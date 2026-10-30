// A waiting session's startup prompt on the owner's Telegram (design 9, C): the injector's control
// connection as a receiving peer that holds its name, the card it asks for from the bridge, the
// owner's tap signed back to it, and the injector's publisher. A fake Telegram and test relays only.
import "./neutral-host.js"; // first: before any module reads the computer's name
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { RelayClient, formatPeers } from "../lib/client.js";
import * as sig from "../lib/ownersig.js";
import { canonicalize } from "../lib/jcs.js";
import { CONTROL_ROLE, controlFileOf, createControl } from "../lib/control.js";
import { CARD_MS, START_MS, answerableOptions, manifestDigest, parseAnswer, parsePromptRequest, promptRequestText, resultKeyId, resultText } from "../lib/promptcards.js";
import { cardPublisher, promptFileOf, readPromptRecord, writePromptRecord } from "../lib/promptflow.js";
import { RESULT_WAIT_MS } from "../lib/ownerchannel.js";
import { waitSurface } from "../lib/tmux.js";
import { ME, OWNER_CHAT, REALM, agent, bridgeOn, fakeTelegram, newKey, ownerRelay, paired, peopleOf, setPeople, textProblems, tmpHome, until } from "./owner-helpers.js";
import { sleep } from "./helpers.js";

const CTL = "me-cabcdefghij";
const manifestFor = (over = {}) => {
  const t = Date.now();
  return {
    hoptell_prompt_manifest: 1,
    realm: REALM,
    profile: null,
    home: "1".repeat(32),
    recipient: { member: ME, control: CTL },
    launch: "2".repeat(32),
    team: "n4",
    session: "me-alice",
    scope: { root: "/Users/x/app", folder: "/Users/x/app" },
    cli: { name: "codex", path: "/opt/homebrew/bin/codex", version: "0.165.0" },
    host: { pid: 4242, start: "Wed Oct 29 10:00:00 2026", uid: 501, boot: "b1" },
    tmux: { socket: "/private/tmp/tmux-501/default", session: "$3", pane: "%7" },
    subtype: "codex-startup-trust",
    options: answerableOptions("0.165.0")[0].map((o) => ({ ...o })),
    untested: false,
    selected: 1,
    dialog: "c".repeat(64),
    captured_at: (over.created_at ?? t) - 2000,
    created_at: t,
    expires_at: t + CARD_MS,
    nonce: [..."0123456789abcdef0123456789abcdef"].sort(() => Math.random() - 0.5).join(""),
    ...over,
  };
};
const promptCards = (tg) => tg.sent.filter((s) => s.method === "sendMessage" && /^🔐 /.test(s.params.text) && s.params.reply_markup?.inline_keyboard);

/** A bridge on a test relay, and the injector's control connection as a raw receiving peer. */
async function setup(t, { control = CTL, tickMs = 60_000, clientFactory = undefined } = {}) {
  const r = await ownerRelay(t);
  const home = tmpHome(t);
  paired(home);
  const tg = fakeTelegram();
  const key = newKey();
  const clock = { skew: 0 };
  const { bridge } = bridgeOn(t, { home, telegram: tg.client(), url: r.url, token: r.tokens.me, key, tickMs, ...(clientFactory ? { clientFactory } : {}), now: () => Date.now() + clock.skew });
  await until(() => bridge.leading(), 4000, "leadership");
  const ctl = new RelayClient({ url: r.url, token: r.tokens.me, name: control, roles: [CONTROL_ROLE], reconnect: false });
  const got = [];
  ctl.on("message", (m, confirm) => {
    got.push(m);
    confirm();
  });
  t.after(() => ctl.close());
  await ctl.start().ready();
  const ask = async (m, from = ctl) => (await from.send("me-owner", promptRequestText(m), 600, undefined, { toMember: ME })).message_id.toLowerCase();
  const verify = (m, me = { name: control, member: ME }) => sig.verifyEnvelope(m.text, { pin: { name: "me-owner", keys: [{ id: sig.keyIdOf(key.pub), pub: key.pub }] }, realm: REALM, sender: m.from, me });
  return { r, home, tg, key, bridge, ctl, got, ask, verify, clock };
}

