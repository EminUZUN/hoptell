// Access (design 4.1/4.2): gates 1 and 2 at the relay, claim views, hidden discovery, reply
// allowances and contact requests. In-process relays with member tokens, a scripted identity
// provider and broker (their tokens are JSON the test controls), and an injected clock.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RelayClient } from "../lib/client.js";
import { createAccess } from "../lib/access.js";
import { startRelay } from "../lib/relay.js";
import { sleep } from "./helpers.js";

const ID = { alice: "m_aaaaaaaaaaaaaaaaaaaaaaaaaa", bob: "m_bbbbbbbbbbbbbbbbbbbbbbbbbb", carol: "m_cccccccccccccccccccccccccc", dave: "m_dddddddddddddddddddddddddd" };
const IDP = "https://idp.example";
const tok = (n) => crypto.createHash("sha256").update(`token-${n}`).digest("hex");
const members = Object.entries(ID).map(([name, id]) => ({ name, id, token: tok(name), oidc: [{ issuer: IDP, subject: name }] }));

/** A scripted provider: a token is JSON {sub, groups, iat, opaque}; `revoked` subjects fail rechecks. */
function fakeProvider() {
  const revoked = new Set();
  const answers = new Map(); // sub -> groups for the next recheck
  return {
    revoked,
    answers,
    verify: async (issuer, token, { fresh = false } = {}) => {
      const t = JSON.parse(token);
      if (fresh && revoked.has(t.sub)) throw Object.assign(new Error("inactive"), { code: "bad_token" });
      const groups = fresh && answers.has(t.sub) ? answers.get(t.sub) : (t.groups ?? []);
      return { issuer, subject: t.sub, deadline: Date.now() + 300_000, opaque: Boolean(t.opaque), checkedAt: Date.now(), groups, issuedAt: t.iat ?? null };
    },
  };
}
/** A scripted broker: a token is JSON {sub, family, groups, at}; `ended` families are not live. */
function fakeBroker() {
  const ended = new Set();
  return {
    ended,
    attach() {},
    reconcile() {},
    handles: () => false,
    familyLive: (id) => !ended.has(id),
    verifyAccess(issuerId, token) {
      const t = JSON.parse(token);
      if (ended.has(t.family)) throw Object.assign(new Error("ended"), { code: "token_expired" });
      return { issuer: IDP, issuerId, subject: t.sub, memberId: ID[t.sub], family: t.family, deadline: Date.now() + 300_000, verifiedAt: t.at, reverifyAt: t.at + 3_600_000, groups: t.groups ?? [] };
    },
  };
}

async function setup(t, { policy = null, token = null, stateDir = null, fault = null, revocationDelay = 300 } = {}) {
  stateDir ??= fs.mkdtempSync(path.join(os.tmpdir(), "hoptell-access-"));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const clock = { t: Date.now() };
  const access = createAccess({ stateDir, policy, now: () => clock.t, fault });
  const provider = fakeProvider();
  const broker = fakeBroker();
  const relay = await startRelay({ host: "127.0.0.1", port: 0, token, members, realm: { id: "e".repeat(32) }, access, oidc: { config: { issuers: [], maxRevocationDelaySeconds: revocationDelay }, verifier: provider, discovery: null, broker }, log: process.env.DEBUG_RELAY ? (...a) => console.log("RELAY", ...a) : () => {}, sweepMs: 100_000 });
  t.after(() => relay.close());
  const url = `ws://127.0.0.1:${relay.port}`;
  const clients = [];
  t.after(() => clients.forEach((c) => c.close()));
  const open = async ({ got, held = false, ...o }) => {
    const c = new RelayClient({ url, reconnect: false, ...o });
    clients.push(c);
    // A receiver's listener goes on before the hello: queued messages arrive right after it.
    if (got) c.on("message", (m, confirm) => (got.push(m), confirm({ released: !held })));
    await c.start().ready(5000);
    return c;
  };
  /** A member-token session (`mode` "send": a send-only client). */
  const connect = (who, mode = "peer", o = {}) => open({ token: tok(who), name: mode === "send" ? `${who}-cli${o.n ?? ""}` : who, mode, got: o.got, held: o.held });
  /** A session signed in at the scripted provider ({groups, iat, opaque}) or broker ({family, at}). */
  const signIn = (who, claims, mode = "peer", kind = "oidc") =>
    open({ signIn: async () => ({ kind, issuer: kind === "broker" ? "b1" : IDP, token: JSON.stringify({ sub: who, ...claims }), expiresAt: Date.now() + 300_000 }), name: mode === "send" ? `${who}-cli` : who, mode });
  return { relay, access, clock, url, connect, signIn, stateDir, provider, broker };
}
/** Messages a client receives, confirmed as released to its session (gate 3 passed) unless `held`. */
const inbox = (c, { held = false } = {}) => {
  const got = [];
  c.on("message", (m, confirm) => (got.push(m), confirm({ released: !held })));
  return got;
};
const until = async (fn, ms = 2000) => {
  for (let i = 0; i < ms / 20 && !fn(); i++) await sleep(20);
  return fn();
};
const sendTo = (c, to, text, extra = {}) => c.rpc({ type: "send", to, text, ...extra }).then((a) => ({ ok: true, a }), (e) => ({ ok: false, error: e.message }));
const publish = async (c, grants) => {
  const cur = (await c.rpc({ type: "grants_get" })).grants;
  return c.rpc({ type: "grants_put", base_revision: cur.revision, grants });
};
const B32 = "abcdefghijklmnopqrstuvwxyz234567";
const op = () => `o_${Array.from(crypto.randomBytes(26), (b) => B32[b & 31]).join("")}`;
const POLICY = (o = {}) => ({ groups: {}, rules: [], defaultAction: "allow", requireGrants: false, ...o });

test("without a policy or grants nothing changes", async (t) => {
  const s = await setup(t);
  const alice = await s.connect("alice");
  const got = inbox(alice);
  const bob = await s.connect("bob");
  assert.ok((await bob.list()).some((p) => p.name === "alice"));
  assert.equal((await sendTo(bob, "alice", "hi")).ok, true);
  assert.ok(await until(() => got.length === 1));
  assert.equal(s.access.active(), false);
});

