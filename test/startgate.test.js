// The startup folder-trust gate of a Codex launch (design 9, C, v2 correction 4): the launch record,
// arming only for a verified fresh launch of a recorded Codex version, the injector's recovery and
// turning it off for good. No real Codex: stand-in scripts named codex. A private tmux server
// (TMUX_TMPDIR) and temporary homes; sessions are ended by their exact names.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { DIALOG_MS, FIRST_READ_MS, GAP_MS, MEMBER_ALLOWED_TOOLS, NO_EDIT_TOOLS, agyFreshProblem, claimFileOf, claudeFreshProblem, cliVersion, codexVersion, freshProblem, launchFileOf, launchGate, readExit, readLaunch, resolveCli, startGate, trustRootOf, trustScopeOf, writeExit, writeLaunch } from "../lib/startgate.js";
import { CARD_MS, START_MS } from "../lib/promptcards.js";
import { classifyPrompt } from "../lib/prompts.js";
import { waitWatch } from "../lib/tmux.js";
import { processIdentity } from "../lib/host.js";
import { readOccurrence } from "../lib/waits.js";
import { RUN_TOOLS } from "../lib/mcp.js";
import { sleep, world } from "./helpers.js";

const TMUX_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "hoptell-gate-"));
process.env.TMUX_TMPDIR = TMUX_DIR;
delete process.env.TMUX;
delete process.env.TMUX_PANE;
test.after(() => {
  spawnSync("tmux", ["kill-server"]);
  fs.rmSync(TMUX_DIR, { recursive: true, force: true });
});
const hasTmux = spawnSync("tmux", ["-V"]).status === 0;

const tmp = (t, prefix = "hoptell-gate-") => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
/** A stand-in named codex in `dir`/bin answering --version with `version`, and sleeping otherwise. */
function fakeCodex(dir, version = "0.165.0") {
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin, { recursive: true });
  const file = path.join(bin, "codex");
  fs.writeFileSync(file, `#!/bin/sh\n[ "$1" = --version ] && echo codex-cli ${version} && exit 0\nexec sleep 60\n`, { mode: 0o755 });
  return { bin, file };
}
const gitEnv = { PATH: process.env.PATH, HOME: os.tmpdir(), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", LC_ALL: "C" };
const git = (cwd, ...args) => execFileSync("git", args, { cwd, env: gitEnv, stdio: "ignore" });
const SOCKET = "/tmp/tmux-501/default";
/** A new launch's record, as hoptell tmux writes it: the earlier launch's claim goes first. */
const relaunch = (home, name, o) => {
  fs.rmSync(claimFileOf(home, name), { force: true });
  return writeLaunch(home, name, o);
};
const HOST = { pid: 4242, start: "Wed Oct 29 10:00:00 2026", uid: 501, boot: "b1" };
/** The injector's view: its pane, process, session and server, the process observed as `seen`. */
const injectorAt = (o = {}) => ({ pane: "%3", pid: "4242", session: "$1", socket: SOCKET, identity: () => "same", ...o });

test("the executable, its version and the folder Codex asks about", (t) => {
  const dir = tmp(t);
  const { bin, file } = fakeCodex(dir);
  assert.equal(resolveCli("codex", { envPath: ["relative", bin].join(path.delimiter), cwd: dir }), file);
  assert.equal(resolveCli("codex", { envPath: "relative", cwd: dir }), null, "a relative PATH entry is never searched");
  assert.equal(resolveCli("./bin/codex", { envPath: "", cwd: dir }), file);
  assert.equal(resolveCli("codex", { envPath: path.join(dir, "none"), cwd: dir }), null);
  assert.equal(codexVersion(file, { env: { PATH: process.env.PATH } }), "0.165.0");
  assert.equal(codexVersion(file, { env: {}, run: () => "codex-cli 0.165.0 extra\n" }), null, "only the exact form");
  assert.equal(codexVersion(file, { env: {}, run: () => { throw new Error("timed out"); } }), null);
  // Outside a repository: the launch folder. In one: its main folder, also from a linked worktree.
  const plain = path.join(dir, "plain");
  fs.mkdirSync(plain);
  assert.equal(trustRootOf(plain, { envPath: process.env.PATH }), plain);
  const repo = path.join(dir, "repo");
  fs.mkdirSync(path.join(repo, "sub"), { recursive: true });
  git(repo, "init", "-q");
  git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "x");
  assert.equal(trustRootOf(path.join(repo, "sub"), { envPath: process.env.PATH }), repo);
  const wt = path.join(dir, "wt");
  git(repo, "worktree", "add", "-q", wt);
  assert.equal(trustRootOf(wt, { envPath: process.env.PATH }), repo);
  assert.equal(trustRootOf(path.join(dir, "missing"), { envPath: process.env.PATH }), null);
  assert.equal(trustRootOf(plain, { envPath: "" }), null, "no git: not told");
});

