// Amendments 3.5 part 2, A10: the private keys of expired, unused KeyPackages are deleted (a day
// after expiry) inside one device transaction, at engine start, at attach, with every
// replenishment and every 6 hours; the ledger maps the library's refs through libRef, a pruned
// package is never uploaded again, and a Welcome needs an open package with a future expiry. The
// real-binding tests need the binding's Device.prune_key_packages (manifest 6) and skip, named,
// while the built binding lacks it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { ROOT } from "../lib/config.js";
import { deviceCommand, e2eeDoctor } from "../lib/mls/cli.js";
import { PRUNE_GRACE_S, deviceStore } from "../lib/mls/device.js";
import { credentialIdentity, newDeviceId } from "../lib/mls/identity.js";
import { bindingPrunes, createOpenMlsDriver, heldKeyPackageRefs, openMlsDriverOver } from "../lib/mls/openmls.js";
import { KP_LIFETIME_MS, PRUNE_EVERY_MS } from "../lib/mls/policy.js";
import { createFakeDriver } from "./fake-mls-driver.js";
import { deviceRelay, e2eeDevice, memoryContacts, ownFor, tmpDir, until } from "./mls-helpers.js";

const PASS = "correct horse battery staple";
const PAST_GRACE = KP_LIFETIME_MS + PRUNE_GRACE_S * 1000 + 1000; // every package of now is prunable after this
const CRASH = new URL("./fixtures/device-crash.mjs", import.meta.url).pathname;

/** A home of `member` with a fake-driver device store, enrolled; make() opens it again (a restart). */
async function home(t, w, member, { driver = null } = {}) {
  const dir = tmpDir(t);
  const contacts = memoryContacts(undefined, { file: path.join(dir, "contacts-test.json") });
  driver ??= createFakeDriver({ seed: `${member}-${dir}`, now: w.clock.now });
  const make = () => deviceStore({ home: dir, profile: "relay-test", driver, store: "file", passphrase: PASS, keychainBackend: null, machine: "m", now: w.clock.now, own: ownFor(contacts, dir, "relay-test") });
  const store = make();
  await store.enroll(await w.client(member));
  return { dir, driver, store, make };
}
const file = (h) => path.join(h.dir, "mls", "relay-test", "device.json");
const raw = (h) => JSON.parse(fs.readFileSync(file(h), "utf8"));
const open = (rec) => Object.entries(rec.kps).filter(([, e]) => e.state === "open");
/** How many KeyPackage bundles the library state of `store` still holds (a dry prune far ahead). */
const held = (h, store = h.store) => store.transact(async (ctx) => (await h.driver.pruneKeyPackages(ctx.dev, { nowSeconds: 4_000_000_000, graceSeconds: 0 })).length, { act: false });

test("A10: prune runs at engine start, at attach, with every replenishment and on the 6-hour timer, with a day's grace", async (t) => {
  assert.equal(PRUNE_EVERY_MS, 6 * 3_600_000);
  assert.equal(PRUNE_GRACE_S, 86_400);
  const w = await deviceRelay(t, { e2ee: true });
  const d = await e2eeDevice(t, w, "alice", { sessions: [] });
  const calls = d.driver.pruneCalls;
  assert.equal(calls.length, 1, "enroll replenished, and pruned first");
  const s = d.engine(await w.client("alice", { session: "alice-s1" }), "alice-s1", { pruneEveryMs: 60_000 });
  await s.e2ee.attach();
  assert.equal(calls.length, 3, "start and attach");
  await s.e2ee.attach();
  assert.equal(calls.length, 4, "a later attach prunes again (start only once)");
  w.clock.advance(61_000);
  await d.store.replenish(await w.client("alice"));
  assert.equal(calls.length, 5, "a replenishment prunes first (in its own save)");
  assert.ok(calls.every((c) => c.graceSeconds === 86_400));
  assert.equal(calls.at(-1).nowSeconds, Math.floor(w.clock.now() / 1000));
  // The timer, short here: it keeps pruning while the engine runs, and stops at close.
  const fast = d.engine(await w.client("alice", { session: "alice-s2" }), "alice-s2", { pruneEveryMs: 40 });
  await fast.e2ee.attach();
  const n = calls.length;
  await until(() => calls.length >= n + 3, "timer prunes");
  fast.e2ee.close();
  s.e2ee.close();
  const m = calls.length;
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(calls.length, m, "no prune after close");
});

