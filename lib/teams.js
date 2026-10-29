// Agent teams (design 8, topic 3.1, phase 2): a team file the owner writes, and
// `hoptell team up | status | stop | restart | down | land`.
//
// A team is one lead and its implementers and reviewers. `team up` checks the file, prints every
// command it will run, adds each implementer's worktree (lib/worktrees.js) and starts every member
// with the `hoptell tmux` launch transaction (lib/tmux.js), in the background. What it started is
// kept in <home>/teams/<team>/state.json (0600): each member's command, its tmux session id, pane
// and the identity of its pane's process (pid, start, user, boot). Members are stopped by that
// session id while the pane still runs that process, never by a name or a pattern.
//
// Every git command on the repository goes through lib/worktrees.js: its runner and its quiet
// check (no implementer of the repository running). `team status` runs git only while the
// repository is quiet; otherwise it shows what hoptell recorded.
//
// Landing is the owner's step (owner decision 4): hoptell builds a signed candidate C on the
// target's commit T, the owner reviews T..C and approves exactly (T, C), and the target moves to
// C only by fast-forward. Provenance (member head H landed as C on T) is recorded here; the
// member's branch is deleted only by that record, never by comparing patches.
//
// Limits per member (design 8, 3.3 and 3.4): `lifetimeMinutes` for any member, and
// `idleMinutes.reviewer` for reviewers (no message waiting and no output in the pane for that
// long). A supervisor (`hoptell team supervise`, in its own tmux session) shows a notice in the
// pane, ends the session by its id a minute later and tells the lead. Implementers are never
// ended for idleness.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { BIN, NAME_RE, checkName, ensurePrivateDir } from "./config.js";
import { readPrivateFile } from "./agents.js";
import { withLock, writeRecord } from "./locks.js";
import { CAPABILITY_CLIS, NOT_OFFERED, codexHoptell, loadPresets, packageVersion, readCodexConfig, resolveLaunch, safeCapabilities } from "./capabilities.js";
import { ROLE_TEMPLATES, launchPrompt, renderTemplate, restartPrompt, roleTemplate, templateArgs } from "./roles.js";
import { REGISTRATION_KEYS, TEAM_RE, addWorktree, adoptCandidate, commonDirOf, isIdentity, checkOwns, discardCandidate, landAction, landApprove, landCandidate, landingEvidence, memberState, observeTarget, readWorktreeRecord, registrationOf, processIn, removeWorktree, worktreeStatus } from "./worktrees.js";
import { identityState, pidExists, processIdentity, processTable } from "./host.js";
import { readTaskFile, sessionFor } from "./tmux.js";
import { readOccurrence, waitLine } from "./waits.js";
import { shellLine } from "./agentadapters.js";
import { canonicalize } from "./jcs.js";
import { ACTION_ID_RE, ACTION_KEYS, ACTION_ROUTES, ACTION_STATES, ACTION_TTL_MS, APPLY_WINDOW_MS, MANIFEST_FIT, REPORT_MAX, checkReceipt, createManifest, ingestDecision, landingRequest, landingStatusText, landingPaths, newActionId, orphanActions, readEvidence, readManifest, readReceipt, readTombstone, storeEvidence, teamOfAction, tombstoneOf, writeTombstone } from "./landings.js";
import { SUMMARY_LIMITS, clipText, fitSummary } from "./teamstatus.js";
import { pinFor } from "./ownersig.js";
import { GRANT_DEFAULT_MS, NOTICES_MAX, REVOKES_MAX, autolandPausedUntil, checkGrant, coveringGrant, grantIds, leftText, newGrantId, newRow, noticeText, parseDuration, parseGrant, queueNotice, readGrant, readGrantState, reserveSlot, revoke, revokeKeptUntil, settleGrants, statusOf, storeGrant, writeGrantState } from "./grants.js";

export const MEMBER_ROLES = ["implementer", "reviewer"];
export const TEAM_MEMBERS_MAX = 16;
const TEAM_FILE_MAX = 64 * 1024;
const STATE_MAX = 1024 * 1024;
const MINUTES_MAX = 1440;
const LOCK_WAIT_MS = 15_000;
const INGEST_WAIT_MS = 2000; // the engine's wait for the team lock; busy, it leaves the decision with the relay
const STOP_WAIT_MS = 5000;
export const NOTICE_MS = 60_000; // a notice in the pane this long before the supervisor ends it

export class TeamError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
const fail = (code, message) => {
  throw new TeamError(code, message);
};

/** The team's folder in the hoptell home: state, the members' task copies, the lock. */
export function teamPaths(home, team) {
  if (!TEAM_RE.test(String(team ?? "")) || team === "all") fail("bad_team", `invalid team name "${String(team ?? "").slice(0, 40)}"`);
  const dir = path.join(home, "teams", team);
  return { root: path.join(home, "teams"), dir, state: path.join(dir, "state.json"), tasks: path.join(dir, "tasks"), task: (m) => path.join(dir, "tasks", `${checkName(m, "member name")}.md`), lock: path.join(dir, "team") };
}

// ---- the team file ----------------------------------------------------------------------------

const TOP = ["version", "team", "repo", "base", "worktrees", "lead", "members", "idleMinutes", "lifetimeMinutes"];
const MEMBER = ["name", "role", "cli", "model", "effort", "task", "owns", "template", "lifetimeMinutes", "folder"];
const minutes = (v) => Number.isSafeInteger(v) && v >= 1 && v <= MINUTES_MAX;

/** A path of the team file: "~/..." from the home folder, a relative one from the file's folder. */
function filePath(p, { homedir, dir }) {
  if (typeof p !== "string" || !p || p.length > 1024 || p.includes("\0")) return null;
  if (p === "~" || p.startsWith("~/")) return homedir ? path.join(homedir, p.slice(2)) : null;
  return path.resolve(dir, p);
}

/** The literal start of a glob (up to its first wildcard). */
const literal = (g) => g.split(/[*?[]/)[0];

/**
 * Could two `owns` lists name the same file? Conservative: a list that is absent (the whole
 * worktree) overlaps everything, and two globs overlap when one's literal start begins the other's.
 */
export function ownsOverlap(a, b) {
  if (!a || !b) return true;
  return a.some((x) => b.some((y) => literal(x).startsWith(literal(y)) || literal(y).startsWith(literal(x))));
}

/**
 * Check a team file's content. `file`: its path (relative paths in it are from its folder).
 * Returns the team with paths resolved; throws TeamError("bad_team_file") naming every problem.
 */
export function checkTeam(doc, { file, homedir }) {
  const p = [];
  const dir = path.dirname(path.resolve(file));
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) fail("bad_team_file", `${file} is not a team file (a JSON object)`);
  for (const k of Object.keys(doc)) if (!TOP.includes(k)) p.push(`unknown field "${String(k).slice(0, 40)}"`);
  if (doc.version !== 1) p.push("version must be 1");
  if (typeof doc.team !== "string" || !TEAM_RE.test(doc.team) || doc.team === "all") p.push('team must be 1 to 32 lowercase letters, digits or "-" (not "all")');
  const repo = filePath(doc.repo, { homedir, dir });
  if (!repo) p.push("repo must be a folder path");
  if (doc.base !== undefined && !(typeof doc.base === "string" && /^[A-Za-z0-9][\w./^~-]{0,199}$/.test(doc.base))) p.push("base must be a commit or branch name (default HEAD)");
  const worktrees = doc.worktrees === undefined ? null : filePath(doc.worktrees, { homedir, dir });
  if (doc.worktrees !== undefined && !worktrees) p.push("worktrees must be a folder path");
  if (typeof doc.lead !== "string" || !NAME_RE.test(doc.lead)) p.push("lead must be the lead session's peer name");
  // The member prefix rule: every name starts with the lead's first part and "-" (a member
  // token's names all start with its member name).
  const prefix = typeof doc.lead === "string" ? doc.lead.split("-")[0] : "";
  if (doc.idleMinutes !== undefined && !(doc.idleMinutes && typeof doc.idleMinutes === "object" && !Array.isArray(doc.idleMinutes) && Object.keys(doc.idleMinutes).every((k) => k === "reviewer") && (doc.idleMinutes.reviewer === undefined || minutes(doc.idleMinutes.reviewer)))) p.push(`idleMinutes must be {"reviewer": 1 to ${MINUTES_MAX}} (implementers are never ended for idleness)`);
  if (doc.lifetimeMinutes !== undefined && !minutes(doc.lifetimeMinutes)) p.push(`lifetimeMinutes must be 1 to ${MINUTES_MAX}`);
  const members = [];
  if (!Array.isArray(doc.members) || !doc.members.length || doc.members.length > TEAM_MEMBERS_MAX) p.push(`members must be a list of 1 to ${TEAM_MEMBERS_MAX}`);
  const seen = new Set([doc.lead]);
  for (const [i, m] of (Array.isArray(doc.members) ? doc.members : []).entries()) {
    const at = `members[${i}]${typeof m?.name === "string" ? ` (${m.name.slice(0, 64)})` : ""}`;
    if (!m || typeof m !== "object" || Array.isArray(m)) {
      p.push(`${at}: not an object`);
      continue;
    }
    const before = p.length;
    for (const k of Object.keys(m)) if (!MEMBER.includes(k)) p.push(`${at}: unknown field "${String(k).slice(0, 40)}"`);
    if (typeof m.name !== "string" || !NAME_RE.test(m.name)) p.push(`${at}: name must be a peer name`);
    else if (!prefix || !m.name.startsWith(`${prefix}-`) || m.name.length <= prefix.length + 1) p.push(`${at}: name must start with "${prefix}-" (the lead's member prefix)`);
    else if (seen.has(m.name)) p.push(`${at}: the name is used twice`);
    seen.add(m.name);
    if (!MEMBER_ROLES.includes(m.role)) p.push(`${at}: role must be ${MEMBER_ROLES.join(" or ")}`);
    if (!CAPABILITY_CLIS.includes(m.cli)) p.push(`${at}: cli must be ${CAPABILITY_CLIS.join(", ")}`);
    else if (NOT_OFFERED[m.cli]?.[m.role]) p.push(`${at}: ${NOT_OFFERED[m.cli][m.role]}`);
    for (const k of ["model", "effort"]) if (m[k] !== undefined && typeof m[k] !== "string") p.push(`${at}: ${k} must be text`);
    const task = filePath(m.task, { homedir, dir });
    if (!task) p.push(`${at}: task must be the path of the member's task file`);
    let owns = null;
    if (m.owns !== undefined) {
      // Left out: the whole worktree. null or anything but a list is not that: it is refused.
      if (m.role !== "implementer") p.push(`${at}: owns is for implementers`);
      else if (!Array.isArray(m.owns)) p.push(`${at}: owns must be a list of globs (leave it out to allow the whole worktree)`);
      else {
        try {
          owns = checkOwns(m.owns);
        } catch (e) {
          p.push(`${at}: ${e.message}`);
        }
      }
    }
    if (m.template !== undefined && !ROLE_TEMPLATES.includes(m.template)) p.push(`${at}: template must be ${ROLE_TEMPLATES.join(", ")}`);
    if (m.lifetimeMinutes !== undefined && !minutes(m.lifetimeMinutes)) p.push(`${at}: lifetimeMinutes must be 1 to ${MINUTES_MAX}`);
    if (m.folder !== undefined && (m.role !== "implementer" || typeof m.folder !== "string" || !NAME_RE.test(m.folder))) p.push(`${at}: folder is an implementer's worktree folder name`);
    if (p.length === before) members.push({ name: m.name, role: m.role, cli: m.cli, model: m.model ?? null, effort: m.effort ?? null, task, owns, template: m.template ?? m.role, lifetimeMinutes: m.lifetimeMinutes ?? doc.lifetimeMinutes ?? null, folder: m.folder ?? null });
  }
  const impl = members.filter((m) => m.role === "implementer");
  for (let i = 0; i < impl.length; i++) {
    for (let j = i + 1; j < impl.length; j++) {
      if (ownsOverlap(impl[i].owns, impl[j].owns)) p.push(`${impl[i].name} and ${impl[j].name} may change the same files (give each implementer owns globs that do not overlap)`);
    }
  }
  if (p.length) fail("bad_team_file", `${file}:\n  ${p.join("\n  ")}`);
  return { version: 1, team: doc.team, repo, base: doc.base ?? "HEAD", worktrees, lead: doc.lead, prefix, members, idleMinutes: doc.idleMinutes?.reviewer ?? null };
}

/** Read and check a team file (the owner's: it may be readable by others, never a link). */
export function readTeamFile(file, { homedir }) {
  const r = readPrivateFile(path.resolve(file), TEAM_FILE_MAX, { privateMode: false });
  if (r.problem) fail("bad_team_file", r.missing ? `${file} does not exist` : `${file} ${r.problem}`);
  let doc;
  try {
    doc = JSON.parse(r.bytes.toString("utf8"));
  } catch {
    fail("bad_team_file", `${file} is not valid JSON`);
  }
  return { team: checkTeam(doc, { file, homedir }), digest: crypto.createHash("sha256").update(r.bytes).digest("hex") };
}

// ---- the member's command ---------------------------------------------------------------------

/**
 * The agent command of one member: the role's preset flags with the model and effort (team file >
 * the owner's preset > shipped preset > the CLI's own configuration), then the role template and
 * the launch prompt in the CLI's per-session places. `prompt`: another fixed prompt (restart).
 * Returns {argv, line, model, effort, warnings}.
 */
export function memberCommand(team, m, { home, homedir, env, capOptions = {}, prompt = null }) {
  let presets;
  try {
    presets = loadPresets(home, capOptions.shipped ? { shipped: capOptions.shipped } : {});
  } catch (e) {
    fail("presets", e.message);
  }
  const { record } = safeCapabilities(m.cli, { home, pathVar: env.PATH ?? "", homedir, codexHome: env.CODEX_HOME || undefined, lang: env.LANG, ...capOptions });
  const r = resolveLaunch(m.cli, m.role, { model: m.model ?? undefined, effort: m.effort ?? undefined }, { record, presets, now: (capOptions.now ?? Date.now)() });
  if (r.refused) fail("refused", `${m.name}: ${r.refused}`);
  let placed;
  try {
    const t = roleTemplate(m.template, { homedir });
    placed = templateArgs(m.cli, { text: renderTemplate(t.text, { lead: team.lead }), prompt: prompt ?? launchPrompt(m.template, team.lead) }, record);
  } catch (e) {
    fail("template", `${m.name}: ${e.message}`);
  }
  const args = [...r.args, ...placed.args];
  return { argv: [m.cli, ...args], line: shellLine(m.cli, args), model: r.model, effort: r.effort, warnings: [...presets.warnings, ...(record.warnings ?? []), ...r.warnings, ...placed.warnings].map((w) => `${m.name}: ${w}`) };
}

// ---- state ------------------------------------------------------------------------------------

/** The team's state, or null when it has none; throws when it cannot be read. */
export function readState(home, team) {
  const file = teamPaths(home, team).state;
  const r = readPrivateFile(file, STATE_MAX);
  if (r.missing) return null;
  if (r.problem) fail("bad_state", `${file} ${r.problem}`);
  let s;
  try {
    s = JSON.parse(r.bytes.toString("utf8"));
  } catch {
    fail("bad_state", `${file} is not valid JSON`);
  }
  const problem = stateProblem(s, team);
  if (problem) fail("bad_state", `${file} is not a valid team state of ${team} (${problem}); hoptell stops nothing by it`);
  return s;
}

// ---- the state's shape ------------------------------------------------------------------------
// Every field is checked before a state is used: a session id, pane and process identity are what
// hoptell ends a session by, so a state that does not have exactly this shape is refused whole.

const STATUSES = ["starting", "up", "partial", "stopping", "down"];
const OID_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const isObj = (x) => Boolean(x) && typeof x === "object" && !Array.isArray(x);
const isTime = (x) => typeof x === "string" && x.length <= 40 && !Number.isNaN(Date.parse(x));
const isAbs = (x) => typeof x === "string" && x.length <= 4096 && path.isAbsolute(x) && !x.includes("\0");
const isText = (x, max = 4096) => typeof x === "string" && x.length <= max;
const orNull = (f) => (x) => x === null || f(x);
const isMinutes = (x) => Number.isSafeInteger(x) && x >= 1 && x <= MINUTES_MAX;
const isOid = (x) => typeof x === "string" && OID_RE.test(x);
const isBranch = (x) => typeof x === "string" && /^[A-Za-z0-9][\w./-]{0,199}$/.test(x) && !x.includes("..");
const isSession = (x) => isObj(x) && same(x, ["id", "pane", "pid", "root", "started"]) && /^\$\d+$/.test(x.id) && /^%\d+$/.test(x.pane) && Number.isSafeInteger(x.pid) && x.pid > 1 && (x.root === null || (isIdentity(x.root) && x.root.pid === x.pid)) && isTime(x.started);
const isReasonAt = (x) => isObj(x) && same(x, ["reason", "at"]) && ["idle", "lifetime"].includes(x.reason) && isTime(x.at);
const same = (o, keys) => {
  const k = Object.keys(o);
  return k.length === keys.length && keys.every((x) => Object.hasOwn(o, x));
};

const MEMBER_STATE = {
  name: (x) => typeof x === "string" && NAME_RE.test(x),
  role: (x) => MEMBER_ROLES.includes(x),
  cli: (x) => CAPABILITY_CLIS.includes(x),
  model: orNull((x) => isText(x, 200)),
  effort: orNull((x) => isText(x, 40)),
  template: (x) => ROLE_TEMPLATES.includes(x),
  owns: orNull((x) => Array.isArray(x) && x.length >= 1 && x.length <= 64 && x.every((o) => isText(o, 256) && o !== "")),
  folder: orNull((x) => typeof x === "string" && NAME_RE.test(x)),
  lifetimeMinutes: orNull(isMinutes),
  argv: (x) => Array.isArray(x) && x.length >= 1 && x.length <= 256 && x.every((a) => isText(a, 65536)),
  taskDigest: orNull((x) => typeof x === "string" && /^[0-9a-f]{64}$/.test(x)),
  cwd: orNull(isAbs),
  worktree: orNull(isAbs),
  branch: orNull(isBranch),
  registration: orNull((x) => isObj(x) && same(x, REGISTRATION_KEYS) && REGISTRATION_KEYS.every((k) => (k === "branch" ? isBranch(x[k]) : isAbs(x[k])))),
  session: orNull(isSession),
  ended: orNull(isReasonAt),
  notice: orNull(isReasonAt),
};
const LANDING = {
  member: (x) => typeof x === "string" && NAME_RE.test(x),
  H: isOid,
  C: isOid,
  T: isOid,
  target: isBranch,
  at: isTime,
};
const isLanded = (x) => isObj(x) && same(x, Object.keys(LANDING)) && Object.entries(LANDING).every(([k, f]) => f(x[k]));
const isCandidate = isLanded;
// A landing journal; one written under a landing action names it (`action`).
const isJournal = (x) => isObj(x) && (same(x, [...Object.keys(LANDING), "repo", "phase"]) || (same(x, [...Object.keys(LANDING), "repo", "phase", "action"]) && ACTION_ID_RE.test(String(x.action)))) && Object.entries(LANDING).every(([k, f]) => f(x[k])) && isAbs(x.repo) && ["intent", "landed"].includes(x.phase);
// A live landing action (lib/landings.js): its manifest's digest, the state, and for display the
// target, T and C (the manifest decides).
const LIVE_STATES = ["ready", "approved", "accepted", "moving", "landed", "blocked"];
const isAction = (x) =>
  isObj(x) &&
  same(x, [...ACTION_KEYS, "target", "T", "C"]) &&
  ACTION_ID_RE.test(String(x.id)) &&
  typeof x.digest === "string" &&
  /^[0-9a-f]{64}$/.test(x.digest) &&
  typeof x.member === "string" &&
  NAME_RE.test(x.member) &&
  LIVE_STATES.includes(x.state) &&
  ACTION_STATES.includes(x.state) &&
  (x.route === null || ACTION_ROUTES.includes(x.route)) &&
  (x.decision === null || (typeof x.decision === "string" && /^[0-9a-f]{64}$/.test(x.decision))) &&
  (x.reason === null || isText(x.reason, 1000)) &&
  isTime(x.created) &&
  isTime(x.updated) &&
  isBranch(x.target) &&
  isOid(x.T) &&
  isOid(x.C);
// The repository enrolment recorded at team up: the common git folder, an id, and a generation
// that counts the team's starts on that folder.
const isEnrolment = (x) => isObj(x) && same(x, ["common", "id", "generation"]) && isAbs(x.common) && /^[0-9a-f]{32}$/.test(String(x.id)) && Number.isSafeInteger(x.generation) && x.generation >= 1;
// Fields a state written before landing actions does not have: such a team lands nothing new.
const LATER = ["run", "enrolment", "actions"];
// Fields a state may lack (written before them): the lead's test evidence of the candidate.
const OPTIONAL = ["evidence"];
// The lead's test evidence for the team's candidate (hoptell team evidence): the tested C and its
// T, the result the lead claims, the commands it ran, and its report, stored by digest.
export const TEST_RESULTS = ["pass", "fail"];
const COMMANDS_MAX = 16;
const COMMAND_MAX = 2000;
const isCommands = (x) => Array.isArray(x) && x.length >= 1 && x.length <= COMMANDS_MAX && x.every((c) => isText(c, COMMAND_MAX) && c.trim() !== "" && !c.includes("\0"));
const isEvidence = (x) => isObj(x) && same(x, ["member", "T", "C", "tests", "commands", "report", "bytes", "at"]) && typeof x.member === "string" && NAME_RE.test(x.member) && isOid(x.T) && isOid(x.C) && TEST_RESULTS.includes(x.tests) && isCommands(x.commands) && typeof x.report === "string" && /^[0-9a-f]{64}$/.test(x.report) && Number.isSafeInteger(x.bytes) && x.bytes >= 0 && x.bytes <= REPORT_MAX && isTime(x.at);
const isPublishing = (x) => isObj(x) && same(x, ["member", "target", "T", "H", "C", "at"]) && Object.entries(LANDING).every(([k, f]) => !Object.hasOwn(x, k) || f(x[k]));
// The review queue (design 8, 3.5): a request the lead sent ({id, base, head, the member whose
// worktree holds them, the reviewers asked, at}) and the verdicts the lead recorded for it.
const REVIEW_RE = /^rv-[0-9a-f]{8}$/;
export const VERDICTS = ["approve", "changes"];
const REVIEWS_MAX = 200;
const VERDICTS_MAX = 200;
const isVerdict = (x) => isObj(x) && same(x, ["reviewer", "verdict", "at"]) && typeof x.reviewer === "string" && NAME_RE.test(x.reviewer) && VERDICTS.includes(x.verdict) && isTime(x.at);
const isReview = (x) =>
  isObj(x) &&
  same(x, ["id", "base", "head", "member", "reviewers", "at", "verdicts"]) &&
  REVIEW_RE.test(String(x.id)) &&
  isOid(x.base) &&
  isOid(x.head) &&
  typeof x.member === "string" &&
  NAME_RE.test(x.member) &&
  Array.isArray(x.reviewers) &&
  x.reviewers.length >= 1 &&
  x.reviewers.length <= TEAM_MEMBERS_MAX &&
  x.reviewers.every((r) => typeof r === "string" && NAME_RE.test(r)) &&
  new Set(x.reviewers).size === x.reviewers.length &&
  isTime(x.at) &&
  Array.isArray(x.verdicts) &&
  x.verdicts.length <= VERDICTS_MAX &&
  x.verdicts.every((v) => isVerdict(v) && x.reviewers.includes(v.reviewer));
