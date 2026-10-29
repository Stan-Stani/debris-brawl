// The game as you see it: your own stickman moves here (no waiting on the server), everything else
// arrives from the match (server or solo) and is replayed: terrain ops exactly, other players smoothed.
import { CELL, TICK, PLAYER as P, WEAPONS, GRENADE, DEBRIS, COLORS, INTERP_DELAY, FL_FLY, FL_FLIP, FL_CHARGE } from '/shared/const.js';
import { newBody, stepBody } from '/shared/physics.js';
import { applyOp, stepParticle, throwVelocity, smashParticles, pageShape } from '/shared/debris.js';
import { css, luma, rgb } from '/shared/grid.js';
import { unpackGrid } from './codec.js';
import { Sfx } from './audio.js';
import { chunkSprite, drawChunk, drawStick, drawTag, drawRocket, drawGrenade } from './render.js';

const r1 = (v) => Math.round(v * 10) / 10, r3 = (v) => Math.round(v * 1000) / 1000;
const MAX_GHOSTS = 4000;
const VERB = { pistol: 'shot', smg: 'shredded', shotgun: 'blasted', rocket: 'rocketed', rail: 'railed', grenade: 'fragged', debris: 'flattened', fall: 'knocked off' };
const WEAPON_KEYS = { Digit1: 0, Digit2: 1, Digit3: 2, Digit4: 3, Digit5: 4 };

function loadImage(src) {
  if (!src) return Promise.resolve(null);
  return new Promise((resolve) => {
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = () => resolve(null);
    im.src = src;
  });
}

export class ClientGame {
  constructor(canvas, net, ui) {
    this.cv = canvas; this.ctx = canvas.getContext('2d'); this.net = net; this.ui = ui;
    this.sfx = ui.sfx ?? new Sfx();
    this.players = new Map(); this.ents = new Map(); this.sprites = new Map();
    this.ghosts = []; this.tracers = []; this.fx = []; this.feed = []; this.floaters = [];
    this.input = { l: false, r: false, jump: false, down: false, jp: false, dp: false };
    this.mouse = { sx: innerWidth / 2, sy: innerHeight / 2, down: false, pressed: false };
    this.nadePressed = false; this.grabPressed = false; this.showBoard = false; this.paused = false;
    this.me = { id: 0, body: null, life: 0, alive: false, weapon: 0, aim: 0, face: 1, cd: WEAPONS.map(() => 0), nade: 0, charge: 0, charging: false, thrownId: 0, flipAt: -9, diedAt: 0, killer: 0, lastHurt: -9 };
    this.cam = { x: 0, y: 0, shake: 0 }; this.zoom = 1;
    this.clock = 0; this.offset = null; this.acc = 0; this.tickN = 0;
    this.round = [0, -1]; this.queue = []; this.pumping = false; this.ready = false;
    this.toastMsg = ''; this.toastT = 0; this.hitT = -9; this.colorCss = new Map();
    this.listen();
    this.raf = requestAnimationFrame((t) => this.frame(t));
  }

  // ---- incoming ----

  receive(m) {
    this.queue.push(m);
    if (!this.pumping) this.pump();
  }

  async pump() {
    this.pumping = true;
    try {
      while (this.queue.length) {
        const m = this.queue.shift();
        if (m.t === 'welcome' || m.t === 'reload') await this.setup(m);
        else if (this.ready || m.t !== 'u') this.handle(m);
      }
    } finally {
      this.pumping = false;
    }
  }

  async setup(m) {
    const grid = m.grid ?? await unpackGrid(m.map);
    const init = m.init ? await unpackGrid(m.init) : null;
    const look = m.terrain ?? await loadImage(m.img); // the page as it really looks, full resolution
    const scenery = m.scenery ?? await loadImage(m.bg);
    if (this.destroyed) return; // left while the map was unpacking
    this.grid = grid; this.W = grid.w * CELL; this.H = grid.h * CELL;
    this.bgCss = css(grid.pageBg);
    this.dark = luma(grid.pageBg) < 0.45;
    this.ink = this.dark ? '#f2f2f2' : '#141414';
    this.paper = this.dark ? '#141414' : '#ffffff';
    this.look = look;
    this.buildPage(grid, init, look);
    this.buildScenery(grid, scenery);

    this.me.id = m.id;
    this.code = m.code ?? this.code;
    this.host = m.host ?? this.host;
    this.timed = m.timed;
    this.mapName = m.mapName ?? '';
    this.players.clear();
    for (const [id, name, color, bot] of m.players) this.addPlayer(id, name, color, bot);
    this.ents.clear(); this.sprites.clear();
    const now = performance.now() / 1000;
    for (const [id, cols, idx, pose] of m.chunks) {
      this.sprites.set(id, idx ? this.pieceSprite(idx, cols) : chunkSprite(cols));
      if (pose) this.ents.set(id, { id, k: 2, x: pose[0], y: pose[1], vx: 0, vy: 0, rot: pose[2], at: now, born: now });
    }
    this.ghosts.length = 0; this.tracers.length = 0; this.fx.length = 0; this.floaters.length = 0;
    Object.assign(this.me, { body: null, alive: false, charge: 0, charging: false, thrownId: 0 });
    this.round = [0, -1];
    this.ready = true;
    this.ui.onMap?.(this);
  }

  addPlayer(id, name, color, bot) {
    this.players.set(id, {
      id, name, bot, color: COLORS[color % COLORS.length], snaps: [], hp: 100, hold: 0, alive: false,
      kills: 0, deaths: 0, fl: 0, phase: 0, flipAt: -9, x: 0, y: 0,
    });
  }

  handle(m) {
    switch (m.t) {
      case 'u': this.update(m); break;
      case 'host': this.host = m.id; this.ui.onHost?.(this); break;
      case 'maperror': this.toast(m.msg); break;
      case 'closed': this.ui.onClosed?.('Lost the connection to the server.'); break;
      case 'error': this.ui.onClosed?.(m.msg); break;
    }
  }

