// Turns a web page into terrain: lay it out in a sandboxed iframe (scripts off), paint its boxes,
// pictures and every letter onto canvases, then cut those into CELL-sized cells.
import { Grid, rgb } from '/shared/grid.js';
import { CELL, LAYOUT_W, MAX_H, MIN_H, SOLID, TEXT } from '/shared/const.js';

export const DEMO_MAPS = [
  { id: 'news', name: 'The Daily Byte', blurb: 'news front page' },
  { id: 'wiki', name: 'Pixelpedia', blurb: 'encyclopedia article' },
  { id: 'shop', name: 'MegaMart', blurb: 'online store' },
  { id: 'devlog', name: 'Night Owl Devlog', blurb: 'dark-mode blog' },
];

const MAX_CHARS = 40000;
const BIG_BOX = LAYOUT_W * 330; // a background bigger than this is scenery, not a platform
const SKIP = new Set(['script', 'style', 'head', 'title', 'meta', 'link', 'template', 'br', 'wbr', 'option', 'datalist']);
const MEDIA = new Set(['img', 'svg', 'canvas', 'video', 'iframe', 'embed', 'object']);

export async function loadPage(src, progress = () => {}) {
  progress('Fetching the page', 0.05);
  let html, base, proxied;
  if (src.kind === 'map') {
    const r = await fetch(`/maps/${encodeURIComponent(src.id)}.html`);
    if (!r.ok) throw new Error('That built-in page is missing.');
    base = new URL(`/maps/${src.id}.html`, location.href).href;
    html = withBase(await r.text(), base);
    proxied = false;
  } else {
    let r;
    progress('Opening the page and letting it build itself', 0.05); // the server runs its scripts for a few seconds
    try { r = await fetch(`/api/page?url=${encodeURIComponent(src.url)}&js=1`); } catch { throw new Error('Pages from other sites need the game server running (npm start).'); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || "Couldn't load that site.");
    html = j.html; base = j.finalUrl; proxied = true;
  }
  const { grid, look, scenery } = await rasterize(html, base, proxied, progress);
  return { grid, look, scenery, name: src.kind === 'map' ? DEMO_MAPS.find((m) => m.id === src.id)?.name ?? src.id : hostOf(base) };
}

const hostOf = (u) => { try { return new URL(u).host.replace(/^www\./, ''); } catch { return u; } };
const withBase = (html, base) => {
  const tag = `<base href="${base.replace(/"/g, '&quot;')}">`;
  return /<head\b[^>]*>/i.test(html) ? html.replace(/<head\b[^>]*>/i, (h) => h + tag) : tag + html;
};
const timeout = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(r, ms))]);
const tick = () => new Promise((r) => setTimeout(r, 0));

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c.getContext('2d', { willReadFrequently: true });
}

// Any CSS colour → [r, g, b, a] by painting one pixel with it.
const probe = makeCanvas(1, 1), colors = new Map();
function parseColor(s) {
  if (!s || s === 'transparent' || s === 'rgba(0, 0, 0, 0)') return null;
  let c = colors.get(s);
  if (c !== undefined) return c;
  probe.clearRect(0, 0, 1, 1);
  probe.fillStyle = '#000';
  probe.fillStyle = s;
  probe.fillRect(0, 0, 1, 1);
  const d = probe.getImageData(0, 0, 1, 1).data;
  c = d[3] ? [d[0], d[1], d[2], d[3] / 255] : null;
  colors.set(s, c);
  return c;
}
const near = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) < 24;

