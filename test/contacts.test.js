// Contacts policy (lib/contacts.js): validation, sender keys and decisions.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { decide, freshContacts, keyId, readContacts, senderKey, validateContacts } from "../lib/contacts.js";

const R = "a".repeat(32);
const R2 = "b".repeat(32);
const ALICE = "m_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const member = (id = ALICE, realm = R) => ({ from: "alice-x", sender: { auth: "member", member: { id, name: "alice" }, realm } });
const shared = (name = "bot", realm = R) => ({ from: name, sender: { auth: "shared", realm } });
const legacy = (name = "old") => ({ from: name });

test("sender keys come from the recorded provenance only", () => {
  assert.deepEqual(senderKey(member()), { realm: R, member: ALICE, label: "member alice" });
  assert.deepEqual(senderKey(shared()), { realm: R, shared: true, name: "bot", label: "bot (shared token)" });
  assert.equal(senderKey(legacy()).unverified, true);
  assert.equal(senderKey({ ...legacy(), relayProfile: "relay-1" }).relay, "relay-1", "the relay recorded at arrival");
  // Values of the wrong type are never trusted as identity (a regex test would coerce them).
  assert.equal(senderKey({ from: "x", sender: { auth: "member", member: { id: [ALICE] }, realm: [R] } }).unverified, true);
  // A message without a realm on a member claim is not trusted as a member.
  assert.equal(senderKey({ from: "x", sender: { auth: "member", member: { id: ALICE } } }).unverified, true);
  assert.equal(keyId(senderKey(member())), `m|${R}|${ALICE}`);
  assert.notEqual(keyId(senderKey(shared("a"))), keyId(senderKey(shared("b"))));
});

test("policy matrix: grants, blocks, sessions, defaults and unverified senders", () => {
  const c = {
    ...freshContacts(),
    grants: [
      { realm: R, member: ALICE },
      { realm: R, shared: true, name: "bot" },
      { realm: R, member: "m_bbbbbbbbbbbbbbbbbbbbbbbbbb", session: { realm: R, name: "only-here" } },
    ],
    blocks: [{ realm: R, member: "m_cccccccccccccccccccccccccc" }, { realm: R, member: ALICE, session: { realm: R, name: "private" } }, { unverified: true, relay: "relay-1", name: "spammer" }],
  };
  const S = (name, realm = R) => ({ realm, name });
  assert.equal(decide(c, senderKey(member()), S("any")), "allow");
  assert.equal(decide(c, senderKey(member()), S("private")), "block", "block wins over allow");
  assert.equal(decide(c, senderKey(member()), S("private", R2)), "allow", "a session scope names its realm");
  assert.equal(decide(c, senderKey({ ...legacy("spammer"), relayProfile: "relay-1" }), S("x")), "block", "unverified blocks match relay profile and name");
  assert.equal(decide(c, senderKey({ ...legacy("spammer"), relayProfile: "relay-2" }), S("x")), "ask");
  assert.equal(decide(c, senderKey(member(ALICE, R2)), S("any")), "ask", "a grant is per realm");
  assert.equal(decide(c, senderKey(shared()), S("any")), "allow");
  assert.equal(decide(c, senderKey(shared("other")), S("any")), "ask", "shared grants name the exact sender");
  assert.equal(decide(c, senderKey(member("m_bbbbbbbbbbbbbbbbbbbbbbbbbb")), S("only-here")), "allow");
  assert.equal(decide(c, senderKey(member("m_bbbbbbbbbbbbbbbbbbbbbbbbbb")), S("elsewhere")), "ask");
  assert.equal(decide(c, senderKey(member("m_cccccccccccccccccccccccccc")), S("any")), "block");
  // A renamed member keeps its grant (the id is the key); a migrated id is a new contact.
  assert.equal(decide(c, senderKey({ from: "alicia-1", sender: { auth: "member", member: { id: ALICE, name: "alicia" }, realm: R } }), S("any")), "allow");
  assert.equal(decide(c, senderKey(member("name:alice")), S("any")), "ask");
  for (const d of ["ask", "allow", "block"]) assert.equal(decide({ ...c, default: d }, senderKey(member("m_dddddddddddddddddddddddddd")), S("x")), d);
  // Unverified senders never get more than "ask", and are blocked when either policy blocks.
  assert.equal(decide({ ...c, default: "allow" }, senderKey(legacy()), S("x")), "ask");
  assert.equal(decide({ ...c, unverified: "block" }, senderKey(legacy()), S("x")), "block");
  assert.equal(decide({ ...c, default: "block" }, senderKey(legacy()), S("x")), "block");
  // No usable file (managed mode): everyone waits.
  assert.equal(decide(null, senderKey(member()), S("x")), "ask");
});

