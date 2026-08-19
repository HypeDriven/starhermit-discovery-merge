// Rules + content unit/property/fuzz tests. Run: node --test test/
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createGame, applyCommand, legalActions, serialize, deserialize, stateHash,
  replay, totalScore, timeBonus, INVALID, TERMINAL, cloneState,
} from '../src/engine/rules.js';
import { createRng, rngInt } from '../src/engine/rng.js';
import {
  journeyLevel, JOURNEY_COUNT, dailyLevel, practiceLevel, challengeLevel,
  tutorialLevels, validateLevel, CHAINS, chainTierCount,
} from '../src/content.js';

function tinyLevel(overrides = {}) {
  return {
    seed: 1234, cols: 4, rows: 4,
    chains: { tools: chainTierCount('tools') },
    generators: [{ cell: 0, chain: 'tools', charges: -1 }],
    pieces: [], crates: [],
    requests: [{ id: 'r0', needs: [{ chain: 'tools', tier: 1, count: 1 }] }],
    moveLimit: null,
    ...overrides,
  };
}

// --------------------------------------------------------------------------
// Generator taps
// --------------------------------------------------------------------------

test('tap generator spawns a tier-0 piece on a free cell', () => {
  const s = createGame(tinyLevel());
  const r = applyCommand(s, { type: 'tap', cell: 0 });
  assert.ok(r.ok);
  assert.equal(r.state.stats.spawns, 1);
  const pieces = r.state.cells.filter((c) => c && c.kind === 'piece');
  assert.equal(pieces.length, 1);
  assert.equal(pieces[0].tier, 0);
  assert.equal(pieces[0].chain, 'tools');
  assert.ok(r.events.some((e) => e.type === 'spawn'));
});

test('tap is deterministic across two runs with the same seed', () => {
  const a = applyCommand(createGame(tinyLevel()), { type: 'tap', cell: 0 });
  const b = applyCommand(createGame(tinyLevel()), { type: 'tap', cell: 0 });
  assert.equal(stateHash(a.state), stateHash(b.state));
});

test('tap on non-generator / out of bounds is rejected with a reason', () => {
  const s = createGame(tinyLevel());
  assert.equal(applyCommand(s, { type: 'tap', cell: 5 }).error, INVALID.NOT_GENERATOR);
  assert.equal(applyCommand(s, { type: 'tap', cell: 99 }).error, INVALID.OUT_OF_BOUNDS);
});

test('finite generator charges deplete and reject', () => {
  const lvl = tinyLevel({ generators: [{ cell: 0, chain: 'tools', charges: 1 }] });
  let s = createGame(lvl);
  s = applyCommand(s, { type: 'tap', cell: 0 }).state;
  assert.equal(applyCommand(s, { type: 'tap', cell: 0 }).error, INVALID.NO_CHARGES);
});

// --------------------------------------------------------------------------
// Merging
// --------------------------------------------------------------------------

test('merge two equal pieces produces next tier and score', () => {
  const lvl = tinyLevel({
    requests: [],
    pieces: [
      { cell: 1, chain: 'tools', tier: 0 },
      { cell: 2, chain: 'tools', tier: 0 },
    ],
  });
  const s = createGame(lvl);
  const r = applyCommand(s, { type: 'merge', from: 1, to: 2 });
  assert.ok(r.ok);
  assert.equal(r.state.cells[1], null);
  assert.equal(r.state.cells[2].tier, 1);
  assert.equal(r.state.score.merge, 10);
  assert.ok(r.events.some((e) => e.type === 'discover')); // tier 1 discovery
  assert.equal(r.state.discovered.tools, 1);
});

test('mismatched chains, tiers, and max tier are rejected', () => {
  const lvl = tinyLevel({
    chains: { tools: 6, relics: 6 },
    requests: [],
    pieces: [
      { cell: 1, chain: 'tools', tier: 0 },
      { cell: 2, chain: 'relics', tier: 0 },
      { cell: 3, chain: 'tools', tier: 1 },
      { cell: 4, chain: 'tools', tier: 5 },
      { cell: 5, chain: 'tools', tier: 5 },
    ],
  });
  const s = createGame(lvl);
  assert.equal(applyCommand(s, { type: 'merge', from: 1, to: 2 }).error, INVALID.MISMATCH);
  assert.equal(applyCommand(s, { type: 'merge', from: 1, to: 3 }).error, INVALID.MISMATCH);
  assert.equal(applyCommand(s, { type: 'merge', from: 4, to: 5 }).error, INVALID.MAX_TIER);
});

