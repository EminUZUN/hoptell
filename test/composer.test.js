// Several relays for one agent session (lib/composer.js, design 2.1): routing, merged reads with
// composite receipts, reply routing by stored origin, a relay that is down, send-only relays.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RelayClient } from "../lib/client.js";
import * as inbox from "../lib/inbox.js";
import { createComposer, parseComposite } from "../lib/composer.js";
import { createSession } from "../lib/mcp.js";
import { readRelaysFile } from "../lib/relays.js";
import { startRelay } from "../lib/relay.js";
import { readSettings } from "../lib/settings.js";
import { contactsFile, freshContacts } from "../lib/contacts.js";
import { HELD_WAIT } from "../lib/notices.js";
import { existingInstall, fakeToken, sleep } from "./helpers.js";

const textOf = (r) => r.content[0].text;
async function until(fn, ms = 8000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) if (await fn()) return true;
  return false;
}

async function setup(t, { labJoin = true, withDefault = true, workJoin = true, env: extra = {}, beforeStart = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hoptell-comp-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = existingInstall(path.join(dir, "home"));
  const tokens = { work: fakeToken(), lab: fakeToken() };
  const work = await startRelay({ host: "127.0.0.1", port: 0, token: tokens.work, realm: { id: "a".repeat(32), name: "work" }, log: () => {} });
  const lab = await startRelay({ host: "127.0.0.1", port: 0, token: tokens.lab, realm: { id: "b".repeat(32), name: "lab" }, log: () => {} });
  t.after(() => work.close());
  t.after(() => lab.close());
  const url = { work: `ws://127.0.0.1:${work.port}`, lab: `ws://127.0.0.1:${lab.port}` };
  const file = path.join(dir, "relays.json");
  fs.writeFileSync(file, JSON.stringify({ version: 1, ...(withDefault ? { default: "work" } : {}), relays: [{ alias: "work", url: url.work, tokenEnv: "T_WORK", join: workJoin }, { alias: "lab", url: url.lab, tokenEnv: "T_LAB", join: labJoin }] }), { mode: 0o600 });
  const env = { HOPTELL_HOME: home, HOPTELL_NAME: "alice", HOPTELL_PUSH: "listener", HOPTELL_RECEIPTS: "on", HOPTELL_RELAYS: file, T_WORK: tokens.work, T_LAB: tokens.lab, ...extra };
  const settings = readSettings({ env, homedir: dir, pid: process.pid, hostname: "testhost" });
  const relays = readRelaysFile(file, { env, homedir: dir });
  const c = createComposer(settings, relays, { keepAlive: true });
  t.after(() => c.stop());
  beforeStart?.(c, home);
  await c.start();
  // A peer "bob" on each relay, and a sender "carol" on lab.
  const peer = (relay, name) => {
    const p = new RelayClient({ url: url[relay], token: tokens[relay], name, mode: "peer" });
    p.got = [];
    p.on("message", (m, confirm) => (p.got.push(m), confirm?.()));
    t.after(() => p.close());
    return p.start();
  };
  return { c, url, tokens, home, dir, peer, settings, env, relays: { work, lab } };
}

test("bare names go only to the default relay; name@relay chooses; @all stays within one relay", async (t) => {
  const { c, peer } = await setup(t);
  const bobWork = peer("work", "bob");
  const bobLab = peer("lab", "bob");
  await bobWork.ready();
  await bobLab.ready();
  assert.ok(await until(async () => /bob@lab/.test(textOf(await c.call("list_peers")))), "both relays listed");
  await c.call("send_message", { to: "bob", message: "to work" });
  await c.call("send_message", { to: "bob@lab", message: "to lab" });
  await c.call("send_message", { to: "@all@lab", message: "everyone on lab" });
  assert.ok(await until(() => bobWork.got.length === 1 && bobLab.got.length === 2));
  assert.deepEqual(bobWork.got.map((m) => m.text), ["to work"]);
  assert.deepEqual(bobLab.got.map((m) => m.text).sort(), ["everyone on lab", "to lab"]);
  assert.match(textOf(await c.call("send_message", { to: "bob@nowhere", message: "x" })), /no relay "nowhere"/);
});

test("without a default, bare addresses are refused", async (t) => {
  const { c } = await setup(t, { withDefault: false });
  assert.match(textOf(await c.call("send_message", { to: "bob", message: "x" })), /say which relay: bob@<alias>/);
});

test("one read over both relays: labeled senders, one composite receipt, acknowledged per store", async (t) => {
  const { c, peer } = await setup(t);
  const carol = peer("lab", "carol");
  const dave = peer("work", "dave");
  await carol.ready();
  await dave.ready();
  await until(async () => /alice@lab/.test(textOf(await c.call("list_peers"))) || true);
  await carol.send("alice", "from lab");
  await dave.send("alice", "from work");
  let out = "";
  assert.ok(await until(async () => /from lab/.test((out = textOf(await c.call("wait_for_message", { timeout_seconds: 2 })))) && /from work/.test(out)) || (/from lab/.test(out) && /from work/.test(out)), out);
  assert.match(out, /from "carol@lab"/);
  assert.match(out, /from "dave@work"/);
  const receipt = out.match(/Receipt: (r2\.\S+?)\./)[1];
  assert.equal(parseComposite(receipt).parts.length, 2);
  // Not acknowledged yet: the same batch comes back to this reader.
  assert.match(textOf(await c.call("read_inbox")), /from lab/);
  assert.equal(textOf(await c.call("ack_messages", { receipt })), "Acknowledged.");
  assert.equal(textOf(await c.call("read_inbox")), "Inbox empty.");
  // A part naming a store this session does not own is refused, never redirected.
  const forged = `r2.${Buffer.from(JSON.stringify({ v: 1, parts: [{ scope: { profile: "x", realm: "c".repeat(32), member: "shared", folder: "alice" }, receipt: "r_x" }] })).toString("base64url")}`;
  assert.match(textOf(await c.call("ack_messages", { receipt: forged })), /an unknown relay/);
  assert.throws(() => parseComposite("r2.!!!"), /malformed/);
});

test("a reply goes through the relay its message came from; a bare reply to another relay is refused", async (t) => {
  const { c, peer } = await setup(t);
  const carol = peer("lab", "carol");
  await carol.ready();
  await sleep(300);
  await carol.send("alice", "please reply");
  let out = "";
  assert.ok(await until(async () => /please reply/.test((out = textOf(await c.call("read_inbox"))))));
  const ref = out.match(/Message reference: ([0-9a-f-]{36})/)[1];
  assert.match(textOf(await c.call("send_message", { to: "carol", message: "wrong way", reply_to: ref })), /reply to carol@lab/);
  await c.call("send_message", { to: "carol@lab", message: "right way", reply_to: ref });
  assert.ok(await until(() => carol.got.some((m) => m.text === "right way")));
  assert.match(textOf(await c.call("send_message", { to: "carol", message: "x", reply_to: "00000000-0000-4000-8000-000000000000" })), /not known here/);
});

test("a relay that is down does not stop the other; list_peers says which is down", async (t) => {
  const { c, peer, relays } = await setup(t);
  const dave = peer("work", "dave");
  await dave.ready();
  await relays.lab.close();
  await sleep(300);
  await dave.send("alice", "still here");
  let out = "";
  assert.ok(await until(async () => /still here/.test((out = textOf(await c.call("read_inbox"))))), out);
  assert.match(textOf(await c.call("list_peers")), /lab \(ws:\/\/[^)]+\): down/);
});

