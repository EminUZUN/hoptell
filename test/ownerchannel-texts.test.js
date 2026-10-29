// Every text the owner channel's bot can show the owner (design 7.3, section 1 and the "Texts"
// test of section 7): no wire-name prefix, no relay alias, no reference, no long hex run, no UUID,
// no ISO timestamp, and none of the words relay, member, envelope, instruction, pairing, digest.
// First the table itself (lib/ownertexts.js, with sample values), then a sweep of everything the
// bridge sent in a scenario that reaches most of them. Agent-supplied text (questions, notes,
// choices) is chosen so that it passes the same scan, and so is not stripped.
import "./neutral-host.js"; // first: before any module reads the computer's name
import { test } from "node:test";
import assert from "node:assert/strict";
import { HOSTNAME } from "../lib/config.js";
import { AUTOLAND_REFUSED_WHY, IDENTITY, IDENTITY_LIMITS, NOT_AUTO_WHY, TEXTS, UNDELIVERED_REASONS, ago } from "../lib/ownertexts.js";
import { OWNER_CHAT, OWNER_USER, agent, bridgeOn, fakeTelegram, newKey, ownerRelay, paired, textProblems as problems, tmpHome, until } from "./owner-helpers.js";
import { sleep } from "./helpers.js";

// The bridge handles Telegram updates and agent messages one at a time, each with several durable
// (fsynced) state writes, so under load a wait is bounded by the work it covers: this much for each
// update or message queued before the awaited reply.
const PER_UPDATE_MS = 4000;

const SAMPLE = { n: 12, who: "codex-pc2", question: "Ship it?", choice: "yes", reason: "the hoptell server refused it", cmd: "xyz", name: "Main", total: 73, shown: 50, page: 2, pages: 5, excerpt: "Ship it?", when: "12 minutes ago", max: 3500, len: 3501 };
const call = (key, f) => {
  if (typeof f !== "function") return f;
  const args = {
    unknownCommand: [SAMPLE.cmd],
    card: [SAMPLE.n, SAMPLE.who],
    cardResent: [SAMPLE.n, SAMPLE.who],
    cardRepaired: [SAMPLE.n, SAMPLE.who],
    answeredChoice: [SAMPLE.n, SAMPLE.who, SAMPLE.question, SAMPLE.choice],
    answeredReply: [SAMPLE.n, SAMPLE.who, SAMPLE.question],
    expired: [SAMPLE.n, SAMPLE.who, SAMPLE.question],
    undelivered: [SAMPLE.n, SAMPLE.who, SAMPLE.question, SAMPLE.reason],
    cancelled: [SAMPLE.n, SAMPLE.who],
    aliasHint: [SAMPLE.name, "Main (claude-mac)"],
    agentsHeader: [3, 41],
    away: ["Main"],
    searchNone: ["zzz"],
    detailHost: ["sam-mbp"],
    detailTalked: [SAMPLE.when],
    renamePrompt: ["claude-mac"],
    hostMoved: ["Main (claude-mac)", "sam-linux", "sam-mbp"],
    replyNotSent: [TEXTS.statusExpired],
    ambiguous: [SAMPLE.cmd],
    unknownAgent: [SAMPLE.name],
    pendingLine: [SAMPLE.n, SAMPLE.who, SAMPLE.excerpt, SAMPLE.when],
    pendingPage: [SAMPLE.page, SAMPLE.pages],
    showButton: [SAMPLE.n],
    tooLong: [SAMPLE.len, SAMPLE.max],
    landingCard: ["L7", SAMPLE.who],
    landingCardResent: ["L7", SAMPLE.who],
    landingWhat: ["n11", "Validate the settings"],
    landingWhereCheckout: ["main", "app"],
    landingWhereBranch: ["main", "app"],
    landingWhereLinked: ["main", "app", "release"],
    landingRepoIn: ["app", "work"],
    landingTests: ["pass", 2],
    landingUndelivered: ["L7", SAMPLE.who, "n11: Validate the settings", SAMPLE.reason],
    landingReview: ["rev-1 approve"],
    landingDeadline: ["10:15 UTC"],
    landButton: ["L7"],
    landingChoseLand: ["L7", SAMPLE.who, "n11: Validate the settings"],
    landingChoseReject: ["L7", SAMPLE.who, "n11: Validate the settings"],
    landingDecidedElsewhere: ["L7", SAMPLE.who, "n11: Validate the settings"],
    landingExpired: ["L7", SAMPLE.who, "n11: Validate the settings"],
    landingCancelled: ["L7", SAMPLE.who],
    landingDiffName: ["L7"],
    landingOutcome: ["L7", "blocked", "main"],
    landAutoButton: ["n4"],
    landingNotAuto: ["the tests failed, and a reviewer asked for changes"],
    landingChoseLandAuto: ["L7", SAMPLE.who, "n11: Validate the settings", "n4"],
    autolandOn: ["n4", "main", "2 h"],
    autolandRefused: ["n4", AUTOLAND_REFUSED_WHY.stale],
    autolandUnsent: [TEXTS.encryptionRequired],
    autolandNotice: ["L9", "n4", "main", "landed", "1 h 20 min"],
    autolandOff: ["lead", "n4, n5"],
    autolandOffPending: [2],
    autolandOffUnsent: [TEXTS.serverRefused],
    autolandOffer: ["n4", "app", "main, release"],
    autolandGrantSent: ["n4"],
  }[key] ?? [SAMPLE.who];
  return f(...args);
};


