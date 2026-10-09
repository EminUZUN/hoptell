// Review sets (design 5.1): capture, the manifest and its digest, limits, local records,
// verify_review_set, the reviewer's check, and proposals validated before they are stored.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { supported } from "../lib/files.js";
import { canonicalize } from "../lib/jcs.js";
import { MAX_PROPOSALS_PER_SET, MAX_PROPOSALS_TOTAL, ReviewSetStore, bundleDigest, checkPatch, checkProposal, checkReceivedSet, intakeMessage, parseProposal, proposalNote, recipientMatches } from "../lib/reviewsets.js";
import { closeRoots, openApprovedRoots, prepare } from "../lib/apply.js";
import { MAX_TEXT, startRelay } from "../lib/relay.js";
import { RelayClient } from "../lib/client.js";
import { TOKEN, fakeToken } from "./helpers.js";
import { REALM, fromAlex, git, lineDiff, machine, proposal, receive, wholeDiff } from "./reviewfix.js";

const skip = !supported() && "file tools need macOS or Linux";
const sha = (b) => `sha256:${crypto.createHash("sha256").update(b).digest("hex")}`;
const wire = (m) => JSON.parse(m.sent.at(-1).text);
const u = (h) => `\\u${h}`; // a JSON escape written without a literal escape in this source

// ---- RFC 8785 ----------------------------------------------------------------------------------

test("JCS: the RFC 8785 example and its number and string rules", () => {
  // RFC 8785, section 3.2.2 (input) and 3.2.3 (canonical output).
  const input = `{"numbers":[333333333.33333329,1E30,4.50,2e-3,0.000000000000000000000000001],"string":"${u("20ac")}$${u("000F")}${u("000a")}A'${u("0042")}${u("0022")}${u("005c")}\\\\\\"\\/","literals":[null,true,false]}`;
  const expected = `{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"${String.fromCharCode(0x20ac)}$${u("000f")}\\nA'B\\"\\\\\\\\\\"/"}`;
  assert.equal(canonicalize(JSON.parse(input)), expected);
  // Appendix B number serialization samples.
  const nums = [
    [0, "0"],
    [-0, "0"],
    [1e21, "1e+21"],
    [1e-7, "1e-7"],
    [9007199254740992, "9007199254740992"],
    [295147905179352830000, "295147905179352830000"],
    [5e-324, "5e-324"],
  ];
  for (const [n, s] of nums) assert.equal(canonicalize(n), s);
});

test("JCS: keys sort by UTF-16 code units (RFC 8785 3.2.3), and unrepresentable values are refused", () => {
  const k = (...units) => String.fromCharCode(...units);
  // The RFC's sorting example: code units order puts the emoji (D83D) before U+FB33 and U+20AC after "1".
  const obj = { [k(0x20ac)]: "Euro Sign", "\r": "Carriage Return", [k(0xfb33)]: "Hebrew Letter Dalet With Dagesh", 1: "One", [k(0xd83d, 0xde00)]: "Emoji: Grinning Face", [k(0x80)]: "Control", [k(0xf6)]: "Latin Small Letter O With Diaeresis" };
  // (Object.keys would put "1" first: integer-like keys; the canonical text is what counts.)
  const expected = [["\r", "Carriage Return"], ["1", "One"], [k(0x80), "Control"], [k(0xf6), "Latin Small Letter O With Diaeresis"], [k(0x20ac), "Euro Sign"], [k(0xd83d, 0xde00), "Emoji: Grinning Face"], [k(0xfb33), "Hebrew Letter Dalet With Dagesh"]];
  assert.equal(canonicalize(obj), `{${expected.map(([a, b]) => `${JSON.stringify(a)}:${JSON.stringify(b)}`).join(",")}}`);
  assert.throws(() => canonicalize({ a: k(0xd800) }));
  assert.throws(() => canonicalize({ a: Infinity }));
  assert.throws(() => canonicalize({ a: undefined }));
});

// ---- capture -----------------------------------------------------------------------------------

test("send_review_set: one message in the wire format, deterministic order and digest across roots", { skip }, async (t) => {
  const m = machine(t, { web: { "src/x.js": "web x\n" }, api: { "src/x.js": "api x\n", "a.txt": "a\n" } });
  const sent = await m.call("send_review_set", { to: "alex", files: [{ root: "web", path: "src/x.js" }, { root: "api", path: "src/x.js" }, { root: "api", path: "a.txt" }], request: "Review." });
  assert.equal(sent.state, "accepted", JSON.stringify(sent));
  const env = wire(m);
  assert.deepEqual(Object.keys(env), ["hoptell_review_set", "review_set_id", "manifest", "contents"]);
  assert.equal(env.hoptell_review_set, 1);
  assert.equal(env.review_set_id, sent.review_set_id);
  // Ordered by root_id, then path, bytewise: equal relative paths under different roots are deterministic.
  assert.deepEqual(env.manifest.files.map((f) => `${f.file_id}=${f.root_id}:${f.path}`), ["f1=api:a.txt", "f2=api:src/x.js", "f3=web:src/x.js"]);
  assert.equal(env.manifest.request, "Review.");
  assert.equal(env.manifest.git, undefined);
  for (const f of env.manifest.files) {
    assert.deepEqual(env.contents[f.file_id].encoding, "utf8");
    assert.equal(sha(Buffer.from(env.contents[f.file_id].text, "utf8")), f.sha256);
  }
  assert.equal(sent.bundle_digest, sha(Buffer.from(canonicalize(env.manifest.files))));
  assert.equal(sent.bundle_digest, bundleDigest(env.manifest.files));
  // Another order of the same files gives the same manifest and digest.
  const again = await m.call("send_review_set", { to: "alex", files: [{ root: "api", path: "a.txt" }, { root: "web", path: "src/x.js" }, { root: "api", path: "src/x.js" }], request: "Review." });
  assert.equal(again.bundle_digest, sent.bundle_digest);
  assert.notEqual(again.review_set_id, sent.review_set_id);
});

