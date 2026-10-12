// Review sets over a transfer (design 6, "Review sets over a transfer (5.1)"): a set larger than
// one frame sends its manifest in the encrypted message and its contents (RFC 8785 JSON) as a
// transfer; the receiver reconstructs the contents from the verified plaintext, checks them
// against the manifest and delivers a review set message; no transfers opt-in is needed, the
// 8 MiB limit is checked from the authenticated descriptor before any fetch, and a set whose
// manifest and contents disagree is refused. Also the tools' choice of transport (send_review_set,
// send_transfer) with a stand-in for the session's transfers.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { canonicalize } from "../lib/jcs.js";
import { createE2ee } from "../lib/mls/e2ee.js";
import { deviceStore } from "../lib/mls/device.js";
import { buildSet, checkReceivedSet, setMessage } from "../lib/reviewsets.js";
import { supported } from "../lib/files.js";
import { MAX_REVIEW_SET_TRANSFER } from "../lib/transferin.js";
import { reviewSetContents, sessionTransfers } from "../lib/transfers.js";
import { createFakeDriver } from "./fake-mls-driver.js";
import { memoryContacts, ownFor, tmpDir } from "./mls-helpers.js";
import { machine } from "./reviewfix.js";
import { settle, transferRelay, until } from "./transfer-helpers.js";

/** A device whose session runs the session-level transfers (lib/transfers.js), as the engine does. */
async function sessionDevice(t, w, member, { session = member, deliver = null, retryMs } = {}) {
  const dir = tmpDir(t);
  const driver = createFakeDriver({ seed: `${member}-${dir}`, now: w.clock.now });
  const contacts = memoryContacts();
  const store = deviceStore({ home: dir, profile: "relay-test", driver, store: "file", passphrase: "correct horse battery staple", keychainBackend: null, machine: "m", now: w.clock.now, own: ownFor(contacts, dir, "relay-test") });
  contacts.doc.encryption = [{ realm: w.realm, mode: "preferred" }];
  await store.enroll(await w.client(member));
  const client = await w.client(member, { session });
  const got = [];
  const d = { dir, id: w.members[member].id, client, got, contacts };
  d.make = (o = {}) => sessionTransfers({ home: dir, relay: client, engine: () => d.e2ee, contacts, deliver: deliver ?? (async (m) => void got.push(m)), now: w.clock.now, retryMs, ...o });
  d.transfers = d.make();
  t.after(() => d.transfers.close());
  d.e2ee = createE2ee({ store, driver, client, session, home: dir, profile: "relay-test", contacts, deliver: async (m) => void got.push(m), onTransfer: (x) => d.transfers.intake(x), now: w.clock.now });
  await d.e2ee.attach();
  return d;
}

/** A review set of `n` files of `size` bytes each (UTF-8 text), built as send_review_set builds it. */
function bigSet(n, size) {
  const captured = Array.from({ length: n }, (_, i) => ({ root_id: "app", path: `src/file${i}.txt`, bytes: Buffer.from(`${i}`.repeat(size).slice(0, size)) }));
  const set = buildSet(captured, { request: "review these please" });
  return { set, manifest: JSON.parse(setMessage(set)).manifest };
}
const reviewMessage = (bob) => until(() => bob.got.find((m) => m.id?.startsWith("transfer-")), "the review set message");

test("a review set larger than one frame goes as a transfer: manifest in the message, contents as the transfer; the receiver checks and delivers it, with no transfers opt-in", async (t) => {
  const w = await transferRelay(t);
  const alice = await sessionDevice(t, w, "alice");
  const bob = await sessionDevice(t, w, "bob");
  const { set, manifest } = bigSet(3, 300_000); // 900 KB: more than one frame
  const contents = reviewSetContents(set);
  assert.equal(contents.toString("utf8"), canonicalize(set.contents));
  const r = await alice.transfers.sendReviewSet({ to: { member: bob.id, session: "bob" }, reviewSet: { review_set_id: set.review_set_id, manifest }, contents });
  assert.equal(r.state, "accepted");
  const notice = await until(() => bob.got.find((m) => /review set sent as a file transfer/.test(m.text)), "the notice");
  assert.match(notice.text, /is being fetched as t_/, "fetched although bob allows no file transfers");
  const m = await reviewMessage(bob);
  const check = checkReceivedSet(m.text);
  assert.equal(check.ok, true);
  assert.equal(check.review_set_id, set.review_set_id);
  assert.equal(check.bundle_digest, set.bundle_digest, "review_set_id and bundle_digest unchanged");
  assert.deepEqual([m.from, m.to, m.sender.member.id, m.e2ee.device], ["alice", "bob", alice.id, alice.e2ee.device()]);
  await until(() => bob.transfers.staging.list().every((e) => e.state === "removed"), "the staging copy removed");
});

