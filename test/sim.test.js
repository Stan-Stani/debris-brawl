import test from 'node:test';
import assert from 'node:assert/strict';
import { Grid } from '../shared/grid.js';
import { Game } from '../shared/game.js';
import { applyOp } from '../shared/debris.js';
import { newBody, stepBody } from '../shared/physics.js';
import { CELL, TICK, NET_TICKS, EMPTY, RUBBLE, PLAYER } from '../shared/const.js';
import { testGrid, flatGrid, rubblePatch, stillInput } from './helpers.js';

const run = (game, seconds, onFlush) => {
  for (let t = 0; t < seconds / TICK; t++) {
    game.step(TICK);
    if (t % NET_TICKS === NET_TICKS - 1) onFlush?.(game.flush());
  }
};

test('map encodes and decodes losslessly', () => {
  const g = testGrid();
  const back = Grid.decode(g.encode());
  assert.ok(back.equals(g));
  assert.equal(back.pageBg, g.pageBg);
  assert.deepEqual([...back.back.slice(0, 410)], [...g.back.slice(0, 410)]);
});

test('decode rejects junk and truncated maps', () => {
  assert.throws(() => Grid.decode(new Uint8Array([1, 2, 3, 4, 5])));
  const bytes = testGrid().encode();
  assert.throws(() => Grid.decode(bytes.slice(0, bytes.length - 3)));
});

test('a client replaying the op stream ends with the exact same page as the server', () => {
  const g = testGrid();
  const game = new Game(g.clone(), { seed: 7, timed: false });
  for (let i = 0; i < 5; i++) game.addBot();
  const client = g.clone();
  let ops = 0;
  run(game, 25, (m) => {
    for (const op of m.ops ?? []) { applyOp(client, op, () => {}); ops++; }
  });
  assert.ok(ops > 50, `bots should have wrecked something (ops=${ops})`);
  assert.ok(client.equals(game.grid), 'client grid drifted from the server');
  let rubble = 0;
  for (const m of game.grid.mat) if (m === RUBBLE) rubble++;
  assert.ok(rubble > 0, 'debris should settle into rubble');
});

test('text is a one-way ledge: land on it, jump up through it, drop through it', () => {
  const g = testGrid();
  const b = newBody(60, 140); // above the text at row 80 (y=160)
  for (let i = 0; i < 120; i++) stepBody(b, stillInput(), g, TICK);
  assert.equal(b.y, 160);
  assert.ok(b.ground);

  const under = newBody(60, 230); // standing on the floor below that text, jump up through it
  for (let i = 0; i < 30; i++) stepBody(under, stillInput(), g, TICK);
  stepBody(under, { ...stillInput(), jp: true }, g, TICK);
  let minY = under.y;
  for (let i = 0; i < 40; i++) { stepBody(under, stillInput(), g, TICK); minY = Math.min(minY, under.y); }
  assert.ok(minY < 160, 'should rise past the text line');

  stepBody(b, { ...stillInput(), down: true, dp: true }, g, TICK);
  for (let i = 0; i < 60; i++) stepBody(b, stillInput(), g, TICK);
  assert.equal(b.y, 240, 'a tap of S drops through the text to the floor');
});

test("rubble stops you sideways; the page's boxes don't, you land on their tops", () => {
  const g = testGrid();
  const b = newBody(240, 240);
  for (let i = 0; i < 20; i++) stepBody(b, stillInput(), g, TICK);
  for (let y = 100; y < 120; y++) for (let x = 140; x < 145; x++) g.set(y * g.w + x, RUBBLE, 0xff0000ff);
  for (let i = 0; i < 90; i++) stepBody(b, { ...stillInput(), r: true }, g, TICK);
  assert.ok(b.x <= 140 * CELL - PLAYER.w / 2 + 0.01, `a pile of rubble stops you, x=${b.x}`);
  const g2 = testGrid(); // a box standing on the floor in the way: x 280..300, y 200..240
  for (let y = 100; y < 120; y++) for (let x = 140; x < 150; x++) g2.set(y * g2.w + x, 1, 0xff00ff00, -1);
  const c = newBody(255, 240);
  for (let i = 0; i < 90; i++) stepBody(c, { ...stillInput(), r: true }, g2, TICK);
  assert.ok(c.x > 360, `you walk through a box, x=${c.x}`);
  const d = newBody(320, 100);
  for (let i = 0; i < 90; i++) stepBody(d, stillInput(), g2, TICK);
  assert.equal(d.y, 120, 'and land on its top edge');
});

