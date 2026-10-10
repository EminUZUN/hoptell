// Per-session device proofs at the relay (amendments 3.5 part 2, A9; review checklist G1),
// experimental: a connection proves a device's key (proof_challenge, then e2ee_attach or
// device_register with a SignWithLabel proof) before it acts for the device, and one guard covers
// every device-scoped frame of both families (KeyPackages and encrypted messages). A member's
// sign-in or token alone acts for none of its devices.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { DEVICE_CAP } from "../lib/relay.js";
import { ATTACH_PROOF_CAP, CHALLENGE_MS } from "../lib/mls/relayproof.js";
import { ATTACH_LABEL, REGISTER_LABEL, b64, makeRotation, pinIdentity, proofContent, unb64url } from "../lib/mls/identity.js";
import { KP_LIFETIME_MS } from "../lib/mls/policy.js";
import { deviceRelay, fakeDevice, newOp, proveOn, refusal } from "./mls-helpers.js";

const blob = (n = 48) => crypto.randomBytes(n).toString("base64");
const groupId = () => crypto.randomBytes(16).toString("hex");
let reqN = 0;
const reqId = () => `req-proof-${++reqN}-${crypto.randomBytes(3).toString("hex")}`;
const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));

/** Deliveries arriving on `client` (message_e2ee frames). */
function listen(client) {
  const got = [];
  client.on("message_e2ee", (m, ack) => got.push({ m, ack }));
  return got;
}

/**
 * alice (devices ad, ad2) and bob (device bd), registered and with KeyPackages through proven
 * connections; bob's device has a Welcome waiting (alice's conversation with bob).
 */
async function setup(t) {
  const w = await deviceRelay(t, { e2ee: true });
  const A = w.members.alice.id;
  const B = w.members.bob.id;
  const ad = await fakeDevice(w.realm, A);
  const ad2 = await fakeDevice(w.realm, A);
  const bd = await fakeDevice(w.realm, B);
  const conns = {};
  for (const [name, d, member] of [["ad", ad, "alice"], ["ad2", ad2, "alice"], ["bd", bd, "bob"]]) {
    const c = await w.client(member);
    await d.registerOn(c);
    await d.attachOn(c);
    await c.rpc({ type: "kp_upload", device: d.device, packages: await d.packages(4, w.clock.now() + KP_LIFETIME_MS) });
    conns[name] = c;
  }
  const take = (c, by, member, target) => c.rpc({ type: "kp_take", request: reqId(), device: by.device, target: { member, device: target.device } });
  const { reservation } = await take(conns.ad, ad, B, bd);
  const g = await conns.ad.rpc({ type: "group_create", op: newOp(), device: ad.device, peer: B, group: groupId(), epoch: 1, welcome: { recipients: [bd.device], mls: blob() }, kp_reservations: [reservation] });
  const counts = () => ({
    kps: w.db.get("SELECT count(*) AS n FROM key_packages").n,
    reservations: w.db.get("SELECT count(*) AS n FROM kp_reservations").n,
    ended: w.db.get("SELECT count(*) AS n FROM kp_reservations WHERE state <> 'reserved'").n,
    log: w.db.get("SELECT count(*) AS n FROM e2ee_log").n,
    queue: w.db.get("SELECT count(*) AS n FROM e2ee_queue").n,
    groups: w.db.get("SELECT count(*) AS n FROM e2ee_groups").n,
    revoked: w.db.get("SELECT count(*) AS n FROM device_revocations").n,
    invalid: w.db.get("SELECT count(*) AS n FROM e2ee_groups WHERE replace_required = 1").n,
  });
  return { w, A, B, ad, ad2, bd, conns, take, group: g.group, counts };
}

test("A9: the protocol-2 welcome carries a fresh connection id with the attach-proof capability", async (t) => {
  const w = await deviceRelay(t, { e2ee: true });
  const a = await w.client("alice");
  const b = await w.client("alice");
  assert.ok(a.caps.includes(DEVICE_CAP) && a.caps.includes(ATTACH_PROOF_CAP));
  assert.equal(unb64url(a.conn, 16)?.length, 16);
  assert.notEqual(a.conn, b.conn, "never reused");
  // Without the device service: neither the capability nor a connection id.
  const plain = await deviceRelay(t, { devices: false });
  const p = await plain.client("alice");
  assert.ok(!p.caps.includes(ATTACH_PROOF_CAP));
  assert.equal(p.conn, null);
});

