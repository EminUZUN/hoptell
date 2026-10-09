// Signing in with an identity provider at the relay (design 1.6 v2), against the test provider,
// with negative fixtures built independently of the provider's normal token builder.
import { test } from "node:test";
import assert from "node:assert/strict";
import { SignJWT } from "jose";
import WebSocket from "ws";
import { RelayClient } from "../lib/client.js";
import { boundedFetch, createVerifier, discoveryDocument } from "../lib/oidc.js";
import { startRelay } from "../lib/relay.js";
import { startProvider } from "./fixtures/oidc-provider.mjs";
import { sleep } from "./helpers.js";

const REALM = "c".repeat(32);
const ALICE = "m_aaaaaaaaaaaaaaaaaaaaaaaaaa";

async function setup(t, { provider = {}, issuer = {}, verifierOptions = {}, config = {} } = {}) {
  const p = await startProvider({ clients: { "hoptell-cli": {}, "hoptell-relay": { secret: "relay-secret" } }, ...provider });
  t.after(() => p.close());
  const cfg = {
    maxRevocationDelaySeconds: 2,
    maxTokenLifetimeSeconds: null,
    ...config,
    issuers: [
      {
        issuer: p.issuer,
        mode: "resource",
        audience: "hoptell-relay",
        validation: "jwt",
        profile: "rfc9068",
        clientClaim: "client_id",
        request: { resource: null, audience: null },
        requiredClaims: {},
        requiredScopes: ["hoptell"],
        allowedClients: null,
        algorithms: ["ES256"],
        claims: { name: "preferred_username", groups: "groups" },
        introspection: { clientId: "hoptell-relay", clientSecret: "relay-secret", requiredFields: ["sub", "aud", "exp"] },
        cli: { clientId: "hoptell-cli", scopes: ["openid", "hoptell"], redirectPath: "/callback", grants: ["authorization_code", "device_code"] },
        ...issuer,
      },
    ],
  };
  const verifier = await createVerifier(cfg, { jwksCooldownMs: 500, ...verifierOptions });
  const members = [{ name: "alice", id: ALICE, oidc: [{ issuer: p.issuer, subject: "user-1" }] }];
  const relay = await startRelay({ host: "127.0.0.1", port: 0, members, realm: { id: REALM }, oidc: { verifier, config: cfg, discovery: discoveryDocument(cfg, REALM) }, log: () => {} });
  t.after(() => relay.close());
  const signIn = (o = {}) => async () => ({ issuer: p.issuer, token: await p.issue(o), expiresAt: Date.now() + 300_000 });
  return { p, cfg, relay, verifier, url: `ws://127.0.0.1:${relay.port}`, http: `http://127.0.0.1:${relay.port}`, signIn };
}

const rawHello = (url, auth, extra = {}) =>
  new Promise((resolve) => {
    const ws = new WebSocket(url);
    const frames = [];
    ws.on("open", () => ws.send(JSON.stringify({ type: "hello", v: 2, name: "alice-s", auth: { kind: "oidc", ...auth }, host: "pc", mode: "send", ...extra })));
    ws.on("message", (d) => frames.push(JSON.parse(d)));
    ws.on("close", (code) => resolve({ code, frames, error: frames.find((f) => f.type === "hello_error")?.code, welcome: frames.find((f) => f.type === "welcome") }));
    ws.on("error", () => {});
    setTimeout(() => ws.close(), 3000);
  });

/** A token signed with the provider's current key but built by hand (negative fixtures). */
const handmade = async (p, claims, header = {}) => {
  const key = (await p.keysForTests())[0];
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ iss: p.issuer, aud: "hoptell-relay", sub: "user-1", client_id: "hoptell-cli", jti: "j", iat: now, exp: now + 300, scope: "hoptell", ...claims })
    .setProtectedHeader({ alg: "ES256", kid: key.kid, typ: "at+jwt", ...header })
    .sign(key.privateKey);
};

