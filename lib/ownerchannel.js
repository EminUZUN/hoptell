// The owner channel's bridge (design 7.2, "The bridge"): the single Telegram poller and the single
// relay peer of one bot. It sends agents' questions to the owner's Telegram chat as cards, and
// routes answers and instructions back to the owner's own agents as signed envelopes.
//
// Targeting (design 7.2 v5, 7.3 section 2): /msg, /agents and "Who is this for?" share one session
// picker over the own agents the relay attests (cap list_own) and people.json (favourites, recent,
// online, More…, Search); a reply to a bot message that names one agent continues with it; the
// paired chat's command menu holds /msg, /agents, /pending, /help and one command per unambiguous
// favourite. Buttons carry opaque ids mapped in state (bound to their message, expiring), never a
// name; a command resolves only through the sets this bridge keeps; an alias is a label, never an
// address. Picker taps in /msg and bare agent commands only open a prompt; a tap in "Who is this
// for?", the "Send to …" confirmation and a host warning's Send send their held text once (a
// choice tap on a question card answers it, as before).
//
// Leadership: the bridge acts only while it holds its relay name (a fresh claim, never a replace)
// and the poll. Each getUpdates is aborted the moment the claim is lost, a late response is
// discarded unprocessed (its offset not confirmed), every side effect checks the claim first, and
// a Telegram 409 (another poller) stops the bridge: it gives its name back and does not retry.
//
// Durable state (<home>/owner-channel/state.json, one atomic rewrite per transition): the offset,
// the questions and the outbox. Every action is first written to the outbox, in the same write as
// the state change it belongs to, then done, then marked done; after a crash, pending entries are
// redone with their stored nonce, so a redone hoptell send is recognisable by its receiver.
//
// Encryption policy: every relay send of the bridge is plaintext to its own member (signed, not
// encrypted). When this home's policy for that member is "required" (its own entry, else the
// realm's default: lib/contacts.js ownEncryptionMode), the receivers hold that plaintext, so the
// bridge does not start, and a send due later (also one prepared before the policy changed) is
// refused for good: its entry ends with reason encryption_required, audited, and the owner is told
// in Telegram once per run of refusals. A policy changed after a question went out cannot erase
// what the relay saw; a later answer may still be held by its receiver.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { MAX_TTL_S, NAME_RE, REF_RE } from "./config.js";
import { NAME_REFUSED, RelayClient } from "./client.js";
import { ENCRYPTION_REQUIRED, contactsFile, filePolicy, homeManaged, ownPlaintextRefused, policyReader } from "./contacts.js";
import { identityState, processIdentity } from "./host.js";
import { tryLock, withLock } from "./locks.js";
import { channelPaths, ensureChannelDir, nonceOf, parseQuestion, readPrivateJson, readReceived, signEnvelope, writePrivateJson } from "./ownersig.js";
import { PeopleFullError, PeopleRefusedError, PeopleStaleError, aliasProblemIn, bump, normalAlias, readPeople, revOf, settingFields, updatePeople } from "./ownerpeople.js";
import { APP_ORIGIN_PROBLEMS, appOriginFor, createOwnerApp, newAppId } from "./ownerapp.js";
import { buildPage } from "./ownerapppage.js";
import { TEXTS, UNDELIVERED_REASONS, ago } from "./ownertexts.js";

export const OWNER_TEXT_MAX = 3500;
export const OPEN_PER_ASKER = 3;
export const NEW_PER_HOUR = 20;
export const PAIR_CODE_MS = 10 * 60_000;
export const PAIR_WRONG_MAX = 5;
const KEEP_CLOSED_MS = 86400_000; // a closed question's record outlives its relay TTL by a day
// Targeting (design 7.2 v5): opaque button ids, reply routes and the per-chat command menu.
export const TARGET_MS = 86400_000; // a target button of /peers or /msg
export const CONFIRM_MS = 10 * 60_000; // the button that sends a reply to a closed card
export const ROUTE_MS = 7 * 86400_000; // a reply to a bot message that names one agent
export const MENU_HOLD_MS = 86400_000; // a name stays in its command's set this long after it was last seen
const MENU_RENEW_MS = 3600_000; // last_seen is renewed at most this often (one write an hour, not a minute)
export const MENU_CHECK_MS = 60_000;
const MAX_TARGETS = 200;
const MAX_ROUTES = 1000;
const MAX_TRACKED_COMMANDS = 500;
const MAX_TRACKED_NAMES = 1000;
export const MAX_COMMANDS = 100; // Telegram's limit for one scope
export const MAX_BUTTONS = 12; // every button of one message, controls included (design 7.3, 2.1)
// The session picker (design 7.3, 2.1, phase-2 notes P3): the first screen, then pages.
export const PICKER_FIRST = 10; // session buttons on the first screen (9 when it also has Cancel)
export const PICKER_PAGE = 8; // session buttons on a page of More… or a search
export const RECENT_MAX = 5;
export const RECENT_MS = 7 * 86400_000;
export const HOLD_MS = 10 * 60_000; // the held text of "Who is this for?" (2.4) and of a host warning (2.8)
export const TG_TEXT_MAX = 4096;
// Question cards (design 7.3, section 1): every live copy of a card is kept in its question's
// record until the question closes; past this cap the oldest copy is retired visibly.
export const MAX_CARD_COPIES = 20;
export const SHOW_PER_PAIRING = 3; // "Show" re-sends of one question's card per pairing
export const PENDING_PAGE = 8; // questions per /pending page
const EXCERPT = 60; // characters of a question in /pending

// Notes from agents (design 7.3, section 3). The limits and the notification rule are proposals
// the owner has not decided yet: each is one named value here.
export const NOTICE_LIMITS = {
  text: 3000, // characters after trimming; longer is cut with "…"
  perAgentShort: { max: 10, ms: 10 * 60_000 }, // per agent: 10 per 10 minutes
  perAgentHour: { max: 30, ms: 3600_000 }, // per agent: 30 per hour
  allHour: { max: 60, ms: 3600_000 }, // all agents together: 60 per hour
  warnEveryMs: 3600_000, // the one-line warning: once per agent (and once overall) per hour
  statusEveryMs: 3600_000, // a status to the agent about a note not shown: once per agent per hour
};
/** The phase-1 notification rule: a note notifies only if the owner messaged that agent this recently. */
export const NOTICE_NOTIFY_MS = 3600_000;
export const NOTICE_ROUTE_MS = 86400_000; // a reply to a note continues with its agent this long,
export const MAX_NOTICE_ROUTES = 1500; // while it is among the last 1,500 notes shown
const NOTICE_SEEN_MS = 8 * 86400_000; // relay message ids of notes already taken (redelivery)
const MAX_NOTICE_SEEN = 5000;
const MAX_LAST_SENT = 1000;
// Instructions the bridge sent (state.sent, design 7.3 section 3, threading): relay message id ->
// {name, member, pairing, msg (the owner's Telegram message that carried it), exp}. A note that
// replies to one, from the agent it was sent to, is threaded under the owner's message.
export const SENT_MS = 7 * 86400_000;
export const MAX_SENT = 1000;
export const STATIC_COMMANDS = [
  { command: "msg", description: "Message an agent" },
  { command: "agents", description: "Your agents and favourites" },
  { command: "pending", description: "Questions waiting for you" },
  { command: "help", description: "How this works" },
];
const RESERVED_COMMANDS = new Set(["start", "help", "settings", "pending", "peers", "msg", "cancel", "agents", "app"]);
/** The menu's /app line, while the app is on and the relay serves it (design 7.4, section 8). */
export const APP_COMMAND = { command: "app", description: "Open the hoptell app" };
const AUDIT_MAX = 1024 * 1024;
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const b32 = (n, alphabet = B32) => [...crypto.randomBytes(n)].map((b) => alphabet[b & 31]).join("");
const digest = (s) => crypto.createHash("sha256").update(String(s)).digest("hex").slice(0, 16);
const short = (q) => q.slice(0, 8);
const tid = () => b32(10, "abcdefghijklmnopqrstuvwxyz234567");

/** Cut a text to Telegram's message limit, with "…" (never split: one item, one message id). */
export function fit(text, max = TG_TEXT_MAX) {
  const t = String(text);
  if (t.length <= max) return t;
  let cut = t.slice(0, max - 1);
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1); // never half a surrogate pair
  return `${cut}…`;
}

/** A button label from agent text: control and format characters and line breaks become spaces. */
export const cleanLabel = (s, max = 64) => String(s).replace(/[\p{Cc}\p{Cf}\u2028\u2029]+/gu, " ").replace(/\s+/g, " ").trim().slice(0, max) || "?";

/**
 * The menu command for a display name: lower-cased, "-" mapped to "_", then 1-32 of [a-z0-9_]
 * and not reserved; else null (that agent gets no command; buttons and @ still work).
 */
export function commandOf(display) {
  const c = String(display).toLowerCase().replace(/-/g, "_");
  return /^[a-z0-9_]{1,32}$/.test(c) && !RESERVED_COMMANDS.has(c) ? c : null;
}

/** Reply parameters that survive a deleted original (a 400 would lose the reply for good). */
const replyParams = (id) => (id ? { reply_parameters: { message_id: id, allow_sending_without_reply: true } } : {});
// A status sent before any pairing (a question that expired while the bot was unpaired) names no
// pairing; answers and instructions exist only after one.
const UNPAIRED = { id: "p_notpairednotpair", at: 1 };

/** A failure injected by tests at a named boundary: the bridge stops at once, as if it crashed. */
export class Crash extends Error {}
class NotLeader extends Error {}

// ---- audit (<home>/owner-channel/audit.jsonl): events, digests and lengths, never text ---------

export function audit(home, event, fields = {}, now = Date.now()) {
  const file = channelPaths(home).audit;
  try {
    ensureChannelDir(home);
    try {
      if (fs.statSync(file).size > AUDIT_MAX) fs.renameSync(file, `${file}.1`); // one older file is kept
    } catch {}
    const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
    try {
      fs.writeSync(fd, `${JSON.stringify({ at: new Date(now).toISOString(), event, ...fields })}\n`);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // the audit never stops the bridge
  }
}

/** Audit entries, oldest first (both files). */
export function readAudit(home) {
  const file = channelPaths(home).audit;
  const out = [];
  for (const f of [`${file}.1`, file]) {
    try {
      for (const line of fs.readFileSync(f, "utf8").split("\n")) if (line) out.push(JSON.parse(line));
    } catch {}
  }
  return out;
}

// ---- pairing (<home>/owner-channel/pairing.json) -----------------------------------------------

export function readPairing(home) {
  const p = readPrivateJson(channelPaths(home).pairing, 16 * 1024);
  return p?.v === 1 ? p : null;
}

const withPairing = (home, fn) => withLock(channelPaths(home).pairing, fn, { waitMs: 5000 });

/** A new one-time pairing code (8 base32 characters, 40 bits, 10 minutes, single use). */
export async function newPairingCode(home, botId, now = Date.now()) {
  ensureChannelDir(home);
  const code = b32(8);
  await withPairing(home, () => {
    const p = readPairing(home) ?? { v: 1, bot_id: String(botId), paired: null };
    if (p.bot_id !== String(botId)) throw new Error("the pairing belongs to another bot; run hoptell telegram unpair --all first");
    writePrivateJson(channelPaths(home).pairing, { ...p, pending: { digest: crypto.createHash("sha256").update(code).digest("hex"), expires_at: now + PAIR_CODE_MS, wrong: 0 } });
  });
  return code;
}

/**
 * A /start attempt from a private chat: "paired" (the code matched: the user and chat are bound),
 * "wrong" (counted; the code is void after five), or "none" (no code waits).
 */
async function tryPair(home, botId, { code, userId, chatId, now, update = null }) {
  return withPairing(home, () => {
    const p = readPairing(home);
    if (!p || p.bot_id !== String(botId) || !p.pending) return "none";
    if (now > p.pending.expires_at) {
      writePrivateJson(channelPaths(home).pairing, { ...p, pending: null });
      return "none";
    }
    if (!code) return "none"; // a bare /start is not a try
    const want = Buffer.from(p.pending.digest, "hex");
    // Codes are issued upper-case; a client may change the case (or add spaces): both are ignored.
    const got = crypto.createHash("sha256").update(String(code ?? "").trim().toUpperCase()).digest();
    if (code && want.length === got.length && crypto.timingSafeEqual(want, got)) {
      writePrivateJson(channelPaths(home).pairing, { ...p, pending: null, paired: { user_id: userId, chat_id: chatId, id: `p_${b32(16, "abcdefghijklmnopqrstuvwxyz234567")}`, at: now, update } });
      return "paired";
    }
    // A wrong try given again (the same update after a crash) is counted once.
    if (update !== null && p.pending.last_update === update) return "wrong";
    const wrong = p.pending.wrong + 1;
    writePrivateJson(channelPaths(home).pairing, { ...p, pending: wrong >= PAIR_WRONG_MAX ? null : { ...p.pending, wrong, last_update: update } });
    return wrong >= PAIR_WRONG_MAX ? "void" : "wrong";
  });
}

// ---- state (<home>/owner-channel/state.json) ---------------------------------------------------

/**
 * Turn the app on or off, or give it a new link (design 7.4, sections 2 and 5), with the bridge
 * stopped. `action`: "on", "off", "rotate". Every change raises the app generation (sessions and
 * app work of an earlier one end); on and rotate also move `since` (initData opened before it never
 * opens a session). Ids turned off or replaced are kept in `off` and `retire` until the relay has
 * been told. Returns the app state written.
 */
export function changeOwnerApp(home, botId, action, now = Date.now()) {
  const state = readState(home, botId);
  const a = state.app ?? null;
  if (action === "on") {
    if (a?.on) return a;
    state.app = a ? { ...a, on: true, gen: (a.gen ?? 0) + 1, since: now } : { id: newAppId(), on: true, gen: 1, since: now };
    if (state.app.off) state.app.off = state.app.off.filter((x) => x !== state.app.id);
    if (!state.app.off?.length) delete state.app.off;
  } else if (action === "off") {
    if (!a?.on) return a;
    state.app = { ...a, on: false, gen: (a.gen ?? 0) + 1, off: [...new Set([...(a.off ?? []), a.id])] };
  } else if (action === "rotate") {
    if (!a) throw new Error("the app was never turned on");
    // The old id is retired at the relay: it answers 404 from then on, and no one can take it.
    state.app = { ...a, id: newAppId(), gen: (a.gen ?? 0) + 1, since: now, retire: [...new Set([...(a.retire ?? []), a.id])] };
  } else throw new Error(`unknown app action ${action}`);
  writePrivateJson(channelPaths(home).state, state);
  audit(home, "app", { action }, now);
  return state.app;
}

export function readState(home, botId) {
  const s = readPrivateJson(channelPaths(home).state, 16 * 1024 * 1024);
  // A state written by this version always has the key `owner` (null: never paired); a state
  // without it was written by 7.2 and is migrated at the bridge's start (design 7.3, 2.9).
  if (!s) return { v: 1, bot_id: String(botId), offset: 0, questions: {}, outbox: [], recent: [], drops: {}, owner: null, card_seq: 0 };
  if (s.v !== 1 || typeof s.questions !== "object" || !Array.isArray(s.outbox)) throw new Error(`${channelPaths(home).state} is malformed`);
  if (s.bot_id !== String(botId)) throw new Error("the owner channel's state belongs to another bot; run hoptell telegram unpair --all first");
  return s;
}

/**
 * The bridge's run record (status and doctor): {pid, start, uid, boot, state, reason, at}, with
 * `identity` from host.js identityState: "same" (that process still runs), "different" (it is
 * gone: another boot, no such pid, a zombie, or another process with that pid) or "unknown".
 */
export function readRun(home, deps = {}) {
  try {
    const r = readPrivateJson(path.join(channelPaths(home).dir, "run.json"), 16 * 1024);
    if (!r) return null;
    const identity = identityState(r, deps);
    return { ...r, identity, live: identity === "same" && r.state !== "stopped" };
  } catch {
    return null;
  }
}

// ---- texts shown in Telegram: lib/ownertexts.js ---------------------------------------------------

/** Whether a plain text from an agent is reserved (design 7.3, section 3), fail closed. */
export function reservedText(text) {
  const t = String(text).trim();
  if (!t.startsWith("{")) return false;
  let v;
  try {
    v = JSON.parse(t);
  } catch {
    return true; // truncated or invalid JSON that looks like a protocol body
  }
  return !v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).some((k) => k.startsWith("hoptell_"));
}

// ---- the bridge -----------------------------------------------------------------------------------

/**
 * Create a bridge. `telegram`: a Bot API client (lib/telegram.js, or a fake in tests); `relay`:
 * {url, token, signIn?} of the bridge's relay; `alias` and `namePrefix`: that relay's entry;
 * `name`: the bridge's wire name; `key`: the signing key {pub, priv}; `botId`; `expectRealm` and
 * `expectMember`: the realm and member bridge.json names (a relay answering otherwise is refused).
 * Options: `fault(point)` (tests: throw Crash to stop at a boundary), `noticeLimits` (tests: other
 * values for NOTICE_LIMITS), `now`, `log`, `pollTimeout`
 * (seconds), `tickMs` (expiry checks), `retryMs`, `menuCheckMs` (the command menu), `clientFactory`.
 * start() resolves when the bridge stops: {code, message}. code: "stopped" | "name_in_use" |
 * "conflict" | "webhook" | "locked" | "crashed" | "refused".
 */
/** A step found stale right before its Telegram call: retired, never sent. */
class StaleStep extends Error {}

