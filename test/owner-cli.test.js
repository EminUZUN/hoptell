// `hoptell telegram ...` (lib/ownerchannelcli.js, design 7.2): the token from standard input only,
// the credential store, the pin, pairing codes, trust, staged key rotation, run, status, unpair,
// and that nothing printed (doctor included) holds a token, chat id, private key or text.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { telegramCommand } from "../lib/ownerchannelcli.js";
import { readBridgeConfig, readPairing, readRun, runState } from "../lib/ownerchannel.js";
import { processIdentity } from "../lib/host.js";
import { doctor } from "../lib/doctor.js";
import * as sig from "../lib/ownersig.js";
import { BOT_ID, ME, OWNER_CHAT, REALM, agent, fakeTelegram, ownerRelay, paired, tmpHome, until } from "./owner-helpers.js";
import { sleep } from "./helpers.js";

const TOKEN = `${BOT_ID}:${crypto.randomBytes(26).toString("base64url")}`;
const SECRET = TOKEN.split(":")[1];

function fakeKeychain() {
  const items = new Map();
  return { items, kind: "test keychain", available: () => true, set: (a, v) => (items.set(a, v), true), get: (a) => items.get(a) ?? null, remove: (a) => items.delete(a) };
}

async function setup(t, { webhook = "" } = {}) {
  const { url, tokens } = await ownerRelay(t);
  const home = tmpHome(t);
  const tg = fakeTelegram({ webhook });
  const keychain = fakeKeychain();
  const lines = [];
  // As the local relay's entry: one member "me" whose names start with "me-".
  const relays = path.join(home, "relays.json");
  fs.writeFileSync(relays, JSON.stringify({ version: 1, relays: [{ alias: "local", url, tokenEnv: "ME_TOKEN", namePrefix: "me-" }] }), { mode: 0o600 });
  const env = { HOPTELL_RELAYS: relays, ME_TOKEN: tokens.me, HOPTELL_HOME: home };
  const factories = [];
  const cli = (argv, extra = {}) =>
    telegramCommand(argv, {
      home,
      env,
      out: (s) => lines.push(`OUT ${s}`),
      err: (s) => lines.push(`ERR ${s}`),
      telegramFactory: (tok) => {
        factories.push(tok);
        return tg.client("cli");
      },
      keychainBackend: keychain,
      signals: false,
      pollTimeout: 1,
      drainMs: 3000,
      ...extra,
    });
  return { url, tokens, home, tg, keychain, lines, cli, env, factories, printed: () => lines.join("\n") };
}

test("setup: the token from standard input only, stored with the key in the credential store; the pin is printed and trusted here", async (t) => {
  const s = await setup(t);
  assert.equal(await s.cli(["setup"], { stdin: `${TOKEN}\n` }), 0, s.printed());
  const b = readBridgeConfig(s.home);
  assert.deepEqual([b.bot_id, b.username, b.alias, b.wire, b.realm, b.member], [BOT_ID, "owner_test_bot", "local", "me-owner", REALM, ME]);
  assert.deepEqual(JSON.parse(s.keychain.items.get(`telegram-bot-${BOT_ID}`)), { token: TOKEN });
  const key = JSON.parse(s.keychain.items.get(`owner-channel-key-${BOT_ID}`)).current;
  assert.equal(key.pub, b.key.pub);
  assert.equal(JSON.stringify(b).includes(key.priv), false, "no private key in bridge.json");
  const pin = s.printed().match(/hoptell telegram trust '([^']+)'/)[1];
  assert.deepEqual(sig.parsePin(pin), { realm: REALM, name: "me-owner", pub: key.pub, keyId: b.key.id });
  assert.ok(sig.pinFor(s.home, REALM), "trusted for its own home");
  assert.equal(s.printed().includes(SECRET), false);
  assert.equal(s.printed().includes(key.priv), false);
  assert.equal(fs.statSync(sig.channelPaths(s.home).bridge).mode & 0o777, 0o600);
  // Not a token on standard input: refused. No argument or environment variable is read for it.
  assert.equal(await s.cli(["setup", TOKEN], { stdin: "" }), 1);
  assert.equal(await s.cli(["setup"], { stdin: "", env: { ...s.env, HOPTELL_TELEGRAM_TOKEN: TOKEN, TELEGRAM_BOT_TOKEN: TOKEN } }), 1);
  assert.match(s.printed(), /standard input does not hold a bot token/);
});

