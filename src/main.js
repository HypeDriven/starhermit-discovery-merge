// Bootstrap + orchestration: boot → title → mode-select → preparing →
// countdown → active ↔ paused → resolving → results → progression.
// Owns screens, save data, achievements, snapshots, and platform lifecycle.

import { GameSession } from './session.js';
import { BoardRenderer } from './render.js';
import { DomBoard, PlayController, el, announce, toast, openModal } from './ui.js';
import { AudioEngine } from './audio.js';
import { Platform } from './platform.js?v=production-qa-1';
import {
  loadSave, storeSave, storeSnapshot, loadSnapshot, clearSnapshot,
  ACHIEVEMENTS, DEFAULT_SETTINGS,
} from './persist.js';
import {
  CHAINS, THEMES, CHAIN_IDS, itemIcon, itemLabel,
  journeyLevel, JOURNEY_COUNT, dailyLevel, practiceLevel, challengeLevel,
  tutorialLevels, CHALLENGES, PRACTICE_DIFFICULTIES,
} from './content.js';
import { totalScore, legalActions } from './engine/rules.js';

// ---------------------------------------------------------------------------
// Global state
// ---------------------------------------------------------------------------

const save = loadSave();
const platform = new Platform();
const audio = new AudioEngine(save.settings);
const $ = (id) => document.getElementById(id);

let current = null; // { session, renderer, controller, level, mode, journeyIndex, domBoard }
let domBoard = null;
let snapshotTimer = null;
let dailyTimer = null;

function persist() { storeSave(save); }

// ---------------------------------------------------------------------------
// Settings application
// ---------------------------------------------------------------------------

function applySettings() {
  const s = save.settings;
  document.body.classList.toggle('reduced-motion', !!s.reducedMotion);
  document.body.classList.toggle('high-contrast', !!s.highContrast);
  document.body.classList.toggle('large-text', !!s.largeText);
  document.body.classList.toggle('colorblind', !!s.colorBlind);
  audio.applyVolumes();
  current?.renderer?.applyQuality(s.quality || 'auto');
  if (current) updateBoardVisibility();
}

function updateBoardVisibility() {
  const useDom = save.settings.domBoard || !current?.renderer;
  $('dom-board').classList.toggle('visible', !!current && useDom);
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
  return { title: 'Home', modes: 'Choose a mode', journey: 'Journey stages', setup: 'Set up game', play: 'Board', results: 'Results' }[name] || name;
}

// ---------------------------------------------------------------------------
// Title / mode select
// ---------------------------------------------------------------------------

