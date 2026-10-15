// The relay's side of the owner channel's Mini App (design 7.4, sections 2, 3 and 6): the relay
// serves `/app/<app id>/<path>` on its own HTTP port by forwarding each request, over the bridge's
// existing WebSocket, to the bridge that registered that app id. The bridge answers with the page
// files and the API; the relay sets every response header itself. Off unless the relay is started
// with HOPTELL_OWNER_APP=on (capability "owner_app").
//
// App ids are owned for good: the first registration binds an id to a member and a bridge name in
// apps.json (the relay's state directory, 0600), and only a connection of that member holding that
// name may register it again, also after a disconnect or a relay restart. Entries are never dropped
// by the relay on its own: `off` and `retired` ids stay as tombstones that answer 404, and only the
// operator's `hoptell relay apps --purge` deletes one (which frees its URL for anyone).
//
// What passes through: the method, a canonical path, the request's Content-Type, Authorization and
// Origin, the client address (through the relay's trusted proxies), the time left and, for a POST,
// a JSON body of at most 16 KB. No other header and no cookie. The relay's log names the app id's
// first characters, the status and the duration, never a body or the Authorization header.
import crypto from "node:crypto";
import path from "node:path";
import { readPrivateJson, writePrivateJson } from "./ownersig.js";

export const OWNER_APP_CAP = "owner_app";
export const APP_ID_RE = /^[a-z2-7]{26}$/;
const SEGMENT = "[a-z0-9][a-z0-9_-]*(?:\\.[a-z0-9_-]+)*";
/** A path inside an app: empty, or segments of SEGMENT joined by single "/" (design 7.4, 3). */
export const APP_PATH_RE = new RegExp(`^(?:${SEGMENT}(?:/${SEGMENT})*)?$`);
export const APP_PATH_MAX = 128;
export const APP_MIMES = new Set(["text/html", "text/css", "text/javascript", "application/json"]);
/** A hashed page file (app.<16 hex>.js): cached for good; everything else is never cached. */
const HASHED_RE = /^[a-z]+\.[0-9a-f]{16}\.(?:js|css)$/;

export const APP_LIMITS = {
  bodyMax: 16 * 1024, // a POST body
  resBodyMax: 256 * 1024, // a response body (UTF-8 bytes)
  resFrameMax: 300 * 1024, // the whole app_res frame
  timeoutMs: 10_000, // the bridge's answer
  perApp: 8, // open requests per app id
  total: 64, // open requests in all
  perClient: { max: 60, ms: 60_000 }, // requests per client address
  sessionPerClient: { max: 10, ms: 60_000 }, // POST api/session per client address
  idsPerMember: 10, // ids that are on or off (retired ones are not counted)
  newIdsPerDay: 10, // new ids a member may register in 24 hours (rotations)
  entriesMax: 20_000, // apps.json entries, tombstones included: a new id past it is refused, nothing is pruned
  clientsMax: 10_000, // client addresses with live rate counters; a new one past it is refused (429)
};
/** apps.json is read up to this size; a write that would pass it is refused, so the file always reads back. */
export const APPS_FILE_MAX = 16 * 1024 * 1024;

/** The response headers of every /app/ answer: a fixed set, whatever the bridge sends (section 6). */
export function appHeaders(appPath, mime, length, status = 200) {
  return {
    "content-type": `${mime}; charset=utf-8`,
    "content-length": String(length),
    "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors https://web.telegram.org",
    // Only a successful hashed file is kept: an error (offline, busy, slow) must never be cached.
    "cache-control": status === 200 && HASHED_RE.test(appPath) ? "max-age=31536000, immutable" : "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "cross-origin-opener-policy": "same-origin",
  };
}

// ---- apps.json: the durable owners of app ids -----------------------------------------------------

export const appsFile = (stateDir) => path.join(stateDir, "apps.json");

