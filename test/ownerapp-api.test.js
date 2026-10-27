// The app's API at the bridge, end to end through the local relay (design 7.4, sections 5 and 7;
// tests of section 11, "The rule", "Settings", "Handles", "Questions").
import { test } from "node:test";
import assert from "node:assert/strict";
import { readAudit } from "../lib/ownerchannel.js";
import { APP_KEY, agent, appClient, appSet, bridgeOn, fakeTelegram, initData, newKey, newOp, ownerRelay, paired, peopleOf, tmpHome, until } from "./owner-helpers.js";
import { sleep } from "./helpers.js";

/** A paired bridge with the app on, an own agent "me-alice", and an app client with a session. */
async function setup(t, { relayLimits = {}, appLimits = null, before = null } = {}) {
  const r = await ownerRelay(t, { ownerApp: true, appLimits: relayLimits });
  const home = tmpHome(t);
  paired(home);
  appSet(home, "on", Date.now() - 120_000);
  before?.(home);
  const alice = await agent(t, r.url, r.tokens.me, "me-alice");
  const tg = fakeTelegram();
  const key = newKey();
  const { bridge } = bridgeOn(t, { home, telegram: tg.client(), url: r.url, token: r.tokens.me, key, ...(appLimits ? { appLimits } : {}) });
  await until(() => bridge.appAvailable(), 4000, "the app registered");
  const app = appClient(r.http, bridge.state().app.id);
  return { r, home, alice, tg, key, bridge, app };
}

const handleOf = async (app, label) => {
  const r = await app.get("sessions");
  assert.equal(r.status, 200, r.body);
  const s = r.json.sessions.find((x) => x.label === label);
  assert.ok(s, `${label} listed: ${r.body}`);
  return s.h;
};

test("app: a session from the owner's initData; the list ranks and labels like the picker, with handles, never names", async (t) => {
  const { app } = await setup(t);
  const o = await app.open();
  assert.equal(o.status, 200, o.body);
  assert.match(o.json.token, /^[A-Za-z0-9_-]{43}$/);
  const r = await app.get("sessions");
  assert.equal(r.status, 200);
  const s = r.json.sessions.find((x) => x.label === "alice");
  assert.ok(s);
  assert.match(s.h, /^[a-z2-7]{10}$/);
  assert.equal(s.online, true);
  assert.ok(!r.body.includes("me-alice"), "no wire name with the relay entry's prefix");
  // Without a token, or with another: refused.
  assert.equal((await app.get("sessions", null)).status, 401);
  assert.equal((await app.get("sessions", "x".repeat(43))).status, 401);
});

test("app: a draft becomes a confirmation in the chat; only the owner's tap sends it, once, to the handle's agent", async (t) => {
  const { app, tg, alice, bridge, home } = await setup(t);
  await app.open();
  const h = await handleOf(app, "alice");
  const text = "@bob /pending please check the build";
  const op = newOp();
  const d = await app.post("draft", { h, op, text });
  assert.deepEqual(d.json, { ok: true });
  await until(() => tg.last(/^✏️ From the app, to alice:/), 4000, "the confirmation");
  const c = tg.last(/^✏️ From the app, to alice:/);
  assert.equal(c.params.text, `✏️ From the app, to alice:\n${text}`);
  assert.equal(c.params.disable_notification, true);
  await sleep(300);
  assert.equal(alice.got.length, 0, "nothing sent before the tap");
  // The same op again: the same answer, no second confirmation.
  assert.deepEqual((await app.post("draft", { h, op, text })).json, { ok: true });
  await sleep(200);
  assert.equal(tg.texts().filter((x) => x.startsWith("✏️ From the app")).length, 1);
  // A tap from another user sends nothing; the owner's tap sends once.
  tg.press(c, 0, { from: 999 });
  await sleep(300);
  assert.equal(alice.got.length, 0);
  tg.press(c, 0);
  await alice.waitFor((m) => JSON.parse(m.text).text === text);
  const env = JSON.parse(alice.got[0].text);
  assert.equal(env.kind, "instruction");
  tg.press(c, 0);
  await sleep(300);
  assert.equal(alice.got.length, 1, "a second tap sends nothing");
  assert.ok(readAudit(home).some((e) => e.event === "app_draft" && e.to === "me-alice" && e.length === text.length));
  assert.ok(!JSON.stringify(readAudit(home)).includes("build"), "never the text in the audit");
  assert.equal(bridge.state().outbox.length, 0);
});

test("app: a settings change shows its line with Undo first, then applies; Undo restores", async (t) => {
  const { app, tg, home, bridge } = await setup(t);
  await app.open();
  const h = await handleOf(app, "alice");
  const p = await app.post("prefs", { h, op: newOp(), set: { fav: true } });
  assert.deepEqual(p.json, { ok: true, pending: true });
  await until(() => peopleOf(home)["me-alice"]?.fav === true, 4000, "applied");
  const line = tg.last(/^From the app: alice is a favourite and is shown in your lists\.$/);
  assert.ok(line);
  assert.equal(line.params.reply_markup.inline_keyboard[0][0].text, "Undo");
  // The list shows it.
  assert.equal((await app.get("sessions")).json.sessions.find((x) => x.h === h).fav, true);
  // Undo, once finalised.
  await until(() => Object.values(bridge.state().targets).some((x) => x.kind === "undo" && !x.pending), 4000, "Undo active");
  tg.press(line, 0);
  await until(() => !peopleOf(home)["me-alice"]?.fav, 4000, "undone");
  await until(() => tg.calls("editMessageText").some((c) => c.params.message_id === line.message_id && c.params.text === "Undone."), 4000, "the line says Undone.");
});

test("app: requests with more or other fields than allowed are refused; the page never sends a name", async (t) => {
  const { app } = await setup(t);
  await app.open();
  const h = await handleOf(app, "alice");
  assert.equal((await app.post("prefs", { h, op: newOp(), set: { fav: true, hidden: false } })).status, 400);
  assert.equal((await app.post("prefs", { h, op: newOp(), set: {} })).status, 400);
  assert.equal((await app.post("prefs", { h, op: newOp(), set: { fav: true }, name: "me-alice" })).status, 400);
  assert.equal((await app.post("draft", { h, op: newOp(), text: "hi", name: "me-alice" })).status, 400);
  assert.equal((await app.post("draft", { h, op: "short", text: "hi" })).status, 400);
  assert.equal((await app.post("draft", { h: "aaaaaaaaaa", op: newOp(), text: "hi" })).json.error, "stale");
  assert.equal((await app.post("draft", { h, op: newOp(), text: "x".repeat(3501) })).json.error, "too_long");
});

test("app: initData of another user, or signed with another bot's token, gets not_you; the key is the derived one", async (t) => {
  const { app } = await setup(t);
  assert.equal((await app.open(initData({ user: { id: 42, first_name: "X" } }))).json.error, "not_you");
  assert.equal((await app.open(initData({}, "7000002:AAHothertokenothertokenothertoken00"))).json.error, "not_you");
  assert.ok(Buffer.isBuffer(APP_KEY) && APP_KEY.length === 32);
});
