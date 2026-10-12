// 3.3's group operations at the library boundary (lib/mls/driver.js), the same checks for the
// fake driver and the OpenMLS driver (when the spike's binding is built; skipped otherwise):
// create, add with a Welcome, the pending-commit lifecycle across export and import, process and
// merge, rollback of every failed process (MI5: a tampered application message first, the valid
// one next; an invalid signature; malformed content), a device's own commit, removal, the epoch
// authenticator as fork evidence.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../lib/config.js";
import { checkGroups, DriverError } from "../lib/mls/driver.js";
import { createOpenMlsDriver } from "../lib/mls/openmls.js";
import { credentialIdentity, newDeviceId } from "../lib/mls/identity.js";
import { createFakeDriver } from "./fake-mls-driver.js";

const WASM = process.env.HOPTELL_MLS_WASM || path.join(ROOT, "..", "mls-bakeoff", "spike", "mls-bakeoff", "openmls-wasm", "pkg", "openmls_wasm.js");
const built = fs.existsSync(WASM);
const DRIVERS = [
  ["fake", () => createFakeDriver({ seed: crypto.randomBytes(8).toString("hex") }), false],
  ["OpenMLS", () => createOpenMlsDriver(WASM), built ? false : `the OpenMLS WASM binding is not built (${WASM})`],
];
const realm = "0".repeat(32);
const idOf = (member) => credentialIdentity({ realm, member, device: newDeviceId() });
const A = `m_${"a".repeat(26)}`;
const B = `m_${"b".repeat(26)}`;

/** alice's device creates a group and adds bob's device (merged, joined). */
async function pair(d) {
  const alice = await d.createDevice(idOf(A));
  const bob = await d.createDevice(idOf(B));
  const gid = crypto.randomBytes(16);
  const ga = await alice.createGroup(gid);
  checkGroups(alice, ga);
  const out = await ga.commit({ add: [await bob.keyPackage({ lifetimeSeconds: 86400 })] });
  await ga.mergePending();
  const joined = await (await bob.stageWelcome(out.welcome, out.ratchetTree)).finish();
  assert.deepEqual(Buffer.from(joined), gid);
  return { alice, bob, gid, ga, gb: bob.group(gid) };
}
const reload = async (d, dev, gid) => {
  const again = await d.importDevice(await dev.exportState());
  return { dev: again, g: again.group(gid) };
};