test("setup: a bridge name the member token may not use says how to pick one", async (t) => {
  const s = await setup(t);
  const relays = path.join(s.home, "relays.json");
  fs.writeFileSync(relays, JSON.stringify({ version: 1, relays: [{ alias: "local", url: s.url, tokenEnv: "ME_TOKEN" }] }), { mode: 0o600 });
  assert.equal(await s.cli(["setup"], { stdin: TOKEN }), 1);
  assert.match(s.printed(), /ERR hoptell telegram: the relay refused the bridge name owner: the bridge needs a member token, which may use only "<member>" or names that start with "<member>-"; e\.g\. hoptell telegram setup --name <member>-owner \(4002\)$/m);
  assert.equal(readBridgeConfig(s.home), null);
  // A wrong namePrefix in the relay entry comes first in the name: that is where it is fixed.
  fs.writeFileSync(relays, JSON.stringify({ version: 1, relays: [{ alias: "local", url: s.url, tokenEnv: "ME_TOKEN", namePrefix: "old-" }] }), { mode: 0o600 });
  assert.equal(await s.cli(["setup", "--name", "me-owner"], { stdin: TOKEN }), 1);
  assert.match(s.printed(), /ERR hoptell telegram: the relay refused the bridge name old-me-owner: the bridge needs a member token, which may use only "<member>" or names that start with "<member>-"; set namePrefix to "<member>-" in relay entry "local" \(4002\)$/m);
  // An existing bridge keeps its name: then only the rule is given.
  fs.writeFileSync(relays, JSON.stringify({ version: 1, relays: [{ alias: "local", url: s.url, tokenEnv: "ME_TOKEN", namePrefix: "me-" }] }), { mode: 0o600 });
  assert.equal(await s.cli(["setup"], { stdin: TOKEN }), 0, s.printed());
  assert.equal(await s.cli(["setup"], { stdin: TOKEN, env: { ...s.env, ME_TOKEN: s.tokens.bob } }), 1);
  assert.match(s.printed(), /ERR hoptell telegram: the relay refused the bridge name me-owner: the bridge needs a member token, which may use only "<member>" or names that start with "<member>-" \(4002\)$/m);
});

test("setup: a webhook stops it; a new token for the same bot replaces it, keeping key and pins; another bot needs unpair --all", async (t) => {
  const hooked = await setup(t, { webhook: "https://example.invalid/x" });
  assert.equal(await hooked.cli(["setup"], { stdin: TOKEN }), 1);
  assert.match(hooked.printed(), /webhook is set .* never deletes it/);
  assert.equal(readBridgeConfig(hooked.home), null);
  const s = await setup(t);
  await s.cli(["setup"], { stdin: TOKEN });
  const before = readBridgeConfig(s.home);
  const rotated = `${BOT_ID}:${crypto.randomBytes(26).toString("base64url")}`;
  assert.equal(await s.cli(["setup"], { stdin: rotated }), 0, s.printed());
  assert.match(s.printed(), /was replaced\. The pairing, state, signing key and every pin stay valid/);
  assert.deepEqual(readBridgeConfig(s.home).key, before.key);
  assert.deepEqual(JSON.parse(s.keychain.items.get(`telegram-bot-${BOT_ID}`)), { token: rotated });
  assert.equal(s.printed().includes(rotated.split(":")[1]), false);
  const other = `7000002:${crypto.randomBytes(26).toString("base64url")}`;
  assert.equal(await s.cli(["setup"], { stdin: other }), 1);
  assert.match(s.printed(), /getMe does not describe|another bot/);
});

