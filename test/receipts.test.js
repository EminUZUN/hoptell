// Receipts end to end: MCP tools, CLI listen and ack, engine stop, and backpressure.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createEngine } from "../lib/engine.js";
import { readSettings } from "../lib/settings.js";
import { openStore } from "../lib/store.js";
import { TOKEN, existingInstall, sleep, world } from "./helpers.js";

const ON = { HOPTELL_RECEIPTS: "on" };
const receiptOf = (text) => text.match(/Receipt: (r_[a-z2-7]{26})/)?.[1];
const count = (text) => (text.match(/--- hoptell message /g) || []).length;
async function until(fn, ms = 8000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) if (await fn()) return true;
  return false;
}

test("MCP: a batch comes with a receipt, repeats until acknowledged, and ack moves on", async (t) => {
  const w = await world();
  t.after(() => w.close());
  const bob = await w.mcp("bob", ON);
  const send = (text) => w.cli(["send", "bob", text], { HOPTELL_NAME: "alice" });
  await send("first");
  let out = "";
  assert.ok(await until(async () => /first/.test((out = await bob.call("read_inbox")))));
  const r1 = receiptOf(out);
  assert.ok(r1, out);
  assert.match(out, /Unacknowledged messages may reappear after 30 minutes; do not repeat completed actions\./);
  assert.equal(receiptOf(await bob.call("read_inbox")), r1, "not acknowledged: the same batch again");
  await send("second");
  await sleep(300);
  const next = await bob.call("read_inbox", { ack: r1 });
  assert.doesNotMatch(next, /first/);
  assert.match(next, /second/);
  const r2 = receiptOf(next);
  const waited = await bob.call("wait_for_message", { ack: r2, timeout_seconds: 1 });
  assert.match(waited, /Wait ended without returning messages \(limit: 1s\)/);
  assert.match(await bob.call("read_inbox"), /Inbox empty/);
  const bad = await bob.client.callTool({ name: "ack_messages", arguments: { receipt: "r_aaaaaaaaaaaaaaaaaaaaaaaaaa" } });
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /Receipt not recognized/);
  const { tools } = await bob.client.listTools();
  assert.match(tools.find((x) => x.name === "read_inbox").description, /When a result includes a receipt, acknowledge the handled batch/);
});

test("CLI: listen acknowledges after printing; --no-ack prints a receipt that hoptell ack accepts", async (t) => {
  const w = await world();
  t.after(() => w.close());
  const bob = await w.mcp("bob", ON);
  const { tools } = await bob.client.listTools();
  const dir = tools.find((x) => x.name === "read_inbox").description.match(/listen --session "([^"]+)"/)[1];
  await w.cli(["send", "bob", "for", "the", "listener"], { HOPTELL_NAME: "alice" });
  const heard = await w.cli(["listen", "--session", dir, "5"]);
  assert.match(heard.stdout, /for the listener/);
  assert.doesNotMatch(heard.stdout, /Receipt:/);
  await sleep(200);
  assert.match(await bob.call("read_inbox"), /Inbox empty/, "acknowledged by listen");
  await w.cli(["send", "bob", "manual"], { HOPTELL_NAME: "alice" });
  const manual = await w.cli(["listen", "--no-ack", "--session", dir, "5"]);
  const r = receiptOf(manual.stdout);
  assert.ok(r, manual.stdout);
  assert.match(manual.stdout, new RegExp(`hoptell ack ${r} --session`));
  assert.match(await bob.call("read_inbox"), /Inbox empty/, "held by the manual consumer, not shown to others");
  const acked = await w.cli(["ack", r, "--session", dir]);
  assert.equal(acked.code, 0, acked.stderr);
  assert.match(acked.stdout, /Acknowledged/);
  const again = await w.cli(["ack", r, "--session", dir]);
  assert.equal(again.code, 0, "a repeated acknowledgement succeeds");
  const wrong = await w.cli(["ack", "r_bbbbbbbbbbbbbbbbbbbbbbbbbb", "--session", dir]);
  assert.notEqual(wrong.code, 0);
  assert.match(wrong.stderr, /unknown receipt/);
});

