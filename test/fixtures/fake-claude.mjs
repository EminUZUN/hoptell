// A stand-in for Claude Code in tests, started through a link named "claude" so hoptell
// recognizes it as the host. Like Claude Code it runs the hoptell hook commands and MCP server
// as its own children, watches the paths SessionStart returns and runs FileChanged on a change.
// Commands arrive as JSON lines on stdin; events go out as JSON lines on stdout.
import fs from "node:fs";
import readline from "node:readline";
import { spawn } from "node:child_process";

const BIN = process.argv[2];
const emit = (ev) => process.stdout.write(`${JSON.stringify(ev)}\n`);
let sessionId = "s-1";
let watchers = [];
let mcp = null;

function runHook(cmd, input, raw = false, env = {}) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [BIN, cmd], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("close", (code) => resolve({ code, stdout, stderr }));
    p.stdin.on("error", () => {}); // a hook may exit before reading all of an oversized input
    p.stdin.end(raw ? input : JSON.stringify(input));
  });
}

function watch(paths) {
  for (const w of watchers) w.close();
  watchers = paths.map((file) => {
    let timer = null;
    return fs.watch(file, () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        const r = await runHook("hook-file-changed", { session_id: sessionId, hook_event_name: "FileChanged", file_path: file, event: "change" });
        emit({ ev: "file-changed", file, ...r });
      }, 50);
    });
  });
}

function startMcp(env) {
  mcp = spawn(process.execPath, [BIN, "mcp"], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
  let buf = "";
  mcp.stderr.on("data", (d) => emit({ ev: "mcp-log", text: String(d) }));
  mcp.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const msg = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      if (msg.id === 1) {
        mcp.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
        emit({ ev: "mcp-ready", instructions: msg.result.instructions });
      } else if (msg.id) emit({ ev: "mcp-result", id: msg.id, result: msg.result });
    }
  });
  mcp.on("close", () => emit({ ev: "mcp-closed" }));
  mcp.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake-claude", version: "0" } } })}\n`);
}

readline.createInterface({ input: process.stdin }).on("line", async (line) => {
  const c = JSON.parse(line);
  if (c.op === "session-start") {
    sessionId = c.session_id ?? sessionId;
    const r = await runHook("hook-session-start", { session_id: sessionId, hook_event_name: "SessionStart", source: c.source ?? "startup" });
    let paths = [];
    try {
      paths = JSON.parse(r.stdout).hookSpecificOutput.watchPaths;
    } catch {
      // nothing to watch
    }
    watch(c.watch === false ? [] : paths);
    emit({ ev: "session-start", ...r, paths });
  } else if (c.op === "hook") {
    emit({ ev: "hook", tag: c.tag, ...(await runHook(c.cmd, c.input, c.raw, c.env)) });
  } else if (c.op === "mcp-start") startMcp(c.env || {});
  else if (c.op === "mcp-call") mcp.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: c.id, method: "tools/call", params: { name: c.tool, arguments: c.args || {} } })}\n`);
  else if (c.op === "mcp-stop") mcp.stdin.end();
  else if (c.op === "exit") process.exit(0);
});
emit({ ev: "ready", pid: process.pid });