test("a prompt card: the folder's name and a fixed warning, one button per option as the screen words it; a tap signs one answer to the control name with a fresh result key; the first tap wins; only a result under that key closes it", async (t) => {
  const s = await setup(t);
  const m = manifestFor();
  const q = await s.ask(m);
  await until(() => promptCards(s.tg).length === 1, 4000, "the card");
  const card = promptCards(s.tg)[0];
  assert.equal(card.params.chat_id, OWNER_CHAT);
  const at = new Date(m.expires_at).toISOString().slice(11, 16);
  assert.equal(card.params.text, `🔐 A session on your Mac reports that alice is waiting: Codex asks whether to trust the folder app (team n4).\n\nTrusting lets Codex use this repository's project config and MCP servers.\nAnswer by ${at} UTC. hoptell presses only the key you choose, and only while the prompt on the Mac is still the same.`);
  assert.deepEqual(textProblems(card.params.text), []);
  const rows = card.params.reply_markup.inline_keyboard;
  assert.deepEqual(rows.map((x) => x.map((b) => b.text)), [["Trust folder"], ["Quit"]]);
  for (const [i, b] of rows.flat().entries()) assert.match(b.callback_data, new RegExp(`^k:[a-z2-7]{12}:${i + 1}$`));
  // The control connection is not one of the owner's agents, and gets no people signal.
  assert.equal(peopleOf(s.home)[CTL], undefined);
  // Quit: one signed answer to the control name, in reply to the request.
  s.tg.press(card, 1);
  await until(() => s.got.some((x) => x.from === "me-owner"), 4000, "the answer");
  const got = s.got.find((x) => x.from === "me-owner");
  assert.equal(got.reply_to, q);
  const v = s.verify(got);
  assert.equal(v.ok, true, v.reason);
  assert.equal(v.env.kind, "prompt_answer");
  const a = parseAnswer(v.env.text);
  assert.deepEqual([a.digest, a.nonce, a.choice], [manifestDigest(m), m.nonce, "2"]);
  assert.match(a.result_key, /^[0-9a-f]{64}$/);
  // The card keeps only the key's digest.
  assert.equal(s.bridge.state().questions[q].prompt.result_key_id, resultKeyId(a.result_key));
  assert.doesNotMatch(JSON.stringify(s.bridge.state().questions[q]), new RegExp(a.result_key));
  assert.ok(Math.abs(a.issued_at - Date.now()) < 10_000);
  assert.equal(s.verify(got, { name: "me-alice", member: ME }).ok, false, "for the control name only");
  await until(() => s.tg.calls("editMessageText").some((c) => /You chose: Quit\./.test(c.params.text)), 4000, "the card closed");
  assert.match(s.tg.calls("answerCallbackQuery").at(-1).params.text, /^Sent: Quit\.$/);
  // Another tap, on either button: nothing more is sent.
  s.tg.press(card, 0);
  await until(() => s.tg.calls("answerCallbackQuery").at(-1).params.text === "This prompt was already answered.", 4000, "already answered");
  await sleep(200);
  assert.equal(s.got.filter((x) => x.from === "me-owner").length, 1);
  // The question is closed as answered.
  assert.ok(s.bridge.state().questions[q].status === "answered");
  // What the injector did comes back: the card says it, and one message under it.
  const drops = (k) => s.bridge.state().drops[k] ?? 0;
  await s.ctl.send("me-owner", resultText({ digest: "d".repeat(64), nonce: m.nonce, outcome: "done", key: a.result_key }), 600, undefined, { toMember: ME });
  await until(() => drops("prompt_result_unknown") === 1, 4000, "a result for no card");
  // A session of the member that sends under the control name without holding it (send-only: the
  // relay lets it) never got the answer, so it has no key: its "done" is not taken.
  const spoof = new RelayClient({ url: s.r.url, token: s.r.tokens.me, name: CTL, mode: "send", reconnect: false });
  t.after(() => spoof.close());
  await spoof.start().ready();
  await spoof.send("me-owner", resultText({ digest: manifestDigest(m), nonce: m.nonce, outcome: "done", key: "7".repeat(64) }), 600, undefined, { toMember: ME });
  await until(() => drops("prompt_result_unverified") === 1, 4000, "a result under another key");
  const forged = JSON.parse(resultText({ digest: manifestDigest(m), nonce: m.nonce, outcome: "unknown", why: "changed", key: a.result_key }));
  await spoof.send("me-owner", canonicalize({ ...forged, outcome: "done", why: null }), 600, undefined, { toMember: ME });
  await until(() => drops("prompt_result_unverified") === 2, 4000, "the key with a MAC for another outcome");
  assert.equal(s.bridge.state().questions[q].prompt.result, undefined, "not closed by it");
  assert.equal(s.tg.calls("sendMessage").filter((c) => /hoptell pressed it/.test(c.params.text)).length, 0);
  // The real result, from a control name drawn again since (the relay refused the kept one at a
  // reconnect): the answer's key is the proof, not the name.
  const redrawn = await agent(t, s.r.url, s.r.tokens.me, "me-credrawnab");
  await redrawn.client.send("me-owner", resultText({ digest: manifestDigest(m), nonce: m.nonce, outcome: "unknown", why: "changed", key: a.result_key }), 600, undefined, { toMember: ME });
  const view = "❓ alice · app\n\nYou chose: Quit. hoptell may have pressed part of it: the prompt on the Mac was no longer the same. Look at its terminal on the Mac.";
  await until(() => s.tg.calls("editMessageText").some((c) => c.params.text === view), 4000, "the card shows the result");
  const posted = s.tg.calls("sendMessage").filter((c) => c.params.text === view);
  assert.equal(posted.length, 1);
  const cardId = s.tg.calls("editMessageText").find((c) => c.params.text === view).params.message_id;
  assert.equal(posted[0].params.reply_parameters.message_id, cardId, "under the card");
  assert.deepEqual(textProblems(view), []);
  await s.ctl.send("me-owner", resultText({ digest: manifestDigest(m), nonce: m.nonce, outcome: "done", key: a.result_key }), 600, undefined, { toMember: ME });
  await until(() => drops("prompt_result_again") === 1, 4000, "once only");
  assert.equal(s.tg.calls("sendMessage").filter((c) => /You chose: Quit\. hoptell pressed it/.test(c.params.text)).length, 0);
  assert.equal(drops("prompt_result_not_own"), 0);
});

