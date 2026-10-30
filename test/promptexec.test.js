// The owner's answer to a prompt card, carried out by the injector (design 9, C): verified, bound
// to the injector's own target, taken once, recorded before any key, pressed only through the
// option's steps and only while the press checks hold; its report kept until the bridge took it.
// A stand-in for Codex's trust dialog (test/fixtures/fake-codex-trust.cjs) runs in a private tmux
// server (TMUX_TMPDIR); sessions are ended by their exact names. No real Codex, no relay: the
// answer is a signed owner envelope made here.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import * as sig from "../lib/ownersig.js";
import { CARD_MS, START_MS, answerText, answerableOptions, homeIdOf, manifestDigest, parseResult, resultKeyId, resultVerifies } from "../lib/promptcards.js";
import { REPORT_TRIES, promptAnswers, reportSettled, resultReport } from "../lib/promptexec.js";
import { promptFileOf, readPromptRecord, writePromptRecord } from "../lib/promptflow.js";
import { classifyPrompt } from "../lib/prompts.js";
import { processIdentity } from "../lib/host.js";
import { injector } from "../lib/tmux.js";
import { sleep } from "./helpers.js";

const TMUX_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "hoptell-pex-"));
process.env.TMUX_TMPDIR = TMUX_DIR;
delete process.env.TMUX;
delete process.env.TMUX_PANE;
test.after(() => {
  spawnSync("tmux", ["kill-server"]);
  fs.rmSync(TMUX_DIR, { recursive: true, force: true });
});
const hasTmux = spawnSync("tmux", ["-V"]).status === 0;
const FAKE = new URL("./fixtures/fake-codex-trust.cjs", import.meta.url).pathname;
const tm = (...args) => execFileSync("tmux", args, { encoding: "utf8" }).trim();

const ME = "m_mmmmmmmmmmmmmmmmmmmmmmmmmm";
const REALM = "a".repeat(32);
const CTL = "me-cabcdefghij";
const KEY = sig.newKey();
const PIN = { name: "me-owner", keys: [{ id: sig.keyIdOf(KEY.pub), pub: KEY.pub }] };
const CONN = Object.freeze({ name: CTL, member: { id: ME, name: "me" }, realm: { id: REALM } }); // the control connection
const RK = "9".repeat(64); // the answer's result key
let n = 0;

/**
 * A stand-in dialog in its own tmux session, the launch it belongs to (the gate's), a home with its
 * prompt record, and the handler. `untested`: the launch's test switch (the table's Trust and Quit
 * are not checked live yet); `over`: manifest fields that differ from the launch.
 */