const isEvent = (x) => isObj(x) && same(x, ["at", "what"]) && isTime(x.at) && isText(x.what, 2000);
const STATE = {
  version: (x) => x === 1,
  team: (x) => typeof x === "string" && TEAM_RE.test(x),
  file: isAbs,
  fileDigest: (x) => typeof x === "string" && /^[0-9a-f]{64}$/.test(x),
  lead: (x) => typeof x === "string" && NAME_RE.test(x),
  prefix: (x) => typeof x === "string" && /^[A-Za-z0-9][A-Za-z0-9_]{0,63}$/.test(x),
  repo: isAbs,
  base: (x) => isText(x, 200) && x !== "",
  worktrees: orNull(isAbs),
  idleMinutes: orNull(isMinutes),
  status: (x) => STATUSES.includes(x),
  created: isTime,
  members: (x) => Array.isArray(x) && x.length >= 1 && x.length <= TEAM_MEMBERS_MAX,
  supervisor: orNull(isSession),
  candidate: orNull(isCandidate),
  landing: orNull(isJournal),
  publishing: orNull(isPublishing),
  landed: (x) => Array.isArray(x) && x.every(isLanded),
  reviews: (x) => Array.isArray(x) && x.length <= REVIEWS_MAX && x.every(isReview) && new Set(x.map((r) => r.id)).size === x.length,
  events: (x) => Array.isArray(x) && x.every(isEvent),
  run: (x) => typeof x === "string" && /^[0-9a-f]{32}$/.test(x),
  enrolment: orNull(isEnrolment),
  actions: (x) => Array.isArray(x) && x.length <= 64 && x.every(isAction) && new Set(x.map((a) => a.id)).size === x.length && new Set(x.map((a) => a.member)).size === x.length,
  evidence: orNull(isEvidence),
};

/** What is wrong with a team state (the first problem), or null. Exported for tests. */
export function stateProblem(s, team) {
  if (!isObj(s)) return "not an object";
  for (const k of Object.keys(s)) if (!Object.hasOwn(STATE, k)) return `unknown field ${String(k).slice(0, 40)}`;
  for (const [k, f] of Object.entries(STATE)) if (Object.hasOwn(s, k) ? !f(s[k]) : !LATER.includes(k) && !OPTIONAL.includes(k)) return `field ${k}`;
  if (LATER.some((k) => Object.hasOwn(s, k)) && !LATER.every((k) => Object.hasOwn(s, k))) return `field ${LATER.find((k) => !Object.hasOwn(s, k))}`;
  if (s.team !== team) return "another team's state";
  const names = new Set();
  for (const [i, m] of s.members.entries()) {
    if (!isObj(m)) return `members[${i}]`;
    for (const k of Object.keys(m)) if (!Object.hasOwn(MEMBER_STATE, k)) return `members[${i}]: unknown field ${String(k).slice(0, 40)}`;
    for (const [k, f] of Object.entries(MEMBER_STATE)) if (!Object.hasOwn(m, k) || !f(m[k])) return `members[${i}].${k}`;
    if (names.has(m.name)) return `members[${i}]: the name is used twice`;
    names.add(m.name);
  }
  return null;
}

const EVENTS_KEPT = 200;
function writeState(home, s) {
  if (s.events.length > EVENTS_KEPT) s.events.splice(0, s.events.length - EVENTS_KEPT);
  writeRecord(teamPaths(home, s.team).state, s, 2);
}

/** The names of the teams with a state in this home. */
export function listTeams(home) {
  try {
    return fs
      .readdirSync(path.join(home, "teams"))
      .filter((t) => TEAM_RE.test(t))
      .sort();
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
}

/** The team to act on: the one named, or the only one that is not down. */
function pickTeam(home, team) {
  if (team) return team;
  const live = listTeams(home).filter((t) => readState(home, t)?.status !== "down");
  if (live.length === 1) return live[0];
  fail("which_team", live.length ? `several teams are up (${live.join(", ")}); name one` : "no team is up");
}

/** The active teams (not down) that have a member named `member`. */
/** Whether `member` is a member of the active (not down) team `team` of this home. */
export const inActiveTeam = (home, team, member) => activeTeamsOf(home, member).includes(team);

function activeTeamsOf(home, member) {
  return listTeams(home).filter((t) => {
    const s = readState(home, t);
    return s && s.status !== "down" && s.members.some((m) => m.name === member);
  });
}

/**
 * The team `member` belongs to now: its one active team. A team that is down keeps its members'
 * names for its history (landedFor) but no longer has them; two active teams with the same name
 * are refused rather than guessed between.
 */
function teamOf(home, member) {
  checkName(member, "member name");
  const teams = activeTeamsOf(home, member);
  if (teams.length > 1) fail("ambiguous_member", `${member} is a member of several active teams (${teams.join(", ")}); take all but one down first`);
  if (teams.length) return teams[0];
  fail("no_member", `${member} is in no active team of this hoptell home (hoptell team status <team>)`);
}

/**
 * The team to finish or make a landing of `member` in: its active team, or else a team that is
 * down with a landing of that member still pending (down keeps it). Two candidates are refused.
 */
function landingTeamOf(home, member) {
  checkName(member, "member name");
  const active = activeTeamsOf(home, member);
  if (active.length > 1) fail("ambiguous_member", `${member} is a member of several active teams (${active.join(", ")}); take all but one down first`);
  if (active.length) return active[0];
  const pending = listTeams(home).filter((t) => {
    const s = readState(home, t);
    return s && s.status === "down" && pendingOf(s)?.member === member;
  });
  if (pending.length > 1) fail("ambiguous_member", `landings of ${member} are pending in several teams (${pending.join(", ")}); finish them by hand`);
  if (pending.length) return pending[0];
  fail("no_member", `${member} is in no active team and has no pending landing in this hoptell home (hoptell team status <team>)`);
}

/** What a live landing action waits for, and the command that continues it. */
function actionText(a) {
  const line = (flag) => `hoptell team land ${a.member} ${flag} ${a.T} ${a.C}`;
  if (a.state === "blocked") return `the landing ${a.id} is blocked (${a.reason}); hoptell does not move ${a.target} again under it. Check it; once ${a.target} is at ${a.C.slice(0, 12)} and its checkout is clean, ${line("--confirm")} records it`;
  if (a.state === "ready") return `the landing ${a.id} waits for the owner's decision: hoptell team approve ${a.id} (in a terminal); hoptell team land ${a.member} --discard drops the candidate`;
  if (a.state === "approved") return `the landing ${a.id} was decided but did not start: ${line("--approve")} continues it, hoptell team land ${a.member} --discard drops the candidate`;
  return `the landing ${a.id} is ${a.state === "landed" ? "landed, its cleanup unfinished" : a.state}: ${line("--approve")} finishes it`;
}

/** The command that finishes a pending landing. */
const finishLine = (l) => `hoptell team land ${l.member} --approve ${l.T} ${l.C}`;

/**
 * What a team still owes a member's landing: a journal that did not finish, or a candidate that
 * was neither approved nor discarded. {member, text} or null. Either keeps the member's worktree
 * through team down and holds team up back.
 */
function pendingOf(s) {
  if (s?.publishing) return { member: s.publishing.member, text: `a candidate was being published: hoptell team land ${s.publishing.member} --target ${s.publishing.target} -m <message> finishes it, hoptell team land ${s.publishing.member} --discard drops it` };
  const a = s?.actions?.[0];
  if (a) return { member: a.member, text: actionText(a) };
  if (s?.landing) return { member: s.landing.member, text: `a landing is pending: ${finishLine(s.landing)} finishes it` };
  if (s?.candidate) return { member: s.candidate.member, text: `candidate pending: approve or discard it with ${finishLine(s.candidate)} or hoptell team land ${s.candidate.member} --discard` };
  return null;
}

/** Whether a worktree record is the registration a team kept of it. */
const sameAs = (rec, reg) => !!reg && REGISTRATION_KEYS.every((k) => rec[k] === reg[k]);

/**
 * The registration of `member` in team state `s`, for its landing: refused when the member has
 * none, or when `journal` (a landing's journal) names another repository.
 */
function registrationFor(s, member, journal = null) {
  const reg = s.members.find((m) => m.name === member)?.registration ?? null;
  if (!reg) fail("not_this_team", `${member} has no worktree registered in team ${s.team}; nothing was changed`);
  if (journal && journal.repo !== reg.repo) fail("not_this_team", `the landing's journal is for ${journal.repo}, but team ${s.team} registered ${member} in ${reg.repo}; nothing was changed`);
  return reg;
}

/** The enrolment of `repo` for a new start of a team whose earlier state is `prev`, or null. */
function enrolmentOf(repo, prev) {
  const common = commonDirOf(repo);
  if (!common) return null;
  const had = prev?.enrolment?.common === common ? prev.enrolment : null;
  return { common, id: had?.id ?? crypto.randomBytes(16).toString("hex"), generation: (had?.generation ?? 0) + 1 };
}

/** Run `fn(state)` under the team's lock with its state read fresh; `fn` may change and return it. */
async function withTeam(home, team, fn) {
  const paths = teamPaths(home, team);
  ensurePrivateDir(path.join(ensurePrivateDir(paths.root), team));
  return withLock(paths.lock, async () => fn(readState(home, team)), { waitMs: LOCK_WAIT_MS });
}

/**
 * Is a member's session running? "running", "exited" or "unknown", from the identities hoptell
 * recorded: an implementer's session record (lib/worktrees.js), otherwise the identity of its
 * pane's process recorded at launch and the processes it started.
 */
export function sessionState(home, m, { table = processTable, state = identityState } = {}) {
  if (!m.session) return "not started";
  // The session record of the member's worktree, while the record of that name is still the
  // team's own (a name reused elsewhere falls back to the identities the team recorded).
  const wr = m.role === "implementer" && m.worktree ? readWorktreeRecord(home, m.name) : null;
  if (wr && !(wr.rec && !sameAs(wr.rec, m.registration))) {
    const st = memberState(home, m.name, { table, state });
    return st.state === "stopped" ? "exited" : st.state;
  }
  if (!m.session.root) return pidExists(m.session.pid) === false ? "exited" : "unknown";
  const st = state(m.session.root);
  if (st === "same") return "running";
  return st === "different" ? "exited" : "unknown";
}

// ---- up -----------------------------------------------------------------------------------------

/**
 * The checks every launch of members runs (team up and restart): agy reads a project MCP file
 * whose precedence over its global registration is unverified (design 8, 3.6), so an agy member
 * is refused while the repository has one.
 */
export function launchPreflight(repo, members) {
  const agy = members.filter((m) => m.cli === "agy");
  if (!agy.length) return;
  const mcp = path.join(repo, ".agents", "mcp_config.json");
  let there = true;
  try {
    fs.lstatSync(mcp);
  } catch (e) {
    if (e.code !== "ENOENT") fail("agy_project_mcp", `${mcp} could not be checked (${e.code}); hoptell does not start agy members (${agy.map((m) => m.name).join(", ")}) without that check`);
    there = false;
  }
  if (there) fail("agy_project_mcp", `${mcp} exists; agy may load its servers instead of or next to its global hoptell registration, so hoptell does not start agy members (${agy.map((m) => m.name).join(", ")}) in this repository`);
}

/**
 * What Codex members will meet, from Codex's own config.toml (read only; hoptell never trusts a
 * folder for you and never edits it): a folder not marked trusted, where interactive Codex asks in
 * its pane before it starts; and the hoptell MCP server Codex runs ([mcp_servers.hoptell]), which
 * may be another install than this one. Codex keeps trust under the repository's root (`repo`),
 * and a worktree of a trusted repository starts without asking (seen with CODEX_TRUST_CHECKED; not
 * in Codex's docs), so a member counts as trusted when its folder or the repository is. Warnings
 * only, one for the repository.
 */
const CODEX_TRUST_CHECKED = "0.165.0";
function codexChecks(members, { repo, homedir, env, warn }) {
  const codex = members.filter((m) => m.cli === "codex");
  if (!codex.length) return;
  const cfg = readCodexConfig(env.CODEX_HOME || path.join(homedir, ".codex"));
  const real = (p) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return p;
    }
  };
  const untrusted = codex.filter((m) => !(!cfg.problem && [m.folder, real(m.folder), repo, real(repo)].some((f) => cfg.projects.get(f) === "trusted")));
  if (untrusted.length) {
    const who = untrusted.map((m) => m.name).join(", ");
    const once = `Codex (checked with ${CODEX_TRUST_CHECKED}) asks once per repository: its worktrees count as trusted after that`;
    if (cfg.problem && !cfg.missing) warn(`warning: Codex may ask you to trust ${repo} in a pane before it starts (${who}; ${cfg.file}: ${cfg.problem}); ${once}`);
    else warn(`warning: Codex will ask you to trust ${repo} in a pane before it starts (${who}); ${once}`);
  }
  const ours = real(BIN);
  const theirs = cfg.problem ? { problem: `${cfg.file}: ${cfg.problem}` } : codexHoptell(cfg, { pathVar: env.PATH ?? "" });
  const version = (v) => (v ? ` (version ${v})` : "");
  if (theirs.problem) warn(`warning: could not check which hoptell the Codex members run as their MCP server: ${theirs.problem}`);
  else if (theirs.script !== ours) warn(`warning: Codex members run the hoptell MCP server of ${theirs.script}${version(theirs.version)}, from [mcp_servers.hoptell] in ${cfg.file}, not this hoptell ${ours}${version(packageVersion(ours))}`);
}

/**
 * `hoptell team up <file> [--dry-run] [--yes]`. `deps`: {launch (lib/tmux.js launch), prepare,
 * startSupervisor, capOptions, out, warn, confirm (a yes/no question on a terminal, or null)}.
 */
export async function teamUp(file, { home, homedir, env, dryRun = false, yes = false }, deps) {
  const { out, warn } = deps;
  const { team, digest } = readTeamFile(file, { homedir });
  let repo;
  try {
    repo = fs.realpathSync(team.repo);
  } catch {
    fail("bad_team_file", `repo ${team.repo} does not exist`);
  }
  if (!fs.statSync(repo).isDirectory()) fail("bad_team_file", `repo ${team.repo} is not a folder`);
  const existing = readState(home, team.team);
  if (existing && existing.status !== "down") fail("team_up", `team ${team.team} is already up (hoptell team status ${team.team}); hoptell team down ${team.team} first`);
  if (pendingOf(existing)) fail("landing_pending", `team ${team.team} still has ${pendingOf(existing).member}'s landing: ${pendingOf(existing).text}; then team up can start the team again`);
  for (const m of team.members) {
    const other = activeTeamsOf(home, m.name).filter((t) => t !== team.team);
    if (other.length) fail("member_in_team", `${m.name} is a member of the active team ${other[0]}; take it down or pick another name`);
    const pending = listTeams(home).find((t) => pendingOf(readState(home, t))?.member === m.name);
    if (pending) fail("landing_pending", `${m.name} has a landing in team ${pending} that is not resolved (${pendingOf(readState(home, pending)).text}); resolve it first`);
  }
  launchPreflight(repo, team.members);
  const agy = team.members.filter((m) => m.cli === "agy");
  if (agy.length) warn(`warning: agy members (${agy.map((m) => m.name).join(", ")}) reach hoptell through agy's own global MCP registration (agy mcp add hoptell hoptell mcp); hoptell does not check it`);
  if (env.HOPTELL_NAME && env.HOPTELL_NAME !== team.lead) warn(`warning: this shell's HOPTELL_NAME is ${env.HOPTELL_NAME}, not the lead ${team.lead}; members take requests from ${team.lead} only`);
  // The commands, resolved before anything starts.
  const taskFiles = team.members.map((m) => {
    try {
      return readTaskFile(m.task);
    } catch (e) {
      fail("bad_task", `${m.name}: ${e.message}`);
    }
  });
  const plan = team.members.map((m) => ({ ...m, ...memberCommand(team, m, { home, homedir, env, capOptions: deps.capOptions }) }));
  const wtParent = team.worktrees ?? path.join(path.dirname(repo), `${path.basename(repo)}-wt`);
  out(`Team ${team.team}: lead ${team.lead}, repository ${repo}`);
  for (const m of plan) {
    const roles = `${m.role},${team.team}`;
    if (m.role === "implementer") {
      const where = path.join(wtParent, m.folder ?? m.name);
      out(`  hoptell worktree add ${m.name} --team ${team.team} --cli ${m.cli}${m.owns ? ` --owns '${m.owns.join(",")}'` : ""}  # ${where}, branch team/${team.team}/${m.name}`);
      out(`  hoptell tmux ${m.name} --roles ${roles} --cwd ${where} --task ${m.task} -- ${m.line}`);
    } else out(`  hoptell tmux ${m.name} --roles ${roles} --cwd ${repo} --task ${m.task} -- ${m.line}`);
    for (const w of m.warnings) warn(`warning: ${w}`);
  }
  codexChecks(plan.map((m) => ({ ...m, folder: m.role === "implementer" ? path.join(wtParent, m.folder ?? m.name) : repo })), { repo, homedir, env, warn });
  if (!plan.some((m) => m.role === "reviewer")) warn(`warning: team ${team.team} has no reviewer, so its landings cannot be requested from the owner (--request-approval needs a review of the candidate); the owner lands them in a terminal with hoptell team land <member> --approve <T> <C>`);
  const writers = plan.filter((m) => m.role === "implementer");
  if (writers.length) warn(`warning: ${writers.map((m) => `${m.name} (${m.cli})`).join(", ")} ${writers.length > 1 ? "get write access to their worktrees and run as you; start them" : "gets write access to its worktree and runs as you; start it"} only with the owner's yes`);
  if (dryRun) return out("Dry run: nothing was started (the CLIs' capabilities were read and cached in the hoptell home).");
  if (writers.length && !yes) {
    if (!deps.confirm) fail("needs_yes", "team up starts members with write access: run it in a terminal to confirm, or pass --yes once the owner said yes");
    if (!(await deps.confirm(`Start ${writers.length} member${writers.length > 1 ? "s" : ""} with write access? [y/N] `))) fail("not_confirmed", "nothing was started");
  }
  await deps.prepare?.();
  const paths = teamPaths(home, team.team);
  const result = await withTeam(home, team.team, async (again) => {
    if (again && again.status !== "down") fail("team_up", `team ${team.team} is already up`);
    if (pendingOf(again)) fail("landing_pending", `team ${team.team} still has ${pendingOf(again).member}'s landing: ${pendingOf(again).text}`);
    ensurePrivateDir(paths.tasks);
    const state = {
      version: 1,
      team: team.team,
      file: path.resolve(file),
      fileDigest: digest,
      lead: team.lead,
      prefix: team.prefix,
      repo,
      base: team.base,
      worktrees: team.worktrees,
      idleMinutes: team.idleMinutes,
      status: "starting",
      created: new Date().toISOString(),
      members: plan.map((m) => ({ name: m.name, role: m.role, cli: m.cli, model: m.model, effort: m.effort, template: m.template, owns: m.owns, folder: m.folder, lifetimeMinutes: m.lifetimeMinutes, argv: m.argv, taskDigest: null, cwd: null, worktree: null, branch: null, registration: null, session: null, ended: null, notice: null })),
      supervisor: null,
      candidate: null,
      landing: null,
      publishing: null,
      landed: existing?.landed ?? [], // the history of an earlier team of this name
      reviews: [],
      events: [],
      // The repository enrolment and this start's run id, which landing actions bind (design 8
      // addendum): a new run id at every up, the same enrolment id on the same common git folder.
      run: crypto.randomBytes(16).toString("hex"),
      enrolment: enrolmentOf(repo, again ?? existing),
      actions: [],
    };
    writeState(home, state);
    let base = team.base === "HEAD" ? null : team.base;
    let current = null;
    try {
      // Every worktree first, then the sessions: a running implementer keeps the repository busy
      // (topic 2), so no git command could run once the first one started.
      for (const [i, m] of plan.entries()) {
        current = m.name;
        const sm = state.members[i];
        // The task, kept in the team's folder (0600) so a restart serves the same text.
        const copy = paths.task(m.name);
        fs.rmSync(copy, { force: true });
        fs.writeFileSync(copy, taskFiles[i].bytes, { flag: "wx", mode: 0o600 });
        sm.taskDigest = taskFiles[i].digest;
        if (m.role === "implementer") {
          const rec = await addWorktree(home, { repo, member: m.name, team: team.team, cli: m.cli, folder: m.folder, base, owns: m.owns, parent: team.worktrees });
          base ??= rec.base; // one base for the whole team
          Object.assign(sm, { worktree: rec.path, branch: rec.branch, registration: registrationOf(rec), cwd: rec.path });
        } else sm.cwd = repo;
        writeState(home, state);
      }
      for (const [i, m] of plan.entries()) {
        current = m.name;
        const sm = state.members[i];
        const started = await deps.launch(m.name, m.argv, `${m.role},${team.team}`, { env, home, cwd: sm.cwd, task: paths.task(m.name), attach: false, team: { team: team.team, role: m.role } });
        sm.session = { id: started.sessionId, pane: started.pane, pid: Number(started.pid), root: processIdentity(Number(started.pid)), started: new Date().toISOString() };
        writeState(home, state);
        out(`started ${m.name} (tmux session ${started.sessionId})`);
      }
      current = "the supervisor";
      if (state.idleMinutes || state.members.some((m) => m.lifetimeMinutes)) {
        state.supervisor = await deps.startSupervisor(state);
        out(`started the supervisor (tmux session ${state.supervisor.id}): idle reviewers and lifetimes`);
      }
      state.status = "up";
      state.events.push({ at: new Date().toISOString(), what: "up" });
      writeState(home, state);
    } catch (e) {
      state.status = "partial";
      state.events.push({ at: new Date().toISOString(), what: `up stopped at ${current}: ${String(e.message).slice(0, 300)}` });
      writeState(home, state);
      const next = state.members.some((m) => m.session)
        ? `The members started so far keep running; hoptell team down ${team.team} stops them and removes the clean worktrees.`
        : `No member was started; hoptell team down ${team.team} removes the worktrees made so far.`;
      fail(e.code ?? "team_up", `team up stopped at ${current}: ${e.message}\n${next}`);
    }
    out(`Team ${team.team} is up. hoptell team status ${team.team}`);
    return state;
  });
  await leadCheck(team.lead, deps);
  return result;
}

