// Discovery Merge on the StarHermit engine: the entry module (starhermit.txt
// engine.entry), played natively by the StarHermit client and in browsers by
// the engine's web runtime. The rules (src/engine/rules.js), content
// (src/content.js), session with its replay envelope and snapshots
// (src/session.js) and the save document (src/persist.js) are the browser
// build's, unchanged in what they decide; this module is what src/main.js and
// src/ui.js's PlayController did around them — the screen flow (title →
// modes → journey / setup → the round with its Ready-Set-Go countdown ⇄
// pause → results → next stage / retry / home), the round lifecycle with its
// saved snapshot (Resume paused board on the title), the selection model
// (tap a Field Kit, select a piece, tap a match to merge or an empty cell to
// move, Deliver on a request card, or drag), the lessons' gating, the event
// presentation (a sound, an announcement and the board's animation per rules
// event), Undo (Practice and Learn), Hint and the camera reset, progression,
// achievements, the device's daily board, posting Journey, Daily and
// Challenge totals through score-script.js and the lifecycle (a hidden window pauses the round and
// saves the snapshot, as the browser build's visibilitychange did). The
// screens and HUD are drawn by screens.ts (starhermit:ui), the cabinet by
// render.ts (starhermit:scene).
//
// Time is the runtime's fixed steps (60 a second): the session's clock
// (src/session.js clock) reads them, and the countdown, the input lock after
// an action, the hint's 2.6 s and the 0.7 s before the results wait on the
// same steps, so play scripts replay exactly.
import { clipboard, frame, onFixedUpdate, onPreferencesChange, onQuit, onRender, onResume, onStart, onSuspend, onUpdate, preferences, setFixedRate } from "starhermit:engine";
import { onAction, onPointerButton, onPointerMove, onTouch, vibrate } from "starhermit:input";
import * as ui from "starhermit:ui";
import { onSessionEnded, requestSignIn } from "starhermit:platform";
import { GameSession, clock } from "../src/session.js";
import { ACHIEVEMENTS, clearSnapshot, guestId, loadSave, loadSnapshot, storeSave, storeSnapshot } from "../src/persist.js";
import {
  CHAINS, JOURNEY_COUNT, challengeLevel, dailyLevel, itemLabel, journeyLevel, practiceLevel,
} from "../src/content.js";
import { canMergeItems, isGenerator, isPiece } from "../src/engine/rules.js";
import { hashString } from "../src/engine/rng.js";
import * as audio from "./audio.ts";
import { N, T } from "./i18n.ts";
import * as platform from "./platform.ts";
import { lookFor } from "./quality.ts";
import * as render from "./render.ts";
import { drawScreens } from "./screens.ts";
import { applyContrast, initStyles } from "./style.ts";

// -- the shapes this client reads ------------------------------------------------------
export interface Item { id: string; kind: "piece" | "generator" | "crate"; chain: string; tier: number; webbed?: boolean; charges?: number }
export interface Need { chain: string; tier: number; count: number }
export interface Request { id: string; needs: Need[]; progress: number[]; done: boolean }
export interface State {
  cells: (Item | null)[]; cols: number; rows: number; requests: Request[]; discovered: Record<string, number>;
  score: { merge: number; discovery: number; request: number; bonus: number; penalty: number };
  movesUsed: number; moveLimit: number | null; status: string; terminalReason: string | null;
  stats: { merges: number; spawns: number; delivers: number; moves: number; invalid: number };
}
export interface Step { text: string; require: { type: string; also?: string[] } | null }
export interface Level {
  id: string; name: string; mode: string; seed: number; cols: number; rows: number; theme: string; moveLimit: number | null;
  parSeconds: number | null; mechanics: string[]; requests: { id: string; needs: Need[] }[]; tutorial: { steps: Step[] } | null; ranked: boolean;
}
interface RulesEvent { type: string; item?: Item; to?: number; cell?: number; unwebbed?: boolean; chain?: string; tier?: number }
interface Results {
  status: string; terminalReason: string | null; components: Record<string, number>; total: number; movesUsed: number;
  moveLimit: number | null; invalidActions: number; elapsedSeconds: number; parSeconds: number | null; seed: number;
}
interface Session {
  level: Level; state: State; finished: boolean; log: { id: string; cmd: Record<string, unknown> }[];
  start(): void; pause(): void; resume(): void; elapsedSeconds(): number; canUndo(): boolean; undo(): boolean;
  dispatch(cmd: Record<string, unknown>): { ok: boolean; error?: string; duplicate?: boolean; events: RulesEvent[] };
  hint(): { kind: string; cell?: number; from?: number; to?: number; chain: string; tier: number } | null;
  results(): Results; snapshot(): string;
}
export type Mode = "learn" | "journey" | "daily" | "practice" | "challenge" | "shared";
export type Screen = "title" | "modes" | "journey" | "setup" | "play" | "results";
export type Modal = "pause" | "codex" | "help" | "profile" | "settings" | "erase";
export type SetupView =
  | { kind: "level"; level: Level; mode: Mode; journeyIndex: number | null; ranked: boolean; note: string | null }
  | { kind: "learn" } | { kind: "practice" } | { kind: "challenge" } | { kind: "scores" };

