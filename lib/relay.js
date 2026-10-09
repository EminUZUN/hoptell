// hoptell relay: a small WebSocket hub that routes plain-text messages between
// agent sessions on different machines.
//
// Protocol v1 (JSON text frames):
//   client -> relay  {type:"hello", v:1, name, token, host, mode:"peer"|"send", roles:[...]}
//                    {type:"send", id, to, text, ttl?, reply_to?, op?} to: a peer name, "@<role>" or "@all";
//                    op (protocol 2): an operation id; a repeated op returns the first outcome
//                    ttl: seconds a queued message may wait before the relay drops it;
//                    reply_to: the message_id this message answers (a reference only)
//                    {type:"list", id}
//                    {type:"got", id}                  receiver confirms a message
//   relay  -> client {type:"welcome", name, auth?}
//                    auth: "shared" (one token for every name), "members" (per-member tokens
//                    only) or "mixed" (both: a shared-token holder may use any member's name)
//                    {type:"error", id?, error}
//                    {type:"ack", id, state:"delivered"|"queued"|"unconfirmed"|"fanout", count?, skipped?, message_id?, expires?}
//                    message_id: the reference of the accepted send (relays without references omit it);
//                    expires: set when the relay accepted the ttl (relays without expiry omit it)
//                    {type:"peers", id, peers:[{name, host, roles, online, queued}]}
//                    {type:"message", id, message_id?, reply_to?, from, fromHost, to, text, ts, expires?, noReply?}
//                    id: this delivery (one per recipient, used by "got"); message_id: the send it
//                    belongs to, shared by every fan-out copy
//                    expires: ms timestamp after which the relay no longer delivers it
//                    noReply: true when, at send time, a send-only sender had no peer
//                    of that name to reply to (a plain `hoptell send` from a shell);
//                    advisory: the name may register later
//
// mode "peer" registers the name as online and receives messages; a newer peer
// connection with the same name replaces the older one. mode "send" can only
// send and list (used by `hoptell send`), so it never evicts the agent itself.
//
// Auth: one shared token (any name), and/or a members list where each member has
// its own token and may only use the name "<member>" or names starting "<member>-".
import crypto from "node:crypto";
import http from "node:http";
import net from "node:net";
import { WebSocketServer } from "ws";
import { ClaimTable, principalKey } from "./claims.js";
import { FORMAT, checkFingerprint, fingerprintSuffix } from "./fingerprint.js";
import { MAX_ROLES, MAX_TTL_S, NAME_RE, REF_RE } from "./config.js";

export const MAX_TEXT = 100_000;
const MAX_QUEUE_PER_PEER = 50;
const MAX_INFLIGHT_PER_PEER = 50; // unconfirmed messages per receiver; more wait in its queue
const MAX_QUEUED_TOTAL = 2000;
const RATE_WINDOW_MS = 10_000;
const RATE_MAX = 30;
const ACK_TIMEOUT_MS = 5000;
const FORGET_AFTER_MS = 6 * 3600_000;
const HOST_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;

const digest = (s) => crypto.createHash("sha256").update(String(s)).digest();
const TOKEN_HELP = "generate one with: openssl rand -hex 32";

export function checkToken(token, what = "HOPTELL_TOKEN") {
  if (token != null && typeof token !== "string") throw new Error(`${what} must be a string`);
  if (/^sha256:/i.test(token || "")) {
    if (/^sha256:[0-9a-f]{64}$/i.test(token)) return;
    throw new Error(`${what} starts with "sha256:" but is not followed by 64 hex digits (the SHA-256 of the secret)`);
  }
  if (!token || token.length < 16 || /^replace|change-?me/i.test(token)) {
    throw new Error(`${what} is missing, a placeholder, or shorter than 16 characters; ${TOKEN_HELP}`);
  }
}

/** A stored token is either the secret itself or "sha256:<hex of the secret>". */
const storedDigest = (t) => (/^sha256:/i.test(t) ? Buffer.from(t.slice(7), "hex") : digest(t));

/** Generated member ids: "m_" + 26 base32 characters (130 random bits). */
export const MEMBER_ID_RE = /^m_[a-z2-7]{26}$/;
export function newMemberId() {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  return `m_${[...crypto.randomBytes(26)].map((b) => alphabet[b & 31]).join("")}`;
}

/**
 * Validated credentials for a shared token and/or a members list. Throws on any problem.
 * At startup at least one credential is required; a reload may remove every member.
 * Each member has an immutable id: its explicit `id`, or the tagged legacy id "name:<name>"
 * (which cannot collide with generated ids). With `requireMembers`, a shared token is refused.
 */
