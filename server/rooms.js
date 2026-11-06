// Rooms: who is connected, which page they are fighting on, and the 60 Hz loop that runs each match.
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { Grid } from '../shared/grid.js';
import { Game } from '../shared/game.js';
import { TICK, NET_TICKS, MAX_PLAYERS } from '../shared/const.js';

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const DEMO_MAPS = ['news', 'wiki', 'shop', 'devlog'];
const EMPTY_ROOM_TTL = 30_000;
const MAP_WAIT = 90_000;      // a host gets this long to send a page
const MAX_ROOMS = 200;
const MAX_PER_IP = 16;

export const packGrid = (g) => zlib.deflateSync(g.encode(), { level: 1 }).toString('base64');
export function unpackGrid(b64) {
  if (typeof b64 !== 'string' || b64.length > 8_000_000) throw new Error('map too big');
  const raw = zlib.inflateSync(Buffer.from(b64, 'base64'), { maxOutputLength: 12 << 20 });
  return Grid.decode(new Uint8Array(raw.buffer, raw.byteOffset, raw.length));
}

// The host's picture of the page (crisp text and images); only relayed, as an image data URL.
const IMG_RE = /^data:image\/(webp|png);base64,[A-Za-z0-9+/]+={0,2}$/;
const imageData = (s) => (typeof s === 'string' && s.length < 6_000_000 && IMG_RE.test(s) ? s : null);

export const cleanText = (s, n) => (typeof s === 'string' ? s : '').replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim().slice(0, n);
const pick = (a) => a[crypto.randomInt(a.length)];

class Conn {
  constructor(ws, name) {
    this.ws = ws; this.name = name; this.pid = 0; this.room = null;
    this.tokens = 240; this.refill = Date.now(); this.lastMap = 0;
  }
  send(m) { this.sendRaw(JSON.stringify(m)); }
  sendRaw(s) {
    if (this.ws.readyState !== 1) return;
    // updates carry terrain changes, so they can't be dropped: a client this far behind is gone
    if (this.ws.bufferedAmount > 16e6) { this.ws.terminate(); return; }
    this.ws.send(s);
  }
  allow() {
    const now = Date.now();
    this.tokens = Math.min(240, this.tokens + ((now - this.refill) / 1000) * 120);
    this.refill = now;
    if (this.tokens < 1) return false;
    this.tokens--;
    return true;
  }
}

class Room {
  constructor(code, isPublic, debrisOnly) {
    this.code = code; this.public = isPublic; this.debrisOnly = debrisOnly;
    this.conns = new Set(); this.host = null; this.game = null;
    this.mapName = ''; this.tickN = 0; this.emptySince = Date.now(); this.created = Date.now();
    this.packed = null; this.packedRev = -1;
    this.img = null; this.bg = null; this.initPacked = null;
  }

  get humans() { return this.conns.size; }

  add(conn) {
    this.conns.add(conn); conn.room = this;
    if (!this.host) this.host = conn;
    if (this.game) this.enter(conn);
    else if (conn === this.host) this.askMap();
    else conn.send({ t: 'wait', code: this.code });
  }

  askMap() {
    this.host.send({ t: 'needmap', code: this.code, suggest: this.public ? pick(DEMO_MAPS) : null });
  }

  enter(conn) {
    this.flush(); // get queued changes out first so the map we pack is current for everyone
    if (this.game.players.size >= MAX_PLAYERS) this.game.removeBot();
    const p = this.game.addPlayer(conn.name);
    conn.pid = p.id;
    conn.send({ t: 'welcome', code: this.code, host: this.host?.pid ?? 0, public: this.public, ...this.mapMsg(), ...this.game.welcome(p.id) });
    this.autoBots();
  }

  // one compressed copy of the page per terrain change, however many people join
  pack() {
    if (this.packedRev !== this.game.rev) { this.packed = packGrid(this.game.grid); this.packedRev = this.game.rev; }
    return this.packed;
  }

  // the page now, the page as it started (so a joiner can redraw what's been wrecked) and its pictures
  mapMsg() {
    this.initPacked ??= packGrid(this.game.initial);
    return { map: this.pack(), init: this.initPacked, img: this.img, bg: this.bg, mapName: this.mapName };
  }

  remove(conn) {
    this.conns.delete(conn);
    if (conn.pid && this.game) this.game.removePlayer(conn.pid);
    if (this.host === conn) {
      this.host = this.conns.values().next().value ?? null;
      if (this.host) {
        this.broadcast({ t: 'host', id: this.host.pid });
        if (!this.game) this.askMap();
      }
    }
    if (!this.conns.size) this.emptySince = Date.now();
    this.autoBots();
  }

  onMessage(conn, m) {
    if (m.t === 'map') { this.setMap(conn, m); return; }
    if (m.t === 'bot') {
      if (conn === this.host && this.game) { if (m.add) this.game.addBot(); else this.game.removeBot(); }
      return;
    }
    if (this.game && conn.pid) this.game.handle(conn.pid, m);
  }

