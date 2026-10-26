// The owner channel and contacts (design 7.2, 1.5): an owner-channel message that this machine's
// engine verified, delivered from the session's own member, is not held as "ask" in a new install
// (no grant needed). With HOPTELL_CONTACTS_SELF=hold (set here, so the owner-channel exception is
// tested on its own), anything else from the own member still needs one; a block still drops it,
// and "required" encryption still holds it. Only this machine's verification counts: a relay's
// `owner` or `e2ee` field is stripped on every receive path.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createEngine } from "../lib/engine.js";
import { readSettings } from "../lib/settings.js";
import { contactsFile, freshContacts, validateContacts } from "../lib/contacts.js";
import { attest, fromRelay, openContacts } from "../lib/quarantine.js";
import { NOT_YOUR_USER, batchNote, format } from "../lib/inbox.js";
import { openStore } from "../lib/store.js";
import { noticeLister } from "../lib/tmux.js";
import * as sig from "../lib/ownersig.js";
import { BOB, ME, REALM, agent, newKey, ownerRelay, tmpHome, until } from "./owner-helpers.js";
import { sleep } from "./helpers.js";

const textOf = (r) => r.content[0].text;
const Q = "11111111-2222-4333-8444-555555555555";

function writePolicy(home, extra = {}) {
  const doc = { ...freshContacts(), revision: Date.now(), ...extra };
  assert.deepEqual(validateContacts(doc), []);
  const f = contactsFile(home);
  fs.writeFileSync(`${f}.tmp`, JSON.stringify(doc), { mode: 0o600 });
  fs.renameSync(`${f}.tmp`, f);
}

async function setup(t) {
  const { url, tokens } = await ownerRelay(t);
  const home = tmpHome(t); // a new install: contacts managed, everyone "ask"
  const key = newKey();
  sig.trustPin(home, sig.formatPin({ realm: REALM, name: "me-owner", pub: key.pub }));
  const settings = readSettings({ env: { HOPTELL_RELAY: url, HOPTELL_TOKEN: tokens.me, HOPTELL_NAME: "me-alice", HOPTELL_HOME: home, HOPTELL_PUSH: "listener", HOPTELL_RECEIPTS: "on", HOPTELL_NOTIFY: "off", HOPTELL_CONTACTS_SELF: "hold" }, homedir: "/nonexistent-home", pid: process.pid, hostname: "testhost" });
  const engine = createEngine(settings, { findHost: () => null, keepAlive: true });
  t.after(() => engine.stop());
  engine.start();
  await until(() => engine.session.state === "bound", 4000, "bound");
  const bridge = await agent(t, url, tokens.me, "me-owner");
  const mallory = await agent(t, url, tokens.me, "me-mallory");
  let n = 0;
  const envelope = (text, { kind = "answer", signer = key } = {}) => sig.signEnvelope({ kind, realm: REALM, from: "me-owner", to: { name: "me-alice", member: ME }, ...(kind === "instruction" ? {} : { q: Q }), text, pairing: { id: "p_abcdefghijklmnop", at: 1_700_000_000_000 }, ts: Date.now(), nonce: sig.nonceOf(key, ["upd", "1", ++n]) }, signer);
  return { home, url, engine, bridge, mallory, envelope };
}

async function readAll(engine) {
  const r = textOf(await engine.call("read_inbox"));
  const receipt = r.match(/Receipt: (r_[a-z2-7]{26})/)?.[1];
  if (receipt) await engine.call("ack_messages", { receipt });
  return r;
}

