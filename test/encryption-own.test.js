// Plaintext between the owner's own sessions under an encryption policy of "required" (design 7.1
// and 7.2, "Encryption policy"): ask_owner and the bridge refuse with encryption_required (at the
// bridge's start and before every relay send, an outbox entry prepared earlier included); a
// member-specific "off" entry for the own member is the explicit override; the receive side keeps
// holding own-member plaintext under "required" (no own-member exception).
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createEngine } from "../lib/engine.js";
import { readSettings } from "../lib/settings.js";
import { RelayClient } from "../lib/client.js";
import { contactsFile, decide, freshContacts, ownEncryptionMode, validateContacts } from "../lib/contacts.js";
import { EXIT_ENCRYPTION_REQUIRED, readAudit, runState, statusLines } from "../lib/ownerchannel.js";
import { telegramCommand } from "../lib/ownerchannelcli.js";
import { linksOf } from "../lib/agentspawn.js";
import * as sig from "../lib/ownersig.js";
import { BOB, BOT_ID, ME, REALM, agent, bridgeOn, fakeTelegram, newKey, ownerRelay, paired, tmpHome, until } from "./owner-helpers.js";
import { existingInstall, sleep } from "./helpers.js";

const textOf = (r) => r.content[0].text;
const REQUIRED = [{ realm: REALM, mode: "required" }];
const OVERRIDE = [{ realm: REALM, mode: "required" }, { realm: REALM, member: ME, mode: "off" }];

/** Write the home's contacts policy atomically (a new file: every reader sees the change). */
function writePolicy(home, encryption, extra = {}) {
  const doc = { ...freshContacts(), revision: Date.now(), grants: [{ realm: REALM, member: ME }], ...extra, ...(encryption ? { encryption } : {}) };
  assert.deepEqual(validateContacts(doc), []);
  const f = contactsFile(home);
  fs.writeFileSync(`${f}.tmp`, JSON.stringify(doc), { mode: 0o600 });
  fs.renameSync(`${f}.tmp`, f);
}

test("the helper: the own member's entry, else the realm's default, else off", () => {
  assert.equal(ownEncryptionMode(null, REALM, ME), "off");
  assert.equal(ownEncryptionMode({ encryption: REQUIRED }, REALM, ME), "required");
  assert.equal(ownEncryptionMode({ encryption: REQUIRED }, REALM, null), "required", "no member known: the realm's default");
  assert.equal(ownEncryptionMode({ encryption: OVERRIDE }, REALM, ME), "off");
  assert.equal(ownEncryptionMode({ encryption: OVERRIDE }, REALM, BOB), "required");
  assert.equal(ownEncryptionMode({ encryption: REQUIRED }, "b".repeat(32), ME), "off");
});

// ---- ask_owner and the receive side -------------------------------------------------------------

async function engineSetup(t) {
  const { url, tokens } = await ownerRelay(t);
  const home = existingInstall(tmpHome(t));
  const key = newKey();
  sig.trustPin(home, sig.formatPin({ realm: REALM, name: "me-owner", pub: key.pub }));
  const settings = readSettings({ env: { HOPTELL_RELAY: url, HOPTELL_TOKEN: tokens.me, HOPTELL_NAME: "me-alice", HOPTELL_HOME: home, HOPTELL_PUSH: "listener", HOPTELL_RECEIPTS: "on", HOPTELL_NOTIFY: "off" }, homedir: "/nonexistent-home", pid: process.pid, hostname: "testhost" });
  const engine = createEngine(settings, { findHost: () => null, keepAlive: true });
  t.after(() => engine.stop());
  engine.start();
  await until(() => engine.session.state === "bound", 4000, "bound");
  const bridge = await agent(t, url, tokens.me, "me-owner");
  const mallory = await agent(t, url, tokens.me, "me-mallory");
  let n = 0;
  const envelope = (text) => sig.signEnvelope({ kind: "answer", realm: REALM, from: "me-owner", to: { name: "me-alice", member: ME }, q: "11111111-2222-4333-8444-555555555555", text, pairing: { id: "p_abcdefghijklmnop", at: 1_700_000_000_000 }, ts: Date.now(), nonce: sig.nonceOf(key, ["upd", "1", ++n]) }, key);
  return { home, engine, bridge, mallory, envelope };
}

async function readAll(engine) {
  const r = textOf(await engine.call("read_inbox"));
  const receipt = r.match(/Receipt: (r_[a-z2-7]{26})/)?.[1];
  if (receipt) await engine.call("ack_messages", { receipt });
  return r;
}

