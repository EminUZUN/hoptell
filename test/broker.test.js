// Broker mode (design 1.7): the relay signs the user in at an ID-token-only provider and issues
// its own credential. Against the test provider; the test plays the browser (it follows the
// redirects) and the CLI.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { RelayClient } from "../lib/client.js";
import { brokerReset, encodeRefresh, exactRedirect, parseRefresh } from "../lib/broker.js";
import { startProvider } from "./fixtures/oidc-provider.mjs";
import { ALICE, BOB, authorizeUrl, b64u, browse, cliRequest, familiesOf, freePort, hello, post, redeem, refresh, setup, signInBrowser, tmp } from "./fixtures/broker-relay.mjs";
import { sleep } from "./helpers.js";

// ---- the token format ----------------------------------------------------------------------------

test("refresh tokens: the fixed vector, canonical encoding, and refusals that never parse", () => {
  const key = Buffer.alloc(32, 7);
  const family = Buffer.alloc(16, 1);
  const random = Buffer.alloc(32, 2);
  const token = encodeRefresh(key, family, 5, random);
  // The MAC by the design's definition, computed here independently.
  const lp = (b) => Buffer.concat([Buffer.from([(b.length >>> 24) & 255, (b.length >>> 16) & 255, (b.length >>> 8) & 255, b.length & 255]), b]);
  const mac = crypto.createHmac("sha256", key).update(Buffer.concat([lp(Buffer.from("hoptell refresh v1")), lp(family), lp(Buffer.from([0, 0, 0, 5])), lp(random)])).digest();
  assert.equal(token, `hr1_${b64u(family)}.5.${b64u(random)}.${b64u(mac)}`);
  // The fixed vector: key 32 x 0x07, family 16 x 0x01, generation 5, random 32 x 0x02.
  assert.equal(token, "hr1_AQEBAQEBAQEBAQEBAQEBAQ.5.AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI.rhB2MXGVfAg4CwjQyjqpSWq8VYcY83x1DV-9fPARqX0");
  assert.deepEqual(parseRefresh(key, token), { family: b64u(family), generation: 5, digest: crypto.createHash("sha256").update(token).digest("hex") });
  const [f, , r, m] = token.slice(4).split(".");
  const bad = [
    `hr1_${f}.05.${r}.${m}`, // leading zero
    `hr1_${f}.2147483648.${r}.${m}`, // out of range
    `hr1_${f}.-1.${r}.${m}`,
    `hr1_${f}=.5.${r}.${m}`, // padded
    `hr1_${f.slice(0, -1)}R.5.${r}.${m}`, // non-canonical last character
    `hr1_${f}.5.${r}.${m}.x`,
    `hr2_${f}.5.${r}.${m}`,
    `hr1_${f}.6.${r}.${m}`, // the MAC does not cover another generation
    encodeRefresh(Buffer.alloc(32, 8), family, 5, random), // another key
  ];
  for (const b of bad) assert.equal(parseRefresh(key, b), null, b);
  assert.equal(exactRedirect("http://127.0.0.1:8080/callback"), "http://127.0.0.1:8080/callback");
  assert.equal(exactRedirect("http://[::1]:8080/callback"), "http://[::1]:8080/callback");
  for (const r2 of ["http://localhost:8080/callback", "http://127.0.0.1/callback", "http://127.0.0.1:8080/callback/", "http://127.0.0.1:8080/callback?x=1", "http://u@127.0.0.1:8080/callback", "https://127.0.0.1:8080/callback", "http://127.0.0.1:08080/callback", "http://127.0.0.1:99999/callback"]) assert.equal(exactRedirect(r2), null, r2);
});

// ---- the flow --------------------------------------------------------------------------------------

test("the full flow: browser sign-in, one-time code, our credential, and a connection as the member", async (t) => {
  const s = await setup(t);
  const leg = await signInBrowser(s);
  assert.equal(leg.state, leg.req.state, "the CLI's own state comes back");
  assert.match(leg.code, /^hk_[A-Za-z0-9_-]{43}$/);
  const r = await redeem(s, leg);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.headers.get("cache-control"), "no-store");
  assert.match(r.body.access_token, /^ha_/);
  assert.match(r.body.refresh_token, /^hr1_/);
  const h = await hello(s, r.body.access_token);
  assert.equal(h.welcome, true, h.error);
  assert.equal(h.member?.id, ALICE);
  h.client.close();
  // The discovery names the broker and its endpoints on the relay's own origin.
  const doc = await (await fetch(`${s.base}/.well-known/hoptell`)).json();
  const e = doc.issuers.find((i) => i.mode === "broker");
  assert.equal(e.id, "idp");
  assert.equal(e.endpoints.token, `${s.base}/oidc/idp/token`);
  assert.match(e.configId, /^[0-9a-f]{64}$/);
  // A broker token is never tried as another kind of credential, and vice versa.
  const asOidc = await new Promise((resolve) => {
    const c = new RelayClient({ url: s.url, signIn: async () => ({ issuer: s.p.issuer, token: r.body.access_token, expiresAt: Date.now() + 600_000 }), name: "alice-y", mode: "send", reconnect: false });
    c.on("ready", () => resolve("accepted"));
    c.on("fatal", () => resolve(c.helloError?.code));
    c.start();
  });
  assert.equal(asOidc, "unsupported_auth");
  assert.equal((await hello(s, r.body.refresh_token)).hello, "bad_token");
});