test("a stopped engine's unacknowledged batch is shown again to the next session", async (t) => {
  const w = await world();
  t.after(() => w.close());
  const first = await w.mcp("carol", ON);
  await w.cli(["send", "carol", "survives"], { HOPTELL_NAME: "alice" });
  assert.ok(await until(async () => /survives/.test(await first.call("read_inbox"))));
  await first.client.close();
  await sleep(500);
  const second = await w.mcp("carol", ON);
  let out = "";
  assert.ok(await until(async () => /survives/.test((out = await second.call("read_inbox")))));
  assert.match(out, /Redelivered: not acknowledged\. Do not repeat completed actions\./);
});

test("backpressure: a full inbox declines, and the message arrives once room is freed, also from another process", async (t) => {
  const w = await world();
  t.after(() => w.close());
  const home = existingInstall(fs.mkdtempSync(path.join(os.tmpdir(), "hoptell-bp-")));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const env = { HOPTELL_RELAY: w.env.HOPTELL_RELAY, HOPTELL_TOKEN: TOKEN, HOPTELL_HOME: home, HOPTELL_NAME: "full", HOPTELL_PUSH: "listener" };
  const rx = createEngine(readSettings({ env, homedir: home, pid: process.pid }), { findHost: () => null, keepAlive: true, storeOptions: { quotaMessages: 2 } });
  t.after(() => rx.stop());
  await rx.start();
  assert.ok(await until(() => rx.session.state === "bound"));
  for (const x of ["m1", "m2", "m3"]) await w.cli(["send", "full", x], { HOPTELL_NAME: "alice" });
  assert.ok(await until(async () => /this inbox is full/.test((await rx.call("list_peers")).content[0].text)), "the third waits at the relay");
  const batch = (await rx.call("read_inbox")).content[0].text;
  assert.equal(count(batch), 2);
  // Another process acknowledges (as hoptell ack would): the engine notices the room.
  const other = await openStore(rx.session.store);
  assert.equal(await other.ack(receiptOf(batch)), "ok");
  let next = "";
  assert.ok(await until(async () => /m3/.test((next = (await rx.call("read_inbox")).content[0].text)), 15000), "the declined message arrives without a restart");
  assert.equal(count(next), 1);
});

const engineIn = (t, w, name, deps = {}, extra = {}) => {
  const home = existingInstall(fs.mkdtempSync(path.join(os.tmpdir(), "hoptell-rc-")));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const env = { HOPTELL_RELAY: w.env.HOPTELL_RELAY, HOPTELL_TOKEN: TOKEN, HOPTELL_HOME: home, HOPTELL_NAME: name, HOPTELL_PUSH: "listener", ...extra };
  const e = createEngine(readSettings({ env, homedir: home, pid: process.pid }), { findHost: () => null, keepAlive: true, ...deps });
  t.after(() => e.stop());
  return e;
};

test("a read waiting for the store lock when the engine stops creates no claim", async (t) => {
  const w = await world();
  t.after(() => w.close());
  const e = engineIn(t, w, "locked");
  await e.start();
  assert.ok(await until(() => e.session.state === "bound"));
  await w.cli(["send", "locked", "waiting"], { HOPTELL_NAME: "alice" });
  assert.ok(await until(async () => (await e.session.pipe.pending()).length === 1));
  const lock = path.join(e.session.store.dir, "store.json.lock");
  fs.writeFileSync(lock, `${process.ppid}\n`); // another live process holds the store
  const reading = e.call("read_inbox");
  await sleep(200);
  const stopping = e.stop();
  await sleep(100);
  fs.rmSync(lock);
  await stopping;
  const r = await reading;
  assert.doesNotMatch(r.content[0].text, /Receipt:/);
  const claimed = path.join(e.session.store.dir, "claimed");
  assert.deepEqual(fs.readdirSync(claimed), [], "nothing is held for the stopped engine");
});

