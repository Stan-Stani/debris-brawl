// Stickman movement against the page grid. Runs on the server for bots and in the browser for your own player.
import { CELL, PLAYER as P, SOLID, TEXT, RUBBLE, WALL } from './const.js';

export function newBody(x, y) {
  return { x, y, vx: 0, vy: 0, ground: false, coyote: 0, air: 1, fuel: P.fuel, flipT: 0, lock: 0, drop: 0, flying: false };
}

// Like the original, the page's boxes are platforms, not walls: you land on their top edges and pass
// through them otherwise (so a page full of big cards stays playable). Rubble piles and the edges of
// the world are the only things that stop you sideways.
const blocks = (m) => m === RUBBLE || m === WALL;

// Something to land on: a letter, or the top edge of a box (where it starts, or where another box sits on it).
function surface(g, cx, cy) {
  const m = g.at(cx, cy);
  if (m === TEXT) return true;
  if (m !== SOLID) return false;
  if (cy === 0) return true;
  const i = cy * g.w + cx, up = i - g.w;
  return g.mat[up] !== SOLID || g.own[up] !== g.own[i];
}
const approach = (v, t, d) => (v < t ? Math.min(t, v + d) : Math.max(t, v - d));

// Feet at (x, y): does the body overlap anything that blocks from every side?
export function boxHits(g, x, y) {
  const x0 = Math.floor((x - P.w / 2) / CELL), x1 = Math.floor((x + P.w / 2 - 0.01) / CELL);
  const y0 = Math.floor((y - P.h) / CELL), y1 = Math.floor((y - 0.01) / CELL);
  for (let cy = y0; cy <= y1; cy++) for (let cx = x0; cx <= x1; cx++) if (blocks(g.at(cx, cy))) return true;
  return false;
}

// Feet moving down from y to ny step into a new row that has something to land on.
function ledge(g, x, y, ny) {
  const r0 = Math.floor((y - 0.01) / CELL), r1 = Math.floor((ny - 0.01) / CELL);
  if (r1 <= r0) return false;
  const x0 = Math.floor((x - P.w / 2) / CELL), x1 = Math.floor((x + P.w / 2 - 0.01) / CELL);
  for (let cx = x0; cx <= x1; cx++) if (surface(g, cx, r1)) return true;
  return false;
}

// inp: l r jump down (held) and jp dp (pressed this step). load = cells of debris carried.
// Returns 1 on jump, 2 on flip, 3 on landing, else 0.
export function stepBody(b, inp, g, dt, load = 0) {
  const slow = 1 - Math.min(0.4, load / 260);
  if (boxHits(g, b.x, b.y)) {
    // the page changed under us (or lag put us inside it): pop up out of it
    for (let up = 1; up <= 24; up++) if (!boxHits(g, b.x, b.y - up)) { b.y -= up; break; }
  }

  const dir = (inp.r ? 1 : 0) - (inp.l ? 1 : 0);
  const fast = Math.abs(b.vx) > P.run * 1.05; // knocked back: let it carry
  const acc = fast ? (b.ground ? 2400 : 450) : (b.ground ? P.accel : P.airAccel);
  b.vx = approach(b.vx, dir * P.run * slow, acc * dt);

  if (b.ground) { b.coyote = P.coyote; b.air = 1; b.fuel = Math.min(P.fuel, b.fuel + P.fuelRegen * dt); }
  else b.coyote -= dt;
  b.lock -= dt; b.drop -= dt; b.flipT = Math.max(0, b.flipT - dt);

  let ev = 0;
  if (inp.jp) {
    if (b.coyote > 0) { b.vy = -P.jump * (0.85 + 0.15 * slow); b.coyote = 0; b.ground = false; ev = 1; }
    else if (b.air > 0) { b.air = 0; b.vy = Math.min(b.vy, -P.flip * (0.85 + 0.15 * slow)); b.flipT = 0.4; b.lock = 0.2; ev = 2; }
  }
  b.flying = !b.ground && inp.jump && b.air === 0 && b.lock <= 0 && b.fuel > 0;
  if (b.flying) { b.vy = Math.max(-P.maxUp, b.vy - P.thrust * dt); b.fuel -= dt; }
  b.vy = Math.min(P.maxFall, b.vy + P.gravity * dt);
  if (b.y < -400) b.vy = Math.max(b.vy, 0);
  if (inp.dp && b.ground) b.drop = 0.22;
  const dropping = b.drop > 0 || inp.down;

  let dx = b.vx * dt;
  while (dx !== 0) {
    const step = Math.abs(dx) > 1 ? Math.sign(dx) : dx;
    dx -= step;
    const nx = b.x + step;
    if (!boxHits(g, nx, b.y)) { b.x = nx; continue; }
    let up = 0;
    if (b.ground || b.coyote > 0) for (let k = 1; k <= P.stepUp; k++) if (!boxHits(g, nx, b.y - k)) { up = k; break; }
    if (up) { b.x = nx; b.y -= up; } else { b.vx = 0; break; }
  }

  const was = b.ground;
  let dy = b.vy * dt, landed = false;
  while (dy !== 0) {
    const step = Math.abs(dy) > 1 ? Math.sign(dy) : dy;
    dy -= step;
    const ny = b.y + step;
    if (boxHits(g, b.x, ny) || (step > 0 && !dropping && ledge(g, b.x, b.y, ny))) {
      if (step > 0) {
        landed = true;
        const row = Math.floor((ny - 0.01) / CELL);
        if (row * CELL > b.y) b.y = row * CELL; // sit flush on the row we hit
      }
      b.vy = 0;
      break;
    }
    b.y = ny;
  }
  b.ground = landed;
  if (landed && !was && !ev) ev = 3;
  return ev;
}

// Where a player could stand: feet on something, room for the body above.
export function canStand(g, x, y) {
  if (boxHits(g, x, y)) return false;
  const row = Math.floor(y / CELL);
  const x0 = Math.floor((x - P.w / 2) / CELL), x1 = Math.floor((x + P.w / 2 - 0.01) / CELL);
  for (let cx = x0; cx <= x1; cx++) if (surface(g, cx, row) || g.at(cx, row) === RUBBLE) return true;
  return false;
}
