// A lead's team summary (design 8, 3.2): published as the lead's own owner-only status (cap
// "status"), listed by the relay only to the same member, and shown read-only by the bridge's
// /team and the Mini App, always under the session that published it. Test relays, a fake Bot API
// and isolated homes only.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startRelay } from "../lib/relay.js";
import { RelayClient } from "../lib/client.js";
import { STATUS_MAX_BYTES } from "../lib/config.js";
import { SUMMARY_LIMITS, fitSummary, ownTeams, parseTeamStatus } from "../lib/teamstatus.js";
import { leadStatus, teamPaths } from "../lib/teams.js";
import { createEngine } from "../lib/engine.js";
import { readSettings } from "../lib/settings.js";
import { BOB, ME, REALM, agent, appClient, appSet, bridgeOn, fakeTelegram, newKey, ownerRelay, paired, tmpHome, until } from "./owner-helpers.js";
import { fakeToken, sleep, world } from "./helpers.js";
import { spawn } from "node:child_process";
import { processIdentity } from "../lib/host.js";

const member = (over = {}) => ({ name: "me-n1-impl", role: "implementer", cli: "codex", model: "gpt-5", effort: "high", branch: "team/n1/me-n1-impl", state: "working", ...over });
const team = (over = {}) => ({ team: "n1", status: "up", members: [member(), member({ name: "me-n1-rev", role: "reviewer", cli: "claude", model: null, effort: null, branch: null, state: "in review" })], more: 0, reviews: [{ id: "rv-0123abcd", member: "me-n1-impl", waiting: ["me-n1-rev"] }], ...over });
const summary = (teams = [team()]) => JSON.stringify({ v: 1, teams });

async function relayWithShared(t) {
  const tokens = { me: fakeToken(), bob: fakeToken(), shared: fakeToken() };
  const relay = await startRelay({ host: "127.0.0.1", port: 0, token: tokens.shared, members: [{ name: "me", id: ME, token: tokens.me }, { name: "bob", id: BOB, token: tokens.bob }], realm: { id: REALM, name: "local" }, log: () => {} });
  t.after(() => relay.close());
  return { tokens, url: `ws://127.0.0.1:${relay.port}` };
}
async function client(t, url, token, name, opts = {}) {
  const c = new RelayClient({ url, token, name, reconnect: false, ...opts });
  t.after(() => c.close());
  await c.start().ready();
  return c;
}
const byName = (list) => Object.fromEntries(list.map((p) => [p.name, p]));

// ---- the relay ----------------------------------------------------------------------------------

test("relay: a status is listed only to the same member, only when asked; other members, shared tokens and a shared-token holder of a member-shaped name see none", async (t) => {
  const r = await relayWithShared(t);
  const lead = await client(t, r.url, r.tokens.me, "me-lead");
  const fake = await client(t, r.url, r.tokens.shared, "me-fake"); // a name's shape proves nothing
  const bobLead = await client(t, r.url, r.tokens.bob, "bob-lead");
  assert.ok(lead.caps.includes("status"));
  assert.equal(await lead.setStatus(summary()), true);
  assert.equal(lead.statusAtRelay, summary());
  assert.equal(await fake.setStatus(summary()), true);
  assert.equal(await bobLead.setStatus(summary([team({ team: "zz", members: [member({ name: "bob-n1-impl" })], reviews: [] })])), true);

  const me = await client(t, r.url, r.tokens.me, "me-viewer");
  assert.equal(byName(await me.list())["me-lead"].status, undefined, "not without asking");
  const mine = byName(await me.list({ status: true }));
  assert.equal(mine["me-lead"].status, summary());
  assert.equal(mine["me-lead"].own, true);
  assert.equal(mine["me-fake"].own, false);
  assert.equal(mine["me-fake"].status, undefined, "set by a shared token: not the member's");
  assert.equal(mine["bob-lead"].status, undefined, "another member's");
  const bob = byName(await (await client(t, r.url, r.tokens.bob, "bob-viewer")).list({ status: true }));
  assert.equal(bob["me-lead"].status, undefined);
  assert.equal(typeof bob["bob-lead"].status, "string");
  const shared = byName(await (await client(t, r.url, r.tokens.shared, "viewer")).list({ status: true }));
  assert.ok(Object.values(shared).every((p) => p.status === undefined), "a shared token sees no status");

  // null clears it.
  assert.equal(await lead.setStatus(null), true);
  assert.equal(byName(await me.list({ status: true }))["me-lead"].status, undefined);
});

