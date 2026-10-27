// Pairing changes and binding (design 7.3, 2.9): the owner of record in state.json, the first
// pairing, the same user paired again, another user, the fail-closed migration of a 7.2 state,
// steps and controls of an earlier pairing retired, a member change, repeated re-pairs and the
// cap on card copies. A fake Bot API on a real local relay.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { RelayClient } from "../lib/client.js";
import * as sig from "../lib/ownersig.js";
import { Crash, MAX_CARD_COPIES, newPairingCode } from "../lib/ownerchannel.js";
import { BOT_ID, BOB, ME, OWNER_CHAT, OWNER_USER, REALM, agent, bridgeOn, fakeTelegram, newKey, ownerRelay, paired, pinOf, tmpHome, until } from "./owner-helpers.js";
import { sleep } from "./helpers.js";

const verifyFor = (key, who) => (m) => sig.verifyEnvelope(m.text, { pin: pinOf(key), realm: REALM, sender: m.from, me: { name: who, member: ME } });
const envs = (a, key, who = "me-alice") => a.got.filter((m) => m.from === "me-owner").map((m) => verifyFor(key, who)(m)).filter((v) => v?.ok).map((v) => v.env);
const once = (xs) => [...new Map(xs.map((x) => [x.nonce, x])).values()]; // a redone send carries its nonce
const LOST = "I can't tell who that message was for. To answer a question, use /pending; to write to an agent, use /msg.";
const P2 = "p_bbbbbbbbbbbbbbbb";
const OTHER = 7770001;

/** A world: relay, home (paired unless told), fake Telegram and key; start() runs a bridge. */
async function world(t, { unpaired = false } = {}) {
  const r = await ownerRelay(t);
  const home = tmpHome(t);
  if (!unpaired) paired(home);
  const tg = fakeTelegram();
  const key = newKey();
  let n = 0;
  const start = async (opts = {}) => {
    const b = bridgeOn(t, { home, telegram: tg.client(`b${++n}`), url: r.url, token: r.tokens.me, key, ...opts });
    if (opts.wait !== false) await until(() => b.bridge.leading(), 4000, "leadership");
    return b;
  };
  return { ...r, home, tg, key, start };
}

test("a fresh home: a question asked before the first pairing is shown once paired, not cancelled", async (t) => {
  const w = await world(t, { unpaired: true });
  const { bridge } = await w.start();
  assert.equal(bridge.state().owner, null, "a state of this version always names its owner (none yet)");
  const alice = await agent(t, w.url, w.tokens.me, "me-alice");
  const q = await alice.ask("Before you paired: ok?");
  await until(() => bridge.state().questions[q]?.status === "pending", 4000, "held");
  await sleep(150);
  assert.equal(w.tg.cards().length, 0);
  const code = await newPairingCode(w.home, BOT_ID);
  w.tg.say(`/start ${code}`);
  await until(() => w.tg.cards().length === 1, 4000, "card after the first pairing");
  assert.match(w.tg.cards()[0].params.text, /^❓ Question 1 · alice asks:\nBefore you paired: ok\?/);
  assert.equal(bridge.state().questions[q].status, "open");
  assert.equal(bridge.state().owner.user_id, OWNER_USER);
  assert.equal(envs(alice, w.key).length, 0, "no status: nothing was cancelled");
});

test("the same user pairs again (crash before the reconcile write): reconciled once; the card comes again, old copies still answer", async (t) => {
  const w = await world(t);
  const a = await w.start();
  const alice = await agent(t, w.url, w.tokens.me, "me-alice");
  const q = await alice.ask("Proceed?", { choices: ["yes", "no"] });
  const free = await alice.ask("Why?");
  await until(() => w.tg.cards().length === 2, 4000, "cards");
  const [card, freeCard] = w.tg.cards();
  await a.bridge.stop();
  paired(w.home, { id: P2 }); // a new /start code: same user, same chat, new pairing id
  let armed = true;
  const b = await w.start({ wait: false, fault: (p) => armed && p === "reconcile" && !(armed = false) && (() => { throw new Crash(p); })() });
  assert.equal((await b.run).code, "crashed");
  assert.equal(b.bridge.state().owner.pairing, "p_abcdefghijklmnop", "not reconciled yet");
  const c = await w.start();
  await until(() => w.tg.cards().length === 4, 4000, "both cards again");
  await sleep(200);
  assert.equal(w.tg.cards().length, 4, "once");
  assert.match(w.tg.cards()[2].params.text, /^❓ Question \d · alice\nSent again in this chat\.\n/);
  const st = c.bridge.state();
  assert.equal(st.owner.pairing, P2);
  assert.equal(st.questions[q].copies.length, 2);
  // The old card's button and a reply to the old free-text card both answer.
  w.tg.press(card, 1);
  w.tg.say("because", { reply: w.tg.replyTo(freeCard) });
  await until(() => envs(alice, w.key).filter((e) => e.kind === "answer").length === 2, 4000, "answers");
  assert.deepEqual(envs(alice, w.key).filter((e) => e.kind === "answer").map((e) => [e.q, e.text]).sort(), [[q, "no"], [free, "because"]].sort());
  assert.equal(envs(alice, w.key).filter((e) => e.kind === "status").length, 0, "nothing cancelled");
  // Both copies of each card show the answer.
  await until(() => w.tg.calls("editMessageText").length >= 4, 4000, "edits");
});

