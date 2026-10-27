// Session titles, phase 2 (design "readable session names"): set_title with its ownership check
// and budgets, Claude Code's session_title from the SessionStart and UserPromptSubmit hooks
// through the title file, HOPTELL_TITLE_AUTO, the HTTP binding, and a relay without set_title.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { spawn } from "node:child_process";
import WebSocket, { WebSocketServer } from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startRelay } from "../lib/relay.js";
import { RelayClient } from "../lib/client.js";
import { ClaimTable } from "../lib/claims.js";
import { BIN, autoClientTitle, envTitleAuto } from "../lib/config.js";
import { readSettings, settingsProblem } from "../lib/settings.js";
import { currentBoot, hostKey, processInfo } from "../lib/host.js";
import { ensureWakeDir, filesFor, hookTitleWanted, hostOfRegistration, readSessionTitle, writeRecord } from "../lib/wake.js";
import { addClient, startMcpHttp } from "../lib/httpmcp.js";
import { httpSessions, serveEngine } from "../lib/mcp.js";
import { TOKEN, fakeToken, sleep, world } from "./helpers.js";

const supported = process.platform === "darwin" || process.platform === "linux";

/** A raw connection that records frames. */
function connect(url, hello) {
  const ws = new WebSocket(url);
  const frames = [];
  const waiters = [];
  ws.on("message", (d) => {
    const f = JSON.parse(d);
    frames.push(f);
    for (const w of [...waiters]) if (w.match(f)) waiters.splice(waiters.indexOf(w), 1) && w.resolve(f);
  });
  const closed = new Promise((r) => ws.on("close", (code) => r(code)));
  ws.on("error", () => {});
  ws.on("open", () => ws.send(JSON.stringify(hello)));
  const next = (match, ms = 3000) => {
    const seen = frames.find(match);
    if (seen) return Promise.resolve(seen);
    return new Promise((resolve, reject) => {
      waiters.push({ match, resolve });
      setTimeout(() => reject(new Error(`no frame; got ${JSON.stringify(frames.map((x) => x.type))}`)), ms);
    });
  };
  let n = 0;
  const rpc = (o, ms) => {
    const id = `r${++n}`;
    ws.send(JSON.stringify({ ...o, id }));
    return next((f) => f.id === id, ms);
  };
  return { ws, frames, closed, next, rpc, send: (o) => ws.send(JSON.stringify(o)) };
}

async function setup(t) {
  const tokens = { alice: fakeToken(), bob: fakeToken(), shared: fakeToken() };
  const members = [{ name: "alice", id: "m_aaaaaaaaaaaaaaaaaaaaaaaaaa", token: tokens.alice }, { name: "bob", token: tokens.bob }];
  const relay = await startRelay({ host: "127.0.0.1", port: 0, token: tokens.shared, members, log: () => {} });
  t.after(() => relay.close());
  const url = `ws://127.0.0.1:${relay.port}`;
  const conns = [];
  t.after(() => conns.forEach((c) => c.ws.terminate()));
  const peer = async (name, token, claim = { action: "acquire" }, extra = {}) => {
    const c = connect(url, { type: "hello", v: 2, name, token, host: "pc", mode: "peer", claim, ...extra });
    conns.push(c);
    c.welcome = await c.next((f) => f.type === "welcome" || f.type === "hello_error");
    return c;
  };
  const sender = async (token, name) => {
    const c = connect(url, { type: "hello", v: 2, name, token, host: "pc", mode: "send" });
    conns.push(c);
    await c.next((f) => f.type === "welcome");
    return c;
  };
  const viewer = await sender(tokens.bob, "bob-view");
  const titleOf = async (name) => (await viewer.rpc({ type: "list" })).peers.find((p) => p.name === name)?.title;
  return { relay, url, tokens, members, peer, sender, viewer, titleOf };
}

// ---- set_title at the relay -------------------------------------------------------------------

test("set_title: the holder sets, changes and clears its title; refusals change nothing", async (t) => {
  const { tokens, peer, titleOf } = await setup(t);
  const a = await peer("alice-a", tokens.alice, undefined, { title: "first" });
  assert.ok(a.welcome.caps.includes("set_title") && a.welcome.caps.includes("title"));
  assert.deepEqual(await a.rpc({ type: "set_title", title: " second‮​ " }), { type: "title_ok", id: "r1", title: "second" });
  assert.equal(await titleOf("alice-a"), "second");
  // Unusable values are refused and change nothing.
  for (const title of ["x".repeat(1025), 42, { a: 1 }, undefined]) {
    const r = await a.rpc({ type: "set_title", title });
    assert.equal(r.type, "error");
    assert.equal(r.code, "bad_request");
    assert.equal(await titleOf("alice-a"), "second");
  }
  // Nothing left after cleaning, or null: no title.
  assert.equal((await a.rpc({ type: "set_title", title: "​" })).title, null);
  assert.equal(await titleOf("alice-a"), undefined);
  await a.rpc({ type: "set_title", title: "third" });
  assert.equal((await a.rpc({ type: "set_title", title: null })).type, "title_ok");
  assert.equal(await titleOf("alice-a"), undefined);
  // The connection stays usable after refusals: it still lists.
  assert.equal((await a.rpc({ type: "list" })).type, "peers");
});

