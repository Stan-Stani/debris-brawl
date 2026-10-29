// The authoritative match: terrain, projectiles, debris, damage, bots and the round clock.
// The server runs one per room; solo play runs one in the browser. Human players move themselves
// and report where they are; everything that hurts or changes the page is decided here.
import {
  CELL, EMPTY, SOLID, RUBBLE, PLAYER as P, WEAPONS, GRENADE, ROCKET_LIFE, DEBRIS, COLORS,
  ROUND_TIME, END_TIME, RESPAWN_TIME, SPAWN_PROTECT, MAX_PLAYERS, FL_FLY, FL_FLIP, FL_PROT, FL_CHARGE,
} from './const.js';
import { newBody, stepBody, canStand } from './physics.js';
import { applyOp, stepParticle, discCells, chunkRadius, throwVelocity, throwDamage, smashParticles } from './debris.js';
import { rng } from './rng.js';

const MAX_PARTS = 2500;
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

  // E: catch a loose chunk in reach, else scoop the nearest rubble into one.
  grab(p) {
    if (p.hold || this.time < p.grabCd) return;
    p.grabCd = this.time + DEBRIS.grabCd;
    const cx = p.body.x, cy = p.body.y - P.h / 2, R = DEBRIS.reach;
    for (const c of this.ents.values()) {
      if (c.k !== 'c' || c.holder || (c.owner === p.id && c.immune > 0)) continue;
      if ((c.x - cx) ** 2 + (c.y - cy) ** 2 < (R + c.rad) ** 2) { this.pickUp(p, c); return; }
    }
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
    const c = this.addEnt({ k: 'c', owner: p.id, holder: 0, cols, n: cols.length, rad: chunkRadius(cols.length), x: cx, y: cy, vx: 0, vy: 0, rot: 0, av: 0, immune: 0, age: 0, rest: 0 });
    this.ev.push(['chunk', c.id, cols]);
    this.pickUp(p, c);
  }

  pickUp(p, c) {
    c.holder = p.id; c.owner = p.id; c.rot = 0; c.av = 0;
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
    c.holder = 0; c.owner = p.id; c.immune = 0.25; c.vx = v.vx; c.vy = v.vy;
    c.av = (Math.cos(a) >= 0 ? 1 : -1) * (5 + 9 * power); c.age = 0; c.rest = 0;
    p.grabCd = this.time + 0.25; p.prot = 0;
    this.ev.push(['throw', p.id, c.id]);
  }

  drop(p) {
    const c = this.ents.get(p.hold);
    p.hold = 0;
    if (!c) return;
    c.holder = 0; c.immune = 0.5; c.age = 0; c.rest = 0;
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
      else this.stepChunk(e, dt);
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
    for (const c of this.ents.values()) if (c.k === 'c' && !c.holder && (c.x - x) ** 2 + (c.y - y) ** 2 < c.rad * c.rad) return c;
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

  circleHits(x, y, r) {
    const g = this.grid, rc = r / CELL, gx = x / CELL, gy = y / CELL;
    for (let j = Math.floor(gy - rc); j <= Math.floor(gy + rc); j++) {
      for (let i = Math.floor(gx - rc); i <= Math.floor(gx + rc); i++) {
        if (g.at(i, j) === EMPTY) continue;
        const dx = i + 0.5 - gx, dy = j + 0.5 - gy;
        if (dx * dx + dy * dy <= rc * rc) return true;
      }
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
        if (ch) { this.smash(ch); return false; }
        const m = g.atPx(b.x, b.y);
        if (m !== EMPTY) {
          this.carve(b.x, b.y, W.hole, 0.6, 170);
          b.pierce -= m === SOLID ? 2 : 1;
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
    this.carve(x, y, R * 0.8, 0.55, 280); // most of a crater lands nearby as rubble you can scoop
    this.ev.push(['boom', r1(x), r1(y), R]);
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

  stepChunk(c, dt) {
    if (c.holder) {
      const p = this.players.get(c.holder);
      if (p && p.alive && p.hold === c.id) { this.holdPos(c, p); return; }
      c.holder = 0; // carrier is gone: let it fall
    }
    c.age += dt; c.immune -= dt;
    c.vy = Math.min(1200, c.vy + DEBRIS.gravity * dt);
    c.rot += c.av * dt;
    const speed = Math.hypot(c.vx, c.vy);
    const steps = Math.max(1, Math.ceil((speed * dt) / CELL));
    for (let k = 0; k < steps; k++) {
      const nx = c.x + (c.vx * dt) / steps, ny = c.y + (c.vy * dt) / steps;
      if (speed >= DEBRIS.hurtSpeed) {
        const hit = this.chunkHitsPlayer(c, nx, ny);
        if (hit) {
          const dmg = throwDamage(c.n, Math.hypot(c.vx - hit.body.vx, c.vy - hit.body.vy));
          const kick = (c.n * 3 + 150) / (speed || 1);
          this.damage(hit, dmg, c.owner, 'debris', c.vx * kick, c.vy * kick - 80);
          this.ev.push(['crunch', hit.id, r1(nx), r1(ny)]);
          this.smash(c);
          return;
        }
      }
      if (this.circleHits(nx, ny, c.rad * 0.8)) {
        if (speed > DEBRIS.smash) {
          this.carve(nx, ny, c.rad * 0.7 + speed * 0.006, 0.55, 220);
          // near misses still sting
          const splash = c.rad + 18, dmg = throwDamage(c.n, speed) * 0.4;
          for (const p of this.players.values()) {
            if (!p.alive || (p.id === c.owner && c.immune > 0)) continue;
            const d = Math.hypot(p.body.x - nx, p.body.y - P.h / 2 - ny);
            if (d < splash) this.damage(p, dmg * (1 - d / splash), c.owner, 'debris', 0, -120);
          }
          this.smash(c);
          return;
        }
        this.bounce(c, nx, ny);
        break;
      }
      c.x = nx; c.y = ny;
    }
    if (c.y > this.H + 100) { this.ents.delete(c.id); this.ev.push(['gone', c.id]); return; }
    const slow = Math.hypot(c.vx, c.vy) < 70;
    c.rest = slow && this.circleHits(c.x, c.y + 3, c.rad * 0.8) ? c.rest + dt : 0;
    if (c.rest > 0.35 || c.age > 10) this.settle(c);
  }

  chunkHitsPlayer(c, x, y) {
    for (const p of this.players.values()) {
      if (!p.alive || p.id === c.holder || (p.id === c.owner && c.immune > 0)) continue;
      const b = p.body;
      const qx = Math.min(b.x + P.w / 2, Math.max(b.x - P.w / 2, x)), qy = Math.min(b.y, Math.max(b.y - P.h, y));
      if ((x - qx) ** 2 + (y - qy) ** 2 < c.rad * c.rad) return p;
    }
    return null;
  }

  bounce(c, x, y) {
    const g = this.grid, rc = c.rad / CELL + 1, gx = x / CELL, gy = y / CELL;
    let nx = 0, ny = 0;
    for (let j = Math.floor(gy - rc); j <= Math.floor(gy + rc); j++) {
      for (let i = Math.floor(gx - rc); i <= Math.floor(gx + rc); i++) {
        if (g.at(i, j) === EMPTY) continue;
        const dx = gx - (i + 0.5), dy = gy - (j + 0.5);
        if (dx * dx + dy * dy <= rc * rc) { nx += dx; ny += dy; }
      }
    }
    const n = Math.hypot(nx, ny);
    if (n) { nx /= n; ny /= n; } else { nx = 0; ny = -1; }
    const dot = c.vx * nx + c.vy * ny;
    if (dot < 0) { c.vx -= 1.35 * dot * nx; c.vy -= 1.35 * dot * ny; }
    c.vx *= 0.8; c.vy *= 0.9;
    c.av = c.av * 0.6 + (c.vx / (c.rad || 1)) * 0.5;
  }

  // A chunk that comes to rest turns back into rubble you can scoop again.
  settle(c) {
    // snap to a quarter turn so no two pixels land on the same cell
    const q = Math.round(c.rot / (Math.PI / 2)) * (Math.PI / 2);
    const g = this.grid, cells = discCells(c.n), cs = Math.round(Math.cos(q)), sn = Math.round(Math.sin(q)), bake = [], taken = new Set();
    for (let k = 0; k < cells.length; k++) {
      const [dx, dy] = cells[k];
      const i = Math.floor((c.x + (dx * cs - dy * sn) * CELL) / CELL);
      let j = Math.floor((c.y + (dx * sn + dy * cs) * CELL) / CELL);
      // pixels that ended up in the ground stack on top of the rest of the chunk instead
      for (let up = 0; up < 28; up++, j--) {
        if (i < 0 || i >= g.w || j < 0 || j >= g.h) break;
        const idx = j * g.w + i;
        if (g.mat[idx] === EMPTY && !taken.has(idx) && !this.cellInPlayer(i, j)) { taken.add(idx); bake.push(idx, c.cols[k]); break; }
      }
    }
    if (bake.length) this.op(['b', ...bake]);
    this.ents.delete(c.id);
    this.ev.push(['gone', c.id]);
  }

  smash(c) {
    const seed = this.seq++;
    for (const pt of smashParticles(c.x, c.y, c.vx, c.vy, c.rot, c.cols, seed)) this.addPart(pt);
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

  chunkList() {
    return [...this.ents.values()].filter((e) => e.k === 'c').map((c) => [c.id, c.cols]);
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
