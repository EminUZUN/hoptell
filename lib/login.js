// `hoptell login` and the access-token source of signed-in sessions (design 1.6, resource mode).
// The relay names its identity providers and the native client registered there (GET
// /.well-known/hoptell); the CLI signs in with the authorization code flow and PKCE on a loopback
// redirect (or the device grant, or client credentials for unattended agents), keeps the
// credential in the OS keychain, bound to its full context, and gives the engine and the CLI
// fresh access tokens. Every refresh, login and logout of one credential runs under one lock and
// checks the credential's generation, so concurrent processes never reuse a rotated refresh token.
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { ensurePrivateDir } from "./config.js";
import { credentialStore, removeDurable, writeDurable } from "./credentials.js";
import { withLock } from "./locks.js";
import { readProfile } from "./profiles.js";

const LOOPBACK = /^(https?|wss?):\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/;
const LOGIN_TIMEOUT_MS = 5 * 60_000;

/** A refusal that needs the user (sign in again, wrong configuration); never retried by itself. */
export class SignInError extends Error {
  terminal = true; // needs the user: never retried by itself
}

/** Signing in needs the relay behind TLS (wss://), except on loopback. Throws a SignInError. */
export function checkSignInUrl(relayUrl) {
  if (!/^wss:/.test(relayUrl) && !LOOPBACK.test(relayUrl)) throw new SignInError("signing in needs a wss:// relay URL (the relay behind TLS)");
}

/** The relay's discovery document, from its WebSocket URL (HTTPS, except loopback). */
export async function relayDiscovery(relayUrl) {
  checkSignInUrl(relayUrl);
  const u = new URL(relayUrl);
  u.protocol = u.protocol === "wss:" ? "https:" : "http:";
  u.pathname = "/.well-known/hoptell";
  u.search = "";
  let r;
  try {
    r = await fetch(u, { signal: AbortSignal.timeout(10_000), redirect: "error" });
  } catch (e) {
    throw new Error(`cannot reach ${u.origin} (${e.cause?.code ?? e.message})`);
  }
  // 404, or 426 from a relay without sign-in (it answers every other path that way).
  if (r.status === 404 || r.status === 426) throw new SignInError("this relay does not offer sign-in with an identity provider; use a member token");
  if (!r.ok) throw new Error(`the relay answered ${r.status} for its sign-in settings`);
  const chunks = [];
  let size = 0;
  for await (const chunk of r.body ?? []) {
    size += chunk.length;
    if (size > 64 * 1024) throw new Error("the relay's sign-in settings are too large"); // stops reading here
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("the relay's sign-in settings are not valid JSON");
  }
}

/**
 * The stable credential key: binds home, profile, relay, realm, issuer and client; a broker
 * credential (design 1.7) also its broker id and the provider configuration identity.
 */
export function credentialKey({ home, profile, relayUrl, realm, issuer, clientId, broker = null }) {
  const binding = { home: path.resolve(home), profile, relay: new URL(relayUrl).href, realm: realm ?? null, issuer, clientId, ...(broker ? { broker: { id: broker.id, configId: broker.configId } } : {}) };
  return { account: `c_${crypto.createHash("sha256").update(JSON.stringify(binding)).digest("hex").slice(0, 32)}`, binding };
}
const sameBinding = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function client(issuer, clientId, clientSecret = undefined) {
  if (!/^https:/.test(issuer) && !LOOPBACK.test(issuer)) throw new SignInError(`the issuer ${issuer} must use https`);
  const oidc = await import("openid-client");
  const opts = LOOPBACK.test(issuer) ? { execute: [oidc.allowInsecureRequests], timeout: 10 } : { timeout: 10 };
  const auth = clientSecret ? oidc.ClientSecretPost(clientSecret) : oidc.None();
  return { oidc, config: await oidc.discovery(new URL(issuer), clientId, clientSecret ? { client_secret: clientSecret } : undefined, auth, opts) };
}

