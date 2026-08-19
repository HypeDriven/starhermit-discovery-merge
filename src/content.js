// Discovery Merge — versioned content: discovery chains, themes, journey
// levels (40 authored-parameter stages), daily seeds, practice, challenges,
// tutorials, and an offline validator. Pure data + pure functions (node-safe).

import { createRng, rngInt, rngPick, rngNext, hashString } from './engine/rng.js';

export const CONTENT_VERSION = 1;

// ---------------------------------------------------------------------------
// Discovery chains (original content)
// ---------------------------------------------------------------------------

export const CHAINS = {
  tools: {
    name: 'Expedition Tools', color: '#c98f3d',
    tiers: [
      { name: 'Field Brush', icon: '🧹' },
      { name: 'Surveyor’s Pick', icon: '⛏️' },
      { name: 'Brass Lantern', icon: '🏮' },
      { name: 'Wayfinder Compass', icon: '🧭' },
      { name: 'Star Atlas', icon: '🗺️' },
      { name: 'Grand Chronometer', icon: '⏳' },
    ],
  },
  relics: {
    name: 'Sunken Relics', color: '#8d6bc9',
    tiers: [
      { name: 'Clay Shard', icon: '🔶' },
      { name: 'Prayer Beads', icon: '📿' },
      { name: 'Tide Amulet', icon: '🧿' },
      { name: 'Silent Idol', icon: '🗿' },
      { name: 'Ceremonial Mask', icon: '🎭' },
      { name: 'Sunken Crown', icon: '👑' },
    ],
  },
  flora: {
    name: 'Verdant Specimens', color: '#4d9e5f',
    tiers: [
      { name: 'Wild Sprout', icon: '🌱' },
      { name: 'Cabinet Fern', icon: '🌿' },
      { name: 'Lantern Bloom', icon: '🌸' },
      { name: 'Glass Orchid', icon: '🪷' },
      { name: 'Cloud Bonsai', icon: '🎍' },
      { name: 'Worldbloom', icon: '🌳' },
    ],
  },
  curios: {
    name: 'Curious Oddities', color: '#3d8fc9',
    tiers: [
      { name: 'River Pebble', icon: '🪨' },
      { name: 'Ancient Fossil', icon: '🦴' },
      { name: 'Speckled Egg', icon: '🥚' },
      { name: 'Prism Crystal', icon: '💎' },
      { name: 'Seer’s Orb', icon: '🔮' },
      { name: 'Star Seed', icon: '🌟' },
    ],
  },
};

export const CHAIN_IDS = Object.keys(CHAINS);

export function chainTierCount(chainId) {
  return CHAINS[chainId].tiers.length;
}

export function itemLabel(chain, tier) {
  const c = CHAINS[chain];
  if (!c || tier < 0 || tier >= c.tiers.length) return 'Unknown';
  return c.tiers[tier].name;
}

export function itemIcon(chain, tier) {
  const c = CHAINS[chain];
  if (!c || tier < 0 || tier >= c.tiers.length) return '❔';
  return c.tiers[tier].icon;
}

// ---------------------------------------------------------------------------
// Themes (five visual scenes for the explorer's cabinet)
// ---------------------------------------------------------------------------

