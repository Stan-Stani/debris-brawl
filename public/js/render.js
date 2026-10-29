// Drawing helpers, all in world coordinates (CSS px of the page).
import { CELL, WEAPONS, FL_FLY, FL_PROT } from '/shared/const.js';
import { rockShape } from '/shared/debris.js';

// A chunk's pixels are baked into a tiny canvas once and drawn rotated after that.
export function chunkSprite(cols) {
  const shape = rockShape(cols.length), cells = cols.map((_, k) => [shape.ix[k], shape.iy[k]]);
  let R = 1;
  for (const [dx, dy] of cells) R = Math.max(R, Math.abs(dx), Math.abs(dy));
  R += 1;
  const S = 2 * R + 1, cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const x = cv.getContext('2d'), img = x.createImageData(S, S), px = new Uint32Array(img.data.buffer);
  const at = (dx, dy) => (dy + R) * S + dx + R;
  cells.forEach(([dx, dy], k) => { px[at(dx, dy)] = cols[k]; });
  // a dark rim so it reads against any page
  for (const [dx, dy] of cells) {
    for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const j = at(dx + ox, dy + oy);
      if (Math.abs(dx + ox) <= R && Math.abs(dy + oy) <= R && px[j] === 0) px[j] = 0xff1c1c1c;
    }
  }
  x.putImageData(img, 0, 0);
  // positioned on the rock's centre of mass, the same point the server moves
  const S2 = S * CELL;
  return { cv, dx: -(R + 0.5 + shape.ox) * CELL, dy: -(R + 0.5 + shape.oy) * CELL, dw: S2, dh: S2, cols, n: cols.length, rad: shape.rad, down: shape.down, off: shape.off, shape, smooth: false };
}

// Rocks are pixel art (no smoothing); letters and shards are real page pixels (smoothed when turned).
export function drawChunk(ctx, sp, x, y, rot) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rot);
  ctx.imageSmoothingEnabled = !!sp.smooth;
  ctx.drawImage(sp.cv, sp.dx, sp.dy, sp.dw, sp.dh);
  ctx.restore();
}