function refreshTitle() {
  const done = Object.keys(save.journey.completed).length;
  $('journey-sub').textContent = `${done} / ${JOURNEY_COUNT} stages restored`;
  $('profile-sub').textContent = platform.id.replace('guest-', 'Guest ·');
  const today = platform.todayUTC();
  const d = save.dailies[today];
  $('daily-sub').textContent = d?.completed ? `Done today — best ${d.score}` : 'One shared seed per UTC day';
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

function setupShell(level, { ranked, onStart, extra }) {
  const body = $('setup-body');
  body.innerHTML = '';
  const mechText = level.mechanics.map((m) => ({
    merge: 'merge identical pieces', generator: 'tap Field Kits to produce items',
    crates: 'crates block cells', webbed: 'cobwebbed pieces only merge as targets',
    'move-limit': 'limited number of actions',
  }[m] || m)).join('; ');
  body.append(
    el('h3', {}, level.name),
    el('p', { class: 'rules-summary' },
      `Board ${level.cols}×${level.rows}. You will ${mechText}. ` +
      `Complete all ${level.requests.length} request${level.requests.length === 1 ? '' : 's'} to finish.`),
    el('div', { class: 'setup-meta' },
      el('span', {}, `⏱ about ${Math.max(1, Math.round((level.parSeconds || 120) / 60))} min`),
      el('span', {}, '👤 1 player'),
      el('span', {}, `🎲 seed ${level.seed.toString(16)}`),
      level.moveLimit ? el('span', {}, `🎯 ${level.moveLimit} actions max`) : null,
      el('span', { class: ranked ? 'ranked-badge' : 'unranked-badge' }, ranked ? 'Ranked' : 'Unranked — no effect on rating')),
    extra || null,
    el('button', { class: 'primary big', onclick: onStart }, 'Start'),
  );
  showScreen('setup');
}

function openModeSetup(mode) {
  audio.unlock();
  if (mode === 'journey') return openJourney();
  if (mode === 'daily') return openDailySetup();
  if (mode === 'scores') return openScores();
  if (mode === 'learn') {
    const lessons = tutorialLevels();
    const body = $('setup-body');
    body.innerHTML = '';
    body.append(el('h3', {}, 'Interactive lessons'), el('p', { class: 'rules-summary' }, 'Each lesson introduces exactly one rule and asks you to perform it.'));
    lessons.forEach((lvl, i) => {
      const done = save.stats.lessonsDone[lvl.id];
      body.append(el('button', { class: 'card-btn', onclick: () => startLevel(lvl, 'learn') },
        el('strong', {}, `${lvl.name}${done ? ' ✓' : ''}`),
        el('span', {}, lvl.tutorial.steps[0].text.slice(0, 60) + '…')));
    });
    return showScreen('setup');
  }
  if (mode === 'practice') {
    const body = $('setup-body');
    body.innerHTML = '';
    body.append(el('h3', {}, 'Practice'), el('p', { class: 'rules-summary' }, 'Undo allowed. Nothing here is ranked.'));
    for (const [key, d] of Object.entries(PRACTICE_DIFFICULTIES)) {
      body.append(el('button', { class: 'card-btn', onclick: () => startLevel(practiceLevel(key), 'practice') },
        el('strong', {}, key[0].toUpperCase() + key.slice(1)),
        el('span', {}, `${d.size}×${d.size} board, ${d.chains} chain${d.chains > 1 ? 's' : ''}, requests up to tier ${d.tierMax}`)));
    }
    return showScreen('setup');
  }
  if (mode === 'challenge') {
    const body = $('setup-body');
    body.innerHTML = '';
    body.append(el('h3', {}, 'Challenges'), el('p', { class: 'rules-summary' }, 'Constrained goals. Ranked.'));
    for (const c of CHALLENGES) {
      const lvl = challengeLevel(c.id);
      body.append(el('button', { class: 'card-btn', onclick: () => setupShell(lvl, { ranked: true, onStart: () => startLevel(lvl, 'challenge') }) },
        el('strong', {}, c.name), el('span', {}, c.blurb)));
    }
    return showScreen('setup');
  }
}

function openDailySetup() {
  const date = platform.todayUTC();
  const lvl = dailyLevel(date);
  const done = save.dailies[date];
  const countdown = el('p', { class: 'screen-sub' });
  const tick = () => {
    const ms = platform.msUntilNextUTCDay();
    const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000), s = Math.floor((ms % 60000) / 1000);
    countdown.textContent = `Next daily seed in ${h}h ${m}m ${s}s (platform-synchronized UTC)`;
  };
  tick();
  clearInterval(dailyTimer);
  dailyTimer = setInterval(tick, 1000);
  setupShell(lvl, {
    ranked: !done?.completed,
    onStart: () => { clearInterval(dailyTimer); startLevel(lvl, 'daily'); },
    extra: el('p', {}, done?.completed
      ? `You already completed today’s cabinet (score ${done.score}). Replay for practice — first completion is what ranks.`
      : 'Today’s cabinet is unclaimed. Your first completion counts for the daily board.'),
  });
}

// ---------------------------------------------------------------------------
// Journey screen
// ---------------------------------------------------------------------------

function openJourney() {
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
    wrap.append(el('h3', {}, `${theme.name}`), el('p', { class: 'screen-sub' }, theme.ambience));
    const grid = el('div', { class: 'journey-stages' });
    for (let s = 0; s < 8; s++) {
      const idx = t * 8 + s;
      const lvl = journeyLevel(idx);
      const done = save.journey.completed[idx];
      const locked = idx > playableUpTo;
      const btn = el('button', {
        class: 'stage-btn' + (done ? ' done' : '') + (lvl.moveLimit ? ' mastery' : '') + (locked ? ' locked' : ''),
        disabled: locked,
        'aria-label': `Stage ${idx + 1}, ${lvl.name}${done ? ', completed, best ' + done.score : ''}${locked ? ', locked' : ''}${lvl.moveLimit ? ', mastery stage' : ''}`,
        onclick: () => setupShell(lvl, { ranked: true, onStart: () => startLevel(lvl, 'journey', idx) }),
      },
        el('strong', {}, `${idx + 1}. ${lvl.name}`),
        el('span', { class: 'stars' }, done ? `★ ${done.score}` : lvl.moveLimit ? '◆ mastery' : '·'));
      grid.append(btn);
    }
    wrap.append(grid);
    list.append(wrap);
  }
  const doneCount = Object.keys(save.journey.completed).length;
  $('journey-progress-sub').textContent = `${doneCount} of ${JOURNEY_COUNT} stages restored — the cabinet diorama grows as you progress.`;
  showScreen('journey');
}