/**
 * Members reach the lead by its name at the relay, so a lead with no session online there gets
 * none of their messages. A short check after the start (deps.leadOnline: true, false, or null
 * when it could not tell); it only warns, and never fails team up.
 */
export async function leadCheck(lead, { leadOnline, warn }) {
  if (!leadOnline) return;
  let on;
  try {
    on = await leadOnline(lead);
  } catch {
    on = null;
  }
  if (on === false) warn(`warning: the lead ${lead} is not online at the relay, so the members' messages to it fail. Run the lead as a session connected under that name (an agent session, or hoptell wait); hoptell listen only reads a local inbox`);
  else if (on !== true) warn(`warning: could not check whether the lead ${lead} is online at the relay; members reach it only while a session is connected under that name`);
}

// ---- stop, down, restart ------------------------------------------------------------------------

/** Wait until a member's recorded processes are gone (bounded): its state then. */
async function settle(home, m, { wait = STOP_WAIT_MS, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), procs } = {}) {
  let st = sessionState(home, m, procs);
  for (let waited = 0; st === "running" && waited < wait; waited += 100) {
    await sleep(100);
    st = sessionState(home, m, procs);
  }
  return st;
}

/**
 * The identity check of a recorded session's process: "same", "different" or "unknown". Without a
 * recorded identity it is never "same" (no signal is sent): "different" only once the pid is gone.
 */
function identityOf(session, deps) {
  if (session.root) return (deps.procs?.state ?? identityState)(session.root);
  return pidExists(session.pid) === false ? "different" : "unknown";
}

/** endSession, with an error (a tmux failure) taken as "not ended". */
function tryEnd(deps, x) {
  try {
    return deps.endSession(x.pane, x.pid, x.id) === true;
  } catch {
    return false;
  }
}

/**
 * End one member's session by its recorded tmux session id, only while its pane still runs the
 * recorded process (lib/tmux.js endSession) and that process is the one recorded at launch
 * (identity "same"); otherwise no signal is sent. Its own processes are left to tmux's hangup;
 * hoptell kills no process by name. Returns the state after a short wait: "not started",
 * "exited", or "running" / "unknown" when the stop is not confirmed.
 */
async function stopOne(home, m, deps) {
  if (!m.session) return "not started";
  let st = sessionState(home, m, deps.procs);
  if (st === "running") {
    const id = identityOf(m.session, deps);
    if (id !== "same") return id === "different" ? "running" : "unknown";
    tryEnd(deps, m.session);
    st = await settle(home, m, deps);
  }
  return st === "exited" && m.worktree ? lingering(m, deps) : st;
}

/**
 * After an implementer's session exited: a child of it (a CLI's helper process) can still be
 * closing in its worktree, which the worktree commands would refuse. Wait briefly (LINGER_MS, by
 * a monotonic clock that includes the scans) for it, with the scan those commands use, each scan
 * given only the time left; one still there when the time is up is named. A scan that cannot
 * answer leaves it to the commands, unless an earlier one saw a process: that one is named.
 */
async function lingering(m, { procs, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = () => performance.now(), lingerMs = LINGER_MS } = {}) {
  const deadline = now() + lingerMs;
  let last = null;
  for (;;) {
    const p = processIn(m.worktree, { ...procs, clock: now }, Math.max(1, Math.round(deadline - now())));
    if (!p) return "exited";
    if (p.unknown) break;
    last = p;
    if (now() + LINGER_STEP_MS >= deadline) break;
    await sleep(LINGER_STEP_MS);
  }
  return last ? `exited; process ${last.pid} (${last.command || "unknown command"}) still runs in its worktree` : "exited";
}
const LINGER_STEP_MS = 250;
const LINGER_MS = 5000;

const STOPPED = ["not started", "exited"];
/** A stop that ended the member's session (a process it left in its worktree is named apart). */
const isStopped = (st) => STOPPED.includes(st) || st.startsWith("exited; ");

/** End the team's supervisor the same way: "stopped", "not running", or "running" / "unknown". */
async function stopSupervisor(sup, deps) {
  const id = identityOf(sup, deps);
  if (id === "different") return "not running";
  if (id !== "same") return "unknown";
  tryEnd(deps, sup);
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  for (let waited = 0; waited < (deps.wait ?? STOP_WAIT_MS); waited += 100) {
    const now = identityOf(sup, deps);
    if (now === "different") return "stopped";
    if (now !== "same") return "unknown";
    await sleep(100);
  }
  return "running";
}

/** `hoptell team stop <member>`: end one member's session (for a commit, or for good). */
export async function teamStop(home, member, deps) {
  const team = teamOf(home, member);
  return withTeam(home, team, async (s) => {
    const m = s.members.find((x) => x.name === member);
    const st = await stopOne(home, m, deps);
    s.events.push({ at: new Date().toISOString(), what: `stop ${member}: ${st}` });
    writeState(home, s);
    if (!isStopped(st)) fail("still_running", `${member} is not confirmed stopped (${st}); hoptell sent no signal unless its pane still ran the process it started. Check it (hoptell team status), quit it in its pane, or stop its processes by pid`);
    return { member, state: st };
  });
}

/**
 * `hoptell team down [<team>] [--keep-worktrees]`: stop every member and the supervisor by their
 * session ids; then remove the stopped implementers' worktrees by hoptell worktree remove's rules
 * (only clean ones; a branch only by the landing record or when it has no commits), unless
 * `keepWorktrees`. The team is down only when every stop is confirmed; otherwise it stays
 * "stopping" and the command can be run again. Returns {report, down}.
 */
export async function teamDown(home, team, { keepWorktrees = false }, deps) {
  team = pickTeam(home, team);
  return withTeam(home, team, async (s) => {
    if (!s) fail("no_team", `team ${team} has no state`);
    // The run ends here: its auto-land grants are retired first, whatever the stop does.
    if (s.run) {
      const gs = readGrantState(home, team);
      if (settleGrants(home, team, gs, { ...s, status: "down" }, Date.now())) writeGrantState(home, team, gs);
    }
    const report = [];
    let down = true;
    if (s.supervisor) {
      const st = await stopSupervisor(s.supervisor, deps);
      report.push({ name: "supervisor", state: st });
      if (st === "stopped" || st === "not running") s.supervisor = null;
      else down = false;
    }
    for (const m of s.members) {
      const st = await stopOne(home, m, deps);
      report.push({ name: m.name, state: st });
      if (!isStopped(st)) down = false;
    }
    for (const m of s.members.filter((x) => x.role === "implementer" && x.worktree)) {
      const r = report.find((x) => x.name === m.name);
      if (pendingOf(s)?.member === m.name) {
        // Its worktree, registration, candidate and journal are the landing's evidence.
        r.worktree = `kept (${pendingOf(s).text})`;
        continue;
      }
      if (keepWorktrees) {
        r.worktree = "kept (--keep-worktrees)";
        continue;
      }
      if (!isStopped(r.state)) {
        r.worktree = "kept (the member is not confirmed stopped)";
        continue;
      }
      const wr = readWorktreeRecord(home, m.name);
      if (wr.absent) {
        r.worktree = "already removed";
        continue;
      }
      if (!wr.rec) {
        r.worktree = `kept: ${wr.problem}`;
        continue;
      }
      if (!sameAs(wr.rec, m.registration)) {
        r.worktree = `kept: the worktree record of ${m.name} is for ${wr.rec.repo} (${wr.rec.path}), not the one this team registered`;
        continue;
      }
      try {
        await deps.beforeRemove?.(m.name);
        // Bound to the registration: a record replaced after the check above is refused, not removed.
        const out = await removeWorktree(home, m.name, { landed: landingOf(s, m.name), procs: deps.procs, bound: m.registration });
        r.worktree = `removed; branch ${out.branch} ${out.branchState}${out.keptBecause ? ` (${out.keptBecause})` : ""}`;
      } catch (e) {
        if (!e.code) throw e;
        r.worktree = `kept: ${e.message}`;
      }
    }
    s.status = down ? "down" : "stopping";
    s.events.push({ at: new Date().toISOString(), what: down ? "down" : `down not confirmed: ${report.filter((r) => !["stopped", "not running"].includes(r.state) && !isStopped(r.state)).map((r) => `${r.name} ${r.state}`).join(", ")}` });
    writeState(home, s);
    return { report, down, pending: pendingOf(s)?.text ?? null };
  });
}

/**
 * `hoptell team restart <member>`: start a stopped member again, fresh, with its team-file
 * command, the same task and worktree, and a restart prompt (its branch and head). A running
 * member is refused: stop it first.
 */
export async function teamRestart(home, member, { homedir, env }, deps) {
  const team = teamOf(home, member);
  return withTeam(home, team, async (s) => {
    if (s.status === "down") fail("team_down", `team ${team} is down; hoptell team up <team file> starts it again`);
    const m = s.members.find((x) => x.name === member);
    const st = sessionState(home, m, deps.procs);
    if (st === "running" || st === "unknown") fail("still_running", `${member} is ${st === "running" ? "still running" : "maybe still running"}; hoptell team stop ${member} first`);
    launchPreflight(s.repo, [m]);
    const t = { lead: s.lead };
    let prompt = null;
    if (m.role === "implementer") {
      const rec = readWorktreeRecord(home, member);
      if (rec.problem) fail("no_worktree", rec.problem);
      if (!sameAs(rec.rec, m.registration)) fail("not_this_team", `the worktree record of ${member} is for ${rec.rec.repo} (${rec.rec.path}), not the worktree team ${team} registered${m.registration ? ` in ${m.registration.repo} (${m.registration.path})` : ""}; nothing was started`);
      prompt = restartPrompt(m.template, s.lead, { branch: rec.rec.branch, head: rec.rec.head });
    }
    const cmd = memberCommand(t, { ...m, task: null }, { home, homedir, env, capOptions: deps.capOptions, prompt });
    for (const w of cmd.warnings) deps.warn(`warning: ${w}`);
    await deps.prepare?.();
    const started = await deps.launch(m.name, cmd.argv, `${m.role},${team}`, { env, home, cwd: m.cwd, task: teamPaths(home, team).task(m.name), attach: false, team: { team, role: m.role } });
    Object.assign(m, { argv: cmd.argv, ended: null, notice: null, session: { id: started.sessionId, pane: started.pane, pid: Number(started.pid), root: processIdentity(Number(started.pid)), started: new Date().toISOString() } });
    s.events.push({ at: new Date().toISOString(), what: `restarted ${member}` });
    writeState(home, s);
    return { member, sessionId: started.sessionId };
  });
}

// ---- status -------------------------------------------------------------------------------------

/**
 * `hoptell team status [<team>]`: per member its role, CLI, model and effort at launch, session
 * state, worktree and branch, commits, and (only while the repository is quiet) changed files and
 * those outside owns; a candidate being published, the candidate, landings and the supervisor's events.
 */
export async function teamStatus(home, team, deps = {}) {
  team = pickTeam(home, team);
  const s = readState(home, team);
  if (!s) fail("no_team", `team ${team} has no state`);
  const now = (deps.now ?? Date.now)();
  const members = [];
  for (const m of s.members) {
    const row = { name: m.name, role: m.role, cli: m.cli, model: m.model ?? "CLI default", effort: m.effort ?? "CLI default", state: m.ended ? `ended (${m.ended.reason})` : sessionState(home, m, deps.procs), session: m.session?.id ?? null };
    if (m.session && m.lifetimeMinutes) row.lifetimeEnds = new Date(Date.parse(m.session.started) + m.lifetimeMinutes * 60_000).toISOString();
    // What its injector sees it wait on (design 9, B): only while it runs.
    const wait = row.state === "running" ? readOccurrence(home, m.name) : null;
    if (wait) row.waiting = { id: wait.id, kind: wait.kind, subtype: wait.subtype, since: wait.since, text: waitLine(wait, now), attach: `tmux attach -t '=${sessionFor(m.name)}'` };
    if (m.role === "implementer") {
      const found = readWorktreeRecord(home, m.name).rec;
      // A record of the same name for another worktree is not this member's.
      const rec = found && sameAs(found, m.registration) ? found : null;
      Object.assign(row, { worktree: m.worktree, branch: m.branch, base: rec?.base ?? null, head: rec?.head ?? null, commits: rec ? rec.commits.length : null, owns: m.owns });
      if (found && !rec) row.git = `not run: the worktree record of ${m.name} is for ${found.repo} (${found.path}), not the one this team registered`;
      // No worktree: hoptell removed it (a landing, or team down), or it was never made.
      if (!found) row.noWorktree = s.status === "down" || s.landed.some((l) => l.member === m.name) ? "worktree removed" : "no worktree";
      if (rec) {
        const g = await worktreeStatus(home, m.name, { procs: deps.procs, bound: m.registration });
        if (g.skipped) row.git = `not run: ${g.skipped}`;
        else Object.assign(row, { changed: g.changed.length, outside: g.outside });
      }
    }
    members.push(row);
  }
  const sup = s.supervisor ? (identityState(s.supervisor.root) === "same" ? "running" : "not running") : "none";
  return { team, status: s.status, lead: s.lead, repo: s.repo, members, supervisor: sup, publishing: s.publishing, candidate: s.candidate, evidence: s.evidence ?? null, landing: s.landing, actions: s.actions ?? [], orphans: orphanActions(home, team, (s.actions ?? []).map((a) => a.id)), landed: s.landed, reviews: s.reviews.map(reviewSummary), grants: grantsView(home, team, s, now), events: s.events.slice(-10), at: new Date(now).toISOString() };
}

// ---- the lead's summary (design 8, 3.2) ----------------------------------------------------------

/**
 * A member's state in the lead's summary. exited: its session ended or is gone; unknown: hoptell
 * cannot tell. A running reviewer is "in review" while a request waits for its verdict, else
 * "ready". A running implementer, by the latest review request of its recorded head (or of its
 * candidate): "in review" while a reviewer has not answered, "approved" when every one approved,
 * "working" after a "changes" (a candidate counts while it is of that head); without such a request "ready" when hoptell has committed its work
 * (its "ready" reached the lead), else "working".
 */
function summaryState(home, s, m, procs) {
  if (m.ended) return "exited";
  const run = sessionState(home, m, procs);
  if (run === "exited" || run === "not started") return "exited";
  if (run !== "running") return "unknown";
  const reviews = s.reviews.map(reviewSummary);
  if (m.role === "reviewer") return reviews.some((r) => r.waiting.includes(m.name)) ? "in review" : "ready";
  const found = m.worktree ? readWorktreeRecord(home, m.name).rec : null;
  const rec = found && sameAs(found, m.registration) ? found : null;
  // The candidate's review counts only while the candidate is of the head recorded now.
  const cand = s.candidate?.member === m.name && rec && s.candidate.H === rec.head ? s.candidate.C : null;
  const heads = [rec?.head, cand].filter(Boolean);
  const latest = reviews.filter((r) => r.member === m.name && heads.includes(r.head)).at(-1);
  if (latest) return latest.waiting.length ? "in review" : latest.answers.every((a) => a.verdict === "approve") ? "approved" : "working";
  return rec?.commits.length ? "ready" : "working";
}

/**
 * The summary the session `lead` publishes as its owner-only status (lib/teamstatus.js): every
 * team of this home that it leads and that is not down, as text within STATUS_MAX_BYTES, or null
 * when it leads none. Reads only what hoptell recorded (no git); a team whose state cannot be
 * read is left out. Never throws. It runs `ps` (once) and reads files synchronously: the engine runs
 * it only in lib/teamstatus-helper.mjs, a process of its own with a deadline.
 */
export function leadStatus(home, lead, deps = {}) {
  // One process table for every check (lib/teamstatus-helper.mjs runs this in its own process).
  let table;
  const once = () => (table === undefined ? (table = (deps.table ?? processTable)()) : table);
  const fromTable = (id) => {
    const t = once();
    if (!t) return "unknown";
    return identityState(id, { info: (pid) => (t.get(pid)?.unknown ? null : (t.get(pid) ?? null)) });
  };
  const procs = { table: once, state: deps.state ?? fromTable };
  const L = SUMMARY_LIMITS;
  const teams = [];
  let names = [];
  try {
    names = listTeams(home);
  } catch {
    return null;
  }
  for (const team of names) {
    if (teams.length >= L.teams) break;
    try {
      const s = readState(home, team);
      if (!s || s.lead !== lead || s.status === "down") continue;
      const members = s.members.slice(0, L.members).map((m) => ({
        name: m.name,
        role: m.role,
        cli: clipText(m.cli, L.cli),
        model: m.model == null ? null : clipText(m.model, L.model),
        effort: m.effort == null ? null : clipText(m.effort, L.effort),
        branch: m.branch == null ? null : clipText(m.branch, L.branch),
        state: summaryState(home, s, m, procs),
      }));
      // Only reviews of an implementer listed here, waiting for reviewers listed here (what a
      // reader checks: lib/teamstatus.js parseTeamStatus).
      const listed = (n, role) => members.some((x) => x.name === n && x.role === role);
      const reviews = s.reviews
        .map(reviewSummary)
        .filter((r) => r.waiting.length && listed(r.member, "implementer") && r.waiting.every((n) => listed(n, "reviewer")))
        .slice(-L.reviews)
        .map((r) => ({ id: r.id, member: r.member, waiting: r.waiting.slice(0, L.waiting) }));
      teams.push({ team, status: s.status, members, more: s.members.length - members.length, reviews });
    } catch {
      // an unreadable state: that team is left out
    }
  }
  if (!teams.length) return null;
  return JSON.stringify(fitSummary({ v: 1, teams }));
}

// ---- landing ----------------------------------------------------------------------------------

const landRefOf = (team) => `refs/heads/team/${team}/land`;

/** The landing record of `member` in a team state: {head, candidate, target}, or null. */
export function landingOf(s, member) {
  const l = [...(s?.landed ?? [])].reverse().find((x) => x.member === member);
  return l ? { head: l.H, candidate: l.C, target: l.target } : null;
}

/**
 * For hoptell worktree add and remove: refuses a member name that a team of this home (active or
 * down) still has a landing pending for, so a record of that name is never replaced under the
 * landing. A team state that cannot be read refuses as well (it might hold one).
 */
export function checkNoPending(home, member) {
  for (const t of listTeams(home)) {
    let s;
    try {
      s = readState(home, t);
    } catch (e) {
      fail("bad_state", `${e.message}; hoptell cannot tell whether a landing of ${member} is pending there, so it changes no worktree of that name`);
    }
    const p = pendingOf(s);
    if (p?.member === member) fail("landing_pending", `team ${t} has a landing of ${member} pending; finish or discard it first: ${p.text}`);
  }
}

/**
 * The latest landing record of `member` in any team of the home, active or down (for hoptell
 * worktree remove, which still checks it against the worktree and the target).
 */
export function landedFor(home, member) {
  let best = null;
  for (const t of listTeams(home)) {
    let s;
    try {
      s = readState(home, t);
    } catch {
      continue;
    }
    for (const l of s?.landed ?? []) if (l.member === member && (!best || l.at > best.at)) best = l;
  }
  return best ? { head: best.H, candidate: best.C, target: best.target } : null;
}

/**
 * `hoptell team land <member> --target <branch> -m <message>`: build and publish the candidate.
 * The publication is journaled: everything that can fail runs first, then a journal
 * (`publishing`: member, target, T, H, C) is written, the branch is created create-only, and the
 * candidate is recorded with the journal cleared in one write. A run that stopped half-way is
 * finished by the same command (the branch adopted when it is exactly C, the journal dropped when
 * the branch is absent), or dropped by --discard. `deps.save` (tests): the state writer.
 */
export async function teamLandCandidate(home, member, { target, message, homedir, sshAuthSock }, deps = {}) {
  const team = landingTeamOf(home, member);
  const save = deps.save ?? writeState;
  return withTeam(home, team, async (s) => {
    const opts = { procs: deps.procs, homedir, git: deps.git };
    if (s.publishing) {
      const p = s.publishing;
      if (p.member !== member || p.target !== target) fail("candidate_pending", `a candidate for ${p.member} on ${p.target} was being published; run hoptell team land ${p.member} --target ${p.target} -m <message> again to finish it, or --discard`);
      const r = await adoptCandidate(home, member, { landRef: landRefOf(team), target: p.target, T: p.T, H: p.H, C: p.C, bound: registrationFor(s, member) }, opts);
      const at = new Date().toISOString();
      if (r.state === "adopted") {
        save(home, { ...s, publishing: null, candidate: { member, target: p.target, T: p.T, C: p.C, H: p.H, at }, evidence: null, events: [...s.events, { at, what: `candidate ${p.C} for ${member} on ${p.target} at ${p.T} (its publication finished)` }] });
        return { target: p.target, T: p.T, C: p.C, H: p.H, stat: r.stat, adopted: true, rebased: r.rebased };
      }
      // Never published: the journal goes, and a new candidate is built below (on an active team).
      s.publishing = null;
      s.events.push({ at, what: `dropped the publication of ${p.C} for ${member}: its branch was never created` });
      save(home, s);
    }
    if (s.status === "down") fail("team_down", `team ${team} is down; hoptell team up starts it before a new candidate is built`);
    if (s.landing) fail("landing_pending", `the landing of ${s.landing.member} did not finish; run hoptell team land ${s.landing.member} --approve ${s.landing.T} ${s.landing.C} again first`);
    if (s.candidate) fail("candidate_exists", `a candidate for ${s.candidate.member} (${s.candidate.C.slice(0, 12)} on ${s.candidate.target}) waits; land or discard it first`);
    const bound = registrationFor(s, member);
    let journaled = false;
    const hooks = {
      afterPublish: deps.afterPublish,
      publishing: ({ T, H, C }) => {
        const p = { member, target, T, H, C, at: new Date().toISOString() };
        save(home, { ...s, publishing: p });
        s.publishing = p;
        journaled = true;
      },
    };
    let c;
    try {
      c = await landCandidate(home, member, { target, message, landRef: landRefOf(team), bound }, { ...opts, sshAuthSock, hooks });
    } catch (e) {
      // The journal goes only when the branch was certainly not created.
      if (journaled && e.publishOutcome === "not created") {
        s.publishing = null;
        try {
          save(home, s);
        } catch {}
      }
      throw e;
    }
    const at = new Date().toISOString();
    save(home, { ...s, publishing: null, candidate: { member, target: c.target, T: c.T, C: c.C, H: c.H, at }, evidence: null, events: [...s.events, { at, what: `candidate ${c.C} for ${member} on ${c.target} at ${c.T}` }] });
    return c;
  });
}

