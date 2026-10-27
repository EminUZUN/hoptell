// Owner-run apply (design 5.2): checks, the preview from the captured bytes in a standalone
// temporary folder, revalidation, the recovery journal, crash recovery and the apply lock.
// Crash tests run the CLI as a child process, pause it at a named step and kill it by its PID.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { BIN } from "../lib/config.js";
import { supported } from "../lib/files.js";
import { canonicalize } from "../lib/jcs.js";
import { closeRoots, commit, openApprovedRoots, prepare, recover, renderPreview } from "../lib/apply.js";
import { ReviewSetStore } from "../lib/reviewsets.js";
import { gitVersionOk } from "../lib/gitsafe.js";
import { writeDurable } from "../lib/credentials.js";
import { REALM, cli, fromAlex, git, lineDiff, machine, proposal, receive, sleep, tmpDir, wholeDiff } from "./reviewfix.js";

const skip = !supported() && "file tools need macOS or Linux";
const read = (m, rel, root = "app") => fs.readFileSync(path.join(m.dir[root], rel), "utf8");
const names = (d) => (fs.existsSync(d) ? fs.readdirSync(d) : []);
// Unfinished applies, and retired journal folders whose removal was interrupted (apply/done).
const journalDirs = (m) => [
  ...names(path.join(m.home, "apply")).filter((n) => /^[0-9a-f-]{36}$/.test(n)),
  ...names(path.join(m.home, "apply", "done")).map((n) => path.join("done", n)),
];

/** Send a set of `files` (paths in "app") and receive a replace proposal from alex. */
async function setWithProposal(m, changes) {
  const sent = await m.call("send_review_set", { to: "alex", files: Object.keys(changes).map((p) => ({ root: "app", path: p })), request: "r" });
  assert.equal(sent.state, "accepted", JSON.stringify(sent));
  const p = proposal(
    sent,
    Object.entries(changes).map(([rel, text]) => {
      const f = sent.files.find((x) => x.file === `app:${rel}`);
      return { file_id: f.file_id, base_sha256: f.sha256, kind: "replace", text };
    }),
  );
  assert.equal(await receive(m, p), "stored");
  return { sent, id: p.proposal_id };
}

/** Two files, one executable, and a proposal replacing both. */
async function twoFiles(t) {
  const m = machine(t, { app: { "a.txt": "A1\n", "dir/b.sh": "B1\n" } });
  fs.chmodSync(path.join(m.dir.app, "dir/b.sh"), 0o755);
  const { id } = await setWithProposal(m, { "a.txt": "A2\n", "dir/b.sh": "B2\n" });
  return { m, id };
}

