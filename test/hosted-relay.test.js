// Hosted custody at the relay (design 4.5): hosted members in the members file, the host
// credential, immutable custody, the custody label and provenance, and the hosted-custody fence
// (derived from the loaded policy; checked in reach before the gates and in contact requests).
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RelayClient } from "../lib/client.js";
import { createAccess } from "../lib/access.js";
import { startRelay, validateMembers } from "../lib/relay.js";
import { lockStateDir } from "../lib/realm.js";
import { openRelayDb } from "../lib/relaydb.js";
import { createDeviceDirectory } from "../lib/mls/relaydir.js";
import { RELAY_MIGRATIONS } from "../lib/relaystore.js";
import { fakeDevice } from "./mls-helpers.js";
import { sleep } from "./helpers.js";

const REALM = "e".repeat(32);
const ID = { alice: "m_aaaaaaaaaaaaaaaaaaaaaaaaaa", bob: "m_bbbbbbbbbbbbbbbbbbbbbbbbbb", hanna: "m_hhhhhhhhhhhhhhhhhhhhhhhhhh", hugo: "m_iiiiiiiiiiiiiiiiiiiiiiiiii" };
const IDP = "https://idp.example";
const tok = (n) => crypto.createHash("sha256").update(`token-${n}`).digest("hex");
const HOSTS = [
  { id: "h1", token: `sha256:${crypto.createHash("sha256").update(tok("host-h1")).digest("hex")}` },
  { id: "h2", token: tok("host-h2") },
];
const MEMBERS = [
  { name: "alice", id: ID.alice, token: tok("alice"), oidc: [{ issuer: IDP, subject: "alice" }] },
  { name: "bob", id: ID.bob, token: tok("bob") },
  { name: "hanna", id: ID.hanna, custody: "hosted", host: "h1" },
  { name: "hugo", id: ID.hugo, custody: "hosted", host: "h2" },
];
const POLICY = (o = {}) => ({ groups: {}, rules: [], defaultAction: "allow", requireGrants: false, ...o });
const FENCED = (o = {}) => POLICY({ groups: { claimed: { members: [], oidcGroups: [{ issuer: IDP, group: "x" }] } }, ...o });

async function setup(t, { policy = POLICY(), members = MEMBERS, hosts = HOSTS, token = null, devices = null } = {}) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "hoptell-hosted-relay-"));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const access = createAccess({ stateDir, policy });
  const logs = [];
  const start = () => startRelay({ host: "127.0.0.1", port: 0, token, members, hosts, realm: { id: REALM }, access, devices, log: (...a) => logs.push(a.join(" ")), sweepMs: 100_000 });
  let relay = await start();
  t.after(() => relay.close());
  const clients = [];
  t.after(() => clients.forEach((c) => c.close()));
  const open = async (o, got) => {
    const c = new RelayClient({ url: `ws://127.0.0.1:${relay.port}`, reconnect: false, ...o });
    clients.push(c);
    if (got) c.on("message", (m, confirm) => (got.push(m), confirm({ released: true })));
    await c.start().ready(5000);
    return c;
  };
  const s = {
    access,
    logs,
    get relay() {
      return relay;
    },
    open,
    connect: (who, got, mode = "peer") => open({ token: tok(who), name: mode === "send" ? `${who}-cli` : who, mode }, got),
    /** A host connection for one of its members (`host`: "h1" or "h2"). */
    host: (hostId, memberId, name, got, mode = "peer") => open({ token: tok(`host-${hostId}`), hostMember: memberId, name, mode }, got),
    async restart() {
      for (const c of clients.splice(0)) c.close();
      await relay.close();
      relay = await start();
    },
  };
  return s;
}
const refusal = (p) => p.then(() => "connected", (e) => e.message);
const sendTo = (c, to, text, extra = {}) => c.rpc({ type: "send", to, text, ...extra }).then((a) => ({ ok: true, a }), (e) => ({ ok: false, error: e.message }));
const until = async (fn, ms = 2000) => {
  for (let i = 0; i < ms / 20 && !fn(); i++) await sleep(20);
  return fn();
};