test("A9: a correct proof attaches, and only then are the device's deliveries sent to the connection (a command's send-mode connection, attached, gets none)", async (t) => {
  const s = await setup(t);
  // A command (send mode) proven for the device acts for it but receives none of its deliveries.
  const cmd = await s.w.client("bob");
  const cmdGot = listen(cmd);
  assert.equal((await s.bd.attachOn(cmd)).type, "e2ee_attached");
  await settle();
  assert.equal(cmdGot.length, 0, "a send-mode connection receives nothing");
  const c = await s.w.client("bob", { session: "bob" });
  const got = listen(c);
  await settle();
  assert.equal(got.length, 0, "an unattached connection receives nothing");
  assert.equal((await s.bd.attachOn(c)).type, "e2ee_attached");
  await settle();
  assert.equal(got.length, 1, "the Welcome arrives after the proof");
  assert.equal(got[0].m.kind, "welcome");
});

test("A9: one guard for every device-scoped frame: an unattached connection and one attached as D1 naming D2 are refused and change nothing; the proven device works", async (t) => {
  const s = await setup(t);
  const { w, A, B, ad, ad2, bd } = s;
  const unattached = await w.client("alice");
  const asAd2 = await w.client("alice");
  await ad2.attachOn(asAd2);
  const { reservation: open } = await s.take(s.conns.ad, ad, B, bd);
  const kp = (await ad.packages(1, w.clock.now() + KP_LIFETIME_MS))[0];
  // Every frame names ad (alice's first device); each family's frames.
  const frames = {
    kp_upload: () => ({ type: "kp_upload", device: ad.device, packages: [kp] }),
    kp_status: () => ({ type: "kp_status", device: ad.device }),
    kp_take: () => ({ type: "kp_take", request: reqId(), device: ad.device, target: { member: B, device: bd.device } }),
    kp_abandon: () => ({ type: "kp_abandon", device: ad.device, reservation: open }),
    device_revoke: () => ({ type: "device_revoke", device: ad.device, by_device: ad.device, statement: null }),
    group_create: () => ({ type: "group_create", op: newOp(), device: ad.device, peer: w.members.carol.id, group: groupId(), epoch: 1, welcome: null, kp_reservations: [] }),
    group_replace: () => ({ type: "group_replace", op: newOp(), device: ad.device, peer: B, expected_generation: 1, group: groupId(), epoch: 1, welcome: null, kp_reservations: [] }),
    send_e2ee_commit: () => ({ type: "send_e2ee", kind: "commit", op: newOp(), device: ad.device, group: s.group, expected_epoch: 1, mls: blob(), roster_delta: { add: [], remove: [] }, kp_reservations: [] }),
    send_e2ee_app: () => ({ type: "send_e2ee", kind: "app", op: newOp(), device: ad.device, group: s.group, mls: blob(), target: "bob" }),
    commits_since: () => ({ type: "commits_since", device: ad.device, group: s.group, epoch: 1 }),
    commit_invalid: () => ({ type: "commit_invalid", device: ad.device, group: s.group, epoch: 1 }),
  };
  for (const [name, frame] of Object.entries(frames)) {
    const before = s.counts();
    assert.equal((await refusal(unattached.rpc(frame()))).code, "not_attached", `${name}: unattached`);
    assert.equal((await refusal(asAd2.rpc(frame()))).code, "not_attached", `${name}: attached as another device`);
    assert.deepEqual(s.counts(), before, `${name}: nothing changed`);
  }
  // The same frames work for the proven device (the destructive ones last).
  const ok = s.conns.ad;
  assert.equal((await ok.rpc(frames.kp_status())).type, "kp_status");
  assert.equal((await ok.rpc(frames.kp_upload())).accepted, 1);
  assert.equal((await ok.rpc(frames.kp_take())).type, "kp");
  assert.equal((await ok.rpc(frames.kp_abandon())).state, "burned");
  assert.equal((await ok.rpc(frames.commits_since())).type, "commits");
  assert.equal((await ok.rpc(frames.send_e2ee_app())).state, "accepted");
  assert.equal((await ok.rpc(frames.send_e2ee_commit())).state, "accepted");
  assert.equal((await ok.rpc(frames.commit_invalid())).type, "commit_invalid_recorded");
  assert.equal((await ok.rpc(frames.group_create())).type, "group");
  assert.equal((await ok.rpc({ ...frames.group_replace(), expected_generation: 1 })).generation, 2);
  // A device-signed revocation of ad2 by ad: acts for ad (by_device), on ad's connection only.
  const { makeRevocation } = await import("../lib/mls/identity.js");
  const statement = await makeRevocation({ realm: w.realm, member: A, device: ad2.device, by: ad.device, at: w.clock.now() }, (l, c) => ad.dev.sign(l, c));
  assert.equal((await refusal(asAd2.rpc({ type: "device_revoke", device: ad2.device, by_device: ad.device, statement }))).code, "not_attached");
  assert.equal((await ok.rpc({ type: "device_revoke", device: ad2.device, by_device: ad.device, statement })).state, "revoked");
  // Member queries need no attachment: device_list, conversation, member_of.
  assert.equal((await unattached.rpc({ type: "device_list" })).devices.length, 2);
  assert.equal((await unattached.rpc({ type: "conversation", peer: B })).generation, 2, "the replacement above");
});

