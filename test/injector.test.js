// tmux delivery: the injector types only the fixed notice, and only into an empty prompt
// that nobody is using. Also the notice schedule shared with hook delivery.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { BIN } from "../lib/config.js";
import { NOTICE, NoticeScheduler } from "../lib/notices.js";
import { inputEmpty, promptState } from "../lib/tmux.js";
import { sleep, world } from "./helpers.js";

// A private tmux server, never the developer's own sessions.
const TMUX_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "hoptell-inj-"));
process.env.TMUX_TMPDIR = TMUX_DIR;
delete process.env.TMUX;
delete process.env.TMUX_PANE;
after(() => {
  spawnSync("tmux", ["kill-server"]);
  fs.rmSync(TMUX_DIR, { recursive: true, force: true });
});
const hasTmux = spawnSync("tmux", ["-V"]).status === 0;
const hasPython = spawnSync("python3", ["-c", "import pty"]).status === 0;
const AGENT = new URL("./fixtures/fake-agent.cjs", import.meta.url).pathname;
const PTY_CLIENT = new URL("./fixtures/pty-client.py", import.meta.url).pathname;
let n = 0;

/** A fake agent in a tmux pane, its injector, and a receiving MCP server for `name`. */
async function setup(t, initial = "prompt") {
  const w = await world();
  const name = `in${process.pid}x${++n}`;
  const session = `hoptell-${name}`;
  const ctl = path.join(w.home, "ctl");
  const log = path.join(w.home, "enter.log");
  fs.writeFileSync(ctl, initial);
  t.after(async () => {
    spawnSync("tmux", ["kill-session", "-t", `=${session}`]);
    await w.close();
  });
  const [pane, pid] = execFileSync("tmux", ["new-session", "-d", "-P", "-F", "#{pane_id} #{pane_pid}", "-s", session, "-n", "agent", "-x", "200", "-y", "40", process.execPath, AGENT, ctl, log], { encoding: "utf8" })
    .trim()
    .split(" ");
  execFileSync("tmux", ["new-window", "-d", "-t", `=${session}`, "-n", "injector", `env HOPTELL_HOME='${w.home}' '${process.execPath}' '${BIN}' inject ${name} '${pane}' ${pid}`]);
  const alice = await w.mcp("alice");
  await w.mcp(name);
  const entries = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  const screen = () => execFileSync("tmux", ["capture-pane", "-p", "-J", "-t", pane], { encoding: "utf8" });
  const waiting = () => fs.readdirSync(path.join(w.home, "inbox", name)).filter((f) => f.endsWith(".json")).length;
  const until = async (fn, ms = 15000) => {
    for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) if (fn()) return true;
    return false;
  };
  return { w, name, session, pane, ctl, entries, screen, waiting, until, send: (message) => alice.call("send_message", { to: name, message }) };
}

