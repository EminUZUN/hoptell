// Agent runs (design 7.1): run records, the detached supervisor, process identity, stop, sweep,
// pruning, and tmux runs. Every test uses a temporary HOPTELL_HOME; processes are signalled only
// by exact pid; tmux sessions get a random name prefix and are ended by exact name.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { agentsWorld } from "./agents-helpers.js";
import { agentCommand, launchDetached } from "../lib/tmux.js";
import { readAudit, withAgentsLock } from "../lib/agents.js";
import { TREE_HARD, TREE_MAX, createRunFiles, isLive, processTree, listRuns, newRunId, prune, readRun, runPaths, signalChecked, startSupervisor, stopProcess, stopRun, supervise, sweep, updateRun, agentEnv, cutUtf8 } from "../lib/agentruns.js";
import { currentBoot, descendantIdentities, identityState, parsePsTable, processIdentity, processInfo, processTable, sameIdentity } from "../lib/host.js";
import { writeRecord } from "../lib/locks.js";

// A run starts its tmux session with a sterile environment, so it is always on the default tmux
// server. The test's own tmux calls must reach that same server, even when the suite itself runs
// inside tmux: an inherited TMUX or TMUX_TMPDIR would point them at another server instead.
delete process.env.TMUX;
delete process.env.TMUX_PANE;
delete process.env.TMUX_TMPDIR;

const FAKE = fileURLToPath(new URL("./fixtures/fake-agent-cli.mjs", import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The digest a run records for its checked CLI (the file the command resolves to). */
const fileDigest = (command) => {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(fs.realpathSync(command))).digest("hex");
  } catch {
    return "0".repeat(64); // a missing CLI: the supervisor reports cli_missing
  }
};

/** Create a run record ("starting") and its files the way a spawn does, without the profile checks. */
export async function makeRun(w, { mode = "headless", plan, task = "the task", name = `t-${crypto.randomBytes(2).toString("hex")}`, lifetimeMinutes = 5, graceMs = 300, resultBytes = 65536, pass = [], extra = {} } = {}) {
  const run = newRunId();
  await withAgentsLock(w.home, () =>
    createRunFiles(w.home, {
      run,
      profile: "test",
      profileDigest: "0".repeat(64),
      cli: "codex",
      mode,
      name,
      roles: ["reviewer", "spawned"],
      wireNames: { local: `me-${name}` },
      defaultAlias: "local",
      cwd: w.work,
      spawner: { name: "owner", wireName: "me-owner" },
      state: "starting",
      created: new Date().toISOString(),
      lifetimeMinutes,
      graceMs,
      limits: { resultBytes, taskBytes: 32768 },
      pass,
      plan: plan ?? { command: process.execPath, args: [FAKE, "echo"], stdin: "task", result: { from: "stdout" } },
      taskDigest: crypto.createHash("sha256").update(task).digest("hex"),
      cliDigest: fileDigest((plan ?? {}).cli?.command ?? (plan ?? {}).command ?? process.execPath),
      ...extra,
    }),
  );
  const p = runPaths(w.home, run);
  fs.writeFileSync(p.task, task, { mode: 0o600 });
  fs.writeFileSync(p.env, "HOPTELL_PUSH=listener\n", { mode: 0o600 });
  fs.writeFileSync(p.relays, "{}", { mode: 0o600 });
  return { run, p, name };
}

/** A process's identity once it can be read (a just-started process may not be listed yet). */
async function identityWhenReadable(pid, ms = 10_000) {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error(`not a pid: ${pid}`);
  for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) {
    const id = processIdentity(pid);
    if (id && sameIdentity(id)) return id;
  }
  return null;
}

/** Wait until the run record's tree holds `pid` (the supervisor recorded and persisted it). */
async function recorded(w, run, pid, ms = 15_000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) if (readRun(w.home, run)?.tree?.some((x) => x.pid === pid)) return true;
  return false;
}

/** The supervisor's environment as a spawn would pass it, plus whatever a test adds. */
const supEnv = (w, run, extra = {}) => ({ PATH: process.env.PATH, HOME: w.homedir, HOPTELL_ENV: runPaths(w.home, run).env, HOPTELL_HOME: w.home, HOPTELL_NOTIFY: "off", ...extra });

/**
 * Wait until the run's record reaches one of the states and its supervisor has exited (it
 * delivers and removes the run's settings files after recording the end).
 */
async function until(w, run, states, ms = 20_000) {
  const end = Date.now() + ms;
  for (;;) {
    const r = readRun(w.home, run);
    if (r && states.includes(r.state) && !(r.supervisor && sameIdentity(r.supervisor))) return readRun(w.home, run);
    if (Date.now() > end) throw new Error(`run ${run} is ${r?.state}, not ${states.join("/")}`);
    await sleep(50);
  }
}

/** Kill a process this test started, by exact pid, after checking its identity. */
function cleanup(identity) {
  if (identity && sameIdentity(identity)) signalChecked(identity, "SIGKILL", { group: true });
}

test("headless: the answer from stdout, the CLI's answer file and the JSON field; ended runs keep their result", async (t) => {
  const w = agentsWorld(t);
  const a = await makeRun(w);
  let rec = await startSupervisor(w.home, a.run, { env: supEnv(w, a.run) });
  assert.ok(["running", "exited"].includes(rec.state), rec.state);
  rec = await until(w, a.run, ["exited"]);
  assert.equal(fs.readFileSync(a.p.result, "utf8"), "answer: the task");
  assert.deepEqual(rec.exit, { code: 0, signal: null });
  assert.equal(rec.result.bytes, "answer: the task".length);
  assert.equal(rec.result.digest, crypto.createHash("sha256").update("answer: the task").digest("hex"));
  // Its identities were recorded, with the boot.
  for (const k of ["supervisor", "agent"]) {
    assert.ok(Number.isSafeInteger(rec[k].pid) && rec[k].start && rec[k].uid === process.getuid(), k);
    assert.equal(rec[k].boot, currentBoot());
  }
  // The settings files are removed at the end; task, output and result stay.
  assert.equal(fs.existsSync(a.p.relays), false);
  assert.equal(fs.existsSync(a.p.env), false);
  assert.ok(fs.existsSync(a.p.task) && fs.existsSync(a.p.output));
  assert.equal(fs.statSync(a.p.dir).mode & 0o777, 0o700);

  const b = await makeRun(w, { plan: { command: process.execPath, args: [FAKE, "file", runPaths(w.home, "r_0000000000000000").result], stdin: "task", result: { from: "file" } } });
  // (the plan names the run's own result file)
  await updateRun(w.home, b.run, (r) => {
    r.plan.args[2] = b.p.result;
  });
  await startSupervisor(w.home, b.run, { env: supEnv(w, b.run) });
  await until(w, b.run, ["exited"]);
  assert.equal(fs.readFileSync(b.p.result, "utf8"), "file answer: the task");
  assert.equal(fs.readFileSync(b.p.output, "utf8"), "progress\n");

  const c = await makeRun(w, { plan: { command: process.execPath, args: [FAKE, "json"], stdin: "task", result: { from: "json", field: "result" } } });
  await startSupervisor(w.home, c.run, { env: supEnv(w, c.run) });
  await until(w, c.run, ["exited"]);
  assert.equal(fs.readFileSync(c.p.result, "utf8"), "json answer: the task");
  const ev = readAudit(w.home).filter((e) => e.run === a.run).map((e) => e.event);
  assert.deepEqual(ev, ["started", "ended"]);
});

test("headless: truncation, a non-zero exit, a crash, stdout over the cap", async (t) => {
  const w = agentsWorld(t);
  const a = await makeRun(w, { task: "é".repeat(50), resultBytes: 21 });
  await startSupervisor(w.home, a.run, { env: supEnv(w, a.run) });
  let rec = await until(w, a.run, ["exited"]);
  const kept = fs.readFileSync(a.p.result);
  assert.ok(kept.length <= 21 && kept.length >= 20, String(kept.length));
  assert.doesNotThrow(() => new TextDecoder("utf-8", { fatal: true }).decode(kept), "cut at a character boundary");
  assert.match(rec.result.notes.join(), /cut from 108 to \d+ bytes/);

  const b = await makeRun(w, { plan: { command: process.execPath, args: [FAKE, "exit3"], stdin: "task", result: { from: "stdout" } } });
  await startSupervisor(w.home, b.run, { env: supEnv(w, b.run) });
  rec = await until(w, b.run, ["exited"]);
  assert.deepEqual(rec.exit, { code: 3, signal: null });
  assert.equal(fs.readFileSync(b.p.result, "utf8"), "partial");

  const c = await makeRun(w, { plan: { command: process.execPath, args: [FAKE, "crash"], stdin: "task", result: { from: "stdout" } } });
  await startSupervisor(w.home, c.run, { env: supEnv(w, c.run) });
  rec = await until(w, c.run, ["exited"]);
  assert.deepEqual(rec.exit, { code: null, signal: "SIGKILL" });
  assert.equal(fs.readFileSync(c.p.result, "utf8"), "before crash");

  const d = await makeRun(w, { plan: { command: process.execPath, args: [FAKE, "big", String(10 * 1024 * 1024 + 4096)], stdin: "task", result: { from: "stdout" } } });
  await startSupervisor(w.home, d.run, { env: supEnv(w, d.run) });
  rec = await until(w, d.run, ["exited"], 60_000);
  assert.equal(fs.statSync(d.p.output).size, 10 * 1024 * 1024);
  assert.match(rec.result.notes.join(), /stdout was cut at 10485760 bytes \(4096 bytes discarded\)/);
  assert.equal(rec.result.bytes, 65536);

  // A CLI that cannot be started fails the run.
  const e = await makeRun(w, { plan: { command: path.join(w.base, "no-such-cli"), args: [], stdin: "task", result: { from: "stdout" } } });
  await startSupervisor(w.home, e.run, { env: supEnv(w, e.run) });
  rec = await until(w, e.run, ["failed"]);
  assert.equal(rec.error, "cli_missing");
});

