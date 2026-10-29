// The authoritative match: terrain, projectiles, debris, damage, bots and the round clock.
// The server runs one per room; solo play runs one in the browser. Human players move themselves
// and report where they are; everything that hurts or changes the page is decided here.
import {
  CELL, EMPTY, SOLID, RUBBLE, PLAYER as P, WEAPONS, GRENADE, ROCKET_LIFE, DEBRIS, COLORS,
  ROUND_TIME, END_TIME, RESPAWN_TIME, SPAWN_PROTECT, MAX_PLAYERS, FL_FLY, FL_FLIP, FL_PROT, FL_CHARGE,
} from './const.js';
import { newBody, stepBody, canStand } from './physics.js';
import { applyOp, stepParticle, rockShape, pageShape, throwVelocity, throwDamage, smashParticles } from './debris.js';
import { rng } from './rng.js';

const MAX_PARTS = 2500;
const MAX_PIECES = 160;   // loose rigid pieces at once; past this the oldest settles where it is
const MAX_BLAST_GLYPHS = 60;
const r1 = (v) => Math.round(v * 10) / 10;
const r2 = (v) => Math.round(v * 100) / 100;
const r3 = (v) => Math.round(v * 1000) / 1000;
const num = (v, lo, hi) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : null);
const BOT_NAMES = ['Botley', 'Rubble Rae', 'Crumbs', 'Pixel Pete', 'Shardy', 'Debra Bris', 'Clank', 'Gravelina'];

export class Game {
  constructor(grid, opts = {}) {
    this.timed = opts.timed ?? true;
    this.rand = rng(opts.seed ?? ((Math.random() * 2 ** 32) >>> 0));
    this.players = new Map();
    this.nextPid = 1;
    this.loadMap(grid);
    this.needsReload = false;
  }

  // Fresh page, fresh round. Sets needsReload so whoever runs us re-sends the map to everyone.
  loadMap(grid) {
    this.grid = grid;
    this.initial = grid.clone();
    this.W = grid.w * CELL; this.H = grid.h * CELL;
    this.ents = new Map(); this.bullets = []; this.parts = [];
    this.ops = []; this.ev = []; this.fallQ = [];
    this.nextEnt = 1; this.seq = 1; this.time = 0;
    this.rev = (this.rev ?? 0) + 1; // bumps on every terrain change
    this.blockDmg = new Float32Array(grid.blockCount + 1);
    this.blockGone = new Uint8Array(grid.blockCount + 1);
    this.round = { state: 'play', t: ROUND_TIME };
    for (const p of this.players.values()) this.resetPlayer(p);
    this.needsReload = true;
  }

  // ---- players ----

  addPlayer(name, bot = false) {
    const used = new Set([...this.players.values()].map((p) => p.color));
    let color = 0;
    while (used.has(color) && color < COLORS.length - 1) color++;
    const p = {
      id: this.nextPid++, name, bot, color, body: newBody(0, 0), aim: 0, face: 1, weapon: 0, fl: 0,
      hp: P.hp, alive: false, life: 0, respawn: 0, prot: 0, hold: 0, kills: 0, deaths: 0,
      cd: WEAPONS.map(() => 0), nade: 0, grabCd: 0, lastBy: 0, lastByT: -99,
      ai: bot ? { think: 0, target: 0, strafe: 1, wander: 1, fire: 0.5, burst: 0, charge: 0 } : null,
    };
    this.resetPlayer(p);
    this.players.set(p.id, p);
    this.ev.push(['join', p.id, name, color, bot ? 1 : 0]);
    return p;
  }

  resetPlayer(p) {
    p.kills = 0; p.deaths = 0; p.hold = 0; p.alive = false; p.hp = P.hp;
    p.respawn = 0.2 + this.rand() * 0.3;
    p.cd.fill(0); p.nade = 0; p.grabCd = 0;
  }

  removePlayer(id) {
    const p = this.players.get(id);
    if (!p) return;
    if (p.hold) this.drop(p);
    this.players.delete(id);
    this.ev.push(['leave', id]);
  }

  addBot() {
    if (this.players.size >= MAX_PLAYERS) return null;
    const used = new Set([...this.players.values()].map((p) => p.name));
    return this.addPlayer(BOT_NAMES.find((n) => !used.has(n)) ?? `Bot ${this.nextPid}`, true);
  }

  removeBot() {
    const bots = [...this.players.values()].filter((p) => p.bot);
    if (bots.length) this.removePlayer(bots[bots.length - 1].id);
  }

  get bots() { let n = 0; for (const p of this.players.values()) if (p.bot) n++; return n; }

  spawn(p) {
    const [x, y] = this.findSpawn();
    p.body = newBody(x, y);
    p.alive = true; p.hp = P.hp; p.life++; p.prot = SPAWN_PROTECT; p.hold = 0; p.fl = 0;
    this.ev.push(['spawn', p.id, r1(x), r1(y), p.life]);
  }

  findSpawn() {
    const g = this.grid;
    for (let tries = 0; tries < 60; tries++) {
      const x = 20 + this.rand() * (this.W - 40);
      let y = Math.floor((this.rand() * Math.min(this.H, 1800)) / CELL) * CELL;
      while (y < this.H && !canStand(g, x, y)) y += CELL;
      if (y >= this.H) continue;
      let crowded = false;
      for (const o of this.players.values()) if (o.alive && Math.abs(o.body.x - x) < 120 && Math.abs(o.body.y - y) < 120) crowded = true;
      if (!crowded || tries > 40) return [x, y];
    }
    return [this.W / 2, 0];
  }

  // ---- messages from a player ----