test("a send-only relay: no receiving name there, sends still work", async (t) => {
  const { c, peer } = await setup(t, { labJoin: false });
  const bob = peer("lab", "bob");
  await bob.ready();
  await c.call("send_message", { to: "bob@lab", message: "send-only" });
  assert.ok(await until(() => bob.got.some((m) => m.text === "send-only")));
  const names = (await bob.list()).map((p) => p.name);
  assert.ok(!names.includes("alice"), `no receiving name on a send-only relay: ${names}`);
});

test("without a relays file the session is the single-relay engine of today", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hoptell-comp-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = { HOPTELL_HOME: dir, HOPTELL_RELAY: "ws://127.0.0.1:1", HOPTELL_TOKEN: fakeToken(), XDG_CONFIG_HOME: path.join(dir, "cfg") };
  const s = await createSession(readSettings({ env, homedir: dir, pid: process.pid }), { env, homedir: dir });
  assert.equal(s.links, undefined, "an engine, not a composer");
  await s.stop();
});

test("the CLI: send to name@relay, list --relay, a conflicting --relay is refused", async (t) => {
  const { peer, env, dir } = await setup(t);
  const bob = peer("lab", "bob");
  await bob.ready();
  const { spawn } = await import("node:child_process");
  fs.writeFileSync(path.join(dir, "none.env"), ""); // never the developer's real settings
  const bin = new URL("../bin/hoptell.js", import.meta.url).pathname;
  // Asynchronous: the relays run in this process and must keep answering.
  const cli = (...a) =>
    new Promise((resolve) => {
      const p = spawn(process.execPath, [bin, ...a], { env: { ...process.env, ...env, HOPTELL_NAME: "alice-cli", HOPTELL_ENV: path.join(dir, "none.env"), XDG_CONFIG_HOME: path.join(dir, "cfg") } });
      let stdout = "";
      let stderr = "";
      p.stdout.on("data", (d) => (stdout += d));
      p.stderr.on("data", (d) => (stderr += d));
      p.on("close", (status) => resolve({ status, stdout, stderr }));
    });
  const sent = await cli("send", "bob@lab", "hello from the CLI");
  assert.equal(sent.status, 0, sent.stderr);
  assert.ok(await until(() => bob.got.some((m) => m.text === "hello from the CLI")));
  assert.match((await cli("list", "--relay", "lab")).stdout, /bob/);
  const bad = await cli("send", "--relay", "work", "bob@lab", "x");
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /disagree/);
});

test("one link failing to read does not hide the other's messages; the failure is noted", async (t) => {
  const { c, peer } = await setup(t);
  const dave = peer("work", "dave");
  const carol = peer("lab", "carol");
  await dave.ready();
  await carol.ready();
  await sleep(300);
  await dave.send("alice", "work message");
  await carol.send("alice", "lab message");
  const lab = c.links.find((l) => l.alias === "lab").engine;
  assert.ok(await until(async () => (await lab.link.pending()).length > 0));
  const real = lab.link.take;
  lab.link.take = async () => {
    throw new Error("simulated storage error");
  };
  let out = "";
  assert.ok(await until(async () => /work message/.test((out = textOf(await c.call("read_inbox"))))), out);
  assert.match(out, /from lab could not be read now: simulated storage error/);
  lab.link.take = real;
  const receipt = out.match(/Receipt: (r2\.\S+?)\./)?.[1];
  out = textOf(await c.call("read_inbox", { ack: receipt }));
  assert.match(out, /lab message/, "the other relay's message comes on the next read");
});

