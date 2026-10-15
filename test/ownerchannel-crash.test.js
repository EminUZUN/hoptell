// The bridge's commit orders under crashes (design 7.2, "Polling and durable state"): a button press
// and a reply race for one question, with a crash injected at every write and send boundary, then a
// restart on the same home. Exactly one answer (one nonce) reaches the agent, the first answer wins,
// and nothing is left in the outbox.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Crash } from "../lib/ownerchannel.js";
import { agent, bridgeOn, fakeTelegram, newKey, ownerRelay, paired, tmpHome, until } from "./owner-helpers.js";
import { sleep } from "./helpers.js";

async function scenario(t, crashAt) {
  const { url, tokens } = await ownerRelay(t);
  const home = tmpHome(t);
  paired(home);
  const tg = fakeTelegram();
  const key = newKey();
  const seq = [];
  let hits = 0;
  const fault = (p) => {
    seq.push(p);
    if (++hits === crashAt) throw new Crash(p);
  };
  const a = bridgeOn(t, { home, telegram: tg.client("a"), url, token: tokens.me, key, fault });
  let crashed = null;
  a.run.then((r) => (crashed = r.code === "crashed" ? r : null));
  let b = null;
  const restart = async () => {
    await a.bridge.stop();
    b = bridgeOn(t, { home, telegram: tg.client("b"), url, token: tokens.me, key });
  };
  const current = () => b?.bridge ?? a.bridge;
  await until(() => a.bridge.leading() || crashed, 4000, "leader");
  if (crashed && !b) {
    // A crash at start (the first pairing's reconcile write): the next run takes over.
    await restart();
    await until(() => b.bridge.leading(), 4000, "leader after restart");
  }
  const alice = await agent(t, url, tokens.me, "me-alice");
  const q = await alice.ask("Which one?", { choices: ["postgres", "sqlite"] });
  await until(() => tg.cards().length || crashed, 4000, "card or crash");
  if (crashed && !b) {
    await restart();
    await until(() => tg.cards().length, 6000, "card after restart");
  }
  const card = tg.cards().at(-1);
  // The press first, the reply right after: one batch.
  tg.press(card, 0);
  tg.say("sqlite", { reply: tg.replyTo(card) });
  const finished = () => {
    try {
      const s = current().state();
      // The later answer finds the question answered, or (a reply to a copy whose message id was
      // never recorded, before a crash) is told the bridge cannot tell who it was for.
      const late = tg.texts().includes("This question is already answered. Send your text to alice as a new message?") || tg.texts().includes("I can't tell who that message was for. To answer a question, use /pending; to write to an agent, use /msg.") || tg.sent.some((x) => x.method === "answerCallbackQuery" && x.params.text === "Already answered.");
      return s.questions[q]?.status === "answered" && s.outbox.length === 0 && s.offset >= 3 && late;
    } catch {
      return false;
    }
  };
  await until(() => finished() || (crashed && !b), 6000, "finished or crashed");
  if (crashed && !b) {
    await restart();
    await until(finished, 8000, `finished after a crash at ${crashed.message}`);
  }
  await sleep(150);
  const answers = alice.got.filter((m) => m.from === "me-owner").map((m) => JSON.parse(m.text));
  assert.ok(answers.length >= 1, "the answer arrived");
  assert.equal(new Set(answers.map((x) => x.nonce)).size, 1, "a redone send carries the same nonce");
  assert.equal(answers[0].text, "postgres", "the first answer wins");
  assert.ok(tg.cards().length <= 2);
  if (tg.cards().length === 2) assert.match(tg.cards()[1].params.text, /^❓ Question 1 · alice asks \(sent again, the first copy may not have arrived\):\n/);
  await a.bridge.stop();
  await b?.bridge.stop();
  return { seq, crashed };
}

