// Discovery Merge — StarHermit adapter unit tests (node --test).
// Loads starhermit-sdk.js (classic script) and the src/platform.js module
// against a stubbed window, fetch and launch hash.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SDK_SRC = readFileSync(new URL('../starhermit-sdk.js', import.meta.url), 'utf8');
const SLUG = 'discovery-merge';
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const JWT = `${b64u({ alg: 'none' })}.${b64u({ sub: 'u-12345678', game_scope: SLUG, exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;
// Clear the SDK's renewal timer so the test process can exit.
test.afterEach(() => { globalThis.StarHermit?.signOut(); });

async function boot(hash) {
  const calls = [];
  const store = { save: null, settings: {} };
  globalThis.fetch = async (url, init = {}) => {
    const method = init.method || 'GET';
    calls.push({ url, method, init });
    const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (url.endsWith('/api/v1/users/u-12345678/profile')) return json({ nickname: 'Pip' });
    if (url.includes('/api/v1/me/cloud-saves/')) {
      if (method === 'PUT') { store.save = Buffer.from(JSON.parse(init.body).dataBase64, 'base64'); return new Response(null, { status: 204 }); }
      return store.save ? new Response(store.save, { status: 200 }) : new Response('', { status: 404 });
    }
    if (url.endsWith(`/api/v1/games/${SLUG}/settings`)) {
      if (method === 'PATCH') Object.assign(store.settings, JSON.parse(init.body).settings);
      return json({ settings: store.settings });
    }
    if (url.endsWith(`/api/v1/games/${SLUG}/controls`)) return json({ actions: [{ action: 'hint', codes: ['F2'] }] });
    if (url === '/api/v1/time') return json({ now: Date.now() });
    return new Response('', { status: 404 });
  };
  const location = { hash, search: '', pathname: '/', hostname: 'localhost', href: 'http://localhost/' + hash, origin: 'http://localhost' };
  globalThis.window = {
    location,
    history: { state: null, replaceState(_s, _t, url) { const i = url.indexOf('#'); location.hash = i >= 0 ? url.slice(i) : ''; } },
    addEventListener() {},
  };
  globalThis.document = { hidden: false, addEventListener() {} };
  globalThis.localStorage = { getItem() { return 'guest-1'; }, setItem() {} };
  vm.runInThisContext(SDK_SRC);               // defines globalThis.StarHermit
  window.StarHermit = globalThis.StarHermit;
  const { Platform } = await import('../src/platform.js');
  return { P: new Platform(), calls, store };
}

test('launch token: read from the fragment, stripped, slug from claims', async () => {
  const { P } = await boot('#game_token=' + JWT + '&session_id=s1');
  await P.init();
  assert.equal(P.hosted, true);
  assert.equal(P.slug, SLUG);
  assert.equal(P.userId, 'u-12345678');
  assert.equal(window.location.hash, '');
  assert.equal(P.launchToken, JWT);
});

test('profile name comes from the profile nickname', async () => {
  const { P } = await boot('#game_token=' + JWT);
  await P.init();
  assert.deepEqual(await P.fetchProfile(), { name: 'Pip' });
  assert.equal(P.displayName, 'Pip');
});

test('cloud save round-trips through /api/v1/me/cloud-saves/game:<slug>', async () => {
  const { P, calls } = await boot('#game_token=' + JWT);
  await P.init();
  const doc = JSON.stringify({ v: 1, sum: 'x', settings: {} });
  P.writeCloudSave(doc);
  assert.equal(P.sync, 'saving');
  assert.equal(await P._flushSave(true), true);
  const put = calls.find((c) => c.method === 'PUT');
  assert.ok(put.url.endsWith('/api/v1/me/cloud-saves/' + encodeURIComponent('game:' + SLUG)), put.url);
  assert.equal(put.init.keepalive, true);
  assert.equal(P.sync, 'synced');
  assert.equal(await P.loadCloudSave(), doc);
});

test('settings patch, bindings, invite link and own-server time', async () => {
  const { P, calls, store } = await boot('#game_token=' + JWT);
  await P.init();
  const time = calls.find((c) => c.url === '/api/v1/time');
  assert.equal(time.init.headers.Authorization, 'Bearer ' + JWT);
  await Promise.all([P.patchSettings({ music: 0.2 }), P.patchSettings({ muted: true })]);
  assert.deepEqual(store.settings, { music: 0.2, muted: true });
  assert.equal(calls.filter((c) => c.method === 'PATCH').length, 1, 'patches are debounced into one');
  assert.deepEqual(await P.loadBindings({ hint: ['KeyH'], undo: ['KeyU'] }), { hint: ['F2'], undo: ['KeyU'] });
  assert.match(P.inviteLink(), /game-invite\/u-12345678\/discovery-merge$/);
});

test('standalone: no StarHermit calls without a token', async () => {
  const { P, calls } = await boot('');
  await P.init();
  assert.equal(P.hosted, false);
  assert.equal(P.canSignIn(), false);
  assert.equal(P.inviteLink(), null);
  assert.equal(await P.fetchProfile(), null);
  assert.equal(await P.loadCloudSave(), null);
  P.writeCloudSave('{"v":1}');
  await P._flushSave(true);
  await P.patchSettings({ a: 1 });
  assert.deepEqual(await P.getSettings(), {});
  assert.deepEqual(await P.loadBindings({ hint: ['KeyH'] }), { hint: ['KeyH'] });
  // no own-server calls either: standalone uses the local clock
  assert.deepEqual(calls.map((c) => c.url), []);
  assert.equal(P.clockOffsetMs, 0);
});
