// Platform adapter: same-origin StarHermit-style /api routes when hosted,
// with graceful local fallbacks. Reads the launch token from the URL (never
// persisted), synchronizes clock with /api/v1/time, submits validated daily
// scores, and sends throttled presence heartbeats.

import { guestId } from './persist.js';

const API_TIMEOUT = 4000;

function utcDateStr(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

export class Platform {
  constructor() {
    const params = new URLSearchParams(location.search);
    this.launchToken = params.get('token') || null; // short-lived; not stored
    this.online = false;
    this.clockOffsetMs = 0;
    this.id = guestId();
    this._heartbeatTimer = null;
  }

  async init() {
    // Clean the token from the address bar after reading it.
    if (this.launchToken && history.replaceState) {
      history.replaceState(null, '', location.pathname);
    }
    await this.syncTime();
  }

  async _fetch(path, opts = {}) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), API_TIMEOUT);
    try {
      const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
      if (this.launchToken) headers['Authorization'] = 'Bearer ' + this.launchToken;
      headers['X-Player-Id'] = this.id;
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

  // Leaderboards -----------------------------------------------------------

  async submitDaily(entry) {
    // entry: { date, envelope, name }
    const r = await this._fetch('/api/v1/leaderboard/daily', {
      method: 'POST', body: JSON.stringify(entry),
    });
    if (r.ok) return { ...r.data, validated: true };
    return { ok: false, error: r.error, validated: false };
  }

  async fetchDailyBoard(date) {
    const r = await this._fetch('/api/v1/leaderboard/daily?date=' + encodeURIComponent(date));
    if (r.ok) return r.data.entries || [];
    return null; // caller falls back to the casual local board
  }

  // Presence (throttled heartbeat while actively playing) ------------------

  startPresence() {
    if (this._heartbeatTimer) return;
    const beat = () => this._fetch('/api/v1/presence', { method: 'POST', body: '{}' });
    beat();
    this._heartbeatTimer = setInterval(beat, 45000);
  }

  stopPresence() {
    if (this._heartbeatTimer) clearInterval(this._heartbeatTimer);
    this._heartbeatTimer = null;
  }

  // Activity pairing for accurate playtime ---------------------------------

  activityStart(levelId) {
    this._fetch('/api/v1/activity/start', { method: 'POST', body: JSON.stringify({ levelId }) });
  }

  activityEnd(levelId, result) {
    this._fetch('/api/v1/activity/end', { method: 'POST', body: JSON.stringify({ levelId, result }) });
  }

  // Anonymous funnel events (aggregate only, no text/pointer data).
  track(event, props = {}) {
    const allowed = ['start', 'tutorial-step', 'round-end', 'retry', 'settings-change', 'error'];
    if (!allowed.includes(event)) return;
    this._fetch('/api/v1/telemetry', {
      method: 'POST',
      body: JSON.stringify({ event, props: { mode: props.mode, level: props.level } }),
    });
  }
}
