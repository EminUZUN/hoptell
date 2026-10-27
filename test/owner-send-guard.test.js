// The owner channel's recipient guard (design 7.3, 2.6; notes N3, N7): a send to this realm's
// pinned bridge name is plaintext text by name, delivered only while the sender's own member holds
// that name (to_member); files, review sets, transfers and the role of that name are refused, and
// so is a send without the relay's to_member check or under a "required" own-member policy. Each
// named-send path: send_message bound and waiting, the composer's send-only relay, `hoptell
// send`; and RelayClient's backstop. Other names and @all are unchanged.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { RelayClient } from "../lib/client.js";
import { createComposer } from "../lib/composer.js";
import { contactsFile, freshContacts, validateContacts } from "../lib/contacts.js";
import { createEngine } from "../lib/engine.js";
import { readRelaysFile } from "../lib/relays.js";
import { readSettings } from "../lib/settings.js";
import * as sig from "../lib/ownersig.js";
import { BOB, ME, REALM, agent, newKey, ownerRelay, tmpHome, until } from "./owner-helpers.js";
import { BIN } from "../lib/config.js";
import { existingInstall, sleep } from "./helpers.js";

const textOf = (r) => r.content[0].text;
const NOTE = "Sent to your owner channel as a note; it may be hidden or dropped by message limits. Use ask_owner for a question or important update.";
const TEXT_ONLY = /your owner channel takes text only, sent to it by name; nothing was sent/;

function writePolicy(home, encryption) {
  const doc = { ...freshContacts(), revision: Date.now(), grants: [{ realm: REALM, member: ME }, { realm: REALM, member: BOB }], ...(encryption ? { encryption } : {}) };
  assert.deepEqual(validateContacts(doc), []);
  const f = contactsFile(home);
  fs.writeFileSync(`${f}.tmp`, JSON.stringify(doc), { mode: 0o600 });
  fs.renameSync(`${f}.tmp`, f);
}

async function world(t, { trust = true } = {}) {
  const r = await ownerRelay(t);
  const home = existingInstall(tmpHome(t));
  writePolicy(home, null);
  if (trust) sig.trustPin(home, sig.formatPin({ realm: REALM, name: "me-owner", pub: newKey().pub }));
  const settingsFor = (name, extra = {}) => readSettings({ env: { HOPTELL_RELAY: r.url, HOPTELL_TOKEN: r.tokens.me, HOPTELL_NAME: name, HOPTELL_HOME: home, HOPTELL_PUSH: "listener", HOPTELL_RECEIPTS: "on", HOPTELL_NOTIFY: "off", ...extra }, homedir: "/nonexistent-home", pid: process.pid, hostname: "testhost" });
  const engine = async (name = "me-alice", extra = {}) => {
    const e = createEngine(settingsFor(name, extra), { findHost: () => null, keepAlive: true });
    t.after(() => e.stop());
    e.start();
    return e;
  };
  return { ...r, home, engine, settingsFor };
}

test("send_message to the pinned bridge name: by name, to the own member, with the owner-channel line; other names unchanged", async (t) => {
  const w = await world(t);
  const e = await w.engine();
  await until(() => e.session.state === "bound", 4000, "bound");
  const bridge = await agent(t, w.url, w.tokens.me, "me-owner");
  const other = await agent(t, w.url, w.tokens.me, "me-other");
  const r = await e.call("send_message", { to: "me-owner", message: "All tests pass." });
  assert.equal(r.isError, false, textOf(r));
  assert.match(textOf(r), /^Delivered to me-owner/);
  assert.ok(textOf(r).endsWith(`\n${NOTE}`), textOf(r));
  const m = await bridge.waitFor((x) => x.text === "All tests pass.");
  assert.equal(m.sender.member.id, ME);
  const o = await e.call("send_message", { to: "me-other", message: "hi" });
  assert.equal(textOf(o).includes(NOTE), false, "only a guarded send gets the line");
  await other.waitFor((x) => x.text === "hi");
  // @all is unchanged (the bridge drops its copy); the role of the bridge's name is refused.
  const all = await e.call("send_message", { to: "@all", message: "to everyone" });
  assert.equal(all.isError, false, textOf(all));
  assert.equal(textOf(all).includes(NOTE), false);
  const role = await e.call("send_message", { to: "@me-owner", message: "as a role" });
  assert.equal(role.isError, true);
  assert.match(textOf(role), TEXT_ONLY);
  await sleep(150);
  assert.equal(bridge.got.some((x) => x.text === "as a role"), false);
});

