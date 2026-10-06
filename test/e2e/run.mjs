#!/usr/bin/env node
// Opt-in end-to-end test with real agents (npm run test:e2e). Costs model usage and takes
// several minutes, so it never runs in normal CI.
//
// It starts a relay and two "machines" (Docker containers pc1 and pc2) on a private
// network, runs Claude Code, Codex and Antigravity on each, and checks:
//   1. roll call: @all reaches every agent, and each replies from its own host
//   2. baton: a message passes through every agent, alternating machines
//
// Logins (pick per agent; agents without a login are skipped):
//   Claude Code  CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`), or --use-local-logins
//   Codex        OPENAI_API_KEY, or --use-local-logins (~/.codex/auth.json)
//   Antigravity  --use-local-logins (~/.gemini/antigravity-cli/antigravity-oauth-token)
// --use-local-logins copies this machine's logins into the containers for the run. Some
// providers rotate refresh tokens, so a refresh inside a container can log this machine out.
// Logins are copied at runtime only and deleted with the containers.
//
// Options: --agents claude,codex,agy   --keep (leave containers running for inspection)
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { RelayClient } from "../../lib/client.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const opt = (f, d) => (args.includes(f) ? args[args.indexOf(f) + 1] : d);
const RUN = `hoptell-e2e-${crypto.randomBytes(3).toString("hex")}`;
const TOKEN = crypto.randomBytes(24).toString("hex");
const HOSTS = ["pc1", "pc2"];
const ROLE = { claude: "reviewer", codex: "backend", agy: "gemini" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(`[e2e ${new Date().toISOString().slice(11, 19)}]`, ...a);

const docker = (a, input) => execFileSync("docker", a, { encoding: "utf8", input, stdio: [input == null ? "ignore" : "pipe", "pipe", "pipe"] });
// Extra env names are passed by name only (docker reads the values from our environment),
// so no secret appears in a host command line or in an error message that echoes one.
const sh = (host, script, user = "agent", envNames = []) => docker(["exec", ...envNames.flatMap((n) => ["-e", n]), "-u", user, `${RUN}-${host}`, "bash", "-lc", script]);
const SECRETS = [process.env.CLAUDE_CODE_OAUTH_TOKEN, process.env.OPENAI_API_KEY].filter(Boolean);
const redact = (s) => SECRETS.reduce((t, v) => t.split(v).join("[redacted]"), String(s));
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// ---------- logins ----------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hoptell-e2e-"));
fs.chmodSync(tmp, 0o700);
const local = flag("--use-local-logins");
const home = os.homedir();

/** Copy logins for the selected agents only. */
function collectLogins(wanted) {
  const found = {};
  const put = (rel, data) => {
    const f = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
    fs.writeFileSync(f, data, { mode: 0o600 });
  };
  // Claude Code
  if (!wanted.includes("claude"));
  else if (process.env.CLAUDE_CODE_OAUTH_TOKEN) found.claude = "CLAUDE_CODE_OAUTH_TOKEN";
  else if (local) {
    let creds = null;
    if (process.platform === "darwin") {
      const r = spawnSync("security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"], { encoding: "utf8" });
      if (r.status === 0) creds = r.stdout.trim();
    } else if (fs.existsSync(path.join(home, ".claude/.credentials.json"))) {
      creds = fs.readFileSync(path.join(home, ".claude/.credentials.json"), "utf8");
    }
    if (creds) {
      put(".claude/.credentials.json", creds);
      found.claude = "local login";
    }
  }
  if (found.claude) {
    let account = {};
    try {
      const j = JSON.parse(fs.readFileSync(path.join(home, ".claude.json"), "utf8"));
      if (local) account = { oauthAccount: j.oauthAccount, userID: j.userID };
    } catch {}
    put(".claude.json", JSON.stringify({ ...account, hasCompletedOnboarding: true, theme: "dark", projects: { "/home/agent/hoptell": { hasTrustDialogAccepted: true, enabledMcpjsonServers: ["hoptell"] } } }));
  }
  // Codex
  if (!wanted.includes("codex"));
  else if (process.env.OPENAI_API_KEY) found.codex = "OPENAI_API_KEY";
  else if (local && fs.existsSync(path.join(home, ".codex/auth.json"))) {
    put(".codex/auth.json", fs.readFileSync(path.join(home, ".codex/auth.json")));
    found.codex = "local login";
  }
  if (found.codex) {
    put(".codex/config.toml", `approval_policy = "never"\nsandbox_mode = "danger-full-access"\n\n[projects."/home/agent/hoptell"]\ntrust_level = "trusted"\n\n[mcp_servers.hoptell]\ncommand = "node"\nargs = ["/home/agent/hoptell/bin/hoptell.js", "mcp"]\ntool_timeout_sec = 1800\ndefault_tools_approval_mode = "approve"\n`);
  }
  // Antigravity
  const agyToken = path.join(home, ".gemini/antigravity-cli/antigravity-oauth-token");
  if (wanted.includes("agy") && local && fs.existsSync(agyToken)) {
    put(".gemini/antigravity-cli/antigravity-oauth-token", fs.readFileSync(agyToken));
    for (const f of ["oauth_creds.json", "google_accounts.json"]) {
      if (fs.existsSync(path.join(home, ".gemini", f))) put(`.gemini/${f}`, fs.readFileSync(path.join(home, ".gemini", f)));
    }
    found.agy = "local login";
  }
  put(".config/hoptell/.env", `HOPTELL_RELAY=ws://${RUN}-relay:7777\nHOPTELL_TOKEN=${TOKEN}\n`);
  return found;
}

