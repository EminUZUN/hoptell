// The decision service (design 3.4, lib/decisions.js): tokens that cover every shown field, stale
// and refused decisions that write nothing, the native locks (no deadlock, no writer between the
// check and the mutation), and settings by compare-and-set.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as decisions from "../lib/decisions.js";
import { contactToken, contactView, viewDigest } from "../lib/decisions.js";
import { tryLock } from "../lib/locks.js";
import { deviceDecision } from "../lib/mls/cli.js";
import { processInfo } from "../lib/host.js";
import { openBound } from "../lib/session.js";
import { openStore, processConsumer } from "../lib/store.js";
import { openContacts } from "../lib/quarantine.js";
import { ensureWakeDir, filesFor, writeRecord } from "../lib/wake.js";
import { fakeDevice, seedOwn } from "./mls-helpers.js";

const R = "a".repeat(32);
const ALICE = "m_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const tmpHome = (t) => {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), "hoptell-dec-"));
  t.after(() => fs.rmSync(h, { recursive: true, force: true }));
  return h;
};
const fromAlice = (text, id = ALICE) => ({ type: "message", id: crypto.randomUUID(), from: "alice-x", fromHost: "h", text, ts: 1, sender: { auth: "member", member: { id, name: "alice" }, realm: R } });
const session = (name) => ({ realm: R, name });
const digestOf = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const snapshot = (home) => {
  // Every file of the contacts state, by content: "nothing was written" compares two of these.
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (!e.name.endsWith(".lock")) out[path.relative(home, p)] = digestOf(p);
    }
  };
  walk(home);
  return out;
};

/** A home with one pending request from alice (one message for session "s"). */
async function pending(t, opts = {}) {
  const home = tmpHome(t);
  const c = await openContacts(home, { notify: false, ...opts });
  const bound = await openBound(home, { realm: R, member: null, key: "s" });
  const store = await openStore(bound);
  await c.hold(bound.dir, session("s"), fromAlice("one"), "ask");
  const [item] = await decisions.list({ home, sources: { contacts: c } });
  return { home, c, bound, store, id: item.id };
}

/** Every leaf of an object, mutated one at a time. */
function* mutations(obj, at = []) {
  for (const [k, v] of Object.entries(obj)) {
    if (v && typeof v === "object") {
      yield* mutations(v, [...at, k]);
      continue;
    }
    const copy = structuredClone(obj);
    copy[k] = typeof v === "string" ? `${v}x` : typeof v === "number" ? v + 1 : typeof v === "boolean" ? !v : "x";
    yield { path: [...at, k].join("."), replace: copy, at };
  }
}
const withLeaf = (root, at, replaced) => {
  if (!at.length) return replaced;
  const copy = structuredClone(root);
  let o = copy;
  for (const k of at.slice(0, -1)) o = o[k];
  o[at.at(-1)] = replaced;
  return copy;
};

test("every kind's token changes when any shown field changes (rendered from fixtures)", async () => {
  const contact = contactView({ id: "q_aaaaaaaaaaaaaaaa", rev: 3, policyRevision: 2, dropped: 0, violation: false, sender: { label: "member alice", auth: "member", realm: R, member: ALICE, name: null, relay: null }, items: [{ session: `${R}/s`, arrived: "2026-10-09T10:00:00.000Z", bytes: 120 }] });
  const base = contactToken(contact);
  for (const m of mutations(contact)) assert.notEqual(contactToken(withLeaf(contact, m.at, m.replace)), base, `contact: ${m.path}`);

  // encryption-violation: the contact view plus the setting it links to.
  const violation = { ...contact, violation: true, setting: `encryption.${R}.${ALICE}`, request: "contact:q_aaaaaaaaaaaaaaaa", command: `hoptell contacts encryption ${ALICE} preferred|off` };
  const vt = `${violation.policyRevision}.${viewDigest(violation)}`;
  for (const m of mutations(violation)) assert.notEqual(`${violation.policyRevision}.${viewDigest(withLeaf(violation, m.at, m.replace))}`, vt, `encryption-violation: ${m.path}`);

  const me = `m_${"m".repeat(26)}`;
  const bob = `m_${"b".repeat(26)}`;
  const served = (d) => ({ device: d.device, key: d.key.toString("base64"), pin: d.register().pin, seq: 0, rotations: [] });
  const mine = await fakeDevice(R, me);
  const b1 = await fakeDevice(R, bob);
  const lists = { theirs: { realm: R, member: bob, devices: [served(b1), served(await fakeDevice(R, bob))] }, mine: { realm: R, member: me, devices: [served(mine)] } };
  for (const [sub, device] of [["verify", null], ["accept-device", b1.device]]) {
    const { view, code } = deviceDecision({ sub, member: bob, device, ...lists, doc: { version: 1, default: "ask", revision: 1 } });
    const token = `${code}.${viewDigest(view)}`;
    for (const m of mutations(view)) assert.notEqual(`${code}.${viewDigest(withLeaf(view, m.at, m.replace))}`, token, `${sub}: ${m.path}`);
  }
});