test("a linked identity signs in as its member, with the relay's deadline; discovery names the CLI client", async (t) => {
  const { url, http, signIn } = await setup(t);
  const c = new RelayClient({ url, name: "alice-agent", signIn: signIn() });
  t.after(() => c.close());
  await c.start().ready();
  assert.deepEqual(c.member, { id: ALICE, name: "alice" });
  assert.ok(c.authDeadline > Date.now(), "the welcome carries auth_expires_at");
  const doc = await (await fetch(`${http}/.well-known/hoptell`)).json();
  assert.equal(doc.realm, REALM);
  assert.deepEqual(doc.issuers[0].cli, { clientId: "hoptell-cli", scopes: ["openid", "hoptell"], redirectPath: "/callback", grants: ["authorization_code", "device_code"] });
  assert.equal(JSON.stringify(doc).includes("relay-secret"), false);
});

test("the token is checked only against the issuer the client names; unknown issuers are unsupported", async (t) => {
  const { p, url } = await setup(t);
  assert.equal((await rawHello(url, { issuer: "https://not-configured.example", token: await p.issue() })).error, "unsupported_auth");
  const other = await startProvider({ clients: {} });
  t.after(() => other.close());
  assert.equal((await rawHello(url, { issuer: p.issuer, token: await other.issue() })).error, "bad_token", "a JWT of another issuer");
  assert.equal((await rawHello(url, { token: await p.issue() })).code, 4001, "no issuer named: a bad hello");
});

test("negative fixtures: missing or wrongly typed claims, ID tokens, wrong typ, scopes, audience, lifetime", async (t) => {
  const { p, url } = await setup(t, { config: { maxTokenLifetimeSeconds: 600 } });
  const refused = async (token) => (await rawHello(url, { issuer: p.issuer, token })).error;
  assert.ok((await rawHello(url, { issuer: p.issuer, token: await handmade(p, {}) })).welcome, "the handmade baseline is accepted");
  assert.equal(await refused(await handmade(p, { sub: undefined })), "bad_token");
  assert.equal(await refused(await handmade(p, { sub: 42 })), "bad_token");
  assert.equal(await refused(await handmade(p, { exp: "soon" })), "bad_token");
  assert.equal(await refused(await handmade(p, { exp: undefined })), "bad_token");
  assert.equal(await refused(await handmade(p, { aud: "someone-else" })), "bad_token");
  assert.equal(await refused(await handmade(p, { scope: "openid" })), "bad_token");
  assert.equal(await refused(await handmade(p, { jti: undefined })), "bad_token", "RFC 9068 requires jti");
  assert.equal(await refused(await handmade(p, {}, { typ: "JWT" })), "bad_token", "not an at+jwt");
  assert.equal(await refused(await handmade(p, { nonce: "n" }, { typ: "JWT" })), "bad_token", "an ID token signed with the same key");
  assert.equal(await refused(await handmade(p, { nbf: Math.floor(Date.now() / 1000) + 3600 })), "bad_token");
  assert.equal(await refused(await handmade(p, { iat: Math.floor(Date.now() / 1000) - 3000, exp: Math.floor(Date.now() / 1000) + 3000 })), "bad_token", "longer than the maximum lifetime");
  assert.equal(await refused("a.b.c"), "bad_token", "an opaque token with dots is not taken for a JWT");
});

test("the claims profile: an explicit access-token marker (Keycloak typ=Bearer)", async (t) => {
  const { p, url } = await setup(t, { issuer: { profile: "claims", requiredClaims: { typ: "Bearer" } } });
  assert.ok((await rawHello(url, { issuer: p.issuer, token: await handmade(p, { typ: "Bearer" }, { typ: "JWT" }) })).welcome);
  assert.equal((await rawHello(url, { issuer: p.issuer, token: await handmade(p, { typ: "ID" }, { typ: "JWT" }) })).error, "bad_token");
});

test("unlinked identities get not_linked; key rotation is fetched once; unknown kids are bounded", async (t) => {
  const { p, url } = await setup(t);
  p.signIn = { sub: "user-2", name: "bob", groups: [] };
  assert.equal((await rawHello(url, { issuer: p.issuer, token: await p.issue({ sub: "user-2" }) })).error, "not_linked");
  p.signIn = { sub: "user-1", name: "alice", groups: [] };
  const before = p.jwksFetches;
  await p.rotate();
  await sleep(600);
  assert.ok((await rawHello(url, { issuer: p.issuer, token: await p.issue() })).welcome);
  for (let i = 0; i < 5; i++) await rawHello(url, { issuer: p.issuer, token: await handmade(p, {}, { kid: `unknown-${i}` }) });
  assert.ok(p.jwksFetches <= before + 2, `bounded refetches (${p.jwksFetches - before})`);
});

