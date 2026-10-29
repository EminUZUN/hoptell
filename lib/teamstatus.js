// A lead's team summary (design 8, 3.2): what the lead's session publishes as its own owner-only
// status at the relay (cap "status", lib/relay.js), and what the bridge's /team and the Mini App
// show of it. lib/teams.js builds it from the team state and the review queue; this module holds
// its shape, its limits and the check every reader runs.
//
// Nothing in it grants anything: it is display text. The relay lists it only to sessions of the
// lead's own member, and a reader shows it only as the team of the session that published it,
// never of a name the text itself mentions. A summary that does not have exactly this shape is
// ignored whole.
//
//   {v: 1, teams: [{team, status, members: [{name, role, cli, model, effort, branch, state}],
//                   more, reviews: [{id, member, waiting: [reviewer]}]}]}
//
// model and effort are the values at launch (null: the CLI's default); more counts the members
// left out to stay within STATUS_MAX_BYTES; reviews are the open review requests.
import { NAME_RE, STATUS_MAX_BYTES } from "./config.js";
import { TEAM_RE } from "./worktrees.js";

/** A member's state in the summary (lib/teams.js leadStatus says how each is derived). */
export const TEAM_STATES = ["working", "ready", "in review", "approved", "exited", "unknown"];
export const SUMMARY_LIMITS = Object.freeze({ teams: 4, members: 16, reviews: 5, waiting: 16, cli: 16, model: 64, effort: 32, branch: 100 });
const ROLES = ["implementer", "reviewer"];
const STATUSES = ["starting", "up", "partial", "stopping"];
const REVIEW_RE = /^rv-[0-9a-f]{8}$/;

/** At most `max` code points of `s`, with control, format and line-break characters as spaces. */
export function clipText(s, max) {
  const t = String(s)
    .replace(/[\p{Cc}\p{Cf}\u2028\u2029]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return [...t].slice(0, max).join("");
}

const isObj = (x) => Boolean(x) && typeof x === "object" && !Array.isArray(x);
const exact = (o, keys) => isObj(o) && Object.keys(o).length === keys.length && keys.every((k) => Object.hasOwn(o, k));
const text = (x, max) => typeof x === "string" && x.length <= max * 2 && [...x].length <= max;
const textOrNull = (x, max) => x === null || text(x, max);
const isName = (x) => typeof x === "string" && NAME_RE.test(x);

/** The member prefix of a lead's name, as a team file requires of its members (lib/teams.js). */
export const prefixOf = (lead) => `${String(lead).split("-")[0]}-`;

/**
 * The summary `raw` published by the session `publisher`, checked and cleaned: {teams}, or null
 * when it is not one. Every member must carry the publisher's member prefix and none may be the
 * publisher itself: a session shows only a team of its own names.
 */
export function parseTeamStatus(raw, publisher) {
  if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > STATUS_MAX_BYTES || !isName(publisher)) return null;
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch {
    return null;
  }
  const L = SUMMARY_LIMITS;
  if (!exact(doc, ["v", "teams"]) || doc.v !== 1 || !Array.isArray(doc.teams) || doc.teams.length > L.teams) return null;
  const prefix = prefixOf(publisher);
  const ours = (n) => isName(n) && n.startsWith(prefix) && n.length > prefix.length && n !== publisher;
  const teams = [];
  const seen = new Set();
  for (const t of doc.teams) {
    if (!exact(t, ["team", "status", "members", "more", "reviews"])) return null;
    if (typeof t.team !== "string" || !TEAM_RE.test(t.team) || seen.has(t.team) || !STATUSES.includes(t.status)) return null;
    seen.add(t.team);
    if (!Array.isArray(t.members) || t.members.length > L.members || !Number.isSafeInteger(t.more) || t.more < 0 || t.more > L.members) return null;
    if (!Array.isArray(t.reviews) || t.reviews.length > L.reviews) return null;
    const members = [];
    for (const m of t.members) {
      if (!exact(m, ["name", "role", "cli", "model", "effort", "branch", "state"])) return null;
      if (!ours(m.name) || !ROLES.includes(m.role) || !text(m.cli, L.cli) || !textOrNull(m.model, L.model) || !textOrNull(m.effort, L.effort) || !textOrNull(m.branch, L.branch) || !TEAM_STATES.includes(m.state)) return null;
      if (members.some((x) => x.name === m.name)) return null;
      members.push({ name: m.name, role: m.role, cli: clipText(m.cli, L.cli), model: m.model === null ? null : clipText(m.model, L.model), effort: m.effort === null ? null : clipText(m.effort, L.effort), branch: m.branch === null ? null : clipText(m.branch, L.branch), state: m.state });
    }
    // A review names an implementer of this team's list and waits for reviewers of it.
    const listed = (n, role) => members.some((x) => x.name === n && x.role === role);
    const reviews = [];
    for (const r of t.reviews) {
      if (!exact(r, ["id", "member", "waiting"]) || typeof r.id !== "string" || !REVIEW_RE.test(r.id) || !listed(r.member, "implementer")) return null;
      if (!Array.isArray(r.waiting) || r.waiting.length < 1 || r.waiting.length > L.waiting || !r.waiting.every((n) => listed(n, "reviewer"))) return null;
      reviews.push({ id: r.id, member: r.member, waiting: [...r.waiting] });
    }
    teams.push({ team: t.team, status: t.status, members, more: t.more, reviews });
  }
  return { teams };
}