test("relay: set_status only from the connection that holds the name, within the size, as well-formed text; a new claim starts without one", async (t) => {
  const r = await relayWithShared(t);
  const lead = await client(t, r.url, r.tokens.me, "me-lead");
  const refused = async (c, status, code) => {
    await assert.rejects(c.rpc({ type: "set_status", status }), (e) => e.code === code);
  };
  const sender = await client(t, r.url, r.tokens.me, "me-lead", { mode: "send" });
  assert.equal(await sender.setStatus("x"), false, "the client sends nothing from a send-only connection");
  await refused(sender, "x", "not_allowed");
  await refused(lead, "x".repeat(STATUS_MAX_BYTES + 1), "bad_request");
  await refused(lead, "\uD800", "bad_request");
  await refused(lead, 42, "bad_request");
  await lead.setStatus("x".repeat(STATUS_MAX_BYTES));
  const viewer = await client(t, r.url, r.tokens.me, "me-viewer");
  assert.equal(byName(await viewer.list({ status: true }))["me-lead"].status.length, STATUS_MAX_BYTES);
  // The session ends; a new session of the same name is a new claim.
  lead.close();
  await sleep(100);
  const again = await client(t, r.url, r.tokens.me, "me-lead", { replace: true });
  assert.equal(again.statusAtRelay, null);
  assert.equal(byName(await viewer.list({ status: true }))["me-lead"].status, undefined);
});

// ---- the summary's shape ------------------------------------------------------------------------

test("parse: exactly the shape, members under the publisher's prefix only; text cleaned; anything else ignored whole", () => {
  const ok = parseTeamStatus(summary(), "me-lead");
  assert.equal(ok.teams[0].members.length, 2);
  assert.equal(ok.teams[0].members[1].model, null);
  // Control, format and bidi characters and line breaks become spaces.
  const hostile = parseTeamStatus(summary([team({ members: [member({ model: "gpt\u202Eevil\nnext\u0007", branch: "a\u2028b" })], reviews: [] })]), "me-lead");
  assert.equal(hostile.teams[0].members[0].model, "gpt evil next");
  assert.equal(hostile.teams[0].members[0].branch, "a b");
  const bad = [
    "not json",
    JSON.stringify({ v: 2, teams: [] }),
    JSON.stringify({ v: 1, teams: [team()], lead: "me-lead" }), // no field beyond the shape (a lead field included)
    summary([team({ lead: "me-other" })]),
    summary([team({ members: [member({ name: "bob-n1-impl" })], reviews: [] })]), // not under me-
    summary([team({ members: [member({ name: "me-lead" })], reviews: [] })]), // the publisher itself
    summary([team({ members: [member({ role: "lead" })], reviews: [] })]),
    summary([team({ members: [member({ state: "merged" })], reviews: [] })]),
    summary([team({ members: [member({ model: "x".repeat(SUMMARY_LIMITS.model + 1) })], reviews: [] })]),
    summary([team({ team: "Bad Team" })]),
    summary([team({ reviews: [{ id: "rv-1", member: "me-n1-impl", waiting: ["me-n1-rev"] }] })]),
    summary([team({ reviews: [{ id: "rv-0123abcd", member: "bob-x", waiting: ["me-n1-rev"] }] })]),
    // A review names an implementer of the team's own list and waits for its reviewers.
    summary([team({ reviews: [{ id: "rv-0123abcd", member: "me-n1-impl", waiting: [] }] })]),
    summary([team({ reviews: [{ id: "rv-0123abcd", member: "me-n1-x", waiting: ["me-n1-rev"] }] })]),
    summary([team({ reviews: [{ id: "rv-0123abcd", member: "me-n1-impl", waiting: ["me-n1-x"] }] })]),
    summary([team({ reviews: [{ id: "rv-0123abcd", member: "me-n1-rev", waiting: ["me-n1-rev"] }] })]),
    summary([team({ reviews: [{ id: "rv-0123abcd", member: "me-n1-impl", waiting: ["me-n1-impl"] }] })]),
    summary([team(), team()]), // the same team twice
    summary(Array.from({ length: SUMMARY_LIMITS.teams + 1 }, (_, i) => team({ team: `t${i}` }))),
    `${summary().slice(0, -1)}${" ".repeat(STATUS_MAX_BYTES)}}`,
  ];
  for (const b of bad) assert.equal(parseTeamStatus(b, "me-lead"), null, b.slice(0, 120));
  assert.equal(parseTeamStatus(summary(), "not a name"), null);
});

