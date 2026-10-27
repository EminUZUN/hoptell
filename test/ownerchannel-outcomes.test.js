// The bridge's side effects and their outcomes (design 7.2, "Leadership", "Commit order", and
// the `undeliverable` status): a Telegram call in flight when the claim is lost or the bridge
// stops is aborted and never applied, and the home's lock waits for it; a send the relay refuses
// replaces the steps that assumed success; a card Telegram refuses for good closes the question
// and tells the asker once; a pairing redelivered after a crash gets the same acknowledgement.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Crash, readPairing, newPairingCode } from "../lib/ownerchannel.js";
import { RelayClient } from "../lib/client.js";
import * as sig from "../lib/ownersig.js";
import { BOT_ID, OWNER_CHAT, ME, REALM, agent, bridgeOn, fakeTelegram, newKey, ownerRelay, paired, pinOf, tmpHome, until } from "./owner-helpers.js";
import { sleep } from "./helpers.js";

/** A relay client whose sends to the names in `refuse` are refused by "the relay" for good. */
const refusingFactory = (refuse) => (o) => {
  const c = new RelayClient(o);
  const send = c.send.bind(c);
  c.send = async (to, ...rest) => {
    if (refuse.has(to)) throw Object.assign(new Error(`unknown peer ${to}`), { kind: "relay_error" });
    return send(to, ...rest);
  };
  return c;
};

const statuses = (a) => a.got.filter((m) => m.from === "me-owner").map((m) => JSON.parse(m.text)).filter((e) => e.kind === "status");

test("a card in flight when the bridge stops: the lock waits for it, its result is not applied, the next run re-sends it", async (t) => {
  const { url, tokens } = await ownerRelay(t);
  const home = tmpHome(t);
  paired(home);
  const tg = fakeTelegram();
  const key = newKey();
  const a = bridgeOn(t, { home, telegram: tg.client("a"), url, token: tokens.me, key });
  await until(() => a.bridge.leading(), 4000, "leader");
  tg.holdCalls.add("sendMessage");
  tg.ignoreAbort = true; // the request is already on its way
  const alice = await agent(t, url, tokens.me, "me-alice");
  const q = await alice.ask("Held card?");
  await until(() => tg.heldCalls.length === 1, 4000, "card held");
  const stopping = a.bridge.stop();
  await until(() => tg.aborted.includes("sendMessage"), 2000, "the call was aborted");
  // The old run's work has not settled: the home stays locked for a new run.
  const b = bridgeOn(t, { home, telegram: tg.client("b"), url, token: tokens.me, key });
  const r = await Promise.race([b.run, sleep(1500).then(() => ({ code: "started while the old call was in flight" }))]);
  assert.equal(r.code, "locked");
  tg.releaseCalls(); // Telegram carried the card out anyway
  assert.equal((await stopping).code, "stopped");
  assert.equal(tg.cards().length, 1);
  const s = a.bridge.state();
  assert.equal(s.questions[q].status, "pending", "the late result was not applied");
  assert.deepEqual(s.questions[q].copies, [], "no copy recorded");
  assert.equal(s.outbox.length, 1);
  // The next run on this home re-sends the card and opens the question with its message id.
  const c = bridgeOn(t, { home, telegram: tg.client("c"), url, token: tokens.me, key });
  await until(() => tg.cards().length === 2, 4000, "re-sent");
  assert.match(tg.cards()[1].params.text, /^❓ Question 1 · alice\nSent again: the first copy may not have arrived\.\n/);
  await until(() => c.bridge.state().questions[q].status === "open", 4000, "open");
  assert.deepEqual(c.bridge.state().questions[q].copies, [{ chat: OWNER_CHAT, id: tg.cards()[1].message_id }]);
});

test("an edit in flight when the claim is lost: aborted, the step not marked done; redone after the claim returns, the answer sent once", async (t) => {
  const { url, tokens } = await ownerRelay(t);
  const home = tmpHome(t);
  paired(home);
  const tg = fakeTelegram();
  const key = newKey();
  const { bridge } = bridgeOn(t, { home, telegram: tg.client(), url, token: tokens.me, key });
  await until(() => bridge.leading(), 4000, "leader");
  const alice = await agent(t, url, tokens.me, "me-alice");
  const q = await alice.ask("Edit held?");
  await until(() => tg.cards().length === 1, 4000, "card");
  tg.holdCalls.add("editMessageText");
  tg.say("yes", { reply: tg.replyTo(tg.cards()[0]) });
  await until(() => tg.heldCalls.length === 1, 4000, "edit held");
  bridge.relay.emit("down", "test: claim lost");
  assert.equal(bridge.leading(), false);
  await until(() => tg.aborted.includes("editMessageText"), 2000, "the edit was aborted");
  await sleep(100);
  const s = bridge.state();
  const entry = s.outbox.find((e) => e.kind === "u");
  assert.ok(entry, "the update's entry is still pending");
  assert.equal(entry.steps[entry.next].t, "edit", "the edit step is not marked done");
  assert.equal(tg.sent.filter((x) => x.method === "editMessageText").length, 0);
  // The claim comes back: the edit is redone, the answer is not sent again.
  tg.holdCalls.clear();
  bridge.relay.emit("ready");
  await until(() => bridge.state().outbox.length === 0, 4000, "outbox empty");
  assert.equal(tg.sent.filter((x) => x.method === "editMessageText").length, 1);
  await sleep(100);
  const answers = alice.got.filter((m) => m.from === "me-owner" && JSON.parse(m.text).kind === "answer");
  assert.equal(answers.length, 1);
  assert.equal(JSON.parse(answers[0].text).q, q);
});