test("set_title ownership: send-only, fenced, reserved and revoked connections change nothing; titles stay with the claim", async (t) => {
  const { relay, tokens, members, peer, sender, titleOf } = await setup(t);
  const a = await peer("alice-o", tokens.alice, undefined, { title: "owner" });
  // A send-only connection of the same member, under the same name: refused.
  const s = await sender(tokens.alice, "alice-o");
  const r = await s.rpc({ type: "set_title", title: "from cli" });
  assert.equal(r.code, "not_allowed");
  assert.equal(await titleOf("alice-o"), "owner");
  // A resume elsewhere fences the old socket: its set_title is ignored. The resume keeps the title.
  const b = await peer("alice-o", tokens.alice, { action: "resume", ...a.welcome.claim, attempt: "x1" });
  assert.equal(b.welcome.type, "welcome");
  assert.equal(await titleOf("alice-o"), "owner", "a resume keeps the title");
  a.send({ type: "set_title", id: "late", title: "fenced" });
  await sleep(200);
  assert.equal(a.frames.some((f) => f.id === "late" && f.type === "title_ok"), false);
  assert.equal(await titleOf("alice-o"), "owner");
  // A title set with set_title also survives a resume, and a new claim never inherits it.
  await b.rpc({ type: "set_title", title: "live" });
  const c = await peer("alice-o", tokens.alice, { action: "resume", ...b.welcome.claim, attempt: "x2" });
  assert.equal(await titleOf("alice-o"), "live");
  const d = await peer("alice-o", tokens.alice, { action: "replace" });
  assert.equal(d.welcome.type, "welcome");
  assert.equal(await titleOf("alice-o"), undefined, "the same member's new claim starts without it");
  void c;
  // A reserved claim: no socket holds it, so the table refuses any update.
  const ct = new ClaimTable();
  const sock = { label: "x" };
  ct.hello({ name: "n", socket: sock, principal: { kind: "shared" }, version: 2, claim: { action: "acquire" }, title: "t" });
  ct.closed("n", sock);
  assert.equal(ct.setTitle("n", sock, "changed"), false);
  assert.equal(ct.titleOf("n"), "t");
  assert.equal(ct.setTitle("n", { label: "other" }, "changed"), false);
  // A revoked credential: its frames are ignored, and its claim (with its title) ends.
  const e = await peer("bob-r", tokens.bob, undefined, { title: "bob's" });
  const view2 = await sender(tokens.alice, "alice-view");
  const aliceSees = async () => (await view2.rpc({ type: "list" })).peers.find((p) => p.name === "bob-r");
  assert.equal((await aliceSees()).title, "bob's");
  await relay.reload(members.filter((m) => m.name !== "bob"));
  e.send({ type: "set_title", id: "revoked", title: "after revocation" });
  await sleep(200);
  assert.equal(e.frames.some((f) => f.id === "revoked" && f.type === "title_ok"), false);
  assert.equal((await aliceSees())?.title, undefined);
});

test("set_title budgets: 10 a minute per claim, 60 per member, one shared bucket; deliveries in flight complete", async (t) => {
  const { tokens, peer, sender, titleOf } = await setup(t);
  // A delivery to alice-b waits for its receipt while alice-b spends its title budget.
  const tx = await sender(tokens.bob, "bob-tx");
  const rx = await peer("alice-b", tokens.alice);
  const pending = tx.rpc({ type: "send", to: "alice-b", text: "in flight" }, 8000);
  const msg = await rx.next((f) => f.type === "message");
  for (let i = 1; i <= 10; i++) assert.equal((await rx.rpc({ type: "set_title", title: `t${i}` })).type, "title_ok", `update ${i}`);
  const over = await rx.rpc({ type: "set_title", title: "eleven" });
  assert.equal(over.code, "title_rate");
  assert.equal(await titleOf("alice-b"), "t10", "a refused update changes nothing");
  rx.send({ type: "got", id: msg.id });
  const ack = await pending;
  assert.equal(ack.type, "ack");
  assert.equal(ack.state, "delivered", "the delivery completes and is acknowledged normally");
  // Messages still flow to and from the session.
  assert.equal((await rx.rpc({ type: "send", to: "bob-tx", text: "x" })).type, "error", "bob-tx is send-only: unknown peer, as before");
  assert.equal((await rx.rpc({ type: "list" })).type, "peers");
  // Per member: alice's other claims share 60 a minute (10 already spent).
  let spent = 10;
  for (let k = 0; spent < 60; k++) {
    const c = await peer(`alice-k${k}`, tokens.alice);
    for (let i = 0; i < 10 && spent < 60; i++, spent++) assert.equal((await c.rpc({ type: "set_title", title: `k${k}-${i}` })).type, "title_ok");
  }
  const fresh = await peer("alice-z", tokens.alice);
  assert.equal((await fresh.rpc({ type: "set_title", title: "z" })).code, "title_rate", "the member's 61st update in the minute");
  // Another member has its own budget.
  const bob = await peer("bob-1", tokens.bob);
  assert.equal((await bob.rpc({ type: "set_title", title: "bob" })).type, "title_ok");
  // Shared-token clients share one bucket.
  let shared = 0;
  for (let k = 0; shared < 60; k++) {
    const c = await peer(`s-${k}`, tokens.shared);
    for (let i = 0; i < 10 && shared < 60; i++, shared++) assert.equal((await c.rpc({ type: "set_title", title: `s${i}` })).type, "title_ok");
  }
  const other = await peer("s-other", tokens.shared);
  assert.equal((await other.rpc({ type: "set_title", title: "x" })).code, "title_rate");
});

