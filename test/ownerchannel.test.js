// The owner channel's bridge (lib/ownerchannel.js, design 7.2) with a fake Bot API on a real local
// relay: pairing, cards, answers by reply and by button, late taps, instructions, drops, the
// webhook check, 409, claim loss during a poll, rate limits, expiry, redelivery and restarts.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import * as sig from "../lib/ownersig.js";
import { newPairingCode, readAudit, readPairing, PAIR_WRONG_MAX } from "../lib/ownerchannel.js";
import { BOT_ID, ME, OWNER_CHAT, OWNER_USER, REALM, agent, bridgeOn, fakeTelegram, newKey, ownerRelay, paired, pinOf, tmpHome, until } from "./owner-helpers.js";
import { sleep } from "./helpers.js";

const verifyFor = (key, who) => (m) => sig.verifyEnvelope(m.text, { pin: pinOf(key), realm: REALM, sender: m.from, me: { name: who, member: ME } });

test("a question without choices: a ForceReply card, answered by a reply, verified by the asker", async (t) => {
  const { url, tokens } = await ownerRelay(t);
  const home = tmpHome(t);
  paired(home);
  const tg = fakeTelegram();
  const key = newKey();
  const { bridge } = bridgeOn(t, { home, telegram: tg.client(), url, token: tokens.me, key });
  await until(() => bridge.leading(), 4000, "leadership");
  const alice = await agent(t, url, tokens.me, "me-alice");
  const q = await alice.ask("Deploy to staging now?");
  await until(() => tg.cards().length === 1, 4000, "card");
  const card = tg.cards()[0];
  assert.equal(card.params.chat_id, OWNER_CHAT);
  assert.equal(card.params.parse_mode, undefined, "plain text");
  assert.deepEqual(card.params.reply_markup.force_reply, true);
  assert.equal(card.params.text, `❓ me-alice (local) asks:\nDeploy to staging now?\n— reply to this message to answer · ref ${q.slice(0, 8)}`);
  tg.say("yes, go ahead", { reply: tg.replyTo(card) });
  const m = await alice.waitFor((x) => x.from === "me-owner");
  assert.equal(m.reply_to, q);
  const v = verifyFor(key, "me-alice")(m);
  assert.equal(v.ok, true, v.reason);
  assert.equal(v.env.kind, "answer");
  assert.equal(v.env.text, "yes, go ahead");
  assert.equal(v.env.q, q);
  await until(() => tg.sent.some((s) => s.method === "editMessageText" && /answered: yes, go ahead/.test(s.params.text)), 4000, "card edited");
  const st = bridge.state();
  assert.equal(st.questions[q].status, "answered");
  assert.equal(st.questions[q].payload, null, "the payload is deleted when the question closes");
  assert.equal(st.outbox.length, 0);
  // The audit holds digests and lengths, never text.
  const text = JSON.stringify(readAudit(home));
  assert.equal(text.includes("Deploy to staging"), false);
  assert.equal(text.includes("go ahead"), false);
  assert.match(text, /"asked"/);
  assert.match(text, /"answered"/);
});

test("a question with choices: buttons, callback_data within 64 bytes, answered by a press; a late tap", async (t) => {
  const { url, tokens } = await ownerRelay(t);
  const home = tmpHome(t);
  paired(home);
  const tg = fakeTelegram();
  const key = newKey();
  const { bridge } = bridgeOn(t, { home, telegram: tg.client(), url, token: tokens.me, key });
  await until(() => bridge.leading());
  const alice = await agent(t, url, tokens.me, "me-alice");
  const q = await alice.ask("Which database?", { choices: ["postgres", "sqlite", "x".repeat(40)] });
  await until(() => tg.cards().length === 1);
  const card = tg.cards()[0];
  const rows = card.params.reply_markup.inline_keyboard;
  assert.deepEqual(rows.map((r) => r[0].text), ["postgres", "sqlite", "x".repeat(40)]);
  for (const r of rows) {
    assert.match(r[0].callback_data, /^a:[a-z2-7]{12}:\d$/);
    assert.ok(Buffer.byteLength(r[0].callback_data) <= 64);
    assert.equal(r[0].callback_data.includes(q.slice(0, 8)), false, "the bridge's own id, not the reference");
  }
  tg.press(card, 1);
  const m = await alice.waitFor((x) => x.from === "me-owner");
  assert.equal(verifyFor(key, "me-alice")(m).env.text, "sqlite");
  await until(() => tg.sent.some((s) => s.method === "answerCallbackQuery" && s.params.text === "Answer sent"));
  // A late tap, and a later reply, find it answered.
  tg.press(card, 0);
  await until(() => tg.sent.some((s) => s.method === "answerCallbackQuery" && s.params.text === "Already answered"));
  // A later reply to the answered card is not sent at once: a button asks first (design v5).
  tg.say("postgres after all", { reply: tg.replyTo(card) });
  await until(() => tg.texts().includes("This question was already answered. Send your text to me-alice as a new instruction?"));
  await sleep(200);
  assert.equal(alice.got.filter((x) => x.from === "me-owner").length, 1, "only the first answer reaches the agent");
});