test("a bridge name held by another member is never reached: the relay refuses the send", async (t) => {
  const w = await world(t, { trust: false });
  sig.trustPin(w.home, sig.formatPin({ realm: REALM, name: "bob-owner", pub: newKey().pub })); // a pinned name another member can hold
  const e = await w.engine();
  await until(() => e.session.state === "bound", 4000, "bound");
  const squatter = await agent(t, w.url, w.tokens.bob, "bob-owner");
  const r = await e.call("send_message", { to: "bob-owner", message: "secret status" });
  assert.equal(r.isError, true, textOf(r));
  await sleep(150);
  assert.equal(squatter.got.length, 0);
});

test("refused: without the relay's to_member check, and under a required own-member policy; preferred sends plaintext", async (t) => {
  const w = await world(t);
  const e = await w.engine();
  await until(() => e.session.state === "bound", 4000, "bound");
  const bridge = await agent(t, w.url, w.tokens.me, "me-owner");
  writePolicy(w.home, [{ realm: REALM, mode: "required" }]);
  const req = await e.call("send_message", { to: "me-owner", message: "under required" });
  assert.equal(req.isError, true);
  assert.match(textOf(req), /encryption_required: the owner channel sends plaintext through the relay, and your encryption policy for your own member requires end-to-end encryption; nothing was sent/);
  writePolicy(w.home, [{ realm: REALM, mode: "preferred" }]);
  const pref = await e.call("send_message", { to: "me-owner", message: "under preferred" });
  assert.equal(pref.isError, false, textOf(pref));
  assert.ok(textOf(pref).endsWith(NOTE));
  await bridge.waitFor((x) => x.text === "under preferred");
  // A managed policy that cannot be read: fail closed.
  fs.writeFileSync(contactsFile(w.home), "{ not json", { mode: 0o600 });
  const broken = await e.call("send_message", { to: "me-owner", message: "unreadable policy" });
  assert.equal(broken.isError, true);
  assert.match(textOf(broken), /the contacts cannot be read \(.*not valid JSON\), so the encryption policy cannot be checked; nothing was sent/);
  // ask_owner fails closed the same way.
  const asked = await e.call("ask_owner", { question: "unreadable policy question?" });
  assert.equal(asked.isError, true);
  assert.match(textOf(asked), /the contacts cannot be read \(.*not valid JSON\), so the encryption policy cannot be checked; nothing was sent/);
  writePolicy(w.home, null);
  const again = await e.call("ask_owner", { question: "readable again?" });
  assert.equal(again.isError, false, textOf(again));
  const relay = e.link.relay;
  relay.caps = relay.caps.filter((c) => c !== "to_member");
  const old = await e.call("send_message", { to: "me-owner", message: "old relay" });
  assert.equal(old.isError, true);
  assert.match(textOf(old), /Nothing was sent: this relay cannot restrict delivery to the intended member\. Your user must upgrade the relay to use this feature\./);
  // Another name on the same relay still goes.
  await agent(t, w.url, w.tokens.me, "me-other");
  assert.equal((await e.call("send_message", { to: "me-other", message: "fine" })).isError, false);
  await sleep(150);
  assert.equal(bridge.got.some((x) => /under required|old relay|unreadable policy/.test(x.text)), false);
});

test("files, review sets and transfers to the bridge name are refused before any routing", async (t) => {
  const w = await world(t);
  const app = path.join(w.home, "..", `app-${path.basename(w.home)}`);
  fs.mkdirSync(app, { recursive: true });
  t.after(() => fs.rmSync(app, { recursive: true, force: true }));
  fs.writeFileSync(path.join(app, "a.txt"), "hello");
  const e = await w.engine("me-alice", { HOPTELL_SNAPSHOT_ROOTS: JSON.stringify([{ id: "app", path: app }]), HOPTELL_EXPERIMENTAL_TRANSFERS: "on" });
  await until(() => e.session.state === "bound", 4000, "bound");
  const bridge = await agent(t, w.url, w.tokens.me, "me-owner");
  const names = (await e.tools()).map((x) => x.name);
  assert.ok(names.includes("send_file"), names.join(", "));
  for (const tool of ["send_file", "send_review_set", "send_transfer"]) {
    if (!names.includes(tool)) continue;
    const r = await e.call(tool, { to: "me-owner", root: "app", path: "a.txt", paths: ["a.txt"] });
    assert.equal(r.isError, true, tool);
    assert.match(textOf(r), TEXT_ONLY, tool);
  }
  await sleep(150);
  assert.equal(bridge.got.length, 0);
});