export interface Round {
  session: Session; level: Level; mode: Mode; journeyIndex: number | null;
  selected: number; focus: number; lockMs: number; finishMs: number | null; lessonFinished: boolean;
  hint: { cells: number[]; ms: number } | null; tutorialStep: number;
}
export interface Toast { text: string; until: number; err: boolean }

const STEP_MS = 1000 / 60;
let fixedMs = 0;
clock.now = () => fixedMs;

export const app = {
  screen: "title" as Screen,
  openedFrame: 0,
  focusNext: null as string | null,
  modal: null as Modal | null,
  modalOpened: 0,
  setup: null as SetupView | null,
  round: null as Round | null,
  results: null as { res: Results; unlocked: { id: string; name: string; desc: string }[]; won: boolean } | null,
  lb: null as null | "posting" | platform.Posted,
  countdown: null as { i: number; left: number } | null,
  drawer: null as "left" | "right" | null,
  toasts: [] as Toast[],
  sharedSeed: "",
  /** Request cards' rectangles this frame (window pixels), for drags onto them. */
  requestRects: [] as { id: string; x: number; y: number; w: number; h: number }[],
  /** The open drawer's rectangle (presses there are not the board's). */
  drawerRect: null as { x: number; y: number; w: number; h: number } | null,
  dragOver: null as string | null,
};
export const options = platform.options;
export let save = null as unknown as ReturnType<typeof loadSave>;
const now = (): number => frame().time;

// ------------------------------------------------------------------ helpers
export function announce(text: string, assertive = false): void {
  if (text) ui.announce(text.slice(0, 500), { politeness: assertive ? "assertive" : "polite" });
}
/** src/ui.js toast(): 2.6 s. */
export function toast(text: string, err = false): void {
  app.toasts.push({ text, until: now() + 2.6, err });
  if (app.toasts.length > 3) app.toasts.shift();
}
export function persist(): void { storeSave(save); }
export const itemName = (chain: string, tier: number): string => T(itemLabel(chain, tier));
export const chainName = (chain: string): string => T((CHAINS as Record<string, { name: string }>)[chain]?.name ?? N("Unknown"));
export function guestName(): string { return guestId().replace("guest-", T("Guest ·")); }
export function displayName(): string { return platform.signedIn() ? platform.displayName() : guestName(); }
export const PRACTICE_LABELS: Record<string, string> = { easy: N("Easy"), medium: N("Medium"), hard: N("Hard") };
/** Display name of a level: content keeps the US-English names, translated at display time. */
export function levelName(level: Level): string {
  if (level.mode === "daily") return T("Daily Cabinet — {date}", { date: String(level.id).replace(/^daily-/, "") });
  if (level.mode === "practice") {
    const d = String(level.id).split("-")[1] || "medium";
    return T("Practice ({difficulty})", { difficulty: T(PRACTICE_LABELS[d] || d) });
  }
  return T(level.name);
}
export function restorationFraction(): number { return Object.keys(save.journey.completed).length / JOURNEY_COUNT; }
export function fmtTime(sec: number): string {
  const m = Math.floor(sec / 60), s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}
export function haptic(ms: number): void { if (options.haptics) { try { vibrate(ms); } catch { /* no motor */ } } }

// ------------------------------------------------------------------ navigation
export function show(screen: Screen, focus: string | null = null): void {
  app.screen = screen;
  app.openedFrame = frame().frame;
  app.focusNext = focus;
  app.drawer = null;
  ui.setFocus(null);
  render.setActive(screen === "play" && !!app.round);
}
export function goHome(): void { show("title", "btn-play"); }
/** Opens a dialog over the current one (Settings and Help over the pause menu, the erase check over Settings). */
export function openModal(m: Modal): void {
  modalStack.push(m);
  app.modal = m;
  app.modalOpened = frame().frame;
  ui.setFocus(null);
}
/** A dialog closed: back to the one under it, else the round (if any) runs on. */
export function closeModal(): void {
  modalStack.pop();
  app.modal = modalStack[modalStack.length - 1] ?? null;
  app.modalOpened = frame().frame;
  ui.setFocus(null);
  if (!app.modal && app.round && app.screen === "play" && !app.round.session.finished && !app.countdown) app.round.session.resume();
}
const modalStack: Modal[] = [];
const SETUP_FOCUS: Record<SetupView["kind"], string> = { level: "btn-start", learn: "lesson-0", practice: "practice-easy", challenge: "challenge-frugal-hands", scores: "btn-copy-seed" };
export function openSetup(view: SetupView): void { app.setup = view; show("setup", SETUP_FOCUS[view.kind]); }