test("large messages: an empty batch always takes one; the rest come next", async (t) => {
  const { c, peer } = await setup(t);
  const dave = peer("work", "dave");
  const carol = peer("lab", "carol");
  await dave.ready();
  await carol.ready();
  await sleep(300);
  const big = "x".repeat(95_000);
  for (let i = 0; i < 2; i++) await dave.send("alice", `W${i}${big}`);
  for (let i = 0; i < 2; i++) await carol.send("alice", `L${i}${big}`);
  const lab = c.links.find((l) => l.alias === "lab").engine;
  const work = c.links.find((l) => l.alias === "work").engine;
  assert.ok(await until(async () => (await lab.link.pending()).length === 2 && (await work.link.pending()).length === 2));
  const shown = [];
  let ack;
  for (let i = 0; i < 4 && shown.length < 4; i++) {
    const out = textOf(await c.call("read_inbox", ack ? { ack } : {}));
    const got = [...out.matchAll(/\n([WL]\d)x{10}/g)].map((m) => m[1]);
    assert.ok(got.length >= 1, "every read takes at least one message");
    assert.ok(Buffer.byteLength(out) < 256 * 1024 + 4096, `a read stays within its budget (${Buffer.byteLength(out)} bytes)`);
    shown.push(...got);
    ack = out.match(/Receipt: (r2\.\S+?)\./)?.[1];
  }
  assert.deepEqual(shown.sort(), ["L0", "L1", "W0", "W1"]);
});

test("protocol-1 links keep their files under the relay's profile; the stores file names every store", async (t) => {
  const { home, c, peer } = await setup(t);
  const dave = peer("work", "dave");
  await dave.ready();
  await sleep(300);
  const stores = JSON.parse(fs.readFileSync(path.join(home, "sessions", "alice.stores.json"), "utf8")).stores;
  assert.deepEqual(stores.map((s) => s.alias).sort(), ["lab", "work"]);
  assert.ok(stores.every((s) => s.dir && s.scope.realm), "bound stores with their realms");
  await c.stop();
  assert.equal(fs.existsSync(path.join(home, "sessions", "alice.stores.json")), false, "removed when the session ends");
});

test("two receiving entries for the same relay and name are refused", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hoptell-comp-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "relays.json");
  fs.writeFileSync(file, JSON.stringify({ version: 1, relays: [{ alias: "a", url: "ws://127.0.0.1:9", tokenEnv: "T" }, { alias: "b", url: "ws://127.0.0.1:9", tokenEnv: "T" }] }), { mode: 0o600 });
  const r = readRelaysFile(file, { env: { T: "t".repeat(20) }, homedir: dir });
  assert.deepEqual(r.relays.map((x) => x.alias), ["a"]);
  assert.match(r.problems[0].problem, /same relay and name as "a"/);
});

test("a partly failed ack names what is left; the same receipt again finishes it", async (t) => {
  const { c, peer } = await setup(t);
  const dave = peer("work", "dave");
  const carol = peer("lab", "carol");
  await dave.ready();
  await carol.ready();
  await sleep(300);
  await dave.send("alice", "w");
  await carol.send("alice", "l");
  let out = "";
  assert.ok(await until(async () => /from "dave@work"/.test((out = textOf(await c.call("read_inbox")))) && /from "carol@lab"/.test(out)), out);
  const receipt = out.match(/Receipt: (r2\.\S+?)\./)[1];
  const lab = c.links.find((l) => l.alias === "lab").engine;
  const real = lab.link.ack;
  lab.link.ack = async () => {
    throw new Error("simulated");
  };
  assert.match(textOf(await c.call("ack_messages", { receipt })), /not acknowledged: lab/);
  lab.link.ack = real;
  assert.equal(textOf(await c.call("ack_messages", { receipt })), "Acknowledged.", "the work part was done; only lab is retried");
  assert.equal(textOf(await c.call("read_inbox")), "Inbox empty.");
});

