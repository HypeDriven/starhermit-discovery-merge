// Sound, as the browser build's src/audio.js: the authored one-shots
// (sfx/<name>.opus, sfx/manifest.txt) per game event, the quiet filtered-
// noise ambience bed looping under a round, and the slow seeded minor-
// pentatonic music (a sine note every 620 ms, now and then an octave up).
//
// The browser build's three buses become the runtime's (Options › Audio owns
// the volumes, the mute and the voice limit): music → "music", the effects
// and the ambience bed → "effects"; the old default bus levels (music 60 % ×
// 0.5, effects 80 %, ambience 50 % × 0.35) are folded into each sound's gain.
// The bed and the music's notes are rendered once offline in onStart with the
// old filter and oscillator envelope; the synthesized stand-ins the browser
// build played while a clip decoded are not ported, so a clip still loading is
// silent. Every clip loads at once in onStart; the bed and the music start once
// the mixer runs (in a browser, after the first press).
import { context, createClip, loadClip, OfflineAudioContext, play as playClip, type AudioClip, type Sound } from "starhermit:audio";
import { createRng, rngNext } from "../src/engine/rng.js";

const LEVEL = { music: 0.6 * 0.5, effects: 0.8, ambience: 0.5 * 0.35 };
/** The bed before its bus level, make-up to the old renderer's rms 0.0370 (±0.3 noise, RBJ low-pass). */
const BED_GAIN = 0.283;
export type Cue =
  | "tap" | "spawn" | "select" | "move" | "invalid" | "merge" | "discover" | "deliver" | "requestComplete"
  | "win" | "lose" | "undo" | "hint" | "webClear" | "achievement";
const SAMPLES: Record<Cue, string> = {
  tap: "ui-tap", spawn: "item-spawn", select: "ui-select", move: "item-move", invalid: "move-invalid", merge: "merge-success",
  discover: "discovery-sparkle", deliver: "deliver-parcel", requestComplete: "request-complete", win: "win-fanfare",
  lose: "lose-sting", undo: "undo-whoosh", hint: "hint-glimmer", webClear: "web-clear", achievement: "achievement-medal",
};

const clips = new Map<string, AudioClip>();
let suspended = false;

/** Loads every clip at once (onStart); a cue whose clip is still loading is silent. */
export function loadSfx(): void {
  for (const name of new Set(Object.values(SAMPLES))) {
    loadClip(`sfx/${name}.opus`).then((c) => { clips.set(name, c); }, (e: unknown) => console.warn(`sfx ${name}: ${String(e)}`));
  }
  const failed = (e: unknown): void => console.warn(`audio: ${String(e)}`);
  renderBed().catch(failed);
  FREQS.forEach((f, i) => { renderNote(i, f).catch(failed); });
}

/** Plays a cue's sample (once loaded). */
export function cue(name: Cue): void {
  const file = SAMPLES[name];
  const clip = clips.get(file);
  if (!clip || suspended) return;
  try { playClip(clip, { bus: "effects", gain: LEVEL.effects }); }
  catch { /* the mixer is full this frame: skip it */ }
}

// -- the ambience bed and the music -----------------------------------------------------------
const RATE = 22050;
/** src/audio.js _startAmbience: two seconds of seeded white noise through a 320 Hz low-pass, looped (filtered periodic noise is periodic once settled). */
async function renderBed(): Promise<void> {
  const n = RATE * 2, settle = Math.round(0.25 * RATE);
  const off = new OfflineAudioContext(1, settle + n, RATE);
  const noise = off.createNoise({ seed: 7, seconds: 2 });
  const lp = off.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = 320;
  const g = off.createGain();
  g.gain.value = BED_GAIN;
  noise.connect(lp).connect(g).connect(off.destination);
  noise.start();
  const r = await off.startRendering();
  bed = createClip([r.getChannelData(0).slice(settle)], RATE);
}
/** src/audio.js _tone for the music: a sine, 5 ms attack, exponential decay over 0.9 s. */
async function renderNote(index: number, freq: number): Promise<void> {
  const attack = 0.005, decay = 0.9;
  const off = new OfflineAudioContext(1, Math.round((attack + decay + 0.05) * RATE), RATE);
  const osc = off.createOscillator();
  osc.frequency.value = freq;
  const gain = off.createGain();
  gain.gain.setValueAtTime(0, 0);
  gain.gain.linearRampToValueAtTime(1, attack);
  gain.gain.exponentialRampToValueAtTime(0.0001, attack + decay);
  osc.connect(gain).connect(off.destination);
  osc.start();
  const r = await off.startRendering();
  notes.set(index, createClip(r));
}
const SCALE = [0, 3, 5, 7, 10]; // minor pentatonic
const ROOT = 196;
const FREQS = [...SCALE.map((s) => ROOT * Math.pow(2, s / 12)), ...SCALE.map((s) => ROOT * Math.pow(2, (s + 12) / 12))];
const notes = new Map<number, AudioClip>();
const musicRng = createRng(20260819);
let bed: AudioClip | null = null;
let bedSound: Sound | null = null;
let roundOn = false;
let nextStep = 0;

/** The round's ambience and music (src/audio.js started both at the first gesture; here while a board is up). */
export function startRound(): void { roundOn = true; }
export function stopRound(): void {
  roundOn = false;
  if (bedSound) { try { bedSound.stop(); } catch { /* gone */ } }
  bedSound = null;
}
/** Pause and a hidden window: everything holds (src/audio.js setHidden). */
export function setSuspended(on: boolean): void { suspended = on; }

/** Each frame once the mixer runs: the bed, then the music's steps by mixer time. */
export function update(): void {
  if (context.state !== "running") return;
  try {
    const want = roundOn && !suspended;
    if (want && bed && !bedSound) bedSound = playClip(bed, { bus: "effects", gain: LEVEL.ambience, loop: true });
    else if (!want && bedSound) { try { bedSound.stop(); } catch { /* gone */ } bedSound = null; }
  } catch (e) { console.warn(`audio: ${String(e)}`); return; }
  if (!roundOn || suspended) return;
  const now = context.currentTime;
  if (now < nextStep) return;
  nextStep = Math.max(now, nextStep) + 0.62;
  const k = Math.floor(rngNext(musicRng) * SCALE.length) + (rngNext(musicRng) < 0.3 ? SCALE.length : 0);
  const note = notes.get(k);
  try { if (note) playClip(note, { bus: "music", gain: 0.08 * LEVEL.music }); } catch { /* the mixer is full */ }
}