test('scoop rubble, throw it at someone, it hurts them and breaks apart', () => {
  const g = flatGrid();
  rubblePatch(g, 40, 112, 12, 8); // a pile on the floor at x 80..104
  const game = new Game(g, { seed: 3, timed: false });
  const a = game.addPlayer('Ana'), v = game.addPlayer('Vik');
  run(game, 0.6);
  Object.assign(a.body, newBody(90, 224)); a.alive = true; a.prot = 0;
  Object.assign(v.body, newBody(260, 240)); v.alive = true; v.prot = 0;

  game.handle(a.id, { t: 'e' });
  assert.ok(a.hold, 'should be holding a chunk');
  const c = game.ents.get(a.hold);
  assert.ok(c.n >= 6 && c.n <= 110);
  const ev = game.flush().ev;
  assert.ok(ev.some((e) => e[0] === 'chunk' && e[2].length === c.n));

  game.handle(a.id, { t: 'th', a: 0.1, p: 1 });
  assert.equal(a.hold, 0);
  let hit = null;
  for (let t = 0; t < 60 && !hit; t++) {
    game.step(TICK);
    hit = game.flush().ev?.find((e) => e[0] === 'hit' && e[1] === v.id);
  }
  assert.ok(hit, 'the throw should land on Vik');
  assert.equal(hit[3], a.id);
  assert.equal(hit[4], 'debris');
  assert.ok(v.hp < 100 && v.hp >= 100 - 80);
  assert.ok(!game.ents.has(c.id), 'chunk bursts on impact');
});

test('a slow drop settles back into rubble you can pick up again', () => {
  const g = flatGrid();
  rubblePatch(g, 40, 112, 12, 8);
  const game = new Game(g, { seed: 5, timed: false });
  const a = game.addPlayer('Ana');
  run(game, 0.6);
  Object.assign(a.body, newBody(90, 224)); a.alive = true;
  const before = game.grid.mat.filter((m) => m === RUBBLE).length;
  game.handle(a.id, { t: 'e' });
  const n = game.ents.get(a.hold).n;
  assert.equal(game.grid.mat.filter((m) => m === RUBBLE).length, before - n);
  game.handle(a.id, { t: 'e' }); // drop it, and step out from under it
  Object.assign(a.body, newBody(300, 240));
  run(game, 3);
  const after = game.grid.mat.filter((m) => m === RUBBLE).length;
  assert.ok(after >= before - 3, `rubble should come back (before ${before}, after ${after})`);
});

test('nothing to grab says so', () => {
  const game = new Game(testGrid(), { seed: 1, timed: false });
  const a = game.addPlayer('Ana');
  run(game, 0.6);
  Object.assign(a.body, newBody(90, 240)); a.alive = true;
  game.handle(a.id, { t: 'e' });
  assert.equal(a.hold, 0);
  assert.ok(game.flush().ev.some((e) => e[0] === 'nograb' && e[1] === a.id));
});

test('rockets blow holes, hurt people nearby and leave rubble', () => {
  const g = testGrid();
  const game = new Game(g, { seed: 9, timed: false });
  const a = game.addPlayer('Ana'), v = game.addPlayer('Vik');
  run(game, 0.6);
  Object.assign(a.body, newBody(60, 240)); a.prot = 0;
  Object.assign(v.body, newBody(200, 240)); v.prot = 0;
  const filled = game.grid.filled();
  game.handle(a.id, { t: 's', life: a.life, x: 60, y: 240, vx: 0, vy: 0, a: 0, f: 1, w: 3 });
  game.handle(a.id, { t: 'f', w: 3, a: [0.25] }); // down-right into the floor near Vik
  run(game, 3);
  assert.ok(game.grid.filled() < filled);
  assert.ok(v.hp < 100);
  assert.ok(game.grid.mat.some((m) => m === RUBBLE));
});

test('bad messages are ignored', () => {
  const game = new Game(testGrid(), { seed: 2, timed: false });
  const a = game.addPlayer('Ana');
  run(game, 0.6);
  const x = a.body.x;
  game.handle(a.id, { t: 's', life: a.life, x: NaN, y: 10 });
  game.handle(a.id, { t: 's', life: a.life + 5, x: 10, y: 10 });
  game.handle(a.id, { t: 'f', w: 99, a: [0] });
  game.handle(a.id, { t: 'f', w: 0, a: ['x'] });
  game.handle(a.id, null);
  game.handle(999, { t: 'e' });
  assert.equal(a.body.x, x);
  assert.equal(game.bullets.length, 0);
});

test('timed rounds end, then restart on a fresh copy of the page', () => {
  const g = testGrid();
  const game = new Game(g.clone(), { seed: 4 });
  game.addBot(); game.addBot();
  game.round.t = 1;
  run(game, 1.2);
  assert.equal(game.round.state, 'end');
  game.round.t = 0.1;
  run(game, 0.2);
  assert.equal(game.round.state, 'play');
  assert.ok(game.needsReload);
  assert.ok(game.grid.equals(g));
  assert.equal(game.grid.mat.filter((m) => m !== EMPTY).length, g.filled());
});