  handle(id, m) {
    const p = this.players.get(id);
    if (!p || !m || typeof m !== 'object') return;
    const live = p.alive && this.round.state === 'play';
    switch (m.t) {
      case 's': { // where I am (players move themselves)
        if (!p.alive || m.life !== p.life) return;
        const x = num(m.x, -50, this.W + 50), y = num(m.y, -600, this.H + 600);
        if (x === null || y === null) return;
        const b = p.body;
        b.x = x; b.y = y;
        b.vx = num(m.vx, -3000, 3000) ?? 0; b.vy = num(m.vy, -3000, 3000) ?? 0;
        p.aim = num(m.a, -10, 10) ?? p.aim;
        p.face = m.f === -1 ? -1 : 1;
        const w = typeof m.w === 'number' ? m.w | 0 : -1; // never coerce objects: their toString can throw
        if (w >= 0 && w < WEAPONS.length) p.weapon = w;
        p.fl = (typeof m.fl === 'number' ? m.fl | 0 : 0) & (FL_FLY | FL_FLIP | FL_CHARGE);
        return;
      }
      case 'f': if (live) this.fire(p, m); return;
      case 'g': if (live) this.grenade(p, num(m.a, -10, 10) ?? p.aim); return;
      case 'e': if (live) { if (p.hold) this.drop(p); else this.grab(p); } return;
      case 'th': if (live) this.throwChunk(p, num(m.a, -10, 10) ?? p.aim, num(m.p, 0, 1) ?? 0); return;
    }
  }

  fire(p, m) {
    const w = typeof m.w === 'number' ? m.w | 0 : -1, W = WEAPONS[w];
    if (!W || p.hold || this.time < p.cd[w]) return;
    const as = (Array.isArray(m.a) ? m.a : [m.a]).slice(0, W.pellets).map((a) => num(a, -10, 10)).filter((a) => a !== null);
    if (!as.length) return;
    p.cd[w] = this.time + W.cd * 0.8; // slack for network jitter
    p.weapon = w; p.prot = 0;
    let bx = p.body.x, by = p.body.y;
    const mx = num(m.x, -1e4, 1e4), my = num(m.y, -1e4, 1e4);
    if (mx !== null && my !== null && Math.abs(mx - bx) < 60 && Math.abs(my - by) < 60) { bx = mx; by = my; }
    const ox = bx, oy = by - 22;
    if (W.kind === 'rocket') {
      const a = as[0];
      this.addEnt({ k: 'r', owner: p.id, x: ox + Math.cos(a) * 14, y: oy + Math.sin(a) * 14, vx: Math.cos(a) * W.speed, vy: Math.sin(a) * W.speed, life: ROCKET_LIFE, rot: a });
    } else {
      for (const a of as) this.bullets.push({ owner: p.id, w, x: ox, y: oy, vx: Math.cos(a) * W.speed, vy: Math.sin(a) * W.speed, life: W.range, pierce: W.pierce });
    }
    this.ev.push(['shot', p.id, w, r1(ox), r1(oy), ...as.map(r3)]);
  }

  grenade(p, a) {
    if (p.hold || this.time < p.nade) return;
    p.nade = this.time + GRENADE.cd * 0.9; p.prot = 0;
    const b = p.body;
    this.addEnt({
      k: 'g', owner: p.id, x: b.x, y: b.y - 24,
      vx: Math.cos(a) * GRENADE.speed + b.vx * 0.5, vy: Math.sin(a) * GRENADE.speed + b.vy * 0.3,
      fuse: GRENADE.fuse, rot: 0, av: Math.cos(a) >= 0 ? 8 : -8,
    });
    this.ev.push(['nade', p.id]);
  }

  // E: grab the nearest loose piece in reach (a rock, a letter, a shard), else scoop rubble into a rock.
  grab(p) {
    if (p.hold || this.time < p.grabCd) return;
    p.grabCd = this.time + DEBRIS.grabCd;
    const cx = p.body.x, cy = p.body.y - P.h / 2, R = DEBRIS.reach;
    let near = null, nd = Infinity;
    for (const c of this.ents.values()) {
      if (c.k !== 'c' || c.holder || c.n > DEBRIS.carryMax || (c.owner === p.id && c.immune > 0)) continue;
      const d = Math.hypot(c.x - cx, c.y - cy) - c.rad;
      if (d < R && d < nd) { near = c; nd = d; }
    }
    if (near) { this.pickUp(p, near); return; }
    const g = this.grid, rc = R / CELL, gx = cx / CELL, gy = cy / CELL, found = [];
    for (let j = Math.max(0, Math.floor(gy - rc)); j <= Math.min(g.h - 1, Math.floor(gy + rc)); j++) {
      for (let i = Math.max(0, Math.floor(gx - rc)); i <= Math.min(g.w - 1, Math.floor(gx + rc)); i++) {
        const k = j * g.w + i;
        if (g.mat[k] !== RUBBLE) continue;
        const d = (i + 0.5 - gx) ** 2 + (j + 0.5 - gy) ** 2;
        if (d <= rc * rc) found.push([d, k]);
      }
    }
    if (found.length < DEBRIS.minCells) { this.ev.push(['nograb', p.id]); return; }
    found.sort((a, b) => a[0] - b[0]);
    const take = found.slice(0, DEBRIS.maxCells).map((f) => f[1]);
    const cols = take.map((k) => g.col[k]);
    this.op(['x', ...take]);
    const c = this.addPiece(cols, rockShape(cols.length), cx, cy, { owner: p.id });
    this.ev.push(['chunk', c.id, cols]);
    this.pickUp(p, c);
  }

  pickUp(p, c) {
    c.holder = p.id; c.owner = p.id; c.rot = 0; c.av = 0; c.thrown = false; c.hits = null;
    p.hold = c.id;
    this.holdPos(c, p);
    this.ev.push(['grab', p.id, c.id]);
  }

  holdPos(c, p) { // carried over the head
    c.x = p.body.x; c.y = p.body.y - P.h - c.rad - 1;
    c.vx = p.body.vx; c.vy = p.body.vy;
  }