// ---- a relay that advertises title but not set_title --------------------------------------------

/** A proxy in front of `url` that hides set_title in the welcome and records client frame types. */
async function phase1Proxy(t, url) {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise((r) => wss.once("listening", r));
  const sent = [];
  wss.on("connection", (down) => {
    const up = new WebSocket(url);
    const early = [];
    up.on("open", () => early.splice(0).forEach((d) => up.send(d)));
    down.on("message", (raw) => {
      const d = raw.toString(); // text frames, as the client sent them
      try {
        sent.push(JSON.parse(d).type);
      } catch {}
      up.readyState === WebSocket.OPEN ? up.send(d) : early.push(d);
    });
    up.on("message", (d) => {
      const f = JSON.parse(d);
      if (f.type === "welcome" && Array.isArray(f.caps)) f.caps = f.caps.filter((c) => c !== "set_title");
      down.send(JSON.stringify(f));
    });
    up.on("close", (code, reason) => down.close(code >= 4000 ? code : 1000, reason));
    down.on("close", () => up.close());
    up.on("error", () => {});
    down.on("error", () => {});
  });
  t.after(() => {
    for (const c of wss.clients) c.terminate();
    wss.close();
  });
  return { url: `ws://127.0.0.1:${wss.address().port}`, sent };
}

test("a phase-2 client on a relay with title but not set_title: the hello title works, no set_title is sent, messages and receipts work", async (t) => {
  const w = await world();
  t.after(() => w.close());
  const proxy = await phase1Proxy(t, w.env.HOPTELL_RELAY);
  let title = "initial";
  const c = new RelayClient({ url: proxy.url, token: TOKEN, name: "p2", reconnect: false, title: () => title });
  const got = [];
  c.on("message", (m, confirm) => (got.push(m), confirm()));
  await c.start().ready(5000);
  t.after(() => c.close());
  assert.ok(c.caps.includes("title") && !c.caps.includes("set_title"));
  const viewer = new RelayClient({ url: w.env.HOPTELL_RELAY, token: TOKEN, name: "viewer", mode: "send", reconnect: false });
  await viewer.start().ready(5000);
  t.after(() => viewer.close());
  assert.equal((await viewer.list()).find((p) => p.name === "p2").title, "initial");
  title = "changed";
  assert.equal(await c.setTitle(title), false, "nothing is sent without the capability");
  assert.equal((await viewer.list()).find((p) => p.name === "p2").title, "initial");
  assert.equal((await viewer.send("p2", "hello p2")).state, "delivered", "the receipt came back");
  assert.equal(got[0].text, "hello p2");
  assert.equal((await c.send("viewer", "x").catch((e) => e)).message !== undefined, true);
  // An MCP session behind the same proxy: list_peers and messages work; no set_title either.
  const m = await w.mcp("p2-mcp", { HOPTELL_RELAY: proxy.url, HOPTELL_TITLE: "mcp title" });
  assert.match(await m.call("list_peers"), /You are "p2-mcp"/);
  assert.equal((await viewer.list()).find((p) => p.name === "p2-mcp").title, "mcp title");
  await viewer.send("p2-mcp", "to the mcp");
  let inbox = "";
  for (let i = 0; i < 50 && !/to the mcp/.test(inbox); i++, await sleep(100)) inbox = await m.call("read_inbox");
  assert.match(inbox, /to the mcp/);
  assert.equal(proxy.sent.includes("set_title"), false);
});

// ---- Claude Code hooks ----------------------------------------------------------------------

