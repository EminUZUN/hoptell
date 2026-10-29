// Relay client used by the MCP server and the CLI.
import { EventEmitter } from "node:events";
import WebSocket from "ws";
import crypto from "node:crypto";
import { HOSTNAME, MAX_ROLES, MAX_TTL_S, NAME_RE, NAME_RULE, PROTOCOL, REF_RE, cleanTitle, legacyAutoName, resemblanceIndex, resemblesIn } from "./config.js";

const RPC_TIMEOUT_MS = 10_000; // above the relay's 5s delivery-ack window
const SILENCE_LIMIT_MS = 45_000; // relay pings every 15s; silence means a dead link
const FREE_CHECK_MS = [2000, 60_000]; // after being replaced: first and longest wait between checks
const MAX_HELD_FRAMES = 200; // frames held while a welcome is being committed
const REAUTH_RETRY_MS = 10_000; // a failed sign-in renewal is tried again after this pause
const OP_RETRY_MS = 5 * 60_000; // retries of one send stay well inside the relay's 10-minute memory
const newOpId = () => `o_${[...crypto.randomBytes(26)].map((b) => "abcdefghijklmnopqrstuvwxyz234567"[b & 31]).join("")}`;
// The relay's reason (close 4002) when a member token may not use the name, or a shared token a
// hosted member's name. The local message states the members' naming rule, not which case it was.
const NAME_NOT_ALLOWED = "name not allowed for this member token";
export const NAME_REFUSED = "name not allowed";

// What a relay's close reason means, shown instead of the wire words (which stay as they are, so
// older relays work too). Keyed by close code and the exact reason: any other reason is shown as
// the relay sent it. Each text says what happened and what to do; doctor prints only these.
const GREETING_REFUSED = "the relay did not accept this client's greeting (4001): the relay and this hoptell may be different versions; update both";
export const CLOSE_TEXTS = {
  "4001 no hello": "the relay timed out waiting for this client's greeting (4001): check the network and try again",
  "4001 hello first": GREETING_REFUSED,
  "4001 bad hello": GREETING_REFUSED,
  "4005 unsupported protocol version": "the relay does not speak this hoptell's protocol (4005): update hoptell on this machine or the relay",
  "4002 bad roles": `the relay refused the roles (4002): at most ${MAX_ROLES} roles, each 1 to 64 letters, digits, "_" or "-", starting with a letter or digit`,
  "4002 no automatic name fits": "the relay could not assign an automatic name (4002): set HOPTELL_NAME to your member name or a permitted unique name",
  "4003 bad token": "the relay refused the token (4003): check HOPTELL_TOKEN, or run hoptell login if you use HOPTELL_AUTH=login",
  "4003 identity not linked to a member": "your sign-in worked, but the relay has no member for that identity (4003): ask the relay owner to run hoptell members link",
  "4003 sign-in is not configured on this relay": "this relay does not offer sign-in (4003): use a member token (HOPTELL_AUTH=token)",
  "4003 this relay requires a newer hoptell (protocol 2)": "this relay requires a newer hoptell (protocol 2, 4003): update hoptell, and unset HOPTELL_PROTOCOL=1 if you set it",
  "4003 member not held by this host": "member not held by this host (4003): ask the relay owner",
  "4003 hosted custody is fenced on this relay": "hosted custody is fenced on this relay (4003): ask the relay owner",
};
/** The text shown for a relay's close (`name`: the name this client asked for, if any). */
export function closeText(code, reason, name = null) {
  const why = String(reason ?? "");
  if (code === 4002 && why === "bad name") return `the relay refused the name${typeof name === "string" && name ? ` ${JSON.stringify(name.slice(0, 80))}` : ""} (4002): ${NAME_RULE}`;
  return CLOSE_TEXTS[`${code} ${why}`] ?? `${why || "closed"} (${code})`;
}
// Texts that already say what happened read whole; anything else follows "relay refused the connection: ".
const WHOLE = /^(the relay |this relay |this profile |your sign-in |the name is in use |member not held |hosted custody )/;
const ERRNO_WORDS = { ECONNREFUSED: "connection refused", ENOTFOUND: "the host name was not found", EAI_AGAIN: "the host name could not be looked up", ECONNRESET: "the connection was reset", EHOSTUNREACH: "the host cannot be reached", ENETUNREACH: "the network cannot be reached", ETIMEDOUT: "the connection timed out" };
/** A socket error in words ("connect ECONNREFUSED 127.0.0.1:9" -> "connection refused"). */
const socketWords = (text) => {
  const code = Object.keys(ERRNO_WORDS).find((c) => new RegExp(`\\b${c}\\b`).test(String(text)));
  return code ? ERRNO_WORDS[code] : String(text);
};
const clampRetry = (ms) => Math.min(60_000, Math.max(1000, Number(ms) || 2000)) * (0.75 + Math.random() * 0.5);

/**
 * Events: "ready", "message" (msg, confirm), "fatal" (reason; will not reconnect),
 * "down" (reason; will reconnect when `reconnect` is true), "closed" (after close()), "replaced" (reason; a newer
 * connection took this name: with `reconnect`, it reconnects once the name is free again).
 *
 * A "message" listener must call confirm() once the message is safely stored or
 * shown. Unconfirmed messages stay with the relay, which redelivers them after a
 * reconnect, so a failed write never loses a message.
 */
