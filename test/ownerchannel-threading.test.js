// Threading (design 7.3, section 3, phase 3): a note that replies to an instruction the bridge sent
// to that same agent is shown as a Telegram reply to the owner's message that carried it, and it
// notifies (any age kept). Anything else (another agent, an unknown id, a one-way note, an earlier
// pairing) is shown unthreaded, under the usual notification rule. state.sent is bounded.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import * as sig from "../lib/ownersig.js";
import { MAX_SENT, SENT_MS } from "../lib/ownerchannel.js";
import { BOT_ID, ME, OWNER_USER, agent, bridgeOn, fakeTelegram, newKey, ownerRelay, paired, tmpHome, until } from "./owner-helpers.js";

const PAIRING = "p_abcdefghijklmnop"; // paired()'s default id
const notes = (tg) => tg.sent.filter((s) => s.method === "sendMessage" && /^💬 /.test(s.params.text));
const fromOwner = (a, text) => a.waitFor((x) => x.from === "me-owner" && JSON.parse(x.text).text === text);
/** A note from an agent session, optionally replying to a relay message id. */
const note = (a, text, replyTo) => a.client.send("me-owner", text, undefined, replyTo, { toMember: ME });

async function setup(t) {
  const r = await ownerRelay(t);
  const home = tmpHome(t);
  paired(home);
  const tg = fakeTelegram();
  const clock = { skew: 0 };
  const { bridge } = bridgeOn(t, { home, telegram: tg.client(), url: r.url, token: r.tokens.me, key: newKey(), now: () => Date.now() + clock.skew });
  await until(() => bridge.leading(), 4000, "leadership");
  return { ...r, home, tg, bridge, clock };
}

/** The owner writes `@alice <text>`; returns the owner's Telegram message and the relay message alice got. */
async function instruct(s, a, short, text) {
  s.tg.say(`@${short} ${text}`);
  const own = s.tg.updates.at(-1).message;
  const got = await fromOwner(a, text);
  await until(() => s.bridge.state().sent?.[got.message_id.toLowerCase()] && s.bridge.state().outbox.length === 0, 4000, "recorded");
  return { own, got };
}

test("a reply to the owner's instruction, from that agent: threaded under the owner's message and notifying, also after hours", async (t) => {
  const s = await setup(t);
  const alice = await agent(t, s.url, s.tokens.me, "me-alice");
  const { own, got } = await instruct(s, alice, "alice", "run the tests");
  const rec = s.bridge.state().sent[got.message_id.toLowerCase()];
  assert.deepEqual([rec.name, rec.member, rec.msg], ["me-alice", ME, own.message_id], "the relay id, its agent and the owner's message");
  s.clock.skew = 5 * 3600_000; // the one-hour rule alone would keep it silent
  await note(alice, "All 40 pass.", got.message_id);
  await until(() => notes(s.tg).length === 1, 4000, "note");
  const n = notes(s.tg)[0];
  assert.equal(n.params.text, "💬 alice:\nAll 40 pass.");
  assert.deepEqual(n.params.reply_parameters, { message_id: own.message_id, allow_sending_without_reply: true });
  assert.equal(n.params.disable_notification, undefined, "it notifies");
  // An ordinary note from alice now: unthreaded and silent (the owner wrote 5 hours ago).
  await note(alice, "Also, the docs build.");
  await until(() => notes(s.tg).length === 2, 4000, "second note");
  assert.equal(notes(s.tg)[1].params.reply_parameters, undefined);
  assert.equal(notes(s.tg)[1].params.disable_notification, true);
});

test("not threaded: another agent replying to that id, an unknown id, a one-way note", async (t) => {
  const s = await setup(t);
  const alice = await agent(t, s.url, s.tokens.me, "me-alice");
  const bob = await agent(t, s.url, s.tokens.me, "me-bob");
  const { got } = await instruct(s, alice, "alice", "check the build");
  s.clock.skew = 2 * 3600_000;
  // bob names alice's instruction: the relay does not attest bob received it.
  await note(bob, "I saw that too.", got.message_id);
  await note(alice, "Unknown reference.", crypto.randomUUID());
  await until(() => notes(s.tg).length === 2, 4000, "notes");
  for (const n of notes(s.tg)) {
    assert.equal(n.params.reply_parameters, undefined, n.params.text);
    assert.equal(n.params.disable_notification, true, n.params.text);
  }
  // A one-way note (a standalone send, noReply) that names the instruction: not threaded either.
  await new Promise((resolve) => {
    const m = { type: "message", id: crypto.randomUUID(), message_id: crypto.randomUUID(), reply_to: got.message_id, from: "me-alice", fromHost: "test", to: "me-owner", text: "one-off", ts: Date.now(), noReply: true, sender: { auth: "member", member: { id: ME, name: "me" } } };
    s.bridge.relay.emit("message", m, resolve);
  });
  await until(() => notes(s.tg).length === 3, 4000, "one-way note");
  assert.equal(notes(s.tg)[2].params.reply_parameters, undefined);
  assert.equal(notes(s.tg)[2].params.disable_notification, true);
});

