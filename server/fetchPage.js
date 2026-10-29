// Fetching other people's pages (and their pictures) so the browser can turn them into terrain,
// without letting anyone use this server to reach localhost, the LAN or cloud metadata endpoints.
import dns from 'node:dns/promises';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';

// Problems the player should see verbatim.
export class UserError extends Error {}

// Only the test suite turns this on, to fetch from a local fixture server on 127.0.0.1 (any port).
export const policy = { testing: false };

const V4_BLOCKED = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
];
const v4num = (ip) => ip.split('.').reduce((a, o) => a * 256 + Number(o), 0);
const v4blocked = (ip) => {
  const n = v4num(ip);
  return V4_BLOCKED.some(([base, bits]) => n >= v4num(base) && n < v4num(base) + 2 ** (32 - bits));
};
const v4from = (hi, lo) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;

function expand6(ip) {
  let s = ip.toLowerCase();
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  let tail = [];
  const m = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (m) {
    const n = v4num(m[1]);
    tail = [Math.floor(n / 65536), n % 65536];
    s = s.slice(0, -m[1].length);
    if (s.endsWith(':') && !s.endsWith('::')) s = s.slice(0, -1);
  }
  const [head, rest] = s.split('::');
  const hex = (part) => (part ? part.split(':').map((x) => parseInt(x, 16)) : []);
  const h = hex(head), r = rest === undefined ? null : hex(rest);
  const out = r === null ? [...h, ...tail] : [...h, ...Array(Math.max(0, 8 - h.length - r.length - tail.length)).fill(0), ...r, ...tail];
  return out.length === 8 && out.every((x) => Number.isInteger(x) && x >= 0 && x <= 0xffff) ? out : null;
}

// Only addresses on the public internet.
export function isPublicAddress(ip) {
  const kind = net.isIP(ip);
  if (kind === 4) return !v4blocked(ip);
  if (kind !== 6) return false;
  const h = expand6(ip);
  if (!h) return false;
  if (h.slice(0, 5).every((x) => x === 0) && (h[5] === 0 || h[5] === 0xffff)) return isPublicAddress(v4from(h[6], h[7])); // ::, ::1, ::ffff:a.b.c.d
  if (h[0] === 0x64 && h[1] === 0xff9b) return h.slice(2, 6).every((x) => x === 0) && isPublicAddress(v4from(h[6], h[7])); // NAT64
  if (h[0] === 0x2002) return isPublicAddress(v4from(h[1], h[2])); // 6to4
  if (h[0] < 0x2000 || h[0] > 0x3fff) return false; // not global unicast (ULA, link-local, multicast, …)
  if (h[0] === 0x2001 && (h[1] < 0x200 || h[1] === 0xdb8)) return false; // Teredo/benchmarking/docs
  return true;
}

export function parseTarget(raw) {
  if (typeof raw !== 'string' || !raw.trim()) throw new UserError('Type a web address.');
  let s = raw.trim();
  if (s.length > 2000) throw new UserError('That address is too long.');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;
  let u;
  try { u = new URL(s); } catch { throw new UserError("That doesn't look like a web address."); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new UserError('Only http and https pages can be loaded.');
  if (u.username || u.password) throw new UserError('Addresses with passwords in them are not allowed.');
  if (u.port && u.port !== '80' && u.port !== '443' && !policy.testing) throw new UserError('Only pages on the normal web ports can be loaded.');
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  const bare = host.replace(/^\[|\]$/g, '');
  if (!host || (!net.isIP(bare) && !host.includes('.')) || /(^|\.)(localhost|local|internal|intranet|lan|home\.arpa)$/.test(host)) {
    throw new UserError("That address isn't on the public web.");
  }
  u.hash = '';
  return u;
}

const allowed = (ip) => isPublicAddress(ip) || (policy.testing && ip === '127.0.0.1');

async function resolvePublic(hostname) {
  const h = hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(h)) {
    if (!allowed(h)) throw new UserError("That address isn't on the public web.");
    return { address: h, family: net.isIP(h) };
  }
  let addrs;
  try { addrs = await dns.lookup(h, { all: true, verbatim: true }); } catch { throw new UserError("Couldn't find that site."); }
  // every address must be public, or a name with one private record could be used to sneak in
  if (!addrs.length || addrs.some((a) => !allowed(a.address))) throw new UserError("That address isn't on the public web.");
  return addrs[0];
}

