// Loose bits of page: flying particles, held/thrown chunks, and the terrain op stream.
//
// The server owns the terrain. Every change goes out as an op, and the server applies its own ops
// through applyOp too, so each client's copy stays cell-for-cell identical. Particles spawned by an op
// are real on the server (they land and bake into rubble) and cosmetic "ghosts" on clients.
import { CELL, EMPTY, RUBBLE, DEBRIS } from './const.js';
import { darken } from './grid.js';
import { hash } from './rng.js';

export function carveParticle(g, i, m, c, x, y, seed, frac, power) {
  if (hash(i, seed) >= frac) return null;
  const px = ((i % g.w) + 0.5) * CELL, py = (((i / g.w) | 0) + 0.5) * CELL;
  const dx = px - x, dy = py - y, d = Math.sqrt(dx * dx + dy * dy) || 1;
  const s = power * (0.35 + 0.65 * hash(i, seed + 1));
  return {
    x: px, y: py,
    vx: (dx / d) * s + (hash(i, seed + 2) - 0.5) * 120,
    vy: (dy / d) * s - 60 - hash(i, seed + 3) * 140,
    c: m === RUBBLE ? c : darken(c, 0.82), t: 0,
  };
}

function fallParticle(g, i, c, seed) {
  return { x: ((i % g.w) + 0.5) * CELL, y: (((i / g.w) | 0) + 0.5) * CELL, vx: (hash(i, seed) - 0.5) * 40, vy: 0, c, t: 0 };
}

// ops: ['c', x, y, r, seed, frac, power] carve with debris
//      ['x', i...] quiet clear (scooped up, or a letter / shard breaking loose)    ['f', seed, i...] rubble that lost its support falls
//      ['b', i, col, ...] particles settling into rubble
// spawn(particle) gets the debris an op throws off; cleared(i, own) hears about carved and scooped cells.
export function applyOp(g, op, spawn, cleared) {
  switch (op[0]) {
    case 'c': {
      const [, x, y, r, seed, frac, power] = op;
      g.carve(x, y, r, (i, m, c, o) => {
        const p = spawn && carveParticle(g, i, m, c, x, y, seed, frac, power);
        if (p) spawn(p);
        if (cleared) cleared(i, o);
      });
      break;
    }
    case 'x':
      for (let k = 1; k < op.length; k++) { const o = g.own[op[k]]; g.clear(op[k]); if (cleared) cleared(op[k], o); }
      break;
    case 'f': {
      const seed = op[1];
      for (let k = 2; k < op.length; k++) {
        const i = op[k];
        if (g.mat[i] === EMPTY) continue;
        const c = g.col[i];
        g.clear(i);
        if (spawn) spawn(fallParticle(g, i, c, seed));
      }
      break;
    }
    case 'b':
      for (let k = 1; k < op.length; k += 2) g.set(op[k], RUBBLE, op[k + 1]);
      break;
  }
}

// 0 still flying, 1 landed (bake it at its cell), 2 gone
export function stepParticle(p, g, dt) {
  p.t += dt;
  if (p.t > 6) return 2;
  p.vy = Math.min(1100, p.vy + 1400 * dt);
  p.vx *= 1 - 0.5 * dt;
  const steps = Math.max(1, Math.ceil((Math.max(Math.abs(p.vx), Math.abs(p.vy)) * dt) / CELL));
  const sx = (p.vx * dt) / steps, sy = (p.vy * dt) / steps;
  for (let k = 0; k < steps; k++) {
    const cy = Math.floor(p.y / CELL);
    const nx = p.x + sx;
    if (g.at(Math.floor(nx / CELL), cy) !== EMPTY) p.vx *= -0.3;
    else p.x = nx;
    const ny = p.y + sy, ncy = Math.floor(ny / CELL);
    if (ncy >= g.h + 20) return 2;
    if (g.at(Math.floor(p.x / CELL), ncy) !== EMPTY) {
      if (p.vy > 0) {
        if (p.vy < 300) return 1;
        p.vy *= -0.25; p.vx *= 0.6;
      } else p.vy = 0;
      break;
    }
    p.y = ny;
  }
  return 0;
}

// A chunk of n cells is drawn as the first n cells of a lumpy disc, so it reads as a rock.
let discTable = null;
export function discCells(n) {
  if (!discTable) {
    const R = Math.ceil(Math.sqrt(DEBRIS.maxCells / Math.PI)) + 3, list = [];
    for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
      list.push([Math.sqrt(dx * dx + dy * dy) + hash(dx + 64, dy + 64) * 1.1, dx, dy]);
    }
    list.sort((a, b) => a[0] - b[0]);
    discTable = list.map(([, dx, dy]) => [dx, dy]);
  }
  return discTable.slice(0, n);
}