// ---------------------------------------------------------------------------
// Starting a level
// ---------------------------------------------------------------------------

function teardownCurrent() {
  if (!current) return;
  current.renderer?.dispose();
  clearInterval(snapshotTimer);
  clearInterval(current.hudTimer);
  platform.stopPresence();
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
      toast('3D unavailable — using the 2D board. Your progress is safe.', true);
      announce('WebGL unavailable. Switched to the accessible 2D board.', true);
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
  });
  domBoard.setLevel(level);

  const controller = new PlayController({
    session, renderer, domBoard, audio,
    hooks: {
      refresh: refreshHUD,
      onPause: openPause,
      onFinish: () => finishLevel(),
      onTutorialStep: (step, i, n) => {
        $('tutorial-panel').hidden = false;
        $('tutorial-text').textContent = `Lesson step ${i + 1}/${n}: ${step.text}`;
        // The finish button appears on the closing step (no required action).
        $('tutorial-finish').hidden = step.require !== null;
        announce(step.text);
      },
    },
  });

  current = { session, renderer, controller, level, mode, journeyIndex, domBoard, hudTimer: null };

  // Present.
  showScreen('play');
  if (renderer) {
    renderer.setLevel(level, session.state);
    renderer.setRestoration(restorationFraction());
  }
  updateBoardVisibility();
  controller._sync();
  $('tutorial-panel').hidden = !level.tutorial;
  $('btn-undo').hidden = $('btn-undo-m').hidden = !session.canUndo() && !(mode === 'practice' || mode === 'learn');
  $('btn-camera').hidden = !renderer;
  wirePlayButtons();

  platform.track('start', { mode, level: level.id });
  platform.activityStart(level.id);
  platform.startPresence();

  // Countdown (skipped under reduced motion).
  await countdown();
  session.start();
  session.resume();
  refreshHUD();

  // Periodic snapshot + timer refresh.
  clearInterval(snapshotTimer);
  snapshotTimer = setInterval(() => {
    if (current && !current.session.finished) storeSnapshot(session.snapshot());
    refreshTimer();
  }, 1000);

  if (level.tutorial) controller._announceStep();
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
    elc.textContent = 'Ready';
    const t = setInterval(() => {
      n--;
      if (n === 1) elc.textContent = 'Set';
      else if (n <= 0) { elc.textContent = 'Go!'; }
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
        el('span', {}, itemLabel(n.chain, n.tier)),
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
      }, canDeliver ? 'Deliver selected piece' : 'Deliver (select a matching piece)');
      card.append(btn);
    } else {
      card.append(el('span', { class: 'sub' }, 'Complete ✓'));
    }
    reqBox.append(card);
  }
  if (!st.requests.length) {
    reqBox.append(el('p', { class: 'screen-sub' }, 'Follow the lesson steps.'));
  }

  // Score panel.
  $('score-panel').innerHTML = '';
  $('score-panel').append(el('div', { class: 'panel-box', role: 'status', 'aria-label': `Score ${totalScore(st)}` },
    el('div', { class: 'big-num' }, String(totalScore(st))),
    el('div', { class: 'sub' }, 'score'),
    el('div', { class: 'sub' }, `merges ${st.score.merge} · discoveries ${st.score.discovery} · requests ${st.score.request}`)));

  // Moves panel.
  $('moves-panel').innerHTML = '';
  $('moves-panel').append(el('div', { class: 'panel-box' },
    el('div', { class: 'big-num' }, st.moveLimit !== null ? `${st.movesUsed}/${st.moveLimit}` : String(st.movesUsed)),
    el('div', { class: 'sub' }, st.moveLimit !== null ? 'actions used' : 'actions')));

  refreshTimer();

  // Undo availability.
  const undoOk = session.canUndo() || (current.mode === 'practice' && !session.finished);
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
    el('div', { class: 'sub' }, par ? `par ${fmtTime(par)}` : 'elapsed')));
}

// ---------------------------------------------------------------------------
// Pause
// ---------------------------------------------------------------------------