test("no result from the Mac: RESULT_WAIT after the answer went out the card says so, once; a late real result still replaces it, once", async (t) => {
  const s = await setup(t, { tickMs: 50 });
  const drops = (k) => s.bridge.state().drops[k] ?? 0;
  const m = manifestFor();
  await s.ask(m);
  await until(() => promptCards(s.tg).length === 1, 4000, "the card");
  const card = promptCards(s.tg)[0];
  s.tg.press(card, 0);
  await until(() => s.got.some((x) => x.from === "me-owner"), 4000, "the answer");
  const a = parseAnswer(s.verify(s.got.find((x) => x.from === "me-owner")).env.text);
  const none = "❓ alice · app\n\nYou chose: Trust folder. No result came back from the Mac. Look at its terminal on the Mac.";
  await sleep(300);
  assert.equal(s.tg.calls("sendMessage").filter((c) => c.params.text === none).length, 0, "not before RESULT_WAIT");
  s.clock.skew = RESULT_WAIT_MS + 1000;
  await until(() => s.tg.calls("sendMessage").some((c) => c.params.text === none), 4000, "the card says no result came");
  assert.ok(s.tg.calls("editMessageText").some((c) => c.params.text === none && c.params.message_id === card.message_id));
  assert.equal(s.tg.calls("sendMessage").find((c) => c.params.text === none).params.reply_parameters.message_id, card.message_id, "under the card");
  assert.deepEqual(textProblems(none), []);
  await sleep(300);
  assert.equal(s.tg.calls("sendMessage").filter((c) => c.params.text === none).length, 1, "once");
  // The real result, late: it replaces the text, once.
  await s.ctl.send("me-owner", resultText({ digest: manifestDigest(m), nonce: m.nonce, outcome: "done", key: a.result_key }), 600, undefined, { toMember: ME });
  const done = "✅ alice · app\n\nYou chose: Trust folder. hoptell pressed it on the Mac.";
  await until(() => s.tg.calls("editMessageText").some((c) => c.params.text === done), 4000, "the late result");
  assert.equal(s.tg.calls("sendMessage").filter((c) => c.params.text === done).length, 1);
  await s.ctl.send("me-owner", resultText({ digest: manifestDigest(m), nonce: m.nonce, outcome: "done", key: a.result_key }), 600, undefined, { toMember: ME });
  await until(() => drops("prompt_result_again") === 1, 4000, "once only");
  await sleep(300);
  assert.equal(s.tg.calls("sendMessage").filter((c) => c.params.text === none).length, 1, "never said again");
});