/** A client of `member` whose kp_upload frames are recorded; `lose` makes their answer never arrive. */
async function uploads(w, member, { lose = false } = {}) {
  const c = await w.client(member);
  const sent = [];
  const rpc = c.rpc.bind(c);
  c.rpc = (f) => {
    if (f.type !== "kp_upload") return rpc(f);
    sent.push(...f.packages.map((p) => p.kp));
    return lose ? Promise.reject(Object.assign(new Error("the answer was lost"), { code: "timeout" })) : rpc(f);
  };
  return { c, sent };
}

test("A10: the ledger marks a pruned package and drops it from unpublished: a lost answer or a restart never uploads it again; inside the grace nothing is pruned", async (t) => {
  const w = await deviceRelay(t, { e2ee: true });
  const h = await home(t, w, "alice");
  // An upload whose answer was lost: 5 packages made, durable, unpublished.
  w.clock.advance(61_000);
  const lost = await uploads(w, "alice", { lose: true });
  await assert.rejects(h.store.replenish(lost.c, { force: 5 }));
  const stale = raw(h).unpublished.map((p) => p.kp);
  assert.equal(stale.length, 5);
  assert.equal(await held(h), 25);
  // Inside the grace (expired, but less than a day ago): nothing is pruned.
  w.clock.advance(KP_LIFETIME_MS + 12 * 3_600_000);
  assert.deepEqual(await h.make().prune(), { pruned: 0, orphans: 0, changed: false });
  assert.equal(open(raw(h)).length, 25);
  assert.equal(raw(h).unpublished.length, 5);
  // Past expiry plus grace, after a restart (the engine's start): all 25 pruned, in the ledger and
  // in the library state, and the unpublished ones are gone.
  w.clock.advance(PAST_GRACE - KP_LIFETIME_MS - 12 * 3_600_000);
  const after = h.make();
  assert.deepEqual(await after.prune(), { pruned: 25, orphans: 0, changed: true });
  const rec = raw(h);
  assert.equal(Object.values(rec.kps).filter((e) => e.state === "pruned" && e.prunedAt === w.clock.now()).length, 25);
  assert.deepEqual(rec.unpublished, []);
  assert.equal(await held(h, after), 0);
  // The next replenishment publishes fresh packages only: never a pruned one.
  const next = await uploads(w, "alice");
  const r = await after.replenish(next.c);
  assert.equal(r.published, 20);
  assert.equal(next.sent.filter((kp) => stale.includes(kp)).length, 0);
  assert.equal(open(raw(h)).length, 20);
});

test("A10: a replenishment after a lost answer prunes first, in the same save: the pruned unpublished packages are not offered again", async (t) => {
  const w = await deviceRelay(t, { e2ee: true });
  const h = await home(t, w, "alice");
  w.clock.advance(61_000);
  const lost = await uploads(w, "alice", { lose: true });
  await assert.rejects(h.store.replenish(lost.c, { force: 5 }));
  const stale = raw(h).unpublished.map((p) => p.kp);
  w.clock.advance(PAST_GRACE);
  const next = await uploads(w, "alice");
  await h.make().replenish(next.c);
  assert.equal(next.sent.filter((kp) => stale.includes(kp)).length, 0, "none of the lost upload's packages");
  assert.equal(Object.values(raw(h).kps).filter((e) => e.state === "pruned").length, 25);
});