test("gate 1: the admin policy; a refused peer answers like an unknown one", async (t) => {
  const s = await setup(t, { policy: POLICY({ groups: { reviewers: { members: [ID.carol] } }, rules: [{ from: `member:${ID.bob}`, to: `member:${ID.alice}`, action: "deny" }, { from: "group:reviewers", to: "*", action: "allow" }] }) });
  const alice = await s.connect("alice");
  const got = inbox(alice);
  const bob = await s.connect("bob");
  assert.equal((await bob.list()).some((p) => p.name === "alice"), false);
  const refused = await sendTo(bob, "alice", "hi");
  const unknown = await sendTo(bob, "nobody", "hi");
  assert.equal(refused.ok, false);
  assert.equal(refused.error.replace("alice", "X"), unknown.error.replace("nobody", "X"), "the same answer for refused and unknown");
  const carol = await s.connect("carol");
  assert.equal((await sendTo(carol, "alice", "from carol")).ok, true);
  assert.ok(await until(() => got.length === 1));
  assert.equal(got[0].access, undefined, "the relay's gate record is not sent to receivers");
});

test("gate 2: precedence, expiry, revisions (compare-and-swap, durable)", async (t) => {
  const s = await setup(t, { policy: POLICY({ groups: { team: { members: [ID.bob, ID.carol] } } }) });
  const alice = await s.connect("alice", "send");
  const bobs = await s.connect("bob");
  const carols = await s.connect("carol");
  inbox(await s.connect("alice"));
  await publish(alice, { default: "allow", visible: "all", entries: [{ selector: `member:${ID.bob}`, action: "deny" }] });
  assert.equal((await sendTo(bobs, "alice", "x")).ok, false);
  assert.equal((await sendTo(carols, "alice", "x")).ok, true);
  // A group allow plus a member deny: the member entry (more specific) wins.
  await publish(alice, { default: "deny", visible: "all", entries: [{ selector: "group:team", action: "allow" }, { selector: `member:${ID.bob}`, action: "deny" }] });
  assert.equal((await sendTo(bobs, "alice", "x")).ok, false);
  assert.equal((await sendTo(carols, "alice", "x")).ok, true);
  // Equal specificity: deny wins.
  await publish(alice, { default: "allow", visible: "all", entries: [{ selector: "*", action: "deny" }, { selector: `member:${ID.carol}`, action: "allow" }, { selector: `member:${ID.bob}`, action: "allow" }, { selector: `member:${ID.bob}`, action: "deny" }] });
  assert.equal((await sendTo(carols, "alice", "x")).ok, true);
  assert.equal((await sendTo(bobs, "alice", "x")).ok, false);
  // Expiry with no reload.
  await publish(alice, { default: "deny", visible: "all", entries: [{ selector: `member:${ID.bob}`, action: "allow", until: s.clock.t + 1000 }] });
  assert.equal((await sendTo(bobs, "alice", "x")).ok, true);
  s.clock.t += 2000;
  assert.equal((await sendTo(bobs, "alice", "x")).ok, false);
  const cur = (await alice.rpc({ type: "grants_get" })).grants;
  await assert.rejects(alice.rpc({ type: "grants_put", base_revision: cur.revision - 1, grants: { default: "allow", visible: "all", entries: [] } }), (e) => e.code === "stale");
  assert.equal(createAccess({ stateDir: s.stateDir }).grantsOf(ID.alice).revision, cur.revision, "durable");
  // A member publishes its own grants only (grants_put names no member): bob's are untouched.
  assert.equal(createAccess({ stateDir: s.stateDir }).grantsOf(ID.bob).revision, 0);
});

test("dispatch-time checks: a queued message whose grant expired is not delivered", async (t) => {
  const s = await setup(t, { policy: POLICY() });
  const alice = await s.connect("alice", "send");
  await publish(alice, { default: "deny", visible: "all", entries: [{ selector: `member:${ID.bob}`, action: "allow", until: s.clock.t + 1000 }] });
  (await s.connect("alice")).close();
  await sleep(100);
  const bob = await s.connect("bob");
  assert.equal((await sendTo(bob, "alice", "queued while allowed")).ok, true);
  s.clock.t += 2000;
  const got = [];
  await s.connect("alice", "peer", { got });
  await sleep(300);
  assert.equal(got.length, 0, "refused at dispatch");
});

test("claim views: newer versions only, conflicts, missing issue times and invalidations fail closed, staleness holds", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hoptell-views-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let now = 1_000_000;
  const policy = POLICY({ groups: { reviewers: { members: [], oidcGroups: [{ issuer: IDP, group: "reviewers" }] }, suspended: { members: [], oidcGroups: [{ issuer: IDP, group: "suspended" }] } }, rules: [{ from: "group:suspended", to: "*", action: "deny" }, { from: "group:reviewers", to: "*", action: "allow" }], defaultAction: "deny" });
  const a = createAccess({ stateDir: dir, policy, now: () => now });
  const bob = { memberId: ID.bob, identity: `${IDP}|bob` };
  const alice = { memberId: ID.alice };
  a.noteAuth(bob.identity, { version: 100, groups: [`${IDP}|reviewers`], freshUntil: now + 60_000, memberId: ID.bob });
  assert.equal(a.decide(bob, alice), "allow");
  a.noteAuth(bob.identity, { version: 200, groups: [], freshUntil: now + 60_000, memberId: ID.bob });
  assert.equal(a.decide(bob, alice), "deny", "T1: the group removed");
  a.noteAuth(bob.identity, { version: 100, groups: [`${IDP}|reviewers`], freshUntil: now + 60_000, memberId: ID.bob });
  assert.equal(a.decide(bob, alice), "deny", "an older authentication does not restore it");
  assert.equal(createAccess({ stateDir: dir, policy, now: () => now }).decide(bob, alice), "deny", "nor does a restart");
  // Equal versions with different claims: closed even though {} would pass the suspended deny.
  const carol = { memberId: ID.carol, identity: `${IDP}|carol` };
  a.noteAuth(carol.identity, { version: 300, groups: [`${IDP}|reviewers`, `${IDP}|suspended`], freshUntil: now + 60_000, memberId: ID.carol });
  a.noteAuth(carol.identity, { version: 300, groups: [`${IDP}|reviewers`], freshUntil: now + 60_000, memberId: ID.carol });
  assert.equal(a.decide(carol, alice), "deny");
  a.noteAuth(carol.identity, { version: 301, groups: [`${IDP}|reviewers`], freshUntil: now + 60_000, memberId: ID.carol });
  assert.equal(a.decide(carol, alice), "allow", "a strictly newer authentication resolves it");
  // A token without an issue time cannot be ordered: closed until a versioned one.
  a.noteAuth(carol.identity, { version: null, groups: [`${IDP}|reviewers`], memberId: ID.carol });
  assert.equal(a.decide(carol, alice), "deny");
  a.noteAuth(carol.identity, { version: 302, groups: [`${IDP}|reviewers`], freshUntil: now + 60_000, memberId: ID.carol });
  assert.equal(a.decide(carol, alice), "allow");
  now += 120_000;
  assert.equal(a.decide(carol, alice), "hold", "stale: held, not treated as an empty claim set");
  a.invalidate(carol.identity, "signed out");
  assert.equal(a.decide(carol, alice), "deny");
  // No freshness bound: kept as such across a restart (not "stale").
  a.noteAuth(`${IDP}|dave`, { version: 5, groups: [`${IDP}|reviewers`], memberId: ID.dave });
  assert.equal(createAccess({ stateDir: dir, policy, now: () => now + 10 * 86_400_000 }).viewOf(`${IDP}|dave`).state, "ok");
});