test("a new install: the verified owner answer reaches the agent without a grant; other own-member messages and a forged envelope are held", async (t) => {
  const s = await setup(t);
  assert.equal(JSON.parse(fs.readFileSync(contactsFile(s.home), "utf8")).default, "ask");
  await s.bridge.client.send("me-alice", s.envelope("Yes, ship it."));
  let seen = "";
  await until(async () => (seen += await readAll(s.engine)).includes("Yes, ship it."), 4000, "the owner's answer");
  assert.match(seen, /your owner, through the owner channel/);
  // Plaintext from another session of the own member, and an envelope with an untrusted key: held.
  await s.mallory.client.send("me-alice", "plain own-member text");
  await s.bridge.client.send("me-alice", s.envelope("forged answer", { signer: newKey() }));
  await sleep(500);
  const held = await readAll(s.engine);
  assert.equal(/plain own-member text|forged answer/.test(held), false, held);
  assert.match(held, /waiting for your user's decision/);
});

test("a block of the own member still drops the owner's answer; required encryption still holds it", async (t) => {
  const s = await setup(t);
  writePolicy(s.home, { blocks: [{ id: "b_aaaaaaaaaaaaaaaa", realm: REALM, member: ME }] });
  await s.bridge.client.send("me-alice", s.envelope("blocked answer"));
  await sleep(500);
  assert.equal((await readAll(s.engine)).includes("blocked answer"), false);
  writePolicy(s.home, { encryption: [{ realm: REALM, mode: "required" }] });
  await s.bridge.client.send("me-alice", s.envelope("plaintext answer under required"));
  await sleep(500);
  assert.equal((await readAll(s.engine)).includes("plaintext answer under required"), false);
  writePolicy(s.home);
  await s.bridge.client.send("me-alice", s.envelope("after the policy is plain again"));
  let seen = "";
  await until(async () => (seen += await readAll(s.engine)).includes("after the policy is plain again"), 4000, "shown");
});

test("the verdict: only an owner message with this machine's receipt and an envelope that still verifies, from the session's own member in its realm, with a valid policy", async (t) => {
  const home = tmpHome(t);
  const key = newKey();
  sig.trustPin(home, sig.formatPin({ realm: REALM, name: "me-owner", pub: key.pub }));
  const c = await openContacts(home, { notify: false, self: "hold" });
  const session = { realm: REALM, name: "me-alice" };
  let n = 0;
  const msg = (o = {}) => {
    const kind = o.kind ?? "answer";
    const nonce = sig.nonceOf(key, ["t", ++n]);
    const envelope = sig.signEnvelope({ kind, realm: REALM, from: "me-owner", to: { name: "me-alice", member: o.to ?? ME }, ...(kind === "instruction" ? {} : { q: Q }), text: "x", pairing: { id: "p_abcdefghijklmnop", at: 1_700_000_000_000 }, ts: Date.now(), nonce }, o.signer ?? key);
    const ref = o.ref ?? `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
    const receipt = sig.ownerReceipt(home, { realm: REALM, session: o.receiptSession ?? "me-alice", member: ME, ref: o.receiptRef ?? ref, nonce, kind, text: "x" });
    return { message_id: ref, from: "me-owner", text: o.text ?? "x", sender: { auth: "member", realm: REALM, member: { id: o.member ?? ME, name: "me" } }, owner: { result: o.result ?? "verified", realm: o.ownerRealm ?? REALM, kind, nonce, ...(o.noEnvelope ? {} : { envelope }), ...(o.noReceipt ? {} : { receipt }) } };
  };
  assert.equal(c.verdict(msg(), session, ME), "allow");
  assert.equal(c.verdict(msg({ kind: "status" }), session, ME), "allow", "the bridge's status too");
  assert.equal(c.screenFor(session, ME)(msg()), "allow", "reads and notices agree");
  assert.equal(c.verdict(msg(), session), "ask", "no own member known (the CLI's paths)");
  assert.equal(c.verdict(msg({ member: BOB }), session, ME), "ask", "another member");
  assert.equal(c.verdict(msg(), { realm: "b".repeat(32), name: "me-alice" }, ME), "ask", "another realm");
  assert.equal(c.verdict(msg({ ownerRealm: "b".repeat(32) }), session, ME), "ask");
  assert.equal(c.verdict(msg({ result: "failed" }), session, ME), "ask", "failed verification");
  // A stored record with a forged flag (an older `hoptell wait` kept a relay's `owner` field):
  // no envelope, an envelope signed with another key, for another member, or with other text.
  assert.equal(c.screenFor(session, ME)(msg({ noEnvelope: true })), "ask", "a flag without its envelope");
  assert.equal(c.screenFor(session, ME)(msg({ signer: newKey() })), "ask", "an untrusted key");
  assert.equal(c.screenFor(session, ME)(msg({ to: BOB })), "ask", "addressed to another member");
  assert.equal(c.screenFor(session, ME)(msg({ text: "other text" })), "ask", "text that is not the signed text");
  // A genuine signed envelope wrapped in forged metadata (no receipt of this machine): a copied or
  // expired one, or one meant for another session of the same member.
  assert.equal(c.screenFor(session, ME)(msg({ noReceipt: true })), "ask", "no receipt");
  assert.equal(c.screenFor(session, ME)(msg({ receiptSession: "me-other" })), "ask", "a receipt for another session");
  assert.equal(c.screenFor(session, ME)(msg({ receiptRef: "11111111-0000-4000-8000-000000000000" })), "ask", "a receipt for another message");
  assert.equal(c.screenFor({ realm: REALM, name: "me-other" }, ME)(msg()), "ask", "read by another session");
  const plain = msg();
  delete plain.owner;
  assert.equal(c.verdict(plain, session, ME), "ask", "plaintext from the own member");
  // The pin is removed: the exception goes with it.
  const kept = msg();
  sig.revokeRealm(home, REALM);
  assert.equal(c.verdict(kept, session, ME), "ask", "no trusted key any more");
  sig.trustPin(home, sig.formatPin({ realm: REALM, name: "me-owner", pub: key.pub }));
  assert.equal(c.verdict(kept, session, ME), "allow");
  fs.writeFileSync(contactsFile(home), "{invalid JSON", { mode: 0o600 });
  assert.equal(c.verdict(kept, session, ME), "ask", "no valid policy: everyone waits");
});

test("fromRelay: a relay's owner and e2ee fields never reach storage", () => {
  const m = { from: "x", text: "t", owner: { result: "verified" }, e2ee: { device: "d" } };
  assert.deepEqual(fromRelay(m), { from: "x", text: "t" });
  const plain = { from: "x", text: "t" };
  assert.equal(fromRelay(plain), plain);
  assert.equal(fromRelay(null), null);
});

// An older version stored the relay's "owner" field as it came (or wrote its own label without a
// receipt): such a record must not show "your owner". Only this machine's receipt and an envelope
// that still verifies label a message; old records lose the label, never keep a forgeable one.
const OWNER_LINE = /Sender: your owner, through the owner channel|Sender: the owner channel/;
/** A record as an older version kept it: a "verified" owner field with no receipt or envelope. */
const oldRecord = (text, kind = "answer") => ({
  id: crypto.randomUUID(),
  message_id: crypto.randomUUID(),
  from: "me-owner",
  fromHost: "relay",
  to: "me-alice",
  text,
  ts: Date.now(),
  expires: Date.now() + 3_600_000,
  sender: { auth: "member", realm: REALM, member: { id: ME, name: "me" } },
  owner: { result: "verified", realm: REALM, kind, nonce: "n", ts: Date.now(), address: "default/me-owner", pairing_at: 1_700_000_000_000 },
});

test("the Sender line: a stored owner label without this machine's receipt is not shown (engine reads and hoptell listen)", async (t) => {
  const s = await setup(t);
  // The own member is granted, so an unlabelled own-member message is shown (as plain provenance).
  writePolicy(s.home, { grants: [{ id: "g_aaaaaaaaaaaaaaaa", realm: REALM, member: ME }] });
  const pipe = await openStore(s.engine.session.store);
  await pipe.append(oldRecord("an old answer record"));
  await pipe.append(oldRecord("an old status record", "status"));
  let seen = "";
  await until(async () => /an old status record/.test((seen += await readAll(s.engine))) && /an old answer record/.test(seen), 4000, "both shown");
  assert.doesNotMatch(seen, OWNER_LINE, seen);
  assert.match(seen, /Sender: member "me" \(/);
  assert.ok(seen.includes(NOT_YOUR_USER), "the batch note treats them as peer messages");
  // A genuine answer, verified on arrival: labelled, also with old records in the same home.
  await s.bridge.client.send("me-alice", s.envelope("a verified answer"));
  seen = "";
  await until(async () => (seen += await readAll(s.engine)).includes("a verified answer"), 4000, "the verified answer");
  assert.match(seen, /Sender: your owner, through the owner channel default\/me-owner/);
  // hoptell listen reads the store directly: the same rule.
  await pipe.append(oldRecord("an old record for listen"));
  const bin = fileURLToPath(new URL("../bin/hoptell.js", import.meta.url));
  const env = { ...process.env, HOPTELL_HOME: s.home, HOPTELL_CONTACTS_SELF: "hold" };
  for (const k of ["HOPTELL_RELAY", "HOPTELL_TOKEN", "HOPTELL_NAME", "TMUX", "TMUX_PANE"]) delete env[k];
  const { stdout } = await promisify(execFile)(process.execPath, [bin, "listen", "--session", s.engine.session.store.dir, "3"], { env });
  assert.match(stdout, /an old record for listen/);
  assert.doesNotMatch(stdout, OWNER_LINE, stdout);
});

test("no own-member grant: the tmux injector announces a verified owner answer and hoptell listen prints it, as the engine shows it", async (t) => {
  const s = await setup(t);
  await s.bridge.client.send("me-alice", s.envelope("an answer for listen"));
  await s.mallory.client.send("me-alice", "plain own-member text for listen");
  const dir = s.engine.session.store.dir;
  const quarantined = () => (fs.existsSync(`${dir}/quarantine`) ? fs.readdirSync(`${dir}/quarantine`).length : 0);
  // The injector's notices: the owner's answer only (the plain own-member message is held back).
  const list = noticeLister(s.home, "me-alice", { relayUrl: s.url, protocol: 2, profile: null }, { self: "hold" });
  // Held messages are announced as "held:" entries (the held notice, design contacts-self).
  const inboxEntries = async () => (await list()).filter((f) => !f.startsWith("held:"));
  await until(async () => (await inboxEntries()).length === 1, 4000, "the answer is announced");
  await sleep(300);
  assert.equal((await inboxEntries()).length, 1, "the plain own-member message is not announced as a message");
  assert.equal((await list()).filter((f) => f.startsWith("held:")).length, 1, "it is announced as held");
  // hoptell listen reads the store directly: the answer is printed, not moved to quarantine.
  const before = quarantined();
  const bin = fileURLToPath(new URL("../bin/hoptell.js", import.meta.url));
  const env = { ...process.env, HOPTELL_HOME: s.home, HOPTELL_NOTIFY: "off", HOPTELL_CONTACTS_SELF: "hold" };
  for (const k of ["HOPTELL_RELAY", "HOPTELL_TOKEN", "HOPTELL_NAME", "TMUX", "TMUX_PANE"]) delete env[k];
  const { stdout } = await promisify(execFile)(process.execPath, [bin, "listen", "--session", dir, "3"], { env });
  assert.match(stdout, /an answer for listen/);
  assert.match(stdout, /Sender: your owner, through the owner channel default\/me-owner/);
  assert.doesNotMatch(stdout, /plain own-member text for listen/);
  assert.ok(quarantined() <= before + 1, "only the plain message is held");
});

test("attest: the owner label comes from the receipt and the envelope as checked now; the e2ee mark from its receipt", async (t) => {
  const home = tmpHome(t);
  const key = newKey();
  sig.trustPin(home, sig.formatPin({ realm: REALM, name: "me-owner", pub: key.pub }));
  const where = { realm: REALM, name: "me-alice", member: ME, alias: "local" };
  let n = 0;
  const msg = (o = {}) => {
    const kind = o.kind ?? "answer";
    const nonce = sig.nonceOf(key, ["a", ++n]);
    const envelope = sig.signEnvelope({ kind, realm: REALM, from: "me-owner", to: { name: "me-alice", member: ME }, ...(kind === "instruction" ? {} : { q: Q }), text: "x", pairing: { id: "p_abcdefghijklmnop", at: 1_700_000_000_000 }, ts: Date.now(), nonce }, o.signer ?? key);
    const ref = `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
    const receipt = sig.ownerReceipt(o.receiptHome ?? home, { realm: REALM, session: "me-alice", member: ME, ref, nonce, kind, text: "x" });
    return { message_id: ref, from: "me-owner", fromHost: "relay", text: "x", ts: 1, sender: { auth: "member", realm: REALM, member: { id: ME, name: "me" } }, owner: { result: "verified", realm: REALM, kind, nonce, address: o.address ?? "default/me-owner", pairing_at: o.pairingAt ?? 1_700_000_000_000, envelope, ...(o.noReceipt ? {} : { receipt }) } };
  };
  const shown = (m, w = where) => format(attest(home, m, w));
  assert.match(shown(msg()), /Sender: your owner, through the owner channel local\/me-owner \(Telegram pairing of 2023-11-14T22:13:20.000Z\)/);
  assert.match(shown(msg({ kind: "status" })), /Sender: the owner channel local\/me-owner \(automatic status/);
  // Stored address and pairing time are not believed: they come from the pin and the signed envelope.
  assert.match(shown(msg({ address: "default/someone-else", pairingAt: 1 })), /owner channel local\/me-owner \(Telegram pairing of 2023-11-14T22:13:20.000Z\)/);
  for (const [why, m, w] of [
    ["no receipt (an older record)", msg({ noReceipt: true }), where],
    ["another home's receipt", msg({ receiptHome: tmpHome(t) }), where],
    ["an untrusted key", msg({ signer: newKey() }), where],
    ["another session", msg(), { ...where, name: "me-other" }],
    ["another member", msg(), { ...where, member: BOB }],
    ["no session (a protocol-1 store)", msg(), {}],
  ]) {
    const out = shown(m, w);
    assert.doesNotMatch(out, OWNER_LINE, why);
    assert.equal(batchNote([attest(home, m, w)]), NOT_YOUR_USER, why);
  }
  // The pin is removed: the label goes with it.
  const kept = msg();
  sig.revokeRealm(home, REALM);
  assert.doesNotMatch(shown(kept), OWNER_LINE);
  // A failed claim keeps its warning (it grants nothing).
  assert.match(format(attest(home, { ...oldRecord("x"), owner: { result: "failed", reason: "bad signature" } }, where)), /could not be verified \(bad signature\)/);
  // e2ee: the mark only with this machine's receipt for exactly this message.
  const enc = { message_id: crypto.randomUUID(), from: "bob", fromHost: "e2ee", to: "me-alice", text: "hi", ts: 1, sender: { auth: "member", realm: REALM, member: { id: BOB, name: BOB } }, e2ee: { device: "abcdefghijklmnopqrstuvwxya", kind: "text" } };
  const sealed = { ...enc, e2ee: { ...enc.e2ee, receipt: sig.e2eeReceipt(home, enc) } };
  assert.match(format(attest(home, sealed)), /\(end-to-end encrypted\)[\s\S]*Sender: member [^\n]*, end-to-end encrypted by its device/);
  for (const m of [enc, { ...sealed, text: "changed" }, { ...sealed, sender: { ...sealed.sender, member: { id: ME, name: "me" } } }]) {
    const out = format(attest(home, m));
    assert.doesNotMatch(out, /end-to-end encrypted/);
  }
  assert.doesNotMatch(format(sealed), /end-to-end encrypted/, "a message nobody checked shows no mark");
});