/** Open a URL in the user's browser (best effort; the URL is also printed). */
export function openBrowser(url) {
  const cmd = process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  const c = spawn(cmd[0], cmd[1], { stdio: "ignore", detached: true });
  c.on("error", () => {});
  c.unref();
}

/** The index of a profile's sign-in (which credential key it uses), in <home>/credentials/. */
const indexFile = (home, profile) => path.join(home, "credentials", `${profile}.login.json`);
const lockOf = (home, account) => path.join(ensurePrivateDir(path.join(ensurePrivateDir(home), "credentials")), `${account}`);
// A holder may be refreshing at the provider (a network call with its own timeout): wait longer.
const credentialLock = (home, account, fn) => withLock(lockOf(home, account), fn, { waitMs: 30_000 });

/**
 * Sign in for relay profile `profile`. `mode`: "browser" (default), "device" or "service"
 * ({clientId, clientSecret}). Stores the credential bound to its context and returns
 * {issuer, kind, store}.
 */
export async function login({ relayUrl, home, profile, issuer: wanted = null, signInMode = null, mode = "browser", service = null, store = "auto", passphrase = null, open = openBrowser, say = console.log, keychainBackend, fault = null }) {
  const doc = await relayDiscovery(relayUrl);
  // The relay must be the one this profile knows (its pinned realm), when it is pinned.
  const pinned = readProfile(home, profile)?.realm ?? null;
  if (pinned && doc.realm !== pinned) throw new SignInError(`this relay reports realm ${doc.realm}, but the profile is pinned to ${pinned}; it may not be the relay you configured`);
  const iss = chooseIssuer(doc.issuers ?? [], { wanted, signInMode, service: mode === "service" || mode === "device" });
  if (iss.mode === "broker") {
    if (mode !== "browser") throw new SignInError("broker sign-in is with the browser only; use a member token or the provider's resource mode for devices and services");
    return brokerLogin({ doc, iss, relayUrl, home, profile, store, passphrase, open, say, keychainBackend, fault });
  }
  // Only the request parameters the relay configured (often none: an audience mapper sets aud).
  const params = { ...(iss.request?.resource ? { resource: iss.request.resource } : {}), ...(iss.request?.audience ? { audience: iss.request.audience } : {}) };

  if (mode === "service") {
    if (!service?.clientId || !service?.clientSecret) throw new SignInError("--client-credentials needs --client-id and --client-secret-file");
    const { oidc, config } = await client(iss.issuer, service.clientId, service.clientSecret);
    const scope = (iss.cli?.scopes ?? []).filter((s) => s !== "openid" && s !== "offline_access").join(" ");
    await oidc.clientCredentialsGrant(config, { ...params, ...(scope ? { scope } : {}) }); // the credentials work now
    return save({ home, profile, relayUrl, realm: doc.realm, issuer: iss.issuer, clientId: service.clientId, store, passphrase, keychainBackend, fault }, { kind: "service", clientSecret: service.clientSecret, params: { ...params, ...(scope ? { scope } : {}) } });
  }
  if (!iss.cli?.clientId) throw new SignInError("the relay names no client registered for signing in from the command line");
  const scope = (iss.cli.scopes ?? ["openid"]).join(" ");
  const { oidc, config } = await client(iss.issuer, iss.cli.clientId);
  let tokens;
  if (mode === "device") {
    if (!(iss.cli.grants ?? []).includes("device_code") || !config.serverMetadata().device_authorization_endpoint) {
      throw new SignInError("this relay or identity provider does not offer sign-in with a code on another device; run hoptell login without --device");
    }
    // PKCE here too: providers that require it for the client (Keycloak) check it on the device
    // grant, and the others ignore the parameters.
    const verifier = oidc.randomPKCECodeVerifier();
    const challenge = await oidc.calculatePKCECodeChallenge(verifier);
    const d = await oidc.initiateDeviceAuthorization(config, { ...params, scope, code_challenge: challenge, code_challenge_method: "S256" });
    say(`To sign in, open ${d.verification_uri_complete ?? d.verification_uri} and enter the code ${d.user_code}.`);
    tokens = await oidc.pollDeviceAuthorizationGrant(config, d, { ...params, code_verifier: verifier });
  } else {
    const verifier = oidc.randomPKCECodeVerifier();
    const challenge = await oidc.calculatePKCECodeChallenge(verifier);
    const state = oidc.randomState();
    const nonce = oidc.randomNonce();
    const { server, redirect, arrived } = await loopback(iss.cli.redirectPath ?? "/callback");
    try {
      const url = oidc.buildAuthorizationUrl(config, { ...params, scope, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: "S256", state, nonce });
      say(`Opening your browser to sign in. If it does not open, visit:\n${url.href}`);
      open(url.href);
      const callback = await arrived;
      tokens = await oidc.authorizationCodeGrant(config, callback, { pkceCodeVerifier: verifier, expectedState: state, expectedNonce: nonce, idTokenExpected: scope.split(" ").includes("openid") }, params); // the same resource/audience as the request
    } finally {
      server.close();
    }
  }
  if (!tokens.refresh_token) throw new SignInError("this identity provider issued no refresh token for hoptell; ask its administrator to allow offline access for the client, or use a member token");
  return save({ home, profile, relayUrl, realm: doc.realm, issuer: iss.issuer, clientId: iss.cli.clientId, store, passphrase, keychainBackend, fault }, { kind: "user", refreshToken: tokens.refresh_token, params });
}