/**
 * The details a relay's refusal may carry for the caller to act on (design 6: busy, quota,
 * incomplete, gone), kept only when well formed: retry_after_ms, limit, state, missing (chunk
 * indexes), relay_expires.
 */
function refusalDetails(m) {
  const out = {};
  if (Number.isSafeInteger(m.retry_after_ms) && m.retry_after_ms >= 0 && m.retry_after_ms <= 3_600_000) out.retry_after_ms = m.retry_after_ms;
  if (typeof m.limit === "string" && /^[a-z_]{1,32}$/.test(m.limit)) out.limit = m.limit;
  if (typeof m.state === "string" && /^[a-z_]{1,32}$/.test(m.state)) out.state = m.state;
  if (Array.isArray(m.missing) && m.missing.length <= 800 && m.missing.every((i) => Number.isSafeInteger(i) && i >= 0 && i < 800)) out.missing = m.missing;
  if (Number.isSafeInteger(m.relay_expires) && m.relay_expires > 0 && m.relay_expires <= 8.64e15) out.relay_expires = m.relay_expires;
  return out;
}

export class RelayClient extends EventEmitter {
  /**
   * `protocol`: 2 (default; falls back to 1 on a relay that refuses 2, unless `require2`), or 1.
   * `name: null` asks a protocol-2 relay for an automatic name (the final one is `this.name`).
   * `onWelcome(welcome)`: may return a promise; runs before the client is ready and before any
   * delivery is passed on or acknowledged; if it throws, the client stops (fatal).
   * `onLegacy()`: called when falling back to protocol 1 (may throw to refuse the fallback).
   * `replace`: claim the name with one explicit replace (protocol 2), then behave normally.
   * `title`: the session's display-only title, a string or a function read at each hello (null
   * for none); sent cleaned, only in a protocol-2 receiving hello. Relays without the "title"
   * capability ignore it.
   */
  constructor({ url, token, name, mode = "peer", roles = [], reconnect = true, waitWhenReplaced = true, nameCheckMs = FREE_CHECK_MS, protocol = 2, require2 = false, onWelcome = null, onLegacy = null, replace = false, signIn = null, autoTag = null, hostMember = null, title = null }) {
    super();
    if (!url) throw new Error("HOPTELL_RELAY is not set (e.g. ws://192.0.2.10:7777): set it in the environment or your hoptell settings file; hoptell --help lists the file locations");
    // `signIn()`: signed in with an identity provider (design 1.6); resolves to {token, expiresAt}.
    if (!token && !signIn) throw new Error("HOPTELL_TOKEN is not set. Your user must configure a shared or per-member relay token.");
    this.signIn = signIn;
    this.autoTag = autoTag; // one of several sessions of this process: part of a protocol-1 automatic name
    // A host for one of its hosted members (design 4.5): `token` is the host credential; protocol 2 only.
    this.hostMember = hostMember;
    Object.assign(this, { url, token, name, mode, roles, reconnect, waitWhenReplaced, nameCheckMs, protocol: hostMember ? 2 : protocol, require2: hostMember ? true : require2, onWelcome, onLegacy, replaceOnce: replace });
    this.autoName = name == null;
    this.titleOf = typeof title === "function" ? title : () => title;
    this.titleAtRelay = null; // the title the relay keeps for this session's claim, as far as known
    this.statusAtRelay = null; // the same for its owner-only status (cap "status")
    this.lease = null; // protocol 2: {lease, secret, gen, incarnation} of this session's claim
    this.attempt = null; // the resume transaction in progress (kept for retries until a welcome)
    this.helloError = null;
    this.connected = false;
    this.lastError = null;
    this.pending = new Map();
    this.nextId = 1;
    this.delay = 1000;
    this.stopped = false;
    this.timers = new Set();
    this.probe = null;
    this.closedEmitted = false;
    // Protocol 2: refused with 4006 name_in_use or reserved, and waiting for the claim (the name
    // is held by another connection). An engine may send through a send-only connection meanwhile.
    this.waitingForName = false;
    this.on("fatal", () => (this.waitingForName = false)); // a final refusal ends the wait
  }

  /** A timer that close() cancels, so a closed client leaves nothing running. */
  later(fn, ms) {
    const t = setTimeout(() => {
      this.timers.delete(t);
      if (!this.stopped) fn();
    }, ms);
    t.unref?.();
    this.timers.add(t);
  }

