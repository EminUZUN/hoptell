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
import { REGISTRATION_KEYS, TEAM_RE, addWorktree, adoptCandidate, isIdentity, checkOwns, discardCandidate, landApprove, landCandidate, memberState, readWorktreeRecord, registrationOf, processIn, removeWorktree, worktreeStatus } from "./worktrees.js";
import { identityState, pidExists, processIdentity, processTable } from "./host.js";
import { readTaskFile } from "./tmux.js";
import { shellLine } from "./agentadapters.js";
import { SUMMARY_LIMITS, clipText, fitSummary } from "./teamstatus.js";

export const MEMBER_ROLES = ["implementer", "reviewer"];
export const TEAM_MEMBERS_MAX = 16;
const TEAM_FILE_MAX = 64 * 1024;
const STATE_MAX = 1024 * 1024;
const MINUTES_MAX = 1440;
const LOCK_WAIT_MS = 15_000;
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
const isJournal = (x) => isObj(x) && same(x, [...Object.keys(LANDING), "repo", "phase"]) && Object.entries(LANDING).every(([k, f]) => f(x[k])) && isAbs(x.repo) && ["intent", "landed"].includes(x.phase);
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
};

/** What is wrong with a team state (the first problem), or null. Exported for tests. */
export function stateProblem(s, team) {
  if (!isObj(s)) return "not an object";
  for (const k of Object.keys(s)) if (!Object.hasOwn(STATE, k)) return `unknown field ${String(k).slice(0, 40)}`;
  for (const [k, f] of Object.entries(STATE)) if (!Object.hasOwn(s, k) || !f(s[k])) return `field ${k}`;
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

/** The command that finishes a pending landing. */
const finishLine = (l) => `hoptell team land ${l.member} --approve ${l.T} ${l.C}`;

/**
 * What a team still owes a member's landing: a journal that did not finish, or a candidate that
 * was neither approved nor discarded. {member, text} or null. Either keeps the member's worktree
 * through team down and holds team up back.
 */
function pendingOf(s) {
  if (s?.publishing) return { member: s.publishing.member, text: `a candidate was being published: hoptell team land ${s.publishing.member} --target ${s.publishing.target} -m <message> finishes it, hoptell team land ${s.publishing.member} --discard drops it` };
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
 * may be another install than this one. Warnings only.
 */
function codexChecks(members, { homedir, env, warn }) {
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
  for (const m of codex) {
    const trusted = !cfg.problem && [m.folder, real(m.folder)].some((f) => cfg.projects.get(f) === "trusted");
    if (trusted) continue;
    if (cfg.problem && !cfg.missing) warn(`warning: ${m.name}: Codex may ask you to trust ${m.folder} in its pane before it starts (${cfg.file}: ${cfg.problem})`);
    else warn(`warning: ${m.name}: Codex will ask you to trust ${m.folder} in its pane before it starts`);
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
  codexChecks(plan.map((m) => ({ ...m, folder: m.role === "implementer" ? path.join(wtParent, m.folder ?? m.name) : repo })), { homedir, env, warn });
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
  return { team, status: s.status, lead: s.lead, repo: s.repo, members, supervisor: sup, publishing: s.publishing, candidate: s.candidate, landing: s.landing, landed: s.landed, reviews: s.reviews.map(reviewSummary), events: s.events.slice(-10), at: new Date(now).toISOString() };
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
        save(home, { ...s, publishing: null, candidate: { member, target: p.target, T: p.T, C: p.C, H: p.H, at }, events: [...s.events, { at, what: `candidate ${p.C} for ${member} on ${p.target} at ${p.T} (its publication finished)` }] });
        return { target: p.target, T: p.T, C: p.C, H: p.H, stat: r.stat, adopted: true };
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
    save(home, { ...s, publishing: null, candidate: { member, target: c.target, T: c.T, C: c.C, H: c.H, at }, events: [...s.events, { at, what: `candidate ${c.C} for ${member} on ${c.target} at ${c.T}` }] });
    return c;
  });
}

/**
 * `hoptell team land <member> --approve <T> <C>` (or `--confirm <T> <C>` after the owner's own
 * fast-forward of a checked-out target): land the recorded candidate and record provenance. The
 * order keeps evidence until the record is durable: a journal of the intent (repository, member,
 * H, target, T, C) is written before the target moves; the landing is recorded once the target is
 * at C; only then are the candidate branch, the worktree and the journal removed. A run that
 * stopped half-way is finished by the same command. `deps.save` (tests): the state writer.
 * Returns landApprove's result.
 */
export async function teamLandApprove(home, member, { T, C, homedir, confirm = false }, deps = {}) {
  const team = landingTeamOf(home, member);
  const save = deps.save ?? writeState;
  return withTeam(home, team, async (s) => {
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
    if (r.manual) {
      s.events.push({ at: new Date().toISOString(), what: `${c.target} is checked out in ${r.manual.at}: the owner fast-forwards it there` });
      save(home, s);
      return r;
    }
    done(`finished the landing of ${member}${r.checkedOut ? ` (${r.target} was checked out in ${r.checkedOut} meanwhile)` : ""}`);
    return r;
  });
}

/** `hoptell team land <member> --discard`: drop the recorded candidate and its branch. */
export async function teamLandDiscard(home, member, deps = {}) {
  const team = landingTeamOf(home, member);
  return withTeam(home, team, async (s) => {
    const p = s.publishing?.member === member ? s.publishing : null;
    const c = p ?? (s.candidate?.member === member ? s.candidate : null);
    if (!c) fail("no_candidate", `no candidate is recorded for ${member}`);
    if (s.landing) fail("landing_pending", `the landing of ${s.landing.C.slice(0, 12)} did not finish; run hoptell team land ${member} --approve ${s.landing.T} ${s.landing.C} again, which finishes it`);
    // A deletion that did not happen refuses here and keeps the record for the next run.
    await discardCandidate(home, member, { C: c.C, landRef: landRefOf(team), bound: registrationFor(s, member) }, { procs: deps.procs, git: deps.git });
    if (p) s.publishing = null;
    else s.candidate = null;
    s.events.push({ at: new Date().toISOString(), what: `discarded the candidate ${c.C} of ${member}` });
    writeState(home, s);
    return { deleted: true, down: s.status === "down" };
  });
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
       hoptell team land <member> --target <branch> -m <message>
       hoptell team land <member> --approve <T> <C>
       hoptell team land <member> --confirm <T> <C>
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

/**
 * `hoptell team ...`. `env`: the caller's effective settings; `isTTY`: whether a person can answer
 * on this terminal; `prepare`: as for hoptell tmux.
 */
export async function teamCommand({ args, home, homedir, env, fail: die, out, warn, isTTY = false, prepare = null, deps: given = {} }) {
  const VALUE = ["--target", "-m", "--message"];
  const opt = (...names) => {
    const at = args.findIndex((a) => names.includes(a));
    if (at < 0) return undefined;
    const v = args[at + 1];
    if (v === undefined || v === "" || (v.startsWith("-") && v !== "-")) die(`${args[at]} needs a value\n${TEAM_USAGE}`, 2);
    return v;
  };
  // --approve <T> <C> and --confirm <T> <C> take two values.
  const pairFlag = ["--approve", "--confirm"].find((f) => args.includes(f)) ?? null;
  const approveAt = pairFlag ? args.indexOf(pairFlag) : -1;
  const approved = approveAt < 0 ? null : args.slice(approveAt + 1, approveAt + 3);
  const known = ["--dry-run", "--yes", "--json", "--keep-worktrees", "--approve", "--confirm", "--discard", ...VALUE];
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
        if (r.landing) out(`  landing pending (${r.landing.phase === "landed" ? "landed, cleanup unfinished" : "target not confirmed moved"}): ${finishLine(r.landing)} finishes it`);
        for (const l of r.landed) out(`  landed: ${l.member} ${l.H.slice(0, 12)} as ${l.C.slice(0, 12)} on ${l.target}`);
        // Open review requests, and the verdicts of the latest one that every reviewer answered.
        const answered = (v) => v.answers.map((a) => `${a.reviewer} ${a.verdict}`).join(", ");
        for (const v of r.reviews.filter((x) => x.waiting.length)) out(`  review ${v.id}: ${v.member}'s ${v.base.slice(0, 12)}..${v.head.slice(0, 12)}; waiting for ${v.waiting.join(", ")}${v.answers.length ? `; ${answered(v)}` : ""}`);
        const closed = r.reviews.filter((x) => !x.waiting.length).at(-1);
        if (closed) out(`  last review ${closed.id}: ${closed.member}'s ${closed.base.slice(0, 12)}..${closed.head.slice(0, 12)}: ${answered(closed)}`);
        for (const e of r.events) out(`  ${e.at}  ${e.what}`);
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
          if (r.manual) {
            // One line that checks again and merges only when both checks pass: pasted into a
            // shell that does not take # as a comment (interactive zsh), nothing merges after a
            // failed check.
            out(`${r.target} is checked out in ${r.manual.at}, so hoptell does not move it. hoptell checked that its HEAD is ${r.target} at ${r.T}. In that folder, run the line below: it checks again that HEAD is refs/heads/${r.target} at ${r.T}, and fast-forwards only when both checks pass.`);
            out(`  cd ${shellLine(r.manual.at, []).trim()}`);
            out(`  test "$(git symbolic-ref HEAD)" = refs/heads/${r.target} && test "$(git rev-parse HEAD)" = ${r.T} && git merge --ff-only ${r.C}`);
            out(`then record it: hoptell team land ${target} --confirm ${r.T} ${r.C}`);
            return;
          }
          out(`${confirm ? "Confirmed" : "Landed"} ${r.C} on ${r.target} (was ${r.T}).`);
          if (r.checkedOut) out(`  warning: ${r.target} was checked out in ${r.checkedOut} while it moved. The index and working tree there were NOT updated: they still hold ${r.T}, so git status shows the landed change as undone. Check git status there; git read-tree -m -u ${r.T} ${r.C} brings them to ${r.target} and keeps your own changes`);
          out(r.removed.already ? "  worktree already removed" : r.removed.kept ? `  worktree kept: ${r.removed.why}` : `  worktree removed; branch ${r.removed.branch} ${r.removed.branchState}${r.removed.keptBecause ? ` (${r.removed.keptBecause})` : ""}`);
          return;
        }
        const t = opt("--target");
        const message = opt("-m", "--message");
        if (!t || message === undefined) die(`team land needs --target <branch> and -m <message> (or --approve, --discard)\n${TEAM_USAGE}`, 2);
        // The candidate is signed with the owner's key, which never serves an agent (decision 4).
        if (!isTTY) die("landing is the owner's step: run hoptell team land in a terminal (the candidate is signed with your key)");
        const r = await teamLandCandidate(home, target, { target: t, message, homedir, sshAuthSock: env.SSH_AUTH_SOCK || null }, deps);
        out(`Candidate ${r.C} on ${r.target} (at ${r.T}), signed and verified; squash of ${target} at ${r.H}.${r.adopted ? " (Its publication by an earlier run is finished; -m was not used.)" : ""}`);
        if (r.stat) out(r.stat);
        out("Next: run the tests on the candidate, have the reviewers review it");
        out(`  hoptell review request --team ${landingTeamOf(home, target)} --base ${r.T} --head ${r.C}`);
        out(`  (they read git diff --no-ext-diff --no-textconv ${r.T} ${r.C})`);
        out(`then the owner lands it in a terminal: hoptell team land ${target} --approve ${r.T} ${r.C}`);
        return;
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