function request(url, addr, accept, timeoutMs) {
  return send(url, addr, {
    timeoutMs,
    headers: { 'user-agent': 'Mozilla/5.0 (compatible; DebrisBrawl/0.1; page-to-terrain game)', accept, 'accept-language': 'en' },
  });
}

function send(url, addr, { method = 'GET', headers = {}, body = null, timeoutMs }) {
  return new Promise((resolve, reject) => {
    // the socket timeout only catches silence; this also stops headers trickling in a byte at a time
    const deadline = setTimeout(() => req.destroy(new UserError('The site took too long to answer.')), timeoutMs);
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request({
      protocol: url.protocol,
      hostname: url.hostname.replace(/^\[|\]$/g, ''),
      port: url.port || undefined,
      path: url.pathname + url.search,
      method,
      agent: false,
      timeout: timeoutMs,
      headers: { ...headers, 'accept-encoding': 'gzip, deflate, br' },
      // connect to the address we already checked, never a fresh DNS answer
      lookup: (_h, opts, cb) => (opts && opts.all ? cb(null, [{ address: addr.address, family: addr.family }]) : cb(null, addr.address, addr.family)),
    }, (res) => { clearTimeout(deadline); resolve(res); });
    req.on('timeout', () => req.destroy(new UserError('The site took too long to answer.')));
    req.on('error', (e) => clearTimeout(deadline) || reject(e instanceof UserError ? e : new UserError("Couldn't reach that site.")));
    req.end(body ?? undefined);
  });
}

// A page's own request headers go along as the browser sent them (its auth tokens included: they're the
// site's, for the host the page asked, in a throwaway browser session), minus the connection-level ones.
const DONT_FORWARD = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'keep-alive',
  'accept-encoding', 'proxy-authorization', 'proxy-connection', 'expect']);
const DROP_BACK = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'keep-alive', 'alt-svc', 'strict-transport-security']);

// One request on behalf of the headless browser (server/render.js), under the same rules as everything
// else: public addresses only, the checked address is the one we connect to, capped size and time.
// Redirects go back to the browser, which asks again (and so gets checked again).
// For other kinds of connection (the headless browser's WebSockets): a checked, public address to pin to.
export async function checkedAddress(raw) {
  const url = parseTarget(raw);
  return { url, addr: await resolvePublic(url.hostname) };
}

export async function proxyFetch(raw, { method = 'GET', headers = {}, body = null, maxBytes = 8_000_000, timeoutMs = 10000 } = {}) {
  if (!['GET', 'HEAD', 'POST', 'OPTIONS'].includes(method)) throw new UserError('Method not allowed.');
  const url = parseTarget(raw);
  const addr = await resolvePublic(url.hostname);
  const out = {};
  for (const [k, v] of Object.entries(headers)) if (!DONT_FORWARD.has(k.toLowerCase()) && !k.startsWith(':') && v !== undefined) out[k] = String(v);
  if (body && body.length > 1_000_000) throw new UserError('Request too big.');
  const res = await send(url, addr, { method, headers: out, body, timeoutMs });
  const back = {};
  for (const [k, v] of Object.entries(res.headers)) if (!DROP_BACK.has(k)) back[k] = Array.isArray(v) ? v.join('\n') : String(v);
  const noBody = method === 'HEAD' || res.statusCode === 204 || res.statusCode === 304 || (res.statusCode >= 300 && res.statusCode < 400);
  const buf = noBody ? (res.destroy(), Buffer.alloc(0)) : await readCapped(res, maxBytes, timeoutMs);
  return { status: res.statusCode, headers: back, body: buf };
}

