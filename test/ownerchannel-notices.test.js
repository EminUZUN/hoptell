// Notes from agents (design 7.3, section 3, bug B3): a plain message from the bridge's own member,
// sent to the bridge by name, is shown in Telegram as a note; the reserved texts, the direct-only
// rule, one-way notes, the limits and their statuses, the notification rule, crash safety, and the
// bounded reply routes (route pressure, a backlog after an outage). Questions keep working.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { startRelay } from "../lib/relay.js";
import { RelayClient } from "../lib/client.js";
import * as sig from "../lib/ownersig.js";
import { Crash, MAX_NOTICE_ROUTES, NOTICE_LIMITS, readAudit, reservedText } from "../lib/ownerchannel.js";
import { BOB, ME, REALM, agent, bridgeOn, fakeTelegram, newKey, ownerRelay, paired, pinOf, tmpHome, until } from "./owner-helpers.js";
import { fakeToken, sleep } from "./helpers.js";

const verifyFor = (key, who) => (m) => sig.verifyEnvelope(m.text, { pin: pinOf(key), realm: REALM, sender: m.from, me: { name: who, member: ME } });
const notes = (tg) => tg.sent.filter((s) => s.method === "sendMessage" && /^💬 /.test(s.params.text));
/**
 * Wait until `count()` reaches `target`, failing only when it stops growing for `stallMs`. The
 * flushes below write the bridge's whole state durably (fsync) several times per note, by design
 * (lib/ownerchannel.js save), so how long thousands of notes take depends on the disk and on what
 * else runs on the machine; a fixed deadline measured that, not the bridge. A stall still fails,
 * and so does any wait beyond `maxMs` overall.
 */