async function world(t, { mode = "normal", armed = true, untested = true, over = {}, ops: wrap = (o) => o, now = Date.now, report = null } = {}) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hoptell-pex-home-")));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const log = path.join(home, "keys.log");
  const ctl = path.join(home, "ctl");
  const session = `hoptell-pex-${process.pid}-${n++}`;
  const [sessionId, pane, pid] = tm("new-session", "-d", "-x", "200", "-y", "40", "-P", "-F", "#{session_id} #{pane_id} #{pane_pid}", "-s", session, `${process.execPath} ${FAKE} ${log} ${mode} ${ctl}`).split(" ");
  t.after(() => spawnSync("tmux", ["kill-session", "-t", `=${session}`]));
  for (let i = 0; i < 100 && !fs.existsSync(log); i++) await sleep(20);
  await sleep(100);
  const inj = injector(pane, pid);
  const read = inj.look();
  const p = classifyPrompt(read.screen, { cli: "codex", version: "0.165.0" });
  assert.equal(p?.actionable, true, read.screen);
  const at = now();
  const launch = {
    id: "2".repeat(32),
    cli: { name: "codex", path: "/opt/homebrew/bin/codex", version: "0.165.0" },
    folder: "/private/tmp/x",
    root: "/private/tmp/x",
    tmux: { socket: tm("display-message", "-p", "-t", pane, "#{socket_path}"), session: sessionId, pane },
    host: processIdentity(Number(pid)),
    untested,
    started: at,
  };
  const manifest = {
    hoptell_prompt_manifest: 1,
    realm: REALM,
    profile: null,
    home: homeIdOf(home),
    recipient: { member: ME, control: CTL },
    launch: launch.id,
    team: null,
    session: "me-alice",
    scope: { root: launch.root, folder: launch.folder },
    cli: { ...launch.cli },
    host: { ...launch.host },
    tmux: { ...launch.tmux },
    subtype: "codex-startup-trust",
    options: answerableOptions("0.165.0")[0].map((o) => JSON.parse(JSON.stringify(o))),
    untested,
    selected: p.selected,
    dialog: p.dialog,
    captured_at: Math.min(read.at, at), // a test clock may lag the injector's
    created_at: at,
    expires_at: at + CARD_MS,
    nonce: "e".repeat(32),
    ...over,
  };
  const digest = manifestDigest(manifest);
  writePromptRecord(home, "me-alice", { digest, manifest, state: "published" });
  const gate = { launch, on: armed, offs: [], observed: [], armed: () => gate.on, off: (why) => (gate.on = false, gate.offs.push(why)), observe: (r) => gate.observed.push(r) };
  const reports = [];
  const logs = [];
  const ops = wrap({ pane: inj.pane, pid: inj.pid, look: inj.look, paneAlive: inj.paneAlive, inMode: inj.inMode, keyIdle: inj.keyIdle, press: inj.press });
  const handler = promptAnswers(home, "me-alice", { gate, ops, report: report ?? (async (r) => (reports.push(r), { note: true, lead: true })), pin: () => PIN, now, lockMs: 300, log: (l) => logs.push(l) });
  /** The owner's signed answer for `choice`, as the bridge makes it. */
  const envelope = (choice, { to = { name: CTL, member: ME }, issuedAt = now(), d = digest, nonce = manifest.nonce, kind = "prompt_answer" } = {}) =>
    sig.signEnvelope({ kind, realm: REALM, from: "me-owner", to, q: "11111111-2222-4333-8444-555555555555", text: answerText({ digest: d, nonce, choice, issuedAt, resultKey: RK }), pairing: { id: "p_abcdefghijklmnop", at: 1 }, ts: now(), nonce: sig.nonceOf(KEY, ["prompt", "1", d, String(Math.random())]) }, KEY);
  let confirmed = 0;
  const answer = (text, from = "me-owner") => handler.onMessage({ from, text }, () => confirmed++, CONN);
  const keys = () => fs.readFileSync(log, "utf8").split("\n").filter((l) => l.startsWith("key") || /^(QUIT|TRUSTED)$/.test(l));
  return { home, log, ctl, pane, inj, gate, reports, logs, manifest, digest, envelope, answer, handler, keys, confirmed: () => confirmed, state: () => readPromptRecord(home, "me-alice") };
}
const outcome = (w) => [w.keys(), w.state().state, w.state().why];

test("Quit: the signed answer is taken once, recorded before the key, and only \"2\" is sent; the gate is off; the result goes out and is marked sent", { skip: !hasTmux && "tmux not installed" }, async (t) => {
  const w = await world(t);
  await w.answer(w.envelope("2"));
  assert.deepEqual(w.keys(), ["key 2", "QUIT"]);
  assert.deepEqual([w.state().state, w.state().why], ["done", null]);
  assert.deepEqual(w.state().answer, { choice: "2", result_key: RK });
  assert.deepEqual(w.state().report, { outcome: "done", why: null, label: "Quit", note: true, lead: true, tries: 1 });
  assert.deepEqual(w.gate.offs, ["answered"]);
  assert.deepEqual(w.reports, [{ outcome: "done", why: null, label: "Quit", digest: w.digest, nonce: w.manifest.nonce, key: RK, note: true, lead: true }]);
  assert.equal(w.confirmed(), 1);
  // The same answer again, or another tap: never tried again, and a report already taken is not sent again.
  await w.answer(w.envelope("2"));
  await w.answer(w.envelope("1"));
  assert.deepEqual(w.keys(), ["key 2", "QUIT"]);
  assert.equal(w.reports.length, 1);
  assert.equal(w.confirmed(), 3);
});

