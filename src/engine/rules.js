// Discovery Merge — pure deterministic rules engine.
// No DOM, no rendering, no wall-clock access. All randomness flows through the
// serializable rules RNG stream. UI/hints/tutorials call legalActions() and
// applyCommand() — the same API used by play.

import { createRng, cloneRng, rngNext, hashState, stableStringify } from './rng.js';

export const RULES_VERSION = 1;

export const TERMINAL = {
  REQUESTS_COMPLETE: 'requests-complete',
  OUT_OF_MOVES: 'out-of-moves',
  NO_LEGAL_MOVES: 'no-legal-moves',
  ABANDONED: 'abandoned',
};

export const INVALID = {
  NOT_ACTIVE: 'not-active',
  OUT_OF_MOVES: 'out-of-moves',
  OUT_OF_BOUNDS: 'out-of-bounds',
  NOT_GENERATOR: 'not-generator',
  NO_CHARGES: 'no-charges',
  BOARD_FULL: 'board-full',
  NO_PIECE: 'no-piece',
  SAME_CELL: 'same-cell',
  TARGET_OCCUPIED: 'target-occupied',
  TARGET_EMPTY: 'target-empty',
  MISMATCH: 'mismatch',
  MAX_TIER: 'max-tier',
  WEBBED: 'webbed',
  NO_MATCHING_NEED: 'no-matching-need',
  BAD_REQUEST: 'bad-request',
  BAD_SHAPE: 'bad-shape',
};

// Deterministic item ids: each command creates at most one item, so
// seed:tick is unique; initial layout uses seed:init:cell. Keeps replay
// hashes stable across processes.
function uidFor(state, tag) {
  return `${state.seed}:${tag}`;
}

// ---------------------------------------------------------------------------
// State construction
// ---------------------------------------------------------------------------

