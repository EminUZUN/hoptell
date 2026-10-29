// Where a waiting session is told (design 9, B): the injector's control connection (v2 correction
// 1), the lead's notice, and the owner's Telegram note, which the bridge words itself and never
// fills with screen text. A fake Telegram and test relays only.
import "./neutral-host.js"; // first: before any module reads the computer's name
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { EventEmitter } from "node:events";
import { RelayClient } from "../lib/client.js";
import * as sig from "../lib/ownersig.js";
import { CONTROL_TRIES, controlFileOf, createControl, drawControlName, readControlName } from "../lib/control.js";
import { openOccurrence, parseWaitNote, waitNoteText } from "../lib/waits.js";
import { waitSurface } from "../lib/tmux.js";
import { SUBTYPES } from "../lib/prompts.js";
import { WAIT_WHAT } from "../lib/ownertexts.js";
import { WAIT_HOURLY } from "../lib/ownerchannel.js";
import { canonicalize } from "../lib/jcs.js";
import { ME, REALM, agent, bridgeOn, fakeTelegram, newKey, ownerRelay, paired, peopleOf, setPeople, textProblems, tmpHome, until } from "./owner-helpers.js";

const NOW = Date.parse("2026-10-29T10:12:00Z");
const OWNER = Object.freeze({ tmux: "$1", pane: "%3", injector: { pid: 4242, start: "s", uid: 501, boot: "b1" } });
const occurrence = (home, name, start) => openOccurrence(home, name, start, { owner: OWNER, now: () => NOW });

test("the note: canonical JSON with fixed fields, display only; anything else is not one", (t) => {
  const home = tmpHome(t);
  const rec = occurrence(home, "me-alice", { kind: "prompt", subtype: "codex-startup-trust", actionable: false, since: NOW - 120_000 });
  const text = waitNoteText(rec, { session: "me-alice", team: "n4", folder: "app", now: NOW });
  assert.deepEqual(parseWaitNote(text), { hoptell_wait: 1, kind: "prompt", subtype: "codex-startup-trust", session: "me-alice", team: "n4", folder: "app", minutes: 2, nonce: rec.nonce });
  assert.equal(parseWaitNote(waitNoteText(null, { session: "me-alice" })).kind, "summary");
  const v = JSON.parse(text);
  for (const bad of [{ ...v, screen: "pane text" }, { ...v, subtype: "rm -rf" }, { ...v, folder: "a\nb" }, { ...v, session: "not a name!" }, { ...v, hoptell_wait: 2 }]) assert.equal(parseWaitNote(JSON.stringify(bad)), null);
  assert.equal(parseWaitNote(JSON.stringify(v, null, 1)), null, "not canonical");
  // Every field has its type checked first; nothing a sender writes makes the parser throw.
  const poison = { toString: null, valueOf: null };
  for (const bad of [{ session: 1 }, { session: true }, { session: null }, { session: poison }, { session: ["me-alice"] }, { subtype: poison }, { kind: poison }, { team: 7 }, { folder: poison }, { nonce: [rec.nonce] }, { minutes: "2" }, { hoptell_wait: poison }]) {
    let got;
    assert.doesNotThrow(() => (got = parseWaitNote(canonicalize({ ...v, ...bad }))), JSON.stringify(bad));
    assert.equal(got, null, JSON.stringify(bad));
  }
  for (const x of [null, 1, {}, poison, "{", '{"hoptell_wait":1}']) assert.doesNotThrow(() => assert.equal(parseWaitNote(x), null));
  // Every subtype the injector can see has the bridge's words.
  for (const s of SUBTYPES) assert.ok(WAIT_WHAT[s], s);
});