test("no result while the relay send waits: the deadline runs from the tap, not the relay's acknowledgement; the card's text and reply go out past answers still waiting for the relay", async (t) => {
  // The bridge's relay connection, with its sends to control names played: `lose` once (the relay
  // took it, its acknowledgement is lost: tried again), `block` (never taken while it is set).
  const mode = { lose: 0, block: false };
  const clientFactory = (o) => {
    const c = new RelayClient(o);
    const real = c.send.bind(c);
    c.send = async (to, ...rest) => {
      if (typeof to === "string" && to.startsWith("me-c")) {
        if (mode.block) throw new Error("socket closed");
        if (mode.lose > 0) {
          mode.lose--;
          await real(to, ...rest);
          throw new Error("socket closed");
        }
      }
      return real(to, ...rest);
    };
    return c;
  };
  const s = await setup(t, { tickMs: 50, clientFactory });
  const none = (label) => `❓ alice · app\n\nYou chose: ${label}. No result came back from the Mac. Look at its terminal on the Mac.`;
  const show = async () => {
    const before = promptCards(s.tg).length;
    const q = await s.ask(manifestFor());
    await until(() => promptCards(s.tg).length === before + 1, 4000, "the card");
    return { q, card: promptCards(s.tg).at(-1) };
  };
  const tap = async ({ q, card }, index) => {
    s.tg.press(card, index);
    await until(() => s.bridge.state().questions[q].status === "answered", 4000, "the tap taken");
    return card;
  };
  const cards = [await show(), await show()];
  // The answer reached the Mac, but its acknowledgement was lost.
  mode.lose = 1;
  const lost = await tap(cards[0], 1);
  await until(() => s.got.some((x) => x.from === "me-owner"), 4000, "the answer delivered");
  await until(() => !s.bridge.state().outbox.some((e) => e.steps.slice(e.next).some((x) => x.t === "send")), 4000, "sent again, acknowledged");
  // Another answer that the relay does not take at all, waiting in the outbox ahead of the card's
  // text (while it waits, the bridge takes no further taps: one at a time, as before).
  const answers = () => s.got.filter((x) => x.from === "me-owner").length;
  const delivered = answers(); // the lost one, and its copy sent again
  mode.block = true;
  const blocked = await tap(cards[1], 0);
  await sleep(300);
  assert.ok(s.bridge.state().outbox.some((e) => e.steps.some((x) => x.t === "send")), "relay sends waiting");
  assert.equal(s.tg.calls("sendMessage").filter((c) => /No result came back/.test(c.params.text)).length, 0, "not before RESULT_WAIT");
  s.clock.skew = RESULT_WAIT_MS + 1000;
  for (const [card, label] of [[lost, "Quit"], [blocked, "Trust folder"]]) {
    await until(() => s.tg.calls("sendMessage").some((c) => c.params.text === none(label) && c.params.reply_parameters?.message_id === card.message_id), 4000, `the "no result" reply under ${label}`);
    assert.ok(s.tg.calls("editMessageText").some((c) => c.params.message_id === card.message_id && c.params.text === none(label)), "the card edited");
  }
  assert.equal(answers(), delivered, "the blocked answer never left");
  assert.ok(s.bridge.state().outbox.some((e) => e.steps.some((x) => x.t === "send")), "and still wait");
  // Once the relay takes them, a later acknowledgement does not move the deadline: said once.
  mode.block = false;
  await until(() => answers() === delivered + 1, 6000, "the waiting answer sent");
  await sleep(300);
  for (const label of ["Quit", "Trust folder"]) assert.equal(s.tg.calls("sendMessage").filter((c) => c.params.text === none(label)).length, 1, label);
});

