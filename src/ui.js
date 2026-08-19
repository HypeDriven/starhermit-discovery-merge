// UI interaction layer: the semantic DOM board (accessibility mirror + 2D
// fallback), pointer/keyboard play controller, modal/toast/live-region
// widgets. UI state is fully separate from simulation state.

import { CHAINS, itemIcon, itemLabel } from './content.js';
import { isGenerator, isPiece, canMergeItems } from './engine/rules.js';

export function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k === 'dataset') Object.assign(e.dataset, v);
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null) continue;
    e.append(c.nodeType ? c : document.createTextNode(c));
  }
  return e;
}

// ---------------------------------------------------------------------------
// Widgets
// ---------------------------------------------------------------------------

const livePolite = () => document.getElementById('live-region');
const liveAssertive = () => document.getElementById('live-assertive');

export function announce(msg, assertive = false) {
  const region = assertive ? liveAssertive() : livePolite();
  if (!region) return;
  region.textContent = '';
  // Force AT to re-announce identical consecutive messages.
  requestAnimationFrame(() => { region.textContent = msg; });
}

export function toast(msg, isError = false) {
  const root = document.getElementById('toast-root');
  const t = el('div', { class: 'toast' + (isError ? ' err' : ''), role: 'status' }, msg);
  root.append(t);
  setTimeout(() => t.remove(), 2600);
}

export function openModal({ title, body, actions = [], onClose }) {
  const root = document.getElementById('overlay-root');
  const prevFocus = document.activeElement;
  const dialog = el('div', { class: 'dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': title });
  dialog.append(el('h2', {}, title));
  if (body) dialog.append(body);
  const actionRow = el('div', { class: 'dialog-actions' });
  dialog.append(actionRow);
  const overlay = el('div', { class: 'overlay' }, dialog);

  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', onKey, true);
    prevFocus?.focus?.();
    onClose?.();
  };
  for (const a of actions) {
    actionRow.append(el('button', { class: a.primary ? 'primary' : 'ghost', onclick: () => { a.onClick?.(); if (a.closes !== false) close(); } }, a.label));
  }
  if (!actions.length) actionRow.append(el('button', { class: 'primary', onclick: () => close() }, 'Close'));

  const onKey = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
    if (e.key === 'Tab') {
      // Simple focus trap inside the dialog.
      const focusables = dialog.querySelectorAll('button, [href], input, select, [tabindex]:not([tabindex="-1"])');
      if (!focusables.length) return;
      const first = focusables[0], last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  };
  document.addEventListener('keydown', onKey, true);
  root.append(overlay);
  dialog.querySelector('button, input, select')?.focus();
  return { close, dialog };
}

// ---------------------------------------------------------------------------
// DOM board — semantic, keyboard-operable mirror of the 3D board
// ---------------------------------------------------------------------------

export class DomBoard {
  // hooks: onCell(cell, {viaKeyboard}), onSelectionChange(cell)
  constructor(container, hooks) {
    this.container = container;
    this.hooks = hooks;
    this.state = null;
    this.level = null;
    this.selected = -1;
    this.hintCells = new Set();
    this.mergeTargets = new Set();
    this.buttons = [];
  }

  setLevel(level) {
    this.level = level;
    this.container.style.setProperty('--cols', level.cols);
    this.container.innerHTML = '';
    this.buttons = [];
    for (let i = 0; i < level.cols * level.rows; i++) {
      const b = el('button', {
        class: 'dm-cell', role: 'gridcell',
        dataset: { cell: i },
        onclick: () => this.hooks.onCell(i),
        onfocus: () => this.hooks.onFocus?.(i),
      });
      this.container.append(b);
      this.buttons.push(b);
    }
    // Arrow-key grid navigation.
    this.container.onkeydown = (e) => {
      const cell = document.activeElement?.dataset?.cell;
      if (cell === undefined) return;
      const i = +cell;
      const { cols, rows } = this.level;
      let next = -1;
      if (e.key === 'ArrowLeft') next = i % cols > 0 ? i - 1 : -1;
      else if (e.key === 'ArrowRight') next = i % cols < cols - 1 ? i + 1 : -1;
      else if (e.key === 'ArrowUp') next = i - cols >= 0 ? i - cols : -1;
      else if (e.key === 'ArrowDown') next = i + cols < cols * rows ? i + cols : -1;
      if (next >= 0) { e.preventDefault(); this.buttons[next].focus(); }
    };
  }