// s: x y vx aim face w fl ground phase flip(0..1 or -1) holding charge color
export function drawStick(ctx, s, ink, t) {
  const face = s.face;
  ctx.save();
  if (s.fl & FL_PROT) ctx.globalAlpha = 0.45 + 0.3 * Math.sin(t * 22);
  ctx.translate(s.x, s.y);
  if (s.flip >= 0) { ctx.translate(0, -17); ctx.rotate(face * s.flip * Math.PI * 2); ctx.translate(0, 17); }

  if (s.fl & FL_FLY) { // jetpack flame
    const f = 7 + Math.random() * 6;
    ctx.fillStyle = '#ffb02e';
    ctx.beginPath(); ctx.moveTo(-face * 5 - 3, -16); ctx.lineTo(-face * 5 + 3, -16); ctx.lineTo(-face * 5, -16 + f); ctx.fill();
    ctx.fillStyle = '#fff3b0';
    ctx.beginPath(); ctx.moveTo(-face * 5 - 1.5, -16); ctx.lineTo(-face * 5 + 1.5, -16); ctx.lineTo(-face * 5, -16 + f * 0.55); ctx.fill();
    ctx.fillStyle = ink;
    ctx.fillRect(-face * 5 - 3, -24, 6, 8);
  }

  const sw = s.ground ? Math.sin(s.phase) * Math.min(1, Math.abs(s.vx) / 120) : 0;
  const hip = [0, -13], neck = [0, -24], sh = [0, -22];
  const legs = s.ground
    ? [[[sw * 4, -6], [sw * 7, 0]], [[-sw * 4, -6], [-sw * 7, 0]]]
    : [[[-3, -6], [-5, -1]], [[4, -7], [6, -3]]];
  const dx = Math.cos(s.aim), dy = Math.sin(s.aim);
  let arms, gun = null;
  if (s.holding) {
    const back = -face * 5 * (s.charge || 0);
    arms = [[[-4 + back, -30], [-5 + back, -36]], [[4 + back, -30], [5 + back, -36]]];
  } else {
    const W = WEAPONS[s.w] ?? WEAPONS[0];
    const hand = [dx * 9, -22 + dy * 9];
    arms = [[[dx * 5, -21 + dy * 5], hand], [[dx * 4 - dy * 2, -20 + dy * 4 + dx * 2], [hand[0] - dy, hand[1] + dx]]];
    gun = { a: [hand[0] - dx * 3, hand[1] - dy * 3], b: [hand[0] + dx * W.gun, hand[1] + dy * W.gun], big: W.gun > 12 };
  }

  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const [lw, col] of [[4.6, ink], [2.2, s.color]]) {
    ctx.strokeStyle = col;
    ctx.lineWidth = lw;
    ctx.beginPath();
    for (const [knee, foot] of legs) { ctx.moveTo(...hip); ctx.lineTo(...knee); ctx.lineTo(...foot); }
    ctx.moveTo(...hip); ctx.lineTo(...neck);
    for (const [el, hand] of arms) { ctx.moveTo(...sh); ctx.lineTo(...el); ctx.lineTo(...hand); }
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.arc(0, -29.5, 4.8, 0, Math.PI * 2);
  ctx.fillStyle = s.color; ctx.fill();
  ctx.lineWidth = 1.6; ctx.strokeStyle = ink; ctx.stroke();
  ctx.fillStyle = ink;
  ctx.fillRect(face * 2 - 0.8, -31, 1.6, 1.8);
  if (gun) {
    ctx.strokeStyle = ink; ctx.lineWidth = gun.big ? 4 : 3.2;
    ctx.beginPath(); ctx.moveTo(...gun.a); ctx.lineTo(...gun.b); ctx.stroke();
    ctx.strokeStyle = '#8d95a0'; ctx.lineWidth = gun.big ? 2 : 1.4;
    ctx.beginPath(); ctx.moveTo(...gun.a); ctx.lineTo(...gun.b); ctx.stroke();
  }
  ctx.restore();
}

export function drawTag(ctx, s, ink, paper, showHp) {
  ctx.save();
  ctx.font = '700 10px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.lineWidth = 3; ctx.strokeStyle = paper; ctx.fillStyle = s.color;
  const y = s.y - (s.holding ? 66 : 44);
  ctx.strokeText(s.name, s.x, y);
  ctx.fillText(s.name, s.x, y);
  if (showHp) {
    ctx.fillStyle = paper; ctx.fillRect(s.x - 13, y + 3, 26, 4);
    ctx.fillStyle = s.hp > 35 ? '#3ccf5a' : '#ff4d4d'; ctx.fillRect(s.x - 12, y + 4, 24 * Math.max(0, s.hp) / 100, 2);
  }
  ctx.restore();
}

export function drawRocket(ctx, x, y, a, ink) {
  ctx.save();
  ctx.translate(x, y); ctx.rotate(a);
  ctx.fillStyle = '#ffb02e';
  ctx.beginPath(); ctx.moveTo(-6, -2); ctx.lineTo(-12 - Math.random() * 6, 0); ctx.lineTo(-6, 2); ctx.fill();
  ctx.fillStyle = ink; ctx.fillRect(-7, -2.5, 11, 5);
  ctx.fillStyle = '#e04040'; ctx.beginPath(); ctx.moveTo(4, -2.5); ctx.lineTo(8, 0); ctx.lineTo(4, 2.5); ctx.fill();
  ctx.restore();
}

export function drawGrenade(ctx, x, y, rot, t, ink) {
  ctx.save();
  ctx.translate(x, y); ctx.rotate(rot);
  ctx.fillStyle = ink; ctx.beginPath(); ctx.arc(0, 0, 4, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#5d7a3a'; ctx.beginPath(); ctx.arc(0, 0, 2.8, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = Math.sin(t * 30) > 0 ? '#ff4d4d' : '#ffd23f'; ctx.fillRect(-1, -6, 2, 2);
  ctx.restore();
}