test("contact: a decision with an old token is stale and writes nothing; a new arrival leaves allow-once pending", async (t) => {
  const { home, c, bound, store, id } = await pending(t);
  const shown = await decisions.show({ home, id, sources: { contacts: c } });
  assert.deepEqual(shown.actions.map((a) => a.action), ["allow", "allow-once", "block"]);
  await c.hold(bound.dir, session("s"), fromAlice("two"), "ask"); // arrives after the owner looked
  const before = snapshot(home);
  const r = await decisions.decide({ home, id, action: "allow-once", token: shown.token, options: {}, sources: { contacts: c } });
  assert.equal(r.stale, true);
  assert.equal(r.view.items.length, 2, "the new view shows the new arrival");
  assert.notEqual(r.token, shown.token);
  assert.deepEqual(snapshot(home), before, "nothing was written");
  assert.equal(await store.take(processConsumer("engine", "e")), null, "nothing was released");
  const ok = await decisions.decide({ home, id, action: "allow-once", token: r.token, options: {}, sources: { contacts: c } });
  assert.equal(ok.done, true);
  const got = await store.take(processConsumer("engine", "e2"), { screen: c.screenFor(session("s")) });
  assert.deepEqual(got.messages.map((m) => m.msg.text).sort(), ["one", "two"]);
});

test("contact: the view digest is compared under the contacts lock (a shown field changed without a new rev)", async (t) => {
  const { home, c, id } = await pending(t);
  const shown = await decisions.show({ home, id, sources: { contacts: c } });
  // The request record is edited in place (same rev): only the digest can notice.
  const file = path.join(home, "contacts", "requests", `${id.slice(8)}.json`);
  const rec = JSON.parse(fs.readFileSync(file, "utf8"));
  rec.sender.label = "member mallory";
  fs.writeFileSync(file, JSON.stringify(rec));
  const before = snapshot(home);
  const r = await decisions.decide({ home, id, action: "allow-once", token: shown.token, options: {}, sources: { contacts: c } });
  assert.equal(r.stale, true);
  assert.equal(r.view.sender.label, "member mallory");
  assert.deepEqual(snapshot(home), before, "nothing was written");
});

test("an action or option outside the kind's set is refused before anything is written", async (t) => {
  const { home, c, id } = await pending(t);
  const shown = await decisions.show({ home, id, sources: { contacts: c } });
  const before = snapshot(home);
  const tries = [
    ["approve", {}],
    ["allow", { how: "in-person" }],
    ["block", { session: `${R}/s` }],
    ["allow-once", { session: "../../etc" }],
    ["verify", { how: "in-person" }],
  ];
  for (const [action, options] of tries) {
    const r = await decisions.decide({ home, id, action, token: shown.token, options, sources: { contacts: c } });
    assert.equal(r.refused, true, `${action} ${JSON.stringify(options)}`);
  }
  for (const id2 of ["proposal:00000000-0000-0000-0000-000000000000", "contact-request:abc"]) {
    assert.equal((await decisions.decide({ home, id: id2, action: "accept", token: null, options: {} })).refused, true, "shown-only kinds decide nothing");
  }
  assert.equal((await decisions.decide({ home, id: "contact:../x", action: "allow-once", token: shown.token })).refused, true);
  assert.equal((await decisions.decide({ home, id, action: "allow-once", token: "1.2.zz" })).refused, true, "a malformed token");
  assert.deepEqual(snapshot(home), before);
});