// ------------------------------------------------------------------ mode setup (src/main.js)
export function openModeSetup(mode: string): void {
  if (mode === "journey") { show("journey", "stage-1"); return; }
  if (mode === "daily") { openDailySetup(); return; }
  if (mode === "scores") { openSetup({ kind: "scores" }); return; }
  if (mode === "learn") openSetup({ kind: "learn" });
  if (mode === "practice") openSetup({ kind: "practice" });
  if (mode === "challenge") openSetup({ kind: "challenge" });
}
export function openDailySetup(): void {
  const date = platform.todayUTC();
  const done = save.dailies[date];
  openSetup({
    kind: "level", level: dailyLevel(date) as Level, mode: "daily", journeyIndex: null, ranked: !done?.completed,
    note: done?.completed
      ? T("You already completed today’s cabinet (score {score}). Replay for practice — first completion is what ranks.", { score: done.score })
      : T("Today’s cabinet is unclaimed. Your first completion counts for the daily board."),
  });
}
export function openStage(idx: number): void {
  openSetup({ kind: "level", level: journeyLevel(idx) as Level, mode: "journey", journeyIndex: idx, ranked: true, note: null });
}
export function openChallenge(id: string): void {
  openSetup({ kind: "level", level: challengeLevel(id) as Level, mode: "challenge", journeyIndex: null, ranked: true, note: null });
}
export function startPractice(key: string): void {
  // A fresh seed per board (the browser build's Date.now + Math.random), from the platform's clock.
  const seed = hashString("practice:" + platform.nowMs() + ":" + frame().frame) >>> 0;
  startLevel(practiceLevel(key, seed) as Level, "practice");
}
/** Score Chase › Play a shared seed: that day's cabinet, unranked (no daily record) unless it is today's. */
export function playSharedSeed(): void {
  const seed = app.sharedSeed.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(seed) || Number.isNaN(Date.parse(seed + "T00:00:00Z"))) { toast(T("Enter a date as YYYY-MM-DD."), true); return; }
  if (seed === platform.todayUTC()) { openDailySetup(); return; }
  toast(T("Shared challenge seed: {seed}", { seed }));
  openSetup({ kind: "level", level: dailyLevel(seed) as Level, mode: "shared", journeyIndex: null, ranked: false, note: null });
}
export function copySeed(): void {
  const date = platform.todayUTC();
  try { clipboard.writeText(date); toast(T("Seed copied: {seed}", { seed: date })); } catch { toast(T("Shared challenge seed: {seed}", { seed: date })); }
}

// ------------------------------------------------------------------ starting a level
function teardown(): void {
  app.round = null;
  app.countdown = null;
  render.clear();
}
export function startLevel(level: Level, mode: Mode, journeyIndex: number | null = null, restored: Session | null = null): void {
  teardown();
  if (!restored) clearSnapshot();
  const session = restored ?? new GameSession(level, {
    allowUndo: mode === "practice" || mode === "learn",
    onEvents: (events: RulesEvent[]) => {
      // Long-term stat: webs cleared feed the Web Clearer achievement.
      let cleared = 0;
      for (const e of events) if (e.type === "merge" && e.unwebbed) cleared++;
      if (cleared) { save.stats.websCleared = (save.stats.websCleared || 0) + cleared; persist(); }
    },
  }) as unknown as Session;
  const r: Round = {
    session, level, mode, journeyIndex, selected: -1, focus: 0, lockMs: 0, finishMs: null, lessonFinished: false, hint: null, tutorialStep: 0,
  };
  app.round = r;
  lastPlayed = r;
  app.results = null;
  app.lb = null;
  show("play");
  render.setLevel(level, session.state);
  render.setRestoration(restorationFraction());
  render.setSelected(-1);
  render.setHint(null);
  syncFocus();
  const begin = (): void => {
    if (restored) session.resume(); // GameSession.restore() hands back a paused session
    else { session.start(); session.resume(); }
    if (restored) toast(T("Board restored."));
    if (level.tutorial) announceStep();
  };
  if (preferences().reducedMotion) { app.countdown = null; begin(); }
  else { app.countdown = { i: 0, left: 480 }; countdownDone = begin; }
  announce(T("Board"));
}
let countdownDone: (() => void) | null = null;
const COUNT = [N("Ready"), N("Set"), N("Go!")];
export function countdownText(): string | null { return app.countdown ? T(COUNT[app.countdown.i]!) : null; }

export function resumeSnapshot(): void {
  const snap = loadSnapshot();
  if (!snap) return;
  try {
    // Undo stays a practice/learn affordance: resuming a ranked board must not hand it out.
    let snapMode: string | null = null;
    try { snapMode = (JSON.parse(snap) as { level?: { mode?: string } })?.level?.mode ?? null; } catch { snapMode = null; }
    const session = GameSession.restore(snap, { allowUndo: snapMode === "practice" || snapMode === "learn" }) as unknown as Session;
    const level = session.level;
    const mode = (level.mode === "daily" && String(level.id) !== "daily-" + platform.todayUTC() ? "shared" : level.mode) as Mode;
    startLevel(level, mode, level.mode === "journey" ? +String(level.id).split("-")[1]! - 1 : null, session);
  } catch (e) {
    console.warn(`snapshot restore failed: ${String(e)}`);
    clearSnapshot();
  }
}

