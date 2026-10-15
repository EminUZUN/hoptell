// Settings changed in the app (design 7.4, section 7): shown first, then applied; crashes at every
// boundary, revocation, other writers, Undo and the alias rules (tests of section 11, "Settings",
// "Crash plus revocation", "Settings writers").
import { test } from "node:test";
import assert from "node:assert/strict";
import { Crash, readAudit } from "../lib/ownerchannel.js";
import { bump, updatePeople } from "../lib/ownerpeople.js";
import { ME, OWNER_USER, agent, appClient, appSet, bridgeOn, fakeTelegram, newKey, newOp, ownerRelay, paired, peopleOf, tmpHome, until } from "./owner-helpers.js";
import { sleep } from "./helpers.js";

/** A paired bridge with the app on and own agents alice and bob; restart() starts a new bridge on the same home. */
async function harness(t, { crashAt = null } = {}) {
  const r = await ownerRelay(t, { ownerApp: true });
  const home = tmpHome(t);
  paired(home);
  appSet(home, "on", Date.now() - 120_000);
  await agent(t, r.url, r.tokens.me, "me-alice");
  await agent(t, r.url, r.tokens.me, "me-bob");
  const tg = fakeTelegram();
  const key = newKey();
  let fired = false;
  const fault = (p) => {
    if (p === crashAt && !fired) {
      fired = true;
      throw new Crash(p);
    }
  };
  const h = { r, home, tg, key, crashed: null, runs: 0 };
  const startOne = async (opts = {}) => {
    h.runs++;
    const b = bridgeOn(t, { home, telegram: tg.client(`run${h.runs}`), url: r.url, token: r.tokens.me, key, ...opts });
    b.run.then((x) => (h.crashed = x.code === "crashed" ? x : h.crashed));
    h.bridge = b.bridge;
    await until(() => b.bridge.appAvailable(), 4000, "the app registered");
    h.app = appClient(r.http, b.bridge.state().app.id);
    assert.equal((await h.app.open()).status, 200);
  };
  await startOne({ fault });
  h.restart = async () => {
    await h.bridge.stop();
    h.crashed = null;
    await startOne();
  };
  h.handle = async (label) => (await h.app.get("sessions")).json.sessions.find((x) => x.label === label).h;
  h.alice = () => peopleOf(home)["me-alice"] ?? {};
  h.lines = (re) => tg.sent.filter((s) => s.method === "sendMessage" && re.test(s.params.text));
  h.edited = (msg, text) => tg.calls("editMessageText").some((c) => c.params.message_id === msg && c.params.text === text);
  h.undoActive = () => Object.values(h.bridge.state().targets).some((x) => x.kind === "undo" && !x.pending);
  return h;
}
const FAV = /^From the app: alice is a favourite\.$/;
const cliSet = (home, name, fields, op = "cli:0123456789abcdef") => updatePeople(home, { member: ME, owner: OWNER_USER }, (s, entry) => bump(Object.assign(entry(name), fields), op));

test("settings: a crash before the commit write: nothing happens; the same op later takes effect once", async (t) => {
  const h = await harness(t, { crashAt: "app-commit" });
  const op = newOp();
  const hdl = await h.handle("alice");
  assert.equal((await h.app.post("prefs", { h: hdl, op, set: { fav: true } })).status, 503);
  await until(() => h.crashed, 4000, "crashed");
  await h.restart();
  await sleep(300);
  assert.equal(h.lines(FAV).length, 0);
  assert.equal(h.alice().fav, undefined);
  const again = await h.app.post("prefs", { h: await h.handle("alice"), op, set: { fav: true } });
  assert.deepEqual(again.json, { ok: true, pending: true });
  await until(() => h.alice().fav === true && h.undoActive(), 4000, "applied");
  assert.equal(h.lines(FAV).length, 1);
  assert.equal(h.alice().rev, 1);
  // Undo is bound to exactly the revision the change wrote.
  const u = Object.values(h.bridge.state().targets).find((x) => x.kind === "undo");
  assert.equal(u.rev, h.alice().rev);
  assert.equal(u.op, h.alice().last_op);
});

