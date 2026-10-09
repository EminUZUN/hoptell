// hoptell login and the token source (lib/login.js) against the test provider and a relay.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { RelayClient } from "../lib/client.js";
import { commitWelcome, profileKey } from "../lib/profiles.js";
import { SignInError, login, logout, signInStatus, tokenSource } from "../lib/login.js";
import { createVerifier, discoveryDocument } from "../lib/oidc.js";
import { doctor } from "../lib/doctor.js";
import { startRelay } from "../lib/relay.js";
import { startProvider } from "./fixtures/oidc-provider.mjs";

const ALICE = "m_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const REALM = "d".repeat(32);
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
const memoryKeychain = () => {
  const m = new Map();
  return { kind: "test keychain", available: () => true, set: (a, v) => (m.set(a, v), true), get: (a) => m.get(a) ?? null, remove: (a) => m.delete(a), size: () => m.size, accounts: () => m.keys() };
};
/** The "browser": follows the provider's redirect to the loopback callback. */
const browser = async (url) => {
  const r = await fetch(url, { redirect: "manual" });
  await fetch(r.headers.get("location"));
};

async function setup(t, providerOptions = {}, { request = { resource: null, audience: null } } = {}) {
  const p = await startProvider({ clients: { "hoptell-cli": {}, "hoptell-relay": { secret: "rs" }, "build-bot": { secret: "bot-secret" } }, ...providerOptions });
  t.after(() => p.close());
  const cfg = {
    maxRevocationDelaySeconds: 300,
    maxTokenLifetimeSeconds: null,
    issuers: [
      {
        issuer: p.issuer,
        mode: "resource",
        audience: "hoptell-relay",
        validation: "jwt",
        profile: "rfc9068",
        clientClaim: "client_id",
        request,
        requiredClaims: {},
        requiredScopes: ["hoptell"],
        allowedClients: null,
        algorithms: ["ES256"],
        claims: { name: "preferred_username", groups: "groups" },
        introspection: null,
        cli: { clientId: "hoptell-cli", scopes: ["openid", "hoptell"], redirectPath: "/callback", grants: ["authorization_code", ...(providerOptions.device === false ? [] : ["device_code"])] },
      },
    ],
  };
  const verifier = await createVerifier(cfg, { jwksCooldownMs: 500 });
  const members = [
    { name: "alice", id: ALICE, oidc: [{ issuer: p.issuer, subject: "user-1" }] },
    { name: "bot", id: "m_bbbbbbbbbbbbbbbbbbbbbbbbbb", oidc: [{ issuer: p.issuer, subject: "service-build-bot" }] },
  ];
  const relay = await startRelay({ host: "127.0.0.1", port: 0, members, realm: { id: REALM }, oidc: { verifier, config: cfg, discovery: discoveryDocument(cfg, REALM) }, log: () => {} });
  t.after(() => relay.close());
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "hoptell-login-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const relayUrl = `ws://127.0.0.1:${relay.port}`;
  return { p, relayUrl, home, profile: profileKey(relayUrl), keychainBackend: memoryKeychain() };
}

test("browser sign-in uses the relay's client registration; the token source signs a session in as its member", async (t) => {
  const { relayUrl, home, profile, keychainBackend } = await setup(t);
  const said = [];
  const r = await login({ relayUrl, home, profile, open: browser, say: (x) => said.push(x), keychainBackend });
  assert.equal(r.kind, "user");
  assert.match(said[0], /Opening your browser/);
  const signIn = tokenSource({ relayUrl, home, profile, keychainBackend });
  const c = new RelayClient({ url: relayUrl, name: "alice-agent", signIn });
  t.after(() => c.close());
  await c.start().ready();
  assert.equal(c.member.id, ALICE);
  const out = await logout({ home, profile, keychainBackend });
  assert.deepEqual(out, { removed: true, revoked: true, kind: "user" });
  await assert.rejects(tokenSource({ relayUrl, home, profile, keychainBackend })(), SignInError);
});