test("A10: a Welcome for a pruned package, an orphan ref, an entry without expiry or in another state is refused and consumes nothing", async (t) => {
  const w = await deviceRelay(t, { e2ee: true });
  const h = await home(t, w, "alice");
  const [ref] = open(raw(h))[0];
  // An orphan: a package the library holds without a ledger entry.
  const orphan = await h.store.transact(async (ctx) => {
    const kp = await ctx.dev.keyPackage({ lifetimeSeconds: 60 });
    await ctx.save();
    return Buffer.from(h.driver.inspectKeyPackage(kp).ref).toString("hex");
  });
  w.clock.advance(PAST_GRACE);
  assert.deepEqual(await h.store.prune(), { pruned: 20, orphans: 1, changed: true });
  const rec = raw(h);
  assert.equal(rec.kps[ref].state, "pruned");
  assert.deepEqual(rec.prunedOrphans.map((o) => o.ref), [orphan]);
  assert.equal(Object.hasOwn(rec.kps, orphan), false, "an orphan never enters the ledger");
  const before = fs.readFileSync(file(h));
  const welcome = Buffer.from("not consumed");
  await assert.rejects(h.store.acceptWelcome(ref, welcome), (e) => e.code === "pruned_key_package");
  await assert.rejects(h.store.acceptWelcome(orphan, welcome), (e) => e.code === "unknown_key_package");
  assert.deepEqual(fs.readFileSync(file(h)), before, "nothing consumed, nothing written");
  // A ledger entry without a valid expiry, or in a state other than open, is refused too.
  w.clock.advance(61_000);
  await h.store.replenish(await w.client("alice"));
  const [a, b, c] = open(raw(h)).map(([r]) => r);
  const edited = raw(h);
  delete edited.kps[a].notAfter;
  edited.kps[b].notAfter = "soon";
  edited.kps[c].state = "reserved";
  fs.writeFileSync(file(h), JSON.stringify(edited));
  const s = h.make();
  await assert.rejects(s.acceptWelcome(a, welcome), (e) => e.code === "expired_key_package", "no expiry");
  await assert.rejects(s.acceptWelcome(b, welcome), (e) => e.code === "expired_key_package", "not a number");
  await assert.rejects(s.acceptWelcome(c, welcome), (e) => e.code === "unknown_key_package", "another state");
});

test("A10: pruned refs without a ledger entry go to a bounded audit list, never to the ledger", async (t) => {
  const w = await deviceRelay(t, { e2ee: true });
  const h = await home(t, w, "alice");
  const kps = Object.keys(raw(h).kps).length;
  await h.store.transact(async (ctx) => {
    for (let i = 0; i < 105; i++) await ctx.dev.keyPackage({ lifetimeSeconds: 60 });
    await ctx.save();
  });
  w.clock.advance(60_000 + PRUNE_GRACE_S * 1000 + 1000);
  assert.deepEqual(await h.store.prune(), { pruned: 0, orphans: 105, changed: true });
  const rec = raw(h);
  assert.equal(rec.prunedOrphans.length, 100);
  assert.equal(Object.keys(rec.kps).length, kps);
  assert.equal(open(rec).length, 20, "the published packages are not expired yet");
});

/** Run the crash fixture's prune at `point`; resolves once it died by SIGKILL. */
function crash(w, h, point) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [CRASH, "-", h.dir, point, "prune"], { timeout: 30_000, env: { ...process.env, HOPTELL_TEST_NOW: String(w.clock.now()) } }, (err, stdout, stderr) => (err?.signal === "SIGKILL" ? resolve() : reject(new Error(`the fixture did not die: ${stdout}${stderr}${err?.message ?? ""}`))));
  });
}

test("A10 crash windows (SIGKILL): before the transaction's save neither the library state nor the ledger changed (the next run prunes); after it, both", async (t) => {
  const w = await deviceRelay(t, { e2ee: true });
  const h = await home(t, w, "alice");
  w.clock.advance(PAST_GRACE);
  const before = fs.readFileSync(file(h));
  await crash(w, h, "prune-before-save");
  assert.deepEqual(fs.readFileSync(file(h)), before, "the device file (library state and ledger) is as it was");
  assert.equal(open(raw(h)).length, 20);
  assert.equal(await held(h, h.make()), 20, "the library state still holds the 20 bundles");
  assert.deepEqual(await h.make().prune(), { pruned: 20, orphans: 0, changed: true }, "the next run prunes");

  const h2 = await home(t, w, "bob");
  w.clock.advance(PAST_GRACE);
  await crash(w, h2, "prune-after-save");
  assert.equal(Object.values(raw(h2).kps).filter((e) => e.state === "pruned").length, 20, "the ledger changed");
  assert.equal(await held(h2, h2.make()), 0, "and the library state with it");
  assert.deepEqual(await h2.make().prune(), { pruned: 0, orphans: 0, changed: false });
});

