// The prompt card's manifest and the owner's signed answer (design 9, C): strict shapes, the
// options exactly as the prompt table has them, digests, and the new owner envelope kind.
import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalize } from "../lib/jcs.js";
import * as sig from "../lib/ownersig.js";
import { CARD_MS, answerText, answerableOptions, executableOptions, homeIdOf, manifestDigest, manifestProblem, parseAnswer, parsePromptRequest, promptRequestText } from "../lib/promptcards.js";

const ME = "m_mmmmmmmmmmmmmmmmmmmmmmmmmm";
const REALM = "a".repeat(32);
const T = 1_800_000_000_000;
const sampleManifest = (over = {}) => ({
  hoptell_prompt_manifest: 1,
  realm: REALM,
  profile: null,
  home: homeIdOf("/Users/x/.hoptell"),
  recipient: { member: ME, control: "me-cabcdefghij" },
  launch: "1".repeat(32),
  team: "n4",
  session: "me-alice",
  scope: { root: "/Users/x/repo", folder: "/Users/x/repo" },
  cli: { name: "codex", path: "/opt/homebrew/bin/codex", version: "0.165.0" },
  host: { pid: 4242, start: "Wed Oct 29 10:00:00 2026", uid: 501, boot: "b1" },
  tmux: { socket: "/private/tmp/tmux-501/default", session: "$3", pane: "%7" },
  subtype: "codex-startup-trust",
  options: answerableOptions("0.165.0")[0].map((o) => ({ ...o })),
  untested: false,
  selected: 1,
  dialog: "c".repeat(64),
  captured_at: T - 2000,
  created_at: T,
  expires_at: T + CARD_MS,
  nonce: "e".repeat(32),
  ...over,
});

test("the manifest: every field exact; options only as the prompt table has them for that version; at most 10 minutes", () => {
  const m = sampleManifest();
  assert.equal(manifestProblem(m), null);
  assert.equal(manifestProblem(sampleManifest({ options: answerableOptions("0.165.0")[1].map((o) => ({ ...o })) })), null, "Back to Agent Command Center");
  assert.deepEqual(answerableOptions("0.165.0").map((o) => o.map((x) => x.label)), [["Trust folder", "Quit"], ["Trust folder", "Back to Agent Command Center"]]);
  assert.deepEqual(answerableOptions("0.166.0"), []);
  const bad = {
    fields: { extra: 1 },
    realm: { realm: "x" },
    home: { home: "/Users/x" },
    recipient: { recipient: { member: ME, control: "not a name!" } },
    launch: { launch: "x" },
    team: { team: "Bad Team" },
    session: { session: "" },
    scope: { scope: { root: "relative", folder: "/x" } },
    cli: { cli: { name: "claude", path: "/x/claude", version: "0.165.0" } },
    host: { host: { pid: 1, start: "s", uid: 501, boot: "b" } },
    tmux: { tmux: { socket: "/s", session: "3", pane: "%7" } },
    subtype: { subtype: "approval" },
    options: { options: [{ key: "1", action: "trust", label: "Trust folder" }, { key: "2", action: "trust", label: "Quit" }] },
    untested: { untested: 1 },
    selected: { selected: 3 },
    dialog: { dialog: "short" },
    times: { expires_at: T + CARD_MS + 1 },
    "times ": { captured_at: T + 1 },
    "times  ": { captured_at: T - CARD_MS - 1 },
    nonce: { nonce: "E".repeat(32) },
  };
  for (const [problem, over] of Object.entries(bad)) assert.equal(manifestProblem(over.extra ? { ...m, ...over } : sampleManifest(over)), problem.trim(), problem);
  // What an answer may press: the options checked live, or all under the launch's test switch.
  assert.deepEqual(executableOptions(m).map((o) => o.label), ["Trust folder", "Quit"], "both checked live on 0.165.0");
  const unchecked = { options: m.options.map((o, i) => ({ ...o, live: i === 1 })), untested: false };
  assert.deepEqual(executableOptions(unchecked).map((o) => o.label), ["Quit"], "an option not checked live is not pressed");
  assert.deepEqual(executableOptions({ ...unchecked, untested: true }).map((o) => o.label), ["Trust folder", "Quit"], "unless the launch's test switch is on");
  assert.deepEqual(executableOptions(sampleManifest({ options: answerableOptions("0.165.0")[1].map((o) => ({ ...o })) })).map((o) => o.label), ["Trust folder", "Back to Agent Command Center"]);
  assert.equal(manifestProblem(sampleManifest({ cli: { name: "codex", path: "/x/codex", version: "0.166.0" } })), "options", "an unrecorded version has no answerable options");
  assert.equal(manifestProblem(null), "fields");
  // The key sequences and live marks are the table's: a single-digit Trust, or Trust or Quit marked not live, is refused.
  const [trust, quit] = answerableOptions("0.165.0")[0];
  const back = answerableOptions("0.165.0")[1][1];
  assert.deepEqual([trust.steps, trust.live, quit.steps, quit.live, back.steps, back.live], [[["1"], "revalidate", ["Enter"]], true, [["2"]], true, [["2"]], true]);
  assert.equal(manifestProblem(sampleManifest({ options: [{ ...trust }, { ...quit, live: false }] })), "options");
  assert.equal(manifestProblem(sampleManifest({ options: [{ ...trust, steps: [["1"]] }, { ...quit }] })), "options");
  assert.equal(manifestProblem(sampleManifest({ options: [{ ...trust, live: false }, { ...quit }] })), "options");
  assert.equal(manifestProblem(sampleManifest({ options: [{ key: "1", action: "trust", label: "Trust folder" }, { key: "2", action: "quit", label: "Quit" }] })), "options");
});