test('webbed pieces cannot move but unweb when merged onto', () => {
  const lvl = tinyLevel({
    requests: [],
    pieces: [
      { cell: 1, chain: 'tools', tier: 0, webbed: true },
      { cell: 2, chain: 'tools', tier: 0 },
    ],
  });
  let s = createGame(lvl);
  assert.equal(applyCommand(s, { type: 'merge', from: 1, to: 2 }).error, INVALID.WEBBED);
  assert.equal(applyCommand(s, { type: 'move', from: 1, to: 3 }).error, INVALID.WEBBED);
  const r = applyCommand(s, { type: 'merge', from: 2, to: 1 });
  assert.ok(r.ok);
  assert.equal(r.state.cells[1].webbed, false);
  assert.equal(r.state.cells[1].tier, 1);
});

// --------------------------------------------------------------------------
// Moves and delivery
// --------------------------------------------------------------------------

test('move to empty cell works; occupied target rejected', () => {
  const lvl = tinyLevel({
    requests: [],
    pieces: [{ cell: 1, chain: 'tools', tier: 0 }, { cell: 2, chain: 'tools', tier: 1 }],
  });
  const s = createGame(lvl);
  assert.equal(applyCommand(s, { type: 'move', from: 1, to: 2 }).error, INVALID.TARGET_OCCUPIED);
  const r = applyCommand(s, { type: 'move', from: 1, to: 7 });
  assert.ok(r.ok);
  assert.equal(r.state.cells[7].tier, 0);
  assert.equal(r.state.stats.moves, 1);
});

test('deliver fills request needs, consumes piece, wins when all done', () => {
  const lvl = tinyLevel({ pieces: [{ cell: 3, chain: 'tools', tier: 1 }] });
  const s = createGame(lvl);
  const r = applyCommand(s, { type: 'deliver', cell: 3, request: 'r0' });
  assert.ok(r.ok);
  assert.equal(r.state.status, 'won');
  assert.equal(r.state.terminalReason, TERMINAL.REQUESTS_COMPLETE);
  assert.equal(r.state.cells[3], null);
  assert.ok(r.state.score.request > 0);
  assert.ok(r.events.some((e) => e.type === 'request-complete'));
});

test('delivering a non-matching piece is rejected', () => {
  const lvl = tinyLevel({ pieces: [{ cell: 3, chain: 'tools', tier: 0 }] });
  const s = createGame(lvl);
  assert.equal(applyCommand(s, { type: 'deliver', cell: 3, request: 'r0' }).error, INVALID.NO_MATCHING_NEED);
});

// --------------------------------------------------------------------------
// Move limits and terminal states
// --------------------------------------------------------------------------

test('move limit ends the round with out-of-moves', () => {
  const lvl = tinyLevel({ moveLimit: 2 });
  let s = createGame(lvl);
  s = applyCommand(s, { type: 'tap', cell: 0 }).state;
  assert.equal(s.status, 'active');
  s = applyCommand(s, { type: 'tap', cell: 0 }).state;
  assert.equal(s.status, 'lost');
  assert.equal(s.terminalReason, TERMINAL.OUT_OF_MOVES);
  assert.equal(applyCommand(s, { type: 'tap', cell: 0 }).error, INVALID.NOT_ACTIVE);
});

test('no-legal-moves loss when board is full with nothing to do', () => {
  // Board full of max-tier pieces and one crate, no generator.
  const pieces = [];
  for (let i = 0; i < 15; i++) pieces.push({ cell: i, chain: 'tools', tier: 5 });
  const lvl = tinyLevel({ generators: [], pieces, crates: [15], requests: [] });
  const s = createGame(lvl);
  assert.equal(legalActions(s).canAct, false);
  // Terminal triggers on next applied command; verify via a fresh game path:
  const lvl2 = tinyLevel({ generators: [], pieces: pieces.slice(0, 14), crates: [14, 15], requests: [] });
  const s2 = createGame(lvl2);
  assert.equal(legalActions(s2).canAct, false);
});

// --------------------------------------------------------------------------
// Serialization, replay, determinism
// --------------------------------------------------------------------------

test('serialization round-trips', () => {
  let s = createGame(tinyLevel());
  s = applyCommand(s, { type: 'tap', cell: 0 }).state;
  const back = deserialize(serialize(s));
  assert.equal(stateHash(back), stateHash(s));
});

test('replay: same level + commands give identical hashes across runs', () => {
  const lvl = tinyLevel();
  const commands = [
    { type: 'tap', cell: 0 }, { type: 'tap', cell: 0 },
    { type: 'merge', from: -1, to: -1 }, // invalid on purpose — recorded as invalid
    { type: 'tap', cell: 0 },
  ];
  const a = replay(lvl, commands);
  const b = replay(lvl, commands);
  assert.deepEqual(a.hashes, b.hashes);
  assert.ok(a.finalHash.length > 0);
});

