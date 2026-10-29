import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { policy } from '../server/fetchPage.js';
import { renderPage, canRender, closeRenderer } from '../server/render.js';

// A stand-in for a site that builds its content with JavaScript, and also tries things it mustn't.
const PAGE = `<!doctype html><html><head><title>Auctions</title></head><body>
<h1>Upcoming auctions</h1><div id="list"><div class="skeleton">Loading…</div></div>
<img id="photo" src="/photo.jpg"><span id="status">DISCONNECTED</span>
<script>
  const s = document.createElement('style'); document.head.appendChild(s);
  s.sheet.insertRule('.card { background: rgb(1, 2, 3); }');                 // CSS-in-JS: no text in the tag
  fetch('/api/items').then((r) => r.json()).then((items) => {
    document.getElementById('list').innerHTML = items.map((i) => '<div class="card">' + i + '</div>').join('');
  });
  for (const u of ['http://169.254.169.254/latest/meta-data/', 'http://10.0.0.1/', 'http://localhost:9/']) {
    fetch(u).then((r) => r.text()).then((t) => document.body.insertAdjacentHTML('beforeend', '<p class="leak">' + t + '</p>')).catch(() => {});
  }
  document.getElementById('photo').onerror = (e) => { e.target.src = '/unavailable.jpg'; }; // sites swap in a fallback
  const live = new WebSocket('ws://' + location.host + '/live');
  live.onmessage = (e) => { document.getElementById('status').textContent = e.data; };
</script></body></html>`;

test('a page that builds itself with JavaScript is rendered, and can only reach the public web', { skip: !canRender() && 'no Chrome here' }, async () => {
  let upgrades = 0;
  const srv = http.createServer((req, res) => {
    if (req.url === '/api/items') { res.setHeader('content-type', 'application/json'); return res.end('["Tractor 8R", "Grader 772GP"]'); }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(PAGE);
  });
  const wss = new WebSocketServer({ server: srv });
  wss.on('connection', (ws) => { upgrades++; ws.send('LIVE: 3 BIDDERS'); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  policy.testing = true; // lets the fixture on 127.0.0.1 through; every other private address stays blocked
  try {
    const { html, rendered } = await renderPage(`http://127.0.0.1:${srv.address().port}/`);
    assert.ok(rendered);
    assert.ok(html.includes('Tractor 8R') && html.includes('Grader 772GP'), 'the cards its script fetched are in the snapshot');
    assert.ok(/\.card\s*\{\s*background:\s*rgb\(1, 2, 3\)/.test(html), 'CSS added from script is kept');
    assert.ok(!/<script/i.test(html), 'scripts are stripped from the snapshot');
    assert.ok(!html.includes('class="leak"'), 'private and metadata addresses could not be reached');
    assert.ok(html.includes('/photo.jpg') && !html.includes('unavailable.jpg'), "pictures keep their real address (the page doesn't fall back)");
    assert.equal(upgrades, 1, 'its live connection is relayed');
    assert.ok(html.includes('LIVE: 3 BIDDERS'), 'and what came over it shows');
  } finally {
    policy.testing = false;
    wss.close();
    srv.close();
    await closeRenderer();
  }
});