test("A9: a member token alone (no key) cannot attach as the device, take its deliveries or touch its KeyPackages", async (t) => {
  const s = await setup(t);
  const { w, bd } = s;
  const thief = await w.client("bob", { session: "bob" });
  const got = listen(thief);
  // No proof (an older client's frame) and a proof by a key it holds (another device of bob's).
  assert.equal((await refusal(thief.rpc({ type: "e2ee_attach", device: bd.device }))).code, "attach_proof");
  assert.match((await refusal(thief.rpc({ type: "e2ee_attach", device: bd.device }))).message, /update/);
  const own = await fakeDevice(w.realm, w.members.bob.id, { device: bd.device }); // the same id, another key
  assert.equal((await refusal(thief.rpc({ type: "e2ee_attach", device: bd.device, proof: await own.proof(thief, "attach") }))).code, "attach_proof");
  for (const f of [{ type: "kp_status", device: bd.device }, { type: "kp_upload", device: bd.device, packages: await own.packages(1, w.clock.now() + KP_LIFETIME_MS) }, { type: "kp_take", request: reqId(), device: bd.device, target: { member: s.A, device: s.ad.device } }]) {
    assert.equal((await refusal(thief.rpc(f))).code, "not_attached", f.type);
  }
  await settle();
  assert.equal(got.length, 0, "no delivery reached it");
  assert.equal(w.ds.usage({ member: s.B, device: bd.device }).messages, 1, "the Welcome still waits for the device");
});

