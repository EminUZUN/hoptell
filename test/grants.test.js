// Auto-land grants (lib/grants.js, design 8 addendum option 6): the scope's exact shape, the
// record kept create-only, the status a grant has (every condition read afresh, final states stay
// final), revocation by generation that also covers grants not seen yet, slots, notices and durations.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GRANT_MAX_MS, NOT_BEFORE_SKEW_MS, NOTICES_MAX, checkGrant, grantText, leftText, newGrantId, noticeText, parseDuration, parseGrant, parseNotice, queueNotice, readGrant, readGrantState, reserveSlot, revoke, scopeProblem, settleGrants, statusOf, storeGrant, writeGrantState } from "../lib/grants.js";

const NOW = Date.parse("2026-10-29T10:00:00Z");
const S = { lead: "dana-lead", run: "a".repeat(32), status: "up", enrolment: { common: "/srv/app/.git", id: "e".repeat(32), generation: 1 } };
const scopeOf = (extra = {}) => ({ hoptell_landing_grant: 1, id: newGrantId(), team: "n4", run: S.run, generation: 0, enrolment: S.enrolment, recipient: null, targets: ["main"], issued_at: NOW, not_before: NOW, expires_at: NOW + 2 * 60 * 60_000, max_count: null, op: "land", origin: null, ...extra });
const homeOf = (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "hoptell-grants-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
};

test("a grant's scope has exactly its fields: frozen sorted targets, at most 24 hours, the operation land", () => {
  assert.equal(scopeProblem(scopeOf()), null);
  for (const [why, extra] of [
    ["targets", { targets: [] }],
    ["targets", { targets: ["main", "dev"] }],
    ["targets", { targets: ["main", "main"] }],
    ["targets", { targets: ["../x"] }],
    ["times", { expires_at: NOW + GRANT_MAX_MS + 1 }],
    ["times", { not_before: NOW - 1 }],
    ["times", { expires_at: NOW }],
    ["max_count", { max_count: 0 }],
    ["op", { op: "push" }],
    ["run", { run: "x" }],
    ["generation", { generation: -1 }],
    ["keys", { any: true }],
  ])
    assert.equal(scopeProblem(scopeOf(extra)), why, JSON.stringify(extra));
  const g = scopeOf({ targets: ["dev", "main"] });
  assert.deepEqual(parseGrant(grantText(g)), g);
  assert.equal(parseGrant(JSON.stringify(g, null, 1)), null, "only the canonical text");
});

test("a grant's record is create-only and checked when read; a changed record is refused", (t) => {
  const home = homeOf(t);
  const g = scopeOf();
  const kept = storeGrant(home, "n4", { source: "terminal", scope: g });
  assert.deepEqual(storeGrant(home, "n4", { source: "terminal", scope: g }), kept, "the same again");
  assert.throws(() => storeGrant(home, "n4", { source: "terminal", scope: { ...g, targets: ["dev", "main"] } }), /already holds another grant/);
  assert.throws(() => storeGrant(home, "n4", { source: "telegram", scope: scopeOf() }), /signed envelope/);
  assert.equal(readGrant(home, "n4", g.id).digest, kept.digest);
  const file = path.join(home, "teams", "n4", "grants", `${g.id}.json`);
  // Another valid record in its place has another digest, which the action approved by it names.
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace('"main"', '"dev"'));
  assert.notEqual(readGrant(home, "n4", g.id).digest, kept.digest);
  fs.writeFileSync(file, ` ${fs.readFileSync(file, "utf8")}`);
  assert.throws(() => readGrant(home, "n4", g.id), /not a valid grant record/);
});

