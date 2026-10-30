// Sessions waiting on a prompt, or stalled (design 9, A and B): the classifier, the watcher, the
// occurrence records and the owner budget. No tmux: the pane is played by a stand-in.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { classifyPrompt, createWatch, stillScreen } from "../lib/prompts.js";
import { OWNER_HOURLY, closeOccurrence, openOccurrence as open, ownerBudget, readOccurrence, waitFileOf, waitLine } from "../lib/waits.js";
import { processIdentity } from "../lib/host.js";
import { injector, injectorOwner, waitWatch } from "../lib/tmux.js";
import { readSettings } from "../lib/settings.js";

const tmp = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hoptell-waits-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const MIN = 60_000;
/** This test process as the injector (it runs: "same"), in tmux session $1, pane %3. */
const OWNER = Object.freeze({ tmux: "$1", pane: "%3", injector: processIdentity(process.pid) });
const openOccurrence = (home, name, start, o = {}) => open(home, name, start, { owner: OWNER, ...o });
const screen = (...rows) => ["", "some transcript", ...rows, ""].join("\n");

const LIVE = JSON.parse(fs.readFileSync(new URL("./fixtures/prompt-screens.json", import.meta.url), "utf8")).screens;
const live = (name) => LIVE.find((x) => x.name === name);

test("prompts: Codex 0.165.0's startup folder trust from live captures at three widths and both launches; actionable only on the tested version", () => {
  for (const s of LIVE.filter((x) => x.cli === "codex")) {
    const { dialog, frame, folders, ...r } = classifyPrompt(s.rows.join("\n"), { cli: "codex", version: "0.165.0" });
    const quit = s.launch === "hoptell tmux";
    // Trust takes "1" (it only selects), a fresh read, then Enter; option 2 is "2" alone. Only Back was checked live.
    const trust = { key: "1", action: "trust", label: "Trust folder", steps: [["1"], "revalidate", ["Enter"]], live: true };
    assert.deepEqual(r, { subtype: "codex-startup-trust", actionable: true, options: [trust, quit ? { key: "2", action: "quit", label: "Quit", steps: [["2"]], live: true } : { key: "2", action: "back", label: "Back to Agent Command Center", steps: [["2"]], live: true }], selected: 1 }, s.name);
    // The folder Codex asks about, read back from its rows however the width wrapped it.
    assert.ok(folders.includes(`/private/tmp/${"x".repeat(quit ? 120 : 85)}/trustprobe2`) || folders.some((f) => /^\/private\/tmp\/x+\/trustprobe2$/.test(f)), s.name);
    assert.match(dialog, /^[0-9a-f]{64}$/);
    // The selection, the folder or the risk text changed: another dialog digest.
    const moved = s.rows.map((x) => x.replace(/^› 1\./, "  1.").replace(/^ {2}2\./, "› 2."));
    assert.notEqual(classifyPrompt(moved.join("\n"), { cli: "codex", version: "0.165.0" }).dialog, dialog);
    // The frame: the dialog whichever row is selected.
    assert.match(frame, /^[0-9a-f]{64}$/);
    assert.equal(classifyPrompt(moved.join("\n"), { cli: "codex", version: "0.165.0" }).frame, frame);
    const other = s.rows.map((x) => x.replace("trustprobe2", "trustprobe3"));
    assert.notEqual(classifyPrompt(other.join("\n"), { cli: "codex", version: "0.165.0" }).dialog, dialog);
    assert.notEqual(classifyPrompt(other.join("\n"), { cli: "codex", version: "0.165.0" }).frame, frame);
    // A row added between the options and the footer (the one the matcher lets through), or a
    // row added to the risk text: still the prompt, but another dialog and another frame.
    const quitRow = s.rows.findIndex((x) => /^(› | {2})2\. /.test(x));
    assert.equal(s.rows[quitRow + 1], "", s.name);
    let risk = quitRow - 2;
    while (!s.rows[risk].trim()) risk--; // the risk text's last row
    for (const added of [s.rows.map((x, i) => (i === quitRow + 1 ? "WARNING: This additionally trusts every repository." : x)), s.rows.map((x, i) => (i === risk ? `${x} It also trusts every repository.` : x))]) {
      const p = classifyPrompt(added.join("\n"), { cli: "codex", version: "0.165.0" });
      assert.equal(p?.actionable, true, "the matcher still takes it: the digests must differ");
      assert.notEqual(p.dialog, dialog, s.name);
      assert.notEqual(p.frame, frame, s.name);
    }
    // Another version, or a CLI that is not verified: the same prompt, display-only.
    assert.equal(classifyPrompt(s.rows.join("\n"), { cli: "codex", version: "0.166.0" }).actionable, false);
    assert.equal(classifyPrompt(s.rows.join("\n")).actionable, false);
    assert.equal(classifyPrompt(s.rows.join("\n")).subtype, "codex-startup-trust");
  }
  // The same dialog at 80, 120 and 200 columns: one dialog digest, however the width wrapped it.
  const direct = LIVE.filter((x) => x.cli === "codex" && x.launch === "direct").map((x) => classifyPrompt(x.rows.join("\n"), { cli: "codex", version: "0.165.0" }).dialog);
  assert.equal(direct.length, 3);
  assert.equal(new Set(direct).size, 1);
  // Claude Code's workspace trust (No first and selected, no digits): display-only.
  assert.deepEqual(classifyPrompt(live("claude-trust-w120").rows.join("\n"), { cli: "claude", version: "2.1.312" }), { subtype: "folder-trust", actionable: false, options: [], selected: null });
});

