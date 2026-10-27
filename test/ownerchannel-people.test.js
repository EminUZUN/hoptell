// Design 7.3, phase 2: people.json (favourites, names, hidden sessions, two times each), the session
// picker (favourites, recent, online, More…, Search), "Who is this for?", the details screen, names
// and the host check, notes from hidden sessions and favourites. A fake Bot API on a real local relay.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { RelayClient } from "../lib/client.js";
import { contactsFile, freshContacts, validateContacts } from "../lib/contacts.js";
import * as sig from "../lib/ownersig.js";
import { HOLD_MS, MAX_BUTTONS, TARGET_MS, readAudit } from "../lib/ownerchannel.js";
import { PEOPLE_MAX, PEOPLE_PRUNE_MS, PeopleFullError, PeopleStaleError, aliasProblem, peoplePath, prune, readPeople, removePeople, updatePeople } from "../lib/ownerpeople.js";
import { ME, OWNER_USER, REALM, agent, bridgeOn, fakeTelegram, newKey, ownerRelay, paired, peopleOf, setPeople, tmpHome, until } from "./owner-helpers.js";
import { sleep } from "./helpers.js";

const fromOwner = (a, text) => a.waitFor((x) => x.from === "me-owner" && JSON.parse(x.text).text === text);
const plain = (o) => JSON.parse(JSON.stringify(o));
const rows = (m) => m?.params.reply_markup?.inline_keyboard ?? [];
const flat = (m) => rows(m).flat();
const sessionButtons = (m) => flat(m).filter((b) => /^t:/.test(b.callback_data));
const button = (m, text) => flat(m).find((b) => b.text === text);
const tap = (tg, m, b, extra = {}) => tg.press(m, 0, { data: b.callback_data, messageId: extra.messageId ?? m.message_id });
/** The latest version of message `m` (an edit replaces its text and buttons). */
function current(tg, m) {
  const edits = tg.sent.filter((s) => s.method === "editMessageText" && s.params.message_id === m.message_id);
  return edits.length ? { ...m, params: { ...m.params, ...edits.at(-1).params } } : m;
}
const count = (tg, re) => tg.texts().filter((x) => re.test(x)).length;
/** Wait for the next message matching `re` after `before` of them. */
async function next(tg, re, before, what = String(re)) {
  await until(() => count(tg, re) > before, 5000, what);
  return tg.sent.filter((s) => s.method === "sendMessage" && re.test(s.params.text)).at(-1);
}

/** A bridge on a fresh paired home whose relay list can be shaped (hosts, failures). */
async function setup(t, opts = {}) {
  const r = opts.relay ?? (await ownerRelay(t));
  const home = opts.home ?? tmpHome(t);
  if (!opts.unpaired) paired(home);
  const tg = opts.tg ?? fakeTelegram();
  const key = opts.key ?? newKey();
  const hosts = new Map(); // name -> host the relay reports (tests: a handoff)
  const titles = new Map(); // name -> title the relay reports (tests: session titles)
  const shape = { failList: false, gate: null, listCalls: 0 }; // gate: a promise every list call waits for
  const clientFactory = (o) => {
    const c = new RelayClient(o);
    const list = c.list.bind(c);
    c.list = async () => {
      shape.listCalls++;
      if (shape.gate) await shape.gate;
      if (shape.failList) throw new Error("relay busy");
      return (await list()).map((p) => (hosts.has(p.name) ? { ...p, host: hosts.get(p.name) } : p)).map((p) => (titles.has(p.name) ? { ...p, title: titles.get(p.name) } : p));
    };
    return c;
  };
  const clock = { skew: 0 };
  const { bridge, run } = bridgeOn(t, { home, telegram: tg.client(), url: r.url, token: r.tokens.me, key, clientFactory, now: () => Date.now() + clock.skew, ...opts.bridge });
  await until(() => bridge.leading(), 4000, "leadership");
  return { ...r, home, tg, key, bridge, run, clock, hosts, titles, shape };
}

// ---- people.json --------------------------------------------------------------------------------

test("people.json: bound to the member and the paired user; another one's file reads as empty and is replaced", async (t) => {
  const home = tmpHome(t);
  sig.ensureChannelDir(home);
  await updatePeople(home, { member: ME, owner: OWNER_USER }, (s, entry) => Object.assign(entry("me-alice"), { fav: true, alias: "Main" }));
  assert.equal((fs.statSync(peoplePath(home)).mode & 0o777).toString(8), "600");
  assert.deepEqual(plain(readPeople(home, { member: ME, owner: OWNER_USER }).sessions), { "me-alice": { fav: true, alias: "Main" } });
  assert.deepEqual(plain(readPeople(home, { member: ME, owner: 42 }).sessions), {}, "another Telegram user starts empty");
  assert.deepEqual(plain(readPeople(home, { member: "m_bbbbbbbbbbbbbbbbbbbbbbbbbb", owner: OWNER_USER }).sessions), {}, "another member starts empty");
  assert.deepEqual(plain(readPeople(home, { member: ME, owner: null }).sessions), {}, "unpaired: nothing applies");
  await assert.rejects(
    updatePeople(home, { member: ME, owner: null }, () => {}),
    /not paired/,
  );
  await updatePeople(home, { member: ME, owner: 42 }, (s, entry) => (entry("me-bob").fav = true));
  assert.deepEqual(plain(readPeople(home, { member: ME, owner: 42 }).sessions), { "me-bob": { fav: true } });
  assert.deepEqual(plain(readPeople(home, { member: ME, owner: OWNER_USER }).sessions), {}, "replaced, not merged");
  fs.writeFileSync(peoplePath(home), "{not json", { mode: 0o600 });
  assert.deepEqual(plain(readPeople(home, { member: ME, owner: 42 }).sessions), {}, "malformed reads as empty");
  await removePeople(home);
  assert.equal(fs.existsSync(peoplePath(home)), false);
});

