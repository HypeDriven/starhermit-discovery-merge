// Bootstrap + orchestration: boot → title → mode-select → preparing →
// countdown → active ↔ paused → resolving → results → progression.
// Owns screens, save data, achievements, snapshots, and platform lifecycle.

import { GameSession } from './session.js';
import { BoardRenderer } from './render.js';
import { DomBoard, PlayController, el, announce, toast, openModal, relabelModals, DEFAULT_KEYS, setKeyBindings, keyLabel, itemName, chainName } from './ui.js';
import { AudioEngine } from './audio.js';
import { graphicsControls, resolvedPreset } from './gfx-panel.js';
import { T, N, onLanguage, initLanguage } from './i18n.js';
import { fromLegacyQuality } from './gfx.js';
import { Platform } from './platform.js?v=production-qa-2';
import {
  loadSave, storeSave, storeSnapshot, loadSnapshot, clearSnapshot, parseSave, mergeSaves,
  ACHIEVEMENTS, DEFAULT_SETTINGS,
} from './persist.js';
import {
  CHAINS, THEMES, CHAIN_IDS, itemIcon,
  journeyLevel, JOURNEY_COUNT, dailyLevel, practiceLevel, challengeLevel,
  tutorialLevels, CHALLENGES, PRACTICE_DIFFICULTIES,
} from './content.js';
import { totalScore, legalActions } from './engine/rules.js';

// ---------------------------------------------------------------------------
// Global state
// ---------------------------------------------------------------------------

// Resolve the game language before anything renders (sh-language.js).
initLanguage();

const save = loadSave();
const platform = new Platform();
const audio = new AudioEngine(save.settings);
const $ = (id) => document.getElementById(id);

let current = null; // { session, renderer, controller, level, mode, journeyIndex, domBoard }
let domBoard = null;
let snapshotTimer = null;

function persist() { storeSave(save); }

// Replace the save in place: `save` is const and its settings object is shared
// (audio engine, renderer, settings panel), so they all see the adopted doc.
function adoptSave(next) {
  const settings = Object.assign(save.settings, next.settings);
  for (const k of Object.keys(save)) delete save[k];
  Object.assign(save, next, { settings });
}

// Top-bar status: hosted shows the account nickname + cloud sync state.
function renderStatus() {
  const el = document.getElementById('topbar-status');
  const canSign = platform.canSignIn(), canInvite = platform.hosted && !!platform.inviteLink();
  $('btn-signin').hidden = !canSign;
  $('btn-invite').hidden = !canInvite;
  $('title-platform').hidden = !canSign && !canInvite;
  if (!el) return;
  if (platform.hosted) {
    const name = platform.profile ? platform.profile.name : '…';
    el.textContent = T('Playing as {name}', { name }) + ' · ' +
      T(platform.sync === 'synced' ? N('progress synced') : platform.sync === 'saving' ? N('saving…') : N('cloud sync unavailable'));
    return;
  }
  el.textContent = T('Local play — fully playable');
}

// Display name of a level: content keeps the US-English names (snapshots
// carry them too), so translate at display time.
function levelName(level) {
  if (level.mode === 'daily') return T('Daily Cabinet — {date}', { date: String(level.id).replace(/^daily-/, '') });
  if (level.mode === 'practice') {
    const d = String(level.id).split('-')[1] || 'medium';
    return T('Practice ({difficulty})', { difficulty: T(PRACTICE_LABELS[d] || d) });
  }
  return T(level.name);
}
const PRACTICE_LABELS = { easy: N('Easy'), medium: N('Medium'), hard: N('Hard') };

// ---------------------------------------------------------------------------
// Settings application
// ---------------------------------------------------------------------------

function applySettings() {
  const s = save.settings;
  document.body.classList.toggle('reduced-motion', !!s.reducedMotion);
  document.body.classList.toggle('high-contrast', !!s.highContrast);
  document.body.classList.toggle('large-text', !!s.largeText);
  // rem-sized UI scales from the root element, not from <body>.
  document.documentElement.classList.toggle('large-text', !!s.largeText);
  document.body.classList.toggle('colorblind', !!s.colorBlind);
  audio.applyVolumes();
  // Graphics: migrate the old single quality tier, then apply live.
  if (!s.graphics || typeof s.graphics !== 'object') { s.graphics = fromLegacyQuality(s.quality); delete s.quality; }
  document.body.dataset.gfxPreset = resolvedPreset(s.graphics);
  document.body.dataset.gfxAuto = s.graphics.preset && s.graphics.preset !== 'auto' ? '0' : '1';
  current?.renderer?.setGraphics(s.graphics);
  if (current) updateBoardVisibility();
}

function updateBoardVisibility() {
  const useDom = save.settings.domBoard || !current?.renderer;
  $('dom-board').classList.toggle('visible', !!current && useDom);
  // With the 3D board on, keep the semantic board present but visually hidden
  // so keyboard and screen-reader players can still operate every cell.
  $('dom-board').classList.toggle('mirror', !!current && !useDom);
  $('gl-container').style.visibility = useDom ? 'hidden' : 'visible';
}

// ---------------------------------------------------------------------------
// Screen router
// ---------------------------------------------------------------------------

const SCREENS = ['title', 'modes', 'journey', 'setup', 'play', 'results'];
let screenName = 'title';

function showScreen(name) {
  screenName = name;
  for (const s of SCREENS) $('screen-' + s).hidden = s !== name;
  const screen = $('screen-' + name);
  screen.querySelector('h2, button')?.focus?.();
  announce(screenTitleFor(name));
}

function screenTitleFor(name) {
  return T({ title: N('Home'), modes: N('Choose a mode'), journey: N('Journey stages'), setup: N('Set up game'), play: N('Board'), results: N('Results') }[name] || name);
}

// ---------------------------------------------------------------------------
// Title / mode select
// ---------------------------------------------------------------------------

function refreshTitle() {
  const done = Object.keys(save.journey.completed).length;
  $('journey-sub').textContent = T('{done} / {total} stages restored', { done, total: JOURNEY_COUNT });
  $('profile-sub').textContent = platform.hosted ? platform.displayName : platform.displayName.replace(/^Guest ·/, T('Guest ·'));
  const today = platform.todayUTC();
  const d = save.dailies[today];
  $('daily-sub').textContent = d?.completed ? T('Done today — best {score}', { score: d.score }) : T('One shared seed per UTC day');
  const snap = loadSnapshot();
  $('resume-note').hidden = !snap;
}