test("send_review_set: the local record keeps the recipient, identities and the exact captured bytes, privately", { skip }, async (t) => {
  const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("const a = 1;\r\n")]);
  const m = machine(t, { app: { "a.js": bytes } });
  const sent = await m.call("send_review_set", { to: "alex", files: [{ root: "app", path: "a.js" }], request: "r" });
  const rec = m.store.read(sent.review_set_id);
  assert.deepEqual(rec.recipient, { realm: REALM, member: null, auth: "legacy", name: "alex" }, "a relay that names no recipient: the legacy realm-and-name fallback, recorded as such");
  assert.match(sent.recipient, /not named by the relay \(an older relay\): proposals are accepted from any authenticated sender named "alex" in this realm/);
  assert.equal(rec.send_state, "accepted");
  const st = fs.statSync(path.join(m.dir.app, "a.js"), { bigint: true });
  assert.equal(rec.files[0].dev, String(st.dev));
  assert.equal(rec.files[0].ino, String(st.ino));
  assert.equal(rec.files[0].mode, Number(st.mode & 0o7777n));
  assert.ok(m.store.captured(rec, "f1").equals(bytes));
  const kept = path.join(m.home, "review-sets", sent.review_set_id, "files", "f1");
  assert.equal(fs.statSync(kept).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(kept)).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(m.home, "review-sets", sent.review_set_id, "set.json")).mode & 0o777, 0o600);
  // A damaged retained capture is detected, not used.
  fs.writeFileSync(kept, "other");
  assert.throws(() => m.store.captured(rec, "f1"), { code: "capture_damaged" });
});

test("send_review_set: limits (files, content, the serialized frame) refuse with the sizes, never truncate", { skip }, async (t) => {
  const many = Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`f${i}.txt`, "x\n"]));
  const m = machine(t, { app: { ...many, "big1.txt": "a".repeat(300_000), "big2.txt": "b".repeat(300_000), "mid.txt": "c".repeat(60_000), "mid2.txt": "d".repeat(60_000) } });
  const r51 = await m.call("send_review_set", { to: "alex", files: Object.keys(many).map((p) => ({ root: "app", path: p })), request: "r" });
  assert.equal(r51.error_code, "invalid_arguments");
  // More than 512 KB in all.
  const big = await m.call("send_review_set", { to: "alex", files: [{ root: "app", path: "big1.txt" }, { root: "app", path: "big2.txt" }], request: "r" });
  assert.equal(big.error_code, "too_large");
  assert.equal(big.limit_bytes, 512 * 1024);
  assert.equal(big.captured_bytes, 300_000);
  // Under 512 KB, but the final message is over the relay's limit.
  const frame = await m.call("send_review_set", { to: "alex", files: [{ root: "app", path: "mid.txt" }, { root: "app", path: "mid2.txt" }], request: "r" });
  assert.equal(frame.error_code, "too_large");
  assert.ok(frame.text_chars > MAX_TEXT && frame.limit_chars === MAX_TEXT && frame.frame_bytes > 0, JSON.stringify(frame));
  assert.equal(m.sent.length, 0);
  assert.equal(m.store.setIds().length, 0, "nothing is recorded for a refused set");
});

test("send_review_set: guarded reads; duplicate and aliased files (overlapping roots, case alias) are refused", { skip }, async (t) => {
  const m = machine(t, { app: { "src/a.js": "a\n", "src/b.js": "b\n", "bin.dat": Buffer.from([0xff, 0xfe, 0x00]) } });
  // A second approved folder inside the first: the same file through both.
  const sub = machine(t, {});
  const tools = (await import("../lib/filetools.js")).createFileTools({
    setting: JSON.stringify([{ id: "app", path: m.dir.app }, { id: "src", path: path.join(m.dir.app, "src") }]),
    home: sub.home,
    peerName: "sam",
    realm: () => REALM,
    log: () => {},
  });
  t.after(() => tools.dispose());
  const relay = { send: async () => ({ type: "ack", state: "delivered" }) };
  const call = async (args) => (await tools.handle("send_review_set", args, relay)).structuredContent;
  assert.equal((await call({ to: "alex", files: [{ root: "app", path: "src/a.js" }, { root: "src", path: "a.js" }], request: "r" })).error_code, "duplicate");
  assert.equal((await call({ to: "alex", files: [{ root: "app", path: "src/a.js" }, { root: "app", path: "src/a.js" }], request: "r" })).error_code, "duplicate");
  // A case alias, where the file system ignores case.
  if (fs.existsSync(path.join(m.dir.app, "SRC", "A.JS"))) {
    assert.equal((await call({ to: "alex", files: [{ root: "app", path: "src/a.js" }, { root: "app", path: "SRC/A.JS" }], request: "r" })).error_code, "duplicate");
  }
  // Guarded: symlinks, paths leaving the folder, non-text.
  fs.symlinkSync(path.join(m.dir.app, "src", "a.js"), path.join(m.dir.app, "link.js"));
  assert.equal((await m.call("send_review_set", { to: "alex", files: [{ root: "app", path: "link.js" }], request: "r" })).error_code, "path_unsafe");
  assert.equal((await m.call("send_review_set", { to: "alex", files: [{ root: "app", path: "../x" }], request: "r" })).error_code, "path_unsafe");
  assert.equal((await m.call("send_review_set", { to: "alex", files: [{ root: "app", path: "bin.dat" }], request: "r" })).error_code, "not_utf8");
  assert.equal((await m.call("send_review_set", { to: "@all", files: [{ root: "app", path: "src/a.js" }], request: "r" })).error_code, "invalid_arguments");
  assert.equal(m.sent.length, 0);
});

