// The startup folder-trust gate of a Codex launch (design 9, C, v2 correction 4): the launch record,
// arming only for a verified fresh launch of a recorded Codex version, the injector's recovery and
// turning it off for good. No real Codex: stand-in scripts named codex. A private tmux server
// (TMUX_TMPDIR) and temporary homes; sessions are ended by their exact names.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { DIALOG_MS, FIRST_READ_MS, GAP_MS, claimFileOf, codexVersion, freshProblem, launchFileOf, launchGate, readLaunch, resolveCli, startGate, trustRootOf, writeLaunch } from "../lib/startgate.js";
import { CARD_MS, START_MS } from "../lib/promptcards.js";
import { classifyPrompt } from "../lib/prompts.js";
import { waitWatch } from "../lib/tmux.js";
import { processIdentity } from "../lib/host.js";
import { readOccurrence } from "../lib/waits.js";
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

test("arming: only a launch of Codex on a recorded version, run by the path that was asked; anything else is off and unchanged", (t) => {
  const dir = tmp(t);
  const { bin, file } = fakeCodex(dir);
  const env = { PATH: [bin, process.env.PATH].join(path.delimiter), HOME: os.tmpdir() };
  const g = launchGate(["codex", "-m", "gpt-5", "--sandbox=workspace-write"], { folder: dir, env, now: () => 7 });
  assert.deepEqual(g, { cli: { name: "codex", path: file, version: "0.165.0" }, root: dir, gate: { state: "armed", why: null, at: 7 }, argv: [file, "-m", "gpt-5", "--sandbox=workspace-write"] });
  const off = (cmd, e = env) => {
    const r = launchGate(cmd, { folder: dir, env: e, now: () => 7 });
    assert.deepEqual(r.argv, cmd, "unchanged");
    return [r.gate.state, r.gate.why];
  };
  assert.deepEqual(off(["claude"]), ["off", "not codex"]);
  assert.deepEqual(off(["codex"], { PATH: path.join(dir, "none") }), ["off", "codex not found"]);
  const other = fakeCodex(path.join(dir, "o"), "0.166.0");
  assert.deepEqual(off([other.file]), ["off", "version not recorded"]);
  fs.writeFileSync(other.file, "#!/bin/sh\necho something else\n", { mode: 0o755 });
  assert.deepEqual(off([other.file]), ["off", "version unknown"]);
  assert.deepEqual(launchGate(["codex"], { folder: dir, env, root: () => null }).gate.why, "folder unknown");
  // Only the fresh interactive launch the prompt table was recorded on.
  for (const ok of [[], ["-s", "read-only"], ["--sandbox", "workspace-write", "-a", "never"], ["--ask-for-approval=on-request", "--model=o3"], ["-m", "gpt-5"], ["--full-auto"], ["--dangerously-bypass-approvals-and-sandbox"]]) assert.equal(freshProblem(ok), null, ok.join(" "));
  const notFresh = {
    "another folder (-C/--cd)": [["-C", "/different"], ["--cd=/different"], ["--cd", "/different"], ["-C/different"], ["-m", "x", "-C", "/d"]],
    "a subcommand or a prompt": [["resume", "--last"], ["exec", "hi"], ["fix the tests"], ["-m", "x", "hello"]],
    "the flag -c": [["-c", "projects.x.trust_level=trusted"]],
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

const TRUST = (dir, { selected = 1, folder = dir } = {}) => ["  Folder access", `  ${folder}`, "  Trust this folder? Codex can read, edit, and run files here, subject to your permission settings.", "", `${selected === 1 ? "›" : " "} 1. Trust and continue`, `${selected === 2 ? "›" : " "} 2. Quit`, "", "  enter continue · esc quit", ""].join("\n");
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
