// The engine (lib/engine.js) driven directly, without MCP: settings, isolation, results, the
// lifecycle and notices; and a guard that nothing behind the engine reads ambient settings.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createEngine } from "../lib/engine.js";
import { readSettings } from "../lib/settings.js";
import { RelayClient } from "../lib/client.js";
import { startRelay } from "../lib/relay.js";
import { TOKEN, existingInstall, fakeToken, sleep, world } from "./helpers.js";

const tmp = (t, label) => {
  const dir = existingInstall(fs.mkdtempSync(path.join(os.tmpdir(), `hoptell-${label}-`)));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return dir;
};
const settingsFor = (env, homedir = "/nonexistent-home") => readSettings({ env, homedir, pid: process.pid, hostname: "testhost" });
const engineFor = (t, env, deps = {}) => {
  const e = createEngine(settingsFor({ HOPTELL_PUSH: "listener", ...env }), { findHost: () => null, ...deps });
  t.after(() => e.stop());
  return e;
};
const textOf = (r) => r.content[0].text;
async function until(fn, ms = 5000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) if (await fn()) return true;
  return false;
}

test("readSettings: every field, per-field problems, a deeply frozen copy, no environment change", () => {
  const before = JSON.stringify(process.env);
  const s = settingsFor({
    HOPTELL_RELAY: "ws://127.0.0.1:1",
    HOPTELL_TOKEN: "t".repeat(20),
    HOPTELL_NAME: "alice-x",
    HOPTELL_ROLES: "rev, back",
    HOPTELL_PUSH: "hook",
    HOPTELL_PROTOCOL: "1",
    HOPTELL_PROFILE: "work",
    HOPTELL_HOME: "/h",
    HOPTELL_SNAPSHOT_ROOTS: "[]",
  });
  assert.deepEqual(
    { ...s, relay: { ...s.relay }, roles: [...s.roles], barriers: { ...s.barriers }, errors: { ...s.errors } },
    {
      home: "/h",
      name: "alice-x",
      title: null,
      titleAuto: "member",
      titleFolder: null,
      roles: ["rev", "back"],
      push: "hook",
      contactsSelf: "allow",
      relay: { url: "ws://127.0.0.1:1", token: "t".repeat(20), auth: "token", protocol: 1, profile: "work", credentialStore: "auto", passphrase: null },
      snapshotRoots: "[]",
      relaysFile: "/nonexistent-home/.config/hoptell/relays.json",
      relaysExplicit: false,
      protocol: 1,
      signIn: { credentialStore: "auto", passphrase: null },
      receipts: "on",
      leaseMinutes: 30,
      elicitation: "off",
      ownerChannel: true,
      agentsMax: 4,
      notify: true,
      pid: process.pid,
      hostname: "testhost",
      barriers: { wake: null, reader: null },
      errors: {},
      warnings: [],
    },
  );
  assert.ok(Object.isFrozen(s) && Object.isFrozen(s.relay) && Object.isFrozen(s.roles) && Object.isFrozen(s.errors));
  assert.equal(settingsFor({}).home, path.join("/nonexistent-home", ".hoptell"));
  assert.equal(readSettings({ env: { HOPTELL_HOME: "rel/state" }, homedir: "/u", cwd: "/work", pid: 1 }).home, "/work/rel/state", "relative to the captured directory");
  // Problems are collected per field.
  assert.match(settingsFor({ HOPTELL_NAME: "bad name" }).errors.name, /HOPTELL_NAME/);
  assert.match(settingsFor({ HOPTELL_PUSH: "loud" }).errors.push, /HOPTELL_PUSH must be/);
  assert.match(settingsFor({ HOPTELL_RECEIPTS: "maybe" }).errors.receipts, /HOPTELL_RECEIPTS/);
  assert.match(settingsFor({ HOPTELL_LEASE_MINUTES: "0" }).errors.receipts, /HOPTELL_LEASE_MINUTES/);
  // HOPTELL_AGENTS_MAX (design 7.1): live spawned runs per home, at most 16 (a larger value is
  // lowered, with a warning); a value that is not a whole number of at least 1 refuses spawning.
  assert.equal(settingsFor({ HOPTELL_AGENTS_MAX: "40" }).agentsMax, 16);
  assert.deepEqual(settingsFor({ HOPTELL_AGENTS_MAX: "40" }).warnings, ["HOPTELL_AGENTS_MAX is at most 16, not 40; using 16"]);
  assert.equal(settingsFor({ HOPTELL_AGENTS_MAX: "2" }).agentsMax, 2);
  for (const v of ["zero", "0", "-1", "2.5"]) {
    const bad = settingsFor({ HOPTELL_AGENTS_MAX: v });
    assert.equal(bad.agentsMax, null, v);
    assert.match(bad.errors.agentsMax, /HOPTELL_AGENTS_MAX must be a whole number from 1 to 16/);
  }
  assert.equal(settingsFor({ HOPTELL_RECEIPTS: "OFF", HOPTELL_LEASE_MINUTES: "5" }).leaseMinutes, 5);
  const badRole = settingsFor({ HOPTELL_RELAY: "ws://x:1", HOPTELL_TOKEN: "t".repeat(20), HOPTELL_ROLES: "bad role" });
  assert.match(badRole.errors.relay, /role/);
  assert.equal(badRole.relay, null, "a bad role keeps the relay tools off, as before");
  assert.match(settingsFor({ HOPTELL_RELAY: "ws://x:1", HOPTELL_TOKEN: "t".repeat(20), HOPTELL_PROTOCOL: "3" }).errors.relay, /HOPTELL_PROTOCOL/);
  assert.match(settingsFor({ HOPTELL_TOKEN: "t".repeat(20) }).errors.relay, /HOPTELL_RELAY is not set/);
  assert.match(settingsFor({ HOPTELL_RELAY: "ws://x:1", HOPTELL_TOKEN: "t".repeat(20), HOPTELL_PROFILE: "../x" }).errors.relay, /HOPTELL_PROFILE/);
  assert.equal(JSON.stringify(process.env), before, "nothing was written to the environment");
});

