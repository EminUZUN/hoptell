// The append-only session events of a Claude Code process (lib/sessionevents.js, design 10).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { EVENTS_MAX, EVENT_MAX_BYTES, appendSessionEvent, eventsFile, readSessionEvents } from "../lib/sessionevents.js";

const tmpDir = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hoptell-events-"));
  fs.chmodSync(dir, 0o700);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const KEY = "0123456789abcdef0123456789abcdef";

test("events: none, then each appended line, as a set of ids with their sources", (t) => {
  const dir = tmpDir(t);
  assert.deepEqual(readSessionEvents(dir, KEY), { state: "none" });
  assert.equal(appendSessionEvent(dir, KEY, { session_id: "conv-a", source: "startup" }), true);
  assert.equal(appendSessionEvent(dir, KEY, { session_id: "conv-b", source: "clear" }), true);
  assert.equal(appendSessionEvent(dir, KEY, { session_id: "conv-a", source: "resume" }), true);
  const r = readSessionEvents(dir, KEY);
  assert.equal(r.state, "ok");
  assert.deepEqual(r.events, [{ session_id: "conv-a", source: "startup" }, { session_id: "conv-b", source: "clear" }, { session_id: "conv-a", source: "resume" }]);
  assert.deepEqual([...r.ids.keys()], ["conv-a", "conv-b"]);
  assert.deepEqual([...r.ids.get("conv-a")].sort(), ["resume", "startup"]);
  assert.equal(fs.statSync(eventsFile(dir, KEY)).mode & 0o777, 0o600);
});

test("events: an unknown source is kept as empty; an unusable id makes the log unreadable", (t) => {
  const dir = tmpDir(t);
  assert.equal(appendSessionEvent(dir, KEY, { session_id: "ok", source: "Weird Source!" }), true);
  assert.deepEqual(readSessionEvents(dir, KEY).events, [{ session_id: "ok", source: "" }]);
  for (const [i, session_id] of ["../x", "x".repeat(129), 7].entries()) {
    const key = `bad${i}`;
    appendSessionEvent(dir, key, { session_id: "ok", source: "startup" });
    assert.equal(appendSessionEvent(dir, key, { session_id }), false);
    assert.equal(readSessionEvents(dir, key).state, "unreadable", `never a set without ${String(session_id)}`);
  }
});

test("events: lines over the byte limit and fields of the wrong type are unreadable", (t) => {
  const dir = tmpDir(t);
  const put = (text) => fs.writeFileSync(eventsFile(dir, KEY), text, { mode: 0o600 });
  const good = JSON.stringify({ session_id: "a", source: "startup" });
  put(`${good}${" ".repeat(EVENT_MAX_BYTES - good.length - 1)}\n`);
  assert.equal(readSessionEvents(dir, KEY).state, "ok", "exactly the limit, with its newline");
  put(`${good}${" ".repeat(EVENT_MAX_BYTES - good.length)}\n`);
  assert.equal(readSessionEvents(dir, KEY).state, "unreadable", "one byte over");
  put(`${good}${" ".repeat(600)}\n`);
  assert.equal(readSessionEvents(dir, KEY).state, "unreadable");
  put(`${JSON.stringify({ session_id: 7, source: "startup" })}\n`);
  assert.equal(readSessionEvents(dir, KEY).state, "unreadable", "a number for the id");
  put(`${JSON.stringify({ session_id: ["a"], source: "startup" })}\n`);
  assert.equal(readSessionEvents(dir, KEY).state, "unreadable", "an array for the id");
});

test("events: a FIFO in place of the log never blocks the writer or the reader", { skip: process.platform === "win32" }, (t) => {
  const dir = tmpDir(t);
  execFileSync("mkfifo", ["-m", "600", eventsFile(dir, KEY)]);
  const mod = new URL("../lib/sessionevents.js", import.meta.url).href;
  const code = `const m = await import(${JSON.stringify(mod)}); let w; try { w = m.appendSessionEvent(${JSON.stringify(dir)}, ${JSON.stringify(KEY)}, { session_id: "a", source: "startup" }); } catch (e) { w = e.code; } console.log(JSON.stringify([w, m.readSessionEvents(${JSON.stringify(dir)}, ${JSON.stringify(KEY)}).state]));`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8", timeout: 10_000 });
  assert.equal(r.signal, null, "it returned instead of waiting for a reader");
  assert.deepEqual(JSON.parse(r.stdout), [false, "unreadable"]);
});

