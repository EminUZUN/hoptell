// Relay identity: realm file and lock, member ids and credential collisions.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { REALM_ID_RE, loadRealm, lockStateDir } from "../lib/realm.js";
import { MEMBER_ID_RE, newMemberId, startRelay } from "../lib/relay.js";
import { BIN } from "../lib/config.js";
import { TOKEN, fakeToken } from "./helpers.js";

const tmp = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hoptell-realm-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "state");
};
const posix = process.platform !== "win32";

test("the realm id is created once, kept, and never silently replaced", (t) => {
  const dir = tmp(t);
  const id = loadRealm(dir);
  assert.match(id, REALM_ID_RE);
  assert.equal(loadRealm(dir), id, "stable across starts");
  const file = path.join(dir, "realm.json");
  if (posix) {
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  }
  assert.equal(loadRealm(dir, id), id, "a matching override is fine");
  assert.throws(() => loadRealm(dir, "f".repeat(32)), /differs from the realm id already stored/);
  assert.throws(() => loadRealm(dir, "not-hex"), /32 lowercase hex/);
  // A seeded new realm.
  const seeded = tmp(t);
  assert.equal(loadRealm(seeded, "a".repeat(32)), "a".repeat(32));
  // A realm file missing from an established directory is refused, not recreated.
  const saved = fs.readFileSync(file);
  fs.rmSync(file);
  assert.throws(() => loadRealm(dir), /missing from an established state directory/);
  fs.writeFileSync(file, saved, { mode: 0o600 });
  assert.equal(loadRealm(dir), id);
  // Corrupt or unexpected files stop the relay instead of creating a new identity.
  fs.writeFileSync(file, "{broken");
  assert.throws(() => loadRealm(dir), /not valid JSON/);
  fs.writeFileSync(file, JSON.stringify({ v: 1, id: "short" }));
  assert.throws(() => loadRealm(dir), /valid realm id/);
  if (posix) {
    fs.writeFileSync(file, JSON.stringify({ v: 1, id }), { mode: 0o644 });
    fs.chmodSync(file, 0o644);
    assert.throws(() => loadRealm(dir), /open to other users/);
    fs.rmSync(file);
    fs.symlinkSync("/etc/hosts", file);
    assert.throws(() => loadRealm(dir), /not a regular file/);
    fs.rmSync(file);
    fs.chmodSync(dir, 0o755);
    assert.throws(() => loadRealm(dir), /open to other users/);
  }
});

test("a state directory reached through a symlink (systemd DynamicUser) is checked where it resolves", { skip: !posix }, (t) => {
  const base = path.dirname(tmp(t));
  const real = path.join(base, "private", "hoptell");
  fs.mkdirSync(real, { recursive: true, mode: 0o700 });
  fs.chmodSync(path.join(base, "private"), 0o700);
  const link = path.join(base, "hoptell");
  fs.symlinkSync(real, link);
  const id = loadRealm(link);
  assert.match(id, REALM_ID_RE);
  assert.equal(loadRealm(link), id, "stable across starts");
  assert.ok(fs.existsSync(path.join(real, "realm.json")), "the realm file is in the resolved directory");
  const release = lockStateDir(link);
  release();
  fs.chmodSync(real, 0o755);
  assert.throws(() => loadRealm(link), /open to other users/, "the resolved directory's mode is checked");
  fs.chmodSync(real, 0o700);
  const file = path.join(base, "plain-file");
  fs.writeFileSync(file, "x");
  const fileLink = path.join(base, "to-file");
  fs.symlinkSync(file, fileLink);
  assert.throws(() => loadRealm(fileLink), /EEXIST|not a directory/, "a symlink to a file is refused");
});

test("concurrent first starts agree on one realm id", async (t) => {
  const dir = tmp(t);
  const url = new URL("../lib/realm.js", import.meta.url).href;
  const script = `const { loadRealm } = await import(${JSON.stringify(url)}); process.stdout.write(loadRealm(${JSON.stringify(dir)}));`;
  const run = () =>
    new Promise((resolve) => {
      const p = spawn(process.execPath, ["--input-type=module", "-e", script]);
      let out = "";
      p.stdout.on("data", (d) => (out += d));
      p.on("exit", () => resolve(out));
    });
  const ids = await Promise.all(Array.from({ length: 6 }, run));
  assert.equal(new Set(ids).size, 1, `different realm ids: ${ids.join(", ")}`);
  assert.match(ids[0], REALM_ID_RE);
});

