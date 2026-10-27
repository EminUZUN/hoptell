// The private local relay (lib/localrelay.js): service files, the member token, status and removal.
// The service manager is faked; one test runs the exact command line the service would run.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { RelayClient } from "../lib/client.js";
import { LABEL, UNIT, controlLocalRelay, installLocalRelay, localRelayStatus, uninstallLocalRelay, verifyRunning } from "../lib/localrelay.js";
import { sleep } from "./helpers.js";

const tmp = (t, p) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), p));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};
const offline = { portInUse: async () => false, verify: async () => {} }; // no real service in these tests
// A service manager that keeps the job's state: loaded or not, and the running instance's pid.
// `failRemove` keeps it running through bootout/disable; `samePid` makes a restart keep the old instance.
const fakeRunner = ({ failRemove = false, samePid = false } = {}) => {
  const calls = [];
  const st = { loaded: false, pid: 0, next: 100 };
  const up = () => ((st.loaded = true), samePid && st.pid ? null : (st.pid = st.next++));
  const ok = (stdout = "") => ({ status: 0, stdout, stderr: "" });
  const run = (cmd, args) => {
    calls.push([cmd, ...args].join(" "));
    const [a, b] = cmd === "systemctl" ? [args[1], args[2]] : [args[0]];
    if (cmd === "launchctl") {
      if (a === "print") return st.loaded ? ok(`state = running\n\tpid = ${st.pid}\n`) : { status: 113, stdout: "", stderr: "Could not find service" };
      if (a === "bootstrap") return st.loaded ? { status: 5, stdout: "", stderr: "Bootstrap failed: 5" } : (up(), ok());
      if (a === "kickstart") return ok();
      if (a === "bootout") return failRemove ? { status: 1, stdout: "", stderr: "Operation not permitted" } : st.loaded ? ((st.loaded = false), (st.pid = 0), ok()) : { status: 3, stdout: "", stderr: "No such process" };
    } else {
      if (a === "is-active") return { status: st.loaded ? 0 : 3, stdout: st.loaded ? "active\n" : "inactive\n", stderr: "" };
      if (a === "show") return ok(`${st.loaded ? st.pid : 0}\n`);
      if (a === "restart" || a === "start") return up(), ok();
      if (a === "stop" || (a === "disable" && b === "--now")) return failRemove ? { status: 1, stdout: "", stderr: "Access denied" } : ((st.loaded = false), (st.pid = 0), ok());
      return ok();
    }
    return ok();
  };
  return { calls, run, st };
};
const freePort = () =>
  new Promise((r) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => r(port));
    });
  });

test("install writes a loopback-only, members-only service and a private token; reinstall keeps the token", async (t) => {
  for (const platform of ["darwin", "linux"]) {
    const home = tmp(t, "hoptell-lr-");
    const homedir = tmp(t, "hoptell-lrh-");
    const { calls, run } = fakeRunner();
    const o = { home, homedir, platform, uid: 501, run, node: "/opt/node/bin/node", bin: "/opt/hoptell/bin/hoptell.js", ...offline };
    const r = await installLocalRelay({ ...o, port: 7799 });
    assert.equal(r.url, "ws://127.0.0.1:7799");
    const content = fs.readFileSync(r.service, "utf8");
    assert.match(content, /127\.0\.0\.1/);
    assert.match(content, /--require-members/);
    assert.doesNotMatch(content, /0\.0\.0\.0/);
    const token = fs.readFileSync(r.tokenFile, "utf8").trim();
    assert.match(token, /^[0-9a-f]{64}$/);
    assert.equal(fs.statSync(r.tokenFile).mode & 0o777, 0o600);
    assert.doesNotMatch(content, new RegExp(token), "the token is not in the service definition");
    const members = JSON.parse(fs.readFileSync(path.join(home, "local-relay", "members.json"), "utf8"));
    assert.match(members.members[0].token, /^sha256:/, "stored hashed");
    if (platform === "darwin") {
      assert.equal(r.service, path.join(homedir, "Library", "LaunchAgents", `${LABEL}.plist`));
      assert.ok(calls.includes(`launchctl bootstrap gui/501 ${r.service}`), calls.join("\n"));
    } else {
      assert.equal(r.service, path.join(homedir, ".config", "systemd", "user", UNIT));
      assert.ok(calls.includes(`systemctl --user enable ${UNIT}`) && calls.includes(`systemctl --user restart ${UNIT}`), calls.join("\n"));
    }
    assert.ok(calls.every((c) => c.includes(LABEL) || c.includes(UNIT) || /daemon-reload|bootstrap/.test(c)), "only this feature's service is addressed");
    await installLocalRelay({ ...o, port: 7799 });
    assert.equal(fs.readFileSync(r.tokenFile, "utf8").trim(), token, "a reinstall keeps the member token");
  }
  await assert.rejects(installLocalRelay({ home: tmp(t, "hoptell-lr-"), homedir: tmp(t, "hoptell-lrh-"), platform: "win32", run: fakeRunner().run, ...offline }), /supports macOS/);
  await assert.rejects(installLocalRelay({ home: tmp(t, "hoptell-lr-"), homedir: tmp(t, "hoptell-lrh-"), platform: "linux", run: fakeRunner().run, port: 80, ...offline }), /--port/);
});

