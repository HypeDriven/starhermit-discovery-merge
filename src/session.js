// Session controller: owns the live rules state, the ordered command log
// (replay envelope), undo stack, action-id dedup, and elapsed-time tracking.
// Rendering and UI consume immutable snapshots + event lists from here.

import {
  createGame, applyCommand, noteInvalid, serialize, deserialize, stateHash,
  totalScore, timeBonus, legalActions,
} from './engine/rules.js';

let cmdSeq = 0;

export class GameSession {
  // opts: { allowUndo, onEvents(events, state), onStateChange(state) }
  constructor(level, opts = {}) {
    this.level = level;
    this.opts = opts;
    this.state = createGame(level);
    this.log = [];
    this.undoStack = [];
    this.seenCommandIds = new Set();
    this.startedAt = null;
    this.activeMs = 0;
    this.paused = false;
    this.finished = false;
    this.initialHash = stateHash(this.state);
  }

  start(now = performance.now()) {
    this.startedAt = now;
  }

  pause(now = performance.now()) {
    if (this.paused || this.startedAt === null) return;
    this.activeMs += now - this.startedAt;
    this.startedAt = null;
    this.paused = true;
  }

  resume(now = performance.now()) {
    if (!this.paused) return;
    this.startedAt = now;
    this.paused = false;
  }

  elapsedSeconds(now = performance.now()) {
    let ms = this.activeMs;
    if (this.startedAt !== null) ms += now - this.startedAt;
    return Math.round(ms / 1000);
  }

  // Single entry point for gameplay input. Duplicate command ids are rejected
  // idempotently; invalid actions are counted but never corrupt the log.
  dispatch(cmd, commandId = null) {
    if (this.finished) return { ok: false, error: 'not-active', events: [] };
    const id = commandId || `c${++cmdSeq}`;
    if (this.seenCommandIds.has(id)) {
      return { ok: false, error: 'duplicate', duplicate: true, events: [] };
    }
    this.seenCommandIds.add(id);

    const r = applyCommand(this.state, cmd);
    if (!r.ok) {
      this.state = noteInvalid(this.state);
      this.opts.onEvents?.(r.events, this.state);
      return r;
    }
    this.undoStack.push(serialize(this.state));
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.state = r.state;
    this.log.push({ id, cmd, hash: stateHash(this.state) });
    this.opts.onEvents?.(r.events, this.state);
    this.opts.onStateChange?.(this.state);
    if (this.state.status !== 'active') this.finished = true;
    return r;
  }

  canUndo() {
    return !!this.opts.allowUndo && this.undoStack.length > 0 && !this.finished;
  }

  undo() {
    if (!this.canUndo()) return false;
    const prev = this.undoStack.pop();
    this.state = deserialize(prev);
    // Undo is a session-level rewind, not a replayable command — it never
    // enters the log (ranked modes have undo disabled entirely).
    this.opts.onEvents?.([{ type: 'undo' }], this.state);
    this.opts.onStateChange?.(this.state);
    return true;
  }

  hint() {
    const la = legalActions(this.state);
    if (la.delivers.length) return { kind: 'deliver', ...la.delivers[0] };
    if (la.merges.length) {
      const m = la.merges.reduce((a, b) => (b.tier > a.tier ? b : a));
      return { kind: 'merge', ...m };
    }
    if (la.taps.length) return { kind: 'tap', ...la.taps[0] };
    return null;
  }

  // Replay envelope per spec §5: schema/build/content versions, seed, hashes.
  replayEnvelope() {
    return {
      schema: 1,
      rulesVersion: this.state.v,
      contentVersion: this.level.version,
      levelId: this.level.id,
      seed: this.level.seed,
      initialHash: this.initialHash,
      commands: this.log.map((l) => l.cmd),
      hashes: this.log.map((l) => l.hash),
      result: {
        status: this.state.status,
        terminalReason: this.state.terminalReason,
        score: { ...this.state.score },
        total: totalScore(this.state),
        movesUsed: this.state.movesUsed,
        invalidActions: this.state.stats.invalid,
        elapsedSeconds: this.elapsedSeconds(),
      },
    };
  }

  // Score breakdown for the results screen (time bonus included).
  results() {
    const elapsed = this.elapsedSeconds();
    const tBonus = this.state.status === 'won' ? timeBonus(this.level.parSeconds, elapsed) : 0;
    const c = this.state.score;
    return {
      status: this.state.status,
      terminalReason: this.state.terminalReason,
      components: {
        Merges: c.merge,
        Discoveries: c.discovery,
        Requests: c.request,
        'Move bonus': c.bonus,
        'Time bonus': tBonus,
        Penalties: c.penalty,
      },
      total: totalScore(this.state) + tBonus,
      movesUsed: this.state.movesUsed,
      moveLimit: this.state.moveLimit,
      invalidActions: this.state.stats.invalid,
      elapsedSeconds: elapsed,
      parSeconds: this.level.parSeconds,
      seed: this.level.seed,
    };
  }

  snapshot() {
    return JSON.stringify({
      level: this.level,
      state: serialize(this.state),
      log: this.log,
      activeMs: this.activeMs + (this.startedAt !== null ? performance.now() - this.startedAt : 0),
      finished: this.finished,
    });
  }

  static restore(json, opts = {}) {
    const data = JSON.parse(json);
    const s = new GameSession(data.level, opts);
    s.state = deserialize(data.state);
    s.log = data.log || [];
    s.activeMs = data.activeMs || 0;
    s.finished = !!data.finished;
    s.initialHash = stateHash(createGame(data.level));
    s.paused = true; // caller resumes explicitly
    for (const l of s.log) s.seenCommandIds.add(l.id);
    return s;
  }
}
