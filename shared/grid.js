// The page as a grid of cells: what each cell is made of and its colour, plus a non-colliding backdrop.
import { CELL, EMPTY, RUBBLE, LAYOUT_W, MAX_H } from './const.js';

// Colours are stored as 0xAABBGGRR so they drop straight into ImageData.
export const rgb = (r, g, b) => ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0;
export const red = (c) => c & 255, green = (c) => (c >>> 8) & 255, blue = (c) => (c >>> 16) & 255;
export const darken = (c, k) => rgb(Math.round(red(c) * k), Math.round(green(c) * k), Math.round(blue(c) * k));
export const css = (c) => `rgb(${red(c)},${green(c)},${blue(c)})`;
export const luma = (c) => (0.299 * red(c) + 0.587 * green(c) + 0.114 * blue(c)) / 255;

const MAGIC = 0x32474244; // "DBG2"
// the biggest map a page can produce; anything larger is not from our rasterizer
export const MAX_GW = LAYOUT_W / CELL, MAX_GH = Math.ceil(MAX_H / CELL);

export class Grid {
  constructor(w, h) {
    this.w = w; this.h = h;
    this.mat = new Uint8Array(w * h);
    this.col = new Uint32Array(w * h);
    this.back = new Uint32Array(w * h); // big page backgrounds: drawn, never collided with
    // what each cell is part of: +n = letter n, -n = box n (an element's background, border or picture), 0 = loose
    this.own = new Int32Array(w * h);
    this.glyphs = new Int32Array(0); // [x0, y0, x1, y1] in cells per letter, inclusive
    this.blocks = new Int32Array(0); // same per box
    this.pageBg = rgb(255, 255, 255);
  }

  get glyphCount() { return this.glyphs.length >> 2; }
  get blockCount() { return this.blocks.length >> 2; }

  clone() {
    const g = new Grid(this.w, this.h);
    g.mat.set(this.mat); g.col.set(this.col); g.back.set(this.back); g.own.set(this.own); g.pageBg = this.pageBg;
    g.glyphs = this.glyphs; g.blocks = this.blocks; // never change after the page is cut up
    return g;
  }

  // Off the sides is wall, above and below is open air.
  at(cx, cy) {
    if (cx < 0 || cx >= this.w) return 1;
    if (cy < 0 || cy >= this.h) return EMPTY;
    return this.mat[cy * this.w + cx];
  }
  atPx(x, y) { return this.at(Math.floor(x / CELL), Math.floor(y / CELL)); }

  clear(i) { this.mat[i] = EMPTY; this.col[i] = 0; this.own[i] = 0; }
  set(i, m, c, o = 0) { this.mat[i] = m; this.col[i] = c; this.own[i] = o; }

  // Clears every filled cell whose centre is within r px of (x, y), calling fn(i, mat, col, own) for each.
  // Only + * and comparisons, so every JS engine clears exactly the same cells.
  carve(x, y, r, fn) {
    const cx = x / CELL, cy = y / CELL, rc = r / CELL, r2 = rc * rc;
    const x0 = Math.max(0, Math.floor(cx - rc)), x1 = Math.min(this.w - 1, Math.floor(cx + rc));
    const y0 = Math.max(0, Math.floor(cy - rc)), y1 = Math.min(this.h - 1, Math.floor(cy + rc));
    for (let j = y0; j <= y1; j++) {
      const dy = j + 0.5 - cy;
      for (let i = x0; i <= x1; i++) {
        const dx = i + 0.5 - cx;
        if (dx * dx + dy * dy > r2) continue;
        const k = j * this.w + i, m = this.mat[k];
        if (m === EMPTY) continue;
        const c = this.col[k], o = this.own[k];
        this.mat[k] = EMPTY; this.col[k] = 0; this.own[k] = 0;
        if (fn) fn(k, m, c, o);
      }
    }
  }

  filled() {
    let n = 0;
    for (let i = 0; i < this.mat.length; i++) if (this.mat[i] !== EMPTY) n++;
    return n;
  }

  equals(o) {
    if (o.w !== this.w || o.h !== this.h) return false;
    for (let i = 0; i < this.mat.length; i++) if (this.mat[i] !== o.mat[i] || this.col[i] !== o.col[i] || this.own[i] !== o.own[i]) return false;
    return true;
  }

