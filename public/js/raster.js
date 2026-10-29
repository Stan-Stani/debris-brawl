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
    try { r = await fetch(`/api/page?url=${encodeURIComponent(src.url)}`); } catch { throw new Error('Pages from other sites need the game server running (npm start).'); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || "Couldn't load that site.");
    html = j.html; base = j.finalUrl; proxied = true;
  }
  const grid = await rasterize(html, base, proxied, progress);
  return { grid, name: src.kind === 'map' ? DEMO_MAPS.find((m) => m.id === src.id)?.name ?? src.id : hostOf(base) };
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

    progress('Painting the boxes', 0.3);
    const blocks = makeCanvas(LAYOUT_W, H), text = makeCanvas(LAYOUT_W, H), back = makeCanvas(LAYOUT_W, H);
    const pageBg = pageBackground(doc, win);
    const media = paintBoxes(doc, win, blocks, back, pageBg, H);

    progress('Painting the pictures', 0.45);
    await paintMedia(media, blocks, proxied);

    progress('Painting the words', 0.6);
    await paintText(doc, win, text, H, progress);

    progress('Cutting it into pieces', 0.85);
    await tick();
    const grid = toGrid(blocks, text, back, H, pageBg);
    if (grid.filled() < 1500) {
      throw new Error("That page came out nearly empty. It probably builds itself with JavaScript, which we don't run. Try another address or one of the built-in pages.");
    }
    return grid;
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

function paintBoxes(doc, win, ctx, bctx, pageBg, H) {
  const media = [];
  for (const el of doc.body.querySelectorAll('*')) {
    const tag = el.localName;
    if (SKIP.has(tag)) continue;
    if (tag !== 'svg' && el.closest('svg')) continue; // an SVG is painted as one picture
    const cs = win.getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility !== 'visible' || Number(cs.opacity) < 0.1) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1 || r.bottom < 0 || r.top > H || r.right < 0 || r.left > LAYOUT_W) continue;
    if (MEDIA.has(tag) || (tag === 'input' && el.type === 'image')) { media.push({ el, r, cs, tag }); continue; }
    const bg = parseColor(cs.backgroundColor);
    if (bg && bg[3] > 0.15) {
      // the same colour as the page, or huge: scenery behind the fight rather than something to stand on
      const scenery = near(bg, pageBg) || r.width * r.height > BIG_BOX || (r.width > LAYOUT_W * 0.9 && r.height > 330);
      const c = scenery ? bctx : ctx;
      c.fillStyle = cs.backgroundColor;
      const rad = Math.min(parseFloat(cs.borderTopLeftRadius) || 0, r.width / 2, r.height / 2);
      c.beginPath();
      if (rad > 1) c.roundRect(r.left, r.top, r.width, r.height, rad); else c.rect(r.left, r.top, r.width, r.height);
      c.fill();
    }
    paintBorders(ctx, r, cs);
  }
  return media;
}

function paintBorders(ctx, r, cs) {
  for (const side of ['Top', 'Right', 'Bottom', 'Left']) {
    const w = parseFloat(cs[`border${side}Width`]);
    if (!(w >= 1)) continue;
    const style = cs[`border${side}Style`];
    if (style === 'none' || style === 'hidden') continue;
    const col = cs[`border${side}Color`], c = parseColor(col);
    if (!c || c[3] < 0.15) continue;
    ctx.fillStyle = col;
    if (side === 'Top') ctx.fillRect(r.left, r.top, r.width, w);
    else if (side === 'Bottom') ctx.fillRect(r.left, r.bottom - w, r.width, w);
    else if (side === 'Left') ctx.fillRect(r.left, r.top, w, r.height);
    else ctx.fillRect(r.right - w, r.top, w, r.height);
  }
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

async function paintMedia(media, ctx, proxied) {
  const jobs = media.slice(0, 160).map(async ({ el, r, cs, tag }) => {
    let src = null, blob = false;
    if (tag === 'img' || tag === 'input') src = el.currentSrc || el.src;
    else if (tag === 'video') src = el.poster || null;
    else if (tag === 'svg') { src = svgSource(el, r, cs); blob = true; }
    if (src && proxied && /^https?:/i.test(src)) src = `/api/asset?url=${encodeURIComponent(src)}`;
    const img = src ? await loadImg(src).catch(() => null) : null;
    if (blob) URL.revokeObjectURL(src);
    return { r, cs, img };
  });
  for (const { r, cs, img } of await Promise.all(jobs)) {
    if (!(img && drawImageSafe(ctx, img, r, cs))) placeholder(ctx, r);
  }
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

// Every visible character, drawn where the browser put it.
async function paintText(doc, win, ctx, H, progress) {
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  const range = doc.createRange();
  ctx.textBaseline = 'alphabetic';
  let count = 0, node, parent = null, ok = false, descent = 0, transform = 'none';
  while ((node = walker.nextNode())) {
    const s = node.data;
    if (!/\S/.test(s)) continue;
    const el = node.parentElement;
    if (!el) continue;
    if (el !== parent) {
      parent = el;
      ok = false;
      if (el.closest('script,style,template,svg,title,textarea,select')) continue;
      const cs = win.getComputedStyle(el), col = parseColor(cs.color);
      if (!col || col[3] < 0.2 || cs.visibility !== 'visible' || Number(cs.opacity) < 0.1) continue;
      ok = true;
      ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
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
      let out = ch;
      if (transform === 'uppercase' || (transform === 'capitalize' && wordStart)) out = ch.toUpperCase();
      else if (transform === 'lowercase') out = ch.toLowerCase();
      wordStart = false;
      ctx.fillText(out, rr.left, rr.bottom - descent);
      if (++count >= MAX_CHARS) return;
      if (count % 3000 === 0) { progress('Painting the words', 0.6 + 0.2 * (count / MAX_CHARS)); await tick(); }
    }
  }
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
