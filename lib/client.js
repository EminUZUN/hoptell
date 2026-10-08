// Relay client used by the MCP server and the CLI.
import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { HOSTNAME, MAX_TTL_S, PROTOCOL, REF_RE } from "./config.js";

const RPC_TIMEOUT_MS = 10_000; // above the relay's 5s delivery-ack window
const SILENCE_LIMIT_MS = 45_000; // relay pings every 15s; silence means a dead link
const FREE_CHECK_MS = [2000, 60_000]; // after being replaced: first and longest wait between checks

/**
 * Events: "ready", "message" (msg, confirm), "fatal" (reason; will not reconnect),
 * "down" (reason; will reconnect when `reconnect` is true), "replaced" (reason; a newer
 * connection took this name: with `reconnect`, it reconnects once the name is free again).
 *
 * A "message" listener must call confirm() once the message is safely stored or
 * shown. Unconfirmed messages stay with the relay, which redelivers them after a
 * reconnect, so a failed write never loses a message.
 */
export class RelayClient extends EventEmitter {
  constructor({ url, token, name, mode = "peer", roles = [], reconnect = true, nameCheckMs = FREE_CHECK_MS }) {
    super();
    if (!url) throw new Error("HOPTELL_RELAY is not set (e.g. ws://192.0.2.10:7777); see .env.example");
    if (!token) throw new Error("HOPTELL_TOKEN is not set; use the same token as the relay");
    Object.assign(this, { url, token, name, mode, roles, reconnect, nameCheckMs });
    this.connected = false;
    this.lastError = null;
    this.pending = new Map();
    this.nextId = 1;
    this.delay = 1000;
    this.stopped = false;
  }

