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
import { CARD_MS, START_MS, answerableOptions, manifestDigest, manifestProblem, parseAnswer, parsePromptRequest, promptRequestText, resultKeyId, resultText } from "../lib/promptcards.js";
import { cardPublisher, promptFileOf, readPromptRecord, writePromptRecord } from "../lib/promptflow.js";
import { RESULT_WAIT_MS } from "../lib/ownerchannel.js";
import { waitSurface } from "../lib/tmux.js";
import { openOccurrence } from "../lib/waits.js";
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

test("Claude Code and agy cards: the CLI named, the folder the dialog shows, and what the trust covers for its kind; both buttons, with or without the test switch", async (t) => {
  const s = await setup(t);
  const at = (m) => new Date(m.expires_at).toISOString().slice(11, 16);
  const deadline = (m) => `Answer by ${at(m)} UTC. hoptell presses only the key you choose, and only while the prompt on the Mac is still the same.`;
  const cases = [
    [{ name: "claude", version: "2.1.314", kind: "folder", folder: "/Users/x/app", root: "/Users/x/app" }, "Claude Code asks whether to trust the folder app", "Trusting lets Claude Code use this folder's project settings, hooks and MCP servers. Claude Code records the trust for this folder: app."],
    [{ name: "claude", version: "2.1.314", kind: "repo", folder: "/Users/x/app", root: "/Users/x/app" }, "Claude Code asks whether to trust the folder app", "Trusting lets Claude Code use this repository's project settings, hooks and MCP servers. Claude Code records the trust for the repository: app."],
    [{ name: "claude", version: "2.1.314", kind: "repo-member", folder: "/Users/x/app-wt/impl-1", root: "/Users/x/app" }, "Claude Code asks whether to trust the folder impl-1", "Trusting lets Claude Code use this repository's project settings, hooks and MCP servers. Claude Code records the trust for the repository's main folder, app, which then covers its worktrees and subfolders."],
    [{ name: "agy", version: "1.4.11", kind: "folder", folder: "/Users/x/app", root: "/Users/x/app" }, "agy asks whether to trust the folder app", "Trusting lets agy load this folder's project hooks, agents and MCP servers. agy's global MCP servers already run. agy records the trust for this folder: app."],
    // A version the row was not recorded on: the card says which one it was.
    [{ name: "agy", version: "1.4.12", kind: "folder", folder: "/Users/x/app", root: "/Users/x/app" }, "agy asks whether to trust the folder app", "Trusting lets agy load this folder's project hooks, agents and MCP servers. agy's global MCP servers already run. agy records the trust for this folder: app.\nagy 1.4.12: hoptell checked this dialog on 1.4.11; the screen matches it exactly."],
    [{ name: "claude", version: "2.1.320", kind: "folder", folder: "/Users/x/app", root: "/Users/x/app" }, "Claude Code asks whether to trust the folder app", "Trusting lets Claude Code use this folder's project settings, hooks and MCP servers. Claude Code records the trust for this folder: app.\nClaude Code 2.1.320: hoptell checked this dialog on 2.1.314; the screen matches it exactly."],
  ];
  for (const [i, [c, head, warning]] of cases.entries()) {
    for (const untested of [false, true]) {
      const m = manifestFor({ session: `me-a${i}${untested ? "u" : ""}`, scope: { root: c.root, folder: c.folder, kind: c.kind }, cli: { name: c.name, path: `/x/${c.name}`, version: c.version }, subtype: `${c.name}-startup-trust`, options: answerableOptions(c.version, c.name)[0].map((o) => ({ ...o })), untested });
      assert.equal(manifestProblem(m), null);
      const n = promptCards(s.tg).length;
      await s.ask(m);
      await until(() => promptCards(s.tg).length === n + 1, 4000, "the card");
      const card = promptCards(s.tg).at(-1);
      const who = m.session.slice(3);
      assert.equal(card.params.text, `🔐 A session on your Mac reports that ${who} is waiting: ${head} (team n4).\n\n${warning}\n${deadline(m)}`, "every option checked live: no test-mode line, switch or not");
      assert.deepEqual(textProblems(card.params.text), []);
      const labels = card.params.reply_markup.inline_keyboard.map((x) => x[0].text);
      assert.deepEqual(labels, m.options.map((o) => o.label), c.name);
      // Answered, so the next card is not over the open cards a session may have.
      const answers = s.got.filter((x) => x.from === "me-owner").length;
      s.tg.press(card, 0);
      await until(() => s.got.filter((x) => x.from === "me-owner").length === answers + 1, 4000, "the answer");
    }
  }
  // agy's trust covers the folder only; the home folder is never a card.
  assert.equal(manifestProblem(manifestFor({ scope: { root: "/a", folder: "/a", kind: "repo" }, cli: { name: "agy", path: "/x/agy", version: "1.4.11" }, subtype: "agy-startup-trust", options: answerableOptions("1.4.11", "agy")[0].map((o) => ({ ...o })) })), "scope");
  assert.equal(manifestProblem(manifestFor({ scope: { root: "/a", folder: "/a", kind: "home" }, cli: { name: "claude", path: "/x/claude", version: "2.1.314" }, subtype: "claude-startup-trust", options: answerableOptions("2.1.314", "claude")[0].map((o) => ({ ...o })) })), "scope");
  assert.equal(manifestProblem(manifestFor({ scope: { root: "/a", folder: "/a" }, cli: { name: "claude", path: "/x/claude", version: "2.1.314" }, subtype: "claude-startup-trust", options: answerableOptions("2.1.314", "claude")[0].map((o) => ({ ...o })) })), "scope", "a kind for Claude Code");
  assert.equal(manifestProblem(manifestFor({ scope: { root: "/a", folder: "/a", kind: "folder" }, cli: { name: "claude", path: "/x/claude", version: "2.1.314" }, subtype: "codex-startup-trust", options: answerableOptions("2.1.314", "claude")[0].map((o) => ({ ...o })) })), "subtype");
  // A version the table was not recorded on: its options are the row's; no version that could be verified: none.
  assert.equal(manifestProblem(manifestFor({ scope: { root: "/a", folder: "/a", kind: "folder" }, cli: { name: "claude", path: "/x/claude", version: "2.1.312" }, subtype: "claude-startup-trust", options: answerableOptions("2.1.314", "claude")[0].map((o) => ({ ...o })) })), null, "a version the table was not recorded on");
  assert.equal(manifestProblem(manifestFor({ scope: { root: "/a", folder: "/a", kind: "folder" }, cli: { name: "claude", path: "/x/claude", version: "2.1" }, subtype: "claude-startup-trust", options: answerableOptions("2.1.314", "claude")[0].map((o) => ({ ...o })) })), "options", "not a version");
  assert.deepEqual(answerableOptions("2.1", "claude"), []);
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
  // One clock reading: two could differ by a millisecond and stretch the card past CARD_MS.
  const past = Date.now();
  await s.ask(manifestFor({ created_at: past - CARD_MS - 1000, expires_at: past - 1000 }));
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
  // A launch under the test switch: its card says so only for an option not checked live, and
  // every option in the table is checked live now.
  await s.ask(manifestFor({ untested: true }));
  await until(() => promptCards(s.tg).length === 3, 4000, "the test mode card");
  assert.doesNotMatch(promptCards(s.tg)[2].params.text, /Test mode/);
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

test("a card over the bridge's limits: no card, the owner gets the waiting note instead (it was dropped silently)", async (t) => {
  const s = await setup(t);
  const drops = (k) => s.bridge.state().drops[k] ?? 0;
  for (const who of ["me-a1", "me-a2", "me-a3"]) await s.ask(manifestFor({ session: who }));
  await until(() => promptCards(s.tg).length === 3, 4000, "three open cards");
  await s.ask(manifestFor({ session: "me-alice" }));
  await until(() => drops("prompt_rate") === 1, 4000, "over the limit");
  const notes = () => s.tg.calls("sendMessage").filter((c) => /^⏳ /.test(c.params.text));
  await until(() => notes().length === 1, 4000, "the note");
  assert.match(notes()[0].params.text, / alice is waiting for you: Codex folder trust \(team n4\), in app\./);
  assert.equal(promptCards(s.tg).length, 3, "no fourth card");
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
  await until(() => typeof release === "function", 2000, "the first publish waits");
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

/** An injector's side on a real test relay: its control connection, a stand-in gate, the publisher and the surface. */
function injectorOn(t, r, key, session, { armed = true } = {}) {
  const home = tmpHome(t);
  sig.trustPin(home, sig.formatPin({ realm: REALM, name: "me-owner", pub: key.pub }));
  const clients = [];
  const client = (o) => {
    const c = new RelayClient({ url: r.url, token: r.tokens.me, require2: true, ...o });
    clients.push(c);
    return c;
  };
  const logs = [];
  let surface = null;
  // As the injector does: a connection back (a reconnect too) sends what is owed at once.
  const control = createControl({ home, name: session, client, policy: () => ({ legacy: true }), onReady: () => surface?.retry(), log: (l) => logs.push(l) });
  t.after(() => (control.close(), clients.forEach((c) => c.close())));
  let on = armed;
  const root = "/Users/x/app";
  const launch = { id: "3".repeat(32), cli: { name: "codex", path: "/opt/homebrew/bin/codex", version: "0.165.0" }, folder: root, root, tmux: { socket: "/private/tmp/tmux-501/default", session: "$3", pane: "%7" }, host: { pid: 4242, start: "s", uid: 501, boot: "b1" }, untested: true, started: Date.now() };
  const gate = { launch, armed: () => on, off: () => (on = false) };
  const cards = cardPublisher(home, session, { control, gate, team: "n4", log: (l) => logs.push(l) });
  surface = waitSurface(home, session, { control, cards, folder: "app", retryMs: 100 });
  const rec = openOccurrence(home, session, { kind: "prompt", subtype: "codex-startup-trust", actionable: true, since: Date.now() - 1000 }, { owner: { tmux: "$3", pane: "%7", injector: { pid: 4242, start: "s", uid: 501, boot: "b1" } } });
  return { session, home, clients, control, gate, surface, rec, started: { prompt: classified(), since: Date.now() - 1000 }, logs };
}

test("a relay outage: the card the relay could not take is published once it is back, while the gate still holds; a dialog that ended or a gate that closed meanwhile gets no card", async (t) => {
  const r = await ownerRelay(t);
  const bhome = tmpHome(t);
  paired(bhome);
  const tg = fakeTelegram();
  const key = newKey();
  const { bridge } = bridgeOn(t, { home: bhome, telegram: tg.client(), url: r.url, token: r.tokens.me, key });
  await until(() => bridge.leading(), 4000, "leadership");
  const alice = injectorOn(t, r, key, "me-alice");
  const bob = injectorOn(t, r, key, "me-bob");
  const carol = injectorOn(t, r, key, "me-carol");
  // Alice's control connection is made before the outage (it reconnects by itself); the others'
  // first connect comes during it.
  await alice.control.whoami();
  await r.stop();
  // Once it has seen the drop (a send on a connection that is going down waits for its answer first).
  await until(() => alice.clients.every((c) => !c.connected), 4000, "alice's connection down");
  // During the outage: nothing reaches the bridge. Alice's card was made and its request not
  // taken, so its record is kept (the same request goes again); bob's and carol's first connect
  // failed, so no card was made.
  for (const s of [alice, bob, carol]) await s.surface.start(s.rec, s.started);
  const first = readPromptRecord(alice.home, "me-alice");
  assert.deepEqual([first?.state, first?.answer], ["published", null]);
  for (const s of [bob, carol]) assert.equal(fs.existsSync(promptFileOf(s.home, s.session)), false, s.session);
  for (const s of [alice, bob, carol]) assert.equal(s.control.offline(), true, s.session);
  assert.match(alice.logs.join("\n"), /owner notes about this session are not sent: not connected to the relay \(reconnecting\)/);
  assert.match(bob.logs.join("\n"), /owner notes about this session are not sent: cannot reach relay/);
  // Retries while it is down change nothing.
  await sleep(150);
  await Promise.all([alice, bob, carol].map((s) => s.surface.tick()));
  // Meanwhile bob's dialog ended (the occurrence's end), and carol's gate closed (her screen changed).
  bob.surface.end(bob.rec);
  carol.gate.off();
  await r.start();
  // Tried again from now on: the relay knows the bridge's name only once the bridge is back too
  // (a relay keeps no names over a restart), which may be after these sessions.
  await until(async () => (await Promise.all([alice, bob, carol].map((s) => s.surface.tick())), promptCards(tg).length === 1 && tg.last(/^⏳ .* carol /)), 15_000, "the card and carol's note after the outage");
  const card = promptCards(tg)[0];
  assert.match(card.params.text, /alice is waiting: Codex asks whether to trust the folder app/);
  const kept = readPromptRecord(alice.home, "me-alice");
  assert.equal(kept.state, "published");
  assert.equal(kept.digest, first.digest, "the same request, not a new card");
  // Its time limits are those of a card made now from the read the occurrence started with.
  assert.equal(kept.manifest.captured_at, alice.started.since);
  assert.ok(kept.manifest.expires_at <= alice.gate.launch.started + START_MS + CARD_MS);
  // Carol's gate said no: the plain note, never a card. Bob's dialog is gone: nothing at all.
  await sleep(500);
  await Promise.all([alice, bob, carol].map((s) => s.surface.tick()));
  await sleep(300);
  assert.equal(promptCards(tg).length, 1, "one card, alice's");
  assert.equal(readPromptRecord(carol.home, "me-carol"), null);
  assert.equal(tg.calls("sendMessage").filter((c) => /bob/.test(c.params.text)).length, 0);
  assert.equal(tg.calls("sendMessage").filter((c) => /^⏳ .* alice /.test(c.params.text)).length, 0, "the card instead of alice's note");
  assert.equal(alice.control.offline(), false);
});

test("a relay outage: a card asked for again when the read is older than a card's life is not made; the note goes", async (t) => {
  const home = tmpHome(t);
  let at = 1_800_000_000_000;
  const now = () => at;
  let reach = false;
  const notes = [];
  const control = {
    whoami: async () => (reach ? { name: CTL, member: { id: ME, name: "me" }, realm: { id: REALM } } : null),
    offline: () => !reach,
    note: async (text) => (reach ? (notes.push(text), true) : null),
    tell: async () => true,
  };
  const launch = { id: "2".repeat(32), cli: { name: "codex", path: "/opt/homebrew/bin/codex", version: "0.165.0" }, folder: "/Users/x/app", root: "/Users/x/app", tmux: { socket: "/private/tmp/tmux-501/default", session: "$3", pane: "%7" }, host: { pid: 4242, start: "s", uid: 501, boot: "b1" }, untested: true, started: at };
  // A gate that stays armed (a stand-in): only the card's own time rule decides here.
  const cards = cardPublisher(home, "me-alice", { control, gate: { launch, armed: () => true }, now });
  const s = waitSurface(home, "me-alice", { control, cards, now, retryMs: 1000 });
  const rec = { id: "P1", nonce: "a".repeat(32), kind: "prompt", subtype: "codex-startup-trust", actionable: true, since: new Date(at).toISOString() };
  await s.start(rec, { prompt: classified(), since: at - 1000 });
  assert.equal(notes.length, 0);
  // Before it is due: not tried again.
  at += 500;
  await s.tick();
  at += CARD_MS;
  reach = true;
  await s.tick();
  assert.equal(notes.length, 1);
  assert.equal(JSON.parse(notes[0]).hoptell_wait, 1, "the note, not a card");
  assert.equal(readPromptRecord(home, "me-alice"), null);
  // Sent: nothing is owed any more.
  at += 5000;
  await s.tick();
  await s.retry();
  assert.equal(notes.length, 1);
});

test("an uncertain send: a request the bridge took but whose answer was lost is sent again as the same request, and the owner sees one card; an answer taken meanwhile is never removed", async (t) => {
  const s = await setup(t);
  const sent = [];
  let lose = true;
  // The relay takes the request, and its answer is lost on the way back (null: it may not have arrived).
  const control = {
    whoami: async () => ({ name: CTL, member: { id: ME, name: "me" }, realm: { id: REALM } }),
    note: async (text) => {
      sent.push(text);
      await s.ctl.send("me-owner", text, 600, undefined, { toMember: ME });
      return lose ? null : true;
    },
  };
  const root = "/Users/x/app";
  const launch = { id: "4".repeat(32), cli: { name: "codex", path: "/opt/homebrew/bin/codex", version: "0.165.0" }, folder: root, root, tmux: { socket: "/private/tmp/tmux-501/default", session: "$3", pane: "%7" }, host: { pid: 4242, start: "s", uid: 501, boot: "b1" }, untested: true, started: Date.now() };
  const home = tmpHome(t);
  const pub = cardPublisher(home, "me-alice", { control, gate: { launch, armed: () => true }, team: "n4" });
  assert.equal(await pub.publish(occ, classified(), Date.now() - 1000), null);
  await until(() => promptCards(s.tg).length === 1, 4000, "the first request's card");
  lose = false;
  assert.equal(await pub.publish(occ, classified(), Date.now() - 1000), true);
  assert.equal(sent.length, 2);
  assert.equal(sent[1], sent[0], "the same request: same digest and nonce");
  await sleep(300);
  assert.equal(promptCards(s.tg).length, 1, "shown once");
  // Open now: asked again, nothing more is sent.
  assert.equal(await pub.publish(occ, classified(), Date.now() - 1000), true);
  assert.equal(sent.length, 2);

  // The owner's answer is taken while the send still waits for the relay's answer, which is then lost.
  const other = tmpHome(t);
  const answered = {
    whoami: control.whoami,
    note: async () => {
      const r = readPromptRecord(other, "me-bob");
      writePromptRecord(other, "me-bob", { digest: r.digest, manifest: r.manifest, state: "attempting", answer: { choice: "1", result_key: "e".repeat(64) } });
      return null;
    },
  };
  const bob = cardPublisher(other, "me-bob", { control: answered, gate: { launch, armed: () => true }, team: "n4" });
  assert.equal(await bob.publish(occ, classified(), Date.now() - 1000), null);
  assert.equal(readPromptRecord(other, "me-bob").state, "attempting", "the answer stands");
  // Asked again: the answer proves the card arrived; nothing is sent, nothing removed.
  assert.equal(await bob.publish(occ, classified(), Date.now() - 1000), true);
  assert.equal(readPromptRecord(other, "me-bob").state, "attempting");
  // A refusal after an answer was taken does not remove it either.
  const third = tmpHome(t);
  const refused = { whoami: control.whoami, note: async () => (writePromptRecord(third, "me-carol", { ...readPromptRecord(third, "me-carol"), state: "done", answer: { choice: "1", result_key: "e".repeat(64) } }), false) };
  assert.equal(await cardPublisher(third, "me-carol", { control: refused, gate: { launch, armed: () => true } }).publish(occ, classified(), Date.now() - 1000), false);
  assert.equal(readPromptRecord(third, "me-carol").state, "done");
});

test("a prompt that ends while its card waits for the connection: nothing is sent for it, no note either; a newer occurrence gets the card", async (t) => {
  const home = tmpHome(t);
  let release;
  let connected = new Promise((r) => (release = r));
  const requests = [];
  const notes = [];
  const control = {
    whoami: async () => (await connected, { name: CTL, member: { id: ME, name: "me" }, realm: { id: REALM } }),
    offline: () => false,
    note: async (text, { live = () => true } = {}) => {
      await connected;
      if (!live()) return false;
      (parsePromptRequest(text) ? requests : notes).push(text);
      return true;
    },
    tell: async () => true,
  };
  const root = "/Users/x/app";
  const launch = { id: "5".repeat(32), cli: { name: "codex", path: "/opt/homebrew/bin/codex", version: "0.165.0" }, folder: root, root, tmux: { socket: "/private/tmp/tmux-501/default", session: "$3", pane: "%7" }, host: { pid: 4242, start: "s", uid: 501, boot: "b1" }, untested: true, started: Date.now() };
  const cards = cardPublisher(home, "me-alice", { control, gate: { launch, armed: () => true } });
  const s = waitSurface(home, "me-alice", { control, cards, retryMs: 10 });
  const one = { id: "P1", nonce: "a".repeat(32), kind: "prompt", subtype: "codex-startup-trust", actionable: true, since: new Date().toISOString() };
  const started = { prompt: classified(), since: Date.now() - 1000 };
  const p = s.start(one, started);
  s.end(one);
  release();
  await p;
  await s.tick();
  assert.deepEqual([requests.length, notes.length, fs.existsSync(promptFileOf(home, "me-alice"))], [0, 0, false]);
  assert.equal(fs.existsSync(`${home}/v2/waits/budget.json`), false, "nothing charged to the budget");
  // Replaced by a newer occurrence while the first waits: only the newer one is told.
  connected = new Promise((r) => (release = r));
  const two = { ...one, id: "P2", nonce: "b".repeat(32) };
  const three = { ...one, id: "P3", nonce: "c".repeat(32) };
  const a = s.start(two, started);
  const b = s.start(three, started);
  release();
  await Promise.all([a, b]);
  assert.equal(requests.length, 1);
  assert.equal(notes.length, 0);
  assert.equal(readPromptRecord(home, "me-alice").state, "published");
});

test("an uncertain card asked for again just before it expires: sent only if it has not expired once the connection is ready; otherwise the note goes", async (t) => {
  const world = (t) => {
    const home = tmpHome(t);
    let at = 1_800_000_000_000;
    const clock = { now: () => at, add: (ms) => (at += ms) };
    let wait = null; // a connection wait for the next request
    let lose = true;
    const requests = [];
    const notes = [];
    const control = {
      whoami: async () => ({ name: CTL, member: { id: ME, name: "me" }, realm: { id: REALM } }),
      offline: () => false,
      note: async (text, { live = () => true } = {}) => {
        const request = parsePromptRequest(text);
        if (request && wait) await wait.promise;
        if (!live()) return false;
        if (!request) return (notes.push(text), true);
        requests.push(text);
        return lose ? null : true;
      },
    };
    const root = "/Users/x/app";
    const launch = { id: "6".repeat(32), cli: { name: "codex", path: "/opt/homebrew/bin/codex", version: "0.165.0" }, folder: root, root, tmux: { socket: "/private/tmp/tmux-501/default", session: "$3", pane: "%7" }, host: { pid: 4242, start: "s", uid: 501, boot: "b1" }, untested: true, started: at };
    // The gate's outer cap (START_MS + CARD_MS after the launch) is later than the card's expiry here.
    const gate = { launch, armed: () => clock.now() - launch.started <= START_MS + CARD_MS };
    const cards = cardPublisher(home, "me-alice", { control, gate, now: clock.now });
    const s = waitSurface(home, "me-alice", { control, cards, now: clock.now, retryMs: 1000 });
    const rec = { id: "P1", nonce: "a".repeat(32), kind: "prompt", subtype: "codex-startup-trust", actionable: true, since: new Date(at).toISOString() };
    const hold = () => {
      let release;
      wait = { promise: new Promise((r) => (release = r)) };
      return () => ((wait = null), release());
    };
    return { home, clock, requests, notes, s, rec, hold, gate, setLose: (v) => (lose = v), started: { prompt: classified(), since: at - 1000 } };
  };
  // The first request's answer is lost; the retry starts 1 s before the card expires and its
  // connection is ready 1 s after it, still within the gate's outer cap: not sent, the note goes.
  const w = world(t);
  await w.s.start(w.rec, w.started);
  const expires = readPromptRecord(w.home, "me-alice").manifest.expires_at;
  assert.equal(w.requests.length, 1);
  w.clock.add(expires - w.clock.now() - 1000);
  const release = w.hold();
  const retry = w.s.tick();
  await until(() => w.requests.length === 1, 1000, "the retry waits for its connection");
  w.clock.add(2000);
  assert.ok(w.gate.armed(), "the outer cap still holds");
  release();
  await retry;
  assert.equal(w.requests.length, 1, "the expired request is not sent");
  assert.equal(readPromptRecord(w.home, "me-alice"), null);
  assert.equal(w.notes.length, 1, "the note instead");
  // The same retry whose connection is ready before the expiry: the same request goes, no note.
  const v = world(t);
  await v.s.start(v.rec, v.started);
  const until2 = readPromptRecord(v.home, "me-alice").manifest.expires_at;
  v.clock.add(until2 - v.clock.now() - 2000);
  v.setLose(false);
  const release2 = v.hold();
  const retry2 = v.s.tick();
  v.clock.add(1000);
  release2();
  await retry2;
  assert.equal(v.requests.length, 2);
  assert.equal(v.requests[1], v.requests[0], "the same request");
  assert.equal(v.notes.length, 0);
  assert.equal(readPromptRecord(v.home, "me-alice").state, "published");
});
