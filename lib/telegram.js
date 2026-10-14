// A minimal Telegram Bot API client for the owner channel (design 7.2): getMe, getWebhookInfo,
// getUpdates, sendMessage, editMessageText, editMessageReplyMarkup, answerCallbackQuery,
// setMyCommands and deleteMyCommands, over the global fetch.
//
// The origin is fixed: there is no setting that changes it, so a stored bot token is never sent to
// another host. Redirects are errors, every call has a deadline, and nothing this module reports
// (errors included) carries the token: the URL is built only here, and every text that leaves
// passes through redact(). Tests inject a whole fake client (ownerchannel.createBridge), not a URL.

export const API_ORIGIN = "https://api.telegram.org";
const TOKEN_RE = /^(\d{1,20}):[A-Za-z0-9_-]{30,80}$/;
const CALL_TIMEOUT_MS = 15_000;
const POLL_EXTRA_MS = 10_000; // a long poll's deadline: its timeout plus this
const MAX_RESPONSE = 4 * 1024 * 1024;

/** Whether `token` has the form of a bot token ("<bot id>:<secret>"). */
export const isBotToken = (token) => typeof token === "string" && TOKEN_RE.test(token);
/** The bot id of a token (its numeric prefix), as a string. */
export const botIdOf = (token) => (isBotToken(token) ? token.match(TOKEN_RE)[1] : null);

/**
 * Remove bot tokens from a text: the given token wherever it appears, and anything shaped like a
 * token or a bot URL path ("bot<id>:<secret>").
 */
export function redact(text, token = null) {
  let s = String(text ?? "");
  if (token) s = s.split(token).join("<token>");
  return s.replace(/\d{1,20}:[A-Za-z0-9_-]{30,80}/g, "<token>");
}

/** A failed Bot API call. `status`: the HTTP status (409: another poller); `aborted`: cancelled by the caller. */
export class TelegramError extends Error {
  constructor(message, { status = null, code = null, retryAfter = null, aborted = false, network = false } = {}) {
    super(message);
    Object.assign(this, { status, code, retryAfter, aborted, network });
  }
  /** Telegram says another process is polling this bot (or a webhook is set). */
  get conflict() {
    return this.status === 409 || this.code === 409;
  }
}

async function readBounded(r) {
  const reader = r.body?.getReader?.();
  if (!reader) return await r.text();
  const chunks = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > MAX_RESPONSE) {
      reader.cancel().catch(() => {});
      throw new Error("the response is too large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
}

/**
 * A client for one bot token. `fetchImpl` (tests of this module only) replaces the global fetch;
 * the URL it is given is always on API_ORIGIN.
 */
export function createTelegram(token, { fetchImpl = globalThis.fetch, timeoutMs = CALL_TIMEOUT_MS } = {}) {
  if (!isBotToken(token)) throw new Error("this is not a Telegram bot token (expected <bot id>:<secret>, as BotFather gives it)");
  const botId = botIdOf(token);

  async function call(method, params = {}, { signal = null, deadlineMs = timeoutMs } = {}) {
    const url = `${API_ORIGIN}/bot${token}/${method}`;
    const signals = [AbortSignal.timeout(deadlineMs), ...(signal ? [signal] : [])];
    let r;
    let text;
    try {
      r = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(params), redirect: "error", signal: AbortSignal.any(signals) });
      text = await readBounded(r);
    } catch (e) {
      // fetch errors may name the URL, in the message or in their cause: neither is copied out unredacted.
      const why = [e?.message, e?.cause?.code, e?.cause?.message].filter(Boolean).join(": ");
      throw new TelegramError(redact(`Telegram ${method} failed: ${why || "network error"}`, token), { aborted: Boolean(signal?.aborted), network: true });
    }
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      // not JSON: reported by status below
    }
    if (!r.ok || body?.ok !== true) {
      const description = typeof body?.description === "string" ? body.description.slice(0, 200) : `HTTP ${r.status}`;
      const retryAfter = Number.isSafeInteger(body?.parameters?.retry_after) ? body.parameters.retry_after : null;
      throw new TelegramError(redact(`Telegram ${method} refused: ${description}`, token), { status: r.status, code: Number.isSafeInteger(body?.error_code) ? body.error_code : null, retryAfter });
    }
    return body.result;
  }

  return {
    botId,
    getMe: (o) => call("getMe", {}, o),
    getWebhookInfo: (o) => call("getWebhookInfo", {}, o),
    /** A long poll; `signal` aborts it (the bridge lost its relay claim). */
    getUpdates: ({ offset, timeout = 50, signal = null } = {}) => call("getUpdates", { ...(offset ? { offset } : {}), timeout, allowed_updates: ["message", "callback_query"] }, { signal, deadlineMs: timeout * 1000 + POLL_EXTRA_MS }),
    sendMessage: (params, o) => call("sendMessage", params, o),
    editMessageText: (params, o) => call("editMessageText", params, o),
    editMessageReplyMarkup: (params, o) => call("editMessageReplyMarkup", params, o),
    answerCallbackQuery: (params, o) => call("answerCallbackQuery", params, o),
    /** The command menu of one scope (the bridge uses only the paired chat's scope). */
    setMyCommands: (params, o) => call("setMyCommands", params, o),
    deleteMyCommands: (params, o) => call("deleteMyCommands", params, o),
  };
}
