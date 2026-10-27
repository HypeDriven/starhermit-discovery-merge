// The browser build's DOM shell (index.html + src/main.js + src/ui.js +
// css/style.css) as starhermit:ui, built every frame: the top bar (the
// compass and title, the account / sync line, Help, Codex and Settings), the
// title (key art, tagline, Play, Daily Cabinet / Journey / Curator Profile,
// sign-in / invite, Resume paused board), the mode grid, the Journey's five
// scenes of eight stages, the set-up screens (a level's rules, duration,
// seed and ranked flag before Start; the Learn, Practice and Challenge lists;
// Score Chase with this device's daily board and the shared seed), the round
// (the Requests rail with the lesson panel, the board — the 3D cabinet framed
// into the playfield, or the 2D board — and the status rail with Pause, Undo,
// Hint and Reset camera; on narrower windows the rails are drawers opened
// from the thumb tray), the Ready-Set-Go countdown, the results, the dialogs
// (pause, Codex, How to play, Curator Profile, Settings, the erase check) and
// the toasts. The browser's media queries are layouts picked by the window's
// logical size: wide (≥ 1024 px: rails beside the board), compact (drawers
// and the tray); the left-handed option swaps the rails and the tray.
import { frame, openMenu } from "starhermit:engine";
import { bindingLabel, requestRebind } from "starhermit:input";
import * as draw from "starhermit:draw";
import * as ui from "starhermit:ui";
import { ACHIEVEMENTS, loadSnapshot } from "../src/persist.js";
import { CHAINS, CHAIN_IDS, CHALLENGES, JOURNEY_COUNT, PRACTICE_DIFFICULTIES, THEMES, itemIcon, journeyLevel, tutorialLevels } from "../src/content.js";
import { totalScore } from "../src/engine/rules.js";
import { drawIcon } from "./icons.ts";
import { N, T } from "./i18n.ts";
import * as platform from "./platform.ts";
import * as render from "./render.ts";
import {
  PRACTICE_LABELS, app, canDeliver, cellLabel, cellTap, chainName, closeModal, copyInvite, copySeed, countdownText, deliverSelected,
  displayName, doUndo, eraseProgress, finishLevel, fmtTime, goHome, guestName, hasNext, itemName, leaderboardLine, leaveRound,
  lessonClosing, levelName, mergeTargets, nextStage, openChallenge, openDailySetup, openModal, openModeSetup, openPause, openStage,
  options, playSharedSeed, replayTutorials, resetCamera, resultHeadline, resultsHome, resumeRound, resumeSnapshot, retry, save, show,
  showHint, signIn, startLevel, startPractice, tutorialLine, undoShown, type Level, type Request,
} from "./main.ts";
import { ink } from "./style.ts";

// ------------------------------------------------------------------ layout
interface Layout { lw: number; lh: number; sc: number; ox: number; oy: number; wide: boolean; phone: boolean; shortLand: boolean }
function layoutNow(): Layout {
  const f = frame();
  const sc = ui.preferences().scale;
  const sa = f.safeArea;
  const lw = Math.max(1, (f.width - sa.left - sa.right) / sc), lh = Math.max(1, (f.height - sa.top - sa.bottom) / sc);
  const shortLand = lw > lh && lh <= 520;
  return { lw, lh, sc, ox: sa.left / sc, oy: sa.top / sc, wide: !shortLand && lw >= 1024, phone: lw < 560, shortLand };
}
const lastHeight = new Map<string, number>();
const pr = (): ui.UiPreferences => ui.preferences();
function textWidth(text: string, style: string | readonly string[], kind?: "button" | "heading"): number {
  return ui.measureText(text, { ...(kind ? { kind } : {}), style: typeof style === "string" ? style : [...style] }).width / pr().scale;
}
const buttonWidth = (text: string, style: readonly string[]): number => textWidth(text, style, "button") + 4;

interface Btn { id: string; text: string; style?: string[]; disabled?: boolean; act: () => void; width?: number }
const PLAIN = ["btn"];
/** A button `width` wide (null: its text's); a label too long for it wraps inside. */
function button(b: Btn, width: number | null = null): void {
  const style = b.style ?? PLAIN;
  const opts: ui.ButtonOptions = {};
  if (b.disabled) opts.disabled = true;
  const s: ui.Style = width != null ? { width } : {};
  if (width != null && buttonWidth(b.text, style) > width) {
    const inner = Math.max(20, width - 36);
    opts.content = () => { ui.style({ text: { align: "center" } }).paragraph(b.text, inner); };
  }
  if (ui.style(...style, s).id(b.id).button(b.text, opts)) b.act();
}
/** Buttons at their own widths in rows that wrap at `width` (CSS flex-wrap). */
function flow(label: string, list: Btn[], width: number, align: "start" | "center" | "end" = "start", gap = 10): void {
  const rows: Btn[][] = [[]];
  let used = 0;
  for (const b of list) {
    const bw = Math.min(width, b.width ?? buttonWidth(b.text, b.style ?? PLAIN));
    if (rows[rows.length - 1]!.length && used + gap + bw > width) { rows.push([]); used = 0; }
    used += (rows[rows.length - 1]!.length ? gap : 0) + bw;
    rows[rows.length - 1]!.push(b);
  }
  ui.column(label, () => {
    rows.forEach((row, ri) => ui.row(`${label}-r${ri}`, () => {
      for (const b of row) button(b, b.width ?? (buttonWidth(b.text, b.style ?? PLAIN) > width ? width : null));
    }, { spacing: gap, align: "center" }));
  }, { spacing: gap, align, width });
}
/** Text up to `width` wide: one label when it fits, else a paragraph. */
function para(text: string, width: number, cls = "body", id?: string, center = false): void {
  if (!text) return;
  const styles: (string | ui.Style)[] = [cls];
  if (center) styles.push({ text: { align: "center" } });
  let u = ui.style(...styles);
  if (id) u = u.id(id);
  if (ui.measureText(text, { style: styles }).width / pr().scale <= width) u.label(text);
  else u.paragraph(text, width);
}
function heading(cls: string, text: string, width: number, id?: string): void {
  if (ui.measureText(text, { kind: "heading", style: [cls] }).width / pr().scale <= width) (id ? ui.id(id) : ui).style(cls).heading(text);
  else ui.style(cls).paragraph(text, width);
}
/** An emoji icon of the atlas as a small inline widget. */
function icon(emoji: string, size: number, dim = false): void {
  ui.widget("", { role: "none", size: { width: size, height: size }, draw: (r) => drawIcon(emoji, r.x, r.y, r.width, dim ? { alpha: 0.4, grey: true } : {}) });
}
/** An image cover-fitted into a box with rounded corners (a panel fallback colour while it loads). */
function art(id: string, path: string, w: number, h: number, radius: number): void {
  const P = ink(pr().highContrast);
  ui.id(id).widget("", {
    role: "none", size: { width: w, height: h },
    draw: (r, s) => draw.box(r.x, r.y, r.width, r.height, {
      background: [{ image: path, size: "cover" }, P.panel2], radius: radius * s.scale,
      border: { width: s.scale, color: P.line }, shadow: { y: 12 * s.scale, blur: 40 * s.scale, color: "#0000008c" },
    }),
  });
}
const keyName = (action: string): string => bindingLabel(action, "keyboard") || "—";

