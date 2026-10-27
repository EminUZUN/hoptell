// /pending, Show, 👍 and routing by message id only (design 7.3, 2.4, 2.5 and C10): every open
// question is listed once over its pages, a page turn and Show work, an old page says so; the
// owner's message gets a 👍 and becomes a reply route (a silent "Sent to <agent>." when Telegram
// refuses the reaction); a reply is routed by the replied-to message id, never by its text. A fake
// Bot API on a real local relay.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as sig from "../lib/ownersig.js";
import { Crash, PENDING_PAGE, SHOW_PER_PAIRING } from "../lib/ownerchannel.js";
import { BOT_ID, ME, OWNER_USER, REALM, agent, bridgeOn, fakeTelegram, newKey, ownerRelay, paired, pinOf, tmpHome, until } from "./owner-helpers.js";
import { sleep } from "./helpers.js";

const verifyFor = (key, who) => (m) => sig.verifyEnvelope(m.text, { pin: pinOf(key), realm: REALM, sender: m.from, me: { name: who, member: ME } });
const envs = (a, key, who = "me-alice") => a.got.filter((m) => m.from === "me-owner").map((m) => verifyFor(key, who)(m)).filter((v) => v?.ok).map((v) => v.env);
const LOST = "I can't tell who that message was for. To answer a question, use /pending; to write to an agent, use /msg.";
const PAIRING = "p_abcdefghijklmnop";

