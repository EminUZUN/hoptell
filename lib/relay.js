// hoptell relay: a small WebSocket hub that routes plain-text messages between
// agent sessions on different machines.
//
// Protocol v1 (JSON text frames):
//   client -> relay  {type:"hello", v:1, name, token, host, mode:"peer"|"send", roles:[...]}
//                    {type:"send", id, to, text}       to: a peer name, "@<role>" or "@all"
//                    {type:"list", id}
//                    {type:"got", id}                  receiver confirms a message
//   relay  -> client {type:"welcome", name}
//                    {type:"error", id?, error}
//                    {type:"ack", id, state:"delivered"|"queued"|"unconfirmed"|"fanout", count?, skipped?}
//                    {type:"peers", id, peers:[{name, host, roles, online, queued}]}
//                    {type:"message", id, from, fromHost, to, text, ts, noReply?}
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
import { WebSocketServer } from "ws";
import { NAME_RE, PROTOCOL } from "./config.js";

export const MAX_TEXT = 100_000;
const MAX_QUEUE_PER_PEER = 50;
const MAX_INFLIGHT_PER_PEER = 50; // unconfirmed messages per receiver; more wait in its queue
const MAX_QUEUED_TOTAL = 2000;
const MAX_ROLES = 16;
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

/**
 * Start a relay. Resolves to {port, close()} once listening.
 * @param {{host: string, port: number, token?: string, members?: {name: string, token: string}[], log?: Function}} opts
 */
