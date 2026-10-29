// Targeting the owner's own agents from Telegram (design 7.2 v5): tap-to-target buttons from
// /peers and /msg, replies that continue with the agent a bot message names, the chat-scoped
// command menu with one command per unambiguous agent, and the Bot API details (reply_parameters,
// no link previews, the 4096 limit, retry_after). A fake Bot API on a real local relay.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { startRelay } from "../lib/relay.js";
import { RelayClient } from "../lib/client.js";
import * as sig from "../lib/ownersig.js";
import { CONFIRM_MS, MENU_HOLD_MS, STATIC_COMMANDS, TARGET_MS, cleanLabel, commandOf, fit, readAudit } from "../lib/ownerchannel.js";
import { BOT_ID, ME, OWNER_CHAT, REALM, agent, bridgeOn, fakeTelegram, newKey, ownerRelay, paired, pinOf, setPeople, tmpHome, until } from "./owner-helpers.js";
import { fakeToken, sleep } from "./helpers.js";

const verifyFor = (key, who) => (m) => sig.verifyEnvelope(m.text, { pin: pinOf(key), realm: REALM, sender: m.from, me: { name: who, member: ME } });
const fromOwner = (a, text) => a.waitFor((x) => x.from === "me-owner" && JSON.parse(x.text).text === text);
const buttonsOf = (m) => (m?.params.reply_markup?.inline_keyboard ?? []).map((r) => r[0]);

/** A bridge on a fresh paired home, leading; `skew` moves the bridge's clock. */
async function setup(t, opts = {}) {
  const r = opts.relay ?? (await ownerRelay(t));
  const home = opts.home ?? tmpHome(t);
  if (!opts.unpaired) paired(home);
  const tg = opts.tg ?? fakeTelegram();
  const key = opts.key ?? newKey();
  const clock = { skew: 0 };
  const { bridge, run } = bridgeOn(t, { home, telegram: tg.client(), url: r.url, token: r.tokens.me, key, now: () => Date.now() + clock.skew, ...opts.bridge });
  await until(() => bridge.leading(), 4000, "leadership");
  return { ...r, home, tg, key, bridge, run, clock };
}

const menuCalls = (tg) => tg.calls("setMyCommands");
const lastMenu = (tg) => menuCalls(tg).at(-1)?.params.commands.map((c) => c.command);

// ---- pure helpers -------------------------------------------------------------------------------

test("commandOf: lower case, '-' to '_', 1-32 of [a-z0-9_], reserved words refused", () => {
  assert.equal(commandOf("alice"), "alice");
  assert.equal(commandOf("Alice"), "alice");
  assert.equal(commandOf("my-bot"), "my_bot");
  assert.equal(commandOf("my_bot"), "my_bot");
  assert.equal(commandOf("x".repeat(32)), "x".repeat(32));
  assert.equal(commandOf("x".repeat(33)), null);
  for (const r of ["help", "start", "settings", "pending", "peers", "msg", "cancel", "team", "teams", "HELP"]) assert.equal(commandOf(r), null, r);
  assert.equal(commandOf("a.b"), null);
  assert.equal(commandOf(""), null);
});

test("fit cuts to 4096 with an ellipsis, never half a surrogate pair; cleanLabel removes control characters", () => {
  assert.equal(fit("abc"), "abc");
  const long = fit("x".repeat(5000));
  assert.equal(long.length, 4096);
  assert.ok(long.endsWith("…"));
  const emoji = fit(`${"x".repeat(4094)}😀😀`);
  assert.ok(emoji.length <= 4096);
  assert.equal(/[\uD800-\uDBFF]…$/.test(emoji), false);
  assert.equal(cleanLabel("a\nb\u0007c‮d"), "a b c d");
  assert.equal(cleanLabel("\n\t"), "?");
  assert.equal(cleanLabel("x".repeat(80), 40).length, 40);
});

// ---- the relay attests ownership ----------------------------------------------------------------