test("pair, trust on another home, status, and doctor: nothing secret is printed", async (t) => {
  const s = await setup(t);
  await s.cli(["setup"], { stdin: TOKEN });
  const pin = s.printed().match(/hoptell telegram trust '([^']+)'/)[1];
  // Not paired yet: status says how the owner pairs, and that the bridge must run for it.
  await s.cli(["status"]);
  assert.match(s.printed(), /owner channel bridge: bot @owner_test_bot for local\/me-owner; not paired: get a code with hoptell telegram pair and send \/start <code> to @owner_test_bot; the bridge \(hoptell telegram run\) must be running to accept it/);
  assert.equal(await s.cli(["pair"]), 0);
  const code = s.printed().match(/\/start ([A-Z2-7]{8})/)[1];
  assert.ok(readPairing(s.home).pending);
  await s.cli(["status"]);
  assert.match(s.printed(), /not paired: a pairing code is waiting for the owner to send \/start <code> to @owner_test_bot; the bridge \(hoptell telegram run\) must be running to accept it/);
  assert.match(s.printed(), new RegExp(`https://t\\.me/owner_test_bot\\?start=${code}`));
  // Another agent machine.
  const other = tmpHome(t);
  const o = await telegramCommand(["trust", pin], { home: other, env: {}, out: (x) => s.lines.push(`OUT ${x}`), err: (x) => s.lines.push(`ERR ${x}`) });
  assert.equal(o, 0);
  assert.ok(sig.pinFor(other, REALM));
  assert.equal(await telegramCommand(["trust", "not a pin"], { home: other, env: {}, out: () => {}, err: () => {} }), 1);
  // A paired home with an open question: status and doctor show state, never secrets or text.
  paired(s.home);
  sig.writePrivateJson(sig.channelPaths(s.home).state, { v: 1, bot_id: BOT_ID, offset: 9, questions: { q: { status: "open", asker: { name: "x" }, payload: { question: "SECRET QUESTION TEXT", choices: [] } } }, outbox: [], recent: [], drops: { foreign_message: 2 } });
  await s.cli(["status"]);
  const lines = [];
  await doctor({ ...s.env, HOPTELL_ENV: path.join(s.home, "none.env") }, (l) => lines.push(l), { homedir: s.home });
  const all = `${s.printed()}\n${lines.join("\n")}`;
  assert.match(lines.join("\n"), /owner channel pin: bridge me-owner on realm aaaaaaaa…, 1 key trusted/);
  assert.match(lines.join("\n"), /owner channel bridge: bot @owner_test_bot for local\/me-owner; paired since/);
  assert.match(lines.join("\n"), /owner channel questions: 1 open; 0 pending actions; dropped: foreign_message 2/);
  const key = JSON.parse(s.keychain.items.get(`owner-channel-key-${BOT_ID}`)).current;
  for (const secret of [SECRET, key.priv, "SECRET QUESTION TEXT"]) assert.equal(all.includes(secret), false, secret.slice(0, 6));
  assert.equal(lines.join("\n").includes(String(OWNER_CHAT)), false, "no chat id in doctor");
});

test("run: leader while running, status says so; stop gives the name back", async (t) => {
  const s = await setup(t);
  await s.cli(["setup"], { stdin: TOKEN });
  paired(s.home);
  let bridge = null;
  const running = s.cli(["run"], { onBridge: (b) => (bridge = b) });
  await until(() => bridge?.leading(), 6000, "leader");
  s.lines.length = 0;
  await s.cli(["status"]);
  assert.match(s.printed(), /bridge: local\/me-owner for bot @owner_test_bot; leader/);
  // A second run on the same home exits.
  assert.equal(await s.cli(["run"]), 1);
  assert.match(s.printed(), /another hoptell telegram run uses this home/);
  // key next refuses while the bridge runs.
  assert.equal(await s.cli(["key", "next"]), 1);
  assert.match(s.printed(), /the bridge is running/);
  await bridge.stop();
  assert.equal(await running, 0);
  s.lines.length = 0;
  await s.cli(["status"]);
  assert.match(s.printed(), /; not running/);
  const again = await agent(t, s.url, s.tokens.me, "me-owner");
  assert.equal(again.client.name, "me-owner", "the name was given back");
});