test("refreshes from several processes are serialized and never reuse a rotated refresh token", async (t) => {
  const { p, relayUrl, home, profile } = await setup(t, { refreshDelayMs: 50 });
  const passphrase = "correct horse battery staple";
  await login({ relayUrl, home, profile, open: browser, say: () => {}, store: "file", passphrase });
  // Separate processes (two engines and a CLI, in effect) share only the encrypted file and its lock.
  const child = `import { tokenSource } from ${JSON.stringify(new URL("../lib/login.js", import.meta.url).href)};
    const s = tokenSource({ relayUrl: process.env.R, home: process.env.H, profile: process.env.P, passphrase: process.env.PW });
    const a = await s(); const b = await s();
    process.stdout.write(JSON.stringify([a.token, b.token === a.token]));`;
  const run = () =>
    new Promise((resolve, reject) => {
      const c = spawn(process.execPath, ["--input-type=module", "-e", child], { env: { ...process.env, R: relayUrl, H: home, P: profile, PW: passphrase }, stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      let err = "";
      c.stdout.on("data", (d) => (out += d));
      c.stderr.on("data", (d) => (err += d));
      c.on("exit", (code) => (code === 0 ? resolve(JSON.parse(out)) : reject(new Error(err))));
    });
  const results = await Promise.all([run(), run(), run()]);
  for (const [, cached] of results) assert.ok(cached, "a valid access token is reused from memory");
  assert.equal(new Set(results.map(([token]) => token)).size, 3, "each process refreshed for itself");
  assert.equal(p.refreshes.total, 3);
  assert.equal(p.refreshes.maxInFlight, 1, "never two refreshes at once");
  assert.equal(p.refreshes.reused, 0, "a rotated refresh token is never sent again");
});

test("logout racing a refresh never resurrects the credential; a new login replaces the old one", async (t) => {
  const { relayUrl, home, profile, keychainBackend } = await setup(t);
  await login({ relayUrl, home, profile, open: browser, say: () => {}, keychainBackend });
  const s = tokenSource({ relayUrl, home, profile, keychainBackend });
  const [, out] = await Promise.allSettled([s(), logout({ home, profile, keychainBackend })]);
  assert.equal(out.value.removed, true);
  await assert.rejects(tokenSource({ relayUrl, home, profile, keychainBackend })(), /run hoptell login/);
  assert.equal(keychainBackend.size(), 0, "nothing left behind");
  await login({ relayUrl, home, profile, open: browser, say: () => {}, keychainBackend });
  const first = await tokenSource({ relayUrl, home, profile, keychainBackend })();
  await login({ relayUrl, home, profile, open: browser, say: () => {}, keychainBackend });
  assert.equal(keychainBackend.size(), 1, "the new login replaced the old credential");
  const second = await tokenSource({ relayUrl, home, profile, keychainBackend })();
  assert.notEqual(second.token, first.token);
});

test("the realm pin is checked; device and service sign-in; clear stops for unsupported setups", async (t) => {
  const { p, relayUrl, home, profile, keychainBackend } = await setup(t);
  await commitWelcome(home, profile, { realm: "e".repeat(32), member: null });
  await assert.rejects(login({ relayUrl, home, profile, open: browser, say: () => {}, keychainBackend }), /pinned to/);
  const home2 = fs.mkdtempSync(path.join(os.tmpdir(), "hoptell-login2-"));
  t.after(() => fs.rmSync(home2, { recursive: true, force: true }));
  const done = login({ relayUrl, home: home2, profile, mode: "device", say: () => setTimeout(() => p.approveDevice(), 200), keychainBackend });
  assert.equal((await done).kind, "user");
  const s = await login({ relayUrl, home: home2, profile: "bot", mode: "service", service: { clientId: "build-bot", clientSecret: "bot-secret" }, keychainBackend });
  assert.equal(s.kind, "service");
  const c = new RelayClient({ url: relayUrl, name: "bot-ci", mode: "send", reconnect: false, signIn: tokenSource({ relayUrl, home: home2, profile: "bot", keychainBackend }) });
  t.after(() => c.close());
  await c.start().ready();
  assert.equal(c.member.name, "bot");
  const noDevice = await setup(t, { device: false });
  await assert.rejects(login({ ...noDevice, mode: "device", say: () => {} }), /does not offer sign-in with a code/);
  const noRefresh = await setup(t, { refresh: false });
  await assert.rejects(login({ ...noRefresh, open: browser, say: () => {} }), /no refresh token/);
});

test("a rotation the provider made but this home lost ends in a terminal sign-in error, reported once", async (t) => {
  const { p, relayUrl, home, profile, keychainBackend } = await setup(t);
  await login({ relayUrl, home, profile, open: browser, say: () => {}, keychainBackend });
  // A failed credential write: the provider rotated, the new refresh token was not stored.
  const set = keychainBackend.set;
  keychainBackend.set = () => {
    throw new Error("simulated keychain failure");
  };
  await assert.rejects(tokenSource({ relayUrl, home, profile, keychainBackend })(), (e) => !(e instanceof SignInError) && /simulated/.test(e.message));
  keychainBackend.set = set;
  await assert.rejects(tokenSource({ relayUrl, home, profile, keychainBackend })(), (e) => e instanceof SignInError && /run hoptell login/.test(e.message));
  assert.equal(p.refreshes.reused, 1, "the stale token was sent once, then reported, not retried");
  // A crash after the rotation (the stored record is the one from before): the same outcome.
  await login({ relayUrl, home, profile, open: browser, say: () => {}, keychainBackend });
  const [account] = [...keychainBackend.accounts()];
  const before = keychainBackend.get(account);
  await tokenSource({ relayUrl, home, profile, keychainBackend })();
  keychainBackend.set(account, before);
  await assert.rejects(tokenSource({ relayUrl, home, profile, keychainBackend })(), SignInError);
  assert.equal(p.refreshes.reused, 2);
});

test("doctor shows the sign-in (never the credential) and logs in with it", async (t) => {
  const { relayUrl, home, profile } = await setup(t);
  const passphrase = "doctor passphrase";
  const env = { HOPTELL_RELAY: relayUrl, HOPTELL_HOME: home, HOPTELL_AUTH: "login", HOPTELL_CREDENTIAL_PASSPHRASE: passphrase, HOPTELL_NAME: "alice" };
  let out = [];
  await doctor(env, (l) => out.push(l), { homedir: home });
  assert.match(out.join("\n"), /FAIL +sign-in: HOPTELL_AUTH=login, but this relay profile is not signed in/);
  await login({ relayUrl, home, profile, open: browser, say: () => {}, store: "file", passphrase });
  out = [];
  await doctor(env, (l) => out.push(l), { homedir: home });
  const text = out.join("\n");
  assert.match(text, /ok +sign-in: with http:\/\/127\.0\.0\.1:\d+ as client hoptell-cli; the credential is kept in the encrypted file/);
  assert.match(text, /ok +relay login: sign-in and protocol version accepted/);
  assert.doesNotMatch(text, /eyJ|passphrase/, "no token or passphrase in the output");
});

test("a slow refresh at the provider makes others wait for the credential, not fail", async (t) => {
  const { p, relayUrl, home, profile, keychainBackend } = await setup(t, { refreshDelayMs: 2500 });
  await login({ relayUrl, home, profile, open: browser, say: () => {}, keychainBackend });
  const [a, b] = await Promise.all([tokenSource({ relayUrl, home, profile, keychainBackend })(), tokenSource({ relayUrl, home, profile, keychainBackend })()]);
  assert.ok(a.token && b.token && a.token !== b.token);
  assert.equal(p.refreshes.maxInFlight, 1);
});

test("a sign-in works only for its own home and relay URL; nothing is sent elsewhere", async (t) => {
  const { p, relayUrl, home, profile, keychainBackend } = await setup(t);
  await login({ relayUrl, home, profile, open: browser, say: () => {}, keychainBackend });
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), "hoptell-copy-"));
  t.after(() => fs.rmSync(copy, { recursive: true, force: true }));
  fs.cpSync(home, copy, { recursive: true });
  const before = p.refreshes.total;
  await assert.rejects(tokenSource({ relayUrl, home: copy, profile, keychainBackend })(), (e) => e instanceof SignInError && /another setup/.test(e.message));
  await assert.rejects(tokenSource({ relayUrl: "ws://127.0.0.1:1", home, profile, keychainBackend })(), (e) => e instanceof SignInError && /another setup/.test(e.message));
  assert.equal(p.refreshes.total, before, "no refresh token was sent");
});