function wireStatic() {
  $('btn-play').onclick = () => { audio.unlock(); showScreen('modes'); };
  $('btn-daily').onclick = () => { audio.unlock(); openDailySetup(); };
  $('btn-journey').onclick = () => { audio.unlock(); openJourney(); };
  $('btn-profile').onclick = () => openProfile();
  $('btn-resume').onclick = () => resumeSnapshot();
  $('btn-settings').onclick = () => openSettings();
  $('btn-help').onclick = () => openHelp();
  $('btn-codex').onclick = () => openCodex();
  document.querySelectorAll('[data-back]').forEach((b) => { b.onclick = () => showScreen('modes'); });
  document.querySelectorAll('.mode-grid .card-btn').forEach((b) => {
    b.onclick = () => openModeSetup(b.dataset.mode);
  });
  // Audio unlock on first gesture anywhere.
  document.addEventListener('pointerdown', () => audio.unlock(), { once: true });
  document.addEventListener('keydown', () => audio.unlock(), { once: true });
}

// ---------------------------------------------------------------------------
// Mode setup screens: rules, duration, ranked flag before commitment
// ---------------------------------------------------------------------------

// The setup screen's content is a render function so a language change can
// redraw it in place (refreshSetup) without leaving the screen.
let setupRender = null;
function showSetup(render) {
  setupRender = render;
  render();
  showScreen('setup');
}
function refreshSetup() { if (setupRender) setupRender(); }

const MECHANIC_TEXT = {
  merge: N('merge identical pieces'), generator: N('tap Field Kits to produce items'),
  crates: N('crates block cells'), webbed: N('cobwebbed pieces only merge as targets'),
  'move-limit': N('limited number of actions'),
};

function setupShell(level, { ranked, onStart, extra }) {
  showSetup(() => {
    const body = $('setup-body');
    body.innerHTML = '';
    const mechText = level.mechanics.map((m) => T(MECHANIC_TEXT[m] || m)).join(T('; '));
    const n = level.requests.length;
    body.append(
      el('h3', {}, levelName(level)),
      el('p', { class: 'rules-summary' },
        T('Board {cols}×{rows}. You will {mechanics}.', { cols: level.cols, rows: level.rows, mechanics: mechText }) + ' ' +
        T(n === 1 ? N('Complete the {n} request to finish.') : N('Complete all {n} requests to finish.'), { n })),
      el('div', { class: 'setup-meta' },
        el('span', {}, '⏱ ' + T('about {n} min', { n: Math.max(1, Math.round((level.parSeconds || 120) / 60)) })),
        el('span', {}, '👤 ' + T('1 player')),
        el('span', {}, '🎲 ' + T('seed {seed}', { seed: level.seed.toString(16) })),
        level.moveLimit ? el('span', {}, '🎯 ' + T('{n} actions max', { n: level.moveLimit })) : null,
        el('span', { class: ranked ? 'ranked-badge' : 'unranked-badge' }, ranked ? T('Ranked') : T('Unranked — no effect on rating'))),
      ...(extra ? [extra()] : []),
      el('button', { class: 'primary big', onclick: onStart }, T('Start')),
    );
  });
}

function openModeSetup(mode) {
  audio.unlock();
  if (mode === 'journey') return openJourney();
  if (mode === 'daily') return openDailySetup();
  if (mode === 'scores') return openScores();
  if (mode === 'learn') {
    return showSetup(() => {
      const lessons = tutorialLevels();
      const body = $('setup-body');
      body.innerHTML = '';
      body.append(el('h3', {}, T('Interactive lessons')), el('p', { class: 'rules-summary' }, T('Each lesson introduces exactly one rule and asks you to perform it.')));
      lessons.forEach((lvl) => {
        const done = save.stats.lessonsDone[lvl.id];
        const first = T(lvl.tutorial.steps[0].text);
        body.append(el('button', { class: 'card-btn', onclick: () => startLevel(lvl, 'learn') },
          el('strong', {}, `${T(lvl.name)}${done ? ' ✓' : ''}`),
          el('span', {}, first.length > 60 ? first.slice(0, 60) + '…' : first)));
      });
    });
  }
  if (mode === 'practice') {
    return showSetup(() => {
      const body = $('setup-body');
      body.innerHTML = '';
      body.append(el('h3', {}, T('Practice')), el('p', { class: 'rules-summary' }, T('Undo allowed. Nothing here is ranked.')));
      for (const [key, d] of Object.entries(PRACTICE_DIFFICULTIES)) {
        body.append(el('button', { class: 'card-btn', onclick: () => startLevel(practiceLevel(key), 'practice') },
          el('strong', {}, T(PRACTICE_LABELS[key] || key)),
          el('span', {}, T(d.chains > 1 ? N('{size}×{size} board, {chains} chains, requests up to tier {tier}') : N('{size}×{size} board, {chains} chain, requests up to tier {tier}'),
            { size: d.size, chains: d.chains, tier: d.tierMax }))));
      }
    });
  }
  if (mode === 'challenge') {
    return showSetup(() => {
      const body = $('setup-body');
      body.innerHTML = '';
      body.append(el('h3', {}, T('Challenges')), el('p', { class: 'rules-summary' }, T('Constrained goals. Ranked.')));
      for (const c of CHALLENGES) {
        const lvl = challengeLevel(c.id);
        body.append(el('button', { class: 'card-btn', onclick: () => setupShell(lvl, { ranked: true, onStart: () => startLevel(lvl, 'challenge') }) },
          el('strong', {}, T(c.name)), el('span', {}, T(c.blurb))));
      }
    });
  }
}

function openDailySetup() {
  const date = platform.todayUTC();
  const lvl = dailyLevel(date);
  const done = save.dailies[date];
  setupShell(lvl, {
    ranked: !done?.completed,
    onStart: () => startLevel(lvl, 'daily'),
    extra: () => el('p', {}, done?.completed
      ? T('You already completed today’s cabinet (score {score}). Replay for practice — first completion is what ranks.', { score: done.score })
      : T('Today’s cabinet is unclaimed. Your first completion counts for the daily board.')),
  });
}

// ---------------------------------------------------------------------------
// Journey screen
// ---------------------------------------------------------------------------