test("people.json: wire names such as constructor and toString are ordinary entries, never inherited properties", async (t) => {
  const home = tmpHome(t);
  sig.ensureChannelDir(home);
  const scope = { member: ME, owner: OWNER_USER };
  await updatePeople(home, scope, (s, entry) => {
    entry("constructor").fav = true;
    entry("toString").alias = "Str";
    entry("hasOwnProperty").first_seen = Date.now();
  });
  assert.equal(Object.prototype.fav, undefined);
  const sessions = readPeople(home, scope).sessions;
  assert.deepEqual(Object.keys(sessions).sort(), ["constructor", "hasOwnProperty", "toString"]);
  assert.equal(sessions.constructor.fav, true);
  assert.equal(sessions.toString.alias, "Str");
  assert.equal(readPeople(home, scope).sessions.valueOf, undefined, "no inherited entry");
  // A file with "__proto__" (not a valid name) and inherited-looking keys: only valid own names load.
  fs.writeFileSync(peoplePath(home), JSON.stringify({ v: 1, member: ME, owner: String(OWNER_USER), sessions: JSON.parse('{"__proto__":{"fav":true},"valueOf":{"hidden":true}}') }), { mode: 0o600 });
  const loaded = readPeople(home, scope).sessions;
  assert.deepEqual(Object.keys(loaded), ["valueOf"]);
  assert.equal(loaded.fav, undefined);
  assert.equal({}.fav, undefined);
});

test("people.json: a change made for an earlier pairing is refused under the lock; nothing lands in the new owner's file", async (t) => {
  const home = tmpHome(t);
  sig.ensureChannelDir(home);
  const a = { member: ME, owner: OWNER_USER };
  const b = { member: ME, owner: 777 };
  let current = "b";
  await updatePeople(home, b, (s, entry) => (entry("me-alice").fav = true));
  await assert.rejects(
    updatePeople(home, a, (s, entry) => (entry("me-alice").last_talked = 1), Date.now(), { still: () => current === "a" }),
    PeopleStaleError,
  );
  assert.deepEqual(readPeople(home, b).sessions["me-alice"], Object.assign(Object.create(null), { fav: true }), "B's preferences kept");
  current = "a";
  await updatePeople(home, a, (s, entry) => (entry("me-x").fav = true), Date.now(), { still: () => current === "a" });
});

test("people.json: unmarked entries are pruned after 30 days and past 2,000; a marked one never; full of marked ones refuses a new mark", async (t) => {
  const t0 = 1_800_000_000_000;
  const doc = { sessions: { old: { last_talked: t0 - PEOPLE_PRUNE_MS - 1 }, fresh: { first_seen: t0 - 1000 }, fav: { fav: true, last_talked: 1 }, hid: { hidden: true } } };
  prune(doc, t0);
  assert.deepEqual(Object.keys(doc.sessions).sort(), ["fav", "fresh", "hid"]);
  const home = tmpHome(t);
  sig.ensureChannelDir(home);
  const scope = { member: ME, owner: OWNER_USER };
  await updatePeople(
    home,
    scope,
    (s, entry) => {
      for (let i = 0; i < PEOPLE_MAX - 1; i++) entry(`me-f${i}`).fav = true;
      entry("me-u0").last_talked = t0 - 5000;
    },
    t0,
  );
  // A new unmarked entry at the cap evicts the least recently used unmarked one, never a marked one.
  await updatePeople(home, scope, (s, entry) => (entry("me-u1").last_talked = t0), t0);
  let s = readPeople(home, scope).sessions;
  assert.equal(Object.keys(s).length, PEOPLE_MAX);
  assert.equal(s["me-u0"], undefined);
  assert.ok(s["me-u1"]);
  // Marking the last unmarked one: all 2,000 marked.
  await updatePeople(home, scope, (s2) => (s2["me-u1"].hidden = true), t0);
  // Now a new unmarked signal is skipped, and a new mark is refused; changing a marked one works.
  await updatePeople(home, scope, (s2, entry) => (entry("me-new").first_seen = t0), t0);
  assert.equal(readPeople(home, scope).sessions["me-new"], undefined);
  await assert.rejects(
    updatePeople(home, scope, (s2, entry) => (entry("me-new").fav = true), t0),
    PeopleFullError,
  );
  await updatePeople(home, scope, (s2) => (s2["me-f1"].alias = "One"), t0);
  s = readPeople(home, scope).sessions;
  assert.equal(s["me-f1"].alias, "One");
  assert.equal(Object.values(s).every((e) => e.fav || e.hidden || e.alias), true, "no marked entry was evicted");
});

test("alias rules: 1-24 characters, no control characters, no leading @, / or emoji, no ·, not another agent's name", () => {
  assert.equal(aliasProblem("Main"), null);
  assert.equal(aliasProblem("  Build   box "), null);
  assert.equal(aliasProblem(""), "length");
  assert.equal(aliasProblem("x".repeat(25)), "length");
  assert.equal(aliasProblem("x".repeat(24)), null);
  assert.equal(aliasProblem("a\u0007b"), "control");
  assert.equal(aliasProblem("a\u202eb"), "control");
  assert.equal(aliasProblem("@main"), "prefix");
  assert.equal(aliasProblem("/main"), "prefix");
  assert.equal(aliasProblem("a · b"), "symbol");
  assert.equal(aliasProblem("💬 main"), "symbol");
  assert.equal(aliasProblem("❓main"), "symbol");
  assert.equal(aliasProblem("MAIN", ["main"]), "taken");
  assert.equal(aliasProblem("alice", ["me-alice", "alice"]), "taken");
});

// ---- the picker ---------------------------------------------------------------------------------

