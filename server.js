// Discovery Merge — authoritative server script (declared as server=server.js
// in starhermit.txt). Zero dependencies; Node >= 18. Serves the static
// distribution and the same-origin /api routes the client degrades from:
//
//   GET  /api/v1/time                 platform clock (daily boundary sync)
//   GET  /api/v1/leaderboard/daily    daily board (?date=YYYY-MM-DD)
//   POST /api/v1/leaderboard/daily    submit {date, envelope, name} — the
//                                     envelope's command log is re-simulated
//                                     through the real rules engine; the
//                                     claimed score must match exactly
//   POST /api/v1/presence             throttled heartbeat (ack only)
//   POST /api/v1/activity/start|end   playtime pairing (ack only)
//   POST /api/v1/telemetry            anonymous funnel events (ack only)
//
// No secrets are exposed to the client; board data lives in data/.

import http from 'node:http';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

import { replay, totalScore, RULES_VERSION } from './src/engine/rules.js';
import { dailyLevel, CONTENT_VERSION } from './src/content.js';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PORT = process.env.PORT || 8080;
const DATA_DIR = join(ROOT, 'data');
const BOARD_FILE = join(DATA_DIR, 'leaderboard.json');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

// --- daily board persistence ------------------------------------------------

let boards = {};
async function loadBoards() {
  try { boards = JSON.parse(await readFile(BOARD_FILE, 'utf8')); }
  catch { boards = {}; }
}
let saveQueued = false;
function persistBoards() {
  if (saveQueued) return;
  saveQueued = true;
  setTimeout(async () => {
    saveQueued = false;
    await mkdir(DATA_DIR, { recursive: true }).catch(() => {});
    await writeFile(BOARD_FILE, JSON.stringify(boards)).catch(() => {});
  }, 250);
}

// Tie-break order per spec: primary objective completion (already gated to
// wins), then fewer invalid actions, lower authoritative elapsed time, then
// stable session identifier.
function rankEntries(list) {
  return [...list].sort((a, b) =>
    b.score - a.score ||
    a.invalidActions - b.invalidActions ||
    a.seconds - b.seconds ||
    String(a.id).localeCompare(String(b.id)));
}

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(data);
}

function readBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('payload-too-large')); req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function handleApi(req, res, url) {
  const route = url.pathname;

  if (route === '/api/v1/time' && req.method === 'GET') {
    return json(res, 200, { now: Date.now() });
  }

  if (route === '/api/v1/presence' && req.method === 'POST') {
    return json(res, 200, { ok: true });
  }

  if ((route === '/api/v1/activity/start' || route === '/api/v1/activity/end') && req.method === 'POST') {
    await readBody(req).catch(() => {});
    return json(res, 200, { ok: true });
  }

  if (route === '/api/v1/telemetry' && req.method === 'POST') {
    // Aggregate-only funnel events; nothing is persisted per-user.
    await readBody(req).catch(() => {});
    return json(res, 200, { ok: true });
  }

  if (route === '/api/v1/leaderboard/daily' && req.method === 'GET') {
    const date = url.searchParams.get('date') || '';
    const entries = rankEntries(boards[date] || []).map((e, i) => ({
      rank: i + 1, name: e.name, score: e.score, moves: e.moves,
      seconds: e.seconds, invalidActions: e.invalidActions, validated: true,
    }));
    return json(res, 200, { date, entries });
  }

  if (route === '/api/v1/leaderboard/daily' && req.method === 'POST') {
    let body;
    try { body = JSON.parse(await readBody(req)); }
    catch { return json(res, 400, { error: 'bad-json' }); }

    const { date, envelope, name } = body || {};
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return json(res, 400, { error: 'bad-date' });
    if (!envelope || typeof name !== 'string' || !name) return json(res, 400, { error: 'bad-envelope' });

    // Reject stale-version or oversized claims up front.
    if (envelope.rulesVersion !== RULES_VERSION || envelope.contentVersion !== CONTENT_VERSION) {
      return json(res, 400, { error: 'stale-version' });
    }
    if (!Array.isArray(envelope.commands) || envelope.commands.length > 20000) {
      return json(res, 400, { error: 'bad-commands' });
    }

    // Authoritative validation: re-simulate the submitted input log against
    // the immutable daily content and require an exact score + hash match.
    const level = dailyLevel(date);
    if (envelope.seed !== level.seed) return json(res, 400, { error: 'seed-mismatch' });
    const { state, finalHash } = replay(level, envelope.commands);
    if (state.status !== 'won') return json(res, 400, { error: 'not-a-win' });
    const claimed = envelope.result || {};
    if (claimed.total !== totalScore(state) || finalHash !== envelope.hashes?.[envelope.hashes.length - 1]) {
      return json(res, 400, { error: 'score-mismatch' });
    }

    const playerId = req.headers['x-player-id'] || name;
    const entry = {
      id: String(playerId), name: String(name).slice(0, 24),
      score: totalScore(state), moves: state.movesUsed,
      invalidActions: state.stats.invalid,
      seconds: Math.max(0, Math.min(86400, claimed.elapsedSeconds | 0)),
      at: Date.now(),
    };
    boards[date] = boards[date] || [];
    const existing = boards[date].findIndex((e) => e.id === entry.id);
    if (existing >= 0) {
      if (rankEntries([entry, boards[date][existing]])[0] === entry) boards[date][existing] = entry;
    } else {
      boards[date].push(entry);
    }
    persistBoards();
    const ranked = rankEntries(boards[date]);
    return json(res, 200, { ok: true, rank: ranked.findIndex((e) => e.id === entry.id) + 1, entries: ranked.length });
  }

  return json(res, 404, { error: 'not-found' });
}

// --- static files -------------------------------------------------------------

const STATIC_CACHE = { '.js': 'public, max-age=3600', '.css': 'public, max-age=3600' };

function serveStatic(req, res, url) {
  let path = decodeURIComponent(url.pathname);
  if (path === '/') path = '/index.html';
  const filePath = normalize(join(ROOT, path));
  if (!filePath.startsWith(ROOT)) { res.writeHead(403); return res.end('forbidden'); }
  // Keep source-adjacent sensitive/design paths out of the distribution surface.
  if (filePath.includes('/data/') || filePath.endsWith('/server.js') || filePath.endsWith('/spec.md')) {
    res.writeHead(404); return res.end('not found');
  }
  stat(filePath)
    .then((st) => {
      if (!st.isFile()) { res.writeHead(404); return res.end('not found'); }
      const ext = extname(filePath);
      const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream' };
      headers['Cache-Control'] = STATIC_CACHE[ext] || 'no-cache';
      headers['Content-Length'] = st.size;
      res.writeHead(200, headers);
      createReadStream(filePath).on('error', () => res.destroy()).pipe(res);
    })
    .catch(() => { res.writeHead(404); res.end('not found'); });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    return serveStatic(req, res, url);
  } catch (e) {
    return json(res, 500, { error: 'internal' });
  }
});

await loadBoards();
server.listen(PORT, () => {
  console.log(`Discovery Merge listening on http://localhost:${PORT}`);
});
