// The owner channel's bridge (design 7.2, "The bridge"): the single Telegram poller and the single
// relay peer of one bot. It sends agents' questions to the owner's Telegram chat as cards, and
// routes answers and instructions back to the owner's own agents as signed envelopes.
//
// Targeting (design 7.2 v5): /peers and /msg show one button per own agent (as the relay attests,
// cap list_own); a reply to a bot message that names one agent continues with it; the paired
// chat's command menu holds /pending, /peers, /msg, /help and one command per unambiguous agent.
// Buttons carry opaque ids mapped in state (bound to their message, expiring), never a name; a
// command resolves only through the sets this bridge keeps. Target-selection taps and bare agent
// commands only open a prompt; the explicit "Send to …" confirmation tap sends a stored reply as
// an instruction (a choice tap on a question card answers it, as before).
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
import { ENCRYPTION_REQUIRED, contactsFile, ownPlaintextRefused, policyReader } from "./contacts.js";
import { identityState, processIdentity } from "./host.js";
import { tryLock, withLock } from "./locks.js";
import { channelPaths, ensureChannelDir, nonceOf, parseQuestion, readPrivateJson, readReceived, signEnvelope, writePrivateJson } from "./ownersig.js";

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
export const MAX_BUTTONS = 50;
export const TG_TEXT_MAX = 4096;
export const STATIC_COMMANDS = [
  { command: "pending", description: "Open questions from your agents" },
  { command: "peers", description: "Your agents, with a button for each" },
  { command: "msg", description: "Message one of your agents" },
  { command: "help", description: "How to use this owner channel" },
];
const RESERVED_COMMANDS = new Set(["start", "help", "settings", "pending", "peers", "msg", "cancel"]);
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