/**
 * The relay's sign-in entry to use: by --issuer and --mode. One provider offered in both modes
 * needs --mode (never chosen by list order); devices and services use resource mode.
 */
function chooseIssuer(entries, { wanted, signInMode, service }) {
  let list = entries.filter((i) => ["resource", "broker"].includes(i.mode) && (!wanted || i.issuer === wanted || (i.mode === "broker" && i.id === wanted)));
  if (signInMode) list = list.filter((i) => i.mode === signInMode);
  else if (service) {
    const brokerOnly = list.length && list.every((i) => i.mode === "broker");
    list = list.filter((i) => i.mode === "resource");
    if (brokerOnly) throw new SignInError("this relay offers broker sign-in, which is with the browser only; use a member token for devices and services");
  }
  if (!list.length) throw new SignInError(wanted ? `the relay does not accept sign-in with ${wanted}${signInMode ? ` in ${signInMode} mode` : ""}` : "the relay names no identity provider");
  if (list.length > 1) {
    const modes = new Set(list.map((i) => i.mode));
    const issuers = new Set(list.map((i) => i.issuer));
    if (issuers.size > 1) throw new SignInError(`the relay offers several identity providers (${[...issuers].join(", ")}): choose one with --issuer`);
    if (modes.size > 1) throw new SignInError(`${list[0].issuer} is offered in broker and resource mode: choose one with --mode broker or --mode resource`);
    throw new SignInError(`the relay offers ${list[0].issuer} more than once: choose with --issuer <broker id>`);
  }
  return list[0];
}

const b64u = (b) => Buffer.from(b).toString("base64url");
const BROKER_CLIENT = "hoptell-cli";

/** The relay's https origin for its WebSocket URL. */
const relayOrigin = (relayUrl) => {
  const u = new URL(relayUrl);
  u.protocol = u.protocol === "wss:" ? "https:" : "http:";
  return u.origin;
};

