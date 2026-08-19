// Seeded deterministic random streams (mulberry32). Serializable state so
// replays and daily sessions reproduce exactly.

export function hashString(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function createRng(seed) {
  return { state: (seed >>> 0) || 1 };
}

export function rngNext(rng) {
  // mulberry32
  rng.state = (rng.state + 0x6d2b79f5) >>> 0;
  let t = rng.state;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export function rngInt(rng, min, maxInclusive) {
  return min + Math.floor(rngNext(rng) * (maxInclusive - min + 1));
}

export function rngPick(rng, arr) {
  return arr[Math.floor(rngNext(rng) * arr.length)];
}

export function cloneRng(rng) {
  return { state: rng.state >>> 0 };
}

// Stable FNV-ish hash of a JSON-serializable value (for replay checksums).
export function hashState(value) {
  const s = stableStringify(value);
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
}