test("a refused send replaces the success steps: no `Sent to`, no answered card, no `Answer sent`", async (t) => {
  const { url, tokens } = await ownerRelay(t);
  const home = tmpHome(t);
  paired(home);
  const tg = fakeTelegram();
  const refuse = new Set(["me-ghost"]);
  const { bridge } = bridgeOn(t, { home, telegram: tg.client(), url, token: tokens.me, key: newKey(), clientFactory: refusingFactory(refuse) });
  await until(() => bridge.leading(), 4000, "leader");
  // An instruction the relay refuses.
  tg.say("@me-ghost hello");
  await until(() => tg.texts().includes("Not sent: there is no agent called ghost right now."), 4000, "refusal");
  assert.equal(tg.texts().some((x) => /^✅ Sent to /.test(x)), false);
  assert.equal(tg.calls("setMessageReaction").length, 0, "no 👍");
  // A button answer whose asker the relay now refuses.
  const alice = await agent(t, url, tokens.me, "me-alice");
  const q1 = await alice.ask("Button?", { choices: ["a", "b"] });
  const q2 = await alice.ask("Reply?");
  await until(() => tg.cards().length === 2, 4000, "cards");
  refuse.add("me-alice");
  const [c1, c2] = [tg.cards().find((c) => /Button\?/.test(c.params.text)), tg.cards().find((c) => /Reply\?/.test(c.params.text))];
  tg.press(c1, 0);
  tg.say("my reply", { reply: tg.replyTo(c2) });
  await until(() => bridge.state().outbox.length === 0 && bridge.state().offset >= 4, 4000, "done");
  const s = bridge.state();
  assert.deepEqual([s.questions[q1].status, s.questions[q2].status], ["undelivered", "undelivered"]);
  const acks = tg.sent.filter((x) => x.method === "answerCallbackQuery").map((x) => x.params.text);
  assert.deepEqual(acks, ["Not sent: there is no agent called alice right now."]);
  const edits = tg.sent.filter((x) => x.method === "editMessageText").map((x) => x.params.text);
  assert.equal(edits.length, 2);
  assert.ok(edits.every((x) => /^⚠️ Question \d · alice asked:\n(Button|Reply)\?\n\nYour answer could not be delivered: there is no agent called alice right now\.$/.test(x)), edits.join(" | "));
  assert.ok(tg.texts().some((x) => x === "Not sent: there is no agent called alice right now."), "the reply gets a refusal message");
  assert.equal(tg.calls("setMessageReaction").length, 0, "no 👍");
  assert.equal(alice.got.filter((m) => m.from === "me-owner").length, 0);
  // A later tap on the closed card says so and sends nothing.
  tg.press(c1, 1);
  await until(() => tg.sent.filter((x) => x.method === "answerCallbackQuery").length === 2, 4000, "late tap");
  assert.equal(tg.sent.filter((x) => x.method === "answerCallbackQuery").at(-1).params.text, "Your answer couldn't be delivered, so this question is closed.");
});

