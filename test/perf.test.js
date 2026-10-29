import test from 'node:test';
import assert from 'node:assert/strict';
import { Grid, rgb } from '../shared/grid.js';
import { Game } from '../shared/game.js';
import { SOLID, TEXT, TICK, NET_TICKS, MAX_PLAYERS } from '../shared/const.js';

// A full-size page: 640 x 1600 cells, rows of "text" and some solid boxes.
function bigPage() {
  const g = new Grid(640, 1600);
  for (let y = 0; y < g.h; y++) {
    for (let x = 0; x < g.w; x++) {
      const line = y % 28 < 9 && x % 9 < 6 && x > 40 && x < 600; // words
      const box = (y % 300 > 200 && y % 300 < 230 && x % 200 < 150);
      if (box) g.set(y * g.w + x, SOLID, rgb(200, 60, 60));
      else if (line) g.set(y * g.w + x, TEXT, rgb(20, 20, 20));
    }
  }
  return g;
}

test('a full room of bots on a full-size page runs well inside the tick budget', () => {
  const game = new Game(bigPage(), { seed: 11, timed: false });
  for (let i = 0; i < MAX_PLAYERS; i++) game.addBot();
  const ticks = 60 * 30;
  let worst = 0, bytes = 0;
  const t0 = performance.now();
  for (let i = 0; i < ticks; i++) {
    const s = performance.now();
    game.step(TICK);
    if (i % NET_TICKS === 0) bytes += JSON.stringify(game.flush()).length;
    worst = Math.max(worst, performance.now() - s);
  }
  const avg = (performance.now() - t0) / ticks;
  console.log(`  avg ${avg.toFixed(2)} ms/tick, worst ${worst.toFixed(1)} ms, ${(bytes / 30 / 1024).toFixed(1)} KB/s per player`);
  assert.ok(avg < 4, `average tick ${avg.toFixed(2)} ms`); // budget is 16.7 ms
  assert.ok(bytes / 30 < 200 * 1024, 'update traffic per player stays modest');
});
