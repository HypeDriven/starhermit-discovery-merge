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
  // graphics: { preset, render_scale, adaptive, show_fps, <category> } — see gfx.js;
  // absent until first applied so a legacy `quality` value can migrate.
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
    const doc = { ...body, checksum };
    localStorage.setItem(KEY, JSON.stringify(doc));
    if (cloudHook) {
      try { cloudHook(JSON.stringify(doc)); } catch { /* mirror errors never break saves */ }
    }
    return true;
  } catch (e) {
    console.warn('Save store failed:', e);
    return false;
  }
}

// Validates a save document (local cache or cloud slot); null on bad shape,
// version or checksum. Remote-preferred cloud loads go through here.
export function parseSave(json) {
  try {
    const doc = typeof json === 'string' ? JSON.parse(json) : json;
    if (!doc || typeof doc !== 'object') return null;
    const { checksum, ...body } = doc;
    if (hashState(body) !== checksum) return null;
    if (doc.version > SAVE_VERSION) return null;
    const base = freshSave();
    return {
      ...base, ...body, version: SAVE_VERSION,
      settings: { ...base.settings, ...(body.settings || {}) },
      journey: { ...base.journey, ...(body.journey || {}) },
      stats: { ...base.stats, ...(body.stats || {}) },
    };
  } catch {
    return null;
  }
}

// Merge two save documents after a cloud-save conflict (another device wrote
// the slot). Progress only ever grows: journey stages keep the better score,
// dailies OR their completion and keep the higher score, codex tiers and
// lifetime stats take the maximum, achievements keep the earliest unlock,
// lessons and streak days are unions, and the local daily board is a
// de-duplicated union of the last 14 days. Settings stay the local ones.
export function mergeSaves(remote, local) {
  if (!remote) return local;
  if (!local) return remote;
  const base = freshSave();
  const out = { ...base, ...remote, ...local, version: SAVE_VERSION };
  out.settings = { ...base.settings, ...(remote.settings || {}), ...(local.settings || {}) };

  const better = (a, b) => (!a ? b : !b ? a : (b.score > a.score ? b : a));
  const completed = { ...(remote.journey?.completed || {}) };
  for (const [k, v] of Object.entries(local.journey?.completed || {})) completed[k] = better(completed[k], v);
  out.journey = { ...base.journey, ...(remote.journey || {}), ...(local.journey || {}), completed,
    bests: { ...(remote.journey?.bests || {}), ...(local.journey?.bests || {}) } };

  const dailies = { ...(remote.dailies || {}) };
  for (const [d, v] of Object.entries(local.dailies || {})) {
    const r = dailies[d];
    dailies[d] = !r ? v : { ...r, ...v, completed: !!(r.completed || v.completed), score: Math.max(r.score || 0, v.score || 0) };
  }
  out.dailies = dailies;
  out.dailyStreakDays = [...new Set([...(remote.dailyStreakDays || []), ...(local.dailyStreakDays || [])])].sort();

  const codex = { ...(remote.codex || {}) };
  for (const [c, t] of Object.entries(local.codex || {})) codex[c] = Math.max(codex[c] ?? -1, t);
  out.codex = codex;

  const ach = { ...(remote.achievements || {}) };
  for (const [id, at] of Object.entries(local.achievements || {})) ach[id] = !ach[id] || String(at) < String(ach[id]) ? at : ach[id];
  out.achievements = ach;

  const rs = { ...base.stats, ...(remote.stats || {}) }, ls = { ...base.stats, ...(local.stats || {}) };
  out.stats = {
    ...rs, ...ls,
    sessions: Math.max(rs.sessions || 0, ls.sessions || 0),
    merges: Math.max(rs.merges || 0, ls.merges || 0),
    websCleared: Math.max(rs.websCleared || 0, ls.websCleared || 0),
    lessonsDone: { ...(rs.lessonsDone || {}), ...(ls.lessonsDone || {}) },
  };

  const seen = new Set();
  const board = [];
  for (const e of [...(remote.leaderboardLocal || []), ...(local.leaderboardLocal || [])]) {
    const id = [e.date, e.name, e.score, e.moves, e.seconds].join('|');
    if (seen.has(id)) continue;
    seen.add(id); board.push(e);
  }
  const days = [...new Set(board.map((e) => e.date))].sort().slice(-14);
  out.leaderboardLocal = board.filter((e) => days.includes(e.date));
  return out;
}

// The platform adapter registers here to mirror saves to the cloud slot.
let cloudHook = null;
export function setCloudHook(fn) { cloudHook = fn; }

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