test("fit: the largest summary stays within the relay's limit; open reviews go first, then members, counted", () => {
  const long = (i, j) => member({ name: `me-${"x".repeat(40)}-${i}-${j}`, cli: "c".repeat(16), model: "m".repeat(64), effort: "e".repeat(32), branch: "b".repeat(100) });
  const teams = Array.from({ length: SUMMARY_LIMITS.teams }, (_, i) => ({
    team: `t${i}`,
    status: "up",
    members: Array.from({ length: 16 }, (_, j) => long(i, j)),
    more: 0,
    reviews: Array.from({ length: 5 }, (_, k) => ({ id: `rv-0000000${k}`, member: long(i, 0).name, waiting: Array.from({ length: 16 }, (_, j) => long(i, j).name) })),
  }));
  const doc = fitSummary({ v: 1, teams });
  const text = JSON.stringify(doc);
  assert.ok(Buffer.byteLength(text) <= STATUS_MAX_BYTES);
  assert.ok(doc.teams.every((x) => x.reviews.length === 0));
  assert.ok(doc.teams.some((x) => x.more > 0));
  assert.ok(doc.teams.every((x) => x.members.length + x.more === 16), "every member left out is counted");
  assert.notEqual(parseTeamStatus(text, "me-lead"), null, "what fits still parses");
});

test("ownTeams: each team under the session that published it; a name two sessions both list is under neither, also as a review's name; unusable summaries are skipped", () => {
  const rev = (name) => member({ name, role: "reviewer", cli: "claude", model: null, effort: null, branch: null, state: "ready" });
  const names = (x) => x.members.map((m) => m.name);
  // A reviewer one lead's open review waits for, listed by another lead as its own member.
  const reviewSide = ownTeams([
    { name: "me-lead", status: summary() },
    { name: "me-other", status: summary([team({ team: "n2", members: [member({ name: "me-n2-impl" }), rev("me-n1-rev")], reviews: [{ id: "rv-0000000a", member: "me-n2-impl", waiting: ["me-n1-rev"] }] })]) },
    { name: "me-broken", status: "{" },
    { name: "me-plain" },
  ]);
  assert.deepEqual(
    reviewSide.map((x) => [x.lead, x.team, names(x), x.more, x.reviews.length]),
    [
      ["me-lead", "n1", ["me-n1-impl"], 1, 0],
      ["me-other", "n2", ["me-n2-impl"], 1, 0],
    ],
  );
  // The other way: the implementer an open review is of, listed by another lead (a later one).
  const memberSide = ownTeams([
    { name: "me-lead", status: summary() },
    { name: "me-zed", status: summary([team({ team: "n7", members: [member()], reviews: [] })]) },
  ]);
  assert.deepEqual(
    memberSide.map((x) => [x.lead, names(x), x.more, x.reviews.length]),
    [
      ["me-lead", ["me-n1-rev"], 1, 0],
      ["me-zed", [], 1, 0],
    ],
  );
  // Without a dispute every review stays.
  assert.equal(ownTeams([{ name: "me-lead", status: summary() }])[0].reviews.length, 1);
});

// ---- the lead's side: the summary from the team state -------------------------------------------