test("prompt requests the bridge refuses: malformed, not from the control name it names, another member's, again, late, a hidden session's; a tap after the deadline sends nothing", async (t) => {
  const s = await setup(t);
  const drops = (k) => s.bridge.state().drops[k] ?? 0;
  // Malformed (an option the prompt table does not have for that version).
  const bad = { ...manifestFor(), options: [{ key: "1", action: "trust", label: "Always trust everything" }, { key: "2", action: "quit", label: "Quit" }] };
  await s.ctl.send("me-owner", canonicalize({ hoptell_prompt: 1, manifest: bad }), 600, undefined, { toMember: ME });
  await until(() => drops("prompt_malformed") === 1, 4000, "malformed");
  // From another session of the member than the control name the manifest names.
  const other = await agent(t, s.r.url, s.r.tokens.me, "me-mallory");
  await s.ask(manifestFor(), other.client);
  await until(() => drops("prompt_not_own") === 1, 4000, "not from the control name");
  await s.ask(manifestFor({ recipient: { member: "m_bbbbbbbbbbbbbbbbbbbbbbbbbb", control: CTL } }));
  await until(() => drops("prompt_not_own") === 2, 4000, "another member");
  // Once per manifest.
  const m = manifestFor();
  await s.ask(m);
  await s.ask(m);
  await until(() => drops("prompt_again") === 1, 4000, "again");
  // Late.
  await s.ask(manifestFor({ created_at: Date.now() - CARD_MS - 1000, expires_at: Date.now() - 1000 }));
  await until(() => drops("prompt_late") === 1, 4000, "late");
  // Dated more than a minute ahead of the bridge's clock: not shown.
  const ahead = Date.now() + 7 * 86400_000;
  await s.ask(manifestFor({ created_at: ahead, expires_at: ahead + CARD_MS }));
  await until(() => drops("prompt_future") === 1, 4000, "dated ahead");
  await sleep(200);
  const skewed = Date.now() + 30_000;
  await s.ask(manifestFor({ created_at: skewed, expires_at: skewed + CARD_MS }));
  await until(() => drops("prompt_future") === 2 || promptCards(s.tg).length === 2, 4000, "a small skew");
  assert.equal(drops("prompt_future"), 1, "30 seconds ahead is taken");
  // A session the owner hid: not shown.
  await setPeople(s.home, ["me-carol"], { hidden: true });
  await s.ask(manifestFor({ session: "me-carol" }));
  await until(() => drops("prompt_hidden") === 1, 4000, "hidden");
  assert.equal(promptCards(s.tg).length, 2, "only the good ones");
  // A launch under the test switch: its card says so.
  await s.ask(manifestFor({ untested: true }));
  await until(() => promptCards(s.tg).length === 3, 4000, "the test mode card");
  assert.match(promptCards(s.tg)[2].params.text, /\nTest mode: these keys are not yet checked live\.\n/);
  assert.doesNotMatch(promptCards(s.tg)[0].params.text, /Test mode/);
  // The deadline passes before the tap: the card closes, nothing is sent.
  const card = promptCards(s.tg)[0];
  s.clock.skew = CARD_MS + 1000;
  s.tg.press(card, 0);
  await until(() => s.tg.calls("answerCallbackQuery").some((c) => c.params.text === "This prompt card has expired; nothing was pressed."), 4000, "expired at the tap");
  await sleep(200);
  assert.equal(s.got.filter((x) => x.from === "me-owner").length, 0);
  assert.equal(s.tg.calls("sendMessage").filter((c) => /Always trust/.test(c.params.text)).length, 0);
});

