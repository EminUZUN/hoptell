// Protocol-2 sessions on the client side: automatic names, bound storage, delivery dedup, the
// relay profile pin, local consumers (listen, injector) and CLI name conflicts.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { WebSocketServer } from "ws";
import { RelayClient } from "../lib/client.js";
import { HOSTNAME } from "../lib/config.js";
import * as inbox from "../lib/inbox.js";
import { startRelay } from "../lib/relay.js";
import { boundFromPath, openBound, sessionKey } from "../lib/session.js";
import { TOKEN, fakeToken, sleep, world } from "./helpers.js";

/** Run fn with a fresh state folder (this process's own storage, passed explicitly). */
async function withHome(t, fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "hoptell-session-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return fn(home);
}

test("an agent session without HOPTELL_NAME gets its name from the relay and keeps messages in bound storage", async (t) => {
  const w = await world();
  t.after(() => w.close());
  const a = await w.mcp("");
  assert.doesNotMatch(a.client.getInstructions(), /as peer "/, "an automatic name is never stated in the instructions");
  assert.match(a.client.getInstructions(), /your peer name is shown by list_peers/);
  const me = (await a.call("list_peers")).match(/You are "([^"]+)"/)[1];
  assert.match(me, new RegExp(`^${HOSTNAME}-\\d+$`), "shared token: <host>-<n>");
  const { tools } = await a.client.listTools();
  const listen = tools.find((x) => x.name === "read_inbox").description.match(/listen --session "([^"]+)"/);
  assert.ok(listen, "the listener command names the session's storage folder");
  const dir = listen[1];
  const binding = JSON.parse(fs.readFileSync(path.join(dir, "binding.json"), "utf8"));
  assert.equal(binding.session_key, me);
  assert.equal(binding.member, "shared");
  assert.equal(binding.realm, w.relay.realm.id);
  assert.equal(fs.existsSync(path.join(w.home, "inbox", me)), false, "nothing goes to the legacy inbox");

  const sent = await w.cli(["send", me, "first"], { HOPTELL_NAME: "bob" });
  assert.equal(sent.code, 0, sent.stderr);
  let got = "";
  for (let i = 0; i < 50 && !/first/.test(got); i++) {
    got += await a.call("read_inbox");
    if (!/first/.test(got)) await sleep(100);
  }
  assert.match(got, /from "bob"[\s\S]*first/);

  // The listener command reads the same storage.
  const listening = w.cli(["listen", "--session", dir, "10"]);
  await sleep(300);
  await w.cli(["send", me, "second"], { HOPTELL_NAME: "bob" });
  const r = await listening;
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /second/);
  // Only folders this installation created are accepted.
  const bad = await w.cli(["listen", "--session", w.home, "1"]);
  assert.notEqual(bad.code, 0);
  assert.match(bad.stderr, /not a hoptell session folder/);
});

test("listen <name> follows an explicit name's bound storage once its relay profile uses protocol 2", async (t) => {
  const w = await world();
  t.after(() => w.close());
  await w.mcp("carol");
  const listening = w.cli(["listen", "carol", "10"]);
  await sleep(300);
  assert.equal((await w.cli(["send", "carol", "for", "the", "listener"], { HOPTELL_NAME: "bob" })).code, 0);
  const r = await listening;
  assert.match(r.stdout, /for the listener/);
});