test("staged key rotation: key next, trust --add, key commit; the bridge signs with the new key from its next run", async (t) => {
  const s = await setup(t);
  await s.cli(["setup"], { stdin: TOKEN });
  paired(s.home);
  const agentHome = tmpHome(t);
  const first = s.printed().match(/hoptell telegram trust '([^']+)'/)[1];
  await telegramCommand(["trust", first], { home: agentHome, env: {}, out: () => {}, err: () => {} });
  s.lines.length = 0;
  assert.equal(await s.cli(["key", "next"]), 0, s.printed());
  const nextPin = s.printed().match(/trust --add '([^']+)'/)[1];
  assert.equal(await telegramCommand(["trust", "--add", nextPin], { home: agentHome, env: {}, out: () => {}, err: () => {} }), 0);
  assert.equal(sig.pinFor(agentHome, REALM).keys.length, 2);
  assert.equal(await s.cli(["key", "next"]), 1, "one staged key at a time");
  const oldId = readBridgeConfig(s.home).key.id;
  s.lines.length = 0;
  assert.equal(await s.cli(["key", "commit"]), 0, s.printed());
  assert.match(s.printed(), new RegExp(`trust --remove-key ${oldId}`));
  assert.equal(readBridgeConfig(s.home).key.id, sig.parsePin(nextPin).keyId);
  // The next run signs with the new key: an instruction verifies against the new key alone.
  let bridge = null;
  const running = s.cli(["run"], { onBridge: (b) => (bridge = b) });
  await until(() => bridge?.leading(), 6000, "leader");
  const alice = await agent(t, s.url, s.tokens.me, "me-alice");
  s.tg.say("@me-alice hello");
  const m = await alice.waitFor((x) => x.from === "me-owner");
  const onlyNew = { name: "me-owner", keys: [{ id: sig.parsePin(nextPin).keyId, pub: sig.parsePin(nextPin).pub }] };
  assert.equal(sig.verifyEnvelope(m.text, { pin: onlyNew, realm: REALM, sender: m.from, me: { name: "me-alice", member: ME } }).ok, true);
  await bridge.stop();
  await running;
  assert.equal(await telegramCommand(["trust", "--remove-key", oldId], { home: agentHome, env: {}, out: () => {}, err: () => {} }), 0);
  assert.equal(sig.pinFor(agentHome, REALM).keys.length, 1);
  assert.equal(await telegramCommand(["trust", "--revoke", REALM], { home: agentHome, env: {}, out: () => {}, err: () => {} }), 0);
  assert.equal(sig.pinFor(agentHome, REALM), null);
});

test("unpair removes the binding; unpair --all answers open questions `cancelled` and resets the channel", async (t) => {
  const s = await setup(t);
  await s.cli(["setup"], { stdin: TOKEN });
  paired(s.home);
  let bridge = null;
  const running = s.cli(["run"], { onBridge: (b) => (bridge = b) });
  await until(() => bridge?.leading(), 6000, "leader");
  const alice = await agent(t, s.url, s.tokens.me, "me-alice");
  const text = sig.questionEnvelope({ question: "pending?", askedAt: Date.now(), expiresAt: Date.now() + 3600_000 });
  const q = (await alice.client.send("me-owner", text, 3600, undefined, { toMember: ME })).message_id;
  await until(() => s.tg.cards().length === 1, 4000, "card");
  await bridge.stop();
  await running;
  assert.equal(await s.cli(["unpair"]), 0);
  assert.equal(readPairing(s.home), null);
  paired(s.home);
  // This home trusts its own keys (setup and key next pin them); a pin of another channel stays.
  assert.equal(await s.cli(["key", "next"]), 0, s.printed());
  const b = readBridgeConfig(s.home);
  const other = sig.newKey();
  sig.trustPin(s.home, sig.formatPin({ realm: "b".repeat(32), name: "them-owner", pub: other.pub }));
  const before = s.printed().length;
  assert.equal(await s.cli(["unpair", "--all"]), 0, s.printed());
  const said = s.printed().slice(before);
  assert.match(said, new RegExp(`Removed the old owner channel's signing keys from this home's trust entry for realm ${REALM}: ${b.key.id}, ${b.next.id}\\.`));
  assert.deepEqual(Object.values(sig.readTrusted(s.home).realms).map((e) => e.name), ["them-owner"], "only this home's own keys are untrusted");
  const m = await alice.waitFor((x) => x.from === "me-owner");
  const env = JSON.parse(m.text);
  assert.deepEqual([env.kind, env.q], ["status", q]);
  assert.match(env.text, /^cancelled: /);
  for (const f of ["pairing", "state", "bridge"]) assert.equal(fs.existsSync(sig.channelPaths(s.home)[f]), false, f);
  assert.equal(s.keychain.items.size, 0, "token and key removed");
  // A token for another bot can now start a new channel.
  await sleep(50);
  assert.equal(readBridgeConfig(s.home), null);
});

test("errors are redacted: a failing Telegram call never prints the token", async (t) => {
  const s = await setup(t);
  const code = await s.cli(["setup"], {
    stdin: TOKEN,
    telegramFactory: () => ({
      getMe: async () => {
        throw new Error(`request to https://api.telegram.org/bot${TOKEN}/getMe failed`);
      },
    }),
  });
  assert.equal(code, 1);
  assert.match(s.printed(), /<token>/);
  assert.equal(s.printed().includes(SECRET), false);
});

