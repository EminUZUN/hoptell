// Sign-in against a real Keycloak (opt-in: npm run test:oidc; needs Docker). A throwaway container
// from a pinned image imports test/keycloak/realm.json: the public CLI client, the relay's
// introspection client, a service account and a user; an audience mapper puts the relay in `aud`.
// The login form is driven over HTTP. Nothing outside the container and temporary folders is used.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RelayClient } from "../../lib/client.js";
import { login, logout, tokenSource } from "../../lib/login.js";
import { createBroker } from "../../lib/broker.js";
import { createVerifier, discoveryDocument, loadOidcConfig } from "../../lib/oidc.js";
import { profileKey } from "../../lib/profiles.js";
import { startRelay } from "../../lib/relay.js";

const IMAGE = "quay.io/keycloak/keycloak:26.7.4";
const REALM_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "realm.json");
const HOPTELL_REALM = "e".repeat(32);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const docker = (...args) => spawnSync("docker", args, { encoding: "utf8" });

let kc = null; // {name, base, issuer}
test.before(async () => {
  if (docker("info").status !== 0) throw new Error("Docker is not available; npm run test:oidc needs it");
  const name = `hoptell-kc-test-${crypto.randomBytes(4).toString("hex")}`;
  // The realm is copied into the container (no bind mount: works wherever Docker runs, also
  // with a VM that shares only some folders).
  const create = docker("create", "--rm", "--name", name, "-p", "127.0.0.1::8080", "-e", "KC_BOOTSTRAP_ADMIN_USERNAME=admin", "-e", "KC_BOOTSTRAP_ADMIN_PASSWORD=admin", IMAGE, "start-dev", "--import-realm");
  if (create.status !== 0) throw new Error(create.stderr);
  process.on("exit", () => docker("rm", "-f", name)); // removed by its exact name, also when a test fails hard
  kc = { name };
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "hoptell-kc-realm-"));
  fs.mkdirSync(path.join(staging, "import"));
  fs.copyFileSync(REALM_FILE, path.join(staging, "import", "realm.json"));
  const cp = docker("cp", path.join(staging, "import"), `${name}:/opt/keycloak/data/`);
  fs.rmSync(staging, { recursive: true, force: true });
  if (cp.status !== 0) throw new Error(cp.stderr);
  const run = docker("start", name);
  if (run.status !== 0) throw new Error(run.stderr);
  const port = docker("port", name, "8080").stdout.trim().split(":").pop();
  const base = `http://127.0.0.1:${port}`;
  kc = { name, base, issuer: `${base}/realms/hoptell-test` };
  for (const end = Date.now() + 180_000; ; await sleep(1000)) {
    if (Date.now() > end) throw new Error("Keycloak did not start in time");
    try {
      if ((await fetch(`${kc.issuer}/.well-known/openid-configuration`)).ok) break;
    } catch {}
  }
});
test.after(() => kc && docker("rm", "-f", kc.name));

/** Ids of the user and of the service account, from the admin API. */
async function subjects() {
  const admin = await (await fetch(`${kc.base}/realms/master/protocol/openid-connect/token`, { method: "POST", body: new URLSearchParams({ grant_type: "password", client_id: "admin-cli", username: "admin", password: "admin" }) })).json();
  const get = async (p) => (await fetch(`${kc.base}/admin/realms/hoptell-test${p}`, { headers: { authorization: `Bearer ${admin.access_token}` } })).json();
  const [alice] = await get("/users?username=alice&exact=true");
  const [bot] = await get("/clients?clientId=build-bot");
  const sa = await get(`/clients/${bot.id}/service-account-user`);
  return { alice: alice.id, bot: sa.id };
}

/** A browser: follows redirects with cookies, fills the login form, accepts a consent page. */
function browserFor(username, password) {
  return async function open(url) {
    const jar = new Map();
    const cookies = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
    const keep = (r) => {
      for (const c of r.headers.getSetCookie?.() ?? []) {
        const [kv] = c.split(";");
        const i = kv.indexOf("=");
        jar.set(kv.slice(0, i), kv.slice(i + 1));
      }
    };
    let next = { url, method: "GET", body: null };
    for (let hops = 0; hops < 20; hops++) {
      const r = await fetch(next.url, { method: next.method, body: next.body, redirect: "manual", headers: { cookie: cookies(), ...(next.body ? { "content-type": "application/x-www-form-urlencoded" } : {}) } });
      keep(r);
      if (r.status >= 300 && r.status < 400) {
        const to = new URL(r.headers.get("location"), next.url).href;
        if (!to.startsWith(kc.base)) return void (await fetch(to)); // the loopback callback
        next = { url: to, method: "GET", body: null };
        continue;
      }
      const html = await r.text();
      // The login form, or a consent form (with its hidden fields); anything else is a final page.
      const forms = [...html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/g)];
      const form = forms.find((f) => /id="kc-form-login"/.test(f[1])) ?? forms.find((f) => /name="accept"/.test(f[2]));
      if (!form) return;
      const action = new URL(form[1].match(/action="([^"]+)"/)[1].replaceAll("&amp;", "&"), next.url).href;
      const hidden = Object.fromEntries([...form[2].matchAll(/<input[^>]*type="hidden"[^>]*>/g)].map(([i]) => [i.match(/name="([^"]*)"/)?.[1], (i.match(/value="([^"]*)"/)?.[1] ?? "").replaceAll("&amp;", "&")]).filter(([k]) => k));
      const fields = /kc-form-login/.test(form[1]) ? { ...hidden, username, password, credentialId: "" } : { ...hidden, accept: "Yes" };
      next = { url: action, method: "POST", body: new URLSearchParams(fields).toString() };
    }
    throw new Error("too many redirects");
  };
}