  // Run-length encoding: pages are mostly long flat runs, so this plus deflate stays small.
  encode() {
    const w = new Writer();
    w.u32(MAGIC); w.vu(this.w); w.vu(this.h); w.u32(this.pageBg);
    for (const t of [this.glyphs, this.blocks]) {
      w.vu(t.length >> 2);
      for (let k = 0; k < t.length; k += 4) { w.vu(t[k]); w.vu(t[k + 1]); w.vu(t[k + 2] - t[k]); w.vu(t[k + 3] - t[k + 1]); }
    }
    const N = this.w * this.h, mat = this.mat, col = this.col, back = this.back, own = this.own;
    for (let i = 0; i < N;) {
      const m = mat[i], c = m ? col[i] : 0;
      let j = i + 1;
      while (j < N && mat[j] === m && (m === EMPTY || col[j] === c)) j++;
      w.vu(j - i); w.u8(m); if (m) w.u32(c);
      i = j;
    }
    for (let i = 0; i < N;) {
      const o = own[i];
      let j = i + 1;
      while (j < N && own[j] === o) j++;
      w.vu(j - i); w.vu(o >= 0 ? o * 2 : -o * 2 - 1);
      i = j;
    }
    for (let i = 0; i < N;) {
      const c = back[i];
      let j = i + 1;
      while (j < N && back[j] === c) j++;
      w.vu(j - i); w.u32(c);
      i = j;
    }
    return w.bytes();
  }

  static decode(bytes) {
    const r = new Reader(bytes);
    if (r.u32() !== MAGIC) throw new Error('not a map');
    const gw = r.vu(), gh = r.vu();
    if (!gw || !gh || gw > MAX_GW || gh > MAX_GH) throw new Error('bad map size');
    const g = new Grid(gw, gh);
    g.pageBg = r.u32();
    const table = () => {
      const n = r.vu();
      if (n > gw * gh) throw new Error('bad map data');
      const t = new Int32Array(n * 4);
      for (let k = 0; k < t.length; k += 4) {
        t[k] = r.vu(); t[k + 1] = r.vu(); t[k + 2] = t[k] + r.vu(); t[k + 3] = t[k + 1] + r.vu();
        if (t[k + 2] >= gw || t[k + 3] >= gh) throw new Error('bad map data');
      }
      return t;
    };
    g.glyphs = table(); g.blocks = table();
    const N = gw * gh, nG = g.glyphCount, nB = g.blockCount;
    for (let i = 0; i < N;) {
      const n = r.vu(), m = r.u8();
      if (!n || i + n > N || m > RUBBLE) throw new Error('bad map data');
      const c = m ? r.u32() : 0;
      if (m) { g.mat.fill(m, i, i + n); g.col.fill(c, i, i + n); }
      i += n;
    }
    for (let i = 0; i < N;) {
      const n = r.vu(), z = r.vu(), o = z & 1 ? -(z + 1) / 2 : z / 2;
      if (!n || i + n > N || o > nG || -o > nB) throw new Error('bad map data');
      if (o) g.own.fill(o, i, i + n);
      i += n;
    }
    for (let i = 0; i < N;) {
      const n = r.vu();
      if (!n || i + n > N) throw new Error('bad map data');
      const c = r.u32();
      if (c) g.back.fill(c, i, i + n);
      i += n;
    }
    return g;
  }
}

class Writer {
  constructor() { this.buf = new Uint8Array(1 << 16); this.n = 0; }
  room(k) {
    if (this.n + k <= this.buf.length) return;
    const b = new Uint8Array(Math.max(this.buf.length * 2, this.n + k));
    b.set(this.buf); this.buf = b;
  }
  u8(v) { this.room(1); this.buf[this.n++] = v; }
  u32(v) { this.room(4); const b = this.buf, n = this.n; b[n] = v & 255; b[n + 1] = (v >>> 8) & 255; b[n + 2] = (v >>> 16) & 255; b[n + 3] = (v >>> 24) & 255; this.n += 4; }
  vu(v) { this.room(5); while (v > 127) { this.buf[this.n++] = (v & 127) | 128; v >>>= 7; } this.buf[this.n++] = v; }
  bytes() { return this.buf.subarray(0, this.n); }
}

class Reader {
  constructor(b) { this.b = b; this.i = 0; }
  need(k) { if (this.i + k > this.b.length) throw new Error('map data truncated'); }
  u8() { this.need(1); return this.b[this.i++]; }
  u32() { this.need(4); const b = this.b, i = this.i; this.i += 4; return (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0; }
  vu() {
    let v = 0, s = 0, x;
    do { x = this.u8(); v += (x & 127) * 2 ** s; s += 7; if (s > 35) throw new Error('bad varint'); } while (x & 128);
    return v;
  }
}