export function createBridge({ home, telegram, relay: relayOpts, alias = "default", namePrefix = "", name, key, botId, expectRealm = null, expectMember = null, noticeLimits = null, appKey = null, appUrl = null, appLimits = null, maxTargets = MAX_TARGETS, fault = null, now = () => Date.now(), log = () => {}, pollTimeout = 50, tickMs = 30_000, retryMs = 5000, menuCheckMs = MENU_CHECK_MS, clientFactory = (o) => new RelayClient(o) }) {
  botId = String(botId);
  const paths = channelPaths(home);
  const address = `${alias}/${name}`;
  let state = null;
  let relay = null;
  let releaseLock = null;
  let stopped = false;
  let finish;
  const done = new Promise((r) => (finish = r));
  let poll = null; // {ac, gen} of the getUpdates in progress
  let sideAc = null; // aborts every Telegram call of the current generation on loss or stop
  let gen = 0; // leadership generation: changes on every gain and loss
  let leader = false;
  let ticker = null;
  let retryTimer = null;
  let chain = Promise.resolve();
  let draining = false; // unpair --all: statuses only; Telegram is not polled
  let backoffUntil = 0; // a 429's retry_after: no outbox retry or menu check before this
  let menuTicker = null;
  let lastMenuCheck = 0;
  const deleteRefused = new Set(); // chats whose menu deletion Telegram refused in this run
  const status = { state: "starting", reason: null };

  const LIMITS = { ...NOTICE_LIMITS, ...(noticeLimits ?? {}) };
  const policy = policyReader(contactsFile(home));
  /**
   * Plaintext to the bridge's own member is refused now: true when its policy is "required",
   * "unreadable" when this home's contacts are managed but the policy file is missing, unreadable
   * or invalid (fail closed: nothing is sent until it is fixed), else false.
   */
  let lastUnreadable = null;
  let managed = false; // sticky: once this process saw the home managed, it stays managed
  const plaintextRefused = () => {
    managed ||= homeManaged(home);
    const p = filePolicy({ managed, read: policy() });
    if (p.refuse) {
      if (p.problem !== lastUnreadable) log(`owner channel: ${p.refuse}; answers wait until it is fixed`);
      lastUnreadable = p.problem;
      return "unreadable";
    }
    lastUnreadable = null;
    return ownPlaintextRefused(p.doc, relay?.realm?.id ?? expectRealm, relay?.member?.id ?? null);
  };
  const hit = (point) => fault?.(point);
  /** Wait `ms`, or less when `signal` aborts (a stop or a lost claim). */
  const pause = (ms, signal) =>
    new Promise((resolve) => {
      if (signal?.aborted) return resolve();
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        signal?.removeEventListener("abort", done);
        resolve();
      }
      signal?.addEventListener("abort", done, { once: true });
    });
  const save = (label) => {
    hit(`write:${label}`);
    writePrivateJson(paths.state, state);
  };
  const leading = () => !stopped && leader && relay?.connected === true;
  const ensureLeader = () => {
    if (!leading()) throw new NotLeader("not the leader");
  };
  /** Run fn after every earlier transition; transitions never interleave. */
  const serial = (fn) => {
    const p = chain.then(() => (stopped ? undefined : fn()));
    chain = p.catch(() => {});
    return p.catch((e) => {
      if (e instanceof Crash) return halt("crashed", e.message);
      if (e instanceof NotLeader) return undefined;
      log("owner channel:", e.message);
      return undefined;
    });
  };
  const writeRun = (s, reason = null) => {
    Object.assign(status, { state: s, reason });
    try {
      const id = processIdentity(process.pid);
      writePrivateJson(path.join(paths.dir, "run.json"), { v: 1, pid: process.pid, start: id?.start ?? null, uid: id?.uid ?? null, boot: id?.boot ?? null, state: s, reason, address, at: now() });
    } catch {}
  };
  const count = (reason) => {
    state.drops[reason] = (state.drops[reason] ?? 0) + 1;
    audit(home, "dropped", { reason, count: state.drops[reason] }, now());
  };

  // ---- leadership --------------------------------------------------------------------------

  function gain() {
    if (stopped || leader) return;
    leader = true;
    gen++;
    sideAc = new AbortController();
    writeRun("leader");
    audit(home, "leader", { address }, now());
    log(`owner channel: leader as ${address}`);
    kick();
    if (!draining) {
      // The app (design 7.4): registered with the relay on every gain; its runner picks up its entries.
      // Pending menu deletions first, then the current menu (with /app once the relay registered it).
      ownerApp.register().then(() => (leading() ? serial(() => menuWork(true)) : undefined));
      ownerApp.kick();
      pollLoop(); // a drain sends what the outbox holds and handles no new update
    }
  }
  function lose(why) {
    if (!leader) return;
    leader = false;
    gen++;
    poll?.ac.abort(); // a response obtained after this is discarded
    sideAc?.abort(); // and so is every Telegram call in flight: its result is never applied
    if (!stopped) writeRun("waiting", why);
    audit(home, "lost-leader", { reason: String(why ?? "").slice(0, 80) }, now());
  }

  function halt(code, message) {
    if (stopped) return;
    stopped = true;
    leader = false;
    gen++;
    poll?.ac.abort();
    sideAc?.abort();
    clearInterval(ticker);
    clearInterval(menuTicker);
    clearTimeout(retryTimer);
    clearTimeout(signalTimer); // signals not written yet are dropped (they are hints)
    const appDone = ownerApp?.stop();
    relay?.close(); // a clean close gives the name back (release)
    // This home's lock is kept until the work already running has settled (aborted calls end it,
    // and nothing is applied after the generation changed), so a new run never overlaps it. The
    // app runner works outside the chain (a people.json write may be waiting for its lock).
    Promise.all([chain, appDone]).then(() => {
      writeRun("stopped", code === "stopped" ? null : code);
      releaseLock?.();
      finish({ code, message });
    });
  }

  // ---- polling --------------------------------------------------------------------------

  let polling = false;
  async function pollLoop() {
    if (polling) return;
    polling = true;
    try {
      while (!stopped && leading()) {
        const mine = gen;
        const ac = new AbortController();
        poll = { ac, gen: mine };
        let updates;
        try {
          updates = await telegram.getUpdates({ offset: state.offset || undefined, timeout: pollTimeout, signal: ac.signal });
        } catch (e) {
          if (stopped) break;
          if (e?.conflict) {
            await serial(() => conflict());
            break;
          }
          if (ac.signal.aborted || mine !== gen) continue; // lost the claim: back to waiting
          log("owner channel: getUpdates failed:", e.message);
          await new Promise((r) => setTimeout(r, Math.min(retryMs, 30_000)));
          continue;
        } finally {
          if (poll?.ac === ac) poll = null;
        }
        // A response that arrives after the claim was lost is discarded: nothing processed, the
        // offset not confirmed, so Telegram gives these updates again to whoever polls next.
        if (mine !== gen || !leading()) {
          log("owner channel: a poll response arrived after the claim was lost; discarded");
          continue;
        }
        const left = await serial(() => handleBatch(Array.isArray(updates) ? updates : [], mine));
        // An update whose work could not finish stays unconfirmed, and Telegram gives it again at
        // once: the next poll waits retryMs first (abortable on stop and on loss), so a side effect
        // that fails instantly is retried at that pace, not in a loop.
        if (left === "pending" && !stopped && mine === gen) await pause(retryDelay(), sideAc?.signal);
      }
    } finally {
      polling = false;
    }
  }

  /** Handle a poll's updates in order; "pending" when one could not finish (it stays unconfirmed). */
  async function handleBatch(updates, mine) {
    for (const u of updates.sort((a, b) => a.update_id - b.update_id)) {
      if (mine !== gen || !leading()) return undefined; // the rest comes again
      await handleUpdate(u);
      if (state.outbox.some((e) => e.kind === "u" && e.update === u.update_id)) return "pending"; // could not finish: retried later
    }
    return undefined;
  }

  function conflict() {
    audit(home, "conflict", { address }, now());
    halt("conflict", "another process polls this bot; hoptell supports one bridge per bot. Stop the other one or use another bot.");
  }

  // ---- the outbox ------------------------------------------------------------------------

  /** Run pending outbox entries in order; stops at the first that has to wait. */
  async function runOutbox() {
    reconciled();
    for (const entry of [...state.outbox]) {
      if (!state.outbox.includes(entry)) continue;
      // App entries (design 7.4, section 5) have their own runner: they never hold this queue.
      if (entry.origin === "a" && entry.kind === "a") continue;
      if ((await runEntry(entry)) === "wait") {
        scheduleRetry();
        return false;
      }
    }
    return true;
  }
  const kick = () => serial(() => runOutbox());
  /** The wait before the outbox is tried again: retryMs, or longer while Telegram asks (429). */
  const retryDelay = () => Math.max(retryMs, backoffUntil - now());
  function scheduleRetry() {
    if (retryTimer || stopped) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      kick();
    }, retryDelay());
    retryTimer.unref?.();
  }

  /** After an awaited side effect: still the same leader, or nothing is applied or written. */
  const stillLeading = (mine) => {
    if (mine !== gen || !leading()) throw new NotLeader("lost the claim during a side effect");
  };

  let running = null; // the outbox step being run, for tg()'s last check
  async function runEntry(entry) {
    while (entry.next < entry.steps.length) {
      ensureLeader();
      const mine = gen;
      const step = entry.steps[entry.next];
      // A step admitted under another pairing is retired, never sent (design 7.3, 2.9); tg()
      // checks again right before each Telegram call, because a step can wait on the relay first.
      const origin = pid(); // for an unbound step's replacements: the pairing when it started
      let r;
      if (stale(step)) r = retire(step);
      else {
        running = step;
        try {
          r = await runStep(entry, step);
        } catch (e) {
          if (!(e instanceof StaleStep)) throw e;
          r = retire(step);
        } finally {
          running = null;
        }
      }
      stillLeading(mine);
      if (r.wait) return "wait";
      hit(`after-step:${step.t}`);
      entry.next++;
      // A refusal replaces the steps that depended on success, in the same write as its outcome.
      // Its replacements (a fallback, a refusal's reply, a continuation) belong to the action it
      // came from: they keep that step's pairing, never the one current when it finished.
      // Cleanup meant for the current pairing carries its own stamp (retire, the reconcile).
      if (r.replace) entry.steps = [...entry.steps.slice(0, entry.next), ...stamp(r.replace, Object.hasOwn(step, "pairing") ? step.pairing : origin)];
      r.apply?.();
      if (entry.next >= entry.steps.length) {
        state.outbox = state.outbox.filter((e) => e !== entry);
        if (entry.kind === "u") state.offset = Math.max(state.offset, entry.update + 1);
        save("done");
      } else save("step");
    }
    return "done";
  }

  const pairing = () => readPairing(home)?.paired ?? null;
  /** The current pairing id (never shown), or null while unpaired. */
  const pid = () => pairing()?.id ?? null;

  // ---- binding (design 7.3, 2.9): every control and outbox step keeps its pairing ---------------

  // Every Telegram step and every owner-origin send (an answer, an instruction) is stamped with the
  // pairing it was admitted under (null: none existed then). Automatic statuses and the command
  // menu (which follows the current pairing by itself) are not bound.
  const BOUND_STEPS = new Set(["tg", "list", "details", "card", "notice", "react", "pending", "edit", "editcopy"]);
  const isBound = (step) => BOUND_STEPS.has(step.t) || (step.t === "send" && (step.kind === "answer" || step.kind === "instruction"));
  function stamp(steps, p = pid()) {
    for (const s of steps) if (isBound(s) && !Object.hasOwn(s, "pairing")) s.pairing = p;
    return steps;
  }
  /**
   * Admit an outbox entry: its bound steps carry the current pairing. Every entry records its origin
   * (design 7.4, section 1): "u" a Telegram update, "q" a relay message or the bridge itself, "a" an
   * app request. sendStep never signs for an entry of origin "a".
   */
  function admit(entry) {
    entry.origin ??= entry.kind === "u" ? "u" : entry.kind === "a" ? "a" : "q";
    stamp(entry.steps);
    state.outbox.push(entry);
    return entry;
  }
  /**
   * Whether a step belongs to another pairing than the current one (also when none exists now). A
   * card admitted while unpaired (null) goes to the first pairing (the reconcile decides about
   * later ones); a step without a stamp is retired (fail closed).
   */
  function stale(step) {
    if (!isBound(step)) return false;
    if (!Object.hasOwn(step, "pairing")) return true;
    if (step.t === "card" && step.pairing === null) return false;
    return step.pairing !== pid();
  }
  /** A stale step: counted and retired; an answer of an earlier pairing closes its question. */
  function retire(step) {
    count("old_pairing");
    if (step.t === "send" && step.kind === "answer") {
      const rec = state.questions[step.q];
      if (!rec) return { replace: [] };
      // Its cards show the cancellation: now in the current pairing, or by the next reconcile.
      return {
        replace: [statusStep(rec, step.q, "retired", `cancelled: your question ${step.q} was cancelled because your owner's Telegram connection changed before the answer could be sent; ask again if it is still needed.`), ...(pid() ? [{ ...editFor(rec, step.q), pairing: pid() }] : [])],
        apply: () => {
          Object.assign(rec, { status: "cancelled", payload: null, closed_at: now() });
          closeView(rec, TEXTS.cancelled(rec.num, labelOf(rec.asker.name)));
        },
      };
    }
    // The rest of an owner action (its acknowledgement, its 👍) belongs to the same pairing.
    return step.t === "send" ? { replace: [] } : {};
  }

  // ---- people.json (design 7.3, 2.7): favourites, names, hidden sessions, two times each ----------

  /** people.json applies to the bridge's member and the paired Telegram user (none while unpaired). */
  const peopleScope = () => ({ member: ownMember() ?? expectMember, owner: pairing()?.user_id ?? null });
  // Signals (last_talked, first_seen) are batched: kept here and written at most once a second
  // (and on stop), so a burst of notes or a long list does not rewrite people.json per name.
  let signals = { scope: null, pending: new Map(), flushing: new Map() };
  let signalTimer = null;
  const scopeKey = (sc) => `${sc.member}\n${sc.owner}`;
  /** people.json's sessions for the current scope, with the signals not written yet. */
  function people() {
    const sc = peopleScope();
    const sessions = readPeople(home, sc).sessions;
    if (signals.scope !== scopeKey(sc)) return sessions;
    for (const m of [signals.flushing, signals.pending]) {
      for (const [n, f] of m) {
        const e = { ...(Object.hasOwn(sessions, n) ? sessions[n] : {}) };
        if (f.last_talked) e.last_talked = Math.max(Number(e.last_talked) || 0, f.last_talked);
        if (f.first_seen && !e.first_seen) e.first_seen = f.first_seen;
        sessions[n] = e;
      }
    }
    return sessions;
  }
  /**
   * Change people.json for an owner action made under pairing `madeUnder` (its control's or route's
   * pairing): under the file's lock, that pairing, the paired user and the member must still be the
   * current ones, or PeopleStaleError and nothing is written (a re-pair while the action waited never
   * lands in the next owner's file). PeopleFullError and PeopleRefusedError pass through.
   */
  function changePeople(change, madeUnder) {
    const sc = peopleScope();
    const still = () => {
      const p = pairing();
      return Boolean(p) && p.id === madeUnder && String(p.user_id) === String(sc.owner) && (ownMember() ?? expectMember) === sc.member;
    };
    return updatePeople(home, sc, change, now(), { still });
  }
  /**
   * Record a signal (last_talked, first_seen) for `names`, best effort: never while unpaired, and
   * skipped for a new name when people.json is full of saved entries. `keep`: only where unset.
   */
  function touch(names, field, { keep = false } = {}) {
    const list = [...new Set(names)].filter((n) => typeof n === "string" && n !== name);
    const sc = peopleScope();
    if (!list.length || !sc.owner || !sc.member) return;
    if (signals.scope !== scopeKey(sc)) signals = { scope: scopeKey(sc), pending: new Map(), flushing: new Map() };
    const cur = keep ? people() : null;
    const t = now();
    let added = false;
    for (const n of list) {
      if (keep && cur[n]?.[field]) continue;
      signals.pending.set(n, { ...signals.pending.get(n), [field]: t });
      added = true;
    }
    if (added && !signalTimer && !stopped) {
      signalTimer = setTimeout(() => {
        signalTimer = null;
        flushSignals();
      }, 1000);
      signalTimer.unref?.();
    }
  }
  async function flushSignals() {
    if (!signals.pending.size || signals.flushing.size) return;
    const batch = signals;
    batch.flushing = batch.pending;
    batch.pending = new Map();
    const [member, owner] = batch.scope.split("\n");
    try {
      await updatePeople(
        home,
        { member, owner },
        (sessions, entry) => {
          for (const [n, f] of batch.flushing) {
            if (!NAME_RE.test(n)) continue;
            const has = Object.hasOwn(sessions, n);
            if (f.last_talked && !(has && Number(sessions[n].last_talked) >= f.last_talked)) entry(n).last_talked = f.last_talked;
            if (f.first_seen && !(has && sessions[n].first_seen)) entry(n).first_seen = f.first_seen;
          }
        },
        now(),
        // Signals of an earlier owner (a re-pair while they waited) are dropped, never written.
        { still: () => scopeKey(peopleScope()) === batch.scope },
      );
    } catch (e) {
      if (!(e instanceof PeopleFullError) && !(e instanceof PeopleStaleError)) log("owner channel: people.json could not be updated:", e.message);
    } finally {
      batch.flushing = new Map();
    }
    if (batch.pending.size && !stopped) {
      signalTimer ??= setTimeout(() => {
        signalTimer = null;
        flushSignals();
      }, 1000);
      signalTimer.unref?.();
    }
  }

  /** The update being classified: people.json changes it makes are written as "bot:<update id>". */
  let classifying = null;
  const botOp = () => `bot:${classifying}`;

  // ---- labels (design 7.3, "Display rule" and 2.8) -------------------------------------------------

  /** An agent's logical name: its wire name without this relay entry's prefix. */
  const display = (wire) => (namePrefix && wire.startsWith(namePrefix) && wire.length > namePrefix.length ? wire.slice(namePrefix.length) : wire);
  const ownMember = () => relay?.member?.id ?? null;
  let knownOwn = new Set(); // the own agents of the last attested list
  let knownHosts = new Map(); // their hosts as the relay reports them, online ones only (a hint)
  let knownAt = 0;
  /**
   * Texts per name over the eligible set (the last attested list, every name people.json and this
   * bridge's state hold, and `extra`), after `first`; names are grouped by text, compared
   * case-insensitively, and in every group of two or more each name not yet shown by its wire name
   * falls back to it; repeated until no group changes. Each name falls back at most once, so this
   * ends; a group of wire names only is final (relay names are case-sensitive and unique).
   */
  function resolveTexts(all, first) {
    const lab = new Map([...all].map((w) => [w, { text: first(w), wire: first(w) === w }]));
    for (;;) {
      const groups = new Map();
      for (const [w, l] of lab) groups.set(l.text.toLowerCase(), [...(groups.get(l.text.toLowerCase()) ?? []), w]);
      let changed = false;
      for (const ws of groups.values()) {
        if (ws.length < 2) continue;
        for (const w of ws) {
          if (!lab.get(w).wire) {
            lab.set(w, { text: w, wire: true });
            changed = true;
          }
        }
      }
      if (!changed) return new Map([...lab].map(([w, l]) => [w, l.text]));
    }
  }
  /**
   * {label, full, plain} for every name of the eligible set (design 7.3, 2.8, phase-2 notes P3).
   * `full` is "Alias (logical)" with an alias, else the logical name; names whose full forms
   * collide show their wire names. `label` is the alias, else the logical name; names whose labels
   * collide show their (resolved) full form, and names still colliding then show their wire
   * names. `plain` ignores aliases (the rename prompt). A label gets "?" while the name is held
   * from another host than the one saved with its alias.
   */
  function labels(extra = [], ppl = people()) {
    const all = new Set([...knownOwn, ...extra, ...Object.keys(ppl)]);
    for (const r of Object.values(state.questions)) if (r?.asker?.name) all.add(r.asker.name);
    for (const m of [state.routes, state.notice_routes, state.targets]) for (const x of Object.values(m ?? {})) if (typeof x?.name === "string") all.add(x.name);
    all.delete(name);
    const alias = (w) => (Object.hasOwn(ppl, w) && typeof ppl[w].alias === "string" && ppl[w].alias) || null;
    const plain = resolveTexts(all, display);
    const full = resolveTexts(all, (w) => (alias(w) ? `${alias(w)} (${display(w)})` : display(w)));
    // Labels: level 0 the label, 1 the resolved full form, 2 the wire name; a colliding name moves up.
    const lab = new Map([...all].map((w) => [w, 0]));
    const textOf = (w) => [alias(w) ?? display(w), full.get(w), w][lab.get(w)];
    for (;;) {
      const groups = new Map();
      for (const w of all) groups.set(textOf(w).toLowerCase(), [...(groups.get(textOf(w).toLowerCase()) ?? []), w]);
      let changed = false;
      for (const ws of groups.values()) {
        if (ws.length < 2) continue;
        for (const w of ws) {
          if (lab.get(w) < 2) {
            lab.set(w, lab.get(w) + 1);
            changed = true;
          }
        }
      }
      if (!changed) break;
    }
    const moved = (w) => Boolean(alias(w) && ppl[w].alias_host && knownHosts.has(w) && knownHosts.get(w) !== ppl[w].alias_host);
    return new Map([...all].map((w) => [w, { label: `${textOf(w)}${moved(w) ? "?" : ""}`, full: full.get(w), plain: plain.get(w), moved: moved(w), alias: alias(w) }]));
  }
  const labelOf = (wire) => labels([wire]).get(wire)?.label ?? wire;
  const fullOf = (wire) => labels([wire]).get(wire)?.full ?? wire;
  /** Refresh the attested list for labels before a card, a note or a list (best effort, at most every 5 s). */
  async function refreshNames() {
    if (now() - knownAt < 5000) return;
    try {
      await ownAgents();
    } catch (e) {
      if (e instanceof NotLeader) throw e;
    }
  }

  // ---- targeting (design 7.2 v5): own agents, routes, buttons, the menu --------------------------

  /**
   * The relay's list: {attested: true, own} with the entries the relay attests as held by the
   * bridge's member (cap list_own), never by a name's shape; {attested: false, all} on a relay
   * without that cap. Throws when the relay cannot list now.
   */
  async function ownAgents() {
    ensureLeader();
    const mine = gen;
    let list;
    try {
      list = await relay.list();
    } catch (e) {
      stillLeading(mine);
      throw new Error(`the relay could not list peers: ${e.message}`);
    }
    stillLeading(mine);
    list = Array.isArray(list) ? list : [];
    if (!relay.caps?.includes("list_own")) return { attested: false, all: list.filter((p) => typeof p?.name === "string" && NAME_RE.test(p.name) && p.name !== name) };
    const own = list.filter((p) => p?.own === true && p.custody !== "hosted" && typeof p.name === "string" && NAME_RE.test(p.name) && p.name !== name);
    knownOwn = new Set(own.map((p) => p.name));
    knownHosts = new Map(own.filter((p) => p.online && typeof p.host === "string" && p.host).map((p) => [p.name, p.host]));
    knownAt = now();
    // Names the relay lists but does not attest as this member's (another member's, hosted): never
    // offered from people.json either.
    const others = new Set(list.filter((p) => typeof p?.name === "string" && !knownOwn.has(p.name)).map((p) => p.name));
    return { attested: true, own, others };
  }

  /**
   * Bounded maps: the entries closest to expiry go first. App Undo buttons are never among them:
   * they have their own bound (lib/ownerapp.js), so ordinary buttons cannot push them out.
   */
  function capMap(map, max) {
    const keys = Object.keys(map).filter((k) => map[k]?.kind !== "undo");
    if (keys.length <= max) return;
    for (const k of keys.sort((a, b) => map[a].exp - map[b].exp).slice(0, keys.length - max)) delete map[k];
  }
  function addRoute(messageId, { name: to, member, kind, pairing: p, chat, q = null, screen = null, mode = null, hold = null }) {
    // Message ids are unique only within one chat: a route keeps the chat it was made in.
    // `chat` is the chat the Telegram call itself used, never the one current when it is recorded.
    // A search prompt's route names no agent (`name` null): its reply lists matches, never sends.
    state.routes[String(messageId)] = { name: to ?? null, member, kind, pairing: p ?? null, chat: chat ?? null, ...(q ? { q } : {}), ...(Number.isSafeInteger(screen) ? { screen } : {}), ...(mode ? { mode } : {}), ...(hold ? { hold } : {}), exp: now() + ROUTE_MS };
    capMap(state.routes, MAX_ROUTES);
  }
  /** A note's reply route: 24 hours, while it is among the last MAX_NOTICE_ROUTES notes shown. */
  function addNoticeRoute(messageId, { name: to, member, pairing: p, chat }) {
    state.notice_routes[String(messageId)] = { name: to, member, pairing: p ?? null, chat: chat ?? null, exp: now() + NOTICE_ROUTE_MS };
    capMap(state.notice_routes, MAX_NOTICE_ROUTES);
  }
  /**
   * A closed card's view (N1 of the phase-1 notes): the text its copies should show now, rendered
   * from the question's state; an edit renders the current view when it runs, so a retry never
   * writes superseded text. `edit_due` stays set until an edit reached every target.
   */
  function closeView(rec, text) {
    rec.view = text;
    rec.edit_due = true;
  }
  /** An edit of a question's card copies: explicit targets, the view rendered when it runs. */
  const editFor = (rec, q) => ({ t: "edit", q, targets: (rec.copies ?? []).map((c) => ({ chat: c.chat, id: c.id })) });
  const retireStep = (messageId) => ({ t: "tg", method: "editMessageReplyMarkup", params: { message_id: messageId, reply_markup: { inline_keyboard: [] } } });
  /** The prompt a target button or an agent command opens: the reply goes to that agent, with `member` as to_member. */
  function promptStep(wire, member, replyId = null) {
    const l = labels([wire]).get(wire);
    return {
      t: "tg",
      method: "sendMessage",
      params: { text: TEXTS.prompt(l.full), ...replyParams(replyId), disable_notification: true, reply_markup: { force_reply: true, input_field_placeholder: cleanLabel(TEXTS.promptPlaceholder(l.label), 64) } },
      route: { name: wire, member, kind: "prompt" },
    };
  }

  /** Picker message kinds of state.targets: one picker at a time (a new one retires the others). */
  const PICKER_KINDS = new Set(["target", "lpage", "search"]);
  /** The held text of a "Who is this for?" picker, if it is still valid for this pairing and member. */
  function heldText(id, t = now()) {
    const h = id && Object.hasOwn(state.targets, id) ? state.targets[id] : null;
    return h?.kind === "hold" && t < h.exp && h.pairing === pid() && h.member === ownMember() ? h : null;
  }

  /**
   * The session picker (design 7.3, 2.1; phase-2 notes P3): /msg (mode "msg"), /agents ("agents")
   * and "Who is this for?" ("hold", with the held text's id). `view`: {kind: "first"} the first
   * screen; {kind: "page", page} a page of More…; {kind: "search", query, page} the matches. A page
   * turn edits its own message (`edit`); any other picker retires the older ones (a held text whose
   * picker is retired this way is dropped, and its picker says so).
   */
  async function listStep(entry, step, chat) {
    if (!chat) return {};
    let a;
    try {
      a = await ownAgents();
    } catch (e) {
      if (e instanceof NotLeader) throw e;
      return { wait: true };
    }
    const t = now();
    const mode = step.mode === "agents" || step.mode === "hold" ? step.mode : "msg";
    // The app's button on /msg and /agents (not in "Who is this for?": a tap there sends).
    const appButton = mode === "hold" ? null : ownerApp.button();
    const appRow = appButton ? [[appButton]] : [];
    const view = step.view ?? { kind: "first" };
    const hold = mode === "hold" ? heldText(step.hold, t) : null;
    if (mode === "hold" && !hold) return {}; // sent, cancelled or expired meanwhile
    let text;
    const sessions = []; // {name, text}
    const controls = []; // rows of {kind, ...}
    let keepHold = Boolean(hold);
    if (!a.attested) {
      // A name's shape proves nothing (a shared token may claim any name): no unconfirmed names.
      text = TEXTS.cannotList;
      keepHold = false;
    } else {
      const ppl = people();
      const L = labels(a.own.map((p) => p.name), ppl);
      const online = new Map(a.own.filter((p) => p.online).map((p) => [p.name, p]));
      const eligible = new Set([...a.own.map((p) => p.name), ...Object.keys(ppl).filter((n) => n !== name && !a.others.has(n) && NAME_RE.test(n))]);
      const e = (n) => (Object.hasOwn(ppl, n) ? ppl[n] : {});
      const by = (x, y) => {
        const lx = L.get(x).label.toLowerCase();
        const ly = L.get(y).label.toLowerCase();
        return lx < ly ? -1 : lx > ly ? 1 : x < y ? -1 : x > y ? 1 : 0;
      };
      const favs = [...eligible].filter((n) => e(n).fav);
      const favOrder = [...favs.filter((n) => online.has(n)).sort(by), ...favs.filter((n) => !online.has(n)).sort(by)];
      const recent = [...eligible]
        .filter((n) => !e(n).fav && !e(n).hidden && t - (Number(e(n).last_talked) || 0) < RECENT_MS)
        .sort((x, y) => (Number(e(y).last_talked) || 0) - (Number(e(x).last_talked) || 0) || by(x, y))
        .slice(0, RECENT_MAX);
      const seen = (n) => Number(e(n).first_seen) || t; // not recorded yet: just seen
      const rest = [...online.keys()].filter((n) => !e(n).fav && !e(n).hidden && !recent.includes(n)).sort((x, y) => seen(y) - seen(x) || by(x, y));
      const order = [...favOrder, ...recent, ...rest];
      const shown = (n) => {
        const l = L.get(n);
        const base = mode === "hold" ? l.full : l.label; // a tap in "Who is this for?" sends at once
        return online.has(n) ? base : TEXTS.away(base);
      };
      const head = mode === "hold" ? TEXTS.whoIsThisFor : mode === "agents" ? TEXTS.agentsHeader(favs.length, online.size) : TEXTS.pickAgent;
      // Cancel counts too, and so does the app's button.
      const firstMax = (mode === "hold" ? PICKER_FIRST - 1 : PICKER_FIRST) - appRow.length;
      const paged = (list, kind) => {
        const pages = Math.max(1, Math.ceil(list.length / PICKER_PAGE));
        const page = Math.min(Math.max(0, Number(view.page) || 0), pages - 1);
        for (const n of list.slice(page * PICKER_PAGE, (page + 1) * PICKER_PAGE)) sessions.push({ name: n, text: shown(n) });
        const nav = [];
        // A page of More…: Back on its first page goes back to the first screen.
        if (page > 0) nav.push({ kind: "lpage", view: { ...view, page: page - 1 }, text: TEXTS.backButton });
        else if (kind === "page") nav.push({ kind: "lpage", view: { kind: "first" }, text: TEXTS.backButton });
        if (page < pages - 1) nav.push({ kind: "lpage", view: { ...view, page: page + 1 }, text: TEXTS.nextButton });
        if (nav.length) controls.push(nav);
        return pages > 1 ? `\n${TEXTS.pendingPage(page + 1, pages)}` : "";
      };
      if (view.kind === "search") {
        const q = String(view.query ?? "").toLowerCase();
        const hit = (n) => [L.get(n).label, L.get(n).full, display(n), n, e(n).alias ?? ""].some((x) => String(x).toLowerCase().includes(q));
        // Hidden sessions too; online ones first.
        const found = [...eligible].filter(hit).sort((x, y) => Number(online.has(y)) - Number(online.has(x)) || by(x, y));
        if (!found.length) {
          text = TEXTS.searchNone(cleanLabel(view.query ?? "", 64));
          controls.push([{ kind: "search", text: TEXTS.searchButton }]);
        } else text = `${head}${paged(found, "search")}`;
      } else if (view.kind === "page") {
        text = `${head}${paged(order, "page")}`;
      } else {
        for (const n of order.slice(0, firstMax)) sessions.push({ name: n, text: shown(n) });
        const row = [];
        if (order.length > firstMax) row.push({ kind: "lpage", view: { kind: "page", page: 0 }, text: TEXTS.moreButton });
        if (eligible.size) row.push({ kind: "search", text: TEXTS.searchButton });
        if (row.length) controls.push(row);
        if (!online.size && (mode !== "agents" || !order.length)) text = mode === "agents" ? TEXTS.listEmpty : favOrder.length ? `${TEXTS.noneOnline}\n${TEXTS.favouritesBelow}` : TEXTS.noneOnline;
        else text = head;
        if (!order.length && mode === "agents" && eligible.size) text = head;
        if (!sessions.length && !row.length) keepHold = false; // nothing to pick: the held text goes
      }
    }
    if (hold && keepHold) controls.push([{ kind: "cancel", text: TEXTS.cancelButton }]);
    const buttons = [...sessions.map((x) => [{ ...x, kind: "target" }]), ...controls].map((row) => row.map((b) => ({ ...b, id: b.kind === "cancel" ? step.hold : tid() })));
    if (buttons.flat().length + appRow.length > MAX_BUTTONS) throw new Error(`a picker of ${buttons.flat().length + appRow.length} buttons`); // never: P3's budget
    const letter = { target: "t", lpage: "l", search: "f", cancel: "x" };
    const keyboard = { inline_keyboard: [...buttons.map((row) => row.map((b) => ({ text: cleanLabel(b.text), callback_data: `${letter[b.kind]}:${b.id}` }))), ...appRow] };
    const r = step.edit
      ? await tg("editMessageText", { chat_id: chat, message_id: step.edit, text, reply_markup: keyboard })
      : await tg("sendMessage", { chat_id: chat, text, ...replyParams(step.reply), disable_notification: true, ...(keyboard.inline_keyboard.length ? { reply_markup: keyboard } : {}) });
    if (r.wait) return { wait: true };
    if (!r.ok) return {};
    const msg = step.edit ?? r.result?.message_id;
    // One picker at a time: every older picker's buttons go (a page turn replaces its own), and a
    // held text whose picker is retired here is dropped, its picker saying so.
    const old = Object.entries(state.targets).filter(([k, x]) => (PICKER_KINDS.has(x.kind) && (x.msg !== msg || step.edit)) || (x.kind === "hold" && k !== step.hold && Number.isSafeInteger(x.msg) && x.msg !== msg));
    const heldOn = new Set(old.filter(([, x]) => x.kind === "hold").map(([, x]) => x.msg));
    const oldMessages = [...new Set(old.map(([, x]) => x.msg).filter((m) => Number.isSafeInteger(m) && m !== msg))];
    const retiring = oldMessages.map((m) => (heldOn.has(m) ? { t: "tg", method: "editMessageText", params: { message_id: m, text: TEXTS.cancelledNothingSent } } : retireStep(m)));
    return {
      ...(retiring.length ? { replace: [...retiring, ...entry.steps.slice(entry.next + 1)] } : {}),
      apply: () => {
        for (const [k] of old) delete state.targets[k];
        if (hold && state.targets[step.hold] === hold) {
          if (keepHold && Number.isSafeInteger(msg)) hold.msg = msg;
          else delete state.targets[step.hold];
        }
        if (Number.isSafeInteger(msg)) {
          const base = { member: ownMember(), pairing: step.pairing ?? null, msg, exp: t + TARGET_MS, mode, ...(hold && keepHold ? { hold: step.hold } : {}) };
          for (const b of buttons.flat()) {
            if (b.kind === "target") state.targets[b.id] = { kind: "target", name: b.name, ...base };
            else if (b.kind === "lpage") state.targets[b.id] = { kind: "lpage", view: b.view, ...base };
            else if (b.kind === "search") state.targets[b.id] = { kind: "search", ...base };
          }
        }
        capMap(state.targets, maxTargets);
        audit(home, "targeted", { list: sessions.length, mode }, t);
      },
    };
  }

  /**
   * The details screen of one session (design 7.3, 2.2; P5): its full name, online or away, the
   * host the relay reports (a hint), when the owner last talked with it, and its buttons. Edited
   * in place by its own buttons; one details screen at a time.
   */
  async function detailsStep(entry, step, chat) {
    if (!chat) return {};
    let a;
    try {
      a = await ownAgents();
    } catch (e) {
      if (e instanceof NotLeader) throw e;
      return { wait: true };
    }
    const t = now();
    const ppl = people();
    const e = Object.hasOwn(ppl, step.name) ? ppl[step.name] : {};
    const l = labels([step.name], ppl).get(step.name);
    const p = a.attested ? a.own.find((x) => x.name === step.name) : null;
    const line = [p?.online ? TEXTS.detailOnline : TEXTS.detailAway, typeof p?.host === "string" && p.host ? TEXTS.detailHost(cleanLabel(p.host, 64)) : "", e.last_talked ? TEXTS.detailTalked(ago(t - e.last_talked)) : TEXTS.detailNotTalked].join("");
    // A name now held from another host than its alias was saved with shows "Main? (claude-mac)".
    const head = l.moved && l.full.startsWith(`${l.alias} (`) ? `${l.alias}?${l.full.slice(l.alias.length)}` : l.moved ? `${l.full}?` : l.full;
    const text = [head, line, ...(e.hidden ? [TEXTS.detailHidden] : [])].join("\n");
    const buttons = [
      [
        { action: "msg", text: TEXTS.messageButton },
        e.fav ? { action: "unfav", text: TEXTS.unfavButton } : { action: "fav", text: TEXTS.favButton },
      ],
      [{ action: "rename", text: TEXTS.renameButton }, e.hidden ? { action: "unhide", text: TEXTS.unhideButton } : { action: "hide", text: TEXTS.hideButton }],
    ].map((row) => row.map((b) => ({ ...b, id: tid() })));
    const keyboard = { inline_keyboard: buttons.map((row) => row.map((b) => ({ text: b.text, callback_data: `d:${b.id}` }))) };
    const r = step.edit
      ? await tg("editMessageText", { chat_id: chat, message_id: step.edit, text, reply_markup: keyboard })
      : await tg("sendMessage", { chat_id: chat, text, ...replyParams(step.reply), disable_notification: true, reply_markup: keyboard });
    if (r.wait) return { wait: true };
    if (!r.ok) return {};
    const msg = step.edit ?? r.result?.message_id;
    const old = Object.entries(state.targets).filter(([, x]) => x.kind === "detail");
    const oldMessages = [...new Set(old.map(([, x]) => x.msg).filter((m) => Number.isSafeInteger(m) && m !== msg))];
    return {
      ...(oldMessages.length ? { replace: [...oldMessages.map(retireStep), ...entry.steps.slice(entry.next + 1)] } : {}),
      apply: () => {
        for (const [k] of old) delete state.targets[k];
        if (Number.isSafeInteger(msg)) for (const b of buttons.flat()) state.targets[b.id] = { kind: "detail", action: b.action, name: step.name, member: step.member, pairing: step.pairing ?? null, msg, exp: t + TARGET_MS };
        capMap(state.targets, maxTargets);
      },
    };
  }

  const emptyMenu = () => ({ chat: null, digest: null, at: 0, delete: [], commands: {} });

  /**
   * Refresh each command's set of names from the relay's attested list: add or renew every online
   * own agent's name, drop names past their hold. Fail-closed bound: nothing is evicted early; a
   * new command past the bound is not tracked, and a name that cannot join its command's set
   * blocks that command. Returns {eligible (null without attestation), changed}; throws when the
   * relay cannot list.
   */
  async function refreshMenu() {
    const a = await ownAgents();
    const m = (state.menu ??= emptyMenu());
    m.commands ??= {};
    if (!a.attested) return { eligible: null, changed: false };
    const t = now();
    let changed = false;
    for (const [cmd, c] of Object.entries(m.commands)) {
      // last_seen is renewed hourly, so a name stays at least MENU_HOLD_MS after it was last seen.
      for (const [n, seen] of Object.entries(c.names)) {
        if (t - seen > MENU_HOLD_MS + MENU_RENEW_MS) {
          delete c.names[n];
          changed = true;
        }
      }
      if (c.blocked_until && t >= c.blocked_until) {
        delete c.blocked_until;
        changed = true;
      }
      if (!Object.keys(c.names).length && !c.blocked_until) {
        delete m.commands[cmd];
        changed = true;
      }
    }
    let names = Object.values(m.commands).reduce((n, c) => n + Object.keys(c.names).length, 0);
    // Every online own agent joins its command's set (so a collision is seen), and so does every
    // favourite, online or not (phase 2: the menu holds favourites only, P9).
    const ppl = people();
    const online = a.own.filter((p) => p.online);
    const favs = Object.keys(ppl).filter((n) => ppl[n].fav && n !== name && NAME_RE.test(n) && !a.others.has(n) && !online.some((p) => p.name === n));
    const eligible = [...online, ...favs.map((n) => ({ name: n, online: false }))];
    for (const p of eligible) {
      const cmd = commandOf(display(p.name));
      if (!cmd) continue;
      const c = m.commands[cmd];
      if (c && Object.hasOwn(c.names, p.name)) {
        if (t - c.names[p.name] >= MENU_RENEW_MS) {
          c.names[p.name] = t;
          changed = true;
        }
      } else if (names >= MAX_TRACKED_NAMES || (!c && Object.keys(m.commands).length >= MAX_TRACKED_COMMANDS)) {
        if (c && !(c.blocked_until > t)) {
          c.blocked_until = t + MENU_HOLD_MS;
          changed = true;
        }
      } else {
        if (c) c.names[p.name] = t;
        else m.commands[cmd] = { names: { [p.name]: t } };
        names++;
        changed = true;
      }
    }
    // The first time the bridge saw each name online ("Online now" sorts by it, newest first).
    touch(
      online.map((p) => p.name),
      "first_seen",
      { keep: true },
    );
    return { eligible, changed };
  }

  /** A received agent command, through the issued sets only: {name} | {ambiguous} | {none}. */
  function resolveCommand(cmd) {
    const c = Object.hasOwn(state.menu?.commands ?? {}, cmd) ? state.menu.commands[cmd] : null;
    if (!c) return { none: true };
    const names = Object.keys(c.names);
    if (c.blocked_until > now() || names.length !== 1) return { ambiguous: true };
    return { name: names[0] };
  }

  /**
   * The chat-scoped command menu: pending deletions first (a chat the menu no longer belongs to),
   * then the static commands and one per unambiguous own agent, registered when they changed.
   * A failure waits for the next check; it never blocks the outbox.
   */
  async function menuWork(force = false) {
    if (draining || !leading()) return;
    const t = now();
    if ((!force && t - lastMenuCheck < menuCheckMs) || t < backoffUntil) return;
    lastMenuCheck = t;
    const m = (state.menu ??= emptyMenu());
    m.delete ??= [];
    const p = pairing();
    if (m.chat != null && m.chat !== (p?.chat_id ?? null)) {
      if (!m.delete.includes(m.chat)) m.delete.push(m.chat);
      Object.assign(m, { chat: null, digest: null });
      save("menu");
    }
    for (const chat of [...m.delete]) {
      if (chat === p?.chat_id) {
        m.delete = m.delete.filter((c) => c !== chat); // set again below
        save("menu");
        continue;
      }
      const r = await tg("deleteMyCommands", { scope: { type: "chat", chat_id: chat } });
      if (r.wait) return; // kept; tried again at the next check
      if (!r.ok) {
        // Not confirmed: kept and tried again at each check (logged once per run and chat).
        if (!deleteRefused.has(chat)) log(`owner channel: Telegram deleteMyCommands refused: ${r.error.message}; tried again at each check`);
        deleteRefused.add(chat);
        continue;
      }
      m.delete = m.delete.filter((c) => c !== chat);
      save("menu");
      audit(home, "menu", { deleted: 1 }, now());
    }
    if (!p) return;
    let res;
    try {
      res = await refreshMenu();
    } catch (e) {
      if (e instanceof NotLeader) throw e;
      return;
    }
    const agents = [];
    let ambiguous = 0;
    const ppl = people();
    const favs = (res.eligible ?? []).filter((e) => Object.hasOwn(ppl, e.name) && ppl[e.name].fav);
    const L = labels(
      favs.map((e) => e.name),
      ppl,
    );
    for (const e of favs) {
      const cmd = commandOf(display(e.name));
      if (!cmd) continue;
      const r = resolveCommand(cmd);
      if (r.name === e.name) agents.push({ command: cmd, description: cleanLabel(`Message ${L.get(e.name).label}`, 256), name: e.name });
      else if (r.ambiguous) ambiguous++;
    }
    agents.sort((x, y) => (x.command < y.command ? -1 : x.command > y.command ? 1 : 0)); // by command, as the menu shows them
    const fixed = ownerApp.available() ? [...STATIC_COMMANDS, APP_COMMAND] : STATIC_COMMANDS;
    const commands = [...fixed, ...agents.slice(0, MAX_COMMANDS - fixed.length).map(({ command, description }) => ({ command, description }))];
    const d = digest(JSON.stringify([p.chat_id, commands]));
    if (d === m.digest && m.chat === p.chat_id) {
      if (res.changed) save("menu");
      return;
    }
    // The chat is recorded before the call: a list Telegram may have set is always deleted later.
    m.chat = p.chat_id;
    save("menu");
    const r = await tg("setMyCommands", { commands, scope: { type: "chat", chat_id: p.chat_id } });
    if (r.wait) return;
    if (!r.ok) {
      log(`owner channel: Telegram setMyCommands refused: ${r.error.message}`);
      return;
    }
    Object.assign(m, { digest: d, at: now() });
    save("menu");
    audit(home, "menu", { commands: commands.length - fixed.length, ambiguous }, now());
  }

  /** A Bot API call of this generation: aborted on loss or stop, its result then never used. */
  async function tg(method, params) {
    // The pairing may have changed while the running step waited (on the relay, for example).
    if (running && stale(running)) throw new StaleStep();
    return tgCall(method, params);
  }
  /** tg() without the outbox runner's step check: the app runner checks its own entries. */
  async function tgCall(method, params) {
    ensureLeader();
    const mine = gen;
    // Every text the bridge sends is plain (no parse_mode), cut to Telegram's limit, and without a
    // link preview: agent text must not make Telegram fetch a URL of the agent's choice.
    if (method === "sendMessage" || method === "editMessageText") params = { ...params, text: fit(params.text), link_preview_options: { is_disabled: true } };
    let result;
    try {
      result = await telegram[method](params, { signal: sideAc?.signal ?? null });
    } catch (e) {
      stillLeading(mine);
      if (Number.isFinite(e?.retryAfter) && e.retryAfter > 0) backoffUntil = Math.max(backoffUntil, now() + Math.min(e.retryAfter, 3600) * 1000);
      if (e?.status === 400 || e?.status === 403) return { ok: false, error: e }; // refused for good: redoing it would not help
      return { wait: true, error: e }; // 429, 5xx, network, or anything else: tried again later
    }
    stillLeading(mine);
    return { ok: true, result };
  }

  async function runStep(entry, step) {
    const chat = pairing()?.chat_id;
    switch (step.t) {
      case "send":
        return sendStep(entry, step);
      case "tg": {
        if (!chat) return {};
        // answerCallbackQuery takes no chat_id; everything else goes to the paired chat.
        const r = await tg(step.method, step.method === "answerCallbackQuery" ? step.params : { chat_id: chat, ...step.params });
        if (r.wait) return { wait: true };
        if (!r.ok) {
          log(`owner channel: Telegram ${step.method} refused: ${r.error.message}`);
          return {};
        }
        // A message that names one agent becomes a reply route; a confirm button learns its message.
        const id = r.result?.message_id;
        if (!Number.isSafeInteger(id)) return {};
        return {
          apply: () => {
            if (step.route) addRoute(id, { ...step.route, pairing: step.pairing ?? null, chat });
            if (step.bind && state.targets[step.bind]) state.targets[step.bind].msg = id;
          },
        };
      }
      case "list":
        return listStep(entry, step, chat);
      case "details":
        return detailsStep(entry, step, chat);
      case "menu":
        // The menu never holds up an update: a failure waits for the next check.
        try {
          await menuWork(true);
        } catch (e) {
          if (e instanceof NotLeader || e instanceof Crash) throw e;
          log("owner channel: the command menu could not be updated:", e.message);
        }
        return {};
      case "edit": {
        // Every target copy, at the chat it was sent to (never the current chat with an old id),
        // with the question's current view.
        const rec = state.questions[step.q];
        if (!rec?.view) return {};
        // The paired chat's copies first (they may have to wait and be retried); every other chat's
        // copy gets its one best-effort try only after those, so a retry never repeats it.
        const targets = [...(step.targets ?? [])].sort((a, b) => Number(b.chat === chat) - Number(a.chat === chat));
        for (const c of targets) if ((await editCopy(c.chat, c.id, rec.view, chat)) === "wait") return { wait: true };
        return { apply: () => (rec.edit_due = false) }; // a redone edit is harmless; a refused one is left
      }
      case "editcopy": {
        if ((await editCopy(step.chat, step.id, step.text, chat)) === "wait") return { wait: true };
        const rec = step.q ? state.questions[step.q] : null;
        return rec?.retiring ? { apply: () => (rec.retiring = rec.retiring.filter((c) => !(c.chat === step.chat && c.id === step.id))) } : {};
      }
      case "card":
        return cardStep(entry, step, chat);
      case "notice":
        return noticeStep(entry, step, chat);
      case "react":
        return reactStep(entry, step, chat);
      case "pending":
        return pendingStep(entry, step, chat);
      default:
        return {};
    }
  }

  /** Edit one copy: retried while it is in the paired chat; one best-effort try in any other chat. */
  async function editCopy(target, id, text, chat) {
    if (!Number.isSafeInteger(id) || target == null) return "done";
    const r = await tg("editMessageText", { chat_id: target, message_id: id, text });
    return r.wait && chat != null && target === chat ? "wait" : "done";
  }

  /**
   * A send to be tried again. When Telegram answered with an HTTP error (429, 5xx), it did not take
   * the message, so the next try is not marked "sent again" (saved with the next write); after a
   * network error the outcome is unknown and the mark stays.
   */
  function notTaken(step, resent, r) {
    if (!resent && Number.isInteger(r.error?.status)) step.attempted = false;
    return { wait: true };
  }

  /** A question's card, the first copy or another one (a crash retry, a re-pair, "Show"). */
  async function cardStep(entry, step, chat) {
    const rec = state.questions[step.q];
    if (!rec || (rec.status !== "pending" && rec.status !== "open") || !rec.payload) return {}; // closed meanwhile
    if (!chat) return { wait: true }; // not paired yet: the card waits (the question expires normally)
    const p = pid();
    const resent = cardBegin(step, rec);
    await refreshNames();
    const { text, markup } = cardRender(rec, step, resent);
    const r = await tg("sendMessage", { chat_id: chat, text, reply_markup: markup, ...(step.show ? { disable_notification: true } : {}) });
    if (r.wait) return notTaken(step, resent, r);
    hit("card-sent");
    if (!r.ok) {
      if (rec.copies?.length) {
        log(`owner channel: another copy of the card for ${short(step.q)} was refused: ${r.error.message}`); // the earlier copies stand
        return {};
      }
      // Refused for good (400, 403): Q closes as `undeliverable` and the asker is told, in one write.
      log(`owner channel: the card for ${short(step.q)} was refused: ${r.error.message}`);
      return {
        replace: [statusStep(rec, step.q, "undeliverable", `undeliverable: your question ${step.q} could not be shown to your owner (Telegram refused it).`)],
        apply: () => {
          Object.assign(rec, { status: "undeliverable", payload: null, closed_at: now() });
          audit(home, "refused", { reason: "card_refused", q: step.q }, now());
        },
      };
    }
    const { over, apply } = cardDone(step, rec, r.result?.message_id, chat, p);
    return {
      // Past the cap the oldest copy loses its buttons and says so, before its id is dropped.
      // It stays in rec.retiring until that edit has had its outcome (a re-pair queues it again).
      ...(over ? { replace: [{ t: "editcopy", q: step.q, chat: over.chat, id: over.id, text: TEXTS.olderCopy }, ...entry.steps.slice(entry.next + 1)] } : {}),
      apply,
    };
  }
  /** Before a card is sent: recorded first, so a crash-lost copy's buttons still answer. Whether it is sent again. */
  function cardBegin(step, rec) {
    const resent = Boolean(step.attempted);
    if (!resent) {
      step.attempted = true;
      rec.pairing = pid();
      save("card-attempt");
    }
    return resent;
  }
  /** A card's text and buttons. */
  function cardRender(rec, step, resent) {
    const who = labelOf(rec.asker.name);
    const head = resent ? TEXTS.cardResent(rec.num, who) : step.again === "repair" ? TEXTS.cardRepaired(rec.num, who) : TEXTS.card(rec.num, who);
    const markup = rec.payload.choices.length
      ? { inline_keyboard: rec.payload.choices.map((c, i) => [{ text: cleanLabel(c, 40), callback_data: `a:${rec.qid}:${i}` }]) }
      : { force_reply: true, input_field_placeholder: "Your answer" };
    const text = `${head}\n${rec.payload.question}${rec.payload.choices.length ? "" : `\n\n${TEXTS.cardReplyHint}`}`;
    return { text, markup };
  }
  /**
   * A card Telegram accepted: one write records the copy (its chat and message id), opens the
   * question, keeps a route to its asker (a reply after it closed, even after its record is gone).
   * `over`: the oldest copy, past the cap, which must lose its buttons.
   */
  function cardDone(step, rec, id, chat, p) {
    const copies = rec.copies ?? [];
    const open = rec.status === "open" || rec.status === "pending";
    const over = open && Number.isSafeInteger(id) && copies.length + 1 > MAX_CARD_COPIES ? copies[0] : null;
    return {
      over,
      apply: () => {
        if (rec.status !== "open" && rec.status !== "pending") {
          // Closed while this copy was on its way (answered, expired, cancelled): it never reopens
          // the question. The copy is recorded (a reply to it gets the closed answer) and is edited
          // to the closed view, without buttons.
          if (!Number.isSafeInteger(id)) return;
          rec.copies = [...(rec.copies ?? []), { chat, id }];
          // Its reply route outlives the record, as an ordinary copy's does.
          addRoute(id, { name: rec.asker.name, member: rec.asker.member, kind: "card", pairing: p, chat, q: step.q });
          admit({ kind: "q", q: step.q, steps: [{ t: "editcopy", q: step.q, chat, id, text: rec.view ?? closedText(rec.status) }], next: 0 });
          return;
        }
        rec.copies = copies;
        if (over) {
          copies.shift();
          rec.retiring = [...(rec.retiring ?? []), over];
          delete state.routes[String(over.id)];
        }
        if (Number.isSafeInteger(id)) {
          copies.push({ chat, id });
          addRoute(id, { name: rec.asker.name, member: rec.asker.member, kind: "card", pairing: p, chat, q: step.q });
        }
        Object.assign(rec, { status: "open", pairing: p });
      },
    };
  }

  /** A note from an agent (design 7.3, section 3): shown once, plain, with a reply route unless one-way. */
  async function noticeStep(entry, step, chat) {
    if (!chat) return {}; // unpaired since it was admitted: not shown
    const resent = Boolean(step.attempted);
    if (!resent) {
      step.attempted = true;
      save("notice-attempt");
    }
    await refreshNames();
    const who = labelOf(step.name);
    const head = step.oneWay ? TEXTS.noticeOneWay(who) : resent ? TEXTS.noticeResent(who) : TEXTS.notice(who);
    const r = await tg("sendMessage", { chat_id: chat, text: `${head}\n${step.text}`, ...replyParams(step.thread), ...(step.notify ? {} : { disable_notification: true }) });
    if (r.wait) return notTaken(step, resent, r);
    hit("notice-sent");
    if (!r.ok) {
      log(`owner channel: a note from ${step.name} was refused: ${r.error.message}`);
      return {};
    }
    const id = r.result?.message_id;
    touch([step.name], "last_talked");
    return {
      apply: () => {
        if (!step.oneWay && Number.isSafeInteger(id)) addNoticeRoute(id, { name: step.name, member: step.member, pairing: step.pairing, chat });
        audit(home, "noticed", { from: step.name, length: step.text.length, digest: digest(step.text), ...(step.oneWay ? { one_way: true } : {}) }, now());
      },
    };
  }

  /** 👍 on the owner's message once it was sent; that message becomes its reply route (design 7.3, 2.5). */
  async function reactStep(entry, step, chat) {
    if (!chat) return {};
    const r = await tg("setMessageReaction", { chat_id: chat, message_id: step.msg, reaction: [{ type: "emoji", emoji: "👍" }] });
    if (r.wait) return { wait: true };
    // A saved name (no agent to continue with): the 👍 alone, or a silent "Saved.".
    if (!step.route) return r.ok ? {} : { replace: [{ t: "tg", method: "sendMessage", params: { text: TEXTS.saved, ...replyParams(step.msg), disable_notification: true } }, ...entry.steps.slice(entry.next + 1)] };
    const route = { ...step.route, kind: "sent", pairing: step.pairing ?? null, chat };
    if (!r.ok) {
      // Telegram refused the reaction: a silent text instead, itself a reply route too.
      return {
        replace: [{ t: "tg", method: "sendMessage", params: { text: TEXTS.sentTo(labelOf(step.route.name)), ...replyParams(step.msg), disable_notification: true }, route: step.route }, ...entry.steps.slice(entry.next + 1)],
        apply: () => addRoute(step.msg, route),
      };
    }
    return { apply: () => addRoute(step.msg, route) };
  }

  /** /pending (C18): one page of open questions, oldest first, with a Show button each and paging. */
  async function pendingStep(entry, step, chat) {
    if (!chat) return {};
    await refreshNames();
    const t = now();
    const open = Object.entries(state.questions)
      .filter(([, r]) => (r.status === "open" || r.status === "pending") && r.payload)
      .sort(([, a], [, b]) => a.created - b.created || (a.num ?? 0) - (b.num ?? 0));
    const pages = Math.max(1, Math.ceil(open.length / PENDING_PAGE));
    const page = Math.min(Math.max(0, Number(step.page) || 0), pages - 1);
    const items = open.slice(page * PENDING_PAGE, (page + 1) * PENDING_PAGE);
    const buttons = [];
    let text = TEXTS.pendingNone;
    if (open.length) {
      const lines = items.map(([, r]) => TEXTS.pendingLine(r.num, labelOf(r.asker.name), fit(cleanLabel(r.payload.question, 4000), EXCERPT), ago(t - r.created)));
      text = [TEXTS.pendingHeader, ...lines, ...(pages > 1 ? [TEXTS.pendingPage(page + 1, pages)] : [])].join("\n");
      for (const [q, r] of items) buttons.push([{ id: tid(), kind: "show", q, text: TEXTS.showButton(r.num) }]);
      const nav = [];
      if (page > 0) nav.push({ id: tid(), kind: "page", page: page - 1, text: TEXTS.backButton });
      if (page < pages - 1) nav.push({ id: tid(), kind: "page", page: page + 1, text: TEXTS.nextButton });
      if (nav.length) buttons.push(nav);
    }
    const letter = { show: "s", page: "p" };
    const appButton = ownerApp.button();
    const keyboard = { inline_keyboard: [...buttons.map((row) => row.map((b) => ({ text: b.text, callback_data: `${letter[b.kind]}:${b.id}` }))), ...(appButton ? [[appButton]] : [])] };
    const r = step.edit
      ? await tg("editMessageText", { chat_id: chat, message_id: step.edit, text, reply_markup: keyboard })
      : await tg("sendMessage", { chat_id: chat, text, ...replyParams(step.reply), disable_notification: true, ...(keyboard.inline_keyboard.length ? { reply_markup: keyboard } : {}) });
    if (r.wait) return { wait: true };
    if (!r.ok) return {};
    const msg = step.edit ?? r.result?.message_id;
    // One /pending list at a time: a new list retires the older one; a page turn replaces its own buttons.
    const old = Object.entries(state.targets).filter(([, x]) => (x.kind === "show" || x.kind === "page") && (!step.edit || x.msg === step.edit));
    const oldMessages = step.edit ? [] : [...new Set(old.map(([, x]) => x.msg).filter((m) => Number.isSafeInteger(m) && m !== msg))];
    return {
      ...(oldMessages.length ? { replace: [...oldMessages.map(retireStep), ...entry.steps.slice(entry.next + 1)] } : {}),
      apply: () => {
        for (const [k] of old) delete state.targets[k];
        if (Number.isSafeInteger(msg)) {
          for (const b of buttons.flat()) state.targets[b.id] = { kind: b.kind, ...(b.kind === "show" ? { q: b.q } : { page: b.page }), member: ownMember(), pairing: step.pairing ?? null, msg, exp: t + TARGET_MS };
        }
        capMap(state.targets, maxTargets);
      },
    };
  }

  /** The owner-facing text of a refused send (the E-table). */
  const refusalText = (reason, who) =>
    ({ relay_without_to_member: TEXTS.needsUpdate, unknown_peer: TEXTS.noSuchAgent(who), recipient_member_mismatch: TEXTS.notYours(who), relay_refused: TEXTS.serverRefused, [ENCRYPTION_REQUIRED]: TEXTS.encryptionRequired })[reason] ?? TEXTS.serverRefused;

  /**
   * A send the relay refused for good: the steps that depended on its success (the 👍, the
   * answered card, "Sent.") are replaced by what `step.fail` asks for, and an answer's question
   * closes as `undelivered`; all in the write that marks this step done.
   */
  function refusedSend(step, reason) {
    const f = step.fail ?? null;
    const who = labelOf(step.to.name);
    const text = refusalText(reason, who);
    const steps = [];
    const rec = step.kind === "answer" ? state.questions[step.q] : null;
    if (f?.edit && rec) steps.push(editFor(rec, step.q));
    if (f?.ack) steps.push({ t: "tg", method: "answerCallbackQuery", params: { callback_query_id: f.ack, text: text.slice(0, 200), show_alert: true } });
    else if (f) steps.push({ t: "tg", method: "sendMessage", params: { text, ...replyParams(f.reply), disable_notification: true }, ...(step.kind === "instruction" ? { route: { name: step.to.name, member: step.to.member, kind: "refused" } } : {}) });
    return {
      replace: steps,
      apply: () => {
        if (rec) {
          Object.assign(rec, { status: "undelivered", closed_at: now() });
          if (f?.edit) closeView(rec, TEXTS.undelivered(f.edit.n, who, f.edit.question, (UNDELIVERED_REASONS[reason] ?? UNDELIVERED_REASONS.relay_refused)(who)));
        }
        audit(home, "refused", { reason, kind: step.kind, ...(step.q ? { q: step.q } : {}) }, now());
      },
    };
  }

  async function sendStep(entry, step) {
    // The app proposes, the chat decides (design 7.4, section 1): nothing an app request admitted is
    // ever signed. An entry of app origin may hold only Telegram steps and the prefs step.
    if (entry.origin === "a") {
      count("app_origin");
      audit(home, "refused", { reason: "app_origin", kind: step.kind }, now());
      return {};
    }
    const refused = plaintextRefused();
    // Not sent: tried again once the policy can be read; a drain (unpair --all) refuses it for good.
    if (refused === "unreadable") return draining ? refusedSend(step, ENCRYPTION_REQUIRED) : { wait: true };
    if (refused) return encryptionRefused(step);
    // The handoff hint (2.8, P8): checked at every dispatch, also after a wait.
    if (step.host_check && step.kind === "instruction") {
      const w = await hostWarning(step);
      if (w) return w;
      // The pairing and the encryption policy may have changed while the host was checked: both
      // checked again, with nothing awaited between here and the send.
      if (running && stale(running)) throw new StaleStep();
      const again = plaintextRefused();
      if (again === "unreadable") return draining ? refusedSend(step, ENCRYPTION_REQUIRED) : { wait: true };
      if (again) return encryptionRefused(step);
    }
    const p = pairing();
    ensureLeader();
    const mine = gen;
    const envelope = signEnvelope({ kind: step.kind, realm: relay.realm.id, from: name, to: step.to, ...(step.q ? { q: step.q } : {}), text: step.text, pairing: p ? { id: p.id, at: p.at } : UNPAIRED, ts: now(), nonce: step.nonce }, key);
    let ack;
    try {
      ack = await relay.send(step.to.name, envelope, step.ttl ?? MAX_TTL_S, step.q ?? undefined, { toMember: step.to.member, retryMs: 10_000 });
    } catch (e) {
      stillLeading(mine);
      if (e.code === "no_to_member") return refusedSend(step, "relay_without_to_member");
      if (e.kind === "relay_error") return refusedSend(step, e.code === "recipient_member_mismatch" ? "recipient_member_mismatch" : /unknown peer/.test(e.message) ? "unknown_peer" : "relay_refused");
      return { wait: true }; // not sent, or its outcome unknown: redone later with the same nonce
    }
    stillLeading(mine);
    hit("sent");
    if (state.encryptionNotice) delete state.encryptionNotice; // saved with this step: a later refusal is told again
    audit(home, step.kind === "status" ? "status" : step.kind === "answer" ? "answered" : "instructed", { to: step.to.name, ...(step.q ? { q: step.q } : {}), length: step.text.length, digest: digest(step.text) }, now());
    if (step.kind === "status") return {};
    touch([step.to.name], "last_talked");
    // The notification rule's input: when the owner last wrote to this agent.
    // Threading: the relay's id of this instruction, for a note that replies to it. A relay
    // without message ids, or an ack lost to a crash, leaves no entry: such a note is unthreaded.
    const ref = typeof ack?.message_id === "string" && REF_RE.test(ack.message_id) ? ack.message_id.toLowerCase() : null;
    const src = [step.src, step.fail?.reply].find((x) => Number.isSafeInteger(x)) ?? null;
    return {
      apply: () => {
        state.last_sent[step.to.name] = now();
        const names = Object.keys(state.last_sent);
        if (names.length > MAX_LAST_SENT) for (const n of names.sort((a, b) => state.last_sent[a] - state.last_sent[b]).slice(0, names.length - MAX_LAST_SENT)) delete state.last_sent[n];
        if (step.kind === "instruction" && ref) {
          state.sent[ref] = { name: step.to.name, member: step.to.member, pairing: step.pairing ?? null, msg: src, exp: now() + SENT_MS };
          capMap(state.sent, MAX_SENT);
        }
      },
    };
  }

  /**
   * The host check (design 7.3, 2.8; phase-2 notes P8), run right before an instruction that
   * follows a tap or a reply goes out (every dispatch, also after a wait): when its name has an
   * alias saved with a host (`alias_host`, read now, so "Send and remember" applies to older
   * controls too) and the relay reports another host for it now, nothing is sent; the text is held
   * (HOLD_MS) behind Send, Send and remember, and Cancel. A one-use override (`override.host`,
   * from Send) lets exactly this step through while the host is still the one it was given for.
   * Offline names (no host now) are not checked. A hint for the owner, not a boundary: that stays
   * to_member. Returns null to go on, or the step's outcome.
   */
  async function hostWarning(step) {
    const ppl = people();
    const e = Object.hasOwn(ppl, step.to.name) ? ppl[step.to.name] : null;
    if (!e?.alias || !e.alias_host) return null;
    let a;
    try {
      a = await ownAgents();
    } catch (err) {
      if (err instanceof NotLeader) throw err;
      return { wait: true }; // the host cannot be checked now: tried again later
    }
    const p = a.attested ? a.own.find((x) => x.name === step.to.name && x.online) : null;
    const host = typeof p?.host === "string" && p.host ? p.host : null;
    if (!host || host === e.alias_host || step.override?.host === host) return null;
    const id = tid();
    const reply = step.src ?? step.fail?.reply ?? null;
    return {
      replace: [
        ...(step.fail?.ack ? [{ t: "tg", method: "answerCallbackQuery", params: { callback_query_id: step.fail.ack } }] : []),
        ...(Number.isSafeInteger(step.picker) ? [retireStep(step.picker)] : []),
        {
          t: "tg",
          method: "sendMessage",
          params: {
            text: TEXTS.hostMoved(fullOf(step.to.name), cleanLabel(host, 64), cleanLabel(e.alias_host, 64)),
            ...replyParams(reply),
            disable_notification: true,
            reply_markup: { inline_keyboard: [[{ text: TEXTS.sendButton, callback_data: `h:${id}` }, { text: TEXTS.sendRememberButton, callback_data: `r:${id}` }], [{ text: TEXTS.cancelButton, callback_data: `x:${id}` }]] },
          },
          bind: id,
        },
      ],
      apply: () => {
        state.targets[id] = { kind: "hostwarn", name: step.to.name, member: step.to.member, text: step.text, host, ...(Number.isSafeInteger(reply) ? { src: reply } : {}), pairing: step.pairing ?? null, msg: null, exp: now() + HOLD_MS };
        capMap(state.targets, maxTargets);
        audit(home, "host_warned", { to: step.to.name }, now());
      },
    };
  }

  /**
   * A send refused because the policy for the bridge's own member is "required": a terminal outcome
   * (reason encryption_required) in the write that marks the step done, like any refused send.
   * Answers and instructions tell the owner through their own `fail` steps (the owner acted, so
   * each one gets its answer); automatic statuses get one general notice, sent once until a send
   * succeeds again (state.encryptionNotice).
   */
  function encryptionRefused(step) {
    const r = refusedSend(step, ENCRYPTION_REQUIRED);
    if (step.fail || state.encryptionNotice) return r;
    r.replace = [...r.replace, { t: "tg", method: "sendMessage", params: { text: TEXTS.encryptionPaused } }];
    const apply = r.apply;
    r.apply = () => {
      apply();
      state.encryptionNotice = true;
    };
    return r;
  }

  // ---- questions and notes from agents (Q side) --------------------------------------------

  const statusStep = (rec, q, what, text) => ({ t: "send", kind: "status", to: { name: rec.asker.name, member: rec.asker.member }, q, text, nonce: nonceOf(key, [what, botId, q]) });

  // Statuses about notes not shown (agent-facing, design 7.3 section 3).
  const NOTICE_STATUS = {
    reserved: 'not shown: a note that starts with "{" must be valid JSON without hoptell fields; write plain text.',
    rate: "not shown: your owner's Telegram is receiving too many messages from you; send fewer, or use ask_owner for a question.",
    unpaired: "not shown: your owner has not connected Telegram yet.",
    hidden: "not shown: your owner has hidden this session.",
  };

  function onMessage(m, confirm) {
    serial(async () => {
      if (!leading()) return; // unconfirmed: the relay delivers it again
      reconciled();
      const q = typeof m.message_id === "string" ? m.message_id.toLowerCase() : null;
      const own = relay.member?.id;
      // Only the bridge's own member, signed in with its member token, may ask or write.
      if (m.sender?.auth !== "member" || !own || m.sender.member?.id !== own || m.sender.custody === "hosted") {
        count("not_own_member");
        save("drop");
        return confirm();
      }
      // Direct only: a copy of an @all or role fan-out keeps its `to` and is not for the bridge.
      if (m.to !== name) {
        count("not_direct");
        save("drop");
        return confirm();
      }
      if (!q || !REF_RE.test(q) || !NAME_RE.test(m.from ?? "")) {
        count("no_reference");
        save("drop");
        return confirm();
      }
      // A redelivery (same reference): acknowledge it and resume its record; nothing extra.
      if (state.questions[q] || Object.hasOwn(state.notices_seen, q) || state.outbox.some((e) => e.kind === "n" && e.id === q)) {
        confirm();
        return runOutbox();
      }
      const body = parseQuestion(m.text);
      return body ? question(m, q, body, own, confirm) : notice(m, q, own, confirm);
    });
  }

  function question(m, q, body, own, confirm) {
    const t = now();
    const rec = { q, qid: b32(12, "abcdefghijklmnopqrstuvwxyz234567"), num: (state.card_seq = (state.card_seq ?? 0) + 1), asker: { name: m.from, realm: relay.realm.id, member: own }, alias, asked_at: body.asked_at, expires_at: body.expires_at, status: "pending", copies: [], pairing: null, shows: {}, payload: { question: body.question, choices: body.choices }, created: t };
    let entry;
    if (t >= body.expires_at) {
      Object.assign(rec, { status: "expired", payload: null, closed_at: t });
      entry = { kind: "q", q, steps: [statusStep(rec, q, "late", `expired: your question ${q} arrived after its expiry time and was not shown to your owner.`)], next: 0 };
    } else {
      state.recent = (state.recent ?? []).filter((x) => t - x < 3600_000);
      const open = Object.values(state.questions).filter((r) => (r.status === "pending" || r.status === "open") && r.asker.name === m.from && r.asker.member === own).length;
      if (open >= OPEN_PER_ASKER || state.recent.length >= NEW_PER_HOUR) {
        Object.assign(rec, { status: "refused", payload: null, closed_at: t });
        entry = { kind: "q", q, steps: [statusStep(rec, q, "rate", `refused: rate. Your owner channel takes at most ${OPEN_PER_ASKER} open questions per agent and ${NEW_PER_HOUR} new questions per hour; ask again later.`)], next: 0 };
        audit(home, "refused", { reason: "rate", q }, t);
      } else {
        state.recent.push(t);
        entry = { kind: "q", q, steps: [{ t: "card", q }], next: 0 };
        audit(home, "asked", { q, from: m.from, length: body.question.length, digest: digest(body.question), choices: body.choices.length }, t);
      }
    }
    hit("q-commit");
    state.questions[q] = rec;
    admit(entry);
    save("question");
    hit("q-before-ack");
    confirm(); // only after the record is durable
    if (rec.status === "pending") touch([m.from], "last_talked");
    return runOutbox();
  }

  /** At most one status about notes per agent per hour, so a loop cannot make the bridge an amplifier. */
  function noticeStatus(to, member, q, text, t) {
    const r = state.notice_rate;
    if (t - (r.statused[to] ?? -Infinity) < LIMITS.statusEveryMs) return;
    r.statused[to] = t;
    admit({ kind: "n", id: q, steps: [{ t: "send", kind: "status", to: { name: to, member }, q, text, nonce: nonceOf(key, ["notice", botId, q]) }], next: 0 });
  }

  /** Whether a note from `from` is over budget now; admits it to the counts when it is not. */
  function noticeOverBudget(from, t) {
    const r = state.notice_rate;
    const L = LIMITS;
    const hour = (r.agents[from] ?? []).filter((x) => t - x < L.perAgentHour.ms);
    r.all = r.all.filter((x) => t - x < L.allHour.ms);
    const overAgent = hour.filter((x) => t - x < L.perAgentShort.ms).length >= L.perAgentShort.max || hour.length >= L.perAgentHour.max;
    const overAll = r.all.length >= L.allHour.max;
    if (!overAgent && !overAll) {
      r.agents[from] = [...hour, t];
      r.all.push(t);
      return false;
    }
    r.agents[from] = hour;
    // One line in the chat, once per agent per hour (and once per hour for all agents together).
    const k = overAgent ? `a:${from}` : "*";
    if (!(t - (r.warned[k] ?? -Infinity) < L.warnEveryMs)) {
      r.warned[k] = t;
      admit({ kind: "n", id: null, steps: [{ t: "tg", method: "sendMessage", params: { text: TEXTS.noticeFlood(labelOf(from)), disable_notification: true } }], next: 0 });
    }
    return true;
  }

  function notice(m, q, own, confirm) {
    const t = now();
    const from = m.from;
    const oneWay = m.noReply === true; // a standalone `hoptell send`: no session to answer
    const seen = () => {
      state.notices_seen[q] = t;
      const ids = Object.keys(state.notices_seen);
      if (ids.length > MAX_NOTICE_SEEN) for (const k of ids.sort((a, b) => state.notices_seen[a] - state.notices_seen[b]).slice(0, ids.length - MAX_NOTICE_SEEN)) delete state.notices_seen[k];
    };
    const drop = (reason, statusText = null) => {
      count(reason);
      seen();
      if (statusText && !oneWay) noticeStatus(from, own, q, statusText, t);
      hit("n-commit");
      save("drop");
      confirm();
      return runOutbox();
    };
    // Reserved, fail closed: never shown raw (a question is handled above).
    if (typeof m.text !== "string") return drop("malformed");
    if (reservedText(m.text)) return drop("malformed", NOTICE_STATUS.reserved);
    const text = m.text.trim();
    if (!text) return drop("malformed");
    if (!pairing()) return drop("notice_unpaired", NOTICE_STATUS.unpaired);
    const ppl = people();
    const pe = Object.hasOwn(ppl, from) ? ppl[from] : null;
    // A hidden session's notes are not shown (phase 2); they do not count against the budget.
    if (pe?.hidden) return drop("notice_hidden", NOTICE_STATUS.hidden);
    if (noticeOverBudget(from, t)) return drop("notice_rate", NOTICE_STATUS.rate);
    // Threading: a reply to an instruction this bridge sent to this same agent (name and member),
    // under the current pairing. The relay does not attest that the sender received it; a hint only.
    const ref = typeof m.reply_to === "string" && REF_RE.test(m.reply_to) ? m.reply_to.toLowerCase() : null;
    const sent = ref && Object.hasOwn(state.sent, ref) ? state.sent[ref] : null;
    const answers = Boolean(sent) && !oneWay && sent.name === from && sent.member === own && sent.pairing === pid() && t < sent.exp;
    const thread = answers && Number.isSafeInteger(sent.msg) ? sent.msg : null;
    // A note notifies when it is from a favourite, answers an instruction (any age kept), or the
    // owner wrote to that agent within NOTICE_NOTIFY_MS.
    const notify = Boolean(pe?.fav) || answers || t - (state.last_sent[from] ?? -Infinity) < NOTICE_NOTIFY_MS;
    admit({ kind: "n", id: q, steps: [{ t: "notice", name: from, member: own, text: fit(text, LIMITS.text), oneWay, notify, ...(thread ? { thread } : {}) }], next: 0 });
    seen();
    hit("n-commit");
    save("notice");
    hit("n-before-ack");
    confirm(); // only after the entry is durable
    return runOutbox();
  }

  // ---- updates from Telegram (U side) -----------------------------------------------------

  async function handleUpdate(u) {
    const U = u?.update_id;
    if (!Number.isSafeInteger(U) || U < state.offset) return;
    if (state.outbox.some((e) => e.kind === "u" && e.update === U)) return void (await runOutbox());
    reconciled();
    const mine = gen;
    const authorized = pid(); // the pairing this update is checked against
    classifying = U; // people.json changes made for this update are "bot:<update id>"
    let plan = await classify(u);
    stillLeading(mine);
    // A /start that paired this home: the pairing changes are reconciled before its steps are admitted.
    reconciled();
    hit("u-commit");
    // The pairing changed while the update was classified (classify can wait on the relay): its
    // plan was made for the earlier pairing, so nothing of it is admitted (design 7.3, 2.9). The
    // update that itself paired this home is the exception.
    if (plan && pid() !== authorized && pairing()?.update !== U) {
      count("old_pairing");
      plan = null;
    }
    if (!plan?.steps?.length) {
      state.offset = Math.max(state.offset, U + 1);
      return save("offset");
    }
    admit({ kind: "u", update: U, steps: plan.steps, next: 0 });
    plan.apply?.(); // the first answer wins: reserved in this same write
    save("update");
    hit("u-after-commit");
    await runOutbox();
  }

  /** What one update leads to: {steps, apply?} or null (dropped, counted). */
  async function classify(u) {
    const t = now();
    const op = nonceOf(key, ["upd", botId, u.update_id]);
    const msg = u.message;
    const cq = u.callback_query;
    const paired = pairing();
    const pairedAck = { steps: [{ t: "tg", method: "sendMessage", params: { text: `${TEXTS.paired}\n\n${TEXTS.help}` } }, { t: "menu" }] };
    // The update that paired this home, given again (a crash after pairing.json was written but
    // before U was committed): the same acknowledgement, nothing else.
    if (paired && msg && paired.update === u.update_id) return pairedAck;
    // Pairing: a /start with the code from a private chat.
    if (msg && msg.chat?.type === "private" && typeof msg.text === "string") {
      const m = msg.text.match(/^\/start(?:@\S+)?(?:\s+(\S+))?\s*$/);
      if (m && !(paired && msg.from?.id === paired.user_id && msg.chat.id === paired.chat_id && !m[1])) {
        const r = await tryPair(home, botId, { code: m[1], userId: msg.from?.id, chatId: msg.chat.id, now: t, update: u.update_id });
        hit("pair-written");
        if (r === "paired") {
          audit(home, "paired", {}, t);
          return pairedAck;
        }
        if (r !== "none") {
          count(r === "void" ? "pairing_code_void" : "pairing_code_wrong");
          return null; // a wrong code gets no answer
        }
      }
    }
    if (!paired) {
      count("not_paired");
      return null;
    }
    const from = msg?.from?.id ?? cq?.from?.id;
    const chat = msg?.chat ?? cq?.message?.chat;
    if (from !== paired.user_id || chat?.id !== paired.chat_id || chat?.type !== "private") {
      count(cq ? "foreign_callback" : msg ? "foreign_message" : "other_update");
      return null;
    }
    // The bridge's answers to the owner's own actions: replies, silent (the owner is in the chat).
    const reply = (text, extra = {}, route = null) => ({ t: "tg", method: "sendMessage", params: { text, ...(msg ? replyParams(msg.message_id) : {}), disable_notification: true, ...extra }, ...(route ? { route } : {}) });
    if (cq) return await classifyCallback(cq, op);
    if (!msg || typeof msg.text !== "string") return { steps: [reply(TEXTS.textOnly)] };
    const text = msg.text;
    if (text.length > OWNER_TEXT_MAX) return { steps: [reply(TEXTS.tooLong(text.length, OWNER_TEXT_MAX))] };
    /** An instruction to one own agent: signed, sent with to_member; 👍 once sent (its route). */
    // `hostCheck`: a send that follows a reply without a new prompt (2.8, P8).
    const instruct = (wire, member, body, hostCheck = false) => {
      audit(home, "instruct", { to: wire, length: body.length, digest: digest(body) }, t);
      return {
        steps: [
          { t: "send", kind: "instruction", to: { name: wire, member }, text: body, nonce: op, fail: { reply: msg.message_id }, ...(hostCheck ? { host_check: true } : {}) },
          { t: "react", msg: msg.message_id, route: { name: wire, member } },
        ],
      };
    };
    const target = msg.reply_to_message;
    if (target) return await classifyReply(target, text, op, reply, instruct, msg.message_id);
    const c = text.match(/^\/([A-Za-z0-9_]{1,64})(?:@[A-Za-z0-9_]{1,64})?(?:\s+([\s\S]*\S))?\s*$/);
    if (c) {
      const lower = c[1].toLowerCase();
      if (lower === "pending") return { steps: [{ t: "pending", page: 0, reply: msg.message_id }] };
      // /peers stays accepted as a synonym of /agents (it left the menu).
      if (lower === "agents" || lower === "peers" || lower === "msg") return { steps: [{ t: "list", mode: lower === "msg" ? "msg" : "agents", reply: msg.message_id }, { t: "menu" }] };
      if (lower === "help" || lower === "start") return { steps: [reply(TEXTS.help)] };
      if (lower === "app") return appCommand(c[2], reply);
      // An agent command: refreshed from the relay first (a colliding agent that came online since
      // the last check is counted), then resolved only through the sets this bridge keeps; never
      // by normalising the received text again. A failed refresh refuses.
      let fresh;
      try {
        fresh = await refreshMenu();
      } catch (e) {
        if (e instanceof NotLeader) throw e;
        return { steps: [reply(TEXTS.serverUnreachable)] };
      }
      if (!fresh.eligible) return { steps: [reply(TEXTS.cannotList)] };
      const r = resolveCommand(c[1]);
      if (r.none) return { steps: [reply(TEXTS.unknownCommand(c[1]))] };
      if (r.ambiguous) return { steps: [reply(TEXTS.ambiguous(c[1]))] };
      return c[2] ? instruct(r.name, ownMember(), c[2]) : { steps: [promptStep(r.name, ownMember(), msg.message_id)] };
    }
    const ins = text.match(/^@([A-Za-z0-9][A-Za-z0-9_-]{0,63})\s+([\s\S]*\S[\s\S]*)$/);
    if (ins) {
      // A name starting with "role" (@roles-bot) is a name; @all is the only broadcast form here.
      if (ins[1] === "all") return { steps: [reply(TEXTS.oneAgent)] };
      const wire = !namePrefix || ins[1].startsWith(namePrefix) ? ins[1] : `${namePrefix}${ins[1]}`;
      // @ names a real agent, never an alias (2.8): a word that is no own agent's name but is an
      // alias gets a hint, and nothing is sent.
      await refreshNames();
      const ppl = people();
      const L = labels([], ppl);
      const word = ins[1].toLowerCase();
      if (![...L.keys()].some((n) => n.toLowerCase() === word || display(n).toLowerCase() === word)) {
        const aliased = [...L.keys()].find((n) => Object.hasOwn(ppl, n) && typeof ppl[n].alias === "string" && ppl[n].alias.toLowerCase() === word);
        if (aliased) return { steps: [reply(TEXTS.aliasHint(cleanLabel(ins[1], 64), L.get(aliased).full))] };
      }
      if (!NAME_RE.test(wire) || wire === name) return { steps: [reply(TEXTS.unknownAgent(ins[1]))] };
      return instruct(wire, ownMember(), ins[2]);
    }
    if (/^@/.test(text)) return { steps: [reply(TEXTS.oneAgent)] };
    // "Who is this for?" (2.4, P4): the text is held for HOLD_MS (never in the audit) and the
    // picker asks; nothing is sent without a tap.
    const id = tid();
    return {
      steps: [{ t: "list", mode: "hold", hold: id, view: { kind: "first" }, reply: msg.message_id }],
      apply: () => {
        state.targets[id] = { kind: "hold", text, src: msg.message_id, member: ownMember(), pairing: pid(), msg: null, exp: t + HOLD_MS };
        capMap(state.targets, maxTargets);
      },
    };
  }

  /**
   * /app (design 7.4, section 8): one message with the button that opens the app, or why there is
   * none. /app off turns the app off in this update's own write: every session ends, and app work
   * not applied yet never is (its entries are retired by the app runner).
   */
  function appCommand(arg, reply) {
    if (arg != null) {
      if (arg.trim().toLowerCase() !== "off") return { steps: [reply(TEXTS.unknownCommand("app"))] };
      const off = ownerApp.offPlan();
      return { steps: [reply(off ? TEXTS.appTurnedOff : TEXTS.appOff), { t: "menu" }], ...(off ? { apply: off } : {}) };
    }
    // Off, or a relay that cannot serve it (no owner_app): no button (design 7.4, section 8).
    const b = ownerApp.button();
    if (!b) return { steps: [reply(ownerApp.served() ? TEXTS.appNoUrl : TEXTS.appOff)] };
    return { steps: [reply(TEXTS.appOpen, { reply_markup: { inline_keyboard: [[b]] } })] };
  }

  /** `via`: {ack: callback query id} for a button, {reply: message id} for a reply. */
  function answerPlan(q, rec, text, op, via, ackStep = null) {
    const who = labelOf(rec.asker.name);
    const question = rec.payload.question;
    const to = { name: rec.asker.name, member: rec.asker.member };
    return {
      steps: [
        { t: "send", kind: "answer", to, q, text, nonce: op, fail: { edit: { n: rec.num, question }, ...via } },
        editFor(rec, q),
        via.ack ? ackStep(TEXTS.sentAck) : { t: "react", msg: via.reply, route: to },
      ],
      apply: () => {
        Object.assign(rec, { status: "answered", winner: op, closed_at: now(), payload: null });
        // No echo of a free-text answer: the view stays far below Telegram's 4096 characters.
        closeView(rec, via.ack ? TEXTS.answeredChoice(rec.num, who, question, text) : TEXTS.answeredReply(rec.num, who, question));
      },
    };
  }

  /** The acknowledgement of a tap on a closed question's button (B7). */
  const closedText = (status) =>
    status === "answered" ? TEXTS.alreadyAnswered : status === "expired" ? TEXTS.statusExpired : status === "cancelled" ? TEXTS.statusCancelled : ["undelivered", "undeliverable", "refused"].includes(status) ? TEXTS.statusUndelivered : TEXTS.noLongerOpen;
  /** Whether message `id` is a recorded copy of a question card in the paired chat. */
  const cardCopy = (id) => {
    const chat = pairing()?.chat_id;
    return Object.entries(state.questions).find(([, r]) => (r.copies ?? []).some((c) => c.chat === chat && c.id === id)) ?? null;
  };

  async function classifyCallback(cq, op) {
    // Every query of the paired chat is answered: the client shows a progress bar until then.
    const ackStep = (text) => ({ t: "tg", method: "answerCallbackQuery", params: { callback_query_id: cq.id, ...(text ? { text } : {}) } });
    const ack = (text) => ({ steps: [ackStep(text)] });
    const data = String(cq.data ?? "");
    const tm = data.match(/^([tcxsplfdhru]):([a-z2-7]{10})$/);
    if (tm) return await classifyTarget(cq, tm[1], tm[2], op, ackStep);
    // A choice tap carries the question's opaque id: a crash-lost copy stays answerable by tap.
    const m = data.match(/^a:([a-z2-7]{12}):(\d)$/);
    if (!m) return ack(TEXTS.noLongerOpen);
    const found = Object.entries(state.questions).find(([, r]) => r.qid === m[1]);
    if (!found) return ack(TEXTS.noLongerOpen);
    const [q, rec] = found;
    if (rec.status !== "open" && rec.status !== "pending") return ack(closedText(rec.status));
    if (rec.pairing !== pid() || rec.asker.member !== ownMember()) return ack(TEXTS.earlierSetup);
    const choice = rec.payload?.choices?.[Number(m[2])];
    if (choice === undefined) return ack(TEXTS.noLongerOpen);
    return answerPlan(q, rec, choice, op, { ack: cq.id }, ackStep);
  }

  /** Which entry kinds each button letter may name (an id of another kind is stale). */
  const LETTER_KINDS = { t: ["target"], c: ["confirm"], x: ["confirm", "hold", "hostwarn"], s: ["show"], p: ["page"], l: ["lpage"], f: ["search"], d: ["detail"], h: ["hostwarn"], r: ["hostwarn"], u: ["undo"] };
  const staleText = (letter) => ("tlfd".includes(letter) ? TEXTS.listOld : "sp".includes(letter) ? TEXTS.pendingOld : TEXTS.buttonExpired);

  /**
   * A button with an opaque id: t a session in a picker, l a picker page, f a picker's search, d a
   * details screen's button, c and x a confirmation (x also cancels a held text or a host
   * warning), h and r a host warning's Send and Send and remember, s a /pending Show, p a /pending
   * page. Valid only with an id of a kind its letter names, unexpired, on the message it was
   * issued on, and made under the current pairing for the current member (design 7.3, 2.9). A
   * target opens a prompt or a details screen, or (in "Who is this for?") sends the held text
   * once; a confirm or a host warning sends its stored text once: the entry is deleted in this
   * update's commit write.
   */
  async function classifyTarget(cq, letter, id, op, ackStep) {
    const t = now();
    const e = Object.hasOwn(state.targets, id) ? state.targets[id] : null;
    const on = cq.message?.message_id;
    const chat = cq.message?.chat?.id ?? null;
    // A stale button: its message loses its buttons (never a question card's).
    const retireOn = Number.isSafeInteger(on) && !cardCopy(on) ? [retireStep(on)] : [];
    // An app draft's confirmation or a settings line's Undo, tapped before it is active (its
    // message id not saved yet, or its setting not finalised; design 7.4, section 5): nothing is
    // sent or applied, and its buttons stay.
    if (e && e.pending && LETTER_KINDS[letter].includes(e.kind) && t < e.exp) return { steps: [ackStep(TEXTS.tapAgain)] };
    if (!e || !LETTER_KINDS[letter].includes(e.kind) || !(t < e.exp) || !Number.isSafeInteger(on) || e.msg !== on) {
      return { steps: [ackStep(staleText(letter)), ...retireOn] };
    }
    if (e.pairing !== pid() || e.member !== ownMember()) {
      return {
        steps: [ackStep(TEXTS.earlierSetup), ...retireOn],
        apply: () => {
          for (const [k, x] of Object.entries(state.targets)) if (x.msg === on) delete state.targets[k];
        },
      };
    }
    const sentRoute = (name, member, p) => () => addRoute(on, { name, member, kind: "sent", pairing: p, chat });
    if (letter === "t") {
      audit(home, "targeted", { to: e.name }, t);
      if (e.mode === "agents") return { steps: [ackStep(null), { t: "details", name: e.name, member: e.member }] };
      if (e.mode !== "hold") return { steps: [ackStep(null), promptStep(e.name, e.member)] };
      // "Who is this for?": the tap sends the held text once.
      const h = heldText(e.hold, t);
      if (!h || h.msg !== on) return { steps: [ackStep(TEXTS.buttonExpired), ...retireOn] };
      audit(home, "instruct", { to: e.name, length: h.text.length, digest: digest(h.text) }, t);
      return {
        steps: [
          { t: "send", kind: "instruction", to: { name: e.name, member: e.member }, text: h.text, nonce: op, fail: { ack: cq.id }, host_check: true, picker: on, src: h.src },
          ackStep(TEXTS.sentAck),
          { t: "tg", method: "editMessageText", params: { message_id: on, text: TEXTS.sentTo(fullOf(e.name)) } },
          { t: "react", msg: h.src, route: { name: e.name, member: e.member } },
        ],
        apply: () => {
          delete state.targets[e.hold];
          for (const [k, x] of Object.entries(state.targets)) if (x.msg === on) delete state.targets[k];
          sentRoute(e.name, e.member, e.pairing)();
        },
      };
    }
    if (letter === "l") {
      if (e.mode === "hold" && !heldText(e.hold, t)) return { steps: [ackStep(TEXTS.buttonExpired), ...retireOn] };
      return { steps: [ackStep(null), { t: "list", mode: e.mode, ...(e.hold ? { hold: e.hold } : {}), view: e.view, edit: on }] };
    }
    if (letter === "f") {
      if (e.mode === "hold" && !heldText(e.hold, t)) return { steps: [ackStep(TEXTS.buttonExpired), ...retireOn] };
      return {
        steps: [ackStep(null), { t: "tg", method: "sendMessage", params: { text: TEXTS.searchPrompt, disable_notification: true, reply_markup: { force_reply: true } }, route: { name: null, member: e.member, kind: "search", mode: e.mode, ...(e.hold ? { hold: e.hold } : {}) } }],
      };
    }
    if (letter === "d") return detailAction(e, on, ackStep);
    if (letter === "u") return undoAction(e, id, on, ackStep, retireOn);
    if (letter === "x") {
      // Cancel: a confirmation, a held text or a host warning; the text goes in this write.
      return {
        steps: [ackStep(null), { t: "tg", method: "editMessageText", params: { message_id: on, text: TEXTS.cancelledNothingSent } }],
        apply: () => {
          delete state.targets[id];
          if (e.kind === "hold") for (const [k, x] of Object.entries(state.targets)) if (x.msg === on) delete state.targets[k];
          audit(home, "confirm_cancelled", { confirm: id }, t);
        },
      };
    }
    if (letter === "s") {
      const rec = state.questions[e.q];
      if (!rec || (rec.status !== "open" && rec.status !== "pending")) return { steps: [ackStep(rec ? closedText(rec.status) : TEXTS.noLongerOpen)] };
      const p = pid();
      if ((rec.shows?.[p] ?? 0) >= SHOW_PER_PAIRING) return { steps: [ackStep(TEXTS.shownTooOften)] };
      return {
        steps: [ackStep(null), { t: "card", q: e.q, show: true }],
        apply: () => {
          rec.shows = { [p]: (rec.shows?.[p] ?? 0) + 1 }; // counted per pairing: only the current one is kept
        },
      };
    }
    if (letter === "p") return { steps: [ackStep(null), { t: "pending", page: e.page, edit: e.msg }] };
    if (letter === "h" || letter === "r") {
      // A host warning (2.8, P8). Send: once, with a one-use override for the host it warned about
      // (checked again at dispatch). Send and remember: that host becomes the alias's baseline.
      if (letter === "r") {
        try {
          await changePeople((sessions) => {
            if (Object.hasOwn(sessions, e.name) && sessions[e.name].alias) bump(Object.assign(sessions[e.name], { alias_host: e.host }), botOp());
          }, e.pairing);
        } catch (err) {
          if (err instanceof PeopleStaleError) return { steps: [ackStep(TEXTS.earlierSetup), ...retireOn] };
          log("owner channel: people.json could not be updated:", err.message);
          return { steps: [ackStep(TEXTS.notSaved)] };
        }
      }
      audit(home, "instruct", { to: e.name, length: e.text.length, digest: digest(e.text) }, t);
      return {
        steps: [
          { t: "send", kind: "instruction", to: { name: e.name, member: e.member }, text: e.text, nonce: op, fail: { ack: cq.id }, host_check: true, ...(letter === "h" ? { override: { host: e.host } } : {}), picker: on, ...(e.src ? { src: e.src } : {}) },
          ackStep(TEXTS.sentAck),
          { t: "tg", method: "editMessageText", params: { message_id: on, text: TEXTS.sentTo(fullOf(e.name)) } },
        ],
        apply: () => {
          delete state.targets[id];
          sentRoute(e.name, e.member, e.pairing)();
        },
      };
    }
    // c: a closed card's confirmation.
    audit(home, "instruct", { to: e.name, length: e.text.length, digest: digest(e.text) }, t);
    return {
      steps: [
        { t: "send", kind: "instruction", to: { name: e.name, member: e.member }, text: e.text, nonce: op, fail: { ack: cq.id }, host_check: true, picker: on, ...(e.src ? { src: e.src } : {}) },
        ackStep(TEXTS.sentAck),
        { t: "tg", method: "editMessageText", params: { message_id: e.msg, text: TEXTS.sentTo(labelOf(e.name)) } },
      ],
      apply: () => {
        delete state.targets[id];
        sentRoute(e.name, e.member, e.pairing)();
      },
    };
  }

  /** A details screen's button (2.2, P5): message, favourite, rename, hide, and their undo. */
  async function detailAction(e, on, ackStep) {
    if (e.action === "msg") return { steps: [ackStep(null), promptStep(e.name, e.member)] };
    if (e.action === "rename") {
      const l = labels([e.name]).get(e.name);
      return { steps: [ackStep(null), { t: "tg", method: "sendMessage", params: { text: TEXTS.renamePrompt(l.plain), disable_notification: true, reply_markup: { force_reply: true } }, route: { name: e.name, member: e.member, kind: "rename", screen: on } }] };
    }
    // Explicit values, never a toggle: a redone update sets the same thing again. Favourite and
    // Hide exclude each other (a favourite is always shown; hiding one ends it).
    const set = { fav: () => settingFields("fav", true), unfav: () => settingFields("fav", false), hide: () => settingFields("hidden", true), unhide: () => settingFields("hidden", false) }[e.action]?.();
    if (!set) return { steps: [ackStep(TEXTS.listOld)] };
    try {
      await changePeople((sessions, entry) => bump(Object.assign(entry(e.name), set), botOp()), e.pairing);
    } catch (err) {
      if (err instanceof PeopleStaleError) return { steps: [ackStep(TEXTS.earlierSetup)] };
      if (err instanceof PeopleFullError) return { steps: [{ ...ackStep(TEXTS.peopleFull), params: { ...ackStep(TEXTS.peopleFull).params, show_alert: true } }] };
      log("owner channel: people.json could not be updated:", err.message);
      return { steps: [ackStep(TEXTS.notSaved)] };
    }
    audit(home, "people", { action: e.action, to: e.name }, now());
    return { steps: [ackStep(null), { t: "details", name: e.name, member: e.member, edit: on }, { t: "menu" }] };
  }

  /**
   * Undo of a settings change made in the app (design 7.4, section 7): the values before it are
   * written back only while people.json still holds exactly the revision that change produced,
   * written by that change (its op id), and, for a name, while the alias rules hold; then its line
   * says "Undone.". Otherwise nothing is written. Independent of the app being on.
   */
  async function undoAction(e, id, on, ackStep, retireOn) {
    let a = null;
    const before = Object.fromEntries(Object.entries(e.before ?? {}).map(([k, v]) => [k, v === null ? undefined : v]));
    if (e.setting === "alias" && before.alias) {
      try {
        a = await ownAgents();
      } catch (err) {
        if (err instanceof NotLeader) throw err;
      }
    }
    const listed = a?.attested ? a.own.map((p) => p.name) : [];
    try {
      await changePeople((sessions, entry) => {
        const cur = Object.hasOwn(sessions, e.name) ? sessions[e.name] : null;
        if (revOf(cur) !== e.rev || cur?.last_op !== e.op) throw new PeopleRefusedError("changed");
        if (before.alias && aliasProblemIn(before.alias, e.name, sessions, listed, display)) throw new PeopleRefusedError("changed");
        bump(Object.assign(entry(e.name), before), botOp());
      }, e.pairing);
    } catch (err) {
      if (err instanceof PeopleStaleError) return { steps: [ackStep(TEXTS.earlierSetup), ...retireOn] };
      if (err instanceof PeopleRefusedError) return { steps: [ackStep(TEXTS.undoChanged)] };
      if (err instanceof PeopleFullError) return { steps: [ackStep(TEXTS.peopleFull)] };
      log("owner channel: people.json could not be updated:", err.message);
      return { steps: [ackStep(TEXTS.notSaved)] };
    }
    audit(home, "app_pref", { undone: e.setting, to: e.name }, now());
    return {
      steps: [ackStep(null), { t: "tg", method: "editMessageText", params: { message_id: on, text: TEXTS.undone } }, { t: "menu" }],
      apply: () => delete state.targets[id],
    };
  }

  /**
   * A reply to a closed card: not sent at once (a double send after answering must not become an
   * instruction by accident); a button asks first, and holds the text for CONFIRM_MS.
   */
  function confirmPlan(to, member, status, text, reply, ids, src = null) {
    const t = now();
    const id = tid();
    const who = labelOf(to);
    const ask = status === "answered" ? TEXTS.confirmAnswered(who) : status === "expired" ? TEXTS.confirmExpired(who) : TEXTS.confirmClosed(who);
    return {
      steps: [{ ...reply(ask, { reply_markup: { inline_keyboard: [[{ text: cleanLabel(TEXTS.confirmButton(who)), callback_data: `c:${id}` }, { text: TEXTS.cancelButton, callback_data: `x:${id}` }]] } }), bind: id }],
      apply: () => {
        state.targets[id] = { kind: "confirm", name: to, member, text, ...(Number.isSafeInteger(src) ? { src } : {}), pairing: pid(), msg: null, exp: t + CONFIRM_MS };
        capMap(state.targets, maxTargets);
        audit(home, "confirm_offered", { to, confirm: id, card: ids.card, ...(ids.q ? { q: ids.q } : {}) }, t); // never the text
      },
    };
  }

  /**
   * A reply: to a recorded copy of an open card, its answer; of a closed card, a confirmation
   * first; to any other bot message that names one agent (a route, a note's route), an
   * instruction to that agent. The name and member always come from state, keyed by the
   * replied-to message id and bound to the current pairing; never from that message's text. A
   * reply to anything else (a crash-lost copy, a forwarded or pasted lookalike, an old message)
   * sends nothing.
   */
  async function classifyReply(target, text, op, reply, instruct, msgId) {
    const p = pid();
    const own = ownMember();
    const old = { steps: [reply(TEXTS.earlierSetup)] };
    const found = cardCopy(target.message_id);
    if (found) {
      const [q, rec] = found;
      // Open or closed, a card answers only under the pairing it was shown in (closed cards are not
      // rebound by a re-pair: only open questions follow their owner).
      if (rec.asker.member !== own || rec.pairing !== p) return old;
      if ((rec.status === "open" || rec.status === "pending") && rec.payload) return answerPlan(q, rec, text, op, { reply: msgId });
      return confirmPlan(rec.asker.name, rec.asker.member, rec.status, text, reply, { card: target.message_id, q }, msgId);
    }
    const k = String(target.message_id);
    const route = Object.hasOwn(state.routes, k) ? state.routes[k] : null;
    // A route made in another chat names another message (ids are per chat): no route here.
    const chat = pairing()?.chat_id;
    if (route && now() < route.exp && route.chat === chat) {
      if (route.pairing !== p || route.member !== own) return old;
      if (route.kind === "search") {
        // A search prompt's reply: the matches, in the picker's mode (a held text that is gone
        // leaves an ordinary /msg search).
        const hold = route.mode === "hold" && heldText(route.hold) ? route.hold : null;
        return { steps: [{ t: "list", mode: hold ? "hold" : route.mode === "agents" ? "agents" : "msg", ...(hold ? { hold } : {}), view: { kind: "search", query: cleanLabel(text, 64), page: 0 }, reply: msgId }] };
      }
      if (route.kind === "rename") return renamePlan(route, text, reply, msgId);
      return route.kind === "card" ? confirmPlan(route.name, route.member, "closed", text, reply, { card: target.message_id }, msgId) : instruct(route.name, route.member, text, true);
    }
    const note = Object.hasOwn(state.notice_routes, k) ? state.notice_routes[k] : null;
    if (note && now() < note.exp && note.chat === chat) {
      if (note.pairing !== p || note.member !== own) return old;
      return instruct(note.name, note.member, text, true);
    }
    return { steps: [reply(TEXTS.lostTrack)] };
  }

  /**
   * A reply to a rename prompt (2.2, 2.8; P6): "-" removes the name; otherwise the alias rules,
   * checked against every other session's alias and every own agent's logical and wire name
   * listed now or held in people.json. The host it is held from now becomes `alias_host`.
   */
  async function renamePlan(route, text, reply, msgId) {
    let a = null;
    try {
      a = await ownAgents();
    } catch (e) {
      if (e instanceof NotLeader) throw e;
    }
    const wire = route.name;
    const after = [{ t: "react", msg: msgId, route: null }, ...(Number.isSafeInteger(route.screen) ? [{ t: "details", name: wire, member: route.member, edit: route.screen }] : []), { t: "menu" }];
    // Written only while the rename prompt's pairing is still the current one (checked under the
    // lock, after the relay list above was awaited).
    const save = async (change) => {
      try {
        await changePeople(change, route.pairing);
        return null;
      } catch (e) {
        if (e instanceof PeopleStaleError) return { steps: [reply(TEXTS.earlierSetup)] };
        if (e instanceof PeopleRefusedError) return { steps: [reply(e.reason === "taken" ? TEXTS.aliasTaken : TEXTS.aliasInvalid)] };
        if (e instanceof PeopleFullError) return { steps: [reply(TEXTS.peopleFull)] };
        log("owner channel: people.json could not be updated:", e.message);
        return { steps: [reply(TEXTS.notSaved)] };
      }
    };
    if (text.trim() === "-") {
      const no = await save((sessions) => {
        if (Object.hasOwn(sessions, wire)) bump(Object.assign(sessions[wire], { alias: undefined, alias_host: undefined }), botOp());
      });
      if (no) return no;
      audit(home, "people", { action: "unalias", to: wire }, now());
      return { steps: after };
    }
    // The alias rules, checked against people.json as read under the lock that writes the alias (a
    // competing rename, here or in the CLI, cannot slip in between) and the relay's list from above.
    const listed = a?.attested ? a.own.map((p) => p.name) : [];
    const host = a?.attested ? a.own.find((p) => p.name === wire && p.online)?.host : null;
    const no = await save((sessions, entry) => {
      const problem = aliasProblemIn(text, wire, sessions, listed, display);
      if (problem) throw new PeopleRefusedError(problem);
      bump(Object.assign(entry(wire), { alias: normalAlias(text), alias_host: typeof host === "string" && host ? host : undefined }), botOp());
    });
    if (no) return no;
    audit(home, "people", { action: "alias", to: wire }, now());
    return { steps: after };
  }

  // ---- expiry and housekeeping ------------------------------------------------------------

  function expireDue() {
    const t = now();
    let changed = false;
    for (const [q, rec] of Object.entries(state.questions)) {
      if ((rec.status === "open" || rec.status === "pending") && t >= rec.expires_at) {
        const question = rec.payload?.question ?? "";
        const who = labelOf(rec.asker.name);
        Object.assign(rec, { status: "expired", payload: null, closed_at: t });
        closeView(rec, TEXTS.expired(rec.num, who, question));
        admit({ kind: "q", q, steps: [editFor(rec, q), statusStep(rec, q, "exp", `expired: your question ${q} was not answered before ${new Date(rec.expires_at).toISOString()}.`)], next: 0 });
        audit(home, "expired", { q }, t);
        changed = true;
      } else if (rec.status !== "open" && rec.status !== "pending" && t - Math.max(rec.closed_at ?? 0, rec.expires_at) > KEEP_CLOSED_MS && !state.outbox.some((e) => e.q === q)) {
        delete state.questions[q];
        changed = true;
      }
    }
    for (const map of [state.targets, state.routes, state.notice_routes, state.sent]) {
      for (const [k, x] of Object.entries(map)) {
        if (!(t < x.exp)) {
          // An app draft shown in the chat says it expired (design 7.4, section 7).
          if (map === state.targets && x.kind === "confirm" && x.app && Number.isSafeInteger(x.msg)) admit({ kind: "n", id: null, steps: [{ t: "tg", method: "editMessageText", params: { message_id: x.msg, text: TEXTS.appDraftExpired }, pairing: x.pairing ?? null }], next: 0 });
          delete map[k]; // a confirm entry's text goes with it
          changed = true;
        }
      }
    }
    for (const [k, at] of Object.entries(state.notices_seen)) {
      if (t - at > NOTICE_SEEN_MS) {
        delete state.notices_seen[k];
        changed = true;
      }
    }
    const r = state.notice_rate;
    for (const [n, xs] of Object.entries(r.agents)) {
      const keep = xs.filter((x) => t - x < LIMITS.perAgentHour.ms);
      if (keep.length !== xs.length) changed = true;
      if (keep.length) r.agents[n] = keep;
      else delete r.agents[n];
    }
    for (const m of [r.warned, r.statused]) {
      for (const [k, at] of Object.entries(m)) {
        if (t - at >= Math.max(LIMITS.warnEveryMs, LIMITS.statusEveryMs)) {
          delete m[k];
          changed = true;
        }
      }
    }
    if (changed) save("expiry");
    return changed;
  }

  /** Cancel every open question (unpair --all): each asker gets a `cancelled` status. */
  function cancelAll() {
    const t = now();
    for (const [q, rec] of Object.entries(state.questions)) {
      if (rec.status !== "open" && rec.status !== "pending") continue;
      const who = labelOf(rec.asker.name);
      Object.assign(rec, { status: "cancelled", payload: null, closed_at: t });
      closeView(rec, TEXTS.cancelled(rec.num, who));
      admit({ kind: "q", q, steps: [editFor(rec, q), statusStep(rec, q, "cancel", `cancelled: your question ${q} was cancelled because the owner channel was reset.`)], next: 0 });
    }
    save("cancel");
  }

  // ---- pairing changes (design 7.3, 2.9): reconciled once, idempotently, from state.json ------------

  const openQuestions = () => Object.entries(state.questions).filter(([, r]) => r.status === "open" || r.status === "pending");
  /** Retire the queued steps (from each entry's `next`) that `pred` names; an emptied update entry confirms its update. */
  function retireWhere(pred, reason) {
    const keep = [];
    for (const e of state.outbox) {
      const rest = e.steps.slice(e.next).filter((s) => {
        if (!pred(s, e)) return true;
        count(reason);
        return false;
      });
      if (!rest.length) {
        if (e.kind === "u") state.offset = Math.max(state.offset, e.update + 1);
        continue;
      }
      e.steps = [...e.steps.slice(0, e.next), ...rest];
      keep.push(e);
    }
    state.outbox = keep;
  }
  /**
   * The queued edits of an earlier pairing are retired; each closed question whose cards still
   * owe their view gets one cleanup edit under the new pairing, rendered from its state (N1).
   */
  function cleanupEdits(p) {
    retireWhere((s) => (s.t === "edit" || s.t === "editcopy") && s.pairing !== p, "old_pairing");
    for (const [q, rec] of Object.entries(state.questions)) {
      if (rec.status !== "open" && rec.status !== "pending" && rec.edit_due && rec.view && rec.copies?.length) admit({ kind: "q", q, steps: [{ ...editFor(rec, q), pairing: p }], next: 0 });
      // Copies past the cap whose "older copy" edit was retired with the old pairing: one more try.
      for (const c of rec.retiring ?? []) admit({ kind: "q", q, steps: [{ t: "editcopy", q, chat: c.chat, id: c.id, text: TEXTS.olderCopy, pairing: p }], next: 0 });
    }
  }

  /**
   * Compare the owner of record (state.owner) with the current pairing and reconcile once; the
   * caller saves (one write). Returns whether anything changed. No clock is used.
   */
  function reconcile() {
    const p = pairing();
    if (!Object.hasOwn(state, "owner")) {
      migrate(p);
      return true;
    }
    if (!p) return false; // unpaired: nothing to compare until the next pairing
    const o = state.owner;
    if (o?.pairing === p.id) return false;
    if (o && o.user_id === p.user_id) samePerson(p);
    else if (o) otherPerson(p);
    // (o === null: the first pairing of this home: questions asked meanwhile are shown to it.)
    state.owner = { user_id: p.user_id, pairing: p.id };
    audit(home, "reconciled", { branch: !o ? "first" : o.user_id === p.user_id ? "same_user" : "other_user" }, now());
    return true;
  }
  function reconciled() {
    if (!reconcile()) return;
    hit("reconcile");
    save("reconcile");
  }

  /** The same Telegram user paired again: their open questions follow them; old controls go. */
  function samePerson(p) {
    const open = new Set(openQuestions().map(([q]) => q));
    for (const [k, r] of Object.entries(state.routes)) {
      // The same person answers the same question, in the same chat (message ids are per chat).
      if (r.kind === "card" && open.has(r.q) && r.chat === p.chat_id) r.pairing = p.id;
      else delete state.routes[k];
    }
    state.targets = {};
    state.notice_routes = {};
    state.sent = {}; // message ids of the old chat
    cleanupEdits(p.id);
    retireWhere((s) => s.t === "card" && open.has(s.q), "old_pairing");
    for (const q of open) {
      const rec = state.questions[q];
      rec.pairing = p.id;
      admit({ kind: "q", q, steps: [{ t: "card", q, ...(rec.copies?.length ? { again: "repair" } : {}), pairing: p.id }], next: 0 });
    }
  }

  /** Another Telegram user paired: they inherit no question and no control. */
  function otherPerson(p) {
    state.routes = {};
    state.targets = {};
    state.notice_routes = {};
    state.last_sent = {};
    state.sent = {};
    const open = openQuestions();
    const qs = new Set(open.map(([q]) => q));
    retireWhere((s) => s.t === "card" && qs.has(s.q), "old_pairing");
    const t = now();
    for (const [q, rec] of open) {
      Object.assign(rec, { status: "cancelled", payload: null, closed_at: t });
      closeView(rec, TEXTS.cancelled(rec.num, labelOf(rec.asker.name)));
      admit({ kind: "q", q, steps: [statusStep(rec, q, "other", `cancelled: your question ${q} was cancelled because your owner channel was paired with another Telegram account.`)], next: 0 });
    }
    // The cards (also the ones just cancelled) are edited in the earlier owner's chat, best effort; never in the new one.
    cleanupEdits(p.id);
  }

  /**
   * A 7.2 state (no `owner` key), fail closed: 7.2 could move or drop the pairing without touching
   * state.json, so nothing in it has a proven owner. Every route, target and confirm entry goes;
   * every open question is cancelled (its agent told); queued answers and instructions and every
   * Telegram step are retired (a retired answer's question is cancelled too); automatic statuses
   * stay. Then the owner of record is the current pairing, if any.
   */
  function migrate(p) {
    const t = now();
    state.routes = {};
    state.targets = {};
    state.sent = {};
    state.card_seq ??= 0;
    const cancel = (q, rec) => {
      Object.assign(rec, { status: "cancelled", payload: null, closed_at: t });
      return { kind: "q", q, steps: [statusStep(rec, q, "upgrade", `cancelled: your question ${q} was cancelled because your owner channel was upgraded; ask again if it is still needed.`)], next: 0 };
    };
    const added = [];
    retireWhere((s) => {
      if (s.t === "send" && s.kind === "status") return false;
      if (s.t === "send" && s.kind === "answer") {
        const rec = state.questions[s.q];
        if (rec && rec.status !== "cancelled") added.push(cancel(s.q, rec));
      }
      return true;
    }, "legacy_step");
    for (const [q, rec] of openQuestions()) added.push(cancel(q, rec));
    for (const rec of Object.values(state.questions)) {
      delete rec.tg_message_id; // a 7.2 card has no recorded chat: never edited, never routed
      rec.copies = [];
    }
    for (const e of added) admit(e);
    state.owner = p ? { user_id: p.user_id, pairing: p.id } : null;
    audit(home, "reconciled", { branch: "migration", cancelled: added.length }, t);
  }

  // ---- the app (design 7.4) -----------------------------------------------------------------

  // The app's public origin: HOPTELL_APP_URL, else the relay's host when that is a wss:// name.
  const appOriginOf = appOriginFor({ explicit: appUrl, relayUrl: relayOpts?.url });
  const appOrigin = () => appOriginOf.origin;
  const ownerApp = createOwnerApp({
    state: () => state,
    serial,
    save,
    admit,
    count,
    hit,
    halt,
    kick: () => kick(),
    leading,
    stopped: () => stopped,
    draining: () => draining,
    backoff: () => backoffUntil - now(),
    pid,
    pairing,
    ownMember,
    tgCall,
    ownAgents,
    labels,
    labelOf,
    display,
    people,
    relay: () => relay,
    appOrigin,
    key,
    botId,
    home,
    name,
    appKey,
    limits: appLimits,
    now,
    log,
    refreshNames,
    cardBegin,
    cardRender,
    cardDone,
    closedText,
    SHOW_PER_PAIRING,
    fit,
    cleanLabel,
    Crash,
    NotLeader,
    audit: (event, fields) => audit(home, event, fields, now()),
    page: (p) => appPage?.get(p) ?? null,
  });
  let appPage = null; // the page files: a fixed table built at start

  // ---- start and stop ---------------------------------------------------------------------

  /**
   * `drain` (unpair --all): cancel open questions, send the outbox, stop; Telegram is not polled.
   * `heldLock`: the caller already holds this home's run lock and keeps it after the bridge stops
   * (unpair --all holds it through its cleanup).
   */
  async function start({ drain = false, drainMs = 15_000, heldLock = null } = {}) {
    ensureChannelDir(home);
    draining = drain;
    const lock = heldLock ?? tryLock(paths.lock);
    if (typeof lock !== "function") {
      finish({ code: "locked", message: `another hoptell telegram run uses this home (pid ${lock.pid})` });
      return done;
    }
    releaseLock = heldLock ? null : lock;
    try {
      state = readState(home, botId);
      state.drops ??= {};
      state.recent ??= [];
      state.targets ??= {};
      state.routes ??= {};
      state.menu ??= emptyMenu();
      state.menu.delete ??= [];
      state.menu.commands ??= {};
      state.notice_routes ??= {};
      state.notices_seen ??= {};
      state.last_sent ??= {};
      state.sent ??= {};
      state.notice_rate ??= {};
      for (const k of ["agents", "warned", "statused"]) state.notice_rate[k] ??= {};
      state.notice_rate.all ??= [];
      state.app_ops ??= {};
      if (!drain) {
        try {
          appPage = buildPage();
        } catch (e) {
          log(`owner channel: the app's page files could not be read: ${e.message}`);
        }
        if (state.app?.on && !appOriginOf.origin) log(`owner channel: the app is on, but its public HTTPS address could not be determined (${appOriginOf.invalid ?? APP_ORIGIN_PROBLEMS[appOriginOf.problem] ?? appOriginOf.problem}); set HOPTELL_APP_URL to the relay's public HTTPS address, such as https://hoptell.example.com`);
      }
      // Entries written before origins existed: their origin by their kind (an app entry is "a").
      for (const e of state.outbox) e.origin ??= e.kind === "u" ? "u" : e.kind === "a" ? "a" : "q";
      // Menu deletions `unpair --all` could not confirm: retried by this run (the same bot only).
      const cleanup = readMenuCleanup(home);
      if (cleanup?.bot_id === botId && !drain) {
        for (const c of cleanup.chats) if (!state.menu.delete.includes(c)) state.menu.delete.push(c);
        writePrivateJson(paths.state, state); // held in state.json (retried until confirmed) before the file goes
        fs.rmSync(menuCleanupFile(home), { force: true });
      }
      // A pairing change (or a 7.2 state) is reconciled before the outbox is replayed or any update handled.
      reconciled();
    } catch (e) {
      halt(e instanceof Crash ? "crashed" : "refused", e.message);
      return done;
    }
    writeRun("starting");
    if (!drain) {
      try {
        const w = await telegram.getWebhookInfo();
        if (w?.url) {
          halt("webhook", "a webhook is set for this bot, so getUpdates cannot work; hoptell never deletes it. Remove it (deleteWebhook) or use another bot.");
          return done;
        }
      } catch (e) {
        halt("refused", `the bot could not be checked: ${e.message}`);
        return done;
      }
    }
    relay = clientFactory({ ...relayOpts, name, mode: "peer", reconnect: true, waitWhenReplaced: false, require2: true });
    relay.on("ready", () => {
      if (!relay.member?.id || !relay.realm?.id) return halt("refused", "the bridge needs a member token on a protocol-2 relay (questions are accepted only from its own member)");
      // The pin names a realm: a relay answering with another one is not this bridge's relay.
      if (expectRealm && relay.realm.id !== expectRealm) return halt("refused", `the relay's realm is ${relay.realm.id}, but this bridge's pin names ${expectRealm}; run hoptell telegram unpair --all and set up again`);
      // Every control keeps the member it was made for; a bridge under another member is another setup.
      if (expectMember && relay.member.id !== expectMember) return halt("refused", "the bridge's member changed; run hoptell telegram unpair --all and set up again");
      // Under "required" for its own member the bridge does not run (unpair --all still drains:
      // each of its sends is refused for good, so the outbox empties and the reset completes).
      // A policy that cannot be read is not a halt: each send waits (sendStep) until it is fixed.
      if (!drain && plaintextRefused() === true) {
        audit(home, "refused", { reason: ENCRYPTION_REQUIRED }, now());
        // Checked at every connection (a reconnect after a policy change stops the bridge too).
        return halt(ENCRYPTION_REQUIRED, "encryption_required: your encryption policy for your own member requires end-to-end encryption, and the owner channel sends plaintext through the relay; the bridge does not run (an explicit off entry for your own member is the override, and it applies to every session of that member)");
      }
      gain();
    });
    relay.on("down", (r) => lose(r || "connection lost"));
    relay.on("replaced", (r) => lose(r || "replaced"));
    relay.on("closed", () => lose("closed"));
    relay.on("fatal", (r) => {
      lose(r);
      if (/name is in use/.test(String(r))) {
        audit(home, "refused", { reason: "name_in_use" }, now());
        halt("name_in_use", `another bridge holds ${address}`);
      } else if (String(r).includes(`${NAME_REFUSED}: `)) {
        const m = relay.helloError?.member ?? "<member>"; // said by the relay, when it is new enough
        halt("refused", `the relay refused the bridge name ${name}: the bridge needs a member token, which may use only "${m}" or names that start with "${m}-" (4002)`);
      } else halt("refused", `the relay refused the bridge: ${r}`);
    });
    relay.on("message", (m, confirm) => (drain ? undefined : onMessage(m, confirm)));
    relay.on("app_req", (m) => (drain ? undefined : ownerApp.onRequest(m)));
    relay.start();
    if (drain) {
      // unpair --all: cancel open questions, send what the outbox holds, then stop.
      const deadline = Date.now() + drainMs;
      await serial(() => cancelAll());
      while (!stopped && state.outbox.length && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
        if (leading()) await serial(() => runOutbox());
      }
      const left = state.outbox.length;
      halt("stopped", left ? `${left} status message(s) could not be sent` : null);
      return done;
    }
    ticker = setInterval(() => serial(() => (leading() && expireDue() ? runOutbox() : undefined)), tickMs);
    ticker.unref?.();
    menuTicker = setInterval(() => serial(() => menuWork()), menuCheckMs);
    menuTicker.unref?.();
    return done;
  }

  return {
    start,
    /** Stop cleanly: give the name back, end the poll. */
    async stop() {
      clearTimeout(signalTimer);
      signalTimer = null;
      await flushSignals().catch(() => {});
      halt("stopped", null);
      await chain.catch(() => {});
      return done;
    },
    done,
    get status() {
      return { ...status, leader: leading(), address };
    },
    /** Tests: the current durable state as written. */
    state: () => readState(home, botId),
    /** Tests: run the expiry check now. */
    tick: () => serial(() => (leading() && expireDue() ? runOutbox() : undefined)),
    /** Tests: run the menu check now (as the timer does, without its once-a-minute limit). */
    menuCheck: () => serial(() => menuWork(true)),
    /** Tests: whether the bridge holds its claim. */
    leading,
    /** Tests: the app's live session count. */
    appSessions: () => ownerApp.sessionCount(),
    /** Tests: whether the relay serves this bridge's app now. */
    appAvailable: () => ownerApp.available(),
    appServed: () => ownerApp.served(),
    get relay() {
      return relay;
    },
  };
}