// ------------------------------------------------------------------ the frame
export function drawScreens(): void {
  const L = layoutNow();
  const f = frame();
  const P = ink(pr().highContrast);
  app.requestRects = [];
  app.drawerRect = null;
  if (app.screen !== "play") draw.rect(0, 0, f.width, f.height, P.bg);
  const top = topbar(L);
  switch (app.screen) {
    case "title": titleScreen(L, top); break;
    case "modes": modesScreen(L, top); break;
    case "journey": journeyScreen(L, top); break;
    case "setup": setupScreen(L, top); break;
    case "play": playScreen(L, top); break;
    case "results": resultsScreen(L, top); break;
  }
  dialogs(L);
  toasts(L);
  if (app.focusNext && !app.modal) {
    const age = f.frame - app.openedFrame;
    if (age >= 1) ui.setFocus(app.focusNext);
    if (age >= 3) app.focusNext = null;
  }
}

function topbar(L: Layout): number {
  const st = platform.syncState();
  const status = platform.signedIn()
    ? T("Playing as {name}", { name: platform.displayName() || "…" }) + " · " + T(st === "synced" ? N("progress synced") : st === "saving" ? N("saving…") : N("cloud sync unavailable"))
    : T("Local play — fully playable");
  const btns: Btn[] = [
    { id: "btn-help", text: T("Help"), style: ["top-btn"], act: () => openModal("help") },
    { id: "btn-codex", text: T("Codex"), style: ["top-btn"], act: () => openModal("codex") },
    { id: "btn-settings", text: T("Settings"), style: ["top-btn"], act: () => openModal("settings") },
  ];
  const btnW = btns.reduce((a, b) => a + buttonWidth(b.text, b.style!) + 6, 0);
  const brandW = 28 + textWidth("Discovery Merge", "brand");
  const inner = L.lw - 24;
  const wrap = L.phone || brandW + btnW + textWidth(status, "status") + 40 > inner;
  const brand = (): ui.Rect => ui.row("brand", () => { icon("🧭", 24); ui.style("brand").heading("Discovery Merge"); }, { spacing: 8, align: "center" });
  const actions = (): ui.Rect => ui.row("top-actions", () => { for (const b of btns) button(b); }, { spacing: 6, align: "center" });
  const r = ui.place("topbar", { anchor: "top-start", x: 0, y: 0 }, () => {
    if (!wrap) {
      ui.row("topbar-row", () => {
        brand();
        ui.spacer();
        para(status, Math.max(80, inner - brandW - btnW - 40), "status", "topbar-status", true);
        ui.spacer();
        actions();
      }, { width: inner, align: "center", spacing: 12 });
    } else {
      ui.column("topbar-col", () => {
        const fits = brandW + btnW + 12 <= inner;
        if (fits) ui.row("topbar-row", () => { brand(); ui.spacer(); actions(); }, { width: inner, align: "center" });
        else { brand(); actions(); }
        para(status, inner, "status", "topbar-status");
      }, { width: inner, spacing: 4 });
    }
  }, { style: "topbar", width: L.lw });
  return r.height / L.sc;
}

/** A page under the top bar: a column `maxW` wide, scrolling when taller than the window. */
function page(key: string, L: Layout, top: number, maxW: number, build: (w: number) => void, center = false, footer: ((w: number) => void) | null = null): void {
  const padX = L.lw < 600 ? 13 : Math.min(48, Math.max(13, L.lw * 0.04));
  const pw = Math.min(maxW, L.lw - 2 * padX);
  let footH = 0;
  if (footer) {
    // A pinned footer (the results' buttons stay in view however long the page).
    const f = ui.place(`foot-${key}`, { anchor: "bottom-start", x: 0, y: 0 }, () => ui.column(`foot-${key}-in`, () => footer(pw), { width: L.lw, padding: { start: padX } }), { style: "tray", width: L.lw });
    footH = f.height / L.sc;
  }
  const avail = Math.max(80, L.lh - top - footH);
  const h = lastHeight.get(key) ?? 0;
  const scroll = h > avail;
  ui.place(`page-${key}`, { anchor: "top-start", x: 0, y: top }, () => {
    const body = (): void => {
      const r = ui.column(`${key}-col`, () => build(pw - (scroll ? 12 : 0)), { width: pw, spacing: 14, padding: { top: 19, bottom: 19 }, ...(center ? { align: "center" as const } : {}) });
      lastHeight.set(key, r.height / L.sc);
    };
    const fresh = frame().frame - app.openedFrame <= 5;
    const outer = { width: L.lw, ...(center ? { align: "center" as const } : { padding: { start: padX } }) };
    if (scroll) ui.scrollArea(`${key}-scroll`, { width: L.lw, height: avail }, () => ui.column(`${key}-sc`, body, { ...outer, width: L.lw - 12 }), fresh ? { scrollTo: { top: 0 } } : undefined);
    else ui.column(`${key}-outer`, body, { ...outer, ...(center ? { height: avail, justify: "center" as const } : {}) });
  }, { width: L.lw });
}
function backButton(w: number, to: () => void): void { flow("back-row", [{ id: "btn-back", text: T("Back"), style: ["ghost"], act: to }], w); }

/** A card button: a bold title over a dim line (the browser build's .card-btn). */
function cardButton(id: string, title: string, sub: string, w: number, act: () => void, opts: { disabled?: boolean } = {}): void {
  const inner = w - 38;
  if (ui.style("card-btn", { width: w }).id(id).button(title + (sub ? ". " + sub : ""), {
    ...(opts.disabled ? { disabled: true } : {}),
    content: () => ui.column(`${id}-face`, () => { para(title, inner, "card-title"); para(sub, inner, "card-sub"); }, { spacing: 3, align: "start", width: inner }),
  })) act();
}
/** Card buttons in rows of `cols` equal columns (CSS grid auto-fill). */
function cardGrid(id: string, min: number, w: number, n: number, build: (i: number, cw: number) => void, gap = 13): void {
  const cols = Math.max(1, Math.floor((w + gap) / (min + gap)));
  const cw = (w - gap * (cols - 1)) / cols;
  ui.column(id, () => {
    for (let i = 0; i < n; i += cols) ui.row(`${id}-r${i}`, () => { for (let j = i; j < Math.min(n, i + cols); j++) build(j, cw); }, { spacing: gap, align: "stretch" });
  }, { spacing: gap, width: w });
}

