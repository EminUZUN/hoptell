// The isolation helpers of the opt-in real-session tests (test/skill-evals/real/), checked
// without a model: the tmux wrapper never lets tmux read a config file and refuses any other
// server, and a session's MCP configuration is checked before it starts. Only private tmux
// servers on sockets this test creates are used; the default server is never contacted.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { assertExclusiveMcp, killPrivateServer, realTmux, writeHoptellWrapper, writeMcpConfig, writeTmuxWrapper } from "./skill-evals/real/isolation.mjs";
import { sleep } from "./helpers.js";

const hasTmux = (() => {
  try {
    return spawnSync(realTmux(), ["-V"]).status === 0;
  } catch {
    return false;
  }
})();

test("real-session tmux wrapper: the user's tmux config is never read, and another server is refused", { skip: !hasTmux && "needs tmux" }, async (t) => {
  // Short paths: a Unix socket path is limited to 104 bytes on macOS.
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()).length > 60 ? "/tmp" : os.tmpdir(), "hrs-"));
  const real = realTmux();
  const control = { real, socket: path.join(root, "control.sock") };
  const priv = { real, socket: path.join(root, "test.sock") };
  t.after(() => {
    killPrivateServer(control);
    killPrivateServer(priv);
    fs.rmSync(root, { recursive: true, force: true });
  });
  // A harmless sentinel: a config that only creates a file. Both places tmux looks for a user
  // config get one, in a fake home and config folder.
  const home = path.join(root, "home");
  const xdg = path.join(root, "xdg");
  fs.mkdirSync(path.join(xdg, "tmux"), { recursive: true });
  fs.mkdirSync(home);
  const sentinel = (n) => path.join(root, `sentinel-${n}`);
  fs.writeFileSync(path.join(home, ".tmux.conf"), `run-shell "touch '${sentinel("home")}'"\n`);
  fs.writeFileSync(path.join(xdg, "tmux", "tmux.conf"), `run-shell "touch '${sentinel("xdg")}'"\n`);
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: xdg, TMUX_TMPDIR: path.join(root, "tt") };
  delete env.TMUX;
  delete env.TMUX_PANE;
  fs.mkdirSync(env.TMUX_TMPDIR);
  const seen = async () => {
    await sleep(800);
    return ["home", "xdg"].filter((n) => fs.existsSync(sentinel(n)));
  };

  // Control, on a private socket: plain tmux does read that config, so the sentinel works.
  const c = spawnSync(real, ["-S", control.socket, "new-session", "-d", "-s", "c", "sleep 20"], { env, encoding: "utf8" });
  assert.equal(c.status, 0, c.stderr);
  assert.ok((await seen()).length >= 1, "plain tmux evaluates the user config (the sentinel works)");
  killPrivateServer(control);
  for (const n of ["home", "xdg"]) fs.rmSync(sentinel(n), { force: true });

  // The wrapper: same environment, no config evaluated, the private socket only.
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  const tmux = writeTmuxWrapper(path.join(bin, "tmux"), priv);
  const started = spawnSync(tmux, ["new-session", "-d", "-s", "probe", "sleep 20"], { env, encoding: "utf8" });
  assert.equal(started.status, 0, started.stderr);
  assert.deepEqual(await seen(), [], "the wrapper's server read no config");
  assert.equal(spawnSync(tmux, ["display-message", "-p", "-t", "=probe", "#{socket_path}"], { env, encoding: "utf8" }).stdout.trim(), priv.socket);
  // Options after the command pass through (capture-pane's -S is a start line).
  assert.equal(spawnSync(tmux, ["capture-pane", "-p", "-t", "=probe:", "-S", "-5"], { env }).status, 0);

  // Another socket, socket name or config is refused before tmux runs.
  for (const args of [["-S", path.join(root, "other.sock"), "ls"], ["-L", "other", "ls"], ["-uL", "other", "ls"], ["-f", path.join(home, ".tmux.conf"), "ls"], ["-Sx", "ls"], ["-T", "256", "-S", path.join(root, "other.sock"), "ls"], ["-uT", "256", "-L", "other", "ls"]]) {
    const r = spawnSync(tmux, args, { env, encoding: "utf8" });
    assert.equal(r.status, 2, `${args.join(" ")}: ${r.stderr}`);
    assert.match(r.stderr, /refused/);
  }
  assert.ok(!fs.existsSync(path.join(root, "other.sock")), "no other socket was created");
  assert.deepEqual(fs.readdirSync(env.TMUX_TMPDIR), [], "no server under TMUX_TMPDIR (-L) was started");
  assert.deepEqual(await seen(), [], "still no config read");
});

