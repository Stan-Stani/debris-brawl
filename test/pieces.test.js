import test from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../shared/game.js';
import { applyOp } from '../shared/debris.js';
import { newBody } from '../shared/physics.js';
import { TICK, NET_TICKS, TEXT, RUBBLE, EMPTY } from '../shared/const.js';
import { testGrid, flatGrid } from './helpers.js';

const steps = (game, seconds, onFlush) => {
  for (let t = 0; t < seconds / TICK; t++) {
    game.step(TICK);
    if (t % NET_TICKS === NET_TICKS - 1) onFlush?.(game.flush());
  }
};
const count = (g, pred) => { let n = 0; for (let i = 0; i < g.mat.length; i++) if (pred(i)) n++; return n; };
const cellsOf = (g, own) => count(g, (i) => g.own[i] === own);

function arena() {
  const game = new Game(testGrid(), { seed: 21, timed: false });
  const a = game.addPlayer('Ana');
  steps(game, 0.6);
  Object.assign(a.body, newBody(60, 240)); a.prot = 0;
  game.flush();
  return { game, a };
}

test('a bullet knocks a whole letter loose, intact, and leaves its neighbours alone', () => {
  const { game, a } = arena();
  const g = game.grid;
  const before = { hit: cellsOf(g, 9), left: cellsOf(g, 8), right: cellsOf(g, 10) };
  assert.equal(before.hit, 12);
  // letter 9 sits at cells x 60..63, y 80..82 (px 120..128, 160..166); shoot it from below-left
  const ax = 60, ay = 240 - 22, tx = 123, ty = 163;
  game.handle(a.id, { t: 'f', w: 0, a: [Math.atan2(ty - ay, tx - ax)] });
  let piece = null;
  for (let t = 0; t < 4 && !piece; t++) { game.step(TICK); piece = game.flush().ev?.find((e) => e[0] === 'piece'); }
  assert.ok(piece, 'a letter should come loose');
  assert.equal(cellsOf(g, 9), 0, 'the whole letter left the page');
  assert.equal(piece[2].length, 12, 'and came off in one piece');
  assert.equal(cellsOf(g, 8), before.left);
  assert.equal(cellsOf(g, 10), before.right);
  const ent = game.ents.get(piece[1]);
  assert.ok(ent.page && ent.n === 12);
});

test('a loose letter lands and lies there whole (asleep) until there are too many, then settles in its shape', () => {
  const { game } = arena();
  game.detachGlyph(9, 40, -200, 0, false);
  const id = [...game.ents.keys()].at(-1), c = game.ents.get(id);
  steps(game, 6);
  assert.ok(game.ents.has(id) && c.sleep, 'it comes to rest and stays a piece you can pick up');
  game.flush(); // its last pose goes out once
  const sent = [];
  steps(game, 0.5, (m) => sent.push(...m.es.filter((e) => e[0] === id)));
  assert.equal(sent.length, 0, 'asleep pieces are not resent every update');
  game.settle(c);
  const rubble = count(game.grid, (i) => game.grid.mat[i] === RUBBLE);
  assert.ok(rubble >= 10 && rubble <= 14, `about the letter's 12 cells come back as rubble (got ${rubble})`);
});

test('a box takes several hits, then cracks into shards that carry its label', () => {
  const { game, a } = arena();
  const g = game.grid;
  const hp = game.blockHp(1);
  assert.ok(hp >= 40 && hp < 80, `hp ${hp}`);
  let pieces = [];
  const aim = Math.atan2(150 - 218, 325 - 60); // at the box's left face
  for (let shot = 0; shot < 10 && !game.blockGone[1]; shot++) {
    game.handle(a.id, { t: 'f', w: 0, a: [aim] });
    steps(game, 0.25, (m) => { pieces = pieces.concat((m.ev ?? []).filter((e) => e[0] === 'piece')); });
  }
  assert.ok(game.blockGone[1], 'the box should crack before ten pistol shots');
  assert.ok(pieces.length >= 2, `cracks into several shards (got ${pieces.length})`);
  assert.equal(cellsOf(g, -1), 0, 'no part of the box is left on the page');
  assert.equal(cellsOf(g, 41), 0, 'its label went with it');
  const label = pieces.some((p) => p[3].includes(0xff003c5a)); // rgb(90, 60, 0) as ABGR
  assert.ok(label, 'one shard carries the label pixels');
});

