// Protocol 2 on the relay: claims, typed refusals, handoff, sender projection, queue ownership.
import { test } from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
import { startRelay } from "../lib/relay.js";
import { fakeToken, sleep } from "./helpers.js";

/** A raw connection that records frames and its close code. */
function connect(url, hello) {
  const ws = new WebSocket(url);
  const frames = [];
  const waiters = [];
  ws.on("message", (d) => {
    const f = JSON.parse(d);
    frames.push(f);
    for (const w of [...waiters]) if (w.match(f)) waiters.splice(waiters.indexOf(w), 1) && w.resolve(f);
  });
  const closed = new Promise((r) => ws.on("close", (code) => r(code)));
  ws.on("error", () => {});
  ws.on("open", () => ws.send(JSON.stringify(hello)));
  const next = (match, ms = 3000) => {
    const seen = frames.find(match);
    if (seen) return Promise.resolve(seen);
    return new Promise((resolve, reject) => {
      waiters.push({ match, resolve });
      setTimeout(() => reject(new Error(`no frame; got ${JSON.stringify(frames.map((x) => x.type))}`)), ms);
    });
  };
  return { ws, frames, closed, next, send: (o) => ws.send(JSON.stringify(o)) };
}

async function setup(t) {
  const tokens = { alice: fakeToken(), bob: fakeToken(), shared: fakeToken() };
  const relay = await startRelay({
    host: "127.0.0.1",
    port: 0,
    token: tokens.shared,
    members: [{ name: "alice", id: "m_aaaaaaaaaaaaaaaaaaaaaaaaaa", token: tokens.alice }, { name: "bob", token: tokens.bob }],
    realm: { id: "1".repeat(32), name: "team" },
    log: () => {},
  });
  t.after(() => relay.close());
  const url = `ws://127.0.0.1:${relay.port}`;
  const v2 = (name, token, claim, extra = {}) => connect(url, { type: "hello", v: 2, name, token, host: "pc", mode: "peer", claim, ...extra });
  const v1 = (name, token, extra = {}) => connect(url, { type: "hello", v: 1, name, token, host: "pc", ...extra });
  return { relay, url, tokens, v1, v2 };
}

test("protocol 2 welcome carries realm, member, lease and capabilities; send-only gets no lease", async (t) => {
  const { tokens, v2, url } = await setup(t);
  const a = v2("alice-a", tokens.alice, { action: "acquire" });
  const w = await a.next((f) => f.type === "welcome");
  assert.deepEqual(w.realm, { id: "1".repeat(32), name: "team" });
  assert.deepEqual(w.member, { id: "m_aaaaaaaaaaaaaaaaaaaaaaaaaa", name: "alice" });
  assert.match(w.claim.lease, /^[0-9a-f]{32}$/);
  assert.equal(w.claim.gen, 1);
  assert.ok(w.caps.includes("lease") && w.caps.includes("claim-status"));
  const s = connect(url, { type: "hello", v: 2, name: "alice-cli", token: tokens.alice, mode: "send" });
  const sw = await s.next((f) => f.type === "welcome");
  assert.equal(sw.claim, null);
  const bad = connect(url, { type: "hello", v: 2, name: "alice-x", token: tokens.alice, mode: "send", claim: { action: "acquire" } });
  assert.equal(await bad.closed, 4001, "a claim on a send-only hello is a bad hello");
  // Legacy members get the legacy id, and a protocol-1 welcome has no protocol-2 fields.
  const b = v2("bob-a", tokens.bob, { action: "acquire" });
  assert.deepEqual((await b.next((f) => f.type === "welcome")).member, { id: "name:bob", name: "bob" });
  const old = connect(url, { type: "hello", name: "bob-old", token: tokens.bob });
  const ow = await old.next((f) => f.type === "welcome");
  assert.equal(ow.realm, undefined);
  assert.equal(ow.claim, undefined);
});

