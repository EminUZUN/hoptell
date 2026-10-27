// Hosted tenants (design 4.5): per-tenant homes and engines signed in with the host credential,
// one logical engine per MCP session, the five hosted tools, gate 3 per tenant, isolation and no
// host detail in what tenants see.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { HOSTED_TOOLS } from "../lib/hostedtenants.js";
import { HANNA, HUGO } from "./hosted-helpers.js";
import { hostedWorld } from "./hosted-world.js";
import { sleep } from "./helpers.js";

const call = async (client, name, args = {}) => (await client.callTool({ name, arguments: args })).content[0].text;
const until = async (fn, ms = 3000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(25)) if (await fn()) return true;
  return Boolean(await fn());
};
const receiptOf = (t) => /Receipt: (\S+)/.exec(t)?.[1];

test("tools: exactly the five hosted tools; nothing a tenant sees names a host path or the relay's address", async (t) => {
  const w = await hostedWorld(t);
  const { client } = await w.connect("hanna-sub");
  const tools = (await client.listTools()).tools.map((x) => x.name).sort();
  assert.deepEqual(tools, [...HOSTED_TOOLS].sort());
  const everything = JSON.stringify([(await client.listTools()).tools, client.getInstructions(), await call(client, "list_peers"), await call(client, "read_inbox")]);
  assert.ok(!everything.includes(w.state) && !everything.includes(`127.0.0.1:${w.relay.port}`), "no host path or relay address");
  assert.match(everything, /hosted/);
  assert.match(everything, /ack_messages/, "every tool named in hosted result text is offered");
});

test("inbound custody: the tenant's engine keeps receiving with no session open; reads carry receipts; ack_messages and ack work", async (t) => {
  const w = await hostedWorld(t);
  const first = await w.connect("hanna-sub");
  await first.client.close();
  w.allowBob(HANNA);
  const bob = await w.bob();
  for (const n of [1, 2, 3]) await bob.send("hanna", `hello ${n}`);
  const { client } = await w.connect("hanna-sub");
  let text = "";
  await until(async () => /hello 1/.test((text = await call(client, "read_inbox"))));
  assert.match(text, /hello 1/);
  const r1 = receiptOf(text);
  assert.ok(r1, "a receipt");
  assert.equal(await call(client, "ack_messages", { receipt: r1 }), "Acknowledged.");
  await until(async () => /hello/.test((text = await call(client, "read_inbox"))));
  if (/hello/.test(text)) {
    const r2 = receiptOf(text);
    const waited = await call(client, "wait_for_message", { ack: r2, timeout_seconds: 1 });
    assert.match(waited, /Wait ended without returning messages \(limit: 1s\)|hello/);
  }
  // Acknowledged messages are not shown again.
  assert.doesNotMatch(await call(client, "read_inbox"), /hello 1/);
});

test("gate 3 at the host: an unknown sender is held for the tenant's owner (default ask), never shown", async (t) => {
  const w = await hostedWorld(t);
  const { client } = await w.connect("hanna-sub");
  const bob = await w.bob();
  await bob.send("hanna", "who am I");
  let text = "";
  await until(async () => /Your user's contacts held these messages/.test((text = await call(client, "read_inbox"))));
  assert.match(text, /Your user's contacts held these messages/);
  assert.doesNotMatch(text, /who am I/);
});

test("isolation: two tenants never see each other's messages; each has its own home; tool arguments cannot escape it", async (t) => {
  const w = await hostedWorld(t);
  const hanna = await w.connect("hanna-sub");
  w.allowBob(HANNA);
  const hugo = await w.connect("hugo-sub");
  w.allowBob(HUGO);
  const bob = await w.bob();
  await bob.send("hugo", "for hugo only");
  let text = "";
  await until(async () => /for hugo only/.test((text = await call(hugo.client, "read_inbox"))));
  assert.match(text, /for hugo only/);
  assert.doesNotMatch(await call(hanna.client, "read_inbox"), /for hugo only/);
  assert.notEqual(w.homeOf(HANNA), w.homeOf(HUGO));
  // Hostile arguments and headers create nothing outside the tenants' homes.
  const tree = () => {
    const out = [];
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        out.push(p);
        if (e.isDirectory()) walk(p);
      }
    };
    walk(w.dir);
    return out.filter((p) => !p.startsWith(path.join(w.state, "tenants")) && !p.startsWith(path.join(w.dir, "relay")));
  };
  const before = tree();
  for (const evil of ["../../x", "..\u0000/y", "/etc/passwd", "a".repeat(5000), "%2e%2e/z"]) {
    await call(hanna.client, "send_message", { to: evil, message: evil });
    await call(hanna.client, "ack_messages", { receipt: evil });
    await call(hanna.client, "read_inbox", { ack: evil });
    await call(hanna.client, "wait_for_message", { ack: evil, timeout_seconds: 1 });
  }
  assert.deepEqual(tree(), before);
});

test("sessions: ending one keeps the tenant receiving; a DELETE during wait_for_message returns within the drain", async (t) => {
  const w = await hostedWorld(t);
  const a = await w.connect("hanna-sub");
  w.allowBob(HANNA);
  const pending = a.client.callTool({ name: "wait_for_message", arguments: { timeout_seconds: 60 } }).then(() => "answered", (e) => `failed: ${e.message}`);
  await sleep(200);
  const t0 = Date.now();
  await a.transport.terminateSession();
  const r = await Promise.race([pending, sleep(5000).then(() => "hung")]);
  assert.notEqual(r, "hung");
  assert.ok(Date.now() - t0 < 4000);
  const bob = await w.bob();
  await bob.send("hanna", "after the session");
  const b = await w.connect("hanna-sub");
  let text = "";
  await until(async () => /after the session/.test((text = await call(b.client, "read_inbox"))));
  assert.match(text, /after the session/);
  assert.equal(w.tenants.runtimes().length, 1, "one engine for the tenant");
});

test("hosted sends: plaintext to a local member, with custody provenance; list_peers labels hosted peers", async (t) => {
  const w = await hostedWorld(t);
  const bob = await w.bob();
  const { client } = await w.connect("hanna-sub");
  await w.connect("hugo-sub");
  assert.match(await call(client, "send_message", { to: "bob", message: "from hanna" }), /bob/);
  await until(() => bob.got.length);
  assert.equal(bob.got[0].sender.custody, "hosted");
  assert.match(await call(client, "list_peers"), /hugo .*hosted: the host can read messages/);
  assert.ok(w.logs.some((l) => /hosted send: tenant .* subject hanna-sub client client-a message [0-9a-f-]{36}$/.test(l)), "the send is logged with the principal and the message id");
  assert.ok(!w.logs.some((l) => l.includes("from hanna")), "never its text");
});