test("headless: lifetime expiry sends SIGTERM, then SIGKILL; a stop keeps the partial result with a note", async (t) => {
  const w = agentsWorld(t);
  const a = await makeRun(w, { plan: { command: process.execPath, args: [FAKE, "stubborn"], stdin: "task", result: { from: "stdout" } }, lifetimeMinutes: 0.02, graceMs: 500 });
  await startSupervisor(w.home, a.run, { env: supEnv(w, a.run) });
  let rec = await until(w, a.run, ["expired", "lost"]);
  t.after(() => cleanup(rec.agent));
  assert.equal(rec.state, "expired");
  assert.equal(rec.exit.signal, "SIGKILL", "SIGTERM was ignored, so SIGKILL ended it");
  assert.equal(sameIdentity(rec.agent), false);
  assert.match(rec.result.notes.join(), /lifetime ran out: the result is partial/);
  assert.equal(fs.readFileSync(a.p.result, "utf8"), "partial answer");

  const b = await makeRun(w, { plan: { command: process.execPath, args: [FAKE, "sleep"], stdin: "task", result: { from: "stdout" } } });
  rec = await startSupervisor(w.home, b.run, { env: supEnv(w, b.run) });
  t.after(() => cleanup(readRun(w.home, b.run)?.agent));
  assert.equal(rec.state, "running");
  await sleep(300);
  const r = await stopRun(w.home, b.run, { by: "test", deps: { waitMs: 5000 } });
  assert.ok(["stopping", "stopped"].includes(r.state), r.state);
  rec = await until(w, b.run, ["stopped", "lost"]);
  assert.equal(rec.state, "stopped");
  assert.equal(rec.stoppedBy, "test");
  assert.equal(rec.exit.signal, "SIGTERM");
  assert.match(rec.result.notes.join(), /stopped: the result is partial/);
  assert.equal(fs.readFileSync(b.p.result, "utf8"), "partial answer");
  const ended = readAudit(w.home).find((e) => e.run === b.run && e.event === "ended");
  assert.equal(ended.state, "stopped");
  assert.equal(ended.stoppedBy, "test");
});

test("teardown: a process the agent starts in a session of its own ends with the run, after a stop and after a normal exit (by exact pid, identity checked)", async (t) => {
  const w = agentsWorld(t);
  for (const mode of ["orphan", "orphan-wait"]) {
    const pidfile = path.join(w.base, `${mode}.pid`);
    const go = path.join(w.base, `${mode}.go`);
    const a = await makeRun(w, { plan: { command: process.execPath, args: [FAKE, mode, pidfile, go], stdin: "task", result: { from: "stdout" } } });
    await startSupervisor(w.home, a.run, { env: supEnv(w, a.run) });
    t.after(() => cleanup(readRun(w.home, a.run)?.agent));
    for (const end = Date.now() + 10_000; !fs.existsSync(pidfile) && Date.now() < end; ) await sleep(50);
    const orphan = await identityWhenReadable(Number(fs.readFileSync(pidfile, "utf8")));
    t.after(() => {
      if (orphan && sameIdentity(orphan)) process.kill(orphan.pid, "SIGKILL");
    });
    assert.ok(orphan && sameIdentity(orphan), "the orphan runs");
    assert.notEqual(processInfo(orphan.pid).ppid, 0);
    // Recorded by the supervisor before the stop or the exit (no timing assumption).
    assert.ok(await recorded(w, a.run, orphan.pid), "the supervisor recorded the orphan");
    let rec;
    if (mode === "orphan") {
      await stopRun(w.home, a.run, { by: "test", deps: { waitMs: 5000 } });
      rec = await until(w, a.run, ["stopped", "lost"]);
      assert.equal(rec.state, "stopped");
    } else {
      fs.writeFileSync(go, "");
      rec = await until(w, a.run, ["exited", "lost"]);
      assert.equal(rec.state, "exited");
    }
    assert.equal(identityState(orphan), "different", `${mode}: the agent's own-session process outlived the run`);
    assert.match(fs.readFileSync(a.p.log, "utf8"), /ended 1 process\(es\) the agent left behind/);
  }
});

test("teardown: the tree is read in one table; a reused root pid, another user, a zombie or an unreadable row records nothing; gone entries are forgotten", () => {
  const boot = "b1";
  const root = { pid: 100, start: "Mon Oct 12 10:00:00 2026", uid: 501, boot };
  const row = (pid, ppid, start, extra = {}) => [pid, { pid, ppid, uid: 501, start, zombie: false, ...extra }];
  const table = new Map([row(100, 1, root.start), row(101, 100, "s101"), row(102, 101, "s102"), row(103, 100, "s103", { uid: 0 }), row(104, 100, "s104", { zombie: true }), row(105, 103, "s105"), [106, { pid: 106, unknown: true }]]);
  const ids = descendantIdentities(root, { table, boot });
  assert.deepEqual(ids.map((x) => x.pid).sort(), [101, 102, 105], "the root's user, through any parent, never a zombie or an unknown row");
  assert.deepEqual(ids.find((x) => x.pid === 102), { pid: 102, start: "s102", uid: 501, boot });
  // The root's pid now belongs to another process (another start): nothing below it is its tree.
  assert.deepEqual(descendantIdentities(root, { table: new Map([row(100, 1, "Tue Oct 13 09:00:00 2026"), row(101, 100, "s101")]), boot }), []);
  assert.deepEqual(descendantIdentities(root, { table: new Map([row(101, 100, "s101")]), boot }), [], "the root absent");
  assert.deepEqual(descendantIdentities(root, { table, boot: "b2" }), [], "another boot");
  assert.deepEqual(descendantIdentities(root, { table: null, boot }), [], "an unreadable table");
  // processTree: the root checked again after the read; forgetting only what the table shows gone.
  let rootOk = true;
  let t = table;
  let changes = 0;
  const gone = new Set();
  const tree = processTree(root, { table: () => t, boot: () => boot, check: (id) => (id === root ? rootOk : true), state: (id) => (gone.has(id.pid) ? "different" : "same"), onChange: () => changes++ });
  rootOk = false;
  tree.poll();
  assert.equal(tree.known.size, 0, "a root that no longer matches after the read adds nothing");
  rootOk = true;
  tree.poll();
  assert.deepEqual([...tree.known.keys()].sort(), [101, 102, 105]);
  assert.equal(changes, 1);
  tree.poll();
  assert.equal(changes, 1, "no change, no write");
  t = new Map([row(100, 1, root.start), row(101, 1, "s101"), [102, { pid: 102, unknown: true }], row(105, 1, "another start")]);
  gone.add(105);
  tree.poll();
  assert.deepEqual([...tree.known.keys()].sort(), [101, 102], "re-parented: kept; unknown row: kept; another start, confirmed gone: forgotten");
  // A row missing from a table (a transient read error) is forgotten only when the identity
  // check observes the exit.
  t = new Map([row(100, 1, root.start)]);
  tree.poll();
  assert.deepEqual([...tree.known.keys()].sort(), [101, 102], "missing rows whose exit is not observed are kept");
  gone.add(101);
  tree.poll();
  assert.deepEqual([...tree.known.keys()], [102]);
  assert.equal(TREE_MAX, 256);
  // ps rows: lstart in LC_ALL=C, one space between its words, as processInfo stores it.
  const ps = parsePsTable("  100     1   501 Ss   Mon Oct  5 10:00:00 2026\n  101   100   501 Z+   Mon Oct 12 10:00:01 2026\nbad line\n");
  assert.deepEqual(ps.get(100), { pid: 100, ppid: 1, uid: 501, start: "Mon Oct 5 10:00:00 2026", zombie: false });
  assert.equal(ps.get(101).zombie, true);
  assert.equal(ps.size, 2);
});

