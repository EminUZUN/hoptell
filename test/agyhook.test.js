// Stop-hook delivery for Antigravity (lib/agyhook.js): at the end of an agy turn, messages waiting in
// the session's inbox make the hook answer "continue" with the fixed notice, once per message; held
// messages get the held notice. The answer and the hook's state never hold message text.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startRelay } from "../lib/relay.js";
import { RelayClient } from "../lib/client.js";
import { createEngine } from "../lib/engine.js";
import { readSettings } from "../lib/settings.js";
import { HELD_NOTICE, NOTICE } from "../lib/notices.js";
import { ALLOW, agyHooksSnippet, hookAgyStop } from "../lib/agyhook.js";
import { fakeToken } from "./helpers.js";
import { tmpHome, until } from "./owner-helpers.js";

const ME = "m_mmmmmmmmmmmmmmmmmmmmmmmmmm";
const BOB = "m_bbbbbbbbbbbbbbbbbbbbbbbbbb";
const REALM = "c".repeat(32);
const BIN = fileURLToPath(new URL("../bin/hoptell.js", import.meta.url));
const CANARY = "CANARY-BODY-5c2e";
const textOf = (r) => r.content[0].text;

/** A stand-in for noticeLister that lists `entries()` for any session. */
const lister = (entries) => () => async () => entries();

test("the hook answers once per waiting message, and the held notice when only held messages wait", async (t) => {
  const home = tmpHome(t);
  let entries = [];
  const stop = (env = {}) => hookAgyStop({ home, env: { HOPTELL_NAME: "me-agy", ...env }, relay: null, list: lister(() => entries) });
  assert.deepEqual(await stop(), ALLOW, "nothing waits");
  entries = ["a.json"];
  assert.deepEqual(await stop(), { decision: "continue", reason: NOTICE });
  assert.deepEqual(await stop(), ALLOW, "an announced message does not keep agy running again");
  entries = ["a.json", "b.json"];
  assert.deepEqual(await stop(), { decision: "continue", reason: NOTICE }, "a new message gets its own notice");
  entries = ["held:q_aaaaaaaaaaaaaaaa/x"];
  assert.deepEqual(await stop(), { decision: "continue", reason: HELD_NOTICE });
  entries = ["held:q_aaaaaaaaaaaaaaaa/x", "c.json"];
  assert.deepEqual(await stop(), { decision: "continue", reason: NOTICE }, "a held message beside a new one: the inbox notice");
  // Read messages are forgotten, so the same entry name later is announced again.
  entries = [];
  assert.deepEqual(await stop(), ALLOW);
  entries = ["a.json"];
  assert.deepEqual(await stop(), { decision: "continue", reason: NOTICE });
  const file = path.join(home, "wake", "agy-me-agy.stop.json");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { announced: ["a.json"] });
  // Without a usable name, or under hoptell tmux (its injector announces), the hook does nothing.
  entries = ["d.json"];
  for (const env of [{ HOPTELL_NAME: "" }, { HOPTELL_NAME: "../x" }, { HOPTELL_PUSH: "tmux" }]) assert.deepEqual(await stop(env), ALLOW, JSON.stringify(env));
  assert.deepEqual(await stop(), { decision: "continue", reason: NOTICE }, "the skipped checks did not mark it announced");
});