function openJourney({ refresh = false } = {}) {
  const list = $('journey-list');
  list.innerHTML = '';
  let firstLocked = -1;
  for (let i = 0; i < JOURNEY_COUNT; i++) {
    if (!save.journey.completed[i]) { firstLocked = i; break; }
  }
  const playableUpTo = firstLocked === -1 ? JOURNEY_COUNT - 1 : firstLocked; // sequential unlock, completed replayable
  for (let t = 0; t < THEMES.length; t++) {
    const theme = THEMES[t];
    const wrap = el('div', { class: 'journey-theme' });
    wrap.append(el('h3', {}, T(theme.name)), el('p', { class: 'screen-sub' }, T(theme.ambience)));
    const grid = el('div', { class: 'journey-stages' });
    for (let s = 0; s < 8; s++) {
      const idx = t * 8 + s;
      const lvl = journeyLevel(idx);
      const done = save.journey.completed[idx];
      const locked = idx > playableUpTo;
      const name = levelName(lvl);
      const btn = el('button', {
        class: 'stage-btn' + (done ? ' done' : '') + (lvl.moveLimit ? ' mastery' : '') + (locked ? ' locked' : ''),
        disabled: locked,
        'aria-label': T('Stage {n}, {name}', { n: idx + 1, name }) +
          (done ? T(', completed, best {score}', { score: done.score }) : '') +
          (locked ? T(', locked') : '') + (lvl.moveLimit ? T(', mastery stage') : ''),
        onclick: () => setupShell(lvl, { ranked: true, onStart: () => startLevel(lvl, 'journey', idx) }),
      },
        el('strong', {}, `${idx + 1}. ${name}`),
        el('span', { class: 'stars' }, done ? `★ ${done.score}` : lvl.moveLimit ? '◆ ' + T('mastery') : '·'));
      grid.append(btn);
    }
    wrap.append(grid);
    list.append(wrap);
  }
  const doneCount = Object.keys(save.journey.completed).length;
  $('journey-progress-sub').textContent = T('{done} of {total} stages restored — the cabinet diorama grows as you progress.', { done: doneCount, total: JOURNEY_COUNT });
  if (!refresh) showScreen('journey');
}

// ---------------------------------------------------------------------------
// Starting a level
// ---------------------------------------------------------------------------

function teardownCurrent() {
  if (!current) return;
  current.controller?.destroy();
  current.renderer?.dispose();
  clearInterval(snapshotTimer);
  clearInterval(current.hudTimer);
  current = null;
}

async function startLevel(level, mode, journeyIndex = null) {
  teardownCurrent();
  clearSnapshot();

  // Render layer (Three.js) unless the 2D board is forced.
  let renderer = null;
  if (!save.settings.domBoard) {
    renderer = new BoardRenderer($('gl-container'), { settings: save.settings });
    if (!renderer.init()) {
      renderer = null;
      toast(T('3D unavailable — using the 2D board. Your progress is safe.'), true);
      announce(T('WebGL unavailable. Switched to the accessible 2D board.'), true);
    }
  }

  const session = new GameSession(level, {
    allowUndo: mode === 'practice' || mode === 'learn',
    onEvents: (events) => {
      // Long-term stat: webs cleared feed the Web Clearer achievement.
      let cleared = 0;
      for (const e of events) if (e.type === 'merge' && e.unwebbed) cleared++;
      if (cleared) { save.stats.websCleared = (save.stats.websCleared || 0) + cleared; persist(); }
    },
  });

  domBoard = domBoard || new DomBoard($('dom-board'), {
    onCell: (cell) => current?.controller?.cellTap(cell),
    // Mirror keyboard focus into the 3D view so focus is visible there too.
    onFocus: (cell) => current?.renderer?.setDragTarget(cell),
  });
  domBoard.setLevel(level);

  const controller = new PlayController({
    session, renderer, domBoard, audio,
    hooks: {
      refresh: refreshHUD,
      onPause: openPause,
      onFinish: () => finishLevel(),
      onTutorialStep: (step, i, n) => {
        tutorialShown = { step, i, n };
        $('tutorial-panel').hidden = false;
        renderTutorialText();
        // The finish button appears on the closing step (no required action).
        $('tutorial-finish').hidden = step.require !== null;
        announce(T(step.text));
      },
    },
  });

  current = { session, renderer, controller, level, mode, journeyIndex, domBoard, hudTimer: null };
  if (!level.tutorial) tutorialShown = null;

  // Present.
  showScreen('play');
  if (renderer) {
    renderer.resize(); // the container only has a size once the play screen is shown
    renderer.setLevel(level, session.state);
    renderer.setRestoration(restorationFraction());
  }
  updateBoardVisibility();
  controller._sync();
  $('tutorial-panel').hidden = !level.tutorial;
  $('btn-undo').hidden = $('btn-undo-m').hidden = !session.canUndo() && !(mode === 'practice' || mode === 'learn');
  $('btn-camera').hidden = !renderer;
  wirePlayButtons();

  // Countdown (skipped under reduced motion).
  await countdown();
  session.start();
  session.resume();
  refreshHUD();

  // Periodic snapshot + timer refresh.
  clearInterval(snapshotTimer);
  snapshotTimer = setInterval(() => {
    // Always snapshot the session currently in play — a restored session
    // replaces this one after startLevel() returns.
    if (current && !current.session.finished) storeSnapshot(current.session.snapshot());
    refreshTimer();
  }, 1000);

  if (level.tutorial) controller._announceStep();
}

let tutorialShown = null;
function renderTutorialText() {
  if (!tutorialShown) return;
  const { step, i, n } = tutorialShown;
  $('tutorial-text').textContent = T('Lesson step {i}/{n}: {text}', { i: i + 1, n, text: T(step.text) });
}

function wirePlayButtons() {
  $('btn-pause').onclick = $('btn-pause-m').onclick = openPause;
  $('btn-undo').onclick = $('btn-undo-m').onclick = () => current?.controller?.doUndo();
  $('btn-hint').onclick = $('btn-hint-m').onclick = () => current?.controller?.showHint();
  $('btn-camera').onclick = () => current?.renderer?.resetCamera();
  $('btn-objectives-m').onclick = () => $('rail-left').classList.toggle('open');
  $('btn-score-m').onclick = () => $('rail-right').classList.toggle('open');
  $('tutorial-finish').onclick = () => finishLevel(true);
  // Tap board background on compact layouts to close drawers.
  $('board-region').onpointerdown = () => {
    $('rail-left').classList.remove('open');
    $('rail-right').classList.remove('open');
  };
}

function countdown() {
  return new Promise((resolve) => {
    const elc = $('countdown');
    if (save.settings.reducedMotion) { resolve(); return; }
    elc.hidden = false;
    let n = 2;
    elc.textContent = T('Ready');
    const t = setInterval(() => {
      n--;
      if (n === 1) elc.textContent = T('Set');
      else if (n <= 0) { elc.textContent = T('Go!'); }
      if (n < 0) { clearInterval(t); elc.hidden = true; resolve(); }
    }, 480);
  });
}

