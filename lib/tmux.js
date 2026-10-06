// Run an interactive CLI agent (Codex, Claude Code, ...) inside tmux and paste
// incoming hoptell messages into it, so an idle session wakes up and answers.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { BIN, checkName, ensurePrivateDir, parseRoles, stateDir } from "./config.js";
import * as inbox from "./inbox.js";

const tmux = (args, input) => execFileSync("tmux", args, { encoding: "utf8", input, stdio: [input == null ? "ignore" : "pipe", "pipe", "pipe"] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// Prompts where Enter would answer a question instead of submitting our text.
// Matched only against the bottom of the screen, where agents draw these prompts.
export const APPROVAL_RE =
  /Do you want to (proceed|make this edit|run|create|allow)|Would you like to (run|make|apply|allow)|Allow (command|this|once)\b|\((y\/n|Y\/n|y\/N)\)|\[(y\/n|Y\/n|y\/N)\]|Yes, (and )?don't ask|Yes, allow|[❯›>]\s*1\.\s*(Yes|Trust|Allow|Approve)|Press enter to confirm|Enter to confirm|trust this folder|Trust the files/i;
const PROMPT_LINES = 12;

/** Whether text could look like an approval prompt once drawn after an agent's input mark. */
export const looksLikePrompt = (text) => APPROVAL_RE.test(text) || APPROVAL_RE.test(text.replace(/^/gm, "> "));
export const waitingNotice = (from) =>
  `hoptell: a message from "${from}" is waiting. Parts of it look like a terminal prompt, so it was not typed here; ` +
  `read it with the hoptell read_inbox tool. ${inbox.NOT_YOUR_USER}`;

// The caller's effective settings go to the agent through a private file
// (~/.hoptell/sessions/<name>.env, 0600), never through process arguments.
const SETTINGS = ["HOPTELL_RELAY", "HOPTELL_TOKEN", "HOPTELL_PUSH"];

function writeSessionSettings(name) {
  const dir = ensurePrivateDir(path.join(ensurePrivateDir(stateDir()), "sessions"));
  const file = path.join(dir, `${name}.env`);
  const body = SETTINGS.filter((k) => process.env[k]).map((k) => `${k}=${JSON.stringify(process.env[k])}`).join("\n");
  fs.rmSync(file, { force: true });
  fs.writeFileSync(file, `${body}\n`, { flag: "wx", mode: 0o600 });
  return file;
}

export const sessionFor = (name) => `hoptell-${name}`;

/**
 * Run tmux `command` on `pane` only if the pane still runs process `pid`: tmux checks
 * and runs it in one step, so a respawn cannot slip in between. Returns whether it ran.
 */
export function guarded(pane, pid, command) {
  const ok = `hoptell-ok-${crypto.randomBytes(4).toString("hex")}`;
  const condition = `#{&&:#{==:#{pane_pid},${pid}},#{==:#{pane_dead},0}}`;
  tmux(["if-shell", "-F", "-t", pane, condition, `${command} ; set-buffer -b ${ok} 1`]);
  const ran = spawnSync("tmux", ["show-buffer", "-b", ok]).status === 0;
  if (ran) spawnSync("tmux", ["delete-buffer", "-b", ok]);
  return ran;
}

function tmuxVersionOk() {
  const v = spawnSync("tmux", ["-V"], { encoding: "utf8" }).stdout || "";
  const m = v.match(/(\d+)\.(\d+)/);
  return m && (Number(m[1]) > 3 || (Number(m[1]) === 3 && Number(m[2]) >= 2));
}

/** `hoptell tmux <name> [--roles a,b] -- <command...>` */
export function launch(name, cmd, rolesValue = "") {
  checkName(name);
  const roles = parseRoles(rolesValue).join(",");
  if (!cmd.length) throw new Error("usage: hoptell tmux <peer-name> [--roles a,b] -- <agent command...>");
  if (!tmuxVersionOk()) throw new Error("tmux 3.2 or newer is required (install it, e.g. `brew install tmux` or `apt install tmux`)");
  const session = sessionFor(name);
  if (spawnSync("tmux", ["has-session", "-t", `=${session}`]).status === 0) {
    throw new Error(`tmux session ${session} already exists: attach with \`tmux attach -t ${session}\`, or end it with \`tmux kill-session -t ${session}\``);
  }
  // Blank inherited values (an already running tmux server may hold stale ones) so the
  // session file decides; the agent and the injector see exactly the caller's settings.
  const env = { HOPTELL_NAME: name, HOPTELL_ROLES: roles, HOPTELL_HOME: stateDir(), HOPTELL_ENV: writeSessionSettings(name) };
  for (const k of SETTINGS) env[k] = "";

  cmd = [...cmd];
  // Interactive Codex starts MCP servers from a shared app-server daemon that does not
  // inherit this environment, so pass the same settings as a config override.
  if (/(^|\/)codex$/.test(cmd[0])) {
    const table = Object.entries(env).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(", ");
    cmd.splice(1, 0, "-c", `mcp_servers.hoptell.env={${table}}`);
  }
  const envArgs = Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);

  // When the agent exits, end the whole session so the injector goes with it.
  const agentCmd = `${cmd.map(q).join(" ")}; tmux kill-session -t ${q(`=${session}`)}`;
  const [pane, pid] = tmux(["new-session", "-d", "-P", "-F", "#{pane_id} #{pane_pid}", "-s", session, "-n", "agent", "-c", process.cwd(), ...envArgs, agentCmd]).trim().split(" ");
  tmux(["new-window", "-d", "-t", `=${session}`, "-n", "injector", ...envArgs, `${q(process.execPath)} ${q(BIN)} inject ${q(name)} ${q(pane)} ${q(pid)}`]);
  const attach = process.env.TMUX ? ["switch-client", "-t", `=${session}`] : ["attach", "-t", `=${session}`];
  const r = spawnSync("tmux", attach, { stdio: "inherit" });
  if (r.status !== 0) console.error(`hoptell: session ${session} is running; attach with: tmux attach -t ${session}`);
}

/**
 * The injector loop: paste messages for `name` into exactly pane `pane` (e.g. "%3")
 * while it still runs the original process `pid`. A respawned pane keeps its id but
 * gets a new process, so it is treated as gone.
 */
export async function inject(name, pane, pid) {
  checkName(name);
  if (!/^%\d+$/.test(pane || "") || !/^\d+$/.test(pid || "")) throw new Error("usage: hoptell inject <name> <tmux pane id> <pane pid>");
  const paneAlive = () => {
    try {
      return tmux(["display-message", "-p", "-t", pane, "#{pane_id} #{pane_pid} #{pane_dead}"]).trim() === `${pane} ${pid} 0`;
    } catch {
      return false;
    }
  };
  const approvalVisible = () => {
    try {
      const lines = tmux(["capture-pane", "-p", "-t", pane]).replace(/\s+$/, "").split("\n");
      return APPROVAL_RE.test(lines.slice(-PROMPT_LINES).join("\n"));
    } catch {
      return true; // cannot see the screen: do not type
    }
  };
  console.log(`hoptell injector: pasting messages for "${name}" into pane ${pane}`);

  // Messages stay in the inbox until they are pasted; if the agent is gone they remain for read_inbox.
  const announced = new Set(); // messages left in the inbox for read_inbox, see below
  while (paneAlive()) {
    const files = inbox.list(name);
    for (const f of announced) if (!files.includes(f)) announced.delete(f);
    const file = files.find((f) => !announced.has(f));
    if (!file) {
      await sleep(250);
      continue;
    }
    if (approvalVisible()) {
      await sleep(2000); // never press Enter on an approval prompt
      continue;
    }
    const c = inbox.claim(name, file);
    if (!c) continue;
    if (!c.msg) {
      c.commit(); // unreadable entry
      continue;
    }
    const m = c.msg;
    // Keep newlines and tabs (pasted as text), drop other control characters.
    // eslint-disable-next-line no-control-regex -- matching control characters is the point
    const body = m.text.replace(/\r\n?/g, "\n").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
    let payload = `${inbox.format({ ...m, text: body })}\nTo answer the sender, use the hoptell send_message tool with to="${m.from}" (unless the message says to send elsewhere). ${inbox.NOT_YOUR_USER}`;
    // Never type text that looks like a prompt: on screen it could not be told apart from a
    // real one. Such a message stays in the inbox, and the agent is told to fetch it.
    const keep = looksLikePrompt(payload);
    // `done` runs once the text is submitted, `undo` if it could not be.
    let done = c.commit;
    let undo = c.release;
    if (keep) {
      c.release(); // back in the inbox before the agent can act on the notice
      payload = waitingNotice(m.from);
      done = () => announced.add(file);
      undo = () => {};
    }
    const buffer = `hoptell-${crypto.randomBytes(4).toString("hex")}`;
    try {
      tmux(["load-buffer", "-b", buffer, "-"], payload);
      // -p: bracketed paste, newlines don't submit. Paste and Enter each run only while
      // the pane still hosts the original agent process.
      if (!guarded(pane, pid, `paste-buffer -d -p -b ${buffer} -t ${pane}`)) throw new Error("agent pane was replaced");
      // The text is in; it is never pasted again. An approval prompt may have come up in
      // the meantime, so hold Enter until it is gone (best effort: the screen is checked
      // right before Enter, not in the same step).
      await sleep(400);
      while (approvalVisible() && paneAlive()) await sleep(1000);
      if (!guarded(pane, pid, `send-keys -t ${pane} Enter`)) {
        undo(); // the agent is gone; the message stays for read_inbox
        continue;
      }
      done();
      console.log(new Date().toISOString(), keep ? "announced message from" : "pasted message from", m.from);
    } catch (e) {
      undo();
      spawnSync("tmux", ["delete-buffer", "-b", buffer]);
      console.error(new Date().toISOString(), "tmux error, retrying:", String(e.message).trim());
      await sleep(2000);
    }
    await sleep(1000);
  }
  console.log("hoptell injector: agent pane is gone; undelivered messages stay in the inbox");
}