test("teardown: a recorded descendant whose identity cannot be read is never treated as ended: kept, reported failed, not signalled", async () => {
  const id = { pid: 4242, start: "s", uid: 501, boot: "b" };
  // The review's case: a boolean check that is false cannot tell an exit from an unreadable process.
  assert.deepEqual(await processTree(null, { known: [id], check: () => false }).end({ graceMs: 0 }), { ended: 0, failed: [id] });
  const sent = [];
  const kill = (pid, sig) => sent.push([pid, sig]);
  let st = "unknown";
  const tree = processTree(null, { known: [id], check: () => st === "same", state: () => st, kill });
  assert.deepEqual(await tree.end({ graceMs: 0 }), { ended: 0, failed: [id] });
  assert.deepEqual(sent, [], "nothing signalled while unreadable");
  assert.equal(tree.known.size, 1, "still recorded");
  // A real process that exists but reads as unknown (here: its identity check made unreadable).
  const c = spawn("sleep", ["30"], { stdio: "ignore" });
  const real = await identityWhenReadable(c.pid);
  try {
    assert.ok(real, "the sleep can be read");
    const r = await processTree(null, { known: [real], state: () => "unknown", kill }).end({ graceMs: 0 });
    assert.deepEqual(r.failed, [real]);
    assert.ok(sameIdentity(real), "it still runs, and the run would stay stopping");
  } finally {
    c.kill("SIGKILL");
  }
  // Observed gone ("different"): forgotten, counted as ended.
  st = "different";
  assert.deepEqual(await tree.end({ graceMs: 0 }), { ended: 1, failed: [] });
});

test("teardown: past TREE_MAX the excess descendants are still recorded (up to TREE_HARD, the rest counted), none evicted; the overflow is reported once and the supervisor stops the run (tree_limit)", async (t) => {
  const boot = "b1";
  const root = { pid: 100, start: "r", uid: 501, boot };
  const kids = (n, from, ppid = 100, uid = 501) => Array.from({ length: n }, (_, i) => [from + i, { pid: from + i, ppid, uid, start: `s${from + i}`, zombie: false }]);
  const many = (n, from) => new Map([[100, { pid: 100, ppid: 1, uid: 501, start: "r", zombie: false }], ...kids(n, from)]);
  let overflows = 0;
  let t1 = many(TREE_MAX + 1, 1000);
  const tree = processTree(root, { table: () => t1, boot: () => boot, check: () => true, state: () => "same", onOverflow: () => overflows++ });
  tree.poll();
  assert.equal(tree.known.size, TREE_MAX + 1, "the excess one is recorded too");
  assert.equal(tree.overflow, true);
  assert.equal(overflows, 1);
  const first = [...tree.known.keys()];
  t1 = many(300, 5000);
  for (const pid of first) t1.set(pid, { pid, ppid: 1, uid: 501, start: `s${pid}`, zombie: false });
  tree.poll();
  assert.equal(overflows, 1, "reported once");
  assert.ok(first.every((pid) => tree.known.has(pid)), "no recorded identity is evicted");
  assert.equal(tree.known.size, TREE_HARD, "recorded up to the hard limit");
  assert.equal(tree.unrecorded.size, TREE_MAX + 1 + 300 - TREE_HARD, "the rest is counted, not dropped silently");
  // The supervisor (a fake table): a run whose agent has more than TREE_MAX descendants is stopped.
  const w = agentsWorld(t);
  const a = await makeRun(w, { plan: { command: process.execPath, args: [FAKE, "sleep"], stdin: "task", result: { from: "stdout" } } });
  const fakeTable = (n) => (ag) => new Map([[ag.pid, { pid: ag.pid, ppid: process.pid, uid: ag.uid, start: ag.start, zombie: false }], ...kids(n, 900000, ag.pid, ag.uid)]);
  await supervise(w.home, a.run, { treeTable: fakeTable(TREE_MAX + 1), deliver: async () => {} }, { env: supEnv(w, a.run) });
  const rec = readRun(w.home, a.run);
  assert.equal(rec.state, "failed");
  assert.equal(rec.error, "tree_limit");
  assert.ok(rec.exit.signal, "the agent was stopped");
  assert.match(rec.result.notes.join(), /tree_limit/);
  assert.match(fs.readFileSync(a.p.log, "utf8"), /stopping it \(tree_limit\)/);
  assert.equal(readAudit(w.home).find((e) => e.run === a.run && e.event === "ended").error, "tree_limit");
  // The overflow while the supervisor's first record update waits on a held agents lock: the
  // overflow handler exists before the tree is read (no crash), and the run still stops.
  const b = await makeRun(w, { plan: { command: process.execPath, args: [FAKE, "sleep"], stdin: "task", result: { from: "stdout" } } });
  let holder = null;
  let held = false;
  let readsWhileHeld = 0;
  const overflowTable = fakeTable(3);
  const hooksB = {
    // Every read returns an overflowing table, so a read while the lock is held is an overflow poll.
    treeTable: (ag) => {
      if (held) readsWhileHeld++;
      return overflowTable(ag);
    },
    treeMax: 2,
    deliver: async () => {},
    beforeAgent: async () => {
      let got;
      const acquired = new Promise((r) => (got = r));
      holder = withAgentsLock(w.home, async () => {
        held = true;
        got();
        // Held until at least one overflow poll ran (at most 4 s, under the 5 s lock wait).
        for (const end = Date.now() + 4000; readsWhileHeld === 0 && Date.now() < end; ) await sleep(50);
        await sleep(200);
        held = false;
      });
      await acquired;
    },
  };
  await supervise(w.home, b.run, hooksB, { env: supEnv(w, b.run) });
  await holder;
  assert.ok(readsWhileHeld >= 1, "an overflow poll ran while the first record update waited on the lock");
  const recB = readRun(w.home, b.run);
  assert.equal(recB.state, "failed");
  assert.equal(recB.error, "tree_limit");
  assert.match(fs.readFileSync(b.p.log, "utf8"), /stopping it \(tree_limit\)/);
});

test("teardown: past TREE_HARD (the shipped limits, a fake table) the excess is counted and reported, and nothing claims it ended", async (t) => {
  const w = agentsWorld(t);
  const a = await makeRun(w, { plan: { command: process.execPath, args: [FAKE, "sleep"], stdin: "task", result: { from: "stdout" } } });
  const extra = 2;
  const n = TREE_HARD + extra;
  // Every read shows the agent with n descendants (pids that do not exist on this machine).
  const treeTable = (ag) => new Map([[ag.pid, { pid: ag.pid, ppid: process.pid, uid: ag.uid, start: ag.start, zombie: false }], ...Array.from({ length: n }, (_, i) => [800000 + i, { pid: 800000 + i, ppid: ag.pid, uid: ag.uid, start: `s${i}`, zombie: false }])]);
  await supervise(w.home, a.run, { treeTable, deliver: async () => {} }, { env: supEnv(w, a.run) });
  const rec = readRun(w.home, a.run);
  assert.equal(rec.state, "failed");
  assert.equal(rec.error, "tree_limit");
  assert.equal(rec.treeUnrecorded, extra, "the count in the record");
  const log = fs.readFileSync(a.p.log, "utf8");
  assert.match(log, new RegExp(`${extra} process\\(es\\) of the agent were seen but not recorded \\(more than ${TREE_HARD} at once\\); they are not ended by hoptell`), "the count in the run log");
  assert.match(rec.result.notes.join("; "), new RegExp(`${extra} process\\(es\\) of the agent were seen but not recorded .* and may still run`), "the count in the result note");
  const ended = readAudit(w.home).find((e) => e.run === a.run && e.event === "ended");
  assert.equal(ended.treeUnrecorded, extra, "the count in the audit");
  assert.equal(ended.error, "tree_limit");
  // Nothing claims all of them ended: at most the recorded ones are counted as ended.
  const said = [...log.matchAll(/ended (\d+) process\(es\) the agent left behind/g)].map((m) => Number(m[1]));
  assert.ok(said.every((k) => k <= TREE_HARD), `claimed ended: ${said}`);
  assert.ok(!said.includes(n), "never all of them");
});

test("teardown: on overflow a real excess child in a session of its own is recorded and ended with the others; past the hard limit what is left is reported", async (t) => {
  const w = agentsWorld(t);
  const run = async (n, hooks) => {
    const pidfile = path.join(w.base, `many-${n}-${hooks.treeHard}.json`);
    const a = await makeRun(w, { plan: { command: process.execPath, args: [FAKE, "many", String(n), pidfile], stdin: "task", result: { from: "stdout" } } });
    // The tree is read only once the test holds every child's identity (else the supervisor could
    // end them first): until then the table reads as unavailable.
    let ready = false;
    const done = supervise(w.home, a.run, { deliver: async () => {}, treeTable: () => (ready ? processTable() : null), ...hooks }, { env: supEnv(w, a.run) });
    for (const end = Date.now() + 10_000; !fs.existsSync(pidfile) && Date.now() < end; ) await sleep(50);
    const ids = [];
    for (const pid of JSON.parse(fs.readFileSync(pidfile, "utf8"))) ids.push(await identityWhenReadable(pid));
    ready = true;
    t.after(() => {
      for (const id of ids) if (id && sameIdentity(id)) process.kill(id.pid, "SIGKILL");
    });
    assert.ok(ids.every((id) => id && processInfo(id.pid).ppid !== 0), "every child runs, each in a session of its own");
    await done;
    return { a, ids, rec: readRun(w.home, a.run) };
  };
  // Three own-session children, a limit of two: all three recorded, all ended, the run failed.
  const one = await run(3, { treeMax: 2, treeHard: 8 });
  assert.equal(one.rec.state, "failed");
  assert.equal(one.rec.error, "tree_limit");
  for (const id of one.ids) assert.equal(identityState(id), "different", `pid ${id.pid} outlived the run`);
  assert.match(fs.readFileSync(one.a.p.log, "utf8"), /ended 3 process\(es\) the agent left behind/);
  // A hard limit of two: one child is seen but not recorded; it is reported, never silent.
  const two = await run(3, { treeMax: 1, treeHard: 2 });
  assert.equal(two.rec.state, "failed");
  assert.equal(two.rec.treeUnrecorded, 1);
  assert.equal(two.ids.filter((id) => identityState(id) !== "different").length, 1, "the unrecorded one is not ended by hoptell");
  assert.match(fs.readFileSync(two.a.p.log, "utf8"), /1 process\(es\) of the agent were seen but not recorded/);
  assert.match(two.rec.result.notes.join(), /seen but not recorded/);
  assert.equal(readAudit(w.home).find((e) => e.run === two.a.run && e.event === "ended").treeUnrecorded, 1);
});