export const THEMES = [
  {
    id: 'atelier', name: 'Atelier of Dawn',
    sky: 0x2a2018, fog: 0x2a2018, key: 0xffd9a0, fill: 0x6b5844,
    board: 0x8a6b4a, cell: 0xa5855e, cellAlt: 0x97795a, accent: '#e0a458',
    ambience: 'Warm lamplight over a drafting desk.',
  },
  {
    id: 'conservatory', name: 'Verdant Conservatory',
    sky: 0x16251c, fog: 0x16251c, key: 0xd8ffd2, fill: 0x3f5a46,
    board: 0x4f6b4a, cell: 0x66855c, cellAlt: 0x5a7752, accent: '#7fc86a',
    ambience: 'Glass panes and slow drifting pollen.',
  },
  {
    id: 'observatory', name: 'Midnight Observatory',
    sky: 0x0e1226, fog: 0x0e1226, key: 0xaec4ff, fill: 0x2a3152,
    board: 0x39406b, cell: 0x4a5280, cellAlt: 0x424a75, accent: '#8ea6ff',
    ambience: 'A brass telescope under wheeling stars.',
  },
  {
    id: 'tidepool', name: 'Tidepool Grotto',
    sky: 0x0f2226, fog: 0x0f2226, key: 0xa8f0e6, fill: 0x2c4a4e,
    board: 0x3d6b6b, cell: 0x508585, cellAlt: 0x467878, accent: '#5fd3c4',
    ambience: 'Dripping stone and phosphorescent pools.',
  },
  {
    id: 'ember', name: 'Ember Archive',
    sky: 0x241317, fog: 0x241317, key: 0xffb08a, fill: 0x54332e,
    board: 0x6b4438, cell: 0x85564a, cellAlt: 0x784e42, accent: '#ff8a5c',
    ambience: 'Candle-glow on stacks of annotated maps.',
  },
];

// ---------------------------------------------------------------------------
// Level construction
// ---------------------------------------------------------------------------

// Minimal actions to satisfy a request set: producing one tier-t piece takes
// 2^t taps + (2^t - 1) merges, plus 1 delivery.
export function minActionsForNeeds(needs) {
  let total = 0;
  for (const n of needs) {
    const produce = Math.pow(2, n.tier + 1) - 1;
    total += n.count * (produce + 1);
  }
  return total;
}

function emptyLayout(cols, rows) {
  return { cols, rows, used: new Set() };
}

function place(layout, cell) {
  layout.used.add(cell);
  return cell;
}

function findFreeCell(layout, rng) {
  const total = layout.cols * layout.rows;
  const free = [];
  for (let i = 0; i < total; i++) if (!layout.used.has(i)) free.push(i);
  if (!free.length) return -1;
  return free[Math.floor(rngNext(rng) * free.length)];
}

// Build a level definition from explicit, inspectable parameters.
export function buildLevel(def) {
  return {
    version: CONTENT_VERSION,
    id: def.id,
    name: def.name,
    mode: def.mode,
    seed: def.seed >>> 0,
    cols: def.cols,
    rows: def.rows,
    chains: def.chains, // {chainId: tierCount}
    generators: def.generators,
    pieces: def.pieces || [],
    crates: def.crates || [],
    requests: def.requests,
    moveLimit: def.moveLimit ?? null,
    parSeconds: def.parSeconds ?? null,
    theme: def.theme || 'atelier',
    mechanics: def.mechanics || [],
    tutorial: def.tutorial || null,
    ranked: !!def.ranked,
  };
}

function derive(level) {
  // Shared constructor from tunable difficulty knobs.
  const rng = createRng(level.seed ^ 0x9e3779b9);
  const { cols, rows } = level;
  const layout = emptyLayout(cols, rows);
  const chains = {};
  for (const c of level.chainIds) chains[c] = chainTierCount(c);

  // Generators: one per chain, placed apart.
  const generators = [];
  for (const c of level.chainIds) {
    const cell = findFreeCell(layout, rng);
    generators.push({ cell: place(layout, cell), chain: c, charges: -1 });
  }

  // Crates (blockers).
  const crates = [];
  for (let i = 0; i < (level.crates || 0); i++) {
    const cell = findFreeCell(layout, rng);
    if (cell >= 0) { crates.push(place(layout, cell)); }
  }

  // Webbed starter pieces: placed in mergeable pairs of tier-0.
  const pieces = [];
  for (let i = 0; i < (level.webPairs || 0); i++) {
    const chain = rngPick(rng, level.chainIds);
    const c1 = findFreeCell(layout, rng);
    if (c1 < 0) break;
    place(layout, c1); // mark before choosing c2 so the pair cannot collide
    const c2 = findFreeCell(layout, rng);
    if (c2 < 0) { layout.used.delete(c1); break; }
    place(layout, c2);
    pieces.push({ cell: c1, chain, tier: 0, webbed: true });
    pieces.push({ cell: c2, chain, tier: 0, webbed: false });
  }

  // Requests.
  const requests = [];
  const minTier = level.reqTierMin, maxTierReq = level.reqTierMax;
  for (let r = 0; r < level.reqCount; r++) {
    const needs = [];
    const nNeeds = level.reqSize || 1;
    for (let k = 0; k < nNeeds; k++) {
      const chain = rngPick(rng, level.chainIds);
      const tier = rngInt(rng, minTier, maxTierReq);
      const count = rngInt(rng, 1, level.reqCountMax || 1);
      needs.push({ chain, tier, count });
    }
    requests.push({ id: level.id + ':r' + r, needs });
  }

  const allNeeds = requests.flatMap((r) => r.needs);
  const minActions = minActionsForNeeds(allNeeds);
  const moveLimit = level.moveLimitFactor
    ? Math.ceil(minActions * level.moveLimitFactor)
    : null;
  const parSeconds = Math.ceil(minActions * 3.2);

  return buildLevel({
    id: level.id, name: level.name, mode: level.mode, seed: level.seed,
    cols, rows, chains, generators, pieces, crates, requests,
    moveLimit, parSeconds, theme: level.theme, mechanics: level.mechanics,
    ranked: level.ranked,
  });
}