test("instructions: @name reaches the owner's own agent, signed; @all is refused, and a name such as @roles-bot is a name", async (t) => {
  const { url, tokens } = await ownerRelay(t);
  const home = tmpHome(t);
  paired(home);
  const tg = fakeTelegram();
  const key = newKey();
  const { bridge } = bridgeOn(t, { home, telegram: tg.client(), url, token: tokens.me, key });
  await until(() => bridge.leading());
  const alice = await agent(t, url, tokens.me, "me-alice");
  tg.say("@alice please run the tests");
  const m = await alice.waitFor((x) => x.from === "me-owner");
  const v = verifyFor(key, "me-alice")(m);
  assert.equal(v.ok, true, v.reason);
  assert.equal(v.env.kind, "instruction");
  assert.equal(v.env.text, "please run the tests");
  assert.deepEqual(v.env.to, { name: "me-alice", member: ME });
  await until(() => tg.texts().includes("Sent to me-alice."));
  // A name that starts with "role" is a name, not a role.
  const rolesBot = await agent(t, url, tokens.me, "me-roles-bot");
  tg.say("@roles-bot check the build");
  const rb = await rolesBot.waitFor((x) => x.from === "me-owner");
  assert.equal(verifyFor(key, "me-roles-bot")(rb).env.text, "check the build");
  await until(() => tg.texts().includes("Sent to me-roles-bot."));
  tg.say("@all stop everything");
  await until(() => tg.texts().some((x) => /^Send to one agent: @<name> <text>\. @all is not supported; other @words are treated as agent names, not roles\.$/.test(x)));
  tg.say("@nobody hello");
  await until(() => tg.texts().some((x) => /no reachable agent named me-nobody/.test(x)));
  tg.say("x".repeat(3501));
  await until(() => tg.texts().some((x) => /limited to 3500/.test(x)));
  tg.say("just chatting");
  await until(() => tg.texts().filter((x) => /^hoptell owner channel\./.test(x)).length >= 1);
  tg.say("/pending");
  await until(() => tg.texts().includes("No open questions."));
  tg.say("/peers");
  await until(() => tg.texts().some((x) => /Your agents on local:\n• me-alice/.test(x)));
  assert.equal(alice.got.filter((x) => x.from === "me-owner").length, 1, "nothing else was forwarded");
});