test('a rocket sends nearby letters flying and the page stays in sync for a client replaying it', () => {
  const g0 = testGrid();
  const game = new Game(g0.clone(), { seed: 5, timed: false });
  const a = game.addPlayer('Ana');
  const client = g0.clone();
  const replay = (m) => { for (const op of m.ops ?? []) applyOp(client, op); };
  steps(game, 0.6, replay);
  Object.assign(a.body, newBody(60, 240)); a.prot = 0;
  game.handle(a.id, { t: 'f', w: 3, a: [Math.atan2(163 - 218, 160 - 60)] }); // into the first line of letters
  let flying = 0;
  steps(game, 0.5, (m) => { replay(m); flying += (m.ev ?? []).filter((e) => e[0] === 'piece').length; });
  assert.ok(flying >= 5, `letters fly (${flying})`);
  steps(game, 10, replay);
  assert.ok(client.equals(game.grid), 'client grid matches the server after pieces fly and settle');
  assert.ok([...game.ents.values()].every((c) => c.sleep), 'every loose piece has come to rest');
});

test('you can pick up a loose letter and throw it', () => {
  const { game, a } = arena();
  const v = game.addPlayer('Vik');
  steps(game, 0.6);
  Object.assign(v.body, newBody(200, 240)); v.prot = 0;
  Object.assign(a.body, newBody(60, 240)); a.prot = 0;
  game.detachGlyph(9, 0, 0, 0, false);
  const id = [...game.ents.keys()].at(-1);
  const c = game.ents.get(id);
  c.x = 64; c.y = 220; c.vx = 0; c.vy = 0; // drifting right past Ana's chest
  game.handle(a.id, { t: 'e' });
  assert.equal(a.hold, id, 'grabbed the letter rather than scooping rubble');
  game.handle(a.id, { t: 'th', a: 0.15, p: 1 });
  let hit = null;
  for (let t = 0; t < 60 && !hit; t++) { game.step(TICK); hit = game.flush().ev?.find((e) => e[0] === 'hit' && e[1] === v.id); }
  assert.ok(hit && hit[4] === 'debris', 'the thrown letter hits Vik');
});

test('glyph and box ownership survives encoding', () => {
  const g = testGrid();
  assert.equal(cellsOf(g, -1), 25 * 25 - 12);
  const g2 = g.clone();
  assert.ok(g2.equals(g));
  assert.equal(g2.glyphCount, 41);
  assert.equal(count(g2, (i) => g2.mat[i] === TEXT && g2.own[i] === 0), 0);
  assert.equal(count(g2, (i) => g2.mat[i] === EMPTY && g2.own[i] !== 0), 0);
});