async function rasterize(html, base, proxied, progress) {
  progress('Laying it out', 0.15);
  const frame = document.createElement('iframe');
  frame.setAttribute('sandbox', 'allow-same-origin'); // we can read its layout; it can't run anything
  frame.setAttribute('aria-hidden', 'true');
  frame.tabIndex = -1;
  frame.style.cssText = `position:fixed;left:-${LAYOUT_W + 200}px;top:0;width:${LAYOUT_W}px;height:${MIN_H}px;border:0;pointer-events:none;`;
  const loaded = new Promise((r) => frame.addEventListener('load', r, { once: true }));
  frame.srcdoc = html;
  document.body.appendChild(frame);
  try {
    await timeout(loaded, 20000);
    const doc = frame.contentDocument, win = frame.contentWindow;
    if (!doc?.body) throw new Error('That page could not be laid out.');
    await timeout(Promise.all([...doc.images].map((im) => (im.complete ? null : new Promise((r) => { im.onload = im.onerror = r; })))), 5000);
    await timeout(doc.fonts?.ready ?? Promise.resolve(), 3000);
    const H = Math.min(MAX_H, Math.max(MIN_H, doc.documentElement.scrollHeight, doc.body.scrollHeight));

    progress('Fetching the pictures', 0.3);
    const blocks = makeCanvas(LAYOUT_W, H), text = makeCanvas(LAYOUT_W, H), back = makeCanvas(LAYOUT_W, H);
    const pageBg = pageBackground(doc, win);
    const clips = clipper(win);
    const { items, overlays } = collect(doc, win, H, clips);
    await loadPictures(items, proxied);

    progress('Painting the boxes and pictures', 0.45);
    const boxes = paintInOrder(items, blocks, back, pageBg);

    progress('Painting the words', 0.6);
    const letters = await paintText(doc, win, text, H, progress, overlays, clips);

    progress('Cutting it into pieces', 0.85);
    await tick();
    const grid = toGrid(blocks, text, back, H, pageBg);
    claim(grid, boxes, letters);
    if (grid.filled() < 1500) {
      throw new Error("That page came out nearly empty. It probably builds itself with JavaScript, which we don't run. Try another address or one of the built-in pages.");
    }
    return { grid, look: lookOf(blocks, text, grid), scenery: back.canvas };
  } finally {
    frame.remove();
  }
}

function pageBackground(doc, win) {
  for (const el of [doc.body, doc.documentElement]) {
    const c = parseColor(win.getComputedStyle(el).backgroundColor);
    if (c && c[3] > 0.5) return c;
  }
  return [255, 255, 255, 1];
}

// Every visible element in page order: boxes and pictures get painted in this order, so a box sitting on a
// photo ends up on top of it, like in the browser.
function collect(doc, win, H, clips) {
  const items = [], overlays = [];
  for (const el of doc.body.querySelectorAll('*')) {
    const tag = el.localName;
    if (SKIP.has(tag)) continue;
    if (tag !== 'svg' && el.closest('svg')) continue; // an SVG is painted as one picture
    const cs = win.getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility !== 'visible' || Number(cs.opacity) < 0.1) continue;
    if (overlays.some((o) => o.contains(el))) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1 || r.bottom < 0 || r.top > H || r.right < 0 || r.left > LAYOUT_W) continue;
    // cookie banners, chat bubbles and the like are pinned to the bottom of the window, not part of the page
    if (cs.position === 'fixed' && r.top > 120) { overlays.push(el); continue; }
    items.push({ el, r, cs, tag, clip: clips(el), media: MEDIA.has(tag) || (tag === 'input' && el.type === 'image') });
  }
  return { items, overlays };
}

// Where an element is actually visible: its ancestors that hide overflow (cut-off descriptions,
// carousels) clip it, as in the browser. Returns [left, top, right, bottom], memoised per element.
function clipper(win) {
  const memo = new Map(), none = [-Infinity, -Infinity, Infinity, Infinity];
  const clipOf = (el) => {
    if (!el || el === el.ownerDocument.body || el === el.ownerDocument.documentElement) return none;
    let c = memo.get(el);
    if (c) return c;
    c = clipOf(el.parentElement);
    const cs = win.getComputedStyle(el);
    if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') {
      const r = el.getBoundingClientRect();
      c = [Math.max(c[0], r.left), Math.max(c[1], r.top), Math.min(c[2], r.right), Math.min(c[3], r.bottom)];
    }
    memo.set(el, c);
    return c;
  };
  return (el) => clipOf(el.parentElement);
}

// Paints each element's background and borders, and each picture. Returns the box of every element that
// put something solid on the page (so it can later crack off as one piece).
function paintInOrder(items, ctx, bctx, pageBg) {
  const boxes = [];
  for (const { r, cs, media, img, clip } of items) {
    const rect = [Math.max(r.left, clip[0]), Math.max(r.top, clip[1]), Math.min(r.right, clip[2]), Math.min(r.bottom, clip[3])];
    if (rect[2] <= rect[0] || rect[3] <= rect[1]) continue; // entirely cut off
    const clipped = rect[0] > r.left || rect[1] > r.top || rect[2] < r.right || rect[3] < r.bottom;
    if (clipped) for (const c of [ctx, bctx]) { c.save(); c.beginPath(); c.rect(rect[0], rect[1], rect[2] - rect[0], rect[3] - rect[1]); c.clip(); }
    paintItem(ctx, bctx, pageBg, boxes, rect, r, cs, media, img);
    if (clipped) for (const c of [ctx, bctx]) c.restore();
  }
  return boxes;
}

