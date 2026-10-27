// The app's writes: the queue, deadlines, quotas, the op record, and questions; the bot is never
// held by app work (design 7.4, sections 5 and 7; tests of section 11, "Quotas and queue",
// "Replay and retry of writes", "Questions", "The rule").
import { test } from "node:test";
import assert from "node:assert/strict";
import { readAudit } from "../lib/ownerchannel.js";
import { agent, appClient, appSet, bridgeOn, fakeTelegram, newKey, newOp, ownerRelay, paired, peopleOf, tmpHome, until } from "./owner-helpers.js";
import { sleep } from "./helpers.js";

async function setup(t, { appLimits = null, relayLimits = {} } = {}) {
  const r = await ownerRelay(t, { ownerApp: true, appLimits: { perClient: { max: 1000, ms: 60_000 }, sessionPerClient: { max: 1000, ms: 60_000 }, ...relayLimits } });
  const home = tmpHome(t);
  paired(home);
  appSet(home, "on", Date.now() - 120_000);
  const alice = await agent(t, r.url, r.tokens.me, "me-alice");
  const tg = fakeTelegram();
  const key = newKey();
  const { bridge } = bridgeOn(t, { home, telegram: tg.client(), url: r.url, token: r.tokens.me, key, ...(appLimits ? { appLimits } : {}) });
  await until(() => bridge.appAvailable(), 4000, "the app registered");
  const app = appClient(r.http, bridge.state().app.id);
  await app.open();
  const h = (await app.get("sessions")).json.sessions.find((x) => x.label === "alice").h;
  /** Hold the bridge's serial queue: an owner instruction whose 👍 hangs in Telegram. */
  const holdQueue = async () => {
    tg.holdCalls.add("setMessageReaction");
    tg.say("@alice hold on");
    await until(() => tg.heldCalls.some((c) => c.method === "setMessageReaction"), 4000, "the queue held");
  };
  return { r, home, alice, tg, bridge, app, h, holdQueue };
}

test("queue: four writes wait for admission, a fifth gets 503 at once; the waiting ones are admitted in order", async (t) => {
  const s = await setup(t, { appLimits: { linesWaiting: 10 } });
  await s.holdQueue();
  const writes = [0, 1, 2, 3].map(() => s.app.post("prefs", { h: s.h, op: newOp(), set: { fav: true } }));
  await sleep(200);
  const fifth = await s.app.post("prefs", { h: s.h, op: newOp(), set: { fav: true } });
  assert.equal(fifth.status, 503);
  assert.equal(fifth.json.error, "busy");
  s.tg.releaseCalls();
  const done = await Promise.all(writes);
  assert.deepEqual(done.map((x) => x.status), [200, 200, 200, 200]);
});

test("queue: a write whose deadline passed before its turn is dropped without effect; the same op later is a new write", async (t) => {
  const s = await setup(t, { relayLimits: { timeoutMs: 1500 } });
  await s.holdQueue();
  const op = newOp();
  const r = await s.app.post("draft", { h: s.h, op, text: "too late" });
  assert.equal(r.status, 504);
  s.tg.releaseCalls();
  await sleep(400);
  assert.ok(!s.tg.last(/^✏️ From the app/), "nothing shown");
  assert.equal(s.bridge.state().app_ops[`p_abcdefghijklmnop:${op}`], undefined);
  assert.ok(readAudit(s.home).some((e) => e.event === "app_write" && e.dropped === "deadline"));
  const again = await s.app.post("draft", { h: s.h, op, text: "now" });
  assert.deepEqual(again.json, { ok: true });
  await until(() => s.tg.last(/^✏️ From the app, to alice:\nnow$/), 4000, "shown once");
});