test("a reply and a button race for one question, with a crash at each boundary", async (t) => {
  const clean = await scenario(t, 0);
  assert.equal(clean.crashed, null);
  const points = clean.seq;
  assert.ok(points.includes("q-commit") && points.includes("q-before-ack") && points.includes("card-sent") && points.includes("u-commit") && points.includes("sent"), points.join(","));
  for (let i = 1; i <= points.length; i++) {
    await t.test(`crash at #${i} (${points[i - 1]})`, async (tt) => {
      const r = await scenario(tt, i);
      assert.ok(r.crashed, `crashed at ${points[i - 1]}`);
    });
  }
});

async function expiryScenario(t, crashAt) {
  const { url, tokens } = await ownerRelay(t);
  const home = tmpHome(t);
  paired(home);
  const tg = fakeTelegram();
  const key = newKey();
  const seq = [];
  let hits = 0;
  let armed = false; // crashes count only from the expiry on
  const fault = (p) => {
    if (!armed) return;
    seq.push(p);
    if (++hits === crashAt) throw new Crash(p);
  };
  let skew = 0;
  const now = () => Date.now() + skew;
  const a = bridgeOn(t, { home, telegram: tg.client("a"), url, token: tokens.me, key, fault, now });
  await until(() => a.bridge.leading());
  const alice = await agent(t, url, tokens.me, "me-alice");
  const q = await alice.ask("anyone?", { expiresIn: 300 });
  await until(() => tg.cards().length === 1);
  armed = true;
  skew = 301_000;
  await a.bridge.tick();
  const r = await Promise.race([a.run, sleep(500).then(() => null)]);
  let b = null;
  if (r?.code === "crashed") {
    b = bridgeOn(t, { home, telegram: tg.client("b"), url, token: tokens.me, key, now });
    await until(() => b.bridge.leading());
    await b.bridge.tick();
  }
  const cur = b?.bridge ?? a.bridge;
  await until(() => cur.state().outbox.length === 0 && cur.state().questions[q].status === "expired", 6000, "expired and sent");
  await sleep(100);
  const statuses = alice.got.filter((m) => m.from === "me-owner").map((m) => JSON.parse(m.text));
  assert.ok(statuses.length >= 1);
  assert.equal(new Set(statuses.map((x) => x.nonce)).size, 1, "one status, redone with its nonce");
  assert.match(statuses[0].text, /^expired: /);
  await a.bridge.stop();
  await b?.bridge.stop();
  return { seq, crashed: r?.code === "crashed" };
}

test("expiry's status goes through the outbox: a crash at each boundary sends it once (one nonce)", async (t) => {
  const clean = await expiryScenario(t, 0);
  for (let i = 1; i <= clean.seq.length; i++) {
    await t.test(`crash at #${i} (${clean.seq[i - 1]})`, async (tt) => {
      assert.equal((await expiryScenario(tt, i)).crashed, true);
    });
  }
});

test("a question redelivered under the same reference (crash before the relay ack) produces nothing extra", async (t) => {
  const { url, tokens } = await ownerRelay(t);
  const home = tmpHome(t);
  paired(home);
  const tg = fakeTelegram();
  const key = newKey();
  const fault = (p) => {
    if (p === "q-before-ack") throw new Crash(p);
  };
  const a = bridgeOn(t, { home, telegram: tg.client("a"), url, token: tokens.me, key, fault });
  await until(() => a.bridge.leading());
  const alice = await agent(t, url, tokens.me, "me-alice");
  const q = await alice.ask("once?");
  assert.equal((await a.run).code, "crashed");
  assert.equal(tg.cards().length, 0);
  const b = bridgeOn(t, { home, telegram: tg.client("b"), url, token: tokens.me, key });
  await until(() => tg.cards().length === 1, 6000, "the card from the stored record");
  await sleep(300);
  const s = b.bridge.state();
  assert.equal(tg.cards().length, 1, "no second card");
  assert.equal(tg.cards()[0].params.text.includes("sent again"), false);
  assert.deepEqual(Object.keys(s.questions), [q]);
  assert.equal(s.recent.length, 1, "no second quota use");
  assert.equal(alice.got.length, 0, "no status");
  assert.equal(s.outbox.length, 0);
});