test("a staged review set whose hand-over fails is kept staged and handed on at the next start, with its stable delivery id: exactly one review-set intake", async (t) => {
  const w = await transferRelay(t);
  const alice = await sessionDevice(t, w, "alice");
  const intakes = [];
  let failures = 1;
  const deliver = async (m) => {
    if (m.id?.startsWith("transfer-") && failures-- > 0) throw new Error("the session did not store it");
    intakes.push(m);
  };
  const bob = await sessionDevice(t, w, "bob", { deliver, retryMs: 3_600_000 });
  const { set, manifest } = bigSet(2, 300_000);
  await alice.transfers.sendReviewSet({ to: { member: bob.id, session: "bob" }, reviewSet: { review_set_id: set.review_set_id, manifest }, contents: reviewSetContents(set) });
  const [e] = await until(() => (bob.transfers.staging.list().some((x) => x.state === "staged") ? bob.transfers.staging.list() : null), "staged");
  await until(async () => failures === 0 && (await Promise.all(bob.transfers.handing())).length === 0, "the failed hand-over");
  await settle(50);
  assert.equal(intakes.filter((m) => m.id?.startsWith("transfer-")).length, 0, "not delivered");
  assert.equal(bob.transfers.staging.list()[0].state, "staged", "still staged, not swept or removed");
  assert.ok(fs.existsSync(bob.transfers.staging.dataFile(e.t)), "the staging copy stays until a confirmed hand-over");
  // A restart: a new session's transfers on the same home, at its attachment.
  bob.transfers.close();
  bob.transfers = bob.make();
  await bob.transfers.ready();
  await until(() => bob.transfers.staging.list()[0].state === "removed", "handed on and removed");
  const got = intakes.filter((m) => m.id?.startsWith("transfer-"));
  assert.equal(got.length, 1, "exactly one review-set intake");
  assert.equal(got[0].id, `transfer-${e.t}`, "the stable delivery id");
  assert.equal(checkReceivedSet(got[0].text).ok, true);
  assert.equal(fs.existsSync(bob.transfers.staging.dataFile(e.t)), false);
  // Another start hands nothing on again.
  bob.transfers.close();
  bob.transfers = bob.make();
  await bob.transfers.ready();
  await settle(100);
  assert.equal(intakes.filter((m) => m.id?.startsWith("transfer-")).length, 1);
});

test("a staged review set whose hand-over fails for a moment is retried in the same session with the same delivery id", async (t) => {
  const w = await transferRelay(t);
  const alice = await sessionDevice(t, w, "alice");
  const intakes = [];
  let failures = 2;
  const deliver = async (m) => {
    if (m.id?.startsWith("transfer-") && failures-- > 0) throw new Error("the session did not store it");
    intakes.push(m);
  };
  const bob = await sessionDevice(t, w, "bob", { deliver, retryMs: 40 });
  const { set, manifest } = bigSet(2, 300_000);
  await alice.transfers.sendReviewSet({ to: { member: bob.id, session: "bob" }, reviewSet: { review_set_id: set.review_set_id, manifest }, contents: reviewSetContents(set) });
  await until(() => bob.transfers.staging.list()[0]?.state === "removed", "handed on after the retries");
  const got = intakes.filter((m) => m.id?.startsWith("transfer-"));
  assert.equal(got.length, 1);
  assert.equal(failures, -1, "two failures, then one delivery");
  assert.equal(got[0].id, `transfer-${bob.transfers.staging.list()[0].t}`);
});

test("a review set whose manifest and contents disagree is refused: nothing of it is delivered", async (t) => {
  const w = await transferRelay(t);
  const alice = await sessionDevice(t, w, "alice");
  const bob = await sessionDevice(t, w, "bob");
  const { set, manifest } = bigSet(2, 400_000);
  const forged = { ...set.contents, f1: { encoding: "utf8", text: `${set.contents.f1.text}x` } };
  await alice.transfers.sendReviewSet({ to: { member: bob.id, session: "bob" }, reviewSet: { review_set_id: set.review_set_id, manifest }, contents: Buffer.from(canonicalize(forged)) });
  const m = await reviewMessage(bob);
  assert.match(m.text, /was refused: its contents do not match its manifest/);
  assert.equal(m.text.includes(set.contents.f2.text.slice(0, 100)), false, "no content shown");
  const [e] = await until(() => (bob.transfers.staging.list().every((x) => x.state === "removed") ? bob.transfers.staging.list() : null), "removed");
  assert.equal(e.error, "its contents do not match its manifest");
});

test("a review set whose descriptor declares more than 8 MiB is refused before any fetch", async (t) => {
  const w = await transferRelay(t);
  const alice = await sessionDevice(t, w, "alice");
  const bob = await sessionDevice(t, w, "bob");
  const rpc = bob.client.rpc.bind(bob.client);
  let downloads = 0;
  bob.client.rpc = (f) => (f.type === "download" && downloads++, rpc(f));
  const { set, manifest } = bigSet(1, 10);
  const contents = Buffer.alloc(MAX_REVIEW_SET_TRANSFER + 1, 0x61);
  await alice.transfers.sendReviewSet({ to: { member: bob.id, session: "bob" }, reviewSet: { review_set_id: set.review_set_id, manifest }, contents });
  const notice = await until(() => bob.got.find((m) => /review set sent as a file transfer/.test(m.text)), "the notice");
  assert.match(notice.text, /not fetched: a review set sent as a transfer has at most 8388608 bytes/);
  await settle(200);
  assert.equal(downloads, 0);
  assert.deepEqual(bob.transfers.staging.list(), [], "nothing reserved");
});