/** apps.json as {v: 1, apps: {id: {member, name, state, registered}}}; missing: empty. */
export function readApps(stateDir) {
  const doc = readPrivateJson(appsFile(stateDir), APPS_FILE_MAX);
  if (!doc) return { v: 1, apps: {} };
  if (doc.v !== 1 || !doc.apps || typeof doc.apps !== "object" || Array.isArray(doc.apps)) throw new Error(`${appsFile(stateDir)} is malformed`);
  const apps = Object.create(null);
  for (const [id, e] of Object.entries(doc.apps)) if (APP_ID_RE.test(id) && e && typeof e === "object" && ["on", "off", "retired"].includes(e.state)) apps[id] = e;
  return { v: 1, apps };
}
function writeApps(stateDir, doc) {
  if (Buffer.byteLength(JSON.stringify(doc)) + 1 > APPS_FILE_MAX) throw Object.assign(new Error("apps.json would be too large"), { code: "app_limit" });
  writePrivateJson(appsFile(stateDir), doc);
}
const tombstone = (e) => ({ member: e.member, name: e.name, state: "retired", registered: e.registered, ...(e.first ? { first: e.first } : {}) });

/** The one entry whose id starts with `prefix` (at least 4 characters), or an error text. */
function byPrefix(doc, prefix) {
  if (typeof prefix !== "string" || !/^[a-z2-7]{4,26}$/.test(prefix)) return { error: "give at least the first 4 characters of an app id" };
  const hits = Object.keys(doc.apps).filter((id) => id.startsWith(prefix));
  if (!hits.length) return { error: `no app id starts with ${prefix}` };
  if (hits.length > 1) return { error: `${hits.length} app ids start with ${prefix}; give more characters` };
  return { id: hits[0] };
}

/**
 * The operator's commands on apps.json, with the relay stopped (the caller holds the state lock):
 * list, retire (a tombstone: answers 404, never registrable again) and purge (deletes the entry,
 * which frees the URL for anyone).
 */
export const appsAdmin = {
  list: (stateDir) => Object.entries(readApps(stateDir).apps).map(([id, e]) => ({ id, ...e })),
  retire(stateDir, prefix) {
    const doc = readApps(stateDir);
    const r = byPrefix(doc, prefix);
    if (r.error) throw new Error(r.error);
    const e = doc.apps[r.id];
    doc.apps[r.id] = tombstone(e);
    writeApps(stateDir, doc);
    return r.id;
  },
  purge(stateDir, prefix) {
    const doc = readApps(stateDir);
    const r = byPrefix(doc, prefix);
    if (r.error) throw new Error(r.error);
    delete doc.apps[r.id];
    writeApps(stateDir, doc);
    return r.id;
  },
};

// ---- the tunnel -------------------------------------------------------------------------------

const json = (o) => JSON.stringify(o);
const ID_LIST_MAX = 20;
const idList = (list) => list === undefined || (Array.isArray(list) && list.length <= ID_LIST_MAX && list.every((id) => typeof id === "string" && APP_ID_RE.test(id)));

/**
 * The tunnel of one relay. `stateDir`: where apps.json lives; `audit(action, detail)`: the relay's
 * security events; `limits`: other values for APP_LIMITS (tests).
 */