async function untilAll(count, target, what, { stallMs = 30_000, maxMs = 20 * 60_000 } = {}) {
  let last = -1;
  let since = Date.now();
  const end = Date.now() + maxMs;
  for (;;) {
    const n = count();
    if (n >= target) return;
    if (n !== last) [last, since] = [n, Date.now()];
    else if (Date.now() - since > stallMs) throw new Error(`timed out waiting for ${what}: stuck at ${n} of ${target}`);
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}: ${n} of ${target} after ${maxMs / 60_000} minutes`);
    await sleep(50);
  }
}
const LOST = "I can't tell who that message was for. To answer a question, use /pending; to write to an agent, use /msg.";

async function setup(t, opts = {}) {
  const r = opts.relay ?? (await ownerRelay(t));
  const home = opts.home ?? tmpHome(t);
  if (!opts.unpaired) paired(home);
  const tg = opts.tg ?? fakeTelegram();
  const key = opts.key ?? newKey();
  const clock = { skew: 0 };
  const { bridge, run } = bridgeOn(t, { home, telegram: tg.client(), url: r.url, token: r.tokens.me, key, now: () => Date.now() + clock.skew, ...opts.bridge });
  await until(() => bridge.leading(), 4000, "leadership");
  return { ...r, home, tg, key, bridge, run, clock };
}
/** A note sent through the relay by an agent session (direct, to the bridge's name). */
const note = (a, text, to = "me-owner") => a.client.send(to, text, undefined, undefined, to.startsWith("@") ? {} : { toMember: ME });
/** A relay message handed to the bridge's connection directly (many notes, no relay rate limit). */
function inject(bridge, { from = "me-alice", text, id = crypto.randomUUID(), to = "me-owner", member = ME, auth = "member", custody = undefined, noReply = undefined }) {
  return new Promise((resolve) => {
    const m = { type: "message", id: crypto.randomUUID(), message_id: id, from, fromHost: "test", to, text, ts: Date.now(), ...(noReply ? { noReply } : {}), sender: { auth, member: { id: member, name: "me" }, ...(custody ? { custody } : {}) } };
    bridge.relay.emit("message", m, () => resolve(id));
  });
}
const statusesOf = (a, key, who = "me-alice") => a.got.filter((m) => m.from === "me-owner").map((m) => verifyFor(key, who)(m)).filter((v) => v?.ok && v.env.kind === "status").map((v) => v.env);

test("reservedText: fail closed on anything that could be a protocol body", () => {
  for (const x of ['{"hoptell_\\u006fwner_question":1}', '{"hoptell_owner_question":1,', '  {"hoptell_x": 2}', "{not json", "{", '{"a":1,"hoptell_owner":1}']) assert.equal(reservedText(x), true, x);
  for (const x of ['{"a": 1, "b": [2]}', "all good", "[1,2]", " plain {braces} later", '{"hoptellish": 1}']) assert.equal(reservedText(x), false, x);
});

test("a note from the owner's own agent: shown once as 💬, silent, with a reply route; a redelivery shows nothing new", async (t) => {
  const s = await setup(t);
  const alice = await agent(t, s.url, s.tokens.me, "me-alice");
  const ack = await note(alice, "  All tests pass.  ");
  await until(() => notes(s.tg).length === 1, 4000, "note");
  const n = notes(s.tg)[0];
  assert.equal(n.params.text, "💬 alice:\nAll tests pass.");
  assert.equal(n.params.disable_notification, true, "silent: the owner has not written to alice lately");
  assert.equal(n.params.reply_markup, undefined, "no buttons");
  assert.equal(n.params.parse_mode, undefined);
  assert.deepEqual(n.params.link_preview_options, { is_disabled: true });
  // The relay delivers it again (a crash before the ack): nothing new.
  await inject(s.bridge, { id: ack.message_id, text: "All tests pass." });
  await sleep(200);
  assert.equal(notes(s.tg).length, 1);
  // A reply continues with alice, as a signed message from the owner.
  s.tg.say("thanks, now deploy", { reply: s.tg.replyTo(n) });
  const m = await alice.waitFor((x) => x.from === "me-owner");
  const v = verifyFor(s.key, "me-alice")(m);
  assert.equal(v.ok, true, v.reason);
  assert.deepEqual([v.env.kind, v.env.text], ["instruction", "thanks, now deploy"]);
  await until(() => s.tg.calls("setMessageReaction").length === 1, 4000, "👍");
  // The audit names the agent and the length, never the text.
  const audit = readAudit(s.home).filter((e) => e.event === "noticed");
  assert.equal(audit.length, 1);
  assert.deepEqual([audit[0].from, audit[0].length], ["me-alice", "All tests pass.".length]);
  assert.equal(JSON.stringify(readAudit(s.home)).includes("All tests"), false);
  // Long notes are cut to 3,000 characters with "…".
  await note(alice, "y".repeat(5000));
  await until(() => notes(s.tg).length === 2, 4000, "long note");
  assert.equal(notes(s.tg)[1].params.text, `💬 alice:\n${"y".repeat(2999)}…`);
});

test("the notification rule (phase 1): a note notifies only when the owner wrote to that agent in the last hour", async (t) => {
  const s = await setup(t);
  const alice = await agent(t, s.url, s.tokens.me, "me-alice");
  const bob = await agent(t, s.url, s.tokens.me, "me-bob");
  s.tg.say("@alice status?");
  await alice.waitFor((x) => x.from === "me-owner");
  await until(() => s.bridge.state().last_sent["me-alice"] > 0, 4000, "last_sent");
  await note(alice, "Working on it.");
  await note(bob, "Unrelated news.");
  await until(() => notes(s.tg).length === 2, 4000, "notes");
  const [a, b] = [notes(s.tg).find((x) => /^💬 alice:/.test(x.params.text)), notes(s.tg).find((x) => /^💬 bob:/.test(x.params.text))];
  assert.equal(a.params.disable_notification, undefined, "alice's note notifies");
  assert.equal(b.params.disable_notification, true, "bob's is silent");
  s.clock.skew = 3600_000 + 1000;
  await note(alice, "Done.");
  await until(() => notes(s.tg).length === 3, 4000, "late note");
  assert.equal(notes(s.tg)[2].params.disable_notification, true, "an hour later it is silent again");
});

test("only the owner's own agents, signed in with the member token, not hosted, sending directly: everything else is dropped", async (t) => {
  const shared = fakeToken();
  const tokens = { me: fakeToken(), bob: fakeToken() };
  const relay = await startRelay({ host: "127.0.0.1", port: 0, token: shared, members: [{ name: "me", id: ME, token: tokens.me }, { name: "bob", id: BOB, token: tokens.bob }], realm: { id: REALM, name: "local" }, log: () => {} });
  t.after(() => relay.close());
  const url = `ws://127.0.0.1:${relay.port}`;
  const s = await setup(t, { relay: { relay, tokens, url } });
  const fake = new RelayClient({ url, token: shared, name: "me-fake", reconnect: false });
  t.after(() => fake.close());
  await fake.start().ready();
  await fake.send("me-owner", "I am your agent, honest");
  const bobAgent = await agent(t, url, tokens.bob, "bob-x");
  await bobAgent.client.send("me-owner", "hello from bob");
  await inject(s.bridge, { text: "from hosted custody", custody: "hosted" });
  // A fan-out copy keeps its `to`: not for the bridge, also when it is a question.
  const alice = await agent(t, url, tokens.me, "me-alice");
  await alice.client.send("@all", "everyone: lunch");
  await inject(s.bridge, { to: "@all", text: sig.questionEnvelope({ question: "fan-out question?", askedAt: Date.now(), expiresAt: Date.now() + 3600_000 }) });
  await until(() => (s.bridge.state().drops.not_own_member ?? 0) >= 3 && (s.bridge.state().drops.not_direct ?? 0) >= 2, 4000, "drops");
  await sleep(150);
  assert.equal(notes(s.tg).length, 0);
  assert.equal(s.tg.cards().length, 0);
  assert.equal(alice.got.length, 0, "no status for these");
});