test("settings: a crash right after the commit: applied once after the restart; the same op from a new session answers the same, once", async (t) => {
  const h = await harness(t, { crashAt: "app-after-commit" });
  const op = newOp();
  assert.equal((await h.app.post("prefs", { h: await h.handle("alice"), op, set: { fav: true } })).status, 503);
  await until(() => h.crashed, 4000, "crashed");
  await h.restart();
  await until(() => h.alice().fav === true && h.undoActive(), 4000, "applied after the restart");
  const again = await h.app.post("prefs", { h: await h.handle("alice"), op, set: { fav: true } });
  assert.deepEqual(again.json, { ok: true, pending: true });
  await sleep(300);
  assert.equal(h.lines(FAV).length, 1);
  assert.equal(h.alice().rev, 1);
});

test("settings: a crash after Telegram took the line: the line again, applied once, its Undo works", async (t) => {
  const h = await harness(t, { crashAt: "app:line-sent" });
  await h.app.post("prefs", { h: await h.handle("alice"), op: newOp(), set: { fav: true } });
  await until(() => h.crashed, 4000, "crashed");
  assert.equal(h.alice().fav, undefined, "not applied before its line is recorded");
  await h.restart();
  await until(() => h.alice().fav === true && h.undoActive(), 4000, "applied");
  assert.equal(h.lines(FAV).length, 2, "at least once: the line twice");
  assert.equal(h.alice().rev, 1);
  h.tg.press(h.lines(FAV).at(-1), 0);
  await until(() => !h.alice().fav, 4000, "undone");
});

test("settings: a crash after the people.json write: finalised at the restart, Undo restores", async (t) => {
  const h = await harness(t, { crashAt: "app:people-written" });
  await h.app.post("prefs", { h: await h.handle("alice"), op: newOp(), set: { fav: true } });
  await until(() => h.crashed, 4000, "crashed");
  assert.equal(h.alice().fav, true);
  await h.restart();
  await until(() => h.undoActive(), 4000, "finalised");
  assert.equal(h.lines(FAV).length, 1);
  assert.equal(h.alice().rev, 1);
  h.tg.press(h.lines(FAV)[0], 0);
  await until(() => !h.alice().fav, 4000, "undone");
});

for (const action of ["off", "rotate"]) {
  test(`settings: written, crash, app --${action} from the CLI, restart: finalised, and its Undo restores`, async (t) => {
    const h = await harness(t, { crashAt: "app:people-written" });
    await h.app.post("prefs", { h: await h.handle("alice"), op: newOp(), set: { hidden: true } });
    await until(() => h.crashed, 4000, "crashed");
    await h.bridge.stop();
    appSet(h.home, action);
    h.runs++;
    const b = bridgeOn(t, { home: h.home, telegram: h.tg.client("again"), url: h.r.url, token: h.r.tokens.me, key: h.key });
    h.bridge = b.bridge;
    await until(() => h.undoActive(), 4000, "finalised");
    const line = h.lines(/^From the app: alice is hidden\.$/)[0];
    assert.ok(!h.edited(line.message_id, "Not changed: the app was turned off."));
    h.tg.press(line, 0);
    await until(() => !h.alice().hidden, 4000, "undone with the app off");
  });

  test(`settings: not written yet, crash, app --${action}, restart: never applied, and its line says why`, async (t) => {
    const h = await harness(t, { crashAt: "app:before-people" });
    await h.app.post("prefs", { h: await h.handle("alice"), op: newOp(), set: { hidden: true } });
    await until(() => h.crashed, 4000, "crashed");
    await h.bridge.stop();
    appSet(h.home, action);
    const b = bridgeOn(t, { home: h.home, telegram: h.tg.client("again"), url: h.r.url, token: h.r.tokens.me, key: h.key });
    h.bridge = b.bridge;
    const line = h.lines(/^From the app: alice is hidden\.$/)[0];
    const why = action === "off" ? "Not changed: the app was turned off." : "Not changed: the app link was changed.";
    await until(() => h.edited(line.message_id, why), 4000, "the line says why");
    assert.equal(h.alice().hidden, undefined);
    assert.equal(b.bridge.state().outbox.length, 0);
  });
}