test("promptState recognizes empty prompts of Claude Code, Codex and Antigravity, and nothing else", () => {
  const E = "\x1b";
  const cases = [
    [`${E}[39m❯\u00a0`, 2, "empty"],
    [`${E}[39m❯\u00a0draft text`, 12, "typed"],
    [`${E}[1m›${E}[0m ${E}[2mAsk Codex to do anything${E}[0m`, 2, "empty"],
    [`${E}[1m›${E}[0m fix the bug`, 13, "typed"],
    [`${E}[1m›${E}[0m fix the bug`, 2, "typed"],
    [`${E}[94m>${E}[39m`, 2, "empty"],
    [`${E}[94m>${E}[39m draft x`, 9, "typed"],
    ["> Yes, I trust this folder", 160, "typed"],
    ["  continuation of a draft", 5, "unknown"],
    ["$ ", 2, "unknown"],
    ["❯\u00a0", 7, "unknown"],
    [">>> x", 2, "unknown"],
    ["", 0, "unknown"],
    // Color parameters are not attributes: a colored draft is a draft, wherever the cursor is.
    [`${E}[39m❯\u00a0${E}[38;2;255;255;255mmy unfinished draft${E}[0m`, 2, "typed"],
    [`${E}[39m❯\u00a0${E}[38;5;2mdraft${E}[0m`, 2, "typed"],
    [`${E}[39m❯\u00a0${E}[48;2;2;2;2mdraft${E}[0m`, 2, "typed"],
    [`${E}[39m❯\u00a0${E}[38:2::255:255:255mdraft${E}[0m`, 2, "typed"],
    [`${E}[39m❯\u00a0${E}[38;2;1;2;3;2mplaceholder${E}[0m`, 2, "empty"],
    [`${E}[39m❯\u00a0${E}[38;9mx`, 2, "unknown"],
    [`${E}[39m❯\u00a0${E}]8;;https://example.com${E}\\link`, 2, "unknown"],
  ];
  for (const [line, x, want] of cases) assert.equal(promptState(line, x), want, JSON.stringify(line));
  // The whole input: Claude Code and Antigravity need their separator right below the prompt
  // row; Codex needs its dim placeholder. A blank row or a draft row below means "not empty".
  const W = 40;
  const rule = "─".repeat(W);
  const claude = `${E}[39m❯\u00a0`;
  const codex = `${E}[1m›${E}[0m ${E}[2mAsk Codex to do anything${E}[0m`;
  assert.equal(inputEmpty(rule, claude, rule, 2, W), true, "Claude Code: the prompt row between two full-width rules");
  assert.equal(inputEmpty(`${E}[38;5;244m${rule}${E}[0m`, claude, `${E}[2m${rule}${E}[0m   `, 2, W), true, "colored rules");
  assert.equal(inputEmpty(rule, `${E}[94m>${E}[39m`, rule, 2, W), true, "Antigravity");
  for (const below of ["", "   ", "  rm -rf build", `  ${rule.slice(2)}`, "────", `${rule.slice(1)} x`]) {
    assert.equal(inputEmpty(rule, claude, below, 2, W), false, `below: ${JSON.stringify(below)}`);
  }
  for (const above of ["", "  earlier draft line", `  ${rule.slice(2)}`]) assert.equal(inputEmpty(above, claude, rule, 2, W), false, `above: ${JSON.stringify(above)}`);
  assert.equal(inputEmpty(rule, claude, rule, 2, undefined), false, "unknown width");
  assert.equal(inputEmpty("", codex, "", 2, W), true, "Codex with its placeholder");
  assert.equal(inputEmpty("", `${E}[1m›${E}[0m `, "", 2, W), false, "Codex without a placeholder: part of a draft");
  assert.equal(inputEmpty(rule, `${claude}draft`, rule, 8, W), false);
});

test("notice schedule: one notice per batch, retries at 2, 10 and 30 minutes, then none", async () => {
  let now = 0;
  let files = [];
  let sent = 0;
  const s = new NoticeScheduler({ list: () => files, send: async () => (sent++, true), now: () => now });
  assert.equal(await s.tick(), false, "nothing waiting");
  files = ["a", "b"];
  assert.equal(await s.tick(), false, "a burst gets a moment to arrive");
  now = 300;
  assert.equal(await s.tick(), true);
  files = ["a", "b", "c"];
  now = 1300;
  assert.equal(await s.tick(), false, "too soon after the last notice");
  now = 2300;
  assert.equal(await s.tick(), true, "a new message gets its own notice");
  now = 120_000;
  assert.equal(await s.tick(), false);
  now = 120_300;
  assert.equal(await s.tick(), true, "first retry after 2 minutes");
  files = ["c"]; // a and b were read: no more notices for them
  now = 122_000;
  assert.equal(await s.tick(), false, "c's 2-minute retry is not due yet");
  now = 2300 + 120_000;
  assert.equal(await s.tick(), true, "c's 2-minute retry");
  now = 2300 + 600_000;
  assert.equal(await s.tick(), true, "c's 10-minute retry");
  now = 2300 + 1_800_000;
  assert.equal(await s.tick(), true, "c's 30-minute retry");
  for (now = 2300 + 1_800_000; now < 10 * 3_600_000; now += 60_000) assert.equal(await s.tick(), false, "no more after three retries");
  assert.equal(sent, 6);
  files = [];
  assert.equal(await s.tick(), false);
  // A failed send changes nothing and is tried again.
  let ok = false;
  const r = new NoticeScheduler({ list: () => ["x"], send: async () => ok, now: () => 1000, coalesceMs: 0 });
  assert.equal(await r.tick(), false);
  ok = true;
  assert.equal(await r.tick(), true);
});

