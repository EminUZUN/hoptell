// The Bot API client (lib/telegram.js): the fixed origin, redirects refused, deadlines, abortable
// long polls, errors and token redaction. Only an injected fetch; no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { API_ORIGIN, TelegramError, botIdOf, createTelegram, isBotToken, redact } from "../lib/telegram.js";

// Generated per run, so no token value is written in the source.
const TOKEN = `${1_000_000 + crypto.randomInt(1e6)}:${crypto.randomBytes(26).toString("base64url")}`;
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("token shape, bot id and redaction", () => {
  assert.equal(isBotToken(TOKEN), true);
  assert.equal(isBotToken("123:short"), false);
  assert.equal(botIdOf(TOKEN), TOKEN.split(":")[0]);
  assert.throws(() => createTelegram("not-a-token"), /not a Telegram bot token/);
  const s = redact(`GET https://api.telegram.org/bot${TOKEN}/getMe failed`, TOKEN);
  assert.equal(s.includes(TOKEN), false);
  assert.equal(s.includes(TOKEN.split(":")[1]), false);
  // Anything shaped like a token is removed, also without knowing it.
  const other = `42:${crypto.randomBytes(26).toString("base64url")}`;
  assert.equal(redact(`bot${other}`).includes(other.split(":")[1]), false);
});

test("every call goes to the fixed origin, as a POST with redirects refused", async () => {
  const calls = [];
  const tg = createTelegram(TOKEN, {
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return json({ ok: true, result: { id: Number(TOKEN.split(":")[0]), username: "owner_bot" } });
    },
  });
  assert.equal((await tg.getMe()).username, "owner_bot");
  await tg.sendMessage({ chat_id: 1, text: "hi" });
  await tg.setMyCommands({ commands: [{ command: "help", description: "Help" }], scope: { type: "chat", chat_id: 1 } });
  await tg.deleteMyCommands({ scope: { type: "chat", chat_id: 1 } });
  await tg.editMessageReplyMarkup({ chat_id: 1, message_id: 2, reply_markup: { inline_keyboard: [] } });
  assert.deepEqual(calls.slice(2).map((c) => new URL(c.url).pathname.split("/").at(-1)), ["setMyCommands", "deleteMyCommands", "editMessageReplyMarkup"]);
  for (const c of calls) {
    assert.ok(c.url.startsWith(`${API_ORIGIN}/bot`), "the fixed origin");
    assert.equal(new URL(c.url).origin, "https://api.telegram.org");
    assert.equal(c.init.redirect, "error");
    assert.equal(c.init.method, "POST");
    assert.ok(c.init.signal instanceof AbortSignal, "every call has a deadline");
  }
  assert.deepEqual(JSON.parse(calls[1].init.body), { chat_id: 1, text: "hi" });
  // No option changes the origin: the client takes only fetchImpl and a timeout.
  const tg2 = createTelegram(TOKEN, { fetchImpl: async (url) => (calls.push({ url }), json({ ok: true, result: [] })), baseUrl: "https://evil.example", apiBase: "https://evil.example" });
  await tg2.getUpdates({ offset: 5, timeout: 1 });
  assert.equal(new URL(calls.at(-1).url).origin, "https://api.telegram.org");
});

test("a fetch error never carries the token, in the message or its cause", async () => {
  const tg = createTelegram(TOKEN, {
    fetchImpl: async (url) => {
      throw new TypeError(`fetch failed for ${url}`, { cause: new Error(`connect ECONNREFUSED ${url}`) });
    },
  });
  const e = await tg.getMe().catch((x) => x);
  assert.ok(e instanceof TelegramError);
  assert.equal(e.network, true);
  assert.equal(e.message.includes(TOKEN), false);
  assert.equal(e.message.includes(TOKEN.split(":")[1]), false);
  assert.equal(String(e.stack).includes(TOKEN.split(":")[1]), false);
  assert.match(e.message, /<token>/);
});

test("API errors: 409 is a conflict, descriptions are redacted, retry_after is kept", async () => {
  let reply = json({ ok: false, error_code: 409, description: "Conflict: terminated by other getUpdates request" }, 409);
  const tg = createTelegram(TOKEN, { fetchImpl: async () => reply });
  const e = await tg.getUpdates({ timeout: 1 }).catch((x) => x);
  assert.equal(e.conflict, true);
  reply = json({ ok: false, error_code: 429, description: `Too Many Requests for bot${TOKEN}`, parameters: { retry_after: 7 } }, 429);
  const r = await tg.sendMessage({ chat_id: 1, text: "x" }).catch((x) => x);
  assert.equal(r.conflict, false);
  assert.equal(r.retryAfter, 7);
  assert.equal(r.message.includes(TOKEN.split(":")[1]), false);
  reply = new Response("<html>gateway</html>", { status: 502 });
  assert.match((await tg.getMe().catch((x) => x)).message, /HTTP 502/);
});

test("a long poll is aborted by the caller's signal", async () => {
  const tg = createTelegram(TOKEN, {
    fetchImpl: (_url, init) =>
      new Promise((_, reject) => {
        init.signal.addEventListener("abort", () => reject(init.signal.reason ?? new Error("aborted")), { once: true });
      }),
  });
  const ac = new AbortController();
  const p = tg.getUpdates({ offset: 1, timeout: 50, signal: ac.signal });
  setTimeout(() => ac.abort(), 20);
  const e = await p.catch((x) => x);
  assert.ok(e instanceof TelegramError);
  assert.equal(e.aborted, true);
});

test("a call that hangs ends at its deadline", async () => {
  const tg = createTelegram(TOKEN, {
    timeoutMs: 50,
    fetchImpl: (_url, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new Error("timeout")), { once: true })),
  });
  const keep = setInterval(() => {}, 1000); // AbortSignal.timeout does not keep the process alive
  const e = await tg.getMe().catch((x) => x);
  clearInterval(keep);
  assert.ok(e instanceof TelegramError);
  assert.equal(e.aborted, false);
});
