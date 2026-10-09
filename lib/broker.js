// Relay side of broker mode (design 1.7): the relay is an OpenID Connect client of the provider,
// the user signs in there in the browser, and the relay issues its own credential to the CLI.
// Two legs, each with its own PKCE, state and redirect: CLI -> relay (/oidc/<id>/authorize, a
// one-time code K for the CLI's loopback redirect, /oidc/<id>/token), relay -> provider
// (authorization code with PKCE, a nonce and full ID-token validation by openid-client).
//
// The credential: one-time codes hk_..., access tokens ha_... (memory only) and refresh tokens
// hr1_<family>.<generation>.<random>.<mac>, MAC-authenticated with a key in the state directory,
// so a genuine old generation proves a replay (the family is revoked) while a fabricated token
// revokes nothing. Families are kept durably in <state>/broker/families.json; every change is
// written (file and directory synced) before its answer. One relay process per state directory.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { writeDurable } from "./credentials.js";
import { OidcError, configIdentity, isLoopback } from "./oidc.js";

export const CLI_CLIENT = "hoptell-cli";
const SKEW_S = 60;
const PENDING_TTL_MS = 5 * 60_000;
const PENDING_MAX = 1000;
const PENDING_PER_ADDRESS = 20;
const CODE_TTL_MS = 60_000;
const CODES_MAX = 1000;
const FAMILIES_PER_MEMBER = 20;
const KEEP_ENDED_MS = 30 * 86400_000;
const ENDED_MAX = 10_000;
const BODY_MAX = 16 * 1024;
const TOKEN_RATE = { perAddress: 60, global: 600, windowMs: 60_000 };
const DOMAIN = Buffer.from("hoptell refresh v1", "ascii");

const b64u = (b) => Buffer.from(b).toString("base64url");
const sha = (s) => crypto.createHash("sha256").update(s).digest();
const digestHex = (s) => sha(s).toString("hex");
/** Canonical unpadded base64url of exactly `len` bytes, or null. */
function bytesOf(text, len) {
  if (typeof text !== "string" || !/^[A-Za-z0-9_-]+$/.test(text)) return null;
  const b = Buffer.from(text, "base64url");
  return b.length === len && b64u(b) === text ? b : null;
}
const eq = (a, b) => a.length === b.length && crypto.timingSafeEqual(a, b);


// ---- refresh tokens -----------------------------------------------------------------------------

const lenPrefixed = (...parts) => Buffer.concat(parts.flatMap((p) => [Buffer.from([(p.length >>> 24) & 255, (p.length >>> 16) & 255, (p.length >>> 8) & 255, p.length & 255]), p]));
const gen4 = (g) => Buffer.from([(g >>> 24) & 255, (g >>> 16) & 255, (g >>> 8) & 255, g & 255]);
const macOf = (key, family, generation, random) => crypto.createHmac("sha256", key).update(lenPrefixed(DOMAIN, family, gen4(generation), random)).digest();

/** Encode a refresh token (exported for the fixed test vector). */
export function encodeRefresh(key, family, generation, random) {
  return `hr1_${b64u(family)}.${generation}.${b64u(random)}.${b64u(macOf(key, family, generation, random))}`;
}

/** Parse and authenticate a refresh token: {family (b64u), generation, digest} or null. */
export function parseRefresh(key, token) {
  if (typeof token !== "string" || token.length > 200 || !token.startsWith("hr1_")) return null;
  const parts = token.slice(4).split(".");
  if (parts.length !== 4) return null;
  const [f, g, r, m] = parts;
  const family = bytesOf(f, 16);
  const random = bytesOf(r, 32);
  const mac = bytesOf(m, 32);
  if (!family || !random || !mac || !/^(0|[1-9][0-9]{0,9})$/.test(g)) return null;
  const generation = Number(g);
  if (generation > 2 ** 31 - 1) return null;
  if (!eq(mac, macOf(key, family, generation, random))) return null;
  return { family: f, generation, digest: digestHex(token) };
}

const randomToken = (prefix) => `${prefix}${b64u(crypto.randomBytes(32))}`;
const tokenOk = (t, prefix) => typeof t === "string" && t.startsWith(prefix) && Boolean(bytesOf(t.slice(prefix.length), 32));

// ---- strict parameter checks --------------------------------------------------------------------

/** The CLI's loopback redirect, exactly http://127.0.0.1:<port>/callback or http://[::1]:<port>/callback. */
export function exactRedirect(text) {
  if (typeof text !== "string" || text.length > 64) return null;
  const m = /^http:\/\/(127\.0\.0\.1|\[::1\]):([1-9][0-9]{0,4})\/callback$/.exec(text);
  return m && Number(m[2]) <= 65535 ? text : null;
}
const STATE_RE = /^[\x21-\x7e]{1,256}$/;
const CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;
const VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/;

