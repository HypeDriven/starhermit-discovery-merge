// Platform adapter: a thin layer over window.StarHermit (starhermit-sdk.js,
// loaded as a classic script before the module graph). The SDK reads the
// launch token (#game_token= / #access_token=), strips it, renews it and makes
// the platform calls; this class keeps the game's API: profile nickname,
// cloud-save mirror of the checksummed save document at
// /api/v1/me/cloud-saves/game:<slug> (remote wins on boot; debounced saves
// with a pagehide flush), the settings KV, key bindings, sign-in and invite
// link. Signed in, the clock is synced from the game's own GET /api/v1/time;
// standalone (no launch token) the game makes no own-server requests at all
// and uses the local clock. The daily board is local (save.leaderboardLocal).

import { guestId, setCloudHook } from './persist.js';

const API_TIMEOUT = 4000;
const SAVE_DEBOUNCE_MS = 2000;
const PATCH_DEBOUNCE_MS = 400;
const sdk = () => (typeof window !== 'undefined' && window.StarHermit) || null;

function utcDateStr(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

export class Platform {
  constructor() {
    this.hosted = false;
    this.clockOffsetMs = 0;
    this.id = guestId();       // offline guest identity (local display name)
    this.profile = null;       // { name } for the signed-in player
    this.sync = 'offline';     // offline | saving | synced (cloud mirror)
    this._syncListeners = new Set();
    this._authListeners = new Set();
    this._started = false;
    this._patch = null;
    this._patchTimer = null;
    this._patchWaiters = [];
  }

  get launchToken() { return sdk()?.token || null; }
  get userId() { return sdk()?.userId || null; }
  get slug() { return sdk()?.slug || null; }

  get displayName() {
    return this.hosted && this.profile ? this.profile.name : this.id.replace('guest-', 'Guest ·');
  }

  async init() {
    const s = sdk();
    if (s && !this._started) {
      this._started = true;
      s.init();
      s.on('saved', (ok) => { if (this.hosted) this._setSync(ok ? 'synced' : 'offline'); });
      s.on('auth', (a) => {
        const was = this.hosted;
        this.hosted = !!(a && a.signedIn && s.slug);
        if (!this.hosted) { this.profile = null; this._setSync('offline'); this.clockOffsetMs = 0; }
        else if (!was) this.syncTime().catch(() => {});
        if (was !== this.hosted) for (const fn of this._authListeners) { try { fn(this.hosted); } catch { /* ok */ } }
      });
      setCloudHook((docJson) => this.writeCloudSave(docJson));
      try {
        window.addEventListener('pagehide', () => this._flushSave(true));
        document.addEventListener('visibilitychange', () => { if (document.hidden) this._flushSave(true); });
      } catch { /* no window events available */ }
    }
    this.hosted = !!(s && s.signedIn && s.slug);
    if (this.hosted) this.fetchProfile().catch(() => {});
    await this.syncTime();
  }

  onAuth(fn) { if (typeof fn === 'function') this._authListeners.add(fn); }
  canSignIn() { return !!sdk()?.canSignIn(); }
  signIn() { return !!sdk()?.signIn(); }
  inviteLink() { return this.hosted ? sdk()?.inviteLink() || null : null; }

  /* Identity: profile nickname (SDK: nickname, then "Player <id>"). */
  profileFor(userId) {
    const s = sdk();
    if (!s || !this.hosted || !userId) return Promise.resolve('player');
    return s.profile(String(userId)).then((p) => (p ? p.displayName : 'Player ' + String(userId).slice(0, 6)));
  }

  async fetchProfile() {
    if (!this.hosted) return null;
    const name = String(await this.profileFor(this.userId)).slice(0, 40);
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

  // Round-trip-adjusted server time (signed in only; standalone uses the
  // local clock). Daily boundaries key off this.
  async syncTime() {
    this.clockOffsetMs = 0;
    if (!this.hosted) return false;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), API_TIMEOUT);
    try {
      const t0 = Date.now();
      const headers = this.launchToken ? { Authorization: 'Bearer ' + this.launchToken } : {};
      const res = await fetch('/api/v1/time', { headers, signal: ctrl.signal });
      const body = res.ok ? await res.json().catch(() => null) : null;
      if (!body || typeof body.now !== 'number') return false;
      this.clockOffsetMs = body.now - Math.round((t0 + Date.now()) / 2);
      return true;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  now() { return new Date(Date.now() + this.clockOffsetMs); }
  todayUTC() { return utcDateStr(this.now()); }

  msUntilNextUTCDay() {
    const n = this.now();
    const next = new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate() + 1));
    return next.getTime() - n.getTime();
  }

  /* Cloud save through the SDK slot; returns the raw doc JSON or null. */
  async loadCloudSave() {
    const s = sdk();
    if (!s || !this.hosted) return null;
    try {
      const obj = await s.loadJSON();
      if (this.sync === 'offline') this._setSync('synced');
      return obj ? JSON.stringify(obj) : null;
    } catch {
      return null;
    }
  }

  writeCloudSave(docJson) {
    const s = sdk();
    if (!s || !this.hosted) return;
    try { s.saveJSON(JSON.parse(docJson), SAVE_DEBOUNCE_MS); } catch { return; }
    this._setSync('saving');
  }

  async _flushSave(keepalive) {
    const s = sdk();
    if (!s || !this.hosted) return false;
    return s.flushSave(keepalive === true);
  }

  /* Settings KV (player preferences), debounced merge. */
  getSettings() {
    const s = sdk();
    return s && this.hosted ? s.getSettings().catch(() => ({})) : Promise.resolve({});
  }
  patchSettings(obj) {
    const s = sdk();
    if (!s || !this.hosted) return Promise.resolve(null);
    this._patch = Object.assign(this._patch || {}, obj);
    if (this._patchTimer) clearTimeout(this._patchTimer);
    return new Promise((resolve) => {
      this._patchWaiters.push(resolve);
      this._patchTimer = setTimeout(() => {
        const body = this._patch, waiters = this._patchWaiters;
        this._patch = null; this._patchTimer = null; this._patchWaiters = [];
        const done = (v) => waiters.forEach((w) => w(v));
        s.patchSettings(body).then(done, () => done(null));
      }, PATCH_DEBOUNCE_MS);
    });
  }

  /* Key bindings (control.* lines in starhermit.txt). */
  loadBindings(defaults) {
    const copy = () => Object.fromEntries(Object.entries(defaults || {}).map(([k, v]) => [k, v.slice()]));
    const s = sdk();
    if (!s || !this.hosted) return Promise.resolve(copy());
    return s.loadBindings(defaults).catch(copy);
  }
}
