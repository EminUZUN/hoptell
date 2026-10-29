// The bridge's side of the owner channel's Mini App (design 7.4): the API behind the page, the app
// sessions, and the app runner. The page reaches the bridge only through the relay's tunnel
// (lib/apptunnel.js); the bridge opens no listener.
//
// The rule that keeps the bot's guarantees: the app proposes, the chat decides. No app request can
// make the bridge sign an instruction or an answer. A draft becomes a confirmation in the chat, sent
// only by the owner's tap on it (a Telegram update); a settings change takes effect only after its
// line (with Undo) is in the chat; an answer is given on the question's card. Outbox entries of
// app origin hold only Telegram steps and the local prefs step, and sendStep refuses anything else.
//
// App entries run here, not in the bot's outbox runner: this runner takes the bridge's serial queue
// only for the short state writes before and after a step, never while it waits for Telegram, so a
// stalled Telegram never holds the owner's answers and instructions.
import crypto from "node:crypto";
import net from "node:net";
import { APP_LIMITS as TUNNEL_LIMITS } from "./apptunnel.js";
import { NAME_RE } from "./config.js";
import { checkInitData } from "./ownerappauth.js";
import { nonceOf } from "./ownersig.js";
import { PeopleFullError, aliasProblemIn, bump, normalAlias, readPeople, revOf, settingFields, updatePeople } from "./ownerpeople.js";
import { TEXTS, ago } from "./ownertexts.js";
import { ownTeams } from "./teamstatus.js";

export const APP_LIMITS = {
  idleMs: 15 * 60_000, // a session ends after 15 minutes without a call
  maxMs: 30 * 60_000, // and 30 minutes after it opened
  sessions: 3, // live sessions per bridge; a fourth ends the oldest
  opensPerMin: 10, // sessions opened per pairing a minute
  readsPerMin: 120,
  writesPerMin: 30,
  draftsPerMin: 10,
  openDrafts: 3, // confirmations of app origin not yet sent, cancelled or expired
  linesWaiting: 5, // settings whose line is not in the chat yet
  queue: 4, // writes waiting for admission
  unfinished: 8, // app entries not finished
  opsMax: 2000, // op ids kept (an hour); full: a new write is refused, nothing is dropped early
  opsMs: 3600_000,
  failsPerMin: 20, // failed initData across all clients; then every session request is refused
  lockoutMs: 5 * 60_000,
  lockLineMs: 86400_000, // the lockout's line in the chat: at most once a day
  agentsMs: 15_000, // the attested list behind reads is at most this old
  marginMs: 500, // a write's deadline: the relay's time left minus this
  retryMs: 5000,
  undos: 500, // Undo buttons of applied changes kept (24 hours each); past it, the oldest goes
  pageRows: 500, // agents in one page of the list
  pageBytes: 192 * 1024, // and at most this much of them (the relay takes 256 KiB a response)
};
export const APP_TEXT_MAX = 3500;
export const UNDO_MS = 86400_000;
export const DRAFT_MS = 10 * 60_000;
const OP_RE = /^[A-Za-z0-9_-]{22}$/;
const H_RE = /^[a-z2-7]{10}$/;
const B32 = "abcdefghijklmnopqrstuvwxyz234567";
const b32 = (n) => [...crypto.randomBytes(n)].map((b) => B32[b & 31]).join("");
/** A new app id: 128 random bits and more, 26 base32 characters (design 7.4, section 2). */
export const newAppId = () => b32(26);
const json = (o) => JSON.stringify(o);

/** Why no origin was derived from the relay URL, for logs and the CLI. */
export const APP_ORIGIN_PROBLEMS = {
  no_relay: "no relay URL",
  not_tls: "the relay URL is ws://, not wss://",
  ip: "the relay URL names an IP address, not a host name",
};

/**
 * The app's public origin (design 7.4, section 2): where Telegram opens the page, and the only
 * `Origin` the API accepts. `explicit` is HOPTELL_APP_URL: an https URL with no path, query,
 * fragment or credentials; it is normalized (only its origin is kept), and a blank value counts as
 * unset. Without it, the origin is inferred from the relay URL, conservatively: automatic inference
 * requires wss:// and a DNS name; IP-based relay URLs require an explicit public HTTPS address.
 * Returns {origin} or {origin: null, problem}; a set but invalid value is {origin: null, invalid}
 * and never falls back to the relay.
 */
export function appOriginFor({ explicit = null, relayUrl = null } = {}) {
  if (explicit != null && String(explicit).trim() !== "") {
    let u;
    try {
      u = new URL(String(explicit).trim());
    } catch {
      return { origin: null, invalid: "HOPTELL_APP_URL is not a URL" };
    }
    if (u.protocol !== "https:") return { origin: null, invalid: "HOPTELL_APP_URL must start with https://" };
    if (u.username || u.password || u.search || u.hash || u.pathname !== "/") return { origin: null, invalid: "HOPTELL_APP_URL must be an HTTPS address with an optional port and no path, query string, fragment, or credentials" };
    return { origin: u.origin };
  }
  let u;
  try {
    u = new URL(relayUrl ?? "");
  } catch {
    return { origin: null, problem: "no_relay" };
  }
  if (u.protocol !== "wss:") return { origin: null, problem: "not_tls" };
  if (net.isIP(u.hostname.replace(/^\[|\]$/g, ""))) return { origin: null, problem: "ip" };
  return { origin: `https://${u.host}` };
}
const nul = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v === undefined ? null : v]));
const unnul = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v === null ? undefined : v]));

/** Thrown by a prefs step that must not write people.json: its outcome. */
class Outcome extends Error {
  constructor(what, rev = null) {
    super(what);
    this.what = what;
    this.rev = rev;
  }
}
/** The runner stops (a crash, a lost claim, a stop): picked up again on the next kick. */
class Stop extends Error {}

/**
 * The app of one bridge. `ctx` gives the bridge's internals (see lib/ownerchannel.js, createBridge):
 * state, serial, save, admit, count, hit, halt, leading, pid, pairing, ownMember, tgCall,
 * ownAgents, labels, display, people, relay, appOrigin, key, botId, home, appKey, now, log,
 * refreshNames, cardBegin, cardRender, cardDone, closedText, Crash, NotLeader, audit, page.
 */