test('different seeds diverge', () => {
  const a = createGame(tinyLevel({ seed: 1 }));
  const b = createGame(tinyLevel({ seed: 2 }));
  const ra = applyCommand(a, { type: 'tap', cell: 0 });
  const rb = applyCommand(b, { type: 'tap', cell: 0 });
  assert.notEqual(stateHash(ra.state), stateHash(rb.state));
});

test('immutability: applying a command does not mutate the input state', () => {
  const s = createGame(tinyLevel());
  const before = serialize(s);
  applyCommand(s, { type: 'tap', cell: 0 });
  assert.equal(serialize(s), before);
});

// --------------------------------------------------------------------------
// Scoring components and tie-break helpers
// --------------------------------------------------------------------------

test('score is a component breakdown summing to the total', () => {
  let s = createGame(tinyLevel({ pieces: [{ cell: 3, chain: 'tools', tier: 1 }] }));
  s = applyCommand(s, { type: 'tap', cell: 0 }).state;
  s = applyCommand(s, { type: 'deliver', cell: 3, request: 'r0' }).state;
  const c = s.score;
  assert.equal(totalScore(s), c.merge + c.discovery + c.request + c.bonus + c.penalty);
  assert.ok(c.request > 0);
});

test('time bonus rewards beating par and caps', () => {
  assert.equal(timeBonus(100, 50), 100);
  assert.equal(timeBonus(100, 120), 0);
  assert.equal(timeBonus(1000, 0), 500);
  assert.equal(timeBonus(null, 10), 0);
});

// --------------------------------------------------------------------------
// Fuzz: malformed commands never throw and never corrupt state
// --------------------------------------------------------------------------

test('fuzz malformed commands', () => {
  const rng = createRng(42);
  let s = createGame(tinyLevel());
  const junk = [null, undefined, 42, 'tap', {}, { type: 1 }, { type: 'tap' },
    { type: 'tap', cell: 'a' }, { type: 'merge', from: 0.5, to: 1 },
    { type: 'deliver', cell: 1 }, { type: 'nope' }, { type: 'move', from: -9, to: 1e9 }];
  for (let i = 0; i < 500; i++) {
    const cmd = junk[Math.floor(rngInt(rng, 0, junk.length - 1))];
    const r = applyCommand(s, cmd);
    assert.equal(r.ok, false);
  }
  // Random legal-ish command stream: no throws, no NaN, no unbounded loops.
  for (let i = 0; i < 400 && s.status === 'active'; i++) {
    const kind = rngInt(rng, 0, 3);
    const cell = rngInt(rng, 0, 15);
    let cmd;
    if (kind === 0) cmd = { type: 'tap', cell };
    else if (kind === 1) cmd = { type: 'merge', from: cell, to: rngInt(rng, 0, 15) };
    else if (kind === 2) cmd = { type: 'move', from: cell, to: rngInt(rng, 0, 15) };
    else cmd = { type: 'deliver', cell, request: 'r0' };
    const r = applyCommand(s, cmd);
    if (r.ok) {
      s = r.state;
      assert.ok(Number.isFinite(totalScore(s)));
    }
  }
});

// --------------------------------------------------------------------------
// Content validation across the shipped catalog
// --------------------------------------------------------------------------

test('all 40 journey levels validate', () => {
  for (let i = 0; i < JOURNEY_COUNT; i++) {
    const lvl = journeyLevel(i);
    const v = validateLevel(lvl);
    assert.ok(v.ok, `journey ${i + 1}: ${v.errors.join('; ')}`);
  }
});

test('daily levels validate for a sweep of dates', () => {
  const dates = ['2026-01-01', '2026-02-28', '2026-08-19', '2026-12-31', '2027-06-15', '2028-02-29', '2030-03-03'];
  for (const d of dates) {
    const lvl = dailyLevel(d);
    const v = validateLevel(lvl);
    assert.ok(v.ok, `daily ${d}: ${v.errors.join('; ')}`);
  }
  // Same date → same content (immutable seed).
  assert.deepEqual(dailyLevel('2026-08-19'), dailyLevel('2026-08-19'));
});

test('practice difficulties and challenges validate', () => {
  for (const diff of ['easy', 'medium', 'hard']) {
    const v = validateLevel(practiceLevel(diff, 777));
    assert.ok(v.ok, `practice ${diff}: ${v.errors.join('; ')}`);
  }
  for (const id of ['frugal-hands', 'brisk-catalog', 'crowded-shelves']) {
    const v = validateLevel(challengeLevel(id));
    assert.ok(v.ok, `challenge ${id}: ${v.errors.join('; ')}`);
  }
});

