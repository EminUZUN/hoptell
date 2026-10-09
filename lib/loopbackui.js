// What every hoptell page on 127.0.0.1 shares (design 3.4, used by the owner UI, `hoptell ui`, and
// the relay admin's UI, `hoptell relay admin ui`): the security headers, the escaping of untrusted
// text, and the gate in front of every request.
//
// A browser on this machine is the client, so the 2.3 rules are adapted, never relaxed: the Host
// must be exactly 127.0.0.1:<port> (DNS rebinding; localhost is not accepted), every POST must
// carry the UI's own Origin, Sec-Fetch-Site must be same-origin on POST and not cross-site on
// GET. A single-use launch token (printed once, valid 60 s) opens the one session; its cookie is
// HttpOnly and SameSite=Strict, held in memory only, and ends after 15 idle minutes or 8 hours.
// GET /launch only consumes its token and creates the session; a prefetch never burns it.
import crypto from "node:crypto";

export const HOST = "127.0.0.1";
export const LIMITS = { launchMs: 60_000, sessionIdleMs: 15 * 60_000, sessionMaxMs: 8 * 3600_000, formMs: 10 * 60_000, idleExitMs: 30 * 60_000, bodyBytes: 64 * 1024 };

/** Headers on every response, whatever its status. */
export const SECURITY_HEADERS = {
  "Content-Security-Policy": "default-src 'none'; style-src 'self'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

// Control and bidirectional formatting characters, shown as visible escapes (U+202E as the text ‮): C0 except
// tab and newline (handled by the caller's choice), DEL and C1, the Arabic letter mark, zero-width
// and directional marks, line and paragraph separators, embeddings, overrides and isolates, the
// word joiner range and the byte-order mark.
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const INVISIBLE = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u061C\u200B-\u200F\u2028-\u202E\u2060-\u2069\uFEFF]/g;
const hex4 = (c) => `\\u${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}`;

/** Untrusted text made visible: control and bidi characters as escapes; newlines too unless kept. */
export function visible(s, { keepNewlines = false } = {}) {
  const out = String(s ?? "").replace(INVISIBLE, hex4);
  return keepNewlines ? out : out.replace(/[\t\n]/g, hex4);
}
/** HTML-escaped visible text. */
export const esc = (s, o) => visible(s, o).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
/** An HTML attribute value. */
export const attr = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Constant-time equality of two strings. */
export const same = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

/**
 * The gate of a loopback UI: one launch token at a time, one session, the request checks.
 * `cookie` names the session cookie; `methods` are the methods served (others: 405).
 * check(req, port) returns {url} or {status, why}; launch(req, url) consumes a launch token and
 * returns {cookie} (the Set-Cookie value) or {status, why}; sessionOf(req) the live session or null.
 */
export function createGate({ cookie, methods = ["GET", "POST"], now = () => Date.now() }) {
  let launch = null; // {token, expires}
  let session = null; // {id, key, created, last}
  let origin = null;
  const cookieRe = new RegExp(`(?:^|;\\s*)${cookie}=([A-Za-z0-9_-]{43})(?:;|$)`);
  return {
    setPort(port) {
      origin = `http://${HOST}:${port}`;
    },
    origin: () => origin,
    /** A new single-use launch link (60 s); the previous unused one stops working. */
    launchUrl() {
      launch = { token: crypto.randomBytes(32).toString("base64url"), expires: now() + LIMITS.launchMs };
      return `${origin}/launch?t=${launch.token}`;
    },
    check(req) {
      if (req.headers.host !== origin.slice("http://".length)) return { status: 403, why: `this page answers only at ${origin}` };
      if (req.method === "OPTIONS" || !methods.includes(req.method)) return { status: 405, why: "not supported" };
      let url;
      try {
        url = new URL(req.url, origin);
      } catch {
        return { status: 400, why: "bad request target" };
      }
      const site = req.headers["sec-fetch-site"];
      if (req.method !== "POST" && site === "cross-site") return { status: 403, why: "requests from other sites are not accepted" };
      if (req.method === "POST") {
        if (req.headers.origin !== origin) return { status: 403, why: "a form must come from this page" };
        if (site !== undefined && site !== "same-origin") return { status: 403, why: "a form must come from this page" };
      }
      return { url };
    },
    launch(req, url, again) {
      // Only a GET consumes it: a HEAD (a link check), a preview or a prefetch never burns it.
      if (req.method !== "GET") return { status: 405, why: "open the link itself" };
      if (/prefetch/i.test(String(req.headers["sec-purpose"] ?? "")) || /prefetch/i.test(String(req.headers.purpose ?? ""))) return { status: 403, why: "open the link itself" };
      const t = url.searchParams.get("t") ?? "";
      const l = launch;
      if (!l || !t || !same(t, l.token) || now() > l.expires) return { status: 403, why: `this launch link is used, expired or wrong: run ${again} again` };
      launch = null; // single use
      // One session at a time: a new launch ends the old one.
      session = { id: crypto.randomBytes(32).toString("base64url"), key: crypto.randomBytes(32), created: now(), last: now() };
      return { cookie: `${cookie}=${session.id}; HttpOnly; SameSite=Strict; Path=/` };
    },
    /** The session (null when there is none). */
    current: () => session,
    sessionOf(req) {
      if (!session) return null;
      const c = cookieRe.exec(req.headers.cookie ?? "");
      if (!c || !same(c[1], session.id)) return null;
      const t = now();
      if (t - session.last > LIMITS.sessionIdleMs || t - session.created > LIMITS.sessionMaxMs) {
        session = null;
        return null;
      }
      session.last = t;
      return session;
    },
  };
}