test("the service's command line runs a relay that only this account's token opens", async (t) => {
  const home = tmp(t, "hoptell-lr-");
  const homedir = tmp(t, "hoptell-lrh-");
  const port = await freePort();
  const r = await installLocalRelay({ home, homedir, platform: "linux", run: fakeRunner().run, port, verify: async () => {} });
  const unit = fs.readFileSync(r.service, "utf8");
  const words = (line) => [...line.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1].replace(/\\(.)/g, "$1"));
  const argv = words(unit.match(/^ExecStart=(.*)$/m)[1]);
  const env = Object.fromEntries(words(unit.match(/^Environment=(.*)$/m)[1]).map((kv) => [kv.slice(0, kv.indexOf("=")), kv.slice(kv.indexOf("=") + 1)]));
  // The service's own environment: nothing from this shell's hoptell settings.
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("HOPTELL_")));
  const child = spawn(argv[0], argv.slice(1), { stdio: "ignore", env: { ...clean, ...env } });
  t.after(() => child.kill("SIGTERM")); // by its own PID
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) break;
    } catch {}
    await sleep(100);
  }
  await verifyRunning(r.url, fs.readFileSync(r.tokenFile, "utf8").trim()); // what install checks before reporting success
  const c = new RelayClient({ url: r.url, token: fs.readFileSync(r.tokenFile, "utf8").trim(), name: "me-agent", mode: "send", reconnect: false });
  t.after(() => c.close());
  await c.start().ready(5000);
  assert.equal(c.member.name, "me");
  const wrong = new RelayClient({ url: r.url, token: "x".repeat(64), name: "me-x", mode: "send", reconnect: false });
  t.after(() => wrong.close());
  const fatal = new Promise((res) => wrong.on("fatal", res));
  wrong.start();
  assert.match(await fatal, /bad token|4003/);
});

test("status reports the service, the port and moved paths; uninstall keeps the token unless purged", async (t) => {
  const home = tmp(t, "hoptell-lr-");
  const homedir = tmp(t, "hoptell-lrh-");
  const { run } = fakeRunner();
  const o = { home, homedir, platform: "darwin", uid: 501, run, ...offline };
  assert.equal((await localRelayStatus(o)).installed, false);
  await installLocalRelay({ ...o, node: "/nonexistent/node", bin: "/nonexistent/hoptell.js", port: 7798 });
  const st = await localRelayStatus({ ...o, fetch: async () => ({ ok: true }) });
  assert.equal(st.installed, true);
  assert.equal(st.loaded, true);
  assert.equal(st.healthy, true);
  assert.equal(st.problems.length, 2, "both recorded paths are reported as moved");
  const u = await uninstallLocalRelay(o);
  assert.equal(u.removed, true);
  assert.equal(fs.existsSync(path.join(homedir, "Library", "LaunchAgents", `${LABEL}.plist`)), false);
  assert.ok(fs.existsSync(path.join(home, "local-relay", "token")), "kept without --purge");
  await uninstallLocalRelay(o, { purge: true });
  assert.equal(fs.existsSync(path.join(home, "local-relay")), false);
});

