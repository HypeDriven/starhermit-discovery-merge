// The game's data and the StarHermit platform, on the runtime's modules:
// - the save is src/persist.js's checksummed document (journey bests,
//   dailies and streak days, the codex, achievements, lifetime stats, the
//   device's daily board), unchanged: it is the game's save
//   (starhermit:storage `saves`) on the device and in the player's cloud
//   slot, two devices' copies merged on a conflict (persist.js mergeSaves:
//   progress only grows). The slot the browser build wrote (the JS SDK's
//   saveJSON of the same document, key game:<slug>) shows as foreign and is
//   merged in and replaced once;
// - src/persist.js keeps reading and writing `localStorage`: here a shim
//   whose save key is that document and whose other keys (the paused board's
//   snapshot, the guest id) are the device's starhermit:storage, as the
//   browser build kept them on the device;
// - the game's own options (2D board, camera tilt, colour-vision palette,
//   left-handed layout, haptics, hints) are `settings` (game.<key>, synced
//   with the account); the browser build's account settings (its save
//   settings mirrored key by key, ui.language, the options panel's
//   audio.options and graphics.gpu.* slots) are migrated, then the old keys
//   removed. Volumes, mute, graphics, language, reduced motion, high contrast
//   and text size are the runtime's Options;
// - the player (signed in or a guest), the invite link, the platform's clock
//   for the daily, and posting a finished ranked round to score-script.js,
//   which replays its command log through the rules and posts the score it
//   computes itself (the server decides the score; the client only sends what
//   was played), with the rank on the high-score board.
import type { JsonValue } from "starhermit:engine";
import {
  connectGame, inviteLink as fetchInviteLink, leaderboards, onPlayerChange, player, serverNow, serverTime, sessions,
  type Leaderboard,
} from "starhermit:platform";
import { saves, settings as store, storage } from "starhermit:storage";
import { hashState } from "../src/engine/rng.js";
import { DEFAULT_SETTINGS, SAVE_VERSION, mergeSaves, parseSave } from "../src/persist.js";

export type SaveDoc = ReturnType<typeof parseSave> & object;
const SAVE_KEY = "discovery-merge.save.v1";

// --- the save and the localStorage shim ----------------------------------------------
let current: Record<string, unknown> | null = null; // the sealed document as saved
let lastSavedAt = 0;
let adoptHook: ((doc: SaveDoc) => void) | null = null;
/** fn(doc) when the account's copy (another device, the browser build) was merged in: the game adopts it. */
export function onAdopt(fn: (doc: SaveDoc) => void): void { adoptHook = fn; }

function persist(): void {
  if (!current) return;
  try { saves.save(current as unknown as JsonValue, { schema: 1 }); }
  catch (e) { console.warn(`save: ${String(e)}`); }
}
const shim = {
  getItem(key: string): string | null {
    if (key === SAVE_KEY) return current ? JSON.stringify(current) : null;
    try { return storage.getText(key); } catch { return null; }
  },
  setItem(key: string, value: string): void {
    if (key === SAVE_KEY) {
      try { current = JSON.parse(value) as Record<string, unknown>; } catch { return; }
      persist();
      return;
    }
    try { storage.set(key, String(value)); } catch (e) { console.warn(`storage ${key}: ${String(e)}`); }
  },
  removeItem(key: string): void {
    if (key === SAVE_KEY) { current = null; return; }
    try { storage.remove(key); } catch { /* gone */ }
  },
  clear(): void { current = null; },
};
(globalThis as unknown as { localStorage: typeof shim }).localStorage = shim;

/** persist.js storeSave's checksum over a document body. */
export function seal(doc: object): Record<string, unknown> {
  const { checksum: _c, ...rest } = doc as Record<string, unknown>;
  const body = { ...rest, version: SAVE_VERSION };
  return { ...body, checksum: hashState(body) };
}
/** Merges another copy into the device's (and saves); whether anything changed. */
function adopt(other: unknown): boolean {
  const remote = parseSave(other as string);
  if (!remote) return false;
  const local = current ? parseSave(current as unknown as string) : null;
  const next = seal(mergeSaves(remote, local));
  if (current && JSON.stringify(next) === JSON.stringify(seal(current))) return false;
  current = next;
  persist();
  adoptHook?.(parseSave(next as unknown as string)!);
  return true;
}