// ------------------------------------------------------------------ title
function titleScreen(L: Layout, top: number): void {
  const done = Object.keys(save.journey.completed).length;
  const today = platform.todayUTC();
  const d = save.dailies[today];
  page("title", L, top, 704, (w) => {
    const heroW = w;
    const heroH = Math.min(heroW * 14 / 25, Math.max(96, Math.min((L.lh - top) * 0.42, L.lh - top - 330)));
    art("title-art", "assets/key-art.webp", heroW, heroH, 16);
    para(T("Restore the explorer’s cabinet, one merge at a time."), Math.min(w, 340), "dim", "tagline", true);
    button({ id: "btn-play", text: T("Play"), style: ["primary", "big"], act: () => show("modes", "mode-learn") });
    const cards: [string, string, string, () => void][] = [
      ["btn-daily", T("Daily Cabinet"), d?.completed ? T("Done today — best {score}", { score: d.score }) : T("One shared seed per UTC day"), openDailySetup],
      ["btn-journey", T("Journey"), T("{done} / {total} stages restored", { done, total: JOURNEY_COUNT }), () => show("journey", "stage-1")],
      ["btn-profile", T("Curator Profile"), displayName(), () => openModal("profile")],
    ];
    const cw = Math.min(200, w);
    const cols = Math.max(1, Math.floor((w + 13) / (cw + 13)));
    ui.column("title-cards", () => {
      for (let i = 0; i < cards.length; i += cols) {
        ui.row(`tc-${i}`, () => { for (const [id, t, s, act] of cards.slice(i, i + cols)) cardButton(id, t, s, cw, act); }, { spacing: 13, align: "stretch" });
      }
    }, { spacing: 13, align: "center", width: w });
    const plat: Btn[] = [];
    if (!platform.signedIn()) plat.push({ id: "btn-signin", text: T("Sign in with StarHermit"), style: ["card-btn"], act: signIn });
    if (platform.inviteLink()) plat.push({ id: "btn-invite", text: T("Invite a friend"), style: ["card-btn"], act: copyInvite });
    if (plat.length) flow("title-platform", plat, w, "center");
    if (loadSnapshot()) button({ id: "btn-resume", text: T("Resume paused board"), style: ["primary"], act: resumeSnapshot });
  }, true);
}

// ------------------------------------------------------------------ modes, journey, set-up
function modesScreen(L: Layout, top: number): void {
  const modes: [string, string, string][] = [
    ["learn", N("Learn"), N("Interactive lessons — one rule at a time")],
    ["journey", N("Journey"), N("Authored stages with mastery tests · ranked")],
    ["daily", N("Daily"), N("Shared seed per UTC day · ranked")],
    ["practice", N("Practice"), N("Your difficulty, undo allowed · unranked")],
    ["challenge", N("Challenge"), N("Move limits, speed targets, dense boards · ranked")],
    ["scores", N("Score Chase"), N("Leaderboards & shareable seeds")],
  ];
  page("modes", L, top, 960, (w) => {
    heading("h2", T("Choose a mode"), w, "modes-h");
    cardGrid("mode-grid", 240, w, modes.length, (i, cw) => { const [m, t, s] = modes[i]!; cardButton(`mode-${m}`, T(t), T(s), cw, () => openModeSetup(m)); });
    backButton(w, goHome);
  });
}
function journeyScreen(L: Layout, top: number): void {
  let firstLocked = -1;
  for (let i = 0; i < JOURNEY_COUNT; i++) if (!save.journey.completed[i]) { firstLocked = i; break; }
  const playableUpTo = firstLocked === -1 ? JOURNEY_COUNT - 1 : firstLocked; // sequential unlock, completed replayable
  const doneCount = Object.keys(save.journey.completed).length;
  page("journey", L, top, 960, (w) => {
    heading("h2", T("Journey"), w, "journey-h");
    para(T("{done} of {total} stages restored — the cabinet diorama grows as you progress.", { done: doneCount, total: JOURNEY_COUNT }), w, "dim");
    THEMES.forEach((theme, t) => {
      ui.column(`theme-${t}`, () => {
        para(T(theme.name), w, "h3-accent");
        para(T(theme.ambience), w, "body");
      }, { spacing: 0, width: w });
      cardGrid(`stages-${t}`, 136, w, 8, (s, cw) => {
        const idx = t * 8 + s;
        const lvl = journeyLevel(idx) as Level;
        const done = save.journey.completed[idx];
        const locked = idx > playableUpTo;
        const name = levelName(lvl);
        const label = T("Stage {n}, {name}", { n: idx + 1, name }) + (done ? T(", completed, best {score}", { score: done.score }) : "")
          + (locked ? T(", locked") : "") + (lvl.moveLimit ? T(", mastery stage") : "");
        const cls = done ? "stage-done" : lvl.moveLimit ? "stage-mastery" : "stage-btn";
        const inner = cw - 22;
        if (ui.style(cls, { width: cw }).id(`stage-${idx + 1}`).button(label, {
          ...(locked ? { disabled: true } : {}),
          content: () => ui.column(`st-${idx}`, () => {
            para(`${idx + 1}. ${name}`, inner, "card-title", undefined, true);
            para(done ? `★ ${done.score}` : lvl.moveLimit ? "◆ " + T("mastery") : "·", inner, "stars", undefined, true);
          }, { spacing: 2, align: "center", width: inner }),
        })) openStage(idx);
      }, 8);
    });
    backButton(w, () => show("modes", "mode-journey"));
  });
}