test("bound storage: a binding cannot be reused for another realm, member or session; repeats of a delivery are stored once", async (t) => {
  await withHome(t, async (home) => {
    const realm = "a".repeat(32);
    const member = { id: "m_aaaaaaaaaaaaaaaaaaaaaaaaaa", name: "alice" };
    const key = sessionKey("alice-pc-7", { explicit: false, member });
    assert.equal(key, "pc-7", "an automatic name's local stem");
    assert.equal(sessionKey("alice-pc-7", { explicit: true, member }), "alice-pc-7", "an explicit name is kept");
    const s = await openBound(home, { realm, member, key });
    assert.equal(s.dir, path.join(home, "v2", realm, member.id, key));
    assert.equal((await openBound(home, { realm, member, key })).dir, s.dir, "the same binding opens again");
    // A binding moved under another member is refused.
    const other = path.join(home, "v2", realm, "shared", key);
    fs.mkdirSync(other, { recursive: true });
    fs.copyFileSync(path.join(s.dir, "binding.json"), path.join(other, "binding.json"));
    await assert.rejects(openBound(home, { realm, member: null, key }), /belongs to another realm, member or session/);
    assert.equal(path.basename((await openBound(home, { realm, member: { id: "name:bob", name: "bob" }, key })).dir), key);
    assert.match(path.dirname((await openBound(home, { realm, member: { id: "name:bob", name: "bob" }, key })).dir), /name-bob$/);
    await assert.rejects(openBound(home, { realm, member: { id: "../x" }, key }), /cannot store/);
    assert.equal(boundFromPath(home, s.dir).dir, fs.realpathSync(s.dir));

    const msg = { type: "message", id: "8b2f9c0e-0d6b-4a43-9d7e-3f0e6c1b2a10", from: "bob", text: "hi", ts: Date.now() };
    assert.equal(inbox.append(s, msg), true);
    assert.equal(inbox.append(s, msg), false, "a repeat of the same delivery");
    assert.equal(inbox.list(s).length, 1);
    assert.equal(inbox.take(s).length, 1);
    assert.equal(inbox.append(s, msg), false, "still known after it was read");
    // Old delivery ids are forgotten after any message could have expired.
    inbox.pruneSeen(s, Date.now() + 9 * 86400_000);
    assert.equal(inbox.append(s, msg), true);
  });
});

test("a delivery repeated after a connection handoff is stored once and confirmed", async (t) => {
  await withHome(t, async (home) => {
    const token = fakeToken();
    const relay = await startRelay({ host: "127.0.0.1", port: 0, members: [{ name: "alice", token }], realm: { id: "2".repeat(32) }, log: () => {} });
    t.after(() => relay.close());
    const url = `ws://127.0.0.1:${relay.port}`;
    let store = null;
    const c = new RelayClient({
      url,
      token,
      name: "alice-rx",
      onWelcome: async (wl) => (store = await openBound(home, { realm: wl.realm.id, member: wl.member, key: "alice-rx" })),
    });
    t.after(() => c.close());
    let deliveries = 0;
    c.on("message", (m, confirm) => {
      deliveries++;
      if (inbox.append(store, m) === false) return confirm();
      // First time: stored, but the connection drops before the confirmation is sent.
      if (deliveries === 1) return c.ws.terminate();
      confirm();
    });
    c.start();
    await c.ready();
    const s = new RelayClient({ url, token, name: "alice-tx", mode: "send", reconnect: false });
    t.after(() => s.close());
    await s.start().ready();
    await s.send("alice-rx", "once");
    // On the drop the relay requeues it; the resumed connection gets the same delivery again.
    for (let i = 0; i < 100 && (deliveries < 2 || relay.stats().unconfirmed); i++) await sleep(50);
    assert.equal(deliveries, 2, "the relay sent it again after the resume");
    assert.equal(relay.stats().unconfirmed, 0, "the repeat was confirmed");
    assert.deepEqual(inbox.take(store).map((m) => m.text), ["once"]);
  });
});

test("a relay profile pinned to one realm refuses a relay reporting another", async (t) => {
  const w = await world();
  t.after(() => w.close());
  const other = await startRelay({ host: "127.0.0.1", port: 0, token: TOKEN, realm: { id: "3".repeat(32) }, log: () => {} });
  t.after(() => other.close());
  const first = await w.cli(["list"], { HOPTELL_PROFILE: "work" });
  assert.equal(first.code, 0, first.stderr);
  const profile = JSON.parse(fs.readFileSync(path.join(w.home, "profiles", "work.json"), "utf8"));
  assert.equal(profile.realm, w.relay.realm.id);
  assert.equal(profile.require, true);
  const second = await w.cli(["list"], { HOPTELL_PROFILE: "work", HOPTELL_RELAY: `ws://127.0.0.1:${other.port}` });
  assert.notEqual(second.code, 0);
  assert.match(second.stderr, /realm changed/);
});