test("teardown: a left-behind process that resists ending keeps the run stopping with its intended end and identity; a sweep ends it, then the run", async (t) => {
  const w = agentsWorld(t);
  const pidfile = path.join(w.base, "resist.pid");
  const go = path.join(w.base, "resist.go");
  const a = await makeRun(w, { plan: { command: process.execPath, args: [FAKE, "orphan-wait", pidfile, go], stdin: "task", result: { from: "stdout" } } });
  let orphanPid = 0;
  const delivered = [];
  // In process: the supervisor's own steps, its tree signals refused for the orphan (EPERM).
  const hooks = {
    treeKill: (pid, sig) => {
      if (pid === orphanPid) throw Object.assign(new Error("refused"), { code: "EPERM" });
      return process.kill(pid, sig);
    },
    deliver: async (rec, { notes }) => delivered.push({ state: rec.state, notes }),
  };
  const done = supervise(w.home, a.run, hooks, { env: supEnv(w, a.run) });
  for (const end = Date.now() + 10_000; !fs.existsSync(pidfile) && Date.now() < end; ) await sleep(50);
  orphanPid = Number(fs.readFileSync(pidfile, "utf8"));
  const orphan = await identityWhenReadable(orphanPid);
  t.after(() => {
    if (orphan && sameIdentity(orphan)) process.kill(orphan.pid, "SIGKILL");
  });
  assert.ok(orphan && sameIdentity(orphan), "the orphan runs");
  // The agent exits only once the supervisor has recorded the orphan (no timing assumption).
  assert.ok(await recorded(w, a.run, orphan.pid), "the supervisor recorded the orphan");
  fs.writeFileSync(go, "");
  await done;
  let rec = readRun(w.home, a.run);
  assert.equal(rec.state, "stopping", "never terminal while a left-behind process may run");
  assert.equal(rec.endAs.state, "exited");
  assert.equal(rec.endAs.exit.code, 0);
  assert.deepEqual(rec.tree.map((x) => [x.pid, x.start]), [[orphan.pid, orphan.start]]);
  assert.ok(sameIdentity(orphan), "it still runs");
  assert.equal(delivered.length, 1, "the agent's answer is delivered once");
  assert.equal(delivered[0].state, "exited");
  assert.match(delivered[0].notes.join(), /1 process\(es\) the agent left behind could not be ended yet/);
  assert.match(fs.readFileSync(a.p.log, "utf8"), new RegExp(`could not end process\\(es\\) the agent left behind: ${orphan.pid}`));
  assert.ok(readAudit(w.home).some((e) => e.run === a.run && e.event === "stop-incomplete" && e.left[0] === orphan.pid));
  assert.ok(!fs.existsSync(a.p.relays), "the run's settings files are removed");
  // The supervisor is gone (here: its recorded identity no longer matches).
  await updateRun(w.home, a.run, (r) => void (r.supervisor = { ...r.supervisor, start: "gone" }));
  // A sweep whose signals are refused too leaves it stopping, the identity kept.
  assert.deepEqual((await sweep(w.home, { deps: { kill: hooks.treeKill, graceMs: 200 } })).find((x) => x.run === a.run)?.state, "stopping");
  assert.equal(readRun(w.home, a.run).tree[0].pid, orphan.pid);
  // The next sweep ends it, and the run ends as the supervisor meant (exited).
  await sweep(w.home, { deps: { graceMs: 2000 } });
  rec = readRun(w.home, a.run);
  assert.equal(identityState(orphan), "different", "the left-behind process ended at the sweep");
  assert.equal(rec.state, "exited");
  assert.equal(rec.exit.code, 0);
  assert.deepEqual(rec.tree, []);
  const ended = readAudit(w.home).find((e) => e.run === a.run && e.event === "ended");
  assert.equal(ended.state, "exited");
  assert.equal(ended.leftEnded, 1);
  assert.equal(delivered.length, 1, "not delivered again");
});

test("teardown: the recorded descendants are in the run record; after the supervisor and the agent are killed, the sweep ends the re-parented process", async (t) => {
  const w = agentsWorld(t);
  const pidfile = path.join(w.base, "kept.pid");
  const a = await makeRun(w, { plan: { command: process.execPath, args: [FAKE, "orphan", pidfile], stdin: "task", result: { from: "stdout" } } });
  await startSupervisor(w.home, a.run, { env: supEnv(w, a.run) });
  t.after(() => cleanup(readRun(w.home, a.run)?.agent));
  for (const end = Date.now() + 10_000; !fs.existsSync(pidfile) && Date.now() < end; ) await sleep(50);
  const orphan = await identityWhenReadable(Number(fs.readFileSync(pidfile, "utf8")));
  t.after(() => {
    if (orphan && sameIdentity(orphan)) process.kill(orphan.pid, "SIGKILL");
  });
  assert.ok(orphan && sameIdentity(orphan), "the orphan runs");
  let rec;
  for (const end = Date.now() + 10_000; Date.now() < end; await sleep(100)) {
    rec = readRun(w.home, a.run);
    if (rec.tree?.some((x) => x.pid === orphan.pid)) break;
  }
  assert.deepEqual(rec.tree.find((x) => x.pid === orphan.pid), orphan, "persisted with its identity");
  // The supervisor and the agent die without a teardown (exact pids, identity checked).
  for (const id of [rec.supervisor, rec.agent]) assert.equal(signalChecked(id, "SIGKILL"), "signalled");
  for (const end = Date.now() + 5000; Date.now() < end && [rec.supervisor, rec.agent].some((id) => identityState(id) !== "different"); ) await sleep(50);
  assert.equal(identityState(rec.agent), "different");
  assert.ok(sameIdentity(orphan), "the re-parented process outlived both");
  await sweep(w.home, { deps: { graceMs: 2000 } });
  assert.equal(identityState(orphan), "different", "ended at the sweep, by its recorded identity");
  rec = readRun(w.home, a.run);
  assert.equal(rec.state, "lost", "the agent itself was gone");
  assert.equal(readAudit(w.home).find((e) => e.run === a.run && e.event === "ended").leftEnded, 1);
});

test("environment: the agent gets the allow list and env.pass, never the spawner's HOPTELL_* settings", async (t) => {
  const w = agentsWorld(t);
  const a = await makeRun(w, { plan: { command: process.execPath, args: [FAKE, "env"], stdin: "task", result: { from: "stdout" } }, pass: ["OPENAI_API_KEY", "HOPTELL_TOKEN"] });
  const secret = crypto.randomBytes(8).toString("hex");
  await startSupervisor(w.home, a.run, { env: supEnv(w, a.run, { HOPTELL_TOKEN: secret, HOPTELL_RELAY: "ws://127.0.0.1:1", HOPTELL_AUTH: "login", HOPTELL_CREDENTIAL_PASSPHRASE: secret, HOPTELL_EXPERIMENTAL_E2EE: "1", OPENAI_API_KEY: "k-pass", OTHER_SECRET: secret, LC_ALL: "C", TERM: "xterm" }) });
  await until(w, a.run, ["exited"]);
  const env = JSON.parse(fs.readFileSync(a.p.output, "utf8"));
  for (const k of ["HOPTELL_TOKEN", "HOPTELL_RELAY", "HOPTELL_AUTH", "HOPTELL_CREDENTIAL_PASSPHRASE", "HOPTELL_EXPERIMENTAL_E2EE", "OTHER_SECRET"]) assert.equal(env[k], undefined, k);
  assert.equal(env.OPENAI_API_KEY, "k-pass");
  assert.equal(env.LC_ALL, "C");
  assert.equal(env.TERM, "xterm");
  assert.equal(env.HOPTELL_RUN, a.run);
  assert.equal(env.HOPTELL_HOME, w.home);
  assert.equal(env.HOPTELL_RELAYS, a.p.relays);
  assert.equal(env.HOPTELL_ENV, a.p.env);
  assert.equal(env.HOPTELL_NAME, a.name);
  assert.equal(env.HOPTELL_ROLES, "reviewer,spawned");
  assert.ok(!JSON.stringify(env).includes(secret));
  // The pure builder agrees.
  assert.deepEqual(Object.keys(agentEnv({ HOPTELL_TOKEN: "x", PATH: "/bin" }, { home: w.home, run: a.run, name: "n", roles: [] })).sort(), ["HOPTELL_ENV", "HOPTELL_HOME", "HOPTELL_NAME", "HOPTELL_RELAYS", "HOPTELL_ROLES", "HOPTELL_RUN", "PATH"]);
});