/** Start the CLI with a barrier at `step`; resolves {child, barrier, exited} once it waits there. */
async function pausedAt(m, step, args) {
  const barrier = path.join(m.base, `barrier-${crypto.randomBytes(4).toString("hex")}`);
  fs.writeFileSync(`${barrier}.step`, step);
  const child = spawn(process.execPath, [BIN, ...args], { env: { ...m.env, HOPTELL_APPLY_TEST_BARRIER: barrier }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  const exited = new Promise((r) => child.once("exit", (code, signal) => r({ code, signal, out })));
  for (let i = 0; i < 400 && !fs.existsSync(`${barrier}.at`); i++) {
    if (child.exitCode !== null) break;
    await sleep(25);
  }
  assert.ok(fs.existsSync(`${barrier}.at`), `the apply did not reach ${step}: ${out}`);
  return { child, barrier, exited, go: () => fs.writeFileSync(`${barrier}.go`, "") };
}

/** Kill a paused CLI by its exact process id. */
async function crash(p) {
  process.kill(p.child.pid, "SIGKILL");
  const r = await p.exited;
  assert.equal(r.signal, "SIGKILL");
}

test("a dirty capture: a proposal for a distant hunk applies to the captured bytes, keeping the owner's edit", { skip }, async (t) => {
  const lines = `${Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n")}\n`;
  const m = machine(t, { app: { "src/a.js": lines } });
  git(m.dir.app, "init", "-q");
  git(m.dir.app, "add", ".");
  git(m.dir.app, "commit", "-qm", "c");
  // The owner's uncommitted edit on line 1 is part of the capture.
  fs.writeFileSync(path.join(m.dir.app, "src/a.js"), lines.replace("line 1\n", "line 1 (owner's edit)\n"));
  const sent = await m.call("send_review_set", { to: "alex", files: [{ root: "app", path: "src/a.js" }], request: "r", git: true });
  assert.equal(sent.files[0].git, "differs-from-head");
  const captured = read(m, "src/a.js");
  const p = proposal(sent, [{ file_id: "f1", base_sha256: sent.files[0].sha256, kind: "patch", unified_diff: lineDiff("src/a.js", captured, 25, "line 25 (reviewed)") }]);
  assert.equal(await receive(m, p), "stored");
  const r = await cli(m.env, ["apply", p.proposal_id, "--yes"]);
  assert.equal(r.code, 0, r.stderr);
  const after = read(m, "src/a.js").split("\n");
  assert.equal(after[0], "line 1 (owner's edit)");
  assert.equal(after[24], "line 25 (reviewed)");
  assert.equal(read(m, "src/a.js"), captured.replace("line 25\n", "line 25 (reviewed)\n"));
  // Applied once: a second run is refused, and the listing is empty.
  assert.match((await cli(m.env, ["apply", p.proposal_id, "--yes"])).stderr, /already applied/);
  assert.match((await cli(m.env, ["apply"])).stdout, /No proposals are waiting/);
});

test("preview writes nothing; a file changed after capture refuses the whole apply", { skip }, async (t) => {
  const { m, id } = await twoFiles(t);
  const listed = await cli(m.env, ["apply"]);
  assert.match(listed.stdout, new RegExp(`${id}  from "alex"`));
  const pv = await cli(m.env, ["apply", id, "--preview"]);
  assert.equal(pv.code, 0, pv.stderr);
  assert.match(pv.stdout, /-A1\n\+A2/);
  assert.match(pv.stdout, /from "alex" \(a shared-token name: anyone holding the relay's shared token can use it; realm /);
  assert.match(pv.stdout, /Preview only: nothing was written/);
  assert.equal(read(m, "a.txt"), "A1\n");
  assert.equal(journalDirs(m).length, 0);
  // Without a terminal and without --yes: nothing is written.
  const noTty = await cli(m.env, ["apply", id]);
  assert.equal(noTty.code, 1);
  assert.match(noTty.stderr, /not confirmed/);
  fs.writeFileSync(path.join(m.dir.app, "dir/b.sh"), "B owner\n");
  const r = await cli(m.env, ["apply", id, "--yes"]);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /applying will be refused/);
  assert.match(r.stderr, /nothing was written/);
  assert.equal(read(m, "a.txt"), "A1\n", "the unchanged file is not written either");
  assert.equal(read(m, "dir/b.sh"), "B owner\n");
  assert.equal(journalDirs(m).length, 0);
});

test("a change between the preview and the write refuses the whole apply", { skip }, async (t) => {
  const { m, id } = await twoFiles(t);
  const p = await pausedAt(m, "before-revalidate", ["apply", id, "--yes"]);
  fs.writeFileSync(path.join(m.dir.app, "dir/b.sh"), "B owner\n");
  p.go();
  const r = await p.exited;
  assert.equal(r.code, 1);
  assert.match(r.out, /changed since it was captured/);
  assert.equal(read(m, "a.txt"), "A1\n");
  assert.equal(journalDirs(m).length, 0);
});

test("a parent folder replaced by a symbolic link after the preview is refused", { skip }, async (t) => {
  const m = machine(t, { app: { "src/a.js": "a1\n" } });
  const { id } = await setWithProposal(m, { "src/a.js": "a2\n" });
  const p = await pausedAt(m, "before-revalidate", ["apply", id, "--yes"]);
  // The same folder (and file inode) behind a symbolic link.
  fs.renameSync(path.join(m.dir.app, "src"), path.join(m.dir.app, "src-real"));
  fs.symlinkSync(path.join(m.dir.app, "src-real"), path.join(m.dir.app, "src"));
  p.go();
  const r = await p.exited;
  assert.equal(r.code, 1);
  assert.match(r.out, /symbolic link/);
  assert.equal(fs.readFileSync(path.join(m.dir.app, "src-real", "a.js"), "utf8"), "a1\n");
  assert.equal(journalDirs(m).length, 0);
});

test("file modes are kept; equal paths in different approved folders get separate temporary locations", { skip }, async (t) => {
  const m = machine(t, { app: { "src/x.js": "one\ntwo\nthree\n" }, web: { "src/x.js": "uno\ndos\ntres\n" } });
  fs.chmodSync(path.join(m.dir.app, "src/x.js"), 0o750);
  const sent = await m.call("send_review_set", { to: "alex", files: [{ root: "app", path: "src/x.js" }, { root: "web", path: "src/x.js" }], request: "r" });
  const [fa, fw] = [sent.files.find((f) => f.file === "app:src/x.js"), sent.files.find((f) => f.file === "web:src/x.js")];
  const p = proposal(sent, [
    { file_id: fa.file_id, base_sha256: fa.sha256, kind: "patch", unified_diff: lineDiff("src/x.js", "one\ntwo\nthree\n", 2, "TWO") },
    { file_id: fw.file_id, base_sha256: fw.sha256, kind: "patch", unified_diff: lineDiff("src/x.js", "uno\ndos\ntres\n", 2, "DOS") },
  ]);
  assert.equal(await receive(m, p), "stored");
  const r = await cli(m.env, ["apply", p.proposal_id, "--yes"]);
  assert.equal(r.code, 0, r.stderr + r.stdout);
  assert.equal(read(m, "src/x.js", "app"), "one\nTWO\nthree\n");
  assert.equal(read(m, "src/x.js", "web"), "uno\nDOS\ntres\n");
  assert.equal(fs.statSync(path.join(m.dir.app, "src/x.js")).mode & 0o7777, 0o750);
});

test("checks at apply time: the malicious-patch corpus and Git releases without the CVE-2023-23946 fix", { skip }, async (t) => {
  const m = machine(t, { app: { "src/a.js": "1\n2\n3\n4\n5\n" } });
  const sent = await m.call("send_review_set", { to: "alex", files: [{ root: "app", path: "src/a.js" }], request: "r" });
  const f = sent.files[0];
  // Records written directly, as if intake had been bypassed: apply checks again.
  const plant = (diff) => {
    const p = proposal(sent, [{ file_id: f.file_id, base_sha256: f.sha256, kind: "patch", unified_diff: diff }]);
    const dir = m.store.proposalsDir(sent.review_set_id);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const rec = { v: 1, proposal_id: p.proposal_id, review_set_id: sent.review_set_id, received_at: Date.now(), expires_at: Date.now() + 86400_000, status: "pending", applied_at: null, sender: { realm: m.store.read(sent.review_set_id).recipient.realm, member: null, name: "alex", auth: "shared" }, payload_sha256: `sha256:${crypto.createHash("sha256").update(canonicalize(p)).digest("hex")}`, proposal: p };
    writeDurable(path.join(dir, `${p.proposal_id}.json`), JSON.stringify(rec));
    return p.proposal_id;
  };
  const ok = lineDiff("src/a.js", "1\n2\n3\n4\n5\n", 3, "three");
  const roots = openApprovedRoots(m.setting);
  t.after(() => closeRoots(roots));
  const corpus = [ok.replaceAll("a/src/a.js", "a/../a.js").replaceAll("b/src/a.js", "b/../a.js"), ok.replace("--- a/src/a.js", "--- /etc/passwd"), `diff --git a/src/a.js b/src/a.js\nnew file mode 120000\n${ok}`, ok.replaceAll("src/a.js", ".git/config")];
  for (const diff of corpus) assert.throws(() => prepare({ home: m.home, roots, id: plant(diff) }), { code: "unsafe_patch" });
  // An old Git is refused before any patch runs.
  const bin = tmpDir(t, "oldgit");
  fs.writeFileSync(path.join(bin, "git"), "#!/bin/sh\necho 'git version 2.39.1'\n", { mode: 0o755 });
  assert.throws(() => prepare({ home: m.home, roots, id: plant(ok), git: path.join(bin, "git") }), { code: "git_too_old" });
  assert.equal(read(m, "src/a.js"), "1\n2\n3\n4\n5\n");
  // The version table: 2.39.2 and the same day's maintenance releases, and everything later.
  for (const v of ["2.39.2", "2.38.4", "2.37.6", "2.36.5", "2.35.7", "2.34.7", "2.33.7", "2.32.6", "2.31.7", "2.30.8", "2.40.0", "2.54.0 (Apple Git-157)", "3.0.0"]) assert.equal(gitVersionOk(`git version ${v}`).ok, true, v);
  for (const v of ["2.39.1", "2.38.3", "2.30.7", "2.29.9", "1.9.0", "garbage"]) assert.equal(gitVersionOk(`git version ${v}`).ok, false, v);
});

test("preview and apply run no hook or filter and leave the repository's files, index and refs untouched", { skip }, async (t) => {
  const m = machine(t, { app: { "a.js": "1\n2\n3\n4\n5\n", "other.js": "o\n" } });
  const marker = path.join(m.base, "HOOK-RAN");
  const repo = m.dir.app;
  git(repo, "init", "-q");
  fs.writeFileSync(path.join(repo, ".gitattributes"), "* filter=evil diff=evil\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "c");
  const script = `#!/bin/sh\necho ran >> '${marker}'\ncat\n`;
  for (const h of ["pre-commit", "post-commit", "pre-applypatch", "post-applypatch", "applypatch-msg", "post-checkout", "post-merge", "post-index-change", "reference-transaction", "fsmonitor-watchman"]) {
    fs.writeFileSync(path.join(repo, ".git", "hooks", h), script, { mode: 0o755 });
  }
  const tool = path.join(m.base, "evil.sh");
  fs.writeFileSync(tool, script, { mode: 0o755 });
  for (const [k, v] of [["core.fsmonitor", tool], ["filter.evil.clean", tool], ["filter.evil.smudge", tool], ["diff.evil.textconv", tool], ["core.pager", tool], ["core.hooksPath", path.join(repo, ".git", "hooks")]]) git(repo, "config", k, v);
  const snapshot = () => {
    const files = {};
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else files[path.relative(repo, p)] = `${fs.readFileSync(p).toString("hex")}:${fs.statSync(p).mtimeMs}`;
      }
    };
    walk(repo);
    return files;
  };
  const sent = await m.call("send_review_set", { to: "alex", files: [{ root: "app", path: "a.js" }], request: "r", git: true });
  assert.equal(sent.state, "accepted", JSON.stringify(sent));
  const p = proposal(sent, [{ file_id: "f1", base_sha256: sent.files[0].sha256, kind: "patch", unified_diff: lineDiff("a.js", "1\n2\n3\n4\n5\n", 3, "three") }]);
  assert.equal(await receive(m, p), "stored");
  const before = snapshot();
  const pv = await cli(m.env, ["apply", p.proposal_id, "--preview"]);
  assert.equal(pv.code, 0, pv.stderr);
  assert.deepEqual(snapshot(), before, "the preview changes nothing in the repository");
  assert.ok(!fs.existsSync(marker), "no hook, filter, textconv, fsmonitor or pager ran");
  const r = await cli(m.env, ["apply", p.proposal_id, "--yes"]);
  assert.equal(r.code, 0, r.stderr);
  const after = snapshot();
  assert.equal(read(m, "a.js"), "1\n2\nthree\n4\n5\n");
  for (const [k, v] of Object.entries(before)) if (k !== "a.js") assert.equal(after[k], v, `${k} untouched`);
  assert.ok(!fs.existsSync(marker), "no hook ran during the apply either");
});

// Every step of the journal, then recovery to all preimages or all postimages.
// From "complete" on, the apply is committed: recovery finishes it, and a roll-back is refused.
const COMMITTED = ["complete", "marked-applied", "journal-retired", "retired-removed-journal.json"];
const STEPS = ["journal-written", "temp-written-0", "renamed-0", "done-0", "temp-written-1", "renamed-1", "done-1", ...COMMITTED];
for (const step of STEPS) {
  for (const choice of ["--finish", "--roll-back"]) {
    test(`a crash at ${step}, then recover ${choice}`, { skip }, async (t) => {
      const { m, id } = await twoFiles(t);
      await crash(await pausedAt(m, step, ["apply", id, "--yes"]));
      assert.equal(journalDirs(m).length, 1, "the journal is kept until recovery completes");
      // No new apply while a journal waits; doctor reports it.
      assert.match((await cli(m.env, ["apply", id, "--yes"])).stderr, /run hoptell apply --recover/);
      assert.match((await cli(m.env, ["doctor"])).stdout, /interrupted apply.*hoptell apply --recover/);
      const status = await cli(m.env, ["apply", "--recover"]);
      assert.equal(status.code, 1);
      assert.match(status.stdout, /^To finish writing the proposed contents: hoptell apply --recover --finish$/m);
      if (!COMMITTED.includes(step)) assert.match(status.stdout, /^To restore the original contents: hoptell apply --recover --roll-back$/m);
      assert.match(status.stdout, /^A committed apply can only be finished\.$/m);
      assert.doesNotMatch(status.stdout, /preimage|postimage|holds its/);
      const r = await cli(m.env, ["apply", "--recover", choice]);
      // At "complete" the apply is committed: it is finished, and a roll-back is refused.
      const committed = COMMITTED.includes(step);
      if (committed && choice === "--roll-back") {
        assert.equal(r.code, 1, r.stdout + r.stderr);
        assert.match(r.stdout, /: finished \(already committed: every file was written, so nothing was rolled back/);
      } else assert.equal(r.code, 0, r.stdout + r.stderr);
      const want = choice === "--finish" || committed ? ["A2\n", "B2\n"] : ["A1\n", "B1\n"];
      assert.deepEqual([read(m, "a.txt"), read(m, "dir/b.sh")], want);
      assert.equal(fs.statSync(path.join(m.dir.app, "dir/b.sh")).mode & 0o7777, 0o755);
      assert.equal(journalDirs(m).length, 0);
      const pending = (await cli(m.env, ["apply"])).stdout;
      if (choice === "--finish" || committed) assert.match(pending, /No proposals are waiting/);
      else assert.match(pending, new RegExp(id), "a rolled-back proposal is still pending");
      for (const d of [m.dir.app, path.join(m.dir.app, "dir")]) for (const f of fs.readdirSync(d)) assert.ok(!f.startsWith(".hoptell-apply-"), `no stray temporary file: ${f}`);
    });
  }
}

test("a crash before the journal record is written: nothing was replaced; recovery clears it", { skip }, async (t) => {
  for (const choice of ["--finish", "--roll-back"]) {
    const { m, id } = await twoFiles(t);
    await crash(await pausedAt(m, "journal-dir-created", ["apply", id, "--yes"]));
    assert.deepEqual([read(m, "a.txt"), read(m, "dir/b.sh")], ["A1\n", "B1\n"]);
    assert.equal(journalDirs(m).length, 1);
    assert.match((await cli(m.env, ["apply", id, "--yes"])).stderr, /run hoptell apply --recover/);
    const r = await cli(m.env, ["apply", "--recover", choice]);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /interrupted before any file was written/);
    assert.equal(journalDirs(m).length, 0);
    const again = await cli(m.env, ["apply", id, "--yes"]);
    assert.equal(again.code, 0, again.stderr);
    assert.deepEqual([read(m, "a.txt"), read(m, "dir/b.sh")], ["A2\n", "B2\n"]);
    for (const d of [m.dir.app, path.join(m.dir.app, "dir")]) for (const f of fs.readdirSync(d)) assert.ok(!f.startsWith(".hoptell-apply-"), f);
  }
});

test("a crash followed by an owner's edit halts recovery for that file; a retry completes it", { skip }, async (t) => {
  const { m, id } = await twoFiles(t);
  await crash(await pausedAt(m, "renamed-0", ["apply", id, "--yes"]));
  fs.writeFileSync(path.join(m.dir.app, "dir/b.sh"), "B owner\n");
  const halted = await cli(m.env, ["apply", "--recover", "--finish"]);
  assert.equal(halted.code, 1);
  assert.match(halted.stdout, /dir\/b.sh: matches neither the original nor the proposed contents; it matches neither the original nor the proposed contents: halted/);
  assert.doesNotMatch(halted.stdout, /preimage|postimage|holds its/, "plain words, no jargon");
  assert.equal(read(m, "dir/b.sh"), "B owner\n", "never overwritten");
  assert.equal(read(m, "a.txt"), "A2\n");
  const kept = journalDirs(m);
  assert.equal(kept.length, 1);
  assert.equal(fs.readFileSync(path.join(m.home, "apply", kept[0], "pre-1"), "utf8"), "B1\n", "the preimage is kept for reconciliation");
  assert.equal(fs.readFileSync(path.join(m.home, "apply", kept[0], "post-1"), "utf8"), "B2\n");
  // The owner reconciles (back to the preimage); recovery is retried and completes.
  fs.writeFileSync(path.join(m.dir.app, "dir/b.sh"), "B1\n");
  const retry = await cli(m.env, ["apply", "--recover", "--finish"]);
  assert.equal(retry.code, 0, retry.stdout);
  assert.deepEqual([read(m, "a.txt"), read(m, "dir/b.sh")], ["A2\n", "B2\n"]);
  assert.equal(journalDirs(m).length, 0);
});

test("a crash during recovery, then a recovery retry", { skip }, async (t) => {
  const { m, id } = await twoFiles(t);
  await crash(await pausedAt(m, "done-1", ["apply", id, "--yes"]));
  // The roll-back restored the first file and is killed with the second one's temporary file written.
  await crash(await pausedAt(m, "temp-written-1", ["apply", "--recover", "--roll-back"]));
  assert.deepEqual([read(m, "a.txt"), read(m, "dir/b.sh")], ["A1\n", "B2\n"]);
  const r = await cli(m.env, ["apply", "--recover", "--roll-back"]);
  assert.equal(r.code, 0, r.stdout);
  assert.deepEqual([read(m, "a.txt"), read(m, "dir/b.sh")], ["A1\n", "B1\n"]);
});

test("the journal outlives the review set's record", { skip }, async (t) => {
  const { m, id } = await twoFiles(t);
  await crash(await pausedAt(m, "renamed-0", ["apply", id, "--yes"]));
  fs.rmSync(path.join(m.home, "review-sets"), { recursive: true }); // as if expired and cleaned up
  const r = await cli(m.env, ["apply", "--recover", "--finish"]);
  assert.equal(r.code, 0, r.stdout);
  assert.match(r.stdout, /record is gone/);
  assert.deepEqual([read(m, "a.txt"), read(m, "dir/b.sh")], ["A2\n", "B2\n"]);
});

test("two overlapping applies serialize: the second is refused while the first holds the lock", { skip }, async (t) => {
  const m = machine(t, { app: { "a.txt": "A1\n", "c.txt": "C1\n" } });
  const first = await setWithProposal(m, { "a.txt": "A2\n" });
  const second = await setWithProposal(m, { "c.txt": "C2\n" });
  const p = await pausedAt(m, "before-revalidate", ["apply", first.id, "--yes"]);
  const busy = await cli(m.env, ["apply", second.id, "--yes"]);
  assert.equal(busy.code, 1);
  assert.match(busy.stderr, new RegExp(`another hoptell apply or recovery is running in this home \\(process ${p.child.pid}\\)`));
  assert.match((await cli(m.env, ["apply", "--recover"])).stderr, /another hoptell apply/);
  assert.equal(read(m, "c.txt"), "C1\n");
  p.go();
  assert.equal((await p.exited).code, 0);
  const r = await cli(m.env, ["apply", second.id, "--yes"]);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual([read(m, "a.txt"), read(m, "c.txt")], ["A2\n", "C2\n"]);
});

test("a whole-file replace and a patch that does not apply", { skip }, async (t) => {
  const m = machine(t, { app: { "a.txt": "x\ny\n" } });
  const sent = await m.call("send_review_set", { to: "alex", files: [{ root: "app", path: "a.txt" }], request: "r" });
  const p = proposal(sent, [{ file_id: "f1", base_sha256: sent.files[0].sha256, kind: "patch", unified_diff: wholeDiff("a.txt", "not\nthe\nbase\n", "z\n") }]);
  assert.equal(await receive(m, p), "stored");
  const r = await cli(m.env, ["apply", p.proposal_id, "--preview"]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /does not apply to the captured bytes/);
  assert.equal(read(m, "a.txt"), "x\ny\n");
});

// ---- in-process faults: the review's reproductions -----------------------------------------------

/** One file, a stored replace proposal, its plan. */
async function planned(t, rel = "a.txt") {
  const m = machine(t, { app: { [rel]: "before\n" } });
  const sent = await m.call("send_review_set", { to: "alex", files: [{ root: "app", path: rel }], request: "review" });
  assert.equal(sent.state, "accepted", JSON.stringify(sent));
  const p = proposal(sent, [{ file_id: "f1", base_sha256: sent.files[0].sha256, kind: "replace", text: "after\n" }]);
  assert.equal(await receive(m, p), "stored");
  const roots = openApprovedRoots(m.setting);
  t.after(() => closeRoots(roots));
  return { m, p, roots, plan: prepare({ home: m.home, roots, id: p.proposal_id }) };
}
const status = (m, p) => m.store.findProposal(p.proposal_id).proposal.status;
const left = (m) => (fs.existsSync(path.join(m.home, "apply")) ? fs.readdirSync(path.join(m.home, "apply"), { recursive: true }) : []);

/** Run `fn` with fs.rmSync replaced by `wrap(original)`; returns what `fn` threw. */
function withRm(wrap, fn) {
  const orig = fs.rmSync;
  fs.rmSync = wrap(orig);
  try {
    fn();
  } catch (e) {
    return e;
  } finally {
    fs.rmSync = orig;
  }
  assert.fail("it was not interrupted");
}

test("an interruption right after the journal record is removed: committed, never reported as unwritten or rolled back", { skip }, async (t) => {
  const { m, p, roots, plan } = await planned(t);
  const fault = (orig) =>
    function (f, ...args) {
      const r = orig.call(this, f, ...args);
      if (String(f).endsWith("/journal.json")) throw new Error("interrupted after journal unlink");
      return r;
    };
  const thrown = withRm(fault, () => commit(plan, { home: m.home }));
  assert.equal(read(m, "a.txt"), "after\n");
  assert.equal(status(m, p), "applied");
  const report = recover({ home: m.home, roots, choice: "roll-back" });
  assert.equal(report.length, 1);
  assert.doesNotMatch(report[0].note, /before any file was written/);
  assert.match(report[0].note, /already committed: every file was written, so nothing was rolled back/);
  assert.equal(report[0].committed, true);
  assert.equal(report[0].resolved, true);
  assert.equal(report[0].outcome, "finished");
  assert.equal(read(m, "a.txt"), "after\n");
  assert.equal(status(m, p), "applied");
  assert.deepEqual(left(m), ["done"], "the journal is gone");
  assert.equal(thrown.code, "committed", "the apply reported that it was committed");
});

test("an interruption after the proposal is marked applied, before cleanup: a roll-back is refused, the state stays consistent", { skip }, async (t) => {
  const { m, p, roots, plan } = await planned(t);
  const fault = (orig) =>
    function (f, ...args) {
      if (String(f).endsWith("/journal.json")) throw new Error("interrupted before journal unlink");
      return orig.call(this, f, ...args);
    };
  const thrown = withRm(fault, () => commit(plan, { home: m.home }));
  const report = recover({ home: m.home, roots, choice: "roll-back" });
  assert.equal(read(m, "a.txt"), "after\n", "the postimage is kept: the apply was committed");
  assert.equal(status(m, p), "applied");
  assert.throws(() => prepare({ home: m.home, roots, id: p.proposal_id }), /already applied/);
  assert.equal(report[0].committed, true);
  assert.equal(report[0].resolved, true);
  assert.equal(thrown.code, "committed");
});

test("marking the proposal applied fails after the commit point: recovery marks it, and never rolls back", { skip }, async (t) => {
  const { m, p, roots, plan } = await planned(t);
  const original = ReviewSetStore.prototype.markApplied;
  let thrown = null;
  try {
    ReviewSetStore.prototype.markApplied = function () {
      throw new Error("injected disk failure");
    };
    try {
      commit(plan, { home: m.home });
    } catch (e) {
      thrown = e;
    }
    assert.ok(thrown, "the failure is reported");
    assert.equal(status(m, p), "pending");
    // While it still fails, recovery keeps the journal.
    assert.equal(recover({ home: m.home, roots, choice: "finish" })[0].resolved, false);
    assert.equal(journalDirs(m).length, 1);
  } finally {
    ReviewSetStore.prototype.markApplied = original;
  }
  const status0 = recover({ home: m.home, roots });
  assert.equal(status0[0].resolved, false);
  const report = recover({ home: m.home, roots, choice: "roll-back" });
  assert.equal(read(m, "a.txt"), "after\n", "never rolled back after the commit point");
  assert.equal(status(m, p), "applied");
  assert.equal(report[0].resolved, true);
  assert.deepEqual(left(m), ["done"]);
  assert.equal(status0[0].committed, true);
  assert.equal(thrown.code, "committed");
  assert.match(thrown.message, /every file was written.*hoptell apply --recover --finish/);
});

test("recovery removes only the temporary file its journal recorded; others are left and reported", { skip }, async (t) => {
  const { m, roots, plan } = await planned(t);
  const unrelated = path.join(m.dir.app, ".hoptell-apply-abcdef012345.tmp");
  let swapped = null;
  // The temporary file is replaced by another file at the same name (another inode) mid-write.
  const pause = (step) => {
    if (step !== "temp-written-0") return;
    swapped = fs.readdirSync(m.dir.app).find((n) => /^\.hoptell-apply-[0-9a-f]{12}\.tmp$/.test(n));
    fs.rmSync(path.join(m.dir.app, swapped));
    fs.writeFileSync(path.join(m.dir.app, swapped), "someone else's file\n");
    throw new Error("interrupted");
  };
  assert.throws(() => commit(plan, { home: m.home, pause }), /interrupted/);
  assert.ok(fs.existsSync(path.join(m.dir.app, swapped)), "the write's own cleanup leaves a file it did not create");
  assert.equal(fs.readFileSync(path.join(m.dir.app, swapped), "utf8"), "someone else's file\n");
  fs.writeFileSync(unrelated, "unrelated work from another home\n");
  const report = recover({ home: m.home, roots, choice: "roll-back" });
  assert.equal(report[0].resolved, true);
  assert.equal(fs.readFileSync(unrelated, "utf8"), "unrelated work from another home\n", "an unrecorded name like ours is never removed");
  assert.ok(fs.existsSync(path.join(m.dir.app, swapped)), "a recorded name with another identity is never removed");
  assert.deepEqual(report[0].left.sort(), [`app:${swapped}`, "app:.hoptell-apply-abcdef012345.tmp"].sort());
  assert.equal(read(m, "a.txt"), "before\n");
});

test("a journal naming a path inside .git is damaged: recovery keeps it and writes nothing", { skip }, async (t) => {
  const { m, roots, plan } = await planned(t);
  assert.throws(() => commit(plan, { home: m.home, pause: (s) => { if (s === "done-0") throw new Error("interrupted"); } }), /interrupted/);
  const dir = path.join(m.home, "apply", journalDirs(m)[0]);
  const j = JSON.parse(fs.readFileSync(path.join(dir, "journal.json"), "utf8"));
  j.targets[0].path = ".Git/config";
  writeDurable(path.join(dir, "journal.json"), JSON.stringify(j));
  const report = recover({ home: m.home, roots, choice: "roll-back" });
  assert.equal(report[0].resolved, false);
  assert.match(report[0].note, /damaged/);
  assert.equal(journalDirs(m).length, 1);
  assert.equal(read(m, "a.txt"), "after\n");
});

test("the preview states how the review set's recipient was bound, and the weaker legacy check as such", { skip }, async (t) => {
  const { plan } = await planned(t); // the stand-in relay names no recipient: legacy
  assert.equal(plan.set.recipient.auth, "legacy");
  assert.match(renderPreview(plan), /did not name its recipient \(an older relay\), so this is the weaker check: any authenticated sender named "alex" in this realm is accepted, not one bound member/);
  const id = "m_aaaaaaaaaaaaaaaaaaaaaaaaaa";
  const m = machine(t, { app: { "a.txt": "x\n" } }, { recipient: { auth: "member", member: { id, name: "alex" } } });
  const sent = await m.call("send_review_set", { to: "alex", files: [{ root: "app", path: "a.txt" }], request: "r" });
  const p = proposal(sent, [{ file_id: "f1", base_sha256: sent.files[0].sha256, kind: "replace", text: "y\n" }]);
  assert.equal(await receive(m, p, fromAlex(JSON.stringify(p), { sender: { auth: "member", realm: REALM, member: { id, name: "alex" } } })), "stored");
  const roots = openApprovedRoots(m.setting);
  t.after(() => closeRoots(roots));
  assert.match(renderPreview(prepare({ home: m.home, roots, id: p.proposal_id })), new RegExp(`went to member ${id}, as the relay confirmed; only that member's replies are accepted`));
});

test("a crash in recovery's own commit point: the apply is committed; a later roll-back is refused", { skip }, async (t) => {
  const { m, id } = await twoFiles(t);
  await crash(await pausedAt(m, "done-0", ["apply", id, "--yes"]));
  await crash(await pausedAt(m, "recovered-complete", ["apply", "--recover", "--finish"]));
  const r = await cli(m.env, ["apply", "--recover", "--roll-back"]);
  assert.equal(r.code, 1, r.stdout);
  assert.match(r.stdout, /already committed/);
  assert.deepEqual([read(m, "a.txt"), read(m, "dir/b.sh")], ["A2\n", "B2\n"]);
  assert.equal(journalDirs(m).length, 0);
  assert.match((await cli(m.env, ["apply"])).stdout, /No proposals are waiting/);
});