test("Trust: \"1\" (it only selects), a fresh read that shows the same dialog with Trust selected, then Enter; every read is one of the gate's reads too", { skip: !hasTmux && "tmux not installed" }, async (t) => {
  const w = await world(t);
  await w.answer(w.envelope("1"));
  assert.deepEqual(w.keys(), ["key 1", "key Enter", "TRUSTED"]);
  assert.equal(w.state().state, "done");
  assert.equal(w.reports[0].label, "Trust folder");
  assert.ok(w.gate.observed.length >= 2, "the read before the key and the revalidation");
  assert.ok(w.gate.observed.every((r) => r.prompt?.subtype === "codex-startup-trust" && typeof r.screen === "string"));
  // Quit was selected when the card was made: "1" selects Trust, the read shows it, then Enter.
  const v = await world(t, { mode: "start-on-2" });
  await v.answer(v.envelope("1"));
  assert.deepEqual(v.keys(), ["key 1", "key Enter", "TRUSTED"]);
  assert.equal(v.state().state, "done");
});

test("after \"1\" the revalidation waits only for the same dialog's selection to move: another screen ends it at once as unknown, and Enter is never sent", { skip: !hasTmux && "tmux not installed" }, async (t) => {
  // "1" selected Quit: the same dialog, the wrong row, for the whole wait.
  const w = await world(t, { mode: "one-selects-two" });
  await w.answer(w.envelope("1"));
  assert.deepEqual(w.keys(), ["key 1"]);
  assert.deepEqual([w.state().state, w.state().why], ["unknown", "changed"]);
  assert.deepEqual(w.reports.map((r) => [r.outcome, r.why]), [["unknown", "changed"]]);
  await w.answer(w.envelope("1"));
  assert.deepEqual(w.keys(), ["key 1"], "unknown is never tried again");
  // "1" shows another program's approval prompt, then the dialog again with Trust selected: the
  // other screen ends it; the dialog that comes back does not bring Enter.
  const v = await world(t, { mode: "foreign-after-one" });
  await v.answer(v.envelope("1"));
  await sleep(700);
  assert.deepEqual(v.keys(), ["key 1"]);
  assert.deepEqual([v.state().state, v.state().why], ["unknown", "changed"]);
  // An unreadable pane during the wait (a mode, a failed read): unknown at once too.
  let reads = 0;
  const u = await world(t, { mode: "start-on-2", ops: (o) => ({ ...o, look: () => (++reads > 1 ? null : o.look()) }) });
  await u.answer(u.envelope("1"));
  assert.deepEqual([u.keys(), u.state().state, u.state().why], [["key 1"], "unknown", "busy"]);
  assert.equal(reads, 2, "not read again");
});

test("refused with nothing sent: the screen changed, copy mode, a key from a client, the gate off, the card expired or the tap too old", { skip: !hasTmux && "tmux not installed" }, async (t) => {
  // Another folder on the screen than on the card.
  let w = await world(t);
  fs.writeFileSync(w.ctl, "redraw /private/tmp/elsewhere\n");
  await sleep(200);
  await w.answer(w.envelope("2"));
  assert.deepEqual(outcome(w), [[], "refused", "changed"]);
  assert.deepEqual(w.gate.offs, ["answered"]);
  // Copy mode.
  w = await world(t);
  tm("copy-mode", "-t", w.pane);
  await w.answer(w.envelope("2"));
  assert.deepEqual(outcome(w), [[], "refused", "busy"]);
  // A key from an attached client just now (the injector's client check, played).
  w = await world(t, { ops: (o) => ({ ...o, keyIdle: () => false }) });
  await w.answer(w.envelope("2"));
  assert.deepEqual(outcome(w), [[], "refused", "busy"]);
  // The startup gate is off (readiness, a gap, a restart): nothing is pressed.
  w = await world(t, { armed: false });
  await w.answer(w.envelope("2"));
  assert.deepEqual(outcome(w), [[], "refused", "changed"]);
  // The card expired, or the tap is older than START_MS.
  let clock = Date.now();
  w = await world(t, { now: () => clock });
  const late = w.envelope("2");
  clock += CARD_MS + 1;
  await w.answer(late);
  assert.deepEqual(outcome(w), [[], "refused", "late"]);
  clock = Date.now();
  w = await world(t, { now: () => clock });
  await w.answer(w.envelope("2", { issuedAt: clock - START_MS - 1 }));
  assert.deepEqual(outcome(w), [[], "refused", "late"]);
  assert.equal(w.reports[0].outcome, "refused");
});