test("the relay's list attests `own` (cap list_own): a shared-token peer holding me-fake is not the member's", async (t) => {
  const shared = fakeToken();
  const tokens = { me: fakeToken(), bob: fakeToken() };
  const relay = await startRelay({ host: "127.0.0.1", port: 0, token: shared, members: [{ name: "me", id: ME, token: tokens.me }, { name: "bob", id: "m_bbbbbbbbbbbbbbbbbbbbbbbbbb", token: tokens.bob }], realm: { id: REALM, name: "local" }, log: () => {} });
  t.after(() => relay.close());
  const url = `ws://127.0.0.1:${relay.port}`;
  await agent(t, url, tokens.me, "me-alice");
  await agent(t, url, tokens.bob, "bob-x");
  await agent(t, url, shared, "me-fake");
  const viewer = new RelayClient({ url, token: tokens.me, name: "me-viewer", reconnect: false });
  t.after(() => viewer.close());
  await viewer.start().ready();
  assert.ok(viewer.caps.includes("list_own"));
  const byName = Object.fromEntries((await viewer.list()).map((p) => [p.name, p]));
  assert.equal(byName["me-alice"].own, true);
  assert.equal(byName["me-fake"].own, false, "a name's shape proves nothing");
  assert.equal(byName["bob-x"].own, false);
  // A shared-token caller gets no attestation at all.
  const anon = new RelayClient({ url, token: shared, name: "anon", reconnect: false });
  t.after(() => anon.close());
  await anon.start().ready();
  assert.equal((await anon.list()).some((p) => "own" in p), false);
});

// ---- feature 1: buttons --------------------------------------------------------------------------

test("/msg: one button per own online agent (the bridge, other members and offline agents excluded); tap, prompt, reply: a signed instruction", async (t) => {
  const s = await setup(t);
  const alice = await agent(t, s.url, s.tokens.me, "me-alice");
  await agent(t, s.url, s.tokens.me, "me-bob");
  await agent(t, s.url, s.tokens.bob, "bob-x");
  s.tg.say("/msg");
  await until(() => s.tg.last(/^Who should get your message\?/), 4000, "list");
  const list = s.tg.last(/^Who should get your message\?/);
  assert.equal(list.params.text, "Who should get your message?");
  const buttons = buttonsOf(list);
  assert.deepEqual(
    buttons.map((b) => b.text),
    ["alice", "bob", "🔍 Search"],
    "the bridge, other members' agents and offline agents get no button",
  );
  for (const b of buttons.slice(0, 2)) {
    assert.match(b.callback_data, /^t:[a-z2-7]{10}$/);
    assert.equal(b.callback_data.includes("alice"), false, "no name in the data");
  }
  assert.equal(list.params.disable_notification, true);
  assert.deepEqual(list.params.link_preview_options, { is_disabled: true });
  s.tg.press(list, 0);
  await until(() => s.tg.last(/^✏️ Message to alice/), 4000, "prompt");
  const prompt = s.tg.last(/^✏️ Message to alice/);
  assert.equal(prompt.params.text, "✏️ Message to alice. Write it below.");
  assert.deepEqual(prompt.params.reply_markup, { force_reply: true, input_field_placeholder: "Message to alice" });
  const acks = s.tg.calls("answerCallbackQuery");
  assert.equal(acks.length, 1, "the tap is answered");
  assert.equal(acks[0].params.chat_id, undefined, "answerCallbackQuery takes no chat_id");
  await sleep(100);
  assert.equal(alice.got.length, 0, "a tap sends nothing to the agent");
  s.tg.say("run the tests please", { reply: s.tg.replyTo(prompt) });
  const m = await fromOwner(alice, "run the tests please");
  const v = verifyFor(s.key, "me-alice")(m);
  assert.equal(v.ok, true, v.reason);
  assert.equal(v.env.kind, "instruction");
  // A 👍 on the owner's message, which becomes its route: replying to it continues with the agent.
  await until(() => s.tg.calls("setMessageReaction").length === 1, 4000, "👍");
  const ownMsg = s.tg.updates.at(-1).message;
  assert.equal(s.tg.calls("setMessageReaction")[0].params.message_id, ownMsg.message_id);
  assert.equal(s.tg.texts().some((x) => /^Sent to/.test(x)), false);
  s.tg.say("and then deploy", { reply: { message_id: ownMsg.message_id, text: ownMsg.text } });
  await fromOwner(alice, "and then deploy");
  // Audit: names and lengths, never the text.
  const audit = JSON.stringify(readAudit(s.home));
  assert.equal(audit.includes("run the tests"), false);
  assert.equal(audit.includes("deploy"), false);
  assert.match(audit, /"targeted"/);
});