  describeCell(state, i) {
    const it = state.cells[i];
    const row = Math.floor(i / this.level.cols) + 1;
    const col = (i % this.level.cols) + 1;
    const pos = `row ${row}, column ${col}`;
    if (!it) return `Empty cell, ${pos}`;
    if (it.kind === 'generator') return `Field Kit generator for ${CHAINS[it.chain].name}, ${pos}. Activate to produce an item.`;
    if (it.kind === 'crate') return `Crate blocking the cell, ${pos}`;
    const name = itemLabel(it.chain, it.tier);
    return `${name}, tier ${it.tier + 1}${it.webbed ? ', cobwebbed — cannot move' : ''}, ${pos}`;
  }

  render(state, selected = -1) {
    this.state = state;
    this.selected = selected;
    this.mergeTargets = new Set();
    if (selected >= 0) {
      const sel = state.cells[selected];
      if (isPiece(sel)) {
        for (let i = 0; i < state.cells.length; i++) {
          if (i !== selected && canMergeItems(state, sel, state.cells[i]) && !sel.webbed) {
            this.mergeTargets.add(i);
          }
        }
      }
    }
    for (let i = 0; i < this.buttons.length; i++) {
      const b = this.buttons[i];
      const it = state.cells[i];
      b.setAttribute('aria-label', this.describeCell(state, i));
      b.classList.toggle('selected', i === selected);
      b.classList.toggle('hint', this.hintCells.has(i));
      b.classList.toggle('merge-target', this.mergeTargets.has(i));
      b.classList.toggle('generator', isGenerator(it));
      b.classList.toggle('crate', it?.kind === 'crate');
      b.classList.toggle('webbed', !!it?.webbed);
      // Color is reinforced by a chain letter badge (color-vision-safe mode).
      if (it && (isPiece(it) || isGenerator(it))) b.dataset.chainLetter = it.chain[0].toUpperCase();
      else delete b.dataset.chainLetter;
      b.innerHTML = '';
      if (isPiece(it) || isGenerator(it)) {
        const icon = isGenerator(it) ? '⚙️' : itemIcon(it.chain, it.tier);
        b.append(el('span', { 'aria-hidden': 'true' }, icon));
        if (isPiece(it) && it.tier > 0) {
          const pips = el('span', { class: 'pips', 'aria-hidden': 'true' });
          for (let k = 0; k <= it.tier; k++) pips.append(el('i'));
          b.append(pips);
        }
      } else if (it?.kind === 'crate') {
        b.append(el('span', { 'aria-hidden': 'true' }, '📦'));
      }
    }
  }

  setHint(hint) {
    this.hintCells = new Set();
    if (hint) {
      if (hint.kind === 'merge') { this.hintCells.add(hint.from); this.hintCells.add(hint.to); }
      else if (hint.cell !== undefined) this.hintCells.add(hint.cell);
    }
    if (this.state) this.render(this.state, this.selected);
  }
}

// ---------------------------------------------------------------------------
// Play controller: pointer + keyboard, selection model, tutorial gating
// ---------------------------------------------------------------------------

export const INVALID_TEXT = {
  'not-active': 'The round is over.',
  'out-of-moves': 'No moves left.',
  'out-of-bounds': 'That is outside the board.',
  'not-generator': 'Only a Field Kit can produce items.',
  'no-charges': 'That Field Kit is out of charges.',
  'board-full': 'The board is full — merge or deliver something first.',
  'no-piece': 'There is no piece there.',
  'same-cell': 'That is the same cell.',
  'target-occupied': 'That cell is occupied.',
  'target-empty': 'Nothing there to merge with.',
  'mismatch': 'Pieces must be the same kind and tier to merge.',
  'max-tier': 'That discovery is already at its highest tier.',
  'webbed': 'Cobwebbed pieces cannot move. Merge a matching piece onto them.',
  'no-matching-need': 'No open request needs that item.',
  'bad-request': 'That request is already complete.',
};

export class PlayController {
  // deps: session, renderer (may be null), domBoard, audio,
  //       hooks: { refresh(), onFinish(), onTutorialStep(step) }
  constructor(deps) {
    Object.assign(this, deps);
    this.selected = -1;
    this.inputLocked = false;
    this.tutorial = deps.session.level.tutorial || null;
    this.tutorialStep = 0;
    this._bindPointer();
    this._bindKeys();
    if (this.tutorial) this._announceStep();
  }

