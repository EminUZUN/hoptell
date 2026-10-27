// The require-encryption policy and the session wiring of encrypted messages (design 3.3,
// experimental): contacts' encryption entries, plaintext from a "required" contact held as a
// policy violation that allow-once and grants do not release, no fallback under "required", a
// relay without the e2ee capability (an older relay) carrying plaintext only, "preferred" saying
// when it did not encrypt, and an agent session sending and reading encrypted messages.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createEngine } from "../lib/engine.js";
import { readSettings } from "../lib/settings.js";
import { decide, encryptionMode, senderKey, validateContacts } from "../lib/contacts.js";
import { ATTESTED } from "../lib/attested.js";
import { e2eeReceipt } from "../lib/ownersig.js";
import { openContacts } from "../lib/quarantine.js";
import { openBound } from "../lib/session.js";
import { openStore } from "../lib/store.js";
import { profileKey } from "../lib/profiles.js";
import { storeFor } from "../lib/mls/cli.js";
import { deviceRelay, tmpDir } from "./mls-helpers.js";

const R = "a".repeat(32);
const ALICE = `m_${"a".repeat(26)}`;
const BOB = `m_${"b".repeat(26)}`;
const PASS = "correct horse battery staple";
const FAKE = fileURLToPath(new URL("./fake-mls-driver.js", import.meta.url));
const plain = (text, member = ALICE) => ({ type: "message", id: crypto.randomUUID(), from: "alice", fromHost: "h", text, ts: 1, sender: { auth: "member", member: { id: member, name: "alice" }, realm: R } });
const textOf = (r) => r.content.map((c) => c.text).join("");
const until = async (fn, ms = 5000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 40));
  }
};

test("contacts: encryption entries per contact and per realm; validated; the contact's own entry wins", () => {
  const doc = { version: 1, default: "ask", encryption: [{ realm: R, mode: "preferred" }, { realm: R, member: BOB, mode: "required" }] };
  assert.deepEqual(validateContacts(doc), []);
  assert.equal(encryptionMode(doc, R, BOB), "required");
  assert.equal(encryptionMode(doc, R, ALICE), "preferred", "the realm's default");
  assert.equal(encryptionMode(doc, "b".repeat(32), ALICE), "off", "unset means off");
  assert.match(validateContacts({ ...doc, encryption: [{ realm: R, mode: "always" }] })[0], /mode must be/);
  assert.match(validateContacts({ ...doc, encryption: [{ realm: R, mode: "off" }, { realm: R, mode: "required" }] })[0], /listed twice/);
  assert.match(validateContacts({ ...doc, encryption: [{ realm: R, member: "bob", mode: "off" }] })[0], /member id/);
  // Plaintext from a required contact is a policy violation, whatever the grants; decrypted is not.
  const granted = { ...doc, grants: [{ realm: R, member: BOB }] };
  assert.equal(decide(granted, senderKey(plain("x", BOB)), { realm: R, name: "s" }), "policy");
  assert.equal(decide(granted, senderKey({ ...plain("x", BOB), e2ee: { device: "x" }, [ATTESTED]: { owner: null, e2ee: true } }), { realm: R, name: "s" }), "allow");
  // A stored mark alone (no check by this machine) is plaintext.
  assert.equal(decide(granted, senderKey({ ...plain("x", BOB), e2ee: { device: "x" } }), { realm: R, name: "s" }), "policy");
  assert.equal(decide({ ...granted, blocks: [{ realm: R, member: BOB }] }, senderKey(plain("x", BOB)), { realm: R, name: "s" }), "block", "a block still wins");
});

test("plaintext from a required contact goes to quarantine and is not releasable by allow-once or a grant; only a policy change releases it", async (t) => {
  const home = tmpDir(t);
  const c = await openContacts(home, { notify: false });
  await c.setEncryption({ realm: R, member: ALICE, mode: "required" });
  const bound = await openBound(home, { realm: R, member: null, key: "s" });
  await openStore(bound);
  const m = plain("not encrypted");
  assert.equal(c.verdict(m, { realm: R, name: "s" }), "ask", "held like ask (the store's verdicts)");
  const r = await c.hold(bound.dir, { realm: R, name: "s" }, m, "ask");
  assert.equal(r.disposition, "quarantined");
  const st = await c.status();
  const req = st.requests[0];
  for (const op of ["allowOnce", "allow"]) {
    await assert.rejects(c[op](req.id, { rev: req.rev, policyRev: st.policyRevision }), /encryption is required.*policy violation/, op);
  }
  // The owner changes the contact's encryption policy: the ordinary decisions apply again.
  await c.setEncryption({ realm: R, member: ALICE, mode: "preferred" });
  const st2 = await c.status();
  const done = await c.allowOnce(req.id, { rev: st2.requests[0].rev, policyRev: st2.policyRevision });
  assert.equal(done.op, "allow-once");
});

