// Read without a reply (lib/unanswered.js): a sender is told once when the session that read its
// request ends its turn without a message back; the Stop hook's turn record (lib/wake.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createEngine } from "../lib/engine.js";
import { readSettings } from "../lib/settings.js";
import { AUTO_PREFIX, QUIET_MS, maybeSent, RETRY_MS, TRIES, TURN_GRACE_MS, isRequest, paneScreen, screenSince, unansweredText, unansweredTracker } from "../lib/unanswered.js";
import { filesFor, readTurnEnd } from "../lib/wake.js";
import { hostKey } from "../lib/host.js";
import { TOKEN, existingInstall, sleep, world } from "./helpers.js";

const R1 = "11111111-1111-4111-8111-111111111111";
const R2 = "22222222-2222-4222-8222-222222222222";
const R3 = "33333333-3333-4333-8333-333333333333";

test("isRequest: requests only; replies, owner-channel messages, command-line sends, @all and automated notices are not", () => {
  const m = { from: "lead", text: "please review", message_id: R1 };
  assert.equal(isRequest(m, "rev"), true);
  assert.equal(isRequest({ ...m, to: "@reviewer" }, "rev"), true);
  for (const x of [{ reply_to: R2 }, { owner: { result: "verified" } }, { noReply: true }, { to: "@all" }, { text: `${AUTO_PREFIX}, not a reply` }, { from: "rev" }, { from: "" }]) {
    assert.equal(isRequest({ ...m, ...x }, "rev"), false, JSON.stringify(x));
  }
});

test("tracker: due after a quiet pane or an ended turn, after the latest read; told once; any message back by name answers; failures retried, then dropped", () => {
  let t = 1_000_000;
  const u = unansweredTracker({ now: () => t });
  u.read([{ from: "lead", text: "a", message_id: R1 }, { from: "other", text: "c", message_id: R3 }], "rev");
  assert.equal(u.size(), 2);
  // Output after the read keeps it open; unknown signals never count.
  assert.deepEqual(u.due({ stillSince: t }), []);
  assert.deepEqual(u.due({}), []);
  // A second request from lead, read later: the quiet time counts from it.
  t += 30_000;
  u.read([{ from: "lead", text: "b", message_id: R2 }], "rev");
  t += QUIET_MS - 1;
  assert.deepEqual(u.due({ stillSince: 1_000_000 }).map((d) => d.to), ["other"]);
  u.answered("other");
  t += 1;
  const [d] = u.due({ stillSince: 1_000_000 });
  assert.deepEqual(d, { to: "lead", refs: [R1, R2], at: 1_030_000 });
  assert.equal(u.size(), 1, "due() changes nothing");
  // A send that failed is tried again after RETRY_MS, at most TRIES times.
  u.failed(d);
  assert.deepEqual(u.due({ stillSince: 0 }), []);
  t += RETRY_MS;
  assert.equal(u.due({ stillSince: 0 }).length, 1);
  assert.equal(u.still(d), true);
  u.told(d);
  assert.equal(u.size(), 0);
  // Redelivered (not acknowledged) copies of what was told or answered are not tracked again.
  u.read([{ from: "lead", text: "a", message_id: R1 }, { from: "other", text: "c", message_id: R3 }], "rev");
  assert.equal(u.size(), 0);
  // A request read after due() listed a sender: that notice is not sent (still() is false), and the
  // new one waits for its own turn end.
  const R4 = "44444444-4444-4444-8444-444444444444";
  const R5 = "55555555-5555-4555-8555-555555555555";
  u.read([{ from: "lead", text: "d", message_id: R4 }], "rev");
  t += QUIET_MS;
  const [d4] = u.due({ stillSince: 0 });
  t += 1;
  u.read([{ from: "lead", text: "e", message_id: R5 }], "rev");
  assert.equal(u.still(d4), false);
  // A turn that ended before the latest read is not its end; one after it counts after the grace.
  assert.deepEqual(u.due({ turnEnd: t - 1 }), []);
  assert.deepEqual(u.due({ turnEnd: t + 1 }), []);
  t += TURN_GRACE_MS + 1;
  const [d5] = u.due({ turnEnd: t - TURN_GRACE_MS });
  assert.deepEqual(d5.refs, [R4, R5]);
  // Given up after TRIES failures: dropped, and not tracked again.
  for (let i = 0; i < TRIES; i++) u.failed(d5);
  assert.equal(u.size(), 0);
  u.read([{ from: "lead", text: "e", message_id: R5 }], "rev");
  assert.equal(u.size(), 0);
});