test("A10: doctor says whether pruning is available (a binding without prune_key_packages: unavailable)", async (t) => {
  const w = await deviceRelay(t, { e2ee: true });
  for (const [driverFile, re, level] of [
    ["fake-mls-driver.js", /deleted a day after expiry \(0 pruned\)/, "info"],
    ["fixtures/fake-mls-driver-noprune.mjs", /KeyPackage pruning is unavailable with this MLS binding/, "warn"],
  ]) {
    const dir = tmpDir(t);
    const env = { HOPTELL_CREDENTIAL_STORE: "file", HOPTELL_CREDENTIAL_PASSPHRASE: PASS, HOPTELL_MLS_DRIVER: new URL(`./${driverFile}`, import.meta.url).pathname };
    await deviceCommand({ args: ["enroll"], home: dir, profile: "relay-test", env, connect: () => w.client("alice"), contacts: memoryContacts(), say: () => {} });
    const line = (await e2eeDoctor({ home: dir, profile: "relay-test", env })).find(([, l]) => /KeyPackage/.test(l));
    assert.ok(line, driverFile);
    assert.equal(line[0], level);
    assert.match(line[1], re);
  }
});

// The real binding (manifest 6): skipped, named, while the built binding has no prune_key_packages.
const WASM = process.env.HOPTELL_MLS_WASM || path.join(ROOT, "..", "mls-bakeoff", "spike", "mls-bakeoff", "openmls-wasm", "pkg", "openmls_wasm.js");
const realSkip = !fs.existsSync(WASM) ? `the OpenMLS WASM binding is not built (${WASM})` : bindingPrunes(createRequire(import.meta.url)(WASM)) ? false : `A10 waits on the binding build with Device.prune_key_packages (manifest 6); the binding at ${WASM} has no such export`;
const MAGIC = Buffer.from("hoptell-openmls-state-v2\n");
const bindingRefs = async (dev) => {
  const s = Buffer.from(await dev.exportState());
  return [...heldKeyPackageRefs(s.subarray(MAGIC.length + 4 + s.readUInt32BE(MAGIC.length)))];
};

test("A10 OpenMLS: a package past expiry plus grace is pruned and its Welcome refused; one inside the grace is kept and still processed; the exported state shrinks", { skip: realSkip }, async (t) => {
  const wasm = createRequire(import.meta.url)(WASM);
  const d = createOpenMlsDriver(WASM, { testOnlySuite: 77 });
  const T = { realm: "0".repeat(32), member: `m_${"a".repeat(26)}`, device: newDeviceId() };
  const dev = await d.createDevice(credentialIdentity(T));
  const short = await dev.keyPackage({ lifetimeSeconds: 60 });
  const long = await dev.keyPackage({ lifetimeSeconds: 14 * 86400 });
  const hex = (kp) => Buffer.from(d.inspectKeyPackage(kp).ref).toString("hex");
  const nowS = Math.floor(Date.now() / 1000);
  assert.equal((await bindingRefs(dev)).length, 2);
  // Inside the grace: nothing.
  assert.deepEqual(await d.pruneKeyPackages(dev, { nowSeconds: nowS + 3600, graceSeconds: 86_400 }), []);
  assert.equal((await bindingRefs(dev)).length, 2);
  // Past expiry plus grace for the short one only.
  const gone = await d.pruneKeyPackages(dev, { nowSeconds: nowS + 60 + 86_400 + 120, graceSeconds: 86_400 });
  assert.deepEqual(gone.map((r) => Buffer.from(r).toString("hex")), [hex(short)]);
  assert.deepEqual(await bindingRefs(dev), [hex(long)], "the exported state no longer holds its keys");
  const committer = new wasm.Device(77, Buffer.from("committer"));
  t.after(() => committer.free());
  const welcomeFor = (kp, gid) => {
    committer.create_group(Buffer.from(gid));
    const out = committer.commit(Buffer.from(gid), [new wasm.Bytes(kp)], new Uint32Array(), false);
    committer.merge_pending(Buffer.from(gid));
    return out;
  };
  const ws = welcomeFor(short, "g-short");
  await assert.rejects(dev.stageWelcome(ws.welcome, ws.ratchet_tree), "the pruned package's Welcome cannot be processed");
  const wl = welcomeFor(long, "g-long");
  await (await dev.stageWelcome(wl.welcome, wl.ratchet_tree)).finish();
});