test("leases cannot be taken: legacy gets 4002, acquire gets 4006 with a typed error, status reports it", async (t) => {
  const { tokens, v1, v2, url } = await setup(t);
  const a = v2("alice-a", tokens.alice, { action: "acquire" });
  await a.next((f) => f.type === "welcome");
  assert.equal(await v1("alice-a", tokens.alice).closed, 4002, "an old client cannot evict a lease");
  const c = v2("alice-a", tokens.alice, { action: "acquire" });
  assert.deepEqual(await c.next((f) => f.type === "hello_error"), { type: "hello_error", code: "name_in_use" });
  assert.equal(await c.closed, 4006);
  const s = connect(url, { type: "hello", v: 2, name: "alice-cli", token: tokens.alice, mode: "send" });
  await s.next((f) => f.type === "welcome");
  s.send({ type: "claim_status", id: 7, name: "alice-a" });
  assert.deepEqual(await s.next((f) => f.type === "claim_status"), { type: "claim_status", id: 7, state: "taken" });
  s.send({ type: "claim_status", id: 8, name: "alice-free" });
  assert.equal((await s.next((f) => f.type === "claim_status" && f.id === 8)).state, "free");
  // a.ws closes: reserved, with a retry hint
  a.ws.close();
  await a.closed;
  await sleep(50);
  s.send({ type: "claim_status", id: 9, name: "alice-a" });
  assert.equal((await s.next((f) => f.type === "claim_status" && f.id === 9)).state, "free", "alice may claim her own reservation");
  const watcher = connect(url, { type: "hello", v: 2, name: "probe", token: tokens.shared, mode: "send" });
  await watcher.next((f) => f.type === "welcome");
  watcher.send({ type: "claim_status", id: 10, name: "alice-a" });
  const st = await watcher.next((f) => f.type === "claim_status" && f.id === 10);
  assert.equal(st.state, "reserved", "another principal sees the reservation");
  assert.ok(st.retry_after_ms > 1000);
  // Another principal waits for the reservation; the same member (a restart) gets the name.
  const other = v2("alice-a", tokens.shared, { action: "acquire" });
  assert.equal((await other.next((f) => f.type === "hello_error")).code, "reserved");
  const restart = v2("alice-a", tokens.alice, { action: "acquire" });
  assert.equal((await restart.next((f) => f.type === "welcome")).name, "alice-a");
  // Legacy vs legacy keeps today's behavior.
  const l1 = v1("bob-l", tokens.bob);
  await l1.next((f) => f.type === "welcome");
  const l2 = v1("bob-l", tokens.bob);
  await l2.next((f) => f.type === "welcome");
  assert.equal(await l1.closed, 4004);
});

test("resume hands off unconfirmed messages exactly once and fences the old socket", async (t) => {
  const { tokens, v2 } = await setup(t);
  const a = v2("alice-a", tokens.alice, { action: "acquire" });
  const { claim } = await a.next((f) => f.type === "welcome");
  const sender = v2("bob-s", tokens.bob, { action: "acquire" });
  await sender.next((f) => f.type === "welcome");
  sender.send({ type: "send", id: 1, to: "alice-a", text: "first" });
  const m1 = await a.next((f) => f.type === "message");
  // a never confirms; its session resumes on a new socket while a is still open.
  const b = v2("alice-a", tokens.alice, { action: "resume", lease: claim.lease, secret: claim.secret, gen: claim.gen, incarnation: claim.incarnation, attempt: "r1" });
  const wb = await b.next((f) => f.type === "welcome");
  assert.equal(wb.claim.gen, 2);
  assert.equal(await a.closed, 4007);
  const again = await b.next((f) => f.type === "message");
  assert.equal(again.text, "first");
  assert.equal(again.id, m1.id, "the same delivery id, so the receiver stores it once");
  // The sender learns the message went back to the queue (as when a receiver disconnects).
  assert.equal((await sender.next((f) => f.type === "ack" && f.id === 1)).state, "queued");
  a.send({ type: "got", id: m1.id }); // a late ack from the fenced socket is ignored
  b.send({ type: "got", id: again.id });
  await sleep(100);
  assert.equal(b.frames.filter((f) => f.type === "message").length, 1, "handed off exactly once");
  // A different attempt from the old generation is superseded.
  const stale = v2("alice-a", tokens.alice, { action: "resume", lease: claim.lease, secret: claim.secret, gen: 1, incarnation: claim.incarnation, attempt: "r2" });
  assert.equal((await stale.next((f) => f.type === "hello_error")).code, "superseded");
  assert.equal(await stale.closed, 4007);
  // Wrong secret, wrong incarnation.
  const wrong = v2("alice-a", tokens.alice, { action: "resume", lease: claim.lease, secret: "x", gen: 2, incarnation: claim.incarnation, attempt: "r3" });
  assert.equal((await wrong.next((f) => f.type === "hello_error")).code, "lease_unknown");
  const restarted = v2("alice-a", tokens.alice, { action: "resume", lease: claim.lease, secret: claim.secret, gen: 2, incarnation: "other", attempt: "r4" });
  assert.equal((await restarted.next((f) => f.type === "hello_error")).code, "relay_restarted");
});

test("replace: same principal only; a shared token cannot take a member's name", async (t) => {
  const { tokens, v2 } = await setup(t);
  const a = v2("alice-a", tokens.alice, { action: "acquire" });
  await a.next((f) => f.type === "welcome");
  const sharedReplace = v2("alice-a", tokens.shared, { action: "replace" });
  assert.equal((await sharedReplace.next((f) => f.type === "hello_error")).code, "not_allowed");
  const r = v2("alice-a", tokens.alice, { action: "replace" });
  await r.next((f) => f.type === "welcome");
  assert.equal(await a.closed, 4004);
});