test("prompts: spoofed trust text in agent output, a changed selection and other dialogs", () => {
  const codex = live("codex-0.165.0-trust-hoptelltmux-w200").rows;
  const at = { cli: "codex", version: "0.165.0" };
  // The same lines printed in the transcript, with Codex's input box below them: not the prompt.
  const spoof = [...codex.filter((r) => r.trim()), "", "› Ask Codex to do anything", "", "  ? for shortcuts"].join("\n");
  assert.notEqual(classifyPrompt(spoof, at)?.subtype, "codex-startup-trust");
  assert.equal(classifyPrompt(spoof, at)?.actionable ?? false, false);
  // The selection moved to Quit: the same prompt, the second row selected.
  const moved = codex.map((r) => r.replace(/^› 1\./, "  1.").replace(/^ {2}2\. Quit$/, "› 2. Quit")).join("\n");
  assert.equal(classifyPrompt(moved, at).selected, 2);
  // A line of the dialog changed: not the known prompt.
  assert.notEqual(classifyPrompt(codex.map((r) => r.replace("Trust and continue", "Trust and run")).join("\n"), at)?.subtype, "codex-startup-trust");
  assert.deepEqual(classifyPrompt(screen("New MCP server found in this project", "› 1. Use this and all future MCP servers")), { subtype: "mcp-trust", actionable: false, options: [], selected: null });
  assert.equal(classifyPrompt(screen("Do you want to proceed?", "❯ 1. Yes", "  2. No")).subtype, "approval");
  assert.equal(classifyPrompt(screen("Sign in with ChatGPT")).subtype, "login");
  assert.equal(classifyPrompt(screen("❯ 1. Dark mode", "  2. Light mode")).subtype, "unknown-dialog");
  // An ordinary screen, and the same words high up in the transcript, are no prompt.
  assert.equal(classifyPrompt(screen("› ")), null);
  const high = ["Do you want to proceed?", ...Array.from({ length: 20 }, (_, i) => `line ${i}`), "› "].join("\n");
  assert.equal(classifyPrompt(high), null);
});

