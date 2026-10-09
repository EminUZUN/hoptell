// Relay logging and an optional metrics endpoint. Neither ever carries tokens or message text:
// log lines are built by the relay from names, references and counts, and metrics are numbers.
import http from "node:http";

// Control characters (C0 including CR/LF, DEL and C1) are replaced, so a value cannot forge
// extra log lines or send terminal control sequences.
// eslint-disable-next-line no-control-regex
export const clean = (v) => String(v).replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");

/** A logger for startRelay(): `text` (time + message) or `json` (one JSON object per line). */
export function makeLogger(format = "text", write = (line) => process.stdout.write(`${line}\n`)) {
  if (!["text", "json"].includes(format)) throw new Error(`invalid log format "${format}": use text or json`);
  return (...parts) => {
    const time = new Date().toISOString();
    const msg = parts.filter((p) => p !== "" && p !== undefined).map(clean).join(" ");
    write(format === "json" ? JSON.stringify({ time, msg }) : `${time} ${msg}`);
  };
}

const HELP = {
  uptimeSeconds: ["gauge", "Seconds since the relay started"],
  peersKnown: ["gauge", "Peers the relay currently remembers"],
  peersOnline: ["gauge", "Peers connected now"],
  queueItems: ["gauge", "Messages queued for offline or busy peers"],
  queueBytes: ["gauge", "Bytes of queued message text"],
  oldestQueuedSeconds: ["gauge", "Age of the oldest queued message"],
  unconfirmed: ["gauge", "Delivered messages not yet confirmed by their receiver"],
  logins: ["counter", "Successful logins"],
  authFailures: ["counter", "Logins refused for a bad token"],
  accepted: ["counter", "Sends accepted"],
  deliveries: ["counter", "Delivery attempts to connected peers"],
  expired: ["counter", "Queued messages dropped because their time-to-live passed"],
  rateLimited: ["counter", "Sends refused by the rate limit"],
  queueFull: ["counter", "Messages not queued because a queue was full"],
  takeovers: ["counter", "Connections replaced by a newer one with the same name"],
  queueDropped: ["counter", "Queued messages dropped because a different member now holds the name"],
  auditDropped: ["counter", "Security events the relay acted on but could not write to the admin audit log"],
};

/** Prometheus text format for relay.stats(). */
export function formatMetrics(stats) {
  const out = [];
  for (const [key, value] of Object.entries(stats)) {
    const [type, help] = HELP[key] || ["gauge", key];
    const name = `hoptell_${key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)}${type === "counter" ? "_total" : ""}`;
    out.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`, `${name} ${Number(value) || 0}`);
  }
  return `${out.join("\n")}\n`;
}

/**
 * Serve GET /metrics for `relay` on host:port. Bound to loopback by default: metrics reveal
 * activity levels, so publishing them is a deliberate choice.
 */
export function startMetrics(relay, { host = "127.0.0.1", port }) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (req.method === "GET" && req.url === "/metrics") {
        res.writeHead(200, { "content-type": "text/plain; version=0.0.4" }).end(formatMetrics(relay.stats()));
      } else res.writeHead(404).end();
    });
    server.once("error", reject);
    server.listen(port, host, () => resolve(server));
  });
}