export function readState(home, botId) {
  const s = readPrivateJson(channelPaths(home).state, 16 * 1024 * 1024);
  if (!s) return { v: 1, bot_id: String(botId), offset: 0, questions: {}, outbox: [], recent: [], drops: {} };
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

// ---- texts shown in Telegram ---------------------------------------------------------------------

const HELP = [
  "hoptell owner channel.",
  "• Answer a question: reply to its card, or press one of its buttons.",
  "• Message one of your agents: /msg or /peers and tap its name, or /<agent> from the menu, then reply to the prompt. Or send @<name> <text>, or /<agent> <text>.",
  "• Reply to any message that names one agent (a prompt, \"Sent to …\") to write to that agent again.",
  "• /pending: open questions · /peers: your agents · /msg: pick an agent · /help: this text",
  "Messages here go to your own agents only. They do not approve hoptell decisions or permission prompts.",
].join("\n");

function cardText(q, rec, { resent = false } = {}) {
  return `${resent ? "(re-sent) " : ""}❓ ${rec.asker.name} (${rec.alias}) asks:\n${rec.payload.question}\n— reply to this message to answer · ref ${short(q)}`;
}

// ---- the bridge -----------------------------------------------------------------------------------

/**
 * Create a bridge. `telegram`: a Bot API client (lib/telegram.js, or a fake in tests); `relay`:
 * {url, token, signIn?} of the bridge's relay; `alias` and `namePrefix`: that relay's entry;
 * `name`: the bridge's wire name; `key`: the signing key {pub, priv}; `botId`.
 * Options: `fault(point)` (tests: throw Crash to stop at a boundary), `now`, `log`, `pollTimeout`
 * (seconds), `tickMs` (expiry checks), `retryMs`, `menuCheckMs` (the command menu), `clientFactory`.
 * start() resolves when the bridge stops: {code, message}. code: "stopped" | "name_in_use" |
 * "conflict" | "webhook" | "locked" | "crashed" | "refused".
 */
export function createBridge({ home, telegram, relay: relayOpts, alias = "default", namePrefix = "", name, key, botId, expectRealm = null, fault = null, now = () => Date.now(), log = () => {}, pollTimeout = 50, tickMs = 30_000, retryMs = 5000, menuCheckMs = MENU_CHECK_MS, clientFactory = (o) => new RelayClient(o) }) {
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

  const policy = policyReader(contactsFile(home));
  /** Plaintext to the bridge's own member is refused now (its policy is "required"). */
  const plaintextRefused = () => ownPlaintextRefused(policy().doc, relay?.realm?.id ?? expectRealm, relay?.member?.id ?? null);
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
      serial(() => menuWork(true)); // pending menu deletions first, then the current menu
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
    relay?.close(); // a clean close gives the name back (release)
    // This home's lock is kept until the work already running has settled (aborted calls end it,
    // and nothing is applied after the generation changed), so a new run never overlaps it.
    chain.then(() => {
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
    for (const entry of [...state.outbox]) {
      if (!state.outbox.includes(entry)) continue;
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

  async function runEntry(entry) {
    while (entry.next < entry.steps.length) {
      ensureLeader();
      const mine = gen;
      const step = entry.steps[entry.next];
      const r = await runStep(entry, step);
      stillLeading(mine);
      if (r.wait) return "wait";
      hit(`after-step:${step.t}`);
      entry.next++;
      // A refusal replaces the steps that depended on success, in the same write as its outcome.
      if (r.replace) entry.steps = [...entry.steps.slice(0, entry.next), ...r.replace];
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

  // ---- targeting (design 7.2 v5): own agents, routes, buttons, the menu --------------------------

  /** An agent's display name: the logical name (its wire name without this relay's prefix). */
  const display = (wire) => (namePrefix && wire.startsWith(namePrefix) && wire.length > namePrefix.length ? wire.slice(namePrefix.length) : wire);
  const ownMember = () => relay?.member?.id ?? null;

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
    return { attested: true, own: list.filter((p) => p?.own === true && p.custody !== "hosted" && typeof p.name === "string" && NAME_RE.test(p.name) && p.name !== name) };
  }

  /** Bounded maps: the entries closest to expiry go first. */
  function bound(map, max) {
    const keys = Object.keys(map);
    if (keys.length <= max) return;
    for (const k of keys.sort((a, b) => map[a].exp - map[b].exp).slice(0, keys.length - max)) delete map[k];
  }
  function addRoute(messageId, { name: to, member, kind }) {
    state.routes[String(messageId)] = { name: to, member, kind, exp: now() + ROUTE_MS };
    bound(state.routes, MAX_ROUTES);
  }
  const retireStep = (messageId) => ({ t: "tg", method: "editMessageReplyMarkup", params: { message_id: messageId, reply_markup: { inline_keyboard: [] } } });
  /** The prompt a target button or an agent command opens: the reply goes to that agent. */
  const promptStep = (wire, replyId = null) => ({
    t: "tg",
    method: "sendMessage",
    params: { text: `✏️ Message to ${wire} (${alias}): reply to this message with your text.`, ...replyParams(replyId), disable_notification: true, reply_markup: { force_reply: true, input_field_placeholder: cleanLabel(`Message to ${display(wire)}`, 64) } },
    route: { name: wire, member: ownMember(), kind: "prompt" },
  });

  /** /peers and /msg: the list, with one button per own online agent; retires the older list. */
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
    const line = (p) => `• ${p.name}${p.online ? "" : " (offline)"}`;
    const lines = (ps) => (ps.length > 100 ? [...ps.slice(0, 100).map(line), `… and ${ps.length - 100} more`] : ps.map(line)).join("\n");
    let text;
    let buttons = [];
    if (!a.attested) {
      // A name's shape proves nothing (a shared token may claim any name): no unconfirmed names.
      text = `The relay ${alias} cannot confirm which agents are yours, so they are not listed and there are no buttons; it needs an upgrade. Meanwhile, send @<name> <text>.`;
    } else {
      const sorted = [...a.own].sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
      const online = sorted.filter((p) => p.online);
      buttons = online.slice(0, MAX_BUTTONS).map((p) => ({ id: tid(), name: p.name }));
      const more = online.length > buttons.length ? ` (buttons for the first ${buttons.length} of ${online.length}; for the others, send @<name> <text>)` : "";
      if (step.mode === "msg") text = buttons.length ? `Who should get your message?${more}` : `None of your agents on ${alias} is online. Send @<name> <text> to queue a message.`;
      else text = sorted.length ? `Your agents on ${alias}:\n${lines(sorted)}${buttons.length ? `\nTap a name to message that agent.${more}` : ""}` : `No other agents of yours on ${alias}.`;
    }
    const markup = buttons.length ? { reply_markup: { inline_keyboard: buttons.map((b) => [{ text: cleanLabel(display(b.name)), callback_data: `t:${b.id}` }]) } } : {};
    const r = await tg("sendMessage", { chat_id: chat, text, ...replyParams(step.reply), disable_notification: true, ...markup });
    if (r.wait) return { wait: true };
    if (!r.ok) return {};
    const msg = r.result?.message_id;
    // One list at a time: any newer list (also one without buttons) retires the older one: its
    // targets go, and its buttons are removed (best effort).
    const old = Object.entries(state.targets).filter(([, x]) => x.kind === "target");
    const oldMessages = [...new Set(old.map(([, x]) => x.msg).filter((m) => Number.isSafeInteger(m) && m !== msg))];
    return {
      replace: [...oldMessages.map(retireStep), ...entry.steps.slice(entry.next + 1)],
      apply: () => {
        for (const [k] of old) delete state.targets[k];
        if (Number.isSafeInteger(msg)) for (const b of buttons) state.targets[b.id] = { kind: "target", name: b.name, member: ownMember(), msg, exp: t + TARGET_MS };
        bound(state.targets, MAX_TARGETS);
        audit(home, "targeted", { list: buttons.length }, t);
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
    const eligible = a.own.filter((p) => p.online);
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
    for (const e of res.eligible ?? []) {
      const cmd = commandOf(display(e.name));
      if (!cmd) continue;
      const r = resolveCommand(cmd);
      if (r.name === e.name) agents.push({ command: cmd, description: `Message ${e.name}`, name: e.name });
      else if (r.ambiguous) ambiguous++;
    }
    agents.sort((x, y) => (x.command < y.command ? -1 : x.command > y.command ? 1 : 0)); // by command, as the menu shows them
    const commands = [...STATIC_COMMANDS, ...agents.slice(0, MAX_COMMANDS - STATIC_COMMANDS.length).map(({ command, description }) => ({ command, description }))];
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
    audit(home, "menu", { commands: commands.length - STATIC_COMMANDS.length, ambiguous }, now());
  }

  /** A Bot API call of this generation: aborted on loss or stop, its result then never used. */
  async function tg(method, params) {
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
            if (step.route) addRoute(id, step.route);
            if (step.bind && state.targets[step.bind]) state.targets[step.bind].msg = id;
          },
        };
      }
      case "list":
        return listStep(entry, step, chat);
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
        const rec = state.questions[step.q];
        if (!chat || !rec?.tg_message_id) return {};
        const r = await tg("editMessageText", { chat_id: chat, message_id: rec.tg_message_id, text: step.text });
        return r.wait ? { wait: true } : {}; // a redone edit is harmless; a refused one is left
      }
      case "card":
        return cardStep(entry, step, chat);
      default:
        return {};
    }
  }

  async function cardStep(entry, step, chat) {
    const rec = state.questions[step.q];
    if (!rec || rec.status !== "pending" || !rec.payload) return {}; // closed meanwhile
    if (!chat) return { wait: true }; // not paired yet: the card waits (the question expires normally)
    const resent = Boolean(entry.attempted);
    if (!resent) {
      entry.attempted = true;
      save("card-attempt");
    }
    const markup = rec.payload.choices.length
      ? { inline_keyboard: rec.payload.choices.map((c, i) => [{ text: cleanLabel(c, 40), callback_data: `a:${rec.qid}:${i}` }]) }
      : { force_reply: true, input_field_placeholder: "Your answer" };
    const r = await tg("sendMessage", { chat_id: chat, text: cardText(step.q, rec, { resent }), reply_markup: markup });
    if (r.wait) return { wait: true };
    hit("card-sent");
    if (!r.ok) {
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
    // One write records the card, opens the question, keeps a route to its asker (a reply after it
    // closed, even after its record is gone) and marks the entry done.
    return {
      apply: () => {
        Object.assign(rec, { tg_message_id: r.result?.message_id ?? null, status: rec.status === "pending" ? "open" : rec.status });
        if (Number.isSafeInteger(r.result?.message_id)) addRoute(r.result.message_id, { name: rec.asker.name, member: rec.asker.member, kind: "card" });
      },
    };
  }

  /**
   * A send the relay refused for good: the steps that depended on its success (the "Sent to",
   * the answered card, "Answer sent") are replaced by what `step.fail` asks for, and an answer's
   * question closes as `undelivered`; all in the write that marks this step done.
   */
  function refusedSend(step, reason, text) {
    const f = step.fail ?? null;
    const steps = [];
    if (f?.edit && step.q) steps.push({ t: "edit", q: step.q, text: f.edit });
    if (f?.ack) steps.push({ t: "tg", method: "answerCallbackQuery", params: { callback_query_id: f.ack, text: text.slice(0, 200), show_alert: true } });
    else if (f) steps.push({ t: "tg", method: "sendMessage", params: { text, ...replyParams(f.reply), disable_notification: true }, ...(step.kind === "instruction" ? { route: { name: step.to.name, member: step.to.member, kind: "refused" } } : {}) });
    return {
      replace: steps,
      apply: () => {
        const rec = step.kind === "answer" ? state.questions[step.q] : null;
        if (rec) Object.assign(rec, { status: "undelivered", closed_at: now() });
        audit(home, "refused", { reason, kind: step.kind, ...(step.q ? { q: step.q } : {}) }, now());
      },
    };
  }

  async function sendStep(entry, step) {
    if (plaintextRefused()) return encryptionRefused(step);
    const p = pairing();
    ensureLeader();
    const mine = gen;
    const envelope = signEnvelope({ kind: step.kind, realm: relay.realm.id, from: name, to: step.to, ...(step.q ? { q: step.q } : {}), text: step.text, pairing: p ? { id: p.id, at: p.at } : UNPAIRED, ts: now(), nonce: step.nonce }, key);
    try {
      await relay.send(step.to.name, envelope, step.ttl ?? MAX_TTL_S, step.q ?? undefined, { toMember: step.to.member, retryMs: 10_000 });
    } catch (e) {
      stillLeading(mine);
      if (e.code === "no_to_member") return refusedSend(step, "relay_without_to_member", "Not sent: this relay cannot guarantee the recipient; upgrade it.");
      if (e.kind === "relay_error") {
        const reason = e.code === "recipient_member_mismatch" ? "recipient_member_mismatch" : /unknown peer/.test(e.message) ? "unknown_peer" : "relay_refused";
        const text = reason === "unknown_peer" ? `Not sent: no reachable agent named ${step.to.name}.` : reason === "recipient_member_mismatch" ? `Not sent: ${step.to.name} is not held by your own member now.` : "Not sent: the relay refused it.";
        return refusedSend(step, reason, text);
      }
      return { wait: true }; // not sent, or its outcome unknown: redone later with the same nonce
    }
    stillLeading(mine);
    hit("sent");
    if (state.encryptionNotice) delete state.encryptionNotice; // saved with this step: a later refusal is told again
    audit(home, step.kind === "status" ? "status" : step.kind === "answer" ? "answered" : "instructed", { to: step.to.name, ...(step.q ? { q: step.q } : {}), length: step.text.length, digest: digest(step.text) }, now());
    return {};
  }

  /**
   * A send refused because the policy for the bridge's own member is "required": a terminal outcome
   * (reason encryption_required) in the write that marks the step done, like any refused send.
   * Answers and instructions tell the owner through their own `fail` steps (the owner acted, so
   * each one gets its answer); automatic statuses get one general notice, sent once until a send
   * succeeds again (state.encryptionNotice).
   */
  function encryptionRefused(step) {
    const r = refusedSend(step, ENCRYPTION_REQUIRED, "Not sent: your encryption policy for your own member requires end-to-end encryption, and the owner channel sends plaintext through the relay.");
    if (step.fail || state.encryptionNotice) return r;
    r.replace = [...r.replace, { t: "tg", method: "sendMessage", params: { text: "Owner channel: messages to your agents are not sent while your encryption policy for your own member requires end-to-end encryption (the owner channel sends plaintext through the relay). Change that policy, or set an explicit off entry for your own member, to use the owner channel." } }];
    const apply = r.apply;
    r.apply = () => {
      apply();
      state.encryptionNotice = true;
    };
    return r;
  }

  // ---- questions from agents (Q side) ------------------------------------------------------

  const statusStep = (rec, q, what, text) => ({ t: "send", kind: "status", to: { name: rec.asker.name, member: rec.asker.member }, q, text, nonce: nonceOf(key, [what, botId, q]) });

  function onMessage(m, confirm) {
    serial(async () => {
      if (!leading()) return; // unconfirmed: the relay delivers it again
      const q = typeof m.message_id === "string" ? m.message_id.toLowerCase() : null;
      const own = relay.member?.id;
      // Only the bridge's own member, signed in with its member token, may ask.
      if (m.sender?.auth !== "member" || !own || m.sender.member?.id !== own || m.sender.custody === "hosted") {
        count("not_own_member");
        save("drop");
        return confirm();
      }
      if (!q || !REF_RE.test(q) || !NAME_RE.test(m.from ?? "")) {
        count("no_reference");
        save("drop");
        return confirm();
      }
      // A redelivery (same reference): acknowledge it and resume its record; nothing extra.
      if (state.questions[q]) {
        confirm();
        return runOutbox();
      }
      const body = parseQuestion(m.text);
      if (!body) {
        count("malformed");
        save("drop");
        return confirm();
      }
      const t = now();
      const rec = { q, qid: b32(12, "abcdefghijklmnopqrstuvwxyz234567"), asker: { name: m.from, realm: relay.realm.id, member: own }, alias, asked_at: body.asked_at, expires_at: body.expires_at, status: "pending", tg_message_id: null, payload: { question: body.question, choices: body.choices }, created: t };
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
      state.outbox.push(entry);
      save("question");
      hit("q-before-ack");
      confirm(); // only after the record is durable
      return runOutbox();
    });
  }

  // ---- updates from Telegram (U side) -----------------------------------------------------

  async function handleUpdate(u) {
    const U = u?.update_id;
    if (!Number.isSafeInteger(U) || U < state.offset) return;
    if (state.outbox.some((e) => e.kind === "u" && e.update === U)) return void (await runOutbox());
    const mine = gen;
    const plan = await classify(u);
    stillLeading(mine);
    hit("u-commit");
    if (!plan?.steps?.length) {
      state.offset = Math.max(state.offset, U + 1);
      return save("offset");
    }
    state.outbox.push({ kind: "u", update: U, steps: plan.steps, next: 0 });
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
    const pairedAck = { steps: [{ t: "tg", method: "sendMessage", params: { text: `Paired with hoptell (${address}).\n\n${HELP}` } }, { t: "menu" }] };
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
    if (cq) return classifyCallback(cq, op);
    if (!msg || typeof msg.text !== "string") return { steps: [reply("Only text is supported.")] };
    const text = msg.text;
    if (text.length > OWNER_TEXT_MAX) return { steps: [reply(`Not sent: messages to your agents are limited to ${OWNER_TEXT_MAX} characters.`)] };
    /** An instruction to one own agent: signed, sent with to_member, confirmed with a reply route. */
    const instruct = (wire, body) => {
      audit(home, "instruct", { to: wire, length: body.length, digest: digest(body) }, t);
      return { steps: [{ t: "send", kind: "instruction", to: { name: wire, member: relay.member.id }, text: body, nonce: op, fail: { reply: msg.message_id } }, reply(`Sent to ${wire}.`, {}, { name: wire, member: relay.member.id, kind: "sent" })] };
    };
    const target = msg.reply_to_message;
    if (target) return classifyReply(target, text, op, reply, instruct, msg.message_id);
    const c = text.match(/^\/([A-Za-z0-9_]{1,64})(?:@[A-Za-z0-9_]{1,64})?(?:\s+([\s\S]*\S))?\s*$/);
    if (c) {
      const lower = c[1].toLowerCase();
      if (lower === "pending") {
        const open = Object.entries(state.questions).filter(([, r]) => r.status === "open" || r.status === "pending");
        const lines = open.map(([q, r]) => `• ${r.asker.name} · ref ${short(q)} · ${Math.max(0, Math.round((t - r.created) / 60_000))} min`);
        return { steps: [reply(lines.length ? `Open questions:\n${lines.join("\n")}` : "No open questions.")] };
      }
      if (lower === "peers" || lower === "msg") return { steps: [{ t: "list", mode: lower, reply: msg.message_id }, { t: "menu" }] };
      if (lower === "help" || lower === "start") return { steps: [reply(HELP)] };
      // An agent command: refreshed from the relay first (a colliding agent that came online since
      // the last check is counted), then resolved only through the sets this bridge keeps; never
      // by normalising the received text again. A failed refresh refuses.
      let fresh;
      try {
        fresh = await refreshMenu();
      } catch (e) {
        if (e instanceof NotLeader) throw e;
        return { steps: [reply("Could not check your agents now; try again, or use @<name> <text>.")] };
      }
      if (!fresh.eligible) return { steps: [reply(`Agent commands need a newer relay; use @<name> <text>.\n\n${HELP}`)] };
      const r = resolveCommand(c[1]);
      if (r.none) return { steps: [reply(`Unknown command.\n\n${HELP}`)] };
      if (r.ambiguous) return { steps: [reply(`/${c[1]} is ambiguous now; use @<name> <text> or /msg.`)] };
      return c[2] ? instruct(r.name, c[2]) : { steps: [promptStep(r.name, msg.message_id)] };
    }
    const ins = text.match(/^@([A-Za-z0-9][A-Za-z0-9_-]{0,63})\s+([\s\S]*\S[\s\S]*)$/);
    if (ins) {
      // A name starting with "role" (@roles-bot) is a name; @all is the only broadcast form here.
      if (ins[1] === "all") return { steps: [reply("Send to one agent: @<name> <text>. @all is not supported; other @words are treated as agent names, not roles.")] };
      const wire = !namePrefix || ins[1].startsWith(namePrefix) ? ins[1] : `${namePrefix}${ins[1]}`;
      if (!NAME_RE.test(wire) || wire === name) return { steps: [reply("That is not one of your agents' names.")] };
      return instruct(wire, ins[2]);
    }
    if (/^@/.test(text)) return { steps: [reply("Send to one agent: @<name> <text>. @all is not supported; other @words are treated as agent names, not roles.")] };
    return { steps: [reply(HELP)] };
  }

  /** `via`: {ack: callback query id} for a button, {reply: message id} for a reply. */
  function answerPlan(q, rec, text, op, ack, via) {
    const failEdit = `✖ ${rec.asker.name} (${rec.alias}) asked:\n${rec.payload.question}\n— your answer could not be delivered · ref ${short(q)}`;
    return {
      steps: [
        { t: "send", kind: "answer", to: { name: rec.asker.name, member: rec.asker.member }, q, text, nonce: op, fail: { edit: failEdit, ...via } },
        { t: "edit", q, text: `✅ ${rec.asker.name} (${rec.alias}) asked:\n${rec.payload.question}\n— answered: ${text} · ref ${short(q)}` },
        ...(ack ? [ack] : []),
      ],
      apply: () => Object.assign(rec, { status: "answered", winner: op, closed_at: now(), payload: null }),
    };
  }

  function classifyCallback(cq, op) {
    // Every query of the paired chat is answered: the client shows a progress bar until then.
    const ackStep = (text) => ({ t: "tg", method: "answerCallbackQuery", params: { callback_query_id: cq.id, ...(text ? { text } : {}) } });
    const ack = (text) => ({ steps: [ackStep(text)] });
    const tm = String(cq.data ?? "").match(/^([tc]):([a-z2-7]{10})$/);
    if (tm) return classifyTarget(cq, tm[1] === "t" ? "target" : "confirm", tm[2], op, ackStep);
    const m = String(cq.data ?? "").match(/^a:([a-z2-7]{12}):(\d)$/);
    if (!m) return ack("This card is not tracked.");
    const found = Object.entries(state.questions).find(([, r]) => r.qid === m[1]);
    if (!found) return ack("This card is not tracked.");
    const [q, rec] = found;
    if (rec.status === "answered") return ack("Already answered");
    if (rec.status !== "open" && rec.status !== "pending") return ack(`This question is ${rec.status}.`);
    const choice = rec.payload?.choices?.[Number(m[2])];
    if (choice === undefined) return ack("This card is not tracked.");
    return answerPlan(q, rec, choice, op, ackStep("Answer sent"), { ack: cq.id });
  }

  /**
   * A target or confirm button: valid only with an id of that kind, unexpired, on the message it
   * was issued on. A target opens a prompt (it sends nothing to an agent); a confirm sends its
   * stored text once: the entry is deleted in this update's commit write.
   */
  function classifyTarget(cq, kind, id, op, ackStep) {
    const t = now();
    const e = Object.hasOwn(state.targets, id) ? state.targets[id] : null;
    const on = cq.message?.message_id;
    if (!e || e.kind !== kind || !(t < e.exp) || !Number.isSafeInteger(on) || e.msg !== on) {
      // A stale button: its message loses its buttons (never a question card's).
      const card = Object.values(state.questions).some((r) => r.tg_message_id === on);
      return { steps: [ackStep(kind === "target" ? "This list is out of date; send /peers again." : "This button has expired."), ...(Number.isSafeInteger(on) && !card ? [retireStep(on)] : [])] };
    }
    if (kind === "target") {
      audit(home, "targeted", { to: e.name }, t);
      return { steps: [ackStep(null), promptStep(e.name)] };
    }
    audit(home, "instruct", { to: e.name, length: e.text.length, digest: digest(e.text) }, t);
    return {
      steps: [
        { t: "send", kind: "instruction", to: { name: e.name, member: e.member }, text: e.text, nonce: op, fail: { ack: cq.id } },
        ackStep("Sent"),
        { t: "tg", method: "editMessageText", params: { message_id: e.msg, text: `Sent to ${e.name} as a new instruction.` } },
      ],
      apply: () => {
        delete state.targets[id];
        addRoute(e.msg, { name: e.name, member: e.member, kind: "sent" });
      },
    };
  }

  /**
   * A reply to a closed card: not sent at once (a double send after answering must not become an
   * instruction by accident); a button asks first, and holds the text for CONFIRM_MS.
   */
  function confirmPlan(to, member, status, text, reply, ids) {
    const t = now();
    const id = tid();
    const why = status === "answered" ? "This question was already answered." : status === "expired" ? "This question has expired." : status === "closed" ? "This question is closed." : `This question is ${status}.`;
    return {
      steps: [{ ...reply(`${why} Send your text to ${to} as a new instruction?`, { reply_markup: { inline_keyboard: [[{ text: cleanLabel(`Send to ${display(to)}`), callback_data: `c:${id}` }]] } }), bind: id }],
      apply: () => {
        state.targets[id] = { kind: "confirm", name: to, member, text, msg: null, exp: t + CONFIRM_MS };
        bound(state.targets, MAX_TARGETS);
        audit(home, "confirm_offered", { to, confirm: id, card: ids.card, ...(ids.q ? { q: ids.q } : {}) }, t); // never the text
      },
    };
  }

  /**
   * A reply: to an open card, its answer; to a closed card, a confirmation first; to any other
   * bot message that names one agent (a route), an instruction to that agent. The name always
   * comes from state, keyed by the replied-to message id; never from that message's text.
   */
  function classifyReply(target, text, op, reply, instruct, msgId) {
    const found = Object.entries(state.questions).find(([, r]) => r.tg_message_id && r.tg_message_id === target.message_id);
    if (found) {
      const [q, rec] = found;
      if (rec.status === "open" || rec.status === "pending") return answerPlan(q, rec, text, op, null, { reply: msgId });
      return confirmPlan(rec.asker.name, rec.asker.member, rec.status, text, reply, { card: target.message_id, q });
    }
    const route = Object.hasOwn(state.routes, String(target.message_id)) ? state.routes[String(target.message_id)] : null;
    if (route && now() < route.exp) return route.kind === "card" ? confirmPlan(route.name, route.member, "closed", text, reply, { card: target.message_id }) : instruct(route.name, text);
    // An earlier card of a question (re-sent after a crash) still names its ref.
    const ref = String(target.text ?? "").match(/ref ([0-9a-f]{8})\s*$/)?.[1];
    const known = ref && Object.entries(state.questions).find(([q]) => q.startsWith(ref))?.[1];
    if (!known) return { steps: [reply("This message is not tracked; use /msg or @<name> <text>.")] };
    if (known.status === "answered") return { steps: [reply("Already answered.")] };
    if (known.status === "open" || known.status === "pending") return { steps: [reply(`That card is no longer tracked; answer the newest card for ref ${ref}.`)] };
    return { steps: [reply(`This question is ${known.status}; your reply was not sent.`)] };
  }

  // ---- expiry and housekeeping ------------------------------------------------------------

  function expireDue() {
    const t = now();
    let changed = false;
    for (const [q, rec] of Object.entries(state.questions)) {
      if ((rec.status === "open" || rec.status === "pending") && t >= rec.expires_at) {
        const question = rec.payload?.question ?? "";
        Object.assign(rec, { status: "expired", payload: null, closed_at: t });
        state.outbox.push({ kind: "q", q, steps: [{ t: "edit", q, text: `⌛ ${rec.asker.name} (${rec.alias}) asked:\n${question}\n— expired unanswered · ref ${short(q)}` }, statusStep(rec, q, "exp", `expired: your question ${q} was not answered before ${new Date(rec.expires_at).toISOString()}.`)], next: 0 });
        audit(home, "expired", { q }, t);
        changed = true;
      } else if (rec.status !== "open" && rec.status !== "pending" && t - Math.max(rec.closed_at ?? 0, rec.expires_at) > KEEP_CLOSED_MS && !state.outbox.some((e) => e.q === q)) {
        delete state.questions[q];
        changed = true;
      }
    }
    for (const map of [state.targets, state.routes]) {
      for (const [k, x] of Object.entries(map)) {
        if (!(t < x.exp)) {
          delete map[k]; // a confirm entry's text goes with it
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
      Object.assign(rec, { status: "cancelled", payload: null, closed_at: t });
      state.outbox.push({ kind: "q", q, steps: [{ t: "edit", q, text: `✖ cancelled · ref ${short(q)}` }, statusStep(rec, q, "cancel", `cancelled: your question ${q} was cancelled because the owner channel was reset.`)], next: 0 });
    }
    save("cancel");
  }

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
      // Menu deletions `unpair --all` could not confirm: retried by this run (the same bot only).
      const cleanup = readMenuCleanup(home);
      if (cleanup?.bot_id === botId && !drain) {
        for (const c of cleanup.chats) if (!state.menu.delete.includes(c)) state.menu.delete.push(c);
        writePrivateJson(paths.state, state); // held in state.json (retried until confirmed) before the file goes
        fs.rmSync(menuCleanupFile(home), { force: true });
      }
    } catch (e) {
      halt("refused", e.message);
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
      // Under "required" for its own member the bridge does not run (unpair --all still drains:
      // each of its sends is refused for good, so the outbox empties and the reset completes).
      if (!drain && plaintextRefused()) {
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
        halt("refused", `the relay refused the bridge name ${name}: the bridge needs a member token, which may use only "<member>" or names that start with "<member>-" (4002)`);
      } else halt("refused", `the relay refused the bridge: ${r}`);
    });
    relay.on("message", (m, confirm) => (drain ? undefined : onMessage(m, confirm)));
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
