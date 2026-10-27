// The save document on the engine (node --test): the browser build's cloud
// slot (the JS SDK's saveJSON of persist.js's checksummed document) is read
// by parseSave and merged with this device's copy (mergeSaves: progress only
// grows), and a merged document sealed as native/platform.ts seals it passes
// the checksum again. The session's clock is injectable (the engine's fixed
// steps).
import test from 'node:test';
import assert from 'node:assert/strict';
import { hashState } from '../src/engine/rng.js';
import { SAVE_VERSION, mergeSaves, parseSave } from '../src/persist.js';
import { GameSession, clock } from '../src/session.js';
import { journeyLevel } from '../src/content.js';

const seal = (doc) => { const { checksum, ...rest } = doc; const body = { ...rest, version: SAVE_VERSION }; return { ...body, checksum: hashState(body) }; };
const old = seal({
  version: 1, settings: { music: 0.4, domBoard: true, cameraTilt: 'top' },
  journey: { completed: { 0: { score: 400, moves: 9, seconds: 30 }, 1: { score: 300, moves: 12, seconds: 50 } }, bests: {} },
  dailies: { '2026-10-20': { score: 900, completed: true } }, dailyStreakDays: ['2026-10-20'],
  codex: { tools: 3 }, achievements: { 'first-restore': '2026-10-01T00:00:00.000Z' },
  stats: { sessions: 5, merges: 40, websCleared: 2, lessonsDone: { 'learn-1': true } }, leaderboardLocal: [],
});

test('the browser build’s cloud document parses (object or JSON text)', () => {
  assert.equal(parseSave(old).journey.completed[1].score, 300);
  assert.equal(parseSave(JSON.stringify(old)).codex.tools, 3);
  assert.equal(parseSave({ ...old, checksum: 'bad' }), null);
});

test('merging keeps the better of both and seals again', () => {
  const local = parseSave(seal({
    version: 1, settings: {}, journey: { completed: { 0: { score: 500, moves: 8, seconds: 25 } }, bests: {} },
    dailies: {}, dailyStreakDays: ['2026-10-26'], codex: { tools: 1, flora: 2 }, achievements: {},
    stats: { sessions: 2, merges: 10, websCleared: 5, lessonsDone: {} }, leaderboardLocal: [],
  }));
  const m = mergeSaves(parseSave(old), local);
  assert.equal(m.journey.completed[0].score, 500);
  assert.equal(m.journey.completed[1].score, 300);
  assert.deepEqual(m.dailyStreakDays, ['2026-10-20', '2026-10-26']);
  assert.deepEqual(m.codex, { tools: 3, flora: 2 });
  assert.equal(m.stats.websCleared, 5);
  assert.ok(m.achievements['first-restore']);
  assert.ok(parseSave(seal(m)));
});

test('the session reads the injected clock', () => {
  const was = clock.now;
  let t = 1000;
  clock.now = () => t;
  try {
    const s = new GameSession(journeyLevel(0));
    s.start(); s.resume();
    t += 12_400;
    assert.equal(s.elapsedSeconds(), 12);
    s.pause(); t += 60_000; s.resume(); t += 1000;
    assert.equal(s.elapsedSeconds(), 13);
  } finally { clock.now = was; }
});
