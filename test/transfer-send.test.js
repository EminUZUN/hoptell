// The sender's side of a larger transfer (design 6, "Sender side: encrypt once, then send stored
// bytes", TR1), end to end with a real relay and real clients: capture once, encrypt every chunk
// once, upload only stored bytes, resume after restarts at each phase, and never encrypt twice.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createAccess } from "../lib/access.js";
import { createOutbox, outgoingDir } from "../lib/transferout.js";
import { CHUNK_SIZE } from "../lib/transferwire.js";
import { allowTransfers, captureOf, device, pattern, sendFile, settle, sha, transferRelay, until } from "./transfer-helpers.js";
import { tmpDir } from "./mls-helpers.js";

/** alice and bob; bob allows transfers from alice. */
async function pair(t, opts = {}) {
  const w = await transferRelay(t, opts.relay);
  const alice = await device(t, w, "alice", opts.alice);
  const bob = await device(t, w, "bob", opts.bob);
  allowTransfers(bob.contacts, w.realm, alice.id);
  return { w, alice, bob };
}
const staged = async (bob, n = 1) => until(() => (bob.staged.length >= n ? bob.staged : null), "a staged transfer");
const crash = (point, when = () => true) => (p, ...a) => {
  if (p === point && when(...a)) throw Object.assign(new Error(`crash at ${p}`), { code: "EFAULT" });
};
const folders = (home) => (fs.existsSync(outgoingDir(home)) ? fs.readdirSync(outgoingDir(home)).filter((n) => n.startsWith("o_")) : []);

test("a file transfer end to end: encrypted chunks at the relay, the descriptor in the message, staged and verified at the recipient; the outbox is gone", async (t) => {
  const { w, alice, bob } = await pair(t);
  const bytes = pattern(2 * CHUNK_SIZE + 1000);
  const r = await sendFile(alice, "alice", bob, bytes, { name: "data.bin" });
  assert.equal(r.state, "accepted");
  assert.match(r.transfer_id, /^[0-9a-f]{32}$/);
  const [s] = await staged(bob);
  assert.equal(sha(s.bytes), sha(bytes));
  assert.deepEqual([s.e.state, s.e.bytes, s.e.name, s.e.kind, s.e.from.member], ["staged", bytes.length, "data.bin", "file", alice.id]);
  // The agent sees a fixed text: who, the size, the label; never the key or a path.
  const [m] = await until(() => (bob.s.bob.got.length ? bob.s.bob.got : null), "the message");
  assert.match(m.text, /a file transfer from alice \(525288 bytes, label "data\.bin"\) is waiting for your user/);
  assert.equal(m.text.includes(r.transfer_id), false);
  assert.deepEqual(folders(alice.dir), [], "the outbox folder is deleted once the message is accepted");
  // The relay holds ciphertext only.
  const stored = Buffer.concat(w.db.all("SELECT data FROM transfer_chunks ORDER BY idx").map((x) => Buffer.from(x.data)));
  assert.equal(stored.includes(bytes.subarray(0, 64)), false);
});

test("TR1: a lost stored answer, then a resend of the same bytes; the relay answers it as stored", async (t) => {
  let dropped = 0;
  const { alice, bob } = await pair(t);
  const rpc = alice.s.alice.client.rpc.bind(alice.s.alice.client);
  const sent = [];
  alice.s.alice.client.rpc = async (f) => {
    const r = await rpc(f);
    if (f.type === "upload_chunk") sent.push([f.index, sha(Buffer.from(f.data, "base64"))]);
    if (f.type === "upload_chunk" && f.index === 1 && !dropped++) throw Object.assign(new Error("lost"), { code: "no_answer" });
    return r;
  };
  const bytes = pattern(3 * CHUNK_SIZE);
  assert.equal((await sendFile(alice, "alice", bob, bytes)).state, "accepted");
  const ones = sent.filter(([i]) => i === 1);
  assert.equal(ones.length, 2, "chunk 1 was sent again");
  assert.equal(ones[0][1], ones[1][1], "with the same bytes");
  assert.equal(sha((await staged(bob))[0].bytes), sha(bytes));
});

test("TR1: a restart after the encrypting phase abandons the transfer; the next send has a new id and key", async (t) => {
  const { w, alice, bob } = await pair(t, { alice: { outboxOpts: { fault: crash("after-encrypting") } } });
  const bytes = pattern(1000);
  await assert.rejects(sendFile(alice, "alice", bob, bytes), /crash at after-encrypting/);
  const [dir] = folders(alice.dir);
  const old = JSON.parse(fs.readFileSync(path.join(outgoingDir(alice.dir), dir, "state.json"), "utf8"));
  assert.equal(old.phase, "encrypting");
  const s2 = await alice.open("alice-2"); // a new session: an outbox without the fault
  s2.outbox = createOutbox({ home: alice.dir, rpc: (f) => s2.client.rpc(f), device: () => alice.device, now: w.clock.now });
  const r = await sendFile(alice, "alice-2", bob, bytes);
  assert.equal(r.state, "accepted");
  assert.notEqual(r.transfer_id, old.transfer_id, "a fresh transfer id");
  assert.deepEqual(folders(alice.dir), [], "the interrupted entry was abandoned (deleted)");
  assert.equal(w.db.get("SELECT count(*) AS n FROM transfers WHERE transfer_id = ?", old.transfer_id).n, 0, "never begun at the relay");
  assert.equal(sha((await staged(bob))[0].bytes), sha(bytes));
});