test("a rotation that cannot be stored durably is an error; its access token is not used", async (t) => {
  const { relayUrl, home, profile } = await setup(t);
  const passphrase = "durable passphrase";
  await login({ relayUrl, home, profile, open: browser, say: () => {}, store: "file", passphrase });
  const fault = (point) => {
    if (point === "dir-fsync") throw Object.assign(new Error("simulated EIO"), { code: "EIO" });
  };
  await assert.rejects(tokenSource({ relayUrl, home, profile, passphrase, fault })(), /simulated EIO/);
});

test("a login with another client while the old one refreshes leaves one credential; logout removes it", async (t) => {
  const { relayUrl, home, profile, keychainBackend } = await setup(t, { refreshDelayMs: 800 });
  await login({ relayUrl, home, profile, open: browser, say: () => {}, keychainBackend });
  const refreshing = tokenSource({ relayUrl, home, profile, keychainBackend })();
  await sleepMs(100);
  await login({ relayUrl, home, profile, mode: "service", service: { clientId: "build-bot", clientSecret: "bot-secret" }, keychainBackend });
  await refreshing.catch(() => {});
  assert.equal(keychainBackend.size(), 1, "the old credential is not resurrected by its refresh");
  assert.ok((await tokenSource({ relayUrl, home, profile, keychainBackend })()).token, "the new one works");
  await logout({ home, profile, keychainBackend });
  assert.equal(keychainBackend.size(), 0);
});