// ---------- first-run prompts ----------
// Each rule: a screen pattern and the keys that answer it. Data-sharing consent is always declined.
const PROMPTS = [
  [/I am using this for local development/, ["Enter"]],
  [/\[x\] Yes, I agree to help improve/, ["Enter"]], // untick data sharing
  [/\[ \] Yes, I agree to help improve[\s\S]*Done/, ["Down", "Down", "Right", "Enter"]],
  [/Yes, I trust this folder|Trust and continue/, ["Enter"]],
  [/New MCP server found in this project/, ["Up", "Up", "Enter"]],
  [/tokyo night|Select a theme|Choose.*theme/i, ["Enter"]],
];
const READY = /(^|\n)\s*[>›❯]\s*(\n|$|Try |Ask |Type )/;

async function settle(host, target, name, client) {
  for (let i = 0; i < 120; i++) {
    let screen = "";
    try {
      screen = sh(host, `tmux capture-pane -p -t ${q(target)}`);
    } catch {}
    const rule = PROMPTS.find(([re]) => re.test(screen));
    if (rule) {
      for (const k of rule[1]) {
        sh(host, `tmux send-keys -t ${q(target)} ${k}`);
        await sleep(300);
      }
      await sleep(1500);
      continue;
    }
    const peers = await client.list().catch(() => []);
    if (peers.some((p) => p.name === name && p.online) && READY.test(screen)) return true;
    await sleep(1000);
  }
  throw new Error(`${name} did not become ready; last screen:\n${sh(host, `tmux capture-pane -p -t ${q(target)}`)}`);
}

// ---------- run ----------
const wanted = opt("--agents", "claude,codex,agy").split(",").filter((a) => ROLE[a]);
const logins = collectLogins(wanted);
const agents = wanted.filter((a) => logins[a]);
const skipped = wanted.filter((a) => !logins[a]);
if (!agents.length) {
  fs.rmSync(tmp, { recursive: true, force: true });
  console.error("No agent logins available. Set CLAUDE_CODE_OAUTH_TOKEN / OPENAI_API_KEY, or pass --use-local-logins (see the top of this file).");
  process.exit(2);
}
if (local) log("WARNING: copying this machine's logins into the test containers (--use-local-logins).");
log(`agents: ${agents.map((a) => `${a} (${logins[a]})`).join(", ")}${skipped.length ? `; skipped (no login): ${skipped.join(", ")}` : ""}`);

