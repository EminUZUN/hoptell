// Bug B2: a session process waiting for its name (4006 name_in_use) still sends, through a
// send-only connection the relay accepts only while a session of the same credential holds the
// name (as_holder). Relay rule, client state and the engine path.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket, { WebSocketServer } from "ws";
import { createEngine } from "../lib/engine.js";
import { readSettings } from "../lib/settings.js";
import { RelayClient } from "../lib/client.js";
import { startRelay } from "../lib/relay.js";
import { fakeToken, sleep } from "./helpers.js";
import { deviceRelay } from "./mls-helpers.js";

const REALM = "1".repeat(32);
const ALICE = "m_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const BOB = "m_bbbbbbbbbbbbbbbbbbbbbbbbbb";
const textOf = (r) => r.content[0].text;
async function until(fn, ms = 8000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) if (await fn()) return true;
  return false;
}
const tmp = (t, label) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `hoptell-${label}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return dir;
};

/** A relay with the shared token (unless `shared: false`) and members alice and bob. */
async function setup(t, { shared = true } = {}) {
  const tokens = { alice: fakeToken(), bob: fakeToken(), shared: fakeToken() };
  const relay = await startRelay({
    host: "127.0.0.1",
    port: 0,
    token: shared ? tokens.shared : null,
    members: [{ name: "alice", id: ALICE, token: tokens.alice }, { name: "bob", id: BOB, token: tokens.bob }],
    realm: { id: REALM, name: "team" },
    log: () => {},
  });
  t.after(() => relay.close());
  return { relay, tokens, url: `ws://127.0.0.1:${relay.port}` };
}

/** A connected client; `got` records what a peer receives. */
async function client(t, url, token, name, { mode = "peer", roles = [], ...rest } = {}) {
  const c = new RelayClient({ url, token, name, mode, roles, reconnect: false, ...rest });
  c.got = [];
  c.on("message", (m, confirm) => (c.got.push(m), confirm?.({ released: true })));
  t.after(() => c.close());
  await c.start().ready(5000);
  return c;
}

const engineFor = (t, env) => {
  const e = createEngine(readSettings({ env: { HOPTELL_PUSH: "listener", ...env }, homedir: "/nonexistent-home", pid: process.pid, hostname: "testhost" }), { findHost: () => null, keepAlive: true });
  t.after(() => e.stop());
  return e;
};
/** Two engines with the same name, credential and home: the first holds the name, the second waits. */
async function siblings(t, url, token, name, home) {
  // Every sender reaches these sessions (a new home would otherwise ask).
  if (!fs.existsSync(path.join(home, "contacts.json"))) fs.writeFileSync(path.join(home, "contacts.json"), JSON.stringify(contactsDoc(REALM, [])), { mode: 0o600 });
  const env = { HOPTELL_RELAY: url, HOPTELL_TOKEN: token, HOPTELL_HOME: home, HOPTELL_NAME: name };
  const holder = engineFor(t, env);
  await holder.start();
  assert.ok(await until(() => holder.session.state === "bound"), "the first engine holds the name");
  const waiter = engineFor(t, env);
  await waiter.start();
  assert.ok(await until(() => waiter.link.status().waitingForName), "the second engine waits for the name");
  return { holder, waiter };
}
const contactsDoc = (realm, encryption) => ({ version: 1, revision: 0, default: "allow", grants: [], blocks: [], encryption: encryption.map((e) => ({ realm, ...e })) });

