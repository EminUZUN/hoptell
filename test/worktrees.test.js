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
import { currentBoot, parseLsofCwds, processCwds, processCwdsScan, processIdentity, processTable } from "../lib/host.js";
import { withLock } from "../lib/locks.js";
import { addWorktree, checkOwns, commitWorktree, diffWorktree, globRe, keyAllowed, listWorktrees, memberState, processIn, readWorktreeRecord, recordProblem, removeWorktree, startMemberSession, worktreeAt, worktreePaths, worktreePins } from "../lib/worktrees.js";
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

test("worktree commit takes a type change in one commit: a file replaced by a folder, a folder replaced by a file; a nested repository in a file's place is still refused", async (t) => {
  const s = setup(t);
  await add(s);
  // A file replaced by a folder.
  fs.rmSync(path.join(s.wt, "README.md"));
  fs.mkdirSync(path.join(s.wt, "README.md"));
  fs.writeFileSync(path.join(s.wt, "README.md", "a.txt"), "a\n");
  const r1 = await commitWorktree(s.home, "dana-impl-1", { message: "file to folder" });
  assert.deepEqual(r1.files, ["README.md", "README.md/a.txt"]);
  assert.equal(git(s.repo, "cat-file", "-t", `${r1.commit}:README.md`), "tree");
  assert.equal(git(s.repo, "show", `${r1.commit}:README.md/a.txt`), "a");
  assert.equal(git(s.wt, "status", "--porcelain"), "");
  // A folder replaced by a file.
  fs.rmSync(path.join(s.wt, "lib"), { recursive: true });
  fs.writeFileSync(path.join(s.wt, "lib"), "now a file\n");
  const r2 = await commitWorktree(s.home, "dana-impl-1", { message: "folder to file" });
  assert.deepEqual(r2.files, ["lib", "lib/x.js"]);
  assert.equal(git(s.repo, "cat-file", "-t", `${r2.commit}:lib`), "blob");
  assert.equal(git(s.repo, "show", `${r2.commit}:lib`), "now a file");
  assert.equal(git(s.wt, "status", "--porcelain"), "");
  // A nested repository where a tracked file was: refused, nothing committed.
  fs.rmSync(path.join(s.wt, "lib"));
  git(s.wt, "init", "-q", "lib");
  fs.writeFileSync(path.join(s.wt, "lib", "f"), "f\n");
  await refusal(() => commitWorktree(s.home, "dana-impl-1", { message: "m" }), "not_a_file", /nested repository/);
  assert.equal(git(s.repo, "rev-parse", "team/n1/dana-impl-1"), r2.commit, "nothing was committed");
});