export function startRelay({ host, port, token, members = null, log = (...a) => console.log(new Date().toISOString(), ...a) }) {
  if (!host) throw new Error("relay host is required: pass --host <LAN-or-VPN-IP> (or 0.0.0.0 for every interface)");
  if (!token && !members?.length) throw new Error(`set HOPTELL_TOKEN (shared secret) or HOPTELL_MEMBERS (per-member tokens); ${TOKEN_HELP}`);
  const credentials = [];
  if (token) {
    checkToken(token);
    credentials.push({ member: null, digest: storedDigest(token) });
  }
  for (const m of members || []) {
    if (!NAME_RE.test(m?.name || "")) throw new Error(`members: invalid member name "${m?.name}"`);
    checkToken(m.token, `token of member "${m.name}"`);
    // Name spaces must not overlap: with "alice" and "alice-bob", alice could use "alice-bob-x".
    const clash = credentials.find((c) => c.member && (c.member === m.name || m.name.startsWith(`${c.member}-`) || c.member.startsWith(`${m.name}-`)));
    if (clash) throw new Error(`members: "${m.name}" overlaps "${clash.member}"; member names must not equal or extend each other with "-"`);
    credentials.push({ member: m.name, digest: storedDigest(m.token) });
  }

  /** Returns the matching credential or null; compares against all of them in constant time. */
  function authenticate(t) {
    if (typeof t !== "string") return null;
    const d = digest(t);
    let found = null;
    for (const c of credentials) if (crypto.timingSafeEqual(d, c.digest) && !found) found = c;
    return found;
  }

  /** name -> {ws, host, roles, since} */
  const online = new Map();
  /** name -> {host, roles, lastSeen, queue: msg[]} for every peer seen recently */
  const peers = new Map();
  /** message id -> {msg, to, ws, sender, reqId, timer} awaiting the receiver's "got" */
  const inflight = new Map();
  let queuedTotal = 0;

  const send = (ws, obj) => {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
  };

  /** `force` is for requeueing unconfirmed messages: those were already accepted, never drop them. */
  function enqueue(to, msg, front = false, force = false) {
    const p = peers.get(to);
    if (!p) return false;
    if (!force && (p.queue.length >= MAX_QUEUE_PER_PEER || queuedTotal >= MAX_QUEUED_TOTAL)) return false;
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

  /** Deliver queued messages for `to` while it is online and under its unconfirmed limit. */
  function flush(to) {
    const p = peers.get(to);
    if (!online.has(to) || !p?.queue.length) return;
    let room = MAX_INFLIGHT_PER_PEER - inflightTo(to);
    // inflightTo counts every connection of `to`, including one that is still closing.
    while (room-- > 0 && p.queue.length) {
      queuedTotal--;
      forward(to, p.queue.shift(), null, null);
    }
  }

  function forward(to, msg, sender, reqId) {
    const target = online.get(to);
    send(target.ws, { type: "message", ...msg });
    const timer = setTimeout(() => {
      // Still waiting: tell the sender, keep tracking until "got" or disconnect.
      const f = inflight.get(msg.id);
      if (f && f.sender) {
        send(f.sender, { type: "ack", id: f.reqId, state: "unconfirmed" });
        f.sender = null;
      }
    }, ACK_TIMEOUT_MS);
    inflight.set(msg.id, { msg, to, ws: target.ws, sender, reqId, timer });
  }

  const server = http.createServer((req, res) => {
    if (req.url === "/healthz") {
      res.writeHead(200, { "content-type": "text/plain" }).end("ok\n");
    } else {
      res.writeHead(426, { "content-type": "text/plain" }).end("hoptell relay: connect with a hoptell client (WebSocket)\n");
    }
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 512 * 1024 });
  server.on("upgrade", (req, socket, head) => wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req)));
  server.on("clientError", (_e, socket) => socket.destroy());

  wss.on("connection", (ws, req) => {
    const addr = req.socket.remoteAddress;
    let name = null;
    let mode = null;
    let sent = [];
    ws.isAlive = true;
    ws.on("pong", () => (ws.isAlive = true));
    ws.on("error", (e) => log("socket error from", addr, e.message)); // protocol errors must not crash the relay
    const helloTimer = setTimeout(() => !name && ws.close(4001, "no hello"), 5000);

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
        if (m.v !== undefined && m.v !== PROTOCOL) return ws.close(4005, "unsupported protocol version");
        const str = (v) => v === undefined || typeof v === "string";
        if (typeof m.token !== "string" || typeof m.name !== "string" || !str(m.mode) || !str(m.host) || (m.roles !== undefined && !Array.isArray(m.roles))) {
          return ws.close(4001, "bad hello");
        }
        const cred = authenticate(m.token);
        if (!cred) {
          log("auth failed from", addr);
          return ws.close(4003, "bad token");
        }
        if (!NAME_RE.test(m.name)) return ws.close(4002, "bad name");
        if (cred.member && m.name !== cred.member && !m.name.startsWith(`${cred.member}-`)) {
          log(`member ${cred.member} tried to use the name ${m.name}`);
          return ws.close(4002, "name not allowed for this member token");
        }
        const roles = Array.isArray(m.roles) ? m.roles : [];
        if (roles.length > MAX_ROLES || !roles.every((r) => typeof r === "string" && NAME_RE.test(r))) return ws.close(4002, "bad roles");
        clearTimeout(helloTimer);
        name = m.name;
        mode = m.mode === "send" ? "send" : "peer";
        const peerHost = HOST_RE.test(m.host || "") ? m.host : addr;
        ws.peerHost = peerHost;
        if (mode === "send") return send(ws, { type: "welcome", name });
        const prev = online.get(name);
        if (prev) prev.ws.close(4004, "replaced by a newer connection with the same name");
        online.set(name, { ws, host: peerHost, roles, since: Date.now() });
        const p = peers.get(name) || { queue: [] };
        peers.set(name, Object.assign(p, { host: peerHost, roles, lastSeen: Date.now() }));
        log("+", name, roles.length ? `[${roles.join(",")}]` : "", "from", peerHost, addr);
        send(ws, { type: "welcome", name });
        return flush(name);
      }

      if (m.type === "got") {
        const f = inflight.get(m.id);
        if (f && f.ws === ws) {
          clearTimeout(f.timer);
          inflight.delete(m.id);
          if (f.sender) send(f.sender, { type: "ack", id: f.reqId, state: "delivered" });
          flush(name); // room for more
        }
        return;
      }

      if (m.type === "list") {
        const list = [...peers.entries()]
          .filter(([n]) => n !== name)
          .map(([n, p]) => ({ name: n, host: p.host, roles: p.roles || [], online: online.has(n), queued: p.queue.length }));
        return send(ws, { type: "peers", id: m.id, peers: list });
      }

      if (m.type === "send") {
        const fail = (error) => send(ws, { type: "error", id: m.id, error });
        if (typeof m.to !== "string" || typeof m.text !== "string") return fail("`to` and `text` must be strings");
        const now = Date.now();
        sent = sent.filter((t) => now - t < RATE_WINDOW_MS);
        if (sent.length >= RATE_MAX) return fail(`rate limit: at most ${RATE_MAX} messages per ${RATE_WINDOW_MS / 1000}s per connection`);
        sent.push(now);

        const { text, to } = m;
        if (!text.trim()) return fail("empty message");
        if (text.length > MAX_TEXT) return fail(`message is longer than ${MAX_TEXT} characters`);
        const noReply = mode === "send" && !peers.has(name);
        const msg = () => ({ id: crypto.randomUUID(), from: name, fromHost: ws.peerHost, to, text, ts: Date.now(), ...(noReply ? { noReply } : {}) });

        if (to.startsWith("@")) {
          // Fan-out to every online peer with the role ("@all": everyone). Not queued for offline peers.
          const role = to.slice(1);
          const targets = [...online.entries()].filter(([n, o]) => n !== name && (role === "all" || o.roles.includes(role))).map(([n]) => n);
          if (!targets.length) return fail(role === "all" ? "no other peer is online" : `no online peer has the role "${role}"`);
          // Busy peers get it queued behind their unconfirmed messages; only a full queue skips one.
          const skipped = [];
          for (const t of targets) {
            if (hasRoom(t) && !peers.get(t).queue.length) forward(t, msg(), null, null);
            else if (!enqueue(t, msg())) skipped.push(t);
          }
          const count = targets.length - skipped.length;
          log(name, "->", to, `(${count} peers${skipped.length ? `, skipped ${skipped.join(",")}` : ""}, ${text.length} chars)`);
          if (!count) return fail(`every peer matching ${to} is busy and its queue is full`);
          return send(ws, { type: "ack", id: m.id, state: "fanout", count, skipped });
        }

        if (to === name) return fail("cannot message yourself");
        if (!peers.has(to)) return fail(`unknown peer "${to}" (see list_peers)`);
        if (online.has(to) && hasRoom(to) && !peers.get(to).queue.length) {
          forward(to, msg(), ws, m.id);
          log(name, "->", to, `(${text.length} chars)`);
          return;
        }
        if (!enqueue(to, msg())) return fail(`${to} ${online.has(to) ? "is not confirming messages" : "is offline"} and its queue is full`);
        log(name, "->", to, online.has(to) ? "(queued behind unconfirmed messages)" : "(queued, offline)");
        return send(ws, { type: "ack", id: m.id, state: "queued" });
      }

      send(ws, { type: "error", id: m.id, error: "unknown message type" });
    }

    ws.on("close", () => {
      clearTimeout(helloTimer);
      if (mode !== "peer") return;
      // Anything not confirmed by this connection goes back to the queue.
      const lost = [...inflight.values()].filter((f) => f.ws === ws).reverse();
      for (const f of lost) {
        clearTimeout(f.timer);
        inflight.delete(f.msg.id);
        enqueue(f.to, f.msg, true, true);
        if (f.sender) send(f.sender, { type: "ack", id: f.reqId, state: "queued" });
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
    const now = Date.now();
    for (const [n, p] of peers) {
      if (!online.has(n) && !p.queue.length && now - p.lastSeen > FORGET_AFTER_MS) peers.delete(n);
    }
  }, 15000);

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const { port: actual } = server.address();
      const auth = [token && "shared token", members?.length && `${members.length} member token(s)`].filter(Boolean).join(" + ");
      log(`hoptell relay listening on ws://${host}:${actual} (auth: ${auth}; health: http://${host}:${actual}/healthz)`);
      resolve({
        port: actual,
        close: () =>
          new Promise((r) => {
            clearInterval(heartbeat);
            for (const f of inflight.values()) clearTimeout(f.timer);
            for (const ws of wss.clients) ws.terminate();
            wss.close();
            server.close(() => r());
          }),
      });
    });
  });
}