test("two engines in one process keep their own settings and storage, whatever the environment does later", async (t) => {
  const w = await world();
  t.after(() => w.close());
  const [ha, hb] = [tmp(t, "ea"), tmp(t, "eb")];
  const base = { HOPTELL_RELAY: w.env.HOPTELL_RELAY, HOPTELL_TOKEN: TOKEN };
  const a = engineFor(t, { ...base, HOPTELL_HOME: ha, HOPTELL_NAME: "eng-a", HOPTELL_PROFILE: "pa" });
  const b = engineFor(t, { ...base, HOPTELL_HOME: hb, HOPTELL_NAME: "eng-b", HOPTELL_PROFILE: "pb" });
  // The ambient environment changes after construction; neither engine notices.
  const saved = { ...process.env };
  t.after(() => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  });
  Object.assign(process.env, { HOPTELL_HOME: "/nonexistent", HOPTELL_PROFILE: "ambient", HOPTELL_NAME: "ambient", HOPTELL_RELAY: "ws://127.0.0.1:1" });
  await Promise.all([a.start(), b.start()]);
  assert.ok(await until(() => a.session.state === "bound" && b.session.state === "bound"));
  assert.match(textOf(await a.call("send_message", { to: "eng-b", message: "isolated" })), /Delivered to eng-b/);
  let got = "";
  assert.ok(await until(async () => /isolated/.test((got += textOf(await b.call("read_inbox"))))));
  assert.ok(fs.existsSync(path.join(ha, "profiles", "pa.json")) && fs.existsSync(path.join(hb, "profiles", "pb.json")));
  assert.ok(!fs.existsSync(path.join(ha, "profiles", "pb.json")) && !fs.existsSync("/nonexistent"));
  assert.ok(b.session.store.dir.startsWith(fs.realpathSync(hb)) || b.session.store.dir.startsWith(hb));
});

