#!/usr/bin/env node
// For the Codex catalog gates only: runs the real codex with the same arguments, stdin and stdout,
// and Codex's own trace of the Responses stream (RUST_LOG=tungstenite::protocol=trace) on a pipe.
// The trace holds auth material, so it is never written anywhere: each `response.created` event is
// parsed in memory and only the tool names are kept; no raw stderr line is passed on (an error
// line can hold request text too). At exit the names and line counts (no content) go to <out>,
// and one fixed line with the counts goes to stderr. Codex's cloud-config lines (RUST_LOG
// codex_cloud_config=info, which the hardened supervisor sets) are kept as their class only
// (lib/agentdeny.js cloudLineClass: none, cached, loaded with its counts, other), never as text:
// the supervisor cannot see them through the tap, so a tapped run's cloud stream is read here.
//   node catalog-tap.mjs <real codex> <out.json> [codex arguments...]
import crypto from "node:crypto";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { cloudLineClass } from "../../lib/agentdeny.js";

const [real, out, ...args] = process.argv.slice(2);
const child = spawn(real, args, { stdio: ["inherit", "inherit", "pipe"], env: { ...process.env, RUST_LOG: [process.env.RUST_LOG, "tungstenite::protocol=trace"].filter(Boolean).join(",") } });
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(sig, () => child.kill(sig));

const catalogs = [];
const calls = [];
const spawnArgs = [];
const params = {};
const cloud = [];
const stats = { traceLines: 0, dropped: 0, errorLines: 0, received: 0, responseCreated: 0, unparsed: 0, oversized: 0, cloudNoneBeforeFirstResponse: 0 };
const MAX_LINE = 64 * 1024 * 1024;

/** The tool names of one `response.created` event: "<namespace>.<tool>" or "<tool>", and the
 * names a code-mode `exec` tool's description lists (its nested tools). */
function names(ev) {
  const top = [];
  const nested = [];
  for (const tool of ev.response?.tools ?? []) {
    if (tool.type === "namespace") {
      for (const c of tool.tools ?? []) {
        top.push(`${tool.name}.${c.name}`);
        if (tool.name === "collaboration") params[c.name] = Object.keys(c.parameters?.properties ?? {});
      }
    } else top.push(tool.name ?? tool.type);
    for (const c of [tool, ...(tool.tools ?? [])]) {
      if (c.name === "exec" && typeof c.description === "string") for (const m of c.description.matchAll(/### `([A-Za-z0-9_.-]+)`/g)) nested.push(m[1]);
    }
  }
  // Which agent made the request, as short digests (never the values): a sub-agent shares the
  // parent's prompt_cache_key but has its own instructions and catalog.
  const d = (v) => (v == null ? null : crypto.createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 12));
  const r = ev.response ?? {};
  return { cacheKey: d(r.prompt_cache_key), instructions: d(r.instructions), metadata: d(r.metadata), top, nested: [...new Set(nested)] };
}

function line(l) {
  const c = cloudLineClass(l);
  if (c) {
    cloud.push(c.cls === "loaded" ? { cls: c.cls, counts: c.counts } : c.cls);
    // The order the supervisor expects: the (none) lines before the first model request.
    if (c.cls === "none" && stats.responseCreated === 0) stats.cloudNoneBeforeFirstResponse++;
    return;
  }
  // The trace also dumps frames over several lines (their payloads hold requests): no raw line
  // is passed on, only counted.
  if (!/\bTRACE\b/.test(l)) {
    stats.dropped++;
    if (/error/i.test(l)) stats.errorLines++;
    return;
  }
  stats.traceLines++;
  if (l.includes("Received message ")) stats.received++;
  const j = l.indexOf('Received message {"type":"response.output_item.done"');
  if (j >= 0) {
    // The model's own tool calls: names only, never their arguments or outputs.
    try {
      const item = JSON.parse(l.slice(j + "Received message ".length)).item ?? {};
      if (/call$/.test(item.type ?? "")) {
        const name = [item.namespace, item.name ?? item.type].filter(Boolean).join(".");
        calls.push(name);
        // For a sub-agent spawn, which options the model chose: keys, and only booleans, numbers and
        // the fork mode as values (never the task text).
        if (/spawn_agent$/.test(name)) {
          try {
            const a = JSON.parse(item.arguments ?? "{}");
            const shown = (k, v) => typeof v === "boolean" || typeof v === "number" || (k === "fork_turns" && /^[a-z0-9_]{1,12}$/.test(String(v)));
            spawnArgs.push(Object.fromEntries(Object.entries(a).map(([k, v]) => [k, shown(k, v) ? v : typeof v])));
          } catch {
            spawnArgs.push(null);
          }
        }
      }
    } catch {
      stats.unparsed++;
    }
    return;
  }
  const i = l.indexOf('Received message {"type":"response.created"');
  if (i < 0) return;
  stats.responseCreated++;
  try {
    catalogs.push(names(JSON.parse(l.slice(i + "Received message ".length))));
  } catch {
    stats.unparsed++;
  }
}

let buf = "";
child.stderr.setEncoding("utf8");
child.stderr.on("data", (c) => {
  buf += c;
  for (let i; (i = buf.indexOf("\n")) >= 0; ) {
    line(buf.slice(0, i));
    buf = buf.slice(i + 1);
  }
  if (buf.length > MAX_LINE) {
    stats.oversized++;
    buf = "";
  }
});
child.on("error", (e) => {
  process.stderr.write(`catalog-tap: ${e.message}\n`);
  process.exit(127);
});
child.on("close", (code, signal) => {
  if (buf) line(buf);
  // `--version`, `--help` and `features list` (the help check) also pass through here; only a
  // run with a catalog writes one, appended so that one file can hold several runs.
  process.stderr.write(`catalog-tap: ${stats.dropped} stderr lines not passed on (${stats.errorLines} mention an error), ${stats.traceLines} trace lines read (trace on)\n`);
  if (catalogs.length || stats.traceLines) fs.appendFileSync(out, `${JSON.stringify({ args: args.slice(0, 1), catalogs, calls, spawnArgs, params, cloud, stats })}\n`, { mode: 0o600 });
  process.exit(code ?? 128 + (signal === "SIGKILL" ? 9 : 15));
});