test("MII5: plaintext held before its contact became required, or adopted under required, is not released by allow-once (current policy, stored provenance)", async (t) => {
  for (const how of ["held-then-required", "adopted-under-required"]) {
    const home = tmpDir(t);
    const c = await openContacts(home, { notify: false });
    const s = { realm: R, name: "s" };
    const bound = await openBound(home, { realm: R, member: null, key: "s" });
    const st = await openStore(bound);
    const m = { ...plain("plaintext"), message_id: crypto.randomUUID() };
    if (how === "adopted-under-required") {
      await c.setEncryption({ realm: R, member: ALICE, mode: "required" });
      await st.quarantineAppend(m);
      await c.adopt();
    } else {
      await c.hold(bound.dir, s, m, "ask");
      await c.setEncryption({ realm: R, member: ALICE, mode: "required" });
    }
    const status = await c.status();
    const req = status.requests[0];
    await assert.rejects(c.allowOnce(req.id, { rev: req.rev, policyRev: status.policyRevision }), /encryption is required.*policy violation/, how);
    assert.equal((await st.pendingEntries({ screen: c.screenFor(s) })).length, 0, `${how}: nothing visible`);
  }
  // An approved (allow-once) copy that reached the inbox before the contact became required is
  // screened again: the policy verdict is not overridden by the approval.
  const home = tmpDir(t);
  const c = await openContacts(home, { notify: false });
  const s = { realm: R, name: "s" };
  const bound = await openBound(home, { realm: R, member: null, key: "s" });
  const st = await openStore(bound);
  await c.hold(bound.dir, s, plain("released before"), "ask");
  const status = await c.status();
  await c.allowOnce(status.requests[0].id, { rev: status.requests[0].rev, policyRev: status.policyRevision });
  assert.equal((await st.pendingEntries({ screen: c.screenFor(s) })).length, 1, "allowed once while the policy allowed it");
  await c.setEncryption({ realm: R, member: ALICE, mode: "required" });
  assert.equal((await st.pendingEntries({ screen: c.screenFor(s) })).length, 0, "required now: the approval does not release plaintext");
  assert.equal(c.screenFor(s)(plain("x")), "policy", "a verdict the approval flag never overrides");
  // Journal recovery: an allow-once interrupted before its release, the contact made required
  // meanwhile (an edit of the file), resumed later: nothing is released, the item stays held.
  {
    const home2 = tmpDir(t);
    let fail = false;
    const c2 = await openContacts(home2, {
      notify: false,
      fault: (p, f) => {
        if (fail && p === "move" && f.includes(`${path.sep}quarantine${path.sep}`)) {
          fail = false;
          throw Object.assign(new Error("simulated"), { code: "EIO" });
        }
      },
    });
    const bound2 = await openBound(home2, { realm: R, member: null, key: "s" });
    const st2 = await openStore(bound2);
    await c2.hold(bound2.dir, s, plain("interrupted"), "ask");
    const q = await c2.status();
    fail = true;
    await assert.rejects(c2.allowOnce(q.requests[0].id, { rev: q.requests[0].rev, policyRev: q.policyRevision }));
    const file = path.join(home2, "contacts.json");
    const doc = JSON.parse(fs.readFileSync(file, "utf8"));
    fs.writeFileSync(file, JSON.stringify({ ...doc, revision: doc.revision + 1, encryption: [{ realm: R, member: ALICE, mode: "required" }] }), { mode: 0o600 });
    const resumed = await c2.status(); // resumes the journal under the current policy
    assert.equal(resumed.journalsWaiting, 0);
    assert.equal(resumed.messages, 1, "still held");
    assert.equal((await st2.pendingEntries({ screen: c2.screenFor(s) })).length, 0);
    assert.equal((await st2.pendingEntries()).length, 0, "not even in the inbox");
  }
  // Decrypted provenance (e2ee, with this machine's receipt) is not a violation.
  const enc = { ...plain("decrypted here"), e2ee: { device: "d" } };
  assert.equal(c.screenFor(s)({ ...enc, e2ee: { ...enc.e2ee, receipt: e2eeReceipt(home, enc) } }), "ask");
  // A record an older hoptell wait kept with a relay's "e2ee" field (no receipt), a receipt made on
  // another home, or one for other content: plaintext, held as a policy violation.
  assert.equal(c.screenFor(s)(enc), "policy", "no receipt");
  assert.equal(c.screenFor(s)({ ...enc, e2ee: { ...enc.e2ee, receipt: e2eeReceipt(tmpDir(t), enc) } }), "policy", "another home's receipt");
  assert.equal(c.screenFor(s)({ ...enc, text: "changed", e2ee: { ...enc.e2ee, receipt: e2eeReceipt(home, enc) } }), "policy", "another text");
  assert.equal(c.screenFor(s)({ ...enc, e2ee: { device: "other", receipt: e2eeReceipt(home, enc) } }), "policy", "another device");
});