/**
 * `hoptell team land <member> --approve <T> <C>` (or `--confirm <T> <C>` after the owner's own
 * fast-forward of a checked-out target): land the recorded candidate and record provenance. The
 * order keeps evidence until the record is durable: a journal of the intent (repository, member,
 * H, target, T, C) is written before the target moves; the landing is recorded once the target is
 * at C; only then are the candidate branch, the worktree and the journal removed. A run that
 * stopped half-way is finished by the same command. `actionId`: the decision is for exactly that
 * requested action; `route` "bridge" with `receipt` (teamApply's checked decision): it came from
 * the owner's Telegram. `deps.save` (tests): the state writer. Returns landApprove's result.
 */
export async function teamLandApprove(home, member, { T, C, homedir, confirm = false, actionId = null, route: given = "terminal", receipt: kept = null }, deps = {}) {
  let route = given;
  let receipt = kept;
  const team = landingTeamOf(home, member);
  const save = deps.save ?? writeState;
  const now = deps.now ?? Date.now;
  return withTeam(home, team, async (s) => {
    // A team started before landing actions: its pending journal and the owner's --confirm still
    // finish as before (--discard works too); nothing new lands there.
    if (!s.enrolment || (s.landing && !s.landing.action)) {
      if (!s.landing && !confirm) fail("legacy_team", `team ${team} was started before landing actions (or its repository has no enrolment), so hoptell lands nothing new in it: discard the candidate (hoptell team land ${member} --discard), run hoptell team down ${team} and hoptell team up again, then build the candidate again`);
      return legacyLandApprove(home, team, s, member, { T, C, homedir, confirm }, deps, save);
    }
    const iso = () => new Date(now()).toISOString();
    // An action whose tombstone exists ended in a run that stopped before the state was written:
    // the state catches up, but only for a final record of exactly that action (a malformed or
    // mismatched one refuses and changes nothing). This member's landing of exactly (T, C) that
    // finished is done, with the cleanup's result its tombstone recorded.
    let done = null;
    for (const a of [...s.actions]) {
      const tomb = readTombstone(home, team, a.id);
      if (!tomb) continue;
      if (!tombstoneOf(tomb, a, readManifest(home, team, a.id, a.digest)) || tomb.intent.T !== a.T || tomb.intent.C !== a.C || tomb.intent.target !== a.target) fail("action_changed", `the final record of the landing ${a.id} does not match that action in team ${team}'s state; hoptell changes nothing by it. Check ${path.join(home, "teams", team, "landings", a.id)}`);
      s.actions = s.actions.filter((x) => x.id !== a.id);
      if (s.landing?.action === a.id) s.landing = null;
      if (tomb.state === "finished" && s.candidate?.member === a.member) s.candidate = null;
      if (tomb.state === "finished" && s.evidence?.member === a.member) s.evidence = null;
      if (tomb.state === "finished" && a.member === member && a.T === T && a.C === C) done = { a, tomb };
      s.events.push({ at: iso(), what: `landing ${a.id} of ${a.member}: ${tomb.state} (recorded again after an interrupted run)` });
      save(home, s);
    }
    if (done) return { id: done.a.id, target: done.a.target, T, C, H: done.tomb.intent.H, removed: done.tomb.result ?? { kept: false, already: true }, checkedOut: null, observed: null };
    const other = s.actions.find((a) => a.member !== member && !["ready", "approved"].includes(a.state));
    if (other) fail("landing_pending", `${actionText(other)}; finish it first`);
    if (s.landing && s.landing.member !== member) fail("landing_pending", `a landing of ${s.landing.member} (${s.landing.C.slice(0, 12)} on ${s.landing.target}) did not finish; run hoptell team land ${s.landing.member} --approve ${s.landing.T} ${s.landing.C} again first`);
    let action = s.actions.find((a) => a.member === member) ?? null;
    // hoptell team approve <id>: exactly that live action, decided as it was shown.
    if (actionId && action?.id !== actionId) fail("action_gone", `the landing ${actionId} is no longer ${member}'s live landing; nothing was moved. hoptell team status ${team} shows what is pending`);
    const update = (st, extra = {}) => Object.assign(action, { state: st, updated: iso(), ...extra });
    // An action leaves the live state only after its tombstone is written.
    const end = (st, reason, extra = {}) => {
      writeTombstone(home, team, action, manifest, { state: st, reason, at: iso(), ...extra });
      s.actions = s.actions.filter((a) => a.id !== action.id);
      if (s.landing?.action === action.id) s.landing = null;
      s.events.push({ at: iso(), what: `landing ${action.id} of ${member}: ${st}${reason ? ` (${reason.slice(0, 300)})` : ""}` });
      action = null;
    };
    let manifest = action ? readManifest(home, team, action.id, action.digest) : null;
    const startedYet = (a) => a && !["ready", "approved"].includes(a.state);
    // A decision from the owner's Telegram (`receipt`, checked by teamApply) is usable from the tap,
    // made before the action expired, for APPLY_WINDOW_MS; a terminal decision until the action expires.
    // An action approved by an auto-land grant: the grant is checked at acceptance instead.
    const expired = (m) => (route === "grant" ? false : route === "bridge" ? receipt.decided_at > Date.parse(m.expires_at) || now() > receipt.decided_at + APPLY_WINDOW_MS : Date.parse(m.expires_at) <= now());
    const expiredLine = (id, m) => (route === "bridge" ? `the owner's decision for ${id} can no longer be applied (it was made at ${new Date(receipt.decided_at).toISOString()}); nothing was moved. Run hoptell team land ${member} --request-approval again` : expiredText(id, m, member));
    // One decision per action, whichever route it comes by (design 8 addendum, option 3): a
    // decision from the owner's Telegram that the lead's engine already kept is honoured before any
    // terminal or manual acceptance. A Reject ends the action; a Land means it is approved by that
    // route. A different decision needs a new action.
    // An action an auto-land grant approved goes on by that grant on every route (terminal, manual,
    // apply), started or not: the grant is checked at acceptance and again before any move.
    if (action?.route === "grant") route = "grant";
    if (action && !startedYet(action) && route === "terminal") {
      const d = keptDecision(home, team, action, manifest, deps);
      if (d?.decision === "reject") {
        const id = action.id;
        Object.assign(action, { route: "bridge", decision: d.receipt });
        end("rejected", "the owner rejected it on Telegram");
        save(home, s);
        fail("action_rejected", rejectedText(id, member, Boolean(actionId)));
      }
      if (d?.decision === "land") {
        route = "bridge";
        receipt = d;
        if (action.state === "ready") update("approved", { route, decision: d.receipt });
        save(home, s);
      }
    }
    if (action && (manifest.T !== T || manifest.C !== C)) {
      if (startedYet(action)) fail("landing_pending", `${actionText(action)}; finish it first`);
      end("superseded", `the decision is now for ${C} at ${T}`);
      manifest = null;
      save(home, s);
    }
    // --confirm reconciles the owner's own move: a decided action that never started gives way.
    if (confirm && action && !startedYet(action)) {
      end("superseded", "the owner confirmed a landing of their own");
      manifest = null;
      save(home, s);
    }
    // The first decision registered wins: a terminal or manual decision on an action that is still
    // ready is written down (approved, route terminal) before the repository is waited for, under
    // the team's lock, which the lead's engine also takes to keep a Telegram decision. One that
    // arrives meanwhile is then kept out as a conflict (ingestLandingDecision).
    if (action?.state === "ready" && route === "terminal") {
      update("approved", { route: "terminal" });
      save(home, s);
    }
    const c = s.candidate?.member === member ? s.candidate : null;
    const bound = registrationFor(s, member, s.landing);
    // A recorded landing whose worktree is already gone: only the bookkeeping is left.
    const finish = (removed = null) => {
      s.candidate = null;
      if (s.evidence?.member === member) s.evidence = null;
      end("finished", null, { result: removed });
      save(home, s);
    };
    if (action?.state === "landed" && readWorktreeRecord(home, member).absent) {
      const id = action.id;
      finish();
      return { id, target: manifest.target, T, C, H: manifest.H, removed: { kept: false, already: true }, checkedOut: null };
    }
    const hooks = {
      beforeMove: deps.beforeMove,
      afterMoving: deps.afterMoving,
      afterMove: deps.afterMove,
      afterRecord: deps.afterRecord,
      // The decision typed on this terminal: a new action (ready, then approved), or a ready or
      // approved one that still matches exactly and has not expired.
      begin: async (info) => {
        if (action) {
          const m = manifest;
          const same = m.target === info.target && m.T === info.T && m.H === info.H && m.C === info.C && canonicalize(m.mode) === canonicalize(info.mode) && canonicalize(m.enrolment) === canonicalize(s.enrolment) && m.run === s.run;
          if (!same) end("superseded", "the target, the commits, the mode or the enrolment changed");
          else if (expired(m)) end("expired", null);
          // The decision shown by hoptell team approve is for that action only: none is made anew.
          if (actionId && !action) {
            save(home, s);
            if (same) fail("action_expired", expiredLine(actionId, m));
            fail("action_changed", `the landing ${actionId} no longer matches the repository (the target, the commits, its checkout or the enrolment changed), so it was ended; nothing was moved. ${route === "bridge" ? "Run" : "Ask the lead to run"} hoptell team land ${member} --request-approval again`);
          }
          if (action) {
            if (action.state === "ready") update("approved", { route, decision: receipt?.receipt ?? null });
            save(home, s);
            return m;
          }
          save(home, s);
        }
        const id = await newActionId(home);
        const created = new Date(now());
        const made = createManifest(home, team, id, {
          realm: null,
          enrolment: s.enrolment,
          team,
          run: s.run,
          member,
          target: info.target,
          T: info.T,
          H: info.H,
          C: info.C,
          parent: info.T,
          mode: info.mode,
          cleanup: { worktree: info.worktree, branch: info.branch, candidate: info.candidate },
          recipient: null,
          evidence: null,
          created_at: created.toISOString(),
          expires_at: new Date(created.getTime() + ACTION_TTL_MS).toISOString(),
          nonce: crypto.randomBytes(16).toString("hex"),
        });
        manifest = made.manifest;
        action = { id, digest: made.digest, member, state: "ready", route: null, decision: null, reason: null, created: created.toISOString(), updated: created.toISOString(), target: info.target, T: info.T, C: info.C };
        s.actions.push(action);
        s.events.push({ at: iso(), what: `landing ${id} of ${member}: ${info.C} on ${info.target} at ${info.T} (${info.mode.kind === "checkout" ? `checked out in ${info.mode.worktree}` : "branch only"})` });
        save(home, s);
        update("approved", { route: "terminal" });
        save(home, s);
        manifest = made.manifest;
        return manifest;
      },
      // Execution starts: checked against expiry; the journal is written in the same transition.
      accept: () => {
        // Under an auto-land grant: checked with the action (signature or source, scope, times,
        // run, revocation, count), and its slot reserved durably before the action is accepted;
        // a retry keeps the same slot, and an unknown outcome never gives it back.
        if (route === "grant") {
          const gs = readGrantState(home, team);
          let g;
          try {
            g = checkGrant(home, team, s, gs, { id: grantOfDigest(home, team, action.decision), digest: action.decision, phase: "accept", target: manifest.target, action: action.id, now: now(), pinFor: (realm) => (deps.pinFor ?? pinFor)(home, realm) });
          } catch (e) {
            if (!grantRefusal(e)) throw e;
            const id = action.id;
            end(e.code === "grant_expired" ? "expired" : "rejected", e.message.slice(0, 300));
            save(home, s);
            fail(e.code ?? "grant_unusable", `${e.message}, so the landing ${id} was not auto-landed and ended; nothing was moved. Run hoptell team land ${member} --request-approval again: the owner decides it`);
          }
          reserveSlot(gs, g, action.id);
          writeGrantState(home, team, gs);
        }
        if (expired(manifest)) {
          const id = action.id;
          const m = manifest;
          end("expired", null);
          save(home, s);
          if (actionId) fail("action_expired", expiredLine(id, m));
          fail("action_expired", `the decision for this landing expired; nothing was moved. Run the same hoptell team land ${member} --approve ${T} ${C} again`);
        }
        update("accepted");
        s.landing = { member, H: manifest.H, C, T, target: manifest.target, at: iso(), repo: bound.repo, phase: "intent", action: action.id };
        save(home, s);
      },
      moving: () => {
        // A revocation (or team down) after the acceptance still stops it before the move.
        if (route === "grant" || action.route === "grant") {
          try {
            checkGrant(home, team, s, readGrantState(home, team), { id: grantOfDigest(home, team, action.decision), digest: action.decision, phase: "move", action: action.id, now: now(), pinFor: (realm) => (deps.pinFor ?? pinFor)(home, realm) });
          } catch (e) {
            if (!grantRefusal(e)) throw e;
            const id = action.id;
            end("rejected", `${e.message.slice(0, 300)} before the move`);
            save(home, s);
            fail(e.code ?? "grant_unusable", `${e.message} before the move, so the landing ${id} ended; nothing was moved. Run hoptell team land ${member} --request-approval again: the owner decides it`);
          }
        }
        update("moving");
        save(home, s);
      },
      block: (reason, { moved }) => {
        if (!action) return;
        if (moved) update("blocked", { reason });
        else end("blocked", reason);
        save(home, s);
      },
      landed: () => {
        const at = iso();
        update("landed");
        s.landed = [...s.landed, { member, H: manifest.H, C, T, target: manifest.target, at }];
        s.landing = { ...(s.landing ?? { member, H: manifest.H, C, T, target: manifest.target, at, repo: bound.repo, action: action.id }), phase: "landed" };
        s.events.push({ at, what: `landed ${member}: ${manifest.H} as ${C} on ${manifest.target} at ${T} (landing ${action.id})` });
        save(home, s);
      },
    };
    const candidate = c ?? (manifest ? { target: manifest.target, T: manifest.T, C: manifest.C, H: manifest.H } : null);
    const live = action ? { id: action.id, state: action.state, reason: action.reason, manifest } : null;
    let r;
    try {
      r = await landAction(home, member, { T, C, candidate, landRef: landRefOf(team), confirm, live, common: s.enrolment.common, bound, requested: actionId ? route : false }, { procs: deps.procs, homedir, git: deps.git, hooks });
    } catch (e) {
      // An unknown outcome whose target is still at T with one clean checkout: the paste-safe
      // line, which checks again and merges only when both checks pass, then --confirm.
      if (e?.paste) {
        const p = e.paste;
        e.message += `\n${p.target} is still at ${p.T} and ${p.at} is clean. Check what happened there first; to land it by hand, run the line below in that folder: it checks again that HEAD is refs/heads/${p.target} at ${p.T}, and fast-forwards only when both checks pass.\n  cd ${shellLine(p.at, []).trim()}\n  test "$(git symbolic-ref HEAD)" = refs/heads/${p.target} && test "$(git rev-parse HEAD)" = ${p.T} && git merge --ff-only ${p.C}\nthen record it: ${p.confirm}`;
      }
      throw e;
    }
    finish(r.removed);
    return r;
  });
}

/**
 * `hoptell team land <member> --abandon <id>` (the owner's step): give up a landing action whose
 * outcome is unknown (accepted, moving or blocked). hoptell reads the target and its checkout and
 * shows them, and infers nothing from them: not a success from a target at C, not "nothing moved"
 * from one at T. It writes the action's final record (`abandoned`: the original intent, what it
 * saw, and why) first, so the action and its decision are never usable again; only then does the
 * action leave the team's state with its journal. It moves, merges and resets nothing, records no
 * landing, and keeps the candidate, its branch and the worktree for --discard or your own
 * cleanup. With `dryRun` it only reads. Returns {id, observed, target, T, C}.
 */
export async function teamLandAbandon(home, member, id, { dryRun = false } = {}, deps = {}) {
  const team = landingTeamOf(home, member);
  const save = deps.save ?? writeState;
  return withTeam(home, team, async (s) => {
    const action = (s.actions ?? []).find((a) => a.id === id && a.member === member);
    if (!action) fail("no_action", `${member} has no live landing ${id} in team ${team}${(s.actions ?? []).some((a) => a.id === id) ? " (it is another member's)" : ""}; nothing was changed`);
    if (!["accepted", "moving", "blocked"].includes(action.state)) fail("not_abandonable", `the landing ${id} is ${action.state}; only a landing whose outcome is unknown (accepted, moving or blocked) is abandoned. ${action.state === "landed" ? "It landed: hoptell team land --approve finishes it" : "Drop a decision that did not start with hoptell team land --discard"}`);
    const manifest = readManifest(home, team, action.id, action.digest);
    let observed;
    try {
      observed = await observeTarget(home, member, { target: manifest.target, T: manifest.T, C: manifest.C, common: s.enrolment.common, bound: registrationFor(s, member, s.landing) }, { procs: deps.procs, git: deps.git });
    } catch (e) {
      observed = `${manifest.target} and its checkout could not be read (${String(e.message).slice(0, 300)})`;
    }
    const out = { id, observed, target: manifest.target, T: manifest.T, C: manifest.C };
    if (dryRun) return out;
    writeTombstone(home, team, action, manifest, { state: "abandoned", reason: `abandoned by the owner while ${action.state}${action.reason ? ` (${action.reason})` : ""}; the outcome of the earlier move was not inferred`.slice(0, 2000), observed: observed.slice(0, 4000), at: new Date().toISOString() });
    s.actions = s.actions.filter((a) => a.id !== id);
    if (s.landing?.action === id) s.landing = null;
    s.events.push({ at: new Date().toISOString(), what: `landing ${id} of ${member}: abandoned by the owner (outcome unknown; ${observed.slice(0, 300)})` });
    save(home, s);
    return out;
  });
}

async function legacyLandApprove(home, team, s, member, { T, C, homedir, confirm }, deps, save) {
  {
    const c = s.candidate?.member === member ? s.candidate : null;
    const j = s.landing && s.landing.member === member && s.landing.T === T && s.landing.C === C ? s.landing : null;
    if (s.landing && !j) fail("landing_pending", `a landing of ${s.landing.member} (${s.landing.C.slice(0, 12)} on ${s.landing.target}) did not finish; run hoptell team land ${s.landing.member} --approve ${s.landing.T} ${s.landing.C} again first`);
    const done = (what) => {
      s.landing = null;
      s.candidate = null;
      s.events.push({ at: new Date().toISOString(), what });
      save(home, s);
    };
    // A recorded landing whose worktree is already gone: only the journal is left to clear.
    // Only a record that does not exist proves that; one that cannot be read is refused below.
    const bound = registrationFor(s, member, j);
    if (j?.phase === "landed" && readWorktreeRecord(home, member).absent) {
      done(`finished the landing of ${member}`);
      return { target: j.target, T, C, H: j.H, removed: { kept: false, already: true }, checkedOut: null };
    }
    let intended = false;
    const hooks = {
      beforeMove: deps.beforeMove,
      afterMove: deps.afterMove,
      afterRecord: deps.afterRecord,
      intent: () => {
        s.landing = { member, H: c.H, C, T, target: c.target, at: new Date().toISOString(), repo: bound.repo, phase: "intent" };
        intended = true;
        save(home, s);
      },
      landed: () => {
        const at = new Date().toISOString();
        const landed = [...s.landed, { member, H: c.H, C, T, target: c.target, at }];
        save(home, { ...s, landed, landing: { ...(s.landing ?? { member, H: c.H, C, T, target: c.target, at, repo: bound.repo }), phase: "landed" }, events: [...s.events, { at, what: `landed ${member}: ${c.H} as ${C} on ${c.target} at ${T}` }] });
        s.landed = landed;
        s.landing = { ...(s.landing ?? { member, H: c.H, C, T, target: c.target, at, repo: bound.repo }), phase: "landed" };
        s.events.push({ at, what: `landed ${member}: ${c.H} as ${C} on ${c.target} at ${T}` });
      },
    };
    let r;
    try {
      r = await landApprove(home, member, { T, C, candidate: c, landRef: landRefOf(team), confirm, journaled: j?.phase ?? null, bound }, { procs: deps.procs, homedir, git: deps.git, hooks });
    } catch (e) {
      // The intent of this run is dropped only when nothing moved; a move that happened, or whose
      // outcome is unknown, keeps it (and a recorded landing is never dropped), so the same
      // command finishes it. A crash leaves it for the next run as well.
      if (intended && s.landing?.phase === "intent" && ["not attempted", "not moved"].includes(e.landOutcome)) {
        s.landing = null;
        try {
          save(home, s);
        } catch {}
      }
      throw e;
    }
    done(`finished the landing of ${member}${r.checkedOut ? ` (${r.target} was checked out in ${r.checkedOut} meanwhile)` : ""}`);
    return r;
  }
}