test("hidden members: unreachable peers are not listed, answer as unknown, and fan-out counts only", async (t) => {
  const s = await setup(t);
  await publish(await s.connect("alice", "send"), { default: "deny", visible: "grantees", entries: [{ selector: `member:${ID.carol}`, action: "allow" }] });
  const got = inbox(await s.connect("alice"));
  const bob = await s.connect("bob");
  const carol = await s.connect("carol");
  assert.equal((await bob.list()).some((p) => p.name === "alice"), false);
  assert.ok((await carol.list()).some((p) => p.name === "alice"));
  const refused = await sendTo(bob, "alice", "x");
  const unknown = await sendTo(bob, "nobody", "x");
  assert.equal(refused.error.replace("alice", "X"), unknown.error.replace("nobody", "X"));
  const fan = await bob.rpc({ type: "send", to: "@all", text: "hello all" });
  assert.equal(fan.skipped, undefined, "no skipped names");
  assert.equal(fan.count, 1, "carol only");
  await sleep(200);
  assert.equal(got.length, 0);
  await assert.rejects(async () => startRelay({ host: "127.0.0.1", port: 0, token: "s".repeat(64), members, access: s.access, log: () => {} }), /hidden members/);
});

test("hidden discovery timing: unknown and unreachable names take the same path", async (t) => {
  const s = await setup(t);
  await publish(await s.connect("alice", "send"), { default: "deny", visible: "grantees", entries: [{ selector: `member:${ID.carol}`, action: "allow" }, ...Array.from({ length: 50 }, (_, i) => ({ selector: `group:g${i}`, action: "allow" }))] });
  inbox(await s.connect("alice"));
  const bobs = await Promise.all([0, 1, 2, 3, 4, 5, 6].map((n) => s.connect("bob", "send", { n })));
  const times = { unknown: [], unreachable: [] };
  for (let i = 0; i < 100; i++) {
    for (const [k, to] of [["unknown", "nobody"], ["unreachable", "alice"]]) {
      const c = bobs[i % bobs.length];
      const t0 = process.hrtime.bigint();
      await sendTo(c, to, "x");
      times[k].push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
  }
  const median = (a) => a.toSorted((x, y) => x - y)[a.length >> 1];
  const [mu, mr] = [median(times.unknown), median(times.unreachable)];
  // Loopback round trips: the medians must be indistinguishable at this resolution.
  assert.ok(Math.abs(mu - mr) < Math.max(0.5, 0.25 * Math.min(mu, mr)), `medians ${mu.toFixed(3)} ms (unknown) and ${mr.toFixed(3)} ms (unreachable)`);
});

test("reply allowance: only after local release, once per message, bound to the operation, revalidated at dispatch", async (t) => {
  const s = await setup(t, { policy: POLICY() });
  const aliceCli = await s.connect("alice", "send");
  await publish(aliceCli, { default: "deny", visible: "all", entries: [] });
  const alice = await s.connect("alice");
  const aliceGot = inbox(alice);
  const bob = await s.connect("bob");
  const bobGot = inbox(bob);
  const sent = await alice.rpc({ type: "send", to: "bob", text: "question" });
  assert.ok(await until(() => bobGot.length === 1));
  await sleep(100);
  assert.equal((await sendTo(bob, "alice", "unprompted")).ok, false);
  // Two sessions of bob, one operation id: the same payload is the same reply; another is refused.
  const bob2 = await s.connect("bob", "send");
  const o = op();
  const r1 = await sendTo(bob, "alice", "answer", { reply_to: sent.message_id, op: o });
  const r2 = await sendTo(bob2, "alice", "answer", { reply_to: sent.message_id, op: o });
  const r3 = await sendTo(bob2, "alice", "other answer", { reply_to: sent.message_id, op: o });
  assert.equal(r1.ok, true, r1.error);
  assert.equal(r2.ok, true, r2.error);
  assert.equal(r2.a.message_id, r1.a.message_id, "the first result");
  assert.equal(r3.ok, false, "different bytes under the same operation");
  assert.ok(await until(() => aliceGot.length === 1));
  await sleep(150);
  assert.equal(aliceGot.length, 1, "delivered once");
  assert.equal((await sendTo(bob2, "alice", "second", { reply_to: sent.message_id, op: op() })).ok, false, "used once");
  // A restart keeps it used.
  assert.equal(createAccess({ stateDir: s.stateDir, policy: POLICY() }).useAllowance(ID.bob, ID.alice, sent.message_id, { op: op(), digest: "d", messageId: "m" }).use, "refused");

  // Held back by bob's contacts (released: false): no allowance.
  bob.close();
  await sleep(100);
  const bobHeld = await s.connect("bob");
  const heldGot = inbox(bobHeld, { held: true });
  const sent2 = await alice.rpc({ type: "send", to: "bob", text: "while held" });
  assert.ok(await until(() => heldGot.length === 1));
  await sleep(100);
  assert.equal((await sendTo(bob2, "alice", "reply", { reply_to: sent2.message_id })).ok, false);

  // A queued reply is revalidated at dispatch and delivered; a group deny cancels an allowance.
  bobHeld.close();
  await sleep(100);
  const bob3 = await s.connect("bob");
  const bob3Got = inbox(bob3);
  const sent3 = await alice.rpc({ type: "send", to: "bob", text: "third" });
  assert.ok(await until(() => bob3Got.length === 1));
  await sleep(100);
  alice.close();
  await sleep(100);
  assert.equal((await sendTo(bob3, "alice", "queued reply", { reply_to: sent3.message_id })).ok, true);
  const backGot = [];
  const back = await s.connect("alice", "peer", { got: backGot });
  assert.ok(await until(() => backGot.some((m) => m.text === "queued reply")), "a queued reply is delivered on reconnect");
  const sent4 = await back.rpc({ type: "send", to: "bob", text: "fourth" });
  assert.ok(await until(() => bob3Got.length === 2));
  await sleep(100);
  s.access.setPolicy(POLICY({ groups: { bobs: { members: [ID.bob] } } }));
  await publish(aliceCli, { default: "deny", visible: "all", entries: [{ selector: "group:bobs", action: "deny" }] });
  assert.equal((await sendTo(bob3, "alice", "after a group deny", { reply_to: sent4.message_id })).ok, false);
});

test("reply allowance: a full queue does not use it", async (t) => {
  const s = await setup(t, { policy: POLICY() });
  const aliceCli = await s.connect("alice", "send");
  await publish(aliceCli, { default: "deny", visible: "all", entries: [{ selector: `member:${ID.carol}`, action: "allow" }] });
  const alice = await s.connect("alice");
  const bobGot = inbox(await s.connect("bob"));
  const sent = await alice.rpc({ type: "send", to: "bob", text: "question" });
  assert.ok(await until(() => bobGot.length === 1));
  await sleep(100);
  alice.close();
  await sleep(100);
  const carols = await Promise.all([0, 1].map((n) => s.connect("carol", "send", { n })));
  for (let i = 0; i < 50; i++) assert.equal((await sendTo(carols[i % 2], "alice", `fill ${i}`)).ok, true);
  const bob = await s.connect("bob", "send");
  assert.equal((await sendTo(bob, "alice", "reply", { reply_to: sent.message_id })).ok, false, "queue full");
  const got = [];
  await s.connect("alice", "peer", { got });
  assert.ok(await until(() => got.length === 50, 5000));
  const late = await sendTo(bob, "alice", "reply", { reply_to: sent.message_id });
  assert.equal(late.ok, true, `still unused: ${late.error}`);
});

test("contact requests: gate 1 first, the same answer for any target, blocking from the grants", async (t) => {
  const s = await setup(t, { policy: POLICY({ rules: [{ from: `member:${ID.dave}`, to: "*", action: "deny" }] }) });
  const aliceCli = await s.connect("alice", "send");
  await publish(aliceCli, { default: "deny", visible: "all", entries: [] });
  const alice = await s.connect("alice");
  const notices = [];
  alice.on("notice", (n) => notices.push(n));
  const bob = await s.connect("bob");
  const r1 = await bob.rpc({ type: "contact_request", to: "alice", reason: "review" });
  const r2 = await bob.rpc({ type: "contact_request", to: "nobody", reason: "review" });
  assert.deepEqual({ ...r1, id: 0 }, { ...r2, id: 0 }, "the same answer");
  await assert.rejects(bob.rpc({ type: "contact_request", to: "alice", reason: "please read this" }), (e) => e.code === "bad_request", "free text refused");
  assert.ok(await until(() => notices.length === 1));
  const list = (await aliceCli.rpc({ type: "contact_requests" })).requests;
  assert.deepEqual(list.map((r) => [r.from, r.reason]), [[ID.bob, "review"]]);
  // Gate 1 refuses dave: the same answer, nothing recorded.
  const dave = await s.connect("dave");
  assert.deepEqual({ ...(await dave.rpc({ type: "contact_request", to: "alice", reason: "other" })), id: 0 }, { ...r1, id: 0 });
  assert.equal((await aliceCli.rpc({ type: "contact_requests" })).requests.length, 1);
  assert.equal((await sendTo(bob, "alice", "before")).ok, false);
  await aliceCli.rpc({ type: "contact_request_answer", request: list[0].id, action: "accept" });
  assert.equal((await sendTo(bob, "alice", "after")).ok, true);
  // deny-forever as the grants command writes it (no separate list): requests stop...
  const carol = await s.connect("carol");
  await publish(aliceCli, { ...(await aliceCli.rpc({ type: "grants_get" })).grants, entries: [{ selector: `member:${ID.bob}`, action: "allow" }, { selector: `member:${ID.carol}`, action: "deny", requests: "blocked" }] });
  await carol.rpc({ type: "contact_request", to: "alice", reason: "other" });
  assert.equal((await aliceCli.rpc({ type: "contact_requests" })).requests.length, 0);
  // ...and start again once the owner removes that entry.
  await publish(aliceCli, { ...(await aliceCli.rpc({ type: "grants_get" })).grants, entries: [{ selector: `member:${ID.bob}`, action: "allow" }] });
  await carol.rpc({ type: "contact_request", to: "alice", reason: "other" });
  assert.equal((await aliceCli.rpc({ type: "contact_requests" })).requests.length, 1);
});

test("sign-ins: every mode is gated by the claim view, also send-only clients and tokens without an issue time", async (t) => {
  const s = await setup(t, { policy: POLICY({ groups: { suspended: { members: [], oidcGroups: [{ issuer: IDP, group: "suspended" }] } }, rules: [{ from: "group:suspended", to: "*", action: "deny" }] }) });
  const got = inbox(await s.connect("alice"));
  const peer = await s.signIn("bob", { groups: ["suspended"], iat: s.clock.t });
  assert.equal((await sendTo(peer, "alice", "as a peer")).ok, false);
  peer.close();
  const cli = await s.signIn("bob", { groups: ["suspended"], iat: s.clock.t }, "send");
  assert.equal((await sendTo(cli, "alice", "send-only")).ok, false, "a send-only client is gated too");
  const broker = await s.signIn("carol", { family: "f1", groups: ["suspended"], at: s.clock.t }, "send", "broker");
  assert.equal((await sendTo(broker, "alice", "broker send-only")).ok, false);
  const noIat = await s.signIn("dave", { groups: [] }, "send");
  assert.equal((await sendTo(noIat, "alice", "no iat")).ok, false, "unordered: closed while access is active");
  await sleep(150);
  assert.equal(got.length, 0);
});

test("recipient groups come from the recipient's claim view", async (t) => {
  const s = await setup(t, { policy: POLICY({ groups: { protected: { members: [], oidcGroups: [{ issuer: IDP, group: "protected" }] } }, rules: [{ from: "*", to: "group:protected", action: "deny" }] }) });
  inbox(await s.signIn("alice", { groups: ["protected"], iat: s.clock.t }));
  const bob = await s.connect("bob");
  assert.equal((await sendTo(bob, "alice", "x")).ok, false);
  assert.equal((await bob.list()).some((p) => p.name === "alice"), false);
});

test("ended broker families and changed provider claims stop their messages, also queued ones", async (t) => {
  const s = await setup(t, { policy: POLICY({ groups: { suspended: { members: [], oidcGroups: [{ issuer: IDP, group: "suspended" }] } }, rules: [{ from: "group:suspended", to: "*", action: "deny" }] }) });
  (await s.connect("alice")).close();
  await sleep(100);
  // A broker family queues a message, then ends (logout or replay): the message is dropped.
  const b = await s.signIn("bob", { family: "f9", at: s.clock.t }, "send", "broker");
  const queuedFromFamily = await sendTo(b, "alice", "from an ended family");
  assert.equal(queuedFromFamily.ok, true, queuedFromFamily.error);
  b.close();
  s.broker.ended.add("f9");
  // A concurrent provider session of the same member keeps going.
  const p = await s.signIn("bob", { iat: s.clock.t + 1 }, "send");
  assert.equal((await sendTo(p, "alice", "provider session")).ok, true);
  const got = [];
  await s.connect("alice", "peer", { got });
  assert.ok(await until(() => got.length >= 1));
  await sleep(150);
  assert.deepEqual(got.map((m) => m.text), ["provider session"]);
  // An introspected token rechecked with other groups at the same issue time: a conflict (closed).
  const o = await s.signIn("carol", { iat: s.clock.t, opaque: true }, "send");
  s.access.noteAuth(`${IDP}|carol`, { version: s.clock.t, groups: [`${IDP}|suspended`], memberId: ID.carol });
  assert.equal(s.access.viewOf(`${IDP}|carol`).state, "closed");
  assert.equal((await sendTo(o, "alice", "x")).ok, false);
});

test("held messages go when the sender's view is renewed, without other traffic", async (t) => {
  const s = await setup(t, { policy: POLICY() });
  (await s.connect("alice")).close();
  await sleep(100);
  const b = await s.signIn("bob", { iat: s.clock.t }, "send");
  assert.equal((await sendTo(b, "alice", "queued while fresh")).ok, true);
  // The view's freshness bound is the token's deadline: past it, dispatch holds the message.
  s.clock.t += 400_000;
  const got = [];
  await s.connect("alice", "peer", { got });
  await sleep(150);
  assert.equal(got.length, 0, "held");
  s.access.noteAuth(`${IDP}|bob`, { version: s.clock.t, groups: [], freshUntil: s.clock.t + 300_000, memberId: ID.bob });
  assert.ok(await until(() => got.length === 1), "delivered after the renewal");
});

test("a members reload closes the claim views of removed members and unlinked identities", async (t) => {
  const s = await setup(t);
  const linked = members.map((m) => (m.name === "bob" ? { ...m, oidc: [{ issuer: IDP, subject: "bob" }, { issuer: IDP, subject: "bob2" }] } : m));
  s.relay.reload(linked);
  for (const [i, who] of [["bob", ID.bob], ["bob2", ID.bob], ["carol", ID.carol], ["alice", ID.alice]]) s.access.noteAuth(`${IDP}|${i}`, { version: 1000, groups: [], memberId: who });
  s.relay.reload(linked.filter((m) => m.name !== "carol").map((m) => (m.name === "bob" ? { ...m, oidc: [{ issuer: IDP, subject: "bob" }] } : m)));
  assert.equal(s.access.viewOf(`${IDP}|bob`).state, "ok");
  assert.equal(s.access.viewOf(`${IDP}|bob2`).state, "closed", "unlinked");
  assert.equal(s.access.viewOf(`${IDP}|carol`).state, "closed", "removed");
  assert.equal(s.access.viewOf(`${IDP}|alice`).state, "ok");
  assert.equal(createAccess({ stateDir: s.stateDir }).viewOf(`${IDP}|carol`).state, "closed", "durable");
});

test("durability: memory follows the file after a failed write; closings stay applied until written", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hoptell-durable-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let failAt = null;
  const fault = (point, file) => {
    if (failAt && point === failAt.point && file.includes(failAt.file)) {
      failAt = null;
      throw Object.assign(new Error(`injected ${point}`), { code: "EIO" });
    }
  };
  const a = createAccess({ stateDir: dir, policy: POLICY(), fault });
  a.putGrants(ID.alice, 0, { default: "allow", visible: "all", entries: [] });
  // The replace happened, the folder sync failed: memory follows the file (the deny), and the
  // caller is told the outcome is unknown.
  failAt = { point: "dir-fsync", file: "access" };
  assert.throws(() => a.putGrants(ID.alice, 1, { default: "deny", visible: "all", entries: [] }), (e) => e.code === "unavailable");
  assert.equal(a.grantsOf(ID.alice).revision, 2);
  assert.equal(a.decide({ memberId: ID.bob }, { memberId: ID.alice }), "deny");
  // Before the replace: nothing changed anywhere.
  failAt = { point: "rename", file: "grants" };
  assert.throws(() => a.putGrants(ID.alice, 2, { default: "allow", visible: "all", entries: [] }), (e) => e.code === "unavailable");
  assert.equal(a.grantsOf(ID.alice).revision, 2);
  // An invalidation whose write fails is applied at once and retried until written.
  a.noteAuth(`${IDP}|bob`, { version: 10, groups: [], memberId: ID.bob });
  failAt = { point: "rename", file: "claims" };
  a.invalidate(`${IDP}|bob`, "signed out");
  assert.equal(a.viewOf(`${IDP}|bob`).state, "closed", "applied although not written");
  assert.equal(createAccess({ stateDir: dir }).viewOf(`${IDP}|bob`).state, "ok", "not on disk yet");
  a.invalidate(`${IDP}|bob`, "signed out"); // the retry is not a no-op
  assert.equal(createAccess({ stateDir: dir }).viewOf(`${IDP}|bob`).state, "closed", "written by the retry");
  // A shape it does not know refuses to load.
  fs.writeFileSync(path.join(dir, "access", "allowances.json"), JSON.stringify({ v: 2, entries: [] }));
  assert.throws(() => createAccess({ stateDir: dir }), /unknown version or shape/);
});