test("no deadlock: every decide path runs the real native operation with its lock, and no writer fits between the check and the mutation", async (t) => {
  const seen = [];
  let lockFile = null;
  const fault = (point) => {
    if (point === "contacts-decision-checked" || point === "contacts-policy-checked") {
      // Inside the native lock: another process cannot take it now.
      const other = tryLock(lockFile);
      if (typeof other === "function") {
        other();
        seen.push(`${point}: free`);
      } else seen.push(`${point}: held`);
    }
  };
  for (const action of ["allow", "allow-once", "block"]) {
    const { home, c, id } = await pending(t, { fault });
    lockFile = path.join(home, "contacts", "state.json.lock");
    const shown = await decisions.show({ home, id, sources: { contacts: c } });
    const r = await decisions.decide({ home, id, action, token: shown.token, options: {}, sources: { contacts: c } });
    assert.equal(r.done, true, action);
  }
  assert.deepEqual(seen, Array(3).fill("contacts-decision-checked: held"));

  // Devices: verify, then accept a new device, through updatePins under the contacts lock.
  const home = tmpHome(t);
  const c = await openContacts(home, { notify: false });
  lockFile = path.join(home, "contacts", "state.json.lock");
  const me = `m_${"m".repeat(26)}`;
  const bob = `m_${"b".repeat(26)}`;
  const served = (d) => ({ device: d.device, key: d.key.toString("base64"), pin: d.register().pin, seq: 0, rotations: [] });
  const mine = await fakeDevice(R, me);
  await seedOwn(c, R, me, mine);
  const lists = { [me]: [served(mine)], [bob]: [served(await fakeDevice(R, bob))] };
  let inside = null;
  const sources = {
    contacts: {
      ...c,
      currentPolicy: c.currentPolicy,
      updatePins: (mutate) =>
        c.updatePins((doc) => {
          const other = tryLock(lockFile);
          inside = typeof other === "function" ? (other(), "free") : "held";
          return mutate(doc);
        }),
    },
    devices: { fetch: async (m) => ({ theirs: { realm: R, member: m, devices: lists[m] }, mine: { realm: R, member: me, devices: lists[me] } }) },
  };
  const v = await decisions.show({ home, id: `device-verify:${bob}`, sources });
  assert.equal((await decisions.decide({ home, id: `device-verify:${bob}`, action: "verify", token: v.token, options: { how: "in-person" }, sources })).done, true);
  assert.equal(inside, "held");
  const b2 = await fakeDevice(R, bob);
  lists[bob] = [...lists[bob], served(b2)];
  const [item] = await decisions.list({ home, kinds: ["device-accept"], sources });
  assert.equal(item.id, `device-accept:${bob}/${b2.device}`);
  const a = await decisions.show({ home, id: item.id, sources });
  assert.equal((await decisions.decide({ home, id: item.id, action: "accept", token: a.token, options: {}, sources })).done, true);
  const pin = JSON.parse(fs.readFileSync(path.join(home, "contacts.json"), "utf8")).pins[0];
  assert.equal(pin.how, "in-person");
  assert.equal(pin.devices.length, 2);
  // relay-tofu is never offered as verified: the verify action only takes in-person or out-of-band.
  assert.deepEqual(v.actions, [{ action: "verify", options: { how: ["in-person", "out-of-band"] } }]);
  assert.equal((await decisions.decide({ home, id: `device-verify:${bob}`, action: "verify", token: v.token, options: { how: "relay-tofu" }, sources })).refused, true);
});

