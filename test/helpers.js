import { Grid, rgb } from '../shared/grid.js';
import { SOLID, TEXT, RUBBLE } from '../shared/const.js';

// A small made-up page: a solid floor, two lines of letters (ledges) and a box with a label on it.
export function testGrid() {
  const g = new Grid(200, 150);
  const fill = (x0, y0, x1, y1, m, c, o = 0) => {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) g.set(y * g.w + x, m, c, o);
  };
  const glyphs = [], blocks = [];
  const letter = (x, y, c) => { glyphs.push(x, y, x + 3, y + 2); fill(x, y, x + 4, y + 3, TEXT, c, glyphs.length / 4); };
  fill(0, 120, 200, 150, SOLID, rgb(40, 60, 200));
  for (let x = 20; x < 120; x += 5) letter(x, 80, rgb(20, 20, 20));
  for (let x = 90; x < 190; x += 5) letter(x, 100, rgb(200, 20, 20));
  blocks.push(150, 60, 174, 84);
  fill(150, 60, 175, 85, SOLID, rgb(240, 200, 30), -1);
  letter(155, 70, rgb(90, 60, 0)); // a label on the box
  g.glyphs = Int32Array.from(glyphs);
  g.blocks = Int32Array.from(blocks);
  g.pageBg = rgb(250, 250, 245);
  for (let i = 0; i < 400; i++) g.back[i] = rgb(220, 220, 255);
  return g;
}

// Just a floor: nothing in the way of a throw.
export function flatGrid() {
  const g = new Grid(200, 150);
  for (let y = 120; y < 150; y++) for (let x = 0; x < 200; x++) g.set(y * g.w + x, SOLID, rgb(40, 60, 200));
  return g;
}

export function rubblePatch(g, x0, y0, w, h) {
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) g.set(y * g.w + x, RUBBLE, rgb(120, 110, 100));
}

export const stillInput = () => ({ l: false, r: false, jump: false, down: false, jp: false, dp: false });