saves.onConflict((local, remote) => {
  const a = parseSave(remote.data as unknown as string), b = parseSave((local?.data ?? null) as unknown as string);
  return { merged: seal(mergeSaves(a, b)) as unknown as JsonValue };
});
saves.onStatus((_status, state) => {
  if (state === "foreign") { migrateForeign(); return; }
  // The account's save replaced the device's (another device saved last): merge it in.
  const cur = saves.load();
  if (cur && cur.savedAt !== lastSavedAt) {
    lastSavedAt = cur.savedAt;
    adopt(cur.data);
  }
});

/** The browser build's cloud save: merged with this device's progress, saved over it once. */
function migrateForeign(): void {
  const old = saves.foreign();
  if (!old) return;
  let doc: unknown = null;
  try { doc = old.text ? JSON.parse(old.text) : null; } catch { doc = null; }
  adopt(doc);
  if (!current) return;
  try { saves.save(current as unknown as JsonValue, { schema: 1, replaceForeign: true }); }
  catch (e) { console.warn(`save migration: ${String(e)}`); }
}

/** For the top bar: offline (a guest) | saving | synced | error. */
export function syncState(): "offline" | "saving" | "synced" | "error" {
  if (!player()) return "offline";
  const st = saves.state();
  if (st === "error" || st === "read-blocked") return "error";
  if (st === "loading" || st === "uploading" || st === "foreign" || saves.status() === "pending") return "saving";
  return "synced";
}
export function flush(): void { void saves.flush().catch(() => undefined); }
/** Settings › Erase local progress: the save starts over (the device's and the account's copy). */
export function eraseSave(): void { current = null; }

// --- the game's options ---------------------------------------------------------------
export interface Options { domBoard: boolean; cameraTilt: string; colorBlind: boolean; leftHanded: boolean; haptics: boolean; hintsEnabled: boolean }
export const options: Options = {
  domBoard: DEFAULT_SETTINGS.domBoard, cameraTilt: DEFAULT_SETTINGS.cameraTilt, colorBlind: DEFAULT_SETTINGS.colorBlind,
  leftHanded: DEFAULT_SETTINGS.leftHanded, haptics: DEFAULT_SETTINGS.haptics, hintsEnabled: DEFAULT_SETTINGS.hintsEnabled,
};
type Key = keyof Options;
const KEYS = Object.keys(options) as Key[];
const optionListeners = new Set<() => void>();
export function onOptionsChange(fn: () => void): void { optionListeners.add(fn); }
function optionsChanged(): void { for (const fn of optionListeners) fn(); }
function check(key: Key, v: unknown): boolean | string | undefined {
  if (key === "cameraTilt") return v === "default" || v === "top" ? v : undefined;
  return typeof v === "boolean" ? v : undefined;
}
function readOption(key: Key): boolean {
  let v: JsonValue | undefined;
  try { v = store.get(key); } catch { return false; }
  const ok = check(key, v);
  if (ok === undefined) return false;
  (options as unknown as Record<string, unknown>)[key] = ok;
  return true;
}
/** A migrated value, kept unless this game set the key since. */
function adoptOption(key: Key, value: unknown): void {
  const v = check(key, value);
  if (v === undefined) return;
  try {
    if (store.get(key) !== undefined) return;
    store.set(key, v);
    (options as unknown as Record<string, unknown>)[key] = v;
    optionsChanged();
  } catch { /* keep the device's */ }
}
/** Changes one of the game's options (device and account). */
export function setOption<K extends Key>(key: K, value: Options[K]): void {
  if (options[key] === value) return;
  options[key] = value;
  try { store.set(key, value as JsonValue); } catch (e) { console.warn(`option ${key}: ${String(e)}`); }
  optionsChanged();
}
// The browser build's account settings: its save settings mirrored key by key
// (main.js pushSettings), the language helper's ui.language and the options
// panel's audio.options / graphics.gpu.<profile> slots.
export const BROWSER_KEYS = [...Object.keys(DEFAULT_SETTINGS), "graphics", "quality", "ui.language", "audio.options"];
const isBrowserKey = (k: string): boolean => BROWSER_KEYS.includes(k) || k.startsWith("graphics.gpu.");
function importLegacy(): void {
  const keys = store.legacyKeys();
  if (!keys) return;
  for (const key of keys) if ((KEYS as string[]).includes(key)) adoptOption(key as Key, store.legacy(key));
  for (const key of keys) if (isBrowserKey(key)) store.removeLegacy(key);
}