// ---------------------------------------------------------------------------
// Journey: 40 authored stages across 5 themes (8 per theme), i%8==7 = mastery
// ---------------------------------------------------------------------------

const JOURNEY_NAMES = [
  ['First Shelf', 'Sorting Brushes', 'A Careful Hand', 'Small Wonders', 'Packed Crates', 'Dust and Web', 'Twin Chains', 'Mastery: The Desk'],
  ['Greenhouse Keys', 'Fern and Flame', 'Pressed Petals', 'Overgrown Corners', 'The Potting Bench', 'Tangled Vines', 'Glass and Leaf', 'Mastery: The Conservatory'],
  ['Star Charts', 'Lens Polish', 'Night Shift', 'Orbiting Requests', 'Deep Field', 'Comet Trails', 'The Meridian', 'Mastery: The Observatory'],
  ['Low Tide', 'Shell Money', 'Grotto Glow', 'Ripple Marks', 'The Wreck', 'Pearl Diving', 'Undertow', 'Mastery: The Grotto'],
  ['Candle Index', 'Foxed Pages', 'The Catalog', 'Marginalia', 'Locked Folios', 'Ash and Amber', 'The Last Carton', 'Mastery: The Archive'],
];

export function journeyLevel(index) {
  if (index < 0 || index > 39) throw new RangeError('journey index out of range');
  const themeIdx = Math.floor(index / 8);
  const step = index % 8;
  const theme = THEMES[themeIdx].id;
  const mastery = step === 7;
  const seed = hashString(`journey:${index}`);

  const g = Math.floor(index / 10); // 0..3 broad band
  const size = index < 8 ? 5 : index < 24 ? 6 : 7;
  const chainCount = Math.min(1 + Math.floor((index + 2) / 8), 3);
  // Theme-flavored chain ordering so each wing feels distinct.
  const poolByTheme = [
    ['tools', 'relics', 'curios'],
    ['flora', 'tools', 'curios'],
    ['curios', 'tools', 'relics'],
    ['relics', 'flora', 'curios'],
    ['relics', 'tools', 'flora'],
  ];
  const chainIds = poolByTheme[themeIdx].slice(0, chainCount);

  const reqTierMin = Math.min(1 + Math.floor(index / 14), 2);
  const reqTierMax = Math.min(2 + Math.floor(index / 8) + (mastery ? 1 : 0), 5);
  const reqCount = 2 + Math.min(Math.floor(index / 10), 2) + (mastery ? 1 : 0);

  return derive({
    id: 'journey-' + (index + 1),
    name: JOURNEY_NAMES[themeIdx][step],
    mode: 'journey',
    seed,
    cols: size, rows: size,
    chainIds,
    crates: index < 10 ? Math.floor(index / 5) : Math.min(2 + Math.floor(index / 8), 6),
    webPairs: index < 6 ? 0 : Math.min(1 + Math.floor((index - 6) / 7), 4),
    reqCount,
    reqSize: index >= 20 ? 2 : 1,
    reqCountMax: index >= 12 ? (index >= 28 ? 2 : 1) : 1,
    reqTierMin,
    reqTierMax,
    moveLimitFactor: mastery ? 1.45 : null,
    theme,
    mechanics: [
      'merge', 'generator',
      ...(index >= 4 ? ['crates'] : []),
      ...(index >= 6 ? ['webbed'] : []),
      ...(mastery ? ['move-limit'] : []),
    ],
    ranked: true,
  });
}