test("install stops before changing anything when the port is taken; a failed start keeps the identity", async (t) => {
  const home = tmp(t, "hoptell-lr-");
  const homedir = tmp(t, "hoptell-lrh-");
  const port = await freePort();
  const blocker = net.createServer().listen(port, "127.0.0.1");
  t.after(() => blocker.close());
  await new Promise((r) => blocker.once("listening", r));
  await assert.rejects(installLocalRelay({ home, homedir, platform: "linux", run: fakeRunner().run, port, verify: async () => {} }), /already in use/);
  assert.equal(fs.existsSync(path.join(home, "local-relay")), false, "nothing written");
  // A start that never answers: an error, and a rerun keeps the same token.
  const o = { home, homedir, platform: "linux", run: fakeRunner().run, port: port + 1, portInUse: async () => false };
  await assert.rejects(installLocalRelay({ ...o, verify: async () => { throw new Error("no answer"); } }), /no answer/);
  const token = fs.readFileSync(path.join(home, "local-relay", "token"), "utf8");
  await installLocalRelay({ ...o, verify: async () => {} });
  assert.equal(fs.readFileSync(path.join(home, "local-relay", "token"), "utf8"), token);
});

test("the relays entry: added once with an install id; uninstall removes only what it still owns", async (t) => {
  const run = () => {
    const home = tmp(t, "hoptell-lr-");
    const homedir = tmp(t, "hoptell-lrh-");
    const relaysFile = path.join(homedir, ".config", "hoptell", "relays.json");
    return { home, homedir, relaysFile, o: { home, homedir, platform: "linux", run: fakeRunner().run, ...offline, relaysFile, env: { HOPTELL_RELAY: "wss://team.example.com" } } };
  };
  const read = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
  // A new relays file keeps today's relay as the default, and gets "local".
  {
    const { relaysFile, o } = run();
    const r = await installLocalRelay({ ...o, port: 7790 });
    assert.equal(r.alias, "local");
    let doc = read(relaysFile);
    assert.deepEqual(doc.relays.map((x) => x.alias), ["default", "local"]);
    assert.equal(doc.default, "default");
    assert.deepEqual(doc.relays[0], { alias: "default", url: "wss://team.example.com", tokenEnv: "HOPTELL_TOKEN" });
    await installLocalRelay({ ...o, port: 7790 });
    assert.equal(read(relaysFile).relays.length, 2, "a reinstall adds nothing");
    // Renamed by the user: still ours (same id and fields), removed by uninstall.
    doc = read(relaysFile);
    doc.relays[1].alias = "mine";
    fs.writeFileSync(relaysFile, JSON.stringify(doc));
    const u = await uninstallLocalRelay(o);
    assert.equal(u.entryRemoved, true);
    assert.deepEqual(read(relaysFile).relays.map((x) => x.alias), ["default"]);
  }
  // "local" taken by an unrelated entry: ours is "local-2"; an edited entry of ours is left with a note.
  {
    const { relaysFile, o } = run();
    fs.mkdirSync(path.dirname(relaysFile), { recursive: true });
    fs.writeFileSync(relaysFile, JSON.stringify({ version: 1, default: "local", relays: [{ alias: "local", url: "ws://127.0.0.1:7790", tokenEnv: "OTHER" }] }), { mode: 0o600 });
    const r = await installLocalRelay({ ...o, port: 7790 });
    assert.equal(r.alias, "local-2");
    const doc = read(relaysFile);
    doc.relays[1].tokenFile = "/elsewhere/token";
    fs.writeFileSync(relaysFile, JSON.stringify(doc));
    const u = await uninstallLocalRelay(o);
    assert.equal(u.entryRemoved, false);
    assert.match(u.note, /changed since install/);
    assert.deepEqual(read(relaysFile).relays.map((x) => x.alias), ["local", "local-2"], "the unrelated same-URL entry and the edited one stay");
  }
});