test("a key since the card's read refuses, also one older than IDLE_S, and so does unknown activity; a key in the read's second counts as after it", { skip: !hasTmux && "tmux not installed" }, async (t) => {
  // look() gives keyAt as the end of the last key's second (tmux keeps whole seconds).
  const keyAt = (f) => (o) => ({ ...o, keyIdle: () => true, look: () => ({ ...o.look(), keyAt: f() }) });
  let w;
  const at = () => w.manifest.captured_at;
  // A key after the read, long enough ago that the IDLE_S check passes.
  w = await world(t, { ops: keyAt(() => at() + 1) });
  await w.answer(w.envelope("2"));
  assert.deepEqual(outcome(w), [[], "refused", "busy"]);
  // Unknown: the clients' activity could not be read.
  w = await world(t, { ops: keyAt(() => null) });
  await w.answer(w.envelope("2"));
  assert.deepEqual(outcome(w), [[], "refused", "busy"]);
  // The boundary: a key whose second ends at the read refuses; one that ended before it does not.
  w = await world(t, { ops: keyAt(() => at()) });
  await w.answer(w.envelope("2"));
  assert.deepEqual(outcome(w), [[], "refused", "busy"]);
  w = await world(t, { ops: keyAt(() => at() - 1) });
  await w.answer(w.envelope("2"));
  assert.deepEqual(outcome(w), [["key 2", "QUIT"], "done", null]);
});

test("the injector's read: stamped before the capture, the last key as the end of its whole second", () => {
  let clock = 10_500;
  let activity = "10";
  const run = (args) => {
    const [cmd] = args;
    if (cmd === "display-message") return { "#{pane_id} #{pane_pid} #{pane_dead}": "%1 100 0", "#{session_id}": "$1", "#{pane_in_mode}": "0", "#{pane_current_command}": "node" }[args.at(-1)] ?? "0 0 80";
    if (cmd === "capture-pane") {
      clock += 300; // the capture takes a while
      return "screen\n";
    }
    if (cmd === "list-clients") return `${activity}\n`;
    return "";
  };
  const inj = injector("%1", "100", { run, runStatus: () => 0, now: () => clock });
  let r = inj.look();
  assert.equal(r.at, 10_500, "the time before the capture");
  assert.equal(r.keyAt, 10_999, "a key in second 10 counts until its end");
  activity = "9";
  clock = 10_500;
  assert.equal(inj.look().keyAt, 9_999);
  activity = "";
  assert.equal(inj.look().keyAt, -Infinity, "no client attached");
  activity = "x";
  r = inj.look();
  assert.equal(r.keyAt, null, "unreadable: unknown");
});

test("Trust and Quit were checked live on 0.165.0: pressed without the launch's test switch; a card that claims the switch for a launch without it is refused", { skip: !hasTmux && "tmux not installed" }, async (t) => {
  for (const [choice, keys] of [["1", ["key 1", "key Enter", "TRUSTED"]], ["2", ["key 2", "QUIT"]]]) {
    const w = await world(t, { untested: false });
    await w.answer(w.envelope(choice));
    assert.deepEqual(outcome(w), [keys, "done", null], choice);
  }
  // The test switch is the launch's: a card that claims it for a launch without it is not this launch's.
  const w = await world(t, { untested: false, over: { untested: true } });
  await w.answer(w.envelope("2"));
  assert.deepEqual(outcome(w), [[], "refused", "changed"]);
});

test("the manifest must be the injector's own target: launch, home, scope, process, tmux server, session and pane, recipient", { skip: !hasTmux && "tmux not installed" }, async (t) => {
  const cases = [
    { over: { launch: "3".repeat(32) } },
    { over: { home: "4".repeat(32) } },
    { over: { scope: { root: "/private/tmp/y", folder: "/private/tmp/x" } } },
    { over: { cli: { name: "codex", path: "/usr/local/bin/codex", version: "0.165.0" } } },
    { over: { tmux: { socket: "/private/tmp/other-socket", session: "$0", pane: "%0" } } },
    { over: { recipient: { member: ME, control: "me-cotherother" } } },
  ];
  for (const c of cases) {
    const w = await world(t, c);
    await w.answer(w.envelope("2"));
    assert.deepEqual(outcome(w), [[], "refused", "changed"], JSON.stringify(c.over));
  }
  // The pane operations of another pane, or another process.
  let w = await world(t, { ops: (o) => ({ ...o, pane: "%999" }) });
  await w.answer(w.envelope("2"));
  assert.deepEqual(outcome(w), [[], "refused", "gone"]);
  w = await world(t, { ops: (o) => ({ ...o, pid: "1" }) });
  await w.answer(w.envelope("2"));
  assert.deepEqual(outcome(w), [[], "refused", "gone"]);
  // The key itself goes only to the target's pane, on its server.
  w = await world(t);
  assert.equal(w.inj.press(["2"], { ...w.manifest.tmux, pane: "%999" }), false);
  assert.equal(w.inj.press(["2"], { ...w.manifest.tmux, socket: "relative" }), false);
  assert.throws(() => w.inj.press(["2"], { ...w.manifest.tmux, socket: path.join(w.home, "no-server") }));
  assert.throws(() => w.inj.press(["q"], w.manifest.tmux), /not a key of the prompt table/);
  await sleep(100);
  assert.deepEqual(w.keys(), []);
  assert.equal(w.inj.press(["2"], w.manifest.tmux), true);
  await sleep(200);
  assert.deepEqual(w.keys(), ["key 2", "QUIT"]);
});

