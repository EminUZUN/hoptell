// `hoptell members` on the relay host, and doctor's realm and profile lines.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { startRelay } from "../lib/relay.js";
import { RelayClient } from "../lib/client.js";
import { HOSTNAME } from "../lib/config.js";
import { fakeToken, world } from "./helpers.js";

test("members add shows a token once and stores its hash; list, revoke and migrate keep the file valid", async (t) => {
  const w = await world();
  t.after(() => w.close());
  const file = path.join(w.home, "members.json");
  const env = { HOPTELL_MEMBERS: file };
  assert.match((await w.cli(["members", "list"], env)).stdout, /No members/);

  const added = await w.cli(["members", "add", "alice"], env);
  assert.equal(added.code, 0, added.stderr);
  const token = added.stdout.match(/^ {2}([0-9a-f]{64})$/m)[1];
  const id = added.stdout.match(/\((m_[a-z2-7]{26})\)/)[1];
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const doc = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(doc.members, [{ name: "alice", id, token: `sha256:${crypto.createHash("sha256").update(token).digest("hex")}` }]);
  assert.doesNotMatch(fs.readFileSync(file, "utf8"), new RegExp(token), "only the hash is stored");

  // The relay accepts the new member with the shown token.
  const relay = await startRelay({ host: "127.0.0.1", port: 0, members: doc.members, log: () => {} });
  t.after(() => relay.close());
  const c = new RelayClient({ url: `ws://127.0.0.1:${relay.port}`, token, name: null, mode: "send", reconnect: false });
  t.after(() => c.close());
  await c.start().ready();
  assert.deepEqual(c.member, { id, name: "alice" });
  assert.equal(c.name, `alice-${HOSTNAME}-cli`, "send-only: <member>-<host>-cli");

  // Refused changes leave the file as it was.
  const before = fs.readFileSync(file, "utf8");
  // The advice is true: revoking and adding again makes a new member id, it does not rotate the token.
  assert.match((await w.cli(["members", "add", "alice"], env)).stderr, /member "alice" already exists: choose another name\. Revoking and adding it again creates a new member id \(its sessions and grants do not carry over\)/);
  assert.match((await w.cli(["members", "add", "alice-2"], env)).stderr, /overlaps "alice"/);
  assert.match((await w.cli(["members", "add", "bad name"], env)).stderr, /invalid member name "bad name": a name is 1 to 64 letters, digits, "_" or "-", starting with a letter or digit/);
  assert.equal(fs.readFileSync(file, "utf8"), before);

  // A legacy record without an id: migrate reports first, then assigns one with --yes.
  doc.members.push({ name: "bob", token: fakeToken(), note: "kept" });
  fs.writeFileSync(file, JSON.stringify(doc), { mode: 0o600 });
  assert.match((await w.cli(["members", "list"], env)).stdout, /bob\t\(no id: run hoptell members migrate\)\tplain token/);
  const dry = await w.cli(["members", "migrate"], env);
  assert.match(dry.stdout, /without an id: bob[\s\S]*messages queued for them are dropped[\s\S]*--yes/);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).members[1].id, undefined);
  assert.match((await w.cli(["members", "migrate", "--yes"], env)).stdout, /Gave ids to: bob/);
  const bob = JSON.parse(fs.readFileSync(file, "utf8")).members[1];
  assert.match(bob.id, /^m_[a-z2-7]{26}$/);
  assert.equal(bob.note, "kept", "other fields are kept");

  assert.match((await w.cli(["members", "revoke", "--members", file, "alice"])).stdout, /Removed member "alice"/);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).members.map((m) => m.name), ["bob"]);
  assert.match((await w.cli(["members", "revoke", "carol"], env)).stderr, /no member named "carol"/);

  // A members file other users can read is refused.
  fs.chmodSync(file, 0o644);
  assert.match((await w.cli(["members", "list"], env)).stderr, /chmod 600/);
});

test("doctor shows the relay realm and whether this machine's profile agrees", async (t) => {
  const w = await world();
  t.after(() => w.close());
  const first = await w.cli(["doctor"]);
  assert.match(first.stdout, new RegExp(`ok +relay realm: ${w.relay.realm.id}; shared token`));
  assert.match(first.stdout, /relay profile: not pinned yet/);
  await w.cli(["list"]);
  assert.match((await w.cli(["doctor"])).stdout, /ok +relay profile: pinned to this realm/);
  // The profile now names another realm (as if the relay were replaced).
  const dir = path.join(w.home, "profiles");
  const [f] = fs.readdirSync(dir).filter((x) => x.endsWith(".json"));
  const rec = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
  fs.writeFileSync(path.join(dir, f), JSON.stringify({ ...rec, realm: "5".repeat(32) }), { mode: 0o600 });
  const changed = await w.cli(["doctor"]);
  assert.equal(changed.code, 1);
  assert.match(changed.stdout, /FAIL +relay profile: this profile's relay realm changed/);
});

test("a members file passed by systemd LoadCredential (0440 in its credentials directory) loads; nothing wider or elsewhere does", { skip: process.platform === "win32" }, async (t) => {
  const os = await import("node:os");
  const { loadMembersAndHosts } = await import("../lib/members.js");
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hoptell-creds-")));
  t.after(() => {
    for (const d of [svc, shared]) if (fs.existsSync(d)) fs.chmodSync(d, 0o700);
    fs.rmSync(base, { recursive: true, force: true });
  });
  // The systemd layout, with this user standing in for root (`trust`).
  const root = path.join(base, "run-credentials");
  const svc = path.join(root, "hoptell-relay.service");
  const shared = path.join(base, "shared");
  fs.mkdirSync(svc, { recursive: true });
  fs.mkdirSync(shared);
  const doc = JSON.stringify({ members: [{ name: "alice", token: fakeToken() }] });
  const put = (dir) => {
    const f = path.join(dir, "members.json");
    fs.writeFileSync(f, doc);
    fs.chmodSync(f, 0o440);
    fs.chmodSync(dir, 0o550);
    return f;
  };
  const file = put(svc);
  const other = put(shared);
  const trust = { rootUid: process.getuid(), root };
  const load = (f, credentialsDir) => loadMembersAndHosts(f, { credentialsDir, trust });
  assert.equal(load(file, svc).members.length, 1, "systemd's 0440 copy loads");
  assert.throws(() => load(file, null), /holds tokens/, "without the credentials directory, 0440 is refused");
  assert.throws(() => loadMembersAndHosts(file, { credentialsDir: svc }), /holds tokens/, "the default trust (root, /run/credentials) does not cover this test layout");
  assert.throws(() => load(other, shared), /holds tokens/, "a group-traversable directory outside the systemd root is refused");
  assert.throws(() => load(other, svc), /holds tokens/, "a file outside the credentials directory is refused");
  for (const mode of [0o040, 0o444, 0o460, 0o640, 0o450, 0o400 | 0o004]) {
    fs.chmodSync(svc, 0o700);
    fs.chmodSync(file, mode);
    fs.chmodSync(svc, 0o550);
    assert.throws(() => load(file, svc), /holds tokens/, `mode ${mode.toString(8)} is refused`);
  }
  fs.chmodSync(svc, 0o700);
  fs.chmodSync(file, 0o440);
  fs.chmodSync(svc, 0o570);
  assert.throws(() => load(file, svc), /holds tokens/, "a group-writable credentials directory is refused");
  fs.chmodSync(svc, 0o551);
  assert.throws(() => load(file, svc), /holds tokens/, "a credentials directory open to others is refused");
});