test("end to end: the installed entry lets a session named alice join the local relay as me-alice", async (t) => {
  const home = tmp(t, "hoptell-lr-");
  const homedir = tmp(t, "hoptell-lrh-");
  const port = await freePort();
  const relaysFile = path.join(homedir, ".config", "hoptell", "relays.json");
  const r = await installLocalRelay({ home, homedir, platform: "linux", run: fakeRunner().run, port, portInUse: async () => false, verify: async () => {}, relaysFile, env: {} });
  const unit = fs.readFileSync(r.service, "utf8");
  const words = (line) => [...line.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1].replace(/\\(.)/g, "$1"));
  const argv = words(unit.match(/^ExecStart=(.*)$/m)[1]);
  const env = Object.fromEntries(words(unit.match(/^Environment=(.*)$/m)[1]).map((kv) => [kv.slice(0, kv.indexOf("=")), kv.slice(kv.indexOf("=") + 1)]));
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("HOPTELL_")));
  const child = spawn(argv[0], argv.slice(1), { stdio: "ignore", env: { ...clean, ...env } });
  t.after(() => child.kill("SIGTERM"));
  await verifyRunning(r.url, fs.readFileSync(r.tokenFile, "utf8").trim());
  const { readRelaysFile } = await import("../lib/relays.js");
  const { createComposer } = await import("../lib/composer.js");
  const { readSettings } = await import("../lib/settings.js");
  const senv = { HOPTELL_HOME: path.join(home, "session"), HOPTELL_NAME: "alice", HOPTELL_PUSH: "listener", HOPTELL_RELAYS: relaysFile };
  const c = createComposer(readSettings({ env: senv, homedir, pid: process.pid, hostname: "testhost" }), readRelaysFile(relaysFile, { env: senv, homedir }), { keepAlive: true });
  t.after(() => c.stop());
  await c.start();
  const link = c.links[0].engine;
  for (let i = 0; i < 50 && link.link.status().state === "pending"; i++) await sleep(100);
  assert.equal(link.link.status().name, "me-alice");
});

test("identity: an interrupted install is completed from its token; anything else incomplete is kept and refused", async (t) => {
  const setup = () => {
    const home = tmp(t, "hoptell-lr-");
    const o = { home, homedir: tmp(t, "hoptell-lrh-"), platform: "linux", run: fakeRunner().run, port: 7791, ...offline };
    return { o, dir: path.join(home, "local-relay") };
  };
  // Token written, members file not yet: the same token, a members file made from it.
  {
    const { o, dir } = setup();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "token"), `${"a".repeat(64)}\n`, { mode: 0o600 });
    await installLocalRelay(o);
    assert.equal(fs.readFileSync(path.join(dir, "token"), "utf8").trim(), "a".repeat(64), "the token is kept");
    const members = JSON.parse(fs.readFileSync(path.join(dir, "members.json"), "utf8")).members;
    assert.equal(members.length, 1);
    assert.equal(members[0].name, "me");
  }
  // A members file without its token: refused, the file left as it was.
  {
    const { o, dir } = setup();
    await installLocalRelay(o);
    const before = fs.readFileSync(path.join(dir, "members.json"), "utf8");
    fs.rmSync(path.join(dir, "token"));
    await assert.rejects(installLocalRelay(o), /token file .* is missing: restore it, or start over with hoptell local-relay uninstall --purge/);
    assert.equal(fs.readFileSync(path.join(dir, "members.json"), "utf8"), before, "no other identity issued");
    assert.equal(fs.existsSync(path.join(dir, "token")), false);
  }
  // A token that does not match the members file: refused.
  {
    const { o, dir } = setup();
    await installLocalRelay(o);
    fs.writeFileSync(path.join(dir, "token"), `${"b".repeat(64)}\n`);
    await assert.rejects(installLocalRelay(o), /does not match its token file/);
    assert.equal(fs.readFileSync(path.join(dir, "token"), "utf8").trim(), "b".repeat(64));
  }
  // Realm state without its members file: refused (a new member id would not own that state).
  {
    const { o, dir } = setup();
    fs.mkdirSync(path.join(dir, "state"), { recursive: true });
    fs.writeFileSync(path.join(dir, "state", "realm.json"), "{}");
    await assert.rejects(installLocalRelay(o), /members file .* is missing but its realm state exists/);
    assert.equal(fs.existsSync(path.join(dir, "token")), false);
  }
});