test("one relay per state directory; a stale lock is taken over", (t) => {
  const dir = tmp(t);
  const release = lockStateDir(dir);
  assert.throws(() => lockStateDir(dir), /already uses the state directory/);
  release();
  const again = lockStateDir(dir);
  again();
  // A lock left by a process that ended.
  fs.writeFileSync(path.join(dir, "relay.lock"), "999999999\n", { mode: 0o600 });
  const taken = lockStateDir(dir);
  assert.equal(fs.readFileSync(path.join(dir, "relay.lock"), "utf8").trim(), String(process.pid));
  taken();
});

test("the relay command keeps its realm across restarts and refuses a second relay on the same state", async (t) => {
  const dir = tmp(t);
  const empty = path.join(path.dirname(dir), "empty.env");
  fs.writeFileSync(empty, "");
  const start = (extra = {}) =>
    new Promise((resolve) => {
      const p = spawn(process.execPath, [BIN, "relay", "--host", "127.0.0.1", "--port", "0", "--realm-name", "team"], { env: { ...process.env, HOPTELL_ENV: empty, HOPTELL_TOKEN: TOKEN, HOPTELL_STATE_DIR: dir, ...extra } });
      let out = "";
      const done = (code) => resolve({ p, out, code });
      p.stdout.on("data", (d) => {
        out += d;
        if (/listening/.test(out)) done(null);
      });
      p.stderr.on("data", (d) => (out += d));
      p.on("exit", (code) => done(code));
    });
  const a = await start();
  const realm = a.out.match(/realm: ([0-9a-f]{32}) "team"/)?.[1];
  assert.ok(realm, a.out);
  const b = await start();
  assert.notEqual(b.code, null, "a second relay on the same state directory must stop");
  assert.match(b.out, /already uses the state directory/);
  a.p.kill("SIGTERM");
  await new Promise((r) => a.p.on("exit", r));
  const c = await start();
  assert.match(c.out, new RegExp(`realm: ${realm}`), "the realm id survives a restart");
  c.p.kill("SIGTERM");
  await new Promise((r) => c.p.on("exit", r));
  assert.ok(!fs.existsSync(path.join(dir, "relay.lock")), "the lock is released on exit");
  const shared = await start({ HOPTELL_REQUIRE_MEMBERS: "1" });
  assert.notEqual(shared.code, null);
  assert.match(shared.out, /--require-members is set, so a shared HOPTELL_TOKEN is not allowed/);
});

test("member ids: generated format, legacy ids, and refused collisions", async (t) => {
  const id = newMemberId();
  assert.match(id, MEMBER_ID_RE);
  assert.notEqual(newMemberId(), id);
  const ok = await startRelay({ host: "127.0.0.1", port: 0, members: [{ name: "alice", id, token: fakeToken() }, { name: "bob", token: fakeToken() }], log: () => {} });
  await ok.close();
  const shared = fakeToken();
  const same = fakeToken();
  const bad = [
    [{ members: [{ name: "alice", id: "m_bad", token: fakeToken() }] }, /invalid id/],
    [{ members: [{ name: "alice", id, token: fakeToken() }, { name: "bob", id, token: fakeToken() }] }, /used twice/],
    [{ members: [{ name: "alice", token: same }, { name: "bob", token: same }] }, /also used by "alice"/],
    [{ token: shared, members: [{ name: "alice", token: shared }] }, /also used by the shared token/],
    [{ token: shared, requireMembers: true, members: [{ name: "alice", token: fakeToken() }] }, /require-members/],
  ];
  for (const [opts, err] of bad) await assert.rejects(async () => startRelay({ host: "127.0.0.1", port: 0, log: () => {}, ...opts }), err);
  // A reload with a colliding list keeps the current one.
  const relay = await startRelay({ host: "127.0.0.1", port: 0, members: [{ name: "alice", token: same }], log: () => {} });
  t.after(() => relay.close());
  assert.throws(() => relay.reload([{ name: "alice", token: same }, { name: "bob", token: same }]), /also used by/);
});