test("members file: hosted entries have no token or linked identity, name a listed host; one person may hold a local and a hosted member", () => {
  validateMembers(MEMBERS, HOSTS); // alice (linked at the relay) and hanna (hosted) are two member ids
  assert.throws(() => validateMembers([{ name: "x", id: ID.hanna, custody: "hosted", host: "h1", token: tok("x") }], HOSTS), /cannot have a token/);
  assert.throws(() => validateMembers([{ name: "x", id: ID.hanna, custody: "hosted", host: "h1", oidc: [{ issuer: IDP, subject: "s" }] }], HOSTS), /cannot have a token or linked/);
  assert.throws(() => validateMembers([{ name: "x", id: ID.hanna, custody: "hosted", host: "h9" }], HOSTS), /not listed in hosts/);
  assert.throws(() => validateMembers([{ name: "x", id: ID.hanna, custody: "local" }], HOSTS), /custody "hosted"/);
  assert.throws(() => validateMembers([{ name: "x", id: ID.hanna, token: tok("host-h2") }], HOSTS), /also used by a host/);
  assert.throws(() => validateMembers([], [HOSTS[0], { id: "h1", token: tok("other") }]), /listed twice/);
  assert.throws(() => validateMembers([], [{ id: "H!", token: tok("other") }]), /invalid host id/);
});

test("host credential: opens only members whose custody names that host", async (t) => {
  const s = await setup(t);
  const h = await s.host("h1", ID.hanna, "hanna");
  assert.ok(h.connected);
  // Host h1 for h2's member, for a local member, with a bad token: refused.
  assert.match(await refusal(s.host("h1", ID.hugo, "hugo")), /member not held by this host/);
  assert.match(await refusal(s.host("h1", ID.alice, "alice")), /member not held by this host/);
  assert.match(await refusal(s.open({ token: tok("nope"), hostMember: ID.hanna, name: "hanna" })), /bad token/);
  // The host token is not a member token, and the hosted member's names stay with its host.
  assert.match(await refusal(s.open({ token: tok("host-h1"), name: "hanna" })), /bad token/);
  // Name rules still apply to a host connection.
  assert.match(await refusal(s.host("h1", ID.hanna, "alice")), /name not allowed/);
});

test("a shared token cannot take a hosted member's names", async (t) => {
  const s = await setup(t, { token: tok("shared") });
  assert.match(await refusal(s.open({ token: tok("shared"), name: "hanna-x" })), /name not allowed/);
  await s.open({ token: tok("shared"), name: "other" });
});

test("custody label in list and custody provenance at the recipient; host connections send no device or grant frames", async (t) => {
  const s = await setup(t);
  const got = [];
  const bob = await s.connect("bob", got);
  const h = await s.host("h1", ID.hanna, "hanna");
  const peers = (await bob.list()).filter((p) => p.name === "hanna");
  assert.equal(peers[0].custody, "hosted");
  assert.equal(peers[0].member_id, ID.hanna, "a hosted peer's member id, for senders' encryption policies");
  assert.equal((await bob.list()).find((p) => p.name === "alice")?.custody, undefined);
  assert.ok((await sendTo(h, "bob", "hi")).ok);
  await until(() => got.length);
  assert.equal(got[0].sender.custody, "hosted");
  assert.equal(got[0].sender.member.id, ID.hanna);
  const err = await h.rpc({ type: "grants_put", base_revision: 0, grants: { default: "allow", entries: [] } }).then(() => null, (e) => e.code);
  assert.equal(err, "not_allowed");
});

test("immutable custody: a members reload never changes a member's custody; an unchanged reload keeps host connections", async (t) => {
  const s = await setup(t);
  const h = await s.host("h1", ID.hanna, "hanna");
  s.relay.reload(MEMBERS, HOSTS);
  await sleep(100);
  assert.ok(h.connected, "an unchanged reload keeps the host connection");
  assert.throws(() => s.relay.reload(MEMBERS.map((m) => (m.id === ID.hanna ? { name: "hanna", id: ID.hanna, token: tok("hanna") } : m)), HOSTS), /custody of "hanna" cannot change/);
  assert.throws(() => s.relay.reload(MEMBERS.map((m) => (m.id === ID.bob ? { name: "bob", id: ID.bob, custody: "hosted", host: "h1" } : m)), HOSTS), /custody of "bob" cannot change/);
  assert.throws(() => s.relay.reload(MEMBERS.map((m) => (m.id === ID.hanna ? { ...m, host: "h2" } : m)), HOSTS), /host of "hanna" cannot change/);
  // A changed host token ends that host's connections.
  s.relay.reload(MEMBERS, [{ id: "h1", token: tok("host-h1-new") }, HOSTS[1]]);
  await until(() => !h.connected);
  assert.equal(h.connected, false);
});

