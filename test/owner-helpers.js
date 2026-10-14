// Test seams for the owner channel (design 7.2): a fake Bot API shared by every bridge that uses
// "the same token", a relay with the owner's member ("me", as on the local relay) and another
// member, and agents that ask and receive. No network beyond 127.0.0.1, no real bot.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startRelay } from "../lib/relay.js";
import { RelayClient } from "../lib/client.js";
import { createBridge } from "../lib/ownerchannel.js";
import * as sig from "../lib/ownersig.js";
import { fakeToken, sleep } from "./helpers.js";

export const ME = "m_mmmmmmmmmmmmmmmmmmmmmmmmmm";
export const BOB = "m_bbbbbbbbbbbbbbbbbbbbbbbbbb";
export const REALM = "a".repeat(32);
export const OWNER_USER = 5550001;
export const OWNER_CHAT = 5550001;
export const BOT_ID = "7000001";

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
    hold: false, // tests: getUpdates ignores aborts and waits for release()
    held: [],
    failNext: {}, // tests: {method: [status, ...]}
    holdCalls: new Set(), // tests: methods whose calls wait for releaseCalls()
    heldCalls: [],
    ignoreAbort: false,
    aborted: [],
    releaseCalls() {
      t.holdCalls.clear();
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
    cards: () => sent.filter((s) => s.method === "sendMessage" && /asks:\n/.test(s.params.text)),
    texts: () => sent.filter((s) => s.method === "sendMessage").map((s) => s.params.text),
    replyTo: (card) => ({ message_id: card.message_id, text: card.params.text }),
    client(label = "bridge") {
      const record = (method) => async (params, { signal = null } = {}) => {
        // Tests: a refusal or failure for the next call(s) of a method, as an HTTP status.
        const status = t.failNext[method]?.shift();
        if (status) throw Object.assign(new Error(`Telegram ${method}: ${status}`), { status, ...(status === 429 ? { retryAfter: 1 } : {}) });
        if (t.holdCalls.has(method)) {
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
        const message_id = method === "sendMessage" ? nextMessage++ : undefined;
        sent.push({ method, params: structuredClone(params), message_id, by: label });
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
        setMyCommands: record("setMyCommands"),
        deleteMyCommands: record("deleteMyCommands"),
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
export async function ownerRelay(t) {
  const tokens = { me: fakeToken(), bob: fakeToken() };
  const relay = await startRelay({ host: "127.0.0.1", port: 0, members: [{ name: "me", id: ME, token: tokens.me }, { name: "bob", id: BOB, token: tokens.bob }], realm: { id: REALM, name: "local" }, log: () => {} });
  t.after(() => relay.close());
  return { relay, tokens, url: `ws://127.0.0.1:${relay.port}` };
}

export const tmpHome = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hoptell-owner-"));
  t?.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

/** Pair `home` directly (as `pair` and `/start <code>` would). */
export function paired(home, { user = OWNER_USER, chat = OWNER_CHAT } = {}) {
  sig.ensureChannelDir(home);
  sig.writePrivateJson(sig.channelPaths(home).pairing, { v: 1, bot_id: BOT_ID, pending: null, paired: { user_id: user, chat_id: chat, id: "p_abcdefghijklmnop", at: 1_700_000_000_000 } });
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
  const bridge = createBridge({ home, telegram, relay: { url, token }, alias: "local", namePrefix: "me-", name, key, botId: BOT_ID, pollTimeout: 1, tickMs: 60_000, retryMs: 100, ...opts });
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

export const pinOf = (key, name = "me-owner") => ({ name, keys: [{ id: sig.keyIdOf(key.pub), pub: key.pub }] });
export const newKey = () => sig.newKey();
export const randomId = () => crypto.randomUUID();