test("the control connection: a receiving peer under its kept name that never replaces a holder; it draws again; what arrives for it reaches onMessage; the bridge does not list it", async (t) => {
  const r = await ownerRelay(t);
  const home = tmpHome(t);
  const clients = [];
  const client = (o) => {
    const c = new RelayClient({ url: r.url, token: r.tokens.me, require2: true, ...o });
    clients.push(c);
    return c;
  };
  t.after(() => clients.forEach((c) => c.close()));
  // The kept name is held by another session now: drawn again, the holder stays.
  fs.mkdirSync(`${home}/sessions`, { recursive: true });
  fs.writeFileSync(controlFileOf(home, "me-alice"), JSON.stringify({ v: 1, member: "me", name: "me-cheldheldhe" }));
  const holder = await agent(t, r.url, r.tokens.me, "me-cheldheldhe");
  const got = [];
  const logs = [];
  const control = createControl({ home, name: "me-alice", client, policy: () => ({ legacy: true }), onMessage: (m, confirm, me) => (got.push([m.text, me.name]), confirm()), log: (l) => logs.push(l) });
  const me = await control.whoami();
  assert.match(me.name, /^me-c[a-z2-7]{10}$/);
  assert.notEqual(me.name, "me-cheldheldhe");
  assert.equal(me.member.id, ME);
  assert.ok(holder.client.connected, "never replaced");
  assert.match(logs.join("\n"), /the control name me-cheldheldhe was not given/);
  // It holds its name: a second session asking for it without replacing is refused.
  const second = new RelayClient({ url: r.url, token: r.tokens.me, name: me.name, reconnect: false });
  t.after(() => second.close());
  await assert.rejects(() => second.start().ready(), /in use/);
  // It receives.
  await holder.client.send(me.name, "hello control", 60, undefined, { toMember: ME });
  await until(() => got.length === 1, 4000, "received");
  assert.deepEqual(got[0], ["hello control", me.name]);
  // Listed with its role: the bridge leaves it out of the owner's agents.
  const list = await holder.client.list();
  assert.deepEqual(list.find((p) => p.name === me.name)?.roles, [CONTROL_ROLE]);
  // Peer lists (list_peers, hoptell peers) leave it out, and @all or @<role> never reaches it.
  assert.equal(formatPeers(list).some((r) => r.includes(me.name)), false);
  await holder.client.send("@all", "to everyone", 60).catch(() => {});
  await assert.rejects(() => holder.client.send(`@${CONTROL_ROLE}`, "to the plumbing", 60), /no online peer has the role/);
  await sleep(200);
  assert.deepEqual(got.map((g) => g[0]), ["hello control"], "no fan-out copy");
  const bhome = tmpHome(t);
  paired(bhome);
  const tg = fakeTelegram();
  const { bridge } = bridgeOn(t, { home: bhome, telegram: tg.client(), url: r.url, token: r.tokens.me, key: newKey() });
  await until(() => bridge.leading(), 4000, "leadership");
  tg.say("/agents");
  await until(() => tg.last(/^Your agents: /), 4000, "the agents list");
  assert.equal(tg.last(/^Your agents: /).params.text, "Your agents: 0 favourites, 1 online.", "the holder only, not the control connection");
  control.close();
});

/** The injector's side of a card, with a stand-in control connection and gate. */
function publisherWorld(t, { armed = true, root = "/Users/x/app", untested = true, note = async () => true, whoami = async () => {} } = {}) {
  const home = tmpHome(t);
  const sent = [];
  let on = armed;
  const control = {
    whoami: async () => (await whoami({ off: () => (on = false) }), { name: CTL, member: { id: ME, name: "me" }, realm: { id: REALM } }),
    note: async (text) => (sent.push(text), note(text, home)),
  };
  let at = 1_800_000_000_000;
  const launch = { id: "2".repeat(32), cli: { name: "codex", path: "/opt/homebrew/bin/codex", version: "0.165.0" }, folder: root, root, tmux: { socket: "/private/tmp/tmux-501/default", session: "$3", pane: "%7" }, host: { pid: 4242, start: "s", uid: 501, boot: "b1" }, untested, started: at };
  const gate = { launch, armed: () => on, off: () => (on = false) };
  const clock = { now: () => at, add: (ms) => (at += ms) };
  const logs = [];
  const inner = cardPublisher(home, "me-alice", { control, gate, team: "n4", now: clock.now, log: (l) => logs.push(l) });
  const pub = { publish: (r, p, capturedAt = clock.now() - 1000) => inner.publish(r, p, capturedAt) }; // read a second before
  return { home, sent, pub, clock, logs, gate };
}
const occ = { kind: "prompt", subtype: "codex-startup-trust", actionable: true };
const classified = (folder = "/Users/x/app") => ({ subtype: "codex-startup-trust", actionable: true, options: answerableOptions("0.165.0")[0].map((o) => ({ ...o })), selected: 1, dialog: "c".repeat(64), folders: [folder] });