test("/msg: buttons for online agents; a newer list retires the older one, whose taps are out of date", async (t) => {
  const s = await setup(t);
  await agent(t, s.url, s.tokens.me, "me-alice");
  s.tg.say("/msg");
  await until(() => s.tg.last(/^Who should get your message\?/));
  const first = s.tg.last(/^Who should get your message\?/);
  assert.equal(first.params.text, "Who should get your message?");
  s.tg.say("/msg");
  await until(() => s.tg.calls("editMessageReplyMarkup").some((c) => c.params.message_id === first.message_id), 4000, "older list retired");
  const second = s.tg.last(/^Who should get your message\?/);
  assert.notEqual(second.message_id, first.message_id);
  s.tg.press(first, 0);
  await until(() => s.tg.calls("answerCallbackQuery").some((c) => c.params.text === "This list is old. Open a new one with /msg."));
  s.tg.press(second, 0);
  await until(() => s.tg.last(/^✏️ Message to alice/));
  // The live id pressed on another message (the first list) is refused too.
  s.tg.press(first, 0, { data: buttonsOf(second)[0].callback_data });
  await until(() => s.tg.calls("answerCallbackQuery").filter((c) => c.params.text === "This list is old. Open a new one with /msg.").length === 2);
  // Nobody online: no buttons; that newer list still retires the older one.
  const s2 = await setup(t);
  const bob = await agent(t, s2.url, s2.tokens.me, "me-bob");
  s2.tg.say("/msg");
  await until(() => s2.tg.last(/^Who should get your message\?/));
  const populated = s2.tg.last(/^Who should get your message\?/);
  bob.client.close();
  await until(async () => !(await s2.bridge.relay.list()).some((p) => p.name === "me-bob" && p.online), 4000, "bob offline");
  s2.tg.say("/msg");
  await until(() => s2.tg.texts().includes("None of your agents is online right now. To leave a message for one, write @name and your message; it waits until the agent is back."));
  await until(() => s2.tg.calls("editMessageReplyMarkup").some((c) => c.params.message_id === populated.message_id), 4000, "retired");
  assert.deepEqual(
    Object.values(s2.bridge.state().targets).map((x) => x.kind),
    ["search"],
    "only Search: bob is offline and not a favourite",
  );
  s2.tg.press(populated, 0);
  await until(() => s2.tg.calls("answerCallbackQuery").some((c) => c.params.text === "This list is old. Open a new one with /msg."));
});

test("target buttons expire after 24 hours; unknown data is answered; a foreign user's or chat's tap is dropped and not answered", async (t) => {
  const s = await setup(t);
  await agent(t, s.url, s.tokens.me, "me-alice");
  s.tg.say("/peers");
  await until(() => s.tg.last(/^Your agents:/));
  const list = s.tg.last(/^Your agents:/);
  s.tg.press(list, 0, { from: 777, chat: 777 });
  s.tg.press(list, 0, { chat: 888 });
  await until(() => s.bridge.state().drops.foreign_callback === 2);
  assert.equal(s.tg.calls("answerCallbackQuery").length, 0, "not answered: the bot does not reveal itself");
  s.tg.press(list, 0, { data: "garbage" });
  await until(() => s.tg.calls("answerCallbackQuery").some((c) => c.params.text === "This question is no longer open."));
  s.clock.skew = TARGET_MS + 1000;
  s.tg.press(list, 0);
  await until(() => s.tg.calls("answerCallbackQuery").some((c) => c.params.text === "This list is old. Open a new one with /msg."));
  await s.bridge.tick();
  assert.deepEqual(s.bridge.state().targets, {}, "expired targets are pruned");
});

test("without the relay's list_own cap: no buttons and no agent commands, the static menu stays", async (t) => {
  const clientFactory = (o) => {
    const c = new RelayClient(o);
    c.on("ready", () => (c.caps = c.caps.filter((x) => x !== "list_own")));
    return c;
  };
  const r = await ownerRelay(t);
  // An empty name prefix: without the relay's attestation no name is listed, own or not.
  const s = await setup(t, { relay: r, bridge: { clientFactory, namePrefix: "" } });
  await agent(t, s.url, s.tokens.me, "me-alice");
  await agent(t, s.url, s.tokens.bob, "bob-x");
  const notice = "I can't list your agents: the hoptell server needs an update. You can still write @name followed by your message.";
  s.tg.say("/peers");
  await until(() => s.tg.texts().includes(notice));
  s.tg.say("/msg");
  await until(() => s.tg.texts().filter((x) => x === notice).length === 2);
  assert.equal(s.tg.sent.some((x) => /me-alice|bob-x/.test(JSON.stringify(x.params))), false, "no unconfirmed name reaches Telegram");
  await s.bridge.menuCheck();
  assert.deepEqual(lastMenu(s.tg), STATIC_COMMANDS.map((c) => c.command));
  s.tg.say("/alice hi");
  await until(() => s.tg.texts().filter((x) => x === notice).length === 3);
});