test("device: a --set mismatch after a new device or a pins change is stale; a key change shows old and new", async (t) => {
  const home = tmpHome(t);
  const c = await openContacts(home, { notify: false });
  const me = `m_${"m".repeat(26)}`;
  const bob = `m_${"b".repeat(26)}`;
  const served = (d) => ({ device: d.device, key: d.key.toString("base64"), pin: d.register().pin, seq: 0, rotations: [] });
  const b1 = await fakeDevice(R, bob);
  const m1 = await fakeDevice(R, me);
  await seedOwn(c, R, me, m1);
  const lists = { [me]: [served(m1)], [bob]: [served(b1)] };
  const sources = { contacts: c, devices: { fetch: async (m) => ({ theirs: { realm: R, member: m, devices: lists[m] }, mine: { realm: R, member: me, devices: lists[me] } }) } };
  const id = `device-verify:${bob}`;
  const v1 = await decisions.show({ home, id, sources });
  lists[bob] = [served(b1), served(await fakeDevice(R, bob))];
  const before = fs.readFileSync(path.join(home, "contacts.json"), "utf8");
  const s1 = await decisions.decide({ home, id, action: "verify", token: v1.token, options: { how: "in-person" }, sources });
  assert.equal(s1.stale, true, "a new device");
  const v2 = await decisions.show({ home, id, sources });
  const doc = JSON.parse(before);
  doc.revision = (doc.revision ?? 0) + 1; // a pins change by another run
  fs.writeFileSync(path.join(home, "contacts.json"), JSON.stringify(doc));
  assert.equal((await decisions.decide({ home, id, action: "verify", token: v2.token, options: { how: "in-person" }, sources })).stale, true, "a pins change");
  // The CLI's code alone (--set) is accepted too.
  const v3 = await decisions.show({ home, id, sources });
  assert.equal((await decisions.decide({ home, id, action: "verify", token: v3.nativeToken, options: { how: "out-of-band" }, sources })).done, true);
  // A key change of a pinned device: the view shows the old and the new fingerprint.
  const other = await fakeDevice(R, bob, { device: b1.device });
  lists[bob] = [served(other), lists[bob][1]];
  const k = await decisions.show({ home, id: `device-accept:${bob}/${b1.device}`, sources });
  const changed = k.view.changed.find((x) => x.device === b1.device);
  assert.ok(changed.old && changed.new && changed.old !== changed.new);
  assert.equal(k.view.target.state, "changed");
  // Without a device source (relay unreachable) a device decision is refused.
  assert.equal((await decisions.decide({ home, id, action: "verify", token: v3.token, options: { how: "in-person" }, sources: { contacts: c } })).refused, true);
});

test("a damaged policy refuses every decision; a busy lock is busy; nothing is written", async (t) => {
  const { home, c, id } = await pending(t);
  const shown = await decisions.show({ home, id, sources: { contacts: c } });
  const release = tryLock(path.join(home, "contacts", "state.json.lock"));
  const busy = await decisions.decide({ home, id, action: "allow-once", token: shown.token, options: {}, sources: { contacts: c } });
  release();
  assert.equal(busy.busy, true);
  fs.writeFileSync(path.join(home, "contacts.json"), "{damaged");
  const before = snapshot(home);
  const r = await decisions.decide({ home, id, action: "allow-once", token: shown.token, options: {}, sources: { contacts: c } });
  assert.equal(r.refused, true);
  assert.match(r.reason, /fix it/);
  assert.deepEqual(snapshot(home), before);
});

// ---- settings ---------------------------------------------------------------------------------------

function settingsHome(t, { env = {}, fromFile = [] } = {}) {
  const home = tmpHome(t);
  const relaysFile = path.join(home, "relays.json");
  fs.writeFileSync(relaysFile, `${JSON.stringify({ version: 1, default: "lab", relays: [{ alias: "lab", url: "ws://192.0.2.1:7777", tokenFile: "lab.token" }, { alias: "home", url: "ws://192.0.2.2:7777", tokenEnv: "HOME_TOKEN", join: false }] }, null, 2)}\n`, { mode: 0o600 });
  const ctx = decisions.settingsContext({ env, fromFile, envFile: path.join(home, "settings.env"), relaysFile });
  return { home, ctx, relaysFile };
}

