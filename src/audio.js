// Audio: original synthesized transients on Web Audio buses (music, effects,
// ambience) with independent volume sliders, focus/background muting, and
// seeded pitch variants so replays sound consistent.

import { createRng, rngNext } from './engine/rng.js';

export class AudioEngine {
  constructor(settings) {
    this.settings = settings;
    this.ctx = null;
    this.buses = {};
    this.rng = createRng(20260819);
    this._musicTimer = null;
    this._ambientNodes = null;
    this._unlocked = false;
  }

  _ensure() {
    if (this.ctx) return true;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    this.ctx = new AC();
    const master = this.ctx.createGain();
    master.connect(this.ctx.destination);
    this.master = master;
    for (const bus of ['music', 'effects', 'ambience']) {
      const g = this.ctx.createGain();
      g.connect(master);
      this.buses[bus] = g;
    }
    this.applyVolumes();
    return true;
  }

  // Must be called from a user gesture once.
  unlock() {
    if (!this._ensure()) return;
    if (this.ctx.state === 'suspended') this.ctx.resume();
    if (!this._unlocked) {
      this._unlocked = true;
      this._startAmbience();
      this._startMusic();
    }
  }

  applyVolumes() {
    if (!this.ctx) return;
    const s = this.settings;
    this.master.gain.value = s.muted ? 0 : 1;
    this.buses.music.gain.value = s.music * 0.5;
    this.buses.effects.gain.value = s.effects;
    this.buses.ambience.gain.value = s.ambience * 0.35;
  }

  setHidden(hidden) {
    if (!this.ctx) return;
    // Background tabs: silence but keep the graph alive.
    this.master.gain.value = hidden || this.settings.muted ? 0 : 1;
  }

  _tone({ freq = 440, type = 'sine', attack = 0.005, decay = 0.18, gain = 0.2, bus = 'effects', slide = 0 }) {
    if (!this.ctx || this.settings.muted) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (slide) osc.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), t + decay);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
    osc.connect(g).connect(this.buses[bus]);
    osc.start(t);
    osc.stop(t + attack + decay + 0.05);
  }

  _variant() {
    // Seeded pitch wobble: deterministic across identical replays.
    return 0.94 + rngNext(this.rng) * 0.12;
  }

  // Event → sound mapping --------------------------------------------------

  tap() { this._tone({ freq: 520 * this._variant(), type: 'triangle', decay: 0.09, gain: 0.18 }); }
  spawn() { this._tone({ freq: 340 * this._variant(), type: 'triangle', decay: 0.12, gain: 0.15, slide: 80 }); }
  select() { this._tone({ freq: 660, type: 'sine', decay: 0.06, gain: 0.1 }); }
  move() { this._tone({ freq: 260 * this._variant(), type: 'sine', decay: 0.1, gain: 0.12 }); }
  invalid() { this._tone({ freq: 140, type: 'sawtooth', decay: 0.16, gain: 0.1 }); }

  merge(tier = 1) {
    const base = 300 * Math.pow(1.2, tier);
    this._tone({ freq: base * this._variant(), type: 'triangle', decay: 0.22, gain: 0.22, slide: base * 0.5 });
    this._tone({ freq: base * 1.5, type: 'sine', decay: 0.3, gain: 0.12 });
  }

  discover() {
    const base = 500;
    [0, 4, 7].forEach((semi, i) => {
      setTimeout(() => this._tone({
        freq: base * Math.pow(2, semi / 12), type: 'sine', decay: 0.4, gain: 0.14,
      }), i * 70);
    });
  }

  deliver() { this._tone({ freq: 440, type: 'triangle', decay: 0.15, gain: 0.2, slide: 220 }); }

  requestComplete() {
    [523, 659, 784].forEach((f, i) => {
      setTimeout(() => this._tone({ freq: f, type: 'triangle', decay: 0.35, gain: 0.18 }), i * 90);
    });
  }

  win() {
    [392, 494, 587, 784].forEach((f, i) => {
      setTimeout(() => this._tone({ freq: f, type: 'triangle', decay: 0.5, gain: 0.2 }), i * 130);
    });
  }

  lose() {
    [330, 277, 220].forEach((f, i) => {
      setTimeout(() => this._tone({ freq: f, type: 'sine', decay: 0.4, gain: 0.15 }), i * 160);
    });
  }

  undo() { this._tone({ freq: 480, type: 'sine', decay: 0.12, gain: 0.12, slide: -160 }); }

  // Quiet ambience: filtered noise bed -------------------------------------

  _startAmbience() {
    if (!this.ctx || this._ambientNodes) return;
    const len = this.ctx.sampleRate * 2;
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    const rng = createRng(7);
    for (let i = 0; i < len; i++) data[i] = (rngNext(rng) * 2 - 1) * 0.3;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const filt = this.ctx.createBiquadFilter();
    filt.type = 'lowpass';
    filt.frequency.value = 320;
    src.connect(filt).connect(this.buses.ambience);
    src.start();
    this._ambientNodes = { src, filt };
  }

  // Adaptive music: a slow seeded arpeggio that brightens with score --------

  _startMusic() {
    if (!this.ctx || this._musicTimer) return;
    const scale = [0, 3, 5, 7, 10]; // minor pentatonic
    const root = 196;
    let stepIdx = 0;
    const tick = () => {
      if (!document.hidden && !this.settings.muted && this.settings.music > 0.01) {
        const semi = scale[Math.floor(rngNext(this.rng) * scale.length)] + (rngNext(this.rng) < 0.3 ? 12 : 0);
        this._tone({
          freq: root * Math.pow(2, semi / 12),
          type: 'sine', decay: 0.9, gain: 0.08, bus: 'music',
        });
      }
      stepIdx++;
    };
    tick();
    this._musicTimer = setInterval(tick, 620);
  }
}
