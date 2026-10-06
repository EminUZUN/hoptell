// Relay client used by the MCP server and the CLI.
import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { HOSTNAME, PROTOCOL } from "./config.js";

const RPC_TIMEOUT_MS = 10_000; // above the relay's 5s delivery-ack window
const SILENCE_LIMIT_MS = 45_000; // relay pings every 15s; silence means a dead link

/**
 * Events: "ready", "message" (msg, confirm), "fatal" (reason; will not reconnect),
 * "down" (reason; will reconnect when `reconnect` is true).
 *
 * A "message" listener must call confirm() once the message is safely stored or
 * shown. Unconfirmed messages stay with the relay, which redelivers them after a
 * reconnect, so a failed write never loses a message.
 */
export class RelayClient extends EventEmitter {
  constructor({ url, token, name, mode = "peer", roles = [], reconnect = true }) {
    super();
    if (!url) throw new Error("HOPTELL_RELAY is not set (e.g. ws://192.0.2.10:7777); see .env.example");
    if (!token) throw new Error("HOPTELL_TOKEN is not set; use the same token as the relay");
    Object.assign(this, { url, token, name, mode, roles, reconnect });
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
        m.type === "error" ? p.reject(new Error(m.error)) : p.resolve(m);
      }
    });
    ws.on("error", (e) => (this.lastError = e.message));
    ws.on("close", (code, reason) => {
      clearInterval(watchdog);
      this.connected = false;
      if (code >= 4000) this.lastError = `${reason || "closed"} (${code})`;
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error(`connection to relay lost${this.lastError ? `: ${this.lastError}` : ""}`));
      }
      this.pending.clear();
      if (this.stopped) return;
      // Bad token, bad name, or another session took this name: retrying would not help
      // (and two sessions with one name would keep evicting each other).
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

  rpc(payload) {
    if (!this.connected) {
      return Promise.reject(new Error(`not connected to relay ${this.url}${this.lastError ? ` (${this.lastError})` : ""}`));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("relay did not answer in time"));
      }, RPC_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ ...payload, id }));
    });
  }

  list() {
    return this.rpc({ type: "list" }).then((r) => r.peers);
  }

  /** Resolves to the relay's ack: {state: "delivered"|"queued"|"unconfirmed"|"fanout", count?}. */
  send(to, text) {
    return this.rpc({ type: "send", to, text });
  }

  close() {
    this.stopped = true;
    this.ws?.close();
  }
}

export const describeAck = (to, { state, count, skipped }) =>
  ({
    delivered: `Delivered to ${to}.`,
    queued: `The relay queued the message for ${to} and will deliver it when ${to} can take it (offline or busy).`,
    unconfirmed: `Sent to ${to}, but it has not confirmed receipt yet; the relay will requeue it if ${to} disconnects.`,
    fanout: `Sent to ${count} online peer(s) matching ${to}${skipped?.length ? `; skipped (busy, queue full): ${skipped.join(", ")}` : ""}.`,
  })[state] || `Sent to ${to} (${state}).`;

export const formatPeer = (p) =>
  `${p.name} (${p.host})${p.roles?.length ? ` [${p.roles.join(", ")}]` : ""} ${p.online ? "online" : "offline"}${p.queued ? `, ${p.queued} queued` : ""}`;