/** A stand-in RelayClient: `refuse(name)` says whether the relay refuses that name. */
function fakeClients({ member = "me", refuse = () => false, gate = null } = {}) {
  const made = [];
  const client = ({ name, mode }) => {
    const c = Object.assign(new EventEmitter(), {
      name,
      mode,
      connected: false,
      closed: false,
      member: { id: ME, name: member },
      realm: { id: REALM },
      start() {
        return c;
      },
      async ready() {
        if (gate) await gate;
        if (name !== null && refuse(name)) throw new Error("name not allowed");
        c.connected = !c.closed;
      },
      close() {
        c.connected = false;
        c.closed = true;
      },
      supportsToMember: () => true,
      sent: [],
      async send(to, text, ttl, ref, opts) {
        c.sent.push({ to, text, opts });
        return { state: "queued" };
      },
    });
    made.push(c);
    return c;
  };
  return { client, made };
}

test("control names: the member's name intact with -c<random>, kept for the session, drawn again when refused, at most 5 tries", async (t) => {
  assert.match(drawControlName("me"), /^me-c[a-z2-7]{10}$/);
  assert.equal(drawControlName("m".repeat(54)).length, 64);
  assert.equal(drawControlName("m".repeat(61)).length, 64);
  for (const n of [62, 63]) assert.equal(drawControlName("m".repeat(n)), null, `a member name of ${n} characters plus "-c" leaves no room`);
  const home = tmpHome(t);
  sig.trustPin(home, sig.formatPin({ realm: REALM, name: "me-owner", pub: newKey().pub }));
  const policy = () => ({ legacy: true });
  let refused = 0;
  const f = fakeClients({ refuse: (n) => n.startsWith("me-c") && refused++ < 2 });
  const logs = [];
  const control = createControl({ home, name: "me-alice", client: f.client, policy, log: (l) => logs.push(l) });
  assert.equal(await control.note("x"), true);
  const used = f.made.at(-1);
  assert.equal(f.made[0].name, null, "first an automatic name, to learn the member");
  assert.equal(f.made.filter((c) => c.name?.startsWith("me-c")).length, 3, "two refused, the third taken");
  assert.equal(readControlName(home, "me-alice", "me"), used.name, "kept for the session");
  assert.deepEqual(used.sent[0], { to: "me-owner", text: "x", opts: { toMember: ME } });
  // A new injector for the session asks for the same name first.
  const g = fakeClients();
  await createControl({ home, name: "me-alice", client: g.client, policy }).note("y");
  assert.equal(g.made.at(-1).name, used.name);
  // Refused every time: at most CONTROL_TRIES names, then notes stay local.
  const h = fakeClients({ refuse: (n) => n !== null });
  const said = [];
  const none = createControl({ home: tmpHome(t), name: "me-bob", client: h.client, policy, log: (l) => said.push(l) });
  assert.equal(await none.note("z"), false);
  assert.equal(h.made.filter((c) => c.name !== null).length, CONTROL_TRIES);
  assert.match(said.join("\n"), new RegExp(`no control name after ${CONTROL_TRIES} tries`));
  assert.equal(await none.note("z"), false);
  assert.equal(h.made.length, CONTROL_TRIES + 1, "never tried again in this run");
  assert.equal(fs.existsSync(controlFileOf(tmpHome(t), "me-bob")), false);
  // No trusted owner channel: nothing is sent, said once.
  const i = fakeClients();
  const quiet = [];
  const nopin = createControl({ home: tmpHome(t), name: "me-carol", client: i.client, policy, log: (l) => quiet.push(l) });
  assert.equal(await nopin.note("z"), false);
  assert.equal(await nopin.note("z"), false);
  assert.deepEqual(quiet, ["owner notes about this session are not sent: this realm has no trusted owner channel"]);
});