/**
 * Fit a summary within STATUS_MAX_BYTES: open reviews go first, then members (counted in more),
 * then teams. Every review is gone before a member is, so no review names a member left out.
 */
export function fitSummary(doc) {
  const size = () => Buffer.byteLength(JSON.stringify(doc), "utf8");
  while (size() > STATUS_MAX_BYTES) {
    const withReviews = doc.teams.findLast((t) => t.reviews.length);
    if (withReviews) {
      withReviews.reviews.pop();
      continue;
    }
    const big = [...doc.teams].sort((a, b) => b.members.length - a.members.length)[0];
    if (big && big.members.length > 1) {
      big.members.pop();
      big.more += 1;
      continue;
    }
    doc.teams.pop();
  }
  return doc;
}

/**
 * The teams in an attested list of the owner's own sessions (entries {name, status?}): each
 * summary checked and shown under the session that published it, sorted by lead and team, at most
 * `max`. A name two leads both list is shown under neither (counted in more): a session's summary
 * is its own word, and two sessions that disagree about a name settle nothing.
 */
export function ownTeams(own, max = 50) {
  const parsed = [];
  for (const p of Array.isArray(own) ? own : []) {
    if (typeof p?.status !== "string" || typeof p.name !== "string") continue;
    const s = parseTeamStatus(p.status, p.name);
    if (s) for (const t of s.teams) parsed.push({ lead: p.name, ...t });
  }
  const leadsOf = new Map();
  const claim = (n, lead) => leadsOf.set(n, new Set([...(leadsOf.get(n) ?? []), lead]));
  // Members, and as a second layer the names reviews mention (the parser keeps those to members).
  for (const t of parsed) for (const n of [...t.members.map((m) => m.name), ...t.reviews.flatMap((r) => [r.member, ...r.waiting])]) claim(n, t.lead);
  const disputed = (n) => (leadsOf.get(n)?.size ?? 0) > 1;
  return parsed
    .map((t) => {
      const members = t.members.filter((m) => !disputed(m.name));
      const reviews = t.reviews.filter((r) => !disputed(r.member)).map((r) => ({ ...r, waiting: r.waiting.filter((n) => !disputed(n)) }))
        .filter((r) => r.waiting.length);
      return { ...t, members, reviews, more: t.more + t.members.length - members.length };
    })
    .sort((a, b) => (a.lead < b.lead ? -1 : a.lead > b.lead ? 1 : a.team < b.team ? -1 : a.team > b.team ? 1 : 0))
    .slice(0, max);
}