async function world(t) {
  const r = await ownerRelay(t);
  const home = tmpHome(t);
  paired(home);
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

/** A state of this version with `count` open questions (more than the per-agent limit allows live). */
function withQuestions(home, count) {
  const t = Date.now();
  const questions = {};
  for (let i = 1; i <= count; i++) {
    const q = `${String(i).padStart(8, "0")}-1111-4111-8111-111111111111`;
    const asker = { name: i % 2 ? "me-alice" : "me-bob", realm: REALM, member: ME };
    const question = `Question text number ${i}: ${"please decide about this long topic ".repeat(4)}`;
    questions[q] = { q, qid: `q${String(i).padStart(11, "a")}`.slice(0, 12), num: i, asker, alias: "local", asked_at: t, expires_at: t + 3600_000, status: "open", copies: [], pairing: PAIRING, shows: {}, payload: { question, choices: ["yes", "no"] }, created: t - (count - i) * 60_000 };
  }
  sig.ensureChannelDir(home);
  sig.writePrivateJson(sig.channelPaths(home).state, { v: 1, bot_id: BOT_ID, offset: 0, recent: [], drops: {}, questions, outbox: [], targets: {}, routes: {}, owner: { user_id: OWNER_USER, pairing: PAIRING }, card_seq: count });
}

const keyboardOf = (tg, msg) => [...tg.sent].reverse().find((s) => (s.message_id === msg && s.method === "sendMessage") || (s.method === "editMessageText" && s.params.message_id === msg))?.params.reply_markup?.inline_keyboard ?? [];
const textOf = (tg, msg) => [...tg.sent].reverse().find((s) => (s.message_id === msg && s.method === "sendMessage") || (s.method === "editMessageText" && s.params.message_id === msg)).params.text;
const acks = (tg) => tg.calls("answerCallbackQuery").map((c) => c.params.text ?? null);

test("/pending: 40 open questions over 5 pages, each once and oldest first; Next and Back; an old page says so", async (t) => {
  const w = await world(t);
  withQuestions(w.home, 40);
  const { bridge } = await w.start();
  w.tg.say("/pending");
  await until(() => w.tg.last(/^⏳ Waiting for you:/), 4000, "the list");
  const list = w.tg.last(/^⏳ Waiting for you:/);
  const pages = Math.ceil(40 / PENDING_PAGE);
  assert.equal(pages, 5);
  const seen = [];
  let firstNav = null;
  for (let page = 1; page <= pages; page++) {
    const text = textOf(w.tg, list.message_id);
    assert.ok(text.length < 4096, `page ${page}: ${text.length}`);
    assert.ok(text.endsWith(`\nPage ${page} of ${pages}.`), text.split("\n").at(-1));
    const lines = text.split("\n").filter((l) => l.startsWith("• Question "));
    assert.equal(lines.length, PENDING_PAGE);
    for (const l of lines) assert.match(l, /^• Question \d+ · (alice|bob): "Question text number \d+: please decide.*…" \((just now|\d+ minutes? ago|\d+ hours? ago)\)$/);
    seen.push(...lines.map((l) => Number(l.match(/^• Question (\d+) /)[1])));
    const kb = keyboardOf(w.tg, list.message_id);
    assert.deepEqual(kb.slice(0, PENDING_PAGE).map((row) => row[0].text), lines.map((l) => `Show question ${l.match(/^• Question (\d+) /)[1]}`));
    for (const row of kb) for (const b of row) assert.match(b.callback_data, /^[sp]:[A-Za-z0-9_-]+$/, "opaque ids only");
    const nav = kb.at(-1).map((b) => b.text);
    assert.deepEqual(nav, page === 1 ? ["Next ▶"] : page === pages ? ["◀ Back"] : ["◀ Back", "Next ▶"]);
    if (page === 1) firstNav = kb.at(-1)[0].callback_data;
    if (page < pages) {
      const edits = w.tg.calls("editMessageText").length;
      w.tg.press(list, 0, { data: kb.at(-1).at(-1).callback_data });
      await until(() => w.tg.calls("editMessageText").length > edits, 4000, `page ${page + 1}`);
    }
  }
  assert.deepEqual(seen, Array.from({ length: 40 }, (_, i) => i + 1), "every question once, oldest first");
  // Back from the last page.
  const edits = w.tg.calls("editMessageText").length;
  w.tg.press(list, 0, { data: keyboardOf(w.tg, list.message_id).at(-1)[0].callback_data });
  await until(() => w.tg.calls("editMessageText").length > edits, 4000, "back");
  assert.ok(textOf(w.tg, list.message_id).endsWith("\nPage 4 of 5."));
  // The first page's Next button is gone from state: the list is old.
  w.tg.press(list, 0, { data: firstNav });
  await until(() => acks(w.tg).includes("This list is old. Send /pending for a new one."), 4000, "old page");
  // A new /pending retires the older list's buttons.
  w.tg.say("/pending");
  await until(() => w.tg.calls("sendMessage").filter((s) => /^⏳ Waiting for you:/.test(s.params.text)).length === 2, 4000, "a new list");
  await until(() => w.tg.calls("editMessageReplyMarkup").some((c) => c.params.message_id === list.message_id), 4000, "old buttons retired");
  assert.equal(bridge.state().outbox.length, 0);
});

test("/pending with nothing open; Show sends the card again, a limited number of times", async (t) => {
  const w = await world(t);
  const { bridge } = await w.start();
  w.tg.say("/pending");
  await until(() => w.tg.texts().includes("No questions are waiting for you."), 4000, "none");
  const alice = await agent(t, w.url, w.tokens.me, "me-alice");
  const q = await alice.ask("Deploy now?", { choices: ["yes", "no"] });
  await until(() => w.tg.cards().length === 1, 4000, "card");
  w.tg.say("/pending");
  await until(() => w.tg.last(/^⏳ Waiting for you:/), 4000, "list");
  const list = w.tg.last(/^⏳ Waiting for you:/);
  assert.match(list.params.text, /^⏳ Waiting for you:\n• Question 1 · alice: "Deploy now\?" \(just now\)$/);
  const show = list.params.reply_markup.inline_keyboard[0][0];
  assert.equal(show.text, "Show question 1");
  for (let i = 1; i <= SHOW_PER_PAIRING; i++) {
    w.tg.press(list, 0);
    await until(() => w.tg.cards().length === 1 + i, 4000, `shown ${i}`);
  }
  const shown = w.tg.cards().at(-1);
  assert.match(shown.params.text, /^❓ Question 1 · alice asks[^\n]*:\nDeploy now\?/);
  assert.equal(shown.params.disable_notification, true, "a shown card is silent");
  w.tg.press(list, 0);
  await until(() => acks(w.tg).includes("I've already sent this question again. Please reply to the newest copy."), 4000, "limit");
  assert.equal(w.tg.cards().length, 1 + SHOW_PER_PAIRING);
  assert.equal(bridge.state().questions[q].copies.length, 1 + SHOW_PER_PAIRING);
  // Any copy answers; then Show says the question is closed.
  w.tg.press(w.tg.cards()[1], 0);
  await until(() => envs(alice, w.key).some((e) => e.kind === "answer" && e.text === "yes"), 4000, "answer");
  await until(() => acks(w.tg).includes("✅ Sent."), 4000, "a button answer is acknowledged");
  w.tg.press(list, 0);
  await until(() => acks(w.tg).includes("Already answered."), 4000, "closed");
});

test("the owner's message gets a 👍 and becomes a reply route; a refused reaction falls back to a silent text", async (t) => {
  const w = await world(t);
  const { bridge } = await w.start();
  const alice = await agent(t, w.url, w.tokens.me, "me-alice");
  const bob = await agent(t, w.url, w.tokens.me, "me-bob");
  const u = w.tg.say("@alice please run the tests");
  await alice.waitFor((m) => m.from === "me-owner" && /please run the tests/.test(m.text));
  await until(() => w.tg.calls("setMessageReaction").length === 1, 4000, "👍");
  const react = w.tg.calls("setMessageReaction")[0].params;
  assert.equal(react.message_id, u.message.message_id);
  assert.deepEqual(react.reaction, [{ type: "emoji", emoji: "👍" }]);
  assert.equal(w.tg.texts().some((x) => /^✅ Sent to /.test(x)), false, "no text when the 👍 worked");
  // A reply to the owner's own message goes to the same agent.
  w.tg.say("and the linter", { reply: { message_id: u.message.message_id, text: "@alice please run the tests" } });
  await alice.waitFor((m) => m.from === "me-owner" && /and the linter/.test(m.text));
  await until(() => w.tg.calls("setMessageReaction").length === 2, 4000, "the second 👍"); // before the next one is refused
  // A refused reaction: "✅ Sent to alice." in reply, silent, itself a route.
  w.tg.failNext.setMessageReaction = [400];
  const u2 = w.tg.say("@alice one more thing");
  await alice.waitFor((m) => m.from === "me-owner" && /one more thing/.test(m.text));
  await until(() => w.tg.last(/^✅ Sent to alice\.$/), 4000, "fallback");
  const fb = w.tg.last(/^✅ Sent to alice\.$/);
  assert.equal(fb.params.reply_parameters?.message_id ?? fb.params.reply_to_message_id, u2.message.message_id);
  assert.equal(fb.params.disable_notification, true);
  w.tg.say("via the fallback", { reply: w.tg.replyTo(fb) });
  await alice.waitFor((m) => m.from === "me-owner" && /via the fallback/.test(m.text));
  w.tg.say("via the owner message", { reply: { message_id: u2.message.message_id, text: "@alice one more thing" } });
  await alice.waitFor((m) => m.from === "me-owner" && /via the owner message/.test(m.text));
  assert.equal(bob.got.length, 0);
  // The last 👍 may still be on its way when alice has the message (slow under load).
  await until(() => bridge.state().outbox.length === 0, 4000, "the outbox drained");
});

test("a reply to a closed card asks first; Cancel sends nothing", async (t) => {
  const w = await world(t);
  await w.start();
  const alice = await agent(t, w.url, w.tokens.me, "me-alice");
  await alice.ask("Which day?");
  await until(() => w.tg.cards().length === 1, 4000, "card");
  const card = w.tg.cards()[0];
  const u = w.tg.say("Friday", { reply: w.tg.replyTo(card) });
  await until(() => envs(alice, w.key).some((e) => e.kind === "answer"), 4000, "answer");
  await until(() => w.tg.calls("setMessageReaction").some((c) => c.params.message_id === u.message.message_id), 4000, "👍 on a reply answer");
  w.tg.say("and Monday", { reply: w.tg.replyTo(card) });
  await until(() => w.tg.last(/^This question is already answered/), 4000, "confirm");
  const confirm = w.tg.last(/^This question is already answered/);
  const [send, cancel] = confirm.params.reply_markup.inline_keyboard[0];
  assert.equal(cancel.text, "Cancel");
  assert.match(cancel.callback_data, /^x:/);
  w.tg.press(confirm, 0, { data: cancel.callback_data });
  await until(() => w.tg.calls("editMessageText").some((c) => c.params.message_id === confirm.message_id && c.params.text === "Cancelled. Nothing was sent."), 4000, "cancelled");
  w.tg.press(confirm, 0, { data: send.callback_data }); // too late: the held text is gone
  await until(() => acks(w.tg).filter(Boolean).length >= 1, 4000, "ack");
  await sleep(200);
  assert.equal(alice.got.filter((m) => /and Monday/.test(m.text)).length, 0, "nothing was sent");
});

test("routing by message id only: a copy lost in a crash, a note that looks like a card, a pasted card", async (t) => {
  const w = await world(t);
  const crashed = new Set();
  const fault = (p) => {
    if (p !== "card-sent") return;
    const k = w.tg.cards().at(-1).params.text.split("\n").filter((l) => !l.startsWith("Sent again"))[1]; // the question
    if (!crashed.has(k)) {
      crashed.add(k);
      throw new Crash(p);
    }
  };
  const alice = await agent(t, w.url, w.tokens.me, "me-alice");
  const bob = await agent(t, w.url, w.tokens.me, "me-bob");
  const b1 = await w.start({ fault });
  const qa = await alice.ask("Tap question?", { choices: ["go", "stop"] });
  assert.equal((await b1.run).code, "crashed");
  const b2 = await w.start({ fault });
  await until(() => w.tg.cards().length === 2, 4000, "the tap card again");
  const qb = await alice.ask("Reply question?");
  assert.equal((await b2.run).code, "crashed");
  const b3 = await w.start();
  await until(() => w.tg.cards().length === 4 && b3.bridge.state().questions[qb]?.copies.length === 1, 4000, "the reply card again");
  const st = b3.bridge.state();
  assert.equal(st.questions[qa].copies.length, 1, "the crash-lost copy was never recorded");
  const [tapLost, , replyLost, replyNew] = w.tg.cards();
  // A reply to the lost copy routes nowhere; to the recorded copy it answers.
  w.tg.say("from the lost copy", { reply: w.tg.replyTo(replyLost) });
  await until(() => w.tg.texts().includes(LOST), 4000, "C10");
  w.tg.say("from the new copy", { reply: w.tg.replyTo(replyNew) });
  await until(() => envs(alice, w.key).some((e) => e.kind === "answer" && e.q === qb && e.text === "from the new copy"), 4000, "answer by reply");
  // A tap on the lost copy still answers: the button carries the question's own id.
  w.tg.press(tapLost, 1);
  await until(() => envs(alice, w.key).some((e) => e.kind === "answer" && e.q === qa && e.text === "stop"), 4000, "answer by tap");
  // A note whose text looks like another agent's card or carries a reference: the reply goes to its sender.
  await alice.client.send("me-owner", "Question 12 · bob asks: ok? ref 1a2b3c4d", undefined, undefined, { toMember: ME });
  await until(() => w.tg.last(/^💬 alice:/), 4000, "note");
  w.tg.say("for alice", { reply: w.tg.replyTo(w.tg.last(/^💬 alice:/)) });
  await alice.waitFor((m) => m.from === "me-owner" && /for alice/.test(m.text));
  // A forwarded or pasted copy of a real card, under another message id, routes nowhere.
  const lost = w.tg.texts().filter((x) => x === LOST).length;
  w.tg.say("pasted", { reply: { message_id: 987654, text: replyNew.params.text } });
  await until(() => w.tg.texts().filter((x) => x === LOST).length === lost + 1, 4000, "C10 again");
  await sleep(200);
  assert.equal(bob.got.length, 0, "never to the agent a text names");
  assert.equal(alice.got.some((m) => /from the lost copy|pasted/.test(m.text)), false);
});