test("A9: refused proofs: another key, another connection's challenge, a reused, expired, failed or missing challenge, another device, another purpose or key", async (t) => {
  const s = await setup(t);
  const { w, A, ad, ad2 } = s;
  const c = await w.client("alice", { session: "alice-x" });
  const other = await w.client("alice");
  const got = listen(c);
  const attach = (proof, device = ad.device) => c.rpc({ type: "e2ee_attach", device, proof });
  const sign = async (purpose, conn, challenge, { dev = ad.dev, device = ad.device, key = null } = {}) => b64(await dev.sign(purpose === "register" ? REGISTER_LABEL : ATTACH_LABEL, proofContent({ purpose, realm: w.realm, member: A, device, key, conn: unb64url(conn, 16), challenge: unb64url(challenge, 32) })));
  const challenge = async (conn = c, purpose = "attach", device = ad.device, key) => (await conn.rpc({ type: "proof_challenge", purpose, device, ...(key ? { key: b64(key) } : {}) })).challenge;
  const refused = async (p, why) => assert.equal((await refusal(p)).code, "attach_proof", why);
  // Another key (ad2's, over ad's challenge).
  await refused(attach(await sign("attach", c.conn, await challenge(), { dev: ad2.dev })), "another key");
  // Another connection's challenge: issued to `other`, signed over `other`'s id, sent on c.
  const foreign = await challenge(other);
  await refused(attach(await sign("attach", other.conn, foreign)), "another connection's challenge");
  // The right challenge signed over another connection id.
  await refused(attach(await sign("attach", other.conn, await challenge())), "bound to another connection");
  // A failed attempt consumes the challenge: the correct signature over it is refused afterwards.
  const ch = await challenge();
  await refused(attach("A".repeat(88)), "a bad signature");
  await refused(attach(await sign("attach", c.conn, ch)), "consumed by the failed attempt");
  // Reused: a valid proof attaches once; the same proof again is refused (the challenge is gone).
  const ch2 = await challenge();
  const good = await sign("attach", c.conn, ch2);
  // ... first used for another device id, which consumes it.
  await refused(attach(good, ad2.device), "a challenge for another device");
  await refused(attach(good), "a reused challenge");
  // Expired (the relay's clock moves past 30 seconds).
  const ch3 = await challenge();
  w.clock.advance(CHALLENGE_MS + 1);
  await refused(attach(await sign("attach", c.conn, ch3)), "an expired challenge");
  // A register challenge cannot attach, and an attach challenge cannot register.
  const reg = await challenge(c, "register", ad.device, ad.key);
  await refused(attach(await sign("register", c.conn, reg, { key: ad.key })), "a register challenge used to attach");
  const att = await challenge();
  await refused(c.rpc({ ...ad.register(), proof: await sign("attach", c.conn, att) }), "an attach challenge used to register");
  // A register challenge for another key.
  const forOther = await challenge(c, "register", ad.device, ad2.key);
  await refused(c.rpc({ ...ad.register(), proof: await sign("register", c.conn, forOther, { key: ad.key }) }), "a register challenge for another key");
  // Only one outstanding: a newer challenge replaces the older one.
  const older = await challenge();
  await challenge();
  await refused(attach(await sign("attach", c.conn, older)), "a replaced challenge");
  // A missing proof.
  await refused(attach(undefined), "no proof");
  await settle();
  assert.equal(got.length, 0, "nothing was delivered to the refused connection");
  assert.equal((await refusal(c.rpc({ type: "kp_status", device: ad.device }))).code, "not_attached", "it stays unattached");
  // And the right proof, fresh, attaches.
  assert.equal((await ad.attachOn(c)).type, "e2ee_attached");
});

test("A9: registration needs possession of the key: no proof, or a proof by another key, is refused and nothing is registered", async (t) => {
  const w = await deviceRelay(t, { e2ee: true });
  const c = await w.client("alice");
  const d = await fakeDevice(w.realm, w.members.alice.id);
  const impostor = await fakeDevice(w.realm, w.members.alice.id);
  assert.equal((await refusal(c.rpc(d.register()))).code, "attach_proof", "no proof");
  // A proof by another key over a register challenge naming d's key.
  const ch = await c.rpc({ type: "proof_challenge", purpose: "register", device: d.device, key: b64(d.key) });
  const content = proofContent({ purpose: "register", realm: w.realm, member: w.members.alice.id, device: d.device, key: d.key, conn: unb64url(c.conn, 16), challenge: unb64url(ch.challenge, 32) });
  assert.equal((await refusal(c.rpc({ ...d.register(), proof: b64(await impostor.dev.sign(REGISTER_LABEL, content)) }))).code, "attach_proof");
  assert.equal((await c.rpc({ type: "device_list" })).devices.length, 0, "nothing registered");
  // With possession: registered; the same key again needs a proof too (an idempotent retry).
  assert.equal((await d.registerOn(c)).state, "enrolled");
  assert.equal((await refusal(c.rpc(d.register()))).code, "attach_proof");
  assert.equal((await d.registerOn(c)).state, "unchanged");
});