test("ID token checks: nonce, audience, issuer and expiry; the callback's iss must match", async (t) => {
  const s = await setup(t);
  const now = Math.floor(Date.now() / 1000);
  for (const tamper of [{ claims: { nonce: "other" } }, { audience: "someone-else" }, { issuer: "http://127.0.0.1:1" }, { exp: now - 600, iat: now - 900 }, { claims: { azp: "another-client" }, audience: ["hoptell-broker", "another-client"] }]) {
    s.p.idTokenTamper = tamper;
    const r = await browse(authorizeUrl(s, cliRequest()));
    assert.equal(r.status, 400, `${JSON.stringify(tamper)}: ${r.text?.slice(0, 200)}`);
    assert.match(r.text, /Sign-in refused/);
  }
  s.p.idTokenTamper = null;
  assert.ok((await signInBrowser(s)).code, "and the untampered one works");
  assert.equal(s.broker.status().codes, 1);
});

test("an unlinked identity gets a page naming issuer and subject (escaped), and no credential", async (t) => {
  const s = await setup(t);
  s.p.signIn = { sub: "<b>user</b>-2", name: "x", groups: [] };
  const r = await browse(authorizeUrl(s, cliRequest()));
  assert.equal(r.status, 403);
  assert.match(r.text, /&lt;b&gt;user&lt;\/b&gt;-2/);
  assert.doesNotMatch(r.text, /<b>user/);
  assert.ok(r.text.includes(s.p.issuer));
  assert.equal(r.headers.get("content-security-policy"), "default-src 'none'");
  assert.equal(r.headers.get("referrer-policy"), "no-referrer");
  assert.equal(s.broker.status().codes, 0);
});

test("authorize is strict: exact parameters, the loopback redirect form, S256 only", async (t) => {
  const s = await setup(t);
  const req = cliRequest();
  const good = { response_type: "code", client_id: "hoptell-cli", redirect_uri: req.redirect, code_challenge: req.challenge, code_challenge_method: "S256", state: req.state };
  const bad = [
    { ...good, code_challenge_method: "plain" },
    { ...good, code_challenge: "short" },
    { ...good, client_id: "someone" },
    { ...good, response_type: "token" },
    { ...good, redirect_uri: "http://localhost:4000/callback" },
    { ...good, redirect_uri: "http://127.0.0.1:4000/other" },
    { ...good, redirect_uri: "http://127.0.0.1/callback" },
    { ...good, state: "" },
    { ...good, extra: "1" },
  ];
  const { state: _s, ...noState } = good;
  void _s;
  for (const p of [...bad, noState]) assert.equal((await fetch(authorizeUrl(s, req, "idp", p), { redirect: "manual" })).status, 400, JSON.stringify(p));
  const dup = [...Object.entries(good), ["state", "again"]];
  assert.equal((await fetch(authorizeUrl(s, req, "idp", dup), { redirect: "manual" })).status, 400, "a repeated parameter");
  assert.equal((await fetch(authorizeUrl(s, req, "idp", good), { redirect: "manual" })).status, 302);
});

test("the callback: an unknown or swapped state, another broker's endpoint, a mismatched iss", async (t) => {
  const s = await setup(t, { extra: [{ id: "idp2", client: { clientId: "other-client", clientSecret: "other-secret" } }] });
  // Start at idp, deliver the provider's answer to idp2's callback: refused (the path selects the issuer).
  const req = cliRequest();
  const first = await fetch(authorizeUrl(s, req), { redirect: "manual" });
  const atProvider = await fetch(first.headers.get("location"), { redirect: "manual" });
  const callback = new URL(atProvider.headers.get("location"));
  const crossed = new URL(callback.href.replace("/oidc/idp/callback", "/oidc/idp2/callback"));
  const r1 = await fetch(crossed, { redirect: "manual" });
  assert.equal(r1.status, 400);
  // The record was consumed by that attempt: the right endpoint now refuses it too.
  assert.equal((await fetch(callback, { redirect: "manual" })).status, 400, "a pending record is used once, whatever the outcome");
  // An unknown state, and an iss of another provider.
  assert.equal((await fetch(`${s.base}/oidc/idp/callback?code=x&state=unknown`, { redirect: "manual" })).status, 400);
  const req2 = cliRequest();
  const a2 = await fetch((await fetch(authorizeUrl(s, req2), { redirect: "manual" })).headers.get("location"), { redirect: "manual" });
  const cb2 = new URL(a2.headers.get("location"));
  cb2.searchParams.set("iss", "http://127.0.0.1:1");
  assert.equal((await fetch(cb2, { redirect: "manual" })).status, 400);
  assert.equal(s.broker.status().codes, 0);
});

