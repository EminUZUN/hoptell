// A hosted member removed at the relay (design 4.5, "Data retention": "after unlink or member
// removal"): the relay's explicit answer to the host's hello (the member is not held by this
// host), confirmed twice, marks the tenant removed durably; then the same cleanup as an unlink
// runs: the engine stops, owner sessions end, new requests are refused, the home is deleted. A
// transient refusal (the fence, an unreachable relay) never marks it.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRetention } from "../lib/hostedretention.js";
import { linkTable, markRemoved } from "../lib/hostedlinks.js";
import { HANNA } from "./hosted-helpers.js";
import { HOSTS, MEMBERS, hostedWorld } from "./hosted-world.js";
import { sleep } from "./helpers.js";

const until = async (fn, ms = 6000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(25)) if (await fn()) return true;
  return Boolean(await fn());
};
const withoutHanna = MEMBERS.filter((m) => m.id !== HANNA.id);
const FENCED = { groups: { claimed: { members: [], oidcGroups: [{ issuer: "https://idp.example", group: "x" }] } }, rules: [], defaultAction: "allow", requireGrants: false };

async function world(t, tenantOptions = {}) {
  const w = await hostedWorld(t, { owner: true, policy: { groups: {}, rules: [], defaultAction: "allow", requireGrants: false }, tenantOptions: { confirmMs: 150, ...tenantOptions } });
  const retention = createRetention({ config: w.config, stateDir: w.state, links: linkTable(w.state), tenants: w.tenants, server: w.h, retention: { stopWaitMs: 300 }, log: (...a) => w.logs.push(a.join(" ")) });
  t.after(() => retention.stop());
  return Object.assign(w, { retention });
}

test("member removed at the relay: confirmed twice, marked durably; engine stopped, owner session ended, requests refused, home deleted", async (t) => {
  const w = await world(t);
  await w.connect("hanna-sub");
  const owner = await w.ownerLogin("hanna-sub");
  assert.equal((await w.page("GET", "/owner/pending", { cookie: owner.cookie })).status, 200);
  w.relay.reload(withoutHanna, HOSTS);
  assert.ok(await until(() => linkTable(w.state).removed(HANNA.id)), "marked removed after the relay's answers");
  assert.ok(fs.existsSync(`${w.state}/removed.json`), "durably");
  assert.equal((await w.page("GET", "/owner/pending", { cookie: owner.cookie })).status, 403, "the owner session ended");
  await assert.rejects(w.connect("hanna-sub"), /removed at the relay/);
  const r = await w.retention.sweep();
  assert.equal(r.deleted, 1);
  assert.equal(fs.existsSync(w.homeOf(HANNA)), false);
  assert.equal(w.tenants.runtime(w.homeOf(HANNA).split("/").pop()), null, "the engine is stopped");
});

test("transient refusals never mark a tenant removed: the fence; one refusal followed by a success", async (t) => {
  const w = await world(t);
  await w.connect("hanna-sub");
  w.access.setPolicy(FENCED);
  await sleep(1000);
  assert.equal(linkTable(w.state).removed(HANNA.id), false, "the fence is not a removal");
  w.access.setPolicy({ groups: {}, rules: [], defaultAction: "allow", requireGrants: false });
  // One answer "not held", then the member is back before the confirmation.
  w.relay.reload(withoutHanna, HOSTS);
  assert.ok(await until(() => w.tenants.runtimes().some((r) => r.member === HANNA.id && r.notHeld === 1), 3000), "one explicit answer seen");
  w.relay.reload(MEMBERS, HOSTS);
  await sleep(800);
  assert.equal(linkTable(w.state).removed(HANNA.id), false);
});

test("a removal mark that fails to write (ENOSPC) is retried on its own: no client request, receiving stopped meanwhile, then the cleanup", async (t) => {
  let failures = 1;
  const mark = async (...a) => {
    if (failures-- > 0) throw Object.assign(new Error("ENOSPC: injected"), { code: "ENOSPC" });
    return markRemoved(...a);
  };
  const w = await world(t, { mark });
  await w.connect("hanna-sub");
  const key = w.homeOf(HANNA).split("/").pop();
  w.relay.reload(withoutHanna, HOSTS);
  assert.ok(await until(() => w.logs.some((l) => /the removal could not be recorded/.test(l))), "the first write failed");
  assert.equal(w.tenants.runtime(key)?.engine ?? null, null, "no engine receives while the mark is pending");
  // No client request from here on: the retry alone writes the mark, then the cleanup runs.
  assert.ok(await until(() => linkTable(w.state).removed(HANNA.id)), "the mark is written by the retry");
  assert.ok(await until(() => w.tenants.runtime(key) === null), "the tenant is stopped");
  assert.equal((await w.retention.sweep()).deleted, 1);
  assert.equal(fs.existsSync(w.homeOf(HANNA)), false);
});

/** Engines whose stop() waits for `gate.open()` (a slow drain of store work). */
function slowStops() {
  let release;
  const gate = { opened: false, wait: new Promise((r) => (release = r)), open: () => ((gate.opened = true), release()) };
  const engineFactory = async (...a) => {
    const { createEngine } = await import("../lib/engine.js");
    const e = createEngine(...a);
    const stop = e.stop.bind(e);
    e.stop = () => gate.wait.then(stop);
    return e;
  };
  return { gate, engineFactory };
}

test("removal: the home is not deleted until the engine's stop has finished", async (t) => {
  const { gate, engineFactory } = slowStops();
  const w = await world(t, { engineFactory });
  t.after(() => gate.open());
  await w.connect("hanna-sub");
  const key = w.homeOf(HANNA).split("/").pop();
  w.relay.reload(withoutHanna, HOSTS);
  assert.ok(await until(() => linkTable(w.state).removed(HANNA.id)), "marked");
  await sleep(200);
  assert.ok(w.tenants.runtime(key), "the runtime stays while its engine is stopping");
  assert.equal((await w.retention.sweep()).deleted, 0);
  assert.ok(fs.existsSync(w.homeOf(HANNA)), "not deleted while the stop drains");
  gate.open();
  assert.ok(await until(() => w.tenants.runtime(key) === null), "removed once stopped");
  assert.equal((await w.retention.sweep()).deleted, 1);
});

test("unlink: the home is deleted only after the engine's stop has finished (a later sweep when it is slow)", async (t) => {
  const { gate, engineFactory } = slowStops();
  const w = await world(t, { engineFactory });
  t.after(() => gate.open());
  await w.connect("hanna-sub");
  const key = w.homeOf(HANNA).split("/").pop();
  const { unlink } = await import("../lib/hostedlinks.js");
  await unlink(w.state, { issuer: w.provider.issuer, subject: "hanna-sub" });
  const first = await w.retention.sweep();
  assert.equal(first.stopped, 1);
  assert.equal(first.deleted, 0, "not while the stop drains");
  assert.ok(fs.existsSync(w.homeOf(HANNA)));
  gate.open();
  assert.ok(await until(() => w.tenants.runtime(key) === null));
  assert.equal((await w.retention.sweep()).deleted, 1);
  assert.equal(fs.existsSync(w.homeOf(HANNA)), false);
});