const MECHANIC_TEXT: Record<string, string> = {
  merge: N("merge identical pieces"), generator: N("tap Field Kits to produce items"),
  crates: N("crates block cells"), webbed: N("cobwebbed pieces only merge as targets"), "move-limit": N("limited number of actions"),
};
function setupScreen(L: Layout, top: number): void {
  const v = app.setup;
  if (!v) { show("modes"); return; }
  page("setup", L, top, 704, (w) => {
    heading("h2", T("Set up"), w, "setup-h");
    if (v.kind === "level") {
      const level = v.level;
      heading("h3", levelName(level), w);
      const n = level.requests.length;
      para(T("Board {cols}×{rows}. You will {mechanics}.", { cols: level.cols, rows: level.rows, mechanics: level.mechanics.map((m) => T(MECHANIC_TEXT[m] || m)).join(T("; ")) }) + " " +
        T(n === 1 ? N("Complete the {n} request to finish.") : N("Complete all {n} requests to finish."), { n }), w, "dim");
      const meta: [string, string][] = [
        ["⏱️", T("about {n} min", { n: Math.max(1, Math.round((level.parSeconds || 120) / 60)) })],
        ["👤", T("1 player")],
        ["🎲", T("seed {seed}", { seed: level.seed.toString(16) })],
      ];
      if (level.moveLimit) meta.push(["🎯", T("{n} actions max", { n: level.moveLimit })]);
      const items: { w: number; build: () => void }[] = meta.map(([e, t]) => ({
        w: 22 + textWidth(t, "small"),
        build: () => ui.row(`meta-${e}`, () => { icon(e, 16); ui.style("small").label(t); }, { spacing: 5, align: "center" }),
      }));
      const badge = v.ranked ? T("Ranked") : T("Unranked — no effect on rating");
      items.push({ w: textWidth(badge, "ranked") + 24, build: () => ui.style(v.ranked ? "ranked" : "unranked").id("ranked-badge").label(badge) });
      wrapRow("setup-meta", items, w, 19);
      if (v.note) para(v.note, w, "body", "setup-note");
      button({ id: "btn-start", text: T("Start"), style: ["primary", "big"], act: () => startLevel(level, v.mode, v.journeyIndex) }, w);
    } else if (v.kind === "learn") {
      heading("h3", T("Interactive lessons"), w);
      para(T("Each lesson introduces exactly one rule and asks you to perform it."), w, "dim");
      tutorialLevels().forEach((lvl: Level, i: number) => {
        const done = save.stats.lessonsDone[lvl.id];
        const first = T(lvl.tutorial!.steps[0]!.text);
        cardButton(`lesson-${i}`, `${T(lvl.name)}${done ? " ✓" : ""}`, first.length > 60 ? first.slice(0, 60) + "…" : first, Math.min(w, 520), () => startLevel(lvl, "learn"));
      });
    } else if (v.kind === "practice") {
      heading("h3", T("Practice"), w);
      para(T("Undo allowed. Nothing here is ranked."), w, "dim");
      for (const [key, d] of Object.entries(PRACTICE_DIFFICULTIES) as [string, { size: number; chains: number; tierMax: number }][]) {
        cardButton(`practice-${key}`, T(PRACTICE_LABELS[key] || key), T(d.chains > 1 ? N("{size}×{size} board, {chains} chains, requests up to tier {tier}") : N("{size}×{size} board, {chains} chain, requests up to tier {tier}"),
          { size: d.size, chains: d.chains, tier: d.tierMax }), Math.min(w, 520), () => startPractice(key));
      }
    } else if (v.kind === "challenge") {
      heading("h3", T("Challenges"), w);
      para(T("Constrained goals. Ranked."), w, "dim");
      for (const c of CHALLENGES) cardButton(`challenge-${c.id}`, T(c.name), T(c.blurb), Math.min(w, 520), () => openChallenge(c.id));
    } else scoresBody(w);
    backButton(w, () => show("modes"));
  });
}
/** Items at their widths in rows that wrap at `width`. */
function wrapRow(id: string, items: { w: number; build: () => void }[], width: number, gap: number): void {
  const rows: (typeof items)[] = [[]];
  let used = 0;
  for (const it of items) {
    if (rows[rows.length - 1]!.length && used + gap + it.w > width) { rows.push([]); used = 0; }
    used += (rows[rows.length - 1]!.length ? gap : 0) + it.w;
    rows[rows.length - 1]!.push(it);
  }
  ui.column(id, () => rows.forEach((r, i) => ui.row(`${id}-${i}`, () => r.forEach((it) => it.build()), { spacing: gap, align: "center" })), { spacing: 6, width });
}
function scoresBody(w: number): void {
  heading("h3", T("Score Chase"), w);
  const date = platform.todayUTC();
  para(T("Daily board for {date} — scores from this device.", { date }), w, "dim");
  const entries = (save.leaderboardLocal as { date: string; name: string; score: number; moves?: number; seconds?: number; me?: boolean }[])
    .filter((e) => e.date === date).sort((a, b) => b.score - a.score);
  const tw = Math.min(w, 480);
  const cols = [0.1, 0.42, 0.16, 0.14, 0.18].map((k) => k * tw);
  const row = (id: string, cells: string[], cls: string): void => {
    ui.row(id, () => cells.forEach((c, i) => ui.column(`${id}-${i}`, () => para(c, cols[i]! - 8, cls), { width: cols[i]! })), { style: "board-row", width: tw, align: "center" });
  };
  ui.column("board-table", () => {
    row("board-h", ["#", T("Player"), T("Score"), T("Moves"), T("Time")], "board-head");
    entries.slice(0, 25).forEach((e, i) => row(`board-${i}`, [String(i + 1), String(e.name).replace(/^Guest ·/, T("Guest ·")), String(e.score), String(e.moves ?? "—"), e.seconds != null ? fmtTime(e.seconds) : "—"], e.me ? "board-me" : "body"));
  }, { spacing: 0, width: tw });
  if (!entries.length) para(T("No entries yet. Finish today’s cabinet to post one."), w, "body");
  // Shareable seeds: the day's code, and a field to play another day's cabinet (the browser build's ?seed= link).
  flow("seed-copy", [{ id: "btn-copy-seed", text: T("Copy today’s challenge seed"), style: ["ghost"], act: copySeed }], w);
  ui.row("seed-row", () => {
    para(T("Shared seed date"), Math.min(160, w * 0.4), "body");
    app.sharedSeed = ui.textField("shared-seed", app.sharedSeed, { maxChars: 10, width: Math.min(150, w * 0.35), placeholder: "YYYY-MM-DD" });
    button({ id: "btn-play-seed", text: T("Play seed"), act: playSharedSeed });
  }, { spacing: 10, align: "center", width: w });
}