function stateOf(teamName, members, extra = {}) {
  return { version: 1, team: teamName, file: "/x/team.json", fileDigest: "0".repeat(64), lead: "dana-lead", prefix: "dana", repo: "/x/repo", base: "HEAD", worktrees: null, idleMinutes: null, status: "up", created: new Date(0).toISOString(), members, supervisor: null, candidate: null, landing: null, publishing: null, landed: [], reviews: [], events: [], ...extra };
}
const session = (n) => ({ id: `$${n}`, pane: `%${n}`, pid: 1000 + n, root: { pid: 1000 + n, start: "Mon Oct 28 10:00:00 2026", uid: 501, boot: "b" }, started: new Date(0).toISOString() });
function memberRow(name, role, n, extra = {}) {
  return { name, role, cli: "claude", model: null, effort: null, template: role, owns: null, folder: null, lifetimeMinutes: null, argv: ["claude"], taskDigest: null, cwd: "/x/repo", worktree: null, branch: null, registration: null, session: n ? session(n) : null, ended: null, notice: null, ...extra };
}
const writeTeam = (home, s) => {
  fs.mkdirSync(teamPaths(home, s.team).dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(teamPaths(home, s.team).state, JSON.stringify(s), { mode: 0o600 });
};
const C = "c".repeat(40);
const T = "a".repeat(40);
const review = (id, memberName, head, reviewers, verdicts = []) => ({ id, base: T, head, member: memberName, reviewers, at: new Date(0).toISOString(), verdicts: verdicts.map(([reviewer, verdict]) => ({ reviewer, verdict, at: new Date(0).toISOString() })) });

test("leadStatus: the teams this session leads that are not down; states from the sessions and the review queue; nothing for another lead", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "hoptell-teamstatus-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const alive = new Set([1, 2, 3, 4]);
  const deps = { state: (root) => (alive.has(root.pid - 1000) ? "same" : "different"), table: () => [] };
  writeTeam(
    home,
    stateOf(
      "n1",
      [
        memberRow("dana-impl-1", "implementer", 1, { cli: "codex", model: "gpt-5", effort: "high", branch: "team/n1/dana-impl-1" }),
        memberRow("dana-impl-2", "implementer", 2),
        memberRow("dana-rev-1", "reviewer", 3),
        memberRow("dana-rev-2", "reviewer", 4),
        memberRow("dana-rev-3", "reviewer", 5), // its process is gone
        memberRow("dana-rev-4", "reviewer", 0), // never started
      ],
      {
        candidate: { member: "dana-impl-1", H: "b".repeat(40), C, T, target: "main", at: new Date(0).toISOString() },
        reviews: [review("rv-00000001", "dana-impl-1", C, ["dana-rev-1", "dana-rev-2"], [["dana-rev-1", "approve"], ["dana-rev-2", "approve"]]), review("rv-00000002", "dana-impl-2", C, ["dana-rev-1", "dana-rev-2"], [["dana-rev-1", "approve"]])],
      },
    ),
  );
  writeTeam(home, stateOf("n2", [memberRow("dana-x", "reviewer", 0)], { status: "down" }));
  writeTeam(home, stateOf("n3", [memberRow("erin-x", "reviewer", 0)], { lead: "erin-lead", prefix: "erin" }));
  const raw = leadStatus(home, "dana-lead", deps);
  const doc = JSON.parse(raw);
  assert.deepEqual(
    doc.teams.map((x) => x.team),
    ["n1"],
    "n2 is down, n3 has another lead",
  );
  const states = Object.fromEntries(doc.teams[0].members.map((m) => [m.name, m.state]));
  // dana-impl-1 has no recorded head (no worktree record): its candidate's review does not count.
  assert.deepEqual(states, { "dana-impl-1": "working", "dana-impl-2": "working", "dana-rev-1": "ready", "dana-rev-2": "in review", "dana-rev-3": "exited", "dana-rev-4": "exited" });
  assert.deepEqual(doc.teams[0].members[0], { name: "dana-impl-1", role: "implementer", cli: "codex", model: "gpt-5", effort: "high", branch: "team/n1/dana-impl-1", state: "working" });
  assert.equal(doc.teams[0].members[1].model, null, "the CLI's default");
  assert.deepEqual(doc.teams[0].reviews, [{ id: "rv-00000002", member: "dana-impl-2", waiting: ["dana-rev-2"] }]);
  assert.notEqual(parseTeamStatus(raw, "dana-lead"), null);
  assert.equal(leadStatus(home, "erin-lead", deps) === null, false);
  assert.equal(leadStatus(home, "dana-impl-1", deps), null, "a member leads nothing");
  // An unreadable state is left out; a missing teams folder is no summary.
  fs.writeFileSync(teamPaths(home, "n3").state, "{", { mode: 0o600 });
  assert.equal(leadStatus(home, "erin-lead", deps), null);
  assert.equal(leadStatus(path.join(home, "nowhere"), "dana-lead", deps), null);
});