test("relay: as_holder is accepted only while a peer of the sender's principal holds the name", async (t) => {
  const { relay, tokens, url } = await setup(t);
  const bob = await client(t, url, tokens.bob, "bob");
  assert.ok(bob.caps.includes("as_holder"), "the cap is advertised");
  const sendAs = async (token, name, extra = {}) => {
    const c = await client(t, url, token, name, { mode: "send", ...extra });
    try {
      return await c.send("bob", `as ${name}`, undefined, undefined, { asHolder: true });
    } catch (e) {
      return e;
    } finally {
      c.close();
    }
  };
  // Nobody holds the name.
  assert.equal((await sendAs(tokens.alice, "alice-x")).code, "not_holder");
  // alice holds alice-x: alice's send-only connection may send as its holder.
  const holder = await client(t, url, tokens.alice, "alice-x");
  const ok = await sendAs(tokens.alice, "alice-x");
  assert.equal(ok.state, "delivered");
  assert.ok(await until(() => bob.got.length === 1));
  assert.deepEqual([bob.got[0].from, bob.got[0].sender.member?.id, bob.got[0].noReply], ["alice-x", ALICE, undefined]);
  holder.close();
  await sleep(100);
  // A shared-token peer holds a member-prefixed name (mixed realm): alice may not send as it.
  const sharedHolder = await client(t, url, tokens.shared, "alice-y");
  const accepted = relay.stats().accepted;
  assert.equal((await sendAs(tokens.alice, "alice-y")).code, "not_holder");
  // A member holds a name: the shared credential may not send as it either.
  await client(t, url, tokens.alice, "alice-z");
  assert.equal((await sendAs(tokens.shared, "alice-z")).code, "not_holder");
  // Shared holder, shared sender: the same principal.
  assert.equal((await sendAs(tokens.shared, "alice-y")).state, "delivered");
  assert.equal(relay.stats().accepted, accepted + 1, "the refusals accepted nothing");
  // A reserved name (its holder vanished without a release) has no live holder.
  sharedHolder.ws.terminate();
  await sleep(200);
  assert.equal((await sendAs(tokens.shared, "alice-y")).code, "not_holder");
  // From a peer connection: a bad send (the client refuses it before it is written; raw frame here).
  const peer = await client(t, url, tokens.alice, "alice-p");
  await assert.rejects(peer.rpc({ type: "send", to: "bob", text: "x", as_holder: true }), /as_holder/);
  await assert.rejects(peer.send("bob", "x", undefined, undefined, { asHolder: true }), (e) => e.code === "no_as_holder");
});

test("relay: a repeated operation gets its first outcome, also from another connection after the holder changed; no cap, no send", async (t) => {
  const { relay, tokens, url } = await setup(t);
  const bob = await client(t, url, tokens.bob, "bob");
  const holder = await client(t, url, tokens.alice, "alice-o");
  const frame = { type: "send", to: "bob", text: "once", as_holder: true, op: `o_${"a".repeat(26)}` };
  const first = await client(t, url, tokens.alice, "alice-o", { mode: "send" });
  const ack = await first.rpc(frame);
  assert.equal(ack.state, "delivered");
  first.close();
  holder.close();
  await sleep(100);
  await client(t, url, tokens.shared, "alice-o"); // now another principal holds the name
  const again = await client(t, url, tokens.alice, "alice-o", { mode: "send" });
  const accepted = relay.stats().accepted;
  assert.equal((await again.rpc(frame)).message_id, ack.message_id, "the first outcome, not a second send");
  // A new operation is refused: the holder is another principal now.
  await assert.rejects(again.rpc({ ...frame, op: `o_${"b".repeat(26)}` }), (e) => e.code === "not_holder");
  assert.equal(relay.stats().accepted, accepted);
  assert.equal(bob.got.filter((m) => m.text === "once").length, 1);
  // A relay without the cap: the client writes nothing.
  again.caps = again.caps.filter((c) => c !== "as_holder");
  await assert.rejects(again.send("bob", "x", undefined, undefined, { asHolder: true }), (e) => e.code === "no_as_holder" && e.kind === "not_sent");
  assert.equal(relay.stats().accepted, accepted);
});

test("relay: a peer that released its name no longer counts as its holder; the operation binds as_holder", async (t) => {
  const { tokens, url } = await setup(t);
  await client(t, url, tokens.bob, "bob");
  // A raw protocol-2 peer that releases its claim and keeps its socket open.
  const raw = new WebSocket(url);
  t.after(() => raw.terminate());
  await new Promise((resolve) => raw.on("open", resolve));
  const welcome = new Promise((resolve) => raw.on("message", (d) => JSON.parse(d).type === "welcome" && resolve()));
  raw.send(JSON.stringify({ type: "hello", v: 2, name: "alice-r", token: tokens.alice, host: "pc", mode: "peer", claim: { action: "acquire" } }));
  await welcome;
  const sender = await client(t, url, tokens.alice, "alice-r", { mode: "send" });
  const frame = { type: "send", to: "bob", text: "x", as_holder: true, op: `o_${"c".repeat(26)}` };
  assert.equal((await sender.rpc(frame)).state, "delivered", "held: accepted");
  raw.send(JSON.stringify({ type: "release" }));
  await sleep(100);
  assert.equal((await sender.rpc({ type: "claim_status", name: "alice-r" })).state, "free");
  await assert.rejects(sender.rpc({ ...frame, op: `o_${"d".repeat(26)}` }), (e) => e.code === "not_holder");
  // The same operation id without as_holder, its value moved into to_member: not the cached outcome.
  const plain = { ...frame };
  delete plain.as_holder;
  await assert.rejects(sender.rpc({ ...plain, to_member: { as_holder: true } }), /op_reused/);
});