test("pairing: a one-time code binds one user and private chat; wrong codes, expiry, single use", async (t) => {
  const { url, tokens } = await ownerRelay(t);
  const home = tmpHome(t);
  const tg = fakeTelegram();
  const key = newKey();
  let now = Date.now();
  const code = await newPairingCode(home, BOT_ID, now);
  assert.match(code, /^[A-Z2-7]{8}$/);
  const { bridge } = bridgeOn(t, { home, telegram: tg.client(), url, token: tokens.me, key, now: () => now });
  await until(() => bridge.leading());
  tg.say("/start WRONGCOD", { from: 9, chat: 9 });
  tg.say(`/start ${code}`, { type: "group", chat: -100 });
  await until(() => bridge.state().offset === 3);
  assert.equal(tg.sent.length, 0, "a wrong code and a group get no answer");
  assert.equal(readPairing(home).pending.wrong, 1);
  tg.say(`/start ${code}`, { from: 42, chat: 42 });
  await until(() => readPairing(home).paired);
  assert.deepEqual([readPairing(home).paired.user_id, readPairing(home).paired.chat_id], [42, 42]);
  assert.match(readPairing(home).paired.id, /^p_[a-z2-7]{16}$/);
  await until(() => tg.texts().some((x) => /^Paired with hoptell/.test(x)));
  // Single use: the same code again does nothing; the earlier user is not the owner.
  tg.say(`/start ${code}`, { from: 43, chat: 43 });
  tg.say("/help", { from: OWNER_USER, chat: OWNER_CHAT });
  await until(() => bridge.state().offset === 6);
  assert.equal(readPairing(home).paired.user_id, 42);
  assert.equal(tg.texts().filter((x) => /^hoptell owner channel/.test(x)).length, 0);
  // Five wrong codes void a code; an expired code is void.
  const c2 = await newPairingCode(home, BOT_ID, now);
  for (let i = 0; i < PAIR_WRONG_MAX; i++) tg.say(`/start BAD${i}XXXX`, { from: 50 + i, chat: 50 + i });
  await until(() => bridge.state().offset === 11);
  assert.equal(readPairing(home).pending, null);
  tg.say(`/start ${c2}`, { from: 60, chat: 60 });
  await until(() => bridge.state().offset === 12);
  assert.equal(readPairing(home).paired.user_id, 42);
  const c3 = await newPairingCode(home, BOT_ID, now);
  now += 10 * 60_000 + 1;
  tg.say(`/start ${c3}`, { from: 61, chat: 61 });
  await until(() => bridge.state().offset === 13);
  assert.equal(readPairing(home).paired.user_id, 42);
  assert.equal(fs.statSync(sig.channelPaths(home).pairing).mode & 0o777, 0o600);
});

test("pairing: the code is matched without regard to case; wrong tries still count", async (t) => {
  const { url, tokens } = await ownerRelay(t);
  const home = tmpHome(t);
  const tg = fakeTelegram();
  const code = await newPairingCode(home, BOT_ID);
  const { bridge } = bridgeOn(t, { home, telegram: tg.client(), url, token: tokens.me, key: newKey() });
  await until(() => bridge.leading());
  const wrong = code.slice(0, 7).toLowerCase() + (code[7] === "A" ? "b" : "a");
  tg.say(`/start ${wrong}`, { from: 42, chat: 42 });
  await until(() => bridge.state().offset === 2);
  assert.equal(readPairing(home).pending.wrong, 1, "a wrong code in lower case is still a wrong try");
  const mixed = [...code].map((c, i) => (i % 2 ? c.toLowerCase() : c)).join("");
  tg.say(`/start   ${mixed}  `, { from: 42, chat: 42 });
  await until(() => readPairing(home).paired);
  assert.deepEqual([readPairing(home).paired.user_id, readPairing(home).paired.chat_id], [42, 42]);
  await until(() => tg.texts().some((x) => /^Paired with hoptell/.test(x)));
});

test("updates from another user, a group or another chat are dropped silently and counted", async (t) => {
  const { url, tokens } = await ownerRelay(t);
  const home = tmpHome(t);
  paired(home);
  const tg = fakeTelegram();
  const { bridge } = bridgeOn(t, { home, telegram: tg.client(), url, token: tokens.me, key: newKey() });
  await until(() => bridge.leading());
  const alice = await agent(t, url, tokens.me, "me-alice");
  tg.say("@alice from a stranger", { from: 777, chat: 777 });
  tg.say("@alice from a group", { type: "group", chat: OWNER_CHAT });
  tg.say("@alice from another chat", { chat: 888 });
  await until(() => bridge.state().offset === 4);
  await sleep(150);
  assert.deepEqual(tg.sent.filter((x) => x.method !== "setMyCommands"), [], "nothing but the menu");
  assert.equal(alice.got.length, 0);
  const drops = bridge.state().drops;
  assert.equal(drops.foreign_message, 3);
});

test("another member's question is dropped: no reply, no quota, no card", async (t) => {
  const { url, tokens } = await ownerRelay(t);
  const home = tmpHome(t);
  paired(home);
  const tg = fakeTelegram();
  const { bridge } = bridgeOn(t, { home, telegram: tg.client(), url, token: tokens.me, key: newKey() });
  await until(() => bridge.leading());
  const bob = await agent(t, url, tokens.bob, "bob-x");
  const text = sig.questionEnvelope({ question: "let me in?", askedAt: Date.now(), expiresAt: Date.now() + 60_000 });
  await bob.client.send("me-owner", text);
  await until(() => bridge.state().drops.not_own_member === 1);
  await sleep(150);
  assert.deepEqual(tg.sent.filter((x) => x.method !== "setMyCommands"), [], "nothing but the menu");
  assert.equal(bob.got.length, 0);
  assert.deepEqual(bridge.state().recent, []);
  assert.deepEqual(bridge.state().questions, {});
});