test("send_review_set: no protocol-2 realm (an unauthenticated recipient) sends nothing", { skip }, async (t) => {
  const m = machine(t, { app: { "a.js": "a\n" } }, { realm: null });
  const r = await m.call("send_review_set", { to: "alex", files: [{ root: "app", path: "a.js" }], request: "r" });
  assert.equal(r.error_code, "not_supported");
  assert.equal(m.sent.length, 0);
});

test("send_review_set: Git provenance per file (matches, differs, untracked), never the content", { skip }, async (t) => {
  const m = machine(t, { app: { "same.js": "same\n", "edited.js": "v1\n", "sub/deep.js": "deep\n" } });
  git(m.dir.app, "init", "-q");
  git(m.dir.app, "add", ".");
  git(m.dir.app, "commit", "-qm", "c");
  const head = git(m.dir.app, "rev-parse", "HEAD").trim();
  fs.writeFileSync(path.join(m.dir.app, "edited.js"), "v2 local edit\n");
  fs.writeFileSync(path.join(m.dir.app, "new.js"), "new\n");
  const sent = await m.call("send_review_set", { to: "alex", files: ["same.js", "edited.js", "new.js", "sub/deep.js"].map((p) => ({ root: "app", path: p })), request: "r", git: true });
  assert.equal(sent.state, "accepted", JSON.stringify(sent));
  const env = wire(m);
  const byPath = Object.fromEntries(env.manifest.files.map((f) => [f.path, f.file_id]));
  assert.equal(env.manifest.git.commit, head);
  assert.equal(env.manifest.git.tree, git(m.dir.app, "rev-parse", "HEAD^{tree}").trim());
  assert.equal(env.manifest.git.files[byPath["same.js"]], "matches-head");
  assert.equal(env.manifest.git.files[byPath["sub/deep.js"]], "matches-head");
  assert.equal(env.manifest.git.files[byPath["edited.js"]], "differs-from-head");
  assert.equal(env.manifest.git.files[byPath["new.js"]], "untracked");
  // The content is the captured bytes (the local edit), not the HEAD blob.
  assert.equal(env.contents[byPath["edited.js"]].text, "v2 local edit\n");
  // Not a repository: refused with a fixed reason.
  const plain = machine(t, { app: { "a.js": "a\n" } });
  const r = await plain.call("send_review_set", { to: "alex", files: [{ root: "app", path: "a.js" }], request: "r", git: true });
  assert.equal(r.error_code, "not_a_repository");
});

test("verify_review_set: match, changed (which files), expired, unknown", { skip }, async (t) => {
  const m = machine(t, { app: { "a.js": "a\n", "b.js": "b\n" } });
  const sent = await m.call("send_review_set", { to: "alex", files: [{ root: "app", path: "a.js" }, { root: "app", path: "b.js" }], request: "r" });
  const v = (id = sent.review_set_id) => m.call("verify_review_set", { review_set_id: id });
  const match = await v();
  assert.equal(match.state, "match");
  assert.match(match.message, /match the recorded snapshot/);
  fs.writeFileSync(path.join(m.dir.app, "b.js"), "b changed\n");
  const changed = await v();
  assert.equal(changed.state, "changed");
  assert.deepEqual(changed.changed.map((c) => c.file), ["app:b.js"]);
  assert.equal((await v(crypto.randomUUID())).state, "unknown");
  const rec = m.store.read(sent.review_set_id);
  m.store.update(rec, { created_at: Date.now() - 9 * 86400_000, expires_at: Date.now() - 2 * 86400_000 });
  assert.equal((await v()).state, "expired");
});

test("the reviewer's check: every text against its sha256; the digest matches the sender's", { skip }, async (t) => {
  const m = machine(t, { app: { "a.js": "a\n", "b.js": "b\n" } });
  const sent = await m.call("send_review_set", { to: "alex", files: [{ root: "app", path: "a.js" }, { root: "app", path: "b.js" }], request: "r" });
  const text = m.sent.at(-1).text;
  const ok = checkReceivedSet(text);
  assert.equal(ok.ok, true);
  assert.equal(ok.bundle_digest, sent.bundle_digest);
  const env = JSON.parse(text);
  env.contents.f2.text = "tampered\n";
  assert.equal(checkReceivedSet(JSON.stringify(env)).reason, "hash_mismatch");
  delete env.contents.f2;
  assert.equal(checkReceivedSet(JSON.stringify(env)).reason, "missing_content");
  assert.equal(checkReceivedSet(`see {"hoptell_review_set": 1`).reason, "not_json");
  assert.equal(checkReceivedSet("an ordinary message"), null);
});

// ---- proposals ---------------------------------------------------------------------------------

async function sentSet(t) {
  const m = machine(t, { app: { "a.js": "one\ntwo\nthree\n", "b.js": "b\n" } });
  const sent = await m.call("send_review_set", { to: "alex", files: [{ root: "app", path: "a.js" }, { root: "app", path: "b.js" }], request: "r" });
  const f1 = sent.files.find((f) => f.file === "app:a.js");
  const f2 = sent.files.find((f) => f.file === "app:b.js");
  const stored = () => (fs.existsSync(m.store.proposalsDir(sent.review_set_id)) ? fs.readdirSync(m.store.proposalsDir(sent.review_set_id)).length : 0);
  return { m, sent, f1, f2, stored };
}

