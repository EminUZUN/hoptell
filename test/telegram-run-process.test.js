// `hoptell telegram run` as a process of its own (bin/hoptell.js awaits telegramCommand at the top
// level): a relay restart must not end it. While the relay is away nothing else holds the event
// loop (the relay client's reconnect timers are unreferenced, the poll ended with the claim), so
// Node used to exit with code 13 ("unsettled top-level await"). The bridge now waits and takes its
// claim again when the relay is back. Temporary homes and relays on 127.0.0.1 only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startRelay } from "../lib/relay.js";
import * as sig from "../lib/ownersig.js";
import { BOB, ME, REALM, tmpHome, until } from "./owner-helpers.js";
import { fakeToken } from "./helpers.js";

const CHILD = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "telegram-run-child.mjs");

test("telegram run: a relay restart does not end the bridge process; it waits, takes its claim again and stops cleanly (never exit 13)", async (t) => {
  const tokens = { me: fakeToken(), bob: fakeToken() };
  const relayOn = (port) => startRelay({ host: "127.0.0.1", port, members: [{ name: "me", id: ME, token: tokens.me }, { name: "bob", id: BOB, token: tokens.bob }], realm: { id: REALM, name: "local" }, log: () => {} });
  let relay = await relayOn(0);
  const port = relay.port;
  t.after(() => relay?.close());
  const home = tmpHome(t);
  const relays = path.join(home, "relays.json");
  fs.writeFileSync(relays, JSON.stringify({ version: 1, relays: [{ alias: "local", url: `ws://127.0.0.1:${port}`, tokenEnv: "ME_TOKEN", namePrefix: "me-" }] }), { mode: 0o600 });
  const env = { ...process.env, ME_TOKEN: tokens.me };
  for (const k of Object.keys(env)) if (k.startsWith("HOPTELL_")) delete env[k];
  const child = spawn(process.execPath, [CHILD, home, relays], { env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (d) => (output += d));
  child.stderr.on("data", (d) => (output += d));
  // "close": the process ended and its output pipes are drained.
  const exited = new Promise((resolve) => child.on("close", (code, signal) => resolve({ code, signal })));
  let exit = null;
  exited.then((e) => (exit = e));
  t.after(() => exit || child.kill("SIGKILL"));
  const run = () => {
    try {
      return JSON.parse(fs.readFileSync(path.join(sig.channelPaths(home).dir, "run.json"), "utf8"));
    } catch {
      return null;
    }
  };
  const state = async (want, what) => {
    await until(() => exit || run()?.state === want, 15_000, what);
    assert.equal(exit, null, `the bridge process exited (${JSON.stringify(exit)}) while waiting for ${what}:\n${output}`);
  };

  await state("leader", "the bridge's first claim");
  await relay.close();
  relay = null;
  await state("waiting", "the bridge to notice the relay is gone");
  // Longer than the client's first reconnect delays: the process stays while the relay is away.
  await new Promise((r) => setTimeout(r, 3000));
  assert.equal(exit, null, `the bridge process exited while the relay was away (${JSON.stringify(exit)}):\n${output}`);
  relay = await relayOn(port);
  await state("leader", "the bridge's claim after the relay restarted");
  child.kill("SIGTERM");
  // Bounded: a keep-alive left behind (or a stop that never settles) fails here instead of hanging.
  await until(() => exit, 15_000, "the bridge process to stop on SIGTERM").catch((err) => {
    throw new Error(`${err.message}\n${output}`);
  });
  const e = await exited;
  assert.deepEqual(e, { code: 0, signal: null }, output);
  assert.doesNotMatch(output, /unsettled top-level await/);
  assert.match(output, /Stopped\./);
});