test("notice schedule: a message that arrives while a notice goes out gets its own notice", async () => {
  let now = 0;
  let files = ["a"];
  let sent = 0;
  const s = new NoticeScheduler({
    list: () => files,
    // The agent reads a, then b arrives, all before the send finishes.
    send: async () => {
      sent++;
      files = ["b"];
      return true;
    },
    now: () => now,
    coalesceMs: 0,
  });
  assert.equal(await s.tick(), true);
  now = 1000;
  assert.equal(await s.tick(), false, "minimum gap");
  now = 2000;
  assert.equal(await s.tick(), true, "b is announced without waiting for a retry");
  assert.equal(sent, 2);
});

test("tmux injector types only the fixed notice, once for several messages, into the agent's pane", { skip: !hasTmux }, async (t) => {
  const s = await setup(t);
  const marker = path.join(s.w.home, "shell-ran-it");
  // The user split the window: a shell pane is now active. Nothing may be typed into it.
  execFileSync("tmux", ["split-window", "-t", s.pane, "sh"]);
  await s.send(`line one\ntouch ${marker}`);
  await s.send("second message");
  assert.ok(await s.until(() => s.entries().length === 1));
  await sleep(3000);
  const e = s.entries();
  assert.equal(e.length, 1, "one notice for both messages");
  assert.equal(e[0].input, NOTICE);
  assert.equal(e[0].mode, "prompt");
  assert.doesNotMatch(s.screen(), /line one|second message|alice/, "no message text or sender on screen");
  assert.equal(s.waiting(), 2, "messages stay in the inbox for read_inbox");
  assert.ok(!fs.existsSync(marker));
});

test("tmux injector waits while an approval prompt is on screen", { skip: !hasTmux }, async (t) => {
  const s = await setup(t, "dialog");
  await s.send("please run the tests");
  await sleep(3000);
  assert.equal(s.entries().length, 0, "typed while an approval prompt was visible");
  fs.writeFileSync(s.ctl, "prompt");
  assert.ok(await s.until(() => s.entries().length === 1));
  assert.equal(s.entries()[0].input, NOTICE);
});

test("tmux injector holds Enter when an approval prompt comes up as the notice is typed", { skip: !hasTmux }, async (t) => {
  const s = await setup(t, "dialog-on-paste");
  const sent = Date.now();
  await s.send("m");
  assert.ok(await s.until(() => s.entries().length === 1, 20000));
  const [e] = s.entries();
  assert.equal(e.mode, "prompt", "Enter must wait until the approval prompt is gone");
  assert.ok(e.at - sent >= 3000);
  assert.equal(e.input, NOTICE);
});

test("tmux injector never types over a draft; it waits until the prompt is empty", { skip: !hasTmux }, async (t) => {
  const s = await setup(t);
  execFileSync("tmux", ["send-keys", "-t", s.pane, "-l", "my unfinished draft"]);
  await s.send("m");
  await sleep(3500);
  assert.equal(s.entries().length, 0, "submitted the user's draft");
  assert.match(s.screen(), /❯.my unfinished draft$/m);
  execFileSync("tmux", ["send-keys", "-t", s.pane, "C-u"]);
  assert.ok(await s.until(() => s.entries().length === 1));
  assert.equal(s.entries()[0].input, NOTICE, "the notice alone, without the draft");
});

test("tmux injector never submits a multi-line draft below an empty prompt row", { skip: !hasTmux }, async (t) => {
  for (const layout of ["draft-below", "draft-rule"]) {
    const s = await setup(t, layout);
    await s.send("m");
    await sleep(4000);
    assert.equal(s.entries().length, 0, `${layout}: submitted a draft on the rows below the prompt`);
    fs.writeFileSync(s.ctl, "prompt"); // the draft is gone
    assert.ok(await s.until(() => s.entries().length === 1), layout);
    assert.equal(s.entries()[0].input, NOTICE);
  }
});