test("proposals are refused before they are stored: sender, set, based_on, file ids, payloads", { skip }, async (t) => {
  const { m, sent, f1, f2, stored } = await sentSet(t);
  const rep = (f, text = "new\n") => ({ file_id: f.file_id, base_sha256: f.sha256, kind: "replace", text });
  const good = proposal(sent, [rep(f1)]);
  const json = (p) => JSON.stringify(p);
  const cases = [
    ["another peer", fromAlex(json(good), { from: "mallory" }), "wrong_sender"],
    ["another realm", fromAlex(json(good), { sender: { auth: "shared", realm: "f".repeat(32), member: null } }), "wrong_sender"],
    ["an unverified sender", fromAlex(json(good), { sender: undefined }), "wrong_sender"],
    ["an unknown set", fromAlex(json({ ...good, review_set_id: crypto.randomUUID() })), "unknown_set"],
    ["based_on differs", fromAlex(json({ ...good, based_on: sha("x") })), "based_on"],
    ["an unknown file id", fromAlex(json(proposal(sent, [{ ...rep(f1), file_id: "f9" }]))), "unknown_file"],
    ["a repeated file id", fromAlex(json(proposal(sent, [rep(f1), rep(f1, "other\n")]))), "repeated_file"],
    ["two payloads", fromAlex(json(proposal(sent, [{ ...rep(f1), unified_diff: "x" }]))), "bad_payload"],
    ["no payload", fromAlex(json(proposal(sent, [{ file_id: f1.file_id, base_sha256: f1.sha256, kind: "patch" }]))), "bad_payload"],
    ["an unknown kind", fromAlex(json(proposal(sent, [{ ...rep(f1), kind: "create" }]))), "bad_payload"],
    ["a wrong base", fromAlex(json(proposal(sent, [{ ...rep(f2), base_sha256: f1.sha256 }]))), "base_sha256"],
    ["a path field", fromAlex(json({ ...good, path: "/etc/passwd" })), "bad_shape"],
    ["an unsafe patch", fromAlex(json(proposal(sent, [{ file_id: f1.file_id, base_sha256: f1.sha256, kind: "patch", unified_diff: wholeDiff("../a.js", "one\n", "x\n") }]))), "unsafe_patch"],
  ];
  for (const [what, msg, code] of cases) {
    let got;
    try {
      const p = parseProposal(msg.text);
      got = await m.store.receive(p, msg);
    } catch (e) {
      got = e.code;
    }
    assert.equal(got, code, what);
    assert.equal(stored(), 0, `${what}: nothing is stored`);
  }
  assert.throws(() => parseProposal('Here it is: {"hoptell_proposal": 1}'), { code: "not_json" });
  // An expired set.
  m.store.update(m.store.read(sent.review_set_id), { created_at: Date.now() - 9 * 86400_000, expires_at: Date.now() - 2 * 86400_000 });
  assert.equal(await receive(m, good), "expired_set");
  assert.equal(stored(), 0);
});

test("proposals: idempotent by proposal_id, a different payload under the same id is refused, quotas hold", { skip }, async (t) => {
  const { m, sent, f1, stored } = await sentSet(t);
  const p = proposal(sent, [{ file_id: f1.file_id, base_sha256: f1.sha256, kind: "replace", text: "new\n" }]);
  assert.equal(await receive(m, p), "stored");
  assert.equal(await receive(m, p), "repeat");
  assert.equal(stored(), 1);
  assert.equal(await receive(m, { ...p, changes: [{ ...p.changes[0], text: "different\n" }] }), "id_reused");
  // Another peer cannot use up the set's quota: its proposals are refused before they count.
  for (let i = 0; i < 30; i++) assert.equal(await receive(m, proposal(sent, p.changes), fromAlex(JSON.stringify(proposal(sent, p.changes)), { from: "mallory" })), "wrong_sender");
  for (let i = 1; i < MAX_PROPOSALS_PER_SET; i++) assert.equal(await receive(m, proposal(sent, p.changes)), "stored");
  assert.equal(await receive(m, proposal(sent, p.changes)), "set_quota");
  assert.equal(stored(), MAX_PROPOSALS_PER_SET);
  // The home's total: a set whose proposals fill the 50 MB budget refuses new ones elsewhere.
  const other = await m.call("send_review_set", { to: "alex", files: [{ root: "app", path: "b.js" }], request: "r" });
  const filler = path.join(m.store.proposalsDir(other.review_set_id));
  fs.mkdirSync(filler, { mode: 0o700 });
  const fd = fs.openSync(path.join(filler, "filler"), "w", 0o600);
  fs.ftruncateSync(fd, MAX_PROPOSALS_TOTAL);
  fs.closeSync(fd);
  assert.equal(await receive(m, proposal(other, [{ file_id: "f1", base_sha256: other.files[0].sha256, kind: "replace", text: "x\n" }])), "store_quota");
});

test("the agent's note names the set and sender only, never the proposal; refusals are fixed text", () => {
  const id = crypto.randomUUID();
  assert.match(proposalNote("stored", { setId: id, from: "alex" }), new RegExp(`a proposal for review set ${id} from "alex" is waiting for your user`));
  assert.match(proposalNote("refused", { from: "alex", code: "wrong_sender" }), /dropped and not stored: it did not come from the peer/);
  assert.match(proposalNote("refused", { from: "bad name\n", code: "nonsense" }), /from an unknown sender was dropped and not stored: the proposal is malformed/);
});

// ---- patches -----------------------------------------------------------------------------------