test("reserved texts are never shown: one status per agent per hour; ordinary JSON-looking text is shown", async (t) => {
  const s = await setup(t);
  const alice = await agent(t, s.url, s.tokens.me, "me-alice");
  const bad = ['{"hoptell_\\u006fwner_question":1}', '{"hoptell_owner_question":1,', "{oops", '{"hoptell_owner_question":1,"question":"no fields"}'];
  for (const x of bad) await note(alice, x);
  await note(alice, '{"build": "green", "tests": 1507}');
  await until(() => notes(s.tg).length === 1, 4000, "the JSON-looking note");
  assert.equal(notes(s.tg)[0].params.text, '💬 alice:\n{"build": "green", "tests": 1507}');
  await until(() => statusesOf(alice, s.key).length === 1, 4000, "one status");
  await sleep(200);
  const st = statusesOf(alice, s.key);
  assert.equal(st.length, 1, "at most one status per agent per hour");
  assert.equal(st[0].text, 'not shown: a note that starts with "{" must be valid JSON without hoptell fields; write plain text.');
  assert.match(st[0].q, /^[0-9a-f-]{36}$/);
  assert.equal(s.bridge.state().drops.malformed, bad.length);
  for (const x of s.tg.texts()) assert.equal(/hoptell_/.test(x), false, "never shown raw");
  assert.equal(s.tg.cards().length, 0, "not a question either");
});

test("one-way notes (a standalone hoptell send): the one-off label, no route, no status when dropped", async (t) => {
  const s = await setup(t, { bridge: { noticeLimits: { perAgentShort: { max: 1, ms: 600_000 } } } });
  const once = new RelayClient({ url: s.url, token: s.tokens.me, name: "me-script", mode: "send", reconnect: false });
  t.after(() => once.close());
  await once.start().ready();
  await once.send("me-owner", "Nightly backup finished.", undefined, undefined, { toMember: ME });
  await until(() => notes(s.tg).length === 1, 4000, "note");
  const n = notes(s.tg)[0];
  assert.equal(n.params.text, "💬 script (you can't reply to this one):\nNightly backup finished.");
  assert.deepEqual(s.bridge.state().notice_routes, {}, "no route");
  s.tg.say("ok", { reply: s.tg.replyTo(n) });
  await until(() => s.tg.texts().includes(LOST), 4000, "C10");
  // Over budget: dropped, and no status goes back (there is no session to tell).
  await once.send("me-owner", "second", undefined, undefined, { toMember: ME });
  await until(() => s.bridge.state().drops.notice_rate === 1, 4000, "dropped");
  await sleep(150);
  assert.equal(Object.keys(s.bridge.state().notice_rate.statused).length, 0);
});