test("settings: Telegram refuses the line: never applied (dropped app_pref_unseen); unreachable: it waits, then applies", async (t) => {
  const h = await harness(t);
  h.tg.failNext.sendMessage = [403];
  await h.app.post("prefs", { h: await h.handle("alice"), op: newOp(), set: { fav: true } });
  await until(() => h.bridge.state().drops.app_pref_unseen === 1, 4000, "dropped");
  assert.equal(h.alice().fav, undefined);
  assert.ok(readAudit(h.home).some((e) => e.event === "dropped" && e.reason === "app_pref_unseen"));
  let down = true;
  h.tg.failWhen = (method, params) => (down && method === "sendMessage" && /^From the app/.test(params.text) ? 502 : 0);
  await h.app.post("prefs", { h: await h.handle("bob"), op: newOp(), set: { fav: true } });
  await sleep(600);
  assert.equal(peopleOf(h.home)["me-bob"]?.fav, undefined, "waits with its line");
  // The bot is not held meanwhile.
  h.tg.say("/help");
  await until(() => h.tg.last(/\/msg/), 4000, "the bot answers");
  down = false;
  await until(() => peopleOf(h.home)["me-bob"]?.fav === true, 6000, "applied once Telegram is back");
});

test("settings: another writer changes the entry first: not applied, the line says so, its Undo does nothing", async (t) => {
  const h = await harness(t);
  h.tg.holdCalls.add("sendMessage");
  await h.app.post("prefs", { h: await h.handle("alice"), op: newOp(), set: { fav: true } });
  await until(() => h.tg.heldCalls.length, 4000, "the line waits");
  // The same values, set first by the bot (or the CLI): another last_op.
  await cliSet(h.home, "me-alice", { fav: true }, "bot:77");
  h.tg.releaseCalls();
  const line = await (async () => {
    await until(() => h.lines(FAV).length, 4000, "line");
    return h.lines(FAV)[0];
  })();
  await until(() => h.edited(line.message_id, "Not changed: a newer change was made to this setting."), 4000, "the line says so");
  assert.equal(h.alice().last_op, "bot:77");
  assert.equal(h.alice().rev, 1);
  h.tg.press(line, 0);
  await sleep(300);
  assert.equal(h.alice().fav, true, "Undo does nothing");
});

test("settings: Undo after a second change, and after a change away and back, refuses and writes nothing", async (t) => {
  const h = await harness(t);
  await h.app.post("prefs", { h: await h.handle("alice"), op: newOp(), set: { fav: true } });
  await until(() => h.undoActive(), 4000, "finalised");
  await cliSet(h.home, "me-alice", { fav: false });
  await cliSet(h.home, "me-alice", { fav: true });
  const line = h.lines(FAV)[0];
  h.tg.press(line, 0);
  await until(() => h.tg.calls("answerCallbackQuery").some((c) => c.params.text === "I couldn't undo this because the setting changed again. Open the app to check."), 4000, "refused");
  assert.equal(h.alice().fav, true);
  assert.equal(h.alice().rev, 3, "a new revision each time, also after the entry was emptied");
});