test("the malicious-patch corpus is refused (absolute, .., .git, symlinks, gitlinks, binary, several files, creates)", () => {
  const ok = lineDiff("src/a.js", "1\n2\n3\n4\n5\n", 3, "three");
  checkPatch(ok, "src/a.js");
  checkPatch(`diff --git a/src/a.js b/src/a.js\nindex 1234567..89abcde 100644\n${ok}`, "src/a.js");
  const swap = (from, to) => ok.replaceAll("a/src/a.js", `a/${from}`).replaceAll("b/src/a.js", `b/${to}`);
  const corpus = [
    ["absolute", ok.replace("--- a/src/a.js", "--- /etc/passwd"), "patch_absolute"],
    ["dotdot", swap("../src/a.js", "../src/a.js"), "patch_dotdot"],
    [".git", swap(".git/config", ".git/config"), "patch_git_dir"],
    [".GIT case", swap(".GIT/hooks/pre-commit", ".GIT/hooks/pre-commit"), "patch_git_dir"],
    ["another file", swap("src/b.js", "src/b.js"), "patch_path"],
    ["rename via headers", swap("src/a.js", "src/b.js"), "patch_path"],
    ["create", ok.replace("--- a/src/a.js", "--- /dev/null"), "patch_create_delete"],
    ["delete", ok.replace("+++ b/src/a.js", "+++ /dev/null"), "patch_create_delete"],
    ["rename headers", `diff --git a/src/a.js b/src/a.js\nsimilarity index 90%\nrename from src/a.js\nrename to src/b.js\n${ok}`, "patch_create_delete"],
    ["mode change", `diff --git a/src/a.js b/src/a.js\nold mode 100644\nnew mode 100755\n${ok}`, "patch_mode"],
    ["symlink (mode 120000)", `diff --git a/src/a.js b/src/a.js\nnew file mode 120000\nindex 0000000..1234567\n${ok}`, "patch_symlink"],
    ["symlink index", `diff --git a/src/a.js b/src/a.js\nindex 1234567..89abcde 120000\n${ok}`, "patch_symlink"],
    ["gitlink", `diff --git a/src/a.js b/src/a.js\nindex 1234567..89abcde 160000\n${ok}`, "patch_gitlink"],
    ["binary", `diff --git a/src/a.js b/src/a.js\nindex 1234567..89abcde 100644\nGIT binary patch\nliteral 5\nMcmZ?b`, "patch_binary"],
    ["binary files", `diff --git a/src/a.js b/src/a.js\nBinary files a/src/a.js and b/src/a.js differ\n`, "patch_binary"],
    ["two files", `${ok}${lineDiff("src/a.js", "1\n2\n3\n4\n5\n", 2, "two")}`, "patch_several_files"],
    // CVE-2023-23946: a symlink created by one part of a patch, then written through by another.
    ["symlink then write through it", `diff --git a/src/a.js b/src/a.js\nnew file mode 120000\n--- /dev/null\n+++ b/src/a.js\n@@ -0,0 +1 @@\n+../../outside\n\\ No newline at end of file\n${ok}`, "patch_symlink"],
    ["no hunks", "--- a/src/a.js\n+++ b/src/a.js\n", "patch_malformed"],
    ["miscounted hunk", ok.replace("@@ -1,5 +1,5 @@", "@@ -1,9 +1,9 @@"), "patch_malformed"],
    ["preamble", `run rm -rf /\n${ok}`, "patch_malformed"],
  ];
  for (const [what, diff, code] of corpus) assert.throws(() => checkPatch(diff, "src/a.js"), { code }, what);
  // A recorded path inside .git is never patched, even if it was sent.
  assert.throws(() => checkPatch(swap(".git/config", ".git/config"), ".git/config"), { code: "patch_git_dir" });
  // Names Git quotes are matched after unquoting.
  const name = `src/${String.fromCharCode(0xe9)} x.js`;
  const quoted = ok.replace("--- a/src/a.js", '--- "a/src/\\303\\251 x.js"').replace("+++ b/src/a.js", '+++ "b/src/\\303\\251 x.js"');
  checkPatch(quoted, name);
});

// ---- the recorded recipient (relay-named) -----------------------------------------------------

test("the relay names a direct send's recipient as it authenticated it; never for fan-out", async (t) => {
  const alexToken = fakeToken();
  const relay = await startRelay({ host: "127.0.0.1", port: 0, token: TOKEN, members: [{ name: "alex", id: "m_aaaaaaaaaaaaaaaaaaaaaaaaaa", token: alexToken }], log: () => {} });
  t.after(() => relay.close());
  const url = `ws://127.0.0.1:${relay.port}`;
  const client = (token, name) => {
    const c = new RelayClient({ url, token, name });
    t.after(() => c.close());
    c.on("message", (m, confirm) => confirm());
    c.start();
    return c.ready().then(() => c);
  };
  const sam = await client(TOKEN, "sam");
  const alex = await client(alexToken, "alex");
  await client(TOKEN, "bob");
  const realm = sam.realm.id;
  const toAlex = await sam.send("alex", "hi");
  assert.deepEqual(toAlex.recipient, { auth: "member", member: { id: "m_aaaaaaaaaaaaaaaaaaaaaaaaaa", name: "alex" }, realm });
  assert.deepEqual((await sam.send("bob", "hi")).recipient, { auth: "shared", member: null, realm });
  assert.equal((await sam.send("@all", "hi")).recipient, undefined, "fan-out names nobody");
  // Queued for an offline peer: still the principal that owns its queue.
  alex.close();
  await new Promise((r) => setTimeout(r, 200));
  const queued = await sam.send("alex", "later");
  assert.equal(queued.state, "queued");
  assert.equal(queued.recipient.member.id, "m_aaaaaaaaaaaaaaaaaaaaaaaaaa");
});