test("the one-time code: used once even when the first use fails; concurrent redemptions give one family", async (t) => {
  const s = await setup(t);
  // A wrong verifier consumes the code.
  const leg = await signInBrowser(s);
  assert.equal((await redeem(s, leg, { code_verifier: b64u(crypto.randomBytes(32)) })).body.error, "invalid_grant");
  assert.equal((await redeem(s, leg)).body.error, "invalid_grant", "consumed by the failed attempt");
  // Another redirect than the one it was issued for.
  const leg2 = await signInBrowser(s);
  assert.equal((await redeem(s, leg2, { redirect_uri: "http://127.0.0.1:49153/callback" })).body.error, "invalid_grant");
  // Concurrent redemptions: one family.
  const leg3 = await signInBrowser(s);
  const rs = await Promise.all([redeem(s, leg3), redeem(s, leg3), redeem(s, leg3)]);
  assert.deepEqual(rs.map((r) => r.status).toSorted(), [200, 400, 400]);
  assert.equal(Object.keys(familiesOf(s)).length, 1);
  // Codes are only valid at their own broker and for their own CLI client.
  const leg4 = await signInBrowser(s);
  assert.equal((await redeem(s, leg4, { client_id: "someone" })).status, 401);
});

// ---- refresh ---------------------------------------------------------------------------------------

test("refresh rotates; a genuine old token is a replay that ends the family, also after a restart", async (t) => {
  const stateDir = tmp(t);
  const p = await startProvider({ clients: { "hoptell-broker": { secret: "broker-secret" } } });
  t.after(() => p.close());
  const port = await freePort();
  let s = await setup(t, { stateDir, port, p, provider: { keep: true } });
  const first = await redeem(s, await signInBrowser(s));
  const gen0 = first.body.refresh_token;
  let current = gen0;
  for (let i = 0; i < 40; i++) {
    const r = await refresh(s, current);
    assert.equal(r.status, 200, `rotation ${i}: ${JSON.stringify(r.body)}`);
    current = r.body.refresh_token;
  }
  assert.equal(Object.values(familiesOf(s))[0].generation, 40);
  // A connection of this family, then a relay restart (the access-token table is gone).
  const live = await hello(s, (await refresh(s, current)).body.access_token);
  assert.equal(live.welcome, true);
  current = null; // spent by that refresh; the next is in the family record only
  await s.close();
  s = await setup(t, { stateDir, port, p, provider: { keep: true } });
  // A fabricated token (a valid shape, a wrong MAC) revokes nothing.
  const [, , r, m] = gen0.slice(4).split(".");
  const fabricated = `hr1_${Object.keys(familiesOf(s))[0]}.0.${r}.${m.slice(0, -2)}AA`;
  assert.equal((await refresh(s, fabricated)).body.error, "invalid_grant");
  assert.equal(Object.values(familiesOf(s))[0].revoked, null, "a forged token ends nothing");
  // The genuine generation 0, after 41 rotations and a restart: replay, the family ends.
  const replay = await refresh(s, gen0);
  assert.equal(replay.body.error, "invalid_grant");
  assert.match(replay.body.error_description, /used elsewhere/);
  assert.equal(Object.values(familiesOf(s))[0].revoked.why, "refresh token replay");
});

test("a replay ends the family's live connections at once", async (t) => {
  const s = await setup(t);
  const a = await redeem(s, await signInBrowser(s));
  const b = await refresh(s, a.body.refresh_token);
  const live = await hello(s, b.body.access_token);
  assert.equal(live.welcome, true);
  const closed = new Promise((r) => live.client.once("fatal", r).once("down", r));
  await refresh(s, a.body.refresh_token); // the old generation again
  assert.match(String(await closed), /revoked|4003/);
  assert.equal((await hello(s, b.body.access_token)).hello, "token_expired", "its access tokens are gone too");
});