// ---- menu deletions that outlive unpair --all (<home>/owner-channel/menu-cleanup.json) ------------

export const menuCleanupFile = (home) => path.join(channelPaths(home).dir, "menu-cleanup.json");

/** {v, bot_id, chats}: chats whose command menu deletion Telegram did not confirm; or null. */
export function readMenuCleanup(home) {
  try {
    const c = readPrivateJson(menuCleanupFile(home), 64 * 1024);
    return c?.v === 1 && typeof c.bot_id === "string" && Array.isArray(c.chats) ? { ...c, chats: c.chats.filter(Number.isSafeInteger) } : null;
  } catch {
    return null;
  }
}

/** Keep `chats` for the next run of bot `botId` (merged with what is already kept for it). */
export function keepMenuCleanup(home, botId, chats) {
  const old = readMenuCleanup(home);
  const all = [...new Set([...(old?.bot_id === String(botId) ? old.chats : []), ...chats])];
  ensureChannelDir(home);
  writePrivateJson(menuCleanupFile(home), { v: 1, bot_id: String(botId), chats: all });
}

// ---- status (hoptell telegram status, hoptell doctor): no token, chat id, key or text ------------

/** The bridge's configuration on this home (written by hoptell telegram setup), or null. */
export function readBridgeConfig(home) {
  const b = readPrivateJson(channelPaths(home).bridge, 64 * 1024);
  return b?.v === 1 ? b : null;
}