/** A stand-in Claude Code process ("claude" link to node) with the world's settings and `env`. */
async function fakeClaude(w, t, env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hoptell-host-"));
  const exe = path.join(dir, "claude");
  fs.symlinkSync(process.execPath, exe);
  const p = spawn(exe, [new URL("./fixtures/fake-claude.mjs", import.meta.url).pathname, BIN], { env: { ...w.env, HOPTELL_PUSH: "listener", ...env }, stdio: ["pipe", "pipe", "inherit"] });
  const events = [];
  const waiters = [];
  readline.createInterface({ input: p.stdout }).on("line", (l) => {
    const ev = JSON.parse(l);
    events.push(ev);
    for (const wt of [...waiters]) if (wt.match(ev)) waiters.splice(waiters.indexOf(wt), 1) && wt.resolve(ev);
  });
  const exited = new Promise((r) => p.once("exit", r));
  const stop = async () => {
    if (p.exitCode === null && p.signalCode === null) p.kill();
    await exited;
    fs.rmSync(dir, { recursive: true, force: true });
  };
  w.onClose(stop);
  t.after(stop);
  let ids = 100;
  const host = {
    pid: null,
    events,
    send: (c) => p.stdin.write(`${JSON.stringify(c)}\n`),
    next(match, ms = 15000, from = 0) {
      const seen = events.slice(from).find(match);
      if (seen) return Promise.resolve(seen);
      return new Promise((resolve, reject) => {
        waiters.push({ match, resolve });
        setTimeout(() => reject(new Error(`timed out; events: ${JSON.stringify(events.map((e) => e.ev))}`)), ms);
      });
    },
    async sessionStart(extra = {}) {
      const from = events.length;
      host.send({ op: "session-start", ...extra });
      return host.next((e) => e.ev === "session-start", 15000, from);
    },
    async prompt(input, extra = {}) {
      const from = events.length;
      host.send({ op: "hook", cmd: "hook-user-prompt-submit", input: { hook_event_name: "UserPromptSubmit", ...input }, ...extra });
      return host.next((e) => e.ev === "hook", 15000, from);
    },
    async startMcp(name, extra = {}) {
      const from = events.length;
      host.send({ op: "mcp-start", env: { HOPTELL_NAME: name, ...extra } });
      return host.next((e) => e.ev === "mcp-ready", 20000, from);
    },
    async call(tool, args = {}) {
      const id = ++ids;
      const from = events.length;
      host.send({ op: "mcp-call", id, tool, args });
      return (await host.next((e) => e.ev === "mcp-result" && e.id === id, 15000, from)).result.content[0].text;
    },
  };
  host.pid = (await host.next((e) => e.ev === "ready")).pid;
  return host;
}

const wakeFiles = (w) => (fs.existsSync(path.join(w.home, "wake")) ? fs.readdirSync(path.join(w.home, "wake")) : []);
const titleFiles = (w) => wakeFiles(w).filter((n) => n.endsWith(".title.json")).map((n) => JSON.parse(fs.readFileSync(path.join(w.home, "wake", n), "utf8")));
/** Everything hoptell wrote under the home, as text (to look for a canary). */
function allText(dir) {
  let out = "";
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out += allText(p);
    else if (e.isFile()) out += fs.readFileSync(p, "latin1");
  }
  return out;
}

test("Claude hooks: SessionStart for every source and UserPromptSubmit keep session_title in the title file; the session shows it only with HOPTELL_TITLE_AUTO", { skip: !supported }, async (t) => {
  const w = await world();
  t.after(() => w.close());
  const host = await fakeClaude(w, t, { HOPTELL_TITLE_AUTO: "on" });
  const viewer = await w.mcp("viewer");
  const shown = async () => {
    for (let i = 0; ; i++) {
      const r = (await viewer.call("list_peers")).split("\n").find((l) => l.startsWith("- cc "));
      if (r || i >= 50) return r;
      await sleep(100);
    }
  };
  for (const source of ["startup", "resume", "clear", "compact", "fork"]) {
    const ss = await host.sessionStart({ session_id: `conv-${source}`, source, input: { session_title: `named ${source}` } });
    assert.equal(ss.code, 0);
    assert.equal(ss.stderr, "");
    const out = JSON.parse(ss.stdout);
    assert.deepEqual(Object.keys(out.hookSpecificOutput).sort(), ["hookEventName", "watchPaths"], "sessionTitle is never returned");
    assert.deepEqual(titleFiles(w).map((f) => [f.session_id, f.title]), [[`conv-${source}`, `named ${source}`]], source);
  }
  const f = wakeFiles(w).find((n) => n.endsWith(".title.json"));
  assert.equal(fs.statSync(path.join(w.home, "wake", f)).mode & 0o777, 0o600);
  await host.startMcp("cc", { HOPTELL_TITLE_AUTO: "on" });
  assert.match(await shown(), /^- cc \(reported host: [^)]+\) title: "named fork" online$/);
  // A later /rename arrives with the next prompt; the canary prompt is never kept or shown.
  const CANARY = `canary-${crypto.randomBytes(6).toString("hex")}`;
  const up = await host.prompt({ session_id: "conv-fork", prompt: CANARY, session_title: "renamed‮ later" });
  assert.deepEqual([up.code, up.stdout, up.stderr], [0, "", ""], "prints nothing: no context, no sessionTitle");
  assert.equal(titleFiles(w)[0].title, "renamed later");
  const mine = await host.call("list_peers"); // reads the title file and updates the relay
  assert.match(await shown(), /title: "renamed later" online$/);
  // Without session_title (no custom title): the client and folder instead.
  const none = await host.prompt({ session_id: "conv-fork", prompt: CANARY });
  assert.equal(none.stdout, "");
  assert.equal(titleFiles(w)[0].title, null);
  await host.call("list_peers");
  assert.match(await shown(), /^- cc \(reported host: [^)]+\) title: "[^"]+ · [^"]+" online$/);
  // Through a shell: Claude Code is an ancestor, not the parent.
  const viaShell = await host.prompt({ session_id: "conv-fork", prompt: CANARY, session_title: "via shell" }, { viaShell: true });
  assert.equal(viaShell.code, 0);
  assert.equal(titleFiles(w)[0].title, "via shell");
  // Another session id than the registration's: ignored.
  await host.prompt({ session_id: "conv-other", prompt: CANARY, session_title: "intruder" });
  assert.equal(titleFiles(w)[0].title, "via shell");
  // A title file naming another session than the registration: the MCP uses none.
  const tf = path.join(w.home, "wake", f);
  writeRecord(tf, { session_id: "conv-other", title: "stale", at: Date.now() });
  await host.call("list_peers");
  assert.match(await shown(), /^- cc \(reported host: [^)]+\) title: "[^"]+ · [^"]+" online$/);
  assert.doesNotMatch(await shown(), /stale/);
  // The canary is nowhere: not in any file under the home, nor in any output.
  assert.ok(!allText(w.home).includes(CANARY), "no file holds the prompt");
  assert.ok(!JSON.stringify(host.events).includes(CANARY), "no hook or MCP output shows it");
  assert.ok(!mine.includes(CANARY) && !(await viewer.call("list_peers")).includes(CANARY));
});