// ------------------------------------------------------------------ the play controller (src/ui.js)
export const INVALID_TEXT: Record<string, string> = {
  "not-active": N("The round is over."),
  "out-of-moves": N("No moves left."),
  "out-of-bounds": N("That is outside the board."),
  "not-generator": N("Only a Field Kit can produce items."),
  "no-charges": N("That Field Kit is out of charges."),
  "board-full": N("The board is full — merge or deliver something first."),
  "no-piece": N("There is no piece there."),
  "same-cell": N("That is the same cell."),
  "target-occupied": N("That cell is occupied."),
  "target-empty": N("Nothing there to merge with."),
  "mismatch": N("Pieces must be the same kind and tier to merge."),
  "max-tier": N("That discovery is already at its highest tier."),
  "webbed": N("Cobwebbed pieces cannot move. Merge a matching piece onto them."),
  "no-matching-need": N("No open request needs that item."),
  "bad-request": N("That request is already complete."),
};
export function canAct(): boolean {
  const r = app.round;
  return !!r && app.screen === "play" && !app.countdown && !app.modal && !r.session.finished && r.finishMs === null;
}
function currentStep(): Step | null { const r = app.round!; return r.level.tutorial?.steps[r.tutorialStep] ?? null; }
function announceStep(): void {
  const step = currentStep();
  if (step) announce(T(step.text));
}
function tutorialAllows(cmd: Record<string, unknown>): boolean {
  const step = app.round?.level.tutorial ? currentStep() : null;
  if (!step || !step.require) return true;
  return cmd.type === step.require.type || (step.require.also || []).includes(String(cmd.type));
}
function tutorialAdvance(events: RulesEvent[]): void {
  const r = app.round!;
  if (!r.level.tutorial) return;
  const step = currentStep();
  if (!step || !step.require) return;
  if (events.some((e) => e.type === step.require!.type || (step.require!.type === "tap" && e.type === "spawn"))) {
    r.tutorialStep++;
    announceStep();
  }
}
/** The lesson's closing step (no required action): its Finish button shows. */
export function lessonClosing(): boolean { const s = app.round?.level.tutorial ? currentStep() : null; return !!s && s.require === null; }
export function tutorialLine(): string | null {
  const r = app.round;
  const step = r?.level.tutorial ? currentStep() : null;
  if (!r || !step) return null;
  return T("Lesson step {i}/{n}: {text}", { i: r.tutorialStep + 1, n: r.level.tutorial!.steps.length, text: T(step.text) });
}