/** `hoptell telegram run`'s exit code when the encryption policy refuses the bridge: final until the policy changes (EX_CONFIG). */
export const EXIT_ENCRYPTION_REQUIRED = 78;

const RUN_STATES = { encryption_required: "stopped: your encryption policy for your own member requires end-to-end encryption, and the owner channel sends plaintext through the relay (change the policy, or add an explicit off entry for your own member)", name_in_use: "stopped: name in use", conflict: "stopped: another poller", webhook: "stopped: a webhook is set", crashed: "stopped: crashed", refused: "stopped: refused", locked: "stopped: another run on this home" };

/** The bridge's run state for people: "leader", "waiting for the relay", "stopped: ...", "not running". */
export function runState(home, deps = {}) {
  const r = readRun(home, deps);
  if (!r) return "not running";
  if (r.state !== "stopped" && r.identity === "unknown") return `unknown: the bridge process (pid ${r.pid}) could not be checked`;
  if (r.live && r.state === "leader") return "leader";
  if (r.live) return r.state === "waiting" ? "waiting for the relay (not leader)" : r.state;
  if (r.state === "stopped") return r.reason ? (RUN_STATES[r.reason] ?? `stopped: ${r.reason}`) : "not running";
  return "not running (its last run ended without stopping cleanly)";
}