test("the control connection: one connect for notes and tells at once, a name not kept is closed before the next, and close reaches a connect in progress", async (t) => {
  const pinned = () => {
    const h = tmpHome(t);
    sig.trustPin(h, sig.formatPin({ realm: REALM, name: "me-owner", pub: newKey().pub }));
    return h;
  };
  const policy = () => ({ legacy: true });
  const open = (f) => f.made.filter((c) => !c.closed);
  // A note and a tell at the same time share one connect: one probe, one control connection.
  const f = fakeClients();
  const control = createControl({ home: pinned(), name: "me-alice", client: f.client, policy });
  assert.deepEqual(await Promise.all([control.note("x"), control.tell("me-lead", "y"), control.note("z")]), [true, true, true]);
  assert.equal(f.made.length, 2);
  assert.deepEqual(open(f).map((c) => c.name), [f.made[1].name]);
  control.close();
  assert.deepEqual(open(f), [], "close closes it");
  assert.equal(await control.note("later"), false);
  assert.equal(f.made.length, 2, "nothing opened after close");
  // The name cannot be kept (its record cannot be written): that connection is closed before the
  // next name is drawn, so the tries leave nothing open.
  const home = pinned();
  fs.mkdirSync(controlFileOf(home, "me-bob"), { recursive: true }); // a folder where the record goes
  const g = fakeClients();
  const logs = [];
  const bob = createControl({ home, name: "me-bob", client: g.client, policy, log: (l) => logs.push(l) });
  assert.equal(await bob.note("x"), false);
  assert.equal(g.made.length, CONTROL_TRIES + 1);
  assert.deepEqual(open(g), []);
  assert.match(logs.join("\n"), new RegExp(`no control name after ${CONTROL_TRIES} tries`));
  // Closed while connecting: the connection that comes up later is closed, and the note not sent.
  let letGo;
  const h = fakeClients({ gate: new Promise((r) => (letGo = r)) });
  const carol = createControl({ home: pinned(), name: "me-carol", client: h.client, policy });
  const pending = carol.note("x");
  await new Promise((r) => setImmediate(r));
  carol.close();
  letGo();
  assert.equal(await pending, false);
  assert.deepEqual(open(h), []);
  assert.equal(h.made.flatMap((c) => c.sent).length, 0);
});

test("the surfaces: one lead notice per occurrence with the attach command (team members only), and the owner's notes within the budget", (t) => {
  const home = tmpHome(t);
  const told = [];
  const notes = [];
  const control = { tell: (to, text) => told.push({ to, text }), note: (text) => notes.push(parseWaitNote(text)) };
  const team = waitSurface(home, "me-alice", { control, team: { team: "n4", lead: "me-lead" }, folder: "app", now: () => NOW });
  const rec = occurrence(home, "me-alice", { kind: "prompt", subtype: "codex-startup-trust", actionable: false, since: NOW });
  team.start(rec);
  assert.deepEqual(told, [{ to: "me-lead", text: `hoptell: automated notice, not a user message. me-alice (team n4) needs a look: Codex folder trust (${rec.id}). Attach: tmux attach -t '=hoptell-me-alice'` }]);
  assert.deepEqual([notes.length, notes[0].session, notes[0].team, notes[0].folder, notes[0].nonce], [1, "me-alice", "n4", "app", rec.nonce]);
  // A repaint makes a new occurrence of the same kind within 5 minutes: the lead hears of it, the owner not.
  team.start(occurrence(home, "me-alice", { kind: "prompt", subtype: "codex-startup-trust", actionable: false, since: NOW }));
  assert.deepEqual([told.length, notes.length], [2, 1]);
  // Not a team member: no lead notice.
  const solo = waitSurface(home, "me-rev", { control, now: () => NOW });
  solo.start(occurrence(home, "me-rev", { kind: "stall", subtype: "busy", actionable: false, since: NOW - 11 * 60_000 }));
  assert.deepEqual([told.length, notes.length, notes[1].kind, notes[1].team], [2, 2, "stall", null]);
});