test("cleanup: expired requests leave the files with time alone", async (t) => {
  const s = await setup(t, { policy: POLICY() });
  const aliceCli = await s.connect("alice", "send");
  await publish(aliceCli, { default: "deny", visible: "all", entries: [] });
  await s.connect("alice");
  const bob = await s.connect("bob");
  await bob.rpc({ type: "contact_request", to: "alice", reason: "review" });
  const file = path.join(s.stateDir, "access", "requests.json");
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).pending.length, 1);
  s.clock.t += 8 * 86_400_000;
  s.access.sweep();
  const after = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(after.pending.length, 0);
  assert.deepEqual(after.sent, {});
});

test("strict realms refuse protocol-1 clients", async (t) => {
  const s = await setup(t, { policy: POLICY({ requireGrants: true }) });
  const c = new RelayClient({ url: s.url, token: tok("bob"), name: "bob", protocol: 1, reconnect: false });
  t.after(() => c.close());
  await assert.rejects(c.start().ready(3000));
});

test("per-sender byte quota across recipients", async (t) => {
  const s = await setup(t);
  for (const who of ["alice", "carol", "dave"]) (await s.connect(who)).close();
  await sleep(100);
  // 50,000 four-byte characters: 200,000 bytes each; 20 MiB is about 104 of them.
  const big = "😀".repeat(50_000);
  const bobs = await Promise.all([0, 1, 2, 3].map((n) => s.connect("bob", "send", { n })));
  let accepted = 0;
  let refused = null;
  for (let i = 0; i < 110 && !refused; i++) {
    const r = await sendTo(bobs[i % 4], ["alice", "carol", "dave"][i % 3], big);
    r.ok ? accepted++ : (refused = r.error);
  }
  assert.ok(refused && /queue is full/.test(refused), `refused after ${accepted}: ${refused}`);
  assert.equal(accepted, Math.floor((20 * 1024 * 1024) / 200_000));
  assert.equal((await sendTo(await s.connect("dave", "send"), "alice", "small")).ok, true, "another sender has its own quota");
});