test("TR1: restarts after encrypted, mid-upload, and after commit before publication resume the same transfer without encrypting again", async (t) => {
  for (const [point, when] of [["after-encrypted", () => true], ["upload-chunks", (_st, n) => n >= 4], ["after-commit", () => true]]) {
    const counts = new Map();
    const { w, alice, bob } = await pair(t, { alice: { outboxOpts: { fault: crash(point, when), onEncrypt: (i) => counts.set(i, (counts.get(i) ?? 0) + 1) } } });
    const bytes = pattern(6 * CHUNK_SIZE + 7, 3);
    await assert.rejects(sendFile(alice, "alice", bob, bytes), new RegExp(`crash at ${point}`));
    const [dir] = folders(alice.dir);
    const st = JSON.parse(fs.readFileSync(path.join(outgoingDir(alice.dir), dir, "state.json"), "utf8"));
    // The restart: the same home's outbox in a new session finishes it.
    const s2 = await alice.open(`alice-r-${point}`);
    s2.outbox = createOutbox({ home: alice.dir, rpc: (f) => s2.client.rpc(f), device: () => alice.device, now: w.clock.now, onEncrypt: (i) => counts.set(i, (counts.get(i) ?? 0) + 1) });
    const out = await s2.outbox.recover({ publish: (descriptor, blobs) => s2.e2ee.send({ to: { member: bob.id, session: "bob" }, kind: "file", body: { transfer: descriptor }, blobs }) });
    assert.equal(out.length, 1, point);
    assert.deepEqual([out[0].state, out[0].transfer_id], ["accepted", st.transfer_id], `${point}: the same transfer`);
    assert.ok([...counts.values()].every((n) => n === 1), `${point}: each index encrypted exactly once`);
    assert.equal(counts.size, 7);
    assert.equal(sha((await staged(bob))[0].bytes), sha(bytes), point);
    assert.deepEqual(folders(alice.dir), []);
  }
});

test("TR1: the source changing after capture has no effect on what is sent", async (t) => {
  const { alice, bob } = await pair(t);
  const file = path.join(alice.dir, "source.txt");
  fs.writeFileSync(file, "the captured version\n".repeat(1000));
  const captured = fs.readFileSync(file);
  let captures = 0;
  const r = await sendFile(alice, "alice", bob, null, {
    capture: async (fd) => {
      captures++;
      const c = await captureOf(fs.readFileSync(file))(fd);
      fs.writeFileSync(file, "changed afterwards\n"); // the source changes once captured
      return c;
    },
  });
  assert.equal(r.state, "accepted");
  assert.equal(captures, 1, "read once");
  assert.equal(sha((await staged(bob))[0].bytes), sha(captured), "the captured bytes, not the changed file");
});

test("TR1: a relay falsely reporting an index missing gets the same stored bytes again; nothing is encrypted again (encryptions counted per index)", async (t) => {
  const counts = new Map();
  const { alice, bob } = await pair(t, { alice: { outboxOpts: { onEncrypt: (i) => counts.set(i, (counts.get(i) ?? 0) + 1) } } });
  const rpc = alice.s.alice.client.rpc.bind(alice.s.alice.client);
  let lied = false;
  const resent = [];
  const first = new Map();
  alice.s.alice.client.rpc = async (f) => {
    if (f.type === "upload_chunk") {
      if (first.has(f.index)) resent.push([f.index, f.data === first.get(f.index)]);
      else first.set(f.index, f.data);
    }
    if (f.type === "upload_commit" && !lied) {
      lied = true;
      throw Object.assign(new Error("incomplete"), { kind: "relay_error", code: "incomplete", missing: [0, 2] });
    }
    return rpc(f);
  };
  const bytes = pattern(3 * CHUNK_SIZE - 5);
  assert.equal((await sendFile(alice, "alice", bob, bytes)).state, "accepted");
  assert.deepEqual(resent, [[0, true], [2, true]], "the same bytes, for exactly the reported indexes");
  assert.deepEqual([...counts.entries()].sort(), [[0, 1], [1, 1], [2, 1]], "one encryption per index");
  assert.equal(sha((await staged(bob))[0].bytes), sha(bytes));
});