test("future generations and a current generation with a wrong digest are refused without ending anything", async (t) => {
  const s = await setup(t);
  const a = await redeem(s, await signInBrowser(s));
  const key = Buffer.from(fs.readFileSync(path.join(s.stateDir, "broker", "refresh.key"), "utf8").trim(), "base64url");
  const family = Buffer.from(Object.keys(familiesOf(s))[0], "base64url");
  const future = encodeRefresh(key, family, 7, crypto.randomBytes(32));
  const sameGenOtherRandom = encodeRefresh(key, family, 0, crypto.randomBytes(32));
  assert.equal((await refresh(s, future)).body.error, "invalid_grant");
  assert.equal((await refresh(s, sameGenOtherRandom)).body.error, "invalid_grant");
  assert.equal(Object.values(familiesOf(s))[0].revoked, null);
  assert.equal((await refresh(s, a.body.refresh_token)).status, 200, "the real token still works");
});

test("revocation ends a family and answers the same for unknown tokens", async (t) => {
  const s = await setup(t);
  const a = await redeem(s, await signInBrowser(s));
  assert.equal((await post(s, "revoke", { token: "hr1_nonsense", client_id: "hoptell-cli" })).status, 200);
  assert.equal((await post(s, "revoke", { token: a.body.refresh_token, client_id: "hoptell-cli" })).status, 200);
  assert.equal(Object.values(familiesOf(s))[0].revoked.why, "signed out");
  assert.equal((await refresh(s, a.body.refresh_token)).body.error, "invalid_grant");
});

test("hard re-verification, idle and absolute expiry end a family; a healthy connection ends at the deadline", async (t) => {
  const s = await setup(t, { issuer: { reverifyAfterSeconds: 2, accessTokenSeconds: 900 } });
  const a = await redeem(s, await signInBrowser(s));
  assert.ok(a.body.expires_in <= 2, "the access token ends no later than the re-verification");
  const t0 = Date.now();
  const live = await hello(s, a.body.access_token);
  assert.equal(live.welcome, true);
  // The connection's deadline is no later than the re-verification plus the one skew.
  assert.ok(live.client.authDeadline <= t0 + 2000 + 60_000, `deadline ${live.client.authDeadline - t0} ms`);
  live.client.close();
  await sleep(2500);
  assert.equal((await refresh(s, a.body.refresh_token)).body.error, "invalid_grant", "a fresh sign-in is due");
  assert.equal((await hello(s, a.body.access_token)).hello, "token_expired", "and its access token ended with it");
});

test("20 active sign-ins per member; members removed, unlinked or signed out end their sign-ins", async (t) => {
  const s = await setup(t);
  const tokens = [];
  for (let i = 0; i < 20; i++) tokens.push((await redeem(s, await signInBrowser(s))).body);
  const r = await browse(authorizeUrl(s, cliRequest()));
  assert.equal(r.status, 409, "a 21st sign-in is refused at the callback");
  assert.match(r.text, /sign out elsewhere first/);
  // Signout by the admin (members file: signedOutAt, then a reload): every family made until now ends.
  const live = await hello(s, tokens[0].access_token);
  const closed = new Promise((res) => live.client.once("fatal", res).once("down", res));
  s.relay.reload([{ ...s.members[0], signedOutAt: Date.now() }]);
  await closed;
  assert.equal(Object.values(familiesOf(s)).filter((f) => !f.revoked).length, 0);
  // A sign-in after the signout works.
  const fresh = (await redeem(s, await signInBrowser(s))).body;
  assert.equal((await hello(s, fresh.access_token)).welcome, true);
  // Relinked to another member: the family does not move with the identity.
  s.relay.reload([{ name: "alice", id: ALICE, token: "a".repeat(64) }, { name: "bob", id: BOB, oidc: [{ issuer: s.p.issuer, subject: "user-1" }] }]);
  assert.equal((await refresh(s, fresh.refresh_token)).body.error, "invalid_grant");
  assert.equal(Object.values(familiesOf(s)).filter((f) => !f.revoked).length, 0);
});

// ---- state ------------------------------------------------------------------------------------------

