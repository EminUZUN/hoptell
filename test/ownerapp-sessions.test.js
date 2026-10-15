// App sessions, their binding and revocation (design 7.4, sections 4 and 5; tests of section 11,
// "Sessions", "Revocation edges", "Rate limits", "Handles", "Early taps", "Old relay").
import { test } from "node:test";
import assert from "node:assert/strict";
import { Crash, readAudit } from "../lib/ownerchannel.js";
import { withLock } from "../lib/locks.js";
import { peoplePath } from "../lib/ownerpeople.js";
import { agent, appClient, appSet, bridgeOn, fakeTelegram, httpRequest, initData, newKey, newOp, ownerRelay, paired, peopleOf, tmpHome, until } from "./owner-helpers.js";
import { sleep } from "./helpers.js";

async function setup(t, { appLimits = null, relayLimits = {}, ownerApp = true, clock = null, fault = null, maxTargets = null } = {}) {
  const r = await ownerRelay(t, { ownerApp, appLimits: { perClient: { max: 1000, ms: 60_000 }, sessionPerClient: { max: 1000, ms: 60_000 }, ...relayLimits } });
  const home = tmpHome(t);
  paired(home);
  appSet(home, "on", Date.now() - 120_000);
  const alice = await agent(t, r.url, r.tokens.me, "me-alice");
  const tg = fakeTelegram();
  const key = newKey();
  const s = { r, home, tg, key, alice };
  s.start = async () => {
    const b = bridgeOn(t, { home, telegram: tg.client(), url: r.url, token: r.tokens.me, key, ...(appLimits ? { appLimits } : {}), ...(clock ? { now: clock } : {}), ...(fault ? { fault } : {}), ...(maxTargets ? { maxTargets } : {}) });
    s.bridge = b.bridge;
    s.run = b.run;
    if (ownerApp) await until(() => b.bridge.appAvailable(), 4000, "the app registered");
    else await until(() => b.bridge.leading(), 4000, "leader");
    s.app = appClient(r.http, b.bridge.state().app.id);
    return s.bridge;
  };
  await s.start();
  s.handle = async (label = "alice", app = s.app) => (await app.get("sessions")).json.sessions.find((x) => x.label === label)?.h;
  /** A request the relay forwards as it likes (a hostile relay): the bridge's app_res. */
  s.forged = (frame) =>
    new Promise((resolve) => {
      const c = s.bridge.relay;
      const orig = c.frame;
      // Only the bridge's answer is taken; its other frames (a list request, a registration) go on.
      c.frame = (f) => {
        if (f?.type !== "app_res") return orig.call(c, f);
        c.frame = orig;
        resolve(f);
      };
      c.emit("app_req", { rid: `r${Math.random()}`, method: "GET", path: "api/sessions", ctype: null, origin: null, client: "1.2.3.4", ttl_ms: 5000, body: null, ...frame });
    });
  return s;
}

test("sessions: the same initData again (also re-encoded) replaces the first session", async (t) => {
  const s = await setup(t);
  const raw = initData({ user: { id: 5550001, first_name: "A B" } });
  const a = appClient(s.r.http, s.bridge.state().app.id);
  const b = appClient(s.r.http, s.bridge.state().app.id);
  assert.equal((await a.open(raw)).status, 200);
  assert.equal((await a.get("sessions")).status, 200);
  assert.equal((await b.open(raw.replace(/%20/g, "+"))).status, 200);
  assert.equal((await a.get("sessions")).status, 401, "the first token stops working");
  assert.equal((await b.get("sessions")).status, 200);
});

test("sessions: idle 15 minutes, or 30 minutes in all: ended; a fourth session ends the oldest", async (t) => {
  let skew = 0;
  const s = await setup(t, { clock: () => Date.now() + skew });
  const id = s.bridge.state().app.id;
  const a = appClient(s.r.http, id);
  await a.open();
  skew = 15 * 60_000 + 1000;
  assert.equal((await a.get("sessions")).status, 401, "idle");
  skew = 0;
  const b = appClient(s.r.http, id);
  await b.open();
  for (const m of [10, 20, 29]) {
    skew = m * 60_000;
    assert.equal((await b.get("sessions")).status, 200, `${m} minutes`);
  }
  skew = 30 * 60_000 + 1000;
  assert.equal((await b.get("sessions")).status, 401, "30 minutes in all");
  skew = 0;
  const four = [0, 1, 2, 3].map(() => appClient(s.r.http, id));
  for (const c of four) assert.equal((await c.open()).status, 200);
  assert.equal((await four[0].get("sessions")).status, 401);
  for (const c of four.slice(1)) assert.equal((await c.get("sessions")).status, 200);
});