/** The broker's endpoints, each on the relay's own origin at /oidc/<id>/<name> (design 1.7). */
function brokerEndpoints(iss, relayUrl) {
  const origin = relayOrigin(relayUrl);
  if (typeof iss.id !== "string" || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(iss.id) || typeof iss.configId !== "string") throw new SignInError("the relay's broker sign-in settings are incomplete");
  const out = {};
  for (const name of ["authorize", "token", "revoke"]) {
    let u;
    try {
      u = new URL(iss.endpoints?.[name]);
    } catch {
      throw new SignInError(`the relay names no valid ${name} endpoint for broker sign-in`);
    }
    if (u.origin !== origin || u.pathname !== `/oidc/${iss.id}/${name}` || u.search || u.hash) throw new SignInError(`the relay's ${name} endpoint is not on the relay itself (${origin}); it may not be the relay you configured`);
    out[name] = u.href;
  }
  return out;
}

/** POST a form to a broker endpoint; resolves to {status, body (parsed JSON or null)}. */
async function postForm(url, form, { timeoutMs = 15_000 } = {}) {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form), redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
  const text = await r.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {}
  return { status: r.status, body };
}

/** Broker sign-in: the browser signs in at the provider through the relay, which issues our credential. */
async function brokerLogin({ doc, iss, relayUrl, home, profile, store, passphrase, open, say, keychainBackend, fault }) {
  const endpoints = brokerEndpoints(iss, relayUrl);
  const verifier = b64u(crypto.randomBytes(32));
  const challenge = b64u(crypto.createHash("sha256").update(verifier).digest());
  const state = b64u(crypto.randomBytes(24));
  const { server, redirect, arrived } = await loopback("/callback");
  let callback;
  try {
    const url = new URL(endpoints.authorize);
    for (const [k, v] of Object.entries({ response_type: "code", client_id: BROKER_CLIENT, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: "S256", state })) url.searchParams.set(k, v);
    say(`Opening your browser to sign in. If it does not open, visit:\n${url.href}`);
    open(url.href);
    callback = await arrived;
  } finally {
    server.close();
  }
  if (callback.searchParams.get("state") !== state) throw new SignInError("the sign-in answer does not belong to this sign-in (state); run hoptell login again");
  const code = callback.searchParams.get("code");
  if (!code) throw new SignInError(`the sign-in was not completed (${callback.searchParams.get("error") ?? "no code"})`);
  let r;
  try {
    r = await postForm(endpoints.token, { grant_type: "authorization_code", code, redirect_uri: redirect, code_verifier: verifier, client_id: BROKER_CLIENT });
  } catch (e) {
    throw new Error(`the relay could not be reached to finish the sign-in (${e.cause?.code ?? e.message}); run hoptell login again`);
  }
  if (r.status !== 200 || !/^hr1_/.test(r.body?.refresh_token ?? "") || !/^ha_/.test(r.body?.access_token ?? "")) {
    throw new SignInError(`the relay refused the sign-in (${r.body?.error_description ?? r.body?.error ?? `HTTP ${r.status}`})`);
  }
  // The sign-in this one replaces (a broker sign-in of this profile) is ended at the relay after the
  // new one is stored (best effort: it would end at its idle expiry anyway).
  let previous = null;
  try {
    const idx = readIndex(home, profile);
    if (idx) previous = credentialStore(home, idx.account, storeOptions({ passphrase, keychainBackend })(concrete(idx.store))).read();
  } catch {}
  const broker = { id: iss.id, configId: iss.configId };
  const saved = await save({ home, profile, relayUrl, realm: doc.realm, issuer: iss.issuer, clientId: BROKER_CLIENT, broker, store, passphrase, keychainBackend, fault }, { kind: "broker", refreshToken: r.body.refresh_token, endpoints, pending: null });
  if (previous?.kind === "broker" && previous.refreshToken && previous.refreshToken !== r.body.refresh_token && previous.endpoints?.revoke) {
    await postForm(previous.endpoints.revoke, { token: previous.refreshToken, client_id: BROKER_CLIENT }, { timeoutMs: 5000 }).catch(() => {});
  }
  return { ...saved, broker: iss.id };
}