test("Claude hooks privacy defaults: unset HOPTELL_TITLE_AUTO keeps a local copy but a shared-token session sends nothing; off keeps and sends nothing; an explicit title wins", { skip: !supported }, async (t) => {
  const w = await world();
  t.after(() => w.close());
  assert.equal(hookTitleWanted({}), true, "unset: kept, because a member session may send it");
  assert.equal(hookTitleWanted({ HOPTELL_TITLE_AUTO: "off" }), false);
  assert.equal(hookTitleWanted({ HOPTELL_TITLE_AUTO: "on" }), true);
  assert.equal(hookTitleWanted({ HOPTELL_TITLE_AUTO: "on", HOPTELL_TITLE: "mine" }), false);
  assert.equal(hookTitleWanted({ HOPTELL_TITLE_AUTO: "on", HOPTELL_TITLE: "off" }), false);
  assert.equal(hookTitleWanted({ HOPTELL_TITLE_AUTO: "maybe" }), false);
  const bad = readSettings({ env: { HOPTELL_TITLE_AUTO: "maybe" }, homedir: "/h", pid: 1 });
  assert.equal(bad.titleAuto, "off");
  assert.match(bad.errors.titleAuto, /HOPTELL_TITLE_AUTO must be on or off/);
  assert.match(settingsProblem(bad), /HOPTELL_TITLE_AUTO/, "refused at start, like the other on/off switches");
  const viewer = await w.mcp("viewer");
  const row = async (n) => {
    for (let i = 0; ; i++) {
      const r = (await viewer.call("list_peers")).split("\n").find((l) => l.startsWith(`- ${n} `));
      if (r || i >= 50) return r;
      await sleep(100);
    }
  };
  // Default with the shared token: the local copy exists, but no title is sent (the relay names
  // no member, so other holders of the token never see it).
  const host = await fakeClaude(w, t);
  await host.sessionStart({ session_id: "c1", input: { session_title: "secret plan" } });
  assert.equal(titleFiles(w).length, 1, "kept locally when unset");
  await host.prompt({ session_id: "c1", prompt: "p", session_title: "secret plan" });
  await host.startMcp("d1");
  await host.call("list_peers");
  assert.match(await row("d1"), /^- d1 \(reported host: [^)]+\) online$/);
  // The hooks wrote a title (HOPTELL_TITLE_AUTO in their environment), the session has it off.
  const host2 = await fakeClaude(w, t, { HOPTELL_TITLE_AUTO: "on" });
  await host2.sessionStart({ session_id: "c2", input: { session_title: "secret plan" } });
  assert.equal(titleFiles(w).length, 2, "one copy per Claude Code process");
  await host2.startMcp("d2", { HOPTELL_TITLE_AUTO: "off" });
  await host2.call("list_peers");
  assert.match(await row("d2"), /^- d2 \(reported host: [^)]+\) online$/);
  host2.send({ op: "mcp-stop" });
  await host2.next((e) => e.ev === "mcp-closed");
  // HOPTELL_TITLE=off: nothing at all.
  await host2.startMcp("d3", { HOPTELL_TITLE_AUTO: "on", HOPTELL_TITLE: "off" });
  await host2.call("list_peers");
  assert.match(await row("d3"), /^- d3 \(reported host: [^)]+\) online$/);
  host2.send({ op: "mcp-stop" });
  await host2.next((e) => e.ev === "mcp-closed" && host2.events.filter((x) => x.ev === "mcp-closed").length === 2);
  // An explicit HOPTELL_TITLE wins over the hook's title.
  await host2.startMcp("d4", { HOPTELL_TITLE_AUTO: "on", HOPTELL_TITLE: "explicit" });
  await host2.call("list_peers");
  assert.match(await row("d4"), /title: "explicit" online$/);
  // A SessionStart whose hooks no longer keep titles removes the old copy.
  await host2.sessionStart({ session_id: "c3", env: { HOPTELL_TITLE_AUTO: "off" }, input: { session_title: "x" } });
  assert.deepEqual(titleFiles(w).map((f) => f.session_id), ["c1"], "only the other process's copy is left");
});

