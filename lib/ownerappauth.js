// initData checks for the owner channel's Mini App (design 7.4, section 4). Telegram signs the
// data it gives a Mini App with a key derived from the bot token; only the bridge holds the token,
// so only the bridge can check it. The bridge is given the derived key (appSecret), never the token.
// initDataUnsafe is never used: every value read here comes from the checked string.
import crypto from "node:crypto";

export const INIT_DATA_MAX = 4096;
export const AUTH_MAX_AGE_S = 600; // an initData opens a session within 10 minutes of its auth_date
export const AUTH_FUTURE_S = 60; // and not more than 60 seconds ahead of the bridge's clock
export const AFTER_CHANGE_S = 60; // and later than every revocation point + 60 seconds

/** The HMAC key for initData: HMAC_SHA256(key = "WebAppData", data = bot token). */
export const appSecret = (botToken) => crypto.createHmac("sha256", "WebAppData").update(String(botToken)).digest();

/** Compare two lowercase hex digests of 64 characters in constant time; anything else is false. */
export function hexEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || !/^[0-9a-f]{64}$/.test(a) || !/^[0-9a-f]{64}$/.test(b)) return false;
  return crypto.timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

/** Parse x-www-form-urlencoded: [[key, value]] decoded, or null (too long, a repeated key, bad encoding). */
export function parseForm(raw) {
  if (typeof raw !== "string" || !raw || raw.length > INIT_DATA_MAX) return null;
  const out = new Map();
  for (const part of raw.split("&")) {
    if (!part) continue;
    const i = part.indexOf("=");
    const dec = (s) => decodeURIComponent(s.replace(/\+/g, " "));
    let k;
    let v;
    try {
      k = dec(i < 0 ? part : part.slice(0, i));
      v = dec(i < 0 ? "" : part.slice(i + 1));
    } catch {
      return null;
    }
    if (out.has(k)) return null;
    out.set(k, v);
  }
  return out;
}

/** The data-check string: every field but `hash`, as key=value, sorted by key in byte order, joined by "\n". */
export function dataCheckString(fields) {
  const keys = [...fields.keys()].filter((k) => k !== "hash").sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  return keys.map((k) => `${k}=${fields.get(k)}`).join("\n");
}

/** The replay key of an initData: from what was authenticated, so a re-encoded copy has the same key. */
export const replayKeyOf = (botId, dcs, hash) => crypto.createHash("sha256").update(`hoptell-app-initdata/1\n${botId}\n${dcs}\n${hash}`).digest("hex");

const parseJson = (s) => {
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
};

/**
 * Check an initData string. `secret`: appSecret(token); `botId`; `user` and `chat`: the paired
 * Telegram user and chat ids; `since`: times (ms) the session must be newer than (the app's last
 * on or rotation, the pairing), each rounded down to seconds plus AFTER_CHANGE_S; `now` (ms).
 * Returns {ok: true, userId, authDate, replayKey} or {ok: false, reason}: "bad_hash" (malformed
 * too), "stale" (too old, in the future, or not after a change), "wrong_user", "wrong_chat".
 */
export function checkInitData(raw, { secret, botId, user, chat, since = [], now }) {
  const fields = parseForm(raw);
  if (!fields) return { ok: false, reason: "bad_hash" };
  const hash = fields.get("hash");
  if (!hash || !fields.has("auth_date") || !fields.has("user")) return { ok: false, reason: "bad_hash" };
  const dcs = dataCheckString(fields);
  const expected = crypto.createHmac("sha256", secret).update(dcs).digest("hex");
  if (!hexEqual(hash, expected)) return { ok: false, reason: "bad_hash" };
  const ad = fields.get("auth_date");
  if (!/^\d{1,12}$/.test(ad)) return { ok: false, reason: "bad_hash" };
  const authDate = Number(ad);
  const nowS = now / 1000;
  if (authDate > nowS + AUTH_FUTURE_S || nowS - authDate > AUTH_MAX_AGE_S) return { ok: false, reason: "stale" };
  for (const t of since) if (Number.isFinite(t) && !(authDate > Math.floor(t / 1000) + AFTER_CHANGE_S)) return { ok: false, reason: "stale", recent: true };
  const u = parseJson(fields.get("user"));
  if (!u || !Number.isSafeInteger(u.id) || String(u.id) !== String(user) || u.is_bot === true) return { ok: false, reason: "wrong_user" };
  if (fields.has("receiver")) return { ok: false, reason: "wrong_chat" };
  if (fields.has("chat")) {
    const c = parseJson(fields.get("chat"));
    if (!c || String(c.id) !== String(chat) || c.type !== "private") return { ok: false, reason: "wrong_chat" };
  }
  if (fields.has("chat_type") && !["sender", "private"].includes(fields.get("chat_type"))) return { ok: false, reason: "wrong_chat" };
  // start_param is never read.
  return { ok: true, userId: u.id, authDate, replayKey: replayKeyOf(botId, dcs, hash) };
}

/** Tests and tools: an initData string signed the way Telegram signs it. */
export function signInitData(botToken, fields) {
  const m = new Map(Object.entries(fields).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)]));
  const hash = crypto.createHmac("sha256", appSecret(botToken)).update(dataCheckString(m)).digest("hex");
  return [...m, ["hash", hash]].map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
}