test("A10 OpenMLS: the store maps the binding's refs through libRef: pruned in the ledger, a Welcome refused", { skip: realSkip }, async (t) => {
  const w = await deviceRelay(t, { e2ee: true });
  const h = await home(t, w, "alice", { driver: createOpenMlsDriver(WASM) });
  const refs = open(raw(h)).map(([r]) => r);
  // The binding stamps not_after from the wall clock at enrollment (later than the test clock's
  // start on a loaded machine): an hour's margin.
  w.clock.advance(PAST_GRACE + 3_600_000);
  assert.deepEqual(await h.store.prune(), { pruned: 20, orphans: 0, changed: true });
  assert.ok(refs.every((r) => raw(h).kps[r].state === "pruned"));
  assert.equal(await held(h, h.make()), 0);
  await assert.rejects(h.store.acceptWelcome(refs[0], Buffer.from("x")), (e) => e.code === "pruned_key_package");
});

test("A10: the OpenMLS adapter passes the prune seconds as BigInt (the binding's u64), never as Numbers; whole seconds only", async () => {
  const seen = [];
  const ref = Uint8Array.from([1, 2, 3]);
  // A stand-in binding: wasm-bindgen's u64 parameter throws a TypeError on a Number.
  const Device = class {
    prune_key_packages(now, grace) {
      seen.push([typeof now, typeof grace, now, grace]);
      if (typeof now !== "bigint" || typeof grace !== "bigint") throw new TypeError("Cannot convert a Number to a BigInt");
      return [{ bytes: ref }];
    }
  };
  const d = openMlsDriverOver({ supported_suites: () => [0x004d], Device });
  assert.equal(typeof d.pruneKeyPackages, "function");
  const dev = await d.createDevice(Buffer.from("id"));
  const refs = await d.pruneKeyPackages(dev, { nowSeconds: 1_800_000_000, graceSeconds: PRUNE_GRACE_S });
  assert.deepEqual(seen, [["bigint", "bigint", 1_800_000_000n, 86_400n]], "one call, BigInt arguments");
  assert.deepEqual(refs.map((r) => [...r]), [[1, 2, 3]]);
  await assert.rejects(d.pruneKeyPackages(dev, { nowSeconds: 1.5, graceSeconds: 0 }), /whole seconds/);
  // A binding without the export: no pruneKeyPackages.
  assert.equal(openMlsDriverOver({ supported_suites: () => [0x004d], Device: class {} }).pruneKeyPackages, undefined);
});

test("A10: the maintenance runs while the engine runs even when every attach fails: a package past expiry plus grace is still pruned on the timer", async (t) => {
  const w = await deviceRelay(t, { e2ee: true });
  const d = await e2eeDevice(t, w, "alice", { sessions: [] });
  const client = await w.client("alice", { session: "alice-s1" });
  // The relay keeps refusing the device's attach (here: every proof challenge is unavailable).
  const rpc = client.rpc.bind(client);
  client.rpc = (f) => (f.type === "proof_challenge" ? Promise.reject(Object.assign(new Error("the relay is unavailable"), { kind: "relay_error", code: "unavailable" })) : rpc(f));
  const s = d.engine(client, "alice-s1", { pruneEveryMs: 40 });
  await assert.rejects(s.e2ee.attach());
  await assert.rejects(s.e2ee.attach(), "a later ready() fails too");
  const file = path.join(d.dir, "mls", "relay-test", "device.json");
  const pruned = () => Object.values(JSON.parse(fs.readFileSync(file, "utf8")).kps).filter((e) => e.state === "pruned").length;
  assert.equal(pruned(), 0);
  // Time passes beyond expiry + grace + the timer's period while no attach succeeds.
  w.clock.advance(PAST_GRACE + PRUNE_EVERY_MS);
  await until(() => pruned() === 20, "the timer prunes without an attach");
  s.e2ee.close();
});