test("leadStatus: an implementer's state follows the review of its recorded head; a candidate's review counts only while the candidate is of that head", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "hoptell-teamstatus-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const R = fs.realpathSync(home);
  const [H1, H2, C1] = ["1", "2", "3"].map((c) => c.repeat(40));
  // The member's worktree record (head H2 after a hoptell commit) and its running session.
  const rec = { attributes: null, base: "0".repeat(40), branch: "team/n1/dana-impl-1", cli: "codex", commits: [{ at: new Date(0).toISOString(), commit: H2, files: 1, tree: "4".repeat(40) }], common: `${R}/repo/.git`, created: new Date(0).toISOString(), emptyTree: "5".repeat(40), gitdir: `${R}/repo/.git/worktrees/dana-impl-1`, head: H2, lead: `${R}/lead`, member: "dana-impl-1", objectFormat: "sha1", owns: null, path: `${R}/wt`, repo: `${R}/repo`, signing: {}, team: "n1", version: 1 };
  fs.mkdirSync(path.join(home, "worktrees", "sessions"), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(home, "worktrees", "dana-impl-1.json"), JSON.stringify(rec), { mode: 0o600 });
  fs.writeFileSync(path.join(home, "worktrees", "sessions", "dana-impl-1.json"), JSON.stringify({ member: "dana-impl-1", pane: "%1", root: session(1).root, sessionId: "$1", started: new Date(0).toISOString(), tree: [], version: 1 }), { mode: 0o600 });
  const registration = { repo: rec.repo, common: rec.common, gitdir: rec.gitdir, path: rec.path, branch: rec.branch };
  const deps = { state: () => "same", table: () => new Map() };
  const stateWith = (candidateH, reviews) => {
    writeTeam(home, stateOf("n1", [memberRow("dana-impl-1", "implementer", 1, { worktree: rec.path, branch: rec.branch, registration }), memberRow("dana-rev-1", "reviewer", 2)], { candidate: candidateH ? { member: "dana-impl-1", H: candidateH, C: C1, T, target: "main", at: new Date(0).toISOString() } : null, reviews }));
    return JSON.parse(leadStatus(home, "dana-lead", deps)).teams[0].members[0].state;
  };
  const approvedC1 = review("rv-0000000c", "dana-impl-1", C1, ["dana-rev-1"], [["dana-rev-1", "approve"]]);
  // New work (H2) after an approved candidate of H1: the stale approval does not count, even when
  // it is newer than the review of H2.
  assert.equal(stateWith(H1, [review("rv-0000000a", "dana-impl-1", H2, ["dana-rev-1"], [["dana-rev-1", "changes"]]), approvedC1]), "working");
  assert.equal(stateWith(H1, [approvedC1]), "ready", "committed, not yet in review");
  assert.equal(stateWith(H1, [approvedC1, review("rv-0000000b", "dana-impl-1", H2, ["dana-rev-1"])]), "in review");
  assert.equal(stateWith(H2, [approvedC1]), "approved", "the candidate of the head recorded now");
  assert.equal(stateWith(null, [review("rv-0000000a", "dana-impl-1", H2, ["dana-rev-1"], [["dana-rev-1", "approve"]])]), "approved");
});

test("engine: a lead's session publishes its summary when it connects; a team member's session publishes none", async (t) => {
  const w = await world();
  t.after(() => w.close());
  const tokens = { me: fakeToken() };
  const relay = await startRelay({ host: "127.0.0.1", port: 0, members: [{ name: "me", id: ME, token: tokens.me }], realm: { id: REALM, name: "local" }, log: () => {} });
  t.after(() => relay.close());
  const url = `ws://127.0.0.1:${relay.port}`;
  writeTeam(w.home, stateOf("n1", [memberRow("me-n1-impl", "implementer", 0), memberRow("me-n1-rev", "reviewer", 0)], { lead: "me-lead", prefix: "me" }));
  const env = { HOPTELL_RELAY: url, HOPTELL_TOKEN: tokens.me };
  await w.mcp("me-lead", env);
  await w.mcp("me-n1-rev", { ...env, HOPTELL_TEAM_MEMBER: "reviewer:n1" });
  const viewer = await client(t, url, tokens.me, "me-viewer");
  let list;
  await until(async () => (list = byName(await viewer.list({ status: true })))["me-lead"]?.status, 8000, "the lead's summary");
  const shown = parseTeamStatus(list["me-lead"].status, "me-lead");
  assert.deepEqual(
    shown.teams[0].members.map((m) => [m.name, m.state]),
    [
      ["me-n1-impl", "exited"],
      ["me-n1-rev", "exited"],
    ],
  );
  assert.equal(list["me-n1-rev"].status, undefined);
});

// ---- the engine runs the summary in a process of its own -----------------------------------------

/**
 * A lead's engine in this process ("me-lead" of member "me") with `helper` (the source of a fake
 * summary process: it gets <home> <lead>) in place of lib/teamstatus-helper.mjs.
 */