test("idle sessions announce a batch again when its lease expires, in every delivery mode", async (t) => {
  const w = await world();
  t.after(() => w.close());
  const e = engineIn(t, w, "idle", { storeOptions: { leaseMs: 300 } });
  const notices = [];
  e.attach({ notify: (m) => notices.push(m.from) });
  await e.start();
  assert.ok(await until(() => e.session.state === "bound"));
  await w.cli(["send", "idle", "once"], { HOPTELL_NAME: "alice" });
  assert.ok(await until(() => notices.length === 1));
  await e.call("read_inbox"); // taken, never acknowledged
  assert.ok(await until(() => notices.length === 2, 10_000), "announced again after the lease, without new traffic");
});

test("a first write that failed, completed by the redelivery, is still announced", async (t) => {
  const w = await world();
  t.after(() => w.close());
  let failOnce = true;
  const e = engineIn(t, w, "flaky", {
    storageRetryMs: 500,
    storeOptions: {
      fault: (p, f) => {
        if (failOnce && p === "dir-fsync" && f.endsWith(`${path.sep}inbox`)) {
          failOnce = false;
          throw Object.assign(new Error("simulated"), { code: "EIO" });
        }
      },
    },
  });
  const notices = [];
  e.attach({ notify: (m) => notices.push(m.from) });
  await e.start();
  assert.ok(await until(() => e.session.state === "bound"));
  await w.cli(["send", "flaky", "eventually"], { HOPTELL_NAME: "alice" });
  assert.ok(await until(() => notices.length >= 1, 15_000), "the reconciled message is announced");
  const out = (await e.call("read_inbox")).content[0].text;
  assert.equal(count(out), 1);
  assert.match(out, /eventually/);
});

test("CLI: listen claims with the configured lease and never acknowledges what it could not read", { skip: process.getuid?.() === 0 && "root reads everything" }, async (t) => {
  const w = await world();
  t.after(() => w.close());
  const bob = await w.mcp("bob", ON);
  const { tools } = await bob.client.listTools();
  const dir = tools.find((x) => x.name === "read_inbox").description.match(/listen --session "([^"]+)"/)[1];
  await w.cli(["send", "bob", "lease"], { HOPTELL_NAME: "alice" });
  await sleep(300);
  await w.cli(["listen", "--no-ack", "--session", dir, "5"], { HOPTELL_LEASE_MINUTES: "1" });
  const [rec] = fs.readdirSync(path.join(dir, "claimed")).filter((f) => f.endsWith(".json"));
  const r = JSON.parse(fs.readFileSync(path.join(dir, "claimed", rec), "utf8"));
  assert.equal(r.lease_until - r.created, 60_000);
  await w.cli(["ack", r.receipt, "--session", dir]);
  await w.cli(["send", "bob", "locked"], { HOPTELL_NAME: "alice" });
  await sleep(300);
  const [f] = fs.readdirSync(path.join(dir, "inbox")).filter((x) => x.endsWith(".json"));
  fs.chmodSync(path.join(dir, "inbox", f), 0o000);
  t.after(() => fs.existsSync(path.join(dir, "inbox", f)) && fs.chmodSync(path.join(dir, "inbox", f), 0o600));
  const failed = await w.cli(["listen", "--session", dir, "2"]);
  assert.notEqual(failed.code, 0);
  assert.match(failed.stderr, /could not be read/);
  assert.ok(fs.existsSync(path.join(dir, "inbox", f)), "still pending, not acknowledged");
});

test("a delivery arriving while the engine stops is not stored by it and reaches the next session", async (t) => {
  const w = await world();
  t.after(() => w.close());
  const home = existingInstall(fs.mkdtempSync(path.join(os.tmpdir(), "hoptell-fence-")));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const e = engineIn(t, w, "fence", {}, { HOPTELL_HOME: home });
  await e.start();
  assert.ok(await until(() => e.session.state === "bound"));
  const dir = e.session.store.dir;
  const stopping = e.stop(); // from here, deliveries are not admitted
  await w.cli(["send", "fence", "late"], { HOPTELL_NAME: "alice" });
  await stopping;
  assert.deepEqual(fs.readdirSync(path.join(dir, "inbox")).filter((x) => x.endsWith(".json")), [], "nothing stored after stop began");
  const next = engineIn(t, w, "fence", {}, { HOPTELL_HOME: home });
  await next.start();
  assert.ok(await until(async () => /late/.test((await next.call("read_inbox")).content[0].text)), "the relay kept it for the next session");
});