// ------------------------------------------------------------------ the round
function requestsRail(w: number, withLesson = true): void {
  const r = app.round!;
  const st = r.session.state;
  ui.style("h3").heading(T("Requests"));
  for (const req of st.requests as Request[]) {
    const cls = req.done ? "request-done" : app.dragOver === req.id ? "request-hot" : "request-card";
    const inner = w - 24;
    const rect = ui.column(`req-${req.id}`, () => {
      const items = req.needs.map((n, i) => {
        const met = req.progress[i]! >= n.count;
        const name = itemName(n.chain, n.tier), count = `${req.progress[i]}/${n.count}`;
        return {
          w: 20 + 5 + textWidth(name, "body") + 5 + textWidth(count, "small") + 18,
          build: () => ui.row(`need-${req.id}-${i}`, () => {
            icon(itemIcon(n.chain, n.tier), 20);
            ui.style("body").label(name);
            ui.style("small").label(count);
          }, { style: met ? "need-met" : "need", spacing: 5, align: "center" }),
        };
      });
      wrapRow(`needs-${req.id}`, items, inner, 8);
      if (!req.done) {
        const ok = canDeliver(req);
        button({ id: `deliver-${req.id}`, text: ok ? T("Deliver selected piece") : T("Deliver (select a matching piece)"), style: ["small-btn"], disabled: !ok, act: () => { deliverSelected(req.id); ui.setFocus(null); } },
          buttonWidth(T("Deliver (select a matching piece)"), ["small-btn"]) > inner ? inner : null);
      } else para(T("Complete ✓"), inner, "small");
    }, { style: cls, width: w, spacing: 6 });
    if (!req.done) app.requestRects.push({ id: req.id, x: rect.x, y: rect.y, w: rect.width, h: rect.height });
  }
  if (!st.requests.length) para(T("Follow the lesson steps."), w, "dim");
  if (withLesson) lessonPanel(w);
}
/** The lesson's step and, on its closing step, Finish lesson. */
function lessonPanel(w: number): void {
  const line = tutorialLine();
  if (line) {
    ui.column("tutorial-panel", () => {
      para(line, w - 24, "body", "tutorial-text");
      if (lessonClosing()) button({ id: "tutorial-finish", text: T("Finish lesson"), style: ["primary"], act: () => finishLevel(true) });
    }, { style: "tutorial", width: w, spacing: 8 });
  }
}
function statusRail(w: number, actions: boolean): void {
  const r = app.round!;
  const st = r.session.state;
  const box = (id: string, big: string, subs: string[]): void => {
    ui.column(id, () => { ui.style("big-num").id(`${id}-num`).label(big); for (const s of subs) para(s, w - 26, "tiny"); }, { style: "panel-box", width: w, spacing: 1 });
  };
  box("score-panel", String(totalScore(st)), [T("score"), T("merges {merges} · discoveries {discoveries} · requests {requests}", { merges: st.score.merge, discoveries: st.score.discovery, requests: st.score.request })]);
  box("moves-panel", st.moveLimit !== null ? `${st.movesUsed}/${st.moveLimit}` : String(st.movesUsed), [st.moveLimit !== null ? T("actions used") : T("actions")]);
  const par = r.level.parSeconds;
  box("timer-panel", fmtTime(r.session.elapsedSeconds()), [par ? T("par {time}", { time: fmtTime(par) }) : T("elapsed")]);
  if (!actions) return;
  ui.column("action-col", () => {
    button({ id: "btn-pause", text: T("Pause"), style: ["ghost"], act: openPause }, w);
    if (undoShown()) button({ id: "btn-undo", text: T("Undo"), style: ["ghost"], disabled: !r.session.canUndo(), act: doUndo }, w);
    if (options.hintsEnabled) button({ id: "btn-hint", text: T("Hint"), style: ["ghost"], act: showHint }, w);
    if (!options.domBoard) button({ id: "btn-camera", text: T("Reset camera"), style: ["ghost"], act: resetCamera }, w);
  }, { spacing: 8, width: w });
}
function tray(L: Layout): number {
  const r = app.round!;
  const list: Btn[] = [{ id: "btn-pause-m", text: T("Pause"), style: ["ghost"], act: openPause }];
  if (undoShown()) list.push({ id: "btn-undo-m", text: T("Undo"), style: ["ghost"], disabled: !r.session.canUndo(), act: doUndo });
  if (options.hintsEnabled) list.push({ id: "btn-hint-m", text: T("Hint"), style: ["ghost"], act: showHint });
  list.push({ id: "btn-objectives-m", text: T("Requests"), style: ["ghost"], act: () => { app.drawer = app.drawer === "left" ? null : "left"; ui.setFocus(null); } });
  list.push({ id: "btn-score-m", text: T("Score"), style: ["ghost"], act: () => { app.drawer = app.drawer === "right" ? null : "right"; ui.setFocus(null); } });
  if (options.leftHanded) list.reverse();
  const res = ui.place("mobile-tray", { anchor: "bottom-start", x: 0, y: 0 }, () => {
    const inner = L.lw - 16;
    const total = list.reduce((a, b) => a + buttonWidth(b.text, b.style!), 0);
    if (total + 8 * (list.length - 1) <= inner) ui.row("tray-row", () => { for (const b of list) button(b); }, { width: inner, justify: "space-around", align: "center" });
    else flow("tray", list, inner, "center", 8);
  }, { style: "tray", width: L.lw });
  lastHeight.set("tray", res.height / L.sc);
  return res.height / L.sc;
}
/** A rail panel of fixed height whose content scrolls when taller. */
function railPlace(id: string, x: number, y: number, w: number, h: number, cls: string, build: (w: number) => void): ui.Rect {
  const ch = lastHeight.get(id) ?? 0;
  const pad = 14;
  return ui.place(id, { anchor: "top-start", x, y }, () => {
    const inner = (): void => {
      const r = ui.column(`${id}-in`, () => build(w - 2 * pad - (ch > h ? 12 : 0)), { spacing: 13 });
      lastHeight.set(id, r.height / ui.preferences().scale + 2 * pad);
    };
    ui.column(`${id}-col`, () => {
      if (ch > h) ui.scrollArea(`${id}-scroll`, { width: w - 2 * pad, height: h - 2 * pad }, inner);
      else inner();
    }, { style: cls, width: w, height: h });
  }, { width: w });
}