test("an instruction sent from \"Who is this for?\" is threaded under the owner's typed message", async (t) => {
  const s = await setup(t);
  const alice = await agent(t, s.url, s.tokens.me, "me-alice");
  s.tg.say("deploy to staging");
  const own = s.tg.updates.at(-1).message;
  await until(() => s.tg.sent.some((x) => x.params.text === "Who is this for?"), 4000, "picker");
  const picker = s.tg.sent.find((x) => x.params.text === "Who is this for?");
  const b = picker.params.reply_markup.inline_keyboard.flat().find((x) => /^t:/.test(x.callback_data) && /alice/.test(x.text));
  s.tg.press(picker, 0, { data: b.callback_data, messageId: picker.message_id });
  const got = await fromOwner(alice, "deploy to staging");
  await until(() => s.bridge.state().sent?.[got.message_id.toLowerCase()], 4000, "recorded");
  assert.equal(s.bridge.state().sent[got.message_id.toLowerCase()].msg, own.message_id);
  await note(alice, "Deployed.", got.message_id);
  await until(() => notes(s.tg).length === 1, 4000, "note");
  assert.equal(notes(s.tg)[0].params.reply_parameters.message_id, own.message_id);
});

test("a new pairing forgets the sent instructions: a later reply to one is unthreaded", async (t) => {
  const s = await setup(t);
  const alice = await agent(t, s.url, s.tokens.me, "me-alice");
  const { got } = await instruct(s, alice, "alice", "start");
  paired(s.home, { id: "p_samepersonnewxyz" }); // the same owner pairs again
  s.clock.skew = 2 * 3600_000;
  // The note is the next event: the pairing change is reconciled first, which forgets state.sent.
  await note(alice, "Started.", got.message_id);
  await until(() => notes(s.tg).length === 1, 4000, "note");
  assert.deepEqual(s.bridge.state().sent, {});
  assert.equal(notes(s.tg)[0].params.reply_parameters, undefined);
  assert.equal(notes(s.tg)[0].params.disable_notification, true);
});

test("state.sent is bounded: entries end after 7 days, and at most 1,000 are kept (the closest to expiry go)", async (t) => {
  assert.equal(SENT_MS, 7 * 86400_000);
  assert.equal(MAX_SENT, 1000);
  const s = await setup(t);
  const alice = await agent(t, s.url, s.tokens.me, "me-alice");
  const { got } = await instruct(s, alice, "alice", "first");
  s.clock.skew = SENT_MS + 60_000;
  await s.bridge.tick();
  await until(() => Object.keys(s.bridge.state().sent).length === 0, 4000, "expired");
  await note(alice, "Late answer.", got.message_id);
  await until(() => notes(s.tg).length === 1, 4000, "note");
  assert.equal(notes(s.tg)[0].params.reply_parameters, undefined, "expired: unthreaded");
});

test("state.sent cap: with 1,000 kept, a new instruction evicts the one closest to expiry", async (t) => {
  const r = await ownerRelay(t);
  const home = tmpHome(t);
  paired(home);
  const t0 = Date.now();
  const sent = {};
  for (let i = 0; i < MAX_SENT; i++) sent[crypto.randomUUID()] = { name: "me-old", member: ME, pairing: PAIRING, msg: i + 1, exp: t0 + 3600_000 + i * 1000 };
  const oldest = Object.keys(sent)[0];
  sig.writePrivateJson(sig.channelPaths(home).state, { v: 1, bot_id: BOT_ID, offset: 0, recent: [], drops: {}, questions: {}, outbox: [], targets: {}, routes: {}, owner: { user_id: OWNER_USER, pairing: PAIRING }, sent });
  const tg = fakeTelegram();
  const { bridge } = bridgeOn(t, { home, telegram: tg.client(), url: r.url, token: r.tokens.me, key: newKey() });
  await until(() => bridge.leading(), 4000, "leadership");
  assert.equal(Object.keys(bridge.state().sent).length, MAX_SENT, "kept across a restart");
  const alice = await agent(t, r.url, r.tokens.me, "me-alice");
  const s = { tg, bridge };
  const { got } = await instruct(s, alice, "alice", "one more");
  await until(() => bridge.state().sent[got.message_id.toLowerCase()], 4000, "recorded");
  const now = bridge.state().sent;
  assert.equal(Object.keys(now).length, MAX_SENT);
  assert.equal(Object.hasOwn(now, oldest), false, "the one closest to expiry went");
});