test("stall: spinner, timer and token changes alone are no change; a held stall ends when the pane changes or a key arrives", () => {
  assert.equal(stillScreen("✻ Working (12s · esc to interrupt) ↑ 1.2k tokens"), stillScreen("✽ Working (1m 4s · esc to interrupt) ↑ 3.4k tokens"));
  const w = createWatch({ stallMs: 10 * MIN });
  let at = 0;
  const busy = (s) => ({ screen: `${s} Working (${at / 1000}s · esc to interrupt)`, prompt: null, inputShown: false, unreadSince: null, keyAt: -Infinity, at });
  const seen = [];
  for (let i = 0; i <= 44; i++) {
    at = i * 15_000;
    const ev = w.feed(busy("⠋"));
    if (ev.start || ev.end) seen.push([at / MIN, ev]);
  }
  // Unchanged from 0: after 10 min a candidate, held at the second equal read (10.25 min).
  assert.deepEqual(seen, [[10.25, { start: { kind: "stall", subtype: "busy", actionable: false, since: 0 } }]]);
  at += 15_000;
  assert.deepEqual(w.feed({ ...busy("⠋"), screen: "done, next step" }), { end: true });
  // A key from a person counts as activity: the quiet time starts again from it, and a full
  // stallMs after the last key with no change a stall starts (an old key never suppresses it).
  const k = createWatch({ stallMs: 10 * MIN });
  const keyed = [];
  for (let i = 0; i <= 80; i++) {
    const ev = k.feed({ ...busy("⠋"), at: i * 15_000, keyAt: 5 * MIN });
    if (ev.start) keyed.push([i * 15_000, ev.start.since]);
  }
  assert.deepEqual(keyed, [[15.25 * MIN, 5 * MIN]], "10 min after the key, held at the second read");
  // A key while a stall holds ends it; the next one comes a full stallMs after that key.
  let key = 5 * MIN;
  const events = [];
  for (let i = 62; i <= 130; i++) {
    if (i === 70) key = 70 * 15_000;
    const ev = k.feed({ ...busy("⠋"), at: i * 15_000, keyAt: key });
    if (ev.start || ev.end) events.push([(i * 15_000) / MIN, ev.end ? "end" : ev.start.since / MIN]);
  }
  assert.deepEqual(events, [[17.5, "end"], [27.75, 17.5]]);
  // A key time that cannot be read: never a stall.
  const u = createWatch({ stallMs: 10 * MIN });
  let started = false;
  for (let i = 0; i <= 80; i++) started ||= Boolean(u.feed({ ...busy("⠋"), at: i * 15_000, keyAt: null }).start);
  assert.equal(started, false, "unknown activity refuses");
  // Idle at the input box: a stall only with a notice unread longer than stallMinutes.
  const idle = (unreadSince, i) => ({ screen: "› ", prompt: null, inputShown: true, unreadSince, keyAt: -Infinity, at: i * 15_000 });
  const a = createWatch({ stallMs: 10 * MIN });
  const b = createWatch({ stallMs: 10 * MIN });
  let sa = null;
  let sb = null;
  for (let i = 0; i <= 60; i++) {
    sa ??= a.feed(idle(null, i)).start ?? null;
    sb ??= b.feed(idle(0, i)).start ?? null;
  }
  assert.equal(sa, null, "idle with nothing unread is no stall");
  assert.equal(sb.subtype, "unread");
});

test("a prompt holds after two equal reads, and an unreadable read starts and ends nothing", () => {
  const w = createWatch();
  const p = { subtype: "approval", actionable: false, options: [] };
  const r = (at, prompt = p, s = "Do you want to proceed?") => ({ screen: s, prompt, inputShown: false, unreadSince: null, keyAt: -Infinity, at });
  assert.deepEqual(w.feed(r(0)), {});
  assert.deepEqual(w.feed(null), {});
  assert.deepEqual(w.feed(r(15_000)), { start: { kind: "prompt", subtype: "approval", actionable: false, since: 15_000, prompt: p } });
  assert.deepEqual(w.feed(r(30_000)), {});
  assert.deepEqual(w.feed(null), {});
  assert.deepEqual(w.feed(r(45_000, null, "› ")), { end: true });
});

test("occurrences: a record per session with a P<n> id per home and a random nonce; no pane text; closed only by its own nonce", (t) => {
  const home = tmp(t);
  const now = () => Date.parse("2026-10-29T10:02:00Z");
  const a = openOccurrence(home, "me-alice", { kind: "prompt", subtype: "mcp-trust", actionable: false, since: Date.parse("2026-10-29T10:00:00Z") }, { now });
  const b = openOccurrence(home, "me-bob", { kind: "stall", subtype: "busy", actionable: false, since: Date.parse("2026-10-29T09:50:00Z") }, { now });
  assert.deepEqual([a.id, b.id], ["P1", "P2"]);
  assert.match(a.nonce, /^[0-9a-f]{32}$/);
  assert.notEqual(a.nonce, b.nonce);
  assert.deepEqual(readOccurrence(home, "me-alice"), a);
  assert.equal(waitLine(a, now()), "waiting for you: MCP server trust (P1, 2 min)");
  assert.equal(waitLine(b, now()), "no change for 12 min (P2)");
  closeOccurrence(home, "me-alice", b.nonce);
  assert.ok(readOccurrence(home, "me-alice"), "another occurrence's nonce closes nothing");
  closeOccurrence(home, "me-alice", a.nonce);
  assert.equal(readOccurrence(home, "me-alice"), null);
  // A record that is not one is not shown.
  fs.writeFileSync(waitFileOf(home, "me-bob"), JSON.stringify({ ...b, extra: "pane text" }));
  assert.equal(readOccurrence(home, "me-bob"), null);
  // Every record names its injector's launch and pane; one whose injector is gone is not shown.
  const c = openOccurrence(home, "me-carol", { kind: "prompt", subtype: "approval", actionable: false, since: now() }, { now });
  assert.deepEqual(c.owner, OWNER);
  assert.deepEqual(readOccurrence(home, "me-carol"), c);
  assert.equal(readOccurrence(home, "me-carol", { state: () => "different" }), null, "its injector exited");
  assert.equal(readOccurrence(home, "me-carol", { state: () => "unknown" }), null);
  const gone = openOccurrence(home, "me-dave", { kind: "prompt", subtype: "approval", actionable: false, since: now() }, { now, owner: { ...OWNER, injector: { ...OWNER.injector, start: "another start" } } });
  assert.ok(gone);
  assert.equal(readOccurrence(home, "me-dave"), null, "the same pid with another start: not that injector");
  assert.throws(() => open(home, "me-erin", { kind: "prompt", subtype: "approval", actionable: false, since: now() }, { now }), /not a valid occurrence/, "no owner, no record");
});