export const JOURNEY_COUNT = 40;

// ---------------------------------------------------------------------------
// Daily: one shared seed + ruleset per UTC day
// ---------------------------------------------------------------------------

export function dailySeedFor(dateStr) {
  return hashString('daily:' + dateStr);
}

export function dailyLevel(dateStr) {
  const seed = dailySeedFor(dateStr);
  const rng = createRng(seed);
  const size = rngInt(rng, 6, 7);
  // Fisher-Yates with the seeded stream (engine-independent, unlike sort()).
  const pool = [...CHAIN_IDS];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rngNext(rng) * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const chainIds = pool.slice(0, 3);
  const tierMax = rngInt(rng, 3, 4);
  return derive({
    id: 'daily-' + dateStr,
    name: 'Daily Cabinet — ' + dateStr,
    mode: 'daily',
    seed,
    cols: size, rows: size,
    chainIds,
    crates: rngInt(rng, 2, 4),
    webPairs: rngInt(rng, 1, 3),
    reqCount: 4,
    reqSize: rngInt(rng, 1, 2),
    reqCountMax: 2,
    reqTierMin: 1,
    reqTierMax: tierMax,
    moveLimitFactor: null,
    theme: THEMES[rngInt(rng, 0, THEMES.length - 1)].id,
    mechanics: ['merge', 'generator', 'crates', 'webbed'],
    ranked: true,
  });
}

// ---------------------------------------------------------------------------
// Practice: selectable difficulty, unranked, undo permitted
// ---------------------------------------------------------------------------

export const PRACTICE_DIFFICULTIES = {
  easy: { size: 5, chains: 1, reqCount: 2, tierMax: 2, crates: 0, webPairs: 0 },
  medium: { size: 6, chains: 2, reqCount: 3, tierMax: 3, crates: 2, webPairs: 1 },
  hard: { size: 7, chains: 3, reqCount: 4, tierMax: 4, crates: 4, webPairs: 2 },
};

export function practiceLevel(difficulty, seed) {
  const d = PRACTICE_DIFFICULTIES[difficulty] || PRACTICE_DIFFICULTIES.medium;
  const useSeed = seed ?? hashString('practice:' + Date.now() + ':' + Math.random());
  return derive({
    id: 'practice-' + difficulty + '-' + useSeed.toString(16),
    name: 'Practice (' + difficulty + ')',
    mode: 'practice',
    seed: useSeed,
    cols: d.size, rows: d.size,
    chainIds: CHAIN_IDS.slice(0, d.chains),
    crates: d.crates, webPairs: d.webPairs,
    reqCount: d.reqCount, reqSize: 1, reqCountMax: 1,
    reqTierMin: 1, reqTierMax: d.tierMax,
    moveLimitFactor: null,
    theme: THEMES[hashString(difficulty) % THEMES.length].id,
    mechanics: ['merge', 'generator', 'crates', 'webbed'],
    ranked: false,
  });
}

// ---------------------------------------------------------------------------
// Challenge: constrained goals (move limit, speed target, altered layout)
// ---------------------------------------------------------------------------

