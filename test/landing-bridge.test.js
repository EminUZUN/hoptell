// Landing approval through the owner's Telegram bridge (design 8 addendum, option 3; L3a): the
// request, decision and outcome shapes (lib/landings.js), the receipt check of hoptell team apply,
// and the bridge's landing card on a real local relay with a fake Bot API: Land, Reject, Show diff,
// the first decision winning, expiry at the tap, a decision signed once, and the outcome on the card.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import * as sig from "../lib/ownersig.js";
import { canonicalize } from "../lib/jcs.js";
import { Crash } from "../lib/ownerchannel.js";
import { APPLY_WINDOW_MS, BRIDGE_STATUS, autolandStatusText, bridgeTakesLandings, checkReceipt, decisionText, landingRequest, landingStatusText, manifestProblem, parseAutolandStatus, parseDecision, parseLandingRequest, parseLandingStatus, parseRevoke, patchBytes, revokeText } from "../lib/landings.js";
import { noticeText, parseGrant } from "../lib/grants.js";
import { BOB, ME, OWNER_CHAT, OWNER_USER, REALM, agent, bridgeOn, fakeTelegram, newKey, ownerRelay, paired, pinOf, textProblems, tmpHome, until } from "./owner-helpers.js";
import { sleep } from "./helpers.js";

const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const PATCH = "diff --git a/settings.js b/settings.js\n--- a/settings.js\n+++ b/settings.js\n@@ -1 +1 @@\n-const strict = false;\n+const strict = true;\n";

/** A complete evidence manifest as teamLandRequest makes it (digests computed from the bytes). */
export function sampleManifest({ id = "L7", patch = PATCH, oversize = false, now = Date.now(), ttl = 15 * 60_000, lead = "me-lead", member = ME, common = "/srv/src/app/.git", commands = ["npm test"], target = "main", mode = { kind: "checkout", worktree: "/srv/src/app", gitDir: "/srv/src/app/.git" } } = {}) {
  const review = { id: "rv-0a1b2c3d", base: "a".repeat(40), head: "c".repeat(40), reviewers: ["me-rev-1"], verdicts: [{ reviewer: "me-rev-1", verdict: "approve", at: new Date(now).toISOString() }] };
  const report = "ok 1 - settings are validated\n";
  const diffstat = " settings.js | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)";
  return {
    version: 1,
    id,
    realm: REALM,
    enrolment: { common, id: "e".repeat(32), generation: 1 },
    team: "web",
    run: "f".repeat(32),
    member: "me-n11",
    target,
    T: "a".repeat(40),
    H: "b".repeat(40),
    C: "c".repeat(40),
    parent: "a".repeat(40),
    mode,
    cleanup: { worktree: "/srv/wt/n11", branch: "team/web/n11", candidate: "team/web/land" },
    recipient: { realm: REALM, member, lead },
    evidence: {
      subject: "Validate the settings",
      diffstat: { text: diffstat, digest: sha(diffstat) },
      patch: oversize ? { text: null, encoding: null, bytes: 300_000, digest: "d".repeat(64), oversize: true } : { text: patch, encoding: "utf8", bytes: Buffer.byteLength(patch), digest: sha(patch), oversize: false },
      tests: { result: "pass", commands, report, digest: sha(report), at: new Date(now).toISOString() },
      review: { ...review, digest: sha(canonicalize(review)) },
    },
    created_at: new Date(now).toISOString(),
    expires_at: new Date(now + ttl).toISOString(),
    nonce: "9".repeat(32),
  };
}

const digestOf = (m) => sha(canonicalize(m));

// ---- the shapes --------------------------------------------------------------------------------