test("the bridge words a waiting session's note itself: never screen text, no people signal for the control name, hidden sessions skipped", async (t) => {
  const r = await ownerRelay(t);
  const home = tmpHome(t);
  paired(home);
  const tg = fakeTelegram();
  const { bridge } = bridgeOn(t, { home, telegram: tg.client(), url: r.url, token: r.tokens.me, key: newKey() });
  await until(() => bridge.leading(), 4000, "leadership");
  const ctl = await agent(t, r.url, r.tokens.me, "me-cabcdefghij"); // the injector's control name
  const send = (text) => ctl.client.send("me-owner", text, 600, undefined, { toMember: ME });
  const src = tmpHome(t);
  const rec = occurrence(src, "me-alice", { kind: "prompt", subtype: "codex-startup-trust", actionable: false, since: NOW - 120_000 });
  await send(waitNoteText(rec, { session: "me-alice", team: "n4", folder: "app", now: NOW }));
  await until(() => tg.last(/^⏳/), 4000, "the note");
  const shown = tg.last(/^⏳/).params.text;
  assert.equal(shown, "⏳ A session on your Mac reports that alice is waiting for you: Codex folder trust (team n4), in app.\nOpen its terminal on the Mac: hoptell team status shows how.");
  assert.deepEqual(textProblems(shown), []);
  // The same occurrence again (a redelivery or a copy): shown once.
  await send(waitNoteText(rec, { session: "me-alice", team: "n4", folder: "app", now: NOW }));
  const stall = occurrence(src, "me-bob", { kind: "stall", subtype: "busy", actionable: false, since: NOW - 12 * 60_000 });
  await send(waitNoteText(stall, { session: "me-bob", now: NOW }));
  await until(() => tg.last(/^⏳ .* bob /), 4000, "the stall note");
  assert.equal(tg.last(/^⏳ .* bob /).params.text, "⏳ A session on your Mac reports that bob has shown no change for 12 min. It may be stuck.\nOpen its terminal on the Mac to check it.");
  assert.equal(tg.calls("sendMessage").filter((c) => /^⏳ .* alice /.test(c.params.text)).length, 1, "posted once");
  // A hidden session's note is not shown; the summary line is.
  await setPeople(home, ["me-carol"], { hidden: true });
  await send(waitNoteText(occurrence(src, "me-carol", { kind: "prompt", subtype: "approval", actionable: false, since: NOW }), { session: "me-carol", now: NOW }));
  await send(waitNoteText(null, { session: "me-alice" }));
  await until(() => tg.last(/^⏳ More sessions/), 4000, "the summary");
  assert.equal(tg.calls("sendMessage").filter((c) => /carol/.test(c.params.text)).length, 0);
  // The control name is never one of the owner's agents.
  assert.equal(peopleOf(home)["me-cabcdefghij"], undefined);
});

test("end to end: the control connection on a test relay reaches the bridge as the member's own", async (t) => {
  const r = await ownerRelay(t);
  const home = tmpHome(t);
  paired(home);
  const tg = fakeTelegram();
  const key = newKey();
  const { bridge } = bridgeOn(t, { home, telegram: tg.client(), url: r.url, token: r.tokens.me, key });
  await until(() => bridge.leading(), 4000, "leadership");
  const mine = tmpHome(t);
  sig.trustPin(mine, sig.formatPin({ realm: REALM, name: "me-owner", pub: key.pub }));
  const clients = [];
  const client = ({ name, mode, reconnect }) => {
    const c = new RelayClient({ url: r.url, token: r.tokens.me, name, mode, reconnect, require2: true });
    clients.push(c);
    return c;
  };
  t.after(() => clients.forEach((c) => c.close()));
  const control = createControl({ home: mine, name: "me-alice", client, policy: () => ({ legacy: true }) });
  const rec = occurrence(mine, "me-alice", { kind: "prompt", subtype: "mcp-trust", actionable: false, since: NOW });
  assert.equal(await control.note(waitNoteText(rec, { session: "me-alice", now: NOW })), true);
  await until(() => tg.last(/^⏳ .* alice /), 4000, "the note");
  assert.match(readControlName(mine, "me-alice", "me"), /^me-c[a-z2-7]{10}$/);
  control.close();
});

