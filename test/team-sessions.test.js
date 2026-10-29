// Team sessions (design 8, phase 1): hoptell tmux --cwd and --task, and read_task bound to the
// session. A private tmux server (TMUX_TMPDIR), temporary homes and test relays only.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { readSessionTask } from "../lib/mcp.js";
import { TASK_MAX, checkCwd, readTaskFile, taskFileOf } from "../lib/tmux.js";
import { addWorktree, commitWorktree, memberState } from "../lib/worktrees.js";
import { sleep, world } from "./helpers.js";

const TMUX_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "hoptell-team-"));
process.env.TMUX_TMPDIR = TMUX_DIR;
delete process.env.TMUX;
delete process.env.TMUX_PANE;
test.after(() => {
  spawnSync("tmux", ["kill-server"]);
  fs.rmSync(TMUX_DIR, { recursive: true, force: true });
});
const hasTmux = spawnSync("tmux", ["-V"]).status === 0;
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const textOf = (r) => r.content.map((c) => c.text).join("");

/** A repository with one commit and a member worktree of `cli` in `home` (no global git config). */
async function memberWorktree(t, home, member, cli) {
  const env = { PATH: process.env.PATH, HOME: os.tmpdir(), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", LC_ALL: "C" };
  const g = (cwd, ...args) => execFileSync("git", args, { cwd, env, stdio: "ignore" });
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hoptell-team-repo-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  g(repo, "init", "-q", "-b", "main");
  g(repo, "config", "user.name", "Lead");
  g(repo, "config", "user.email", "lead@example.com");
  fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
  g(repo, "add", "-A");
  g(repo, "commit", "-q", "-m", "init");
  return addWorktree(home, { repo, member, team: "n1", cli });
}

test("--task and --cwd checks: a missing, empty, oversized or binary task file and a missing folder are refused", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hoptell-task-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const f = (name, bytes) => {
    fs.writeFileSync(path.join(dir, name), bytes);
    return path.join(dir, name);
  };
  const ok = readTaskFile(f("ok.md", "Add validation to lib/config.js.\n"));
  assert.equal(ok.digest, sha("Add validation to lib/config.js.\n"));
  assert.throws(() => readTaskFile(path.join(dir, "none.md")), /--task: .* does not exist/);
  assert.throws(() => readTaskFile(dir), /is not a file/);
  assert.throws(() => readTaskFile(f("empty.md", " \n")), /is empty/);
  assert.throws(() => readTaskFile(f("big.md", "x".repeat(TASK_MAX + 1))), /is over 32768 bytes/);
  assert.throws(() => readTaskFile(f("bin.md", Buffer.from([0xff, 0xfe, 0x41]))), /not UTF-8 text/);
  assert.throws(() => readTaskFile(f("nul.md", "a\0b")), /NUL/);
  assert.equal(checkCwd(dir), fs.realpathSync(dir));
  assert.throws(() => checkCwd(path.join(dir, "nope")), /--cwd: .* does not exist/);
  assert.throws(() => checkCwd(path.join(dir, "ok.md")), /is not a folder/);
});

test("hoptell tmux: option parsing and refusals before anything starts", async (t) => {
  const w = await world();
  t.after(() => w.close());
  const task = path.join(w.home, "task.md");
  fs.writeFileSync(task, "do it\n");
  for (const args of [
    ["tmux", "x", "--bogus", "1", "--", "true"],
    ["tmux", "x", "--cwd", "--", "true"],
    ["tmux", "x", "--cwd", w.home, "--cwd", w.home, "--", "true"],
    ["tmux", "--cwd", w.home, "x", "--", "true"],
    ["tmux", "x", "--task", task],
  ]) {
    const r = await w.cli(args, { HOPTELL_PUSH: "" });
    assert.equal(r.code, 2, `${args.join(" ")}: ${r.stderr}`);
  }
  let r = await w.cli(["tmux", "x", "--cwd", path.join(w.home, "missing"), "--", "true"], { HOPTELL_PUSH: "" });
  assert.match(r.stderr, /--cwd: .* does not exist/);
  r = await w.cli(["tmux", "x", "--task", path.join(w.home, "missing.md"), "--", "true"], { HOPTELL_PUSH: "" });
  assert.match(r.stderr, /--task: .* does not exist/);
  assert.ok(!fs.existsSync(path.join(w.home, "sessions")), "nothing was written");
  // A member's worktree is for that member and the CLI it was added for.
  const wt = (await memberWorktree(t, w.home, "dana-impl-1", "codex")).path;
  r = await w.cli(["tmux", "dana-impl-2", "--cwd", wt, "--", "codex"], { HOPTELL_PUSH: "" });
  assert.match(r.stderr, /is the worktree of dana-impl-1; only dana-impl-1 starts there/);
  r = await w.cli(["tmux", "dana-impl-1", "--cwd", wt, "--", "claude"], { HOPTELL_PUSH: "" });
  assert.match(r.stderr, /was added for a codex implementer \(hoptell worktree add --cli codex\), not claude/);
  r = await w.cli(["tmux", "dana-impl-1", "--cwd", wt, "--", "agy"], { HOPTELL_PUSH: "" });
  assert.match(r.stderr, /not agy/);
  // A folder inside the worktree is the worktree too.
  fs.mkdirSync(path.join(wt, "sub"));
  r = await w.cli(["tmux", "dana-impl-2", "--cwd", path.join(wt, "sub"), "--", "codex"], { HOPTELL_PUSH: "" });
  assert.match(r.stderr, /is the worktree of dana-impl-1/);
  assert.ok(!fs.existsSync(path.join(w.home, "worktrees", "sessions", "dana-impl-1.json")), "no session was recorded");
});