test("a relay whose state directory is a symlink (systemd DynamicUser) records owner app ids, and its admin commands work there", { skip: !posix }, async (t) => {
  const { RelayClient } = await import("../lib/client.js");
  const { execFile } = await import("node:child_process");
  const base = path.dirname(tmp(t));
  const real = path.join(base, "private", "hoptell");
  fs.mkdirSync(real, { recursive: true, mode: 0o700 });
  fs.chmodSync(path.join(base, "private"), 0o700);
  const link = path.join(base, "hoptell");
  fs.symlinkSync(real, link);
  const empty = path.join(base, "empty.env");
  fs.writeFileSync(empty, "");
  const members = path.join(base, "members.json");
  const env = { ...process.env, HOPTELL_ENV: empty, HOPTELL_TOKEN: "", HOPTELL_STATE_DIR: link, HOPTELL_MEMBERS: members, HOPTELL_OWNER_APP: "on", XDG_CONFIG_HOME: path.join(base, "xdg") };
  for (const k of ["HOPTELL_POLICY", "HOPTELL_OIDC", "HOPTELL_EXPERIMENTAL_E2EE"]) delete env[k];
  const cli = (args) => new Promise((resolve) => execFile(process.execPath, [BIN, ...args], { env, timeout: 30_000 }, (err, stdout, stderr) => resolve({ code: err ? (err.code ?? 1) : 0, out: stdout + stderr })));
  // A members change is recorded in the audit log under the symlinked state directory.
  const added = await cli(["members", "add", "me"]);
  assert.equal(added.code, 0, added.out);
  const token = added.out.match(/shown only now:\s+(\S+)/)?.[1];
  assert.ok(token, "the new member's token is printed");

  const p = spawn(process.execPath, [BIN, "relay", "--host", "127.0.0.1", "--port", "0"], { env });
  let out = "";
  p.stdout.on("data", (d) => (out += d));
  p.stderr.on("data", (d) => (out += d));
  const exited = new Promise((r) => p.on("exit", r));
  t.after(() => p.exitCode === null && p.signalCode === null && p.kill("SIGKILL"));
  for (let i = 0; i < 100 && !/listening on [^\n]*:(\d+)/.test(out) && p.exitCode === null; i++) await new Promise((r) => setTimeout(r, 50));
  const port = Number(out.match(/listening on [^\n]*:(\d+)/)?.[1]);
  assert.ok(port, out);

  const c = new RelayClient({ url: `ws://127.0.0.1:${port}`, token, name: "me-owner", reconnect: false });
  await c.start().ready(5000);
  const app = "abcdefghijklmnopqrstuvwxyz";
  const r = await c.rpc({ type: "app_register", app });
  assert.equal(r.state, "on");
  c.close();
  assert.ok(fs.existsSync(path.join(real, "apps.json")), "apps.json is written in the resolved directory");
  // The running relay answers on its admin socket through the symlinked path.
  const online = await cli(["relay", "admin", "status"]);
  assert.equal(online.code, 0, online.out);
  p.kill("SIGTERM");
  await exited;
  assert.doesNotMatch(out, /could not be written|not a plain directory/, out);
  assert.ok(!fs.existsSync(path.join(real, "relay.lock")), "the lock is released on exit");

  // With the relay stopped, the offline commands take the same lock and see the same files.
  const apps = await cli(["relay", "apps"]);
  assert.equal(apps.code, 0, apps.out);
  assert.match(apps.out, new RegExp(`^${app}  on  member `, "m"));
  const retired = await cli(["relay", "apps", "--retire", app.slice(0, 6)]);
  assert.equal(retired.code, 0, retired.out);
  assert.match((await cli(["relay", "apps"])).out, new RegExp(`^${app}  retired`, "m"));
  const offline = await cli(["relay", "admin", "status"]);
  assert.equal(offline.code, 0, offline.out);
});