test("a keychain that cannot delete: logout fails and keeps the sign-in record", async (t) => {
  const { relayUrl, home, profile, keychainBackend } = await setup(t);
  await login({ relayUrl, home, profile, open: browser, say: () => {}, keychainBackend });
  keychainBackend.remove = () => false; // locked, or the delete failed
  await assert.rejects(logout({ home, profile, keychainBackend }), /could not be removed/);
  assert.ok(signInStatus(home, profile), "the index still points to the stored credential");
});

test("the configured resource and audience go with every token request, the code exchange included", async (t) => {
  const request = { resource: "https://hoptell.example/", audience: "hoptell-relay" };
  const { p, relayUrl, home, profile, keychainBackend } = await setup(t, {}, { request });
  await login({ relayUrl, home, profile, open: browser, say: () => {}, keychainBackend });
  await tokenSource({ relayUrl, home, profile, keychainBackend })();
  for (const grant of ["authorization_code", "refresh_token"]) {
    const r = p.tokenRequests.find((x) => x.grant === grant);
    assert.deepEqual([r?.resource, r?.audience], [request.resource, request.audience], grant);
  }
});

test("a token in memory stops being used after logout; a realm pin that changed is refused", async (t) => {
  const { relayUrl, home, profile, keychainBackend } = await setup(t);
  await login({ relayUrl, home, profile, open: browser, say: () => {}, keychainBackend });
  const s = tokenSource({ relayUrl, home, profile, keychainBackend });
  await s();
  await logout({ home, profile, keychainBackend });
  await assert.rejects(s(), SignInError, "the cached token is not handed out after logout");
  await login({ relayUrl, home, profile, open: browser, say: () => {}, keychainBackend });
  await commitWelcome(home, profile, { realm: "f".repeat(32), member: null }).catch(() => {});
  await assert.rejects(tokenSource({ relayUrl, home, profile, keychainBackend })(), /pinned to/);
});