test("settings: an environment-sourced key is not writable; a value outside the allowed set is refused", async (t) => {
  const { home, ctx, relaysFile } = settingsHome(t, { env: { HOPTELL_SNAPSHOT_ROOTS: '[{"id":"app","path":"/tmp"}]' } });
  await openContacts(home, { notify: false });
  const rows = await decisions.settings.list({ home, ctx });
  const roots = rows.find((r) => r.key === "files.roots");
  assert.equal(roots.writable, false);
  assert.match(roots.source, /environment \(HOPTELL_SNAPSHOT_ROOTS\)/);
  const s = decisions.settings.show({ home, ctx, key: "files.roots" });
  assert.equal((await decisions.settings.set({ home, ctx, key: "files.roots", value: "[]", token: s.token })).refused, true);
  const before = [digestOf(relaysFile), digestOf(path.join(home, "contacts.json"))];
  for (const [key, value] of [["contacts.default", "maybe"], ["contacts.unverified", "allow"], ["relays.lab.join", "yes"], ["relays.default", "nowhere"], ["relays.lab.name", "bad name!"]]) {
    const cur = decisions.settings.show({ home, ctx, key });
    assert.equal((await decisions.settings.set({ home, ctx, key, value, token: cur.token })).refused, true, `${key}=${value}`);
  }
  assert.deepEqual([digestOf(relaysFile), digestOf(path.join(home, "contacts.json"))], before);
  // From the settings file instead: writable, and an invalid roots value is refused.
  const { home: h2, ctx: c2 } = settingsHome(t, { env: { HOPTELL_SNAPSHOT_ROOTS: "[]" }, fromFile: ["HOPTELL_SNAPSHOT_ROOTS"] });
  const r2 = decisions.settings.show({ home: h2, ctx: c2, key: "files.roots" });
  assert.equal(r2.writable, true);
  assert.equal((await decisions.settings.set({ home: h2, ctx: c2, key: "files.roots", value: '[{"id":"app","path":"relative"}]', token: r2.token })).refused, true);
  const ok = await decisions.settings.set({ home: h2, ctx: c2, key: "files.roots", value: '[{"id":"app","path":"/srv/app"}]', token: r2.token });
  assert.equal(ok.done, true);
  assert.equal(decisions.settings.show({ home: h2, ctx: c2, key: "files.roots" }).value, '[{"id":"app","path":"/srv/app"}]', "read back as loadEnv reads it");
  assert.equal(decisions.settings.widens({ home: h2, ctx: c2, key: "files.roots", value: '[{"id":"app","path":"/srv/app"},{"id":"b","path":"/b"}]' }), true);
});

test("settings: compare-and-set between two writers, for contacts.json and for relays.json under the settings lock", async (t) => {
  const { home, ctx, relaysFile } = settingsHome(t);
  await openContacts(home, { notify: false });
  for (const [key, a, b] of [["contacts.default", "block", "allow"], ["relays.lab.join", "false", "true"]]) {
    const first = decisions.settings.show({ home, ctx, key });
    const second = decisions.settings.show({ home, ctx, key });
    assert.equal((await decisions.settings.set({ home, ctx, key, value: a, token: first.token })).done, true);
    const lost = await decisions.settings.set({ home, ctx, key, value: b, token: second.token });
    assert.equal(lost.stale, true, key);
    assert.equal(lost.value, a);
  }
  assert.equal(decisions.settings.widens({ home, ctx, key: "contacts.default", value: "allow" }), true);
  assert.equal(decisions.settings.show({ home, ctx, key: "relays.lab.join" }).widening.join(), "true");
  const doc = JSON.parse(fs.readFileSync(relaysFile, "utf8"));
  assert.equal(doc.relays[0].join, false);
  assert.equal(doc.relays[0].tokenFile, "lab.token", "the document is edited as written (no tokens are added)");
  assert.equal(fs.statSync(relaysFile).mode & 0o077, 0, "still private");
  // A hand edit seen just before the rename makes the write stale and is kept.
  const cur = decisions.settings.show({ home, ctx, key: "relays.default" });
  const edited = fs.readFileSync(relaysFile, "utf8").replace('"default": "lab"', '"default": "home"');
  const r = await decisions.settings.set({ home, ctx, key: "relays.default", value: "", token: cur.token, sources: { fault: (p) => p === "rename" && fs.writeFileSync(relaysFile, edited) } });
  assert.equal(r.stale, true);
  assert.equal(JSON.parse(fs.readFileSync(relaysFile, "utf8")).default, "home");
  // The settings lock is the one held while the file is written.
  const held = tryLock(path.join(home, "settings.lock"));
  const busy = await decisions.settings.set({ home, ctx, key: "relays.default", value: "", token: decisions.settings.show({ home, ctx, key: "relays.default" }).token });
  held();
  assert.equal(busy.busy, true);
});