test("renaming an alias: receipts and protocol-1 mail follow the relay, not its old name", async (t) => {
  const { url, tokens, dir, home, peer } = await setup(t);
  const make = async (labAlias, extraEnv = {}) => {
    const file = path.join(dir, `relays-${labAlias}.json`);
    fs.writeFileSync(file, JSON.stringify({ version: 1, default: "work", relays: [{ alias: "work", url: url.work, tokenEnv: "T_WORK" }, { alias: labAlias, url: url.lab, tokenEnv: "T_LAB" }] }), { mode: 0o600 });
    const env = { HOPTELL_HOME: home, HOPTELL_NAME: "alice2", HOPTELL_PUSH: "listener", HOPTELL_RECEIPTS: "on", HOPTELL_RELAYS: file, T_WORK: tokens.work, T_LAB: tokens.lab, ...extraEnv };
    const settings = readSettings({ env, homedir: dir, pid: process.pid, hostname: "testhost" });
    const c = createComposer(settings, readRelaysFile(file, { env, homedir: dir }), { keepAlive: true });
    t.after(() => c.stop());
    await c.start();
    return c;
  };
  const carol = peer("lab", "carol");
  await carol.ready();
  // Receipts: taken under "lab", acknowledged after the alias became "lab-b".
  let a = await make("lab");
  await sleep(300);
  await carol.send("alice2", "rename me");
  let out = "";
  assert.ok(await until(async () => /rename me/.test((out = textOf(await a.call("read_inbox"))))), out);
  const receipt = out.match(/Receipt: (r2\.\S+?)\./)[1];
  await a.stop();
  const b = await make("lab-b");
  // A stopped session gave its batch back: the old receipt is unknown (never redirected), and the
  // message comes again, now labeled with the relay's new alias; its new receipt works.
  assert.match(textOf(await b.call("ack_messages", { receipt })), /not acknowledged: lab-b \(unknown\)/);
  assert.ok(await until(async () => /from "carol@lab-b"/.test((out = textOf(await b.call("read_inbox"))))), out);
  assert.equal(textOf(await b.call("ack_messages", { receipt: out.match(/Receipt: (r2\.\S+?)\./)[1] })), "Acknowledged.");
  assert.equal(textOf(await b.call("read_inbox")), "Inbox empty.");
  await b.stop();
  // Protocol 1: unread mail stored under "lab" is read under "lab-c" (the files follow the relay's profile).
  a = await make("lab", { HOPTELL_PROTOCOL: "1" });
  await sleep(500);
  await carol.send("alice2", "legacy mail");
  await sleep(800);
  await a.stop();
  const c3 = await make("lab-c", { HOPTELL_PROTOCOL: "1" });
  assert.ok(await until(async () => /legacy mail/.test((out = textOf(await c3.call("read_inbox"))))), out);
  assert.match(out, /from "carol@lab-c"/);
});

test("a slow take is waited for, never dropped: nothing taken is lost (receipts off too)", async (t) => {
  for (const receipts of ["on", "off"]) {
    const { c, peer } = await setup(t, { env: { HOPTELL_RECEIPTS: receipts } });
    const carol = peer("lab", "carol");
    await carol.ready();
    await sleep(300);
    await carol.send("alice", `slow ${receipts}`);
    const lab = c.links.find((l) => l.alias === "lab").engine;
    assert.ok(await until(async () => (await lab.link.pending()).length > 0));
    const real = lab.link.take;
    lab.link.take = async (limits) => (await sleep(11_000), real(limits)); // longer than any former per-link limit
    const out = textOf(await c.call("read_inbox"));
    lab.link.take = real;
    assert.match(out, new RegExp(`slow ${receipts}`), `${receipts}: the late batch is in the result`);
  }
});