test("the bridge's own budget: one note per claimed session and kind every 5 minutes, 20 an hour per member, then one summary and silence; a note that is not one is confirmed and dropped", async (t) => {
  const r = await ownerRelay(t);
  const home = tmpHome(t);
  paired(home);
  const tg = fakeTelegram();
  const clock = { skew: 0 };
  const { bridge } = bridgeOn(t, { home, telegram: tg.client(), url: r.url, token: r.tokens.me, key: newKey(), now: () => Date.now() + clock.skew });
  await until(() => bridge.leading(), 4000, "leadership");
  // Any connection of the own member may send one: nothing in it is taken as checked.
  const ctl = await agent(t, r.url, r.tokens.me, "me-cabcdefghij");
  const send = async (text) => (await ctl.client.send("me-owner", text, 600, undefined, { toMember: ME })).message_id.toLowerCase();
  const src = tmpHome(t);
  const note = (session, kind = "prompt") => waitNoteText(occurrence(src, session, kind === "prompt" ? { kind, subtype: "approval", actionable: false, since: NOW } : { kind, subtype: "busy", actionable: false, since: NOW - 11 * 60_000 }), { session, now: NOW });
  const waits = () => tg.calls("sendMessage").filter((c) => /^⏳/.test(c.params.text)).map((c) => c.params.text);
  const drops = (k) => bridge.state().drops[k] ?? 0;
  // A report with a field of the wrong type: never shown, and confirmed (taken, not redelivered).
  const poisoned = await send(canonicalize({ ...JSON.parse(note("me-alice")), session: { toString: null, valueOf: null } }));
  await until(() => Object.hasOwn(bridge.state().notices_seen, poisoned), 4000, "the poisoned report taken");
  assert.equal(drops("malformed"), 1);
  // The same claimed session and kind with fresh nonces: once in 5 minutes; another kind is apart.
  await send(note("me-alice"));
  await send(note("me-alice"));
  await send(note("me-alice", "stall"));
  await until(() => drops("wait_cooldown") === 1 && waits().length === 2, 4000, "the cooldown");
  // Up to WAIT_HOURLY an hour for the member, then one summary line, then nothing.
  for (let i = 0; i < WAIT_HOURLY + 1; i++) await send(note(`me-s${i}`));
  await until(() => drops("wait_rate") === 2, 8000, "the hour's limit");
  const all = waits();
  assert.equal(all.length, WAIT_HOURLY + 1);
  assert.match(all.at(-1), /^⏳ More sessions are waiting/);
  assert.equal(all.filter((x) => /More sessions/.test(x)).length, 1);
  // Counted in the bridge's own state.
  assert.equal(bridge.state().wait_rate.members[ME].length, WAIT_HOURLY);
  // After the hour: notes again.
  clock.skew = 61 * 60_000;
  await send(note("me-later"));
  await until(() => waits().some((x) => / later /.test(x)), 4000, "a new hour");
  assert.equal(tg.calls("sendMessage").filter((c) => /toString|\[object/.test(c.params.text)).length, 0);
});

test("the control connection tells onReady of every connection it gets: the first, a fresh one after it ended (a name drawn again too), and a reconnect", async (t) => {
  const home = tmpHome(t);
  const { client, made } = fakeClients();
  let ready = 0;
  const control = createControl({ home, name: "me-alice", client, policy: () => ({ legacy: true }), onReady: () => ready++ });
  const first = await control.whoami();
  assert.equal(ready, 1, "the first connection");
  const peer = made.find((c) => c.name === first.name);
  peer.emit("ready"); // a reconnect of the same connection
  assert.equal(ready, 2);
  // The connection ends (refused later): the next use makes a fresh one, which is told too.
  peer.emit("fatal", "replaced");
  await control.whoami();
  assert.equal(ready, 3, "a fresh replacement connection");
  control.close();
});
