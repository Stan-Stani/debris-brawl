// Menus and the path from "pick a page" to "standing on it with a rocket launcher".
import { ClientGame } from './client.js';
import { WsNet, LocalNet } from './net.js';
import { loadPage, DEMO_MAPS } from './raster.js';
import { packGrid } from './codec.js';
import { Sfx } from './audio.js';
import { imagesIn, sendShot } from './upload.js';

const $ = (id) => document.getElementById(id);
const canvas = $('game');
const sfx = new Sfx();
const store = {
  get: (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

let game = null, net = null, selected = store.get('db:map', 'news'), loadToken = 0;

// ---- screens ----

function show(id) {
  for (const s of ['menu', 'loading', 'pause']) $(s).classList.toggle('hidden', s !== id);
  document.body.classList.toggle('playing', !id || id === 'pause');
}

function menuError(msg) {
  show('menu');
  $('menuerr').textContent = msg || '';
}

function progress(msg, k) {
  $('loadmsg').textContent = msg;
  $('loadbar').style.width = `${Math.round(k * 100)}%`;
}

function playerName() {
  const n = $('name').value.trim().slice(0, 16) || `Player${Math.floor(Math.random() * 900 + 100)}`;
  $('name').value = n;
  store.set('db:name', n);
  return n;
}

// What the player picked: an address if they typed one, else the highlighted built-in page.
function chosenSource(urlInput) {
  const url = urlInput.value.trim();
  return url ? { kind: 'url', url } : { kind: 'map', id: selected };
}

function mapCards(container, onPick) {
  container.textContent = '';
  for (const m of DEMO_MAPS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `map map-${m.id}`;
    b.dataset.id = m.id;
    const name = document.createElement('strong');
    name.textContent = m.name;
    const blurb = document.createElement('span');
    blurb.textContent = m.blurb;
    b.append(name, blurb);
    b.addEventListener('click', () => onPick(m.id));
    container.append(b);
  }
}

function markSelected() {
  for (const el of document.querySelectorAll('.map')) el.classList.toggle('on', el.dataset.id === selected && !$('url').value.trim());
}

// ---- starting a match ----

function leave(msg) {
  loadToken++;
  game?.destroy(); game = null;
  net?.close(); net = null;
  menuError(msg);
}

async function startSolo() {
  sfx.unlock();
  const src = chosenSource($('url')), name = playerName(), bots = Number($('bots').value), token = ++loadToken;
  show('loading');
  try {
    const page = await loadPage(src, progress);
    if (token !== loadToken) return;
    net = new LocalNet(page.grid, { name, bots, mapName: page.name });
    begin(net);
    net.connect((m) => game?.receive(m));
  } catch (e) {
    if (token === loadToken) menuError(e.message);
  }
}

function startOnline(room) {
  sfx.unlock();
  const name = playerName(), token = ++loadToken;
  show('loading');
  progress('Connecting', 0.05);
  net = new WsNet({ room, name });
  net.connect(async (m) => {
    if (token !== loadToken) return;
    if (game) { game.receive(m); return; }
    switch (m.t) {
      case 'needmap': { // we're hosting: build the page and hand it to the server
        const src = m.suggest ? { kind: 'map', id: m.suggest } : chosenSource($('url'));
        try {
          const page = await loadPage(src, progress);
          if (token !== loadToken) return;
          progress('Sending the page to the room', 0.95);
          net.send({ t: 'map', data: await packGrid(page.grid), name: page.name });
        } catch (e) {
          leave(e.message);
        }
        break;
      }
      case 'wait': progress(`Room ${m.code}: waiting for the host to pick a page`, 0.5); break;
      case 'welcome':
        begin(net);
        game.receive(m);
        history.replaceState(null, '', `?room=${m.code}`);
        break;
      case 'maperror': leave(m.msg); break;
      case 'error': leave(m.msg); break;
      case 'closed': leave("Couldn't reach the game server. Is it running? (npm start)"); break;
    }
  });
}

function begin(n) {
  game = new ClientGame(canvas, n, {
    sfx,
    togglePause: () => setPause(!game.paused),
    onClosed: (msg) => leave(msg),
    onHost: () => syncPause(),
    onMap: () => { show(null); syncPause(); },
  });
  if (window.location.search.includes('debug=1')) window.__game = game;
}

// ---- pause menu ----

function setPause(on) {
  if (!game) return;
  game.setPaused(on);
  show(on ? 'pause' : null);
  if (on) syncPause();
}

function syncPause() {
  if (!game) return;
  const isHost = game.net.solo || game.host === game.me.id;
  $('hostctl').classList.toggle('hidden', !isHost);
  $('guestnote').classList.toggle('hidden', isHost);
  $('copy').classList.toggle('hidden', !game.code);
  $('roominfo').textContent = game.code ? `Room ${game.code} · ${game.players.size} in the fight` : 'Solo · the match is paused';
  $('sound').checked = sfx.on;
}

async function changeMap(src) {
  if (!game) return;
  const token = ++loadToken, g = game;
  show('loading');
  try {
    const page = await loadPage(src, progress);
    if (token !== loadToken || g !== game) return;
    if (net.solo) net.loadMap(page.grid, page.name);
    else {
      progress('Sending the page to the room', 0.95);
      net.send({ t: 'map', data: await packGrid(page.grid), name: page.name });
    }
    game.setPaused(false);
    show(null);
  } catch (e) {
    if (token !== loadToken) return;
    show('pause');
    $('pauseerr').textContent = e.message;
  }
}

// ---- wiring ----

$('name').value = store.get('db:name', '');
mapCards($('maps'), (id) => { selected = id; store.set('db:map', id); $('url').value = ''; markSelected(); });
mapCards($('maps2'), (id) => changeMap({ kind: 'map', id }));
markSelected();
$('url').addEventListener('input', markSelected);
$('addr').addEventListener('submit', (e) => { e.preventDefault(); startSolo(); });
$('solo').addEventListener('click', startSolo);
$('quick').addEventListener('click', () => startOnline('quick'));
$('create').addEventListener('click', () => startOnline('new'));
$('join').addEventListener('click', () => {
  const code = $('code').value.trim().toUpperCase();
  if (!/^[A-Z0-9]{6}$/.test(code)) { $('menuerr').textContent = 'Room codes are 6 letters and numbers.'; return; }
  startOnline(code);
});
$('code').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('join').click(); });
$('loadcancel').addEventListener('click', () => leave(''));
$('resume').addEventListener('click', () => setPause(false));
$('leave').addEventListener('click', () => { history.replaceState(null, '', location.pathname); leave(''); });
$('copy').addEventListener('click', async () => {
  const link = `${location.origin}/?room=${game.code}`;
  try { await navigator.clipboard.writeText(link); $('copy').textContent = 'Copied!'; } catch { $('copy').textContent = link; }
  setTimeout(() => { $('copy').textContent = 'Copy invite link'; }, 2000);
});
$('loadurl').addEventListener('click', () => { if ($('url2').value.trim()) changeMap({ kind: 'url', url: $('url2').value }); });
$('url2').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('loadurl').click(); });
$('botadd').addEventListener('click', () => game?.net.send({ t: 'bot', add: true }));
$('botdel').addEventListener('click', () => game?.net.send({ t: 'bot', add: false }));
$('sound').addEventListener('change', (e) => sfx.setOn(e.target.checked));
window.addEventListener('keydown', (e) => {
  if (e.code === 'Escape' && !$('pause').classList.contains('hidden')) { e.stopImmediatePropagation(); setPause(false); }
}, true);

// a screenshot pasted on the menu goes straight to uploads/ (the share page has drag and drop too)
document.addEventListener('paste', async (e) => {
  if ($('menu').classList.contains('hidden')) return;
  const files = imagesIn(e.clipboardData);
  if (!files.length) return;
  e.preventDefault();
  for (const f of files) {
    $('menuerr').textContent = 'Sending screenshot…';
    try { $('menuerr').textContent = `Screenshot saved as uploads/${(await sendShot(f)).name}`; } catch (err) { $('menuerr').textContent = err.message; }
  }
});

const params = new URLSearchParams(location.search);
const invite = params.get('room');
if (invite && /^[A-Za-z0-9]{6}$/.test(invite)) {
  $('code').value = invite.toUpperCase();
  $('menuerr').textContent = `You're invited to room ${invite.toUpperCase()}. Pick a name and press Join.`;
  $('join').classList.add('primary');
}
if (matchMedia('(pointer: coarse)').matches && !matchMedia('(pointer: fine)').matches) {
  $('menuerr').textContent = 'Debris Brawl needs a keyboard and mouse for now.';
}
show('menu');