test("context checks come before a token in memory; an index copied to another profile is refused", async (t) => {
  const { relayUrl, home, profile, keychainBackend } = await setup(t);
  await login({ relayUrl, home, profile, open: browser, say: () => {}, keychainBackend });
  const s = tokenSource({ relayUrl, home, profile, keychainBackend });
  await s();
  await commitWelcome(home, profile, { realm: "f".repeat(32), member: null });
  await assert.rejects(s(), /pinned to/, "the cached token is not returned once the realm pin differs");
  fs.copyFileSync(path.join(home, "credentials", `${profile}.login.json`), path.join(home, "credentials", "other.login.json"));
  await assert.rejects(tokenSource({ relayUrl, home, profile: "other", keychainBackend })(), /another setup/);
});

test("a replacement interrupted at any step is finished or rolled back; logout leaves nothing behind", async (t) => {
  const service = (extra = {}) => ({ mode: "service", service: { clientId: "build-bot", clientSecret: "bot-secret" }, ...extra });
  // 1. The old credential cannot be removed: the new sign-in is in place, the removal is recorded,
  //    and a logout straight away removes both.
  {
    const { relayUrl, home, profile, keychainBackend } = await setup(t);
    await login({ relayUrl, home, profile, open: browser, say: () => {}, keychainBackend });
    const remove = keychainBackend.remove;
    keychainBackend.remove = () => false;
    await assert.rejects(login({ relayUrl, home, profile, keychainBackend, ...service() }), /could not be removed/);
    assert.equal(signInStatus(home, profile).clientId, "build-bot");
    keychainBackend.remove = remove;
    await logout({ home, profile, keychainBackend });
    assert.equal(keychainBackend.size(), 0, "no secret left behind");
  }
  // 2. No removal works at all: logout fails and keeps the recovery state; once the keychain works,
  //    logout removes every credential it tracks.
  {
    const { relayUrl, home, profile, keychainBackend } = await setup(t);
    await login({ relayUrl, home, profile, open: browser, say: () => {}, keychainBackend });
    const remove = keychainBackend.remove;
    keychainBackend.remove = () => false;
    await assert.rejects(login({ relayUrl, home, profile, keychainBackend, ...service() }), /could not be removed/);
    await assert.rejects(logout({ home, profile, keychainBackend }), /could not be removed/);
    keychainBackend.remove = remove;
    await logout({ home, profile, keychainBackend });
    assert.equal(keychainBackend.size(), 0);
  }
  // 3. Publishing the new index fails (as if the process ended there): the next token source rolls
  //    the replacement back and keeps working with the old sign-in.
  {
    const { relayUrl, home, profile, keychainBackend } = await setup(t);
    await login({ relayUrl, home, profile, open: browser, say: () => {}, keychainBackend });
    const fault = (point, file) => {
      if (point === "rename" && file.endsWith(".login.json")) throw Object.assign(new Error("simulated EIO"), { code: "EIO" });
    };
    await assert.rejects(login({ relayUrl, home, profile, keychainBackend, ...service({ fault }) }), /simulated EIO/);
    assert.equal(keychainBackend.size(), 2, "both stored for a moment");
    assert.ok((await tokenSource({ relayUrl, home, profile, keychainBackend })()).token, "the old sign-in still works");
    assert.equal(keychainBackend.size(), 1, "the half-made new one was removed");
    assert.equal(signInStatus(home, profile).clientId, "hoptell-cli");
  }
});

test("logins that replace each other at the same time finish (locks in one order)", async (t) => {
  const { relayUrl, home, profile, keychainBackend } = await setup(t);
  await login({ relayUrl, home, profile, open: browser, say: () => {}, keychainBackend });
  const service = () => login({ relayUrl, home, profile, mode: "service", service: { clientId: "build-bot", clientSecret: "bot-secret" }, keychainBackend });
  const user = () => login({ relayUrl, home, profile, open: browser, say: () => {}, keychainBackend });
  const all = Promise.allSettled([service(), user(), service(), user()]);
  const outcome = await Promise.race([all, sleepMs(25_000).then(() => "deadlock")]);
  assert.notEqual(outcome, "deadlock");
  assert.equal(keychainBackend.size(), 1);
});