test("a missing or damaged refresh key, or a damaged families file, disables broker sign-in until fixed", async (t) => {
  const p = await startProvider({ clients: { "hoptell-broker": { secret: "broker-secret" } } });
  t.after(() => p.close());
  const stateDir = tmp(t);
  const port = await freePort();
  let s = await setup(t, { stateDir, port, p, provider: { keep: true } });
  const a = await redeem(s, await signInBrowser(s));
  await s.close();
  // The key is lost while families exist: no new key is made silently.
  fs.rmSync(path.join(stateDir, "broker", "refresh.key"));
  s = await setup(t, { stateDir, port, p, provider: { keep: true } });
  assert.match(s.broker.status().disabled, /missing: run hoptell relay broker-reset/);
  assert.equal(fs.existsSync(path.join(stateDir, "broker", "refresh.key")), false);
  assert.equal((await refresh(s, a.body.refresh_token)).status, 503);
  assert.equal((await fetch(authorizeUrl(s, cliRequest()), { redirect: "manual" })).status, 503);
  await s.close();
  // The explicit reset: a new key, every family ended.
  assert.equal(brokerReset(stateDir), 1);
  s = await setup(t, { stateDir, port, p, provider: { keep: true } });
  assert.equal(s.broker.status().disabled, null);
  assert.equal((await refresh(s, a.body.refresh_token)).body.error, "invalid_grant");
  assert.ok((await redeem(s, await signInBrowser(s))).body.refresh_token, "new sign-ins work");
  await s.close();
  // A damaged families file: broker sign-in stops; member tokens keep working.
  fs.writeFileSync(path.join(stateDir, "broker", "families.json"), "{nope");
  s = await setup(t, { stateDir, port, p, provider: { keep: true }, members: [{ name: "alice", id: ALICE, token: "t".repeat(64), oidc: [{ issuer: p.issuer, subject: "user-1" }] }] });
  assert.match(s.broker.status().disabled, /cannot be read or is invalid/);
  assert.equal(fs.readFileSync(path.join(stateDir, "broker", "families.json"), "utf8"), "{nope", "never reinitialized silently");
  const member = await new Promise((resolve) => {
    const c = new RelayClient({ url: s.url, token: "t".repeat(64), name: "alice-z", mode: "send", reconnect: false });
    c.on("ready", () => (c.close(), resolve("connected")));
    c.on("fatal", (e) => resolve(e));
    c.start();
  });
  assert.equal(member, "connected");
});

test("a changed provider configuration refuses pending sign-ins and ends their families at startup", async (t) => {
  const p = await startProvider({ clients: { "hoptell-broker": { secret: "broker-secret" }, "other-client": { secret: "other-secret" } } });
  t.after(() => p.close());
  const stateDir = tmp(t);
  const port = await freePort();
  let s = await setup(t, { stateDir, port, p, provider: { keep: true } });
  const a = await redeem(s, await signInBrowser(s));
  await s.close();
  // A rotated client secret with the same client id keeps everything.
  s = await setup(t, { stateDir, port, p, provider: { keep: true } });
  assert.equal((await refresh(s, a.body.refresh_token)).status, 200);
  await s.close();
  // Another provider client id for the same broker id: the families end.
  s = await setup(t, { stateDir, port, p, provider: { keep: true }, issuer: { client: { clientId: "other-client", clientSecret: "other-secret" } } });
  assert.equal(Object.values(familiesOf(s))[0].revoked.why, "provider configuration changed");
});

