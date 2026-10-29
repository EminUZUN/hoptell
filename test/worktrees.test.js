// Implementer worktrees (design 8, topic 2): hoptell worktree add | list | diff | commit | remove on
// the controlled git runner. Temporary repositories and homes only; every helper a hostile
// configuration could start writes a canary file, and the tests assert that none appears.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { BIN } from "../lib/config.js";
import { controlledGit, findGit } from "../lib/gitsafe.js";
import { parseLsofCwds, processCwds, processIdentity } from "../lib/host.js";
import { withLock } from "../lib/locks.js";
import { addWorktree, checkOwns, commitWorktree, diffWorktree, globRe, keyAllowed, listWorktrees, memberState, readWorktreeRecord, recordProblem, removeWorktree, startMemberSession, worktreeAt, worktreePaths, worktreePins } from "../lib/worktrees.js";
import { sleep } from "./helpers.js";

// Git for setting up the test repositories: no system or global configuration of the developer's.
const gitEnv = { PATH: process.env.PATH, HOME: os.tmpdir(), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", LC_ALL: "C" };
const git = (cwd, ...args) => execFileSync("git", args, { cwd, env: gitEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** A repository with one commit (lib/, test/, README.md), its identity in its own config, and a home. */
function setup(t, { identity = true } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hoptell-wt-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo");
  fs.mkdirSync(path.join(repo, "lib"), { recursive: true });
  fs.mkdirSync(path.join(repo, "test"));
  git(repo, "init", "-q", "-b", "main");
  if (identity) {
    git(repo, "config", "user.name", "Lead Tester");
    git(repo, "config", "user.email", "lead@example.com");
  }
  fs.writeFileSync(path.join(repo, "lib", "x.js"), "export const x = 1;\n");
  fs.writeFileSync(path.join(repo, "test", "x.test.js"), "// test\n");
  fs.writeFileSync(path.join(repo, "README.md"), "# repo\n");
  git(repo, "add", "-A");
  git(repo, "-c", "user.name=Setup", "-c", "user.email=setup@example.com", "commit", "-q", "-m", "init");
  const canary = path.join(root, "canary");
  return { root, repo, home: path.join(root, "home"), canary, wt: path.join(root, "repo-wt", "dana-impl-1") };
}

const add = (s, extra = {}) => addWorktree(s.home, { repo: s.repo, member: "dana-impl-1", team: "n1", cli: "codex", ...extra });
const refusal = async (fn, code, re) => {
  await assert.rejects(fn, (e) => {
    assert.equal(e.code, code, e.message);
    if (re) assert.match(e.message, re);
    return true;
  });
};

test("worktree add: a new branch team/<team>/<member> at the lead's HEAD, next to the repository, with a 0600 safety record", async (t) => {
  const s = setup(t);
  const head = git(s.repo, "rev-parse", "HEAD");
  const rec = await add(s, { owns: ["lib/**"] });
  assert.equal(rec.path, s.wt);
  assert.equal(rec.branch, "team/n1/dana-impl-1");
  assert.equal(rec.base, head);
  assert.equal(rec.head, head);
  assert.match(rec.base, /^[0-9a-f]{40}$/, "a full object id");
  assert.equal(rec.common, path.join(s.repo, ".git"));
  assert.ok(rec.gitdir.startsWith(path.join(s.repo, ".git", "worktrees")));
  assert.equal(git(s.wt, "rev-parse", "--abbrev-ref", "HEAD"), "team/n1/dana-impl-1");
  const file = path.join(s.home, "worktrees", "dana-impl-1.json");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(readWorktreeRecord(s.home, "dana-impl-1").rec, rec);
  assert.equal(worktreeAt(s.home, s.wt)?.member, "dana-impl-1");
  assert.equal(worktreeAt(s.home, s.repo), null);
  assert.deepEqual(listWorktrees(s.home).map((r) => [r.member, r.exists]), [["dana-impl-1", true]]);
  // --folder and --base.
  git(s.repo, "-c", "user.name=a", "-c", "user.email=b", "commit", "-q", "--allow-empty", "-m", "second");
  const other = await addWorktree(s.home, { repo: s.repo, member: "dana-impl-2", team: "n1", cli: "claude", folder: "parser", base: head });
  assert.equal(other.path, path.join(s.root, "repo-wt", "parser"));
  assert.equal(other.base, head);
  // From a linked worktree, the location still follows the main repository.
  const third = await addWorktree(s.home, { repo: s.wt, member: "dana-impl-3", team: "n1", cli: "codex" });
  assert.equal(third.path, path.join(s.root, "repo-wt", "dana-impl-3"));
  assert.equal(third.base, head, "the base is the HEAD of the folder it was run from");
});

test("worktree add refuses: no repository, a dirty tree, an existing branch, folder or member, bad names, agy, no identity", async (t) => {
  const s = setup(t);
  await refusal(() => addWorktree(s.home, { repo: s.root, member: "dana-impl-1", team: "n1", cli: "codex" }), "not_a_repository");
  await refusal(() => addWorktree(s.home, { repo: path.join(s.root, "nope"), member: "dana-impl-1", team: "n1", cli: "codex" }), "not_a_repository");
  await refusal(() => add(s, { cli: "agy" }), "not_offered", /agy implementers are not offered/);
  await refusal(() => add(s, { cli: "gemini" }), "bad_cli");
  await refusal(() => add(s, { team: "N1" }), "bad_team");
  await refusal(() => add(s, { team: "../x" }), "bad_team");
  await assert.rejects(() => add(s, { member: "../evil" }), /invalid member name/);
  await refusal(() => add(s, { folder: "../out" }), "bad_folder");
  await refusal(() => add(s, { owns: ["/etc/**"] }), "bad_owns");
  await refusal(() => add(s, { owns: ["lib/../../x"] }), "bad_owns");
  await refusal(() => add(s, { base: "no-such-commit" }), "bad_base");
  // A tracked change in the lead's tree would not be in the worktree.
  fs.writeFileSync(path.join(s.repo, "README.md"), "changed\n");
  await refusal(() => add(s), "dirty_tree", /uncommitted changes/);
  assert.ok(!fs.existsSync(s.wt));
  const base = git(s.repo, "rev-parse", "HEAD");
  await add(s, { base }); // an explicit base is the lead's choice
  fs.writeFileSync(path.join(s.repo, "README.md"), "# repo\n");
  await refusal(() => add(s), "member_exists");
  await refusal(() => add(s, { member: "dana-impl-2", folder: "dana-impl-1" }), "path_exists");
  git(s.repo, "branch", "team/n1/dana-impl-3");
  await refusal(() => add(s, { member: "dana-impl-3" }), "branch_exists", /does not reuse a branch/);
  const bare = setup(t, { identity: false });
  await refusal(() => add(bare), "no_identity", /git config user\.name/);
  assert.equal(listWorktrees(bare.home).length, 0);
});

test("worktree commit: plumbing, every change of the worktree on its branch; modes, links and deletions; the index follows", async (t) => {
  const s = setup(t);
  const rec = await add(s, { owns: ["lib/**", "test/**"] });
  fs.writeFileSync(path.join(s.wt, "lib", "x.js"), "export const x = 2;\n");
  fs.writeFileSync(path.join(s.wt, "lib", "run.sh"), "#!/bin/sh\n", { mode: 0o755 });
  fs.symlinkSync("x.js", path.join(s.wt, "lib", "link"));
  fs.mkdirSync(path.join(s.wt, "lib", "deep", "er"), { recursive: true });
  fs.writeFileSync(path.join(s.wt, "lib", "deep", "er", "new.js"), "new\n");
  fs.rmSync(path.join(s.wt, "test", "x.test.js"));
  const r = await commitWorktree(s.home, "dana-impl-1", { message: "first change" });
  assert.match(r.commit, /^[0-9a-f]{40}$/);
  assert.deepEqual(r.files.sort(), ["lib/deep/er/new.js", "lib/link", "lib/run.sh", "lib/x.js", "test/x.test.js"]);
  assert.equal(git(s.repo, "rev-parse", "team/n1/dana-impl-1"), r.commit);
  assert.equal(git(s.repo, "rev-parse", `${r.commit}^`), rec.base);
  const tree = git(s.repo, "ls-tree", "-r", r.commit);
  assert.match(tree, /^120000 blob \S+\tlib\/link$/m);
  assert.match(tree, /^100755 blob \S+\tlib\/run\.sh$/m);
  assert.doesNotMatch(tree, /test\/x\.test\.js/);
  assert.equal(git(s.repo, "show", `${r.commit}:lib/link`), "x.js");
  assert.equal(git(s.repo, "log", "-1", "--format=%an <%ae>|%s", r.commit), "Lead Tester <lead@example.com>|first change");
  assert.doesNotMatch(git(s.repo, "cat-file", "commit", r.commit), /gpgsig/);
  assert.equal(git(s.wt, "status", "--porcelain"), "", "the worktree's index follows the new head");
  const after = readWorktreeRecord(s.home, "dana-impl-1").rec;
  assert.equal(after.head, r.commit);
  assert.equal(after.commits.length, 1);
  await refusal(() => commitWorktree(s.home, "dana-impl-1", { message: "again" }), "nothing_to_commit");
  await refusal(() => commitWorktree(s.home, "dana-impl-1", { message: "  " }), "no_message");
  // The diff of the member's commits: base..head, no external diff, no textconv.
  const d = await diffWorktree(s.home, "dana-impl-1");
  assert.equal(d.base, rec.base);
  assert.equal(d.head, r.commit);
  assert.match(d.text, /^diff --git a\/lib\/x\.js b\/lib\/x\.js$/m);
  assert.match(d.text, /^\+export const x = 2;$/m);
  assert.match((await diffWorktree(s.home, "dana-impl-1", { stat: true })).text, /5 files changed/);
});

test("worktree commit refuses files outside owns: changed, renamed and pre-staged paths; --allow-outside commits them", async (t) => {
  const s = setup(t);
  await add(s, { owns: ["lib/**"] });
  fs.writeFileSync(path.join(s.wt, "README.md"), "outside\n");
  await refusal(() => commitWorktree(s.home, "dana-impl-1", { message: "m" }), "outside_owns", /README\.md/);
  git(s.wt, "checkout", "--", "README.md");
  // A rename out of owns: both paths count.
  git(s.wt, "mv", "lib/x.js", "docs-x.js");
  await refusal(() => commitWorktree(s.home, "dana-impl-1", { message: "m" }), "outside_owns", /docs-x\.js/);
  git(s.wt, "mv", "docs-x.js", "lib/x.js");
  // Pre-staged: the implementer's own index holds a file outside owns.
  fs.writeFileSync(path.join(s.wt, "staged.txt"), "staged\n");
  git(s.wt, "add", "staged.txt");
  await refusal(() => commitWorktree(s.home, "dana-impl-1", { message: "m" }), "outside_owns", /staged\.txt/);
  // What is committed is the worktree's content, never what was staged.
  fs.rmSync(path.join(s.wt, "staged.txt"));
  fs.writeFileSync(path.join(s.wt, "lib", "x.js"), "worktree content\n");
  const r = await commitWorktree(s.home, "dana-impl-1", { message: "m" });
  assert.deepEqual(r.files, ["lib/x.js"]);
  assert.equal(git(s.repo, "show", `${r.commit}:lib/x.js`), "worktree content");
  fs.writeFileSync(path.join(s.wt, "README.md"), "outside\n");
  const out = await commitWorktree(s.home, "dana-impl-1", { message: "m2", allowOutside: true });
  assert.deepEqual(out.outside, ["README.md"]);
});

test("worktree commit refuses paths through a symbolic link and nested repositories", async (t) => {
  const s = setup(t);
  await add(s);
  const elsewhere = path.join(s.root, "elsewhere");
  fs.mkdirSync(elsewhere);
  fs.writeFileSync(path.join(elsewhere, "x.js"), "outside the worktree\n");
  fs.rmSync(path.join(s.wt, "lib"), { recursive: true });
  fs.symlinkSync(elsewhere, path.join(s.wt, "lib"));
  await refusal(() => commitWorktree(s.home, "dana-impl-1", { message: "m" }), "outside_worktree", /symbolic link/);
  fs.rmSync(path.join(s.wt, "lib"));
  git(s.wt, "checkout", "--", "lib");
  git(path.join(s.wt), "init", "-q", "nested");
  fs.writeFileSync(path.join(s.wt, "nested", "f"), "f\n");
  await refusal(() => commitWorktree(s.home, "dana-impl-1", { message: "m" }), "not_a_file", /nested repository/);
  assert.equal(git(s.repo, "rev-parse", "team/n1/dana-impl-1"), readWorktreeRecord(s.home, "dana-impl-1").rec.base, "nothing was committed");
});

test("worktree: hostile configuration is refused or runs nothing (hooks, filters, textconv, includes, attributes)", async (t) => {
  const s = setup(t);
  const touch = `sh -c 'touch ${s.canary}; cat'`;
  // A tracked .gitattributes selecting a filter and a diff driver (defined nowhere yet).
  fs.writeFileSync(path.join(s.repo, ".gitattributes"), "* filter=evil diff=evil\n");
  git(s.repo, "add", ".gitattributes");
  git(s.repo, "commit", "-q", "-m", "attributes");
  // Hooks: the repository's own hooks folder, with the hooks a checkout and a commit would run.
  for (const h of ["post-checkout", "pre-commit", "post-commit", "reference-transaction", "post-index-change"]) fs.writeFileSync(path.join(s.repo, ".git", "hooks", h), `#!/bin/sh\ntouch ${s.canary}\n`, { mode: 0o755 });
  await add(s);
  fs.writeFileSync(path.join(s.wt, "lib", "x.js"), "changed\n");
  const r = await commitWorktree(s.home, "dana-impl-1", { message: "with hooks present" });
  await diffWorktree(s.home, "dana-impl-1");
  assert.ok(!fs.existsSync(s.canary), "a hook ran");
  assert.ok(r.commit);
  // Configuration that would select a program, in the repository's config or the worktree's.
  const rec = readWorktreeRecord(s.home, "dana-impl-1").rec;
  fs.writeFileSync(path.join(s.wt, "lib", "x.js"), "changed again\n");
  for (const [file, key, value] of [
    [path.join(s.repo, ".git", "config"), "filter.evil.clean", touch],
    [path.join(s.repo, ".git", "config"), "diff.evil.textconv", touch],
    [path.join(s.repo, ".git", "config"), "include.path", path.join(s.root, "other.gitconfig")],
    [path.join(s.repo, ".git", "config"), "core.fsmonitor", touch],
    [path.join(s.repo, ".git", "config"), "gpg.ssh.program", touch],
    [path.join(rec.gitdir, "config.worktree"), "filter.evil.smudge", touch],
    [path.join(rec.gitdir, "config.worktree"), "core.hooksPath", s.root],
  ]) {
    git(s.repo, "config", "--file", file, key, value);
    await refusal(() => commitWorktree(s.home, "dana-impl-1", { message: "m" }), "config_not_allowed", new RegExp(key.replace(/\./g, "\\."), "i"));
    await refusal(async () => diffWorktree(s.home, "dana-impl-1"), "config_not_allowed");
    await refusal(() => removeWorktree(s.home, "dana-impl-1"), "config_not_allowed");
    git(s.repo, "config", "--file", file, "--unset-all", key);
  }
  // The repository's own attributes file: a driver there is refused at add, a change is drift.
  fs.writeFileSync(path.join(s.repo, ".git", "info", "attributes"), "* -text\n");
  await refusal(() => commitWorktree(s.home, "dana-impl-1", { message: "m" }), "attributes_changed");
  fs.rmSync(path.join(s.repo, ".git", "info", "attributes"));
  await commitWorktree(s.home, "dana-impl-1", { message: "clean again" });
  fs.writeFileSync(path.join(s.repo, ".git", "info", "attributes"), "*.js filter=evil\n");
  await refusal(() => add(s, { member: "dana-impl-2" }), "attributes_not_allowed");
  fs.rmSync(path.join(s.repo, ".git", "info", "attributes"));
  git(s.repo, "config", "include.path", path.join(s.root, "other.gitconfig"));
  await refusal(() => add(s, { member: "dana-impl-2" }), "config_not_allowed", /include\.path/);
  assert.ok(!fs.existsSync(s.canary), "a helper ran");
});

test("worktree pins: the empty attribute tree keeps a filter selected by a tracked .gitattributes from running", (t) => {
  // The allow list refuses such a configuration first; this shows the pin on its own (hardening).
  const s = setup(t);
  git(s.repo, "config", "filter.evil.clean", `sh -c 'touch ${s.canary}; cat'`);
  fs.writeFileSync(path.join(s.repo, ".gitattributes"), "* filter=evil\n");
  fs.writeFileSync(path.join(s.repo, "lib", "x.js"), "changed\n");
  const scratch = path.join(s.root, "scratch");
  const empty = git(s.repo, "hash-object", "-t", "tree", "/dev/null");
  const pinned = controlledGit({ scratch, pins: worktreePins(empty) });
  assert.equal(pinned.run(["add", "-A"], s.repo).status, 0);
  assert.ok(!fs.existsSync(s.canary), "the filter ran with the pins");
  git(s.repo, "reset", "-q");
  const plain = controlledGit({ scratch });
  plain.run(["add", "-A"], s.repo);
  assert.ok(fs.existsSync(s.canary), "without attr.tree the filter runs (the test would prove nothing otherwise)");
});

test("worktree signing settings: SSH signing is recorded at add; a changed value, another format or a program is refused", async (t) => {
  const s = setup(t);
  for (const [k, v] of [["gpg.format", "ssh"], ["user.signingkey", "~/.ssh/id_ed25519.pub"], ["gpg.ssh.allowedSignersFile", "~/.ssh/allowed_signers"], ["commit.gpgsign", "true"], ["tag.gpgsign", "true"]]) git(s.repo, "config", k, v);
  const rec = await add(s);
  assert.deepEqual(rec.signing, { "gpg.format": ["ssh"], "user.signingkey": ["~/.ssh/id_ed25519.pub"], "gpg.ssh.allowedsignersfile": ["~/.ssh/allowed_signers"], "commit.gpgsign": ["true"], "tag.gpgsign": ["true"] });
  fs.writeFileSync(path.join(s.wt, "lib", "x.js"), "changed\n");
  const r = await commitWorktree(s.home, "dana-impl-1", { message: "unsigned working commit" });
  assert.doesNotMatch(git(s.repo, "cat-file", "commit", r.commit), /gpgsig/, "working commits on team/* stay unsigned");
  git(s.repo, "config", "user.signingkey", "~/.ssh/other.pub");
  await refusal(async () => diffWorktree(s.home, "dana-impl-1"), "signing_changed");
  git(s.repo, "config", "user.signingkey", "~/.ssh/id_ed25519.pub");
  await diffWorktree(s.home, "dana-impl-1");
  git(s.repo, "config", "gpg.format", "openpgp");
  await refusal(async () => diffWorktree(s.home, "dana-impl-1"), "signing_not_supported");
  await refusal(() => add(s, { member: "dana-impl-2" }), "signing_not_supported");
  // The main worktree's config.worktree is checked against the allow list; what the member reads
  // is the repository's config and its own config.worktree (see "the settings git copies").
  git(s.repo, "config", "extensions.worktreeConfig", "true");
  git(s.repo, "config", "--worktree", "user.email", "lead@example.com");
  git(s.repo, "config", "gpg.format", "ssh");
  const second = await add(s, { member: "dana-impl-3" });
  assert.deepEqual(second.signing, rec.signing);
  await diffWorktree(s.home, "dana-impl-3");
  git(s.repo, "config", "--worktree", "gpg.ssh.program", "/tmp/x");
  await refusal(() => add(s, { member: "dana-impl-4" }), "config_not_allowed", /gpg\.ssh\.program/);
  assert.ok(keyAllowed("remote.origin.url") && keyAllowed("branch.main.merge") && keyAllowed("core.filemode"));
  for (const k of ["core.hookspath", "core.sshcommand", "core.pager", "core.editor", "core.askpass", "core.worktree", "gpg.program", "gpg.ssh.program", "include.path", "includeif.onbranch:x.path", "filter.a.clean", "diff.a.textconv", "merge.a.driver", "alias.st"]) assert.ok(!keyAllowed(k), k);
});

test("worktree: every command fails closed without a matching record (names not ours, moved heads, a changed .git file)", async (t) => {
  const s = setup(t);
  for (const fn of [() => commitWorktree(s.home, "dana-impl-9", { message: "m" }), async () => diffWorktree(s.home, "dana-impl-9"), () => removeWorktree(s.home, "dana-impl-9")]) await refusal(fn, "no_record", /has no hoptell worktree/);
  await refusal(async () => diffWorktree(s.home, "../x"), "no_record", /not a member name/);
  // A worktree git made without hoptell is not ours either.
  git(s.repo, "worktree", "add", "-q", "-b", "team/n1/dana-impl-2", path.join(s.root, "repo-wt", "dana-impl-2"));
  await refusal(() => removeWorktree(s.home, "dana-impl-2"), "no_record");
  await add(s);
  // A commit made without hoptell moves the branch: hoptell commits only on the head it recorded.
  fs.writeFileSync(path.join(s.wt, "lib", "x.js"), "changed\n");
  git(s.wt, "-c", "user.name=a", "-c", "user.email=b", "-c", "core.hooksPath=/dev/null", "commit", "-q", "-am", "by hand");
  await refusal(() => commitWorktree(s.home, "dana-impl-1", { message: "m" }), "head_moved");
  await refusal(() => removeWorktree(s.home, "dana-impl-1"), "head_moved");
  git(s.wt, "reset", "-q", "--hard", "HEAD~1");
  // Another branch checked out in the worktree.
  git(s.wt, "checkout", "-q", "-b", "elsewhere");
  await refusal(async () => diffWorktree(s.home, "dana-impl-1"), "head_moved", /no longer on team\/n1\/dana-impl-1/);
  git(s.wt, "checkout", "-q", "team/n1/dana-impl-1");
  // The worktree's .git file points somewhere else.
  const dotgit = path.join(s.wt, ".git");
  const saved = fs.readFileSync(dotgit, "utf8");
  fs.writeFileSync(dotgit, `gitdir: ${path.join(s.repo, ".git")}\n`);
  await refusal(async () => diffWorktree(s.home, "dana-impl-1"), "record_mismatch");
  fs.writeFileSync(dotgit, saved);
  // A tampered record.
  const file = path.join(s.home, "worktrees", "dana-impl-1.json");
  const rec = JSON.parse(fs.readFileSync(file, "utf8"));
  fs.writeFileSync(file, JSON.stringify({ ...rec, member: "dana-impl-2" }), { mode: 0o600 });
  await refusal(async () => diffWorktree(s.home, "dana-impl-1"), "no_record", /not version 1 of this member's record/);
  fs.writeFileSync(file, JSON.stringify(rec));
  fs.chmodSync(file, 0o644);
  await refusal(async () => diffWorktree(s.home, "dana-impl-1"), "no_record", /other users/);
});

/** A stand-in for git that only leaves the canary: a refusal before any git call never starts it. */
function canaryGit(s) {
  const f = path.join(s.root, "canary-git");
  fs.writeFileSync(f, `#!/bin/sh\ntouch '${s.canary}'\nexit 1\n`, { mode: 0o755 });
  return f;
}

/** Git that reports another version and otherwise is the real one. */
function gitReporting(s, version) {
  const f = path.join(s.root, `git-${version}`);
  fs.writeFileSync(f, `#!/bin/sh\nfor a; do [ "$a" = --version ] && { echo "git version ${version}"; exit 0; }; done\nexec '${findGit()}' "$@"\n`, { mode: 0o755 });
  return f;
}

/** A process standing for a member's pane; stopped by its exact pid. */
function paneProcess(t, script = "sleep 60") {
  const c = spawn("sh", ["-c", script], { stdio: ["ignore", "pipe", "ignore"] });
  const exited = new Promise((r) => c.once("exit", r));
  const stop = async () => {
    try {
      process.kill(c.pid);
    } catch {}
    await exited;
  };
  t.after(stop);
  return { pid: c.pid, stdout: c.stdout, stop };
}

const startAs = (home, rec, pid) => startMemberSession(home, rec, () => ({ sessionId: "$7", pane: "%9", pid: String(pid) }));

test("worktree commands refuse while any member of the repository runs, whatever its CLI, before any git runs", async (t) => {
  const s = setup(t);
  await add(s, { cli: "claude" });
  const codex = await addWorktree(s.home, { repo: s.repo, member: "dana-impl-2", team: "n1", cli: "codex" });
  const p = paneProcess(t);
  await startAs(s.home, codex, p.pid);
  assert.equal(memberState(s.home, "dana-impl-2").state, "running");
  assert.equal(memberState(s.home, "dana-impl-1").state, "stopped", "never started with hoptell tmux");
  fs.writeFileSync(path.join(s.wt, "lib", "x.js"), "changed\n");
  fs.writeFileSync(path.join(codex.path, "lib", "x.js"), "codex change\n");
  const git = canaryGit(s);
  for (const fn of [
    () => commitWorktree(s.home, "dana-impl-1", { message: "m" }, { git }),
    () => commitWorktree(s.home, "dana-impl-2", { message: "m" }, { git }),
    () => diffWorktree(s.home, "dana-impl-1", {}, { git }),
    () => removeWorktree(s.home, "dana-impl-1", { git }),
    () => addWorktree(s.home, { repo: s.repo, member: "dana-impl-3", team: "n1", cli: "claude" }, { git }),
  ]) {
    await refusal(fn, "member_running", /dana-impl-2 \(codex\) is still running .* stop it, or let it quit/);
  }
  assert.ok(!fs.existsSync(s.canary), "git ran before the check");
  // A second session of the member does not start while the first runs.
  await refusal(() => startAs(s.home, codex, p.pid), "member_running", /an earlier session of dana-impl-2 is still running/);
  // Another repository's members do not count.
  const other = setup(t);
  assert.ok((await addWorktree(s.home, { repo: other.repo, member: "eve-impl-1", team: "n1", cli: "codex" })).path);
  // Once it stopped, every command runs.
  await p.stop();
  assert.equal(memberState(s.home, "dana-impl-2").state, "stopped");
  assert.ok((await commitWorktree(s.home, "dana-impl-1", { message: "m" })).commit);
  assert.ok((await commitWorktree(s.home, "dana-impl-2", { message: "m" })).commit);
  assert.match((await diffWorktree(s.home, "dana-impl-2")).text, /codex change/);
  // A repository deleted by hand leaves a record that still reads: it blocks nothing elsewhere.
  fs.rmSync(other.root, { recursive: true, force: true });
  assert.match(execFileSync(process.execPath, [BIN, "worktree", "list"], { env: { ...gitEnv, HOPTELL_HOME: s.home }, encoding: "utf8" }), /^eve-impl-1 .*\(missing\)/m);
  fs.writeFileSync(path.join(s.wt, "lib", "x.js"), "changed again\n");
  assert.ok((await commitWorktree(s.home, "dana-impl-1", { message: "m" })).commit);
  await refusal(async () => diffWorktree(s.home, "eve-impl-1"), "worktree_missing");
});

test("worktree member state: processes the session started still count after its pane's process exits", async (t) => {
  const s = setup(t);
  const rec = await add(s);
  const p = paneProcess(t, "sleep 60 & echo $!; wait");
  const kid = Number(await new Promise((r) => p.stdout.once("data", (d) => r(String(d).trim()))));
  t.after(() => {
    try {
      process.kill(kid);
    } catch {}
  });
  await startAs(s.home, rec, p.pid);
  assert.equal(memberState(s.home, "dana-impl-1", { persist: true }).state, "running");
  const session = JSON.parse(fs.readFileSync(path.join(s.home, "worktrees", "sessions", "dana-impl-1.json"), "utf8"));
  assert.equal(session.sessionId, "$7");
  assert.deepEqual(session.root, processIdentity(p.pid));
  assert.deepEqual(session.tree.map((x) => x.pid), [kid], "the descendant is recorded by identity");
  // The pane's process is gone; the process it started (now detached from it) still runs.
  await p.stop();
  assert.equal(memberState(s.home, "dana-impl-1").state, "running");
  await refusal(() => removeWorktree(s.home, "dana-impl-1"), "member_running");
  process.kill(kid);
  let state = "running";
  for (let i = 0; i < 100 && state !== "stopped"; i++, await sleep(50)) state = memberState(s.home, "dana-impl-1").state;
  assert.equal(state, "stopped");
  assert.equal((await removeWorktree(s.home, "dana-impl-1")).branchState, "deleted");
  assert.ok(!fs.existsSync(path.join(s.home, "worktrees", "sessions", "dana-impl-1.json")), "remove drops the session record");
});

test("worktree member state: any process of yours in a member's worktree counts as running; a lister error refuses; hoptell's own ancestors do not count", async (t) => {
  const s = setup(t);
  await add(s);
  fs.writeFileSync(path.join(s.wt, "lib", "x.js"), "changed\n");
  const git = canaryGit(s);
  // A fake process table: hoptell is 500, its parent (the lead's shell) 400.
  const table = () => new Map([[500, { pid: 500, ppid: 400, uid: 1, start: "a" }], [400, { pid: 400, ppid: 1, uid: 1, start: "b" }]]);
  const procs = (rows) => ({ table, self: 500, cwds: () => rows });
  // A tool command a daemon started in the worktree, parented anywhere.
  await refusal(() => commitWorktree(s.home, "dana-impl-1", { message: "m" }, { git, procs: procs([{ pid: 600, cwd: path.join(s.wt, "lib"), command: "codex-tool" }]) }), "member_running", /process 600 \(codex-tool\) runs in its worktree/);
  await refusal(() => commitWorktree(s.home, "dana-impl-1", { message: "m" }, { git, procs: procs(null) }), "member_unknown", /working folders of your processes could not be read/);
  await refusal(() => commitWorktree(s.home, "dana-impl-1", { message: "m" }, { git, procs: { ...procs([]), table: () => null } }), "member_unknown", /process table could not be read/);
  assert.ok(!fs.existsSync(s.canary), "git ran before the check");
  // hoptell and its ancestors may stand in the worktree; a sibling folder is not the worktree.
  const rows = [
    { pid: 500, cwd: s.wt, command: "node" },
    { pid: 400, cwd: path.join(s.wt, "lib"), command: "zsh" },
    { pid: 700, cwd: `${s.wt}-other`, command: "vim" },
    { pid: 701, cwd: s.repo, command: "zsh" },
  ];
  assert.ok((await commitWorktree(s.home, "dana-impl-1", { message: "m" }, { procs: procs(rows) })).commit);
  // The real lister sees a real process there.
  const c = spawn("sleep", ["60"], { cwd: s.wt, stdio: "ignore" });
  const exited = new Promise((r) => c.once("exit", r));
  t.after(() => {
    if (c.exitCode === null && c.signalCode === null) process.kill(c.pid);
  });
  fs.writeFileSync(path.join(s.wt, "lib", "x.js"), "changed again\n");
  await refusal(() => commitWorktree(s.home, "dana-impl-1", { message: "m" }), "member_running", new RegExp(`process ${c.pid} \\(sleep\\)`));
  assert.match(execFileSync(process.execPath, [BIN, "worktree", "list"], { env: { ...gitEnv, HOPTELL_HOME: s.home }, encoding: "utf8" }), /^dana-impl-1 {2}codex {2}running /m);
  process.kill(c.pid);
  await exited;
  assert.ok((await commitWorktree(s.home, "dana-impl-1", { message: "m" })).commit);
  // lsof -Fpcn output: parsed, or null when it is not what was asked for.
  assert.deepEqual(parseLsofCwds("p12\ncnode\nfcwd\nn/a b\np13\ncsh\nfcwd\nn/\n"), [{ pid: 12, cwd: "/a b", command: "node" }, { pid: 13, cwd: "/", command: "sh" }]);
  for (const bad of ["", "garbage\n", "p12\ncnode\n", "px\nn/a\n", "p12\nn/a\nt3\n"]) assert.equal(parseLsofCwds(bad), null, JSON.stringify(bad));
});

test("worktree member state: an unknown state refuses (unreadable processes, a malformed session record, another member's broken record)", async (t) => {
  const s = setup(t);
  const rec = await add(s);
  const p = paneProcess(t);
  await startAs(s.home, rec, p.pid);
  await p.stop();
  const git = canaryGit(s);
  fs.writeFileSync(path.join(s.wt, "lib", "x.js"), "changed\n");
  assert.equal(memberState(s.home, "dana-impl-1", { table: () => null }).state, "unknown");
  await refusal(() => commitWorktree(s.home, "dana-impl-1", { message: "m" }, { git, procs: { table: () => null } }), "member_unknown", /the process table could not be read/);
  await refusal(() => commitWorktree(s.home, "dana-impl-1", { message: "m" }, { git, procs: { state: () => "unknown" } }), "member_unknown", /could not be checked/);
  const file = path.join(s.home, "worktrees", "sessions", "dana-impl-1.json");
  const saved = fs.readFileSync(file, "utf8");
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(saved), root: null }));
  await refusal(async () => diffWorktree(s.home, "dana-impl-1", {}, { git }), "member_unknown", /could not be identified/);
  fs.writeFileSync(file, "{}");
  await refusal(async () => diffWorktree(s.home, "dana-impl-1", {}, { git }), "member_unknown", new RegExp(`malformed.*remove ${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  fs.writeFileSync(file, saved);
  // A record that cannot be read: its repository is unknown, so no command runs git.
  fs.writeFileSync(path.join(s.home, "worktrees", "eve-impl-1.json"), "{}", { mode: 0o600 });
  await refusal(() => commitWorktree(s.home, "dana-impl-1", { message: "m" }, { git }), "record_invalid", /eve-impl-1/);
  assert.ok(!fs.existsSync(s.canary), "git ran before the check");
  fs.rmSync(path.join(s.home, "worktrees", "eve-impl-1.json"));
  assert.ok((await commitWorktree(s.home, "dana-impl-1", { message: "m" })).commit);
});

test("worktree registry: a folder that cannot be listed refuses every command and launch lookup before any git runs", async (t) => {
  const s = setup(t);
  await add(s);
  fs.writeFileSync(path.join(s.wt, "lib", "x.js"), "changed\n");
  const dir = path.join(s.home, "worktrees");
  // Write and search, no read: each record still opens by name, but the folder does not list.
  fs.chmodSync(dir, 0o300);
  t.after(() => fs.existsSync(dir) && fs.chmodSync(dir, 0o700));
  const git = canaryGit(s);
  await refusal(() => commitWorktree(s.home, "dana-impl-1", { message: "m" }, { git }), "record_invalid", /could not be listed \(EACCES\)/);
  await refusal(async () => diffWorktree(s.home, "dana-impl-1", {}, { git }), "record_invalid");
  await refusal(() => removeWorktree(s.home, "dana-impl-1", { git }), "record_invalid");
  await refusal(() => addWorktree(s.home, { repo: s.repo, member: "dana-impl-2", team: "n1", cli: "codex" }, { git }), "record_invalid");
  assert.throws(() => worktreeAt(s.home, s.wt), (e) => e.code === "record_invalid");
  assert.throws(() => worktreeAt(s.home, s.root), (e) => e.code === "record_invalid", "not even outside any worktree");
  assert.ok(!fs.existsSync(s.canary), "git ran");
  fs.chmodSync(dir, 0o700);
  // An absent registry holds no worktrees.
  assert.deepEqual(listWorktrees(path.join(s.root, "fresh-home")), []);
  assert.ok((await commitWorktree(s.home, "dana-impl-1", { message: "m" })).commit);
});

test("worktree containment: a folder named ..cache inside a worktree is inside it; a sibling is not", async (t) => {
  const s = setup(t);
  await add(s);
  fs.mkdirSync(path.join(s.wt, "..cache", "sub"), { recursive: true });
  fs.mkdirSync(path.join(s.root, "repo-wt", "dana-impl-1x"));
  assert.equal(worktreeAt(s.home, path.join(s.wt, "..cache"))?.member, "dana-impl-1");
  assert.equal(worktreeAt(s.home, path.join(s.wt, "..cache", "sub"))?.member, "dana-impl-1");
  assert.equal(worktreeAt(s.home, path.join(s.root, "repo-wt", "dana-impl-1x")), null);
  assert.equal(worktreeAt(s.home, path.join(s.root, "repo-wt")), null);
  // The working-folder scan counts a process there.
  const procs = (cwd) => ({ table: () => new Map([[500, { pid: 500, ppid: 1, uid: 1, start: "a" }]]), self: 500, cwds: () => [{ pid: 600, cwd, command: "tool" }] });
  fs.writeFileSync(path.join(s.wt, "lib", "x.js"), "changed\n");
  await refusal(() => commitWorktree(s.home, "dana-impl-1", { message: "m" }, { procs: procs(path.join(s.wt, "..cache", "sub")) }), "member_running", /process 600 \(tool\) runs in its worktree.*if it is the implementer or something it started, quit it; if it is an unrelated shell of yours, cd out of the worktree/);
  assert.ok((await commitWorktree(s.home, "dana-impl-1", { message: "m" }, { procs: procs(path.join(s.root, "repo-wt", "dana-impl-1x")) })).commit);
});

test("worktree record changed while a command waited for the lock: diff and a stale launch refuse, nothing runs", async (t) => {
  const s = setup(t);
  const a = await add(s);
  // The same member name, registered in another repository: its record replaces the first one
  // while a command of the first repository waits for that repository's lock.
  const other = setup(t);
  const otherHome = path.join(other.root, "home");
  const b = await addWorktree(otherHome, { repo: other.repo, member: "dana-impl-1", team: "n1", cli: "codex" });
  const file = path.join(s.home, "worktrees", "dana-impl-1.json");
  const git = canaryGit(s);
  let pending;
  await withLock(worktreePaths(s.home).repoLock(a.common), async () => {
    pending = diffWorktree(s.home, "dana-impl-1", {}, { git });
    await sleep(100);
    fs.writeFileSync(file, fs.readFileSync(path.join(otherHome, "worktrees", "dana-impl-1.json")));
  });
  await refusal(() => pending, "record_changed", /changed while hoptell waited/);
  assert.ok(!fs.existsSync(s.canary), "git ran");
  // A launch that picked the lock by the old record does not start.
  let started = false;
  await refusal(
    () =>
      startMemberSession(s.home, a, () => {
        started = true;
      }),
    "record_changed",
  );
  assert.equal(started, false);
  assert.ok(!fs.existsSync(path.join(s.home, "worktrees", "sessions", "dana-impl-1.json")));
  assert.equal(readWorktreeRecord(s.home, "dana-impl-1").rec.common, b.common);
});

test("process working folders on Linux: a vanished process is skipped; a live one without a readable cwd makes the scan unknown", (t) => {
  const proc = fs.mkdtempSync(path.join(os.tmpdir(), "hoptell-proc-"));
  t.after(() => fs.rmSync(proc, { recursive: true, force: true }));
  const uid = process.getuid();
  fs.mkdirSync(path.join(proc, "100"));
  fs.symlinkSync("/work/repo-wt/dana-impl-1", path.join(proc, "100", "cwd"));
  fs.writeFileSync(path.join(proc, "100", "comm"), "codex\n");
  fs.mkdirSync(path.join(proc, "101")); // no readable cwd
  fs.mkdirSync(path.join(proc, "self"));
  const scan = (exists) => processCwds(uid, { platform: "linux", proc, exists });
  // 101 positively gone (kill(pid, 0) gives ESRCH): skipped.
  assert.deepEqual(scan((pid) => (pid === 101 ? false : true)), [{ pid: 100, cwd: "/work/repo-wt/dana-impl-1", command: "codex" }]);
  // 101 still alive, or not known to be gone: unknown.
  assert.equal(scan(() => true), null);
  assert.equal(scan(() => null), null);
  // Not known (kill gives neither answer) and its /proc entry cannot be checked: unknown, even
  // though the entry looks absent to a check that collapses errors.
  // The owner stat (first) succeeds; the absence check after the cwd read failure (second) fails.
  const { statSync, existsSync } = fs;
  let calls = 0;
  t.mock.method(fs, "statSync", (p, ...a) => {
    if (p === path.join(proc, "101") && ++calls === 2) throw Object.assign(new Error("EIO"), { code: "EIO" });
    return statSync(p, ...a);
  });
  assert.equal(scan(() => null), null);
  t.mock.restoreAll();
  // Still alive by kill(pid, 0) while a lookup of its /proc entry fails (an error-collapsing
  // existence check would say absent): unknown, never skipped.
  calls = 0;
  t.mock.method(fs, "existsSync", (p, ...a) => (p === path.join(proc, "101") ? false : existsSync(p, ...a)));
  t.mock.method(fs, "statSync", (p, ...a) => {
    if (p === path.join(proc, "101") && ++calls === 2) throw Object.assign(new Error("EACCES"), { code: "EACCES" });
    return statSync(p, ...a);
  });
  assert.equal(scan(() => true), null);
  t.mock.restoreAll();
  // Its /proc entry gone after the listing: skipped.
  fs.rmSync(path.join(proc, "101"), { recursive: true });
  assert.deepEqual(scan(() => true).map((r) => r.pid), [100]);
});

test("worktree records: every field is checked; a missing or malformed one refuses before any git runs", async (t) => {
  const s = setup(t);
  const rec = await add(s, { owns: ["lib/**"] });
  assert.equal(recordProblem(rec, "dana-impl-1"), null);
  const { owns, ...noOwns } = rec;
  assert.deepEqual(owns, ["lib/**"]);
  for (const [bad, re] of [
    [noOwns, /missing or unknown fields/],
    [{ ...rec, extra: 1 }, /missing or unknown fields/],
    [{ ...rec, owns: [] }, /malformed owns/],
    [{ ...rec, owns: ["/etc/**"] }, /malformed owns/],
    [{ ...rec, owns: "lib/**" }, /malformed owns/],
    [{ ...rec, cli: "agy" }, /team, CLI or branch/],
    [{ ...rec, branch: "main" }, /team, CLI or branch/],
    [{ ...rec, version: 2 }, /not version 1/],
    [{ ...rec, head: rec.head.slice(0, 12) }, /object id/],
    [{ ...rec, objectFormat: "md5" }, /object id/],
    [{ ...rec, repo: "repo" }, /absolute and canonical/],
    [{ ...rec, path: `${rec.path}/../dana-impl-1` }, /absolute and canonical/],
    [{ ...rec, gitdir: path.join(rec.common, "objects") }, /do not belong together/],
    [{ ...rec, signing: { "gpg.program": ["x"] } }, /signing/],
    [{ ...rec, signing: { "user.signingkey": "x" } }, /signing/],
    [{ ...rec, attributes: "abc" }, /attributes/],
    [{ ...rec, commits: [{ commit: "abc", tree: "abc", files: 1, at: "x" }] }, /commit list/],
    [{ ...rec, created: "yesterday" }, /creation time/],
  ]) {
    assert.match(recordProblem(bad, "dana-impl-1") ?? "", re, JSON.stringify(Object.keys(bad)));
  }
  // On disk: the record without owns refuses every command; git never runs.
  const file = path.join(s.home, "worktrees", "dana-impl-1.json");
  fs.writeFileSync(file, JSON.stringify(noOwns));
  fs.writeFileSync(path.join(s.wt, "README.md"), "outside owns\n");
  const git = canaryGit(s);
  await refusal(() => commitWorktree(s.home, "dana-impl-1", { message: "m" }, { git }), "no_record", /missing or unknown fields/);
  await refusal(() => addWorktree(s.home, { repo: s.repo, member: "dana-impl-2", team: "n1", cli: "codex" }, { git }), "record_invalid");
  assert.ok(!fs.existsSync(s.canary));
  assert.match(listWorktrees(s.home)[0].problem, /missing or unknown fields/);
  assert.throws(() => worktreeAt(s.home, s.wt), (e) => e.code === "record_invalid", "a broken record refuses the launch lookup");
});

test("worktree commit capture: a folder swapped for a link while it is read, a hard link and a leaf link are handled", async (t) => {
  const s = setup(t);
  await add(s);
  const elsewhere = path.join(s.root, "elsewhere");
  fs.mkdirSync(elsewhere);
  fs.writeFileSync(path.join(elsewhere, "x.js"), "outside the worktree\n");
  fs.writeFileSync(path.join(s.wt, "lib", "x.js"), "changed\n");
  // The capture pauses after opening lib/; another process swaps lib/ for a link meanwhile.
  const barrier = path.join(s.root, "barrier");
  fs.writeFileSync(`${barrier}.step`, "opened-lib");
  const swap = `const fs = require("fs"); const [b, wt, to] = process.argv.slice(1); const until = Date.now() + 10000;
(function poll() { if (fs.existsSync(b + ".at")) { fs.renameSync(wt + "/lib", wt + "/lib.real"); fs.symlinkSync(to, wt + "/lib"); fs.writeFileSync(b + ".go", ""); } else if (Date.now() < until) setTimeout(poll, 5); })();`;
  const swapper = spawn(process.execPath, ["-e", swap, barrier, s.wt, elsewhere], { stdio: "ignore" });
  const swapped = new Promise((r) => swapper.once("exit", r));
  t.after(() => swapper.exitCode === null && swapper.kill());
  await refusal(() => commitWorktree(s.home, "dana-impl-1", { message: "m" }, { captureBarrier: barrier }), "changed_during_capture");
  await swapped;
  assert.equal(fs.readFileSync(`${barrier}.at`, "utf8"), "opened-lib", "the swap happened at the pause");
  assert.equal(git(s.repo, "rev-parse", "team/n1/dana-impl-1"), readWorktreeRecord(s.home, "dana-impl-1").rec.base, "nothing was committed");
  fs.rmSync(path.join(s.wt, "lib"));
  fs.renameSync(path.join(s.wt, "lib.real"), path.join(s.wt, "lib"));
  // A second hard link could be a file from outside the worktree.
  fs.linkSync(path.join(elsewhere, "x.js"), path.join(s.wt, "lib", "hard.js"));
  await refusal(() => commitWorktree(s.home, "dana-impl-1", { message: "m" }), "hard_link", /lib\/hard\.js/);
  fs.rmSync(path.join(s.wt, "lib", "hard.js"));
  // A link as the last name is committed as a link: its target, never the file it points at.
  fs.symlinkSync(path.join(elsewhere, "x.js"), path.join(s.wt, "lib", "out.js"));
  const r = await commitWorktree(s.home, "dana-impl-1", { message: "m" });
  assert.deepEqual(r.files.sort(), ["lib/out.js", "lib/x.js"]);
  assert.match(git(s.repo, "ls-tree", r.commit, "lib/out.js"), /^120000 /);
  assert.equal(git(s.repo, "show", `${r.commit}:lib/out.js`), path.join(elsewhere, "x.js"));
  assert.equal(git(s.repo, "show", `${r.commit}:lib/x.js`), "changed");
});

test("worktree: Git older than 2.43 (attr.tree) is refused by every command", async (t) => {
  const s = setup(t);
  const old = gitReporting(s, "2.42.4");
  await refusal(() => addWorktree(s.home, { repo: s.repo, member: "dana-impl-1", team: "n1", cli: "codex" }, { git: old }), "git_too_old", /Git 2\.43 or later/);
  await add(s, { owns: null });
  fs.writeFileSync(path.join(s.wt, "lib", "x.js"), "changed\n");
  await refusal(() => commitWorktree(s.home, "dana-impl-1", { message: "m" }, { git: old }), "git_too_old");
  await refusal(async () => diffWorktree(s.home, "dana-impl-1", {}, { git: old }), "git_too_old");
  await refusal(() => removeWorktree(s.home, "dana-impl-1", { git: old }), "git_too_old");
  assert.ok((await commitWorktree(s.home, "dana-impl-1", { message: "m" }, { git: gitReporting(s, "2.43.0") })).commit);
});

test("worktree signing: the settings git copies into the member's config.worktree are recorded", async (t) => {
  const s = setup(t);
  git(s.repo, "config", "extensions.worktreeConfig", "true");
  for (const [k, v] of [["gpg.format", "ssh"], ["user.signingkey", "~/.ssh/lead.pub"], ["commit.gpgsign", "true"]]) git(s.repo, "config", "--worktree", k, v);
  const rec = await add(s);
  assert.match(fs.readFileSync(path.join(rec.gitdir, "config.worktree"), "utf8"), /signingkey = ~\/\.ssh\/lead\.pub/, "git copied the lead's config.worktree");
  assert.deepEqual(rec.signing, { "gpg.format": ["ssh"], "user.signingkey": ["~/.ssh/lead.pub"], "commit.gpgsign": ["true"] });
  fs.writeFileSync(path.join(s.wt, "lib", "x.js"), "changed\n");
  const r = await commitWorktree(s.home, "dana-impl-1", { message: "m" });
  assert.doesNotMatch(git(s.repo, "cat-file", "commit", r.commit), /gpgsig/);
  git(s.repo, "config", "--file", path.join(rec.gitdir, "config.worktree"), "user.signingkey", "~/.ssh/other.pub");
  await refusal(async () => diffWorktree(s.home, "dana-impl-1"), "signing_changed");
});

test("worktree remove: only clean worktrees; the branch is deleted only without commits (compare-and-delete), else kept", async (t) => {
  const s = setup(t);
  await add(s);
  fs.writeFileSync(path.join(s.wt, "new.txt"), "untracked\n");
  await refusal(() => removeWorktree(s.home, "dana-impl-1"), "dirty_tree", /new\.txt/);
  fs.rmSync(path.join(s.wt, "new.txt"));
  const r = await removeWorktree(s.home, "dana-impl-1");
  assert.equal(r.branchState, "deleted");
  assert.ok(!fs.existsSync(s.wt));
  assert.notEqual(spawnSync("git", ["rev-parse", "--verify", "-q", "team/n1/dana-impl-1"], { cwd: s.repo, env: gitEnv }).status, 0);
  assert.equal(listWorktrees(s.home).length, 0);
  await add(s);
  fs.writeFileSync(path.join(s.wt, "lib", "x.js"), "changed\n");
  const c = await commitWorktree(s.home, "dana-impl-1", { message: "m" });
  const kept = await removeWorktree(s.home, "dana-impl-1");
  assert.equal(kept.branchState, "kept");
  assert.equal(git(s.repo, "rev-parse", "team/n1/dana-impl-1"), c.commit);
});

test("owns globs", () => {
  assert.ok(globRe("lib/**").test("lib/a/b.js") && globRe("lib/**").test("lib/a.js"));
  assert.ok(!globRe("lib/*").test("lib/a/b.js"));
  assert.ok(globRe("**/*.md").test("README.md") && globRe("**/*.md").test("docs/x/y.md"));
  assert.ok(!globRe("lib/*.js").test("lib/a.jsx") && !globRe("lib/x.js").test("lib/xxjs"));
  assert.ok(globRe("test/?.js").test("test/a.js"));
  assert.equal(checkOwns(null), null);
  assert.throws(() => checkOwns([]), /1 to 64 globs/);
  assert.throws(() => checkOwns(["a\\b"]), /not a glob/);
});

test("hoptell worktree: the command line (list, add, commit, diff, remove, usage errors)", async (t) => {
  const s = setup(t);
  const cli = (...args) => spawnSync(process.execPath, [BIN, "worktree", ...args], { cwd: s.repo, env: { ...gitEnv, HOPTELL_HOME: s.home, TMUX_TMPDIR: s.root }, encoding: "utf8" });
  assert.equal(cli("list").stdout.trim(), "No hoptell worktrees.");
  const a = cli("add", "dana-impl-1", "--team", "n1", "--cli", "codex", "--owns", "lib/**,test/**");
  assert.equal(a.status, 0, a.stderr);
  assert.match(a.stdout, new RegExp(`Worktree for dana-impl-1: ${s.wt}`));
  assert.match(a.stdout, /hoptell tmux dana-impl-1 --cwd \S+ --task <file>/);
  assert.match(cli("list").stdout, /^dana-impl-1 {2}codex {2}stopped {2}team\/n1\/dana-impl-1 .* 0 commits {2}owns lib\/\*\*,test\/\*\*$/m);
  fs.writeFileSync(path.join(s.wt, "lib", "x.js"), "changed\n");
  const c = cli("commit", "dana-impl-1", "-m", "from the cli");
  assert.equal(c.status, 0, c.stderr);
  assert.match(c.stdout, /^[0-9a-f]{40} {2}team\/n1\/dana-impl-1 {2}1 file$/m);
  const d = cli("diff", "dana-impl-1");
  assert.match(d.stdout, /^# team\/n1\/dana-impl-1 [0-9a-f]{40}\.\.[0-9a-f]{40}$/m);
  assert.match(d.stdout, /^\+changed$/m);
  const r = cli("remove", "dana-impl-1");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /branch team\/n1\/dana-impl-1 kept at [0-9a-f]{40}/);
  for (const [args, re] of [
    [[], /worktree needs a command/],
    [["frob"], /unknown worktree command "frob"/],
    [["add"], /worktree add needs a member name/],
    [["add", "dana-impl-2"], /needs --team and --cli/],
    [["commit", "dana-impl-2"], /needs -m <message>/],
    [["commit", "dana-impl-2", "-m", ""], /-m needs a message/],
    [["diff", "a", "b"], /unexpected argument "b"/],
  ]) {
    const u = cli(...args);
    assert.equal(u.status, 2, `${args.join(" ")}: ${u.stderr}`);
    assert.match(u.stderr, re);
  }
  const unknown = cli("diff", "dana-impl-1", "--bogus");
  assert.equal(unknown.status, 2);
  const missing = cli("diff", "dana-impl-1");
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /dana-impl-1 has no hoptell worktree/);
});
