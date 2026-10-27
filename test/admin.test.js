// The relay admin (design 4.4): the admin socket (its folder and file modes, its protocol and
// limits), the CLI's online and offline modes, read views (paging, never a token or a digest,
// grants entries audited, cached counts), the intent and result protocol of the members commands
// (refused intent, unknown outcome after a crash, failed reload), unannounced changes, and the
// relay's own security events.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createAccess, loadPolicy } from "../lib/access.js";
import { MAX_CONNECTIONS, adminRequest, createAdmin, socketPath, startAdminSocket } from "../lib/admin.js";
import { startAdminUi } from "../lib/adminui.js";
import { SECURITY_HEADERS } from "../lib/loopbackui.js";
import { loadMembersAndHosts, loadMembersFile, revokeMember } from "../lib/members.js";
import { auditedChange } from "../lib/admincli.js";
import { loadRealm, lockStateDir } from "../lib/realm.js";
import { newMemberId, startRelay } from "../lib/relay.js";
import { RELAY_MIGRATIONS, openRelayStore } from "../lib/relaystore.js";
import { createDeviceDirectory } from "../lib/mls/relaydir.js";
import { displayFingerprint, pinIdentity } from "../lib/mls/identity.js";
import { RelayClient } from "../lib/client.js";
import { sleep } from "./helpers.js";
import { DEV, ID, cli, enroll, membersFile, tmp } from "./restore-helpers.js";

const TOKENS = { alice: crypto.randomBytes(16).toString("hex"), bob: crypto.randomBytes(16).toString("hex") };

/** A running relay with its store, access state and admin socket, as bin/hoptell.js wires them. */
async function adminRelay(t, { extraMembers = 0, socket = true, wrap = (a) => a, policy = null } = {}) {
  const root = tmp(t, "hoptell-adm-");
  const state = path.join(root, "state");
  const members = membersFile(root);
  // Plain tokens for alice and bob so clients can sign in (the file stores them as the admin chose).
  const doc = JSON.parse(fs.readFileSync(members, "utf8"));
  doc.members[0].token = TOKENS.alice;
  doc.members[1].token = `sha256:${crypto.createHash("sha256").update(TOKENS.bob).digest("hex")}`;
  for (let i = 0; i < extraMembers; i++) doc.members.push({ name: `m${i}`, id: newMemberId(), token: `sha256:${crypto.randomBytes(32).toString("hex")}` });
  fs.writeFileSync(members, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 });
  const policyFile = policy ? path.join(root, "policy.json") : null;
  if (policy) fs.writeFileSync(policyFile, JSON.stringify(policy));
  const release = lockStateDir(state);
  t.after(() => release());
  const realm = loadRealm(state);
  const db = openRelayStore({ dir: state, fullfsync: false });
  t.after(() => db.close());
  const access = createAccess({ stateDir: state, policy: policyFile ? loadPolicy(policyFile) : null });
  const readMembers = () => loadMembersFile(members);
  let admin = null;
  const relay = await startRelay({ host: "127.0.0.1", port: 0, members: readMembers(), realm: { id: realm }, access, audit: (a, d) => admin?.securityEvent(a, d), extraStats: () => ({ auditDropped: admin?.auditDropped() ?? 0 }), log: () => {} });
  t.after(() => relay.close());
  admin = createAdmin({ stateDir: state, db, realm, relay, access, config: { members, policy: policyFile }, apply: { readMembers, members: (l) => relay.reload(l), policy: (p) => access.setPolicy(p) } });
  let sock = null;
  if (socket) {
    sock = await startAdminSocket({ stateDir: state, admin: wrap(admin), idleMs: 500 });
    t.after(() => sock.close());
  }
  const env = { HOPTELL_MEMBERS: members, ...(policyFile ? { HOPTELL_POLICY: policyFile } : {}) };
  return { root, state, members, db, realm, access, relay, admin, sock, env, run: (args, extra = {}) => cli(args, { stateDir: state, env: { ...env, ...extra } }) };
}
const rows = (db) => db.all("SELECT seq, actor, action, target, state, result, detail, ref FROM admin_audit ORDER BY seq").map((r) => ({ ...r, detail: JSON.parse(r.detail) }));
/** Send raw text to the socket; resolves with every line answered until the server closes or `ms` passes. */
function raw(state, text, ms = 400) {
  return new Promise((resolve) => {
    const s = net.createConnection(socketPath(state));
    let buf = "";
    s.on("connect", () => s.write(text));
    s.on("data", (d) => (buf += d));
    s.on("error", () => {});
    const done = () => resolve({ lines: buf.split("\n").filter(Boolean).map((l) => JSON.parse(l)), closed: s.destroyed || s.readableEnded });
    s.on("close", () => done());
    setTimeout(() => (s.destroy(), done()), ms);
  });
}

