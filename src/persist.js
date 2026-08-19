// Versioned, checksummed local persistence. The save document carries a
// checksum so corruption is detected and falls back to a fresh profile.
// Never stores credentials or launch tokens.

import { hashState } from './engine/rng.js';

export const SAVE_VERSION = 1;
const KEY = 'discovery-merge.save.v1';
const SNAPSHOT_KEY = 'discovery-merge.snapshot.v1';
const GUEST_KEY = 'discovery-merge.guest.v1';

export const DEFAULT_SETTINGS = {
  music: 0.6,
  effects: 0.8,
  ambience: 0.5,
  muted: false,
  reducedMotion: false,
  highContrast: false,
  colorBlind: false,
  largeText: false,
  leftHanded: false,
  domBoard: false, // force the semantic 2D board instead of WebGL
  quality: 'auto', // auto | low | medium | high
  cameraTilt: 'default',
  haptics: true,
  hintsEnabled: true,
};

export const ACHIEVEMENTS = [
  { id: 'first-restore', name: 'First Restoration', desc: 'Complete your first cabinet request board.' },
  { id: 'deep-discovery', name: 'Deep Discovery', desc: 'Create a tier-5 item in any chain.' },
  { id: 'web-clearer', name: 'Web Clearer', desc: 'Merge onto 10 cobwebbed pieces in total.' },
  { id: 'steady-hands', name: 'Steady Hands', desc: 'Complete daily cabinets on 3 different days.' },
  { id: 'mastery-archivist', name: 'Mastery Archivist', desc: 'Complete all 5 journey mastery stages.' },
  { id: 'grand-curator', name: 'Grand Curator', desc: 'Complete all 40 journey stages.' },
];

function freshSave() {
  return {
    version: SAVE_VERSION,
    settings: { ...DEFAULT_SETTINGS },
    journey: { completed: {}, bests: {} }, // index -> {score, moves, seconds}
    dailies: {}, // date -> {score, completed}
    dailyStreakDays: [],
    codex: {}, // chain -> max tier discovered
    achievements: {}, // id -> timestamp
    stats: { sessions: 0, merges: 0, websCleared: 0, lessonsDone: {} },
    leaderboardLocal: [], // casual local board entries
  };
}

export function loadSave() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return freshSave();
    const doc = JSON.parse(raw);
    const { checksum, ...body } = doc;
    if (hashState(body) !== checksum) {
      console.warn('Save checksum mismatch; starting fresh.');
      return freshSave();
    }
    if (doc.version > SAVE_VERSION) return freshSave();
    // Migration point: fill any missing fields from defaults.
    const base = freshSave();
    return {
      ...base, ...body, version: SAVE_VERSION,
      settings: { ...base.settings, ...(body.settings || {}) },
      journey: { ...base.journey, ...(body.journey || {}) },
      stats: { ...base.stats, ...(body.stats || {}) },
    };
  } catch (e) {
    console.warn('Save load failed:', e);
    return freshSave();
  }
}

export function storeSave(save) {
  try {
    const body = { ...save, version: SAVE_VERSION };
    const checksum = hashState(body);
    localStorage.setItem(KEY, JSON.stringify({ ...body, checksum }));
    return true;
  } catch (e) {
    console.warn('Save store failed:', e);
    return false;
  }
}

export function storeSnapshot(json) {
  try { localStorage.setItem(SNAPSHOT_KEY, json); } catch { /* quota */ }
}

export function loadSnapshot() {
  try { return localStorage.getItem(SNAPSHOT_KEY); } catch { return null; }
}

export function clearSnapshot() {
  try { localStorage.removeItem(SNAPSHOT_KEY); } catch { /* ignore */ }
}

export function guestId() {
  try {
    let id = localStorage.getItem(GUEST_KEY);
    if (!id) {
      id = 'guest-' + crypto.getRandomValues(new Uint32Array(2)).join('-');
      localStorage.setItem(GUEST_KEY, id);
    }
    return id;
  } catch {
    return 'guest-anonymous';
  }
}