/** `hoptell team land <member> --discard`: drop the recorded candidate and its branch. */
export async function teamLandDiscard(home, member, deps = {}) {
  const team = landingTeamOf(home, member);
  return withTeam(home, team, async (s) => {
    const p = s.publishing?.member === member ? s.publishing : null;
    const c = p ?? (s.candidate?.member === member ? s.candidate : null);
    if (!c) fail("no_candidate", `no candidate is recorded for ${member}`);
    if (s.landing) fail("landing_pending", `the landing of ${s.landing.C.slice(0, 12)} did not finish; run hoptell team land ${member} --approve ${s.landing.T} ${s.landing.C} again, which finishes it`);
    // A decided landing that never started ends with its candidate; a started one refuses.
    const a = s.actions?.find((x) => x.member === member) ?? null;
    if (a && !["ready", "approved"].includes(a.state)) fail("landing_pending", actionText(a));
    // A deletion that did not happen refuses here and keeps the record for the next run.
    await discardCandidate(home, member, { C: c.C, landRef: landRefOf(team), bound: registrationFor(s, member) }, { procs: deps.procs, git: deps.git });
    if (a) {
      writeTombstone(home, team, a, readManifest(home, team, a.id, a.digest), { state: "superseded", reason: "the candidate was discarded" });
      s.actions = s.actions.filter((x) => x.id !== a.id);
    }
    if (p) s.publishing = null;
    else s.candidate = null;
    if (s.evidence?.member === member) s.evidence = null;
    s.events.push({ at: new Date().toISOString(), what: `discarded the candidate ${c.C} of ${member}` });
    writeState(home, s);
    return { deleted: true, down: s.status === "down" };
  });
}

// ---- the lead prepares, the owner decides (design 8 addendum, option 2) ----------------------------

const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");
// The patch a manifest keeps inline, and the bound of the whole manifest (as canonical JSON, which
// escaping can make much larger than the patch): over either, the patch is marked oversize. A
// manifest travels to the owner's bridge as one message, and the relay takes at most 100,000
// characters of text (UTF-8 bytes are never fewer than characters).
export const PATCH_INLINE_MAX = 64 * 1024;
export { MANIFEST_FIT };

/**
 * The decision the owner gave on Telegram for a live action, as the lead's engine kept it
 * (receipt.json), verified again (lib/landings.js checkReceipt, without its apply window: the
 * caller decides by decided_at): {decision, decided_at, receipt, ...}, or null when none is kept.
 * A receipt that cannot be read or does not verify refuses: hoptell never decides past it.
 */
function keptDecision(home, team, a, m, deps = {}) {
  if (!m?.recipient) return null;
  const bytes = readReceipt(home, team, a.id);
  return bytes === null ? null : checkReceipt(bytes, { pin: (deps.pinFor ?? pinFor)(home, m.realm), manifest: m, digest: a.digest, window: false });
}

/** Can a kept "land" decision `d` still be applied at `now`: tapped before the action expired, within APPLY_WINDOW_MS? */
const applicable = (d, now) => d.decided_at <= d.expires_at && now <= d.decided_at + APPLY_WINDOW_MS;

/**
 * The lead's engine keeps the owner's Telegram decision (a verified landing_decision) as the
 * receipt of the action it names, under the team's lock: the first decision registered for an
 * action wins. One for an action already approved, accepted or later by another route (a
 * terminal) is kept out as a conflict, and one for an action that ended is not kept either; the
 * lead's inbox note says which decision stands (lib/inbox.js). See lib/landings.js ingestDecision.
 */
export async function ingestLandingDecision(home, env, bytes, me, { waitMs = INGEST_WAIT_MS } = {}) {
  return ingestDecision(home, env, bytes, me, {
    lock: (team, fn) => withLock(teamPaths(home, team).lock, fn, { waitMs }),
    standing: (team, id) => {
      const a = readState(home, team)?.actions?.find((x) => x.id === id) ?? null;
      if (a) return a.state === "ready" || a.route === "bridge" ? null : { result: "conflict", by: a.route ?? "terminal", kept: "land" };
      return { result: "ended", state: readTombstone(home, team, id)?.state ?? null };
    },
  });
}
/**
 * The lead's engine keeps an auto-land grant the owner gave on Telegram (a verified landing_grant
 * envelope, `bytes` its original text) under the team's lock, as the grant's record with source
 * telegram. Kept only when it is for this lead session and member, for the team's current run and
 * repository, of the team's current revocation generation (one given before the owner last turned
 * auto-land off is stale, whatever the clocks say) and not expired. A grant kept already is kept
 * again (the relay's redelivery). Returns {ref, state: "on" | "refused", why (null, or stale,
 * no_team, not_lead, scope, expired), team, targets, left_s}: what the owner's bridge is told,
 * and the lead's inbox note. Throws when the record or the state cannot be written (the engine
 * leaves the message with the relay).
 */
export async function ingestLandingGrant(home, env, bytes, me, { waitMs = INGEST_WAIT_MS, now = Date.now } = {}) {
  const g = parseGrant(env.text);
  if (!g) return { ref: null, state: "refused", why: "scope", team: null, targets: [], left_s: null };
  const report = (state, why, left = null) => ({ ref: g.id, state, why, team: g.team, targets: g.targets, left_s: left === null ? null : Math.min(24 * 3600, Math.max(0, Math.ceil(left / 60_000) * 60)) }); // whole minutes, as the owner reads them
  if (!g.recipient || g.recipient.lead !== me.name || g.recipient.member !== me.member) return report("refused", "not_lead");
  if (!listTeams(home).includes(g.team)) return report("refused", "no_team");
  return withLock(
    teamPaths(home, g.team).lock,
    async () => {
      const s = readState(home, g.team);
      if (!s) return report("refused", "no_team");
      if (s.lead !== g.recipient.lead) return report("refused", "not_lead");
      if (s.status === "down" || !s.enrolment || s.run !== g.run || canonicalize(s.enrolment) !== canonicalize(g.enrolment)) return report("refused", "scope");
      const gs = readGrantState(home, g.team);
      const t = now();
      const had = gs.grants[g.id];
      if (!had && g.generation !== gs.generation) return report("refused", "stale");
      if (!had && t >= g.expires_at) return report("refused", "expired");
      if (!had && autolandPausedUntil(gs, t) !== null) return report("refused", "paused");
      storeGrant(home, g.team, { source: "telegram", scope: g, envelope: bytes });
      if (!had) {
        gs.grants[g.id] = newRow();
        writeGrantState(home, g.team, gs);
        s.events.push({ at: new Date(t).toISOString(), what: `auto-land on for ${g.targets.join(", ")} until ${new Date(g.expires_at).toISOString()} (grant ${g.id}, given on Telegram)` });
        writeState(home, s);
      }
      const status = statusOf(readGrant(home, g.team, g.id), gs, s, t);
      return status === "active" ? report("on", null, g.expires_at - t) : report("refused", status === "revoked" ? "stale" : status === "expired" ? "expired" : "scope");
    },
    { waitMs },
  );
}

/** What a terminal decision says when the owner already rejected the action on Telegram. */
const rejectedText = (id, member, requested) => `the owner rejected ${id} on Telegram, so it ended as rejected; nothing was moved. A different decision needs a new landing: ${requested ? `ask the lead to run hoptell team land ${member} --request-approval again` : "run the same command again"}`;

/** What `team approve` says of an expired action: what to do, and nothing a shell would run. */
const expiredText = (id, m, member) => `${id} expired at ${m.expires_at}; nothing was moved. Ask the lead to run hoptell team land ${member} --request-approval again`;

/** End a ready or approved action of `s` as superseded (its tombstone first), with `reason`. */
function supersede(home, s, a, reason) {
  writeTombstone(home, s.team, a, readManifest(home, s.team, a.id, a.digest), { state: "superseded", reason });
  s.actions = s.actions.filter((x) => x.id !== a.id);
  s.events.push({ at: new Date().toISOString(), what: `landing ${a.id} of ${a.member}: superseded (${reason})` });
}

/**
 * `hoptell team land <member> --target <branch> -m <message> --prepare` (the lead): stop the
 * member's session (confirmed, by its recorded id), then build and publish the candidate as
 * teamLandCandidate does, under the same quiet check: another implementer of the repository that
 * still runs refuses. The candidate is signed with the owner's configured key; that signature is
 * provenance a process can make, not a decision. Returns teamLandCandidate's result and the stop.
 */
export async function teamLandPrepare(home, member, opts, deps = {}) {
  const stop = await teamStop(home, member, deps);
  return { ...(await teamLandCandidate(home, member, opts, deps)), stopped: stop.state };
}

/**
 * `hoptell team evidence <member> --candidate <C> --tests pass|fail --command <cmd>... --report
 * <file>` (the lead): record the test evidence of the member's current candidate, exactly C. The
 * report (a regular file of this user, at most 64 KiB of UTF-8 text) is read once and stored by its
 * digest, so a later approval request freezes these bytes. Evidence for the same C replaces the
 * earlier one, and a decision that did not start yet is superseded by it; for another C it refuses.
 * "pass" is the lead's claim. Returns the recorded evidence.
 */
export async function teamEvidence(home, member, { C, tests, commands, report }) {
  const team = teamOf(home, member);
  if (!isOid(C)) fail("bad_commit", `--candidate takes the full commit id of the candidate, not "${String(C ?? "").slice(0, 70)}"`);
  if (!TEST_RESULTS.includes(tests)) fail("bad_tests", `--tests is pass or fail, not "${String(tests ?? "").slice(0, 40)}"`);
  if (!isCommands(commands)) fail("bad_command", `give each test command with --command (1 to ${COMMANDS_MAX}, each at most ${COMMAND_MAX} characters)`);
  if (typeof report !== "string" || !report) fail("bad_report", "--report takes the file of the test report");
  const r = readPrivateFile(report, REPORT_MAX, { privateMode: false });
  if (r.problem) fail("bad_report", `the test report ${report} ${r.missing ? "does not exist" : r.problem}`);
  let textOk = !r.bytes.includes(0);
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(r.bytes);
  } catch {
    textOk = false;
  }
  if (!textOk) fail("bad_report", `the test report ${report} is not UTF-8 text (or holds a NUL)`);
  return withTeam(home, team, async (s) => {
    if (s.status === "down") fail("team_down", `team ${team} is down`);
    const c = s.candidate?.member === member ? s.candidate : null;
    if (!c) fail("no_candidate", `no candidate is recorded for ${member}; prepare one with hoptell team land ${member} --target <branch> -m <message> --prepare`);
    if (c.C !== C) fail("not_candidate", `${C.slice(0, 12)} is not ${member}'s current candidate (${c.C}); evidence is recorded for exactly that commit`);
    if (s.evidence && s.evidence.C !== C) fail("evidence_exists", `the evidence recorded is for ${s.evidence.C.slice(0, 12)}, not for this candidate; discard that candidate first`);
    const a = s.actions?.find((x) => x.member === member) ?? null;
    if (a && !["ready", "approved"].includes(a.state)) fail("landing_pending", `${actionText(a)}; finish it first`);
    const digest = storeEvidence(home, team, r.bytes);
    const at = new Date().toISOString();
    if (a) supersede(home, s, a, "new test evidence was recorded");
    s.evidence = { member, T: c.T, C, tests, commands, report: digest, bytes: r.bytes.length, at };
    s.events.push({ at, what: `evidence for ${member}'s candidate ${C.slice(0, 12)}: tests ${tests} (${commands.length} command${commands.length === 1 ? "" : "s"}, report ${digest.slice(0, 12)})` });
    writeState(home, s);
    return { ...s.evidence, team, superseded: a?.id ?? null };
  });
}

/** The verdicts of a review request as a manifest freezes them: each asked reviewer's latest. */
function frozenReview(r) {
  const sum = reviewSummary(r);
  const review = { id: r.id, base: r.base, head: r.head, reviewers: r.reviewers, verdicts: sum.answers.map((v) => ({ reviewer: v.reviewer, verdict: v.verdict, at: v.at })) };
  return { ...review, digest: sha256(canonicalize(review)) };
}

/**
 * `hoptell team land <member> --request-approval` (the lead): only for the member's current
 * candidate C on T, with test evidence for exactly C and a review request of T..C that every
 * reviewer asked has answered (a "changes" verdict is shown, not refused). It freezes the evidence
 * in a new landing action's manifest (the execution mode, C's subject, the diffstat, the patch, the
 * test report and the verdicts, each with its digest) and leaves the action ready for the owner's
 * decision (hoptell team approve <id>). A patch over PATCH_INLINE_MAX (`deps.inlineMax` in tests),
 * or one that would make the manifest larger than MANIFEST_FIT, is marked oversize, never cut: its
 * digest and size are of the complete patch, which is streamed and never held whole. A decision of the member that
 * did not start is superseded. `deps.recipient` ({realm, member}): the owner's bridge takes the
 * request, and its decision goes to the lead's session. Returns {id, team, target, T, C, mode,
 * expires, evidence, manifest, digest}.
 */
export async function teamLandRequest(home, member, deps = {}) {
  const team = teamOf(home, member);
  const now = deps.now ?? Date.now;
  return withTeam(home, team, async (s) => {
    if (!s.enrolment) fail("legacy_team", `team ${team} was started before landing actions, so hoptell lands nothing new in it: run hoptell team down ${team} and hoptell team up again`);
    if (s.status === "down") fail("team_down", `team ${team} is down`);
    const c = s.candidate?.member === member ? s.candidate : null;
    if (!c) fail("no_candidate", `no candidate is recorded for ${member}; prepare one with hoptell team land ${member} --target <branch> -m <message> --prepare`);
    if (s.landing) fail("landing_pending", `a landing of ${s.landing.member} did not finish; finish it first`);
    const other = s.actions.find((a) => a.member !== member && !["ready", "approved"].includes(a.state));
    if (other) fail("landing_pending", `${actionText(other)}; finish it first`);
    const live = s.actions.find((a) => a.member === member) ?? null;
    if (live && !["ready", "approved"].includes(live.state)) fail("landing_pending", `${actionText(live)}; finish it first`);
    const ev = s.evidence;
    if (!ev || ev.member !== member || ev.C !== c.C || ev.T !== c.T) fail("no_evidence", `no test evidence is recorded for the candidate ${c.C}; record it with hoptell team evidence ${member} --candidate ${c.C} --tests pass|fail --command <command> --report <file>`);
    const req = [...s.reviews].reverse().find((r) => r.base === c.T && r.head === c.C);
    if (!req && !s.members.some((m) => m.role === "reviewer")) fail("no_review", `team ${team} has no reviewer, so this landing cannot be requested from the owner; the owner lands it in a terminal with hoptell team land ${member} --approve ${c.T} ${c.C}`);
    if (!req) fail("no_review", `no review request is recorded for the candidate; ask the reviewers with hoptell review request --team ${team} --base ${c.T} --head ${c.C}`);
    const waiting = reviewSummary(req).waiting;
    if (waiting.length) fail("review_incomplete", `the review ${req.id} of the candidate waits for ${waiting.join(", ")}; record each verdict with hoptell review verdict --team ${team} ${req.id} <reviewer> approve|changes first`);
    const report = readEvidence(home, team, ev.report);
    const inlineMax = deps.inlineMax ?? PATCH_INLINE_MAX;
    const seen = await landingEvidence(home, member, { target: c.target, T: c.T, C: c.C, landRef: landRefOf(team), common: s.enrolment.common, bound: registrationFor(s, member), inlineMax }, { procs: deps.procs, git: deps.git });
    const rec = readWorktreeRecord(home, member).rec;
    const p = seen.patch;
    let utf8 = true;
    try {
      if (p.inline) new TextDecoder("utf-8", { fatal: true }).decode(p.inline);
    } catch {
      utf8 = false;
    }
    // The digest and the size are of the complete patch, inline or not.
    const patchOf = (inline) => ({ text: inline ? (utf8 ? p.inline.toString("utf8") : p.inline.toString("base64")) : null, encoding: inline ? (utf8 ? "utf8" : "base64") : null, bytes: p.bytes, digest: p.digest, oversize: !inline });
    const evidence = (inline) => ({
      subject: seen.subject,
      diffstat: { text: seen.diffstat, digest: sha256(seen.diffstat) },
      patch: patchOf(inline),
      tests: { result: ev.tests, commands: ev.commands, report: report.toString("utf8"), digest: ev.report, at: ev.at },
      review: frozenReview(req),
    });
    const created = new Date(now());
    // The owner's bridge, when it can take the request: the realm, and the decision's recipient (the
    // lead's session in this home's own member). Without one the request is for the terminal only.
    const to = deps.recipient ?? null;
    const gs = readGrantState(home, team);
    const fields = (inline) => ({
      realm: to?.realm ?? null,
      enrolment: s.enrolment,
      team,
      run: s.run,
      member,
      target: c.target,
      T: c.T,
      H: c.H,
      C: c.C,
      parent: c.T,
      mode: seen.mode,
      cleanup: { worktree: rec?.path ?? null, branch: rec?.branch ?? null, candidate: landRefOf(team).slice(11) },
      // The revocation generation tells the bridge which auto-land grant this team takes now.
      recipient: to ? { realm: to.realm, member: to.member, lead: s.lead, generation: gs.generation } : null,
      evidence: evidence(inline),
      created_at: created.toISOString(),
      expires_at: new Date(created.getTime() + ACTION_TTL_MS).toISOString(),
      nonce: crypto.randomBytes(16).toString("hex"),
    });
    const size = (f) => Buffer.byteLength(canonicalize({ version: 1, id: "L0000000000", ...f }));
    let f = fields(p.inline !== null);
    if (size(f) > MANIFEST_FIT) f = fields(false);
    if (size(f) > MANIFEST_FIT) fail("evidence_too_large", `the evidence of this landing is too large for its record even without the patch (over ${MANIFEST_FIT} bytes); shorten the test report`);
    // Auto-land (design 8 addendum, option 6): an active grant of the owner that covers the target
    // decides this action instead of a decision per landing, when the lead's tests passed and every
    // reviewer asked approved exactly T..C. Otherwise the request goes to the owner as usual, and
    // says why it was not auto-landed. The grant is checked again at acceptance and before the move.
    // The notices owed are counted with the queued ones (owedNotices queues them first).
    const settled = settleGrants(home, team, gs, s, now());
    if (owedNotices(home, team, s, gs, now()) || settled) writeGrantState(home, team, gs);
    const cover = coveringGrant(home, team, gs, s, { target: c.target, now: now(), pinFor: (realm) => (deps.pinFor ?? pinFor)(home, realm) });
    // An active grant for other targets: the request says so. Too many notices still owed to the
    // owner's bridge: no new auto-landing until the bridge has taken them (none is ever dropped).
    const others = cover ? [] : [...new Set(Object.entries(gs.grants).filter(([, r]) => r.status === "active").flatMap(([gid]) => {
      try {
        return readGrant(home, team, gid).scope.targets;
      } catch {
        return [];
      }
    }))];
    const why = cover ? (gs.notices.length >= NOTICES_MAX ? [["notices_full", `too many auto-land notices are pending (${gs.notices.length}); check the owner's Telegram`]] : autoProblems(f.evidence)) : others.length ? [["not_covered", `${c.target} is not covered by the grant's targets (${others.sort().join(", ")})`]] : [];
    const notAuto = why.length ? why.map(([, text]) => text).join(", and ") : null;
    const auto = cover && !notAuto ? cover : null;
    if (live) supersede(home, s, live, "a new approval was requested");
    const id = await newActionId(home);
    // The grant's row names the action before the action exists: the notice it will owe is
    // reconciled from there (a name with no action behind it owes nothing).
    if (auto) {
      (gs.grants[auto.g.scope.id] ??= newRow()).actions.push(id);
      writeGrantState(home, team, gs);
    }
    const made = createManifest(home, team, id, f);
    const action = { id, digest: made.digest, member, state: auto ? "approved" : "ready", route: auto ? "grant" : null, decision: auto ? auto.g.digest : null, reason: null, created: f.created_at, updated: f.created_at, target: c.target, T: c.T, C: c.C };
    s.actions.push(action);
    s.events.push({ at: f.created_at, what: `landing ${id} of ${member}: ${c.C} on ${c.target} at ${c.T} (${f.mode.kind === "checkout" ? `checked out in ${f.mode.worktree}` : "branch only"}), ${auto ? `approved by the auto-land grant ${auto.g.scope.id}` : "approval requested"}` });
    writeState(home, s);
    return { id, team, member, target: c.target, T: c.T, C: c.C, mode: f.mode, expires: f.expires_at, evidence: f.evidence, superseded: live?.id ?? null, manifest: made.manifest, digest: made.digest, auto: auto ? { grant: auto.g.scope.id, left: auto.left } : null, notAuto, notAutoCodes: why.length ? why.map(([code]) => code) : null };
  });
}

/**
 * Why an action covered by an auto-land grant is not auto-landed (the owner decides it): [code,
 * text] pairs, the code for the owner's card (lib/landings.js AUTO_CODES), the text for the lead.
 */
function autoProblems(e) {
  const changes = e.review.verdicts.filter((v) => v.verdict !== "approve").map((v) => v.reviewer);
  return [e.tests.result !== "pass" ? ["tests_failed", "the lead's tests failed"] : null, changes.length ? ["changes", `${changes.join(", ")} asked for changes`] : null, e.review.reviewers.length ? null : ["no_reviewers", "no reviewer was asked"]].filter(Boolean);
}

/** The id of the grant kept for `team` whose record has `digest`; refused when none has it. */
function grantOfDigest(home, team, digest) {
  for (const id of grantIds(home, team)) {
    try {
      if (readGrant(home, team, id).digest === digest) return id;
    } catch {}
  }
  fail("no_grant", `the auto-land grant this landing was approved by is no longer kept for team ${team}`);
}
/** A refusal of a grant check (it ends the action), not a failure to read or write. */
const grantRefusal = (e) => /^(grant_|no_grant$)/.test(String(e?.code ?? ""));

/**
 * The landing action `id` as hoptell team approve shows it, from its manifest: {team, member, id,
 * repo, manifest, path}. Only a ready or approved action with evidence; an expired one ends here (its
 * tombstone) with what to do.
 */