test("reauth: renewal keeps the connection; another identity or a reduced scope is refused", async (t) => {
  const { p, url, signIn } = await setup(t);
  const c = new RelayClient({ url, name: "alice-r", signIn: signIn() });
  t.after(() => c.close());
  await c.start().ready();
  const ok = await c.rpc({ type: "reauth", token: await p.issue() });
  assert.equal(ok.type, "reauth_ok");
  assert.ok(Number.isFinite(ok.auth_expires_at));
  await assert.rejects(c.rpc({ type: "reauth", token: await p.issue({ scope: "openid" }) }), /scope/);
  assert.equal(c.connected, true, "a refused renewal does not end the connection before its deadline");
  p.signIn = { sub: "user-2", name: "bob", groups: [] };
  const closed = new Promise((r) => c.ws.once("close", (code) => r(code)));
  c.ws.send(JSON.stringify({ type: "reauth", id: 999, token: await p.issue({ sub: "user-2" }) }));
  assert.equal(await closed, 4003);
});

test("the deadline ends the connection; the client renews by reconnecting", async (t) => {
  const { p, url } = await setup(t, { verifierOptions: { skewSeconds: 1 } });
  let issued = 0;
  const signIn = async () => (issued++, { issuer: p.issuer, token: await p.issue({ exp: 1 }), expiresAt: Date.now() + 1000 });
  const c = new RelayClient({ url, name: "alice-d", signIn });
  t.after(() => c.close());
  await c.start().ready();
  const closed = new Promise((r) => c.ws.once("close", (code, reason) => r([code, String(reason)])));
  assert.deepEqual(await closed, [4003, "token expired"]);
  for (let i = 0; i < 50 && !(c.connected && issued >= 2); i++) await sleep(100);
  assert.ok(issued >= 2 && c.connected, "reconnected with a fresh token");
});

test("opaque tokens: revocation and an issuer outage close by the delay", async (t) => {
  const opaque = { provider: { opaque: true }, issuer: { validation: "introspection", requiredClaims: { typ: "Bearer" } } };
  const { p, url, signIn } = await setup(t, opaque);
  const c = new RelayClient({ url, name: "alice-o", reconnect: false, signIn: signIn() });
  t.after(() => c.close());
  await c.start().ready();
  assert.equal(c.member.id, ALICE);
  const closed = new Promise((r) => c.ws.once("close", (code) => r(code)));
  p.revoke("user-1");
  assert.equal(await Promise.race([closed, sleep(6000).then(() => "still open")]), 4003, "closed within the revocation delay");
  const second = await setup(t, opaque);
  const d = new RelayClient({ url: second.url, name: "alice-p", reconnect: false, signIn: second.signIn() });
  t.after(() => d.close());
  await d.start().ready();
  const down = new Promise((r) => d.ws.once("close", (code) => r(code)));
  await second.p.close(); // the provider stops answering
  assert.equal(await Promise.race([down, sleep(8000).then(() => "still open")]), 4003, "closed by last success + delay");
});

test("lifetime bound needs a real issue time; conflicting clients and unmarked introspection are refused", async (t) => {
  const { p, url } = await setup(t, { config: { maxTokenLifetimeSeconds: 600 }, issuer: { profile: "claims", requiredClaims: { typ: "Bearer" } } });
  const now = Math.floor(Date.now() / 1000);
  const refused = async (claims) => (await rawHello(url, { issuer: p.issuer, token: await handmade(p, { typ: "Bearer", ...claims }, { typ: "JWT" }) })).error;
  assert.equal(await refused({ iat: undefined }), "bad_token", "no iat: the bound cannot be checked");
  assert.equal(await refused({ iat: now + 3600, exp: now + 3700 }), "bad_token", "issued in the future with a short interval");
  assert.equal(await refused({ azp: "someone-else" }), "bad_token", "client_id and azp disagree");
  const intro = await setup(t, { provider: { opaque: true }, issuer: { validation: "introspection", requiredClaims: { typ: "Refresh" } } });
  assert.equal((await rawHello(intro.url, { issuer: intro.p.issuer, token: await intro.p.issue() })).error, "bad_token", "introspection without the access-token marker");
});