test("another user pairs: open and pending questions are cancelled once, their agents told; the new owner inherits nothing", async (t) => {
  const w = await world(t);
  const a = await w.start();
  const alice = await agent(t, w.url, w.tokens.me, "me-alice");
  const q1 = await alice.ask("Open one?");
  await until(() => w.tg.cards().length === 1, 4000, "card");
  w.tg.failNext.sendMessage = [502, 502, 502, 502, 502, 502, 502, 502, 502, 502, 502, 502, 502, 502, 502, 502, 502, 502, 502, 502];
  const q2 = await alice.ask("Pending one?"); // its card cannot be sent yet
  await until(() => a.bridge.state().questions[q2]?.status === "pending", 4000, "pending");
  // The owner's earlier controls: a list with a button, a prompt, a route.
  await a.bridge.stop();
  w.tg.failNext.sendMessage = [];
  paired(w.home, { user: OTHER, chat: OTHER, id: P2 });
  const b = await w.start();
  await until(() => envs(alice, w.key).filter((e) => e.kind === "status").length === 2, 4000, "statuses");
  await sleep(200);
  const st = b.bridge.state();
  assert.deepEqual([st.questions[q1].status, st.questions[q2].status], ["cancelled", "cancelled"]);
  const statuses = once(envs(alice, w.key).filter((e) => e.kind === "status"));
  assert.equal(statuses.length, 2);
  for (const x of statuses) assert.match(x.text, /^cancelled: your question [0-9a-f-]{36} was cancelled because your owner channel was paired with another Telegram account\.$/);
  // Nothing reached the new chat; the old card was edited in the old chat (best effort).
  assert.equal(w.tg.sent.some((x) => x.params.chat_id === OTHER), false);
  assert.ok(w.tg.calls("editMessageText").some((x) => x.params.chat_id === OWNER_CHAT && /^🚫 Question 1 · alice: cancelled/.test(x.params.text)));
  assert.deepEqual([st.routes, st.targets, st.notice_routes], [{}, {}, {}]);
  // The new owner's reply to an old message id reaches nothing.
  w.tg.say("hi", { from: OTHER, chat: OTHER, reply: { message_id: w.tg.cards()[0].message_id, text: "x" } });
  await until(() => w.tg.texts().includes(LOST), 4000, "C10");
});

test("plain unpair, then a pairing by the same user and by another one: each takes its branch", async (t) => {
  const w = await world(t);
  const { bridge } = await w.start();
  const alice = await agent(t, w.url, w.tokens.me, "me-alice");
  await alice.ask("Still there?");
  await until(() => w.tg.cards().length === 1, 4000, "card");
  fs.rmSync(sig.channelPaths(w.home).pairing); // hoptell telegram unpair
  await bridge.tick();
  assert.equal(bridge.state().owner.pairing, "p_abcdefghijklmnop", "kept while unpaired");
  const code = await newPairingCode(w.home, BOT_ID);
  w.tg.say(`/start ${code}`);
  await until(() => w.tg.cards().length === 2, 4000, "same user: the card again");
  assert.match(w.tg.cards()[1].params.text, /\nSent again in this chat\.\n/);
  assert.equal(bridge.state().owner.user_id, OWNER_USER);
  fs.rmSync(sig.channelPaths(w.home).pairing);
  const code2 = await newPairingCode(w.home, BOT_ID);
  w.tg.say(`/start ${code2}`, { from: OTHER, chat: OTHER });
  await until(() => envs(alice, w.key).some((e) => e.kind === "status" && /another Telegram account/.test(e.text)), 4000, "cancelled for the other user");
  assert.equal(bridge.state().owner.user_id, OTHER);
  assert.equal(w.tg.cards().filter((c) => c.params.chat_id === OTHER).length, 0);
});

