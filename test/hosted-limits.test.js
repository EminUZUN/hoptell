// Stored-data limits of hosted mode (design 4.5): the tenant's inbox cap (inbound left at the
// relay, not dropped), the host budget over every durable file, the admission and hard floors
// (admission versus progress writes), the write-error contract of acknowledgements, resuming with
// hysteresis, and live-engine admission with parking. Free space is scripted.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createStorageGuard } from "../lib/hostedstorage.js";
import { HANNA, HUGO } from "./hosted-helpers.js";
import { hostedWorld } from "./hosted-world.js";
import { sleep } from "./helpers.js";

const call = async (client, name, args = {}) => (await client.callTool({ name, arguments: args })).content[0].text;
const until = async (fn, ms = 4000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(25)) if (await fn()) return true;
  return Boolean(await fn());
};
const receiptOf = (t) => /Receipt: ([^ .]+)\./.exec(t)?.[1];
const MB = 1024 * 1024;

/** A world whose volume reports `disk.free` bytes, with these storage limits and store faults. */
function world(t, { storage = {}, limits = {}, fault = null } = {}) {
  const disk = { free: 10_000 * MB };
  let guard = null;
  return hostedWorld(t, {
    limits: { requestsPerMinute: 100_000, ...limits },
    tenantOptions: (state) => {
      guard = createStorageGuard({ stateDir: state, freeBytes: () => disk.free, limits: { usageCacheMs: 0, resumeMarginBytes: 0, resumeMarginMessages: 0, admissionFloorBytes: 100 * MB, hardFloorBytes: 50 * MB, ...storage } });
      return { storage: guard, engineDeps: fault ? { storeOptions: { fault: (p, f) => (fault(p, f), guard.forTenant("/nonexistent").fault(p)) } } : {} };
    },
  }).then((w) => Object.assign(w, { disk, guard: () => guard }));
}

test("tenant inbox cap: inbound beyond it stays at the relay (not dropped) and arrives once there is room", async (t) => {
  const w = await world(t, { storage: { tenantMessages: 2 } });
  const { client } = await w.connect("hanna-sub");
  w.allowBob(HANNA);
  const bob = await w.bob();
  for (const n of [1, 2, 3, 4]) await bob.send("hanna", `message-${n}-text`);
  let first = "";
  await until(async () => /message-2-text/.test((first = await call(client, "read_inbox"))));
  assert.match(first, /message-1-text[\s\S]*message-2-text/);
  assert.doesNotMatch(first, /message-3-text/);
  assert.ok(w.relay.stats().queueItems + w.relay.stats().unconfirmed >= 1, "the rest waits at the relay");
  assert.match(await call(client, "read_inbox", { ack: receiptOf(first) }), /hosted inbox is full|message-3-text/);
  // Room again: the engine resumes and the relay delivers the rest.
  let rest = "";
  let last = null;
  await until(async () => {
    const r = await call(client, "read_inbox", last ? { ack: last } : {});
    last = receiptOf(r) ?? null;
    rest += r;
    return /message-4-text/.test(rest);
  }, 15_000);
  assert.match(rest, /message-3-text/);
  assert.match(rest, /message-4-text/);
});

test("admission floor: new sends and inbound storage are refused (nothing partial) while reading and acknowledging still run", async (t) => {
  const w = await world(t);
  const { client } = await w.connect("hanna-sub");
  w.allowBob(HANNA);
  const bob = await w.bob();
  await bob.send("hanna", "before");
  let text = "";
  await until(async () => /before/.test((text = await call(client, "read_inbox"))));
  w.disk.free = 80 * MB; // below the admission floor, above the hard floor
  const sent = await call(client, "send_message", { to: "bob", message: "refused" });
  assert.match(sent, /host storage full/);
  await sleep(200);
  assert.equal(bob.got.length, 0, "nothing was sent");
  await bob.send("hanna", "waits at the relay");
  await sleep(500);
  // Progress writes still run: the acknowledgement of what was read.
  assert.equal(await call(client, "ack_messages", { receipt: receiptOf(text) }), "Acknowledged.");
  assert.doesNotMatch(await call(client, "read_inbox"), /waits at the relay/);
  // Free space returns above the floor (plus the margin): receiving resumes.
  w.disk.free = 10_000 * MB;
  let later = "";
  await until(async () => /waits at the relay/.test((later = await call(client, "read_inbox"))), 15_000);
  assert.match(later, /waits at the relay/);
});

