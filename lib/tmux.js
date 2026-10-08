// Run an interactive CLI agent (Codex, Claude Code, Antigravity, ...) inside tmux. When peer
// messages are waiting, an injector types a fixed notice into the agent's prompt, so an idle
// session wakes up and reads them with read_inbox. Message text is never typed.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { BIN, checkName, ensurePrivateDir, parseRoles, stateDir } from "./config.js";
import * as inbox from "./inbox.js";
import { NOTICE, NoticeScheduler } from "./notices.js";

/**
 * The environment for tmux commands, without hoptell settings. A command that starts the tmux
 * server hands it this environment, and the server gives it to every later session as its
 * global environment. Sessions started here get their settings explicitly with -e instead.
 */
export const tmuxEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("HOPTELL_")));
const tmux = (args, input) => execFileSync("tmux", args, { encoding: "utf8", input, env: tmuxEnv(), stdio: [input == null ? "ignore" : "pipe", "pipe", "pipe"] });
const tmuxRun = (args, opts = {}) => spawnSync("tmux", args, { env: tmuxEnv(), ...opts });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// Prompts where Enter would answer a question instead of submitting our text.
// Matched only against the bottom of the screen, where agents draw these prompts.
export const APPROVAL_RE =
  /Do you want to (proceed|make this edit|run|create|allow)|Would you like to (run|make|apply|allow)|Allow (command|this|once)\b|\((y\/n|Y\/n|y\/N)\)|\[(y\/n|Y\/n|y\/N)\]|Yes, (and )?don't ask|Yes, allow|[❯›>]\s*1\.\s*(Yes|Trust|Allow|Approve)|Press enter to confirm|Enter to confirm|trust this folder|Trust the files/i;
const PROMPT_LINES = 12;

/**
 * Is the agent's input line empty? `line` is the screen row holding the cursor, captured with
 * escape sequences (`capture-pane -e`); `cursorX` is the cursor column. Claude Code draws
 * "❯", Codex "›" and Antigravity ">", then a space and the input; a placeholder in dim text
 * counts as empty. Returns "empty", "typed" or "unknown" (any other layout: do not press Enter).
 */
export function promptState(line, cursorX) {
  return parsePrompt(line, cursorX).state;
}

