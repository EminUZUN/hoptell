#!/usr/bin/env node
// Opt-in compatibility test (npm run test:compat), driven without AI models. Needs network
// access to install the earlier release from npm, so it never runs in normal CI.
//
// It installs an earlier hoptell release into a temporary folder and runs every mix of that
// release and this checkout as the relay, the sender (alice) and the receiver (bob):
//   1. a plain message arrives with its text intact
//   2. message references and replies, where both sides support them
//   3. file reviews (send_file, verify_snapshot), where the sender has the file tools
//   4. a receiver from this checkout whose name was taken over reconnects once it is free
// Checks follow what each side supports, so any earlier release can be compared.
//
// Options: --version <x.y.z> (default: the newest npm release older than package.json)
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const opt = (f, d) => (args.includes(f) ? args[args.indexOf(f) + 1] : d);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const npm = (a) => execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", a, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

const current = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
const older = (a, b) => {
  const [x, y] = [a, b].map((v) => v.split(/[.-]/).slice(0, 3).map(Number));
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i];
  return false;
};
const earlier =
  opt("--version") ||
  JSON.parse(npm(["view", "hoptell", "versions", "--json"]))
    .filter((v) => /^\d+\.\d+\.\d+$/.test(v) && older(v, current))
    .sort((a, b) => (older(a, b) ? -1 : 1))
    .pop();
if (!earlier) throw new Error(`no npm release older than ${current}`);

const work = fs.mkdtempSync(path.join(os.tmpdir(), "hoptell-compat-"));
process.on("exit", () => fs.rmSync(work, { recursive: true, force: true }));
console.log(`installing hoptell@${earlier} from npm...`);
npm(["install", "--prefix", path.join(work, "earlier"), "--no-save", "--no-audit", "--no-fund", "--ignore-scripts", `hoptell@${earlier}`]);
const BIN = { [earlier]: path.join(work, "earlier/node_modules/hoptell/bin/hoptell.js"), this: path.join(ROOT, "bin/hoptell.js") };
const VERSIONS = [earlier, "this"];

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