const skip = !supported() && "file tools need macOS or Linux";

test("send_review_set: inline when it fits one frame; as a transfer when larger and encrypted messaging reaches the peer (8 MiB), recorded for that member", { skip }, async (t) => {
  const calls = [];
  const via = { member: "m_bbbbbbbbbbbbbbbbbbbbbbbbbb", sendReviewSet: async (a) => (calls.push(a), { state: "accepted", message_id: crypto.randomUUID(), transfer_id: "a".repeat(32), relay_expires: Date.now() + 7 * 86_400_000 }) };
  const files = Object.fromEntries(Array.from({ length: 3 }, (_, i) => [`big${i}.txt`, "y".repeat(300_000)]));
  const m = machine(t, { app: { "small.txt": "hello\n", ...files } }, { transfers: { to: async () => via, why: () => "" } });
  const small = await m.call("send_review_set", { to: "bob", files: [{ root: "app", path: "small.txt" }], request: "look" });
  assert.equal(small.state, "accepted");
  assert.equal(m.sent.length, 1, "inline, through the relay as before");
  assert.equal(calls.length, 0);
  const big = await m.call("send_review_set", { to: "bob", files: Object.keys(files).map((p) => ({ root: "app", path: p })), request: "look" });
  assert.equal(big.state, "accepted");
  assert.equal(big.transport, "transfer");
  assert.equal(m.sent.length, 1, "not inline");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].reviewSet.review_set_id, big.review_set_id);
  assert.deepEqual(Object.keys(calls[0].reviewSet.manifest).sort(), ["files", "request"]);
  assert.equal(calls[0].contents.length > 512 * 1024, true);
  assert.deepEqual(m.store.read(big.review_set_id).recipient, { realm: "0123456789abcdef0123456789abcdef", member: via.member, auth: "member", name: "bob" });
  // Required encryption: a set that fits one frame goes as a transfer too (never plaintext).
  const req = await m.call("send_review_set", { to: "bob", files: [{ root: "app", path: "small.txt" }], request: "look" }, { encryptedOnly: true });
  assert.equal(req.transport, "transfer");
  assert.equal(m.sent.length, 1);
});

test("send_review_set: larger than one frame without a transfer route is refused as before", { skip }, async (t) => {
  const files = Object.fromEntries(Array.from({ length: 2 }, (_, i) => [`big${i}.txt`, "y".repeat(300_000)]));
  const m = machine(t, { app: files }, { transfers: { to: async () => null, why: () => "no route" } });
  const r = await m.call("send_review_set", { to: "bob", files: Object.keys(files).map((p) => ({ root: "app", path: p })), request: "look" });
  assert.equal(r.state, "error");
  assert.equal(r.error_code, "too_large");
});

test("send_transfer: captures the file once through the guarded reader; refused when no encrypted route exists", { skip }, async (t) => {
  const sent = [];
  const fs = await import("node:fs");
  const via = {
    member: "m_bbbbbbbbbbbbbbbbbbbbbbbbbb",
    sendFile: async ({ capture, name, mediaType }) => {
      const tmp = tmpDir(t);
      const fd = fs.openSync(`${tmp}/cap`, "wx", 0o600);
      const c = await capture(fd);
      fs.closeSync(fd);
      sent.push({ name, mediaType, c, bytes: fs.readFileSync(`${tmp}/cap`) });
      return { state: "accepted", transfer_id: "b".repeat(32), message_id: crypto.randomUUID(), relay_expires: Date.now() + 1000 };
    },
  };
  const binary = crypto.randomBytes(70_000);
  let route = via;
  const m = machine(t, { app: { "data.bin": binary } }, { transfers: { to: async () => route, why: () => "this relay does not store transfers" } });
  assert.ok(m.tools.tools.some((x) => x.name === "send_transfer"));
  const r = await m.call("send_transfer", { to: "bob", root_id: "app", path: "data.bin" });
  assert.equal(r.state, "accepted");
  assert.equal(sent.length, 1);
  assert.deepEqual([sent[0].name, sent[0].c.bytes], ["data.bin", 70_000]);
  assert.ok(sent[0].bytes.equals(binary), "binary content, read once into the capture");
  assert.equal(sent[0].c.sha256, crypto.createHash("sha256").update(binary).digest("hex"));
  assert.equal((await m.call("send_transfer", { to: "bob", root_id: "app", path: "../x" })).error_code, "path_unsafe");
  route = null;
  const no = await m.call("send_transfer", { to: "bob", root_id: "app", path: "data.bin" });
  assert.deepEqual([no.state, no.error_code], ["error", "not_available"]);
  assert.match(no.message, /this relay does not store transfers/);
  // Without the experimental route the tool is not offered at all.
  const plain = machine(t, { app: { "a.txt": "x" } });
  assert.equal(plain.tools.tools.some((x) => x.name === "send_transfer"), false);
});