function restorationFraction() {
  return Object.keys(save.journey.completed).length / JOURNEY_COUNT;
}

// ---------------------------------------------------------------------------
// HUD
// ---------------------------------------------------------------------------

function fmtTime(sec) {
  const m = Math.floor(sec / 60), s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function refreshHUD() {
  if (!current) return;
  const { session, controller } = current;
  const st = session.state;

  // Requests (objective rail).
  const reqBox = $('requests');
  reqBox.innerHTML = '';
  for (const req of st.requests) {
    const card = el('div', { class: 'request-card' + (req.done ? ' done' : ''), dataset: { request: req.id } });
    const needs = el('div', { class: 'needs' });
    req.needs.forEach((n, i) => {
      const met = req.progress[i] >= n.count;
      needs.append(el('span', { class: 'need' + (met ? ' met' : '') },
        el('span', { class: 'icon', 'aria-hidden': 'true' }, itemIcon(n.chain, n.tier)),
        el('span', {}, itemName(n.chain, n.tier)),
        el('span', { class: 'count' }, `${req.progress[i]}/${n.count}`)));
    });
    card.append(needs);
    if (!req.done) {
      const sel = controller.selected >= 0 ? st.cells[controller.selected] : null;
      const canDeliver = sel && sel.kind === 'piece' && !sel.webbed &&
        req.needs.some((n, i) => req.progress[i] < n.count && n.chain === sel.chain && n.tier === sel.tier);
      const btn = el('button', {
        disabled: !canDeliver,
        onclick: () => controller.deliverSelected(req.id),
      }, canDeliver ? T('Deliver selected piece') : T('Deliver (select a matching piece)'));
      card.append(btn);
    } else {
      card.append(el('span', { class: 'sub' }, T('Complete ✓')));
    }
    reqBox.append(card);
  }
  if (!st.requests.length) {
    reqBox.append(el('p', { class: 'screen-sub' }, T('Follow the lesson steps.')));
  }

  // Score panel.
  $('score-panel').innerHTML = '';
  $('score-panel').append(el('div', { class: 'panel-box', role: 'status', 'aria-label': T('Score {score}', { score: totalScore(st) }) },
    el('div', { class: 'big-num' }, String(totalScore(st))),
    el('div', { class: 'sub' }, T('score')),
    el('div', { class: 'sub' }, T('merges {merges} · discoveries {discoveries} · requests {requests}', { merges: st.score.merge, discoveries: st.score.discovery, requests: st.score.request }))));

  // Moves panel.
  $('moves-panel').innerHTML = '';
  $('moves-panel').append(el('div', { class: 'panel-box' },
    el('div', { class: 'big-num' }, st.moveLimit !== null ? `${st.movesUsed}/${st.moveLimit}` : String(st.movesUsed)),
    el('div', { class: 'sub' }, st.moveLimit !== null ? T('actions used') : T('actions'))));

  refreshTimer();

  // Undo availability.
  $('btn-undo').hidden = $('btn-undo-m').hidden = !(current.mode === 'practice' || current.mode === 'learn');
  $('btn-undo').disabled = $('btn-undo-m').disabled = !session.canUndo();
}

function refreshTimer() {
  if (!current) return;
  const sec = current.session.elapsedSeconds();
  const par = current.level.parSeconds;
  $('timer-panel').innerHTML = '';
  $('timer-panel').append(el('div', { class: 'panel-box' },
    el('div', { class: 'big-num' }, fmtTime(sec)),
    el('div', { class: 'sub' }, par ? T('par {time}', { time: fmtTime(par) }) : T('elapsed'))));
}

// ---------------------------------------------------------------------------
// Pause
// ---------------------------------------------------------------------------

function openPause() {
  if (!current || current.session.finished) return;
  current.session.pause();
  storeSnapshot(current.session.snapshot());
  announce(T('Paused.'));
  const level = current.level, state = current.session.state;
  openModal({
    title: N('Paused'),
    body: () => el('div', {},
      el('p', {}, T('{name} — score {score} so far.', { name: levelName(level), score: totalScore(state) })),
      el('p', { class: 'screen-sub' }, T('Your board is saved locally and will resume exactly.'))),
    actions: [
      { label: N('Resume'), primary: true, onClick: () => { current?.session.resume(); announce(T('Resumed.')); } },
      { label: N('Settings'), onClick: () => openSettings() },
      { label: N('Help'), onClick: () => openHelp() },
      { label: N('Leave round'), onClick: () => {
        teardownCurrent();
        showScreen('title');
        refreshTitle();
      } },
    ],
    onClose: () => { if (current && !current.session.finished) current.session.resume(); },
  });
}

function resumeSnapshot() {
  const snap = loadSnapshot();
  if (!snap) return;
  try {
    // Undo stays a practice/learn affordance: resuming a ranked board must not
    // hand it out (the snapshot carries the level, and with it the mode).
    let snapMode = null;
    try { snapMode = JSON.parse(snap)?.level?.mode ?? null; } catch { snapMode = null; }
    const session = GameSession.restore(snap, {
      allowUndo: snapMode === 'practice' || snapMode === 'learn',
    });
    teardownCurrent();
    startRestored(session);
  } catch (e) {
    console.warn('snapshot restore failed', e);
    clearSnapshot();
  }
}

async function startRestored(session) {
  const level = session.level;
  // Reuse startLevel plumbing but with the restored session.
  await startLevel(level, session.level.mode === 'journey' ? 'journey' : level.mode,
    level.mode === 'journey' ? +level.id.split('-')[1] - 1 : null);
  if (current) {
    current.session = session;
    current.controller.session = session;
    // GameSession.restore() hands back a paused session; without this the
    // restored board's clock never advances.
    session.resume();
    current.controller._sync();
    refreshHUD();
  }
  toast(T('Board restored.'));
}

// ---------------------------------------------------------------------------
// Finish + results
// ---------------------------------------------------------------------------

function finishLevel(lessonFinished = false) {
  if (!current) return;
  const { session, level, mode, journeyIndex } = current;
  session.pause();
  clearInterval(snapshotTimer);
  clearSnapshot();

  const res = session.results();
  if (lessonFinished && mode === 'learn') { res.status = 'won'; res.terminalReason = 'lesson-complete'; }
  const won = res.status === 'won';

  // Persist progression.
  save.stats.sessions++;
  save.stats.merges += session.state.stats.merges;
  if (won) {
    if (mode === 'journey' && journeyIndex !== null) {
      const prev = save.journey.completed[journeyIndex];
      if (!prev || res.total > prev.score) {
        save.journey.completed[journeyIndex] = { score: res.total, moves: res.movesUsed, seconds: res.elapsedSeconds };
      }
    } else if (mode === 'daily') {
      const date = platform.todayUTC();
      if (!save.dailies[date]) {
        save.dailies[date] = { score: res.total, completed: true };
        if (!save.dailyStreakDays.includes(date)) save.dailyStreakDays.push(date);
      } else if (res.total > save.dailies[date].score) {
        save.dailies[date].score = res.total;
      }
    } else if (mode === 'learn') {
      save.stats.lessonsDone[level.id] = true;
    }
    // Codex: fold discoveries into the long-term collection.
    for (const [chain, tier] of Object.entries(session.state.discovered)) {
      save.codex[chain] = Math.max(save.codex[chain] ?? -1, tier);
    }
  }
  // Webs cleared (achievement stat) from events tracked in stats — count via merges onto webbed.
  persist();

  // Achievements.
  const unlocked = checkAchievements(session, won, journeyIndex);

  // Daily board (local to this device).
  if (won && mode === 'daily' && save.dailies[platform.todayUTC()]) {
    const date = platform.todayUTC();
    save.leaderboardLocal.push({
      name: platform.displayName, score: res.total, moves: res.movesUsed,
      seconds: res.elapsedSeconds, date, me: true,
    });
    // Keep the last 14 days.
    const days = [...new Set(save.leaderboardLocal.map((e) => e.date))].sort().slice(-14);
    save.leaderboardLocal = save.leaderboardLocal.filter((e) => days.includes(e.date));
    persist();
    toast(T('Daily score saved to this device’s board.'));
  }

  showResults(res, unlocked, won);
}

function checkAchievements(session, won, journeyIndex) {
  const got = [];
  const grant = (id) => {
    if (!save.achievements[id]) {
      save.achievements[id] = new Date().toISOString();
      got.push(ACHIEVEMENTS.find((a) => a.id === id));
    }
  };
  if (won) grant('first-restore');
  for (const tier of Object.values(session.state.discovered)) {
    if (tier >= 4) grant('deep-discovery');
  }
  // Count unweb merges from the command replay stats (approximate via board scan is fine:
  // a webbed-then-merged piece leaves no trace, so use events stored during play).
  if ((save.stats.websCleared || 0) >= 10) grant('web-clearer');
  if (save.dailyStreakDays.length >= 3) grant('steady-hands');
  const mastery = [7, 15, 23, 31, 39];
  if (mastery.every((i) => save.journey.completed[i])) grant('mastery-archivist');
  if (Object.keys(save.journey.completed).length >= JOURNEY_COUNT) grant('grand-curator');
  persist();
  return got;
}

// Hosted play only: post Journey, Daily and Challenge rounds to the platform
// high-score board and show the rank on the results screen. The line's state
// is kept so a language change can re-render it.
let lbSeq = 0;
let lbState = null; // null | { status: 'posting'|'posted'|'not-posted', rank }
function lbText() {
  if (!lbState) return '';
  if (lbState.status === 'posting') return T('Posting score to the leaderboard…');
  if (lbState.status === 'not-posted') return T('Score not posted to the leaderboard.');
  return lbState.rank ? T('Leaderboard rank: #{rank}', { rank: lbState.rank }) : T('Score posted to the leaderboard.');
}
function postToLeaderboard(res, mode) {
  const seq = ++lbSeq;
  lbState = null;
  if (!platform.hosted || mode === 'learn' || mode === 'practice') return;
  lbState = { status: 'posting', rank: null };
  platform.submitScore(res.total).then((r) => {
    if (seq !== lbSeq) return;
    lbState = { status: r.posted ? 'posted' : 'not-posted', rank: r.rank || null };
    const line = $('results-lb');
    if (line) line.textContent = lbText();
  });
}

const RESULT_LABELS = {
  Merges: N('Merges'), Discoveries: N('Discoveries'), Requests: N('Requests'),
  'Move bonus': N('Move bonus'), 'Time bonus': N('Time bonus'), Penalties: N('Penalties'),
};

let lastResults = null;
function showResults(res, unlocked, won, { refresh = false } = {}) {
  const { level, mode, journeyIndex } = current;
  lastResults = { res, unlocked, won };
  if (!refresh) lbState = null;
  const body = $('results-body');
  body.innerHTML = '';

  const headline = T(won ? N('Cabinet restored!') :
    res.terminalReason === 'out-of-moves' ? N('Out of actions') :
    res.terminalReason === 'no-legal-moves' ? N('The board locked up') : N('Round over'));
  body.append(el('p', { class: 'results-headline ' + (won ? 'won' : 'lost') }, headline));
  // Illustration (FLUX key art); hidden if the asset fails to load.
  const art = el('img', {
    class: 'results-art', alt: '', 'aria-hidden': 'true', decoding: 'async',
    src: won ? 'assets/cabinet-restored.webp' : 'assets/cabinet-locked.webp',
  });
  art.onerror = () => art.remove();
  body.append(art);

  // Component breakdown (spec: never one unexplained total).
  const grid = el('div', { class: 'results-breakdown', role: 'table', 'aria-label': T('Score breakdown') });
  for (const [k, v] of Object.entries(res.components)) {
    if (v === 0) continue;
    grid.append(el('div', { class: 'row', role: 'row' },
      el('span', { role: 'cell' }, T(RESULT_LABELS[k] || k)), el('span', { role: 'cell' }, String(v))));
  }
  grid.append(el('div', { class: 'row total', role: 'row' },
    el('span', { role: 'cell' }, T('Total')), el('span', { role: 'cell' }, String(res.total))));
  body.append(grid);

  const parts = [
    res.moveLimit ? T('{n} actions of {max}', { n: res.movesUsed, max: res.moveLimit }) : T('{n} actions', { n: res.movesUsed }),
    T('{n} invalid', { n: res.invalidActions }),
    res.parSeconds ? T('{time} elapsed (par {par})', { time: fmtTime(res.elapsedSeconds), par: fmtTime(res.parSeconds) }) : T('{time} elapsed', { time: fmtTime(res.elapsedSeconds) }),
    T('seed {seed}', { seed: res.seed.toString(16) }),
  ];
  body.append(el('p', { class: 'screen-sub' }, parts.join(' · ')));

  for (const a of unlocked) {
    body.append(el('p', { class: 'achievement-pop' }, '🏅 ' + T('Achievement unlocked: {name} — {desc}', { name: T(a.name), desc: T(a.desc) })));
  }
  if (lbState) body.append(el('p', { class: 'screen-sub', id: 'results-lb', role: 'status' }, lbText()));
  if (refresh) return;

  if (unlocked.length) audio.achievement();
  announce(T('{headline} Total score {total}.', { headline, total: res.total }), true);

  // Progress / next action.
  if (mode === 'journey' && won && journeyIndex !== null && journeyIndex + 1 < JOURNEY_COUNT) {
    $('btn-next').hidden = false;
    $('btn-next').onclick = () => {
      const lvl = journeyLevel(journeyIndex + 1);
      startLevel(lvl, 'journey', journeyIndex + 1);
    };
  } else {
    $('btn-next').hidden = true;
  }
  postToLeaderboard(res, mode);
  if (lbState) body.append(el('p', { class: 'screen-sub', id: 'results-lb', role: 'status' }, lbText()));
  $('btn-retry').onclick = () => startLevel(level, mode, journeyIndex);
  $('btn-results-home').onclick = () => { teardownCurrent(); refreshTitle(); showScreen('title'); };
  showScreen('results');
}

// ---------------------------------------------------------------------------
// Scores (score chase): daily board + casual local board + seed sharing
// ---------------------------------------------------------------------------

function openScores() {
  showSetup(() => {
    const body = $('setup-body');
    body.innerHTML = '';
    body.append(el('h3', {}, T('Score Chase')));
    const date = platform.todayUTC();
    body.append(el('p', { class: 'screen-sub' }, T('Daily board for {date} — scores from this device.', { date })));

    const table = el('table', { class: 'board-table' });
    table.append(el('tr', {}, el('th', {}, '#'), el('th', {}, T('Player')), el('th', {}, T('Score')), el('th', {}, T('Moves')), el('th', {}, T('Time'))));
    body.append(table);

    const entries = save.leaderboardLocal.filter((e) => e.date === date).sort((a, b) => b.score - a.score);
    if (!entries.length) body.append(el('p', {}, T('No entries yet. Finish today’s cabinet to post one.')));
    entries.slice(0, 25).forEach((e2, i) => {
      table.append(el('tr', { class: e2.me ? 'me' : '' },
        el('td', {}, String(i + 1)), el('td', {}, String(e2.name).replace(/^Guest ·/, T('Guest ·'))), el('td', {}, String(e2.score)),
        el('td', {}, String(e2.moves ?? '—')), el('td', {}, e2.seconds != null ? fmtTime(e2.seconds) : '—')));
    });

    // Shareable challenge seed.
    const shareBtn = el('button', { class: 'ghost' }, T('Copy today’s challenge seed link'));
    shareBtn.onclick = async () => {
      const url = `${location.origin}${location.pathname}?seed=${date}`;
      try { await navigator.clipboard.writeText(url); toast(T('Link copied.')); }
      catch { toast(url); }
    };
    body.append(shareBtn);
  });
}

// ---------------------------------------------------------------------------
// Codex, help, profile, settings overlays
// ---------------------------------------------------------------------------

function openCodex() {
  openModal({ title: N('Discovery Codex'), actions: [], body: () => {
    const wrap = el('div');
    wrap.append(el('p', { class: 'screen-sub' }, T('Every item tier you have ever created, across all sessions.')));
    for (const id of CHAIN_IDS) {
      const chain = CHAINS[id];
      const maxTier = save.codex[id] ?? -1;
      const box = el('div', { class: 'codex-chain' });
      box.append(el('h3', {}, chainName(id)));
      const row = el('div', { class: 'codex-tiers' });
      chain.tiers.forEach((t, i) => {
        const name = T(t.name);
        row.append(el('div', { class: 'codex-tier' + (i <= maxTier ? '' : ' undiscovered'), title: name, 'aria-label': i <= maxTier ? name : T('{name}, undiscovered', { name }) },
          el('span', { class: 'icon', 'aria-hidden': 'true' }, i <= maxTier ? t.icon : '❔')));
      });
      box.append(row);
      wrap.append(box);
    }
    return wrap;
  } });
}

function openHelp() {
  openModal({ title: N('How to play'), actions: [], body: () => {
    const wrap = el('div');
    const cards = [
      [T('Tap a Field Kit'), T('Generators (⚙️) produce new items onto free cells. Every tap counts as one action.')],
      [T('Merge identical pieces'), T('Drag one piece onto an identical piece (same kind, same tier) — or select one, then activate the other — to discover the next tier.')],
      [T('Deliver requests'), T('Select a piece a request needs, then press its Deliver button — or drag the piece onto the request card. Complete every request to finish.')],
      [T('Cobwebs'), T('Webbed pieces cannot move or be delivered. Merge a matching piece onto one to clear the web.')],
      [T('Crates'), T('Crates block cells permanently. Work around them.')],
      [T('Keyboard'), T('{move} move between cells · Enter/Space select & confirm · {cancel} cancel or pause · {undo} undo (practice) · {hint} hint · {camera} reset camera.', {
        move: ['up', 'down', 'left', 'right'].map(keyLabel).join('/'), cancel: keyLabel('cancel'), undo: keyLabel('undo'), hint: keyLabel('hint'), camera: keyLabel('camera'),
      })],
      [T('Gamepad'), T('D-pad or left stick moves focus, A confirms, B cancels, Start pauses.')],
    ];
    for (const [h, t] of cards) {
      wrap.append(el('div', { class: 'settings-group' }, el('h3', {}, h), el('p', {}, t)));
    }
    return wrap;
  } });
}

function openProfile() {
  openModal({ title: N('Curator Profile'), actions: [], body: () => {
    const s = save.stats;
    const wrap = el('div');
    wrap.append(
      el('p', {}, T('Identity: {id} (local guest)', { id: platform.id })),
      el('p', { class: 'screen-sub' }, T('Sign-in is handled by the host shell when hosted; guest practice works fully offline. Progress below is stored on this device.')),
      el('div', { class: 'settings-group' },
        el('h3', {}, T('Lifetime')),
        el('p', {}, T('{sessions} sessions · {merges} merges · {webs} webs cleared · {stages}/{total} journey stages · {dailies} dailies', {
          sessions: s.sessions, merges: s.merges, webs: s.websCleared || 0,
          stages: Object.keys(save.journey.completed).length, total: JOURNEY_COUNT, dailies: Object.keys(save.dailies).length,
        }))),
      el('div', { class: 'settings-group' },
        el('h3', {}, T('Achievements')),
        ...ACHIEVEMENTS.map((a) => el('p', {}, `${save.achievements[a.id] ? '🏅' : '⬜'} ${T(a.name)} — ${T(a.desc)}`))),
    );
    return wrap;
  } });
}

// Settings is one static body whose labels carry data-i18n, so a language
// change relabels it in place: the shared option sections (Sound, Language,
// Report a problem) that game-options.js mounts inside the Graphics box stay.
let settingsGfx = null;
function openSettings() {
  const s = save.settings;
  const wrap = el('div', { class: 'settings-grid' });
  wrap.addEventListener('change', pushSettings); // platform settings KV mirror

  const text = (key) => el('span', { 'data-i18n': key }, T(key));
  const slider = (label, key) => {
    const input = el('input', { type: 'range', min: 0, max: 1, step: 0.05, value: s[key], 'aria-label': T(label), 'data-i18n-aria': label });
    input.oninput = () => { s[key] = +input.value; persist(); applySettings(); };
    return el('label', {}, text(label), input);
  };
  const toggle = (label, key) => {
    const input = el('input', { type: 'checkbox', 'aria-label': T(label), 'data-i18n-aria': label });
    input.checked = !!s[key];
    input.onchange = () => { s[key] = input.checked; persist(); applySettings(); };
    return el('label', {}, text(label), input);
  };
  const heading = (key) => el('h3', { 'data-i18n': key }, T(key));

  const gfx = graphicsControls({
    get: () => s.graphics || {},
    set: (next) => { s.graphics = next; persist(); applySettings(); pushSettings(); },
    renderer: () => current?.renderer || null,
  });
  const gfxTitle = el('h3', {}, gfx.title);
  settingsGfx = { gfx, gfxTitle };

  wrap.append(
    el('div', { class: 'settings-group' }, heading(N('Audio')),
      slider(N('Music volume'), 'music'), slider(N('Effects volume'), 'effects'), slider(N('Ambience volume'), 'ambience'),
      toggle(N('Mute all'), 'muted')),
    el('div', { class: 'settings-group', id: 'settings-graphics', 'data-section': 'graphics' }, gfxTitle,
      gfx.el,
      toggle(N('Reduced motion'), 'reducedMotion'),
      toggle(N('High contrast'), 'highContrast')),
    el('div', { class: 'settings-group' }, heading(N('Controls')),
      toggle(N('Left-handed layout'), 'leftHanded'),
      toggle(N('Use 2D board (accessible fallback)'), 'domBoard'),
      (() => {
        const sel = el('select', { 'aria-label': T('Camera tilt'), 'data-i18n-aria': N('Camera tilt') },
          ...[['default', N('Default')], ['top', N('Top-down')]].map(([q, label]) => el('option', { value: q, selected: s.cameraTilt === q, 'data-i18n': label }, T(label))));
        sel.onchange = () => { s.cameraTilt = sel.value; persist(); applySettings(); current?.renderer?.resetCamera(); };
        return el('label', {}, text(N('Camera')), sel);
      })()),
    el('div', { class: 'settings-group' }, heading(N('Accessibility')),
      toggle(N('Larger text'), 'largeText'),
      toggle(N('Color-vision-safe palette'), 'colorBlind'),
      toggle(N('Haptics'), 'haptics'),
      toggle(N('Hints enabled'), 'hintsEnabled'),
      el('button', { class: 'ghost', 'data-i18n': N('Replay tutorials (reset lesson progress)'), onclick: () => { save.stats.lessonsDone = {}; persist(); toast(T('Lessons reset — replay them from Learn.')); } }, T('Replay tutorials (reset lesson progress)'))),
    el('div', { class: 'settings-group' }, heading(N('Data')),
      el('button', { class: 'ghost', 'data-i18n': N('Erase local progress'), onclick: () => {
        openModal({
          title: N('Erase all local progress?'),
          body: () => el('p', {}, T('This removes journey progress, codex, achievements, and settings on this device.')),
          actions: [
            { label: N('Erase everything'), primary: true, onClick: () => { localStorage.clear(); location.reload(); } },
            { label: N('Cancel') },
          ],
        });
      } }, T('Erase local progress'))),
  );
  openModal({ title: N('Settings'), body: wrap, actions: [{ label: N('Done'), primary: true }], onClose: () => { settingsGfx = null; } });
}

// The game language changed (Settings → Language, the account preference or
// Automatic): re-render whatever is on screen in place. The round, its clock,
// the save and the platform connection are untouched. Static markup and
// dialog titles/buttons were already relabelled through data-i18n.
function onLanguageChange() {
  renderStatus();
  refreshTitle();
  if (settingsGfx) { settingsGfx.gfx.relabel(); settingsGfx.gfxTitle.textContent = settingsGfx.gfx.title; }
  relabelModals();
  if (screenName === 'journey') openJourney({ refresh: true });
  else if (screenName === 'setup') refreshSetup();
  else if (screenName === 'results' && current && lastResults) showResults(lastResults.res, lastResults.unlocked, lastResults.won, { refresh: true });
  if (current) {
    refreshHUD();
    domBoard?.render(current.session.state, current.controller.selected);
    renderTutorialText();
  }
}

// ---------------------------------------------------------------------------
// Gamepad support (focus navigation among cells + confirm/cancel/pause)
// ---------------------------------------------------------------------------

function startGamepadLoop() {
  let prev = {};
  const poll = () => {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const gp = [...pads].find(Boolean);
    if (gp && current && screenName === 'play') {
      const pressed = (i) => gp.buttons[i]?.pressed && !prev[i];
      const axes = gp.axes;
      const dom = $('dom-board');
      const focusables = domBoard?.buttons || [];
      const cur = document.activeElement?.dataset?.cell;
      let idx = cur !== undefined ? +cur : 0;
      const cols = current.level.cols;
      const move = (d) => {
        idx = Math.max(0, Math.min(focusables.length - 1, idx + d));
        focusables[idx]?.focus();
      };
      if (pressed(12) || (axes[1] < -0.6 && !prev.up)) move(-cols);
      if (pressed(13) || (axes[1] > 0.6 && !prev.down)) move(cols);
      if (pressed(14) || (axes[0] < -0.6 && !prev.left)) move(-1);
      if (pressed(15) || (axes[0] > 0.6 && !prev.right)) move(1);
      prev.up = axes[1] < -0.6; prev.down = axes[1] > 0.6; prev.left = axes[0] < -0.6; prev.right = axes[0] > 0.6;
      if (pressed(0)) focusables[idx]?.click();       // A: confirm
      if (pressed(1)) current.controller.select(-1);   // B: cancel
      if (pressed(9)) openPause();                     // Start: pause
      for (let i = 0; i < gp.buttons.length; i++) prev[i] = gp.buttons[i].pressed;
      // Keep the DOM board visible for gamepad users even in 3D mode (sr mirror).
      void dom;
    }
    requestAnimationFrame(poll);
  };
  requestAnimationFrame(poll);
}

// ---------------------------------------------------------------------------
// Lifecycle: resize, visibility, snapshot safety
// ---------------------------------------------------------------------------

function wireLifecycle() {
  const onResize = () => current?.renderer?.resize();
  window.addEventListener('resize', onResize);
  window.visualViewport?.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', () => setTimeout(onResize, 60));

  document.addEventListener('visibilitychange', () => {
    const hidden = document.hidden;
    audio.setHidden(hidden);
    current?.renderer?.setPaused(hidden);
    if (hidden && current && !current.session.finished && screenName === 'play') {
      current.session.pause();
      storeSnapshot(current.session.snapshot());
    } else if (!hidden && current && screenName === 'play' && !document.querySelector('#overlay-root .overlay')) {
      current.session.resume();
      // "While you were away" summary for solo play.
      toast(T('Welcome back — the cabinet waited for you.'));
    }
  });

  window.addEventListener('pagehide', () => {
    if (current && !current.session.finished) storeSnapshot(current.session.snapshot());
  });

  window.addEventListener('error', (e) => {
    console.error(e.error || e.message);
  });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

let platformSettingsReady = false;
// Preferences mirrored to the platform settings KV.
function pushSettings() {
  if (platform.hosted && platformSettingsReady) platform.patchSettings({ ...save.settings });
}
function syncFromPlatform() {
  if (!platform.hosted) return;
  platform.fetchProfile().then(() => { refreshTitle(); renderStatus(); }).catch(() => {});
  platformSettingsReady = false;
  platform.loadCloudSave().then((remoteJson) => {
    const remote = remoteJson ? parseSave(remoteJson) : null;
    if (remote) {
      adoptSave(remote);
      persist(); // local cache mirrors the remote doc (supersedes any queued stale cloud save)
      applySettings();
      refreshTitle();
    }
    renderStatus();
  }).catch(() => {}).then(() => platform.getSettings()).then((remote) => {
    platformSettingsReady = true;
    let changed = false;
    for (const [k, v] of Object.entries(remote || {})) {
      if (!(k in save.settings) || v == null || typeof v !== typeof save.settings[k]) continue;
      save.settings[k] = v; changed = true;
    }
    if (changed) { persist(); applySettings(); }
  }, () => { platformSettingsReady = true; });
  platform.loadBindings(DEFAULT_KEYS).then(setKeyBindings).catch(() => {});
}

// Another device wrote the cloud slot since our last load (the SDK's
// conditional write got 412 and blocks further writes): reload the slot,
// merge it with this device's progress (persist.js mergeSaves) and save the
// merge back, which the reload has unblocked.
let merging = false;
function mergeCloudConflict() {
  if (merging || !platform.hosted) return;
  merging = true;
  platform.loadCloudSave().then((remoteJson) => {
    if (platform.saveConflicted() || platform.cloudLoadFailed()) return; // reload failed: writes stay blocked
    const remote = remoteJson ? parseSave(remoteJson) : null;
    adoptSave(mergeSaves(remote, save));
    persist(); // mirrors the merged doc to the cloud slot
    applySettings();
    refreshTitle();
    if (screenName === 'journey') openJourney({ refresh: true });
  }).catch(() => {}).then(() => { merging = false; });
}

async function boot() {
  onLanguage(onLanguageChange);
  applySettings();
  wireStatic();
  wireLifecycle();
  refreshTitle();
  showScreen('title');
  startGamepadLoop();
  await platform.init();
  // Signed in: remote save, platform settings and key bindings win; the
  // account nickname replaces the guest label.
  platform.onSync(renderStatus);
  platform.onAuth(() => { refreshTitle(); renderStatus(); syncFromPlatform(); });
  platform.onSaveConflict(mergeCloudConflict);
  $('btn-signin').addEventListener('click', () => platform.signIn());
  $('btn-invite').addEventListener('click', () => {
    const link = platform.inviteLink();
    if (!link) return;
    const fail = () => toast(T('Could not copy — invite link: {link}', { link }));
    try { navigator.clipboard.writeText(link).then(() => toast(T('Invite link copied to the clipboard.')), fail); } catch { fail(); }
  });
  syncFromPlatform();
  refreshTitle();
  renderStatus();
  // Shared challenge seed via URL (?seed=YYYY-MM-DD).
  const seedParam = new URLSearchParams(location.search).get('seed');
  if (seedParam && /^\d{4}-\d{2}-\d{2}$/.test(seedParam)) {
    const lvl = dailyLevel(seedParam);
    setupShell(lvl, { ranked: false, onStart: () => startLevel(lvl, 'daily') });
    toast(T('Shared challenge seed: {seed}', { seed: seedParam }));
  }
  document.body.dataset.boot = 'ok';

  // Headless/QA self-test harness: ?selftest=1 plays a scripted practice
  // round and records the outcome on <body data-selftest> for inspection.
  if (new URLSearchParams(location.search).get('selftest')) {
    try {
      const lvl = practiceLevel('easy', 12345);
      await startLevel(lvl, 'practice');
      await new Promise((r) => setTimeout(r, 2200)); // countdown
      const c = current.controller;
      const genCell = current.session.state.cells.findIndex((it) => it && it.kind === 'generator');
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      c.cellTap(genCell);
      await wait(350); // outlast the input-resolution lock
      c.cellTap(genCell);
      await wait(350);
      const la = legalActions(current.session.state);
      if (la.merges.length) c.dispatch({ type: 'merge', from: la.merges[0].from, to: la.merges[0].to });
      const st = current.session.state;
      document.body.dataset.selftest = JSON.stringify({
        renderer: !!current.renderer,
        pieces: st.cells.filter((x) => x && x.kind === 'piece').length,
        score: totalScore(st),
        merges: st.stats.merges,
        domBoardCells: $('dom-board').children.length,
        undoWorks: (() => { const okU = c.session.undo(); return okU; })(),
      });
    } catch (e) {
      document.body.dataset.selftest = 'ERROR: ' + (e && e.stack || e);
    }
  }
}

window.addEventListener('error', (e) => {
  document.body.dataset.bootError = String(e.message || e.error);
});
window.addEventListener('unhandledrejection', (e) => {
  document.body.dataset.bootError = String(e.reason);
});

boot().catch((e) => {
  document.body.dataset.bootError = String(e && e.stack || e);
  console.error('boot failed', e);
});