test("tool results pass through unchanged, including structured file-tool results; the catalog is complete", async (t) => {
  const w = await world();
  t.after(() => w.close());
  const home = tmp(t, "eres");
  const app = path.join(home, "app");
  fs.mkdirSync(app);
  fs.writeFileSync(path.join(app, "x.js"), "const x = 1;\n");
  const base = { HOPTELL_RELAY: w.env.HOPTELL_RELAY, HOPTELL_TOKEN: TOKEN, HOPTELL_HOME: home };
  const sam = engineFor(t, { ...base, HOPTELL_NAME: "sam", HOPTELL_SNAPSHOT_ROOTS: JSON.stringify([{ id: "app", path: app }]) });
  const rev = engineFor(t, { ...base, HOPTELL_NAME: "rev" });
  await Promise.all([sam.start(), rev.start()]);
  assert.ok(await until(() => sam.session.state === "bound" && rev.session.state === "bound"));
  const catalog = await sam.tools();
  assert.deepEqual(catalog.map((x) => x.name), ["list_peers", "send_message", "wait_for_message", "read_inbox", "ack_messages", "send_file", "verify_snapshot", "send_review_set", "verify_review_set"]);
  assert.equal(catalog.find((x) => x.name === "send_file").annotations.openWorldHint, true);
  assert.match(catalog.find((x) => x.name === "read_inbox").description, /listen --session "/);
  assert.match(sam.instructions(), /Your hoptell peer name is "sam"/);
  const sent = await sam.call("send_message", { to: "rev", message: "plain" });
  assert.deepEqual(Object.keys(sent).sort(), ["content", "isError"]);
  assert.equal(sent.isError, false);
  const file = await sam.call("send_file", { to: "rev", root_id: "app", path: "x.js", request: "look" });
  assert.equal(file.isError, false);
  assert.equal(file.structuredContent.state, "accepted");
  assert.deepEqual(JSON.parse(file.content[0].text), file.structuredContent);
  const verify = await sam.call("verify_snapshot", { snapshot_id: file.structuredContent.snapshot_id });
  assert.equal(verify.structuredContent.state, "match");
  const bad = await sam.call("send_message", { to: 5 });
  assert.equal(bad.isError, true);
  assert.match(textOf(bad), /required strings/);
});

test("lifecycle: the first detach keeps the engine; the last stops it and frees the name; a pending wait settles", async (t) => {
  const aliceToken = fakeToken();
  const relay = await startRelay({ host: "127.0.0.1", port: 0, token: TOKEN, members: [{ name: "alice", token: aliceToken }], log: () => {} });
  t.after(() => relay.close());
  const url = `ws://127.0.0.1:${relay.port}`;
  const e = engineFor(t, { HOPTELL_RELAY: url, HOPTELL_TOKEN: aliceToken, HOPTELL_HOME: tmp(t, "elife"), HOPTELL_NAME: "alice-life" });
  const h1 = e.attach();
  const h2 = e.attach();
  await e.start();
  assert.ok(await until(() => e.session.state === "bound"));
  const waiting = e.call("wait_for_message", { timeout_seconds: 60 });
  h1.detach();
  h1.detach(); // a duplicate detach is a no-op
  assert.equal(e.state, "running");
  const started = Date.now();
  h2.detach(); // the last one: the engine stops
  assert.match(textOf(await waiting), /Wait ended without returning messages/);
  assert.ok(Date.now() - started < 5000, "the wait settled on stop");
  await e.stop(); // the same stop
  assert.equal(e.state, "stopped");
  assert.throws(() => e.attach(), /stopped/);
  assert.match(textOf(await e.call("read_inbox")), /stopping/);
  // Another principal sees the name free at once (released, not reserved).
  const probe = new RelayClient({ url, token: TOKEN, name: "probe", mode: "send", reconnect: false });
  t.after(() => probe.close());
  await probe.start().ready();
  assert.equal((await probe.rpc({ type: "claim_status", name: "alice-life" })).state, "free");
});

test("lifecycle: stop before start never connects; stop racing the welcome publishes nothing", async (t) => {
  const w = await world();
  t.after(() => w.close());
  const home = tmp(t, "erace");
  const base = { HOPTELL_RELAY: w.env.HOPTELL_RELAY, HOPTELL_TOKEN: TOKEN, HOPTELL_HOME: home };
  const logins = w.relay.stats().logins;
  const never = engineFor(t, { ...base, HOPTELL_NAME: "never" });
  await never.stop();
  await never.start(); // after stop: nothing happens
  assert.equal(never.state, "stopped");
  await sleep(200);
  assert.equal(w.relay.stats().logins, logins);
  const racing = engineFor(t, { ...base, HOPTELL_NAME: "racing" });
  await racing.start();
  await racing.stop();
  await sleep(300);
  assert.equal(racing.session.state, "pending", "no session context after stop");
  assert.equal(fs.existsSync(path.join(home, "v2")) && fs.readdirSync(path.join(home, "v2")).some((r) => fs.existsSync(path.join(home, "v2", r, "names", "racing.json"))), false, "no owner record");
});

test("notices: a failing notifier affects nothing else; a detached one gets nothing", async (t) => {
  const w = await world();
  t.after(() => w.close());
  const base = { HOPTELL_RELAY: w.env.HOPTELL_RELAY, HOPTELL_TOKEN: TOKEN, HOPTELL_HOME: tmp(t, "enote") };
  const rx = createEngine(settingsFor({ ...base, HOPTELL_PUSH: "listener", HOPTELL_NAME: "rx" }), { findHost: () => null, keepAlive: true });
  t.after(() => rx.stop());
  const seen = [];
  rx.attach({ notify: () => Promise.reject(new Error("broken front end")) });
  rx.attach({ notify: () => { throw new Error("broken too"); } });
  const good = rx.attach({ notify: (m) => seen.push(m.text) });
  const tx = engineFor(t, { ...base, HOPTELL_NAME: "tx" });
  await Promise.all([rx.start(), tx.start()]);
  assert.ok(await until(() => rx.session.state === "bound" && tx.session.state === "bound"));
  await tx.call("send_message", { to: "rx", message: "one" });
  assert.ok(await until(() => seen.length === 1));
  assert.equal(w.relay.stats().unconfirmed, 0, "stored and confirmed despite the failing notifiers");
  good.detach();
  await tx.call("send_message", { to: "rx", message: "two" });
  let got = "";
  assert.ok(await until(async () => /two/.test((got += textOf(await rx.call("read_inbox"))))));
  assert.deepEqual(seen, ["one"]);
  assert.equal(rx.state, "running", "kept alive by its owner");
});

// Only entry points read the process environment, home or working directory; everything an
// engine uses gets its settings passed in. Each allowed read is listed with its reason.
const ALLOWED = {
  "config.js": "loadEnv/envFiles: the CLI's settings-file loading at startup",
  "settings.js": "bootstrap(): captures the environment once for readSettings",
  "realm.js": "relay side: the relay's default state directory",
  "host.js": "PATH for the process-inspection tools it runs (not a hoptell setting)",
  "gitsafe.js": "PATH, only to find the git executable (not a hoptell setting); Git itself gets an environment built from scratch",
  "tmux.js": "CLI commands tmux/inject: the spawn environment for tmux without HOPTELL_ values, and the caller's directory",
  "agentdeny.js": "ownerRelaysFile: a relative HOPTELL_RELAYS against the surface's working directory (settings.js's rule), when the caller passes no directory",
  "decisions.js": "approvalContext: the approving surface's environment, when the caller passes none, to resolve the owner relays file and CODEX_HOME a hardened profile is checked against",
};
test("guard: no hidden reads of the environment, home or working directory behind the engine", () => {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "lib");
  const found = [];
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".js"))) {
    const code = fs.readFileSync(path.join(dir, f), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    if (/process\.env|os\.homedir\(\)|process\.cwd\(\)/.test(code) && !ALLOWED[f]) found.push(f);
  }
  assert.deepEqual(found, [], "these modules read ambient settings; pass them in instead");
});