test('big shards of a box can be lifted and thrown; ones over the limit are too heavy', () => {
  const game = new Game(flatGrid(), { seed: 8, timed: false });
  const a = game.addPlayer('Ana'), v = game.addPlayer('Vik');
  steps(game, 0.6);
  Object.assign(a.body, newBody(60, 240)); a.prot = 0;
  Object.assign(v.body, newBody(175, 240)); v.prot = 0;
  // a 1250-cell slab out of the floor, lying next to Ana
  const idx = [];
  for (let y = 125; y < 150; y++) for (let x = 150; x < 200; x++) idx.push(y * 200 + x);
  const big = game.breakOff(idx, 0, 0, 0, 0, false);
  big.x = 70; big.y = 200; big.sleep = true;
  game.handle(a.id, { t: 'e' });
  assert.equal(a.hold, big.id, 'a 1250-cell shard can be lifted');
  assert.ok(Math.abs(big.y - (240 - 34 - big.shape.down - 1)) < 0.01, 'carried just over the head');
  game.handle(a.id, { t: 'th', a: -0.15, p: 1 });
  let hit = null;
  for (let t = 0; t < 90 && !hit; t++) { game.step(TICK); hit = game.flush().ev?.find((e) => e[0] === 'hit' && e[1] === v.id); }
  assert.ok(hit && hit[2] >= 20, `a thrown slab hurts (${hit?.[2]})`);
  steps(game, 4);
  assert.ok(game.ents.has(big.id), 'and stays whole to be thrown again');

  const huge = [];
  for (let y = 120; y < 150; y++) for (let x = 0; x < 120; x++) huge.push(y * 200 + x); // 3600 cells
  const slab = game.breakOff(huge, 0, 0, 0, 0, false);
  slab.x = 70; slab.y = 185; slab.sleep = true; // right against her chest
  game.time += 1;
  game.handle(a.id, { t: 'e' });
  assert.equal(a.hold, 0);
  assert.ok(game.flush().ev.some((e) => e[0] === 'nograb' && e[1] === a.id && e[2] === 1), 'too heavy says so');
});

test('a piece carried up into the text line overhead still flies where it was aimed', () => {
  const { game, a } = arena();
  Object.assign(a.body, newBody(60, 200)); // under the first line of letters (y 160..166): the held piece overlaps it
  game.detachGlyph(30, 0, 0, 0, false); // a letter from the second line, out of the way
  const c = [...game.ents.values()].at(-1);
  c.x = 60; c.y = 190; c.vx = 0; c.vy = 0;
  game.handle(a.id, { t: 'e' });
  assert.equal(a.hold, c.id);
  assert.ok(game.pieceContact(c, c.x, c.y, 0), 'it does start inside the text line');
  const x0 = c.x;
  game.handle(a.id, { t: 'th', a: -0.8, p: 0.5 });
  steps(game, 0.25);
  assert.ok(c.x - x0 > 100, `it flew on instead of bouncing off the line (moved ${(c.x - x0).toFixed(0)} px)`);
});

test('your own thrown piece never hurts you, even dropped on your own head', () => {
  const game = new Game(flatGrid(), { seed: 12, timed: false });
  const a = game.addPlayer('Ana');
  steps(game, 0.6);
  Object.assign(a.body, newBody(100, 240)); a.prot = 0;
  const idx = [];
  for (let y = 125; y < 150; y++) for (let x = 150; x < 200; x++) idx.push(y * 200 + x);
  const slab = game.breakOff(idx, 0, 0, 0, 0, false);
  slab.x = 105; slab.y = 200; slab.sleep = true;
  game.handle(a.id, { t: 'e' });
  assert.equal(a.hold, slab.id);
  game.handle(a.id, { t: 'th', a: Math.PI / 2, p: 0 }); // straight down onto herself
  steps(game, 2);
  assert.equal(a.hp, 100);
});

test('a pile of shards lying still does not stop bullets', () => {
  const game = new Game(flatGrid(), { seed: 13, timed: false });
  const a = game.addPlayer('Ana'), v = game.addPlayer('Vik');
  steps(game, 0.6);
  Object.assign(a.body, newBody(60, 240)); a.prot = 0;
  Object.assign(v.body, newBody(300, 240)); v.prot = 0;
  const idx = [];
  for (let y = 125; y < 150; y++) for (let x = 150; x < 200; x++) idx.push(y * 200 + x);
  const slab = game.breakOff(idx, 0, 0, 0, 0, false); // lying on the floor between them
  slab.x = 180; slab.y = 212; slab.sleep = true; slab.vx = slab.vy = 0;
  game.handle(a.id, { t: 'f', w: 0, a: [Math.atan2(240 - 17 - 218, 300 - 60)] });
  steps(game, 0.3);
  assert.ok(v.hp < 100, 'the shot went through the resting shard');
});