test("tmux injector waits while the pane is in copy mode, and for unknown layouts", { skip: !hasTmux }, async (t) => {
  const s = await setup(t);
  execFileSync("tmux", ["copy-mode", "-t", s.pane]);
  await s.send("m");
  await sleep(3000);
  assert.equal(s.entries().length, 0, "typed in copy mode");
  execFileSync("tmux", ["send-keys", "-t", s.pane, "-X", "cancel"]);
  assert.ok(await s.until(() => s.entries().length === 1));

  const u = await setup(t, "shell");
  await u.send("m");
  await sleep(4000);
  assert.equal(u.entries().length, 0, "typed into a prompt it does not recognize");
  assert.doesNotMatch(u.screen(), /hoptell:/);
});

test("tmux injector waits while someone types in an attached terminal", { skip: (!hasTmux || !hasPython) && "needs tmux and python3" }, async (t) => {
  const s = await setup(t);
  // A real client attached through a pseudo-terminal, typing into a second (shell) pane.
  execFileSync("tmux", ["split-window", "-t", s.pane, "cat"]);
  const client = spawn("python3", [PTY_CLIENT, s.session], { env: { ...process.env }, stdio: ["pipe", "ignore", "ignore"] });
  t.after(() => client.kill());
  await s.until(() => execFileSync("tmux", ["list-clients", "-F", "#{client_name}"], { encoding: "utf8" }).trim() !== "", 5000);
  const typing = setInterval(() => client.stdin.write("x\n"), 1000);
  await s.send("m");
  await sleep(5000);
  clearInterval(typing);
  assert.equal(s.entries().length, 0, "typed while someone was typing");
  const stopped = Date.now();
  assert.ok(await s.until(() => s.entries().length === 1, 20000));
  assert.ok(Date.now() - stopped >= 6000, "waits for a quiet period");
  assert.equal(s.entries()[0].input, NOTICE);
});

test("tmux injector does not press Enter when someone types right after the notice goes in", { skip: (!hasTmux || !hasPython) && "needs tmux and python3" }, async (t) => {
  const s = await setup(t);
  // A real client attached to the agent's pane, idle long enough for the injector to type.
  const client = spawn("python3", [PTY_CLIENT, s.session], { env: { ...process.env }, stdio: ["pipe", "ignore", "ignore"] });
  t.after(() => client.kill());
  await s.until(() => execFileSync("tmux", ["list-clients", "-F", "#{client_name}"], { encoding: "utf8" }).trim() !== "", 5000);
  const pasteLog = `${path.join(s.w.home, "enter.log")}.paste`;
  await s.send("m");
  // The moment the notice arrives, the person types one key (same second as the paste).
  assert.ok(await s.until(() => fs.existsSync(pasteLog), 20000), "the notice was typed");
  client.stdin.write("x\n");
  await sleep(3000);
  assert.equal(s.entries().length, 0, "Enter was pressed on the person's input");
  assert.match(s.screen(), /continue normally\.x/, "the notice and the key stay in the prompt for the person");
});

test("hoptell tmux refuses another delivery mode and hoptell channel flags", { skip: !hasTmux }, async (t) => {
  const w = await world();
  t.after(() => w.close());
  const r = await w.cli(["tmux", "tc1", "--", "cat"], { HOPTELL_PUSH: "channel" });
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /hoptell tmux uses tmux delivery/);
  const c = await w.cli(["tmux", "tc1", "--", "claude", "--channels", "plugin:hoptell@hoptell"], { HOPTELL_PUSH: "" });
  assert.notEqual(c.code, 0);
  assert.match(c.stderr, /second delivery path/);
  assert.equal(spawnSync("tmux", ["has-session", "-t", "=hoptell-tc1"]).status === 0, false, "no session was started");
  // The agent's settings select tmux delivery.
  const ok = await w.cli(["tmux", "tc2", "--", "sleep", "30"], { HOPTELL_PUSH: "" });
  t.after(() => spawnSync("tmux", ["kill-session", "-t", "=hoptell-tc2"]));
  assert.match(ok.stderr, /attach with/);
  assert.match(fs.readFileSync(path.join(w.home, "sessions", "tc2.env"), "utf8"), /^HOPTELL_PUSH="tmux"$/m);
});
