// to_member on direct sends (design 7.2, "Routing"): checked at acceptance, stored with the message
// and checked again before every forward, requeue and redelivery; part of the operation digest;
// advertised as a capability; the client sends it only to a relay that has the capability.
import { test } from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
import { startRelay } from "../lib/relay.js";
import { RelayClient } from "../lib/client.js";
import { fakeToken, sleep } from "./helpers.js";

const ALICE = "m_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const BOB = "name:bob";

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
    members: [{ name: "alice", id: ALICE, token: tokens.alice }, { name: "bob", token: tokens.bob }],
    realm: { id: "1".repeat(32), name: "team" },
    log: () => {},
  });
  t.after(() => relay.close());
  const url = `ws://127.0.0.1:${relay.port}`;
  const peer = async (name, token, action = "acquire", { confirm = false } = {}) => {
    const c = connect(url, { type: "hello", v: 2, name, token, host: "pc", mode: "peer", claim: { action } });
    if (confirm) c.ws.on("message", (d) => (JSON.parse(d).type === "message" ? c.send({ type: "got", id: JSON.parse(d).id }) : null));
    await c.next((f) => f.type === "welcome");
    return c;
  };
  const sender = async (name, token) => {
    const c = connect(url, { type: "hello", v: 2, name, token, host: "pc", mode: "send" });
    await c.next((f) => f.type === "welcome");
    return c;
  };
  let id = 100;
  const send = async (c, frame, { wait = true } = {}) => {
    const n = id++;
    c.send({ type: "send", id: n, ...frame });
    return wait ? c.next((f) => f.id === n && (f.type === "ack" || f.type === "error"), 7000) : null;
  };
  const leave = async (c) => {
    c.send({ type: "release" });
    await sleep(30);
    c.ws.close();
    await c.closed;
    await sleep(30);
  };
  return { relay, url, tokens, peer, sender, send, leave };
}

const dropped = (relay) => relay.stats().recipientMismatch + relay.stats().queueDropped;

test("the relay advertises to_member and delivers a matching send without the field", async (t) => {
  const { tokens, peer, send } = await setup(t);
  const a = await peer("alice-a", tokens.alice, "acquire", { confirm: true });
  assert.ok((await a.next((f) => f.type === "welcome")).caps.includes("to_member"));
  const b = await peer("alice-b", tokens.alice);
  const ack = await send(b, { to: "alice-a", text: "hi", to_member: ALICE });
  assert.equal(ack.type, "ack");
  const m = await a.next((f) => f.type === "message");
  assert.equal(m.text, "hi");
  assert.equal(Object.hasOwn(m, "to_member"), false, "the relay's condition is not forwarded");
});

test("acceptance: a name held by another member, or by a shared token, is refused", async (t) => {
  const { tokens, peer, sender, send } = await setup(t);
  await peer("alice-a", tokens.alice);
  await peer("anyone", tokens.shared);
  const s = await sender("bob-cli", tokens.bob);
  const r = await send(s, { to: "alice-a", text: "x", to_member: BOB });
  assert.equal(r.type, "error");
  assert.equal(r.code, "recipient_member_mismatch");
  assert.equal((await send(s, { to: "anyone", text: "x", to_member: ALICE })).code, "recipient_member_mismatch");
  // Malformed uses are refused before acceptance.
  assert.match((await send(s, { to: "alice-a", text: "x", to_member: "alice" })).error, /member id/);
  assert.match((await send(s, { to: "@all", text: "x", to_member: ALICE })).error, /one peer name/);
  const old = connect(`ws://127.0.0.1:${(s.ws.url.match(/:(\d+)/) || [])[1]}`, { type: "hello", v: 1, name: "bob-old", token: tokens.bob, host: "pc", mode: "send" });
  await old.next((f) => f.type === "welcome");
  assert.match((await send(old, { to: "alice-a", text: "x", to_member: ALICE })).error, /protocol 2/);
});