test("ignored without a trace: not signed by the pinned bridge, for another name, another kind, another card; the record left attempting is unknown", { skip: !hasTmux && "tmux not installed" }, async (t) => {
  const w = await world(t);
  const before = fs.readFileSync(promptFileOf(w.home, "me-alice"), "utf8");
  const other = sig.newKey();
  const forged = sig.signEnvelope({ kind: "prompt_answer", realm: REALM, from: "me-owner", to: { name: CTL, member: ME }, q: "11111111-2222-4333-8444-555555555555", text: answerText({ digest: w.digest, nonce: w.manifest.nonce, choice: "2", issuedAt: Date.now(), resultKey: RK }), pairing: { id: "p_abcdefghijklmnop", at: 1 }, ts: Date.now(), nonce: sig.nonceOf(other, ["x"]) }, other);
  await w.answer(forged);
  await w.answer(w.envelope("2"), "me-mallory");
  await w.answer(w.envelope("2", { to: { name: "me-alice", member: ME } }));
  await w.answer(w.envelope("2", { kind: "answer" }));
  await w.answer(w.envelope("2", { d: "d".repeat(64) }));
  await w.answer(w.envelope("2", { nonce: "f".repeat(32) }));
  await w.answer("plain text, not an envelope");
  assert.deepEqual(w.keys(), []);
  assert.equal(fs.readFileSync(promptFileOf(w.home, "me-alice"), "utf8"), before);
  assert.equal(w.reports.length, 0);
  assert.equal(w.confirmed(), 7, "everything is confirmed: nothing comes again");
  assert.match(w.logs.join("\n"), /does not verify/);
  // An injector that stopped while trying: the answer comes again and is reported unknown, never pressed.
  writePromptRecord(w.home, "me-alice", { digest: w.digest, manifest: w.manifest, state: "attempting", answer: { choice: "2", result_key: RK } });
  await w.answer(w.envelope("2"));
  assert.deepEqual(outcome(w), [[], "unknown", "interrupted"]);
  assert.deepEqual(w.reports.map((r) => [r.outcome, r.why, r.key]), [["unknown", "interrupted", RK]]);
});

test("the prompt's state cannot be written before the key (a read-only folder): refused, nothing sent, the owner still told", { skip: (!hasTmux && "tmux not installed") || (process.getuid?.() === 0 && "root writes anywhere") }, async (t) => {
  const w = await world(t);
  const sessions = path.dirname(promptFileOf(w.home, "me-alice"));
  fs.chmodSync(sessions, 0o500);
  try {
    await w.answer(w.envelope("2"));
  } finally {
    fs.chmodSync(sessions, 0o700);
  }
  assert.deepEqual(w.keys(), []);
  assert.deepEqual(w.reports.map((r) => [r.outcome, r.why, r.key]), [["refused", "storage", RK]]);
  assert.deepEqual(w.gate.offs, ["answered"]);
});