  start() {
    const ws = (this.ws = new WebSocket(this.url, { handshakeTimeout: 10_000 }));
    let lastSeen = Date.now();
    const seen = () => (lastSeen = Date.now());
    const watchdog = setInterval(() => Date.now() - lastSeen > SILENCE_LIMIT_MS && ws.terminate(), 10_000);
    watchdog.unref();

    ws.on("open", () => {
      seen();
      ws.send(JSON.stringify({ type: "hello", v: PROTOCOL, name: this.name, token: this.token, host: HOSTNAME, mode: this.mode, roles: this.roles }));
    });
    ws.on("ping", seen);
    ws.on("message", (raw) => {
      seen();
      let m;
      try {
        m = JSON.parse(raw);
      } catch {
        return;
      }
      if (m.type === "welcome") {
        this.connected = true;
        this.lastError = null;
        this.delay = 1000;
        this.emit("ready");
      } else if (m.type === "message") {
        let confirmed = false;
        const confirm = () => {
          if (confirmed || ws.readyState !== 1) return;
          confirmed = true;
          ws.send(JSON.stringify({ type: "got", id: m.id }));
        };
        this.emit("message", m, confirm);
      } else if (m.id && this.pending.has(m.id)) {
        const p = this.pending.get(m.id);
        this.pending.delete(m.id);
        clearTimeout(p.timer);
        // kind "relay_error": the relay answered with a refusal, so the request was not accepted.
        m.type === "error" ? p.reject(Object.assign(new Error(m.error), { kind: "relay_error" })) : p.resolve(m);
      }
    });
    ws.on("error", (e) => (this.lastError = e.message));
    ws.on("close", (code, reason) => {
      clearInterval(watchdog);
      this.connected = false;
      if (code >= 4000) this.lastError = `${reason || "closed"} (${code})`;
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(Object.assign(new Error(`connection to relay lost${this.lastError ? `: ${this.lastError}` : ""}`), { kind: "lost" }));
      }
      this.pending.clear();
      if (this.stopped) return;
      // Another connection took this name. Reconnecting now would evict it in turn, so wait
      // until the relay no longer has the name online (a short-lived copy of this server,
      // like one an agent starts only to list tools, gives the name back when it exits).
      if (code === 4004 && this.reconnect && this.mode === "peer" && this.name.length <= 58) {
        this.emit("replaced", this.lastError);
        return this.whenNameFree(this.nameCheckMs[0]);
      }
      // Bad token, bad name or protocol: retrying would not help.
      if ([4001, 4002, 4003, 4004, 4005].includes(code)) return this.emit("fatal", this.lastError);
      this.emit("down", this.lastError);
      if (!this.reconnect) return;
      setTimeout(() => !this.stopped && this.start(), this.delay).unref?.();
      this.delay = Math.min(this.delay * 2, 30_000);
    });
    return this;
  }

  /** Resolve once connected (or reject on fatal error / timeout). */
  ready(timeoutMs = 10_000) {
    if (this.connected) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const done = (fn, v) => {
        clearTimeout(t);
        this.off("ready", onReady).off("fatal", onFail).off("down", onDown);
        fn(v);
      };
      const onReady = () => done(resolve);
      const onFail = (r) => done(reject, new Error(`relay refused the connection: ${r}`));
      const onDown = (r) => !this.reconnect && done(reject, new Error(`cannot reach relay ${this.url}: ${r || "connection failed"}`));
      const t = setTimeout(() => done(reject, new Error(`timed out connecting to ${this.url}${this.lastError ? ` (${this.lastError})` : ""}`)), timeoutMs);
      this.on("ready", onReady).on("fatal", onFail).on("down", onDown);
    });
  }

  /**
   * Reconnect once the relay no longer has this name online. Checks log in send-only, which
   * never takes over a name, as "<name>-check": the relay leaves the caller out of its peer
   * list, and member-token name rules accept the suffix. A failed check leaves the name
   * unavailable: only a successful peer list showing it absent or offline allows reconnection.
   */
  whenNameFree(wait) {
    setTimeout(async () => {
      if (this.stopped) return;
      const probe = new RelayClient({ url: this.url, token: this.token, name: `${this.name}-check`, mode: "send", reconnect: false });
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
      }
      if (this.stopped) return;
      if (refused) {
        // The relay no longer accepts these credentials (e.g. a revoked member token).
        this.lastError = refused;
        return this.emit("fatal", refused);
      }
      if (free) return this.start();
      this.whenNameFree(Math.min(wait * 2, this.nameCheckMs[1]));
    }, wait).unref?.();
  }

  rpc(payload) {
    if (!this.connected) {
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

  list() {
    return this.rpc({ type: "list" }).then((r) => r.peers);
  }

  /** Resolves to the relay's ack: {state: "delivered"|"queued"|"unconfirmed"|"fanout", count?}. */
  send(to, text, ttl, replyTo) {
    return this.rpc({ type: "send", to, text, ...(ttl ? { ttl } : {}), ...(replyTo ? { reply_to: replyTo } : {}) });
  }

  close() {
    this.stopped = true;
    this.ws?.close();
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
  const expiry = !ttl ? "" : expires ? ` If it is still queued after ${ttl}s, the relay drops it.` : " This relay does not support expiry, so the message has no deadline.";
  // Relays before references omit message_id; say so instead of implying a reply link.
  const reference = typeof ref === "string" && REF_RE.test(ref)
    ? ` Message reference: ${ref}.`
    : ` This relay does not provide message references${replyTo ? ", so the link to the message you replied to was not kept" : ""}.`;
  const outcome =
    {
      delivered: `Delivered to ${to}.`,
      queued: `The relay queued the message for ${to} and will deliver it when ${to} can take it (offline or busy).${expiry}`,
      unconfirmed: `Sent to ${to}, but it has not confirmed receipt yet; the relay will requeue it if ${to} disconnects.${expiry}`,
      fanout: `Sent to ${count} online peer(s) matching ${to}${skipped?.length ? `; skipped (busy, queue full): ${skipped.join(", ")}` : ""}.${expiry}`,
    }[state] || `Sent to ${to} (${state}).`;
  return outcome + reference;
};

export const formatPeer = (p) =>
  `${p.name} (${p.host})${p.roles?.length ? ` [${p.roles.join(", ")}]` : ""} ${p.online ? "online" : "offline"}${p.queued ? `, ${p.queued} queued` : ""}`;
