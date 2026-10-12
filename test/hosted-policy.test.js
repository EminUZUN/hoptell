// Encryption and custody policy toward hosted members (design 4.5): required always refuses
// (also with allow-hosted), preferred needs allow-hosted for a separate direct plaintext send, off
// sends; fan-outs under an encryption policy carry no hosted copy. Recipients may block hosted
// senders as a class (hosted: ask|block|allow) from the relay's custody provenance.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { RelayClient } from "../lib/client.js";
import { decide, senderKey, validateContacts } from "../lib/contacts.js";
import { sessionE2ee } from "../lib/mls/session.js";
import { E2EE_CAP, startRelay } from "../lib/relay.js";
import { sleep } from "./helpers.js";

const REALM = "e".repeat(32);
const BOB = "m_bbbbbbbbbbbbbbbbbbbbbbbbbb";
const HANNA = "m_hhhhhhhhhhhhhhhhhhhhhhhhhh";
const ALICE = "m_aaaaaaaaaaaaaaaaaaaaaaaaaa";

/** plan() over a scripted relay: `peers` maps names to {member, custody}. */
function planner(doc, peers, { caps = [E2EE_CAP] } = {}) {
  const relay = {
    caps,
    realm: { id: REALM },
    rpc: async ({ type, name }) => (type === "member_of" ? { member: peers[name]?.member ?? null, ...(peers[name]?.custody ? { custody: peers[name].custody } : {}) } : {}),
    list: async () => Object.entries(peers).map(([name, p]) => ({ name, ...(p.custody ? { custody: p.custody, ...(p.member ? { member_id: p.member } : {}) } : {}) })),
  };
  return sessionE2ee({ env: {}, home: "/nonexistent", profile: null, relay, contacts: { currentPolicy: () => ({ doc }) }, deliver: async () => {} });
}
const policy = (entries, extra = {}) => ({ version: 1, revision: 1, default: "ask", grants: [], blocks: [], encryption: entries, ...extra });
const PEERS = { hanna: { member: HANNA, custody: "hosted" }, alice: { member: ALICE } };

test("required toward a hosted member refuses, also with allow-hosted", async () => {
  for (const custody of [undefined, "allow-hosted"]) {
    const p = await planner(policy([{ realm: REALM, member: HANNA, mode: "required", ...(custody ? { custody } : {}) }]), PEERS).plan("hanna");
    assert.match(p.refuse, /^hosted custody: the host can read; not sent/, String(custody));
    assert.equal(p.encrypt, false);
  }
  // A realm default of required, too.
  assert.match((await planner(policy([{ realm: REALM, mode: "required" }]), PEERS).plan("hanna")).refuse, /hosted custody/);
});

test("preferred toward a hosted member: refused without allow-hosted; with it, one direct plaintext send, said so; off sends", async () => {
  const without = await planner(policy([{ realm: REALM, member: HANNA, mode: "preferred" }]), PEERS).plan("hanna");
  assert.match(without.refuse, /hosted custody.*allow-hosted/);
  const withIt = await planner(policy([{ realm: REALM, member: HANNA, mode: "preferred", custody: "allow-hosted" }]), PEERS).plan("hanna");
  assert.equal(withIt.refuse, null);
  assert.equal(withIt.encrypt, false);
  assert.match(withIt.note, /host can read/);
  const off = await planner(policy([{ realm: REALM, member: HANNA, mode: "off" }, { realm: REALM, member: ALICE, mode: "preferred" }]), PEERS).plan("hanna");
  assert.equal(off.refuse, null);
  // Without the e2ee capability the custody label of list decides; preferred cannot name the contact: refused.
  const noCap = await planner(policy([{ realm: REALM, mode: "preferred" }]), PEERS, { caps: [] }).plan("hanna");
  assert.match(noCap.refuse, /hosted custody/);
});