/** Store a credential under its lock (replacing an older one for this profile), with a new generation. */
async function save(ctx, secret) {
  const { account, binding } = credentialKey(ctx);
  const cs = storeOptions(ctx);
  const creds = credentialStore(ctx.home, account, cs(ctx.store));
  const store = creds.kind === "encrypted file" ? "file" : "keychain"; // the concrete backend, recorded
  // The profile's sign-in state (index and transition) changes only under its profile lock, taken
  // before any credential lock: recovery, logins and logouts of one profile are serialized, and an
  // unresolved transition is always finished before a new one starts.
  await withProfileLock(ctx.home, ctx.profile, async () => {
    await recoverLocked(ctx.home, ctx.profile, cs);
    const old = readIndex(ctx.home, ctx.profile);
    // The same sign-in in another backend (keychain <-> encrypted file) is not moved in place: the
    // old copy would be left behind. Signing out first keeps exactly one credential.
    if (old && old.account === account && concrete(old.store) !== store) {
      throw new SignInError(`this relay profile is signed in with its credential in the ${concrete(old.store) === "file" ? "encrypted file" : "keychain"}; run hoptell logout first to keep it in the ${store === "file" ? "encrypted file" : "keychain"} instead`);
    }
    const replacing = old && old.account !== account ? old : null;
    // Every sign-in is a recorded transition, also the first: before the new secret is written the
    // record names it (and the credential it replaces), so an interruption (an error, a crash, an
    // unavailable keychain) is finished or rolled back by the next login, logout or token source.
    writeTransition(ctx.home, ctx.profile, { from: replacing ? { account: replacing.account, store: replacing.store } : null, to: { account, store } });
    await withCredentialLocks(ctx.home, [account, replacing?.account].filter(Boolean), () => {
      const generation = (creds.read()?.generation ?? 0) + 1;
      creds.write({ v: 1, binding, generation, ...secret });
      writeIndex(ctx.home, ctx.profile, { account, binding, store }, ctx.fault);
      if (replacing) credentialStore(ctx.home, replacing.account, cs(concrete(replacing.store))).remove(); // throws: the record stays for recovery
    });
    clearTransition(ctx.home, ctx.profile);
  });
  return { issuer: binding.issuer, kind: secret.kind, store: creds.kind };
}