test("relay --policy: a bad policy file stops startup with a fixed message", async () => {
  const { execFileSync } = await import("node:child_process");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hoptell-policy-"));
  try {
    fs.writeFileSync(path.join(dir, "policy.json"), JSON.stringify({ v: 1, rules: [{ from: "nobody", to: "*", action: "allow" }] }));
    const bin = new URL("../bin/hoptell.js", import.meta.url).pathname;
    let out = "";
    try {
      execFileSync(process.execPath, [bin, "relay", "--host", "127.0.0.1", "--port", "0", "--state-dir", path.join(dir, "state"), "--policy", path.join(dir, "policy.json")], { env: { ...process.env, HOPTELL_TOKEN: "t".repeat(64), HOPTELL_MEMBERS: "" }, stdio: "pipe", timeout: 10_000 });
    } catch (e) {
      out = `${e.stdout}${e.stderr}`;
    }
    assert.match(out, /rules must be/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the shared-token invariant: hiding is refused on a relay with a shared token, also for members without ids", async (t) => {
  const s = await setup(t, { token: "s".repeat(64) });
  const alice = await s.connect("alice", "send");
  await assert.rejects(publish(alice, { default: "allow", visible: "grantees", entries: [] }), (e) => e.code === "not_allowed");
  const legacy = [{ name: "dora", token: tok("dora") }];
  createAccess({ stateDir: s.stateDir }).putGrants("name:dora", 0, { default: "allow", visible: "grantees", entries: [] });
  await assert.rejects(async () => startRelay({ host: "127.0.0.1", port: 0, token: "s".repeat(64), members: legacy, access: createAccess({ stateDir: s.stateDir }), log: () => {} }), /hidden members/);
});

test("introspection rechecks: other groups for the same token close the view, a revocation closes it and the connection", async (t) => {
  const s = await setup(t, { policy: POLICY(), revocationDelay: 1 });
  inbox(await s.connect("alice"));
  const c = await s.signIn("carol", { iat: s.clock.t, opaque: true, groups: [] }, "send");
  assert.equal((await sendTo(c, "alice", "before")).ok, true);
  s.provider.answers.set("carol", ["suspended"]);
  assert.ok(await until(() => s.access.viewOf(`${IDP}|carol`).state === "closed", 3000), "a recheck with other groups at the same issue time conflicts");
  const d = await s.signIn("dave", { iat: s.clock.t, opaque: true }, "send");
  assert.equal(s.access.viewOf(`${IDP}|dave`).state, "ok");
  s.provider.revoked.add("dave");
  assert.ok(await until(() => s.access.viewOf(`${IDP}|dave`).state === "closed", 3000), "revoked: closed");
  assert.equal((await sendTo(d, "alice", "after").catch(() => ({ ok: false }))).ok, false);
});

/** A fault hook that fails the next matching write point once, optionally damaging the file first. */
function faults() {
  let next = null;
  const hook = (point, file) => {
    if (!next || point !== next.point || !file.includes(next.file)) return;
    const f = next;
    next = null;
    if (f.damage) fs.writeFileSync(path.join(point === "dir-fsync" ? file : path.dirname(file), f.damage), "{not json");
    throw Object.assign(new Error(`injected ${point}`), { code: "EIO" });
  };
  return { hook, arm: (point, file, damage = null) => (next = { point, file, damage }) };
}

test("a failed sign-in record keeps the newest version: an older one never reopens the view, also after a restart", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hoptell-hw-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const f = faults();
  const a = createAccess({ stateDir: dir, policy: POLICY(), fault: f.hook });
  a.noteAuth(`${IDP}|bob`, { version: 100, groups: [], memberId: ID.bob });
  f.arm("rename", "claims");
  assert.throws(() => a.noteAuth(`${IDP}|bob`, { version: 300, groups: [], memberId: ID.bob }));
  assert.equal(a.viewOf(`${IDP}|bob`).state, "closed");
  a.sweep(); // writes the closing
  const b = createAccess({ stateDir: dir, policy: POLICY() });
  b.noteAuth(`${IDP}|bob`, { version: 200, groups: [], memberId: ID.bob });
  assert.equal(b.viewOf(`${IDP}|bob`).state, "closed", "200 is older than the 300 already seen");
  b.noteAuth(`${IDP}|bob`, { version: 301, groups: [], memberId: ID.bob });
  assert.equal(b.viewOf(`${IDP}|bob`).state, "ok");
});

test("fenced state: no change is built from it, decisions hold, and recovery lets held messages go", async (t) => {
  const f = faults();
  const s = await setup(t, { policy: POLICY(), fault: f.hook });
  const aliceCli = await s.connect("alice", "send");
  await publish(aliceCli, { default: "deny", visible: "all", entries: [{ selector: `member:${ID.carol}`, action: "allow" }] });
  const got = [];
  await s.connect("alice", "peer", { got });
  const bob = await s.connect("bob");
  await bob.rpc({ type: "contact_request", to: "alice", reason: "review" });
  const file = path.join(s.stateDir, "access", "requests.json");
  const good = fs.readFileSync(file, "utf8");
  // The next request's file is replaced, its folder sync fails and the read-back fails: fenced.
  f.arm("dir-fsync", "access", "requests.json"); // a folder sync names the folder
  const carol = await s.connect("carol", "send");
  await carol.rpc({ type: "contact_request", to: "alice", reason: "other" });
  assert.equal(s.access.fenced(), true);
  // A change while fenced is not built from the old memory (it would erase the first request).
  const dave = await s.connect("dave", "send");
  await dave.rpc({ type: "contact_request", to: "alice", reason: "other" });
  assert.equal(fs.readFileSync(file, "utf8"), "{not json", "nothing written while fenced");
  // Unresolved: the same answer for a real and an unknown target.
  const r1 = await sendTo(carol, "alice", "while fenced");
  const r2 = await sendTo(carol, "nobody", "while fenced");
  assert.equal(r1.ok, false);
  assert.equal(r1.error, r2.error);
  // The file is repaired: the next sweep re-reads it, and access works again.
  fs.writeFileSync(file, good);
  s.access.sweep();
  assert.equal(s.access.fenced(), false);
  assert.equal((await sendTo(carol, "alice", "after recovery")).ok, true);
  assert.ok(await until(() => got.some((m) => m.text === "after recovery")));
});

test("recovery notifies: a message held while fenced goes once the state is read again", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hoptell-notify-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const f = faults();
  let calls = 0;
  const a = createAccess({ stateDir: dir, policy: POLICY(), fault: f.hook, onChange: () => calls++ });
  a.putGrants(ID.alice, 0, { default: "allow", visible: "all", entries: [] });
  const good = fs.readFileSync(path.join(dir, "access", "grants.json"), "utf8");
  f.arm("dir-fsync", "access", "grants.json");
  assert.throws(() => a.putGrants(ID.alice, 1, { default: "deny", visible: "all", entries: [] }));
  assert.equal(a.decide({ memberId: ID.bob }, { memberId: ID.alice }), "hold");
  fs.writeFileSync(path.join(dir, "access", "grants.json"), good);
  const before = calls;
  a.sweep();
  return new Promise((resolve) =>
    setImmediate(() => {
      assert.ok(calls > before, "listeners told after recovery");
      assert.equal(a.decide({ memberId: ID.bob }, { memberId: ID.alice }), "allow");
      resolve();
    }),
  );
});

