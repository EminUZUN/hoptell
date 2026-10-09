// The CLI side of broker mode (design 1.7): hoptell login through the relay, the token source's
// strict durable refresh state (one submission of a token whose outcome is unknown, in every
// process), and the client's single forced renewal after token_expired.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { RelayClient } from "../lib/client.js";
import { SignInError, login, logout, tokenSource } from "../lib/login.js";
import { profileKey } from "../lib/profiles.js";
import { startProvider } from "./fixtures/oidc-provider.mjs";
import { ALICE, browse, familiesOf, freePort, proxyTo, setup, tmp } from "./fixtures/broker-relay.mjs";
import { sleep } from "./helpers.js";

const CHILD = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "broker-signin-child.mjs");

/** A relay with broker sign-in behind a proxy (the CLI's relay URL is the proxy's). */
async function world(t, opts = {}) {
  const p = opts.p ?? (await startProvider({ clients: { "hoptell-broker": { secret: "broker-secret" } } }));
  if (!opts.p) t.after(() => p.close());
  const port = opts.port ?? (await freePort());
  const px = opts.px ?? (await proxyTo(t, port));
  const stateDir = opts.stateDir ?? tmp(t);
  const s = await setup(t, { port, publicPort: px.port, stateDir, p, provider: { keep: true }, issuer: opts.issuer ?? {} });
  const home = opts.home ?? tmp(t, "hoptell-cli-");
  const relayUrl = `ws://127.0.0.1:${px.port}`;
  return { ...s, p, px, port, stateDir, home, relayUrl, profile: profileKey(relayUrl) };
}
/** hoptell login, with the test as the browser (it follows the redirects to the CLI's loopback). */
const signInCli = (w, extra = {}) =>
  login({
    relayUrl: w.relayUrl,
    home: w.home,
    profile: w.profile,
    store: "file",
    passphrase: "test-passphrase-123",
    say: () => {},
    open: async (url) => {
      const r = await browse(url);
      if (r.cli) await fetch(r.cli.href);
    },
    ...extra,
  });
const source = (w, o = {}) => tokenSource({ home: w.home, profile: w.profile, relayUrl: w.relayUrl, passphrase: "test-passphrase-123", ...o });
const child = (w, env = {}) =>
  new Promise((resolve) => {
    const c = spawn(process.execPath, [CHILD, w.home, w.profile, w.relayUrl], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    c.stdout.on("data", (d) => (out += d));
    c.on("exit", (code, signal) => resolve({ code, signal, result: out.trim() ? JSON.parse(out.trim().split("\n").at(-1)) : null }));
  });
const theFamily = (w) => Object.values(familiesOf(w))[0];

test("broker login from the CLI: our credential, a session as the member, logout ends it at the relay", async (t) => {
  const w = await world(t);
  const r = await signInCli(w);
  assert.equal(r.kind, "broker");
  assert.equal(r.broker, "idp");
  const signIn = source(w);
  const a = await signIn();
  assert.equal(a.kind, "broker");
  assert.equal(a.issuer, "idp");
  const c = new RelayClient({ url: w.relayUrl, signIn, name: "alice-cli", mode: "send", reconnect: false });
  await c.start().ready(10_000);
  assert.equal(c.member.id, ALICE);
  c.close();
  const out = await logout({ home: w.home, profile: w.profile, passphrase: "test-passphrase-123" });
  assert.deepEqual(out, { removed: true, revoked: true, kind: "broker" });
  assert.equal(theFamily(w).revoked.why, "signed out");
});

test("login chooses the mode explicitly when one provider has both, and refuses endpoints elsewhere", async (t) => {
  const home = tmp(t, "hoptell-cli-");
  let doc = null;
  const server = http.createServer((_req, res) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(doc)));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));
  const relayUrl = `ws://127.0.0.1:${server.address().port}`;
  const origin = `http://127.0.0.1:${server.address().port}`;
  const broker = (o = {}) => ({ issuer: "https://idp.example", mode: "broker", id: "idp", configId: "c".repeat(64), endpoints: { authorize: `${origin}/oidc/idp/authorize`, token: `${origin}/oidc/idp/token`, revoke: `${origin}/oidc/idp/revoke` }, ...o });
  const resource = { issuer: "https://idp.example", mode: "resource", audience: "r", request: {}, cli: { clientId: "c", scopes: ["openid"] } };
  const attempt = (o = {}) => login({ relayUrl, home, profile: profileKey(relayUrl), store: "file", passphrase: "test-passphrase-123", say: () => {}, open: () => assert.fail("no browser for a refused sign-in"), ...o });
  doc = { hoptell: 1, realm: null, issuers: [resource, broker()] };
  await assert.rejects(attempt(), (e) => e instanceof SignInError && /--mode broker or --mode resource/.test(e.message));
  doc = { hoptell: 1, realm: null, issuers: [broker({ endpoints: { ...broker().endpoints, token: "https://evil.example/oidc/idp/token" } })] };
  await assert.rejects(attempt(), /not on the relay itself/);
  doc = { hoptell: 1, realm: null, issuers: [broker({ endpoints: { ...broker().endpoints, token: `${origin}/oidc/other/token` } })] };
  await assert.rejects(attempt(), /not on the relay itself/);
  doc = { hoptell: 1, realm: null, issuers: [broker()] };
  await assert.rejects(attempt({ mode: "device" }), /with the browser only/);
});