/** A home of `member` with an enrolled device (fake driver) for the relay of `w`, and its engine environment. */
async function homeOf(t, w, member, { enroll = true, contacts = null, flag = true, roles = null, extra = {} } = {}) {
  const dir = tmpDir(t);
  const env = { HOPTELL_RELAY: w.url, HOPTELL_TOKEN: w.members[member].token, HOPTELL_NAME: member, ...(roles ? { HOPTELL_ROLES: roles } : {}), HOPTELL_HOME: dir, HOPTELL_PUSH: "listener", HOPTELL_CREDENTIAL_STORE: "file", HOPTELL_CREDENTIAL_PASSPHRASE: PASS, HOPTELL_MLS_DRIVER: FAKE, HOPTELL_MACHINE_ID: "m", ...(flag ? { HOPTELL_EXPERIMENTAL_E2EE: "1" } : {}), ...extra };
  if (contacts) fs.writeFileSync(path.join(dir, "contacts.json"), JSON.stringify(contacts(w)), { mode: 0o600 });
  if (enroll) {
    // Enrollment writes the own baseline into the home's contacts (A1).
    const store = await storeFor({ home: dir, profile: profileKey(w.url, null), env, contacts: await openContacts(dir, { notify: false }) });
    await store.enroll(await w.client(member));
  }
  const engine = createEngine(readSettings({ env, homedir: os.tmpdir(), pid: process.pid, hostname: "testhost" }), { findHost: () => null, keepAlive: true });
  t.after(() => engine.stop());
  await engine.start();
  await until(() => engine.session.state === "bound");
  return { dir, engine, env };
}
const policy = (grantee, encryption = []) => (w) => ({ version: 1, revision: 0, default: "ask", grants: [{ realm: w.realm, member: w.members[grantee].id }], blocks: [], ...(encryption.length ? { encryption: encryption.map((e) => ({ realm: w.realm, ...(e.member ? { member: w.members[e.member].id } : {}), mode: e.mode })) } : {}) });

test("an agent session: required sends encrypted end to end; the peer's session reads it; no plaintext reached the relay", async (t) => {
  const w = await deviceRelay(t, { e2ee: true });
  const bob = await homeOf(t, w, "bob", { contacts: policy("alice") });
  const alice = await homeOf(t, w, "alice", { contacts: policy("bob", [{ member: "bob", mode: "required" }]) });
  await until(() => alice.engine.session.state === "bound");
  await new Promise((r) => setTimeout(r, 300)); // both attached their devices
  const r = await alice.engine.call("send_message", { to: "bob", message: "secret plan" });
  assert.match(textOf(r), /encrypted \(experimental, unreviewed\)/);
  let got = "";
  assert.ok(await until(async () => /secret plan/.test((got += textOf(await bob.engine.call("read_inbox"))))), got);
  assert.equal(w.relay.stats().queueItems, 0, "nothing went through the plaintext queue");
  const rows = [...w.db.all("SELECT frame FROM e2ee_queue").map((x) => x.frame), ...w.db.all("SELECT body FROM e2ee_payloads").map((x) => x.body)].join("");
  assert.ok(!rows.includes("secret plan"));
});