test("a reply whose use was written but not answered is accepted on retry, exactly once", async (t) => {
  const f = faults();
  const s = await setup(t, { policy: POLICY(), fault: f.hook });
  const aliceCli = await s.connect("alice", "send");
  await publish(aliceCli, { default: "deny", visible: "all", entries: [] });
  const aliceGot = [];
  const alice = await s.connect("alice", "peer", { got: aliceGot });
  const bobGot = [];
  await s.connect("bob", "peer", { got: bobGot });
  const sent = await alice.rpc({ type: "send", to: "bob", text: "question" });
  assert.ok(await until(() => bobGot.length === 1));
  await sleep(100);
  const o = op();
  const bob1 = await s.connect("bob", "send", { n: 1 });
  f.arm("dir-fsync", "access");
  const first = await sendTo(bob1, "alice", "answer", { reply_to: sent.message_id, op: o });
  assert.equal(first.ok, false, "the outcome was uncertain: refused");
  // The same session retries (an error is not kept as the operation's result), then another one.
  const again = await sendTo(bob1, "alice", "answer", { reply_to: sent.message_id, op: o });
  assert.equal(again.ok, true, again.error);
  const bob2 = await s.connect("bob", "send", { n: 2 });
  const third = await sendTo(bob2, "alice", "answer", { reply_to: sent.message_id, op: o });
  assert.equal(third.ok, true);
  assert.equal(third.a.message_id, again.a.message_id);
  assert.ok(await until(() => aliceGot.length === 1));
  await sleep(200);
  assert.equal(aliceGot.length, 1, "delivered once");
});