test("arming: only a launch of Codex on a verified version, run by the path that was asked; anything else is off and unchanged", (t) => {
  const dir = tmp(t);
  const { bin, file } = fakeCodex(dir);
  const env = { PATH: [bin, process.env.PATH].join(path.delimiter), HOME: os.tmpdir() };
  const g = launchGate(["codex", "-m", "gpt-5", "--sandbox=workspace-write"], { folder: dir, env, now: () => 7 });
  assert.deepEqual(g, { cli: { name: "codex", path: file, version: "0.165.0" }, root: dir, scope: null, built: null, gate: { state: "armed", why: null, at: 7 }, argv: [file, "-m", "gpt-5", "--sandbox=workspace-write"] });
  const off = (cmd, e = env) => {
    const r = launchGate(cmd, { folder: dir, env: e, now: () => 7 });
    assert.deepEqual(r.argv, cmd, "unchanged");
    return [r.gate.state, r.gate.why];
  };
  assert.deepEqual(off(["gemini"]), ["off", "not codex, claude or agy"]);
  assert.deepEqual(off(["env", "codex"]), ["off", "not codex, claude or agy"], "a wrapper in front: off, whatever follows");
  assert.deepEqual(off(["codex"], { PATH: path.join(dir, "none") }), ["off", "codex not found"]);
  // A version the table was not recorded on arms all the same (the screen must match exactly).
  const other = fakeCodex(path.join(dir, "o"), "0.166.0");
  assert.equal(launchGate([other.file], { folder: dir, env }).gate.state, "armed");
  fs.writeFileSync(other.file, "#!/bin/sh\necho something else\n", { mode: 0o755 });
  assert.deepEqual(off([other.file]), ["off", "version unknown"]);
  assert.deepEqual(launchGate(["codex"], { folder: dir, env, root: () => null }).gate.why, "folder unknown");
  // Only the fresh interactive launch the prompt table was recorded on.
  const fresh = [[], ["-s", "read-only"], ["--sandbox", "workspace-write", "-a", "never"], ["--ask-for-approval=on-request", "--model=o3"], ["-m", "gpt-5"], ["--full-auto"], ["--dangerously-bypass-approvals-and-sandbox"]];
  // A team member's launch (lib/roles.js): one prompt, the last word, and -c only for the model
  // and its instructions.
  fresh.push(
    ["-s", "workspace-write", "-a", "never", "You are the implementer for me-lead; read your task with the hoptell read_task tool."],
    ["-s", "read-only", "-a", "never", "-c", 'model_reasoning_effort="high"', "Review what me-lead sends."],
    ["-c", 'developer_instructions="Be brief."', "--config", 'model="gpt-5"', "--config=model_reasoning_effort=low", "fix the tests"],
    ["-c", "model=o3"],
  );
  for (const ok of fresh) assert.equal(freshProblem(ok), null, ok.join(" "));
  const notFresh = {
    "another folder (-C/--cd)": [["-C", "/different"], ["--cd=/different"], ["--cd", "/different"], ["-C/different"], ["-m", "x", "-C", "/d"]],
    "a subcommand or a prompt before other words": [["resume", "--last"], ["exec", "hi"], ["fix the tests", "-m", "x"], ["one prompt", "another prompt"], ["fix the tests", "-c", "model=o3"]],
    "a subcommand or a one-word prompt": [["resume"], ["exec"], ["mcp-server"], ["-m", "x", "hello"], ["-s", "read-only", ""], ["  "]],
    "the setting -c projects.x.trust_level": [["-c", "projects.x.trust_level=trusted"], ["--config", "projects.x.trust_level=trusted"], ["--config=projects.x.trust_level=trusted"]],
    "the setting -c sandbox_mode": [["-c", 'sandbox_mode="danger-full-access"', "prompt here"]],
    "the setting -c mcp_servers.hoptell.command": [["-c", "mcp_servers.hoptell.command=x"]],
    "the setting -c model_reasoning_effort ": [["-c", "model_reasoning_effort =high"]],
    "the setting -c \"model\"": [["-c", '"model"=o3']],
    "-c without key=value": [["-c", "model"], ["-c", "=x"], ["--config=model"]],
    "-c without a value": [["-c"]],
    "--config without a value": [["--config"]],
    "the flag -cmodel": [["-cmodel=o3"]],
    "the flag -c": [["-c=model=o3"]],
    "the flag -p": [["-p", "work"]],
    "the flag --profile": [["--profile=work"]],
    "the flag --yolo": [["--yolo"]],
    "the flag --": [["--", "prompt"]],
    "-m without a value": [["-m"]],
  };
  for (const [why, cases] of Object.entries(notFresh)) {
    for (const c of cases) {
      assert.equal(freshProblem(c), why, c.join(" "));
      assert.deepEqual(off(["codex", ...c]), ["off", `not a fresh interactive launch: ${why}`], c.join(" "));
    }
  }
});

test("the injector's gate: only for its own pane and process; claimed exclusively, so a second or restarted injector never arms; armed() follows the record and the claim; off for good", (t) => {
  const home = tmp(t);
  const dir = tmp(t);
  const { file } = fakeCodex(dir);
  const launch = (gate = { state: "armed", why: null, at: 1 }, o = {}) => relaunch(home, "me-alice", { cli: { name: "codex", path: file, version: "0.165.0" }, root: dir, gate, folder: dir, tmux: { socket: SOCKET, session: "$1", pane: "%3" }, host: HOST, ...o });
  const why = () => readLaunch(home, "me-alice").gate.why;
  const rec = launch();
  assert.equal(fs.statSync(launchFileOf(home, "me-alice")).mode & 0o777, 0o600);
  assert.deepEqual(readLaunch(home, "me-alice"), rec);
  // Another server, session, pane or process, or a process not observed as the same: notification-only, and no claim.
  for (const o of [{ pane: "%4" }, { pid: "4243" }, { session: "$2" }, { session: null }, { socket: "/tmp/tmux-501/other" }, { socket: null }, { identity: () => "different" }, { identity: () => "unknown" }, { identity: () => { throw new Error("x"); } }]) {
    const x = startGate(home, "me-alice", injectorAt(o));
    assert.deepEqual([x.launch, x.armed(), x.version()], [null, false, null], JSON.stringify(o));
  }
  assert.deepEqual(readLaunch(home, "me-alice"), rec, "untouched by them");
  assert.equal(fs.existsSync(claimFileOf(home, "me-alice")), false);
  const seenAs = [];
  const g = startGate(home, "me-alice", injectorAt({ identity: (h) => (seenAs.push(h), "same"), now: () => rec.started }));
  assert.deepEqual([g.armed(), g.version(), g.launch.id], [true, "0.165.0", rec.id]);
  assert.deepEqual(seenAs, [HOST], "the recorded process identity is the one observed");
  // The claim: created once, 0600, naming the launch, the pane and pid, and the injector's own identity.
  const claim = JSON.parse(fs.readFileSync(claimFileOf(home, "me-alice"), "utf8"));
  assert.equal(fs.statSync(claimFileOf(home, "me-alice")).mode & 0o777, 0o600);
  assert.deepEqual({ ...claim, nonce: undefined }, { v: 1, launch: rec.id, pane: "%3", pid: 4242, injector: processIdentity(process.pid), nonce: undefined });
  // Another injector (a restart, or a second one), whenever: off for good; the first one sees it at once.
  const again = startGate(home, "me-alice", injectorAt({ now: () => rec.started }));
  assert.equal(again.armed(), false);
  assert.equal(why(), "injector restarted");
  assert.equal(g.armed(), false, "armed() reads the record again");
  g.off("ready");
  assert.equal(why(), "injector restarted", "the first word stays");
  // The claim replaced, or gone, under an armed record: off.
  for (const change of [(f) => fs.writeFileSync(f, "{}\n"), (f) => fs.rmSync(f)]) {
    const r = launch();
    const h = startGate(home, "me-alice", injectorAt({ now: () => r.started }));
    assert.equal(h.armed(), true);
    change(claimFileOf(home, "me-alice"));
    assert.equal(h.armed(), false);
    assert.equal(why(), "claimed by another injector");
  }
  // Another launch's record in its place: off, and that record is left alone.
  launch();
  const h = startGate(home, "me-alice", injectorAt());
  const other = launch();
  assert.equal(h.armed(), false);
  assert.deepEqual(readLaunch(home, "me-alice"), other);
  // An unclaimed record found later than FIRST_READ_MS after its launch: off, and no claim made.
  const old = launch(undefined, { now: () => Date.now() - FIRST_READ_MS - 1 });
  assert.equal(startGate(home, "me-alice", injectorAt()).armed(), false);
  assert.equal(why(), "startup not observed");
  assert.equal(fs.existsSync(claimFileOf(home, "me-alice")), false);
  assert.ok(old);
  // The injector's own identity unknown: off.
  const r4 = launch();
  assert.equal(startGate(home, "me-alice", injectorAt({ self: () => null, now: () => r4.started })).armed(), false);
  assert.equal(why(), "injector unknown");
  // A record that is not one, or armed without what arming needs: notification-only.
  fs.writeFileSync(launchFileOf(home, "me-alice"), JSON.stringify({ ...rec, extra: 1 }));
  assert.equal(readLaunch(home, "me-alice"), null);
  fs.writeFileSync(launchFileOf(home, "me-alice"), JSON.stringify({ ...rec, root: null }));
  assert.equal(readLaunch(home, "me-alice"), null);
  fs.writeFileSync(launchFileOf(home, "me-alice"), JSON.stringify({ ...rec, host: null }));
  assert.equal(readLaunch(home, "me-alice"), null);
  // Armed is never written without what arming needs: the server and the process.
  assert.deepEqual(launch(undefined, { tmux: { socket: null, session: "$1", pane: "%3" } }).gate.why, "tmux server unknown");
  assert.deepEqual(launch(undefined, { host: null }).gate.why, "process unknown");
  if (process.getuid?.() === 0) return; // root writes anywhere
  // The claim cannot be created (a read-only folder): off in this run. Nor can the record be turned
  // off: this injector tries again on each check until it can, and a record still unclaimed past
  // FIRST_READ_MS is off for any later injector.
  const logs = [];
  const r3 = launch();
  const sessions = path.dirname(launchFileOf(home, "me-alice"));
  fs.chmodSync(sessions, 0o500);
  let blocked;
  try {
    blocked = startGate(home, "me-alice", injectorAt({ now: () => r3.started, log: (l) => logs.push(l) }));
    assert.equal(blocked.armed(), false);
  } finally {
    fs.chmodSync(sessions, 0o700);
  }
  assert.match(logs.join("\n"), /could not be recorded .*tries again/);
  assert.equal(readLaunch(home, "me-alice").gate.state, "armed", "not yet written");
  assert.equal(blocked.armed(), false);
  assert.deepEqual([readLaunch(home, "me-alice").gate.state, why()], ["off", "not claimed: EACCES"], "written once it can be");
  const r6 = launch();
  fs.chmodSync(sessions, 0o500);
  try {
    assert.equal(startGate(home, "me-alice", injectorAt({ now: () => r6.started })).armed(), false);
  } finally {
    fs.chmodSync(sessions, 0o700);
  }
  assert.equal(startGate(home, "me-alice", injectorAt({ now: () => r6.started + FIRST_READ_MS + 1 })).armed(), false, "storage back, later: off");
  // A claim that was created but not fully written stays as a fence: the launch is notification-only.
  const r5 = launch();
  fs.writeFileSync(claimFileOf(home, "me-alice"), "", { flag: "wx" });
  assert.equal(startGate(home, "me-alice", injectorAt({ now: () => r5.started })).armed(), false);
});