test("one notifier over every relay: stable keys, a notice while the default relay is down, re-announced", async (t) => {
  const { c, peer, relays } = await setup(t);
  const { NoticeScheduler } = await import("../lib/notices.js");
  const carol = peer("lab", "carol");
  await carol.ready();
  await sleep(300);
  await relays.work.close(); // the default relay is down
  await carol.send("alice", "notice me");
  const lab = c.links.find((l) => l.alias === "lab").engine;
  assert.ok(await until(async () => (await lab.link.pending()).length > 0));
  const keys = await c.noticeList();
  assert.ok(keys.every((k) => typeof k === "string" && /^lab\//.test(k)), JSON.stringify(keys));
  let sent = 0;
  const sched = new NoticeScheduler({ list: c.noticeList, send: async () => (sent++, true), reannounceMs: [600], minGapMs: 0, coalesceMs: 100 });
  // Timing tolerant (a busy machine): tick until the notice, then check nothing more is sent at once.
  for (let i = 0; i < 40 && sent < 1; i++, await sleep(100)) await sched.tick();
  assert.equal(sent, 1, "announced");
  for (let i = 0; i < 3; i++) await sched.tick();
  assert.equal(sent, 1, "once, not on every tick");
  for (let i = 0; i < 40 && sent < 2; i++, await sleep(100)) await sched.tick();
  assert.equal(sent, 2, "re-announced while still unread");
});

test("the CLI keeps the reply rule: a reply to a lab message addressed to the default is refused, nothing sent", async (t) => {
  const { c, peer, env, dir } = await setup(t);
  const carol = peer("lab", "carol");
  const bobWork = peer("work", "bob");
  const bobLab = peer("lab", "bob");
  await Promise.all([carol.ready(), bobWork.ready(), bobLab.ready()]);
  await sleep(300);
  await carol.send("alice", "reply via lab");
  let out = "";
  assert.ok(await until(async () => /reply via lab/.test((out = textOf(await c.call("read_inbox"))))));
  const ref = out.match(/Message reference: ([0-9a-f-]{36})/)[1];
  const { spawn } = await import("node:child_process");
  fs.writeFileSync(path.join(dir, "none.env"), "");
  const bin = new URL("../bin/hoptell.js", import.meta.url).pathname;
  const r = await new Promise((resolve) => {
    const p = spawn(process.execPath, [bin, "send", "--reply-to", ref, "bob", "wrong relay"], { env: { ...process.env, ...env, HOPTELL_NAME: "alice-cli", HOPTELL_ENV: path.join(dir, "none.env"), XDG_CONFIG_HOME: path.join(dir, "cfg") } });
    let stderr = "";
    p.stderr.on("data", (d) => (stderr += d));
    p.on("close", (status) => resolve({ status, stderr }));
  });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /reply to bob@lab/);
  await sleep(500);
  assert.equal(bobWork.got.length + bobLab.got.length, 0, "nothing reached either relay");
});

test("budgets: a held batch that does not fit waits; protocol-1 links read within the budget", async (t) => {
  {
    const { c, peer } = await setup(t);
    const dave = peer("work", "dave");
    const carol = peer("lab", "carol");
    await dave.ready();
    await carol.ready();
    await sleep(300);
    await dave.send("alice", `W${"€".repeat(99_000)}`); // about 300 KB as stored
    const work = c.links.find((l) => l.alias === "work").engine;
    assert.ok(await until(async () => (await work.link.pending()).length > 0));
    const first = textOf(await c.call("read_inbox")); // alone: the one-message allowance
    assert.match(first, /W€€€/);
    await carol.send("alice", `L${"x".repeat(95_000)}`);
    const lab = c.links.find((l) => l.alias === "lab").engine;
    assert.ok(await until(async () => (await lab.link.pending()).length > 0));
    const outs = [];
    for (let i = 0; i < 3; i++) outs.push(textOf(await c.call("read_inbox")));
    for (const o of outs) if (/Lxxx/.test(o) && /W€€€/.test(o)) assert.fail("the held 300 KB batch was combined with another message");
    assert.ok(outs.some((o) => /Lxxx/.test(o)), "the lab message is read");
  }
  {
    const { c, peer } = await setup(t, { env: { HOPTELL_PROTOCOL: "1" } });
    const carol = peer("lab", "carol");
    await carol.ready();
    const lab = c.links.find((l) => l.alias === "lab").engine;
    assert.ok(await until(() => lab.link.status().state === "legacy"), "protocol 1 from the relays-file-only settings");
    for (let i = 0; i < 12; i++) await carol.send("alice", `M${String(i).padStart(2, "0")}${"y".repeat(25_000)}`);
    assert.ok(await until(async () => (await lab.link.pending()).length === 12));
    const seen = new Set();
    let ack;
    for (let i = 0; i < 6 && seen.size < 12; i++) {
      const out = textOf(await c.call("read_inbox", ack ? { ack } : {}));
      assert.ok(Buffer.byteLength(out) < 256 * 1024 + 4096, `bounded (${Buffer.byteLength(out)} bytes)`);
      for (const m of out.matchAll(/\nM(\d\d)y/g)) seen.add(m[1]);
      ack = out.match(/Receipt: (r2\.\S+?)\./)?.[1];
    }
    assert.equal(seen.size, 12, "every message read, none lost");
  }
});

test("a relay on protocol 1 next to one with receipts: both read, the receipt covers the bound one", async (t) => {
  const { c, peer } = await setup(t, { beforeStart: (comp) => (comp.links.find((l) => l.alias === "lab").engine.link.relay.legacyRelay = true) });
  const carol = peer("lab", "carol");
  const dave = peer("work", "dave");
  await carol.ready();
  await dave.ready();
  const lab = c.links.find((l) => l.alias === "lab").engine;
  assert.ok(await until(() => lab.link.status().state === "legacy"));
  await sleep(300);
  await carol.send("alice", "old protocol");
  await dave.send("alice", "receipts");
  let out = "";
  assert.ok(await until(async () => {
    out += textOf(await c.call("read_inbox"));
    return /old protocol/.test(out) && /receipts/.test(out);
  }), out);
  const receipt = out.match(/Receipt: (r2\.\S+?)\./)[1];
  assert.equal(parseComposite(receipt).parts.length, 2, "the protocol-1 batch is held under the composer's own receipt part");
  assert.equal(textOf(await c.call("ack_messages", { receipt })), "Acknowledged.");
  assert.equal(textOf(await c.call("read_inbox")), "Inbox empty.");
});

test("only send-only relays: the tools are still there; origins are shared between sessions and keep every relay", async (t) => {
  const { c } = await setup(t, { workJoin: false, labJoin: false });
  const names = (await c.tools()).map((x) => x.name);
  for (const n of ["send_message", "list_peers"]) assert.ok(names.includes(n), `${n} in ${names}`);
  const { routesStore, checkReply } = await import("../lib/routes.js");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "hoptell-routes-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const a = routesStore(home);
  const b = routesStore(home);
  const ref = "11111111-1111-4111-8111-111111111111";
  await a.note([{ ref, profile: "pw", realm: "rw" }]);
  await b.note([{ ref, profile: "pl", realm: "rl" }]); // the same reference on another relay, from another session
  assert.equal(a.lookup(ref).length, 2, "both origins kept, across sessions");
  const rule = (profile, qualified = true) => checkReply({ origins: a.lookup(ref), routeProfile: profile, target: "bob", qualified, several: true, aliasOf: (p) => ({ pw: "work", pl: "lab" })[p], aliases: ["work", "lab"] });
  rule("pw");
  rule("pl");
  assert.throws(() => rule("px"), /bob@work or bob@lab/);
});

const MODES = [
  ["receipts on", { HOPTELL_RECEIPTS: "on" }],
  ["receipts off", { HOPTELL_RECEIPTS: "off" }],
  ["protocol 1", { HOPTELL_PROTOCOL: "1" }],
];

test("a read cancelled right after its take, or failing after it, loses nothing (every storage mode)", async (t) => {
  for (const [mode, env] of MODES) {
    const { c, peer } = await setup(t, { env });
    const carol = peer("lab", "carol");
    await carol.ready();
    const lab = c.links.find((l) => l.alias === "lab").engine;
    assert.ok(await until(() => lab.link.status().state !== "pending"));
    await sleep(300);
    await carol.send("alice", `keep me (${mode})`);
    assert.ok(await until(async () => (await lab.link.pending()).length > 0), mode);
    // Cancelled just after the take succeeded.
    const ctl = new AbortController();
    const real = lab.link.take;
    lab.link.take = async (limits) => {
      const b = await real(limits);
      ctl.abort();
      return b;
    };
    const cancelled = textOf(await c.call("read_inbox", {}, { signal: ctl.signal }));
    assert.match(cancelled, /cancelled/, `${mode}: ${cancelled.slice(0, 200)}`);
    lab.link.take = real;
    // A failure after the take.
    const first = c.links[0].engine; // the composer asks every link for the parts of the decisions lines
    const realDecisions = first.link.decisionParts;
    first.link.decisionParts = () => {
      throw new Error("simulated");
    };
    assert.match(textOf(await c.call("read_inbox")), /simulated/, mode);
    first.link.decisionParts = realDecisions;
    let out = "";
    assert.ok(await until(async () => new RegExp(`keep me \\(${mode}\\)`).test((out = textOf(await c.call("read_inbox"))))), `${mode}: ${out}`);
    // Every mode ends with a receipt in a composed session; acknowledging it removes the message.
    const receipt = out.match(/Receipt: (r2\.\S+?)\./)[1];
    assert.equal(textOf(await c.call("ack_messages", { receipt })), "Acknowledged.", mode);
    assert.match(textOf(await c.call("read_inbox")), /Inbox empty/, `${mode}: gone after the ack`);
  }
});

test("a cancelled wait takes nothing; a later message is read by the next call", async (t) => {
  const { c, peer } = await setup(t, { env: { HOPTELL_RECEIPTS: "off" } });
  const carol = peer("lab", "carol");
  await carol.ready();
  await sleep(300);
  const ctl = new AbortController();
  setTimeout(() => ctl.abort(), 300);
  const started = Date.now();
  await c.call("wait_for_message", { timeout_seconds: 30 }, { signal: ctl.signal });
  assert.ok(Date.now() - started < 5000, "the wait ended on cancellation");
  await carol.send("alice", "after the cancel");
  let out = "";
  assert.ok(await until(async () => /after the cancel/.test((out = textOf(await c.call("read_inbox"))))), out);
});

test("through a real MCP client: cancelling a read keeps its message", async (t) => {
  const { c, peer } = await setup(t, { env: { HOPTELL_RECEIPTS: "off" } });
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const carol = peer("lab", "carol");
  await carol.ready();
  await sleep(300);
  await carol.send("alice", "over mcp");
  const lab = c.links.find((l) => l.alias === "lab").engine;
  assert.ok(await until(async () => (await lab.link.pending()).length > 0));
  const { Server } = await import("@modelcontextprotocol/sdk/server/index.js");
  const { CallToolRequestSchema, ListToolsRequestSchema } = await import("@modelcontextprotocol/sdk/types.js");
  const [a, b] = InMemoryTransport.createLinkedPair();
  // As runStdio wires it: the request's signal goes to the call.
  const server = new Server({ name: "hoptell", version: "0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: await c.tools() }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }, extra) => c.call(params.name, params.arguments ?? {}, { signal: extra?.signal ?? null }));
  await server.connect(b);
  const client = new Client({ name: "t", version: "0" });
  await client.connect(a);
  t.after(() => client.close());
  const real = lab.link.take;
  const ctl = new AbortController();
  lab.link.take = async (limits) => {
    const r = await real(limits);
    ctl.abort(); // the client cancels while the server holds the batch
    await sleep(200);
    return r;
  };
  await assert.rejects(client.callTool({ name: "read_inbox", arguments: {} }, undefined, { signal: ctl.signal }));
  lab.link.take = real;
  await sleep(500);
  let out = "";
  assert.ok(await until(async () => /over mcp/.test((out = (await client.callTool({ name: "read_inbox", arguments: {} })).content[0].text))), out);
});

test("a reference seen on two relays needs a qualified reply (sessions and CLI alike)", async (t) => {
  const { c, peer, url, env, dir, home } = await setup(t);
  const { routesStore } = await import("../lib/routes.js");
  const { profileKey } = await import("../lib/profiles.js");
  const bobWork = peer("work", "bob");
  const bobLab = peer("lab", "bob");
  await bobWork.ready();
  await bobLab.ready();
  const ref = "22222222-2222-4222-8222-222222222222";
  await routesStore(home).note([{ ref, profile: profileKey(url.work), realm: "a".repeat(32) }, { ref, profile: profileKey(url.lab), realm: "b".repeat(32) }]);
  assert.match(textOf(await c.call("send_message", { to: "bob", message: "x", reply_to: ref })), /seen on several relays: say which, as bob@work or bob@lab/);
  await c.call("send_message", { to: "bob@work", message: "to work", reply_to: ref });
  await c.call("send_message", { to: "bob@lab", message: "to lab", reply_to: ref });
  assert.ok(await until(() => bobWork.got.length === 1 && bobLab.got.length === 1));
  const { spawn } = await import("node:child_process");
  fs.writeFileSync(path.join(dir, "none.env"), "");
  const bin = new URL("../bin/hoptell.js", import.meta.url).pathname;
  const cli = (...a) =>
    new Promise((resolve) => {
      const p = spawn(process.execPath, [bin, ...a], { env: { ...process.env, ...env, HOPTELL_NAME: "alice-cli", HOPTELL_ENV: path.join(dir, "none.env"), XDG_CONFIG_HOME: path.join(dir, "cfg") } });
      let stderr = "";
      p.stderr.on("data", (d) => (stderr += d));
      p.on("close", (status) => resolve({ status, stderr }));
    });
  const bare = await cli("send", "--reply-to", ref, "bob", "bare");
  assert.notEqual(bare.status, 0);
  assert.match(bare.stderr, /several relays/);
  assert.equal((await cli("send", "--relay", "work", "--reply-to", ref, "bob", "qualified")).status, 0);
  assert.ok(await until(() => bobWork.got.some((m) => m.text === "qualified")));
  assert.ok(!bobWork.got.some((m) => m.text === "bare") && !bobLab.got.some((m) => m.text === "bare"), "nothing sent when refused");
});

test("through a real MCP client: cancelled while a store lock is held after the take, with a bound and a protocol-1 relay", async (t) => {
  const { c, peer } = await setup(t, { env: { HOPTELL_RECEIPTS: "off" }, beforeStart: (comp) => (comp.links.find((l) => l.alias === "lab").engine.link.relay.legacyRelay = true) });
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const { Server } = await import("@modelcontextprotocol/sdk/server/index.js");
  const { CallToolRequestSchema, ListToolsRequestSchema } = await import("@modelcontextprotocol/sdk/types.js");
  const { tryLock } = await import("../lib/locks.js");
  const dave = peer("work", "dave");
  const carol = peer("lab", "carol");
  await dave.ready();
  await carol.ready();
  const work = c.links.find((l) => l.alias === "work").engine;
  const lab = c.links.find((l) => l.alias === "lab").engine;
  assert.ok(await until(() => work.link.status().state === "bound" && lab.link.status().state === "legacy"));
  await sleep(300);
  await dave.send("alice", "bound one");
  await carol.send("alice", "legacy one");
  assert.ok(await until(async () => (await work.link.pending()).length && (await lab.link.pending()).length));
  const [a, b] = InMemoryTransport.createLinkedPair();
  const server = new Server({ name: "hoptell", version: "0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: await c.tools() }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }, extra) => c.call(params.name, params.arguments ?? {}, { signal: extra?.signal ?? null }));
  await server.connect(b);
  const client = new Client({ name: "t", version: "0" });
  await client.connect(a);
  t.after(() => client.close());
  const ctl = new AbortController();
  const realDecisions = work.link.pendingDecisions;
  let unlock = null;
  work.link.pendingDecisions = async () => {
    // Ordinary lock contention right where a read would finish: the cancellation arrives while
    // anything that waits for this store's lock is waiting.
    unlock = tryLock(path.join(work.session.store.dir, "store.json.lock"));
    setTimeout(() => ctl.abort(), 200);
    setTimeout(() => typeof unlock === "function" && unlock(), 600);
    return "";
  };
  const first = await client.callTool({ name: "read_inbox", arguments: {} }, undefined, { signal: ctl.signal }).then(
    (r) => r.content[0].text,
    () => null, // cancelled: the agent saw nothing
  );
  work.link.pendingDecisions = realDecisions;
  await sleep(800);
  // Either the agent received both messages (with a receipt still to acknowledge), or the read was
  // cancelled and both are still waiting. Never: cancelled and gone.
  if (first !== null) assert.ok(/bound one/.test(first) && /legacy one/.test(first) && /Receipt: r2\./.test(first), first);
  else {
    let out = "";
    assert.ok(await until(async () => {
      out = (await client.callTool({ name: "read_inbox", arguments: {} })).content[0].text;
      return /bound one/.test(out) && /legacy one/.test(out);
    }), out);
  }
});

const claimedIn = (dir) => {
  try {
    return fs.readdirSync(dir).filter((f) => f.startsWith(".claimed-"));
  } catch {
    return [];
  }
};

test("protocol-1 receipts: a repeated ack is fine, a failed commit can be retried, stop gives claims back", async (t) => {
  const { c, peer } = await setup(t, { env: { HOPTELL_PROTOCOL: "1" } });
  const carol = peer("lab", "carol");
  await carol.ready();
  const lab = c.links.find((l) => l.alias === "lab").engine;
  assert.ok(await until(() => lab.link.status().state === "legacy"));
  const legacyDir = () => {
    const st = lab.session.store;
    return inbox.fileOf(st, "").replace(/\/$/, "");
  };
  await sleep(300);
  await carol.send("alice", "one");
  let out = "";
  assert.ok(await until(async () => /one/.test((out = textOf(await c.call("read_inbox"))))));
  let receipt = out.match(/Receipt: (r2\.\S+?)\./)[1];
  assert.equal(textOf(await c.call("ack_messages", { receipt })), "Acknowledged.");
  assert.equal(textOf(await c.call("ack_messages", { receipt })), "Acknowledged.", "again after success");
  // A commit that fails (the inbox folder cannot be changed), then a retry that works.
  await carol.send("alice", "two");
  assert.ok(await until(async () => /two/.test((out = textOf(await c.call("read_inbox"))))));
  receipt = out.match(/Receipt: (r2\.\S+?)\./)[1];
  fs.chmodSync(legacyDir(), 0o500);
  assert.match(textOf(await c.call("ack_messages", { receipt })), /not acknowledged: lab \(error\)/);
  fs.chmodSync(legacyDir(), 0o700);
  assert.equal(textOf(await c.call("ack_messages", { receipt })), "Acknowledged.");
  assert.deepEqual(claimedIn(legacyDir()), []);
  assert.equal(textOf(await c.call("read_inbox")), "Inbox empty.");
  // Unacknowledged at stop: the claim goes back to the inbox.
  await carol.send("alice", "three");
  assert.ok(await until(async () => /three/.test(textOf(await c.call("read_inbox")))));
  assert.equal(claimedIn(legacyDir()).length, 1);
  await c.stop();
  assert.deepEqual(claimedIn(legacyDir()), [], "given back at stop");
  assert.equal(fs.readdirSync(legacyDir()).filter((f) => f.endsWith(".json")).length, 1);
});

test("overlapping reads on a protocol-1 relay: every receipt they return stays usable, nothing is lost", async (t) => {
  const { c, peer } = await setup(t, { env: { HOPTELL_PROTOCOL: "1" } });
  const carol = peer("lab", "carol");
  await carol.ready();
  const lab = c.links.find((l) => l.alias === "lab").engine;
  assert.ok(await until(() => lab.link.status().state === "legacy"));
  await sleep(300);
  await carol.send("alice", "A-message");
  assert.ok(await until(async () => (await lab.link.pending()).length === 1));
  const real = lab.link.take;
  let gate;
  const paused = new Promise((r) => (gate = r));
  let once = true;
  lab.link.take = async (limits) => {
    const b = await real(limits);
    if (once) {
      once = false;
      await paused; // the first read waits here, holding its batch
    }
    return b;
  };
  const first = c.call("read_inbox");
  await sleep(300);
  await carol.send("alice", "B-message");
  await sleep(300);
  const second = c.call("read_inbox");
  await sleep(300);
  gate();
  const [o1, o2] = (await Promise.all([first, second])).map(textOf);
  lab.link.take = real;
  for (const o of [o1, o2]) {
    const r = o.match(/Receipt: (r2\.\S+?)\./)?.[1];
    if (r) assert.equal(textOf(await c.call("ack_messages", { receipt: r })), "Acknowledged.", `every returned receipt works: ${o.slice(0, 120)}`);
  }
  let out = "";
  for (let i = 0; i < 5 && !/B-message/.test(o1 + o2 + out); i++) {
    const t2 = textOf(await c.call("read_inbox"));
    out += t2;
    const r = t2.match(/Receipt: (r2\.\S+?)\./)?.[1];
    if (r) await c.call("ack_messages", { receipt: r });
  }
  assert.ok(/A-message/.test(o1 + o2) && /B-message/.test(o1 + o2 + out), "both messages were shown");
  await c.stop();
  const dir = inbox.fileOf(lab.session.store, "").replace(/\/$/, "");
  assert.deepEqual(claimedIn(dir), [], "no claim is left behind");
});

test("contacts: a message held on a non-default relay wakes a wait once and is listed with its request; never its text", async (t) => {
  // A managed home (everyone "ask"); a shared-token sender is held.
  const { c, peer } = await setup(t, { beforeStart: (_c, home) => fs.writeFileSync(contactsFile(home), JSON.stringify(freshContacts()), { mode: 0o600 }) });
  const carol = peer("lab", "carol");
  await carol.ready();
  const lab = c.links.find((l) => l.alias === "lab").engine;
  assert.ok(await until(() => lab.link.status().state !== "pending"));
  await sleep(300);
  const waiting = c.call("wait_for_message", { timeout_seconds: 20 });
  await sleep(300);
  await carol.send("alice", "CANARY-composer-held");
  const out = textOf(await waiting);
  assert.ok(out.startsWith(HELD_WAIT), out);
  assert.match(out, /1 message from a sender using the relay's shared token: held until your user decides\. Your user can review it with: hoptell contacts show q_[a-z2-7]{16}/);
  assert.doesNotMatch(out, /CANARY-composer-held|carol/);
  // The scheduler's list carries it as a held entry of the lab link; a repeated wait does not return for it.
  assert.ok((await c.noticeList()).some((f) => /^held:lab\/q_[a-z2-7]{16}\//.test(f)));
  assert.match(textOf(await c.call("wait_for_message", { timeout_seconds: 1 })), /^No messages within 1s\./);
  assert.match(textOf(await c.call("read_inbox")), /hoptell contacts show q_/);
});
