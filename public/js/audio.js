// Every sound is synthesised on the spot: no audio files to load.
export class Sfx {
  constructor() {
    this.ctx = null;
    try { this.on = localStorage.getItem('db:sound') !== 'off'; } catch { this.on = true; }
  }

  unlock() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.45;
    this.master.connect(this.ctx.destination);
    const len = this.ctx.sampleRate;
    this.noiseBuf = this.ctx.createBuffer(1, len, len);
    const d = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  }

  setOn(on) {
    this.on = on;
    try { localStorage.setItem('db:sound', on ? 'on' : 'off'); } catch { /* private mode */ }
  }

  play(name, vol = 1, pan = 0) {
    if (!this.on || !this.ctx || vol <= 0.02) return;
    SOUNDS[name]?.(this, Math.min(1, vol), Math.max(-1, Math.min(1, pan)));
  }

  out(vol, pan) {
    const g = this.ctx.createGain();
    g.gain.value = vol;
    if (pan && this.ctx.createStereoPanner) {
      const p = this.ctx.createStereoPanner();
      p.pan.value = pan;
      g.connect(p).connect(this.master);
    } else g.connect(this.master);
    return g;
  }

  tone(type, f0, f1, dur, vol, pan, delay = 0) {
    const t = this.ctx.currentTime + delay, o = this.ctx.createOscillator(), g = this.out(0, pan);
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g);
    o.start(t); o.stop(t + dur + 0.02);
  }

  noise(dur, f0, f1, q, vol, pan, kind = 'bandpass') {
    const t = this.ctx.currentTime, s = this.ctx.createBufferSource(), f = this.ctx.createBiquadFilter(), g = this.out(0, pan);
    s.buffer = this.noiseBuf;
    f.type = kind; f.Q.value = q;
    f.frequency.setValueAtTime(f0, t);
    f.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    s.connect(f).connect(g);
    s.start(t, Math.random() * 0.5); s.stop(t + dur + 0.02);
  }
}

const SOUNDS = {
  pistol: (s, v, p) => { s.noise(0.09, 2600, 700, 0.8, 0.55 * v, p); s.tone('square', 520, 110, 0.06, 0.12 * v, p); },
  smg: (s, v, p) => { s.noise(0.06, 3200, 1200, 0.7, 0.35 * v, p); },
  shotgun: (s, v, p) => { s.noise(0.25, 1500, 250, 0.6, 0.9 * v, p); s.tone('sine', 110, 40, 0.18, 0.5 * v, p); },
  rocket: (s, v, p) => { s.noise(0.45, 500, 2200, 1.4, 0.4 * v, p); },
  rail: (s, v, p) => { s.tone('sawtooth', 2200, 160, 0.4, 0.22 * v, p); s.noise(0.12, 5000, 2000, 0.5, 0.3 * v, p); },
  boom: (s, v, p) => { s.noise(0.8, 1000, 50, 0.4, 1.0 * v, p, 'lowpass'); s.tone('sine', 90, 28, 0.6, 0.8 * v, p); },
  nade: (s, v, p) => { s.tone('triangle', 520, 300, 0.07, 0.25 * v, p); },
  throw: (s, v, p) => { s.noise(0.28, 280, 1500, 1.3, 0.45 * v, p); },
  crunch: (s, v, p) => { s.noise(0.3, 1300, 160, 0.6, 0.9 * v, p); s.tone('square', 170, 45, 0.2, 0.35 * v, p); },
  thud: (s, v, p) => { s.noise(0.12, 500, 120, 0.8, 0.4 * v, p); },
  grab: (s, v, p) => { s.tone('triangle', 260, 720, 0.1, 0.35 * v, p); s.noise(0.08, 900, 400, 0.8, 0.2 * v, p); },
  nograb: (s, v, p) => { s.tone('square', 190, 140, 0.13, 0.15 * v, p); },
  jump: (s, v, p) => { s.tone('sine', 300, 540, 0.08, 0.12 * v, p); },
  flip: (s, v, p) => { s.tone('sine', 420, 980, 0.11, 0.12 * v, p); },
  land: (s, v, p) => { s.noise(0.05, 420, 200, 0.8, 0.12 * v, p); },
  hurt: (s, v, p) => { s.tone('sawtooth', 230, 80, 0.16, 0.3 * v, p); },
  hitmark: (s, v) => { s.tone('square', 1500, 1400, 0.035, 0.1 * v, 0); },
  kill: (s, v) => { s.tone('square', 520, 520, 0.08, 0.14 * v, 0); s.tone('square', 780, 780, 0.12, 0.14 * v, 0, 0.08); },
  die: (s, v) => { s.tone('sawtooth', 400, 60, 0.5, 0.3 * v, 0); },
  spawn: (s, v) => { s.tone('sine', 200, 640, 0.25, 0.2 * v, 0); },
  end: (s, v) => { s.tone('triangle', 660, 660, 0.15, 0.2 * v, 0); s.tone('triangle', 880, 880, 0.3, 0.2 * v, 0, 0.15); },
};