test("two injectors claiming one launch at the same moment, in separate processes: one claim wins, the other is refused and turns the launch off, so neither stays armed", { skip: process.platform === "win32" }, async (t) => {
  const home = tmp(t);
  const dir = tmp(t);
  const { file } = fakeCodex(dir);
  const lib = new URL("../lib/startgate.js", import.meta.url).href;
  const script = `
    import { startGate } from ${JSON.stringify(lib)};
    const [home, at] = process.argv.slice(1);
    while (Date.now() < Number(at)) {}
    const g = startGate(home, "me-alice", { pane: "%3", pid: "4242", session: "$1", socket: ${JSON.stringify(SOCKET)}, identity: () => "same" });
    process.stdout.write(g.armed() ? "armed" : "off");
  `;
  for (let round = 0; round < 5; round++) {
    relaunch(home, "me-alice", { cli: { name: "codex", path: file, version: "0.165.0" }, root: dir, gate: { state: "armed", why: null, at: 1 }, folder: dir, tmux: { socket: SOCKET, session: "$1", pane: "%3" }, host: HOST });
    const at = Date.now() + 400;
    const run = () => new Promise((resolve, reject) => {
      const c = spawn(process.execPath, ["--input-type=module", "-e", script, home, String(at)], { stdio: ["ignore", "pipe", "inherit"] });
      let out = "";
      c.stdout.on("data", (d) => (out += d));
      c.on("error", reject);
      c.on("close", () => resolve(out));
    });
    const results = await Promise.all([run(), run()]);
    assert.ok(results.every((x) => x === "armed" || x === "off"), results.join());
    assert.ok(results.filter((x) => x === "armed").length <= 1, `round ${round}: ${results}`);
    // The second claim was refused (the claim exists), and that refusal turned the launch off.
    assert.equal(readLaunch(home, "me-alice").gate.why, "injector restarted", `round ${round}`);
    assert.equal(JSON.parse(fs.readFileSync(claimFileOf(home, "me-alice"), "utf8")).v, 1);
  }
});

const TRUST = (dir, { selected = 1, folder = dir } = {}) => ["  Folder access", `  ${folder}`, "", "  Trust this folder? Codex can read, edit, and run files here, subject to your permission settings. Folder settings can run code", "  automatically, even without a model request. Continue only if you trust these files. Your trust decision will be saved.", "", `${selected === 1 ? "›" : " "} 1. Trust and continue`, `${selected === 2 ? "›" : " "} 2. Quit`, "", "  enter continue · esc quit", ""].join("\n");
const readOf = (screen, inputShown = false) => ({ screen, inputShown, prompt: classifyPrompt(screen, { cli: "codex", version: "0.165.0" }) });

