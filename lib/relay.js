// hoptell relay: a small WebSocket hub that routes plain-text messages between
// agent sessions on different machines.
//
// Protocol v1 (JSON text frames):
//   client -> relay  {type:"hello", v:1, name, token, host, mode:"peer"|"send", roles:[...]}
//                    {type:"send", id, to, text, ttl?, reply_to?, op?, to_member?, as_holder?} to: a peer name, "@<role>" or "@all";
//                    to_member (protocol 2, direct sends, cap "to_member"): the member id that must
//                    hold the name; checked at acceptance and again before every delivery
//                    as_holder: true (protocol 2, send-only connections, cap "as_holder"): accepted
//                    only while the sender's name is held by a peer connection of the sender's own
//                    principal (refused with code "not_holder"), checked when the send executes
//                    op (protocol 2): an operation id; a repeated op returns the first outcome
//                    ttl: seconds a queued message may wait before the relay drops it;
//                    reply_to: the message_id this message answers (a reference only)
//                    {type:"list", id, status?}  status: true (cap "status") asks for the statuses below
//                    {type:"got", id}                  receiver confirms a message
//   relay  -> client {type:"welcome", name, auth?}
//                    auth: "shared" (one token for every name), "members" (per-member tokens
//                    only) or "mixed" (both: a shared-token holder may use any member's name)
//                    {type:"error", id?, error}
//                    {type:"ack", id, state:"delivered"|"queued"|"unconfirmed"|"fanout", count?, skipped?, message_id?, expires?,
//                     recipient?: {auth, member: {id, name}|null, realm} (protocol 2, direct sends only)}
//                    message_id: the reference of the accepted send (relays without references omit it);
//                    expires: set when the relay accepted the ttl (relays without expiry omit it)
//                    {type:"peers", id, peers:[{name, host, roles, online, queued, custody?, member_id?, own?, title?, status?}]}
//                    (own, cap list_own: for a member caller, whether the name is held by its member)
//                    (title, cap title: the display-only title of the name's current claim, while
//                    it has one; unverified, never used for routing or access)
//                    (status, cap status: only to a member caller that asked for it, only on a
//                    name whose claim was set by that same member; see "Session statuses")
//                    {type:"message", id, message_id?, reply_to?, from, fromHost, to, text, ts, expires?, noReply?}
//                    id: this delivery (one per recipient, used by "got"); message_id: the send it
//                    belongs to, shared by every fan-out copy
//                    expires: ms timestamp after which the relay no longer delivers it
//                    noReply: true when, at send time, a send-only sender had no peer
//                    of that name to reply to (a plain `hoptell send` from a shell);
//                    advisory: the name may register later
//
// Session titles (cap "title", protocol 2): a receiving hello may carry title: a display-only
// label, cleaned here again (lib/config.js cleanTitle); an unusable one is ignored, never refused.
// It is kept on the claim the hello establishes (acquire or replace): a resume keeps the claim's
// title, and a new claim never inherits one. Titles are not logged.
//   client -> relay  {type:"set_title", id, title}   (cap "set_title"): title text, or null to clear;
//                    only from the connection that currently holds its name (a protocol-2 peer,
//                    not fenced or revoked); at most TITLE_PER_CLAIM a minute per claim and
//                    TITLE_PER_PRINCIPAL per member (shared-token clients share one budget)
//   relay  -> client {type:"title_ok", id, title} or {type:"error", id, code: "not_allowed" |
//                    "title_rate" | "bad_request", error}; a refusal changes nothing, and title
//                    handling never touches deliveries or the connection.
//
// Session statuses (cap "status", protocol 2): an owner-only text a session keeps on its claim (a
// lead's team summary, lib/teamstatus.js). The relay never reads it and never logs it. It is
// listed only to a caller signed in with a member token that asked for it (list status:true), and
// only on a name whose claim belongs to that member: never to other members or shared tokens.
//   client -> relay  {type:"set_status", id, status}  text of at most STATUS_MAX_BYTES UTF-8 bytes,
//                    or null to clear; only from the connection that currently holds its name, as
//                    set_title, with budgets of its own of the same size
//   relay  -> client {type:"status_ok", id} or {type:"error", id, code: "not_allowed" |
//                    "status_rate" | "bad_request", error}; a refusal changes nothing.
//
// Hosted custody (design 4.5, protocol 2): a host signs in with
//   {type:"hello", v:2, auth:{kind:"host", token, member}, name, claim, ...} for a member it holds;
// the sender provenance of a hosted member's messages, its `peers` entries (with member_id, so a
// sender's encryption policy can name the contact without the e2ee service), its welcome member
// and the `member_of` reply carry custody:"hosted". A plaintext fan-out send may carry
// exclude_hosted:true: a sender under an encryption policy whose session cannot encrypt never
// sends a hosted member a plaintext copy. An encrypted fan-out (4.3) applies that design's
// hosted-custody matrix at the sender instead, from the custody and member_id in `list`.
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
import { REASONS } from "./access.js";
import { OWNER_APP_CAP, createAppTunnel } from "./apptunnel.js";
import { ClaimTable, principalKey } from "./claims.js";
import { FORMAT, checkFingerprint, fingerprintSuffix } from "./fingerprint.js";
import { MAX_ROLES, MAX_TTL_S, NAME_RE, REF_RE, STATUS_MAX_BYTES, TITLE_MAX_BYTES, cleanTitle } from "./config.js";
import { DEVICE_ID_RE } from "./mls/identity.js";
import { DirectoryError } from "./mls/relaydir.js";
import { ATTACH_PROOF_CAP, createDeviceProofs, newConnId } from "./mls/relayproof.js";
import { MAX_FRAME_BYTES, OP_RE as E2EE_OP_RE, QUEUE_MAX_MESSAGES as E2EE_QUEUE_MAX } from "./mls/relayds.js";
import { plural } from "./words.js";

export const MAX_TEXT = 100_000;
const MAX_QUEUE_PER_PEER = 50;
const MAX_INFLIGHT_PER_PEER = 50; // unconfirmed messages per receiver; more wait in its queue
const MAX_QUEUED_TOTAL = 2000;
// Per authenticated sender (design 4.1 quotas): queued messages and bytes across all recipients;
// shared-token senders share one quota.
const MAX_QUEUED_PER_SENDER = 1000;
const MAX_QUEUED_BYTES_PER_SENDER = 20 * 1024 * 1024;
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
function buildCredentials(token, members, { allowNone = false, requireMembers = false, hosts = null } = {}) {
  if (!allowNone && !token && !members?.length) throw new Error(`set HOPTELL_TOKEN (shared secret) or HOPTELL_MEMBERS (per-member tokens); ${TOKEN_HELP}`);
  if (requireMembers && token) throw new Error("--require-members is set, so a shared HOPTELL_TOKEN is not allowed; remove it and use per-member tokens");
  const credentials = [];
  if (token) {
    checkToken(token);
    credentials.push({ member: null, memberId: null, digest: storedDigest(token) });
  }
  // Host credentials (design 4.5, hosted custody): checked first, so that no member token can equal one.
  const hostCreds = buildHosts(hosts);
  const links = new Set();
  for (const m of members || []) {
    if (!NAME_RE.test(m?.name || "")) throw new Error(`members: invalid member name "${m?.name}"`);
    // Hosted custody (design 4.5): the member's identity is held by a host, which signs in with
    // its own host credential. Such a member has no token and no linked identity at the relay
    // (its tenant's identity is linked at the host), so nothing but its host can open it.
    if (m.custody !== undefined || m.host !== undefined) {
      if (m.custody !== "hosted" || typeof m.host !== "string" || !HOST_ID_RE.test(m.host)) throw new Error(`members: "${m.name}" needs custody "hosted" with a host id (1-32 lowercase letters, digits or "-"), or neither`);
      if (m.token !== undefined || m.oidc !== undefined) throw new Error(`members: "${m.name}" is hosted, so it cannot have a token or linked identities at the relay (its host signs in for it)`);
      if (m.devicesRevoked !== undefined) throw new Error(`members: "${m.name}" is hosted and has no devices`);
      if (hosts !== null && !hostCreds.some((h) => h.id === m.host)) throw new Error(`members: the host "${m.host}" of "${m.name}" is not listed in hosts`);
    }
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
    const hosted = m.custody === "hosted";
    if (!hosted && (m.token !== undefined || !oidc.length)) checkToken(m.token, `token of member "${m.name}"`);
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
    if (d && hostCreds.some((h) => crypto.timingSafeEqual(h.digest, d))) throw new Error(`members: the token of "${m.name}" is also used by a host; every credential needs its own token`);
    // `hoptell members signout <name>` (design 1.7): broker sign-ins made before this time end.
    if (m.signedOutAt !== undefined && !(Number.isSafeInteger(m.signedOutAt) && m.signedOutAt > 0)) throw new Error(`members: signedOutAt of "${m.name}" must be a time in milliseconds`);
    // `hoptell members device-revoke` (design 3.2, experimental): the admin's device revocations.
    if (m.devicesRevoked !== undefined && !(Array.isArray(m.devicesRevoked) && m.devicesRevoked.length <= 1000 && m.devicesRevoked.every((x) => typeof x === "string" && DEVICE_ID_RE.test(x)))) {
      throw new Error(`members: devicesRevoked of "${m.name}" must be a list of device ids`);
    }
    credentials.push({ member: m.name, memberId, digest: d, oidc: oidc.map((l) => ({ issuer: l.issuer, subject: l.subject })), ...(m.signedOutAt ? { signedOutAt: m.signedOutAt } : {}), ...(m.devicesRevoked?.length ? { devicesRevoked: [...m.devicesRevoked] } : {}), ...(hosted ? { custody: "hosted", host: m.host } : {}) });
  }
  if (token && hostCreds.some((h) => crypto.timingSafeEqual(h.digest, storedDigest(token)))) throw new Error("hosts: a host token equals the shared token; every credential needs its own token");
  return Object.assign(credentials, { hosts: hostCreds });
}

/** Host ids (design 4.5): what a hosted member's `host` names. */
export const HOST_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

/**
 * Host credentials (design 4.5): [{id, token}] from the members file's `hosts`, each token the
 * secret or "sha256:<hex>" (stored hashed by `hoptell members host add`). Throws on any problem.
 */
function buildHosts(hosts) {
  if (hosts === null || hosts === undefined) return [];
  if (!Array.isArray(hosts) || hosts.length > 100) throw new Error("hosts must be a list of at most 100 {\"id\", \"token\"}");
  const out = [];
  for (const h of hosts) {
    if (!HOST_ID_RE.test(h?.id ?? "")) throw new Error(`hosts: invalid host id "${String(h?.id).slice(0, 40)}": 1-32 lowercase letters, digits or "-"`);
    if (out.some((x) => x.id === h.id)) throw new Error(`hosts: the host "${h.id}" is listed twice`);
    checkToken(h.token, `token of host "${h.id}"`);
    const d = storedDigest(h.token);
    if (out.some((x) => crypto.timingSafeEqual(x.digest, d))) throw new Error(`hosts: the token of "${h.id}" is also used by another host; every credential needs its own token`);
    out.push({ id: h.id, digest: d });
  }
  return out;
}

/** Check a members list (and the file's hosts) with the relay's rules (for `hoptell members`); throws on any problem. */
export const validateMembers = (members, hosts = null) => void buildCredentials(null, members, { allowNone: true, hosts });

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
const CAPS = ["auth", "realm", "member", "auto-name", "lease", "claim-status", "sender", "idempotent-send", "to_member", "list_own", "as_holder", "title", "set_title", "status"];
// Title and status updates (set_title, set_status): per claim and per authenticated principal, in
// one minute, each with budgets of its own.
const TITLE_WINDOW_MS = 60_000;
const TITLE_PER_CLAIM = 10;
const TITLE_PER_PRINCIPAL = 60;
const TO_MEMBER_RE = /^(m_[a-z2-7]{26}|name:[A-Za-z0-9][A-Za-z0-9_-]{0,63})$/;
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
/** Whether the socket peer of `req` is one of the trusted proxies (design 4.5 reads X-Forwarded-Proto only then). */
export const fromTrustedProxy = (req, trusted) => isTrusted(trusted, plainIp(req.socket.remoteAddress));

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
 * every connection whose token or name the new list no longer allows. With device keys, a
 * members file whose device revocations cannot be stored stops the start (throws), and fails a
 * reload (throws with membersApplied: the list is in force, device service paused until stored).
 * @param {{host: string, port: number, token?: string, members?: {name: string, token: string}[], log?: Function}} opts
 */
/**
 * The checks of a relay start that need no state: the listen address and the credentials (the
 * same ones startRelay makes). The CLI runs them before it creates or locks the state directory.
 */
export function checkRelayStart({ host, token, members = null, hosts = null, requireMembers = false }) {
  if (!host) throw new Error("relay host is required: pass --host <LAN-or-VPN-IP> (or 0.0.0.0 for every interface)");
  buildCredentials(token, members, { requireMembers, hosts });
}