test("an injector's records: a restart removes the earlier injector's record, a record not written stays pending and is written again, and the end removes only its own", (t) => {
  const home = tmp(t);
  let at = 0;
  const pane = { screen: "Do you want to proceed?\n❯ 1. Yes\n  2. No", command: "claude", keyAt: -Infinity, inputShown: false };
  const started = [];
  const watch = (owner = () => OWNER) => waitWatch(home, "me-alice", { look: () => ({ ...pane, at }), unreadSince: () => null, owner, surface: { start: (r) => started.push(r) }, now: () => at });
  // An earlier injector's record (another pane, or one that exited) is removed before watching.
  const old = open(home, "me-alice", { kind: "prompt", subtype: "login", actionable: false, since: 0 }, { owner: { ...OWNER, pane: "%9" } });
  let unknown = true;
  const late = watch(() => (unknown ? null : OWNER));
  late();
  assert.equal(JSON.parse(fs.readFileSync(waitFileOf(home, "me-alice"), "utf8")).nonce, old.nonce, "nothing touched while its own launch cannot be read");
  unknown = false;
  at += 15_000;
  late();
  assert.equal(fs.existsSync(waitFileOf(home, "me-alice")), false, "the earlier record removed");
  // A record that cannot be written: the occurrence stays pending and is written on a later tick.
  const file = waitFileOf(home, "me-alice");
  fs.mkdirSync(file); // the record's place is taken: writes fail
  const tick = watch();
  for (; at < 60_000; at += 500) tick();
  assert.equal(started.length, 0, "not surfaced before it is kept");
  fs.rmdirSync(file);
  for (; at < 90_000; at += 500) tick();
  assert.equal(started.length, 1);
  assert.equal(readOccurrence(home, "me-alice").nonce, started[0].nonce);
  // Its end removes only its own occurrence: another injector's record now in its place stays.
  const other = open(home, "me-alice", { kind: "prompt", subtype: "login", actionable: false, since: 0 }, { owner: { ...OWNER, pane: "%9" } });
  tick.close();
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).nonce, other.nonce);
  // Its own: removed.
  fs.rmSync(file);
  const again = watch();
  const before = started.length;
  for (; at < 150_000; at += 500) again();
  assert.equal(started.length, before + 1);
  again.close();
  assert.equal(fs.existsSync(file), false);
});

test("the owner budget: one note per occurrence, 5 min cooldown per session and kind, 20 an hour per home, then one summary", (t) => {
  const home = tmp(t);
  let at = Date.parse("2026-10-29T10:00:00Z");
  const now = () => at;
  const rec = (subtype) => ({ kind: "prompt", subtype });
  assert.equal(ownerBudget(home, "me-a", rec("approval"), { now }), "send");
  at += MIN;
  assert.equal(ownerBudget(home, "me-a", rec("approval"), { now }), "skip", "the same session and kind within 5 min (repaint churn)");
  assert.equal(ownerBudget(home, "me-a", rec("login"), { now }), "send", "another kind");
  at += 5 * MIN;
  assert.equal(ownerBudget(home, "me-a", rec("approval"), { now }), "send", "after the cooldown");
  const verdicts = [];
  for (let i = 0; i < OWNER_HOURLY + 3; i++) verdicts.push(ownerBudget(home, `me-s${i}`, rec("approval"), { now }));
  // 3 were sent this hour already: 17 more, then one summary, then nothing.
  assert.deepEqual([verdicts.filter((v) => v === "send").length, verdicts.slice(OWNER_HOURLY - 4)], [OWNER_HOURLY - 3, ["send", "summary", "skip", "skip", "skip", "skip", "skip"]]);
  at += 61 * MIN;
  assert.equal(ownerBudget(home, "me-x", rec("approval"), { now }), "send", "a new hour");
  // A budget that cannot be read fails closed.
  fs.writeFileSync(path.join(home, "v2", "waits", "budget.json"), "{");
  assert.equal(ownerBudget(home, "me-y", rec("approval"), { now }), "skip");
});