test("the startup gate as continuity: armed only while every read since the launch showed the same trust dialog, with no gap; anything else ends it for good", (t) => {
  const home = tmp(t);
  const dir = tmp(t);
  const { file } = fakeCodex(dir);
  let now = 1_000_000;
  /** A launch at `now`, its injector, and `then(gate, step)`: reads with the clock moved `step` ms each. */
  const fresh = () => {
    const rec = relaunch(home, "me-alice", { cli: { name: "codex", path: file, version: "0.165.0" }, root: dir, gate: { state: "armed", why: null, at: now }, folder: dir, tmux: { socket: SOCKET, session: "$1", pane: "%3" }, host: HOST, now: () => now });
    const gate = startGate(home, "me-alice", injectorAt({ now: () => now }));
    const read = (screen, { after = 2000, inputShown = false } = {}) => {
      now += after;
      gate.observe(screen === null ? null : readOf(screen, inputShown));
      return gate.armed();
    };
    return { rec, gate, read, why: () => readLaunch(home, "me-alice").gate.why };
  };
  const transcriptTrust = ["earlier output", ...TRUST(dir).split("\n").filter(Boolean), "", "› Ask Codex to do anything"].join("\n");
  // Blank screens, then the dialog, then the same dialog with the other row selected: armed.
  let x = fresh();
  assert.equal(x.read(""), true);
  assert.equal(x.read(TRUST(dir)), true);
  assert.equal(x.read(TRUST(dir, { selected: 2 })), true, "the selection may move");
  assert.equal(x.read(TRUST(dir)), true);
  // ... and its input box: off ("ready"), and the dialog again later does not arm it.
  assert.equal(x.read("› Ask Codex to do anything", { inputShown: true }), false);
  assert.equal(x.why(), "ready");
  assert.equal(x.read(TRUST(dir)), false);
  // The input box sampled after a capture that still shows the dialog: off ("ready"), first read or later.
  x = fresh();
  assert.equal(x.read(TRUST(dir), { inputShown: true }), false);
  assert.equal(x.why(), "ready");
  x = fresh();
  x.read(TRUST(dir));
  assert.equal(x.read(TRUST(dir), { inputShown: true }), false);
  assert.equal(x.why(), "ready");
  // The first read shows Codex ready (a folder trusted before): off, and trust-like text later is nothing.
  x = fresh();
  assert.equal(x.read("› Ask Codex to do anything", { inputShown: true }), false);
  assert.equal(x.why(), "ready");
  assert.equal(x.read(TRUST(dir)), false);
  // The first screen that shows anything is not the dialog (transcript, MCP start, another prompt): off.
  for (const first of ["Starting MCP servers (1/2): hoptell", transcriptTrust, "  Do you want to proceed?"]) {
    x = fresh();
    assert.equal(x.read(first), false, first);
    assert.equal(x.why(), "startup not observed");
    assert.equal(x.read(TRUST(dir)), false);
  }
  // The dialog for another folder than the launch's root: off.
  x = fresh();
  assert.equal(x.read(TRUST(dir, { folder: "/somewhere/else" })), false);
  // The first read too late after the launch: off, whatever it shows.
  x = fresh();
  assert.equal(x.read(TRUST(dir), { after: FIRST_READ_MS + 1 }), false);
  assert.equal(x.why(), "startup not observed");
  // Blank reads only: the dialog must show within DIALOG_MS.
  x = fresh();
  for (let i = 0; i < DIALOG_MS / 2000; i++) x.read("");
  assert.equal(x.read(TRUST(dir), { after: 2001 }), false);
  // A gap between reads (a failed read counts as none): off, and the dialog afterwards does not arm it.
  x = fresh();
  x.read(TRUST(dir));
  x.read(null);
  assert.equal(x.read(TRUST(dir), { after: GAP_MS - 2000 + 1 }), false);
  assert.equal(x.why(), "reads interrupted");
  x = fresh();
  x.read(TRUST(dir));
  now += GAP_MS + 1;
  assert.equal(x.gate.armed(), false, "found at key time too, without a read");
  // The dialog changed (another folder, other text), went blank or was replaced: off.
  for (const next of [TRUST(dir, { folder: `${dir}/sub` }), TRUST(dir).replace("Trust and continue", "Trust and go"), "", transcriptTrust]) {
    x = fresh();
    x.read(TRUST(dir));
    assert.equal(x.read(next), false, next);
    assert.equal(x.why(), "the startup dialog ended");
  }
  // Held without a break: at most START_MS + CARD_MS after the launch.
  x = fresh();
  for (let i = 0; i < (START_MS + CARD_MS) / 2000; i++) assert.equal(x.read(TRUST(dir)), true);
  assert.equal(x.read(TRUST(dir), { after: 1 }), false);
  assert.equal(x.why(), "startup window over");
  // A restarted injector, at any time: off, and its reads are nothing.
  x = fresh();
  x.read(TRUST(dir));
  const restarted = startGate(home, "me-alice", injectorAt({ now: () => now }));
  restarted.observe(readOf(TRUST(dir)));
  assert.equal(restarted.armed(), false);
  assert.equal(x.why(), "injector restarted");
});

// Codex's worktree variant (live capture codex-0.165.0-trust-worktree-w200): the launch folder,
// the note, then the repository root, the folder Codex trusts and the record's `root`.
const WORKTREE = (folder, root, { selected = 1, note = "Note: You’re in a subdirectory of a Git project. Trusting will apply to the repository root:" } = {}) =>
  ["", "  Folder access", `  ${folder}`, "", `  ${note}`, `  ${root}`, "", "  Trust this folder? Codex can read, edit, and run files here, subject to your permission settings. Folder settings can run code", "  automatically, even without a model request. Continue only if you trust these files. Your trust decision will be saved.", "", `${selected === 1 ? "›" : " "} 1. Trust and continue`, `${selected === 2 ? "›" : " "} 2. Quit`, "", "  enter continue · esc quit", ""].join("\n");

test("the startup gate with Codex's worktree variant: armed only when the repository root it names is the launch's root", (t) => {
  const home = tmp(t);
  const root = tmp(t);
  const wt = `${root}-wt`;
  const { file } = fakeCodex(root);
  let now = 1_000_000;
  const fresh = () => {
    relaunch(home, "me-alice", { cli: { name: "codex", path: file, version: "0.165.0" }, root, gate: { state: "armed", why: null, at: now }, folder: wt, tmux: { socket: SOCKET, session: "$1", pane: "%3" }, host: HOST, now: () => now });
    const gate = startGate(home, "me-alice", injectorAt({ now: () => now }));
    const read = (screen) => {
      now += 2000;
      gate.observe(readOf(screen));
      return gate.armed();
    };
    return { read, why: () => readLaunch(home, "me-alice").gate.why };
  };
  let x = fresh();
  assert.equal(x.read(WORKTREE(wt, root)), true);
  assert.equal(x.read(WORKTREE(wt, root, { selected: 2 })), true, "the selection may move");
  // The repository root shown changed, or the launch folder above the note: another dialog, off.
  for (const next of [WORKTREE(wt, `${root}/sub`), WORKTREE(`${wt}2`, root)]) {
    x = fresh();
    x.read(WORKTREE(wt, root));
    assert.equal(x.read(next), false, next);
    assert.equal(x.why(), "the startup dialog ended");
  }
  // Only the root counts: the worktree's own folder in the root's place is another folder.
  for (const first of [WORKTREE(root, wt), WORKTREE(wt, "/somewhere/else")]) {
    x = fresh();
    assert.equal(x.read(first), false, first);
    assert.equal(x.why(), "startup not observed");
  }
  // Another note: no known dialog (the plain one never takes a note), off.
  x = fresh();
  assert.equal(x.read(WORKTREE(wt, root, { note: "Note: You’re in a subdirectory of a Git project. Trusting will apply to every repository:" })), false);
  assert.equal(x.why(), "startup not observed");
});