// level: { seed, cols, rows, chains: {id: {tiers: n}}, generators: [{cell, chain, spawn, charges}],
//          pieces: [{cell, chain, tier, webbed}], crates: [cell], requests: [{id, needs}], moveLimit }
export function createGame(level) {
  const cells = new Array(level.cols * level.rows).fill(null);
  const state = {
    v: RULES_VERSION,
    seed: level.seed >>> 0,
    rng: createRng(level.seed),
    tick: 0,
    cols: level.cols,
    rows: level.rows,
    cells,
    chains: level.chains, // { chainId: tierCount }
    requests: level.requests.map((r) => ({
      id: r.id,
      needs: r.needs.map((n) => ({ ...n })),
      progress: r.needs.map(() => 0),
      done: false,
    })),
    discovered: {},
    score: { merge: 0, discovery: 0, request: 0, bonus: 0, penalty: 0 },
    movesUsed: 0,
    moveLimit: level.moveLimit ?? null,
    status: 'active',
    terminalReason: null,
    stats: { merges: 0, spawns: 0, delivers: 0, moves: 0, invalid: 0 },
  };
  for (const g of level.generators || []) {
    cells[g.cell] = {
      id: uidFor(state, 'gen:' + g.cell), kind: 'generator', chain: g.chain,
      spawn: g.spawn || [[0, 1]], charges: g.charges ?? -1,
    };
  }
  for (const c of level.crates || []) {
    cells[c] = { id: uidFor(state, 'crate:' + c), kind: 'crate' };
  }
  for (const p of level.pieces || []) {
    const item = { id: uidFor(state, 'init:' + p.cell), kind: 'piece', chain: p.chain, tier: p.tier, webbed: !!p.webbed };
    cells[p.cell] = item;
    noteDiscovery(state, p.chain, p.tier, /*silent*/ true);
  }
  return state;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function inBounds(state, cell) {
  return Number.isInteger(cell) && cell >= 0 && cell < state.cells.length;
}

export function freeCells(state) {
  const out = [];
  for (let i = 0; i < state.cells.length; i++) if (!state.cells[i]) out.push(i);
  return out;
}

export function isPiece(it) { return !!it && it.kind === 'piece'; }
export function isGenerator(it) { return !!it && it.kind === 'generator'; }

export function maxTier(state, chain) {
  return (state.chains[chain] || 1) - 1;
}

export function canMergeItems(state, a, b) {
  if (!isPiece(a) || !isPiece(b)) return false;
  if (a.chain !== b.chain || a.tier !== b.tier) return false;
  return a.tier < maxTier(state, a.chain);
}

function noteDiscovery(state, chain, tier, silent = false, events = null) {
  const prev = state.discovered[chain] ?? -1;
  if (tier > prev) {
    state.discovered[chain] = tier;
    if (!silent) {
      const pts = 25 * (tier + 1);
      state.score.discovery += pts;
      if (events) events.push({ type: 'discover', chain, tier, points: pts });
    }
    return true;
  }
  return false;
}

function requestNeedsPiece(req, piece) {
  for (let i = 0; i < req.needs.length; i++) {
    const n = req.needs[i];
    if (n.chain === piece.chain && n.tier === piece.tier && req.progress[i] < n.count) return i;
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Legal action query (shared by play, hints, tutorials)
// ---------------------------------------------------------------------------

export function legalActions(state) {
  const result = { taps: [], merges: [], delivers: [], movesCount: 0, canAct: false };
  if (state.status !== 'active') return result;
  if (state.moveLimit !== null && state.movesUsed >= state.moveLimit) return result;

  const free = freeCells(state);
  const pieces = [];
  for (let i = 0; i < state.cells.length; i++) {
    const it = state.cells[i];
    if (!it) continue;
    if (isGenerator(it)) {
      if (it.charges !== 0 && free.length > 0) result.taps.push({ cell: i, chain: it.chain });
    } else if (isPiece(it)) {
      pieces.push({ cell: i, item: it });
    }
  }
  for (const p of pieces) {
    for (const q of pieces) {
      if (q.cell <= p.cell) continue;
      if (!canMergeItems(state, p.item, q.item)) continue;
      if (p.item.webbed && q.item.webbed) continue; // two webbed pieces can't merge
      // The movable piece must be the source; merging onto a webbed twin unwebs it.
      const src = p.item.webbed ? q : p;
      const dst = p.item.webbed ? p : q;
      result.merges.push({ from: src.cell, to: dst.cell, chain: src.item.chain, tier: src.item.tier });
    }
    if (!p.item.webbed) {
      for (const req of state.requests) {
        if (req.done) continue;
        if (requestNeedsPiece(req, p.item) >= 0) {
          result.delivers.push({ cell: p.cell, request: req.id, chain: p.item.chain, tier: p.item.tier });
        }
      }
    }
  }
  if (free.length > 0) {
    for (const p of pieces) if (!p.item.webbed) result.movesCount += free.length;
  }
  result.canAct = result.taps.length > 0 || result.merges.length > 0 ||
    result.delivers.length > 0 || result.movesCount > 0;
  return result;
}

// ---------------------------------------------------------------------------
// Command validation + application
// ---------------------------------------------------------------------------

export function cloneState(state) {
  return JSON.parse(JSON.stringify(state));
}

export function serialize(state) {
  return JSON.stringify(state);
}

export function deserialize(json) {
  const s = typeof json === 'string' ? JSON.parse(json) : json;
  if (!s || typeof s !== 'object') throw new Error('bad state');
  if (s.v > RULES_VERSION) throw new Error('unsupported state version ' + s.v);
  // v1 is the current shape; future migrations slot in here.
  return s;
}

export function stateHash(state) {
  // Hash the canonical simulation state (excludes nothing — state is pure data).
  return hashState(state);
}

function isValidShape(cmd) {
  if (!cmd || typeof cmd !== 'object' || typeof cmd.type !== 'string') return false;
  for (const k of ['cell', 'from', 'to']) {
    if (k in cmd && !Number.isInteger(cmd[k])) return false;
  }
  if ('request' in cmd && typeof cmd.request !== 'string') return false;
  return true;
}

function fail(state, reason) {
  return { ok: false, error: reason, events: [{ type: 'invalid', reason }] };
}

function beginCommand(state) {
  const next = cloneState(state);
  next.tick += 1;
  return next;
}

function countAction(state) {
  state.movesUsed += 1;
}

function checkTerminal(state, events) {
  if (state.requests.length > 0 && state.requests.every((r) => r.done)) {
    state.status = 'won';
    state.terminalReason = TERMINAL.REQUESTS_COMPLETE;
    if (state.moveLimit !== null) {
      const left = Math.max(0, state.moveLimit - state.movesUsed);
      state.score.bonus += left * 5;
    }
    events.push({ type: 'win', reason: state.terminalReason });
    return;
  }
  if (state.moveLimit !== null && state.movesUsed >= state.moveLimit) {
    state.status = 'lost';
    state.terminalReason = TERMINAL.OUT_OF_MOVES;
    events.push({ type: 'lost', reason: state.terminalReason });
    return;
  }
  if (!legalActions(state).canAct) {
    state.status = 'lost';
    state.terminalReason = TERMINAL.NO_LEGAL_MOVES;
    events.push({ type: 'lost', reason: state.terminalReason });
  }
}

// Pure transition. Returns { ok, state?, error?, events } — never throws on
// malformed input, never mutates the input state.
export function applyCommand(state, cmd) {
  if (!isValidShape(cmd)) return fail(state, INVALID.BAD_SHAPE);
  if (state.status !== 'active') return fail(state, INVALID.NOT_ACTIVE);
  if (state.moveLimit !== null && state.movesUsed >= state.moveLimit) {
    return fail(state, INVALID.OUT_OF_MOVES);
  }

  switch (cmd.type) {
    case 'tap': return applyTap(state, cmd);
    case 'merge': return applyMerge(state, cmd);
    case 'move': return applyMove(state, cmd);
    case 'deliver': return applyDeliver(state, cmd);
    default: return fail(state, INVALID.BAD_SHAPE);
  }
}

function applyTap(state, cmd) {
  if (!inBounds(state, cmd.cell)) return fail(state, INVALID.OUT_OF_BOUNDS);
  const gen = state.cells[cmd.cell];
  if (!isGenerator(gen)) return fail(state, INVALID.NOT_GENERATOR);
  if (gen.charges === 0) return fail(state, INVALID.NO_CHARGES);
  const free = freeCells(state);
  if (free.length === 0) return fail(state, INVALID.BOARD_FULL);

  const next = beginCommand(state);
  const ngen = next.cells[cmd.cell];
  if (ngen.charges > 0) ngen.charges -= 1;

  // Weighted spawn tier from the rules RNG stream.
  const table = ngen.spawn;
  let roll = rngNext(next.rng);
  let tier = table[0][0];
  let acc = 0;
  for (const [t, w] of table) {
    acc += w;
    if (roll < acc) { tier = t; break; }
  }
  tier = Math.min(tier, maxTier(next, ngen.chain));
  const cell = free[Math.floor(rngNext(next.rng) * free.length)];
  const item = { id: uidFor(next, 't' + next.tick), kind: 'piece', chain: ngen.chain, tier, webbed: false };
  next.cells[cell] = item;
  next.stats.spawns += 1;

  const events = [{ type: 'spawn', cell, item, from: cmd.cell }];
  noteDiscovery(next, item.chain, item.tier, false, events);
  countAction(next);
  checkTerminal(next, events);
  return { ok: true, state: next, events };
}

function applyMerge(state, cmd) {
  if (!inBounds(state, cmd.from) || !inBounds(state, cmd.to)) return fail(state, INVALID.OUT_OF_BOUNDS);
  if (cmd.from === cmd.to) return fail(state, INVALID.SAME_CELL);
  const a = state.cells[cmd.from];
  const b = state.cells[cmd.to];
  if (!isPiece(a)) return fail(state, INVALID.NO_PIECE);
  if (!isPiece(b)) return fail(state, INVALID.TARGET_EMPTY);
  if (a.webbed) return fail(state, INVALID.WEBBED);
  if (a.chain !== b.chain || a.tier !== b.tier) return fail(state, INVALID.MISMATCH);
  if (a.tier >= maxTier(state, a.chain)) return fail(state, INVALID.MAX_TIER);

  const next = beginCommand(state);
  const merged = {
    id: uidFor(next, 't' + next.tick), kind: 'piece', chain: a.chain, tier: a.tier + 1, webbed: false,
  };
  next.cells[cmd.to] = merged; // merging onto a webbed twin also unwebs it
  next.cells[cmd.from] = null;
  next.stats.merges += 1;

  const pts = 10 * merged.tier;
  next.score.merge += pts;
  const events = [{ type: 'merge', from: cmd.from, to: cmd.to, item: merged, points: pts, unwebbed: !!b.webbed }];
  noteDiscovery(next, merged.chain, merged.tier, false, events);
  countAction(next);
  checkTerminal(next, events);
  return { ok: true, state: next, events };
}

function applyMove(state, cmd) {
  if (!inBounds(state, cmd.from) || !inBounds(state, cmd.to)) return fail(state, INVALID.OUT_OF_BOUNDS);
  if (cmd.from === cmd.to) return fail(state, INVALID.SAME_CELL);
  const a = state.cells[cmd.from];
  if (!isPiece(a)) return fail(state, INVALID.NO_PIECE);
  if (a.webbed) return fail(state, INVALID.WEBBED);
  if (state.cells[cmd.to]) return fail(state, INVALID.TARGET_OCCUPIED);

  const next = beginCommand(state);
  next.cells[cmd.to] = next.cells[cmd.from];
  next.cells[cmd.from] = null;
  next.stats.moves += 1;
  const events = [{ type: 'move', from: cmd.from, to: cmd.to, item: next.cells[cmd.to] }];
  countAction(next);
  checkTerminal(next, events);
  return { ok: true, state: next, events };
}

function applyDeliver(state, cmd) {
  if (!inBounds(state, cmd.cell)) return fail(state, INVALID.OUT_OF_BOUNDS);
  const piece = state.cells[cmd.cell];
  if (!isPiece(piece)) return fail(state, INVALID.NO_PIECE);
  if (piece.webbed) return fail(state, INVALID.WEBBED);
  const req = state.requests.find((r) => r.id === cmd.request);
  if (!req || req.done) return fail(state, INVALID.BAD_REQUEST);
  const needIdx = requestNeedsPiece(req, piece);
  if (needIdx < 0) return fail(state, INVALID.NO_MATCHING_NEED);

  const next = beginCommand(state);
  const nreq = next.requests.find((r) => r.id === cmd.request);
  nreq.progress[needIdx] += 1;
  next.cells[cmd.cell] = null;
  next.stats.delivers += 1;

  const pts = 5 * (piece.tier + 1);
  next.score.request += pts;
  const events = [{ type: 'deliver', cell: cmd.cell, request: cmd.request, chain: piece.chain, tier: piece.tier, points: pts }];
  if (nreq.needs.every((n, i) => nreq.progress[i] >= n.count)) {
    nreq.done = true;
    const bonus = 150 + nreq.needs.reduce((s, n) => s + 20 * n.tier * n.count, 0);
    next.score.request += bonus;
    events.push({ type: 'request-complete', request: cmd.request, points: bonus });
  }
  countAction(next);
  checkTerminal(next, events);
  return { ok: true, state: next, events };
}

// Record a rejected action (drives the invalid-action tie-break stat).
export function noteInvalid(state) {
  const next = cloneState(state);
  next.stats.invalid += 1;
  return next;
}

export function totalScore(state) {
  const s = state.score;
  return s.merge + s.discovery + s.request + s.bonus + s.penalty;
}

// Time bonus reported at results (wall time is session-owned, not rules state).
export function timeBonus(parSeconds, elapsedSeconds) {
  if (!parSeconds || elapsedSeconds == null) return 0;
  const over = elapsedSeconds - parSeconds;
  if (over >= 0) return 0;
  return Math.min(500, Math.round(-over * 2));
}

// ---------------------------------------------------------------------------
// Replay: apply an ordered command log from a level definition.
// ---------------------------------------------------------------------------

export function replay(level, commands) {
  let state = createGame(level);
  const hashes = [stateHash(state)];
  for (const cmd of commands) {
    const r = applyCommand(state, cmd);
    if (r.ok) state = r.state;
    else state = noteInvalid(state);
    hashes.push(stateHash(state));
  }
  return { state, hashes, finalHash: hashes[hashes.length - 1] };
}

export { stableStringify };