export function startRelay({ host, port, token, members = null, hosts = null, requireMembers = false, realm = null, sweepMs = 15000, pingMs = sweepMs, fingerprint = null, trustedProxies = null, opsPerPrincipal = OPS_PER_PRINCIPAL, oidc = null, access = null, devices = null, ownerApp = null, audit = () => {}, extraStats = () => ({}), log = (...a) => console.log(new Date().toISOString(), ...a) }) {
  if (!host) throw new Error("relay host is required: pass --host <LAN-or-VPN-IP> (or 0.0.0.0 for every interface)");
  let credentials = buildCredentials(token, members, { requireMembers, hosts });
  /** Whether `name` belongs to a hosted member (design 4.5): only its host's connections may hold it. */
  const hostedName = (name) => credentials.some((c) => c.custody === "hosted" && nameAllowed(c, name));
  /**
   * Custody is immutable for a member id (design 4.5): a member with enrolled devices is never
   * marked hosted, and a reload never moves a member id between custodies (either way). Throws,
   * so a start stops and a reload keeps the current list.
   */
  function checkCustody(next, current) {
    for (const c of next) {
      if (!c.memberId) continue;
      const before = current?.find((x) => x.memberId === c.memberId);
      if (before && (before.custody ?? "member") !== (c.custody ?? "member")) throw new Error(`members: the custody of "${c.member}" cannot change (${before.custody ?? "member"} to ${c.custody ?? "member"}); use a new member for the other custody`);
      if (before && c.custody === "hosted" && before.host !== c.host) throw new Error(`members: the host of "${c.member}" cannot change; use a new member`);
      if (c.custody === "hosted" && devices?.directory) {
        let has;
        try {
          has = devices.directory.list(c.memberId).length > 0;
        } catch (e) {
          throw new Error(`members: the devices of "${c.member}" could not be checked (${e.message}); a hosted member must have none`);
        }
        if (has) throw new Error(`members: "${c.member}" has enrolled devices, so it cannot be hosted; use a new member for hosted custody`);
      }
    }
  }
  /** Whether a member id is in hosted custody (design 4.5): looked up by the immutable member id. */
  const isHosted = (memberId) => Boolean(memberId) && credentials.some((c) => c.memberId === memberId && c.custody === "hosted");
  /**
   * The hosted-custody fence (design 4.5): up exactly while the loaded access policy has a group
   * with provider groups (`oidcGroups`). Derived from the live policy on every use, so it changes
   * in the same step that makes a policy live, and a start under such a policy starts fenced,
   * before anything is dispatched. Distinct from the access module's fence for unresolved state.
   */
  const hostedFenced = () => Object.values(access?.policy()?.groups ?? {}).some((g) => (g.oidcGroups ?? []).length > 0);
  /** Queued messages with a hosted sender or recipient (held while the fence is up). */
  const heldForHosted = () => {
    let n = 0;
    for (const p of peers.values()) for (const msg of p.queue) if (isHosted(msg.access?.memberId) || isHosted(memberOf(p.owner))) n++;
    return n;
  };

  // A relay started without a stored realm (tests, embedding) gets a fresh one per start.
  const realmInfo = { id: realm?.id ?? crypto.randomBytes(16).toString("hex"), ...(realm?.name ? { name: realm.name } : {}) };
  // Device keys (design 3.2, EXPERIMENTAL): only with --experimental-e2ee, which passes
  // {directory, visible}; without it nothing below is reachable and the relay is unchanged.
  // The members file's device revocations must be stored before any device frame is served: until
  // they are (a storage failure), every device frame is answered "unavailable" (retryable), and the
  // sweep tries again. `devicesFenced` holds why.
  let devicesFenced = null;
  // Device lists and KeyPackages follow the same reach as names (design 4.2): a member the caller
  // may not reach (as signed in now: its claim view, credential and broker sign-in) is answered
  // like one without devices.
  const accessVisible = access
    ? (caller, target, ws) => {
        if (caller === target) return true;
        if (hostedFenced() && (isHosted(caller) || isHosted(target))) return false; // design 4.5: never evaluated while fenced
        const from = ws ? fromOf(ws) : { memberId: caller, identity: null, family: null };
        if (from.memberId && !credentials.some((c) => c.member && c.memberId === from.memberId)) return false;
        if (from.family && !broker?.familyLive(from.family)) return false;
        return access.decide(from, { memberId: target, identity: null }) === "allow";
      }
    : null;
  // Encrypted direct messages (design 3.3, EXPERIMENTAL): the Delivery Service `devices.ds`
  // (lib/mls/relayds.js) on the same store; absent without the flag. The same fence covers it:
  // no encrypted publication, attachment or delivery while revocations wait to be stored.
  // Gates 1 and 2 (design 4.1) apply to encrypted messages as to plaintext: at send, as the
  // sender is signed in now; at dispatch, as it was signed in when the message was accepted (the
  // principal queued with it: its member credential, claim view and broker sign-in are rechecked).
  // Messages queued without one are refused before this (see pumpOnce).
  const e2eeReach = access
    ? (fromWs, fromMember, toMember, queued = null) => {
        if (fromMember === toMember) return "allow";
        if (hostedFenced() && (isHosted(fromMember) || isHosted(toMember))) return fromWs ? "deny" : "hold"; // design 4.5
        const from = fromWs ? fromOf(fromWs) : { memberId: fromMember, identity: queued?.identity ?? null, family: queued?.family ?? null };
        if (!credentials.some((c) => c.member && c.memberId === from.memberId)) return "deny";
        if (from.family && !broker?.familyLive(from.family)) return "deny";
        return access.decide(from, { memberId: toMember, identity: null });
      }
    : () => "allow";
  // A9: the per-session device proofs and attachments, shared by the device, encrypted-message and
  // transfer frames (one guard for every device-scoped frame). `devices.now` is the clock (tests);
  // `devices.rateNow` the clock of the device and encrypted-message frames' rate windows only (tests).
  const proofs = devices ? createDeviceProofs({ directory: devices.directory, realm: realmInfo.id, now: devices.now ?? (() => Date.now()) }) : null;
  const e2eeFrames = devices?.ds ? createE2eeFrames({ proofs, custodyOf: (id) => (isHosted(id) ? "hosted" : null), ds: devices.ds, audit, visible: devices.visible ?? accessVisible, reach: e2eeReach, principal: (ws) => senderOf(ws), mayUpload: (ws) => mayUpload(ws), log, fenced: () => devicesFenced, memberOf: (n) => credentials.find((c) => c.member && nameAllowed(c, n))?.memberId ?? null, ...(devices.rateNow ? { rateNow: devices.rateNow } : {}) }) : null;
  // Larger transfers (design 6, EXPERIMENTAL): the transfer store `devices.transfers` on the same
  // store, beside the Delivery Service; absent without it. Uploads pass gate 1's transfers rules as
  // the uploader is signed in now (its claim view's provider groups count, as in gate 1). Downloads
  // recheck gates 1 and 2 before every chunk for the principal that published the reference, as at
  // dispatch of a queued message: its member credential, claim view and broker sign-in now. A
  // relation kept without a principal serves no other member (as a message queued without one).
  const transferReach = (fromMember, toMember, sender) => {
    if (fromMember === toMember) return "allow";
    if (!sender) return "deny";
    return e2eeReach(null, fromMember, toMember, sender);
  };
  const mayUpload = (ws) => {
    if (!access) return "allow";
    const from = fromOf(ws);
    if (hostedFenced() && isHosted(from.memberId)) return "retry"; // design 4.5
    if (!credentials.some((c) => c.member && c.memberId === from.memberId)) return "deny";
    if (from.family && !broker?.familyLive(from.family)) return "deny";
    return access.mayUpload(from);
  };
  const transferFrames = devices?.ds && devices.transfers ? createTransferFrames({ transfers: devices.transfers, proofs, reach: transferReach, mayUpload, log, fenced: () => devicesFenced }) : null;
  const deviceFrames = devices ? createDeviceFrames({ ...devices, proofs, attachHere: !e2eeFrames, visible: devices.visible ?? accessVisible, realm: realmInfo.id, log, fenced: () => devicesFenced, revoked: () => e2eeFrames?.revalidate(), hosted: (id) => isHosted(id) }) : null;
  const applyDeviceRevocations = () => {
    if (!deviceFrames) return true;
    const list = credentials.flatMap((c) => (c.devicesRevoked ?? []).map((device) => ({ member: c.memberId, device })));
    try {
      const n = devices.directory.applyAdminRevocations(list);
      if (n) log(`devices: ${n} device${n === 1 ? "" : "s"} revoked by the members file`);
      if (n) audit("devices.admin_revoked", { devices: n }); // a security event of the relay's own (design 4.4)
      if (devicesFenced) log("devices: the members file's device revocations are stored; device service resumes");
      devicesFenced = null;
      e2eeFrames?.revalidate(); // attached devices revoked now stop receiving at once
      return true;
    } catch (e) {
      devicesFenced = e.message;
      log("devices: applying the members file's device revocations failed; device service is paused until they are stored:", e.message);
      return false;
    }
  };
  if (!applyDeviceRevocations()) throw new Error(`the members file's device revocations could not be stored (${devicesFenced}); the relay does not start`);
  checkCustody(credentials, null);
  // Opt-in keyed fingerprints: computed per log event from the text held at that moment, and
  // kept out of message objects (they are spread into frames sent to clients).
  const fp = checkFingerprint(fingerprint);
  const tag = (msg) => (fp ? [fingerprintSuffix(fp, msg.message_id, msg.text)] : []);
  const logQueued = (to, msg) => fp && log("queued", `ref ${msg.message_id} delivery ${msg.id}`, "for", to, ...tag(msg));

  // Access (design 4.1/4.2, lib/access.js): gates 1 and 2 for every list, send, fan-out and
  // dispatch. Hidden members need a members-only realm: a shared token could use any name.
  // A sender is {memberId, identity, family}: identity is its claim-view key (sign-ins only; member
  // and shared tokens carry no provider groups), family its broker sign-in, if any.
  const memberOf = (ownerKey) => (typeof ownerKey === "string" && ownerKey.startsWith("member:") ? ownerKey.slice(7) : null);
  const fromOf = (ws) => ({ memberId: ws.cred?.member ? ws.cred.memberId : null, identity: ws.accessIdentity ?? null, family: ws.oidc?.family ?? null });
  /**
   * The principal queued with an encrypted message, also without access configured (so that a
   * policy added later can recheck it): a sign-in keeps its claim-view key even when no view was
   * recorded for it, which then never counts as a fresh view.
   */
  const senderOf = (ws) => ({ ...fromOf(ws), identity: ws.accessIdentity ?? (ws.oidc ? `${ws.oidc.issuer}|${ws.oidc.subject}` : null) });
  /** The member holding `peerName`, with the claim view of its last sign-in seen by this relay. */
  const recipientOf = (peerName) => {
    const p = peers.get(peerName);
    return { memberId: memberOf(p?.owner), identity: p?.accessIdentity ?? null };
  };
  /**
   * Gates 1 and 2 from a sender to the member holding `peerName`: "allow", "deny", "hold" or
   * "reply" (only a reply allowance can pass gate 2). A sender whose member credential is gone, or
   * whose broker sign-in ended, reaches nobody, also with messages it queued before.
   */
  const reach = (from, peerName, o = {}) => {
    if (!access) return "allow";
    // The hosted-custody fence (design 4.5) before the gates: a hosted party is never evaluated
    // while it is up. A send to a hosted member answers as for an unknown name, with the same
    // work (and no reply allowance is consulted); anything else with a hosted party is held.
    if (hostedFenced()) {
      if (isHosted(from.memberId)) return o.send ? "deny" : "hold";
      if (isHosted(recipientOf(peerName).memberId)) {
        if (!o.send) return "hold";
        const v = access.decide(from, { memberId: `unknown:${peerName}`, identity: null }, o);
        return v === "retry" ? "retry" : "deny";
      }
    }
    if (from.memberId && !credentials.some((c) => c.member && c.memberId === from.memberId)) return "deny";
    if (from.family && !broker?.familyLive(from.family)) return "deny";
    // An unknown name takes the same path as a member with no grants (hidden discovery timing).
    return access.decide(from, peers.has(peerName) ? recipientOf(peerName) : { memberId: `unknown:${peerName}`, identity: null }, o);
  };
  if (access && token && credentials.some((c) => c.member && access.hidden(c.memberId))) {
    throw new Error("this realm has hidden members, which needs a members-only relay: remove the shared token (HOPTELL_TOKEN) or unhide them");
  }
  /**
   * Note a fresh authentication of a signed-in `ws` in its identity's claim view (gate 1 group
   * claims), for every mode, before the connection can send. The version is the source's issue
   * time (a broker sign-in's verification); a token without one closes the view (it cannot be
   * ordered). Returns false when the view could not be recorded (the caller refuses).
   */
  function noteAuth(ws, cred = ws.cred) {
    if (!access || !cred || !ws.oidc) return true;
    ws.accessIdentity = `${ws.oidc.issuer}|${ws.oidc.subject}`;
    try {
      access.noteAuth(ws.accessIdentity, {
        version: ws.oidc.version ?? null,
        groups: (ws.oidc.groups ?? []).map((g) => `${ws.oidc.issuer}|${g}`),
        freshUntil: ws.oidc.freshUntil ?? ws.oidc.deadline,
        memberId: cred.memberId,
      });
      return true;
    } catch (e) {
      log("access: a sign-in could not be recorded:", e.message);
      return false;
    }
  }

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
            // The same token (same issue time) with other groups is a conflict: closed until a newer token.
            ws.oidc.groups = id.groups;
            if (!noteAuth(ws)) return cutOff(ws, "sign-in could not be recorded");
            arm();
          },
          (e) => {
            if (!current() || ws.oidc.token !== token) return;
            if (e.code !== "unavailable") {
              access?.invalidate(`${ws.oidc.issuer}|${ws.oidc.subject}`, "token revoked");
              return cutOff(ws, "token revoked");
            }
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
    appTunnel?.closed(ws);
    if (ws.peerName) claims.revoke(ws.peerName, ws);
    if (online.get(ws.peerName)?.ws === ws) {
      online.delete(ws.peerName);
      peers.get(ws.peerName).lastSeen = Date.now();
      log("disconnected", ws.peerName, `(${reason})`);
    }
    ws.close(4003, reason);
    setTimeout(() => ws.terminate(), 2000).unref();
  }

  /** The host whose token this is (design 4.5), or null; compares against every host in constant time. */
  function authenticateHost(t) {
    if (typeof t !== "string") return null;
    const d = digest(t);
    let found = null;
    for (const h of credentials.hosts ?? []) if (crypto.timingSafeEqual(d, h.digest) && !found) found = h;
    return found;
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
  const counts = { logins: 0, authFailures: 0, accepted: 0, deliveries: 0, expired: 0, rateLimited: 0, queueFull: 0, takeovers: 0, queueDropped: 0, refusedByPolicy: 0, recipientMismatch: 0 };
  const claims = new ClaimTable();
  /** set_title and set_status budgets: lease id -> times, principal key -> times (accepted attempts in the window). */
  const titleBudget = { claims: new Map(), principals: new Map() };
  const statusBudget = { claims: new Map(), principals: new Map() };
  /** Charge one update to the claim and its principal, or false when either is over budget. */
  function chargeTitle(lease, principal, budget = titleBudget) {
    const now = Date.now();
    const recent = (m, k) => (m.get(k) ?? []).filter((t) => now - t < TITLE_WINDOW_MS);
    const c = recent(budget.claims, lease);
    const p = recent(budget.principals, principal);
    if (c.length >= TITLE_PER_CLAIM || p.length >= TITLE_PER_PRINCIPAL) return false;
    budget.claims.set(lease, [...c, now]);
    budget.principals.set(principal, [...p, now]);
    return true;
  }

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
    appTunnel?.closed(previous);
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
      // to_member and as_holder join only when present, so the digests recorded for earlier sends
      // (reply allowances keep theirs durably) stay the same. as_holder adds two entries (a marker
      // and the value), so no to_member value alone can stand for it.
      .update(JSON.stringify([m.to, m.text, m.ttl ?? null, typeof m.reply_to === "string" ? m.reply_to.toLowerCase() : (m.reply_to ?? null), ...(m.to_member !== undefined ? [m.to_member] : []), ...(m.as_holder !== undefined ? ["as_holder", m.as_holder] : [])]))
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
  // Replies accepted through an allowance in this relay's lifetime (message id -> {at, recipient}), so a
  // repeated reply operation is answered, not accepted twice.
  const acceptedReplies = new Map();
  // Queued messages and bytes per sender (member id, or one quota for shared-token senders).
  const bySender = new Map();
  const senderKey = (msg) => (msg.sender?.member?.id ? `member:${msg.sender.member.id}` : msg.sender?.auth === "shared" ? "shared" : null);
  const msgBytes = (msg) => Buffer.byteLength(msg.text ?? "", "utf8");
  function counted(msg, sign) {
    const k = senderKey(msg);
    if (!k) return;
    const c = bySender.get(k) ?? { n: 0, bytes: 0 };
    c.n += sign;
    c.bytes += sign * msgBytes(msg);
    c.n > 0 ? bySender.set(k, c) : bySender.delete(k);
  }
  // A sender's charge covers a message from its acceptance until it is confirmed, expires, is
  // refused at dispatch or dropped: queued and in flight alike, so moving between the two keeps it.
  const charged = new WeakSet();
  const charge = (msg) => charged.has(msg) || (charged.add(msg), counted(msg, 1));
  const release = (msg) => charged.has(msg) && (charged.delete(msg), counted(msg, -1));
  /** Whether the sender of `msg` has room for one more outstanding message. */
  function senderRoom(msg) {
    const c = bySender.get(senderKey(msg));
    return !c || (c.n < MAX_QUEUED_PER_SENDER && c.bytes + msgBytes(msg) <= MAX_QUEUED_BYTES_PER_SENDER);
  }
  /** Whether a new message may be queued for `to` (queue, global and per-sender limits). */
  function canEnqueue(to, msg) {
    const p = peers.get(to);
    if (!p || p.queue.length >= MAX_QUEUE_PER_PEER || queuedTotal >= MAX_QUEUED_TOTAL) return false;
    return senderRoom(msg);
  }
  function enqueue(to, msg, front = false, force = false) {
    const p = peers.get(to);
    if (!p) return false;
    if (!force && !canEnqueue(to, msg)) {
      counts.queueFull++;
      return false;
    }
    front ? p.queue.unshift(msg) : p.queue.push(msg);
    queuedTotal++;
    charge(msg);
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
  // A direct send from a protocol-2 sender learns who the relay delivers to (design 5.1: review sets
  // record their recipient); kept beside the message, never forwarded with it.
  const recipients = new WeakMap();
  const ackMeta = (msg) => ({ message_id: msg.message_id, ...(msg.expires ? { expires: msg.expires } : {}), ...(recipients.has(msg) ? { recipient: recipients.get(msg) } : {}) });

  /** Deliver queued messages for `to` while it is online and under its unconfirmed limit. */
  function flush(to) {
    const p = peers.get(to);
    if (!online.has(to) || !p?.queue.length) return;
    let room = MAX_INFLIGHT_PER_PEER - inflightTo(to);
    // inflightTo counts every connection of `to`, including one that is still closing.
    // Gates 1 and 2 again at dispatch, against the current policy, grants, time and the sender's
    // claim view: refused messages are dropped silently; a stale view holds them (and the sender's
    // later messages, to keep its order) for another try.
    const held = [];
    const heldFrom = new Set();
    while (room > 0 && p.queue.length && online.has(to)) {
      queuedTotal--;
      const msg = p.queue.shift();
      if (expired(msg)) {
        dropExpired(to, msg);
        release(msg);
        continue;
      }
      const key = msg.access?.identity ?? msg.access?.memberId ?? msg.from;
      const verdict = heldFrom.has(key) ? "hold" : msg.access ? reach(msg.access, to, msg.access.reply ? { replyTo: msg.reply_to, usedBy: msg.message_id } : {}) : "allow";
      if (verdict === "deny") {
        counts.refusedByPolicy++;
        release(msg);
        continue;
      }
      if (verdict === "hold") {
        heldFrom.add(key);
        held.push(msg);
        continue;
      }
      forward(to, msg, null);
      room--;
    }
    if (held.length) {
      p.queue.unshift(...held);
      queuedTotal += held.length;
    }
  }

  /**
   * Whether `member` holds `name` now: its live connection, else its claim (live or reserved),
   * else the principal that last held it (a queued send to a peer offline past its grace).
   */
  function heldBy(name, member) {
    const holder = online.get(name)?.ws.principal ?? claims.owner(name) ?? peers.get(name)?.principal ?? null;
    return holder?.kind === "member" && holder.id === member;
  }

  /** Deliver `msg` to online `to`; `reply(frame)` reports the first acknowledgement to the sender. */
  function forward(to, msg, reply) {
    // The delivery id stays the same across redeliveries (receivers use it to store a message
    // once); acknowledgements count only from the socket it was sent to (see "got").
    const target = online.get(to);
    // A send bound to a member (to_member) is delivered only while that member holds the name:
    // checked before every forward, requeue and redelivery, also after a handoff, release, replace
    // or acquire. Otherwise it is dropped, never delivered; its sender already had its ack.
    if (msg.to_member !== undefined && !(target.ws.principal?.kind === "member" && target.ws.principal.id === msg.to_member)) {
      counts.recipientMismatch++;
      release(msg);
      log("dropped", `ref ${msg.message_id} delivery ${msg.id}`, "for", to, "(the name is held by another member than the send requires)", ...tag(msg));
      if (reply) reply({ type: "error", code: "recipient_member_mismatch", error: `${to} is not held by the member this send requires` });
      return;
    }
    charge(msg); // outstanding until confirmed, also when it goes back to the queue just below
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
    delete frame.access; // the relay's own record of the sender for its gates
    delete frame.to_member; // the relay's own condition; receivers check their envelope
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

  // The owner channel's Mini App (design 7.4): /app/<id>/ is forwarded to the bridge that owns the id.
  const appTunnel = ownerApp ? createAppTunnel({ stateDir: ownerApp.stateDir, limits: ownerApp.limits ?? null, now: ownerApp.now, audit, log }) : null;
  const appCaps = appTunnel ? [OWNER_APP_CAP] : [];
  const server = http.createServer((req, res) => {
    if (appTunnel?.handles(req.url)) {
      appTunnel.handle(req, res, clientAddress(req, trustedProxies).client);
    } else if (broker?.handles(req.url)) {
      broker.handle(req, res, clientAddress(req, trustedProxies).client).catch(() => res.destroy());
    } else if (req.url === "/.well-known/hoptell" && oidc?.discovery) {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "max-age=300" }).end(JSON.stringify(oidc.discovery));
    } else if (req.url === "/healthz") {
      res.writeHead(200, { "content-type": "text/plain" }).end("ok\n");
    } else {
      res.writeHead(426, { "content-type": "text/plain" }).end("hoptell relay: connect with a hoptell client (WebSocket)\n");
    }
  });
  // With encrypted messages a frame over the bound is answered with a refusal (it is checked on
  // the complete serialized frame), so the socket's own limit sits above it; without them the
  // socket closes at the bound, as always.
  const wss = new WebSocketServer({ noServer: true, maxPayload: e2eeFrames ? 2 * MAX_FRAME_BYTES : 512 * 1024 });
  // Broker mode: the broker sees this relay's members (the loaded ones are applied at once, before
  // any connection) and ends the connections of ended families.
  broker?.attach({
    members: () => credentials,
    fence: (families) => {
      for (const ws of wss.clients) if (ws.oidc?.family && families.has(ws.oidc.family)) cutOff(ws, "token revoked");
    },
  });
  // Held or queued messages may go after a change of claims, grants or policy (design 4.1).
  // The hosted-custody fence (design 4.5) follows the policy: open hosted connections are cut when
  // it goes up; when it goes down, the flush below dispatches held work through the member-id gates.
  let fenceWas = hostedFenced();
  if (fenceWas) log(`hosted custody is fenced: the access policy has provider groups (oidcGroups); hosted connections are refused and work with hosted members is held`);
  const applyFence = () => {
    const up = hostedFenced();
    if (up) for (const ws of wss.clients) if (ws.custody) cutOff(ws, "hosted custody fenced");
    if (up !== fenceWas) {
      fenceWas = up;
      if (up) {
        const n = heldForHosted();
        log(`hosted custody is fenced: the access policy has provider groups (oidcGroups); ${plural(n, "queued message")} with a hosted party ${n === 1 ? "is" : "are"} held`);
      } else log("hosted custody fence lifted: held messages are dispatched through the member gates");
    }
  };
  access?.subscribe(() => {
    applyFence();
    // A pending mark that went (a grants publish, an accepted or deny-forever contact request, a
    // reload): the sessions told it was pending learn that it is not. Only the member's own.
    for (const { ws: o } of online.values()) {
      if (o.grantsPendingTold && !access.isPending(o.cred?.memberId)) {
        o.grantsPendingTold = false;
        send(o, { type: "notice", kind: "grants_pending", pending: false });
      }
    }
    for (const n of online.keys()) flush(n);
  });
  server.on("upgrade", (req, socket, head) => {
    // The app's paths are plain HTTP only (design 7.4, section 2), whether or not the app is on.
    if (typeof req.url === "string" && (req.url === "/app" || req.url.startsWith("/app/") || req.url.startsWith("/app?"))) {
      socket.end("HTTP/1.1 400 Bad Request\r\nconnection: close\r\ncontent-length: 0\r\n\r\n");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });
  server.on("clientError", (_e, socket) => socket.destroy());

  wss.on("connection", (ws, req) => {
    ws.conn = newConnId(); // A9: this connection's id, announced in the protocol-2 welcome
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
        if (e2eeFrames && raw.length > MAX_FRAME_BYTES) return ws.close(1009, "Max payload size exceeded");
        if (!name) return ws.close(4001, "bad hello");
        return send(ws, { type: "error", error: "bad frame" });
      }
      if (e2eeFrames && raw.length > MAX_FRAME_BYTES) {
        // Over the bound: an encrypted-message frame is refused, anything else closes as before.
        if (!name || !e2eeFrames.handles(m.type)) return ws.close(1009, "Max payload size exceeded");
        return send(ws, { type: "error", id: m.id, code: "too_large", error: `the frame has ${raw.length} bytes; at most ${MAX_FRAME_BYTES}` });
      }

      if (!name) {
        // Close reasons are fixed strings: they must stay under the 123-byte WebSocket limit.
        if (m.type !== "hello") return ws.close(4001, "hello first");
        const v = m.v === undefined ? 1 : m.v;
        if (v !== 1 && v !== 2) return ws.close(4005, "unsupported protocol version");
        // A refusal for a protocol-2 client: a typed error first, then the fixed close.
        const refuse = (code, close, reason, retryAfterMs, extra = {}) => {
          if (v === 2) send(ws, { type: "hello_error", code, ...(retryAfterMs ? { retry_after_ms: retryAfterMs } : {}), ...extra });
          return ws.close(close, reason);
        };
        if (ws.authenticating) return; // a sign-in is being checked: nothing else until it is
        const str = (x) => x === undefined || typeof x === "string";
        const auto = v === 2 && m.name === null && m.auto && typeof m.auto === "object" && str(m.auto.host) && ["string", "number", "undefined"].includes(typeof m.auto.n);
        const signIn = v === 2 && m.auth && typeof m.auth === "object" && ["oidc", "broker"].includes(m.auth.kind) && typeof m.auth.token === "string" && typeof m.auth.issuer === "string";
        // A host for one of its hosted members (design 4.5): protocol 2 only.
        const hostAuth = v === 2 && m.auth && typeof m.auth === "object" && m.auth.kind === "host" && typeof m.auth.token === "string" && typeof m.auth.member === "string";
        if (hostAuth) {
          if (typeof m.name !== "string" || !str(m.mode) || !str(m.host) || (m.roles !== undefined && !Array.isArray(m.roles))) return refuse("bad_claim", 4001, "bad hello");
          const sendOnlyHost = m.mode === "send";
          if (sendOnlyHost ? m.claim !== undefined : !m.claim || typeof m.claim !== "object") return refuse("bad_claim", 4001, "bad hello");
          const h = authenticateHost(m.auth.token);
          if (!h) {
            counts.authFailures++;
            log("host auth failed from", addr);
            return refuse("bad_token", 4003, "bad token");
          }
          // Only members whose custody names this host; any other member is refused alike.
          const cred = credentials.find((c) => c.member && c.memberId === m.auth.member && c.custody === "hosted" && c.host === h.id);
          if (!cred) {
            counts.authFailures++;
            log(`host ${h.id} tried to open a member it does not hold, from`, addr);
            // "not_held": the relay's explicit answer; the host treats it, confirmed, as a removal.
            return refuse("not_held", 4003, "member not held by this host");
          }
          if (hostedFenced()) {
            log(`host ${h.id}: hosted connection refused (hosted custody is fenced: the access policy has provider groups)`);
            return refuse("unavailable", 4003, "hosted custody is fenced on this relay");
          }
          ws.custody = { kind: "hosted", host: h.id, digest: h.digest };
          return finishHello(m, v, cred, refuse, false, sendOnlyHost);
        }
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
          ws.oidc = { gen: 1, kind: "broker", issuer: id.issuer, issuerId: id.issuerId, subject: id.subject, family: id.family, deadline: id.deadline, opaque: false, checkedAt: Date.now(), token: null, groups: id.groups ?? [], version: id.verifiedAt, freshUntil: id.reverifyAt };
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
              ws.oidc = { gen: 1, issuer: id.issuer, subject: id.subject, deadline: id.deadline, opaque: id.opaque, checkedAt: id.checkedAt ?? Date.now(), token: id.opaque ? m.auth.token : null, groups: id.groups, version: id.issuedAt };
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
          Object.assign(ws.oidc, { gen: ws.oidc.gen + 1, family: id.family, deadline: id.deadline, checkedAt: Date.now(), groups: id.groups ?? ws.oidc.groups, version: id.verifiedAt, freshUntil: id.reverifyAt });
          if (!noteAuth(ws)) return cutOff(ws, "sign-in could not be recorded");
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
            Object.assign(ws.oidc, { gen: gen + 1, deadline: id.deadline, opaque: id.opaque, checkedAt: id.checkedAt ?? Date.now(), token: id.opaque ? m.token : null, groups: id.groups, version: id.issuedAt });
            if (!noteAuth(ws)) return cutOff(ws, "sign-in could not be recorded");
            watchSignIn(ws);
            send(ws, { type: "reauth_ok", id: m.id, auth_expires_at: id.deadline });
          },
          (e) => {
            if (ws.readyState !== 1) return;
            send(ws, { type: "error", id: m.id, code: e.code ?? "bad_token", error: e.message });
          },
        );
      }
      ws.frameBytes = raw.length;
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
          // The member's own name tells it which names it may use (it holds this member's credential).
          return refuse("not_allowed", 4002, "name not allowed for this member token", undefined, cred.member ? { member: cred.member } : {});
        }
        // A hosted member's names belong to its host's connections only (design 4.5): a shared
        // token, which may otherwise use any name, cannot take them.
        if (!ws.custody && hostedName(wanted)) return refuse("not_allowed", 4002, "name not allowed for this member token");
        const roles = Array.isArray(m.roles) ? m.roles : [];
        if (roles.length > MAX_ROLES || !roles.every((r) => typeof r === "string" && NAME_RE.test(r))) return refuse("bad_claim", 4002, "bad roles");
        // A realm that requires grants or hides members refuses protocol-1 clients (they cannot
        // be granted or filtered): a refusal, never a silent fallback.
        if (v !== 2 && access?.strict()) return refuse("not_allowed", 4003, "this relay requires a newer hoptell (protocol 2)");
        // Every mode records its sign-in first: a send-only connection is gated like a peer.
        if (!noteAuth(ws, cred)) return refuse("unavailable", 1013, "sign-in could not be recorded; try again");
        const welcome = (claim) => ({
          type: "welcome",
          name: wanted,
          auth: authMode(),
          ...(v === 2 ? { realm: realmInfo, member: cred.member ? { id: cred.memberId, name: cred.member, ...(cred.custody ? { custody: cred.custody } : {}) } : null, claim: claim ?? null, incarnation: claims.incarnation, caps: [...(verifier || broker ? [...CAPS, ...(verifier ? ["oidc"] : []), ...(broker ? ["broker"] : []), "reauth"] : CAPS), ...(deviceFrames ? [DEVICE_CAP, ATTACH_PROOF_CAP] : []), ...(e2eeFrames ? [E2EE_CAP] : []), ...(transferFrames ? [TRANSFER_CAP] : []), ...appCaps], ...(ws.oidc ? { auth_expires_at: ws.oidc.deadline } : {}), ...(deviceFrames ? { conn: ws.conn } : {}) } : {}),
        });
        if (sendOnly) {
          clearTimeout(helloTimer);
          Object.assign(ws, { cred, principal, version: v, peerName: wanted, peerHost });
          name = wanted;
          mode = "send";
          counts.logins++;
          return send(ws, welcome(null));
        }
        // A title only on a protocol-2 receiving hello, and only for a new claim (claims.js).
        const decision = claims.hello({ name: wanted, socket: ws, principal, version: v, claim: m.claim, title: v === 2 ? cleanTitle(m.title) : null });
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
          for (const msg of p.queue) release(msg);
          log("queue dropped", name, `(${p.queue.length} messages for a previous owner)`);
          p.queue = [];
        }
        peers.set(name, Object.assign(p, { host: peerHost, roles, lastSeen: Date.now(), owner, principal, accessIdentity: ws.accessIdentity ?? null }));
        log("connected", name, roles.length ? `[${roles.join(",")}]` : "", "from", peerHost, addr, v === 2 ? `(${m.claim.action})` : "");
        send(ws, welcome(decision.claim));
        // Contact requests already waiting for this member's owner (design 4.1): the count only.
        if (access && v === 2 && cred.member) {
          const count = access.requestsFor(cred.memberId).length;
          if (count) send(ws, { type: "notice", kind: "contact_requests", count });
          // A restore lost the access state (design 4.4): this member must publish its grants
          // again before messages reach it. Told to the member itself only (F6: no other sender
          // learns which names are pending).
          if (access.isPending(cred.memberId)) {
            ws.grantsPendingTold = true; // told "not pending" when the mark goes (see the access listener)
            send(ws, { type: "notice", kind: "grants_pending", pending: true });
          }
        }
        return flush(name);
      }
    }

    /** Frames of a logged-in connection. */
    function afterLogin(m) {
      if (ws.custody) {
        // A hosted connection (design 4.5): cut once the fence is up (also before the policy
        // listener runs); no device or encryption frames (the host holds no keys); grants and
        // contact-request answers are not set through the host in v1 (owner open point).
        if (hostedFenced()) return cutOff(ws, "hosted custody fenced");
        if (deviceFrames?.handles(m.type) || e2eeFrames?.handles(m.type) || ["grants_put", "contact_request_answer"].includes(m.type)) {
          return send(ws, { type: "error", id: m.id, code: "not_allowed", error: "not available for a hosted member" });
        }
      }

      if (m.type === "got") {
        const f = inflight.get(m.id);
        if (f && f.ws === ws) {
          clearTimeout(f.timer);
          inflight.delete(m.id);
          release(f.msg);
          log("receipt acknowledged", `ref ${f.msg.message_id} delivery ${f.msg.id}`, "by", f.to, ...tag(f.msg));
          // A reply allowance only for a message the receiver released to its session (gate 3), not
          // one it merely stored (held back by its contacts).
          if (access && m.released === true && f.msg.access?.memberId) access.noteRelease(f.msg.access.memberId, recipientOf(f.to).memberId, f.msg.message_id);
          if (f.reply) f.reply({ type: "ack", state: "delivered", ...ackMeta(f.msg) });
          flush(name); // room for more
        }
        return;
      }

      if (appTunnel && (m.type === "app_register" || m.type === "app_unregister")) {
        // The owner channel's Mini App (design 7.4, section 3): only a member-token peer that holds its name.
        // A signed-in connection past its deadline or freshness bound holds nothing, also before its
        // timer runs: a request (with its credentials) is never forwarded to it.
        const holds = () => {
          if (pastDeadline(ws)) {
            setImmediate(() => cutOff(ws, "token expired"));
            return false;
          }
          return mode === "peer" && ws.version === 2 && !ws.revoked && !ws.fenced && claims.isCurrent(name, ws);
        };
        const r = m.type === "app_register" ? appTunnel.register(ws, m, { holds }) : appTunnel.unregister(ws, m, { holds });
        return send(ws, r.ok ? { type: "app_ok", id: m.id, state: r.state } : { type: "error", id: m.id, code: r.error, error: r.text });
      }
      if (appTunnel && m.type === "app_res") return appTunnel.response(ws, m, ws.frameBytes ?? 0);

      if (m.type === "release") {
        // A clean shutdown of a protocol-2 session: the name is free at once, not reserved.
        if (ws.version === 2 && mode === "peer") claims.release(name, ws);
        appTunnel?.closed(ws); // an app is served only while its bridge holds the name
        return;
      }

      if (m.type === "claim_status") {
        if (ws.version !== 2 || typeof m.name !== "string" || !NAME_RE.test(m.name)) return send(ws, { type: "error", id: m.id, error: "bad claim_status" });
        // Only names this credential may claim are described; others are just "taken".
        const st = nameAllowed(ws.cred, m.name) ? claims.status(m.name, ws.principal) : { state: "taken" };
        return send(ws, { type: "claim_status", id: m.id, state: st.state, ...(st.retryAfterMs ? { retry_after_ms: st.retryAfterMs } : {}) });
      }

      if (m.type === "list") {
        const me = fromOf(ws);
        // `own` (cap list_own): for a caller signed in with a member token, whether the name's
        // current holder (its live connection, else its last principal) is that member. A name's
        // shape proves nothing: a shared token may claim any name.
        const mine = ws.cred?.member && ws.cred.memberId ? ws.cred.memberId : null;
        const holderOf = (n, p) => {
          const live = online.get(n)?.ws?.principal;
          return live ? principalKey(live) : p.owner;
        };
        // `status` (cap status): asked for by a member caller, and only of a claim that member set.
        const statusFor = (n) => {
          if (!mine || m.status !== true) return null;
          const st = claims.statusOf(n);
          return st && memberOf(principalKey(st.principal)) === mine ? st.status : null;
        };
        const list = [...peers.entries()]
          .filter(([n]) => n !== name && reach(me, n) === "allow")
          .map(([n, p]) => {
            // The title of this name's own current claim: never derived from any other name.
            const title = claims.titleOf(n);
            const own = mine ? memberOf(holderOf(n, p)) === mine : null;
            const status = own ? statusFor(n) : null;
            return { name: n, host: p.host, roles: p.roles || [], online: online.has(n), queued: p.queue.length, ...(isHosted(memberOf(p.owner)) ? { custody: "hosted", member_id: memberOf(p.owner) } : {}), ...(mine ? { own } : {}), ...(title ? { title } : {}), ...(status ? { status } : {}) };
          });
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
        const toMember = m.to_member;
        if (toMember !== undefined && (ws.version !== 2 || typeof toMember !== "string" || !TO_MEMBER_RE.test(toMember))) return fail("`to_member` must be a member id (protocol 2)");
        if (toMember !== undefined && typeof to === "string" && to.startsWith("@")) return fail("`to_member` applies to a send to one peer name only");
        if (m.as_holder !== undefined) {
          // A send-only connection sending for the session that holds its name (a sibling process
          // waiting for that name): only while a peer connection of this principal holds it, so the
          // message's name, and the replies to it, belong to this principal. Checked here, when
          // the send executes; send-only connections are never in `online`.
          if (m.as_holder !== true || ws.version !== 2 || mode !== "send") return fail("`as_holder` is true, from a protocol-2 send-only connection");
          const key = (p) => {
            try {
              return p ? principalKey(p) : null;
            } catch {
              return null; // not an authenticated principal: never a match
            }
          };
          // The holder: the online peer socket whose claim is still current (a released name's
          // socket may stay open a moment, but it no longer holds the name).
          const held = online.get(name)?.ws;
          const mine = key(ws.principal);
          if (!mine || !held || !claims.isCurrent(name, held) || key(held.principal) !== mine) return reply({ type: "error", code: "not_holder", error: `the name ${name} is not held by a session of this principal` });
        }
        if (!text.trim()) return fail("empty message");
        if (text.length > MAX_TEXT) return fail(`message is longer than ${MAX_TEXT} characters`);
        const noReply = mode === "send" && !peers.has(name);
        const expiry = ttl ? { expires: Date.now() + ttl * 1000 } : {};
        // One reference per accepted send, shared by its fan-out copies; each copy gets its own delivery id.
        const ref = { message_id: crypto.randomUUID(), ...(replyTo ? { reply_to: replyTo } : {}) };
        // Hosted members' messages carry custody "hosted" provenance (design 4.5).
        const sender = { member: ws.cred.member ? { id: ws.cred.memberId, name: ws.cred.member } : null, auth: ws.cred.member ? "member" : "shared", realm: realmInfo.id, ...(ws.cred.custody === "hosted" ? { custody: "hosted" } : {}) };
        const me = fromOf(ws);
        const msg = () => ({ id: crypto.randomUUID(), ...ref, from: name, fromHost: ws.peerHost, to, text, ts: Date.now(), ...expiry, ...(noReply ? { noReply } : {}), sender, ...(access ? { access: me } : {}) });
        const refs = `ref ${ref.message_id}${replyTo ? ` reply-to ${replyTo}` : ""}`;

        if (to.startsWith("@")) {
          // Fan-out to every online peer with the role ("@all": everyone). Not queued for offline peers.
          const role = to.slice(1);
          // exclude_hosted (design 4.5): a sender under an encryption policy never gets a hosted copy.
          const targets = [...online.entries()].filter(([n, o]) => n !== name && (role === "all" || o.roles.includes(role)) && !(m.exclude_hosted === true && isHosted(memberOf(peers.get(n)?.owner))) && reach(me, n) === "allow").map(([n]) => n);
          if (!targets.length) return fail(role === "all" ? "no other peer is online" : `no online peer has the role "${role}"`);
          // Busy peers get it queued behind their unconfirmed messages; only a full queue skips one.
          const skipped = [];
          for (const t of targets) {
            const copy = msg();
            if (hasRoom(t) && !peers.get(t).queue.length && senderRoom(copy)) forward(t, copy, null);
            else if (enqueue(t, copy)) logQueued(t, copy);
            else skipped.push(t);
          }
          const count = targets.length - skipped.length;
          const summary = count ? tag({ message_id: ref.message_id, text }) : [];
          log(name, "->", to, `(${count} peers${skipped.length ? `, skipped ${skipped.join(",")}` : ""}, ${text.length} chars)`, refs, ...summary);
          if (!count) return fail(`every peer matching ${to} is busy and its queue is full`);
          counts.accepted++; // once per send, however many copies
          // With access configured, skipped names are not reported (they could reveal hidden peers).
          return reply({ type: "ack", state: "fanout", count, ...(access?.active() ? {} : { skipped }), message_id: ref.message_id, ...expiry });
        }

        if (to === name) return fail("cannot message yourself");
        // An unreachable peer answers exactly like an unknown one (hidden discovery); the gates run
        // for every name, known or not, so both take the same work.
        const verdict = reach(me, to, { replyTo, send: true });
        // Unresolved access on the sender's side: one answer for every target, known or not.
        if (verdict === "retry") return fail("the relay cannot check your access right now; renew your sign-in or try again shortly");
        // "unknown peer" stays first: older clients (owner channel bridges) recognize the refusal by it.
        if (!peers.has(to) || verdict === "deny") return fail(`unknown peer "${to}" (no such peer, or not available to you): list visible peers with hoptell list or the list_peers tool`);
        // to_member at acceptance: the name must be held by that member, or (queued) its claim
        // record must belong to it.
        if (toMember !== undefined && !heldBy(to, toMember)) return reply({ type: "error", code: "recipient_member_mismatch", error: `${to} is not held by member ${toMember}` });
        let first = msg();
        const direct = online.has(to) && hasRoom(to) && !peers.get(to).queue.length && senderRoom(first);
        if (!direct && !canEnqueue(to, first)) return fail(`${to} ${online.has(to) ? "is not confirming messages" : "is offline"} and its queue is full`);
        if (verdict === "reply") {
          // A reply allowance (design 4.2): used once, durably, before the reply is accepted, and
          // bound to this operation and its payload across the member's sessions and restarts.
          let u;
          try {
            u = access.useAllowance(me.memberId, recipientOf(to).memberId, replyTo, { op: m.op ?? null, digest: opDigest(m), messageId: first.message_id, deliveryId: first.id, ts: first.ts, expires: first.expires ?? null });
          } catch {
            return fail("the relay could not record this reply; try again");
          }
          if (u.use === "refused") return fail(`unknown peer "${to}" (no such peer, or not available to you): list visible peers with hoptell list or the list_peers tool`);
          if (u.use === "repeat") {
            // The first attempt's envelope, exactly: its ids and times, never a renewed expiry, and
            // the recipient binding its ack named.
            const original = u.expires ? { expires: u.expires } : {};
            if (acceptedReplies.has(u.messageId)) {
              const bound = acceptedReplies.get(u.messageId).recipient;
              return reply({ type: "ack", state: "queued", message_id: u.messageId, ...original, ...(ws.version === 2 && bound ? { recipient: bound } : {}) });
            }
            // Past its deadline: not accepted again (it would be revived). An error, so no client
            // reads it as sent; whether an earlier attempt was delivered is not known here.
            if (u.expires && u.expires <= Date.now()) {
              return reply({ type: "error", code: "expired", message_id: u.messageId, expires: u.expires, error: `this retry was not queued: the deadline of message ${u.messageId} passed at ${new Date(u.expires).toISOString()} (an earlier attempt may have been delivered)` });
            }
            // A use recorded but never accepted here (its answer was lost, or the relay restarted):
            // accepted now as recorded, so a receiver stores it at most once.
            const { expires: _renewed, ...rest } = first;
            void _renewed;
            first = { ...rest, id: u.deliveryId, message_id: u.messageId, ts: u.ts, ...original };
          }
          first = { ...first, access: { ...first.access, reply: true } };
        }
        if (toMember !== undefined) first = { ...first, to_member: toMember };
        // The target as the relay authenticated it (design 5.1): named in every ack of this direct
        // send to a protocol-2 sender, never forwarded with the message.
        const target = peers.get(to).principal;
        const recipient = target ? { auth: target.kind === "member" ? "member" : "shared", member: target.kind === "member" ? { id: target.id, name: target.name } : null, realm: realmInfo.id } : null;
        if (ws.version === 2 && recipient) recipients.set(first, recipient);
        // An accepted reply keeps its first ack's binding, for a repeat from another session.
        if (verdict === "reply") acceptedReplies.set(first.message_id, { at: Date.now(), recipient });
        if (direct) {
          counts.accepted++;
          forward(to, first, reply);
          log(name, "->", to, `(${text.length} chars)`, refs, ...tag({ message_id: first.message_id, text }));
          return;
        }
        const queued = first;
        if (!enqueue(to, queued)) return fail(`${to} ${online.has(to) ? "is not confirming messages" : "is offline"} and its queue is full`);
        counts.accepted++;
        log(name, "->", to, online.has(to) ? "(queued behind unconfirmed messages)" : "(queued, offline)", `(${text.length} chars)`, refs, ...tag(queued));
        logQueued(to, queued);
        return reply({ type: "ack", state: "queued", ...ackMeta(queued) });
      }

      if (m.type === "set_title") {
        // A session's own display title (cap set_title): only from the connection that holds the
        // claim now (the app_register predicate), within its budgets. Never affects a delivery.
        const err = (code, error) => send(ws, { type: "error", id: m.id, code, error });
        if (mode !== "peer" || ws.version !== 2 || ws.revoked || ws.fenced || !claims.isCurrent(name, ws)) return err("not_allowed", "only the session that holds this name can set its title");
        const lease = claims.leaseOf(name, ws);
        if (!lease) return err("not_allowed", "only the session that holds this name can set its title");
        if (!chargeTitle(lease, principalKey(ws.principal))) return err("title_rate", `too many title changes: at most ${TITLE_PER_CLAIM} a minute per session and ${TITLE_PER_PRINCIPAL} per member`);
        if (m.title !== null && (typeof m.title !== "string" || Buffer.byteLength(m.title, "utf8") > TITLE_MAX_BYTES)) return err("bad_request", `title must be text of at most ${TITLE_MAX_BYTES} bytes, or null`);
        const title = m.title === null ? null : cleanTitle(m.title); // nothing left after cleaning: no title
        claims.setTitle(name, ws, title);
        return send(ws, { type: "title_ok", id: m.id, title });
      }

      if (m.type === "set_status") {
        // A session's own owner-only status (cap status): the same holder check as set_title.
        const err = (code, error) => send(ws, { type: "error", id: m.id, code, error });
        if (mode !== "peer" || ws.version !== 2 || ws.revoked || ws.fenced || !claims.isCurrent(name, ws)) return err("not_allowed", "only the session that holds this name can set its status");
        const lease = claims.leaseOf(name, ws);
        if (!lease) return err("not_allowed", "only the session that holds this name can set its status");
        if (!chargeTitle(lease, principalKey(ws.principal), statusBudget)) return err("status_rate", `too many status changes: at most ${TITLE_PER_CLAIM} a minute per session and ${TITLE_PER_PRINCIPAL} per member`);
        if (m.status !== null && (typeof m.status !== "string" || !m.status.isWellFormed() || Buffer.byteLength(m.status, "utf8") > STATUS_MAX_BYTES)) return err("bad_request", `status must be text of at most ${STATUS_MAX_BYTES} bytes, or null`);
        claims.setStatus(name, ws, m.status === "" ? null : m.status);
        return send(ws, { type: "status_ok", id: m.id });
      }

      if (access && ["grants_get", "grants_put", "contact_request", "contact_requests", "contact_request_answer"].includes(m.type)) return accessFrame(m);
      if (deviceFrames?.handles(m.type)) return deviceFrames.handle(ws, m, (frame) => send(ws, { ...frame, id: m.id }));
      if (e2eeFrames?.handles(m.type)) return e2eeFrames.handle(ws, m, (frame) => send(ws, { ...frame, id: m.id }), send, mode);
      if (transferFrames?.handles(m.type)) return transferFrames.handle(ws, m, (frame) => send(ws, { ...frame, id: m.id }));

      send(ws, { type: "error", id: m.id, error: "unknown message type" });
    }

    /**
     * Grants and contact requests (design 4.1): a member manages only its own grants and requests;
     * a contact request gets the same answer and charge whatever its target.
     */
    function accessFrame(m) {
      const mine = ws.cred?.member ? ws.cred.memberId : null;
      const err = (code, error, extra = {}) => send(ws, { type: "error", id: m.id, code, error, ...extra });
      if (ws.version !== 2) return err("bad_request", "needs protocol 2");
      if (m.type === "contact_request") {
        if (!mine) return err("not_allowed", "contact requests need a member credential");
        if (typeof m.reason !== "undefined" && !REASONS.includes(m.reason)) return err("bad_request", `reason must be one of ${REASONS.join(", ")}`);
        const to = typeof m.to === "string" ? m.to : "";
        // Eligibility (gate 1, a fresh view, gate 2 refusing, not blocked, bounds) is decided
        // inside; the sender gets the same answer and charge in every case.
        let target = peers.has(to) ? recipientOf(to) : null;
        // The hosted-custody fence (design 4.5): a request to or from a hosted member answers as
        // for an unknown name, with the same charge, and is not stored.
        if (hostedFenced() && (isHosted(mine) || isHosted(target?.memberId))) target = null;
        const r = access.requestContact({ ...fromOf(ws), name: ws.cred.member }, target, m.reason);
        if (r.limited) return err("quota", "too many contact requests today");
        const rid = r.recorded ? target.memberId : null;
        if (rid) for (const [n, o] of online) if (recipientOf(n).memberId === rid) send(o.ws, { type: "notice", kind: "contact_requests", count: access.requestsFor(rid).length });
        return send(ws, { type: "contact_request_ok", id: m.id });
      }
      if (!mine) return err("not_allowed", "grants belong to a member credential");
      try {
        if (m.type === "grants_get") return send(ws, { type: "grants", id: m.id, grants: access.grantsOf(mine), ...(access.isPending(mine) ? { pending: true } : {}) });
        if (m.type === "grants_put") return send(ws, { type: "grants_ok", id: m.id, ...access.putGrants(mine, m.base_revision, m.grants, { sharedToken: credentials.some((c) => !c.member) }) });
        if (m.type === "contact_requests") return send(ws, { type: "contact_requests", id: m.id, requests: access.requestsFor(mine).map(({ id, from, name, reason, at }) => ({ id, from, name, reason, at })) });
        if (m.type === "contact_request_answer") return send(ws, { type: "contact_request_answered", id: m.id, ...access.answerRequest(mine, m.request, m.action) });
      } catch (e) {
        return err(e.code ?? "bad_request", e.message, e.revision !== undefined ? { revision: e.revision } : {});
      }
    }

    ws.on("close", () => {
      appTunnel?.closed(ws);
      clearTimeout(ws.oidcTimer);
      clearTimeout(ws.oidcCheck);
      clearTimeout(ws.oidcBound);
      clearTimeout(helloTimer);
      e2eeFrames?.detach(ws, send);
      proofs?.closed(ws);
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
        log("disconnected", name, lost.length ? `(${lost.length === 1 ? "1 unconfirmed message" : `${lost.length} unconfirmed messages`} requeued)` : "");
      } else {
        flush(name); // replaced by a newer connection: hand it what this one never confirmed
      }
    });
  });

  // Liveness pings run on their own interval (by default the sweep's), so a relay with rare sweeps
  // still keeps quiet connections alive and drops dead ones.
  const pinger = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) ws.terminate();
      else {
        ws.isAlive = false;
        ws.ping();
      }
    }
  }, pingMs);
  const heartbeat = setInterval(() => {
    claims.sweep();
    sweepOps();
    for (const m of [titleBudget.claims, titleBudget.principals, statusBudget.claims, statusBudget.principals]) for (const [k, times] of m) if (!times.some((t) => Date.now() - t < TITLE_WINDOW_MS)) m.delete(k);
    access?.sweep();
    for (const [id, e] of acceptedReplies) if (Date.now() - e.at > 8 * 86_400_000) acceptedReplies.delete(id);
    if (devicesFenced) applyDeviceRevocations();
    deviceFrames?.sweep();
    e2eeFrames?.sweep();
    transferFrames?.sweep();
    const now = Date.now();
    for (const [n, p] of peers) {
      const keep = [];
      for (const msg of p.queue) expired(msg, now) ? (dropExpired(n, msg), release(msg)) : keep.push(msg);
      queuedTotal -= p.queue.length - keep.length;
      p.queue = keep;
      if (!online.has(n) && !p.queue.length && now - p.lastSeen > FORGET_AFTER_MS) peers.delete(n);
    }
  }, sweepMs);

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const { port: actual } = server.address();
      const auth = [token && "shared token", members?.length && (members.length === 1 ? "1 member" : `${members.length} members`), oidc && `sign-in with ${oidc.config.issuers.map((i) => i.issuer).join(", ")}`].filter(Boolean).join(" + ");
      const at = host.includes(":") ? `[${host}]:${actual}` : `${host}:${actual}`; // an IPv6 address in brackets
      log(`hoptell relay listening on ws://${at} (auth: ${auth}; realm: ${realmInfo.id}${realmInfo.name ? ` "${realmInfo.name}"` : ""}; health: http://${at}/healthz)`);
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
            hostedFenced: hostedFenced() ? 1 : 0,
            hostedHeld: hostedFenced() ? heldForHosted() : 0,
            ...counts,
            ...(appTunnel ? appTunnel.stats() : {}),
            ...extraStats(),
          };
        },
        /**
         * The relay admin's per-member view (design 4.4): sessions online and quota use by member
         * id, the auth mode and capabilities. Counts only, never names of sessions or content.
         */
        adminView() {
          const sessions = {};
          for (const o of online.values()) if (o.ws.cred?.member) sessions[o.ws.cred.memberId] = (sessions[o.ws.cred.memberId] ?? 0) + 1;
          const quota = {};
          for (const [k, c] of bySender) if (k.startsWith("member:")) quota[k.slice(7)] = { queued: c.n, bytes: c.bytes };
          // The hosted-custody fence (design 4.5): its state, reason and held work, for the relay admin.
          const fenced = hostedFenced();
          const hosted = { fenced, reason: fenced ? "the access policy has a group with provider groups (oidcGroups)" : null, held: fenced ? heldForHosted() : 0, members: credentials.filter((c) => c.custody === "hosted").length };
          return { hosted, auth: authMode(), caps: [...CAPS, ...(verifier ? ["oidc"] : []), ...(broker ? ["broker"] : []), ...(deviceFrames ? [DEVICE_CAP, ATTACH_PROOF_CAP] : []), ...(e2eeFrames ? [E2EE_CAP] : []), ...(transferFrames ? [TRANSFER_CAP] : []), ...appCaps], sessions, quota, limits: { queuedPerSender: MAX_QUEUED_PER_SENDER, bytesPerSender: MAX_QUEUED_BYTES_PER_SENDER } };
        },
        /** A device's service changed outside a frame (the admin reinstated it): held frames may go now. */
        devicesChanged() {
          e2eeFrames?.revalidate();
        },
        reload(newMembers, newHosts = hosts) {
          const next = buildCredentials(token, newMembers, { allowNone: true, requireMembers, hosts: newHosts }); // throws, keeping the old list
          checkCustody(next, credentials); // custody never changes for a member id (design 4.5)
          credentials = next;
          hosts = newHosts;
          let revoked = 0;
          for (const ws of wss.clients) {
            if (!ws.cred || ws.revoked) continue; // not logged in yet: it authenticates against the new list
            // A connection keeps going only if an identical credential still exists and allows its name.
            // Matched by immutable member id and token: a renamed member keeps its sessions only while
            // their names still fit the new name (checked next); a different person never inherits them.
            // A token connection needs the same token; a sign-in connection the same linked identity.
            // A host connection (design 4.5): the member still hosted by the same host, whose token is unchanged.
            const c = ws.custody
              ? credentials.hosts.some((h) => h.id === ws.custody.host && h.digest.equals(ws.custody.digest)) ? credentials.find((x) => x.memberId === ws.cred.memberId && x.custody === "hosted" && x.host === ws.custody.host) : null
              : ws.oidc
                ? credentials.find((x) => x.memberId === ws.cred.memberId && x.oidc?.some((l) => l.issuer === ws.oidc.issuer && l.subject === ws.oidc.subject))
                : credentials.find((x) => x.memberId === ws.cred.memberId && x.digest && ws.cred.digest && x.digest.equals(ws.cred.digest));
            // The hosted-name rule too (as at hello): a member that became hosted takes its names
            // back from every other connection, send-only ones included.
            if (c && nameAllowed(c, ws.peerName) && (ws.custody || !hostedName(ws.peerName))) {
              ws.cred = c;
              continue;
            }
            revoked++;
            cutOff(ws, "token revoked");
          }
          // A reservation survives only for a principal that still has a credential for the name.
          claims.pruneReservations((n, p) => credentials.some((c) => principalKey(c.member ? { kind: "member", id: c.memberId } : { kind: "shared" }) === principalKey(p) && nameAllowed(c, n) && (c.custody === "hosted" || !hostedName(n))));
          // Broker sign-ins of removed, unlinked or signed-out members end too (durably).
          if (broker) {
            try {
              broker.reconcile(credentials);
            } catch (e) {
              log("broker: ending sign-ins after the reload failed:", e.message);
            }
          }
          // Claim views of removed members and unlinked identities close until a newer
          // authentication (design 4.1).
          if (access) {
            for (const v of access.identities()) {
              const c = credentials.find((x) => x.member && x.memberId === v.memberId);
              // A sign-out ends broker families (broker.reconcile below); their queued messages are
              // dropped at dispatch by family, while the identity's view stays for other sign-ins.
              const why = !c ? "member removed" : !c.oidc?.some((l) => `${l.issuer}|${l.subject}` === v.identity) ? "identity unlinked" : null;
              if (why) access.invalidate(v.identity, why);
            }
          }
          const devicesOk = applyDeviceRevocations();
          const n = newMembers?.length || 0;
          log(`members reloaded: ${n} member credential${n === 1 ? "" : "s"}; ${revoked} connection${revoked === 1 ? "" : "s"} revoked`);
          // The members list is in force; its device revocations are not stored yet, so device
          // service stays paused (retried at the sweep) and the reload is reported as failed.
          if (!devicesOk) throw Object.assign(new Error(`the members list is applied, but its device revocations could not be stored (${devicesFenced}); device service is paused and retried`), { membersApplied: true });
        },
        close: () =>
          new Promise((r) => {
            clearInterval(heartbeat);
            clearInterval(pinger);
            appTunnel?.close();
            e2eeFrames?.stop();
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

// ---- device keys (design 3.2, EXPERIMENTAL) ------------------------------------------------------

/** The capability a relay started with --experimental-e2ee announces (protocol 2 only). */
export const DEVICE_CAP = "x-e2ee-devices";
const DEVICE_RATE_MAX = 30; // device frames per RATE_WINDOW_MS per connection
const b64Bytes = (s, max) => (typeof s === "string" && s.length <= Math.ceil(max / 3) * 4 && /^[A-Za-z0-9+/]*={0,2}$/.test(s) ? Buffer.from(s, "base64") : null);

/**
 * The device frames over a directory (lib/mls/relaydir.js), for authenticated members on protocol
 * 2 only. `visible(callerMemberId, targetMemberId)` is the hidden-member rule of design 4.2 for
 * device_list and kp_take: lib/access.js (the access branch) plugs in there; until then every
 * member is visible, as every member's name is today. A member always sees its own devices.
 */
function createDeviceFrames({ directory, proofs, attachHere = false, visible = null, realm, log, fenced = () => null, revoked = () => {}, hosted = () => false, rateNow = () => Date.now() }) {
  const mayReach = visibleHook(visible);
  // A9: proof_challenge, device_register (with its own proof) and e2ee_attach are the only device
  // frames before an attachment; device_list is a member query. e2ee_attach is the encrypted-message
  // frames' (it also starts deliveries); a relay with devices only attaches here (KeyPackage work).
  // A12: device_request (with its own register proof) is a new device's, before it is a device;
  // device_pending, device_pending_cancel, device_expect and device_approve are a proven device's.
  const TYPES = new Set(["proof_challenge", "device_register", "device_list", "kp_upload", "kp_status", "kp_take", "kp_abandon", "device_revoke", "device_request", "device_pending", "device_pending_cancel", "device_expect", "device_approve", ...(attachHere ? ["e2ee_attach"] : [])]);
  const rate = new WeakMap();
  function handle(ws, m, reply) {
    const fail = (code, error) => reply({ type: "error", code, error });
    if (ws.version !== 2 || !ws.cred?.member) return fail("member_only", "device keys need a member credential on protocol 2");
    if (fenced()) return fail("unavailable", "the relay's device service is paused until the members file's device revocations are stored; try again");
    const now = rateNow();
    const sent = (rate.get(ws) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
    if (sent.length >= DEVICE_RATE_MAX) return fail("rate_limited", `rate limit: at most ${DEVICE_RATE_MAX} device requests per ${RATE_WINDOW_MS / 1000}s per connection`);
    sent.push(now);
    rate.set(ws, sent);
    const me = ws.cred.memberId;
    const str = (x) => typeof x === "string";
    try {
      switch (m.type) {
        case "proof_challenge": {
          // Custody is immutable (design 4.5): a hosted member has no device to prove.
          if (hosted(me)) return fail("not_allowed", "a hosted member has no devices");
          return reply({ type: "proof_challenge", ...proofs.challenge(ws, { purpose: m.purpose, device: m.device, key: m.key }) });
        }
        case "e2ee_attach": {
          if (!str(m.device)) return fail("bad_request", "e2ee_attach needs device and proof");
          proofs.attach(ws, m.device, proofs.verify(ws, { purpose: "attach", device: m.device, proof: m.proof }));
          return reply({ type: "e2ee_attached", device: m.device });
        }
        case "device_register": {
          const key = b64Bytes(m.key, 32);
          const pin = b64Bytes(m.pin, 32);
          if (!str(m.device) || !key || !pin) return fail("bad_request", "device_register needs device, key, pin and proof");
          // Custody is immutable (design 4.5): a hosted member never enrolls a device.
          if (hosted(me)) return fail("not_allowed", "a hosted member cannot enroll devices");
          // A9: possession of the key being registered (a first registration, a rotation or a
          // same-key retry). A12: a new device of a member that has one needs an approval, which
          // the directory consumes with the pending request in the registration's transaction.
          proofs.verify(ws, { purpose: "register", device: m.device, key, proof: m.proof });
          const r = directory.register({ member: me, device: m.device, key, pin, rotation: m.rotation ?? null });
          log("device", r.state, `member ${me} device ${m.device}${r.approvedBy ? ` approved by ${r.approvedBy === "admin" ? "the admin" : "a device"}` : ""}`);
          // A changed key or sequence drops every existing attachment of the device: those
          // connections prove again with the new key.
          if (r.state === "rotated") proofs.drop(me, m.device);
          return reply({ type: "device_registered", device: m.device, state: r.state, seq: r.seq });
        }
        case "device_request": {
          // A12: a new device asks for its approval, with A9's register-purpose proof of the new
          // key; the pending request it makes is not a device and passes no guard.
          const key = b64Bytes(m.key, 32);
          if (!str(m.device) || !key) return fail("bad_request", "device_request needs device, key and proof");
          if (hosted(me)) return fail("not_allowed", "a hosted member cannot enroll devices");
          proofs.verify(ws, { purpose: "register", device: m.device, key, proof: m.proof });
          const r = directory.request({ member: me, device: m.device, key });
          if (r.state === "pending") log("device", "request", `member ${me} device ${m.device}`);
          return reply({ type: "device_request", device: m.device, state: r.state, ...(r.expires ? { expires: r.expires } : {}) });
        }
        case "device_pending": {
          // A12: pending requests only to a proven device of the same member (and the admin channel).
          proofs.guard(ws);
          if (m.member !== undefined && m.member !== me) return fail("not_allowed", "pending device requests are shown only to the member's own devices");
          return reply({ type: "device_pending", member: me, realm, requests: directory.pending(me).map(({ device, key, requested, expires, approved }) => ({ device, key, requested, expires, approved })) });
        }
        case "device_pending_cancel": {
          if (!str(m.device) || !str(m.by_device)) return fail("bad_request", "device_pending_cancel needs device (the pending one) and by_device");
          proofs.guard(ws, m.by_device);
          const r = directory.cancel({ member: me, device: m.device, by: { kind: "device", device: m.by_device } });
          if (r.state === "cancelled") log("device", "request cancelled", `member ${me} device ${m.device} by ${m.by_device}`);
          return reply({ type: "device_pending_cancelled", device: m.device, state: r.state });
        }
        case "device_expect": {
          const pin = b64Bytes(m.pin, 32);
          if (!str(m.device) || !str(m.by_device) || !pin) return fail("bad_request", "device_expect needs device (the expected one), pin (32 bytes) and by_device");
          proofs.guard(ws, m.by_device);
          const r = directory.expect({ member: me, device: m.device, pin, by: m.by_device });
          return reply({ type: "device_expected", device: m.device, expires: r.expires });
        }
        case "device_approve": {
          // A12: the approving device acts: it is this connection's proven one (A9's guard).
          const a = m.approval;
          if (!a || typeof a !== "object" || !str(a.approver)) return fail("bad_request", "device_approve needs approval");
          proofs.guard(ws, a.approver);
          // The request instance the owner accepted (device_pending's `requested`), unsigned: this
          // connection is the approving device, proven (the guard above).
          if (!Number.isSafeInteger(m.requested)) return fail("bad_request", "device_approve needs requested (the pending request's time, as device_pending reported it)");
          const r = directory.approve({ member: me, approval: a, by: a.approver, requested: m.requested });
          log("device", `approval ${r.state}`, `member ${me} device ${a.device} by ${a.approver}`);
          return reply({ type: "device_approved", device: a.device, state: r.state });
        }
        case "device_list": {
          const target = str(m.member) ? m.member : me;
          // A hidden member's devices are not listed to callers that may not reach it: the answer
          // is the same as for a member without devices.
          const devices = target === me || mayReach(me, target, ws) ? directory.list(target) : [];
          return reply({ type: "devices", member: target, realm, devices, ...(hosted(target) ? { custody: "hosted" } : {}) });
        }
        case "kp_upload": {
          if (!str(m.device) || !Array.isArray(m.packages) || m.packages.length > 20) return fail("bad_request", "kp_upload needs device and packages");
          const packages = m.packages.map((p) => ({ kp: b64Bytes(p?.kp, 16 * 1024), notAfter: p?.not_after }));
          if (packages.some((p) => !p.kp)) return fail("bad_request", "every package needs kp (base64)");
          proofs.guard(ws, m.device);
          const r = directory.upload({ member: me, device: m.device, packages });
          return reply({ type: "kp_uploaded", accepted: r.accepted, available: r.available, reserved: r.reserved, oldest_expires: r.oldestExpires });
        }
        case "kp_status": {
          if (!str(m.device)) return fail("bad_request", "kp_status needs device");
          proofs.guard(ws, m.device);
          const r = directory.status({ member: me, device: m.device });
          return reply({ type: "kp_status", available: r.available, reserved: r.reserved, oldest_expires: r.oldestExpires });
        }
        case "kp_take": {
          const t = m.target;
          if (!str(m.device) || !t || !str(t.member) || !str(t.device)) return fail("bad_request", "kp_take needs request, device and target {member, device}");
          proofs.guard(ws, m.device);
          if (t.member !== me && !mayReach(me, t.member, ws)) return fail("no_device", "no such device");
          const r = directory.take({ requester: { member: me, device: m.device }, request: m.request, target: { member: t.member, device: t.device } });
          return reply({ type: "kp", reservation: r.reservation, ref: r.ref, kp: r.kp.toString("base64"), not_after: r.notAfter, member: r.member, device: r.device, key: r.key, pin: r.pin, seq: r.seq });
        }
        case "kp_abandon": {
          if (!str(m.device) || !str(m.reservation)) return fail("bad_request", "kp_abandon needs device and reservation");
          proofs.guard(ws, m.device);
          return reply({ type: "kp_abandoned", ...directory.abandon({ requester: { member: me, device: m.device }, reservation: m.reservation }) });
        }
        case "device_revoke": {
          if (!str(m.device) || !str(m.by_device)) return fail("bad_request", "device_revoke needs device and by_device");
          proofs.guard(ws, m.by_device); // the revoking device acts: it is this connection's proven one
          const r = directory.revoke({ member: me, device: m.device, by: { kind: "device", device: m.by_device }, statement: m.statement ?? null });
          log("device", r.state, `member ${me} device ${m.device} by ${m.by_device}`);
          revoked();
          return reply({ type: "device_revoked", device: m.device, state: r.state, at: r.at });
        }
      }
    } catch (e) {
      if (e instanceof DirectoryError) return fail(e.code, e.message);
      // The store's WAL admission refused the write (design 6): nothing was written; retry later.
      if (e.code === "busy") return fail("busy", e.message, { retry_after_ms: e.retry_after_ms });
      // Storage trouble (a failed write): nothing was answered as done, and the client may retry.
      log("devices: request failed:", e.code === "ERELAYDB" ? e.message : "storage error");
      return fail("unavailable", "the relay could not store this; try again");
    }
  }
  return {
    handles: (type) => TYPES.has(type),
    handle,
    sweep() {
      try {
        directory.sweep();
      } catch (e) {
        log("devices: sweep failed:", e.message);
      }
    },
  };
}

/**
 * The design 4.2 visibility rule for devices: `visible(caller, target, ws)` decides whether a
 * caller (its member id, and its connection for the signed-in principal) may see a member's
 * devices. With access configured, startRelay passes the reach rule of names; `devices.visible`
 * overrides it.
 */
function visibleHook(visible) {
  return typeof visible === "function" ? (caller, target, ws) => Boolean(visible(caller, target, ws)) : () => true;
}

// ---- encrypted direct messages (design 3.3, EXPERIMENTAL) ----------------------------------------

/** The capability of a relay that carries encrypted direct messages (protocol 2, the flag only). */
export const E2EE_CAP = "e2ee";
const E2EE_RATE_MAX = 120; // encrypted-message frames per RATE_WINDOW_MS per connection
const E2EE_INFLIGHT = 50; // unacknowledged application messages per connection
// Unacknowledged control frames (commits, Welcomes) per connection: a budget of their own, so
// application messages the device cannot read yet (waiting for a Welcome) never block the Welcome.
const E2EE_CONTROL_INFLIGHT = 16;
// Application messages read per page at dispatch, and pages per delivery round: enough to pass a
// device's whole queue (its quota) of held messages in one round.
const E2EE_PAGE = 200;
const E2EE_PAGES = Math.ceil(E2EE_QUEUE_MAX / E2EE_PAGE) + 1;

/**
 * The encrypted-message frames over a Delivery Service (lib/mls/relayds.js), for authenticated
 * members on protocol 2 only:
 *   group_create {op, peer, group, epoch, welcome?, kp_reservations}      -> group
 *   group_replace {op, peer, expected_generation, group, epoch, welcome?, kp_reservations} -> group
 *   conversation {peer}                                                    -> group | null
 *   send_e2ee {op, device, group, kind: "commit", expected_epoch, mls, roster_delta, welcome?,
 *              kp_reservations} | {op, device, group, kind: "app", mls, target, reconcile?}
 *       (reconcile: only the original result of that op id; an op id never accepted is cancelled
 *       in the same transaction and answered {state: "cancelled"}; nothing accepted. A cancelled
 *       op id is refused with "op_cancelled" afterwards, whatever its payload)
 *       -> e2ee_result {state: "accepted", position?, epoch?} | {state: "conflict", winner}
 *          | {state: "cancelled"} | {state: "stale_epoch", epoch}; other refusals are errors with a code
 *       (an accepted app op also answers recipients and peerRecipients, the roster devices not of
 *       the sender's member, which the sender reads as delivery evidence; an app op whose roster
 *       holds no device of another member is refused "no_recipient" before acceptance. Both are
 *       backward-compatible protocol-2 additions: an older client ignores the field)
 *   commits_since {device, group, epoch}                                   -> commits
 *   commit_invalid {device, group, epoch, reason?}                          -> recorded
 *   member_of {name}                                                       -> the member id of a session name
 *   e2ee_attach {device, proof}  (A9: a SignWithLabel proof of the device's registered key over
 *                         a proof_challenge of this connection) this connection is attached to the
 *                         device and receives its message_e2ee frames: application messages only
 *                         when the connection holds their target session's name, commits and
 *                         Welcomes on the most recently attached agent session (peer mode); a
 *                         send-mode connection acts for the device but receives none
 *   e2ee_got {delivery, outcome}  the device took a delivery (into its receive pipeline, or refused
 *                         it by its checks): it leaves the durable queue
 * Every frame naming a device goes through the proofs' guard (A9): the connection's proven
 * attachment, for that device, with its key and sequence current (else not_attached).
 */
function createE2eeFrames({ proofs, ds, audit = () => {}, visible = null, reach = () => "allow", principal = () => null, mayUpload = () => "allow", log, memberOf, fenced = () => null, custodyOf = () => null, rateNow = () => Date.now() }) {
  const mayReach = visibleHook(visible);
  const TYPES = new Set(["group_create", "group_replace", "conversation", "send_e2ee", "commits_since", "commit_invalid", "member_of", "e2ee_attach", "e2ee_got"]);
  const rate = new WeakMap();
  /** "member|device" -> attached sockets, oldest first. */
  const attached = new Map();
  /** delivery -> {ws, control}: the socket it was sent to and not yet acknowledged, and its budget. */
  const inflight = new Map();
  let sendFrame = null;

  /** Send what the device's queue holds to its attached connections. */
  let stopped = false;
  function pump(key) {
    try {
      pumpOnce(key);
    } catch (e) {
      // The queue stays as it is; the next acknowledgement, attachment or sweep tries again.
      log("e2ee: delivery failed:", e.code === "ERELAYDB" ? e.message : "storage error");
    }
  }
  /** A connection's attachment ended (A9: its device's key or sequence changed): it stops receiving. */
  function unlist(ws) {
    if (!ws.e2eeKey) return;
    const key = ws.e2eeKey;
    const list = (attached.get(key) ?? []).filter((w) => w !== ws);
    if (list.length) attached.set(key, list);
    else attached.delete(key);
    for (const [d, f] of inflight) if (f.ws === ws) inflight.delete(d);
    ws.e2eeKey = null;
    return key;
  }
  /** A9: tell a connection its attachment ended, so a live session proves again (or stops, revoked). */
  const detached = (ws, device, reason) => {
    if (ws.readyState === 1) ws.send(JSON.stringify({ type: "e2ee_detached", device, reason }));
  };
  proofs.onDrop((ws, a) => {
    if (a) detached(ws, a.device, "key_changed");
    const key = unlist(ws);
    if (key) {
      log("e2ee: an attachment was dropped (the device's key changed); the connection proves again");
      pump(key);
    }
  });
  /**
   * A device revoked since it attached: its connections stop receiving (they are detached). A
   * connection whose proof was for an earlier key or sequence of the device is detached too (A9).
   */
  function dropRevoked(key) {
    const [member, device] = key.split("|");
    try {
      ds.checkDevice({ member, device });
      for (const w of [...(attached.get(key) ?? [])]) {
        if (w.attachment && proofs.current(w)) continue;
        proofs.detach(w, false);
        unlist(w);
        detached(w, device, "key_changed");
      }
      return !attached.get(key)?.length;
    } catch (e) {
      if (!(e instanceof DirectoryError)) throw e;
    }
    const list = attached.get(key) ?? [];
    attached.delete(key);
    for (const [d, f] of inflight) if (list.includes(f.ws)) inflight.delete(d);
    for (const w of list) {
      w.e2eeKey = null;
      proofs.detach(w, false);
      detached(w, device, "revoked");
    }
    log("e2ee: a revoked device was detached", device);
    return true;
  }
  // Commits and Welcomes go to the most recently attached agent session (peer mode). A send-mode
  // connection (a CLI command attached for KeyPackage or device work, A9) acts for the device but
  // receives no deliveries: it never takes them from a running agent, nor holds them unacknowledged.
  const controlTo = (list) => list.findLast((w) => w.e2eeMode === "peer");
  function pumpOnce(key) {
    const list = attached.get(key);
    // Paused while the members file's revocations are not stored (resumed by the sweep).
    if (stopped || fenced() || !list?.length || dropRevoked(key)) return;
    const [member, device] = key.split("|");
    // Deliveries that left the queue unacknowledged (a replacement or a newer Welcome removed a
    // control frame, an application message expired) free their slots: none is held for ever.
    const mine = [...inflight].filter(([, f]) => list.includes(f.ws)).map(([d]) => d);
    if (mine.length) {
      const still = ds.queued({ member, device, deliveries: mine });
      for (const d of mine) if (!still.has(d)) inflight.delete(d);
    }
    const busy = (w, control) => [...inflight.values()].filter((f) => f.ws === w && f.control === control).length;
    const room = (w, control) => w.readyState === 1 && busy(w, control) < (control ? E2EE_CONTROL_INFLIGHT : E2EE_INFLIGHT);
    // Only what an attached, not saturated connection can take now is read (MII7): application
    // messages of its session names, control frames for the most recent connection, each kind
    // within its own budget (MII8).
    //
    // Application messages are rechecked just before they are sent (gates 1 and 2, for the sender
    // as it was signed in): a refused one is dropped, a held one (a stale claim view) stays queued
    // under its expiry. Held messages must not hide the deliverable ones behind them, so a round
    // reads the queue a page at a time, each page after the application messages already looked
    // at (by seq), while the previous page was full and a connection has room: at most
    // E2EE_PAGES pages, which pass a full queue. A sender's later messages wait behind its held
    // one (its order, as for plaintext). The next round (an acknowledgement, an attachment, a new
    // message or the sweep) starts from the front again, so a held message is retried each time.
    let unrecorded = 0;
    let after = 0;
    const heldFrom = new Set();
    for (let page = 0; page < E2EE_PAGES; page++) {
      const targets = list.filter((w) => w.e2eeMode === "peer" && room(w, false)).map((w) => w.peerName);
      const toControl = controlTo(list);
      const control = Boolean(toControl) && room(toControl, true);
      if (!targets.length && !control) break;
      let apps = 0;
      for (const { frame, sender, seq } of ds.pending({ member, device, limit: E2EE_PAGE, controlLimit: E2EE_CONTROL_INFLIGHT, except: new Set(inflight.keys()), targets, control, appsAfter: after, withSender: true })) {
        const isControl = frame.kind !== "app";
        if (!isControl) {
          apps++;
          after = Math.max(after, seq);
          // A message from another member queued before the store recorded senders (migration 3)
          // has no principal, and nothing durable tells how it was authenticated: it may have come
          // from a sign-in (a provider or the broker; the relay's sign-in configuration then may
          // differ from now) whose claim view (stale, closed, its provider groups) or broker family
          // decided its reach. Neither the bare member nor the member's current session can stand
          // in for it, so it is refused, whatever the relay's configuration (the sender can send
          // again). A member's own messages to its other devices pass no gates and still go.
          if (!sender && frame.from_member !== member) {
            ds.ack({ member, device, delivery: frame.delivery });
            unrecorded++;
            continue;
          }
          const who = sender?.identity ?? frame.from_member;
          const verdict = heldFrom.has(who) ? "hold" : reach(null, frame.from_member, member, sender);
          if (verdict === "deny") {
            ds.ack({ member, device, delivery: frame.delivery });
            continue;
          }
          if (verdict !== "allow") {
            heldFrom.add(who);
            continue;
          }
        }
        const to = isControl ? controlTo(list) : list.findLast((w) => w.peerName === frame.target && w.e2eeMode === "peer");
        if (!to || !room(to, isControl)) continue;
        inflight.set(frame.delivery, { ws: to, control: isControl });
        sendFrame(to, frame);
      }
      if (apps < E2EE_PAGE) break;
    }
    if (unrecorded) log(`e2ee: ${unrecorded} message${unrecorded === 1 ? "" : "s"} queued before the relay recorded senders refused at dispatch`);
  }
  const pumpAll = () => {
    for (const key of attached.keys()) pump(key);
  };

  function handle(ws, m, reply, send, mode) {
    sendFrame ??= send;
    const fail = (code, error, extra = {}) => reply({ type: "error", code, error, ...extra });
    if (ws.version !== 2 || !ws.cred?.member) return fail("member_only", "encrypted messages need a member credential on protocol 2");
    // Acknowledgements only remove what was delivered before; everything else waits for the fence.
    if (fenced() && m.type !== "e2ee_got") return fail("unavailable", "the relay's device service is paused until the members file's device revocations are stored; try again");
    const now = rateNow();
    if (m.type !== "e2ee_got") {
      const sent = (rate.get(ws) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
      if (sent.length >= E2EE_RATE_MAX) return fail("rate_limited", `rate limit: at most ${E2EE_RATE_MAX} encrypted-message requests per ${RATE_WINDOW_MS / 1000}s per connection`);
      sent.push(now);
      rate.set(ws, sent);
    }
    const me = ws.cred.memberId;
    const str = (x) => typeof x === "string";
    // A9: the one guard of device-scoped frames: this connection's proven attachment, for the
    // device the frame names, with its key and sequence current.
    const requester = () => {
      if (!str(m.device) || !DEVICE_ID_RE.test(m.device)) throw new DirectoryError("bad_request", "device must be one of your device ids");
      return proofs.guard(ws, m.device);
    };
    const opOk = () => {
      if (!str(m.op) || !E2EE_OP_RE.test(m.op)) throw new DirectoryError("bad_request", "op must be an operation id (o_ and 26 letters a-z or digits 2-7)");
      return m.op;
    };
    const welcomeOf = (w) => (w === undefined || w === null ? null : w && typeof w === "object" ? { recipients: w.recipients, mls: w.mls, ratchet_tree: w.ratchet_tree ?? null } : {});
    try {
      switch (m.type) {
        case "e2ee_attach": {
          if (!str(m.device) || !DEVICE_ID_RE.test(m.device)) return fail("bad_request", "e2ee_attach needs device and proof");
          const key = `${me}|${m.device}`;
          if (ws.e2eeKey && ws.e2eeKey !== key) return fail("bad_request", "this connection is attached to another device");
          // A9: a proof of the device's registered key on this connection (the challenge is
          // consumed whatever the outcome); a refusal leaves the connection unattached.
          const cur = proofs.verify(ws, { purpose: "attach", device: m.device, proof: m.proof });
          ds.checkDevice({ member: me, device: m.device }); // the Delivery Service's own check (suspension)
          proofs.attach(ws, m.device, cur);
          const r = { device: m.device };
          ws.e2eeKey = key;
          ws.e2eeMode = mode;
          const list = (attached.get(key) ?? []).filter((w) => w !== ws && w.readyState === 1);
          list.push(ws);
          attached.set(key, list);
          reply({ type: "e2ee_attached", device: r.device });
          return pump(key);
        }
        case "e2ee_got": {
          // A delivery no longer in flight (it left the queue meanwhile) is answered by nothing.
          if (inflight.get(m.delivery)?.ws !== ws || !ws.e2eeKey || !ws.attachment) return;
          inflight.delete(m.delivery);
          const [member, device] = ws.e2eeKey.split("|");
          ds.ack({ member, device, delivery: m.delivery });
          if (m.outcome === "refused") log("e2ee: a delivery was refused by device", device);
          return pump(ws.e2eeKey);
        }
        case "member_of": {
          if (!str(m.name)) return fail("bad_request", "member_of needs name");
          // A hidden member (design 4.2's hook, as for device_list) is not named to callers that may not reach it.
          const member = memberOf(m.name);
          const shown = member && (member === me || mayReach(me, member, ws)) ? member : null;
          return reply({ type: "member", name: m.name, member: shown, ...(shown && custodyOf(shown) ? { custody: custodyOf(shown) } : {}) });
        }
        case "conversation": {
          if (!str(m.peer)) return fail("bad_request", "conversation needs peer");
          return reply({ type: "group", ...(ds.conversation({ member: me, peer: m.peer }) ?? { group: null }) });
        }
        case "group_create": {
          if (!str(m.peer) || !Array.isArray(m.kp_reservations ?? [])) return fail("bad_request", "group_create needs op, device, peer, group, epoch");
          // A new conversation needs the gates to allow the peer (as plaintext would).
          if (reach(ws, me, m.peer) !== "allow") return fail("not_allowed", "the relay's access rules do not let you reach this member now");
          const r = ds.groupCreate({ requester: requester(), op: opOk(), peer: m.peer, group: m.group, epoch: m.epoch, welcome: welcomeOf(m.welcome), reservations: m.kp_reservations ?? [] });
          reply({ type: "group", ...r });
          return pumpAll();
        }
        case "group_replace": {
          if (!str(m.peer) || !Array.isArray(m.kp_reservations ?? [])) return fail("bad_request", "group_replace needs op, device, peer, expected_generation, group, epoch");
          const r = ds.groupReplace({ requester: requester(), op: opOk(), peer: m.peer, expectedGeneration: m.expected_generation, group: m.group, epoch: m.epoch, welcome: welcomeOf(m.welcome), reservations: m.kp_reservations ?? [] });
          log("e2ee: group replaced", `member ${me} generation ${r.generation}`);
          reply({ type: "group", ...r });
          return pumpAll();
        }
        case "send_e2ee": {
          let r;
          if (m.kind === "commit") {
            if (!Array.isArray(m.kp_reservations ?? [])) return fail("bad_request", "kp_reservations must be a list");
            r = ds.sendCommit({ requester: requester(), op: opOk(), group: m.group, expectedEpoch: m.expected_epoch, mls: m.mls, delta: m.roster_delta, welcome: welcomeOf(m.welcome), reservations: m.kp_reservations ?? [] });
          } else if (m.kind === "app") {
            // Gates 1 and 2 for every other member of the conversation, as the sender is signed in now.
            // (A reconciliation accepts nothing new, so it is answered whatever the gates say now.)
            // Only for a sender whose device is in the group's roster: anyone else gets the
            // directory's own refusal below (no_group, not_member), never an answer that depends on
            // the roster's members (which ones the gates refuse, or cannot check now).
            const roster = m.reconcile === true ? [] : ds.roster(m.group);
            const sender = requester();
            const inRoster = roster.some((d) => d.member === sender.member && d.device === sender.device);
            const peers = new Set(inRoster ? roster.map((d) => d.member).filter((x) => x !== me) : []);
            for (const peer of peers) {
              const v = reach(ws, me, peer);
              if (v === "retry" || v === "hold") return fail("unavailable", "the relay cannot check your access right now; try again shortly");
              if (v !== "allow") return fail("not_allowed", "the relay's access rules do not let you reach this member now");
            }
            // The sender's principal is queued with the message for the recheck at dispatch.
            r = ds.sendApp({ requester: requester(), op: opOk(), group: m.group, mls: m.mls, target: m.target, reconcile: m.reconcile === true, sender: m.reconcile === true ? null : principal(ws), blobs: m.blobs === undefined ? null : m.blobs, authorize: () => mayUpload(ws) });
          } else return fail("bad_request", 'send_e2ee kind is "commit" or "app"');
          reply({ type: "e2ee_result", ...r });
          return pumpAll();
        }
        case "commits_since": {
          return reply({ type: "commits", ...ds.commitsSince({ requester: requester(), group: m.group, epoch: m.epoch }) });
        }
        case "commit_invalid": {
          const r = ds.commitInvalid({ requester: requester(), group: m.group, epoch: m.epoch, reason: m.reason ?? null });
          log("e2ee: commit reported invalid", `group ${m.group} epoch ${m.epoch} by device ${m.device}`);
          audit("e2ee.commit_invalid", { group: m.group, epoch: m.epoch }); // a security event of the relay's own (design 4.4)
          return reply({ type: "commit_invalid_recorded", ...r });
        }
      }
    } catch (e) {
      if (e instanceof DirectoryError) {
        if (e.code === "stale_epoch") return reply({ type: "e2ee_result", state: "stale_epoch", epoch: e.epoch });
        const extra = {};
        for (const k of ["group", "generation", "epoch", "limit", "relay_expires", "state"]) if (e[k] !== undefined) extra[k] = e[k];
        return fail(e.code, e.message, extra);
      }
      if (e.code === "busy") return fail("busy", e.message, { retry_after_ms: e.retry_after_ms });
      log("e2ee: request failed:", e.code === "ERELAYDB" ? e.message : "storage error");
      return fail("unavailable", "the relay could not store this; try again");
    }
  }
  return {
    handles: (type) => TYPES.has(type),
    handle,
    /** A connection closed: what it had not acknowledged goes to the device's other connections. */
    detach(ws, send) {
      sendFrame ??= send;
      const key = unlist(ws);
      if (key) pump(key);
    },
    /** Revocations took effect: attached devices are checked again (revoked ones detached), then pumped. */
    revalidate() {
      pumpAll();
    },
    /** The relay is closing: nothing more is read from the store. */
    stop() {
      stopped = true;
    },
    sweep() {
      try {
        ds.sweep();
      } catch (e) {
        log("e2ee: sweep failed:", e.message);
      }
      pumpAll();
    },
  };
}

// ---- larger transfers (design 6, EXPERIMENTAL) ---------------------------------------------------

/** The capability of a relay that stores larger transfers (protocol 2, with "e2ee"). */
export const TRANSFER_CAP = "transfers";
const TRANSFER_RATE_MAX = 1000; // transfer frames per RATE_WINDOW_MS per connection (a chunk is one frame)
const DOWNLOAD_BUFFER_MAX = 4 * 1024 * 1024; // unsent bytes a downloading connection may hold
const TRANSFER_B64_MAX = Math.ceil((262_144 + 16) / 3) * 4;

/**
 * The transfer frames over a transfer store (lib/mls/relaytransfers.js), for authenticated members
 * on protocol 2, on a connection attached to one of their devices (e2ee_attach): the uploader and
 * the downloading device are that attachment's device, never a field of the frame.
 *   upload_begin {transfer_id, total_bytes, chunk_count, header_digest} -> begun {state, open_expires | relay_expires}
 *   upload_chunk {transfer_id, index, data (base64)}                    -> stored {index}
 *   upload_status {transfer_id}                                         -> transfer_status {state, stored, ...}
 *   upload_commit {transfer_id, root}                                   -> sealed {relay_expires, root}
 *   upload_abort {transfer_id}                                          -> aborted {state}
 *   download {uploader_device, transfer_id, from_index}                 -> chunk {index, data, chunk_count, root, relay_expires}
 * A download answers one chunk (from_index); a client keeps up to 4 requests in flight. Refusals are
 * errors with a code: gone (unknown, unauthorized, terminal or expired: the same answer), sealed,
 * chunk_conflict, transfer_conflict, incomplete {missing}, quota {limit}, busy {retry_after_ms}.
 * The upload policy is live (amendments 3.5, A8): asked at begin and whenever a chunk not stored
 * yet or a seal not done yet would be accepted (and at a publication, in send_e2ee). A deny ends
 * the upload (not_allowed; the transfer is then denied, and every later chunk or seal of it answers
 * denied); a stale view answers unavailable (retry later).
 */
function createTransferFrames({ transfers, proofs, reach, mayUpload = () => "allow", log, fenced = () => null }) {
  const TYPES = new Set(["upload_begin", "upload_chunk", "upload_status", "upload_commit", "upload_abort", "download"]);
  const rate = new WeakMap();
  function handle(ws, m, reply) {
    const fail = (code, error, extra = {}) => reply({ type: "error", code, error, ...extra });
    if (ws.version !== 2 || !ws.cred?.member) return fail("member_only", "transfers need a member credential on protocol 2");
    if (fenced()) return fail("unavailable", "the relay's device service is paused until the members file's device revocations are stored; try again");
    const now = Date.now();
    const sent = (rate.get(ws) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
    if (sent.length >= TRANSFER_RATE_MAX) return fail("rate_limited", `rate limit: at most ${TRANSFER_RATE_MAX} transfer requests per ${RATE_WINDOW_MS / 1000}s per connection`);
    sent.push(now);
    rate.set(ws, sent);
    if (!ws.attachment || ws.attachment.member !== ws.cred.memberId) return fail("not_attached", "transfers need a connection attached to one of your devices (e2ee_attach)");
    let me;
    try {
      // A9's guard: the proven attachment, its key and sequence current; the device enrolled, not
      // revoked, not suspended: now, for every frame.
      me = proofs.guard(ws);
      if (!ws.e2eeKey) throw new DirectoryError("not_attached", "transfers need a connection attached to one of your devices (e2ee_attach)");
      switch (m.type) {
        case "upload_begin":
          // The relay's policy can refuse a member transfers (4.1 gate 1, as signed in now).
          switch (mayUpload(ws)) {
            case "allow":
              break;
            case "deny":
              return fail("not_allowed", "the relay's access policy does not let you upload transfers");
            default:
              return fail("unavailable", "the relay cannot check your access right now; renew your sign-in or try again shortly");
          }
          return reply({ type: "begun", transfer_id: m.transfer_id, ...transfers.begin({ uploader: me, transferId: m.transfer_id, totalBytes: m.total_bytes, chunkCount: m.chunk_count, headerDigest: m.header_digest }) });
        case "upload_chunk": {
          if (typeof m.data !== "string" || m.data.length > TRANSFER_B64_MAX || m.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(m.data)) return fail("bad_request", "data must be one chunk in base64");
          return reply({ type: "stored", transfer_id: m.transfer_id, ...transfers.chunk({ uploader: me, transferId: m.transfer_id, index: m.index, data: Buffer.from(m.data, "base64"), authorize: () => mayUpload(ws) }) });
        }
        case "upload_status":
          return reply({ type: "transfer_status", transfer_id: m.transfer_id, ...transfers.status({ uploader: me, transferId: m.transfer_id }) });
        case "upload_commit":
          return reply({ type: "sealed", transfer_id: m.transfer_id, ...transfers.commit({ uploader: me, transferId: m.transfer_id, root: m.root, authorize: () => mayUpload(ws) }) });
        case "upload_abort":
          return reply({ type: "aborted", transfer_id: m.transfer_id, ...transfers.abort({ uploader: me, transferId: m.transfer_id }) });
        case "download": {
          if (ws.bufferedAmount > DOWNLOAD_BUFFER_MAX) return fail("rate_limited", "this connection has too many chunks in flight; at most 4");
          const c = transfers.download({ requester: me, uploaderDevice: m.uploader_device, transferId: m.transfer_id, index: m.from_index, reach });
          const frame = { type: "chunk", uploader_device: m.uploader_device, transfer_id: m.transfer_id, index: c.index, chunk_count: c.chunk_count, total_bytes: c.total_bytes, root: c.root, relay_expires: c.relay_expires, data: c.data.toString("base64") };
          if (Buffer.byteLength(JSON.stringify({ ...frame, id: Number.MAX_SAFE_INTEGER })) > MAX_FRAME_BYTES) return fail("too_large", "the chunk does not fit a frame");
          return reply(frame);
        }
      }
    } catch (e) {
      if (e instanceof DirectoryError) {
        // An unknown device (revoked since attaching) looks like any refusal of its own.
        const extra = {};
        for (const k of ["missing", "limit", "state", "relay_expires"]) if (e[k] !== undefined) extra[k] = e[k];
        return fail(e.code, e.message, extra);
      }
      if (e.code === "busy") return fail("busy", e.message, { retry_after_ms: e.retry_after_ms });
      log("transfers: request failed:", e.code === "ERELAYDB" ? e.message : "storage error");
      return fail("unavailable", "the relay could not store this; try again");
    }
  }
  return {
    handles: (type) => TYPES.has(type),
    handle,
    sweep() {
      try {
        transfers.sweep();
      } catch (e) {
        log("transfers: sweep failed:", e.message);
      }
    },
  };
}
