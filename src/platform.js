// Platform adapter: same-origin StarHermit-style /api routes when hosted,
// with graceful local fallbacks. Reads the launch token from the URL fragment
// (never persisted), synchronizes clock with /api/v1/time, submits validated
// daily scores, mirrors the save document to the cloud slot, and resolves
// profile nicknames. The own-server presence/activity/telemetry sinks are
// local-dev only — no launch-token endpoints exist for them (wiki).
//
// Hosted contract: the platform opens the game as index.html#game_token=<jwt>
// (optional &session_id=), stripped after the read. The JWT carries sub =
// user id and game_scope = this game's slug — never hard-coded. Every call
// sends Authorization: Bearer; the token re-mints every 45 min via
// POST /api/v1/games/{slug}/launch-token.

import { guestId, setCloudHook } from './persist.js';

const API_TIMEOUT = 4000;
const REFRESH_MS = 45 * 60 * 1000; // token lives 60 min; re-mint at 45
const RETRY_MS = 60 * 1000;
const SAVE_DEBOUNCE_MS = 2000;

// Minimal ZIP writer/reader (stored entries only, no compression).
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function zipStore(name, dataBytes) {
  const enc = new TextEncoder();
  const nameB = enc.encode(name);
  const crc = crc32(dataBytes);
  const out = [];
  const u16 = (v) => out.push(v & 0xff, (v >> 8) & 0xff);
  const u32 = (v) => out.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
  u32(0x04034b50); u16(20); u16(0); u16(0); u16(0); u16(0);
  u32(crc); u32(dataBytes.length); u32(dataBytes.length);
  u16(nameB.length); u16(0);
  const head = new Uint8Array(out);
  const cd = [];
  const c16 = (v) => cd.push(v & 0xff, (v >> 8) & 0xff);
  const c32 = (v) => cd.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
  c32(0x02014b50); c16(20); c16(20); c16(0); c16(0); c16(0); c16(0);
  c32(crc); c32(dataBytes.length); c32(dataBytes.length);
  c16(nameB.length); c16(0); c16(0); c16(0); c16(0); c32(0); c32(0);
  const cdHead = new Uint8Array(cd);
  const cdOff = head.length + nameB.length + dataBytes.length;
  const parts = [head, nameB, dataBytes, cdHead, nameB];
  const eocd = [];
  const e32 = (v) => eocd.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
  const e16 = (v) => eocd.push(v & 0xff, (v >> 8) & 0xff);
  e32(0x06054b50); e16(0); e16(0); e16(1); e16(1);
  e32(cdHead.length + nameB.length); e32(cdOff); e16(0);
  parts.push(new Uint8Array(eocd));
  const total = parts.reduce((n, p) => n + p.length, 0);
  const buf = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { buf.set(p, o); o += p.length; }
  return buf;
}
function unzipFirstEntry(zipBytes) {
  const dv = new DataView(zipBytes.buffer, zipBytes.byteOffset, zipBytes.byteLength);
  let off = 0;
  while (off + 30 <= zipBytes.length && dv.getUint32(off, true) === 0x04034b50) {
    const method = dv.getUint16(off + 8, true);
    const size = dv.getUint32(off + 18, true);
    const nameLen = dv.getUint16(off + 26, true);
    const extraLen = dv.getUint16(off + 28, true);
    const dataOff = off + 30 + nameLen + extraLen;
    if (method !== 0) throw new Error('unsupported zip entry');
    return zipBytes.slice(dataOff, dataOff + size);
  }
  throw new Error('bad zip');
}
function bytesToBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function utcDateStr(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

export class Platform {
  constructor() {
    this.launchToken = null;   // short-lived; not stored
    this.userId = null;        // JWT sub
    this.slug = null;          // JWT game_scope — never hard-coded
    this.hosted = false;
    this.online = false;
    this.clockOffsetMs = 0;
    this.id = guestId();       // offline guest identity (its-backend key)
    this.profile = null;       // { name } for the signed-in player
    this.sync = 'offline';     // offline | saving | synced (cloud mirror)
    this._heartbeatTimer = null;
    this._refreshTimer = null;
    this._retryTimer = null;
    this._saveTimer = null;
    this._pendingSave = null;
    this._profileNames = {};
    this._syncListeners = new Set();
  }

  get displayName() {
    return this.hosted && this.profile ? this.profile.name : this.id.replace('guest-', 'Guest ·');
  }

  async init() {
    this.launchToken = this._readLaunchToken();
    if (this.launchToken) {
      const claims = this._decodeJwt(this.launchToken);
      if (!claims) this.launchToken = null;
      else {
        if (typeof claims.sub === 'string' && claims.sub) this.userId = claims.sub;
        if (typeof claims.game_scope === 'string' && claims.game_scope) this.slug = claims.game_scope;
        if (!this.userId || !this.slug) this.launchToken = null; // unusable token
      }
    }
    this.hosted = !!this.launchToken;
    if (this.hosted) {
      this._refreshTimer = setInterval(() => this._refreshToken(), REFRESH_MS);
      setCloudHook((docJson) => this.writeCloudSave(docJson));
      try {
        window.addEventListener('pagehide', () => this._flushSave());
        document.addEventListener('visibilitychange', () => { if (document.hidden) this._flushSave(); });
      } catch { /* no window events available */ }
      this.fetchProfile().catch(() => {});
    }
    await this.syncTime();
  }

  // Fragment first (platform contract); query forms are local-dev only.
  _readLaunchToken() {
    try {
      const h = new URLSearchParams(String(location.hash || '').replace(/^#/, ''));
      const t = h.get('game_token');
      if (t) {
        h.delete('game_token');
        h.delete('session_id');
        const rest = h.toString();
        history.replaceState(null, '', location.pathname + location.search + (rest ? '#' + rest : ''));
        return t;
      }
      const q = new URLSearchParams(location.search);
      return q.get('game_token') || q.get('token') || q.get('launch_token') || null;
    } catch {
      return null;
    }
  }

  _decodeJwt(token) {
    try {
      const seg = String(token).split('.')[1];
      if (!seg) return null;
      let b64 = seg.replace(/-/g, '+').replace(/_/g, '/');
      b64 += '='.repeat((4 - (b64.length % 4)) % 4);
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      return null;
    }
  }

  async _refreshToken() {
    if (!this.launchToken || !this.slug) return false;
    try {
      const res = await fetch(`/api/v1/games/${encodeURIComponent(this.slug)}/launch-token`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + this.launchToken }, body: '{}',
      });
      const data = await res.json().catch(() => null);
      if (res.ok && data && typeof data.token === 'string' && data.token) {
        this.launchToken = data.token; // memory only
        const claims = this._decodeJwt(this.launchToken);
        if (claims && claims.sub) this.userId = claims.sub;
        if (claims && claims.game_scope) this.slug = claims.game_scope;
        return true;
      }
    } catch { /* fall through to retry */ }
    if (!this._retryTimer) {
      this._retryTimer = setTimeout(() => { this._retryTimer = null; this._refreshToken(); }, RETRY_MS);
    }
    return false;
  }

  /* Identity: the profile nickname is the only profile read a game-scoped
   * token may make. Never /api/v1/me, never usernames. */
  profileFor(userId) {
    if (!userId || typeof userId !== 'string') return Promise.resolve('player');
    if (this._profileNames[userId]) return this._profileNames[userId];
    const p = fetch(`/api/v1/users/${encodeURIComponent(userId)}/profile`, {
      headers: this.launchToken ? { Authorization: 'Bearer ' + this.launchToken } : {},
    }).then((r) => (r.ok ? r.json() : null))
      .then((j) => (j && typeof j.nickname === 'string' && j.nickname ? j.nickname : null))
      .then((n) => n || ('Player ' + userId.slice(0, 8)))
      .catch(() => 'Player ' + userId.slice(0, 8));
    this._profileNames[userId] = p;
    return p;
  }

  async fetchProfile() {
    if (!this.userId) return null;
    const name = (await this.profileFor(this.userId)).slice(0, 40);
    this.profile = { name };
    return this.profile;
  }

  onSync(fn) { if (typeof fn === 'function') this._syncListeners.add(fn); }
  _setSync(state) {
    if (this.sync === state) return;
    this.sync = state;
    for (const fn of this._syncListeners) {
      try { fn(state); } catch { /* listener errors never break the adapter */ }
    }
  }

  async _fetch(path, opts = {}) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), API_TIMEOUT);
    try {
      const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
      if (this.launchToken) headers['Authorization'] = 'Bearer ' + this.launchToken;
      headers['X-Player-Id'] = this.userId || this.id;
      const res = await fetch(path, { ...opts, headers, signal: ctrl.signal });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        const err = (body && body.error) || `http-${res.status}`;
        return { ok: false, error: err, status: res.status };
      }
      return { ok: true, data: body };
    } catch (e) {
      return { ok: false, error: 'offline', status: 0 };
    } finally {
      clearTimeout(t);
    }
  }

  // Round-trip-adjusted server time; daily boundaries key off this.
  async syncTime() {
    const t0 = Date.now();
    const r = await this._fetch('/api/v1/time');
    if (r.ok && typeof r.data.now === 'number') {
      const t1 = Date.now();
      this.clockOffsetMs = r.data.now - Math.round((t0 + t1) / 2);
      this.online = true;
    } else {
      this.online = false;
      this.clockOffsetMs = 0;
    }
    return this.online;
  }

  now() { return new Date(Date.now() + this.clockOffsetMs); }
  todayUTC() { return utcDateStr(this.now()); }

  msUntilNextUTCDay() {
    const n = this.now();
    const next = new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate() + 1));
    return next.getTime() - n.getTime();
  }

  /* Cloud save: ONE zip+base64 slot at /api/v1/me/cloud-saves/{slug} holding
   * the checksummed save document. Remote wins on boot (validated by the
   * caller through parseSave); saves debounce ~2 s and flush on pagehide/
   * hidden with keepalive; localStorage stays the offline cache. */
  async loadCloudSave() {
    if (!this.hosted || !this.slug) return null;
    try {
      const res = await fetch(`/api/v1/me/cloud-saves/${encodeURIComponent(this.slug)}`, {
        headers: this.launchToken ? { Authorization: 'Bearer ' + this.launchToken } : {},
      });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`http-${res.status}`);
      const buf = await res.arrayBuffer();
      if (!buf || !buf.byteLength) return null;
      return new TextDecoder().decode(unzipFirstEntry(new Uint8Array(buf)));
    } catch {
      return null;
    }
  }

  writeCloudSave(docJson) {
    if (!this.hosted || !this.slug) return;
    this._pendingSave = docJson;
    this._setSync('saving');
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this._flushSave(), SAVE_DEBOUNCE_MS);
  }

  async _flushSave() {
    if (this._saveTimer) { clearTimeout(this._saveTimer); this._saveTimer = null; }
    if (!this.hosted || !this.slug || this._pendingSave == null) return false;
    const docJson = this._pendingSave;
    this._pendingSave = null;
    let body;
    try {
      body = { dataBase64: bytesToBase64(zipStore('save.json', new TextEncoder().encode(docJson))) };
    } catch {
      return false;
    }
    try {
      const res = await fetch(`/api/v1/me/cloud-saves/${encodeURIComponent(this.slug)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + this.launchToken },
        body: JSON.stringify(body),
        keepalive: true,
      });
      if (res.ok) { this._setSync('synced'); return true; }
      this._pendingSave = this._pendingSave == null ? docJson : this._pendingSave;
      this._setSync('offline');
      return false;
    } catch {
      this._pendingSave = this._pendingSave == null ? docJson : this._pendingSave;
      this._setSync('offline');
      return false;
    }
  }

  // Leaderboards (own-server validated routes; authenticated its-backend) ---

  async submitDaily(entry) {
    // entry: { date, envelope, name }
    const payload = {
      ...entry,
      name: this.hosted && this.profile ? this.profile.name : entry.name,
      playerId: this.hosted ? this.userId : undefined,
    };
    const r = await this._fetch('/api/v1/leaderboard/daily', {
      method: 'POST', body: JSON.stringify(payload),
    });
    if (r.ok) return { ...r.data, validated: true };
    return { ok: false, error: r.error, validated: false };
  }

  async fetchDailyBoard(date) {
    const r = await this._fetch('/api/v1/leaderboard/daily?date=' + encodeURIComponent(date));
    if (r.ok) return r.data.entries || [];
    return null; // caller falls back to the casual local board
  }

  /* Presence / activity / telemetry: own-server sinks exist for local dev,
   * but no launch-token endpoints do (wiki) — hosted mode stays silent. */

  startPresence() {
    if (this.hosted) return; // no hosted presence endpoint
    if (this._heartbeatTimer) return;
    const beat = () => this._fetch('/api/v1/presence', { method: 'POST', body: '{}' });
    beat();
    this._heartbeatTimer = setInterval(beat, 45000);
  }

  stopPresence() {
    if (this._heartbeatTimer) clearInterval(this._heartbeatTimer);
    this._heartbeatTimer = null;
  }

  activityStart(levelId) {
    if (this.hosted) return;
    this._fetch('/api/v1/activity/start', { method: 'POST', body: JSON.stringify({ levelId }) });
  }

  activityEnd(levelId, result) {
    if (this.hosted) return;
    this._fetch('/api/v1/activity/end', { method: 'POST', body: JSON.stringify({ levelId, result }) });
  }

  track(event, props = {}) {
    if (this.hosted) return;
    const allowed = ['start', 'tutorial-step', 'round-end', 'retry', 'settings-change', 'error'];
    if (!allowed.includes(event)) return;
    this._fetch('/api/v1/telemetry', {
      method: 'POST',
      body: JSON.stringify({ event, props: { mode: props.mode, level: props.level } }),
    });
  }
}