async function leadEngine(t, helper, { deadlineMs = 1000, everyMs = 60_000 } = {}) {
  const tokens = { me: fakeToken() };
  const relay = await startRelay({ host: "127.0.0.1", port: 0, members: [{ name: "me", id: ME, token: tokens.me }], realm: { id: REALM, name: "local" }, log: () => {} });
  t.after(() => relay.close());
  const url = `ws://127.0.0.1:${relay.port}`;
  const home = tmpHome(t);
  fs.mkdirSync(path.join(home, "teams"), { mode: 0o700 });
  // helper null: the real lib/teamstatus-helper.mjs, started exactly as a session starts it.
  const file = helper === null ? null : path.join(home, "fake-helper.mjs");
  if (file) fs.writeFileSync(file, `import fs from "node:fs";\nconst [home, lead] = process.argv.slice(2);\nfs.writeFileSync(home + "/helper.pid", String(process.pid));\n${helper}\n`);
  const settings = { ...readSettings({ env: { HOPTELL_RELAY: url, HOPTELL_TOKEN: tokens.me, HOPTELL_NAME: "me-lead", HOPTELL_HOME: home, HOPTELL_PUSH: "listener", HOPTELL_NOTIFY: "off" }, homedir: "/nonexistent-home", pid: process.pid, hostname: "testhost" }), ...(file ? { teamStatusHelper: file } : {}), teamStatusDeadlineMs: deadlineMs, teamStatusMs: everyMs };
  const engine = createEngine(settings, { findHost: () => null, keepAlive: true });
  t.after(() => engine.stop());
  const viewer = await client(t, url, tokens.me, "me-viewer");
  const pidFile = path.join(home, "helper.pid");
  return {
    engine,
    home,
    pid: async () => {
      await until(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, "utf8"), 8000, "the summary process");
      return Number(fs.readFileSync(pidFile, "utf8"));
    },
    status: async () => byName(await viewer.list({ status: true }))["me-lead"]?.status,
    start: () => {
      engine.start();
      return until(() => engine.session.state === "bound", 4000, "bound");
    },
  };
}
const gone = (pid) => {
  try {
    process.kill(pid, 0); // this exact pid only: is it still there?
    return false;
  } catch (e) {
    return e.code === "ESRCH";
  }
};

test("engine: a slow summary process never holds up the session's own process; at its deadline it is ended and nothing is published", async (t) => {
  // Two seconds of synchronous work, then a valid summary: too late for a one-second deadline.
  const e = await leadEngine(t, `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2500);\nprocess.stdout.write(${JSON.stringify(summary())});`);
  let last = Date.now();
  let worst = 0;
  const tick = setInterval(() => {
    worst = Math.max(worst, Date.now() - last);
    last = Date.now();
  }, 20);
  t.after(() => clearInterval(tick));
  await e.start();
  const pid = await e.pid();
  await until(() => gone(pid), 8000, "the late summary process ended");
  clearInterval(tick);
  assert.ok(worst < 1000, `a 20 ms timer of this process waited ${worst} ms`);
  await sleep(200);
  assert.equal(await e.status(), undefined, "nothing published");
});

test("engine: the real summary process, started as a session starts it, reads a live member as running and an ended one as exited", async (t) => {
  // A member's pane process, recorded as a launch records it; stopped by its exact pid.
  const live = spawn("sleep", ["60"], { stdio: "ignore" });
  t.after(() => live.kill());
  const ended = spawn("sleep", ["60"], { stdio: "ignore" });
  await until(() => processIdentity(live.pid) && processIdentity(ended.pid), 4000, "both identities");
  const at = (p, n) => ({ id: `$${n}`, pane: `%${n}`, pid: p.pid, root: processIdentity(p.pid), started: new Date().toISOString() });
  const rows = [memberRow("me-n1-rev", "reviewer", 0, { session: at(live, 1) }), memberRow("me-n1-gone", "reviewer", 0, { session: at(ended, 2) })];
  ended.kill();
  await until(() => gone(ended.pid), 4000, "the ended process gone");
  const e = await leadEngine(t, null, { deadlineMs: 10_000 });
  writeTeam(e.home, stateOf("n1", rows, { lead: "me-lead", prefix: "me" }));
  await e.start();
  let raw;
  await until(async () => (raw = await e.status()), 15_000, "the summary published");
  const states = Object.fromEntries(parseTeamStatus(raw, "me-lead").teams[0].members.map((m) => [m.name, m.state]));
  assert.deepEqual(states, { "me-n1-rev": "ready", "me-n1-gone": "exited" });
});

test("engine: stop() ends a running summary process by its handle", async (t) => {
  const e = await leadEngine(t, "setInterval(() => {}, 1000);", { deadlineMs: 60_000 });
  await e.start();
  const pid = await e.pid();
  assert.equal(gone(pid), false);
  await e.engine.stop();
  await until(() => gone(pid), 4000, "the summary process ended");
});