test("a grant's status is read afresh: a revocation, a new run or the expiry show even for a grant whose count ran out; only the count exempts an action's own slot", (t) => {
  const home = homeOf(t);
  const gs = readGrantState(home, "n4");
  const check = (g, extra) => checkGrant(home, "n4", S, gs, { id: g.scope.id, digest: g.digest, phase: "accept", target: "main", now: NOW, pinFor: () => null, ...extra });
  const a = readGrant(home, "n4", storeGrant(home, "n4", { source: "terminal", scope: scopeOf({ max_count: 1 }) }).id);
  assert.equal(statusOf(a, gs, S, NOW), "active");
  assert.equal(statusOf(a, gs, { ...S, run: "b".repeat(32) }, NOW), "retired");
  assert.equal(statusOf(a, gs, { ...S, status: "down" }, NOW), "retired");
  assert.equal(statusOf(a, gs, S, a.scope.expires_at), "expired");
  reserveSlot(gs, a, "L1");
  reserveSlot(gs, a, "L1");
  assert.deepEqual(gs.grants[a.scope.id], { status: "exhausted", actions: [], slots: ["L1"], noticed: [] }, "one slot per action");
  assert.equal(check(a, { action: "L1" }).scope.id, a.scope.id, "the action that holds the slot goes on");
  assert.throws(() => check(a, { action: "L2" }), /has no landings left/);
  // Exhausted, yet each of these still refuses the action that holds the slot.
  assert.throws(() => check(a, { action: "L1", now: a.scope.expires_at }), /expired/);
  assert.throws(() => checkGrant(home, "n4", { ...S, status: "down" }, gs, { id: a.scope.id, digest: a.digest, phase: "move", action: "L1", now: NOW, pinFor: () => null }), /was for an earlier run/);
  revoke(home, "n4", gs, S, NOW);
  assert.equal(statusOf(a, gs, S, NOW), "revoked", "the revocation shows over exhausted");
  assert.throws(() => checkGrant(home, "n4", S, gs, { id: a.scope.id, digest: a.digest, phase: "move", action: "L1", now: NOW, pinFor: () => null }), /the owner turned auto-land off/);
  // A grant of the earlier generation, seen only now and dated after the revocation: revoked.
  const late = readGrant(home, "n4", storeGrant(home, "n4", { source: "terminal", scope: scopeOf({ issued_at: NOW + 3 * 60_000, not_before: NOW + 3 * 60_000, generation: 0 }) }).id);
  assert.equal(statusOf(late, gs, S, NOW + 3 * 60_000), "revoked");
  const fresh = readGrant(home, "n4", storeGrant(home, "n4", { source: "terminal", scope: scopeOf({ generation: 1 }) }).id);
  assert.equal(statusOf(fresh, gs, S, NOW), "active");
  writeGrantState(home, "n4", gs);
  const back = readGrantState(home, "n4");
  assert.equal(back.generation, 1);
  settleGrants(home, "n4", back, S, NOW);
  assert.equal(back.grants[late.scope.id].status, "revoked");
  assert.equal(back.grants[fresh.scope.id].status, "active");
  assert.throws(() => checkGrant(home, "n4", S, back, { id: fresh.scope.id, digest: "0".repeat(64), phase: "resume", now: NOW, pinFor: () => null }), /not the one this landing was approved by/);
});

test("a bridge clock ahead: not_before may be up to two minutes in this Mac's future; the expiry has no allowance", (t) => {
  const home = homeOf(t);
  const gs = readGrantState(home, "n4");
  const at = (ahead) => readGrant(home, "n4", storeGrant(home, "n4", { source: "terminal", scope: scopeOf({ issued_at: NOW + ahead, not_before: NOW + ahead, expires_at: NOW + ahead + 60 * 60_000 }) }).id);
  const check = (g, now) => checkGrant(home, "n4", S, gs, { id: g.scope.id, digest: g.digest, phase: "accept", target: "main", now, pinFor: () => null });
  assert.equal(NOT_BEFORE_SKEW_MS, 120_000);
  const sixty = at(60_000);
  assert.equal(check(sixty, NOW).scope.id, sixty.scope.id, "60 s ahead: accepted");
  assert.equal(check(at(NOT_BEFORE_SKEW_MS), NOW).scope.not_before, NOW + NOT_BEFORE_SKEW_MS, "the edge: accepted");
  assert.throws(() => check(at(NOT_BEFORE_SKEW_MS + 1), NOW), /is not valid yet/);
  assert.throws(() => check(sixty, sixty.scope.expires_at), /expired/, "an hour from the bridge's issue time, not from this Mac's");
});

test("notices, durations and time left", () => {
  const n = { digest: "d".repeat(64), id: "L9", team: "n4", target: "main", state: "landed", left_s: 4800 };
  assert.deepEqual(parseNotice(noticeText(n)), n);
  assert.throws(() => noticeText({ ...n, state: "moving" }), /malformed/);
  const gs = { notices: [] };
  queueNotice(gs, n);
  queueNotice(gs, n);
  queueNotice(gs, { ...n, state: "blocked", left_s: null });
  assert.deepEqual(gs.notices.map((x) => x.state), ["landed", "blocked"], "one per action and state");
  // Never dropped unsent: past NOTICES_MAX they all stay.
  for (let i = 1; i <= NOTICES_MAX + 5; i++) queueNotice(gs, { ...n, id: `L${100 + i}`, digest: i.toString(16).padStart(64, "0") });
  assert.equal(gs.notices.length, NOTICES_MAX + 7);
  assert.equal(parseDuration("2h"), 2 * 60 * 60_000);
  assert.equal(parseDuration("90m"), 90 * 60_000);
  assert.equal(parseDuration("25h"), null);
  assert.equal(parseDuration("0h"), null);
  assert.equal(parseDuration("2d"), null);
  assert.equal(leftText(80 * 60_000), "1 h 20 min");
  assert.equal(leftText(2 * 60 * 60_000), "2 h");
  assert.equal(leftText(45 * 60_000 + 59_000), "45 min");
  assert.equal(leftText(30_000), "under a minute");
});