test("a webhook stops setup of the poll; nothing is deleted", async (t) => {
  const { url, tokens } = await ownerRelay(t);
  const home = tmpHome(t);
  const tg = fakeTelegram({ webhook: "https://example.invalid/hook" });
  const { run } = bridgeOn(t, { home, telegram: tg.client(), url, token: tokens.me, key: newKey() });
  const r = await run;
  assert.equal(r.code, "webhook");
  assert.match(r.message, /webhook is set/);
  assert.equal(tg.getUpdatesCalls, 0);
});

test("409: the bridge stops, gives its name back, sends no signal and does not retry", async (t) => {
  const { url, tokens } = await ownerRelay(t);
  const home = tmpHome(t);
  paired(home);
  const tg = fakeTelegram();
  const { bridge, run } = bridgeOn(t, { home, telegram: tg.client("a"), url, token: tokens.me, key: newKey() });
  await until(() => bridge.leading());
  await sleep(50);
  // Another poller of the same token (not a hoptell bridge) starts polling.
  const other = tg.client("intruder");
  const p = other.getUpdates({ offset: 0 });
  const r = await run;
  assert.equal(r.code, "conflict");
  assert.match(r.message, /another process polls this bot; hoptell supports one bridge per bot/);
  await p;
  const calls = tg.getUpdatesCalls;
  await sleep(300);
  assert.equal(tg.getUpdatesCalls, calls, "no retry");
  assert.ok(readAudit(home).some((e) => e.event === "conflict"));
  // The name was given back at once (no reservation).
  const again = await agent(t, url, tokens.me, "me-owner");
  assert.equal(again.client.name, "me-owner");
});

test("claim loss during a poll: the poll is aborted, a late response is discarded, its offset not confirmed", async (t) => {
  const { url, tokens } = await ownerRelay(t);
  const home = tmpHome(t);
  paired(home);
  const tg = fakeTelegram();
  const key = newKey();
  const { bridge } = bridgeOn(t, { home, telegram: tg.client(), url, token: tokens.me, key });
  await until(() => bridge.leading());
  const alice = await agent(t, url, tokens.me, "me-alice");
  await sleep(50);
  tg.hold = true; // the poll in progress keeps its response until released, whatever happens
  tg.say("@alice first");
  await until(() => tg.held.length === 1, 4000, "a held response");
  bridge.relay.cycle(); // the relay connection drops: the claim is lost
  await until(() => !bridge.leading(), 4000, "loss");
  tg.release(); // the response arrives late
  await sleep(100);
  assert.equal(bridge.state().offset, 0, "the late response was not processed");
  assert.equal(alice.got.length, 0);
  // Back as leader (its lease resumed): the update comes again and is handled once.
  await until(() => bridge.leading(), 6000, "leader again");
  const m = await alice.waitFor((x) => x.from === "me-owner");
  assert.equal(verifyFor(key, "me-alice")(m).env.text, "first");
  await sleep(200);
  assert.equal(alice.got.length, 1);
  assert.equal(bridge.state().offset, 2);
  assert.ok(readAudit(home).some((e) => e.event === "lost-leader"));
});

test("rate limits: three open questions per asker; the fourth gets a signed `refused: rate` status", async (t) => {
  const { url, tokens } = await ownerRelay(t);
  const home = tmpHome(t);
  paired(home);
  const tg = fakeTelegram();
  const key = newKey();
  const { bridge } = bridgeOn(t, { home, telegram: tg.client(), url, token: tokens.me, key });
  await until(() => bridge.leading());
  const alice = await agent(t, url, tokens.me, "me-alice");
  for (let i = 0; i < 3; i++) await alice.ask(`question ${i}`);
  const q4 = await alice.ask("question 3");
  const m = await alice.waitFor((x) => x.from === "me-owner");
  const v = verifyFor(key, "me-alice")(m);
  assert.equal(v.ok, true);
  assert.equal(v.env.kind, "status");
  assert.equal(v.env.q, q4);
  assert.match(v.env.text, /^refused: rate/);
  await until(() => tg.cards().length === 3);
  await sleep(100);
  assert.equal(tg.cards().length, 3);
  // Another asker still has room.
  const carol = await agent(t, url, tokens.me, "me-carol");
  await carol.ask("mine");
  await until(() => tg.cards().length === 4);
});