test("admin socket: a 0700 folder and a 0600 socket; a folder open to others refuses the start", { skip: process.platform === "win32" }, async (t) => {
  const w = await adminRelay(t);
  assert.equal(fs.statSync(path.join(w.state, "admin")).mode & 0o777, 0o700);
  assert.equal(fs.lstatSync(socketPath(w.state)).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(w.state, "admin")).uid, process.getuid());
  await w.sock.close();
  fs.chmodSync(path.join(w.state, "admin"), 0o755);
  await assert.rejects(startAdminSocket({ stateDir: w.state, admin: w.admin }), /open to other users; run: chmod 700/);
});

test("admin socket protocol: strict requests (no credentials ride along), 16 KB, 4 connections, idle timeout", async (t) => {
  const w = await adminRelay(t);
  // A member token is not an admin credential: a request carrying one is refused as malformed.
  const withToken = await raw(w.state, `${JSON.stringify({ v: 1, id: 1, op: "status", args: {}, token: TOKENS.alice })}\n`);
  assert.deepEqual(withToken.lines[0].error.code, "bad_request");
  const ok = await raw(w.state, `${JSON.stringify({ v: 1, id: "a", op: "status", args: {} })}\n`);
  assert.equal(ok.lines[0].ok, true);
  assert.equal(ok.lines[0].id, "a");
  assert.equal((await raw(w.state, "not json\n")).lines[0].error.code, "bad_request");
  assert.equal((await raw(w.state, `${JSON.stringify({ v: 2, id: 1, op: "status" })}\n`)).lines[0].error.code, "bad_request");
  assert.equal((await raw(w.state, `${JSON.stringify({ v: 1, id: 1, op: "nope", args: {} })}\n`)).lines[0].error.code, "bad_request");
  const big = await raw(w.state, "x".repeat(17 * 1024));
  assert.equal(big.lines[0].error.code, "too_large");
  // Four connections at most: a fifth is closed at once.
  const held = [];
  for (let i = 0; i < MAX_CONNECTIONS; i++) {
    const s = net.createConnection(socketPath(w.state));
    s.on("error", () => {});
    await new Promise((r) => s.on("connect", r));
    held.push(s);
  }
  await sleep(50);
  const fifth = await raw(w.state, `${JSON.stringify({ v: 1, id: 5, op: "status", args: {} })}\n`, 300);
  assert.deepEqual(fifth.lines, [], "no answer for the fifth");
  // Idle connections are closed (60 s in the relay; 500 ms here).
  await sleep(700);
  assert.ok(held.every((s) => s.destroyed || s.readableEnded || s.closed), "idle connections closed");
  for (const s of held) s.destroy();
  assert.equal((await raw(w.state, `${JSON.stringify({ v: 1, id: 6, op: "status", args: {} })}\n`)).lines[0].ok, true, "room again");
});

test("admin socket: a request that runs longer than the idle timeout keeps its connection and gets its answer", async (t) => {
  const w = await adminRelay(t, { wrap: (a) => ({ ...a, call: async (op, args, o) => (op === "store" ? (await sleep(900), a.call(op, args, o)) : a.call(op, args, o)) }) });
  const r = await raw(w.state, `${JSON.stringify({ v: 1, id: 1, op: "store", args: {} })}\n`, 1500);
  assert.equal(r.lines[0]?.ok, true, "answered after 900 ms with a 500 ms idle timeout");
  await sleep(700);
  const idle = await raw(w.state, "", 800);
  assert.equal(idle.closed, true, "an idle connection is still closed");
});

test("CLI modes: online over the socket; refused offline while the relay holds the lock; restore refused while it runs", async (t) => {
  const w = await adminRelay(t);
  const st = await w.run(["relay", "admin", "status"]);
  assert.equal(st.code, 0, st.stderr);
  assert.match(st.stdout, /relay running for \d+s, auth members/);
  assert.match((await w.run(["relay", "admin", "restore", "/nonexistent"])).stderr, /restore runs only while it is stopped/);
  // The lock is held (this process) but nothing answers on the socket: refused, never opened.
  await w.sock.close();
  const r = await w.run(["relay", "admin", "members"]);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /the relay is running: use the admin socket/);
  assert.match((await w.run(["members", "add", "dora"])).stderr, /the relay is running: use the admin socket/);
  assert.equal(loadMembersFile(w.members).some((m) => m.name === "dora"), false, "the file is not touched");
});

