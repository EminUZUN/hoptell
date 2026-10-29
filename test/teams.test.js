// Agent teams (design 8, phase 2): the team file, hoptell team up | status | stop | restart | down,
// landing with provenance and cleanup, and the supervisor's lifetimes and idle reviewers.
// Temporary repositories and homes, test relays, a private tmux server (TMUX_TMPDIR) and stand-in
// CLIs only; processes are stopped by their exact pids.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { currentBoot, identityState, processIdentity, processInfo } from "../lib/host.js";
import { BIN } from "../lib/config.js";
import { MANIFEST_FIT, NOTICE_MS, leadCheck, checkTeam, landedFor, launchPreflight, ownsOverlap, readState, stateProblem, superviseTick, teamApproveView, teamCommand, teamDown, teamApply, teamEvidence, ingestLandingDecision, teamLandAbandon, teamLandApprove, teamLandCandidate, teamLandDiscard, teamLandPrepare, teamLandRequest, teamPaths, teamRestart, teamStatus, teamStop, teamUp, reviewCommand, reviewDiff, reviewRequest, reviewVerdict } from "../lib/teams.js";
import { APPLY_WINDOW_MS, decisionText, newActionId, parseLandingRequest, parseLandingStatus, readTombstone, teamOfAction } from "../lib/landings.js";
import * as ownersig from "../lib/ownersig.js";
import { grantText, newGrantId, noticeText, parseNotice, readGrantState, storeGrant, writeGrantState } from "../lib/grants.js";
import { canonicalize } from "../lib/jcs.js";
import { addWorktree, candidateTree, commitWorktree, landApprove, landCandidate, readWorktreeRecord, registrationOf, removeWorktree, worktreeCommand, worktreePaths } from "../lib/worktrees.js";
import { controlledGit, findGit } from "../lib/gitsafe.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { MEMBER_HIDDEN, serveEngine } from "../lib/mcp.js";
import { sleep, world } from "./helpers.js";

const TMUX_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "hoptell-teams-"));
process.env.TMUX_TMPDIR = TMUX_DIR;
delete process.env.TMUX;
delete process.env.TMUX_PANE;
test.after(() => {
  spawnSync("tmux", ["kill-server"]);
  fs.rmSync(TMUX_DIR, { recursive: true, force: true });
});
const hasTmux = spawnSync("tmux", ["-V"]).status === 0;