test("the picker with 300 agents: favourites first (away ones marked), recent next, then online; at most 12 buttons; More… pages", async (t) => {
  const s = await setup(t);
  const names = Array.from({ length: 300 }, (_, i) => `me-a${String(i).padStart(3, "0")}`);
  for (const n of names) await agent(t, s.url, s.tokens.me, n);
  const now = Date.now();
  // Recorded first sightings, so the order below does not depend on how long the picker takes.
  await setPeople(s.home, names, { first_seen: now - 1000 });
  await setPeople(s.home, ["me-a010", "me-a005"]);
  await setPeople(s.home, ["me-gone"]); // a favourite that is not online
  await setPeople(s.home, ["me-a200"], { last_talked: now - 3600_000 });
  await setPeople(s.home, ["me-a201"], { last_talked: now - 60_000 });
  await setPeople(s.home, ["me-a202"], { last_talked: now - 8 * 86400_000 }); // too old for "recent"
  await setPeople(s.home, ["me-a299"], { first_seen: now }); // the newest online
  s.tg.say("/msg");
  const first = await next(s.tg, /^Who should get your message\?$/, 0, "picker");
  assert.deepEqual(
    sessionButtons(first).map((b) => b.text),
    ["a005", "a010", "gone (away)", "a201", "a200", "a299", "a000", "a001", "a002", "a003"],
  );
  assert.deepEqual(rows(first).at(-1).map((b) => b.text), ["More…", "🔍 Search"]);
  assert.equal(flat(first).length, MAX_BUTTONS);
  // More… pages through every session, 8 per page, each name once.
  tap(s.tg, first, button(first, "More…"));
  await until(() => current(s.tg, first).params.text.startsWith("Who should get your message?\nPage 1 of"), 4000, "page 1");
  const seen = [];
  for (let page = 1; ; page++) {
    const m = current(s.tg, first);
    assert.match(m.params.text, new RegExp(`Page ${page} of 38\\.$`));
    assert.ok(flat(m).length <= MAX_BUTTONS);
    seen.push(...sessionButtons(m).map((b) => b.text));
    const nextB = button(m, "Next ▶");
    if (!nextB) break;
    const edits = s.tg.calls("editMessageText").length;
    tap(s.tg, m, nextB);
    await until(() => s.tg.calls("editMessageText").length > edits, 4000, `page ${page + 1}`);
  }
  assert.equal(seen.length, 301, "300 online and one away favourite");
  assert.equal(new Set(seen).size, 301, "every name once");
  // A page's buttons are bound to their message: a stale page button (an earlier page) retires.
  const p1 = s.bridge.state().targets;
  assert.ok(Object.values(p1).every((x) => x.msg === first.message_id && x.exp <= Date.now() + TARGET_MS));
  tap(s.tg, first, button(first, "More…"));
  await until(() => s.tg.calls("answerCallbackQuery").some((c) => c.params.text === "This list is old. Open a new one with /msg."), 4000, "stale");
});

test("/agents: the header counts favourites and online agents; a tap opens the details screen; favourite, hide and unhide edit it", async (t) => {
  const s = await setup(t);
  const alice = await agent(t, s.url, s.tokens.me, "me-alice");
  await agent(t, s.url, s.tokens.me, "me-bob");
  await setPeople(s.home, ["me-alice"], { last_talked: Date.now() - 2 * 3600_000 });
  s.tg.say("/agents");
  const list = await next(s.tg, /^Your agents: /, 0);
  assert.equal(list.params.text, "Your agents: 0 favourites, 2 online.");
  tap(s.tg, list, sessionButtons(list)[0]);
  const d = await next(s.tg, /^alice\n/, 0, "details");
  assert.match(d.params.text, /^alice\n🟢 Online · on \S+ · last message 2 hours ago$/);
  assert.deepEqual(rows(d).map((r) => r.map((b) => b.text)), [["✉️ Message", "☆ Add favourite"], ["✏️ Rename", "🙈 Hide and skip notes"]]);
  tap(s.tg, d, button(d, "☆ Add favourite"));
  await until(() => button(current(s.tg, d), "★ Remove favourite"), 4000, "favourite");
  assert.equal(peopleOf(s.home)["me-alice"].fav, true);
  // Every settings change raises the entry's revision and names its writer (design 7.4, section 7).
  assert.equal(peopleOf(s.home)["me-alice"].rev, 1);
  assert.match(peopleOf(s.home)["me-alice"].last_op, /^bot:\d+$/);
  await until(() => s.tg.calls("setMyCommands").some((c) => c.params.commands.some((x) => x.command === "alice")), 4000, "menu");
  tap(s.tg, d, button(current(s.tg, d), "🙈 Hide and skip notes"));
  await until(() => current(s.tg, d).params.text.endsWith("\n🙈 Hidden from lists and favourites; new notes are skipped and won't appear later. Questions still arrive."), 4000, "hidden");
  assert.deepEqual(peopleOf(s.home)["me-alice"].fav, undefined, "hiding a favourite ends it");
  assert.equal(peopleOf(s.home)["me-alice"].rev, 2);
  assert.notEqual(peopleOf(s.home)["me-alice"].last_op, "bot:0");
  // A hidden session is out of /msg, but found by search.
  s.tg.say("/msg");
  const pick = await next(s.tg, /^Who should get your message\?$/, 0);
  assert.deepEqual(sessionButtons(pick).map((b) => b.text), ["bob"]);
  tap(s.tg, d, button(current(s.tg, d), "👁️ Show agent"));
  await until(() => button(current(s.tg, d), "🙈 Hide and skip notes"), 4000, "unhidden");
  tap(s.tg, d, button(current(s.tg, d), "✉️ Message"));
  const prompt = await next(s.tg, /^✏️ Message to alice\./, 0);
  s.tg.say("hi there", { reply: s.tg.replyTo(prompt) });
  await fromOwner(alice, "hi there");
  // A foreign user's tap changes nothing.
  s.tg.press(current(s.tg, d), 0, { from: 999, chat: 999, data: button(current(s.tg, d), "☆ Add favourite").callback_data });
  await sleep(200);
  assert.equal(peopleOf(s.home)["me-alice"].fav, undefined);
  const audit = JSON.stringify(readAudit(s.home));
  assert.match(audit, /"people"/);
  assert.equal(audit.includes("hi there"), false);
});

