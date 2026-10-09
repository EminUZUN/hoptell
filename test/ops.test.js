// Idempotent sends on the relay: an operation id executes once; retries get the first outcome.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import WebSocket from "ws";
import { startRelay } from "../lib/relay.js";
import { fakeToken, sleep } from "./helpers.js";

const opId = () => `o_${[...crypto.randomBytes(26)].map((b) => "abcdefghijklmnopqrstuvwxyz234567"[b & 31]).join("")}`;

/** A raw protocol-2 connection that records frames. */
function connect(url, hello) {
  const ws = new WebSocket(url);
  const frames = [];
  ws.on("message", (d) => frames.push(JSON.parse(d)));
  ws.on("error", () => {});
  ws.on("open", () => ws.send(JSON.stringify(hello)));
  const next = async (match, ms = 3000) => {
    for (const end = Date.now() + ms; Date.now() < end; await sleep(10)) {
      const f = frames.find(match);
      if (f) return f;
    }
    throw new Error(`no frame; got ${JSON.stringify(frames.map((x) => x.type))}`);
  };
  let id = 0;
  return {
    ws,
    frames,
    next,
    /** Send and return the reply for this request id. */
    async send(fields) {
      const rid = `r${++id}`;
      ws.send(JSON.stringify({ type: "send", id: rid, ...fields }));
      return next((f) => f.id === rid);
    },
    messages: () => frames.filter((f) => f.type === "message"),
  };
}

async function setup(t, opts = {}) {
  const token = fakeToken();
  const relay = await startRelay({ host: "127.0.0.1", port: 0, token, realm: { id: "9".repeat(32) }, log: () => {}, ...opts });
  t.after(() => relay.close());
  const url = `ws://127.0.0.1:${relay.port}`;
  const peer = async (name) => {
    const c = connect(url, { type: "hello", v: 2, name, token, host: "pc", mode: "peer", claim: { action: "acquire" } });
    await c.next((f) => f.type === "welcome");
    c.ws.on("message", (d) => {
      const m = JSON.parse(d);
      if (m.type === "message") c.ws.send(JSON.stringify({ type: "got", id: m.id }));
    });
    return c;
  };
  const sender = async (name, v = 2) => {
    const c = connect(url, { type: "hello", v, name, token, host: "pc", mode: "send" });
    await c.next((f) => f.type === "welcome");
    return c;
  };
  return { relay, url, token, peer, sender };
}

test("every protocol-2 welcome carries the relay incarnation and the idempotent-send capability", async (t) => {
  const { sender, peer } = await setup(t);
  const s = await sender("s");
  const w = s.frames.find((f) => f.type === "welcome");
  assert.match(w.incarnation, /^[0-9a-f]{16}$/);
  assert.ok(w.caps.includes("idempotent-send"));
  const p = await peer("p");
  assert.equal(p.frames.find((f) => f.type === "welcome").incarnation, w.incarnation);
});

test("a repeated operation returns the first outcome and is delivered once", async (t) => {
  const { sender, peer } = await setup(t);
  const bob = await peer("bob");
  const s = await sender("alice");
  const op = opId();
  const first = await s.send({ to: "bob", text: "once", op });
  assert.equal(first.type, "ack");
  // The reply was "lost": the client retries on a new connection with the same op.
  const s2 = await sender("alice");
  const again = await s2.send({ to: "bob", text: "once", op });
  assert.equal(again.message_id, first.message_id);
  assert.equal(again.state, first.state);
  // Two attempts in flight at the same time join one execution.
  const op2 = opId();
  const [a, b] = await Promise.all([s.send({ to: "bob", text: "twice?", op: op2 }), s2.send({ to: "bob", text: "twice?", op: op2 })]);
  assert.equal(a.message_id, b.message_id);
  await sleep(200);
  assert.deepEqual(bob.messages().map((m) => m.text), ["once", "twice?"]);
});

test("an operation id reused for another message is refused; a refused operation may run again", async (t) => {
  const { sender, peer } = await setup(t);
  const s = await sender("alice");
  const op = opId();
  const refused = await s.send({ to: "nobody", text: "hi", op });
  assert.match(refused.error, /unknown peer/);
  const carol = await peer("nobody"); // the peer exists now: the same operation runs
  const ok = await s.send({ to: "nobody", text: "hi", op });
  assert.equal(ok.type, "ack");
  const reused = await s.send({ to: "nobody", text: "different", op });
  assert.match(reused.error, /op_reused/);
  // Equivalent encodings of reply_to and ttl are the same operation.
  const ref = crypto.randomUUID();
  const op2 = opId();
  const x = await s.send({ to: "nobody", text: "r", reply_to: ref.toUpperCase(), op: op2 });
  const y = await s.send({ to: "nobody", text: "r", reply_to: ref, op: op2 });
  assert.equal(x.message_id, y.message_id);
  assert.match((await s.send({ to: "nobody", text: "r", reply_to: ref, ttl: 60, op: op2 })).error, /op_reused/);
  await sleep(100);
  assert.equal(carol.messages().length, 2);
});