test("hoptell wait: a name in use stops it, --replace takes it over once, --wait-for-name waits for it", async (t) => {
  const w = await world();
  t.after(() => w.close());
  const dave = await w.mcp("dave");
  const busy = await w.cli(["wait", "3"], { HOPTELL_NAME: "dave" });
  assert.notEqual(busy.code, 0);
  assert.match(busy.stderr, /in use by another session/);

  const waiting = w.cli(["wait", "--wait-for-name", "20"], { HOPTELL_NAME: "dave" });
  await sleep(1000);
  await dave.client.close(); // a clean exit gives the name back at once
  let ok = null;
  for (let i = 0; i < 50 && !/Delivered/.test(ok?.stdout ?? ""); i++) {
    await sleep(200);
    ok = await w.cli(["send", "dave", "after", "the", "wait"], { HOPTELL_NAME: "bob" });
  }
  const r = await waiting;
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /after the wait/);

  const erin = await w.mcp("erin");
  const replacing = w.cli(["wait", "--replace", "10"], { HOPTELL_NAME: "erin" });
  await sleep(1000);
  await w.cli(["send", "erin", "to", "the", "replacement"], { HOPTELL_NAME: "bob" });
  const rr = await replacing;
  assert.equal(rr.code, 0, rr.stderr);
  assert.match(rr.stdout, /to the replacement/);
  assert.doesNotMatch(await erin.call("read_inbox"), /to the replacement/);
});

test("a member token on an older relay without HOPTELL_NAME gets a clear instruction", async (t) => {
  // An older relay: refuses protocol 2 (4005); refuses the default protocol-1 name (4002).
  const old = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  t.after(() => old.close());
  await new Promise((r) => old.once("listening", r));
  old.on("connection", (ws) =>
    ws.on("message", (d) => {
      const m = JSON.parse(d);
      ws.close(m.v === 2 ? 4005 : 4002, m.v === 2 ? "unsupported protocol" : "name not allowed for this member token");
    }),
  );
  const c = new RelayClient({ url: `ws://127.0.0.1:${old.address().port}`, token: fakeToken(), name: null, reconnect: false });
  t.after(() => c.close());
  await assert.rejects(c.start().ready(), /set HOPTELL_NAME to the member-prefixed name/);
});