test("twenty new questions per hour per bridge", async (t) => {
  const { url, tokens } = await ownerRelay(t);
  const home = tmpHome(t);
  paired(home);
  const tg = fakeTelegram();
  const { bridge } = bridgeOn(t, { home, telegram: tg.client(), url, token: tokens.me, key: newKey() });
  await until(() => bridge.leading());
  const asked = [];
  for (let i = 0; i < 7; i++) asked.push(await agent(t, url, tokens.me, `me-a${i}`));
  for (let i = 0; i < 21; i++) await asked[i % 7].ask(`q${i}`);
  await until(() => Object.values(bridge.state().questions).filter((r) => r.status === "refused").length === 1, 6000, "one refusal");
  assert.equal(bridge.state().recent.length, 20);
});

test("expiry: the card is edited and the asker gets a signed `expired` status; a stale question gets no card", async (t) => {
  const { url, tokens } = await ownerRelay(t);
  const home = tmpHome(t);
  paired(home);
  const tg = fakeTelegram();
  const key = newKey();
  let skew = 0;
  const { bridge } = bridgeOn(t, { home, telegram: tg.client(), url, token: tokens.me, key, now: () => Date.now() + skew });
  await until(() => bridge.leading());
  const alice = await agent(t, url, tokens.me, "me-alice");
  const q = await alice.ask("still there?", { expiresIn: 300 });
  await until(() => tg.cards().length === 1);
  skew = 301_000;
  await bridge.tick();
  const m = await alice.waitFor((x) => x.from === "me-owner");
  const v = sig.verifyEnvelope(m.text, { pin: pinOf(key), realm: REALM, sender: m.from, me: { name: "me-alice", member: ME }, now: Date.now() + skew });
  assert.equal(v.ok, true, v.reason);
  assert.equal(v.env.kind, "status");
  assert.match(v.env.text, /^expired: /);
  assert.ok(tg.sent.some((s) => s.method === "editMessageText" && /expired unanswered/.test(s.params.text)));
  // A reply after expiry is not forwarded.
  tg.say("too late", { reply: tg.replyTo(tg.cards()[0]) });
  await until(() => tg.texts().some((x) => /^This question has expired\. Send your text to me-alice as a new instruction\?$/.test(x)));
  assert.equal(alice.got.length, 1);
  // A question that arrives past its expires_at: an `expired` status, no card.
  await alice.ask("old one", { now: Date.now() + skew - 400_000, expiresIn: 300 });
  await alice.waitFor((x) => x.from === "me-owner" && /arrived after its expiry/.test(JSON.parse(x.text).text));
  assert.equal(tg.cards().length, 1);
  void q;
});

test("the offset and open questions survive a restart; a redelivered question produces nothing extra", async (t) => {
  const { url, tokens } = await ownerRelay(t);
  const home = tmpHome(t);
  paired(home);
  const tg = fakeTelegram();
  const key = newKey();
  const first = bridgeOn(t, { home, telegram: tg.client(), url, token: tokens.me, key });
  await until(() => first.bridge.leading());
  const alice = await agent(t, url, tokens.me, "me-alice");
  const q = await alice.ask("survive?");
  await until(() => tg.cards().length === 1);
  tg.say("/help");
  await until(() => first.bridge.state().offset === 2);
  await first.bridge.stop();
  const second = bridgeOn(t, { home, telegram: tg.client(), url, token: tokens.me, key });
  await until(() => second.bridge.leading());
  assert.equal(second.bridge.state().offset, 2);
  assert.equal(second.bridge.state().questions[q].status, "open");
  tg.say("yes", { reply: tg.replyTo(tg.cards()[0]) });
  const m = await alice.waitFor((x) => x.from === "me-owner");
  assert.equal(verifyFor(key, "me-alice")(m).env.text, "yes");
  assert.equal(tg.cards().length, 1);
});