function buildCredentials(token, members, { allowNone = false, requireMembers = false } = {}) {
  if (!allowNone && !token && !members?.length) throw new Error(`set HOPTELL_TOKEN (shared secret) or HOPTELL_MEMBERS (per-member tokens); ${TOKEN_HELP}`);
  if (requireMembers && token) throw new Error("--require-members is set, so a shared HOPTELL_TOKEN is not allowed; remove it and use per-member tokens");
  const credentials = [];
  if (token) {
    checkToken(token);
    credentials.push({ member: null, memberId: null, digest: storedDigest(token) });
  }
  const links = new Set();
  for (const m of members || []) {
    if (!NAME_RE.test(m?.name || "")) throw new Error(`members: invalid member name "${m?.name}"`);
    // A member signs in with its token, with linked identity-provider identities (design 1.6), or both.
    const oidc = m.oidc ?? [];
    if (!Array.isArray(oidc) || !oidc.every((l) => typeof l?.issuer === "string" && /^https?:\/\//.test(l.issuer) && typeof l.subject === "string" && l.subject && l.subject.length <= 255)) {
      throw new Error(`members: oidc of "${m.name}" must be a list of {"issuer": <URL>, "subject": <subject>}`);
    }
    for (const l of oidc) {
      const k = `${l.issuer}|${l.subject}`; // issuers are exact identifiers
      if (links.has(k)) throw new Error(`members: the identity ${l.subject} at ${l.issuer} is linked to two members`);
      links.add(k);
    }
    if (m.token !== undefined || !oidc.length) checkToken(m.token, `token of member "${m.name}"`);
    if (m.id !== undefined && (typeof m.id !== "string" || !MEMBER_ID_RE.test(m.id))) throw new Error(`members: invalid id for "${m.name}": use an id from "hoptell members add" (m_ followed by 26 letters a-z or digits 2-7)`);
    const memberId = m.id ?? `name:${m.name}`;
    // Name spaces must not overlap: with "alice" and "alice-bob", alice could use "alice-bob-x".
    const clash = credentials.find((c) => c.member && (c.member === m.name || m.name.startsWith(`${c.member}-`) || c.member.startsWith(`${m.name}-`)));
    if (clash) throw new Error(`members: "${m.name}" overlaps "${clash.member}"; member names must not equal or extend each other with "-"`);
    if (credentials.some((c) => c.memberId === memberId)) throw new Error(`members: the id of "${m.name}" is used twice`);
    const d = m.token === undefined ? null : storedDigest(m.token);
    // One token per credential: otherwise a login would depend on list order.
    const same = d && credentials.find((c) => c.digest && c.digest.length === d.length && crypto.timingSafeEqual(c.digest, d));
    if (same) throw new Error(`members: the token of "${m.name}" is also used by ${same.member ? `"${same.member}"` : "the shared token"}; every credential needs its own token`);
    // `hoptell members signout <name>` (design 1.7): broker sign-ins made before this time end.
    if (m.signedOutAt !== undefined && !(Number.isSafeInteger(m.signedOutAt) && m.signedOutAt > 0)) throw new Error(`members: signedOutAt of "${m.name}" must be a time in milliseconds`);
    credentials.push({ member: m.name, memberId, digest: d, oidc: oidc.map((l) => ({ issuer: l.issuer, subject: l.subject })), ...(m.signedOutAt ? { signedOutAt: m.signedOutAt } : {}) });
  }
  return credentials;
}

/** Check a members list with the relay's rules (for `hoptell members`); throws on any problem. */
export const validateMembers = (members) => void buildCredentials(null, members, { allowNone: true });

const nameAllowed = (cred, name) => !cred.member || name === cred.member || name.startsWith(`${cred.member}-`);

/**
 * Parse a list of trusted proxy addresses or CIDR ranges ("10.0.0.1, 10.1.0.0/16, ::1"), as
 * accepted by --trusted-proxies. Throws on anything else, so a typo cannot trust everyone.
 */
export function parseTrustedProxies(value) {
  const list = new net.BlockList();
  const entries = String(value ?? "").split(",").map((e) => e.trim()).filter(Boolean);
  for (const e of entries) {
    const [ip, bits, extra] = e.split("/");
    const family = net.isIP(ip);
    if (!family || extra !== undefined) throw new Error(`invalid trusted proxy "${e}": use an IP address or CIDR range`);
    const type = family === 6 ? "ipv6" : "ipv4";
    if (bits === undefined) list.addAddress(ip, type);
    else {
      const n = Number(bits);
      if (!/^\d+$/.test(bits) || n > (family === 6 ? 128 : 32)) throw new Error(`invalid trusted proxy "${e}": bad prefix length`);
      list.addSubnet(ip, n, type);
    }
  }
  return entries.length ? list : null;
}

/** Protocol 2 capabilities (all or nothing: a relay that speaks protocol 2 has every one). */
const CAPS = ["auth", "realm", "member", "auto-name", "lease", "claim-status", "sender", "idempotent-send"];
const OP_RE = /^o_[a-z2-7]{26}$/;
const OP_TTL_MS = 10 * 60_000; // an accepted operation is remembered this long (retries stop after 5 min)
const OPS_PER_PRINCIPAL = 1000;
/** Fixed close reasons (WebSocket reasons are limited to 123 bytes and shown to old clients). */
const CLOSE_REASONS = {
  name_in_use: "name in use by another session",
  reserved: "name reserved for a reconnecting session",
  superseded: "superseded by a newer connection of the same session",
  lease_unknown: "unknown or expired session lease",
  relay_restarted: "relay restarted; claim the name again",
  not_allowed: "not allowed to replace this name",
  bad_claim: "bad claim",
};
const MAX_FORWARDED_BYTES = 2048;
const MAX_FORWARDED_HOPS = 20;
const plainIp = (a) => (typeof a === "string" && a.startsWith("::ffff:") && net.isIPv4(a.slice(7)) ? a.slice(7) : a);
const isTrusted = (list, a) => Boolean(list && net.isIP(a) && list.check(a, net.isIPv6(a) ? "ipv6" : "ipv4"));

/**
 * The client address for a connection. X-Forwarded-For is used only when the socket peer is a
 * trusted proxy: walk it from the right past trusted proxies; the first other address is the
 * client. Bounded; malformed values fall back to the socket address. Never an identity.
 */
export function clientAddress(req, trusted) {
  const socket = plainIp(req.socket.remoteAddress);
  if (!isTrusted(trusted, socket)) return { socket, client: socket };
  const raw = req.headers["x-forwarded-for"];
  const header = Array.isArray(raw) ? raw.join(",") : raw || "";
  // An overlong header or chain is not interpreted at all: any cut could drop the real hop.
  if (header.length > MAX_FORWARDED_BYTES) return { socket, client: socket };
  const hops = header.split(",").map((h) => plainIp(h.trim()));
  if (hops.length > MAX_FORWARDED_HOPS) return { socket, client: socket };
  for (let i = hops.length - 1; i >= 0; i--) {
    if (!net.isIP(hops[i])) return { socket, client: socket };
    if (!isTrusted(trusted, hops[i])) return { socket, client: hops[i] };
  }
  return { socket, client: hops[0] && net.isIP(hops[0]) ? hops[0] : socket };
}

/**
 * Start a relay. Resolves to {port, close(), reload(members)} once listening.
 * reload() swaps in a new members list (the shared token stays) and disconnects
 * every connection whose token or name the new list no longer allows.
 * @param {{host: string, port: number, token?: string, members?: {name: string, token: string}[], log?: Function}} opts
 */
export function startRelay({ host, port, token, members = null, requireMembers = false, realm = null, sweepMs = 15000, fingerprint = null, trustedProxies = null, opsPerPrincipal = OPS_PER_PRINCIPAL, oidc = null, log = (...a) => console.log(new Date().toISOString(), ...a) }) {
  if (!host) throw new Error("relay host is required: pass --host <LAN-or-VPN-IP> (or 0.0.0.0 for every interface)");
  let credentials = buildCredentials(token, members, { requireMembers });
  // A relay started without a stored realm (tests, embedding) gets a fresh one per start.
  const realmInfo = { id: realm?.id ?? crypto.randomBytes(16).toString("hex"), ...(realm?.name ? { name: realm.name } : {}) };
  // Opt-in keyed fingerprints: computed per log event from the text held at that moment, and
  // kept out of message objects (they are spread into frames sent to clients).
  const fp = checkFingerprint(fingerprint);
  const tag = (msg) => (fp ? [fingerprintSuffix(fp, msg.message_id, msg.text)] : []);
  const logQueued = (to, msg) => fp && log("queued", `ref ${msg.message_id} delivery ${msg.id}`, "for", to, ...tag(msg));

  /** How names are authenticated, reported to clients so they can tell how far to trust them. */
  const authMode = () => {
    const shared = credentials.some((c) => !c.member);
    const members = credentials.some((c) => c.member);
    return shared && members ? "mixed" : members ? "members" : "shared";
  };

  // Sign-in with an identity provider (design 1.6): {verifier, config, discovery} from lib/oidc.js;
  // broker mode (design 1.7): `broker` from lib/broker.js, attached to this relay's members and
  // connections.
  const verifier = oidc?.verifier ?? null;
  const broker = oidc?.broker ?? null;


  /**
   * A signed-in connection stays valid until its deadline (the token's expiry plus the one clock
   * skew); introspected tokens are checked again within maxRevocationDelaySeconds.
   */
  function watchSignIn(ws) {
    clearTimeout(ws.oidcTimer);
    clearTimeout(ws.oidcCheck);
    clearTimeout(ws.oidcBound);
    const gen = ws.oidc.gen;
    const current = () => ws.oidc && ws.oidc.gen === gen && ws.readyState === 1;
    // One deadline (the token's expiry plus the one clock skew): the connection ends there.
    ws.oidcTimer = setTimeout(() => {
      if (!current()) return;
      cutOff(ws, "token expired");
    }, Math.max(0, ws.oidc.deadline - Date.now()));
    ws.oidcTimer.unref?.();
    if (ws.oidc.opaque) {
      // Introspected tokens: a fresh answer must arrive before checkedAt + delay. The recheck starts
      // early enough for the request timeout and backoff; at the bound the connection closes even
      // if a recheck is still in flight.
      const delayMs = (oidc.config?.maxRevocationDelaySeconds ?? 300) * 1000;
      const bound = () => ws.oidc.checkedAt + delayMs;
      const arm = () => {
        clearTimeout(ws.oidcBound);
        ws.oidcBound = setTimeout(() => current() && cutOff(ws, "identity provider unavailable"), Math.max(0, bound() - Date.now()));
        ws.oidcBound.unref?.();
        clearTimeout(ws.oidcCheck);
        ws.oidcCheck = setTimeout(recheck, Math.max(500, bound() - Date.now() - Math.min(delayMs / 2, 15_000)));
        ws.oidcCheck.unref?.();
      };
      const recheck = () => {
        if (!current()) return;
        const token = ws.oidc.token;
        verifier.verify(ws.oidc.issuer, token, { fresh: true }).then(
          (id) => {
            if (!current() || ws.oidc.token !== token) return; // an older token's answer
            ws.oidc.checkedAt = id.checkedAt;
            arm();
          },
          (e) => {
            if (!current() || ws.oidc.token !== token) return;
            if (e.code !== "unavailable") return cutOff(ws, "token revoked");
            ws.oidcCheck = setTimeout(recheck, 2000); // try again until the bound
            ws.oidcCheck.unref?.();
          },
        );
      };
      arm();
    }
  }
  /** Signed-in connections past their deadline stop at once, even before the socket is closed. */
  // Introspected tokens also end at their freshness bound (the last provider answer + the delay),
  // checked here as well as by the timers, so nothing passes it even if a timer runs late.
  const freshUntil = (o) => (o.opaque ? o.checkedAt + (oidc?.config?.maxRevocationDelaySeconds ?? 300) * 1000 : Infinity);
  const pastDeadline = (ws) => Boolean(ws.oidc && Date.now() >= Math.min(ws.oidc.deadline, freshUntil(ws.oidc)));

  /**
   * Stop serving a connection now (its credential ended): no more frames are handled, it leaves
   * the online list and its claim, and it is closed; the close handshake can take as long as the
   * client wants, so it is cut after two seconds.
   */
  function cutOff(ws, reason) {
    if (ws.revoked) return;
    ws.revoked = true;
    if (ws.peerName) claims.revoke(ws.peerName, ws);
    if (online.get(ws.peerName)?.ws === ws) {
      online.delete(ws.peerName);
      peers.get(ws.peerName).lastSeen = Date.now();
      log("-", ws.peerName, `(${reason})`);
    }
    ws.close(4003, reason);
    setTimeout(() => ws.terminate(), 2000).unref();
  }

  /** Returns the matching credential or null; compares against all of them in constant time. */
  function authenticate(t) {
    if (typeof t !== "string") return null;
    const d = digest(t);
    let found = null;
    for (const c of credentials) if (c.digest && crypto.timingSafeEqual(d, c.digest) && !found) found = c;
    return found;
  }

  /** name -> {ws, host, roles, since} */
  const online = new Map();
  /** name -> {host, roles, lastSeen, queue: msg[]} for every peer seen recently */
  const peers = new Map();
  /** message id -> {msg, to, ws, reply, timer} awaiting the receiver's "got" (reply: to the sender) */
  const inflight = new Map();
  let queuedTotal = 0;
  const startedAt = Date.now();
  /** Counters for monitoring (stats()); never message content. */
  const counts = { logins: 0, authFailures: 0, accepted: 0, deliveries: 0, expired: 0, rateLimited: 0, queueFull: 0, takeovers: 0, queueDropped: 0 };
  const claims = new ClaimTable();

  /**
   * An automatic session name: "<member>-<host>-<n>" (member credentials) or "<host>-<n>"; send-only
   * connections get "<member>-cli" / "<host>-cli". The host part is shortened to fit 64 characters,
   * never the member prefix; unique among live and reserved claims, with -2, -3, ... on collision.
   */
  function autoName(cred, auto, sendOnly) {
    const host = String(auto.host || "host").replace(/[^A-Za-z0-9_-]/g, "-").replace(/^[^A-Za-z0-9]+/, "") || "host";
    const n = Number.isInteger(auto.n) && auto.n >= 0 ? String(auto.n) : "0";
    const prefix = cred.member ? `${cred.member}-` : "";
    const tail = sendOnly ? "cli" : n;
    for (let k = 1; k <= 99; k++) {
      const suffix = k === 1 ? "" : `-${k}`;
      const room = 64 - prefix.length - tail.length - suffix.length - 1;
      if (room < 1) return null;
      const name = `${prefix}${host.slice(0, room)}-${tail}${suffix}`;
      if (!NAME_RE.test(name)) return null;
      if (sendOnly || claims.status(name).state === "free") return name;
    }
    return null;
  }

  /**
   * Hand off from a previous socket of a name (evicted or fenced): fence it, and move its
   * unconfirmed deliveries back to the front of the queue exactly once, cancelling their timers.
   * Its later frames, acknowledgements and close are then no-ops.
   */
  function handOff(previous) {
    previous.fenced = true;
    for (const f of [...inflight.values()].filter((x) => x.ws === previous).reverse()) {
      clearTimeout(f.timer);
      inflight.delete(f.msg.id);
      enqueue(f.to, f.msg, true, true);
      log("requeued", `ref ${f.msg.message_id} delivery ${f.msg.id}`, "for", f.to, ...tag(f.msg));
      if (f.reply) f.reply({ type: "ack", state: "queued", ...ackMeta(f.msg) });
    }
  }

  /**
   * Operations (idempotent sends): (principal, session name, op) -> {digest, state, outcome,
   * waiters, expires}. Reserved before any effect; the first acknowledgement (or refusal) is the
   * outcome. Entries are never evicted early: a principal with OPS_PER_PRINCIPAL live entries gets
   * new operations refused before acceptance.
   */
  const ops = new Map();
  const opCounts = new Map();
  const opDigest = (m) =>
    crypto
      .createHash("sha256")
      .update(JSON.stringify([m.to, m.text, m.ttl ?? null, typeof m.reply_to === "string" ? m.reply_to.toLowerCase() : (m.reply_to ?? null)]))
      .digest("hex");
  function dropOp(key, e) {
    ops.delete(key);
    const n = (opCounts.get(e.owner) ?? 1) - 1;
    if (n > 0) opCounts.set(e.owner, n);
    else opCounts.delete(e.owner);
  }
  function sweepOps(now = Date.now()) {
    for (const [key, e] of ops) if (e.state === "done" && e.expires <= now) dropOp(key, e);
  }
  /** Look up or reserve the operation of a send. Returns {run: true, op} when this attempt executes it. */
  function operation(ws, name, m) {
    const now = Date.now();
    const owner = principalKey(ws.principal);
    const key = `${owner}|${name}|${m.op}`;
    const digest = opDigest(m);
    let e = ops.get(key);
    if (e && e.state === "done" && e.expires <= now) {
      dropOp(key, e);
      e = null;
    }
    const answer = (to, id, frame) => send(to, { ...frame, id });
    if (e) {
      if (e.digest !== digest) {
        answer(ws, m.id, { type: "error", error: "op_reused: this operation id was used for a different message" });
        return { run: false };
      }
      if (e.state === "done") answer(ws, m.id, e.outcome);
      else e.waiters.push({ ws, id: m.id }); // joins the attempt in progress
      return { run: false };
    }
    sweepOps(now);
    if ((opCounts.get(owner) ?? 0) >= opsPerPrincipal) {
      answer(ws, m.id, { type: "error", error: "too_many_operations: too many recent sends are still remembered; try again in a few minutes" });
      return { run: false };
    }
    e = { owner, digest, state: "in_progress", outcome: null, waiters: [{ ws, id: m.id }], expires: now + OP_TTL_MS };
    ops.set(key, e);
    opCounts.set(owner, (opCounts.get(owner) ?? 0) + 1);
    const op = {
      settle(frame) {
        if (e.state === "done") return;
        if (frame.type === "error") {
          // Refused before acceptance: nothing happened, so a retry may execute it.
          dropOp(key, e);
        } else Object.assign(e, { state: "done", outcome: frame, expires: Date.now() + OP_TTL_MS });
        for (const w of e.waiters.splice(0)) answer(w.ws, w.id, frame);
      },
    };
    return { run: true, op };
  }

  const send = (ws, obj) => {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
  };

  /** `force` is for requeueing unconfirmed messages: those were already accepted, never drop them. */
  function enqueue(to, msg, front = false, force = false) {
    const p = peers.get(to);
    if (!p) return false;
    if (!force && (p.queue.length >= MAX_QUEUE_PER_PEER || queuedTotal >= MAX_QUEUED_TOTAL)) {
      counts.queueFull++;
      return false;
    }
    front ? p.queue.unshift(msg) : p.queue.push(msg);
    queuedTotal++;
    return true;
  }

  // Counted per recipient name across all its connections, so replacing a connection
  // that has not finished closing does not open a fresh budget.
  const inflightTo = (to) => {
    let n = 0;
    for (const f of inflight.values()) if (f.to === to) n++;
    return n;
  };
  const hasRoom = (to) => inflightTo(to) < MAX_INFLIGHT_PER_PEER;

  const expired = (msg, now = Date.now()) => msg.expires != null && msg.expires <= now;
  const dropExpired = (to, msg) => {
    counts.expired++;
    log("expired", msg.from, "->", to, `(dropped, TTL expired) ref ${msg.message_id} delivery ${msg.id}`, ...tag(msg));
  };
  /** Fields every ack about this message carries. */
  const ackMeta = (msg) => ({ message_id: msg.message_id, ...(msg.expires ? { expires: msg.expires } : {}) });

  /** Deliver queued messages for `to` while it is online and under its unconfirmed limit. */
  function flush(to) {
    const p = peers.get(to);
    if (!online.has(to) || !p?.queue.length) return;
    let room = MAX_INFLIGHT_PER_PEER - inflightTo(to);
    // inflightTo counts every connection of `to`, including one that is still closing.
    while (room > 0 && p.queue.length && online.has(to)) {
      queuedTotal--;
      const msg = p.queue.shift();
      if (expired(msg)) dropExpired(to, msg);
      else {
        forward(to, msg, null);
        room--;
      }
    }
  }

  /** Deliver `msg` to online `to`; `reply(frame)` reports the first acknowledgement to the sender. */
  function forward(to, msg, reply) {
    // The delivery id stays the same across redeliveries (receivers use it to store a message
    // once); acknowledgements count only from the socket it was sent to (see "got").
    const target = online.get(to);
    if (pastDeadline(target.ws)) {
      // Its sign-in ended (the timer may not have run yet): nothing more is delivered to it.
      const p = peers.get(to);
      p.queue.unshift(msg);
      queuedTotal++;
      if (reply) reply({ type: "ack", state: "queued", ...ackMeta(msg) });
      return cutOff(target.ws, "token expired");
    }
    counts.deliveries++;
    log("forward attempt", `ref ${msg.message_id} delivery ${msg.id}`, "to", to, ...tag(msg));
    // Protocol-1 receivers get exactly the fields they know.
    const frame = { type: "message", ...msg };
    if (target.version !== 2) delete frame.sender;
    send(target.ws, frame);
    const timer = setTimeout(() => {
      // Still waiting: tell the sender, keep tracking until "got" or disconnect.
      const f = inflight.get(msg.id);
      if (f && f.reply) {
        f.reply({ type: "ack", state: "unconfirmed", ...ackMeta(f.msg) });
        f.reply = null;
      }
    }, ACK_TIMEOUT_MS);
    inflight.set(msg.id, { msg, to, ws: target.ws, reply, timer });
  }

  const server = http.createServer((req, res) => {
    if (broker?.handles(req.url)) {
      broker.handle(req, res, clientAddress(req, trustedProxies).client).catch(() => res.destroy());
    } else if (req.url === "/.well-known/hoptell" && oidc?.discovery) {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "max-age=300" }).end(JSON.stringify(oidc.discovery));
    } else if (req.url === "/healthz") {
      res.writeHead(200, { "content-type": "text/plain" }).end("ok\n");
    } else {
      res.writeHead(426, { "content-type": "text/plain" }).end("hoptell relay: connect with a hoptell client (WebSocket)\n");
    }
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 512 * 1024 });
  // Broker mode: the broker sees this relay's members (the loaded ones are applied at once, before
  // any connection) and ends the connections of ended families.
  broker?.attach({
    members: () => credentials,
    fence: (families) => {
      for (const ws of wss.clients) if (ws.oidc?.family && families.has(ws.oidc.family)) cutOff(ws, "token revoked");
    },
  });
  server.on("upgrade", (req, socket, head) => wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req)));
  server.on("clientError", (_e, socket) => socket.destroy());

  wss.on("connection", (ws, req) => {
    const { socket: via, client } = clientAddress(req, trustedProxies);
    const addr = via === client ? client : `${client} via ${via}`; // for logs only
    let name = null;
    let mode = null;
    let sent = [];
    ws.isAlive = true;
    ws.on("pong", () => (ws.isAlive = true));
    ws.on("error", (e) => log("socket error from", addr, e.message)); // protocol errors must not crash the relay
    // A sign-in being verified (the provider's discovery, keys or introspection, each bounded by
    // its own timeout) may take longer than a hello: it gets up to 20 s in all.
    const helloStarted = Date.now();
    let helloTimer;
    const helloCheck = () => {
      if (name) return;
      if (ws.authenticating && Date.now() - helloStarted < 20_000) helloTimer = setTimeout(helloCheck, 1000);
      else ws.close(4001, "no hello");
    };
    helloTimer = setTimeout(helloCheck, 5000);

    ws.on("message", (raw, isBinary) => {
      try {
        handle(raw, isBinary);
      } catch (e) {
        // A bug or a hostile frame must cost one connection, never the relay.
        log("dropping connection from", addr, "after error:", e.message);
        ws.terminate();
      }
    });

    function handle(raw, isBinary) {
      if (ws.revoked) return; // its credential was removed; ignore it until the socket is gone
      let m;
      try {
        if (isBinary) throw new Error("binary");
        m = JSON.parse(raw);
        if (!m || typeof m !== "object") throw new Error("not an object");
      } catch {
        if (!name) return ws.close(4001, "bad hello");
        return send(ws, { type: "error", error: "bad frame" });
      }

      if (!name) {
        // Close reasons are fixed strings: they must stay under the 123-byte WebSocket limit.
        if (m.type !== "hello") return ws.close(4001, "hello first");
        const v = m.v === undefined ? 1 : m.v;
        if (v !== 1 && v !== 2) return ws.close(4005, "unsupported protocol version");
        // A refusal for a protocol-2 client: a typed error first, then the fixed close.
        const refuse = (code, close, reason, retryAfterMs) => {
          if (v === 2) send(ws, { type: "hello_error", code, ...(retryAfterMs ? { retry_after_ms: retryAfterMs } : {}) });
          return ws.close(close, reason);
        };
        if (ws.authenticating) return; // a sign-in is being checked: nothing else until it is
        const str = (x) => x === undefined || typeof x === "string";
        const auto = v === 2 && m.name === null && m.auto && typeof m.auto === "object" && str(m.auto.host) && ["string", "number", "undefined"].includes(typeof m.auto.n);
        const signIn = v === 2 && m.auth && typeof m.auth === "object" && ["oidc", "broker"].includes(m.auth.kind) && typeof m.auth.token === "string" && typeof m.auth.issuer === "string";
        if ((typeof m.token !== "string" && !signIn) || (typeof m.name !== "string" && !auto) || !str(m.mode) || !str(m.host) || (m.roles !== undefined && !Array.isArray(m.roles))) {
          return refuse("bad_claim", 4001, "bad hello");
        }
        const sendOnly = m.mode === "send";
        if (v === 2 && (sendOnly ? m.claim !== undefined : !m.claim || typeof m.claim !== "object")) return refuse("bad_claim", 4001, "bad hello");
        if (signIn && m.auth.kind === "broker") {
          // Broker mode (design 1.7): the relay's own access token, checked in memory, then the link.
          if (!broker) return refuse("unsupported_auth", 4003, "sign-in is not configured on this relay");
          let id;
          try {
            id = broker.verifyAccess(m.auth.issuer, m.auth.token);
          } catch (e) {
            counts.authFailures++;
            return refuse(e.code ?? "bad_token", 4003, e.code === "token_expired" ? "token expired" : e.code === "unsupported_auth" ? "sign-in with that issuer is not accepted" : "bad token");
          }
          const cred = credentials.find((c) => c.memberId === id.memberId && c.oidc?.some((l) => l.issuer === id.issuer && l.subject === id.subject));
          if (!cred) {
            counts.authFailures++;
            return refuse("not_linked", 4003, "identity not linked to a member");
          }
          ws.oidc = { gen: 1, kind: "broker", issuer: id.issuer, issuerId: id.issuerId, subject: id.subject, family: id.family, deadline: id.deadline, opaque: false, checkedAt: Date.now(), token: null, groups: [] };
          finishHello(m, v, cred, refuse, auto, sendOnly);
          return watchSignIn(ws);
        }
        if (signIn) {
          // Signed in with an identity provider (design 1.6): verified asynchronously, then linked.
          if (!verifier) return refuse("unsupported_auth", 4003, "sign-in is not configured on this relay");
          ws.authenticating = true;
          verifier.verify(m.auth.issuer, m.auth.token).then(
            (id) => {
              ws.authenticating = false;
              if (ws.readyState !== 1) return;
              const cred = credentials.find((c) => c.oidc?.some((l) => l.issuer === id.issuer && l.subject === id.subject));
              if (!cred) {
                counts.authFailures++;
                log("sign-in not linked:", id.issuer, `subject ${fp ? crypto.createHmac("sha256", fp.key).update(`subject:${id.subject}`).digest("hex").slice(0, 12) : "(hidden)"}`, "from", addr);
                send(ws, { type: "hello_error", code: "not_linked", issuer: id.issuer, subject: id.subject });
                return ws.close(4003, "identity not linked to a member");
              }
              ws.oidc = { gen: 1, issuer: id.issuer, subject: id.subject, deadline: id.deadline, opaque: id.opaque, checkedAt: id.checkedAt ?? Date.now(), token: id.opaque ? m.auth.token : null, groups: id.groups };
              // Outside the frame handler's guard: a bug or a hostile field costs this connection only.
              try {
                finishHello(m, v, cred, refuse, auto, sendOnly);
                watchSignIn(ws);
              } catch (e) {
                log("dropping connection from", addr, "after error:", e.message);
                ws.terminate();
              }
            },
            (e) => {
              ws.authenticating = false;
              counts.authFailures++;
              log("sign-in refused from", addr, e.code ?? "", e.message);
              send(ws, { type: "hello_error", code: e.code ?? "bad_token" });
              ws.close(4003, e.code === "unavailable" ? "identity provider unavailable" : e.code === "unsupported_auth" ? "sign-in with that issuer is not accepted" : "bad token");
            },
          );
          return;
        }
        const cred = authenticate(m.token);
        if (!cred) {
          counts.authFailures++;
          log("auth failed from", addr);
          return ws.close(4003, "bad token");
        }
        return finishHello(m, v, cred, refuse, auto, sendOnly);
      }

      if (ws.fenced) return; // a socket replaced by its own session's resume: its frames are ignored

      if (pastDeadline(ws)) return cutOff(ws, "token expired"); // nothing is accepted after it
      if (m.type === "reauth") {
        // A fresh token for a signed-in connection: applied only when every check passes, for the
        // same issuer, subject and member; the connection, lease and name are kept.
        if (!ws.oidc || typeof m.token !== "string" || (ws.oidc.kind === "broker" ? !broker : !verifier)) return send(ws, { type: "error", id: m.id, code: "bad_token", error: "reauth is only for signed-in connections" });
        if (ws.oidc.kind === "broker") {
          let id;
          try {
            id = broker.verifyAccess(ws.oidc.issuerId, m.token);
          } catch (e) {
            return send(ws, { type: "error", id: m.id, code: e.code ?? "bad_token", error: e.message });
          }
          if (id.subject !== ws.oidc.subject || id.issuer !== ws.oidc.issuer) {
            send(ws, { type: "error", id: m.id, code: "other_identity", error: "reauth with another identity" });
            return cutOff(ws, "reauth with another identity");
          }
          const linked = credentials.find((c) => c.oidc?.some((l) => l.issuer === id.issuer && l.subject === id.subject));
          if (!linked || linked.memberId !== ws.cred.memberId || id.memberId !== ws.cred.memberId) {
            send(ws, { type: "error", id: m.id, code: "not_linked", error: "the identity is no longer linked to this member" });
            return cutOff(ws, "identity not linked to a member");
          }
          Object.assign(ws.oidc, { gen: ws.oidc.gen + 1, family: id.family, deadline: id.deadline, checkedAt: Date.now() });
          watchSignIn(ws);
          return send(ws, { type: "reauth_ok", id: m.id, auth_expires_at: id.deadline });
        }
        // One renewal at a time; its result applies only to the generation it started from.
        if (ws.reauthing) return send(ws, { type: "error", id: m.id, code: "busy", error: "a renewal is already in progress" });
        ws.reauthing = true;
        const holder = ws.cred;
        const gen = ws.oidc.gen;
        return verifier.verify(ws.oidc.issuer, m.token, { fresh: true }).finally(() => (ws.reauthing = false)).then(
          (id) => {
            if (ws.readyState !== 1 || ws.fenced || ws.cred !== holder || ws.oidc.gen !== gen) return; // a late result
            if (id.subject !== ws.oidc.subject) {
              send(ws, { type: "error", id: m.id, code: "other_identity", error: "reauth with another identity" });
              return cutOff(ws, "reauth with another identity");
            }
            const linked = credentials.find((c) => c.oidc?.some((l) => l.issuer === id.issuer && l.subject === id.subject));
            if (!linked || linked.memberId !== ws.cred.memberId) {
              send(ws, { type: "error", id: m.id, code: "not_linked", error: "the identity is no longer linked to this member" });
              return cutOff(ws, "identity not linked to a member");
            }
            Object.assign(ws.oidc, { gen: gen + 1, deadline: id.deadline, opaque: id.opaque, checkedAt: id.checkedAt ?? Date.now(), token: id.opaque ? m.token : null, groups: id.groups });
            watchSignIn(ws);
            send(ws, { type: "reauth_ok", id: m.id, auth_expires_at: id.deadline });
          },
          (e) => {
            if (ws.readyState !== 1) return;
            send(ws, { type: "error", id: m.id, code: e.code ?? "bad_token", error: e.message });
          },
        );
      }
      return afterLogin(m);
    }

    /** The part of a hello after its credential is known (token or sign-in). */
    function finishHello(m, v, cred, refuse, auto, sendOnly) {
      {
        const principal = cred.member ? { kind: "member", id: cred.memberId, name: cred.member } : { kind: "shared" };
        const peerHost = HOST_RE.test(m.host || "") ? m.host : via; // forwarded addresses stay in logs only
        let wanted = m.name;
        if (auto) {
          wanted = autoName(cred, m.auto, sendOnly);
          if (!wanted) return refuse("name_unavailable", 4002, "no automatic name fits");
        }
        if (!NAME_RE.test(wanted)) return refuse("bad_claim", 4002, "bad name");
        if (!nameAllowed(cred, wanted)) {
          log(`member ${cred.member} tried to use the name ${wanted}`);
          return refuse("not_allowed", 4002, "name not allowed for this member token");
        }
        const roles = Array.isArray(m.roles) ? m.roles : [];
        if (roles.length > MAX_ROLES || !roles.every((r) => typeof r === "string" && NAME_RE.test(r))) return refuse("bad_claim", 4002, "bad roles");
        const welcome = (claim) => ({
          type: "welcome",
          name: wanted,
          auth: authMode(),
          ...(v === 2 ? { realm: realmInfo, member: cred.member ? { id: cred.memberId, name: cred.member } : null, claim: claim ?? null, incarnation: claims.incarnation, caps: verifier || broker ? [...CAPS, ...(verifier ? ["oidc"] : []), ...(broker ? ["broker"] : []), "reauth"] : CAPS, ...(ws.oidc ? { auth_expires_at: ws.oidc.deadline } : {}) } : {}),
        });
        if (sendOnly) {
          clearTimeout(helloTimer);
          Object.assign(ws, { cred, principal, version: v, peerName: wanted, peerHost });
          name = wanted;
          mode = "send";
          counts.logins++;
          return send(ws, welcome(null));
        }
        const decision = claims.hello({ name: wanted, socket: ws, principal, version: v, claim: m.claim });
        if (!decision.ok) {
          log("claim refused", wanted, decision.code, "from", peerHost, addr);
          return refuse(decision.code, decision.close, CLOSE_REASONS[decision.code] || "refused", decision.retryAfterMs);
        }
        clearTimeout(helloTimer);
        Object.assign(ws, { cred, principal, version: v, peerName: wanted, peerHost });
        name = wanted;
        mode = "peer";
        counts.logins++;
        // The previous holder: evicted by a replace (4004) or fenced by a resume (4007). Its
        // unconfirmed deliveries go back to the front of the queue now, exactly once.
        const previous = decision.evict || decision.fence || online.get(name)?.ws;
        if (previous && previous !== ws) {
          counts.takeovers++;
          handOff(previous);
          previous.close(decision.fence ? 4007 : 4004, decision.fence ? "resumed by its own session elsewhere" : "replaced by a newer connection with the same name");
        }
        online.set(name, { ws, host: peerHost, roles, since: Date.now(), version: v });
        const p = peers.get(name) || { queue: [] };
        const owner = principalKey(principal);
        if (p.owner && p.owner !== owner && p.queue.length) {
          // A different principal now holds this name: the earlier owner's queue is not delivered.
          counts.queueDropped += p.queue.length;
          queuedTotal -= p.queue.length;
          log("queue dropped", name, `(${p.queue.length} messages for a previous owner)`);
          p.queue = [];
        }
        peers.set(name, Object.assign(p, { host: peerHost, roles, lastSeen: Date.now(), owner }));
        log("+", name, roles.length ? `[${roles.join(",")}]` : "", "from", peerHost, addr, v === 2 ? `(${m.claim.action})` : "");
        send(ws, welcome(decision.claim));
        return flush(name);
      }
    }

    /** Frames of a logged-in connection. */
    function afterLogin(m) {

      if (m.type === "got") {
        const f = inflight.get(m.id);
        if (f && f.ws === ws) {
          clearTimeout(f.timer);
          inflight.delete(m.id);
          log("receipt acknowledged", `ref ${f.msg.message_id} delivery ${f.msg.id}`, "by", f.to, ...tag(f.msg));
          if (f.reply) f.reply({ type: "ack", state: "delivered", ...ackMeta(f.msg) });
          flush(name); // room for more
        }
        return;
      }

      if (m.type === "release") {
        // A clean shutdown of a protocol-2 session: the name is free at once, not reserved.
        if (ws.version === 2 && mode === "peer") claims.release(name, ws);
        return;
      }

      if (m.type === "claim_status") {
        if (ws.version !== 2 || typeof m.name !== "string" || !NAME_RE.test(m.name)) return send(ws, { type: "error", id: m.id, error: "bad claim_status" });
        // Only names this credential may claim are described; others are just "taken".
        const st = nameAllowed(ws.cred, m.name) ? claims.status(m.name, ws.principal) : { state: "taken" };
        return send(ws, { type: "claim_status", id: m.id, state: st.state, ...(st.retryAfterMs ? { retry_after_ms: st.retryAfterMs } : {}) });
      }

      if (m.type === "list") {
        const list = [...peers.entries()]
          .filter(([n]) => n !== name)
          .map(([n, p]) => ({ name: n, host: p.host, roles: p.roles || [], online: online.has(n), queued: p.queue.length }));
        return send(ws, { type: "peers", id: m.id, peers: list });
      }

      if (m.type === "send") {
        // An operation id makes retries safe: the first execution's acknowledgement is kept and
        // repeated; nothing is forwarded or queued twice (see operation() below).
        let op = null;
        const reply = (frame) => (op ? op.settle(frame) : send(ws, { ...frame, id: m.id }));
        const fail = (error) => reply({ type: "error", error });
        if (typeof m.to !== "string" || typeof m.text !== "string") return fail("`to` and `text` must be strings");
        if (m.op !== undefined) {
          if (ws.version !== 2 || typeof m.op !== "string" || !OP_RE.test(m.op)) return fail("`op` must be an operation id (o_ and 26 letters a-z or digits 2-7)");
          const r = operation(ws, name, m);
          if (!r.run) return; // answered from the cache, joined an operation in progress, or refused
          op = r.op;
        }
        const now = Date.now();
        sent = sent.filter((t) => now - t < RATE_WINDOW_MS);
        if (sent.length >= RATE_MAX) {
          counts.rateLimited++;
          return fail(`rate limit: at most ${RATE_MAX} messages per ${RATE_WINDOW_MS / 1000}s per connection`);
        }
        sent.push(now);

        const { text, to, ttl } = m;
        const replyTo = typeof m.reply_to === "string" ? m.reply_to.toLowerCase() : m.reply_to;
        if (replyTo != null && (typeof replyTo !== "string" || !REF_RE.test(replyTo))) return fail("`reply_to` must be a message reference (a UUID)");
        if (ttl != null && !(Number.isInteger(ttl) && ttl >= 1 && ttl <= MAX_TTL_S)) return fail(`\`ttl\` must be a whole number of seconds from 1 to ${MAX_TTL_S}`);
        if (!text.trim()) return fail("empty message");
        if (text.length > MAX_TEXT) return fail(`message is longer than ${MAX_TEXT} characters`);
        const noReply = mode === "send" && !peers.has(name);
        const expiry = ttl ? { expires: Date.now() + ttl * 1000 } : {};
        // One reference per accepted send, shared by its fan-out copies; each copy gets its own delivery id.
        const ref = { message_id: crypto.randomUUID(), ...(replyTo ? { reply_to: replyTo } : {}) };
        const sender = { member: ws.cred.member ? { id: ws.cred.memberId, name: ws.cred.member } : null, auth: ws.cred.member ? "member" : "shared", realm: realmInfo.id };
        const msg = () => ({ id: crypto.randomUUID(), ...ref, from: name, fromHost: ws.peerHost, to, text, ts: Date.now(), ...expiry, ...(noReply ? { noReply } : {}), sender });
        const refs = `ref ${ref.message_id}${replyTo ? ` reply-to ${replyTo}` : ""}`;

        if (to.startsWith("@")) {
          // Fan-out to every online peer with the role ("@all": everyone). Not queued for offline peers.
          const role = to.slice(1);
          const targets = [...online.entries()].filter(([n, o]) => n !== name && (role === "all" || o.roles.includes(role))).map(([n]) => n);
          if (!targets.length) return fail(role === "all" ? "no other peer is online" : `no online peer has the role "${role}"`);
          // Busy peers get it queued behind their unconfirmed messages; only a full queue skips one.
          const skipped = [];
          for (const t of targets) {
            const copy = msg();
            if (hasRoom(t) && !peers.get(t).queue.length) forward(t, copy, null);
            else if (enqueue(t, copy)) logQueued(t, copy);
            else skipped.push(t);
          }
          const count = targets.length - skipped.length;
          const summary = count ? tag({ message_id: ref.message_id, text }) : [];
          log(name, "->", to, `(${count} peers${skipped.length ? `, skipped ${skipped.join(",")}` : ""}, ${text.length} chars)`, refs, ...summary);
          if (!count) return fail(`every peer matching ${to} is busy and its queue is full`);
          counts.accepted++; // once per send, however many copies
          return reply({ type: "ack", state: "fanout", count, skipped, message_id: ref.message_id, ...expiry });
        }

        if (to === name) return fail("cannot message yourself");
        if (!peers.has(to)) return fail(`unknown peer "${to}" (see list_peers)`);
        if (online.has(to) && hasRoom(to) && !peers.get(to).queue.length) {
          counts.accepted++;
          forward(to, msg(), reply);
          log(name, "->", to, `(${text.length} chars)`, refs, ...tag({ message_id: ref.message_id, text }));
          return;
        }
        const queued = msg();
        if (!enqueue(to, queued)) return fail(`${to} ${online.has(to) ? "is not confirming messages" : "is offline"} and its queue is full`);
        counts.accepted++;
        log(name, "->", to, online.has(to) ? "(queued behind unconfirmed messages)" : "(queued, offline)", `(${text.length} chars)`, refs, ...tag(queued));
        logQueued(to, queued);
        return reply({ type: "ack", state: "queued", message_id: ref.message_id, ...expiry });
      }

      send(ws, { type: "error", id: m.id, error: "unknown message type" });
    }

    ws.on("close", () => {
      clearTimeout(ws.oidcTimer);
      clearTimeout(ws.oidcCheck);
      clearTimeout(ws.oidcBound);
      clearTimeout(helloTimer);
      if (mode !== "peer") return;
      if (ws.fenced) return flush(name); // already handed off: the current holder gets its messages
      claims.closed(name, ws);
      // Anything not confirmed by this connection goes back to the queue.
      const lost = [...inflight.values()].filter((f) => f.ws === ws).reverse();
      for (const f of lost) {
        clearTimeout(f.timer);
        inflight.delete(f.msg.id);
        enqueue(f.to, f.msg, true, true);
        log("requeued", `ref ${f.msg.message_id} delivery ${f.msg.id}`, "for", f.to, ...tag(f.msg));
        if (f.reply) f.reply({ type: "ack", state: "queued", ...ackMeta(f.msg) });
      }
      if (online.get(name)?.ws === ws) {
        online.delete(name);
        peers.get(name).lastSeen = Date.now();
        log("-", name, lost.length ? `(${lost.length} unconfirmed message(s) requeued)` : "");
      } else {
        flush(name); // replaced by a newer connection: hand it what this one never confirmed
      }
    });
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) ws.terminate();
      else {
        ws.isAlive = false;
        ws.ping();
      }
    }
    claims.sweep();
    sweepOps();
    const now = Date.now();
    for (const [n, p] of peers) {
      const keep = [];
      for (const msg of p.queue) expired(msg, now) ? dropExpired(n, msg) : keep.push(msg);
      queuedTotal -= p.queue.length - keep.length;
      p.queue = keep;
      if (!online.has(n) && !p.queue.length && now - p.lastSeen > FORGET_AFTER_MS) peers.delete(n);
    }
  }, sweepMs);

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const { port: actual } = server.address();
      const auth = [token && "shared token", members?.length && `${members.length} member token(s)`, oidc && `sign-in with ${oidc.config.issuers.map((i) => i.issuer).join(", ")}`].filter(Boolean).join(" + ");
      log(`hoptell relay listening on ws://${host}:${actual} (auth: ${auth}; realm: ${realmInfo.id}${realmInfo.name ? ` "${realmInfo.name}"` : ""}; health: http://${host}:${actual}/healthz)`);
      if (fp) log(`fingerprint logging enabled key-id ${fp.id} format ${FORMAT}`);
      resolve({
        port: actual,
        realm: realmInfo,
        /** Numbers for monitoring: counts, sizes and ages only, never names or content. */
        stats() {
          let queueBytes = 0;
          let oldest = null;
          for (const p of peers.values()) {
            for (const msg of p.queue) {
              queueBytes += Buffer.byteLength(msg.text);
              if (oldest === null || msg.ts < oldest) oldest = msg.ts;
            }
          }
          return {
            uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
            peersKnown: peers.size,
            peersOnline: online.size,
            queueItems: queuedTotal,
            queueBytes,
            oldestQueuedSeconds: oldest === null ? 0 : Math.round((Date.now() - oldest) / 1000),
            unconfirmed: inflight.size,
            ...counts,
          };
        },
        reload(newMembers) {
          credentials = buildCredentials(token, newMembers, { allowNone: true, requireMembers }); // throws, keeping the old list
          let revoked = 0;
          for (const ws of wss.clients) {
            if (!ws.cred || ws.revoked) continue; // not logged in yet: it authenticates against the new list
            // A connection keeps going only if an identical credential still exists and allows its name.
            // Matched by immutable member id and token: a renamed member keeps its sessions only while
            // their names still fit the new name (checked next); a different person never inherits them.
            // A token connection needs the same token; a sign-in connection the same linked identity.
            const c = ws.oidc
              ? credentials.find((x) => x.memberId === ws.cred.memberId && x.oidc?.some((l) => l.issuer === ws.oidc.issuer && l.subject === ws.oidc.subject))
              : credentials.find((x) => x.memberId === ws.cred.memberId && x.digest && ws.cred.digest && x.digest.equals(ws.cred.digest));
            if (c && nameAllowed(c, ws.peerName)) {
              ws.cred = c;
              continue;
            }
            revoked++;
            cutOff(ws, "token revoked");
          }
          // A reservation survives only for a principal that still has a credential for the name.
          claims.pruneReservations((n, p) => credentials.some((c) => principalKey(c.member ? { kind: "member", id: c.memberId } : { kind: "shared" }) === principalKey(p) && nameAllowed(c, n)));
          // Broker sign-ins of removed, unlinked or signed-out members end too (durably).
          if (broker) {
            try {
              broker.reconcile(credentials);
            } catch (e) {
              log("broker: ending sign-ins after the reload failed:", e.message);
            }
          }
          const n = newMembers?.length || 0;
          log(`members reloaded: ${n} member credential${n === 1 ? "" : "s"}; ${revoked} connection${revoked === 1 ? "" : "s"} revoked`);
        },
        close: () =>
          new Promise((r) => {
            clearInterval(heartbeat);
            for (const f of inflight.values()) clearTimeout(f.timer);
            for (const ws of wss.clients) ws.terminate();
            wss.close();
            server.close(() => r());
            // A connection still sending its upgrade request would keep close() waiting.
            server.closeAllConnections();
          }),
      });
    });
  });
}