test("the watch with the gate: armed, it reads every 2 s and the trust prompt is answerable; Codex's input box ends it for good, and the same prompt later is display-only", (t) => {
  const home = tmp(t);
  const dir = tmp(t);
  const { file } = fakeCodex(dir);
  relaunch(home, "me-alice", { cli: { name: "codex", path: file, version: "0.165.0" }, root: dir, gate: { state: "armed", why: null, at: 0 }, folder: dir, tmux: { socket: SOCKET, session: "$1", pane: "%3" }, host: HOST, now: () => 0 });
  let at = 0;
  const gate = startGate(home, "me-alice", injectorAt({ now: () => at }));
  const trust = TRUST(dir);
  let pane = { screen: trust, command: "node", keyAt: -Infinity, inputShown: false };
  const reads = [];
  const started = [];
  const owner = { tmux: "$1", pane: "%3", injector: processIdentity(process.pid) };
  const tick = waitWatch(home, "me-alice", { look: () => (reads.push(at), { ...pane, at }), unreadSince: () => null, owner: () => owner, gate, surface: { start: (r) => started.push(r) }, now: () => at });
  for (; at < 5000; at += 500) tick();
  assert.deepEqual(reads, [0, 2000, 4000], "every 2 s while armed");
  assert.equal(started.length, 1, "held at the second read");
  assert.equal(started[0].actionable, true, "answerable: armed, and Codex by the launch record");
  // Codex shows its input box: the gate is off for good, and the reads go back to every 15 s.
  pane = { ...pane, screen: "› ", inputShown: true };
  for (; at < 10_000; at += 500) tick();
  assert.equal(gate.armed(), false);
  assert.equal(readLaunch(home, "me-alice").gate.why, "ready");
  reads.length = 0;
  pane = { ...pane, screen: trust, inputShown: false };
  for (; at < 60_000; at += 500) tick();
  assert.ok(reads.length <= 4, "every 15 s");
  assert.equal(readOccurrence(home, "me-alice").actionable, false, "the same screen later: display-only");
});

test("the watch with the gate: a first read that ends it is display-only itself; Codex's input box ends it whatever the transcript holds; so does work under way", (t) => {
  const home = tmp(t);
  const dir = tmp(t);
  const { file } = fakeCodex(dir);
  const owner = { tmux: "$1", pane: "%3", injector: processIdentity(process.pid) };
  const cases = [
    [["some output", "The previous task asked: Do you want to proceed?", "› 1. Yes", "  2. No", "", "› Ask Codex to do anything"].join("\n"), true, "ready"],
    [["working", "", "• Working (3s • esc to interrupt)", ""].join("\n"), false, "ready"],
    [TRUST(dir, { folder: "/somewhere/else" }), false, "startup not observed"],
  ];
  for (const [screen, inputShown, why] of cases) {
    relaunch(home, "me-alice", { cli: { name: "codex", path: file, version: "0.165.0" }, root: dir, gate: { state: "armed", why: null, at: 0 }, folder: dir, tmux: { socket: SOCKET, session: "$1", pane: "%3" }, host: HOST, now: () => 0 });
    let at = 0;
    const gate = startGate(home, "me-alice", injectorAt({ now: () => at }));
    const started = [];
    const tick = waitWatch(home, "me-alice", { look: () => ({ screen, command: "node", keyAt: -Infinity, inputShown, at }), unreadSince: () => null, owner: () => owner, gate, surface: { start: (r) => started.push(r) }, now: () => at });
    for (; at <= 20_000; at += 500) tick();
    assert.equal(gate.armed(), false, screen);
    assert.equal(readLaunch(home, "me-alice").gate.why, why);
    assert.ok(started.every((r) => !r.actionable), "never answerable");
  }
});

test("hoptell tmux with a recorded Codex: the launch record names the pane, its process and the folder, armed; the agent runs the executable that was asked; a relaunch replaces the record", { skip: !hasTmux && "tmux not installed" }, async (t) => {
  const w = await world();
  const name = `gt${process.pid}`;
  const session = `hoptell-${name}`;
  t.after(async () => {
    spawnSync("tmux", ["kill-session", "-t", `=${session}`]);
    await w.close();
  });
  const dir = tmp(t);
  const { bin, file } = fakeCodex(dir);
  const env = { HOPTELL_PUSH: "", PATH: [bin, process.env.PATH].join(path.delimiter) };
  const r = await w.cli(["tmux", name, "--cwd", dir, "--", "codex"], env);
  assert.match(r.stderr, /attach with: tmux attach/);
  const rec = readLaunch(w.home, name);
  assert.ok(rec, "a launch record");
  const tm = (f) => execFileSync("tmux", ["display-message", "-p", "-t", rec.tmux.pane, f], { encoding: "utf8" }).trim();
  assert.deepEqual([rec.gate.state, rec.cli, rec.folder, rec.root], ["armed", { name: "codex", path: file, version: "0.165.0" }, dir, dir]);
  assert.deepEqual([rec.tmux.session, String(rec.host.pid), rec.tmux.socket], [tm("#{session_id}"), tm("#{pane_pid}"), tm("#{socket_path}")]);
  assert.deepEqual(rec.host, processIdentity(rec.host.pid));
  // Its injector found the record (written before the injector started) and the same server,
  // session, pane and process.
  const injectorPane = execFileSync("tmux", ["list-panes", "-t", `=${session}:injector`, "-F", "#{pane_id}"], { encoding: "utf8" }).trim();
  let out = "";
  for (let i = 0; i < 100 && !/startup trust gate/.test(out); i++, await sleep(50)) out = execFileSync("tmux", ["capture-pane", "-p", "-J", "-t", injectorPane], { encoding: "utf8" });
  assert.match(out, /the startup trust gate of this launch is armed \(Codex 0\.165\.0\)/);
  assert.equal(JSON.parse(fs.readFileSync(claimFileOf(w.home, name), "utf8")).launch, rec.id, "claimed by its injector");
  // Another injector of the same pane matches it with the real process identity, and is a restart: off.
  const g = startGate(w.home, name, { pane: rec.tmux.pane, pid: tm("#{pane_pid}"), session: tm("#{session_id}"), socket: tm("#{socket_path}") });
  assert.equal(g.launch?.id, rec.id, "the same server, session, pane and process");
  assert.equal(g.armed(), false);
  assert.equal(readLaunch(w.home, name).gate.why, "injector restarted");
  // The agent's command is the asked executable, by its path.
  let args = "";
  for (let i = 0; i < 40 && !args.includes(file); i++, await sleep(50)) args = spawnSync("ps", ["-o", "args=", "-p", tm("#{pane_pid}")], { encoding: "utf8" }).stdout + execFileSync("ps", ["-A", "-o", "args="], { encoding: "utf8" }).split("\n").filter((l) => l.includes(file)).join("\n");
  assert.ok(args.includes(file), args);
  // A relaunch: the earlier record never names the new pane.
  spawnSync("tmux", ["kill-session", "-t", `=${session}`]);
  const r2 = await w.cli(["tmux", name, "--cwd", dir, "--", "codex"], env);
  assert.match(r2.stderr, /attach with: tmux attach/);
  assert.notEqual(readLaunch(w.home, name).id, rec.id);
});

// ---- Claude Code 2.1.314 and agy 1.4.11 (design 10, trust buttons) ----------------------------

/** A stand-in for `cli` in `dir`/bin answering --version as `out` does, and sleeping otherwise. */
function fakeCli(dir, cli, out) {
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin, { recursive: true });
  const file = path.join(bin, cli);
  fs.writeFileSync(file, `#!/bin/sh\n[ "$1" = --version ] && echo '${out}' && exit 0\nexec sleep 60\n`, { mode: 0o755 });
  return { bin, file };
}
const UUID = "0b9c5e4e-6a51-4d6f-8f1e-3c2a7d9e1f00";

