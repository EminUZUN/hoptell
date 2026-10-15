// Outgoing sends fail closed when a managed contacts policy cannot be read (design 3.3): a missing,
// unreadable or invalid contacts.json never turns a "required" contact into plaintext. send_message
// and send_file (engine), `hoptell send`, the bridge's answers and spawned runs' results all refuse
// (the bridge waits instead) with a message naming the file; a legacy-allow home has no policy and
// sends as before.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { contactsFile, filePolicy, freshContacts, homeManaged, homeSendPolicy, sendPolicy, validateContacts } from "../lib/contacts.js";
import { createEngine } from "../lib/engine.js";
import { createComposer } from "../lib/composer.js";
import { readRelaysFile } from "../lib/relays.js";
import { readSettings } from "../lib/settings.js";
import { readAudit } from "../lib/ownerchannel.js";
import { BIN } from "../lib/config.js";
import { BOB, ME, REALM, agent, bridgeOn, fakeTelegram, newKey, ownerRelay, paired, tmpHome, until } from "./owner-helpers.js";
import { existingInstall, sleep } from "./helpers.js";

const textOf = (r) => r.content[0].text;
const REFUSED = /the contacts cannot be read \(.*contacts\.json is not valid JSON\), so the encryption policy cannot be checked; nothing was sent/;

function writePolicy(home, encryption) {
  const doc = { ...freshContacts(), revision: Date.now(), grants: [{ realm: REALM, member: ME }, { realm: REALM, member: BOB }], ...(encryption ? { encryption } : {}) };
  assert.deepEqual(validateContacts(doc), []);
  const f = contactsFile(home);
  fs.writeFileSync(`${f}.tmp`, JSON.stringify(doc), { mode: 0o600 });
  fs.renameSync(`${f}.tmp`, f);
}
const corrupt = (home) => fs.writeFileSync(contactsFile(home), "{invalid JSON", { mode: 0o600 });

test("the helpers: legacy has no policy; a managed home needs a valid file; a damaged marker counts as managed", (t) => {
  assert.deepEqual(sendPolicy({ doc: null, legacy: true }), { doc: null, refuse: null });
  const doc = freshContacts();
  assert.deepEqual(sendPolicy({ doc, problem: null }), { doc, refuse: null });
  for (const current of [null, { doc: null, problem: "/h/contacts.json is not valid JSON" }, { doc: null, problem: null }, { doc, problem: "/h/contacts.json is missing" }]) {
    const p = sendPolicy(current);
    assert.equal(p.doc, null);
    assert.match(p.refuse, /^the contacts cannot be read \(.+\), so the encryption policy cannot be checked; nothing was sent$/, JSON.stringify(current));
  }
  assert.deepEqual(filePolicy({ managed: false, read: { doc: null, problem: "x is missing" } }), { doc: null, refuse: null });
  assert.match(filePolicy({ managed: true, read: { doc: null, problem: "x is missing" } }).refuse, /x is missing/);

  const home = tmpHome(t);
  assert.equal(homeManaged(home), false, "nothing yet: not managed");
  assert.equal(homeSendPolicy(home).refuse, null);
  fs.mkdirSync(path.join(home, "contacts"), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(home, "contacts", "state.json"), JSON.stringify({ v: 1, mode: "legacy-allow" }));
  assert.equal(homeManaged(home), false);
  fs.writeFileSync(path.join(home, "contacts", "state.json"), JSON.stringify({ v: 1, mode: "managed" }));
  assert.equal(homeManaged(home), true);
  assert.match(homeSendPolicy(home).refuse, /contacts\.json is missing/, "managed, file deleted: refused");
  fs.writeFileSync(path.join(home, "contacts", "state.json"), "{damaged");
  assert.equal(homeManaged(home), true, "a damaged marker fails closed");
  writePolicy(home, null);
  assert.equal(homeSendPolicy(home).refuse, null);
  corrupt(home);
  assert.match(homeSendPolicy(home).refuse, /contacts\.json is not valid JSON/);

  // Policy and marker both lost, a managed session store remains: still managed (as at startup).
  const w = tmpHome(t);
  const store = path.join(w, "v2", REALM, ME, "s");
  fs.mkdirSync(store, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(store, "store.json"), JSON.stringify({ v: 1, storage: 2, receipts: "on", gen: 0, contacts: "managed" }));
  assert.equal(homeManaged(w), true);
  assert.match(homeSendPolicy(w).refuse, /contacts\.json is missing/);
  fs.writeFileSync(path.join(store, "store.json"), JSON.stringify({ v: 1, storage: 2, receipts: "on", gen: 0 }));
  assert.equal(homeManaged(w), false, "a store without the mark is no witness");
  fs.writeFileSync(path.join(store, "store.json"), "{damaged");
  assert.equal(homeManaged(w), true, "a store that cannot be read fails closed");
  const l = tmpHome(t);
  fs.mkdirSync(path.join(l, "legacy", "s"), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(l, "legacy", "s", "store.json"), JSON.stringify({ v: 1, contacts: "managed" }));
  assert.equal(homeManaged(l), true, "a protocol-1 store is a witness too");
});