test("ask_owner under required for the own member: still listed, refused with encryption_required, nothing sent; the member's off entry restores it", async (t) => {
  const s = await engineSetup(t);
  // spawn_agent's view of this link carries the scope its checks use (design 7.1).
  const l = linksOf({ links: [{ alias: "local", engine: s.engine }] }).get("local");
  assert.deepEqual([l.wireName, l.realm, l.member], ["me-alice", REALM, ME]);
  writePolicy(s.home, REQUIRED);
  assert.ok((await s.engine.tools()).some((x) => x.name === "ask_owner"), "the tool stays visible");
  const r = await s.engine.call("ask_owner", { question: "Ship it under required?" });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /encryption_required: the owner channel sends plaintext through the relay, and your encryption policy for your own member requires end-to-end encryption; nothing was sent/);
  await sleep(200);
  assert.equal(s.bridge.got.some((m) => /Ship it under required/.test(m.text)), false, "nothing reached the bridge");
  // The explicit override: a member-specific off entry for the own member.
  writePolicy(s.home, OVERRIDE);
  const ok = await s.engine.call("ask_owner", { question: "Ship it with the override?" });
  assert.equal(ok.isError, false, textOf(ok));
  await s.bridge.waitFor((m) => /Ship it with the override/.test(m.text));
  // preferred is not required: sent.
  writePolicy(s.home, [{ realm: REALM, mode: "preferred" }]);
  assert.equal((await s.engine.call("ask_owner", { question: "preferred?" })).isError, false);
});

test("receive side (unchanged): own-member plaintext under required is held as a policy violation, a verified owner answer too; the off entry releases new ones", async (t) => {
  // The verdict itself: no own-member exception.
  const k = { realm: REALM, member: ME, label: "member me" };
  assert.equal(decide({ ...freshContacts(), grants: [{ realm: REALM, member: ME }], encryption: REQUIRED }, k), "policy");
  assert.equal(decide({ ...freshContacts(), grants: [{ realm: REALM, member: ME }], encryption: OVERRIDE }, k), "allow");
  // End to end: granted, so only the encryption policy holds them.
  const s = await engineSetup(t);
  writePolicy(s.home, REQUIRED);
  await s.mallory.client.send("me-alice", "plaintext from my own member");
  await s.bridge.client.send("me-alice", s.envelope("a verified owner answer"));
  await sleep(500);
  const held = await readAll(s.engine);
  assert.equal(/plaintext from my own member|a verified owner answer/.test(held), false, held);
  // hoptell contacts show offers no allow commands that would be refused: only block.
  const { execFileSync } = await import("node:child_process");
  const { BIN } = await import("../lib/config.js");
  fs.writeFileSync(path.join(s.home, "empty.env"), "");
  const cli = (...args) => execFileSync(process.execPath, [BIN, "contacts", ...args], { env: { PATH: process.env.PATH, HOME: s.home, HOPTELL_HOME: s.home, HOPTELL_ENV: path.join(s.home, "empty.env"), HOPTELL_NOTIFY: "off" }, encoding: "utf8" });
  const id = /^(q_[a-z2-7]{16})\s/m.exec(cli("list"))?.[1];
  assert.ok(id);
  const shown = cli("show", id);
  assert.match(shown, /unencrypted, and this contact's encryption is required: they can only be blocked, or released after you set this contact's encryption to preferred or off \(hoptell contacts encryption m_\S+ preferred\)/);
  assert.match(shown, /hoptell contacts block /);
  assert.doesNotMatch(shown, /hoptell contacts allow/);
  writePolicy(s.home, OVERRIDE);
  await s.mallory.client.send("me-alice", "after the override");
  let seen = "";
  await until(async () => (seen += await readAll(s.engine)).includes("after the override"), 4000, "shown");
});

// ---- the bridge ------------------------------------------------------------------------------

test("the bridge does not start under required for its own member (audited); the member's off entry lets it lead", async (t) => {
  const { url, tokens } = await ownerRelay(t);
  const home = tmpHome(t);
  paired(home);
  writePolicy(home, REQUIRED);
  const tg = fakeTelegram();
  const key = newKey();
  const a = bridgeOn(t, { home, telegram: tg.client("a"), url, token: tokens.me, key });
  const r = await a.run;
  assert.equal(r.code, "encryption_required");
  assert.match(r.message, /requires end-to-end encryption.*does not run/);
  assert.ok(readAudit(home).some((e) => e.event === "refused" && e.reason === "encryption_required"));
  writePolicy(home, OVERRIDE);
  const b = bridgeOn(t, { home, telegram: tg.client("b"), url, token: tokens.me, key });
  await until(() => b.bridge.leading(), 4000, "leader with the override");
});