test("engine: a waiting sibling refuses to send when the managed contacts file breaks", async (t) => {
  const w = await deviceRelay(t, { e2ee: true });
  await client(t, w.url, w.members.bob.token, "bob");
  const home = tmp(t, "b2c");
  const file = path.join(home, "contacts.json");
  fs.writeFileSync(file, JSON.stringify(contactsDoc(w.realm, [{ member: w.members.bob.id, mode: "required" }])), { mode: 0o600 });
  const { waiter } = await siblings(t, w.url, w.members.alice.token, "alice-x", home);
  const accepted = w.relay.stats().accepted;
  fs.writeFileSync(file, "{damaged", { mode: 0o600 });
  const r = await waiter.call("send_message", { to: "bob", message: "must not leak" });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /the contacts cannot be read .*encryption policy cannot be checked; nothing was sent/);
  assert.equal(w.relay.stats().accepted, accepted);
});

test("engine: a send whose acknowledgement is lost is reported as unknown at once, not retried", async (t) => {
  // A fake protocol-2 relay: the name is in use; a send-only welcome; a send closes the socket.
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  t.after(() => new Promise((r) => (wss.clients.forEach((c) => c.terminate()), wss.close(r))));
  await new Promise((r) => wss.on("listening", r));
  let sends = 0;
  wss.on("connection", (ws) =>
    ws.on("message", (d) => {
      const m = JSON.parse(d);
      if (m.type === "hello" && m.claim) {
        ws.send(JSON.stringify({ type: "hello_error", code: "name_in_use" }));
        return ws.close(4006, "name in use by another session");
      }
      if (m.type === "hello") return ws.send(JSON.stringify({ type: "welcome", name: m.name, auth: "members", realm: { id: REALM, name: "team" }, member: { id: ALICE, name: "alice" }, claim: null, incarnation: "i1", caps: ["auth", "realm", "member", "lease", "claim-status", "sender", "idempotent-send", "to_member", "list_own", "as_holder"] }));
      if (m.type === "claim_status") return ws.send(JSON.stringify({ type: "claim_status", id: m.id, state: "taken" }));
      if (m.type === "send") {
        sends++;
        return ws.terminate();
      }
    }),
  );
  const home = tmp(t, "b2l");
  fs.writeFileSync(path.join(home, "contacts.json"), JSON.stringify(contactsDoc(REALM, [])), { mode: 0o600 });
  const e = engineFor(t, { HOPTELL_RELAY: `ws://127.0.0.1:${wss.address().port}`, HOPTELL_TOKEN: fakeToken(), HOPTELL_HOME: home, HOPTELL_NAME: "alice-x" });
  await e.start();
  assert.ok(await until(() => e.link.status().waitingForName));
  const started = Date.now();
  const r = await e.call("send_message", { to: "bob", message: "lost" });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /ended before the relay answered .*may or may not have been sent/);
  assert.ok(Date.now() - started < 3000, "reported at once");
  assert.equal(sends, 1, "written once, not retried");
});

test("older clients: a send without as_holder is handled exactly as before, held name or not", async (t) => {
  const { relay, tokens, url } = await setup(t);
  const bob = await client(t, url, tokens.bob, "bob");
  // A send-only connection under a name nobody holds (a plain `hoptell send`): accepted, no reply.
  const cli = await client(t, url, tokens.alice, "alice-cli", { mode: "send" });
  assert.equal((await cli.send("bob", "plain")).state, "delivered");
  // Under a name another principal holds: accepted as before (the flag is opt-in).
  await client(t, url, tokens.shared, "alice-h");
  const old = await client(t, url, tokens.alice, "alice-h", { mode: "send" });
  assert.equal((await old.send("bob", "old")).state, "delivered");
  // A protocol-1 client: unchanged, and its frames never carry the flag.
  const v1 = await client(t, url, tokens.alice, "alice-v1", { mode: "send", protocol: 1 });
  assert.equal(v1.protocolInUse, 1);
  assert.equal((await v1.send("bob", "v1")).state, "delivered");
  await assert.rejects(v1.send("bob", "x", undefined, undefined, { asHolder: true }), (e) => e.code === "no_as_holder" && e.kind === "not_sent");
  assert.ok(await until(() => bob.got.length === 3));
  assert.deepEqual(bob.got.map((m) => [m.text, Boolean(m.noReply)]), [["plain", true], ["old", false], ["v1", true]]);
  assert.equal(relay.stats().accepted, 3);
});