/** Reads the device's save and the game's options (from onStart, before persist.js loadSave). */
export function initPlatform(): void {
  const cur = saves.load();
  lastSavedAt = cur?.savedAt ?? 0;
  current = cur?.data && typeof cur.data === "object" ? cur.data as Record<string, unknown> : null;
  const unset = KEYS.filter((k) => !readOption(k));
  // Options never set on the engine: the save document's settings carry them (the browser build kept them there).
  const docSettings = (current?.settings ?? null) as Record<string, unknown> | null;
  if (docSettings) for (const k of unset) adoptOption(k, docSettings[k]);
  store.onChange((key) => {
    if (!(KEYS as string[]).includes(key)) return;
    readOption(key as Key);
    optionsChanged();
  });
  store.onLegacy(importLegacy);
  importLegacy();
  if (saves.state() === "foreign") migrateForeign();
  optionsChanged();
  refreshPlayer();
  void serverTime().catch(() => undefined);
}

// --- the player and the clock ----------------------------------------------------------
export function signedIn(): boolean { return !!player(); }
export function displayName(): string { return player()?.displayName ?? ""; }
let invite: string | null = null;
/** The invite link, fetched ahead so a button press can copy it at once. */
export function inviteLink(): string | null { return player() ? invite : null; }
function refreshPlayer(): void {
  invite = null;
  board = null;
  if (!player()) return;
  fetchInviteLink().then((u) => { invite = u; }, () => { invite = null; });
}
const playerListeners = new Set<() => void>();
export function onPlayer(fn: () => void): void { playerListeners.add(fn); }
onPlayerChange(() => { refreshPlayer(); for (const fn of playerListeners) fn(); });

/** Now in ms by the platform's clock when it has answered, else the device's. */
export function nowMs(): number {
  try { return serverNow() ?? Date.now(); } catch { return Date.now(); }
}
/** Today's UTC date (YYYY-MM-DD) by nowMs(): the daily cabinet's seed. */
export function todayUTC(): string { return new Date(nowMs()).toISOString().slice(0, 10); }

// --- the StarHermit high-score board ---------------------------------------------------
let board: Leaderboard | null = null;
async function highScoreBoard(): Promise<Leaderboard | null> {
  if (board) return board;
  const list = await leaderboards.list();
  board = list.find((b) => b.key === "high-score") ?? list[0] ?? null;
  return board;
}
/** What score-script.js needs to judge a round: which board it was (it builds the
 * level from its own content), the commands played and the round's active seconds. */
export interface RoundClaim { mode: "journey" | "daily" | "challenge"; ref: string | number; commands: unknown[]; elapsedSeconds: number }
export interface Posted { posted: boolean; score: number | null; rank: number | null }

/** Signed in only: post a finished ranked round through score-script.js; never rejects. */
export async function postLeaderboard(claim: RoundClaim): Promise<Posted> {
  const me = player();
  if (!me) return { posted: false, score: null, rank: null };
  let ack: { accepted: string[]; score: number | null } = { accepted: [], score: null };
  try {
    const sessionId = await sessions.practice();
    ack = await new Promise((resolve) => {
      const socket = connectGame(sessionId);
      let done = false;
      const finish = (v: { accepted: string[]; score: number | null }): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        socket.close();
        resolve(v);
      };
      const timer = setTimeout(() => finish({ accepted: [], score: null }), 15000);
      socket.on("open", () => { socket.sendCommand({ type: "result", ...claim } as unknown as JsonValue); });
      socket.on("game", (data) => {
        const d = data as { type?: string; accepted?: string[]; score?: number } | null;
        if (d && d.type === "result-ack") finish({ accepted: Array.isArray(d.accepted) ? d.accepted : [], score: typeof d.score === "number" ? d.score : null });
      });
      socket.on("error", () => finish({ accepted: [], score: null }));
      socket.on("stopped", () => finish({ accepted: [], score: null }));
      socket.on("abandoned", () => finish({ accepted: [], score: null }));
    });
  } catch { return { posted: false, score: null, rank: null }; }
  if (!ack.accepted.includes("high-score")) return { posted: false, score: ack.score, rank: null };
  try {
    const b = await highScoreBoard();
    if (!b) return { posted: true, score: ack.score, rank: null };
    const r = await leaderboards.entries(b.id, { pageSize: 100 });
    const mine = r.items.find((e) => e.userId === me.userId);
    return { posted: true, score: ack.score, rank: mine ? mine.rank : null };
  } catch { return { posted: true, score: ack.score, rank: null }; }
}