test("without a pin nothing changes: the name is an ordinary peer", async (t) => {
  const w = await world(t, { trust: false });
  const e = await w.engine();
  await until(() => e.session.state === "bound", 4000, "bound");
  const bridge = await agent(t, w.url, w.tokens.me, "me-owner");
  const r = await e.call("send_message", { to: "me-owner", message: "a name" });
  assert.equal(r.isError, false, textOf(r));
  assert.equal(textOf(r).includes(NOTE), false);
  const m = await bridge.waitFor((x) => x.text === "a name");
  assert.equal(m.sender.member.id, ME);
});

test("a waiting sibling sends to the bridge name through its send-only connection, guarded", async (t) => {
  const w = await world(t);
  const holder = await w.engine("me-sib");
  await until(() => holder.session.state === "bound", 4000, "holder bound");
  const waiter = await w.engine("me-sib");
  await until(() => waiter.link.status().waitingForName, 8000, "waiting");
  const bridge = await agent(t, w.url, w.tokens.me, "me-owner");
  const r = await waiter.call("send_message", { to: "me-owner", message: "from the waiting one" });
  assert.equal(r.isError, false, textOf(r));
  assert.match(textOf(r), /^Delivered to me-owner/);
  assert.ok(textOf(r).includes(`\n${NOTE}\n`), textOf(r));
  const m = await bridge.waitFor((x) => x.text === "from the waiting one");
  assert.equal(m.sender.member.id, ME);
  const role = await waiter.call("send_message", { to: "@me-owner", message: "role" });
  assert.match(textOf(role), TEXT_ONLY);
  writePolicy(w.home, [{ realm: REALM, mode: "required" }]);
  assert.match(textOf(await waiter.call("send_message", { to: "me-owner", message: "required" })), /^hoptell error: encryption_required: /);
});

test("the composer's send-only relay: guarded the same way", async (t) => {
  const w = await world(t);
  const file = path.join(w.home, "relays.json");
  fs.writeFileSync(file, JSON.stringify({ version: 1, default: "local", relays: [{ alias: "local", url: w.url, tokenEnv: "T_LOCAL", join: false }] }), { mode: 0o600 });
  const env = { HOPTELL_HOME: w.home, HOPTELL_NAME: "me-comp", HOPTELL_PUSH: "listener", HOPTELL_RECEIPTS: "on", HOPTELL_NOTIFY: "off", HOPTELL_RELAYS: file, T_LOCAL: w.tokens.me };
  const settings = readSettings({ env, homedir: "/nonexistent-home", pid: process.pid, hostname: "testhost" });
  const c = createComposer(settings, readRelaysFile(file, { env, homedir: "/nonexistent-home" }), { keepAlive: true });
  t.after(() => c.stop());
  await c.start();
  const bridge = await agent(t, w.url, w.tokens.me, "me-owner");
  const other = await agent(t, w.url, w.tokens.me, "me-other");
  const r = await c.call("send_message", { to: "me-owner@local", message: "from the composer" });
  assert.equal(r.isError, false, textOf(r));
  assert.ok(textOf(r).endsWith(`\n${NOTE}`), textOf(r));
  assert.equal((await bridge.waitFor((x) => x.text === "from the composer")).sender.member.id, ME);
  assert.match(textOf(await c.call("send_message", { to: "@me-owner@local", message: "role" })), TEXT_ONLY);
  fs.writeFileSync(contactsFile(w.home), "{ not json", { mode: 0o600 });
  assert.match(textOf(await c.call("send_message", { to: "me-owner@local", message: "broken" })), /the contacts cannot be read/);
  writePolicy(w.home, null);
  const o = await c.call("send_message", { to: "me-other@local", message: "plain" });
  assert.equal(textOf(o).includes(NOTE), false);
  await other.waitFor((x) => x.text === "plain");
});