test("recipientMatches: a member record accepts only that member; a shared record only a shared-token name", () => {
  const realm = REALM;
  const member = { realm, name: "alex", auth: "member", member: "m_aaaaaaaaaaaaaaaaaaaaaaaaaa" };
  const shared = { realm, name: "alex", auth: "shared", member: null };
  const unnamed = { realm, name: "alex", auth: "legacy", member: null };
  const pending = { realm, name: "alex", auth: "pending", member: null };
  const s = (o) => ({ realm, name: "alex", auth: "shared", member: null, ...o });
  assert.equal(recipientMatches(member, s({ auth: "member", member: "m_aaaaaaaaaaaaaaaaaaaaaaaaaa" })), true);
  assert.equal(recipientMatches(member, s({ auth: "member", member: "m_bbbbbbbbbbbbbbbbbbbbbbbbbb" })), false, "another member with the same name");
  assert.equal(recipientMatches(member, s()), false, "a shared-token sender using the member's name");
  assert.equal(recipientMatches(shared, s()), true);
  assert.equal(recipientMatches(shared, s({ name: "bob" })), false);
  assert.equal(recipientMatches(shared, s({ auth: "member", member: "m_aaaaaaaaaaaaaaaaaaaaaaaaaa" })), false);
  assert.equal(recipientMatches(shared, s({ realm: "f".repeat(32) })), false);
  assert.equal(recipientMatches(shared, { ...s(), auth: "unverified", unverified: true, realm: null }), false);
  assert.equal(recipientMatches(unnamed, s()), true, "fallback: realm and name");
  assert.equal(recipientMatches(unnamed, s({ name: "bob" })), false);
  // Not yet (or never) confirmed: no sender matches, not even through the legacy fallback.
  assert.equal(recipientMatches(pending, s()), false);
  assert.equal(recipientMatches(pending, s({ auth: "member", member: "m_aaaaaaaaaaaaaaaaaaaaaaaaaa" })), false);
  assert.equal(recipientMatches({ ...unnamed, auth: null }, s()), false, "an unknown binding is never the fallback");
});

test("a member recipient: a proposal from another member, or a shared-token sender, with the same name is refused", { skip }, async (t) => {
  const id = "m_aaaaaaaaaaaaaaaaaaaaaaaaaa";
  const m = machine(t, { app: { "a.js": "a\n" } }, { recipient: { auth: "member", member: { id, name: "alex" } } });
  const sent = await m.call("send_review_set", { to: "alex", files: [{ root: "app", path: "a.js" }], request: "r" });
  assert.equal(sent.recipient, `member ${id}`);
  assert.deepEqual(m.store.read(sent.review_set_id).recipient, { realm: REALM, member: id, auth: "member", name: "alex" });
  const change = [{ file_id: "f1", base_sha256: sent.files[0].sha256, kind: "replace", text: "b\n" }];
  const as = (sender) => {
    const p = proposal(sent, change);
    return receive(m, p, fromAlex(JSON.stringify(p), { sender: { realm: REALM, ...sender } }));
  };
  assert.equal(await as({ auth: "member", member: { id: "m_bbbbbbbbbbbbbbbbbbbbbbbbbb", name: "alex" } }), "wrong_sender");
  assert.equal(await as({ auth: "shared", member: null }), "wrong_sender");
  assert.equal(await as({ auth: "member", member: { id, name: "alex" } }), "stored");
});

test("a shared-token recipient: a shared-token sender with that name is accepted, a member is not", { skip }, async (t) => {
  const m = machine(t, { app: { "a.js": "a\n" } }, { recipient: { auth: "shared", member: null } });
  const sent = await m.call("send_review_set", { to: "alex", files: [{ root: "app", path: "a.js" }], request: "r" });
  assert.equal(sent.recipient, "a shared-token name");
  assert.equal(m.store.read(sent.review_set_id).recipient.auth, "shared");
  const change = [{ file_id: "f1", base_sha256: sent.files[0].sha256, kind: "replace", text: "b\n" }];
  const p1 = proposal(sent, change);
  assert.equal(await receive(m, p1, fromAlex(JSON.stringify(p1), { sender: { realm: REALM, auth: "member", member: { id: "m_aaaaaaaaaaaaaaaaaaaaaaaaaa", name: "alex" } } })), "wrong_sender");
  assert.equal(await receive(m, proposal(sent, change)), "stored");
  // A relay that names another realm is not believed, and that is not a legacy ack either: the
  // record stays pending and every reply is refused.
  const odd = machine(t, { app: { "a.js": "a\n" } }, { recipient: { auth: "shared", member: null, realm: "f".repeat(32) } });
  const s2 = await odd.call("send_review_set", { to: "alex", files: [{ root: "app", path: "a.js" }], request: "r" });
  assert.equal(odd.store.read(s2.review_set_id).recipient.auth, "pending");
  assert.match(s2.recipient, /not confirmed/);
  assert.equal(await receive(odd, proposal(s2, [{ ...change[0], base_sha256: s2.files[0].sha256 }])), "recipient_pending");
});

// ---- the outer envelope decides (review RW1) -----------------------------------------------------