test("an answer from owner A still waiting for the relay when B pairs is retired, never signed with B's pairing", async (t) => {
  let hold = false;
  const clientFactory = (o) => {
    const c = new RelayClient(o);
    const send = c.send.bind(c);
    c.send = (to, text, ...rest) => (hold && to === "me-alice" && /"kind":"answer"/.test(text) ? Promise.reject(Object.assign(new Error("lost"), { kind: "lost" })) : send(to, text, ...rest));
    return c;
  };
  const w = await world(t);
  const { bridge } = await w.start({ clientFactory });
  const alice = await agent(t, w.url, w.tokens.me, "me-alice");
  const q = await alice.ask("Go?", { choices: ["go", "stop"] });
  await until(() => w.tg.cards().length === 1, 4000, "card");
  hold = true;
  w.tg.press(w.tg.cards()[0], 0);
  await until(() => bridge.state().questions[q].status === "answered" && bridge.state().outbox.length === 1, 4000, "answer waiting");
  paired(w.home, { user: OTHER, chat: OTHER, id: P2 });
  hold = false;
  await bridge.tick();
  await until(() => envs(alice, w.key).some((e) => e.kind === "status"), 4000, "status");
  await sleep(200);
  assert.equal(envs(alice, w.key).some((e) => e.kind === "answer"), false, "the answer was never sent");
  assert.match(envs(alice, w.key).find((e) => e.kind === "status").text, /^cancelled: your question [0-9a-f-]{36} was cancelled because your owner's Telegram connection changed before the answer could be sent/);
  assert.equal(bridge.state().questions[q].status, "cancelled");
  assert.ok(bridge.state().drops.old_pairing >= 1);
});

test("a note, a list and an edit queued for owner A are never sent to owner B", async (t) => {
  const w = await world(t);
  const clock = { skew: 0 };
  const { bridge } = await w.start({ now: () => Date.now() + clock.skew });
  const alice = await agent(t, w.url, w.tokens.me, "me-alice");
  const q = await alice.ask("Edit me?", { choices: ["a", "b"], expiresIn: 600 });
  await until(() => w.tg.cards().length === 1, 4000, "card");
  // Telegram is down for A: a list, a note and the expired card's edit wait in the outbox.
  w.tg.failNext.sendMessage = Array(1000).fill(502);
  w.tg.failNext.editMessageText = Array(1000).fill(502);
  w.tg.say("/msg");
  await alice.client.send("me-owner", "a note for A", undefined, undefined, { toMember: ME });
  await until(() => bridge.state().outbox.length >= 2, 4000, "list and note waiting");
  clock.skew = 601_000;
  await bridge.tick();
  await until(() => bridge.state().questions[q].status === "expired" && bridge.state().outbox.length >= 3, 4000, "edit waiting");
  const mark = w.tg.sent.length;
  paired(w.home, { user: OTHER, chat: OTHER, id: P2 });
  w.tg.failNext.sendMessage = [];
  w.tg.failNext.editMessageText = [];
  w.tg.say("/help", { from: OTHER, chat: OTHER }); // B's first update: the change is reconciled first
  await until(() => bridge.state().outbox.length === 0 && w.tg.texts().some((x) => /^How this works:/.test(x)), 6000, "outbox empty");
  const toB = w.tg.sent.filter((x) => x.params.chat_id === OTHER);
  assert.deepEqual(toB.map((x) => x.params.text.split("\n")[0]), ["How this works:"], "only B's own help");
  assert.equal(w.tg.sent.some((x) => /a note for A/.test(x.params.text ?? "")), false, "the note is not shown to anyone");
  assert.deepEqual(w.tg.sent.filter((x) => /^Who should get your message\?/.test(x.params.text ?? "")).map((x) => ({ chat: x.params.chat_id, by: x.by, at: w.tg.sent.indexOf(x), mark, left: x.left })), [], "nor the list");
  // The expired card's view went to A's chat as a cleanup edit (best effort).
  assert.ok(w.tg.calls("editMessageText").some((x) => x.params.chat_id === OWNER_CHAT && /^⌛ Question 1 · alice · Closed\n/.test(x.params.text)));
  // (The bridge's clock runs ahead here, so the agent's freshness check would refuse it: read it raw.)
  await until(() => alice.got.some((m) => m.from === "me-owner" && /"kind":"status"/.test(m.text) && /expired: /.test(m.text)), 4000, "the agent's status is not bound");
  assert.ok(bridge.state().drops.old_pairing >= 3);
});

test("migration of a 7.2 state, paired or not: every open question cancelled with a status, every control and Telegram step retired, then the owner set", async (t) => {
  for (const pairedNow of [true, false]) {
    await t.test(pairedNow ? "paired" : "unpaired", async (tt) => {
      const w = await world(tt, { unpaired: !pairedNow });
      const alice = await agent(tt, w.url, w.tokens.me, "me-alice");
      const q1 = "11111111-1111-4111-8111-111111111111";
      const q2 = "22222222-2222-4222-8222-222222222222";
      const q3 = "33333333-3333-4333-8333-333333333333";
      const asker = { name: "me-alice", realm: REALM, member: ME };
      const legacy = {
        v: 1,
        bot_id: BOT_ID,
        offset: 7,
        recent: [],
        drops: {},
        questions: {
          [q1]: { q: q1, qid: "aaaaaaaaaaaa", asker, alias: "local", asked_at: 1, expires_at: Date.now() + 3600_000, status: "open", tg_message_id: 501, payload: { question: "old open", choices: ["x", "y"] }, created: Date.now() },
          [q2]: { q: q2, qid: "bbbbbbbbbbbb", asker, alias: "local", asked_at: 1, expires_at: Date.now() + 3600_000, status: "answered", tg_message_id: 502, payload: null, created: Date.now(), closed_at: Date.now() },
          [q3]: { q: q3, qid: "cccccccccccc", asker, alias: "local", asked_at: 1, expires_at: Date.now() + 3600_000, status: "pending", tg_message_id: null, payload: { question: "old pending", choices: [] }, created: Date.now() },
        },
        outbox: [
          { kind: "q", q: q3, steps: [{ t: "card", q: q3 }], next: 0 },
          { kind: "u", update: 7, steps: [{ t: "send", kind: "answer", to: { name: "me-alice", member: ME }, q: q2, text: "legacy answer", nonce: sig.nonceOf(w.key, ["legacy", "n2"]) }, { t: "edit", q: q2, text: "answered" }], next: 0 },
          { kind: "u", update: 8, steps: [{ t: "send", kind: "instruction", to: { name: "me-alice", member: ME }, text: "legacy instruction", nonce: sig.nonceOf(w.key, ["legacy", "n3"]) }, { t: "tg", method: "sendMessage", params: { text: "Sent to me-alice." } }], next: 0 },
          { kind: "q", q: q1, steps: [{ t: "send", kind: "status", to: { name: "me-alice", member: ME }, q: q1, text: "expired: kept", nonce: sig.nonceOf(w.key, ["legacy", "n4"]) }], next: 0 },
        ],
        targets: { tttttttttt: { kind: "target", name: "me-alice", member: ME, msg: 600, exp: Date.now() + 3600_000 } },
        routes: { 501: { name: "me-alice", member: ME, kind: "card", exp: Date.now() + 3600_000 }, 700: { name: "me-alice", member: ME, kind: "sent", exp: Date.now() + 3600_000 } },
      };
      sig.ensureChannelDir(w.home);
      sig.writePrivateJson(sig.channelPaths(w.home).state, legacy);
      const { bridge } = await w.start();
      const st = bridge.state();
      assert.equal(st.owner === null, !pairedNow);
      if (pairedNow) assert.deepEqual(st.owner, { user_id: OWNER_USER, pairing: "p_abcdefghijklmnop" });
      assert.deepEqual([st.questions[q1].status, st.questions[q2].status, st.questions[q3].status], ["cancelled", "cancelled", "cancelled"]);
      assert.deepEqual([st.routes, st.targets], [{}, {}]);
      assert.ok(st.offset >= 9, "the retired updates are confirmed, never replayed");
      await until(() => bridge.state().outbox.length === 0, 4000, "statuses sent");
      const statuses = once(envs(alice, w.key).filter((e) => e.kind === "status"));
      assert.deepEqual(statuses.map((e) => e.q).sort(), [q1, q1, q2, q3].sort());
      assert.equal(statuses.filter((e) => /was cancelled because your owner channel was upgraded; ask again if it is still needed\.$/.test(e.text)).length, 3);
      assert.equal(envs(alice, w.key).some((e) => e.kind !== "status"), false, "no legacy answer or instruction is sent");
      assert.equal(w.tg.sent.filter((x) => x.method !== "setMyCommands").length, 0, "no legacy Telegram step, no edit of a legacy card");
      assert.ok(st.drops.legacy_step >= 5);
      // A tap on a legacy card's button: the question was cancelled.
      if (pairedNow) {
        for (let i = 0; i < 10; i++) w.tg.say("x", { from: 1, chat: 1 }); // the fake's update ids pass the migrated offset
        w.tg.press({ message_id: 501, params: { reply_markup: { inline_keyboard: [[{ callback_data: "a:aaaaaaaaaaaa:0" }]] } } }, 0);
        await until(() => w.tg.calls("answerCallbackQuery").some((c) => c.params.text === "This question was cancelled."), 4000, "tap");
        w.tg.say("reply to a legacy card", { reply: { message_id: 501, text: "❓ me-alice (local) asks:\nold open\n— reply to this message to answer · ref 11111111" } });
        await until(() => w.tg.texts().includes(LOST), 4000, "no text routing");
      }
      // A later pairing by another user sees none of it.
      paired(w.home, { user: OTHER, chat: OTHER, id: P2 });
      await bridge.tick();
      await sleep(150);
      assert.equal(w.tg.sent.some((x) => x.params.chat_id === OTHER), false);
      // A clock set back changes nothing: no time is used.
    });
  }
});

test("five same-user re-pairs and Show: every copy answers by reply until the question closes; the 21st copy retires the oldest visibly", async (t) => {
  const w = await world(t);
  const { bridge } = await w.start();
  const alice = await agent(t, w.url, w.tokens.me, "me-alice");
  const q = await alice.ask("Which copy?");
  await until(() => w.tg.cards().length === 1, 4000, "card");
  const show = async () => {
    w.tg.say("/pending");
    await until(() => w.tg.last(/^⏳ Waiting for you:/) && w.tg.last(/^⏳ Waiting for you:/).message_id > (w.lastPending ?? 0), 4000, "pending");
    const list = w.tg.last(/^⏳ Waiting for you:/);
    w.lastPending = list.message_id;
    return list;
  };
  for (let i = 1; i <= 5; i++) {
    paired(w.home, { id: `p_${"abcde"[i - 1].repeat(16)}` });
    w.tg.say("/help"); // any update: the pairing change is reconciled first
    const before = w.tg.cards().length;
    await until(() => w.tg.cards().length === before + 1, 4000, `re-pair ${i}`);
    const list = await show();
    for (let k = 0; k < 3; k++) {
      const n = w.tg.cards().length;
      w.tg.press(list, 0);
      await until(() => w.tg.cards().length === n + 1, 4000, `show ${i}.${k}`);
    }
    w.tg.press(list, 0);
    await until(() => w.tg.calls("answerCallbackQuery").some((c) => c.params.text === "I've already sent this question again. Please reply to the newest copy."), 4000, "fourth tap");
  }
  assert.equal(w.tg.cards().length, 21);
  await until(() => w.tg.calls("editMessageText").some((c) => c.params.message_id === w.tg.cards()[0].message_id && c.params.text === "↩️ This question was sent again. Please answer the newest copy."), 4000, "oldest retired");
  const st = bridge.state();
  assert.equal(st.questions[q].copies.length, MAX_CARD_COPIES);
  assert.equal(st.questions[q].copies.some((c) => c.id === w.tg.cards()[0].message_id), false);
  // The retired copy reaches nothing; the second one (from the first pairing) still answers.
  w.tg.say("first", { reply: w.tg.replyTo(w.tg.cards()[0]) });
  await until(() => w.tg.texts().includes(LOST), 4000, "C10");
  w.tg.say("second", { reply: w.tg.replyTo(w.tg.cards()[1]) });
  const m = await alice.waitFor((x) => x.from === "me-owner");
  assert.equal(verifyFor(w.key, "me-alice")(m).env.text, "second");
});

test("binding: after a member change old buttons, prompts, routes and confirm entries refuse and send nothing; run refuses a member other than bridge.json's", async (t) => {
  const w = await world(t);
  const a = await w.start();
  const alice = await agent(t, w.url, w.tokens.me, "me-alice");
  await alice.ask("Closed soon?", { choices: ["y", "n"] });
  await until(() => w.tg.cards().length === 1, 4000, "card");
  w.tg.press(w.tg.cards()[0], 0);
  await until(() => envs(alice, w.key).length === 1, 4000, "answered");
  w.tg.say("/msg");
  await until(() => w.tg.last(/^Who should get your message\?/), 4000, "list");
  const list = w.tg.last(/^Who should get your message\?/);
  w.tg.press(list, 0);
  await until(() => w.tg.last(/^✏️ Message to alice\. Write it below\.$/), 4000, "prompt");
  const prompt = w.tg.last(/^✏️ Message to alice/);
  // The prompt opened from the button carries the button's member.
  assert.equal(a.bridge.state().routes[String(prompt.message_id)].member, ME);
  w.tg.say("@alice hello");
  await until(() => w.tg.calls("setMessageReaction").length === 1, 4000, "👍");
  const own = w.tg.updates.at(-1).message;
  w.tg.say("again", { reply: w.tg.replyTo(w.tg.cards()[0]) });
  await until(() => w.tg.last(/^This question is already answered/), 4000, "confirm");
  const confirm = w.tg.last(/^This question is already answered/);
  await a.bridge.stop();
  // The relay entry now signs the bridge in as another member (a setup that kept this state).
  const before = envs(alice, w.key).length;
  const b = bridgeOn(t, { home: w.home, telegram: w.tg.client("bob"), url: w.url, token: w.tokens.bob, key: w.key, name: "bob-owner", namePrefix: "bob-" });
  await until(() => b.bridge.leading(), 4000, "leader as bob");
  const STALE = "This message or button is from an earlier connection. Use /pending for questions or /msg to choose an agent.";
  w.tg.press(list, 0);
  w.tg.press(confirm, 0);
  await until(() => w.tg.calls("answerCallbackQuery").filter((c) => c.params.text === STALE).length === 2, 4000, "buttons refuse");
  for (const target of [prompt, { message_id: own.message_id, params: { text: own.text } }]) w.tg.say("still there?", { reply: { message_id: target.message_id, text: target.params.text } });
  await until(() => w.tg.texts().filter((x) => x === STALE).length === 2, 4000, "replies refuse");
  await sleep(200);
  assert.equal(envs(alice, w.key).length, before, "nothing sent");
  await b.bridge.stop();
  // run's own check: bridge.json names member ME, the relay answers with BOB.
  const c = bridgeOn(t, { home: w.home, telegram: w.tg.client("c"), url: w.url, token: w.tokens.bob, key: w.key, name: "bob-owner", namePrefix: "bob-", expectMember: ME });
  const r = await c.run;
  assert.deepEqual([r.code, r.message], ["refused", "the bridge's member changed; run hoptell telegram unpair --all and set up again"]);
  assert.ok(BOB);
});

test("an agent command classified under owner A while B pairs (the relay list was slow) admits nothing", async (t) => {
  const w = await world(t);
  const gate = { on: false, waiting: [] };
  const clientFactory = (o) => {
    const c = new RelayClient(o);
    const list = c.list.bind(c);
    c.list = async (...a) => {
      if (gate.on) await new Promise((resolve) => gate.waiting.push(resolve));
      return list(...a);
    };
    return c;
  };
  const { bridge } = await w.start({ clientFactory });
  const alice = await agent(t, w.url, w.tokens.me, "me-alice");
  await sleep(100);
  gate.on = true;
  const u = w.tg.say("/alice from A"); // an agent command: classified after a fresh relay list
  await until(() => gate.waiting.length > 0, 4000, "classify waits on the relay list");
  paired(w.home, { user: OTHER, chat: OTHER, id: P2 });
  const before = bridge.state().drops.old_pairing ?? 0;
  gate.on = false;
  for (const r of gate.waiting.splice(0)) r();
  await until(() => bridge.state().offset > u.update_id, 4000, "the update is confirmed");
  await sleep(200);
  assert.equal(alice.got.some((m) => /from A/.test(m.text)), false, "nothing sent");
  assert.equal(w.tg.calls("setMessageReaction").length, 0);
  assert.ok(w.tg.sent.every((x) => x.params.chat_id !== OWNER_CHAT || x.method === "editMessageText" || x.method.startsWith("set") || x.method.startsWith("delete")), "nothing new to A's chat");
  assert.ok((bridge.state().drops.old_pairing ?? 0) > before);
});

test("the same user re-pairs in another chat: old message ids there route nowhere, even when they collide", async (t) => {
  const w = await world(t);
  const { bridge } = await w.start();
  const alice = await agent(t, w.url, w.tokens.me, "me-alice");
  const q = await alice.ask("Which db?");
  await until(() => w.tg.cards().length === 1, 4000, "card");
  const card = w.tg.cards()[0];
  const u = w.tg.say("@alice hello");
  await alice.waitFor((m) => m.from === "me-owner" && /hello/.test(m.text));
  await until(() => w.tg.calls("setMessageReaction").length === 1, 4000, "👍");
  await alice.client.send("me-owner", "a note", undefined, undefined, { toMember: ME });
  await until(() => w.tg.last(/^💬 alice:/), 4000, "note");
  const note = w.tg.last(/^💬 alice:/);
  const NEWCHAT = 5550999;
  paired(w.home, { user: OWNER_USER, chat: NEWCHAT, id: P2 }); // same person, another private chat
  w.tg.say("/help", { chat: NEWCHAT });
  await until(() => w.tg.cards().length === 2, 4000, "the card again, in the new chat");
  assert.equal(w.tg.cards()[1].params.chat_id, NEWCHAT);
  const st = bridge.state();
  assert.equal(Object.values(st.routes).some((r) => r.chat === OWNER_CHAT), false, "no route of the old chat survives");
  // Replies in the new chat to the old chat's message ids (colliding ids): nothing is sent.
  const lost = () => w.tg.texts().filter((x) => x === LOST).length;
  for (const id of [card.message_id, u.message.message_id, note.message_id]) {
    const n = lost();
    w.tg.say(`collide ${id}`, { chat: NEWCHAT, reply: { message_id: id, text: "x" } });
    await until(() => lost() === n + 1, 4000, `C10 for ${id}`);
  }
  await sleep(150);
  assert.equal(alice.got.some((m) => /collide/.test(m.text)), false);
  assert.equal(st.questions[q].status, "open");
  // The new copy answers.
  w.tg.say("postgres", { chat: NEWCHAT, reply: w.tg.replyTo(w.tg.cards()[1]) });
  await until(() => envs(alice, w.key).some((e) => e.kind === "answer" && e.text === "postgres"), 4000, "answer");
});

test("a 👍 still waiting for Telegram when B pairs: its refusal's fallback text is never sent to B", async (t) => {
  const w = await world(t);
  const { bridge } = await w.start();
  const alice = await agent(t, w.url, w.tokens.me, "me-alice");
  await sleep(100);
  w.tg.holdCalls.add("setMessageReaction");
  w.tg.say("@alice hi from A");
  await alice.waitFor((m) => m.from === "me-owner" && /hi from A/.test(m.text));
  await until(() => w.tg.heldCalls.length === 1, 4000, "the 👍 waits");
  w.tg.failNext.setMessageReaction = [400]; // refused once it goes
  paired(w.home, { user: OTHER, chat: OTHER, id: P2 });
  w.tg.releaseCalls();
  w.tg.say("/help", { from: OTHER, chat: OTHER });
  await until(() => bridge.state().outbox.length === 0 && w.tg.texts().some((x) => /^How this works:/.test(x)), 4000, "settled");
  await sleep(150);
  assert.equal(w.tg.texts().some((x) => /^✅ Sent to /.test(x)), false, "no fallback to anyone");
  assert.equal(Object.keys(bridge.state().routes).length, 0, "no route for B");
});

test("a reply to a closed card after a same-chat re-pair: refused as an earlier setup, nothing offered or sent", async (t) => {
  const w = await world(t);
  await w.start();
  const alice = await agent(t, w.url, w.tokens.me, "me-alice");
  await alice.ask("Closed?", { choices: ["yes", "no"] });
  await until(() => w.tg.cards().length === 1, 4000, "card");
  const card = w.tg.cards()[0];
  w.tg.press(card, 0);
  await until(() => envs(alice, w.key).some((e) => e.kind === "answer"), 4000, "answered");
  paired(w.home, { id: P2 }); // same user, same chat
  w.tg.say("again", { reply: w.tg.replyTo(card) });
  await until(() => w.tg.texts().includes("This message or button is from an earlier connection. Use /pending for questions or /msg to choose an agent."), 4000, "earlier setup");
  await sleep(150);
  assert.equal(w.tg.texts().some((x) => /^This question is already answered/.test(x)), false, "no confirm offered");
  assert.equal(alice.got.some((m) => /again/.test(m.text)), false);
});

test("a note still in the outbox is not admitted again when the relay redelivers it after its seen entry was evicted", async (t) => {
  const w = await world(t);
  let crash = true;
  const fault = (p) => {
    if (crash && p === "n-before-ack") {
      crash = false;
      throw new Crash(p);
    }
  };
  w.tg.failNext.sendMessage = Array(1000).fill(502); // Telegram is down: the note waits
  const a = await w.start({ fault });
  const alice = await agent(t, w.url, w.tokens.me, "me-alice");
  await alice.client.send("me-owner", "only once", undefined, undefined, { toMember: ME });
  assert.equal((await a.run).code, "crashed");
  // Seen-map pressure evicted the note's entry; the note itself is still in the outbox.
  const file = sig.channelPaths(w.home).state;
  const st = sig.readPrivateJson(file, 16 * 1024 * 1024);
  assert.equal(st.outbox.filter((e) => e.kind === "n").length, 1);
  st.notices_seen = {};
  sig.writePrivateJson(file, st);
  const b = await w.start();
  await sleep(500); // the relay redelivers the unconfirmed note
  assert.equal(b.bridge.state().outbox.filter((e) => e.kind === "n").length, 1, "admitted once");
  w.tg.failNext.sendMessage = [];
  w.tg.say("/help");
  await until(() => b.bridge.state().outbox.length === 0, 4000, "sent");
  assert.equal(w.tg.texts().filter((x) => /only once/.test(x)).length, 1);
});

test("an answered card's edit: the paired chat's copy is retried, another chat's copy is tried once", async (t) => {
  const w = await world(t);
  await w.start();
  const alice = await agent(t, w.url, w.tokens.me, "me-alice");
  await alice.ask("Two chats?", { choices: ["yes", "no"] });
  await until(() => w.tg.cards().length === 1, 4000, "card");
  const NEWCHAT = 5550999;
  paired(w.home, { user: OWNER_USER, chat: NEWCHAT, id: P2 });
  w.tg.say("/help", { chat: NEWCHAT });
  await until(() => w.tg.cards().length === 2, 4000, "copy in the new chat");
  let fails = 2;
  w.tg.failWhen = (method, params) => (method === "editMessageText" && params.chat_id === NEWCHAT && fails-- > 0 ? 502 : 0);
  w.tg.press(w.tg.cards()[1], 0, { chat: NEWCHAT });
  await until(() => envs(alice, w.key).some((e) => e.kind === "answer"), 4000, "answered");
  await until(() => w.tg.calls("editMessageText").some((c) => c.params.chat_id === NEWCHAT), 6000, "the new chat's copy edited");
  await sleep(300);
  assert.equal(w.tg.attempts.filter((c) => c.method === "editMessageText" && c.params.chat_id === OWNER_CHAT).length, 1, "the old chat's copy: one try");
});

test("the 21st copy's retirement edit waits, then a re-pair: the oldest copy is still retired visibly", async (t) => {
  const w = await world(t);
  const { bridge } = await w.start();
  const alice = await agent(t, w.url, w.tokens.me, "me-alice");
  const q = await alice.ask("Which copy?");
  await until(() => w.tg.cards().length === 1, 4000, "card");
  let last = 0;
  for (let i = 1; i <= 5; i++) {
    paired(w.home, { id: `p_${"abcde"[i - 1].repeat(16)}` });
    w.tg.say("/help");
    const before = w.tg.cards().length;
    await until(() => w.tg.cards().length === before + 1, 4000, `re-pair ${i}`);
    w.tg.say("/pending");
    await until(() => (w.tg.last(/^⏳ Waiting for you:/)?.message_id ?? 0) > last, 4000, "pending");
    const list = w.tg.last(/^⏳ Waiting for you:/);
    last = list.message_id;
    for (let k = 0; k < 3; k++) {
      if (i === 5 && k === 2) w.tg.failNext.editMessageText = Array(1000).fill(502); // the retirement edit waits
      const n = w.tg.cards().length;
      w.tg.press(list, 0);
      await until(() => w.tg.cards().length === n + 1, 4000, `show ${i}.${k}`);
    }
  }
  const oldest = w.tg.cards()[0];
  await until(() => bridge.state().questions[q].retiring?.length === 1, 4000, "retiring recorded");
  paired(w.home, { id: `p_${"f".repeat(16)}` }); // re-pair before the edit went through
  w.tg.failNext.editMessageText = [];
  w.tg.say("/help");
  await until(() => w.tg.calls("editMessageText").some((c) => c.params.message_id === oldest.message_id && c.params.text === "↩️ This question was sent again. Please answer the newest copy."), 6000, "oldest retired");
  await until(() => (bridge.state().questions[q].retiring ?? []).length === 0, 4000, "retiring cleared");
});

test("a card whose Telegram answer arrives after a re-pair to another chat: its route keeps the chat it was sent to", async (t) => {
  const w = await world(t);
  const { bridge } = await w.start();
  const alice = await agent(t, w.url, w.tokens.me, "me-alice");
  await sleep(100);
  w.tg.holdCalls.add("sendMessage");
  const q = await alice.ask("Held card?");
  await until(() => w.tg.heldCalls.length === 1, 4000, "the card is at Telegram");
  const NEWCHAT = 5550999;
  paired(w.home, { user: OWNER_USER, chat: NEWCHAT, id: P2 }); // same person, another chat, before the answer
  w.tg.releaseCalls();
  w.tg.say("/help", { chat: NEWCHAT });
  await until(() => w.tg.cards().some((c) => c.params.chat_id === NEWCHAT), 4000, "the card again, in the new chat");
  const first = w.tg.cards().find((c) => c.params.chat_id === OWNER_CHAT);
  const st = bridge.state();
  assert.deepEqual(st.questions[q].copies.find((c) => c.id === first.message_id), { chat: OWNER_CHAT, id: first.message_id });
  assert.equal(Object.values(st.routes).some((r) => r.chat === NEWCHAT && r.q === q && r.pairing === P2 && st.routes[String(first.message_id)] === r), false, "the old chat's card route is not rebound to the new chat");
  const n = w.tg.texts().filter((x) => x === LOST).length;
  w.tg.say("collide", { chat: NEWCHAT, reply: { message_id: first.message_id, text: "x" } });
  await until(() => w.tg.texts().filter((x) => x === LOST).length === n + 1, 4000, "C10");
  await sleep(150);
  assert.equal(w.tg.texts().some((x) => /^This question is/.test(x)), false, "no confirm offered");
  assert.equal(alice.got.some((m) => /collide/.test(m.text)), false);
});