test("fan-out recipients are those of the first execution", async (t) => {
  const { sender, peer } = await setup(t);
  const one = await peer("one");
  const s = await sender("lead");
  const op = opId();
  const first = await s.send({ to: "@all", text: "standup", op });
  assert.equal(first.count, 1);
  const two = await peer("two"); // comes online before the retry
  const again = await s.send({ to: "@all", text: "standup", op });
  assert.equal(again.count, 1);
  await sleep(200);
  assert.equal(one.messages().length, 1);
  assert.equal(two.messages().length, 0, "a retry never adds recipients");
});

test("a full operation memory refuses new operations before acceptance, never forgets an accepted one", async (t) => {
  const { sender, peer } = await setup(t, { opsPerPrincipal: 3 });
  const bob = await peer("bob");
  const s = await sender("alice");
  const ids = [opId(), opId(), opId()];
  const outcomes = [];
  for (const [i, op] of ids.entries()) outcomes.push(await s.send({ to: "bob", text: `m${i}`, op }));
  const full = await s.send({ to: "bob", text: "m3", op: opId() });
  assert.match(full.error, /too_many_operations/);
  // The first operation's reply was "lost": its retry still returns the cached outcome.
  const retry = await s.send({ to: "bob", text: "m0", op: ids[0] });
  assert.equal(retry.message_id, outcomes[0].message_id);
  await sleep(200);
  assert.deepEqual(bob.messages().map((m) => m.text), ["m0", "m1", "m2"], "nothing delivered twice, the refused one not at all");
  // Without an op, sends are not limited by the operation memory.
  assert.equal((await s.send({ to: "bob", text: "plain" })).type, "ack");
});

test("operation ids belong to protocol 2 and to one session name", async (t) => {
  const { sender, peer } = await setup(t);
  await peer("bob");
  const v1 = await sender("old", 1);
  assert.match((await v1.send({ to: "bob", text: "x", op: opId() })).error, /operation id/);
  const s = await sender("alice");
  assert.match((await s.send({ to: "bob", text: "x", op: "bad" })).error, /operation id/);
  // The same op from another session name is another operation (executed again).
  const op = opId();
  const a = await s.send({ to: "bob", text: "x", op });
  const other = await sender("alice-2");
  const b = await other.send({ to: "bob", text: "x", op });
  assert.notEqual(a.message_id, b.message_id);
});

test("the client retries a send whose reply was lost, on the same relay incarnation only", async (t) => {
  const { RelayClient } = await import("../lib/client.js");
  const { url, token } = await setup(t);
  // bob receives but never confirms, so the relay answers only after its 5-second window.
  const bob = connect(url, { type: "hello", v: 2, name: "bob", token, host: "pc", mode: "peer", claim: { action: "acquire" } });
  await bob.next((f) => f.type === "welcome");
  const c = new RelayClient({ url, token, name: "alice", mode: "send" });
  t.after(() => c.close());
  await c.start().ready();
  const sending = c.send("bob", "exactly once");
  await sleep(200);
  c.ws.terminate(); // the connection drops before the relay's answer
  const ack = await sending;
  assert.equal(ack.state, "unconfirmed");
  await sleep(200);
  assert.deepEqual(bob.messages().map((m) => m.text), ["exactly once"], "executed once");
});

test("after a relay restart, a send with a lost reply is reported as unknown, not retried", async (t) => {
  const { RelayClient } = await import("../lib/client.js");
  const token = fakeToken();
  const realm = { id: "8".repeat(32) };
  let relay = await startRelay({ host: "127.0.0.1", port: 0, token, realm, log: () => {} });
  const port = relay.port;
  t.after(() => relay.close());
  const url = `ws://127.0.0.1:${port}`;
  const bob = connect(url, { type: "hello", v: 2, name: "bob", token, host: "pc", mode: "peer", claim: { action: "acquire" } });
  await bob.next((f) => f.type === "welcome");
  const c = new RelayClient({ url, token, name: "alice", mode: "send" });
  t.after(() => c.close());
  await c.start().ready();
  const sending = c.send("bob", "maybe", undefined, undefined, { retryMs: 8000 });
  await sleep(200);
  await relay.close(); // the reply is lost with the relay
  relay = await startRelay({ host: "127.0.0.1", port, token, realm, log: () => {} });
  await assert.rejects(sending, (e) => e.kind === "lost" || e.kind === "no_answer");
});