test("hoptell tmux in a member's worktree: the session is recorded, worktree commands refuse until it stopped, a second launch is refused", { skip: !hasTmux && "tmux not installed" }, async (t) => {
  const w = await world();
  const name = `tw${process.pid}`;
  const session = `hoptell-${name}`;
  t.after(async () => {
    spawnSync("tmux", ["kill-session", "-t", `=${session}`]);
    await w.close();
  });
  const rec = await memberWorktree(t, w.home, name, "codex");
  // A stand-in named codex: the launch checks the CLI by name.
  const bin = path.join(path.dirname(rec.path), "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "codex"), "#!/bin/sh\nexec sleep 60\n", { mode: 0o755 });
  const r = await w.cli(["tmux", name, "--cwd", rec.path, "--", path.join(bin, "codex")], { HOPTELL_PUSH: "" });
  assert.match(r.stderr, /attach with: tmux attach/);
  const sessionFile = path.join(w.home, "worktrees", "sessions", `${name}.json`);
  const recorded = JSON.parse(fs.readFileSync(sessionFile, "utf8"));
  assert.equal(fs.statSync(sessionFile).mode & 0o777, 0o600);
  assert.match(recorded.sessionId, /^\$\d+$/);
  assert.equal(String(recorded.root.pid), execFileSync("tmux", ["display-message", "-p", "-t", recorded.pane, "#{pane_pid}"], { encoding: "utf8" }).trim());
  assert.equal(memberState(w.home, name).state, "running");
  fs.writeFileSync(path.join(rec.path, "a.txt"), "changed\n");
  await assert.rejects(() => commitWorktree(w.home, name, { message: "m" }), (e) => e.code === "member_running");
  const again = await w.cli(["tmux", name, "--cwd", rec.path, "--", path.join(bin, "codex")], { HOPTELL_PUSH: "" });
  assert.match(again.stderr, /an earlier session of .* is still running/);
  // A renamed session is still the member: the record follows processes, not the name.
  execFileSync("tmux", ["rename-session", "-t", recorded.sessionId, `${session}-renamed`]);
  assert.equal(memberState(w.home, name).state, "running");
  execFileSync("tmux", ["kill-session", "-t", recorded.sessionId]);
  let state = "running";
  for (let i = 0; i < 100 && state !== "stopped"; i++, await sleep(50)) state = memberState(w.home, name).state;
  assert.equal(state, "stopped");
  assert.ok((await commitWorktree(w.home, name, { message: "m" })).commit);
});

test("hoptell tmux --cwd --task: the agent starts in the folder, the task is stored 0600 and stays off the command line; read_task serves it", { skip: !hasTmux && "tmux not installed" }, async (t) => {
  const w = await world();
  const name = `tt${process.pid}`;
  const session = `hoptell-${name}`;
  t.after(async () => {
    spawnSync("tmux", ["kill-session", "-t", `=${session}`]);
    await w.close();
  });
  const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hoptell-cwd-")));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const secretish = `TASK-CANARY-${crypto.randomBytes(6).toString("hex")}`;
  const taskText = `Implement the parser fix. ${secretish}\n`;
  const taskFile = path.join(w.home, "task.md");
  fs.writeFileSync(taskFile, taskText);
  const out = path.join(w.home, "agent-pwd.txt");
  const r = await w.cli(["tmux", name, "--roles", "implementer", "--cwd", folder, "--task", taskFile, "--", "sh", "-c", `pwd > '${out}'; sleep 30`], { HOPTELL_PUSH: "" });
  assert.match(r.stderr, /attach with: tmux attach/);
  let pwd = "";
  for (let i = 0; i < 50 && !pwd; i++, await sleep(100)) pwd = fs.existsSync(out) ? fs.readFileSync(out, "utf8").trim() : "";
  assert.equal(pwd, folder);
  // The stored task: 0600, the file's bytes; the session gets its digest only.
  const stored = taskFileOf(w.home, name);
  assert.equal(fs.statSync(stored).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(stored, "utf8"), taskText);
  const env = execFileSync("tmux", ["show-environment", "-t", `=${session}`], { encoding: "utf8" });
  assert.match(env, new RegExp(`^HOPTELL_TASK=${sha(taskText)}$`, "m"));
  const commands = execFileSync("tmux", ["list-panes", "-s", "-t", `=${session}`, "-F", "#{pane_start_command}"], { encoding: "utf8" });
  assert.ok(!commands.includes(secretish) && !env.includes(secretish), "the task text is not on a command line or in the environment");

  // The session's MCP server: read_task in its catalog, the stored task, no arguments.
  const s = await w.mcp(name, { HOPTELL_TASK: sha(taskText) });
  const tools = (await s.client.listTools()).tools;
  const readTask = tools.find((x) => x.name === "read_task");
  assert.ok(readTask, "read_task is offered");
  assert.deepEqual(readTask.inputSchema, { type: "object", properties: {}, additionalProperties: false });
  assert.equal(textOf(await s.client.callTool({ name: "read_task", arguments: {} })), taskText);
  // A session without a task (or another name) has no read_task.
  const plain = await w.mcp(`${name}-other`);
  assert.ok(!(await plain.client.listTools()).tools.some((x) => x.name === "read_task"));

  // A later launch with the same name and no --task removes the stored task: the old session's
  // read_task then refuses instead of serving something else.
  spawnSync("tmux", ["kill-session", "-t", `=${session}`]);
  const again = await w.cli(["tmux", name, "--", "sh", "-c", "sleep 30"], { HOPTELL_PUSH: "" });
  assert.match(again.stderr, /attach with: tmux attach/);
  assert.ok(!fs.existsSync(stored));
  assert.match(execFileSync("tmux", ["show-environment", "-t", `=${session}`], { encoding: "utf8" }), /^HOPTELL_TASK=$/m);
  const gone = await s.client.callTool({ name: "read_task", arguments: {} });
  assert.equal(gone.isError, true);
  assert.match(textOf(gone), /the task stored for this session is gone/);
});

test("hoptell tmux: racing launches of one name start one session; a refused launch leaves its task and settings byte for byte", { skip: !hasTmux && "tmux not installed" }, async (t) => {
  const w = await world();
  const name = `tr${process.pid}`;
  const session = `hoptell-${name}`;
  t.after(async () => {
    spawnSync("tmux", ["kill-session", "-t", `=${session}`]);
    await w.close();
  });
  const launchWith = (tag) => {
    const file = path.join(w.home, `task-${tag}.md`);
    fs.writeFileSync(file, `task ${tag}\n`);
    return w.cli(["tmux", name, "--task", file, "--", "sh", "-c", "sleep 30"], { HOPTELL_PUSH: "", HOPTELL_TITLE: `title ${tag}` });
  };
  const runs = await Promise.all(["a", "b"].map(launchWith));
  const won = runs.map((r) => /attach with: tmux attach/.test(r.stderr));
  assert.equal(won.filter(Boolean).length, 1, runs.map((r) => r.stderr).join("\n---\n"));
  const winner = won[0] ? "a" : "b";
  const taskFile = taskFileOf(w.home, name);
  const settingsFile = path.join(w.home, "sessions", `${name}.env`);
  assert.equal(fs.readFileSync(taskFile, "utf8"), `task ${winner}\n`);
  assert.match(fs.readFileSync(settingsFile, "utf8"), new RegExp(`^HOPTELL_TITLE="title ${winner}"$`, "m"));
  assert.match(execFileSync("tmux", ["show-environment", "-t", `=${session}`], { encoding: "utf8" }), new RegExp(`^HOPTELL_TASK=${sha(`task ${winner}\n`)}$`, "m"));
  // A later launch of the running name is refused and writes nothing.
  const before = [fs.readFileSync(taskFile), fs.readFileSync(settingsFile)];
  const late = await launchWith("c");
  assert.match(late.stderr, /already exists/);
  assert.deepEqual([fs.readFileSync(taskFile), fs.readFileSync(settingsFile)], before);
});

test("read_task of a session: only the task with the session's digest, read with the file checks", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "hoptell-rt-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, "sessions"), { mode: 0o700 });
  const file = taskFileOf(home, "dana-impl-1");
  fs.writeFileSync(file, "first task\n", { mode: 0o600 });
  const digest = sha("first task\n");
  assert.equal(textOf(await readSessionTask({ home, name: "dana-impl-1", digest })), "first task\n");
  // Replaced by a later launch: refused, never the new text.
  fs.writeFileSync(file, "second task\n");
  const replaced = await readSessionTask({ home, name: "dana-impl-1", digest });
  assert.equal(replaced.isError, true);
  assert.match(textOf(replaced), /not the one this session was started with/);
  assert.ok(!textOf(replaced).includes("second task"));
  // Readable by others, or a symbolic link: refused.
  fs.writeFileSync(file, "first task\n");
  fs.chmodSync(file, 0o644);
  assert.match(textOf(await readSessionTask({ home, name: "dana-impl-1", digest })), /other users/);
  fs.rmSync(file);
  fs.symlinkSync(path.join(home, "elsewhere"), file);
  assert.match(textOf(await readSessionTask({ home, name: "dana-impl-1", digest })), /symbolic link/);
});