function readCapped(res, max, timeoutMs) {
  return new Promise((resolve, reject) => {
    const enc = String(res.headers['content-encoding'] || '').trim().toLowerCase();
    let stream = res;
    if (enc === 'gzip' || enc === 'x-gzip') stream = res.pipe(zlib.createGunzip());
    else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
    else if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress());
    else if (enc && enc !== 'identity') { res.destroy(); reject(new UserError('The site sent something we cannot read.')); return; }
    const chunks = [];
    let n = 0, done = false;
    const fail = (e) => { if (done) return; done = true; clearTimeout(timer); res.destroy(); if (stream !== res) stream.destroy(); reject(e); };
    const timer = setTimeout(() => fail(new UserError('The site took too long to answer.')), timeoutMs);
    stream.on('data', (c) => {
      n += c.length; // counts decompressed bytes, so a zip bomb stops here too
      if (n > max) fail(new UserError('That page is too big.'));
      else chunks.push(c);
    });
    stream.on('end', () => { if (done) return; done = true; clearTimeout(timer); resolve(Buffer.concat(chunks)); });
    stream.on('error', () => fail(new UserError("Couldn't read what the site sent.")));
    res.on('error', () => fail(new UserError("Couldn't read what the site sent.")));
  });
}

export async function fetchSafe(raw, { accept, types, maxBytes, timeoutMs = 10000, maxRedirects = 4 }) {
  let url = parseTarget(raw);
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const addr = await resolvePublic(url.hostname);
    const res = await request(url, addr, accept, timeoutMs);
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      res.destroy();
      url = parseTarget(new URL(res.headers.location, url).href); // every hop gets checked again
      continue;
    }
    if (res.statusCode !== 200) { res.destroy(); throw new UserError(`The site answered with an error (${res.statusCode}).`); }
    const ctype = String(res.headers['content-type'] || '');
    const type = ctype.split(';')[0].trim().toLowerCase();
    if (!types.includes(type)) { res.destroy(); throw new UserError(`That address isn't a web page (${type || 'unknown type'}).`); }
    const body = await readCapped(res, maxBytes, timeoutMs);
    return { body, url: url.href, type, charset: /charset=["']?([\w-]+)/i.exec(ctype)?.[1] };
  }
  throw new UserError('That address redirects too many times.');
}

const attr = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

// The browser lays this out in a sandboxed iframe with scripts off; stripping them here is a second lock.
export function cleanHtml(html, base) {
  const s = html
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<script\b[^>]*>/gi, '')
    .replace(/<\/?(iframe|frame|frameset|object|embed|applet|portal|base|audio|source|track)\b[^>]*>/gi, '')
    .replace(/<meta\b[^>]*http-equiv[^>]*>/gi, '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    // `crossorigin` / `integrity` make the browser demand CORS headers the site only sends to itself,
    // which blocks its stylesheets when laid out here; plain links load fine (scripts stay off regardless)
    .replace(/\s(crossorigin|integrity)(\s*=\s*("[^"]*"|'[^']*'|[^\s>]+))?(?=[\s/>])/gi, '')
    .replace(/(href|src|action|formaction)\s*=\s*(["']?)\s*javascript:/gi, '$1=$2about:blank#');
  const tag = `<base href="${attr(base)}">`;
  return /<head\b[^>]*>/i.test(s) ? s.replace(/<head\b[^>]*>/i, (h) => h + tag) : tag + s;
}

export async function fetchPage(raw) {
  const r = await fetchSafe(raw, { accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1', types: ['text/html', 'application/xhtml+xml'], maxBytes: 3_000_000 });
  let html;
  try { html = new TextDecoder(r.charset || 'utf-8').decode(r.body); } catch { html = new TextDecoder().decode(r.body); }
  return { html: cleanHtml(html, r.url), finalUrl: r.url };
}

// SVG is allowed because so many logos and icons are SVG. Opened directly from our origin an SVG could
// run script, so /api/asset always answers with `Content-Security-Policy: sandbox` (see server/index.js).
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp', 'image/x-icon', 'image/vnd.microsoft.icon', 'image/svg+xml'];

export async function fetchImage(raw) {
  const r = await fetchSafe(raw, { accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif;q=0.9', types: IMAGE_TYPES, maxBytes: 4_000_000, timeoutMs: 8000, maxRedirects: 3 });
  return { body: r.body, type: r.type };
}
