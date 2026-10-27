// Test seams for the owner channel (design 7.2): a fake Bot API shared by every bridge that uses
// "the same token", a relay with the owner's member ("me", as on the local relay) and another
// member, and agents that ask and receive. No network beyond 127.0.0.1, no real bot.
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { startRelay } from "../lib/relay.js";
import { RelayClient } from "../lib/client.js";
import { changeOwnerApp, createBridge } from "../lib/ownerchannel.js";
import { appSecret, signInitData } from "../lib/ownerappauth.js";
import { readPeople, updatePeople } from "../lib/ownerpeople.js";
import * as sig from "../lib/ownersig.js";
import { fakeToken, sleep } from "./helpers.js";

export const ME = "m_mmmmmmmmmmmmmmmmmmmmmmmmmm";
export const BOB = "m_bbbbbbbbbbbbbbbbbbbbbbbbbb";
export const REALM = "a".repeat(32);
export const OWNER_USER = 5550001;
export const OWNER_CHAT = 5550001;
export const BOT_ID = "7000001";
/** The test bot's token (never a real one): the app's initData is signed with a key derived from it. */
// Generated per run, so no token-shaped literal sits in the repository.
export const BOT_TOKEN = `${BOT_ID}:${crypto.randomBytes(26).toString("base64url")}`;
export const APP_KEY = appSecret(BOT_TOKEN);

/**
 * A fake Bot API server. client() gives one poller's view (each bridge gets its own); like
 * Telegram, a new getUpdates while another poller's is open ends the older one with a 409.
 */