  start() {
    if (this.stopped) return this; // a closed client never opens another connection
    // Signed in with an identity provider: get the token first (a credential lock, a refresh at
    // the provider), so the relay's hello window starts only when the hello is ready to go.
    // A token fetched for an earlier attempt that never opened: used only while it is recent.
    if (this.preAuth && (Date.now() - this.preAuthAt > 30_000 || this.preAuth.expiresAt <= Date.now() || this.forceAuth)) this.preAuth = null;
    if (this.signIn && !this.preAuth) {
      if (this.authing) return this;
      this.authing = true;
      // After the relay answered token_expired (design 1.7): one forced renewal, never the cached token.
      const force = Boolean(this.forceAuth);
      this.forceAuth = false;
      this.signIn({ force }).then(
        (a) => {
          this.authing = false;
          if (this.stopped) return;
          this.preAuth = a;
          this.preAuthAt = Date.now();
          this.authForced = force; // the token about to be used was just renewed
          this.start();
        },
        (e) => {
          this.authing = false;
          if (this.stopped) return;
          this.lastError = `sign-in: ${e.message}`;
          // A refusal that needs the user stops; a passing problem (the provider unreachable) is
          // tried again with the reconnect backoff.
          if (e.terminal || !this.reconnect) return this.emit("fatal", this.lastError);
          this.emit("down", this.lastError);
          this.later(() => this.start(), this.delay * (0.75 + Math.random() * 0.5));
          this.delay = Math.min(this.delay * 2, 30_000);
        },
      );
      return this;
    }
    const ws = (this.ws = new WebSocket(this.url, { handshakeTimeout: 10_000 }));
    let lastSeen = Date.now();
    const seen = () => (lastSeen = Date.now());
    const watchdog = setInterval(() => Date.now() - lastSeen > SILENCE_LIMIT_MS && ws.terminate(), 10_000);
    watchdog.unref();

    // Events from an older socket (after a reconnect) or after close() must not act on this client.
    const current = () => this.ws === ws && !this.stopped;
    ws.on("open", () => {
      if (!current()) return;
      seen();
      this.helloError = null;
      if (!this.signIn) return ws.send(JSON.stringify(this.hello()));
      const a = this.preAuth;
      this.preAuth = null; // each connection uses the token obtained for it, then gets a new one
      this.tokenExpiresAt = a.expiresAt;
      ws.send(JSON.stringify(this.hello(a)));
    });
    ws.on("ping", seen);
    let held = null; // frames arriving while the welcome is being committed
    const onFrame = (m) => {
      if (m.type === "welcome") {
        // The relay's deadline for a sign-in token (renewal is scheduled from it).
        if (Number.isFinite(m.auth_expires_at)) this.authDeadline = m.auth_expires_at;
        // Relays before 0.3 do not report how names are authenticated.
        this.relayAuth = ["shared", "members", "mixed"].includes(m.auth) ? m.auth : null;
        if (this.protocolInUse === 2) {
          if (typeof m.name === "string") this.name = m.name;
          this.realm = m.realm ?? null;
          this.member = m.member ?? null;
          this.incarnation = typeof m.incarnation === "string" ? m.incarnation : null;
          this.caps = Array.isArray(m.caps) ? m.caps : [];
          // A9: this connection's id, which a device proof binds (a new one after every reconnect).
          this.conn = typeof m.conn === "string" ? m.conn : null;
          if (m.claim) {
            this.lease = { lease: m.claim.lease, secret: m.claim.secret, gen: m.claim.gen, incarnation: m.claim.incarnation };
            this.attempt = null;
            // The title the relay now keeps for this claim: a new claim takes the hello's title
            // (when the relay supports titles), a resume keeps the one it had.
            if (this.helloClaim !== "resume") this.titleAtRelay = this.caps.includes("title") ? this.helloTitle : null;
            if (this.helloClaim !== "resume") this.statusAtRelay = null; // a new claim starts without one
          }
        }
        held = [];
        Promise.resolve()
          // The hook gets a check that this welcome's connection is still the live one.
          .then(() => this.onWelcome?.(m, { current: () => current() && ws.readyState === WebSocket.OPEN }))
          .then(
            () => {
              // The socket may have closed while the welcome was being committed.
              if (!current() || ws.readyState !== WebSocket.OPEN) return;
              this.connected = true;
              this.waitingForName = false;
              this.lastError = null;
              this.delay = 1000;
              this.authForced = false;
              if (this.signIn) this.scheduleReauth(ws);
              this.emit("ready");
              const frames = held;
              held = null;
              for (const f of frames) if (current()) onFrame(f);
            },
            (e) => {
              if (!current()) return;
              this.lastError = e.message;
              this.reconnect = false;
              held = null;
              ws.close(1000);
              this.emit("fatal", e.message);
            },
          );
        return;
      }
      if (m.type === "hello_error") {
        // member: on a refused name, the member whose credential this is (its names are allowed).
        this.helloError = { code: m.code, retryAfterMs: m.retry_after_ms, member: typeof m.member === "string" && NAME_RE.test(m.member) ? m.member : null };
        return;
      }
      // A relay notice for this member (design 4.1: contact requests waiting for the owner).
      if (m.type === "notice" && !m.id) return void this.emit("notice", m);
      // A9: the relay dropped this connection's device attachment (its key changed, or it was
      // revoked); the encrypted-messaging engine proves again, or stops.
      if (m.type === "e2ee_detached" && !m.id) return void this.emit("e2ee_detached", m);
      // The owner channel's Mini App (design 7.4): a request the relay forwards to this bridge.
      if (m.type === "app_req" && typeof m.rid === "string") return void this.emit("app_req", m);
      if (m.type === "message") {
        let confirmed = false;
        // {released: true}: the message reached a session (not held back by the contacts); the
        // relay grants a reply allowance only then (design 4.2).
        const confirm = ({ released = false } = {}) => {
          if (confirmed || ws.readyState !== 1) return;
          confirmed = true;
          ws.send(JSON.stringify({ type: "got", id: m.id, ...(released ? { released: true } : {}) }));
        };
        this.emit("message", m, confirm);
      } else if (m.type === "message_e2ee" && typeof m.delivery === "string") {
        // Encrypted deliveries (design 3.3, EXPERIMENTAL): only a relay started with
        // --experimental-e2ee sends them, to a connection that attached a device. ack(outcome)
        // removes it from the relay's durable queue ("delivered", or "refused" by the checks).
        let acked = false;
        const ack = (outcome = "delivered") => {
          if (acked || ws.readyState !== 1) return;
          acked = true;
          ws.send(JSON.stringify({ type: "e2ee_got", delivery: m.delivery, outcome }));
        };
        this.emit("message_e2ee", m, ack);
      } else if (m.id && this.pending.has(m.id)) {
        const p = this.pending.get(m.id);
        this.pending.delete(m.id);
        clearTimeout(p.timer);
        // kind "relay_error": the relay answered with a refusal, so the request was not accepted.
        // An expired retry (design 4.2) also names the original message and its deadline, kept
        // only when well formed.
        const original = m.code === "expired" && typeof m.message_id === "string" && REF_RE.test(m.message_id) && Number.isSafeInteger(m.expires) && m.expires > 0 && m.expires <= 8.64e15 ? { message_id: m.message_id, expires: m.expires } : {};
        m.type === "error" ? p.reject(Object.assign(new Error(m.error), { kind: "relay_error", code: m.code, ...original, ...refusalDetails(m) })) : p.resolve(m);
      }
    };
    ws.on("message", (raw) => {
      if (!current()) return;
      seen();
      let m;
      try {
        m = JSON.parse(raw);
      } catch {
        return;
      }
      if (held && m.type !== "welcome") {
        // Not yet ready: hold the frame (never acknowledged); too many means something is wrong.
        if (held.length >= MAX_HELD_FRAMES) return ws.terminate();
        return held.push(m);
      }
      onFrame(m);
    });
    ws.on("error", (e) => current() && (this.lastError = e.message));
    ws.on("close", (code, reason) => {
      clearInterval(watchdog);
      if (this.ws !== ws) return; // an older socket closing after a reconnect: not this connection
      this.connected = false;
      this.waitingForName = false; // set again below only for the protocol-2 wait for the name
      if (code >= 4000) this.lastError = closeText(code, reason, this.name);
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(Object.assign(new Error(`connection to relay lost${this.lastError ? `: ${this.lastError}` : ""}`), { kind: "lost" }));
      }
      this.pending.clear();
      if (this.stopped) return this.closedOnce();
      if (this.protocolInUse === 2 && this.closedV2(code)) return;
      // Another connection took this name. Reconnecting now would evict it in turn, so wait
      // until the relay no longer has the name online (a short-lived copy of this server,
      // like one an agent starts only to list tools, gives the name back when it exits).
      if (code === 4004 && this.reconnect && this.waitWhenReplaced && this.mode === "peer" && this.name.length <= 58) {
        this.emit("replaced", this.lastError);
        return this.whenNameFree(this.nameCheckMs[0]);
      }
      // A member token on an older relay that cannot assign names: the default name is not allowed.
      if (code === 4002 && this.autoName && this.legacyRelay) {
        this.lastError = "this relay does not assign names: set HOPTELL_NAME to the member-prefixed name your relay operator gave you";
      } else if (code === 4002 && String(reason) === NAME_NOT_ALLOWED) {
        // Say how to fix it: with the member's names when the relay says whose token this is (an
        // older relay does not, nor does any relay for a shared token).
        const who = this.helloError?.member;
        this.lastError = who
          ? `${NAME_REFUSED}: this is member ${who}'s token. Set HOPTELL_NAME to "${who}" or a unique name that starts with "${who}-" (64 characters at most) (4002)`
          : `${NAME_REFUSED}: a member token may use only its member's name, or a unique name that starts with that name and "-"; a shared token may not use a hosted member's names (4002)`;
      }
      // Bad token, bad name or protocol: retrying would not help.
      // The relay does not know the token (a broker access token after a relay restart, design 1.7):
      // renew once by force and reconnect; a freshly renewed token refused again needs the user.
      if (code === 4003 && this.signIn && this.helloError?.code === "token_expired") {
        if (this.authForced) {
          this.lastError = "the relay refused a freshly renewed sign-in: run hoptell login";
          return this.emit("fatal", this.lastError);
        }
        this.forceAuth = true;
        this.emit("down", this.lastError);
        return this.later(() => this.start(), 500);
      }
      // A sign-in token that expired (for example while the machine slept) is renewed by reconnecting;
      // every other refusal stops with its reason.
      if (code === 4003 && this.signIn && /token expired/.test(String(reason))) {
        this.emit("down", this.lastError);
        return this.later(() => this.start(), 500);
      }
      // The relay could not reach the identity provider: a passing problem, tried again with backoff.
      if (code === 4003 && this.signIn && /identity provider unavailable/.test(String(reason)) && this.reconnect) {
        this.emit("down", this.lastError);
        this.later(() => this.start(), this.delay * (0.75 + Math.random() * 0.5));
        this.delay = Math.min(this.delay * 2, 30_000);
        return;
      }
      // "no hello" is the relay's hello timeout (this side was slow, or the network stalled), not a
      // refused hello: tried again with backoff like a lost connection.
      if (code === 4001 && String(reason) === "no hello" && this.reconnect) {
        this.emit("down", this.lastError);
        this.later(() => this.start(), this.delay * (0.75 + Math.random() * 0.5));
        this.delay = Math.min(this.delay * 2, 30_000);
        return;
      }
      if ([4001, 4002, 4003, 4004, 4005].includes(code)) return this.emit("fatal", this.lastError);
      this.emit("down", this.lastError);
      if (!this.reconnect) return;
      this.later(() => this.start(), this.delay * (0.75 + Math.random() * 0.5)); // jitter
      this.delay = Math.min(this.delay * 2, 30_000);
    });
    return this;
  }

  /** Before a sign-in token expires, send a fresh one on the live connection (reauth). */
  scheduleReauth(ws, retry = false, forced = false) {
    // Before the relay's deadline (or the token's own expiry): two minutes ahead, or halfway for
    // short-lived tokens, with some jitter; a failed attempt is tried again after a pause (the relay
    // closes the connection at its deadline).
    const until = this.authDeadline ?? this.tokenExpiresAt ?? Date.now() + 300_000;
    const left = until - Date.now();
    const lead = Math.min(120_000, left / 2);
    const at = retry ? REAUTH_RETRY_MS : Math.max(5000, left - lead - Math.floor(Math.random() * Math.min(30_000, lead / 4)));
    const live = () => this.ws === ws && ws.readyState === WebSocket.OPEN;
    // Refusals that a retry cannot fix stop this client with their reason (no renewal loop).
    const stop = (why) => {
      this.lastError = why;
      this.reconnect = false;
      ws.close(1000);
      this.emit("fatal", this.lastError);
    };
    this.later(() => {
      if (!live()) return;
      this.signIn({ force: forced }).then(
        (a) => {
          if (!live()) return;
          this.tokenExpiresAt = a.expiresAt;
          this.rpc({ type: "reauth", token: a.token }).then(
            (r) => {
              if (Number.isFinite(r.auth_expires_at)) this.authDeadline = r.auth_expires_at;
              this.scheduleReauth(ws);
            },
            (e) => {
              if (!live()) return;
              if (["bad_token", "not_linked", "other_identity"].includes(e.code)) return stop(`sign-in renewal refused: ${e.message} (${e.code})`);
              // The relay does not know the token: one forced renewal, then the user is needed.
              if (e.code === "token_expired") return forced ? stop("the relay refused a freshly renewed sign-in: run hoptell login") : this.scheduleReauth(ws, true, true);
              this.lastError = `sign-in renewal: ${e.message}`;
              this.emit("down", this.lastError);
              this.scheduleReauth(ws, true);
            },
          );
        },
        (e) => {
          if (!live()) return;
          if (e.terminal) return stop(`sign-in: ${e.message}`);
          this.lastError = `sign-in: ${e.message}`;
          this.emit("down", this.lastError);
          this.scheduleReauth(ws, true);
        },
      );
    }, at);
  }

  /** The hello for the protocol in use; a peer claim for protocol 2. `bearer`: {issuer, token} of a sign-in. */
  hello(bearer = null) {
    this.protocolInUse = this.protocol === 2 && !this.legacyRelay ? 2 : 1;
    const base = bearer
      ? { type: "hello", auth: { kind: bearer.kind === "broker" ? "broker" : "oidc", issuer: bearer.issuer, token: bearer.token }, host: HOSTNAME, mode: this.mode, roles: this.roles }
      : this.hostMember
        ? { type: "hello", auth: { kind: "host", token: this.token, member: this.hostMember }, host: HOSTNAME, mode: this.mode, roles: this.roles }
        : { type: "hello", token: this.token, host: HOSTNAME, mode: this.mode, roles: this.roles };
    if (this.protocolInUse === 1) {
      if (this.autoName && this.name == null) this.name = this.mode === "send" ? `${HOSTNAME}-cli` : legacyAutoName(HOSTNAME, process.pid, this.autoTag);
      return { ...base, v: PROTOCOL, name: this.name };
    }
    const named = this.autoName && !this.lease ? { name: null, auto: { host: HOSTNAME, n: process.pid } } : { name: this.name };
    if (this.mode === "send") return { ...base, v: 2, ...named };
    // A title never decides anything here: a failing source sends none.
    let title = null;
    try {
      title = cleanTitle(this.titleOf());
    } catch {
      title = null;
    }
    let claim;
    if (this.replaceOnce) {
      claim = { action: "replace" };
      this.replaceOnce = false; // one-shot: a reconnect never replaces again
    } else if (this.lease) {
      this.attempt ??= crypto.randomBytes(8).toString("hex");
      claim = { action: "resume", ...this.lease, attempt: this.attempt };
    } else claim = { action: "acquire" };
    this.helloClaim = claim.action;
    this.helloTitle = title;
    return { ...base, v: 2, ...named, claim, ...(title ? { title } : {}) };
  }

  /** Protocol-2 close handling; returns true when handled. */
  closedV2(code) {
    const err = this.helloError?.code;
    if (code === 4005 && !this.require2) {
      // A protocol-1 relay: fall back once (legacy semantics), unless the profile forbids it.
      // onLegacy may be asynchronous (it records the profile under a lock): wait for it.
      Promise.resolve()
        .then(() => this.onLegacy?.())
        .then(
          () => {
            if (this.stopped) return;
            this.legacyRelay = true;
            this.later(() => this.start(), 0);
          },
          (e) => {
            if (this.stopped) return;
            this.lastError = e.message;
            this.emit("fatal", e.message);
          },
        );
      return true;
    }
    if (code === 4005) {
      this.emit("fatal", (this.lastError = "this profile requires protocol 2, but the relay does not support it: ask the relay operator to update hoptell, or check that HOPTELL_RELAY is the relay you meant"));
      return true;
    }
    if (code === 4006 && (err === "lease_unknown" || err === "relay_restarted")) {
      this.lease = null; // the relay no longer knows this session: claim the name again
      this.attempt = null;
      this.emit("down", this.lastError);
      this.later(() => this.start(), 200);
      return true;
    }
    if (code === 4006 && (err === "name_in_use" || err === "reserved")) {
      if (!this.reconnect || !this.waitWhenReplaced) {
        this.emit("fatal", (this.lastError = "the name is in use by another session: wait for that session to end, or choose another HOPTELL_NAME"));
        return true;
      }
      this.waitingForName = this.mode === "peer";
      this.emit("replaced", this.lastError);
      this.waitForClaim(this.helloError?.retryAfterMs);
      return true;
    }
    if (code === 4007 || code === 4004) {
      // Superseded by this session's own newer connection, or deliberately replaced: stop.
      this.emit("fatal", this.lastError);
      return true;
    }
    return false;
  }

  /** Protocol 2: ask claim_status (send-only, never evicting) until the name is free, then acquire. */
  waitForClaim(retryAfterMs) {
    this.later(async () => {
      const probe = (this.probe = new RelayClient({ url: this.url, token: this.token, signIn: this.signIn, hostMember: this.hostMember, name: this.name, mode: "send", reconnect: false, require2: true }));
      let state = null;
      let hint;
      let refused = null;
      probe.on("fatal", (r) => (refused = r));
      try {
        await probe.start().ready();
        const r = await probe.rpc({ type: "claim_status", name: this.name });
        state = r.state;
        hint = r.retry_after_ms;
      } catch {
        // unknown: keep waiting
      } finally {
        probe.close();
        if (this.probe === probe) this.probe = null;
      }
      if (this.stopped) return;
      if (refused && !/protocol 2/.test(refused)) {
        this.lastError = refused;
        return this.emit("fatal", refused);
      }
      if (state === "free") return this.start();
      this.waitForClaim(hint);
    }, clampRetry(retryAfterMs));
  }

  /** Report the end of this client once: settles ready() waits. */
  closedOnce() {
    if (this.closedEmitted) return;
    this.closedEmitted = true;
    this.emit("closed");
  }

  /** Resolve once connected (or reject on fatal error / timeout, or after close()). */
  ready(timeoutMs = 10_000) {
    if (this.stopped) return Promise.reject(new Error("the relay client was closed"));
    if (this.connected) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const done = (fn, v) => {
        clearTimeout(t);
        this.off("ready", onReady).off("fatal", onFail).off("down", onDown).off("closed", onClosed);
        fn(v);
      };
      const onReady = () => done(resolve);
      const onFail = (r) => done(reject, new Error(WHOLE.test(String(r)) ? String(r) : `relay refused the connection: ${r}`));
      const onDown = (r) => !this.reconnect && done(reject, new Error(`cannot reach relay ${this.url}: ${r || "connection failed"}`));
      const onClosed = () => done(reject, new Error("the relay client was closed"));
      // The budget ran out, usually after retries that each failed at once: say the last failure.
      const t = setTimeout(() => done(reject, new Error(`could not connect to ${this.url} within ${Math.round(timeoutMs / 1000)} s; last error: ${this.lastError ? socketWords(this.lastError) : "no answer"}. Check that the relay is running and HOPTELL_RELAY is correct`)), timeoutMs);
      this.on("ready", onReady).on("fatal", onFail).on("down", onDown).on("closed", onClosed);
    });
  }

  /**
   * Reconnect once the relay no longer has this name online. Checks log in send-only, which
   * never takes over a name, as "<name>-check": the relay leaves the caller out of its peer
   * list, and member-token name rules accept the suffix. A failed check leaves the name
   * unavailable: only a successful peer list showing it absent or offline allows reconnection.
   */
  whenNameFree(wait) {
    this.later(async () => {
      const probe = (this.probe = new RelayClient({ url: this.url, token: this.token, signIn: this.signIn, hostMember: this.hostMember, name: `${this.name}-check`, mode: "send", reconnect: false }));
      let refused = null;
      probe.on("fatal", (r) => (refused = r));
      let free = false;
      try {
        await probe.start().ready();
        free = !(await probe.list()).some((p) => p.name === this.name && p.online);
      } catch {
        // unknown (relay unreachable or slow): only a successful check may give the name back
      } finally {
        probe.close();
        if (this.probe === probe) this.probe = null;
      }
      if (this.stopped) return;
      if (refused) {
        // The relay no longer accepts these credentials (e.g. a revoked member token).
        this.lastError = refused;
        return this.emit("fatal", refused);
      }
      if (free) return this.start();
      this.whenNameFree(Math.min(wait * 2, this.nameCheckMs[1]));
    }, wait);
  }

  rpc(payload) {
    if (!this.connected || this.stopped) {
      return Promise.reject(Object.assign(new Error(`not connected to relay ${this.url}${this.lastError ? ` (${this.lastError})` : ""}`), { kind: "not_sent" }));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Object.assign(new Error("relay did not answer in time"), { kind: "no_answer" }));
      }, RPC_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ ...payload, id }));
    });
  }

  /** The relay's list; `status`: also the statuses of the caller's own member's sessions (cap "status"). */
  list({ status = false } = {}) {
    return this.rpc({ type: "list", ...(status && this.caps?.includes("status") ? { status: true } : {}) }).then((r) => r.peers);
  }

  /** A frame without an answer (an owner app response): sent when connected, else false. */
  frame(payload) {
    if (!this.connected || this.stopped || this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(payload));
    return true;
  }

  /**
   * A controlled resume: drop the connection without giving the name back, so the client
   * reconnects and resumes its lease, and the relay sends unconfirmed deliveries again.
   */
  cycle() {
    if (this.stopped || !this.connected || !this.ws) return false;
    this.ws.terminate();
    return true;
  }

  /**
   * Resolves to the relay's ack: {state: "delivered"|"queued"|"unconfirmed"|"fanout", count?}; a
   * direct send on a protocol-2 relay also names the recipient as the relay authenticated it
   * (`recipient: {auth, member, realm}`).
   * On a relay with idempotent sends, a send whose outcome is unknown (connection lost or no
   * answer) is retried with the same operation id within `retryMs` (at most five minutes), but
   * only on the same relay incarnation, realm, member and session name; the relay executes it
   * once. Otherwise the error is passed on: the outcome stays unknown.
   */
  async send(to, text, ttl, replyTo, { retryMs = 30_000, excludeHosted = false, toMember = null, asHolder = false } = {}) {
    // toMember (design 7.2): the relay delivers only while that member holds the name. Sent only
    // to a relay that advertises it; without it nothing is sent (the caller decides what to do).
    if (toMember != null && !this.supportsToMember()) {
      throw Object.assign(new Error("this relay cannot guarantee the recipient (it does not support to_member); upgrade it"), { kind: "not_sent", code: "no_to_member" });
    }
    // The owner channel's backstop (design 7.3, 2.6): a send to this realm's pinned bridge name
    // (`ownerChannelName()`, set by the callers that know the pins) goes only by name, with
    // toMember = this connection's own member; anything else is refused before it is written.
    const bridge = typeof this.ownerChannelName === "function" ? this.ownerChannelName() : null;
    if (bridge && typeof to === "string" && (to === bridge || to === `@${bridge}`) && (to.startsWith("@") || !this.member?.id || toMember !== this.member.id)) {
      throw Object.assign(new Error("a send to your owner channel must go by name, to your own member; nothing was sent"), { kind: "not_sent", code: "owner_channel_unguarded" });
    }
    // asHolder (bug B2): a send-only connection sends only while a session of its own principal
    // holds its name, which the relay checks when the send executes (cap "as_holder").
    if (asHolder && !(this.connected && this.protocolInUse === 2 && this.mode === "send" && this.caps?.includes("as_holder"))) {
      throw Object.assign(new Error("this relay cannot verify who holds the name; update it to a version that supports this check"), { kind: "not_sent", code: "no_as_holder" });
    }
    // excludeHosted (design 4.5): a fan-out under an encryption policy leaves hosted members out.
    const payload = { type: "send", to, text, ...(ttl ? { ttl } : {}), ...(replyTo ? { reply_to: replyTo } : {}), ...(excludeHosted && to.startsWith("@") ? { exclude_hosted: true } : {}), ...(toMember != null ? { to_member: toMember } : {}), ...(asHolder ? { as_holder: true } : {}) };
    const identity = () => (this.protocolInUse === 2 && this.caps?.includes("idempotent-send") && this.incarnation ? JSON.stringify([this.incarnation, this.realm?.id, this.member?.id ?? null, this.name]) : null);
    const first = identity();
    if (!first) return this.rpc(payload);
    payload.op = newOpId();
    const deadline = Date.now() + Math.min(retryMs, OP_RETRY_MS);
    for (;;) {
      try {
        return await this.rpc(payload);
      } catch (e) {
        if (e.kind !== "lost" && e.kind !== "no_answer") throw e; // refused or never written: no doubt
        const left = deadline - Date.now();
        if (left <= 0 || this.stopped) throw e;
        try {
          await this.ready(left);
        } catch {
          throw e;
        }
        if (identity() !== first) throw e; // another relay instance or identity: report it as unknown
      }
    }
  }

  /**
   * Set (text) or clear (null) this session's title at the relay, on a relay with the "set_title"
   * capability (a receiving protocol-2 connection only). Resolves to false when nothing was sent;
   * rejects with the relay's refusal (code not_allowed, title_rate or bad_request).
   */
  async setTitle(title) {
    if (!(this.connected && this.protocolInUse === 2 && this.mode === "peer" && this.caps?.includes("set_title"))) return false;
    const t = title == null ? null : cleanTitle(title);
    const r = await this.rpc({ type: "set_title", title: t });
    this.titleAtRelay = typeof r.title === "string" ? r.title : null;
    return true;
  }

  /**
   * Set (text) or clear (null) this session's owner-only status at the relay (cap "status", a
   * receiving protocol-2 connection only). Resolves to false when nothing was sent; rejects with
   * the relay's refusal (code not_allowed, status_rate or bad_request).
   */
  async setStatus(status) {
    if (!(this.connected && this.protocolInUse === 2 && this.mode === "peer" && this.caps?.includes("status"))) return false;
    await this.rpc({ type: "set_status", status: status ?? null });
    this.statusAtRelay = status ?? null;
    return true;
  }

  /** Whether the connected relay checks a send's recipient member (cap "to_member", protocol 2). */
  supportsToMember() {
    return this.connected && this.protocolInUse === 2 && Boolean(this.caps?.includes("to_member"));
  }

  /**
   * Stop for good, at once: no more reconnects, checks or requests. Waits and pending requests
   * settle now (a request already written to the socket is "lost": its outcome is unknown), and
   * the socket is terminated if the relay does not finish the close handshake within a second.
   */
  close() {
    if (this.stopped) return;
    this.stopped = true;
    this.connected = false;
    this.waitingForName = false;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.probe?.close(); // an in-flight name check ends now instead of after its timeouts
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(Object.assign(new Error("the relay client was closed before the relay answered"), { kind: "lost" }));
    }
    this.pending.clear();
    const ws = this.ws;
    if (ws && ws.readyState !== WebSocket.CLOSED) {
      // A clean shutdown gives a protocol-2 name back at once (a crash leaves a reservation).
      if (ws.readyState === WebSocket.OPEN && this.protocolInUse === 2 && this.mode === "peer" && this.lease) ws.send(JSON.stringify({ type: "release" }));
      ws.close();
      setTimeout(() => ws.terminate(), 1000).unref();
    }
    this.closedOnce();
  }
}