test("devices: a member with enrolled devices cannot be hosted; a hosted member cannot enroll one", async (t) => {
  const ddir = fs.mkdtempSync(path.join(os.tmpdir(), "hoptell-hosted-devices-"));
  const release = lockStateDir(ddir);
  const db = openRelayDb({ dir: ddir, migrations: RELAY_MIGRATIONS, fullfsync: false });
  t.after(() => (db.close(), release(), fs.rmSync(ddir, { recursive: true, force: true })));
  const directory = createDeviceDirectory({ db, realm: REALM });
  const d = await fakeDevice(REALM, ID.hanna);
  const reg = d.register();
  directory.register({ member: ID.hanna, device: d.device, key: Buffer.from(reg.key, "base64"), pin: Buffer.from(reg.pin, "base64"), rotation: null });
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "hoptell-hosted-relay-"));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  assert.throws(() => startRelay({ host: "127.0.0.1", port: 0, members: MEMBERS, hosts: HOSTS, realm: { id: REALM }, devices: { directory }, log: () => {} }), /has enrolled devices, so it cannot be hosted/);
  // Without hanna's devices the relay starts; the host's device frames are refused.
  const s = await setup(t, { members: MEMBERS.filter((m) => m.id !== ID.hanna), devices: { directory } });
  const h = await s.host("h2", ID.hugo, "hugo");
  const f = await fakeDevice(REALM, ID.hugo);
  assert.equal(await h.rpc(f.register()).then(() => "ok", (e) => e.code), "not_allowed");
  // A9: a hosted member has no device to prove: no challenge, no attachment (the host holds no
  // device key; a hosted device key would sign the same proof, but custody 4.5 enrolls none).
  for (const frame of [{ type: "proof_challenge", purpose: "attach", device: f.device }, { type: "proof_challenge", purpose: "register", device: f.device, key: f.key.toString("base64") }, { type: "e2ee_attach", device: f.device, proof: "x" }]) {
    assert.equal(await h.rpc(frame).then(() => "ok", (e) => e.code), "not_allowed", frame.type);
  }
});

test("hosted-custody fence: queued work is held under its original expiry; lifting it dispatches through the member gates", async (t) => {
  const s = await setup(t);
  const h = await s.host("h1", ID.hanna, "hanna");
  // bob is known to the relay, then offline.
  (await s.connect("bob")).close();
  await sleep(100);
  const queued = await sendTo(h, "bob", "held", { ttl: 3 });
  assert.equal(queued.a.state, "queued");
  // A reload adds a group with provider groups (and a deny for it): the fence goes up.
  s.access.setPolicy(FENCED({ rules: [{ from: "group:claimed", to: "*", action: "deny" }] }));
  await until(() => !h.connected);
  assert.equal(h.connected, false, "open hosted connections are cut");
  assert.equal(s.relay.stats().hostedFenced, 1);
  assert.equal(s.relay.stats().hostedHeld, 1);
  assert.ok(s.logs.some((l) => /hosted custody is fenced/.test(l)));
  // A new host connection is refused; bob reconnects and gets nothing.
  assert.match(await refusal(s.host("h1", ID.hanna, "hanna")), /fenced/);
  const got = [];
  await s.connect("bob", got);
  await sleep(200);
  assert.equal(got.length, 0, "held, not delivered");
  assert.equal(s.relay.stats().queueItems, 1, "still queued");
  // Lifting the fence dispatches it through the member gates (a static policy allows).
  s.access.setPolicy(POLICY());
  await until(() => got.length);
  assert.equal(got[0].text, "held");
});

test("hosted-custody fence: a held message expires at its original expiry", async (t) => {
  const s = await setup(t);
  const h = await s.host("h1", ID.hanna, "hanna");
  (await s.connect("bob")).close();
  await sleep(100);
  assert.equal((await sendTo(h, "bob", "short", { ttl: 1 })).a.state, "queued");
  s.access.setPolicy(FENCED());
  await sleep(1200);
  const got = [];
  await s.connect("bob", got);
  s.access.setPolicy(POLICY());
  await sleep(300);
  assert.equal(got.length, 0, "expired as any queued message");
  assert.equal(s.relay.stats().expired, 1);
});