export function fakeTelegram({ webhook = "" } = {}) {
  const updates = [];
  let nextUpdate = 1;
  let nextMessage = 100;
  const sent = []; // {method, params, message_id?}
  const waiters = new Set();
  let active = null; // {view, reject}
  const t = {
    sent,
    updates,
    getUpdatesCalls: 0,
    profile: { name: "owner test bot", description: "", short_description: "", photo: null }, // the bot's profile texts
    hold: false, // tests: getUpdates ignores aborts and waits for release()
    held: [],
    failNext: {}, // tests: {method: [status, ...]}
    failWhen: null, // tests: (method, params) => an HTTP status to fail this call with, or 0
    attempts: [], // tests: every call tried, failed ones included: {method, params}
    holdCalls: new Set(), // tests: methods whose calls wait for releaseCalls()
    holdWhen: null, // tests: (method, params) => whether this call waits for releaseCalls()
    heldCalls: [],
    ignoreAbort: false,
    aborted: [],
    releaseCalls() {
      t.holdCalls.clear();
      t.holdWhen = null;
      for (const c of t.heldCalls.splice(0)) c.resolve();
    },
    push(u) {
      const full = { update_id: nextUpdate++, ...u };
      updates.push(full);
      for (const w of [...waiters]) w();
      return full;
    },
    /** A private message from the paired owner (or from `from`/`chat`). */
    say(text, { reply = null, from = OWNER_USER, chat = OWNER_CHAT, type = "private" } = {}) {
      return t.push({ message: { message_id: nextMessage++, from: { id: from }, chat: { id: chat, type }, text, ...(reply ? { reply_to_message: reply } : {}) } });
    },
    /** Press a card's button (or any sent message's: a list, a confirmation). */
    press(card, index, { from = OWNER_USER, chat = OWNER_CHAT, data = null, messageId = null } = {}) {
      data ??= card.params.reply_markup.inline_keyboard[index][0].callback_data;
      return t.push({ callback_query: { id: `cq${nextUpdate}`, from: { id: from }, message: { message_id: messageId ?? card.message_id, chat: { id: chat, type: "private" } }, data } });
    },
    /** The last sendMessage whose text matches `re`. */
    last: (re) => sent.filter((s) => s.method === "sendMessage" && re.test(s.params.text)).at(-1),
    calls: (method) => sent.filter((s) => s.method === method),
    cards: () => sent.filter((s) => s.method === "sendMessage" && /^❓ Question \d+ · ([^\n]* asks:|[^\n]*\nSent again[^\n]*)\n/.test(s.params.text)),
    texts: () => sent.filter((s) => s.method === "sendMessage").map((s) => s.params.text),
    replyTo: (card) => ({ message_id: card.message_id, text: card.params.text }),
    client(label = "bridge") {
      const record = (method) => async (params, { signal = null } = {}) => {
        if (t.holdCalls.has(method) || t.holdWhen?.(method, params)) {
          // Tests: the call waits for releaseCalls(). An abort ends it unless `ignoreAbort` (a
          // request already on its way: Telegram still carries it out).
          await new Promise((resolve, reject) => {
            t.heldCalls.push({ method, params, resolve });
            signal?.addEventListener(
              "abort",
              () => {
                t.aborted.push(method);
                if (!t.ignoreAbort) reject(Object.assign(new Error("aborted"), { aborted: true, network: true }));
              },
              { once: true },
            );
          });
        }
        // Tests: a refusal or failure for the next call(s) of a method, as an HTTP status (checked
        // after a hold, so a held call can still fail).
        t.attempts.push({ method, params: structuredClone(params) });
        const status = t.failNext[method]?.shift() || t.failWhen?.(method, params) || 0;
        if (status) throw Object.assign(new Error(`Telegram ${method}: ${status}`), { status, ...(status === 429 ? { retryAfter: 1 } : {}) });
        const message_id = method === "sendMessage" ? nextMessage++ : undefined;
        sent.push({ method, params: structuredClone(params), message_id, by: label, left: t.failNext[method]?.length ?? null });
        return method === "sendMessage" ? { message_id } : true;
      };
      const view = {
        label,
        getMe: async () => ({ id: Number(BOT_ID), is_bot: true, username: "owner_test_bot" }),
        getWebhookInfo: async () => ({ url: webhook }),
        getUpdates: ({ offset = 0, signal = null } = {}) => {
          t.getUpdatesCalls++;
          return new Promise((resolve, reject) => {
            if (active && active.view !== view) active.reject(Object.assign(new Error("Conflict: terminated by other getUpdates request"), { status: 409, code: 409, conflict: true }));
            const me = { view, reject };
            active = me;
            const done = (fn, v) => {
              waiters.delete(check);
              if (active === me) active = null;
              fn(v);
            };
            const check = () => {
              const ready = updates.filter((u) => u.update_id >= offset);
              if (!ready.length) return;
              if (t.hold) {
                waiters.delete(check);
                t.held.push(() => done(resolve, structuredClone(updates.filter((u) => u.update_id >= offset))));
                return;
              }
              done(resolve, structuredClone(ready));
            };
            me.reject = (e) => done(reject, e);
            waiters.add(check);
            signal?.addEventListener("abort", () => !t.hold && done(reject, Object.assign(new Error("aborted"), { aborted: true })), { once: true });
            const timer = setTimeout(() => done(resolve, []), 200);
            timer.unref?.();
            check();
          });
        },
        sendMessage: record("sendMessage"),
        editMessageText: record("editMessageText"),
        editMessageReplyMarkup: record("editMessageReplyMarkup"),
        answerCallbackQuery: record("answerCallbackQuery"),
        setMessageReaction: record("setMessageReaction"),
        setMyCommands: record("setMyCommands"),
        deleteMyCommands: record("deleteMyCommands"),
        // The bot's profile texts (hoptell telegram identity): a get returns what was last set.
        getMyName: async (params) => (await record("getMyName")(params), { name: t.profile.name }),
        getMyDescription: async (params) => (await record("getMyDescription")(params), { description: t.profile.description }),
        getMyShortDescription: async (params) => (await record("getMyShortDescription")(params), { short_description: t.profile.short_description }),
        setMyName: async (params) => (await record("setMyName")(params), (t.profile.name = params.name ?? ""), true),
        setMyDescription: async (params) => (await record("setMyDescription")(params), (t.profile.description = params.description ?? ""), true),
        setMyShortDescription: async (params) => (await record("setMyShortDescription")(params), (t.profile.short_description = params.short_description ?? ""), true),
        // The profile photo (identity --photo / --remove-photo): the uploaded JPG, or null.
        setMyProfilePhoto: async (params) => (await record("setMyProfilePhoto")(params), (t.profile.photo = params.jpeg), true),
        removeMyProfilePhoto: async (params) => (await record("removeMyProfilePhoto")(params), (t.profile.photo = null), true),
      };
      return view;
    },
    release() {
      t.hold = false;
      for (const f of t.held.splice(0)) f();
    },
  };
  return t;
}

