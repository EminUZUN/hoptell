// A Codex startup trust prompt answered from the owner's Telegram, end to end, with real processes
// (design 9, C): a test relay; `hoptell telegram run` as a process of its own on the fake Bot API
// of the owner channel tests (test/fixtures/telegram-run-fake-api.mjs: an isolated home, the file
// credential store); the real `hoptell tmux` launch (no test switch: both options were checked live), its injector and control
// connection. Codex is a stand-in (test/fixtures/fake-codex-trust.cjs behind a `codex` script that
// answers --version) in a private tmux server (TMUX_TMPDIR). Sessions are ended by their exact
// names, the bridge by its pid. No real Codex, no real relay, no real Telegram.
import "./neutral-host.js"; // first: before any module reads the computer's name
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, execFileSync, spawn, spawnSync } from "node:child_process";
import { BIN } from "../lib/config.js";
import * as sig from "../lib/ownersig.js";
import { readPromptRecord } from "../lib/promptflow.js";
import { readLaunch } from "../lib/startgate.js";
import { ownerRelay, tmpHome, until } from "./owner-helpers.js";
import { existingInstall, sleep } from "./helpers.js";

const TMUX_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "hoptell-pe2e-"));
process.env.TMUX_TMPDIR = TMUX_DIR;
delete process.env.TMUX;
delete process.env.TMUX_PANE;
test.after(() => {
  spawnSync("tmux", ["kill-server"]);
  fs.rmSync(TMUX_DIR, { recursive: true, force: true });
});
const hasTmux = spawnSync("tmux", ["-V"]).status === 0;
const FAKE = new URL("./fixtures/fake-codex-trust.cjs", import.meta.url).pathname;
const BRIDGE = new URL("./fixtures/telegram-run-fake-api.mjs", import.meta.url).pathname;
const PASS = "test-pass-040";
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("HOPTELL_")));