test("durable-write fault windows: before the replacement retryable, after it an unknown outcome", async (t) => {
  for (const point of ["file-fsync", "rename", "dir-fsync"]) {
    let armed = null;
    const fault = (at, file) => {
      if (armed === at && (file.endsWith("families.json") || (at === "dir-fsync" && file.endsWith("broker")))) {
        armed = null;
        throw Object.assign(new Error(`injected ${at}`), { code: "EIO" });
      }
    };
    const p = await startProvider({ clients: { "hoptell-broker": { secret: "broker-secret" } } });
    t.after(() => p.close());
    const stateDir = tmp(t);
    const port = await freePort();
    let s = await setup(t, { fault, stateDir, port, p, provider: { keep: true } });
    const a = await redeem(s, await signInBrowser(s));
    const before = familiesOf(s);
    armed = point;
    const r = await refresh(s, a.body.refresh_token);
    assert.equal(r.body.refresh_token, undefined, `${point}: no token was issued`);
    if (point !== "dir-fsync") {
      // Before the replacement: nothing changed, the same token may be sent again.
      assert.equal(r.status, 503, `${point}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.error, "temporarily_unavailable");
      assert.deepEqual(familiesOf(s), before, `${point}: nothing changed on disk`);
      assert.equal((await refresh(s, a.body.refresh_token)).status, 200);
      await s.close();
      continue;
    }
    // After the replacement: the new generation is on disk; the outcome is unknown (500), and the
    // client must not resend. Across a restart, the old token is a replay.
    assert.equal(r.status, 500, JSON.stringify(r.body));
    assert.equal(r.body.error, "server_error");
    assert.equal(Object.values(familiesOf(s))[0].generation, 1, "the replacement happened");
    await s.close();
    s = await setup(t, { stateDir, port, p, provider: { keep: true } });
    const again = await refresh(s, a.body.refresh_token);
    assert.equal(again.body.error, "invalid_grant");
    assert.equal(Object.values(familiesOf(s))[0].revoked.why, "refresh token replay");
  }
});

test("a revocation that cannot be written is not reported as done (logout and replay), also across a restart", async (t) => {
  const p = await startProvider({ clients: { "hoptell-broker": { secret: "broker-secret" } } });
  t.after(() => p.close());
  let failing = false;
  const fault = (at, file) => {
    if (failing && at === "rename" && file.endsWith("families.json")) throw Object.assign(new Error("injected"), { code: "EIO" });
  };
  // Logout.
  {
    const stateDir = tmp(t);
    const port = await freePort();
    let s = await setup(t, { fault, stateDir, port, p, provider: { keep: true } });
    const a = await redeem(s, await signInBrowser(s));
    failing = true;
    const out = await post(s, "revoke", { token: a.body.refresh_token, client_id: "hoptell-cli" });
    assert.equal(out.status, 503, "not acknowledged");
    assert.equal(Object.values(familiesOf(s))[0].revoked, null);
    assert.equal((await hello(s, a.body.access_token)).hello, "token_expired", "in effect in this process");
    assert.equal((await refresh(s, a.body.refresh_token)).status, 503, "and nothing is issued meanwhile");
    failing = false;
    await s.close();
    // After a restart the unacknowledged sign-out is not in effect; the client was told it failed and retries.
    s = await setup(t, { stateDir, port, p, provider: { keep: true } });
    assert.equal((await post(s, "revoke", { token: a.body.refresh_token, client_id: "hoptell-cli" })).status, 200);
    assert.equal(Object.values(familiesOf(s))[0].revoked.why, "signed out");
    await s.close();
  }
  // Replay.
  {
    const stateDir = tmp(t);
    const port = await freePort();
    let s = await setup(t, { fault, stateDir, port, p, provider: { keep: true } });
    const a = await redeem(s, await signInBrowser(s));
    const b = await refresh(s, a.body.refresh_token);
    failing = true;
    const r = await refresh(s, a.body.refresh_token); // the old generation
    assert.equal(r.status, 500, "the reuse is not claimed as recorded");
    assert.doesNotMatch(r.body.error_description ?? "", /has been ended/);
    assert.equal((await refresh(s, b.body.refresh_token)).status, 503, "nothing is issued while it is unwritten");
    failing = false;
    await s.close();
    s = await setup(t, { stateDir, port, p, provider: { keep: true } });
    // The old token presented again after the restart is detected again and now recorded.
    assert.equal((await refresh(s, a.body.refresh_token)).body.error, "invalid_grant");
    assert.equal(Object.values(familiesOf(s))[0].revoked.why, "refresh token replay");
    assert.equal((await refresh(s, b.body.refresh_token)).body.error, "invalid_grant");
    await s.close();
  }
});

test("requireReauthentication: max_age=0 is sent and an old auth_time is refused", async (t) => {
  const s = await setup(t, { issuer: { requireReauthentication: true } });
  assert.ok((await signInBrowser(s)).code, "a fresh sign-in (auth_time now) is accepted");
  assert.equal(s.p.lastAuthorize.get("max_age"), "0");
  s.p.idTokenTamper = { claims: { auth_time: Math.floor(Date.now() / 1000) - 3600 } };
  const r = await browse(authorizeUrl(s, cliRequest()));
  assert.equal(r.status, 400);
});

test("the token endpoint is rate limited per client address, before any change", async (t) => {
  const s = await setup(t);
  const a = await redeem(s, await signInBrowser(s));
  const statuses = [];
  for (let i = 0; i < 65; i++) statuses.push((await post(s, "token", { grant_type: "refresh_token", refresh_token: "hr1_x", client_id: "hoptell-cli" })).status);
  assert.ok(statuses.includes(429), "slow_down once over the limit");
  const r = await refresh(s, a.body.refresh_token);
  assert.equal(r.status, 429);
  assert.equal(r.body.error, "slow_down");
  assert.equal(Object.values(familiesOf(s))[0].generation, 0, "nothing changed");
});

// ---- review fixes ----------------------------------------------------------------------------------

test("a saved sign-out applies at startup, and at once even when its revocation cannot be written", async (t) => {
  const p = await startProvider({ clients: { "hoptell-broker": { secret: "broker-secret" } } });
  t.after(() => p.close());
  const stateDir = tmp(t);
  const port = await freePort();
  let s = await setup(t, { stateDir, port, p, provider: { keep: true } });
  const a = await redeem(s, await signInBrowser(s));
  const member = s.members[0];
  await s.close();
  // Restart with the sign-out already in the members file: the family ends before any traffic.
  s = await setup(t, { stateDir, port, p, provider: { keep: true }, members: [{ ...member, signedOutAt: Date.now() }] });
  assert.equal((await refresh(s, a.body.refresh_token)).body.error, "invalid_grant");
  assert.match(Object.values(familiesOf(s))[0].revoked?.why ?? "", /signed out/);
  await s.close();
  // A sign-out whose durable revocation fails: refused at once anyway, connections fenced, written later.
  let failing = false;
  const fault = (at, file) => {
    if (failing && at === "rename" && file.endsWith("families.json")) throw Object.assign(new Error("injected"), { code: "EIO" });
  };
  s = await setup(t, { stateDir: tmp(t), port: await freePort(), p, provider: { keep: true }, fault });
  const b = await redeem(s, await signInBrowser(s));
  const live = await hello(s, b.body.access_token);
  assert.equal(live.welcome, true);
  const closed = new Promise((r) => live.client.once("fatal", r).once("down", r));
  failing = true;
  s.relay.reload([{ ...member, signedOutAt: Date.now() }]);
  await closed;
  assert.equal(s.broker.status().unwrittenRevocations, 1);
  assert.equal((await hello(s, b.body.access_token)).hello, "token_expired");
  assert.equal((await refresh(s, b.body.refresh_token)).body.error, "temporarily_unavailable", "nothing is issued while a revocation is unwritten");
  assert.equal(Object.values(familiesOf(s))[0].revoked, null, "not yet on disk");
  failing = false;
  assert.equal(s.broker.flushRevocations(), 0);
  assert.match(Object.values(familiesOf(s))[0].revoked.why, /signed out/);
});

test("private_key_jwt: an RSA key in PEM and an EC key as JWK sign the relay in at the provider", async (t) => {
  const { loadOidcConfig } = await import("../lib/oidc.js");
  for (const [type, opts, format] of [["rsa", { modulusLength: 2048 }, "pem"], ["ec", { namedCurve: "P-256" }, "jwk"]]) {
    const { publicKey, privateKey } = crypto.generateKeyPairSync(type, opts);
    const pub = publicKey.export({ format: "jwk" });
    const p = await startProvider({ clients: { "hoptell-broker-pk": { jwk: { ...pub, alg: type === "rsa" ? "RS256" : "ES256" } } } });
    t.after(() => p.close());
    const dir = tmp(t);
    const keyFile = path.join(dir, "client.key");
    fs.writeFileSync(keyFile, format === "pem" ? privateKey.export({ format: "pem", type: "pkcs8" }) : JSON.stringify({ ...privateKey.export({ format: "jwk" }), kid: "k1" }), { mode: 0o600 });
    const cfgFile = path.join(dir, "oidc.json");
    fs.writeFileSync(cfgFile, JSON.stringify({ version: 1, issuers: [{ issuer: p.issuer, mode: "broker", id: "idp", publicBaseUrl: "http://127.0.0.1:1", client: { clientId: "hoptell-broker-pk", privateKeyFile: keyFile } }] }), { mode: 0o600 });
    const loaded = loadOidcConfig(cfgFile).issuers[0];
    const s = await setup(t, { p, provider: { keep: true }, issuer: { client: loaded.client } });
    const leg = await signInBrowser(s);
    assert.ok(leg.code, `${type}/${format}: the code exchange at the provider authenticated with the key`);
    assert.ok(s.p.assertions >= 1);
  }
  // An unsupported key type is refused when the configuration is loaded.
  const dir = tmp(t);
  const dsa = crypto.generateKeyPairSync("ec", { namedCurve: "secp256k1" }).privateKey.export({ format: "pem", type: "pkcs8" });
  fs.writeFileSync(path.join(dir, "k"), dsa, { mode: 0o600 });
  fs.writeFileSync(path.join(dir, "o.json"), JSON.stringify({ version: 1, issuers: [{ issuer: "https://idp.example", mode: "broker", id: "idp", publicBaseUrl: "https://relay.example", client: { clientId: "c", privateKeyFile: path.join(dir, "k") } }] }), { mode: 0o600 });
  assert.throws(() => loadOidcConfig(path.join(dir, "o.json")), /RSA, P-256, P-384 or Ed25519/);
});

test("the ID token's signature is checked against the provider's keys", async (t) => {
  const s = await setup(t);
  s.p.idTokenTamper = { badSignature: true };
  const r = await browse(authorizeUrl(s, cliRequest()));
  assert.equal(r.status, 400);
  assert.equal(s.broker.status().codes, 0);
  assert.ok(s.p.jwksFetches >= 1, "the keys were fetched");
  s.p.idTokenTamper = null;
  assert.ok((await signInBrowser(s)).code);
});

test("families past their re-verification deadline free their place in the 20-family limit", async (t) => {
  let clock = Date.now();
  const s = await setup(t, { now: () => clock });
  for (let i = 0; i < 20; i++) await redeem(s, await signInBrowser(s));
  assert.equal((await browse(authorizeUrl(s, cliRequest()))).status, 409);
  clock += 86_400_000 + 1000; // past the one-day re-verification, long before idle or absolute expiry
  assert.equal(s.broker.status().families, 0);
  assert.ok((await signInBrowser(s)).code, "a fresh sign-in is possible again");
});

test("simultaneous authorize requests cannot exceed the pending limits while discovery waits", async (t) => {
  const s = await setup(t);
  s.p.slowMs = 600; // discovery (first use) is slow
  const rs = await Promise.all(Array.from({ length: 30 }, () => fetch(authorizeUrl(s, cliRequest()), { redirect: "manual" })));
  const statuses = rs.map((r) => r.status);
  assert.equal(statuses.filter((x) => x === 302).length, 20, statuses.join(","));
  assert.equal(statuses.filter((x) => x === 429).length, 10);
  assert.ok(s.broker.status().pending <= 20);
});

test("removing every broker issuer ends their families at the next start", async (t) => {
  const { createBroker } = await import("../lib/broker.js");
  const s = await setup(t);
  await redeem(s, await signInBrowser(s));
  await s.close();
  const b = await createBroker({ issuers: [], stateDir: s.stateDir, log: () => {} });
  t.after(() => b.close());
  assert.equal(Object.values(familiesOf(s))[0].revoked.why, "provider configuration changed");
});

test("uncertain writes: a repeated sign-out after a post-replacement failure, and an unreadable read-back", async (t) => {
  const p = await startProvider({ clients: { "hoptell-broker": { secret: "broker-secret" } } });
  t.after(() => p.close());
  const faults = new Set();
  const fault = (at, file) => {
    if (faults.has(at) && (file.endsWith("families.json") || (at === "dir-fsync" && file.endsWith("broker")))) throw Object.assign(new Error(`injected ${at}`), { code: "EIO" });
  };
  // A sign-out whose directory sync keeps failing: never 200 until a write completes.
  {
    const s = await setup(t, { fault, p, provider: { keep: true } });
    const a = await redeem(s, await signInBrowser(s));
    faults.add("dir-fsync");
    assert.equal((await post(s, "revoke", { token: a.body.refresh_token, client_id: "hoptell-cli" })).status, 503);
    assert.equal((await post(s, "revoke", { token: a.body.refresh_token, client_id: "hoptell-cli" })).status, 503, "the retry is not taken as done");
    faults.delete("dir-fsync");
    assert.equal((await post(s, "revoke", { token: a.body.refresh_token, client_id: "hoptell-cli" })).status, 200, "done once a write completes");
    assert.equal(s.broker.status().unwrittenRevocations, 0);
    await s.close();
  }
  // A renewal whose directory sync fails and whose read-back fails too: unknown, terminal, fenced.
  {
    const stateDir = tmp(t);
    const port = await freePort();
    let s = await setup(t, { fault, stateDir, port, p, provider: { keep: true } });
    const a = await redeem(s, await signInBrowser(s));
    faults.add("dir-fsync");
    faults.add("read-back");
    const r = await refresh(s, a.body.refresh_token);
    assert.equal(r.status, 500, "an unknown outcome, not retryable");
    assert.equal(r.body.error, "server_error");
    faults.delete("dir-fsync");
    assert.equal((await refresh(s, a.body.refresh_token)).status, 503, "nothing is issued while the state cannot be read");
    faults.delete("read-back");
    await s.close();
    s = await setup(t, { stateDir, port, p, provider: { keep: true } });
    assert.equal(Object.values(familiesOf(s))[0].generation, 1, "the replacement had happened");
    assert.equal((await refresh(s, a.body.refresh_token)).body.error, "invalid_grant", "the old token is a replay: the client was right not to resend");
    await s.close();
  }
});

test("a sign-in with more than 100 groups is refused with a page, never cut short", async (t) => {
  const s = await setup(t);
  s.p.signIn = { ...(s.p.signIn ?? {}), sub: "user-1", groups: Array.from({ length: 101 }, (_, i) => `g${i}`) };
  const r = await browse(authorizeUrl(s, cliRequest()));
  assert.equal(r.status, 400);
  assert.match(r.text, /more than 100 groups/);
  assert.equal(s.broker.status().codes, 0);
});