test("queue: a write admitted just before its deadline completes", async (t) => {
  const s = await setup(t, { relayLimits: { timeoutMs: 2000 } });
  await s.holdQueue();
  const w = s.app.post("draft", { h: s.h, op: newOp(), text: "just in time" });
  // Released with about 0.8 s left of the relay's 2 s (the bridge keeps 0.5 s of margin).
  await sleep(1200);
  s.tg.releaseCalls();
  const r = await w;
  assert.ok(r.status === 200 || r.status === 504, String(r.status));
  await until(() => s.tg.last(/^✏️ From the app, to alice:\njust in time$/), 4000, "it completes");
});

test("queue: Telegram stalled for the app's 8 unfinished entries: more writes get 503, and the bot still answers questions at once", async (t) => {
  const s = await setup(t, { appLimits: { linesWaiting: 20, openDrafts: 20, draftsPerMin: 20 } });
  s.tg.holdWhen = (method, params) => method === "sendMessage" && /^(From the app|🙈 From the app|✏️)/.test(params.text ?? "");
  for (let i = 0; i < 8; i++) assert.equal((await s.app.post(i % 2 ? "draft" : "prefs", i % 2 ? { h: s.h, op: newOp(), text: `d${i}` } : { h: s.h, op: newOp(), set: { fav: i % 4 === 0 } })).status, 200, `write ${i}`);
  const ninth = await s.app.post("draft", { h: s.h, op: newOp(), text: "ninth" });
  assert.equal(ninth.status, 503);
  // A question and its answer by tap, while the app's Telegram calls hang.
  const q = await s.alice.ask("Which one?", { choices: ["a", "b"] });
  await until(() => s.tg.cards().length, 4000, "card");
  s.tg.press(s.tg.cards()[0], 1);
  const ans = await s.alice.waitFor((m) => m.q === q || JSON.parse(m.text).kind === "answer");
  assert.equal(JSON.parse(ans.text).text, "b");
  s.tg.releaseCalls();
  await until(() => s.bridge.state().outbox.filter((e) => e.origin === "a").length === 0, 8000, "the app's entries finish");
});

test("op record: the same op twice from one session, from a new session, and when full: one effect; a full record refuses new writes", async (t) => {
  const s = await setup(t, { appLimits: { opsMax: 2 } });
  const op = newOp();
  assert.deepEqual((await s.app.post("draft", { h: s.h, op, text: "once" })).json, { ok: true });
  assert.deepEqual((await s.app.post("draft", { h: s.h, op, text: "once" })).json, { ok: true });
  const other = appClient(s.r.http, s.bridge.state().app.id);
  await other.open();
  const h2 = (await other.get("sessions")).json.sessions[0].h;
  assert.deepEqual((await other.post("draft", { h: h2, op, text: "once" })).json, { ok: true });
  assert.equal((await s.app.post("prefs", { h: s.h, op: newOp(), set: { fav: true } })).status, 200);
  const full = await s.app.post("prefs", { h: s.h, op: newOp(), set: { hidden: true } });
  assert.equal(full.status, 503);
  // A replay of the oldest still answers its first result and does nothing.
  assert.deepEqual((await s.app.post("draft", { h: s.h, op, text: "once" })).json, { ok: true });
  await sleep(400);
  assert.equal(s.tg.texts().filter((x) => x === "✏️ From the app, to alice:\nonce").length, 1);
  assert.equal(peopleOf(s.home)["me-alice"]?.hidden, undefined);
});

test("drafts: at most 3 open at a time, counted from state (a new session does not reset it); a draft starting with @other goes to the handle's agent", async (t) => {
  const s = await setup(t);
  for (let i = 0; i < 3; i++) assert.deepEqual((await s.app.post("draft", { h: s.h, op: newOp(), text: `@bob ${i}` })).json, { ok: true });
  const other = appClient(s.r.http, s.bridge.state().app.id);
  await other.open();
  const h2 = (await other.get("sessions")).json.sessions[0].h;
  const four = await other.post("draft", { h: h2, op: newOp(), text: "four" });
  assert.equal(four.json.error, "drafts");
  assert.equal(four.json.text, "You already have 3 drafts waiting in the chat. Send or cancel one first.");
  await until(() => s.tg.texts().filter((x) => x.startsWith("✏️ From the app, to alice:\n@bob")).length === 3, 4000, "three");
  const c = s.tg.last(/^✏️ From the app, to alice:\n@bob 2$/);
  await until(() => Object.values(s.bridge.state().targets).filter((x) => x.kind === "confirm" && !x.pending).length === 3, 4000, "active");
  s.tg.press(c, 0);
  const m = await s.alice.waitFor((x) => JSON.parse(x.text).text === "@bob 2");
  assert.equal(JSON.parse(m.text).kind, "instruction");
  // Cancel sends nothing.
  s.tg.press(s.tg.last(/^✏️ From the app, to alice:\n@bob 1$/), 0, { data: s.tg.last(/^✏️ From the app, to alice:\n@bob 1$/).params.reply_markup.inline_keyboard[0][1].callback_data });
  await sleep(300);
  assert.equal(s.alice.got.length, 1);
});