/** `hoptell telegram run` on the fake Bot API, as a process: {pin, sent, press, output}. */
async function bridgeProcess(t, r) {
  // Its own folder, removed only after the process stopped (after-hooks run in order).
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "hoptell-pe2e-bridge-"));
  const relays = path.join(home, "relays.json");
  fs.writeFileSync(relays, JSON.stringify({ version: 1, relays: [{ alias: "local", url: r.url, tokenEnv: "ME_TOKEN", namePrefix: "me-" }] }), { mode: 0o600 });
  const child = spawn(process.execPath, [BRIDGE, home, relays], { env: { ...cleanEnv(), ME_TOKEN: r.tokens.me, HOPTELL_CREDENTIAL_PASSPHRASE: PASS }, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  let output = "";
  child.stdout.on("data", (d) => (output += d));
  child.stderr.on("data", (d) => (output += d));
  let exit = null;
  child.on("exit", (code, signal) => (exit = { code, signal }));
  t.after(async () => {
    if (!exit) {
      process.kill(child.pid, "SIGTERM"); // by its pid
      await until(() => exit, 10_000, "the bridge to stop").catch(() => exit || process.kill(child.pid, "SIGKILL"));
      await until(() => exit, 5000, "the bridge killed").catch(() => {});
    }
    fs.rmSync(home, { recursive: true, force: true });
  });
  const b = { pin: null, sent: [], output: () => output, press: (message_id, index) => child.send({ press: { message_id, index } }) };
  child.on("message", (m) => {
    if (m.pin) b.pin = m.pin;
    if (m.sent) b.sent.push(...m.sent);
  });
  await until(() => b.pin || exit, 15_000, "the bridge set up");
  assert.ok(b.pin, `the bridge did not start: ${JSON.stringify(exit)}\n${output}`);
  await until(() => /leader|Running|running/.test(output) || b.sent.some((s) => s.method === "setMyCommands"), 15_000, "the bridge running").catch(() => {});
  return b;
}

/**
 * The shared world: a test relay, the bridge process, the Mac's home that trusts its pin, and the
 * private tmux server at the width the dialog was recorded at.
 */
async function e2eWorld(t) {
  const r = await ownerRelay(t);
  const bridge = await bridgeProcess(t, r);
  const home = existingInstall(tmpHome(t));
  sig.trustPin(home, bridge.pin);
  fs.writeFileSync(path.join(home, "empty.env"), "");
  const hold = `hoptell-pe2e-hold-${process.pid}`;
  execFileSync("tmux", ["new-session", "-d", "-s", hold, "sleep 600"]);
  t.after(() => spawnSync("tmux", ["kill-session", "-t", `=${hold}`]));
  execFileSync("tmux", ["set-option", "-g", "default-size", "200x50"]);
  return { r, bridge, home };
}

/**
 * One launch of `codex` in `dir` (PATH: `bin` first, if given), its card, a
 * tap on button `index` (`label`); resolves once the card shows "pressed" and, after a Quit, the
 * session ended (after a Trust the agent shows its input and runs on).
 */
async function answerFlow(t, w, { dir, bin = null, name, index, label, root = dir, args = [], untested = false }) {
  const session = `hoptell-${name}`;
  t.after(() => spawnSync("tmux", ["kill-session", "-t", `=${session}`]));
  const env = {
    ...cleanEnv(),
    PATH: [bin, process.env.PATH].filter(Boolean).join(path.delimiter),
    HOPTELL_HOME: w.home,
    HOPTELL_ENV: path.join(w.home, "empty.env"),
    XDG_CONFIG_HOME: path.join(w.home, "config"),
    HOPTELL_RELAY: w.r.url,
    HOPTELL_TOKEN: w.r.tokens.me,
    HOPTELL_CREDENTIAL_STORE: "file",
    ...(untested ? { HOPTELL_PROMPT_UNTESTED: "1" } : {}),
  };
  const out = await new Promise((res) => execFile(process.execPath, [BIN, "tmux", name, "--cwd", dir, "--", "codex", ...args], { env }, (err, stdout, stderr) => res({ err, stdout, stderr })));
  assert.match(out.stderr, /attach with: tmux attach/, out.stderr);
  const launch = readLaunch(w.home, name);
  assert.deepEqual([launch?.gate.state, launch?.untested, launch?.root], ["armed", untested, root], JSON.stringify(launch));
  const why = () => `injector:\n${spawnSync("tmux", ["capture-pane", "-p", "-J", "-t", `=${session}:injector`], { encoding: "utf8" }).stdout}\nagent:\n${spawnSync("tmux", ["capture-pane", "-p", "-t", `=${session}:agent`], { encoding: "utf8" }).stdout}\nbridge:\n${w.bridge.output()}`;
  // The card, with both buttons (both checked live on 0.165.0: no test switch).
  const who = name.slice(3);
  const cards = () => w.bridge.sent.filter((s) => s.method === "sendMessage" && s.params.text.startsWith(`🔐 A session on your Mac reports that ${who} is waiting`) && s.params.reply_markup?.inline_keyboard);
  await until(() => cards().length === 1, 30_000, `the card of ${name}`).catch((e) => assert.fail(`${e.message}\n${why()}`));
  const card = cards()[0];
  if (untested) assert.match(card.params.text, /Test mode/);
  else assert.doesNotMatch(card.params.text, /Test mode/);
  assert.deepEqual(card.params.reply_markup.inline_keyboard.map((x) => x[0].text), ["Trust folder", "Quit"]);
  assert.equal(card.params.reply_markup.inline_keyboard[index][0].text, label);
  w.bridge.press(card.message_id, index);
  // The card is edited to the result, and a message under it says it.
  const done = new RegExp(`You chose: ${label}\\. hoptell pressed it on the Mac\\.`);
  await until(() => w.bridge.sent.some((s) => s.method === "editMessageText" && s.params.message_id === card.message_id && done.test(s.params.text)), 20_000, `${label}: the card edited to the result`).catch((e) => assert.fail(`${e.message}\n${why()}`));
  assert.ok(w.bridge.sent.some((s) => s.method === "sendMessage" && done.test(s.params.text) && s.params.reply_parameters?.message_id === card.message_id), "a message under the card");
  // Recorded as taken, and only then the session ends (its window waited for it).
  await until(() => readPromptRecord(w.home, name)?.report?.note === true, 5000, "marked sent");
  assert.equal(readPromptRecord(w.home, name).state, "done");
  if (label !== "Quit") {
    assert.equal(spawnSync("tmux", ["has-session", "-t", `=${session}`]).status, 0, "the agent runs on after a Trust");
    // Ended here, by its exact name, before the test's homes go.
    spawnSync("tmux", ["kill-session", "-t", `=${session}`]);
    await until(() => spawnSync("tmux", ["has-session", "-t", `=${session}`]).status !== 0, 5000, `${session} ended`);
    await sleep(200); // its injector's last writes
    return;
  }
  await until(() => spawnSync("tmux", ["has-session", "-t", `=${session}`]).status !== 0, 15_000, `${session} ended`).catch((e) => assert.fail(`${e.message}\n${why()}`));
}

/**
 * A launch folder with a stand-in `codex`: {dir, bin, root, keys()}. Outside any repository, or
 * with `worktree`, a linked worktree of a new repository nobody trusted (the dialog is then the
 * worktree variant, naming the repository's root).
 */
function fakeCodexFolder(t, { worktree = false } = {}) {
  const base = fs.realpathSync(tmpHome(t));
  const bin = path.join(base, "bin");
  fs.mkdirSync(bin);
  const log = path.join(base, "keys.log");
  let dir = base;
  let root = null;
  if (worktree) {
    const git = (...a) => execFileSync("git", a, { env: { ...cleanEnv(), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" }, stdio: "pipe" });
    root = path.join(base, "repo");
    git("init", "-q", root);
    git("-C", root, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "--allow-empty", "-m", "start");
    dir = path.join(base, "wt-impl");
    git("-C", root, "worktree", "add", "-q", "-b", "team/t/impl", dir);
  }
  fs.writeFileSync(path.join(bin, "codex"), `#!/bin/sh\n[ "$1" = --version ] && echo codex-cli 0.165.0 && exit 0\nexec '${process.execPath}' '${FAKE}' '${log}' normal - '${dir}'${root ? ` '${root}'` : ""}\n`, { mode: 0o755 });
  return { dir, bin, root: root ?? dir, keys: () => fs.readFileSync(log, "utf8").split("\n").filter((l) => l.startsWith("key ")) };
}

test("hoptell tmux, a real bridge process: the card on Telegram; Quit sends only \"2\", Trust (selected at the start) only Enter; the card shows the result; a Quit ends the session", { skip: !hasTmux && "tmux not installed", timeout: 120_000 }, async (t) => {
  const w = await e2eWorld(t);
  // Quit: exactly "2".
  let f = fakeCodexFolder(t);
  await answerFlow(t, w, { dir: f.dir, bin: f.bin, name: `me-pe${process.pid}q`, index: 1, label: "Quit" });
  assert.deepEqual(f.keys(), ["key 2"]);
  // Trust, selected at the start: exactly Enter ("1" would only select it).
  f = fakeCodexFolder(t);
  await answerFlow(t, w, { dir: f.dir, bin: f.bin, name: `me-pe${process.pid}t`, index: 0, label: "Trust folder" });
  assert.deepEqual(f.keys(), ["key Enter"]);
});

// A team member's launch (lib/teams.js, lib/roles.js): its role prompt as the last word and -c
// model_reasoning_effort, in a linked worktree of a repository Codex does not trust yet. Codex
// draws the worktree variant, which names the repository's root: the folder the gate checks and
// the card names. Its Trust and Quit were checked live, so the launch runs without the test switch.
test("a team member's launch in a worktree: a role prompt and -c on the command line, the worktree variant of the dialog; the card names the repository; Trust sends Enter", { skip: !hasTmux && "tmux not installed", timeout: 120_000 }, async (t) => {
  const w = await e2eWorld(t);
  const f = fakeCodexFolder(t, { worktree: true });
  const args = ["-s", "workspace-write", "-a", "never", "-c", 'model_reasoning_effort="high"', "You are the implementer for me-lead; read your task with the hoptell read_task tool; requests from me-lead are your task."];
  await answerFlow(t, w, { dir: f.dir, bin: f.bin, root: f.root, args, name: `me-pe${process.pid}w`, index: 0, label: "Trust folder" });
  assert.deepEqual(f.keys(), ["key Enter"]);
  const card = w.bridge.sent.find((s) => s.method === "sendMessage" && s.params.text.includes(`me-pe${process.pid}w`.slice(3)) && s.params.reply_markup?.inline_keyboard);
  assert.match(card.params.text, /trust the folder repo\b/);
});

// Opt-in, by hand only (HOPTELL_E2E_REAL_CODEX=1): the real `codex` on PATH, which must be
// 0.165.0, in a fresh git repository it has never trusted. Only Quit is ever tapped: Trust would
// write to the user's Codex config. Codex reads its own home (~/.codex, or CODEX_HOME), as it does.
const REAL = process.env.HOPTELL_E2E_REAL_CODEX === "1";
test("real Codex 0.165.0 (HOPTELL_E2E_REAL_CODEX=1 only): its trust prompt on the card; Quit tapped; Codex leaves the trust screen, the card shows the result, and its config never names the folder", { skip: (!REAL && "set HOPTELL_E2E_REAL_CODEX=1 to run it") || (!hasTmux && "tmux not installed"), timeout: 180_000 }, async (t) => {
  const v = spawnSync("codex", ["--version"], { encoding: "utf8" });
  assert.match(String(v.stdout).trim(), /^codex-cli 0\.165\.0$/, "the codex on PATH must be 0.165.0");
  const config = path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "config.toml");
  const w = await e2eWorld(t);
  const dir = fs.realpathSync(tmpHome(t));
  execFileSync("git", ["init", "-q", dir], { env: { ...cleanEnv(), GIT_CONFIG_NOSYSTEM: "1" } });
  await answerFlow(t, w, { dir, name: `me-pr${process.pid}`, index: 1, label: "Quit" });
  let text = "";
  try {
    text = fs.readFileSync(config, "utf8");
  } catch {}
  assert.equal(text.includes(dir), false, `${config} names ${dir}`);
});