test("the injector's watch: reads every 15 s, keeps the record and surfaces start and end once; HOPTELL_STALL_MINUTES", (t) => {
  const home = tmp(t);
  let at = 0;
  let pane = { screen: "Do you want to proceed?\n❯ 1. Yes\n  2. No", command: "claude", keyAt: -Infinity, inputShown: false };
  const started = [];
  const ended = [];
  const tick = waitWatch(home, "me-alice", { look: () => (pane ? { ...pane, at } : null), unreadSince: () => null, owner: () => OWNER, surface: { start: (r) => started.push(r), end: (r) => ended.push(r) }, now: () => at });
  for (; at < 60_000; at += 500) tick();
  assert.equal(started.length, 1);
  assert.equal(readOccurrence(home, "me-alice").nonce, started[0].nonce);
  pane = { ...pane, screen: "› " };
  for (; at < 120_000; at += 500) tick();
  assert.deepEqual([ended.length, ended[0].nonce, readOccurrence(home, "me-alice")], [1, started[0].nonce, null]);
  const s = (v) => readSettings({ env: { HOPTELL_STALL_MINUTES: v }, homedir: "/nonexistent", pid: 1 });
  assert.equal(s(undefined).stallMinutes, 10);
  assert.equal(s("3").stallMinutes, 3);
  assert.equal(s("0").stallMinutes, 10);
  assert.match(s("x").warnings.join("\n"), /HOPTELL_STALL_MINUTES must be a whole number/);
});

test("the injector's read for the watch: none in a tmux mode or on a selection; a key's whole second counts to its end; unknown activity is null", () => {
  const pane = { mode: "0", screen: "› \n", clients: "1700000000\n", cmd: "codex" };
  const run = (args) => {
    if (args[0] === "display-message") {
      const f = args.at(-1);
      if (f === "#{pane_id} #{pane_pid} #{pane_dead}") return "%3 77 0\n";
      if (f === "#{pane_in_mode}") return `${pane.mode}\n`;
      if (f === "#{session_id}") return "$1\n";
      if (f === "#{pane_current_command}") return `${pane.cmd}\n`;
      if (f === "#{cursor_x} #{cursor_y} #{pane_width}") return "2 1 80\n";
      throw new Error(`unexpected ${f}`);
    }
    if (args[0] === "capture-pane") return pane.screen;
    if (args[0] === "list-clients") return pane.clients;
    throw new Error(`unexpected ${args[0]}`);
  };
  const { look, sessionId } = injector("%3", "77", { run, runStatus: () => 0, now: () => 5 });
  assert.equal(sessionId(), "$1");
  const r = look();
  assert.deepEqual([r.command, r.keyAt, r.at], ["codex", 1_700_000_000_999, 5]);
  pane.clients = "";
  assert.equal(look().keyAt, -Infinity, "nobody attached");
  pane.clients = "soon\n";
  assert.equal(look().keyAt, null, "unreadable: never a stall");
  pane.mode = "1";
  assert.equal(look(), null, "copy mode");
  pane.mode = "0";
  pane.screen = "some text\n\n<ctrl-c> copy · enter copy & follow · esc clear\n";
  assert.equal(look(), null, "the agent's transcript selection");
});

test("the injector's own identity not read at first: read again on a later tick, then kept; the watch starts then", (t) => {
  const home = tmp(t);
  let at = 0;
  const reads = [];
  const identity = () => {
    reads.push(at);
    return reads.length === 1 ? null : OWNER.injector;
  };
  const owner = injectorOwner("%3", { sessionId: () => "$1", identity });
  const started = [];
  const pane = { screen: "Do you want to proceed?\n❯ 1. Yes\n  2. No", command: "claude", keyAt: -Infinity, inputShown: false };
  const tick = waitWatch(home, "me-alice", { look: () => ({ ...pane, at }), unreadSince: () => null, owner, surface: { start: (r) => started.push(r) }, now: () => at });
  tick();
  assert.equal(started.length, 0);
  for (at = 500; at < 60_000; at += 500) tick();
  assert.deepEqual(reads, [0, 15_000], "once a tick while unknown, then kept");
  assert.equal(started.length, 1, "detection started on a later tick");
  assert.deepEqual(readOccurrence(home, "me-alice").owner, OWNER);
  // Kept once read; the tmux session id is read each time it is asked for.
  assert.deepEqual(owner(), OWNER);
  assert.equal(reads.length, 2);
});