  update(m) {
    const now = performance.now() / 1000;
    const off = m.st - now;
    this.offset = this.offset === null || Math.abs(off - this.offset) > 1 ? off : this.offset + (off - this.offset) * 0.05;
    for (const op of m.ops ?? []) {
      applyOp(this.grid, op, (p) => this.addGhost(p));
      this.paintOp(op);
    }
    for (const e of m.ev ?? []) this.event(e);
    for (const s of m.ps) {
      const p = this.players.get(s[0]);
      if (!p) continue;
      p.snaps.push({ t: m.st, x: s[1], y: s[2], vx: s[3], vy: s[4], aim: s[5], face: s[6], w: s[7], fl: s[9] });
      if (p.snaps.length > 30) p.snaps.shift();
      p.hp = s[8]; p.fl = s[9]; p.hold = s[10]; p.alive = !!s[11]; p.kills = s[12]; p.deaths = s[13];
      if (p.id === this.me.id && !p.hold) this.me.thrownId = 0;
    }
    const seen = new Set();
    for (const e of m.es) {
      seen.add(e[0]);
      let en = this.ents.get(e[0]);
      if (!en) this.ents.set(e[0], en = { id: e[0], k: e[1], born: now });
      en.x = e[2]; en.y = e[3]; en.vx = e[4]; en.vy = e[5]; en.rot = e[6]; en.at = now;
    }
    // rockets and grenades vanish from updates when they're done; pieces asleep on the page aren't resent,
    // so those only go away on their own events (grab, settle, smash, gone)
    for (const [id, en] of this.ents) if (!seen.has(id) && en.k !== 2) this.ents.delete(id);
    if (this.round[0] === 0 && m.r[0] === 1) this.showBoard = false;
    this.round = m.r;
  }