test("run state from the run record, judged by the process identity (7.1's helper)", (t) => {
  const home = tmpHome(t);
  sig.ensureChannelDir(home);
  const runFile = path.join(sig.channelPaths(home).dir, "run.json");
  const write = (over) => sig.writePrivateJson(runFile, { v: 1, ...processIdentity(process.pid), state: "leader", reason: null, address: "local/me-owner", at: 1, ...over });
  assert.equal(runState(home), "not running");
  write({});
  assert.equal(readRun(home).identity, "same");
  assert.equal(runState(home), "leader");
  write({ state: "waiting" });
  assert.equal(runState(home), "waiting for the relay (not leader)");
  // Another boot, or another process now holding that pid: the run is gone.
  write({ boot: "another-boot" });
  assert.equal(runState(home), "not running (its last run ended without stopping cleanly)");
  const realStart = processIdentity(process.pid).start;
  write({ start: /^\d+$/.test(realStart) ? String(Number(realStart) + 1) : "Thu Jan  1 00:00:00 1970" }); // the same form, another start
  assert.equal(readRun(home).identity, "different");
  // An identity that cannot be judged (an old record without uid) is not called stopped.
  write({ uid: null });
  assert.match(runState(home), /^unknown: the bridge process \(pid \d+\) could not be checked$/);
  write({ state: "stopped", reason: "conflict" });
  assert.equal(runState(home), "stopped: another poller");
});

test("unpair --all holds the run lock through the drain and the cleanup: a run started meanwhile is refused", async (t) => {
  const s = await setup(t);
  await s.cli(["setup"], { stdin: TOKEN });
  paired(s.home);
  // An open question: the drain has a `cancelled` status to send, so it needs the relay.
  const q = crypto.randomUUID();
  sig.writePrivateJson(sig.channelPaths(s.home).state, { v: 1, bot_id: BOT_ID, offset: 0, questions: { [q]: { q, qid: "abcdefghijkl", asker: { name: "me-alice", realm: REALM, member: ME }, alias: "local", asked_at: Date.now(), expires_at: Date.now() + 3600_000, status: "open", tg_message_id: null, payload: { question: "open?", choices: [] }, created: Date.now() } }, outbox: [], recent: [], drops: {} });
  const alice = await agent(t, s.url, s.tokens.me, "me-alice");
  let competing = null;
  let competingBridge = null;
  // Right before the drain starts, a `run` on the same home tries to start; the drain goes on
  // once that run has given up, or has become leader (which a correct unpair must never allow).
  const beforeDrain = async () => {
    competing = s.cli(["run"], { onBridge: (x) => (competingBridge = x) });
    await Promise.race([competing, until(() => competingBridge?.leading(), 3000, "never").catch(() => {})]);
  };
  t.after(() => competingBridge?.stop());
  const code = await s.cli(["unpair", "--all"], { beforeDrain });
  assert.equal(code, 0, s.printed());
  assert.ok(competing, "the competing run was started before the drain");
  assert.equal(await Promise.race([competing, sleep(1000).then(() => "still running")]), 1, `the competing run was refused: ${s.printed()}`);
  assert.match(s.printed(), /another hoptell telegram run uses this home/);
  assert.equal(readBridgeConfig(s.home), null);
  assert.equal(s.keychain.items.size, 0);
  assert.equal(fs.existsSync(sig.channelPaths(s.home).lock), false, "the lock is given back");
  const m = await alice.waitFor((x) => x.from === "me-owner");
  assert.match(JSON.parse(m.text).text, /^cancelled: /);
});

test("unpair --all whose drain does not finish as stopped removes nothing", async (t) => {
  const s = await setup(t);
  await s.cli(["setup"], { stdin: TOKEN });
  paired(s.home);
  const before = s.keychain.items.size;
  // The bridge cannot start its drain (its state file is malformed): the drain ends `refused`.
  sig.writePrivateJson(sig.channelPaths(s.home).state, { v: 2 });
  const code = await s.cli(["unpair", "--all"]);
  assert.equal(code, 1);
  assert.match(s.printed(), /the owner channel was not reset: /);
  assert.ok(readBridgeConfig(s.home), "bridge.json kept");
  assert.ok(readPairing(s.home)?.paired, "pairing kept");
  assert.equal(s.keychain.items.size, before, "token and key kept");
  assert.equal(fs.existsSync(sig.channelPaths(s.home).lock), false, "the lock is given back");
});