test("tracker: no notice while a message to the sender is being sent; an older attempt's failure never drops a newer request", () => {
  let t = 0;
  const u = unansweredTracker({ now: () => t });
  u.read([{ from: "lead", text: "a", message_id: R1 }], "rev");
  t = QUIET_MS;
  const [d] = u.due({ stillSince: 0 });
  u.sending("lead");
  assert.equal(u.still(d), false, "a reply is on its way");
  u.sent("lead");
  assert.equal(u.still(d), true);
  // Four failures, then a new request read while the fifth attempt is out: that attempt's failure
  // does not count against the new request, which starts over.
  for (let i = 0; i < TRIES - 1; i++) u.failed(d);
  t += 1;
  u.read([{ from: "lead", text: "b", message_id: R2 }], "rev");
  u.failed(d);
  assert.equal(u.size(), 1);
  t += QUIET_MS;
  const [d2] = u.due({ stillSince: 0 });
  assert.deepEqual(d2.refs, [R1, R2]);
  for (let i = 0; i < TRIES - 1; i++) u.failed(d2);
  assert.equal(u.size(), 1, "its own tries");
});

test("maybeSent: the client's lost-answer errors (not sent again); a refusal or no connection is tried again", () => {
  const client = fs.readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
  for (const phrase of ["connection to relay lost", "the relay client was closed before the relay answered", "relay did not answer in time"]) {
    assert.ok(client.includes(phrase), phrase);
    assert.equal(maybeSent(`hoptell error: ${phrase}`), true);
  }
  assert.equal(maybeSent("hoptell error: not connected to relay ws://x"), false);
  assert.equal(maybeSent("hoptell error: unknown peer lead"), false);
});

test("unansweredText: an automated notice naming the reader, the references and the time, never more", () => {
  const s = unansweredText("rev-1", { refs: [R1], at: Date.UTC(2026, 10, 1, 9, 5) });
  assert.ok(s.startsWith(`${AUTO_PREFIX}, not a reply from rev-1. rev-1 read your message ${R1} at 09:05 UTC`));
  assert.match(unansweredText("rev-1", { refs: [R1, R2], at: 0 }), new RegExp(`your messages ${R1}, ${R2}`));
});

test("paneScreen and screenSince: the pane's text; unchanged text keeps its time, a change or the first read starts it; unknown is null", () => {
  assert.equal(paneScreen(undefined), null);
  assert.equal(paneScreen("x; rm"), null);
  assert.equal(paneScreen("%3", { run: () => ({ status: 0, stdout: "idle\n" }) }), "idle\n");
  assert.equal(paneScreen("%3", { run: () => ({ status: 1, stdout: "" }) }), null);
  let t = 100;
  let screen = "a";
  const since = screenSince(() => screen, { now: () => t });
  assert.equal(since(), 100);
  t = 200;
  assert.equal(since(), 100, "redrawn but unchanged");
  screen = "b";
  t = 300;
  assert.equal(since(), 300);
  screen = null;
  assert.equal(since(), null);
});

test("readTurnEnd: only the Stop record of the current registration (same process, session id and epoch)", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "hoptell-turn-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, "wake"), { mode: 0o700 });
  const host = { pid: 4242, start: "s", uid: process.getuid(), boot: "b" };
  const key = hostKey(host);
  const f = filesFor(fs.realpathSync(path.join(home, "wake")), key);
  const recs = new Map();
  const read = (file) => recs.get(file) ?? null;
  assert.equal(readTurnEnd(home, host, { read }), null);
  recs.set(f.reg, { key, host: { ...host }, session_id: "s1", epoch: "e1" });
  assert.equal(readTurnEnd(home, host, { read }), null, "no Stop record yet");
  recs.set(f.turn, { session_id: "s1", epoch: "e1", at: 5000 });
  assert.equal(readTurnEnd(home, host, { read }), 5000);
  assert.equal(readTurnEnd(home, { ...host, start: "other" }, { read }), null, "another process");
  assert.equal(readTurnEnd(home, { ...host, registration: { id: "x", epoch: "e0" } }, { read }), null, "an HTTP session bound to an older registration");
  for (const turn of [{ session_id: "s1", epoch: "old", at: 5000 }, { session_id: "s0", epoch: "e1", at: 5000 }, { session_id: "s1", epoch: "e1", at: "5000" }]) {
    recs.set(f.turn, turn);
    assert.equal(readTurnEnd(home, host, { read }), null, JSON.stringify(turn));
  }
});