test("hard floor: below it an acknowledgement fails before its commit point: reported, the receipt stays held, and works again later", async (t) => {
  const w = await world(t);
  const { client } = await w.connect("hanna-sub");
  w.allowBob(HANNA);
  await (await w.bob()).send("hanna", "keep me");
  let text = "";
  await until(async () => /keep me/.test((text = await call(client, "read_inbox"))));
  const receipt = receiptOf(text);
  w.disk.free = 10 * MB; // below the hard floor
  assert.match(await call(client, "ack_messages", { receipt }), /Not acknowledged: the host could not record it/);
  w.disk.free = 10_000 * MB;
  assert.equal(await call(client, "ack_messages", { receipt }), "Acknowledged.");
  assert.doesNotMatch(await call(client, "read_inbox"), /keep me/);
});

test("write errors: ENOSPC at the done marker after the acknowledgement committed is pending, never refused; a retry answers ok and the messages never return", async (t) => {
  const failDone = { on: false };
  const w = await world(t, {
    fault: (point, file) => {
      if (failDone.on && point === "write" && /[/\\]done[/\\]/.test(file)) throw Object.assign(new Error("ENOSPC: injected"), { code: "ENOSPC" });
    },
  });
  const { client } = await w.connect("hanna-sub");
  w.allowBob(HANNA);
  await (await w.bob()).send("hanna", "ack me once");
  let text = "";
  await until(async () => /ack me once/.test((text = await call(client, "read_inbox"))));
  failDone.on = true;
  assert.match(await call(client, "ack_messages", { receipt: receiptOf(text) }), /Acknowledgement pending: it completes on the next access/);
  failDone.on = false;
  assert.equal(await call(client, "ack_messages", { receipt: receiptOf(text) }), "Acknowledged.");
  assert.doesNotMatch(await call(client, "read_inbox"), /ack me once/);
});

test("host budget: every durable file counts (operation and store records); a send over it is refused", async (t) => {
  const w = await world(t, { storage: { hostBytes: 64 * 1024 } });
  const { client } = await w.connect("hanna-sub");
  assert.ok(w.guard().state().hostBytes > 0, "the tenant's files already count");
  assert.match(await call(client, "send_message", { to: "bob", message: "x".repeat(70 * 1024) }), /host storage full \(the host's storage budget is used up\)/);
});

test("live engines: at the cap an idle engine without a session is parked and resumes later; engines with sessions never are; 503 only when none can be", async (t) => {
  const w = await world(t, { limits: { liveEngines: 1 } });
  const hanna = await w.connect("hanna-sub");
  // hanna has a session: hugo cannot get an engine.
  await assert.rejects(w.connect("hugo-sub"), /503|limit of live engines/);
  await hanna.transport.terminateSession();
  await sleep(100);
  // hanna has no session now: hugo's session parks her engine.
  const hugo = await w.connect("hugo-sub");
  assert.match(await call(hugo.client, "list_peers"), /hugo/);
  assert.equal(w.tenants.runtimes().find((r) => r.member === HANNA.id).state, "parked");
  await hugo.transport.terminateSession();
  await sleep(100);
  const again = await w.connect("hanna-sub");
  assert.match(await call(again.client, "read_inbox"), /receiving was paused while you were away/);
  assert.equal(w.tenants.runtimes().find((r) => r.member === HUGO.id).state, "parked");
});

test("tenant cap counts the quarantine: held messages from an unknown sender use it; beyond it inbound waits at the relay", async (t) => {
  const w = await world(t, { storage: { tenantMessages: 2 } });
  await w.connect("hanna-sub"); // bob is not allowed: his messages are held (gate 3, ask)
  const bob = await w.bob();
  for (const n of [1, 2, 3]) await bob.send("hanna", `held ${n}`);
  const quarantined = () => {
    let n = 0;
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (path.basename(d) === "quarantine" && e.name.endsWith(".json")) n++;
      }
    };
    walk(w.homeOf(HANNA));
    return n;
  };
  await until(() => quarantined() === 2);
  await sleep(500);
  assert.equal(quarantined(), 2, "the cap holds across the quarantine");
  assert.ok(w.relay.stats().queueItems + w.relay.stats().unconfirmed >= 1, "the third waits at the relay, not dropped");
  assert.equal(w.guard().forTenant(w.homeOf(HANNA)).admit(10) !== null, true, "an inbox message would be refused too");
});