// ---- feature 2: replies ---------------------------------------------------------------------------

test("a reply to a closed card asks first; the confirm button sends once, is bound to its message, and survives a restart", async (t) => {
  const r = await ownerRelay(t);
  const home = tmpHome(t);
  const key = newKey();
  const tg = fakeTelegram();
  const s = await setup(t, { relay: r, home, key, tg });
  const alice = await agent(t, s.url, s.tokens.me, "me-alice");
  await alice.ask("Ship it?", { choices: ["yes", "no"] });
  await until(() => tg.cards().length === 1);
  const card = tg.cards()[0];
  tg.press(card, 0);
  await fromOwner(alice, "yes");
  tg.say("also bump the version", { reply: tg.replyTo(card) });
  await until(() => tg.last(/^This question is already answered\./));
  const confirm = tg.last(/^This question is already answered\./);
  assert.equal(confirm.params.text, "This question is already answered. Send your text to alice as a new message?");
  const [[button, cancel]] = confirm.params.reply_markup.inline_keyboard;
  assert.equal(button.text, "Send to alice");
  assert.match(button.callback_data, /^c:[a-z2-7]{10}$/);
  assert.deepEqual(cancel, { text: "Cancel", callback_data: `x:${button.callback_data.slice(2)}` });
  // The offer is audited with the agent and the ids only, never the text.
  const offers = readAudit(home).filter((e) => e.event === "confirm_offered");
  assert.equal(offers.length, 1);
  const { at, ...offer } = offers[0];
  assert.ok(at);
  assert.deepEqual(offer, { event: "confirm_offered", to: "me-alice", confirm: button.callback_data.slice(2), card: card.message_id, q: Object.keys(s.bridge.state().questions)[0] });
  assert.equal(JSON.stringify(readAudit(home)).includes("also bump the version"), false);
  await sleep(150);
  assert.equal(alice.got.filter((x) => x.from === "me-owner").length, 1, "not sent before the tap");
  // The id on another message is refused; the state keeps the text only in the confirm entry.
  tg.press(card, 0, { data: button.callback_data });
  await until(() => tg.calls("answerCallbackQuery").some((c) => c.params.text === "This button has expired."));
  assert.equal(tg.calls("editMessageReplyMarkup").some((c) => c.params.message_id === card.message_id), false, "a card's buttons are never retired by a stale tap");
  // A restart keeps the entry.
  await s.bridge.stop();
  const { bridge } = bridgeOn(t, { home, telegram: tg.client("b"), url: r.url, token: r.tokens.me, key });
  await until(() => bridge.leading());
  tg.press(confirm, 0);
  const m = await fromOwner(alice, "also bump the version");
  assert.equal(verifyFor(key, "me-alice")(m).env.kind, "instruction");
  await until(() => tg.calls("editMessageText").some((c) => c.params.message_id === confirm.message_id && c.params.text === "✅ Sent to alice."));
  assert.ok(tg.calls("answerCallbackQuery").some((c) => c.params.text === "✅ Sent."));
  // Once: a second tap finds nothing.
  tg.press(confirm, 0);
  await until(() => tg.calls("answerCallbackQuery").filter((c) => c.params.text === "This button has expired.").length === 2);
  await sleep(150);
  assert.equal(alice.got.filter((x) => x.from === "me-owner").length, 2);
  assert.equal(JSON.stringify(bridge.state()).includes("also bump the version"), false, "the text is gone from state");
  // The edited confirmation is a route: a reply to it continues with the agent.
  tg.say("thanks", { reply: { message_id: confirm.message_id, text: "✅ Sent to alice." } });
  await fromOwner(alice, "thanks");
});