test("unresolved access answers the same for hidden and unknown names", async (t) => {
  const s = await setup(t, { policy: POLICY() });
  await publish(await s.connect("alice", "send"), { default: "deny", visible: "grantees", entries: [] });
  inbox(await s.signIn("alice", { iat: s.clock.t }));
  const bob = await s.signIn("bob", { iat: s.clock.t }, "send");
  const dave = await s.connect("dave", "send");
  // The recipient's view goes stale (a member-token sender): denied like an unknown name.
  s.clock.t += 400_000;
  const d1 = await sendTo(dave, "alice", "x");
  const d2 = await sendTo(dave, "nobody", "x");
  assert.equal(d1.ok, false);
  assert.equal(d1.error.replace("alice", "X"), d2.error.replace("nobody", "X"));
  // The sender's view is stale too: one retry answer for every target.
  const b1 = await sendTo(bob, "alice", "x");
  const b2 = await sendTo(bob, "nobody", "x");
  assert.equal(b1.ok, false);
  assert.equal(b1.error, b2.error);
});

test("the per-sender quota counts deliveries in flight, not only queued ones", async (t) => {
  const s = await setup(t);
  // Receivers that never confirm: everything they get stays in flight.
  const silent = [];
  for (const who of ["alice", "carol", "dave"]) {
    const c = await s.connect(who);
    c.on("message", () => {});
    silent.push(c);
  }
  const big = "😀".repeat(50_000);
  const bobs = await Promise.all([0, 1, 2, 3, 4].map((n) => s.connect("bob", "send", { n })));
  // Sent together: an unconfirmed delivery is answered only after the relay's 5 s wait.
  // In order, one after another, so the charges add up deterministically.
  const results = [];
  for (let i = 0; i < 110; i++) {
    results.push(sendTo(bobs[i % 5], ["alice", "carol", "dave"][i % 3], big));
    await sleep(2);
  }
  const all = await Promise.all(results);
  const accepted = all.filter((r) => r.ok).length;
  assert.equal(accepted, Math.floor((20 * 1024 * 1024) / 200_000), all.find((r) => !r.ok)?.error);
  // A receiver going away requeues its deliveries without a second charge or a release.
  silent[0].close();
  await sleep(200);
  assert.equal((await sendTo(bobs[0], "carol", big)).ok, false, "still at the quota");
});

test("saved state is checked in full on load", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hoptell-shape-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, "access"));
  fs.writeFileSync(path.join(dir, "access", "grants.json"), JSON.stringify({ v: 1, members: { [ID.alice]: { revision: 1, default: "deny", visible: "all", entries: [{ selector: "*", action: "invalid" }] } } }));
  assert.throws(() => createAccess({ stateDir: dir }), /unknown version or shape/);
  fs.writeFileSync(path.join(dir, "access", "grants.json"), JSON.stringify({ v: 1, members: {} }));
  fs.writeFileSync(path.join(dir, "access", "allowances.json"), JSON.stringify({ v: 1, entries: [{ from: ID.bob, to: ID.alice, message: "m", expires: -1, used: null }] }));
  assert.throws(() => createAccess({ stateDir: dir }), /unknown version or shape/);
});