test("hosted-custody fence: new sends, list, fan-out and contact requests treat hosted members as unknown; a start under the fenced policy starts fenced", async (t) => {
  const s = await setup(t);
  const h = await s.host("h1", ID.hanna, "hanna", undefined);
  h.on("message", (m, c) => c({ released: true }));
  const bob = await s.connect("bob");
  assert.ok((await bob.list()).some((p) => p.name === "hanna"));
  s.access.setPolicy(FENCED());
  await until(() => !h.connected);
  const unknown = await sendTo(bob, "nobody", "x");
  const fenced = await sendTo(bob, "hanna", "x");
  assert.equal(fenced.ok, false);
  assert.equal(fenced.error, unknown.error.replace("nobody", "hanna"), "the unknown-name answer");
  assert.ok(!(await bob.list()).some((p) => p.name === "hanna"), "not listed");
  const fan = await sendTo(bob, "@all", "x");
  assert.equal(fan.ok, false, "hanna is not a fan-out target (no other online peer)");
  // Restart under the fenced policy: fenced from the start, before any dispatch.
  await s.restart();
  assert.equal(s.relay.stats().hostedFenced, 1);
  assert.match(await refusal(s.host("h1", ID.hanna, "hanna")), /fenced/);
});

test("hosted-custody fence: a contact request to a hosted member answers as for an unknown name and is not stored", async (t) => {
  // requireGrants: hanna's gate 2 refuses by default, so a request to her is eligible unfenced.
  const s = await setup(t, { policy: POLICY({ requireGrants: true }) });
  const h = await s.host("h1", ID.hanna, "hanna");
  const bob = await s.connect("bob");
  await bob.rpc({ type: "contact_request", to: "hanna", reason: "collaborate" });
  assert.equal(s.access.requestsFor(ID.hanna).length, 1, "eligible while unfenced");
  s.access.setPolicy(FENCED({ requireGrants: true }));
  await until(() => !h.connected);
  const alice = await s.connect("alice");
  const r = await alice.rpc({ type: "contact_request", to: "hanna", reason: "collaborate" });
  const u = await alice.rpc({ type: "contact_request", to: "nobody", reason: "collaborate" });
  assert.equal(r.type, u.type);
  assert.equal(s.access.requestsFor(ID.hanna).filter((x) => x.from === ID.alice).length, 0, "not stored");
});

test("hosted-custody fence: a reply under an allowance is answered as unknown and the allowance is not used", async (t) => {
  // requireGrants: hanna's gate 2 refuses bob by default, so bob's reply needs an allowance.
  const s = await setup(t, { policy: POLICY({ requireGrants: true }) });
  const bob = await s.connect("bob");
  const cur = (await bob.rpc({ type: "grants_get" })).grants;
  await bob.rpc({ type: "grants_put", base_revision: cur.revision, grants: { default: "deny", entries: [{ selector: `member:${ID.hanna}`, action: "allow" }] } });
  const bobGot = [];
  bob.on("message", (m, confirm) => (bobGot.push(m), confirm({ released: true })));
  const h = await s.host("h1", ID.hanna, "hanna");
  const hGot = [];
  h.on("message", (m, confirm) => (hGot.push(m), confirm({ released: true })));
  const first = await sendTo(h, "bob", "question");
  await until(() => bobGot.length);
  s.access.setPolicy(FENCED({ requireGrants: true }));
  await until(() => !h.connected);
  const r = await sendTo(bob, "hanna", "answer", { reply_to: first.a.message_id });
  assert.equal(r.ok, false);
  assert.match(r.error, /unknown peer "hanna"/);
  // Lifted: the same allowance still works (it was not consumed while fenced).
  s.access.setPolicy(POLICY({ requireGrants: true }));
  const h2 = await s.host("h1", ID.hanna, "hanna");
  const got2 = [];
  h2.on("message", (m, confirm) => (got2.push(m), confirm({ released: true })));
  const again = await sendTo(bob, "hanna", "answer", { reply_to: first.a.message_id });
  assert.ok(again.ok, again.error);
  await until(() => got2.length);
  assert.equal(got2[0].text, "answer");
});