test("search: 30 hidden sessions matching one fragment are all reachable through search pages, also with a held text", async (t) => {
  const s = await setup(t);
  const names = Array.from({ length: 30 }, (_, i) => `me-db${String(i).padStart(2, "0")}`);
  for (const n of names) await agent(t, s.url, s.tokens.me, n);
  const other = await agent(t, s.url, s.tokens.me, "me-web");
  await setPeople(s.home, names, { hidden: true });
  for (const mode of ["msg", "hold"]) {
    const re = mode === "msg" ? /^Who should get your message\?$/ : /^Who is this for\?$/;
    const before = count(s.tg, re);
    s.tg.say(mode === "msg" ? "/msg" : "check the backups");
    const pick = await next(s.tg, re, before, mode);
    assert.deepEqual(sessionButtons(pick).map((b) => b.text), ["web"], "hidden ones are not listed");
    if (mode === "hold") assert.equal(flat(pick).at(-1).text, "Cancel");
    const prompts = count(s.tg, /^Type part of a name\.$/);
    tap(s.tg, pick, button(pick, "🔍 Search"));
    const q = await next(s.tg, /^Type part of a name\.$/, prompts);
    assert.deepEqual(q.params.reply_markup, { force_reply: true });
    const resRe = new RegExp(`${re.source.slice(0, -1)}\\nPage`);
    const resBefore = count(s.tg, resRe);
    s.tg.say("DB", { reply: s.tg.replyTo(q) });
    const res = await next(s.tg, resRe, resBefore, "results");
    assert.match(res.params.text, /\nPage 1 of 4\.$/);
    const found = [];
    for (;;) {
      const m = current(s.tg, res);
      assert.ok(flat(m).length <= MAX_BUTTONS);
      if (mode === "hold") assert.equal(flat(m).at(-1).text, "Cancel", "the held text stays held");
      found.push(...sessionButtons(m).map((b) => b.text));
      const n = button(m, "Next ▶");
      if (!n) break;
      const edits = s.tg.calls("editMessageText").length;
      tap(s.tg, m, n);
      await until(() => s.tg.calls("editMessageText").length > edits, 4000, "next page");
    }
    assert.deepEqual(found.sort(), names.map((n) => n.slice(3)), mode);
    if (mode === "hold") {
      // The held text goes to the session tapped on the last page.
      const m = current(s.tg, res);
      const b = sessionButtons(m).at(-1);
      const target = `me-${b.text}`;
      const db = await agent(t, s.url, s.tokens.me, `${target}-x`); // another agent: never reached
      tap(s.tg, m, b);
      await until(() => current(s.tg, res).params.text === `✅ Sent to ${b.text}.`, 4000, "sent");
      assert.equal(db.got.length, 0);
    }
  }
  assert.equal(other.got.length, 0);
});

test('"Who is this for?": the text is held, sent once on a tap, dropped by Cancel or after 10 minutes, never sent without a tap', async (t) => {
  const s = await setup(t);
  const alice = await agent(t, s.url, s.tokens.me, "me-alice");
  await setPeople(s.home, ["me-alice"]); // exactly one favourite: still asks
  s.tg.say("deploy the fix");
  const pick = await next(s.tg, /^Who is this for\?$/, 0);
  assert.deepEqual(flat(pick).map((b) => b.text), ["alice", "🔍 Search", "Cancel"]);
  await sleep(200);
  assert.equal(alice.got.length, 0, "nothing without a tap");
  const held = Object.values(s.bridge.state().targets).find((x) => x.kind === "hold");
  assert.equal(held.text, "deploy the fix");
  assert.equal(JSON.stringify(readAudit(s.home)).includes("deploy the fix"), false, "never in the audit");
  tap(s.tg, pick, sessionButtons(pick)[0]);
  await fromOwner(alice, "deploy the fix");
  await until(() => current(s.tg, pick).params.text === "✅ Sent to alice.", 4000, "picker edited");
  await until(() => s.tg.calls("setMessageReaction").length === 1, 4000, "👍 on the owner's message");
  assert.equal(Object.values(s.bridge.state().targets).some((x) => x.kind === "hold"), false, "deleted on use");
  tap(s.tg, pick, sessionButtons(pick)[0]); // a second tap: nothing more
  await until(() => s.tg.calls("answerCallbackQuery").length >= 2, 4000, "answered");
  await sleep(200);
  assert.equal(alice.got.filter((x) => x.from === "me-owner").length, 1, "sent once");
  // Cancel.
  s.tg.say("never mind this");
  const p2 = await next(s.tg, /^Who is this for\?$/, 1);
  tap(s.tg, p2, button(p2, "Cancel"));
  await until(() => current(s.tg, p2).params.text === "Cancelled. Nothing was sent.", 4000, "cancelled");
  assert.equal(Object.values(s.bridge.state().targets).some((x) => x.kind === "hold"), false);
  tap(s.tg, p2, sessionButtons(p2)[0]);
  await sleep(300);
  // A newer picker retires an older held text, and says so.
  s.tg.say("first text");
  const p3 = await next(s.tg, /^Who is this for\?$/, 2);
  s.tg.say("/msg");
  await until(() => current(s.tg, p3).params.text === "Cancelled. Nothing was sent.", 4000, "older held text dropped");
  // After 10 minutes the held text is gone.
  s.tg.say("later text");
  const p4 = await next(s.tg, /^Who is this for\?$/, 3);
  s.clock.skew = HOLD_MS + 1000;
  await s.bridge.tick();
  tap(s.tg, p4, sessionButtons(p4)[0]);
  await until(() => s.tg.calls("answerCallbackQuery").some((c) => c.params.text === "This list is old. Open a new one with /msg." || c.params.text === "This button has expired."), 4000, "expired");
  await sleep(200);
  assert.deepEqual(
    alice.got.filter((x) => x.from === "me-owner").map((x) => JSON.parse(x.text).text),
    ["deploy the fix"],
  );
});

test("a hold picker has at most 9 sessions with More…, Search and Cancel: 12 buttons", async (t) => {
  const s = await setup(t);
  for (let i = 0; i < 12; i++) await agent(t, s.url, s.tokens.me, `me-h${i}`);
  s.tg.say("hello all");
  const pick = await next(s.tg, /^Who is this for\?$/, 0);
  assert.equal(sessionButtons(pick).length, 9);
  assert.deepEqual(rows(pick).slice(-2).map((r) => r.map((b) => b.text)), [["More…", "🔍 Search"], ["Cancel"]]);
  assert.equal(flat(pick).length, 12);
  tap(s.tg, pick, button(pick, "More…"));
  await until(() => /Page 1 of 2\.$/.test(current(s.tg, pick).params.text), 4000, "page");
  const page = current(s.tg, pick);
  assert.deepEqual(rows(page).slice(-2).map((r) => r.map((b) => b.text)), [["◀ Back", "Next ▶"], ["Cancel"]]);
  assert.equal(flat(page).length, 11);
  tap(s.tg, page, button(page, "◀ Back"));
  await until(() => current(s.tg, pick).params.text === "Who is this for?", 4000, "back to the first screen");
});

// ---- names --------------------------------------------------------------------------------------

