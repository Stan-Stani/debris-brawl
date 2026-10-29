// Two ways to reach a match: a WebSocket to the server, or (solo) the same Game ticking in this tab.
import { Game } from '/shared/game.js';
import { TICK, NET_TICKS } from '/shared/const.js';

export class WsNet {
  constructor(params) { this.params = params; this.handler = () => {}; this.ws = null; }

  connect(handler) {
    this.handler = handler;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = this.ws = new WebSocket(`${proto}://${location.host}/ws?${new URLSearchParams(this.params)}`);
    ws.onmessage = (e) => {
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      this.handler(m);
    };
    ws.onclose = () => this.handler({ t: 'closed' });
  }

  send(m) { if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(m)); }

  close() {
    if (!this.ws) return;
    this.ws.onclose = null;
    this.ws.close();
  }
}

export class LocalNet {
  constructor(grid, { name, bots, mapName, look, scenery }) {
    this.grid = grid; this.name = name; this.bots = bots; this.mapName = mapName; this.look = look; this.scenery = scenery;
    this.paused = false; this.solo = true;
  }

  connect(handler) {
    this.handler = handler;
    const g = this.game = new Game(this.grid.clone(), { timed: false });
    for (let i = 0; i < this.bots; i++) g.addBot();
    this.me = g.addPlayer(this.name).id;
    handler({ t: 'welcome', code: null, host: this.me, grid: this.grid.clone(), terrain: this.look, scenery: this.scenery, mapName: this.mapName, ...g.welcome(this.me) });
    let last = performance.now(), acc = 0, n = 0;
    this.timer = setInterval(() => {
      const now = performance.now();
      acc = Math.min(acc + (now - last) / 1000, 0.25);
      last = now;
      if (this.paused) { acc = 0; return; }
      while (acc >= TICK) {
        acc -= TICK;
        g.step(TICK);
        if (++n % NET_TICKS === 0) this.flush();
      }
    }, 5);
  }

  flush() {
    const g = this.game;
    if (g.needsReload) {
      g.needsReload = false;
      this.handler({ t: 'reload', grid: g.grid.clone(), terrain: this.look, scenery: this.scenery, mapName: this.mapName, host: this.me, ...g.welcome(this.me) });
    }
    this.handler(g.flush());
  }

  send(m) {
    if (m.t === 'bot') { if (m.add) this.game.addBot(); else this.game.removeBot(); return; }
    this.game.handle(this.me, m);
  }

  loadMap(grid, mapName, look, scenery) {
    this.grid = grid; this.mapName = mapName; this.look = look; this.scenery = scenery;
    this.game.loadMap(grid.clone());
  }

  close() { clearInterval(this.timer); }
}