test("a name a member token may not use: the refusal says which names it may use, in each protocol and in doctor", async (t) => {
  const aliceToken = fakeToken();
  const relay = await startRelay({ host: "127.0.0.1", port: 0, token: TOKEN, members: [{ name: "alice", token: aliceToken }], log: () => {} });
  t.after(() => relay.close());
  const url = `ws://127.0.0.1:${relay.port}`;
  for (const protocol of [2, 1]) {
    const c = new RelayClient({ url, token: aliceToken, name: "bob-x", protocol, reconnect: false });
    t.after(() => c.close());
    await assert.rejects(c.start().ready(), { message: `relay refused the connection: name not allowed: a member token may use only "<member>" or names that start with "<member>-", e.g. HOPTELL_NAME=<member>-<name>; a shared token may not use a hosted member's names (4002)` });
  }
  const { doctor } = await import("../lib/doctor.js");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "hoptell-session-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const out = [];
  await doctor({ HOPTELL_RELAY: url, HOPTELL_TOKEN: aliceToken, HOPTELL_NAME: "bob", HOPTELL_HOME: home }, (l) => out.push(l), { homedir: home });
  assert.match(out.join("\n"), /FAIL +relay login: the relay refused this name: a member token may use only "<member>" or names that start with "<member>-", e\.g\. HOPTELL_NAME=<member>-<name>; a shared token may not use a hosted member's names \(4002\)/);
});

test("an agent session that exits cleanly frees its name at once (no reservation)", async (t) => {
  const w = await world();
  t.after(() => w.close());
  const aliceToken = fakeToken();
  const relay = await startRelay({ host: "127.0.0.1", port: 0, token: TOKEN, members: [{ name: "alice", token: aliceToken }], log: () => {} });
  t.after(() => relay.close());
  const url = `ws://127.0.0.1:${relay.port}`;
  const a = await w.mcp("alice-x", { HOPTELL_RELAY: url, HOPTELL_TOKEN: aliceToken });
  assert.match(await a.call("list_peers"), /You are "alice-x"/);
  await a.client.close();
  // Another principal (the shared token) asks about the name: free, not reserved.
  const probe = new RelayClient({ url, token: TOKEN, name: "probe", mode: "send", reconnect: false });
  t.after(() => probe.close());
  await probe.start().ready();
  let state = null;
  for (let i = 0; i < 20 && state !== "free"; i++) {
    state = (await probe.rpc({ type: "claim_status", name: "alice-x" })).state;
    if (state !== "free") await sleep(100);
  }
  assert.equal(state, "free");
});

test("the fallback to protocol 1 waits for an asynchronous onLegacy, and stops if it fails", async (t) => {
  const old = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  t.after(() => old.close());
  await new Promise((r) => old.once("listening", r));
  old.on("connection", (ws) =>
    ws.on("message", (d) => {
      const m = JSON.parse(d);
      if (m.v === 2) return ws.close(4005, "unsupported protocol");
      ws.send(JSON.stringify({ type: "welcome", name: m.name }));
    }),
  );
  const url = `ws://127.0.0.1:${old.address().port}`;
  let recorded = false;
  const ok = new RelayClient({ url, token: fakeToken(), name: "x", reconnect: false, onLegacy: async () => (await sleep(100), (recorded = true)) });
  t.after(() => ok.close());
  await ok.start().ready();
  assert.equal(recorded, true);
  assert.equal(ok.protocolInUse, 1);
  const refused = new RelayClient({ url, token: fakeToken(), name: "y", reconnect: false, onLegacy: async () => Promise.reject(new Error("this relay profile requires protocol 2")) });
  t.after(() => refused.close());
  await assert.rejects(refused.start().ready(), /requires protocol 2/);
});

test("a welcome whose socket closes while it is being committed does not make the client ready", async (t) => {
  const srv = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  t.after(() => srv.close());
  await new Promise((r) => srv.once("listening", r));
  let connections = 0;
  srv.on("connection", (ws) => {
    connections++;
    ws.on("message", (d) => {
      const m = JSON.parse(d);
      ws.send(JSON.stringify({ type: "welcome", name: m.name, realm: { id: "6".repeat(32) }, member: null, claim: { lease: "a".repeat(32), secret: "s", gen: 1, incarnation: "i" } }));
      ws.close(1001);
    });
  });
  const c = new RelayClient({ url: `ws://127.0.0.1:${srv.address().port}`, token: fakeToken(), name: "z", reconnect: false, onWelcome: () => sleep(200) });
  t.after(() => c.close());
  let ready = false;
  c.on("ready", () => (ready = true));
  c.start();
  await sleep(600);
  assert.equal(ready, false);
  assert.equal(c.connected, false);
  assert.equal(connections, 1);
});

test("locks are published with their process id; a stale one is broken, a live one is not", async (t) => {
  const { tryLock } = await import("../lib/locks.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hoptell-lock-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const lock = path.join(dir, "x.lock");
  const release = tryLock(lock);
  assert.equal(typeof release, "function");
  assert.equal(fs.readFileSync(lock, "utf8").trim(), String(process.pid));
  assert.deepEqual(tryLock(lock), { pid: process.pid }, "a live holder keeps it");
  release();
  assert.equal(fs.existsSync(lock), false);
  fs.writeFileSync(lock, "999999999\n");
  const again = tryLock(lock);
  assert.equal(typeof again, "function", "a stale lock is taken over");
  again();
  assert.deepEqual(fs.readdirSync(dir), [], "no temporary or moved-aside files are left");
});

/**
 * Another process taking `lock` with tryLock, synchronously from the caller's view: it writes its
 * result to a file, which this waits for (so it works inside tryLock's test hooks). It stays alive
 * (holding what it got) until killed.
 */
function locker(t, lock) {
  const mod = new URL("../lib/locks.js", import.meta.url).href;
  const out = `${lock}.out-${crypto.randomUUID()}`;
  const code = `import(${JSON.stringify(mod)}).then((m) => { const r = m.tryLock(process.argv[1]); require("node:fs").writeFileSync(process.argv[2], typeof r === "function" ? "acquired" : "held " + r.pid); setInterval(() => {}, 1000); })`;
  const child = spawn(process.execPath, ["-e", code, lock, out], { stdio: "ignore" });
  t.after(() => child.kill("SIGKILL"));
  const until = Date.now() + 10_000;
  // The child creates the file, then writes its result: wait for the content, not just the file.
  const read = () => (fs.existsSync(out) ? fs.readFileSync(out, "utf8") : "");
  while (!read() && Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  const line = read();
  fs.rmSync(out);
  return { pid: child.pid, line, kill: () => child.kill("SIGKILL") };
}

test("stale locks: a live lock is never moved or removed, whatever the interleaving", async (t) => {
  const { tryLock } = await import("../lib/locks.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hoptell-lock-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const lock = path.join(dir, "x.lock");
  const dead = "999999999";

  // A sees the dead holder; before A breaks the lock, B removes it and takes the lock (B lives).
  fs.writeFileSync(lock, `${dead}\n`);
  let b;
  const a = tryLock(lock, { afterCheck: () => (b = locker(t, lock)) });
  assert.equal(b.line, "acquired");
  assert.deepEqual(a, { pid: b.pid }, "A does not remove B's live lock; it sees B as the holder");
  assert.equal(fs.readFileSync(lock, "utf8").trim(), String(b.pid));
  assert.equal(locker(t, lock).line, `held ${b.pid}`, "a third contender sees B as the holder too");
  b.kill();
  fs.rmSync(lock);

  // While A holds the break lock, another contender neither breaks nor takes the lock.
  fs.writeFileSync(lock, `${dead}\n`);
  let c;
  const mine = tryLock(lock, { beforeBreak: () => (c = locker(t, lock)) });
  assert.equal(c.line, `held ${process.pid}`, "the contender waits for the process removing the stale lock");
  assert.equal(typeof mine, "function", "the stale lock is replaced by this process's");
  assert.equal(fs.readFileSync(lock, "utf8").trim(), String(process.pid));
  assert.equal(fs.existsSync(`${lock}.break`), false);
  c.kill();
  // A late release by an earlier owner leaves a newer owner's lock alone.
  fs.rmSync(lock);
  const d = locker(t, lock);
  assert.equal(d.line, "acquired");
  mine();
  assert.equal(fs.readFileSync(lock, "utf8").trim(), String(d.pid));
  d.kill();
  fs.rmSync(lock);

  // A break lock left by an ended process is reported, never guessed around.
  fs.writeFileSync(lock, `${dead}\n`);
  fs.writeFileSync(`${lock}.break`, `${dead}\n`);
  assert.throws(() => tryLock(lock), /removing a stale lock was interrupted/);
  assert.equal(fs.readFileSync(lock, "utf8").trim(), dead);
  assert.deepEqual(fs.readdirSync(dir).sort(), ["x.lock", "x.lock.break"], "no temporary files are left");
});

test("name consumers follow the receiving session, not the last member to sign in", async (t) => {
  const w = await world();
  t.after(() => w.close());
  const aliceToken = fakeToken();
  const bobToken = fakeToken();
  const relay = await startRelay({ host: "127.0.0.1", port: 0, members: [{ name: "alice", token: aliceToken }, { name: "bob", token: bobToken }], log: () => {} });
  t.after(() => relay.close());
  const env = { HOPTELL_RELAY: `ws://127.0.0.1:${relay.port}` };
  // The listener starts before its receiver: it waits, then follows the receiver's storage.
  const listening = w.cli(["listen", "alice-agent", "15"], env);
  await sleep(500);
  await w.mcp("alice-agent", { ...env, HOPTELL_TOKEN: aliceToken });
  // Bob signs in with the same relay URL (same profile) afterwards.
  assert.equal((await w.cli(["list"], { ...env, HOPTELL_TOKEN: bobToken, HOPTELL_NAME: "bob-cli" })).code, 0);
  assert.equal((await w.cli(["send", "alice-agent", "routed"], { ...env, HOPTELL_TOKEN: bobToken, HOPTELL_NAME: "bob-cli" })).code, 0);
  const r = await listening;
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /routed/);
  assert.match(r.stdout, /Sender: member "bob" \(name:bob\), signed in with its member token according to the relay/);
  // A damaged owner record is an error, never a silent switch to the legacy inbox.
  const names = fs.readdirSync(path.join(w.home, "v2")).map((realm) => path.join(w.home, "v2", realm, "names", "alice-agent.json")).find((f) => fs.existsSync(f));
  fs.writeFileSync(names, "{");
  const bad = await w.cli(["listen", "alice-agent", "2"], env);
  assert.notEqual(bad.code, 0);
  assert.match(bad.stderr, /cannot be read/);
});

test("before the relay's welcome, read_inbox does not consume the legacy inbox of the same name", async (t) => {
  const w = await world();
  t.after(() => w.close());
  // A legacy message from before the upgrade, and a relay that never answers.
  const legacy = path.join(w.home, "inbox", "erin");
  fs.mkdirSync(legacy, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(legacy, "0000000000001-00000001-aaaaaaaa.json"), JSON.stringify({ from: "x", fromHost: "h", text: "old", ts: 1 }), { mode: 0o600 });
  const silent = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  t.after(() => silent.close());
  await new Promise((r) => silent.once("listening", r));
  const e = await w.mcp("erin", { HOPTELL_RELAY: `ws://127.0.0.1:${silent.address().port}` });
  assert.match(await e.call("read_inbox"), /not connected/);
  assert.equal(fs.readdirSync(legacy).length, 1, "the legacy message is still there");
});

test("a pinned profile stops the fallback to an older relay before any protocol-1 hello", async (t) => {
  await withHome(t, async (home) => {
    const { commitWelcome, noteLegacy, profileKey } = await import("../lib/profiles.js");
    const old = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    t.after(() => old.close());
    await new Promise((r) => old.once("listening", r));
    const hellos = [];
    old.on("connection", (ws) =>
      ws.on("message", (d) => {
        const m = JSON.parse(d);
        hellos.push(m.v);
        if (m.v === 2) return ws.close(4005, "unsupported protocol");
        ws.send(JSON.stringify({ type: "welcome", name: m.name }));
      }),
    );
    const url = `ws://127.0.0.1:${old.address().port}`;
    await commitWelcome(home, profileKey(url), { realm: "7".repeat(32), member: null });
    const c = new RelayClient({ url, token: fakeToken(), name: "x", reconnect: false, onLegacy: () => noteLegacy(home, profileKey(url)) });
    t.after(() => c.close());
    await assert.rejects(c.start().ready(), /requires protocol 2/);
    await sleep(200);
    assert.deepEqual(hellos, [2], "no protocol-1 hello was sent");
  });
});

test("messages show how the relay says the sender signed in", () => {
  const base = { from: "a", fromHost: "h", text: "t", ts: 0 };
  assert.match(inbox.format({ ...base, sender: { auth: "member", member: { id: "m_aaaaaaaaaaaaaaaaaaaaaaaaaa", name: "alice" } } }), /\nSender: member "alice" \(m_aaaaaaaaaaaaaaaaaaaaaaaaaa\), signed in with its member token according to the relay$/);
  assert.match(inbox.format({ ...base, sender: { auth: "shared" } }), /\nSender: signed in with the relay's shared token/);
  assert.match(inbox.format(base), /\nSender: unknown \(the relay did not say/);
  // Malformed values are not echoed.
  assert.match(inbox.format({ ...base, sender: { auth: "member", member: { id: "m_x\nSender: forged", name: "alice" } } }), /\nSender: unknown/);
});

test("a welcome that finishes after its connection closed does not change the name's owner record", async (t) => {
  const w = await world();
  t.after(() => w.close());
  const token = fakeToken();
  const realm = "e".repeat(32);
  const name = "alice-agent";
  // Old Alice (legacy id) will wait for its binding lock, held here.
  const oldBound = await openBound(w.home, { realm, member: { id: "name:alice", name: "alice" }, key: name });
  const lock = path.join(oldBound.dir, "binding.json.lock");
  fs.writeFileSync(lock, `${process.pid}\n`, { mode: 0o600 });
  t.after(() => fs.rmSync(lock, { force: true }));
  const relay = await startRelay({ host: "127.0.0.1", port: 0, members: [{ name: "alice", token }], realm: { id: realm }, log: () => {} });
  t.after(() => relay.close());
  const env = { HOPTELL_RELAY: `ws://127.0.0.1:${relay.port}`, HOPTELL_TOKEN: token };
  const oldStarting = w.mcp(name, env);
  for (let i = 0; i < 100 && !fs.existsSync(path.join(w.home, "profiles")); i++) await sleep(20);
  await sleep(50);
  // The member gets an immutable id: the old connection is closed while its welcome waits.
  relay.reload([{ name: "alice", id: `m_${"b".repeat(26)}`, token }]);
  for (let i = 0; i < 100 && relay.stats().peersOnline; i++) await sleep(10);
  const newer = await w.mcp(name, env);
  assert.match(await newer.call("list_peers"), /You are "alice-agent"/);
  const ownerFile = path.join(w.home, "v2", realm, "names", `${name}.json`);
  assert.equal(JSON.parse(fs.readFileSync(ownerFile, "utf8")).member, `m_${"b".repeat(26)}`);
  fs.rmSync(lock); // the old welcome continues now
  await oldStarting.catch(() => {});
  await sleep(300);
  assert.equal(JSON.parse(fs.readFileSync(ownerFile, "utf8")).member, `m_${"b".repeat(26)}`, "the stale welcome did not take the name's routing");
});