test("the relay's sign-in settings are read with a bound: a huge answer stops early", async (t) => {
  const http = await import("node:http");
  let sent = 0;
  const big = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    const chunk = Buffer.alloc(64 * 1024, 32);
    const pump = () => {
      while (sent < 1024 * 1024 && res.write(chunk)) sent += chunk.length;
      if (sent < 1024 * 1024) res.once("drain", pump);
      else res.end();
    };
    pump();
  });
  await new Promise((r) => big.listen(0, "127.0.0.1", r));
  t.after(() => big.close());
  const { relayDiscovery } = await import("../lib/login.js");
  await assert.rejects(relayDiscovery(`ws://127.0.0.1:${big.address().port}`), /too large/);
});

test("a process that ends in the middle of a replacement: a new process recovers", async (t) => {
  for (const point of ["credential", "index"]) {
    const { relayUrl, home, profile } = await setup(t);
    const passphrase = "transition passphrase";
    await login({ relayUrl, home, profile, open: browser, say: () => {}, store: "file", passphrase });
    // The child replaces the sign-in with a service account and exits right before writing `point`.
    const child = `import { login } from ${JSON.stringify(new URL("../lib/login.js", import.meta.url).href)};
      const fault = (p, file) => { if (p === "rename" && (${JSON.stringify(point)} === "index" ? file.endsWith(".login.json") : /c_[0-9a-f]+\\.json$/.test(file))) process.exit(9); };
      await login({ relayUrl: process.env.R, home: process.env.H, profile: process.env.P, mode: "service", service: { clientId: "build-bot", clientSecret: "bot-secret" }, store: "file", passphrase: process.env.PW, fault });`;
    const code = await new Promise((resolve) => spawn(process.execPath, ["--input-type=module", "-e", child], { env: { ...process.env, R: relayUrl, H: home, P: profile, PW: passphrase }, stdio: "ignore" }).on("exit", resolve));
    assert.equal(code, 9, point);
    // This process (a new one for the stored state) uses the sign-in, then logs out: nothing remains.
    assert.ok((await tokenSource({ relayUrl, home, profile, passphrase })()).token, `${point}: usable after recovery`);
    await logout({ home, profile, passphrase });
    const left = fs.readdirSync(path.join(home, "credentials")).filter((f) => /^c_.*\.json$|transition/.test(f));
    assert.deepEqual(left, [], `${point}: no credential or transition left`);
  }
});

test("a first sign-in is journaled too; concurrent logins of one profile never lose cleanup state", async (t) => {
  const service = (id, extra = {}) => ({ mode: "service", service: { clientId: id, clientSecret: id === "build-bot" ? "bot-secret" : "ci-secret" }, ...extra });
  // A first sign-in whose index cannot be published: nothing usable, and logout leaves no secret.
  {
    const { relayUrl, home, profile, keychainBackend } = await setup(t);
    const fault = (point, file) => {
      if (point === "rename" && file.endsWith(".login.json")) throw Object.assign(new Error("simulated EIO"), { code: "EIO" });
    };
    await assert.rejects(login({ relayUrl, home, profile, open: browser, say: () => {}, keychainBackend, fault }), /simulated EIO/);
    assert.equal(keychainBackend.size(), 1, "the new secret was stored before the failure");
    await logout({ home, profile, keychainBackend });
    assert.equal(keychainBackend.size(), 0, "recovery removed it");
  }
  // Concurrent first logins of one empty profile: serialized, one credential.
  {
    const { relayUrl, home, profile, keychainBackend } = await setup(t, { clients: { "hoptell-cli": {}, "hoptell-relay": { secret: "rs" }, "build-bot": { secret: "bot-secret" }, "ci-bot": { secret: "ci-secret" } } });
    await Promise.all([login({ relayUrl, home, profile, keychainBackend, ...service("build-bot") }), login({ relayUrl, home, profile, keychainBackend, ...service("ci-bot") })]);
    assert.equal(keychainBackend.size(), 1);
  }
  // Login B fails to remove A (transition A -> B kept) while login C waits behind it: C first finishes
  // A -> B, then replaces B; logout leaves nothing.
  {
    const { relayUrl, home, profile, keychainBackend } = await setup(t, { clients: { "hoptell-cli": {}, "hoptell-relay": { secret: "rs" }, "build-bot": { secret: "bot-secret" }, "ci-bot": { secret: "ci-secret" } } });
    await login({ relayUrl, home, profile, open: browser, say: () => {}, keychainBackend });
    const userAccount = [...keychainBackend.accounts()][0];
    const remove = keychainBackend.remove;
    let failOnce = true;
    keychainBackend.remove = (a) => (a === userAccount && failOnce ? ((failOnce = false), false) : remove(a));
    const b = login({ relayUrl, home, profile, keychainBackend, ...service("build-bot") });
    const c = login({ relayUrl, home, profile, keychainBackend, ...service("ci-bot") });
    const [rb, rc] = await Promise.allSettled([b, c]);
    assert.equal(rb.status, "rejected");
    assert.equal(rc.status, "fulfilled");
    assert.equal(signInStatus(home, profile).clientId, "ci-bot");
    assert.equal(keychainBackend.size(), 1, "A and B are gone, only C remains");
    await logout({ home, profile, keychainBackend });
    assert.equal(keychainBackend.size(), 0);
  }
});