  throwChunk(p, a, power) {
    const c = this.ents.get(p.hold);
    p.hold = 0;
    if (!c || c.holder !== p.id) return;
    const v = throwVelocity(a, power, c.n, p.body.vx, p.body.vy);
    c.holder = 0; c.owner = p.id; c.immune = 0.25; c.vx = v.vx; c.vy = v.vy; c.thrown = true; c.hits = null;
    c.av = (Math.cos(a) >= 0 ? 1 : -1) * (5 + 9 * power); c.age = 0; c.rest = 0;
    p.grabCd = this.time + 0.25; p.prot = 0;
    this.ev.push(['throw', p.id, c.id]);
  }

  drop(p) {
    const c = this.ents.get(p.hold);
    p.hold = 0;
    if (!c) return;
    c.holder = 0; c.immune = 0.5; c.age = 0; c.rest = 0; c.thrown = false;
    this.ev.push(['throw', p.id, c.id]);
  }

  // ---- simulation ----

  step(dt) {
    this.time += dt;
    const R = this.round;
    if (this.timed) {
      R.t -= dt;
      if (R.state === 'play' && R.t <= 0) {
        R.state = 'end'; R.t = END_TIME;
        for (const p of this.players.values()) if (p.hold) this.drop(p);
        this.ev.push(['end']);
      } else if (R.state === 'end' && R.t <= 0) {
        this.loadMap(this.initial);
        return;
      }
    }
    for (const p of this.players.values()) {
      if (!p.alive) {
        p.respawn -= dt;
        if (p.respawn <= 0 && R.state === 'play') this.spawn(p);
        continue;
      }
      p.prot = Math.max(0, p.prot - dt);
      if (p.bot) this.botStep(p, dt);
      if (p.body.y > this.H + 150) this.kill(p, this.time - p.lastByT < 4 ? p.lastBy : 0, 'fall');
    }
    this.stepBullets(dt);
    for (const e of [...this.ents.values()]) {
      if (!this.ents.has(e.id)) continue;
      if (e.k === 'r') this.stepRocket(e, dt);
      else if (e.k === 'g') this.stepGrenade(e, dt);
      else this.stepPiece(e, dt);
    }
    this.stepParts(dt);
    this.collapse();
  }

  addEnt(e) { e.id = this.nextEnt++; this.ents.set(e.id, e); return e; }
  addPart(pt) { if (this.parts.length < MAX_PARTS) this.parts.push(pt); }

  // Every terrain change goes through here so it reaches clients exactly as applied.
  op(o) {
    applyOp(this.grid, o, (pt) => this.addPart(pt), (i) => this.fallQ.push(i));
    this.ops.push(o);
    this.rev++;
  }

  carve(x, y, r, frac, power) { this.op(['c', r2(x), r2(y), r2(r), this.seq++, frac, power]); }

  playerAt(x, y, exclude, pad = 0) {
    for (const p of this.players.values()) {
      if (!p.alive || p.id === exclude) continue;
      const b = p.body;
      if (x >= b.x - P.w / 2 - pad && x <= b.x + P.w / 2 + pad && y >= b.y - P.h - pad && y <= b.y + pad) return p;
    }
    return null;
  }

  chunkAt(x, y) {
    for (const c of this.ents.values()) if (c.k === 'c' && !c.holder && (c.x - x) ** 2 + (c.y - y) ** 2 < (c.rad * 0.7) ** 2) return c;
    return null;
  }

  cellInPlayer(i, j) {
    const x0 = i * CELL, y0 = j * CELL;
    for (const p of this.players.values()) {
      if (!p.alive) continue;
      const b = p.body;
      if (x0 + CELL > b.x - P.w / 2 && x0 < b.x + P.w / 2 && y0 + CELL > b.y - P.h && y0 < b.y) return true;
    }
    return false;
  }

  stepBullets(dt) {
    const g = this.grid;
    this.bullets = this.bullets.filter((b) => {
      const W = WEAPONS[b.w];
      b.life -= dt;
      if (b.life <= 0) return false;
      const steps = Math.ceil((W.speed * dt) / CELL), sx = (b.vx * dt) / steps, sy = (b.vy * dt) / steps;
      for (let k = 0; k < steps; k++) {
        b.x += sx; b.y += sy;
        if (b.x < 0 || b.x >= this.W || b.y < -600 || b.y > this.H + 50) return false;
        const hit = this.playerAt(b.x, b.y, b.owner, 2);
        if (hit) {
          const kick = (W.dmg * 6) / W.speed;
          this.damage(hit, W.dmg, b.owner, W.id, b.vx * kick, b.vy * kick);
          this.ev.push(['spark', r1(b.x), r1(b.y)]);
          return false;
        }
        const ch = this.chunkAt(b.x, b.y);
        if (ch) {
          if (ch.page) { ch.vx += b.vx * 0.06; ch.vy += b.vy * 0.06 - 60; ch.av += (this.rand() - 0.5) * 10; ch.rest = 0; } // shoot letters around
          else this.smash(ch);
          return false;
        }
        if (g.atPx(b.x, b.y) !== EMPTY) {
          b.pierce -= this.hitTerrain(b.x, b.y, W, b.vx / W.speed, b.vy / W.speed, b.owner);
          if (b.pierce <= 0) return false;
        }
      }
      return true;
    });
  }