test("Claude Code and agy: their --version, and what the trust covers: a folder, a repository, a repository member, the home folder", (t) => {
  const dir = tmp(t);
  const run = (out) => () => out;
  assert.equal(cliVersion("/x", { env: {}, cli: "claude", run: run("2.1.314 (Claude Code)\n") }), "2.1.314");
  assert.equal(cliVersion("/x", { env: {}, cli: "claude", run: run("2.1.314\n") }), null, "only the exact form");
  assert.equal(cliVersion("/x", { env: {}, cli: "agy", run: run("1.4.11\n") }), "1.4.11");
  assert.equal(cliVersion("/x", { env: {}, cli: "agy", run: run("agy 1.4.11\n") }), null);
  assert.equal(cliVersion("/x", { env: {}, cli: "gemini", run: run("1.4.11\n") }), null);
  const plain = path.join(dir, "plain");
  fs.mkdirSync(plain);
  const repo = path.join(dir, "repo");
  fs.mkdirSync(path.join(repo, "sub"), { recursive: true });
  git(repo, "init", "-q");
  git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "x");
  const wt = path.join(dir, "wt");
  git(repo, "worktree", "add", "-q", wt);
  const o = { envPath: process.env.PATH, home: path.join(dir, "home") };
  fs.mkdirSync(o.home);
  assert.deepEqual(trustScopeOf("claude", plain, o), { root: plain, kind: "folder" });
  assert.deepEqual(trustScopeOf("claude", repo, o), { root: repo, kind: "repo" });
  assert.deepEqual(trustScopeOf("claude", wt, o), { root: repo, kind: "repo-member" });
  assert.deepEqual(trustScopeOf("claude", path.join(repo, "sub"), o), { root: repo, kind: "repo-member" });
  assert.deepEqual(trustScopeOf("claude", o.home, o), { root: o.home, kind: "home" });
  assert.deepEqual(trustScopeOf("agy", wt, o), { root: wt, kind: "folder" }, "agy: the folder it shows");
  assert.deepEqual(trustScopeOf("codex", wt, o), { root: repo, kind: null });
  assert.equal(trustScopeOf("claude", path.join(dir, "missing"), o), null);
});

test("arming Claude Code and agy: a fresh launch of a recorded version; their own fresh rules; the home folder and anything else off", (t) => {
  const dir = tmp(t);
  const c = fakeCli(dir, "claude", "2.1.314 (Claude Code)");
  const a = fakeCli(dir, "agy", "1.4.11");
  const env = { PATH: [c.bin, process.env.PATH].join(path.delimiter), HOME: path.join(dir, "home") };
  fs.mkdirSync(env.HOME);
  const g = launchGate(["claude", "--permission-mode", "plan", "fix the tests"], { folder: dir, env, now: () => 7 });
  assert.deepEqual(g, { cli: { name: "claude", path: c.file, version: "2.1.314" }, root: dir, scope: "folder", built: null, gate: { state: "armed", why: null, at: 7 }, argv: [c.file, "--permission-mode", "plan", "fix the tests"] });
  const ga = launchGate(["agy", "--mode", "plan", "--sandbox", "--dangerously-skip-permissions", "-i", "review this"], { folder: dir, env, now: () => 7 });
  assert.deepEqual([ga.cli, ga.root, ga.scope, ga.gate.state], [{ name: "agy", path: a.file, version: "1.4.11" }, dir, "folder", "armed"]);
  const off = (cmd, o = {}) => {
    const r = launchGate(cmd, { folder: dir, env, now: () => 7, ...o });
    if (r.gate.state === "off") assert.deepEqual(r.argv, cmd, "unchanged");
    return r.gate.state === "off" ? r.gate.why : "armed";
  };
  assert.equal(off(["claude"], { folder: env.HOME }), "the home folder (Claude Code trusts it for the session only)");
  // A version the table was not recorded on (2.1.312 shows the same dialog): armed all the same.
  fs.writeFileSync(c.file, "#!/bin/sh\n[ \"$1\" = --version ] && echo '2.1.312 (Claude Code)' && exit 0\nexec sleep 60\n", { mode: 0o755 });
  assert.equal(off(["claude"]), "armed");
  fs.writeFileSync(c.file, "#!/bin/sh\n[ \"$1\" = --version ] && echo '2.1.314 (Claude Code)' && exit 0\nexec sleep 60\n", { mode: 0o755 });
  // Claude Code's fresh rules.
  // A team member's --allowedTools: exactly the list hoptell builds, before another option.
  const V = MEMBER_ALLOWED_TOOLS;
  assert.deepEqual(V.split(","), ["mcp__plugin_hoptell_hoptell__", "mcp__hoptell__"].flatMap((p) => [...RUN_TOOLS, "check_snapshot"].map((x) => p + x)), "lib/mcp.js RUN_TOOLS and check_snapshot under both ids");
  assert.doesNotMatch(V, /send_file|send_review_set|send_transfer|ask_owner|spawn_agent|_agent|\*/);
  for (const ok of [["--allowedTools", V, "--session-id", UUID, "Read your task."], [`--allowedTools=${V}`, "--append-system-prompt", "Be brief.", "Read your task."]]) assert.equal(claudeFreshProblem(ok, { built: { session_id: UUID } }), null, ok.join(" "));
  for (const x of [["--allowedTools", "Bash", "--model", "x"], ["--allowedTools", `${V},Bash`, "--model", "x"], ["--allowedTools", `${V},mcp__hoptell__send_file`, "--model", "x"], ["--allowedTools", V.split(",").slice(1).join(","), "--model", "x"], ["--allowedTools", V, "Read your task."], ["--allowedTools", V]]) assert.equal(claudeFreshProblem(x), "an --allowedTools list hoptell did not build", x.join(" "));
  assert.equal(claudeFreshProblem(["--allowed-tools", V, "--model", "x"]), "the flag --allowed-tools");
  assert.equal(off(["claude", "--allowedTools", "Bash", "--model", "x", "fix the tests"]), "not a fresh interactive launch: an --allowedTools list hoptell did not build");
  assert.equal(off(["claude", "--allowedTools", V, "--model", "x", "fix the tests"]), "armed");
  // The reviewer preset's --disallowedTools: exactly NO_EDIT_TOOLS, before another option.
  assert.equal(claudeFreshProblem(["--disallowedTools", NO_EDIT_TOOLS, "--permission-mode", "manual", "--allowedTools", V, "--session-id", UUID, "Read your task."], { built: { session_id: UUID } }), null);
  for (const x of [["--disallowedTools", "Edit", "--model", "x"], ["--disallowedTools", `${NO_EDIT_TOOLS},Bash`, "--model", "x"], ["--disallowedTools", NO_EDIT_TOOLS, "Read your task."], ["--disallowedTools", NO_EDIT_TOOLS]]) assert.equal(claudeFreshProblem(x), "a --disallowedTools list hoptell did not build", x.join(" "));
  for (const ok of [[], ["--permission-mode", "acceptEdits"], ["--permission-mode=manual", "--model", "opus", "--effort", "high"], ["--append-system-prompt", "Be brief.", "Review what me-lead sends."], ["-n", "me-alice"], ["--name=me-alice"]]) assert.equal(claudeFreshProblem(ok, { name: "me-alice" }), null, ok.join(" "));
  const claudeOff = {
    "--permission-mode bypassPermissions": [["--permission-mode", "bypassPermissions"]],
    "a --session-id hoptell did not assign to this launch": [["--session-id", UUID]],
    "another session name": [["-n", "me-bob"]],
    "a subcommand or a one-word prompt": [["mcp"], ["--model", "x", "hello"]],
    "a subcommand or a prompt before other words": [["a prompt here", "--model", "x"]],
    "-n without a value": [["-n"]],
  };
  for (const flag of ["-c", "--continue", "-r", "--resume", "--fork-session", "--add-dir", "--settings", "--setting-sources", "--mcp-config", "--strict-mcp-config", "--plugin-dir", "--dangerously-skip-permissions", "-p", "--print", "--bg"]) claudeOff[`the flag ${flag}`] = [[flag, "x y"]];
  for (const [why, cases] of Object.entries(claudeOff)) {
    for (const x of cases) {
      assert.equal(claudeFreshProblem(x, { name: "me-alice" }), why, x.join(" "));
      assert.equal(off(["claude", ...x], { name: "me-alice" }), `not a fresh interactive launch: ${why}`, x.join(" "));
    }
  }
  // agy's: the prompt is -i's value; a bare word is not one.
  for (const ok of [["--mode", "accept-edits"], ["--mode=auto", "--model", "gemini-4"], ["--prompt-interactive", "do it"]]) assert.equal(agyFreshProblem(ok), null, ok.join(" "));
  assert.equal(agyFreshProblem(["-i", "x", "trailing"]), "a subcommand or another word");
  assert.equal(agyFreshProblem(["--mode", "yolo"]), "--mode yolo");
  for (const flag of ["--settings", "--add-dir", "-c", "--continue", "--conversation", "--project", "--new-project", "--agent", "-p", "--print", "--prompt", "--remote-control"]) assert.equal(agyFreshProblem([flag, "x"]), `the flag ${flag}`, flag);
  assert.equal(off(["agy", "--settings", '{"trustedWorkspaces":["/"]}']), "not a fresh interactive launch: the flag --settings");
  // Wrappers are none of the three, whatever follows them; Part C's forms with them.
  for (const w of [["env", "claude"], ["env", "-u", "CODEX_HOME", "CODEX_HOME=/x", "codex"], ["sh", "-c", "agy"], ["npx", "claude"]]) assert.equal(off(w), "not codex, claude or agy", w.join(" "));
  assert.equal(off(["codex", "--no-daemon"]), "not a fresh interactive launch: the flag --no-daemon");
});

