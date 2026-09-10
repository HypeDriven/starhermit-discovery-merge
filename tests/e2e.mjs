// Discovery Merge — end-to-end QA playthrough (dev only, not shipped).
//
// Drives the real visible UI in headless Chrome (playwright-core + system
// Chrome), twice: desktop 1280x800 and mobile 390x844 (touch). Per pass:
//   title → settings (enable 2D board + reduced motion, close) → journey →
//   stage 1 setup → start → play the board by clicking real DOM-board cells
//   (tap generators, merge identical pieces, deliver to request cards) plus
//   hint + pause/resume, until the results screen shows a win → back home.
//
// The game is fully playable offline; this test serves the repo with an
// embedded static server (no /api backend), so the daily leaderboard runs in
// its designed "casual local board" fallback. Ranked server validation is
// covered separately by tests/e2e.smoke.mjs.
//
// Game state (cell aria-labels, request cards) is read only to decide the
// next move; every action goes through page clicks on visible elements.

import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SHOT = (stage, vp) => `/tmp/discovery-merge-e2e-${stage}-${vp}.png`;

// Benign GPU/swiftshader noise (mirrors tools/production_game_audit.mjs).
const browserNoise = /GL Driver Message|GPU stall due to ReadPixels|Automatic fallback to software WebGL|EnableWebGLDeveloperExtensions|Failed to load resource.*favicon/i;

// ---------------------------------------------------------------------------
// Embedded static file server (ephemeral port)
// ---------------------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.glb': 'model/gltf-binary',
  '.woff2': 'font/woff2',
  '.ts': 'text/typescript',
};

function startServer() {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname.startsWith('/api/')) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'offline' }));
      }
      let p = decodeURIComponent(url.pathname);
      if (p === '/') p = '/index.html';
      const filePath = normalize(join(ROOT, p));
      if (!filePath.startsWith(ROOT)) { res.writeHead(403); return res.end('forbidden'); }
      const st = await stat(filePath).catch(() => null);
      if (!st || !st.isFile()) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, {
        'Content-Type': MIME[extname(filePath)] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
        'Content-Length': st.size,
      });
      res.end(await readFile(filePath));
    } catch {
      res.writeHead(500); res.end('internal');
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

// ---------------------------------------------------------------------------
// In-page board inspection (visible UI state: aria-labels + request cards)
// ---------------------------------------------------------------------------

function readBoard(page) {
  return page.evaluate(() => {
    const cells = [...document.querySelectorAll('#dom-board .dm-cell')].map((b) => {
      const label = b.getAttribute('aria-label') || '';
      const i = +b.dataset.cell;
      if (label.startsWith('Empty cell')) return { i, kind: 'empty' };
      if (label.startsWith('Crate blocking')) return { i, kind: 'crate' };
      if (label.startsWith('Field Kit generator')) return { i, kind: 'generator' };
      const m = label.match(/^(.+), tier (\d+)(, cobwebbed)?/);
      if (m) return { i, kind: 'piece', name: m[1], tier: +m[2], webbed: !!m[3] };
      return { i, kind: 'unknown', label };
    });
    const requests = [...document.querySelectorAll('.request-card')].map((card, idx) => ({
      idx,
      done: card.classList.contains('done'),
      needs: [...card.querySelectorAll('.need')].map((n) => ({
        name: n.children[1]?.textContent || '',
        met: n.classList.contains('met'),
        count: n.querySelector('.count')?.textContent || '',
      })),
    }));
    const selected = document.querySelector('#dom-board .dm-cell.selected');
    return {
      cells,
      requests,
      selected: selected ? +selected.dataset.cell : -1,
      moves: document.querySelector('#moves-panel .big-num')?.textContent || '',
      resultsVisible: !document.getElementById('screen-results').hidden,
    };
  });
}

// ---------------------------------------------------------------------------
// UI action helpers (real clicks only)
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ensureNoSelection(page) {
  const sel = page.locator('#dom-board .dm-cell.selected');
  if (await sel.count()) {
    await sel.first().click(); // tapping the selected cell deselects it
    await page.waitForTimeout(120);
  }
}

async function tapCell(page, i) {
  await page.locator(`#dom-board .dm-cell[data-cell="${i}"]`).click();
}

async function mergeCells(page, from, to) {
  await ensureNoSelection(page);
  await tapCell(page, from);
  await page.waitForTimeout(120);
  await tapCell(page, to);
  await page.waitForTimeout(340); // outlast the 260ms input-resolution lock
}

async function deliverPiece(page, cellIdx, cardIdx, isMobile) {
  await ensureNoSelection(page);
  await tapCell(page, cellIdx); // select the piece
  if (isMobile) {
    await page.locator('#btn-objectives-m').click(); // open the Requests drawer
  }
  const btn = page.locator('.request-card').nth(cardIdx).locator('button');
  await page.waitForFunction(
    (ci) => {
      const card = document.querySelectorAll('.request-card')[ci];
      const b = card?.querySelector('button');
      return b && !b.disabled;
    },
    cardIdx,
    { timeout: 4000 },
  );
  await btn.click();
  await page.waitForTimeout(340);
}

// Greedy playthrough, same priority as the repo's solver tests:
// deliver > merge highest-tier pair > tap a generator.
async function playUntilResults(page, isMobile, hooks) {
  let actions = 0;
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    const b = await readBoard(page);
    if (b.resultsVisible) return { actions, board: b };
    if (actions >= 600) throw new Error('playthrough exceeded 600 actions without finishing');

    if (actions === 3 && hooks?.onMidPlay) await hooks.onMidPlay();

    // 1. Deliver: an unwebbed piece matching an open need.
    let did = false;
    for (const req of b.requests) {
      if (req.done) continue;
      for (const need of req.needs) {
        if (need.met) continue;
        const piece = b.cells.find((c) => c.kind === 'piece' && !c.webbed && c.name === need.name);
        if (piece) {
          await deliverPiece(page, piece.i, req.idx, isMobile);
          did = true;
          break;
        }
      }
      if (did) break;
    }

    // 2. Merge: highest-tier identical pair (source unwebbed, tier below max).
    if (!did) {
      const pieces = b.cells.filter((c) => c.kind === 'piece' && c.tier < 6);
      const byName = new Map();
      for (const p of pieces) {
        if (!byName.has(p.name)) byName.set(p.name, []);
        byName.get(p.name).push(p);
      }
      const pairs = [...byName.values()]
        .filter((g) => g.length >= 2 && g.some((p) => !p.webbed))
        .sort((a, c) => c[0].tier - a[0].tier);
      if (pairs.length) {
        const g = pairs[0];
        const from = g.find((p) => !p.webbed);
        const to = g.find((p) => p.i !== from.i);
        await mergeCells(page, from.i, to.i);
        did = true;
      }
    }

    // 3. Tap a generator (only if the board has a free cell).
    if (!did) {
      const gen = b.cells.find((c) => c.kind === 'generator');
      const free = b.cells.some((c) => c.kind === 'empty');
      if (gen && free) {
        await ensureNoSelection(page);
        await tapCell(page, gen.i);
        await page.waitForTimeout(340);
        did = true;
      }
    }

    if (!did) {
      throw new Error('stuck: no deliver/merge/tap available — board: ' + JSON.stringify(b.cells));
    }
    actions++;
  }
  throw new Error('playthrough timed out after 180s');
}