  get state() { return this.session.state; }

  // --- tutorial gating -----------------------------------------------------

  _announceStep() {
    const step = this.tutorial.steps[this.tutorialStep];
    if (!step) return;
    this.hooks.onTutorialStep?.(step, this.tutorialStep, this.tutorial.steps.length);
  }

  _tutorialAllows(cmd) {
    if (!this.tutorial) return true;
    const step = this.tutorial.steps[this.tutorialStep];
    if (!step || !step.require) return true;
    return cmd.type === step.require.type || (step.require.also || []).includes(cmd.type);
  }

  _tutorialAdvance(events) {
    if (!this.tutorial) return;
    const step = this.tutorial.steps[this.tutorialStep];
    if (!step || !step.require) return;
    if (events.some((e) => e.type === step.require.type ||
        (step.require.type === 'tap' && e.type === 'spawn'))) {
      this.tutorialStep++;
      this._announceStep();
    }
  }

  tutorialDone() {
    return this.tutorial && this.tutorialStep >= this.tutorial.steps.length - 1;
  }

  // --- input plumbing --------------------------------------------------------

  dispatch(cmd) {
    if (this.inputLocked) return;
    if (!this._tutorialAllows(cmd)) {
      const step = this.tutorial.steps[this.tutorialStep];
      this.audio.invalid();
      announce('Not yet — ' + step.text, true);
      return;
    }
    const r = this.session.dispatch(cmd);
    if (!r.ok) {
      if (r.duplicate) return;
      this.audio.invalid();
      const msg = INVALID_TEXT[r.error] || 'That action is not allowed.';
      announce(msg, true);
      if (cmd.cell !== undefined) this.renderer?.shakeCell(cmd.cell);
      if (cmd.to !== undefined) this.renderer?.shakeCell(cmd.to);
      this.hooks.refresh();
      return;
    }
    this._playEventSounds(r.events);
    this._tutorialAdvance(r.events);
    // Brief input lock mirrors the non-interruptible resolution phase.
    this.inputLocked = true;
    setTimeout(() => { this.inputLocked = false; }, 260);
    this.selected = -1;
    this._sync(r.events);
    if (this.state.status !== 'active') {
      setTimeout(() => this.hooks.onFinish(), 700);
    }
  }

  _playEventSounds(events) {
    for (const e of events) {
      if (e.type === 'spawn') this.audio.spawn();
      else if (e.type === 'merge') this.audio.merge(e.item.tier);
      else if (e.type === 'move') this.audio.move();
      else if (e.type === 'deliver') this.audio.deliver();
      else if (e.type === 'discover') { this.audio.discover(); announce(`New discovery: ${itemLabel(e.chain, e.tier)}!`); }
      else if (e.type === 'request-complete') { this.audio.requestComplete(); announce('Request complete!'); }
      else if (e.type === 'win') this.audio.win();
      else if (e.type === 'lost') this.audio.lose();
    }
  }

  _sync(events = []) {
    this.renderer?.syncState(this.state, events);
    this.renderer?.setSelected(this.selected);
    this.domBoard.render(this.state, this.selected);
    this.hooks.refresh();
  }

  select(cell) {
    if (this.selected === cell) cell = -1;
    this.selected = cell;
    this.audio.select();
    if (cell >= 0) {
      const it = this.state.cells[cell];
      if (isPiece(it)) announce(`${itemLabel(it.chain, it.tier)} selected. Choose a matching piece to merge, an empty cell to move, or a request to deliver.`);
    }
    this._sync();
  }

  // Tap/click on a cell (from either the 3D canvas or the DOM board).
  cellTap(cell) {
    if (cell < 0 || this.inputLocked) return;
    const it = this.state.cells[cell];
    if (this.selected >= 0 && this.selected !== cell) {
      const sel = this.state.cells[this.selected];
      if (isPiece(sel)) {
        if (isPiece(it)) { this.dispatch({ type: 'merge', from: this.selected, to: cell }); return; }
        if (!it) { this.dispatch({ type: 'move', from: this.selected, to: cell }); return; }
      }
    }
    if (isGenerator(it)) { this.audio.tap(); this.dispatch({ type: 'tap', cell }); return; }
    if (isPiece(it)) { this.select(cell); return; }
    if (it?.kind === 'crate') { this.audio.invalid(); announce('A crate blocks that cell.', true); return; }
    // Empty cell tap with nothing selected: acknowledge quietly.
    this.audio.tap();
  }