/** A relay with the owner's member "me" (names me-*) and another member "bob". */
export async function ownerRelay(t, { ownerApp = false, appLimits = {} } = {}) {
  const tokens = { me: fakeToken(), bob: fakeToken() };
  let stateDir = null;
  if (ownerApp) {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "hoptell-owner-relay-"));
    t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  }
  const relay = await startRelay({ host: "127.0.0.1", port: 0, members: [{ name: "me", id: ME, token: tokens.me }, { name: "bob", id: BOB, token: tokens.bob }], realm: { id: REALM, name: "local" }, ...(ownerApp ? { ownerApp: { stateDir, limits: appLimits } } : {}), log: () => {} });
  t.after(() => relay.close());
  return { relay, tokens, stateDir, url: `ws://127.0.0.1:${relay.port}`, http: `http://127.0.0.1:${relay.port}` };
}

/** Turn the app on (or off, or rotate it) as the CLI does, with the bridge stopped. */
export const appSet = (home, action = "on", now = Date.now()) => changeOwnerApp(home, BOT_ID, action, now);

/** initData as Telegram makes it for the paired owner (fields override), signed with the test bot token. */
export function initData(fields = {}, token = BOT_TOKEN) {
  return signInitData(token, { auth_date: String(Math.floor(Date.now() / 1000)), query_id: `AA${crypto.randomBytes(6).toString("hex")}`, user: { id: OWNER_USER, first_name: "Owner", is_bot: false }, ...fields });
}

/** A plain HTTP request to the relay: {status, headers, body, json}. */
export function httpRequest(base, p, { method = "GET", headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(base);
    const data = body === null ? null : typeof body === "string" ? body : JSON.stringify(body);
    const req = http.request({ host: u.hostname, port: u.port, method, path: p, headers: { ...(data !== null ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {}), ...headers } }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {}
        resolve({ status: res.statusCode, headers: res.headers, body: text, json });
      });
    });
    req.on("error", reject);
    if (data !== null) req.write(data);
    req.end();
  });
}

/** The app's API of a bridge, through the relay: open(), get(path), post(path, body). */
export function appClient(base, appId) {
  const c = {
    token: null,
    url: (p) => `/app/${appId}/${p}`,
    async open(raw = initData()) {
      const r = await httpRequest(base, c.url("api/session"), { method: "POST", body: { init_data: raw } });
      if (r.status === 200) c.token = r.json.token;
      return r;
    },
    get: (p, token = c.token) => httpRequest(base, c.url(`api/${p}`), { headers: token ? { authorization: `Bearer ${token}` } : {} }),
    post: (p, body, token = c.token, headers = {}) => httpRequest(base, c.url(`api/${p}`), { method: "POST", body, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers } }),
  };
  return c;
}
/** A new op id, as the page makes one (16 random bytes, base64url). */
export const newOp = () => crypto.randomBytes(16).toString("base64url");

export const tmpHome = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hoptell-owner-"));
  t?.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

/** Pair `home` directly (as `pair` and `/start <code>` would). */
export function paired(home, { user = OWNER_USER, chat = OWNER_CHAT, id = "p_abcdefghijklmnop" } = {}) {
  sig.ensureChannelDir(home);
  sig.writePrivateJson(sig.channelPaths(home).pairing, { v: 1, bot_id: BOT_ID, pending: null, paired: { user_id: user, chat_id: chat, id, at: 1_700_000_000_000 } });
}