/** Exactly these query parameters, each once; returns an object or null. */
function exactParams(search, names) {
  const p = new URLSearchParams(search);
  const keys = [...p.keys()];
  if (keys.length !== names.length || new Set(keys).size !== keys.length || !names.every((n) => p.has(n))) return null;
  return Object.fromEntries(names.map((n) => [n, p.get(n)]));
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const SAFE_HEADERS = { "cache-control": "no-store", pragma: "no-cache", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" };

/**
 * The client's private key as a Web Crypto signing key for private_key_jwt (openid-client needs a
 * CryptoKey): RS256 for RSA, ES256/ES384 for P-256/P-384, EdDSA for Ed25519.
 */
async function signingKey({ key, kid }) {
  const jwk = key.export({ format: "jwk" });
  const alg = jwk.kty === "RSA" ? { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } : jwk.kty === "EC" && ["P-256", "P-384"].includes(jwk.crv) ? { name: "ECDSA", namedCurve: jwk.crv } : jwk.kty === "OKP" && jwk.crv === "Ed25519" ? { name: "Ed25519" } : null;
  if (!alg) throw new Error("client.privateKeyFile: use an RSA, P-256, P-384 or Ed25519 key");
  const cryptoKey = await crypto.webcrypto.subtle.importKey("jwk", jwk, alg, false, ["sign"]);
  return kid ? { key: cryptoKey, kid } : cryptoKey;
}

// ---- the families file --------------------------------------------------------------------------

function validFamilies(doc) {
  if (doc?.v !== 1 || !doc.families || typeof doc.families !== "object" || Array.isArray(doc.families)) return false;
  for (const [id, f] of Object.entries(doc.families)) {
    if (!bytesOf(id, 16) || !f || typeof f !== "object") return false;
    const n = (x) => Number.isSafeInteger(x) && x >= 0;
    if (typeof f.memberId !== "string" || typeof f.issuer !== "string" || typeof f.issuerId !== "string" || typeof f.subject !== "string" || typeof f.configId !== "string") return false;
    if (!n(f.generation) || !n(f.created) || !n(f.idleUntil) || !n(f.maxUntil) || !n(f.reverifyAt) || !n(f.verifiedAt)) return false;
    if (typeof f.digest !== "string" || !/^[0-9a-f]{64}$/.test(f.digest)) return false;
    if (f.revoked !== null && !(f.revoked && typeof f.revoked.at === "number" && typeof f.revoked.why === "string")) return false;
  }
  return true;
}

/**
 * Create the broker. `issuers`: the configured broker issuers (lib/oidc.js). `members()` gives the
 * relay's current credentials (for links). `fence(families: Set<string>)` ends every connection of
 * those families now. Both can be given later with attach() (the relay does). Returns {attach,
 * handles(url), handle(req, res, addr), verifyAccess, reconcile, status, close}.
 */
export async function createBroker({ issuers, stateDir, members = () => [], fence = () => {}, log = () => {}, audit = () => {}, now = () => Date.now(), fetcher = undefined, fault = null }) {
  const oidc = await import("openid-client");
  const byId = new Map(issuers.map((i) => [i.id, i]));
  const dir = path.join(stateDir, "broker");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const keyFile = path.join(dir, "refresh.key");
  const familiesFile = path.join(dir, "families.json");

  // Startup: the refresh key and the families file. A missing or damaged key while broker state
  // exists, or an unreadable families file, disables broker issuance (never silently replaced).
  let disabled = null;
  let key = null;
  let doc = { v: 1, families: {} };
  if (fs.existsSync(familiesFile)) {
    try {
      const d = JSON.parse(fs.readFileSync(familiesFile, "utf8"));
      if (!validFamilies(d)) throw new Error("invalid");
      doc = d;
    } catch {
      disabled = `${familiesFile} cannot be read or is invalid; fix or remove it (removing ends every broker sign-in)`;
    }
  }
  if (fs.existsSync(keyFile)) {
    try {
      key = bytesOf(fs.readFileSync(keyFile, "utf8").trim(), 32); // 32 bytes as base64url text
      if (!key) throw new Error("damaged");
    } catch {
      key = null;
      disabled ??= `the broker refresh key ${keyFile} is damaged: run hoptell relay broker-reset (it ends every broker sign-in)`;
    }
  } else if (fs.existsSync(familiesFile)) {
    disabled ??= `the broker refresh key ${keyFile} is missing: run hoptell relay broker-reset (it ends every broker sign-in)`;
  } else {
    // First use: the key exists durably before any family or token is issued.
    const fresh = crypto.randomBytes(32);
    try {
      writeDurable(keyFile, `${b64u(fresh)}\n`, { fault });
      key = fresh;
    } catch (e) {
      disabled = `the broker refresh key ${keyFile} could not be created (${e.code ?? e.message}); broker sign-in stays off until the relay restarts`;
    }
  }
  if (disabled) log(`broker sign-in disabled: ${disabled}`);

  /** Change the families durably: the mutation runs on a copy, which replaces the state only once written. */
  /**
   * Change the families durably: the mutation runs on a copy, written with writeDurable. A failed
   * write throws with `outcome`: "unchanged" (provably before the replacement: the caller may
   * answer "nothing changed, try again"), "replaced" (the new state is on disk, its durability
   * unknown: adopted in memory, so memory and disk agree) or "unknown" (the file could not be
   * verified: nothing is issued until reconcileFile() finds the old or the new state). Only
   * "unchanged" is retryable for a client.
   */
  // Set when a write failed in a way that leaves the file's content unknown: nothing is issued
  // until reconcileFile() has read the file back and found the old or the new state.
  let uncertain = null; // {old text, new text, new doc}
  function commit(mutate) {
    if (uncertain && !reconcileFile()) throw Object.assign(new Error("the broker state is being reconciled"), { outcome: "unknown" });
    const next = structuredClone(doc);
    const result = mutate(next);
    const text = `${JSON.stringify(next)}\n`;
    const oldText = `${JSON.stringify(doc)}\n`;
    try {
      writeDurable(familiesFile, text, { fault });
    } catch (e) {
      // Three outcomes: definitely unchanged (before the replacement), replaced (the new state is in
      // place: adopted, durability unknown), or unknown (no phase, or an unexpected read-back).
      if (e.phase === "before-replace") throw Object.assign(e, { outcome: "unchanged" });
      if (e.phase === "after-replace" && readBack() === text) {
        doc = next;
        throw Object.assign(e, { outcome: "replaced" });
      }
      uncertain = { oldText, text, next };
      throw Object.assign(e, { outcome: "unknown" });
    }
    doc = next;
    return result;
  }
  function readBack() {
    try {
      fault?.("read-back", familiesFile);
      return fs.readFileSync(familiesFile, "utf8");
    } catch {
      return null;
    }
  }
  /** After an unknown outcome: adopt what the file holds, if it is the old or the new state. */
  function reconcileFile() {
    if (!uncertain) return true;
    const now = readBack();
    if (now === uncertain.text) doc = uncertain.next;
    else if (now !== uncertain.oldText) return false;
    uncertain = null;
    return true;
  }

  const pending = new Map(); // S2 -> record
  const codes = new Map(); // digest(K) -> record
  const access = new Map(); // digest(ha_) -> {memberId, issuerId, issuer, subject, family, generation, exp}
  const rate = { windowStart: now(), global: 0, perAddress: new Map() };
  const providers = new Map(); // issuer id -> Promise<openid-client Configuration>

  function provider(i) {
    if (!providers.has(i.id)) {
      const p = (async () => {
        const auth = i.client.privateKey ? oidc.PrivateKeyJwt(await signingKey(i.client.privateKey)) : oidc.ClientSecretBasic(i.client.clientSecret);
        const opts = { timeout: 10, ...(fetcher ? { [oidc.customFetch]: fetcher } : {}), ...(isLoopback(i.issuer) ? { execute: [oidc.allowInsecureRequests] } : {}) };
        const config = await oidc.discovery(new URL(i.issuer), i.client.clientId, i.client.clientSecret ? { client_secret: i.client.clientSecret } : undefined, auth, opts);
        // The ID token's signature is checked against the provider's keys too (openid-client
        // checks only the claims of a code-flow ID token unless this is enabled).
        oidc.enableNonRepudiationChecks(config);
        return config;
      })();
      providers.set(i.id, p);
      p.catch(() => providers.delete(i.id));
    }
    return providers.get(i.id);
  }

  const linkedMember = (issuer, subject) => members().find((c) => c.oidc?.some((l) => l.issuer === issuer && l.subject === subject)) ?? null;
  // A family is usable until it is revoked, idle, past its absolute expiry or past its
  // re-verification deadline; an ended family no longer counts toward the member's limit.
  const blocked = new Map(); // family id -> why: ended in memory, its durable revocation still to be written
  const active = (f, t = now(), id = null) => !f.revoked && !(id && blocked.has(id)) && t < f.idleUntil && t < f.maxUntil && t < f.reverifyAt;
  const activeFor = (memberId) => Object.entries(doc.families).filter(([id, f]) => f.memberId === memberId && active(f, now(), id)).length;
  /** The member the family belongs to may still use it: linked the same way, not signed out since. */
  const stillAllowed = (f) => {
    const c = linkedMember(f.issuer, f.subject);
    return Boolean(c && c.memberId === f.memberId && !(Number.isFinite(c.signedOutAt) && f.created <= c.signedOutAt));
  };

  /**
   * Revoke families: at once in memory (their access tokens dropped, the families refused, their
   * connections fenced), then durably. A failed write keeps them refused and is tried again by
   * the sweep; a restart applies member-based ends again from the members file.
   */
  /** Returns whether every requested family is now ended durably (true) or in memory only (false). */
  function revoke(ids, why) {
    const list = [...ids].filter((id) => doc.families[id] && !doc.families[id].revoked && !blocked.has(id));
    if (list.length) {
      const set = new Set(list);
      for (const id of list) blocked.set(id, why);
      for (const [k, a] of access) if (set.has(a.family)) access.delete(k);
      fence(set);
      log(`broker: ${list.length} sign-in(s) ended (${why})`);
    }
    // Already-blocked ids are written again here, never taken as done.
    if ([...ids].some((id) => blocked.has(id))) persistRevocations();
    return [...ids].every((id) => !doc.families[id] || (doc.families[id].revoked && !blocked.has(id)));
  }
  /** Write the revocations in effect but not yet durable; true when none remain. */
  function persistRevocations() {
    if (!blocked.size) return true;
    if (!reconcileFile()) return false;
    try {
      const at = now();
      commit((d) => {
        for (const [id, why] of blocked) if (d.families[id] && !d.families[id].revoked) d.families[id].revoked = { at, why };
      });
      blocked.clear();
      return true;
    } catch (e) {
      log(`broker: ending ${blocked.size} sign-in(s) could not be written yet (${e.message}); they stay refused, nothing new is issued, and the write is retried`);
      return false;
    }
  }

  // Families whose provider configuration changed (an issuer id removed, reused for another issuer
  // or client, or every broker issuer removed) end at startup, through the same path as any
  // revocation (in effect at once, written durably, again later if the write fails).
  if (!disabled) {
    const stale = Object.entries(doc.families).filter(([, f]) => !f.revoked && (!byId.has(f.issuerId) || configIdentity(byId.get(f.issuerId)) !== f.configId));
    if (stale.length) revoke(stale.map(([id]) => id), "provider configuration changed");
  }

  function issueAccess(id, f) {
    const t = now();
    const exp = Math.min(t + byId.get(f.issuerId).accessTokenSeconds * 1000, f.idleUntil, f.maxUntil, f.reverifyAt);
    const token = randomToken("ha_");
    access.set(digestHex(token), { memberId: f.memberId, issuerId: f.issuerId, issuer: f.issuer, subject: f.subject, family: id, generation: f.generation, exp });
    return { token, exp };
  }

  // Cleanup: expired pending records, codes and access tokens; ended families after 30 days.
  const sweep = setInterval(() => {
    const t = now();
    for (const [k, r] of pending) if (r.expires <= t) pending.delete(k);
    for (const [k, c] of codes) if (c.expires <= t) codes.delete(k);
    for (const [k, a] of access) if (a.exp <= t) access.delete(k);
    if (disabled) return;
    persistRevocations();
    const ended = Object.entries(doc.families).filter(([id, f]) => !active(f, t, id)).sort((a, b) => (a[1].revoked?.at ?? a[1].idleUntil) - (b[1].revoked?.at ?? b[1].idleUntil));
    const drop = ended.filter(([id, f], n) => !blocked.has(id) && (t - (f.revoked?.at ?? Math.min(f.idleUntil, f.maxUntil, f.reverifyAt)) > KEEP_ENDED_MS || ended.length - n > ENDED_MAX));
    if (drop.length) {
      try {
        commit((d) => {
          for (const [id] of drop) delete d.families[id];
        });
      } catch (e) {
        log("broker: cleanup could not be written:", e.message);
      }
    }
  }, 30_000);
  sweep.unref();

  // ---- HTTP -------------------------------------------------------------------------------------

  const page = (res, status, title, lines) =>
    res
      .writeHead(status, { ...SAFE_HEADERS, "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'none'" })
      .end(`<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title><h1>${escapeHtml(title)}</h1>${lines.map((l) => `<p>${escapeHtml(l)}</p>`).join("")}\n`);
  const json = (res, status, obj, extra = {}) => res.writeHead(status, { ...SAFE_HEADERS, "content-type": "application/json", ...extra }).end(JSON.stringify(obj));
  const oauthError = (res, status, error, description) => json(res, status, { error, ...(description ? { error_description: description } : {}) });

  function limited(addr) {
    const t = now();
    if (t - rate.windowStart > TOKEN_RATE.windowMs) {
      rate.windowStart = t;
      rate.global = 0;
      rate.perAddress.clear();
    }
    const n = (rate.perAddress.get(addr) ?? 0) + 1;
    rate.perAddress.set(addr, n);
    return ++rate.global > TOKEN_RATE.global || n > TOKEN_RATE.perAddress;
  }

  async function readForm(req) {
    if (!/^application\/x-www-form-urlencoded\b/i.test(req.headers["content-type"] ?? "")) throw Object.assign(new Error("send a form"), { status: 400, error: "invalid_request" });
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > BODY_MAX) throw Object.assign(new Error("request too large"), { status: 413, error: "invalid_request" });
      chunks.push(c);
    }
    const p = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
    const keys = [...p.keys()];
    if (new Set(keys).size !== keys.length) throw Object.assign(new Error("a parameter is repeated"), { status: 400, error: "invalid_request" });
    return Object.fromEntries(p);
  }

  async function authorize(i, url, res, addr) {
    const q = exactParams(url.search, ["response_type", "client_id", "redirect_uri", "code_challenge", "code_challenge_method", "state"]);
    if (!q || q.response_type !== "code" || q.client_id !== CLI_CLIENT || q.code_challenge_method !== "S256" || !CHALLENGE_RE.test(q.code_challenge) || !STATE_RE.test(q.state) || !exactRedirect(q.redirect_uri)) {
      return page(res, 400, "Sign-in request refused", ["This sign-in link is not valid. Run hoptell login again."]);
    }
    if (disabled) return page(res, 503, "Sign-in unavailable", ["Sign-in through this relay is disabled until its operator fixes its state."]);
    if (pending.size >= PENDING_MAX || [...pending.values()].filter((r) => r.addr === addr).length >= PENDING_PER_ADDRESS) return page(res, 429, "Too many sign-ins in progress", ["Finish or wait for the sign-ins already started, then try again."]);
    // The record takes its place in the bounded table before anything waits (provider discovery),
    // so concurrent requests cannot all pass the same check.
    const s2 = oidc.randomState();
    const v2 = oidc.randomPKCECodeVerifier();
    const nonce = oidc.randomNonce();
    pending.set(s2, { issuerId: i.id, configId: configIdentity(i), redirect: q.redirect_uri, c1: q.code_challenge, s1: q.state, v2, nonce, addr, expires: now() + PENDING_TTL_MS });
    let config;
    try {
      config = await provider(i);
    } catch (e) {
      pending.delete(s2);
      log(`broker: ${i.issuer} is not reachable (${e.code ?? e.message})`);
      return page(res, 503, "Identity provider unavailable", ["The relay could not reach the identity provider. Try again later."]);
    }
    const to = oidc.buildAuthorizationUrl(config, {
      redirect_uri: `${i.publicBaseUrl}/oidc/${i.id}/callback`,
      scope: i.scopes.join(" "),
      code_challenge: await oidc.calculatePKCECodeChallenge(v2),
      code_challenge_method: "S256",
      state: s2,
      nonce,
      ...(i.requireReauthentication ? { max_age: "0" } : {}),
    });
    res.writeHead(302, { ...SAFE_HEADERS, location: to.href }).end();
  }

  async function callback(i, url, res) {
    const state = url.searchParams.get("state");
    const r = state ? pending.get(state) : null;
    if (r) pending.delete(state); // consumed in every outcome
    if (!r || r.issuerId !== i.id || r.expires <= now() || r.configId !== configIdentity(i)) return page(res, 400, "Sign-in expired", ["This sign-in is not known or has expired. Run hoptell login again."]);
    if (url.searchParams.has("iss") && url.searchParams.get("iss") !== i.issuer) return page(res, 400, "Sign-in refused", ["The answer came from another identity provider."]);
    if (url.searchParams.has("error")) return page(res, 400, "Sign-in not completed", [`The identity provider answered: ${url.searchParams.get("error").slice(0, 100)}`]);
    let claims;
    try {
      const config = await provider(i);
      const current = new URL(`${i.publicBaseUrl}/oidc/${i.id}/callback${url.search}`);
      const tokens = await oidc.authorizationCodeGrant(config, current, { pkceCodeVerifier: r.v2, expectedState: state, expectedNonce: r.nonce, idTokenExpected: true, ...(i.requireReauthentication ? { maxAge: 0 } : {}) });
      claims = tokens.claims();
      if (!claims?.sub) throw new Error("no ID token subject");
      if (i.requireReauthentication && !(typeof claims.auth_time === "number" && Math.abs(claims.auth_time * 1000 - now()) <= SKEW_S * 1000)) throw new Error("the provider did not confirm a fresh sign-in");
    } catch (e) {
      log(`broker: a sign-in at ${i.issuer} was refused (${e.code ?? e.error ?? "invalid"})`);
      return page(res, 400, "Sign-in refused", ["The identity provider's answer could not be accepted. Run hoptell login again."]);
    }
    const member = linkedMember(i.issuer, claims.sub);
    if (!member) {
      return page(res, 403, "Not linked to a member", ["You signed in, but this identity is not linked to a member of this relay. Give your relay administrator these two values:", `issuer: ${i.issuer}`, `subject: ${claims.sub}`, `They link it with: hoptell members link <name> --issuer ${i.issuer} --subject ${claims.sub}`]);
    }
    if (activeFor(member.memberId) >= FAMILIES_PER_MEMBER) return page(res, 409, "Too many sign-ins", [`${member.member} is signed in on ${FAMILIES_PER_MEMBER} devices already: sign out elsewhere first (hoptell logout), then try again.`]);
    if (codes.size >= CODES_MAX) return page(res, 429, "Too many sign-ins in progress", ["Try again in a minute."]);
    // Group claims feed deny rules too (design 4.1): a set that cannot be kept whole is refused,
    // never cut short.
    const groups = Array.isArray(claims.groups) ? claims.groups.filter((g) => typeof g === "string") : [];
    if (groups.length > 100 || groups.some((g) => g.length > 255)) return page(res, 400, "Sign-in refused", ["Your account has more than 100 groups at the identity provider, or a group name longer than 255 characters; this relay cannot use them. Ask your relay administrator."]);
    const k = randomToken("hk_");
    codes.set(digestHex(k), { c1: r.c1, redirect: r.redirect, memberId: member.memberId, issuerId: i.id, issuer: i.issuer, subject: claims.sub, groups, verifiedAt: now(), configId: r.configId, expires: now() + CODE_TTL_MS });
    const to = new URL(r.redirect);
    to.searchParams.set("code", k);
    to.searchParams.set("state", r.s1);
    res.writeHead(302, { ...SAFE_HEADERS, location: to.href }).end();
  }

  function newFamily(c) {
    const i = byId.get(c.issuerId);
    const t = now();
    const familyBytes = crypto.randomBytes(16);
    const id = b64u(familyBytes);
    const random = crypto.randomBytes(32);
    const refresh = encodeRefresh(key, familyBytes, 0, random);
    const f = {
      memberId: c.memberId,
      issuer: c.issuer,
      issuerId: c.issuerId,
      providerClient: i.client.clientId,
      configId: c.configId,
      subject: c.subject,
      groups: c.groups ?? [],
      verifiedAt: c.verifiedAt,
      reverifyAt: c.verifiedAt + i.reverifyAfterSeconds * 1000,
      created: t,
      lastUsed: t,
      idleUntil: Math.min(t + i.familyIdleSeconds * 1000, t + i.familyMaxSeconds * 1000),
      maxUntil: t + i.familyMaxSeconds * 1000,
      generation: 0,
      digest: digestHex(refresh),
      revoked: null,
    };
    commit((d) => {
      if (d.families[id]) throw new Error("family id reused");
      d.families[id] = f;
    });
    return { id, f: doc.families[id], refresh };
  }

  function tokenResponse(res, id, f, refresh) {
    const a = issueAccess(id, f);
    return json(res, 200, { access_token: a.token, token_type: "Bearer", expires_in: Math.max(1, Math.floor((a.exp - now()) / 1000)), refresh_token: refresh, scope: "hoptell" });
  }

  function token(i, form, res) {
    if (form.client_id !== CLI_CLIENT) return oauthError(res, 401, "invalid_client");
    if (disabled) return oauthError(res, 503, "temporarily_unavailable", "broker sign-in is disabled on this relay until its operator fixes its state");
    // Nothing new is issued while the state is uncertain or a revocation is not yet written.
    if (!reconcileFile()) return oauthError(res, 503, "temporarily_unavailable", "the relay cannot read its state right now; try again later");
    if (!persistRevocations()) return oauthError(res, 503, "temporarily_unavailable", "the relay cannot record changes right now; try again later");
    if (form.grant_type === "authorization_code") {
      if (!tokenOk(form.code, "hk_")) return oauthError(res, 400, "invalid_grant");
      const k = digestHex(form.code);
      const c = codes.get(k);
      codes.delete(k); // the first redemption consumes it, whatever its outcome
      if (!c || c.issuerId !== i.id || c.expires <= now() || c.configId !== configIdentity(i)) return oauthError(res, 400, "invalid_grant");
      if (form.redirect_uri !== c.redirect || !VERIFIER_RE.test(form.code_verifier ?? "") || !eq(Buffer.from(b64u(sha(form.code_verifier))), Buffer.from(c.c1))) return oauthError(res, 400, "invalid_grant");
      const m = linkedMember(c.issuer, c.subject);
      if (!m || m.memberId !== c.memberId) return oauthError(res, 400, "invalid_grant", "the identity is no longer linked to that member");
      if (activeFor(c.memberId) >= FAMILIES_PER_MEMBER) return oauthError(res, 400, "invalid_grant", "too many active sign-ins for this member: sign out elsewhere first");
      const { id, f, refresh } = newFamily(c);
      return tokenResponse(res, id, f, refresh);
    }
    if (form.grant_type === "refresh_token") {
      const p = parseRefresh(key, form.refresh_token);
      if (!p) return oauthError(res, 400, "invalid_grant"); // fabricated or malformed: nothing changes
      const f = doc.families[p.family];
      if (!f || f.issuerId !== i.id || !active(f, now(), p.family)) return oauthError(res, 400, "invalid_grant");
      if (f.configId !== configIdentity(i)) {
        revoke([p.family], "provider configuration changed");
        return oauthError(res, 400, "invalid_grant");
      }
      if (p.generation < f.generation) {
        // A genuine old token: replay (RFC 9700 4.14.2). The whole family ends, durably; until that
        // is written it is refused in this process only, and the answer does not claim more.
        if (!revoke([p.family], "refresh token replay")) return oauthError(res, 500, "server_error", "the reuse was detected but could not be recorded yet");
        audit("broker.replay_revoked", { families: 1 }); // the relay admin's audit log (design 4.4)
        return oauthError(res, 400, "invalid_grant", "this sign-in was used elsewhere and has been ended: run hoptell login");
      }
      if (p.generation > f.generation || !eq(Buffer.from(p.digest), Buffer.from(f.digest))) return oauthError(res, 400, "invalid_grant");
      if (now() >= f.reverifyAt) return oauthError(res, 400, "invalid_grant", "a fresh sign-in is due: run hoptell login");
      if (!stillAllowed(f)) {
        revoke([p.family], "member removed, unlinked or signed out");
        return oauthError(res, 400, "invalid_grant");
      }
      const random = crypto.randomBytes(32);
      const generation = f.generation + 1;
      const refresh = encodeRefresh(key, Buffer.from(p.family, "base64url"), generation, random);
      const t = now();
      const i2 = byId.get(f.issuerId);
      try {
        commit((d) => {
          Object.assign(d.families[p.family], { generation, digest: digestHex(refresh), lastUsed: t, idleUntil: Math.min(t + i2.familyIdleSeconds * 1000, f.maxUntil) });
        });
      } catch (e) {
        log("broker: a renewal could not be recorded:", e.message);
        // Only a write that provably did not replace the file is retryable; replaced or unknown is an
        // unknown outcome (the client must not resend).
        if (e.outcome === "unchanged") return oauthError(res, 503, "temporarily_unavailable", "the relay could not record the renewal; try again");
        return oauthError(res, 500, "server_error", "the renewal's outcome is unknown");
      }
      // The old generation's access tokens stay valid until their own expiry (bounded); new ones carry the new generation.
      return tokenResponse(res, p.family, doc.families[p.family], refresh);
    }
    return oauthError(res, 400, "unsupported_grant_type");
  }

  function revocation(i, form, res) {
    if (form.client_id !== CLI_CLIENT) return oauthError(res, 401, "invalid_client");
    if (!disabled && typeof form.token === "string") {
      const p = parseRefresh(key, form.token);
      const f = p && doc.families[p.family];
      let durable = true;
      // A family still blocked (its end adopted or held in memory, not yet written) goes through
      // revoke() again: success only once the write and sync have completed.
      if (f && f.issuerId === i.id && (!f.revoked || blocked.has(p.family))) durable = revoke([p.family], "signed out");
      else if (tokenOk(form.token, "ha_")) {
        const a = access.get(digestHex(form.token));
        if (a && a.issuerId === i.id) durable = revoke([a.family], "signed out");
      }
      // Success only once the end is recorded; it is in effect in this process meanwhile.
      if (!durable) return oauthError(res, 503, "temporarily_unavailable", "the sign-out could not be recorded; try again");
    }
    // RFC 7009: the same answer whether or not the token existed.
    res.writeHead(200, SAFE_HEADERS).end();
  }

  async function handle(req, res, addr) {
    const url = new URL(req.url, "http://relay.invalid");
    const m = /^\/oidc\/([a-z0-9][a-z0-9-]{0,31})\/(authorize|callback|token|revoke)$/.exec(url.pathname);
    const i = m && byId.get(m[1]);
    if (!i) return json(res, 404, { error: "not_found" });
    try {
      if (m[2] === "authorize" && req.method === "GET") return await authorize(i, url, res, addr);
      if (m[2] === "callback" && req.method === "GET") return await callback(i, url, res);
      if ((m[2] === "token" || m[2] === "revoke") && req.method === "POST") {
        if (url.search) return oauthError(res, 400, "invalid_request", "parameters belong in the body");
        if (limited(addr)) return oauthError(res, 429, "slow_down");
        const form = await readForm(req);
        return m[2] === "token" ? token(i, form, res) : revocation(i, form, res);
      }
      return json(res, 405, { error: "method_not_allowed" });
    } catch (e) {
      if (e.status) return oauthError(res, e.status, e.error ?? "invalid_request", e.message);
      // A durable write that failed: nothing new was issued. Before the file was replaced nothing
      // changed (retryable); after it the outcome is unknown.
      log("broker: request failed:", e.message);
      if (!res.headersSent) e.outcome === "unchanged" ? oauthError(res, 503, "temporarily_unavailable", "the relay could not record the change; try again") : oauthError(res, 500, "server_error");
    }
  }

  return {
    /** The relay's members and connections; the loaded members are applied at once (startup). */
    attach(o) {
      if (o.members) members = o.members;
      if (o.fence) fence = o.fence;
      if (o.members) this.reconcile(members());
    },
    handles: (url) => /^\/oidc\//.test(url),
    /** Whether broker family `id` can still be used (queued messages of an ended family are dropped). */
    familyLive: (id) => {
      const f = doc.families[id];
      return Boolean(f) && active(f, now(), id);
    },
    handle,
    /**
     * An access token of broker issuer `issuerId`: {issuer, subject, memberId, family, deadline}.
     * Throws OidcError: unsupported_auth (no such broker), bad_token (not an access token),
     * token_expired (unknown, expired or ended: the client refreshes once).
     */
    verifyAccess(issuerId, token) {
      const i = byId.get(issuerId);
      if (!i) throw new OidcError("unsupported_auth", "this relay has no broker sign-in with that id");
      if (!tokenOk(token, "ha_")) throw new OidcError("bad_token", "not a broker access token");
      const a = access.get(digestHex(token));
      const f = a && doc.families[a.family];
      if (!a || a.issuerId !== issuerId || a.exp <= now() || !f || !active(f, now(), a.family)) throw new OidcError("token_expired", "the sign-in token expired");
      // The current members decide, also before a reconciliation could be written.
      if (!stillAllowed(f)) {
        revoke([a.family], "member removed, unlinked or signed out");
        throw new OidcError("token_expired", "the sign-in ended");
      }
      // verifiedAt, reverifyAt and groups feed the access claim view (design 4.1): the ID token's
      // groups at sign-in, fresh until the hard re-verification.
      return { issuer: a.issuer, issuerId, subject: a.subject, memberId: a.memberId, family: a.family, deadline: a.exp + SKEW_S * 1000, verifiedAt: f.verifiedAt, reverifyAt: f.reverifyAt, groups: f.groups ?? [] };
    },
    /**
     * After a members reload: families whose identity is no longer linked to the same member, of
     * removed members, or older than the member's signedOutAt, end now.
     */
    reconcile(creds) {
      if (disabled) return 0;
      const ended = Object.entries(doc.families).filter(([id, f]) => {
        if (f.revoked || blocked.has(id)) return false;
        const c = creds.find((x) => x.oidc?.some((l) => l.issuer === f.issuer && l.subject === f.subject));
        return !c || c.memberId !== f.memberId || (Number.isFinite(c.signedOutAt) && f.created <= c.signedOutAt);
      });
      return revoke(ended.map(([id]) => id), "member removed, unlinked or signed out");
    },
    /** Write revocations that are in effect but not yet durable (the sweep does it too). */
    flushRevocations: () => (persistRevocations(), blocked.size),
    status: () => ({ disabled, families: Object.entries(doc.families).filter(([id, f]) => active(f, now(), id)).length, unwrittenRevocations: blocked.size, pending: pending.size, codes: codes.size, accessTokens: access.size }),
    close: () => clearInterval(sweep),
  };
}