test("a landing request: built and read back with the digest of the manifest's canonical bytes; every evidence digest is recomputed", () => {
  const m = sampleManifest();
  assert.equal(manifestProblem(m), null);
  const text = landingRequest(m);
  const r = parseLandingRequest(text);
  assert.equal(r.digest, digestOf(m));
  assert.deepEqual(r.manifest, m);
  assert.equal(parseLandingRequest("plain text"), null);
  assert.equal(parseLandingRequest('{"hoptell_owner_question":1}'), null);
  assert.match(parseLandingRequest(` ${text}`.trim().replace(/^\{/, "{ ")).problem, /canonical|JSON/);
  // Tampered evidence: each digest is checked against its bytes.
  const tamper = (f) => {
    const x = structuredClone(m);
    f(x);
    return manifestProblem(x);
  };
  assert.equal(tamper((x) => (x.evidence.patch.text += "+evil\n")), "patch digest");
  assert.equal(tamper((x) => (x.evidence.diffstat.text = "0 files changed")), "diffstat");
  assert.equal(tamper((x) => (x.evidence.tests.report = "all good")), "test report digest");
  assert.equal(tamper((x) => (x.evidence.review.verdicts[0].verdict = "changes")), "review digest");
  assert.equal(tamper((x) => (x.recipient.realm = "0".repeat(32))), "recipient");
  assert.equal(tamper((x) => (x.extra = 1)), "not the fields of a landing manifest");
  assert.equal(tamper((x) => (x.evidence.patch = { text: "x", encoding: null, bytes: 1, digest: "d".repeat(64), oversize: true })), "patch");
  assert.match(parseLandingRequest(canonicalize({ hoptell_owner_landing: 1, manifest: { ...m, recipient: null } })).problem, /recipient/);
  // A base64 patch decodes to its bytes; a patch the request does not hold has none.
  const bin = Buffer.from([0, 1, 2, 255]);
  assert.deepEqual(patchBytes({ text: bin.toString("base64"), encoding: "base64", bytes: 4, digest: sha(bin), oversize: false }), bin);
  assert.equal(patchBytes(sampleManifest({ oversize: true }).evidence.patch), null);
});

test("a decision, an outcome and the bridge's status: exact canonical shapes", () => {
  const d = decisionText({ id: "L7", digest: "d".repeat(64), decision: "land", decidedAt: 1000, expiresAt: 2000 });
  assert.deepEqual(parseDecision(d), { hoptell_landing_decision: 1, id: "L7", digest: "d".repeat(64), decision: "land", decided_at: 1000, expires_at: 2000 });
  assert.equal(parseDecision(d.replace('"land"', '"merge"')), null);
  assert.equal(parseDecision(` ${d}`), null);
  assert.throws(() => decisionText({ id: "L7", digest: "d".repeat(64), decision: "maybe", decidedAt: 1, expiresAt: 2 }));
  const o = landingStatusText({ digest: "d".repeat(64), state: "landed", text: "L7 landed on main." });
  assert.deepEqual(parseLandingStatus(o), { digest: "d".repeat(64), state: "landed", text: "L7 landed on main." });
  assert.equal(parseLandingStatus("hello"), null);
  assert.ok(parseLandingStatus('{"hoptell_owner_landing_status":1,"digest":"x"}').problem);
  assert.equal(bridgeTakesLandings(BRIDGE_STATUS), true);
  assert.equal(bridgeTakesLandings('{"hoptell_bridge":1,"caps":[]}'), false);
  assert.equal(bridgeTakesLandings('{"v":1,"teams":[]}'), false);
  assert.equal(bridgeTakesLandings(null), false);
});

// ---- the receipt hoptell team apply verifies -------------------------------------------------------

function receipt(key, m, { decision = "land", decidedAt = Date.now(), from = "me-owner", to = { name: m.recipient.lead, member: m.recipient.member }, digest = digestOf(m), expiresAt = Date.parse(m.expires_at), ts = decidedAt } = {}) {
  const text = decisionText({ id: m.id, digest, decision, decidedAt, expiresAt });
  return sig.signEnvelope({ kind: "landing_decision", realm: REALM, from, to, q: crypto.randomUUID(), text, pairing: { id: "p_abcdefghijklmnop", at: 1_700_000_000_000 }, ts, nonce: crypto.randomBytes(32).toString("base64url") }, key);
}

test("the receipt check: signature, pin, recipient, digest and the apply window, from the original bytes", () => {
  const key = newKey();
  const pin = pinOf(key);
  const now = Date.now();
  const m = sampleManifest({ now });
  const d = digestOf(m);
  const ok = checkReceipt(receipt(key, m, { decidedAt: now + 1000 }), { pin, manifest: m, digest: d, now: now + 2000 });
  assert.equal(ok.decision, "land");
  assert.match(ok.receipt, /^[0-9a-f]{64}$/);
  // A tap at minute 14 still leaves the lead the whole apply window.
  const late = now + 14 * 60_000;
  assert.equal(checkReceipt(receipt(key, m, { decidedAt: late }), { pin, manifest: m, digest: d, now: late + APPLY_WINDOW_MS - 1 }).decision, "land");
  assert.throws(() => checkReceipt(receipt(key, m, { decidedAt: late }), { pin, manifest: m, digest: d, now: late + APPLY_WINDOW_MS + 1 }), (e) => e.code === "action_expired");
  // A land decision dated after the request expired is never applied.
  const after = Date.parse(m.expires_at) + 1;
  assert.throws(() => checkReceipt(receipt(key, m, { decidedAt: after }), { pin, manifest: m, digest: d, now: after + 1 }), (e) => e.code === "action_expired");
  // Another key, another digest, another addressee, another bridge name: nothing verifies.
  assert.throws(() => checkReceipt(receipt(newKey(), m), { pin, manifest: m, digest: d, now }), /does not verify \(key not trusted\)/);
  assert.throws(() => checkReceipt(receipt(key, m, { digest: "0".repeat(64) }), { pin, manifest: m, digest: d, now }), /for another landing/);
  assert.throws(() => checkReceipt(receipt(key, m, { to: { name: "me-other", member: ME } }), { pin, manifest: m, digest: d, now }), /not addressed to this session/);
  assert.throws(() => checkReceipt(receipt(key, m, { from: "me-fake" }), { pin, manifest: m, digest: d, now }), /not sent by the trusted bridge name/);
  assert.throws(() => checkReceipt(receipt(key, m, { expiresAt: Date.parse(m.expires_at) + 60_000 }), { pin, manifest: m, digest: d, now }), /another expiry/);
  assert.throws(() => checkReceipt(receipt(key, m), { pin: null, manifest: m, digest: d, now }), /trusts no owner channel/);
  // A reject is read as such, whenever it is applied.
  assert.equal(checkReceipt(receipt(key, m, { decision: "reject", decidedAt: now }), { pin, manifest: m, digest: d, now: now + APPLY_WINDOW_MS * 4 }).decision, "reject");
});

// ---- the bridge ----------------------------------------------------------------------------------

async function setup(t, opts = {}) {
  const { url, tokens } = await ownerRelay(t);
  const { unpaired = false, ...rest } = opts;
  const home = tmpHome(t);
  if (!unpaired) paired(home);
  const tg = fakeTelegram();
  const key = newKey();
  const b = bridgeOn(t, { home, telegram: tg.client(), url, token: tokens.me, key, ...rest });
  await until(() => b.bridge.leading(), 4000, "leadership");
  const lead = await agent(t, url, tokens.me, "me-lead");
  const cli = await agent(t, url, tokens.me, "me-cli-1");
  const request = async (m) => (await cli.client.send("me-owner", landingRequest(m), 900, undefined, { toMember: ME })).message_id;
  return { url, tokens, home, tg, key, ...b, lead, cli, request };
}
const verifyAt = (key, name) => (m) => sig.verifyEnvelope(m.text, { pin: pinOf(key), realm: REALM, sender: m.from, me: { name, member: ME } });
const acks = (tg) => tg.calls("answerCallbackQuery").map((c) => c.params.text);
const edits = (tg) => tg.calls("editMessageText").map((c) => c.params.text);

test("the bridge says it takes landing requests: its owner-only status, read by the own member's sessions", async (t) => {
  const s = await setup(t);
  await until(async () => (await s.cli.client.list({ status: true })).some((p) => p.name === "me-owner" && p.status === BRIDGE_STATUS), 4000, "the bridge's status");
});

test("a landing card: Land, Reject and Show diff; the diff as a .patch; Land sends one signed decision to the lead; the first decision wins", async (t) => {
  const s = await setup(t);
  const m = sampleManifest();
  const q = await s.request(m);
  await until(() => s.tg.landingCards().length === 1, 4000, "landing card");
  const card = s.tg.landingCards()[0];
  assert.equal(card.params.chat_id, OWNER_CHAT);
  const at = new Date(Date.parse(m.expires_at)).toISOString().slice(11, 16);
  assert.equal(
    card.params.text,
    `🛬 Landing L7 · lead asks you to decide:\nn11: Validate the settings\n→ main in app, checked out there (fast-forwarded)\nTests: pass (1 command, as the lead reports)\nReview: rev-1 approve\n1 file changed, 1 insertion(+), 1 deletion(-)\n\nThe test result and the review come from agents: they are claims, not proof.\nDecide by ${at} UTC. Land moves the branch as shown; Reject moves nothing.`,
  );
  assert.deepEqual(textProblems(card.params.text), []);
  const rows = card.params.reply_markup.inline_keyboard;
  assert.deepEqual(rows.map((r) => r.map((b) => b.text)), [["Land L7", "Reject"], ["Show diff"]]);
  for (const b of rows.flat()) {
    assert.match(b.callback_data, /^g:[a-z2-7]{12}:[lrd]$/);
    assert.equal(b.callback_data.includes(q.slice(0, 8)), false);
  }
  // Show diff: the frozen patch, as a document, in the same chat.
  s.tg.press(card, 0, { data: rows[1][0].callback_data });
  await until(() => s.tg.calls("sendDocument").length === 1, 4000, "the diff");
  const doc = s.tg.calls("sendDocument")[0].params;
  assert.equal(doc.chat_id, OWNER_CHAT);
  assert.equal(doc.document.name, "L7.patch");
  assert.equal(Buffer.from(doc.document.bytes).toString("utf8"), PATCH);
  // Land: one signed decision to the lead's session, in reply to the request.
  s.tg.press(card, 0, { data: rows[0][0].callback_data });
  const got = await s.lead.waitFor((x) => x.from === "me-owner");
  assert.equal(got.reply_to, q);
  const v = verifyAt(s.key, "me-lead")(got);
  assert.equal(v.ok, true, v.reason);
  assert.equal(v.env.kind, "landing_decision");
  assert.equal(v.env.q, q);
  const d = parseDecision(v.env.text);
  assert.equal(d.decision, "land");
  assert.equal(d.digest, digestOf(m));
  assert.equal(d.id, "L7");
  assert.equal(d.expires_at, Date.parse(m.expires_at));
  assert.ok(d.decided_at <= d.expires_at);
  assert.equal(v.env.ts, d.decided_at, "signed at the tap");
  await until(() => acks(s.tg).includes("✅ Sent: land."), 4000, "ack");
  await until(() => edits(s.tg).some((x) => x.startsWith("✅ Landing L7 · lead\n") && x.endsWith("You chose: Land. lead carries it out now and reports back here.")), 4000, "card closed");
  // Reject afterwards, Show diff afterwards and a reply: nothing more is sent.
  s.tg.press(card, 0, { data: rows[0][1].callback_data });
  await until(() => acks(s.tg).includes("This landing was already decided."), 4000, "late tap");
  await sleep(150);
  assert.equal(s.lead.got.filter((x) => x.from === "me-owner").length, 1, "one decision");
  // The lead's outcome: the card shows it, and one line follows it.
  await s.cli.client.send("me-owner", landingStatusText({ digest: digestOf(m), state: "landed", text: "L7 landed on main." }), 600, undefined, { toMember: ME });
  await until(() => s.tg.texts().includes("✅ L7 landed on main."), 4000, "outcome line");
  await until(() => edits(s.tg).some((x) => x.endsWith("reports back here.\n\n✅ L7 landed on main.")), 4000, "card shows the outcome");
  for (const x of [...s.tg.texts(), ...edits(s.tg), ...acks(s.tg).filter(Boolean)]) assert.deepEqual(textProblems(x), [], x);
  assert.equal(s.bridge.state().outbox.length, 0);
  assert.equal(s.bridge.state().questions[q].status, "answered");
});

test("Reject: a signed reject decision; an oversize patch has no Show diff; a reply to the card decides nothing", async (t) => {
  const s = await setup(t);
  const m = sampleManifest({ oversize: true, mode: { kind: "ref" } });
  await s.request(m);
  await until(() => s.tg.landingCards().length === 1, 4000, "landing card");
  const card = s.tg.landingCards()[0];
  assert.match(card.params.text, /→ main in app \(branch only, not checked out\)\n/);
  assert.match(card.params.text, /\nThe diff is too large to show here; review it on the Mac\.\n/);
  assert.deepEqual(card.params.reply_markup.inline_keyboard.map((r) => r.map((b) => b.text)), [["Land L7", "Reject"]]);
  s.tg.say("land it", { reply: s.tg.replyTo(card) });
  await until(() => s.tg.texts().includes("Use the Land or Reject button on the card to decide this landing."), 4000, "reply refused");
  s.tg.press(card, 0, { data: card.params.reply_markup.inline_keyboard[0][1].callback_data });
  const got = await s.lead.waitFor((x) => x.from === "me-owner");
  assert.equal(parseDecision(verifyAt(s.key, "me-lead")(got).env.text).decision, "reject");
  await until(() => edits(s.tg).some((x) => x.endsWith("You chose: Reject. Nothing is moved.")), 4000, "card closed");
});

test("expiry at the tap: a Land after the request expired sends no decision; the lead gets an expired status", async (t) => {
  const s = await setup(t); // tickMs is a minute here: only the tap can see the expiry
  const m = sampleManifest({ ttl: 1500 });
  await s.request(m);
  await until(() => s.tg.landingCards().length === 1, 4000, "landing card");
  const card = s.tg.landingCards()[0];
  await until(() => Date.now() > Date.parse(m.expires_at) + 50, 4000, "expiry");
  s.tg.press(card, 0);
  await until(() => acks(s.tg).includes("This landing request has expired; nothing was moved."), 4000, "expired ack");
  const st = await s.lead.waitFor((x) => x.from === "me-owner");
  const v = verifyAt(s.key, "me-lead")(st);
  assert.equal(v.env.kind, "status");
  assert.match(v.env.text, /^expired: your landing request .* for L7 was not decided before /);
  await until(() => edits(s.tg).some((x) => x.startsWith("⌛ Landing L7 · lead · Closed\n") && x.endsWith("The deadline passed. Nothing was moved.")), 4000, "card closed");
  await sleep(150);
  assert.equal(s.lead.got.some((x) => verifyAt(s.key, "me-lead")(x)?.env?.kind === "landing_decision"), false);
});

test("requests the bridge does not take: malformed evidence, another member's sender, a recipient of another member, a repeat", async (t) => {
  const s = await setup(t);
  const bad = sampleManifest();
  bad.evidence.patch.text += "+more\n";
  await s.cli.client.send("me-owner", canonicalize({ hoptell_owner_landing: 1, manifest: bad }), 900, undefined, { toMember: ME });
  const bob = await agent(t, s.url, s.tokens.bob, "bob-cli");
  await bob.client.send("me-owner", landingRequest(sampleManifest({ id: "L8" })), 900).catch(() => {});
  await s.request(sampleManifest({ id: "L9", member: BOB }));
  const ok = sampleManifest({ id: "L10" });
  await s.request(ok);
  await s.request(ok);
  await until(() => s.tg.landingCards().length === 1, 4000, "one card");
  await sleep(300);
  assert.equal(s.tg.landingCards().length, 1);
  assert.match(s.tg.landingCards()[0].params.text, /^🛬 Landing L10 /);
  const drops = s.bridge.state().drops;
  assert.equal(drops.landing_malformed, 1);
  assert.equal(drops.landing_not_own, 1);
  assert.equal(drops.landing_again, 1);
  // Nothing of these is shown raw as a note.
  assert.equal(s.tg.texts().some((x) => x.includes("hoptell_owner_landing")), false);
});

test("a decision is signed once: after a crash right after its send, the restarted bridge sends exactly the same bytes", async (t) => {
  const { url, tokens } = await ownerRelay(t);
  const home = tmpHome(t);
  paired(home);
  const tg = fakeTelegram();
  const key = newKey();
  let crash = true;
  const fault = (p) => {
    if (p === "sent" && crash) {
      crash = false;
      throw new Crash(p);
    }
  };
  const a = bridgeOn(t, { home, telegram: tg.client("a"), url, token: tokens.me, key, fault });
  await until(() => a.bridge.leading(), 4000, "leadership");
  const lead = await agent(t, url, tokens.me, "me-lead");
  const cli = await agent(t, url, tokens.me, "me-cli-1");
  await cli.client.send("me-owner", landingRequest(sampleManifest()), 900, undefined, { toMember: ME });
  await until(() => tg.landingCards().length === 1, 4000, "landing card");
  tg.press(tg.landingCards()[0], 0);
  const r = await a.run;
  assert.equal(r.code, "crashed");
  await sleep(1100); // a later run signs at another millisecond if it signed again
  const b = bridgeOn(t, { home, telegram: tg.client("b"), url, token: tokens.me, key });
  await until(() => b.bridge.state?.()?.outbox?.length === 0 && lead.got.filter((x) => x.from === "me-owner").length >= 2, 6000, "the decision sent again");
  const sent = lead.got.filter((x) => x.from === "me-owner").map((x) => x.text);
  assert.equal(new Set(sent).size, 1, "the same signed bytes");
});

test("the card names the repository by its folder, never a path or a commit id; two repositories of the same name are told apart", async (t) => {
  const s = await setup(t);
  const C = "c".repeat(40);
  await s.request(sampleManifest({ id: "L7", mode: { kind: "ref" }, commands: [`git -C /srv/src/app diff ${C}`, "npm test"] }));
  await s.request(sampleManifest({ id: "L8", mode: { kind: "ref" }, common: "/home/dana/work/app/.git" }));
  await until(() => s.tg.landingCards().length === 2, 4000, "two cards");
  const [one, two] = s.tg.landingCards().map((c) => c.params.text);
  assert.match(one, /\n→ main in app \(branch only, not checked out\)\nTests: pass \(2 commands, as the lead reports\)\n/);
  assert.match(two, /\n→ main in app \(in work\) \(branch only, not checked out\)\n/);
  for (const text of [one, two]) {
    assert.doesNotMatch(text, /\/[\w.-]+\//, "no path segments");
    assert.doesNotMatch(text, /[0-9a-f]{40}/, "no commit ids");
    assert.deepEqual(textProblems(text), []);
  }
});

test("a decision that cannot be delivered: the card says so in its own words; nothing is moved", async (t) => {
  const s = await setup(t);
  await s.request(sampleManifest({ lead: "me-ghost" }));
  await until(() => s.tg.landingCards().length === 1, 4000, "landing card");
  s.tg.press(s.tg.landingCards()[0], 0);
  await until(() => edits(s.tg).some((x) => x.startsWith("⚠️ Landing L7 · ghost\n") && /\n\nYour decision could not be delivered: .+\. Nothing was moved\.$/.test(x)), 6000, "undelivered view");
  for (const x of edits(s.tg)) assert.deepEqual(textProblems(x), [], x);
});

test("a checkout in a separate folder is named on the card; commit ids inside branch names are shortened on the card and in the outcome", async (t) => {
  const s = await setup(t);
  const m = sampleManifest({ target: "fix_deadbeef", mode: { kind: "checkout", worktree: "/srv/wt/release", gitDir: "/srv/src/app/.git/worktrees/release" } });
  await s.request(m);
  await until(() => s.tg.landingCards().length === 1, 4000, "landing card");
  const card = s.tg.landingCards()[0].params.text;
  assert.match(card, /\n→ fix_… in app, checked out in release, a separate checkout \(fast-forwarded\)\n/);
  assert.doesNotMatch(card, /deadbeef/);
  await s.cli.client.send("me-owner", landingStatusText({ digest: digestOf(m), state: "landed", text: "L7 landed." }), 600, undefined, { toMember: ME });
  await until(() => s.tg.texts().some((x) => x.startsWith("✅ L7")), 4000, "outcome line");
  const line = s.tg.texts().find((x) => x.startsWith("✅ L7"));
  assert.match(line, /fix_…/);
  // The same in a name joined by "-", which the outcome showed whole before.
  const n = sampleManifest({ id: "L8", target: "fix-deadbeef", mode: { kind: "ref" }, now: Date.now() + 1 });
  await s.request(n);
  await until(() => s.tg.landingCards().length === 2, 4000, "second card");
  await s.cli.client.send("me-owner", landingStatusText({ digest: digestOf(n), state: "landed", text: "L8 landed." }), 600, undefined, { toMember: ME });
  await until(() => s.tg.texts().some((x) => x.startsWith("✅ L8")), 4000, "outcome line");
  assert.match(s.tg.texts().find((x) => x.startsWith("✅ L8")), /fix-…/);
  for (const x of [...s.tg.texts(), ...edits(s.tg)]) {
    assert.doesNotMatch(x, /deadbeef/, x);
    assert.deepEqual(textProblems(x), [], x);
  }
});

// ---- auto-land (design 8 addendum, option 6; L3b-2a) ----------------------------------------------

test("auto-land shapes: the recipient's generation, the request's reasons, the Mac's report", () => {
  const m = sampleManifest();
  const g = { ...m, recipient: { ...m.recipient, generation: 3 } };
  assert.equal(manifestProblem(g), null);
  assert.equal(manifestProblem({ ...m, recipient: { ...m.recipient, generation: -1 } }), "recipient");
  assert.equal(parseLandingRequest(landingRequest(g)).auto, null);
  assert.deepEqual(parseLandingRequest(landingRequest(g, { why: ["tests_failed", "changes"] })).auto, ["tests_failed", "changes"]);
  assert.throws(() => landingRequest(g, { why: ["because"] }), /malformed/);
  assert.match(parseLandingRequest(canonicalize({ auto: { why: [] }, hoptell_owner_landing: 1, manifest: g })).problem, /auto-land/);
  const r = { ref: "g_abcdefghijklmnop", state: "refused", why: "stale", team: "web", targets: ["main"], left_s: null, teams: [] };
  assert.deepEqual(parseAutolandStatus(autolandStatusText(r)), r);
  const off = { ref: "v_abcdefghijklmnop", state: "off", why: null, team: null, targets: [], left_s: null, teams: ["n4", "n5"] };
  assert.deepEqual(parseAutolandStatus(autolandStatusText(off)), off);
  assert.throws(() => autolandStatusText({ ...off, ref: "g_abcdefghijklmnop" }), /not an auto-land report/);
  assert.throws(() => autolandStatusText({ ...r, teams: ["n4"] }), /not an auto-land report/);
  assert.deepEqual(parseRevoke(revokeText({ id: "v_abcdefghijklmnop", issuedAt: 5 })), { id: "v_abcdefghijklmnop", issued_at: 5 });
  assert.equal(parseRevoke('{"hoptell_landing_revoke":1,"id":"g_abcdefghijklmnop","issued_at":5}'), null);
  assert.throws(() => autolandStatusText({ ...r, why: "because" }), /not an auto-land report/);
  assert.equal(parseAutolandStatus(JSON.stringify({ hoptell_owner_autoland_status: 1, ...r }, null, 1)), null, "only the canonical text");
  assert.deepEqual(JSON.parse(BRIDGE_STATUS).caps, ["landing", "autoland"]);
});

test("Land this and auto-land: one tap, the decision and then a signed grant for the team; the Mac's report and the auto-land notices are posted once each", async (t) => {
  const s = await setup(t);
  const base = sampleManifest();
  const m = { ...base, recipient: { ...base.recipient, generation: 2 } };
  const q = (await s.cli.client.send("me-owner", landingRequest(m, { why: ["changes"] }), 900, undefined, { toMember: ME })).message_id;
  await until(() => s.tg.landingCards().length === 1, 4000, "landing card");
  const card = s.tg.landingCards()[0];
  assert.match(card.params.text, /\nWhy it wasn't auto-landed: a reviewer asked for changes\.\n\n/);
  const rows = card.params.reply_markup.inline_keyboard;
  assert.deepEqual(rows.map((r) => r.map((b) => b.text)), [["Land L7", "Reject"], ["Land this and auto-land web for 2 h"], ["Show diff"]]);
  const before = Date.now();
  s.tg.press(card, 0, { data: rows[1][0].callback_data });
  await until(() => s.lead.got.filter((x) => x.from === "me-owner").length === 2, 4000, "two messages");
  const [d, g] = s.lead.got.filter((x) => x.from === "me-owner").map(verifyAt(s.key, "me-lead"));
  assert.equal(d.ok && g.ok, true);
  assert.equal(d.env.kind, "landing_decision");
  assert.equal(parseDecision(d.env.text).decision, "land");
  assert.equal(g.env.kind, "landing_grant");
  assert.equal(g.env.q, q);
  const scope = parseGrant(g.env.text);
  assert.ok(scope, "a valid grant");
  assert.deepEqual({ ...scope, id: "x", issued_at: 0, not_before: 0, expires_at: 0 }, { hoptell_landing_grant: 1, id: "x", team: "web", run: m.run, generation: 2, enrolment: m.enrolment, recipient: { lead: "me-lead", member: ME }, targets: ["main"], issued_at: 0, not_before: 0, expires_at: 0, max_count: null, op: "land", origin: digestOf(m) });
  assert.ok(scope.issued_at >= before && scope.not_before === scope.issued_at && scope.expires_at === scope.issued_at + 2 * 60 * 60_000);
  assert.equal(g.env.ts, scope.issued_at, "signed at the tap");
  await until(() => acks(s.tg).includes("✅ Sent: land, and auto-land for 2 h."), 4000, "ack");
  await until(() => edits(s.tg).some((x) => x.endsWith("You chose: Land, and auto-land web for 2 h. lead carries it out now and reports back here.")), 4000, "card closed");
  // The Mac's report: one line, answering the card; a repeat under another reference shows nothing.
  const report = autolandStatusText({ ref: scope.id, state: "on", why: null, team: "web", targets: ["main"], left_s: 7200 });
  await s.cli.client.send("me-owner", report, 600, undefined, { toMember: ME });
  await s.cli.client.send("me-owner", report, 600, undefined, { toMember: ME });
  await until(() => s.tg.texts().includes("🤖 Auto-land on: team web, main, 2 h."), 4000, "the report");
  const refused = autolandStatusText({ ref: "g_abcdefghijklmnop", state: "refused", why: "stale", team: "web", targets: ["main"], left_s: null });
  await s.cli.client.send("me-owner", refused, 600, undefined, { toMember: ME });
  await until(() => s.tg.texts().some((x) => x.startsWith("⚠️ Auto-land for team web not turned on")), 4000, "a refusal");
  assert.ok(s.tg.texts().includes("⚠️ Auto-land for team web not turned on: it was given before auto-land was last turned off; give it again from a newer card or in a terminal."));
  // The notices of auto-landings: a new message each, once per action and state.
  const n = { digest: "e".repeat(64), id: "L9", team: "web", target: "main", state: "landed", left_s: 4800 };
  await s.cli.client.send("me-owner", noticeText(n), 600, undefined, { toMember: ME });
  await s.cli.client.send("me-owner", noticeText(n), 600, undefined, { toMember: ME });
  await s.cli.client.send("me-owner", noticeText({ ...n, state: "blocked", left_s: null }), 600, undefined, { toMember: ME });
  await until(() => s.tg.texts().some((x) => x.startsWith("⚠️ L9")), 4000, "the blocked notice");
  await sleep(200);
  const texts = s.tg.texts();
  assert.equal(texts.filter((x) => x === "🤖 Auto-land on: team web, main, 2 h.").length, 1);
  assert.equal(texts.filter((x) => x === "🤖 L9 landed on main under your auto-land for team web (1 h 20 min left).").length, 1);
  assert.ok(texts.includes("⚠️ L9 (auto-land, team web) is blocked; check its state on the Mac."));
  for (const x of [...texts, ...edits(s.tg), ...acks(s.tg).filter(Boolean)]) assert.deepEqual(textProblems(x), [], x);
  assert.equal(s.bridge.state().outbox.length, 0);
});

test("no auto-land button for a lead that does not name its generation, and Land alone sends no grant", async (t) => {
  const s = await setup(t);
  await s.request(sampleManifest());
  await until(() => s.tg.landingCards().length === 1, 4000, "landing card");
  const card = s.tg.landingCards()[0];
  assert.equal(card.params.text.includes("auto-land"), false);
  assert.equal(card.params.reply_markup.inline_keyboard.flat().some((b) => b.callback_data.endsWith(":a")), false);
  s.tg.press(card, 0, { data: card.params.reply_markup.inline_keyboard[0][0].callback_data.replace(/:l$/, ":a") });
  await until(() => acks(s.tg).length === 1, 4000, "ack");
  await sleep(200);
  assert.equal(s.lead.got.filter((x) => x.from === "me-owner").length, 0, "nothing sent for a forged auto-land tap");
});

test("auto-land reports and notices that arrive while unpaired are held, once each, and posted after pairing", async (t) => {
  const s = await setup(t, { unpaired: true });
  const send = (text) => s.cli.client.send("me-owner", text, 600, undefined, { toMember: ME });
  const n = { digest: "e".repeat(64), id: "L9", team: "web", target: "main", state: "landed", left_s: 4800 };
  const report = autolandStatusText({ ref: "g_abcdefghijklmnop", state: "on", why: null, team: "web", targets: ["main"], left_s: 7200 });
  await send(noticeText(n));
  await send(noticeText(n));
  await send(report);
  await until(() => (s.bridge.state().autoland_pending ?? []).length === 2 && s.bridge.state().drops.autoland_again === 1, 4000, "held once each");
  assert.equal(s.tg.sent.filter((x) => x.method === "sendMessage").length, 0, "nothing posted unpaired");
  paired(s.home);
  // The next message the bridge handles finds the pairing; a repeat of a held line adds nothing.
  await send(noticeText(n));
  await until(() => s.tg.texts().includes("🤖 Auto-land on: team web, main, 2 h."), 4000, "posted after pairing");
  await sleep(200);
  const texts = s.tg.texts();
  assert.deepEqual(texts, ["🤖 L9 landed on main under your auto-land for team web (1 h 20 min left).", "🤖 Auto-land on: team web, main, 2 h."]);
  assert.deepEqual(s.bridge.state().autoland_pending, []);
  assert.equal(s.bridge.state().outbox.length, 0);
});

test("an auto-land line Telegram refuses (the owner blocked the bot) stays held and is posted on a later try, a direct post and a held one alike", async (t) => {
  let clock = Date.now();
  const s = await setup(t, { unpaired: true, now: () => clock });
  const send = (text) => s.cli.client.send("me-owner", text, 600, undefined, { toMember: ME });
  const n = { digest: "e".repeat(64), id: "L9", team: "web", target: "main", state: "landed", left_s: null };
  const report = autolandStatusText({ ref: "g_abcdefghijklmnop", state: "on", why: null, team: "web", targets: ["main"], left_s: 7200 });
  // Held while unpaired; then paired, with the bot blocked: both tries refused, both kept.
  await send(noticeText(n));
  await until(() => (s.bridge.state().autoland_pending ?? []).length === 1, 4000, "held");
  paired(s.home);
  s.tg.failWhen = (method, p) => (method === "sendMessage" && p.text.startsWith("🤖") ? 403 : 0);
  await send(report); // a direct post, and the reconcile posts the held one
  await until(() => s.tg.attempts.filter((a) => a.params.text?.startsWith("🤖")).length === 2, 4000, "two refused tries");
  await until(() => s.bridge.state().outbox.length === 0, 4000, "settled");
  assert.deepEqual(s.bridge.state().autoland_pending.map((h) => h.k), [`notice:${n.digest}:landed`, `autoland:g_abcdefghijklmnop:on:me-cli-1|${ME}`]);
  assert.equal(s.tg.texts().length, 0);
  // Unblocked: a message before the retry time tries nothing; one after it posts both, once each.
  s.tg.failWhen = null;
  await send(noticeText(n));
  await sleep(200);
  assert.equal(s.tg.texts().length, 0, "not before the retry time");
  clock += 61_000;
  await send(report);
  await until(() => s.tg.texts().length === 2, 4000, "both posted");
  assert.deepEqual(s.tg.texts(), ["🤖 L9 landed on main under your auto-land for team web.", "🤖 Auto-land on: team web, main, 2 h."]);
  assert.deepEqual(s.bridge.state().autoland_pending, []);
  await send(report);
  await sleep(200);
  assert.equal(s.tg.texts().length, 2, "shown once");
});

test("held auto-land lines belong to the Telegram account they came under: another account pairing later never sees them; the same account paired again gets them", async (t) => {
  const report = autolandStatusText({ ref: "g_abcdefghijklmnop", state: "on", why: null, team: "web", targets: ["main"], left_s: 7200 });
  const n = { digest: "e".repeat(64), id: "L9", team: "web", target: "main", state: "landed", left_s: null };
  const refusedUnder = async (s) => {
    s.tg.failWhen = (method, p) => (method === "sendMessage" && p.text.startsWith("🤖") ? 403 : 0);
    await s.cli.client.send("me-owner", report, 600, undefined, { toMember: ME });
    await until(() => s.tg.attempts.some((a) => a.params.text?.startsWith("🤖")), 4000, "refused");
    await until(() => s.bridge.state().outbox.length === 0, 4000, "settled");
    assert.equal(s.bridge.state().autoland_pending.length, 1);
    s.tg.failWhen = null;
  };
  // Account A's line, refused; then account B pairs: B gets its own line, never A's.
  let clock = Date.now();
  const s = await setup(t, { now: () => clock });
  await refusedUnder(s);
  paired(s.home, { user: 222, chat: 222, id: "p_bbbbbbbbbbbbbbbb" });
  clock += 61_000;
  await s.cli.client.send("me-owner", noticeText(n), 600, undefined, { toMember: ME });
  await until(() => s.tg.texts().length === 1, 4000, "B's own line");
  await sleep(200);
  assert.deepEqual(s.tg.calls("sendMessage").map((c) => [c.params.chat_id, c.params.text]), [[222, "🤖 L9 landed on main under your auto-land for team web."]]);
  // A's line waits for A (nothing moved), never sent to B.
  assert.deepEqual(s.bridge.state().autoland_pending.map((h) => [h.k, h.owner]), [[`autoland:g_abcdefghijklmnop:on:me-cli-1|${ME}`, OWNER_USER]]);
  // The same account paired again (a new pairing, a new chat): its held line is shown there.
  let clock2 = Date.now();
  const u = await setup(t, { now: () => clock2 });
  await refusedUnder(u);
  paired(u.home, { id: "p_cccccccccccccccc", chat: 333 });
  clock2 += 61_000;
  await u.cli.client.send("me-owner", noticeText(n), 600, undefined, { toMember: ME });
  await until(() => u.tg.texts().length === 2, 4000, "both lines");
  assert.deepEqual(u.tg.calls("sendMessage").map((c) => [c.params.chat_id, c.params.text, c.params.reply_parameters ?? null]), [
    [333, "🤖 Auto-land on: team web, main, 2 h.", null],
    [333, "🤖 L9 landed on main under your auto-land for team web.", null],
  ]);
  assert.deepEqual(u.bridge.state().autoland_pending, []);
});

test("a line kept for an earlier account: a copy sent again while another account is paired is taken and not shown; that account paired again sees it once", async (t) => {
  let clock = Date.now();
  const s = await setup(t, { now: () => clock });
  const send = (text) => s.cli.client.send("me-owner", text, 600, undefined, { toMember: ME });
  const K = { digest: "e".repeat(64), id: "L9", team: "web", target: "main", state: "landed", left_s: null };
  const k = `notice:${K.digest}:landed`;
  // A's line K, refused by Telegram (403) and held; the Mac does not know the bridge took it.
  s.tg.failWhen = (method, p) => (method === "sendMessage" && p.text.startsWith("🤖") ? 403 : 0);
  await send(noticeText(K));
  await until(() => s.tg.attempts.some((a) => a.params.text?.startsWith("🤖")), 4000, "refused");
  await until(() => s.bridge.state().outbox.length === 0, 4000, "settled");
  s.tg.failWhen = null;
  // Account B pairs: K is kept apart for A.
  paired(s.home, { user: 222, chat: 222, id: "p_bbbbbbbbbbbbbbbb" });
  clock += 61_000;
  const own = { ...K, digest: "f".repeat(64), id: "L10" };
  await send(noticeText(own));
  await until(() => s.tg.texts().length === 1, 4000, "B's own line");
  assert.deepEqual(s.bridge.state().autoland_pending.map((h) => [h.k, h.owner]), [[k, OWNER_USER]]);
  // The Mac sends K again (a new reference): taken, so the Mac settles it, and nothing reaches B.
  const ack = await send(noticeText(K));
  assert.equal(ack.state, "delivered");
  await until(() => s.bridge.state().drops.autoland_other_owner === 1, 4000, "counted");
  await sleep(200);
  assert.deepEqual(s.tg.calls("sendMessage").map((c) => [c.params.chat_id, c.params.text]), [[222, "🤖 L10 landed on main under your auto-land for team web."]]);
  // A pairs again: K is shown to A, once, and the kept copy is gone.
  paired(s.home, { id: "p_cccccccccccccccc" });
  await send(noticeText(own)); // any message: the bridge finds the new pairing
  await until(() => s.tg.texts().length === 2, 4000, "K for A");
  await sleep(200);
  assert.deepEqual(s.tg.calls("sendMessage").map((c) => [c.params.chat_id, c.params.text]).slice(1), [[OWNER_CHAT, "🤖 L9 landed on main under your auto-land for team web."]]);
  assert.deepEqual(s.bridge.state().autoland_pending, []);
});

/** Send `texts` to the bridge from several connections (the relay takes 30 messages per 10 s per connection). */
async function sendMany(t, s, texts) {
  const per = 25;
  const clis = [];
  for (let i = 0; i * per < texts.length; i++) clis.push(await agent(t, s.url, s.tokens.me, `me-bulk-${i + 1}`));
  await Promise.all(clis.map(async (c, j) => {
    for (const text of texts.slice(j * per, j * per + per)) await c.client.send("me-owner", text, 600, undefined, { toMember: ME });
  }));
}
const bulkNotice = (i) => noticeText({ digest: i.toString(16).padStart(64, "0"), id: `L${1000 + i}`, team: "web", target: "main", state: "landed", left_s: null });

test("one list of pending auto-land lines: an account that returns while another account's 200 lines wait gets its line without a resend", async (t) => {
  let clock = Date.now();
  const s = await setup(t, { tickMs: 200, now: () => clock });
  const K = { digest: "e".repeat(64), id: "L9", team: "web", target: "main", state: "landed", left_s: null };
  // A's K, refused (403): pending for A.
  s.tg.failWhen = (method, p) => (method === "sendMessage" && p.text.startsWith("🤖") ? 403 : 0);
  await s.cli.client.send("me-owner", noticeText(K), 600, undefined, { toMember: ME });
  await until(() => s.tg.attempts.some((a) => a.params.text?.startsWith("🤖 L9")), 4000, "refused");
  // B pairs; its 200 lines are refused too and wait.
  paired(s.home, { user: 222, chat: 222, id: "p_bbbbbbbbbbbbbbbb" });
  await sendMany(t, s, Array.from({ length: 200 }, (_, i) => bulkNotice(i + 1)));
  await until(() => s.bridge.state().autoland_pending.filter((h) => h.owner === 222).length === 200, 15000, "B's 200 pending");
  assert.equal(s.tg.texts().length, 0);
  // A returns (a new pairing): the tick finds it, and K is posted to A, nothing of B's.
  s.tg.failWhen = null;
  clock += 61_000; // past K's retry time
  paired(s.home, { id: "p_cccccccccccccccc" });
  await until(() => s.tg.texts().length === 1, 4000, "K for A");
  await sleep(300);
  assert.deepEqual(s.tg.calls("sendMessage").map((c) => [c.params.chat_id, c.params.text]), [[OWNER_CHAT, "🤖 L9 landed on main under your auto-land for team web."]]);
  assert.equal(s.bridge.state().autoland_pending.length, 200, "B's lines wait for B");
});

test("more than 200 of one account's pending lines all go out once it pairs, a batch at a time", async (t) => {
  const s = await setup(t, { unpaired: true, tickMs: 200 });
  await sendMany(t, s, Array.from({ length: 230 }, (_, i) => bulkNotice(i + 1)));
  await until(() => (s.bridge.state().autoland_pending ?? []).length === 230, 15000, "230 pending");
  paired(s.home);
  await until(() => s.tg.texts().length === 230, 20000, "all 230 posted");
  assert.equal(new Set(s.tg.texts()).size, 230, "each once");
  assert.equal(s.tg.texts()[0], "🤖 L1001 landed on main under your auto-land for team web.", "oldest first");
  assert.deepEqual(s.bridge.state().autoland_pending, []);
});

// ---- /autoland and /autoland off (L3b-2b) ---------------------------------------------------------

const withGeneration = (m, generation = 2) => ({ ...m, recipient: { ...m.recipient, generation } });
const offerCards = (tg) => tg.calls("sendMessage").filter((c) => /^🤖 Auto-land for team /.test(c.params.text));

test("/autoland offers the teams of recent requests (lead, team and run), every target asked for, and grants 2 h from a confirmation; Cancel sends nothing", async (t) => {
  let clock = Date.now();
  const s = await setup(t, { now: () => clock });
  s.tg.say("/autoland");
  await until(() => s.tg.texts().some((x) => x.startsWith("No team asked you")), 4000, "none yet");
  // Two requests of the same team run (main, then release), and one of a lead without a generation.
  await s.request(withGeneration(sampleManifest({ id: "L7", now: clock })));
  const q2 = await s.request(withGeneration(sampleManifest({ id: "L8", target: "release", now: clock }), 3));
  await s.request(sampleManifest({ id: "L9", lead: "me-other", now: clock }));
  await until(() => s.tg.landingCards().length === 3, 4000, "three cards");
  s.tg.say("/autoland");
  await until(() => offerCards(s.tg).length === 1, 4000, "one offer");
  const offer = offerCards(s.tg)[0];
  assert.equal(offer.params.text, "🤖 Auto-land for team web in app?\nBranches: main, release\nFor 2 h, with no limit on the number of landings: the lead lands reviewed and tested work without asking you. The reviewers' verdicts and the lead's test report come from agents.");
  assert.deepEqual(offer.params.reply_markup.inline_keyboard[0].map((b) => b.text), ["Grant for 2 h", "Cancel"]);
  // Cancel: nothing sent.
  s.tg.press(offer, 0, { data: offer.params.reply_markup.inline_keyboard[0][1].callback_data });
  await until(() => edits(s.tg).includes("Cancelled. Nothing was sent."), 4000, "cancelled");
  // Again, and Grant: a signed grant for the latest generation, both targets, 2 h, in reply to the latest request.
  s.tg.say("/autoland");
  await until(() => offerCards(s.tg).length === 2, 4000, "second offer");
  const again = offerCards(s.tg)[1];
  s.tg.press(again, 0);
  const got = await s.lead.waitFor((x) => x.from === "me-owner" && verifyAt(s.key, "me-lead")(x).env?.kind === "landing_grant");
  const v = verifyAt(s.key, "me-lead")(got);
  assert.equal(v.ok, true);
  assert.equal(v.env.q, q2);
  const scope = parseGrant(v.env.text);
  assert.deepEqual([scope.team, scope.targets, scope.generation, scope.origin, scope.max_count, scope.expires_at - scope.issued_at, scope.issued_at], ["web", ["main", "release"], 3, null, null, 2 * 60 * 60_000, clock]);
  await until(() => edits(s.tg).includes("🤖 Sent: auto-land for team web, 2 h. The Mac confirms it here."), 4000, "sent");
  // The same button again, or an offer more than 24 h after its request: nothing more is sent.
  clock += 24 * 3600_000 - 5 * 60_000;
  s.tg.say("/autoland");
  await until(() => offerCards(s.tg).length === 3, 4000, "third offer");
  clock += 6 * 60_000; // the button is still open; its request is now over 24 h old
  s.tg.press(offerCards(s.tg)[2], 0);
  await until(() => acks(s.tg).includes("This team's last request is more than 24 hours old; nothing was sent. Send /autoland again."), 4000, "too old");
  s.tg.press(again, 0);
  await sleep(200);
  assert.equal(s.lead.got.filter((x) => x.from === "me-owner" && verifyAt(s.key, "me-lead")(x).env?.kind === "landing_grant").length, 1);
  for (const x of [...s.tg.texts(), ...edits(s.tg), ...acks(s.tg).filter(Boolean)]) assert.deepEqual(textProblems(x), [], x);
});

test("/autoland off: one signed revocation to each lead session seen, revocation pending until each Mac reports off; with none seen, the terminal command", async (t) => {
  const s = await setup(t);
  s.tg.say("/autoland off");
  await until(() => s.tg.texts().includes("No landing request was seen here, so there is nothing to reach; in a terminal: hoptell team autoland <team> --off"), 4000, "none seen");
  const other = await agent(t, s.url, s.tokens.me, "me-lead-2");
  await s.request(withGeneration(sampleManifest({ id: "L7" })));
  await s.request(withGeneration(sampleManifest({ id: "L8", target: "release" })));
  await s.request(withGeneration(sampleManifest({ id: "L9", lead: "me-lead-2" })));
  await until(() => s.tg.landingCards().length === 3, 4000, "three cards");
  s.tg.say("/autoland off");
  await until(() => s.tg.texts().some((x) => x.startsWith("⏳ Revocation pending")), 4000, "pending");
  assert.ok(s.tg.texts().includes("⏳ Revocation pending: auto-land turns off on each Mac that asked you to land something (2 lead sessions) once it confirms here. A Mac that is offline sees it only once it is back."));
  const revokes = (a, name) => a.got.filter((x) => x.from === "me-owner").map(verifyAt(s.key, name)).filter((v) => v.ok && v.env.kind === "landing_revoke");
  await until(() => revokes(s.lead, "me-lead").length === 1 && revokes(other, "me-lead-2").length === 1, 4000, "one revocation each");
  const r = parseRevoke(revokes(s.lead, "me-lead")[0].env.text);
  assert.ok(r, "a valid revocation");
  // Each Mac's report: shown once each, also when both report the same revocation; a report from a
  // session the revocation was not sent to is not shown.
  const off = (teams) => autolandStatusText({ ref: r.id, state: "off", why: null, team: null, targets: [], left_s: null, teams });
  await s.cli.client.send("me-owner", off(["n9"]), 600, undefined, { toMember: ME });
  for (let i = 0; i < 2; i++) {
    await s.lead.client.send("me-owner", off(["n4", "n5"]), 600, undefined, { toMember: ME });
    await other.client.send("me-owner", off(["n6"]), 600, undefined, { toMember: ME });
  }
  const offLines = () => s.tg.texts().filter((x) => x.startsWith("✅ Auto-land is off"));
  await until(() => offLines().length === 2, 4000, "off from each Mac");
  await sleep(300);
  assert.deepEqual(offLines().sort(), ["✅ Auto-land is off for every team on the Mac of lead (n4, n5).", "✅ Auto-land is off for every team on the Mac of lead-2 (n6)."]);
  for (const x of s.tg.texts()) assert.deepEqual(textProblems(x), [], x);
});

test("/autoland off past the bound of tracked revocations: a live one is never dropped (its reports are shown later), and the one over the bound is sent and says its confirmations are not shown", async (t) => {
  const s = await setup(t, { autolandOffsMax: 2 });
  await s.request(withGeneration(sampleManifest({ id: "L7" })));
  await until(() => s.tg.landingCards().length === 1, 4000, "card");
  const revokes = () => s.lead.got.filter((x) => x.from === "me-owner").map(verifyAt(s.key, "me-lead")).filter((v) => v.ok && v.env.kind === "landing_revoke").map((v) => parseRevoke(v.env.text).id);
  for (let i = 1; i <= 3; i++) {
    s.tg.say("/autoland off");
    await until(() => revokes().length === i, 4000, `revocation ${i}`);
  }
  const pendings = () => s.tg.texts().filter((x) => x.startsWith("⏳ Revocation pending"));
  await until(() => pendings().length === 3, 4000, "three replies");
  assert.deepEqual(pendings().map((x) => x.includes("\nToo many recent /autoland off here: the Macs' confirmations of this one will not be shown; it is sent all the same.")), [false, false, true]);
  assert.deepEqual(Object.keys(s.bridge.state().autoland_offs), revokes().slice(0, 2));
  // The first one's report, after two more: shown once; the untracked one's report is not shown.
  const [first, , third] = revokes();
  const off = (ref, teams) => autolandStatusText({ ref, state: "off", why: null, team: null, targets: [], left_s: null, teams });
  await s.lead.client.send("me-owner", off(third, ["n7"]), 600, undefined, { toMember: ME });
  await s.lead.client.send("me-owner", off(first, ["n4"]), 600, undefined, { toMember: ME });
  await s.lead.client.send("me-owner", off(first, ["n4"]), 600, undefined, { toMember: ME });
  await until(() => s.tg.texts().includes("✅ Auto-land is off for every team on the Mac of lead (n4)."), 4000, "first's report");
  await sleep(300);
  assert.deepEqual(s.tg.texts().filter((x) => x.startsWith("✅ Auto-land is off")), ["✅ Auto-land is off for every team on the Mac of lead (n4)."]);
  for (const x of s.tg.texts()) assert.deepEqual(textProblems(x), [], x);
});

test("an /autoland confirmation signs only what it showed: a request that arrives while it is open refreshes it and asks for a new tap", async (t) => {
  const s = await setup(t);
  await s.request(withGeneration(sampleManifest({ id: "L7" })));
  await until(() => s.tg.landingCards().length === 1, 4000, "card");
  s.tg.say("/autoland");
  await until(() => offerCards(s.tg).length === 1, 4000, "offer");
  const offer = offerCards(s.tg)[0];
  assert.match(offer.params.text, /\nBranches: main\n/);
  // Meanwhile: another target, and a newer generation.
  await s.request(withGeneration(sampleManifest({ id: "L8", target: "release" }), 3));
  await until(() => s.tg.landingCards().length === 2, 4000, "second card");
  s.tg.press(offer, 0);
  await until(() => acks(s.tg).includes("This team changed since this was shown; check the new offer and tap again."), 4000, "changed");
  const refreshed = s.tg.calls("editMessageText").find((c) => c.params.message_id === offer.message_id && c.params.reply_markup);
  assert.match(refreshed.params.text, /\nBranches: main, release\n/);
  await sleep(200);
  const grants = () => s.lead.got.filter((x) => x.from === "me-owner").map(verifyAt(s.key, "me-lead")).filter((v) => v.ok && v.env.kind === "landing_grant");
  assert.equal(grants().length, 0, "nothing signed for what was not shown");
  s.tg.press(offer, 0, { data: refreshed.params.reply_markup.inline_keyboard[0][0].callback_data });
  await until(() => grants().length === 1, 4000, "the grant");
  const scope = parseGrant(grants()[0].env.text);
  assert.deepEqual([scope.targets, scope.generation], [["main", "release"], 3]);
});

test("/autoland off reaches a lead given a grant here even after 64 newer requests pushed it out of the recent list, and says it may not reach every Mac", async (t) => {
  const s = await setup(t);
  await s.request(withGeneration(sampleManifest({ id: "L7" })));
  await until(() => s.tg.landingCards().length === 1, 4000, "card");
  const card = s.tg.landingCards()[0];
  s.tg.press(card, 0, { data: card.params.reply_markup.inline_keyboard[1][0].callback_data }); // Land this and auto-land
  await until(() => acks(s.tg).includes("✅ Sent: land, and auto-land for 2 h."), 4000, "granted");
  // 64 newer requests of other lead sessions (from several connections: the relay's rate per connection).
  const texts = Array.from({ length: 64 }, (_, i) => landingRequest(withGeneration(sampleManifest({ id: `L${100 + i}`, lead: `me-x${i}` }))));
  const clis = [];
  for (let i = 0; i < 3; i++) clis.push(await agent(t, s.url, s.tokens.me, `me-req-${i}`));
  await Promise.all(clis.map(async (c, j) => {
    for (const text of texts.slice(j * 22, j * 22 + 22)) await c.client.send("me-owner", text, 900, undefined, { toMember: ME });
  }));
  await until(() => Object.keys(s.bridge.state().autoland_seen).length === 64 && !Object.keys(s.bridge.state().autoland_seen).some((k) => k.startsWith("me-lead|")), 15000, "pushed out");
  s.tg.say("/autoland off");
  const revokes = () => s.lead.got.filter((x) => x.from === "me-owner").map(verifyAt(s.key, "me-lead")).filter((v) => v.ok && v.env.kind === "landing_revoke");
  // The command is answered after the 64 cards before it are posted (Telegram's pace per chat).
  await until(() => revokes().length === 1, 60000, "the grant's lead is reached");
  await until(() => s.tg.texts().some((x) => x.startsWith("⏳ Revocation pending") && x.endsWith("\nThis may not reach every Mac you gave auto-land to: in a terminal there, hoptell team autoland <team> --off")), 10000, "pending, may not reach every Mac");
});