export function dispatch(cmd: Record<string, unknown>): void {
  const r = app.round;
  if (!r || r.lockMs > 0 || !canAct()) return;
  if (!tutorialAllows(cmd)) {
    audio.cue("invalid");
    haptic(30);
    announce(T("Not yet — {step}", { step: T(currentStep()!.text) }), true);
    toast(T("Not yet — {step}", { step: T(currentStep()!.text) }), true);
    return;
  }
  const res = r.session.dispatch(cmd);
  if (!res.ok) {
    if (res.duplicate) return;
    audio.cue("invalid");
    haptic(30);
    const why = T(INVALID_TEXT[res.error ?? ""] || N("That action is not allowed."));
    announce(why, true);
    toast(why, true);
    if (typeof cmd.cell === "number") render.shakeCell(cmd.cell);
    if (typeof cmd.to === "number") render.shakeCell(cmd.to);
    return;
  }
  playEventSounds(res.events);
  tutorialAdvance(res.events);
  // Brief input lock mirrors the non-interruptible resolution phase.
  r.lockMs = 260;
  r.selected = -1;
  render.syncState(r.session.state, res.events);
  render.setSelected(-1);
  storeSnapshot(r.session.snapshot());
  if (r.session.state.status !== "active") r.finishMs = 700;
}
function playEventSounds(events: RulesEvent[]): void {
  for (const e of events) {
    if (e.type === "spawn") audio.cue("spawn");
    else if (e.type === "merge") { audio.cue("merge"); if (e.unwebbed) audio.cue("webClear"); }
    else if (e.type === "move") audio.cue("move");
    else if (e.type === "deliver") audio.cue("deliver");
    else if (e.type === "discover") { audio.cue("discover"); announce(T("New discovery: {name}!", { name: itemName(e.chain!, e.tier!) })); }
    else if (e.type === "request-complete") { audio.cue("requestComplete"); announce(T("Request complete!")); }
    else if (e.type === "win") audio.cue("win");
    else if (e.type === "lost") audio.cue("lose");
  }
}
export function select(cell: number): void {
  const r = app.round!;
  if (r.selected === cell) cell = -1;
  r.selected = cell;
  audio.cue("select");
  if (cell >= 0) {
    const it = r.session.state.cells[cell];
    if (it && isPiece(it)) announce(T("{name} selected. Choose a matching piece to merge, an empty cell to move, or a request to deliver.", { name: itemName(it.chain, it.tier) }));
  }
  render.setSelected(cell);
}
/** A tap or click on a cell (the 3D board, the 2D board, Enter on the focused cell). */
export function cellTap(cell: number): void {
  const r = app.round;
  if (!r || cell < 0 || r.lockMs > 0 || !canAct()) return;
  r.focus = cell;
  syncFocus();
  const st = r.session.state;
  const it = st.cells[cell];
  if (r.selected >= 0 && r.selected !== cell) {
    const sel = st.cells[r.selected];
    if (sel && isPiece(sel)) {
      if (it && isPiece(it)) { dispatch({ type: "merge", from: r.selected, to: cell }); return; }
      if (!it) { dispatch({ type: "move", from: r.selected, to: cell }); return; }
    }
  }
  if (it && isGenerator(it)) { audio.cue("tap"); dispatch({ type: "tap", cell }); return; }
  if (it && isPiece(it)) { select(cell); return; }
  if (it?.kind === "crate") { audio.cue("invalid"); announce(T("A crate blocks that cell."), true); return; }
  // Empty cell tap with nothing selected: acknowledge quietly.
  audio.cue("tap");
}
export function deliverSelected(requestId: string): void {
  const r = app.round;
  if (!r) return;
  if (r.selected < 0) { announce(T("Select a piece first, then deliver it."), true); return; }
  dispatch({ type: "deliver", cell: r.selected, request: requestId });
}
/** Whether the selected piece can go to a request (its Deliver button). */
export function canDeliver(req: Request): boolean {
  const r = app.round!;
  const sel = r.selected >= 0 ? r.session.state.cells[r.selected] : null;
  return !!sel && sel.kind === "piece" && !sel.webbed && req.needs.some((n, i) => req.progress[i]! < n.count && n.chain === sel.chain && n.tier === sel.tier);
}
/** The cells the selected piece may merge onto (the 2D board's marks). */
export function mergeTargets(): Set<number> {
  const out = new Set<number>();
  const r = app.round;
  if (!r || r.selected < 0) return out;
  const st = r.session.state;
  const sel = st.cells[r.selected];
  if (!sel || !isPiece(sel) || sel.webbed) return out;
  for (let i = 0; i < st.cells.length; i++) if (i !== r.selected && canMergeItems(st, sel, st.cells[i])) out.add(i);
  return out;
}
export function showHint(): void {
  const r = app.round;
  if (!r || !canAct()) return;
  if (!options.hintsEnabled) { toast(T("Hints are turned off in Settings.")); return; }
  const hint = r.session.hint();
  if (!hint) { announce(T("No moves available."), true); toast(T("No moves available.")); return; }
  audio.cue("hint");
  render.setHint(hint);
  r.hint = { cells: hint.kind === "merge" ? [hint.from!, hint.to!] : [hint.cell!], ms: 2600 };
  const text = hint.kind === "tap"
    ? T("Hint: tap the Field Kit for {chain}.", { chain: chainName(hint.chain) })
    : hint.kind === "merge"
      ? T("Hint: merge the two {name} pieces.", { name: itemName(hint.chain, hint.tier) })
      : T("Hint: deliver the {name} to its request.", { name: itemName(hint.chain, hint.tier) });
  announce(text);
  toast(text);
}
export function doUndo(): void {
  const r = app.round;
  if (!r || !canAct()) return;
  if (r.session.undo()) {
    audio.cue("undo");
    announce(T("Undone."));
    r.selected = -1;
    render.syncState(r.session.state, []);
    render.setSelected(-1);
  } else { audio.cue("invalid"); announce(T("Undo is not available here."), true); }
}
export function undoShown(): boolean { const m = app.round?.mode; return m === "practice" || m === "learn"; }
export function resetCamera(): void { render.resetCamera(); }
function syncFocus(): void { const r = app.round; render.setDragTarget(r && !dragging ? r.focus : -1); }

// ------------------------------------------------------------------ pause
export function openPause(): void {
  const r = app.round;
  if (!r || r.session.finished || app.modal || app.screen !== "play") return;
  r.session.pause();
  storeSnapshot(r.session.snapshot());
  announce(T("Paused."));
  modalStack.length = 0;
  openModal("pause");
}
export function resumeRound(): void {
  modalStack.length = 0;
  app.modal = null;
  if (app.round && !app.round.session.finished && !app.countdown) app.round.session.resume();
  announce(T("Resumed."));
}
export function leaveRound(): void {
  modalStack.length = 0;
  app.modal = null;
  teardown();
  goHome();
}