  setMap(conn, m) {
    if (conn !== this.host) return;
    if (Date.now() - conn.lastMap < 2000) { conn.send({ t: 'maperror', msg: 'Wait a moment before loading another page.' }); return; }
    conn.lastMap = Date.now();
    let grid;
    try { grid = unpackGrid(m.data); } catch { conn.send({ t: 'maperror', msg: 'That map could not be read.' }); return; }
    this.mapName = cleanText(m.name, 80);
    this.img = imageData(m.img); this.bg = imageData(m.bg); this.initPacked = null;
    if (!this.game) {
      this.game = new Game(grid, { timed: true, debrisOnly: this.debrisOnly });
      for (const c of this.conns) this.enter(c);
    } else {
      this.game.loadMap(grid); // everyone gets it with the next update
    }
  }

  tick() {
    if (!this.game || !this.conns.size) return;
    this.game.step(TICK);
    if (++this.tickN % NET_TICKS === 0) this.flush();
  }

  flush() {
    const g = this.game;
    if (!g) return;
    if (g.needsReload) {
      g.needsReload = false;
      const map = this.mapMsg();
      for (const c of this.conns) if (c.pid) c.send({ t: 'reload', ...map, host: this.host?.pid ?? 0, ...g.welcome(c.pid) });
    }
    const msg = JSON.stringify(g.flush());
    for (const c of this.conns) if (c.pid) c.sendRaw(msg);
  }

  // Quick-match rooms top themselves up with bots so nobody fights an empty page.
  autoBots() {
    if (!this.public || !this.game) return;
    const want = this.humans === 0 ? 0 : Math.max(0, Math.min(2, 3 - this.humans));
    while (this.game.bots < want && this.game.players.size < MAX_PLAYERS) this.game.addBot();
    while (this.game.bots > want) this.game.removeBot();
  }

  broadcast(m) { const s = JSON.stringify(m); for (const c of this.conns) c.sendRaw(s); }
}

export class Rooms {
  constructor() {
    this.rooms = new Map();
    this.perIp = new Map();
    let last = performance.now(), acc = 0;
    this.timer = setInterval(() => {
      const now = performance.now();
      acc = Math.min(acc + (now - last) / 1000, 0.25);
      last = now;
      while (acc >= TICK) {
        acc -= TICK;
        for (const r of this.rooms.values()) r.tick();
      }
      for (const [code, r] of this.rooms) {
        if (!r.conns.size && Date.now() - r.emptySince > EMPTY_ROOM_TTL) this.rooms.delete(code);
        else if (!r.game && Date.now() - r.created > MAP_WAIT) { // host never sent a page: free the slot
          for (const c of r.conns) { c.send({ t: 'error', msg: 'The host never picked a page.' }); c.ws.close(); }
          this.rooms.delete(code);
        }
      }
    }, 4);
  }

  create(isPublic, debrisOnly = false) {
    let code;
    do code = Array.from({ length: 6 }, () => CODE_CHARS[crypto.randomInt(CODE_CHARS.length)]).join('');
    while (this.rooms.has(code));
    const r = new Room(code, isPublic, debrisOnly);
    this.rooms.set(code, r);
    return r;
  }

  connect(ws, params, ip = '') {
    const conn = new Conn(ws, cleanText(params.get('name'), 16) || 'Player');
    const n = (this.perIp.get(ip) ?? 0) + 1;
    if (n > MAX_PER_IP) { conn.send({ t: 'error', msg: 'Too many connections from your address.' }); ws.close(); return; }
    this.perIp.set(ip, n);
    ws.on('close', () => { const k = (this.perIp.get(ip) ?? 1) - 1; if (k > 0) this.perIp.set(ip, k); else this.perIp.delete(ip); });
    const want = String(params.get('room') || 'new').toUpperCase();
    const refuse = (msg) => { conn.send({ t: 'error', msg }); ws.close(); };
    let room;
    if (want === 'NEW' || want === 'QUICK') {
      // a new room takes the mode you picked; quick match only puts you in a room of that mode
      const debrisOnly = params.get('mode') === 'debris';
      if (want === 'QUICK') room = [...this.rooms.values()].find((r) => r.public && r.debrisOnly === debrisOnly && r.humans < MAX_PLAYERS);
      if (!room) {
        if (this.rooms.size >= MAX_ROOMS) return refuse('The server is full right now. Try again soon.');
        room = this.create(want === 'QUICK', debrisOnly);
      }
    } else {
      room = this.rooms.get(want);
      if (!room) return refuse('No room with that code. It may have ended.');
      if (room.humans >= MAX_PLAYERS) return refuse('That room is full.');
    }
    room.add(conn);
    ws.on('message', (data, isBinary) => {
      if (isBinary || !conn.allow()) return;
      let m;
      try { m = JSON.parse(data); } catch { return; }
      if (!m || typeof m !== 'object' || Array.isArray(m)) return;
      try { room.onMessage(conn, m); } catch (e) { console.error('bad message from', conn.name, e); } // one client must never take the server down
    });
    ws.on('close', () => room.remove(conn));
  }

  close() { clearInterval(this.timer); }
}