/** "90", "90s", "10m", "2h" or "1d" -> seconds; throws on anything else or beyond MAX_TTL_S. */
export function parseTtl(value) {
  const m = String(value).trim().match(/^(\d+)([smhd]?)$/);
  const secs = m ? Number(m[1]) * { "": 1, s: 1, m: 60, h: 3600, d: 86400 }[m[2]] : NaN;
  if (!(secs >= 1 && secs <= MAX_TTL_S)) throw new Error(`invalid ttl "${value}": use a positive whole number with an optional s, m, h or d suffix, from 1s to 7d`);
  return secs;
}

/** A message reference given by a user or agent: a UUID, returned in lowercase. */
export function parseRef(value) {
  const ref = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!REF_RE.test(ref)) throw new Error(`invalid message reference "${String(value).slice(0, 80)}": expected the UUID shown as "Message reference"`);
  return ref;
}

export const describeAck = (to, { state, count, skipped, expires, message_id: ref }, ttl, replyTo) => {
  // A relay that applies the ttl echoes `expires`; older relays ignore the request.
  const expiry = !ttl ? "" : expires ? ` The relay drops queued copies at ${new Date(expires).toISOString()}.` : " This relay does not support expiry, so the message has no deadline.";
  // Relays before references omit message_id; say so instead of implying a reply link.
  const reference = typeof ref === "string" && REF_RE.test(ref)
    ? ` Message reference: ${ref}.`
    : ` This relay does not provide message references${replyTo ? ", so the link to the message you replied to was not kept" : ""}.`;
  const outcome =
    {
      delivered: `Delivered to ${to}.`,
      queued: `Queued at the relay for ${to}; delivery waits until the peer can receive it.${expiry}`,
      unconfirmed: `Sent to ${to}, but it has not confirmed receipt yet; the relay will requeue it if ${to} disconnects.${expiry}`,
      fanout: `Sent to ${count} online ${count === 1 ? "peer" : "peers"} matching ${to}${skipped?.length ? `; skipped (busy, queue full): ${skipped.join(", ")}` : ""}.${expiry}`,
    }[state] || `Sent to ${to} (${state}).`;
  return outcome + reference;
};