export async function teamApproveView(home, id, deps = {}) {
  const team = teamOfAction(home, id);
  const now = deps.now ?? Date.now;
  return withTeam(home, team, async (s) => {
    const a = s?.actions?.find((x) => x.id === id) ?? null;
    if (!a) {
      const t = readTombstone(home, team, id);
      fail("action_gone", t ? `the landing ${id} already ended (${t.state}${t.reason ? `: ${t.reason}` : ""}); nothing was changed` : `the landing ${id} is not live in team ${team}; nothing was changed`);
    }
    if (!["ready", "approved"].includes(a.state)) fail("landing_pending", `${actionText(a)}; hoptell team approve decides only a landing that did not start`);
    const m = readManifest(home, team, a.id, a.digest);
    if (!m.evidence) fail("no_evidence", `the landing ${id} has no evidence (it was decided with hoptell team land --approve); continue it with hoptell team land ${a.member} --approve ${a.T} ${a.C}`);
    const end = (state, reason, extra = {}) => {
      Object.assign(a, { updated: new Date(now()).toISOString(), ...extra });
      writeTombstone(home, team, a, m, { state, reason });
      s.actions = s.actions.filter((x) => x.id !== a.id);
      s.events.push({ at: new Date(now()).toISOString(), what: `landing ${id} of ${a.member}: ${state}${reason ? ` (${reason})` : ""}` });
      writeState(home, s);
    };
    // A decision the owner gave on Telegram, already kept, stands (teamLandApprove checks again
    // under the lock, for one that arrives while this prompt is open): a Reject ends the action; a
    // Land is the lead's to apply while it can be, so the action does not expire by its own time.
    if (a.route === "grant") return { team, member: a.member, id, repo: s.repo, manifest: m, path: landingPaths(home, team, id).manifest, decided: "grant" };
    const kept = keptDecision(home, team, a, m, deps);
    if (kept?.decision === "reject") {
      end("rejected", "the owner rejected it on Telegram", { route: "bridge", decision: kept.receipt });
      fail("action_rejected", rejectedText(id, a.member, true));
    }
    if (kept?.decision === "land" && !applicable(kept, now())) {
      end("expired", null, { route: "bridge", decision: kept.receipt });
      fail("action_expired", `the owner's decision on Telegram to land ${id} can no longer be applied (it is older than ${APPLY_WINDOW_MS / 60_000} minutes, or came after the landing expired); nothing was moved. Ask the lead to run hoptell team land ${a.member} --request-approval again`);
    }
    if (!kept && Date.parse(m.expires_at) <= now()) {
      end("expired", null);
      fail("action_expired", expiredText(id, m, a.member));
    }
    return { team, member: a.member, id, repo: s.repo, manifest: m, path: landingPaths(home, team, id).manifest, decided: kept?.decision ?? null };
  });
}

/**
 * `hoptell team apply <id>` (the lead, design 8 addendum option 3): carry out the decision the owner
 * made on Telegram for a requested action. The receipt the lead's engine kept (the bridge's signed
 * landing_decision, its original bytes) is verified again against the pin this home trusts now
 * (lib/landings.js checkReceipt); a verified inbox label or a local record is never a substitute.
 * "reject" ends the action as rejected; "land" runs it from approved, with the route "bridge" and
 * the receipt's digest as its decision, and T, H, C and the mode checked again at acceptance.
 * A run that stopped after acceptance resumes the same action (see below). `deps.pinFor` (tests):
 * the pin lookup. Returns {rejected: true, id, member, digest} or landApprove's result with the
 * action's digest.
 */
export async function teamApply(home, id, { homedir }, deps = {}) {
  const team = teamOfAction(home, id);
  const now = deps.now ?? Date.now;
  const seen = await withTeam(home, team, async (s) => {
    const a = s?.actions?.find((x) => x.id === id) ?? null;
    if (!a) {
      const t = readTombstone(home, team, id);
      fail("action_gone", t ? `the landing ${id} already ended (${t.state}${t.reason ? `: ${t.reason}` : ""}); nothing was changed` : `the landing ${id} is not live in team ${team}; nothing was changed`);
    }
    // A run that stopped after the decision was accepted: the same action resumes under the same
    // receipt, verified again but with no apply window (it was applied in time): accepted makes its
    // checks and moves, moving only reads what happened and never moves again, landed finishes the
    // cleanup. An unknown outcome (blocked) stays the owner's.
    if (a.state === "blocked") fail("land_blocked", `${actionText(a)}; hoptell team apply does not move it again. The owner checks it on the Mac (hoptell team status ${team})`);
    // An action an auto-land grant approved: it goes on under that grant (its record verified
    // again; an approved one is checked in full at acceptance, an accepted one for revocation
    // before the move, and one already moving or landed only reconciles).
    if (a.route === "grant") {
      const m = readManifest(home, team, a.id, a.digest);
      checkGrant(home, team, s, readGrantState(home, team), { id: grantOfDigest(home, team, a.decision), digest: a.decision, phase: "resume", now: now(), pinFor: (realm) => (deps.pinFor ?? pinFor)(home, realm) });
      return { id, member: a.member, T: m.T, C: m.C, digest: a.digest, route: "grant" };
    }
    if (!["ready", "approved"].includes(a.state)) {
      if (a.route !== "bridge") fail("landing_pending", `${actionText(a)}; it was decided in a terminal, so it is finished there`);
      const m = readManifest(home, team, a.id, a.digest);
      const bytes = readReceipt(home, team, id);
      if (bytes === null) fail("bad_receipt", `the decision ${id} was accepted under is no longer kept next to it; hoptell changes nothing by it`);
      const d = checkReceipt(bytes, { pin: (deps.pinFor ?? pinFor)(home, m.realm), manifest: m, digest: a.digest, now: now(), window: false });
      if (d.decision !== "land" || d.receipt !== a.decision) fail("bad_receipt", `the decision kept for ${id} is not the one it was accepted under; hoptell changes nothing by it`);
      return { id, member: a.member, T: m.T, C: m.C, digest: a.digest, receipt: d };
    }
    const m = readManifest(home, team, a.id, a.digest);
    if (!m.recipient) fail("no_receipt", `the landing ${id} was not sent to the owner's Telegram; the owner decides it in a terminal: hoptell team approve ${id}`);
    const bytes = readReceipt(home, team, id);
    const iso = () => new Date(now()).toISOString();
    const end = (state, reason) => {
      writeTombstone(home, team, a, m, { state, reason, at: iso() });
      s.actions = s.actions.filter((x) => x.id !== a.id);
      s.events.push({ at: iso(), what: `landing ${id} of ${a.member}: ${state}${reason ? ` (${reason})` : ""}` });
      writeState(home, s);
    };
    if (bytes === null) {
      if (Date.parse(m.expires_at) <= now()) {
        end("expired", null);
        fail("action_expired", `${id} expired at ${m.expires_at} without a decision from the owner; nothing was moved. Run hoptell team land ${a.member} --request-approval again`);
      }
      fail("no_receipt", `the owner has not decided ${id} yet (it expires at ${m.expires_at}); its decision arrives in this session's inbox`);
    }
    let d;
    try {
      d = checkReceipt(bytes, { pin: (deps.pinFor ?? pinFor)(home, m.realm), manifest: m, digest: a.digest, now: now() });
    } catch (e) {
      // A decision that came too late to apply ends the action; one that does not verify changes nothing.
      if (e.code !== "action_expired") throw e;
      Object.assign(a, { route: "bridge", decision: null });
      end("expired", null);
      fail("action_expired", `${e.message}; nothing was moved. Run hoptell team land ${a.member} --request-approval again`);
    }
    if (d.decision === "reject") {
      Object.assign(a, { route: "bridge", decision: d.receipt, updated: iso() });
      end("rejected", "the owner rejected it on Telegram");
      return { rejected: true, id, member: a.member, digest: a.digest };
    }
    return { id, member: a.member, T: m.T, C: m.C, digest: a.digest, receipt: d };
  });
  if (seen.rejected) return seen;
  const r = await teamLandApprove(home, seen.member, { T: seen.T, C: seen.C, homedir, actionId: id, route: seen.route ?? "bridge", receipt: seen.receipt ?? null }, deps);
  return { ...r, digest: seen.digest };
}

/**
 * How a requested landing stands for the owner's card (hoptell team apply and approve report it
 * back): {digest, state} for one that ended landed (finished), blocked, rejected or expired, or
 * is blocked after its move; null while it is undecided or for an action never sent to Telegram.
 */
export function landingOutcome(home, id) {
  let team;
  try {
    team = teamOfAction(home, id);
  } catch {
    return null;
  }
  const t = readTombstone(home, team, id);
  const s = readState(home, team);
  const a = t ?? s?.actions?.find((x) => x.id === id) ?? null;
  if (!a) return null;
  let m;
  try {
    m = readManifest(home, team, id, a.digest);
  } catch {
    return null;
  }
  // An auto-landing has no card: its notice tells the owner (sendNotices).
  if (!m.recipient || a.route === "grant") return null;
  const state = { finished: "landed", landed: "landed", blocked: "blocked", rejected: "rejected", expired: "expired" }[a.state] ?? null;
  // A final record "blocked" is a refusal before the move (nothing moved); a live blocked action
  // has an unknown outcome after its move.
  return state ? { digest: a.digest, state, member: a.member, target: m.target, reason: a.reason ?? null, refused: Boolean(t) && t.state === "blocked" } : null;
}

// ---- the supervisor -------------------------------------------------------------------------------

/**
 * One look of the supervisor at a team: for each running member over its lifetime, or a reviewer
 * idle for idleMinutes (no message waiting and no output in its pane), a notice in its pane first;
 * NOTICE_MS later, if the reason still holds, its session is ended by id and the lead is told.
 * `deps`: {now, activity(m) → ms or null, notice(m, text), endSession, notify(text), procs}.
 * Returns the members it ended.
 */
export async function superviseTick(home, team, deps) {
  return withTeam(home, team, async (s) => {
    if (!s || s.status === "down") return null;
    const now = deps.now();
    const ended = [];
    for (const m of s.members) {
      if (!m.session || m.ended || sessionState(home, m, deps.procs) !== "running") continue;
      const started = Date.parse(m.session.started);
      let reason = null;
      if (m.lifetimeMinutes && now >= started + m.lifetimeMinutes * 60_000) reason = "lifetime";
      else if (m.role === "reviewer" && s.idleMinutes) {
        // Activity that cannot be read (null) is never taken for idleness.
        const seen = deps.activity(m);
        if (seen !== null && seen !== undefined && now - Math.max(started, seen) >= s.idleMinutes * 60_000) reason = "idle";
      }
      if (!reason) {
        m.notice = null;
        continue;
      }
      if (!m.notice || m.notice.reason !== reason) {
        deps.notice(m, `hoptell: this session ends in about a minute (${reason === "idle" ? `idle for ${s.idleMinutes} minutes` : `its lifetime of ${m.lifetimeMinutes} minutes is over`})`);
        m.notice = { reason, at: new Date(now).toISOString() };
        continue;
      }
      if (now - Date.parse(m.notice.at) < NOTICE_MS) continue;
      // Ended only when confirmed: otherwise noted, and tried again at the next look.
      const st = await stopOne(home, m, deps);
      if (st !== "exited") {
        s.events.push({ at: new Date(now).toISOString(), what: `could not end ${m.name} (${reason}): ${st}; trying again` });
        continue;
      }
      m.ended = { reason, at: new Date(now).toISOString() };
      s.events.push({ at: m.ended.at, what: `ended ${m.name} (${reason})` });
      ended.push(m.name);
      try {
        await deps.notify(`hoptell team ${team}: ${m.name} was ended (${reason === "idle" ? `idle for ${s.idleMinutes} minutes` : `lifetime of ${m.lifetimeMinutes} minutes`}). hoptell team restart ${m.name} starts it again.`);
      } catch (e) {
        s.events.push({ at: m.ended.at, what: `the lead was not told about ${m.name}: ${String(e.message).slice(0, 200)}` });
      }
    }
    writeState(home, s);
    return ended;
  });
}

/** The supervisor's peer name, under the lead's member prefix. */
export const supervisorName = (s) => `${s.prefix}-${s.team}-supervisor`.slice(0, 64);

/** The default lead notice: `hoptell send` as the supervisor's own name. */
export function sendToLead(s, { env }) {
  return (text) => {
    const r = spawnSync(process.execPath, [BIN, "send", "--", s.lead, text], { env: { ...env, HOPTELL_NAME: supervisorName(s) }, encoding: "utf8", timeout: 60_000 });
    if (r.status !== 0) throw new Error((r.stderr || "hoptell send failed").trim().split("\n").at(-1));
  };
}

/** Is the team's supervisor needed (any lifetime, or idle reviewers)? */
export const needsSupervisor = (s) => Boolean(s.idleMinutes || s.members.some((m) => m.lifetimeMinutes));

/**
 * `hoptell team supervise <team>` (started by team up in its own tmux session): look every
 * `everyMs` until the team is down.
 */
export async function teamSupervise(home, team, deps) {
  for (;;) {
    let r;
    try {
      r = await superviseTick(home, team, deps);
    } catch (e) {
      if (e.code !== "busy") throw e;
    }
    if (r === null) return;
    await deps.sleep(deps.everyMs ?? 30_000);
  }
}

export const TEAM_USAGE = `usage: hoptell team up <team file> [--dry-run] [--yes]
       hoptell team status [<team>] [--json]
       hoptell team stop <member>
       hoptell team restart <member>
       hoptell team down [<team>] [--keep-worktrees]
       hoptell team land <member> --target <branch> -m <message> [--prepare]
       hoptell team evidence <member> --candidate <C> --tests pass|fail --command <command>... --report <file>
       hoptell team land <member> --request-approval
       hoptell team approve <id> [--show-diff]
       hoptell team apply <id>
       hoptell team autoland <team> --target <branch>[,<branch>] [--for <n>h|<n>m] [--count <n>]
       hoptell team autoland <team> --off
       hoptell team land <member> --approve <T> <C>
       hoptell team land <member> --confirm <T> <C>
       hoptell team land <member> --abandon <id>
       hoptell team land <member> --discard`;

// ---- the review queue ------------------------------------------------------------------------------

/** The diff command a review request gives its reviewers: never an external diff or textconv. */
export const reviewDiff = (repo, base, head) => shellLine("git", ["-C", repo, "diff", "--no-ext-diff", "--no-textconv", base, head]);

/** A review request with each asked reviewer's latest verdict and who has not answered. */
function reviewSummary(r) {
  const latest = new Map(r.verdicts.map((v) => [v.reviewer, v]));
  return { ...r, answers: [...latest.values()], waiting: r.reviewers.filter((n) => !latest.has(n)) };
}

/**
 * The member whose work `base..head` is: two commits hoptell recorded for that member's worktree
 * (its base or a hoptell worktree commit, `base` before `head`, in the worktree the team
 * registered), or exactly the target's commit T and the candidate C of the team's recorded
 * candidate, or of a publication or landing that is still pending. No git runs: the records say
 * which commits exist and in which order.
 */
function reviewedWorktree(home, s, base, head) {
  for (const c of [s.candidate, s.publishing, s.landing]) if (c && c.T === base && c.C === head) return c.member;
  for (const m of s.members.filter((x) => x.role === "implementer" && x.registration)) {
    const rec = readWorktreeRecord(home, m.name).rec;
    if (!rec || !sameAs(rec, m.registration)) continue;
    const chain = [rec.base, ...rec.commits.map((c) => c.commit)];
    const at = chain.indexOf(head);
    if (at > 0 && chain.indexOf(base) >= 0 && chain.indexOf(base) < at) return m.name;
  }
  return null;
}

/**
 * `hoptell review request --team <team> --base <c> --head <c> [--to <reviewer>...]`: record a
 * review request in the team's state, then send it to each reviewer asked (all the team's
 * reviewers by default) with `deps.send(to, text)`, the normal send path. Returns {review, text,
 * sent: [{to, ack} | {to, error}]}; a send that fails leaves the request recorded.
 */
export async function reviewRequest(home, { team, base, head, to = [] }, deps) {
  if (!team) fail("which_team", "review request needs --team <team>");
  const oid = (x, flag) => {
    if (!OID_RE.test(String(x ?? ""))) fail("bad_commit", `${flag} takes a full commit id (40 or 64 hex digits), not "${String(x ?? "").slice(0, 70)}"`);
    return x;
  };
  oid(base, "--base");
  oid(head, "--head");
  if (base === head) fail("bad_commit", "--base and --head are the same commit; there is nothing to review");
  if (!readState(home, team)) fail("no_team", `team ${team} has no state`);
  const recorded = await withTeam(home, team, async (s) => {
    if (!s) fail("no_team", `team ${team} has no state`);
    if (s.status === "down") fail("team_down", `team ${team} is down; its reviewers are not running`);
    const reviewers = s.members.filter((m) => m.role === "reviewer").map((m) => m.name);
    const asked = [...new Set(to.length ? to : reviewers)];
    for (const r of asked) if (!reviewers.includes(r)) fail("not_member", `${String(r).slice(0, 64)} is not a reviewer of team ${team} (its reviewers: ${reviewers.join(", ") || "none"})`);
    if (!asked.length) fail("not_member", `team ${team} has no reviewers`);
    const member = reviewedWorktree(home, s, base, head);
    if (!member) fail("unknown_commit", `${head.slice(0, 12)} is not a commit hoptell recorded in a worktree of team ${team} with ${base.slice(0, 12)} before it, nor the candidate of team ${team} on its target commit; give full commit ids: a member's base (or an earlier commit) as --base and a later commit as --head, as hoptell worktree commit prints them, the first line of hoptell worktree diff <member> shows them, or hoptell team status ${team} --json lists them; for a candidate, the T and C that hoptell team land printed`);
    let id;
    do id = `rv-${crypto.randomBytes(4).toString("hex")}`;
    while (s.reviews.some((r) => r.id === id));
    const at = new Date().toISOString();
    const review = { id, base, head, member, reviewers: asked, at, verdicts: [] };
    // The queue keeps every open request: only answered ones make room, the oldest first.
    if (s.reviews.length >= REVIEWS_MAX) {
      const done = s.reviews.findIndex((x) => !reviewSummary(x).waiting.length);
      if (done < 0) fail("too_many_reviews", `team ${team} has too many open review requests (${s.reviews.length}); record the replies you have received with hoptell review verdict --team ${team} <request> <reviewer> approve|changes first (hoptell team status ${team} lists the requests and the missing replies), or start the team again: a fresh team up starts an empty queue`);
      s.reviews.splice(done, 1);
    }
    s.reviews = [...s.reviews, review];
    s.events.push({ at, what: `review request ${id}: ${member}'s ${base.slice(0, 12)}..${head.slice(0, 12)} to ${asked.join(", ")}` });
    writeState(home, s);
    const m = s.members.find((x) => x.name === member);
    // A candidate's review names its branch (team/<team>/land), not the member's.
    const cand = [s.candidate, s.publishing, s.landing].find((c) => c && c.T === base && c.C === head);
    return { review, lead: s.lead, repo: s.repo, branch: cand ? `team/${team}/land (the candidate of ${member} for ${cand.target})` : m.branch };
  });
  const { review, lead, repo, branch } = recorded;
  deps.onRecorded?.(review);
  // The command reviewers run: no external diff program and no textconv filter of the
  // repository's configuration or attributes runs for them (REVIEW_DIFF).
  const text = `Review request ${review.id} from ${lead} (team ${team}): review ${review.member}'s commits ${review.base}..${review.head} on ${branch}; read them with: ${reviewDiff(repo, review.base, review.head)} . Your verdict is for ${review.head} only. Reply to ${lead} with approve or changes and your findings; ${lead} records your verdict.`;
  const sent = [];
  for (const r of review.reviewers) {
    try {
      sent.push({ to: r, ack: await deps.send(r, text) });
    } catch (e) {
      sent.push({ to: r, error: String(e.message ?? e).slice(0, 300) });
    }
  }
  return { review, text, sent };
}

/**
 * `hoptell review verdict --team <team> <request> <reviewer> approve|changes`: the lead records a
 * reviewer's verdict for the request's head. Request ids are unique within a team only, so the
 * request is looked up in that team alone. hoptell never reads a verdict out of a message.
 * Returns {team, review} (with the answers so far).
 */
export async function reviewVerdict(home, { team, id, reviewer, verdict }) {
  if (!team) fail("which_team", "review verdict needs --team <team>");
  if (!REVIEW_RE.test(String(id ?? ""))) fail("unknown_request", `"${String(id ?? "").slice(0, 40)}" is not a review request id (rv- and 8 hex digits; hoptell team status lists them)`);
  if (!VERDICTS.includes(verdict)) fail("bad_verdict", `the verdict is approve or changes, not "${String(verdict ?? "").slice(0, 40)}"`);
  if (!readState(home, team)) fail("no_team", `team ${team} has no state`);
  return withTeam(home, team, async (s) => {
    const r = s?.reviews.find((x) => x.id === id);
    if (!r) fail("unknown_request", `team ${team} has no review request ${id} (hoptell team status ${team} lists them)`);
    if (!s.members.some((m) => m.name === reviewer && m.role === "reviewer")) fail("not_member", `${String(reviewer ?? "").slice(0, 64)} is not a reviewer of team ${team}`);
    if (!r.reviewers.includes(reviewer)) fail("not_asked", `${reviewer} was not asked for ${id} (asked: ${r.reviewers.join(", ")})`);
    const at = new Date().toISOString();
    r.verdicts = [...r.verdicts, { reviewer, verdict, at }];
    // Over the cap, the oldest verdict that a later one of the same reviewer replaced goes: every
    // reviewer's latest verdict stays (a request asks at most TEAM_MEMBERS_MAX reviewers).
    while (r.verdicts.length > VERDICTS_MAX) {
      const old = r.verdicts.findIndex((v, i) => r.verdicts.slice(i + 1).some((w) => w.reviewer === v.reviewer));
      if (old < 0) break;
      r.verdicts.splice(old, 1);
    }
    s.events.push({ at, what: `review ${id}: ${reviewer} ${verdict} for ${r.head.slice(0, 12)}` });
    // A later verdict never changes a frozen decision: one that did not start is superseded.
    for (const a of (s.actions ?? []).filter((x) => ["ready", "approved"].includes(x.state))) {
      if (readManifest(home, team, a.id, a.digest).evidence?.review?.id === id) supersede(home, s, a, `a later verdict (${reviewer} ${verdict}) for ${id}`);
    }
    writeState(home, s);
    return { team, review: reviewSummary(r) };
  });
}

export const REVIEW_USAGE = `usage: hoptell review request --team <team> --base <commit> --head <commit> [--to <reviewer>]...
       hoptell review verdict --team <team> <request> <reviewer> approve|changes`;