// ---------------------------------------------------------------------------
// One full viewport pass
// ---------------------------------------------------------------------------

async function runPass(browser, vp) {
  const isMobile = vp.name === 'mobile';
  const context = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    hasTouch: isMobile,
    isMobile,
  });
  await context.addInitScript(() => localStorage.setItem('discovery-merge.guest.v1', 'guest-4294967295-4294967295'));
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    // The platform adapter polls same-origin /api routes (time, presence,
    // activity, telemetry); with no backend those 404 by design (the game
    // runs in its supported offline mode). Ignore exactly those.
    const url = m.location()?.url || '';
    if (m.text().startsWith('Failed to load resource') && url.includes('/api/')) return;
    if (!browserNoise.test(m.text())) errors.push(`console: ${m.text()} (${url})`);
  });

  const step = async (name, fn) => {
    await fn();
    console.log(`ok - [${vp.name}] ${name}`);
  };

  try {
    await step('load + boot + title visible', async () => {
      await page.goto(`http://127.0.0.1:${vp.port}/`, { waitUntil: 'load' });
      await page.waitForFunction(() => document.body.dataset.boot === 'ok', null, { timeout: 15000 });
      await page.waitForSelector('#screen-title:not([hidden])');
      const err = await page.evaluate(() => document.body.dataset.bootError || null);
      if (err) throw new Error('boot error: ' + err);
      await page.screenshot({ path: SHOT('title', vp.name) });
    });

    await step('settings: enable 2D board + reduced motion, close', async () => {
      await page.click('#btn-settings');
      await page.waitForSelector('#overlay-root .overlay');
      await page.getByLabel('Use 2D board (accessible fallback)').check();
      await page.getByLabel('Reduced motion').check();
      await page.screenshot({ path: SHOT('settings', vp.name) });
      await page.getByRole('button', { name: 'Done' }).click();
      await page.waitForSelector('#overlay-root .overlay', { state: 'detached' });
    });

    await step('journey screen lists 40 stages, stage 1 unlocked', async () => {
      await page.click('#btn-journey');
      await page.waitForSelector('#screen-journey:not([hidden])');
      const total = await page.locator('.stage-btn').count();
      if (total !== 40) throw new Error(`expected 40 stage buttons, got ${total}`);
      const unlocked = await page.locator('.stage-btn:not(.locked)').count();
      if (unlocked !== 1) throw new Error(`expected 1 unlocked stage, got ${unlocked}`);
      // Regression guard: #screen-title's `display:flex` ID rule used to
      // outrank `.screen[hidden]`, leaving the title screen painted under
      // every other screen.
      const titleDisplay = await page.evaluate(
        () => getComputedStyle(document.getElementById('screen-title')).display,
      );
      if (titleDisplay !== 'none') {
        throw new Error(`hidden #screen-title is still rendered (display:${titleDisplay})`);
      }
      await page.screenshot({ path: SHOT('journey', vp.name) });
    });

    await step('stage 1 setup → start → play screen', async () => {
      await page.locator('.stage-btn:not(.locked)').first().click();
      await page.waitForSelector('#screen-setup:not([hidden])');
      await page.screenshot({ path: SHOT('setup', vp.name) });
      await page.locator('#setup-body button.primary.big').click();
      await page.waitForSelector('#screen-play:not([hidden])');
      // Reduced motion skips the countdown; give the session a beat to start.
      await page.waitForTimeout(600);
      if (!(await page.locator('#dom-board.visible').count())) {
        throw new Error('2D board not visible after start');
      }
      await page.screenshot({ path: SHOT('play', vp.name) });
    });

    let midPlayed = false;
    await step('hint + pause/resume during play', async () => {
      // Exercise hint on the very first board, then let the play loop run a
      // few actions and trigger pause/resume mid-round via the hook below.
      await page.click(isMobile ? '#btn-hint-m' : '#btn-hint');
      await page.waitForTimeout(300);
      midPlayed = true;
    });

    const result = await step('play stage 1 to a results screen (real UI clicks)', async () => {
      const r = await playUntilResults(page, isMobile, {
        onMidPlay: async () => {
          await page.click(isMobile ? '#btn-pause-m' : '#btn-pause');
          await page.waitForSelector('#overlay-root .overlay');
          await page.screenshot({ path: SHOT('pause', vp.name) });
          await page.getByRole('button', { name: 'Resume' }).click();
          await page.waitForSelector('#overlay-root .overlay', { state: 'detached' });
        },
      });
      console.log(`  actions taken: ${r.actions}, moves used: ${r.board.moves}`);
      return r;
    });
    void result;

    await step('results screen shows a win with score breakdown', async () => {
      await page.waitForSelector('#screen-results:not([hidden])', { timeout: 8000 });
      const headline = await page.textContent('.results-headline');
      console.log('  headline:', headline.trim());
      if (!/Cabinet restored!/.test(headline)) {
        throw new Error('stage 1 was not won: ' + headline.trim());
      }
      const rows = await page.locator('.results-breakdown .row').count();
      if (rows < 2) throw new Error(`expected score breakdown rows, got ${rows}`);
      if (await page.locator('#btn-next').isHidden()) {
        throw new Error('Next stage button hidden after a journey win');
      }
      await page.screenshot({ path: SHOT('results', vp.name) });
    });

    await step('progress persisted + back home', async () => {
      const saved = await page.evaluate(() => {
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          const v = localStorage.getItem(k);
          if (v && v.includes('"journey"')) return { key: k, value: v };
        }
        return null;
      });
      if (!saved || !saved.value.includes('"0"')) {
        throw new Error('journey stage 1 completion not persisted: ' + JSON.stringify(saved));
      }
      await page.click('#btn-results-home');
      await page.waitForSelector('#screen-title:not([hidden])');
      await page.screenshot({ path: SHOT('home-after-win', vp.name) });
    });
    await step('daily board highlights the shortened guest display name', async () => {
      await page.route('**/api/v1/leaderboard/daily?*', route => route.fulfill({
        json: { entries: [
          { name: 'another-player', score: 200 },
          { name: 'guest-4294967295-4294967295'.slice(0, 24), score: 100 },
        ] },
      }));
      await page.click('#btn-play');
      await page.click('[data-mode="scores"]');
      await page.waitForSelector('.board-table tr.me');
      const highlighted = page.locator('.board-table tr.me');
      if (await highlighted.count() !== 1 || !(await highlighted.textContent()).includes('guest-')) {
        throw new Error('Daily board must highlight only the current guest');
      }
    });
  } finally {
    await context.close();
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const allErrors = [];
let server = null;
let browser = null;
try {
  const started = await startServer();
  server = started.server;
  console.log(`ok - static server on ephemeral port ${started.port}`);

  browser = await chromium.launch({
    executablePath: '/usr/bin/google-chrome',
    args: ['--no-sandbox', '--enable-unsafe-swiftshader'],
  });

  const passes = [
    { name: 'desktop', width: 1280, height: 800, port: started.port },
    { name: 'mobile', width: 390, height: 844, port: started.port },
  ];
  for (const vp of passes) {
    const errs = await runPass(browser, vp);
    allErrors.push(...errs.map((e) => `[${vp.name}] ${e}`));
    if (errs.length) {
      throw new Error(`page errors in ${vp.name} pass:\n` + errs.join('\n'));
    }
  }
} catch (e) {
  allErrors.push('fatal: ' + (e && e.stack || e));
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server) await new Promise((r) => server.close(r));
}

if (allErrors.length) {
  console.error('\nE2E FAIL:\n' + allErrors.join('\n'));
  process.exit(1);
}
console.log('\nE2E PASS — Discovery Merge played through the real UI on desktop + mobile, no page errors');