test("senders are projected per receiver: protocol 1 gets today's frame, protocol 2 also gets the sender", async (t) => {
  const { tokens, v1, v2 } = await setup(t);
  const old = v1("bob-old", tokens.bob);
  await old.next((f) => f.type === "welcome");
  const neu = v2("bob-new", tokens.bob, { action: "acquire" });
  await neu.next((f) => f.type === "welcome");
  const from = v2("alice-a", tokens.alice, { action: "acquire" });
  await from.next((f) => f.type === "welcome");
  from.send({ type: "send", id: 1, to: "@all", text: "hello" });
  const mo = await old.next((f) => f.type === "message");
  const mn = await neu.next((f) => f.type === "message");
  assert.equal(mo.from, "alice-a");
  assert.equal(mo.sender, undefined);
  assert.deepEqual(Object.keys(mo).sort(), ["from", "fromHost", "id", "message_id", "text", "to", "ts", "type"]);
  assert.deepEqual(mn.sender, { member: { id: "m_aaaaaaaaaaaaaaaaaaaaaaaaaa", name: "alice" }, auth: "member", realm: "1".repeat(32) });
  const viaShared = v2("cli-x", tokens.shared, { action: "acquire" });
  await viaShared.next((f) => f.type === "welcome");
  viaShared.send({ type: "send", id: 2, to: "bob-new", text: "from shared" });
  assert.deepEqual((await neu.next((f) => f.type === "message" && f.text === "from shared")).sender, { member: null, auth: "shared", realm: "1".repeat(32) });
});

test("a name claimed by a different member does not inherit the earlier owner's queue", async (t) => {
  const { tokens, v1, v2 } = await setup(t);
  // A legacy shared-token session named "carol" went offline with a queued message.
  const carol = v1("carol", tokens.shared);
  await carol.next((f) => f.type === "welcome");
  carol.ws.close();
  await carol.closed;
  const s = v2("alice-s", tokens.alice, { action: "acquire" });
  await s.next((f) => f.type === "welcome");
  s.send({ type: "send", id: 1, to: "carol", text: "for the shared carol" });
  assert.equal((await s.next((f) => f.type === "ack")).state, "queued");
  // The same principal reconnecting gets it.
  const back = v1("carol", tokens.shared);
  assert.equal((await back.next((f) => f.type === "message")).text, "for the shared carol");
  back.send({ type: "got", id: back.frames.find((f) => f.type === "message").id });
  back.ws.close();
  await back.closed;
  s.send({ type: "send", id: 2, to: "carol", text: "queued again" });
  await s.next((f) => f.type === "ack" && f.id === 2);
  // Now bob's member token is not allowed "carol"; use a shared-token v2 replace? No: a different
  // principal needs a name its credential may use, so model reuse with bob's prefix space instead.
  const bobQueue = v1("bob-x", tokens.bob);
  await bobQueue.next((f) => f.type === "welcome");
  bobQueue.ws.close();
  await bobQueue.closed;
  s.send({ type: "send", id: 3, to: "bob-x", text: "for bob" });
  await s.next((f) => f.type === "ack" && f.id === 3);
  // The shared token may use any name: it claims "bob-x", a different principal than bob.
  const taker = v1("bob-x", tokens.shared);
  await taker.next((f) => f.type === "welcome");
  await sleep(300);
  assert.equal(taker.frames.filter((f) => f.type === "message").length, 0, "bob's queued message must not go to another principal");
});

test("automatic names use the member prefix, fit 64 characters and avoid live claims", async (t) => {
  const { tokens, url } = await setup(t);
  const hello = (token, extra) => connect(url, { type: "hello", v: 2, name: null, auto: { host: "my.laptop", n: 7 }, token, mode: "peer", claim: { action: "acquire" }, ...extra });
  const a = hello(tokens.alice);
  assert.equal((await a.next((f) => f.type === "welcome")).name, "alice-my-laptop-7");
  const b = hello(tokens.alice);
  assert.equal((await b.next((f) => f.type === "welcome")).name, "alice-my-laptop-7-2");
  const longHost = connect(url, { type: "hello", v: 2, name: null, auto: { host: "h".repeat(80), n: 1 }, token: tokens.alice, mode: "peer", claim: { action: "acquire" } });
  const ln = (await longHost.next((f) => f.type === "welcome")).name;
  assert.equal(ln.length, 64);
  assert.ok(ln.startsWith("alice-"));
  const shared = hello(tokens.shared);
  assert.equal((await shared.next((f) => f.type === "welcome")).name, "my-laptop-7");
  const cli = connect(url, { type: "hello", v: 2, name: null, auto: { host: "my.laptop", n: 1 }, token: tokens.alice, mode: "send" });
  assert.equal((await cli.next((f) => f.type === "welcome")).name, "alice-my-laptop-cli");
});