test("a result not taken is kept and tried again, a bounded number of times; the answer coming again sends it again and presses nothing", { skip: !hasTmux && "tmux not installed" }, async (t) => {
  let clock = Date.now();
  let take = false;
  const calls = [];
  const w = await world(t, { now: () => clock, report: async (r) => (calls.push(r), { note: take, lead: true }) });
  await w.answer(w.envelope("2"));
  assert.deepEqual(w.keys(), ["key 2", "QUIT"]);
  assert.deepEqual([w.state().report.note, w.state().report.tries, calls.length], [false, 1, 1]);
  // Before its next turn nothing is tried; at it, once more.
  assert.equal(await w.handler.flush(), false);
  assert.equal(calls.length, 1);
  clock += 2000;
  assert.equal(await w.handler.flush(), false);
  assert.equal(calls.length, 2);
  // The answer again: its report goes out at once, nothing is pressed.
  take = true;
  await w.answer(w.envelope("2"));
  assert.deepEqual(w.keys(), ["key 2", "QUIT"]);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.at(-1), { outcome: "done", why: null, label: "Quit", digest: w.digest, nonce: w.manifest.nonce, key: RK, note: true, lead: false }, "the part not taken yet only");
  assert.deepEqual([w.state().report.note, w.state().report.lead], [true, true]);
  assert.equal(await w.handler.flush({ force: true }), true);
  assert.equal(calls.length, 3, "taken: never sent again");
  // A report never taken: at most REPORT_TRIES tries on the ticks.
  const v = await world(t, { now: () => clock, report: async (r) => (calls.push(r), { note: false, lead: true }) });
  const before = calls.length;
  await v.answer(v.envelope("2"));
  for (let i = 0; i < REPORT_TRIES + 5; i++) {
    clock += 61_000;
    await v.handler.flush();
  }
  assert.equal(calls.length - before, REPORT_TRIES);
  assert.equal(v.state().report.tries, REPORT_TRIES);
});

test("the agent's exit waits, briefly, while an answer is carried out or its result is not reported", async (t) => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hoptell-pex-home-")));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  assert.equal(await reportSettled(home, "me-alice", { ms: 50 }), true, "no record: at once");
  const at = Date.now();
  const manifest = {
    hoptell_prompt_manifest: 1, realm: REALM, profile: null, home: homeIdOf(home), recipient: { member: ME, control: CTL }, launch: "2".repeat(32), team: null, session: "me-alice",
    scope: { root: "/private/tmp/x", folder: "/private/tmp/x" }, cli: { name: "codex", path: "/opt/homebrew/bin/codex", version: "0.165.0" }, host: { pid: 4242, start: "s", uid: 501, boot: "b1" },
    tmux: { socket: "/private/tmp/s", session: "$1", pane: "%1" }, subtype: "codex-startup-trust", options: answerableOptions("0.165.0")[0].map((o) => JSON.parse(JSON.stringify(o))), untested: true,
    selected: 1, dialog: "c".repeat(64), captured_at: at, created_at: at, expires_at: at + CARD_MS, nonce: "e".repeat(32),
  };
  const digest = manifestDigest(manifest);
  const answer = { choice: "2", result_key: RK };
  writePromptRecord(home, "me-alice", { digest, manifest, state: "attempting", answer });
  const t0 = Date.now();
  assert.equal(await reportSettled(home, "me-alice", { ms: 300 }), false);
  assert.ok(Date.now() - t0 >= 290, "it waited");
  const report = { outcome: "done", why: null, label: "Quit", note: false, lead: false, tries: 0 };
  writePromptRecord(home, "me-alice", { digest, manifest, state: "done", answer, report });
  setTimeout(() => writePromptRecord(home, "me-alice", { digest, manifest, state: "done", answer, report: { ...report, note: true, tries: 1 } }), 150);
  assert.equal(await reportSettled(home, "me-alice", { ms: 3000 }), true, "until the bridge took it");
  writePromptRecord(home, "me-alice", { digest, manifest, state: "published" });
  assert.equal(await reportSettled(home, "me-alice", { ms: 50 }), true, "a card not answered: nothing to wait for");
});