test("drafts: expiry sends nothing and the message says so", async (t) => {
  let skew = 0;
  const r = await ownerRelay(t, { ownerApp: true });
  const home = tmpHome(t);
  paired(home);
  appSet(home, "on", Date.now() - 120_000);
  const alice = await agent(t, r.url, r.tokens.me, "me-alice");
  const tg = fakeTelegram();
  const { bridge } = bridgeOn(t, { home, telegram: tg.client(), url: r.url, token: r.tokens.me, key: newKey(), now: () => Date.now() + skew });
  await until(() => bridge.appAvailable(), 4000, "registered");
  const app = appClient(r.http, bridge.state().app.id);
  await app.open();
  const h = (await app.get("sessions")).json.sessions[0].h;
  await app.post("draft", { h, op: newOp(), text: "later" });
  await until(() => Object.values(bridge.state().targets).some((x) => x.kind === "confirm" && x.msg), 4000, "shown");
  const c = tg.last(/^✏️ From the app/);
  skew = 11 * 60_000;
  await bridge.tick();
  await until(() => tg.calls("editMessageText").some((x) => x.params.message_id === c.message_id && x.params.text === "Not sent: this draft expired."), 4000, "edited");
  tg.press(c, 0);
  await sleep(300);
  assert.equal(alice.got.length, 0);
});

test("the rule: a pairing change between a draft's commit and its run: nothing of app origin reaches the signer", async (t) => {
  const s = await setup(t);
  s.tg.holdCalls.add("sendMessage");
  await s.app.post("draft", { h: s.h, op: newOp(), text: "never" });
  await s.app.post("prefs", { h: s.h, op: newOp(), set: { fav: true } });
  await until(() => s.tg.heldCalls.length, 4000, "held");
  paired(s.home, { id: "p_zzzzzzzzzzzzzzzz" });
  s.tg.releaseCalls();
  await until(() => s.bridge.state().outbox.filter((e) => e.origin === "a").length === 0, 6000, "retired");
  const c = s.tg.last(/^✏️ From the app/);
  if (c) s.tg.press(c, 0);
  await sleep(400);
  assert.equal(s.alice.got.length, 0);
  assert.equal(peopleOf(s.home, { owner: 5550001 })["me-alice"]?.fav, undefined);
  assert.ok(!readAudit(s.home).some((e) => e.event === "instructed"));
});

test("questions: the list matches /pending; Show re-sends the card (3 per question), a closed one answers its text", async (t) => {
  const s = await setup(t);
  const q = await s.alice.ask("Deploy to prod?\nIt is Friday.", { choices: ["yes", "no"] });
  await until(() => s.tg.cards().length === 1, 4000, "card");
  const list = await s.app.get("questions");
  assert.equal(list.status, 200);
  assert.equal(list.json.questions.length, 1);
  const item = list.json.questions[0];
  assert.equal(item.asker, "alice");
  assert.deepEqual(item.choices, ["yes", "no"]);
  assert.ok(item.text.startsWith("Deploy to prod?"));
  assert.ok(!JSON.stringify(list.json).includes(q), "no question reference");
  for (let i = 0; i < 3; i++) assert.deepEqual((await s.app.post("questions/show", { n: item.n, op: newOp() })).json, { ok: true });
  await until(() => s.tg.cards().length === 4, 4000, "three copies");
  const fourth = await s.app.post("questions/show", { n: item.n, op: newOp() });
  assert.equal(fourth.json.text, "I've already sent this question again. Please reply to the newest copy.");
  s.tg.press(s.tg.cards().at(-1), 0);
  await s.alice.waitFor((m) => JSON.parse(m.text).kind === "answer");
  const closed = await s.app.post("questions/show", { n: item.n, op: newOp() });
  assert.equal(closed.json.error, "closed");
  assert.equal(closed.json.text, "Already answered.");
  assert.deepEqual((await s.app.get("questions")).json.questions, []);
});