async function relayWith(t, validation, members) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hoptell-kc-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const secretFile = path.join(dir, "introspect.secret");
  fs.writeFileSync(secretFile, "relay-introspection-secret\n", { mode: 0o600 });
  const file = path.join(dir, "oidc.json");
  const issuer = {
    issuer: kc.issuer,
    mode: "resource",
    audience: "hoptell-relay",
    validation,
    profile: "claims",
    clientClaim: "azp",
    requiredClaims: { typ: "Bearer" }, // Keycloak's access-token marker (its ID tokens say "ID")
    requiredScopes: ["hoptell"],
    allowedClients: ["hoptell-cli", "build-bot"],
    algorithms: ["RS256"],
    ...(validation === "introspection" ? { introspection: { clientId: "hoptell-relay", clientSecretFile: secretFile, requiredFields: ["sub", "aud", "exp"] } } : {}),
    cli: { clientId: "hoptell-cli", scopes: ["openid", "hoptell"], redirectPath: "/callback", grants: ["authorization_code", "device_code"] },
  };
  fs.writeFileSync(file, JSON.stringify({ version: 1, maxRevocationDelaySeconds: 20, maxTokenLifetimeSeconds: 3600, issuers: [issuer] }), { mode: 0o600 });
  const cfg = loadOidcConfig(file);
  const log = process.env.HOPTELL_TEST_LOG ? (...a) => console.error("relay:", ...a) : () => {};
  const verifier = await createVerifier(cfg, { log });
  const relay = await startRelay({ host: "127.0.0.1", port: 0, members, realm: { id: HOPTELL_REALM }, oidc: { verifier, config: cfg, discovery: discoveryDocument(cfg, HOPTELL_REALM) }, log });
  t.after(() => relay.close());
  return `ws://127.0.0.1:${relay.port}`;
}

const tmpHome = (t) => {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), "hoptell-kch-"));
  t.after(() => fs.rmSync(h, { recursive: true, force: true }));
  return h;
};
const fileStore = { store: "file", passphrase: "keycloak test passphrase" };

test("Keycloak, JWT validation: browser, device and service sign-in; renewal keeps the connection", { timeout: 400_000 }, async (t) => {
  const sub = await subjects();
  const url = await relayWith(t, "jwt", [
    { name: "alice", id: "m_aaaaaaaaaaaaaaaaaaaaaaaaaa", oidc: [{ issuer: kc.issuer, subject: sub.alice }] },
    { name: "bot", id: "m_bbbbbbbbbbbbbbbbbbbbbbbbbb", oidc: [{ issuer: kc.issuer, subject: sub.bot }] },
  ]);
  const profile = profileKey(url);
  // Browser sign-in (authorization code with PKCE on a loopback redirect).
  const home = tmpHome(t);
  await login({ relayUrl: url, home, profile, open: browserFor("alice", "alice-password"), say: () => {}, ...fileStore });
  const alice = new RelayClient({ url, name: "alice-kc", signIn: tokenSource({ relayUrl: url, home, profile, passphrase: fileStore.passphrase }) });
  t.after(() => alice.close());
  await alice.start().ready(10_000);
  assert.equal(alice.member.name, "alice");
  // Device sign-in on another home.
  const home2 = tmpHome(t);
  const drive = browserFor("alice", "alice-password");
  await login({ relayUrl: url, home: home2, profile, mode: "device", say: (line) => drive(line.match(/open (\S+) and/)[1]), ...fileStore });
  const alice2 = new RelayClient({ url, name: "alice-kc2", mode: "send", reconnect: false, signIn: tokenSource({ relayUrl: url, home: home2, profile, passphrase: fileStore.passphrase }) });
  t.after(() => alice2.close());
  await alice2.start().ready(10_000);
  assert.equal(alice2.member.name, "alice");
  // A service account (client credentials).
  const bot = new RelayClient({ url, name: "bot-kc", mode: "send", signIn: await serviceSource(t, url, profile) });
  t.after(() => bot.close());
  await bot.start().ready(10_000);
  assert.equal(bot.member.name, "bot");
  // Keycloak's access tokens here live 60 s; the relay's deadline is exp + 60 s. Past it, the same
  // connection still delivers: the client renewed it with reauth.
  const firstDeadline = alice.authDeadline;
  let downs = 0;
  alice.on("down", () => downs++);
  await sleep(firstDeadline - Date.now() + 5000);
  assert.ok(alice.authDeadline > firstDeadline, "renewed before the deadline");
  assert.equal(downs, 0, "the connection was never lost");
  const got = new Promise((r) => alice.on("message", (m, confirm) => (confirm?.(), r(m))));
  await bot.send("alice-kc", "after renewal");
  assert.equal((await got).text, "after renewal");
});