export const CHALLENGES = [
  {
    id: 'frugal-hands', name: 'Frugal Hands', blurb: 'Complete every request within a tight move limit.',
    variant: { moveLimitFactor: 1.3 }, seed: hashString('challenge:frugal'),
  },
  {
    id: 'brisk-catalog', name: 'Brisk Catalog', blurb: 'A speed target: beat the par clock on a roomy board.',
    variant: { speed: true }, seed: hashString('challenge:brisk'),
  },
  {
    id: 'crowded-shelves', name: 'Crowded Shelves', blurb: 'Crates and cobwebs choke a small cabinet.',
    variant: { dense: true }, seed: hashString('challenge:crowded'),
  },
];

export function challengeLevel(challengeId) {
  const c = CHALLENGES.find((x) => x.id === challengeId);
  if (!c) throw new RangeError('unknown challenge ' + challengeId);
  const v = c.variant;
  return derive({
    id: 'challenge-' + c.id,
    name: c.name,
    mode: 'challenge',
    seed: c.seed,
    cols: v.dense ? 5 : 6, rows: v.dense ? 5 : 6,
    chainIds: ['tools', 'relics', 'flora'],
    crates: v.dense ? 6 : 2,
    webPairs: v.dense ? 3 : 1,
    reqCount: 3, reqSize: 1, reqCountMax: 1,
    reqTierMin: 1, reqTierMax: 3,
    moveLimitFactor: v.moveLimitFactor || null,
    theme: v.dense ? 'ember' : v.speed ? 'observatory' : 'atelier',
    mechanics: ['merge', 'generator', 'crates', 'webbed', ...(v.moveLimitFactor ? ['move-limit'] : [])],
    ranked: true,
  });
}

// ---------------------------------------------------------------------------
// Learn: interactive lessons, one rule at a time
// ---------------------------------------------------------------------------

export function tutorialLevels() {
  const chains = { tools: chainTierCount('tools') };
  const base = {
    version: CONTENT_VERSION, mode: 'learn', cols: 4, rows: 4, chains,
    crates: [], moveLimit: null, parSeconds: null, theme: 'atelier', ranked: false,
  };
  return [
    {
      ...buildLevel({
        ...base, id: 'learn-1', name: 'Lesson 1: The Field Kit', seed: 11,
        generators: [{ cell: 5, chain: 'tools', charges: -1 }], pieces: [], requests: [],
        mechanics: ['generator'],
        tutorial: {
          steps: [
            { text: 'This brass Field Kit is a generator. Tap it (or press Enter on it) to produce an item.', require: { type: 'tap' } },
            { text: 'Tap the Field Kit once more — we need a matching pair.', require: { type: 'tap' } },
            { text: 'Well done. Lesson complete!', require: null },
          ],
        },
      }),
      requests: [],
    },
    {
      ...buildLevel({
        ...base, id: 'learn-2', name: 'Lesson 2: Merging Pairs', seed: 22,
        generators: [{ cell: 5, chain: 'tools', charges: -1 }],
        pieces: [
          { cell: 9, chain: 'tools', tier: 0 },
          { cell: 10, chain: 'tools', tier: 0 },
        ],
        requests: [],
        mechanics: ['generator', 'merge'],
        tutorial: {
          steps: [
            { text: 'Two Field Brushes! Drag one onto the other — or select one, then the other — to merge them.', require: { type: 'merge' } },
            { text: 'Merging raised the discovery tier. Tap the Field Kit twice and merge again.', require: { type: 'merge', also: ['tap'] } },
            { text: 'You have the idea. Lesson complete!', require: null },
          ],
        },
      }),
      requests: [],
    },
    {
      ...buildLevel({
        ...base, id: 'learn-3', name: 'Lesson 3: Requests', seed: 33,
        generators: [{ cell: 5, chain: 'tools', charges: -1 }],
        pieces: [{ cell: 9, chain: 'tools', tier: 1 }],
        requests: [{ id: 'learn-3:r0', needs: [{ chain: 'tools', tier: 1, count: 1 }] }],
        mechanics: ['generator', 'merge', 'deliver'],
        tutorial: {
          steps: [
            { text: 'The cabinet keeper requests a Surveyor’s Pick. Select the pick, then press Deliver (or drag it onto the request card).', require: { type: 'deliver' } },
            { text: 'Request complete — that wins a round. Lesson complete!', require: null },
          ],
        },
      }),
    },
    {
      ...buildLevel({
        ...base, id: 'learn-4', name: 'Lesson 4: Cobwebs', seed: 44, cols: 5, rows: 5,
        generators: [{ cell: 7, chain: 'tools', charges: -1 }],
        pieces: [
          { cell: 11, chain: 'tools', tier: 0, webbed: true },
          { cell: 12, chain: 'tools', tier: 0 },
        ],
        requests: [{ id: 'learn-4:r0', needs: [{ chain: 'tools', tier: 2, count: 1 }] }],
        mechanics: ['generator', 'merge', 'deliver', 'webbed'],
        tutorial: {
          steps: [
            { text: 'Webbed pieces cannot move — but merging a matching piece onto one clears the web. Merge the free brush onto the webbed one.', require: { type: 'merge' } },
            { text: 'Now complete the request: make a Brass Lantern and deliver it. No more hints — you have this!', require: { type: 'deliver', also: ['tap', 'merge', 'move'] } },
            { text: 'Lesson complete. The cabinet is yours.', require: null },
          ],
        },
      }),
    },
  ];
}