test("a second renewal while one is in progress is refused (busy); an older result never wins", async (t) => {
  const { p, url, signIn } = await setup(t);
  const c = new RelayClient({ url, name: "alice-busy", signIn: signIn() });
  t.after(() => c.close());
  await c.start().ready();
  const [t1, t2] = [await p.issue(), await p.issue()];
  const [a, b] = await Promise.allSettled([c.rpc({ type: "reauth", token: t1 }), c.rpc({ type: "reauth", token: t2 })]);
  const outcomes = [a, b].map((x) => (x.status === "fulfilled" ? x.value.type : /busy|progress/.test(x.reason.message) ? "busy" : x.reason.message));
  assert.deepEqual(outcomes.sort(), ["busy", "reauth_ok"]);
});

test("client renewal: a refused identity stops without a loop; a passing sign-in failure is retried", async (t) => {
  const { p, url, signIn } = await setup(t);
  // The second token (the renewal) belongs to someone else: refused, the client stops with the reason.
  let n = 0;
  const swap = async () => ({ issuer: p.issuer, token: await p.issue({ sub: n++ ? "user-2" : "user-1", exp: 5 }), expiresAt: Date.now() + 5000 });
  const c = new RelayClient({ url, name: "alice-r", signIn: swap });
  t.after(() => c.close());
  const fatal = new Promise((r) => c.on("fatal", r));
  await c.start().ready();
  assert.match(await fatal, /another identity|other_identity/);
  await sleep(300);
  assert.equal(n, 2, "no further renewal attempts");
  // The provider unreachable at connect time: retried like a lost connection, not fatal.
  let down = 0;
  const flaky = async () => {
    if (down++ < 1) throw Object.assign(new Error("fetch failed"), { code: "ECONNREFUSED" });
    return signIn()();
  };
  const c2 = new RelayClient({ url, name: "alice-f", signIn: flaky });
  t.after(() => c2.close());
  let fatal2 = null;
  c2.on("fatal", (e) => (fatal2 = e));
  await c2.start().ready(8000);
  assert.equal(fatal2, null);
  assert.equal(down, 2);
});

test("hostile hello fields cost one connection; a cut-off connection is served no more while it closes", async (t) => {
  const { p, url, signIn } = await setup(t, { provider: { opaque: true }, issuer: { validation: "introspection", requiredClaims: { typ: "Bearer" } } });
  // An automatic name with a non-text host is a bad hello, also on the asynchronous sign-in path.
  const bad = await rawHello(url, { issuer: p.issuer, token: await p.issue() }, { name: null, auto: { host: { toString: 1 } }, mode: "peer", claim: { action: "acquire" } });
  assert.equal(bad.code, 4001);
  // A revoked sign-in whose client never answers the close: gone from the list at once, and
  // messages for it wait in the queue instead of going to it.
  const ws = new WebSocket(url);
  const frames = [];
  await new Promise((r) => ws.on("open", r));
  ws.on("message", (d) => frames.push(JSON.parse(d)));
  ws.send(JSON.stringify({ type: "hello", v: 2, name: "alice-slow", auth: { kind: "oidc", issuer: p.issuer, token: await p.issue() }, host: "pc", mode: "peer", claim: { action: "acquire" } }));
  for (let i = 0; i < 30 && !frames.some((f) => f.type === "welcome"); i++) await sleep(100);
  assert.ok(frames.some((f) => f.type === "welcome"));
  ws._socket.pause(); // the close handshake never completes on our side
  const other = new RelayClient({ url, name: "alice-other", mode: "send", signIn: signIn() });
  t.after(() => other.close());
  await other.start().ready();
  assert.ok((await other.list()).some((x) => x.name === "alice-slow" && x.online));
  p.revoke("user-1");
  let listed = true;
  for (let i = 0; i < 60 && listed; i++) {
    await sleep(100);
    listed = (await other.list().catch(() => [])).some((x) => x.name === "alice-slow" && x.online);
  }
  assert.equal(listed, false, "no longer online as soon as it is cut off");
  ws.terminate();
});