/** promptState plus the prompt glyph and whether a dim placeholder was shown. */
function parsePrompt(line, cursorX) {
  let dim = false;
  let text = "";
  let placeholder = false;
  const result = (state, glyph = "") => ({ state, glyph, placeholder });
  // eslint-disable-next-line no-control-regex -- parsing terminal escape sequences is the point
  for (const part of String(line).split(/(\x1b(?:\[[0-9;:]*[A-Za-z]|.?))/)) {
    if (!part.startsWith("\x1b")) {
      if (dim && /\S/.test(part)) placeholder = true;
      text += dim ? part.replace(/\S/g, " ") : part;
      continue;
    }
    // eslint-disable-next-line no-control-regex -- an escape sequence
    const sgr = part.match(/^\x1b\[([0-9;:]*)m$/);
    if (!sgr) return result("unknown"); // anything but text attributes: do not guess
    const params = (sgr[1] || "0").split(";");
    for (let i = 0; i < params.length; i++) {
      const p = params[i];
      if (p.includes(":")) continue; // colon form (e.g. 38:2::255:0:0) is one color or style
      const n = Number(p || "0");
      if (n === 38 || n === 48 || n === 58) {
        // Extended color: 5;<index> or 2;<r>;<g>;<b>. Its numbers are not attributes.
        const kind = params[i + 1];
        if (kind === "5") i += 2;
        else if (kind === "2") i += 4;
        else return result("unknown");
      } else if (n === 0 || n === 22) dim = false;
      else if (n === 2) dim = true;
    }
  }
  const m = text.match(/^[ \u00a0]*([❯›>])(?=[ \u00a0]|$)/);
  if (!m) return result("unknown");
  if (text.slice(m[0].length).replace(/[ \u00a0]/g, "") !== "") return result("typed", m[1]);
  return result(cursorX === m[0].length + 1 ? "empty" : "unknown", m[1]);
}

/**
 * Is the agent's whole input empty, not just the cursor row? `above`, `line` and `below` are
 * the rows around the cursor, with escape sequences; `width` is the pane width. Codex shows its
 * dim placeholder only while the whole input is empty. Claude Code and Antigravity draw the
 * input between two full-width separator lines, so the prompt row must be the only row between
 * them: any other draft row (blank, indented, or drawn with box characters) breaks that.
 */
export function inputEmpty(above, line, below, cursorX, width) {
  const p = parsePrompt(line, cursorX);
  if (p.state !== "empty") return false;
  if (p.glyph === "›") return p.placeholder;
  return fullWidthRule(above, width) && fullWidthRule(below, width);
}

/** A separator line: box-drawing characters from the first column across the whole pane. */
function fullWidthRule(row, width) {
  // eslint-disable-next-line no-control-regex -- terminal escape sequences
  const text = String(row ?? "").replace(/\x1b\[[0-9;:]*[A-Za-z]/g, "").replace(/[\s\u00a0]+$/, "");
  return Number.isInteger(width) && width > 0 && /^[─━═]+$/.test(text) && text.length >= width - 1;
}

// The caller's effective settings go to the agent through a private file
// (~/.hoptell/sessions/<name>.env, 0600), never through process arguments.
const SETTINGS = ["HOPTELL_RELAY", "HOPTELL_TOKEN", "HOPTELL_PUSH", "HOPTELL_SNAPSHOT_ROOTS"];

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
  const ran = tmuxRun(["show-buffer", "-b", ok]).status === 0;
  if (ran) tmuxRun(["delete-buffer", "-b", ok]);
  return ran;
}

/** Does `tmux -V` output ("tmux 3.4", "tmux next-3.5") name a version hoptell supports (3.2+)? */
export function tmuxVersionSupported(v) {
  const m = String(v || "").match(/(\d+)\.(\d+)/);
  return Boolean(m && (Number(m[1]) > 3 || (Number(m[1]) === 3 && Number(m[2]) >= 2)));
}

const tmuxVersionOk = () => tmuxVersionSupported(tmuxRun(["-V"], { encoding: "utf8" }).stdout);

/** `hoptell tmux <name> [--roles a,b] -- <command...>` */
export function launch(name, cmd, rolesValue = "") {
  checkName(name);
  const roles = parseRoles(rolesValue).join(",");
  if (!cmd.length) throw new Error("usage: hoptell tmux <peer-name> [--roles a,b] -- <agent command...>");
  if (!tmuxVersionOk()) throw new Error("tmux 3.2 or newer is required (install it, e.g. `brew install tmux` or `apt install tmux`)");
  const push = String(process.env.HOPTELL_PUSH ?? "").trim();
  if (push && push !== "tmux") {
    throw new Error(`hoptell tmux uses tmux delivery; unset HOPTELL_PUSH or set it to tmux. To keep a channel session in a persistent terminal, start Claude Code in ordinary tmux instead`);
  }
  if (cmd.some((w) => /^(server:hoptell|plugin:hoptell@\S+)$/.test(w))) {
    throw new Error("hoptell tmux would add a second delivery path to a hoptell channel session; start Claude Code with channels in ordinary tmux instead");
  }
  process.env.HOPTELL_PUSH = "tmux"; // the agent's MCP server uses tmux delivery: no listener
  const session = sessionFor(name);
  if (tmuxRun(["has-session", "-t", `=${session}`]).status === 0) {
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
  const r = tmuxRun(attach, { stdio: "inherit" });
  if (r.status !== 0) console.error(`hoptell: session ${session} is running; attach with: tmux attach -t ${session}`);
}

const IDLE_S = 8; // no key from any attached client for this long before typing

/**
 * The injector loop: while messages wait in `name`'s inbox, type the fixed notice into exactly
 * pane `pane` (e.g. "%3") while it still runs the original process `pid`, and press Enter.
 * It types only when the agent's prompt is recognizably empty, no approval prompt is visible,
 * the pane is not in a tmux mode and nobody typed for a few seconds; otherwise it waits.
 * Messages stay in the inbox until the agent reads them.
 */
export async function inject(name, pane, pid) {
  checkName(name);
  if (!/^%\d+$/.test(pane || "") || !/^\d+$/.test(pid || "")) throw new Error("usage: hoptell inject <name> <tmux pane id> <pane pid>");
  const show = (format) => tmux(["display-message", "-p", "-t", pane, format]).trim();
  const paneAlive = () => {
    try {
      return show("#{pane_id} #{pane_pid} #{pane_dead}") === `${pane} ${pid} 0`;
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
  /** Seconds since the last key from any client attached to the pane's session (Infinity: none). */
  /**
   * The last key time of any client attached to the pane's session, as tmux reports it (whole
   * seconds); -Infinity when none is attached. Throws when it cannot be read.
   */
  const lastKey = () => {
    const session = show("#{session_id}");
    const times = tmux(["list-clients", "-t", session, "-F", "#{client_activity}"]).split("\n").filter(Boolean);
    if (times.some((t) => !/^\d+$/.test(t))) throw new Error("unreadable client activity");
    return times.length ? Math.max(...times.map(Number)) : -Infinity;
  };
  const promptEmpty = () => {
    const [x, y, width] = show("#{cursor_x} #{cursor_y} #{pane_width}").split(" ").map(Number);
    if (y < 1) return false; // no room for the line above the input: not a layout we know
    const [above, line, below = ""] = tmux(["capture-pane", "-p", "-e", "-t", pane, "-S", String(y - 1), "-E", String(y + 1)]).replace(/\n$/, "").split("\n");
    return inputEmpty(above, line, below, x, width);
  };
  const ready = () => {
    try {
      return paneAlive() && show("#{pane_in_mode}") === "0" && Date.now() / 1000 - lastKey() >= IDLE_S && !approvalVisible() && promptEmpty();
    } catch {
      return false;
    }
  };

  /** Type the notice and submit it. False (nothing typed) when the pane is not ready. */
  async function send() {
    if (!ready()) return false;
    const buffer = `hoptell-${crypto.randomBytes(4).toString("hex")}`;
    const typedAt = Date.now() / 1000;
    try {
      tmux(["load-buffer", "-b", buffer, "-"], NOTICE);
      // -p: bracketed paste. Paste and Enter each run only while the pane still hosts the agent.
      if (!guarded(pane, pid, `paste-buffer -d -p -b ${buffer} -t ${pane}`)) return false;
    } catch (e) {
      tmuxRun(["delete-buffer", "-b", buffer]);
      console.error(new Date().toISOString(), "tmux error, retrying:", String(e.message).trim());
      return false;
    }
    // Best effort: the screen is checked right before Enter, not in the same step.
    await sleep(400);
    for (let i = 0; i < 30 && paneAlive() && approvalVisible(); i++) await sleep(1000);
    let keyAt = Infinity; // unknown: treat as typed
    try {
      keyAt = lastKey();
    } catch {
      // keep Infinity
    }
    if (keyAt >= Math.floor(typedAt)) {
      // client_activity has whole seconds, so a key in the same second counts as typed after.
      // Someone typed after the notice went in: leave it in the prompt for them.
      console.log(new Date().toISOString(), "notice typed but not submitted: someone is typing");
      return true;
    }
    if (approvalVisible() || !guarded(pane, pid, `send-keys -t ${pane} Enter`)) {
      console.log(new Date().toISOString(), "notice typed but not submitted");
      return true;
    }
    console.log(new Date().toISOString(), "submitted the inbox notice");
    return true;
  }

  console.log(`hoptell injector: announcing messages for "${name}" in pane ${pane}`);
  const scheduler = new NoticeScheduler({ list: () => inbox.list(name), send });
  while (paneAlive()) {
    await scheduler.tick().catch(() => {});
    await sleep(500);
  }
  console.log("hoptell injector: agent pane is gone; messages stay in the inbox");
}