test("rename: an alias changes labels, never the recipient; refused names; '-' removes it; @alias is not resolved", async (t) => {
  const s = await setup(t);
  const mac = await agent(t, s.url, s.tokens.me, "me-claude-mac");
  const main = await agent(t, s.url, s.tokens.me, "me-other");
  s.tg.say("/agents");
  const list = await next(s.tg, /^Your agents: /, 0);
  tap(s.tg, list, sessionButtons(list).find((b) => b.text === "claude-mac"));
  const d = await next(s.tg, /^claude-mac\n/, 0, "details");
  tap(s.tg, d, button(d, "✏️ Rename"));
  const prompt = await next(s.tg, /^New name for claude-mac \(up to 24 characters\)\. Send "-" to remove the name\.$/, 0);
  s.tg.say("/msg"); // a picker made before the rename
  const old = await next(s.tg, /^Who should get your message\?$/, 0);
  for (const bad of ["other", "OTHER", "me-other"]) {
    const n = count(s.tg, /^That name is already used/);
    s.tg.say(bad, { reply: s.tg.replyTo(prompt) });
    await next(s.tg, /^That name is already used by another agent\. Pick another\.$/, n, bad);
  }
  for (const bad of ["@main", "/main", "a · b", "x".repeat(25), "💬 x"]) {
    const n = count(s.tg, /^Names can be/);
    s.tg.say(bad, { reply: s.tg.replyTo(prompt) });
    await next(s.tg, /^Names can be 1 to 24 characters/, n, bad);
  }
  s.tg.say("Main", { reply: s.tg.replyTo(prompt) });
  await until(() => current(s.tg, d).params.text.startsWith("Main (claude-mac)\n"), 4000, "renamed");
  assert.equal(peopleOf(s.home)["me-claude-mac"].alias, "Main");
  assert.ok(s.tg.calls("setMessageReaction").length >= 1, "👍 on the reply");
  // The old picker's button (made before the rename) still reaches the same agent.
  tap(s.tg, old, sessionButtons(old).find((b) => b.text === "claude-mac"));
  const p = await next(s.tg, /^✏️ Message to Main \(claude-mac\)\. Write it below\.$/, 0);
  assert.equal(p.params.reply_markup.input_field_placeholder, "Message to Main");
  s.tg.say("status?", { reply: s.tg.replyTo(p) });
  const got = await fromOwner(mac, "status?");
  assert.deepEqual(JSON.parse(got.text).to, { name: "me-claude-mac", member: ME });
  // @ keeps meaning a real name.
  s.tg.say("@Main hello");
  await next(s.tg, /^I don't know an agent called "Main"\. Did you mean Main \(claude-mac\)\? Use \/msg\.$/, 0);
  s.tg.say("@claude-mac hello");
  await fromOwner(mac, "hello");
  // New pickers show the alias.
  s.tg.say("/msg");
  const pick = await next(s.tg, /^Who should get your message\?$/, 1);
  assert.ok(sessionButtons(pick).some((b) => b.text === "Main"));
  // A route made before the rename (the owner's own message) still sends to the wire name.
  const own = s.tg.updates.find((u) => u.message?.text === "status?").message;
  s.tg.say("and again", { reply: { message_id: own.message_id, text: own.text } });
  const again = await fromOwner(mac, "and again");
  assert.deepEqual(JSON.parse(again.text).to, { name: "me-claude-mac", member: ME });
  // Another session taking over the name inherits the alias; the details screen shows the real name.
  mac.client.close();
  await until(async () => !(await s.bridge.relay.list()).some((p) => p.name === "me-claude-mac" && p.online), 4000, "gone");
  const mac2 = await agent(t, s.url, s.tokens.me, "me-claude-mac");
  const lists = count(s.tg, /^Your agents: /);
  s.tg.say("/agents");
  const l2 = await next(s.tg, /^Your agents: /, lists);
  tap(s.tg, l2, sessionButtons(l2).find((b) => b.text === "Main"));
  const d2 = await next(s.tg, /^Main \(claude-mac\)\n🟢 Online/, 0, "details of the new session");
  assert.ok(d2);
  // "-" removes the name.
  s.tg.say("-", { reply: s.tg.replyTo(prompt) });
  await until(() => current(s.tg, d).params.text.startsWith("claude-mac\n"), 4000, "name removed");
  assert.equal(peopleOf(s.home)["me-claude-mac"]?.alias, undefined);
  assert.equal(main.got.length, 0);
  assert.equal(mac2.got.length, 0);
});

test("labels: an alias colliding with an agent's name shows the full form; wire names me and me-me show as wire names", async (t) => {
  const s = await setup(t);
  await agent(t, s.url, s.tokens.me, "me-claude-mac");
  await agent(t, s.url, s.tokens.me, "me-main");
  await agent(t, s.url, s.tokens.me, "me");
  await agent(t, s.url, s.tokens.me, "me-me");
  await setPeople(s.home, ["me-claude-mac"], { alias: "Main" });
  s.tg.say("/msg");
  const pick = await next(s.tg, /^Who should get your message\?$/, 0);
  assert.deepEqual(sessionButtons(pick).map((b) => b.text).sort(), ["Main (claude-mac)", "main", "me", "me-me"]);
  s.tg.say("hello");
  const hold = await next(s.tg, /^Who is this for\?$/, 0);
  assert.ok(sessionButtons(hold).some((b) => b.text === "Main (claude-mac)"), "the hold picker shows full names");
});

test("labels: a session's title goes first with its name beside it; an alias wins; long titles are shortened; equal titles stay apart", async (t) => {
  const s = await setup(t);
  for (const n of ["me-a", "me-b", "me-c", "me-d", "me-e"]) await agent(t, s.url, s.tokens.me, n);
  s.titles.set("me-a", "Codex · hoptell");
  s.titles.set("me-b", "Claude · hoptell");
  s.titles.set("me-c", "Claude · hoptell");
  s.titles.set("me-d", `Claude · ${"x".repeat(60)}`);
  s.titles.set("me-e", "\u202eignored alias wins");
  await setPeople(s.home, ["me-e"], { alias: "Main" });
  await agent(t, s.url, s.tokens.me, "me-f1");
  await agent(t, s.url, s.tokens.me, "me-f2");
  await agent(t, s.url, s.tokens.me, `me-${"n".repeat(55)}1`);
  await agent(t, s.url, s.tokens.me, `me-${"n".repeat(55)}2`);
  s.titles.set("me-f1", "😀".repeat(32)); // 64 UTF-16 units: Telegram's whole button budget
  s.titles.set("me-f2", "😀".repeat(32));
  s.titles.set(`me-${"n".repeat(55)}1`, "Codex · hoptell");
  s.titles.set(`me-${"n".repeat(55)}2`, "Codex · hoptell");
  s.tg.say("/msg");
  const pick = await next(s.tg, /^Who should get your message\?$/, 0);
  const texts = sessionButtons(pick).map((b) => b.text);
  assert.equal(new Set(texts).size, texts.length, "every rendered button differs");
  for (const n of ["f1", "f2", `${"n".repeat(55)}1`, `${"n".repeat(55)}2`]) {
    assert.ok(texts.some((x) => x.endsWith(`(${n})`) || x === n), `the button for ${n} keeps its name: ${texts}`);
  }
  assert.ok(texts.every((x) => x.length <= 64));
  assert.ok(texts.includes(`${"😀".repeat(29)}… (f1)`), "astral titles are cut on whole characters before the name");
  assert.ok(texts.includes(`${"n".repeat(55)}1`), "too little room for the title: the name alone");
  const named = texts.filter((x) => !/^(f1|f2|n+[12])$/.test(x) && !/\((f1|f2)\)$/.test(x));
  assert.deepEqual(named.sort(), [
    "Claude · hoptell (b)",
    "Claude · hoptell (c)",
    `Claude · ${"x".repeat(22)}… (d)`,
    "Codex · hoptell (a)",
    "Main",
  ]);
});

// ---- the host check -----------------------------------------------------------------------------

test("host check: a name now held from another host asks first on every send without a new prompt; Send once; a later move warns again", async (t) => {
  const s = await setup(t);
  const mac = await agent(t, s.url, s.tokens.me, "me-claude-mac");
  await setPeople(s.home, ["me-claude-mac"], { alias: "Main", alias_host: "sam-mbp" });
  s.hosts.set("me-claude-mac", "sam-mbp");
  s.tg.say("@claude-mac first");
  await fromOwner(mac, "first");
  const ownMsg = s.tg.updates.at(-1).message;
  await until(() => s.tg.calls("setMessageReaction").length === 1, 4000, "👍");
  // The name moves: a reply to the owner's own message (a route) is not sent; the bot asks.
  s.hosts.set("me-claude-mac", "sam-linux");
  s.tg.say("second", { reply: { message_id: ownMsg.message_id, text: ownMsg.text } });
  const warn = await next(s.tg, /^⚠️ Main \(claude-mac\) reports running on sam-linux \(previously sam-mbp\)\.\nSend once, or remember this computer\?$/, 0);
  assert.deepEqual(rows(warn).map((r) => r.map((b) => b.text)), [["Send once", "Remember & send"], ["Cancel"]]);
  await sleep(200);
  assert.equal(mac.got.filter((x) => x.from === "me-owner").length, 1, "nothing sent");
  // The label shows the move, and so does the details screen.
  s.tg.say("/agents");
  const pick = await next(s.tg, /^Your agents: /, 0);
  assert.ok(sessionButtons(pick).some((b) => b.text === "⚠️ Main"));
  tap(s.tg, pick, sessionButtons(pick).find((b) => b.text === "⚠️ Main"));
  await next(s.tg, /^Main \(claude-mac\)\n🟢 Online · on sam-linux[^\n]*\n⚠️ This agent reports a different computer\.$/, 0, "details");
  // Send: once, for the host it warned about.
  tap(s.tg, warn, button(warn, "Send once"));
  await fromOwner(mac, "second");
  await until(() => current(s.tg, warn).params.text === "✅ Sent to Main (claude-mac).", 4000, "warning edited");
  tap(s.tg, warn, button(warn, "Send once"));
  await sleep(300);
  assert.equal(mac.got.filter((x) => x.from === "me-owner").length, 2, "once");
  // The baseline did not change: the next reply asks again.
  s.tg.say("third", { reply: { message_id: ownMsg.message_id, text: ownMsg.text } });
  const warn2 = await next(s.tg, /reports running on sam-linux \(previously sam-mbp\)/, 1);
  // Before the tap the name moves again: Send warns again instead of sending.
  s.hosts.set("me-claude-mac", "sam-third");
  tap(s.tg, warn2, button(warn2, "Send once"));
  await next(s.tg, /reports running on sam-third \(previously sam-mbp\)/, 0, "warned again");
  assert.equal(mac.got.filter((x) => x.from === "me-owner").length, 2);
  // Remember & send: the new host becomes the baseline; an older warning then sends without asking.
  s.tg.say("fourth", { reply: { message_id: ownMsg.message_id, text: ownMsg.text } });
  const w4 = await next(s.tg, /reports running on sam-third \(previously sam-mbp\)/, 1);
  s.tg.say("fifth", { reply: { message_id: ownMsg.message_id, text: ownMsg.text } });
  const w5 = await next(s.tg, /reports running on sam-third \(previously sam-mbp\)/, 2);
  tap(s.tg, w4, button(w4, "Remember & send"));
  await fromOwner(mac, "fourth");
  assert.equal(peopleOf(s.home)["me-claude-mac"].alias_host, "sam-third");
  s.tg.say("sixth", { reply: { message_id: ownMsg.message_id, text: ownMsg.text } });
  await fromOwner(mac, "sixth");
  tap(s.tg, w5, button(w5, "Cancel"));
  await until(() => current(s.tg, w5).params.text === "Cancelled. Nothing was sent.", 4000, "cancelled");
  await sleep(200);
  assert.equal(mac.got.some((x) => x.from === "me-owner" && JSON.parse(x.text).text === "fifth"), false);
  assert.equal(JSON.stringify(readAudit(s.home)).includes("fifth"), false);
});

test("host check at dispatch: a send waiting on the relay is checked when it goes out, not when it was made", async (t) => {
  const s = await setup(t);
  const mac = await agent(t, s.url, s.tokens.me, "me-claude-mac");
  await setPeople(s.home, ["me-claude-mac"], { alias: "Main", alias_host: "sam-mbp" });
  s.hosts.set("me-claude-mac", "sam-mbp");
  s.tg.say("/msg");
  const pick = await next(s.tg, /^Who should get your message\?$/, 0);
  tap(s.tg, pick, sessionButtons(pick)[0]);
  const prompt = await next(s.tg, /^✏️ Message to Main \(claude-mac\)/, 0);
  // The relay cannot list now: the send waits (its host cannot be checked) …
  s.shape.failList = true;
  s.tg.say("go", { reply: s.tg.replyTo(prompt) });
  await until(() => s.bridge.state().outbox.some((e) => e.steps.some((x) => x.t === "send" && x.host_check)), 4000, "waiting");
  // … meanwhile the name moves; when the relay answers again, the send asks first.
  s.hosts.set("me-claude-mac", "sam-linux");
  s.shape.failList = false;
  await next(s.tg, /reports running on sam-linux \(previously sam-mbp\)/, 0, "checked at dispatch");
  await sleep(200);
  assert.equal(mac.got.filter((x) => x.from === "me-owner").length, 0);
});

test("host check: an offline name and a name without an alias are not checked; @name is not checked", async (t) => {
  const s = await setup(t);
  const bob = await agent(t, s.url, s.tokens.me, "me-bob");
  s.hosts.set("me-bob", "elsewhere");
  await setPeople(s.home, ["me-bob"], { fav: true }); // no alias: no baseline
  s.tg.say("@bob one");
  await fromOwner(bob, "one");
  const own = s.tg.updates.at(-1).message;
  s.tg.say("two", { reply: { message_id: own.message_id, text: own.text } });
  await fromOwner(bob, "two");
});

// ---- notes: hidden and favourite sessions ---------------------------------------------------------

test("notes: a hidden session's note is not shown (counted, one status); a favourite's note notifies", async (t) => {
  const s = await setup(t);
  const quiet = await agent(t, s.url, s.tokens.me, "me-quiet");
  const fav = await agent(t, s.url, s.tokens.me, "me-fav");
  await setPeople(s.home, ["me-quiet"], { hidden: true });
  await setPeople(s.home, ["me-fav"], { fav: true });
  await quiet.client.send("me-owner", "noise one", undefined, undefined, { toMember: ME });
  await quiet.client.send("me-owner", "noise two", undefined, undefined, { toMember: ME });
  await quiet.waitFor((m) => m.from === "me-owner" && JSON.parse(m.text).text === "not shown: your owner has hidden this session.");
  await until(() => s.bridge.state().drops.notice_hidden === 2, 4000, "counted");
  await sleep(200);
  assert.equal(quiet.got.filter((m) => m.from === "me-owner").length, 1, "one status per hour");
  assert.equal(s.tg.texts().some((x) => x.includes("noise")), false);
  await fav.client.send("me-owner", "Build done.", undefined, undefined, { toMember: ME });
  await until(() => s.tg.last(/^💬 fav:/), 4000, "note");
  assert.equal(s.tg.last(/^💬 fav:/).params.disable_notification, undefined, "a favourite's note notifies");
  // Notes, questions and sends record when the owner last talked with an agent.
  await until(() => peopleOf(s.home)["me-fav"]?.last_talked > 0, 4000, "last_talked");
});

test("menu: a favourite named agents gets no command and /agents stays the static one; offline favourites keep theirs", async (t) => {
  const s = await setup(t);
  await agent(t, s.url, s.tokens.me, "me-agents");
  const zed = await agent(t, s.url, s.tokens.me, "me-zed");
  await setPeople(s.home, ["me-agents", "me-zed"]);
  await s.bridge.menuCheck();
  const cmds = s.tg.calls("setMyCommands").at(-1).params.commands;
  assert.deepEqual(cmds.map((c) => c.command), ["msg", "agents", "pending", "help", "zed"]);
  assert.deepEqual(cmds.slice(0, 4).map((c) => c.description), ["Message an agent", "Your agents and favourites", "Questions waiting for you", "How this works"]);
  zed.client.close();
  await sleep(200);
  await s.bridge.menuCheck();
  assert.ok(s.tg.calls("setMyCommands").at(-1).params.commands.some((c) => c.command === "zed"), "offline favourite");
  s.tg.say("/agents");
  await next(s.tg, /^Your agents: 2 favourites, 1 online\.$/, 0);
});

test("first_seen: the bridge records when it first saw each agent online; unpaired, nothing is written", async (t) => {
  const s = await setup(t);
  await agent(t, s.url, s.tokens.me, "me-alice");
  await s.bridge.menuCheck();
  await until(() => peopleOf(s.home)["me-alice"]?.first_seen > 0, 4000, "first_seen");
  const first = peopleOf(s.home)["me-alice"].first_seen;
  await s.bridge.menuCheck();
  await sleep(1300);
  assert.equal(peopleOf(s.home)["me-alice"].first_seen, first, "kept");
  const u = await setup(t, { unpaired: true });
  await agent(t, u.url, u.tokens.me, "me-bob");
  await u.bridge.menuCheck();
  await sleep(1300);
  assert.equal(fs.existsSync(peoplePath(u.home)), false);
});

test("a new pairing by another Telegram user starts with no favourites: people.json is ignored", async (t) => {
  const s = await setup(t);
  await agent(t, s.url, s.tokens.me, "me-alice");
  await setPeople(s.home, ["me-alice"], { fav: true, alias: "Main" });
  paired(s.home, { user: 777, chat: 777, id: "p_otherpairingxxxx" });
  s.tg.say("/msg", { from: 777, chat: 777 });
  const pick = await next(s.tg, /^Who should get your message\?$/, 0);
  assert.deepEqual(sessionButtons(pick).map((b) => b.text), ["alice"], "no alias, no favourite");
});

test("a rename made under an earlier pairing is not saved, even when the pairing changes while the relay list is awaited", async (t) => {
  const s = await setup(t);
  await agent(t, s.url, s.tokens.me, "me-alice");
  s.tg.say("/agents");
  const list = await next(s.tg, /^Your agents: /, 0);
  tap(s.tg, list, sessionButtons(list)[0]);
  const d = await next(s.tg, /^alice\n/, 0, "details");
  tap(s.tg, d, button(d, "✏️ Rename"));
  const prompt = await next(s.tg, /^New name for alice/, 0);
  let open;
  s.shape.gate = new Promise((r) => (open = r));
  const calls = s.shape.listCalls;
  s.tg.say("Old owner alias", { reply: s.tg.replyTo(prompt) });
  await until(() => s.shape.listCalls > calls, 4000, "the rename waits on the relay");
  paired(s.home, { user: 777, chat: 777, id: "p_otherpairingxxxx" }); // another owner pairs meanwhile
  open();
  s.shape.gate = null;
  await sleep(500);
  assert.deepEqual(peopleOf(s.home, { owner: 777 }), Object.create(null), "nothing in the new owner's file");
  assert.equal(peopleOf(s.home)["me-alice"]?.alias, undefined, "nor in the old one's");
});

test("a rename checks its name under the lock: a name taken meanwhile (by the CLI) is refused", async (t) => {
  const s = await setup(t);
  await agent(t, s.url, s.tokens.me, "me-alice");
  await agent(t, s.url, s.tokens.me, "me-bob");
  s.tg.say("/agents");
  const list = await next(s.tg, /^Your agents: /, 0);
  tap(s.tg, list, sessionButtons(list).find((b) => b.text === "alice"));
  const d = await next(s.tg, /^alice\n/, 0, "details");
  tap(s.tg, d, button(d, "✏️ Rename"));
  const prompt = await next(s.tg, /^New name for alice/, 0);
  let open;
  s.shape.gate = new Promise((r) => (open = r));
  const calls = s.shape.listCalls;
  s.tg.say("Main", { reply: s.tg.replyTo(prompt) });
  await until(() => s.shape.listCalls > calls, 4000, "the rename waits on the relay");
  await setPeople(s.home, ["me-bob"], { alias: "main" }); // as hoptell telegram alias would, meanwhile
  open();
  s.shape.gate = null;
  await next(s.tg, /^That name is already used by another agent\. Pick another\.$/, 0, "refused");
  assert.equal(peopleOf(s.home)["me-alice"]?.alias, undefined);
  assert.equal(peopleOf(s.home)["me-bob"].alias, "main");
});

test("signals of an earlier owner are dropped, never written over the new owner's file", async (t) => {
  const s = await setup(t);
  const alice = await agent(t, s.url, s.tokens.me, "me-alice");
  s.tg.say("@alice hello");
  await fromOwner(alice, "hello"); // a last_talked signal is pending now (written within a second)
  paired(s.home, { user: 777, chat: 777, id: "p_otherpairingxxxx" });
  await setPeople(s.home, ["me-bob"], { fav: true }, { owner: 777 });
  await sleep(1500);
  const b = peopleOf(s.home, { owner: 777 });
  assert.equal(b["me-bob"].fav, true, "the new owner's preferences stay");
  assert.equal(b["me-alice"], undefined, "the old owner's signal is not in them");
});

test("host check: a re-pair while the host is being checked retires the send; nothing goes out under the new pairing", async (t) => {
  const s = await setup(t);
  const mac = await agent(t, s.url, s.tokens.me, "me-claude-mac");
  await setPeople(s.home, ["me-claude-mac"], { alias: "Main", alias_host: "sam-mbp" });
  s.hosts.set("me-claude-mac", "sam-mbp");
  s.tg.say("@claude-mac first");
  await fromOwner(mac, "first");
  const own = s.tg.updates.at(-1).message;
  await until(() => s.tg.calls("setMessageReaction").length === 1, 4000, "👍");
  // The send waits first (the relay cannot list), so the next list call is its host check.
  s.shape.failList = true;
  s.tg.say("second", { reply: { message_id: own.message_id, text: own.text } });
  await until(() => s.bridge.state().outbox.some((e) => e.steps.some((x) => x.t === "send" && x.host_check)), 4000, "waiting");
  let open;
  s.shape.gate = new Promise((r) => (open = r));
  const calls = s.shape.listCalls;
  s.shape.failList = false;
  await until(() => s.shape.listCalls > calls, 4000, "the send checks the host");
  paired(s.home, { id: "p_samepersonnewxyz" }); // the same owner pairs again meanwhile
  open();
  s.shape.gate = null;
  await until(() => (s.bridge.state().drops.old_pairing ?? 0) >= 1, 4000, "retired");
  await sleep(300);
  assert.equal(mac.got.some((m) => m.from === "me-owner" && JSON.parse(m.text).text === "second"), false);
});

/** Write the home's contacts policy atomically (a new file: every reader sees the change). */
function writePolicy(home, encryption) {
  const doc = { ...freshContacts(), revision: Date.now(), grants: [{ realm: REALM, member: ME }], ...(encryption ? { encryption } : {}) };
  assert.deepEqual(validateContacts(doc), []);
  const f = contactsFile(home);
  fs.writeFileSync(`${f}.tmp`, JSON.stringify(doc), { mode: 0o600 });
  fs.renameSync(`${f}.tmp`, f);
}

test("host check: a policy that becomes required while the host is being checked refuses the send; nothing reaches the agent", async (t) => {
  const home = tmpHome(t);
  writePolicy(home, null); // managed, no encryption policy: the bridge runs
  const s = await setup(t, { home });
  const mac = await agent(t, s.url, s.tokens.me, "me-claude-mac");
  await setPeople(s.home, ["me-claude-mac"], { alias: "Main", alias_host: "sam-mbp" });
  s.hosts.set("me-claude-mac", "sam-mbp");
  s.tg.say("@claude-mac first");
  await fromOwner(mac, "first");
  const own = s.tg.updates.at(-1).message;
  await until(() => s.tg.calls("setMessageReaction").length === 1, 4000, "👍");
  // The send waits first (the relay cannot list), so the next list call is its host check.
  s.shape.failList = true;
  s.tg.say("second", { reply: { message_id: own.message_id, text: own.text } });
  await until(() => s.bridge.state().outbox.some((e) => e.steps.some((x) => x.t === "send" && x.host_check)), 4000, "waiting");
  let open;
  s.shape.gate = new Promise((r) => (open = r));
  const calls = s.shape.listCalls;
  s.shape.failList = false;
  await until(() => s.shape.listCalls > calls, 4000, "the send checks the host");
  writePolicy(s.home, [{ realm: REALM, mode: "required" }]); // meanwhile
  open();
  s.shape.gate = null;
  await until(() => readAudit(s.home).some((e) => e.event === "refused" && e.reason === "encryption_required" && e.kind === "instruction"), 4000, "refused");
  await until(() => s.tg.texts().some((x) => /^⚠️ Not sent: your settings require end-to-end encryption/.test(x)), 4000, "the owner is told");
  await until(() => s.bridge.state().outbox.length === 0, 4000, "the entry ended");
  await sleep(300);
  assert.equal(mac.got.some((m) => m.from === "me-owner" && JSON.parse(m.text).text === "second"), false, "nothing sent");
});