/**
 * Status lines [{level, what, detail}] for this home: the setting, trusted pins, the bridge (if
 * configured here), and verification failures. `ownerChannel`: the HOPTELL_OWNER_CHANNEL setting.
 */
export function statusLines(home, { ownerChannel = true, readTrusted = null } = {}) {
  const lines = [];
  const add = (level, what, detail) => lines.push({ level, what, detail });
  if (!ownerChannel) add("info", "owner channel", "off (HOPTELL_OWNER_CHANNEL=off): ask_owner is hidden and owner envelopes show as ordinary peer messages");
  let trusted = null;
  try {
    trusted = (readTrusted ?? ((h) => readPrivateJson(channelPaths(h).trusted, 64 * 1024) ?? { v: 1, realms: {} }))(home);
  } catch (e) {
    add("FAIL", "owner channel pins", `${channelPaths(home).trusted} cannot be used (${e.message.slice(0, 120)}); nothing is verified`);
  }
  if (trusted) {
    const realms = Object.entries(trusted.realms ?? {});
    if (!realms.length) add("info", "owner channel pins", "none trusted on this machine (ask_owner is not offered)");
    for (const [realm, e] of realms) add("ok", "owner channel pin", `bridge ${e.name} on realm ${realm.slice(0, 8)}…, ${e.keys.length} key${e.keys.length === 1 ? "" : "s"} trusted${e.keys.length > 1 ? " (a key rotation is staged)" : ""}`);
  }
  let bridge = null;
  try {
    bridge = readBridgeConfig(home);
  } catch (e) {
    add("FAIL", "owner channel bridge", `the bridge configuration cannot be read (${e.message.slice(0, 120)})`);
  }
  if (bridge) {
    let paired = null;
    let code = false;
    try {
      const pr = readPairing(home);
      paired = pr?.paired ?? null;
      code = Number(pr?.pending?.expires_at) > Date.now(); // an expired code needs a new one
    } catch {}
    const howToPair = code
      ? `not paired: a pairing code is waiting for the owner to send /start <code> to @${bridge.username}; the bridge (hoptell telegram run) must be running to accept it`
      : `not paired: get a code with hoptell telegram pair and send /start <code> to @${bridge.username}; the bridge (hoptell telegram run) must be running to accept it`;
    add("ok", "owner channel bridge", `bot @${bridge.username} for ${bridge.alias}/${bridge.wire}; ${paired ? `paired since ${new Date(paired.at).toISOString()}` : howToPair}${bridge.next ? "; a next key is staged (hoptell telegram key commit)" : ""}`);
    const st = runState(home);
    add(st === "leader" ? "ok" : /^stopped: (name in use|another poller|a webhook|your encryption policy)/.test(st) ? "warn" : "info", "owner channel run", st);
  }
  let rec = null;
  try {
    const s = readPrivateJson(channelPaths(home).state, 16 * 1024 * 1024);
    if (s?.v === 1) rec = s;
  } catch {}
  if (rec) {
    const open = Object.values(rec.questions ?? {}).filter((q) => q.status === "open" || q.status === "pending").length;
    const drops = Object.entries(rec.drops ?? {}).map(([k, n]) => `${k} ${n}`).join(", ");
    add("info", "owner channel questions", `${open} open; ${rec.outbox?.length ?? 0} pending action${rec.outbox?.length === 1 ? "" : "s"}${drops ? `; dropped: ${drops}` : ""}`);
  }
  try {
    const c = readReceived(home);
    if (c.failed || c.suppressed) add(c.failed ? "warn" : "info", "owner channel verification", `${c.failed} envelope${c.failed === 1 ? "" : "s"} failed verification${Object.keys(c.reasons ?? {}).length ? ` (${Object.entries(c.reasons).map(([k, n]) => `${k}: ${n}`).join("; ")})` : ""}; ${c.suppressed} replay${c.suppressed === 1 ? "" : "s"} suppressed`);
  } catch {}
  return lines;
}