/** `hoptell review ...`. `send(to, text)`: the CLI's send path; resolves to the relay's answer. */
export async function reviewCommand({ args, home, fail: die, out, send }) {
  const VALUE = ["--team", "--base", "--head", "--to"];
  const bad = args.find((a, i) => a.startsWith("-") && !VALUE.includes(a) && !VALUE.includes(args[i - 1]));
  if (bad) die(`unknown option ${bad.slice(0, 40)}\n${REVIEW_USAGE}`, 2);
  for (const [i, a] of args.entries()) if (VALUE.includes(a) && (args[i + 1] === undefined || args[i + 1] === "" || args[i + 1].startsWith("-"))) die(`${a} needs a value\n${REVIEW_USAGE}`, 2);
  const one = (flag) => {
    const all = args.flatMap((a, i) => (a === flag ? [args[i + 1]] : []));
    if (all.length > 1) die(`${flag} is given more than once\n${REVIEW_USAGE}`, 2);
    return all[0];
  };
  const pos = args.filter((a, i) => !a.startsWith("-") && !VALUE.includes(args[i - 1]));
  const [sub, ...rest] = pos;
  // Refusals of the library calls end the command with their message (usage errors exit 2).
  const lib = async (fn) => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof TeamError || e.code) die(e.message);
      throw e;
    }
  };
  if (sub === "request") {
    if (rest.length) die(`unexpected argument "${String(rest[0]).slice(0, 40)}"\n${REVIEW_USAGE}`, 2);
    const to = args.flatMap((a, i) => (a === "--to" ? args[i + 1].split(",").map((x) => x.trim()).filter(Boolean) : []));
    // Said before anything is sent: a send that stops the command leaves a recorded request.
    const onRecorded = (v) => out(`Review request ${v.id} recorded: ${v.member}'s ${v.base.slice(0, 12)}..${v.head.slice(0, 12)}, asked ${v.reviewers.join(", ")}.`);
    const ask = { team: one("--team"), base: one("--base"), head: one("--head"), to };
    const r = await lib(() => reviewRequest(home, ask, { send, onRecorded }));
    for (const x of r.sent) out(x.error ? `  ${x.to}: not sent (${x.error}); the request stays recorded. Send it by hand: hoptell send ${x.to} '<the request>'` : `  ${x.to}: ${x.ack}`);
    out(`Record each verdict with: hoptell review verdict --team ${ask.team} ${r.review.id} <reviewer> approve|changes`);
    if (r.sent.some((x) => x.error)) {
      out(`The request text:\n${r.text}`);
      die("the request was not sent to every reviewer", 1);
    }
    return;
  }
  if (sub === "verdict") {
    if (rest.length !== 3) die(`review verdict needs a request, a reviewer and approve or changes\n${REVIEW_USAGE}`, 2);
    if (args.some((a) => VALUE.includes(a) && a !== "--team")) die(`review verdict takes only --team\n${REVIEW_USAGE}`, 2);
    const [id, reviewer, verdict] = rest;
    const team = one("--team");
    const r = await lib(() => reviewVerdict(home, { team, id, reviewer, verdict }));
    out(`Recorded: ${reviewer} ${verdict} for ${r.review.head.slice(0, 12)} (${id}, team ${r.team}).`);
    out(r.review.waiting.length ? `  waiting for ${r.review.waiting.join(", ")}` : `  every reviewer asked has answered: ${r.review.answers.map((a) => `${a.reviewer} ${a.verdict}`).join(", ")}`);
    return;
  }
  die(`${sub ? `unknown review command "${String(sub).slice(0, 40)}"` : "review needs a command"}\n${REVIEW_USAGE}`, 2);
}

// ---- the command line ---------------------------------------------------------------------------