  stepRocket(r, dt) {
    const W = WEAPONS[3];
    r.life -= dt;
    const steps = Math.max(1, Math.ceil((Math.hypot(r.vx, r.vy) * dt) / 4));
    for (let k = 0; k < steps; k++) {
      r.x += (r.vx * dt) / steps; r.y += (r.vy * dt) / steps;
      if (r.y > this.H + 50 || r.y < -800) { this.ents.delete(r.id); return; }
      if (r.life <= 0 || r.x < 0 || r.x >= this.W || this.playerAt(r.x, r.y, r.owner, 4) || this.chunkAt(r.x, r.y) || this.grid.atPx(r.x, r.y) !== EMPTY) {
        this.ents.delete(r.id);
        this.explode(r.x, r.y, W.radius, W.dmg, r.owner, 'rocket');
        return;
      }
    }
  }

  stepGrenade(n, dt) {
    const g = this.grid;
    n.fuse -= dt;
    if (n.fuse <= 0) { this.ents.delete(n.id); this.explode(n.x, n.y, GRENADE.radius, GRENADE.dmg, n.owner, 'grenade'); return; }
    n.vy = Math.min(1100, n.vy + GRENADE.gravity * dt);
    n.rot += n.av * dt;
    const steps = Math.max(1, Math.ceil((Math.max(Math.abs(n.vx), Math.abs(n.vy)) * dt) / CELL));
    for (let k = 0; k < steps; k++) {
      const nx = n.x + (n.vx * dt) / steps;
      if (g.atPx(nx, n.y) !== EMPTY) { n.vx *= -0.45; n.av *= -0.6; } else n.x = nx;
      const ny = n.y + (n.vy * dt) / steps;
      if (g.atPx(n.x, ny) !== EMPTY) { n.vy *= -0.4; n.vx *= 0.75; if (Math.abs(n.vy) < 40) n.vy = 0; } else n.y = ny;
    }
    if (n.y > this.H + 100) this.ents.delete(n.id);
  }

  explode(x, y, R, dmg, owner, cause) {
    this.carve(x, y, R * 0.55, 0.55, 280); // the middle turns to sand you can scoop
    this.ev.push(['boom', r1(x), r1(y), R]);
    this.blast(x, y, R * 1.05, owner, 560); // around it, letters fly and boxes crack
    const reach = R * 1.6;
    for (const p of this.players.values()) {
      if (!p.alive) continue;
      const dx = p.body.x - x, dy = p.body.y - P.h / 2 - y, d = Math.hypot(dx, dy);
      if (d >= reach) continue;
      const f = 1 - d / reach, k = (620 * f) / (d || 1);
      this.damage(p, dmg * f * (p.id === owner ? 0.5 : 1), owner, cause, dx * k, dy * k - 120 * f);
    }
    for (const c of this.ents.values()) {
      if (c.k !== 'c' || c.holder) continue;
      const dx = c.x - x, dy = c.y - y, d = Math.hypot(dx, dy);
      if (d >= reach) continue;
      const k = (700 * (1 - d / reach)) / (d || 1);
      c.vx += dx * k; c.vy += dy * k; c.rest = 0;
    }
  }

  // ---- what the page is made of: letters come off whole, boxes wear down and crack ----

  // A bullet reaching the page. Returns how much of the bullet's pierce it used up.
  hitTerrain(x, y, W, dx, dy, owner) {
    const g = this.grid, i = Math.floor(y / CELL) * g.w + Math.floor(x / CELL);
    const inside = x >= 0 && x < this.W && y >= 0 && y < this.H;
    const o = inside ? g.own[i] : 0, m = inside ? g.mat[i] : SOLID;
    if (o > 0) { // a letter: knock the whole thing loose
      this.detachGlyph(o, dx * 230 + (this.rand() - 0.5) * 80, dy * 230 - 140 - this.rand() * 90, owner, false);
      return 1;
    }
    if (o < 0) { // a box: chip it, and enough hits crack it apart
      this.carve(x, y, W.hole * 0.6, 0.6, 150);
      this.damageBlock(-o, W.dmg, x, y, dx * 200, dy * 200, owner, 140);
      return 2;
    }
    this.carve(x, y, W.hole, 0.6, 170);
    return m === SOLID ? 2 : 1;
  }

  detachGlyph(gid, vx, vy, owner, harm) {
    const g = this.grid, t = g.glyphs, q = (gid - 1) * 4, idx = [];
    for (let y = t[q + 1]; y <= t[q + 3]; y++) for (let x = t[q]; x <= t[q + 2]; x++) if (g.own[y * g.w + x] === gid) idx.push(y * g.w + x);
    if (idx.length) this.breakOff(idx, vx, vy, (this.rand() - 0.5) * 16, owner, harm);
  }

  blockHp(bid) {
    const t = this.grid.blocks, q = (bid - 1) * 4;
    return 30 + 0.6 * Math.sqrt((t[q + 2] - t[q] + 1) * (t[q + 3] - t[q + 1] + 1)) * CELL; // a button takes a few shots, a card a rocket or two
  }

  damageBlock(bid, amt, x, y, vx, vy, owner, kick) {
    if (this.blockGone[bid]) return;
    this.blockDmg[bid] += amt;
    if (this.blockDmg[bid] >= this.blockHp(bid)) this.breakBlock(bid, x, y, vx, vy, owner, kick);
  }