test("the report: a result message for the bridge under the answer's key, and a line for the team's lead; each says whether it was taken", async () => {
  const notes = [];
  const tells = [];
  let up = true;
  const control = { note: async (x) => (notes.push(x), up), tell: async (to, x) => (tells.push([to, x]), up) };
  const r = await resultReport("me-alice", { control, team: { team: "n4", lead: "me-lead" } })({ outcome: "unknown", why: "changed", label: "Trust folder", digest: "d".repeat(64), nonce: "e".repeat(32), key: RK });
  assert.deepEqual(r, { note: true, lead: true });
  const got = parseResult(notes[0]);
  assert.deepEqual({ ...got, mac: undefined }, { hoptell_prompt_result: 1, digest: "d".repeat(64), nonce: "e".repeat(32), outcome: "unknown", why: "changed", result_key: RK, mac: undefined });
  assert.equal(resultVerifies(got, resultKeyId(RK)), true);
  assert.equal(resultVerifies({ ...got, outcome: "done", why: null }, resultKeyId(RK)), false, "the MAC covers the outcome");
  assert.equal(resultVerifies(got, resultKeyId("8".repeat(64))), false, "another answer's key");
  assert.deepEqual(tells, [["me-lead", 'hoptell: automated notice, not a user message. me-alice (team n4), Codex\'s folder trust prompt: the owner chose "Trust folder"; hoptell may have pressed part of it (changed): look at the session.']]);
  up = false;
  assert.deepEqual(await resultReport("me-alice", { control, team: null })({ outcome: "done", why: null, label: "Quit", digest: "d".repeat(64), nonce: "e".repeat(32), key: RK }), { note: false, lead: true }, "no lead: nothing to tell");
  assert.equal(tells.length, 1);
  assert.equal(parseResult(notes[1]).outcome, "done");
  // Only the parts asked for; a failing connection is not taken.
  const throwing = { note: async () => { throw new Error("down"); }, tell: async () => true };
  assert.deepEqual(await resultReport("me-alice", { control: throwing, team: { team: "n4", lead: "me-lead" } })({ outcome: "done", why: null, label: "Quit", digest: "d".repeat(64), nonce: "e".repeat(32), key: RK, lead: false }), { note: false, lead: true });
});

test("a report whose send failed is kept and tried again, also one that could not be recorded; the lead is told once, best effort", { skip: (!hasTmux && "tmux not installed") || (process.getuid?.() === 0 && "root writes anywhere") }, async (t) => {
  let clock = Date.now();
  let up = false;
  const calls = [];
  const w = await world(t, { now: () => clock, report: async (r) => (calls.push(r), { note: up, lead: false }) });
  const sessions = path.dirname(promptFileOf(w.home, "me-alice"));
  fs.chmodSync(sessions, 0o500); // nothing can be recorded: refused/storage, kept in memory only
  try {
    await w.answer(w.envelope("2"));
  } finally {
    fs.chmodSync(sessions, 0o700);
  }
  assert.deepEqual(w.keys(), []);
  assert.deepEqual(calls.map((c) => [c.outcome, c.why, c.note, c.lead]), [["refused", "storage", true, true]]);
  assert.match(w.logs.join("\n"), /lead was not told/);
  // Not taken: kept, and tried at the next turn (not discarded), now for the owner only.
  clock += 2000;
  assert.equal(await w.handler.flush(), false);
  assert.deepEqual(calls.map((c) => [c.note, c.lead]).at(-1), [true, false]);
  up = true;
  clock += 2000;
  assert.equal(await w.handler.flush(), true);
  assert.equal(calls.length, 3);
  clock += 2000;
  assert.equal(await w.handler.flush(), true);
  assert.equal(calls.length, 3, "taken: not sent again");
  // A recorded report: the lead's failure holds nothing up; the record counts as settled once the note is taken.
  const v = await world(t, { report: async () => ({ note: true, lead: false }) });
  await v.answer(v.envelope("2"));
  assert.deepEqual([v.state().report.note, v.state().report.lead], [true, true]);
  assert.equal(await reportSettled(v.home, "me-alice", { ms: 50 }), true);
});

test("a record left \"attempting\" by an injector that stopped becomes unknown/interrupted when the next one starts, and is reported without the answer coming again", { skip: !hasTmux && "tmux not installed" }, async (t) => {
  const w = await world(t);
  writePromptRecord(w.home, "me-alice", { digest: w.digest, manifest: w.manifest, state: "attempting", answer: { choice: "1", result_key: RK } });
  const calls = [];
  const next = promptAnswers(w.home, "me-alice", { gate: w.gate, ops: {}, report: async (r) => (calls.push(r), { note: true, lead: true }), pin: () => PIN, lockMs: 300 });
  assert.equal(await next.flush(), true);
  assert.deepEqual([w.state().state, w.state().why, w.state().report.note], ["unknown", "interrupted", true]);
  assert.deepEqual(calls.map((c) => [c.outcome, c.why, c.label, c.key]), [["unknown", "interrupted", "Trust folder", RK]]);
  assert.deepEqual(w.gate.offs, ["answered"]);
  assert.deepEqual(w.keys(), [], "nothing pressed");
});