test("the publisher: a card only while armed, for the launch's folder; the manifest kept before it is asked for; one open card per launch; a card not sent is not kept", async (t) => {
  const w = publisherWorld(t);
  assert.equal(await w.pub.publish(occ, classified()), true);
  assert.equal(w.sent.length, 1);
  const req = parsePromptRequest(w.sent[0]);
  const rec = readPromptRecord(w.home, "me-alice");
  assert.deepEqual([rec.state, rec.digest, rec.manifest], ["published", req.digest, req.manifest]);
  assert.deepEqual([req.manifest.recipient, req.manifest.session, req.manifest.team, req.manifest.scope.root, req.manifest.expires_at - req.manifest.created_at], [{ member: ME, control: CTL }, "me-alice", "n4", "/Users/x/app", CARD_MS]);
  // The launch's process and pane, and the options with their key sequences, as the table has them.
  assert.deepEqual([req.manifest.host, req.manifest.tmux], [w.gate.launch.host, w.gate.launch.tmux]);
  assert.deepEqual(req.manifest.options, answerableOptions("0.165.0")[0].map((o) => JSON.parse(JSON.stringify(o))));
  // When the dialog was read, and the launch's test switch.
  assert.deepEqual([req.manifest.captured_at, req.manifest.untested], [req.manifest.created_at - 1000, true]);
  assert.equal(fs.statSync(promptFileOf(w.home, "me-alice")).mode & 0o777, 0o600);
  // The same prompt again (a resize, a repaint) while the card is open: no other card.
  w.clock.add(60_000);
  assert.equal(await w.pub.publish(occ, classified()), true);
  assert.equal(w.sent.length, 1);
  // After the card's deadline: a new card, a new nonce.
  w.clock.add(CARD_MS);
  assert.equal(await w.pub.publish(occ, classified()), true);
  assert.equal(w.sent.length, 2);
  const second = parsePromptRequest(w.sent[1]).manifest;
  assert.notEqual(second.nonce, req.manifest.nonce);
  // Never open past the gate's outer cap (START_MS + CARD_MS after the launch).
  assert.equal(second.expires_at, w.gate.launch.started + START_MS + CARD_MS);
  // Another folder on the screen than the launch's, a display-only prompt, or the gate off: no card.
  const x = publisherWorld(t);
  assert.equal(await x.pub.publish(occ, classified("/Users/x/other")), false);
  assert.match(x.logs.join("\n"), /not the one the launch recorded/);
  assert.equal(await x.pub.publish({ ...occ, actionable: false }, classified()), false);
  assert.equal(await publisherWorld(t, { armed: false }).pub.publish(occ, classified()), false);
  assert.equal(await x.pub.publish(occ, { ...classified(), selected: null }), false, "no single selected row");
  assert.equal(await x.pub.publish(occ, classified(), null), false, "no time of the read");
  assert.equal(await x.pub.publish(occ, classified(), x.clock.now() - CARD_MS - 1), false, "a read too old for a card");
  assert.equal(x.sent.length, 0);
  // The table's options are checked live: a card without the test switch.
  const normal = publisherWorld(t, { untested: false });
  assert.equal(await normal.pub.publish(occ, classified()), true);
  assert.equal(parsePromptRequest(normal.sent[0]).manifest.untested, false);
  // No option checked live (another version's row, played) and no test switch: no card, the prompt is told as a note.
  const live = publisherWorld(t, { untested: false });
  assert.equal(await live.pub.publish(occ, { ...classified(), options: classified().options.map((o) => ({ ...o, live: false })) }), false);
  assert.match(live.logs.join("\n"), /no option of this prompt was checked live yet/);
  assert.deepEqual([live.sent.length, fs.existsSync(promptFileOf(live.home, "me-alice"))], [0, false]);
  // Not sent: its record goes, so no answer can ever match it.
  const y = publisherWorld(t, { note: async () => false });
  assert.equal(await y.pub.publish(occ, classified()), false);
  assert.equal(fs.existsSync(promptFileOf(y.home, "me-alice")), false);
  // ... but only its own: a record written meanwhile by another publish stays.
  const other = { ...parsePromptRequest(w.sent[0]).manifest, nonce: "f".repeat(32) };
  const z = publisherWorld(t, { note: async (text, home) => (writePromptRecord(home, "me-alice", { digest: manifestDigest(other), manifest: other, state: "published" }), false) });
  assert.equal(await z.pub.publish(occ, classified()), false);
  assert.equal(readPromptRecord(z.home, "me-alice").manifest.nonce, "f".repeat(32));
});