test("a confirm button expires after 10 minutes, and its text goes with it", async (t) => {
  const s = await setup(t);
  const alice = await agent(t, s.url, s.tokens.me, "me-alice");
  await alice.ask("Now?", { choices: ["a", "b"] });
  await until(() => s.tg.cards().length === 1);
  const card = s.tg.cards()[0];
  s.tg.press(card, 1);
  await fromOwner(alice, "b");
  s.tg.say("secret-ish follow up", { reply: s.tg.replyTo(card) });
  await until(() => s.tg.last(/^This question is already answered\./));
  const confirm = s.tg.last(/^This question is already answered\./);
  assert.ok(JSON.stringify(s.bridge.state()).includes("secret-ish follow up"));
  s.clock.skew = CONFIRM_MS + 1000;
  await s.bridge.tick();
  assert.equal(JSON.stringify(s.bridge.state()).includes("secret-ish follow up"), false);
  s.tg.press(confirm, 0);
  await until(() => s.tg.calls("answerCallbackQuery").some((c) => c.params.text === "This button has expired."));
  await until(() => s.tg.calls("editMessageReplyMarkup").some((c) => c.params.message_id === confirm.message_id));
});

test("replies: to a refusal it retries that agent; to an untracked message it says so; never a name from the message text", async (t) => {
  const s = await setup(t);
  s.tg.say("@nobody hello");
  await until(() => s.tg.last(/^Not sent: there is no agent called nobody right now\.$/));
  const refusal = s.tg.last(/^Not sent: there is no agent called nobody right now\.$/);
  const route = s.bridge.state().routes[String(refusal.message_id)];
  assert.deepEqual([route.name, route.kind], ["me-nobody", "refused"]);
  const nobody = await agent(t, s.url, s.tokens.me, "me-nobody");
  s.tg.say("hello again", { reply: s.tg.replyTo(refusal) });
  await fromOwner(nobody, "hello again");
  // A bot message the bridge never routed, whose text names an agent: nothing is sent.
  s.tg.say("/help");
  await until(() => s.tg.last(/^How this works:/));
  s.tg.say("to alice", { reply: { message_id: s.tg.last(/^How this works:/).message_id, text: "✅ Sent to alice." } });
  await until(() => s.tg.texts().includes("I can't tell who that message was for. To answer a question, use /pending; to write to an agent, use /msg."));
  // Routes expire after 7 days.
  s.clock.skew = 8 * 86400_000;
  await s.bridge.tick();
  assert.deepEqual(s.bridge.state().routes, {});
});

// ---- features 3 and 4: the menu --------------------------------------------------------------------

test("the menu: chat scope, static commands then one per agent; unchanged lists are not registered again; agent commands work", async (t) => {
  const s = await setup(t);
  await until(() => menuCalls(s.tg).length === 1, 4000, "menu at leadership");
  const first = menuCalls(s.tg)[0];
  assert.deepEqual(first.params.scope, { type: "chat", chat_id: OWNER_CHAT });
  assert.equal(first.params.chat_id, undefined);
  assert.deepEqual(first.params.commands, STATIC_COMMANDS);
  const alice = await agent(t, s.url, s.tokens.me, "me-alice");
  await agent(t, s.url, s.tokens.me, "me-Big-Bot");
  await agent(t, s.url, s.tokens.me, "me-carol");
  await setPeople(s.home, ["me-alice", "me-Big-Bot"]);
  await s.bridge.menuCheck();
  assert.deepEqual(lastMenu(s.tg), ["msg", "agents", "team", "pending", "help", "alice", "big_bot"], "favourites only");
  assert.equal(menuCalls(s.tg).at(-1).params.commands.at(-1).description, "Message Big-Bot");
  await s.bridge.menuCheck();
  assert.equal(menuCalls(s.tg).length, 2, "the same list is not registered again");
  s.tg.say("/alice");
  await until(() => s.tg.last(/^✏️ Message to alice/));
  s.tg.say("/alice@owner_test_bot check the logs");
  await fromOwner(alice, "check the logs");
  s.tg.say("/alice  look again ");
  await fromOwner(alice, "look again");
  s.tg.say("/zed hi");
  await until(() => s.tg.texts().includes("I don't know /zed. Tap the menu button or send /help."));
  // Not by normalising the received text: /ALICE is not /alice.
  s.tg.say("/ALICE hi");
  await until(() => s.tg.texts().includes("I don't know /ALICE. Tap the menu button or send /help."));
  assert.ok(JSON.stringify(readAudit(s.home)).includes('"menu"'));
});