/**
 * `hoptell relay broker-reset`: a new refresh key, and every broker family revoked (the relay is
 * stopped: the caller holds the state lock). Returns the number of families ended.
 */
export function brokerReset(stateDir, { now = () => Date.now(), fault = null } = {}) {
  const dir = path.join(stateDir, "broker");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // The folder's entry in the state directory, durable before its files are (also after a crash
  // between the mkdir and this sync: a rerun syncs again).
  if (process.platform !== "win32") {
    const fd = fs.openSync(stateDir, "r");
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }
  const familiesFile = path.join(dir, "families.json");
  let doc = { v: 1, families: {} };
  let ended = 0;
  try {
    const d = JSON.parse(fs.readFileSync(familiesFile, "utf8"));
    if (validFamilies(d)) doc = d;
  } catch {}
  for (const f of Object.values(doc.families)) {
    if (!f.revoked) {
      f.revoked = { at: now(), why: "broker reset" };
      ended++;
    }
  }
  // Families first (all revoked), then the new key: an interruption never leaves a valid family
  // under a new key.
  writeDurable(familiesFile, `${JSON.stringify(doc)}\n`, { fault });
  writeDurable(path.join(dir, "refresh.key"), `${b64u(crypto.randomBytes(32))}\n`, { fault });
  return ended;
}
