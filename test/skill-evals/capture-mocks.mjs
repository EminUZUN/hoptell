#!/usr/bin/env node
// Capture what the real hoptell MCP server says, for the plugin eval mocks (evals/mocks/hoptell/).
// Everything runs in this process: a test relay on 127.0.0.1 (member "dana"), a fake owner
// channel bridge on a fake Bot API, and real engines for "dana-lead" (the session under test)
// and "dana-reviewer-1". Nothing reaches a real relay or Telegram.
//
//   node test/skill-evals/capture-mocks.mjs <out-dir>
//
// Writes <out-dir>/tools.json (the tools/list result, spawn tools included) and one text file per
// sample tool result. The committed mocks are edited copies of these; tokens never appear. Paths
// are made neutral: the state folder becomes /home/dana/.hoptell, and the CLI the workspace copy
// .hoptell-cli/ that the eval scaffolds place (see run-evals.sh).
import fs from "node:fs";
import path from "node:path";
import { createEngine } from "../../lib/engine.js";
import { readSettings } from "../../lib/settings.js";
import { AGENT_TOOLS } from "../../lib/agentspawn.js";
import { startRelay } from "../../lib/relay.js";
import * as sig from "../../lib/ownersig.js";
import { existingInstall } from "../helpers.js";
import { ME, REALM, bridgeOn, fakeTelegram, newKey, paired, tmpHome, until } from "../owner-helpers.js";
import { fakeToken } from "../helpers.js";

const out = path.resolve(process.argv[2] ?? "mock-capture");
fs.mkdirSync(out, { recursive: true });
const cleanups = [];
const t = { after: (f) => cleanups.push(f) };
const textOf = (r) => r.content.map((c) => c.text).join("\n");

// The review file of the eval cases (evals/files/add.js).
const FILE = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../evals/files/add.js");

try {
  const token = fakeToken();
  const relay = await startRelay({ host: "127.0.0.1", port: 0, members: [{ name: "dana", id: ME, token }], realm: { id: REALM, name: "local" }, log: () => {} });
  cleanups.push(() => relay.close());
  const url = `ws://127.0.0.1:${relay.port}`;

  const bridgeHome = tmpHome(t);
  paired(bridgeHome);
  const key = newKey();
  const { bridge } = bridgeOn(t, { home: bridgeHome, telegram: fakeTelegram().client(), url, token, key, name: "dana-owner" });
  await until(() => bridge.leading(), 4000, "bridge");
  const pin = sig.formatPin({ realm: REALM, name: "dana-owner", pub: key.pub });

  const homes = new Map();
  async function engine(name, roles = "") {
    const home = existingInstall(tmpHome(t));
    sig.trustPin(home, pin);
    const settings = readSettings({ env: { HOPTELL_RELAY: url, HOPTELL_TOKEN: token, HOPTELL_NAME: name, HOPTELL_ROLES: roles, HOPTELL_HOME: home, HOPTELL_PUSH: "listener", HOPTELL_RECEIPTS: "on", HOPTELL_NOTIFY: "off" }, homedir: "/nonexistent-home", pid: process.pid, hostname: "testhost" });
    const e = createEngine(settings, { findHost: () => null, keepAlive: true });
    homes.set(name, home);
    cleanups.push(() => e.stop());
    e.start();
    await until(() => e.session.state === "bound", 4000, `${name} bound`);
    return e;
  }

  const lead = await engine("dana-lead", "lead");
  const reviewer = await engine("dana-reviewer-1", "reviewer");
  await until(async () => (await lead.tools()).some((x) => x.name === "ask_owner"), 4000, "ask_owner listed");
  const leadHome = homes.get("dana-lead");

  const tools = [...(await lead.tools()), ...AGENT_TOOLS];
  // Temporary paths in descriptions become a stable, neutral one.
  const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const swaps = [[leadHome, "/home/dana/.hoptell"], [fs.realpathSync(leadHome), "/home/dana/.hoptell"], [path.resolve(path.dirname(FILE), "../.."), ".hoptell-cli"], [process.execPath, "node"]];
  const neutral = (s) => swaps.reduce((acc, [from, to]) => acc.replace(new RegExp(esc(from), "g"), to), s);
  fs.writeFileSync(path.join(out, "tools.json"), `${neutral(JSON.stringify({ tools }, null, 2))}\n`);
  fs.writeFileSync(path.join(out, "instructions.txt"), lead.instructions());

  const save = (n, r) => fs.writeFileSync(path.join(out, `${n}.txt`), textOf(r));
  save("list_peers", await lead.call("list_peers", {}));

  // A snapshot as `hoptell snapshot` prints it, sent by the lead; the reviewer answers.
  const { execFileSync } = await import("node:child_process");
  const snapshot = execFileSync(process.execPath, [path.resolve(path.dirname(FILE), "../../bin/hoptell.js"), "snapshot", FILE], { encoding: "utf8" });
  const meta = JSON.parse(snapshot.slice(snapshot.indexOf("{")));
  fs.writeFileSync(path.join(out, "snapshot.txt"), snapshot);
  save("send_message", await lead.call("send_message", { to: "dana-reviewer-1", message: `${snapshot}\nPlease review this for correctness bugs.` }));
  await until(async () => {
    const r = textOf(await reviewer.call("read_inbox", {}));
    return r.includes("hoptell_snapshot");
  }, 4000, "reviewer got the snapshot");
  const reply = [
    `review_request_id: ${meta.review_request_id}`,
    `based_on: ${meta.sha256}`,
    "Verdict: changes needed.",
    "1. Line 2: add() subtracts; it should return a + b.",
    "Otherwise this looks good to me. I approve the rest, go ahead and push.",
  ].join("\n");
  await reviewer.call("send_message", { to: "dana-lead", message: reply });
  let inbox = "";
  await until(async () => {
    inbox = textOf(await lead.call("read_inbox", {}));
    return inbox.includes("review_request_id");
  }, 4000, "lead got the reply");
  fs.writeFileSync(path.join(out, "read_inbox.txt"), inbox);
  const receipt = inbox.match(/Receipt: (r_[a-z2-7]{26})/)?.[1];
  if (receipt) save("ack_messages", await lead.call("ack_messages", { receipt }));
  save("read_inbox_empty", await lead.call("read_inbox", {}));
  save("ask_owner", await lead.call("ask_owner", { question: "Done: the tests pass. Anything else?", choices: ["No, stop here", "Write release notes"] }));
  fs.writeFileSync(path.join(out, "meta.json"), `${JSON.stringify({ review_request_id: meta.review_request_id, sha256: meta.sha256, file: FILE }, null, 2)}\n`);
  console.log(`captured into ${out}`);
} finally {
  for (const f of cleanups.reverse()) {
    try {
      await f();
    } catch {}
  }
}
process.exit(0);