test("settings: names follow the alias rules; two pending changes to the same name: the second is not applied", async (t) => {
  const h = await harness(t);
  const a = await h.handle("alice");
  const b = await h.handle("bob");
  assert.equal((await h.app.post("prefs", { h: a, op: newOp(), set: { alias: "@main" } })).json.error, "alias");
  assert.equal((await h.app.post("prefs", { h: a, op: newOp(), set: { alias: "bob" } })).json.text, "That name is already used by another agent. Pick another.");
  assert.equal((await h.app.post("prefs", { h: a, op: newOp(), set: { alias: "x".repeat(25) } })).json.error, "alias");
  assert.equal((await h.app.post("prefs", { h: a, op: newOp(), set: { alias: "a‮b" } })).json.error, "alias");
  h.tg.holdCalls.add("sendMessage");
  assert.equal((await h.app.post("prefs", { h: a, op: newOp(), set: { alias: "Main" } })).json.ok, true);
  assert.equal((await h.app.post("prefs", { h: b, op: newOp(), set: { alias: "Main" } })).json.ok, true);
  h.tg.releaseCalls();
  await until(() => h.lines(/^From the app: bob is now called Main\.$/).length, 4000, "both lines");
  const second = h.lines(/^From the app: bob is now called Main\.$/)[0];
  await until(() => h.edited(second.message_id, "Not changed: that name is now used by another agent."), 4000, "the second says so");
  assert.equal(h.alice().alias, "Main");
  assert.equal(peopleOf(h.home)["me-bob"]?.alias, undefined);
});

test("settings: Remove name clears the name and its computer; Undo restores both", async (t) => {
  const h = await harness(t, {});
  await cliSet(h.home, "me-alice", { alias: "prod", alias_host: "laptop" });
  const hdl = (await h.app.get("sessions")).json.sessions.find((x) => x.logical === "alice").h;
  const r = await h.app.post("prefs", { h: hdl, op: newOp(), set: { alias: null } });
  assert.deepEqual(r.json, { ok: true, pending: true });
  await until(() => h.alice().alias === undefined && h.undoActive(), 4000, "removed and finalised");
  assert.equal(h.alice().alias_host, undefined);
  const line = h.lines(/^From the app: .* no longer has a custom name\.$/).at(-1);
  assert.ok(line, "the line");
  h.tg.press(line, 0);
  await until(() => h.alice().alias === "prod", 4000, "undone");
  assert.equal(h.alice().alias_host, "laptop");
});

test("settings: at people.json's cap, a newly seen agent never pushes out an entry whose Undo is live: Remove name, a new agent, Undo restores", async (t) => {
  const h = await harness(t, {});
  await updatePeople(h.home, { member: ME, owner: OWNER_USER }, (_, entry) => {
    for (let i = 0; i < 1999; i++) bump(Object.assign(entry(`me-f${String(i).padStart(4, "0")}`), { fav: true }), "cli:0123456789abcdef");
    bump(Object.assign(entry("me-alice"), { alias: "prod" }), "cli:0123456789abcdef");
  });
  let hdl = null;
  for (let path = "sessions"; path && !hdl; ) {
    const r = (await h.app.get(path)).json;
    hdl = r.sessions.find((x) => x.logical === "alice")?.h ?? null;
    path = r.next === null ? null : `sessions/${r.next}`;
  }
  await h.app.post("prefs", { h: hdl, op: newOp(), set: { alias: null } });
  await until(() => h.alice().alias === undefined && h.undoActive(), 6000, "removed and finalised");
  // A signal for an agent seen for the first time, as the bridge records one, with the file full.
  await updatePeople(h.home, { member: ME, owner: OWNER_USER }, (_, entry) => {
    entry("me-newcomer").first_seen = Date.now();
  });
  const ppl = peopleOf(h.home);
  assert.ok(ppl["me-alice"], "the just-changed entry stays");
  assert.equal(ppl["me-newcomer"], undefined, "the newcomer is not added past the cap");
  h.tg.press(h.lines(/^From the app: .* no longer has a custom name\.$/).at(-1), 0);
  await until(() => h.alice().alias === "prod", 4000, "undone");
});
