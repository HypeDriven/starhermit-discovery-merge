// Sound, as the browser build's src/audio.js: the authored one-shots
// (sfx/<name>.opus, sfx/manifest.txt) per game event, the quiet filtered-
// noise ambience bed looping under a round, and the slow seeded minor-
// pentatonic music (a sine note every 620 ms, now and then an octave up).
//
// The browser build's three buses become the runtime's (Options › Audio owns
// the volumes, the mute and the voice limit): music → "music", the effects
// and the ambience bed → "effects"; the old default bus levels (music 60 % ×
// 0.5, effects 80 %, ambience 50 % × 0.35) are folded into each sound's gain.
// The bed and the music's notes are rendered once into clips (createClip)
// with the old filter and oscillator envelope; the synthesized stand-ins the
// browser build played while a clip decoded are not ported (a live synthesis
// graph makes clip loads fail on the engine's web runtime; the arrow-exodus
// port's finding), so a clip still loading is silent. Clips load once the
// mixer runs (natively at once, in a browser after the first press), one at
// a time.
import { context, createClip, loadClip, play as playClip, type AudioClip, type Sound } from "starhermit:audio";
import { createRng, rngNext } from "../src/engine/rng.js";

const LEVEL = { music: 0.6 * 0.5, effects: 0.8, ambience: 0.5 * 0.35 };
export type Cue =
  | "tap" | "spawn" | "select" | "move" | "invalid" | "merge" | "discover" | "deliver" | "requestComplete"
  | "win" | "lose" | "undo" | "hint" | "webClear" | "achievement";
const SAMPLES: Record<Cue, string> = {
  tap: "ui-tap", spawn: "item-spawn", select: "ui-select", move: "item-move", invalid: "move-invalid", merge: "merge-success",
  discover: "discovery-sparkle", deliver: "deliver-parcel", requestComplete: "request-complete", win: "win-fanfare",
  lose: "lose-sting", undo: "undo-whoosh", hint: "hint-glimmer", webClear: "web-clear", achievement: "achievement-medal",
};

const clips = new Map<string, AudioClip>();
const queue: string[] = [];
let loading = false;
let wantClips = false;
let suspended = false;

function load(name: string): void { if (!queue.includes(name) && !clips.has(name)) queue.push(name); }
function pump(): void {
  if (loading || !queue.length) return;
  const name = queue.shift()!;
  loading = true;
  loadClip(`sfx/${name}.opus`).then((c) => { clips.set(name, c); loading = false; }, (e: unknown) => { console.warn(`sfx ${name}: ${String(e)}`); loading = false; });
}
/** Asks for the clips; they load once the mixer runs (see update). */
export function loadSfx(): void { wantClips = true; }

/** Plays a cue's sample (once loaded). */
export function cue(name: Cue): void {
  const file = SAMPLES[name];
  const clip = clips.get(file);
  if (!clip || suspended) return;
  try { playClip(clip, { bus: "effects", gain: LEVEL.effects }); }
  catch { clips.delete(file); load(file); } // a clip the mixer lost: load it again
}

// -- the ambience bed and the music -----------------------------------------------------------
const RATE = 22050;
/** src/audio.js _startAmbience: two seconds of seeded noise (±0.3) through a 320 Hz low-pass, looped. */
function ambienceClip(): AudioClip {
  const n = RATE * 2;
  const out = new Float32Array(n);
  const rng = createRng(7);
  // RBJ biquad low-pass, Q 1 (the Web Audio BiquadFilterNode default).
  const w = (2 * Math.PI * 320) / RATE, alpha = Math.sin(w) / 2, cw = Math.cos(w);
  const a0 = 1 + alpha, b0 = (1 - cw) / 2 / a0, b1 = (1 - cw) / a0, b2 = b0, a1 = (-2 * cw) / a0, a2 = (1 - alpha) / a0;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let pass = 0; pass < 2; pass++) { // a first pass settles the filter so the loop has no click
    for (let i = 0; i < n; i++) {
      const x = (rngNext(rng) * 2 - 1) * 0.3;
      const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1; x1 = x; y2 = y1; y1 = y;
      if (pass) out[i] = y;
    }
  }
  // A short crossfade at the seam.
  const fade = 400;
  for (let i = 0; i < fade; i++) out[i] = out[i]! * (i / fade) + out[n - fade + i]! * (1 - i / fade);
  return createClip([out.subarray(0, n - fade)], RATE);
}
/** src/audio.js _tone for the music: a sine, 5 ms attack, exponential decay over 0.9 s. */
function noteClip(freq: number): AudioClip {
  const attack = 0.005, decay = 0.9;
  const n = Math.round((attack + decay + 0.05) * RATE);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    const env = t < attack ? t / attack : Math.pow(0.0001, Math.min(1, (t - attack) / decay));
    out[i] = Math.sin(2 * Math.PI * freq * t) * env;
  }
  return createClip([out], RATE);
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
let nextRender = 0;

/** The round's ambience and music (src/audio.js started both at the first gesture; here while a board is up). */
export function startRound(): void { roundOn = true; }
export function stopRound(): void {
  roundOn = false;
  if (bedSound) { try { bedSound.stop(); } catch { /* gone */ } }
  bedSound = null;
}
/** Pause and a hidden window: everything holds (src/audio.js setHidden). */
export function setSuspended(on: boolean): void { suspended = on; }

/** Each frame: the clips once the mixer runs (one at a time), the bed and the
 * notes rendered one each 0.3 s after them, the bed, then the music's steps by mixer time. */
export function update(): void {
  if (context.state !== "running") return;
  if (wantClips) {
    wantClips = false;
    for (const name of Object.values(SAMPLES)) load(name);
    return;
  }
  pump();
  if (loading || queue.length) return;
  try {
    if (context.currentTime >= nextRender) {
      if (!bed) { bed = ambienceClip(); nextRender = context.currentTime + 0.3; return; }
      for (let i = 0; i < FREQS.length; i++) {
        if (!notes.has(i)) { notes.set(i, noteClip(FREQS[i]!)); nextRender = context.currentTime + 0.3; return; }
      }
    }
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