/**
 * One list_peers row: the address first, then the self-reported host, the roles, and the title as
 * an untrusted label (cleaned again, quoted with JSON.stringify, after "title:"). `index`: the
 * addresses visible in the same list (resemblanceIndex, the row's own included) and `own`, the
 * row's address; a title that equals another of them, or slugs to one, is marked. Only what the
 * caller can see is compared, so no row depends on hidden peers.
 */
export const formatPeer = (p, index = null, own = p.name) => {
  const title = cleanTitle(p.title);
  const resembles = title && index && resemblesIn(index, title, own);
  return `${p.name} (reported host: ${p.host})${p.roles?.length ? ` [${p.roles.join(", ")}]` : ""}${title ? ` title: ${JSON.stringify(title)}${resembles ? " (title resembles another address)" : ""}` : ""} ${p.online ? "online" : "offline"}${p.queued ? `, ${p.queued} queued` : ""}${p.custody === "hosted" ? " (hosted: the host can read messages)" : ""}`;
};

/**
 * The rows of one peers list. Titles are compared with the addresses of this list and the
 * caller's own (`self`), never another; `label(name)` changes only how an address is shown. The
 * addresses are indexed once, so a list of n rows costs O(n) (`slug`: tests count its calls).
 */
export function formatPeers(peers, { self = null, label = (n) => n, slug } = {}) {
  const index = resemblanceIndex([...peers.map((p) => p.name), ...(typeof self === "string" ? [self] : [])], slug ? { slug } : {});
  return peers.map((p) => formatPeer({ ...p, name: label(p.name) }, index, p.name));
}
