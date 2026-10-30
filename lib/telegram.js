// A minimal Telegram Bot API client for the owner channel (design 7.2): getMe, getWebhookInfo,
// getUpdates, sendMessage, editMessageText, editMessageReplyMarkup, answerCallbackQuery,
// setMessageReaction, setMyCommands and deleteMyCommands, over the global fetch; sendDocument (a
// landing's frozen patch, design 8 addendum option 3, uploaded as multipart/form-data); and the bot's
// profile texts (get/setMyName, get/setMyDescription, get/setMyShortDescription) and its profile
// photo (setMyProfilePhoto, a JPG uploaded as multipart/form-data; removeMyProfilePhoto), which
// only the owner-run `hoptell telegram identity` command uses (design 7.3, section 4).
//
// The origin is fixed: there is no setting that changes it, so a stored bot token is never sent to
// another host. Redirects are errors, every call has a deadline, and nothing this module reports
// (errors included) carries the token: the URL is built only here, and every text that leaves
// passes through redact(). Tests inject a whole fake client (ownerchannel.createBridge), not a URL.

export const API_ORIGIN = "https://api.telegram.org";
const TOKEN_RE = /^(\d{1,20}):[A-Za-z0-9_-]{30,80}$/;
const CALL_TIMEOUT_MS = 15_000;
const UPLOAD_TIMEOUT_MS = 60_000; // a photo or document upload's deadline
const POLL_EXTRA_MS = 10_000; // a long poll's deadline: its timeout plus this
const MAX_RESPONSE = 4 * 1024 * 1024;
/** The largest profile photo `setMyProfilePhoto` uploads (design 7.3, section 4). */
export const PHOTO_MAX = 2 * 1024 * 1024;
/** The largest document `sendDocument` uploads (a landing's patch is far smaller). */
export const DOCUMENT_MAX = 1024 * 1024;
/** A JPG starts with the SOI marker and a marker segment (FF D8 FF). */
export const isJpeg = (b) => Buffer.isBuffer(b) && b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;

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

  // `form` (multipart/form-data, a file upload) replaces the JSON body; fetch sets its boundary.
  async function call(method, params = {}, { signal = null, deadlineMs = timeoutMs, form = null } = {}) {
    const url = `${API_ORIGIN}/bot${token}/${method}`;
    const signals = [AbortSignal.timeout(deadlineMs), ...(signal ? [signal] : [])];
    const body = form ? { body: form } : { headers: { "content-type": "application/json" }, body: JSON.stringify(params) };
    let r;
    let text;
    try {
      r = await fetchImpl(url, { method: "POST", ...body, redirect: "error", signal: AbortSignal.any(signals) });
      text = await readBounded(r);
    } catch (e) {
      // fetch errors may name the URL, in the message or in their cause: neither is copied out unredacted.
      const why = [e?.message, e?.cause?.code, e?.cause?.message].filter(Boolean).join(": ");
      throw new TelegramError(redact(`Telegram ${method} failed: ${why || "network error"}`, token), { aborted: Boolean(signal?.aborted), network: true });
    }
    let res = null;
    try {
      res = JSON.parse(text);
    } catch {
      // not JSON: reported by status below
    }
    if (!r.ok || res?.ok !== true) {
      const description = typeof res?.description === "string" ? res.description.slice(0, 200) : `HTTP ${r.status}`;
      const retryAfter = Number.isSafeInteger(res?.parameters?.retry_after) ? res.parameters.retry_after : null;
      throw new TelegramError(redact(`Telegram ${method} refused: ${description}`, token), { status: r.status, code: Number.isSafeInteger(res?.error_code) ? res.error_code : null, retryAfter });
    }
    return res.result;
  }

  /**
   * The bot's profile photo: `jpeg` (a Buffer holding a JPG, at most PHOTO_MAX bytes) is uploaded
   * as a new file, as InputProfilePhotoStatic requires ("attach://" names the form part).
   */
  async function setMyProfilePhoto({ jpeg } = {}, o = {}) {
    if (!isJpeg(jpeg)) throw new Error("the profile photo must be a JPG file");
    if (jpeg.length > PHOTO_MAX) throw new Error(`the profile photo is too large: ${jpeg.length} bytes, the limit is ${PHOTO_MAX}`);
    const form = new FormData();
    form.set("photo", JSON.stringify({ type: "static", photo: "attach://hoptell_photo" }));
    form.set("hoptell_photo", new Blob([jpeg], { type: "image/jpeg" }), "photo.jpg");
    return call("setMyProfilePhoto", {}, { deadlineMs: UPLOAD_TIMEOUT_MS, ...o, form });
  }

  /**
   * A document in a chat: `document` {name, bytes (a Buffer, at most DOCUMENT_MAX)} is uploaded as
   * a new file, sent as plain text (text/plain) with Telegram's own content-type detection off.
   * Other parameters (chat_id, reply_parameters, disable_notification) go as form fields.
   */
  async function sendDocument({ document, ...params } = {}, o = {}) {
    if (!document || !Buffer.isBuffer(document.bytes) || typeof document.name !== "string") throw new Error("sendDocument needs a document {name, bytes}");
    if (document.bytes.length > DOCUMENT_MAX) throw new Error(`the document is too large: ${document.bytes.length} bytes, the limit is ${DOCUMENT_MAX}`);
    const form = new FormData();
    for (const [k, v] of Object.entries(params)) if (v !== undefined) form.set(k, typeof v === "object" ? JSON.stringify(v) : String(v));
    form.set("disable_content_type_detection", "true");
    form.set("document", new Blob([document.bytes], { type: "text/plain" }), document.name);
    return call("sendDocument", {}, { deadlineMs: UPLOAD_TIMEOUT_MS, ...o, form });
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
    /** A reaction on a message (the bridge sets 👍 on the owner's message once it was sent). */
    setMessageReaction: (params, o) => call("setMessageReaction", params, o),
    /** The command menu of one scope (the bridge uses only the paired chat's scope). */
    setMyCommands: (params, o) => call("setMyCommands", params, o),
    deleteMyCommands: (params, o) => call("deleteMyCommands", params, o),
    // The bot's profile texts: read by `identity`, set only by `identity --apply`, never by the bridge.
    getMyName: (params = {}, o) => call("getMyName", params, o),
    getMyDescription: (params = {}, o) => call("getMyDescription", params, o),
    getMyShortDescription: (params = {}, o) => call("getMyShortDescription", params, o),
    setMyName: (params, o) => call("setMyName", params, o),
    setMyDescription: (params, o) => call("setMyDescription", params, o),
    setMyShortDescription: (params, o) => call("setMyShortDescription", params, o),
    setMyProfilePhoto,
    sendDocument,
    removeMyProfilePhoto: (params = {}, o) => call("removeMyProfilePhoto", params, o),
  };
}