const settingsFor = (env) => readSettings({ env, homedir: "/nonexistent-home", pid: process.pid, hostname: "testhost" });
async function until(fn, ms = 5000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(25)) if (await fn()) return true;
  return false;
}

test("engine: a request read and left without a reply tells its sender once, as a reply to it; a reply by name tells nothing", async (t) => {
  const w = await world();
  t.after(() => w.close());
  const home = existingInstall(fs.mkdtempSync(path.join(os.tmpdir(), "hoptell-unans-")));
  t.after(() => fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const base = { HOPTELL_RELAY: w.env.HOPTELL_RELAY, HOPTELL_TOKEN: TOKEN, HOPTELL_HOME: home, HOPTELL_PUSH: "listener", HOPTELL_RECEIPTS: "off" };
  let stillSince = null;
  const lead = createEngine(settingsFor({ ...base, HOPTELL_NAME: "lead" }), { findHost: () => null });
  const rev = createEngine(settingsFor({ ...base, HOPTELL_NAME: "rev" }), { findHost: () => null, turnSignals: () => ({ stillSince }), unansweredTiming: { quietMs: 300, checkMs: 20 } });
  t.after(() => Promise.all([lead.stop(), rev.stop()]));
  await Promise.all([lead.start(), rev.start()]);
  assert.ok(await until(() => lead.session.state === "bound" && rev.session.state === "bound"));
  const ref = (r) => r.content[0].text.match(/Message reference: ([0-9a-f-]{36})/)[1];
  const sent = await lead.call("send_message", { to: "rev", message: "please review" });
  const first = ref(sent);
  let got = "";
  assert.ok(await until(async () => /please review/.test((got += (await rev.call("read_inbox")).content[0].text))));
  // Busy (output again and again): nothing yet. Quiet for quietMs: told once.
  for (let i = 0; i < 8; i++) {
    stillSince = Date.now();
    await sleep(50);
  }
  let seen = "";
  const inbox = async () => (seen += (await lead.call("read_inbox")).content[0].text);
  await inbox();
  assert.doesNotMatch(seen, /automated notice/);
  assert.ok(await until(async () => /automated notice, not a reply from rev/.test(await inbox())));
  assert.match(seen, new RegExp(`read your message ${first}`));
  assert.match(seen, new RegExp(`In reply to: ${first}`));
  await sleep(150);
  seen = "";
  await inbox();
  assert.doesNotMatch(seen, /automated notice/, "once");
  // The notice is itself not a request: the lead reading it tells the reviewer nothing (no tracker
  // signals on the lead). A second request answered by name tells nothing.
  await lead.call("send_message", { to: "rev", message: "second" });
  got = "";
  assert.ok(await until(async () => /second/.test((got += (await rev.call("read_inbox")).content[0].text))));
  await rev.call("send_message", { to: "lead", message: "on it" });
  await sleep(150);
  seen = "";
  assert.ok(await until(async () => /on it/.test(await inbox())));
  await sleep(150);
  await inbox();
  assert.doesNotMatch(seen, /automated notice/);
  // A lead tells nothing: it waits on its user as part of a team's work.
  const boss = createEngine(settingsFor({ ...base, HOPTELL_NAME: "boss", HOPTELL_ROLES: "lead" }), { findHost: () => null, turnSignals: () => ({ stillSince: 0 }), unansweredTiming: { quietMs: 50, checkMs: 20 } });
  t.after(() => boss.stop());
  await boss.start();
  assert.ok(await until(() => boss.session.state === "bound"));
  await rev.call("send_message", { to: "boss", message: "ready for review" });
  got = "";
  assert.ok(await until(async () => /ready for review/.test((got += (await boss.call("read_inbox")).content[0].text))));
  await sleep(300);
  assert.doesNotMatch((await rev.call("read_inbox")).content[0].text, /automated notice/);
});