  event(e) {
    const me = this.me;
    switch (e[0]) {
      case 'join':
        this.addPlayer(e[1], e[2], e[3], e[4]);
        if (e[1] !== me.id && !e[4]) this.toast(`${e[2]} joined`);
        break;
      case 'leave': {
        const p = this.players.get(e[1]);
        if (p && !p.bot) this.toast(`${p.name} left`);
        this.players.delete(e[1]);
        break;
      }
      case 'spawn': {
        const p = this.players.get(e[1]);
        if (p) { p.snaps.length = 0; p.alive = true; p.hp = 100; }
        if (e[1] === me.id) {
          me.body = newBody(e[2], e[3]); me.life = e[4]; me.alive = true;
          me.charge = 0; me.charging = false; me.thrownId = 0;
          this.sfx.play('spawn', 0.7);
        }
        break;
      }
      case 'shot': if (e[1] !== me.id) this.shotFx(e[1], e[2], e[3], e[4], e.slice(5)); break;
      case 'nade': if (e[1] !== me.id) this.sound('nade', this.posOf(e[1])); break;
      case 'boom': {
        const [, x, y, r] = e;
        this.fx.push({ k: 'boom', x, y, r, t: 0, dur: 0.45 });
        for (let i = 0; i < 12; i++) {
          const a = Math.random() * Math.PI * 2, s = 30 + Math.random() * 90;
          this.fx.push({ k: 'smoke', x: x + Math.cos(a) * r * 0.3, y: y + Math.sin(a) * r * 0.3, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 40, r: 6 + Math.random() * 10, t: 0, dur: 0.7 + Math.random() * 0.6 });
        }
        this.sound('boom', { x, y });
        this.shake(r / 6, { x, y });
        break;
      }
      case 'spark': this.sparks(e[1], e[2], '#ffe08a', 6); break;
      case 'hit': {
        const [, pid, amt, by] = e;
        const p = this.players.get(pid), pos = this.posOf(pid);
        if (pos) this.floaters.push({ x: pos.x + (Math.random() - 0.5) * 10, y: pos.y - 40, text: `-${amt}`, color: by === me.id ? '#ffd23f' : '#ff4d4d', t: 0 });
        if (pid === me.id) { me.lastHurt = this.clock; this.sfx.play('hurt', 0.8); this.shake(Math.min(8, amt / 6)); }
        else if (by === me.id) { this.hitT = this.clock; this.sfx.play('hitmark'); }
        if (p && pos) this.sparks(pos.x, pos.y - 18, p.color, 5);
        break;
      }
      case 'kill': {
        const [, pid, by, cause, x, y] = e;
        const v = this.players.get(pid), k = this.players.get(by);
        this.feed.push({ k: k ?? null, v, verb: VERB[cause] ?? 'wrecked', debris: cause === 'debris', t: 0 });
        if (this.feed.length > 5) this.feed.shift();
        if (v) for (let i = 0; i < 26; i++) this.addGhost({ x: x + (Math.random() - 0.5) * 12, y: y - Math.random() * 30, vx: (Math.random() - 0.5) * 360, vy: -Math.random() * 380, c: this.colorInt(v.color), t: 0 });
        if (pid === me.id) {
          me.alive = false; me.diedAt = this.clock; me.killer = by; me.deathX = x; me.deathY = y;
          this.sfx.play('die', 0.8);
        } else if (by === me.id) this.sfx.play('kill');
        break;
      }
      case 'push':
        if (e[1] === me.id && me.body) { me.body.vx += e[2]; me.body.vy += e[3]; me.body.ground = false; }
        break;
      case 'chunk': this.sprites.set(e[1], chunkSprite(e[2])); break;
      case 'piece': { // a letter or a shard of a box came loose: it keeps its real pixels
        const [, id, idx, cols] = e, g = this.grid, ctx = this.pageCtx;
        this.sprites.set(id, this.pieceSprite(idx, cols));
        for (const i of idx) { // its soft edges sat in the empty cells around it; wipe those too
          const x = i % g.w, y = (i / g.w) | 0;
          for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx, ny = y + dy;
            if (nx >= 0 && ny >= 0 && nx < g.w && ny < g.h && !g.mat[ny * g.w + nx]) ctx.clearRect(nx * CELL, ny * CELL, CELL, CELL);
          }
        }
        break;
      }
      case 'settle': { // lying still: it's rubble now (the cells came as ops), drawn crisp where it lies
        const [, id, x, y, rot] = e, sp = this.sprites.get(id);
        if (sp?.smooth) { this.pageCtx.imageSmoothingEnabled = true; drawChunk(this.pageCtx, sp, x, y, rot); }
        this.sprites.delete(id); this.ents.delete(id);
        break;
      }
      case 'crack': this.sound('crunch', { x: e[1], y: e[2] }, 0.6); this.sparks(e[1], e[2], this.ink, 8); break;
      case 'grab': this.ents.delete(e[2]); this.sound('grab', this.posOf(e[1])); break;
      case 'throw': if (e[1] !== me.id) this.sound('throw', this.posOf(e[1])); break;
      case 'smash': {
        const [, id, x, y, vx, vy, rot, seed] = e;
        const sp = this.sprites.get(id);
        if (sp) for (const pt of smashParticles(x, y, vx, vy, rot, sp.cols, seed)) this.addGhost(pt);
        this.sprites.delete(id); this.ents.delete(id);
        this.sound('crunch', { x, y }, 0.8);
        break;
      }
      case 'gone': {
        const en = this.ents.get(e[1]);
        if (en) this.sound('thud', en, 0.6);
        this.sprites.delete(e[1]); this.ents.delete(e[1]);
        break;
      }
      case 'crunch':
        this.sound('crunch', { x: e[2], y: e[3] });
        this.shake(e[1] === me.id ? 9 : 4, { x: e[2], y: e[3] });
        this.sparks(e[2], e[3], '#ffffff', 10);
        break;
      case 'nograb':
        if (e[1] === me.id) { this.toast(e[2] ? 'That piece is too heavy to lift. Break it up first!' : 'No loose debris in reach. Blast something first!'); this.sfx.play('nograb'); }
        break;
      case 'end': this.sfx.play('end'); this.showBoard = true; break;
    }
  }

  colorInt(hex) {
    const n = parseInt(hex.slice(1), 16);
    return rgb(n >> 16, (n >> 8) & 255, n & 255);
  }

  // The page as it looks right now: the real picture of it, minus what's been destroyed, plus rubble.
  buildPage(g, init, look) {
    const cv = document.createElement('canvas');
    cv.width = this.W; cv.height = this.H;
    const ctx = cv.getContext('2d', { willReadFrequently: false });
    const img = ctx.createImageData(this.W, this.H), px = new Uint32Array(img.data.buffer), W = this.W;
    const cell = (i, c) => {
      const x0 = (i % g.w) * CELL, y0 = ((i / g.w) | 0) * CELL;
      for (let y = y0; y < y0 + CELL; y++) for (let x = x0; x < x0 + CELL; x++) px[y * W + x] = c;
    };
    if (look) {
      const tmp = document.createElement('canvas');
      tmp.width = this.W; tmp.height = this.H;
      const t = tmp.getContext('2d', { willReadFrequently: true });
      t.drawImage(look, 0, 0);
      px.set(new Uint32Array(t.getImageData(0, 0, this.W, this.H).data.buffer));
      // joining late: redraw every cell that has changed since the page was cut up
      if (init) for (let i = 0; i < g.mat.length; i++) if (g.mat[i] !== init.mat[i] || g.col[i] !== init.col[i]) cell(i, g.mat[i] ? g.col[i] : 0);
    } else {
      for (let i = 0; i < g.mat.length; i++) if (g.mat[i]) cell(i, g.col[i]); // no picture of the page: draw the cells
    }
    ctx.putImageData(img, 0, 0);
    this.page = cv; this.pageCtx = ctx;
  }

  // Big backgrounds are scenery: washed out so they never look like something to stand on.
  buildScenery(g, scenery) {
    const cv = document.createElement('canvas'), ctx = cv.getContext('2d');
    if (scenery) {
      cv.width = this.W; cv.height = this.H;
      ctx.globalAlpha = 0.5;
      ctx.drawImage(scenery, 0, 0);
    } else {
      cv.width = g.w; cv.height = g.h;
      const img = ctx.createImageData(g.w, g.h), px = new Uint32Array(img.data.buffer);
      for (let i = 0; i < g.back.length; i++) if (g.back[i]) px[i] = (g.back[i] & 0x00ffffff) | 0x80000000;
      ctx.putImageData(img, 0, 0);
    }
    this.scenery = cv;
  }

  // Keep the picture in step with each change to the cells.
  paintOp(op) {
    const ctx = this.pageCtx, g = this.grid;
    const at = (i) => [(i % g.w) * CELL, ((i / g.w) | 0) * CELL];
    switch (op[0]) {
      case 'c':
        ctx.save();
        ctx.globalCompositeOperation = 'destination-out';
        ctx.beginPath(); ctx.arc(op[1], op[2], op[3] + 0.8, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
        break;
      case 'x': case 'f':
        for (let k = op[0] === 'f' ? 2 : 1; k < op.length; k++) { const [x, y] = at(op[k]); ctx.clearRect(x, y, CELL, CELL); }
        break;
      case 'b':
        for (let k = 1; k < op.length; k += 2) { const [x, y] = at(op[k]); ctx.fillStyle = this.cssOf(op[k + 1]); ctx.fillRect(x, y, CELL, CELL); }
        break;
    }
  }

  // A loose letter / shard drawn from the page's own pixels (or its cell colours if there's no picture).
  pieceSprite(idx, cols) {
    const g = this.grid, shape = pageShape(idx, g.w), member = new Set(idx);
    let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
    for (const i of idx) { const x = i % g.w, y = (i / g.w) | 0; x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    const w = (x1 - x0 + 1) * CELL, h = (y1 - y0 + 1) * CELL, cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const c = cv.getContext('2d');
    if (this.look) {
      c.drawImage(this.look, x0 * CELL, y0 * CELL, w, h, 0, 0, w, h);
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (!member.has(y * g.w + x)) c.clearRect((x - x0) * CELL, (y - y0) * CELL, CELL, CELL);
    } else {
      idx.forEach((i, k) => { c.fillStyle = this.cssOf(cols[k]); c.fillRect(((i % g.w) - x0) * CELL, (((i / g.w) | 0) - y0) * CELL, CELL, CELL); });
    }
    const dx = (x0 - shape.ox - 0.5) * CELL, dy = (y0 - shape.oy - 0.5) * CELL;
    const sp = { cv, dx, dy, dw: w, dh: h, n: idx.length, rad: shape.rad, down: shape.down, cols, off: shape.off, smooth: true };
    if (idx.length <= 40) return sp; // letters stay as they are
    // shards of a box get a thin rim, so a white piece still reads against a white page
    const rim = document.createElement('canvas');
    rim.width = w + 2; rim.height = h + 2;
    const r = rim.getContext('2d');
    for (const [ox, oy] of [[0, 1], [2, 1], [1, 0], [1, 2]]) r.drawImage(cv, ox, oy);
    r.globalCompositeOperation = 'source-in';
    r.fillStyle = this.dark ? 'rgba(255,255,255,0.45)' : 'rgba(0,0,0,0.35)';
    r.fillRect(0, 0, w + 2, h + 2);
    r.globalCompositeOperation = 'source-over';
    r.drawImage(cv, 1, 1);
    return { ...sp, cv: rim, dx: dx - 1, dy: dy - 1, dw: w + 2, dh: h + 2 };
  }

  addGhost(p) {
    if (this.ghosts.length < MAX_GHOSTS) this.ghosts.push(p);
  }

  // ---- input ----

  listen() {
    const on = (t, ev, fn, opt) => { t.addEventListener(ev, fn, opt); (this.unlisten ??= []).push(() => t.removeEventListener(ev, fn, opt)); };
    on(window, 'keydown', (e) => this.key(e, true));
    on(window, 'keyup', (e) => this.key(e, false));
    on(window, 'blur', () => this.clearInput());
    on(this.cv, 'mousemove', (e) => { this.mouse.sx = e.clientX; this.mouse.sy = e.clientY; });
    on(this.cv, 'mousedown', (e) => {
      this.sfx.unlock();
      if (this.paused) return;
      if (e.button === 0) { this.mouse.down = true; this.mouse.pressed = true; }
      if (e.button === 2) this.nadePressed = true;
    });
    on(window, 'mouseup', (e) => { if (e.button === 0) this.mouse.down = false; });
    on(this.cv, 'contextmenu', (e) => e.preventDefault());
    let wheel = 0;
    on(this.cv, 'wheel', (e) => {
      e.preventDefault();
      wheel += e.deltaY;
      if (Math.abs(wheel) < 40) return;
      const n = WEAPONS.length;
      this.me.weapon = (this.me.weapon + (wheel > 0 ? 1 : n - 1)) % n;
      wheel = 0;
    }, { passive: false });
  }

  key(e, down) {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    if (down) this.sfx.unlock();
    const inp = this.input;
    if (e.code === 'Escape') { if (down) this.ui.togglePause?.(); return; }
    if (e.code === 'Tab') { e.preventDefault(); if (this.round[0] === 0) this.showBoard = down; return; }
    if (this.paused) return;
    switch (e.code) {
      case 'KeyA': case 'ArrowLeft': inp.l = down; break;
      case 'KeyD': case 'ArrowRight': inp.r = down; break;
      case 'KeyW': case 'ArrowUp': case 'Space':
        e.preventDefault();
        if (down && !inp.jump) inp.jp = true;
        inp.jump = down;
        break;
      case 'KeyS': case 'ArrowDown':
        e.preventDefault();
        if (down && !inp.down) inp.dp = true;
        inp.down = down;
        break;
      case 'KeyE': case 'KeyF': this.eHeld = down; if (down && !e.repeat) this.grabPressed = true; break;
      case 'KeyG': case 'KeyQ': if (down && !e.repeat) this.nadePressed = true; break;
      case 'KeyM': if (down) { this.sfx.setOn(!this.sfx.on); this.toast(this.sfx.on ? 'Sound on' : 'Sound off'); } break;
      default:
        if (down && e.code in WEAPON_KEYS) this.me.weapon = WEAPON_KEYS[e.code];
    }
  }

  clearInput() {
    Object.assign(this.input, { l: false, r: false, jump: false, down: false, jp: false, dp: false });
    this.mouse.down = false; this.mouse.pressed = false; this.eHeld = false;
  }

  setPaused(p) {
    this.paused = p;
    if (p) { this.clearInput(); this.me.charging = false; this.me.charge = 0; } // or resuming would fire off the wind-up
    if (this.net.solo) this.net.paused = p;
  }

  // ---- simulation of you ----

  frame(ts) {
    this.raf = requestAnimationFrame((t) => this.frame(t));
    const now = ts / 1000, dt = Math.min(0.1, now - (this.last ?? now));
    this.last = now;
    if (!this.ready) return;
    this.acc += dt;
    while (this.acc >= TICK) { this.acc -= TICK; this.tick(TICK); }
    this.updateFx(dt);
    this.render(dt, now);
  }

  heldSprite() {
    const p = this.players.get(this.me.id);
    if (!p?.hold || p.hold === this.me.thrownId) return null;
    return this.sprites.get(p.hold) ?? null;
  }

  tick(dt) {
    this.clock += dt;
    const me = this.me, inp = this.input;
    const solo = this.net.solo;
    if (me.alive && me.body && !(solo && this.paused)) {
      const held = this.heldSprite();
      const ev = stepBody(me.body, inp, this.grid, dt, held ? held.n : 0);
      if (ev === 1) this.sfx.play('jump');
      else if (ev === 2) { this.sfx.play('flip'); me.flipAt = this.clock; }
      else if (ev === 3) this.sfx.play('land', 0.6);
      const w = this.toWorld(this.mouse.sx, this.mouse.sy);
      me.aim = Math.atan2(w.y - (me.body.y - 22), w.x - me.body.x);
      me.face = Math.cos(me.aim) >= 0 ? 1 : -1;
      if (this.round[0] === 0 && !this.paused) this.act(dt, held);
    }
    inp.jp = inp.dp = false;
    this.mouse.pressed = false; this.nadePressed = false; this.grabPressed = false;
    if (++this.tickN % 2 === 0) this.sendState();
  }

  act(dt, held) {
    const me = this.me, m = this.mouse;
    if (held) {
      // E (or left click) throws: tap for a toss along the arc, hold to wind up harder
      if (m.pressed || this.grabPressed) me.charging = true;
      if (me.charging) {
        if (m.down || this.eHeld) me.charge = Math.min(1, me.charge + dt / DEBRIS.charge);
        else {
          this.net.send({ t: 'th', a: r3(me.aim), p: r3(me.charge) });
          me.thrownId = this.players.get(me.id)?.hold ?? 0;
          me.charging = false; me.charge = 0;
          this.sfx.play('throw');
        }
      }
    } else {
      me.charging = false; me.charge = 0;
      const W = WEAPONS[me.weapon];
      if (this.clock >= me.cd[me.weapon] && (m.pressed || (W.auto && m.down))) this.shoot(W);
      if (this.grabPressed) this.net.send({ t: 'e' });
      if (this.nadePressed && this.clock >= me.nade) {
        this.net.send({ t: 'g', a: r3(me.aim) });
        me.nade = this.clock + GRENADE.cd;
        this.sfx.play('nade');
      }
    }
  }

  shoot(W) {
    const me = this.me, b = me.body, w = me.weapon;
    me.cd[w] = this.clock + W.cd;
    const as = [];
    for (let k = 0; k < W.pellets; k++) as.push(r3(me.aim + (Math.random() - 0.5) * 2 * W.spread));
    this.net.send({ t: 'f', w, a: as, x: r1(b.x), y: r1(b.y) });
    this.shotFx(me.id, w, b.x, b.y - 22, as);
    const kick = W.id === 'shotgun' ? 170 : W.id === 'rail' ? 90 : 0; // shotgun hop
    if (kick) { b.vx -= Math.cos(me.aim) * kick; b.vy -= Math.sin(me.aim) * kick; }
    this.shake(W.id === 'rocket' || W.id === 'shotgun' || W.id === 'rail' ? 3 : 1);
  }

  sendState() {
    const me = this.me, b = me.body;
    if (!me.alive || !b) return;
    const fl = (b.flying ? FL_FLY : 0) | (b.flipT > 0 ? FL_FLIP : 0) | (me.charging ? FL_CHARGE : 0);
    this.net.send({ t: 's', life: me.life, x: r1(b.x), y: r1(b.y), vx: r1(b.vx), vy: r1(b.vy), a: r3(me.aim), f: me.face, w: me.weapon, fl });
  }

  // ---- effects ----

  shotFx(pid, w, x, y, as) {
    const W = WEAPONS[w];
    const a0 = as[0] ?? 0;
    this.fx.push({ k: 'flash', x: x + Math.cos(a0) * (9 + W.gun), y: y + Math.sin(a0) * (9 + W.gun), a: a0, t: 0, dur: 0.06 });
    this.sound(W.id, { x, y });
    if (W.kind === 'rocket') return;
    if (W.id === 'rail') {
      const len = 4000;
      this.fx.push({ k: 'beam', x, y, x2: x + Math.cos(a0) * len, y2: y + Math.sin(a0) * len, color: this.players.get(pid)?.color ?? '#fff', t: 0, dur: 0.35 });
      return;
    }
    for (const a of as) this.tracers.push({ x, y, vx: Math.cos(a) * W.speed, vy: Math.sin(a) * W.speed, life: W.range, owner: pid, px: x, py: y });
  }

  sparks(x, y, color, n) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, s = 80 + Math.random() * 220;
      this.fx.push({ k: 'spark', x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 60, color, t: 0, dur: 0.25 + Math.random() * 0.2 });
    }
  }

  posOf(pid) {
    if (pid === this.me.id && this.me.body) return this.me.body;
    const p = this.players.get(pid);
    return p?.snaps.length ? p.snaps[p.snaps.length - 1] : null;
  }

  sound(name, pos, vol = 1) {
    if (!pos || !this.W) { this.sfx.play(name, vol); return; }
    const cx = this.cam.x + this.cv.width / this.zoom / 2, cy = this.cam.y + this.cv.height / this.zoom / 2;
    const d = Math.hypot(pos.x - cx, pos.y - cy);
    this.sfx.play(name, vol * Math.max(0.06, 1 - d / 1500), (pos.x - cx) / 700);
  }

  shake(n, pos) {
    if (pos && this.me.body && Math.hypot(pos.x - this.me.body.x, pos.y - this.me.body.y) > 500) return;
    this.cam.shake = Math.min(14, Math.max(this.cam.shake, n));
  }

  toast(msg) { this.toastMsg = msg; this.toastT = 2.6; }

  updateFx(dt) {
    const g = this.grid;
    let n = 0;
    for (const p of this.ghosts) {
      if (p.landed !== undefined) { p.landed -= dt; if (p.landed > 0) this.ghosts[n++] = p; continue; }
      const r = stepParticle(p, g, dt);
      if (r === 1) p.landed = 0.25; // the server's real copy settles about now; hold still until it shows
      if (r !== 2) this.ghosts[n++] = p;
    }
    this.ghosts.length = n;

    this.tracers = this.tracers.filter((t) => {
      t.life -= dt;
      t.px = t.x; t.py = t.y;
      const steps = Math.ceil((Math.hypot(t.vx, t.vy) * dt) / 3);
      for (let k = 0; k < steps; k++) {
        t.x += (t.vx * dt) / steps; t.y += (t.vy * dt) / steps;
        if (g.atPx(t.x, t.y) !== 0 || this.tracerHits(t)) { this.sparks(t.x, t.y, '#ffe9a8', 2); return false; }
      }
      return t.life > 0 && t.y < this.H + 100;
    });

    this.fx = this.fx.filter((f) => {
      f.t += dt;
      if (f.vx !== undefined) { f.x += f.vx * dt; f.y += f.vy * dt; if (f.k === 'spark') f.vy += 900 * dt; else { f.vx *= 0.96; f.vy *= 0.96; } }
      return f.t < f.dur;
    });
    this.floaters = this.floaters.filter((f) => (f.t += dt) < 0.9);
    for (const f of this.feed) f.t += dt;
    this.feed = this.feed.filter((f) => f.t < 6);
    this.toastT -= dt;
    this.cam.shake = Math.max(0, this.cam.shake - dt * 30);
  }

  tracerHits(t) {
    for (const p of this.players.values()) {
      if (p.id === t.owner || !p.alive) continue;
      const s = p.id === this.me.id ? this.me.body : p.draw;
      if (s && t.x > s.x - P.w / 2 && t.x < s.x + P.w / 2 && t.y > s.y - P.h && t.y < s.y) return true;
    }
    return false;
  }

  // ---- drawing ----

  toWorld(sx, sy) {
    const dpr = this.dpr ?? 1;
    return { x: this.cam.x + (sx * dpr) / this.zoom, y: this.cam.y + (sy * dpr) / this.zoom };
  }

  // Remote players are drawn a little in the past, between two snapshots.
  sample(p, rt) {
    const s = p.snaps;
    if (!s.length) return null;
    const last = s[s.length - 1];
    if (rt >= last.t) {
      const k = Math.min(0.12, rt - last.t);
      return { ...last, x: last.x + last.vx * k, y: last.y + last.vy * k };
    }
    let i = s.length - 1;
    while (i > 0 && s[i - 1].t > rt) i--;
    if (i === 0) return s[0];
    const a = s[i - 1], b = s[i], f = (rt - a.t) / Math.max(1e-6, b.t - a.t);
    let da = b.aim - a.aim;
    if (da > Math.PI) da -= Math.PI * 2; else if (da < -Math.PI) da += Math.PI * 2;
    return { ...b, x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, vx: a.vx + (b.vx - a.vx) * f, vy: a.vy + (b.vy - a.vy) * f, aim: a.aim + da * f };
  }

  cssOf(c) {
    let s = this.colorCss.get(c);
    if (!s) { s = css(c); this.colorCss.set(c, s); }
    return s;
  }

  render(dt, now) {
    const cv = this.cv, ctx = this.ctx, dpr = this.dpr = Math.min(2, window.devicePixelRatio || 1);
    const cw = Math.round(innerWidth * dpr), ch = Math.round(innerHeight * dpr);
    if (cv.width !== cw || cv.height !== ch) { cv.width = cw; cv.height = ch; }
    const z = this.zoom = Math.max(0.6, Math.min(2.6, innerHeight / 720)) * dpr;
    const vw = cw / z, vh = ch / z, me = this.me;

    let tx, ty;
    if (me.alive && me.body) {
      tx = me.body.x + ((this.mouse.sx - innerWidth / 2) * dpr / z) * 0.3;
      ty = me.body.y - 30 + ((this.mouse.sy - innerHeight / 2) * dpr / z) * 0.3;
    } else {
      const k = this.players.get(me.killer);
      const ks = k && k.id !== me.id && this.clock - me.diedAt > 0.8 ? k.draw : null;
      tx = ks ? ks.x : me.deathX ?? this.W / 2;
      ty = ks ? ks.y - 30 : me.deathY ?? 300;
    }
    tx -= vw / 2; ty -= vh / 2;
    if (!this.camInit) { this.cam.x = tx; this.cam.y = ty; this.camInit = true; }
    const k = Math.min(1, dt * 9);
    this.cam.x += (tx - this.cam.x) * k;
    this.cam.y += (ty - this.cam.y) * k;
    this.cam.x = this.W <= vw ? (this.W - vw) / 2 : Math.max(-40, Math.min(this.W - vw + 40, this.cam.x));
    this.cam.y = Math.max(-260, Math.min(this.H + 160 - vh, this.cam.y));
    const sh = this.cam.shake, sx = (Math.random() - 0.5) * sh, sy = (Math.random() - 0.5) * sh;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = this.bgCss;
    ctx.fillRect(0, 0, cw, ch);
    ctx.setTransform(z, 0, 0, z, (-this.cam.x + sx) * z, (-this.cam.y + sy) * z);
    ctx.imageSmoothingEnabled = false;

    // the page itself: washed-out scenery, then everything you can stand on and break
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.scenery, 0, 0, this.W, this.H);
    ctx.drawImage(this.page, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = this.dark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)';
    ctx.fillRect(-2000, 0, 2000, this.H); ctx.fillRect(this.W, 0, 2000, this.H);
    ctx.fillStyle = 'rgba(230,40,40,0.14)';
    ctx.fillRect(-2000, this.H, this.W + 4000, 4000);
    ctx.fillStyle = 'rgba(230,40,40,0.5)';
    for (let x = 0; x < this.W; x += 24) ctx.fillRect(x, this.H, 12, 2);

    // loose bits in the air
    for (const p of this.ghosts) { ctx.fillStyle = this.cssOf(p.c); ctx.fillRect(p.x - CELL / 2, p.y - CELL / 2, CELL, CELL); }

    // rockets, grenades, thrown chunks: extrapolated from the newest snapshot so they don't lag
    const tnow = performance.now() / 1000;
    for (const e of this.ents.values()) {
      const d = Math.min(0.12, tnow - e.at);
      const moving = e.vx || e.vy; // a piece asleep on the page doesn't fall any further
      const x = e.x + e.vx * d, y = e.y + e.vy * d + (e.k && moving ? 0.5 * (e.k === 1 ? GRENADE.gravity : DEBRIS.gravity) * d * d : 0);
      e.drawX = x; e.drawY = y;
      if (e.k === 0) {
        drawRocket(ctx, x, y, Math.atan2(e.vy, e.vx), this.ink);
        if (Math.random() < 0.7) this.fx.push({ k: 'smoke', x, y, vx: (Math.random() - 0.5) * 20, vy: -10, r: 3 + Math.random() * 3, t: 0, dur: 0.5 });
      } else if (e.k === 1) drawGrenade(ctx, x, y, e.rot, now, this.ink);
      else {
        const sp = this.sprites.get(e.id);
        if (sp) drawChunk(ctx, sp, x, y, e.rot);
      }
    }

    // players
    const rt = tnow + (this.offset ?? 0) - INTERP_DELAY;
    for (const p of this.players.values()) {
      let s;
      if (p.id === me.id) {
        if (!me.alive || !me.body) { p.draw = null; continue; }
        const b = me.body;
        s = { x: b.x, y: b.y, vx: b.vx, vy: b.vy, aim: me.aim, face: me.face, w: me.weapon, fl: (b.flying ? FL_FLY : 0) | (p.fl & 4), ground: b.ground };
        const fp = (this.clock - me.flipAt) / 0.4;
        s.flip = fp < 1 ? fp : -1;
        s.holding = this.heldSprite();
        s.charge = me.charge;
      } else {
        if (!p.alive) { p.draw = null; continue; }
        s = this.sample(p, rt);
        if (!s) continue;
        s.ground = Math.abs(s.vy) < 40 && !(s.fl & FL_FLY);
        if (s.fl & FL_FLIP && !(p.lastFl & FL_FLIP)) p.flipAt = this.clock;
        p.lastFl = s.fl;
        const fp = (this.clock - p.flipAt) / 0.4;
        s.flip = fp < 1 ? fp : -1;
        s.holding = p.hold ? this.sprites.get(p.hold) ?? null : null;
        s.charge = s.fl & FL_CHARGE ? 0.7 : 0;
      }
      p.phase += Math.abs(s.vx) * dt * 0.055;
      Object.assign(s, { phase: p.phase, color: p.color, name: p.name, hp: p.hp });
      p.draw = s;
      drawStick(ctx, s, this.ink, now);
      if (s.holding) drawChunk(ctx, s.holding, s.x - s.face * 5 * (s.charge || 0), s.y - P.h - s.holding.down - 1, 0);
      if (p.id !== me.id) drawTag(ctx, s, this.ink, this.paper, p.hp < 100);
    }

    // where a throw would go, or what E would pick up
    const held = me.alive && me.body ? this.heldSprite() : null;
    if (held) this.drawArc(ctx, held);
    else if (me.alive && me.body) this.drawGrabHint(ctx, now);

    for (const t of this.tracers) {
      ctx.strokeStyle = '#ffd36b'; ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.moveTo(t.px - t.vx * 0.012, t.py - t.vy * 0.012); ctx.lineTo(t.x, t.y); ctx.stroke();
    }
    for (const f of this.fx) this.drawFx(ctx, f);
    ctx.font = '800 11px system-ui, sans-serif'; ctx.textAlign = 'center';
    for (const f of this.floaters) {
      ctx.globalAlpha = 1 - f.t / 0.9;
      ctx.lineWidth = 3; ctx.strokeStyle = this.paper; ctx.strokeText(f.text, f.x, f.y - f.t * 30);
      ctx.fillStyle = f.color; ctx.fillText(f.text, f.x, f.y - f.t * 30);
    }
    ctx.globalAlpha = 1;

    this.drawHud(ctx, dpr);
  }

  drawArc(ctx, sp) {
    const me = this.me, b = me.body;
    const power = me.charging ? me.charge : 0;
    const v = throwVelocity(me.aim, power, sp.n, b.vx, b.vy);
    let x = b.x, y = b.y - P.h - sp.down - 1, vx = v.vx, vy = v.vy;
    ctx.fillStyle = me.charging ? (this.dark ? 'rgba(255,255,255,0.85)' : 'rgba(0,0,0,0.7)') : (this.dark ? 'rgba(255,255,255,0.3)' : 'rgba(0,0,0,0.25)');
    let clear = this.grid.atPx(x, y) === 0; // like the server: it passes through what it starts inside
    for (let i = 0; i < 40; i++) {
      for (let k = 0; k < 3; k++) { vy += DEBRIS.gravity * 0.01; x += vx * 0.01; y += vy * 0.01; }
      const solid = this.grid.atPx(x, y) !== 0;
      if (y > this.H || (clear && solid)) break;
      if (!solid) clear = true;
      if (i % 2 === 0) ctx.fillRect(x - 1.5, y - 1.5, 3, 3);
    }
    if (me.charging) { // charge meter over the rock
      const cx = b.x, cy = b.y - P.h - sp.down * 2 - 10;
      ctx.fillStyle = this.paper; ctx.fillRect(cx - 16, cy, 32, 5);
      ctx.fillStyle = me.charge >= 1 ? '#ff4d4d' : '#ffd23f'; ctx.fillRect(cx - 15, cy + 1, 30 * me.charge, 3);
    }
  }

  // The piece E would grab (same rule as the server: nearest one within reach), marked with a key badge.
  drawGrabHint(ctx, now) {
    const b = this.me.body, cx = b.x, cy = b.y - P.h / 2;
    let best = null, bd = Infinity;
    for (const e of this.ents.values()) {
      const sp = e.k === 2 && this.sprites.get(e.id);
      if (!sp || e.drawX === undefined) continue;
      const d = Math.hypot(e.drawX - cx, e.drawY - cy) - sp.rad;
      if (d < DEBRIS.reach && d < bd) { best = { e, sp }; bd = d; }
    }
    if (!best) return;
    const heavy = best.sp.n > DEBRIS.carryMax, x = best.e.drawX, y = best.e.drawY - Math.min(best.sp.rad, 40) - 12 + Math.sin(now * 6) * 2;
    ctx.save();
    ctx.font = '800 10px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = heavy ? 'rgba(120,120,120,0.85)' : '#ffd23f';
    ctx.strokeStyle = this.ink; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.roundRect(x - 8, y - 8, 16, 16, 3); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#141414'; ctx.fillText('E', x, y + 0.5);
    ctx.restore();
  }

  drawFx(ctx, f) {
    const k = f.t / f.dur;
    switch (f.k) {
      case 'boom':
        ctx.globalAlpha = 1 - k;
        ctx.fillStyle = k < 0.25 ? '#fffbe6' : '#ffb02e';
        ctx.beginPath(); ctx.arc(f.x, f.y, f.r * (0.5 + k * 0.9), 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#ff5a1f';
        ctx.beginPath(); ctx.arc(f.x, f.y, f.r * (0.3 + k * 0.5), 0, Math.PI * 2); ctx.fill();
        break;
      case 'smoke':
        ctx.globalAlpha = 0.45 * (1 - k);
        ctx.fillStyle = this.dark ? '#9a9a9a' : '#707070';
        ctx.beginPath(); ctx.arc(f.x, f.y, f.r * (1 + k), 0, Math.PI * 2); ctx.fill();
        break;
      case 'spark':
        ctx.globalAlpha = 1 - k;
        ctx.fillStyle = f.color; ctx.fillRect(f.x - 1, f.y - 1, 2, 2);
        break;
      case 'flash':
        ctx.globalAlpha = 1 - k;
        ctx.fillStyle = '#fff3b0';
        ctx.save(); ctx.translate(f.x, f.y); ctx.rotate(f.a);
        ctx.beginPath(); ctx.moveTo(0, -4); ctx.lineTo(12, 0); ctx.lineTo(0, 4); ctx.fill();
        ctx.restore();
        break;
      case 'beam':
        ctx.globalAlpha = 1 - k;
        ctx.strokeStyle = f.color; ctx.lineWidth = 4 * (1 - k) + 1;
        ctx.beginPath(); ctx.moveTo(f.x, f.y); ctx.lineTo(f.x2, f.y2); ctx.stroke();
        ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(f.x, f.y); ctx.lineTo(f.x2, f.y2); ctx.stroke();
        break;
    }
    ctx.globalAlpha = 1;
  }

  // ---- HUD (screen space, CSS px) ----

  drawHud(ctx, dpr) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const W = innerWidth, H = innerHeight, me = this.me, mp = this.players.get(me.id);
    const panel = this.dark ? 'rgba(20,20,24,0.82)' : 'rgba(255,255,255,0.86)', txt = this.dark ? '#f2f2f2' : '#151515';
    ctx.textBaseline = 'middle';

    // crosshair
    const { sx, sy } = this.mouse, hit = this.clock - this.hitT < 0.15;
    ctx.strokeStyle = hit ? '#ff4d4d' : txt; ctx.lineWidth = 2;
    ctx.beginPath();
    for (const [a, b] of [[[-10, 0], [-4, 0]], [[4, 0], [10, 0]], [[0, -10], [0, -4]], [[0, 4], [0, 10]]]) { ctx.moveTo(sx + a[0], sy + a[1]); ctx.lineTo(sx + b[0], sy + b[1]); }
    if (hit) { ctx.moveTo(sx - 7, sy - 7); ctx.lineTo(sx + 7, sy + 7); ctx.moveTo(sx + 7, sy - 7); ctx.lineTo(sx - 7, sy + 7); }
    ctx.stroke();

    // top left: where you are
    ctx.font = '700 12px system-ui, sans-serif'; ctx.textAlign = 'left';
    const label = this.code ? `ROOM ${this.code}` : 'SOLO';
    const info = `${label}  ·  ${this.mapName}`;
    ctx.fillStyle = panel; ctx.fillRect(10, 10, ctx.measureText(info).width + 20, 26);
    ctx.fillStyle = txt; ctx.fillText(info, 20, 23);
    ctx.font = '500 11px system-ui, sans-serif';
    ctx.fillStyle = this.dark ? 'rgba(255,255,255,0.6)' : 'rgba(0,0,0,0.55)';
    ctx.fillText('Esc menu · Tab scores · E grab debris', 12, 46);

    // clock
    if (this.round[1] >= 0) {
      const t = this.round[1], s = this.round[0] === 0 ? `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}` : `Next round in ${t}`;
      ctx.font = '800 16px system-ui, sans-serif'; ctx.textAlign = 'center';
      const w = ctx.measureText(s).width + 24;
      ctx.fillStyle = panel; ctx.fillRect(W / 2 - w / 2, 10, w, 28);
      ctx.fillStyle = this.round[0] === 0 && t <= 10 ? '#ff4d4d' : txt; ctx.fillText(s, W / 2, 24);
    }

    // kill feed
    ctx.font = '700 12px system-ui, sans-serif'; ctx.textAlign = 'right';
    ctx.textAlign = 'left';
    this.feed.forEach((f, i) => {
      const y = 22 + i * 24, victim = [f.v?.name ?? '?', f.v?.color ?? txt];
      const parts = f.k
        ? [[f.k.name, f.k.color], [` ${f.verb} `, f.debris ? '#ff8c2e' : txt], victim]
        : [victim, [f.verb === 'knocked off' ? ' fell off the page' : ' wrecked themselves', txt]];
      const total = parts.reduce((s, [t]) => s + ctx.measureText(t).width, 0);
      let x = W - 20 - total;
      ctx.globalAlpha = Math.min(1, (6 - f.t) * 2);
      ctx.fillStyle = panel; ctx.fillRect(x - 10, y - 10, total + 20, 21);
      for (const [t, c] of parts) { ctx.fillStyle = c; ctx.fillText(t, x, y); x += ctx.measureText(t).width; }
      ctx.globalAlpha = 1;
    });

    // bottom left: health + jet fuel
    const hp = mp?.hp ?? 0;
    ctx.fillStyle = panel; ctx.fillRect(14, H - 54, 220, 40);
    ctx.fillStyle = this.dark ? '#333' : '#ddd'; ctx.fillRect(24, H - 46, 200, 14);
    ctx.fillStyle = hp > 35 ? '#3ccf5a' : '#ff4d4d'; ctx.fillRect(24, H - 46, 2 * Math.max(0, hp), 14);
    ctx.font = '800 11px system-ui, sans-serif'; ctx.textAlign = 'left'; ctx.fillStyle = '#111';
    ctx.fillText(`${Math.max(0, hp)} HP`, 28, H - 39);
    const fuel = me.body ? me.body.fuel / P.fuel : 0;
    ctx.fillStyle = '#ffb02e'; ctx.fillRect(24, H - 27, 200 * Math.max(0, fuel), 5);

    // bottom centre: weapons, grenade, debris
    const slots = [...WEAPONS.map((w, i) => ({ key: String(i + 1), name: w.name, on: me.weapon === i && !this.heldSprite() })),
      { key: 'RMB', name: 'Grenade', cd: Math.max(0, me.nade - this.clock) / GRENADE.cd },
      { key: 'E', name: this.heldSprite() ? `${this.heldSprite().smooth ? 'Piece' : 'Rock'} ×${this.heldSprite().n}` : 'Debris', on: !!this.heldSprite() }];
    ctx.font = '700 11px system-ui, sans-serif';
    const sw = 76, total = slots.length * (sw + 6) - 6;
    let x = W / 2 - total / 2;
    for (const s of slots) {
      ctx.fillStyle = s.on ? '#ffd23f' : panel; ctx.fillRect(x, H - 50, sw, 36);
      if (s.cd) { ctx.fillStyle = 'rgba(128,128,128,0.45)'; ctx.fillRect(x, H - 50, sw * s.cd, 36); }
      ctx.fillStyle = s.on ? '#111' : txt; ctx.textAlign = 'center';
      ctx.fillText(s.name, x + sw / 2, H - 27);
      ctx.font = '600 9px system-ui, sans-serif'; ctx.globalAlpha = 0.7;
      ctx.fillText(s.key, x + sw / 2, H - 41);
      ctx.globalAlpha = 1; ctx.font = '700 11px system-ui, sans-serif';
      x += sw + 6;
    }
    if (this.heldSprite() && me.alive) {
      ctx.textAlign = 'center'; ctx.font = '700 12px system-ui, sans-serif';
      const tip = 'Tap E to toss it along the arc · hold E (or left click) to throw harder';
      ctx.fillStyle = panel; ctx.fillRect(W / 2 - ctx.measureText(tip).width / 2 - 10, H - 80, ctx.measureText(tip).width + 20, 22);
      ctx.fillStyle = txt; ctx.fillText(tip, W / 2, H - 69);
    }

    // hurt flash
    const hurt = 1 - (this.clock - me.lastHurt) / 0.35;
    if (hurt > 0) { ctx.fillStyle = `rgba(255,40,40,${0.22 * hurt})`; ctx.fillRect(0, 0, W, H); }

    // dead
    if (!me.alive && this.ready && this.round[0] === 0) {
      const k = this.players.get(me.killer);
      ctx.textAlign = 'center'; ctx.font = '900 30px system-ui, sans-serif';
      ctx.fillStyle = panel; ctx.fillRect(W / 2 - 220, H / 2 - 70, 440, 90);
      ctx.fillStyle = '#ff4d4d'; ctx.fillText('WRECKED', W / 2, H / 2 - 42);
      ctx.font = '600 14px system-ui, sans-serif'; ctx.fillStyle = txt;
      ctx.fillText(k && k.id !== me.id ? `by ${k.name}. Respawning…` : 'Respawning…', W / 2, H / 2 - 8);
    }

    if (this.toastT > 0) {
      ctx.globalAlpha = Math.min(1, this.toastT * 3);
      ctx.textAlign = 'center'; ctx.font = '700 14px system-ui, sans-serif';
      const w = ctx.measureText(this.toastMsg).width + 28;
      ctx.fillStyle = panel; ctx.fillRect(W / 2 - w / 2, H - 120, w, 30);
      ctx.fillStyle = txt; ctx.fillText(this.toastMsg, W / 2, H - 105);
      ctx.globalAlpha = 1;
    }

    if (this.showBoard || this.round[0] === 1) this.drawBoard(ctx, W, H, panel, txt);
  }

  drawBoard(ctx, W, H, panel, txt) {
    const rows = [...this.players.values()].sort((a, b) => b.kills - a.kills || a.deaths - b.deaths);
    const w = 380, h = 74 + rows.length * 28, x = W / 2 - w / 2, y = Math.max(60, H / 2 - h / 2 - 40);
    ctx.fillStyle = panel; ctx.fillRect(x, y, w, h);
    ctx.textAlign = 'center'; ctx.font = '900 18px system-ui, sans-serif'; ctx.fillStyle = txt;
    ctx.fillText(this.round[0] === 1 ? (rows[0] ? `${rows[0].name} wins the round!` : 'Round over') : 'Scores', W / 2, y + 24);
    ctx.font = '700 11px system-ui, sans-serif'; ctx.globalAlpha = 0.6;
    ctx.textAlign = 'left'; ctx.fillText('PLAYER', x + 20, y + 52);
    ctx.textAlign = 'right'; ctx.fillText('WRECKS', x + w - 90, y + 52); ctx.fillText('DEATHS', x + w - 20, y + 52);
    ctx.globalAlpha = 1; ctx.font = '700 14px system-ui, sans-serif';
    rows.forEach((p, i) => {
      const ry = y + 78 + i * 28;
      if (p.id === this.me.id) { ctx.fillStyle = 'rgba(255,210,63,0.25)'; ctx.fillRect(x + 8, ry - 13, w - 16, 26); }
      ctx.textAlign = 'left'; ctx.fillStyle = p.color; ctx.fillText(`${p.name}${p.bot ? ' (bot)' : ''}`, x + 20, ry);
      ctx.textAlign = 'right'; ctx.fillStyle = txt;
      ctx.fillText(String(p.kills), x + w - 90, ry); ctx.fillText(String(p.deaths), x + w - 20, ry);
    });
  }

  destroy() {
    this.destroyed = true;
    cancelAnimationFrame(this.raf);
    for (const f of this.unlisten ?? []) f();
    this.ready = false;
  }
}