const results = [];
const check = (ok, what) => {
  results.push([ok, what]);
  log(ok ? "PASS" : "FAIL", what);
};

let client;
const startedPeers = [];
function cleanup() {
  client?.close();
  if (!flag("--keep")) {
    spawnSync("docker", ["rm", "-f", `${RUN}-relay`, ...HOSTS.map((h) => `${RUN}-${h}`)], { stdio: "ignore" });
    spawnSync("docker", ["network", "rm", RUN], { stdio: "ignore" });
  } else log(`--keep: containers ${RUN}-* left running; remove with: docker rm -f $(docker ps -aq -f name=${RUN})`);
  fs.rmSync(tmp, { recursive: true, force: true });
}
process.on("SIGINT", () => (cleanup(), process.exit(130)));

try {
  log("building images (first run takes a few minutes)");
  docker(["build", "-q", "-t", "hoptell-relay-e2e", ROOT]);
  docker(["build", "-q", "-t", "hoptell-e2e", "-f", path.join(ROOT, "test/e2e/Dockerfile"), ROOT]);

  docker(["network", "create", RUN]);
  docker(["run", "-d", "--name", `${RUN}-relay`, "--network", RUN, "-p", "127.0.0.1::7777", "-e", `HOPTELL_TOKEN=${TOKEN}`, "hoptell-relay-e2e"]);
  const port = docker(["port", `${RUN}-relay`, "7777/tcp"]).trim().split(":").pop();
  for (const h of HOSTS) {
    docker(["run", "-d", "--name", `${RUN}-${h}`, "--hostname", h, "--network", RUN, "hoptell-e2e"]);
    docker(["cp", `${tmp}/.`, `${RUN}-${h}:/home/agent/`]);
    sh(h, "chown -R agent:agent /home/agent && chmod -R go-rwx /home/agent/.claude* /home/agent/.codex /home/agent/.gemini /home/agent/.config 2>/dev/null; true", "root");
    if (agents.includes("codex") && process.env.OPENAI_API_KEY) {
      docker(["exec", "-i", "-u", "agent", `${RUN}-${h}`, "codex", "login", "--with-api-key"], process.env.OPENAI_API_KEY);
    }
    if (agents.includes("agy")) sh(h, "agy mcp add hoptell node /home/agent/hoptell/bin/hoptell.js mcp >/dev/null");
  }

  // The tester is a peer on this machine, connected through the published relay port.
  client = new RelayClient({ url: `ws://127.0.0.1:${port}`, token: TOKEN, name: "e2e-tester" });
  const inbox = [];
  client.on("message", (m, confirm) => (inbox.push(m), confirm()));
  client.start();
  await client.ready(30_000);
  log(`relay up on 127.0.0.1:${port}`);

  // Start every agent on every machine.
  const peers = startedPeers;
  for (const h of HOSTS) {
    for (const a of agents) {
      const name = `${h}-${a}`;
      const env = `HOPTELL_NAME=${name} HOPTELL_ROLES=${ROLE[a]},${h}`;
      if (a === "claude") {
        // The container's shell expands the token; it is not part of this command line.
        const oauth = process.env.CLAUDE_CODE_OAUTH_TOKEN ? ["CLAUDE_CODE_OAUTH_TOKEN"] : [];
        const tokenEnv = oauth.length ? `-e "CLAUDE_CODE_OAUTH_TOKEN=$CLAUDE_CODE_OAUTH_TOKEN"` : "";
        sh(h, `cd hoptell && tmux new-session -d -s ${name} -x 200 -y 50 ${tokenEnv} -e HOPTELL_NAME=${name} -e HOPTELL_ROLES=${ROLE[a]},${h} "claude --allowedTools mcp__hoptell --dangerously-load-development-channels server:hoptell"`, "agent", oauth);
        peers.push({ host: h, agent: a, name, target: name });
      } else {
        const cmd = a === "codex" ? "codex" : "agy --dangerously-skip-permissions";
        sh(h, `cd hoptell && ${env} node bin/hoptell.js tmux ${name} --roles ${ROLE[a]},${h} -- ${cmd} >/dev/null 2>&1; tmux resize-window -t =hoptell-${name}:agent -x 200 -y 50`);
        peers.push({ host: h, agent: a, name, target: `=hoptell-${name}:agent` });
      }
    }
  }
  for (const p of peers) {
    await settle(p.host, p.target, p.name, client);
    log(`${p.name} ready`);
  }

  const waitFor = async (pred, secs) => {
    for (let i = 0; i < secs && !pred(); i++) await sleep(1000);
    return pred();
  };

  // 1. Roll call
  inbox.length = 0;
  await client.send("@all", "Roll call (hoptell e2e test): run the shell command 'hostname', then reply with send_message to \"e2e-tester\" with exactly: <your peer name> on <hostname output>. Nothing else.");
  await waitFor(() => peers.every((p) => inbox.some((m) => m.from === p.name)), 360);
  for (const p of peers) {
    const m = inbox.find((x) => x.from === p.name);
    check(Boolean(m) && m.text.includes(p.host), `roll call: ${p.name} replied from ${p.host}${m ? "" : " (no reply)"}`);
  }

  // 2. Baton: alternate machines, rotating through the agents.
  const order = [];
  for (let i = 0; i < agents.length; i++) {
    order.push(`pc1-${agents[i]}`, `pc2-${agents[(i + 1) % agents.length]}`);
  }
  order.push("e2e-tester");
  // Models occasionally drop a hop; one retry tells flakiness from a real failure (two misses).
  const expected = ["start@e2e-tester", ...order.slice(0, -1).map((n) => `${n}@${n.split("-")[0]}`)];
  let lines = [];
  let attempt = 0;
  while (attempt < 2 && JSON.stringify(lines) !== JSON.stringify(expected)) {
    attempt++;
    inbox.length = 0;
    await client.send(order[0], `BATON RELAY (hoptell e2e test, attempt ${attempt}). Forward this ENTIRE message unchanged, including these instructions, with only your line added at the end.
Order: ${order.join(" -> ")}
Rules:
1. Find your own peer name in the order.
2. Run 'hostname'.
3. Append the line <your peer name>@<hostname> at the very end.
4. Send the whole message with send_message to the NEXT name after yours in the order.
5. Do this exactly once, then stop.
BATON LINES:
start@e2e-tester`);
    await waitFor(() => inbox.some((m) => /BATON LINES/.test(m.text)), 300);
    const baton = inbox.find((m) => /BATON LINES/.test(m.text));
    lines = baton ? baton.text.split("BATON LINES:")[1].trim().split("\n").map((l) => l.trim()) : [];
    if (JSON.stringify(lines) !== JSON.stringify(expected)) log(`baton attempt ${attempt} failed: ${lines.join(" | ") || "did not come back"}`);
  }
  check(JSON.stringify(lines) === JSON.stringify(expected), `baton through ${order.length - 1} agents in order${attempt > 1 ? ` (needed ${attempt} attempts)` : ""}\n    got:      ${lines.join(" | ")}\n    expected: ${expected.join(" | ")}`);
} catch (e) {
  check(false, `run aborted: ${redact(e.message)}`);
} finally {
  if (results.some(([ok]) => !ok)) diagnose();
  cleanup();
}

/** On failure: show who sent what to whom (relay log) and each agent's screen. */
function diagnose() {
  try {
    const hops = docker(["logs", `${RUN}-relay`]).split("\n").filter((l) => l.includes(" -> "));
    log(`relay routing log:\n    ${hops.join("\n    ")}`);
  } catch {}
  for (const p of startedPeers) {
    try {
      const screen = sh(p.host, `tmux capture-pane -p -t ${q(p.target)}`).split("\n").filter((l) => l.trim()).slice(-12).join("\n      ");
      log(`${p.name} screen:\n      ${screen}`);
    } catch {}
  }
}

const failed = results.filter(([ok]) => !ok).length;
log(`${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