test("a card Telegram refuses for good (400, 403) closes Q as undeliverable and sends exactly one status; a retryable error keeps the card pending", async (t) => {
  const { url, tokens } = await ownerRelay(t);
  const home = tmpHome(t);
  paired(home);
  const tg = fakeTelegram();
  const key = newKey();
  const { bridge } = bridgeOn(t, { home, telegram: tg.client(), url, token: tokens.me, key, retryMs: 150 });
  await until(() => bridge.leading(), 4000, "leader");
  const alice = await agent(t, url, tokens.me, "me-alice");
  for (const status of [400, 403]) {
    tg.failNext.sendMessage = [status];
    const q = await alice.ask(`refused with ${status}?`);
    await until(() => statuses(alice).some((e) => e.q === q), 4000, `status for ${status}`);
    await bridge.tick();
    await sleep(200);
    const mine = statuses(alice).filter((e) => e.q === q);
    assert.equal(mine.length, 1, "exactly one status");
    assert.match(mine[0].text, /^undeliverable: your question .* could not be shown to your owner/);
    assert.equal(mine[0].nonce, sig.nonceOf(key, ["undeliverable", BOT_ID, q]), "the undeliverable nonce domain");
    assert.equal(sig.verifyEnvelope(alice.got.find((m) => m.from === "me-owner" && JSON.parse(m.text).q === q).text, { pin: pinOf(key), realm: REALM, sender: "me-owner", me: { name: "me-alice", member: ME } }).ok, true);
    const s = bridge.state();
    assert.equal(s.questions[q].status, "undeliverable");
    assert.equal(s.questions[q].payload, null);
    assert.equal(s.outbox.length, 0);
  }
  // 429 and 500: the card entry stays pending, Q stays pending, and the card is sent later.
  tg.failNext.sendMessage = [429, 500];
  const q = await alice.ask("retry me?");
  await until(() => tg.failNext.sendMessage.length === 0, 4000, "both failures used");
  const s = bridge.state();
  assert.equal(s.questions[q].status, "pending");
  assert.ok(s.outbox.some((e) => e.q === q && e.steps[0].t === "card"));
  await until(() => tg.cards().some((c) => /retry me\?/.test(c.params.text)), 4000, "card sent after the retry");
  await until(() => bridge.state().questions[q].status === "open", 4000, "open");
  assert.equal(statuses(alice).filter((e) => e.q === q).length, 0);
});

test("a crash after pairing.json is written but before the update is committed: the redelivery gets the same acknowledgement", async (t) => {
  const { url, tokens } = await ownerRelay(t);
  const home = tmpHome(t);
  const tg = fakeTelegram();
  const key = newKey();
  const code = await newPairingCode(home, BOT_ID);
  let crashed = false;
  const fault = (p) => {
    if (p === "pair-written" && !crashed) {
      crashed = true;
      throw new Crash(p);
    }
  };
  const a = bridgeOn(t, { home, telegram: tg.client("a"), url, token: tokens.me, key, fault });
  await until(() => a.bridge.leading(), 4000, "leader");
  tg.say(`/start ${code}`, { from: 42, chat: 42 });
  assert.equal((await a.run).code, "crashed");
  assert.equal(readPairing(home).paired.user_id, 42, "pairing.json was written");
  assert.equal(a.bridge.state().offset, 0, "the update was not committed");
  assert.equal(tg.texts().length, 0);
  const b = bridgeOn(t, { home, telegram: tg.client("b"), url, token: tokens.me, key });
  await until(() => b.bridge.state().offset === 2, 4000, "committed after the restart");
  await sleep(100);
  assert.equal(tg.texts().filter((x) => /^You're connected\. /.test(x)).length, 1, "acknowledged once");
  assert.equal(b.bridge.state().drops.pairing_code_wrong ?? 0, 0, "not counted as a wrong try");
  // A wrong try given again after a crash is counted once.
  const c2 = await newPairingCode(home, BOT_ID);
  assert.ok(c2);
  await b.bridge.stop();
  let crashed2 = false;
  const fault2 = (p) => {
    if (p === "pair-written" && !crashed2) {
      crashed2 = true;
      throw new Crash(p);
    }
  };
  const c = bridgeOn(t, { home, telegram: tg.client("c"), url, token: tokens.me, key, fault: fault2 });
  await until(() => c.bridge.leading(), 4000, "leader c");
  tg.say("/start WRONGXXX", { from: 42, chat: 42 });
  assert.equal((await c.run).code, "crashed");
  assert.equal(readPairing(home).pending.wrong, 1);
  const d = bridgeOn(t, { home, telegram: tg.client("d"), url, token: tokens.me, key });
  await until(() => d.bridge.state().offset === 3, 4000, "committed");
  assert.equal(readPairing(home).pending.wrong, 1, "counted once");
});

test("a paired home: the paired record names its update; an unrelated /start is not an acknowledgement", async (t) => {
  const { url, tokens } = await ownerRelay(t);
  const home = tmpHome(t);
  paired(home);
  const tg = fakeTelegram();
  const { bridge } = bridgeOn(t, { home, telegram: tg.client(), url, token: tokens.me, key: newKey() });
  await until(() => bridge.leading(), 4000, "leader");
  tg.say("/start");
  await until(() => bridge.state().offset === 2, 4000, "handled");
  assert.equal(tg.texts().some((x) => /^You're connected\. /.test(x)), false);
});

test("a bridge name the member token may not use stops the bridge with how to pick one", async (t) => {
  const { url, tokens } = await ownerRelay(t);
  const home = tmpHome(t);
  paired(home);
  const { run } = bridgeOn(t, { home, telegram: fakeTelegram().client(), url, token: tokens.me, key: newKey(), name: "owner" });
  const r = await run;
  assert.equal(r.code, "refused");
  assert.equal(r.message, 'the relay refused the bridge name owner: the bridge needs a member token, which may use only "me" or names that start with "me-" (4002)');
});