// A rigid piece of page: its cells as integer coords centred on their average. Server and clients build
// it the same way from the same cells, so offsets match. `at` finds a cell by coords (for settling).
export function pieceShape(ix, iy) {
  const n = ix.length, key = (x, y) => (x + 32768) * 65536 + (y + 32768);
  let sx = 0, sy = 0;
  for (let k = 0; k < n; k++) { sx += ix[k]; sy += iy[k]; }
  const ox = sx / n, oy = sy / n, off = new Float32Array(2 * n), at = new Map(), edge = [];
  for (let k = 0; k < n; k++) at.set(key(ix[k], iy[k]), k);
  let r2 = 0, inertia = 0, low = 0;
  for (let k = 0; k < n; k++) {
    const dx = ix[k] - ox, dy = iy[k] - oy, d2 = dx * dx + dy * dy;
    off[2 * k] = dx; off[2 * k + 1] = dy;
    r2 = Math.max(r2, d2);
    low = Math.max(low, dy);
    inertia += d2 + 1 / 6;
    if (!at.has(key(ix[k] + 1, iy[k])) || !at.has(key(ix[k] - 1, iy[k])) || !at.has(key(ix[k], iy[k] + 1)) || !at.has(key(ix[k], iy[k] - 1))) edge.push(k);
  }
  // down: how far its lowest cell reaches below the centre (to carry it just over a head)
  return { n, ix, iy, ox, oy, off, edge, at, key, rad: (Math.sqrt(r2) + 0.75) * CELL, down: (low + 0.5) * CELL, inertia: inertia * CELL * CELL };
}

// cells of the page itself (a letter, a shard of a box)
// How far (px) a piece lying at (x, y, rot) is from a standing body: the vertical line at px from
// top to bottom (head to feet), so a letter by your feet is as reachable as one at your chest.
export function pieceDistance(shape, x, y, rot, px, top, bottom = top) {
  const cs = Math.cos(rot), sn = Math.sin(rot);
  let best = Infinity;
  for (const k of shape.edge) {
    const dx = shape.off[2 * k], dy = shape.off[2 * k + 1];
    const wx = x + (dx * cs - dy * sn) * CELL, wy = y + (dx * sn + dy * cs) * CELL;
    best = Math.min(best, Math.hypot(wx - px, wy - Math.min(bottom, Math.max(top, wy))));
  }
  return best;
}

export function pageShape(idx, w) {
  return pieceShape(idx.map((i) => i % w), idx.map((i) => (i / w) | 0));
}

// a scooped-up rock
export function rockShape(n) {
  const cells = discCells(n);
  return pieceShape(cells.map((c) => c[0]), cells.map((c) => c[1]));
}

// Heavier chunks fly slower; full charge throws hard.
export function throwVelocity(a, power, n, bvx = 0, bvy = 0) {
  const mass = Math.min(1.1, Math.max(0.6, 1.1 / (1 + n / 250))); // a slab flies slower than a pebble, but still flies
  const s = (DEBRIS.minSpeed + (DEBRIS.maxSpeed - DEBRIS.minSpeed) * power) * mass;
  return { vx: Math.cos(a) * s + bvx * 0.4, vy: Math.sin(a) * s + bvy * 0.2 };
}

export function throwDamage(n, speed) {
  if (speed < DEBRIS.hurtSpeed) return 0;
  return Math.min(DEBRIS.maxDmg, Math.round((DEBRIS.dmgBase + n * DEBRIS.dmgPerCell) * Math.min(1.5, Math.max(0.5, speed / 700))));
}

// Pieces of a burst chunk (same seed on server and clients). off: the piece's cell offsets.
export function smashParticles(x, y, vx, vy, rot, off, cols, seed) {
  const cs = Math.cos(rot), sn = Math.sin(rot), out = [];
  for (let k = 0; k < cols.length; k++) {
    const dx = off[2 * k], dy = off[2 * k + 1];
    out.push({
      x: x + (dx * cs - dy * sn) * CELL, y: y + (dx * sn + dy * cs) * CELL,
      vx: vx * 0.25 + (hash(k, seed) - 0.5) * 320 + dx * 18,
      vy: vy * 0.25 - hash(k, seed + 1) * 260 + dy * 10,
      c: cols[k], t: 0,
    });
  }
  return out;
}