test("a review set whose captured file or request names the proposal marker is still a review set", { skip }, async (t) => {
  const m = machine(t, { app: { "a.js": 'const marker = "hoptell_proposal";\nconst asKey = {"hoptell_proposal": 1};\n' } });
  const sent = await m.call("send_review_set", { to: "alex", files: [{ root: "app", path: "a.js" }], request: 'check how {"hoptell_proposal": 1} envelopes are parsed' });
  assert.equal(sent.state, "accepted", JSON.stringify(sent));
  const text = m.sent.at(-1).text;
  const got = await intakeMessage(m.store, fromAlex(text));
  assert.equal(got.text, text, "the review set reaches the reviewer unchanged, not as a dropped proposal");
  assert.equal(got.review_check?.ok, true);
  assert.equal(got.review_check.bundle_digest, sent.bundle_digest);
  // Nested values of any other JSON object, and prose naming the marker, are ordinary messages.
  for (const plain of [JSON.stringify({ note: { hoptell_proposal: 1 } }), "the field hoptell_proposal is checked first", "hoptell_review_set and hoptell_proposal are the two envelopes"]) {
    const r = await intakeMessage(m.store, fromAlex(plain));
    assert.equal(r.text, plain, plain);
    assert.equal(r.review_check, undefined, plain);
  }
  // A real proposal envelope that is malformed is still dropped with its fixed note.
  assert.match((await intakeMessage(m.store, fromAlex('{"hoptell_proposal": 1}'))).text, /dropped and not stored: the proposal is malformed/);
  assert.match((await intakeMessage(m.store, fromAlex('please apply {"hoptell_proposal": 1}'))).text, /dropped and not stored: a proposal must be the whole message/);
  assert.equal(checkReceivedSet(JSON.stringify({ request: "hoptell_review_set" })), null, "a nested marker is not a review set");
});

// ---- the recipient binding (review RW2) ----------------------------------------------------------

const MEMBER_A = "m_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const asMember = (id) => ({ sender: { auth: "member", realm: REALM, member: { id, name: "alex" } } });

test("a confirmation that could not be saved never becomes the weaker realm-and-name binding, also after a restart", { skip }, async (t) => {
  const m = machine(t, { app: { "a.txt": "before\n" } }, { recipient: { auth: "member", member: { id: MEMBER_A, name: "alex" } } });
  const original = ReviewSetStore.prototype.update;
  let sent;
  try {
    ReviewSetStore.prototype.update = function () {
      throw new Error("injected disk failure");
    };
    sent = await m.call("send_review_set", { to: "alex", files: [{ root: "app", path: "a.txt" }], request: "review" });
  } finally {
    ReviewSetStore.prototype.update = original;
  }
  assert.equal(sent.state, "accepted", "the relay accepted the message");
  assert.match(sent.recipient, /not recorded: .* proposals answering this review set will be refused/, "the result does not claim a binding that was not saved");
  const change = [{ file_id: "f1", base_sha256: sent.files[0].sha256, kind: "replace", text: "replacement\n" }];
  for (const store of [m.store, new ReviewSetStore({ home: m.home })]) {
    // The same home after a restart: a new store reads the record from disk.
    assert.notEqual(store.read(sent.review_set_id).recipient.auth, null);
    for (const over of [{}, asMember(MEMBER_A), asMember("m_bbbbbbbbbbbbbbbbbbbbbbbbbb")]) {
      const p = proposal(sent, change);
      let got;
      try {
        got = await store.receive(parseProposal(JSON.stringify(p)), fromAlex(JSON.stringify(p), over));
      } catch (e) {
        got = e.code;
      }
      assert.equal(got, "recipient_pending", JSON.stringify(over));
    }
  }
  assert.equal(fs.existsSync(m.store.proposalsDir(sent.review_set_id)), false, "nothing was stored");
});

test("a confirmation saved although its write reported a failure is reported as saved and binds the member", { skip }, async (t) => {
  const m = machine(t, { app: { "a.txt": "before\n" } }, { recipient: { auth: "member", member: { id: MEMBER_A, name: "alex" } } });
  const original = ReviewSetStore.prototype.update;
  let sent;
  try {
    // The record was replaced, then the folder sync failed: the write reports an error.
    ReviewSetStore.prototype.update = function (...a) {
      original.apply(this, a);
      throw Object.assign(new Error("injected folder sync failure"), { phase: "after-replace" });
    };
    sent = await m.call("send_review_set", { to: "alex", files: [{ root: "app", path: "a.txt" }], request: "review" });
  } finally {
    ReviewSetStore.prototype.update = original;
  }
  assert.equal(sent.recipient, `member ${MEMBER_A}`, "read back: the binding was saved");
  assert.equal(new ReviewSetStore({ home: m.home }).read(sent.review_set_id).recipient.auth, "member");
  const change = [{ file_id: "f1", base_sha256: sent.files[0].sha256, kind: "replace", text: "replacement\n" }];
  const p = proposal(sent, change);
  assert.equal(await receive(m, p, fromAlex(JSON.stringify(p), asMember(MEMBER_A))), "stored");
});

test("an approved folder that is .git or inside one is refused at capture", { skip }, async (t) => {
  for (const dir of ["repo/.git", "repo/.GIT/sub", "repo/.git"]) {
    const m = machine(t, { meta: { dir, files: { config: "[core]\n" } } });
    const r = await m.call("send_review_set", { to: "alex", files: [{ root: "meta", path: "config" }], request: "review" });
    assert.equal(r.error_code, "path_unsafe", dir);
    assert.equal(m.sent.length, 0, "nothing was sent");
  }
});