test("identity: a different start, uid or boot, or an empty boot, is never signalled", () => {
  const me = processIdentity(process.pid);
  assert.ok(sameIdentity(me));
  const info = (pid) => ({ ...processInfo(pid) });
  const kills = [];
  const kill = (pid, sig) => kills.push([pid, sig]);
  const cases = [
    [{ ...me, start: "Thu Jan  1 00:00:00 1970" }, {}],
    [{ ...me, uid: me.uid + 1 }, {}],
    [{ ...me, boot: `${me.boot}x` }, {}],
    [me, { boot: () => "" }],
    [me, { info: () => null }],
    [{ ...me, pid: 1 }, {}],
    [{ pid: me.pid, start: me.start, uid: me.uid }, {}],
  ];
  for (const [id, deps] of cases) {
    const check = (x) => sameIdentity(x, { info, ...deps });
    assert.equal(check(id), false, JSON.stringify(id));
    assert.equal(signalChecked(id, "SIGTERM", { check, kill }), "mismatch");
  }
  assert.deepEqual(kills, []);
});

test("identity: stopProcess fails closed (nothing signalled, lost) and signals a match by group", async () => {
  const kills = [];
  const kill = (pid, sig) => kills.push([pid, sig]);
  assert.equal(await stopProcess({ pid: 4242, start: "x", uid: 1, boot: "b" }, { check: () => false, kill }), "lost");
  assert.equal(await stopProcess(null, { kill }), "lost");
  assert.deepEqual(kills, []);
  let alive = true;
  const check = () => alive;
  const k2 = (pid, sig) => {
    kills.push([pid, sig]);
    if (sig === "SIGKILL") alive = false;
  };
  assert.equal(await stopProcess({ pid: 4242 }, { check, kill: k2, graceMs: 200 }), "ended");
  assert.deepEqual(kills, [[-4242, "SIGTERM"], [-4242, "SIGKILL"]]);
});

test("identity: a zombie (exited, not yet reaped) is no longer the process; a refused signal to it is not a failure", async (t) => {
  // A real zombie: the shell's background child exits after the shell became sleep, which never
  // reaps it.
  const parent = spawn("/bin/sh", ["-c", "sleep 0.3 & echo $!; exec sleep 30"], { stdio: ["ignore", "pipe", "ignore"] });
  t.after(() => parent.kill("SIGKILL"));
  const zpid = Number(await new Promise((r) => parent.stdout.once("data", (d) => r(String(d).trim()))));
  let info = processInfo(zpid);
  for (let i = 0; i < 500 && info && !info.zombie; i++) {
    await sleep(20);
    info = processInfo(zpid);
  }
  assert.equal(info?.zombie, true, JSON.stringify(info));
  assert.equal(processInfo(process.pid).zombie, false);
  const stored = { pid: zpid, start: info.start, uid: info.uid, boot: currentBoot() };
  assert.equal(sameIdentity(stored), false, "a zombie never matches");
  assert.equal(sameIdentity({ ...stored, pid: process.pid, start: processInfo(process.pid).start }), true);
  // EPERM (macOS, a group of unreaped processes): "gone" once the identity no longer matches.
  const eperm = () => {
    throw Object.assign(new Error("EPERM"), { code: "EPERM" });
  };
  let matches = 2;
  assert.equal(signalChecked({ pid: 4242 }, "SIGTERM", { group: true, check: () => matches-- > 1, kill: eperm }), "gone");
  assert.equal(signalChecked({ pid: 4242 }, "SIGTERM", { group: true, check: () => true, kill: eperm }), "failed");
  let alive = true;
  const kills = [];
  const k = (pid, sig) => {
    kills.push(sig);
    alive = false;
    throw Object.assign(new Error("EPERM"), { code: "EPERM" });
  };
  assert.equal(await stopProcess({ pid: 4242 }, { check: () => alive, kill: k, graceMs: 100 }), "ended");
  assert.deepEqual(kills, ["SIGTERM"]);
});

test("identity: three states; an unreadable identity is never an exit (no gone, no ended)", async () => {
  const stored = { pid: 4242, start: "Mon Oct 12 10:00:00 2026", uid: 501, boot: "b1" };
  const info = (over) => () => ({ pid: 4242, uid: 501, start: stored.start, zombie: false, ...over });
  const st = (deps) => identityState(stored, { boot: () => "b1", exists: () => true, ...deps });
  assert.equal(st({ info: info({}) }), "same");
  assert.equal(st({ info: info({ start: "Mon Oct 12 10:00:01 2026" }) }), "different");
  assert.equal(st({ info: info({ uid: 0 }) }), "different");
  assert.equal(st({ info: info({ zombie: true }) }), "different");
  assert.equal(st({ info: info({}), boot: () => "b2" }), "different", "another boot");
  assert.equal(st({ info: info({}), boot: () => null }), "unknown", "the boot cannot be read");
  assert.equal(st({ info: () => null, exists: () => false }), "different", "the pid is absent (ESRCH)");
  assert.equal(st({ info: () => null, exists: () => true }), "unknown", "ps failed while the pid exists");
  assert.equal(st({ info: () => null, exists: () => null }), "unknown");
  assert.equal(st({ info: info({ start: "123456" }) }), "unknown", "a start in another form is no comparison");
  assert.equal(identityState({ pid: 4242 }), "unknown", "a malformed identity");
  assert.equal(identityState({ ...processIdentity(process.pid) }), "same");
  // EPERM while the identity cannot be read: failed, never gone; a stop never reports ended.
  const eperm = () => {
    throw Object.assign(new Error("EPERM"), { code: "EPERM" });
  };
  assert.equal(signalChecked(stored, "SIGTERM", { group: true, check: () => true, kill: eperm, state: () => "unknown" }), "failed");
  assert.equal(signalChecked(stored, "SIGTERM", { group: true, check: () => true, kill: eperm, state: () => "different" }), "gone");
  // Signals delivered, then the identity becomes unreadable: not ended (failed after SIGKILL).
  let reads = 0;
  const sent = [];
  const out = await stopProcess(stored, { check: () => reads++ < 2, kill: (pid, sig) => sent.push(sig), state: () => "unknown", graceMs: 100 });
  assert.equal(out, "failed");
  assert.deepEqual(sent, ["SIGTERM"], "the SIGKILL check failed closed: nothing more was sent");
  // tmux: the guarded end did not run and the identity cannot be read: lost, not ended.
  assert.equal(await stopProcess(stored, { check: () => true, tmuxEnd: () => false, state: () => "unknown" }), "lost");
});