test("simultaneous installs: one identity, one install id, one relays entry", async (t) => {
  const home = tmp(t, "hoptell-lr-");
  const homedir = tmp(t, "hoptell-lrh-");
  const relaysFile = path.join(homedir, "relays.json");
  const o = { home, homedir, platform: "linux", run: fakeRunner().run, port: 7792, ...offline, verify: () => sleep(50), relaysFile, env: {} };
  const rs = await Promise.all([installLocalRelay(o), installLocalRelay(o), installLocalRelay(o)]);
  assert.deepEqual(new Set(rs.map((r) => r.alias)), new Set(["local"]));
  const doc = JSON.parse(fs.readFileSync(relaysFile, "utf8"));
  assert.equal(doc.relays.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, "local-relay", "members.json"), "utf8")).members.length, 1);
  assert.equal(doc.relays[0].installId, JSON.parse(fs.readFileSync(path.join(home, "local-relay", "local-relay.json"), "utf8")).installId);
});

test("a new port moves an unchanged relays entry; an edited one is refused before anything changes; no --port keeps the port", async (t) => {
  const home = tmp(t, "hoptell-lr-");
  const homedir = tmp(t, "hoptell-lrh-");
  const relaysFile = path.join(homedir, "relays.json");
  const fake = fakeRunner();
  const o = { home, homedir, platform: "linux", run: fake.run, ...offline, relaysFile, env: {} };
  const read = () => JSON.parse(fs.readFileSync(relaysFile, "utf8"));
  await installLocalRelay({ ...o, port: 7793 });
  const r = await installLocalRelay(o);
  assert.equal(r.url, "ws://127.0.0.1:7793", "an omitted --port keeps the installed one");
  await installLocalRelay({ ...o, port: 7794 });
  assert.equal(read().relays[0].url, "ws://127.0.0.1:7794");
  const doc = read();
  doc.relays[0].profile = "mine";
  fs.writeFileSync(relaysFile, JSON.stringify(doc));
  const unit = fs.readFileSync(path.join(homedir, ".config", "systemd", "user", UNIT), "utf8");
  const calls = fake.calls.length;
  await assert.rejects(installLocalRelay({ ...o, port: 7795 }), /was changed since install, so it is not moved/);
  assert.equal(fs.readFileSync(path.join(homedir, ".config", "systemd", "user", UNIT), "utf8"), unit, "the service is unchanged");
  assert.ok(fake.calls.slice(calls).every((c) => /is-active|show/.test(c)), "the service was not restarted");
  assert.equal(read().relays[0].url, "ws://127.0.0.1:7794");
  // Uninstall finds the entry at the URL it really has (here edited, so it stays).
  const u = await uninstallLocalRelay(o);
  assert.equal(u.entryRemoved, false);
});

test("the default entry made from today's settings keeps HOPTELL_PROFILE", async (t) => {
  const homedir = tmp(t, "hoptell-lrh-");
  const relaysFile = path.join(homedir, "relays.json");
  await installLocalRelay({ home: tmp(t, "hoptell-lr-"), homedir, platform: "linux", run: fakeRunner().run, port: 7796, ...offline, relaysFile, env: { HOPTELL_RELAY: "wss://team.example.com", HOPTELL_AUTH: "login", HOPTELL_PROFILE: "work" } });
  assert.deepEqual(JSON.parse(fs.readFileSync(relaysFile, "utf8")).relays[0], { alias: "default", url: "wss://team.example.com", auth: "login", profile: "work" });
});

test("uninstall never leaves a relays file without relays", async (t) => {
  // Created by install, ours alone: removed with the entry.
  {
    const homedir = tmp(t, "hoptell-lrh-");
    const relaysFile = path.join(homedir, "relays.json");
    const o = { home: tmp(t, "hoptell-lr-"), homedir, platform: "linux", run: fakeRunner().run, port: 7797, ...offline, relaysFile, env: {} };
    await installLocalRelay(o);
    const u = await uninstallLocalRelay(o);
    assert.equal(u.entryRemoved, true);
    assert.equal(fs.existsSync(relaysFile), false);
  }
  // The user's own file that holds only our entry: the entry stays, with a note.
  {
    const homedir = tmp(t, "hoptell-lrh-");
    const relaysFile = path.join(homedir, "relays.json");
    fs.writeFileSync(relaysFile, JSON.stringify({ version: 1, relays: [{ alias: "team", url: "wss://team.example.com", tokenEnv: "T" }] }), { mode: 0o600 });
    const o = { home: tmp(t, "hoptell-lr-"), homedir, platform: "linux", run: fakeRunner().run, port: 7797, ...offline, relaysFile, env: {} };
    await installLocalRelay(o);
    const doc = JSON.parse(fs.readFileSync(relaysFile, "utf8"));
    doc.relays = doc.relays.filter((r) => r.alias !== "team");
    fs.writeFileSync(relaysFile, JSON.stringify(doc));
    const u = await uninstallLocalRelay(o);
    assert.equal(u.entryRemoved, false);
    assert.match(u.note, /would be left empty/);
    assert.equal(JSON.parse(fs.readFileSync(relaysFile, "utf8")).relays.length, 1);
  }
});