test("events: the writer stops at the limit and a reader says full; unsafe, torn or malformed files are unreadable", (t) => {
  const dir = tmpDir(t);
  const id = "s".repeat(128);
  for (let i = 0; i < EVENTS_MAX - 1; i++) assert.equal(appendSessionEvent(dir, KEY, { session_id: `e${i}`, source: "clear" }), true);
  assert.equal(readSessionEvents(dir, KEY).state, "ok", `${EVENTS_MAX - 1} lines`);
  assert.equal(appendSessionEvent(dir, KEY, { session_id: "last", source: "clear" }), true);
  assert.equal(readSessionEvents(dir, KEY).state, "full", `${EVENTS_MAX} lines: a later event may be missing`);
  // The writer's byte limit takes more than EVENTS_MAX of the longest lines: when it stops, the
  // log already reads as full.
  let n = EVENTS_MAX;
  while (appendSessionEvent(dir, KEY, { session_id: id, source: "compact" })) n++;
  assert.ok(n > EVENTS_MAX);
  assert.equal(readSessionEvents(dir, KEY).state, "full");

  const k2 = "k2";
  fs.writeFileSync(eventsFile(dir, k2), '{"session_id":"a","source":"startup"}\n{"session_id":"b"', { mode: 0o600 });
  assert.equal(readSessionEvents(dir, k2).state, "unreadable", "a torn last line");
  fs.writeFileSync(eventsFile(dir, k2), "not json\n", { mode: 0o600 });
  assert.equal(readSessionEvents(dir, k2).state, "unreadable");
  fs.writeFileSync(eventsFile(dir, k2), '{"session_id":"a","source":"startup"}\n', { mode: 0o644 });
  fs.chmodSync(eventsFile(dir, k2), 0o644);
  assert.equal(readSessionEvents(dir, k2).state, "unreadable", "readable by others");
  assert.equal(appendSessionEvent(dir, k2, { session_id: "b" }), false, "nor appended to");
  const k3 = "k3";
  fs.writeFileSync(path.join(dir, "elsewhere"), '{"session_id":"a","source":"startup"}\n', { mode: 0o600 });
  fs.symlinkSync(path.join(dir, "elsewhere"), eventsFile(dir, k3));
  assert.equal(readSessionEvents(dir, k3).state, "unreadable", "a symlink");
  assert.throws(() => appendSessionEvent(dir, k3, { session_id: "b" }), /ELOOP|symbolic/);
  const k4 = "k4";
  fs.writeFileSync(eventsFile(dir, k4), '{"session_id":"a","source":"startup"}\n', { mode: 0o600 });
  fs.linkSync(eventsFile(dir, k4), path.join(dir, "second-link"));
  assert.equal(readSessionEvents(dir, k4).state, "unreadable", "a second hard link");
});

test("events: concurrent writers in separate processes never tear or lose a line", async (t) => {
  const dir = tmpDir(t);
  const mod = new URL("../lib/sessionevents.js", import.meta.url).href;
  const writer = (w) =>
    new Promise((resolve, reject) => {
      const code = `const { appendSessionEvent } = await import(${JSON.stringify(mod)}); for (let i = 0; i < 12; i++) appendSessionEvent(${JSON.stringify(dir)}, ${JSON.stringify(KEY)}, { session_id: "w${w}-" + i + "-" + "p".repeat(100), source: "startup" });`;
      const p = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: "inherit" });
      p.on("exit", (c) => (c === 0 ? resolve() : reject(new Error(`writer ${w} exited ${c}`))));
    });
  await Promise.all([0, 1, 2, 3, 4].map(writer));
  const r = readSessionEvents(dir, KEY);
  assert.equal(r.state, "ok");
  assert.equal(r.events.length, 60);
  assert.equal(r.ids.size, 60);
});