function playScreen(L: Layout, top: number): void {
  const r = app.round;
  if (!r) { goHome(); return; }
  const f = frame();
  const sc = L.sc;
  const P = ink(pr().highContrast);
  let x0 = 0, x1 = L.lw, y0 = top, y1 = L.lh;
  if (L.wide) {
    const lw = Math.min(304, Math.max(240, L.lw * 0.22)), rw = Math.min(256, Math.max(208, L.lw * 0.19));
    const leftReq = !options.leftHanded;
    railPlace("rail-left", 0, top, leftReq ? lw : rw, L.lh - top, "rail", (w) => (leftReq ? requestsRail(w) : statusRail(w, true)));
    railPlace("rail-right", L.lw - (leftReq ? rw : lw), top, leftReq ? rw : lw, L.lh - top, "rail", (w) => (leftReq ? statusRail(w, true) : requestsRail(w)));
    x0 = leftReq ? lw : rw; x1 = L.lw - (leftReq ? rw : lw);
  } else {
    y1 -= tray(L);
    // Compact: the lesson stays in view above the board (the requests go to a drawer).
    if (tutorialLine()) {
      const lw = Math.min(L.lw - 16, 640);
      const b = ui.place("lesson-banner", { anchor: "top-start", x: (L.lw - lw) / 2, y: top + 8 }, () => lessonPanel(lw), { width: lw });
      const bh = b.height / sc;
      y0 = top + 16 + (Number.isFinite(bh) ? bh : 0);
    }
  }
  const pw = Math.max(40, x1 - x0 || 0), ph = Math.max(40, y1 - y0 || 0);
  const X = (L.ox + x0) * sc, Y = (L.oy + y0) * sc, Wd = pw * sc, Hd = ph * sc;
  if (options.domBoard) {
    render.setActive(false);
    draw.rect(0, 0, f.width, f.height, P.bg);
    board2d(x0, y0, pw, ph);
  } else {
    render.setActive(true);
    render.setPlayfield(X, Y, Wd, Hd, f.width, f.height);
    // The page around the playfield (the cabinet fills the window behind the UI).
    const band = (x: number, y: number, w: number, h: number): void => { if (w > 0.5 && h > 0.5) draw.rect(x, y, w, h, P.bg); };
    band(0, 0, f.width, Y);
    band(0, Y + Hd, f.width, f.height - Y - Hd);
    band(0, Y, X, Hd);
    band(X + Wd, Y, f.width - X - Wd, Hd);
    cellTargets();
  }
  // Compact layouts: the rails as drawers over the board (left: requests, right: status).
  if (!L.wide && app.drawer) {
    const dw = Math.min(320, L.lw * 0.85);
    const left = (app.drawer === "left") !== options.leftHanded;
    const d = railPlace(`drawer-${app.drawer}`, left ? 0 : L.lw - dw, y0, dw, ph, "drawer", (w) => (app.drawer === "left" ? requestsRail(w, false) : statusRail(w, false)));
    app.drawerRect = { x: d.x, y: d.y, w: d.width, h: d.height };
  }
  const cd = countdownText();
  // Workaround (engine 1.17.0, web): a glyph taller than about 256 window pixels is left out of the
  // overlay ("not valid"), so the 96 px countdown is capped at 240 window pixels on high-DPI phones.
  if (cd) ui.place("countdown", { anchor: "top-start", x: x0, y: y0 }, () => ui.column("cd-col", () => ui.style("countdown", { text: { size: Math.min(96, 240 / sc) } }).id("countdown").label(cd), { width: pw, height: ph, align: "center", justify: "center" }));
}
/** Each cell as a named area for screen readers (the browser build's DOM board mirror, visually hidden in 3D). */
function cellTargets(): void {
  const r = app.round;
  if (!r || app.modal || app.countdown) return;
  const n = r.level.cols * r.level.rows;
  for (let i = 0; i < n; i++) {
    const p = render.cellScreen(i);
    if (!p) continue;
    const half = p.size / 2;
    ui.id(`cell-${i}`).target(cellLabel(i), { x: p.x - half, y: p.y - half, width: p.size, height: p.size }, { role: "button" });
  }
}
/** The 2D board (Settings › Use 2D board): a grid of cell buttons with the item icons, tier pips and marks (src/ui.js DomBoard). */
function board2d(x: number, y: number, w: number, h: number): void {
  const r = app.round!;
  const st = r.session.state;
  const { cols, rows } = r.level;
  const gap = 6;
  const cell = Math.max(41.6, Math.min(67.2, (w - 32 - gap * (cols - 1)) / cols, (h - 32 - gap * (rows - 1)) / rows));
  const targets = mergeTargets();
  const hint = new Set(r.hint?.cells ?? []);
  const P = ink(pr().highContrast);
  ui.place("dom-board", { anchor: "top-start", x, y }, () => ui.column("dom-col", () => {
    ui.grid("dom-grid", () => {
      for (let i = 0; i < cols * rows; i++) {
        const it = st.cells[i];
        const alt = (i % cols + Math.floor(i / cols)) % 2 === 1;
        const cls = it?.kind === "generator" ? "dm-cell-gen" : it?.kind === "crate" ? "dm-cell-crate" : alt ? "dm-cell-alt" : "dm-cell";
        const res = ui.id(`cell-${i}`).widget(cellLabel(i), {
          role: "button", size: { width: cell, height: cell }, style: cls,
          draw: (q, s) => {
            const k = s.scale;
            const isz = Math.min(q.width, q.height) * 0.52;
            if (it && (it.kind === "piece" || it.kind === "generator")) {
              drawIcon(it.kind === "generator" ? "⚙️" : itemIcon(it.chain, it.tier), q.x + (q.width - isz) / 2, q.y + (q.height - isz) / 2 - 3 * k, isz);
              if (it.kind === "piece" && it.tier > 0) {
                for (let p = 0; p <= it.tier; p++) draw.circle(q.x + q.width / 2 + (p - it.tier / 2) * 7 * k, q.y + q.height - 6 * k, 2.5 * k, "#ffffffd9");
              }
              if (options.colorBlind) draw.text(it.chain[0]!.toUpperCase(), q.x + 4 * k, q.y + 2 * k, { size: 10.4 * k, color: P.accent2, weight: "700" });
            } else if (it?.kind === "crate") drawIcon("📦", q.x + (q.width - isz) / 2, q.y + (q.height - isz) / 2, isz);
            if (it?.webbed) {
              draw.roundRect(q.x, q.y, q.width, q.height, 10 * k, "#e6e6f52e");
              drawIcon("🕸️", q.x + q.width * 0.15, q.y + q.height * 0.15, q.width * 0.7, { alpha: 0.85 });
            }
            const ring = (color: string): void => draw.strokeRoundRect(q.x - 3 * k, q.y - 3 * k, q.width + 6 * k, q.height + 6 * k, 12 * k, color, 3 * k);
            if (i === r.selected) ring("#fff2b0");
            else if (hint.has(i)) ring(P.accent2);
            else if (targets.has(i)) ring(P.ok);
            else if (i === r.focus && !s.focused) ring("#ffffff66");
          },
        });
        if (res.activated) cellTap(i);
      }
    }, { columns: Array.from({ length: cols }, () => cell), gap });
  }, { width: w, height: h, align: "center", justify: "center" }));
}