test("limits: per agent 10 per 10 minutes and 30 per hour, 60 per hour in all; one warning line, drops counted, one status per agent per hour", async (t) => {
  assert.deepEqual([NOTICE_LIMITS.perAgentShort, NOTICE_LIMITS.perAgentHour, NOTICE_LIMITS.allHour], [{ max: 10, ms: 600_000 }, { max: 30, ms: 3600_000 }, { max: 60, ms: 3600_000 }]);
  const s = await setup(t);
  const alice = await agent(t, s.url, s.tokens.me, "me-alice");
  for (let i = 1; i <= 12; i++) await inject(s.bridge, { text: `note ${i}` });
  await until(() => notes(s.tg).length === 10 && s.bridge.state().drops.notice_rate === 2, 6000, "10 shown, 2 dropped");
  const warn = "⚠️ alice has reached its message limit. New notes are skipped until the limit clears and won't appear later. Questions still arrive.";
  await until(() => s.tg.texts().filter((x) => x === warn).length === 1, 4000, "one warning");
  await until(() => statusesOf(alice, s.key).length === 1, 4000, "one status");
  assert.equal(statusesOf(alice, s.key)[0].text, "not shown: your owner's Telegram is receiving too many messages from you; send fewer, or use ask_owner for a question.");
  // 30 per hour: three more windows of 10 minutes.
  for (let w = 1; w <= 3; w++) {
    s.clock.skew = w * 600_000 + 1000;
    for (let i = 0; i < 10; i++) await inject(s.bridge, { text: `w${w} ${i}` });
  }
  await until(() => notes(s.tg).length === 30, 8000, "30 in the hour");
  assert.equal(s.bridge.state().drops.notice_rate, 12);
  await sleep(150);
  assert.equal(s.tg.texts().filter((x) => x === warn).length, 1, "once per hour");
  assert.equal(statusesOf(alice, s.key).length, 1, "once per hour");
  // 60 per hour in all: bob and carol fill the rest.
  s.clock.skew = 3 * 600_000 + 2000;
  for (const who of ["me-bob", "me-carol", "me-dave"]) for (let i = 0; i < 10; i++) await inject(s.bridge, { from: who, text: `${who} ${i}` });
  await until(() => notes(s.tg).length === 60, 8000, "60 in all");
  assert.equal(s.bridge.state().drops.notice_rate, 12);
  s.clock.skew = 4 * 600_000 + 3000;
  await inject(s.bridge, { from: "me-erin", text: "one too many" });
  await until(() => s.bridge.state().drops.notice_rate === 13, 4000, "over the total");
  // The limit for all agents together trips on erin's first note: the warning names no agent.
  await until(() => s.tg.texts().includes("⚠️ The hourly limit for agent notes has been reached. New notes are skipped until the limit clears and won't appear later. Questions still arrive."), 4000, "the overall warning");
  assert.ok(!s.tg.texts().some((x) => /erin/.test(x)), "erin is not blamed for the overall limit");
});

test("a note while unpaired is dropped with its status", async (t) => {
  const s = await setup(t, { unpaired: true });
  const alice = await agent(t, s.url, s.tokens.me, "me-alice");
  await note(alice, "anyone there?");
  await until(() => statusesOf(alice, s.key).length === 1, 4000, "status");
  assert.equal(statusesOf(alice, s.key)[0].text, "not shown: your owner has not connected Telegram yet.");
  assert.equal(s.bridge.state().drops.notice_unpaired, 1);
  await until(() => s.bridge.state().outbox.length === 0, 4000, "nothing left");
  assert.equal(s.tg.sent.filter((x) => x.method === "sendMessage").length, 0, "not queued for a later pairing");
});