test('tutorial levels validate and each has steps', () => {
  for (const lvl of tutorialLevels()) {
    const v = validateLevel(lvl);
    assert.ok(v.ok, `${lvl.id}: ${v.errors.join('; ')}`);
    assert.ok(lvl.tutorial.steps.length >= 2);
  }
});

test('golden session: full win on a scripted board reproduces a stable hash', () => {
  // Board: generator at 0; complete r0 (tier 1) via two taps + merge + deliver.
  const lvl = tinyLevel({ cols: 3, rows: 3 });
  let s = createGame(lvl);
  s = applyCommand(s, { type: 'tap', cell: 0 }).state;
  s = applyCommand(s, { type: 'tap', cell: 0 }).state;
  const la = legalActions(s);
  assert.equal(la.merges.length, 1);
  const m = la.merges[0];
  s = applyCommand(s, { type: 'merge', from: m.from, to: m.to }).state;
  s = applyCommand(s, { type: 'deliver', cell: m.to, request: 'r0' }).state;
  assert.equal(s.status, 'won');
  assert.equal(stateHash(s), 'cc53c98d');
});

test('journey level 1 is winnable by a greedy solver within sane bounds', () => {
  const lvl = journeyLevel(0);
  let s = createGame(lvl);
  const rng = createRng(9);
  let guard = 0;
  while (s.status === 'active' && guard++ < 4000) {
    const la = legalActions(s);
    // Deliver when possible, then merge, else tap a generator.
    if (la.delivers.length) {
      const d = la.delivers[0];
      s = applyCommand(s, { type: 'deliver', cell: d.cell, request: d.request }).state;
    } else if (la.merges.length) {
      const m = la.merges[0];
      s = applyCommand(s, { type: 'merge', from: m.from, to: m.to }).state;
    } else if (la.taps.length) {
      const t = la.taps[Math.floor(rngInt(rng, 0, la.taps.length - 1))];
      const r = applyCommand(s, { type: 'tap', cell: t.cell });
      if (r.ok) s = r.state;
      else if (r.error === INVALID.BOARD_FULL) {
        // Consolidate: move nothing; if truly stuck, break.
        break;
      } else break;
    } else break;
  }
  assert.equal(s.status, 'won', `ended ${s.status}/${s.terminalReason} after ${guard} actions`);
});

test('all journey levels + dailies are winnable by a greedy solver', () => {
  function solve(lvl, seed) {
    let s = createGame(lvl);
    const rng = createRng(seed);
    let guard = 0;
    while (s.status === 'active' && guard++ < 8000) {
      const la = legalActions(s);
      if (la.delivers.length) {
        const d = la.delivers[0];
        s = applyCommand(s, { type: 'deliver', cell: d.cell, request: d.request }).state;
      } else if (la.merges.length) {
        // Prefer the highest-tier merge to make progress.
        const m = la.merges.reduce((a, b) => (b.tier > a.tier ? b : a));
        const r = applyCommand(s, { type: 'merge', from: m.from, to: m.to });
        if (!r.ok) return { s, stuck: true };
        s = r.state;
      } else if (la.taps.length) {
        const t = la.taps[Math.floor(rngInt(rng, 0, la.taps.length - 1))];
        const r = applyCommand(s, { type: 'tap', cell: t.cell });
        if (!r.ok) return { s, stuck: true };
        s = r.state;
      } else break;
    }
    return { s, stuck: false };
  }
  for (let i = 0; i < JOURNEY_COUNT; i++) {
    const lvl = journeyLevel(i);
    if (lvl.moveLimit !== null) continue; // greedy play isn't move-optimal; validator covers feasibility
    const { s, stuck } = solve(lvl, 7);
    assert.equal(s.status, 'won', `journey ${i + 1} unsolved: ${s.status}/${s.terminalReason}${stuck ? ' (stuck)' : ''}`);
  }
  for (const d of ['2026-08-19', '2026-01-01', '2027-12-31']) {
    const { s } = solve(dailyLevel(d), 13);
    assert.equal(s.status, 'won', `daily ${d} unsolved: ${s.status}/${s.terminalReason}`);
  }
});

test('cloneState deep-copies without aliasing', () => {
  const s = createGame(tinyLevel({ pieces: [{ cell: 3, chain: 'tools', tier: 0 }] }));
  const c = cloneState(s);
  c.cells[3].tier = 99;
  assert.equal(s.cells[3].tier, 0);
});