test("a protocol-1 relay never gets the flag, and a waiting engine never arises there", async (t) => {
  // A fake protocol-1 relay: refuses protocol 2 (4005), welcomes protocol 1, records every frame.
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  t.after(() => new Promise((r) => (wss.clients.forEach((c) => c.terminate()), wss.close(r))));
  await new Promise((r) => wss.on("listening", r));
  const frames = [];
  wss.on("connection", (ws) =>
    ws.on("message", (d) => {
      const m = JSON.parse(d);
      frames.push(m);
      if (m.type === "hello" && m.v === 2) return ws.close(4005, "unsupported protocol");
      if (m.type === "hello") return ws.send(JSON.stringify({ type: "welcome", name: m.name }));
      if (m.type === "send") return ws.send(JSON.stringify({ type: "ack", id: m.id, state: "delivered" }));
      if (m.type === "list") return ws.send(JSON.stringify({ type: "peers", id: m.id, peers: [] }));
    }),
  );
  const url = `ws://127.0.0.1:${wss.address().port}`;
  const c = new RelayClient({ url, token: fakeToken(), name: "alice-x", mode: "send", reconnect: false });
  t.after(() => c.close());
  await c.start().ready(5000);
  assert.equal(c.protocolInUse, 1, "fell back to protocol 1");
  await assert.rejects(c.send("bob", "x", undefined, undefined, { asHolder: true }), (e) => e.code === "no_as_holder");
  assert.equal((await c.send("bob", "plain")).state, "delivered");
  // An engine on it: protocol 1, never waiting for a name, sends through its own connection.
  const home = tmp(t, "b2v1");
  const e = engineFor(t, { HOPTELL_RELAY: url, HOPTELL_TOKEN: fakeToken(), HOPTELL_HOME: home, HOPTELL_NAME: "alice-y" });
  await e.start();
  assert.ok(await until(() => e.session.state === "legacy"));
  assert.equal(e.link.status().waitingForName, false);
  assert.match(textOf(await e.call("send_message", { to: "bob", message: "from engine" })), /Delivered to bob/);
  const sends = frames.filter((f) => f.type === "send");
  assert.equal(sends.length, 2);
  assert.ok(sends.every((f) => !("as_holder" in f)), "no frame carries as_holder");
});

test("client: waitingForName is set only for the protocol-2 wait after 4006, and cleared on the welcome", async (t) => {
  const { tokens, url } = await setup(t);
  const a = await client(t, url, tokens.alice, "alice-w");
  const b = new RelayClient({ url, token: tokens.alice, name: "alice-w", nameCheckMs: [200, 400] });
  t.after(() => b.close());
  assert.equal(b.waitingForName, false);
  b.start();
  assert.ok(await until(() => b.waitingForName), "waiting after name_in_use");
  a.close();
  await b.ready(8000);
  assert.equal(b.waitingForName, false, "cleared once connected");
  // Without waiting (reconnect false), name_in_use is final: no wait.
  const c = new RelayClient({ url, token: tokens.alice, name: "alice-w", reconnect: false });
  t.after(() => c.close());
  await assert.rejects(c.start().ready(3000), /in use/);
  assert.equal(c.waitingForName, false);
});