test("sessions: /app off ends every session; a relay that keeps forwarding gets 404; /app shows the off text", async (t) => {
  const s = await setup(t);
  await s.app.open();
  const h = await s.handle();
  const token = s.app.token;
  const id = s.bridge.state().app.id;
  s.tg.say("/app off");
  await until(() => s.tg.last(/^The app is turned off\. Its links no longer work\.$/), 4000, "turned off");
  assert.equal(s.bridge.state().app.on, false);
  // The relay was told: it answers 404 itself.
  await until(async () => (await s.app.get("sessions")).status === 404, 4000, "relay 404");
  // A relay that forwards anyway: the bridge refuses.
  const f = await s.forged({ app: id, auth: `Bearer ${token}` });
  assert.equal(f.status, 404);
  const d = await s.forged({ app: id, method: "POST", path: "api/draft", ctype: "application/json", auth: `Bearer ${token}`, body: JSON.stringify({ h, op: newOp(), text: "hi" }) });
  assert.equal(d.status, 404);
  assert.equal(s.bridge.appSessions(), 0);
  s.tg.say("/app");
  await until(() => s.tg.last(/^The app is turned off\. To turn it on, use hoptell telegram app --on on the computer running this bot\.$/), 4000, "the off text");
  assert.ok(!JSON.stringify(s.tg.sent).includes("web_app"), "no app button anywhere once off");
});

test("sessions: a new pairing (same user) ends sessions and handles; initData from before it cannot open one", async (t) => {
  const s = await setup(t);
  await s.app.open();
  const h = await s.handle();
  const old = initData({ auth_date: String(Math.floor(Date.now() / 1000)) });
  paired(s.home, { id: "p_newnewnewnewnewne" });
  // The pairing file changes under the running bridge: the next call sees it.
  assert.equal((await s.app.get("sessions")).status, 401);
  const r = await s.app.post("draft", { h, op: newOp(), text: "hi" });
  assert.equal(r.status, 401);
  // pairing.at in the helper is old, so set the new pairing's time to now.
  const sig = await import("../lib/ownersig.js");
  sig.writePrivateJson(sig.channelPaths(s.home).pairing, { v: 1, bot_id: "7000001", pending: null, paired: { user_id: 5550001, chat_id: 5550001, id: "p_newnewnewnewnewne", at: Date.now() } });
  const o = await s.app.open(old);
  assert.equal(o.status, 403);
  assert.equal(o.json.error, "just_changed");
});

test("sessions: --rotate with the bridge stopped: the old link answers 404; a bridge restart ends every session", async (t) => {
  const s = await setup(t);
  await s.app.open();
  const oldId = s.bridge.state().app.id;
  const oldToken = s.app.token;
  await s.bridge.stop();
  appSet(s.home, "rotate");
  await s.start();
  assert.notEqual(s.bridge.state().app.id, oldId);
  assert.equal((await appClient(s.r.http, oldId).get("sessions", oldToken)).status, 404);
  const f = await s.forged({ app: oldId, auth: `Bearer ${oldToken}` });
  assert.equal(f.status, 404);
  // A new session needs initData from after the rotation (+60 s): refused until then.
  const o = await s.app.open();
  assert.equal(o.json.error, "just_changed");
  // The new id, with a restart in between: the old token refuses there too.
  assert.equal((await s.app.get("sessions", oldToken)).status, 401);
});

