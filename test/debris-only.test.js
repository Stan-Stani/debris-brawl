import test from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../shared/game.js';
import { applyOp } from '../shared/debris.js';
import { newBody } from '../shared/physics.js';
import { TICK, NET_TICKS, EMPTY, DEBRIS } from '../shared/const.js';
import { Rooms } from '../server/rooms.js';
import { testGrid, flatGrid } from './helpers.js';

const steps = (game, seconds, onFlush) => {
  for (let t = 0; t < seconds / TICK; t++) {
    game.step(TICK);
    if (t % NET_TICKS === NET_TICKS - 1) onFlush?.(game.flush());
  }
};
const filled = (g) => g.mat.reduce((n, m) => n + (m !== EMPTY), 0);

function arena(grid, x, y) {
  const game = new Game(grid, { seed: 4, timed: false, debrisOnly: true });
  const a = game.addPlayer('Ana');
  steps(game, 0.6);
  Object.assign(a.body, newBody(x, y)); a.alive = true; a.prot = 0;
  game.flush();
  return { game, a };
}

test('debris only: guns and grenades do nothing, and joiners are told the mode', () => {
  const { game, a } = arena(flatGrid(), 200, 240);
  game.handle(a.id, { t: 'f', w: 3, a: [0.3], x: 200, y: 240 });
  game.handle(a.id, { t: 'f', w: 0, a: [0], x: 200, y: 240 });
  game.handle(a.id, { t: 'g', a: -0.5 });
  assert.equal(game.ents.size, 0);
  assert.equal(game.bullets.length, 0);
  assert.equal(game.welcome(a.id).debrisOnly, true);
  assert.equal(new Game(flatGrid(), { timed: false }).welcome(1).debrisOnly, false);
});

test('debris only: E tears off the letter you aim at, whole', () => {
  const { game, a } = arena(testGrid(), 200, 240); // under the red line of letters at row 100
  const g = game.grid;
  a.aim = -Math.PI / 2;
  const gid = g.own[101 * g.w + 101];
  assert.ok(gid > 0, 'a letter sits overhead');
  const before = g.own.reduce((n, o) => n + (o === gid), 0);
  game.handle(a.id, { t: 'e' });
  const c = game.ents.get(a.hold);
  assert.ok(c?.page, 'holding a piece of the page');
  assert.equal(c.n, before, 'the whole letter came off');
  assert.equal(g.own.reduce((n, o) => n + (o === gid), 0), 0);
});

test('debris only: aiming at plain page tears out a rock of it', () => {
  const { game, a } = arena(flatGrid(), 200, 240);
  a.aim = Math.PI / 2; // at the floor
  const before = filled(game.grid);
  game.handle(a.id, { t: 'e' });
  const c = game.ents.get(a.hold);
  assert.ok(c && !c.page, 'holding a rock');
  assert.ok(c.n >= DEBRIS.minCells && c.n <= DEBRIS.maxCells, `${c.n} cells`);
  assert.equal(filled(game.grid), before - c.n, 'exactly those cells left the page');
  assert.ok(game.flush().ev.some((e) => e[0] === 'chunk' && e[1] === c.id));
});

test('debris only: out of reach of everything, E says so', () => {
  const { game, a } = arena(flatGrid(), 200, 100); // high above the floor
  game.handle(a.id, { t: 'e' });
  assert.equal(a.hold, 0);
  assert.ok(game.flush().ev.some((e) => e[0] === 'nograb' && e[1] === a.id));
});

test('debris only: bots never shoot, they tear the page up and throw it at each other', () => {
  const g = testGrid();
  const game = new Game(g.clone(), { seed: 9, timed: false, debrisOnly: true });
  for (let i = 0; i < 4; i++) game.addBot();
  const client = g.clone(), seen = new Map();
  steps(game, 30, (m) => {
    for (const op of m.ops ?? []) applyOp(client, op, () => {});
    for (const e of m.ev ?? []) { const k = e[0] === 'hit' ? `hit:${e[4]}` : e[0]; seen.set(k, (seen.get(k) ?? 0) + 1); }
  });
  assert.ok(!seen.has('shot') && !seen.has('nade'), 'no guns or grenades');
  assert.ok((seen.get('throw') ?? 0) > 5, `bots throw (${seen.get('throw') ?? 0})`);
  assert.ok((seen.get('hit:debris') ?? 0) > 0, 'and hit someone');
  assert.ok(client.equals(game.grid), 'a client replaying the ops still has the same page');
});

test('quick match keeps debris-only and normal rooms apart', () => {
  const rooms = new Rooms();
  const join = (mode) => {
    const ws = { readyState: 1, bufferedAmount: 0, sent: [], send(s) { this.sent.push(JSON.parse(s)); }, on() {}, close() {}, terminate() {} };
    rooms.connect(ws, new URLSearchParams({ room: 'quick', name: 'P', ...(mode && { mode }) }));
    return ws.sent.find((m) => m.t === 'needmap' || m.t === 'wait')?.code;
  };
  try {
    const d1 = join('debris'), n1 = join(), d2 = join('debris'), n2 = join();
    assert.ok(d1 && n1 && d1 !== n1);
    assert.equal(d2, d1);
    assert.equal(n2, n1);
    assert.equal(rooms.rooms.get(d1).debrisOnly, true);
    assert.equal(rooms.rooms.get(n1).debrisOnly, false);
  } finally {
    rooms.close();
  }
});