test("a refresh whose answer is lost: the old token was sent once, and every process then asks for login", async (t) => {
  const w = await world(t);
  await signInCli(w);
  w.px.state.posts = 0;
  w.px.state.dropTokenAnswers = 1;
  await assert.rejects(source(w)(), (e) => e instanceof SignInError && /answer was lost: run hoptell login/.test(e.message));
  assert.equal(w.px.state.posts, 1);
  assert.equal(theFamily(w).generation, 1, "the relay committed the rotation");
  // Again in this process, and in a new one: refused without sending anything.
  await assert.rejects(source(w)(), /answer was lost/);
  const c = await child(w);
  assert.equal(c.result.ok, false);
  assert.equal(c.result.terminal, true);
  assert.equal(w.px.state.posts, 1, "the old token was submitted exactly once in total");
  assert.equal(theFamily(w).revoked, null, "so no replay ended the sign-in");
  // A new login replaces the record, the mark included.
  await signInCli(w);
  assert.equal((await source(w)()).kind, "broker");
});

test("an explicit busy answer clears the mark, and so does a connection that never opened", async (t) => {
  const w = await world(t);
  await signInCli(w);
  w.px.state.answerBusy = 1;
  await assert.rejects(source(w)(), (e) => !e.terminal && /busy \(temporarily_unavailable\)/.test(e.message));
  const a = await source(w)();
  assert.equal(a.kind, "broker", "the next attempt sends again and succeeds");
  // The relay's port closed: not dispatched, so not terminal.
  await w.px.close();
  await assert.rejects(source(w)(), (e) => !e.terminal && /not reachable \(ECONNREFUSED\)/.test(e.message));
  const px2 = await proxyTo(t, w.port, { listenPort: w.px.port });
  void px2;
  assert.equal((await source(w)()).kind, "broker");
});

test("a process killed right after the mark sent nothing; later processes ask for login", async (t) => {
  const w = await world(t);
  await signInCli(w);
  w.px.state.posts = 0;
  const killed = await child(w, { KILL_AT: "broker-marked" });
  assert.equal(killed.signal, "SIGKILL");
  assert.equal(w.px.state.posts, 0);
  const later = await child(w);
  assert.equal(later.result.terminal, true);
  assert.match(later.result.error, /answer was lost/);
  assert.equal(w.px.state.posts, 0, "nothing was sent at all");
  assert.equal(theFamily(w).generation, 0);
});

test("the credential cannot be stored after a successful answer: terminal, the mark stays", async (t) => {
  const w = await world(t);
  await signInCli(w);
  let renames = 0;
  const fault = (point) => {
    if (point === "rename" && ++renames === 2) throw Object.assign(new Error("injected"), { code: "EIO" }); // the write after the answer
  };
  await assert.rejects(source(w, { fault })(), /answer was lost/);
  assert.equal(theFamily(w).generation, 1);
  await assert.rejects(source(w)(), /answer was lost/);
  assert.equal(theFamily(w).revoked, null);
});

test("two processes renewing at once: one after the other under the lock, nothing replayed", async (t) => {
  const w = await world(t);
  await signInCli(w);
  w.px.state.posts = 0;
  const [a, b] = await Promise.all([child(w), child(w)]);
  assert.equal(a.result.ok, true, JSON.stringify(a.result));
  assert.equal(b.result.ok, true, JSON.stringify(b.result));
  assert.equal(w.px.state.posts, 2);
  assert.equal(theFamily(w).generation, 2);
  assert.equal(theFamily(w).revoked, null);
});

test("after a relay restart the session renews once by force and reconnects; a refused fresh token stops it", async (t) => {
  const w = await world(t);
  await signInCli(w);
  const signIn = source(w);
  const c = new RelayClient({ url: w.relayUrl, signIn, name: "alice-r", mode: "peer", reconnect: true });
  t.after(() => c.close());
  await c.start().ready(10_000);
  w.px.state.posts = 0;
  const down = new Promise((r) => c.once("down", r));
  await w.close();
  await down;
  const ready = new Promise((r) => c.once("ready", r));
  const w2 = await world(t, { p: w.p, port: w.port, px: w.px, stateDir: w.stateDir, home: w.home });
  await Promise.race([ready, sleep(20_000)]);
  assert.equal(c.connected, true, c.lastError);
  assert.equal(w.px.state.posts, 1, "one forced renewal (the cached token was not tried again after token_expired)");
  // A relay that refuses every access token: the second token_expired after a fresh token is terminal.
  const fatal = new Promise((r) => c.once("fatal", r));
  w2.broker.verifyAccess = () => {
    throw Object.assign(new Error("expired"), { code: "token_expired" });
  };
  c.ws.terminate();
  assert.match(await fatal, /freshly renewed sign-in: run hoptell login/);
});

test("a connect timeout is a request that never left: retryable, the mark cleared", async (t) => {
  const w = await world(t);
  await signInCli(w);
  const real = globalThis.fetch;
  globalThis.fetch = async () => {
    throw Object.assign(new TypeError("fetch failed"), { cause: { code: "UND_ERR_CONNECT_TIMEOUT" } });
  };
  try {
    await assert.rejects(source(w)(), (e) => !e.terminal && /not reachable \(UND_ERR_CONNECT_TIMEOUT\)/.test(e.message));
  } finally {
    globalThis.fetch = real;
  }
  assert.equal((await source(w)()).kind, "broker", "the next attempt sends again");
});

test("a new login ends the broker sign-in it replaces", async (t) => {
  const w = await world(t);
  await signInCli(w);
  await signInCli(w);
  const fams = Object.values(familiesOf(w)).sort((a, b) => a.created - b.created);
  assert.equal(fams.length, 2);
  assert.equal(fams[0].revoked?.why, "signed out");
  assert.equal(fams[1].revoked, null);
});
