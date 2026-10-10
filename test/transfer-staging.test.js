// The receiver's side of a larger transfer (design 6, "6.2 Download and staging", TR6, and the
// client half of "Retention", TR5), with a real relay and real clients: the checks before any
// fetch, the staging ledger and its caps, restarts and damage, cleanup that keeps its charge when
// it fails, expiry during a download, cancellation and resumption.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { contactsFile, readContacts, transferCaps, transferPolicy, validateContacts } from "../lib/contacts.js";
import { openContacts } from "../lib/quarantine.js";
import { StagingError, createStaging, incomingDir } from "../lib/transferin.js";
import { sessionTransfers } from "../lib/transfers.js";
import { saveTransfer } from "../lib/transfersave.js";
import { acceptOwnDevices, tmpDir } from "./mls-helpers.js";
import { CHUNK_SIZE } from "../lib/transferwire.js";
import { allowTransfers, device, pattern, sendFile, settle, sha, transferRelay, until } from "./transfer-helpers.js";

async function pair(t, { bob = {}, allow = true, maxBytes, caps } = {}) {
  const w = await transferRelay(t);
  const alice = await device(t, w, "alice");
  const b = await device(t, w, "bob", bob);
  if (allow) allowTransfers(b.contacts, w.realm, alice.id, maxBytes, caps);
  return { w, alice, bob: b };
}
/** Count the download frames a client sends. */
function spy(client) {
  const rpc = client.rpc.bind(client);
  const seen = { download: 0 };
  client.rpc = (f) => {
    if (f.type === "download") seen.download++;
    return rpc(f);
  };
  return seen;
}
const message = (bob) => until(() => (bob.s.bob.got.length ? bob.s.bob.got.at(-1) : null), "the message");
const crash = (point, when = () => true) => (p, ...a) => {
  if (p === point && when(...a)) throw Object.assign(new Error(`crash at ${p}`), { code: "EFAULT" });
};
const entries = (bob) => bob.staging.list();
/** A new staging over the same home (as after a restart of the receiving process). */
const restart = (bob, w, opts = {}) => createStaging({ home: bob.dir, contacts: () => bob.contacts.doc, now: w.clock.now, onStaged: async (e, file) => void bob.staged.push({ e, bytes: fs.readFileSync(file) }), ...opts });

test("TR6: the default refusal performs no fetch, and the agent learns why", async (t) => {
  const { alice, bob } = await pair(t, { allow: false });
  const seen = spy(bob.s.bob.client);
  assert.equal((await sendFile(alice, "alice", bob, pattern(5000))).state, "accepted");
  const m = await message(bob);
  assert.match(m.text, /not fetched: your user has not allowed file transfers from this contact/);
  await settle(200);
  assert.equal(seen.download, 0, "no byte fetched");
  assert.deepEqual(entries(bob), [], "nothing reserved");
});

test("TR6: a declared size over the contact's maxBytes is refused before any fetch", async (t) => {
  const { alice, bob } = await pair(t, { maxBytes: 4096 });
  const seen = spy(bob.s.bob.client);
  await sendFile(alice, "alice", bob, pattern(4097));
  assert.match((await message(bob)).text, /larger than the 4096 bytes your user allows/);
  await settle(100);
  assert.equal(seen.download, 0);
  assert.deepEqual(entries(bob), []);
});

test("TR6: concurrent downloads at the cap: the next transfer is refused before any fetch", async (t) => {
  const { alice, bob } = await pair(t, { bob: { autoFetch: false }, caps: { concurrent: 1 } });
  await sendFile(alice, "alice", bob, pattern(3000));
  await until(() => entries(bob).length === 1, "the first reservation");
  await sendFile(alice, "alice", bob, pattern(3000, 1));
  await until(() => bob.s.bob.got.length === 2, "the second message");
  assert.match(bob.s.bob.got[1].text, /1 downloads are already running in this home/);
  assert.match(bob.s.bob.got[1].text, /It will not be fetched later: the sender has to send it again after space is freed in this home\./, "the notice says the sender has to send it again");
  assert.equal(entries(bob).length, 1);
});