test("title record bound to its registration: a replacement between the two reads (same session id, new epoch) lends no title", { skip: !supported }, (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "hoptell-titlerace-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const me = processInfo(process.pid);
  const host = { pid: process.pid, start: me.start, uid: me.uid, boot: currentBoot() };
  const dir = ensureWakeDir(home); // readSessionTitle needs the private wake folder
  const f = filesFor(dir, hostKey(host));
  const reg = (epoch, httpReg) => ({ v: 1, key: hostKey(host), host, session_id: "conv-r", epoch, http_reg: httpReg, at: Date.now() });
  const title = (epoch, httpReg, extra = {}) => ({ v: 1, session_id: "conv-r", http_reg: httpReg, epoch, title: `gen ${epoch}`, at: Date.now(), ...extra });
  /** A read double: the registration first read is `first`; the title read sees `then`. */
  const reads = (first, then) => (file) => (file === f.reg ? first : file === f.title ? then : null);
  const A = "a".repeat(32);
  const B = "b".repeat(32);
  // Matching generation: the title is used.
  assert.equal(readSessionTitle(home, host, { read: reads(reg("e1", A), title("e1", A)) }), "gen e1");
  // Interleaving: the registration read is generation e1, and before the title read a new
  // SessionStart (same session id) replaced both files with generation e2.
  assert.equal(readSessionTitle(home, host, { read: reads(reg("e1", A), title("e2", B)) }), null, "the newer generation's title is not paired with the older registration");
  assert.equal(readSessionTitle(home, host, { read: reads(reg("e2", B), title("e1", A)) }), null, "nor an older title with a newer registration");
  assert.equal(readSessionTitle(home, host, { read: reads(reg("e1", A), title("e1", B)) }), null, "another http_reg");
  // A record missing any binding field gives none.
  for (const k of ["session_id", "http_reg", "epoch"]) {
    const rec = title("e1", A);
    delete rec[k];
    assert.equal(readSessionTitle(home, host, { read: reads(reg("e1", A), rec) }), null, `no ${k}`);
  }
  const noEpoch = reg("e1", A);
  delete noEpoch.epoch;
  assert.equal(readSessionTitle(home, host, { read: reads(noEpoch, title(undefined, A)) }), null, "a registration without an epoch");
  // HTTP: the bound registration must also match.
  assert.equal(readSessionTitle(home, { ...host, registration: { id: A, epoch: "e1" } }, { read: reads(reg("e1", A), title("e1", A)) }), "gen e1");
  assert.equal(readSessionTitle(home, { ...host, registration: { id: A, epoch: "e1" } }, { read: reads(reg("e2", A), title("e2", A)) }), null);
});

// ---- HTTP sessions ----------------------------------------------------------------------------