// ---- the client side ----
import { WebSocketServer } from "ws";
import { RelayClient } from "../lib/client.js";

test("client: a dropped connection resumes its lease, keeps its name and gets unconfirmed messages again", async (t) => {
  const { tokens, url, v2 } = await setup(t);
  const c = new RelayClient({ url, token: tokens.alice, name: "alice-agent" });
  t.after(() => c.close());
  const got = [];
  c.on("message", (m, confirm) => {
    got.push(m.text);
    if (got.length > 1) confirm(); // the first delivery is not confirmed before the drop
  });
  c.start();
  await c.ready();
  const firstGen = c.lease.gen;
  const sender = v2("bob-s", tokens.bob, { action: "acquire" });
  await sender.next((f) => f.type === "welcome");
  sender.send({ type: "send", id: 1, to: "alice-agent", text: "before the drop" });
  for (let i = 0; i < 40 && !got.length; i++) await sleep(25);
  c.ws.terminate(); // network drop
  for (let i = 0; i < 100 && !(c.connected && c.lease.gen > firstGen); i++) await sleep(50);
  assert.equal(c.connected, true);
  assert.equal(c.lease.gen, firstGen + 1, "resumed, not a new claim");
  for (let i = 0; i < 60 && got.length < 2; i++) await sleep(50);
  assert.deepEqual(got, ["before the drop", "before the drop"], "redelivered after the resume");
});

test("client: a temporary copy waits instead of evicting, then gets the name after the holder leaves", async (t) => {
  const { tokens, url } = await setup(t);
  const holder = new RelayClient({ url, token: tokens.alice, name: "alice-agent" });
  holder.start();
  await holder.ready();
  const events = [];
  const copy = new RelayClient({ url, token: tokens.alice, name: "alice-agent" });
  t.after(() => copy.close());
  for (const e of ["ready", "replaced", "fatal"]) copy.on(e, () => events.push(e));
  copy.start();
  for (let i = 0; i < 40 && !events.includes("replaced"); i++) await sleep(25);
  assert.deepEqual(events, ["replaced"], "the copy waits");
  assert.equal(holder.connected, true, "the holder was not evicted");
  holder.close();
  for (let i = 0; i < 200 && !events.includes("ready"); i++) await sleep(50);
  assert.deepEqual(events, ["replaced", "ready"]);
});

test("client: falls back to protocol 1 on an old relay unless the profile requires protocol 2", async (t) => {
  // A stand-in for a 0.2.x relay: refuses v:2 with 4005, welcomes v:1.
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise((r) => wss.on("listening", r));
  t.after(() => wss.close());
  const hellos = [];
  wss.on("connection", (ws) =>
    ws.on("message", (d) => {
      const m = JSON.parse(d);
      hellos.push(m.v);
      if (m.v !== undefined && m.v !== 1) return ws.close(4005, "unsupported protocol version");
      ws.send(JSON.stringify({ type: "welcome", name: m.name }));
    }),
  );
  const url = `ws://127.0.0.1:${wss.address().port}`;
  let legacyNoted = false;
  const c = new RelayClient({ url, token: fakeToken(), name: "x", onLegacy: () => (legacyNoted = true) });
  t.after(() => c.close());
  c.start();
  await c.ready();
  assert.deepEqual(hellos, [2, 1]);
  assert.equal(legacyNoted, true);
  const strict = new RelayClient({ url, token: fakeToken(), name: "y", require2: true });
  t.after(() => strict.close());
  await assert.rejects(strict.start().ready(), /requires/);
});

test("client: CLI-style clients stop at once when the name is taken; onWelcome runs before anything is acknowledged", async (t) => {
  const { tokens, url, v2 } = await setup(t);
  const holder = new RelayClient({ url, token: tokens.alice, name: "alice-agent" });
  t.after(() => holder.close());
  holder.start();
  await holder.ready();
  const cli = new RelayClient({ url, token: tokens.alice, name: "alice-agent", waitWhenReplaced: false });
  t.after(() => cli.close());
  await assert.rejects(cli.start().ready(), /in use by another session/);
  // A failing onWelcome stops the client without acknowledging what was already queued.
  const s = v2("bob-s", tokens.bob, { action: "acquire" });
  await s.next((f) => f.type === "welcome");
  s.send({ type: "send", id: 1, to: "alice-late", text: "queued" });
  await s.next((f) => f.type === "error" || f.type === "ack");
  const late = new RelayClient({ url, token: tokens.alice, name: "alice-late", onWelcome: () => Promise.reject(new Error("storage refused")) });
  t.after(() => late.close());
  const seen = [];
  late.on("message", (m) => seen.push(m));
  await assert.rejects(late.start().ready(), /storage refused/);
  assert.deepEqual(seen, [], "nothing is passed on when the welcome cannot be committed");
});