/** An agent session of a member: collects messages (confirmed at once) and sends questions. */
export async function agent(t, url, token, name) {
  const c = new RelayClient({ url, token, name, reconnect: false });
  const got = [];
  c.on("message", (m, confirm) => {
    got.push(m);
    confirm();
  });
  t.after(() => c.close());
  await c.start().ready();
  return {
    client: c,
    got,
    async ask(question, { choices = [], expiresIn = 3600, now = Date.now() } = {}) {
      const text = sig.questionEnvelope({ question, choices, askedAt: now, expiresAt: now + expiresIn * 1000 });
      const ack = await c.send("me-owner", text, expiresIn, undefined, { toMember: ME });
      return ack.message_id;
    },
    async waitFor(pred, ms = 4000) {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        const m = got.find(pred);
        if (m) return m;
        await sleep(20);
      }
      throw new Error(`no matching message; got ${got.length}: ${got.map((m) => m.text.slice(0, 60)).join(" | ")}`);
    },
  };
}

/** A bridge on `home` with the fake client; returns {bridge, run (the start promise)}. */
export function bridgeOn(t, { home, telegram, url, token, key, name = "me-owner", ...opts }) {
  // The test relay is ws://127.0.0.1: the app's public origin is given, as HOPTELL_APP_URL would.
  const appUrl = `https://127.0.0.1:${new URL(url).port}`;
  const bridge = createBridge({ home, telegram, relay: { url, token }, alias: "local", namePrefix: "me-", name, key, botId: BOT_ID, appKey: APP_KEY, appUrl, pollTimeout: 1, tickMs: 60_000, retryMs: 100, ...opts });
  const run = bridge.start();
  t.after(() => bridge.stop());
  return { bridge, run };
}

export async function until(pred, ms = 4000, what = "condition") {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await pred()) return;
    await sleep(20);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Set fields of people.json entries (favourites, aliases, hidden) for the paired owner, as the CLI would. */
export async function setPeople(home, names, fields = { fav: true }, { member = ME, owner = OWNER_USER } = {}) {
  await updatePeople(home, { member, owner }, (sessions, entry) => {
    for (const n of names) Object.assign(entry(n), fields);
  });
}
export const peopleOf = (home, { member = ME, owner = OWNER_USER } = {}) => readPeople(home, { member, owner }).sessions;

export const pinOf = (key, name = "me-owner") => ({ name, keys: [{ id: sig.keyIdOf(key.pub), pub: key.pub }] });
export const newKey = () => sig.newKey();
export const randomId = () => crypto.randomUUID();

// ---- owner-visible texts (design 7.3, section 1; 7.4, section 7) ----

const BANNED = /\b(relay|member|envelope|instruction|instructions|pairing|digest)\b/i;
/** The problems of one owner-visible text ([] when it is clean). */
export function textProblems(text, { alias = "local", prefix = "me-" } = {}) {
  const out = [];
  if (BANNED.test(text)) out.push(`a banned word (${text.match(BANNED)[0]})`);
  if (/\bref\b/i.test(text)) out.push("a reference");
  if (/[0-9a-f]{8,}/i.test(text.replace(/[^0-9a-fA-F]+/g, " ").replace(/\b[a-fA-F]{8,}\b/g, ""))) out.push("a hex run");
  if (/[0-9a-f]{8}-[0-9a-f]{4}-/i.test(text)) out.push("a UUID");
  if (/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(text)) out.push("an ISO timestamp");
  if (prefix && new RegExp(`(^|[^A-Za-z0-9_-])${prefix}`).test(text)) out.push("a wire-name prefix");
  if (alias && new RegExp(`\\b${alias}\\b`).test(text)) out.push("the relay alias");
  return out;
}