test("a crash after Telegram took a note, before its id was saved: one copy marked (sent again), whose reply continues", async (t) => {
  const r = await ownerRelay(t);
  const home = tmpHome(t);
  paired(home);
  const tg = fakeTelegram();
  const key = newKey();
  let armed = true;
  const fault = (p) => {
    if (p === "notice-sent" && armed) {
      armed = false;
      throw new Crash(p);
    }
  };
  const a = bridgeOn(t, { home, telegram: tg.client("a"), url: r.url, token: r.tokens.me, key, fault });
  await until(() => a.bridge.leading(), 4000, "leader");
  const alice = await agent(t, r.url, r.tokens.me, "me-alice");
  await note(alice, "Build is red.");
  assert.equal((await a.run).code, "crashed");
  assert.equal(notes(tg).length, 1);
  bridgeOn(t, { home, telegram: tg.client("b"), url: r.url, token: r.tokens.me, key });
  await until(() => notes(tg).length === 2, 6000, "the copy");
  await sleep(200);
  assert.equal(notes(tg).length, 2, "at least once, not more");
  assert.equal(notes(tg)[1].params.text, "💬 alice (sent again):\nBuild is red.");
  tg.say("look at the logs", { reply: tg.replyTo(notes(tg)[1]) });
  await alice.waitFor((x) => x.from === "me-owner" && JSON.parse(x.text).text === "look at the logs");
  // The first copy has no route.
  tg.say("and this?", { reply: tg.replyTo(notes(tg)[0]) });
  await until(() => tg.texts().includes(LOST), 4000, "C10");
});

test("route pressure: 1,600 notes while a question is open; its card still answers, the newest 1,500 notes continue, older ones get C10", async (t) => {
  const s = await setup(t, { bridge: { noticeLimits: { perAgentShort: { max: 1e6, ms: 1 }, perAgentHour: { max: 1e6, ms: 1 }, allHour: { max: 1e6, ms: 1 } } } });
  const alice = await agent(t, s.url, s.tokens.me, "me-alice");
  await alice.ask("Keep going?");
  await until(() => s.tg.cards().length === 1, 4000, "card");
  const card = s.tg.cards()[0];
  for (let i = 0; i < 1600; i++) await inject(s.bridge, { from: "me-bob", text: `n${i}` });
  await untilAll(() => notes(s.tg).length, 1600, "1600 notes");
  assert.deepEqual(notes(s.tg).map((x) => x.params.text.split("\n").at(-1)), Array.from({ length: 1600 }, (_, i) => `n${i}`), "each note once, in order");
  assert.equal(Object.keys(s.bridge.state().notice_routes).length, MAX_NOTICE_ROUTES);
  const ns = notes(s.tg);
  s.tg.say("too old", { reply: s.tg.replyTo(ns[99]) });
  await until(() => s.tg.texts().includes(LOST), 6000, "C10");
  const bob = await agent(t, s.url, s.tokens.me, "me-bob");
  s.tg.say("recent enough", { reply: s.tg.replyTo(ns[100]) });
  await bob.waitFor((x) => x.from === "me-owner" && JSON.parse(x.text).text === "recent enough");
  s.tg.say("yes", { reply: s.tg.replyTo(card) });
  const m = await alice.waitFor((x) => x.from === "me-owner");
  assert.equal(verifyFor(s.key, "me-alice")(m).env.kind, "answer");
});

test("a backlog after an outage: 2,000 notes flushed; the newest 1,500 accept replies, older ones get C10", async (t) => {
  const s = await setup(t, { bridge: { noticeLimits: { perAgentShort: { max: 1e6, ms: 1 }, perAgentHour: { max: 1e6, ms: 1 }, allHour: { max: 1e6, ms: 1 } } } });
  s.tg.failNext.sendMessage = Array(1e6).fill(502); // Telegram is down
  for (let i = 0; i < 2000; i++) await inject(s.bridge, { from: "me-bob", text: `b${i}` });
  assert.equal(s.bridge.state().outbox.length, 2000);
  s.tg.failNext.sendMessage = [];
  await untilAll(() => notes(s.tg).length, 2000, "flushed");
  assert.deepEqual(notes(s.tg).map((x) => x.params.text.split("\n").at(-1)), Array.from({ length: 2000 }, (_, i) => `b${i}`), "each note once, in order");
  const ns = notes(s.tg);
  assert.equal(ns.filter((x) => /sent again/.test(x.params.text)).length, 0, "an HTTP error is not a send: no copy is marked");
  const bob = await agent(t, s.url, s.tokens.me, "me-bob");
  s.tg.say("old", { reply: s.tg.replyTo(ns[499]) });
  await until(() => s.tg.texts().includes(LOST), 6000, "C10");
  s.tg.say("new", { reply: s.tg.replyTo(ns[500]) });
  await bob.waitFor((x) => x.from === "me-owner" && JSON.parse(x.text).text === "new");
});