test("hosted-custody fence: a send to a hosted member takes the unknown-name path, timing included", async (t) => {
  const s = await setup(t);
  (await s.host("h1", ID.hanna, "hanna")).on("message", (m, c) => c({ released: true }));
  s.access.setPolicy(FENCED());
  await sleep(100);
  const bobs = await Promise.all([0, 1, 2, 3].map((n) => s.open({ token: tok("bob"), name: `bob-cli${n}`, mode: "send" })));
  const times = { unknown: [], hosted: [] };
  for (let i = 0; i < 100; i++) {
    for (const [k, to] of [["unknown", "nobody"], ["hosted", "hanna"]]) {
      const c = bobs[i % bobs.length];
      const t0 = process.hrtime.bigint();
      await sendTo(c, to, "x");
      times[k].push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
  }
  const median = (a) => a.toSorted((x, y) => x - y)[a.length >> 1];
  const [mu, mh] = [median(times.unknown), median(times.hosted)];
  assert.ok(Math.abs(mu - mh) < Math.max(0.5, 0.25 * Math.min(mu, mh)), `medians ${mu.toFixed(3)} ms (unknown) and ${mh.toFixed(3)} ms (hosted)`);
});

test("hoptell members: hosts are stored hashed; a hosted member is a new member, never linked or given devices at the relay", async (t) => {
  const { addHost, addHostedMember, addMember, linkMember, listHosts, listMembers, loadMembersAndHosts, removeHost } = await import("../lib/members.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hoptell-hosted-members-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "members.json");
  await addMember(file, "alice");
  await assert.rejects(addHostedMember(file, "hanna", "h1"), /no host "h1"/);
  const h = await addHost(file, "h1");
  assert.match(h.token, /^[0-9a-f]{64}$/);
  assert.ok(!fs.readFileSync(file, "utf8").includes(h.token), "only the hash is stored");
  assert.deepEqual(listHosts(file), [{ id: "h1", token: "hashed" }]);
  await addHostedMember(file, "hanna", "h1");
  await assert.rejects(addHostedMember(file, "alice", "h1"), /already exists/);
  await assert.rejects(linkMember(file, "hanna", { issuer: IDP, subject: "s" }), /cannot have a token or linked/);
  assert.equal(listMembers(file).find((m) => m.name === "hanna").custody, "hosted");
  await assert.rejects(removeHost(file, "h1"), /holds hanna/);
  const d = loadMembersAndHosts(file);
  assert.equal(d.hosts.length, 1);
  validateMembers(d.members, d.hosts);
});

test("hosted-custody fence: a hosted member is absent from an @role fan-out; the relay admin's view reports the fence, its reason and the held count", async (t) => {
  const s = await setup(t);
  const aliceGot = [];
  await s.open({ token: tok("alice"), name: "alice", roles: ["team"] }, aliceGot);
  const hGot = [];
  await s.open({ token: tok("host-h1"), hostMember: ID.hanna, name: "hanna", roles: ["team"] }, hGot);
  (await s.connect("bob")).close();
  await sleep(100);
  const bob = await s.connect("bob", null, "send");
  assert.equal((await sendTo(bob, "@team", "both")).a.count, 2, "unfenced: hanna is a candidate");
  // A message from hanna to offline bob, then the fence.
  const h2 = await s.host("h2", ID.hugo, "hugo");
  assert.equal((await sendTo(h2, "bob", "held")).a.state, "queued");
  assert.equal(s.relay.adminView().hosted.fenced, false);
  s.access.setPolicy(FENCED());
  await sleep(200);
  const r = await sendTo(bob, "@team", "fenced");
  assert.equal(r.a.count, 1, "hanna is not counted");
  await sleep(200);
  assert.deepEqual(hGot.map((m) => m.text), ["both"]);
  assert.deepEqual(aliceGot.map((m) => m.text), ["both", "fenced"]);
  const v = s.relay.adminView().hosted;
  assert.equal(v.fenced, true);
  assert.match(v.reason, /oidcGroups/);
  assert.equal(v.held, 1);
  assert.equal(v.members, 2);
});
