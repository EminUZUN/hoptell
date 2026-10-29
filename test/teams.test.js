// Agent teams (design 8, phase 2): the team file, hoptell team up | status | stop | restart | down,
// landing with provenance and cleanup, and the supervisor's lifetimes and idle reviewers.
// Temporary repositories and homes, test relays, a private tmux server (TMUX_TMPDIR) and stand-in
// CLIs only; processes are stopped by their exact pids.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { currentBoot, identityState, processIdentity, processInfo } from "../lib/host.js";
import { BIN } from "../lib/config.js";
import { NOTICE_MS, leadCheck, checkTeam, landedFor, launchPreflight, ownsOverlap, readState, stateProblem, superviseTick, teamCommand, teamDown, teamLandApprove, teamLandCandidate, teamLandDiscard, teamPaths, teamRestart, teamStatus, teamStop, teamUp, reviewCommand, reviewDiff, reviewRequest, reviewVerdict } from "../lib/teams.js";
import { addWorktree, commitWorktree, landApprove, landCandidate, readWorktreeRecord, registrationOf, removeWorktree, worktreeCommand, worktreePaths } from "../lib/worktrees.js";
import { findGit } from "../lib/gitsafe.js";
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
  assert.ok(dry.warn.includes(`warning: dana-n1-impl-1: Codex will ask you to trust ${wt} in its pane before it starts`), dry.warn);
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
  if (process.getuid() !== 0) assert.match(w, /dana-n1-impl-1: Codex may ask you to trust \S+ in its pane before it starts \(\S+config\.toml: it could not be read \(EACCES\)\)/);
  fs.chmodSync(path.join(codexHome, "config.toml"), 0o600);
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
  // main is checked out in the repository: hoptell does not move it, it says what to run there.
  const manual = await owner(["land", impl.name, "--approve", T, C]);
  assert.equal(manual.failed, null, manual.failed);
  assert.match(manual.out, /main is checked out in \S+repo, so hoptell does not move it/);
  assert.ok(manual.out.includes(`\n  test "$(git symbolic-ref HEAD)" = refs/heads/main && test "$(git rev-parse HEAD)" = ${T} && git merge --ff-only ${C}\nthen record it: hoptell team land dana-n1-impl-1 --confirm ${T} ${C}`), manual.out);
  assert.ok(!manual.out.includes("#"), "nothing a shell might not take as a comment");
  assert.equal(git(s.repo, "rev-parse", "main"), T, "nothing moved");
  assert.equal(readState(w.home, "n1").candidate.C, C, "the candidate stays");
  // --confirm before the owner's fast-forward: nothing is recorded.
  assert.match((await owner(["land", impl.name, "--confirm", T, C])).failed, /main is still at .*; run git merge --ff-only/);
  assert.match((await cli("land", impl.name, "--confirm", T, C)).stderr, /landing is the owner's step: run hoptell team land --confirm in a terminal/);
  // The printed line, pasted into a shell: with a wrong check nothing merges; as printed, it merges.
  const line = manual.out.split("\n").find((l) => l.startsWith("  test ")).trim();
  const paste = (text) => spawnSync("sh", ["-c", text], { cwd: s.repo, env: gitEnv, encoding: "utf8" });
  assert.notEqual(paste(line.replace(`= ${T} `, `= ${C} `)).status, 0);
  assert.equal(git(s.repo, "rev-parse", "main"), T, "a failed check merges nothing");
  assert.equal(paste(line).status, 0);
  const landed = await owner(["land", impl.name, "--confirm", T, C]);
  assert.equal(landed.failed, null, landed.failed);
  assert.match(landed.out, new RegExp(`Confirmed ${C} on main \\(was ${T}\\)`));
  assert.match(landed.out, /worktree removed; branch team\/n1\/dana-n1-impl-1 deleted/);
  assert.equal(git(s.repo, "rev-parse", "main"), C);
  assert.equal(readState(w.home, "n1").landing, null, "the journal is cleared");
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
  // The target moved: refused, and a new candidate is refused too (no merge machinery).
  git(s.repo, "update-ref", "-d", landRef, c.C);
  git(s.repo, "commit", "-q", "--allow-empty", "-m", "elsewhere");
  await refusal(() => landCandidate(s.home, "dana-impl-1", { target: "main", message: "Land", landRef, bound: reg(s.home) }, opts), "target_moved", /hoptell runs no merge/);
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
  const manual = await landApprove(v.home, "dana-impl-1", { T: dev.T, C: dev.C, candidate: { target: "dev", T: dev.T, C: dev.C, H: dev.H }, landRef: "refs/heads/team/n2/land", bound: reg(v.home) }, { homedir: v.homedir });
  assert.equal(manual.manual.at, fs.realpathSync(path.join(v.root, "devwt")));
  assert.equal(git(v.repo, "rev-parse", "dev"), vrec.base, "a checked-out target is never moved by hoptell");
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

/** A signed repository with one team member whose commit has a candidate on main (not checked out). */
async function landingSetup(t, team = "n4", { candidate = true } = {}) {
  const s = repoSetup(t, { signing: true });
  git(s.repo, "commit", "-q", "--allow-empty", "-m", "second"); // T has a parent to rewind to
  const member = `dana-${team}-impl-1`;
  const rec = await addWorktree(s.home, { repo: s.repo, member, team, cli: "codex" });
  fs.writeFileSync(path.join(rec.path, "lib", "x.js"), "2\n");
  await commitWorktree(s.home, member, { message: "m" });
  writeTeam(s.home, stateOf(team, [memberRow(member, "implementer", null, { cli: "codex", template: "implementer", worktree: rec.path, branch: rec.branch, registration: registrationOf(rec), cwd: rec.path })], { repo: s.repo }));
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
  // 1. The journal of the intent cannot be written: nothing moves.
  {
    const { s, rec, c, member, landRef } = await landingSetup(t);
    await assert.rejects(teamLandApprove(s.home, member, { T: c.T, C: c.C, homedir: s.homedir }, { save: failing(1) }), /ENOSPC/);
    assert.equal(refOf(s.repo, "main"), c.T);
    assert.equal(refOf(s.repo, landRef), c.C);
    assert.ok(fs.existsSync(rec.path));
  }
  // 2. The target moved, but the landing cannot be recorded: the candidate branch and the worktree
  // stay, the journal says what moved, and the same command finishes it.
  {
    const { s, rec, c, member, landRef } = await landingSetup(t);
    await refusal(() => teamLandApprove(s.home, member, { T: c.T, C: c.C, homedir: s.homedir }, { save: failing(2) }), "not_recorded", /main is at .*, but the landing could not be recorded \(ENOSPC.*\); the candidate branch and the worktree are kept/);
    assert.equal(refOf(s.repo, "main"), c.C);
    assert.equal(refOf(s.repo, landRef), c.C);
    assert.ok(fs.existsSync(rec.path));
    const j = readState(s.home, "n4").landing;
    assert.deepEqual([j.phase, j.member, j.H, j.T, j.C, j.target, j.repo], ["intent", member, c.H, c.T, c.C, "main", s.repo]);
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
    await assert.rejects(teamLandApprove(s.home, member, { T: c.T, C: c.C, homedir: s.homedir }, { save: failing(3) }), /ENOSPC/);
    assert.ok(!fs.existsSync(rec.path));
    assert.equal(readState(s.home, "n4").landing.phase, "landed");
    const r = await teamLandApprove(s.home, member, { T: c.T, C: c.C, homedir: s.homedir });
    assert.ok(r.removed.already);
    assert.equal(readState(s.home, "n4").landing, null);
    assert.equal(readState(s.home, "n4").landed.length, 1);
  }
});