test("a used allowance has a read-time horizon: a reply still queued after 7 days is not delivered", async (t) => {
  const s = await setup(t, { policy: POLICY() });
  const aliceCli = await s.connect("alice", "send");
  await publish(aliceCli, { default: "deny", visible: "all", entries: [] });
  const alice = await s.connect("alice");
  const bobGot = [];
  const bob = await s.connect("bob", "peer", { got: bobGot });
  const sent = await alice.rpc({ type: "send", to: "bob", text: "question" });
  assert.ok(await until(() => bobGot.length === 1));
  await sleep(100);
  alice.close();
  await sleep(100);
  assert.equal((await sendTo(bob, "alice", "late reply", { reply_to: sent.message_id })).ok, true);
  s.clock.t += 8 * 86_400_000; // no sweep
  const got = [];
  await s.connect("alice", "peer", { got });
  await sleep(300);
  assert.equal(got.length, 0);
});

test("a recovered reply keeps its original envelope: no renewed expiry, nothing delivered after its deadline", async (t) => {
  const f = faults();
  const s = await setup(t, { policy: POLICY(), fault: f.hook });
  const aliceCli = await s.connect("alice", "send");
  await publish(aliceCli, { default: "deny", visible: "all", entries: [] });
  const alice = await s.connect("alice");
  const bobGot = [];
  await s.connect("bob", "peer", { got: bobGot });
  const q1 = await alice.rpc({ type: "send", to: "bob", text: "q1" });
  const q2 = await alice.rpc({ type: "send", to: "bob", text: "q2" });
  assert.ok(await until(() => bobGot.length === 2));
  await sleep(100);
  alice.close();
  await sleep(100);
  // Accepted and queued, then repeated from another session: the original expiry, not a new one.
  const o1 = op();
  const b1 = await s.connect("bob", "send", { n: 1 });
  const first = await sendTo(b1, "alice", "reply 1", { reply_to: q1.message_id, op: o1, ttl: 60 });
  assert.equal(first.ok, true);
  await sleep(1100);
  const b2 = await s.connect("bob", "send", { n: 2 });
  const repeat = await sendTo(b2, "alice", "reply 1", { reply_to: q1.message_id, op: o1, ttl: 60 });
  assert.equal(repeat.a.message_id, first.a.message_id);
  assert.equal(repeat.a.expires, first.a.expires, "the original expiry");
  // Recorded but not answered (an uncertain write), with a 1 s lifetime: past it, a retry is
  // reported as expired and nothing is queued.
  const o2 = op();
  f.arm("dir-fsync", "access");
  assert.equal((await sendTo(b1, "alice", "reply 2", { reply_to: q2.message_id, op: o2, ttl: 1 })).ok, false);
  await sleep(1200);
  const late = await b2.rpc({ type: "send", to: "alice", text: "reply 2", reply_to: q2.message_id, op: o2, ttl: 1 }).then(
    () => null,
    (e) => e,
  );
  assert.equal(late?.code, "expired", "an error, never an ack a client could read as sent");
  assert.match(late.message, /this retry was not queued: the deadline of message [0-9a-f-]{36} passed at .* \(an earlier attempt may have been delivered\)/);
  const got = [];
  await s.connect("alice", "peer", { got });
  await sleep(300);
  assert.deepEqual(got.map((m) => m.text), ["reply 1"]);
});

test("a direct send to a recipient whose sign-in just ended is charged too", async (t) => {
  const s = await setup(t);
  inbox(await s.signIn("alice", { iat: s.clock.t }));
  for (const who of ["carol", "dave"]) (await s.connect(who)).close();
  await sleep(100);
  const big = "😀".repeat(50_000);
  const bobs = await Promise.all([0, 1, 2, 3, 4].map((n) => s.connect("bob", "send", { n })));
  // Past alice's deadline before her timer runs: the relay queues the message and cuts her off.
  const realNow = Date.now;
  Date.now = () => realNow() + 400_000;
  let first;
  try {
    first = await sendTo(bobs[0], "alice", big);
  } finally {
    Date.now = realNow;
  }
  assert.equal(first.ok, true);
  let accepted = 1;
  for (let i = 0; i < 110; i++) {
    const r = await sendTo(bobs[(i % 4) + 1], ["carol", "dave", "alice"][i % 3], big);
    if (!r.ok) break;
    accepted++;
  }
  assert.equal(accepted, Math.floor((20 * 1024 * 1024) / 200_000));
});

test("authenticated claims the store cannot keep are refused whole, and the store still loads", async (t) => {
  const s = await setup(t, { policy: POLICY() });
  // The scripted provider passes any group through; the relay's store refuses what it cannot load.
  const long = "g".repeat(1100);
  await assert.rejects(s.signIn("bob", { iat: s.clock.t, groups: [long] }, "send"));
  assert.doesNotThrow(() => createAccess({ stateDir: s.stateDir }));
  assert.equal(createAccess({ stateDir: s.stateDir }).viewOf(`${IDP}|bob`).state, "closed");
});

test("a repeated reply from another session names the same recipient as the first ack", async (t) => {
  const s = await setup(t, { policy: POLICY() });
  const aliceCli = await s.connect("alice", "send");
  await publish(aliceCli, { default: "deny", visible: "all", entries: [] });
  const alice = await s.connect("alice");
  inbox(alice);
  const bobGot = [];
  await s.connect("bob", "peer", { got: bobGot });
  const q = await alice.rpc({ type: "send", to: "bob", text: "question" });
  assert.ok(await until(() => bobGot.length === 1));
  await sleep(100);
  const o = op();
  const b1 = await s.connect("bob", "send", { n: 1 });
  const b2 = await s.connect("bob", "send", { n: 2 });
  const first = await sendTo(b1, "alice", "answer", { reply_to: q.message_id, op: o });
  const again = await sendTo(b2, "alice", "answer", { reply_to: q.message_id, op: o });
  assert.equal(again.a.message_id, first.a.message_id);
  assert.deepEqual(first.a.recipient, { auth: "member", member: { id: ID.alice, name: "alice" }, realm: "e".repeat(32) });
  assert.deepEqual(again.a.recipient, first.a.recipient, "not shown as an older relay");
});