async function engineWorld(t, { legacy = false } = {}) {
  const r = await ownerRelay(t);
  const home = existingInstall(tmpHome(t));
  if (!legacy) writePolicy(home, [{ realm: REALM, member: BOB, mode: "required" }]);
  const settings = readSettings({ env: { HOPTELL_RELAY: r.url, HOPTELL_TOKEN: r.tokens.me, HOPTELL_NAME: "me-alice", HOPTELL_HOME: home, HOPTELL_PUSH: "listener", HOPTELL_RECEIPTS: "on", HOPTELL_NOTIFY: "off", HOPTELL_SNAPSHOT_ROOTS: JSON.stringify([{ id: "app", path: home }]) }, homedir: "/nonexistent-home", pid: process.pid, hostname: "testhost" });
  const e = createEngine(settings, { findHost: () => null, keepAlive: true });
  t.after(() => e.stop());
  e.start();
  await until(() => e.session.state === "bound", 4000, "bound");
  const bob = await agent(t, r.url, r.tokens.bob, "bob-probe");
  return { ...r, home, e, bob };
}

test("send_message and send_file: a corrupt managed policy refuses every send, naming the file; nothing reaches the peer", async (t) => {
  const w = await engineWorld(t);
  const before = await w.e.call("send_message", { to: "bob-probe", message: "under required" });
  assert.equal(before.isError, true, "required: refused (no encryption here)");
  corrupt(w.home);
  const r = await w.e.call("send_message", { to: "bob-probe", message: "plaintext-after-corruption" });
  assert.equal(r.isError, true, textOf(r));
  assert.match(textOf(r), REFUSED);
  const all = await w.e.call("send_message", { to: "@all", message: "fanout-after-corruption" });
  assert.equal(all.isError, true, textOf(all));
  assert.match(textOf(all), REFUSED);
  const f = path.join(w.home, "note.txt");
  fs.writeFileSync(f, "file body");
  const file = await w.e.call("send_file", { to: "bob-probe", root_id: "app", path: "note.txt", request: "look" });
  assert.equal(file.isError, true, textOf(file));
  assert.match(textOf(file), REFUSED);
  fs.rmSync(contactsFile(w.home));
  const missing = await w.e.call("send_message", { to: "bob-probe", message: "plaintext-after-deletion" });
  assert.equal(missing.isError, true, textOf(missing));
  assert.match(textOf(missing), /the contacts cannot be read \(.*contacts\.json is missing\), so the encryption policy cannot be checked; nothing was sent/);
  await sleep(200);
  assert.deepEqual(w.bob.got.map((m) => m.text), []);
  // Fixed: sends follow the policy again (bob has no entry now: plaintext).
  writePolicy(w.home, null);
  const ok = await w.e.call("send_message", { to: "bob-probe", message: "readable again" });
  assert.equal(ok.isError, false, textOf(ok));
  await w.bob.waitFor((m) => m.text === "readable again");
});