test("the publisher: the gate closing while the connection is made means no card; two publishes at once make one card", async (t) => {
  const w = publisherWorld(t, { whoami: async ({ off }) => off() });
  assert.equal(await w.pub.publish(occ, classified()), false);
  assert.deepEqual([w.sent.length, fs.existsSync(promptFileOf(w.home, "me-alice"))], [0, false]);
  let release;
  const slow = publisherWorld(t, { whoami: () => new Promise((r) => (release = r)) });
  const a = slow.pub.publish(occ, classified());
  const b = slow.pub.publish(occ, classified());
  release();
  assert.deepEqual(await Promise.all([a, b]), [true, true]);
  assert.equal(slow.sent.length, 1, "one card");
  // Once that one has settled, the next publish finds its card open.
  assert.equal(await slow.pub.publish(occ, classified()), true);
  assert.equal(slow.sent.length, 1);  // An answer was taken for this launch (any state but published): it stands, no other card,
  // even after the card's deadline; the prompt is told as a note.
  for (const state of ["attempting", "done", "refused", "unknown"]) {
    const r = readPromptRecord(slow.home, "me-alice");
    writePromptRecord(slow.home, "me-alice", { digest: r.digest, manifest: r.manifest, state });
    assert.equal(await slow.pub.publish(occ, classified()), false, state);
    slow.clock.add(CARD_MS + 1);
    assert.equal(await slow.pub.publish(occ, classified()), false, state);
  }
  assert.equal(slow.sent.length, 1);
});

test("the surfaces with cards: a card instead of the owner's note; the note when no card can be made", async (t) => {
  const home = tmpHome(t);
  const notes = [];
  const control = { tell: async () => true, note: async (text) => (notes.push(text), true) };
  const published = [];
  let card = true;
  const cards = { publish: async (rec, prompt) => (published.push([rec.id, prompt.dialog]), card) };
  const s = waitSurface(home, "me-alice", { control, cards, now: () => 1_800_000_000_000 });
  const rec = { id: "P1", nonce: "a".repeat(32), kind: "prompt", subtype: "codex-startup-trust", actionable: true, since: new Date(1_800_000_000_000).toISOString() };
  s.start(rec, { prompt: classified() });
  await until(() => published.length === 1, 2000, "published");
  await sleep(50);
  assert.equal(notes.length, 0, "the card instead of the note");
  card = false;
  s.start({ ...rec, id: "P2", nonce: "b".repeat(32), subtype: "codex-startup-trust" }, { prompt: classified() });
  await until(() => notes.length === 1, 2000, "the note");
  // A prompt without a classification (a stall): the note.
  s.start({ ...rec, id: "P3", nonce: "c".repeat(32), kind: "stall", subtype: "busy" }, null);
  await sleep(50);
  assert.equal(published.length, 2);
});