test("tmux: a failed start whose pane process cannot be stopped keeps the run stopping (pane identity, session id) until the process is observed gone; a sweep ends such a run failed", async (t) => {
  const w = agentsWorld(t);
  // In process: the supervisor's own steps, with a stop that fails and an exit observed on cue.
  const a = await makeRun(w, { mode: "tmux", plan: { command: process.execPath, args: [], cli: { command: "/bin/sh", args: [] } } });
  const victim = { pid: process.pid, ...processIdentity(process.pid) };
  let gone = false;
  let ended = 0;
  const hooks = {
    launchTmux: async () => {
      throw Object.assign(new Error("new-window refused"), { started: { sessionId: "$999999", pane: "%999999", pid: String(process.pid), end: () => (ended++, false) } });
    },
    stopProcess: async () => "failed",
    identityState: () => (gone ? "different" : "same"),
  };
  const done = supervise(w.home, a.run, hooks, { env: { PATH: process.env.PATH, HOME: w.homedir } });
  let rec;
  for (let i = 0; i < 100; i++) {
    rec = readRun(w.home, a.run);
    if (rec.state === "stopping") break;
    await sleep(20);
  }
  assert.equal(rec.state, "stopping");
  assert.equal(rec.pane.pid, victim.pid);
  assert.equal(rec.pane.start, victim.start);
  assert.equal(rec.pane.sessionId, "$999999");
  assert.equal(rec.pane.pane, "%999999");
  assert.equal(rec.error, "failed");
  assert.ok(rec.stopFailed);
  await sleep(50);
  assert.equal(ended, 1, "the session was ended by id again");
  assert.equal(readRun(w.home, a.run).state, "stopping", "never terminal while the process may run");
  gone = true;
  await done;
  rec = readRun(w.home, a.run);
  assert.equal(rec.state, "failed");
  assert.match(fs.readFileSync(a.p.log, "utf8"), /after a failed start: failed[\s\S]*waiting for the agent's process to exit/);
  // The supervisor gone: the sweep stops the recorded process and the run ends failed.
  const child = spawn("/bin/sleep", ["600"], { detached: true, stdio: "ignore" });
  t.after(() => {
    try {
      process.kill(child.pid, "SIGKILL");
    } catch {}
  });
  await new Promise((r) => child.once("spawn", r));
  const pane = await identityWhenReadable(child.pid);
  assert.ok(pane && sameIdentity(pane), "the pane's process runs");
  const b = await makeRun(w, { mode: "tmux", plan: { command: process.execPath, args: [], cli: { command: "/bin/sh", args: [] } }, extra: { state: "stopping", supervisor: { pid: 999999, start: "x", uid: process.getuid(), boot: currentBoot() }, pane: { ...pane, pane: "%999999", session: "hoptell-none" }, error: "failed", errorText: "new-window refused" } });
  const exited = new Promise((r) => child.once("exit", r));
  const changed = await sweep(w.home, { deps: { graceMs: 300 } });
  assert.deepEqual(changed.filter((c) => c.run === b.run), [{ run: b.run, state: "failed" }]);
  await exited;
  assert.equal(readRun(w.home, b.run).state, "failed");
});

test("headless: a task replaced after the spawn is never given to the agent; the run fails before the CLI starts", async (t) => {
  const w = agentsWorld(t);
  const marker = path.join(w.base, "cli-ran");
  const a = await makeRun(w, { task: "the confirmed task", plan: { command: "/bin/sh", args: ["-c", `touch '${marker}'; cat`], stdin: "task", result: { from: "stdout" } } });
  fs.writeFileSync(a.p.task, "another task", { mode: 0o600 });
  const rec = await startSupervisor(w.home, a.run, { env: supEnv(w, a.run) });
  const ended = rec.state === "failed" ? rec : await until(w, a.run, ["failed"]);
  assert.equal(ended.state, "failed");
  assert.match(ended.errorText, /not the task the run was made with/);
  assert.equal(fs.existsSync(marker), false, "the CLI never started");
  // The confirmed bytes are what the agent reads on stdin.
  const b = await makeRun(w, { task: "the confirmed task", plan: { command: "/bin/sh", args: ["-c", "cat"], stdin: "task", result: { from: "stdout" } } });
  await startSupervisor(w.home, b.run, { env: supEnv(w, b.run) });
  const done = await until(w, b.run, ["exited"]);
  assert.equal(done.state, "exited");
  assert.equal(fs.readFileSync(b.p.result, "utf8"), "the confirmed task");
});

test("the checked CLI only: a file changed after the check fails the run cli_changed before it starts (headless, tmux, and hoptell agents exec)", async (t) => {
  const w = agentsWorld(t);
  const marker = path.join(w.base, "cli-ran");
  const cli = path.join(w.base, "cli.sh");
  fs.writeFileSync(cli, `#!/bin/sh\ntouch '${marker}'\ncat\n`, { mode: 0o755 });
  // Headless: the supervisor checks the digest right before it starts the CLI.
  const a = await makeRun(w, { plan: { command: cli, args: [], stdin: "task", result: { from: "stdout" } } });
  fs.appendFileSync(cli, "# changed\n");
  let rec = await startSupervisor(w.home, a.run, { env: supEnv(w, a.run) });
  rec = rec.state === "failed" ? rec : await until(w, a.run, ["failed"]);
  assert.equal(rec.error, "cli_changed");
  assert.equal(fs.existsSync(marker), false);
  // tmux: refused before any session is made.
  const b = await makeRun(w, { mode: "tmux", plan: { command: process.execPath, args: [], cli: { command: cli, args: [] } } });
  fs.appendFileSync(cli, "# changed again\n");
  rec = await startSupervisor(w.home, b.run, { env: supEnv(w, b.run) });
  rec = rec.state === "failed" ? rec : await until(w, b.run, ["failed"]);
  assert.equal(rec.error, "cli_changed");
  if (tmuxOk) assert.equal(hasSession(`hoptell-${b.name}`), false);
  // hoptell agents exec (the pane's process) checks it again right before it starts the CLI.
  const c = await makeRun(w, { mode: "tmux", plan: { command: process.execPath, args: [], cli: { command: cli, args: [] } } });
  fs.writeFileSync(c.p.agentEnv, JSON.stringify({ PATH: process.env.PATH }), { mode: 0o600 });
  fs.appendFileSync(cli, "# and again\n");
  const { agentsCommand } = await import("../lib/agentscli.js");
  await assert.rejects(
    agentsCommand({ args: ["exec", c.run], home: w.home, env: {}, homedir: w.homedir, out: () => {}, fail: (m) => {
      throw new Error(m);
    } }),
    /changed since it was checked/,
  );
  assert.equal(fs.existsSync(marker), false, "the CLI never ran");
});

test("supervision: the spawner exits mid-run; the run continues and keeps its result", async (t) => {
  const w = agentsWorld(t);
  const a = await makeRun(w, { plan: { command: process.execPath, args: ["-e", "setTimeout(() => process.stdout.write('late answer'), 1500)"], stdin: "task", result: { from: "stdout" } } });
  // A separate spawner process starts the supervisor and exits at once.
  const script = `import { startSupervisor } from ${JSON.stringify(new URL("../lib/agentruns.js", import.meta.url).href)};
const r = await startSupervisor(${JSON.stringify(w.home)}, ${JSON.stringify(a.run)}, { env: ${JSON.stringify(supEnv(w, a.run))} });
process.stdout.write(r.state); process.exit(0);`;
  const out = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 30_000 });
  assert.equal(out.stdout, "running", out.stderr);
  const rec = await until(w, a.run, ["exited"]);
  assert.equal(fs.readFileSync(a.p.result, "utf8"), "late answer");
  assert.equal(rec.state, "exited");
});

test("supervision: a killed supervisor; the sweep stops the agent if it matches, else marks the run lost without a signal", async (t) => {
  const w = agentsWorld(t);
  const a = await makeRun(w, { plan: { command: process.execPath, args: [FAKE, "sleep"], stdin: "task", result: { from: "stdout" } } });
  let rec = await startSupervisor(w.home, a.run, { env: supEnv(w, a.run) });
  t.after(() => cleanup(readRun(w.home, a.run)?.agent));
  assert.equal(rec.state, "running");
  assert.equal(signalChecked(rec.supervisor, "SIGKILL"), "signalled");
  for (let i = 0; i < 300 && sameIdentity(rec.supervisor); i++) await sleep(50);
  assert.ok(sameIdentity(rec.agent), "the agent outlives its supervisor (own process group)");
  assert.equal(isLive(readRun(w.home, a.run)), false, "a record whose supervisor is gone does not count");
  const changed = await sweep(w.home, { deps: { graceMs: 500 } });
  assert.deepEqual(changed.filter((c) => c.run === a.run), [{ run: a.run, state: "stopped" }]);
  for (let i = 0; i < 300 && sameIdentity(rec.agent); i++) await sleep(50);
  assert.equal(sameIdentity(rec.agent), false, "the agent was stopped");
  assert.equal(readRun(w.home, a.run).stoppedBy, "sweep");

  // The agent's recorded identity no longer matches (pid reuse): never signalled, lost.
  const b = await makeRun(w, { plan: { command: process.execPath, args: [FAKE, "sleep"], stdin: "task", result: { from: "stdout" } } });
  rec = await startSupervisor(w.home, b.run, { env: supEnv(w, b.run) });
  t.after(() => cleanup(rec.agent));
  signalChecked(rec.supervisor, "SIGKILL");
  for (let i = 0; i < 300 && sameIdentity(rec.supervisor); i++) await sleep(50);
  await updateRun(w.home, b.run, (r) => {
    r.agent = { ...r.agent, start: "Thu Jan  1 00:00:00 1970" };
  });
  await sweep(w.home);
  rec = readRun(w.home, b.run);
  assert.equal(rec.state, "lost");
  const real = { ...rec.agent, start: processInfo(rec.agent.pid).start };
  assert.ok(sameIdentity(real), "the real process was not signalled");
  cleanup(real);
});

test("sweep: past the lifetime with a supervisor that did not stop it; old pending confirmations are discarded", async (t) => {
  const w = agentsWorld(t);
  const a = await makeRun(w, { plan: { command: process.execPath, args: [FAKE, "sleep"], stdin: "task", result: { from: "stdout" } } });
  let rec = await startSupervisor(w.home, a.run, { env: supEnv(w, a.run) });
  t.after(() => cleanup(readRun(w.home, a.run)?.agent));
  await updateRun(w.home, a.run, (r) => {
    r.ends = new Date(Date.now() - 120_000).toISOString();
  });
  // The sweep and the supervisor run at once: the sweep asks the supervisor and waits for it;
  // exactly one terminal write, by the supervisor.
  const changed = await sweep(w.home, { deps: { graceMs: 500 } });
  assert.deepEqual(changed.filter((c) => c.run === a.run).map((c) => c.state), ["stopped"]);
  rec = await until(w, a.run, ["expired", "stopped"]);
  for (let i = 0; i < 300 && sameIdentity(rec.agent); i++) await sleep(50);
  assert.equal(sameIdentity(rec.agent), false);
  assert.equal(rec.stoppedBy, "sweep");
  assert.ok(rec.result, "the supervisor wrote the end (with the result)");
  assert.equal(readAudit(w.home).filter((e) => e.run === a.run && e.event === "ended").length, 1, "one terminal write");
  const old = await makeRun(w, { extra: { state: "pending-confirmation", created: new Date(Date.now() - 3700_000).toISOString() } });
  await sweep(w.home);
  assert.equal(readRun(w.home, old.run).state, "discarded");
});