export function createOwnerApp(ctx) {
  const L = { ...APP_LIMITS, ...(ctx.limits ?? {}) };
  const { now, log } = ctx;
  const S = () => ctx.state();
  const sessions = new Map(); // token -> {pairing, user, member, gen, created, last, replay, handles: Map(name -> h)}
  const handles = new Map(); // h -> {name, member, pairing, exp, token}
  const rates = new Map(); // "<pairing>:<kind>" -> [times]
  let fails = [];
  let lockUntil = 0;
  let waiting = 0; // writes waiting for admission
  let agents = null; // {a, at}
  let agentsP = null;
  let registered = false; // the relay acknowledged this app id
  let running = false;
  let runP = null; // the runner in flight (halt waits for it before the home lock is released)
  let again = false;
  let timer = null;

  const app = () => S()?.app ?? null;
  const on = () => Boolean(app()?.on && app()?.id);
  /** Whether the relay serves this bridge's app now (its capability, and our registration). */
  const served = () => on() && registered && Boolean(ctx.relay()?.caps?.includes("owner_app"));
  /** ...and Telegram can open it: the bridge knows the app's public https origin (HOPTELL_APP_URL). */
  const available = () => served() && Boolean(ctx.appOrigin());
  const url = () => `${ctx.appOrigin()}/app/${app().id}/`;
  const origin = () => ctx.appOrigin();

  /** The inline button that opens the app, or null when it is off or not served. */
  const button = () => (available() ? { text: TEXTS.appButton, web_app: { url: url() } } : null);

  function take(kind, max, p, ms = 60_000) {
    const k = `${p}:${kind}`;
    const t = now();
    const xs = (rates.get(k) ?? []).filter((x) => t - x < ms);
    if (xs.length >= max) {
      rates.set(k, xs);
      return false;
    }
    xs.push(t);
    rates.set(k, xs);
    return true;
  }

  // ---- registration with the relay ------------------------------------------------------------

  /** After every welcome as leader: tell the relay about this app id (on or off) and earlier ids. */
  async function register() {
    registered = false;
    const a = app();
    const relay = ctx.relay();
    if (!a?.id || !relay?.caps?.includes("owner_app")) return;
    const retire = [...(a.retire ?? [])];
    const off = [...(a.off ?? [])];
    try {
      const r = await relay.rpc({ type: "app_register", app: a.id, ...(a.on ? {} : { state: "off" }), ...(retire.length ? { retire } : {}), ...(off.length ? { off } : {}) });
      registered = a.on && r?.state === "on";
      await ctx.serial(() => {
        const cur = app();
        if (!cur) return;
        cur.retire = (cur.retire ?? []).filter((x) => !retire.includes(x));
        cur.off = (cur.off ?? []).filter((x) => !off.includes(x));
        if (!cur.retire.length) delete cur.retire;
        if (!cur.off.length) delete cur.off;
        ctx.save("app-registered");
      });
    } catch (e) {
      log(`owner channel: the relay did not register the app: ${e.code ?? ""} ${e.message}`);
    }
  }

  // ---- sessions --------------------------------------------------------------------------------

  /** End every app session and handle (a pairing or member change, /app off, --off, --rotate). */
  function endAll(why) {
    if (sessions.size) ctx.audit("app_session", { closed: sessions.size, why });
    sessions.clear();
    handles.clear();
  }

  /** The session of a request, if it is still valid for the current pairing, member and app. */
  function sessionOf(m) {
    const auth = typeof m.auth === "string" ? m.auth.match(/^Bearer ([A-Za-z0-9_-]{43})$/) : null;
    const s = auth ? sessions.get(auth[1]) : null;
    if (!s) return null;
    const t = now();
    const p = ctx.pairing();
    if (t - s.last > L.idleMs || t - s.created > L.maxMs || !p || s.pairing !== p.id || String(s.user) !== String(p.user_id) || s.member !== ctx.ownMember() || s.gen !== app()?.gen || !on()) {
      drop(auth[1], "ended");
      return null;
    }
    s.last = t;
    return { token: auth[1], ...s, s };
  }
  /** Whether a session found earlier is still valid now (after an await), on a leading bridge. */
  const still = (sess) => ctx.leading() && sessionOf({ auth: `Bearer ${sess.token}` }) !== null;
  function drop(token, why) {
    const s = sessions.get(token);
    if (!s) return;
    sessions.delete(token);
    for (const h of s.handles.values()) handles.delete(h);
    ctx.audit("app_session", { closed: 1, why });
  }

  function handleFor(sess, name) {
    let h = sess.s.handles.get(name);
    if (h && handles.has(h)) return h;
    h = b32(10);
    handles.set(h, { name, member: sess.member, pairing: sess.pairing, exp: sess.created + L.maxMs, token: sess.token });
    sess.s.handles.set(name, h);
    return h;
  }
  /** A handle of this session, unexpired, made under the current pairing and member. */
  function handleOf(sess, h) {
    const x = typeof h === "string" && H_RE.test(h) ? handles.get(h) : null;
    if (!x || x.token !== sess.token || !(now() < x.exp) || x.pairing !== ctx.pid() || x.member !== ctx.ownMember()) return null;
    return x;
  }

  async function openSession(body) {
    const t = now();
    const p = ctx.pairing();
    if (!ctx.appKey || !p) return [403, { error: "not_you" }];
    if (t < lockUntil) return [403, { error: "not_you" }];
    const a = app();
    const r = checkInitData(typeof body?.init_data === "string" ? body.init_data : "", { secret: ctx.appKey, botId: ctx.botId, user: p.user_id, chat: p.chat_id, since: [a.since, p.at], now: t });
    if (!r.ok) {
      ctx.count(`app_initdata_${r.reason}`);
      ctx.audit("app_session", { refused: r.reason });
      fails = fails.filter((x) => t - x < 60_000);
      fails.push(t);
      if (fails.length >= L.failsPerMin) {
        lockUntil = t + L.lockoutMs;
        fails = [];
        await ctx.serial(() => {
          ctx.count("app_initdata_lockout");
          const st = S();
          if (!(t - (st.app_lock_line ?? -Infinity) < L.lockLineMs)) {
            st.app_lock_line = t;
            ctx.admit({ kind: "n", id: null, steps: [{ t: "tg", method: "sendMessage", params: { text: TEXTS.appLockout, disable_notification: true } }], next: 0 });
          }
          ctx.save("app-lockout");
        });
        ctx.kick();
      }
      return r.recent ? [403, { error: "just_changed" }] : [403, { error: "not_you" }];
    }
    // Only verified opens count against the per-pairing limit: failures have their own (above), and
    // must all reach it. The relay limits session requests per client address before both.
    if (!take("open", L.opensPerMin, p.id)) return [429, { error: "too_many" }];
    // One session per initData: the same one again (also re-encoded) replaces the first.
    for (const [tok, s] of sessions) if (s.replay === r.replayKey) drop(tok, "replaced");
    while (sessions.size >= L.sessions) drop(sessions.keys().next().value, "too_many");
    const token = crypto.randomBytes(32).toString("base64url");
    sessions.set(token, { pairing: p.id, user: p.user_id, member: ctx.ownMember(), gen: a.gen, created: t, last: t, replay: r.replayKey, handles: new Map() });
    ctx.audit("app_session", { opened: 1 });
    return [200, { token, expires_in: Math.floor(L.idleMs / 1000) }];
  }

  // ---- reads (outside the serial queue: a snapshot of state, and a cached attested list) --------

  async function attested() {
    if (agents && now() - agents.at < L.agentsMs) return agents.a;
    agentsP ??= ctx
      .ownAgents()
      .then((a) => {
        agents = { a, at: now() };
        return a;
      })
      .finally(() => (agentsP = null));
    return agentsP;
  }

  /** The eligible sessions, ranked as the 7.3 picker: favourites, recent, online, then the rest. */
  function ranked(a, ppl) {
    const t = now();
    const L2 = ctx.labels(a.own.map((p) => p.name), ppl);
    const online = new Map(a.own.filter((p) => p.online).map((p) => [p.name, p]));
    const eligible = new Set([...a.own.map((p) => p.name), ...Object.keys(ppl).filter((n) => n !== ctx.name && !a.others.has(n) && NAME_RE.test(n))]);
    const e = (n) => (Object.hasOwn(ppl, n) ? ppl[n] : {});
    const by = (x, y) => {
      const lx = L2.get(x).label.toLowerCase();
      const ly = L2.get(y).label.toLowerCase();
      return lx < ly ? -1 : lx > ly ? 1 : x < y ? -1 : x > y ? 1 : 0;
    };
    const favs = [...eligible].filter((n) => e(n).fav);
    const favOrder = [...favs.filter((n) => online.has(n)).sort(by), ...favs.filter((n) => !online.has(n)).sort(by)];
    const recent = [...eligible].filter((n) => !e(n).fav && t - (Number(e(n).last_talked) || 0) < 7 * 86400_000).sort((x, y) => (Number(e(y).last_talked) || 0) - (Number(e(x).last_talked) || 0) || by(x, y));
    const seen = (n) => Number(e(n).first_seen) || t;
    const onl = [...online.keys()].filter((n) => !e(n).fav && !recent.includes(n)).sort((x, y) => seen(y) - seen(x) || by(x, y));
    const rest = [...eligible].filter((n) => !favs.includes(n) && !recent.includes(n) && !online.has(n)).sort(by);
    return { order: [...favOrder, ...recent, ...onl, ...rest], labels: L2, online, eligible, e, favs };
  }

  function row(sess, n, R, a) {
    const l = R.labels.get(n);
    const p = R.online.get(n) ?? a.own.find((x) => x.name === n);
    const e = R.e(n);
    return {
      h: handleFor(sess, n),
      label: l.label,
      full: l.full,
      logical: l.plain,
      machine: typeof p?.host === "string" && p.host ? ctx.cleanLabel(p.host, 64) : null,
      online: R.online.has(n),
      fav: Boolean(e.fav),
      hidden: Boolean(e.hidden),
      alias: e.alias ?? null,
      last_talked: e.last_talked ? ago(now() - e.last_talked) : null,
    };
  }

  /**
   * One page of the list: at most L.pageRows rows and L.pageBytes of them (one row at least).
   * Page 0 fixes the order for this session (a snapshot); `next` ("<snapshot>/<start>", or null)
   * reads on in that same order, so a change of rank between pages never hides an agent. Agents
   * gone since are skipped; ones new since appear at the next page 0. A replaced snapshot: stale.
   */
  async function listSessions(sess, cursor = null) {
    let a;
    try {
      a = await attested();
    } catch (e) {
      if (e instanceof ctx.NotLeader) return [503, { error: "offline" }];
      return [503, { error: "offline" }];
    }
    // The owner may have changed while the list was fetched: this session must still be valid.
    if (!still(sess)) return [401, { error: "session" }];
    if (!a.attested) return [200, { error: "needs_update", text: TEXTS.cannotList }];
    const R = ranked(a, ctx.people());
    if (cursor && sess.s.snap?.id !== cursor.id) return [200, { error: "stale" }];
    if (!cursor) sess.s.snap = { id: b32(10), order: R.order };
    const { order, id } = sess.s.snap;
    const list = [];
    let bytes = 0;
    let i = cursor?.start ?? 0;
    for (; i < order.length && list.length < L.pageRows; i++) {
      if (!R.eligible.has(order[i])) continue; // gone since page 0
      const r = row(sess, order[i], R, a);
      const b = Buffer.byteLength(json(r)) + 1;
      if (list.length && bytes + b > L.pageBytes) break;
      list.push(r);
      bytes += b;
    }
    return [200, { sessions: list, counts: { favourites: R.favs.length, online: R.online.size, all: order.length }, next: i < order.length ? `${id}/${i}` : null }];
  }

  async function oneSession(sess, h) {
    const x = handleOf(sess, h);
    if (!x) return [200, { error: "stale" }];
    let a;
    try {
      a = await attested();
    } catch {
      return [503, { error: "offline" }];
    }
    if (!still(sess)) return [401, { error: "session" }];
    if (!handleOf(sess, h)) return [200, { error: "stale" }];
    if (!a.attested) return [200, { error: "needs_update", text: TEXTS.cannotList }];
    const ppl = ctx.people();
    const R = ranked(a, ppl);
    if (!R.eligible.has(x.name)) return [200, { error: "stale" }];
    const out = row(sess, x.name, R, a);
    const e = R.e(x.name);
    const l = R.labels.get(x.name);
    if (l.moved && out.machine && e.alias_host) out.warning = TEXTS.appMoved(l.full, out.machine, ctx.cleanLabel(e.alias_host, 64));
    return [200, out];
  }

  function listQuestions() {
    const t = now();
    const qs = Object.values(S().questions)
      .filter((r) => (r.status === "open" || r.status === "pending") && r.payload)
      .sort((a, b) => a.created - b.created || (a.num ?? 0) - (b.num ?? 0))
      .map((r) => ({ n: r.num, asker: ctx.labelOf(r.asker.name), text: ctx.fit(ctx.cleanLabel(r.payload.question, 4000), 200), age: ago(t - r.created), choices: r.payload.choices.map((c) => ctx.cleanLabel(c, 40)) }));
    return [200, { questions: qs }];
  }

  /**
   * The teams view (design 8, 3.2; read-only): each team a session of the owner's attested list
   * reports, under that session (lib/teamstatus.js ownTeams), with labels as the list shows them.
   * No handles: nothing in it can be tapped to act. Within L.pageBytes; the rest is counted.
   */
  async function listTeamsView(sess) {
    let a;
    try {
      a = await attested();
    } catch {
      return [503, { error: "offline" }];
    }
    if (!still(sess)) return [401, { error: "session" }];
    if (!a.attested || !ctx.relay()?.caps?.includes("status")) return [200, { error: "needs_update", text: TEXTS.teamsNeedUpdate }];
    const teams = ownTeams(a.own);
    const ppl = ctx.people();
    const L2 = ctx.labels(
      teams.flatMap((x) => [x.lead, ...x.members.map((m) => m.name), ...x.reviews.flatMap((r) => [r.member, ...r.waiting])]),
      ppl,
    );
    const who = (n) => ctx.cleanLabel(L2.get(n)?.full ?? n, 64);
    const online = new Set(a.own.filter((p) => p.online).map((p) => p.name));
    const opt = (v) => (v === null ? TEXTS.cliDefault : ctx.cleanLabel(v, 64));
    const out = [];
    let bytes = 0;
    for (const x of teams) {
      const host = a.own.find((p) => p.name === x.lead)?.host;
      const t = {
        team: ctx.cleanLabel(x.team, 64),
        status: x.status,
        lead: who(x.lead),
        machine: typeof host === "string" && host ? ctx.cleanLabel(host, 64) : null,
        members: x.members.map((m) => ({ label: who(m.name), role: m.role, cli: ctx.cleanLabel(m.cli, 64), model: opt(m.model), effort: opt(m.effort), branch: m.branch === null ? null : ctx.cleanLabel(m.branch, 100), state: m.state, online: online.has(m.name) })),
        more: x.more,
        reviews: x.reviews.map((r) => ({ member: who(r.member), waiting: r.waiting.map(who) })),
      };
      const b = Buffer.byteLength(json(t)) + 1;
      if (out.length && bytes + b > L.pageBytes) break;
      out.push(t);
      bytes += b;
    }
    return [200, { teams: out, more: teams.length - out.length }];
  }

  // ---- writes: admitted in one state write, then run by the app runner ----------------------------

  const appEntries = () => S().outbox.filter((e) => e.origin === "a" && e.kind === "a");
  const openDrafts = () => Object.values(S().targets).filter((x) => x.kind === "confirm" && x.app && now() < x.exp).length;
  const linesWaiting = () => appEntries().filter((e) => e.steps.slice(e.next).some((s) => s.t === "aline")).length;

  function pruneOps(t) {
    const ops = (S().app_ops ??= {});
    for (const [k, o] of Object.entries(ops)) if (!(t - o.at < L.opsMs)) delete ops[k];
    return ops;
  }

  /**
   * A write: `op` (16 random bytes from the page) makes it happen at most once per pairing; the
   * first result is returned again for a repeat. It waits in a queue of L.queue at most and is
   * admitted in one serial state write, or dropped without effect when its deadline passed first.
   */
  async function write(m, sess, body, admitFn) {
    const op = body?.op;
    if (typeof op !== "string" || !OP_RE.test(op)) return [400, { error: "bad_request" }];
    const k = `${sess.pairing}:${op}`;
    const seen = S().app_ops?.[k];
    if (seen && now() - seen.at < L.opsMs) return [seen.result.status, seen.result.body];
    if (!take("write", L.writesPerMin, sess.pairing)) return [429, { error: "too_many" }];
    if (waiting >= L.queue) return [503, { error: "busy" }];
    waiting++;
    const deadline = m.received + Math.max(0, Number(m.ttl_ms) || 0) - L.marginMs;
    let out = null;
    let ran = false;
    await ctx.serial(() => {
      waiting--;
      ran = true;
      const t = now();
      // Unadmitted work never takes effect later.
      if (t > deadline) {
        out = [504, { error: "slow" }];
        ctx.audit("app_write", { dropped: "deadline" });
        return;
      }
      const ops = pruneOps(t);
      if (ops[k]) {
        out = [ops[k].result.status, ops[k].result.body];
        return;
      }
      if (!sessionOf({ auth: `Bearer ${sess.token}` })) {
        out = [401, { error: "session" }];
        return;
      }
      if (Object.keys(ops).length >= L.opsMax || appEntries().length >= L.unfinished) {
        out = [503, { error: "busy" }];
        return;
      }
      const r = admitFn(nonceOf(ctx.key, ["app", sess.pairing, op]), t);
      if (r.entry) ctx.admit({ kind: "a", origin: "a", op, pairing: sess.pairing, user: sess.user, member: sess.member, app_gen: app().gen, app_id: app().id, next: 0, ...r.entry });
      r.apply?.();
      ops[k] = { result: { status: r.status, body: r.body }, at: t };
      ctx.hit("app-commit");
      ctx.save("app");
      ctx.hit("app-after-commit");
      // Answered only once committed: a crash before the write answers 503 (uncertain).
      out = [r.status, r.body];
    });
    if (!ran) {
      waiting = Math.max(0, waiting - 1);
      return [503, { error: "offline" }];
    }
    if (out === null) return [503, { error: "offline" }];
    kick();
    return out;
  }

  /** Fields of the body other than these are refused (the page never sends a name). */
  const only = (body, keys) => body && typeof body === "object" && !Array.isArray(body) && Object.keys(body).every((k) => keys.includes(k));

  function stillOwn(name) {
    const a = agents?.a;
    if (!a?.attested) return true; // checked again at the tap (to_member stays the boundary)
    return !a.others.has(name);
  }

  async function prefs(m, sess, body) {
    if (!only(body, ["h", "op", "set"]) || !body.set || typeof body.set !== "object" || Array.isArray(body.set) || Object.keys(body.set).length !== 1) return [400, { error: "bad_request" }];
    const [setting, value] = Object.entries(body.set)[0];
    if (!((setting === "fav" || setting === "hidden") && typeof value === "boolean") && !(setting === "alias" && (value === null || typeof value === "string"))) return [400, { error: "bad_request" }];
    const x = handleOf(sess, body.h);
    if (!x) return [200, { error: "stale" }];
    let a = null;
    try {
      a = await attested();
    } catch {}
    return write(m, sess, body, (opId, t) => {
      if (!stillOwn(x.name)) return { status: 200, body: { error: "not_yours", text: TEXTS.appNotYours(ctx.labelOf(x.name)) } };
      if (linesWaiting() >= L.linesWaiting) return { status: 429, body: { error: "too_many" } };
      const ppl = readPeople(ctx.home, { member: sess.member, owner: sess.user }).sessions;
      const e = Object.hasOwn(ppl, x.name) ? ppl[x.name] : {};
      let after;
      if (setting === "alias" && value !== null) {
        const listed = a?.attested ? a.own.map((p) => p.name) : [];
        const problem = aliasProblemIn(value, x.name, ppl, listed, ctx.display);
        if (problem) return { status: 200, body: { error: "alias", text: problem === "taken" ? TEXTS.aliasTaken : TEXTS.aliasInvalid } };
        const host = a?.attested ? a.own.find((p) => p.name === x.name && p.online)?.host : null;
        after = { alias: normalAlias(value), alias_host: typeof host === "string" && host ? host : undefined };
      } else if (setting === "alias") after = { alias: undefined, alias_host: undefined }; // removed: both go, Undo restores both
      else after = settingFields(setting, value);
      const before = Object.fromEntries(Object.keys(after).map((k2) => [k2, e[k2]]));
      const l = ctx.labels([x.name]).get(x.name);
      const text =
        setting === "fav" ? (value ? TEXTS.appSetFav(l.full) : TEXTS.appSetUnfav(l.full)) : setting === "hidden" ? (value ? TEXTS.appSetHidden(l.full) : TEXTS.appSetShown(l.full)) : value === null ? TEXTS.appSetNoAlias(l.full) : TEXTS.appSetAlias(l.plain, normalAlias(value));
      const undo = b32(10);
      return {
        status: 200,
        body: { ok: true, pending: true },
        entry: { steps: [{ t: "aline", undo, text }, { t: "prefs", op: opId, undo, name: x.name, setting, before: nul(before), after: nul(after), rev: revOf(e) }] },
        apply: () => {
          // Undo, inactive until its setting is finalised (design 7.4, section 7).
          S().targets[undo] = { kind: "undo", name: x.name, member: sess.member, pairing: sess.pairing, pending: true, msg: null, exp: t + UNDO_MS, before: nul(before), setting };
          ctx.audit("app_pref", { to: x.name, setting });
        },
      };
    });
  }

  async function draft(m, sess, body) {
    if (!only(body, ["h", "op", "text"]) || typeof body.text !== "string") return [400, { error: "bad_request" }];
    const text = body.text;
    if (!text.trim()) return [200, { error: "empty" }];
    if (text.length > APP_TEXT_MAX) return [200, { error: "too_long", text: TEXTS.tooLong(text.length, APP_TEXT_MAX) }];
    const x = handleOf(sess, body.h);
    if (!x) return [200, { error: "stale" }];
    return write(m, sess, body, (opId, t) => {
      if (!stillOwn(x.name)) return { status: 200, body: { error: "not_yours", text: TEXTS.appNotYours(ctx.labelOf(x.name)) } };
      if (openDrafts() >= L.openDrafts) return { status: 200, body: { error: "drafts", text: TEXTS.appTooManyDrafts } };
      if (!take("draft", L.draftsPerMin, sess.pairing)) return { status: 429, body: { error: "too_many" } };
      const id = b32(10);
      return {
        status: 200,
        body: { ok: true },
        entry: { steps: [{ t: "aconfirm", id }] },
        apply: () => {
          // The 2.4 held-text confirmation, pending until its message id is saved.
          S().targets[id] = { kind: "confirm", app: true, pending: true, name: x.name, member: x.member, text, pairing: sess.pairing, msg: null, exp: t + DRAFT_MS };
          ctx.audit("app_draft", { to: x.name, length: text.length, digest: crypto.createHash("sha256").update(text).digest("hex").slice(0, 16) });
        },
      };
    });
  }

  async function show(m, sess, body) {
    if (!only(body, ["n", "op"]) || !Number.isSafeInteger(body.n)) return [400, { error: "bad_request" }];
    return write(m, sess, body, () => {
      const found = Object.entries(S().questions).find(([, r]) => r.num === body.n);
      const rec = found?.[1];
      if (!rec || (rec.status !== "open" && rec.status !== "pending")) return { status: 200, body: { error: "closed", text: rec ? ctx.closedText(rec.status) : TEXTS.noLongerOpen } };
      const p = sess.pairing;
      if ((rec.shows?.[p] ?? 0) >= ctx.SHOW_PER_PAIRING) return { status: 200, body: { error: "shown", text: TEXTS.shownTooOften } };
      return {
        status: 200,
        body: { ok: true },
        entry: { steps: [{ t: "ashow", q: found[0] }] },
        apply: () => {
          rec.shows = { [p]: (rec.shows?.[p] ?? 0) + 1 };
          ctx.audit("app_show", { n: rec.num });
        },
      };
    });
  }

  // ---- requests from the tunnel -------------------------------------------------------------

  /** An app_req frame from the relay: always answered with one app_res. */
  async function onRequest(m) {
    m.received = now();
    let status = 500;
    let body = { error: "internal" };
    let mime = "application/json";
    try {
      [status, body, mime = "application/json"] = await route(m);
    } catch (e) {
      if (!(e instanceof ctx.NotLeader)) log("owner channel: app request failed:", e.message);
      [status, body] = [503, { error: "offline" }];
    }
    let text = typeof body === "string" ? body : json(body);
    // Never a frame the relay must refuse (it would close this connection): a bounded error instead.
    if (Buffer.byteLength(text) > TUNNEL_LIMITS.resBodyMax - 1024) {
      log(`owner channel: an app response was too large (${Buffer.byteLength(text)} bytes) and was not sent`);
      [status, mime, text] = [500, "application/json", json({ error: "too_large" })];
    }
    ctx.relay()?.frame({ type: "app_res", rid: m.rid, status, mime, body: text });
  }

  async function route(m) {
    const a = app();
    // The relay's forwarding proves nothing: only this bridge's app, while it is on.
    if (!a?.on || m.app !== a.id) return [404, { error: "not_found" }];
    const path = typeof m.path === "string" ? m.path : "";
    if (!path.startsWith("api/")) {
      const f = m.method === "GET" ? ctx.page?.(path) : null;
      return f ? [200, f.body, f.mime] : [404, { error: "not_found" }];
    }
    if (!ctx.leading()) return [503, { error: "offline" }];
    let body = null;
    if (m.method === "POST") {
      if (m.ctype !== "application/json") return [415, { error: "content_type" }];
      if (m.origin != null && m.origin !== origin()) return [403, { error: "origin" }];
      try {
        body = JSON.parse(m.body);
      } catch {
        return [400, { error: "bad_request" }];
      }
    }
    if (m.method === "POST" && path === "api/session") return openSession(body);
    const sess = sessionOf(m);
    if (!sess) return [401, { error: "session" }];
    if (m.method === "GET") {
      if (!take("read", L.readsPerMin, sess.pairing)) return [429, { error: "too_many" }];
      if (path === "api/sessions") return listSessions(sess);
      const pg = path.match(/^api\/sessions\/([a-z2-7]{10})\/(0|[1-9][0-9]{0,4})$/);
      if (pg) return listSessions(sess, { id: pg[1], start: Number(pg[2]) });
      const h = path.match(/^api\/session\/([a-z2-7]{10})$/);
      if (h) return oneSession(sess, h[1]);
      if (path === "api/questions") return listQuestions();
      if (path === "api/teams") return listTeamsView(sess);
      return [404, { error: "not_found" }];
    }
    if (path === "api/prefs") return prefs(m, sess, body);
    if (path === "api/draft") return draft(m, sess, body);
    if (path === "api/questions/show") return show(m, sess, body);
    return [404, { error: "not_found" }];
  }

  // ---- the app runner ---------------------------------------------------------------------------

  /** Why an app entry may not go on now: "pairing" (or member), "off", "link"; null: it may. */
  function revoked(entry) {
    const p = ctx.pairing();
    if (!p || entry.pairing !== p.id || entry.member !== ctx.ownMember()) return "pairing";
    const a = app();
    if (!a?.on) return "off";
    if (a.id !== entry.app_id) return "link";
    if (a.gen !== entry.app_gen) return "off";
    return null;
  }

  /** Run fn (sync) in the serial queue; a crash, a lost claim or a stop ends the runner. */
  async function inSerial(fn) {
    let out;
    let done = false;
    await ctx.serial(() => {
      out = fn();
      done = true;
    });
    if (!done || ctx.stopped()) throw new Stop();
    return out;
  }
  /** Mark `n` steps of `entry` done (and the entry, when it has no more), in the caller's write. */
  function advance(entry, n = 1) {
    entry.next += n;
    if (entry.next >= entry.steps.length) S().outbox = S().outbox.filter((e) => e !== entry);
    ctx.save("app-step");
  }
  /** Whether `step` is still the step `entry` is at (a reconcile may have changed the outbox). */
  const at = (entry, step) => S().outbox.includes(entry) && entry.steps[entry.next] === step;

  function kick() {
    if (running) {
      again = true;
      return;
    }
    runP = run().catch(() => {});
  }
  function later() {
    if (timer || ctx.stopped()) return;
    timer = setTimeout(() => {
      timer = null;
      kick();
    }, Math.max(L.retryMs, ctx.backoff()));
    timer.unref?.();
  }

  async function run() {
    running = true;
    try {
      do {
        again = false;
        if (!ctx.leading() || ctx.draining()) return;
        for (const entry of appEntries()) {
          if ((await runEntry(entry)) === "wait") {
            later();
            return;
          }
        }
      } while (again);
    } catch (e) {
      if (e instanceof ctx.Crash) ctx.halt("crashed", e.message);
      else if (!(e instanceof Stop) && !(e instanceof ctx.NotLeader)) log("owner channel: the app runner stopped:", e.message);
    } finally {
      running = false;
    }
  }

  async function runEntry(entry) {
    while (S().outbox.includes(entry) && entry.next < entry.steps.length) {
      if (!ctx.leading()) throw new Stop();
      const step = entry.steps[entry.next];
      const r = await runStep(entry, step);
      if (r === "wait") return "wait";
    }
    return "done";
  }

  const chatNow = () => ctx.pairing()?.chat_id ?? null;

  async function runStep(entry, step) {
    switch (step.t) {
      case "aconfirm":
        return confirmStep(entry, step);
      case "aline":
        return lineStep(entry, step);
      case "prefs":
        return prefsStep(entry, step);
      case "aedit":
        return editStep(entry, step);
      case "ashow":
        return showStep(entry, step);
      default:
        // Anything else in an app entry (a hand-made one): never run; a send is refused by sendStep's rule.
        return inSerial(() => {
          if (!at(entry, step)) return "done";
          ctx.count("app_origin");
          ctx.audit("refused", { reason: "app_origin", kind: step.kind ?? step.t });
          advance(entry);
          return "done";
        });
    }
  }

  /** A draft's confirmation in the chat: the whole text, the target's full name, Send and Cancel. */
  async function confirmStep(entry, step) {
    const pre = await inSerial(() => {
      if (!at(entry, step)) return null;
      const c = S().targets[step.id];
      if (!c || c.kind !== "confirm" || !c.pending) {
        advance(entry); // cancelled, expired or capped meanwhile
        return null;
      }
      if (revoked(entry)) {
        delete S().targets[step.id]; // not shown yet: dropped
        ctx.audit("app_draft", { dropped: revoked(entry) });
        advance(entry);
        return null;
      }
      const l = ctx.labels([c.name]).get(c.name);
      return { chat: chatNow(), text: `${TEXTS.appDraft(l.full)}\n${c.text}`, label: l.label };
    });
    if (!pre) return "done";
    const r = await ctx.tgCall("sendMessage", { chat_id: pre.chat, text: pre.text, disable_notification: true, reply_markup: { inline_keyboard: [[{ text: ctx.cleanLabel(TEXTS.confirmButton(pre.label)), callback_data: `c:${step.id}` }, { text: TEXTS.cancelButton, callback_data: `x:${step.id}` }]] } });
    if (r.wait) return "wait";
    if (r.ok) ctx.hit("app:confirm-sent");
    return inSerial(() => {
      if (!at(entry, step)) return "done";
      const c = S().targets[step.id];
      const id = r.result?.message_id;
      // Shown: it stays, also when the app was turned off meanwhile; sending still needs the tap.
      if (r.ok && c && Number.isSafeInteger(id)) {
        c.msg = id;
        delete c.pending;
      } else if (!r.ok) {
        log(`owner channel: Telegram refused an app draft's confirmation: ${r.error?.message}`);
        delete S().targets[step.id];
      }
      advance(entry);
      return "done";
    });
  }

  /** A settings change's line in the chat, with Undo (inactive until the change is finalised). */
  async function lineStep(entry, step) {
    const pre = await inSerial(() => {
      if (!at(entry, step)) return null;
      const why = revoked(entry);
      if (why) {
        // Not shown, never applied.
        delete S().targets[step.undo];
        ctx.audit("app_pref", { retired: why });
        advance(entry, entry.steps.length - entry.next);
        return null;
      }
      return { chat: chatNow() };
    });
    if (!pre) return "done";
    const r = await ctx.tgCall("sendMessage", { chat_id: pre.chat, text: step.text, disable_notification: true, reply_markup: { inline_keyboard: [[{ text: TEXTS.undoButton, callback_data: `u:${step.undo}` }]] } });
    if (r.wait) return "wait";
    if (r.ok) ctx.hit("app:line-sent");
    return inSerial(() => {
      if (!at(entry, step)) return "done";
      const id = r.result?.message_id;
      if (r.ok && Number.isSafeInteger(id)) {
        step.msg = id;
        if (S().targets[step.undo]) S().targets[step.undo].msg = id;
        advance(entry);
        return "done";
      }
      // Telegram refused the line for good: the change is never applied.
      ctx.count("app_pref_unseen");
      ctx.audit("dropped", { reason: "app_pref_unseen" });
      delete S().targets[step.undo];
      advance(entry, entry.steps.length - entry.next);
      return "done";
    });
  }

  /**
   * Apply a setting, after its line is in the chat (design 7.4, section 7, step 3). Under
   * people.json's lock: an entry whose last_op is already this op was applied before (a crash):
   * finalised. Else a revoked app, a changed revision or a broken alias rule writes nothing (every
   * such outcome throws inside the change, so people.json is not rewritten) and the line says so.
   */
  async function prefsStep(entry, step) {
    const line = entry.steps[entry.next - 1];
    ctx.hit("app:before-people");
    let what = "applied";
    let produced = null; // the revision this change produced (Undo is bound to it)
    try {
      let listed = [];
      if (step.setting === "alias" && step.after.alias) {
        try {
          const a = await ctx.ownAgents();
          listed = a.attested ? a.own.map((p) => p.name) : [];
        } catch (e) {
          if (e instanceof ctx.NotLeader) throw new Stop();
        }
      }
      let written = null;
      await updatePeople(ctx.home, { member: entry.member, owner: entry.user }, (sessions, mk) => {
        const e = Object.hasOwn(sessions, step.name) ? sessions[step.name] : null;
        if (e?.last_op === step.op) throw new Outcome("applied", revOf(e));
        // Under the lock: a stopped bridge (its home lock may be released already) writes nothing.
        if (ctx.stopped() || !ctx.leading()) throw new Stop();
        const why = revoked(entry);
        if (why) throw new Outcome(why);
        if (revOf(e) !== step.rev) throw new Outcome("changed");
        if (step.setting === "alias" && step.after.alias && aliasProblemIn(step.after.alias, step.name, sessions, listed, ctx.display)) throw new Outcome("taken");
        written = bump(Object.assign(mk(step.name), unnul(step.after)), step.op);
      }, now());
      ctx.hit("app:people-written");
      // updatePeople numbers revisions under its lock, on this same entry object: the revision written.
      produced = revOf(written);
    } catch (e) {
      if (e instanceof Outcome) {
        what = e.what;
        produced = e.rev;
      }
      else if (e instanceof PeopleFullError) what = "full";
      else if (e instanceof ctx.Crash || e instanceof Stop) throw e;
      else {
        log("owner channel: people.json could not be updated:", e.message);
        return "wait";
      }
    }
    return inSerial(() => {
      if (!at(entry, step)) return "done";
      const u = S().targets[step.undo];
      if (what === "applied") {
        // Finalisation: Undo becomes usable, bound to the revision this change produced.
        if (u) {
          Object.assign(u, { rev: produced, op: step.op });
          delete u.pending;
          // Undo buttons have their own bound (other buttons never push them out), counted over
          // applied changes only: past it, the one closest to expiry goes. Pending ones are few.
          const active = Object.entries(S().targets).filter(([, v]) => v.kind === "undo" && !v.pending);
          for (const [k] of active.sort((x, y) => x[1].exp - y[1].exp).slice(0, Math.max(0, active.length - L.undos))) delete S().targets[k];
        }
        ctx.audit("app_pref", { applied: step.setting, to: step.name });
        advance(entry);
        return "done";
      }
      delete S().targets[step.undo];
      ctx.audit("app_pref", { not_applied: what, to: step.name });
      const text = { off: TEXTS.appNotChangedOff, link: TEXTS.appNotChangedLink, changed: TEXTS.appNotChangedAgain, taken: TEXTS.appNotChangedTaken, full: TEXTS.appNotChangedFull }[what];
      // A line in an earlier pairing's chat is left alone (its Telegram steps are retired).
      if (text && Number.isSafeInteger(line?.msg)) entry.steps = [...entry.steps.slice(0, entry.next + 1), { t: "aedit", msg: line.msg, text }];
      advance(entry);
      return "done";
    });
  }

  /** An edit of an app line (why it did not change), without buttons. */
  async function editStep(entry, step) {
    const pre = await inSerial(() => {
      if (!at(entry, step)) return null;
      const p = ctx.pairing();
      if (!p || p.id !== entry.pairing) {
        advance(entry);
        return null;
      }
      return { chat: p.chat_id };
    });
    if (!pre) return "done";
    const r = await ctx.tgCall("editMessageText", { chat_id: pre.chat, message_id: step.msg, text: step.text });
    if (r.wait) return "wait";
    return inSerial(() => {
      if (at(entry, step)) advance(entry);
      return "done";
    });
  }

  /** Another copy of a question's card (the 7.3 Show path), from the app. */
  async function showStep(entry, step) {
    // Names first. The send is started inside the same serial step as the checks, so nothing
    // queued after them (an /app off) can come between the checks and the send.
    await ctx.refreshNames().catch(() => {});
    const pre = await inSerial(() => {
      if (!at(entry, step)) return null;
      const rec = S().questions[step.q];
      // Closed meanwhile, or the app revoked (off, a new link, a new pairing): not sent.
      if (!rec || (rec.status !== "open" && rec.status !== "pending") || !rec.payload || revoked(entry)) {
        advance(entry);
        return null;
      }
      const resent = ctx.cardBegin(step, rec);
      const { text, markup } = ctx.cardRender(rec, step, resent);
      const chat = chatNow();
      const send = ctx.tgCall("sendMessage", { chat_id: chat, text, reply_markup: markup, disable_notification: true });
      send.catch(() => {}); // awaited below; a stop in between must not leave it unhandled
      return { send, resent, chat, p: ctx.pid() };
    });
    if (!pre) return "done";
    ctx.hit("app:show-checked");
    const r = await pre.send;
    if (r.wait) {
      if (!pre.resent && Number.isInteger(r.error?.status)) step.attempted = false;
      return "wait";
    }
    return inSerial(() => {
      if (!at(entry, step)) return "done";
      const rec = S().questions[step.q];
      // A copy made under an earlier pairing is not recorded (its buttons answer nothing there).
      if (rec && r.ok && ctx.pid() === pre.p) {
        // A question closed meanwhile stays closed: cardDone edits this copy to its closed view.
        const { over, apply } = ctx.cardDone(step, rec, r.result?.message_id, pre.chat, pre.p);
        // Past the cap the oldest copy loses its buttons: a cleanup of the bot's own outbox.
        if (over) ctx.admit({ kind: "q", q: step.q, steps: [{ t: "editcopy", q: step.q, chat: over.chat, id: over.id, text: TEXTS.olderCopy }], next: 0 });
        apply();
        ctx.kick();
      } else if (!rec && r.ok && Number.isSafeInteger(r.result?.message_id)) {
        // Its record is gone meanwhile: the copy loses its buttons.
        ctx.admit({ kind: "q", q: step.q, steps: [{ t: "editcopy", q: step.q, chat: pre.chat, id: r.result.message_id, text: TEXTS.noLongerOpen }], next: 0 });
        ctx.kick();
      } else if (!r.ok) log(`owner channel: Telegram refused a copy of a card from the app: ${r.error?.message}`);
      advance(entry);
      return "done";
    });
  }

  // ---- turning the app off from the chat ----------------------------------------------------

  /** /app off from the paired owner: in the update's own write (`apply`); every session ends. */
  function offPlan() {
    const a = app();
    if (!a?.on) return null;
    return () => {
      a.on = false;
      a.gen = (a.gen ?? 0) + 1;
      a.off = [...new Set([...(a.off ?? []), a.id])];
      registered = false;
      endAll("off");
      ctx.audit("app", { on: false, by: "chat" });
      // The relay is told now, best effort; the id stays in `off` until it confirms.
      Promise.resolve().then(() => register());
    };
  }

  return {
    onRequest,
    register,
    button,
    available,
    served,
    offPlan,
    endAll,
    kick,
    on,
    /** Stops retrying; resolves once the runner's work in flight has settled. */
    stop() {
      clearTimeout(timer);
      timer = null;
      return running ? runP : Promise.resolve();
    },
    /** Tests: the live sessions. */
    sessionCount: () => sessions.size,
  };
}