test("the computer's name in these scenarios is the neutral stand-in, whatever the machine is called", () => {
  assert.equal(HOSTNAME, "testhost");
});

test("the texts table: every bot text passes the scan, with sample values", () => {
  const keys = Object.keys(TEXTS);
  assert.ok(keys.length > 50, `${keys.length} texts`);
  for (const k of keys) {
    const text = call(k, TEXTS[k]);
    assert.equal(typeof text, "string", k);
    assert.ok(text.length > 0 && text.length < 4096, k);
    assert.deepEqual(problems(text), [], `${k}: ${text}`);
  }
  for (const [k, f] of Object.entries(UNDELIVERED_REASONS)) assert.deepEqual(problems(f(SAMPLE.who)), [], k);
  for (const [k, v] of [...Object.entries(NOT_AUTO_WHY), ...Object.entries(AUTOLAND_REFUSED_WHY)]) assert.deepEqual(problems(v), [], k);
  for (const st of ["landed", "blocked", "rejected", "expired"]) assert.deepEqual(problems(TEXTS.autolandNotice("L9", "n4", "main", st, null)), [], st);
  assert.ok(TEXTS.landAutoButton("a".repeat(32)).length <= 64, "the auto-land button stays short");
  for (const x of [TEXTS.autolandOff("lead", ""), TEXTS.autolandOffPending(1)]) assert.deepEqual(problems(x), [], x);
  assert.equal(TEXTS.autolandOffUnsent(TEXTS.serverRefused), "⚠️ Auto-land could not be turned off on one Mac: the hoptell server refused it. In a terminal there: hoptell team autoland <team> --off");
  assert.equal(TEXTS.autolandUnsent(TEXTS.serverRefused), "⚠️ Auto-land was not turned on: the hoptell server refused it.");
  for (const [k, v] of Object.entries(IDENTITY)) {
    assert.deepEqual(problems(v), [], k);
    assert.ok(v.length <= IDENTITY_LIMITS[k], `${k}: ${v.length} > ${IDENTITY_LIMITS[k]}`);
  }
  assert.equal(TEXTS.agentsHeader(1, 0), "Your agents: 1 favourite, 0 online.");
  assert.equal(TEXTS.agentsHeader(0, 1), "Your agents: 0 favourites, 1 online.");
  assert.equal(TEXTS.tooLong(3501, 3500), "Too long to send: 3,501 characters, the limit is 3,500. Please shorten or split it.");
  assert.deepEqual([0, 59_000, 60_000, 12 * 60_000, 3600_000, 50 * 3600_000].map(ago), ["just now", "just now", "1 minute ago", "12 minutes ago", "1 hour ago", "2 days ago"]);
});

// Static button labels must stay short enough for a phone; the alert texts fit Telegram's 200.
const BUTTON_MAX = 32;
const BUTTONS = ["cancelButton", "moreButton", "searchButton", "messageButton", "favButton", "unfavButton", "renameButton", "hideButton", "unhideButton", "sendButton", "sendRememberButton", "backButton", "nextButton", "appButton", "undoButton", "autolandGrantButton"];
const ALERTS = ["autolandOfferGone", "autolandOfferChanged", "earlierSetup", "peopleFull", "notSaved", "listOld", "undoChanged", "tapAgain", "buttonExpired", "shownTooOften", "noLongerOpen", "statusExpired", "statusCancelled", "statusUndelivered", "alreadyAnswered", "sentAck", "encryptionRequired", "encryptionPaused", "needsUpdate", "serverRefused", "serverUnreachable", "textOnly"];