test("real-session tmux wrapper: only a command or -V alone reaches tmux; every leading option is refused", () => {
  // A recording stand-in for tmux shows exactly what the wrapper would run.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hrs-stub-"));
  try {
    const log = path.join(root, "calls");
    const real = path.join(root, "real-tmux");
    fs.writeFileSync(real, `#!/bin/sh\nprintf '%s|' "$@" >> '${log}'\necho >> '${log}'\n`, { mode: 0o755 });
    const tmux = writeTmuxWrapper(path.join(root, "tmux"), { real, socket: "/priv.sock" });
    const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean) : []);
    const other = path.join(root, "other.sock");
    const cfg = path.join(root, "cfg.conf");
    for (const args of [
      ["-T", "256", "-S", other, "ls"],
      ["-uT", "256", "-S", other, "ls"],
      ["-T", "256", "-f", cfg, "ls"],
      ["-c", "true"],
      ["-2", "ls"],
      ["-V", "-S", other],
      ["--", "ls"],
      [],
    ]) {
      const r = spawnSync(tmux, args, { encoding: "utf8" });
      assert.equal(r.status, 2, `${args.join(" ")}: ${r.stderr}`);
      assert.match(r.stderr, /refused/);
      assert.deepEqual(calls(), [], `${args.join(" ")} never reached tmux`);
    }
    assert.equal(spawnSync(tmux, ["-V"]).status, 0);
    assert.equal(spawnSync(tmux, ["capture-pane", "-p", "-t", "=probe:", "-S", "-200"]).status, 0);
    assert.equal(spawnSync(tmux, ["new-session", "-d", "-s", "x", "-f", "keep"]).status, 0);
    assert.deepEqual(calls(), [
      "-V|",
      "-S|/priv.sock|-f|/dev/null|capture-pane|-p|-t|=probe:|-S|-200|",
      "-S|/priv.sock|-f|/dev/null|new-session|-d|-s|x|-f|keep|",
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("real-session MCP configuration: only this checkout's hoptell server, pinned to the test relay", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hrs-mcp-"));
  try {
    const bin = "/repo/bin/hoptell.js";
    const env = { HOPTELL_RELAY: "ws://127.0.0.1:1", HOPTELL_TOKEN: "t", HOPTELL_ENV: "/e", HOPTELL_RELAYS: "/r", HOPTELL_HOME: "/h" };
    const file = writeMcpConfig(path.join(dir, "mcp.json"), { node: "node", bin, env });
    assert.doesNotThrow(() => assertExclusiveMcp(["-p", "x", "--strict-mcp-config", "--mcp-config", file], { bin }));
    assert.throws(() => assertExclusiveMcp(["-p", "x", "--mcp-config", file], { bin }), /strict/);
    assert.throws(() => assertExclusiveMcp(["--strict-mcp-config", "--mcp-config", file, "--mcp-config", file], { bin }), /exactly one/);
    const two = path.join(dir, "two.json");
    fs.writeFileSync(two, JSON.stringify({ mcpServers: { hoptell: { command: "node", args: [bin, "mcp"], env }, other: { command: "x" } } }));
    assert.throws(() => assertExclusiveMcp(["--strict-mcp-config", "--mcp-config", two], { bin }), /unexpected/);
    const loose = writeMcpConfig(path.join(dir, "loose.json"), { node: "node", bin, env: { ...env, HOPTELL_RELAYS: "" } });
    assert.throws(() => assertExclusiveMcp(["--strict-mcp-config", "--mcp-config", loose], { bin }), /HOPTELL_RELAYS/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("real-session hoptell wrapper: the test relay, token and relays file win over the caller's environment", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "hrs-hop-"));
  try {
    // A stand-in for bin/hoptell.js that prints what it was started with.
    const show = path.join(base, "show.mjs");
    fs.writeFileSync(show, 'console.log(JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("HOPTELL_")))));\n');
    const envFile = path.join(base, "hoptell.env");
    const pinned = { HOPTELL_RELAY: "ws://127.0.0.1:1", HOPTELL_TOKEN: "test-token", HOPTELL_RELAYS: path.join(base, "relays.json"), HOPTELL_HOME: path.join(base, "home") };
    const w = writeHoptellWrapper(path.join(base, "hoptell"), { node: process.execPath, bin: show, pinned, envFile, base });
    const run = (env) => JSON.parse(spawnSync(w, ["mcp"], { env: { PATH: process.env.PATH, ...env }, encoding: "utf8" }).stdout);
    const live = { HOPTELL_RELAY: "wss://relay.example.invalid", HOPTELL_TOKEN: "other", HOPTELL_RELAYS: "/elsewhere/relays.json", HOPTELL_HOME: "/elsewhere", HOPTELL_ENV: "/elsewhere/.env" };
    const got = run(live);
    for (const [k, v] of Object.entries(pinned)) assert.equal(got[k], v, k);
    assert.equal(got.HOPTELL_ENV, envFile, "a settings file outside the test folder is replaced");
    const own = path.join(base, "home", "sessions", "dana-reviewer-1.env");
    assert.equal(run({ ...live, HOPTELL_ENV: own }).HOPTELL_ENV, own, "a launched session's own file is kept");
    assert.equal(run({ HOPTELL_ENV: `${base}/../elsewhere.env` }).HOPTELL_ENV, envFile, "no way out with ..");
    assert.equal(run({}).HOPTELL_ENV, envFile);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