test("collisions: Alice/alice and my-bot/my_bot get no command, also for 24 hours after one leaves and across a restart", async (t) => {
  const r = await ownerRelay(t);
  const home = tmpHome(t);
  const key = newKey();
  const tg = fakeTelegram();
  const s = await setup(t, { relay: r, home, key, tg });
  const a1 = await agent(t, s.url, s.tokens.me, "me-my-bot");
  await agent(t, s.url, s.tokens.me, "me-my_bot");
  await agent(t, s.url, s.tokens.me, "me-carol");
  await setPeople(home, ["me-my_bot", "me-carol"]);
  await s.bridge.menuCheck();
  assert.deepEqual(lastMenu(tg), ["msg", "agents", "team", "pending", "help", "carol"]);
  tg.say("/my_bot hi");
  await until(() => tg.texts().includes("/my_bot fits more than one agent right now. Pick one with /msg."));
  // One leaves: still ambiguous (the hold), also after a restart.
  a1.client.close();
  await sleep(100);
  await s.bridge.stop();
  const clock = { skew: 0 };
  const { bridge } = bridgeOn(t, { home, telegram: tg.client("b"), url: r.url, token: r.tokens.me, key, now: () => Date.now() + clock.skew });
  await until(() => bridge.leading());
  tg.say("/my_bot again");
  await until(() => tg.texts().filter((x) => x === "/my_bot fits more than one agent right now. Pick one with /msg.").length === 2);
  // After the hold (24 h after it was last seen, plus the hourly renewal), only me-my_bot is left.
  clock.skew = MENU_HOLD_MS + 3600_000 + 1000;
  await bridge.menuCheck();
  assert.deepEqual(lastMenu(tg), ["msg", "agents", "team", "pending", "help", "carol", "my_bot"]);
});

test("a colliding agent that comes online between two checks makes the command ambiguous at once; a failed refresh refuses", async (t) => {
  let failList = false;
  const clientFactory = (o) => {
    const c = new RelayClient(o);
    const list = c.list.bind(c);
    c.list = () => (failList ? Promise.reject(new Error("relay busy")) : list());
    return c;
  };
  const s = await setup(t, { bridge: { clientFactory } });
  const carol = await agent(t, s.url, s.tokens.me, "me-carol");
  await setPeople(s.home, ["me-carol"]);
  await s.bridge.menuCheck();
  assert.ok(lastMenu(s.tg).includes("carol"));
  s.tg.say("/carol one");
  await fromOwner(carol, "one");
  await agent(t, s.url, s.tokens.me, "me-Carol"); // no menu check in between
  s.tg.say("/carol two");
  await until(() => s.tg.texts().includes("/carol fits more than one agent right now. Pick one with /msg."));
  failList = true;
  s.tg.say("/carol three");
  await until(() => s.tg.texts().includes("I couldn't reach the hoptell server just now. Please try again in a moment."));
  await sleep(100);
  assert.equal(carol.got.filter((x) => x.from === "me-owner").length, 1);
});

test("the tracking bound fails closed: a full history blocks a colliding command and tracks no new one", async (t) => {
  const home = tmpHome(t);
  sig.ensureChannelDir(home);
  const t0 = Date.now();
  const commands = {};
  for (let i = 0; i < 499; i++) commands[`c${i}`] = { names: { [`me-c${i}`]: t0, [`me-C${i}`]: t0 } };
  commands.alice = { names: { "me-ALICE": t0, "me-Alice": t0 } }; // 1000 names in all
  sig.writePrivateJson(sig.channelPaths(home).state, { v: 1, bot_id: BOT_ID, offset: 0, questions: {}, outbox: [], recent: [], drops: {}, menu: { chat: null, digest: null, at: 0, delete: [], commands } });
  const s = await setup(t, { home });
  await agent(t, s.url, s.tokens.me, "me-alice");
  await agent(t, s.url, s.tokens.me, "me-zed");
  await s.bridge.menuCheck();
  const st = s.bridge.state().menu.commands;
  assert.ok(st.alice.blocked_until > Date.now(), "blocked, not rebound");
  assert.equal(Object.hasOwn(st.alice.names, "me-alice"), false);
  assert.equal(st.zed, undefined, "not tracked: no command");
  assert.deepEqual(lastMenu(s.tg), STATIC_COMMANDS.map((c) => c.command));
  s.tg.say("/alice hi");
  await until(() => s.tg.texts().includes("/alice fits more than one agent right now. Pick one with /msg."));
  s.tg.say("/zed hi");
  await until(() => s.tg.texts().includes("I don't know /zed. Tap the menu button or send /help."));
});