test("the texts table: button labels are short, alert texts fit 200 characters, placeholders 64", () => {
  for (const k of BUTTONS) assert.ok(TEXTS[k].length <= BUTTON_MAX, `${k}: ${TEXTS[k]}`);
  assert.ok(TEXTS.showButton(9999).length <= BUTTON_MAX);
  for (const k of ALERTS) assert.ok(call(k, TEXTS[k]).length <= 200, `${k}: ${call(k, TEXTS[k]).length}`);
  for (const k of ["notYours", "noSuchAgent"]) assert.ok(TEXTS[k]("x".repeat(64)).length <= 200, k);
  assert.ok(TEXTS.answerPlaceholder.length <= 64);
  // A note head never stacks two icons (the moved marker is on picker buttons only).
  assert.equal(TEXTS.notice("Main"), "💬 Main:");
});

test("the scan itself catches what it should", () => {
  assert.deepEqual(problems("Sent to me-alice."), ["a wire-name prefix"]);
  assert.deepEqual(problems("Your agents on local:"), ["the relay alias"]);
  assert.deepEqual(problems("answered · ref 1a2b3c4d"), ["a reference", "a hex run"]);
  assert.ok(problems("not held by your own member").includes("a banned word (member)"));
  assert.ok(problems("q 11111111-2222-4333-8444-555555555555").includes("a UUID"));
  assert.ok(problems("before 2026-10-15T06:28:14.560Z").includes("an ISO timestamp"));
  assert.deepEqual(problems("Send a new instruction?"), ["a banned word (instruction)"]);
  assert.deepEqual(problems("Codex pc2 asks: deadbeef?"), [], "a word of hex letters is not a hex run");
});