test("a legacy-allow home (no managed policy) sends as before", async (t) => {
  const w = await engineWorld(t, { legacy: true });
  assert.equal(fs.existsSync(contactsFile(w.home)), false);
  const r = await w.e.call("send_message", { to: "bob-probe", message: "legacy send" });
  assert.equal(r.isError, false, textOf(r));
  await w.bob.waitFor((m) => m.text === "legacy send");
});

test("hoptell send: a corrupt managed policy exits non-zero naming the file; nothing is sent", async (t) => {
  const r = await ownerRelay(t);
  const home = existingInstall(tmpHome(t));
  writePolicy(home, [{ realm: REALM, member: BOB, mode: "required" }]);
  const bob = await agent(t, r.url, r.tokens.bob, "bob-probe");
  const cli = (args) => new Promise((resolve) => execFile(process.execPath, [BIN, ...args], { env: { PATH: process.env.PATH, HOME: home, HOPTELL_HOME: home, HOPTELL_RELAY: r.url, HOPTELL_TOKEN: r.tokens.me, HOPTELL_NAME: "me-cli", HOPTELL_NOTIFY: "off" } }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr })));
  assert.notEqual((await cli(["send", "bob-probe", "before"])).code, 0, "required: refused");
  corrupt(home);
  const after = await cli(["send", "bob-probe", "plaintext-after-corruption"]);
  assert.notEqual(after.code, 0, after.stdout);
  assert.match(after.stderr, REFUSED);
  await sleep(200);
  assert.deepEqual(bob.got.map((m) => m.text), []);
});

test("the bridge: an answer waits while the policy is unreadable (never sent, never refused for good) and goes once it is fixed", async (t) => {
  const { url, tokens } = await ownerRelay(t);
  const home = tmpHome(t);
  paired(home);
  writePolicy(home, null);
  const tg = fakeTelegram();
  const logs = [];
  const { bridge } = bridgeOn(t, { home, telegram: tg.client(), url, token: tokens.me, key: newKey(), log: (s) => logs.push(s) });
  await until(() => bridge.leading(), 4000, "leader");
  const alice = await agent(t, url, tokens.me, "me-alice");
  const q = await alice.ask("Ship it?", { choices: ["yes", "no"] });
  await until(() => tg.cards().length === 1, 4000, "card");
  corrupt(home);
  tg.press(tg.cards()[0], 0);
  await until(() => logs.some((s) => /owner channel: the contacts cannot be read \(.*contacts\.json is not valid JSON\).*answers wait until it is fixed/.test(s)), 4000, "logged");
  await sleep(300);
  assert.equal(alice.got.some((m) => m.from === "me-owner" && /"kind":"answer"/.test(m.text)), false, "nothing sent");
  assert.ok(bridge.state().outbox.some((e) => e.steps.some((x) => x.t === "send" && x.kind === "answer")), "the answer still waits");
  assert.equal(readAudit(home).some((e) => e.event === "refused" && e.q === q), false, "not refused for good");
  writePolicy(home, null);
  await bridge.tick();
  await until(() => alice.got.some((m) => m.from === "me-owner" && /"kind":"answer"/.test(m.text)), 4000, "answer sent");
});