test("sessions: failed initData: 20 a minute (the defaults) lock out every session request for 5 minutes, with one chat line a day", async (t) => {
  const s = await setup(t);
  const bad = initData({}, "7000001:AAHwrongwrongwrongwrongwrongwrong00");
  for (let i = 0; i < 20; i++) {
    const r = await s.app.open(bad);
    assert.equal(r.status, 403, `failure ${i + 1}: refused, never rate-limited first`);
    assert.equal(r.json.error, "not_you");
  }
  const after = await s.app.open();
  assert.equal(after.status, 403);
  assert.equal(after.json.error, "not_you", "locked out, even with valid initData");
  await until(() => s.tg.last(/^Someone is trying to open your hoptell app\. If it isn't you, send \/app off\.$/), 4000, "the line");
  assert.equal(s.bridge.state().drops.app_initdata_bad_hash, 20);
  assert.equal(s.bridge.state().drops.app_initdata_lockout, 1);
  assert.ok(readAudit(s.home).every((e) => !JSON.stringify(e).includes("query_id")), "never initData in the audit");
});

test("sessions: per pairing, at most 10 sessions opened a minute (the defaults), also from new sessions; failures do not count", async (t) => {
  const s = await setup(t);
  const id = s.bridge.state().app.id;
  const bad = initData({}, "7000001:AAHwrongwrongwrongwrongwrongwrong00");
  for (let i = 0; i < 5; i++) assert.equal((await s.app.open(bad)).status, 403);
  for (let i = 0; i < 10; i++) assert.equal((await appClient(s.r.http, id).open()).status, 200, `open ${i + 1}`);
  const eleventh = await appClient(s.r.http, id).open();
  assert.equal(eleventh.status, 429);
  assert.equal(eleventh.json.error, "too_many");
});

test("handles: a handle from another session is refused", async (t) => {
  const s = await setup(t);
  await s.app.open();
  const h = await s.handle();
  const other = appClient(s.r.http, s.bridge.state().app.id);
  await other.open();
  assert.equal((await other.post("draft", { h, op: newOp(), text: "hi" })).json.error, "stale");
  assert.equal((await other.get(`session/${h}`)).json.error, "stale");
  assert.equal((await s.app.get(`session/${h}`)).json.label, "alice");
});

test("early taps: a confirmation and an Undo tapped before they are active answer 'Just a moment' and stay; once active, they work once", async (t) => {
  const s = await setup(t);
  await s.app.open();
  const h = await s.handle();
  s.tg.holdCalls.add("sendMessage");
  await s.app.post("draft", { h, op: newOp(), text: "deploy now" });
  await until(() => s.tg.heldCalls.length === 1, 4000, "the confirmation waits");
  const data = s.tg.heldCalls[0].params.reply_markup.inline_keyboard[0][0].callback_data;
  s.tg.press(null, 0, { data, messageId: 9999 });
  await until(() => s.tg.calls("answerCallbackQuery").some((c) => c.params.text === "Just a moment, then tap again."), 4000, "tap again");
  assert.equal(s.alice.got.length, 0);
  s.tg.releaseCalls();
  await until(() => s.tg.last(/^✏️ From the app/), 4000, "shown");
  await until(() => Object.values(s.bridge.state().targets).some((x) => x.kind === "confirm" && x.app && !x.pending), 4000, "active");
  const c = s.tg.last(/^✏️ From the app/);
  s.tg.press(c, 0);
  await s.alice.waitFor((m) => JSON.parse(m.text).text === "deploy now");
  // Undo: tapped while its line is on its way, and after the line but before the people.json write.
  s.tg.holdCalls.add("sendMessage");
  await s.app.post("prefs", { h, op: newOp(), set: { hidden: true } });
  await until(() => s.tg.heldCalls.length === 1, 4000, "the line waits");
  const u = s.tg.heldCalls[0].params.reply_markup.inline_keyboard[0][0].callback_data;
  s.tg.press(null, 0, { data: u, messageId: 9998 });
  await until(() => s.tg.calls("answerCallbackQuery").filter((x) => x.params.text === "Just a moment, then tap again.").length === 2, 4000, "tap again");
  s.tg.releaseCalls();
  await until(() => peopleOf(s.home)["me-alice"]?.hidden === true && Object.values(s.bridge.state().targets).some((x) => x.kind === "undo" && !x.pending), 4000, "finalised");
  const line = s.tg.last(/^From the app: alice is hidden\.$/);
  s.tg.press(line, 0);
  await until(() => !peopleOf(s.home)["me-alice"]?.hidden, 4000, "undone");
  s.tg.press(line, 0);
  await sleep(300);
  assert.equal(s.alice.got.length, 1);
});

test("revocation: /app off while a settings line is on its way: never applied, the line says why; a draft on its way is shown and still needs the tap", async (t) => {
  const s = await setup(t);
  await s.app.open();
  const h = await s.handle();
  s.tg.holdCalls.add("sendMessage");
  await s.app.post("prefs", { h, op: newOp(), set: { fav: true } });
  await s.app.post("draft", { h, op: newOp(), text: "ship it" });
  await until(() => s.tg.heldCalls.length === 1, 4000, "the line waits");
  s.tg.say("/app off");
  await sleep(200);
  s.tg.releaseCalls();
  const line = await (async () => {
    await until(() => s.tg.last(/^From the app: alice is a favourite\.$/), 4000, "line");
    return s.tg.last(/^From the app: alice is a favourite\.$/);
  })();
  s.tg.releaseCalls();
  await until(() => s.tg.calls("editMessageText").some((c) => c.params.message_id === line.message_id && c.params.text === "Not changed: the app was turned off."), 6000, "the line says why");
  assert.equal(peopleOf(s.home)["me-alice"]?.fav, undefined);
  // The draft: dropped before it was shown, or shown and needing the tap.
  await sleep(300);
  s.tg.releaseCalls();
  await sleep(300);
  const c = s.tg.last(/^✏️ From the app/);
  if (c) {
    assert.equal(s.alice.got.length, 0);
    s.tg.press(c, 0);
    await s.alice.waitFor((m) => JSON.parse(m.text).text === "ship it");
  }
  assert.equal(s.bridge.state().outbox.filter((e) => e.origin === "a").length, 0);
});

test("old relay: without owner_app there is no registration, no button, and /app answers the off text", async (t) => {
  const s = await setup(t, { ownerApp: false });
  s.tg.say("/app");
  await until(() => s.tg.last(/^The app is turned off\./), 4000, "the off text");
  s.tg.say("/msg");
  s.tg.say("/pending");
  await until(() => s.tg.last(/questions|No questions|waiting/i) && s.tg.texts().length >= 3, 4000, "lists");
  await sleep(200);
  assert.ok(!JSON.stringify(s.tg.sent).includes("web_app"));
  assert.ok(!s.tg.calls("setMyCommands").some((c) => c.params.commands.some((x) => x.command === "app")));
  assert.equal((await httpRequest(s.r.http, `/app/${s.bridge.state().app.id}/`)).status, 426);
});

test("the app's button: on /msg, /agents and /pending, never in 'Who is this for?'; /app in the menu", async (t) => {
  const s = await setup(t);
  s.tg.say("/msg");
  s.tg.say("/agents");
  s.tg.say("/pending");
  s.tg.say("hello there");
  await until(() => s.tg.last(/^Who is this for\?/), 4000, "the hold picker");
  const url = `https://127.0.0.1:${s.r.relay.port}/app/${s.bridge.state().app.id}/`;
  const appRow = (re) => {
    const rows = s.tg.last(re).params.reply_markup?.inline_keyboard ?? [];
    return rows.flat().filter((b) => b.web_app);
  };
  for (const re of [/^Who should get your message\?/, /^Your agents: /, /^No questions are waiting for you\./]) {
    const b = appRow(re);
    assert.equal(b.length, 1, String(re));
    assert.deepEqual(b[0], { text: "📱 Open the app", web_app: { url } });
  }
  assert.equal(appRow(/^Who is this for\?/).length, 0);
  await until(() => s.tg.calls("setMyCommands").some((c) => c.params.commands.some((x) => x.command === "app" && x.description === "Open the hoptell app")), 4000, "menu");
  s.tg.say("/app");
  await until(() => s.tg.last(/^Your agents, favourites and questions, in one place:$/), 4000, "/app");
  assert.equal(appRow(/^Your agents, favourites and questions, in one place:$/).length, 1);
});

/** Hold people.json's lock until the returned function is called. */
function holdPeople(home) {
  let release;
  const held = new Promise((r) => (release = r));
  const taken = new Promise((ok) => withLock(peoplePath(home), () => (ok(), held), { waitMs: 5000 }));
  return taken.then(() => release);
}

test("early taps: Undo after its line is saved but before the people.json write answers 'Just a moment'; then it works once", async (t) => {
  const s = await setup(t);
  await s.app.open();
  const h = await s.handle();
  const release = await holdPeople(s.home);
  await s.app.post("prefs", { h, op: newOp(), set: { fav: true } });
  await until(() => Object.values(s.bridge.state().targets).some((x) => x.kind === "undo" && Number.isSafeInteger(x.msg)), 4000, "the line is saved");
  const line = s.tg.last(/^From the app: alice is a favourite\.$/);
  s.tg.press(line, 0);
  await until(() => s.tg.calls("answerCallbackQuery").some((c) => c.params.text === "Just a moment, then tap again."), 4000, "tap again");
  assert.ok(!s.tg.calls("editMessageReplyMarkup").some((c) => c.params.message_id === line.message_id), "its button stays");
  release();
  await until(() => peopleOf(s.home)["me-alice"]?.fav === true && Object.values(s.bridge.state().targets).some((x) => x.kind === "undo" && !x.pending), 6000, "finalised");
  s.tg.press(line, 0);
  await until(() => !peopleOf(s.home)["me-alice"]?.fav, 4000, "undone");
});

test("early taps: Undo after the people.json write but before finalisation (a crash, then a restart) answers 'Just a moment'; then it works", async (t) => {
  const r = await ownerRelay(t, { ownerApp: true });
  const home = tmpHome(t);
  paired(home);
  appSet(home, "on", Date.now() - 120_000);
  await agent(t, r.url, r.tokens.me, "me-alice");
  const tg = fakeTelegram();
  const key = newKey();
  let fired = false;
  const fault = (p) => {
    if (p === "app:people-written" && !fired) {
      fired = true;
      throw new Crash(p);
    }
  };
  const a = bridgeOn(t, { home, telegram: tg.client("a"), url: r.url, token: r.tokens.me, key, fault });
  await until(() => a.bridge.appAvailable(), 4000, "registered");
  const app = appClient(r.http, a.bridge.state().app.id);
  await app.open();
  const h = (await app.get("sessions")).json.sessions[0].h;
  await app.post("prefs", { h, op: newOp(), set: { fav: true } });
  assert.equal((await a.run).code, "crashed");
  assert.equal(peopleOf(home)["me-alice"]?.fav, true, "written");
  assert.ok(Object.values(a.bridge.state().targets).some((x) => x.kind === "undo" && x.pending), "not finalised");
  // The restart's finalisation waits for people.json; the tap comes first.
  const release = await holdPeople(home);
  const line = tg.last(/^From the app: alice is a favourite\.$/);
  tg.press(line, 0);
  const b = bridgeOn(t, { home, telegram: tg.client("b"), url: r.url, token: r.tokens.me, key });
  await until(() => tg.calls("answerCallbackQuery").some((c) => c.params.text === "Just a moment, then tap again."), 4000, "tap again");
  assert.equal(peopleOf(home)["me-alice"]?.fav, true);
  release();
  await until(() => Object.values(b.bridge.state().targets).some((x) => x.kind === "undo" && !x.pending), 6000, "finalised");
  tg.press(line, 0);
  await until(() => !peopleOf(home)["me-alice"]?.fav, 4000, "undone");
});

test("reads: a new pairing or /app off while the agent list is fetched: both read routes answer 401 and show nothing of the new owner", async (t) => {
  const { ME } = await import("./owner-helpers.js");
  const { bump, updatePeople } = await import("../lib/ownerpeople.js");
  for (const change of ["repair", "off"]) {
    for (const route of ["list", "one"]) {
      const s = await setup(t, { appLimits: { agentsMs: 0 } });
      await s.app.open();
      const h = await s.handle();
      const c = s.bridge.relay;
      const orig = c.list.bind(c);
      // Every list call waits (handling /app off lists too) until release().
      const waiting = [];
      let held = false;
      c.list = async () => {
        held = true;
        await new Promise((r) => waiting.push(r));
        return orig();
      };
      const release = () => {
        c.list = orig;
        for (const r of waiting) r();
      };
      // The bridge's own answer (once the app is off, the relay would answer for it).
      const pending = s.forged({ app: s.bridge.state().app.id, auth: `Bearer ${s.app.token}`, path: route === "list" ? "api/sessions" : `api/session/${h}` });
      await until(() => held, 4000, "the list held");
      if (change === "repair") {
        paired(s.home, { user: 5550002, chat: 5550002, id: "p_newownernewowner" });
        await updatePeople(s.home, { member: ME, owner: 5550002 }, (_, entry) => bump(Object.assign(entry("me-alice"), { alias: "newownerlabel" }), "cli:0123456789abcdef"));
      } else {
        s.tg.say("/app off");
        await until(() => s.bridge.state().app.on === false, 4000, "off");
      }
      release();
      const r = await pending;
      assert.equal(r.status, 401, `${change}, ${route}`);
      assert.ok(!String(r.body).includes("newownerlabel"));
    }
  }
});

test("stop: a settings write waiting for people.json's lock when the bridge halts writes nothing, and the home stays locked until it settled; then --off and a restart retire it", async (t) => {
  let armed = false;
  const fault = (p) => {
    if (armed && p === "u-commit") {
      armed = false;
      throw new Crash(p);
    }
  };
  const s = await setup(t, { fault });
  await s.app.open();
  const h = await s.handle();
  const release = await holdPeople(s.home);
  await s.app.post("prefs", { h, op: newOp(), set: { fav: true } });
  await until(() => Object.values(s.bridge.state().targets).some((x) => x.kind === "undo" && Number.isSafeInteger(x.msg)), 4000, "the line is saved");
  const line = s.tg.last(/^From the app: alice is a favourite\.$/);
  // The bridge halts (a crash in an update) while the app's write waits for the lock.
  let finished = false;
  s.run.then(() => (finished = true));
  armed = true;
  s.tg.say("/help");
  await until(() => !s.bridge.leading(), 4000, "halted");
  await sleep(300);
  assert.equal(finished, false, "the bridge keeps its home until the app's write settled");
  release();
  assert.equal((await s.run).code, "crashed");
  assert.equal(peopleOf(s.home)["me-alice"]?.fav, undefined, "never written after the halt");
  appSet(s.home, "off");
  await s.start().catch(() => {});
  await until(() => s.tg.calls("editMessageText").some((c) => c.params.message_id === line.message_id && c.params.text === "Not changed: the app was turned off."), 6000, "the line says why");
  assert.equal(peopleOf(s.home)["me-alice"]?.fav, undefined);
  assert.ok(!Object.values(s.bridge.state().targets).some((x) => x.kind === "undo"), "no Undo left");
});

test("undo: other buttons never push an Undo out, pending or active; Undo buttons have their own bound", async (t) => {
  // Other buttons capped at 20 here (200 in use), so fewer of them are needed.
  const s = await setup(t, { appLimits: { undos: 2, writesPerMin: 100, linesWaiting: 10 }, maxTargets: 20 });
  await s.app.open();
  const h = await s.handle();
  const undos = () => Object.values(s.bridge.state().targets).filter((x) => x.kind === "undo");
  const others = () => Object.values(s.bridge.state().targets).filter((x) => x.kind !== "undo").length;
  // One active, one pending (its people.json write waits).
  await s.app.post("prefs", { h, op: newOp(), set: { hidden: true } });
  await until(() => undos().some((x) => !x.pending), 4000, "active");
  // Its line waits in Telegram (the bot's own updates wait for people.json, so not that lock).
  s.tg.holdWhen = (method, params) => method === "sendMessage" && /^From the app: /.test(params.text ?? "");
  await s.app.post("prefs", { h, op: newOp(), set: { hidden: false } });
  await until(() => s.tg.heldCalls.length === 1 && undos().some((x) => x.pending), 4000, "pending");
  // Ordinary buttons, more than the 20 kept: each reply to a closed card asks first.
  await s.alice.ask("Deploy?", { choices: ["yes", "no"] });
  await until(() => s.tg.cards().length === 1, 4000, "card");
  const card = s.tg.cards()[0];
  s.tg.press(card, 0);
  await s.alice.waitFor((m) => JSON.parse(m.text).kind === "answer");
  for (let i = 0; i < 30; i++) s.tg.say(`again ${i}`, { reply: card });
  const confirmations = () => s.tg.calls("sendMessage").filter((c) => JSON.stringify(c.params.reply_markup ?? {}).includes('"callback_data":"c:')).length;
  await until(() => confirmations() >= 30, 15000, "30 confirmations");
  assert.equal(undos().length, 2, "both Undo buttons stay");
  assert.equal(others(), 20, "the other buttons are capped");
  s.tg.releaseCalls();
  await until(() => undos().every((x) => !x.pending), 6000, "finalised");
  const line = s.tg.last(/^From the app: alice is shown again\.$/);
  s.tg.press(line, 0);
  await until(() => peopleOf(s.home)["me-alice"]?.hidden === true, 4000, "its Undo works");
  // Past their own bound, the finalised Undo closest to expiry goes.
  await s.app.post("prefs", { h, op: newOp(), set: { fav: true } });
  await s.app.post("prefs", { h, op: newOp(), set: { fav: false } });
  await until(() => undos().length === 2 && undos().every((x) => !x.pending), 6000, "two kept");
});

test("reads: the largest supported list (2,000 saved agents, 64-character names) comes through the relay in pages, each within its limits", async (t) => {
  const { ME, OWNER_USER } = await import("./owner-helpers.js");
  const { bump, updatePeople } = await import("../lib/ownerpeople.js");
  const s = await setup(t);
  const names = Array.from({ length: 2000 }, (_, i) => `me-${String(i).padStart(4, "0")}${"x".repeat(57)}`);
  await updatePeople(s.home, { member: ME, owner: OWNER_USER }, (_, entry) => {
    names.forEach((n, i) => bump(Object.assign(entry(n), { alias: `name${String(i).padStart(4, "0")}${"y".repeat(16)}`, alias_host: "h".repeat(64), fav: i % 2 === 0 }), "cli:0123456789abcdef"));
  });
  await s.app.open();
  const seen = new Set();
  let path = "sessions";
  let pages = 0;
  while (path) {
    const r = await s.app.get(path);
    assert.equal(r.status, 200, `page ${pages}`);
    assert.ok(Buffer.byteLength(JSON.stringify(r.json)) <= 192 * 1024 + 1024, "within the page's byte bound");
    for (const x of r.json.sessions) seen.add(x.h);
    assert.equal(r.json.counts.all, 2001);
    path = r.json.next === null ? null : `sessions/${r.json.next}`;
    pages++;
  }
  assert.ok(pages > 1, "more than one page");
  assert.equal(seen.size, 2001, "every agent, once");
  assert.ok(s.bridge.relay.connected, "the bridge's relay connection stays up");
});

test("reads: an answer too large for the relay is never sent; a bounded error goes instead and the connection stays", async (t) => {
  const { ME, OWNER_USER } = await import("./owner-helpers.js");
  const { bump, updatePeople } = await import("../lib/ownerpeople.js");
  const s = await setup(t, { appLimits: { pageRows: 1e6, pageBytes: 1e9 } });
  await updatePeople(s.home, { member: ME, owner: OWNER_USER }, (_, entry) => {
    for (let i = 0; i < 2000; i++) bump(Object.assign(entry(`me-${String(i).padStart(4, "0")}${"x".repeat(57)}`), { fav: true }), "cli:0123456789abcdef");
  });
  await s.app.open();
  const f = await s.forged({ app: s.bridge.state().app.id, auth: `Bearer ${s.app.token}` });
  assert.equal(f.status, 500);
  assert.equal(f.body, JSON.stringify({ error: "too_large" }));
  assert.equal((await s.app.get("questions")).status, 200, "the connection stays");
});

test("questions: a copy from the app that arrives after the answer keeps a reply route after the question's record is gone", async (t) => {
  let skew = 0;
  const s = await setup(t, { clock: () => Date.now() + skew });
  await s.app.open();
  const q = await s.alice.ask("Deploy to prod?", { choices: ["yes", "no"] });
  await until(() => s.tg.cards().length === 1, 4000, "card");
  const n = (await s.app.get("questions")).json.questions[0].n;
  s.tg.holdWhen = (method, params) => method === "sendMessage" && /Deploy to prod\?/.test(params.text ?? "");
  await s.app.post("questions/show", { n, op: newOp() });
  await until(() => s.tg.heldCalls.length === 1, 4000, "the copy held");
  s.tg.press(s.tg.cards()[0], 0);
  await s.alice.waitFor((m) => JSON.parse(m.text).kind === "answer");
  s.tg.releaseCalls();
  await until(() => (s.bridge.state().questions[q]?.copies ?? []).length === 2, 4000, "the late copy recorded");
  const late = s.tg.cards()[1];
  // Two days on: the closed question's record is pruned (its TTL and a day); routes last 7 days.
  skew = 2 * 86400_000;
  await s.bridge.tick();
  await until(() => !s.bridge.state().questions[q], 4000, "the record pruned");
  s.tg.say("one more thing", { reply: late });
  await until(() => s.tg.calls("sendMessage").some((c) => JSON.stringify(c.params.reply_markup ?? {}).includes('"callback_data":"c:')), 4000, "a confirmation, as for any closed card");
  assert.ok(!s.tg.last(/^I can't tell who that message was for/), "not lost");
});

test("questions: a Show's copy is sent in the same serial step as its checks, so nothing queued behind them (an /app off) comes between", async (t) => {
  let s;
  const atChecked = [];
  // Right after the step with the checks returns: the copy's send must have started already.
  const fault = (p) => {
    if (p === "app:show-checked") atChecked.push(s.tg.calls("sendMessage").filter((c) => /Deploy to prod\?/.test(c.params.text)).length);
  };
  s = await setup(t, { fault });
  await s.app.open();
  await s.alice.ask("Deploy to prod?", { choices: ["yes", "no"] });
  await until(() => s.tg.cards().length === 1, 4000, "card");
  const n = (await s.app.get("questions")).json.questions[0].n;
  await s.app.post("questions/show", { n, op: newOp() });
  await until(() => s.tg.cards().length === 2, 4000, "the copy");
  assert.deepEqual(atChecked, [2], "the copy's send started inside the checked step");
});

test("reads: pages follow the order page 0 fixed: a rank change between pages hides no agent, one gone is skipped, a new one waits for the next page 0", async (t) => {
  const { ME, OWNER_USER } = await import("./owner-helpers.js");
  const { bump, updatePeople } = await import("../lib/ownerpeople.js");
  const s = await setup(t, { appLimits: { pageRows: 2 } });
  const scope = { member: ME, owner: OWNER_USER };
  const names = ["me-b1", "me-b2", "me-b3", "me-b4", "me-b5"];
  await updatePeople(s.home, scope, (_, entry) => {
    // Saved names, no favourites: recent talk moves an agent ahead of the others.
    for (const n of names) bump(Object.assign(entry(n), { alias: `x${n.slice(3)}` }), "cli:0123456789abcdef");
  });
  await s.app.open();
  const p0 = (await s.app.get("sessions")).json;
  assert.equal(p0.sessions.length, 2);
  const firstTwo = p0.sessions.map((x) => x.logical);
  const all0 = ["alice", ...names.map((n) => n.slice(3))];
  const rest = all0.filter((n) => !firstTwo.includes(n));
  // Between pages: the last one moves to the front (a signal), one not read yet goes, a new one comes.
  const saved = rest.filter((n) => n !== "alice"); // alice is online: listed whatever people.json says
  const gone = `me-${saved[0]}`;
  await updatePeople(s.home, scope, (sessions, entry) => {
    entry(`me-${saved.at(-1)}`).last_talked = Date.now();
    delete sessions[gone];
    bump(Object.assign(entry("me-new1"), { alias: "xnew1" }), "cli:0123456789abcdef");
  });
  const seen = [...firstTwo];
  for (let next = p0.next; next; ) {
    const r = (await s.app.get(`sessions/${next}`)).json;
    seen.push(...r.sessions.map((x) => x.logical));
    next = r.next;
  }
  assert.deepEqual([...seen].sort(), all0.filter((n) => `me-${n}` !== gone).sort(), "every agent of page 0 still here, once each");
  assert.ok(!seen.includes("new1"), "the new one waits for the next page 0");
  const again = (await s.app.get("sessions")).json;
  assert.equal(again.counts.all, 6);
  // A newer page 0 replaced the snapshot: the old cursor is stale.
  assert.deepEqual((await s.app.get(`sessions/${p0.next}`)).json, { error: "stale" });
});