test("the sweep: every text the bridge sent in a broad scenario passes the scan", async (t) => {
  const r = await ownerRelay(t);
  const home = tmpHome(t);
  paired(home);
  const tg = fakeTelegram();
  const { bridge } = bridgeOn(t, { home, telegram: tg.client(), url: r.url, token: r.tokens.me, key: newKey() });
  await until(() => bridge.leading(), 4000, "leader");
  const alice = await agent(t, r.url, r.tokens.me, "me-alice");
  await agent(t, r.url, r.tokens.me, "me-bob");
  // Questions: a choice, a reply, a refused answer, an expired one.
  await alice.ask("Ship it?", { choices: ["yes", "no"] });
  await alice.ask("Which day?");
  await until(() => tg.cards().length === 2, 2 * PER_UPDATE_MS, "cards");
  const [choice, free] = tg.cards();
  tg.press(choice, 0);
  tg.say("Friday", { reply: tg.replyTo(free) });
  await until(() => tg.calls("editMessageText").length >= 2, 2 * PER_UPDATE_MS, "answered");
  tg.press(choice, 1); // a late tap
  tg.say("and Monday", { reply: tg.replyTo(free) }); // the confirm offer
  await until(() => tg.last(/^This question is already answered/), 2 * PER_UPDATE_MS, "confirm");
  const confirm = tg.last(/^This question is already answered/);
  tg.press(confirm, 0, { data: confirm.params.reply_markup.inline_keyboard[0][1].callback_data }); // Cancel
  // Commands and refusals.
  const commands = ["/help", "/pending", "/peers", "/agents", "/zed hi", "@all hi", "@ hi", "@nobody hi", "x".repeat(3501), "/msg"];
  for (const x of commands) tg.say(x);
  tg.push({ message: { message_id: 9999, from: { id: OWNER_USER }, chat: { id: OWNER_CHAT, type: "private" } } }); // a sticker: no text
  await until(() => tg.texts().includes("I can only pass on text messages for now."), (commands.length + 1) * PER_UPDATE_MS, "commands");
  const list = tg.last(/^Who should get your message\?/);
  tg.press(list, 0);
  await until(() => tg.last(/^✏️ Message to /), 4000, "prompt");
  tg.say("please check", { reply: tg.replyTo(tg.last(/^✏️ Message to /)) });
  // A note from an agent, and a reply to it.
  await alice.client.send("me-owner", "All tests pass.", undefined, undefined, { toMember: alice.client.member.id });
  await until(() => tg.last(/^💬 alice:/), 4000, "note");
  tg.say("great, thanks", { reply: tg.replyTo(tg.last(/^💬 alice:/)) });
  await alice.waitFor((m) => m.from === "me-owner" && /great, thanks/.test(m.text));
  // Phase 2: a held text and its picker, the details screen, a favourite, a rename, a search.
  tg.say("hello there");
  await until(() => tg.last(/^Who is this for\?/), 4000, "held");
  tg.press(tg.last(/^Who is this for\?/), 0);
  await alice.waitFor((m) => m.from === "me-owner" && /hello there/.test(m.text));
  const lists = tg.texts().filter((x) => /^Your agents: /.test(x)).length;
  tg.say("/agents");
  await until(() => tg.texts().filter((x) => /^Your agents: /.test(x)).length > lists, 4000, "agents");
  tg.press(tg.last(/^Your agents: /), 0);
  await until(() => tg.last(/^alice\n/), 4000, "details");
  const details = tg.last(/^alice\n/);
  tg.press(details, 0, { data: details.params.reply_markup.inline_keyboard[0][1].callback_data }); // Favourite
  await until(() => tg.calls("editMessageText").some((c) => c.params.message_id === details.message_id), 4000, "details edited");
  const edited = tg.calls("editMessageText").filter((c) => c.params.message_id === details.message_id).at(-1);
  assert.equal(edited.params.reply_markup.inline_keyboard[0][1].text, "★ Remove favourite");
  tg.press(details, 0, { data: edited.params.reply_markup.inline_keyboard[1][0].callback_data }); // Rename
  await until(() => tg.last(/^New name for alice/), 4000, "rename prompt");
  tg.say("@x", { reply: tg.replyTo(tg.last(/^New name for alice/)) });
  tg.say("Main", { reply: tg.replyTo(tg.last(/^New name for alice/)) });
  await until(() => tg.texts().some((x) => x.startsWith("Names can be")), 4000, "refused name");
  tg.say("@Main hi");
  await until(() => tg.texts().some((x) => /^I don't know an agent called "Main"\. Did you mean/.test(x)), 2 * PER_UPDATE_MS, "alias hint"); // after the rename to Main
  tg.say("/msg");
  await until(() => tg.calls("sendMessage").filter((c) => c.params.text === "Who should get your message?").length >= 2, 4000, "msg");
  const picker = tg.calls("sendMessage").filter((c) => c.params.text === "Who should get your message?").at(-1);
  const search = picker.params.reply_markup.inline_keyboard.flat().find((b) => b.text === "🔍 Search");
  tg.press(picker, 0, { data: search.callback_data });
  await until(() => tg.last(/^Type part of a name\./), 4000, "search prompt");
  tg.say("zzz", { reply: tg.replyTo(tg.last(/^Type part of a name\./)) });
  await until(() => tg.texts().includes('No agent matches "zzz".'), 4000, "no match");
  // A reply to an unknown bot message.
  tg.say("who?", { reply: { message_id: 1, text: "anything" } });
  await until(() => tg.texts().some((x) => /^I can't tell who that message was for\./.test(x)), 4000, "lost track");
  await sleep(200);
  const texts = [
    ...tg.sent.filter((s) => s.method === "sendMessage" || s.method === "editMessageText").map((s) => s.params.text),
    ...tg.calls("answerCallbackQuery").map((s) => s.params.text).filter(Boolean),
    ...tg.sent.flatMap((s) => (s.params.reply_markup?.inline_keyboard ?? []).flat().map((b) => b.text)),
    ...tg.sent.map((s) => s.params.reply_markup?.input_field_placeholder).filter(Boolean),
  ];
  assert.ok(texts.length > 25, `${texts.length} texts`);
  for (const x of texts) assert.deepEqual(problems(x), [], x.slice(0, 120));
  // Telegram's limits and plain text: no parse_mode anywhere (so nothing needs escaping), a message
  // up to 4096 characters, an alert up to 200, callback_data up to 64 bytes, short button labels.
  for (const c of tg.sent.filter((x) => x.method === "sendMessage" || x.method === "editMessageText")) {
    assert.equal(c.params.parse_mode, undefined, c.params.text.slice(0, 60));
    assert.ok(c.params.text.length <= 4096, c.params.text.slice(0, 60));
  }
  for (const c of tg.calls("answerCallbackQuery")) assert.ok((c.params.text ?? "").length <= 200, c.params.text);
  for (const b of tg.sent.flatMap((x) => (x.params.reply_markup?.inline_keyboard ?? []).flat())) {
    if (b.callback_data !== undefined) assert.ok(Buffer.byteLength(b.callback_data, "utf8") <= 64, b.callback_data);
    assert.ok(b.text.length <= BUTTON_MAX, b.text);
  }
});