test("at most 100 commands: the static five, then favourites by name", async (t) => {
  const s = await setup(t);
  const names = Array.from({ length: 98 }, (_, i) => `me-a${String(i).padStart(3, "0")}`);
  for (const n of names) await agent(t, s.url, s.tokens.me, n);
  await setPeople(s.home, names);
  await s.bridge.menuCheck();
  const cmds = lastMenu(s.tg);
  assert.equal(cmds.length, 100);
  assert.deepEqual(cmds.slice(5, 7), ["a000", "a001"]);
  assert.equal(cmds.at(-1), "a094");
});

test("the menu follows the pairing: unpaired, it is deleted; a failed deletion is kept and retried; a new chat gets its own", async (t) => {
  const s = await setup(t);
  await until(() => menuCalls(s.tg).length === 1);
  // The pairing moves to another chat: the old chat's list is deleted, the new one set.
  paired(s.home, { chat: 9990001, user: 9990001 });
  await s.bridge.menuCheck();
  assert.deepEqual(s.tg.calls("deleteMyCommands").map((c) => c.params.scope), [{ type: "chat", chat_id: OWNER_CHAT }]);
  assert.deepEqual(menuCalls(s.tg).at(-1).params.scope, { type: "chat", chat_id: 9990001 });
  // Unpaired (plain unpair while the bridge runs); Telegram fails once: kept, retried.
  fs.rmSync(sig.channelPaths(s.home).pairing);
  s.tg.failNext.deleteMyCommands = [502];
  await s.bridge.menuCheck();
  assert.deepEqual(s.bridge.state().menu.delete, [9990001]);
  await s.bridge.menuCheck();
  assert.deepEqual(s.tg.calls("deleteMyCommands").at(-1).params.scope, { type: "chat", chat_id: 9990001 });
  assert.deepEqual(s.bridge.state().menu.delete, []);
  assert.equal(s.bridge.state().menu.chat, null);
  // A refusal (400) is not a confirmation: kept and tried again at the next check.
  paired(s.home, { chat: 9990002, user: 9990002 });
  await s.bridge.menuCheck();
  fs.rmSync(sig.channelPaths(s.home).pairing);
  s.tg.failNext.deleteMyCommands = [400];
  await s.bridge.menuCheck();
  assert.deepEqual(s.bridge.state().menu.delete, [9990002]);
  await s.bridge.menuCheck();
  assert.deepEqual(s.bridge.state().menu.delete, []);
});

// ---- Bot API details --------------------------------------------------------------------------------

test("every text has no link preview and no parse_mode; replies use reply_parameters; a long answered edit is cut to 4096", async (t) => {
  const s = await setup(t);
  const alice = await agent(t, s.url, s.tokens.me, "me-alice");
  await alice.ask("q".repeat(3000));
  await until(() => s.tg.cards().length === 1);
  const card = s.tg.cards()[0];
  s.tg.say("a".repeat(3500), { reply: s.tg.replyTo(card) });
  await until(() => s.tg.calls("editMessageText").length === 1);
  const edit = s.tg.calls("editMessageText")[0];
  // No echo of the answer: a 3,000-character question with a 3,500-character answer stays whole.
  assert.ok(edit.params.text.length < 4096, String(edit.params.text.length));
  assert.equal(edit.params.text, `✅ Question 1 · alice asked:\n${"q".repeat(3000)}\n\nAnswered (your reply is below).`);
  s.tg.say("@alice hi");
  s.tg.say("/pending");
  await until(() => s.tg.texts().includes("No questions are waiting for you."));
  for (const c of s.tg.sent.filter((x) => x.method === "sendMessage" || x.method === "editMessageText")) {
    assert.deepEqual(c.params.link_preview_options, { is_disabled: true }, c.params.text.slice(0, 40));
    assert.equal(c.params.parse_mode, undefined);
    assert.equal("reply_to_message_id" in c.params, false);
  }
  assert.ok(s.tg.last(/^No questions are waiting for you\.$/).params.reply_parameters.message_id > 0);
});

test("429: the outbox waits retry_after before trying again", async (t) => {
  const s = await setup(t);
  s.tg.failNext.sendMessage = [429]; // the fake's retry_after is 1 s
  const at = Date.now();
  s.tg.say("/help");
  await until(() => s.tg.last(/^How this works:/), 5000, "help after the wait");
  assert.ok(Date.now() - at >= 900, `waited ${Date.now() - at} ms`);
});