/** A relay client whose sends fail (not refused: retried later) while `hold.on`. */
const holdingFactory = (hold) => (o) => {
  const c = new RelayClient(o);
  const send = c.send.bind(c);
  c.send = async (...a) => {
    if (hold.on) {
      hold.tried++;
      throw new Error("test: the relay did not answer"); // at once: no pause of its own
    }
    return send(...a);
  };
  return c;
};

test("an outbox send prepared before the policy became required: refused for good (encryption_required), audited, the owner told; statuses: one notice", async (t) => {
  const { url, tokens } = await ownerRelay(t);
  const home = tmpHome(t);
  paired(home);
  writePolicy(home, null); // managed, no encryption policy: the bridge runs
  const tg = fakeTelegram();
  const key = newKey();
  const hold = { on: false, tried: 0 };
  let offset = 0;
  const { bridge } = bridgeOn(t, { home, telegram: tg.client(), url, token: tokens.me, key, clientFactory: holdingFactory(hold), now: () => Date.now() + offset });
  await until(() => bridge.leading(), 4000, "leader");
  const alice = await agent(t, url, tokens.me, "me-alice");
  const q = await alice.ask("Prepared answer?", { choices: ["yes", "no"] });
  await until(() => tg.cards().length === 1, 4000, "card");
  // The answer's send is prepared (in the outbox) but the relay does not take it yet.
  hold.on = true;
  tg.press(tg.cards()[0], 0);
  await until(() => hold.tried > 0 && bridge.state().outbox.some((e) => e.steps.some((x) => x.t === "send" && x.kind === "answer")), 4000, "the answer waits in the outbox");
  writePolicy(home, REQUIRED);
  hold.on = false;
  await until(() => bridge.state().outbox.length === 0, 4000, "the entry ended");
  const s = bridge.state();
  assert.equal(s.questions[q].status, "undelivered");
  assert.ok(readAudit(home).some((e) => e.event === "refused" && e.reason === "encryption_required" && e.kind === "answer" && e.q === q));
  await sleep(200);
  assert.equal(alice.got.some((m) => m.from === "me-owner" && JSON.parse(m.text).kind === "answer"), false, "nothing sent");
  const told = () => tg.sent.filter((x) => x.method !== "editMessageText" && /require end-to-end encryption/.test(x.params.text ?? "")); // (the closed card names the reason too)
  assert.equal(told().length, 1, "the owner was told once");
  // Two questions that expire: their statuses are refused too; one general notice for both.
  const q2 = await alice.ask("Expiring one?");
  const q3 = await alice.ask("Expiring two?");
  await until(() => tg.cards().length === 3, 4000, "cards");
  offset = 2 * 3600_000;
  await bridge.tick();
  await until(() => bridge.state().outbox.length === 0, 4000, "statuses ended");
  assert.deepEqual([q2, q3].map((x) => bridge.state().questions[x].status), ["expired", "expired"]);
  assert.equal(readAudit(home).filter((e) => e.event === "refused" && e.reason === "encryption_required" && e.kind === "status").length, 2);
  assert.equal(told().length, 2, "one more notice, for both statuses");
  assert.match(told()[1].params.text, /^⚠️ Messages to your agents are paused: .*Run hoptell telegram status on the bot's computer for details\.$/);
  assert.equal(alice.got.filter((m) => m.from === "me-owner").length, 0, "no status was sent either");
});

test("a send that fails at once is retried at retryMs, not in a loop (the unconfirmed update waits before the next poll); it recovers once the send works", async (t) => {
  const { url, tokens } = await ownerRelay(t);
  const home = tmpHome(t);
  paired(home);
  const tg = fakeTelegram();
  const hold = { on: false, tried: 0 };
  const retryMs = 200;
  const { bridge } = bridgeOn(t, { home, telegram: tg.client(), url, token: tokens.me, key: newKey(), clientFactory: holdingFactory(hold), retryMs });
  await until(() => bridge.leading(), 4000, "leader");
  const alice = await agent(t, url, tokens.me, "me-alice");
  const q = await alice.ask("Instant failure?", { choices: ["yes", "no"] });
  await until(() => tg.cards().length === 1, 4000, "card");
  hold.on = true;
  const polls0 = tg.getUpdatesCalls;
  tg.press(tg.cards()[0], 0);
  await until(() => hold.tried > 0, 4000, "first attempt");
  const t0 = Date.now();
  const tried0 = hold.tried;
  await sleep(1000);
  const window = Date.now() - t0;
  // At most two attempts per retryMs (the poll's and the scheduled retry's), plus slack.
  const bound = Math.ceil(window / retryMs) * 2 + 2;
  assert.ok(hold.tried - tried0 <= bound, `${hold.tried - tried0} attempts in ${window} ms (bound ${bound})`);
  assert.ok(tg.getUpdatesCalls - polls0 <= bound, `${tg.getUpdatesCalls - polls0} polls in about ${window} ms (bound ${bound})`);
  assert.ok(hold.tried - tried0 >= 2, "still retried");
  // The relay takes it now: the answer goes out once, the question closes.
  hold.on = false;
  const m = await alice.waitFor((x) => x.from === "me-owner" && JSON.parse(x.text).kind === "answer", 4000);
  assert.equal(JSON.parse(m.text).q, q);
  await until(() => bridge.state().outbox.length === 0, 4000, "the entry ended");
  assert.equal(bridge.state().questions[q].status, "answered");
});

test("hoptell telegram run under required: exit code 78 (do not restart), the reason shown at warning level in status", async (t) => {
  const { url, tokens } = await ownerRelay(t);
  const home = tmpHome(t);
  const tg = fakeTelegram();
  const items = new Map();
  const keychain = { items, kind: "test keychain", available: () => true, set: (a, v) => (items.set(a, v), true), get: (a) => items.get(a) ?? null, remove: (a) => items.delete(a) };
  const relays = `${home}/relays.json`;
  fs.writeFileSync(relays, JSON.stringify({ version: 1, relays: [{ alias: "local", url, tokenEnv: "ME_TOKEN", namePrefix: "me-" }] }), { mode: 0o600 });
  const lines = [];
  const cli = (argv, extra = {}) => telegramCommand(argv, { home, env: { HOPTELL_RELAYS: relays, ME_TOKEN: tokens.me, HOPTELL_HOME: home }, out: (x) => lines.push(`OUT ${x}`), err: (x) => lines.push(`ERR ${x}`), telegramFactory: () => tg.client("cli"), keychainBackend: keychain, signals: false, pollTimeout: 1, ...extra });
  assert.equal(await cli(["setup"], { stdin: `${BOT_ID}:${crypto.randomBytes(26).toString("base64url")}\n` }), 0, lines.join("\n"));
  writePolicy(home, REQUIRED);
  assert.equal(EXIT_ENCRYPTION_REQUIRED, 78);
  assert.equal(await cli(["run"]), 78, lines.join("\n"));
  assert.match(lines.join("\n"), /ERR hoptell telegram run: encryption_required: .*\nERR hoptell telegram run: exit code 78; a service manager should not restart the bridge on this code/);
  assert.match(runState(home), /^stopped: your encryption policy for your own member requires end-to-end encryption/);
  const run = statusLines(home).find((l) => l.what === "owner channel run");
  assert.equal(run.level, "warn");
  assert.match(run.detail, /explicit off entry for your own member/);
});

test("reconnect-halt: a bridge leading under off halts at its next relay reconnect after the policy flips to required (encryption_required, audited), and sends nothing in plaintext after the flip", async (t) => {
  const { url, tokens } = await ownerRelay(t);
  const home = tmpHome(t);
  paired(home);
  writePolicy(home, null);
  const tg = fakeTelegram();
  const { bridge, run } = bridgeOn(t, { home, telegram: tg.client(), url, token: tokens.me, key: newKey() });
  await until(() => bridge.leading(), 4000, "leader under off");
  const alice = await agent(t, url, tokens.me, "me-alice");
  const q = await alice.ask("Before the flip?", { choices: ["yes", "no"] });
  await until(() => tg.cards().length === 1, 4000, "card");
  writePolicy(home, REQUIRED);
  const flipped = alice.got.length;
  // The owner answers after the flip: refused, not sent.
  tg.press(tg.cards()[0], 0);
  await until(() => bridge.state().questions[q].status === "undelivered", 4000, "answer refused");
  // The connection drops; on the reconnect the bridge checks the policy again and halts.
  bridge.relay.ws.terminate();
  const r = await Promise.race([run, sleep(15_000).then(() => ({ code: "no halt within 15 s" }))]);
  assert.equal(r.code, "encryption_required");
  assert.equal(readAudit(home).filter((e) => e.event === "refused" && e.reason === "encryption_required" && e.kind === undefined).length, 1, "the halt is audited");
  assert.match(runState(home), /^stopped: your encryption policy/);
  await sleep(200);
  assert.deepEqual(alice.got.slice(flipped).filter((m) => m.from === "me-owner"), [], "nothing sent in plaintext after the flip");
});