// ------------------------------------------------------------------ finish and results
export function finishLevel(lessonFinished = false): void {
  const r = app.round;
  if (!r || app.screen !== "play") return;
  const { session, level, mode, journeyIndex } = r;
  session.pause();
  clearSnapshot();
  const res = session.results();
  if (lessonFinished && mode === "learn") { res.status = "won"; res.terminalReason = "lesson-complete"; }
  const won = res.status === "won";
  save.stats.sessions++;
  save.stats.merges += session.state.stats.merges;
  const today = platform.todayUTC();
  if (won) {
    if (mode === "journey" && journeyIndex !== null) {
      const prev = save.journey.completed[journeyIndex];
      if (!prev || res.total > prev.score) save.journey.completed[journeyIndex] = { score: res.total, moves: res.movesUsed, seconds: res.elapsedSeconds };
    } else if (mode === "daily") {
      if (!save.dailies[today]) {
        save.dailies[today] = { score: res.total, completed: true };
        if (!save.dailyStreakDays.includes(today)) save.dailyStreakDays.push(today);
      } else if (res.total > save.dailies[today].score) save.dailies[today].score = res.total;
    } else if (mode === "learn") save.stats.lessonsDone[level.id] = true;
    // Codex: fold discoveries into the long-term collection.
    for (const [chain, tier] of Object.entries(session.state.discovered)) save.codex[chain] = Math.max(save.codex[chain] ?? -1, tier);
  }
  persist();
  const unlocked = checkAchievements(session, won);
  // Daily board (local to this device).
  if (won && mode === "daily" && save.dailies[today]) {
    save.leaderboardLocal.push({ name: displayName(), score: res.total, moves: res.movesUsed, seconds: res.elapsedSeconds, date: today, me: true });
    const days = [...new Set(save.leaderboardLocal.map((e: { date: string }) => e.date))].sort().slice(-14);
    save.leaderboardLocal = save.leaderboardLocal.filter((e: { date: string }) => days.includes(e.date));
    persist();
    toast(T("Daily score saved to this device’s board."));
  }
  app.results = { res, unlocked, won };
  if (unlocked.length) audio.cue("achievement");
  const headline = resultHeadline();
  announce(T("{headline} Total score {total}.", { headline, total: res.total }), true);
  postToLeaderboard(r, res);
  show("results", "btn-retry");
  render.setActive(false);
}
export function resultHeadline(x = app.results!): string {
  return T(x.won ? N("Cabinet restored!") : x.res.terminalReason === "out-of-moves" ? N("Out of actions")
    : x.res.terminalReason === "no-legal-moves" ? N("The board locked up") : N("Round over"));
}
function checkAchievements(session: Session, won: boolean): { id: string; name: string; desc: string }[] {
  const got: { id: string; name: string; desc: string }[] = [];
  const grant = (id: string): void => {
    if (!save.achievements[id]) {
      save.achievements[id] = new Date(platform.nowMs()).toISOString();
      got.push(ACHIEVEMENTS.find((a) => a.id === id)!);
    }
  };
  if (won) grant("first-restore");
  for (const tier of Object.values(session.state.discovered)) if (tier >= 4) grant("deep-discovery");
  if ((save.stats.websCleared || 0) >= 10) grant("web-clearer");
  if (save.dailyStreakDays.length >= 3) grant("steady-hands");
  if ([7, 15, 23, 31, 39].every((i) => save.journey.completed[i])) grant("mastery-archivist");
  if (Object.keys(save.journey.completed).length >= JOURNEY_COUNT) grant("grand-curator");
  persist();
  return got;
}
/** Signed in: Journey, Daily and Challenge totals go to the high-score board through score-script.js (src/main.js postToLeaderboard). */
function postToLeaderboard(r: Round, res: Results): void {
  app.lb = null;
  if (!platform.signedIn() || (r.mode !== "journey" && r.mode !== "daily" && r.mode !== "challenge")) return;
  app.lb = "posting";
  const results = app.results;
  void platform.postLeaderboard(res.total).then((p) => { if (app.results === results) app.lb = p; });
}
export function leaderboardLine(): string | null {
  const lb = app.lb;
  if (!lb) return null;
  if (lb === "posting") return T("Posting score to the leaderboard…");
  if (!lb.posted) return T("Score not posted to the leaderboard.");
  return lb.rank ? T("Leaderboard rank: #{rank}", { rank: lb.rank }) : T("Score posted to the leaderboard.");
}
let lastPlayed: Round | null = null;
export function retry(): void { const r = lastPlayed; if (r) startLevel(r.level, r.mode, r.journeyIndex); }
export function hasNext(): boolean {
  const r = lastPlayed, x = app.results;
  return !!r && !!x && r.mode === "journey" && x.won && r.journeyIndex !== null && r.journeyIndex + 1 < JOURNEY_COUNT;
}
export function nextStage(): void { const r = lastPlayed!; startLevel(journeyLevel(r.journeyIndex! + 1) as Level, "journey", r.journeyIndex! + 1); }
export function resultsHome(): void { teardown(); app.results = null; goHome(); }

// ------------------------------------------------------------------ settings and account
export function replayTutorials(): void { save.stats.lessonsDone = {}; persist(); toast(T("Lessons reset — replay them from Learn.")); }
export function eraseProgress(): void {
  clearSnapshot();
  platform.eraseSave();
  const fresh = loadSave();
  adoptSave(fresh as unknown as Record<string, unknown>);
  persist();
  modalStack.length = 0;
  app.modal = null;
  toast(T("Progress erased."));
  goHome();
}
/** Replace the save in place (its fields are read everywhere through `save`). */
function adoptSave(next: Record<string, unknown>): void {
  const s = save as unknown as Record<string, unknown>;
  for (const k of Object.keys(s)) delete s[k];
  Object.assign(s, next);
}
export function copyInvite(): void {
  const link = platform.inviteLink();
  if (!link) return;
  try { clipboard.writeText(link); toast(T("Invite link copied to the clipboard.")); }
  catch { toast(T("Could not copy — invite link: {link}", { link })); }
}
export function signIn(): void { void requestSignIn().catch(() => undefined); }
platform.onAdopt((doc) => {
  adoptSave(doc as unknown as Record<string, unknown>);
  toast(T("progress synced"));
});