test("members view: never a token or a digest; tokenPresent and tokenFormat; sessions and quota; paged by 256", async (t) => {
  const w = await adminRelay(t, { extraMembers: 300 });
  const c = new RelayClient({ url: `ws://127.0.0.1:${w.relay.port}`, token: TOKENS.alice, name: "alice", mode: "peer", reconnect: false });
  t.after(() => c.close());
  await c.start().ready(5000);
  const first = await adminRequest(w.state, "members");
  assert.equal(first.rows.length, 256);
  assert.equal(first.next, "256");
  const second = await adminRequest(w.state, "members", { cursor: first.next });
  assert.equal(second.rows.length, 303 - 256);
  assert.equal(second.next, null);
  const alice = first.rows.find((m) => m.name === "alice");
  assert.deepEqual([alice.tokenPresent, alice.tokenFormat, alice.sessions], [true, "plain", 1]);
  assert.equal(first.rows.find((m) => m.name === "bob").tokenFormat, "hashed");
  const out = await w.run(["relay", "admin", "members", "--json"]);
  assert.equal(out.code, 0, out.stderr);
  assert.equal(JSON.parse(out.stdout).length, 303, "the CLI follows every page");
  const text = (await w.run(["relay", "admin", "members"])).stdout + out.stdout + JSON.stringify(first) + JSON.stringify(second);
  for (const secret of [TOKENS.alice, TOKENS.bob, crypto.createHash("sha256").update(TOKENS.bob).digest("hex"), "sha256:"]) assert.equal(text.includes(secret), false, "no token or digest is printed");
});

test("grants views: summaries without entries; --entries is audited first and refused when it cannot be recorded", async (t) => {
  const w = await adminRelay(t);
  w.access.putGrants(ID.alice, 0, { default: "deny", visible: "all", entries: [{ selector: `member:${ID.bob}`, action: "allow" }] });
  const sum = await w.run(["relay", "admin", "grants", "--json"]);
  const g = JSON.parse(sum.stdout).find((x) => x.member === ID.alice);
  assert.deepEqual([g.default, g.entries, g.revision, g.pending], ["deny", 1, 1, false]);
  assert.equal(sum.stdout.includes(ID.bob), false, "no entry in the summary");
  assert.match((await w.run(["relay", "admin", "grants", "--entries"])).stderr, /needs --member/);
  const e = await w.run(["relay", "admin", "grants", "--entries", "--member", "alice"]);
  assert.match(e.stdout, new RegExp(`allow member:${ID.bob}`));
  assert.deepEqual(rows(w.db).filter((r) => r.action === "grants.entries-read").map((r) => [r.actor, r.target, r.state]), [["socket", "alice", "done"]]);
  // An audit row that cannot be written: the entries are not read.
  const broken = createAdmin({ stateDir: w.state, db: { ...w.db, tx: () => { throw new Error("audit refused"); }, get: w.db.get, all: w.db.all }, realm: w.realm, access: w.access, config: { members: w.members } });
  await assert.rejects(broken.call("grants_entries", { member: "alice" }), /audit refused/);
});

test("store view: table counts come from the sweep's cache, with their age; checkpoint recorded after it runs", async (t) => {
  const w = await adminRelay(t);
  let s = await adminRequest(w.state, "store");
  assert.deepEqual(s.counts.admin_audit, { count: null, ageSeconds: null, cap: 100000 }, "never counted for a view");
  assert.equal(s.schema.version, RELAY_MIGRATIONS.length, "with phase 6's transfer tables and the later migrations");
  assert.match(s.instance, /^[0-9a-f]{32}$/);
  // WAL admission (design 6): the limits in force and nothing refused on an idle store.
  assert.deepEqual(s.admission.limits, { soft: 256 * 1024 * 1024, hard: 512 * 1024 * 1024, maintenanceBudget: 64 * 1024 * 1024 });
  assert.deepEqual(s.admission.refused, { bulk: false, progress: false, maintenance: false });
  assert.equal(s.size.autoVacuum, 2, "a new store has incremental auto-vacuum");
  assert.equal(s.schema.pageSize, 4096);
  await w.admin.maintain();
  s = await adminRequest(w.state, "store");
  assert.equal(s.counts.admin_audit.count, 0);
  for (const tb of ["e2ee_groups", "e2ee_log", "e2ee_queue", "e2ee_ops"]) assert.equal(s.counts[tb].count, 0, `3.3's ${tb}, from the cache too`);
  assert.match(s.counts.e2ee_queue.cap, /1000 messages and \d+ bytes per device/);
  assert.ok(s.counts.admin_audit.ageSeconds >= 0);
  const c = await w.run(["relay", "admin", "checkpoint"]);
  assert.match(c.stdout, /Checkpoint ok/);
  assert.equal(rows(w.db).at(-1).action, "store.checkpoint");
  assert.equal((await adminRequest(w.state, "store")).checkpoint.last.result, "ok");
});