// ---------------------------------------------------------------------------
// Offline validator: legality, reachable goals, bounded duration, no soft locks
// ---------------------------------------------------------------------------

export function validateLevel(level) {
  const errors = [];
  const total = level.cols * level.rows;
  const used = new Set();
  const checkCell = (cell, what) => {
    if (!Number.isInteger(cell) || cell < 0 || cell >= total) {
      errors.push(`${what} out of bounds: ${cell}`);
      return false;
    }
    if (used.has(cell)) {
      errors.push(`${what} overlaps another object at ${cell}`);
      return false;
    }
    used.add(cell);
    return true;
  };

  if (!level.generators || level.generators.length === 0) {
    errors.push('no generators: soft lock risk');
  }
  const genChains = new Set();
  let infiniteGen = false;
  for (const g of level.generators || []) {
    checkCell(g.cell, 'generator');
    genChains.add(g.chain);
    if ((g.charges ?? -1) !== 0) infiniteGen = true;
    if (!level.chains[g.chain]) errors.push(`generator references unknown chain ${g.chain}`);
  }
  for (const c of level.crates || []) checkCell(c, 'crate');
  for (const p of level.pieces || []) {
    if (checkCell(p.cell, 'piece')) {
      const n = level.chains[p.chain];
      if (!n) errors.push(`piece references unknown chain ${p.chain}`);
      else if (p.tier < 0 || p.tier >= n) errors.push(`piece tier ${p.tier} out of range for ${p.chain}`);
    }
  }
  const free = total - used.size;
  if (free < 2) errors.push('fewer than 2 free cells: soft lock risk');

  // Requests must reference craftable chains/tiers.
  for (const r of level.requests || []) {
    for (const n of r.needs) {
      if (!genChains.has(n.chain)) errors.push(`request needs ${n.chain} but no generator provides it`);
      const tiers = level.chains[n.chain];
      if (!tiers || n.tier < 0 || n.tier >= tiers) errors.push(`request tier ${n.tier} unreachable in ${n.chain}`);
      if (n.count < 1) errors.push('request count must be >= 1');
    }
  }

  // Bounded duration estimate.
  const minActions = minActionsForNeeds((level.requests || []).flatMap((r) => r.needs));
  if (minActions > 2000) errors.push(`unbounded: estimated ${minActions} minimum actions`);
  if (level.moveLimit !== null && level.moveLimit !== undefined) {
    if (level.moveLimit < minActions) {
      errors.push(`move limit ${level.moveLimit} below minimum required actions ${minActions}`);
    }
  }
  if (!infiniteGen && (level.requests || []).length > 0) {
    errors.push('all generators exhausted-limited but requests exist: possible soft lock');
  }
  return { ok: errors.length === 0, errors, minActions };
}