  // A box cracks into a few rigid shards, taking along whatever sits on it (its text, smaller boxes).
  breakBlock(bid, hx, hy, vx, vy, owner, kick) {
    const g = this.grid, B = g.blocks, G = g.glyphs, q0 = (bid - 1) * 4;
    const x0 = B[q0], y0 = B[q0 + 1], x1 = B[q0 + 2], y1 = B[q0 + 3], area = (x1 - x0 + 1) * (y1 - y0 + 1);
    const within = (t, q) => t[q] >= x0 && t[q + 1] >= y0 && t[q + 2] <= x1 && t[q + 3] <= y1;
    this.blockGone[bid] = 1;
    const idx = [];
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const i = y * g.w + x, o = g.own[i];
        if (!o) continue; // loose rubble stays put
        if (o < 0 && o !== -bid) {
          const q = (-o - 1) * 4;
          if (!within(B, q) || (B[q + 2] - B[q] + 1) * (B[q + 3] - B[q + 1] + 1) >= area) continue; // a parent box underneath
          this.blockGone[-o] = 1;
        } else if (o > 0 && !within(G, (o - 1) * 4)) continue;
        idx.push(i);
      }
    }
    if (!idx.length) return;
    // a few random seeds; every cell joins the nearest one
    const n = Math.max(2, Math.min(12, Math.round(Math.sqrt(idx.length) / 9)));
    const seeds = [];
    for (let s = 0; s < n; s++) { const i = idx[Math.floor(this.rand() * idx.length)]; seeds.push(i % g.w, (i / g.w) | 0); }
    const parts = Array.from({ length: n }, () => []);
    for (const i of idx) {
      const x = i % g.w, y = (i / g.w) | 0;
      let best = 0, bd = Infinity;
      for (let s = 0; s < n; s++) { const d = (x - seeds[2 * s]) ** 2 + (y - seeds[2 * s + 1]) ** 2; if (d < bd) { bd = d; best = s; } }
      parts[best].push(i);
    }
    for (const part of parts) {
      if (!part.length) continue;
      let sx = 0, sy = 0;
      for (const i of part) { sx += i % g.w; sy += (i / g.w) | 0; }
      const dx = (sx / part.length + 0.5) * CELL - hx, dy = (sy / part.length + 0.5) * CELL - hy, d = Math.hypot(dx, dy) || 1;
      const s = kick * (0.5 + this.rand());
      this.breakOff(part, vx * 0.5 + (dx / d) * s, vy * 0.5 + (dy / d) * s - 60, (this.rand() - 0.5) * 6, owner, kick > 420);
    }
    this.ev.push(['crack', r1(hx), r1(hy)]);
  }

  // Everything still attached near a blast: letters fly off, boxes take damage.
  blast(x, y, R, owner, power) {
    const g = this.grid, rc = R / CELL, gx = x / CELL, gy = y / CELL, glyphs = new Map(), blocks = new Map();
    for (let j = Math.max(0, Math.floor(gy - rc)); j <= Math.min(g.h - 1, Math.floor(gy + rc)); j++) {
      for (let i = Math.max(0, Math.floor(gx - rc)); i <= Math.min(g.w - 1, Math.floor(gx + rc)); i++) {
        const o = g.own[j * g.w + i];
        if (!o) continue;
        const d = Math.hypot(i + 0.5 - gx, j + 0.5 - gy) * CELL;
        if (d > R) continue;
        const m = o > 0 ? glyphs : blocks, key = Math.abs(o);
        if (!m.has(key) || d < m.get(key)) m.set(key, d);
      }
    }
    const near = [...glyphs].sort((a, b) => a[1] - b[1]).slice(0, MAX_BLAST_GLYPHS);
    for (const [gid, d] of near) {
      const t = g.glyphs, q = (gid - 1) * 4;
      const dx = ((t[q] + t[q + 2] + 1) / 2) * CELL - x, dy = ((t[q + 1] + t[q + 3] + 1) / 2) * CELL - y, dl = Math.hypot(dx, dy) || 1;
      const f = 1 - d / R, s = power * (0.35 + 0.65 * f);
      this.detachGlyph(gid, (dx / dl) * s, (dy / dl) * s - 120 * f, owner, s > 420);
    }
    for (const [bid, d] of blocks) this.damageBlock(bid, 20 + 90 * (1 - d / R), x, y, 0, 0, owner, power * 0.7);
  }

  // Cells of the page come loose together as one rigid piece.
  breakOff(idx, vx, vy, av, owner, harm) {
    const g = this.grid, cols = idx.map((i) => g.col[i]), shape = pageShape(idx, g.w);
    this.op(['x', ...idx]);
    const c = this.addPiece(cols, shape, (shape.ox + 0.5) * CELL, (shape.oy + 0.5) * CELL, { owner, vx, vy, av, harm, idx });
    this.ev.push(['piece', c.id, idx, cols]);
    return c;
  }

  addPiece(cols, shape, x, y, o = {}) {
    let count = 0, oldest = null;
    for (const e of this.ents.values()) {
      if (e.k !== 'c') continue;
      count++;
      if (!e.holder && (!oldest || e.age > oldest.age)) oldest = e;
    }
    if (count >= MAX_PIECES && oldest) this.settle(oldest);
    return this.addEnt({
      k: 'c', cols, n: cols.length, shape, rad: shape.rad, x, y, px: x, py: y, pr: 0, vx: o.vx ?? 0, vy: o.vy ?? 0, rot: 0, av: o.av ?? 0,
      holder: 0, owner: o.owner ?? 0, immune: 0, age: 0, rest: 0, thrown: false, harm: !!o.harm, hits: null,
      page: !!o.idx, idx: o.idx ?? null,
    });
  }

  // Loose pieces are rigid bodies: they tumble, bounce off the page, hurt people when thrown (or blasted),
  // and once they lie still they settle back into the page as rubble in their own shape.
  stepPiece(c, dt) {
    if (c.holder) {
      const p = this.players.get(c.holder);
      if (p && p.alive && p.hold === c.id) { this.holdPos(c, p); return; }
      c.holder = 0; // carrier is gone: let it fall
    }
    c.age += dt; c.immune -= dt;
    c.vy = Math.min(1200, c.vy + DEBRIS.gravity * dt);
    const speed = Math.hypot(c.vx, c.vy);
    const steps = Math.max(1, Math.ceil(Math.max(speed * dt, Math.abs(c.av) * dt * c.rad) / CELL));
    const hurts = c.thrown || (c.harm && speed > 300);
    for (let k = 0; k < steps; k++) {
      const nx = c.x + (c.vx * dt) / steps, ny = c.y + (c.vy * dt) / steps, nr = c.rot + (c.av * dt) / steps;
      if (hurts && speed >= DEBRIS.hurtSpeed) {
        const hit = this.pieceHitsPlayer(c, nx, ny, nr);
        if (hit) {
          const n = Math.min(c.n, DEBRIS.maxCells);
          const dmg = throwDamage(n, Math.hypot(c.vx - hit.body.vx, c.vy - hit.body.vy)) * (c.thrown ? 1 : 0.5);
          const kick = (n * 3 + 150) / (speed || 1);
          this.damage(hit, dmg, c.owner, 'debris', c.vx * kick, c.vy * kick - 80);
          this.ev.push(['crunch', hit.id, r1(nx), r1(ny)]);
          if (c.thrown) { this.smash(c); return; }
          (c.hits ??= new Set()).add(hit.id);
          c.vx *= 0.5; c.vy *= 0.5;
        }
      }
      const at = this.pieceContact(c, nx, ny, nr);
      if (at) {
        if (c.thrown && speed > DEBRIS.smash) { this.impact(c, nx, ny, speed); return; }
        // only the turn is blocked: keep sliding, lose the spin
        if (nr !== c.rot && !this.pieceContact(c, nx, ny, c.rot)) { c.x = nx; c.y = ny; c.av *= 0.5; continue; }
        this.collide(c, at);
        c.thrown = false; // after its first bounce it's just debris again
        break;
      }
      c.x = nx; c.y = ny; c.rot = nr;
    }
    if (c.y > this.H + 100) { this.ents.delete(c.id); this.ev.push(['gone', c.id]); return; }
    // sunk into the page (it changed under the piece): lift it clear
    if (this.pieceContact(c, c.x, c.y, c.rot)) for (let up = 1; up <= 8; up++) if (!this.pieceContact(c, c.x, c.y - up, c.rot)) { c.y -= up; break; }
    c.av = Math.max(-30, Math.min(30, c.av));
    // at rest = touching the page and not really going anywhere, whatever its velocity says
    const moved = Math.hypot(c.x - c.px, c.y - c.py) + Math.abs(c.rot - c.pr) * c.rad;
    c.px = c.x; c.py = c.y; c.pr = c.rot;
    const still = moved < 0.6 || (Math.hypot(c.vx, c.vy) < 60 && Math.abs(c.av) < 2.5);
    c.rest = still && this.pieceContact(c, c.x, c.y + 2, c.rot) ? c.rest + dt : 0;
    if (c.rest > (c.page ? 1.2 : 0.35) || c.age > 12) this.settle(c);
  }

  // Where (if anywhere) the piece's outline at this pose touches the page.
  pieceContact(c, x, y, rot) {
    const g = this.grid, s = c.shape, cs = Math.cos(rot), sn = Math.sin(rot);
    let hx = 0, hy = 0, n = 0;
    for (const k of s.edge) {
      const dx = s.off[2 * k], dy = s.off[2 * k + 1];
      const wx = x + (dx * cs - dy * sn) * CELL, wy = y + (dx * sn + dy * cs) * CELL;
      if (g.atPx(wx, wy) !== EMPTY) { hx += wx; hy += wy; n++; }
    }
    return n ? { x: hx / n, y: hy / n } : null;
  }

  pieceHitsPlayer(c, x, y, rot) {
    const s = c.shape, cs = Math.cos(rot), sn = Math.sin(rot);
    for (const p of this.players.values()) {
      if (!p.alive || p.id === c.holder || (p.id === c.owner && c.immune > 0) || c.hits?.has(p.id)) continue;
      const b = p.body;
      if (Math.abs(b.x - x) > c.rad + P.w || Math.abs(b.y - P.h / 2 - y) > c.rad + P.h) continue;
      for (const k of s.edge) {
        const dx = s.off[2 * k], dy = s.off[2 * k + 1];
        const wx = x + (dx * cs - dy * sn) * CELL, wy = y + (dx * sn + dy * cs) * CELL;
        if (wx > b.x - P.w / 2 - 1 && wx < b.x + P.w / 2 + 1 && wy > b.y - P.h - 1 && wy < b.y + 1) return p;
      }
    }
    return null;
  }

  // Rigid-body bounce off the page at a contact point: restitution, friction and spin.
  collide(c, at) {
    const g = this.grid, gx = at.x / CELL, gy = at.y / CELL;
    let nx = 0, ny = 0;
    for (let j = Math.floor(gy) - 3; j <= Math.floor(gy) + 3; j++) {
      for (let i = Math.floor(gx) - 3; i <= Math.floor(gx) + 3; i++) {
        if (g.at(i, j) === EMPTY) continue;
        nx += gx - (i + 0.5); ny += gy - (j + 0.5);
      }
    }
    const n = Math.hypot(nx, ny);
    if (n) { nx /= n; ny /= n; } else { nx = 0; ny = -1; }
    const rx = at.x - c.x, ry = at.y - c.y, m = c.n, I = c.shape.inertia;
    const vpx = c.vx - c.av * ry, vpy = c.vy + c.av * rx; // how the contact point is moving
    const vn = vpx * nx + vpy * ny;
    if (vn < 0) {
      const rn = rx * ny - ry * nx;
      const j = (-1.25 * vn) / (1 / m + (rn * rn) / I);
      c.vx += (j * nx) / m; c.vy += (j * ny) / m; c.av += (rn * j) / I;
      const tx = -ny, ty = nx, vt = vpx * tx + vpy * ty, rt = rx * ty - ry * tx;
      const jt = Math.max(-0.6 * j, Math.min(0.6 * j, -vt / (1 / m + (rt * rt) / I)));
      c.vx += (jt * tx) / m; c.vy += (jt * ty) / m; c.av += (rt * jt) / I;
    }
    c.av *= 0.92;
  }

  // A thrown piece slamming into the page: crater, nearby letters fly, and it bursts into sand.
  impact(c, x, y, speed) {
    const r = Math.min(c.rad, 14) * 0.7 + speed * 0.006;
    this.carve(x, y, r, 0.55, 220);
    this.blast(x, y, r * 1.8, c.owner, 320);
    const splash = Math.min(c.rad, 14) + 18, dmg = throwDamage(Math.min(c.n, DEBRIS.maxCells), speed) * 0.4;
    for (const p of this.players.values()) {
      if (!p.alive || (p.id === c.owner && c.immune > 0)) continue;
      const d = Math.hypot(p.body.x - x, p.body.y - P.h / 2 - y);
      if (d < splash) this.damage(p, dmg * (1 - d / splash), c.owner, 'debris', 0, -120);
    }
    this.smash(c);
  }

  // A piece at rest goes back into the page as rubble, keeping its shape (and angle).
  settle(c) {
    const g = this.grid, s = c.shape;
    let rot = c.rot;
    const q = Math.round(rot / (Math.PI / 2)) * (Math.PI / 2);
    if (Math.abs(rot - q) < 0.12) rot = q; // nearly square: lay it down square
    const cs = Math.cos(rot), sn = Math.sin(rot), bake = [];
    const R = Math.ceil(c.rad / CELL) + 1, gx = Math.floor(c.x / CELL), gy = Math.floor(c.y / CELL);
    for (let j = Math.max(0, gy - R); j <= Math.min(g.h - 1, gy + R); j++) {
      for (let i = Math.max(0, gx - R); i <= Math.min(g.w - 1, gx + R); i++) {
        const idx = j * g.w + i;
        if (g.mat[idx] !== EMPTY) continue;
        const wx = ((i + 0.5) * CELL - c.x) / CELL, wy = ((j + 0.5) * CELL - c.y) / CELL;
        // which of the piece's own cells lands here, at this angle
        const k = s.at.get(s.key(Math.round(wx * cs + wy * sn + s.ox), Math.round(-wx * sn + wy * cs + s.oy)));
        if (k === undefined || this.cellInPlayer(i, j)) continue;
        bake.push(idx, c.cols[k]);
      }
    }
    if (bake.length) this.op(['b', ...bake]);
    this.ents.delete(c.id);
    const p = c.holder && this.players.get(c.holder);
    if (p) p.hold = 0;
    this.ev.push(['settle', c.id, r1(c.x), r1(c.y), r3(rot)]);
  }

  smash(c) {
    const seed = this.seq++;
    for (const pt of smashParticles(c.x, c.y, c.vx, c.vy, c.rot, c.shape.off, c.cols, seed)) this.addPart(pt);
    this.ents.delete(c.id);
    const p = c.holder && this.players.get(c.holder);
    if (p) p.hold = 0;
    this.ev.push(['smash', c.id, r1(c.x), r1(c.y), r1(c.vx), r1(c.vy), r2(c.rot), seed]);
  }

  stepParts(dt) {
    const g = this.grid, bake = [];
    let n = 0;
    for (const p of this.parts) {
      const r = stepParticle(p, g, dt);
      if (r === 0) { this.parts[n++] = p; continue; }
      if (r !== 1) continue;
      const i = Math.floor(p.x / CELL);
      let j = Math.floor(p.y / CELL);
      for (let up = 0; up < 3; up++, j--) {
        if (i < 0 || i >= g.w || j < 0 || j >= g.h) break;
        const k = j * g.w + i;
        if (g.mat[k] !== EMPTY) continue;
        if (!this.cellInPlayer(i, j)) { g.set(k, RUBBLE, p.c); bake.push(k, p.c); }
        break;
      }
    }
    this.parts.length = n;
    if (bake.length) { this.ops.push(['b', ...bake]); this.rev++; } // applied cell by cell above, same as applyOp would
  }

  // Rubble sitting on something that just got blasted away tumbles down.
  collapse() {
    if (!this.fallQ.length) return;
    const g = this.grid, seen = new Set(), list = [];
    for (const i of this.fallQ) {
      for (let j = i - g.w; j >= 0 && g.mat[j] === RUBBLE && !seen.has(j) && list.length < 4000; j -= g.w) { seen.add(j); list.push(j); }
    }
    this.fallQ.length = 0;
    if (list.length) {
      const o = ['f', this.seq++, ...list];
      applyOp(g, o, (pt) => this.addPart(pt));
      this.ops.push(o);
      this.rev++;
    }
  }

  damage(p, amt, by, cause, kx = 0, ky = 0) {
    if (!p.alive) return;
    if (kx || ky) this.push(p, kx, ky);
    if (p.prot > 0 || this.round.state !== 'play') return;
    amt = Math.round(amt);
    if (amt <= 0) return;
    p.hp -= amt;
    if (by && by !== p.id) { p.lastBy = by; p.lastByT = this.time; }
    this.ev.push(['hit', p.id, amt, by || 0, cause]);
    if (p.hp <= 0) this.kill(p, by, cause);
  }

  push(p, kx, ky) {
    p.body.vx += kx; p.body.vy += ky;
    if (!p.bot) this.ev.push(['push', p.id, Math.round(kx), Math.round(ky)]);
  }

  kill(p, by, cause) {
    if (!p.alive) return;
    if (p.hold) this.drop(p);
    p.alive = false; p.hp = 0; p.deaths++; p.respawn = RESPAWN_TIME;
    const k = by && by !== p.id ? this.players.get(by) : null;
    if (k) k.kills++;
    this.ev.push(['kill', p.id, k ? k.id : 0, cause, r1(p.body.x), r1(p.body.y)]);
  }

  // ---- bots ----

  botStep(p, dt) {
    const ai = p.ai, b = p.body, live = this.round.state === 'play';
    ai.think -= dt;
    if (ai.think <= 0) {
      ai.think = 0.4 + this.rand() * 0.4;
      let best = null, bd = 1e9;
      for (const o of this.players.values()) {
        if (o === p || !o.alive) continue;
        const d = Math.hypot(o.body.x - b.x, o.body.y - b.y) * (o.bot ? 1.3 : 1);
        if (d < bd) { bd = d; best = o; }
      }
      ai.target = best && bd < 1100 ? best.id : 0;
      if (this.rand() < 0.3) ai.strafe = this.rand() < 0.5 ? -1 : 1;
      if (this.rand() < 0.3) ai.wander = this.rand() < 0.5 ? -1 : 1;
    }
    const t = this.players.get(ai.target);
    const inp = { l: false, r: false, jump: false, down: false, jp: false, dp: false };
    let move;
    if (t && t.alive) {
      const dx = t.body.x - b.x, dy = t.body.y - b.y, adx = Math.abs(dx);
      move = adx > 420 ? Math.sign(dx) : adx < 140 ? -Math.sign(dx) : ai.strafe;
      if (dy < -90 && b.ground && this.rand() < 0.04) inp.jp = true;
      if (dy < -140 && !b.ground) { if (b.air > 0 && b.vy > -100) inp.jp = true; inp.jump = true; }
      if (dy > 90 && b.ground && this.rand() < 0.02) inp.dp = true;
      p.aim = Math.atan2(t.body.y - P.h / 2 - (b.y - 22), dx) + (this.rand() - 0.5) * 0.12;
      if (live) this.botAttack(p, t, Math.hypot(dx, dy), dt);
    } else {
      move = ai.wander;
      p.aim = move > 0 ? 0 : Math.PI;
      if (live && !p.hold && this.rand() < 0.01) this.grab(p);
    }
    p.face = Math.cos(p.aim) >= 0 ? 1 : -1;
    if (move > 0) inp.r = true; else if (move < 0) inp.l = true;
    if (move && Math.abs(b.vx) < 5 && b.ground && this.rand() < 0.15) inp.jp = true; // stuck on a wall: hop
    const held = p.hold && this.ents.get(p.hold);
    stepBody(b, inp, this.grid, dt, held ? held.n : 0);
    p.fl = (b.flying ? FL_FLY : 0) | (b.flipT > 0 ? FL_FLIP : 0) | (ai.charge > 0 ? FL_CHARGE : 0);
    if (held) this.holdPos(held, p);
  }

  botAttack(p, t, d, dt) {
    const ai = p.ai;
    if (p.hold) {
      ai.charge += dt;
      const want = Math.min(1, d / 700);
      if (ai.charge >= want * DEBRIS.charge) {
        // lob a little above them, more for far throws
        const a = Math.atan2(t.body.y - P.h / 2 - (p.body.y - P.h - 10) - d * 0.18, t.body.x - p.body.x);
        this.throwChunk(p, a, want);
        ai.charge = 0;
      }
      return;
    }
    ai.fire -= dt;
    if (ai.fire > 0) return;
    if (ai.burst > 0) {
      ai.burst--;
      this.fire(p, { w: 1, a: [p.aim + (this.rand() - 0.5) * 2 * WEAPONS[1].spread] });
      ai.fire = WEAPONS[1].cd;
      return;
    }
    ai.fire = 0.25 + this.rand() * 0.7;
    const r = this.rand();
    if (r < 0.14) { this.grab(p); if (p.hold) { ai.charge = 0; return; } }
    if (r > 0.94) { this.grenade(p, p.aim - 0.35 * Math.sign(Math.cos(p.aim) || 1)); return; }
    const w = d < 180 ? 2 : d < 450 ? (this.rand() < 0.5 ? 1 : 0) : (this.rand() < 0.5 ? 3 : 4);
    if (w === 1) { ai.burst = 5 + Math.floor(this.rand() * 6); ai.fire = 0; return; }
    const W = WEAPONS[w], as = [];
    for (let k = 0; k < W.pellets; k++) as.push(p.aim + (this.rand() - 0.5) * 2 * W.spread);
    this.fire(p, { w, a: as });
  }

  // ---- what goes over the wire ----

  roster() {
    return [...this.players.values()].map((p) => [p.id, p.name, p.color, p.bot ? 1 : 0]);
  }

  chunkList() { // loose pieces a joiner needs to draw: rocks by colour, page pieces by their cells
    return [...this.ents.values()].filter((e) => e.k === 'c').map((c) => (c.page ? [c.id, c.cols, c.idx] : [c.id, c.cols]));
  }

  welcome(id) {
    return { id, players: this.roster(), chunks: this.chunkList(), timed: this.timed };
  }

  flush() {
    const ps = [];
    for (const p of this.players.values()) {
      const b = p.body;
      ps.push([p.id, r1(b.x), r1(b.y), r1(b.vx), r1(b.vy), r2(p.aim), p.face, p.weapon, Math.max(0, p.hp),
        p.fl | (p.prot > 0 ? FL_PROT : 0), p.hold, p.alive ? 1 : 0, p.kills, p.deaths]);
    }
    const es = [];
    for (const e of this.ents.values()) {
      if (e.k === 'c' && e.holder) continue;
      es.push([e.id, e.k === 'r' ? 0 : e.k === 'g' ? 1 : 2, r1(e.x), r1(e.y), r1(e.vx), r1(e.vy), r2(e.rot || 0)]);
    }
    const m = {
      t: 'u', st: r3(this.time), ps, es,
      r: [this.round.state === 'play' ? 0 : 1, this.timed ? Math.max(0, Math.ceil(this.round.t)) : -1],
    };
    if (this.ops.length) m.ops = this.ops;
    if (this.ev.length) m.ev = this.ev;
    this.ops = []; this.ev = [];
    return m;
  }
}