  deliverSelected(requestId) {
    if (this.selected < 0) { announce('Select a piece first, then deliver it.', true); return; }
    this.dispatch({ type: 'deliver', cell: this.selected, request: requestId });
  }

  showHint() {
    const hint = this.session.hint();
    if (!hint) { announce('No moves available.', true); return; }
    this.renderer?.setHint(hint);
    this.domBoard.setHint(hint);
    const text = hint.kind === 'tap'
      ? `Hint: tap the Field Kit for ${CHAINS[hint.chain].name}.`
      : hint.kind === 'merge'
        ? `Hint: merge the two ${itemLabel(hint.chain, hint.tier)} pieces.`
        : `Hint: deliver the ${itemLabel(hint.chain, hint.tier)} to its request.`;
    announce(text);
    setTimeout(() => { this.renderer?.setHint(null); this.domBoard.setHint(null); }, 2600);
  }

  // --- pointer on the 3D canvas -------------------------------------------

  _bindPointer() {
    const canvasHost = document.getElementById('gl-container');
    if (!canvasHost) return;
    let down = null;
    const DRAG_PX = 12;

    canvasHost.addEventListener('pointerdown', (e) => {
      if (!this.renderer) return;
      const cell = this.renderer.cellAt(e.clientX, e.clientY);
      down = { cell, x: e.clientX, y: e.clientY, dragging: false, id: e.pointerId };
      canvasHost.setPointerCapture(e.pointerId);
    });
    canvasHost.addEventListener('pointermove', (e) => {
      if (!down || !this.renderer) return;
      if (!down.dragging && Math.hypot(e.clientX - down.x, e.clientY - down.y) > DRAG_PX) {
        const it = this.state.cells[down.cell];
        if (isPiece(it) && !it.webbed) {
          down.dragging = true;
          this.select(down.cell);
        }
      }
      if (down.dragging) {
        const over = this.renderer.cellAt(e.clientX, e.clientY);
        this.renderer.setDragTarget(over);
        // Live deliver preview over request cards.
        const elUnder = document.elementFromPoint(e.clientX, e.clientY);
        this._dragOverRequest = elUnder?.closest?.('.request-card')?.dataset?.request || null;
      }
    });
    const finish = (e, cancelled) => {
      if (!down) return;
      const d = down;
      down = null;
      this.renderer?.setDragTarget(-1);
      if (cancelled) return;
      if (!d.dragging) { if (d.cell >= 0) this.cellTap(d.cell); return; }
      // Drag commit: deliver onto a request card, merge onto a piece, or move.
      if (this._dragOverRequest) {
        const req = this._dragOverRequest;
        this._dragOverRequest = null;
        this.selected = d.cell;
        this.dispatch({ type: 'deliver', cell: d.cell, request: req });
        return;
      }
      const target = this.renderer.cellAt(e.clientX, e.clientY);
      if (target < 0 || target === d.cell) return;
      const it = this.state.cells[target];
      if (isPiece(it)) this.dispatch({ type: 'merge', from: d.cell, to: target });
      else if (!it) this.dispatch({ type: 'move', from: d.cell, to: target });
      else this.dispatch({ type: 'merge', from: d.cell, to: target }); // produces the right invalid reason
    };
    canvasHost.addEventListener('pointerup', (e) => finish(e, false));
    canvasHost.addEventListener('pointercancel', (e) => finish(e, true));
    canvasHost.addEventListener('lostpointercapture', () => { down = null; this.renderer?.setDragTarget(-1); });
  }

  _bindKeys() {
    document.addEventListener('keydown', (e) => {
      if (document.getElementById('screen-play').hidden) return;
      if (document.querySelector('#overlay-root .overlay')) return; // modal open
      const k = e.key.toLowerCase();
      if (k === 'escape') { if (this.selected >= 0) { this.selected = -1; this._sync(); } else this.hooks.onPause?.(); }
      else if (k === 'u') this.doUndo();
      else if (k === 'h') this.showHint();
      else if (k === 'c') this.renderer?.resetCamera();
    });
  }

  doUndo() {
    if (this.session.undo()) { this.audio.undo(); announce('Undone.'); this._sync(); }
    else { this.audio.invalid(); announce('Undo is not available here.', true); }
  }
}
