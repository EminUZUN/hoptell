// A local mock of the Responses API for the hardening gate rows (design-7.1-read-containment.md,
// draft 6.1): Codex runs with a test-only model provider on 127.0.0.1 that answers with scripted
// tool calls, so the commands run through the real exec sandbox path without a model's judgment
// and without any sign-in. Test-only: never part of a shipped plan.
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

export const PROBE_PROVIDER = "hoptell_probe";

/** The two -c slots a probe run adds, exactly (4 argv tokens). */
export const providerSlots = (port) => ["-c", `model_providers.${PROBE_PROVIDER}={name="hoptell-probe", base_url="http://127.0.0.1:${port}/v1", wire_api="responses"}`, "-c", `model_provider="${PROBE_PROVIDER}"`];

const sse = (events) => events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
const completed = (id) => ({ type: "response.completed", response: { id, usage: { input_tokens: 0, input_tokens_details: null, output_tokens: 0, output_tokens_details: null, total_tokens: 0 } } });

/** A scripted call of the code-mode `functions.exec` tool that runs one shell command through exec_command. */
export const execCall = (callId, cmd) => ({ type: "response.output_item.done", item: { type: "custom_tool_call", call_id: callId, namespace: "functions", name: "exec", input: `const r = await tools.exec_command({cmd: ${JSON.stringify(cmd)}}); text(typeof r === "string" ? r : JSON.stringify(r));` } });
/** A scripted call of the code-mode `functions.exec` tool running the given JavaScript. */
export const execJs = (callId, js) => ({ type: "response.output_item.done", item: { type: "custom_tool_call", call_id: callId, namespace: "functions", name: "exec", input: js } });
/** A scripted function call of a namespaced tool (for a tool that must not exist). */
export const functionCall = (callId, namespace, name, args) => ({ type: "response.output_item.done", item: { type: "function_call", call_id: callId, namespace, name, arguments: JSON.stringify(args) } });
export const finalMessage = (text) => ({ type: "response.output_item.done", item: { type: "message", role: "assistant", id: "m1", content: [{ type: "output_text", text }] } });

/**
 * Start the mock: `script` (settable later as `.script`) is a list of output items per request
 * (the last one repeats; none: a final message), or a function (n, requestBody) => items, which
 * may be async (a script that acts on what Codex sent). Every
 * request body is kept (`requests`), and every other request path is counted (`hits`).
 */
export async function startMock(script = []) {
  const m = { script };
  const requests = [];
  const hits = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      if (req.method === "POST" && /\/responses$/.test(req.url)) {
        let j = null;
        try {
          j = JSON.parse(body);
        } catch {}
        requests.push(j);
        const n = requests.length;
        let items;
        try {
          items = typeof m.script === "function" ? await m.script(n, j) : m.script[Math.min(n - 1, m.script.length - 1)];
        } catch (e) {
          m.errors = [...(m.errors ?? []), String(e?.message ?? e)];
        }
        items ??= [finalMessage("MOCK-DONE")];
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(sse([{ type: "response.created", response: { id: `r${n}` } }, ...items, completed(`r${n}`)]));
        return;
      }
      hits.push(`${req.method} ${req.url}`);
      res.writeHead(404);
      res.end();
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return Object.assign(m, { port: server.address().port, requests, hits, close: () => new Promise((r) => server.close(r)) });
}

/**
 * A profile command for a probe run: execs the real codex with the given argv, and for `exec` only
 * run (argv "exec" … "-") inserts the two provider slots right before the trailing "-"; anything
 * else (the help and feature checks, the preflight's `sandbox`) passes unchanged, and any argv that
 * already names a model provider is refused (exit 97). It logs each exec run's argv as received and
 * as passed to codex (one JSON line), so the test can check both against buildPlan's, byte for byte.
 * `wrapperSource` is the template; draft 6.4 records its digest with placeholders (WRAPPER_DIGEST).
 */
export function wrapperSource({ node, codex, log, port }) {
  return `#!${node}
import { spawn } from "node:child_process";
import fs from "node:fs";
const argv = process.argv.slice(2);
let run = argv;
if (argv.some((a) => /^model_providers?[.=]/.test(a))) {
  process.stderr.write("probe wrapper: a model provider slot is already present\\n");
  process.exit(97);
}
if (argv[0] === "exec" && argv.at(-1) === "-") {
  run = [...argv.slice(0, -1), ...${JSON.stringify(providerSlots(port))}, "-"];
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ received: argv, effective: run }) + "\\n");
}
const child = spawn(${JSON.stringify(codex)}, run, { stdio: "inherit" });
for (const s of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(s, () => child.kill(s));
child.on("exit", (code, sig) => {
  if (!sig) process.exit(code ?? 1);
  process.removeAllListeners(sig);
  process.kill(process.pid, sig);
});
`;
}
/** The digest of the wrapper template, with <node>, <codex>, <log> and <port> as placeholders (draft 6.4). */
export const WRAPPER_DIGEST = crypto.createHash("sha256").update(wrapperSource({ node: "<node>", codex: "<codex>", log: "<log>", port: "<port>" })).digest("hex");

export function probeWrapper(dir, { codex, port }) {
  const file = path.join(dir, "codex-probe");
  const log = path.join(dir, "codex-probe-argv.jsonl");
  const values = { node: process.execPath, codex, log, port };
  fs.writeFileSync(file, wrapperSource(values), { mode: 0o755 });
  const lines = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  return {
    file,
    log,
    values,
    // Whether the file on disk is still exactly the template with this run's values.
    isTemplate: () => fs.readFileSync(file, "utf8") === wrapperSource(values),
    argv: () => lines().map((l) => l.received),
    effective: () => lines().map((l) => l.effective),
  };
}

/** The text items of the developer and user messages of a request (the model's instructions). */
export function requestText(body) {
  return (body?.input ?? [])
    .filter((it) => it?.type === "message")
    .flatMap((it) => it.content ?? [])
    .map((c) => c.text ?? "")
    .join("\n");
}

/** The advertised tools of a request: {namespace: [names]}, from `tools` and additional_tools items. */
export function advertised(body) {
  const out = {};
  const add = (list) => {
    for (const t of list ?? []) {
      if (t.type === "namespace") out[t.name] = [...(out[t.name] ?? []), ...(t.tools ?? []).map((x) => x.name)];
      else out[""] = [...(out[""] ?? []), t.name];
    }
  };
  add(body?.tools);
  for (const it of body?.input ?? []) if (it?.type === "additional_tools") add(it.tools);
  return out;
}

/** The entries of the permission profile the model is given: [{access, escalatable, path|special}]. */
export function permissionEntries(body) {
  const t = requestText(body);
  const fsx = t.match(/<permission_profile[^>]*>([\s\S]*?)<\/permission_profile>/)?.[1] ?? null;
  if (fsx === null) return null;
  return [...fsx.matchAll(/<entry access="([^"]+)"([^>]*)>(?:<path>([^<]*)<\/path>|<special>([^<]*)<\/special>)<\/entry>/g)].map((m) => ({ access: m[1], escalatable: m[2].match(/escalatable="([^"]*)"/)?.[1] ?? null, ...(m[3] !== undefined ? { path: m[3] } : { special: m[4] }) }));
}
