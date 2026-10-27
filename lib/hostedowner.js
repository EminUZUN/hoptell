// The hosted owner page (design 4.5, "Hosted owner page"): owner decisions for a hosted tenant on
// https://<authority>/owner, through the 3.4 decision service on the tenant's home (contacts and
// pending decisions); the tenant's published grants and the relay's contact requests are shown
// only, as in 3.4 v2.
//
// Login: OpenID Connect authorization code with PKCE (S256), `state` (32 random bytes) and a
// `nonce`, with a separate pre-registered client and the exact redirect URI
// https://<authority>/owner/callback. GET /owner/login stores the login record server-side under
// a login id (10 minutes) and sets only that id in `__Host-hoptell-login` (SameSite=Lax: the
// provider's redirect back is a cross-site navigation). The callback requires that cookie, a
// matching unexpired record and the exact state; the record is consumed whatever the outcome. An
// `iss` parameter (RFC 9207) must equal the expected issuer. The ID token (issuer, audience = the
// owner client, nonce, lifetime) gives (issuer, subject), which must map through the link table.
// Any failure: 403, no session, the login cookie cleared.
//
// Session: a new id on every login in `__Host-hoptell-owner` (SameSite=Strict), 15 idle minutes,
// 8 hours at most, held server-side with (issuer, subject, tenant, link generation). Every request
// checks that the link table still maps exactly that identity to that member with that
// generation, so unlinking, relinking either way or removing the member ends it. Login records and
// sessions are kept in memory only: a restart signs every owner out.
//
// Requests: the exact Host (checked before), POST only with the public Origin and, when sent,
// Sec-Fetch-Site same-origin; changes only by form-encoded POST (64 KB at most) with per-form
// tokens; no JavaScript; a strict CSP. GET starts no decision or setting change (a read may
// complete a journal recovery of a change already authorized), except that /owner/login and
// /owner/callback create or consume login state.
import crypto from "node:crypto";
import { LIMITS, SECURITY_HEADERS, attr, esc, same } from "./loopbackui.js";
import { iconFor, iconLinks } from "./icons.js";
import { canonicalize } from "./jcs.js";
import { contactsFile, readContacts } from "./contacts.js";
import * as decisions from "./decisions.js";
import { isLoopback } from "./oidc.js";
import { tenantHome } from "./hostedtenants.js";
import { KIND_TITLE } from "./ownerui.js";

const LOGIN_COOKIE = "__Host-hoptell-login";
const SESSION_COOKIE = "__Host-hoptell-owner";
const LOGIN_MS = 10 * 60_000;
const MAX_LOGINS = 10_000;
const MAX_SESSIONS = 10_000;
const newId = () => crypto.randomBytes(32).toString("base64url");
const ACTION_LABEL = { allow: "Allow future messages", "allow-once": "Allow these messages", block: "Block sender" };