test("engine: a summary process that crashes, prints something else, or prints another session's summary publishes nothing; a good one is published", async (t) => {
  const cases = [
    `process.stdout.write(${JSON.stringify(summary())}); process.exit(1);`,
    `process.stdout.write("garbage");`,
    `process.stdout.write(${JSON.stringify(summary([team({ members: [member({ name: "bob-n1-impl" })], reviews: [] })]))});`,
    `process.stdout.write("x".repeat(${STATUS_MAX_BYTES + 10}));`,
  ];
  for (const src of cases) {
    const e = await leadEngine(t, src);
    await e.start();
    const pid = await e.pid();
    await until(() => gone(pid), 4000, "the summary process ended");
    await sleep(300);
    assert.equal(await e.status(), undefined, src.slice(0, 80));
    await e.engine.stop();
  }
  const ok = await leadEngine(t, `process.stdout.write(${JSON.stringify(summary())});`);
  await ok.start();
  await until(async () => (await ok.status()) === summary(), 8000, "the summary published");
});

// ---- the bridge: /team and the Mini App ---------------------------------------------------------

const HOSTILE = "<img src=x onerror=alert(1)>\u202E\nX";

async function bridgeWithTeams(t, { ownerApp = false } = {}) {
  const r = await ownerRelay(t, { ownerApp, appLimits: { perClient: { max: 1000, ms: 60_000 }, sessionPerClient: { max: 1000, ms: 60_000 } } });
  const home = tmpHome(t);
  paired(home);
  if (ownerApp) appSet(home, "on", Date.now() - 120_000);
  const lead = await agent(t, r.url, r.tokens.me, "me-lead");
  await lead.client.setStatus(summary([team({ members: [member({ model: HOSTILE, branch: "feature/<b>x</b>" }), member({ name: "me-n1-rev", role: "reviewer", cli: "claude", model: null, effort: null, branch: null, state: "in review" })] })]));
  // Another of the owner's sessions claims a team too: shown under its own name, never under me-lead.
  const other = await agent(t, r.url, r.tokens.me, "me-other");
  await other.client.setStatus(summary([team({ team: "n9", members: [member({ name: "me-n9-impl" })], reviews: [] })]));
  // Another member's session: never shown.
  const bob = await agent(t, r.url, r.tokens.bob, "bob-lead");
  await bob.client.setStatus(summary([team({ team: "zz", members: [member({ name: "bob-zz-impl" })], reviews: [] })]));
  const tg = fakeTelegram();
  const { bridge } = bridgeOn(t, { home, telegram: tg.client(), url: r.url, token: r.tokens.me, key: newKey() });
  if (ownerApp) await until(() => bridge.appAvailable(), 4000, "the app registered");
  else await until(() => bridge.leading(), 4000, "leadership");
  return { r, home, tg, bridge, lead };
}