test("hoptell send: guarded the same way", async (t) => {
  const w = await world(t);
  const bridge = await agent(t, w.url, w.tokens.me, "me-owner");
  const cli = (args, extra = {}) =>
    new Promise((resolve) => execFile(process.execPath, [BIN, ...args], { env: { PATH: process.env.PATH, HOME: w.home, HOPTELL_HOME: w.home, HOPTELL_RELAY: w.url, HOPTELL_TOKEN: w.tokens.me, HOPTELL_NAME: "me-cli", HOPTELL_NOTIFY: "off", ...extra } }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr })));
  const ok = await cli(["send", "me-owner", "from the shell"]);
  assert.equal(ok.code, 0, ok.stderr);
  // The command line speaks to a person: no "your owner", no ask_owner.
  assert.ok(ok.stdout.trim().endsWith("\nnote: the owner's Telegram chat may show this as a note; it is not shown if the session is hidden there or over the message limits."), ok.stdout);
  assert.doesNotMatch(ok.stdout, /ask_owner|your owner/);
  assert.equal((await bridge.waitFor((x) => x.text === "from the shell")).sender.member.id, ME);
  const role = await cli(["send", "@me-owner", "role"]);
  assert.notEqual(role.code, 0);
  assert.match(role.stderr, TEXT_ONLY);
  writePolicy(w.home, [{ realm: REALM, mode: "required" }]);
  const req = await cli(["send", "me-owner", "required"]);
  assert.notEqual(req.code, 0);
  assert.match(req.stderr, /encryption_required/);
  fs.writeFileSync(contactsFile(w.home), "{ not json", { mode: 0o600 });
  const broken = await cli(["send", "me-owner", "broken"]);
  assert.notEqual(broken.code, 0);
  assert.match(broken.stderr, /the contacts cannot be read/);
  await sleep(150);
  assert.equal(bridge.got.some((x) => /^(role|required|broken)$/.test(x.text)), false);
});

test("RelayClient backstop: a send to the pinned name needs to_member = its own member; @name is refused", async (t) => {
  const w = await world(t);
  const bridge = await agent(t, w.url, w.tokens.me, "me-owner");
  const c = sig.armOwnerBackstop(w.home, new RelayClient({ url: w.url, token: w.tokens.me, name: "me-raw", mode: "send", reconnect: false }));
  t.after(() => c.close());
  await c.start().ready(5000);
  for (const [to, opts] of [["me-owner", {}], ["me-owner", { toMember: BOB }], ["@me-owner", { toMember: ME }]]) {
    await assert.rejects(c.send(to, "unguarded", undefined, undefined, opts), (e) => e.code === "owner_channel_unguarded" && e.kind === "not_sent", `${to} ${JSON.stringify(opts)}`);
  }
  await c.send("me-owner", "guarded", undefined, undefined, { toMember: ME });
  await bridge.waitFor((x) => x.text === "guarded");
  assert.equal(bridge.got.some((x) => x.text === "unguarded"), false);
  // Without a pin for the realm the hook names nothing: unchanged.
  const plain = new RelayClient({ url: w.url, token: w.tokens.me, name: "me-raw2", mode: "send", reconnect: false });
  t.after(() => plain.close());
  await plain.start().ready(5000);
  await plain.send("me-owner", "no hook");
  await bridge.waitFor((x) => x.text === "no hook");
});

test("ownerSendGuard fails closed on any policy failure; only an explicit legacy home has no document", (t) => {
  const home = tmpHome(t);
  sig.trustPin(home, sig.formatPin({ realm: REALM, name: "me-owner", pub: newKey().pub }));
  const client = { realm: { id: REALM }, member: { id: ME }, supportsToMember: () => true };
  const guard = (policy) => sig.ownerSendGuard({ home, client, to: "me-owner", policy });
  const refused = /the contacts cannot be read \(.+\), so the encryption policy cannot be checked; nothing was sent$/;
  for (const policy of [
    () => {
      throw new Error();
    },
    () => {
      throw "unreadable";
    },
    () => {
      throw undefined;
    },
    () => null,
    () => ({}),
    () => ({ problem: "" }),
    () => ({ doc: null }),
    () => ({ doc: null, problem: "x is missing" }),
  ]) {
    assert.throws(() => guard(policy), refused, String(policy));
  }
  assert.deepEqual(guard(() => ({ legacy: true, doc: null })), { toMember: ME });
  assert.deepEqual(guard(() => ({ doc: freshContacts(), problem: null })), { toMember: ME });
  assert.equal(sig.ownerSendGuard({ home, client, to: "me-other", policy: () => null }), null, "other names: not read at all");
});