test("worktree commit refuses a nested repository in a tracked folder's place: a kept file name, a new file, a .git file or a dangling .git link, the old name gone; a plain folder change still commits", async (t) => {
  const s = setup(t);
  await add(s);
  const head = () => [git(s.repo, "rev-parse", "team/n1/dana-impl-1"), readWorktreeRecord(s.home, "dana-impl-1").rec.head];
  const before = head();
  const nested = (form) => {
    fs.rmSync(path.join(s.wt, "lib"), { recursive: true });
    if (form === "folder" || form === "no old name") git(s.wt, "init", "-q", "lib");
    else {
      fs.mkdirSync(path.join(s.wt, "lib"));
      if (form === "file") fs.writeFileSync(path.join(s.wt, "lib", ".git"), "gitdir: /nowhere\n");
      else fs.symlinkSync(path.join(s.root, "nowhere"), path.join(s.wt, "lib", ".git")); // dangling
    }
    if (form !== "no old name") fs.writeFileSync(path.join(s.wt, "lib", "x.js"), "the nested repository's own\n"); // the tracked name kept
    fs.writeFileSync(path.join(s.wt, "lib", "f"), "f\n"); // a new file
  };
  for (const form of ["folder", "file", "dangling link", "no old name"]) {
    nested(form);
    await refusal(() => commitWorktree(s.home, "dana-impl-1", { message: "m" }), "not_a_file", /lib\/(x\.js|f) is a folder \(a nested repository/);
    assert.deepEqual(head(), before, `${form}: nothing was committed`);
    fs.rmSync(path.join(s.wt, "lib"), { recursive: true });
    git(s.wt, "checkout", "--", "lib");
  }
  // A plain folder below the root: a file there replaced by a folder, and a new nested folder.
  fs.rmSync(path.join(s.wt, "lib", "x.js"));
  fs.mkdirSync(path.join(s.wt, "lib", "x.js", "deep"), { recursive: true });
  fs.writeFileSync(path.join(s.wt, "lib", "x.js", "deep", "a.js"), "a\n");
  const r = await commitWorktree(s.home, "dana-impl-1", { message: "nested folder change" });
  assert.deepEqual(r.files, ["lib/x.js", "lib/x.js/deep/a.js"]);
  assert.equal(git(s.repo, "show", `${r.commit}:lib/x.js/deep/a.js`), "a");
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
// "exec": with a shell that forks even a single command (dash, Ubuntu's sh), stopping the shell
// would leave its sleep running as a process the session started.
function paneProcess(t, script = "exec sleep 60") {
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

/** For a failing assertion: the member's state and reason, and every process its session record names. */
function explain(home, member, st) {
  let rec = null;
  try {
    rec = JSON.parse(fs.readFileSync(path.join(home, "worktrees", "sessions", `${member}.json`), "utf8"));
  } catch {}
  const ids = rec ? [rec.root, ...rec.tree].filter(Boolean) : [];
  const ps = ids.map((id) => {
    const r = spawnSync("ps", ["-o", "pid=,ppid=,stat=,args=", "-p", String(id.pid)], { encoding: "utf8" });
    return `${JSON.stringify(id)} -> ${r.stdout.trim() || "(not running)"}`;
  });
  return `${JSON.stringify(st)}; recorded: ${ps.join(" | ") || "none"}`;
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
  const after = memberState(s.home, "dana-impl-2");
  assert.equal(after.state, "stopped", explain(s.home, "dana-impl-2", after));
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
  fs.writeFileSync(path.join(proc, "101", "stat"), "101 (codex) S 1 101 101 0 -1\n"); // a live, running process
  fs.mkdirSync(path.join(proc, "self"));
  const scan = (exists) => processCwds(uid, { platform: "linux", proc, exists, pause: () => {} });
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

test("process working folders on Linux: a live process that refuses its cwd to its own user (EACCES, EPERM) is listed as unreadable; EIO and a missing cwd stay unknown", (t) => {
  const proc = fs.mkdtempSync(path.join(os.tmpdir(), "hoptell-proc-"));
  t.after(() => fs.rmSync(proc, { recursive: true, force: true }));
  const uid = process.getuid();
  fs.mkdirSync(path.join(proc, "100"));
  fs.symlinkSync("/work/repo-wt/dana-impl-1", path.join(proc, "100", "cwd"));
  fs.writeFileSync(path.join(proc, "100", "comm"), "codex\n");
  for (const [n, comm] of [["200", "systemd"], ["201", "sshd"]]) {
    fs.mkdirSync(path.join(proc, n));
    fs.symlinkSync("/", path.join(proc, n, "cwd"));
    fs.writeFileSync(path.join(proc, n, "comm"), `${comm}\n`);
    fs.writeFileSync(path.join(proc, n, "stat"), statLine(n, comm, "S", { start: Number(n) * 10 }));
  }
  const { readlinkSync } = fs;
  const failing = new Map(); // pid folder -> error code of its cwd
  t.mock.method(fs, "readlinkSync", (p, ...a) => {
    const code = failing.get(path.basename(path.dirname(String(p))));
    if (code) throw Object.assign(new Error(code), { code });
    return readlinkSync(p, ...a);
  });
  const scan = (exists = () => true) => processCwdsScan(uid, { platform: "linux", proc, exists, pause: () => {} });
  failing.set("200", "EACCES").set("201", "EPERM");
  assert.deepEqual(scan(), {
    rows: [{ pid: 100, cwd: "/work/repo-wt/dana-impl-1", command: "codex" }],
    unreadable: [
      { pid: 200, uid, start: "2000", command: "systemd" },
      { pid: 201, uid, start: "2010", command: "sshd" },
    ],
  });
  // Gone by kill(pid, 0): skipped, not listed.
  assert.deepEqual(scan((pid) => pid !== 200).unreadable, [{ pid: 201, uid, start: "2010", command: "sshd" }]);
  // Its start as that very stat gives it; none when the stat has no start field.
  fs.writeFileSync(path.join(proc, "201", "stat"), "201 (sshd) S 1 201 201 0 -1\n");
  assert.equal(scan().unreadable.find((u) => u.pid === 201).start, null);
  fs.writeFileSync(path.join(proc, "201", "stat"), statLine("201", "sshd", "S", { start: 2010 }));
  // Any other error on a live process is unknown, and so is an EACCES whose process cannot be told.
  failing.set("201", "EIO");
  assert.equal(scan().rows, null);
  failing.set("201", "ENOENT");
  assert.equal(scan().rows, null);
  failing.set("201", "EACCES");
  assert.equal(scan((pid) => (pid === 201 ? null : true)).rows, null);
});

// A /proc/<pid>/stat line: after the command, [0] state, [1] ppid, [17] num_threads, [19] start.
const statLine = (n, comm, state, { threads = 1, start = 1000 } = {}) => {
  const f = Array(22).fill("0");
  Object.assign(f, { 0: state, 1: "1", 2: n, 3: n, 17: String(threads), 19: String(start) });
  return `${n} (${comm}) ${f.join(" ")}\n`;
};

test("process working folders on Linux: an exited group (state Z or X, one thread, every task exited) without a cwd is skipped; a zombie leader whose threads run, or a live process, stays unknown", (t) => {
  const proc = fs.mkdtempSync(path.join(os.tmpdir(), "hoptell-proc-"));
  t.after(() => fs.rmSync(proc, { recursive: true, force: true }));
  const uid = process.getuid();
  fs.mkdirSync(path.join(proc, "100"));
  fs.symlinkSync("/work", path.join(proc, "100", "cwd"));
  // tasks: tid -> state of /proc/300/task/<tid>/stat (null: no task folder at all).
  const entry = (n, stat, tasks = { [n]: "Z" }) => {
    fs.rmSync(path.join(proc, n), { recursive: true, force: true });
    fs.mkdirSync(path.join(proc, n)); // no cwd, as for an exited process
    if (stat !== null) fs.writeFileSync(path.join(proc, n, "stat"), stat);
    if (tasks !== null) fs.mkdirSync(path.join(proc, n, "task"));
    for (const [tid, st] of Object.entries(tasks ?? {})) {
      fs.mkdirSync(path.join(proc, n, "task", tid), { recursive: true });
      fs.writeFileSync(path.join(proc, n, "task", tid, "stat"), statLine(tid, "sh", st));
    }
  };
  // kill(pid, 0) succeeds for a zombie until it is reaped.
  const scan = () => processCwdsScan(uid, { platform: "linux", proc, exists: () => true, pause: () => {} });
  entry("300", statLine("300", "sh", "Z"));
  assert.deepEqual(scan().rows.map((r) => r.pid), [100], "a zombie is skipped");
  entry("300", statLine("300", "a) b", "X")); // the state follows the last ")"
  assert.deepEqual(scan().rows.map((r) => r.pid), [100]);
  entry("300", statLine("300", "sh", "S"));
  assert.equal(scan().rows, null, "a live process without a cwd is unknown");
  // A leader that called pthread_exit: Z, while a thread of it still runs (and writes).
  entry("300", statLine("300", "sh", "Z", { threads: 2 }), { 300: "Z", 301: "S" });
  assert.equal(scan().rows, null, "a zombie leader with two threads is unknown");
  entry("300", statLine("300", "sh", "Z", { threads: 2 }), { 300: "Z" });
  assert.equal(scan().rows, null, "num_threads above 1 is unknown whatever the task list shows");
  entry("300", statLine("300", "sh", "Z"), { 300: "Z", 301: "R" });
  assert.equal(scan().rows, null, "a live task is unknown");
  entry("300", "300 (sh) Z 1\n");
  assert.equal(scan().rows, null, "num_threads that cannot be read is unknown");
  // Caught while it is reaped (state Z, with no task listed): no thread is
  // left on its list, so it runs nothing. Only state Z so; X with an empty list stays unknown.
  entry("300", statLine("300", "sh", "Z"), {});
  assert.deepEqual(scan().rows.map((r) => r.pid), [100], "state Z with no task listed has exited");
  entry("300", statLine("300", "sh", "X"), {});
  assert.equal(scan().rows, null, "state X with an empty task list is unknown");
  entry("300", null);
  assert.deepEqual(scan().rows.map((r) => r.pid), [100], "its stat gone: gone");
  // Any other failure to read the stat or the task list is unknown.
  entry("300", statLine("300", "sh", "Z"));
  const { readFileSync, readdirSync } = fs;
  t.mock.method(fs, "readdirSync", (p, ...a) => {
    if (String(p) === path.join(proc, "300", "task")) throw Object.assign(new Error("EACCES"), { code: "EACCES" });
    return readdirSync(p, ...a);
  });
  assert.equal(scan().rows, null);
  t.mock.restoreAll();
  t.mock.method(fs, "readFileSync", (p, ...a) => {
    if (String(p) === path.join(proc, "300", "stat")) throw Object.assign(new Error("EIO"), { code: "EIO" });
    return readFileSync(p, ...a);
  });
  assert.equal(scan().rows, null);
});

test("process working folders on Linux: a process caught while it exits is read again, briefly; gone or exited by then it is skipped, still so it is unknown, with the reason", (t) => {
  const proc = fs.mkdtempSync(path.join(os.tmpdir(), "hoptell-proc-"));
  t.after(() => fs.rmSync(proc, { recursive: true, force: true }));
  const uid = process.getuid();
  fs.mkdirSync(path.join(proc, "100"));
  fs.symlinkSync("/work", path.join(proc, "100", "cwd"));
  const entry = (n, stat, tasks) => {
    fs.rmSync(path.join(proc, n), { recursive: true, force: true });
    fs.mkdirSync(path.join(proc, n));
    fs.writeFileSync(path.join(proc, n, "stat"), stat);
    fs.writeFileSync(path.join(proc, n, "comm"), "sh\n");
    if (tasks === null) return;
    fs.mkdirSync(path.join(proc, n, "task"));
    for (const [tid, st] of Object.entries(tasks)) {
      fs.mkdirSync(path.join(proc, n, "task", tid));
      fs.writeFileSync(path.join(proc, n, "task", tid, "stat"), statLine(tid, "sh", st));
    }
  };
  // `then(read)`: called before each reading after the first, to change /proc meanwhile.
  let pauses = [];
  let then = () => {};
  const scan = (exists = () => true) => {
    pauses = [];
    return processCwdsScan(uid, { platform: "linux", proc, exists, pause: (ms) => (pauses.push(ms), then(pauses.length)) });
  };
  const total = () => pauses.reduce((a, b) => a + b, 0);
  const { readFileSync } = fs;
  // Every reading the same: unknown after five more, about 750 ms, with the step and what it saw.
  for (const [stat, tasks, why] of [
    [statLine("300", "sh", "Z", { threads: 2 }), { 300: "Z" }, "state Z, with num_threads 2 while every task listed has exited"],
    [statLine("300", "sh", "Z"), null, "state Z, and its task listing is gone (ENOENT)"],
    [statLine("300", "sh", "Z", { threads: 2 }), { 300: "Z", 301: "R" }, "state Z, while its task 301 is in state R"],
    [statLine("300", "sh", "D"), {}, "readlink cwd gave ENOENT while it runs (state D)"],
    [statLine("300", "sh", "S"), {}, "readlink cwd gave ENOENT while it runs (state S)"],
  ]) {
    entry("300", stat, tasks);
    const r = scan();
    assert.equal(r.rows, null);
    assert.ok(r.problem.startsWith("process 300 (sh): readlink cwd gave ENOENT") && r.problem.endsWith(why), r.problem);
    assert.deepEqual(pauses, [50, 100, 150, 200, 250]);
  }
  entry("300", statLine("300", "sh", "Z"), { 300: "Z", 301: "Z" });
  t.mock.method(fs, "readFileSync", (p, ...a) => {
    if (String(p) === path.join(proc, "300", "task", "301", "stat")) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    return readFileSync(p, ...a);
  });
  assert.match(scan().problem, /state Z, and the stat of its task 301 is gone \(ENOENT\)$/);
  t.mock.restoreAll();
  // Resolved on the third reading (after the second pause): the group exited, or the process is gone.
  entry("300", statLine("300", "sh", "Z", { threads: 2 }), { 300: "Z", 301: "R" });
  then = (i) => i === 2 && entry("300", statLine("300", "sh", "Z"), { 300: "Z", 301: "Z" });
  assert.deepEqual(scan().rows.map((r) => r.pid), [100]);
  assert.deepEqual(pauses, [50, 100]);
  entry("300", statLine("300", "sh", "R"), {});
  then = (i) => i === 2 && fs.rmSync(path.join(proc, "300"), { recursive: true });
  assert.deepEqual(scan().rows.map((r) => r.pid), [100]);
  assert.deepEqual(pauses, [50, 100]);
  entry("300", statLine("300", "sh", "Z", { threads: 2 }), { 300: "Z" });
  then = () => {};
  let calls = 0;
  assert.deepEqual(scan((pid) => pid !== 300 || ++calls < 3).rows.map((r) => r.pid), [100], "ESRCH on a later look");
  // A cwd that reads on a later reading is a row.
  fs.rmSync(path.join(proc, "300"), { recursive: true });
  entry("300", statLine("300", "sh", "R"), {});
  then = (i) => i === 1 && fs.symlinkSync("/elsewhere", path.join(proc, "300", "cwd"));
  assert.deepEqual(scan().rows.map((r) => r.pid).sort(), [100, 300]);
  then = () => {};
  // A zombie caught while it is reaped (state Z, no task listed, one thread or none): exited,
  // skipped at once. State X so, or num_threads unreadable: unknown at once, with no pause.
  for (const threads of [1, 0]) {
    entry("300", statLine("300", "sh", "Z", { threads }), {});
    assert.deepEqual(scan().rows.map((r) => r.pid), [100]);
    assert.deepEqual(pauses, []);
  }
  entry("300", statLine("300", "sh", "X"), {});
  assert.deepEqual(scan(), { rows: null, problem: "process 300 (sh): readlink cwd gave ENOENT; state X, with no task listed" });
  assert.deepEqual(pauses, []);
  entry("300", statLine("300", "sh", "Z", { threads: "?" }), {});
  assert.deepEqual(scan(), { rows: null, problem: "process 300 (sh): readlink cwd gave ENOENT; state Z, with no task listed" });
  assert.deepEqual(pauses, []);
  // Z with no task listed but more than one thread counted: read again, unknown if it stays so.
  entry("300", statLine("300", "sh", "Z", { threads: 2 }), {});
  assert.match(scan().problem, /; state Z, with no task listed and num_threads 2$/);
  assert.deepEqual(pauses, [50, 100, 150, 200, 250]);
  // More processes caught exiting than one scan waits for: unknown at the ninth, without waiting
  // for it; the scan's pauses stay within 8 x 750 ms.
  fs.rmSync(path.join(proc, "300"), { recursive: true });
  const exiting = [];
  for (let i = 0; i < 9; i++) {
    const n = String(400 + i);
    entry(n, statLine(n, "sh", "Z", { threads: 2 }), { [n]: "Z", [String(500 + i)]: "R" });
    exiting.push(n);
  }
  // Each one gone (ESRCH) at its first look after a pause.
  const looks = new Map();
  const r = scan((pid) => pid === 100 || (looks.set(pid, (looks.get(pid) ?? 0) + 1), looks.get(pid) < 2));
  assert.equal(r.rows, null);
  assert.match(r.problem, /^more than 8 of your processes were exiting while hoptell read them \(the last: process \d+ \(sh\): .*state Z, while its task \d+ is in state R\)$/);
  assert.deepEqual(pauses, Array(8).fill(50), "one pause each for the first eight, none for the ninth");
  assert.ok(total() <= 8 * 750);
  for (const n of exiting) fs.rmSync(path.join(proc, n), { recursive: true, force: true });
});

test("worktree member state: a process whose folder cannot be read counts unless it is older than the repository's first launch on this boot or one of hoptell's own ancestors", async (t) => {
  const s = setup(t);
  await add(s);
  fs.writeFileSync(path.join(s.wt, "lib", "x.js"), "changed\n");
  const sessions = path.join(s.home, "worktrees", "sessions");
  fs.mkdirSync(sessions, { recursive: true, mode: 0o700 });
  // A launch whose pane's process (tick `start` of this boot) has exited, with no other process
  // recorded (Codex's case: a reparented writer is all that is left of it). firstLaunch: the first
  // launch on the boot, which later launches keep.
  const boot = currentBoot();
  const launch = (start, firstLaunch = { boot, start }) =>
    fs.writeFileSync(path.join(sessions, "dana-impl-1.json"), JSON.stringify({ version: 1, member: "dana-impl-1", sessionId: "$1", pane: "%1", root: { pid: 999_999, start, uid: process.getuid(), boot }, tree: [], started: new Date().toISOString(), firstLaunch }), { mode: 0o600 });
  launch("1000");
  // hoptell (500) runs under its login's sshd (902, started after the launch); systemd --user
  // (900) is older than the launch; 901 and 903 started after it.
  const rows = [
    [500, { ppid: 902, start: "5000" }],
    [902, { ppid: 1, start: "3000" }],
    [900, { ppid: 1, start: "500" }],
    [901, { ppid: 1, start: "2000" }],
    [903, { ppid: 1, start: "1200" }],
  ];
  const procs = (unreadable) => ({
    table: () => new Map(rows.map(([pid, r]) => [pid, { pid, uid: process.getuid(), ...r }])),
    self: 500,
    cwds: () => ({ rows: [{ pid: 500, cwd: s.root, command: "node" }], unreadable }),
  });
  // Each with the start the scan read from it, as the table shows it.
  const unreadable = (pid, command) => ({ pid, uid: process.getuid(), start: rows.find(([p]) => p === pid)[1].start, command });
  const systemd = unreadable(900, "systemd");
  const sshd = unreadable(902, "sshd");
  const writer = unreadable(901, "writer");
  const child = unreadable(903, "child");
  const change = (n) => fs.writeFileSync(path.join(s.wt, "lib", "x.js"), `changed ${n}\n`);
  const commit = (u) => commitWorktree(s.home, "dana-impl-1", { message: "m" }, { procs: procs(u) });
  // Older than the launch, or in hoptell's own ancestor chain: not counted.
  assert.ok((await commit([systemd, sshd])).commit);
  // A pid reused since the table was read: the table shows the old process (500, before the
  // launch), the scan read the new one (2000). Only the scan's start counts, and one that differs
  // from the table's, or none at all, places nothing; nor does the chain place a reused pid.
  change(1);
  await refusal(() => commit([{ ...systemd, start: "2000" }]), "member_unknown", /process 900 \(systemd/);
  await refusal(() => commit([{ ...systemd, start: "400" }]), "member_unknown", /process 900 \(systemd/);
  await refusal(() => commit([{ ...systemd, start: null }]), "member_unknown", /process 900 \(systemd, started at an unknown time\)/);
  await refusal(() => commit([{ ...sshd, start: "6000" }]), "member_unknown", /process 902 \(sshd/);
  // An unreadable process started after the launch, outside the chain: it could be the member's.
  await refusal(() => commit([systemd, sshd, writer]), "member_unknown", /process 901 \(writer, started [^)]+\) of yours could not be inspected, so it runs no git on this repository\. Processes you cannot inspect count unless they are older than the team's first launch or part of this command's own login\. One of a later login .* end it, or wait for it to end/);
  // A relaunch at tick 1500 keeps the baseline at 1000: the child started at 1200 still counts.
  launch("1500", { boot, start: "1000" });
  await refusal(() => commit([child]), "member_unknown", /process 903 \(child/);
  // A record written before firstLaunch existed: its root is the baseline.
  const rec = JSON.parse(fs.readFileSync(path.join(sessions, "dana-impl-1.json"), "utf8"));
  delete rec.firstLaunch;
  fs.writeFileSync(path.join(sessions, "dana-impl-1.json"), JSON.stringify(rec), { mode: 0o600 });
  await refusal(() => commit([writer]), "member_unknown", /process 901 \(writer/);
  assert.ok((await commit([systemd, child])).commit, "older than its root (1500)");
  // After a reboot (no launch on this boot), or with no launch record at all, no process of a
  // member started by hoptell tmux can exist: none counts.
  change(2);
  launch("1000", { boot: "another-boot", start: "1000" });
  assert.ok((await commit([systemd, writer, child])).commit);
  change(3);
  fs.rmSync(path.join(sessions, "dana-impl-1.json"));
  assert.ok((await commit([systemd, writer])).commit);
});

test("worktree member state: a relaunch keeps the member's first launch on this boot", async (t) => {
  const s = setup(t);
  const rec = await add(s);
  const file = path.join(s.home, "worktrees", "sessions", "dana-impl-1.json");
  const a = paneProcess(t);
  await startAs(s.home, rec, a.pid);
  const first = processIdentity(a.pid);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).firstLaunch, { boot: first.boot, start: first.start });
  await a.stop();
  const b = paneProcess(t);
  await startAs(s.home, rec, b.pid);
  const again = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(again.root, processIdentity(b.pid));
  assert.deepEqual(again.firstLaunch, { boot: first.boot, start: first.start }, "the relaunch does not move it");
  await b.stop();
  // A first launch of another boot is replaced.
  fs.writeFileSync(file, JSON.stringify({ ...again, firstLaunch: { boot: "another-boot", start: "1" } }), { mode: 0o600 });
  const c = paneProcess(t);
  await startAs(s.home, rec, c.pid);
  const third = processIdentity(c.pid);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).firstLaunch, { boot: third.boot, start: third.start });
  // A malformed one makes the record unreadable.
  fs.writeFileSync(file, JSON.stringify({ ...again, firstLaunch: { boot: "x" } }), { mode: 0o600 });
  assert.equal(memberState(s.home, "dana-impl-1").state, "unknown");
});

test("worktree member state: a recorded process of the member counts as running while it runs, whatever its folder shows", async (t) => {
  const s = setup(t);
  await add(s);
  fs.writeFileSync(path.join(s.wt, "lib", "x.js"), "changed\n");
  // The member's session root has exited, its child is alive and unreadable.
  const child = spawn("sleep", ["60"], { stdio: "ignore" });
  t.after(() => child.kill());
  const id = processIdentity(child.pid);
  const sessions = path.join(s.home, "worktrees", "sessions");
  fs.mkdirSync(sessions, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(sessions, "dana-impl-1.json"), JSON.stringify({ version: 1, member: "dana-impl-1", sessionId: "$1", pane: "%1", root: { ...id, pid: 999_999, start: "Mon Jan  1 00:00:00 2024" }, tree: [id], started: new Date().toISOString() }), { mode: 0o600 });
  const withChild = { table: processTable, self: process.pid, cwds: () => ({ rows: [], unreadable: [{ pid: child.pid, uid: id.uid, start: id.start, command: "sleep" }] }) };
  await refusal(() => commitWorktree(s.home, "dana-impl-1", { message: "m" }, { procs: withChild }), "member_running");
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
  assert.match(a.stdout, /Start it there: HOPTELL_PUSH=tmux hoptell tmux dana-impl-1 --roles implementer --cwd \S+ --task <file> -- <the command hoptell agents flags codex --role implementer --lead <lead> prints>/);
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

test("the macOS cwd scan: only a complete lsof answer is used; anything else refuses and says why", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hoptell-lsof-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const gone = spawnSync("true").pid; // exited and reaped
  let n = 0;
  const fake = (out, tail) => {
    const f = path.join(dir, `lsof-${++n}`);
    fs.writeFileSync(path.join(dir, `out-${n}`), out);
    fs.writeFileSync(f, `#!/bin/sh\ncat '${path.join(dir, `out-${n}`)}'\n${tail}\n`, { mode: 0o755 });
    return f;
  };
  const me = process.pid;
  const exists = (pid) => pid !== gone;
  const scan = (out, tail) => processCwdsScan(501, { platform: "darwin", lsof: fake(out, tail), exists });
  const partial = `p${me}\ncnode\nfcwd\nn/work\np${gone}\ncsleep\n`;
  // Exit 0: a row without a folder is dropped only for a process that is gone.
  assert.deepEqual(scan(partial, "exit 0").rows, [{ pid: me, cwd: "/work", command: "node" }]);
  assert.match(scan(`p${me}\ncnode\nfcwd\nn/work\np1\nclaunchd\n`, "exit 0").problem, /lsof did not give the folder of process 1, which still runs/);
  // Exit 1 with output that parses, a signal, output that does not parse, no lsof: unknown.
  const one = scan(partial, "echo 'lsof: WARNING: cannot stat() a file system' >&2; exit 1");
  assert.equal(one.rows, null);
  assert.equal(one.problem, "lsof exited 1: lsof: WARNING: cannot stat() a file system");
  assert.match(scan(partial, "kill -9 $$").problem, /lsof was stopped by SIGKILL/);
  assert.match(scan("garbage\n", "exit 0").problem, /lsof's output did not parse/);
  assert.match(processCwdsScan(501, { platform: "darwin", lsof: path.join(dir, "none") }).problem, /lsof failed \(ENOENT\)/);
  // A scan given a time budget stops lsof when it runs out (team stop's bounded wait).
  const t0 = performance.now();
  assert.match(processCwdsScan(501, { platform: "darwin", lsof: fake(partial, "exec sleep 20"), exists, timeoutMs: 200 }).problem, /lsof failed \(ETIMEDOUT\)/);
  assert.ok(performance.now() - t0 < 5000);
});

test("one budget for a whole observation: the cwd scan gets what the table read left, and none runs without a table or time", (t) => {
  // In-memory readers on an injected clock, each keeping to the limit it is given.
  let clock = 0;
  const calls = [];
  const reader = (kind, ms, result) => ({ timeoutMs }) => {
    calls.push([kind, timeoutMs]);
    clock += Math.min(ms, timeoutMs ?? ms);
    return result;
  };
  const table = new Map([[500, { pid: 500, ppid: 1, uid: process.getuid(), start: "1" }]]);
  const look = (tableMs, tableResult) => {
    [clock, calls.length] = [0, 0];
    return processIn("/x/wt", { table: reader("table", tableMs, tableResult), cwds: reader("cwds", 80, [{ pid: 700, cwd: "/x/wt/lib", command: "node" }]), self: 500, clock: () => clock }, 100);
  };
  assert.deepEqual(look(80, table), { pid: 700, cwd: "/x/wt/lib", command: "node" });
  assert.deepEqual(calls, [["table", 100], ["cwds", 20]], "the scan gets only the 20 ms the table left");
  assert.ok(clock <= 100, `the observation took ${clock} ms of a 100 ms budget`);
  // A failed table read, or one that used up the budget: no cwd scan starts.
  assert.deepEqual(look(10, null), { unknown: "the process table could not be read" });
  assert.deepEqual(calls, [["table", 100]]);
  assert.deepEqual(look(100, table), { unknown: "the time for the scan ran out" });
  assert.deepEqual(calls, [["table", 100]]);
  // On Linux, the deadline is checked before each process is read.
  const proc = fs.mkdtempSync(path.join(os.tmpdir(), "hoptell-proc-"));
  t.after(() => fs.rmSync(proc, { recursive: true, force: true }));
  fs.mkdirSync(path.join(proc, "4242"));
  let ticks = 0;
  const r = processCwdsScan(process.getuid(), { platform: "linux", proc, timeoutMs: 100, clock: () => (ticks++ ? 1000 : 0) });
  assert.equal(r.problem, `the time for the scan ran out before ${proc}/4242 was read`);
});

test("worktree member state through the real scan: a process born during a failed scan is never missed, and one found is named", async (t) => {
  const s = setup(t);
  await add(s);
  fs.writeFileSync(path.join(s.wt, "lib", "x.js"), "changed\n");
  const git = canaryGit(s);
  const pidFile = path.join(s.root, "born.pid");
  t.after(() => {
    try {
      process.kill(Number(fs.readFileSync(pidFile, "utf8")));
    } catch {}
  });
  // lsof that starts a process in the worktree while it scans, leaves it out and exits 1.
  const lsof = path.join(s.root, "lsof-born");
  fs.writeFileSync(lsof, `#!/bin/sh\n(cd '${s.wt}' && exec sleep 60 </dev/null >/dev/null 2>&1) &\necho $! > '${pidFile}'\necho p${process.pid}; echo cnode; echo fcwd; echo n/\nexit 1\n`, { mode: 0o755 });
  await refusal(() => commitWorktree(s.home, "dana-impl-1", { message: "m" }, { git, procs: { lsof, platform: "darwin" } }), "member_unknown", /could not be read \(lsof exited 1\)/);
  assert.ok(Number(fs.readFileSync(pidFile, "utf8")) > 1, "the process was born during the scan");
  // A complete answer that has it: it is named.
  const born = Number(fs.readFileSync(pidFile, "utf8"));
  const found = path.join(s.root, "lsof-found");
  fs.writeFileSync(found, `#!/bin/sh\necho p${process.pid}; echo cnode; echo fcwd; echo n/\necho p${born}; echo csleep; echo fcwd; echo n${s.wt}\nexit 0\n`, { mode: 0o755 });
  await refusal(() => commitWorktree(s.home, "dana-impl-1", { message: "m" }, { git, procs: { lsof: found, platform: "darwin" } }), "member_running", new RegExp(`process ${born} \\(sleep\\) runs in its worktree`));
  assert.ok(!fs.existsSync(s.canary), "git ran before the check");
});

test("controlledGit stream: every chunk of the output, past the runner's output limit; a reader that throws stops git and rejects", async (t) => {
  const s = setup(t);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "hoptell-stream-"));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const g = controlledGit({ scratch, maxBuffer: 16 });
  assert.throws(() => g.run(["cat-file", "-p", "HEAD"], s.repo), /Git could not be run/, "run() is capped");
  const chunks = [];
  const r = await g.stream(["cat-file", "-p", "HEAD"], s.repo, (b) => chunks.push(Buffer.from(b)));
  assert.equal(r.status, 0);
  assert.equal(Buffer.concat(chunks).toString("utf8"), execFileSync("git", ["cat-file", "-p", "HEAD"], { cwd: s.repo, env: gitEnv, encoding: "utf8" }));
  await assert.rejects(
    g.stream(["cat-file", "-p", "HEAD"], s.repo, () => {
      throw new Error("enough");
    }),
    /enough/,
  );
  // Whatever a reader throws rejects, a falsy value too.
  for (const v of [null, undefined, false, 0]) {
    await assert.rejects(
      g.stream(["cat-file", "-p", "HEAD"], s.repo, () => {
        throw v;
      }),
      (e) => e === v,
    );
  }
  const bad = await g.stream(["cat-file", "-p", "0".repeat(40)], s.repo, () => {});
  assert.notEqual(bad.status, 0);
});
