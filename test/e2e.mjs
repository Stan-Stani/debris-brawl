// End-to-end: real server, two headless browsers in one room, debris thrown from one at the other.
// Run: npm run e2e   (needs Chrome, or set CHROME=/path/to/chrome; uses playwright-core)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { startServer } from '../server/index.js';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'out');
fs.mkdirSync(OUT, { recursive: true });
const CHROME = process.env.CHROME || ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find((p) => fs.existsSync(p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => { results.push([ok, name, detail]); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  (${detail})` : ''}`); };

async function waitFor(page, fn, arg, ms = 15000) {
  try { await page.waitForFunction(fn, arg, { timeout: ms, polling: 100 }); return true; } catch { return false; }
}

const UPLOADS = fs.mkdtempSync(path.join(os.tmpdir(), 'db-e2e-up-'));
const { port, close } = await startServer({ port: 0, host: '127.0.0.1', uploadDir: UPLOADS });
const base = `http://127.0.0.1:${port}`;
const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const errors = [];
async function open(name) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 760 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  // a fetched real site may try to load media our CSP blocks, or pictures the proxy refuses: not our bugs
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Content Security Policy|Failed to load resource/.test(m.text())) errors.push(`${name} console: ${m.text()}`);
  });
  return page;
}

try {
  // --- A hosts a room on the news page ---
  const a = await open('A');
  await a.goto(`${base}/?debug=1`);
  await a.fill('#name', 'Ana');
  await a.click('.map-news');
  await a.click('#create');
  check('host builds the page and enters the room', await waitFor(a, () => window.__game?.ready && window.__game.me.alive, null, 30000));
  const code = await a.evaluate(() => window.__game.code);
  check('room has a 6-character code', /^[A-Z0-9]{6}$/.test(code ?? ''), code);
  const filled = await a.evaluate(() => window.__game.grid.filled());
  check('the page became terrain', filled > 20000, `${filled} cells`);
  await a.screenshot({ path: path.join(OUT, 'a-start.png') });

  // --- B joins with the code ---
  const b = await open('B');
  await b.goto(`${base}/?room=${code}&debug=1`);
  await b.fill('#name', 'Vik');
  await b.click('#join');
  check('guest joins by code', await waitFor(b, () => window.__game?.ready && window.__game.me.alive, null, 20000));
  check('both see two players', await waitFor(a, () => window.__game.players.size === 2) && await waitFor(b, () => window.__game.players.size === 2));
  const same = await a.evaluate(() => window.__game.grid.filled()) === await b.evaluate(() => window.__game.grid.filled());
  check('both have the same page', same);
  const packed = await a.evaluate(async () => (await (await import('/js/codec.js')).packGrid(window.__game.grid)).length);
  check('the whole page fits in a small join message', packed < 1_500_000, `${Math.round(packed / 1024)} KB`);
  const svgHeaders = await a.evaluate(async () => {
    const r = await fetch('/api/asset?url=' + encodeURIComponent('http://127.0.0.1/x.svg'));
    return r.status;
  });
  check('asset proxy refuses local addresses', svgHeaders === 400, String(svgHeaders));

  // find a flat stretch of floor wide enough for the duel, near the top of the page
  const spot = await a.evaluate(() => {
    const g = window.__game.grid, C = 2;
    for (let cy = 160; cy < g.h - 40; cy += 2) {
      for (let cx = 140; cx < g.w - 220; cx += 6) {
        let ok = true;
        for (let x = cx; x < cx + 180 && ok; x++) if (g.mat[cy * g.w + x] !== 1) ok = false; // solid floor
        for (let y = cy - 40; y < cy && ok; y++) for (let x = cx; x < cx + 180 && ok; x++) if (g.mat[y * g.w + x] !== 0) ok = false; // open air above
        if (ok) return { x: (cx + 30) * C, y: cy * C, x2: (cx + 150) * C };
      }
    }
    return null;
  });
  check('found a floor to fight on', !!spot, JSON.stringify(spot));
  const place = (page, x, y) => page.evaluate(([x, y]) => { const b = window.__game.me.body; Object.assign(b, { x, y, vx: 0, vy: 0 }); window.__game.sendState(); }, [x, y]);
  await place(a, spot.x, spot.y);
  await place(b, spot.x2, spot.y);
  await sleep(2200); // let spawn protection wear off

  // B moves; A should see it
  const bx0 = await a.evaluate(() => { const g = window.__game; for (const p of g.players.values()) if (p.id !== g.me.id) return p.snaps.at(-1)?.x; });
  await b.keyboard.down('KeyA'); await sleep(250); await b.keyboard.up('KeyA'); await sleep(400);
  const bx1 = await a.evaluate(() => { const g = window.__game; for (const p of g.players.values()) if (p.id !== g.me.id) return p.snaps.at(-1)?.x; });
  check("A sees B's movement", bx1 < bx0 - 10, `${bx0} -> ${bx1}`);
  await place(b, spot.x2, spot.y);

  // E with nothing loose nearby says so (exercises the real key path)
  await a.keyboard.press('KeyE');
  check('E with no rubble around explains why', await waitFor(a, () => /debris/i.test(window.__game.toastMsg) && window.__game.toastT > 0, null, 3000));

  // A blasts the floor behind itself to make rubble
  await a.evaluate(([x, y]) => {
    const g = window.__game, me = g.me;
    const aim = Math.atan2(y + 4 - (me.body.y - 22), x - 70 - me.body.x);
    g.net.send({ t: 'f', w: 3, a: [aim], x: me.body.x, y: me.body.y });
  }, [spot.x, spot.y]);
  await sleep(2500);
  const rubble = await a.evaluate(() => window.__game.grid.mat.reduce((n, m) => n + (m === 3), 0));
  check('explosion leaves rubble', rubble > 50, `${rubble} cells`);
  await a.screenshot({ path: path.join(OUT, 'a-crater.png') });

  // walk A onto the rubble and scoop it up with E
  // the densest pile: most rubble within grabbing reach of one spot
  const pile = await a.evaluate(() => {
    const gr = window.__game.grid, cells = [];
    for (let i = 0; i < gr.mat.length; i++) if (gr.mat[i] === 3) cells.push([(i % gr.w) * 2, Math.floor(i / gr.w) * 2]);
    let best = null;
    for (const [x, y] of cells) {
      let n = 0;
      for (const [u, v] of cells) if ((u - x) ** 2 + (v - y) ** 2 < 28 * 28) n++;
      if (!best || n > best.n) best = { x, y, n };
    }
    return best;
  });
  check('rubble piles up somewhere', pile?.n >= 6, `${pile?.n} cells in reach`);
  // chest (feet - 17) right on the pile; send it and grab before local physics moves us
  await a.evaluate(([x, y]) => {
    const g = window.__game, b = g.me.body;
    Object.assign(b, { x, y: y + 17, vx: 0, vy: 0 });
    g.sendState();
    g.net.send({ t: 'e' });
  }, [pile.x, pile.y]);
  check('E picks up debris', await waitFor(a, () => { const g = window.__game; return !!g.players.get(g.me.id)?.hold; }, null, 3000));
  const n = await a.evaluate(() => window.__game.heldSprite()?.n);
  check('the chunk has a size', n >= 6, `${n} cells`);
  await place(a, spot.x, spot.y);
  await sleep(400);
  await a.screenshot({ path: path.join(OUT, 'a-holding.png') });

  // aim at B with the real mouse (search for the angle that lands on B's chest), hold to wind up, release
  const hp0 = await b.evaluate(() => window.__game.players.get(window.__game.me.id).hp);
  const aimAt = () => a.evaluate(async () => {
    const { throwVelocity } = await import('/shared/debris.js');
    const g = window.__game, me = g.me.body, sp = g.heldSprite();
    let target = null;
    for (const p of g.players.values()) if (p.id !== g.me.id) target = p.snaps.at(-1);
    const sx = me.x, sy = me.y - 34 - sp.rad - 1, tx = target.x, ty = target.y - 17;
    let best = 0, err = 1e9;
    for (let ang = -1.2; ang <= 0.6; ang += 0.002) {
      const v = throwVelocity(ang, 1, sp.n, 0, 0);
      const t = (tx - sx) / v.vx;
      if (t <= 0) continue;
      const y = sy + v.vy * t + 0.5 * 1300 * t * t;
      if (Math.abs(y - ty) < err) { err = Math.abs(y - ty); best = ang; }
    }
    // the screen point that makes the client aim at that angle (aim is measured from the shoulder)
    const wx = me.x + Math.cos(best) * 160, wy = me.y - 22 + Math.sin(best) * 160;
    return { x: ((wx - g.cam.x) * g.zoom) / g.dpr, y: ((wy - g.cam.y) * g.zoom) / g.dpr };
  });
  for (let i = 0; i < 4; i++) { const p = await aimAt(); await a.mouse.move(p.x, p.y); await sleep(350); } // camera follows the mouse a bit
  await a.mouse.down();
  await sleep(500);
  const charging = await a.evaluate(() => window.__game.me.charging && window.__game.me.charge > 0.3);
  await a.screenshot({ path: path.join(OUT, 'a-charging.png') });
  await sleep(400);
  { const p = await aimAt(); await a.mouse.move(p.x, p.y); }
  await a.mouse.up();
  check('holding the mouse winds up a throw', charging);
  const hit = await waitFor(b, (h) => window.__game.players.get(window.__game.me.id).hp < h, hp0, 3000);
  const hp1 = await b.evaluate(() => window.__game.players.get(window.__game.me.id).hp);
  check('thrown debris hurts the other player', hit, `B hp ${hp0} -> ${hp1}`);
  await sleep(150);
  await b.screenshot({ path: path.join(OUT, 'b-hit.png') });
  const feedOk = await a.evaluate(() => window.__game.floaters.length > 0 || window.__game.hitT > 0);
  check('A gets hit feedback', feedOk);
  const sync = await a.evaluate(() => Array.from(window.__game.grid.mat.slice(0, 400000)).join('').length) && await Promise.all([a, b].map((p) => p.evaluate(() => { let h = 0; const m = window.__game.grid.mat, c = window.__game.grid.col; for (let i = 0; i < m.length; i++) h = (Math.imul(h, 31) + m[i] * 7 + c[i]) | 0; return h; })));
  check('both pages still identical after all that', sync[0] === sync[1]);

  // --- solo with bots ---
  const s = await open('S');
  await s.goto(`${base}/?debug=1`);
  await s.fill('#name', 'Solo');
  await s.click('.map-shop');
  await s.click('#solo');
  check('solo starts with bots', await waitFor(s, () => window.__game?.ready && window.__game.me.alive && window.__game.players.size === 4, null, 30000));
  const before = await s.evaluate(() => window.__game.grid.filled());
  await sleep(9000);
  const after = await s.evaluate(() => window.__game.grid.filled());
  check('bots wreck the page', after < before, `${before} -> ${after}`);
  await s.screenshot({ path: path.join(OUT, 'solo-shop.png') });

  for (const id of ['wiki', 'devlog']) {
    await s.click('canvas');
    await s.keyboard.press('Escape');
    await s.click(`#maps2 .map-${id}`);
    const ok = await waitFor(s, (m) => window.__game.ready && window.__game.mapName && !document.getElementById('loading').checkVisibility() && window.__game.me.alive, id, 30000);
    await sleep(1500);
    await s.screenshot({ path: path.join(OUT, `solo-${id}.png`) });
    check(`switch to ${id}`, ok);
  }

  // --- screenshot page: pick a file, then paste one ---
  const sh = await open('share');
  await sh.goto(`${base}/share.html`);
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63f8cfc0f01f0005000201a5e3b5a40000000049454e44ae426082', 'hex');
  await sh.fill('#note', 'picked from disk');
  await sh.setInputFiles('#file', { name: 'shot.png', mimeType: 'image/png', buffer: png });
  check('share page uploads a picked file', await waitFor(sh, () => document.querySelectorAll('.shots li strong')[0]?.textContent === 'Saved', null, 5000));
  await sh.evaluate((bytes) => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(bytes)], 'clip.png', { type: 'image/png' }));
    document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true }));
  }, [...png]);
  check('share page uploads a pasted screenshot', await waitFor(sh, () => [...document.querySelectorAll('.shots li strong')].filter((s) => s.textContent === 'Saved').length === 2, null, 5000));
  const saved = fs.readdirSync(UPLOADS).filter((f) => f.endsWith('.png'));
  check('both pictures landed in uploads/', saved.length === 2 && fs.readdirSync(UPLOADS).some((f) => f.endsWith('.txt')), saved.join(', '));
  await sh.screenshot({ path: path.join(OUT, 'share.png') });

  // --- a real website through the proxy (needs internet) ---
  if (process.env.E2E_URL !== 'off') {
    const url = process.env.E2E_URL || 'https://en.wikipedia.org/wiki/Stick_figure';
    await s.click('canvas');
    await s.keyboard.press('Escape');
    await s.fill('#url2', url);
    await s.click('#loadurl');
    const ok = await waitFor(s, (u) => window.__game.ready && !document.getElementById('loading').checkVisibility() && window.__game.mapName && !window.__game.mapName.includes('Devlog'), url, 45000);
    const err = await s.evaluate(() => document.getElementById('pauseerr').textContent);
    await sleep(2500);
    await s.screenshot({ path: path.join(OUT, 'solo-url.png') });
    check(`loads a real site (${url})`, ok && !err, err || (await s.evaluate(() => `${window.__game.mapName}, ${window.__game.grid.filled()} cells`)));
  }
} finally {
  if (errors.length) console.log('\nbrowser errors:\n' + errors.join('\n'));
  check('no script errors in the browsers', errors.length === 0, `${errors.length}`);
  await browser.close();
  close();
  fs.rmSync(UPLOADS, { recursive: true, force: true });
  const failed = results.filter(([ok]) => !ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exitCode = failed ? 1 : 0;
}