test("over a real relay: a message to the agy session is announced once, a held one with the held notice, never with its text", async (t) => {
  const tokens = { shared: fakeToken(), me: fakeToken(), bob: fakeToken() };
  const relay = await startRelay({ host: "127.0.0.1", port: 0, token: tokens.shared, members: [{ name: "me", id: ME, token: tokens.me }, { name: "bob", id: BOB, token: tokens.bob }], realm: { id: REALM, name: "local" }, log: () => {} });
  t.after(() => relay.close());
  const url = `ws://127.0.0.1:${relay.port}`;
  const home = tmpHome(t);
  const env = { HOPTELL_RELAY: url, HOPTELL_TOKEN: tokens.me, HOPTELL_NAME: "me-agy", HOPTELL_HOME: home, HOPTELL_PUSH: "listener", HOPTELL_RECEIPTS: "on", HOPTELL_NOTIFY: "off" };
  const engine = createEngine(readSettings({ env, homedir: "/nonexistent-home", pid: process.pid, hostname: "testhost" }), { findHost: () => null, keepAlive: true });
  engine.attach({ notifyHeld: () => {} });
  t.after(() => engine.stop());
  engine.start();
  await until(() => engine.session.state === "bound", 4000, "bound");
  const stop = () => hookAgyStop({ home, env, relay: { relayUrl: url, protocol: 2, profile: null } });
  const send = async (token, name, text) => {
    const c = new RelayClient({ url, token, name, reconnect: false });
    c.on("message", (_m, confirm) => confirm());
    t.after(() => c.close());
    await c.start().ready();
    await c.send("me-agy", text);
  };

  assert.deepEqual(await stop(), ALLOW);
  // The own member's message reaches the inbox (contacts self-trust).
  await send(tokens.me, "me-claude", `review this ${CANARY}`);
  await until(async () => (await stop()).decision === "continue", 4000, "the inbox notice");
  assert.deepEqual(await stop(), ALLOW, "announced once");
  const read = textOf(await engine.call("read_inbox"));
  assert.match(read, new RegExp(CANARY));
  await engine.call("ack_messages", { receipt: read.match(/Receipt: (r_[a-z2-7]{26})/)[1] });
  assert.deepEqual(await stop(), ALLOW);
  // Another member's message is held by the contacts: the held notice, once.
  await send(tokens.bob, "bob-reviewer", `held ${CANARY}`);
  let held;
  await until(async () => (held = await stop()).decision === "continue", 4000, "the held notice");
  assert.deepEqual(held, { decision: "continue", reason: HELD_NOTICE });
  assert.deepEqual(await stop(), ALLOW);
  const state = fs.readFileSync(path.join(home, "wake", "agy-me-agy.stop.json"), "utf8");
  assert.ok(!state.includes(CANARY) && !state.includes("bob") && !state.includes(tokens.me), state);
});

test("hoptell hook-agy-stop never fails agy's turn; hoptell hooks --agy prints the hooks.json entry", (t) => {
  const home = tmpHome(t);
  fs.writeFileSync(path.join(home, "empty.env"), ""); // no settings file of the developer's
  const run = (args, input, env = {}) => spawnSync(process.execPath, [BIN, ...args], { input, encoding: "utf8", env: { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: path.join(home, "config"), HOPTELL_HOME: path.join(home, "h"), HOPTELL_ENV: path.join(home, "empty.env"), ...env } });
  const cases = [
    ["{}", {}],
    ["not json", { HOPTELL_NAME: "me-agy" }],
    ["{}", { HOPTELL_NAME: "me-agy", HOPTELL_PROTOCOL: "bogus" }],
    ["{}", { HOPTELL_NAME: "me-agy", HOPTELL_ENV: path.join(home, "missing.env") }],
    ["x".repeat(300 * 1024), { HOPTELL_NAME: "me-agy" }],
  ];
  for (const [input, env] of cases) {
    const r = run(["hook-agy-stop"], input, env);
    assert.deepEqual([r.status, r.stdout, r.stderr], [0, '{"decision":"allow"}\n', ""], JSON.stringify(env));
  }
  const r = run(["hooks", "--agy"], "");
  assert.equal(r.status, 0, r.stderr);
  const doc = JSON.parse(r.stdout);
  assert.deepEqual(Object.keys(doc), ["hoptell"]);
  assert.deepEqual(Object.keys(doc.hoptell), ["Stop"]);
  assert.equal(doc.hoptell.Stop[0].timeout, 10);
  assert.ok(doc.hoptell.Stop[0].command.endsWith(`'hook-agy-stop' '--home' '${path.join(home, "h")}'`), doc.hoptell.Stop[0].command);
  // Paths are quoted for the shell agy runs the command with.
  const odd = agyHooksSnippet("/opt/my node/node", "/home/o'brien/.hoptell").hoptell.Stop[0].command;
  assert.ok(odd.startsWith("'/opt/my node/node' '"), odd);
  assert.ok(odd.endsWith(`'hook-agy-stop' '--home' '/home/o'\\''brien/.hoptell'`), odd);
});