test("TR1: a damaged ciphertext (digest mismatch) abandons the transfer with upload_abort; the key is never used again", async (t) => {
  const { w, alice, bob } = await pair(t, { alice: { outboxOpts: { fault: crash("after-encrypted") } } });
  await assert.rejects(sendFile(alice, "alice", bob, pattern(2 * CHUNK_SIZE)), /crash/);
  const [dir] = folders(alice.dir);
  const full = path.join(outgoingDir(alice.dir), dir);
  const st = JSON.parse(fs.readFileSync(path.join(full, "state.json"), "utf8"));
  // Damage the stored ciphertext of chunk 1.
  const fd = fs.openSync(path.join(full, "ciphertext"), "r+");
  fs.writeSync(fd, Buffer.from([0xff]), 0, 1, CHUNK_SIZE + 16 + 5);
  fs.closeSync(fd);
  const s2 = await alice.open("alice-d");
  s2.outbox = createOutbox({ home: alice.dir, rpc: (f) => s2.client.rpc(f), device: () => alice.device, now: w.clock.now });
  // Pretend upload_begin went out before the crash: an abandoned transfer is aborted at the relay.
  await s2.client.rpc({ type: "upload_begin", transfer_id: st.transfer_id, total_bytes: 2 * CHUNK_SIZE, chunk_count: 2, header_digest: "0".repeat(64) });
  fs.writeFileSync(path.join(full, "state.json"), JSON.stringify({ ...st, begin_sent: true }));
  const out = await s2.outbox.recover({ publish: () => assert.fail("never published") });
  assert.equal(out[0].state, "abandoned");
  assert.deepEqual(folders(alice.dir), []);
  await settle();
  const row = w.db.get("SELECT state FROM transfers WHERE transfer_id = ?", st.transfer_id);
  assert.equal(row?.state, "aborted", "the begun upload was aborted at the relay");
  assert.equal(bob.staged.length, 0);
});

// ---- A8 (amendments 3.5 v4.1, N11): the relay's upload policy is live ------------------------

/** A relay whose upload verdict the test sets ("allow": the policy decides; "deny"; "retry": a stale view). */
function policyRelay(t) {
  const ctl = { mode: "allow" };
  ctl.access = () => {
    const a = createAccess({ stateDir: tmpDir(t), policy: null });
    return new Proxy(a, { get: (o, k) => (k === "mayUpload" ? (from) => (ctl.mode === "allow" ? o.mayUpload(from) : ctl.mode) : o[k]) });
  };
  return ctl;
}
/** Run `after(frame)` once each frame `pred` matches has been answered. */
function onAnswered(client, pred, after) {
  const rpc = client.rpc.bind(client);
  const types = [];
  client.rpc = async (f) => {
    types.push(f.type);
    const r = await rpc(f);
    if (pred(f)) after(f);
    return r;
  };
  return types;
}

test("A8: a deny during the upload ends the outbox entry as refused: the relay transfer is aborted (denied) and the ciphertext deleted", async (t) => {
  const ctl = policyRelay(t);
  const { w, alice, bob } = await pair(t, { relay: { access: ctl.access } });
  const types = onAnswered(alice.s.alice.client, (f) => f.type === "upload_chunk" && f.index === 0, () => (ctl.mode = "deny"));
  await assert.rejects(sendFile(alice, "alice", bob, pattern(6 * CHUNK_SIZE)), (e) => e.code === "refused" && /relay's policy refused the upload/.test(e.message));
  assert.deepEqual(folders(alice.dir), [], "the outbox folder (and its ciphertext) is deleted");
  assert.ok(types.includes("upload_abort"), "the relay transfer is aborted");
  assert.equal(w.db.get("SELECT denied FROM transfers").denied, 1);
  await settle();
  assert.equal(bob.staged.length + bob.s.bob.got.length, 0, "nothing reached bob");
});

test("A8: a deny at the publication after the seal ends the outbox entry as refused, with no message accepted", async (t) => {
  const ctl = policyRelay(t);
  const { w, alice, bob } = await pair(t, { relay: { access: ctl.access } });
  onAnswered(alice.s.alice.client, (f) => f.type === "upload_commit", () => (ctl.mode = "deny"));
  await assert.rejects(sendFile(alice, "alice", bob, pattern(1000)), (e) => e.code === "refused" && /relay's policy refused the upload/.test(e.message));
  assert.deepEqual(folders(alice.dir), []);
  assert.equal(w.db.get("SELECT denied FROM transfers").denied, 1);
  assert.equal(w.db.get("SELECT count(*) AS n FROM e2ee_ops WHERE kind = 'app'").n, 0, "no message op accepted");
});

test("A8: a stale view pauses the upload (unavailable, waited out with backoff); it resumes when the view is fresh", async (t) => {
  const ctl = policyRelay(t);
  const { alice, bob } = await pair(t, { relay: { access: ctl.access }, alice: { outboxOpts: { sleep: () => settle(5) } } });
  ctl.mode = "retry";
  let paused = 0;
  const rpc = alice.s.alice.client.rpc.bind(alice.s.alice.client);
  alice.s.alice.client.rpc = async (f) => {
    try {
      return await rpc(f);
    } catch (e) {
      if (e.code === "unavailable" && ++paused >= 8) ctl.mode = "allow";
      throw e;
    }
  };
  const bytes = pattern(2 * CHUNK_SIZE);
  assert.equal((await sendFile(alice, "alice", bob, bytes)).state, "accepted");
  assert.ok(paused >= 8, "it was paused");
  assert.equal(sha((await staged(bob))[0].bytes), sha(bytes));
});
