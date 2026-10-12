// Retention in hosted mode (design 4.5): an unlink stops the tenant's engine at once and deletes
// its home at the next sweep; inbox messages go at the latest 7 days after arrival; nothing is
// deleted while the link table cannot be read; deletions run below the free-space floors.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRetention } from "../lib/hostedretention.js";
import { linkTable, unlink } from "../lib/hostedlinks.js";
import { HANNA, HUGO } from "./hosted-helpers.js";
import { hostedWorld } from "./hosted-world.js";
import { sleep } from "./helpers.js";

const call = async (client, name, args = {}) => (await client.callTool({ name, arguments: args })).content[0].text;
const until = async (fn, ms = 4000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(25)) if (await fn()) return true;
  return Boolean(await fn());
};

async function world(t, o = {}) {
  const w = await hostedWorld(t, o);
  const clock = { t: Date.now() };
  // `disk.fail`: the next deletions fail with ENOSPC (injected), as a full or failing volume may.
  const disk = { fail: false };
  const rm = (p, opts) => {
    if (disk.fail) throw Object.assign(new Error("ENOSPC: injected"), { code: "ENOSPC" });
    return fs.rmSync(p, opts);
  };
  const retention = createRetention({ config: w.config, stateDir: w.state, links: linkTable(w.state), tenants: w.tenants, server: w.h, now: () => clock.t, rm, storeFault: () => disk.fail && rm("/nonexistent"), log: (...a) => w.logs.push(a.join(" ")) });
  w.disk = disk;
  t.after(() => retention.stop());
  return Object.assign(w, { retention, clock });
}

test("unlink: the engine stops and the sessions end at the next check; the home is deleted; other tenants are untouched", async (t) => {
  const w = await world(t);
  const hanna = await w.connect("hanna-sub");
  await w.connect("hugo-sub");
  assert.ok(fs.existsSync(w.homeOf(HANNA)));
  await unlink(w.state, { issuer: w.provider.issuer, subject: "hanna-sub" });
  const r = await w.retention.sweep();
  assert.equal(r.stopped, 1);
  assert.equal(r.deleted, 1);
  assert.equal(fs.existsSync(w.homeOf(HANNA)), false);
  assert.ok(fs.existsSync(w.homeOf(HUGO)));
  assert.equal(w.h.sessions().filter((s) => s.tenant === path.basename(w.homeOf(HANNA))).length, 0, "its sessions ended");
  await assert.rejects(call(hanna.client, "read_inbox"));
  assert.ok(w.logs.some((l) => l.includes("hosted.tenant-deleted")), "logged");
});

test("an unreadable link table deletes nothing", async (t) => {
  const w = await world(t);
  await w.connect("hanna-sub");
  fs.writeFileSync(path.join(w.state, "links.json"), "{", { mode: 0o600 });
  const r = await w.retention.sweep();
  assert.deepEqual(r, { stopped: 0, deleted: 0, expired: 0 });
  assert.ok(fs.existsSync(w.homeOf(HANNA)));
});

test("inbox messages go at the latest 7 days after arrival, unread or not; newer ones stay", async (t) => {
  const w = await world(t);
  const { client } = await w.connect("hanna-sub");
  w.allowBob(HANNA);
  const bob = await w.bob();
  await bob.send("hanna", "old message");
  await until(async () => (await w.tenants.runtime(path.basename(w.homeOf(HANNA))).engine.link.pending()).length > 0);
  w.clock.t += 7 * 86_400_000 + 60_000;
  const r = await w.retention.sweep();
  assert.equal(r.expired, 1);
  assert.doesNotMatch(await call(client, "read_inbox"), /old message/);
  w.clock.t = Date.now(); // back to the present: the next message is new
  await bob.send("hanna", "new message");
  let text = "";
  await until(async () => /new message/.test((text = await call(client, "read_inbox"))));
  assert.equal((await w.retention.sweep()).expired, 0);
  assert.match(text, /new message/);
});

test("ENOSPC in a tenant deletion: reported, nothing claimed as deleted, done at the next sweep; the engine stopped at once anyway", async (t) => {
  const w = await world(t);
  await w.connect("hanna-sub");
  await unlink(w.state, { issuer: w.provider.issuer, subject: "hanna-sub" });
  w.disk.fail = true;
  const r = await w.retention.sweep();
  assert.equal(r.stopped, 1, "the engine stops whatever the disk says");
  assert.equal(r.deleted, 0);
  assert.ok(fs.existsSync(w.homeOf(HANNA)));
  assert.ok(w.logs.some((l) => /a tenant home could not be deleted \(ENOSPC\)/.test(l)));
  w.disk.fail = false;
  assert.equal((await w.retention.sweep()).deleted, 1);
  assert.equal(fs.existsSync(w.homeOf(HANNA)), false);
});

test("ENOSPC in the expiry sweep: reported, retried at the next sweep, nothing lost on the way", async (t) => {
  const w = await world(t);
  const { client } = await w.connect("hanna-sub");
  w.allowBob(HANNA);
  await (await w.bob()).send("hanna", "expires later");
  await until(async () => (await w.tenants.runtime(path.basename(w.homeOf(HANNA))).engine.link.pending()).length > 0);
  w.clock.t += 8 * 86_400_000;
  w.disk.fail = true;
  assert.equal((await w.retention.sweep()).expired, 0);
  assert.ok(w.logs.some((l) => /an expiry sweep failed \(ENOSPC\)/.test(l)));
  assert.equal((await w.tenants.runtime(path.basename(w.homeOf(HANNA))).engine.link.pending()).length, 1, "nothing lost or half-deleted");
  w.disk.fail = false;
  assert.equal((await w.retention.sweep()).expired, 1, "deleted at the next sweep");
  assert.doesNotMatch(await call(client, "read_inbox"), /expires later/);
});

test("an unacknowledged claimed batch past 7 days is reconciled as a unit under the store's journal and its expired message deleted", async (t) => {
  const w = await world(t);
  const { client } = await w.connect("hanna-sub");
  w.allowBob(HANNA);
  await (await w.bob()).send("hanna", "claimed and forgotten");
  let text = "";
  await until(async () => /claimed and forgotten/.test((text = await call(client, "read_inbox"))));
  assert.match(text, /Receipt: r_/, "held under a receipt, never acknowledged; the session stays open");
  w.clock.t += 8 * 86_400_000;
  const r = await w.retention.sweep();
  assert.equal(r.expired, 1, "the claimed copy is expired too");
  assert.doesNotMatch(await call(client, "read_inbox"), /claimed and forgotten/);
  const store = fs.readdirSync(path.join(w.homeOf(HANNA), "v2"), { recursive: true }).filter((f) => /claimed[/\\]r_[a-z2-7]{26}\.json$/.test(f));
  assert.deepEqual(store, [], "no claimed record is left behind");
});