test("validation follows the published schema", () => {
  assert.deepEqual(validateContacts(freshContacts()), []);
  assert.deepEqual(validateContacts({ ...freshContacts(), replies: { allowWithin: null } }), []);
  const schema = JSON.parse(fs.readFileSync(new URL("../schema/contacts.schema.json", import.meta.url), "utf8"));
  assert.equal(schema.properties.version.const, 1);
  const bad = [
    [{ version: 2, default: "ask" }, /version/],
    [{ version: 1, default: "maybe" }, /default/],
    [{ version: 1, default: "ask", unverified: "allow" }, /unverified/],
    [{ version: 1, default: "ask", extra: 1 }, /unknown field/],
    [{ version: 1, default: "ask", grants: [{ realm: "x", member: ALICE }] }, /realm/],
    [{ version: 1, default: "ask", grants: [{ realm: R }] }, /exactly one of/],
    [{ version: 1, default: "ask", grants: [{ realm: R, member: ALICE, shared: true, name: "x" }] }, /exactly one of/],
    [{ version: 1, default: "ask", grants: [{ realm: R, shared: true }] }, /shared-token entry/],
    [{ version: 1, default: "ask", grants: [{ realm: R, member: "alice" }] }, /member id/],
    [{ version: 1, default: "ask", blocks: [{ realm: R, member: ALICE, session: "bad name" }] }, /session must be/],
    [{ version: 1, default: "ask", replies: { allowWithin: 60 } }, /not supported yet/],
    [{ version: 1, default: "ask", grants: [{ unverified: true, relay: "relay-1", name: "x" }] }, /cannot get a grant/],
    [{ version: 1, default: "ask", blocks: [{ unverified: true, relay: "relay-1", name: "x", realm: R }] }, /no realm/],
    [{ version: 1, default: "ask", grants: [{ id: "b_aaaaaaaaaaaaaaaa", realm: R, member: ALICE }] }, /id must look like g_/],
    [{ version: 1, default: "allow", blocks: [{ realm: [R], member: ALICE }] }, /realm must be/],
    [{ version: 1, default: "allow", blocks: [{ realm: R, member: [ALICE] }] }, /member must be/],
    [{ version: 1, default: "allow", blocks: [{ realm: R, shared: true, name: ["x"] }] }, /shared-token entry/],
  ];
  for (const [doc, re] of bad) assert.match(validateContacts(doc).join("; "), re, JSON.stringify(doc));
});

test("reading: missing, unreadable, invalid JSON and schema problems are reported, never guessed", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hoptell-contacts-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const f = path.join(dir, "contacts.json");
  assert.match(readContacts(f).problem, /missing/);
  fs.writeFileSync(f, "{oops");
  assert.match(readContacts(f).problem, /not valid JSON/);
  fs.writeFileSync(f, JSON.stringify({ version: 1, default: "everyone" }));
  assert.match(readContacts(f).problem, /default/);
  fs.writeFileSync(f, JSON.stringify(freshContacts()));
  assert.equal(readContacts(f).problem, null);
});