/** The backend a sign-in record names; older records said "auto" for the keychain. */
const concrete = (store) => (store === "file" ? "file" : "keychain");
const storeOptions = (ctx) => (store) => ({ store, passphrase: ctx.passphrase ?? null, ...(ctx.keychainBackend ? { keychainBackend: ctx.keychainBackend } : {}), ...(ctx.fault ? { fault: ctx.fault } : {}) });
const transitionFile = (home, profile) => path.join(home, "credentials", `${profile}.transition.json`);
const profileLockOf = (home, profile) => path.join(ensurePrivateDir(path.join(ensurePrivateDir(home), "credentials")), `${profile}.profile`);
const withProfileLock = (home, profile, fn) => withLock(profileLockOf(home, profile), fn, { waitMs: 30_000 });
function readTransition(home, profile) {
  let t;
  try {
    t = JSON.parse(fs.readFileSync(transitionFile(home, profile), "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw new SignInError(`the sign-in change of ${profile} cannot be read; run hoptell login again`);
  }
  const ref = (r) => r === null || (r && typeof r.account === "string" && typeof r.store === "string");
  if (t?.v !== 1 || !ref(t.from) || !t.to || !ref(t.to)) throw new SignInError(`the sign-in change of ${profile} is damaged; run hoptell login again`);
  return t;
}
const writeTransition = (home, profile, rec) => writeDurable(transitionFile(home, profile), `${JSON.stringify({ v: 1, ...rec })}\n`);
const clearTransition = (home, profile) => removeDurable(transitionFile(home, profile));

/**
 * Finish or roll back an interrupted transition (the caller holds the profile lock): if the index
 * names the new credential, the replaced one is removed; otherwise the new one is. The record is
 * cleared only when that worked; a failure keeps it (and is reported) for the next attempt.
 */
async function recoverLocked(home, profile, cs) {
  const t = readTransition(home, profile);
  if (!t) return;
  const idx = readIndex(home, profile);
  const leftover = idx?.account === t.to.account ? t.from : t.to;
  if (leftover && leftover.account !== idx?.account) await credentialLock(home, leftover.account, () => credentialStore(home, leftover.account, cs(concrete(leftover.store))).remove());
  clearTransition(home, profile);
}
const recoverTransition = (home, profile, cs) => withProfileLock(home, profile, () => recoverLocked(home, profile, cs));

/** Run `fn` under the locks of several credentials, taken in a fixed (sorted) order. */
async function withCredentialLocks(home, accounts, fn) {
  const [first, ...rest] = [...new Set(accounts)].sort();
  return credentialLock(home, first, () => (rest.length ? withCredentialLocks(home, rest, fn) : fn()));
}

/** What doctor may show about a profile's sign-in, from its index only (no keychain access, no secrets). */
export function signInStatus(home, profile) {
  const idx = readIndex(home, profile);
  return idx ? { issuer: idx.binding.issuer, clientId: idx.binding.clientId, broker: idx.binding.broker?.id ?? null, store: idx.store === "file" ? "encrypted file" : "keychain" } : null;
}

function readIndex(home, profile) {
  try {
    return JSON.parse(fs.readFileSync(indexFile(home, profile), "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw new SignInError(`the sign-in record of ${profile} cannot be read; run hoptell login again`);
  }
}
function writeIndex(home, profile, rec, fault = null) {
  ensurePrivateDir(path.join(ensurePrivateDir(home), "credentials"));
  writeDurable(indexFile(home, profile), `${JSON.stringify(rec)}\n`, { fault }); // durable, or an error
}

/** A one-shot loopback server on 127.0.0.1 for the redirect at `redirectPath` (RFC 8252). */
function loopback(redirectPath) {
  return new Promise((resolve, reject) => {
    let settle;
    const arrived = new Promise((res, rej) => (settle = { res, rej }));
    const timer = setTimeout(() => settle.rej(new SignInError("sign-in timed out")), LOGIN_TIMEOUT_MS);
    let used = false;
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (url.pathname !== redirectPath || used) return res.writeHead(404).end();
      used = true; // one outstanding callback
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" }).end("Signed in to hoptell. You can close this window.\n");
      clearTimeout(timer);
      settle.res(url);
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => resolve({ server, redirect: `http://127.0.0.1:${server.address().port}${redirectPath}`, arrived }));
  });
}

/**
 * Remove the stored credential (under its lock, so a running engine's next refresh fails), then
 * revoke its refresh token at the provider where possible. Returns {removed, revoked}.
 */
export async function logout({ home, profile, passphrase = null, keychainBackend }) {
  const cs = storeOptions({ passphrase, keychainBackend });
  let secret = null;
  // Under the profile lock: an interrupted transition is completed first, so logout removes every
  // credential it knows of, or fails with the recovery state kept.
  const removed = await withProfileLock(home, profile, async () => {
    await recoverLocked(home, profile, cs);
    const idx = readIndex(home, profile);
    if (!idx) return null;
    await credentialLock(home, idx.account, () => {
      const creds = credentialStore(home, idx.account, cs(concrete(idx.store)));
      secret = creds.read();
      creds.remove(); // throws if it is still stored: the index stays, nothing claims success
      removeDurable(indexFile(home, profile));
    });
    return idx;
  });
  if (!removed) return { removed: false, revoked: null, kind: null };
  const idx = removed;
  let revoked = null;
  if (secret?.kind === "broker") {
    try {
      const r = await postForm(secret.endpoints.revoke, { token: secret.refreshToken, client_id: BROKER_CLIENT });
      revoked = r.status === 200;
    } catch {
      revoked = false;
    }
  } else if (secret?.kind === "user") {
    try {
      const { oidc, config } = await client(idx.binding.issuer, idx.binding.clientId);
      if (config.serverMetadata().revocation_endpoint) {
        await oidc.tokenRevocation(config, secret.refreshToken);
        revoked = true;
      } else revoked = "unsupported";
    } catch {
      revoked = false;
    }
  }
  return { removed: true, revoked, kind: secret?.kind ?? null };
}

/**
 * The access-token source of a signed-in relay profile: resolves to {issuer, token, expiresAt}.
 * Under the credential's lock it re-reads the record, refreshes once for its generation, stores a
 * rotated refresh token (generation + 1) before using the new access token, and releases. A
 * refused refresh (invalid_grant) is a SignInError ("run hoptell login"); transport failures are
 * ordinary errors (tried again later).
 */
export function tokenSource({ home, profile, relayUrl, passphrase = null, keychainBackend, fault = null }) {
  if (!relayUrl) throw new Error("tokenSource needs the relay URL it signs in to");
  const wantRelay = new URL(relayUrl).href;
  let cached = null;
  let cachedAccount = null;
  // `force` (the relay answered token_expired): renew now, never the token in memory.
  return ({ force = false } = {}) => signIn(force, false);
  async function signIn(force, again) {
    if (fs.existsSync(transitionFile(home, profile))) await recoverTransition(home, profile, storeOptions({ passphrase, keychainBackend, fault }));
    const idx = readIndex(home, profile);
    if (!idx) throw new SignInError("not signed in for this relay: run hoptell login");
    // The sign-in belongs to exactly this home, profile and relay URL: the binding expected from
    // the current context must reproduce the stored account (a copied home or index, another
    // profile, or a profile now pointing elsewhere never gets this credential's tokens).
    const b = idx.binding ?? {};
    const expected = credentialKey({ home, profile, relayUrl: wantRelay, realm: b.realm ?? null, issuer: b.issuer, clientId: b.clientId, broker: b.broker ?? null });
    if (expected.account !== idx.account || !sameBinding(expected.binding, b)) {
      throw new SignInError(`this sign-in was made for ${b.relay ?? "another relay"} in another setup; run hoptell login again for ${wantRelay}`);
    }
    const pinned = readProfile(home, profile)?.realm ?? null;
    if (pinned && pinned !== b.realm) throw new SignInError(`this sign-in is for realm ${b.realm}, but the profile is pinned to ${pinned}; run hoptell login again`);
    // A token in memory is used only after those checks, and while the same credential is still the
    // profile's sign-in.
    if (!force && cached && cachedAccount === idx.account && cached.expiresAt - Date.now() > 150_000) return cached;
    cached = null;
    const creds = credentialStore(home, idx.account, { store: concrete(idx.store), passphrase, ...(keychainBackend ? { keychainBackend } : {}), ...(fault ? { fault } : {}) });
    let replaced = false;
    const result = await credentialLock(home, idx.account, async () => {
      // A login may have replaced this credential while we waited for its lock.
      const now = readIndex(home, profile);
      if (!now) throw new SignInError("signed out: run hoptell login");
      if (now.account !== idx.account) return (replaced = true), null;
      const c = creds.read();
      if (!c) throw new SignInError("signed out: run hoptell login");
      if (!sameBinding(c.binding, idx.binding)) throw new SignInError("the stored sign-in belongs to another relay or account; run hoptell login again");
      if (c.kind === "broker") return brokerRefresh(c, creds, fault);
      if (c.kind === "service") {
        const { oidc, config } = await client(c.binding.issuer, c.binding.clientId, c.clientSecret);
        let t;
        try {
          t = await oidc.clientCredentialsGrant(config, c.params);
        } catch (e) {
          if (e.error === "invalid_client" || e.error === "unauthorized_client") throw new SignInError(`the client credentials were refused (${e.error}): run hoptell login --client-credentials again`);
          throw e;
        }
        return { issuer: c.binding.issuer, token: t.access_token, expiresAt: Date.now() + (t.expires_in ?? 300) * 1000 };
      }
      const { oidc, config } = await client(c.binding.issuer, c.binding.clientId);
      let t;
      try {
        t = await oidc.refreshTokenGrant(config, c.refreshToken, c.params);
      } catch (e) {
        if (e.error === "invalid_grant") throw new SignInError("your sign-in expired or was revoked: run hoptell login");
        throw e; // a transport problem: tried again later
      }
      if (t.refresh_token && t.refresh_token !== c.refreshToken) creds.write({ ...c, refreshToken: t.refresh_token, generation: c.generation + 1 }); // rotation, stored (durably) before use
      return { issuer: c.binding.issuer, token: t.access_token, expiresAt: Date.now() + (t.expires_in ?? 300) * 1000 };
    });
    if (replaced) {
      if (again) throw new SignInError("the sign-in keeps changing; run hoptell login again");
      return signIn(force, true); // the new credential, under its own lock
    }
    cached = result;
    cachedAccount = idx.account;
    return cached;
  }
}

const LOST = "the sign-in may have been renewed but the answer was lost: run hoptell login";
// Failures that prove the request never reached the relay.
const NOT_SENT = ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "EADDRNOTAVAIL", "UND_ERR_CONNECT_TIMEOUT"];

/**
 * A broker refresh (design 1.7), strict: under the credential's lock the record is first marked
 * `pending` durably, then the old refresh token is sent once. Only a provably unsent request or an
 * explicit answer that changed nothing clears the mark (a later attempt may retry); an unknown
 * outcome keeps it, and every process that finds it asks for hoptell login instead of sending
 * the old token again (it may be spent: its replay would end the sign-in).
 */
async function brokerRefresh(c, creds, fault) {
  if (c.pending || c.needsLogin) throw new SignInError(c.needsLogin ? "your sign-in ended: run hoptell login" : LOST);
  const attempt = crypto.randomBytes(8).toString("hex");
  creds.write({ ...c, pending: { attempt, at: Date.now() } }); // durable before the request leaves
  fault?.("broker-marked");
  let r;
  try {
    r = await postForm(c.endpoints.token, { grant_type: "refresh_token", refresh_token: c.refreshToken, client_id: BROKER_CLIENT });
  } catch (e) {
    const code = e.cause?.code ?? e.code;
    if (NOT_SENT.includes(code)) {
      creds.write({ ...c, pending: null });
      throw new Error(`the relay is not reachable (${code}); trying again later`);
    }
    throw new SignInError(LOST); // sent, answer unknown (timeout, reset): the mark stays
  }
  fault?.("broker-answered");
  const b = r.body;
  if (r.status === 200 && typeof b?.refresh_token === "string" && /^hr1_/.test(b.refresh_token) && typeof b.access_token === "string" && /^ha_/.test(b.access_token) && Number.isFinite(b.expires_in)) {
    try {
      creds.write({ ...c, refreshToken: b.refresh_token, generation: c.generation + 1, pending: null }); // stored before use
    } catch {
      throw new SignInError(LOST); // the new token could not be kept; the old one is spent
    }
    return { kind: "broker", issuer: c.binding.broker.id, token: b.access_token, expiresAt: Date.now() + b.expires_in * 1000 };
  }
  if ((r.status === 503 || r.status === 429) && ["temporarily_unavailable", "slow_down"].includes(b?.error)) {
    creds.write({ ...c, pending: null }); // an explicit answer before any change at the relay
    throw new Error(`the relay is busy (${b.error}); trying again later`);
  }
  if (r.status === 400 && b?.error === "invalid_grant") {
    creds.write({ ...c, pending: null, needsLogin: true });
    throw new SignInError(`your sign-in ended (${b.error_description ?? "invalid_grant"}): run hoptell login`);
  }
  throw new SignInError(LOST); // a malformed or unexpected answer: the outcome is unknown
}