test("members commands: intent, file edit, reload with the result; a token is shown only after the write", async (t) => {
  const w = await adminRelay(t);
  const add = await w.run(["members", "add", "dora"]);
  assert.equal(add.code, 0, add.stderr);
  assert.match(add.stdout, /The relay reloaded it\./);
  const token = /^ {2}([0-9a-f]{64})$/m.exec(add.stdout)[1];
  const r = rows(w.db);
  assert.deepEqual(r.map((x) => [x.action, x.state, x.result, x.target]), [["members.add", "intent", null, "dora"], ["members.add", "result", "ok", "dora"]]);
  assert.equal(r[1].ref, `intent:${r[0].seq}`);
  assert.deepEqual(r[1].detail, { added: 1, changed: 0, removed: 0 });
  // The relay applied it: the new member signs in.
  const c = new RelayClient({ url: `ws://127.0.0.1:${w.relay.port}`, token, name: "dora", mode: "send", reconnect: false });
  t.after(() => c.close());
  await c.start().ready(5000);
  // A refused command (no such member) writes nothing to the file and records failed.
  const before = fs.readFileSync(w.members);
  assert.match((await w.run(["members", "revoke", "nobody"])).stderr, /no member named "nobody"/);
  assert.deepEqual(fs.readFileSync(w.members), before);
  assert.deepEqual(rows(w.db).slice(-1).map((x) => [x.action, x.state, x.result, x.detail.code]), [["members.revoke", "result", "failed", "not_written"]]);
  // revocations list the member removal (the members file keeps no record of it).
  await w.run(["members", "revoke", "dora"]);
  assert.match((await w.run(["relay", "admin", "revocations"])).stdout, /member\tdora\tby socket/);
});

test("a refused intent leaves the members file unchanged; nothing is attempted", async (t) => {
  const w = await adminRelay(t, { wrap: (a) => ({ ...a, call: (op, args, o) => (op === "audit_intent" ? Promise.reject(Object.assign(new Error("audit refused"), { code: "unavailable" })) : a.call(op, args, o)) }) });
  const before = fs.readFileSync(w.members);
  const r = await w.run(["members", "add", "erin"]);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /audit refused/);
  assert.deepEqual(fs.readFileSync(w.members), before);
  assert.equal(/[0-9a-f]{64}/.test(r.stdout), false, "no token shown");
});

test("a crash between the file edit and the result: the next start records unknown with the state found", async (t) => {
  const root = tmp(t, "hoptell-adm-crash-");
  const state = path.join(root, "state");
  const members = membersFile(root);
  {
    const release = lockStateDir(state);
    const db = openRelayStore({ dir: state, fullfsync: false });
    const a = createAdmin({ stateDir: state, db, realm: null, config: { members } });
    await a.call("audit_intent", { action: "members.revoke", target: "carol" });
    await a.call("audit_intent", { action: "members.add", target: "frank" });
    db.close();
    release();
  }
  // The CLI edited the file for the first, then stopped; the second never reached the file.
  const doc = JSON.parse(fs.readFileSync(members, "utf8"));
  fs.writeFileSync(members, JSON.stringify({ members: doc.members.filter((m) => m.name !== "carol") }), { mode: 0o600 });
  const release = lockStateDir(state);
  t.after(release);
  const db = openRelayStore({ dir: state, fullfsync: false });
  t.after(() => db.close());
  const a = createAdmin({ stateDir: state, db, realm: null, config: { members } });
  assert.equal(a.settleOpenIntents("relay"), 2);
  assert.deepEqual(rows(db).filter((r) => r.state === "unknown").map((r) => [r.action, r.target, r.detail.observed]), [["members.revoke", "carol", "as_intended"], ["members.add", "frank", "not_as_intended"]]);
  assert.equal(a.settleOpenIntents("relay"), 0, "once");
});

test("an intent already settled as unknown is reported unknown to the CLI that reloads with it, never ok", async (t) => {
  const w = await adminRelay(t);
  const { intent } = await adminRequest(w.state, "audit_intent", { action: "members.revoke", target: "carol" });
  await adminRequest(w.state, "reload"); // another owner's reload, before the first CLI's file edit
  assert.equal(rows(w.db).find((r) => r.ref === `intent:${intent}`).state, "unknown");
  await revokeMember(w.members, "carol");
  const r = await adminRequest(w.state, "reload", { intent });
  assert.equal(r.result, "unknown");
  assert.deepEqual(rows(w.db).filter((x) => x.ref === `intent:${intent}`).map((x) => x.state), ["unknown"], "one outcome, never rewritten");
  assert.deepEqual(await adminRequest(w.state, "audit_result", { intent, result: "ok" }), { recorded: false, already: true, outcome: "unknown" });
});

