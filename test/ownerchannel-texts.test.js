// Every text the owner channel's bot can show the owner (design 7.3, section 1 and the "Texts"
// test of section 7): no wire-name prefix, no relay alias, no reference, no long hex run, no UUID,
// no ISO timestamp, and none of the words relay, member, envelope, instruction, pairing, digest.
// First the table itself (lib/ownertexts.js, with sample values), then a sweep of everything the
// bridge sent in a scenario that reaches most of them. Agent-supplied text (questions, notes,
// choices) is chosen so that it passes the same scan, and so is not stripped.
import { test } from "node:test";
import assert from "node:assert/strict";
import { IDENTITY, IDENTITY_LIMITS, TEXTS, UNDELIVERED_REASONS, ago } from "../lib/ownertexts.js";
import { OWNER_CHAT, OWNER_USER, agent, bridgeOn, fakeTelegram, newKey, ownerRelay, paired, textProblems as problems, tmpHome, until } from "./owner-helpers.js";
import { sleep } from "./helpers.js";

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
  }[key] ?? [SAMPLE.who];
  return f(...args);
};

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
  for (const [k, v] of Object.entries(IDENTITY)) {
    assert.deepEqual(problems(v), [], k);
    assert.ok(v.length <= IDENTITY_LIMITS[k], `${k}: ${v.length} > ${IDENTITY_LIMITS[k]}`);
  }
  assert.equal(TEXTS.agentsHeader(1, 0), "Your agents: 1 favourite, 0 online.");
  assert.equal(TEXTS.agentsHeader(0, 1), "Your agents: 0 favourites, 1 online.");
  assert.equal(TEXTS.tooLong(3501, 3500), "Too long to send: 3,501 characters, the limit is 3,500. Please shorten or split it.");
  assert.deepEqual([0, 59_000, 60_000, 12 * 60_000, 3600_000, 50 * 3600_000].map(ago), ["just now", "just now", "1 minute ago", "12 minutes ago", "1 hour ago", "2 days ago"]);
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
  await until(() => tg.cards().length === 2, 4000, "cards");
  const [choice, free] = tg.cards();
  tg.press(choice, 0);
  tg.say("Friday", { reply: tg.replyTo(free) });
  await until(() => tg.calls("editMessageText").length >= 2, 4000, "answered");
  tg.press(choice, 1); // a late tap
  tg.say("and Monday", { reply: tg.replyTo(free) }); // the confirm offer
  await until(() => tg.last(/^This question is already answered/), 4000, "confirm");
  const confirm = tg.last(/^This question is already answered/);
  tg.press(confirm, 0, { data: confirm.params.reply_markup.inline_keyboard[0][1].callback_data }); // Cancel
  // Commands and refusals.
  for (const x of ["/help", "/pending", "/peers", "/agents", "/zed hi", "@all hi", "@ hi", "@nobody hi", "x".repeat(3501), "/msg"]) tg.say(x);
  tg.push({ message: { message_id: 9999, from: { id: OWNER_USER }, chat: { id: OWNER_CHAT, type: "private" } } }); // a sticker: no text
  await until(() => tg.texts().includes("I can only pass on text messages for now."), 6000, "commands");
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
  assert.equal(edited.params.reply_markup.inline_keyboard[0][1].text, "★ Unfavourite");
  tg.press(details, 0, { data: edited.params.reply_markup.inline_keyboard[1][0].callback_data }); // Rename
  await until(() => tg.last(/^New name for alice/), 4000, "rename prompt");
  tg.say("@x", { reply: tg.replyTo(tg.last(/^New name for alice/)) });
  tg.say("Main", { reply: tg.replyTo(tg.last(/^New name for alice/)) });
  await until(() => tg.texts().some((x) => x.startsWith("Names can be")), 4000, "refused name");
  tg.say("@Main hi");
  await until(() => tg.texts().some((x) => /^I don't know an agent called "Main"\. Did you mean/.test(x)), 4000, "alias hint");
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
});
