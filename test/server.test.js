import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { WebSocket } from 'ws';
import { startServer } from '../server/index.js';
import { testGrid } from './helpers.js';
import { packGrid } from '../server/rooms.js';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63f8cfc0f01f0005000201a5e3b5a40000000049454e44ae426082', 'hex');

function request(port, { method = 'GET', path: p = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const rawGet = (port, line) => new Promise((resolve) => {
  const s = net.connect(port, '127.0.0.1', () => s.write(`${line}\r\nHost: x\r\n\r\n`));
  s.on('data', () => s.destroy());
  s.on('close', resolve);
  s.on('error', resolve);
});

async function withServer(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-up-'));
  const srv = await startServer({ port: 0, host: '127.0.0.1', uploadDir: dir });
  try { await fn(srv.port, dir); } finally { srv.close(); fs.rmSync(dir, { recursive: true, force: true }); }
}

const health = async (port) => (await request(port, { path: '/api/health' })).status;

test('malformed request targets do not crash the server', () => withServer(async (port) => {
  await rawGet(port, 'GET // HTTP/1.1');
  await rawGet(port, 'GET http://[::1 HTTP/1.1');
  assert.equal(await health(port), 200);
}));

test('static files cannot escape the public folder', () => withServer(async (port) => {
  for (const p of ['/../package.json', '/%2e%2e/package.json', '/shared/../server/index.js', '/%2e%2e%2fserver/index.js']) {
    const r = await request(port, { path: p });
    assert.notEqual(r.status, 200, p);
  }
  assert.equal((await request(port, { path: '/shared/const.js' })).status, 200);
}));

test('hostile game messages do not crash the server', () => withServer(async (port) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?room=new&name=Eve`);
  const welcome = new Promise((resolve) => ws.on('message', (d) => { if (JSON.parse(d).t === 'welcome') resolve(); }));
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ t: 'map', data: packGrid(testGrid()), name: { toString: 0 } }));
  await welcome;
  await new Promise((r) => setTimeout(r, 700)); // spawned
  const evil = { toString: 0, valueOf: 0 };
  for (const m of [
    { t: 's', life: 1, x: 10, y: 10, w: evil, fl: evil }, { t: 'f', w: evil, a: [0] }, { t: 'f', w: 0, a: [evil] },
    { t: 'th', a: evil, p: evil }, { t: 'g', a: evil }, { t: 'bot', add: evil }, { t: evil }, [1, 2], 'x', null,
  ]) ws.send(JSON.stringify(m));
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(await health(port), 200);
  ws.close();
}));

test('screenshots upload from our own page on this computer', () => withServer(async (port, dir) => {
  const ok = await request(port, { method: 'POST', path: '/api/upload', body: PNG, headers: { origin: `http://127.0.0.1:${port}`, host: `127.0.0.1:${port}`, 'x-debris-upload': '1', 'x-note': encodeURIComponent('whole letters ✓'), 'content-type': 'image/png' } });
  assert.equal(ok.status, 200, ok.body);
  const { name } = JSON.parse(ok.body);
  assert.match(name, /^shot-\d{8}-\d{6}-[0-9a-f]{6}\.png$/);
  assert.deepEqual(fs.readFileSync(path.join(dir, name)), PNG);
  assert.equal(fs.readFileSync(path.join(dir, `${name}.txt`), 'utf8'), 'whole letters ✓\n');
}));

test('uploads refuse other sites, non-pictures and huge files', () => withServer(async (port, dir) => {
  const base = { method: 'POST', path: '/api/upload', headers: { origin: `http://127.0.0.1:${port}`, host: `127.0.0.1:${port}`, 'x-debris-upload': '1' } };
  const cases = [
    [{ ...base, body: PNG, headers: { ...base.headers, origin: 'https://evil.example' } }, 403],
    [{ ...base, body: PNG, headers: { ...base.headers, 'x-debris-upload': undefined } }, 403],
    [{ ...base, body: '<svg onload=alert(1)>', headers: { ...base.headers, 'content-type': 'image/png' } }, 415],
    [{ ...base, body: Buffer.alloc(16 << 20, 1) }, 413],
    [{ ...base, method: 'GET' }, 405],
  ];
  for (const [opts, want] of cases) {
    for (const k of Object.keys(opts.headers)) if (opts.headers[k] === undefined) delete opts.headers[k];
    const r = await request(port, opts).catch(() => ({ status: 413 })); // a 413 may close the socket mid-send
    assert.equal(r.status, want, JSON.stringify(opts.headers));
  }
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.startsWith('shot-')), []);
  assert.equal(await health(port), 200);
}));