const gitEnv = { PATH: process.env.PATH, HOME: os.tmpdir(), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", LC_ALL: "C" };
const git = (cwd, ...args) => execFileSync("git", args, { cwd, env: gitEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const refusal = async (fn, code, re) => {
  await assert.rejects(fn, (e) => {
    assert.equal(e.code, code, e.message);
    if (re) assert.match(e.message, re);
    return true;
  });
};

/** A repository with one commit and its identity; optionally SSH signing with a fresh key. */
function repoSetup(t, { signing = false } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hoptell-team-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo");
  fs.mkdirSync(path.join(repo, "lib"), { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "Lead Tester");
  git(repo, "config", "user.email", "lead@example.com");
  fs.writeFileSync(path.join(repo, "lib", "x.js"), "export const x = 1;\n");
  fs.writeFileSync(path.join(repo, "README.md"), "# repo\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  const s = { root, repo, home: path.join(root, "home"), homedir: path.join(root, "userhome") };
  fs.mkdirSync(s.homedir);
  if (signing) {
    const key = path.join(s.homedir, ".ssh", "id_ed25519");
    fs.mkdirSync(path.dirname(key), { mode: 0o700 });
    execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "lead", "-f", key]);
    fs.writeFileSync(path.join(s.homedir, ".ssh", "allowed_signers"), `lead@example.com namespaces="git" ${fs.readFileSync(`${key}.pub`, "utf8")}`);
    // As an owner writes them: paths from the home folder, expanded by hoptell (its git has no HOME).
    git(repo, "config", "gpg.format", "ssh");
    git(repo, "config", "user.signingkey", "~/.ssh/id_ed25519");
    git(repo, "config", "gpg.ssh.allowedSignersFile", "~/.ssh/allowed_signers");
  }
  return s;
}

/** Stand-in CLIs: --version and --help answer, anything else is an agent that waits. */
function fakeClis(root) {
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin, { recursive: true });
  const help = {
    codex: "Usage: codex [OPTIONS] [PROMPT]\n  -c, --config <key=value>\n  -m, --model <MODEL>\n  -s, --sandbox <SANDBOX_MODE>  [possible values: read-only, workspace-write, danger-full-access]\n  -a, --ask-for-approval <APPROVAL_POLICY>  [possible values: untrusted, on-request, never]\n",
    claude: 'Usage: claude [options] [prompt]\n  --permission-mode <mode>  (choices: "acceptEdits", "plan", "default")\n  --append-system-prompt <prompt>\n  --model <model>\n  --effort <level>\n',
  };
  const version = { codex: "codex-cli 0.164.0", claude: "2.1.311 (Claude Code)" };
  for (const cli of ["codex", "claude"]) {
    fs.writeFileSync(path.join(bin, `${cli}.help`), help[cli]);
    fs.writeFileSync(path.join(bin, cli), `#!/bin/sh\ncase "$1" in\n  --version) echo '${version[cli]}'; exit 0;;\n  --help) cat '${path.join(bin, `${cli}.help`)}'; exit 0;;\n  features|debug|changelog) exit 2;;\nesac\nexec sleep 60\n`, { mode: 0o755 });
  }
  // The stand-ins first; tmux and git from the developer's PATH.
  return { bin, PATH: [bin, path.dirname(process.execPath), process.env.PATH, "/usr/bin", "/bin"].join(path.delimiter) };
}

const memberOf = (over = {}) => ({ name: "dana-n1-impl-1", role: "implementer", cli: "codex", task: "tasks/impl.md", owns: ["lib/**"], ...over });
const teamDoc = (over = {}) => ({ version: 1, team: "n1", repo: "repo", lead: "dana-lead", members: [memberOf(), { name: "dana-n1-rev-1", role: "reviewer", cli: "claude", task: "tasks/rev.md" }], ...over });

test("team file: the fields, the member prefix, roles and CLIs, owns that do not overlap, limits", () => {
  const file = "/work/team.json";
  const ok = checkTeam(teamDoc({ idleMinutes: { reviewer: 30 }, lifetimeMinutes: 120, worktrees: "~/wt" }), { file, homedir: "/home/dana" });
  assert.equal(ok.repo, "/work/repo");
  assert.equal(ok.worktrees, "/home/dana/wt");
  assert.equal(ok.prefix, "dana");
  assert.equal(ok.base, "HEAD");
  assert.equal(ok.idleMinutes, 30);
  assert.deepEqual(
    ok.members.map((m) => [m.name, m.role, m.task, m.template, m.lifetimeMinutes]),
    [
      ["dana-n1-impl-1", "implementer", "/work/tasks/impl.md", "implementer", 120],
      ["dana-n1-rev-1", "reviewer", "/work/tasks/rev.md", "reviewer", 120],
    ],
  );
  const bad = (doc, re) => assert.throws(() => checkTeam(doc, { file, homedir: "/home/dana" }), (e) => e.code === "bad_team_file" && re.test(e.message), JSON.stringify(doc).slice(0, 200));
  bad({ ...teamDoc(), extra: 1 }, /unknown field "extra"/);
  bad(teamDoc({ version: 2 }), /version must be 1/);
  bad(teamDoc({ team: "all" }), /team must be/);
  bad(teamDoc({ team: "N1" }), /team must be/);
  bad(teamDoc({ lead: "dana lead" }), /lead must be/);
  bad(teamDoc({ members: [memberOf({ name: "bob-n1-impl-1" })] }), /name must start with "dana-"/);
  bad(teamDoc({ members: [memberOf({ name: "dana-" })] }), /name must start with "dana-"/);
  bad(teamDoc({ members: [memberOf(), memberOf({ owns: ["test/**"] })] }), /used twice/);
  bad(teamDoc({ members: [memberOf({ cli: "agy" })] }), /agy implementers are not offered/);
  bad(teamDoc({ members: [memberOf({ cli: "gemini" })] }), /cli must be/);
  bad(teamDoc({ members: [memberOf({ role: "lead" })] }), /role must be implementer or reviewer/);
  bad(teamDoc({ members: [memberOf({ task: undefined })] }), /task must be the path/);
  bad(teamDoc({ members: [{ name: "dana-n1-rev-1", role: "reviewer", cli: "claude", task: "t.md", owns: ["lib/**"] }] }), /owns is for implementers/);
  bad(teamDoc({ members: [memberOf({ owns: ["/etc/**"] })] }), /not a glob relative/);
  bad(teamDoc({ members: [memberOf({ template: "boss" })] }), /template must be/);
  bad(teamDoc({ members: [memberOf({ lifetimeMinutes: 0 })] }), /lifetimeMinutes must be 1 to 1440/);
  bad(teamDoc({ idleMinutes: { implementer: 10 } }), /implementers are never ended for idleness/);
  bad(teamDoc({ members: [] }), /members must be a list of 1 to 16/);
  bad(teamDoc({ members: Array.from({ length: 17 }, (_, i) => memberOf({ name: `dana-r${i}`, role: "reviewer", owns: undefined })) }), /1 to 16/);
  // Two implementers may not change the same files; one without owns overlaps every other.
  bad(teamDoc({ members: [memberOf(), memberOf({ name: "dana-n1-impl-2", owns: ["lib/tmux.js"] })] }), /dana-n1-impl-1 and dana-n1-impl-2 may change the same files/);
  bad(teamDoc({ members: [memberOf(), memberOf({ name: "dana-n1-impl-2", owns: undefined })] }), /may change the same files/);
  checkTeam(teamDoc({ members: [memberOf(), memberOf({ name: "dana-n1-impl-2", owns: ["test/**", "docs/*.md"] })] }), { file, homedir: "/home/dana" });
  assert.ok(ownsOverlap(["lib/tmux*.js"], ["lib/tmux.js"]));
  assert.ok(ownsOverlap(["**/*.md"], ["docs/a.md"]), "a glob that starts with a wildcard overlaps everything");
  assert.ok(!ownsOverlap(["lib/a.js"], ["lib/ab.js"]));
  assert.ok(ownsOverlap(null, ["lib/**"]));
});

test("team up --dry-run prints every command and starts nothing; write access needs a terminal yes or --yes", async (t) => {
  const s = repoSetup(t);
  const f = fakeClis(s.root);
  fs.mkdirSync(path.join(s.root, "tasks"));
  fs.writeFileSync(path.join(s.root, "tasks", "impl.md"), "Implement it.\n");
  fs.writeFileSync(path.join(s.root, "tasks", "rev.md"), "Review requests.\n");
  const file = path.join(s.root, "team.json");
  fs.writeFileSync(file, JSON.stringify(teamDoc()));
  const run = async (args, extra = {}) => {
    const out = [];
    const warn = [];
    let failed = null;
    try {
      await teamCommand({ args, home: s.home, homedir: s.homedir, env: { PATH: f.PATH, LANG: "C" }, out: (l) => out.push(l), warn: (l) => warn.push(l), fail: (m, c = 1) => { failed = { m, c }; throw new Error("fail"); }, ...extra });
    } catch (e) {
      if (!failed) throw e;
    }
    return { out: out.join("\n"), warn: warn.join("\n"), failed };
  };
  const dry = await run(["up", file, "--dry-run"]);
  assert.equal(dry.failed, null, dry.failed?.m);
  assert.match(dry.out, /hoptell worktree add dana-n1-impl-1 --team n1 --cli codex --owns 'lib\/\*\*'/);
  assert.match(dry.out, new RegExp(`hoptell tmux dana-n1-impl-1 --roles implementer,n1 --cwd ${s.root}/repo-wt/dana-n1-impl-1 --task \\S+impl.md -- codex -s workspace-write -a never`));
  assert.match(dry.out, /hoptell tmux dana-n1-rev-1 --roles reviewer,n1 --cwd \S+ --task \S+rev\.md -- claude --permission-mode plan --effort high --append-system-prompt/);
  assert.match(dry.out, /read your task with the hoptell read_task tool/);
  assert.match(dry.warn, /dana-n1-impl-1 \(codex\) gets write access to its worktree/);
  assert.match(dry.out, /Dry run: nothing was started/);
  assert.ok(!fs.existsSync(path.join(s.root, "repo-wt")) && !fs.existsSync(path.join(s.home, "teams")), "nothing was created");
  // Codex members: no config.toml, so Codex asks to trust the worktree, and which hoptell it runs
  // could not be checked.
  const wt = path.join(s.root, "repo-wt", "dana-n1-impl-1");
  assert.ok(dry.warn.includes(`warning: Codex will ask you to trust ${s.repo} in a pane before it starts (dana-n1-impl-1); Codex (checked with 0.165.0) asks once per repository: its worktrees count as trusted after that`), dry.warn);
  assert.doesNotMatch(dry.warn, /has no reviewer/);
  assert.match(dry.warn, /could not check which hoptell the Codex members run as their MCP server: \S+config\.toml: it does not exist/);
  assert.doesNotMatch(dry.warn, /dana-n1-rev-1: Codex/, "a Claude Code member is not checked");
  // A trusted folder, and Codex's hoptell: another install (named, with its version), then this one.
  const codexHome = path.join(s.homedir, ".codex");
  fs.mkdirSync(codexHome, { recursive: true });
  const other = path.join(s.root, "other-install");
  fs.mkdirSync(path.join(other, "bin"), { recursive: true });
  fs.writeFileSync(path.join(other, "bin", "hoptell.js"), "");
  fs.writeFileSync(path.join(other, "package.json"), JSON.stringify({ name: "hoptell", version: "0.3.2" }));
  const config = (script) => fs.writeFileSync(path.join(codexHome, "config.toml"), `model = "x"\n\n[projects.${JSON.stringify(wt)}]\ntrust_level = "trusted"\n\n[mcp_servers.hoptell]\ncommand = "node"\nargs = [${JSON.stringify(script)}, "mcp"] # comment\n`);
  config(path.join(other, "bin", "hoptell.js"));
  let w = (await run(["up", file, "--dry-run"])).warn;
  assert.doesNotMatch(w, /Codex will ask|Codex may ask/);
  assert.ok(w.includes(`Codex members run the hoptell MCP server of ${fs.realpathSync(path.join(other, "bin", "hoptell.js"))} (version 0.3.2), from [mcp_servers.hoptell] in ${path.join(codexHome, "config.toml")}, not this hoptell ${fs.realpathSync(BIN)}`), w);
  config(BIN);
  const before = fs.readFileSync(path.join(codexHome, "config.toml"), "utf8");
  w = (await run(["up", file, "--dry-run"])).warn;
  assert.doesNotMatch(w, /MCP server/);
  assert.equal(fs.readFileSync(path.join(codexHome, "config.toml"), "utf8"), before, "read only");
  // A config that cannot be read: Codex may ask.
  fs.chmodSync(path.join(codexHome, "config.toml"), 0);
  w = (await run(["up", file, "--dry-run"])).warn;
  if (process.getuid() !== 0) assert.match(w, /Codex may ask you to trust \S+ in a pane before it starts \(dana-n1-impl-1; \S+config\.toml: it could not be read \(EACCES\)\); Codex \(checked with 0\.165\.0\) asks once per repository/);
  fs.chmodSync(path.join(codexHome, "config.toml"), 0o600);
  // Codex keeps trust under the repository's root: with only the repository trusted, its
  // worktrees are too.
  fs.writeFileSync(path.join(codexHome, "config.toml"), `[projects.${JSON.stringify(s.repo)}]\ntrust_level = "trusted"\n`);
  assert.doesNotMatch((await run(["up", file, "--dry-run"])).warn, /Codex will ask|Codex may ask/);
  // A team without a reviewer: its landings cannot be requested from the owner, and team up says so.
  const solo = path.join(s.root, "solo.json");
  fs.writeFileSync(solo, JSON.stringify(teamDoc({ team: "n9", members: [memberOf({ name: "dana-n9-impl-1", cli: "codex", owns: ["lib/**"] })] })));
  const sw = await run(["up", solo, "--dry-run"]);
  assert.equal(sw.failed, null, sw.failed?.m);
  assert.ok(sw.warn.includes("warning: team n9 has no reviewer, so its landings cannot be requested from the owner (--request-approval needs a review of the candidate); the owner lands them in a terminal with hoptell team land <member> --approve <T> <C>"), sw.warn);
  // No terminal and no --yes: refused before anything starts.
  const no = await run(["up", file]);
  assert.match(no.failed.m, /run it in a terminal to confirm, or pass --yes/);
  const asked = await run(["up", file], { isTTY: true, deps: { ask: async () => "n" } });
  assert.match(asked.failed.m, /nothing was started/);
  assert.ok(!fs.existsSync(path.join(s.root, "repo-wt")) && !fs.existsSync(path.join(s.home, "teams")), "nothing was created");
  // A task file that is missing, and agy next to a project MCP file, are refused first.
  fs.writeFileSync(file, JSON.stringify(teamDoc({ members: [memberOf({ task: "tasks/none.md" })] })));
  assert.match((await run(["up", file, "--dry-run"])).failed.m, /dana-n1-impl-1: --task: .* does not exist/);
  fs.mkdirSync(path.join(s.repo, ".agents"));
  fs.writeFileSync(path.join(s.repo, ".agents", "mcp_config.json"), "{}");
  fs.writeFileSync(file, JSON.stringify(teamDoc({ members: [{ name: "dana-n1-rev-2", role: "reviewer", cli: "agy", task: "tasks/rev.md" }] })));
  assert.match((await run(["up", file, "--dry-run"])).failed.m, /mcp_config\.json exists; .* does not start agy members \(dana-n1-rev-2\)/);
  // Usage errors.
  for (const [args, re] of [
    [["frob"], /unknown team command/],
    [[], /team needs a command/],
    [["up"], /needs a team file/],
    [["stop"], /needs a member/],
    [["land", "dana-n1-impl-1"], /needs --target <branch> and -m/],
    [["status", "--bogus"], /unknown option --bogus/],
  ]) {
    const r = await run(args);
    assert.equal(r.failed?.c, 2, `${args.join(" ")}: ${r.failed?.m}`);
    assert.match(r.failed.m, re);
  }
});

test("team: up, status, stop, commit, restart, land (owner approval of exactly T and C), down; provenance and cleanup", { skip: !hasTmux && "tmux not installed" }, async (t) => {
  const w = await world();
  t.after(async () => {
    spawnSync("tmux", ["kill-server"]);
    await w.close();
  });
  const s = repoSetup(t, { signing: true });
  s.home = w.home;
  const f = fakeClis(s.root);
  fs.mkdirSync(path.join(s.root, "tasks"));
  fs.writeFileSync(path.join(s.root, "tasks", "impl.md"), "Implement it.\n");
  fs.writeFileSync(path.join(s.root, "tasks", "rev.md"), "Review requests.\n");
  const file = path.join(s.root, "team.json");
  fs.writeFileSync(file, JSON.stringify(teamDoc({ members: [memberOf(), { name: "dana-n1-rev-1", role: "reviewer", cli: "claude", task: "tasks/rev.md", lifetimeMinutes: 600 }] })));
  const env = { PATH: f.PATH, HOME: s.homedir, HOPTELL_PUSH: "" };
  const cli = (...args) => w.cli(["team", ...args], env);
  const up = await cli("up", file, "--yes");
  assert.equal(up.code, 0, up.stderr);
  assert.match(up.stdout, /started dana-n1-impl-1 \(tmux session \$\d+\)/);
  assert.match(up.stdout, /started the supervisor/);
  // No session of the lead is online at the test relay: a warning after the start.
  assert.match(up.stderr, /warning: the lead dana-lead is not online at the relay, so the members' messages to it fail\. Run the lead as a session connected under that name \(an agent session, or hoptell wait\); hoptell listen only reads a local inbox/);
  const state = readState(w.home, "n1");
  assert.equal(fs.statSync(teamPaths(w.home, "n1").state).mode & 0o777, 0o600);
  assert.equal(state.status, "up");
  const [impl, rev] = state.members;
  assert.equal(impl.worktree, path.join(s.root, "repo-wt", "dana-n1-impl-1"));
  assert.equal(impl.branch, "team/n1/dana-n1-impl-1");
  assert.deepEqual(impl.session.root, processIdentity(impl.session.pid));
  // Each member's session: its roles include the team; it starts in its folder with its command.
  const show = (id, fmt) => execFileSync("tmux", ["display-message", "-p", "-t", id, fmt], { encoding: "utf8" }).trim();
  assert.match(execFileSync("tmux", ["show-environment", "-t", impl.session.id], { encoding: "utf8" }), /^HOPTELL_ROLES=implementer,n1$/m);
  // The team member's signal for its MCP server's tool filter (decision 6), set by the launch.
  assert.match(execFileSync("tmux", ["show-environment", "-t", impl.session.id], { encoding: "utf8" }), /^HOPTELL_TEAM_MEMBER=implementer:n1$/m);
  assert.match(execFileSync("tmux", ["show-environment", "-t", rev.session.id], { encoding: "utf8" }), /^HOPTELL_TEAM_MEMBER=reviewer:n1$/m);
  assert.match(show(impl.session.pane, "#{pane_start_command}"), /HOPTELL_TEAM_MEMBER=\\?"implementer:n1\\?"/);
  assert.equal(show(impl.session.pane, "#{pane_current_path}"), impl.worktree);
  assert.equal(show(rev.session.pane, "#{pane_current_path}"), s.repo);
  assert.match(show(impl.session.pane, "#{pane_start_command}"), /'-s' 'workspace-write' '-a' 'never'/);
  assert.equal(fs.readFileSync(teamPaths(w.home, "n1").task(impl.name), "utf8"), "Implement it.\n");
  assert.match((await cli("up", file, "--yes")).stderr, /team n1 is already up/);

  // Status while the implementer runs: no git on the repository.
  let st = await cli("status", "n1");
  assert.match(st.stdout, /dana-n1-impl-1 {2}implementer {2}codex {2}model CLI default, effort CLI default \(at launch\) {2}running/);
  assert.match(st.stdout, /git not run: .*dana-n1-impl-1 \(codex\) is still running/);
  assert.match(st.stdout, /dana-n1-rev-1 {2}reviewer {2}claude {2}model CLI default, effort high \(at launch\) {2}running .*lifetime ends/);
  assert.match(st.stdout, /supervisor running/);

  // The loop: the implementer works, is stopped (by its session id), the lead commits.
  fs.writeFileSync(path.join(impl.worktree, "lib", "x.js"), "export const x = 2;\n");
  assert.match((await cli("restart", impl.name)).stderr, /still running; hoptell team stop/);
  const stop = await cli("stop", impl.name);
  assert.equal(stop.code, 0, stop.stderr);
  assert.match(stop.stdout, /dana-n1-impl-1: exited/);
  st = await cli("status", "n1");
  assert.match(st.stdout, /dana-n1-impl-1 .* exited/);
  assert.match(st.stdout, /1 uncommitted change/);
  const commit = await commitWorktree(w.home, impl.name, { message: "Change x" });
  // Restart: a fresh session in the same worktree, with where it stands and the same task.
  const re = await cli("restart", impl.name);
  assert.equal(re.code, 0, re.stderr);
  const again = readState(w.home, "n1").members[0];
  assert.notEqual(again.session.id, impl.session.id);
  assert.match(show(again.session.pane, "#{pane_start_command}"), new RegExp(`restarted in your worktree; your branch is team/n1/dana-n1-impl-1 at ${commit.commit}`));
  assert.match(execFileSync("tmux", ["show-environment", "-t", again.session.id], { encoding: "utf8" }), /^HOPTELL_TEAM_MEMBER=implementer:n1$/m);
  assert.equal((await cli("stop", impl.name)).code, 0);

  // Landing: the candidate is a signed squash on main's commit; the owner approves exactly (T, C).
  // Both steps are the owner's, in a terminal: the candidate is signed with the owner's key.
  const owner = async (args, answer = "land") => {
    let failed = null;
    const out = [];
    try {
      await teamCommand({ args, home: w.home, homedir: s.homedir, env, out: (l) => out.push(l), warn: () => {}, fail: (m) => { failed = m; throw new Error("fail"); }, isTTY: true, deps: { ask: async () => answer } });
    } catch (e) {
      if (!failed) throw e;
    }
    return { failed, out: out.join("\n") };
  };
  const T = git(s.repo, "rev-parse", "main");
  assert.match((await cli("land", impl.name, "--target", "main", "-m", "Change x (team n1)")).stderr, /landing is the owner's step: run hoptell team land in a terminal \(the candidate is signed with your key\)/);
  const cand = await owner(["land", impl.name, "--target", "main", "-m", "Change x (team n1)"]);
  assert.equal(cand.failed, null, cand.failed);
  const C = readState(w.home, "n1").candidate.C;
  assert.match(cand.out, new RegExp(`Candidate ${C} on main \\(at ${T}\\), signed and verified`));
  assert.match(cand.out, new RegExp(`hoptell team land dana-n1-impl-1 --approve ${T} ${C}`));
  assert.equal(git(s.repo, "rev-parse", "team/n1/land"), C);
  assert.match(git(s.repo, "cat-file", "commit", C), /^gpgsig -----BEGIN SSH SIGNATURE-----/m);
  assert.equal(git(s.repo, "rev-parse", `${C}^{tree}`), git(s.repo, "rev-parse", `${commit.commit}^{tree}`));
  assert.match((await owner(["land", impl.name, "--target", "main", "-m", "again"])).failed, /a candidate for dana-n1-impl-1 .* waits/);
  // The approval: in a terminal, for exactly that pair.
  assert.match((await cli("land", impl.name, "--approve", T, C)).stderr, /landing is the owner's step: run hoptell team land --approve in a terminal/);
  assert.match((await owner(["land", impl.name, "--approve", T, C], "yes")).failed, /not confirmed; nothing was landed/);
  assert.match((await owner(["land", impl.name, "--approve", T, T])).failed, /no candidate .* is recorded/);
  assert.match((await owner(["land", impl.name, "--approve", T.slice(0, 12), C])).failed, /full target and candidate commit ids/);
  assert.equal(git(s.repo, "rev-parse", "main"), T, "nothing landed");
  // team up enrolled the repository: its common git folder, an id and generation 1; a run id.
  const st0 = readState(w.home, "n1");
  assert.equal(st0.enrolment.common, fs.realpathSync(path.join(s.repo, ".git")));
  assert.equal(st0.enrolment.generation, 1);
  assert.match(st0.run, /^[0-9a-f]{32}$/);
  // main is checked out in the repository. A dirty checkout blocks the landing before any move,
  // with what is dirty; it ends that action, prints no line to paste, and moves nothing.
  const tracked = path.join(s.repo, "lib", "x.js");
  const clean = fs.readFileSync(tracked);
  fs.writeFileSync(tracked, "mine\n");
  const dirty = await owner(["land", impl.name, "--approve", T, C]);
  assert.match(dirty.failed, new RegExp(`main is checked out in \\S+repo, and it has 1 uncommitted change: lib/x\\.js\\. Nothing was moved\\. Fix that, then run the same hoptell team land dana-n1-impl-1 --approve ${T} ${C} again; hoptell then moves it itself`));
  assert.ok(!dirty.failed.includes("git merge"), "no line to paste before a move");
  assert.equal(git(s.repo, "rev-parse", "main"), T, "nothing moved");
  const L1 = readTombstone(w.home, "n1", "L1");
  assert.equal(L1.state, "blocked");
  assert.equal(L1.route, "terminal");
  assert.deepEqual(readState(w.home, "n1").actions, [], "a block before the move ends the action");
  assert.equal(readState(w.home, "n1").candidate.C, C, "the candidate stays");
  fs.writeFileSync(tracked, clean);
  // --confirm before anything moved: nothing is recorded.
  assert.match((await owner(["land", impl.name, "--confirm", T, C])).failed, /main is at \w+, not at \w+; .*nothing was recorded\. Move main to \w+ first/);
  assert.match((await cli("land", impl.name, "--confirm", T, C)).stderr, /landing is the owner's step: run hoptell team land --confirm in a terminal/);
  // Clean again: the next decision is a new action, and hoptell fast-forwards the checkout itself.
  const landed = await owner(["land", impl.name, "--approve", T, C]);
  assert.equal(landed.failed, null, landed.failed);
  assert.match(landed.out, new RegExp(`Landed ${C} on main \\(was ${T}\\), landing L2\\.`));
  assert.match(landed.out, /worktree removed; branch team\/n1\/dana-n1-impl-1 deleted/);
  assert.doesNotMatch(landed.out, /warning/);
  assert.equal(git(s.repo, "rev-parse", "main"), C);
  assert.equal(git(s.repo, "status", "--porcelain", "--untracked-files=no"), "", "the checkout moved with its branch");
  assert.equal(fs.readFileSync(tracked, "utf8"), "export const x = 2;\n");
  assert.equal(readState(w.home, "n1").landing, null, "the journal is cleared");
  assert.deepEqual(readState(w.home, "n1").actions, []);
  assert.equal(readTombstone(w.home, "n1", "L2").state, "finished");
  const m2 = JSON.parse(fs.readFileSync(path.join(w.home, "teams", "n1", "landings", "L2", "manifest.json"), "utf8"));
  assert.deepEqual([m2.T, m2.C, m2.H, m2.target, m2.mode.kind, m2.mode.worktree, m2.run, m2.realm, m2.evidence], [T, C, commit.commit, "main", "checkout", fs.realpathSync(s.repo), st0.run, null, null]);
  assert.equal(spawnSync("git", ["rev-parse", "--verify", "-q", "team/n1/land"], { cwd: s.repo, env: gitEnv }).status, 1, "the candidate branch is gone");
  assert.equal(spawnSync("git", ["rev-parse", "--verify", "-q", "team/n1/dana-n1-impl-1"], { cwd: s.repo, env: gitEnv }).status, 1);
  assert.ok(!fs.existsSync(impl.worktree));
  assert.deepEqual(readState(w.home, "n1").landed.map((l) => [l.member, l.H, l.C, l.T, l.target]), [[impl.name, commit.commit, C, T, "main"]]);

  // Down: the reviewer and the supervisor end by their session ids.
  const down = await cli("down", "n1");
  assert.equal(down.code, 0, down.stderr);
  assert.match(down.stdout, /dana-n1-rev-1: exited/);
  assert.match(down.stdout, /supervisor: stopped/);
  assert.equal(readState(w.home, "n1").status, "down");
  const sessions = spawnSync("tmux", ["list-sessions", "-F", "#{session_name}"], { encoding: "utf8" }).stdout;
  assert.doesNotMatch(sessions, /hoptell-dana/);
  assert.match((await cli("status", "n1")).stdout, /Team n1 \(down\)/);
});

test("team down keeps a dirty worktree and a branch with commits that never landed, and says why", { skip: !hasTmux && "tmux not installed" }, async (t) => {
  const w = await world();
  t.after(async () => {
    spawnSync("tmux", ["kill-server"]);
    await w.close();
  });
  const s = repoSetup(t);
  const f = fakeClis(s.root);
  fs.mkdirSync(path.join(s.root, "tasks"));
  fs.writeFileSync(path.join(s.root, "tasks", "impl.md"), "Implement it.\n");
  const file = path.join(s.root, "team.json");
  fs.writeFileSync(file, JSON.stringify(teamDoc({ team: "n2", members: [memberOf({ name: "dana-n2-a" }), memberOf({ name: "dana-n2-b", owns: ["test/**"] })] })));
  // The lead is online, and team up runs under the lead's own name (the relay leaves a caller's
  // own name out of its listing): the check's probe has a name of its own and sees the lead.
  await w.mcp("dana-lead");
  const env = { PATH: f.PATH, HOME: s.homedir, HOPTELL_PUSH: "", HOPTELL_NAME: "dana-lead" };
  const up = await w.cli(["team", "up", file, "--yes"], env);
  assert.equal(up.code, 0, up.stderr);
  assert.doesNotMatch(up.stderr, /the lead dana-lead|could not check whether the lead/);
  const [a, b] = readState(w.home, "n2").members;
  fs.writeFileSync(path.join(a.worktree, "dirty.txt"), "uncommitted\n");
  // b gets a commit that never lands. A running implementer keeps the repository busy, so both stop
  // first; the busy refusal is the phase 1 rule.
  assert.equal((await w.cli(["team", "stop", b.name], env)).code, 0);
  fs.mkdirSync(path.join(b.worktree, "test"), { recursive: true });
  fs.writeFileSync(path.join(b.worktree, "test", "x.js"), "b\n");
  await refusal(() => commitWorktree(w.home, b.name, { message: "b" }), "member_running", /dana-n2-a \(codex\) is still running/);
  assert.equal((await w.cli(["team", "stop", a.name], env)).code, 0);
  await commitWorktree(w.home, b.name, { message: "b" });
  const down = await w.cli(["team", "down"], env);
  assert.equal(down.code, 0, down.stderr);
  assert.match(down.stdout, /dana-n2-a: exited; worktree kept: the worktree of dana-n2-a has 1 uncommitted change \(dirty\.txt\)/);
  assert.match(down.stdout, /dana-n2-b: exited; worktree removed; branch team\/n2\/dana-n2-b kept \(it has commits that hoptell has no record of landing\)/);
  assert.ok(fs.existsSync(a.worktree));
  assert.ok(git(s.repo, "rev-parse", "team/n2/dana-n2-b"));
});

test("landing refuses: no signing settings, a target that moved from the base, an existing candidate, a moved head or target at approval", async (t) => {
  const s = repoSetup(t, { signing: true });
  const rec = await addWorktree(s.home, { repo: s.repo, member: "dana-impl-1", team: "n1", cli: "codex" });
  fs.writeFileSync(path.join(rec.path, "lib", "x.js"), "2\n");
  await commitWorktree(s.home, "dana-impl-1", { message: "m" });
  const landRef = "refs/heads/team/n1/land";
  const opts = { homedir: s.homedir };
  await refusal(() => landCandidate(s.home, "dana-impl-1", { target: "main", message: "", landRef, bound: reg(s.home) }, opts), "no_message");
  await refusal(() => landCandidate(s.home, "dana-impl-1", { target: "team/n1/x", message: "m", landRef, bound: reg(s.home) }, opts), "bad_target");
  await refusal(() => landCandidate(s.home, "dana-impl-1", { target: "nope", message: "m", landRef, bound: reg(s.home) }, opts), "bad_target", /there is no branch nope/);
  // The candidate: one signed commit, parent T, the member's tree.
  const c = await landCandidate(s.home, "dana-impl-1", { target: "main", message: "Land", landRef, bound: reg(s.home) }, opts);
  assert.equal(c.T, rec.base);
  assert.equal(git(s.repo, "rev-parse", `${c.C}^`), c.T);
  await refusal(() => landCandidate(s.home, "dana-impl-1", { target: "main", message: "Land", landRef, bound: reg(s.home) }, opts), "candidate_exists");
  const candidate = { target: "main", T: c.T, C: c.C, H: c.H };
  // The member moved on after the candidate: refused.
  fs.writeFileSync(path.join(rec.path, "lib", "x.js"), "3\n");
  await commitWorktree(s.home, "dana-impl-1", { message: "m2" });
  await refusal(() => landApprove(s.home, "dana-impl-1", { T: c.T, C: c.C, candidate, landRef, bound: reg(s.home) }, opts), "head_moved");
  // The target moved with a change to the member's own file: refused, the path named (no merge machinery).
  git(s.repo, "update-ref", "-d", landRef, c.C);
  fs.writeFileSync(path.join(s.repo, "lib", "x.js"), "elsewhere\n");
  git(s.repo, "commit", "-q", "-am", "elsewhere");
  await refusal(() => landCandidate(s.home, "dana-impl-1", { target: "main", message: "Land", landRef, bound: reg(s.home) }, opts), "target_moved", /touch the same paths: lib\/x\.js; hoptell builds a candidate on the moved target only when no path overlaps/);
  assert.notEqual(git(s.repo, "rev-parse", "main"), c.C);
  // A repository without SSH signing cannot land.
  const u = repoSetup(t);
  const urec = await addWorktree(u.home, { repo: u.repo, member: "dana-impl-1", team: "n1", cli: "codex" });
  fs.writeFileSync(path.join(urec.path, "lib", "x.js"), "2\n");
  await commitWorktree(u.home, "dana-impl-1", { message: "m" });
  await refusal(() => landCandidate(u.home, "dana-impl-1", { target: "main", message: "Land", landRef, bound: reg(u.home) }, { homedir: u.homedir }), "signing_required");
  // Approval with an unsigned candidate C (made by hand) does not verify.
  const v = repoSetup(t, { signing: true });
  const vrec = await addWorktree(v.home, { repo: v.repo, member: "dana-impl-1", team: "n1", cli: "codex" });
  fs.writeFileSync(path.join(vrec.path, "lib", "x.js"), "2\n");
  const vc = await commitWorktree(v.home, "dana-impl-1", { message: "m" });
  const tree = git(v.repo, "rev-parse", `${vc.commit}^{tree}`);
  const unsigned = execFileSync("git", ["commit-tree", "-p", vrec.base, "-m", "unsigned", tree], { cwd: v.repo, env: gitEnv, encoding: "utf8" }).trim();
  git(v.repo, "update-ref", landRef, unsigned);
  await refusal(() => landApprove(v.home, "dana-impl-1", { T: vrec.base, C: unsigned, candidate: { target: "main", T: vrec.base, C: unsigned, H: vc.commit }, landRef, bound: reg(v.home) }, { homedir: v.homedir }), "verify_failed");
  assert.equal(git(v.repo, "rev-parse", "main"), vrec.base);
  // A target checked out in another worktree than the main one: refused.
  git(v.repo, "branch", "dev", vrec.base);
  git(v.repo, "worktree", "add", "-q", path.join(v.root, "devwt"), "dev");
  const dev = await landCandidate(v.home, "dana-impl-1", { target: "dev", message: "Land", landRef: "refs/heads/team/n2/land", bound: reg(v.home) }, { homedir: v.homedir });
  // (landApprove finishes landings journaled before landing actions: it never moves a checkout.)
  await refusal(() => landApprove(v.home, "dana-impl-1", { T: dev.T, C: dev.C, candidate: { target: "dev", T: dev.T, C: dev.C, H: dev.H }, landRef: "refs/heads/team/n2/land", journaled: "intent", bound: reg(v.home) }, { homedir: v.homedir }), "land_blocked", new RegExp(`dev is checked out in ${fs.realpathSync(path.join(v.root, "devwt"))}; nothing was moved`));
  assert.equal(git(v.repo, "rev-parse", "dev"), vrec.base, "a checked-out target is never moved by the old path");
});

test("a target that moved: the member's change re-based onto it when no path overlaps (adds, deletes, a symlink), signed and landed; overlapping paths and a file that became a folder refuse, named", async (t) => {
  const s = repoSetup(t, { signing: true });
  fs.mkdirSync(path.join(s.repo, "docs"));
  fs.writeFileSync(path.join(s.repo, "docs", "a.md"), "a\n");
  fs.writeFileSync(path.join(s.repo, "old.txt"), "old\n");
  git(s.repo, "add", "-A");
  git(s.repo, "commit", "-q", "-m", "more");
  const rec = await addWorktree(s.home, { repo: s.repo, member: "dana-impl-1", team: "n1", cli: "codex", owns: ["lib/**", "old.txt"] });
  const other = await addWorktree(s.home, { repo: s.repo, member: "dana-impl-2", team: "n1", cli: "codex" });
  // The member: a change, a new file, a symlink, a delete.
  fs.writeFileSync(path.join(rec.path, "lib", "x.js"), "mine\n");
  fs.writeFileSync(path.join(rec.path, "lib", "new.js"), "new\n");
  fs.symlinkSync("x.js", path.join(rec.path, "lib", "link.js"));
  fs.rmSync(path.join(rec.path, "old.txt"));
  const H = (await commitWorktree(s.home, "dana-impl-1", { message: "mine" })).commit;
  // Meanwhile the target moves elsewhere: another file changed, one deleted, one added.
  fs.writeFileSync(path.join(s.repo, "README.md"), "# moved\n");
  fs.rmSync(path.join(s.repo, "docs", "a.md"));
  fs.writeFileSync(path.join(s.repo, "docs", "b.md"), "b\n");
  git(s.repo, "add", "-A");
  git(s.repo, "commit", "-q", "-m", "moved");
  const T = git(s.repo, "rev-parse", "main");
  const landRef = "refs/heads/team/n1/land";
  const opts = { homedir: s.homedir };
  const c = await landCandidate(s.home, "dana-impl-1", { target: "main", message: "Land", landRef, bound: reg(s.home) }, opts);
  assert.equal(c.rebased, true);
  assert.equal(c.T, T);
  assert.equal(git(s.repo, "rev-parse", `${c.C}^`), T);
  const files = git(s.repo, "ls-tree", "-r", "--name-only", c.C).split("\n").sort();
  assert.deepEqual(files, ["README.md", "docs/b.md", "lib/link.js", "lib/new.js", "lib/x.js"]);
  assert.equal(git(s.repo, "show", `${c.C}:README.md`), "# moved");
  assert.equal(git(s.repo, "show", `${c.C}:lib/x.js`), "mine");
  assert.match(git(s.repo, "ls-tree", c.C, "lib/link.js"), /^120000 blob /);
  assert.deepEqual(git(s.repo, "diff", "--name-only", T, c.C).split("\n").sort(), ["lib/link.js", "lib/new.js", "lib/x.js", "old.txt"]);
  // Approved exactly (T, C): the tree is checked again, the same way, and the target moves to C.
  git(s.repo, "checkout", "-q", "--detach");
  const landed = await landApprove(s.home, "dana-impl-1", { T, C: c.C, candidate: { target: "main", T, C: c.C, H }, landRef, journaled: "intent", bound: reg(s.home) }, opts);
  assert.equal(landed.C, c.C);
  assert.equal(git(s.repo, "rev-parse", "main"), c.C);
  // The second member's base is now behind; its change to the file the first changed overlaps,
  // and a file that became a folder on the target overlaps with a file in it.
  fs.writeFileSync(path.join(other.path, "lib", "x.js"), "theirs\n");
  fs.writeFileSync(path.join(other.path, "README.md"), "# theirs\n");
  await commitWorktree(s.home, "dana-impl-2", { message: "theirs" });
  await refusal(() => landCandidate(s.home, "dana-impl-2", { target: "main", message: "Land", landRef, bound: reg(s.home, "dana-impl-2") }, opts), "target_moved", /touch the same paths: README\.md, lib\/x\.js;/);
  const u = repoSetup(t, { signing: true });
  const urec = await addWorktree(u.home, { repo: u.repo, member: "dana-impl-1", team: "n1", cli: "codex" });
  fs.mkdirSync(path.join(urec.path, "notes"));
  fs.writeFileSync(path.join(urec.path, "notes", "n.md"), "n\n");
  await commitWorktree(u.home, "dana-impl-1", { message: "a folder" });
  fs.writeFileSync(path.join(u.repo, "notes"), "a file\n");
  git(u.repo, "add", "-A");
  git(u.repo, "commit", "-q", "-m", "a file");
  await refusal(() => landCandidate(u.home, "dana-impl-1", { target: "main", message: "Land", landRef, bound: reg(u.home) }, { homedir: u.homedir }), "target_moved", /touch the same paths: notes\/n\.md;/);
});

test("a re-base reads Git's names exactly: a name that is not UTF-8 refuses (it never reads as another), and a path a case- or normalization-insensitive checkout takes for another refuses, both named", async (t) => {
  const s = repoSetup(t);
  const scratch = path.join(s.root, "scratch");
  fs.mkdirSync(scratch);
  const g = controlledGit({ git: findGit(), scratch });
  const run = (args, input, env = {}) => execFileSync("git", args, { cwd: s.repo, env: { ...gitEnv, ...env }, input });
  const blob = (text) => run(["hash-object", "-w", "--stdin"], text).toString().trim();
  // A tree with raw names (Buffers), written through a private index: no checkout has to hold them.
  let n = 0;
  const tree = (files) => {
    const env = { GIT_INDEX_FILE: path.join(scratch, `test-index-${n++}`) };
    run(["update-index", "-z", "--index-info"], Buffer.concat(files.map(([name, oid]) => Buffer.concat([Buffer.from(`100644 ${oid}\t`), Buffer.isBuffer(name) ? name : Buffer.from(name), Buffer.from([0])]))), env);
    return run(["write-tree"], undefined, env).toString().trim();
  };
  const commit = (tr, parent) => run(["commit-tree", ...(parent ? ["-p", parent] : []), "-m", "c", tr]).toString().trim();
  const rebase = (files, onT, onH) => {
    const B = commit(tree(files));
    const T = commit(tree([...files, ...onT]), B);
    const H = commit(tree(onH(files)), B);
    return candidateTree(g, { repo: s.repo, base: B, member: "dana-impl-1", objectFormat: "sha1" }, T, H, scratch);
  };
  // B holds "bad-\xEF\xBF\xBD" (a valid "bad-\uFFFD") and "bad-\xFF" (not UTF-8); the member changes only the first.
  const valid = Buffer.from([...Buffer.from("bad-"), 0xef, 0xbf, 0xbd]);
  const invalid = Buffer.from([...Buffer.from("bad-"), 0xff]);
  const one = blob("one\n");
  assert.throws(() => rebase([[valid, one], [invalid, one]], [["other.txt", blob("t\n")]], (f) => [[valid, blob("two\n")], f[1]]), (e) => e.code === "target_moved" && e.message.includes('the path "bad-\\xff" is not UTF-8'));
  // A byte order mark is part of the name: an unchanged "\uFEFFa.txt" never reads as the changed "a.txt".
  const bom = Buffer.from([0xef, 0xbb, 0xbf, ...Buffer.from("a.txt")]);
  const c = rebase([[bom, one], ["a.txt", one]], [["other.txt", blob("t\n")]], (f) => [f[0], ["a.txt", blob("two\n")]]);
  assert.equal(run(["rev-parse", `${c.tree}:a.txt`]).toString().trim(), blob("two\n"));
  assert.equal(run(["rev-parse", `${c.tree}:\uFEFFa.txt`]).toString().trim(), one);
  // Case only: the target adds Notes.md, the member notes.md.
  assert.throws(() => rebase([["a.txt", one]], [["Notes.md", blob("t\n")]], (f) => [...f, ["notes.md", blob("m\n")]]), (e) => e.code === "target_moved" && e.message.includes("notes.md (the target has Notes.md)"));
  // NFC and NFD: the target adds "café" composed, the member decomposed.
  const nfc = "caf\u00e9.md";
  const nfd = "cafe\u0301.md";
  assert.throws(() => rebase([["a.txt", one]], [[nfc, blob("t\n")]], (f) => [...f, [nfd, blob("m\n")]]), (e) => e.code === "target_moved" && e.message.includes(`${nfd} (the target has ${nfc})`));
  // A folder whose name differs only in case is an alias too.
  assert.throws(() => rebase([["a.txt", one]], [["Docs/x.md", blob("t\n")]], (f) => [...f, ["docs/y.md", blob("m\n")]]), (e) => e.code === "target_moved" && e.message.includes("docs (the target has Docs)"));
  // Without aliases the same shapes re-base.
  assert.equal(rebase([["a.txt", one]], [["Notes.md", blob("t\n")]], (f) => [...f, ["other.md", blob("m\n")]]).rebased, true);
});

test("prepare with only uncommitted changes names the stop and the commit, in order; worktree add --team says when the name is in no running team", async (t) => {
  const s = repoSetup(t, { signing: true });
  const rec = await addWorktree(s.home, { repo: s.repo, member: "dana-impl-1", team: "n1", cli: "codex" });
  fs.writeFileSync(path.join(rec.path, "lib", "x.js"), "2\n");
  await refusal(() => landCandidate(s.home, "dana-impl-1", { target: "main", message: "Land", landRef: "refs/heads/team/n1/land", bound: reg(s.home) }, { homedir: s.homedir }), "nothing_to_land", /^dana-impl-1 has no commits yet, only uncommitted changes in its worktree: run hoptell team stop dana-impl-1, then hoptell worktree commit dana-impl-1 -m <message>, then this command again$/);
  const lines = [];
  const add = (member, inTeam) => worktreeCommand({ args: ["add", member, "--team", "n1", "--cli", "codex"], home: s.home, cwd: s.repo, fail: (m) => assert.fail(m), out: (l) => lines.push(l), inTeam });
  await add("dana-impl-2", () => false);
  assert.ok(lines.includes("Note: dana-impl-2 is not a member of the running team n1, so this worktree is in no team: hoptell team land and team status do not see it. Members come from the team file, through hoptell team up."), lines.join("\n"));
  lines.length = 0;
  await add("dana-impl-3", (team, member) => team === "n1" && member === "dana-impl-3");
  assert.ok(!lines.some((l) => l.startsWith("Note:")));
});

test("worktree remove after a landing: the branch goes only when its head landed and the landed commit is in the target", async (t) => {
  const s = repoSetup(t);
  const rec = await addWorktree(s.home, { repo: s.repo, member: "dana-impl-1", team: "n1", cli: "codex" });
  fs.writeFileSync(path.join(rec.path, "lib", "x.js"), "2\n");
  const c = await commitWorktree(s.home, "dana-impl-1", { message: "m" });
  // A landing hoptell has no record of: the branch stays.
  git(s.repo, "merge", "-q", "--ff-only", c.commit);
  const kept = await removeWorktree(s.home, "dana-impl-1", { landed: { head: "0".repeat(40), candidate: c.commit, target: "main" } });
  assert.equal(kept.branchState, "kept");
  assert.match(kept.keptBecause, /is not the one that landed/);
  const again = await addWorktree(s.home, { repo: s.repo, member: "dana-impl-2", team: "n1", cli: "codex" });
  fs.writeFileSync(path.join(again.path, "lib", "x.js"), "3\n");
  const c2 = await commitWorktree(s.home, "dana-impl-2", { message: "m" });
  const notIn = await removeWorktree(s.home, "dana-impl-2", { landed: { head: c2.commit, candidate: c2.commit, target: "main" } });
  assert.match(notIn.keptBecause, /is not in main/);
  const third = await addWorktree(s.home, { repo: s.repo, member: "dana-impl-3", team: "n1", cli: "codex", base: c2.commit });
  fs.writeFileSync(path.join(third.path, "lib", "x.js"), "4\n");
  const c3 = await commitWorktree(s.home, "dana-impl-3", { message: "m" });
  git(s.repo, "merge", "-q", "--ff-only", c3.commit);
  const gone = await removeWorktree(s.home, "dana-impl-3", { landed: { head: c3.commit, candidate: c3.commit, target: "main" } });
  assert.equal(gone.branchState, "deleted");
  assert.equal(readWorktreeRecord(s.home, "dana-impl-3").problem !== undefined, true);
});

test("worktree add with a team's worktrees folder: used when given; inside the repository it is refused", async (t) => {
  const s = repoSetup(t);
  const parent = path.join(s.root, "elsewhere");
  const rec = await addWorktree(s.home, { repo: s.repo, member: "dana-impl-1", team: "n1", cli: "codex", parent });
  assert.equal(rec.path, path.join(parent, "dana-impl-1"));
  await refusal(() => addWorktree(s.home, { repo: s.repo, member: "dana-impl-2", team: "n1", cli: "codex", parent: path.join(s.repo, "wt") }), "bad_folder", /outside the repository/);
});

/** A team state of the full shape (readState checks every field), for the supervisor tests. */
/** The registration of dana-impl-1's worktree, as a team keeps it. */
const reg = (home, member = "dana-impl-1") => registrationOf(readWorktreeRecord(home, member).rec);

function stateOf(team, members, extra = {}) {
  return { version: 1, team, file: "/x/team.json", fileDigest: "0".repeat(64), lead: "dana-lead", prefix: "dana", repo: "/x/repo", base: "HEAD", worktrees: null, idleMinutes: 30, status: "up", created: new Date(0).toISOString(), members, supervisor: null, candidate: null, landing: null, publishing: null, landed: [], reviews: [], events: [], ...extra };
}
function memberRow(name, role, session, extra = {}) {
  return { name, role, cli: "claude", model: null, effort: null, template: role, owns: null, folder: null, lifetimeMinutes: null, argv: ["claude"], taskDigest: null, cwd: "/x/repo", worktree: null, branch: null, registration: null, session, ended: null, notice: null, ...extra };
}
function sleepers(t) {
  const procs = [];
  t.after(() => {
    for (const p of procs) {
      try {
        process.kill(p.pid);
      } catch {}
    }
  });
  return (started) => {
    const p = spawn("sleep", ["60"], { stdio: "ignore" });
    procs.push(p);
    return { id: `$${procs.length}`, pane: `%${procs.length}`, pid: p.pid, root: processIdentity(p.pid), started: new Date(started).toISOString() };
  };
}
const writeTeam = (home, s) => {
  fs.mkdirSync(teamPaths(home, s.team).dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(teamPaths(home, s.team).state, JSON.stringify(s), { mode: 0o600 });
};

test("supervisor: a lifetime ends any member, idleness only a reviewer; a notice first, the end a minute later, by session id; the lead is told", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "hoptell-sup-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const session = sleepers(t);
  const T0 = Date.parse("2026-10-28T10:00:00Z");
  const quiet = new Set(["dana-n1-rev-1", "dana-n1-impl-1", "dana-n1-rev-3"]); // no output since the start
  writeTeam(home, stateOf("n1", [memberRow("dana-n1-rev-1", "reviewer", session(T0)), memberRow("dana-n1-rev-2", "reviewer", session(T0)), memberRow("dana-n1-impl-1", "implementer", session(T0)), memberRow("dana-n1-rev-3", "reviewer", session(T0), { lifetimeMinutes: 10 })]));
  let now = T0 + 31 * 60_000;
  const notices = [];
  const ends = [];
  const told = [];
  const deps = {
    now: () => now,
    activity: (m) => (quiet.has(m.name) ? T0 : T0 + 20 * 60_000), // rev-2: output 11 minutes ago
    notice: (m, text) => notices.push([m.name, text]),
    endSession: (pane, pid, id) => {
      ends.push(id);
      process.kill(pid);
      return true;
    },
    notify: async (text) => told.push(text),
  };
  assert.deepEqual(await superviseTick(home, "n1", deps), []);
  assert.deepEqual(notices.map((n) => n[0]).sort(), ["dana-n1-rev-1", "dana-n1-rev-3"], "the idle reviewer and the one over its lifetime; never the implementer");
  assert.match(notices.find((n) => n[0] === "dana-n1-rev-1")[1], /ends in about a minute \(idle for 30 minutes\)/);
  assert.match(notices.find((n) => n[0] === "dana-n1-rev-3")[1], /its lifetime of 10 minutes is over/);
  now += NOTICE_MS - 1000;
  assert.deepEqual(await superviseTick(home, "n1", deps), [], "not before the notice had its minute");
  now += 1000;
  assert.deepEqual((await superviseTick(home, "n1", deps)).sort(), ["dana-n1-rev-1", "dana-n1-rev-3"]);
  assert.deepEqual(ends.sort(), ["$1", "$4"]);
  assert.equal(told.length, 2);
  assert.match(told.join("\n"), /hoptell team n1: dana-n1-rev-1 was ended \(idle for 30 minutes\)\. hoptell team restart dana-n1-rev-1 starts it again\./);
  const after = readState(home, "n1");
  assert.deepEqual(after.members.map((m) => m.ended?.reason ?? null), ["idle", null, null, "lifetime"]);
  assert.ok(after.events.some((e) => /ended dana-n1-rev-1 \(idle\)/.test(e.what)));
  // Activity after the notice takes it back.
  now += 15 * 60_000;
  deps.activity = (m) => (m.name === "dana-n1-rev-2" ? now - 1000 : T0);
  await superviseTick(home, "n1", deps);
  assert.equal(readState(home, "n1").members[1].notice, null);
  // Activity that cannot be read (null, a tmux error) is never idleness.
  deps.activity = () => null;
  now += 60 * 60_000;
  notices.length = 0;
  await superviseTick(home, "n1", deps);
  assert.deepEqual(notices, []);
  // A lead that cannot be told is an event, not a failure.
  const s2 = readState(home, "n1");
  s2.members[1].notice = { reason: "idle", at: new Date(now - NOTICE_MS).toISOString() };
  writeTeam(home, s2);
  deps.activity = () => T0;
  deps.notify = async () => {
    throw new Error("relay down");
  };
  await superviseTick(home, "n1", deps);
  assert.ok(readState(home, "n1").events.some((e) => /the lead was not told about dana-n1-rev-2: relay down/.test(e.what)));
  // A team that is down ends the supervisor's loop.
  const s3 = readState(home, "n1");
  s3.status = "down";
  writeTeam(home, s3);
  assert.equal(await superviseTick(home, "n1", deps), null);
  await sleep(10);
});

test("supervisor and down: a stop that fails, an unknown identity or a stale supervisor is never taken for success", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "hoptell-sup-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const session = sleepers(t);
  const T0 = Date.parse("2026-10-28T10:00:00Z");
  const rev = memberRow("dana-n2-rev-1", "reviewer", session(T0), { notice: { reason: "idle", at: new Date(T0).toISOString() } });
  writeTeam(home, stateOf("n2", [rev]));
  const ends = [];
  const base = { now: () => T0 + 120 * 60_000, activity: () => T0, notice: () => true, notify: async () => {}, wait: 300 };
  // endSession says no (false), or fails (a tmux error): nothing is ended, it is retried, and the
  // supervisor's loop goes on.
  const tmuxError = () => {
    throw new Error("tmux: server exited unexpectedly");
  };
  for (const endSession of [() => false, tmuxError]) {
    assert.deepEqual(await superviseTick(home, "n2", { ...base, endSession }), []);
    const s = readState(home, "n2");
    assert.equal(s.members[0].ended, null);
    assert.match(s.events.at(-1).what, /could not end dana-n2-rev-1 \(idle\): running; trying again/);
  }
  // An identity that cannot be checked: no signal at all.
  ends.length = 0;
  const unknown = { state: () => "unknown" };
  assert.deepEqual(await superviseTick(home, "n2", { ...base, procs: unknown, endSession: () => ends.push("signal") }), []);
  assert.deepEqual(ends, []);
  const down = await teamDown(home, "n2", {}, { ...base, procs: unknown, endSession: () => ends.push("signal") });
  assert.equal(down.down, false);
  assert.deepEqual(ends, [], "no signal while the identity is unknown");
  assert.equal(readState(home, "n2").status, "stopping");
  assert.match(readState(home, "n2").events.at(-1).what, /down not confirmed: dana-n2-rev-1 unknown/);

  // The supervisor: a stale identity (its pid now another process) gets no signal; an unknown one
  // neither, and the team is not down.
  const sup = session(T0);
  const s = readState(home, "n2");
  s.members = [memberRow("dana-n2-rev-1", "reviewer", null)];
  // Another start in the same form as the real one (Linux: clock ticks; macOS: ps lstart): a
  // start in the other form is no comparison, so it would read as unknown.
  const otherStart = /^\d+$/.test(sup.root.start) ? String(Number(sup.root.start) + 1) : "Thu Jan  1 00:00:00 1970";
  s.supervisor = { ...sup, root: { ...sup.root, start: otherStart } };
  writeTeam(home, s);
  const calls = [];
  const r = await teamDown(home, "n2", {}, { ...base, endSession: (pane, pid, id) => calls.push(id) });
  assert.deepEqual(calls, []);
  assert.deepEqual(r.report[0], { name: "supervisor", state: "not running" }, `stored ${JSON.stringify(s.supervisor.root)}; now ${JSON.stringify(processInfo(sup.root.pid))}; boot ${currentBoot()}; identityState ${identityState(s.supervisor.root)}`);
  assert.equal(r.down, true);
  s.status = "up";
  s.supervisor = sup;
  writeTeam(home, s);
  const r2 = await teamDown(home, "n2", {}, { ...base, procs: { state: () => "unknown" }, endSession: (pane, pid, id) => calls.push(id) });
  assert.deepEqual(calls, []);
  assert.equal(r2.down, false);
  assert.ok(readState(home, "n2").supervisor, "the supervisor's record stays");
  // Confirmed: the supervisor's process really ends.
  const r3 = await teamDown(home, "n2", {}, { ...base, endSession: (pane, pid, id) => (calls.push(id), process.kill(pid), true) });
  assert.deepEqual(calls, [sup.id]);
  assert.deepEqual(r3.report[0], { name: "supervisor", state: "stopped" });
  assert.equal(r3.down, true);
  assert.equal(readState(home, "n2").status, "down");
  // A session recorded without an identity: never signalled; confirmed once its pid is gone.
  const gone = spawnSync("true").pid;
  s.status = "up";
  s.supervisor = null;
  s.members = [memberRow("dana-n2-rev-1", "reviewer", { ...session(T0), root: null })];
  writeTeam(home, s);
  const r4 = await teamDown(home, "n2", {}, { ...base, endSession: (pane, pid, id) => calls.push(id) });
  assert.equal(r4.down, false, "a live pid without an identity is not confirmed");
  assert.deepEqual(calls, [sup.id], "and gets no signal");
  s.members = [memberRow("dana-n2-rev-1", "reviewer", { id: "$40", pane: "%40", pid: gone, root: null, started: new Date(T0).toISOString() })];
  writeTeam(home, s);
  const r5 = await teamDown(home, "n2", {}, { ...base, endSession: (pane, pid, id) => calls.push(id) });
  assert.equal(r5.down, true);
  assert.deepEqual(r5.report, [{ name: "dana-n2-rev-1", state: "exited" }]);
});

test("a malformed team state is refused before any stop runs", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "hoptell-sup-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const session = sleepers(t);
  const good = stateOf("n3", [memberRow("dana-n3-rev-1", "reviewer", session(Date.now()))]);
  assert.equal(stateProblem(good, "n3"), null);
  const bad = [
    ["a session id that is not $<n>", (x) => (x.members[0].session.id = "hoptell-dana")],
    ["a pane that is not %<n>", (x) => (x.members[0].session.pane = "0")],
    ["root.pid not the pid", (x) => (x.members[0].session.root = { ...x.members[0].session.root, pid: x.members[0].session.root.pid + 1 })],
    ["a root that is not an identity", (x) => (x.members[0].session.root = { pid: x.members[0].session.pid })],
    ["a supervisor without its identity", (x) => (x.supervisor = { id: "$9", pane: "%9", pid: 4242, started: new Date().toISOString() })],
    ["an unknown field", (x) => (x.extra = 1)],
    ["an unknown member field", (x) => (x.members[0].extra = 1)],
    ["a missing field", (x) => delete x.landing],
    ["an unknown status", (x) => (x.status = "running")],
    ["a member twice", (x) => x.members.push(structuredClone(x.members[0]))],
    ["a landing with a short id", (x) => x.landed.push({ member: "dana-n3-rev-1", H: "abc", C: "0".repeat(40), T: "0".repeat(40), target: "main", at: new Date().toISOString() })],
  ];
  for (const [what, change] of bad) {
    const x = structuredClone(good);
    change(x);
    assert.ok(stateProblem(x, "n3"), what);
    writeTeam(home, x);
    const calls = [];
    const deps = { endSession: () => calls.push("signal"), sleep: async () => {}, wait: 0 };
    await refusal(() => teamDown(home, "n3", {}, deps), "bad_state", /not a valid team state of n3/);
    await refusal(() => teamStop(home, "dana-n3-rev-1", deps), "bad_state");
    assert.deepEqual(calls, [], `${what}: no stop ran`);
  }
});

test("team file: the schema file and the checker agree on fields, enums and limits", () => {
  const schema = JSON.parse(fs.readFileSync(new URL("../schema/team.schema.json", import.meta.url), "utf8"));
  const item = schema.properties.members.items;
  assert.deepEqual(Object.keys(schema.properties).sort(), ["base", "idleMinutes", "lead", "lifetimeMinutes", "members", "repo", "team", "version", "worktrees"]);
  assert.deepEqual(Object.keys(item.properties).sort(), ["cli", "effort", "folder", "lifetimeMinutes", "model", "name", "owns", "role", "task", "template"]);
  assert.deepEqual(item.properties.role.enum, ["implementer", "reviewer"]);
  assert.deepEqual(item.properties.cli.enum, ["codex", "claude", "agy"]);
  assert.deepEqual(item.properties.template.enum, ["reviewer", "implementer", "tester"]);
  assert.equal(schema.properties.members.maxItems, 16);
  assert.equal(schema.properties.lifetimeMinutes.maximum, 1440);
  assert.equal(item.properties.owns.maxItems, 64);
  // Every field the schema names is one the checker takes, and an unknown one is refused by both.
  const ok = { version: 1, team: "n1", repo: "/r", base: "main", worktrees: "/w", lead: "dana-lead", idleMinutes: { reviewer: 30 }, lifetimeMinutes: 60, members: [{ name: "dana-i", role: "implementer", cli: "codex", model: "m", effort: "high", task: "/t", owns: ["lib/**"], template: "implementer", lifetimeMinutes: 5, folder: "i" }] };
  assert.equal(checkTeam(ok, { file: "/x/team.json", homedir: "/h" }).members.length, 1);
  assert.throws(() => checkTeam({ ...ok, extra: 1 }, { file: "/x/team.json", homedir: "/h" }), /unknown field "extra"/);
  assert.equal(schema.additionalProperties, false);
  assert.equal(item.additionalProperties, false);
  // The same JSON types: what the schema's type refuses, the checker refuses too.
  const types = { team: "string", repo: "string", lead: "string", base: "string", worktrees: "string" };
  for (const [k, type] of Object.entries(types)) assert.equal(schema.properties[k].type, type, k);
  for (const [k, type] of Object.entries({ name: "string", model: "string", effort: "string", task: "string", owns: "array", folder: "string", lifetimeMinutes: "integer" })) assert.equal(item.properties[k].type, type, k);
  const file = { file: "/x/team.json", homedir: "/h" };
  const m0 = ok.members[0];
  for (const [what, doc, re] of [
    ["team as a number", { ...ok, team: 12 }, /team must be/],
    ["team as a list", { ...ok, team: ["n1"] }, /team must be/],
    ["owns null", { ...ok, members: [{ ...m0, owns: null }] }, /owns must be a list of globs \(leave it out/],
    ["owns as text", { ...ok, members: [{ ...m0, owns: "lib/**" }] }, /owns must be a list of globs/],
    ["owns empty", { ...ok, members: [{ ...m0, owns: [] }] }, /owns is a list of 1 to 64 globs/],
    ["folder as a number", { ...ok, members: [{ ...m0, folder: 12 }] }, /folder is an implementer's worktree folder name/],
    ["model as a number", { ...ok, members: [{ ...m0, model: 5 }] }, /model must be text/],
    ["lifetime as text", { ...ok, members: [{ ...m0, lifetimeMinutes: "5" }] }, /lifetimeMinutes must be 1 to 1440/],
    ["version as text", { ...ok, version: "1" }, /version must be 1/],
  ]) assert.throws(() => checkTeam(doc, file), re, what);
  // Left out, owns means the whole worktree.
  const noOwns = { ...m0 };
  delete noOwns.owns;
  assert.equal(checkTeam({ ...ok, members: [noOwns] }, file).members[0].owns, null);
});

test("team up stopped while making worktrees: nothing started, status and down cope with members never started", { skip: !hasTmux && "tmux not installed" }, async (t) => {
  const w = await world();
  t.after(async () => {
    spawnSync("tmux", ["kill-server"]);
    await w.close();
  });
  const s = repoSetup(t);
  const f = fakeClis(s.root);
  fs.mkdirSync(path.join(s.root, "tasks"));
  fs.writeFileSync(path.join(s.root, "tasks", "impl.md"), "Implement it.\n");
  const file = path.join(s.root, "team.json");
  fs.writeFileSync(file, JSON.stringify(teamDoc({ team: "n3", members: [memberOf({ name: "dana-n3-a" }), memberOf({ name: "dana-n3-b", owns: ["test/**"] })] })));
  git(s.repo, "branch", "team/n3/dana-n3-b"); // the second worktree add is refused
  const env = { PATH: f.PATH, HOME: s.homedir, HOPTELL_PUSH: "" };
  const up = await w.cli(["team", "up", file, "--yes"], env);
  assert.equal(up.code, 1);
  assert.match(up.stderr, /team up stopped at dana-n3-b: .*team\/n3\/dana-n3-b/);
  assert.match(up.stderr, /No member was started; hoptell team down n3 removes the worktrees made so far/);
  const state = readState(w.home, "n3");
  assert.equal(state.status, "partial");
  assert.ok(state.members.every((m) => m.session === null));
  const st = await w.cli(["team", "status", "n3"], env);
  assert.equal(st.code, 0, st.stderr);
  assert.match(st.stdout, /dana-n3-a .* not started/);
  const down = await w.cli(["team", "down", "n3"], env);
  assert.equal(down.code, 0, down.stderr);
  assert.match(down.stdout, /dana-n3-a: not started; worktree removed; branch team\/n3\/dana-n3-a deleted/);
  assert.ok(!fs.existsSync(state.members[0].worktree));
  assert.ok(git(s.repo, "rev-parse", "team/n3/dana-n3-b"), "the branch hoptell did not make stays");
});

/** The fields team up records for landing actions: a run id and the repository's enrolment. */
const enrolled = (rec) => ({ run: "0".repeat(32), enrolment: { common: rec.common, id: "1".repeat(32), generation: 1 }, actions: [] });

/** A signed repository with one team member whose commit has a candidate on main (not checked out). */
async function landingSetup(t, team = "n4", { candidate = true } = {}) {
  const s = repoSetup(t, { signing: true });
  git(s.repo, "commit", "-q", "--allow-empty", "-m", "second"); // T has a parent to rewind to
  const member = `dana-${team}-impl-1`;
  const rec = await addWorktree(s.home, { repo: s.repo, member, team, cli: "codex" });
  fs.writeFileSync(path.join(rec.path, "lib", "x.js"), "2\n");
  await commitWorktree(s.home, member, { message: "m" });
  writeTeam(s.home, stateOf(team, [memberRow(member, "implementer", null, { cli: "codex", template: "implementer", worktree: rec.path, branch: rec.branch, registration: registrationOf(rec), cwd: rec.path })], { repo: s.repo, ...enrolled(rec) }));
  git(s.repo, "checkout", "-q", "-b", "dev"); // main is not checked out anywhere
  const c = candidate ? await teamLandCandidate(s.home, member, { target: "main", message: "Land", homedir: s.homedir }) : null;
  return { s, rec, c, member, landRef: `refs/heads/team/${team}/land` };
}
const refOf = (repo, ref) => {
  const r = spawnSync("git", ["rev-parse", "--verify", "-q", ref], { cwd: repo, env: gitEnv, encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
};

test("landing moves only refs/heads/<target>, by compare-and-swap from T: a rewind or a HEAD switch in the gap", async (t) => {
  const { s, rec, c, member, landRef } = await landingSetup(t);
  const opts = { homedir: s.homedir };
  // The target rewound to an ancestor of T between the checks and the move: nothing moves.
  await refusal(() => teamLandApprove(s.home, member, { T: c.T, C: c.C, ...opts }, { beforeMove: () => git(s.repo, "update-ref", "refs/heads/main", `${c.T}~1`) }), "target_moved", /main moved while landing; nothing was landed/);
  assert.equal(refOf(s.repo, "main"), git(s.repo, "rev-parse", `${c.T}~1`));
  assert.equal(refOf(s.repo, landRef), c.C, "the candidate stays");
  assert.ok(fs.existsSync(rec.path));
  assert.equal(readState(s.home, "n4").landing, null, "the intent of a move that did not happen is dropped");
  assert.deepEqual(readState(s.home, "n4").landed, []);
  git(s.repo, "update-ref", "refs/heads/main", c.T);
  // HEAD switches to another branch at T in the gap: only main moves, the other branch stays.
  git(s.repo, "branch", "other", c.T);
  const r = await teamLandApprove(s.home, member, { T: c.T, C: c.C, ...opts }, { beforeMove: () => git(s.repo, "checkout", "-q", "other") });
  assert.equal(r.C, c.C);
  assert.equal(refOf(s.repo, "main"), c.C);
  assert.equal(refOf(s.repo, "other"), c.T);
  assert.equal(refOf(s.repo, "dev"), c.T);
  assert.equal(refOf(s.repo, landRef), null);
  assert.ok(!fs.existsSync(rec.path));
  const st = readState(s.home, "n4");
  assert.equal(st.landing, null);
  assert.deepEqual(st.landed.map((l) => [l.member, l.H, l.C, l.T, l.target]), [[member, c.H, c.C, c.T, "main"]]);
});

test("landing keeps its evidence until the landing is recorded: a failed write or a crash at each step is finished by the same command", async (t) => {
  const enospc = () => Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
  const failing = (n) => {
    let calls = 0;
    return (home, st) => {
      calls += 1;
      if (calls === n) throw enospc();
      fs.writeFileSync(teamPaths(home, st.team).state, JSON.stringify(st), { mode: 0o600 });
    };
  };
  // The writes of a landing: ready (1), approved (2), accepted with the journal (3), moving (4),
  // landed (5), finished (6).
  // 1. The journal of the intent cannot be written: nothing moves.
  {
    const { s, rec, c, member, landRef } = await landingSetup(t);
    await assert.rejects(teamLandApprove(s.home, member, { T: c.T, C: c.C, homedir: s.homedir }, { save: failing(3) }), /ENOSPC/);
    assert.equal(refOf(s.repo, "main"), c.T);
    assert.equal(refOf(s.repo, landRef), c.C);
    assert.ok(fs.existsSync(rec.path));
  }
  // 2. The target moved, but the landing cannot be recorded: the candidate branch and the worktree
  // stay, the journal says what moved, and the same command finishes it.
  {
    const { s, rec, c, member, landRef } = await landingSetup(t);
    await refusal(() => teamLandApprove(s.home, member, { T: c.T, C: c.C, homedir: s.homedir }, { save: failing(5) }), "not_recorded", /main is at .*, but the landing could not be recorded \(ENOSPC.*\); the candidate branch and the worktree are kept/);
    assert.equal(refOf(s.repo, "main"), c.C);
    assert.equal(refOf(s.repo, landRef), c.C);
    assert.ok(fs.existsSync(rec.path));
    const j = readState(s.home, "n4").landing;
    assert.deepEqual([j.phase, j.member, j.H, j.T, j.C, j.target, j.repo, j.action], ["intent", member, c.H, c.T, c.C, "main", s.repo, "L1"]);
    assert.equal(readState(s.home, "n4").actions[0].state, "moving");
    // Another landing waits for this one; a discard too.
    await refusal(() => teamLandApprove(s.home, member, { T: c.T, C: "f".repeat(40), homedir: s.homedir }), "landing_pending");
    await refusal(() => teamCommand({ args: ["land", member, "--discard"], home: s.home, homedir: s.homedir, env: {}, out: () => {}, warn: () => {}, fail: (m) => { throw Object.assign(new Error(m), { code: "landing_pending" }); } }), "landing_pending", /the landing of .* did not finish/);
    const r = await teamLandApprove(s.home, member, { T: c.T, C: c.C, homedir: s.homedir });
    assert.equal(r.removed.branchState, "deleted");
    assert.equal(refOf(s.repo, landRef), null);
    assert.ok(!fs.existsSync(rec.path));
    const st = readState(s.home, "n4");
    assert.equal(st.landing, null);
    assert.equal(st.landed.length, 1);
  }
  // 3. A crash after the landing was recorded, before the evidence went: finished, recorded once.
  {
    const { s, rec, c, member, landRef } = await landingSetup(t);
    git(s.repo, "update-ref", "refs/heads/main", c.C, c.T);
    const st = readState(s.home, "n4");
    const at = new Date().toISOString();
    st.landing = { member, H: c.H, C: c.C, T: c.T, target: "main", at, repo: s.repo, phase: "landed" };
    st.landed.push({ member, H: c.H, C: c.C, T: c.T, target: "main", at });
    writeTeam(s.home, st);
    const r = await teamLandApprove(s.home, member, { T: c.T, C: c.C, homedir: s.homedir });
    assert.equal(r.removed.branchState, "deleted");
    assert.equal(refOf(s.repo, landRef), null);
    assert.ok(!fs.existsSync(rec.path));
    assert.equal(readState(s.home, "n4").landed.length, 1, "recorded once");
    assert.equal(readState(s.home, "n4").landing, null);
  }
  // 4. A crash after the move, before the record (the journal says intent): finished.
  {
    const { s, rec, c, member } = await landingSetup(t);
    git(s.repo, "update-ref", "refs/heads/main", c.C, c.T);
    await refusal(() => teamLandApprove(s.home, member, { T: c.T, C: c.C, homedir: s.homedir }), "already_landed", /--confirm/);
    const st = readState(s.home, "n4");
    st.landing = { member, H: c.H, C: c.C, T: c.T, target: "main", at: new Date().toISOString(), repo: s.repo, phase: "intent" };
    writeTeam(s.home, st);
    await teamLandApprove(s.home, member, { T: c.T, C: c.C, homedir: s.homedir });
    assert.ok(!fs.existsSync(rec.path));
    assert.equal(readState(s.home, "n4").landed.length, 1);
  }
  // 5. The last write (clearing the journal) fails after the evidence went: the rerun clears it.
  {
    const { s, rec, c, member } = await landingSetup(t);
    await assert.rejects(teamLandApprove(s.home, member, { T: c.T, C: c.C, homedir: s.homedir }, { save: failing(6) }), /ENOSPC/);
    assert.ok(!fs.existsSync(rec.path));
    assert.equal(readState(s.home, "n4").landing.phase, "landed");
    assert.equal(readTombstone(s.home, "n4", "L1").state, "finished", "the tombstone came first");
    const r = await teamLandApprove(s.home, member, { T: c.T, C: c.C, homedir: s.homedir });
    // The rerun reports the cleanup that happened, from the final record, not a guess.
    assert.deepEqual([r.id, r.removed.branchState, r.removed.path], ["L1", "deleted", rec.path]);
    assert.deepEqual(readTombstone(s.home, "n4", "L1").result, r.removed);
    assert.equal(readState(s.home, "n4").landing, null);
    assert.equal(readState(s.home, "n4").landed.length, 1);
  }
});

test("--confirm records only a target that is exactly at the verified candidate", async (t) => {
  const { s, rec, c, member } = await landingSetup(t);
  const confirm = () => teamLandApprove(s.home, member, { T: c.T, C: c.C, homedir: s.homedir, confirm: true });
  await refusal(confirm, "not_landed", /main is at \w+, not at \w+; nothing was recorded\. Move main to \w+ first/);
  const other = git(s.repo, "commit-tree", "-p", c.T, "-m", "other", git(s.repo, "rev-parse", `${c.T}^{tree}`));
  git(s.repo, "update-ref", "refs/heads/main", other, c.T);
  await refusal(confirm, "not_landed", new RegExp(`main is at ${other.slice(0, 12)}, not at ${c.C.slice(0, 12)}; nothing was recorded`));
  assert.deepEqual(readState(s.home, "n4").landed, []);
  git(s.repo, "update-ref", "refs/heads/main", c.C, other);
  const r = await confirm();
  assert.equal(r.C, c.C);
  assert.ok(!fs.existsSync(rec.path));
  assert.equal(readState(s.home, "n4").landed.length, 1);
});

/** landingSetup with main checked out in the repository (landing mode checkout). */
async function checkoutSetup(t) {
  const x = await landingSetup(t);
  git(x.s.repo, "checkout", "-q", "main");
  return { ...x, file: path.join(x.s.repo, "lib", "x.js"), approve: (deps = {}, more = {}) => teamLandApprove(x.s.home, x.member, { T: x.c.T, C: x.c.C, homedir: x.s.homedir, ...more }, deps) };
}
const MIN = 60_000;

test("a checked-out target (option 1): two checkouts refuse; a dirty checkout or an operation in progress blocks before the move; a clean one is fast-forwarded by hoptell", async (t) => {
  const x = await checkoutSetup(t);
  const clean = fs.readFileSync(x.file, "utf8");
  // Two worktrees on main: refused before any action is made.
  const second = path.join(x.s.root, "second");
  git(x.s.repo, "worktree", "add", "-q", "--force", second, "main");
  await refusal(() => x.approve(), "land_blocked", /main is checked out in 2 worktrees \(.*repo, .*second\); hoptell moves a checked-out target only when exactly one worktree has it\. Nothing was moved\./);
  assert.deepEqual(readState(x.s.home, "n4").actions, []);
  git(x.s.repo, "worktree", "remove", second);
  // A merge in progress: the action ends blocked (its tombstone says why), nothing moves.
  const mergeHead = path.join(x.s.repo, ".git", "MERGE_HEAD");
  fs.writeFileSync(mergeHead, `${x.c.T}\n`);
  await refusal(() => x.approve(), "land_blocked", /main is checked out in .*repo, and a merge is in progress there\. Nothing was moved\. Fix that, then run the same hoptell team land dana-n4-impl-1 --approve \w+ \w+ again; hoptell then moves it itself/);
  fs.rmSync(mergeHead);
  // A staged change.
  fs.writeFileSync(x.file, "staged\n");
  git(x.s.repo, "add", "lib/x.js");
  await refusal(() => x.approve(), "land_blocked", /and it has 1 uncommitted change: lib\/x\.js/);
  git(x.s.repo, "reset", "-q", "--hard");
  assert.deepEqual([readTombstone(x.s.home, "n4", "L1").state, readTombstone(x.s.home, "n4", "L2").state], ["blocked", "blocked"]);
  assert.match(readTombstone(x.s.home, "n4", "L1").reason, /a merge is in progress/);
  assert.equal(refOf(x.s.repo, "main"), x.c.T);
  assert.equal(fs.readFileSync(x.file, "utf8"), clean);
  // Clean: hoptell fast-forwards the checkout itself, under a new action.
  const r = await x.approve();
  assert.equal(r.id, "L3");
  assert.equal(refOf(x.s.repo, "main"), x.c.C);
  assert.equal(git(x.s.repo, "symbolic-ref", "HEAD"), "refs/heads/main");
  assert.equal(git(x.s.repo, "status", "--porcelain", "--untracked-files=no"), "");
  assert.equal(fs.readFileSync(x.file, "utf8"), execFileSync("git", ["show", `${x.c.C}:lib/x.js`], { cwd: x.s.repo, env: gitEnv, encoding: "utf8" }), "the checkout's files moved too");
  const st = readState(x.s.home, "n4");
  assert.deepEqual([st.actions, st.landing, st.candidate, st.landed.length], [[], null, null, 1]);
  assert.equal(readTombstone(x.s.home, "n4", "L3").state, "finished");
});

test("from moving on nothing moves again: crashes before and after the move, a merge stopped half-way, \"Already up to date\"; --confirm reconciles", async (t) => {
  const crash = () => {
    throw new Error("crash");
  };
  // A crash after `moving` was written, before the merge ran: the rerun never merges. main is still
  // at T and the checkout is clean, so the outcome is unknown and the paste-safe line is printed.
  {
    const x = await checkoutSetup(t);
    await assert.rejects(x.approve({ afterMoving: crash }), /crash/);
    assert.equal(readState(x.s.home, "n4").actions[0].state, "moving");
    const g = faultyGit(x.s.root);
    g.set([{ match: "merge --ff-only", nth: 1, action: "exit128" }]); // a merge would fail the test
    let message;
    await refusal(
      async () => {
        try {
          await x.approve({ git: g.git });
        } catch (e) {
          message = e.message;
          throw e;
        }
      },
      "land_unknown",
      /^an earlier run stopped while it moved the target, and main is at \w+, not at \w+\. Whether main moved is unknown, so the landing L1 is blocked: hoptell does not move it again and resets nothing\.\nmain is still at \w+ and .*repo is clean\. Check what happened there first; to land it by hand, run the line below in that folder/,
    );
    assert.equal(refOf(x.s.repo, "main"), x.c.T, "no second move");
    assert.equal(readState(x.s.home, "n4").actions[0].state, "blocked");
    assert.equal(readState(x.s.home, "n4").landing.phase, "intent", "the journal stays");
    assert.ok(!message.includes("#"));
    // The printed line, pasted into a shell: with a wrong check nothing merges; as printed, it merges.
    const line = message.split("\n").find((l) => l.startsWith("  test ")).trim();
    assert.equal(line, `test "$(git symbolic-ref HEAD)" = refs/heads/main && test "$(git rev-parse HEAD)" = ${x.c.T} && git merge --ff-only ${x.c.C}`);
    assert.ok(message.endsWith(`then record it: hoptell team land ${x.member} --confirm ${x.c.T} ${x.c.C}`));
    const paste = (text) => spawnSync("sh", ["-c", text], { cwd: x.s.repo, env: gitEnv, encoding: "utf8" });
    assert.notEqual(paste(line.replace(`= ${x.c.T} `, `= ${x.c.C} `)).status, 0);
    assert.equal(refOf(x.s.repo, "main"), x.c.T, "a failed check merges nothing");
    // --approve leaves a blocked action alone; --confirm before the merge records nothing.
    await refusal(() => x.approve(), "land_blocked", /the landing L1 is blocked/);
    await refusal(() => x.approve({}, { confirm: true }), "not_landed", /main is at \w+, not at \w+; nothing was recorded/);
    assert.equal(paste(line).status, 0);
    const r = await x.approve({}, { confirm: true });
    assert.equal(r.id, "L1", "the same action");
    const st = readState(x.s.home, "n4");
    assert.deepEqual([st.actions, st.landing, st.landed.length], [[], null, 1]);
    assert.equal(readTombstone(x.s.home, "n4", "L1").state, "finished");
  }
  // A crash after the merge, before the record: the rerun reads the result (no merge) and finishes.
  {
    const x = await checkoutSetup(t);
    await assert.rejects(x.approve({ afterMove: crash }), /crash/);
    assert.equal(refOf(x.s.repo, "main"), x.c.C);
    const g = faultyGit(x.s.root);
    g.set([{ match: "merge --ff-only", nth: 1, action: "exit128" }]);
    const r = await x.approve({ git: g.git });
    assert.equal(r.id, "L1");
    assert.equal(readState(x.s.home, "n4").landed.length, 1);
  }
  // A merge that changed the checkout and was stopped before its ref update: unknown, blocked,
  // nothing reset, no line to paste (the checkout is dirty); only --confirm can end it.
  {
    const x = await checkoutSetup(t);
    const g = faultyGit(x.s.root);
    g.set([{ match: "merge --ff-only", nth: 1, action: "dirtyKill" }]);
    await refusal(() => x.approve({ git: g.git }), "land_unknown", /^git merge --ff-only ended with stopped by a signal, and main is at \w+, not at \w+; in .*repo, it has 1 uncommitted change: lib\/x\.js\. Whether main moved is unknown, so the landing L1 is blocked: hoptell does not move it again and resets nothing\. Check .*repo; once main is at \w+ and that checkout is on it and clean, record it with hoptell team land dana-n4-impl-1 --confirm \w+ \w+$/);
    assert.equal(fs.readFileSync(x.file, "utf8"), "half\n", "nothing reset");
    assert.equal(refOf(x.s.repo, "main"), x.c.T);
    const st = readState(x.s.home, "n4");
    assert.deepEqual([st.actions[0].state, st.landing.phase], ["blocked", "intent"]);
    g.set([]);
    await refusal(() => x.approve({ git: g.git }), "land_blocked");
    await refusal(() => x.approve({ git: g.git }, { confirm: true }), "not_landed");
    assert.equal(refOf(x.s.repo, "main"), x.c.T, "never a second move");
  }
  // "Already up to date" is not a landing, even with status 0.
  {
    const x = await checkoutSetup(t);
    const g = faultyGit(x.s.root);
    g.set([{ match: "merge --ff-only", nth: 1, action: "uptodate0" }]);
    await refusal(() => x.approve({ git: g.git }), "land_unknown", /^git merge --ff-only said "Already up to date", and main is at \w+, not at \w+\. Whether main moved is unknown/);
    assert.equal(readState(x.s.home, "n4").actions[0].state, "blocked");
  }
  // A branch-only target (mode ref): a crash after `moving`, before the update: never a second move.
  {
    const x = await landingSetup(t);
    await assert.rejects(teamLandApprove(x.s.home, x.member, { T: x.c.T, C: x.c.C, homedir: x.s.homedir }, { afterMoving: crash }), /crash/);
    await refusal(() => teamLandApprove(x.s.home, x.member, { T: x.c.T, C: x.c.C, homedir: x.s.homedir }), "land_unknown", /^an earlier run stopped while it moved the target, and main is at \w+, not at \w+\. Whether main moved is unknown, so the landing L1 is blocked.* Check main; once main is at \w+, record it with/);
    assert.equal(refOf(x.s.repo, "main"), x.c.T);
  }
});

test("expiry is checked only on the way to accepted: a decision that never started expires, an accepted or moving landing finishes late", async (t) => {
  const enospc = (n) => {
    let calls = 0;
    return (home, st) => {
      if (++calls === n) throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
      fs.writeFileSync(teamPaths(home, st.team).state, JSON.stringify(st), { mode: 0o600 });
    };
  };
  const later = () => Date.now() + 16 * MIN;
  // Approved, then the acceptance could not be written: 16 minutes later that decision has
  // expired; the new decision is a new action.
  {
    const x = await checkoutSetup(t);
    await assert.rejects(x.approve({ save: enospc(3) }), /ENOSPC/);
    assert.equal(readState(x.s.home, "n4").actions[0].state, "approved");
    assert.equal(refOf(x.s.repo, "main"), x.c.T);
    const r = await x.approve({ now: later });
    assert.equal(r.id, "L2");
    assert.equal(readTombstone(x.s.home, "n4", "L1").state, "expired");
    assert.equal(readState(x.s.home, "n4").landed.length, 1);
  }
  // Accepted (moving could not be written): nothing expires any more; the same action lands.
  {
    const x = await checkoutSetup(t);
    await assert.rejects(x.approve({ save: enospc(4) }), /ENOSPC/);
    assert.equal(readState(x.s.home, "n4").actions[0].state, "accepted");
    const r = await x.approve({ now: later });
    assert.equal(r.id, "L1");
    assert.equal(readState(x.s.home, "n4").landed.length, 1);
    assert.equal(refOf(x.s.repo, "main"), x.c.C);
  }
  // Moved, then a restart after expiry: recording and cleanup still finish, without a move.
  {
    const x = await checkoutSetup(t);
    await assert.rejects(x.approve({ afterMove: () => { throw new Error("crash"); } }), /crash/);
    const r = await x.approve({ now: later });
    assert.equal(r.id, "L1");
    assert.equal(readTombstone(x.s.home, "n4", "L1").state, "finished");
  }
});

test("the action record: a create-only canonical manifest bound by its digest, ids never reused across teams, tombstones through down and up, teams from before actions", async (t) => {
  const x = await landingSetup(t);
  const crash = () => {
    throw new Error("crash");
  };
  await assert.rejects(teamLandApprove(x.s.home, x.member, { T: x.c.T, C: x.c.C, homedir: x.s.homedir }, { afterMoving: crash }), /crash/);
  const file = path.join(x.s.home, "teams", "n4", "landings", "L1", "manifest.json");
  const bytes = fs.readFileSync(file, "utf8");
  const m = JSON.parse(bytes);
  assert.equal(bytes, canonicalize(m), "canonical JSON (JCS)");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(readState(x.s.home, "n4").actions[0].digest, crypto.createHash("sha256").update(bytes).digest("hex"));
  assert.deepEqual(Object.keys(m).sort(), ["C", "H", "T", "cleanup", "created_at", "enrolment", "evidence", "expires_at", "id", "member", "mode", "nonce", "parent", "realm", "recipient", "run", "target", "team", "version"]);
  assert.deepEqual([m.version, m.id, m.mode, m.parent, m.cleanup.candidate, m.recipient], [1, "L1", { kind: "ref" }, x.c.T, "team/n4/land", null]);
  assert.equal(Date.parse(m.expires_at) - Date.parse(m.created_at), 15 * MIN);
  // A changed manifest is not acted on.
  fs.chmodSync(file, 0o600);
  fs.writeFileSync(file, bytes.replace(x.c.C, x.c.T));
  await refusal(() => teamLandApprove(x.s.home, x.member, { T: x.c.T, C: x.c.C, homedir: x.s.homedir }), "action_changed", /the manifest of the landing L1 changed since it was made/);
  fs.writeFileSync(file, bytes);
  await refusal(() => teamLandApprove(x.s.home, x.member, { T: x.c.T, C: x.c.C, homedir: x.s.homedir }), "land_unknown");
  // Ids: the home's counter; a folder that exists in another team is never reused, even when
  // the counter was lost; an id in two teams is refused.
  fs.mkdirSync(path.join(x.s.home, "teams", "n7", "landings", "L2"), { recursive: true });
  fs.rmSync(path.join(x.s.home, "teams", "landings.seq"));
  assert.equal(await newActionId(x.s.home), "L3");
  assert.equal(await newActionId(x.s.home), "L4");
  assert.equal(teamOfAction(x.s.home, "L1"), "n4");
  fs.mkdirSync(path.join(x.s.home, "teams", "n7", "landings", "L1"), { recursive: true });
  assert.throws(() => teamOfAction(x.s.home, "L1"), /the landing L1 exists in several teams \(n4, n7\)/);
  assert.throws(() => teamOfAction(x.s.home, "L9"), /no landing L9/);
  // A state with only some of the action fields is refused.
  const st = readState(x.s.home, "n4");
  delete st.run;
  assert.equal(stateProblem(st, "n4"), "field run");

  // A team started before landing actions: --approve refuses with what to do, --discard works,
  // and down and up then enrol it.
  const y = await landingSetup(t, "n5");
  const legacy = readState(y.s.home, "n5");
  for (const k of ["run", "enrolment", "actions"]) delete legacy[k];
  writeTeam(y.s.home, legacy);
  await refusal(() => teamLandApprove(y.s.home, y.member, { T: y.c.T, C: y.c.C, homedir: y.s.homedir }), "legacy_team", /team n5 was started before landing actions .*: discard the candidate \(hoptell team land dana-n5-impl-1 --discard\), run hoptell team down n5 and hoptell team up again, then build the candidate again/);
  assert.equal(refOf(y.s.repo, "main"), y.c.T);
  await teamLandDiscard(y.s.home, y.member);
  assert.equal(readState(y.s.home, "n5").candidate, null);
  // ...and a journal it had pending still finishes as before.
  const v = await landingSetup(t, "n8");
  const old = readState(v.s.home, "n8");
  for (const k of ["run", "enrolment", "actions"]) delete old[k];
  old.landing = { member: v.member, H: v.c.H, C: v.c.C, T: v.c.T, target: "main", at: new Date().toISOString(), repo: v.s.repo, phase: "intent" };
  writeTeam(v.s.home, old);
  git(v.s.repo, "update-ref", "refs/heads/main", v.c.C, v.c.T);
  await teamLandApprove(v.s.home, v.member, { T: v.c.T, C: v.c.C, homedir: v.s.homedir });
  assert.deepEqual([readState(v.s.home, "n8").landing, readState(v.s.home, "n8").landed.length], [null, 1]);

  // Tombstones outlive team down and up: the landings folder stays, the new state has no actions.
  const z = await landingSetup(t, "n6");
  await teamLandApprove(z.s.home, z.member, { T: z.c.T, C: z.c.C, homedir: z.s.homedir });
  assert.equal((await teamDown(z.s.home, "n6", {}, { endSession: () => false, sleep: async () => {}, wait: 0 })).down, true);
  const f = fakeClis(z.s.root);
  fs.mkdirSync(path.join(z.s.root, "tasks"), { recursive: true });
  fs.writeFileSync(path.join(z.s.root, "tasks", "impl.md"), "x\n");
  const teamFile = path.join(z.s.root, "n6.json");
  fs.writeFileSync(teamFile, JSON.stringify(teamDoc({ team: "n6", repo: z.s.repo, members: [memberOf({ name: "dana-n6-rev-1", role: "reviewer", cli: "claude", task: "tasks/impl.md", owns: undefined })] })));
  const session = sleepers(t);
  const launch = async () => {
    const y = session(Date.now());
    return { session: "hoptell-x", sessionId: y.id, pane: y.pane, pid: y.pid };
  };
  await teamUp(teamFile, { home: z.s.home, homedir: z.s.homedir, env: { PATH: f.PATH }, yes: true }, { out: () => {}, warn: () => {}, launch, startSupervisor: async () => null });
  const up = readState(z.s.home, "n6");
  assert.deepEqual(up.actions, []);
  assert.deepEqual([up.enrolment.id, up.enrolment.generation], ["1".repeat(32), 2], "the same enrolment, started again");
  assert.equal(readTombstone(z.s.home, "n6", "L1").state, "finished", "kept through down and up");
});

test("a checkout of the target must be a worktree of the enrolled repository: a folder replaced by another clone gets no git, before the move and in recovery", async (t) => {
  const crash = () => {
    throw new Error("crash");
  };
  for (const when of ["before", "recovery"]) {
    const x = await landingSetup(t);
    // main checked out in a linked worktree of the repository.
    const wt = path.join(x.s.root, "mainwt");
    git(x.s.repo, "worktree", "add", "-q", wt, "main");
    const replace = () => {
      // The folder is replaced by another clone on main at the same T, with the same commits.
      fs.rmSync(wt, { recursive: true, force: true });
      execFileSync("git", ["clone", "-q", "-b", "main", x.s.repo, wt], { env: gitEnv });
      execFileSync("git", ["fetch", "-q", x.s.repo, x.c.C], { cwd: wt, env: gitEnv });
    };
    if (when === "before") {
      replace();
      await refusal(() => teamLandApprove(x.s.home, x.member, { T: x.c.T, C: x.c.C, homedir: x.s.homedir }), "land_blocked", /main is checked out in .*mainwt, but .*mainwt is not a worktree of .*\.git \(its \.git is another repository\); hoptell runs no git there\. Nothing was moved/);
    } else {
      await assert.rejects(teamLandApprove(x.s.home, x.member, { T: x.c.T, C: x.c.C, homedir: x.s.homedir }, { afterMoving: crash }), /crash/);
      replace();
      await refusal(() => teamLandApprove(x.s.home, x.member, { T: x.c.T, C: x.c.C, homedir: x.s.homedir }), "land_unknown", /is not a worktree of .*; hoptell runs no git there/);
      await refusal(() => teamLandApprove(x.s.home, x.member, { T: x.c.T, C: x.c.C, homedir: x.s.homedir, confirm: true }), "not_landed", /is not a worktree of/);
    }
    assert.equal(refOf(x.s.repo, "main"), x.c.T, when);
    assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: wt, env: gitEnv, encoding: "utf8" }).trim(), x.c.T, "the clone was not merged");
  }
});

test("a branch-only landing finishes only over a checkout that is at C and clean: one that appeared at T, or two, keep it blocked", async (t) => {
  // A checkout of main appears (at T) between the checks and the compare-and-swap: the ref moves,
  // but the landing is blocked, with its evidence, and nothing else moves.
  {
    const x = await landingSetup(t);
    await refusal(() => teamLandApprove(x.s.home, x.member, { T: x.c.T, C: x.c.C, homedir: x.s.homedir }, { beforeMove: () => git(x.s.repo, "checkout", "-q", "main") }), "land_unknown", /^git update-ref moved main to \w+, but a checkout of it appeared meanwhile, and in .*repo, it has 1 uncommitted change: lib\/x\.js\. main is at \w+, but the landing L1 is blocked: hoptell moves nothing more and resets nothing\. Bring the checkout in .*repo to \w+ \(git read-tree -m -u \w+ \w+ there keeps your own changes\), then record it with hoptell team land dana-n4-impl-1 --confirm/);
    assert.equal(refOf(x.s.repo, "main"), x.c.C);
    assert.equal(refOf(x.s.repo, x.landRef), x.c.C, "the candidate stays");
    assert.ok(fs.existsSync(x.rec.path), "the worktree stays");
    assert.equal(readState(x.s.home, "n4").actions[0].state, "blocked");
    await refusal(() => teamLandApprove(x.s.home, x.member, { T: x.c.T, C: x.c.C, homedir: x.s.homedir, confirm: true }), "not_landed");
    git(x.s.repo, "read-tree", "-m", "-u", x.c.T, x.c.C);
    const r = await teamLandApprove(x.s.home, x.member, { T: x.c.T, C: x.c.C, homedir: x.s.homedir, confirm: true });
    assert.equal(r.id, "L1");
    assert.equal(readState(x.s.home, "n4").landed.length, 1);
  }
  // The same appearance, then a crash before the record: the rerun moves nothing and does not finish.
  {
    const x = await landingSetup(t);
    const crash = () => {
      throw new Error("crash");
    };
    await assert.rejects(teamLandApprove(x.s.home, x.member, { T: x.c.T, C: x.c.C, homedir: x.s.homedir }, { beforeMove: () => git(x.s.repo, "checkout", "-q", "main"), afterMove: crash }), /crash/);
    await refusal(() => teamLandApprove(x.s.home, x.member, { T: x.c.T, C: x.c.C, homedir: x.s.homedir }), "land_unknown", /^an earlier run stopped while it moved the target, and in .*repo, .*\. main is at \w+, but the landing L1 is blocked/);
    assert.equal(readState(x.s.home, "n4").landed.length, 0);
    assert.ok(fs.existsSync(x.rec.path));
    // Two checkouts: still blocked, and --confirm refuses too.
    git(x.s.repo, "read-tree", "-m", "-u", x.c.T, x.c.C);
    const second = path.join(x.s.root, "second");
    git(x.s.repo, "worktree", "add", "-q", "--force", second, "main");
    await refusal(() => teamLandApprove(x.s.home, x.member, { T: x.c.T, C: x.c.C, homedir: x.s.homedir, confirm: true }), "not_landed", /main is checked out in 2 worktrees/);
    git(x.s.repo, "worktree", "remove", second);
    await teamLandApprove(x.s.home, x.member, { T: x.c.T, C: x.c.C, homedir: x.s.homedir, confirm: true });
  }
  // A checkout that appears already at C and clean: the landing finishes and says so.
  {
    const x = await landingSetup(t);
    const r = await teamLandApprove(x.s.home, x.member, { T: x.c.T, C: x.c.C, homedir: x.s.homedir }, { afterMove: () => git(x.s.repo, "checkout", "-q", "main") });
    assert.equal(r.observed, fs.realpathSync(x.s.repo));
    assert.equal(readState(x.s.home, "n4").landed.length, 1);
  }
});

test("untracked files in the checkout: one the landing does not add is kept; one where it adds a file, untracked or ignored, blocks before the move", async (t) => {
  for (const kind of ["kept", "untracked", "ignored"]) {
    const x = await landingSetup(t, "n4", { candidate: false });
    fs.writeFileSync(path.join(x.rec.path, "lib", "new.js"), "new\n");
    await commitWorktree(x.s.home, x.member, { message: "adds lib/new.js" });
    const c = await teamLandCandidate(x.s.home, x.member, { target: "main", message: "Land", homedir: x.s.homedir });
    git(x.s.repo, "checkout", "-q", "main");
    const mine = path.join(x.s.repo, kind === "kept" ? "notes.txt" : path.join("lib", "new.js"));
    fs.writeFileSync(mine, "mine\n");
    if (kind === "ignored") fs.appendFileSync(path.join(x.s.repo, ".git", "info", "exclude"), "lib/new.js\n");
    const approve = () => teamLandApprove(x.s.home, x.member, { T: c.T, C: c.C, homedir: x.s.homedir });
    if (kind === "kept") {
      await approve();
      assert.equal(refOf(x.s.repo, "main"), c.C);
    } else {
      await refusal(approve, "land_blocked", /main is checked out in .*repo, and lib\/new\.js exists there untracked or ignored, where the landing adds lib\/new\.js\. Nothing was moved/);
      assert.equal(refOf(x.s.repo, "main"), c.T);
    }
    assert.equal(fs.readFileSync(mine, "utf8"), "mine\n", `${kind}: never deleted or stashed`);
  }
});

test("final records are checked strictly: a malformed one, or one of another action, changes nothing", async (t) => {
  for (const bad of ["{}", "other"]) {
    const x = await landingSetup(t);
    const crash = () => {
      throw new Error("crash");
    };
    await assert.rejects(teamLandApprove(x.s.home, x.member, { T: x.c.T, C: x.c.C, homedir: x.s.homedir }, { afterMoving: crash }), /crash/);
    const final = path.join(x.s.home, "teams", "n4", "landings", "L1", "final.json");
    const before = readState(x.s.home, "n4");
    const a = before.actions[0];
    const rec = { version: 1, id: "L1", digest: "e".repeat(64), member: a.member, state: "finished", route: "terminal", decision: null, reason: null, observed: null, intent: { target: "main", T: x.c.T, H: x.c.H, C: x.c.C, mode: { kind: "ref" } }, result: null, at: new Date().toISOString() };
    fs.writeFileSync(final, bad === "{}" ? "{}" : JSON.stringify(rec), { mode: 0o600 });
    await refusal(() => teamLandApprove(x.s.home, x.member, { T: x.c.T, C: x.c.C, homedir: x.s.homedir }), "action_changed", bad === "{}" ? /is not a valid final record of a landing \(not the fields/ : /the final record of the landing L1 does not match that action/);
    assert.deepEqual(readState(x.s.home, "n4"), before, "nothing changed");
  }
});

test("--abandon ends a landing with an unknown outcome for good: an abandoned record first, nothing moved or removed, and a replay of the old action never runs", async (t) => {
  const x = await checkoutSetup(t);
  await assert.rejects(x.approve({ afterMoving: () => { throw new Error("crash"); } }), /crash/);
  // Only an action whose outcome is unknown; never one that has not started or has landed.
  await refusal(() => teamLandAbandon(x.s.home, x.member, "L9"), "no_action");
  const stale = readState(x.s.home, "n4");
  const asked = [];
  const lines = [];
  const cli = (answer) =>
    teamCommand({ args: ["land", x.member, "--abandon", "L1"], home: x.s.home, homedir: x.s.homedir, env: {}, isTTY: true, out: (l) => lines.push(l), warn: () => {}, fail: (m) => { throw Object.assign(new Error(m), { code: "cli" }); }, deps: { ask: async (q) => (asked.push(q), answer) } });
  await assert.rejects(teamCommand({ args: ["land", x.member, "--abandon", "L1"], home: x.s.home, homedir: x.s.homedir, env: {}, isTTY: false, out: () => {}, warn: () => {}, fail: (m) => { throw new Error(m); } }), /abandoning a landing is the owner's step/);
  await assert.rejects(cli("no"), /not confirmed; nothing was changed/);
  assert.equal(readState(x.s.home, "n4").actions[0].state, "moving");
  await cli("abandon");
  assert.match(lines[0], new RegExp(`^The landing L1 \\(${x.c.C} on main at ${x.c.T}\\) has an unknown outcome\\. What hoptell sees now: main is at ${x.c.T} \\(T, where it was\\); checked out in .*repo, on it and clean\\.$`));
  assert.match(lines[1], /does not infer from this whether or how far the earlier move happened.*hoptell team land --discard then drops the candidate and keeps the worktree/);
  assert.deepEqual(asked, ["Abandon L1? Type abandon to confirm: ", "Abandon L1? Type abandon to confirm: "]);
  const tomb = readTombstone(x.s.home, "n4", "L1");
  assert.equal(tomb.state, "abandoned");
  assert.match(tomb.reason, /abandoned by the owner while moving; the outcome of the earlier move was not inferred/);
  assert.match(tomb.observed, /main is at \w+ \(T, where it was\)/);
  assert.deepEqual(tomb.intent, { target: "main", T: x.c.T, H: x.c.H, C: x.c.C, mode: stale.actions[0] && JSON.parse(fs.readFileSync(path.join(x.s.home, "teams", "n4", "landings", "L1", "manifest.json"), "utf8")).mode });
  const st = readState(x.s.home, "n4");
  assert.deepEqual([st.actions, st.landing, st.landed.length, st.candidate.C], [[], null, 0, x.c.C], "no landing recorded; the candidate stays");
  assert.equal(refOf(x.s.repo, "main"), x.c.T, "nothing moved");
  assert.equal(refOf(x.s.repo, x.landRef), x.c.C);
  assert.ok(fs.existsSync(x.rec.path), "the worktree stays");
  // A replay of the old action (the state from before, written back): its final record ends it
  // again, and the next decision is a new action.
  writeTeam(x.s.home, stale);
  const r = await x.approve();
  assert.equal(r.id, "L2");
  assert.equal(readTombstone(x.s.home, "n4", "L1").state, "abandoned");
  assert.equal(readState(x.s.home, "n4").landed.length, 1);
});

test("an orphaned manifest (a run stopped right after making it) is reported and never acted on; its id is not reused", async (t) => {
  const x = await checkoutSetup(t);
  let calls = 0;
  const save = (home, st) => {
    if (++calls === 1) throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
    fs.writeFileSync(teamPaths(home, st.team).state, JSON.stringify(st), { mode: 0o600 });
  };
  await assert.rejects(x.approve({ save }), /ENOSPC/);
  assert.ok(fs.existsSync(path.join(x.s.home, "teams", "n4", "landings", "L1", "manifest.json")));
  assert.deepEqual(readState(x.s.home, "n4").actions, []);
  assert.deepEqual((await teamStatus(x.s.home, "n4")).orphans, ["L1"]);
  const lines = [];
  await teamCommand({ args: ["status", "n4"], home: x.s.home, homedir: x.s.homedir, env: {}, out: (l) => lines.push(l), warn: () => {}, fail: (m) => { throw new Error(m); } });
  assert.ok(lines.some((l) => /orphaned landing L1: a manifest was made but no decision was recorded \(a run stopped\); nothing acts on it, and the id is not used again/.test(l)), lines.join("\n"));
  const r = await x.approve();
  assert.equal(r.id, "L2");
  assert.equal(fs.existsSync(path.join(x.s.home, "teams", "n4", "landings", "L1", "final.json")), false, "the orphan stays as it was");
});

test("--abandon is reached through the CLI entry point: the flag and its value pass the option check, and the owner's terminal check answers", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "hoptell-abandon-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.writeFileSync(path.join(home, "empty.env"), "");
  const env = { ...process.env, HOPTELL_HOME: home, HOPTELL_ENV: path.join(home, "empty.env"), XDG_CONFIG_HOME: path.join(home, "config"), HOPTELL_CREDENTIAL_STORE: "file", HOPTELL_CREDENTIAL_PASSPHRASE: "test-pass-040" };
  delete env.HOPTELL_NAME;
  const r = spawnSync(process.execPath, [BIN, "team", "land", "dana-n4-impl-1", "--abandon", "L1"], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /abandoning a landing is the owner's step: run hoptell team land --abandon in a terminal/);
  assert.doesNotMatch(r.stderr, /unknown option/);
  const help = spawnSync(process.execPath, [BIN, "help", "team"], { env, encoding: "utf8" });
  assert.match(help.stdout, /--abandon <id>/);
  assert.match(help.stdout, /hoptell team approve <id> \[--show-diff\]/);
  // The lead's new flags pass the option check too and reach the command.
  const run = (...a) => spawnSync(process.execPath, [BIN, "team", ...a], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  for (const a of [["evidence", "dana-n4-impl-1", "--candidate", "a".repeat(40), "--tests", "pass", "--command", "npm test", "--command", "npm run lint", "--report", "r.txt"], ["land", "dana-n4-impl-1", "--request-approval"], ["land", "dana-n4-impl-1", "--target", "main", "-m", "x", "--prepare"]]) {
    const r2 = run(...a);
    assert.equal(r2.status, 1, r2.stderr);
    assert.match(r2.stderr, /dana-n4-impl-1 is in no active team/);
  }
  const r3 = run("approve", "L1", "--show-diff");
  assert.match(r3.stderr, /no landing L1 in this hoptell home/);
});

test("tracked paths that the candidate replaces are not obstructions: a file that becomes a folder, a folder that becomes a file; a folder holding untracked files still blocks", async (t) => {
  for (const kind of ["file-to-folder", "folder-to-file", "folder-with-junk"]) {
    const x = await landingSetup(t, "n4", { candidate: false });
    fs.rmSync(path.join(x.rec.path, kind === "file-to-folder" ? "README.md" : "lib"), { recursive: true });
    if (kind === "file-to-folder") {
      fs.mkdirSync(path.join(x.rec.path, "README.md"));
      fs.writeFileSync(path.join(x.rec.path, "README.md", "a.txt"), "a\n");
    } else {
      fs.writeFileSync(path.join(x.rec.path, "lib"), "now a file\n");
    }
    await commitWorktree(x.s.home, x.member, { message: kind });
    const c = await teamLandCandidate(x.s.home, x.member, { target: "main", message: "Land", homedir: x.s.homedir });
    git(x.s.repo, "checkout", "-q", "main");
    if (kind === "folder-with-junk") fs.writeFileSync(path.join(x.s.repo, "lib", "junk.txt"), "mine\n");
    const approve = () => teamLandApprove(x.s.home, x.member, { T: c.T, C: c.C, homedir: x.s.homedir });
    if (kind === "folder-with-junk") {
      await refusal(approve, "land_blocked", /lib\/junk\.txt exists there untracked or ignored, in lib, which the landing replaces by a file\. Nothing was moved/);
      assert.equal(refOf(x.s.repo, "main"), c.T);
      assert.equal(fs.readFileSync(path.join(x.s.repo, "lib", "junk.txt"), "utf8"), "mine\n");
    } else {
      await approve();
      assert.equal(refOf(x.s.repo, "main"), c.C, kind);
      assert.equal(git(x.s.repo, "status", "--porcelain"), "", kind);
    }
  }
});

test("a final record must carry the action's complete intent from its manifest: a changed H or mode changes nothing", async (t) => {
  for (const change of ["H", "mode"]) {
    const x = await landingSetup(t);
    await assert.rejects(teamLandApprove(x.s.home, x.member, { T: x.c.T, C: x.c.C, homedir: x.s.homedir }, { afterMoving: () => { throw new Error("crash"); } }), /crash/);
    const st = readState(x.s.home, "n4");
    const a = st.actions[0];
    const m = JSON.parse(fs.readFileSync(path.join(x.s.home, "teams", "n4", "landings", "L1", "manifest.json"), "utf8"));
    const intent = { target: m.target, T: m.T, H: change === "H" ? x.c.T : m.H, C: m.C, mode: change === "mode" ? { kind: "checkout", worktree: x.s.repo, gitDir: path.join(x.s.repo, ".git") } : m.mode };
    const rec = { version: 1, id: "L1", digest: a.digest, member: a.member, state: "finished", route: a.route, decision: a.decision, reason: null, observed: null, intent, result: null, at: new Date().toISOString() };
    const final = path.join(x.s.home, "teams", "n4", "landings", "L1", "final.json");
    fs.writeFileSync(final, JSON.stringify(rec), { mode: 0o600 });
    const before = fs.readFileSync(teamPaths(x.s.home, "n4").state);
    await refusal(() => teamLandApprove(x.s.home, x.member, { T: x.c.T, C: x.c.C, homedir: x.s.homedir }), "action_changed", /the final record of the landing L1 does not match that action/);
    assert.deepEqual(fs.readFileSync(teamPaths(x.s.home, "n4").state), before, `${change}: the state and its journal are byte-identical`);
    // A second write of a final record with another intent is refused too.
    await refusal(() => teamLandAbandon(x.s.home, x.member, "L1"), "action_changed");
    assert.deepEqual(fs.readFileSync(teamPaths(x.s.home, "n4").state), before);
  }
});

test("a member belongs to its one active team: a team that is down keeps only its history; two active teams are refused", async (t) => {
  const { s, member } = await landingSetup(t, "n6");
  // An older team n5 with the same member name, down; its state stays for its history.
  writeTeam(s.home, stateOf("n5", [memberRow(member, "implementer", null, { cli: "codex", template: "implementer" })], { repo: s.repo, status: "down" }));
  const session = sleepers(t);
  const f = fakeClis(s.root);
  const launched = [];
  const deps = {
    launch: async (name, argv, roles) => {
      launched.push([name, roles]);
      const x = session(Date.now());
      return { session: `hoptell-${name}`, sessionId: x.id, pane: x.pane, pid: x.pid };
    },
    endSession: () => false,
    warn: () => {},
    sleep: async () => {},
    wait: 0,
  };
  // stop, restart and land act on n6, the active one.
  assert.equal((await teamStop(s.home, member, deps)).state, "not started");
  assert.match(readState(s.home, "n6").events.at(-1).what, new RegExp(`stop ${member}: not started`));
  assert.deepEqual(readState(s.home, "n5").events, []);
  await teamRestart(s.home, member, { homedir: s.homedir, env: { PATH: f.PATH } }, deps);
  assert.deepEqual(launched, [[member, "implementer,n6"]]);
  assert.ok(readState(s.home, "n6").members[0].session);
  assert.equal(readState(s.home, "n5").members[0].session, null);
  assert.equal(readState(s.home, "n6").candidate.member, member, "n6 holds the candidate");
  // Landing commands act on n6 too: the candidate is discarded and built again there.
  const n5before = JSON.stringify(readState(s.home, "n5"));
  await teamLandDiscard(s.home, member);
  assert.equal(readState(s.home, "n6").candidate, null);
  const again = await teamLandCandidate(s.home, member, { target: "main", message: "Land again", homedir: s.homedir });
  assert.equal(readState(s.home, "n6").candidate.C, again.C);
  assert.equal(JSON.stringify(readState(s.home, "n5")), n5before, "the team that is down is untouched");
  // The landing record of n6 is the one hoptell worktree remove reads, whichever team is newer.
  const n5 = readState(s.home, "n5");
  n5.landed.push({ member, H: "1".repeat(40), C: "2".repeat(40), T: "3".repeat(40), target: "main", at: "2020-01-01T00:00:00.000Z" });
  writeTeam(s.home, n5);
  const n6 = readState(s.home, "n6");
  n6.landed.push({ member, H: "4".repeat(40), C: "5".repeat(40), T: "6".repeat(40), target: "main", at: new Date().toISOString() });
  writeTeam(s.home, n6);
  assert.equal(landedFor(s.home, member).candidate, "5".repeat(40));
  // Two active teams with the same member: refused, never guessed.
  n5.status = "up";
  writeTeam(s.home, n5);
  await refusal(() => teamStop(s.home, member, deps), "ambiguous_member", /several active teams \(n5, n6\)/);
  // team up refuses a name that an active team has.
  fs.mkdirSync(path.join(s.root, "tasks"), { recursive: true });
  fs.writeFileSync(path.join(s.root, "tasks", "impl.md"), "x\n");
  const file = path.join(s.root, "team7.json");
  fs.writeFileSync(file, JSON.stringify(teamDoc({ team: "n7", members: [memberOf({ name: member })] })));
  await refusal(() => teamUp(file, { home: s.home, homedir: s.homedir, env: { PATH: f.PATH }, dryRun: true }, { out: () => {}, warn: () => {} }), "member_in_team", new RegExp(`${member} is a member of the active team n5`));
});

test("restart runs the same launch checks as up: an agy member is not restarted next to a project MCP file", async (t) => {
  const s = repoSetup(t);
  writeTeam(s.home, stateOf("n8", [memberRow("dana-n8-rev-1", "reviewer", null, { cli: "agy" })], { repo: s.repo }));
  fs.mkdirSync(path.join(s.repo, ".agents"));
  fs.writeFileSync(path.join(s.repo, ".agents", "mcp_config.json"), "{}");
  const launched = [];
  await refusal(() => teamRestart(s.home, "dana-n8-rev-1", { homedir: s.homedir, env: {} }, { launch: async () => launched.push(1), warn: () => {} }), "agy_project_mcp", /mcp_config\.json exists/);
  assert.deepEqual(launched, []);
  assert.throws(() => launchPreflight(s.repo, [{ name: "x", cli: "claude" }, { name: "dana-a", cli: "agy" }]), /does not start agy members \(dana-a\)/);
  assert.equal(launchPreflight(s.repo, [{ name: "x", cli: "codex" }]), undefined);
});

test("landing recovery: the journal stays after a move that happened, a recorded landing is finished once, a failed ref deletion stops before cleanup", async (t) => {
  const finish = (x, deps) => teamLandApprove(x.s.home, x.member, { T: x.c.T, C: x.c.C, homedir: x.s.homedir }, deps);
  const crash = () => {
    throw new Error("crash");
  };
  // A failure after the compare-and-swap, before the record: the journal (intent) stays and the
  // same command finishes with exactly one landed row.
  {
    const x = await landingSetup(t);
    await assert.rejects(finish(x, { afterMove: crash }), /crash/);
    assert.equal(refOf(x.s.repo, "main"), x.c.C);
    assert.equal(readState(x.s.home, "n4").landing.phase, "intent");
    assert.equal(readState(x.s.home, "n4").actions[0].state, "moving");
    await finish(x);
    const st = readState(x.s.home, "n4");
    assert.equal(st.landed.length, 1);
    assert.equal(st.landing, null);
    assert.ok(!fs.existsSync(x.rec.path));
  }
  // A failure after the record, before cleanup: finished, no second row.
  {
    const x = await landingSetup(t);
    await assert.rejects(finish(x, { afterRecord: crash }), /crash/);
    assert.equal(readState(x.s.home, "n4").landing.phase, "landed");
    assert.equal(refOf(x.s.repo, x.landRef), x.c.C, "the candidate branch stays");
    assert.ok(fs.existsSync(x.rec.path));
    await finish(x);
    assert.equal(readState(x.s.home, "n4").landed.length, 1);
    assert.equal(readState(x.s.home, "n4").landing, null);
  }
  // The deletion of the candidate branch exits nonzero (a git lock): nothing else goes.
  {
    const x = await landingSetup(t);
    const lock = path.join(x.s.repo, ".git", "refs", "heads", "team", "n4", "land.lock");
    fs.writeFileSync(lock, "");
    await refusal(() => finish(x), "ref_delete_failed", /the landing is recorded, but git could not delete team\/n4\/land .*; nothing else was removed/);
    assert.equal(refOf(x.s.repo, x.landRef), x.c.C);
    assert.ok(fs.existsSync(x.rec.path));
    assert.ok(readWorktreeRecord(x.s.home, x.member).rec, "the registration stays");
    assert.equal(readState(x.s.home, "n4").landing.phase, "landed");
    fs.rmSync(lock);
    await finish(x);
    assert.equal(refOf(x.s.repo, x.landRef), null);
    assert.equal(readState(x.s.home, "n4").landed.length, 1);
    assert.equal(readState(x.s.home, "n4").landing, null);
  }
  // The candidate branch was moved to another commit meanwhile: refused, with what to do.
  {
    const x = await landingSetup(t);
    await refusal(() => finish(x, { afterRecord: () => git(x.s.repo, "update-ref", x.landRef, x.c.T) }), "candidate_changed", /now points at \w+, not at the candidate \w+; .*git branch -D team\/n4\/land/);
    assert.ok(fs.existsSync(x.rec.path));
    await refusal(() => finish(x), "candidate_changed");
    git(x.s.repo, "update-ref", "-d", x.landRef);
    await finish(x);
    assert.ok(!fs.existsSync(x.rec.path));
    assert.equal(readState(x.s.home, "n4").landing, null);
  }
  // A record that cannot be read is not taken for "cleanup finished": refused, journal kept.
  {
    const x = await landingSetup(t);
    await assert.rejects(finish(x, { afterRecord: crash }), /crash/);
    const file = worktreePaths(x.s.home).record(x.member);
    const good = fs.readFileSync(file);
    fs.writeFileSync(file, "{");
    await assert.rejects(finish(x), /the worktree record of dana-n4-impl-1 is not valid JSON/);
    assert.equal(readState(x.s.home, "n4").landing.phase, "landed");
    fs.writeFileSync(file, good);
    await finish(x);
    assert.equal(readState(x.s.home, "n4").landing, null);
  }
});

test("a pending landing survives team down and blocks team up until it is finished", async (t) => {
  const crash = () => {
    throw new Error("crash");
  };
  for (const [phase, failAt] of [["intent", { afterMove: crash }], ["landed", { afterRecord: crash }]]) {
    for (const keepWorktrees of [false, true]) {
      const x = await landingSetup(t);
      await assert.rejects(teamLandApprove(x.s.home, x.member, { T: x.c.T, C: x.c.C, homedir: x.s.homedir }, failAt));
      const r = await teamDown(x.s.home, "n4", { keepWorktrees }, { endSession: () => false, sleep: async () => {}, wait: 0 });
      const label = `${phase}, keepWorktrees ${keepWorktrees}`;
      assert.equal(r.down, true, label);
      const pending = `the landing L1 is ${phase === "intent" ? "moving" : "landed, its cleanup unfinished"}: hoptell team land ${x.member} --approve ${x.c.T} ${x.c.C} finishes it`;
      assert.equal(r.pending, pending, label);
      assert.ok(r.report.find((y) => y.name === x.member).worktree.includes(`kept (${pending})`), label);
      assert.ok(fs.existsSync(x.rec.path), label);
      assert.ok(readWorktreeRecord(x.s.home, x.member).rec, label);
      const st = readState(x.s.home, "n4");
      assert.equal(st.status, "down");
      assert.equal(st.landing.phase, phase, label);
      assert.equal(st.candidate.C, x.c.C, label);
      // team up of that team, or of a team with that member, waits for the landing.
      const f = fakeClis(x.s.root);
      fs.mkdirSync(path.join(x.s.root, "tasks"), { recursive: true });
      fs.writeFileSync(path.join(x.s.root, "tasks", "impl.md"), "x\n");
      const up = (team) => {
        const file = path.join(x.s.root, `${team}.json`);
        fs.writeFileSync(file, JSON.stringify(teamDoc({ team, members: [memberOf({ name: x.member })] })));
        return teamUp(file, { home: x.s.home, homedir: x.s.homedir, env: { PATH: f.PATH }, dryRun: true }, { out: () => {}, warn: () => {} });
      };
      await refusal(() => up("n4"), "landing_pending", /team n4 still has dana-n4-impl-1's landing: the landing L1 is .*: hoptell team land .* --approve/);
      await refusal(() => up("n9"), "landing_pending", /dana-n4-impl-1 has a landing in team n4 that is not resolved \(the landing L1 is/);
      // team land finds the member in the team that is down, and finishes.
      await teamLandApprove(x.s.home, x.member, { T: x.c.T, C: x.c.C, homedir: x.s.homedir });
      const after = readState(x.s.home, "n4");
      assert.equal(after.landing, null, label);
      assert.equal(after.landed.length, 1, label);
      assert.ok(!fs.existsSync(x.rec.path), label);
      await up("n4"); // a dry run goes ahead now
    }
  }
});

test("a plain candidate survives team down: down keeps the worktree, up waits, and --discard or --approve reaches it", async (t) => {
  for (const resolve of ["discard", "approve"]) {
    const x = await landingSetup(t);
    const r = await teamDown(x.s.home, "n4", {}, { endSession: () => false, sleep: async () => {}, wait: 0 });
    assert.equal(r.down, true);
    assert.equal(r.pending, `candidate pending: approve or discard it with hoptell team land ${x.member} --approve ${x.c.T} ${x.c.C} or hoptell team land ${x.member} --discard`);
    assert.match(r.report.find((y) => y.name === x.member).worktree, /^kept \(candidate pending: approve or discard it with/);
    assert.ok(fs.existsSync(x.rec.path));
    assert.ok(readWorktreeRecord(x.s.home, x.member).rec);
    assert.equal(readState(x.s.home, "n4").candidate.C, x.c.C);
    const f = fakeClis(x.s.root);
    fs.mkdirSync(path.join(x.s.root, "tasks"), { recursive: true });
    fs.writeFileSync(path.join(x.s.root, "tasks", "impl.md"), "x\n");
    const up = (team) => {
      const file = path.join(x.s.root, `${team}.json`);
      fs.writeFileSync(file, JSON.stringify(teamDoc({ team, members: [memberOf({ name: x.member })] })));
      return teamUp(file, { home: x.s.home, homedir: x.s.homedir, env: { PATH: f.PATH }, dryRun: true }, { out: () => {}, warn: () => {} });
    };
    await refusal(() => up("n4"), "landing_pending", /team n4 still has dana-n4-impl-1's landing: candidate pending/);
    await refusal(() => up("n9"), "landing_pending", /dana-n4-impl-1 has a landing in team n4 that is not resolved/);
    if (resolve === "discard") {
      const out = [];
      await teamCommand({ args: ["land", x.member, "--discard"], home: x.s.home, homedir: x.s.homedir, env: {}, out: (l) => out.push(l), warn: () => {}, fail: (m) => assert.fail(m) });
      assert.match(out.join("\n"), /The candidate was discarded\.\nThe team is down, so dana-n4-impl-1's worktree stays for you: hoptell worktree remove dana-n4-impl-1 removes it/);
      assert.equal(refOf(x.s.repo, x.landRef), null);
      assert.equal(refOf(x.s.repo, "main"), x.c.T);
      assert.ok(fs.existsSync(x.rec.path));
    } else {
      await teamLandApprove(x.s.home, x.member, { T: x.c.T, C: x.c.C, homedir: x.s.homedir });
      assert.equal(refOf(x.s.repo, "main"), x.c.C);
      assert.equal(readState(x.s.home, "n4").landed.length, 1);
      assert.ok(!fs.existsSync(x.rec.path));
    }
    assert.equal(readState(x.s.home, "n4").candidate, null);
    await up("n4"); // resolved: team up goes ahead
  }
});

/**
 * Git that is the real one except for the calls a test scripts: rules [{match, nth, action}]; the
 * nth call whose arguments contain `match` exits 128 before running ("exit128"), is killed before
 * ("kill") or after it ran ("killAfter").
 */
function faultyGit(root) {
  const rules = path.join(root, "git-rules.json");
  const counts = path.join(root, "git-counts.json");
  fs.writeFileSync(rules, "[]");
  const f = path.join(root, "faulty-git");
  fs.writeFileSync(
    f,
    `#!${process.execPath}
const fs = require("fs");
const { spawnSync } = require("child_process");
const args = process.argv.slice(2).join(" ");
const rules = JSON.parse(fs.readFileSync(${JSON.stringify(rules)}, "utf8"));
let counts = {};
try { counts = JSON.parse(fs.readFileSync(${JSON.stringify(counts)}, "utf8")); } catch {}
let action = null;
for (const [i, r] of rules.entries()) if (args.includes(r.match)) { counts[i] = (counts[i] ?? 0) + 1; if (counts[i] === r.nth) action = r.action; }
fs.writeFileSync(${JSON.stringify(counts)}, JSON.stringify(counts));
if (action === "exit128") { process.stderr.write("fatal: injected failure\\n"); process.exit(128); }
if (action === "kill") process.kill(process.pid, "SIGKILL");
// Exit-0 answers that are not clean: a warning only, garbage, a line for another ref, no output.
if (action === "warn0") { fs.writeSync(2, "warning: ignoring broken ref injected\\n"); process.exit(0); }
if (action === "garbage0") { fs.writeSync(1, "not an answer\\n"); process.exit(0); }
if (action === "other0") { fs.writeSync(1, "${"1".repeat(40)} refs/heads/other \\n"); process.exit(0); }
if (action === "quiet0") process.exit(0);
// A merge that changed the checkout and was stopped before its ref update; one that answers
// "Already up to date" without doing anything.
if (action === "dirtyKill") { fs.writeFileSync(require("path").join(process.cwd(), "lib", "x.js"), "half\\n"); process.kill(process.pid, "SIGKILL"); }
if (action === "uptodate0") { fs.writeSync(1, "Already up to date.\\n"); process.exit(0); }
const r = spawnSync(${JSON.stringify(findGit())}, process.argv.slice(2), { stdio: "inherit" });
if (action === "killAfter") process.kill(process.pid, "SIGKILL");
process.exit(r.status ?? 1);
`,
    { mode: 0o755 },
  );
  return {
    git: f,
    set: (r) => {
      fs.writeFileSync(rules, JSON.stringify(r));
      fs.rmSync(counts, { force: true });
    },
  };
}
const failingSave = (n) => {
  let calls = 0;
  return (home, st) => {
    calls += 1;
    if (calls === n) throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
    fs.writeFileSync(teamPaths(home, st.team).state, JSON.stringify(st), { mode: 0o600 });
  };
};
const FOR_EACH = "for-each-ref --format=%(objectname) %(refname) %(symref) ";

test("an update or readback that does not answer cleanly is never taken for \"not moved\": the action is blocked with its journal, and --confirm reconciles it", async (t) => {
  for (const readback of ["exit128", "kill"]) {
    const x = await landingSetup(t);
    const g = faultyGit(x.s.root);
    // The update is killed after it wrote the ref (status null); the readback fails.
    g.set([{ match: "update-ref --no-deref -m hoptell team land refs/heads/main", nth: 1, action: "killAfter" }, { match: `${FOR_EACH}refs/heads/main`, nth: 2, action: readback }]);
    await assert.rejects(teamLandApprove(x.s.home, x.member, { T: x.c.T, C: x.c.C, homedir: x.s.homedir }, { git: g.git }), (e) => {
      assert.equal(e.code, "land_unknown", e.message);
      assert.match(e.message, /^git update-ref ended with stopped by a signal, and main could not be read \(git for-each-ref ended with .*\)\. Whether main moved is unknown, so the landing L1 is blocked: hoptell does not move it again and resets nothing\. Check main; once main is at \w+, record it with hoptell team land dana-n4-impl-1 --confirm /);
      return true;
    });
    assert.equal(refOf(x.s.repo, "main"), x.c.C, "the ref was written");
    assert.equal(readState(x.s.home, "n4").landing.phase, "intent", readback);
    assert.equal(readState(x.s.home, "n4").actions[0].state, "blocked");
    g.set([]);
    // --approve does not touch a blocked action; the owner's --confirm reconciles it.
    await refusal(() => teamLandApprove(x.s.home, x.member, { T: x.c.T, C: x.c.C, homedir: x.s.homedir }, { git: g.git }), "land_blocked", /the landing L1 is blocked \(git update-ref ended with stopped by a signal; .*\); hoptell does not move main again under it/);
    await teamLandApprove(x.s.home, x.member, { T: x.c.T, C: x.c.C, homedir: x.s.homedir, confirm: true }, { git: g.git });
    const st = readState(x.s.home, "n4");
    assert.equal(st.landed.length, 1);
    assert.equal(st.landing, null);
    assert.ok(!fs.existsSync(x.rec.path));
  }
});

test("a candidate branch that cannot be read is not absence: a landed journal, a failed deletion's readback", async (t) => {
  const crash = () => {
    throw new Error("crash");
  };
  for (const action of ["exit128", "kill"]) {
    const x = await landingSetup(t);
    const g = faultyGit(x.s.root);
    await assert.rejects(teamLandApprove(x.s.home, x.member, { T: x.c.T, C: x.c.C, homedir: x.s.homedir }, { afterRecord: crash }), /crash/);
    // The first read of the candidate branch fails: refused, everything kept.
    g.set([{ match: `${FOR_EACH}${x.landRef}`, nth: 1, action }]);
    await refusal(() => teamLandApprove(x.s.home, x.member, { T: x.c.T, C: x.c.C, homedir: x.s.homedir }, { git: g.git }), "ref_unreadable", /team\/n4\/land could not be read \(git for-each-ref ended with /);
    assert.equal(readState(x.s.home, "n4").landing.phase, "landed");
    assert.ok(readWorktreeRecord(x.s.home, x.member).rec);
    // The deletion fails and its readback (the second read: a landed action reads the branch only
    // before the deletion and back after it) fails too: refused before the registration goes.
    g.set([{ match: `update-ref --no-deref -d ${x.landRef}`, nth: 1, action: "exit128" }, { match: `${FOR_EACH}${x.landRef}`, nth: 2, action }]);
    await refusal(() => teamLandApprove(x.s.home, x.member, { T: x.c.T, C: x.c.C, homedir: x.s.homedir }, { git: g.git }), "ref_unreadable", /git could not delete team\/n4\/land \(status 128: fatal: injected failure\) and it could not be read back/);
    assert.equal(refOf(x.s.repo, x.landRef), x.c.C);
    assert.ok(readWorktreeRecord(x.s.home, x.member).rec, "the registration stays");
    assert.equal(readState(x.s.home, "n4").landing.phase, "landed");
    g.set([]);
    await teamLandApprove(x.s.home, x.member, { T: x.c.T, C: x.c.C, homedir: x.s.homedir }, { git: g.git });
    assert.equal(readState(x.s.home, "n4").landing, null);
    assert.equal(readState(x.s.home, "n4").landed.length, 1);
  }
});

test("--discard checks its deletion: a locked branch keeps the candidate until a rerun, on a team that is up or down", async (t) => {
  for (const down of [false, true]) {
    const x = await landingSetup(t);
    if (down) assert.equal((await teamDown(x.s.home, "n4", {}, { endSession: () => false, sleep: async () => {}, wait: 0 })).down, true);
    const lock = path.join(x.s.repo, ".git", "refs", "heads", "team", "n4", "land.lock");
    fs.writeFileSync(lock, "");
    await refusal(() => teamLandDiscard(x.s.home, x.member), "ref_delete_failed", /the candidate is kept: git could not delete team\/n4\/land \(status \d+: .*\); nothing else was removed\. Run the same hoptell team land dana-n4-impl-1 --discard again/);
    assert.equal(readState(x.s.home, "n4").candidate.C, x.c.C);
    assert.equal(refOf(x.s.repo, x.landRef), x.c.C);
    fs.rmSync(lock);
    await teamLandDiscard(x.s.home, x.member);
    assert.equal(readState(x.s.home, "n4").candidate, null);
    assert.equal(refOf(x.s.repo, x.landRef), null);
    // A branch moved to another commit: refused with what to do.
    if (!down) {
      const y = await landingSetup(t, "n5");
      git(y.s.repo, "update-ref", y.landRef, y.c.T);
      await refusal(() => teamLandDiscard(y.s.home, y.member), "candidate_changed", /now points at \w+, not at the candidate \w+; .*git branch -D team\/n5\/land/);
      assert.ok(readState(y.s.home, "n5").candidate);
    }
  }
});

test("candidate publication is journaled: a failure after the branch exists is adopted by a rerun or dropped by --discard; an unknown create keeps the journal", async (t) => {
  const build = (x, deps) => teamLandCandidate(x.s.home, x.member, { target: "main", message: "Land", homedir: x.s.homedir }, deps);
  // The branch was created, the record could not be written: the rerun adopts it.
  {
    const x = await landingSetup(t, "n4", { candidate: false });
    await assert.rejects(build(x, { save: failingSave(2) }), /ENOSPC/);
    const p = readState(x.s.home, "n4").publishing;
    assert.equal(refOf(x.s.repo, x.landRef), p.C);
    assert.deepEqual([p.member, p.target, p.H], [x.member, "main", readWorktreeRecord(x.s.home, x.member).rec.head]);
    // down keeps it, up waits for it.
    const r = await teamDown(x.s.home, "n4", {}, { endSession: () => false, sleep: async () => {}, wait: 0 });
    assert.match(r.pending, /a candidate was being published: hoptell team land dana-n4-impl-1 --target main -m <message> finishes it/);
    assert.ok(fs.existsSync(x.rec.path));
    const again = await build(x);
    assert.equal(again.adopted, true);
    assert.equal(again.C, p.C);
    const st = readState(x.s.home, "n4");
    assert.equal(st.publishing, null);
    assert.equal(st.candidate.C, p.C);
  }
  // The same failure, then --discard: the branch and the journal go.
  {
    const x = await landingSetup(t, "n4", { candidate: false });
    await assert.rejects(build(x, { save: failingSave(2) }), /ENOSPC/);
    await teamLandDiscard(x.s.home, x.member);
    assert.equal(refOf(x.s.repo, x.landRef), null);
    assert.equal(readState(x.s.home, "n4").publishing, null);
  }
  // The journal itself cannot be written: no branch.
  {
    const x = await landingSetup(t, "n4", { candidate: false });
    await assert.rejects(build(x, { save: failingSave(1) }), /ENOSPC/);
    assert.equal(refOf(x.s.repo, x.landRef), null);
    assert.equal(readState(x.s.home, "n4").publishing, null);
  }
  // The create is killed before it ran (status null): unknown, the journal stays; the rerun finds
  // the branch absent, drops the journal and builds the candidate.
  {
    const x = await landingSetup(t, "n4", { candidate: false });
    const g = faultyGit(x.s.root);
    g.set([{ match: "update-ref --no-deref -m hoptell team land: candidate", nth: 1, action: "kill" }]);
    await refusal(() => build(x, { git: g.git }), "publish_unknown", /whether the candidate was published is unknown/);
    assert.ok(readState(x.s.home, "n4").publishing);
    assert.equal(refOf(x.s.repo, x.landRef), null);
    g.set([]);
    const c = await build(x, { git: g.git });
    assert.equal(c.adopted, undefined);
    assert.equal(refOf(x.s.repo, x.landRef), c.C);
    assert.equal(readState(x.s.home, "n4").publishing, null);
    assert.match(readState(x.s.home, "n4").events.map((e) => e.what).join("\n"), /dropped the publication of \w+ for dana-n4-impl-1: its branch was never created/);
  }
});

const crashAfterRecord = () => {
  throw new Error("crash");
};
const refsOf = (repo) => git(repo, "for-each-ref", "--format=%(refname) %(objectname) %(symref)");
const stateBytes = (home, team = "n4") => fs.readFileSync(teamPaths(home, team).state, "utf8");

test("a symbolic candidate branch or target is never followed: --discard, a landed journal's cleanup and the move refuse, and no branch moves", async (t) => {
  // The candidate branch made a symbolic ref to main, with main at C: --discard refuses.
  {
    const x = await landingSetup(t);
    git(x.s.repo, "update-ref", "refs/heads/main", x.c.C, x.c.T);
    git(x.s.repo, "update-ref", "-d", x.landRef, x.c.C);
    git(x.s.repo, "symbolic-ref", x.landRef, "refs/heads/main");
    await refusal(() => teamLandDiscard(x.s.home, x.member), "ref_unreadable", /the candidate is kept: team\/n4\/land could not be read \(refs\/heads\/team\/n4\/land is a symbolic ref; hoptell does not follow it\); nothing was removed/);
    assert.equal(refOf(x.s.repo, "main"), x.c.C, "main survives");
    assert.equal(readState(x.s.home, "n4").candidate.C, x.c.C);
  }
  // The same after a recorded landing: the journal's cleanup refuses; main stays at C.
  {
    const x = await landingSetup(t);
    await assert.rejects(teamLandApprove(x.s.home, x.member, { T: x.c.T, C: x.c.C, homedir: x.s.homedir }, { afterRecord: crashAfterRecord }), /crash/);
    assert.equal(refOf(x.s.repo, "main"), x.c.C);
    git(x.s.repo, "update-ref", "-d", x.landRef, x.c.C);
    git(x.s.repo, "symbolic-ref", x.landRef, "refs/heads/main");
    await refusal(() => teamLandApprove(x.s.home, x.member, { T: x.c.T, C: x.c.C, homedir: x.s.homedir }), "ref_unreadable", /team\/n4\/land could not be read \(refs\/heads\/team\/n4\/land is a symbolic ref; hoptell does not follow it\)/);
    assert.equal(refOf(x.s.repo, "main"), x.c.C, "main survives");
    assert.equal(readState(x.s.home, "n4").landing.phase, "landed");
    assert.ok(readWorktreeRecord(x.s.home, x.member).rec, "the registration stays");
  }
  // The target made a symbolic ref to another branch that is checked out (dev, in the lead's tree):
  // the approval and a new candidate refuse, and no branch moves.
  {
    const x = await landingSetup(t);
    git(x.s.repo, "update-ref", "-d", "refs/heads/main", x.c.T);
    git(x.s.repo, "symbolic-ref", "refs/heads/main", "refs/heads/dev");
    const refs = refsOf(x.s.repo);
    await refusal(() => teamLandApprove(x.s.home, x.member, { T: x.c.T, C: x.c.C, homedir: x.s.homedir }), "ref_unreadable", /main could not be read \(refs\/heads\/main is a symbolic ref; hoptell does not follow it\); nothing was changed/);
    assert.equal(refsOf(x.s.repo), refs);
    assert.equal(refOf(x.s.repo, "dev"), x.c.T);
    assert.equal(readState(x.s.home, "n4").landing, null);
    await teamLandDiscard(x.s.home, x.member);
    const left = refsOf(x.s.repo);
    await refusal(() => teamLandCandidate(x.s.home, x.member, { target: "main", message: "Land", homedir: x.s.homedir }), "ref_unreadable", /main could not be read \(refs\/heads\/main is a symbolic ref/);
    assert.equal(refsOf(x.s.repo), left);
    assert.equal(readState(x.s.home, "n4").publishing, null);
  }
});

/**
 * A second clone of a landingSetup repository, with the same commits and refs (H, T and C the
 * same) and a copy of the member's worktree repaired into it; `recB` is the member's record for it
 * under the same name, `useRecord` puts a record text in place.
 */
function secondClone(t, x) {
  const rootB = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hoptell-team-b-")));
  t.after(() => fs.rmSync(rootB, { recursive: true, force: true }));
  const wtParent = path.dirname(x.rec.path);
  const repoB = path.join(rootB, "repo");
  const pathB = path.join(rootB, path.basename(wtParent), path.basename(x.rec.path));
  fs.cpSync(x.s.repo, repoB, { recursive: true });
  fs.cpSync(wtParent, path.dirname(pathB), { recursive: true });
  // Point the copy and the clone at each other directly: `git worktree repair <path>` leaves a
  // .git file that still names a valid admin folder (the first clone's) unchanged on Git 2.43.
  const id = path.basename(fs.readFileSync(path.join(pathB, ".git"), "utf8").replace(/^gitdir:\s*/, "").trim());
  const adminB = path.join(repoB, ".git", "worktrees", id);
  assert.ok(fs.existsSync(adminB), `the clone has the worktree's admin folder ${id}`);
  fs.writeFileSync(path.join(pathB, ".git"), `gitdir: ${adminB}\n`);
  fs.writeFileSync(path.join(adminB, "gitdir"), `${path.join(pathB, ".git")}\n`);
  git(repoB, "worktree", "repair", pathB); // no change expected; any other inconsistency is repaired
  assert.ok(fs.readFileSync(path.join(pathB, ".git"), "utf8").includes(rootB), "the copy is a worktree of its own clone");
  const recFile = worktreePaths(x.s.home).record(x.member);
  const recA = fs.readFileSync(recFile, "utf8");
  return { repoB, pathB, recFile, recA, recB: recA.split(x.s.root).join(rootB), useRecord: (text) => fs.writeFileSync(recFile, text, { mode: 0o600 }) };
}

test("a landing is bound to the team's own registration: a record of the same name for another clone refuses approve, adopt and discard, and nothing changes", async (t) => {
  const x = await landingSetup(t);
  const { repoB, pathB, recFile, recA, recB, useRecord } = secondClone(t, x);
  assert.equal(refOf(repoB, x.landRef), x.c.C);
  useRecord(recB);
  const snapshot = () => ({ a: refsOf(x.s.repo), b: refsOf(repoB), state: stateBytes(x.s.home), rec: fs.readFileSync(recFile, "utf8") });
  const before = snapshot();
  const notThis = new RegExp(`the worktree record of ${x.member} is for ${repoB} \\(${pathB}\\), not the worktree this team registered in ${x.s.repo} \\(${x.rec.path}\\); nothing was changed`);
  await refusal(() => teamLandApprove(x.s.home, x.member, { T: x.c.T, C: x.c.C, homedir: x.s.homedir }), "not_this_team", notThis);
  await refusal(() => teamLandDiscard(x.s.home, x.member), "not_this_team", notThis);
  assert.deepEqual(snapshot(), before);
  // A publication that did not finish: adopting it refuses as well.
  const st = readState(x.s.home, "n4");
  writeTeam(x.s.home, { ...st, candidate: null, publishing: { member: x.member, target: "main", T: x.c.T, H: x.c.H, C: x.c.C, at: st.candidate.at } });
  const adopting = snapshot();
  await refusal(() => teamLandCandidate(x.s.home, x.member, { target: "main", message: "Land", homedir: x.s.homedir }), "not_this_team", notThis);
  await refusal(() => teamLandDiscard(x.s.home, x.member), "not_this_team", notThis);
  assert.deepEqual(snapshot(), adopting);
  // The team's own record back, but a landing journal written for the other clone: refused.
  useRecord(recA);
  writeTeam(x.s.home, { ...st, landing: { member: x.member, H: x.c.H, C: x.c.C, T: x.c.T, target: "main", at: st.candidate.at, repo: repoB, phase: "intent" } });
  const journaled = snapshot();
  await refusal(() => teamLandApprove(x.s.home, x.member, { T: x.c.T, C: x.c.C, homedir: x.s.homedir }), "not_this_team", new RegExp(`the landing's journal is for ${repoB}, but team n4 registered ${x.member} in ${x.s.repo}; nothing was changed`));
  assert.deepEqual(snapshot(), journaled);
  // The name cannot be reused while its landing is pending: worktree remove and add refuse.
  const die = (m) => {
    throw Object.assign(new Error(m), { code: "die" });
  };
  const wt = (args) => worktreeCommand({ args, home: x.s.home, cwd: x.s.repo, fail: die, out: () => {} });
  const pending = /team n4 has a landing of dana-n4-impl-1 pending; finish or discard it first: a landing is pending: hoptell team land dana-n4-impl-1 --approve/;
  await refusal(() => wt(["remove", x.member]), "die", pending);
  fs.rmSync(recFile);
  await refusal(() => wt(["add", x.member, "--team", "n4", "--cli", "codex", "--repo", repoB]), "die", pending);
  assert.ok(!fs.existsSync(recFile));
  assert.equal(refsOf(x.s.repo), journaled.a);
  assert.equal(refsOf(repoB), journaled.b);
});

test("a candidate branch that git skips with a warning, or an exit-0 answer that is not clean, is never absence: every recovery state is kept", async (t) => {
  const approve = (x, deps) => teamLandApprove(x.s.home, x.member, { T: x.c.T, C: x.c.C, homedir: x.s.homedir }, deps);
  // A real broken loose ref: git for-each-ref warns, skips it and still ends with 0.
  {
    const x = await landingSetup(t);
    const file = path.join(x.s.repo, ".git", "refs", "heads", "team", "n4", "land");
    fs.writeFileSync(file, "garbage\n");
    const warned = /team\/n4\/land could not be read \(git for-each-ref warned: warning: ignoring broken ref refs\/heads\/team\/n4\/land\)/;
    await refusal(() => approve(x), "ref_unreadable", warned);
    await refusal(() => teamLandDiscard(x.s.home, x.member), "ref_unreadable", warned);
    assert.equal(readState(x.s.home, "n4").candidate.C, x.c.C);
    assert.equal(refOf(x.s.repo, "main"), x.c.T);
    assert.equal(fs.readFileSync(file, "utf8"), "garbage\n");
    // A publication that did not finish, then the broken branch: not adopted, not dropped.
    const st = readState(x.s.home, "n4");
    writeTeam(x.s.home, { ...st, candidate: null, publishing: { member: x.member, target: "main", T: x.c.T, H: x.c.H, C: x.c.C, at: st.candidate.at } });
    await refusal(() => teamLandCandidate(x.s.home, x.member, { target: "main", message: "Land", homedir: x.s.homedir }), "ref_unreadable", warned);
    assert.equal(readState(x.s.home, "n4").publishing.C, x.c.C);
    // team status shows the publication in progress, and so does its --json.
    const lines = [];
    await teamCommand({ args: ["status", "n4"], home: x.s.home, homedir: x.s.homedir, env: {}, out: (l) => lines.push(l), warn: () => {}, fail: (m) => assert.fail(m) });
    assert.ok(lines.includes(`  candidate being published: ${x.member} ${x.c.C} on main at ${x.c.T}; hoptell team land ${x.member} --target main -m <message> finishes it, or --discard`), lines.join("\n"));
    const json = [];
    await teamCommand({ args: ["status", "n4", "--json"], home: x.s.home, homedir: x.s.homedir, env: {}, out: (l) => json.push(l), warn: () => {}, fail: (m) => assert.fail(m) });
    assert.deepEqual(JSON.parse(json.join("\n")).publishing, { member: x.member, target: "main", T: x.c.T, H: x.c.H, C: x.c.C, at: st.candidate.at });
  }
  // A recorded landing whose candidate branch turned broken: its cleanup refuses, the journal stays.
  {
    const x = await landingSetup(t);
    await assert.rejects(approve(x, { afterRecord: crashAfterRecord }), /crash/);
    fs.writeFileSync(path.join(x.s.repo, ".git", "refs", "heads", "team", "n4", "land"), "garbage\n");
    await refusal(() => approve(x), "ref_unreadable", /git for-each-ref warned/);
    assert.equal(readState(x.s.home, "n4").landing.phase, "landed");
    assert.ok(readWorktreeRecord(x.s.home, x.member).rec);
  }
  // Injected answers with status 0: a warning only, garbage, a line for another ref; and a
  // symbolic-ref that says "symbolic".
  const cases = [
    { action: "warn0", re: /git for-each-ref warned: warning: ignoring broken ref injected/ },
    { action: "garbage0", re: /git for-each-ref gave an unexpected answer/ },
    { action: "other0", re: /git for-each-ref gave an unexpected answer/ },
    { action: "quiet0", symbolic: true, re: /refs\/heads\/team\/n4\/land is a symbolic ref; hoptell does not follow it/ },
  ];
  for (const k of cases) {
    const x = await landingSetup(t);
    const g = faultyGit(x.s.root);
    const rule = [{ match: k.symbolic ? `symbolic-ref -q ${x.landRef}` : `${FOR_EACH}${x.landRef}`, nth: 1, action: k.action }];
    g.set(rule);
    await refusal(() => approve(x, { git: g.git }), "ref_unreadable", k.re);
    g.set(rule);
    await refusal(() => teamLandDiscard(x.s.home, x.member, { git: g.git }), "ref_unreadable", k.re);
    assert.equal(readState(x.s.home, "n4").candidate.C, x.c.C, k.action);
    assert.equal(refOf(x.s.repo, x.landRef), x.c.C);
    assert.equal(refOf(x.s.repo, "main"), x.c.T);
    // The same answers to a landed journal's cleanup and to a publication's rerun.
    g.set([]);
    await assert.rejects(approve(x, { git: g.git, afterRecord: crashAfterRecord }), /crash/);
    g.set(rule);
    await refusal(() => approve(x, { git: g.git }), "ref_unreadable", k.re);
    assert.equal(readState(x.s.home, "n4").landing.phase, "landed", k.action);
    assert.ok(readWorktreeRecord(x.s.home, x.member).rec);
    g.set([]);
    await approve(x, { git: g.git });
    const y = await landingSetup(t, "n5", { candidate: false });
    const gy = faultyGit(y.s.root);
    await assert.rejects(teamLandCandidate(y.s.home, y.member, { target: "main", message: "Land", homedir: y.s.homedir }, { save: failingSave(2) }), /ENOSPC/);
    gy.set([{ ...rule[0], match: rule[0].match.replace(x.landRef, y.landRef) }]);
    await refusal(() => teamLandCandidate(y.s.home, y.member, { target: "main", message: "Land", homedir: y.s.homedir }, { git: gy.git }), "ref_unreadable", new RegExp(k.re.source.replace("n4", "n5")));
    assert.ok(readState(y.s.home, "n5").publishing, k.action);
  }
});

test("team down removes only the worktree it registered: a record of the same name replaced after its check is kept, not removed; status and restart refuse it too", async (t) => {
  const x = await landingSetup(t, "n4", { candidate: false });
  const { repoB, pathB, recFile, recA, recB, useRecord } = secondClone(t, x);
  const refs = { a: refsOf(x.s.repo), b: refsOf(repoB) };
  // status and restart while the record names the other clone: no git there, nothing started.
  useRecord(recB);
  const status = await teamStatus(x.s.home, "n4", {});
  const row = status.members.find((m) => m.name === x.member);
  assert.match(row.git, new RegExp(`not run: the worktree record of ${x.member} is for ${repoB}`));
  assert.equal(row.head, null);
  writeTeam(x.s.home, { ...readState(x.s.home, "n4"), members: readState(x.s.home, "n4").members.map((m) => ({ ...m, session: { id: "$1", pane: "%1", pid: 999999, root: null, started: new Date(0).toISOString() } })) });
  await refusal(() => teamRestart(x.s.home, x.member, { homedir: x.s.homedir, env: {} }, { procs: {}, warn: () => {}, launch: () => assert.fail("nothing is started") }), "not_this_team", new RegExp(`is for ${repoB} \\(${pathB}\\), not the worktree team n4 registered in ${x.s.repo}`));
  writeTeam(x.s.home, { ...readState(x.s.home, "n4"), members: readState(x.s.home, "n4").members.map((m) => ({ ...m, session: null })) });
  // down: the check reads the team's own record; the name is then reused for the other clone
  // before the removal reads it again.
  useRecord(recA);
  const down = await teamDown(x.s.home, "n4", {}, { endSession: () => false, sleep: async () => {}, wait: 0, beforeRemove: () => useRecord(recB) });
  const r = down.report.find((e) => e.name === x.member);
  assert.match(r.worktree, new RegExp(`^kept: the worktree record of ${x.member} is for ${repoB} \\(${pathB}\\), not the worktree this team registered in ${x.s.repo}`));
  assert.ok(fs.existsSync(pathB), "the other clone's worktree stays");
  assert.ok(fs.existsSync(x.rec.path));
  assert.equal(fs.readFileSync(recFile, "utf8"), recB, "its record stays");
  assert.deepEqual({ a: refsOf(x.s.repo), b: refsOf(repoB) }, refs);
  assert.equal(git(repoB, "worktree", "list", "--porcelain").includes(pathB), true);
});

test("decision 6: a team member's MCP server leaves out ask_owner and spawn_agent and refuses them; the lead and other sessions are unchanged", async (t) => {
  const calls = [];
  const engine = {
    attach: () => ({ detach() {} }),
    start: async () => {},
    instructions: () => "",
    tools: async () => ["list_peers", "send_message", "ask_owner", "read_inbox"].map((name) => ({ name, description: name, inputSchema: { type: "object" } })),
    call: async (name) => (calls.push(name), { content: [{ type: "text", text: `ran ${name}` }] }),
    delivery: { mode: "tmux" },
  };
  const agents = { tools: ["spawn_agent", "list_agents"].map((name) => ({ name, inputSchema: { type: "object" } })), has: (n) => ["spawn_agent", "list_agents"].includes(n), call: async (n) => (calls.push(n), { content: [{ type: "text", text: `ran ${n}` }] }) };
  const serve = async (member) => {
    const [a, b] = InMemoryTransport.createLinkedPair();
    const close = await serveEngine(engine, a, { front: "stdio", agents, member });
    const c = new Client({ name: "t", version: "0" });
    await c.connect(b);
    t.after(async () => {
      await c.close().catch(() => {});
      await close();
    });
    return c;
  };
  const text = (r) => r.content[0].text;
  assert.deepEqual(MEMBER_HIDDEN, ["ask_owner", "spawn_agent"]);
  for (const role of ["implementer", "reviewer"]) {
    const c = await serve({ role, team: "n4" });
    assert.deepEqual((await c.listTools()).tools.map((x) => x.name), ["list_peers", "send_message", "read_inbox", "list_agents"], role);
    for (const name of MEMBER_HIDDEN) {
      const r = await c.callTool({ name, arguments: { question: "may I push?" } });
      assert.equal(r.isError, true);
      assert.equal(text(r), `not_available_to_team_member: ${name} is not available to a team member (the ${role} of team n4); send owner questions and requests for more agents to your lead`);
    }
    assert.equal(text(await c.callTool({ name: "send_message", arguments: {} })), "ran send_message");
  }
  assert.deepEqual(calls, ["send_message", "send_message"], "a refused call reaches neither the engine nor the spawn tools");
  // A member whose value did not parse: still filtered.
  const odd = await serve({ role: null, team: null });
  assert.ok(!(await odd.listTools()).tools.some((x) => MEMBER_HIDDEN.includes(x.name)));
  assert.match(text(await odd.callTool({ name: "ask_owner", arguments: {} })), /^not_available_to_team_member: ask_owner is not available to a team member; send owner/);
  // The lead and any other session: everything, as before.
  calls.length = 0;
  const lead = await serve(null);
  assert.deepEqual((await lead.listTools()).tools.map((x) => x.name), ["list_peers", "send_message", "ask_owner", "read_inbox", "spawn_agent", "list_agents"]);
  assert.equal(text(await lead.callTool({ name: "ask_owner", arguments: {} })), "ran ask_owner");
  assert.equal(text(await lead.callTool({ name: "spawn_agent", arguments: {} })), "ran spawn_agent");
  assert.deepEqual(calls, ["ask_owner", "spawn_agent"]);
});

test("decision 6 end to end: hoptell mcp with HOPTELL_TEAM_MEMBER refuses ask_owner and spawn_agent; without it they are not refused as a member's", async (t) => {
  const w = await world();
  t.after(() => w.close());
  const member = await w.mcp("dana-n7-impl-1", { HOPTELL_TEAM_MEMBER: "implementer:n7" });
  for (const name of MEMBER_HIDDEN) {
    assert.ok(!(await member.client.listTools()).tools.some((x) => x.name === name), name);
    assert.equal(await member.call(name, { question: "x" }), `not_available_to_team_member: ${name} is not available to a team member (the implementer of team n7); send owner questions and requests for more agents to your lead`);
  }
  assert.match(await member.call("list_peers"), /You are/);
  const lead = await w.mcp("dana-lead");
  for (const name of MEMBER_HIDDEN) assert.doesNotMatch(await lead.call(name, { question: "x" }), /not_available_to_team_member/);
});

/** A team n9 in `home` with one implementer (two commits in its worktree) and two reviewers. */
async function reviewSetup(t, home = null) {
  const s = repoSetup(t);
  home ??= s.home;
  const member = "dana-n9-impl-1";
  const rec = await addWorktree(home, { repo: s.repo, member, team: "n9", cli: "codex" });
  fs.writeFileSync(path.join(rec.path, "lib", "x.js"), "2\n");
  const c1 = await commitWorktree(home, member, { message: "one" });
  fs.writeFileSync(path.join(rec.path, "lib", "x.js"), "3\n");
  const c2 = await commitWorktree(home, member, { message: "two" });
  const impl = memberRow(member, "implementer", null, { cli: "codex", template: "implementer", worktree: rec.path, branch: rec.branch, registration: registrationOf(rec), cwd: rec.path });
  writeTeam(home, stateOf("n9", [impl, memberRow("dana-n9-rev-1", "reviewer", null), memberRow("dana-n9-rev-2", "reviewer", null)], { repo: s.repo }));
  return { s, home, member, base: rec.base, c1: c1.commit, c2: c2.commit, rec };
}

test("review queue: a request names a member's recorded commits and the team's reviewers, goes out through the send path and is recorded; the lead records verdicts", async (t) => {
  const x = await reviewSetup(t);
  const sent = [];
  const send = async (to, text) => (sent.push({ to, text }), `sent to ${to}`);
  const req = (o, deps = { send }) => reviewRequest(x.home, { team: "n9", base: x.base, head: x.c2, ...o }, deps);
  // Refusals: nothing is recorded or sent.
  await refusal(() => req({ base: x.base.slice(0, 12) }), "bad_commit", /--base takes a full commit id \(40 or 64 hex digits\)/);
  await refusal(() => req({ head: "main" }), "bad_commit", /--head takes a full commit id/);
  await refusal(() => req({ head: x.base }), "bad_commit", /the same commit/);
  await refusal(() => req({ base: x.c2, head: x.c1 }), "unknown_commit", /is not a commit hoptell recorded in a worktree of team n9 with \w+ before it/);
  await refusal(() => req({ head: "f".repeat(40) }), "unknown_commit");
  await refusal(() => req({ to: ["dana-n9-impl-1"] }), "not_member", /dana-n9-impl-1 is not a reviewer of team n9 \(its reviewers: dana-n9-rev-1, dana-n9-rev-2\)/);
  await refusal(() => req({ to: ["dana-n8-rev-1"] }), "not_member");
  await refusal(() => reviewRequest(x.home, { team: "n8", base: x.base, head: x.c2 }, { send }), "no_team");
  assert.ok(!fs.existsSync(path.join(x.home, "teams", "n8")), "an unknown team gets no folder");
  assert.deepEqual(readState(x.home, "n9").reviews, []);
  assert.deepEqual(sent, []);
  // A request to every reviewer (the default), from the worktree's base to its head.
  const r = await req({});
  assert.match(r.review.id, /^rv-[0-9a-f]{8}$/);
  assert.deepEqual([r.review.member, r.review.base, r.review.head, r.review.reviewers], [x.member, x.base, x.c2, ["dana-n9-rev-1", "dana-n9-rev-2"]]);
  assert.deepEqual(sent.map((m) => m.to), ["dana-n9-rev-1", "dana-n9-rev-2"]);
  assert.equal(sent[0].text, `Review request ${r.review.id} from dana-lead (team n9): review dana-n9-impl-1's commits ${x.base}..${x.c2} on team/n9/dana-n9-impl-1; read them with: git -C ${x.s.repo} diff --no-ext-diff --no-textconv ${x.base} ${x.c2} . Your verdict is for ${x.c2} only. Reply to dana-lead with approve or changes and your findings; dana-lead records your verdict.`);
  assert.deepEqual(readState(x.home, "n9").reviews, [{ ...r.review }]);
  // Commit to commit inside the worktree, to one reviewer named; a send that fails keeps the request.
  const failing = async (to) => {
    throw new Error(`unknown peer ${to}`);
  };
  const r2 = await req({ base: x.c1, to: ["dana-n9-rev-2", "dana-n9-rev-2"] }, { send: failing });
  assert.deepEqual(r2.review.reviewers, ["dana-n9-rev-2"]);
  assert.deepEqual(r2.sent, [{ to: "dana-n9-rev-2", error: "unknown peer dana-n9-rev-2" }]);
  assert.equal(readState(x.home, "n9").reviews.length, 2);
  // Verdicts: only by the lead's command, only for a reviewer asked.
  await refusal(() => reviewVerdict(x.home, { team: "n9", id: "rv-zz", reviewer: "dana-n9-rev-1", verdict: "approve" }), "unknown_request");
  await refusal(() => reviewVerdict(x.home, { team: "n9", id: "rv-00000000", reviewer: "dana-n9-rev-1", verdict: "approve" }), "unknown_request", /team n9 has no review request rv-00000000/);
  await refusal(() => reviewVerdict(x.home, { id: r.review.id, reviewer: "dana-n9-rev-1", verdict: "approve" }), "which_team", /review verdict needs --team <team>/);
  await refusal(() => reviewVerdict(x.home, { team: "n9", id: r.review.id, reviewer: "dana-n9-rev-1", verdict: "lgtm" }), "bad_verdict", /approve or changes/);
  await refusal(() => reviewVerdict(x.home, { team: "n9", id: r.review.id, reviewer: "dana-n9-impl-1", verdict: "approve" }), "not_member");
  await refusal(() => reviewVerdict(x.home, { team: "n9", id: r2.review.id, reviewer: "dana-n9-rev-1", verdict: "approve" }), "not_asked", /dana-n9-rev-1 was not asked for rv-\w+ \(asked: dana-n9-rev-2\)/);
  const v1 = await reviewVerdict(x.home, { team: "n9", id: r.review.id, reviewer: "dana-n9-rev-1", verdict: "changes" });
  assert.deepEqual(v1.review.waiting, ["dana-n9-rev-2"]);
  // team status: the open requests and who has not answered.
  let st = await teamStatus(x.home, "n9", {});
  assert.deepEqual(st.reviews.map((v) => [v.id, v.waiting]), [[r.review.id, ["dana-n9-rev-2"]], [r2.review.id, ["dana-n9-rev-2"]]]);
  const lines = [];
  await teamCommand({ args: ["status", "n9"], home: x.home, env: {}, fail: (m) => assert.fail(m), out: (l) => lines.push(l), warn: () => {}, deps: { launch: () => assert.fail("no launch") } });
  assert.ok(lines.includes(`  review ${r.review.id}: dana-n9-impl-1's ${x.base.slice(0, 12)}..${x.c2.slice(0, 12)}; waiting for dana-n9-rev-2; dana-n9-rev-1 changes`), lines.join("\n"));
  assert.ok(lines.includes(`  review ${r2.review.id}: dana-n9-impl-1's ${x.c1.slice(0, 12)}..${x.c2.slice(0, 12)}; waiting for dana-n9-rev-2`));
  // A later verdict replaces the reviewer's earlier one; the history stays in the state.
  await reviewVerdict(x.home, { team: "n9", id: r.review.id, reviewer: "dana-n9-rev-1", verdict: "approve" });
  const done = await reviewVerdict(x.home, { team: "n9", id: r.review.id, reviewer: "dana-n9-rev-2", verdict: "approve" });
  assert.deepEqual(done.review.waiting, []);
  assert.deepEqual(done.review.answers.map((a) => `${a.reviewer} ${a.verdict}`), ["dana-n9-rev-1 approve", "dana-n9-rev-2 approve"]);
  assert.equal(readState(x.home, "n9").reviews[0].verdicts.length, 3);
  lines.length = 0;
  await teamCommand({ args: ["status", "n9"], home: x.home, env: {}, fail: (m) => assert.fail(m), out: (l) => lines.push(l), warn: () => {}, deps: { launch: () => assert.fail("no launch") } });
  assert.ok(lines.includes(`  last review ${r.review.id}: dana-n9-impl-1's ${x.base.slice(0, 12)}..${x.c2.slice(0, 12)}: dana-n9-rev-1 approve, dana-n9-rev-2 approve`), lines.join("\n"));
  assert.ok(!lines.some((l) => l.startsWith(`  review ${r.review.id}`)), "an answered request is no longer open");
  // A landing candidate's T..C: exactly the recorded candidate's (or a pending publication's or
  // landing's) target commit and candidate; any other pair is refused. No git runs for either.
  const T = "a".repeat(40);
  const C = "b".repeat(40);
  const base9 = readState(x.home, "n9");
  writeTeam(x.home, { ...base9, candidate: { member: x.member, target: "main", T, C, H: x.c2, at: base9.created } });
  sent.length = 0;
  const cr = await req({ base: T, head: C });
  assert.deepEqual([cr.review.member, cr.review.base, cr.review.head], [x.member, T, C]);
  assert.match(sent[0].text, new RegExp(`review dana-n9-impl-1's commits ${T}\\.\\.${C} on team/n9/land \\(the candidate of dana-n9-impl-1 for main\\); read them with: git -C \\S+ diff --no-ext-diff --no-textconv ${T} ${C} \\. `));
  const unknown = /is not a commit hoptell recorded in a worktree of team n9 with \w+ before it, nor the candidate of team n9 on its target commit/;
  const before = readState(x.home, "n9").reviews.length;
  await refusal(() => req({ base: T, head: "c".repeat(40) }), "unknown_commit", unknown);
  await refusal(() => req({ base: x.base, head: C }), "unknown_commit", unknown);
  await refusal(() => req({ base: C, head: T }), "unknown_commit", unknown);
  assert.equal(readState(x.home, "n9").reviews.length, before, "nothing recorded for a pair that does not match");
  // The same pair from a publication or a landing journal that is still pending.
  for (const extra of [{ publishing: { member: x.member, target: "main", T, H: x.c2, C, at: base9.created } }, { landing: { member: x.member, H: x.c2, C, T, target: "main", at: base9.created, repo: x.s.repo, phase: "intent" } }]) {
    writeTeam(x.home, { ...readState(x.home, "n9"), candidate: null, ...extra });
    assert.equal((await req({ base: T, head: C })).review.member, x.member, Object.keys(extra)[0]);
    writeTeam(x.home, { ...readState(x.home, "n9"), publishing: null, landing: null });
  }
  await refusal(() => req({ base: T, head: C }), "unknown_commit", unknown);
  // A team that is down takes no new requests.
  writeTeam(x.home, { ...readState(x.home, "n9"), status: "down" });
  await refusal(() => req({}), "team_down");
  // The state's schema: a review with a verdict of a reviewer not asked, or a duplicate id, is refused.
  const good = readState(x.home, "n9");
  assert.equal(stateProblem(good, "n9"), null);
  assert.equal(stateProblem({ ...good, reviews: [{ ...good.reviews[1], verdicts: [{ reviewer: "dana-n9-rev-1", verdict: "approve", at: good.reviews[1].at }] }] }, "n9"), "field reviews");
  assert.equal(stateProblem({ ...good, reviews: [good.reviews[0], good.reviews[0]] }, "n9"), "field reviews");
  assert.equal(stateProblem({ ...good, reviews: [{ ...good.reviews[0], head: "main" }] }, "n9"), "field reviews");
  const old = { ...good };
  delete old.reviews;
  assert.equal(stateProblem(old, "n9"), "field reviews");
});

test("hoptell review: the command line checks its arguments; a request reaches an online reviewer through the relay", async (t) => {
  const w = await world();
  t.after(() => w.close());
  const x = await reviewSetup(t, w.home);
  const die = (m, code = 1) => {
    throw Object.assign(new Error(m), { code: `exit ${code}` });
  };
  const run = (args, send = async () => "sent") => {
    const lines = [];
    return reviewCommand({ args, home: w.home, fail: die, out: (l) => lines.push(l), send }).then(() => lines);
  };
  await refusal(() => run([]), "exit 2", /review needs a command/);
  await refusal(() => run(["approve"]), "exit 2", /unknown review command "approve"/);
  await refusal(() => run(["request", "--team", "n9", "--base"]), "exit 2", /--base needs a value/);
  await refusal(() => run(["request", "--team", "n9", "--team", "n9", "--base", x.base, "--head", x.c2]), "exit 2", /--team is given more than once/);
  await refusal(() => run(["request", "--team", "n9", "--base", x.base, "--head", x.c2, "--json"]), "exit 2", /unknown option --json/);
  await refusal(() => run(["request", "--base", x.base, "--head", x.c2]), "exit 1", /review request needs --team <team>/);
  await refusal(() => run(["verdict", "--team", "n9", "rv-00000000", "dana-n9-rev-1"]), "exit 2", /needs a request, a reviewer and approve or changes/);
  await refusal(() => run(["verdict", "rv-00000000", "dana-n9-rev-1", "approve"]), "exit 1", /review verdict needs --team <team>/);
  await refusal(() => run(["verdict", "--team", "n9", "--to", "x", "rv-00000000", "dana-n9-rev-1", "approve"]), "exit 2", /review verdict takes only --team/);
  // A send that fails: the request is recorded first and said so; the command fails.
  const lines = [];
  await refusal(
    () =>
      reviewCommand({
        args: ["request", "--team", "n9", "--base", x.base, "--head", x.c2, "--to", "dana-n9-rev-1"],
        home: w.home,
        fail: die,
        out: (l) => lines.push(l),
        send: async () => {
          throw new Error("unknown peer");
        },
      }),
    "exit 1",
    /the request was not sent to every reviewer/,
  );
  assert.match(lines[0], /^Review request rv-[0-9a-f]{8} recorded: dana-n9-impl-1's \w{12}\.\.\w{12}, asked dana-n9-rev-1\.$/);
  assert.match(lines[1], /dana-n9-rev-1: not sent \(unknown peer\); the request stays recorded/);
  // End to end: the lead's CLI sends to a reviewer that is online; its inbox has the request.
  const rv = await w.mcp("dana-n9-rev-1");
  const r = await w.cli(["review", "request", "--team", "n9", "--base", x.base, "--head", x.c2, "--to", "dana-n9-rev-1"], { HOPTELL_NAME: "dana-lead" });
  assert.equal(r.code, 0, r.stderr);
  const id = /Review request (rv-[0-9a-f]{8}) recorded/.exec(r.stdout)[1];
  let inbox = "";
  for (let i = 0; i < 50 && !inbox.includes(id); i++, await sleep(100)) inbox = await rv.call("read_inbox");
  assert.match(inbox, new RegExp(`Review request ${id} from dana-lead \\(team n9\\)`));
  const v = await w.cli(["review", "verdict", "--team", "n9", id, "dana-n9-rev-1", "approve"]);
  assert.equal(v.code, 0, v.stderr);
  assert.match(v.stdout, new RegExp(`Recorded: dana-n9-rev-1 approve for ${x.c2.slice(0, 12)} \\(${id}, team n9\\)\\.\n {2}every reviewer asked has answered: dana-n9-rev-1 approve`));
  const bad = await w.cli(["review", "verdict", "--team", "n9", id, "dana-n9-rev-2", "approve"]);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /dana-n9-rev-2 was not asked/);
});

test("review request: reviewers are told git diff --no-ext-diff --no-textconv; the exact command it prints runs no diff program or textconv filter of the repository", async (t) => {
  const x = await reviewSetup(t);
  const sent = [];
  await reviewRequest(x.home, { team: "n9", base: x.base, head: x.c2 }, { send: async (to, text) => (sent.push(text), "sent") });
  const cmd = /read them with: (.*) \. Your verdict/.exec(sent[0])[1];
  assert.equal(cmd, reviewDiff(x.s.repo, x.base, x.c2));
  // The repository now selects an external diff program and a textconv filter (set after the
  // worktree add, which refuses them). Each leaves a mark in the canary file when it runs.
  const canary = path.join(x.s.root, "canary");
  const tool = path.join(x.s.root, "tool.sh");
  fs.writeFileSync(tool, `#!/bin/sh\necho ran >> '${canary}'\necho CANARY-OUTPUT\ncat "$1" 2>/dev/null\nexit 0\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(x.s.repo, ".git", "info", "attributes"), "* diff=canary\n");
  git(x.s.repo, "config", "diff.canary.textconv", tool);
  const sh = (line) => execFileSync("sh", ["-c", line], { env: gitEnv, encoding: "utf8", cwd: x.s.root });
  for (const external of [false, true]) {
    if (external) git(x.s.repo, "config", "diff.external", tool);
    // The canary works: a plain git diff runs the program.
    assert.match(sh(`git -C '${x.s.repo}' diff ${x.base} ${x.c2}`), /CANARY-OUTPUT/, external ? "external diff" : "textconv");
    assert.ok(fs.existsSync(canary));
    fs.rmSync(canary);
    // The request's command: the real patch, and the program never ran.
    const out = sh(cmd);
    assert.doesNotMatch(out, /CANARY/);
    assert.ok(!fs.existsSync(canary), external ? "no external diff ran" : "no textconv ran");
    assert.match(out, /^-export const x = 1;$/m);
    assert.match(out, /^\+3$/m);
  }
});

test("review request through a relay entry with a namePrefix: every reviewer gets it from the same sender", async (t) => {
  const w = await world();
  t.after(() => w.close());
  const x = await reviewSetup(t, w.home);
  const r1 = await w.mcp("dana-n9-rev-1");
  const r2 = await w.mcp("dana-n9-rev-2");
  const relays = path.join(w.home, "relays.json");
  fs.writeFileSync(relays, JSON.stringify({ version: 1, relays: [{ alias: "local", url: w.env.HOPTELL_RELAY, tokenEnv: "LOCAL_TOKEN", namePrefix: "p-" }], default: "local" }), { mode: 0o600 });
  const r = await w.cli(["review", "request", "--team", "n9", "--base", x.base, "--head", x.c2], { HOPTELL_NAME: "dana-lead", HOPTELL_RELAYS: relays, LOCAL_TOKEN: w.env.HOPTELL_TOKEN });
  assert.equal(r.code, 0, r.stderr);
  const id = /Review request (rv-[0-9a-f]{8}) recorded/.exec(r.stdout)[1];
  for (const rv of [r1, r2]) {
    let inbox = "";
    for (let i = 0; i < 50 && !inbox.includes(id); i++, await sleep(100)) inbox = await rv.call("read_inbox");
    assert.match(inbox, new RegExp(`Review request ${id} from dana-lead`));
    assert.match(inbox, /\bp-dana-lead\b/, "sent as the prefixed name");
    assert.doesNotMatch(inbox, /p-p-dana-lead/, "the prefix is applied once");
  }
});

test("review queue caps keep live data: 200 open requests refuse the next one; answered ones make room; a reviewer's only verdict survives 200 later ones of another", async (t) => {
  const x = await reviewSetup(t);
  const send = async () => "sent";
  const at = new Date(0).toISOString();
  const open = Array.from({ length: 200 }, (_, i) => ({ id: `rv-${i.toString(16).padStart(8, "0")}`, base: x.base, head: x.c2, member: x.member, reviewers: ["dana-n9-rev-1"], at, verdicts: [] }));
  writeTeam(x.home, { ...readState(x.home, "n9"), reviews: open });
  const bytes = stateBytes(x.home, "n9");
  await refusal(() => reviewRequest(x.home, { team: "n9", base: x.base, head: x.c2 }, { send }), "too_many_reviews", /team n9 has too many open review requests \(200\); record the replies you have received with hoptell review verdict --team n9 <request> <reviewer> approve\|changes first/);
  assert.equal(stateBytes(x.home, "n9"), bytes, "all 200 open requests are kept, nothing else changed");
  // One answered: it makes room, the 199 still open stay.
  await reviewVerdict(x.home, { team: "n9", id: "rv-00000005", reviewer: "dana-n9-rev-1", verdict: "approve" });
  const r = await reviewRequest(x.home, { team: "n9", base: x.base, head: x.c2 }, { send });
  const ids = readState(x.home, "n9").reviews.map((v) => v.id);
  assert.equal(ids.length, 200);
  assert.ok(!ids.includes("rv-00000005"));
  assert.deepEqual(ids.slice(0, -1), open.map((v) => v.id).filter((id) => id !== "rv-00000005"));
  assert.equal(ids.at(-1), r.review.id);
  // B answers once, A 200 times: B's verdict is still there; the log stays at its cap.
  writeTeam(x.home, { ...readState(x.home, "n9"), reviews: [] });
  const two = await reviewRequest(x.home, { team: "n9", base: x.base, head: x.c2 }, { send });
  await reviewVerdict(x.home, { team: "n9", id: two.review.id, reviewer: "dana-n9-rev-2", verdict: "changes" });
  let last;
  for (let i = 0; i < 200; i++) last = await reviewVerdict(x.home, { team: "n9", id: two.review.id, reviewer: "dana-n9-rev-1", verdict: i % 2 ? "approve" : "changes" });
  assert.deepEqual(last.review.answers.map((a) => `${a.reviewer} ${a.verdict}`).sort(), ["dana-n9-rev-1 approve", "dana-n9-rev-2 changes"]);
  const kept = readState(x.home, "n9").reviews[0].verdicts;
  assert.equal(kept.length, 200);
  assert.deepEqual(kept.filter((v) => v.reviewer === "dana-n9-rev-2").map((v) => v.verdict), ["changes"]);
});

test("review request ids are per team: a verdict names its team and changes only that team, even when another team has the same id and reviewer", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "hoptell-review-ids-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const at = new Date(0).toISOString();
  const review = { id: "rv-deadbeef", base: "1".repeat(40), head: "2".repeat(40), member: "dana-impl-1", reviewers: ["dana-rev-1"], at, verdicts: [] };
  writeTeam(home, stateOf("n4", [memberRow("dana-rev-1", "reviewer", null)], { status: "down", reviews: [review] }));
  writeTeam(home, stateOf("n5", [memberRow("dana-rev-1", "reviewer", null)], { reviews: [review] }));
  const n4 = stateBytes(home, "n4");
  const r = await reviewVerdict(home, { team: "n5", id: "rv-deadbeef", reviewer: "dana-rev-1", verdict: "approve" });
  assert.equal(r.team, "n5");
  assert.deepEqual(readState(home, "n5").reviews[0].verdicts.map((v) => v.verdict), ["approve"]);
  assert.equal(stateBytes(home, "n4"), n4, "the other team's state is byte-identical");
  await refusal(() => reviewVerdict(home, { team: "n6", id: "rv-deadbeef", reviewer: "dana-rev-1", verdict: "approve" }), "no_team");
  await refusal(() => reviewVerdict(home, { id: "rv-deadbeef", reviewer: "dana-rev-1", verdict: "approve" }), "which_team");
  assert.equal(stateBytes(home, "n4"), n4);
});

test("team status: an implementer without a worktree shows no worktree, or worktree removed after a landing or down; never undefined", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "hoptell-st-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const impl = (name) => memberRow(name, "implementer", null, { cli: "codex", worktree: `/x/repo-wt/${name}`, branch: `team/n6/${name}` });
  const landed = { member: "dana-n6-impl-2", H: "a".repeat(40), C: "b".repeat(40), T: "c".repeat(40), target: "main", at: new Date(0).toISOString() };
  writeTeam(home, stateOf("n6", [impl("dana-n6-impl-1"), impl("dana-n6-impl-2")], { landed: [landed] }));
  const show = async (args) => {
    const out = [];
    await teamCommand({ args, home, homedir: home, env: {}, out: (l) => out.push(l), warn: () => {}, fail: (m) => assert.fail(m) });
    return out.join("\n");
  };
  let text = await show(["status", "n6"]);
  assert.match(text, /dana-n6-impl-1 .*\n {4}team\/n6\/dana-n6-impl-1\n {4}no worktree\n/);
  assert.match(text, /dana-n6-impl-2 .*\n {4}team\/n6\/dana-n6-impl-2\n {4}worktree removed/);
  let json = await show(["status", "n6", "--json"]);
  assert.deepEqual(JSON.parse(json).members.map((m) => [m.noWorktree, m.commits, m.head]), [["no worktree", null, null], ["worktree removed", null, null]]);
  for (const s of [text, json]) assert.doesNotMatch(s, /undefined|\? commit/);
  // A team that is down: hoptell removed what it could.
  writeTeam(home, stateOf("n6", [impl("dana-n6-impl-1")], { status: "down" }));
  text = await show(["status", "n6"]);
  assert.match(text, /\n {4}worktree removed/);
  json = await show(["status", "n6", "--json"]);
  assert.doesNotMatch(text + json, /undefined/);
});

test("team stop: after a confirmed stop, a process still closing in the member's worktree is waited for briefly, then named", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "hoptell-linger-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const wt = "/x/repo-wt/dana-n7-impl-1";
  // Its pane's process is gone (no worktree record: the recorded pid, positively absent).
  const gone = { id: "$1", pane: "%1", pid: 999_999, root: null, started: new Date(0).toISOString() };
  const team = () => writeTeam(home, stateOf("n7", [memberRow("dana-n7-impl-1", "implementer", gone, { cli: "codex", worktree: wt, branch: "team/n7/dana-n7-impl-1" })]));
  const self = { pid: 500, cwd: "/", command: "node" };
  // An injected monotonic clock: the pauses and the scans (`scanMs` each) move it.
  let scans = 0;
  let clock = 0;
  let budgets = [];
  const deps = (rows, { scanMs = 0, lingerMs = 1000 } = {}) => ({
    procs: {
      table: () => new Map([[500, { pid: 500, ppid: 1, uid: process.getuid(), start: "1" }]]),
      self: 500,
      cwds: ({ timeoutMs }) => (scans++, budgets.push(timeoutMs), (clock += scanMs), rows(scans)),
    },
    endSession: () => true,
    sleep: async (ms) => void (clock += ms),
    now: () => clock,
    lingerMs,
  });
  team();
  let r = await teamStop(home, "dana-n7-impl-1", deps(() => [self, { pid: 700, cwd: `${wt}/lib`, command: "node" }]));
  assert.equal(r.state, "exited; process 700 (node) still runs in its worktree");
  assert.equal(scans, 4, "polled every 250 ms within the bounded 1 s, then named");
  assert.deepEqual(budgets, [1000, 750, 500, 250], "each scan gets only the time left");
  // A slow scan counts against the bound: after a 3 s scan and a pause, the second scan gets only
  // the 1.75 s left (a reader that kept to it would end by 5 s), and no third scan starts.
  [scans, clock, budgets] = [0, 0, []];
  team();
  r = await teamStop(home, "dana-n7-impl-1", deps(() => [self, { pid: 700, cwd: wt, command: "node" }], { scanMs: 3000, lingerMs: 5000 }));
  assert.equal(r.state, "exited; process 700 (node) still runs in its worktree");
  assert.deepEqual(budgets, [5000, 1750]);
  assert.equal(clock, 6250);
  // A scan that cannot answer (timed out) after one that saw the process: the last one seen is named.
  [scans, clock, budgets] = [0, 0, []];
  team();
  r = await teamStop(home, "dana-n7-impl-1", deps((n) => (n === 1 ? [self, { pid: 700, cwd: wt, command: "node" }] : null)));
  assert.equal(r.state, "exited; process 700 (node) still runs in its worktree");
  assert.equal(scans, 2);
  // It closes on the third look: plain exited.
  [scans, clock] = [0, 0];
  team();
  r = await teamStop(home, "dana-n7-impl-1", deps((n) => (n < 3 ? [self, { pid: 700, cwd: wt, command: "node" }] : [self])));
  assert.equal(r.state, "exited");
  assert.equal(scans, 3);
  // A first scan that cannot answer leaves it to the worktree commands.
  [scans, clock] = [0, 0];
  team();
  r = await teamStop(home, "dana-n7-impl-1", deps(() => null));
  assert.equal(r.state, "exited");
  assert.equal(scans, 1);
});

test("team up's lead check only warns: online says nothing, offline and a failed check say so", async () => {
  const said = [];
  const warn = (l) => said.push(l);
  await leadCheck("dana-lead", { leadOnline: async () => true, warn });
  assert.deepEqual(said, []);
  await leadCheck("dana-lead", { leadOnline: async () => null, warn });
  await leadCheck("dana-lead", {
    leadOnline: async () => {
      throw new Error("no relay");
    },
    warn,
  });
  assert.deepEqual(said, Array(2).fill("warning: could not check whether the lead dana-lead is online at the relay; members reach it only while a session is connected under that name"));
  await leadCheck("dana-lead", { warn }); // no check available: nothing
  assert.equal(said.length, 2);
});

// ---- the lead prepares, the owner decides (design 8 addendum, option 2) ----------------------------

/**
 * landingSetup without a candidate, with a reviewer in the team: the lead prepares the candidate
 * (--prepare), and the helpers record evidence, a review and a request.
 */
async function preparedSetup(t, { checkout = true, change = null, beforePrepare = null } = {}) {
  const x = await landingSetup(t, "n4", { candidate: false });
  const st = readState(x.s.home, "n4");
  st.members.push(memberRow("dana-n4-rev-1", "reviewer", null));
  writeTeam(x.s.home, st);
  if (change) {
    change(x.rec.path);
    await commitWorktree(x.s.home, x.member, { message: "more" });
  }
  if (checkout) git(x.s.repo, "checkout", "-q", "main");
  await beforePrepare?.(x);
  const report = path.join(x.s.root, "report.txt");
  fs.writeFileSync(report, "ok 12 tests\n");
  const c = await teamLandPrepare(x.s.home, x.member, { target: "main", message: "Land the change", homedir: x.s.homedir });
  const home = x.s.home;
  const review = async (...verdicts) => {
    const r = await reviewRequest(home, { team: "n4", base: c.T, head: c.C }, { send: async () => "sent" });
    for (const v of verdicts) await reviewVerdict(home, { team: "n4", id: r.review.id, reviewer: "dana-n4-rev-1", verdict: v });
    return r.review.id;
  };
  const evidence = (more = {}) => teamEvidence(home, x.member, { C: c.C, tests: "pass", commands: ["npm test"], report, ...more });
  const request = (deps = {}) => teamLandRequest(home, x.member, deps);
  const cli = async (args, { tty = false, answer = "land", deps = {}, env = {}, warned = null } = {}) => {
    const lines = [];
    try {
      await teamCommand({ args, home, homedir: x.s.homedir, env, isTTY: tty, out: (l) => lines.push(l), warn: (l) => warned?.push(l), fail: (m) => { throw Object.assign(new Error(m), { code: "cli" }); }, deps: { ask: async () => answer, ...deps } });
    } catch (e) {
      e.lines = lines;
      throw e;
    }
    return lines;
  };
  return { ...x, c, report, review, evidence, request, cli };
}

test("a team without a reviewer: --request-approval says the owner lands it in a terminal", async (t) => {
  const x = await landingSetup(t, "n4", { candidate: false });
  git(x.s.repo, "checkout", "-q", "main");
  const c = await teamLandPrepare(x.s.home, x.member, { target: "main", message: "Land", homedir: x.s.homedir });
  const report = path.join(x.s.root, "report.txt");
  fs.writeFileSync(report, "ok\n");
  await teamEvidence(x.s.home, x.member, { C: c.C, tests: "pass", commands: ["npm test"], report });
  await refusal(() => teamLandRequest(x.s.home, x.member), "no_review", new RegExp(`team n4 has no reviewer, so this landing cannot be requested from the owner; the owner lands it in a terminal with hoptell team land ${x.member} --approve ${c.T} ${c.C}`));
});

test("a candidate re-based onto a moved target: a review of the member's own commits does not count; only a review of exactly T..C does", async (t) => {
  let stale = null;
  const x = await preparedSetup(t, {
    beforePrepare: async (y) => {
      // The reviewers reviewed the member's own commits (base..head), then main moved elsewhere.
      const rec = readWorktreeRecord(y.s.home, y.member).rec;
      stale = (await reviewRequest(y.s.home, { team: "n4", base: rec.base, head: rec.head }, { send: async () => "sent" })).review.id;
      await reviewVerdict(y.s.home, { team: "n4", id: stale, reviewer: "dana-n4-rev-1", verdict: "approve" });
      fs.writeFileSync(path.join(y.s.repo, "README.md"), "# moved\n");
      git(y.s.repo, "commit", "-q", "-am", "moved");
    },
  });
  assert.equal(x.c.rebased, true);
  assert.equal(x.c.T, git(x.s.repo, "rev-parse", "main"));
  await x.evidence();
  await refusal(() => x.request(), "no_review", new RegExp(`--base ${x.c.T} --head ${x.c.C}`));
  await x.review("approve");
  const r = await x.request();
  assert.equal(r.C, x.c.C);
  assert.notEqual(r.evidence?.review?.id ?? null, stale);
});

test("the lead prepares, records the tests and asks; the owner decides L<n> in one visit with team approve", async (t) => {
  const x = await preparedSetup(t);
  // --prepare stopped the member (never started here) and made the signed candidate.
  assert.match(git(x.s.repo, "log", "-1", "--format=%G? %s", x.c.C), /^[GU] Land the change$/);
  assert.equal(x.c.stopped, "not started");
  // What --request-approval needs: evidence for exactly C, then a review that every reviewer answered.
  await refusal(() => x.request(), "no_evidence", /no test evidence is recorded for the candidate \w+; record it with hoptell team evidence dana-n4-impl-1 --candidate \w+ --tests pass\|fail --command <command> --report <file>/);
  await refusal(() => x.evidence({ C: x.c.T }), "not_candidate", /is not dana-n4-impl-1's current candidate/);
  await refusal(() => x.evidence({ tests: "maybe" }), "bad_tests");
  await refusal(() => x.evidence({ commands: [] }), "bad_command");
  fs.writeFileSync(path.join(x.s.root, "bin.txt"), Buffer.from([0x61, 0, 0x62]));
  await refusal(() => x.evidence({ report: path.join(x.s.root, "bin.txt") }), "bad_report", /is not UTF-8 text/);
  fs.writeFileSync(path.join(x.s.root, "big.txt"), "x".repeat(64 * 1024 + 1));
  await refusal(() => x.evidence({ report: path.join(x.s.root, "big.txt") }), "bad_report", /larger than 65536 bytes/);
  const lines = await x.cli(["evidence", x.member, "--candidate", x.c.C, "--tests", "pass", "--command", "npm test", "--command", "npm run lint", "--report", x.report]);
  assert.match(lines.at(-1), /^Recorded for dana-n4-impl-1's candidate \w+: tests pass \(2 commands\), report \w{12} \(12 bytes\)\.$/);
  await refusal(() => x.request(), "no_review", /hoptell review request --team n4 --base \w+ --head \w+/);
  const r = await reviewRequest(x.s.home, { team: "n4", base: x.c.T, head: x.c.C }, { send: async () => "sent" });
  await refusal(() => x.request(), "review_incomplete", /the review rv-\w+ of the candidate waits for dana-n4-rev-1/);
  await reviewVerdict(x.s.home, { team: "n4", id: r.review.id, reviewer: "dana-n4-rev-1", verdict: "approve" });
  const asked = await x.cli(["land", x.member, "--request-approval"]);
  assert.match(asked[0], /^Landing L1: \w+ on main \(at \w+\), checked out in .*repo; tests pass, review rv-\w+: dana-n4-rev-1 approve\.$/);
  assert.match(asked[1], /^The owner decides it in a terminal before .*: hoptell team approve L1$/);
  const st = readState(x.s.home, "n4");
  assert.deepEqual(st.actions.map((a) => [a.id, a.state, a.route]), [["L1", "ready", null]]);
  assert.match((await x.cli(["status", "n4"])).join("\n"), /the landing L1 waits for the owner's decision: hoptell team approve L1 \(in a terminal\)/);
  // The lead cannot decide it: the evidence is shown, then the owner's step refuses.
  const shown = await x.cli(["approve", "L1"]).catch((e) => e);
  assert.match(shown.message, /landing is the owner's step: run hoptell team approve L1 in a terminal/);
  const view = shown.lines.join("\n");
  assert.match(view, /^Landing L1 of dana-n4-impl-1 \(team n4\) in .*repo$/m);
  assert.match(view, /^ {2}target {5}main, checked out in .*repo \(fast-forwarded there\)$/m);
  assert.match(view, /^ {2}subject {4}Land the change$/m);
  assert.match(view, /^ {2}tests {6}pass \(the lead's report \w{12}, 12 bytes\): npm test; npm run lint$/m);
  assert.match(view, /^ {2}patch {6}\d+ bytes: hoptell team approve L1 --show-diff prints it$/m);
  assert.match(view, /lib\/x\.js \| 2 \+-/);
  assert.match(view, /The test result and the verdicts come from agents: they are claims, not proof\./);
  assert.doesNotMatch(view, /You may still land it/);
  assert.equal(readState(x.s.home, "n4").actions[0].state, "ready", "showing decides nothing");
  const diff = (await x.cli(["approve", "L1", "--show-diff"])).join("\n");
  assert.match(diff, /^diff --git a\/lib\/x\.js b\/lib\/x\.js$/m);
  assert.match(diff, /^\+2$/m);
  // Not confirmed: nothing moves.
  await assert.rejects(x.cli(["approve", "L1"], { tty: true, answer: "no" }), /not confirmed; nothing was landed/);
  assert.equal(refOf(x.s.repo, "main"), x.c.T);
  // Typed land: decided and applied in the same command.
  const landed = await x.cli(["approve", "L1"], { tty: true });
  assert.match(landed.join("\n"), /^Landed \w+ on main \(was \w+\), landing L1\.$/m);
  assert.equal(refOf(x.s.repo, "main"), x.c.C);
  assert.equal(git(x.s.repo, "status", "--porcelain", "--untracked-files=no"), "");
  const end = readTombstone(x.s.home, "n4", "L1");
  assert.deepEqual([end.state, end.route], ["finished", "terminal"]);
  const after = readState(x.s.home, "n4");
  assert.deepEqual([after.actions, after.candidate, after.evidence, after.landed.length], [[], null, null, 1]);
  await refusal(() => teamApproveView(x.s.home, "L1"), "action_gone", /the landing L1 already ended \(finished\)/);
});

test("evidence and requests are for exactly one candidate: new evidence, a later verdict or a new request supersede a decision that did not start; --discard clears the evidence", async (t) => {
  const x = await preparedSetup(t, { checkout: false });
  await x.evidence();
  const rv = await x.review("approve");
  const one = await x.request();
  assert.deepEqual([one.id, one.mode.kind], ["L1", "ref"]);
  // A new request supersedes the earlier one.
  const two = await x.request();
  assert.deepEqual([two.id, two.superseded], ["L2", "L1"]);
  assert.match(readTombstone(x.s.home, "n4", "L1").reason, /a new approval was requested/);
  // New evidence for the same C supersedes the decision waiting for the owner.
  const ev = await x.evidence({ tests: "fail" });
  assert.equal(ev.superseded, "L2");
  assert.equal(readTombstone(x.s.home, "n4", "L2").state, "superseded");
  // A later verdict of the review frozen in a request supersedes it.
  const three = await x.request();
  assert.equal(three.evidence.tests.result, "fail");
  await reviewVerdict(x.s.home, { team: "n4", id: rv, reviewer: "dana-n4-rev-1", verdict: "changes" });
  assert.match(readTombstone(x.s.home, "n4", three.id).reason, /a later verdict \(dana-n4-rev-1 changes\)/);
  assert.deepEqual(readState(x.s.home, "n4").actions, []);
  await refusal(() => teamApproveView(x.s.home, three.id), "action_gone", /already ended \(superseded: a later verdict/);
  // The frozen evidence is what the manifest holds, whatever the report file says now.
  fs.writeFileSync(x.report, "changed afterwards\n");
  const four = await x.request();
  assert.equal(four.evidence.tests.report, "ok 12 tests\n");
  assert.equal(four.evidence.review.verdicts[0].verdict, "changes");
  // --discard drops the candidate, its evidence and the waiting decision; a new --prepare starts clean.
  await teamLandDiscard(x.s.home, x.member);
  const st = readState(x.s.home, "n4");
  assert.deepEqual([st.candidate, st.evidence, st.actions], [null, null, []]);
  await refusal(() => teamEvidence(x.s.home, x.member, { C: x.c.C, tests: "pass", commands: ["npm test"], report: x.report }), "no_candidate", /prepare one with hoptell team land dana-n4-impl-1 --target <branch> -m <message> --prepare/);
  // The lead prepares again, without a terminal; the text says what the signature is not.
  const again = await x.cli(["land", x.member, "--target", "main", "-m", "Again", "--prepare"]);
  assert.equal(again[0], "dana-n4-impl-1: not started.");
  assert.match(again.join("\n"), /The signature shows the candidate was made with your key; it is not your decision\./);
  assert.match(again.join("\n"), /then ask the owner: hoptell team land dana-n4-impl-1 --request-approval$/);
  assert.equal(readState(x.s.home, "n4").evidence, null);
  // Without --prepare it stays the owner's step on a terminal.
  await assert.rejects(x.cli(["land", x.member, "--target", "main", "-m", "Again"]), /landing is the owner's step: run hoptell team land in a terminal/);
  // An id in two teams refuses.
  fs.mkdirSync(path.join(x.s.home, "teams", "n5", "landings", four.id), { recursive: true });
  await refusal(() => teamApproveView(x.s.home, four.id), "ambiguous_action", /exists in several teams \(n4, n5\)/);
});

test("an expired request lands nothing: team approve says what to do, and a new request works (acceptance row 2)", async (t) => {
  const x = await preparedSetup(t);
  await x.evidence();
  await x.review("approve");
  let now = Date.now();
  const clock = { now: () => now };
  const one = await x.request(clock);
  // Expired before it is shown: ended (its tombstone), with the lead's command, nothing a shell would run as a comment.
  now += 16 * MIN;
  await refusal(() => teamApproveView(x.s.home, one.id, clock), "action_expired", new RegExp(`^L1 expired at ${one.expires.replace(/[.]/g, "\\.")}; nothing was moved\\. Ask the lead to run hoptell team land dana-n4-impl-1 --request-approval again$`));
  assert.equal(readTombstone(x.s.home, "n4", "L1").state, "expired");
  assert.equal(refOf(x.s.repo, "main"), x.c.T);
  // Expired between the view and the decision: the same text, nothing moved, no new action made.
  const two = await x.request(clock);
  const view = await teamApproveView(x.s.home, two.id, clock);
  now += 16 * MIN;
  await refusal(() => teamLandApprove(x.s.home, x.member, { T: view.manifest.T, C: view.manifest.C, homedir: x.s.homedir, actionId: two.id }, clock), "action_expired", /^L2 expired at .*; nothing was moved\. Ask the lead to run hoptell team land dana-n4-impl-1 --request-approval again$/);
  assert.deepEqual(readState(x.s.home, "n4").actions, []);
  assert.equal(refOf(x.s.repo, "main"), x.c.T);
  assert.equal(readTombstone(x.s.home, "n4", "L2").state, "expired");
  // A decision for an action that is gone does not land another one.
  await refusal(() => teamLandApprove(x.s.home, x.member, { T: x.c.T, C: x.c.C, homedir: x.s.homedir, actionId: "L2" }), "action_gone");
  // A new request lands.
  const three = await x.request();
  const r = await teamLandApprove(x.s.home, x.member, { T: x.c.T, C: x.c.C, homedir: x.s.homedir, actionId: three.id });
  assert.deepEqual([r.id, refOf(x.s.repo, "main")], ["L3", x.c.C]);
});

test("an oversize patch stays marked unavailable, a patch full of escapes too; failed tests and \"changes\" are shown apart from hard safety refusals (acceptance row 3)", async (t) => {
  // Over the inline bound: a 200 KiB file.
  {
    const x = await preparedSetup(t, { change: (wt) => fs.writeFileSync(path.join(wt, "big.txt"), `${"0123456789abcdef".repeat(4096)}\n`.repeat(3)) });
    await x.evidence({ tests: "fail" });
    await x.review("changes");
    const r = await x.request();
    assert.deepEqual([r.evidence.patch.oversize, r.evidence.patch.text, r.evidence.patch.encoding], [true, null, null]);
    assert.ok(r.evidence.patch.bytes > 64 * 1024);
    assert.match(r.evidence.patch.digest, /^[0-9a-f]{64}$/);
    const view = (await x.cli(["approve", r.id]).catch((e) => e)).lines.join("\n");
    assert.match(view, /^ {2}patch {6}\d+ bytes: too large to show here; review it on the Mac \(hoptell team approve L1 --show-diff says how\)$/m);
    assert.match(view, /^ {2}tests {6}FAILED /m);
    assert.match(view, /^Note: the lead's tests failed, and dana-n4-rev-1 asked for changes\. You may still land it\.$/m);
    const how = (await x.cli(["approve", r.id, "--show-diff"])).join("\n");
    assert.match(how, /^The patch of L1 \(\d+ bytes\) is too large to keep in its record, so it is not stored inline\. The record: .*landings\/L1\/manifest\.json\. View it with: git -C .*repo diff --no-ext-diff --no-textconv \w+ \w+$/);
    // A hard safety failure is a refusal, not a note: a dirty checkout blocks before the move. The
    // decision came by team approve, so the text asks for a new request, never the manual --approve.
    fs.writeFileSync(path.join(x.s.repo, "lib", "x.js"), "dirty\n");
    const dirty = await x.cli(["approve", r.id], { tty: true }).catch((e) => e);
    assert.match(dirty.message, /main is checked out in .*repo, and it has 1 uncommitted change: lib\/x\.js\. Nothing was moved\. Fix that\. Then ask the lead to run hoptell team land dana-n4-impl-1 --request-approval again, and approve the new id; hoptell then moves it itself$/);
    assert.doesNotMatch(dirty.message, /--approve/);
    assert.equal(refOf(x.s.repo, "main"), x.c.T);
    assert.equal(readTombstone(x.s.home, "n4", r.id).state, "blocked");
    git(x.s.repo, "checkout", "--", "lib/x.js");
    // Two checkouts of the target, the same way.
    const again = await x.request();
    const second = path.join(x.s.root, "second");
    git(x.s.repo, "worktree", "add", "-q", "--force", second, "main");
    await refusal(() => teamLandApprove(x.s.home, x.member, { T: x.c.T, C: x.c.C, homedir: x.s.homedir, actionId: again.id }), "land_blocked", /main is checked out in 2 worktrees \(.*\); hoptell moves a checked-out target only when exactly one worktree has it\. Nothing was moved\. Switch all but one to another branch\. Then ask the lead to run hoptell team land dana-n4-impl-1 --request-approval again, and approve the new id$/);
    git(x.s.repo, "worktree", "remove", second);
    // The manual route keeps its own command.
    fs.writeFileSync(path.join(x.s.repo, "lib", "x.js"), "dirty\n");
    await refusal(() => teamLandApprove(x.s.home, x.member, { T: x.c.T, C: x.c.C, homedir: x.s.homedir }), "land_blocked", /Nothing was moved\. Fix that, then run the same hoptell team land dana-n4-impl-1 --approve \w+ \w+ again; hoptell then moves it itself$/);
    assert.equal(refOf(x.s.repo, "main"), x.c.T);
  }
  // Under the inline bound, but its canonical JSON is not: control characters escape six-fold.
  {
    const x = await preparedSetup(t, { checkout: false, change: (wt) => fs.writeFileSync(path.join(wt, "ctl.txt"), `${"\u0001".repeat(100)}\n`.repeat(300)) });
    await x.evidence();
    await x.review("approve");
    const r = await x.request();
    assert.ok(r.evidence.patch.bytes < 64 * 1024, "the raw patch fits the inline bound");
    assert.deepEqual([r.evidence.patch.oversize, r.evidence.patch.text], [true, null]);
    const m = fs.readFileSync(path.join(x.s.home, "teams", "n4", "landings", r.id, "manifest.json"));
    assert.ok(m.length <= MANIFEST_FIT, `the manifest is ${m.length} bytes`);
    // Landing does not depend on the patch being inline.
    const done = await teamLandApprove(x.s.home, x.member, { T: x.c.T, C: x.c.C, homedir: x.s.homedir, actionId: r.id });
    assert.equal(done.C, x.c.C);
  }
});

test("the patch is streamed: one over the inline bound is counted and hashed whole, kept out of the record, and the owner route still lands", async (t) => {
  const x = await preparedSetup(t, { checkout: false });
  await x.evidence();
  await x.review("approve");
  // A small bound stands in for a patch of any size (one over git's output limit included).
  const r = await x.request({ inlineMax: 100 });
  const full = execFileSync("git", ["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--binary", "--full-index", x.c.T, x.c.C, "--"], { cwd: x.s.repo, env: gitEnv });
  assert.ok(full.length > 100);
  const p = r.evidence.patch;
  assert.deepEqual([p.oversize, p.text, p.encoding, p.bytes, p.digest], [true, null, null, full.length, crypto.createHash("sha256").update(full).digest("hex")], "the digest and the size are of the complete patch");
  assert.deepEqual(readState(x.s.home, "n4").actions.map((a) => [a.id, a.state]), [[r.id, "ready"]]);
  const landed = await x.cli(["approve", r.id], { tty: true });
  assert.match(landed.join("\n"), /^Landed \w+ on main \(was \w+\), landing L1\.$/m);
  assert.equal(refOf(x.s.repo, "main"), x.c.C);
  // At the bound it stays inline, whole.
  const y = await preparedSetup(t, { checkout: false });
  await y.evidence();
  await y.review("approve");
  const whole = execFileSync("git", ["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--binary", "--full-index", y.c.T, y.c.C, "--"], { cwd: y.s.repo, env: gitEnv });
  const at = await y.request({ inlineMax: whole.length });
  assert.deepEqual([at.evidence.patch.oversize, at.evidence.patch.text, at.evidence.patch.bytes], [false, whole.toString("utf8"), whole.length]);
});

// ---- the owner decides on Telegram (design 8 addendum, option 3; L3a) ------------------------------

const REALM_ID = "0123456789abcdef0123456789abcdef";
const OWN_MEMBER = `m_${"a".repeat(26)}`;

/** A bridge connection as bin/hoptell.js gives it to teamCommand: what was sent, in order. */
function fakeBridge(sent, { problem = null, why = undefined, failSend = false, caps = ["landing"], ack = "delivered" } = {}) {
  const send = async (text) => {
    if (failSend) throw new Error("relay did not answer in time");
    sent.push(text);
    return { state: ack };
  };
  return async () => (problem ? { problem, ...(why ? { why } : {}) } : { realm: REALM_ID, member: OWN_MEMBER, caps, send, close: () => {} });
}

/** The bridge's signed decision for `m` (the original bytes the lead's engine keeps). */
function decisionFor(key, m, { decision = "land", decidedAt = Date.now() } = {}) {
  const text = decisionText({ id: m.id, digest: crypto.createHash("sha256").update(canonicalize(m)).digest("hex"), decision, decidedAt, expiresAt: Date.parse(m.expires_at) });
  return ownersig.signEnvelope({ kind: "landing_decision", realm: REALM_ID, from: "dana-owner", to: { name: m.recipient.lead, member: m.recipient.member }, q: crypto.randomUUID(), text, pairing: { id: "p_abcdefghijklmnop", at: 1_700_000_000_000 }, ts: decidedAt, nonce: crypto.randomBytes(32).toString("base64url") }, key);
}
/** What the lead's engine does with a verified decision: keep its bytes as the action's receipt. */
const ingest = (home, bytes, me, opts) => ingestLandingDecision(home, ownersig.parseEnvelope(bytes).env, bytes, me, opts);

async function telegramSetup(t, opts = {}) {
  const x = await preparedSetup(t, opts);
  await x.evidence();
  await x.review("approve");
  const key = ownersig.newKey();
  ownersig.trustPin(x.s.home, ownersig.formatPin({ realm: REALM_ID, name: "dana-owner", pub: key.pub }));
  const lead = readState(x.s.home, "n4").lead;
  return { ...x, key, lead, me: { name: lead, member: OWN_MEMBER } };
}

test("a request sent to the owner's Telegram: the lead's session is its recipient; apply verifies the kept decision, lands, and reports back", async (t) => {
  const x = await telegramSetup(t);
  const sent = [];
  const asked = await x.cli(["land", x.member, "--request-approval"], { deps: { landingChannel: fakeBridge(sent) } });
  assert.match(asked[0], /^Landing L1: /);
  assert.match(asked[1], /^Sent to the owner's Telegram\. The owner decides it there, or in a terminal \(hoptell team approve L1\), before .*\.$/);
  assert.equal(asked[2], "When the owner's decision arrives in your inbox, run: hoptell team apply L1");
  // One message: the manifest as made, with this realm, the own member and the lead's session.
  assert.equal(sent.length, 1);
  const req = parseLandingRequest(sent[0]);
  const a = readState(x.s.home, "n4").actions[0];
  assert.equal(req.digest, a.digest);
  // The recipient names the team's revocation generation: the bridge offers auto-land with it.
  assert.deepEqual(req.manifest.recipient, { realm: REALM_ID, member: OWN_MEMBER, lead: x.lead, generation: 0 });
  assert.equal(req.auto, null, "no grant was active: nothing to explain");
  assert.equal(req.manifest.realm, REALM_ID);
  // No decision yet.
  await assert.rejects(x.cli(["apply", "L1"]), /the owner has not decided L1 yet \(it expires at .*\); its decision arrives in this session's inbox/);
  // A decision kept for another session, or for another digest, is not kept.
  const other = structuredClone(req.manifest);
  other.recipient.lead = "dana-elsewhere";
  assert.match((await ingest(x.s.home, decisionFor(x.key, other), { name: "dana-elsewhere", member: OWN_MEMBER })).problem, /changed since it was made|not requested for this session/);
  assert.match((await ingest(x.s.home, decisionFor(x.key, req.manifest), { name: "dana-elsewhere", member: OWN_MEMBER })).problem, /not requested for this session/);
  // The first decision kept wins; the same bytes again are the same.
  const bytes = decisionFor(x.key, req.manifest);
  assert.deepEqual(await ingest(x.s.home, bytes, x.me), { id: "L1", team: "n4", decision: "land", result: "stored", kept: "land", by: "telegram" });
  assert.equal((await ingest(x.s.home, bytes, x.me)).result, "same");
  assert.deepEqual(((r) => [r.result, r.kept])(await ingest(x.s.home, decisionFor(x.key, req.manifest, { decision: "reject" }), x.me)), ["conflict", "land"]);
  assert.equal(refOf(x.s.repo, "main"), x.c.T, "keeping a decision moves nothing");
  // A team member's session cannot apply it.
  await assert.rejects(x.cli(["apply", "L1"], { env: { HOPTELL_TEAM_MEMBER: "implementer:n4" } }), /carrying out the owner's landing decision is the lead's step/);
  const out = await x.cli(["apply", "L1"], { deps: { landingChannel: fakeBridge(sent) } });
  assert.match(out.join("\n"), /^Landed \w+ on main \(was \w+\), landing L1\.$/m);
  assert.match(out.join("\n"), /^The owner's Telegram card shows it as landed\.$/m);
  assert.equal(refOf(x.s.repo, "main"), x.c.C);
  const end = readTombstone(x.s.home, "n4", "L1");
  assert.deepEqual([end.state, end.route, end.decision], ["finished", "bridge", crypto.createHash("sha256").update(bytes).digest("hex")]);
  assert.deepEqual(parseLandingStatus(sent.at(-1)), { digest: a.digest, state: "landed", text: "L1 landed on main." });
  // Again: nothing more happens, and the card hears it again (a retry after "notice pending").
  const again = await x.cli(["apply", "L1"], { deps: { landingChannel: fakeBridge(sent) } }).catch((e) => e);
  assert.match(again.message, /the landing L1 already ended \(finished\); nothing was changed/);
  assert.equal(sent.length, 3);
});

test("apply of a reject ends the action as rejected; a failed report is only 'notice pending'", async (t) => {
  const x = await telegramSetup(t, { checkout: false });
  const sent = [];
  await x.cli(["land", x.member, "--request-approval"], { deps: { landingChannel: fakeBridge(sent) } });
  const m = parseLandingRequest(sent[0]).manifest;
  await ingest(x.s.home, decisionFor(x.key, m, { decision: "reject", decidedAt: Date.now() }), x.me);
  const warned = [];
  const out = await x.cli(["apply", "L1"], { warned, deps: { landingChannel: fakeBridge(sent, { failSend: true }) } });
  assert.deepEqual(out, ["The owner rejected L1 on Telegram; it ended as rejected. Nothing was moved."]);
  assert.match(warned.join("\n"), /^notice pending: the owner's Telegram card was not updated \(relay did not answer in time\); run hoptell team apply L1 again to retry$/);
  assert.equal(refOf(x.s.repo, "main"), x.c.T);
  const end = readTombstone(x.s.home, "n4", "L1");
  assert.deepEqual([end.state, end.route, end.reason], ["rejected", "bridge", "the owner rejected it on Telegram"]);
  assert.deepEqual(readState(x.s.home, "n4").actions, []);
});

test("apply after the window: a decision tapped in time but applied too late ends the action as expired; nothing moves", async (t) => {
  const x = await telegramSetup(t, { checkout: false });
  const sent = [];
  await x.cli(["land", x.member, "--request-approval"], { deps: { landingChannel: fakeBridge(sent) } });
  const m = parseLandingRequest(sent[0]).manifest;
  // Tapped at minute 14: applied at minute 28 still works, at minute 30 it does not.
  const tap = Date.parse(m.created_at) + 14 * 60_000;
  await ingest(x.s.home, decisionFor(x.key, m, { decidedAt: tap }), x.me);
  const late = await x.cli(["apply", "L1"], { deps: { now: () => tap + APPLY_WINDOW_MS + 1 } }).catch((e) => e);
  assert.match(late.message, /^the owner's decision for L1 is older than 15 minutes; nothing was moved\. Run hoptell team land dana-n4-impl-1 --request-approval again$/);
  assert.equal(refOf(x.s.repo, "main"), x.c.T);
  assert.equal(readTombstone(x.s.home, "n4", "L1").state, "expired");
  // Within the window, past the request's own expiry: it lands.
  const y = await telegramSetup(t, { checkout: false });
  const sent2 = [];
  await y.cli(["land", y.member, "--request-approval"], { deps: { landingChannel: fakeBridge(sent2) } });
  const m2 = parseLandingRequest(sent2[0]).manifest;
  const tap2 = Date.parse(m2.created_at) + 14 * 60_000;
  await ingest(y.s.home, decisionFor(y.key, m2, { decidedAt: tap2 }), y.me);
  const ok = await y.cli(["apply", "L1"], { deps: { now: () => tap2 + APPLY_WINDOW_MS - 1000 } });
  assert.match(ok.join("\n"), /^Landed \w+ on main \(was \w+\), landing L1\.$/m);
  assert.equal(refOf(y.s.repo, "main"), y.c.C);
});

test("without a bridge that takes landing requests: the terminal route, with the update hint; a member's session cannot ask", async (t) => {
  const x = await telegramSetup(t, { checkout: false });
  const warned = [];
  const out = await x.cli(["land", x.member, "--request-approval"], { warned, deps: { landingChannel: fakeBridge([], { problem: "the bridge does not take landing requests" }) } });
  assert.deepEqual(warned, ["landing approval needs a bridge update; use hoptell team approve in a terminal"]);
  assert.match(out.at(-1), /^The owner decides it in a terminal before .*: hoptell team approve L1$/);
  const st = readState(x.s.home, "n4");
  assert.deepEqual(st.actions.map((a) => a.state), ["ready"], "the action stays ready");
  await assert.rejects(x.cli(["apply", "L1"]), /the landing L1 was not sent to the owner's Telegram; the owner decides it in a terminal: hoptell team approve L1/);
  // No owner channel at all: the terminal route, without the hint.
  const quiet = [];
  await x.cli(["land", x.member, "--request-approval"], { warned: quiet, deps: { landingChannel: async () => null } });
  assert.deepEqual(quiet, []);
  // A send that fails: the terminal route, and why.
  const failed = [];
  const f = await x.cli(["land", x.member, "--request-approval"], { warned: failed, deps: { landingChannel: fakeBridge([], { failSend: true }) } });
  assert.match(failed[0], /^The request could not be sent to the owner's Telegram \(relay did not answer in time\)\.$/);
  assert.match(f.at(-1), /^The owner decides it in a terminal before .*: hoptell team approve L3$/);
  // A relay that lists no statuses, and a bridge that is offline, are told apart from an old bridge.
  for (const why of ["relay", "offline"]) await x.cli(["land", x.member, "--request-approval"], { warned, deps: { landingChannel: fakeBridge([], { problem: "x", why }) } });
  assert.deepEqual(warned.slice(1), ["landing approval needs a relay update (hoptell 0.4.0 or later on the relay); use hoptell team approve in a terminal", "the owner's Telegram bridge is offline, so the request was not sent there; use hoptell team approve in a terminal"]);
  await assert.rejects(x.cli(["land", x.member, "--request-approval"], { env: { HOPTELL_TEAM_MEMBER: "implementer:n4" } }), /asking the owner for a landing is the lead's step/);
});

/** A request sent to Telegram, with the owner's decision on it already kept by the lead's engine. */
async function decidedOnTelegram(t, decision, opts = { checkout: false }) {
  const x = await telegramSetup(t, opts);
  const sent = [];
  await x.cli(["land", x.member, "--request-approval"], { deps: { landingChannel: fakeBridge(sent) } });
  const m = parseLandingRequest(sent[0]).manifest;
  const bytes = decisionFor(x.key, m, { decision });
  return { ...x, sent, m, bytes, keep: () => ingest(x.s.home, bytes, x.me) };
}
const moves = (repo) => git(repo, "reflog", "show", "refs/heads/main", "--format=%gs").split("\n").filter((l) => l.includes("hoptell team land")).length;

test("one decision per action: a Reject kept from Telegram stops team approve, an open terminal prompt and the manual --approve", async (t) => {
  // Kept before the owner opens the terminal.
  const a = await decidedOnTelegram(t, "reject");
  await a.keep();
  const shown = await a.cli(["approve", "L1"], { tty: true }).catch((e) => e);
  assert.match(shown.message, /^the owner rejected L1 on Telegram, so it ended as rejected; nothing was moved\. A different decision needs a new landing: ask the lead to run hoptell team land dana-n4-impl-1 --request-approval again$/);
  assert.equal(refOf(a.s.repo, "main"), a.c.T);
  assert.deepEqual(((e) => [e.state, e.route, e.decision])(readTombstone(a.s.home, "n4", "L1")), ["rejected", "bridge", crypto.createHash("sha256").update(a.bytes).digest("hex")]);
  // Kept while the terminal prompt is open: the typed land finds it under the lock.
  const b = await decidedOnTelegram(t, "reject");
  const open = await b.cli(["approve", "L1"], { tty: true, deps: { ask: async () => (await b.keep(), "land") } }).catch((e) => e);
  assert.match(open.message, /^the owner rejected L1 on Telegram, so it ended as rejected; nothing was moved/);
  assert.equal(refOf(b.s.repo, "main"), b.c.T);
  assert.equal(readTombstone(b.s.home, "n4", "L1").state, "rejected");
  // The manual route on the same action: rejected too; deciding it again is a new action.
  const c = await decidedOnTelegram(t, "reject");
  await c.keep();
  const manual = await c.cli(["land", c.member, "--approve", c.c.T, c.c.C], { tty: true }).catch((e) => e);
  assert.match(manual.message, /^the owner rejected L1 on Telegram, so it ended as rejected; nothing was moved\. A different decision needs a new landing: run the same command again$/);
  assert.equal(refOf(c.s.repo, "main"), c.c.T);
  const again = await c.cli(["land", c.member, "--approve", c.c.T, c.c.C], { tty: true });
  assert.match(again.join("\n"), /^Landed \w+ on main \(was \w+\), landing L2\.$/m);
  assert.equal(moves(c.s.repo), 1);
});

test("one decision per action: a Land kept from Telegram is shown as decided by team approve, and the manual --approve lands it by that route", async (t) => {
  const x = await decidedOnTelegram(t, "land");
  await x.keep();
  const out = await x.cli(["approve", "L1"], { tty: true, deps: { ask: async () => assert.fail("no prompt for a decided landing") } });
  assert.equal(out.at(-1), "L1 is decided on Telegram: land. The lead applies it (hoptell team apply L1); nothing more is needed here.");
  assert.equal(refOf(x.s.repo, "main"), x.c.T);
  const manual = await x.cli(["land", x.member, "--approve", x.c.T, x.c.C], { tty: true });
  assert.match(manual.join("\n"), /^Landed \w+ on main \(was \w+\), landing L1\.$/m);
  assert.deepEqual(((e) => [e.state, e.route])(readTombstone(x.s.home, "n4", "L1")), ["finished", "bridge"]);
});

test("a Land tapped late but kept in its apply window: viewing it at minute 20 does not expire it and the lead's apply lands it; past the window, viewing ends it as expired", async (t) => {
  const x = await telegramSetup(t, { checkout: false });
  const sent = [];
  await x.cli(["land", x.member, "--request-approval"], { deps: { landingChannel: fakeBridge(sent) } });
  const m = parseLandingRequest(sent[0]).manifest;
  const tap = Date.parse(m.created_at) + 14 * 60_000;
  await ingest(x.s.home, decisionFor(x.key, m, { decidedAt: tap }), x.me);
  const at20 = { now: () => Date.parse(m.created_at) + 20 * 60_000 };
  assert.equal((await x.cli(["approve", "L1"], { tty: true, deps: at20 })).at(-1), "L1 is decided on Telegram: land. The lead applies it (hoptell team apply L1); nothing more is needed here.");
  assert.match((await x.cli(["approve", "L1", "--show-diff"], { deps: at20 })).join("\n"), /^diff --git /m);
  assert.deepEqual(readState(x.s.home, "n4").actions.map((a) => a.state), ["ready"]);
  const ok = await x.cli(["apply", "L1"], { deps: at20 });
  assert.match(ok.join("\n"), /^Landed \w+ on main \(was \w+\), landing L1\.$/m);
  // Just past the apply window: the view ends it as expired; nothing moves.
  const y = await telegramSetup(t, { checkout: false });
  const sent2 = [];
  await y.cli(["land", y.member, "--request-approval"], { deps: { landingChannel: fakeBridge(sent2) } });
  const m2 = parseLandingRequest(sent2[0]).manifest;
  const tap2 = Date.parse(m2.created_at) + 14 * 60_000;
  await ingest(y.s.home, decisionFor(y.key, m2, { decidedAt: tap2 }), y.me);
  const late = await y.cli(["approve", "L1", "--show-diff"], { deps: { now: () => tap2 + APPLY_WINDOW_MS + 1 } }).catch((e) => e);
  assert.match(late.message, /^the owner's decision on Telegram to land L1 can no longer be applied \(it is older than 15 minutes, or came after the landing expired\); nothing was moved\. Ask the lead to run hoptell team land dana-n4-impl-1 --request-approval again$/);
  assert.deepEqual(((e) => [e.state, e.route])(readTombstone(y.s.home, "n4", "L1")), ["expired", "bridge"]);
  assert.equal(refOf(y.s.repo, "main"), y.c.T);
});

test("the first decision registered wins: a terminal decision is written down before the repository wait, so a Reject that arrives meanwhile is kept out", async (t) => {
  const x = await decidedOnTelegram(t, "reject");
  // The engine takes the team lock to keep a decision: during the terminal's run it is busy (the
  // relay keeps the message and it is tried again later).
  let during = null;
  const out = await x.cli(["approve", "L1"], {
    tty: true,
    deps: {
      ask: async () => "land",
      // The hook is not awaited: the engine's one try for the lock happens here, while it is held.
      beforeMove: () => {
        assert.equal(readState(x.s.home, "n4").actions[0].route, "terminal", "approved by the terminal before the wait");
        during = ingest(x.s.home, x.bytes, x.me, { waitMs: 20 }).catch((e) => e);
      },
    },
  });
  assert.equal((await during)?.code, "busy");
  assert.match(out.join("\n"), /^Landed \w+ on main \(was \w+\), landing L1\.$/m);
  // Tried again after the landing: it ended, so the Reject is not kept.
  assert.deepEqual(await ingest(x.s.home, x.bytes, x.me), { id: "L1", team: "n4", decision: "reject", result: "ended", state: "finished" });
  assert.equal(fs.existsSync(path.join(x.s.home, "teams", "n4", "landings", "L1", "receipt.json")), false);
  // A run that stopped after the terminal registered its decision: the Reject is a conflict.
  const y = await decidedOnTelegram(t, "reject");
  await assert.rejects(y.cli(["approve", "L1"], { tty: true, deps: { ask: async () => "land", beforeMove: () => { throw new Error("crash"); } } }), /crash/);
  assert.deepEqual(await ingest(y.s.home, y.bytes, y.me), { id: "L1", team: "n4", decision: "reject", result: "conflict", by: "terminal", kept: "land" });
  assert.equal(fs.existsSync(path.join(y.s.home, "teams", "n4", "landings", "L1", "receipt.json")), false);
});

test("a kept receipt that cannot be read or does not verify refuses the terminal decision; only its absence lets it go on", async (t) => {
  const x = await decidedOnTelegram(t, "land");
  await x.keep();
  const file = path.join(x.s.home, "teams", "n4", "landings", "L1", "receipt.json");
  fs.chmodSync(file, 0o000);
  t.after(() => fs.rmSync(file, { force: true }));
  const unreadable = await x.cli(["approve", "L1"], { tty: true, deps: { ask: async () => "land" } }).catch((e) => e);
  assert.ok(unreadable instanceof Error, "refused");
  fs.chmodSync(file, 0o600);
  // Another key's signature: it does not verify.
  fs.writeFileSync(file, decisionFor(ownersig.newKey(), x.m));
  const forged = await x.cli(["land", x.member, "--approve", x.c.T, x.c.C], { tty: true }).catch((e) => e);
  assert.match(forged.message, /^the decision kept for L1 does not verify/);
  assert.equal(refOf(x.s.repo, "main"), x.c.T);
  assert.deepEqual(readState(x.s.home, "n4").actions.map((a) => a.state), ["ready"]);
});

test("team apply resumes after a crash: accepted moves once, moving only reads, landed finishes; the apply window no longer counts", async (t) => {
  const crash = () => {
    throw new Error("crash");
  };
  for (const [hook, state] of [["beforeMove", "accepted"], ["afterMove", "moving"], ["afterRecord", "landed"]]) {
    const x = await decidedOnTelegram(t, "land");
    await x.keep();
    await assert.rejects(x.cli(["apply", "L1"], { deps: { [hook]: crash } }), /crash/);
    assert.equal(readState(x.s.home, "n4").actions[0].state, state, hook);
    const late = Date.parse(x.m.created_at) + 60 * 60_000; // far past the request's expiry and the window
    const out = await x.cli(["apply", "L1"], { deps: { now: () => late } });
    assert.match(out.join("\n"), /^Landed \w+ on main \(was \w+\), landing L1\.$/m, hook);
    assert.equal(refOf(x.s.repo, "main"), x.c.C);
    assert.equal(moves(x.s.repo), 1, `${hook}: git moved main once`);
    assert.deepEqual(((e) => [e.state, e.route])(readTombstone(x.s.home, "n4", "L1")), ["finished", "bridge"]);
  }
});

test("team apply after a crash during the move with an unknown outcome: blocked, never moved again, reported as blocked without a claim", async (t) => {
  const x = await decidedOnTelegram(t, "land");
  await x.keep();
  await assert.rejects(x.cli(["apply", "L1"], { deps: { afterMoving: () => { throw new Error("crash"); } } }), /crash/);
  assert.equal(readState(x.s.home, "n4").actions[0].state, "moving");
  const warned = [];
  const r = await x.cli(["apply", "L1"], { warned, deps: { now: () => Date.parse(x.m.created_at) + 60 * 60_000, landingChannel: fakeBridge(x.sent) } }).catch((e) => e);
  assert.match(r.message, /Whether main moved is unknown, so the landing L1 is blocked/);
  assert.equal(refOf(x.s.repo, "main"), x.c.T);
  assert.equal(moves(x.s.repo), 0);
  assert.deepEqual(parseLandingStatus(x.sent.at(-1)), { digest: readState(x.s.home, "n4").actions[0].digest, state: "blocked", text: "L1 is blocked; check its state on the Mac." });
  const again = await x.cli(["apply", "L1"]).catch((e) => e);
  assert.match(again.message, /hoptell team apply does not move it again\. The owner checks it on the Mac \(hoptell team status n4\)$/);
});

// ---- auto-land grants (design 8 addendum, option 6) ---------------------------------------------

const AUTOLAND = ["landing", "autoland"];
/** A grant given in the terminal: team autoland with its typed confirmation. */
const autolandOn = (x, args = ["--target", "main"], deps = {}) => x.cli(["autoland", "n4", ...args], { tty: true, answer: "autoland", deps });
/** A grant as the owner's bridge signs it (landing_grant), kept as the lead's engine will keep it (L3b-2). */
function signedGrant(x, { key = x.key, issued = Date.now(), forMs = 2 * 60 * 60_000, targets = ["main"], maxCount = null, generation = readGrantState(x.s.home, "n4").generation } = {}) {
  const st = readState(x.s.home, "n4");
  const scope = { hoptell_landing_grant: 1, id: newGrantId(), team: "n4", run: st.run, generation, enrolment: st.enrolment, recipient: { lead: st.lead, member: OWN_MEMBER }, targets, issued_at: issued, not_before: issued, expires_at: issued + forMs, max_count: maxCount, op: "land", origin: null };
  const envelope = ownersig.signEnvelope({ kind: "landing_grant", realm: REALM_ID, from: "dana-owner", to: { name: st.lead, member: OWN_MEMBER }, q: crypto.randomUUID(), text: grantText(scope), pairing: { id: "p_abcdefghijklmnop", at: 1_700_000_000_000 }, ts: issued, nonce: crypto.randomBytes(32).toString("base64url") }, key);
  storeGrant(x.s.home, "n4", { source: "telegram", scope, envelope });
  return scope;
}
const grantRow = (x, id) => readGrantState(x.s.home, "n4").grants[id] ?? null;
const onlyGrant = (x) => Object.keys(readGrantState(x.s.home, "n4").grants)[0];
const crash = () => {
  throw new Error("crash");
};

test("auto-land given in a terminal: the lead's request lands at once under it, one slot used, and the owner's Telegram gets a notice instead of a card", async (t) => {
  const x = await telegramSetup(t, { checkout: false });
  await assert.rejects(x.cli(["autoland", "n4", "--target", "main"]), /auto-land is the owner's choice: run hoptell team autoland n4 in a terminal/);
  await assert.rejects(x.cli(["autoland", "n4", "--target", "main"], { tty: true, env: { HOPTELL_TEAM_MEMBER: "lead:n4" } }), /a team member's session cannot change it/);
  await assert.rejects(autolandOn(x, ["--target", "main", "--for", "25h"]), /--for takes a duration of at most 24 hours/);
  await assert.rejects(x.cli(["autoland", "n4", "--target", "main"], { tty: true, answer: "yes" }), /not confirmed; auto-land stays off/);
  const on = await autolandOn(x, ["--target", "main", "--for", "90m", "--count", "3"]);
  assert.equal(on[0], `While auto-land is on, the lead lands reviewed and tested work of team n4 (this run, in ${x.s.repo}) on main without asking you, for 1 h 30 min or 3 landings. The reviewers' verdicts and the lead's test report become the only gate, and both come from agents.`);
  assert.match(on[1], /does not bypass a protected branch.*not a hardware presence check: given here, it is policy only/);
  assert.match(on.at(-1), /^Auto-land is on for team n4 on main until .*, for at most 3 landings\. Turn it off with: hoptell team autoland n4 --off$/);
  const status = await x.cli(["status", "n4"]);
  assert.match(status.join("\n"), /auto-land ON for main: 1 h (29|30) min left, 3 of 3 landings left \(grant g_[a-z2-7]{16}, given in a terminal\); hoptell team autoland n4 --off ends it/);
  const sent = [];
  const out = await x.cli(["land", x.member, "--request-approval"], { deps: { landingChannel: fakeBridge(sent, { caps: AUTOLAND }) } });
  assert.match(out.join("\n"), /The owner's auto-land grant covers main \(1 h (29|30) min left\), so L1 lands now without asking\.\nLanded \w+ on main \(was \w+\), landing L1\./);
  assert.equal(refOf(x.s.repo, "main"), x.c.C);
  assert.equal(moves(x.s.repo), 1);
  const end = readTombstone(x.s.home, "n4", "L1");
  assert.deepEqual([end.state, end.route], ["finished", "grant"]);
  // No card: one notice, landed, with the time left; sent, acknowledged and no longer queued.
  assert.equal(sent.length, 1);
  const n = parseNotice(sent[0]);
  assert.deepEqual([n.id, n.team, n.target, n.state], ["L1", "n4", "main", "landed"]);
  assert.ok(n.left_s > 85 * 60 && n.left_s <= 90 * 60, String(n.left_s));
  assert.deepEqual(grantRow(x, onlyGrant(x)), { status: "active", actions: ["L1"], slots: ["L1"], noticed: ["L1:landed"] });
  assert.deepEqual(readGrantState(x.s.home, "n4").notices, []);
  assert.match(out.at(-1), /^The owner's Telegram was told: L1 landed\.$/);
});

test("the terminal grant is for what the owner was shown: a team started again during the prompt gets nothing", async (t) => {
  const x = await telegramSetup(t, { checkout: false });
  const ask = async () => {
    writeTeam(x.s.home, { ...readState(x.s.home, "n4"), run: "9".repeat(32) });
    return "autoland";
  };
  await assert.rejects(x.cli(["autoland", "n4", "--target", "main"], { tty: true, deps: { ask } }), /^Error: team n4 changed while you confirmed \(it was started again, or its repository changed\); nothing was granted\. Run hoptell team autoland n4 again$/);
  assert.deepEqual(readGrantState(x.s.home, "n4").grants, {});
});

test("auto-land only for reviewed and tested work on its targets: otherwise the request goes to the owner and says why", async (t) => {
  // A "changes" verdict: the card, with the reason.
  const x = await preparedSetup(t, { checkout: false });
  await x.evidence();
  await x.review("changes");
  await autolandOn(x);
  const sent = [];
  const out = await x.cli(["land", x.member, "--request-approval"], { deps: { landingChannel: fakeBridge(sent, { caps: AUTOLAND }) } });
  assert.ok(out.includes("Not auto-landed under the owner's grant: dana-n4-rev-1 asked for changes. The owner decides it."), out.join("\n"));
  assert.deepEqual(parseLandingRequest(sent[0]).auto, ["changes"], "the normal card, with the reason as a code");
  assert.equal(refOf(x.s.repo, "main"), x.c.T);
  assert.deepEqual(readState(x.s.home, "n4").actions.map((a) => [a.state, a.route]), [["ready", null]]);
  // Failed tests: the same.
  const y = await preparedSetup(t, { checkout: false });
  await y.evidence({ tests: "fail" });
  await y.review("approve");
  await autolandOn(y);
  const out2 = await y.cli(["land", y.member, "--request-approval"]);
  assert.ok(out2.includes("Not auto-landed under the owner's grant: the lead's tests failed. The owner decides it."), out2.join("\n"));
  // Another target than the grant's: the request says so.
  const z = await preparedSetup(t, { checkout: false });
  await z.evidence();
  await z.review("approve");
  await autolandOn(z, ["--target", "release,dev"]);
  const out3 = await z.cli(["land", z.member, "--request-approval"]);
  assert.ok(out3.includes("Not auto-landed under the owner's grant: main is not covered by the grant's targets (dev, release). The owner decides it."), out3.join("\n"));
  assert.equal(refOf(z.s.repo, "main"), z.c.T);
});

test("auto-land off is a new revocation generation: every earlier grant is dead, also one signed by a bridge whose clock runs ahead and delivered after the --off", async (t) => {
  const x = await telegramSetup(t, { checkout: false });
  await autolandOn(x);
  // Signed before the --off by a bridge clock 3 minutes ahead (so dated after it), kept only after it.
  const g0 = readGrantState(x.s.home, "n4").generation;
  const off = await x.cli(["autoland", "n4", "--off"]);
  assert.equal(off[0], "Auto-land is off for team n4 (1 grant revoked). The lead asks you again for every landing. This also covers every grant you gave on Telegram before now that this Mac has not received yet; give a new one if you want auto-land again.");
  const ahead = signedGrant(x, { issued: Date.now() + 3 * 60_000, generation: g0 });
  const sent = [];
  const out = await x.cli(["land", x.member, "--request-approval"], { deps: { landingChannel: fakeBridge(sent, { caps: AUTOLAND }) } });
  assert.ok(!out.join("\n").includes("lands now"), out.join("\n"));
  assert.ok(parseLandingRequest(sent[0]), "the normal card");
  assert.equal(readGrantState(x.s.home, "n4").grants[ahead.id].status, "revoked");
  // A new grant, of the new generation, works; the revoked ones stay revoked.
  const fresh = signedGrant(x);
  assert.equal(fresh.generation, g0 + 1);
  const out2 = await x.cli(["land", x.member, "--request-approval"]);
  assert.match(out2.join("\n"), /so L2 lands now without asking/);
  assert.equal(readGrantState(x.s.home, "n4").grants[ahead.id].status, "revoked");
});

test("an auto-landing that stopped after its slot was reserved: a revocation, team down or the grant's expiry still stop it before the move; a resume never takes a second slot", async (t) => {
  // Count 1, stopped after acceptance, then --off: team apply ends it; nothing moves.
  const x = await telegramSetup(t, { checkout: false });
  await autolandOn(x, ["--target", "main", "--count", "1"]);
  await assert.rejects(x.cli(["land", x.member, "--request-approval"], { deps: { beforeMove: crash } }), /crash/);
  assert.equal(readState(x.s.home, "n4").actions[0].state, "accepted");
  const gid = onlyGrant(x);
  assert.deepEqual(grantRow(x, gid).slots, ["L1"]);
  await x.cli(["autoland", "n4", "--off"]);
  const sent = [];
  const r = await x.cli(["apply", "L1"], { deps: { landingChannel: fakeBridge(sent, { caps: AUTOLAND }) } }).catch((e) => e);
  assert.match(r.message, /^the owner turned auto-land off \(the grant g_[a-z2-7]{16} is revoked\) before the move, so the landing L1 ended; nothing was moved\./);
  assert.equal(moves(x.s.repo), 0);
  assert.deepEqual(((e) => [e.state, e.route])(readTombstone(x.s.home, "n4", "L1")), ["rejected", "grant"]);
  assert.deepEqual(grantRow(x, gid).slots, ["L1"]);
  assert.deepEqual([parseNotice(sent.at(-1)).state, parseNotice(sent.at(-1)).left_s], ["rejected", null]);
  // Count 1, stopped after acceptance, then the team is down: the same.
  const d = await telegramSetup(t, { checkout: false });
  await autolandOn(d, ["--target", "main", "--count", "1"]);
  await assert.rejects(d.cli(["land", d.member, "--request-approval"], { deps: { beforeMove: crash } }), /crash/);
  writeTeam(d.s.home, { ...readState(d.s.home, "n4"), status: "down" });
  const rd = await d.cli(["apply", "L1"]).catch((e) => e);
  assert.match(rd.message, /^the auto-land grant g_[a-z2-7]{16} was for an earlier run of team n4 before the move, so the landing L1 ended; nothing was moved\./);
  assert.equal(moves(d.s.repo), 0);
  // A slot reserved before the acceptance (a run stopped in between), retried after the grant expired: ended, nothing moved.
  const e = await telegramSetup(t, { checkout: false });
  await autolandOn(e, ["--target", "main", "--count", "1", "--for", "30m"]);
  await e.request();
  const ge = onlyGrant(e);
  const st = readGrantState(e.s.home, "n4");
  st.grants[ge].slots.push("L1");
  st.grants[ge].status = "exhausted";
  writeGrantState(e.s.home, "n4", st);
  const re = await e.cli(["apply", "L1"], { deps: { now: () => Date.now() + 31 * 60_000 } }).catch((err) => err);
  assert.match(re.message, /^the auto-land grant g_[a-z2-7]{16} expired, so the landing L1 was not auto-landed and ended; nothing was moved\./);
  assert.equal(readTombstone(e.s.home, "n4", "L1").state, "expired");
  assert.equal(moves(e.s.repo), 0);
  // Not revoked: an accepted one resumes with the same slot, once, even past the grant's expiry.
  const y = await telegramSetup(t, { checkout: false });
  await autolandOn(y, ["--target", "main", "--count", "1", "--for", "30m"]);
  await assert.rejects(y.cli(["land", y.member, "--request-approval"], { deps: { beforeMove: crash } }), /crash/);
  const gy = onlyGrant(y);
  const out = await y.cli(["apply", "L1"], { deps: { now: () => Date.now() + 60 * 60_000 } });
  assert.match(out.join("\n"), /^Landed \w+ on main \(was \w+\), landing L1\.$/m);
  assert.equal(moves(y.s.repo), 1);
  assert.deepEqual(grantRow(y, gy).slots, ["L1"]);
  // An unknown outcome after the move: blocked, never moved again, the slot not given back.
  const z = await telegramSetup(t, { checkout: false });
  await autolandOn(z, ["--target", "main", "--count", "2"]);
  await assert.rejects(z.cli(["land", z.member, "--request-approval"], { deps: { afterMoving: crash } }), /crash/);
  const gz = onlyGrant(z);
  const sentZ = [];
  const b = await z.cli(["apply", "L1"], { deps: { landingChannel: fakeBridge(sentZ, { caps: AUTOLAND }) } }).catch((err) => err);
  assert.match(b.message, /the landing L1 is blocked/);
  assert.equal(parseNotice(sentZ.at(-1)).state, "blocked");
  assert.deepEqual(grantRow(z, gz).slots, ["L1"]);
});

test("auto-land grants are bound: a Telegram grant verifies against the trusted pin; a new team run, another key or a used-up count cover nothing", async (t) => {
  const x = await telegramSetup(t, { checkout: false });
  const g = signedGrant(x, { maxCount: 1 });
  const out = await x.cli(["land", x.member, "--request-approval"]);
  assert.match(out.join("\n"), /so L1 lands now without asking/);
  assert.deepEqual(grantRow(x, g.id).slots, ["L1"]);
  assert.match((await x.cli(["status", "n4"])).join("\n"), new RegExp(`auto-land grant ${g.id} for main: exhausted, 1 landing`));
  const y = await telegramSetup(t, { checkout: false });
  signedGrant(y, { key: ownersig.newKey() });
  const out2 = await y.cli(["land", y.member, "--request-approval"]);
  assert.ok(!out2.join("\n").includes("lands now"), out2.join("\n"));
  const z = await telegramSetup(t, { checkout: false });
  await autolandOn(z);
  writeTeam(z.s.home, { ...readState(z.s.home, "n4"), run: "9".repeat(32) });
  const out3 = await z.cli(["land", z.member, "--request-approval"]);
  assert.ok(!out3.join("\n").includes("lands now"), out3.join("\n"));
  assert.deepEqual(Object.values(readGrantState(z.s.home, "n4").grants).map((r) => r.status), ["retired"]);
});

test("a Telegram grant from a bridge whose clock runs 60 s ahead covers the next landing at once; the duration still counts from the bridge's issue time", async (t) => {
  const x = await telegramSetup(t, { checkout: false });
  const g = signedGrant(x, { issued: Date.now() + 60_000 });
  const out = await x.cli(["land", x.member, "--request-approval"]);
  assert.match(out.join("\n"), /so L1 lands now without asking/);
  assert.deepEqual(grantRow(x, g.id).slots, ["L1"]);
  assert.equal(g.expires_at - g.issued_at, 2 * 60 * 60_000);
});

test("a notice the bridge has not taken (200 lines held, the 201st left unconfirmed at the relay) stays owed on the Mac, and reaches Telegram once there is room", async (t) => {
  const { ME, agent, bridgeOn, fakeTelegram, newKey, ownerRelay, paired, tmpHome, until } = await import("./owner-helpers.js");
  const r = await ownerRelay(t);
  const home = tmpHome(t);
  const tg = fakeTelegram();
  const b = bridgeOn(t, { home, telegram: tg.client(), url: r.url, token: r.tokens.me, key: newKey(), tickMs: 200, autolandMax: 200 });
  await until(() => b.bridge.leading(), 4000, "leadership");
  // The relay takes at most 30 messages per 10 s per connection: the 200 come from 8 connections.
  const clis = [];
  for (let i = 1; i <= 8; i++) clis.push(await agent(t, r.url, r.tokens.me, `me-cli-${i}`));
  const sendBy = (c) => (text, ttl = 600) => c.client.send("me-owner", text, ttl, undefined, { toMember: ME });
  const send = sendBy(clis[0]);
  await Promise.all(clis.map(async (c, j) => {
    for (let i = j * 25 + 1; i <= j * 25 + 25; i++) await sendBy(c)(noticeText({ digest: i.toString(16).padStart(64, "0"), id: `L${100 + i}`, team: "web", target: "main", state: "landed", left_s: null }));
  }));
  await until(() => (b.bridge.state().autoland_pending ?? []).length === 200, 15000, "200 held while unpaired");
  const x = await telegramSetup(t, { checkout: false });
  await autolandOn(x);
  const channel = async () => ({ realm: REALM_ID, member: OWN_MEMBER, caps: AUTOLAND, send, close: () => {} });
  const warned = [];
  const out = await x.cli(["land", x.member, "--request-approval"], { warned, deps: { landingChannel: channel } });
  assert.match(out.join("\n"), /so L1 lands now without asking/);
  assert.ok(warned.some((w) => /notice pending: the owner's Telegram was not told of 1 auto-landing \(the bridge has not taken it yet\)/.test(w)), warned.join("\n"));
  const owed = readGrantState(x.s.home, "n4");
  assert.deepEqual(owed.notices.map((n) => [n.id, n.state]), [["L1", "landed"]], "still owed on the Mac");
  assert.deepEqual(Object.values(owed.grants)[0].noticed, []);
  // Paired: the held lines go out, the bridge takes the one the relay kept, and shows it once.
  paired(home);
  const line = /^🤖 L1 landed on main under your auto-land for team n4/;
  await until(() => tg.texts().some((x) => line.test(x)), 20000, "the owed notice on Telegram");
  assert.equal(tg.texts().filter((x) => /^🤖 L\d+ landed/.test(x)).length, 201);
  // The Mac sends it again (it was owed), the bridge takes it as a repeat; nothing is shown twice.
  await x.cli(["status", "n4"], { deps: { landingChannel: channel } });
  const done = readGrantState(x.s.home, "n4");
  assert.deepEqual(done.notices, []);
  assert.deepEqual(Object.values(done.grants)[0].noticed, ["L1:landed"]);
  await sleep(300);
  assert.equal(tg.texts().filter((x) => line.test(x)).length, 1);
});

test("auto-land notices are owed by the records: pending on a bridge that cannot show them, owed after a run stopped before queueing or a queue that could not be written, never dropped, sent once", async (t) => {
  const x = await telegramSetup(t, { checkout: false });
  await autolandOn(x);
  const warned = [];
  const old = [];
  await x.cli(["land", x.member, "--request-approval"], { warned, deps: { landingChannel: fakeBridge(old, { caps: ["landing"] }) } });
  assert.equal(refOf(x.s.repo, "main"), x.c.C);
  assert.deepEqual(old, []);
  assert.deepEqual(warned, ["notice pending: the owner's Telegram was not told of 1 auto-landing (the bridge needs an update to show auto-land notices); the next hoptell team command for n4 tries again"]);
  const failing = [];
  await x.cli(["status", "n4"], { warned: failing, deps: { landingChannel: fakeBridge([], { caps: AUTOLAND, failSend: true }) } });
  assert.match(failing[0], /^notice pending: .*\(relay did not answer in time\)/);
  const sent = [];
  const out = await x.cli(["status", "n4"], { deps: { landingChannel: fakeBridge(sent, { caps: AUTOLAND }) } });
  assert.equal(out.at(-1), "The owner's Telegram was told: L1 landed.");
  await x.cli(["status", "n4"], { deps: { landingChannel: fakeBridge(sent, { caps: AUTOLAND }) } });
  assert.deepEqual(sent.map((m) => parseNotice(m).state), ["landed"], "sent once");
  assert.equal(moves(x.s.repo), 1);
  // A run that stopped right after the landing ended, before any notice was queued: still owed.
  const y = await telegramSetup(t, { checkout: false });
  await autolandOn(y);
  const r = await y.request();
  await teamLandApprove(y.s.home, y.member, { T: r.T, C: r.C, homedir: y.s.homedir, actionId: r.id, route: "grant" });
  assert.deepEqual(readGrantState(y.s.home, "n4").notices, []);
  // The queue cannot be written: pending, and owed still.
  const dir = path.join(y.s.home, "teams", "n4", "grants");
  fs.chmodSync(dir, 0o500);
  t.after(() => {
    try {
      fs.chmodSync(dir, 0o700);
    } catch {}
  });
  const w1 = [];
  await y.cli(["status", "n4"], { warned: w1, deps: { landingChannel: fakeBridge([], { caps: AUTOLAND }) } });
  assert.match(w1[0], /^notice pending: the owner's Telegram is owed auto-land notices that could not be queued \(/);
  fs.chmodSync(dir, 0o700);
  const sentY = [];
  await y.cli(["status", "n4"], { deps: { landingChannel: fakeBridge(sentY, { caps: AUTOLAND }) } });
  assert.deepEqual(sentY.map((m) => [parseNotice(m).id, parseNotice(m).state]), [["L1", "landed"]]);
  // 50 notices still owed: no new auto-landing; the request goes to the owner, and nothing is dropped.
  const z = await telegramSetup(t, { checkout: false });
  await autolandOn(z);
  const gs = readGrantState(z.s.home, "n4");
  for (let i = 1; i <= 50; i++) gs.notices.push({ digest: crypto.createHash("sha256").update(String(i)).digest("hex"), id: `L${100 + i}`, team: "n4", target: "main", state: "landed", left_s: null });
  writeGrantState(z.s.home, "n4", gs);
  const outZ = await z.cli(["land", z.member, "--request-approval"]);
  assert.ok(outZ.includes("Not auto-landed under the owner's grant: too many auto-land notices are pending (50); check the owner's Telegram. The owner decides it."), outZ.join("\n"));
  assert.equal(refOf(z.s.repo, "main"), z.c.T);
  assert.equal(readGrantState(z.s.home, "n4").notices.length, 50);
});

test("an auto-landing that stopped after acceptance stays the grant's on every route: after --off, the owner's terminal --approve and team apply both refuse, and nothing moves", async (t) => {
  for (const route of ["terminal", "apply"]) {
    const x = await telegramSetup(t, { checkout: false });
    await autolandOn(x);
    await assert.rejects(x.cli(["land", x.member, "--request-approval"], { deps: { beforeMove: crash } }), /crash/);
    assert.equal(readState(x.s.home, "n4").actions[0].state, "accepted");
    await x.cli(["autoland", "n4", "--off"]);
    const r = await (route === "terminal" ? x.cli(["land", x.member, "--approve", x.c.T, x.c.C], { tty: true }) : x.cli(["apply", "L1"])).catch((e) => e);
    assert.match(r.message, /^the owner turned auto-land off \(the grant g_[a-z2-7]{16} is revoked\) before the move, so the landing L1 ended; nothing was moved\./, route);
    assert.equal(moves(x.s.repo), 0, route);
    assert.equal(refOf(x.s.repo, "main"), x.c.T, route);
    assert.deepEqual(((e) => [e.state, e.route])(readTombstone(x.s.home, "n4", "L1")), ["rejected", "grant"], route);
  }
});

test("the notices owed count before an auto-landing: 49 queued plus one owed after a stopped run already reach the limit", async (t) => {
  const x = await telegramSetup(t, { checkout: false });
  await autolandOn(x);
  // L1, approved by the grant, ends rejected when it is applied after an --off (the library call:
  // no command queued its notice, as when a run stops right after the record). A new grant follows.
  await x.request();
  await x.cli(["autoland", "n4", "--off"]);
  await autolandOn(x);
  await assert.rejects(teamApply(x.s.home, "L1", { homedir: x.s.homedir }), /revoked/);
  assert.equal(readTombstone(x.s.home, "n4", "L1").state, "rejected");
  const gs = readGrantState(x.s.home, "n4");
  assert.equal(gs.notices.length, 0);
  for (let i = 1; i <= 49; i++) gs.notices.push({ digest: crypto.createHash("sha256").update(String(i)).digest("hex"), id: `L${100 + i}`, team: "n4", target: "main", state: "landed", left_s: null });
  writeGrantState(x.s.home, "n4", gs);
  const out = await x.cli(["land", x.member, "--request-approval"]);
  assert.ok(out.includes("Not auto-landed under the owner's grant: too many auto-land notices are pending (50); check the owner's Telegram. The owner decides it."), out.join("\n"));
  assert.equal(refOf(x.s.repo, "main"), x.c.T);
  const after = readGrantState(x.s.home, "n4");
  assert.equal(after.notices.length, 50);
  assert.ok(after.notices.some((n) => n.id === "L1" && n.state === "rejected"));
});

test("an action an auto-land grant approved is shown as such by team approve, and a terminal approve lands it by the grant", async (t) => {
  const x = await telegramSetup(t, { checkout: false });
  await autolandOn(x);
  const r = await x.request();
  assert.equal(r.auto.grant.startsWith("g_"), true);
  assert.deepEqual(readState(x.s.home, "n4").actions.map((a) => [a.state, a.route]), [["approved", "grant"]]);
  const view = await x.cli(["approve", "L1"], { tty: true, deps: { ask: async () => assert.fail("no prompt") } });
  assert.equal(view.at(-1), "L1 is approved by your auto-land grant. The lead lands it (hoptell team apply L1); nothing more is needed here.");
  const out = await x.cli(["land", x.member, "--approve", x.c.T, x.c.C], { tty: true });
  assert.match(out.join("\n"), /^Landed \w+ on main \(was \w+\), landing L1\.$/m);
  assert.deepEqual(((e) => [e.state, e.route])(readTombstone(x.s.home, "n4", "L1")), ["finished", "grant"]);
  assert.deepEqual(grantRow(x, onlyGrant(x)).slots, ["L1"]);
});

test("team autoland from the real command line: --off, --for and --count are known options; a missing value is refused", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "hoptell-autoland-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const run = (...args) => spawnSync(process.execPath, [BIN, "team", ...args], { env: { ...process.env, HOPTELL_HOME: home, HOPTELL_CREDENTIAL_STORE: "file", HOPTELL_CREDENTIAL_PASSPHRASE: "test-pass-040", HOPTELL_TEAM_MEMBER: "" }, encoding: "utf8" });
  const off = run("autoland", "n4", "--off");
  assert.equal(off.status, 1, off.stderr);
  assert.match(off.stderr, /team n4 has no state/);
  assert.doesNotMatch(off.stderr, /unknown option/);
  const on = run("autoland", "n4", "--target", "main", "--for", "2h", "--count", "3");
  assert.doesNotMatch(on.stderr, /unknown option/);
  for (const flag of ["--for", "--count"]) {
    const r = run("autoland", "n4", "--target", "main", flag);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, new RegExp(`${flag} needs a value`));
  }
});