test("required at the receiver: a message this device decrypted is shown as encrypted (its receipt); a stored e2ee mark without one, as an older hoptell wait kept it, is held", async (t) => {
  const w = await deviceRelay(t, { e2ee: true });
  const bob = await homeOf(t, w, "bob", { contacts: policy("alice", [{ member: "alice", mode: "required" }]) });
  const alice = await homeOf(t, w, "alice", { contacts: policy("bob", [{ member: "bob", mode: "required" }]) });
  await new Promise((r) => setTimeout(r, 300)); // both attached their devices
  const r = await alice.engine.call("send_message", { to: "bob", message: "decrypted here" });
  assert.match(textOf(r), /encrypted \(experimental, unreviewed\)/);
  const read = async () => {
    const out = textOf(await bob.engine.call("read_inbox"));
    const receipt = out.match(/Receipt: (r_[a-z2-7]{26})/)?.[1];
    if (receipt) await bob.engine.call("ack_messages", { receipt });
    return out;
  };
  let got = "";
  assert.ok(await until(async () => /decrypted here/.test((got += await read()))), got);
  assert.match(got, /\(end-to-end encrypted\)[\s\S]*Sender: member [^\n]*, end-to-end encrypted by its device/);
  // Encrypted text that claims to be an owner envelope: checked as one (it fails), still encrypted.
  await alice.engine.call("send_message", { to: "bob", message: '{"hoptell_owner":1}' });
  got = "";
  assert.ok(await until(async () => /hoptell_owner/.test((got += await read()))), got);
  assert.match(got, /\(end-to-end encrypted\)[\s\S]*could not be verified \(malformed envelope/);
  // A record with the relay's "e2ee" field and no receipt, as an older hoptell wait stored it.
  const pipe = await openStore(bob.engine.session.store);
  await pipe.append({ type: "message", id: crypto.randomUUID(), message_id: crypto.randomUUID(), from: "alice", fromHost: "relay", to: "bob", text: "claims encryption", ts: Date.now(), expires: Date.now() + 3_600_000, sender: { auth: "member", realm: w.realm, member: { id: w.members.alice.id, name: "alice" } }, e2ee: { device: "abcdefghijklmnopqrstuvwxya", kind: "text" } });
  let after = "";
  await until(async () => /waiting for your user's decision/.test((after += await read())), 3000);
  assert.doesNotMatch(after, /claims encryption/, after);
  assert.match(after, /1 message from member alice \(authenticated by the relay\): held because your user's contacts require encryption from this sender/, after);
});

test("required: no fallback; a relay without the e2ee capability (an older relay) carries no plaintext to that contact", async (t) => {
  const w = await deviceRelay(t); // device keys, no encrypted messages
  await homeOf(t, w, "bob", { contacts: policy("alice") });
  const alice = await homeOf(t, w, "alice", { contacts: policy("bob", [{ member: "bob", mode: "required" }]) });
  const r = await alice.engine.call("send_message", { to: "bob", message: "must not leak" });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /does not carry encrypted messages/);
  assert.equal(w.relay.stats().accepted, 0, "nothing was sent");
  // With encrypted messages but no device of the peer: an error too, never plaintext.
  const w2 = await deviceRelay(t, { e2ee: true });
  await homeOf(t, w2, "bob", { enroll: false, contacts: policy("alice") });
  const a2 = await homeOf(t, w2, "alice", { contacts: policy("bob", [{ member: "bob", mode: "required" }]) });
  await new Promise((r) => setTimeout(r, 300));
  const r2 = await a2.engine.call("send_message", { to: "bob", message: "must not leak" });
  assert.equal(r2.isError, true);
  assert.match(textOf(r2), /nothing was sent \(never as plaintext\)/);
  assert.equal(w2.relay.stats().accepted, 0);
  // A realm default of "required": a name that is no member's session is refused too.
  const a3 = await homeOf(t, w2, "carol", { contacts: policy("bob", [{ mode: "required" }]) });
  await new Promise((r) => setTimeout(r, 300));
  const r3 = await a3.engine.call("send_message", { to: "nobody", message: "must not leak" });
  assert.equal(r3.isError, true);
  assert.match(textOf(r3), /required in this realm/);
  assert.equal(w2.relay.stats().accepted, 0);
});

test("preferred: plaintext when the peer has no device, and the result says so; off and no policy: unchanged plaintext", async (t) => {
  const w = await deviceRelay(t, { e2ee: true });
  const bob = await homeOf(t, w, "bob", { enroll: false, contacts: policy("alice") });
  const alice = await homeOf(t, w, "alice", { contacts: policy("bob", [{ mode: "preferred" }]) });
  await new Promise((r) => setTimeout(r, 300));
  const r = await alice.engine.call("send_message", { to: "bob", message: "hello" });
  assert.match(textOf(r), /Not encrypted:/);
  let got = "";
  assert.ok(await until(async () => /hello/.test((got += textOf(await bob.engine.call("read_inbox"))))));
  // Without the flag the session attaches no device; the persisted policy still decides: a
  // required contact is refused (turning the flag off never turns it into plaintext), and a home
  // without a policy sends plaintext as before.
  const w3 = await deviceRelay(t, { e2ee: true });
  await homeOf(t, w3, "bob", { contacts: policy("alice"), flag: false });
  const off = await homeOf(t, w3, "alice", { contacts: policy("bob", [{ member: "bob", mode: "required" }]), flag: false });
  assert.equal(readSettings({ env: off.env, homedir: os.tmpdir(), pid: 1, hostname: "h" }).e2ee, undefined);
  const r3 = await off.engine.call("send_message", { to: "bob", message: "must not leak" });
  assert.equal(r3.isError, true);
  assert.match(textOf(r3), /encryption is required for bob, but encrypted messages are not enabled here \(HOPTELL_EXPERIMENTAL_E2EE is not set\); nothing was sent \(never as plaintext\)/);
  assert.equal(w3.relay.stats().accepted, 0, "nothing was sent");
  const plain = await homeOf(t, w3, "carol", { contacts: policy("bob"), flag: false });
  const r4 = await plain.engine.call("send_message", { to: "bob", message: "plain as before" });
  assert.doesNotMatch(textOf(r4), /encrypt/i);
  assert.equal(w3.relay.stats().accepted, 1);
  assert.equal(w3.db.get("SELECT count(*) AS n FROM e2ee_queue").n, 0, "no device attached, nothing encrypted");
});

test("without the flag, a required contact gets no plaintext from send_message, @role, send_file or send_review_set (the persisted policy decides)", async (t) => {
  const w = await deviceRelay(t, { e2ee: true });
  await homeOf(t, w, "bob", { contacts: policy("alice"), flag: false, roles: "reviewer" });
  const root = tmpDir(t);
  fs.writeFileSync(path.join(root, "a.txt"), "secret file\n");
  const alice = await homeOf(t, w, "alice", { contacts: policy("bob", [{ member: "bob", mode: "required" }]), flag: false, extra: { HOPTELL_SNAPSHOT_ROOTS: JSON.stringify([{ id: "app", path: root }]) } });
  const calls = [
    ["send_message", { to: "bob", message: "must not leak" }, /encryption is required for bob/],
    ["send_message", { to: "@reviewer", message: "must not leak" }, /fan-out \(@reviewer\) cannot be encrypted now/],
    ["send_file", { to: "bob", root_id: "app", path: "a.txt", request: "review" }, /encryption is required for bob/],
    ["send_review_set", { to: "bob", files: [{ root: "app", path: "a.txt" }], request: "review" }, /encryption is required for bob/],
  ];
  for (const [tool, args, why] of calls) {
    const r = await alice.engine.call(tool, args);
    assert.equal(r.isError, true, `${tool} ${args.to}: ${textOf(r)}`);
    assert.match(textOf(r), why);
  }
  assert.equal(w.relay.stats().accepted, 0, "nothing was sent");
});

test("an agent session: @role under an encryption policy is an encrypted fan-out (design 4.3): pinned members only, counted, no plaintext copy", async (t) => {
  const w = await deviceRelay(t, { e2ee: true });
  const bob = await homeOf(t, w, "bob", { contacts: policy("alice"), roles: "reviewer" });
  await homeOf(t, w, "carol", { contacts: policy("alice"), roles: "reviewer" });
  const alice = await homeOf(t, w, "alice", { contacts: policy("bob", [{ mode: "required" }]) });
  await new Promise((r) => setTimeout(r, 300));
  // The first message to bob is a deliberate direct send (it pins bob's devices); carol has none.
  assert.match(textOf(await alice.engine.call("send_message", { to: "bob", message: "first contact" })), /encrypted \(experimental, unreviewed\)/);
  const r = await alice.engine.call("send_message", { to: "@reviewer", message: "fan-out secret" });
  assert.ok(!r.isError, textOf(r));
  assert.equal(textOf(r), "Fan-out to @reviewer, encrypted (experimental, unreviewed): sent to 1 of 1 copy. Not included: 1 session needs a first direct message (first-contact). 2 sessions matched @reviewer.");
  let got = "";
  let ack;
  const read = async () => {
    const text = textOf(await bob.engine.call("read_inbox", ack ? { ack } : {}));
    ack = /Receipt: (\S+)\./.exec(text)?.[1];
    return text;
  };
  assert.ok(await until(async () => /fan-out secret/.test((got += await read()))), got);
  assert.equal(w.relay.stats().queueItems, 0, "nothing went through the plaintext queue");
  assert.ok(![...w.db.all("SELECT frame FROM e2ee_queue").map((x) => x.frame), ...w.db.all("SELECT body FROM e2ee_payloads").map((x) => x.body)].join("").includes("fan-out secret"));
});

test("an encrypted fan-out copy meets gate 3 at the recipient: bob's contacts do not admit alice, so it waits in quarantine, never in the inbox", async (t) => {
  const w = await deviceRelay(t, { e2ee: true });
  const bob = await homeOf(t, w, "bob", { contacts: policy("carol"), roles: "reviewer" });
  const alice = await homeOf(t, w, "alice", { contacts: policy("bob", [{ mode: "required" }]) });
  await new Promise((r) => setTimeout(r, 300));
  assert.match(textOf(await alice.engine.call("send_message", { to: "bob", message: "first contact" })), /encrypted \(experimental, unreviewed\)/);
  const r = await alice.engine.call("send_message", { to: "@reviewer", message: "fan-out to quarantine" });
  assert.match(textOf(r), /sent to 1 of 1 copy/);
  const c = await openContacts(bob.dir, { notify: false });
  assert.ok(await until(async () => (await c.status()).messages === 2), "both of alice's messages wait for bob's owner");
  const inbox = textOf(await bob.engine.call("read_inbox"));
  assert.doesNotMatch(inbox, /fan-out to quarantine/);
  assert.equal(w.relay.stats().queueItems, 0, "nothing went through the plaintext queue");
});

test("hoptell contacts verify --conversation: both owners see the same checkpoint; doctor reports the conversations", async (t) => {
  const w = await deviceRelay(t, { e2ee: true });
  const bob = await homeOf(t, w, "bob", { contacts: policy("alice") });
  const alice = await homeOf(t, w, "alice", { contacts: policy("bob", [{ member: "bob", mode: "required" }]) });
  await new Promise((r) => setTimeout(r, 300));
  assert.match(textOf(await alice.engine.call("send_message", { to: "bob", message: "checkpoint me" })), /encrypted/);
  let got = "";
  assert.ok(await until(async () => /checkpoint me/.test((got += textOf(await bob.engine.call("read_inbox"))))));
  const profile = profileKey(w.url, null);
  const { conversationCommand, e2eeDoctor } = await import("../lib/mls/cli.js");
  const shown = async (h, member) => {
    const lines = [];
    await conversationCommand({ member, home: h.dir, profile, env: h.env, say: (l) => lines.push(l) });
    return lines;
  };
  const a = await shown(alice, w.members.bob.id);
  const b = await shown(bob, w.members.alice.id);
  const cp = (lines) => lines.find((l) => l.startsWith("Checkpoint:"));
  assert.match(cp(a), /^Checkpoint: (\d{5} ){11}\d{5}$/);
  assert.equal(cp(a), cp(b), "one history, one number");
  assert.match((await shown(alice, w.members.carol.id))[0], /no encrypted conversation/);
  const lines = await e2eeDoctor({ home: alice.dir, profile, env: alice.env });
  assert.match(lines[0][1], /1 encrypted conversation\(s\)/);
});