test("the CLI edits only the members file the running relay uses: another file is refused before the intent", async (t) => {
  const w = await adminRelay(t);
  const other = path.join(w.root, "other-members.json");
  fs.copyFileSync(w.members, other);
  const before = fs.readFileSync(other);
  const audited = rows(w.db).length;
  const r = await w.run(["members", "revoke", "carol"], { HOPTELL_MEMBERS: other });
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /the running relay uses another members file/);
  assert.deepEqual(fs.readFileSync(other), before, "not edited");
  assert.equal(rows(w.db).length, audited, "no intent written");
  await assert.rejects(auditedChange({ stateDir: w.state, config: { members: other }, action: "members.revoke", target: "carol", change: () => revokeMember(other, "carol") }), /another members file/);
  // The same file by another path (a symlink) is the same file: the real file is edited, the link stays.
  const link = path.join(w.root, "members-link.json");
  fs.symlinkSync(w.members, link);
  const ok = await w.run(["members", "revoke", "carol"], { HOPTELL_MEMBERS: link });
  assert.equal(ok.code, 0, ok.stderr);
  assert.match(ok.stdout, /The relay reloaded it\./);
  assert.ok(fs.lstatSync(link).isSymbolicLink(), "the symlink is still a symlink");
  assert.equal(loadMembersFile(w.members).some((m) => m.name === "carol"), false, "the relay's own file changed");
  assert.equal((await adminRequest(w.state, "members", { member: "carol" })).rows.length, 0, "the live relay no longer has carol");
  assert.equal((await adminRequest(w.state, "members")).rows.length, 2);
  // The status names no path: a digest only.
  const st = await adminRequest(w.state, "status");
  assert.match(st.membersFile, /^[0-9a-f]{64}$/);
});

test("reload with an invalid file: refused with its error, the running list stays, the open intent gets a failed result", async (t) => {
  const w = await adminRelay(t);
  const { intent } = await adminRequest(w.state, "audit_intent", { action: "members.add", target: "x" });
  fs.writeFileSync(w.members, "{ not json", { mode: 0o600 });
  const r = await adminRequest(w.state, "reload", { intent });
  assert.equal(r.members.ok, false);
  assert.match(r.members.error, /invalid JSON/);
  assert.equal(r.result, "failed");
  const last = rows(w.db).filter((x) => x.ref === `intent:${intent}`);
  assert.deepEqual(last.map((x) => [x.state, x.result, x.detail.code]), [["result", "failed", "invalid_members"]]);
  assert.ok(rows(w.db).some((x) => x.action === "config.load-failed" && x.detail.file === "members"));
  // The running list stays: alice still signs in.
  const c = new RelayClient({ url: `ws://127.0.0.1:${w.relay.port}`, token: TOKENS.alice, name: "alice-cli", mode: "send", reconnect: false });
  t.after(() => c.close());
  await c.start().ready(5000);
});

test("changes no admin command announced are recorded at reload as counts; policy changes too", async (t) => {
  const w = await adminRelay(t, { policy: { v: 1, rules: [] } });
  const doc = JSON.parse(fs.readFileSync(w.members, "utf8"));
  doc.members = doc.members.filter((m) => m.name !== "carol");
  doc.members[0].signedOutAt = Date.now();
  fs.writeFileSync(w.members, JSON.stringify(doc), { mode: 0o600 });
  fs.writeFileSync(path.join(w.root, "policy.json"), JSON.stringify({ v: 1, rules: [], defaultAction: "deny" }));
  const r = await w.run(["relay", "admin", "reload"]);
  assert.equal(r.code, 0, r.stderr);
  const ev = rows(w.db).filter((x) => x.state === "event");
  assert.deepEqual(ev.map((x) => [x.action, x.actor]), [["policy.changed", "socket"], ["members.unannounced", "socket"]]);
  assert.deepEqual(ev[1].detail, { added: 0, changed: 1, removed: 1 });
  assert.equal((await adminRequest(w.state, "policy")).loaded.defaultAction, "deny");
  const check = await w.run(["relay", "admin", "policy", "check", "alice", "bob"]);
  assert.match(check.stdout, /^deny: the policy's default/);
});

test("policy check: labelled a static check by member ids; uncertain where sign-in (OIDC) groups take part", async (t) => {
  const w = await adminRelay(t, { policy: { v: 1, groups: { reviewers: { members: [], oidcGroups: [{ issuer: "https://idp.example", group: "reviewers" }] } }, rules: [{ from: "group:reviewers", to: "*", action: "allow" }], defaultAction: "deny" } });
  const r = await adminRequest(w.state, "policy_check", { from: "alice", to: "bob" });
  assert.deepEqual([r.action, r.rule, r.basis, r.certain], ["deny", "default", "member ids", false]);
  const out = await w.run(["relay", "admin", "policy", "check", "alice", "bob"]);
  assert.match(out.stdout, /^deny: the policy's default \(a static check by member ids; a signed-in session's provider groups can match other rules\)/);
  // Without sign-in groups in any rule, the static check is the answer.
  fs.writeFileSync(path.join(w.root, "policy.json"), JSON.stringify({ v: 1, rules: [{ from: `member:${ID.alice}`, to: "*", action: "allow" }], defaultAction: "deny" }));
  await adminRequest(w.state, "reload");
  assert.match((await w.run(["relay", "admin", "policy", "check", "alice", "bob"])).stdout, /^allow: rule 0 \(member:m_a+ -> \*\) \(a static check by member ids\)$/m);
});