test("settings: a crash during writeDurable leaves the old file; the restart list names live sessions started before the change", async (t) => {
  const { home, ctx, relaysFile } = settingsHome(t);
  const before = fs.readFileSync(relaysFile, "utf8");
  const cur = decisions.settings.show({ home, ctx, key: "relays.lab.name" });
  await assert.rejects(decisions.settings.set({ home, ctx, key: "relays.lab.name", value: "me", token: cur.token, sources: { fault: (p) => { if (p === "file-fsync") throw Object.assign(new Error("simulated crash"), { code: "EIO" }); } } }), /simulated/);
  assert.equal(fs.readFileSync(relaysFile, "utf8"), before);
  assert.deepEqual(fs.readdirSync(home).filter((f) => f.endsWith(".tmp")), [], "no temporary file left");
  // This test process stands for a session with a hook registration, started before the change.
  const dir = ensureWakeDir(home);
  writeRecord(filesFor(dir, "k1").runtime, { key: "k1", peer: "bob", generation: 1, mcp: { pid: process.pid, start: processInfo(process.pid).start } });
  writeRecord(filesFor(dir, "k2").runtime, { key: "k2", peer: "gone", generation: 1, mcp: { pid: 999999, start: "Thu Jan  1 00:00:00 1970" } });
  const done = await decisions.settings.set({ home, ctx, key: "relays.lab.name", value: "me", token: cur.token });
  assert.deepEqual(done.restart, ["bob"]);
  const rows = await decisions.settings.list({ home, ctx });
  assert.deepEqual(rows.find((r) => r.key === "relays.lab.name").restart, ["bob"]);
  await openContacts(home, { notify: false });
  assert.deepEqual((await decisions.settings.list({ home, ctx })).find((r) => r.key === "contacts.default").restart, [], "the policy is read again without a restart");
});

test("encryption-violation: plaintext from a contact whose encryption is required is shown only; the setting releases it", async (t) => {
  const home = tmpHome(t);
  const c = await openContacts(home, { notify: false });
  await c.setEncryption({ realm: R, member: ALICE, mode: "required" });
  const bound = await openBound(home, { realm: R, member: null, key: "s" });
  const store = await openStore(bound);
  const msg = fromAlice("plain");
  await c.hold(bound.dir, session("s"), msg, c.verdict(msg, session("s")));
  const [item] = await decisions.list({ home, sources: { contacts: c } });
  assert.equal(item.kind, "encryption-violation");
  const shown = await decisions.show({ home, id: item.id, sources: { contacts: c } });
  assert.deepEqual(shown.actions, []);
  assert.equal(shown.view.setting, `encryption.${R}.${ALICE}`);
  const before = snapshot(home);
  assert.equal((await decisions.decide({ home, id: item.id, action: "allow-once", token: shown.token })).refused, true);
  // The same request as a contact decision offers only the block; allow-once is refused natively too.
  const asContact = await decisions.show({ home, id: shown.view.request, sources: { contacts: c } });
  assert.deepEqual(asContact.actions.map((a) => a.action), ["block"]);
  const r = await decisions.decide({ home, id: shown.view.request, action: "allow-once", token: asContact.token, options: {}, sources: { contacts: c } });
  assert.equal(r.refused, true);
  assert.match(r.reason, /encryption is required/);
  assert.deepEqual(snapshot(home), before);
  // Lowering the contact's encryption (marked as widening) turns it into an ordinary request.
  const ctx = decisions.settingsContext({ env: { HOPTELL_EXPERIMENTAL_E2EE: "1" }, fromFile: [], envFile: path.join(home, "s.env"), relaysFile: path.join(home, "none.json") });
  const k = decisions.settings.show({ home, ctx, key: `encryption.${R}.${ALICE}` });
  assert.equal(k.value, "required");
  assert.deepEqual(k.allowed.enum, ["off", "preferred", "required"]);
  assert.deepEqual(k.widening.sort(), ["off", "preferred"], "lowering widens access");
  assert.equal((await decisions.settings.set({ home, ctx, key: k.key, value: "preferred", token: k.token, sources: { contacts: c } })).done, true);
  const [after] = await decisions.list({ home, sources: { contacts: c } });
  assert.equal(after.kind, "contact");
  const s2 = await decisions.show({ home, id: after.id, sources: { contacts: c } });
  assert.equal((await decisions.decide({ home, id: after.id, action: "allow-once", token: s2.token, options: {}, sources: { contacts: c } })).done, true);
  const got = await store.take(processConsumer("engine", "v"), { screen: c.screenFor(session("s")) });
  assert.deepEqual(got.messages.map((m) => m.msg.text), ["plain"]);
});