test("an offline queue: delivered to the same member, never after a release and acquire by another principal", async (t) => {
  const { relay, tokens, peer, sender, send, leave } = await setup(t);
  const a = await peer("alice-a", tokens.alice);
  await leave(a); // released: the name is free, the peer record remembers alice
  const s = await sender("alice-cli", tokens.alice);
  const ack = await send(s, { to: "alice-a", text: "queued for alice", to_member: ALICE });
  assert.equal(ack.state, "queued", "accepted against the name's last holder");
  // The same member comes back: delivered.
  const back = await peer("alice-a", tokens.alice);
  assert.equal((await back.next((f) => f.type === "message")).text, "queued for alice");
  back.send({ type: "got", id: back.frames.find((f) => f.type === "message").id });
  await leave(back);
  // Queued again, then another principal acquires the name: never delivered to it.
  assert.equal((await send(s, { to: "alice-a", text: "secret for alice", to_member: ALICE })).state, "queued");
  const before = dropped(relay);
  const other = await peer("alice-a", tokens.shared);
  await sleep(150);
  assert.equal(other.frames.some((f) => f.type === "message"), false);
  assert.ok(dropped(relay) > before, "the drop is counted");
  // And a replace by the other principal does not bring it back.
  const again = await peer("alice-a", tokens.shared, "replace");
  await sleep(150);
  assert.equal(again.frames.some((f) => f.type === "message"), false);
});

test("a handoff while a message is in flight: requeued, then not delivered to another principal", async (t) => {
  const { relay, tokens, peer, sender, send, leave } = await setup(t);
  const a = await peer("alice-a", tokens.alice);
  const s = await sender("alice-cli", tokens.alice);
  await send(s, { to: "alice-a", text: "in flight", to_member: ALICE }, { wait: false });
  await a.next((f) => f.type === "message"); // delivered, never confirmed
  const before = dropped(relay);
  await leave(a); // the unconfirmed delivery goes back to the queue
  const other = await peer("alice-a", tokens.shared);
  await sleep(150);
  assert.equal(other.frames.some((f) => f.type === "message"), false);
  assert.ok(dropped(relay) > before);
  // Without to_member, the relay's existing queue ownership applies in the same way.
  assert.equal(relay.stats().queueItems, 0);
});

test("an op retry with another to_member is a different operation", async (t) => {
  const { tokens, peer, sender, send } = await setup(t);
  await peer("alice-a", tokens.alice, "acquire", { confirm: true });
  const s = await sender("alice-cli", tokens.alice);
  const op = `o_${"a".repeat(26)}`;
  const first = await send(s, { to: "alice-a", text: "x", to_member: ALICE, op });
  assert.equal(first.type, "ack");
  const same = await send(s, { to: "alice-a", text: "x", to_member: ALICE, op });
  assert.equal(same.message_id, first.message_id, "the same operation is answered from its first outcome");
  const other = await send(s, { to: "alice-a", text: "x", to_member: BOB, op });
  assert.match(other.error, /op_reused/);
  const none = await send(s, { to: "alice-a", text: "x", op });
  assert.match(none.error, /op_reused/, "dropping to_member is also a different operation");
});

test("the client sends to_member only when the relay has the capability", async (t) => {
  const { tokens, url, peer } = await setup(t);
  const a = await peer("alice-a", tokens.alice, "acquire", { confirm: true });
  const c = new RelayClient({ url, token: tokens.alice, name: "alice-c", reconnect: false });
  t.after(() => c.close());
  await c.start().ready();
  assert.equal(c.supportsToMember(), true);
  const ack = await c.send("alice-a", "bound", undefined, undefined, { toMember: ALICE });
  assert.equal(ack.recipient.member.id, ALICE);
  assert.equal((await a.next((f) => f.type === "message" && f.text === "bound")).text, "bound");
  await assert.rejects(c.send("alice-a", "bound", undefined, undefined, { toMember: BOB }), (e) => e.code === "recipient_member_mismatch");
  // An older relay (no capability): nothing is sent.
  c.caps = c.caps.filter((x) => x !== "to_member");
  await assert.rejects(c.send("alice-a", "never", undefined, undefined, { toMember: ALICE }), (e) => e.code === "no_to_member" && e.kind === "not_sent");
  await sleep(100);
  assert.equal(a.frames.some((f) => f.text === "never"), false);
  // Without toMember, sends are unchanged.
  assert.equal((await c.send("alice-a", "plain")).type, "ack");
});