test("stopping: a refused signal or a process that survives SIGKILL is never recorded as ended; the sweep retries", async (t) => {
  const me = processIdentity(process.pid);
  const eperm = () => {
    throw Object.assign(new Error("not permitted"), { code: "EPERM" });
  };
  const esrch = () => {
    throw Object.assign(new Error("no such process"), { code: "ESRCH" });
  };
  assert.equal(signalChecked(me, "SIGTERM", { kill: eperm }), "failed");
  assert.equal(signalChecked(me, "SIGTERM", { kill: esrch }), "gone");
  assert.equal(await stopProcess(me, { kill: eperm, graceMs: 100 }), "failed");
  const sent = [];
  assert.equal(await stopProcess(me, { check: () => true, kill: (pid, sig) => sent.push(sig), graceMs: 100 }), "failed", "still matching after both signals");
  assert.deepEqual(sent, ["SIGTERM", "SIGKILL"]);
  // Both group signals raise ESRCH while the checked pid still matches (the group is gone, the
  // process is not): uncertain, so never "ended".
  assert.equal(await stopProcess(me, { check: () => true, kill: esrch, graceMs: 100 }), "failed");
  // ESRCH, and a later identity check shows it gone: ended.
  let alive = true;
  assert.equal(await stopProcess(me, { check: () => alive, kill: () => ((alive = false), esrch()), graceMs: 100 }), "ended");
  // Through the sweep: the supervisor is gone, the agent matches but cannot be stopped.
  const w = agentsWorld(t);
  const a = await makeRun(w, { extra: { state: "running", supervisor: { pid: 999999, start: "x", uid: process.getuid(), boot: currentBoot() }, agent: { pid: 424242, start: "y", uid: process.getuid(), boot: currentBoot() } } });
  const deps = { check: (id) => id.pid === 424242, kill: eperm, graceMs: 100 };
  assert.deepEqual((await sweep(w.home, { deps })).filter((c) => c.run === a.run), [{ run: a.run, state: "stopping" }]);
  let rec = readRun(w.home, a.run);
  assert.equal(rec.state, "stopping");
  assert.ok(rec.stopFailed);
  assert.ok(fs.existsSync(a.p.relays), "the run's files stay while it may run");
  assert.equal(readAudit(w.home).filter((e) => e.run === a.run && e.event === "ended").length, 0);
  // The next sweep tries again; once the agent no longer matches, nothing is signalled and the run ends lost.
  await sweep(w.home, { deps: { ...deps, check: () => false } });
  rec = readRun(w.home, a.run);
  assert.equal(rec.state, "lost", "no longer matching: nothing signalled");
});

test("pruning: 7 days or 100 runs, whichever is fewer; runs of the last hour and live runs stay", async (t) => {
  const w = agentsWorld(t);
  const ids = [];
  const now = Date.now();
  await withAgentsLock(w.home, () => {
    for (let i = 0; i < 105; i++) {
      const run = newRunId();
      ids.push(run);
      createRunFiles(w.home, { run, state: "exited", created: new Date(now - 2 * 3600_000 - i * 60_000).toISOString() });
    }
    const week = newRunId();
    ids.push(week);
    createRunFiles(w.home, { run: week, state: "stopped", created: new Date(now - 8 * 86400_000).toISOString() });
    const live = newRunId();
    ids.push(live);
    createRunFiles(w.home, { run: live, state: "running", created: new Date(now - 9 * 86400_000).toISOString() });
  });
  const removed = prune(w.home, { now });
  assert.equal(removed.length, 6, "the 5 oldest beyond 100, and the one older than 7 days");
  assert.ok(removed.includes(ids[105]));
  assert.ok(!removed.includes(ids[106]), "a live run is never pruned");
  for (const r of removed) assert.equal(fs.existsSync(runPaths(w.home, r).dir), false);
  assert.equal(listRuns(w.home).length, 101);
  // A record that fails the file checks is not read.
  fs.chmodSync(runPaths(w.home, ids[0]).record, 0o644);
  assert.equal(readRun(w.home, ids[0]), null);
  fs.writeFileSync(runPaths(w.home, ids[1]).record, "{", { mode: 0o600 });
  assert.equal(readRun(w.home, ids[1]), null);
  assert.equal(cutUtf8(Buffer.from("aé"), 2).toString(), "a");
});

// ---- tmux ------------------------------------------------------------------------------------------

const tmuxOk = spawnSync("tmux", ["-V"]).status === 0;
/** End a tmux session this test created, by its exact name. */
const endSession = (session) => spawnSync("tmux", ["kill-session", "-t", `=${session}`], { stdio: "ignore" });
const hasSession = (session) => spawnSync("tmux", ["has-session", "-t", `=${session}`], { stdio: "ignore" }).status === 0;

test("tmux: detached start in the run's folder with the run's settings, the injector, stop through the identity check and guarded()", { skip: !tmuxOk && "tmux is not installed" }, async (t) => {
  const w = agentsWorld(t);
  const name = `t7x${crypto.randomBytes(3).toString("hex")}-a1b2`;
  const session = `hoptell-${name}`;
  t.after(() => endSession(session));
  const out = path.join(w.base, "pane-out");
  // A tmux on PATH that logs every invocation's arguments and environment, then runs tmux.
  const shim = path.join(w.base, "bin");
  const log = path.join(w.base, "tmux-calls");
  fs.mkdirSync(shim);
  fs.writeFileSync(path.join(shim, "tmux"), `#!/bin/sh\nprintf 'ARGV %s\\n' "$*" >> '${log}'\nenv | sed 's/^/ENV /' >> '${log}'\nexec '${execFileSync("/bin/sh", ["-c", "command -v tmux"], { encoding: "utf8" }).trim()}' "$@"\n`, { mode: 0o700 });
  const secret = `sentinel-${crypto.randomBytes(8).toString("hex")}`;
  const a = await makeRun(w, {
    mode: "tmux",
    name,
    pass: ["SPAWN_TEST_SECRET"],
    plan: { command: process.execPath, args: [], cli: { command: "/bin/sh", args: ["-c", `pwd > ${out}; env >> ${out}; sleep 600`] } },
  });
  const rec = await startSupervisor(w.home, a.run, { env: supEnv(w, a.run, { HOPTELL_TOKEN: "never-in-the-pane", SPAWN_TEST_SECRET: secret, PATH: `${shim}:${process.env.PATH}` }) });
  t.after(() => cleanup(readRun(w.home, a.run)?.pane));
  assert.equal(rec.state, "running", JSON.stringify(rec));
  assert.ok(hasSession(session));
  assert.equal(rec.pane.session, session);
  assert.match(rec.pane.pane, /^%\d+$/);
  assert.equal(rec.pane.boot, currentBoot());
  const windows = execFileSync("tmux", ["list-windows", "-t", `=${session}`, "-F", "#{window_name}"], { encoding: "utf8" }).trim().split("\n");
  assert.deepEqual(windows, ["agent", "injector"]);
  for (let i = 0; i < 400 && !(fs.existsSync(out) && /HOPTELL_RUN/.test(fs.readFileSync(out, "utf8"))); i++) await sleep(50);
  const seen = fs.readFileSync(out, "utf8");
  assert.equal(seen.split("\n")[0], w.work, "the run's folder, not the caller's");
  assert.match(seen, new RegExp(`HOPTELL_RUN=${a.run}`));
  assert.doesNotMatch(seen, /never-in-the-pane/);
  assert.match(seen, new RegExp(`SPAWN_TEST_SECRET=${secret}`), "env.pass reaches the agent");
  assert.equal(fs.existsSync(a.p.agentEnv), false, "the private environment file was read and removed");
  // No tmux invocation carried the secret, neither in its arguments nor in its environment
  // (a tmux server it starts would keep that environment).
  const calls = fs.readFileSync(log, "utf8");
  assert.match(calls, /ARGV new-session -d/);
  assert.ok(!calls.includes(secret), "the secret is in no tmux argv or environment");
  assert.doesNotMatch(calls, /never-in-the-pane/);
  await stopRun(w.home, a.run, { by: "test", deps: { waitMs: 100 } });
  const ended = await until(w, a.run, ["stopped", "lost"]);
  assert.equal(ended.state, "stopped");
  assert.equal(ended.stoppedBy, "test");
  assert.equal(hasSession(session), false);
});