test("a first login that ends before its index: a new process cleans up", async (t) => {
  const { relayUrl, home, profile } = await setup(t);
  const passphrase = "first login passphrase";
  const child = `import { login } from ${JSON.stringify(new URL("../lib/login.js", import.meta.url).href)};
    const fault = (p, file) => { if (p === "rename" && file.endsWith(".login.json")) process.exit(9); };
    await login({ relayUrl: process.env.R, home: process.env.H, profile: process.env.P, mode: "service", service: { clientId: "build-bot", clientSecret: "bot-secret" }, store: "file", passphrase: process.env.PW, fault });`;
  const code = await new Promise((resolve) => spawn(process.execPath, ["--input-type=module", "-e", child], { env: { ...process.env, R: relayUrl, H: home, P: profile, PW: passphrase }, stdio: "ignore" }).on("exit", resolve));
  assert.equal(code, 9);
  const out = await logout({ home, profile, passphrase });
  assert.equal(out.removed, false, "never signed in");
  assert.deepEqual(fs.readdirSync(path.join(home, "credentials")).filter((f) => /^c_.*\.json$|transition/.test(f)), [], "no secret or transition left");
});

test("the same sign-in in another store is refused until logout; a stray file never replaces the keychain", async (t) => {
  const { relayUrl, home, profile, keychainBackend } = await setup(t);
  await login({ relayUrl, home, profile, open: browser, say: () => {}, keychainBackend });
  await assert.rejects(login({ relayUrl, home, profile, open: browser, say: () => {}, keychainBackend, store: "file", passphrase: "another passphrase" }), /run hoptell logout first/);
  assert.equal(keychainBackend.size(), 1);
  assert.deepEqual(fs.readdirSync(path.join(home, "credentials")).filter((f) => /^c_.*\.json$/.test(f)), [], "nothing written to a file");
  // A file appearing for the same account does not take over a keychain sign-in.
  const [account] = [...keychainBackend.accounts()];
  fs.writeFileSync(path.join(home, "credentials", `${account}.json`), "{}", { mode: 0o600 });
  assert.ok((await tokenSource({ relayUrl, home, profile, keychainBackend })()).token, "still the keychain credential");
  fs.rmSync(path.join(home, "credentials", `${account}.json`));
  await logout({ home, profile, keychainBackend });
  assert.equal(keychainBackend.size(), 0, "logout leaves no usable credential");
  // After logout, the file store can be chosen.
  await login({ relayUrl, home, profile, open: browser, say: () => {}, keychainBackend, store: "file", passphrase: "another passphrase" });
  assert.equal(signInStatus(home, profile).store, "encrypted file");
});