test("without the e2ee capability: a per-contact preferred policy toward a hosted member is refused (the member comes from list)", async () => {
  const peers = { hanna: { member: HANNA, custody: "hosted" } };
  const doc = policy([{ realm: REALM, member: HANNA, mode: "preferred" }]);
  const p = await planner(doc, peers, { caps: [] }).plan("hanna");
  assert.match(p.refuse ?? "", /hosted custody/, "never a silent plaintext send");
  // With allow-hosted for that contact: the separate plaintext send, said so.
  const ok = await planner(policy([{ realm: REALM, member: HANNA, mode: "preferred", custody: "allow-hosted" }]), peers, { caps: [] }).plan("hanna");
  assert.equal(ok.refuse, null);
  assert.match(ok.note, /host can read/);
  // Hosted, but the member cannot be resolved (an older relay): refused whenever the realm has a policy entry.
  const unresolved = await planner(policy([{ realm: REALM, member: ALICE, mode: "preferred" }]), { hanna: { custody: "hosted" } }, { caps: [] }).plan("hanna");
  assert.match(unresolved.refuse ?? "", /hosted custody/);
});

test("contacts: allow-hosted belongs to one contact's encryption entry; hosted is ask, block or allow", () => {
  assert.deepEqual(validateContacts(policy([{ realm: REALM, member: HANNA, mode: "preferred", custody: "allow-hosted" }], { hosted: "block" })), []);
  assert.match(validateContacts(policy([{ realm: REALM, mode: "preferred", custody: "allow-hosted" }]))[0], /custody must be "allow-hosted", for one contact/);
  assert.match(validateContacts(policy([{ realm: REALM, member: HANNA, mode: "preferred", custody: "yes" }]))[0], /custody/);
  assert.match(validateContacts(policy([], { hosted: "maybe" }))[0], /hosted must be/);
});

test("recipients: hosted senders as a class from the relay's provenance (ask needs a grant, block blocks, allow is any member)", () => {
  const msg = (custody) => ({ from: "hanna", sender: { auth: "member", member: { id: HANNA, name: "hanna" }, realm: REALM, ...(custody ? { custody } : {}) } });
  const k = senderKey(msg("hosted"));
  assert.equal(k.hosted, true);
  assert.equal(senderKey(msg()).hosted, undefined);
  const session = { realm: REALM, name: "bob" };
  const grant = [{ member: HANNA, realm: REALM }];
  assert.equal(decide(policy([], { default: "allow" }), k, session), "ask", "ask by default, even when the default allows");
  assert.equal(decide(policy([], { default: "allow", grants: grant }), k, session), "allow", "a grant for that member");
  assert.equal(decide(policy([], { hosted: "block", grants: grant }), k, session), "block");
  assert.equal(decide(policy([], { hosted: "allow", default: "allow" }), k, session), "allow");
  assert.equal(decide(policy([], { default: "allow" }), senderKey(msg()), session), "allow", "an ordinary member is unchanged");
});

test("relay: member_of names the custody; a fan-out with exclude_hosted carries no hosted copy", async (t) => {
  const tok = (n) => crypto.createHash("sha256").update(`token-${n}`).digest("hex");
  const members = [
    { name: "bob", id: BOB, token: tok("bob") },
    { name: "alice", id: ALICE, token: tok("alice") },
    { name: "hanna", id: HANNA, custody: "hosted", host: "h1" },
  ];
  const relay = await startRelay({ host: "127.0.0.1", port: 0, members, hosts: [{ id: "h1", token: tok("host") }], realm: { id: REALM }, log: () => {}, sweepMs: 100_000 });
  t.after(() => relay.close());
  const url = `ws://127.0.0.1:${relay.port}`;
  const clients = [];
  t.after(() => clients.forEach((c) => c.close()));
  const open = async (o) => {
    const c = new RelayClient({ url, reconnect: false, roles: ["team"], ...o });
    clients.push(c);
    c.got = [];
    c.on("message", (m, confirm) => (c.got.push(m), confirm({ released: true })));
    await c.start().ready(5000);
    return c;
  };
  const bob = await open({ token: tok("bob"), name: "bob" });
  const alice = await open({ token: tok("alice"), name: "alice" });
  const hanna = await open({ token: tok("host"), hostMember: HANNA, name: "hanna" });
  const a = await bob.send("@team", "to the team", undefined, undefined, { excludeHosted: true });
  assert.equal(a.count, 1);
  const b = await bob.send("@team", "plain fan-out");
  assert.equal(b.count, 2, "without a policy: as today");
  await sleep(200);
  assert.deepEqual(alice.got.map((m) => m.text), ["to the team", "plain fan-out"]);
  assert.deepEqual(hanna.got.map((m) => m.text), ["plain fan-out"]);
});