test("tmux: the pane's process replaced, or its identity unreadable: no signal, lost", { skip: !tmuxOk && "tmux is not installed" }, async (t) => {
  const w = agentsWorld(t);
  const name = `t7x${crypto.randomBytes(3).toString("hex")}-c3d4`;
  const session = `hoptell-${name}`;
  t.after(() => endSession(session));
  const a = await makeRun(w, { mode: "tmux", name, plan: { command: process.execPath, args: [], cli: { command: "/bin/sh", args: ["-c", "sleep 600"] } } });
  let rec = await startSupervisor(w.home, a.run, { env: supEnv(w, a.run) });
  assert.equal(rec.state, "running");
  // The supervisor is gone and the recorded pane identity is not the pane's process any more.
  signalChecked(rec.supervisor, "SIGKILL");
  for (let i = 0; i < 300 && sameIdentity(rec.supervisor); i++) await sleep(50);
  await updateRun(w.home, a.run, (r) => {
    r.pane = { ...r.pane, start: "Thu Jan  1 00:00:00 1970" };
  });
  await sweep(w.home);
  rec = readRun(w.home, a.run);
  assert.equal(rec.state, "lost");
  assert.ok(hasSession(session), "the session was not ended");
  // Unreadable: no identity recorded at all.
  await updateRun(w.home, a.run, (r) => {
    r.state = "running";
    r.pane = null;
  });
  writeRecord(runPaths(w.home, a.run).record, readRun(w.home, a.run));
  await sweep(w.home);
  assert.equal(readRun(w.home, a.run).state, "lost");
  assert.ok(hasSession(session));
});

test("tmux: the agent exiting by itself ends its session by session id; hoptell tmux keeps ending its session by name", { skip: !tmuxOk && "tmux is not installed" }, async (t) => {
  // The existing launch path is unchanged; a spawned run's pane has no name-based kill.
  assert.equal(agentCommand(["codex", "-c", "x=1"], "hoptell-a"), "'codex' '-c' 'x=1'; tmux kill-session -t '=hoptell-a'");
  assert.equal(agentCommand(["node", "bin", "agents", "exec"], "hoptell-a", { endByName: false }), "'node' 'bin' 'agents' 'exec'");
  const w = agentsWorld(t);
  const name = `t7x${crypto.randomBytes(3).toString("hex")}-e5f6`;
  const session = `hoptell-${name}`;
  t.after(() => endSession(session));
  const a = await makeRun(w, { mode: "tmux", name, plan: { command: process.execPath, args: [], cli: { command: "/bin/sh", args: ["-c", "sleep 1; exit 0"] } } });
  const rec = await startSupervisor(w.home, a.run, { env: supEnv(w, a.run) });
  assert.equal(rec.state, "running");
  const ended = await until(w, a.run, ["exited", "lost"]);
  assert.equal(ended.state, "exited");
  for (let i = 0; i < 100 && hasSession(session); i++) await sleep(50);
  assert.equal(hasSession(session), false);
});

test("tmux: a stop ends the run's session by its id, never the session that took its name after a rename", { skip: !tmuxOk && "tmux is not installed" }, async (t) => {
  const w = agentsWorld(t);
  for (const how of ["supervisor", "sweep"]) {
    const name = `t7x${crypto.randomBytes(3).toString("hex")}-a7a7`;
    const session = `hoptell-${name}`;
    const moved = `${session}-moved`;
    t.after(() => (endSession(session), endSession(moved)));
    const a = await makeRun(w, { mode: "tmux", name, plan: { command: process.execPath, args: [], cli: { command: "/bin/sh", args: ["-c", "sleep 600"] } } });
    const rec = await startSupervisor(w.home, a.run, { env: supEnv(w, a.run) });
    assert.equal(rec.state, "running");
    assert.match(rec.pane.sessionId, /^\$\d+$/);
    if (how === "sweep") {
      signalChecked(rec.supervisor, "SIGKILL");
      for (let i = 0; i < 300 && sameIdentity(rec.supervisor); i++) await sleep(50);
    }
    // The run's session is renamed, and another session takes the old name.
    execFileSync("tmux", ["rename-session", "-t", rec.pane.sessionId, moved]);
    execFileSync("tmux", ["new-session", "-d", "-s", session, "sleep 600"]);
    if (how === "supervisor") await stopRun(w.home, a.run, { by: "test", deps: { waitMs: 100 } });
    else await sweep(w.home, { deps: { graceMs: 500 } });
    const ended = await until(w, a.run, ["stopped", "lost", "expired"]);
    assert.equal(ended.state, "stopped", how);
    assert.equal(hasSession(moved), false, `${how}: the run's own session (by id) was ended`);
    assert.equal(hasSession(session), true, `${how}: the session now holding the old name was left alone`);
    endSession(session);
  }
});

test("tmux: when the injector window cannot be created, the agent's new session is ended (by id, checked pane) and its process stopped by pid; the run fails", { skip: !tmuxOk && "tmux is not installed" }, async (t) => {
  const w = agentsWorld(t);
  const real = execFileSync("/bin/sh", ["-c", "command -v tmux"], { encoding: "utf8" }).trim();
  const shim = (name, body) => {
    const dir = path.join(w.base, name);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "tmux"), `#!/bin/sh\n${body}exec '${real}' "$@"\n`, { mode: 0o700 });
    return dir;
  };
  const failWindow = 'if [ "$1" = new-window ]; then echo refused >&2; exit 1; fi\n';
  const gone = async (pidFile) => {
    const pid = Number(fs.readFileSync(pidFile, "utf8"));
    // Never 0 (process.kill(0, 0) would probe this test's own process group).
    assert.ok(Number.isSafeInteger(pid) && pid > 1, `not a pid: ${pid}`);
    for (let i = 0; i < 100; i++) {
      try {
        process.kill(pid, 0);
      } catch {
        return true;
      }
      await sleep(50);
    }
    return false;
  };
  // Directly: launchDetached throws, names the pane it started, and its session is gone.
  const bin1 = shim("bin1", failWindow);
  const name = `t7x${crypto.randomBytes(3).toString("hex")}-b8b8`;
  const session = `hoptell-${name}`;
  t.after(() => endSession(session));
  let err;
  try {
    launchDetached(name, ["/bin/sh", "-c", "exec sleep 600"], { ids: {}, base: { PATH: process.env.PATH, HOME: w.homedir }, cwd: w.work, tmuxBin: path.join(bin1, "tmux") });
  } catch (e) {
    err = e;
  }
  assert.ok(err, "the start failed");
  assert.match(String(err.started?.sessionId), /^\$\d+$/);
  assert.match(String(err.started?.pane), /^%\d+$/);
  assert.match(String(err.started?.pid), /^\d+$/);
  assert.equal(hasSession(session), false);
  // Through the supervisor: the run fails, no session is left and the agent's process is gone.
  // Then with a tmux whose session end does nothing (as when the hangup comes before the pane's
  // process has its terminal): the supervisor still stops the process by its pid.
  for (const [how, body] of [
    ["ended session", failWindow],
    ["session end lost", `${failWindow}if [ "$1" = if-shell ]; then exit 0; fi\n`],
  ]) {
    const dir = shim(`bin-${how.replace(/ /g, "-")}`, body);
    const name2 = `t7x${crypto.randomBytes(3).toString("hex")}-c9c9`;
    t.after(() => endSession(`hoptell-${name2}`));
    const pidFile = path.join(w.base, `pid-${name2}`);
    const a = await makeRun(w, { mode: "tmux", name: name2, plan: { command: process.execPath, args: [], cli: { command: "/bin/sh", args: ["-c", `echo $$ > '${pidFile}.tmp' && mv '${pidFile}.tmp' '${pidFile}'; exec sleep 600`] } } });
    const rec = await startSupervisor(w.home, a.run, { env: supEnv(w, a.run, { PATH: `${dir}:${process.env.PATH}` }) });
    const ended = rec.state === "failed" ? rec : await until(w, a.run, ["failed"]);
    assert.equal(ended.state, "failed", how);
    assert.equal(fs.existsSync(a.p.agentEnv), false, how);
    if (fs.existsSync(pidFile)) {
      const ok = await gone(pidFile);
      const pid = fs.readFileSync(pidFile, "utf8").trim();
      const ps = ok ? "" : spawnSync("ps", ["-o", "pid,pgid,ppid,stat,lstart,command", "-p", pid], { encoding: "utf8" }).stdout;
      assert.equal(ok, true, `${how}: the agent's process is gone\n${ps}\n${fs.readFileSync(a.p.log, "utf8")}`);
    }
    if (how === "session end lost") {
      // Nothing ended the session: it closes only because its pane's process is gone.
      const log = fs.readFileSync(a.p.log, "utf8");
      // ended (stopped) or lost (it had exited by itself: its settings were already removed).
      assert.match(log, /the agent's process after a failed start: (ended|lost)/, `${how}\n${log}`);
      for (let i = 0; i < 100 && hasSession(`hoptell-${name2}`); i++) await sleep(50);
    }
    assert.equal(hasSession(`hoptell-${name2}`), false, how);
  }
});