// ------------------------------------------------------------------ input
function moveFocus(dc: number, dr: number): void {
  const r = app.round!;
  const { cols, rows } = r.level;
  const c = r.focus % cols, row = Math.floor(r.focus / cols);
  const nc = Math.min(cols - 1, Math.max(0, c + dc)), nr = Math.min(rows - 1, Math.max(0, row + dr));
  r.focus = nr * cols + nc;
  syncFocus();
  announce(cellLabel(r.focus));
}
/** A cell's spoken description (src/ui.js DomBoard.describeCell). */
export function cellLabel(i: number): string {
  const r = app.round!;
  const it = r.session.state.cells[i];
  const pos = T("row {row}, column {col}", { row: Math.floor(i / r.level.cols) + 1, col: (i % r.level.cols) + 1 });
  if (!it) return T("Empty cell, {pos}", { pos });
  if (it.kind === "generator") return T("Field Kit generator for {chain}, {pos}. Activate to produce an item.", { chain: chainName(it.chain), pos });
  if (it.kind === "crate") return T("Crate blocking the cell, {pos}", { pos });
  const name = itemName(it.chain, it.tier);
  return it.webbed ? T("{name}, tier {tier}, cobwebbed — cannot move, {pos}", { name, tier: it.tier + 1, pos }) : T("{name}, tier {tier}, {pos}", { name, tier: it.tier + 1, pos });
}
onAction((e) => {
  if (!e.pressed) return;
  const fresh = frame().frame !== app.openedFrame && frame().frame !== app.modalOpened;
  if (app.modal) return; // dialogs take their own keys
  if (app.screen !== "play") {
    // Escape on a list screen goes back, as its Back button.
    if (e.action === "cancel" && fresh && !ui.capturingKeys()) {
      if (app.screen === "journey" || app.screen === "setup") show("modes");
      else if (app.screen === "modes") goHome();
    }
    return;
  }
  const r = app.round;
  if (!r) return;
  if (e.action === "pause") { if (fresh) openPause(); return; }
  if (e.action === "cancel") {
    if (!fresh) return;
    if (app.drawer) { app.drawer = null; return; }
    if (r.selected >= 0) { r.selected = -1; render.setSelected(-1); } else openPause();
    return;
  }
  if (!canAct()) return;
  switch (e.action) {
    case "up": ui.setFocus(null); moveFocus(0, -1); break;
    case "down": ui.setFocus(null); moveFocus(0, 1); break;
    case "left": ui.setFocus(null); moveFocus(-1, 0); break;
    case "right": ui.setFocus(null); moveFocus(1, 0); break;
    case "select": if (!ui.focused()) cellTap(r.focus); break;
    case "hint": showHint(); break;
    case "undo": if (undoShown()) doUndo(); break;
    case "camera": resetCamera(); break;
  }
});

// Board presses (the 3D board only; the 2D board's cells are widgets): a tap
// acts on the cell, a drag of a free piece (past 12 px) selects it and drops
// it on a piece (merge), an empty cell (move) or a request card (deliver).
// The playfield is the part of the window the HUD leaves, so a press there
// is the board's; presses are queued and decided after the frame's UI is
// built, when the playfield's and the cards' rectangles are this frame's.
let down: { cell: number; x: number; y: number; dragging: boolean } | null = null;
let dragging = false;
let lastTouch = -1e9;
const queued: { kind: "down" | "move" | "up" | "cancel"; x: number; y: number }[] = [];
const inRect = (x: number, y: number, q: { x: number; y: number; w: number; h: number } | null): boolean => !!q && x >= q.x && y >= q.y && x <= q.x + q.w && y <= q.y + q.h;
function inPlayfield(x: number, y: number): boolean {
  return app.screen === "play" && !!app.round && !options.domBoard && inRect(x, y, render.playfield()) && !inRect(x, y, app.drawerRect);
}
function requestAt(x: number, y: number): string | null { return app.requestRects.find((q) => inRect(x, y, q))?.id ?? null; }
function boardDown(x: number, y: number): void {
  if (!inPlayfield(x, y) || app.modal) { down = null; return; }
  if (app.drawer) { app.drawer = null; down = null; return; } // a press on the board closes the drawers
  down = { cell: render.pick(x, y), x, y, dragging: false };
}
function boardMove(x: number, y: number): void {
  const r = app.round;
  if (!down || !r) return;
  if (!down.dragging && Math.hypot(x - down.x, y - down.y) > 12 * frame().scale) {
    const it = r.session.state.cells[down.cell];
    if (canAct() && r.lockMs <= 0 && it && isPiece(it) && !it.webbed) {
      down.dragging = dragging = true;
      r.selected = -1;
      select(down.cell);
    }
  }
  if (down.dragging) {
    render.setDragTarget(render.pick(x, y));
    app.dragOver = requestAt(x, y);
  }
}
function boardUp(x: number, y: number, cancelled: boolean): void {
  const d = down;
  down = null;
  dragging = false;
  app.dragOver = null;
  syncFocus();
  if (!d || cancelled) return;
  if (!d.dragging) { if (d.cell >= 0) cellTap(d.cell); return; }
  const req = requestAt(x, y);
  if (req) { dispatch({ type: "deliver", cell: d.cell, request: req }); return; }
  const target = render.pick(x, y);
  if (target < 0 || target === d.cell) return;
  const it = app.round?.session.state.cells[target];
  if (it && isPiece(it)) dispatch({ type: "merge", from: d.cell, to: target });
  else if (!it) dispatch({ type: "move", from: d.cell, to: target });
  else dispatch({ type: "merge", from: d.cell, to: target }); // produces the right invalid reason
}
function boardInput(): void {
  for (const q of queued.splice(0)) {
    if (q.kind === "down") boardDown(q.x, q.y);
    else if (q.kind === "move") boardMove(q.x, q.y);
    else boardUp(q.x, q.y, q.kind === "cancel");
  }
}
onPointerButton((e) => {
  if (e.button !== 0 || now() - lastTouch < 0.6) return;
  queued.push({ kind: e.pressed ? "down" : "up", x: e.x, y: e.y });
});
onPointerMove((x, y) => { if (down && now() - lastTouch >= 0.6) queued.push({ kind: "move", x, y }); });
onTouch((e) => {
  if (!e.primary || e.control) return;
  lastTouch = now();
  if (e.phase === "start") queued.push({ kind: "down", x: e.x, y: e.y });
  else if (e.phase === "move") queued.push({ kind: "move", x: e.x, y: e.y });
  else if (e.phase === "end") queued.push({ kind: "up", x: e.x, y: e.y });
  else queued.push({ kind: "cancel", x: e.x, y: e.y });
});