test("a team member's launch: the CLI and its words from `built`; fresh and restart-fresh armed, resume off; --session-id only the one assigned; the record keeps built's digest", (t) => {
  const dir = tmp(t);
  const c = fakeCli(dir, "claude", "2.1.314 (Claude Code)");
  const env = { PATH: [c.bin, process.env.PATH].join(path.delimiter), HOME: os.tmpdir() };
  // Part R's fresh line (design 10, containment and resume), composed: its --session-id and -n.
  const argv = ["claude", "--session-id", UUID, "-n", "me-alice", "--permission-mode", "plan", "--effort", "high", "--append-system-prompt", "Role text.", "Read your task."];
  const gate = (built, cmd = argv, name = "me-alice") => launchGate(cmd, { folder: dir, env, built, name, now: () => 7 });
  for (const mode of ["fresh", "restart-fresh"]) {
    const g = gate({ cli: "claude", mode, argv, session_id: UUID });
    assert.equal(g.gate.state, "armed", mode);
    assert.deepEqual(g.built, { cli: "claude", mode, argv: crypto.createHash("sha256").update(JSON.stringify(argv)).digest("hex") });
  }
  const why = (...a) => gate(...a).gate.why;
  assert.equal(why({ cli: "claude", mode: "resume", argv, session_id: UUID }), "a resumed conversation");
  assert.equal(why({ cli: "claude", mode: "fresh", argv, session_id: "1b9c5e4e-6a51-4d6f-8f1e-3c2a7d9e1f00" }), "not a fresh interactive launch: a --session-id hoptell did not assign to this launch");
  assert.equal(why({ cli: "claude", mode: "fresh", argv, session_id: null }), "not a fresh interactive launch: a --session-id hoptell did not assign to this launch");
  const upper = argv.map((x) => (x === UUID ? UUID.toUpperCase() : x));
  assert.equal(why({ cli: "claude", mode: "fresh", argv: upper, session_id: UUID.toUpperCase() }, upper), "not a fresh interactive launch: a --session-id hoptell did not assign to this launch", "a canonical, lowercase UUID only");
  assert.equal(why({ cli: "claude", mode: "fresh", argv, session_id: UUID }, argv, "me-bob"), "not a fresh interactive launch: another session name");
  // The words must be built's exactly: a wrapper or anything added in between turns it off.
  assert.equal(why({ cli: "claude", mode: "fresh", argv, session_id: UUID }, ["env", ...argv]), "not the launch hoptell built");
  assert.equal(why({ cli: "claude", mode: "fresh", argv, session_id: UUID }, [...argv.slice(0, -1), "--add-dir", "/", argv.at(-1)]), "not the launch hoptell built");
  assert.equal(why({ cli: "codex", mode: "fresh", argv, session_id: null }), "not the launch hoptell built", "another CLI than its command");
  assert.equal(why({ cli: "claude", mode: "fresh", argv }), "not the launch hoptell built", "not a builder's account");
  // Typed by hand (no built): a --session-id turns it off.
  assert.equal(why(null), "not a fresh interactive launch: a --session-id hoptell did not assign to this launch");
  // The record keeps scope and built; armed Claude Code needs its scope.
  const home = tmp(t);
  const g = gate({ cli: "claude", mode: "fresh", argv, session_id: UUID });
  const rec = writeLaunch(home, "me-alice", { cli: g.cli, root: g.root, scope: g.scope, built: g.built, gate: g.gate, folder: dir, tmux: { socket: SOCKET, session: "$1", pane: "%3" }, host: HOST });
  assert.deepEqual(readLaunch(home, "me-alice"), rec);
  fs.writeFileSync(launchFileOf(home, "me-alice"), JSON.stringify({ ...rec, scope: null }));
  assert.equal(readLaunch(home, "me-alice"), null, "armed Claude Code without its scope");
  fs.writeFileSync(launchFileOf(home, "me-alice"), JSON.stringify({ ...rec, scope: "home" }));
  assert.equal(readLaunch(home, "me-alice"), null, "home is never armed");
  fs.writeFileSync(launchFileOf(home, "me-alice"), JSON.stringify({ ...rec, built: { ...rec.built, argv: "x" } }));
  assert.equal(readLaunch(home, "me-alice"), null);
  // The note that the agent ended: only for the launch whose record is there.
  writeLaunch(home, "me-alice", { cli: g.cli, root: g.root, scope: g.scope, built: g.built, gate: g.gate, folder: dir, tmux: { socket: SOCKET, session: "$1", pane: "%3" }, host: HOST });
  const id = readLaunch(home, "me-alice").id;
  assert.equal(readExit(home, "me-alice", id), null);
  assert.equal(writeExit(home, "me-alice", id, "130", { now: () => 9 }), true);
  assert.deepEqual(readExit(home, "me-alice", id), { status: 130, at: 9 });
  assert.equal(readExit(home, "me-alice", "f".repeat(32)), null, "another launch's");
  writeExit(home, "me-alice", id, "x");
  assert.equal(readExit(home, "me-alice", id).status, null, "a status that is not one: unknown");
});