test("HTTP: a title follows only the exact registration its session was bound to", { skip: !supported }, async (t) => {
  const w = await world();
  t.after(() => w.close());
  const me = processInfo(process.pid);
  const h0 = { pid: process.pid, start: me.start, uid: me.uid, boot: currentBoot() };
  const dir = ensureWakeDir(w.home);
  const key = hostKey(h0);
  const f = filesFor(dir, key);
  const reg = (epoch, httpReg) => writeRecord(f.reg, { key, host: h0, session_id: "conv-h", epoch, http_reg: httpReg, at: Date.now() });
  const id = crypto.randomBytes(16).toString("hex");
  reg("e1", id);
  writeRecord(f.title, { session_id: "conv-h", http_reg: id, epoch: "e1", title: "http title", at: Date.now() });
  // The registration-bound lookup, directly.
  const bound = hostOfRegistration(w.home, id);
  assert.deepEqual(bound.registration, { id, epoch: "e1" });
  assert.equal(readSessionTitle(w.home, bound), "http title");
  assert.equal(readSessionTitle(w.home, null), null, "no registration: no title");
  assert.equal(readSessionTitle(w.home, { ...bound, registration: { id, epoch: "e0" } }), null, "another generation");
  assert.equal(readSessionTitle(w.home, { ...bound, registration: { id: "0".repeat(32), epoch: "e1" } }), null, "another registration");

  // Through hoptell mcp-http, with HOPTELL_TITLE_AUTO on and a server HOPTELL_TITLE that no session uses.
  const sessions = httpSessions({ env: { ...w.env, HOPTELL_TITLE_AUTO: "on", HOPTELL_TITLE: "server title" }, homedir: w.home, cwd: w.home, pid: process.pid, hostname: "testhost" });
  const h = await startMcpHttp({ home: w.home, port: 0, engineFor: sessions, serve: (e, tr, o) => serveEngine(e, tr, { front: "http", ...o }), hostOf: (x) => hostOfRegistration(w.home, x) });
  t.after(() => h.close());
  const base = `http://127.0.0.1:${h.port}/mcp`;
  const open = async (name, headers = {}) => {
    const c = await addClient(w.home, name, { name });
    const client = new Client({ name: "test", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(base), { requestInit: { headers: { authorization: `Bearer ${c.token}`, ...headers } } }));
    t.after(() => client.close().catch(() => {}));
    const call = async (tool) => (await client.callTool({ name: tool, arguments: {} })).content[0].text;
    for (let i = 0; i < 50 && !/You are/.test(await call("list_peers")); i++) await sleep(100);
    return { call };
  };
  const first = await open("h-first", { "x-hoptell-hook-registration": id });
  await open("h-second", { "x-hoptell-hook-registration": id }); // in use by another session
  await open("h-none");
  assert.deepEqual(h.sessions().map((s) => s.hook), ["registered", "in use by another session", "none"]);
  const viewer = new RelayClient({ url: w.env.HOPTELL_RELAY, token: TOKEN, name: "viewer", mode: "send", reconnect: false });
  await viewer.start().ready(5000);
  t.after(() => viewer.close());
  const titles = async () => Object.fromEntries((await viewer.list()).filter((p) => p.name.startsWith("h-")).map((p) => [p.name, p.title ?? null]));
  await first.call("list_peers");
  assert.deepEqual(await titles(), { "h-first": "http title", "h-second": null, "h-none": null });
  // A new SessionStart for the same process (a new generation): the bound session gets none.
  reg("e2", crypto.randomBytes(16).toString("hex"));
  await first.call("list_peers");
  assert.deepEqual(await titles(), { "h-first": null, "h-second": null, "h-none": null });
});

// ---- automatic titles (0.3.2) ---------------------------------------------------------------

test("automatic title: the client word and the folder's last part; the home folder is \"~\"; either part alone", () => {
  assert.equal(autoClientTitle("claude-code", "/work/hoptell", "/home/u"), "Claude · hoptell");
  assert.equal(autoClientTitle("codex-mcp-client", "/work/hoptell/", "/home/u"), "Codex · hoptell");
  assert.equal(autoClientTitle("antigravity-cli", "/work/x", "/home/u"), "agy · x");
  assert.equal(autoClientTitle("agy", "/work/x", "/home/u"), "agy · x");
  assert.equal(autoClientTitle("Gemini CLI", "/work/x", "/home/u"), "Gemini · x");
  assert.equal(autoClientTitle("claude-code", "/home/u", "/home/u"), "Claude · ~", "the account name is not shown");
  assert.equal(autoClientTitle("some-editor‮", "/w/p", "/home/u"), "some-editor · p", "an unknown client is cleaned and kept short");
  assert.equal(autoClientTitle(null, "/w/p", "/home/u"), "p");
  assert.equal(autoClientTitle("claude-code", null, "/home/u"), "Claude");
  assert.equal(autoClientTitle(null, null), null);
  assert.equal(envTitleAuto({}), "member");
  assert.equal(envTitleAuto({ HOPTELL_TITLE_AUTO: " " }), "member");
  assert.equal(envTitleAuto({ HOPTELL_TITLE_AUTO: "yes" }), "on");
  assert.equal(envTitleAuto({ HOPTELL_TITLE_AUTO: "0" }), "off");
  assert.throws(() => envTitleAuto({ HOPTELL_TITLE_AUTO: "maybe" }), /HOPTELL_TITLE_AUTO must be on or off/);
});