test("the request to the bridge: canonical, the digest computed from the manifest, anything else refused without throwing", () => {
  const m = sampleManifest();
  const text = promptRequestText(m);
  assert.deepEqual(parsePromptRequest(text), { manifest: m, digest: manifestDigest(m) });
  assert.match(manifestDigest(m), /^[0-9a-f]{64}$/);
  assert.notEqual(manifestDigest(sampleManifest({ dialog: "d".repeat(64) })), manifestDigest(m));
  assert.equal(parsePromptRequest("plain text"), null);
  assert.equal(parsePromptRequest('{"hoptell_wait":1}'), null);
  assert.deepEqual(parsePromptRequest(JSON.stringify({ manifest: m, hoptell_prompt: 1 })), { problem: "not canonical" });
  assert.deepEqual(parsePromptRequest(canonicalize({ hoptell_prompt: 1, manifest: { ...m, extra: 1 } })), { problem: "fields" });
  assert.deepEqual(parsePromptRequest(canonicalize({ hoptell_prompt: 2, manifest: m })), { problem: "fields" });
  assert.deepEqual(parsePromptRequest('{"hoptell_prompt":1,'), { problem: "not valid JSON" });
  const poison = { toString: null, valueOf: null };
  assert.doesNotThrow(() => parsePromptRequest(canonicalize({ hoptell_prompt: 1, manifest: { ...m, session: poison, realm: poison } })));
  assert.throws(() => promptRequestText({ ...m, subtype: "approval" }), /not a prompt manifest \(subtype\)/);
});

test("the answer: exact text, signed as its own owner envelope kind and verified like the others", () => {
  const text = answerText({ digest: "d".repeat(64), nonce: "e".repeat(32), choice: "2", issuedAt: T, resultKey: "9".repeat(64) });
  assert.equal(text, canonicalize({ hoptell_prompt_answer: 1, digest: "d".repeat(64), nonce: "e".repeat(32), choice: "2", issued_at: T, result_key: "9".repeat(64) }));
  assert.throws(() => answerText({ digest: "d".repeat(64), nonce: "e".repeat(32), choice: "2", issuedAt: T }), /result key/, "never without its result key");
  assert.deepEqual(parseAnswer(text), JSON.parse(text));
  for (const bad of [JSON.stringify({ ...JSON.parse(text), extra: 1 }), text.replace('"2"', '"x"'), text.replace('"2"', "2"), JSON.stringify(JSON.parse(text), null, 1), "{", null]) assert.equal(parseAnswer(bad), null, String(bad));
  assert.throws(() => answerText({ digest: "x", nonce: "e".repeat(32), choice: "1", issuedAt: T, resultKey: "9".repeat(64) }));
  assert.ok(sig.KINDS.includes("prompt_answer"));
  const key = sig.newKey();
  const env = sig.signEnvelope({ kind: "prompt_answer", realm: REALM, from: "me-owner", to: { name: "me-cabcdefghij", member: ME }, q: "11111111-2222-4333-8444-555555555555", text, pairing: { id: "p_abcdefghijklmnop", at: T }, ts: T, nonce: sig.nonceOf(key, ["prompt", "1", "d".repeat(64)]) }, key);
  const pin = { name: "me-owner", keys: [{ id: sig.keyIdOf(key.pub), pub: key.pub }] };
  const v = sig.verifyEnvelope(env, { pin, realm: REALM, sender: "me-owner", me: { name: "me-cabcdefghij", member: ME }, now: T });
  assert.equal(v.ok, true);
  assert.equal(v.env.kind, "prompt_answer");
  assert.equal(sig.verifyEnvelope(env, { pin, realm: REALM, sender: "me-owner", me: { name: "me-alice", member: ME }, now: T }).reason, "not addressed to this session", "the control name only");
});