/** One line from a terminal (team up's write-access question, the landing confirmation). */
async function askLine(question) {
  const readline = await import("node:readline/promises");
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

/** The tmux side of the team commands (lib/tmux.js), replaceable in tests. */
async function tmuxDeps(home, env) {
  const t = await import("./tmux.js");
  return {
    launch: t.launch,
    endSession: (pane, pid, id) => {
      try {
        return t.endSession(pane, pid, id);
      } catch {
        return false;
      }
    },
    activity: (m) => {
      // null (unknown) when tmux cannot tell: never read as idle.
      const pane = t.paneActivity(m.session.pane);
      if (pane === null) return null;
      let notice = 0;
      try {
        notice = fs.statSync(t.activityFileOf(home, m.name)).mtimeMs;
      } catch (e) {
        if (e.code !== "ENOENT") return null;
      }
      return Math.max(pane, notice);
    },
    notice: (m, text) => t.paneNotice(m.session.pane, m.session.pid, text),
    startSupervisor: async (s) => {
      const name = supervisorName(s);
      const settings = t.writeSessionSettings(home, name, { ...env, HOPTELL_PUSH: "" });
      const started = t.startPlainSession(t.sessionFor(name), [process.execPath, BIN, "team", "supervise", s.team], { env: { HOPTELL_HOME: home, HOPTELL_ENV: settings, HOPTELL_NAME: name }, cwd: home });
      return { id: started.sessionId, pane: started.pane, pid: Number(started.pid), root: processIdentity(Number(started.pid)), started: new Date().toISOString() };
    },
  };
}

/** Each asked reviewer's verdict, as one phrase. */
const verdictsText = (r) => `review ${r.id}: ${r.verdicts.map((v) => `${v.reviewer} ${v.verdict}`).join(", ")}`;

/**
 * What hoptell team approve shows of a landing action, from its manifest alone: where it lands, the
 * commits, the evidence (the lead's test result and the reviewers' verdicts, both from agents), the
 * patch's size or that it is too large to show, and when the request expires.
 */
function approvalLines(v) {
  const m = v.manifest;
  const e = m.evidence;
  const where = m.mode.kind === "checkout" ? `${m.target}, checked out in ${m.mode.worktree} (fast-forwarded there)` : `${m.target} (branch only, not checked out)`;
  const changes = e.review.verdicts.filter((x) => x.verdict === "changes").map((x) => x.reviewer);
  const lines = [
    `Landing ${v.id} of ${v.member} (team ${v.team}) in ${v.repo}`,
    `  target     ${where}`,
    `  candidate  ${m.C}`,
    `  on         ${m.T}`,
    `  subject    ${e.subject}`,
    `  tests      ${e.tests.result === "pass" ? "pass" : "FAILED"} (the lead's report ${e.tests.digest.slice(0, 12)}, ${Buffer.byteLength(e.tests.report)} bytes): ${e.tests.commands.join("; ")}`,
    `  reviews    ${verdictsText(e.review)}`,
    `  patch      ${e.patch.oversize ? `${e.patch.bytes} bytes: too large to show here; review it on the Mac (hoptell team approve ${v.id} --show-diff says how)` : `${e.patch.bytes} bytes: hoptell team approve ${v.id} --show-diff prints it`}`,
    `  expires    ${m.expires_at}`,
    ...e.diffstat.text.split("\n").map((l) => `  ${l}`),
  ];
  if (e.tests.result !== "pass" || changes.length) lines.push(`Note: ${[e.tests.result !== "pass" ? "the lead's tests failed" : null, changes.length ? `${changes.join(", ")} asked for changes` : null].filter(Boolean).join(", and ")}. You may still land it.`);
  lines.push("The test result and the verdicts come from agents: they are claims, not proof. Typing land below decides this landing and runs it now.");
  return lines;
}

/** The lines of a landing that ran (team land --approve or --confirm, team approve). */
function landedLines(r, confirm, out) {
  out(`${confirm ? "Confirmed" : "Landed"} ${r.C} on ${r.target} (was ${r.T})${r.id ? `, landing ${r.id}` : ""}.`);
  if (r.observed) out(`  note: ${r.target} was checked out in ${r.observed} while it landed; that checkout is on ${r.target} at ${r.C.slice(0, 12)} and clean`);
  if (r.checkedOut) out(`  warning: ${r.target} was checked out in ${r.checkedOut} while it moved. The index and working tree there were NOT updated: they still hold ${r.T}, so git status shows the landed change as undone. Check git status there; git read-tree -m -u ${r.T} ${r.C} brings them to ${r.target} and keeps your own changes`);
  out(r.removed.already ? "  worktree already removed" : r.removed.kept ? `  worktree kept: ${r.removed.why}` : `  worktree removed; branch ${r.removed.branch} ${r.removed.branchState}${r.removed.keptBecause ? ` (${r.removed.keptBecause})` : ""}`);
}

/** What --request-approval says when the owner's bridge cannot take landing requests, by `why` (bin/hoptell.js landingChannel). */
export const LANDING_BRIDGE_UPDATE = "landing approval needs a bridge update; use hoptell team approve in a terminal";
export const LANDING_CHANNEL_PROBLEM = {
  relay: "landing approval needs a relay update (hoptell 0.4.0 or later on the relay); use hoptell team approve in a terminal",
  offline: "the owner's Telegram bridge is offline, so the request was not sent there; use hoptell team approve in a terminal",
  bridge: LANDING_BRIDGE_UPDATE,
};

/** Whether this process runs in a team member's session (hoptell team up sets HOPTELL_TEAM_MEMBER). */
const memberSession = (env) => String(env?.HOPTELL_TEAM_MEMBER ?? "").trim() !== "";

// ---- auto-land grants (design 8 addendum, option 6) -------------------------------------------

/** The team's grants for hoptell team status: [{id, source, status, targets, left, used, max}], newest first. */
function grantsView(home, team, s, now) {
  let gs;
  try {
    gs = readGrantState(home, team);
  } catch (e) {
    return [{ problem: e.message }];
  }
  const out = [];
  for (const id of grantIds(home, team)) {
    let g;
    try {
      g = readGrant(home, team, id);
    } catch (e) {
      out.push({ id, problem: e.message });
      continue;
    }
    out.push({ id, source: g.source, status: statusOf(g, gs, s, now), targets: g.scope.targets, issued: g.scope.issued_at, left: Math.max(0, g.scope.expires_at - now), used: gs.grants[id]?.slots.length ?? 0, max: g.scope.max_count });
  }
  return out.sort((a, b) => (b.issued ?? 0) - (a.issued ?? 0));
}

/** Why no grant is given while auto-land is paused (grants.js `revokes`), with the end in local time. */
function pausedText(until) {
  const d = new Date(until);
  const pad = (n) => String(n).padStart(2, "0");
  return `Auto-land is paused on this Mac until ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}: too many /autoland off in the last days.`;
}

/**
 * `hoptell team autoland <team> --target <t>[,<t>] --for 2h` (the owner, in a terminal): a grant
 * that lets the lead land reviewed and tested work of this team run on exactly these targets
 * without asking, for at most 24 hours (GRANT_DEFAULT_MS when `forMs` is not given), and for at
 * most `maxCount` landings when given. Policy only, like hoptell team approve: no signature, and a
 * process of the same user could run it. `expect` ({run, enrolment}: what the owner was shown
 * before confirming) must still be the team's under the lock, or nothing is granted. The grant
 * takes the team's current revocation generation. Returns {id, targets, expires, left, maxCount}.
 */
export async function teamAutoland(home, team, { targets, forMs = GRANT_DEFAULT_MS, maxCount = null, expect = null }, deps = {}) {
  const now = (deps.now ?? Date.now)();
  return withTeam(home, team, async (s) => {
    if (!s) fail("no_team", `team ${team} has no state`);
    if (s.status === "down") fail("team_down", `team ${team} is down; a grant is for a running team`);
    if (!s.enrolment || !s.run) fail("legacy_team", `team ${team} was started before landing actions: run hoptell team down ${team} and hoptell team up again`);
    if (expect && (expect.run !== s.run || expect.enrolment !== canonicalize(s.enrolment))) fail("team_changed", `team ${team} changed while you confirmed (it was started again, or its repository changed); nothing was granted. Run hoptell team autoland ${team} again`);
    const set = [...new Set(targets)].sort();
    if (!set.length) fail("bad_target", "auto-land needs at least one target branch (--target <branch>[,<branch>])");
    for (const t of set) if (!isBranch(t)) fail("bad_target", `"${String(t).slice(0, 60)}" is not a branch name`);
    const gs = readGrantState(home, team);
    const paused = autolandPausedUntil(gs, now);
    if (paused !== null) fail("autoland_paused", pausedText(paused));
    const scope = { hoptell_landing_grant: 1, id: newGrantId(), team, run: s.run, generation: gs.generation, enrolment: s.enrolment, recipient: null, targets: set, issued_at: now, not_before: now, expires_at: now + forMs, max_count: maxCount, op: "land", origin: null };
    storeGrant(home, team, { source: "terminal", scope });
    gs.grants[scope.id] = newRow();
    writeGrantState(home, team, gs);
    s.events.push({ at: new Date(now).toISOString(), what: `auto-land on for ${set.join(", ")} until ${new Date(scope.expires_at).toISOString()}${maxCount ? `, at most ${maxCount} landing${maxCount === 1 ? "" : "s"}` : ""} (grant ${scope.id}, given in a terminal)` });
    writeState(home, s);
    return { id: scope.id, targets: set, expires: new Date(scope.expires_at).toISOString(), left: forMs, maxCount };
  });
}

/**
 * `hoptell team autoland <team> --off`: a new revocation generation under the team's lock, so
 * every grant given before it is dead (also one given on Telegram that this Mac has not received
 * yet, whatever the clocks say), and no acceptance or move under one follows. An action already
 * moving reconciles. Returns {revoked (the ids that were active)}.
 */
export async function teamAutolandOff(home, team, deps = {}) {
  const now = (deps.now ?? Date.now)();
  return withTeam(home, team, async (s) => {
    if (!s) fail("no_team", `team ${team} has no state`);
    const gs = readGrantState(home, team);
    settleGrants(home, team, gs, s, now);
    const before = Object.entries(gs.grants).filter(([, g]) => g.status === "active").map(([id]) => id);
    revoke(home, team, gs, s, now);
    writeGrantState(home, team, gs);
    s.events.push({ at: new Date(now).toISOString(), what: `auto-land off${before.length ? ` (revoked ${before.join(", ")})` : ""}` });
    writeState(home, s);
    return { revoked: before };
  });
}

/**
 * /autoland off on the owner's Telegram (a verified landing_revoke, `revokeId` its id): a new
 * revocation generation for every team of this home, each under its own lock, as hoptell team
 * autoland <team> --off makes it, so every grant given before it is dead (also one not received
 * yet). Applied once per team and revocation (the grants state keeps the ids for as long as a copy
 * can verify; `signedAt` its envelope's time): a redelivery, the same revocation
 * reaching another lead session of this home, or a retry after a partial run revokes nothing
 * given since. The grants state is what revokes; it is written first, also when
 * the team's state cannot be read (its event is then only logged). A grants state that cannot be
 * read or written throws: the engine leaves the message with the relay and the retry finishes
 * the teams left. Returns the names of the teams whose auto-land is off.
 */
export async function revokeEveryTeam(home, { revokeId, signedAt, waitMs = INGEST_WAIT_MS, now = Date.now, log = () => {} } = {}) {
  const off = [];
  for (const team of listTeams(home)) {
    await withLock(
      teamPaths(home, team).lock,
      async () => {
        const gs = readGrantState(home, team);
        const t = now();
        if (gs.revokes.some((v) => v.id === revokeId)) return void off.push(team); // applied already
        gs.generation += 1; // any other id revokes, whatever its time
        gs.revokes = gs.revokes.filter((v) => v.until >= t); // no copy of these can verify any more
        if (gs.revokes.length >= REVOKES_MAX) {
          // All still kept: the one kept until the earliest gives way, and auto-land pauses until
          // then (see grants.js), so a copy of it has no grant to take.
          const first = gs.revokes.reduce((a, v) => (v.until < a.until ? v : a));
          gs.revokes = gs.revokes.filter((v) => v !== first);
          gs.revoke_dedup_gap_until = Math.max(gs.revoke_dedup_gap_until, first.until);
          log(`owner channel: team ${team} keeps ${REVOKES_MAX} recent auto-land revocations; auto-land is paused there until ${new Date(gs.revoke_dedup_gap_until).toISOString()}`);
        }
        gs.revokes.push({ id: revokeId, until: revokeKeptUntil(signedAt, t) });
        let s = null;
        try {
          s = readState(home, team);
        } catch (e) {
          log(`owner channel: auto-land of team ${team} is off, but its state could not be read (${e.message})`);
        }
        if (s) settleGrants(home, team, gs, s, t);
        writeGrantState(home, team, gs);
        off.push(team);
        if (!s) return;
        s.events.push({ at: new Date(t).toISOString(), what: "auto-land off (turned off on Telegram for every team of this home)" });
        try {
          writeState(home, s);
        } catch (e) {
          log(`owner channel: auto-land of team ${team} is off, but its event could not be recorded (${e.message})`);
        }
      },
      { waitMs },
    );
  }
  return off;
}

/**
 * Queue in `gs` the notice each auto-landing owes the owner: from the records themselves, so a
 * run that stopped right after an action ended still owes it. For every action a grant approved
 * (its row's `actions`), by how it stands now (its final record, or its live state): landed,
 * blocked, rejected or expired, unless that notice was acknowledged (`noticed`) or is queued.
 * Returns whether anything was queued.
 */
function owedNotices(home, team, s, gs, now) {
  let added = false;
  for (const [gid, row] of Object.entries(gs.grants)) {
    for (const id of row.actions) {
      const a = readTombstone(home, team, id) ?? s.actions.find((x) => x.id === id) ?? null;
      const state = a && { finished: "landed", landed: "landed", blocked: "blocked", rejected: "rejected", expired: "expired" }[a.state];
      if (!state || row.noticed.includes(`${id}:${state}`) || gs.notices.some((n) => n.id === id && n.state === state)) continue;
      const m = readManifest(home, team, id, a.digest);
      let left = null;
      try {
        const g = readGrant(home, team, gid);
        if (statusOf(g, gs, s, now) === "active") left = Math.floor((g.scope.expires_at - now) / 1000);
      } catch {}
      queueNotice(gs, { digest: a.digest, id, team, target: m.target, state, left_s: left });
      added = true;
    }
  }
  return added;
}

/**
 * Send the auto-land notices the team owes the owner's Telegram through `given.landingChannel`:
 * first queued from the records (owedNotices), then sent, and each one sent acknowledged. A notice
 * that cannot be queued or sent stays owed: "notice pending", never a move again and never a
 * lost record (a bridge offline, one without "autoland", no owner channel yet); a later team
 * command sends it.
 */
async function sendNotices(home, team, given, out, warn, deps = {}) {
  const now = () => (deps.now ?? Date.now)();
  let pending;
  try {
    pending = await withTeam(home, team, async (s) => {
      if (!s) return [];
      const gs = readGrantState(home, team);
      if (owedNotices(home, team, s, gs, now())) writeGrantState(home, team, gs);
      return gs.notices;
    });
  } catch (e) {
    warn(`notice pending: the owner's Telegram is owed auto-land notices that could not be queued (${String(e.message).slice(0, 200)}); the next hoptell team command for ${team} tries again`);
    return;
  }
  if (!pending.length || !given.landingChannel) return;
  let link = null;
  const sent = [];
  let why = null;
  try {
    link = await given.landingChannel();
    if (!link) why = "no owner channel is set up";
    else if (link.problem) why = link.problem;
    else if (!(link.caps ?? []).includes("autoland")) why = "the bridge needs an update to show auto-land notices";
    else
      for (const n of pending) {
        // Owed until the bridge took it: the relay says "delivered" only once the bridge confirmed
        // it, which it does after keeping it. Queued or unconfirmed (an offline or full bridge)
        // stays owed and is sent again later; the bridge shows each notice once per action and state.
        const ack = await link.send(noticeText(n), 3600);
        if (ack?.state !== "delivered") {
          why = "the bridge has not taken it yet";
          break;
        }
        sent.push(n);
      }
  } catch (e) {
    why = String(e.message).slice(0, 200);
  } finally {
    link?.close?.();
  }
  if (sent.length) {
    try {
      await withTeam(home, team, async () => {
        const gs = readGrantState(home, team);
        gs.notices = gs.notices.filter((n) => !sent.some((x) => x.digest === n.digest && x.state === n.state));
        for (const n of sent) for (const row of Object.values(gs.grants)) if (row.actions.includes(n.id) && !row.noticed.includes(`${n.id}:${n.state}`)) row.noticed.push(`${n.id}:${n.state}`);
        writeGrantState(home, team, gs);
      });
    } catch (e) {
      warn(`the owner's Telegram was told, but that could not be recorded (${String(e.message).slice(0, 200)}); it may be told again`);
    }
    out(`The owner's Telegram was told: ${sent.map((n) => `${n.id} ${n.state}`).join(", ")}.`);
  }
  const left = pending.length - sent.length;
  if (why) warn(`notice pending: the owner's Telegram was not told of ${left} auto-landing${left === 1 ? "" : "s"} (${why}); the next hoptell team command for ${team} tries again`);
}

/**
 * Tell the owner's card how a requested landing ended (landingOutcome), through the bridge
 * connection `given.landingChannel` opens. A send that fails is only reported ("notice pending"):
 * it never moves or retries anything; running hoptell team apply again reports it again.
 */
async function reportOutcome(home, id, given, out, warn) {
  let o;
  try {
    o = landingOutcome(home, id);
  } catch {
    o = null;
  }
  if (!o || !given.landingChannel) return;
  const text = { landed: `${id} landed on ${o.target}.`, blocked: o.refused ? `${id} was not landed: hoptell refused it before the move (${o.reason ?? "see hoptell team status"}).` : `${id} is blocked; check its state on the Mac.`, rejected: `${id} was rejected; nothing was moved.`, expired: `${id} expired; nothing was moved.` }[o.state];
  let link = null;
  try {
    link = await given.landingChannel();
    if (!link || link.problem) throw new Error(link?.problem ?? "no owner channel");
    await link.send(landingStatusText({ digest: o.digest, state: o.state, text }), 3600);
    out(`The owner's Telegram card shows it as ${o.state}.`);
  } catch (e) {
    warn(`notice pending: the owner's Telegram card was not updated (${String(e.message).slice(0, 200)}); run hoptell team apply ${id} again to retry`);
  } finally {
    link?.close?.();
  }
}

/**
 * `hoptell team ...`. `env`: the caller's effective settings; `isTTY`: whether a person can answer
 * on this terminal; `prepare`: as for hoptell tmux.
 */
export async function teamCommand({ args, home, homedir, env, fail: die, out, warn, isTTY = false, prepare = null, deps: given = {} }) {
  const VALUE = ["--target", "-m", "--message", "--abandon", "--candidate", "--tests", "--command", "--report", "--for", "--count"];
  const opt = (...names) => {
    const at = args.findIndex((a) => names.includes(a));
    if (at < 0) return undefined;
    const v = args[at + 1];
    if (v === undefined || v === "" || (v.startsWith("-") && v !== "-")) die(`${args[at]} needs a value\n${TEAM_USAGE}`, 2);
    return v;
  };
  // A value of a flag given more than once (--command), by its place.
  const opt2 = (at) => {
    const v = args[at + 1];
    if (v === undefined || v === "" || (v.startsWith("-") && v !== "-")) die(`${args[at]} needs a value\n${TEAM_USAGE}`, 2);
    return v;
  };
  // --approve <T> <C> and --confirm <T> <C> take two values.
  const pairFlag = ["--approve", "--confirm"].find((f) => args.includes(f)) ?? null;
  const approveAt = pairFlag ? args.indexOf(pairFlag) : -1;
  const approved = approveAt < 0 ? null : args.slice(approveAt + 1, approveAt + 3);
  const known = ["--dry-run", "--yes", "--json", "--keep-worktrees", "--approve", "--confirm", "--discard", "--prepare", "--request-approval", "--show-diff", "--off", ...VALUE];
  const pos = args.filter((a, i) => !a.startsWith("-") && !VALUE.includes(args[i - 1]) && !(approveAt >= 0 && i > approveAt && i <= approveAt + 2));
  const bad = args.find((a, i) => a.startsWith("-") && !known.includes(a) && !VALUE.includes(args[i - 1]));
  if (bad) die(`unknown option ${bad.slice(0, 40)}\n${TEAM_USAGE}`, 2);
  const [sub, target, ...extra] = pos;
  if (extra.length) die(`unexpected argument "${String(extra[0]).slice(0, 40)}"\n${TEAM_USAGE}`, 2);
  const deps = { ...(await tmuxDeps(home, env)), out, warn, prepare, procs: undefined, ...given };
  try {
    switch (sub) {
      case "up": {
        if (!target) die(`team up needs a team file\n${TEAM_USAGE}`, 2);
        const confirm = isTTY ? async (q) => /^y(es)?$/i.test((await (given.ask ?? askLine)(q)).trim()) : null;
        await teamUp(target, { home, homedir, env, dryRun: args.includes("--dry-run"), yes: args.includes("--yes") }, { ...deps, confirm });
        return;
      }
      case "status": {
        const r = await teamStatus(home, target ?? null, deps);
        if (args.includes("--json")) return out(JSON.stringify(r, null, 2));
        out(`Team ${r.team} (${r.status === "partial" ? "partly started" : r.status}), lead ${r.lead}, ${r.repo}; supervisor ${r.supervisor}`);
        for (const m of r.members) {
          out(`  ${m.name}  ${m.role}  ${m.cli}  model ${m.model}, effort ${m.effort} (at launch)  ${m.state}${m.session ? `  ${m.session}` : ""}${m.lifetimeEnds ? `  lifetime ends ${m.lifetimeEnds}` : ""}`);
          if (m.waiting) out(`    ${m.waiting.text}; ${m.waiting.attach}`);
          if (m.role === "implementer") {
            const commits = m.commits === null ? "" : `, ${m.commits} commit${m.commits === 1 ? "" : "s"}`;
            out(`    ${m.branch ?? "no branch"}${m.head ? ` at ${m.head.slice(0, 12)}` : ""}${commits}${m.owns ? `, owns ${m.owns.join(",")}` : ""}`);
            if (m.noWorktree) out(`    ${m.noWorktree}`);
            else if (m.git) out(`    git ${m.git}`);
            else out(`    ${m.changed} uncommitted change${m.changed === 1 ? "" : "s"}${m.outside?.length ? `; outside owns: ${m.outside.join(", ")}` : ""}`);
          }
        }
        if (r.publishing) out(`  candidate being published: ${r.publishing.member} ${r.publishing.C} on ${r.publishing.target} at ${r.publishing.T}; hoptell team land ${r.publishing.member} --target ${r.publishing.target} -m <message> finishes it, or --discard`);
        if (r.candidate) out(`  candidate: ${r.candidate.member} ${r.candidate.C} on ${r.candidate.target} at ${r.candidate.T}`);
        if (r.evidence) out(`  evidence: tests ${r.evidence.tests} for ${r.evidence.C.slice(0, 12)} (the lead's report ${r.evidence.report.slice(0, 12)})`);
        for (const a of r.actions ?? []) out(`  ${actionText(a)}`);
        if (r.orphans.length) out(`  orphaned landing${r.orphans.length === 1 ? "" : "s"} ${r.orphans.join(", ")}: a manifest was made but no decision was recorded (a run stopped); nothing acts on ${r.orphans.length === 1 ? "it" : "them"}, and the id${r.orphans.length === 1 ? " is" : "s are"} not used again. Remove the folder${r.orphans.length === 1 ? "" : "s"} under ${path.join(home, "teams", r.team, "landings")} by hand when you like`);
        if (r.landing && !r.landing.action) out(`  landing pending (${r.landing.phase === "landed" ? "landed, cleanup unfinished" : "target not confirmed moved"}): ${finishLine(r.landing)} finishes it`);
        for (const l of r.landed) out(`  landed: ${l.member} ${l.H.slice(0, 12)} as ${l.C.slice(0, 12)} on ${l.target}`);
        // Open review requests, and the verdicts of the latest one that every reviewer answered.
        const answered = (v) => v.answers.map((a) => `${a.reviewer} ${a.verdict}`).join(", ");
        for (const v of r.reviews.filter((x) => x.waiting.length)) out(`  review ${v.id}: ${v.member}'s ${v.base.slice(0, 12)}..${v.head.slice(0, 12)}; waiting for ${v.waiting.join(", ")}${v.answers.length ? `; ${answered(v)}` : ""}`);
        const closed = r.reviews.filter((x) => !x.waiting.length).at(-1);
        if (closed) out(`  last review ${closed.id}: ${closed.member}'s ${closed.base.slice(0, 12)}..${closed.head.slice(0, 12)}: ${answered(closed)}`);
        for (const g of r.grants) {
          if (g.problem) out(`  auto-land grant${g.id ? ` ${g.id}` : "s"}: unreadable (${g.problem})`);
          else if (g.status === "active") out(`  auto-land ON for ${g.targets.join(", ")}: ${leftText(g.left)} left${g.max ? `, ${g.max - g.used} of ${g.max} landings left` : ""} (grant ${g.id}, ${g.source === "telegram" ? "given on Telegram" : "given in a terminal"}); hoptell team autoland ${r.team} --off ends it`);
        }
        const recent = r.grants.filter((g) => !g.problem && g.status !== "active").slice(0, 3);
        for (const g of recent) out(`  auto-land grant ${g.id} for ${g.targets.join(", ")}: ${g.status}${g.used ? `, ${g.used} landing${g.used === 1 ? "" : "s"}` : ""}`);
        for (const e of r.events) out(`  ${e.at}  ${e.what}`);
        await sendNotices(home, r.team, given, out, warn, deps);
        return;
      }
      case "autoland": {
        if (!target) die(`team autoland needs a team\n${TEAM_USAGE}`, 2);
        if (memberSession(env)) die("auto-land is the owner's choice; a team member's session cannot change it");
        if (args.includes("--off")) {
          const r = await teamAutolandOff(home, target, deps);
          out(`Auto-land is off for team ${target}${r.revoked.length ? ` (${r.revoked.length} grant${r.revoked.length === 1 ? "" : "s"} revoked)` : ""}. The lead asks you again for every landing. This also covers every grant you gave on Telegram before now that this Mac has not received yet; give a new one if you want auto-land again.`);
          await sendNotices(home, target, given, out, warn, deps);
          return;
        }
        const t = opt("--target");
        if (!t) die(`team autoland needs --target <branch>[,<branch>] (or --off)\n${TEAM_USAGE}`, 2);
        const forText = opt("--for");
        const forMs = forText === undefined ? GRANT_DEFAULT_MS : parseDuration(forText);
        if (forMs === null) die("--for takes a duration of at most 24 hours: <n>h or <n>m, such as 2h or 90m", 2);
        const countText = opt("--count");
        const maxCount = countText === undefined ? null : /^[1-9][0-9]{0,2}$/.test(countText) ? Number(countText) : die("--count takes a number of landings from 1 to 999", 2);
        const targets = t.split(",").map((x) => x.trim()).filter(Boolean);
        // Policy only, like team approve: typed on a terminal, which proves no person is present.
        if (!isTTY) die(`auto-land is the owner's choice: run hoptell team autoland ${target} in a terminal`);
        // What the owner confirms: this run of the team in this repository, checked again when it is granted.
        const shown = readState(home, target);
        if (!shown) die(`team ${target} has no state`);
        if (!shown.run || !shown.enrolment) die(`team ${target} was started before landing actions: run hoptell team down ${target} and hoptell team up again`);
        const expect = { run: shown.run, enrolment: canonicalize(shown.enrolment) };
        out(`While auto-land is on, the lead lands reviewed and tested work of team ${target} (this run, in ${shown.repo}) on ${targets.join(", ")} without asking you, for ${leftText(forMs)}${maxCount ? ` or ${maxCount} landing${maxCount === 1 ? "" : "s"}` : ""}. The reviewers' verdicts and the lead's test report become the only gate, and both come from agents.`);
        out("It does not bypass a protected branch, a dirty checkout or any other safety check, and it is not a hardware presence check: given here, it is policy only (any process of yours could type it).");
        const answer = await (given.ask ?? askLine)("Turn auto-land on? Type autoland to confirm: ");
        if (answer.trim() !== "autoland") die("not confirmed; auto-land stays off");
        const r = await teamAutoland(home, target, { targets, forMs, maxCount, expect }, deps);
        out(`Auto-land is on for team ${target} on ${r.targets.join(", ")} until ${r.expires}${r.maxCount ? `, for at most ${r.maxCount} landing${r.maxCount === 1 ? "" : "s"}` : ""}. Turn it off with: hoptell team autoland ${target} --off`);
        await sendNotices(home, target, given, out, warn, deps);
        return;
      }
      case "stop": {
        if (!target) die(`team stop needs a member\n${TEAM_USAGE}`, 2);
        const r = await teamStop(home, target, deps);
        return out(`${r.member}: ${r.state}`);
      }
      case "restart": {
        if (!target) die(`team restart needs a member\n${TEAM_USAGE}`, 2);
        const r = await teamRestart(home, target, { homedir, env }, deps);
        return out(`restarted ${r.member} (tmux session ${r.sessionId})`);
      }
      case "down": {
        const { report, down, pending } = await teamDown(home, target ?? null, { keepWorktrees: args.includes("--keep-worktrees") }, deps);
        for (const r of report) out(`${r.name}: ${r.state}${r.worktree ? `; worktree ${r.worktree}` : ""}`);
        if (pending) out(`${down ? "Down" : "Stopping"}; ${pending}.`);
        if (!down) die("the team is not down: the stops above that are not confirmed sent no signal or did not end their process. Check them (hoptell team status), then run hoptell team down again");
        return;
      }
      case "land": {
        if (!target) die(`team land needs a member\n${TEAM_USAGE}`, 2);
        if (args.includes("--abandon")) {
          const id = opt("--abandon");
          // The owner's step, like --approve: it ends a decision for good.
          if (!isTTY) die("abandoning a landing is the owner's step: run hoptell team land --abandon in a terminal");
          const seen = await teamLandAbandon(home, target, id, { dryRun: true }, deps);
          out(`The landing ${seen.id} (${seen.C} on ${seen.target} at ${seen.T}) has an unknown outcome. What hoptell sees now: ${seen.observed}.`);
          out("hoptell does not infer from this whether or how far the earlier move happened. Abandoning ends the action and its decision for good; it moves, merges and resets nothing, records no landing, and keeps the candidate and the worktree (hoptell team land --discard then drops the candidate and keeps the worktree; a new landing needs a new decision).");
          const answer = await (given.ask ?? askLine)(`Abandon ${seen.id}? Type abandon to confirm: `);
          if (answer.trim() !== "abandon") die("not confirmed; nothing was changed");
          const r = await teamLandAbandon(home, target, id, {}, deps);
          return out(`Abandoned ${r.id}. Its final record keeps what it was for and what hoptell saw: ${r.observed}.`);
        }
        if (args.includes("--discard")) {
          const r = await teamLandDiscard(home, target, deps);
          out("The candidate was discarded.");
          if (r.down) out(`The team is down, so ${target}'s worktree stays for you: hoptell worktree remove ${target} removes it once you checked it.`);
          return;
        }
        if (approved) {
          if (args.includes("--approve") && args.includes("--confirm")) die(`use --approve or --confirm, not both\n${TEAM_USAGE}`, 2);
          if (approved.length !== 2 || approved.some((a) => a.startsWith("-"))) die(`${pairFlag} needs the target and candidate commit ids\n${TEAM_USAGE}`, 2);
          const confirm = pairFlag === "--confirm";
          // The owner's step: typed on a terminal, like trust-cli. A terminal prompt is no proof
          // of a person (design 8, decision 9): the lead must never run this step.
          if (!isTTY) die(`landing is the owner's step: run hoptell team land ${pairFlag} in a terminal`);
          if (!confirm) {
            const answer = await (given.ask ?? askLine)(`Land ${approved[1]} on its target (now ${approved[0]})? Type land to confirm: `);
            if (answer.trim() !== "land") die("not confirmed; nothing was landed");
          }
          const r = await teamLandApprove(home, target, { T: approved[0], C: approved[1], homedir, confirm }, deps);
          return landedLines(r, confirm, out);
        }
        if (args.includes("--request-approval")) {
          if (memberSession(env)) die("asking the owner for a landing is the lead's step; a team member's session cannot do it");
          // The owner's bridge, when it says it takes landing requests (a UX check: an older bridge
          // also refuses a request it does not know). Otherwise the request is for the terminal
          // only: `landingChannel` gives null without an owner channel, {problem} when its bridge
          // cannot be reached or does not say "landing", else {realm, member, send, close}.
          let link = null;
          try {
            link = (await given.landingChannel?.()) ?? null;
          } catch (e) {
            link = { problem: e.message };
          }
          const tg = link && !link.problem ? link : null;
          let r;
          try {
            r = await teamLandRequest(home, target, { ...deps, recipient: tg ? { realm: tg.realm, member: tg.member } : null });
            if (r.superseded) out(`The earlier landing ${r.superseded} of ${target} was superseded.`);
            out(`Landing ${r.id}: ${r.C} on ${r.target} (at ${r.T}), ${r.mode.kind === "checkout" ? `checked out in ${r.mode.worktree}` : "branch only"}; tests ${r.evidence.tests.result}, ${verdictsText(r.evidence.review)}.`);
            if (r.auto) {
              // The owner's auto-land grant decided it: it lands now, and the owner is told.
              link?.close?.();
              link = null;
              out(`The owner's auto-land grant covers ${r.target} (${leftText(r.auto.left)} left), so ${r.id} lands now without asking.`);
              try {
                landedLines(await teamLandApprove(home, target, { T: r.T, C: r.C, homedir, actionId: r.id, route: "grant" }, deps), false, out);
              } finally {
                await sendNotices(home, r.team, given, out, warn, deps);
              }
              return;
            }
            if (r.notAuto) out(`Not auto-landed under the owner's grant: ${r.notAuto}. The owner decides it.`);
            let sent = false;
            if (tg) {
              try {
                await tg.send(landingRequest(r.manifest, r.notAutoCodes ? { why: r.notAutoCodes } : null), Math.ceil(ACTION_TTL_MS / 1000));
                sent = true;
              } catch (e) {
                warn(`The request could not be sent to the owner's Telegram (${String(e.message).slice(0, 300)}).`);
              }
            } else if (link?.problem) warn(LANDING_CHANNEL_PROBLEM[link.why] ?? LANDING_BRIDGE_UPDATE);
            if (sent) {
              out(`Sent to the owner's Telegram. The owner decides it there, or in a terminal (hoptell team approve ${r.id}), before ${r.expires}.`);
              out(`When the owner's decision arrives in your inbox, run: hoptell team apply ${r.id}`);
            } else out(`The owner decides it in a terminal before ${r.expires}: hoptell team approve ${r.id}`);
          } finally {
            link?.close?.();
          }
          if (r) await sendNotices(home, r.team, given, out, warn, deps);
          return;
        }
        const t = opt("--target");
        const message = opt("-m", "--message");
        if (!t || message === undefined) die(`team land needs --target <branch> and -m <message> (or --approve, --discard)\n${TEAM_USAGE}`, 2);
        const prep = args.includes("--prepare");
        // Without --prepare the owner builds it on a terminal; with it the lead does, signed with
        // the owner's configured key: provenance only, never a decision (design 8 addendum).
        if (!prep && !isTTY) die("landing is the owner's step: run hoptell team land in a terminal (the candidate is signed with your key), or let the lead prepare it with --prepare");
        const opts = { target: t, message, homedir, sshAuthSock: env.SSH_AUTH_SOCK || null };
        const r = prep ? await teamLandPrepare(home, target, opts, deps) : await teamLandCandidate(home, target, opts, deps);
        if (prep) out(`${target}: ${r.stopped}.`);
        out(`Candidate ${r.C} on ${r.target} (at ${r.T}), signed and verified; squash of ${target} at ${r.H}.${r.adopted ? " (Its publication by an earlier run is finished; -m was not used.)" : ""}`);
        if (r.rebased) out(`${r.target} moved since ${target} started, and no path overlaps, so the candidate is ${target}'s change re-based onto ${r.T.slice(0, 12)}: test and review exactly this candidate, not the member's own commits.`);
        if (r.stat) out(r.stat);
        const team = landingTeamOf(home, target);
        if (prep) {
          out("The signature shows the candidate was made with your key; it is not your decision. Next, for exactly this candidate:");
          out(`  test it in a worktree of its own, and record the result: hoptell team evidence ${target} --candidate ${r.C} --tests pass|fail --command <command> --report <file>`);
          out(`  have the reviewers review it: hoptell review request --team ${team} --base ${r.T} --head ${r.C}`);
          out(`  then ask the owner: hoptell team land ${target} --request-approval`);
          return;
        }
        out("Next: run the tests on the candidate, have the reviewers review it");
        out(`  hoptell review request --team ${team} --base ${r.T} --head ${r.C}`);
        out(`  (they read git diff --no-ext-diff --no-textconv ${r.T} ${r.C})`);
        out(`then the owner lands it in a terminal: hoptell team land ${target} --approve ${r.T} ${r.C}`);
        return;
      }
      case "evidence": {
        if (!target) die(`team evidence needs a member\n${TEAM_USAGE}`, 2);
        const commands = args.flatMap((a, i) => (a === "--command" ? [opt2(i)] : []));
        const r = await teamEvidence(home, target, { C: opt("--candidate"), tests: opt("--tests"), commands, report: opt("--report") === undefined ? undefined : path.resolve(opt("--report")) });
        if (r.superseded) out(`The landing ${r.superseded} that waited for a decision was superseded by this evidence.`);
        return out(`Recorded for ${r.member}'s candidate ${r.C}: tests ${r.tests} (${r.commands.length} command${r.commands.length === 1 ? "" : "s"}), report ${r.report.slice(0, 12)} (${r.bytes} bytes).`);
      }
      case "approve": {
        if (!target) die(`team approve needs a landing id (L<n>)\n${TEAM_USAGE}`, 2);
        const v = await teamApproveView(home, target, deps);
        const m = v.manifest;
        const p = m.evidence.patch;
        if (args.includes("--show-diff")) {
          if (p.oversize) return out(`The patch of ${v.id} (${p.bytes} bytes) is too large to keep in its record, so it is not stored inline. The record: ${v.path}. View it with: ${reviewDiff(v.repo, m.T, m.C)}`);
          if (p.encoding !== "utf8") return out(`The patch of ${v.id} is not UTF-8 text. View it with: ${reviewDiff(v.repo, m.T, m.C)}`);
          return out(p.text);
        }
        for (const l of approvalLines(v)) out(l);
        if (v.decided === "grant") return out(`${v.id} is approved by your auto-land grant. The lead lands it (hoptell team apply ${v.id}); nothing more is needed here.`);
        if (v.decided === "land") return out(`${v.id} is decided on Telegram: land. The lead applies it (hoptell team apply ${v.id}); nothing more is needed here.`);
        // The owner's step: typed on a terminal. A terminal prompt is no proof of a person.
        if (!isTTY) die(`landing is the owner's step: run hoptell team approve ${v.id} in a terminal`);
        const answer = await (given.ask ?? askLine)(`Land ${v.id} (${m.C} on ${m.target})? Type land to confirm: `);
        if (answer.trim() !== "land") die("not confirmed; nothing was landed");
        let r;
        try {
          r = await teamLandApprove(home, v.member, { T: m.T, C: m.C, homedir, actionId: v.id }, deps);
        } finally {
          // A request that also went to Telegram: its card says how it ended.
          if (m.recipient) await reportOutcome(home, v.id, given, out, warn);
        }
        return landedLines(r, false, out);
      }
      case "apply": {
        if (!target) die(`team apply needs a landing id (L<n>)\n${TEAM_USAGE}`, 2);
        if (memberSession(env)) die("carrying out the owner's landing decision is the lead's step; a team member's session cannot do it");
        let r;
        // How it ended goes to the owner: the card of a request, or an auto-landing's notice.
        const report = async () => {
          await reportOutcome(home, target, given, out, warn);
          let team = null;
          try {
            team = teamOfAction(home, target);
          } catch {}
          if (team) await sendNotices(home, team, given, out, warn, deps);
        };
        try {
          r = await teamApply(home, target, { homedir }, deps);
        } catch (e) {
          await report();
          throw e;
        }
        await report();
        if (r.rejected) return out(`The owner rejected ${r.id} on Telegram; it ended as rejected. Nothing was moved.`);
        return landedLines(r, false, out);
      }
      case "supervise": {
        if (!target) die(`team supervise needs a team\n${TEAM_USAGE}`, 2);
        const s = readState(home, target);
        if (!s) die(`team ${target} has no state`);
        await teamSupervise(home, target, { ...deps, now: Date.now, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), notify: given.notify ?? sendToLead(s, { env }) });
        return;
      }
      default:
        die(sub ? `unknown team command "${String(sub).slice(0, 40)}"\n${TEAM_USAGE}` : `team needs a command\n${TEAM_USAGE}`, 2);
    }
  } catch (e) {
    if (e instanceof TeamError || e.code) die(e.message);
    throw e;
  }
}