function openPause() {
  if (!current || current.session.finished) return;
  current.session.pause();
  storeSnapshot(current.session.snapshot());
  announce('Paused.');
  openModal({
    title: 'Paused',
    body: el('div', {},
      el('p', {}, `${current.level.name} — score ${totalScore(current.session.state)} so far.`),
      el('p', { class: 'screen-sub' }, 'Your board is saved locally and will resume exactly.')),
    actions: [
      { label: 'Resume', primary: true, onClick: () => { current?.session.resume(); announce('Resumed.'); } },
      { label: 'Settings', onClick: () => openSettings() },
      { label: 'Help', onClick: () => openHelp() },
      { label: 'Leave round', onClick: () => {
        platform.activityEnd(current.level.id, 'abandoned');
        platform.track('round-end', { mode: current.mode, level: current.level.id });
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
    const session = GameSession.restore(snap, { allowUndo: true });
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
    current.controller._sync();
    refreshHUD();
  }
  toast('Board restored.');
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
  platform.stopPresence();

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

  // Score submission.
  let submitNote = null;
  if (won && mode === 'daily' && save.dailies[platform.todayUTC()]) {
    const envelope = session.replayEnvelope();
    platform.submitDaily({ date: platform.todayUTC(), envelope, name: platform.id }).then((r) => {
      if (r.ok) toast(`Daily score submitted (rank #${r.rank ?? '—'})`);
      else {
        // Casual fallback: local board only.
        save.leaderboardLocal.push({ name: platform.id, score: res.total, date: platform.todayUTC(), me: true });
        persist();
        toast('Offline — score kept on the casual local board.');
      }
    });
  }

  platform.activityEnd(level.id, res.status);
  platform.track('round-end', { mode, level: level.id });

  showResults(res, unlocked, won, submitNote);
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

function showResults(res, unlocked, won) {
  const { session, level, mode, journeyIndex } = current;
  const body = $('results-body');
  body.innerHTML = '';

  const headline = won ? 'Cabinet restored!' :
    res.terminalReason === 'out-of-moves' ? 'Out of actions' :
    res.terminalReason === 'no-legal-moves' ? 'The board locked up' : 'Round over';
  body.append(el('p', { class: 'results-headline ' + (won ? 'won' : 'lost') }, headline));

  // Component breakdown (spec: never one unexplained total).
  const grid = el('div', { class: 'results-breakdown', role: 'table', 'aria-label': 'Score breakdown' });
  for (const [k, v] of Object.entries(res.components)) {
    if (v === 0) continue;
    grid.append(el('div', { class: 'row', role: 'row' },
      el('span', { role: 'cell' }, k), el('span', { role: 'cell' }, String(v))));
  }
  grid.append(el('div', { class: 'row total', role: 'row' },
    el('span', { role: 'cell' }, 'Total'), el('span', { role: 'cell' }, String(res.total))));
  body.append(grid);

  body.append(el('p', { class: 'screen-sub' },
    `${res.movesUsed} actions${res.moveLimit ? ' of ' + res.moveLimit : ''} · ${res.invalidActions} invalid · ` +
    `${fmtTime(res.elapsedSeconds)} elapsed${res.parSeconds ? ' (par ' + fmtTime(res.parSeconds) + ')' : ''} · seed ${res.seed.toString(16)}`));

  for (const a of unlocked) {
    body.append(el('p', { class: 'achievement-pop' }, `🏅 Achievement unlocked: ${a.name} — ${a.desc}`));
  }
  announce(`${headline} Total score ${res.total}.`, true);

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
  $('btn-retry').onclick = () => startLevel(level, mode, journeyIndex);
  $('btn-results-home').onclick = () => { teardownCurrent(); refreshTitle(); showScreen('title'); };
  platform.track(won ? 'round-end' : 'retry', { mode, level: level.id });
  showScreen('results');
}

// ---------------------------------------------------------------------------
// Scores (score chase): daily board + casual local board + seed sharing
// ---------------------------------------------------------------------------

async function openScores() {
  const body = $('setup-body');
  body.innerHTML = '';
  body.append(el('h3', {}, 'Score Chase'));
  const date = platform.todayUTC();
  body.append(el('p', { class: 'screen-sub' }, `Daily board for ${date}. Submissions are replay-validated when online; offline scores are marked casual.`));

  const table = el('table', { class: 'board-table' });
  table.append(el('tr', {}, el('th', {}, '#'), el('th', {}, 'Player'), el('th', {}, 'Score'), el('th', {}, 'Moves'), el('th', {}, 'Time')));
  body.append(table);
  showScreen('setup');

  const remote = await platform.fetchDailyBoard(date);
  const local = save.leaderboardLocal.filter((e) => e.date === date);
  const entries = remote && remote.length ? remote : local;
  if (!entries.length) {
    body.append(el('p', {}, remote === null
      ? 'Offline — no local entries yet. Finish today’s cabinet to post one.'
      : 'No entries yet — be the first to restore today’s cabinet.'));
  }
  entries.slice(0, 25).forEach((e2, i) => {
    table.append(el('tr', { class: e2.me || e2.name === platform.id ? 'me' : '' },
      el('td', {}, String(i + 1)), el('td', {}, e2.name), el('td', {}, String(e2.score)),
      el('td', {}, String(e2.moves ?? '—')), el('td', {}, e2.seconds != null ? fmtTime(e2.seconds) : '—')));
  });
  if (!remote) body.append(el('p', { class: 'screen-sub' }, 'Casual board (offline, not validated).'));

  // Shareable challenge seed.
  const shareBtn = el('button', { class: 'ghost' }, 'Copy today’s challenge seed link');
  shareBtn.onclick = async () => {
    const url = `${location.origin}${location.pathname}?seed=${date}`;
    try { await navigator.clipboard.writeText(url); toast('Link copied.'); }
    catch { toast(url); }
  };
  body.append(shareBtn);
}

// ---------------------------------------------------------------------------
// Codex, help, profile, settings overlays
// ---------------------------------------------------------------------------

function openCodex() {
  const wrap = el('div');
  wrap.append(el('p', { class: 'screen-sub' }, 'Every item tier you have ever created, across all sessions.'));
  for (const id of CHAIN_IDS) {
    const chain = CHAINS[id];
    const maxTier = save.codex[id] ?? -1;
    const box = el('div', { class: 'codex-chain' });
    box.append(el('h3', {}, chain.name));
    const row = el('div', { class: 'codex-tiers' });
    chain.tiers.forEach((t, i) => {
      row.append(el('div', { class: 'codex-tier' + (i <= maxTier ? '' : ' undiscovered'), title: t.name, 'aria-label': `${t.name}${i <= maxTier ? '' : ', undiscovered'}` },
        el('span', { class: 'icon', 'aria-hidden': 'true' }, i <= maxTier ? t.icon : '❔')));
    });
    box.append(row);
    wrap.append(box);
  }
  openModal({ title: 'Discovery Codex', body: wrap, actions: [] });
}

function openHelp() {
  const wrap = el('div');
  const cards = [
    ['Tap a Field Kit', 'Generators (⚙️) produce new items onto free cells. Every tap counts as one action.'],
    ['Merge identical pieces', 'Drag one piece onto an identical piece (same kind, same tier) — or select one, then activate the other — to discover the next tier.'],
    ['Deliver requests', 'Select a piece a request needs, then press its Deliver button — or drag the piece onto the request card. Complete every request to finish.'],
    ['Cobwebs', 'Webbed pieces cannot move or be delivered. Merge a matching piece onto one to clear the web.'],
    ['Crates', 'Crates block cells permanently. Work around them.'],
    ['Keyboard', 'Arrow keys move between cells · Enter/Space select & confirm · Esc cancel or pause · U undo (practice) · H hint · C reset camera.'],
    ['Gamepad', 'D-pad or left stick moves focus, A confirms, B cancels, Start pauses.'],
  ];
  for (const [h, t] of cards) {
    wrap.append(el('div', { class: 'settings-group' }, el('h3', {}, h), el('p', {}, t)));
  }
  openModal({ title: 'How to play', body: wrap, actions: [] });
}

function openProfile() {
  const s = save.stats;
  const wrap = el('div');
  wrap.append(
    el('p', {}, `Identity: ${platform.id} (local guest)`),
    el('p', { class: 'screen-sub' }, 'Sign-in is handled by the host shell when hosted; guest practice works fully offline. Progress below is stored on this device.'),
    el('div', { class: 'settings-group' },
      el('h3', {}, 'Lifetime'),
      el('p', {}, `${s.sessions} sessions · ${s.merges} merges · ${(s.websCleared || 0)} webs cleared · ${Object.keys(save.journey.completed).length}/${JOURNEY_COUNT} journey stages · ${Object.keys(save.dailies).length} dailies`)),
    el('div', { class: 'settings-group' },
      el('h3', {}, 'Achievements'),
      ...ACHIEVEMENTS.map((a) => el('p', {}, `${save.achievements[a.id] ? '🏅' : '⬜'} ${a.name} — ${a.desc}`))),
  );
  openModal({ title: 'Curator Profile', body: wrap, actions: [] });
}

function openSettings() {
  const s = save.settings;
  const wrap = el('div', { class: 'settings-grid' });

  const slider = (label, key) => {
    const input = el('input', { type: 'range', min: 0, max: 1, step: 0.05, value: s[key], 'aria-label': label });
    input.oninput = () => { s[key] = +input.value; persist(); applySettings(); };
    return el('label', {}, label, input);
  };
  const toggle = (label, key) => {
    const input = el('input', { type: 'checkbox', 'aria-label': label });
    input.checked = !!s[key];
    input.onchange = () => { s[key] = input.checked; persist(); applySettings(); platform.track('settings-change'); };
    return el('label', {}, label, input);
  };

  wrap.append(
    el('div', { class: 'settings-group' }, el('h3', {}, 'Audio'),
      slider('Music volume', 'music'), slider('Effects volume', 'effects'), slider('Ambience volume', 'ambience'),
      toggle('Mute all', 'muted')),
    el('div', { class: 'settings-group' }, el('h3', {}, 'Graphics'),
      (() => {
        const sel = el('select', { 'aria-label': 'Graphics quality' },
          ...['auto', 'low', 'medium', 'high'].map((q) => el('option', { value: q, selected: s.quality === q }, q)));
        sel.onchange = () => { s.quality = sel.value; persist(); applySettings(); };
        return el('label', {}, 'Quality tier', sel);
      })(),
      toggle('Reduced motion', 'reducedMotion'),
      toggle('High contrast', 'highContrast')),
    el('div', { class: 'settings-group' }, el('h3', {}, 'Controls'),
      toggle('Left-handed layout', 'leftHanded'),
      toggle('Use 2D board (accessible fallback)', 'domBoard'),
      (() => {
        const sel = el('select', { 'aria-label': 'Camera tilt' },
          ...['default', 'top'].map((q) => el('option', { value: q, selected: s.cameraTilt === q }, q)));
        sel.onchange = () => { s.cameraTilt = sel.value; persist(); applySettings(); current?.renderer?.resetCamera(); };
        return el('label', {}, 'Camera', sel);
      })()),
    el('div', { class: 'settings-group' }, el('h3', {}, 'Accessibility'),
      toggle('Larger text', 'largeText'),
      toggle('Color-vision-safe palette', 'colorBlind'),
      toggle('Haptics', 'haptics'),
      toggle('Hints enabled', 'hintsEnabled'),
      el('button', { class: 'ghost', onclick: () => { save.stats.lessonsDone = {}; persist(); toast('Lessons reset — replay them from Learn.'); } }, 'Replay tutorials (reset lesson progress)')),
    el('div', { class: 'settings-group' }, el('h3', {}, 'Data'),
      el('button', { class: 'ghost', onclick: () => {
        openModal({
          title: 'Erase all local progress?',
          body: el('p', {}, 'This removes journey progress, codex, achievements, and settings on this device.'),
          actions: [
            { label: 'Erase everything', primary: true, onClick: () => { localStorage.clear(); location.reload(); } },
            { label: 'Cancel' },
          ],
        });
      } }, 'Erase local progress')),
  );
  openModal({ title: 'Settings', body: wrap, actions: [{ label: 'Done', primary: true }] });
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
      toast('Welcome back — the cabinet waited for you.');
    }
  });

  window.addEventListener('pagehide', () => {
    if (current && !current.session.finished) storeSnapshot(current.session.snapshot());
  });

  window.addEventListener('error', (e) => {
    platform.track('error', { level: current?.level?.id });
    console.error(e.error || e.message);
  });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function boot() {
  applySettings();
  wireStatic();
  wireLifecycle();
  refreshTitle();
  showScreen('title');
  startGamepadLoop();
  await platform.init();
  refreshTitle();
  $('topbar-status').textContent = platform.online ? 'Connected to host' : 'Offline mode — fully playable';
  // Shared challenge seed via URL (?seed=YYYY-MM-DD).
  const seedParam = new URLSearchParams(location.search).get('seed');
  if (seedParam && /^\d{4}-\d{2}-\d{2}$/.test(seedParam)) {
    const lvl = dailyLevel(seedParam);
    setupShell(lvl, { ranked: false, onStart: () => startLevel(lvl, 'daily') });
    toast(`Shared challenge seed: ${seedParam}`);
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
