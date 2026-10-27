// score-script.js, the server's judge of ranked rounds (node --test): it is
// evaluated as the platform's sandbox runs it (one classic script, no Date or
// Math.random), and fed rounds played here by a greedy player through the same
// rules: it accepts what was played with the score it computes itself, and
// refuses tampered logs, unfinished rounds, unknown boards and stale dailies.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { applyCommand, createGame, legalActions, timeBonus, totalScore } from '../src/engine/rules.js';
import { challengeLevel, dailyLevel, journeyLevel } from '../src/content.js';

const ROOT = new URL('..', import.meta.url).pathname;
const sandbox = vm.createContext({ Date: undefined, Math: Object.assign(Object.create(Math), { random: undefined }) });
sandbox.globalThis = sandbox;
vm.runInContext(readFileSync(ROOT + 'score-script.js', 'utf8'), sandbox);
const game = sandbox.game;

function play(level) {
  let st = createGame(level);
  const cmds = [];
  for (let k = 0; k < 600 && st.status === 'active'; k++) {
    const la = legalActions(st);
    const c = la.delivers[0] ? { type: 'deliver', cell: la.delivers[0].cell, request: la.delivers[0].request }
      : la.merges[0] ? { type: 'merge', from: la.merges[0].from, to: la.merges[0].to }
        : la.taps[0] ? { type: 'tap', cell: la.taps[0].cell } : null;
    if (!c) break;
    const r = applyCommand(st, c);
    assert.ok(r.ok);
    st = r.state;
    cmds.push(c);
  }
  return { st, cmds };
}
const NOW = Date.UTC(2026, 9, 27, 12, 0, 0);
function send(data, now = NOW) {
  const r = game.onPlayerMessage({ now, random: 0.5, sessionId: 's', players: [], sessionState: {}, message: { from: 'u1', data } });
  assert.equal(r.ok, true);
  return { ack: r.broadcast[0].data, scores: r.scores, result: r.result };
}

test('the RULES block matches src/', () => {
  execFileSync('node', [ROOT + 'tools/build-score-script.mjs', '--check'], { stdio: 'pipe' });
});

test('a won journey stage scores the rules total plus the time bonus, by the server', () => {
  const level = journeyLevel(0);
  const { st, cmds } = play(level);
  assert.equal(st.status, 'won');
  const { ack, scores, result } = send({ type: 'result', mode: 'journey', ref: 0, commands: cmds, elapsedSeconds: 20 });
  const want = totalScore(st) + timeBonus(level.parSeconds, 20);
  assert.deepEqual([...ack.accepted], ['high-score']);
  assert.equal(ack.score, want);
  assert.equal(scores['high-score'].u1, want);
  assert.equal(result.kind, 'finished');
});

test('a claimed time below the input-lock floor counts as the floor', () => {
  const level = journeyLevel(0);
  const { st, cmds } = play(level);
  const { ack } = send({ type: 'result', mode: 'journey', ref: 0, commands: cmds, elapsedSeconds: 0 });
  assert.equal(ack.score, totalScore(st) + timeBonus(level.parSeconds, Math.floor(cmds.length * 0.26)));
});

test('challenges and today’s (or yesterday’s) daily are judged; other days are not', () => {
  const ch = play(challengeLevel('crowded-shelves'));
  if (ch.st.status !== 'active') assert.ok(send({ type: 'result', mode: 'challenge', ref: 'crowded-shelves', commands: ch.cmds, elapsedSeconds: 60 }).ack.accepted.length === 1);
  const today = play(dailyLevel('2026-10-27'));
  if (today.st.status !== 'active') {
    assert.equal(send({ type: 'result', mode: 'daily', ref: '2026-10-27', commands: today.cmds, elapsedSeconds: 90 }).ack.accepted.length, 1);
    assert.equal(send({ type: 'result', mode: 'daily', ref: '2026-10-27', commands: today.cmds, elapsedSeconds: 90 }, NOW + 86400000).ack.accepted.length, 1);
    assert.equal(send({ type: 'result', mode: 'daily', ref: '2026-10-27', commands: today.cmds, elapsedSeconds: 90 }, NOW + 2 * 86400000).ack.accepted.length, 0);
  }
});

test('tampered, unfinished and unknown rounds are refused', () => {
  const { cmds } = play(journeyLevel(0));
  const refused = (data) => { const { ack, scores } = send(data); assert.equal(ack.accepted.length, 0); assert.equal(ack.score, null); assert.equal(scores['high-score'], undefined); };
  refused({ type: 'result', mode: 'journey', ref: 0, commands: cmds.slice(0, -1), elapsedSeconds: 20 }); // never finished
  refused({ type: 'result', mode: 'journey', ref: 0, commands: [{ type: 'merge', from: 0, to: 1 }, ...cmds], elapsedSeconds: 20 }); // an illegal action
  refused({ type: 'result', mode: 'journey', ref: 1, commands: cmds, elapsedSeconds: 20 }); // another stage's board
  refused({ type: 'result', mode: 'journey', ref: 40, commands: cmds, elapsedSeconds: 20 });
  refused({ type: 'result', mode: 'practice', ref: 'easy', commands: cmds, elapsedSeconds: 20 });
  refused({ type: 'result', mode: 'challenge', ref: 'nope', commands: cmds, elapsedSeconds: 20 });
  refused({ type: 'result', mode: 'journey', ref: 0, commands: 'x', elapsedSeconds: 20 });
  assert.equal(game.onPlayerMessage({ now: NOW, message: { from: 'u1', data: { type: 'nope' } } }).ok, false);
});
