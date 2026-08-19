// E2E smoke: solve today's daily with the greedy solver, submit the replay
// envelope to a running server, expect validation + rank; then verify a
// tampered score is rejected. Usage: node test/e2e.smoke.mjs [port]
import { createGame, applyCommand, legalActions, stateHash, totalScore } from '../src/engine/rules.js';
import { dailyLevel } from '../src/content.js';
import { createRng, rngInt } from '../src/engine/rng.js';

const port = process.argv[2] || 8471;
const base = `http://localhost:${port}`;
const date = new Date().toISOString().slice(0, 10);
const level = dailyLevel(date);

// Greedy solve (same strategy as the winnability property test).
let s = createGame(level);
const rng = createRng(7);
const commands = [];
const hashes = [stateHash(s)];
let guard = 0;
while (s.status === 'active' && guard++ < 8000) {
  const la = legalActions(s);
  let cmd;
  if (la.delivers.length) cmd = { type: 'deliver', cell: la.delivers[0].cell, request: la.delivers[0].request };
  else if (la.merges.length) {
    const m = la.merges.reduce((a, b) => (b.tier > a.tier ? b : a));
    cmd = { type: 'merge', from: m.from, to: m.to };
  } else if (la.taps.length) cmd = { type: 'tap', cell: la.taps[Math.floor(rngInt(rng, 0, la.taps.length - 1))].cell };
  else break;
  const r = applyCommand(s, cmd);
  if (!r.ok) { console.error('solver stuck:', r.error); process.exit(1); }
  s = r.state;
  commands.push(cmd);
  hashes.push(stateHash(s));
}
if (s.status !== 'won') { console.error('daily not won:', s.status, s.terminalReason); process.exit(1); }

const envelope = {
  schema: 1, rulesVersion: s.v, contentVersion: level.version, levelId: level.id,
  seed: level.seed, initialHash: hashes[0], commands, hashes: hashes.slice(1),
  result: { status: s.status, terminalReason: s.terminalReason, score: s.score,
    total: totalScore(s), movesUsed: s.movesUsed, invalidActions: s.stats.invalid, elapsedSeconds: 300 },
};

const post = (body) => fetch(base + '/api/v1/leaderboard/daily', {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Player-Id': 'smoke-tester' },
  body: JSON.stringify(body),
}).then((r) => r.json());

const ok = await post({ date, envelope, name: 'smoke-tester' });
console.log('valid submission:', ok);
if (!ok.ok) process.exit(1);

const bad = JSON.parse(JSON.stringify(envelope));
bad.result.total += 500;
const rejected = await post({ date, envelope: bad, name: 'smoke-tester' });
console.log('tampered submission:', rejected);
if (rejected.ok) { console.error('FAIL: tampered score accepted'); process.exit(1); }

const board = await fetch(base + '/api/v1/leaderboard/daily?date=' + date).then((r) => r.json());
console.log('board entries:', board.entries.length, 'top:', board.entries[0]);
if (!board.entries.length) process.exit(1);

console.log('E2E smoke passed.');
process.exit(0);