test("security events of the relay: an admin device revocation is recorded; an event that cannot be written is counted", async (t) => {
  const w = await adminRelay(t);
  w.admin.securityEvent("devices.admin_revoked", { devices: 1 });
  assert.equal(rows(w.db).at(-1).action, "devices.admin_revoked");
  const broken = createAdmin({ stateDir: w.state, db: { ...w.db, tx: () => { throw new Error("full"); }, get: w.db.get, all: w.db.all, stat: w.db.stat }, realm: w.realm, config: {} });
  broken.securityEvent("broker.replay_revoked", { families: 1 });
  assert.equal(broken.auditDropped(), 1);
  assert.equal((await broken.call("metrics")).store.auditDropped, 1);
});

test("devices view and reinstate: suspended devices listed; reinstate is recorded with the change", async (t) => {
  const w = await adminRelay(t);
  const directory = createDeviceDirectory({ db: w.db, realm: w.realm });
  enroll(directory, w.realm, ID.alice, DEV.a1, 1);
  w.db.tx((h) => h.run("UPDATE devices SET suspended = 1"));
  const v = await w.run(["relay", "admin", "devices", "--json"]);
  const d = JSON.parse(v.stdout)[0];
  assert.deepEqual([d.name, d.device, d.suspended, d.revoked], ["alice", DEV.a1, true, null]);
  assert.match(d.fingerprint, /^(\d{5} ){11}\d{5}$/);
  const r = await w.run(["relay", "admin", "devices", "reinstate", "alice", DEV.a1]);
  assert.match(r.stdout, /in service again/);
  assert.deepEqual(rows(w.db).at(-1), { ...rows(w.db).at(-1), action: "devices.reinstate", target: `alice/${DEV.a1}`, result: "reinstated" });
  assert.equal(Number(w.db.get("SELECT suspended FROM devices").suspended), 0);
});

test("A12: hoptell members device-approve approves a pending device request over the admin channel, audited; the pending view and cancel too", async (t) => {
  const w = await adminRelay(t);
  const directory = createDeviceDirectory({ db: w.db, realm: w.realm });
  enroll(directory, w.realm, ID.alice, DEV.a1, 1);
  const key = Buffer.alloc(32, 2);
  assert.equal(directory.request({ member: ID.alice, device: DEV.a2, key }).state, "pending");
  const e2ee = { HOPTELL_EXPERIMENTAL_E2EE: "1" };
  const v = JSON.parse((await w.run(["relay", "admin", "devices", "pending", "--json"])).stdout);
  assert.deepEqual([v.length, v[0].name, v[0].device, v[0].approved], [1, "alice", DEV.a2, null]);
  const fp = displayFingerprint({ realm: w.realm, member: ID.alice, device: DEV.a2, key });
  assert.equal(v[0].fingerprint, fp);
  // A wrong fingerprint is refused, nothing recorded.
  const bad = await w.run(["members", "device-approve", "alice", DEV.a2, ..."11111 ".repeat(12).trim().split(" ")], e2ee);
  assert.notEqual(bad.code, 0);
  assert.match(bad.stderr, /fingerprint does not match/);
  assert.ok(!rows(w.db).some((r) => r.action === "devices.approve"));
  // The fingerprint as the new device shows it (12 groups, one argument or several).
  const r = await w.run(["members", "device-approve", "alice", DEV.a2, ...fp.split(" ")], e2ee);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /Approved device/);
  assert.deepEqual(rows(w.db).at(-1), { ...rows(w.db).at(-1), action: "devices.approve", target: `alice/${DEV.a2}`, result: "approved", actor: "socket" });
  assert.equal(directory.register({ member: ID.alice, device: DEV.a2, key, pin: pinIdentity({ realm: w.realm, member: ID.alice, device: DEV.a2, key }) }).approvedBy, "admin");
  // Cancel: audited, then the pair is blocked.
  const k3 = Buffer.alloc(32, 3);
  const d3 = `${"d".repeat(25)}a`;
  directory.request({ member: ID.alice, device: d3, key: k3 });
  const c = await w.run(["relay", "admin", "devices", "pending-cancel", "alice", d3]);
  assert.match(c.stdout, /Cancelled the pending request/);
  assert.equal(rows(w.db).at(-1).action, "devices.pending-cancel");
  assert.throws(() => directory.request({ member: ID.alice, device: d3, key: k3 }), (e) => e.code === "request_blocked");
});