// ------------------------------------------------------------------ results
const RESULT_LABELS: Record<string, string> = {
  Merges: N("Merges"), Discoveries: N("Discoveries"), Requests: N("Requests"), "Move bonus": N("Move bonus"), "Time bonus": N("Time bonus"), Penalties: N("Penalties"),
};
function resultsScreen(L: Layout, top: number): void {
  const x = app.results;
  if (!x) { goHome(); return; }
  const { res, unlocked, won } = x;
  page("results", L, top, 704, (w) => {
    heading("h2", T("Results"), w, "results-h");
    para(resultHeadline(x), w, won ? "headline-won" : "headline-lost", "results-headline");
    const aw = Math.min(w, 384, Math.max(160, (L.lh - top - 380) * 8 / 5));
    if (L.lh > 360) art("results-art", won ? "assets/cabinet-restored.webp" : "assets/cabinet-locked.webp", aw, aw * 5 / 8, 12);
    const bw = Math.min(w, 384);
    ui.column("results-breakdown", () => {
      for (const [k, v] of Object.entries(res.components)) {
        if (v === 0) continue;
        ui.row(`res-${k}`, () => { para(T(RESULT_LABELS[k] || k), bw - 70, "body"); ui.spacer(); ui.style("body").label(String(v)); }, { style: "results-row", width: bw, align: "center" });
      }
      ui.row("res-total", () => { ui.style("total").label(T("Total")); ui.spacer(); ui.style("total").id("results-total").label(String(res.total)); }, { style: "results-total", width: bw, align: "center" });
    }, { spacing: 4, width: bw });
    const parts = [
      res.moveLimit ? T("{n} actions of {max}", { n: res.movesUsed, max: res.moveLimit }) : T("{n} actions", { n: res.movesUsed }),
      T("{n} invalid", { n: res.invalidActions }),
      res.parSeconds ? T("{time} elapsed (par {par})", { time: fmtTime(res.elapsedSeconds), par: fmtTime(res.parSeconds) }) : T("{time} elapsed", { time: fmtTime(res.elapsedSeconds) }),
      T("seed {seed}", { seed: res.seed.toString(16) }),
    ];
    para(parts.join(" · "), w, "dim", "results-line");
    for (const a of unlocked) {
      const text = T("Achievement unlocked: {name} — {desc}", { name: T(a.name), desc: T(a.desc) });
      ui.row(`ach-${a.id}`, () => { icon("🏅", 20); para(text, w - 28, "achievement"); }, { spacing: 8, align: "center", width: w });
    }
    const lb = leaderboardLine();
    if (lb) para(lb, w, "dim", "results-lb");
  }, false, (w) => {
    const btns: Btn[] = [{ id: "btn-retry", text: T("Retry"), style: ["primary"], act: retry }];
    if (hasNext()) btns.push({ id: "btn-next", text: T("Next stage"), style: ["primary"], act: nextStage });
    btns.push({ id: "btn-results-home", text: T("Home"), style: ["ghost"], act: resultsHome });
    flow("results-actions", btns, w);
  });
}