const layout = (title, body, signedIn) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)} - hoptell (hosted)</title>${iconLinks("/owner")}</head><body><header><strong>hoptell (hosted)</strong>${signedIn ? ` <a href="/owner">Overview</a> <a href="/owner/pending">Pending</a> <a href="/owner/contacts">Contacts</a> <a href="/owner/grants">Grants</a>` : ""}</header><p><strong>⚠️ Hosted mode: the host can read your messages.</strong></p><main><h1>${esc(title)}</h1>${body}</main></body></html>`;

/**
 * The owner page for lib/hosted.js. `config.owner`: {issuer, clientId, clientSecret?} (the
 * owner-page client); `links` the link table; `tenants` (for the grants view and the guard);
 * `storage` the host's storage guard (owner decisions that add state are admission writes).
 * `openid` (tests) replaces openid-client.
 */
export function createOwnerPage({ config, stateDir, links, tenants = null, storage = null, log = () => {}, now = () => Date.now(), fetcher = null }) {
  if (!config.owner?.issuer || !config.owner?.clientId) throw new Error("owner must name the owner page's issuer and clientId");
  const origin = config.origin;
  const redirectUri = `${origin}/owner/callback`;
  const logins = new Map(); // login id -> {state, verifier, nonce, issuer, expires}
  const sessions = new Map(); // session id -> {issuer, subject, tenant, memberId, generation, created, last, key}
  let provider = null;

  async function openid() {
    const oidc = await import("openid-client");
    if (!provider) {
      provider = (async () => {
        const o = config.owner;
        const auth = o.clientSecret ? oidc.ClientSecretBasic(o.clientSecret) : oidc.None();
        const opts = { timeout: 10, ...(fetcher ? { [oidc.customFetch]: fetcher } : {}), ...(isLoopback(o.issuer) ? { execute: [oidc.allowInsecureRequests] } : {}) };
        const c = await oidc.discovery(new URL(o.issuer), o.clientId, o.clientSecret ? { client_secret: o.clientSecret } : undefined, auth, opts);
        oidc.enableNonRepudiationChecks(c); // the ID token's signature too, not only its claims
        return c;
      })();
      provider.catch(() => (provider = null));
    }
    return { oidc, c: await provider };
  }

  const cookieOf = (req, name) => {
    const m = new RegExp(`(?:^|;\\s*)${name.replace(/[-]/g, "\\-")}=([A-Za-z0-9_-]{43})(?:;|$)`).exec(req.headers.cookie ?? "");
    return m ? m[1] : null;
  };
  const setCookie = (name, value, { lax = false, maxAge }) => `${name}=${value}; Secure; HttpOnly; SameSite=${lax ? "Lax" : "Strict"}; Path=/; Max-Age=${maxAge}`;
  const clear = (name, lax) => setCookie(name, "", { lax, maxAge: 0 });
  const send = (res, status, title, body, headers = {}, signedIn = false) => {
    res.writeHead(status, { ...SECURITY_HEADERS, "Content-Security-Policy": "default-src 'none'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'", "Content-Type": "text/html; charset=utf-8", ...headers });
    res.end(layout(title, body, signedIn));
  };
  const refuse = (res, status, why, headers = {}) => send(res, status, "Refused", `<p>${esc(why)}</p>`, headers);

  /** The session of a request, re-checked against the link table (exact identity, member and generation). */
  function sessionOf(req) {
    const id = cookieOf(req, SESSION_COOKIE);
    const s = id ? sessions.get(id) : null;
    if (!s) return null;
    const t = now();
    let ok = t - s.last < LIMITS.sessionIdleMs && t - s.created < LIMITS.sessionMaxMs;
    if (ok) {
      try {
        const l = links.lookup(s.issuer, s.subject);
        ok = Boolean(l && l.member.id === s.memberId && l.generation === s.generation) && !links.removed(s.memberId);
      } catch {
        ok = false; // the table cannot be read: no owner session works
      }
    }
    if (!ok) {
      sessions.delete(id);
      return null;
    }
    s.last = t;
    return { id, ...s, home: tenantHome(stateDir, s.tenant) };
  }

  // ---- form tokens (per session) --------------------------------------------------------------------
  const mac = (key, parts) => crypto.createHmac("sha256", key).update(canonicalize(parts)).digest("base64url");
  const formToken = (s, kind, subject, token, allowed) => {
    const exp = now() + LIMITS.formMs;
    return `${exp}.${mac(s.key, [kind, subject, token ?? null, allowed, exp])}`;
  };
  const checkForm = (s, kind, subject, token, allowedText, ft) => {
    const m = /^(\d{13,15})\.([A-Za-z0-9_-]{43})$/.exec(ft ?? "");
    let allowed;
    try {
      allowed = JSON.parse(allowedText ?? "");
    } catch {
      return { problem: "the form is not one this page rendered" };
    }
    if (!m) return { problem: "the form is not one this page rendered" };
    const exp = Number(m[1]);
    if (!same(m[2], mac(s.key, [kind, subject, token ?? null, allowed, exp]))) return { problem: "the form is not one this page rendered for this session" };
    if (exp <= now() || exp > now() + LIMITS.formMs) return { problem: "the form expired; open the page again" };
    return { allowed };
  };

  // ---- login --------------------------------------------------------------------------------------------
  async function login(req, res) {
    const t = now();
    for (const [k, r] of logins) if (r.expires <= t) logins.delete(k);
    if (logins.size >= MAX_LOGINS) return refuse(res, 503, "Too many sign-ins in progress; try again shortly.");
    let o;
    try {
      o = await openid();
    } catch (e) {
      log(`owner page: the identity provider is not reachable (${e.code ?? e.message})`);
      return refuse(res, 503, "The identity provider is not reachable; try again later.");
    }
    const id = newId();
    const rec = { state: crypto.randomBytes(32).toString("base64url"), verifier: o.oidc.randomPKCECodeVerifier(), nonce: o.oidc.randomNonce(), issuer: config.owner.issuer, expires: t + LOGIN_MS };
    logins.set(id, rec);
    const to = o.oidc.buildAuthorizationUrl(o.c, { redirect_uri: redirectUri, scope: "openid", code_challenge: await o.oidc.calculatePKCECodeChallenge(rec.verifier), code_challenge_method: "S256", state: rec.state, nonce: rec.nonce });
    res.writeHead(302, { ...SECURITY_HEADERS, location: to.href, "set-cookie": setCookie(LOGIN_COOKIE, id, { lax: true, maxAge: LOGIN_MS / 1000 }) }).end();
  }

  async function callback(req, res, url) {
    const lid = cookieOf(req, LOGIN_COOKIE);
    const rec = lid ? logins.get(lid) : null;
    if (lid) logins.delete(lid); // single use, whatever the outcome
    const fail = (why) => {
      log(`owner page: a sign-in was refused (${why})`);
      return refuse(res, 403, "The sign-in could not be accepted. Start again from the owner page.", { "set-cookie": clear(LOGIN_COOKIE, true) });
    };
    if (!rec) return fail("no login record");
    if (rec.expires <= now()) return fail("expired");
    const state = url.searchParams.get("state");
    if (typeof state !== "string" || !same(state, rec.state)) return fail("state");
    if (url.searchParams.has("iss") && url.searchParams.get("iss") !== rec.issuer) return fail("iss");
    if (url.searchParams.has("error")) return fail("provider error");
    let claims;
    try {
      const o = await openid();
      const tokens = await o.oidc.authorizationCodeGrant(o.c, new URL(`${redirectUri}${url.search}`), { pkceCodeVerifier: rec.verifier, expectedState: rec.state, expectedNonce: rec.nonce, idTokenExpected: true });
      claims = tokens.claims();
      if (!claims?.sub || claims.iss !== rec.issuer) throw new Error("no subject");
    } catch (e) {
      return fail(e.code ?? e.error ?? "the ID token was refused");
    }
    let l;
    try {
      l = links.lookup(claims.iss, claims.sub);
    } catch {
      return fail("the link table cannot be read");
    }
    if (!l) return send(res, 403, "Not linked", `<p>You signed in, but this identity is not linked to a hosted member. Give the host's administrator:</p><p>issuer: <code>${esc(claims.iss)}</code><br>subject: <code>${esc(claims.sub)}</code></p>`, { "set-cookie": clear(LOGIN_COOKIE, true) });
    // A new session id on every login; an earlier session of this browser ends.
    const old = cookieOf(req, SESSION_COOKIE);
    if (old) sessions.delete(old);
    if (sessions.size >= MAX_SESSIONS) {
      const oldest = [...sessions.entries()].sort((a, b) => a[1].last - b[1].last)[0];
      sessions.delete(oldest[0]);
    }
    const sid = newId();
    const { tenantKey } = await import("./hosted.js");
    sessions.set(sid, { issuer: claims.iss, subject: claims.sub, tenant: tenantKey(config.realm, l.member.id), memberId: l.member.id, generation: l.generation, created: now(), last: now(), key: crypto.randomBytes(32) });
    res.writeHead(303, { ...SECURITY_HEADERS, location: "/owner", "set-cookie": [setCookie(SESSION_COOKIE, sid, { maxAge: LIMITS.sessionMaxMs / 1000 }), clear(LOGIN_COOKIE, true)] }).end();
  }

  // ---- pages --------------------------------------------------------------------------------------------
  const when = (iso) => (iso ? esc(iso) : "-");
  function forms(s, shown) {
    if (shown.kind === "encryption-violation") return `<p>These messages were held because this contact requires encryption. They can't be released here. <a href="/owner/decision?id=${attr(encodeURIComponent(shown.view.request ?? ""))}">Open the contact request</a> to block the sender, or ask the host administrator to review your encryption settings.</p>`;
    if (!shown.actions.length) return `<p class="note">View only: no action is available here.</p>`;
    const allows = shown.actions.some((a) => a.action === "allow");
    const blocks = shown.actions.some((a) => a.action === "block");
    const intro = allows || blocks ? `<p>${allows ? "Allowing future messages also releases the messages shown here. " : ""}${blocks ? "Blocking deletes them." : ""}</p>` : "";
    return intro + shown.actions
      .map((a) => {
        const allowed = { action: a.action, options: a.options };
        const selects = Object.entries(a.options)
          .filter(([, v]) => v.length)
          .map(([k, values]) => `<label>${esc(k)} <select name="${attr(k)}"><option value="">all sessions</option>${values.map((v) => `<option value="${attr(v)}">${esc(v)}</option>`).join("")}</select></label> `)
          .join("");
        return `<form method="post" action="/owner/decide"><input type="hidden" name="id" value="${attr(shown.id)}"><input type="hidden" name="token" value="${attr(shown.token)}"><input type="hidden" name="action" value="${attr(a.action)}"><input type="hidden" name="allowed" value="${attr(JSON.stringify(allowed))}"><input type="hidden" name="ft" value="${attr(formToken(s, "decision", shown.id, shown.token, allowed))}">${selects}<button type="submit">${esc(ACTION_LABEL[a.action] ?? a.action)}</button></form>`;
      })
      .join("");
  }
  /** Only contact decisions are decidable here; grants and contact requests stay show-only. */
  const decidable = (shown) => (shown.kind === "contact" ? shown : { ...shown, actions: [] });

  async function getPage(s, url, res) {
    const p = url.pathname;
    const ok = (title, body) => send(res, 200, title, body, {}, true);
    if (p === "/owner" || p === "/owner/") {
      const items = await decisions.list({ home: s.home, kinds: ["contact", "encryption-violation"] });
      const n = items.length;
      return ok("Owner view", `<p>Hosted member <code>${esc(s.memberId)}</code>. ${n === 1 ? "1 item waits" : `${n} items wait`} for your decision: <a href="/owner/pending">Pending</a>.</p><form method="post" action="/owner/logout"><input type="hidden" name="ft" value="${attr(formToken(s, "logout", "", null, {}))}"><input type="hidden" name="allowed" value="{}"><button type="submit">Sign out</button></form>`);
    }
    if (p === "/owner/pending") {
      const items = await decisions.list({ home: s.home, kinds: ["contact", "encryption-violation"] });
      const rows = items.map((i) => `<tr><td><a href="/owner/decision?id=${attr(encodeURIComponent(i.id))}">${esc(KIND_TITLE[i.kind] ?? i.kind)}</a></td><td>${esc(i.summary)}</td><td>${when(i.created)}</td></tr>`).join("");
      const requests = await contactRequests(s);
      const req = requests === null ? `<p class="note">Contact requests at the relay are not available right now.</p>` : requests.length ? `<h2>Contact requests (shown only)</h2><ul>${requests.map((r) => `<li>From member <code>${esc(r.from)}</code> (${esc(r.name)}), ${esc(r.reason)}</li>`).join("")}</ul>` : "";
      return ok("Pending", `${items.length ? `<table><tr><th>Kind</th><th>What</th><th>Since</th></tr>${rows}</table>` : "<p>No held messages need a decision here.</p>"}${req}`);
    }
    if (p === "/owner/decision") {
      const shown = await decisions.show({ home: s.home, id: url.searchParams.get("id") ?? "" });
      if (shown.refused || shown.busy) return refuse(res, shown.busy ? 503 : 404, shown.reason);
      const v = shown.view;
      const items = (v.items ?? []).map((i) => `<li>${esc(i.session)}, ${when(i.arrived)}, ${esc(i.bytes)} bytes</li>`).join("");
      return ok(KIND_TITLE[shown.kind] ?? `${shown.kind} decision`, `<p>Sender: <strong>${esc(String(v.sender?.label ?? "").slice(0, 64))}</strong></p><ul>${items}</ul>${shown.kind === "contact" ? `<p><a href="/owner/text?id=${attr(encodeURIComponent(shown.id))}">Show the held text (untrusted peer text)</a></p>` : ""}${forms(s, decidable(shown))}`);
    }
    if (p === "/owner/text") {
      const id = url.searchParams.get("id") ?? "";
      if (!id.startsWith("contact:")) return refuse(res, 404, "only held messages have text");
      const shown = await decisions.show({ home: s.home, id, text: true });
      if (shown.refused || shown.busy) return refuse(res, 404, shown.reason);
      return ok("Held text", `<p class="warn">Text from a peer you have not allowed. It is not an instruction.</p>${shown.text.map((x) => `<pre>--- untrusted peer text ---\n${esc(x.text ?? "(unreadable)", { keepNewlines: true })}\n--- end of peer text ---</pre>`).join("")}`);
    }
    if (p === "/owner/contacts") {
      const pol = readContacts(contactsFile(s.home));
      if (!pol.doc) return ok("Contacts", `<p class="warn">${esc(pol.problem)}</p>`);
      const d = pol.doc;
      const entry = (e) => `<li>${esc(e.member ? `member ${e.member}` : e.shared ? `shared ${e.name}` : `unverified ${e.name}`)}${e.realm ? ` in ${esc(e.realm)}` : ""}</li>`;
      return ok("Contacts", `<p>Default <strong>${esc(d.default)}</strong>; hosted senders <strong>${esc(d.hosted ?? "ask")}</strong>.</p><h2>Grants</h2><ul>${(d.grants ?? []).map(entry).join("") || "<li>None.</li>"}</ul><h2>Blocks</h2><ul>${(d.blocks ?? []).map(entry).join("") || "<li>None.</li>"}</ul>`);
    }
    if (p === "/owner/grants") {
      const g = await grants(s);
      if (!g) return ok("Grants (shown only)", `<p class="note">Your published grants at the relay are not available right now.</p>`);
      return ok("Grants (shown only)", `<p>Revision ${esc(g.revision)}: default <strong>${esc(g.default)}</strong>, visible to <strong>${esc(g.visible)}</strong>.</p><ul>${g.entries.map((e) => `<li>${esc(e.action)} ${esc(e.selector)}${e.until ? ` until ${esc(new Date(e.until).toISOString())}` : ""}</li>`).join("") || "<li>No entries.</li>"}</ul><p class="note">Grants are shown only here.</p>`);
    }
    return refuse(res, 404, "no such page");
  }
  const relayOf = (s) => tenants?.runtime(s.tenant)?.engine?.link.relay ?? null;
  async function grants(s) {
    try {
      return (await relayOf(s)?.rpc({ type: "grants_get" }))?.grants ?? null;
    } catch {
      return null;
    }
  }
  async function contactRequests(s) {
    try {
      const r = relayOf(s);
      return r ? (await r.rpc({ type: "contact_requests" })).requests : null;
    } catch {
      return null;
    }
  }

  async function postPage(s, url, f, res) {
    if (url.pathname === "/owner/logout") {
      const c = checkForm(s, "logout", "", null, f.allowed, f.ft);
      if (c.problem) return refuse(res, 403, c.problem);
      sessions.delete(s.id);
      return send(res, 200, "Signed out", `<p>Signed out. <a href="/owner/login">Sign in again</a></p>`, { "set-cookie": clear(SESSION_COOKIE, false) });
    }
    if (url.pathname === "/owner/decide") {
      const c = checkForm(s, "decision", f.id, f.token, f.allowed, f.ft);
      if (c.problem) return refuse(res, 403, c.problem);
      const a = c.allowed;
      if (f.action !== a?.action || !String(f.id ?? "").startsWith("contact:")) return refuse(res, 403, "that action is not one this form offered");
      const options = {};
      if (f.session) {
        if (!Array.isArray(a.options?.session) || !a.options.session.includes(f.session)) return refuse(res, 403, "that session is not one this form offered");
        options.session = f.session;
      }
      if (Object.keys(f).some((k) => !["id", "token", "action", "allowed", "ft", "session"].includes(k))) return refuse(res, 400, "the form has fields it should not have");
      // Releasing held messages adds state (an admission write); a block only removes data.
      if (f.action !== "block") {
        const why = storage?.admitHost(64 * 1024);
        if (why) return refuse(res, 507, `The host's storage is full (${why}); a block still works.`);
      }
      const r = await decisions.decide({ home: s.home, id: f.id, action: f.action, token: f.token, options });
      if (r.done) return send(res, 200, "Done", `<p>${f.action === "block" ? "Blocked; its messages were deleted." : `Released ${esc(r.effects.steps)} message${r.effects.steps === 1 ? "" : "s"}.`}</p><p><a href="/owner/pending">Back to Pending</a></p>`, {}, true);
      if (r.stale) return refuse(res, 409, "Nothing was done: it changed since you looked. Open it again.");
      if (r.busy) return refuse(res, 503, "Another request is using this right now. Try again in a moment.");
      return refuse(res, 409, r.reason);
    }
    return refuse(res, 404, "no such form");
  }

  const readForm = (req) =>
    new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on("data", (c) => {
        size += c.length;
        if (size > LIMITS.bodyBytes) {
          req.removeAllListeners("data");
          req.pause();
          reject(Object.assign(new Error("the form is larger than 64 KB"), { status: 413 }));
        } else chunks.push(c);
      });
      req.on("end", () => {
        const p = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
        const out = {};
        for (const k of new Set(p.keys())) {
          if (p.getAll(k).length > 1) return reject(Object.assign(new Error("a field is repeated"), { status: 400 }));
          out[k] = p.get(k);
        }
        resolve(out);
      });
      req.on("error", reject);
    });

  return {
    /** Answer a request under /owner (the Host and the proxy's scheme are checked by the caller). */
    async handle(req, res, url) {
      if (!["GET", "POST"].includes(req.method)) return refuse(res, 405, "not supported");
      if (req.method === "GET") {
        const icon = iconFor(url.pathname, "/owner");
        if (icon) {
          res.writeHead(200, { ...SECURITY_HEADERS, "Content-Security-Policy": "default-src 'none'", ...icon.headers });
          return res.end(icon.body);
        }
        if (url.pathname === "/owner/login") return login(req, res);
        if (url.pathname === "/owner/callback") return callback(req, res, url);
        const s = sessionOf(req);
        if (!s) return send(res, url.pathname === "/owner" || url.pathname === "/owner/" ? 200 : 403, "Sign in", `<p><a href="/owner/login">Sign in</a> with the account linked to your hosted session to decide who may contact it.</p>`);
        return getPage(s, url, res);
      }
      // POST: the public origin only; Sec-Fetch-Site, when sent, same-origin.
      if (req.headers.origin !== origin) return refuse(res, 403, "requests from other sites are not accepted");
      if (req.headers["sec-fetch-site"] !== undefined && req.headers["sec-fetch-site"] !== "same-origin") return refuse(res, 403, "requests from other sites are not accepted");
      if (!/^application\/x-www-form-urlencoded\s*(;|$)/i.test(req.headers["content-type"] ?? "")) return refuse(res, 415, "send a form");
      const s = sessionOf(req);
      if (!s) return refuse(res, 403, "no session: sign in again");
      let f;
      try {
        f = await readForm(req);
      } catch (e) {
        res.on("finish", () => req.destroy());
        return refuse(res, e.status ?? 400, e.message, { connection: "close" });
      }
      return postPage(s, url, f, res);
    },
    sessions: () => sessions.size,
  };
}
