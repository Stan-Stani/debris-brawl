// Pages that build their content with JavaScript (auction listings, product grids…) come out as empty
// skeletons when only their HTML is fetched. Here such a page gets to run in a locked-down headless
// Chrome for a few seconds; what it built is then snapshotted as plain HTML (scripts stripped) and laid
// out by the player's browser like any other page.
//
// How it's locked down:
// - every request the page makes is answered by proxyFetch (public addresses only, the checked address is
//   the one we connect to, size and time caps); Chrome itself is pointed at a dead proxy, so anything
//   that slipped past the interception goes nowhere
// - WebSockets are relayed by us to checked public addresses only; no service workers, no WebRTC over UDP,
//   no pop-ups, no downloads; Chrome's own sandbox on
// - pictures get a 1-pixel stand-in (the page keeps their real addresses; the player's browser fetches the
//   real ones through /api/asset), fonts and video are skipped
// - one page at a time per slot, a hard deadline, and a byte budget per page
import fs from 'node:fs';
import { chromium } from 'playwright-core';
import { WebSocket } from 'ws';
import { proxyFetch, checkedAddress, parseTarget, cleanHtml, UserError } from './fetchPage.js';

const CHROME = process.env.CHROME || [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].find((p) => fs.existsSync(p));
const SLOTS = 2, DEADLINE = 20_000, PAGE_BYTES = 40_000_000;
const SKIP_TYPES = new Set(['media', 'font', 'websocket', 'eventsource', 'manifest', 'other']);
// a transparent 1×1 PNG: an image that "loads", so pages don't swap in their broken-picture fallback
const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

let launching = null, active = 0;
const waiting = [];

export const canRender = () => !!CHROME && process.env.RENDER !== 'off';

async function browser() {
  const b = await launching?.catch(() => null);
  if (b && !b.isConnected()) launching = null; // it died: start a fresh one
  launching ??= chromium.launch({
    executablePath: CHROME,
    headless: true,
    chromiumSandbox: true,
    args: [
      '--proxy-server=127.0.0.1:9', '--proxy-bypass-list=<-loopback>', // nothing reaches the network by itself
      '--webrtc-ip-handling-policy=disable_non_proxied_udp', '--force-webrtc-ip-handling-policy',
      '--dns-prefetch-disable', '--disable-background-networking', '--no-pings',
      '--disable-gpu', // headless needs none, and on a machine without a display it's what crashes
    ],
  }).then((b) => { b.on('disconnected', () => { launching = null; }); return b; }, (e) => { launching = null; throw e; });
  return launching;
}

async function slot() {
  if (active < SLOTS) { active++; return; }
  await new Promise((r) => waiting.push(r));
  active++;
}
function release() { active--; waiting.shift()?.(); }

// Chrome follows a redirect we hand it without asking us again (and then hits the dead proxy), so
// redirects are followed here instead, each hop checked like the first.
async function fetchFollowing(url, opts) {
  let u = url, o = opts;
  for (let hop = 0; hop < 5; hop++) {
    const r = await proxyFetch(u, o);
    if (!(r.status >= 300 && r.status < 400 && r.headers.location) || hop === 4) return { ...r, url: u };
    u = new URL(r.headers.location, u).href;
    if (r.status !== 307 && r.status !== 308) o = { ...o, method: 'GET', body: null };
  }
}

// Runs inside the rendered page: its DOM as HTML, plus CSS that scripts added through the CSSOM
// (CSS-in-JS libraries do that, leaving their <style> tags empty).
function snapshot() {
  const extra = [];
  for (const sheet of document.styleSheets) {
    try {
      const node = sheet.ownerNode;
      if (node?.tagName === 'STYLE' && !node.textContent.trim() && sheet.cssRules.length) extra.push([...sheet.cssRules].map((r) => r.cssText).join('\n'));
    } catch { /* cross-origin sheet: it's a <link>, which carries over by itself */ }
  }
  for (const sheet of document.adoptedStyleSheets ?? []) {
    try { extra.push([...sheet.cssRules].map((r) => r.cssText).join('\n')); } catch { /* ignore */ }
  }
  for (const el of document.querySelectorAll('input')) el.setAttribute('value', el.value);
  for (const img of document.images) {
    if (img.currentSrc) img.setAttribute('src', img.currentSrc);
    img.removeAttribute('srcset'); img.removeAttribute('loading');
  }
  let html = document.documentElement.outerHTML;
  if (extra.length) html = html.replace(/<\/head>/i, `<style>${extra.join('\n').replace(/<\/style/gi, '<\\/style')}</style></head>`);
  return `<!doctype html>${html}`;
}