test("stop releases everything: file-tool descriptors and timers, wait listeners, a start still in progress", async (t) => {
  const w = await world();
  t.after(() => w.close());
  const { getEventListeners } = await import("node:events");
  const inbox = await import("../lib/inbox.js");
  // A finished wait leaves no abort listener behind.
  const ctl = new AbortController();
  const dir = tmp(t, "ewait");
  const store = { inbox: dir, seen: null };
  await inbox.waitFor(store, 50, ctl.signal);
  assert.equal(getEventListeners(ctl.signal, "abort").length, 0);
  // Approved folders' descriptors are closed on stop.
  const fds = () => fs.readdirSync("/dev/fd").length;
  const app = tmp(t, "eapp");
  const before = fds();
  const e = engineFor(t, { HOPTELL_HOME: tmp(t, "efd"), HOPTELL_NAME: "fd", HOPTELL_SNAPSHOT_ROOTS: JSON.stringify([{ id: "a", path: app }, { id: "b", path: tmp(t, "eapp2") }]) });
  assert.ok(fds() >= before + 2, "the folders are open while the engine runs");
  await e.stop();
  assert.ok(fds() <= before, "and closed after stop");
  // A stop during a slow start (hook delivery probing a host) waits for it; nothing starts after.
  const logins = w.relay.stats().logins;
  const host = { pid: process.pid, start: "x", uid: process.getuid(), boot: "b" };
  const slow = createEngine(settingsFor({ HOPTELL_PUSH: "hook", HOPTELL_RELAY: w.env.HOPTELL_RELAY, HOPTELL_TOKEN: TOKEN, HOPTELL_HOME: tmp(t, "eslow"), HOPTELL_NAME: "slow" }), { findHost: () => host });
  const starting = slow.start();
  await sleep(50);
  await slow.stop();
  await starting;
  await sleep(300);
  assert.equal(slow.state, "stopped");
  assert.equal(w.relay.stats().logins, logins, "the relay connection never started");
});

