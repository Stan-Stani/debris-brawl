import test from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../shared/game.js';
import { applyOp } from '../shared/debris.js';
import { newBody } from '../shared/physics.js';
import { TICK, NET_TICKS, TEXT, RUBBLE, EMPTY } from '../shared/const.js';
import { testGrid } from './helpers.js';

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

test('a loose letter lands and settles back into the page in its own shape', () => {
  const { game } = arena();
  game.detachGlyph(9, 40, -200, 0, false);
  const id = [...game.ents.keys()].at(-1);
  let settled = null;
  steps(game, 8, (m) => { settled ??= m.ev?.find((e) => e[0] === 'settle' && e[1] === id); });
  assert.ok(settled, 'it should come to rest and settle');
  assert.ok(!game.ents.has(id));
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
  assert.equal(game.ents.size, 0, 'everything has settled');
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
