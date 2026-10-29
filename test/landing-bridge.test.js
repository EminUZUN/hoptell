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
import { APPLY_WINDOW_MS, BRIDGE_STATUS, bridgeTakesLandings, checkReceipt, decisionText, landingRequest, landingStatusText, manifestProblem, parseDecision, parseLandingRequest, parseLandingStatus, patchBytes } from "../lib/landings.js";
import { BOB, ME, OWNER_CHAT, REALM, agent, bridgeOn, fakeTelegram, newKey, ownerRelay, paired, pinOf, textProblems, tmpHome, until } from "./owner-helpers.js";
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
  const home = tmpHome(t);
  paired(home);
  const tg = fakeTelegram();
  const key = newKey();
  const b = bridgeOn(t, { home, telegram: tg.client(), url, token: tokens.me, key, ...opts });
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