test("TR6: repeated sequential completions until each cap (bytes, then files): staged files keep their charge, so the next transfer is refused before any fetch", async (t) => {
  const { alice, bob } = await pair(t, { caps: { stagedBytes: 3 * 10_000, stagedFiles: 100 } });
  for (let i = 0; i < 3; i++) {
    await sendFile(alice, "alice", bob, pattern(10_000, i));
    await until(() => bob.staged.length === i + 1, `staged ${i + 1}`);
  }
  const seen = spy(bob.s.bob.client);
  await sendFile(alice, "alice", bob, pattern(1, 9));
  await until(() => bob.s.bob.got.length === 4, "the fourth message");
  assert.match(bob.s.bob.got[3].text, /staging space is full \(30000 of 30000 bytes used/);
  assert.match(bob.s.bob.got[3].text, /It will not be fetched later: the sender has to send it again after space is freed in this home\./, "a cap refusal is final, and the notice says the sender has to resend");
  assert.equal(seen.download, 0);
  // The files cap.
  bob.contacts.doc.transfers.stagedBytes = 10 ** 9;
  bob.contacts.doc.transfers.stagedFiles = 4;
  await sendFile(alice, "alice", bob, pattern(10, 10));
  await until(() => bob.staged.length === 4, "the fourth staged");
  await sendFile(alice, "alice", bob, pattern(10, 11));
  await until(() => bob.s.bob.got.length === 6, "the sixth message");
  assert.match(bob.s.bob.got[5].text, /the most staged files it may \(4/);
  assert.match(bob.s.bob.got[5].text, /It will not be fetched later: the sender has to send it again after space is freed in this home\./);
  assert.equal(entries(bob).filter((e) => e.state === "staged").length, 4);
});

test("TR6: zero-byte transfers are staged and occupy a file slot with 0 bytes", async (t) => {
  const { alice, bob } = await pair(t, { caps: { stagedFiles: 1 } });
  await sendFile(alice, "alice", bob, Buffer.alloc(0), { name: "empty" });
  const [s] = await until(() => (bob.staged.length ? bob.staged : null), "staged");
  assert.deepEqual([s.e.bytes, s.bytes.length, s.e.state], [0, 0, "staged"]);
  await sendFile(alice, "alice", bob, Buffer.alloc(0), { name: "empty2" });
  await until(() => bob.s.bob.got.length === 2, "the second message");
  assert.match(bob.s.bob.got[1].text, /the most staged files it may \(1/);
});

test("TR6: a full disk, simulated, while writing fails the transfer: its folder is deleted and its charge released", async (t) => {
  const enospc = (p, _t, i) => {
    if (p === "before-chunk-write" && i === 1) throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
  };
  const { alice, bob } = await pair(t, { bob: { stagingOpts: { fault: enospc } } });
  await sendFile(alice, "alice", bob, pattern(3 * CHUNK_SIZE));
  const [r] = await until(() => (bob.fetches.length ? Promise.all(bob.fetches) : null), "the fetch");
  assert.deepEqual(r, { state: "failed", reason: "the staging copy could not be written (ENOSPC)" });
  const [e] = entries(bob);
  assert.equal(e.state, "removed");
  assert.equal(fs.existsSync(path.join(incomingDir(bob.dir), e.t)), false);
});

test("TR6: a restart during a chunk write resumes: the unrecorded chunk is fetched again, recorded ones are verified, the file completes", async (t) => {
  const { w, alice, bob } = await pair(t, { bob: { stagingOpts: { fault: crash("after-chunk-write", (_t, i) => i === 2) } } });
  const bytes = pattern(4 * CHUNK_SIZE + 3);
  await sendFile(alice, "alice", bob, bytes);
  await until(() => bob.fetches.length, "a fetch");
  await assert.rejects(bob.fetches[0], /crash at after-chunk-write/);
  const [e] = entries(bob);
  const st = JSON.parse(fs.readFileSync(path.join(incomingDir(bob.dir), e.t, "state.json"), "utf8"));
  assert.deepEqual(Object.keys(st.chunks).sort(), ["0", "1"], "chunk 2 written but not recorded");
  const again = restart(bob, w);
  await again.reconcile();
  const seen = spy(bob.s.bob.client);
  assert.equal((await again.fetch(e.t, (f) => bob.s.bob.client.rpc(f))).state, "staged");
  assert.equal(seen.download, 3, "chunks 2, 3 and 4 only");
  assert.equal(sha(bob.staged.at(-1).bytes), sha(bytes));
});

test("TR6: a corrupted state.json restarts the download from index 0 (once); a corrupted data file refetches the damaged chunk", async (t) => {
  const { w, alice, bob } = await pair(t, { bob: { stagingOpts: { fault: crash("after-chunk-write", (_t, i) => i === 1) } } });
  const bytes = pattern(3 * CHUNK_SIZE);
  await sendFile(alice, "alice", bob, bytes);
  await until(() => bob.fetches.length, "a fetch");
  await assert.rejects(bob.fetches[0], /crash/);
  const [e] = entries(bob);
  const dir = path.join(incomingDir(bob.dir), e.t);
  // Damage a recorded chunk's data: it is fetched again.
  const fd = fs.openSync(path.join(dir, "data"), "r+");
  fs.writeSync(fd, Buffer.from([0xee]), 0, 1, 17);
  fs.closeSync(fd);
  const s1 = restart(bob, w, { fault: crash("after-chunk-write", (_t, i) => i === 2) });
  const seen = spy(bob.s.bob.client);
  await assert.rejects(s1.fetch(e.t, (f) => bob.s.bob.client.rpc(f)), /crash/);
  assert.equal(seen.download, 3, "the damaged chunk 0, and 1 and 2, which were never recorded");
  // Damaged state: the download starts again from index 0, once (the descriptor is its own file).
  fs.writeFileSync(path.join(dir, "state.json"), "{not json");
  const s2 = restart(bob, w);
  const seen2 = spy(bob.s.bob.client);
  assert.equal((await s2.fetch(e.t, (f) => bob.s.bob.client.rpc(f))).state, "staged");
  assert.equal(seen2.download, 3, "every chunk fetched again");
  assert.equal(entries(bob)[0].restarts, 1);
  assert.equal(sha(bob.staged.at(-1).bytes), sha(bytes));
  // A damaged descriptor cannot be recovered at all (the key is in it): the transfer fails.
});

test("TR6: data shorter than recorded restarts from index 0 once; a second time the transfer fails", async (t) => {
  const { w, alice, bob } = await pair(t, { bob: { stagingOpts: { fault: crash("after-chunk-write", (_t, i) => i === 1) } } });
  const bytes = pattern(3 * CHUNK_SIZE);
  await sendFile(alice, "alice", bob, bytes);
  await until(() => bob.fetches.length, "a fetch");
  await assert.rejects(bob.fetches[0], /crash/);
  const [e] = entries(bob);
  const data = path.join(incomingDir(bob.dir), e.t, "data");
  fs.truncateSync(data, 10);
  const s1 = restart(bob, w, { fault: crash("after-chunk-write", (_t, i) => i === 0) });
  await assert.rejects(s1.fetch(e.t, (f) => bob.s.bob.client.rpc(f)), /crash/);
  assert.equal(entries(bob)[0].restarts, 1, "restarted from index 0");
  fs.truncateSync(data, 0);
  const st = JSON.parse(fs.readFileSync(path.join(incomingDir(bob.dir), e.t, "state.json"), "utf8"));
  st.chunks = { 0: st.chunks[0] ?? "0".repeat(64), 1: "0".repeat(64) };
  fs.writeFileSync(path.join(incomingDir(bob.dir), e.t, "state.json"), JSON.stringify(st));
  const r = await restart(bob, w).fetch(e.t, (f) => bob.s.bob.client.rpc(f));
  assert.deepEqual(r, { state: "failed", reason: "the partial download was damaged again" });
});

test("TR6: more data than declared fails the chunk's verification; it is fetched again once, then the transfer fails", async (t) => {
  const { alice, bob } = await pair(t);
  const rpc = bob.s.bob.client.rpc.bind(bob.s.bob.client);
  let asked = 0;
  bob.s.bob.client.rpc = async (f) => {
    const r = await rpc(f);
    if (f.type === "download" && f.from_index === 0) {
      asked++;
      return { ...r, data: Buffer.concat([Buffer.from(r.data, "base64"), Buffer.alloc(1)]).toString("base64") };
    }
    return r;
  };
  await sendFile(alice, "alice", bob, pattern(2 * CHUNK_SIZE));
  const [r] = await until(() => (bob.fetches.length ? Promise.all(bob.fetches) : null), "the fetch");
  assert.deepEqual(r, { state: "failed", reason: "chunk 0 failed verification twice" });
  assert.equal(asked, 2, "fetched again once");
});

test("TR6: a restart between the data being complete and the staged write, and between a deletion and the removed write", async (t) => {
  const { w, alice, bob } = await pair(t, { bob: { stagingOpts: { fault: crash("before-staged") } } });
  const bytes = pattern(CHUNK_SIZE + 5);
  await sendFile(alice, "alice", bob, bytes);
  await until(() => bob.fetches.length, "a fetch");
  await assert.rejects(bob.fetches[0], /crash at before-staged/);
  const [e] = entries(bob);
  assert.equal(e.state, "reserved");
  const s1 = restart(bob, w);
  await s1.reconcile();
  const seen = spy(bob.s.bob.client);
  assert.equal((await s1.fetch(e.t, (f) => bob.s.bob.client.rpc(f))).state, "staged");
  assert.equal(seen.download, 0, "every chunk was recorded and verified: nothing fetched again");
  assert.equal(sha(bob.staged.at(-1).bytes), sha(bytes));
  // Between the folder's deletion and the removed write: the entry is marked removed at the next start.
  const s2 = restart(bob, w, { fault: crash("after-folder-delete") });
  await assert.rejects(s2.cancel(e.t), /crash/);
  assert.equal(entries(bob)[0].state, "staged", "still charged");
  assert.equal((await restart(bob, w).reconcile()).entriesRemoved, 1);
  assert.equal(entries(bob)[0].state, "removed");
});

test("TR6: a failed cleanup keeps the charge; a later attempt releases it once", async (t) => {
  const { w, alice, bob } = await pair(t, { caps: { stagedFiles: 1 } });
  await sendFile(alice, "alice", bob, pattern(1000));
  await until(() => bob.staged.length, "staged");
  const [e] = entries(bob);
  const failing = restart(bob, w, { fault: (p) => { if (p === "before-folder-delete") throw Object.assign(new Error("permission denied"), { code: "EACCES" }); } });
  w.clock.advance(7 * 86_400_000);
  assert.deepEqual(await failing.sweep(), { removed: 0, kept: 0 });
  assert.equal(entries(bob)[0].state, "staged", "the charge stays");
  assert.match(entries(bob)[0].error, /could not be deleted \(EACCES\)/);
  await sendFile(alice, "alice", bob, pattern(10, 2));
  await until(() => bob.s.bob.got.length === 2, "the second message");
  assert.match(bob.s.bob.got[1].text, /the most staged files it may/, "still counted against the caps");
  assert.deepEqual(await restart(bob, w).sweep(), { removed: 1, kept: 0 });
  assert.equal(entries(bob).find((x) => x.t === e.t).state, "removed");
  // Compaction: removed entries leave the ledger 7 days after removal.
  w.clock.advance(7 * 86_400_000);
  await restart(bob, w).sweep();
  assert.equal(entries(bob).some((x) => x.t === e.t), false);
});

test("TR6: the ledger is reconciled with the folders at startup: a folder without an entry is deleted, an entry without a folder removed", async (t) => {
  const { w, alice, bob } = await pair(t);
  await sendFile(alice, "alice", bob, pattern(100));
  await until(() => bob.staged.length, "staged");
  const [e] = entries(bob);
  const stray = path.join(incomingDir(bob.dir), "t_0123456789abcdef01234567");
  fs.mkdirSync(stray);
  fs.rmSync(path.join(incomingDir(bob.dir), e.t), { recursive: true });
  const r = await restart(bob, w).reconcile();
  assert.deepEqual([r.foldersDeleted, r.entriesRemoved], [1, 1]);
  assert.equal(fs.existsSync(stray), false);
  assert.equal(entries(bob)[0].state, "removed");
});

const omit = (o, k) => Object.fromEntries(Object.entries(o).filter(([x]) => x !== k));

test("TR6: a ledger that parses but is not a version 1 ledger stops the startup reconciliation: the old ledger and every folder stay as they were", async (t) => {
  const { w, alice, bob } = await pair(t);
  await sendFile(alice, "alice", bob, pattern(100));
  await until(() => bob.staged.length, "staged");
  const [e] = entries(bob);
  const file = path.join(incomingDir(bob.dir), "ledger.json");
  const folder = path.join(incomingDir(bob.dir), e.t);
  const good = JSON.parse(fs.readFileSync(file, "utf8"));
  const bad = [
    { v: 2 },
    { v: 2, entries: good.entries },
    { v: 1, entries: [] },
    { v: 1 },
    [],
    null,
    { v: 1, entries: { [e.t]: { ...good.entries[e.t], state: "lost" } } },
    { v: 1, entries: { [e.t]: { ...good.entries[e.t], t: "t_0123456789abcdef01234567" } } },
    { v: 1, entries: { not_an_id: good.entries[e.t] } },
    { v: 1, entries: { [e.t]: { ...good.entries[e.t], bytes: -1 } } },
    { v: 1, entries: { [e.t]: { ...good.entries[e.t], key: null } } },
    // Fields the sweeps and the handoff read: a staged entry without staged_at would look long past.
    { v: 1, entries: { [e.t]: omit(good.entries[e.t], "staged_at") } },
    { v: 1, entries: { [e.t]: omit(good.entries[e.t], "created") } },
    { v: 1, entries: { [e.t]: omit(good.entries[e.t], "from") } },
    { v: 1, entries: { [e.t]: omit(good.entries[e.t], "to") } },
    { v: 1, entries: { [e.t]: omit(good.entries[e.t], "relay_expires") } },
    { v: 1, entries: { [e.t]: { ...good.entries[e.t], staged_at: "yesterday" } } },
    { v: 1, entries: { [e.t]: { ...good.entries[e.t], state: "removed" } } },
  ];
  assert.equal(good.entries[e.t].state, "staged");
  for (const doc of [...bad.map((d) => JSON.stringify(d)), "{not json", ""]) {
    fs.writeFileSync(file, doc);
    const s1 = restart(bob, w);
    await assert.rejects(s1.reconcile(), (x) => x instanceof StagingError && x.code === "ledger", doc);
    assert.equal(fs.readFileSync(file, "utf8"), doc, "the old ledger is left as it was");
    assert.ok(fs.existsSync(path.join(folder, "data")), "the staged folder is untouched");
    w.clock.t += 30 * 86_400_000; // long past the staged keep time: a sweep would remove it if it read this ledger
    await assert.rejects(Promise.resolve().then(() => s1.sweep()), (x) => x instanceof StagingError && x.code === "ledger", `sweep: ${doc}`);
    assert.ok(fs.existsSync(path.join(folder, "data")), "the sweep removed nothing");
    w.clock.t -= 30 * 86_400_000;
    await assert.rejects(s1.intake({ descriptor: { h: { totalBytes: 1 }, uploader_device: e.key.uploader_device, transfer_id: Buffer.alloc(16) }, sender: { member: alice.id, realm: w.realm }, to: { session: "bob" } }), (x) => x.code === "ledger", "nothing new is reserved either");
  }
  // A missing ledger alone is empty: the folder without an entry then goes.
  fs.rmSync(file);
  assert.equal((await restart(bob, w).reconcile()).foldersDeleted, 1);
});

test("TR6: a damaged ledger keeps a session's staging untouched at attachment (no resume, no sweep), not its outbox; staging is used again once repaired", async (t) => {
  const w = await transferRelay(t);
  const dir = tmpDir(t);
  const client = { name: "bob", rpc: async () => ({}) };
  const logs = [];
  fs.mkdirSync(path.join(dir, "incoming", "t_0123456789abcdef01234567"), { recursive: true });
  fs.writeFileSync(path.join(dir, "incoming", "ledger.json"), JSON.stringify({ v: 1, entries: [] }));
  // An upload interrupted while encrypting, in the outbox: its recovery is apart from staging.
  const out = path.join(dir, "outgoing", "o_0123456789abcdef01234567");
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, "state.json"), JSON.stringify({ v: 1, transfer_id: "ab".repeat(16), phase: "encrypting" }));
  const st = sessionTransfers({ home: dir, relay: client, engine: () => null, contacts: null, log: (x) => logs.push(x), now: w.clock.now });
  t.after(() => st.close());
  await st.ready();
  assert.ok(logs.some((x) => /staging ledger could not be reconciled/.test(x)));
  assert.ok(logs.some((x) => /an interrupted upload was abandoned/.test(x)), "the outbox is recovered all the same");
  assert.equal(fs.existsSync(out), false);
  assert.ok(fs.existsSync(path.join(dir, "incoming", "t_0123456789abcdef01234567")), "the folder stays");
  fs.writeFileSync(path.join(dir, "incoming", "ledger.json"), JSON.stringify({ v: 1, entries: {} }));
  await st.ready();
  assert.equal(fs.existsSync(path.join(dir, "incoming", "t_0123456789abcdef01234567")), false, "reconciled once the ledger reads again");
});

test("TR5: expiry in the middle of a download ends it with the sender's expiry time", async (t) => {
  const { w, alice, bob } = await pair(t, { bob: { autoFetch: false } });
  await sendFile(alice, "alice", bob, pattern(8 * CHUNK_SIZE));
  await until(() => entries(bob).length === 1, "reserved");
  const [e] = entries(bob);
  // The relay's clock passes relay_expires once chunk 0 is written; the requests after it are refused.
  const s1 = restart(bob, w, { fault: (p, _t, i) => { if (p === "after-chunk-write" && i === 0) w.clock.set(e.relay_expires); } });
  const r = await s1.fetch(e.t, (f) => bob.s.bob.client.rpc(f));
  assert.deepEqual(r, { state: "failed", reason: `the sender's file expired at the relay on ${new Date(e.relay_expires).toISOString()}` });
  assert.equal(entries(bob)[0].state, "removed");
});

test("TR5: a recipient cancelling affects only its own device: the blob stays for the others", async (t) => {
  const w = await transferRelay(t);
  const alice = await device(t, w, "alice");
  const bob = await device(t, w, "bob", { autoFetch: false });
  const bob2 = await device(t, w, "bob", { sessions: ["bob-other"] });
  await acceptOwnDevices(bob, bob2); // bob's owner accepted his second device (A1)
  allowTransfers(bob.contacts, w.realm, alice.id);
  // alice's conversation with bob holds both of bob's devices.
  assert.equal((await sendFile(alice, "alice", bob, pattern(2 * CHUNK_SIZE))).state, "accepted");
  await until(() => entries(bob).length === 1, "reserved");
  const [e] = entries(bob);
  assert.equal((await bob.staging.cancel(e.t)).state, "removed");
  assert.equal(entries(bob)[0].state, "removed");
  const tr = w.db.get("SELECT state FROM transfers WHERE transfer_id = ?", e.key.transfer_id);
  assert.equal(tr.state, "sealed", "the relay's blob is untouched");
  const c = await bob2.s["bob-other"].client.rpc({ type: "download", uploader_device: e.key.uploader_device, transfer_id: e.key.transfer_id, from_index: 0 });
  assert.equal(c.index, 0, "another recipient device still downloads");
});

test("TR5: a disconnect after the last byte and a client crash before staging is complete: the download resumes and the blob is still there", async (t) => {
  const { w, alice, bob } = await pair(t);
  const rpc = bob.s.bob.client.rpc.bind(bob.s.bob.client);
  let cut = true;
  bob.s.bob.client.rpc = async (f) => {
    const r = await rpc(f);
    if (f.type === "download" && f.from_index === 2 && cut) {
      cut = false;
      throw Object.assign(new Error("connection lost"), { code: "no_answer" });
    }
    return r;
  };
  const bytes = pattern(3 * CHUNK_SIZE - 1);
  await sendFile(alice, "alice", bob, bytes);
  const [r] = await until(() => (bob.fetches.length ? Promise.all(bob.fetches) : null), "the fetch");
  assert.equal(r.state, "waiting", "resumed later");
  const [e] = entries(bob);
  assert.equal(e.state, "reserved");
  const s1 = restart(bob, w);
  assert.deepEqual(s1.pending(), [e.t]);
  assert.equal((await s1.fetch(e.t, (f) => bob.s.bob.client.rpc(f))).state, "staged");
  assert.equal(sha(bob.staged.at(-1).bytes), sha(bytes));
  assert.equal(w.db.get("SELECT state FROM transfers WHERE transfer_id = ?", e.key.transfer_id).state, "sealed", "the blob is still there");
});

test("TR8: two transfers with the same display name and the same id from two uploaders stay independent at the recipient, and each saves its own bytes", async (t) => {
  const w = await transferRelay(t);
  const same = Buffer.from("c0".repeat(16), "hex");
  const alice = await device(t, w, "alice", { outboxOpts: { newId: () => same } });
  const carol = await device(t, w, "carol", { outboxOpts: { newId: () => same } });
  const bob = await device(t, w, "bob");
  allowTransfers(bob.contacts, w.realm, alice.id);
  allowTransfers(bob.contacts, w.realm, carol.id);
  await sendFile(alice, "alice", bob, pattern(500, 1), { name: "same.txt" });
  await sendFile(carol, "carol", bob, pattern(700, 2), { name: "same.txt" });
  await until(() => bob.staged.length === 2, "two staged");
  const list = entries(bob);
  assert.equal(new Set(list.map((e) => e.t)).size, 2, "two local ids");
  assert.deepEqual(list.map((e) => e.bytes).sort(), [500, 700]);
  assert.equal(new Set(list.map((e) => path.join(incomingDir(bob.dir), e.t))).size, 2, "locally generated folders, never the name");
  assert.deepEqual(list.map((e) => e.key.transfer_id), [same.toString("hex"), same.toString("hex")], "the same transfer_id from both");
  const out = tmpDir(t);
  for (const e of list) {
    const r = await saveTransfer({ home: bob.dir, staging: bob.staging, t: e.t, destination: path.join(out, `${e.from.session}.bin`) });
    assert.equal(r.state, "saved");
  }
  assert.equal(sha(fs.readFileSync(path.join(out, "alice.bin"))), sha(pattern(500, 1)));
  assert.equal(sha(fs.readFileSync(path.join(out, "carol.bin"))), sha(pattern(700, 2)));
});

test("contacts: the transfers entry is validated, defaults to not allowed, and survives every other contacts change", async (t) => {
  const R = "a".repeat(32);
  const M = `m_${"b".repeat(26)}`;
  const base = { version: 1, revision: 0, default: "ask", grants: [], blocks: [] };
  assert.deepEqual(transferPolicy(base, R, M), { allowed: false, maxBytes: 200 * 1024 * 1024 }, "the default: not allowed");
  assert.deepEqual(transferCaps(base), { stagedBytes: 2 * 1024 ** 3, stagedFiles: 20, concurrent: 2 });
  const transfers = { contacts: [{ realm: R, member: M, allowed: true, maxBytes: 1000 }], stagedBytes: 5000, stagedFiles: 3, concurrent: 1 };
  assert.deepEqual(validateContacts({ ...base, transfers }), []);
  assert.match(validateContacts({ ...base, transfers: { contacts: [{ realm: R, member: M, allowed: "yes" }] } })[0], /allowed must be true or false/);
  assert.match(validateContacts({ ...base, transfers: { contacts: [{ realm: R, member: M, allowed: true, maxBytes: 300 * 1024 * 1024 }] } })[0], /maxBytes/);
  assert.match(validateContacts({ ...base, transfers: { contacts: [{ realm: R, member: M, allowed: true }, { realm: R, member: M, allowed: false }] } })[0], /listed twice/);
  assert.match(validateContacts({ ...base, transfers: { other: 1 } })[0], /transfers must be/);
  // Every writer of contacts.json edits the whole document: the owner's transfer settings stay.
  const home = tmpDir(t);
  fs.writeFileSync(contactsFile(home), JSON.stringify({ ...base, transfers }), { mode: 0o600 });
  const c = await openContacts(home, { notify: false });
  await c.setEncryption({ realm: R, member: M, mode: "preferred" });
  await c.updatePins((doc) => void (doc.requireVerified = [R]));
  const after = readContacts(contactsFile(home)).doc;
  assert.deepEqual(after.transfers, transfers);
  assert.deepEqual(transferPolicy(after, R, M), { allowed: true, maxBytes: 1000 });
  assert.equal(after.revision, 2);
});