test("a reply that arrives before the relay's confirmation is recorded is refused, not matched by name", { skip }, async (t) => {
  const m = machine(t, { app: { "a.txt": "before\n" } });
  let early = null;
  const relay = {
    send: async (to, text) => {
      // The reviewer answers at once, before this send's ack is processed.
      const env = JSON.parse(text);
      const files = env.manifest.files;
      const p = { hoptell_proposal: 1, proposal_id: crypto.randomUUID(), review_set_id: env.review_set_id, based_on: bundleDigest(files), changes: [{ file_id: "f1", base_sha256: files[0].sha256, kind: "replace", text: "fast\n" }] };
      early = await intakeMessage(m.store, fromAlex(JSON.stringify(p), asMember(MEMBER_A)));
      return { type: "ack", state: "delivered", message_id: crypto.randomUUID(), recipient: { realm: REALM, auth: "member", member: { id: MEMBER_A, name: "alex" } } };
    },
  };
  const r = await m.tools.handle("send_review_set", { to: "alex", files: [{ root: "app", path: "a.txt" }], request: "r" }, relay);
  const sent = r.structuredContent;
  assert.equal(sent.recipient, `member ${MEMBER_A}`);
  assert.match(early.text, /dropped and not stored: the review set's recipient is not confirmed \(the relay's confirmation is not recorded yet, or could not be saved\)/);
  // Once the binding is recorded, the bound member's proposal is accepted, and only that member's.
  const change = [{ file_id: "f1", base_sha256: sent.files[0].sha256, kind: "replace", text: "later\n" }];
  const p = proposal(sent, change);
  assert.equal(await receive(m, p, fromAlex(JSON.stringify(p))), "wrong_sender", "a shared-token sender using the name");
  const p2 = proposal(sent, change);
  assert.equal(await receive(m, p2, fromAlex(JSON.stringify(p2), asMember(MEMBER_A))), "stored");
});

test("apply re-checks the binding: a set whose recipient is not confirmed is refused at prepare", { skip }, async (t) => {
  const m = machine(t, { app: { "a.txt": "before\n" } }, { recipient: { auth: "member", member: { id: MEMBER_A, name: "alex" } } });
  const sent = await m.call("send_review_set", { to: "alex", files: [{ root: "app", path: "a.txt" }], request: "r" });
  const p = proposal(sent, [{ file_id: "f1", base_sha256: sent.files[0].sha256, kind: "replace", text: "after\n" }]);
  assert.equal(await receive(m, p, fromAlex(JSON.stringify(p), asMember(MEMBER_A))), "stored");
  const rec = m.store.read(sent.review_set_id);
  m.store.update(rec, { recipient: { ...rec.recipient, auth: "pending", member: null } });
  const roots = openApprovedRoots(m.setting);
  t.after(() => closeRoots(roots));
  assert.throws(() => prepare({ home: m.home, roots, id: p.proposal_id }), { code: "recipient_pending" });
});

// ---- files inside .git (review RW3) --------------------------------------------------------------

test("files inside .git are outside review sets for every kind of change: capture, intake and records", { skip }, async (t) => {
  const m = machine(t, { app: { ".git/config": "[core]\n", "sub/.Git/HEAD": "x\n", "a.txt": "a\n" } });
  for (const rel of [".git/config", ".GIT/config", "sub/.Git/HEAD", "sub/.g\u200cit/HEAD"]) {
    const r = await m.call("send_review_set", { to: "alex", files: [{ root: "app", path: rel }], request: "r" });
    assert.equal(r.state, "error", rel);
    assert.equal(r.error_code, "path_unsafe", rel);
    assert.match(r.message, /inside \.git/, rel);
  }
  assert.equal(m.sent.length, 0, "nothing was sent");
  // A proposal against a set that names a .git path is refused whatever its kind.
  const sent = await m.call("send_review_set", { to: "alex", files: [{ root: "app", path: "a.txt" }], request: "r" });
  const rec = m.store.read(sent.review_set_id);
  const forged = { ...rec, recipient: { ...rec.recipient, auth: "shared" }, files: [{ ...rec.files[0], path: ".git/config" }] };
  const p = proposal(sent, [{ file_id: "f1", base_sha256: sent.files[0].sha256, kind: "replace", text: "x\n" }]);
  assert.throws(() => checkProposal(p, forged, { realm: REALM, name: "alex", auth: "shared", member: null }), { code: "git_dir" });
  // A stored record that names one is damaged, so nothing reads it as a target.
  const file = path.join(m.home, "review-sets", sent.review_set_id, "set.json");
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  raw.files[0].path = "x/.GIT/config";
  fs.writeFileSync(file, JSON.stringify(raw));
  assert.throws(() => m.store.read(sent.review_set_id), { code: "invalid_record" });
});

test("send_review_set: an expired retry is unknown with the original reference and deadline, and the binding stays pending", { skip }, async (t) => {
  const ref = "6a976c97-7664-460a-a5ba-8915ada1c29f";
  const deadline = Date.UTC(2026, 9, 9, 10, 0, 0);
  for (const [frame, want] of [
    [{ message_id: ref, expires: deadline }, [ref, new Date(deadline).toISOString()]],
    [{ message_id: "not-a-uuid", expires: Number.MAX_SAFE_INTEGER }, [null, null]],
  ]) {
    const m = machine(t, { app: { "a.txt": "before\n" } });
    const relay = { send: async () => Promise.reject(Object.assign(new Error("this retry was not queued"), { kind: "relay_error", code: "expired", ...frame })) };
    const r = (await m.tools.handle("send_review_set", { to: "alex", files: [{ root: "app", path: "a.txt" }], request: "r" }, relay)).structuredContent;
    assert.deepEqual([r.state, r.error_code, r.message_reference, r.relay_expires_at], ["unknown", "expired", ...want]);
    assert.match(r.message, /An earlier attempt may have been delivered/);
    const stored = new ReviewSetStore({ home: m.home }).read(r.review_set_id);
    assert.equal(stored.send_state, "unknown");
    assert.equal(stored.recipient.auth, "pending");
  }
});