// ------------------------------------------------------------------ boot and lifecycle
let lookKey = "";
function applyLook(): void {
  const f = frame();
  const k = `${f.quality}:${f.levelIndex}`;
  if (k === lookKey) return;
  lookKey = k;
  render.applyLook(lookFor(f.quality, f.levelIndex));
}
function applyOptions(): void { render.setOptions({ highContrast: ui.preferences().highContrast, cameraTilt: options.cameraTilt }); }
platform.onOptionsChange(applyOptions);

onStart(() => {
  setFixedRate(60);
  initStyles();
  platform.initPlatform();
  save = loadSave();
  audio.loadSfx();
  audio.startRound();
  render.setReducedMotion(preferences().reducedMotion);
  applyLook();
  applyOptions();
  render.setActive(false);
  goHome();
});
onPreferencesChange((p) => { render.setReducedMotion(p.reducedMotion); applyOptions(); });
onSessionEnded(() => toast(T("cloud sync unavailable")));
let hidden = false;
function saveRound(): void { const r = app.round; if (r && !r.session.finished && app.screen === "play") storeSnapshot(r.session.snapshot()); }
onSuspend(() => {
  hidden = true;
  audio.setSuspended(true);
  // A hidden window pauses the round and keeps its snapshot (src/main.js visibilitychange).
  if (app.round && app.screen === "play" && !app.round.session.finished) { app.round.session.pause(); saveRound(); }
  platform.flush();
});
onResume(() => {
  hidden = false;
  audio.setSuspended(false);
  if (app.round && app.screen === "play" && !app.modal && !app.countdown && !app.round.session.finished) {
    app.round.session.resume();
    toast(T("Welcome back — the cabinet waited for you."));
  }
});
onQuit(() => { saveRound(); platform.flush(); });

let snapMs = 0;
onFixedUpdate(() => {
  if (hidden) return;
  fixedMs += STEP_MS;
  render.tick(STEP_MS);
  const c = app.countdown;
  if (c && !app.modal) {
    c.left -= STEP_MS;
    if (c.left <= 0) {
      c.i++;
      if (c.i < COUNT.length) c.left = 480;
      else { app.countdown = null; const d = countdownDone; countdownDone = null; d?.(); }
    }
    return;
  }
  const r = app.round;
  if (!r || app.screen !== "play") return;
  if (r.lockMs > 0) r.lockMs -= STEP_MS;
  if (r.hint) { r.hint.ms -= STEP_MS; if (r.hint.ms <= 0) { r.hint = null; render.setHint(null); } }
  if (r.finishMs !== null) {
    r.finishMs -= STEP_MS;
    if (r.finishMs <= 0) { r.finishMs = null; finishLevel(); return; }
  }
  // Periodic snapshot of the board in play (src/main.js did it every second).
  snapMs += STEP_MS;
  if (snapMs >= 5000) { snapMs = 0; if (!app.modal && !r.session.finished) storeSnapshot(r.session.snapshot()); }
});

let frameDt = 0;
let hcWas: boolean | null = null;
onUpdate((dt) => {
  frameDt = dt;
  applyLook();
  audio.update();
  const hc = ui.preferences().highContrast;
  applyContrast(hc);
  if (hcWas !== null && hcWas !== hc) applyOptions();
  hcWas = hc;
  const t = now();
  app.toasts = app.toasts.filter((x) => x.until >= t);
});
onRender(() => {
  drawScreens();
  boardInput();
  render.update(frameDt);
});