test("offline: the CLI opens the store under the lock; status works through a restore fence, everything else is refused", async (t) => {
  const root = tmp(t, "hoptell-adm-off-");
  const state = path.join(root, "state");
  const members = membersFile(root);
  const run = (args) => cli(args, { stateDir: state, env: { HOPTELL_MEMBERS: members } });
  const add = await run(["members", "add", "gina"]);
  assert.match(add.stdout, /The relay applies it when it starts\./);
  const audit = await run(["relay", "admin", "audit"]);
  assert.match(audit.stdout, /offline-cli\tmembers\.add\tgina\tintent/);
  assert.match(audit.stdout, /offline-cli\tmembers\.add\tgina\tresult\tok/);
  assert.match(audit.stdout, /hash chain verified: 2 rows from the start/);
  fs.mkdirSync(path.join(state, "restore"), { mode: 0o700 });
  fs.writeFileSync(path.join(state, "restore", "intent.json"), JSON.stringify({ v: 1, id: "0123456789abcdef", phase: "evidence" }));
  assert.match((await run(["relay", "admin", "status"])).stdout, /unfinished 0123456789abcdef at evidence/);
  for (const args of [["relay", "admin", "members"], ["relay", "admin", "audit"], ["members", "add", "hank"], ["relay", "broker-reset", "--yes"], ["relay", "admin", "backup", path.join(root, "bk")]]) {
    const r = await run(args);
    assert.notEqual(r.code, 0, args.join(" "));
    assert.match(r.stderr, /unfinished restore \(0123456789abcdef, phase evidence\)/, args.join(" "));
  }
  assert.equal(loadMembersFile(members).some((m) => m.name === "hank"), false);
});

test("broker-reset is offline only and audited", async (t) => {
  const root = tmp(t, "hoptell-adm-br-");
  const state = path.join(root, "state");
  const r = await cli(["relay", "broker-reset", "--yes"], { stateDir: state });
  assert.equal(r.code, 0, r.stderr);
  const a = await cli(["relay", "admin", "audit"], { stateDir: state });
  assert.match(a.stdout, /relay\.broker-reset\t-\tintent/);
  assert.match(a.stdout, /relay\.broker-reset\t-\tresult\tok/);
});

// ---- the read-only UI ------------------------------------------------------------------------------