test("/team: each team under the session that reported it, labels and text cleaned, another member's teams absent; read-only", async (t) => {
  const s = await bridgeWithTeams(t);
  s.tg.say("/team");
  await until(() => s.tg.texts().some((x) => x.startsWith("👥")), 8000, "the /team answer");
  const m = s.tg.sent.find((x) => x.method === "sendMessage" && x.params.text.startsWith("👥"));
  const text = m.params.text;
  assert.equal(m.params.parse_mode, undefined, "plain text");
  assert.equal(m.params.reply_markup, undefined, "no buttons");
  assert.match(text, /^👥 Team n1 · led by lead\n/);
  assert.match(text, /• n1-impl · implementer · codex, model <img src=x onerror=alert\(1\)> X, effort high \(at launch\) · feature\/<b>x<\/b> · working/);
  assert.match(text, /• n1-rev · reviewer · claude, model CLI default, effort CLI default \(at launch\) · in review/);
  assert.match(text, /🔎 Review of n1-impl's work: waiting for n1-rev/);
  assert.match(text, /👥 Team n9 · led by other\n• n9-impl/);
  assert.ok(!text.includes("\u202E"), "no bidi override");
  assert.doesNotMatch(text, /zz|bob/);
  assert.match(text, /This view is read-only\./);
  // A session that stops reporting is gone from the next answer (/teams is the same command).
  await s.lead.client.setStatus(null);
  s.tg.say("/teams");
  await until(() => s.tg.texts().filter((x) => x.startsWith("👥")).length === 2, 8000, "the second answer");
  const next = s.tg.texts().filter((x) => x.startsWith("👥")).at(-1);
  assert.match(next, /^👥 Team n9 · led by other\n/);
  assert.doesNotMatch(next, /Team n1/);
});

test("/team on a relay without statuses says it needs an update; with no team reported, says so", async (t) => {
  const r = await ownerRelay(t);
  const home = tmpHome(t);
  paired(home);
  const tg = fakeTelegram();
  const { bridge } = bridgeOn(t, { home, telegram: tg.client(), url: r.url, token: r.tokens.me, key: newKey() });
  await until(() => bridge.leading(), 4000, "leadership");
  tg.say("/teams");
  await until(() => tg.texts().includes("No teams yet. A team shows up here once its lead's session reports it."), 8000, "no teams");
  bridge.relay.caps = bridge.relay.caps.filter((c) => c !== "status");
  tg.say("/team");
  await until(() => tg.texts().includes("I can't show your teams: the hoptell server needs an update."), 8000, "needs an update");
});

test("Mini App: GET teams lists each team under its reporting session with labels, no handles, hostile text cleaned", async (t) => {
  const s = await bridgeWithTeams(t, { ownerApp: true });
  const app = appClient(s.r.http, s.bridge.state().app.id);
  assert.equal((await app.open()).status, 200);
  const res = await app.get("teams");
  assert.equal(res.status, 200);
  const { teams, more } = res.json;
  assert.equal(more, 0);
  assert.deepEqual(
    teams.map((x) => [x.team, x.lead]),
    [
      ["n1", "lead"],
      ["n9", "other"],
    ],
  );
  assert.deepEqual(teams[0].members[0], { label: "n1-impl", role: "implementer", cli: "codex", model: "<img src=x onerror=alert(1)> X", effort: "high", branch: "feature/<b>x</b>", state: "working", online: false });
  assert.equal(teams[0].members[1].model, "CLI default");
  assert.deepEqual(teams[0].reviews, [{ member: "n1-impl", waiting: ["n1-rev"] }]);
  assert.doesNotMatch(res.body, /"h":|bob|\\u202e/i);
});

test("/team and the Mini App: a name two sessions both claim, as a member or in an open review, is shown under neither, both ways", async (t) => {
  const r = await ownerRelay(t, { ownerApp: true, appLimits: { perClient: { max: 1000, ms: 60_000 }, sessionPerClient: { max: 1000, ms: 60_000 } } });
  const home = tmpHome(t);
  paired(home);
  appSet(home, "on", Date.now() - 120_000);
  const rev = (name) => member({ name, role: "reviewer", cli: "claude", model: null, effort: null, branch: null, state: "ready" });
  const publish = async (name, teams) => (await agent(t, r.url, r.tokens.me, name)).client.setStatus(summary(teams));
  // me-lead's open review waits for me-n1-rev, which me-other lists as its own reviewer; me-other's
  // open review is of me-n9-impl, which me-zed lists as its own implementer.
  await publish("me-lead", [team()]);
  await publish("me-other", [team({ team: "n9", members: [member({ name: "me-n9-impl" }), rev("me-n9-rev"), rev("me-n1-rev")], reviews: [{ id: "rv-0000000a", member: "me-n9-impl", waiting: ["me-n9-rev"] }] })]);
  await publish("me-zed", [team({ team: "n7", members: [member({ name: "me-n9-impl" })], reviews: [] })]);
  const tg = fakeTelegram();
  const { bridge } = bridgeOn(t, { home, telegram: tg.client(), url: r.url, token: r.tokens.me, key: newKey() });
  await until(() => bridge.appAvailable(), 4000, "the app registered");
  tg.say("/team");
  await until(() => tg.texts().some((x) => x.startsWith("👥")), 8000, "the /team answer");
  const text = tg.texts().find((x) => x.startsWith("👥"));
  const blocks = text.split("\n\n");
  assert.match(blocks[0], /^👥 Team n1 · led by lead\n• n1-impl · [^\n]*\n\+ 1 more not shown$/);
  assert.match(blocks[1], /^👥 Team n9 · led by other\n• n9-rev · [^\n]*\n\+ 2 more not shown$/);
  assert.match(blocks[2], /^👥 Team n7 · led by zed\n\+ 1 more not shown$/);
  assert.doesNotMatch(text, /🔎|n1-rev|n9-impl/);
  const app = appClient(r.http, bridge.state().app.id);
  assert.equal((await app.open()).status, 200);
  const { teams } = (await app.get("teams")).json;
  assert.deepEqual(
    teams.map((x) => [x.team, x.members.map((m) => m.label), x.more, x.reviews.length]),
    [
      ["n1", ["n1-impl"], 1, 0],
      ["n9", ["n9-rev"], 2, 0],
      ["n7", [], 1, 0],
    ],
  );
});