test("macOS stop unloads the job (KeepAlive would restart a killed one); start loads it again", async (t) => {
  const fake = fakeRunner();
  const o = { home: tmp(t, "hoptell-lr-"), homedir: tmp(t, "hoptell-lrh-"), platform: "darwin", uid: 501, run: fake.run, port: 7786, ...offline };
  const r = await installLocalRelay(o);
  await controlLocalRelay(o, "stop");
  assert.ok(fake.calls.includes(`launchctl bootout gui/501/${LABEL}`));
  assert.ok(!fake.calls.some((c) => c.startsWith("launchctl kill")));
  assert.equal(fake.st.loaded, false);
  await controlLocalRelay(o, "start");
  assert.equal(fake.st.loaded, true);
  assert.equal(fake.calls.at(-1), `launchctl bootstrap gui/501 ${r.service}`);
  await controlLocalRelay(o, "start"); // already loaded: kickstart, no error
  assert.equal(fake.calls.at(-1), `launchctl kickstart gui/501/${LABEL}`);
});

test("a reinstall replaces the running instance, and fails when the old one keeps running", async (t) => {
  for (const platform of ["linux", "darwin"]) {
    const home = tmp(t, "hoptell-lr-");
    const homedir = tmp(t, "hoptell-lrh-");
    const fake = fakeRunner();
    const o = { home, homedir, platform, uid: 501, run: fake.run, port: 7787, ...offline };
    await installLocalRelay(o);
    const first = fake.st.pid;
    await installLocalRelay(o);
    assert.notEqual(fake.st.pid, first, `${platform}: a new instance`);
    const stuck = fakeRunner({ samePid: true });
    const o2 = { ...o, home: tmp(t, "hoptell-lr-"), run: stuck.run };
    await installLocalRelay(o2);
    if (platform === "linux") await assert.rejects(installLocalRelay(o2), /previous instance \(pid \d+\) is still running/);
  }
  // Nothing running after the start: an error, not success.
  const run = (cmd, args) => (args.includes("show") ? { status: 0, stdout: "0\n", stderr: "" } : { status: 0, stdout: "", stderr: "" });
  await assert.rejects(installLocalRelay({ home: tmp(t, "hoptell-lr-"), homedir: tmp(t, "hoptell-lrh-"), platform: "linux", run, port: 7787, ...offline }), /not running after its start; check its log with journalctl --user -u hoptell-local-relay\.service$/);
});

test("uninstall keeps everything when the service cannot be stopped, and can be run again", async (t) => {
  for (const platform of ["linux", "darwin"]) {
    const home = tmp(t, "hoptell-lr-");
    const homedir = tmp(t, "hoptell-lrh-");
    const relaysFile = path.join(homedir, "relays.json");
    const fake = fakeRunner();
    const o = { home, homedir, platform, uid: 501, run: fake.run, port: 7785, ...offline, relaysFile, env: {} };
    const r = await installLocalRelay(o);
    const failing = fakeRunner({ failRemove: true });
    failing.st.loaded = true;
    failing.st.pid = 5;
    await assert.rejects(uninstallLocalRelay({ ...o, run: failing.run }, { purge: true }), /could not be stopped.*nothing was removed/);
    assert.ok(fs.existsSync(r.service), `${platform}: the service file stays`);
    assert.ok(fs.existsSync(relaysFile), "the relays entry stays");
    assert.ok(fs.existsSync(path.join(home, "local-relay", "local-relay.json")), "the install record stays");
    assert.ok(fs.existsSync(path.join(home, "local-relay", "token")), "nothing purged");
    const u = await uninstallLocalRelay(o, { purge: true });
    assert.equal(u.removed, true);
    assert.equal(fs.existsSync(path.join(home, "local-relay")), false);
    if (platform === "linux") assert.equal(fake.calls.at(-1), "systemctl --user daemon-reload", "reloaded after the unit file is gone");
  }
});