test("questions: answered or expired while a copy from the app is on its way: the question stays closed, the late copy shows the closed view, a reply to it is handled", async (t) => {
  for (const close of ["answer", "expiry"]) {
    const s = await setup(t);
    const q = await s.alice.ask("Deploy to prod?", { choices: ["yes", "no"], expiresIn: close === "expiry" ? 2 : 3600 });
    await until(() => s.tg.cards().length === 1, 4000, "card");
    const n = (await s.app.get("questions")).json.questions[0].n;
    s.tg.holdWhen = (method, params) => method === "sendMessage" && /Deploy to prod\?/.test(params.text ?? "");
    assert.deepEqual((await s.app.post("questions/show", { n, op: newOp() })).json, { ok: true });
    await until(() => s.tg.heldCalls.length === 1, 4000, "the copy held");
    if (close === "answer") {
      s.tg.press(s.tg.cards()[0], 0);
      await s.alice.waitFor((m) => JSON.parse(m.text).kind === "answer");
    } else {
      await sleep(2100);
      await s.bridge.tick();
      await until(() => s.bridge.state().questions[q].status === "expired", 4000, "expired");
    }
    const want = close === "answer" ? "answered" : "expired";
    s.tg.releaseCalls();
    await until(() => s.tg.cards().length === 2, 4000, "the late copy");
    const late = s.tg.cards()[1];
    await until(() => s.tg.calls("editMessageText").some((c) => c.params.message_id === late.message_id), 4000, "the late copy edited");
    const st = s.bridge.state().questions[q];
    assert.equal(st.status, want, "never reopened");
    assert.equal(st.payload, null);
    const edit = s.tg.calls("editMessageText").filter((c) => c.params.message_id === late.message_id).at(-1);
    assert.equal(edit.params.text, st.view, "the closed view");
    // A reply to the late copy: handled as a reply to a closed card (no crash; the bridge leads on).
    s.tg.say("too late?", { reply: late });
    await sleep(300);
    assert.ok(s.bridge.leading());
    assert.equal(s.bridge.state().questions[q].status, want);
  }
});

test("questions: /app off while a Show waits for the names to be refreshed: no copy is sent", async (t) => {
  const s = await setup(t);
  await s.alice.ask("Deploy to prod?", { choices: ["yes", "no"] });
  await until(() => s.tg.cards().length === 1, 4000, "card");
  const n = (await s.app.get("questions")).json.questions[0].n;
  await sleep(5100); // the names are refreshed again only after 5 s
  const c = s.bridge.relay;
  const orig = c.list.bind(c);
  const waiting = [];
  c.list = async () => {
    await new Promise((r) => waiting.push(r));
    return orig();
  };
  assert.deepEqual((await s.app.post("questions/show", { n, op: newOp() })).json, { ok: true });
  await until(() => waiting.length > 0, 4000, "the refresh held");
  s.tg.say("/app off");
  await until(() => s.bridge.state().app.on === false, 4000, "off");
  c.list = orig;
  for (const r of waiting) r();
  await until(() => !s.bridge.state().outbox.some((e) => e.origin === "a"), 4000, "the Show retired");
  await sleep(200);
  assert.equal(s.tg.cards().length, 1, "no copy after the app was turned off");
});