test("the composer's send to a relay it has not joined: the encryption policy applies, failing closed on a corrupt file", async (t) => {
  const r = await ownerRelay(t);
  const home = existingInstall(tmpHome(t));
  writePolicy(home, [{ realm: REALM, member: BOB, mode: "required" }]);
  const file = path.join(home, "relays.json");
  fs.writeFileSync(file, JSON.stringify({ version: 1, default: "local", relays: [{ alias: "local", url: r.url, tokenEnv: "T_LOCAL", join: false }] }), { mode: 0o600 });
  const env = { HOPTELL_HOME: home, HOPTELL_NAME: "me-comp", HOPTELL_PUSH: "listener", HOPTELL_RECEIPTS: "on", HOPTELL_NOTIFY: "off", HOPTELL_RELAYS: file, T_LOCAL: r.tokens.me };
  const settings = readSettings({ env, homedir: "/nonexistent-home", pid: process.pid, hostname: "testhost" });
  const c = createComposer(settings, readRelaysFile(file, { env, homedir: "/nonexistent-home" }), { keepAlive: true });
  t.after(() => c.stop());
  await c.start();
  const bob = await agent(t, r.url, r.tokens.bob, "bob-probe");
  const req = await c.call("send_message", { to: "bob-probe@local", message: "under required" });
  assert.equal(req.isError, true, textOf(req));
  assert.match(textOf(req), /cannot tell whether bob-probe is one of them|encryption is required for bob-probe/);
  corrupt(home);
  const broken = await c.call("send_message", { to: "bob-probe@local", message: "plaintext-after-corruption" });
  assert.equal(broken.isError, true, textOf(broken));
  assert.match(textOf(broken), REFUSED);
  await sleep(200);
  assert.deepEqual(bob.got.map((m) => m.text), []);
  writePolicy(home, null);
  const ok = await c.call("send_message", { to: "bob-probe@local", message: "no policy" });
  assert.equal(ok.isError, false, textOf(ok));
  await bob.waitFor((m) => m.text === "no policy");
});

test("the bridge: managed stays managed in a running bridge; with policy and marker deleted, an answer waits", async (t) => {
  const { url, tokens } = await ownerRelay(t);
  const home = tmpHome(t);
  paired(home);
  writePolicy(home, null);
  const tg = fakeTelegram();
  const { bridge } = bridgeOn(t, { home, telegram: tg.client(), url, token: tokens.me, key: newKey() });
  await until(() => bridge.leading(), 4000, "leader");
  const alice = await agent(t, url, tokens.me, "me-alice");
  const first = await alice.ask("First?", { choices: ["yes", "no"] });
  await until(() => tg.cards().length === 1, 4000, "card");
  tg.press(tg.cards()[0], 0);
  await until(() => alice.got.some((m) => m.from === "me-owner" && m.reply_to === first), 4000, "first answer sent");
  // Both the policy and the marker go: this bridge already saw the home managed.
  fs.rmSync(contactsFile(home));
  fs.rmSync(path.join(home, "contacts", "state.json"), { force: true });
  const q = await alice.ask("Second?", { choices: ["yes", "no"] });
  await until(() => tg.cards().length === 2, 4000, "card");
  tg.press(tg.cards()[1], 0);
  await sleep(500);
  assert.equal(alice.got.some((m) => m.from === "me-owner" && m.reply_to === q && /"kind":"answer"/.test(m.text)), false, "nothing sent");
  writePolicy(home, null);
  await bridge.tick();
  await until(() => alice.got.some((m) => m.from === "me-owner" && m.reply_to === q && /"kind":"answer"/.test(m.text)), 4000, "sent once the policy is back");
});

test("sessionE2ee's plan (send_message, send_transfer): a policy that cannot be read refuses, with its reason", async (t) => {
  const { sessionE2ee } = await import("../lib/mls/session.js");
  let current = { doc: null, problem: "/h/contacts.json is not valid JSON" };
  const relay = { realm: { id: REALM }, caps: [], rpc: async () => ({ member: BOB }), list: async () => [] };
  const s = sessionE2ee({ env: {}, home: tmpHome(t), profile: null, relay, contacts: { currentPolicy: () => current }, deliver: () => {} });
  const p = await s.plan("bob-probe");
  assert.equal(p.encrypt, false);
  assert.match(p.refuse, /^the contacts cannot be read \(\/h\/contacts\.json is not valid JSON\), so the encryption policy cannot be checked; nothing was sent$/);
  current = { doc: freshContacts(), problem: null };
  assert.equal((await s.plan("bob-probe")).refuse, null, "a readable policy without entries: no refusal");
  current = { doc: null, legacy: true };
  assert.equal((await s.plan("bob-probe")).refuse, null, "legacy: no policy");
});