// ------------------------------------------------------------------ dialogs
/** A modal card: a scrolling body when taller than the window, a pinned footer (its buttons stay clickable). */
function dialogFrame(id: string, title: string, L: Layout, maxW: number, build: ((w: number) => void) | null, footer: (w: number) => void, onClose: () => void): void {
  const w = Math.min(maxW, L.lw - 32) - 44;
  const fh = (lastHeight.get(`dlg-${id}-foot`) ?? 56) + 16;
  const avail = Math.max(80, L.lh * 0.85 - 40 - fh - 40);
  const h = lastHeight.get(`dlg-${id}`) ?? 0;
  const body = (): void => {
    const r = ui.column(`${id}-body`, () => { heading("h2", T(title), w, `${id}-h`); build?.(w); }, { spacing: 13, width: w });
    lastHeight.set(`dlg-${id}`, r.height / L.sc);
  };
  // A dialog opens at its top (heading visible), whatever it focuses.
  const fresh = frame().frame - app.modalOpened <= 4;
  const open = ui.dialog(T(title), "", true, () => {
    if (h > avail) ui.scrollArea(`${id}-scroll`, { width: w + 14, height: avail }, body, fresh ? { scrollTo: { top: 0 } } : undefined);
    else body();
    const r = ui.column(`${id}-foot`, () => footer(w), { width: w, spacing: 8, padding: { top: 16 } });
    lastHeight.set(`dlg-${id}-foot`, r.height / L.sc - 16);
  });
  // The Escape (or East) that opened it must not close it the same frame.
  if (!open && frame().frame !== app.modalOpened) onClose();
}
const closeRow = (w: number, label = N("Close")): void => flow("dlg-close", [{ id: "btn-close", text: T(label), style: ["primary"], act: closeModal }], w);
function dialogs(L: Layout): void {
  switch (app.modal) {
    case "pause": {
      const r = app.round;
      if (!r) { closeModal(); return; }
      dialogFrame("pause", N("Paused"), L, 544, (w) => {
        para(T("{name} — score {score} so far.", { name: levelName(r.level), score: totalScore(r.session.state) }), w);
        para(T("Your board is saved locally and will resume exactly."), w, "dim");
      }, (w) => flow("pause-actions", [
        { id: "btn-resume-round", text: T("Resume"), style: ["primary"], act: resumeRound },
        { id: "btn-pause-settings", text: T("Settings"), style: ["ghost"], act: () => openModal("settings") },
        { id: "btn-pause-help", text: T("Help"), style: ["ghost"], act: () => openModal("help") },
        { id: "btn-leave", text: T("Leave round"), style: ["ghost"], act: leaveRound },
      ], w), resumeRound);
      return;
    }
    case "codex": dialogFrame("codex", N("Discovery Codex"), L, 544, codexBody, (w) => closeRow(w), closeModal); return;
    case "help": dialogFrame("help", N("How to play"), L, 544, helpBody, (w) => closeRow(w), closeModal); return;
    case "profile": dialogFrame("profile", N("Curator Profile"), L, 544, profileBody, (w) => closeRow(w), closeModal); return;
    case "settings": dialogFrame("settings", N("Settings"), L, 544, settingsBody, (w) => closeRow(w, N("Done")), closeModal); return;
    case "erase":
      dialogFrame("erase", N("Erase all local progress?"), L, 480,
        (w) => para(T("This removes journey progress, the codex and achievements, on this device and in your cloud save."), w),
        (w) => flow("erase-actions", [
          { id: "btn-erase-yes", text: T("Erase everything"), style: ["primary"], act: eraseProgress },
          { id: "btn-erase-no", text: T("Cancel"), style: ["ghost"], act: closeModal },
        ], w), closeModal);
      return;
    default:
  }
}
function codexBody(w: number): void {
  para(T("Every item tier you have ever created, across all sessions."), w, "dim");
  for (const id of CHAIN_IDS) {
    const chain = (CHAINS as Record<string, { tiers: { name: string; icon: string }[] }>)[id]!;
    const maxTier = save.codex[id] ?? -1;
    ui.column(`codex-${id}`, () => {
      para(chainName(id), w, "h3");
      const items = chain.tiers.map((t, i) => ({
        w: 51,
        build: () => {
          const name = T(t.name);
          ui.id(`codex-${id}-${i}`).widget(i <= maxTier ? name : T("{name}, undiscovered", { name }), {
            role: "image", size: { width: 51, height: 51 }, style: "codex-tier",
            draw: (q) => drawIcon(i <= maxTier ? t.icon : "❔", q.x + q.width * 0.2, q.y + q.height * 0.2, q.width * 0.6, i <= maxTier ? {} : { alpha: 0.35, grey: true }),
          });
        },
      }));
      wrapRow(`codex-row-${id}`, items, w, 6);
    }, { spacing: 6, width: w });
  }
}
function group(id: string, title: string, w: number, build: (inner: number) => void): void {
  ui.column(id, () => { para(title, w - 34, "group-title"); build(w - 34); }, { style: "settings-group", width: w, spacing: 9 });
}
function helpBody(w: number): void {
  const move = ["up", "down", "left", "right"].map(keyName).join("/");
  const cards: [string, string][] = [
    [T("Tap a Field Kit"), T("Generators (⚙️) produce new items onto free cells. Every tap counts as one action.")],
    [T("Merge identical pieces"), T("Drag one piece onto an identical piece (same kind, same tier) — or select one, then activate the other — to discover the next tier.")],
    [T("Deliver requests"), T("Select a piece a request needs, then press its Deliver button — or drag the piece onto the request card. Complete every request to finish.")],
    [T("Cobwebs"), T("Webbed pieces cannot move or be delivered. Merge a matching piece onto one to clear the web.")],
    [T("Crates"), T("Crates block cells permanently. Work around them.")],
    [T("Keyboard"), T("{move} move between cells · Enter/Space select & confirm · {cancel} cancel or pause · {undo} undo (practice) · {hint} hint · {camera} reset camera.", {
      move, cancel: keyName("cancel"), undo: keyName("undo"), hint: keyName("hint"), camera: keyName("camera"),
    })],
    [T("Gamepad"), T("D-pad or left stick moves focus, A confirms, B cancels, Start pauses.")],
  ];
  cards.forEach(([h, t], i) => group(`help-${i}`, h, w, (inner) => para(t.replace(/\s*\(⚙️\)/g, ""), inner)));
}
function profileBody(w: number): void {
  const s = save.stats;
  para(platform.signedIn() ? T("Playing as {name}", { name: platform.displayName() }) : T("Identity: {id} (local guest)", { id: guestName() }), w);
  para(T("Sign-in is handled by the host shell when hosted; guest practice works fully offline. Progress below is stored on this device."), w, "dim");
  group("profile-life", T("Lifetime"), w, (inner) => para(T("{sessions} sessions · {merges} merges · {webs} webs cleared · {stages}/{total} journey stages · {dailies} dailies", {
    sessions: s.sessions, merges: s.merges, webs: s.websCleared || 0, stages: Object.keys(save.journey.completed).length, total: JOURNEY_COUNT, dailies: Object.keys(save.dailies).length,
  }), inner));
  group("profile-ach", T("Achievements"), w, (inner) => {
    for (const a of ACHIEVEMENTS) {
      const got = !!save.achievements[a.id];
      ui.row(`pa-${a.id}`, () => { icon(got ? "🏅" : "⬜", 20); para(`${T(a.name)} — ${T(a.desc)}`, inner - 28); }, { spacing: 8, align: "center", width: inner });
    }
  });
}
function toggle(key: "leftHanded" | "domBoard" | "colorBlind" | "haptics" | "hintsEnabled", label: string): void {
  const cur = options[key];
  const next = ui.id(`set-${key}`).checkbox(T(label), cur);
  if (next !== cur) platform.setOption(key, next);
}
function settingsBody(w: number): void {
  group("set-runtime", T("Audio"), w, (inner) => {
    para(T("Volumes, mute, graphics quality, language, reduced motion, high contrast and text size are in the StarHermit Options."), inner, "dim");
    flow("set-runtime-btns", [{ id: "btn-options", text: T("Open Options"), style: ["ghost"], act: () => openMenu() }], inner);
  });
  group("set-controls", T("Controls"), w, (inner) => {
    toggle("leftHanded", N("Left-handed layout"));
    toggle("domBoard", N("Use 2D board (accessible fallback)"));
    const tilts = [N("Default"), N("Top-down")];
    const cur = options.cameraTilt === "top" ? 1 : 0;
    ui.row("tilt-row", () => {
      para(T("Camera"), Math.max(80, inner * 0.35));
      ui.spacer();
      const next = ui.style({ width: Math.min(200, inner * 0.6) }).id("set-camera").select(T("Camera tilt"), cur, tilts.map((t) => T(t)));
      if (next !== cur) platform.setOption("cameraTilt", next === 1 ? "top" : "default");
    }, { width: inner, align: "center", spacing: 10 });
    flow("rebind-btns", [{ id: "btn-rebind", text: T("Change keys and buttons"), style: ["ghost"], act: () => requestRebind() }], inner);
  });
  group("set-a11y", T("Accessibility"), w, (inner) => {
    toggle("colorBlind", N("Color-vision-safe palette"));
    toggle("haptics", N("Haptics"));
    toggle("hintsEnabled", N("Hints enabled"));
    flow("lesson-btns", [{ id: "btn-replay-lessons", text: T("Replay tutorials (reset lesson progress)"), style: ["ghost"], act: replayTutorials }], inner);
  });
  group("set-data", T("Data"), w, (inner) => flow("data-btns", [{ id: "btn-erase", text: T("Erase local progress"), style: ["ghost"], act: () => openModal("erase") }], inner));
}

// ------------------------------------------------------------------ toasts
function toasts(L: Layout): void {
  if (!app.toasts.length) return;
  const bottom = app.screen === "play" && !L.wide ? (lastHeight.get("tray") ?? 64) + 8 : 16;
  const w = Math.min(L.lw - 24, 520);
  ui.place("toast-root", { anchor: "bottom", y: bottom }, () => ui.column("toast-col", () => {
    app.toasts.forEach((t, i) => {
      const cls = t.err ? "toast-err" : "toast";
      if (textWidth(t.text, cls) + 40 <= w) ui.style(cls).id(`toast-${i}`).label(t.text);
      else ui.style(cls).id(`toast-${i}`).paragraph(t.text, w - 40);
    });
  }, { spacing: 6, align: "center" }));
}