test("Claude Code's install is a link to a file named by its version: it resolves and reports 2.1.314, and the gate arms from the launch, never the pane's command", (t) => {
  const dir = tmp(t);
  const versions = path.join(dir, "share", "claude", "versions");
  fs.mkdirSync(versions, { recursive: true });
  const real = path.join(versions, "2.1.314");
  fs.writeFileSync(real, "#!/bin/sh\n[ \"$1\" = --version ] && echo '2.1.314 (Claude Code)' && exit 0\nexec sleep 60\n", { mode: 0o755 });
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  fs.symlinkSync(real, path.join(bin, "claude"));
  const g = launchGate(["claude"], { folder: dir, env: { PATH: [bin, process.env.PATH].join(path.delimiter), HOME: os.tmpdir() } });
  assert.deepEqual([g.gate.state, g.cli.name, g.cli.version, path.basename(g.argv[0])], ["armed", "claude", "2.1.314", "claude"]);
});

test("the gate over a Claude Code and an agy launch: the dialog naming the launch folder arms it, the selection may move, another frame ends it", (t) => {
  const screens = JSON.parse(fs.readFileSync(new URL("./fixtures/prompt-screens.json", import.meta.url), "utf8")).screens;
  for (const [cli, version, name, moved] of [["claude", "2.1.314", "claude-2.1.314-trust-w120", "claude-2.1.314-trust-selected-yes-w120"], ["agy", "1.4.11", "agy-1.4.11-trust-w120", "agy-1.4.11-trust-selected-no-w120"]]) {
    const home = tmp(t);
    const read = (n) => {
      const s = screens.find((x) => x.name === n);
      const screen = s.rows.join("\n");
      return { screen, inputShown: false, prompt: classifyPrompt(screen, { cli, version, cursor: s.cursor }) };
    };
    const first = read(name);
    const folder = first.prompt.folders[0];
    const launch = (o = {}) => relaunch(home, "me-alice", { cli: { name: cli, path: `/x/${cli}`, version }, root: folder, scope: "folder", gate: { state: "armed", why: null, at: 1 }, folder, tmux: { socket: SOCKET, session: "$1", pane: "%3" }, host: HOST, ...o });
    let r = launch();
    let g = startGate(home, "me-alice", injectorAt({ now: () => r.started }));
    // agy 1.4.12 draws its sign-in splash for a moment before the dialog: still drawing (Claude
    // Code has none: the same screen turns its gate off).
    const splash = ["", "     ▄▀▀▄", "    ▀▀▀▀▀▀", "   ▀▀▀▀▀▀▀▀", "  ▄▀▀    ▀▀▄", " ▄▀▀      ▀▀▄", "", " Welcome to the Antigravity CLI. You are currently not signed in.", "", " ⣷  Signing in...", ""].join("\n");
    if (cli === "agy") g.observe({ screen: splash, inputShown: false, prompt: classifyPrompt(splash, { cli, version }) });
    g.observe(first);
    g.observe(read(moved));
    assert.deepEqual([g.armed(), g.cli(), g.version()], [true, cli, version], cli);
    g.observe(read(cli === "claude" ? "claude-2.1.314-trust-subdir-w120" : "agy-1.4.11-trust-subdir-w120"));
    assert.equal(readLaunch(home, "me-alice").gate.why, "the startup dialog ended", cli);
    // A launch folder the dialog does not name (Claude Code's repository root, for instance): never armed.
    r = launch({ folder: "/private/tmp/elsewhere" });
    g = startGate(home, "me-alice", injectorAt({ now: () => r.started }));
    g.observe(first);
    assert.equal(readLaunch(home, "me-alice").gate.why, "startup not observed", cli);
    // The splash with any other row, or on another CLI: not still drawing.
    for (const other of [`${splash}\n Opened /tmp/x`, splash.replace(" Welcome to the Antigravity CLI. You are currently not signed in.", "")]) {
      r = launch();
      g = startGate(home, "me-alice", injectorAt({ now: () => r.started }));
      g.observe({ screen: other, inputShown: false, prompt: null });
      assert.equal(readLaunch(home, "me-alice").gate.why, "startup not observed", cli);
    }
    r = launch();
    g = startGate(home, "me-alice", injectorAt({ now: () => r.started }));
    g.observe({ screen: splash, inputShown: false, prompt: null });
    assert.equal(readLaunch(home, "me-alice").gate.state, cli === "agy" ? "armed" : "off", cli);
  }
});

test("the note that an agent ended is its own launch's: a late prompt-wait of an earlier launch whose name was reused writes nothing", (t) => {
  const home = tmp(t);
  const o = { cli: { name: "claude", path: "/x/claude", version: "2.1.314" }, root: "/x", scope: "folder", gate: { state: "armed", why: null, at: 1 }, folder: "/x", tmux: { socket: SOCKET, session: "$1", pane: "%3" }, host: HOST };
  const a = relaunch(home, "me-alice", o);
  const b = relaunch(home, "me-alice", { ...o, tmux: { ...o.tmux, session: "$2", pane: "%4" } });
  assert.notEqual(a.id, b.id);
  assert.equal(writeExit(home, "me-alice", a.id, "0"), false, "A's prompt-wait, late");
  assert.equal(readExit(home, "me-alice", b.id), null);
  assert.equal(writeExit(home, "me-alice", "-", "0"), false, "no launch id (a window started before this release)");
  assert.equal(writeExit(home, "me-alice", undefined, "0"), false);
  assert.equal(readExit(home, "me-alice", b.id), null);
  assert.equal(writeExit(home, "me-alice", b.id, "0"), true);
  assert.equal(readExit(home, "me-alice", b.id).status, 0);
  // The id hoptell tmux made before the pane started is the record's.
  const id = "a".repeat(32);
  assert.equal(relaunch(home, "me-alice", { ...o, id }).id, id);
  assert.throws(() => relaunch(home, "me-alice", { ...o, id: "x" }), /not a launch id/);
});