test("unpair --all does not poll Telegram: an instruction waiting there is not sent", async (t) => {
  const s = await setup(t);
  await s.cli(["setup"], { stdin: TOKEN });
  paired(s.home);
  const q = crypto.randomUUID();
  sig.writePrivateJson(sig.channelPaths(s.home).state, { v: 1, bot_id: BOT_ID, offset: 0, questions: { [q]: { q, qid: "abcdefghijkl", asker: { name: "me-bob", realm: REALM, member: ME }, alias: "local", asked_at: Date.now(), expires_at: Date.now() + 3600_000, status: "open", tg_message_id: null, payload: { question: "open?", choices: [] }, created: Date.now() } }, outbox: [], recent: [], drops: {} });
  const bob = await agent(t, s.url, s.tokens.me, "me-bob");
  const alice = await agent(t, s.url, s.tokens.me, "me-alice");
  s.tg.say("@me-alice deploy now");
  const calls = s.tg.getUpdatesCalls;
  assert.equal(await s.cli(["unpair", "--all"]), 0, s.printed());
  await sleep(300);
  assert.equal(s.tg.getUpdatesCalls, calls, "no getUpdates during the drain");
  assert.equal(alice.got.length, 0, "the waiting instruction was not sent");
  assert.match(JSON.parse((await bob.waitFor((x) => x.from === "me-owner")).text).text, /^cancelled: /, "the drain did run");
  assert.equal(s.tg.texts().some((x) => /^Sent to /.test(x)), false);
});