export function createAppTunnel({ stateDir, audit = () => {}, log = () => {}, limits = null, now = () => Date.now() }) {
  const L = { ...APP_LIMITS, ...(limits ?? {}) };
  let doc = readApps(stateDir); // throws on a damaged file: the relay does not start
  const live = new Map(); // app id -> {ws, gen, holds}: the connection serving it while it may
  const open = new Map(); // rid -> {app, ws, gen, res, timer, path, started, method}
  const slots = new Map(); // app id -> requests admitted (reading their body, or forwarded)
  let admitted = 0; // in all
  const rates = new Map(); // "a:<client>" / "s:<client>" -> [times]
  let swept = 0;
  let gens = 0;
  const counts = { appRequests: 0, appRefused: 0, appIgnored: 0 };

  /** A change of apps.json: made on a copy, and in force only once it is written. */
  function commit(next) {
    writeApps(stateDir, next);
    doc = next;
  }

  /**
   * An app_register frame from a logged-in connection: {app, state?, retire?: [ids], off?: [ids]}.
   * Accepted only from a peer connection signed in with a member token (not the shared token, not
   * hosted custody) that holds its name now, under the durable ownership rule. `retire` and `off`
   * name this owner's earlier ids (a rotation, or ids turned off while the bridge was stopped): each
   * becomes a tombstone or off; ids of another owner are ignored. All or nothing: a malformed list
   * changes nothing.
   */
  function register(ws, m, { holds }) {
    if (!ws.cred?.member || !ws.cred.memberId || ws.custody || !holds()) return { error: "not_allowed", text: "only a bridge signed in with a member token and holding its name can serve an app" };
    if (typeof m.app !== "string" || !APP_ID_RE.test(m.app) || !idList(m.retire) || !idList(m.off) || (m.state !== undefined && m.state !== "off")) return { error: "bad_request", text: "bad app_register" };
    const member = ws.cred.memberId;
    const name = ws.peerName;
    const mine = (e) => e && e.member === member && e.name === name;
    const next = { v: 1, apps: { ...doc.apps } };
    const ended = [];
    for (const [list, to] of [
      [m.retire ?? [], "retired"],
      [m.off ?? [], "off"],
    ]) {
      for (const id of list) {
        const e = next.apps[id];
        if (id === m.app || !mine(e) || e.state === "retired" || e.state === to) continue;
        next.apps[id] = to === "retired" ? tombstone(e) : { ...e, state: "off" };
        ended.push(id);
      }
    }
    const e = next.apps[m.app];
    const t = now();
    let refusal = null;
    if (e && (!mine(e) || e.state === "retired")) {
      audit("relay.app_id_taken", { member, app: m.app.slice(0, 6) });
      log(`app: registration of ${m.app.slice(0, 6)}… refused (app_id_taken)`);
      refusal = { error: "app_id_taken", text: "this app id belongs to another bridge" };
    } else if (e) {
      next.apps[m.app] = m.state === "off" ? { ...e, state: "off" } : { ...e, state: "on", registered: t };
    } else {
      const entries = Object.values(next.apps);
      if (entries.filter((x) => x.member === member && x.state !== "retired").length >= L.idsPerMember) refusal = { error: "app_limit", text: `a member may have at most ${L.idsPerMember} app ids` };
      else if (entries.filter((x) => x.member === member && t - (Number(x.first) || 0) < 86400_000).length >= L.newIdsPerDay) refusal = { error: "app_limit", text: `a member may register at most ${L.newIdsPerDay} new app ids a day` };
      else if (entries.length >= L.entriesMax) refusal = { error: "app_limit", text: "this relay has no room for more app ids" };
      else next.apps[m.app] = { member, name, state: m.state === "off" ? "off" : "on", registered: t, first: t };
    }
    try {
      commit(next); // the retire and off lists apply also when the id itself is refused
    } catch (err) {
      log(`app: apps.json could not be written: ${err.message}`);
      return { error: "app_limit", text: "the relay could not record this app id" };
    }
    for (const id of ended) unbind(id);
    if (refusal) return refusal;
    unbind(m.app);
    if (doc.apps[m.app].state === "on") live.set(m.app, { ws, gen: ++gens, holds });
    return { ok: true, state: doc.apps[m.app].state };
  }

  /** The live binding of `id` ends; its open requests answer 503 at once. */
  function unbind(id) {
    if (!live.has(id)) return;
    live.delete(id);
    for (const [rid, r] of open) if (r.app === id) finish(rid, 503, "application/json", json({ error: "offline" }));
  }

  /** A connection closed, gave its name back, was handed off or revoked: every binding it held ends. */
  function closed(ws) {
    for (const [id, b] of [...live]) if (b.ws === ws) unbind(id);
  }

  /** The binding of `id`, if its connection still holds the bridge's name; else it ends now. */
  function current(id) {
    const b = live.get(id);
    if (!b) return null;
    if (b.ws.readyState !== 1 || !b.holds()) {
      unbind(id);
      return null;
    }
    return b;
  }

  const release = (id) => {
    admitted--;
    slots.set(id, (slots.get(id) ?? 1) - 1);
    if (!slots.get(id)) slots.delete(id);
  };

  function finish(rid, status, mime, body) {
    const r = open.get(rid);
    if (!r) return;
    open.delete(rid);
    clearTimeout(r.timer);
    release(r.app);
    reply(r.res, status, r.path, mime, body);
    log(`app ${r.app.slice(0, 6)}… ${r.method} ${status} ${now() - r.started}ms`);
  }

  function reply(res, status, appPath, mime, body) {
    if (res.headersSent || res.destroyed) return;
    const buf = Buffer.from(body, "utf8");
    res.writeHead(status, appHeaders(appPath, mime, buf.length, status)).end(buf);
  }
  const plain = (res, status, appPath, error) => reply(res, status, appPath, "application/json", json({ error }));

  /** Whether one more request under `key` fits `limit` now (counted when it does). */
  function allow(key, limit) {
    const t = now();
    if (t - swept > 60_000) {
      // Counters of addresses that went quiet go; a live counter is never dropped early.
      swept = t;
      for (const [k, xs] of rates) if (!xs.length || t - xs.at(-1) >= Math.max(L.perClient.ms, L.sessionPerClient.ms)) rates.delete(k);
    }
    const xs = (rates.get(key) ?? []).filter((x) => t - x < limit.ms);
    if (!rates.has(key) && rates.size >= L.clientsMax) return false;
    if (xs.length >= limit.max) {
      rates.set(key, xs);
      return false;
    }
    xs.push(t);
    rates.set(key, xs);
    return true;
  }

  /** An app_res frame (`size`: the frame's bytes) from `ws`: accepted once, from the connection and generation its rid went to, while it holds the name. */
  function response(ws, m, size) {
    const r = typeof m.rid === "string" ? open.get(m.rid) : null;
    const b = r ? current(r.app) : null;
    if (!r || !b || b.ws !== ws || b.gen !== r.gen || r.ws !== ws) {
      counts.appIgnored++;
      return;
    }
    const okStatus = Number.isInteger(m.status) && m.status >= 200 && m.status <= 599;
    if (!okStatus || !APP_MIMES.has(m.mime) || typeof m.body !== "string" || size > L.resFrameMax || Buffer.byteLength(m.body, "utf8") > L.resBodyMax) {
      counts.appRefused++;
      return finish(m.rid, 502, "application/json", json({ error: "bad_gateway" }));
    }
    finish(m.rid, m.status, m.mime, m.body);
  }

  const handles = (url) => typeof url === "string" && (url === "/app" || url.startsWith("/app/") || url.startsWith("/app?"));

  /**
   * An HTTP request for /app/…; `client`: its address through the trusted proxies. Its slot (8 per
   * app, 64 in all) and its 10-second deadline start here, before its body is read: a slow or
   * unfinished body holds one slot until the deadline, never more.
   */
  function handle(req, res, client) {
    counts.appRequests++;
    const url = String(req.url).split("?")[0]; // the query string is never forwarded
    const m = url.match(/^\/app\/([^/]*)(?:\/(.*))?$/);
    const appPath = m?.[2] ?? "";
    if (!m || m[2] === undefined || !APP_ID_RE.test(m[1])) return plain(res, 404, "", "not_found");
    const id = m[1];
    if (appPath.length > APP_PATH_MAX || !APP_PATH_RE.test(appPath)) return plain(res, 404, "", "not_found");
    const e = doc.apps[id];
    if (!e || e.state !== "on") return plain(res, 404, "", "not_found");
    if (req.method !== "GET" && req.method !== "POST") return plain(res, 405, appPath, "method");
    const api = appPath.startsWith("api/");
    if (req.method === "POST" && !api) return plain(res, 405, appPath, "method");
    if (!allow(`a:${client}`, L.perClient)) return plain(res, 429, appPath, "too_many");
    if (req.method === "POST" && appPath === "api/session" && !allow(`s:${client}`, L.sessionPerClient)) return plain(res, 429, appPath, "too_many");
    const ctype = typeof req.headers["content-type"] === "string" ? req.headers["content-type"] : null;
    if (req.method === "POST" && ctype !== "application/json") return plain(res, 415, appPath, "content_type");
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > L.bodyMax) return plain(res, 413, appPath, "too_large");
    if (!current(id)) return plain(res, 503, appPath, "offline");
    if ((slots.get(id) ?? 0) >= L.perApp || admitted >= L.total) return plain(res, 503, appPath, "busy");
    // Admitted: a slot and a deadline from now on.
    admitted++;
    slots.set(id, (slots.get(id) ?? 0) + 1);
    const started = now();
    const rid = crypto.randomBytes(16).toString("base64url");
    const r = { app: id, ws: null, gen: null, res, timer: null, path: appPath, started, method: req.method };
    open.set(rid, r);
    r.timer = setTimeout(() => {
      finish(rid, 504, "application/json", json({ error: "slow" }));
      req.destroy();
    }, L.timeoutMs);
    r.timer.unref?.();
    // The client went away (or its body broke off): the slot is freed; a late answer is ignored.
    res.on("close", () => {
      if (!open.has(rid)) return;
      open.delete(rid);
      clearTimeout(r.timer);
      release(id);
    });
    const chunks = [];
    let n = 0;
    req.on("data", (c) => {
      if (!open.has(rid)) return;
      n += c.length;
      if (n > L.bodyMax) {
        finish(rid, 413, "application/json", json({ error: "too_large" }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("error", () => {});
    req.on("end", () => {
      if (!open.has(rid)) return;
      forward(rid, req, ctype, client, req.method === "POST" ? Buffer.concat(chunks).toString("utf8") : "");
    });
  }

  function forward(rid, req, ctype, client, body) {
    const r = open.get(rid);
    const b = doc.apps[r.app]?.state === "on" ? current(r.app) : null;
    if (!b) return finish(rid, doc.apps[r.app]?.state === "on" ? 503 : 404, "application/json", json({ error: doc.apps[r.app]?.state === "on" ? "offline" : "not_found" }));
    Object.assign(r, { ws: b.ws, gen: b.gen });
    const header = (h) => (typeof req.headers[h] === "string" ? req.headers[h] : null);
    const frame = { type: "app_req", rid, app: r.app, method: req.method, path: r.path, ctype, origin: header("origin"), client, auth: header("authorization"), ttl_ms: Math.max(0, L.timeoutMs - (now() - r.started)), body };
    try {
      b.ws.send(json(frame));
    } catch {
      finish(rid, 503, "application/json", json({ error: "offline" }));
    }
  }

  /** An app_unregister frame: {app}; the owner turns its id off (it answers 404 from now on). */
  function unregister(ws, m, { holds }) {
    if (!ws.cred?.member || ws.custody || !holds() || typeof m.app !== "string") return { error: "not_allowed", text: "not allowed" };
    const e = doc.apps[m.app];
    if (!e || e.member !== ws.cred.memberId || e.name !== ws.peerName) return { error: "not_allowed", text: "not this bridge's app id" };
    if (e.state === "on") {
      try {
        commit({ v: 1, apps: { ...doc.apps, [m.app]: { ...e, state: "off" } } });
      } catch (err) {
        log(`app: apps.json could not be written: ${err.message}`);
        return { error: "app_limit", text: "the relay could not record this change" };
      }
    }
    unbind(m.app);
    return { ok: true, state: doc.apps[m.app].state };
  }

  return {
    handles,
    handle,
    register,
    unregister,
    response,
    closed,
    stats: () => ({ ...counts, appOpen: open.size, appLive: live.size }),
    close() {
      for (const rid of [...open.keys()]) finish(rid, 503, "application/json", json({ error: "offline" }));
    },
  };
}

/** Whether the relay's owner app is switched on (HOPTELL_OWNER_APP). */
export const ownerAppEnabled = (v) => /^(1|true|on|yes)$/i.test(String(v ?? ""));