export async function renderPage(raw) {
  if (!canRender()) throw new UserError('Rendering is off.');
  const target = parseTarget(raw);
  try {
    return await renderOnce(target);
  } catch (e) {
    if (!/closed|crash|disconnected/i.test(e.message)) throw e;
    launching = null; // Chrome went away under us: one more go with a fresh one
    return renderOnce(target);
  }
}

async function renderOnce(target) {
  await slot();
  let ctx = null;
  const sockets = new Set();
  try {
    const b = await browser();
    ctx = await b.newContext({
      viewport: { width: 1280, height: 900 }, serviceWorkers: 'block', acceptDownloads: false,
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 DebrisBrawl/0.1',
    });
    const until = Date.now() + DEADLINE;
    let bytes = 0;
    await ctx.routeWebSocket(/.*/, (ws) => relaySocket(ws, sockets, until, (n) => { bytes += n; return bytes < PAGE_BYTES; }));
    await ctx.route('**/*', async (route) => {
      const req = route.request();
      if (req.resourceType() === 'image') return route.fulfill({ status: 200, contentType: 'image/png', body: PIXEL }).catch(() => {});
      if (!/^https?:/i.test(req.url()) || SKIP_TYPES.has(req.resourceType()) || bytes > PAGE_BYTES || Date.now() > until) return route.abort().catch(() => {});
      try {
        const r = await fetchFollowing(req.url(), { method: req.method(), headers: await req.allHeaders(), body: req.postDataBuffer(), timeoutMs: Math.min(10_000, until - Date.now()) });
        bytes += r.body.length;
        await route.fulfill({ status: r.status, headers: r.headers, body: r.body });
      } catch {
        await route.abort().catch(() => {});
      }
    });
    // open the page at the address it really lives at, so its own relative links resolve without redirects
    const start = (await fetchFollowing(target.href, { method: 'GET', timeoutMs: 10_000 })).url;
    const page = await ctx.newPage();
    page.on('dialog', (d) => d.dismiss().catch(() => {}));
    page.on('popup', (p) => p.close().catch(() => {}));
    await page.goto(start, { waitUntil: 'domcontentloaded', timeout: Math.max(1000, until - Date.now() - 4000) });
    // give its scripts a moment to fetch and draw (bounded), and nudge anything that loads on scroll
    await page.waitForLoadState('networkidle', { timeout: Math.max(500, Math.min(6000, until - Date.now() - 4000)) }).catch(() => {});
    // nudge anything that loads on scroll, then wait for the content to stop changing (lists filling in)
    await page.evaluate(async () => {
      for (let y = 0; y < 3200; y += 800) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 120)); }
      window.scrollTo(0, 0);
    }).catch(() => {});
    await page.evaluate(async (ms) => {
      const end = Date.now() + ms;
      let last = -1, same = 0;
      while (Date.now() < end && same < 4) {
        const n = (document.body?.innerText.length ?? 0) + document.getElementsByTagName('*').length;
        if (n === last) same++; else { same = 0; last = n; }
        await new Promise((r) => setTimeout(r, 250));
      }
    }, Math.max(0, until - Date.now() - 2000)).catch(() => {});
    const html = await page.evaluate(snapshot);
    if (html.length > 6_000_000) throw new UserError('That page is too big.');
    const finalUrl = page.url();
    return { html: cleanHtml(html, finalUrl), finalUrl, rendered: true };
  } finally {
    for (const s of sockets) s.terminate();
    await ctx?.close().catch(() => {});
    release();
  }
}

// A page's live connection (auction status, chat…), passed through to a checked public address. Without it
// many pages show "disconnected" badges. It lives no longer than the render.
async function relaySocket(ws, sockets, until, budget) {
  const shut = () => ws.close().catch(() => {});
  try {
    if (Date.now() > until || !/^wss?:/i.test(ws.url())) return shut();
    const { addr } = await checkedAddress(ws.url().replace(/^ws/i, 'http'));
    const up = new WebSocket(ws.url(), {
      handshakeTimeout: 5000, maxPayload: 1 << 20,
      headers: { origin: new URL(ws.url().replace(/^ws/i, 'http')).origin },
      lookup: (_h, opts, cb) => (opts && opts.all ? cb(null, [{ address: addr.address, family: addr.family }]) : cb(null, addr.address, addr.family)),
    });
    sockets.add(up);
    const queued = [];
    ws.onMessage((m) => { if (up.readyState === 1) up.send(m); else queued.push(m); });
    ws.onClose(() => up.terminate());
    up.on('open', () => { for (const m of queued.splice(0)) up.send(m); });
    up.on('message', (d, binary) => { if (!budget(d.length)) { up.terminate(); return; } try { ws.send(binary ? d : d.toString()); } catch { up.terminate(); } });
    up.on('close', shut);
    up.on('error', shut);
  } catch {
    shut();
  }
}

export async function closeRenderer() {
  const b = await launching?.catch(() => null);
  launching = null;
  await b?.close().catch(() => {});
}