test("unpair --all with an unreadable trust file still resets the channel, and names the file and the key it may still trust", async (t) => {
  const s = await setup(t);
  await s.cli(["setup"], { stdin: TOKEN });
  const id = readBridgeConfig(s.home).key.id;
  fs.writeFileSync(sig.channelPaths(s.home).trusted, "not json", { mode: 0o600 });
  assert.equal(await s.cli(["unpair", "--all"]), 0, s.printed());
  assert.equal(readBridgeConfig(s.home), null, "reset");
  const said = s.printed().split("\n").find((l) => l.startsWith("ERR note: the trust file "));
  assert.ok(said?.includes(`${sig.channelPaths(s.home).trusted} could not be read (`), said);
  assert.ok(said.endsWith(`), so this hoptell home may still trust the old owner-channel signing key: ${id}. Fix or remove that file.`), said);
  assert.doesNotMatch(s.printed(), /trust --revoke|--remove-key/, "no command that would fail on the same file");
  assert.doesNotMatch(s.printed(), /Removed the old owner channel's signing/);
});

test("unpair --all removes only this channel's own pin: the same key trusted for another realm, listed first, stays", async (t) => {
  const s = await setup(t);
  await s.cli(["setup"], { stdin: TOKEN });
  const b = readBridgeConfig(s.home);
  const other = "b".repeat(32);
  // The same public key pinned for another realm, then this realm's entry re-trusted: the other comes first.
  sig.trustPin(s.home, sig.formatPin({ realm: other, name: b.wire, pub: b.key.pub }));
  sig.revokeRealm(s.home, REALM);
  sig.trustPin(s.home, sig.formatPin({ realm: REALM, name: b.wire, pub: b.key.pub }));
  assert.deepEqual(Object.keys(sig.readTrusted(s.home).realms), [other, REALM]);
  assert.equal(await s.cli(["unpair", "--all"]), 0, s.printed());
  assert.match(s.printed(), new RegExp(`Removed the old owner channel's signing key from this home's trust entry for realm ${REALM}: ${b.key.id}\\.`));
  assert.deepEqual(Object.keys(sig.readTrusted(s.home).realms), [other], "this realm's pin is gone; the other realm's stays");
  assert.deepEqual(sig.readTrusted(s.home).realms[other].keys.map((k) => k.id), [b.key.id]);
});

test("unpair --all leaves this realm's pin alone when it names another bridge", async (t) => {
  const s = await setup(t);
  await s.cli(["setup"], { stdin: TOKEN });
  const b = readBridgeConfig(s.home);
  sig.trustPin(s.home, sig.formatPin({ realm: REALM, name: "me-other", pub: b.key.pub }));
  assert.equal(await s.cli(["unpair", "--all"]), 0, s.printed());
  assert.doesNotMatch(s.printed(), /Removed the old owner channel's signing/);
  assert.equal(sig.readTrusted(s.home).realms[REALM].name, "me-other");
});

test("trust --remove-key: a key pinned for more than one realm needs --realm, and is removed only there", async (t) => {
  const home = tmpHome(t);
  const lines = [];
  const run = (argv) => telegramCommand(argv, { home, env: {}, out: (x) => lines.push(`OUT ${x}`), err: (x) => lines.push(`ERR ${x}`) });
  const key = sig.newKey();
  const id = sig.keyIdOf(key.pub);
  const [a, b] = ["a".repeat(32), "b".repeat(32)];
  for (const realm of [a, b]) assert.equal(await run(["trust", sig.formatPin({ realm, name: "me-owner", pub: key.pub })]), 0);
  assert.equal(await run(["trust", "--remove-key", id]), 1);
  assert.match(lines.at(-1), new RegExp(`^ERR hoptell telegram: key ${id} is trusted for more than one realm \\(${a}, ${b}\\); name one with --realm <realm id>$`));
  assert.deepEqual(Object.keys(sig.readTrusted(home).realms), [a, b], "nothing removed");
  assert.equal(await run(["trust", "--remove-key", id, "--realm", "c".repeat(32)]), 1);
  assert.match(lines.at(-1), new RegExp(`realm c+ does not trust key ${id}$`));
  assert.equal(await run(["trust", "--remove-key", id, "--realm", b]), 0, lines.join("\n"));
  assert.equal(lines.at(-1), `OUT Key ${id} is no longer trusted for realm ${b}; no owner channel is trusted for realm ${b} now.`);
  assert.deepEqual(Object.keys(sig.readTrusted(home).realms), [a], "removed only for the named realm");
  // One realm left: no --realm needed.
  assert.equal(await run(["trust", "--remove-key", id]), 0, lines.join("\n"));
  assert.deepEqual(sig.readTrusted(home).realms, {});
  // --realm belongs to --remove-key.
  assert.equal(await run(["trust", "--realm", a, sig.formatPin({ realm: a, name: "me-owner", pub: key.pub })]), 2);
  assert.match(lines.join("\n"), /--remove-key <key id> \[--realm <realm id>\]/);
});

test("unpair removes the chat's command menu; a deletion Telegram does not confirm is kept across unpair --all and retried by the next run", async (t) => {
  const s = await setup(t);
  assert.equal(await s.cli(["setup"], { stdin: TOKEN }), 0, s.printed());
  paired(s.home);
  // Plain unpair: one try at once.
  assert.equal(await s.cli(["unpair"]), 0, s.printed());
  assert.deepEqual(s.tg.calls("deleteMyCommands").map((c) => c.params.scope), [{ type: "chat", chat_id: OWNER_CHAT }]);
  // unpair --all while Telegram keeps failing: the chat is kept in menu-cleanup.json, the owner is told.
  paired(s.home);
  s.tg.failNext.deleteMyCommands = Array(50).fill(502);
  assert.equal(await s.cli(["unpair", "--all"], { menuDeleteMs: 300 }), 0, s.printed());
  assert.match(s.printed(), /ERR note: the command menu in your Telegram chat could not be removed \(Telegram deleteMyCommands: 502\); it lists your agents' names\. The next run of this bot on this home tries again; you can also delete the bot chat in Telegram\./);
  assert.equal(s.printed().includes(SECRET), false);
  const file = path.join(sig.channelPaths(s.home).dir, "menu-cleanup.json");
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { v: 1, bot_id: BOT_ID, chats: [OWNER_CHAT] });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  // The next run of the same bot deletes it, then removes the file.
  s.tg.failNext.deleteMyCommands = [];
  const before = s.tg.calls("deleteMyCommands").length;
  assert.equal(await s.cli(["setup"], { stdin: TOKEN }), 0, s.printed());
  let bridge = null;
  const running = s.cli(["run"], { onBridge: (b) => (bridge = b) });
  await until(() => bridge?.leading(), 6000, "leader");
  await until(() => s.tg.calls("deleteMyCommands").length > before, 4000, "the kept deletion retried");
  assert.deepEqual(s.tg.calls("deleteMyCommands").at(-1).params.scope, { type: "chat", chat_id: OWNER_CHAT });
  assert.equal(fs.existsSync(file), false);
  await until(() => bridge.state().menu.delete.length === 0, 4000, "confirmed");
  await bridge.stop();
  await running;
});