test("status: answering is not enough, the token must sign in", async (t) => {
  const o = { home: tmp(t, "hoptell-lr-"), homedir: tmp(t, "hoptell-lrh-"), platform: "linux", run: fakeRunner().run, port: 7784, ...offline };
  await installLocalRelay(o);
  const st = await localRelayStatus({ ...o, fetch: async () => ({ ok: true }), verify: async () => { throw new Error("bad token"); } });
  assert.equal(st.healthy, true);
  assert.equal(st.signedIn, false);
  assert.match(st.problems.join("\n"), /token does not sign in \(bad token\)/);
  const down = await localRelayStatus({ ...o, fetch: async () => { throw new Error("refused"); }, verify: async () => assert.fail("not tried while down") });
  assert.equal(down.signedIn, false);
  assert.equal((await localRelayStatus({ ...o, fetch: async () => ({ ok: true }) })).signedIn, true);
});

test("uninstall removes nothing when the service manager cannot tell whether the service stopped", async (t) => {
  for (const platform of ["linux", "darwin"]) {
    const home = tmp(t, "hoptell-lr-");
    const homedir = tmp(t, "hoptell-lrh-");
    const relaysFile = path.join(homedir, "relays.json");
    const fake = fakeRunner();
    const o = { home, homedir, platform, uid: 501, run: fake.run, port: 7783, ...offline, relaysFile, env: {} };
    const r = await installLocalRelay(o);
    // The manager is unreachable: removal and every state query fail.
    const broken = () => ({ status: 1, stdout: "", stderr: "Failed to connect to bus: No such file or directory" });
    await assert.rejects(uninstallLocalRelay({ ...o, run: broken }, { purge: true }), /could not confirm that the service stopped.*nothing was removed/);
    for (const f of [r.service, relaysFile, path.join(home, "local-relay", "token"), path.join(home, "local-relay", "local-relay.json")]) assert.ok(fs.existsSync(f), `${platform}: ${f} kept`);
    // A job already gone (an earlier uninstall stopped it) is not an obstacle.
    fake.st.loaded = false;
    if (platform === "linux") {
      // The final reload fails: an error, and the install record stays so that uninstall can run again.
      const noReload = (cmd, args) => (args.includes("daemon-reload") ? { status: 1, stdout: "", stderr: "Failed to reload" } : fake.run(cmd, args));
      await assert.rejects(uninstallLocalRelay({ ...o, run: noReload }), /reloading the user services failed.*run hoptell local-relay uninstall again/);
      assert.ok(fs.existsSync(path.join(home, "local-relay", "local-relay.json")));
    }
    const u = await uninstallLocalRelay(o, { purge: true });
    assert.equal(u.removed, true);
    assert.equal(fs.existsSync(path.join(home, "local-relay")), false);
    assert.equal(fs.existsSync(relaysFile), false, "the relays file install created is gone too");
  }
});

test("a relays file install created stays its own across an interruption: fail, retry, uninstall", async (t) => {
  const home = tmp(t, "hoptell-lr-");
  const homedir = tmp(t, "hoptell-lrh-");
  const relaysFile = path.join(homedir, "relays.json");
  const o = { home, homedir, platform: "linux", run: fakeRunner().run, port: 7782, ...offline, relaysFile, env: {} };
  await assert.rejects(installLocalRelay({ ...o, fault: (p) => { if (p === "relays entry written") throw new Error("EIO"); } }), /EIO/);
  assert.ok(fs.existsSync(relaysFile), "the relays file was written before the interruption");
  const token = fs.readFileSync(path.join(home, "local-relay", "token"), "utf8");
  await installLocalRelay(o);
  assert.equal(fs.readFileSync(path.join(home, "local-relay", "token"), "utf8"), token);
  assert.equal(JSON.parse(fs.readFileSync(relaysFile, "utf8")).relays.length, 1);
  const u = await uninstallLocalRelay(o, { purge: true });
  assert.equal(u.entryRemoved, true);
  assert.equal(u.note, null);
  assert.equal(fs.existsSync(relaysFile), false, "no relays file left pointing at a removed relay");
});