/** One HTTP request to the UI with an explicit Host header. */
function get(port, p, { method = "GET", host = `127.0.0.1:${port}`, cookie = null, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: p, method, headers: { host, ...(cookie ? { cookie } : {}), ...headers } }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("UI (3.4's shared gate): one origin, a single-use launch token, the session cookie, Sec-Fetch-Site, the 3.4 headers, visible escaping, no POST route", async (t) => {
  const w = await adminRelay(t);
  // A linked identity whose subject is markup with a bidi override: shown as text, the override visible.
  const doc = JSON.parse(fs.readFileSync(w.members, "utf8"));
  doc.members[0].oidc = [{ issuer: "https://idp.example", subject: "<script>alert(1)</script>\u202Eevil" }];
  fs.writeFileSync(w.members, JSON.stringify(doc), { mode: 0o600 });
  w.access.putGrants(ID.alice, 0, { default: "deny", visible: "all", entries: [{ selector: `member:${ID.bob}`, action: "allow" }] });
  let clock = Date.now();
  const ui = await startAdminUi({ stateDir: w.state, now: () => clock });
  t.after(() => ui.close());
  const { port } = ui;
  // A launch link expires after 60 seconds.
  const stale = new URL(ui.launchUrl());
  clock += 61_000;
  assert.equal((await get(port, stale.pathname + stale.search)).status, 403, "expired");
  const launch = new URL(ui.launchUrl());
  assert.equal(launch.origin, `http://127.0.0.1:${port}`);
  const noSession = await get(port, "/");
  assert.equal(noSession.status, 403, "no session: refused");
  assert.ok(noSession.body.includes('<meta name="viewport" content="width=device-width, initial-scale=1">'));
  assert.ok(noSession.body.includes("<h1>Refused</h1><p>Open the launch link that hoptell relay admin ui printed.</p>"), noSession.body);
  assert.equal((await get(port, `/launch?t=${"0".repeat(43)}`)).status, 403);
  assert.equal((await get(port, launch.pathname + launch.search, { host: `localhost:${port}` })).status, 403, "another host name for the same address");
  assert.equal((await get(port, launch.pathname + launch.search, { headers: { "sec-purpose": "prefetch" } })).status, 403, "a prefetch never burns the token");
  assert.equal((await get(port, launch.pathname + launch.search, { headers: { "sec-fetch-site": "cross-site" } })).status, 403, "not from another site");
  assert.notEqual((await get(port, launch.pathname + launch.search, { method: "HEAD" })).status, 303, "a HEAD (a link check) never consumes the token");
  const l = await get(port, launch.pathname + launch.search);
  assert.equal(l.status, 303);
  const setCookie = l.headers["set-cookie"][0];
  assert.match(setCookie, /^hoptell_relay_admin=[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Strict; Path=\/$/);
  assert.equal((await get(port, launch.pathname + launch.search)).status, 403, "the launch link works once");
  const cookie = setCookie.split(";")[0];
  for (const page of ["/", "/members", "/devices", "/policy", "/grants", "/revocations", "/metrics", "/store", "/audit"]) {
    const r = await get(port, page, { cookie });
    assert.equal(r.status, 200, page);
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) assert.equal(r.headers[k.toLowerCase()], v, `${page}: ${k}`);
    assert.equal(/<script/i.test(r.body), false, `${page}: no script, and markup in values is escaped`);
  }
  const membersPage = (await get(port, "/members", { cookie })).body;
  assert.match(membersPage, /&#60;script&#62;alert\(1\)&#60;\/script&#62;\\u202Eevil/, "escaped, the bidi override shown as \\u202E");
  assert.equal(membersPage.includes("\u202E"), false);
  assert.equal((await get(port, "/members", { cookie, headers: { "sec-fetch-site": "cross-site" } })).status, 403);
  const grants = (await get(port, "/grants", { cookie })).body;
  assert.equal(grants.includes(ID.bob), false, "grants entries are not shown");
  for (const method of ["POST", "PUT", "DELETE", "PATCH"]) assert.equal((await get(port, "/", { method, cookie })).status, 405, `${method}: no such route`);
  assert.equal((await get(port, "/", { host: "evil.example", cookie })).status, 403, "DNS rebinding: refused");
  assert.equal((await get(port, "/style.css")).headers["content-type"], "text/css; charset=utf-8");
  // A stopped relay: the page says so, nothing is opened.
  await w.sock.close();
  assert.match((await get(port, "/members", { cookie })).body, /The relay is not running/);
});

test("relay: a state directory too long for the admin socket stops startup before it says it is listening, naming the limit and the fix", async () => {
  const { spawnSync } = await import("node:child_process");
  const { default: os } = await import("node:os");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hoptell-sock-"));
  try {
    const state = path.join(dir, "s".repeat(Math.max(1, 110 - dir.length)));
    const bin = new URL("../bin/hoptell.js", import.meta.url).pathname;
    const r = spawnSync(process.execPath, [bin, "relay", "--host", "127.0.0.1", "--port", "0", "--state-dir", state], { env: { ...process.env, HOPTELL_TOKEN: "t".repeat(64), HOPTELL_MEMBERS: "" }, encoding: "utf8", timeout: 10_000 });
    assert.equal(r.status, 1, `${r.stdout}${r.stderr}`);
    assert.doesNotMatch(`${r.stdout}${r.stderr}`, /listening/);
    assert.match(r.stderr, /the admin socket's path ".+admin\.sock" is \d+ bytes; keep it within hoptell's 103-byte cross-platform limit for Unix socket paths by using a shorter state directory \(--state-dir or HOPTELL_STATE_DIR\)/);
    assert.equal(fs.existsSync(state), false, "nothing was created");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the running relay's admin reads systemd's LoadCredential copy (0440 in its credentials directory) as the relay does; without that context it stays strict", { skip: process.platform === "win32" }, async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hoptell-adm-cred-")));
  const state = path.join(root, "state");
  // The systemd layout, with this user standing in for root (`trust`): a 0440 copy in a 0550 directory.
  const creds = path.join(root, "run-credentials");
  const svc = path.join(creds, "hoptell-relay.service");
  fs.mkdirSync(svc, { recursive: true });
  const members = membersFile(svc);
  fs.chmodSync(members, 0o440);
  fs.chmodSync(svc, 0o550);
  t.after(() => {
    fs.chmodSync(svc, 0o700);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const membersRead = { credentialsDir: svc, trust: { rootUid: process.getuid(), root: creds } };
  const release = lockStateDir(state);
  t.after(() => release());
  const realm = loadRealm(state);
  const db = openRelayStore({ dir: state, fullfsync: false });
  t.after(() => db.close());
  const access = createAccess({ stateDir: state });
  const readMembers = () => loadMembersAndHosts(members, membersRead).members;
  const relay = await startRelay({ host: "127.0.0.1", port: 0, members: readMembers(), realm: { id: realm }, access, log: () => {} });
  t.after(() => relay.close());
  const admin = createAdmin({ stateDir: state, db, realm, relay, access, config: { members }, apply: { readMembers, members: (l) => relay.reload(l), policy: (p) => access.setPolicy(p) }, membersRead });
  const view = await admin.call("members");
  assert.deepEqual(view.rows.map((m) => m.name).sort(), ["alice", "bob", "carol"], "the members view reads the copy");
  assert.deepEqual((await admin.call("members", { member: "bob" })).rows.map((m) => m.id), [ID.bob]);
  assert.deepEqual((await admin.call("devices", { member: "alice" })).rows, [], "a member name resolves to its id");
  await admin.call("grants", { member: "carol" });
  // observe(): an open intent is settled with what the file shows, not "unreadable".
  await admin.call("audit_intent", { action: "members.add", target: "alice" });
  assert.equal(admin.settleOpenIntents("relay"), 1);
  assert.equal(rows(db).find((r) => r.state === "unknown").detail.observed, "as_intended");
  // The same file without the relay's credentials context (the offline tools): refused as before.
  const strict = createAdmin({ stateDir: state, db, realm, config: { members } });
  await assert.rejects(strict.call("members"), /holds tokens/);
  await assert.rejects(strict.call("devices", { member: "alice" }), /holds tokens/);
});
