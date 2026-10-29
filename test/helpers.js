import { Grid, rgb } from '../shared/grid.js';
import { SOLID, TEXT, RUBBLE } from '../shared/const.js';

// A small made-up page: a solid floor, two lines of "text" ledges and a solid box.
export function testGrid() {
  const g = new Grid(200, 150);
  const fill = (x0, y0, x1, y1, m, c) => {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) g.set(y * g.w + x, m, c);
  };
  fill(0, 120, 200, 150, SOLID, rgb(40, 60, 200));
  fill(20, 80, 120, 83, TEXT, rgb(20, 20, 20));
  fill(90, 100, 190, 103, TEXT, rgb(200, 20, 20));
  fill(150, 60, 175, 85, SOLID, rgb(240, 200, 30));
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