const results = [];
async function run(relayV, aliceV, bobV) {
  const combo = `relay ${relayV} | alice ${aliceV} | bob ${bobV}`;
  const check = (what, ok, detail = "") => results.push({ combo, what, ok, detail });
  const dir = fs.mkdtempSync(path.join(work, "run-"));
  const empty = path.join(dir, "empty.env");
  fs.writeFileSync(empty, "");
  const token = crypto.randomBytes(24).toString("hex");
  const port = await freePort();
  const relay = spawn(process.execPath, [BIN[relayV], "relay", "--host", "127.0.0.1", "--port", String(port)], {
    env: { ...process.env, HOPTELL_ENV: empty, HOPTELL_TOKEN: token },
    stdio: "ignore",
  });
  for (let i = 0; i < 50; i++) {
    if (await fetch(`http://127.0.0.1:${port}/healthz`).then((r) => r.ok, () => false)) break;
    await sleep(100);
  }
  const clients = [];
  const peer = async (name, v, extra = {}) => {
    const c = new Client({ name: "compat", version: "0" });
    const env = { ...process.env, HOPTELL_ENV: empty, HOPTELL_RELAY: `ws://127.0.0.1:${port}`, HOPTELL_TOKEN: token, HOPTELL_NAME: name, HOPTELL_PUSH: "listener", HOPTELL_HOME: path.join(dir, name), ...extra };
    await c.connect(new StdioClientTransport({ command: process.execPath, args: [BIN[v], "mcp"], env, stderr: "ignore" }));
    clients.push(c);
    const tools = new Set((await c.listTools()).tools.map((t) => t.name));
    const call = async (t, a = {}) => (await c.callTool({ name: t, arguments: a })).content[0].text;
    for (let i = 0; i < 50 && !/You are/.test(await call("list_peers")); i++) await sleep(100);
    return { c, call, tools };
  };
  const read = async (p) => {
    let got = "";
    for (let i = 0; i < 50 && !/end of hoptell/.test(got); i++) {
      const r = await p.call("read_inbox");
      if (r !== "Inbox empty.") got += r;
      else await sleep(100);
    }
    return got;
  };
  try {
    const files = path.join(dir, "files");
    fs.mkdirSync(files);
    const fileBytes = Buffer.from("const x = 1;\r\n// ünï\n", "utf8");
    fs.writeFileSync(path.join(files, "x.js"), fileBytes);
    const alice = await peer("alice", aliceV, { HOPTELL_SNAPSHOT_ROOTS: JSON.stringify([{ id: "app", path: files }]) });
    const bob = await peer("bob", bobV, { HOPTELL_SNAPSHOT_ROOTS: "" });

    // 1. Plain message.
    const payload = "plain text: ünïcode \r\n line two";
    const ack = await alice.call("send_message", { to: "bob", message: payload });
    check("plain message acknowledged", /Delivered to bob/.test(ack), ack.slice(0, 160));
    const got = await read(bob);
    check("plain message text intact", got.includes(payload), JSON.stringify(got.slice(0, 160)));

    // 2. References and replies: a sender gets a reference or is told the relay has none.
    const ref = ack.match(/Message reference: ([0-9a-f-]{36})/)?.[1];
    if (aliceV === "this") check(ref ? "sender gets a reference" : "sender told the relay has no references", Boolean(ref) || /does not provide message references/.test(ack), ack.slice(0, 160));
    if (ref && bobV === "this") check("receiver shows the reference", got.includes(`Message reference: ${ref}`), got.slice(0, 200));
    const shownRef = got.match(/Message reference: ([0-9a-f-]{36})/)?.[1];
    const replyArgs = { to: "alice", message: "the answer", ...(shownRef ? { reply_to: shownRef } : {}) };
    const r = await bob.call("send_message", replyArgs);
    check("reply acknowledged", /Delivered to alice/.test(r), r.slice(0, 160));
    const back = await read(alice);
    check("reply text intact", back.includes("the answer"), back.slice(0, 160));
    if (shownRef && aliceV === "this" && /Message reference/.test(r)) check("sender sees which message was answered", back.includes(`In reply to: ${shownRef}`), back.slice(0, 200));

    // 3. File reviews.
    if (alice.tools.has("send_file")) {
      const sent = JSON.parse(await alice.call("send_file", { to: "bob", root_id: "app", path: "x.js", request: "please review" }));
      check("send_file accepted", sent.state === "accepted", JSON.stringify(sent).slice(0, 160));
      const review = await read(bob);
      let content = null;
      try {
        content = JSON.parse(review.slice(review.indexOf("{"), review.lastIndexOf("}") + 1)).content;
      } catch {}
      check("receiver gets the exact file bytes", typeof content === "string" && Buffer.from(content, "utf8").equals(fileBytes), review.slice(0, 200));
      if (alice.tools.has("verify_snapshot")) {
        const v = JSON.parse(await alice.call("verify_snapshot", { snapshot_id: sent.snapshot_id }));
        check("verify_snapshot: match", v.state === "match", JSON.stringify(v).slice(0, 160));
      }
    }

    // 4. Takeover: a short-lived copy of bob takes the name, then exits.
    if (bobV === "this") {
      const copy = await peer("bob", bobV);
      await copy.c.close();
      let online = false;
      for (let i = 0; i < 100 && !(online = /bob .*online/.test(await alice.call("list_peers"))); i++) await sleep(100);
      check("receiver reconnects after a short-lived copy took its name", online);
      if (online) {
        await alice.call("send_message", { to: "bob", message: "back again" });
        check("message reaches the reconnected receiver", (await read(bob)).includes("back again"));
      }
    }
  } catch (e) {
    check("ran without errors", false, e.message);
  } finally {
    for (const c of clients) await c.close().catch(() => {});
    relay.kill();
  }
}

for (const r of VERSIONS) for (const a of VERSIONS) for (const b of VERSIONS) await run(r, a, b);
let fail = 0;
for (const x of results) {
  if (!x.ok) fail++;
  console.log(`${x.ok ? "PASS" : "FAIL"}  ${x.combo}  ${x.what}${x.ok ? "" : `  -> ${x.detail}`}`);
}
console.log(`\nhoptell@${earlier} and this checkout (${current}): ${results.length - fail}/${results.length} checks passed`);
process.exitCode = fail ? 1 : 0;