test("encryption settings: offered with experimental device keys only, compare-and-set, values outside the set refused", async (t) => {
  const home = tmpHome(t);
  const c = await openContacts(home, { notify: false });
  await c.setEncryption({ realm: R, member: null, mode: "preferred" }); // the realm's default
  const doc = JSON.parse(fs.readFileSync(path.join(home, "contacts.json"), "utf8"));
  doc.grants = [{ id: "g_aaaaaaaaaaaaaaaa", realm: R, member: ALICE }];
  doc.revision++;
  fs.writeFileSync(path.join(home, "contacts.json"), JSON.stringify(doc));
  const ctxOf = (env) => decisions.settingsContext({ env, fromFile: [], envFile: path.join(home, "s.env"), relaysFile: path.join(home, "none.json") });
  const key = `encryption.${R}.${ALICE}`;
  assert.equal(decisions.settings.show({ home, ctx: ctxOf({}), key }), null, "not offered without HOPTELL_EXPERIMENTAL_E2EE");
  const ctx = ctxOf({ HOPTELL_EXPERIMENTAL_E2EE: "1" });
  const row = (await decisions.settings.list({ home, ctx })).find((r) => r.key === key);
  assert.equal(row.value, "preferred");
  assert.equal(row.note, "from the realm's default");
  const a = decisions.settings.show({ home, ctx, key });
  const b = decisions.settings.show({ home, ctx, key });
  const before = digestOf(path.join(home, "contacts.json"));
  assert.equal((await decisions.settings.set({ home, ctx, key, value: "maybe", token: a.token, sources: { contacts: c } })).refused, true);
  assert.equal(digestOf(path.join(home, "contacts.json")), before);
  assert.equal((await decisions.settings.set({ home, ctx, key, value: "required", token: a.token, sources: { contacts: c } })).done, true);
  assert.equal((await decisions.settings.set({ home, ctx, key, value: "off", token: b.token, sources: { contacts: c } })).stale, true);
  const enc = JSON.parse(fs.readFileSync(path.join(home, "contacts.json"), "utf8")).encryption;
  assert.deepEqual(enc, [{ realm: R, mode: "preferred" }, { realm: R, member: ALICE, mode: "required" }]);
});

test("settings: the token describes exactly the bytes the shown value was read from (an edit between two reads is stale)", async (t) => {
  for (const kind of ["contacts", "roots", "relays"]) {
    const { home, ctx, relaysFile } = settingsHome(t, { fromFile: ["HOPTELL_SNAPSHOT_ROOTS"] });
    const c = await openContacts(home, { notify: false });
    let file, key, after, value;
    if (kind === "contacts") {
      file = path.join(home, "contacts.json");
      key = "contacts.default";
      const d = JSON.parse(fs.readFileSync(file, "utf8"));
      d.default = "block";
      d.revision++;
      after = JSON.stringify(d);
      value = "allow";
    } else if (kind === "roots") {
      file = ctx.envFile;
      key = "files.roots";
      fs.writeFileSync(file, 'HOPTELL_SNAPSHOT_ROOTS="[]"\n');
      after = `HOPTELL_SNAPSHOT_ROOTS=${JSON.stringify(JSON.stringify([{ id: "existing", path: "/srv/x" }]))}\n`;
      value = JSON.stringify([{ id: "new", path: "/srv/y" }]);
    } else {
      file = relaysFile;
      key = "relays.lab.name";
      after = fs.readFileSync(file, "utf8").replace('"alias": "lab",', '"alias": "lab", "name": "concurrent",');
      value = "chosen";
    }
    // Another editor changes the file right after the first read of it during show().
    const original = fs.readFileSync;
    let armed = true;
    fs.readFileSync = function (p, ...rest) {
      const b = original.call(this, p, ...rest);
      if (String(p) === file && armed) {
        armed = false;
        fs.writeFileSync(file, after);
      }
      return b;
    };
    let shown;
    try {
      shown = decisions.settings.show({ home, ctx, key });
    } finally {
      fs.readFileSync = original;
    }
    assert.equal(armed, false, kind);
    const r = await decisions.settings.set({ home, ctx, key, value, token: shown.token, sources: { contacts: c } });
    assert.equal(r.stale, true, `${kind}: shown from older bytes, so the concurrent edit is kept`);
    assert.equal(fs.readFileSync(file, "utf8"), after, kind);
  }
});