test("the provider's keys unreachable: the sign-in is unavailable (tried again), not a bad token", async (t) => {
  const { p, url } = await setup(t, { verifierOptions: { jwksCooldownMs: 0 } });
  p.jwksDown = true;
  const r = await rawHello(url, { issuer: p.issuer, token: await p.issue() });
  assert.equal(r.error, "unavailable");
  p.jwksDown = false;
  await sleep(1200); // past the fetch backoff
  assert.ok((await rawHello(url, { issuer: p.issuer, token: await p.issue() })).welcome);
});

test("a first sign-in against a slow provider is not cut off by the hello timeout", async (t) => {
  const { p, url } = await setup(t);
  p.slowMs = 3000; // discovery and keys: each within its fetch timeout, together longer than a hello
  const token = await p.issue();
  const welcomed = await new Promise((resolve) => {
    const ws = new WebSocket(url);
    ws.on("open", () => ws.send(JSON.stringify({ type: "hello", v: 2, name: "alice-slow2", auth: { kind: "oidc", issuer: p.issuer, token }, host: "pc", mode: "send" })));
    ws.on("message", (d) => JSON.parse(d).type === "welcome" && (ws.close(), resolve(true)));
    ws.on("close", () => resolve(false));
    ws.on("error", () => {});
  });
  assert.equal(welcomed, true);
});

test("an issuer identifier ending in a slash is kept exactly, in links and in token checks", async (t) => {
  const { p, url } = await setup(t, { provider: { trailingSlash: true } });
  assert.ok(p.issuer.endsWith("/"));
  assert.ok((await rawHello(url, { issuer: p.issuer, token: await p.issue() })).welcome);
  assert.equal((await rawHello(url, { issuer: p.issuer.replace(/\/$/, ""), token: await p.issue() })).error, "unsupported_auth", "not the same identifier");
});

test("a refused connection to the provider's keys is unavailable, for hellos and renewals alike", async (t) => {
  const { p, cfg } = await setup(t);
  const real = boundedFetch();
  const fetcher = (url, o) => (String(url).includes("/jwks") ? Promise.reject(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } })) : real(url, o));
  const v = await createVerifier(cfg, { fetcher, jwksCooldownMs: 0 });
  await assert.rejects(v.verify(p.issuer, await p.issue()), (e) => e.code === "unavailable");
});

test("a slow token source does not use up the relay's hello window", async (t) => {
  const { url, signIn } = await setup(t);
  const slow = async () => (await sleep(5500), signIn()());
  const c = new RelayClient({ url, name: "alice-patient", signIn: slow });
  t.after(() => c.close());
  await c.start().ready(15_000);
  assert.equal(c.member.id, ALICE);
});

test("a rate-limited key set (HTTP 429) is unavailable, not a bad token", async (t) => {
  const { p, url } = await setup(t, { verifierOptions: { jwksCooldownMs: 0 } });
  p.jwksDown = 429;
  assert.equal((await rawHello(url, { issuer: p.issuer, token: await p.issue() })).error, "unavailable");
});

test("an introspected sign-in past its freshness bound is served no more, even before its timer runs", async (t) => {
  const { url, signIn } = await setup(t, { provider: { opaque: true }, issuer: { validation: "introspection", requiredClaims: { typ: "Bearer" } }, config: { maxRevocationDelaySeconds: 30 } });
  const c = new RelayClient({ url, name: "alice-fresh", reconnect: false, signIn: signIn() });
  t.after(() => c.close());
  await c.start().ready();
  const real = Date.now;
  Date.now = () => real() + 31_000; // the clock passes checkedAt + delay; the timers have not run
  t.after(() => (Date.now = real));
  const closed = new Promise((r) => c.ws.once("close", (code) => r(code)));
  await c.list().catch(() => {});
  assert.equal(await closed, 4003);
});

test("a key set that is not JSON (a proxy page) is unavailable; repaired, sign-in works again", async (t) => {
  const { p, url } = await setup(t, { verifierOptions: { jwksCooldownMs: 0 } });
  p.jwksBody = "<html>temporary proxy page</html>";
  assert.equal((await rawHello(url, { issuer: p.issuer, token: await p.issue() })).error, "unavailable");
  p.jwksBody = null;
  await sleep(1200); // past the fetch backoff
  assert.ok((await rawHello(url, { issuer: p.issuer, token: await p.issue() })).welcome);
});