function paintItem(ctx, bctx, pageBg, boxes, rect, r, cs, media, img) {
  if (media) {
    if (!(img && drawImageSafe(ctx, img, r, cs))) placeholder(ctx, r);
    boxes.push(rect); // a picture breaks off as one piece too
    return;
  }
  const bg = parseColor(cs.backgroundColor);
  if (bg && bg[3] > 0.15) {
    // huge, or the same colour as the page with only page under it: scenery behind the fight
    const huge = r.width * r.height > BIG_BOX || (r.width > LAYOUT_W * 0.9 && r.height > 330);
    const scenery = huge || (near(bg, pageBg) && !onTerrain(ctx, r));
    const c = scenery ? bctx : ctx;
    c.fillStyle = cs.backgroundColor;
    const rad = Math.min(parseFloat(cs.borderTopLeftRadius) || 0, r.width / 2, r.height / 2);
    c.beginPath();
    if (rad > 1) c.roundRect(r.left, r.top, r.width, r.height, rad); else c.rect(r.left, r.top, r.width, r.height);
    c.fill();
    if (!scenery) { boxes.push(rect); paintBorders(ctx, r, cs); return; }
  }
  if (paintBorders(ctx, r, cs)) boxes.push(rect);
}

// Is most of this rectangle already covered by something solid (a photo, a coloured band)?
function onTerrain(ctx, r) {
  let n = 0;
  for (const [fx, fy] of [[0.5, 0.5], [0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) {
    const x = Math.floor(r.left + r.width * fx), y = Math.floor(r.top + r.height * fy);
    if (x >= 0 && y >= 0 && x < ctx.canvas.width && y < ctx.canvas.height && ctx.getImageData(x, y, 1, 1).data[3] > 200) n++;
  }
  return n >= 3;
}

function paintBorders(ctx, r, cs) {
  let any = false;
  for (const side of ['Top', 'Right', 'Bottom', 'Left']) {
    const w = parseFloat(cs[`border${side}Width`]);
    if (!(w >= 1)) continue;
    const style = cs[`border${side}Style`];
    if (style === 'none' || style === 'hidden') continue;
    const col = cs[`border${side}Color`], c = parseColor(col);
    if (!c || c[3] < 0.15) continue;
    ctx.fillStyle = col;
    any = true;
    if (side === 'Top') ctx.fillRect(r.left, r.top, r.width, w);
    else if (side === 'Bottom') ctx.fillRect(r.left, r.bottom - w, r.width, w);
    else if (side === 'Left') ctx.fillRect(r.left, r.top, w, r.height);
    else ctx.fillRect(r.right - w, r.top, w, r.height);
  }
  return any;
}

function loadImg(src) {
  return new Promise((resolve, reject) => {
    const im = new Image();
    im.decoding = 'async';
    im.onload = () => resolve(im);
    im.onerror = reject;
    im.src = src;
    setTimeout(reject, 6000);
  });
}

function svgSource(el, r, cs) {
  const copy = el.cloneNode(true);
  copy.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  copy.setAttribute('width', String(r.width));
  copy.setAttribute('height', String(r.height));
  copy.style.color = cs.color; // so currentColor still means something
  const blob = new Blob([new XMLSerializer().serializeToString(copy)], { type: 'image/svg+xml' });
  return URL.createObjectURL(blob);
}

async function loadPictures(items, proxied) {
  const media = items.filter((it) => it.media).slice(0, 160);
  await Promise.all(media.map(async (it) => {
    const { el, r, cs, tag } = it;
    let src = null, blob = false;
    if (tag === 'img' || tag === 'input') src = el.currentSrc || el.src;
    else if (tag === 'video') src = el.poster || null;
    else if (tag === 'svg') { src = svgSource(el, r, cs); blob = true; }
    if (src && proxied && /^https?:/i.test(src)) src = `/api/asset?url=${encodeURIComponent(src)}`;
    it.img = src ? await loadImg(src).catch(() => null) : null;
    if (blob) URL.revokeObjectURL(src);
  }));
}

// Draw through a scratch canvas first: a picture that would taint the canvas becomes a placeholder.
function drawImageSafe(ctx, img, r, cs) {
  const w = Math.max(1, Math.round(r.width)), h = Math.max(1, Math.round(r.height));
  const x = makeCanvas(w, h);
  try {
    const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
    if (!iw || !ih) return false;
    const fit = cs.objectFit;
    if (fit === 'cover' || fit === 'contain') {
      const k = fit === 'cover' ? Math.max(w / iw, h / ih) : Math.min(w / iw, h / ih);
      x.drawImage(img, (w - iw * k) / 2, (h - ih * k) / 2, iw * k, ih * k);
    } else x.drawImage(img, 0, 0, w, h);
    x.getImageData(0, 0, 1, 1); // throws if tainted
  } catch {
    return false;
  }
  ctx.drawImage(x.canvas, r.left, r.top);
  return true;
}

function placeholder(ctx, r) {
  if (r.width < 6 || r.height < 6) return;
  ctx.fillStyle = '#a7adb5';
  ctx.fillRect(r.left, r.top, r.width, r.height);
  ctx.save();
  ctx.beginPath(); ctx.rect(r.left, r.top, r.width, r.height); ctx.clip();
  ctx.strokeStyle = '#8b929b'; ctx.lineWidth = 4;
  for (let d = -r.height; d < r.width; d += 14) { ctx.beginPath(); ctx.moveTo(r.left + d, r.bottom); ctx.lineTo(r.left + d + r.height, r.top); ctx.stroke(); }
  ctx.restore();
}

// Every visible character, drawn where the browser put it. Returns each one's box.
async function paintText(doc, win, ctx, H, progress, overlays, clips) {
  const letters = [];
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  const range = doc.createRange();
  ctx.textBaseline = 'alphabetic';
  let count = 0, node, parent = null, ok = false, descent = 0, transform = 'none', clip = null;
  while ((node = walker.nextNode())) {
    const s = node.data;
    if (!/\S/.test(s)) continue;
    const el = node.parentElement;
    if (!el) continue;
    if (el !== parent) {
      parent = el;
      ok = false;
      if (el.closest('script,style,template,svg,title,textarea,select') || overlays.some((o) => o.contains(el))) continue;
      clip = clips(node); // what this text's element and its ancestors let show
      const cs = win.getComputedStyle(el), col = parseColor(cs.color);
      if (!col || col[3] < 0.2 || cs.visibility !== 'visible' || Number(cs.opacity) < 0.1) continue;
      ok = true;
      // the site's web fonts can't be used here, so make sure the fallback is a sans-serif rather than Times
      const family = /\b(serif|sans-serif|monospace|cursive|fantasy|system-ui)\b/i.test(cs.fontFamily) ? cs.fontFamily : `${cs.fontFamily}, sans-serif`;
      ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${family}`;
      ctx.fillStyle = cs.color;
      descent = ctx.measureText('Hg').fontBoundingBoxDescent || parseFloat(cs.fontSize) * 0.22;
      transform = cs.textTransform;
    }
    if (!ok) continue;
    let i = 0, wordStart = true;
    for (const ch of s) {
      const len = ch.length;
      if (/\s/.test(ch)) { i += len; wordStart = true; continue; }
      range.setStart(node, i);
      range.setEnd(node, i + len);
      i += len;
      const rr = range.getClientRects()[0];
      if (!rr || rr.width < 0.5 || rr.bottom < 0 || rr.top > H || rr.right < 0 || rr.left > LAYOUT_W) { wordStart = false; continue; }
      const mx = (rr.left + rr.right) / 2, my = (rr.top + rr.bottom) / 2;
      if (mx < clip[0] || mx > clip[2] || my < clip[1] || my > clip[3]) { wordStart = false; continue; } // cut off by the site
      let out = ch;
      if (transform === 'uppercase' || (transform === 'capitalize' && wordStart)) out = ch.toUpperCase();
      else if (transform === 'lowercase') out = ch.toLowerCase();
      wordStart = false;
      ctx.fillText(out, rr.left, rr.bottom - descent);
      letters.push([rr.left, rr.top, rr.right, rr.bottom]);
      if (++count >= MAX_CHARS) return letters;
      if (count % 3000 === 0) { progress('Painting the words', 0.6 + 0.2 * (count / MAX_CHARS)); await tick(); }
    }
  }
  return letters;
}

function toGrid(blocks, text, back, H, pageBg) {
  const W = LAYOUT_W, GW = W / CELL, GH = Math.ceil(H / CELL);
  const bd = blocks.getImageData(0, 0, W, H).data, td = text.getImageData(0, 0, W, H).data, kd = back.getImageData(0, 0, W, H).data;
  const g = new Grid(GW, GH);
  const [pr, pg, pb] = pageBg;
  g.pageBg = rgb(pr, pg, pb);
  const out = [0, 0, 0, 0];
  const avg = (d, cx, cy) => {
    let r = 0, gg = 0, b = 0, a = 0, n = 0;
    for (let y = cy * CELL; y < Math.min(H, cy * CELL + CELL); y++) {
      for (let x = cx * CELL; x < cx * CELL + CELL; x++, n++) {
        const k = (y * W + x) * 4, al = d[k + 3];
        r += d[k] * al; gg += d[k + 1] * al; b += d[k + 2] * al; a += al;
      }
    }
    out[3] = n ? a / (n * 255) : 0;
    if (a) { out[0] = r / a; out[1] = gg / a; out[2] = b / a; }
    return out;
  };
  for (let cy = 0; cy < GH; cy++) {
    for (let cx = 0; cx < GW; cx++) {
      const i = cy * GW + cx;
      let c = avg(td, cx, cy);
      if (c[3] >= 0.28) g.set(i, TEXT, rgb(c[0] | 0, c[1] | 0, c[2] | 0));
      else {
        c = avg(bd, cx, cy);
        if (c[3] >= 0.5) {
          const a = c[3]; // blend partial coverage over the page colour
          g.set(i, SOLID, rgb((c[0] * a + pr * (1 - a)) | 0, (c[1] * a + pg * (1 - a)) | 0, (c[2] * a + pb * (1 - a)) | 0));
        }
      }
      c = avg(kd, cx, cy);
      if (c[3] >= 0.5) {
        const k = rgb(c[0] | 0, c[1] | 0, c[2] | 0);
        if (Math.abs(c[0] - pr) + Math.abs(c[1] - pg) + Math.abs(c[2] - pb) > 6) g.back[i] = k;
      }
    }
  }
  return g;
}

// Tag each cell with what it belongs to: -n for box n (later boxes are painted on top, so they win),
// +n for letter n. Only boxes and letters that ended up with cells get a number.
function claim(g, boxes, letters) {
  const cells = (l, t, r, b) => [Math.max(0, Math.floor(l / CELL)), Math.max(0, Math.floor(t / CELL)), Math.min(g.w - 1, Math.floor((r - 0.01) / CELL)), Math.min(g.h - 1, Math.floor((b - 0.01) / CELL))];
  const assign = (rects, mat, sign) => {
    const table = [];
    for (const rect of rects) {
      const [x0, y0, x1, y1] = cells(...rect);
      if (x1 < x0 || y1 < y0 || (x1 - x0 + 1) * (y1 - y0 + 1) > 200000) continue; // giant wrappers aren't one piece
      let any = false;
      for (let y = y0; y <= y1 && !any; y++) for (let x = x0; x <= x1; x++) if (g.mat[y * g.w + x] === mat) { any = true; break; }
      if (!any) continue;
      table.push(x0, y0, x1, y1);
      const id = sign * (table.length / 4);
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (g.mat[y * g.w + x] === mat) g.own[y * g.w + x] = id;
    }
    return Int32Array.from(table);
  };
  g.blocks = assign(boxes, SOLID, -1);
  g.glyphs = assign(letters, TEXT, 1);
}

// The page as it looks, at full resolution: boxes and pictures with the words on top. Faint pixels in
// empty cells that aren't next to anything solid are wiped, so nothing looks solid that isn't.
function lookOf(blocks, text, g) {
  const W = blocks.canvas.width, H = blocks.canvas.height, out = makeCanvas(W, H);
  out.drawImage(blocks.canvas, 0, 0);
  out.drawImage(text.canvas, 0, 0);
  const img = out.getImageData(0, 0, W, H), px = new Uint32Array(img.data.buffer);
  for (let cy = 0; cy < g.h; cy++) {
    for (let cx = 0; cx < g.w; cx++) {
      if (g.mat[cy * g.w + cx]) continue;
      let near = false;
      for (let y = Math.max(0, cy - 1); y <= Math.min(g.h - 1, cy + 1) && !near; y++) for (let x = Math.max(0, cx - 1); x <= Math.min(g.w - 1, cx + 1); x++) if (g.mat[y * g.w + x]) { near = true; break; }
      if (near) continue;
      for (let y = cy * CELL; y < Math.min(H, cy * CELL + CELL); y++) for (let x = cx * CELL; x < cx * CELL + CELL; x++) px[y * W + x] = 0;
    }
  }
  out.putImageData(img, 0, 0);
  return out.canvas;
}