for (const [name, make, skip] of DRIVERS) {
  test(`${name}: a group of two: Welcome, application messages both ways, equal epoch authenticators`, { skip }, async () => {
    const d = make();
    const { alice, ga, gb } = await pair(d);
    assert.equal(ga.epoch(), 1);
    assert.equal(gb.epoch(), 1);
    assert.deepEqual(Buffer.from(ga.epochAuthenticator()), Buffer.from(gb.epochAuthenticator()));
    assert.deepEqual(gb.members().map((m) => Buffer.from(m.identity).toString()).sort(), ga.members().map((m) => Buffer.from(m.identity).toString()).sort());
    const m = await ga.encrypt(Buffer.from("hello"), Buffer.from("aad"));
    const p = await gb.process(m);
    assert.equal(p.kind, "application");
    assert.equal(Buffer.from(p.plaintext).toString(), "hello");
    assert.deepEqual(Buffer.from(p.sender.identity), Buffer.from(alice.identity));
    await assert.rejects(gb.process(m), (e) => e instanceof DriverError, "a replayed message does not decrypt twice");
    const back = await gb.encrypt(Buffer.from("hi"), new Uint8Array());
    assert.equal(Buffer.from((await ga.process(back)).plaintext).toString(), "hi");
  });

  test(`${name}: MI5: a failed process restores the state (tampered then valid, invalid signature, malformed)`, { skip }, async () => {
    const d = make();
    const { ga, gb } = await pair(d);
    const m = await ga.encrypt(Buffer.from("the valid one"), new Uint8Array());
    const tampered = Buffer.from(m);
    tampered[tampered.length - 2] ^= 1;
    const before = Buffer.from(gb.epochAuthenticator());
    await assert.rejects(gb.process(tampered), (e) => e instanceof DriverError);
    assert.equal(Buffer.from((await gb.process(m)).plaintext).toString(), "the valid one", "the tampered copy did not consume the valid one's generation");
    assert.deepEqual(Buffer.from(gb.epochAuthenticator()), before);
    // A commit whose signature or content was changed: refused, the group unchanged.
    const c = await ga.commit({ update: true });
    const bad = Buffer.from(c.commit);
    bad[bad.length - 1] ^= 1;
    await assert.rejects(gb.process(bad), (e) => e instanceof DriverError);
    await assert.rejects(gb.process(Buffer.from("not an MLS message at all")), (e) => e instanceof DriverError);
    assert.equal(gb.epoch(), 1);
    const ok = await gb.process(c.commit);
    assert.equal(ok.kind, "commit");
    await ok.merge();
    await ga.mergePending();
    assert.equal(gb.epoch(), 2);
    assert.deepEqual(Buffer.from(ga.epochAuthenticator()), Buffer.from(gb.epochAuthenticator()));
  });

  test(`${name}: the pending commit survives export and import; clearPending drops it; a discarded staged commit leaves no trace`, { skip }, async () => {
    const d = make();
    const { alice, bob, gid, ga, gb } = await pair(d);
    const c = await ga.commit({ update: true });
    const { g: ga2 } = await reload(d, alice, gid);
    assert.equal(ga2.epoch(), 1);
    await ga2.mergePending();
    assert.equal(ga2.epoch(), 2, "the pending commit was in the exported state");
    // bob stages it, discards it (a delta that disagrees), then processes it again after a restart.
    const staged = await gb.process(c.commit);
    await staged.discard();
    assert.equal(gb.epoch(), 1);
    const { g: gb2 } = await reload(d, bob, gid);
    const again = await gb2.process(c.commit);
    await again.merge();
    assert.deepEqual(Buffer.from(gb2.epochAuthenticator()), Buffer.from(ga2.epochAuthenticator()));
    // Another commit, cleared (a competitor won): the group stays at its epoch.
    await ga2.commit({ update: true });
    await ga2.clearPending();
    assert.equal(ga2.epoch(), 2);
  });

  test(`${name}: a device cannot process its own commit; removal deactivates the removed device`, { skip }, async () => {
    const d = make();
    const { ga, gb } = await pair(d);
    const c = await ga.commit({ update: true });
    await assert.rejects(ga.process(c.commit), (e) => e instanceof DriverError, "OwnPrivateMessage");
    await ga.mergePending();
    await (await gb.process(c.commit)).merge();
    const bobIndex = ga.members().find((m) => Buffer.from(m.identity).toString().includes(B)).index;
    const rm = await ga.commit({ remove: [bobIndex] });
    const p = await gb.process(rm.commit);
    assert.deepEqual(p.removed.map((r) => Buffer.from(r.identity).toString().split("|")[2]), [B], "removed members resolve to credentials before the merge");
    await p.merge();
    await ga.mergePending();
    assert.equal(gb.isActive(), false);
    assert.equal(ga.members().length, 1);
  });

  test(`${name}: forks: two histories at the same epoch have different epoch authenticators`, { skip }, async () => {
    const d = make();
    const { alice, gid, ga, gb } = await pair(d);
    const { g: ga2 } = await reload(d, alice, gid); // a copy of alice's state
    const c1 = await ga.commit({ update: true });
    await ga.mergePending();
    const c2 = await ga2.commit({ update: true });
    await ga2.mergePending();
    assert.equal(ga.epoch(), ga2.epoch());
    assert.notDeepEqual(Buffer.from(ga.epochAuthenticator()), Buffer.from(ga2.epochAuthenticator()));
    await (await gb.process(c1.commit)).merge();
    assert.deepEqual(Buffer.from(gb.epochAuthenticator()), Buffer.from(ga.epochAuthenticator()));
    await assert.rejects(gb.process(c2.commit), (e) => e instanceof DriverError, "a commit for an epoch already left");
  });
}