async function serviceSource(t, url, profile) {
  const home = tmpHome(t);
  await login({ relayUrl: url, home, profile, mode: "service", service: { clientId: "build-bot", clientSecret: "build-bot-secret" }, ...fileStore });
  return tokenSource({ relayUrl: url, home, profile, passphrase: fileStore.passphrase });
}

test("Keycloak, introspection: a sign-in revoked at logout is closed within the revocation delay", { timeout: 200_000 }, async (t) => {
  const sub = await subjects();
  const url = await relayWith(t, "introspection", [{ name: "alice", id: "m_aaaaaaaaaaaaaaaaaaaaaaaaaa", oidc: [{ issuer: kc.issuer, subject: sub.alice }] }]);
  const profile = profileKey(url);
  const home = tmpHome(t);
  await login({ relayUrl: url, home, profile, open: browserFor("alice", "alice-password"), say: () => {}, ...fileStore });
  const alice = new RelayClient({ url, name: "alice-ki", reconnect: false, signIn: tokenSource({ relayUrl: url, home, profile, passphrase: fileStore.passphrase }) });
  t.after(() => alice.close());
  await alice.start().ready(10_000);
  assert.equal(alice.member.name, "alice");
  const closed = new Promise((r) => alice.on("fatal", r).on("down", r));
  const out = await logout({ home, profile, passphrase: fileStore.passphrase });
  assert.deepEqual(out, { removed: true, revoked: true, kind: "user" });
  const started = Date.now();
  await closed;
  assert.ok(Date.now() - started < 30_000, "closed within the revocation delay (20 s) plus the recheck timeout");
});

test("Keycloak, broker mode: a client without the relay audience mapper; sign-in through the relay", { timeout: 200_000 }, async (t) => {
  const { alice } = await subjects();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hoptell-kcb-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const secretFile = path.join(dir, "broker.secret");
  fs.writeFileSync(secretFile, "broker-client-secret\n", { mode: 0o600 });
  // The relay's public origin must be known before it listens: a free port first.
  const port = await new Promise((r) => {
    const s = (net.createServer()).listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => r(p));
    });
  });
  const file = path.join(dir, "oidc.json");
  fs.writeFileSync(file, JSON.stringify({ version: 1, issuers: [{ issuer: kc.issuer, mode: "broker", id: "kc", publicBaseUrl: `http://127.0.0.1:${port}`, client: { clientId: "hoptell-broker", clientSecretFile: secretFile }, scopes: ["openid"] }] }), { mode: 0o600 });
  const cfg = loadOidcConfig(file);
  const log = process.env.HOPTELL_TEST_LOG ? (...a) => console.error("relay:", ...a) : () => {};
  const broker = await createBroker({ issuers: cfg.issuers, stateDir: path.join(dir, "state"), log });
  t.after(() => broker.close());
  const members = [{ name: "alice", id: "m_aaaaaaaaaaaaaaaaaaaaaaaaaa", oidc: [{ issuer: kc.issuer, subject: alice }] }];
  const relay = await startRelay({ host: "127.0.0.1", port, members, realm: { id: HOPTELL_REALM }, oidc: { verifier: null, config: cfg, discovery: discoveryDocument(cfg, HOPTELL_REALM), broker }, log });
  t.after(() => relay.close());
  const url = `ws://127.0.0.1:${port}`;
  const home = tmpHome(t);
  const profile = profileKey(url);
  const r = await login({ relayUrl: url, home, profile, ...fileStore, open: browserFor("alice", "alice-password"), say: () => {} });
  assert.equal(r.kind, "broker");
  const signIn = tokenSource({ home, profile, relayUrl: url, passphrase: fileStore.passphrase });
  const c = new RelayClient({ url, signIn, name: "alice-kcb", mode: "send", reconnect: false });
  t.after(() => c.close());
  await c.start().ready(30_000);
  assert.equal(c.member.name, "alice");
  // A renewal rotates the relay's refresh token; logout ends the sign-in at the relay.
  assert.equal((await signIn({ force: true })).kind, "broker");
  const out = await logout({ home, profile, passphrase: fileStore.passphrase });
  assert.equal(out.revoked, true);
  assert.equal(broker.status().families, 0);
});