test("A9: after a rotation the old key no longer attaches; a connection attached before it is detached and refused until it proves with the new key", async (t) => {
  const s = await setup(t);
  const { w, B, bd } = s;
  const session = await w.client("bob", { session: "bob" });
  const got = listen(session);
  await bd.attachOn(session);
  await settle();
  got.splice(0).forEach((x) => x.ack());
  const cli = s.conns.bd; // attached before the rotation too
  // The rotation: registered with a proof by the new key, on a third connection.
  const next = await bd.driver.createDevice(bd.dev.identity);
  const newKey = Buffer.from(next.signaturePublicKey());
  const statement = await makeRotation({ realm: w.realm, member: B, device: bd.device, oldKey: bd.key, newKey, sequence: 1 }, (l, c) => bd.dev.sign(l, c), (l, c) => next.sign(l, c));
  const rot = await w.client("bob");
  const proof = await proveOn(rot, { realm: w.realm, member: B, device: bd.device, dev: next, key: newKey }, "register");
  assert.equal((await rot.rpc({ type: "device_register", device: bd.device, key: b64(newKey), pin: b64(pinIdentity({ realm: w.realm, member: B, device: bd.device, key: newKey })), rotation: statement, proof })).state, "rotated");
  // Both earlier attachments are dropped: frames refused, deliveries stop.
  assert.equal((await refusal(cli.rpc({ type: "kp_status", device: bd.device }))).code, "not_attached");
  assert.equal((await refusal(session.rpc({ type: "commits_since", device: bd.device, group: s.group, epoch: 1 }))).code, "not_attached");
  await s.conns.ad.rpc({ type: "send_e2ee", kind: "app", op: newOp(), device: s.ad.device, group: s.group, mls: blob(), target: "bob" });
  await settle();
  assert.equal(got.length, 0, "a connection proven with the old key gets nothing");
  // The old key cannot attach again; the new one can, and the waiting message arrives.
  assert.equal((await refusal(bd.attachOn(session))).code, "attach_proof");
  await session.rpc({ type: "e2ee_attach", device: bd.device, proof: await proveOn(session, { realm: w.realm, member: B, device: bd.device, dev: next }, "attach") });
  await settle();
  assert.equal(got.length, 1);
  assert.equal(got[0].m.kind, "app");
});

test("A9: a reconnect proves again: nothing carries over to a new connection, and an old proof does not attach it", async (t) => {
  const s = await setup(t);
  const { w, ad } = s;
  const first = await w.client("alice");
  const ch = await first.rpc({ type: "proof_challenge", purpose: "attach", device: ad.device });
  const content = proofContent({ purpose: "attach", realm: w.realm, member: s.A, device: ad.device, conn: unb64url(first.conn, 16), challenge: unb64url(ch.challenge, 32) });
  const proof = b64(await ad.dev.sign(ATTACH_LABEL, content));
  await first.rpc({ type: "e2ee_attach", device: ad.device, proof });
  first.close();
  const again = await w.client("alice");
  assert.equal((await refusal(again.rpc({ type: "kp_status", device: ad.device }))).code, "not_attached", "a new connection is unattached");
  assert.equal((await refusal(again.rpc({ type: "e2ee_attach", device: ad.device, proof }))).code, "attach_proof", "the old connection's proof does not attach it");
  await ad.attachOn(again);
  assert.equal((await again.rpc({ type: "kp_status", device: ad.device })).type, "kp_status");
});

test("A9: transfers refuse an unattached connection, and one whose attachment a rotation dropped", async (t) => {
  const w = await deviceRelay(t, { e2ee: true, transfers: true });
  const d = await fakeDevice(w.realm, w.members.alice.id);
  const c = await w.client("alice");
  await d.registerOn(c);
  const begin = () => ({ type: "upload_begin", transfer_id: crypto.randomBytes(16).toString("hex"), total_bytes: 10, chunk_count: 1, header_digest: crypto.randomBytes(32).toString("hex") });
  assert.equal((await refusal(c.rpc(begin()))).code, "not_attached");
  await d.attachOn(c);
  assert.equal((await c.rpc(begin())).type, "begun");
  const next = await d.driver.createDevice(d.dev.identity);
  const newKey = Buffer.from(next.signaturePublicKey());
  const statement = await makeRotation({ realm: w.realm, member: w.members.alice.id, device: d.device, oldKey: d.key, newKey, sequence: 1 }, (l, x) => d.dev.sign(l, x), (l, x) => next.sign(l, x));
  const rot = await w.client("alice");
  await rot.rpc({ type: "device_register", device: d.device, key: b64(newKey), pin: b64(pinIdentity({ realm: w.realm, member: w.members.alice.id, device: d.device, key: newKey })), rotation: statement, proof: await proveOn(rot, { realm: w.realm, member: w.members.alice.id, device: d.device, dev: next, key: newKey }, "register") });
  assert.equal((await refusal(c.rpc(begin()))).code, "not_attached");
});