test("encryption: a member held under a required realm default gets its own setting, with the inherited value and the widening mark", async (t) => {
  const home = tmpHome(t);
  const c = await openContacts(home, { notify: false });
  await c.setEncryption({ realm: R, member: null, mode: "required" });
  const bound = await openBound(home, { realm: R, member: null, key: "s" });
  await openStore(bound);
  const msg = fromAlice("plain");
  await c.hold(bound.dir, session("s"), msg, c.verdict(msg, session("s")));
  const [item] = await decisions.list({ home, sources: { contacts: c } });
  const shown = await decisions.show({ home, id: item.id, sources: { contacts: c } });
  const ctx = decisions.settingsContext({ env: { HOPTELL_EXPERIMENTAL_E2EE: "1" }, fromFile: [], envFile: path.join(home, "s.env"), relaysFile: path.join(home, "none.json") });
  const k = decisions.settings.show({ home, ctx, key: shown.view.setting });
  assert.ok(k, "the linked setting exists");
  assert.equal(k.value, "required");
  assert.deepEqual(k.widening.sort(), ["off", "preferred"]);
  assert.equal((await decisions.settings.list({ home, ctx })).find((r) => r.key === k.key).note, "from the realm's default");
  assert.equal((await decisions.settings.set({ home, ctx, key: k.key, value: "preferred", token: k.token, sources: { contacts: c } })).done, true);
  assert.equal((await decisions.list({ home, sources: { contacts: c } }))[0].kind, "contact");
});

test("requireVerified: per realm and per pinned contact, writable with compare-and-set; turning it off widens access", async (t) => {
  const { evaluate } = await import("../lib/mls/trust.js");
  const home = tmpHome(t);
  const c = await openContacts(home, { notify: false });
  const b1 = await fakeDevice(R, ALICE);
  await c.updatePins((doc) => void (doc.pins = [{ realm: R, member: ALICE, devices: [{ device: b1.device, pin: b1.register().pin, key: b1.key.toString("base64"), seq: 0 }], verifiedAt: new Date().toISOString(), how: "relay-tofu" }]));
  const ctxOf = (env) => decisions.settingsContext({ env, fromFile: [], envFile: path.join(home, "s.env"), relaysFile: path.join(home, "none.json") });
  assert.equal(decisions.settings.show({ home, ctx: ctxOf({}), key: `verified.${R}` }), null, "experimental only");
  const ctx = ctxOf({ HOPTELL_EXPERIMENTAL_E2EE: "1" });
  const served = [{ device: b1.device, key: b1.key.toString("base64"), pin: b1.register().pin, seq: 0, rotations: [] }];
  const doc = () => JSON.parse(fs.readFileSync(path.join(home, "contacts.json"), "utf8"));
  for (const key of [`verified.${R}.${ALICE}`, `verified.${R}`]) {
    const k = decisions.settings.show({ home, ctx, key });
    assert.equal(k.value, "false", key);
    assert.deepEqual(k.widening, [], "turning it on narrows");
    const late = decisions.settings.show({ home, ctx, key });
    assert.equal((await decisions.settings.set({ home, ctx, key, value: "yes", token: k.token, sources: { contacts: c } })).refused, true);
    assert.equal((await decisions.settings.set({ home, ctx, key, value: "true", token: k.token, sources: { contacts: c } })).done, true, key);
    assert.equal((await decisions.settings.set({ home, ctx, key, value: "false", token: late.token, sources: { contacts: c } })).stale, true, key);
    assert.equal(evaluate(doc(), R, ALICE, served).state, "hold", `${key}: an unverified contact is held`);
    const on = decisions.settings.show({ home, ctx, key });
    assert.deepEqual(on.widening, ["false"]);
    assert.equal((await decisions.settings.set({ home, ctx, key, value: "false", token: on.token, sources: { contacts: c } })).done, true);
    assert.equal(evaluate(doc(), R, ALICE, served).state, "ok");
  }
  assert.equal(doc().requireVerified, undefined);
  assert.equal(doc().pins[0].requireVerified, undefined);
});