test("a notifier detached while notices are being sent is not called", async (t) => {
  const w = await world();
  t.after(() => w.close());
  const base = { HOPTELL_RELAY: w.env.HOPTELL_RELAY, HOPTELL_TOKEN: TOKEN, HOPTELL_HOME: tmp(t, "edet") };
  const rx = createEngine(settingsFor({ ...base, HOPTELL_PUSH: "listener", HOPTELL_NAME: "rx2" }), { findHost: () => null, keepAlive: true });
  t.after(() => rx.stop());
  const calls = [];
  let second;
  rx.attach({ notify: () => (calls.push("first"), second.detach()) });
  second = rx.attach({ notify: () => calls.push("second") });
  const tx = engineFor(t, { ...base, HOPTELL_NAME: "tx2" });
  await Promise.all([rx.start(), tx.start()]);
  assert.ok(await until(() => rx.session.state === "bound" && tx.session.state === "bound"));
  await tx.call("send_message", { to: "rx2", message: "x" });
  assert.ok(await until(() => calls.length >= 1));
  await sleep(100);
  assert.deepEqual(calls, ["first"]);
});

test("a stopped engine never takes hook ownership later; a replacement engine gets the hook", async (t) => {
  const { hookChannel } = await import("../lib/wake.js");
  const { processInfo } = await import("../lib/host.js");
  const home = tmp(t, "earm");
  const host = { ...processInfo(process.pid), uid: process.getuid(), boot: "test-fixture" };
  const settings = settingsFor({ HOPTELL_HOME: home, HOPTELL_PUSH: "hook" });
  const old = createEngine(settings, { findHost: () => host });
  const starting = old.start(); // waits for a hook registration that is not there yet
  await sleep(30);
  const t0 = Date.now();
  await old.stop();
  assert.ok(Date.now() - t0 < 1000, "stop ends the hook wait at once");
  await starting;
  // The registration appears after the stop.
  const meta = hookChannel({ home, host, peer: "fixture" });
  const f = meta.files;
  fs.writeFileSync(f.bell, "", { mode: 0o600 });
  fs.writeFileSync(f.reg, JSON.stringify({ v: 1, key: meta.key, host: { pid: host.pid, start: host.start, uid: host.uid, boot: host.boot }, bell: f.bell, epoch: "fixture", session_id: "fixture" }), { mode: 0o600 });
  await sleep(500);
  assert.equal(fs.existsSync(f.runtime), false, "the stopped engine published nothing");
  const next = createEngine(settings, { findHost: () => host });
  t.after(() => next.stop());
  await next.start(); // nothing answers its probe here: unverified, but it owns the channel
  assert.ok(next.delivery.hook, "the replacement engine is not blocked by the stopped one");
});

test("stopping during a file read sends nothing and records nothing", { skip: process.platform === "win32" }, async (t) => {
  const w = await world();
  t.after(() => w.close());
  const home = tmp(t, "efile");
  const app = path.join(home, "app");
  fs.mkdirSync(app);
  fs.writeFileSync(path.join(app, "x.js"), "const x = 1;\n");
  const barrier = path.join(home, "barrier");
  fs.writeFileSync(`${barrier}.step`, "file-checked");
  const e = createEngine(
    settingsFor({
      HOPTELL_PUSH: "listener",
      HOPTELL_RELAY: w.env.HOPTELL_RELAY,
      HOPTELL_TOKEN: TOKEN,
      HOPTELL_HOME: home,
      HOPTELL_NAME: "filer",
      HOPTELL_SNAPSHOT_ROOTS: JSON.stringify([{ id: "app", path: app }]),
      HOPTELL_READER_TEST_BARRIER: barrier,
    }),
    { findHost: () => null },
  );
  await e.start();
  assert.ok(await until(() => e.session.state === "bound"));
  const sending = e.call("send_file", { to: "nobody", root_id: "app", path: "x.js", request: "look" });
  assert.ok(await until(() => fs.existsSync(`${barrier}.at`)), "the helper paused mid-read");
  await e.stop();
  fs.writeFileSync(`${barrier}.go-file-checked`, "");
  const r = await sending;
  assert.equal(r.isError, true);
  assert.equal(r.structuredContent.state, "error");
  const snaps = path.join(home, "snapshots");
  const records = fs.existsSync(snaps) ? fs.readdirSync(snaps, { recursive: true }).filter((n) => String(n).endsWith(".json")) : [];
  assert.deepEqual(records, [], "no snapshot record after stop");
});
