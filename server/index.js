// HTTP + WebSocket server: serves the game, fetches pages to wreck, and runs multiplayer rooms.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { fetchPage, fetchImage, parseTarget, UserError } from './fetchPage.js';
import { renderPage, canRender, closeRenderer } from './render.js';
import { Rooms } from './rooms.js';
import { uploadHandler } from './uploads.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MOUNTS = [['/shared/', path.join(ROOT, 'shared')], ['/', path.join(ROOT, 'public')]];
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8',
};

// The fetched page is laid out in a sandboxed iframe that inherits this policy: its scripts never run,
// but its stylesheets, fonts and pictures may load from anywhere so the layout looks right.
const CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline' http: https:",
  "img-src 'self' data: blob: http: https:", "font-src 'self' data: http: https:", "connect-src 'self'",
  "media-src 'none'", "object-src 'none'", "frame-src 'self' about: blob: data:", "base-uri 'self' http: https:",
  "form-action 'none'", "frame-ancestors 'self'",
].join('; ');

// A few page fetches a minute per address is plenty for a game and keeps the proxy from being a free crawler.
function limiter(perMin) {
  const hits = new Map();
  setInterval(() => hits.clear(), 60_000).unref();
  return (ip) => {
    const n = (hits.get(ip) ?? 0) + 1;
    hits.set(ip, n);
    return n <= perMin;
  };
}
const pageLimit = limiter(20), assetLimit = limiter(400);

const json = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(body));
};

async function api(req, res, url) {
  const ip = req.socket.remoteAddress ?? '';
  const target = url.searchParams.get('url');
  try {
    if (url.pathname === '/api/page') {
      if (!pageLimit(ip)) return json(res, 429, { error: 'Too many pages at once. Wait a minute.' });
      // JSON, never text/html: opening this URL directly must not render someone else's page on our origin
      if (url.searchParams.get('js') === '1' && canRender()) {
        parseTarget(target); // bad addresses get the usual answer straight away
        try {
          return json(res, 200, await renderPage(target));
        } catch (e) {
          console.warn('render failed, loading it without its scripts:', target, String(e.message).split('\n')[0]); // the static fetch re-checks everything
        }
      }
      return json(res, 200, await fetchPage(target));
    }
    if (url.pathname === '/api/asset') {
      if (!assetLimit(ip)) return json(res, 429, { error: 'Too many pictures.' });
      const img = await fetchImage(target);
      res.writeHead(200, {
        'content-type': img.type, 'cache-control': 'public, max-age=3600', 'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; sandbox", 'cross-origin-resource-policy': 'same-origin',
      });
      return res.end(img.body);
    }
    if (url.pathname === '/api/health') return json(res, 200, { ok: true });
    return json(res, 404, { error: 'Not found' });
  } catch (e) {
    if (!(e instanceof UserError)) console.error('fetch failed:', target, e);
    return json(res, e instanceof UserError ? 400 : 502, { error: e instanceof UserError ? e.message : "Couldn't load that site." });
  }
}

async function serveStatic(req, res, pathname) {
  let rel;
  try { rel = decodeURIComponent(pathname); } catch { rel = null; }
  for (const [prefix, dir] of MOUNTS) {
    if (!rel || !rel.startsWith(prefix)) continue;
    let sub = rel.slice(prefix.length);
    if (!sub || sub.endsWith('/')) sub += 'index.html';
    const file = path.resolve(dir, sub);
    if (!file.startsWith(dir + path.sep) || sub.includes('\0')) break; // no ../ escapes
    try {
      const data = await fs.readFile(file);
      const ext = path.extname(file);
      const headers = { 'content-type': TYPES[ext] ?? 'application/octet-stream', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'cache-control': 'no-cache' };
      if (ext === '.html') headers['content-security-policy'] = CSP;
      res.writeHead(200, headers);
      return res.end(req.method === 'HEAD' ? undefined : data);
    } catch {
      break;
    }
  }
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('Not found');
}

export function startServer({ port = 8787, host = '0.0.0.0', uploadDir = path.join(ROOT, 'uploads'), uploadsFromLan = false } = {}) {
  const rooms = new Rooms();
  const upload = uploadHandler(uploadDir, { allowLan: uploadsFromLan });
  const server = http.createServer((req, res) => {
    let url;
    try { url = new URL(req.url, 'http://local'); } catch { res.writeHead(400); return res.end(); }
    if (url.pathname === '/api/upload') {
      if (req.method !== 'POST') { res.writeHead(405); return res.end(); }
      return upload(req, res, (code, body) => json(res, code, body));
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    if (url.pathname.startsWith('/api/')) return api(req, res, url);
    return serveStatic(req, res, url.pathname);
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 24 << 20 }); // a map plus two page pictures
  server.on('upgrade', (req, socket, head) => {
    let url;
    try { url = new URL(req.url, 'http://local'); } catch { socket.destroy(); return; }
    // only our own page may open a game socket (stops other sites driving a visitor's browser into rooms)
    const origin = req.headers.origin;
    let sameOrigin = !origin;
    try { if (origin) sameOrigin = new URL(origin).host === req.headers.host; } catch { sameOrigin = false; }
    if (url.pathname !== '/ws' || !sameOrigin) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.isAlive = true;
      ws.on('pong', () => { ws.isAlive = true; });
      rooms.connect(ws, url.searchParams, req.socket.remoteAddress ?? '');
    });
  });
  const ping = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false;
      ws.ping();
    }
  }, 20_000);

  return new Promise((resolve) => {
    server.listen(port, host, () => {
      const close = () => { clearInterval(ping); rooms.close(); wss.close(); server.close(); closeRenderer(); };
      resolve({ server, rooms, port: server.address().port, close });
    });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 8787;
  const host = process.env.HOST || '0.0.0.0';
  startServer({ port, host, uploadDir: process.env.UPLOAD_DIR || undefined, uploadsFromLan: process.env.UPLOADS === 'lan' }).then(({ port: p }) => {
    console.log(`Debris Brawl on http://localhost:${p}  (listening on ${host}; friends on your network can join via your IP)`);
  });
}