test("automatic title by default for a member-token session (client and folder), none with HOPTELL_TITLE_AUTO=off; a shared-token session sends none", async (t) => {
  const w = await world();
  t.after(() => w.close());
  const alice = fakeToken();
  const relay = await startRelay({ host: "127.0.0.1", port: 0, token: TOKEN, members: [{ name: "alice", id: "m_aaaaaaaaaaaaaaaaaaaaaaaaaa", token: alice }], log: () => {} });
  t.after(() => relay.close());
  const url = `ws://127.0.0.1:${relay.port}`;
  const viewer = await w.mcp("alice-viewer", { HOPTELL_RELAY: url, HOPTELL_TOKEN: alice });
  const row = async (n, want) => {
    let r;
    for (let i = 0; i < 50; i++) {
      r = (await viewer.call("list_peers")).split("\n").find((l) => l.startsWith(`- ${n} `));
      if (r && want(r)) return r;
      await sleep(100);
    }
    return r;
  };
  const folder = path.basename(process.cwd());
  await w.mcp("alice-a", { HOPTELL_RELAY: url, HOPTELL_TOKEN: alice });
  assert.match(await row("alice-a", (r) => r.includes("title:")), new RegExp(`^- alice-a \\(reported host: [^)]+\\) title: "test · ${folder}" online$`));
  await w.mcp("alice-b", { HOPTELL_RELAY: url, HOPTELL_TOKEN: alice, HOPTELL_TITLE_AUTO: "off" });
  assert.doesNotMatch(await row("alice-b", () => true), /title:/);
  await w.mcp("alice-c", { HOPTELL_RELAY: url, HOPTELL_TOKEN: alice, HOPTELL_TITLE: "explicit" });
  assert.match(await row("alice-c", (r) => r.includes("title:")), /title: "explicit" online$/);
  // The shared token: no member, so no automatic title.
  await w.mcp("shared-d", { HOPTELL_RELAY: url, HOPTELL_TOKEN: TOKEN });
  const shared = await w.mcp("shared-viewer", { HOPTELL_RELAY: url, HOPTELL_TOKEN: TOKEN });
  let r;
  for (let i = 0; i < 20 && !r; i++) {
    r = (await shared.call("list_peers")).split("\n").find((l) => l.startsWith("- shared-d "));
    if (!r) await sleep(100);
  }
  assert.doesNotMatch(r, /title:/);
});

test("member-mode titles never ride in a hello: not on the first connection, not on a reconnect; they follow the welcome", async (t) => {
  const w = await world();
  t.after(() => w.close());
  const alice = fakeToken();
  const relay = await startRelay({ host: "127.0.0.1", port: 0, token: TOKEN, members: [{ name: "alice", id: "m_aaaaaaaaaaaaaaaaaaaaaaaaaa", token: alice }], log: () => {} });
  t.after(() => relay.close());
  // A proxy that records each hello the client sends and can drop every connection.
  const hellos = [];
  const pairs = new Set();
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise((r) => wss.once("listening", r));
  wss.on("connection", (down) => {
    const up = new WebSocket(`ws://127.0.0.1:${relay.port}`);
    const pair = { up, down };
    pairs.add(pair);
    const early = [];
    up.on("open", () => early.splice(0).forEach((d) => up.send(d)));
    down.on("message", (raw) => {
      const d = raw.toString();
      try {
        const f = JSON.parse(d);
        if (f.type === "hello") hellos.push({ title: f.title ?? null, claim: f.claim ?? null });
      } catch {}
      up.readyState === WebSocket.OPEN ? up.send(d) : early.push(d);
    });
    up.on("message", (d) => down.readyState === WebSocket.OPEN && down.send(d.toString()));
    up.on("close", () => (pairs.delete(pair), down.terminate()));
    down.on("close", () => (pairs.delete(pair), up.terminate()));
    up.on("error", () => {});
    down.on("error", () => {});
  });
  t.after(() => {
    for (const c of wss.clients) c.terminate();
    wss.close();
  });
  const viewer = new RelayClient({ url: `ws://127.0.0.1:${relay.port}`, token: alice, name: "alice-viewer", mode: "send", reconnect: false });
  await viewer.start().ready(5000);
  t.after(() => viewer.close());
  const titleOf = async (want) => {
    let p;
    for (let i = 0; i < 80; i++) {
      p = (await viewer.list()).find((x) => x.name === "alice-r");
      if (p && want(p)) return p.title ?? null;
      await sleep(100);
    }
    return p?.title ?? null;
  };
  const m = await w.mcp("alice-r", { HOPTELL_RELAY: `ws://127.0.0.1:${wss.address().port}`, HOPTELL_TOKEN: alice });
  await m.call("list_peers");
  const folder = path.basename(process.cwd());
  assert.equal(await titleOf((p) => p.title), `test · ${folder}`, "published after the welcome");
  assert.ok(hellos.length >= 1 && hellos.every((h) => h.title === null), `first hello: ${JSON.stringify(hellos)}`);
  // Drop the connection: the reconnect's hello carries no title either.
  const before = hellos.length;
  for (const p of [...pairs]) p.down.terminate();
  for (let i = 0; i < 80 && hellos.length === before; i++) await sleep(100);
  assert.ok(hellos.length > before, "the session reconnected");
  assert.ok(hellos.slice(before).every((h) => h.title === null), `reconnect hello: ${JSON.stringify(hellos.slice(before))}`);
  await m.call("list_peers");
  assert.equal(await titleOf((p) => p.online && p.title), `test · ${folder}`, "and it is back after the new welcome");
});