test("engine: a waiting sibling sends as the name, list_peers and link.list work, and after the holder stops it sends normally", async (t) => {
  const { relay, tokens, url } = await setup(t, { shared: false });
  const bob = await client(t, url, tokens.bob, "bob", { roles: ["rev"] });
  const home = tmp(t, "b2m");
  const { holder, waiter } = await siblings(t, url, tokens.alice, "alice-x", home);
  const r = await waiter.call("send_message", { to: "bob", message: "verdict" });
  assert.equal(r.isError, false, textOf(r));
  assert.match(textOf(r), /Delivered to bob/);
  assert.match(textOf(r), /Sent through a separate connection\. Another connection of member "alice" holds "alice-x" and receives replies/);
  assert.ok(await until(() => bob.got.length === 1));
  assert.deepEqual([bob.got[0].from, bob.got[0].sender.member?.id, bob.got[0].noReply], ["alice-x", ALICE, undefined]);
  // A reply reaches the holder.
  await bob.send("alice-x", "thanks", undefined, bob.got[0].message_id);
  assert.ok(await until(async () => /thanks/.test(textOf(await holder.call("read_inbox")))), "the holder got the reply");
  assert.equal(holder.session.state, "bound", "the holder keeps the name");
  // list_peers on the waiting engine, and the composer's path (link.list).
  const l = await waiter.call("list_peers");
  assert.equal(l.isError, false, textOf(l));
  assert.match(textOf(l), /waiting for its name/);
  assert.match(textOf(l), /- bob \(/);
  assert.ok((await waiter.link.list()).some((p) => p.name === "bob"));
  // Other tools stay as before on a waiting process.
  assert.match(textOf(await waiter.call("read_inbox")), /not connected/);
  // The holder stops: the sibling gets the name and sends through its receiving connection.
  await holder.stop();
  assert.ok(await until(() => waiter.session.state === "bound", 15_000), "the sibling took the name");
  assert.equal(waiter.link.status().waitingForName, false);
  const after = await waiter.call("send_message", { to: "bob", message: "direct" });
  assert.match(textOf(after), /Delivered to bob/);
  assert.doesNotMatch(textOf(after), /send-only/);
  assert.ok(relay.stats().accepted >= 3);
});

test("engine: a member waiting for a name a shared-token peer holds sends nothing", async (t) => {
  const { relay, tokens, url } = await setup(t);
  await client(t, url, tokens.bob, "bob");
  await client(t, url, tokens.shared, "alice-x"); // the shared credential may take any name
  const waiter = engineFor(t, { HOPTELL_RELAY: url, HOPTELL_TOKEN: tokens.alice, HOPTELL_HOME: tmp(t, "b2x"), HOPTELL_NAME: "alice-x" });
  await waiter.start();
  assert.ok(await until(() => waiter.link.status().waitingForName));
  const accepted = relay.stats().accepted;
  const r = await waiter.call("send_message", { to: "bob", message: "must not go" });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /is held by another member or token, or is no longer held; .*nothing was sent/);
  assert.equal(relay.stats().accepted, accepted);
});

test("engine: two shared-credential siblings: the waiting one sends", async (t) => {
  const { tokens, url } = await setup(t);
  const bob = await client(t, url, tokens.bob, "bob");
  const { waiter } = await siblings(t, url, tokens.shared, "sib", tmp(t, "b2s"));
  const r = await waiter.call("send_message", { to: "bob", message: "from sib" });
  assert.match(textOf(r), /Delivered to bob/);
  assert.ok(await until(() => bob.got.some((m) => m.from === "sib" && m.sender.auth === "shared")));
});

test("engine: a waiting sibling applies the CLI's encryption rule against the send-only welcome", async (t) => {
  // A relay with the e2ee service (it names the member behind a session); the engines have
  // encrypted messaging off, as the CLI.
  const w = await deviceRelay(t, { e2ee: true });
  const { relay } = w;
  const bob = await client(t, w.url, w.members.bob.token, "bob", { roles: ["rev"] });
  const home = tmp(t, "b2p");
  const policy = (entries) => fs.writeFileSync(path.join(home, "contacts.json"), JSON.stringify(contactsDoc(w.realm, entries)), { mode: 0o600 });
  policy([]);
  const { waiter } = await siblings(t, w.url, w.members.alice.token, "alice-x", home);
  // preferred direct: plaintext, said so.
  policy([{ member: w.members.bob.id, mode: "preferred" }]);
  const p = await waiter.call("send_message", { to: "bob", message: "preferred" });
  assert.equal(p.isError, false, textOf(p));
  assert.match(textOf(p), /\(Not encrypted: the hoptell CLI does not send encrypted messages yet/);
  assert.ok(await until(() => bob.got.some((m) => m.text === "preferred")));
  const accepted = relay.stats().accepted;
  // required direct: refused.
  policy([{ member: w.members.bob.id, mode: "required" }]);
  const r = await waiter.call("send_message", { to: "bob", message: "must not leak" });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /encryption is required for bob.*nothing was sent/);
  // Fan-out with any policy for the realm: refused, also when preferred only.
  policy([{ member: w.members.bob.id, mode: "preferred" }]);
  for (const to of ["@rev", "@all"]) {
    const f = await waiter.call("send_message", { to, message: "must not leak" });
    assert.equal(f.isError, true);
    assert.match(textOf(f), /fan-out .* is plaintext from the hoptell CLI/);
  }
  assert.equal(relay.stats().accepted, accepted, "nothing was accepted");
  assert.ok(!bob.got.some((m) => m.text === "must not leak"));
});