test("--confirm records only a target that is exactly at the verified candidate", async (t) => {
  const { s, rec, c, member } = await landingSetup(t);
  const confirm = () => teamLandApprove(s.home, member, { T: c.T, C: c.C, homedir: s.homedir, confirm: true });
  await refusal(confirm, "not_landed", /main is still at /);
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
    await assert.rejects(finish(x, { afterMove: crash }), (e) => e.landOutcome === "moved");
    assert.equal(refOf(x.s.repo, "main"), x.c.C);
    assert.equal(readState(x.s.home, "n4").landing.phase, "intent");
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
      assert.equal(r.pending, `a landing is pending: hoptell team land ${x.member} --approve ${x.c.T} ${x.c.C} finishes it`, label);
      assert.match(r.report.find((y) => y.name === x.member).worktree, /kept \(a landing is pending: hoptell team land .* finishes it\)/, label);
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
      await refusal(() => up("n4"), "landing_pending", /team n4 still has dana-n4-impl-1's landing: a landing is pending: hoptell team land .* --approve/);
      await refusal(() => up("n9"), "landing_pending", /dana-n4-impl-1 has a landing in team n4 that is not resolved \(a landing is pending/);
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

test("an update or readback that does not answer cleanly is never taken for \"not moved\": the journal stays and the same command finishes", async (t) => {
  for (const readback of ["exit128", "kill"]) {
    const x = await landingSetup(t);
    const g = faultyGit(x.s.root);
    // The update is killed after it wrote the ref (status null); the readback fails.
    g.set([{ match: "update-ref --no-deref -m hoptell team land refs/heads/main", nth: 1, action: "killAfter" }, { match: `${FOR_EACH}refs/heads/main`, nth: 2, action: readback }]);
    await assert.rejects(teamLandApprove(x.s.home, x.member, { T: x.c.T, C: x.c.C, homedir: x.s.homedir }, { git: g.git }), (e) => {
      assert.equal(e.code, "land_unknown", e.message);
      assert.equal(e.landOutcome, "unknown");
      assert.match(e.message, /git update-ref ended with stopped by a signal, and main could not be read \(git for-each-ref ended with .*\); whether it moved is unknown/);
      return true;
    });
    assert.equal(refOf(x.s.repo, "main"), x.c.C, "the ref was written");
    assert.equal(readState(x.s.home, "n4").landing.phase, "intent", readback);
    g.set([]);
    await teamLandApprove(x.s.home, x.member, { T: x.c.T, C: x.c.C, homedir: x.s.homedir }, { git: g.git });
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
    // The deletion fails and its readback (the third read: the check, the read before the
    // deletion, the readback) fails too: refused before the registration goes.
    g.set([{ match: `update-ref --no-deref -d ${x.landRef}`, nth: 1, action: "exit128" }, { match: `${FOR_EACH}${x.landRef}`, nth: 3, action }]);
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
