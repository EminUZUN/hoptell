// Run an interactive CLI agent (Codex, Claude Code, Antigravity, ...) inside tmux. When peer
// messages are waiting, an injector types a fixed notice into the agent's prompt, so an idle
// session wakes up and reads them with read_inbox. Message text is never typed.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { BIN, checkName, ensurePrivateDir, envAuth, envContactsSelf, envCredentialStore, parseRoles } from "./config.js";
import * as inbox from "./inbox.js";
import { HELD_NOTICE, NOTICE, NoticeScheduler, heldEntries } from "./notices.js";
import { memberOfStoreDir, resolveNameStore, storeParts } from "./session.js";
import { openStore } from "./store.js";
import { openContacts } from "./quarantine.js";
import { withLock } from "./locks.js";
import { processIdentity } from "./host.js";
import { claimFileOf, launchFileOf, launchGate, startGate, writeLaunch } from "./startgate.js";
import { promptFileOf } from "./promptflow.js";
import { WATCH_MS, classifyPrompt, createWatch } from "./prompts.js";
import { clearForeignOccurrence, closeOccurrence, openOccurrence, ownerBudget, waitLabel, waitLine, waitNoteText } from "./waits.js";


/**
 * The environment for tmux commands, without hoptell settings. A command that starts the tmux
 * server hands it this environment, and the server gives it to every later session as its
 * global environment. Sessions started here get their settings explicitly with -e instead.
 */
export const tmuxEnv = (env = process.env) => Object.fromEntries(Object.entries(env).filter(([k]) => !k.startsWith("HOPTELL_")));
const tmux = (args, input) => execFileSync("tmux", args, { encoding: "utf8", input, env: tmuxEnv(), stdio: [input == null ? "ignore" : "pipe", "pipe", "pipe"] });
const tmuxRun = (args, opts = {}) => spawnSync("tmux", args, { env: tmuxEnv(), ...opts });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// Prompts where Enter would answer a question instead of submitting our text.
// Matched only against the bottom of the screen, where agents draw these prompts.
export const APPROVAL_RE =
  /Do you want to (proceed|make this edit|run|create|allow)|Would you like to (run|make|apply|allow)|Allow (command|this|once)\b|\((y\/n|Y\/n|y\/N)\)|\[(y\/n|Y\/n|y\/N)\]|Yes, (and )?don't ask|Yes, allow|[❯›>]\s*1\.\s*(Yes|Trust|Allow|Approve)|Press enter to confirm|Enter to confirm|trust this folder|Trust the files/i;
const PROMPT_LINES = 12;

// Codex's transcript selection and copy mode: while one of these footers shows, Enter copies
// the selection ("copy & follow") instead of submitting the prompt. From Codex 0.162.1,
// codex-rs/tui/src/transcript_view/footer.rs (the same on main at 9ce35d3, 2026-10-03). The
// footer shows the first variant that fits the pane width, so a narrow pane shows only one of
// the short ones; a status ("New activity", "Earlier messages available.", loading) may come
// first, and a failed history load adds "Retry: <key>" after it. "New activity" alone is not a
// selection: it also shows while following is paused. These are Codex's own strings and may
// change in a later version, so they are only a veto (do not type), never a sign of readiness.
// They are checked in every pane: the injector does not know which agent runs in it, and a
// whole footer row with these words in another agent only makes it wait.
const SELECTION_ROWS = [
  /(^|[\s·])enter copy & follow · esc clear( · Retry: .+)?$/, // "<ctrl-c> copy · enter copy & follow · esc clear" and "enter copy & follow · esc clear"
  /^enter copy\+↓ · esc$/, // narrow
  /^esc clear$/, // narrowest
  /(^|[\s·])enter copy · esc close$/, // copy mode (footer.rs:27); it is not shortened for narrow panes
];

// eslint-disable-next-line no-control-regex -- terminal escape sequences
const plain = (row) => String(row ?? "").replace(/\x1b\[[0-9;:?]*[A-Za-z]/g, "").replace(/[\s\u00a0]+/g, " ").trim();

/** The bottom rows of a captured screen, where agents draw prompts and footers. */
const bottomRows = (screen) => String(screen).replace(/\s+$/, "").split("\n").slice(-PROMPT_LINES);

/**
 * Does the screen (capture-pane text) show Codex's transcript selection or copy mode footer?
 * Only the footer counts: the bottom-most non-blank row, where Codex draws the hint (the last
 * line of a two-line footer, as in copy mode and search). The same words higher up, in the
 * transcript or a draft, are not a footer. Styling is not checked: a later Codex that restyles
 * the hint should still be vetoed.
 */
export function selectionShown(screen) {
  const footer = plain(bottomRows(screen).at(-1));
  return SELECTION_ROWS.some((re) => re.test(footer));
}

/** Visible characters of the notice (spaces aside) needed when the start of the draft is not on screen. */
export const MIN_VISIBLE_NOTICE = 64;

/**
 * Does the prompt hold the notice `expected`, with the cursor right after it? `rows` are the
 * screen rows (capture-pane without -J: an agent's own line breaks stay rows), `x` and `y` the
 * cursor. Spaces are ignored, as agents wrap long input at spaces.
 *
 * Read upwards from the cursor, the rows must spell the end of `expected`. Nothing may follow
 * the cursor on its row, and the row below must be blank or a separator rule (no more draft).
 * If the first row of the draft is on screen (the prompt glyph, Codex without its "↑" marker of
 * hidden rows), the draft must be the whole of `expected`; if it is not (a composer capped and
 * scrolled, or a prompt taller than the pane), at least MIN_VISIBLE_NOTICE of its last characters
 * must be visible. Any other row (blank, other text) ends the draft: then it does not hold.
 *
 * With `whole`, only a draft whose first row is on screen counts, and it must be all of
 * `expected`: the visible end alone is not enough.
 *
 * This shows that the visible end of the draft is the notice and the cursor is at its end. It
 * does not show what hidden rows above hold (only `whole` covers them), nor that the agent gives the prompt focus beyond
 * where it puts the cursor; callers add the other checks (no key since the paste, no selection,
 * approval or tmux mode). False for anything it cannot read.
 */
export function promptHolds(rows, x, y, expected, { whole = false, width } = {}) {
  const r = scanDraft(rows, x, y, expected, width);
  if (!r || !r.suffix) return false;
  if (r.complete) return true;
  return !whole && r.seen >= Math.min(MIN_VISIBLE_NOTICE, squash(expected).length);
}

const squash = (str) => String(str).replace(/[\s\u00a0]+/g, "");

/**
 * A row without Codex's "↑" marker of hidden rows, and whether it had one. The marker follows a
 * space, or, when the text fills Codex's text area (the pane width less 3), it sits right after
 * the text in the pane's last column. Codex's text never reaches that column, so a "↑" there
 * without a space is the marker; it counts only on a Codex prompt row (› or ») of a pane of
 * known `width`. A typed "↑" anywhere else stays text.
 */
const unmark = (row, width) => {
  if (/[ \u00a0]↑$/.test(row)) return { row: row.replace(/[ \u00a0]+↑$/, ""), scrolled: true };
  if (Number.isInteger(width) && width > 3 && row.endsWith("↑") && [...row].length === width && /^[ \u00a0]*[›»][ \u00a0]/.test(row)) return { row: row.slice(0, -1), scrolled: true };
  return { row, scrolled: false };
};

/**
 * The draft that ends at the cursor, read upwards (see promptHolds). Null when the cursor is not
 * at its end or the draft goes on below. Otherwise {suffix, complete, seen}: `complete` when its
 * first row is on screen (the prompt glyph without Codex's "↑"), `suffix` when what is visible
 * is the end of `expected` (all of it, when complete), `seen` the visible characters.
 */
function scanDraft(rows, x, y, expected, width) {
  if (!Number.isInteger(x) || !Number.isInteger(y) || y < 0 || y >= rows.length) return null;
  const text = (i) => String(rows[i] ?? "").replace(/[\s\u00a0]+$/, "");
  const end = unmark(text(y), width).row.length; // a one-row capped composer has its "↑" here
  let last = y;
  // At a wrap boundary the cursor may sit at the start of the next, still empty row.
  if (text(y).trim() === "" && x <= 2 && y > 0) last = y - 1;
  else if (x < end || x > end + 1) return null; // more text after the cursor
  const below = text(y + 1).trim();
  if (below !== "" && !/^[─━═]+$/.test(below)) return null; // the draft goes on below the cursor
  const target = squash(expected);
  let seen = "";
  for (let i = last; i >= 0; i--) {
    const { row, scrolled } = unmark(text(i), width); // Codex: rows of the draft are hidden above
    const glyph = row.match(/^[ \u00a0]*[❯›»>](?:[ \u00a0]|$)/);
    const part = squash(glyph ? row.slice(glyph[0].length) : row);
    if (!part || !target.endsWith(part + seen)) return { suffix: false, complete: false, seen: seen.length }; // not the notice
    seen = part + seen;
    if (glyph && !scrolled) return { suffix: seen === target, complete: true, seen: seen.length };
    if (glyph) break;
  }
  // The first row is hidden: in a capped composer, or above the top of the screen.
  return { suffix: true, complete: false, seen: seen.length };
}

/**
 * What the draft around the cursor row `y` shows, wherever the cursor is in it (a key may have
 * moved it). The draft is taken to end at the last row of text below the cursor, before a blank
 * row or a separator rule. "notice": the notice by the rules of promptHolds; "partial": the end
 * of the notice, but too little of it is visible to tell (a narrow capped composer); "other":
 * not the notice (or an empty prompt); null: not readable.
 */
export function draftState(rows, y, expected, width) {
  if (!Number.isInteger(y) || y < 0 || y >= rows.length) return null;
  const text = (i) => String(rows[i] ?? "").replace(/[\s\u00a0]+$/, "");
  const ends = (i) => i >= rows.length || text(i).trim() === "" || /^[─━═]+$/.test(text(i).trim());
  let x = 0;
  let last = y;
  if (!ends(y)) {
    while (!ends(last + 1) && last - y < 60) last++;
    x = unmark(text(last), width).row.length;
  } // else: the empty row after a wrap
  const r = scanDraft(rows, x, last, expected, width);
  if (!r) return null;
  if (!r.suffix) return "other";
  if (r.complete || r.seen >= Math.min(MIN_VISIBLE_NOTICE, squash(expected).length)) return "notice";
  return "partial";
}

/** draftState is "notice". */
export const draftHolds = (rows, y, expected, width) => draftState(rows, y, expected, width) === "notice";

export const BLOCKED_LOG_MS = 60_000;

/**
 * Logs once which ready() check keeps a notice from going out, after it has failed for over
 * `afterMs`. Only the check's name is logged, never screen text. note(null) (the pane was ready)
 * and reset() (the inbox is empty) start over, and so does a different failing check.
 */
export class BlockedLog {
  constructor({ afterMs = BLOCKED_LOG_MS, now = Date.now, log = (...a) => console.log(new Date().toISOString(), ...a) } = {}) {
    Object.assign(this, { afterMs, now, log });
    this.reset();
  }

  reset() {
    this.check = null;
    this.since = 0;
    this.logged = false;
  }

  /** `check`: the name of the failing check, or null. Returns whether it logged now. */
  note(check) {
    if (!check) return (this.reset(), false);
    if (check !== this.check) {
      this.check = check;
      this.since = this.now();
      this.logged = false;
      return false;
    }
    if (this.logged || this.now() - this.since <= this.afterMs) return false;
    this.logged = true;
    this.log(`inbox notice waiting for over ${Math.round(this.afterMs / 1000)} s; failing check: ${check}`);
    return true;
  }
}

/**
 * Is the agent's input line empty? `line` is the screen row holding the cursor, captured with
 * escape sequences (`capture-pane -e`); `cursorX` is the cursor column. Claude Code draws
 * "❯", Codex "›" (0.162.1 can also draw "»", observed in fresh sessions) and Antigravity ">",
 * then a space and the input; a placeholder in dim text counts as empty. Returns "empty",
 * "typed" or "unknown" (any other layout: do not press Enter).
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
  const m = text.match(/^[ \u00a0]*([❯›»>])(?=[ \u00a0]|$)/);
  if (!m) return result("unknown");
  if (text.slice(m[0].length).replace(/[ \u00a0]/g, "") !== "") return result("typed", m[1]);
  return result(cursorX === m[0].length + 1 ? "empty" : "unknown", m[1]);
}

/** Codex's prompt glyphs: its input has no separator rules, only the dim placeholder when empty. */
const CODEX_GLYPHS = new Set(["›", "»"]);

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
  if (CODEX_GLYPHS.has(p.glyph)) return p.placeholder;
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
// The sign-in passphrase is never written here: it would sit next to the file it protects.
const SETTINGS = ["HOPTELL_RELAY", "HOPTELL_TOKEN", "HOPTELL_AUTH", "HOPTELL_CREDENTIAL_STORE", "HOPTELL_PUSH", "HOPTELL_SNAPSHOT_ROOTS", "HOPTELL_PROTOCOL", "HOPTELL_PROFILE", "HOPTELL_RECEIPTS", "HOPTELL_LEASE_MINUTES", "HOPTELL_NOTIFY", "HOPTELL_CONTACTS_SELF", "HOPTELL_TITLE", "HOPTELL_TITLE_AUTO", "HOPTELL_STALL_MINUTES"];

export function writeSessionSettings(home, name, settings) {
  const dir = ensurePrivateDir(path.join(ensurePrivateDir(home), "sessions"));
  const file = path.join(dir, `${name}.env`);
  const body = SETTINGS.filter((k) => settings[k]).map((k) => `${k}=${JSON.stringify(settings[k])}`).join("\n");
  fs.rmSync(file, { force: true });
  fs.writeFileSync(file, `${body}\n`, { flag: "wx", mode: 0o600 });
  return file;
}

export const sessionFor = (name) => `hoptell-${name}`;
export const TMUX_USAGE = "hoptell tmux <peer-name> [--roles a,b] [--cwd <dir>] [--task <file>] -- <agent command...>";

// The task of a session (design 8, topic 4): `hoptell tmux --task <file>` copies it into
// ~/.hoptell/sessions/<name>.task (0600) at launch, and the session's read_task serves only the
// file whose digest the session got. It keeps the task off the command line, which `ps` and the
// pane show; it is not hidden from other processes of the same user.
export const TASK_MAX = 32768;

/** Read and check a task file for --task: {bytes, digest}; throws with the reason. */
export function readTaskFile(file) {
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    throw new Error(`--task: ${file} does not exist`);
  }
  if (!st.isFile()) throw new Error(`--task: ${file} is not a file`);
  if (st.size > TASK_MAX) throw new Error(`--task: ${file} is over ${TASK_MAX} bytes`);
  const bytes = fs.readFileSync(file);
  if (bytes.length > TASK_MAX) throw new Error(`--task: ${file} is over ${TASK_MAX} bytes`);
  if (!bytes.toString("utf8").trim()) throw new Error(`--task: ${file} is empty`);
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`--task: ${file} is not UTF-8 text`);
  }
  if (bytes.includes(0)) throw new Error(`--task: ${file} contains a NUL byte`);
  return { bytes, digest: crypto.createHash("sha256").update(bytes).digest("hex") };
}

/** The file whose time says when messages last waited for session `name` (its injector writes it). */
export const activityFileOf = (home, name) => path.join(home, "sessions", `${checkName(name)}.notice`);

export const taskFileOf = (home, name) => path.join(home, "sessions", `${checkName(name)}.task`);

/** Store a session's task (or remove a stale one when `task` is null). */
function writeSessionTask(home, name, task) {
  const file = taskFileOf(home, name);
  ensurePrivateDir(path.dirname(file));
  fs.rmSync(file, { force: true });
  if (task) fs.writeFileSync(file, task.bytes, { flag: "wx", mode: 0o600 });
}

/** The working folder for --cwd: an existing folder, resolved. */
export function checkCwd(dir) {
  let real;
  try {
    real = fs.realpathSync(dir);
  } catch {
    throw new Error(`--cwd: ${dir} does not exist`);
  }
  if (!fs.statSync(real).isDirectory()) throw new Error(`--cwd: ${dir} is not a folder`);
  return real;
}

/**
 * Run tmux `command` on `pane` only if the pane still runs process `pid`: tmux checks
 * and runs it in one step, so a respawn cannot slip in between. Returns whether it ran.
 */
export function guarded(pane, pid, command, { run = tmux, status = (args) => tmuxRun(args).status, session = null } = {}) {
  const ok = `hoptell-ok-${crypto.randomBytes(4).toString("hex")}`;
  // With `session` (a session id, "$<n>"): only while the pane also still belongs to that session,
  // and is that very pane.
  const alive = `#{&&:#{==:#{pane_pid},${pid}},#{==:#{pane_dead},0}}`;
  const condition = session ? `#{&&:${alive},#{&&:#{==:#{session_id},${session}},#{==:#{pane_id},${pane}}}}` : alive;
  run(["if-shell", "-F", "-t", pane, condition, `${command} ; set-buffer -b ${ok} 1`]);
  const ran = status(["show-buffer", "-b", ok]) === 0;
  if (ran) status(["delete-buffer", "-b", ok]);
  return ran;
}

/**
 * End a run's session by its immutable id (never by a name, which a rename can hand to another
 * session), only while `pane` still runs `pid` and belongs to that session. False otherwise.
 */
export function endSession(pane, pid, sessionId, { run = tmux, status = (args) => tmuxRun(args).status } = {}) {
  if (!/^\$\d+$/.test(String(sessionId)) || !/^%\d+$/.test(String(pane)) || !/^\d+$/.test(String(pid))) return false;
  return guarded(pane, pid, `kill-session -t ${q(sessionId)}`, { run, status, session: sessionId });
}

/** Does `tmux -V` output ("tmux 3.4", "tmux next-3.5") name a version hoptell supports (3.2+)? */
export function tmuxVersionSupported(v) {
  const m = String(v || "").match(/(\d+)\.(\d+)/);
  return Boolean(m && (Number(m[1]) > 3 || (Number(m[1]) === 3 && Number(m[2]) >= 2)));
}

const tmuxVersionOk = () => tmuxVersionSupported(tmuxRun(["-V"], { encoding: "utf8" }).stdout);

/**
 * `hoptell tmux <name> [--roles a,b] [--cwd <dir>] [--task <file>] -- <command...>`. `env` holds
 * the caller's effective settings (environment plus settings file) and `home` the state
 * directory; neither is changed. `cwd`: the agent's working folder (default: this process's);
 * `task`: a task file, copied into the session's task store. `attach: false` (hoptell team up)
 * leaves the session in the background. `team` ({team, role}, hoptell team up and restart only):
 * the session is a team member, and its hoptell MCP server leaves out the tools a member does
 * not use (lib/mcp.js MEMBER_HIDDEN). Returns {session, sessionId, pane, pid}.
 */
export async function launch(name, cmd, rolesValue = "", { env: callerEnv, home, prepare = null, cwd = null, task = null, attach = true, team = null }) {
  checkName(name);
  const roles = parseRoles(rolesValue).join(",");
  if (!cmd.length) throw new Error(`usage: ${TMUX_USAGE}`);
  const folder = checkCwd(cwd ?? process.cwd());
  const taskFile = task == null ? null : readTaskFile(task);
  // A member's worktree (hoptell worktree add) is for that member and its CLI only.
  const { memberState, startMemberSession, worktreeAt } = await import("./worktrees.js");
  const wt = worktreeAt(home, folder);
  if (wt && wt.member !== name) throw new Error(`${folder} is the worktree of ${wt.member}; only ${wt.member} starts there (hoptell worktree add gives ${name} its own)`);
  if (wt && path.basename(cmd[0]) !== wt.cli) throw new Error(`${folder} was added for a ${wt.cli} implementer (hoptell worktree add --cli ${wt.cli}), not ${path.basename(cmd[0])}`);
  if (wt && memberState(home, wt.member).state !== "stopped") throw new Error(`an earlier session of ${wt.member} is still running, or may be (hoptell worktree list); stop it first`);
  // Both are checked before anything starts (a misspelled value would stop the session's MCP server later).
  const auth = envAuth(callerEnv);
  envContactsSelf(callerEnv); // the agent and the injector decide alike: refused here when invalid
  const credentialStore = envCredentialStore(callerEnv);
  if (!tmuxVersionOk()) throw new Error("tmux 3.2 or newer is required (install it, e.g. `brew install tmux` or `apt install tmux`)");
  const push = String(callerEnv.HOPTELL_PUSH ?? "").trim();
  if (push && push !== "tmux") {
    throw new Error(`hoptell tmux uses tmux delivery; unset HOPTELL_PUSH or set it to tmux. To keep a channel session in a persistent terminal, start Claude Code in ordinary tmux instead`);
  }
  if (cmd.some((w) => /^(server:hoptell|plugin:hoptell@\S+)$/.test(w))) {
    throw new Error("hoptell tmux would add a second delivery path to a hoptell channel session; start Claude Code with channels in ordinary tmux instead");
  }
  if (auth === "login" && credentialStore === "file") {
    throw new Error("hoptell tmux does not pass HOPTELL_CREDENTIAL_PASSPHRASE to the session; sign in with the OS keychain (hoptell login without --store file), or use a member token");
  }
  const session = sessionFor(name);
  const sessionExists = () => {
    if (tmuxRun(["has-session", "-t", `=${session}`]).status === 0) {
      throw new Error(`tmux session ${session} already exists: attach with \`tmux attach -t '=${session}'\`, or end it with \`tmux kill-session -t '=${session}'\``);
    }
  };
  sessionExists();
  // Everything was checked: `prepare` runs before anything is created (the CLI classifies the
  // home's contacts there, so the files below never make a new home look like an old one).
  await prepare?.();
  // One launch at a time per name (and, in a member's worktree, per repository, taken inside
  // startMemberSession): the checks are repeated there, and a refused launch writes nothing, so
  // it never replaces the task or settings of the session that won.
  const start = () => {
    sessionExists();
    // Blank inherited values (an already running tmux server may hold stale ones) so the
    // session file decides; the agent and the injector see exactly the caller's settings.
    // The agent's MCP server uses tmux delivery: no listener.
    const settings = { ...callerEnv, HOPTELL_PUSH: "tmux" };
    // The task store is written (or a stale task removed) even without --task: a reused name
    // never serves an earlier session's task.
    writeSessionTask(home, name, taskFile);
    // HOPTELL_TEAM_MEMBER is set here only, from the team state's launch; empty otherwise, so a
    // value a tmux server kept from an earlier session never applies.
    const env = { HOPTELL_NAME: name, HOPTELL_ROLES: roles, HOPTELL_HOME: home, HOPTELL_ENV: writeSessionSettings(home, name, settings), HOPTELL_TASK: taskFile?.digest ?? "", HOPTELL_TEAM_MEMBER: team ? `${team.role}:${team.team}` : "" };
    for (const k of SETTINGS) env[k] = "";
    // The startup trust gate (design 9, C; lib/startgate.js): an earlier launch's record goes
    // first, so only this launch's record can ever name this session's pane.
    fs.rmSync(launchFileOf(home, name), { force: true });
    fs.rmSync(claimFileOf(home, name), { force: true }); // the earlier launch's claim goes with it
    fs.rmSync(promptFileOf(home, name), { force: true }); // and its prompt record: a new launch, a new card
    const gate = launchGate(cmd, { folder, env: callerEnv });
    // The test switch for the owner's live check of the prompt's keys (lib/startgate.js): only "1".
    const untested = String(callerEnv.HOPTELL_PROMPT_UNTESTED ?? "").trim() === "1";
    const argv = gate.argv;
    // Interactive Codex starts MCP servers from a shared app-server daemon that does not
    // inherit this environment, so pass the same settings as a config override.
    if (/(^|\/)codex$/.test(argv[0])) {
      const table = Object.entries(env).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(", ");
      argv.splice(1, 0, "-c", `mcp_servers.hoptell.env={${table}}`);
    }
    // The launch record is written once the agent's pane runs and before its injector starts, so
    // the injector always finds it (or knows there is none).
    const record = (started) => {
      let socket = null;
      try {
        socket = tmux(["display-message", "-p", "-t", started.pane, "#{socket_path}"]).trim() || null;
      } catch {}
      try {
        writeLaunch(home, name, { cli: gate.cli, root: gate.root, gate: gate.gate, folder: fs.realpathSync(folder), tmux: { socket, session: started.sessionId, pane: started.pane }, host: processIdentity(Number(started.pid)), untested });
      } catch (e) {
        // The session runs: without its record, its prompts are shown, never answered from Telegram.
        console.error(`hoptell: the launch record of ${name} could not be written (${e.message}); its prompts can only be shown`);
      }
    };
    return startSession(session, name, argv, env, folder, { beforeInjector: record });
  };
  const launchLock = path.join(ensurePrivateDir(path.join(ensurePrivateDir(home), "sessions")), `${name}.launch`);
  const started = await withLock(
    launchLock,
    // In a member's worktree the session is recorded (under the repository's lock), so hoptell
    // worktree commands refuse while it or a process it started runs.
    async () => (wt ? startMemberSession(home, wt, start) : start()),
    { waitMs: 10_000 },
  );
  if (attach) {
    const how = callerEnv.TMUX ? ["switch-client", "-t", `=${session}`] : ["attach", "-t", `=${session}`];
    const r = tmuxRun(how, { stdio: "inherit" });
    if (r.status !== 0) console.error(`hoptell: session ${session} is running; attach with: tmux attach -t '=${session}'`);
  }
  return { session, ...started };
}

/**
 * The agent window's shell command. For `hoptell tmux` (`endByName`), the session is ended by its
 * name when the agent exits, so the injector goes with it (unchanged); with `name`, first a short
 * wait while that session's prompt answer is carried out or its result is not reported yet
 * (`hoptell prompt-wait`: a Quit ends the agent at once). A spawned run's session has
 * no such command: a session name can be reused, so ending is left to the injector (it exits
 * when the agent's pane is gone, and the session with it) and to the run's supervisor, which ends
 * it by its immutable session id.
 */
export function agentCommand(cmd, session, { endByName = true, name = null } = {}) {
  const line = cmd.map(q).join(" ");
  const settle = name ? `${q(process.execPath)} ${q(BIN)} prompt-wait ${q(checkName(name))}; ` : "";
  return endByName ? `${line}; ${settle}tmux kill-session -t ${q(`=${session}`)}` : line;
}

/**
 * Start the tmux session: the agent window running `cmd` in `cwd` with exactly the variables of
 * `env` set (-e), and the injector window. Returns {sessionId, pane, pid} of the agent's pane.
 * `run` runs one tmux command (the caller decides the tmux client's environment);
 * `beforeInjector(started)` runs between the two windows (it must not throw).
 */
function startSession(session, name, cmd, env, cwd, { run = tmux, endByName = true, beforeInjector = () => {} } = {}) {
  const envArgs = Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
  const [sessionId, pane, pid] = run(["new-session", "-d", "-P", "-F", "#{session_id} #{pane_id} #{pane_pid}", "-s", session, "-n", "agent", "-c", cwd, ...envArgs, agentCommand(cmd, session, { endByName, name: endByName ? name : null })]).trim().split(" ");
  try {
    beforeInjector({ sessionId, pane, pid });
    // By the new session's id: a rename in between cannot point this at another session.
    run(["new-window", "-d", "-t", /^\$\d+$/.test(sessionId) ? sessionId : `=${session}`, "-n", "injector", ...envArgs, `${q(process.execPath)} ${q(BIN)} inject ${q(name)} ${q(pane)} ${q(pid)}`]);
  } catch (e) {
    // The agent's pane already runs: end its session (by id, while the pane still runs that
    // process in it), so no agent is left without its injector and without a record.
    // The pane's process can outlive its session (a kill-session that comes before the process
    // has its terminal sends it no hangup): the error names it, so the caller can stop it by pid.
    try {
      endSession(pane, pid, sessionId, { run, status: (args) => (run(args), 0) });
    } catch {}
    throw Object.assign(e, { started: { sessionId, pane, pid } });
  }
  return { sessionId, pane, pid };
}

/** When the pane's window last showed output (tmux window_activity), in ms, or null. */
export function paneActivity(pane) {
  if (!/^%\d+$/.test(String(pane))) return null;
  const r = tmuxRun(["display-message", "-p", "-t", pane, "#{window_activity}"], { encoding: "utf8" });
  const s = Number(String(r.stdout ?? "").trim());
  return r.status === 0 && Number.isSafeInteger(s) && s > 0 ? s * 1000 : null;
}

/** Show `text` to whoever looks at `pane` (tmux's message line), only while it runs `pid`. */
export function paneNotice(pane, pid, text) {
  if (!/^%\d+$/.test(String(pane)) || !/^\d+$/.test(String(pid))) return false;
  try {
    return guarded(pane, pid, `display-message -d 60000 -t ${q(pane)} ${q(String(text).replace(/#/g, "##"))}`);
  } catch {
    return false;
  }
}

/**
 * A plain background session for a hoptell process of the owner's (the team supervisor): no agent,
 * no injector. `env` holds non-secret values only (they are on tmux's command line). Returns
 * {sessionId, pane, pid}; refuses an existing session of that name.
 */
export function startPlainSession(session, argv, { env, cwd }) {
  if (tmuxRun(["has-session", "-t", `=${session}`]).status === 0) throw new Error(`tmux session ${session} already exists`);
  const envArgs = Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
  const [sessionId, pane, pid] = tmux(["new-session", "-d", "-P", "-F", "#{session_id} #{pane_id} #{pane_pid}", "-s", session, "-c", cwd, ...envArgs, argv.map(q).join(" ")]).trim().split(" ");
  return { sessionId, pane, pid };
}

// The tmux client's environment for a spawned run: these only, never a secret (a tmux server
// started by the run takes the client's environment as its global environment).
const STERILE = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "TMPDIR", "TERM"];

/**
 * A spawned agent's session (design 7.1): launch() detached (no attach or switch-client), in the
 * run's working directory, with the run's settings instead of a copy of the caller's. `ids` are
 * the run's non-secret identifiers (HOPTELL_HOME, _NAME, _ROLES, _ENV, _RELAYS, _RUN), the only
 * values on a tmux command line; the agent's full environment, pass-through values included,
 * reaches it through a private file of the run (hoptell agents exec). Every tmux command runs with
 * a sterile environment built from `base`. Returns {session, sessionId, pane, pid, end(pid),
 * cleanup()}: end() runs kill-session only while the pane still runs `pid` (guarded); cleanup()
 * ends the session after the agent exited, by its session id and only while it still has its name.
 */
export function launchDetached(name, cmd, { ids, base, cwd, tmuxBin = "tmux" }) {
  checkName(name);
  if (!cmd.length) throw new Error("no agent command");
  const sterile = Object.fromEntries(STERILE.filter((k) => base[k] !== undefined).map((k) => [k, base[k]]));
  const run = (args) => execFileSync(tmuxBin, args, { encoding: "utf8", env: sterile, stdio: ["ignore", "pipe", "pipe"] });
  const status = (args) => spawnSync(tmuxBin, args, { env: sterile, stdio: "ignore" }).status;
  if (!tmuxVersionSupported(spawnSync(tmuxBin, ["-V"], { env: sterile, encoding: "utf8" }).stdout)) throw new Error("tmux 3.2 or newer is required");
  const session = sessionFor(name);
  if (status(["has-session", "-t", `=${session}`]) === 0) throw Object.assign(new Error(`tmux session ${session} already exists`), { code: "name_in_use" });
  // Inherited values of a running tmux server are blanked: the session gets the run's settings only.
  const full = { ...Object.fromEntries(SETTINGS.map((k) => [k, ""])), HOPTELL_EXPERIMENTAL_E2EE: "", ...ids };
  let started;
  try {
    started = startSession(session, name, cmd, full, cwd, { run, endByName: false });
  } catch (e) {
    // The caller may end the session again (by id, checked pane) if its process outlives the start.
    if (e.started) e.started.end = () => endSession(e.started.pane, e.started.pid, e.started.sessionId, { run, status });
    throw e;
  }
  const { sessionId, pane, pid } = started;
  return {
    session,
    sessionId,
    pane,
    pid,
    end: (p) => endSession(pane, p, sessionId, { run, status }),
    cleanup: () => {
      if (!/^\$\d+$/.test(sessionId)) return false;
      const cond = `#{==:#{session_name},${session}}`;
      return status(["if-shell", "-F", "-t", sessionId, cond, `kill-session -t ${q(sessionId)}`]) === 0;
    },
  };
}

const IDLE_S = 8; // no key from any attached client for this long before typing

/**
 * After a key, what one look at a pending notice's draft (`d`, from pendingDraft) means, given the
 * earlier looks kept on `pending` (its `change` and `back` marks): "handover" (a lasting change:
 * the person has it), "wait" (unsettled: never submit on this look) or "ok" (no suspicion: the
 * usual checks decide). `size` is the pane's size at this look, or null when it cannot be read.
 *
 * One look can catch a frame in passing: on a resize tmux reflows the old screen before the
 * agent redraws it, and a redraw can be captured half done. So neither direction is taken from
 * a single look. A change ("empty" or "other") counts only when it is seen again at least
 * CHANGE_CONFIRM_MS later at the same pane size; until then the notice is not submitted. Once a
 * change was seen, only a stable return to the notice clears the suspicion: "notice" seen twice,
 * at least CHANGE_CONFIRM_MS apart, at the same size, with no other look in between. A
 * "partial" or unknown look (null) keeps the suspicion and restarts the return. A resize starts
 * either check over. A look whose pane size cannot be read is never "ok": a change seen on it,
 * or before it, stays suspected and both checks start over, so only later looks with a readable
 * size can confirm a change or a return.
 */
export const CHANGE_CONFIRM_MS = 1000;
export function settleLook(pending, d, size, now) {
  const lasted = (mark) => size !== null && mark?.size === size && now - mark.at >= CHANGE_CONFIRM_MS;
  const changed = d === "empty" || d === "other";
  if (size === null) {
    // Cannot tell: a change (seen now or before) stays suspected, timed from this look, and
    // the return starts over, so only later readable looks can confirm either.
    pending.back = null;
    if (changed || pending.change) pending.change = { at: now, size: null };
    return "wait";
  }
  if (changed) {
    pending.back = null;
    if (lasted(pending.change)) return "handover";
    if (pending.change?.size !== size) pending.change = { at: now, size };
    return "wait";
  }
  if (!pending.change) return "ok";
  if (d !== "notice") {
    pending.back = null; // too little seen, or nothing: no evidence either way
    return "wait";
  }
  if (lasted(pending.back)) {
    pending.change = null;
    pending.back = null;
    return "ok";
  }
  if (pending.back?.size !== size) pending.back = { at: now, size };
  return "wait";
}

/**
 * The injector loop (`relay`: {relayUrl, protocol, profile} of the session's settings): while
 * messages wait in `name`'s inbox, type the fixed notice into exactly
 * pane `pane` (e.g. "%3") while it still runs the original process `pid`, and press Enter.
 * It types only when the agent's prompt is recognizably empty, no approval prompt or transcript
 * selection is visible, the pane is not in a tmux mode and nobody typed for a few seconds;
 * otherwise it waits. Enter is pressed only while the prompt still shows the notice.
 * Messages stay in the inbox until the agent reads them.
 */
/**
 * What the injector announces for session `name` of `home`: the files of its store(s) that wait,
 * screened by the owner's contacts as the engine screens them (with the session's own member, so a
 * verified owner-channel message or, unless `self` is "hold", any message from the own member needs
 * no grant), and the messages the contacts hold for it ("held:" entries). Returns an async list().
 */
/**
 * Where the contacts hold a protocol-1 session's messages (the engine's holdDir): legacy/<name>, or
 * legacy/<scope>/<name> for a link of a session over several relays (its legacy home links/<scope>).
 */
function legacyHoldDir(home, legacyHome, name) {
  const scoped = path.dirname(path.resolve(legacyHome)) === path.join(path.resolve(home), "links");
  return scoped ? path.join(home, "legacy", path.basename(legacyHome), name) : path.join(home, "legacy", name);
}

export function noticeLister(home, name, relay, { self = envContactsSelf(process.env) } = {}) {
  // The receiving session's storage, resolved at each check; nothing to announce until it is known.
  let lastProblem = null;
  const pipes = new Map();
  let contacts = null;
  // A session over several relays (design 2.1) publishes every store it reads: announce for all.
  const composed = async () => {
    let doc;
    try {
      doc = JSON.parse(fs.readFileSync(path.join(home, "sessions", `${name}.stores.json`), "utf8"));
    } catch {
      return null;
    }
    contacts ??= await openContacts(home, { notify: false, self });
    const all = [];
    for (const s of doc.stores ?? []) {
      if (s.dir) {
        const b = { dir: s.dir, inbox: path.join(s.dir, "inbox"), seen: path.join(s.dir, "seen") };
        if (!pipes.has(s.dir)) pipes.set(s.dir, await openStore(b));
        const where = { realm: s.scope.realm, name: s.scope.folder };
        const entries = await pipes.get(s.dir).pending({ screen: contacts.screenFor(where, s.scope.member && s.scope.member !== "shared" ? s.scope.member : null) });
        all.push(...entries.map((f) => `${s.alias}/${f}`));
        // Messages the contacts hold for this session wake it too, once each (lib/notices.js).
        all.push(...heldEntries(contacts.heldFor({ store: s.dir })).map((f) => f.replace(/^held:/, `held:${s.alias}/`)));
      } else if (s.legacy) {
        all.push(...inbox.list({ legacy: true, home: s.legacy.home, name: s.legacy.name }).map((f) => `${s.alias}/${f}`));
        all.push(...heldEntries(contacts.heldFor({ store: legacyHoldDir(home, s.legacy.home, s.legacy.name) })).map((f) => f.replace(/^held:/, `held:${s.alias}/`)));
      }
    }
    return all;
  };
  const list = async () => {
    const c = await composed();
    if (c) return c;
    const r = resolveNameStore(home, name, relay);
    if (r.state === "invalid" && r.error !== lastProblem) console.log(new Date().toISOString(), "cannot find this session's messages:", (lastProblem = r.error));
    if (r.state === "bound") {
      // Through the session's store: its lock, recovery and lease expiry, and the owner's
      // contacts (messages the policy holds back are never announced).
      if (!pipes.has(r.store.dir)) pipes.set(r.store.dir, await openStore(r.store));
      contacts ??= await openContacts(home, { notify: false, self });
      const rel = storeParts(home, r.store.dir);
      // The own member too: a verified owner-channel message needs no grant (as in the engine).
      const where = { realm: rel[1], name: rel[3] };
      const entries = await pipes.get(r.store.dir).pending({ screen: contacts.screenFor(where, memberOfStoreDir(home, r.store.dir)) });
      // Messages the contacts hold for this session wake it too, once each (lib/notices.js).
      return [...entries, ...heldEntries(contacts.heldFor({ store: r.store.dir }))];
    }
    if (!r.store) return [];
    if (r.state !== "legacy") return inbox.list(r.store);
    contacts ??= await openContacts(home, { notify: false, self });
    return [...inbox.list(r.store), ...heldEntries(contacts.heldFor({ store: legacyHoldDir(home, home, name) }))];
  };
  return list;
}

/**
 * The injector's checks and its notice delivery for pane `pane` running `pid`, without its loop:
 * send({held, entries}) for a NoticeScheduler, paneAlive() and resetBlockedLog(). `run` (tmux,
 * returning stdout; throws on failure), `runStatus` (tmux, returning the exit status), `now` and
 * `wait` default to the real ones; tests pass stand-ins to play a screen and a clock.
 */
export function injector(pane, pid, { run = tmux, runStatus = (args) => tmuxRun(args).status, now = Date.now, wait = sleep } = {}) {
  const show = (format) => run(["display-message", "-p", "-t", pane, format]).trim();
  const paneAlive = () => {
    try {
      return show("#{pane_id} #{pane_pid} #{pane_dead}") === `${pane} ${pid} 0`;
    } catch {
      return false;
    }
  };
  const approvalVisible = () => {
    try {
      return APPROVAL_RE.test(bottomRows(run(["capture-pane", "-p", "-t", pane])).join("\n"));
    } catch {
      return true; // cannot see the screen: do not type
    }
  };
  /**
   * The last key time of any client attached to the pane's session, as tmux reports it (whole
   * seconds); -Infinity when none is attached. Throws when it cannot be read.
   */
  const lastKey = () => {
    const session = show("#{session_id}");
    const times = run(["list-clients", "-t", session, "-F", "#{client_activity}"]).split("\n").filter(Boolean);
    if (times.some((t) => !/^\d+$/.test(t))) throw new Error("unreadable client activity");
    return times.length ? Math.max(...times.map(Number)) : -Infinity;
  };
  const promptEmpty = () => {
    const [x, y, width] = show("#{cursor_x} #{cursor_y} #{pane_width}").split(" ").map(Number);
    if (y < 1) return false; // no room for the line above the input: not a layout we know
    const [above, line, below = ""] = run(["capture-pane", "-p", "-e", "-t", pane, "-S", String(y - 1), "-E", String(y + 1)]).replace(/\n$/, "").split("\n");
    return inputEmpty(above, line, below, x, width);
  };
  /** The first failing check of the ones that hold for any typing or Enter, or null. */
  const blocked = () => {
    try {
      if (!paneAlive()) return "pane";
      if (show("#{pane_in_mode}") !== "0") return "mode";
      if (now() / 1000 - lastKey() < IDLE_S) return "idle";
      const screen = run(["capture-pane", "-p", "-t", pane]);
      if (APPROVAL_RE.test(bottomRows(screen).join("\n"))) return "approval";
      if (selectionShown(screen)) return "selection";
      return null;
    } catch {
      return "unreadable";
    }
  };
  /** The name of the first failing ready() check, or null when the notice may be typed. */
  const ready = () => {
    const b = blocked();
    if (b) return b;
    try {
      return promptEmpty() ? null : "prompt";
    } catch {
      return "unreadable";
    }
  };
  /**
   * Is the notice still the prompt's draft, with the cursor at its end, and no selection or
   * approval prompt on screen? One capture and one cursor read, taken together, just before
   * Enter. This is evidence, not proof: the agent's screen can change between this look and
   * the Enter (a selection opened by a click in that moment still gets the Enter).
   * Returns {reason}: null when it holds, else why not; and {draft}: what the same capture shows
   * of the draft, by draftState ("notice", "partial", "other"), or null when an approval prompt,
   * a selection or a tmux mode is in the way or the screen cannot be read.
   */
  const PARTLY_VISIBLE = "a key arrived and the draft is not fully visible";
  const TOO_LITTLE = "too little of the draft is visible to verify it";
  /** `whole`: the whole draft must be on screen (after a key, the visible end proves too little). */
  const draftOwnsPrompt = (whole = false) => {
    try {
      const [x, y, mode, width] = show("#{cursor_x} #{cursor_y} #{pane_in_mode} #{pane_width}").split(" ").map(Number);
      if (mode !== 0) return { reason: "the pane is in a tmux mode", draft: null };
      const screen = run(["capture-pane", "-p", "-t", pane]);
      if (APPROVAL_RE.test(bottomRows(screen).join("\n"))) return { reason: "an approval prompt is visible", draft: null };
      if (selectionShown(screen)) return { reason: "the agent's transcript selection is open", draft: null };
      const rows = screen.replace(/\n$/, "").split("\n");
      const text = typedText();
      const draft = draftState(rows, y, text, width);
      const r = scanDraft(rows, x, y, text, width);
      if (r?.suffix && !r.complete && !promptHolds(rows, x, y, text, { width })) return { reason: TOO_LITTLE, draft };
      if (!promptHolds(rows, x, y, text, { width })) return { reason: "the prompt does not show the notice with the cursor at its end", draft };
      if (whole && !promptHolds(rows, x, y, text, { whole, width })) return { reason: PARTLY_VISIBLE, draft };
      return { reason: null, draft };
    } catch {
      return { reason: "cannot read the screen", draft: null };
    }
  };
  /** Did any attached client send a key since `typedAt` (or is that unknown)? */
  const keySince = (typedAt) => {
    try {
      // client_activity has whole seconds, so a key in the same second counts as typed after.
      return lastKey() >= Math.floor(typedAt);
    } catch {
      return true; // unknown: treat as typed
    }
  };

  /**
   * What the pane's draft shows now, wherever the cursor is: "notice" (still ours), "partial"
   * (the end of ours, too little visible to tell), "empty" (cleared or sent), "other" (a draft
   * that is not ours: changed), or null (an approval prompt, selection or tmux mode is in the
   * way, or the screen cannot be read). Only "empty" and "other" are evidence of a change.
   */
  const pendingDraft = () => {
    try {
      const [y, mode, width] = show("#{cursor_y} #{pane_in_mode} #{pane_width}").split(" ").map(Number);
      if (mode !== 0) return null;
      const screen = run(["capture-pane", "-p", "-t", pane]);
      if (APPROVAL_RE.test(bottomRows(screen).join("\n")) || selectionShown(screen)) return null;
      const d = draftState(screen.replace(/\n$/, "").split("\n"), y, typedText(), width);
      if (d !== "other") return d;
      return promptEmpty() ? "empty" : "other";
    } catch {
      return null;
    }
  };

  // A notice that was typed into the prompt but not submitted (null: none). While it is set,
  // nothing else is typed: the draft is submitted once it is safe, or left for a person.
  let pending = null;
  /** The fixed text typed for the pending notice: NOTICE, or HELD_NOTICE when only held messages were due. */
  const typedText = () => pending?.text ?? NOTICE;
  const blockedLog = new BlockedLog();

  /**
   * The person acted on the notice: a key arrived after the paste and the pane's draft is no
   * longer exactly the notice (they edited, cleared or sent it). It is never submitted or typed
   * again for them; it counts as an attempt, so the normal schedule goes on (a retry types a
   * new notice only into an empty prompt).
   */
  function handOver() {
    console.log(new Date().toISOString(), "notice typed but not submitted: the person changed the draft; left to them");
    // Only the files due when it was typed count: one that came later gets its own notice.
    const covered = pending.covered;
    pending = null;
    blockedLog.reset();
    return { covered };
  }

  /**
   * One look after a key: the pane's size (null: it cannot be read) decides with settleLook. The
   * first look that shows a change is logged (once per notice).
   */
  function settle(d) {
    let size = null;
    try {
      size = show("#{pane_width}x#{pane_height}");
    } catch {
      // cannot be read: settleLook keeps any suspicion and restarts the checks
    }
    const v = settleLook(pending, d, size, now());
    if (v === "wait" && (d === "empty" || d === "other")) notSubmitted("the draft changed after a key; checking that the change lasts");
    return v;
  }

  /** Log once per pending notice and reason why it was not submitted (no screen text). */
  const notSubmitted = (reason) => {
    if (pending.reported.has(reason)) return;
    pending.reported.add(reason);
    console.log(new Date().toISOString(), `notice typed but not submitted: ${reason}`);
  };

  /**
   * One guarded Enter for the pending notice, if no key arrived since `quietSince` (seconds) and
   * the prompt still shows it (`afterKey`: a key arrived since the paste, so all of it must show).
   * True when it was sent; after a key, a look that shows a changed draft counts (settle), and
   * the result of a handover when the change lasted.
   */
  function submit(how, quietSince, afterKey) {
    let reason = null;
    if (!paneAlive()) reason = "the agent's pane is gone";
    else if (keySince(quietSince)) reason = "a key arrived; waiting for a quiet moment";
    else {
      const look = draftOwnsPrompt(afterKey);
      reason = look.reason;
      if (reason && afterKey && settle(look.draft) === "handover") return handOver();
    }
    if (reason || !guarded(pane, pid, `send-keys -t ${pane} Enter`, { run, status: runStatus })) {
      notSubmitted(reason || "the agent's pane changed");
      return false;
    }
    pending = null;
    blockedLog.reset();
    console.log(new Date().toISOString(), how);
    return true;
  }

  /**
   * Type the notice and submit it. True when Enter was sent for it, or when the person took it
   * over (handOver). A notice left in the prompt for any other reason (an approval prompt or a
   * selection came up, a key arrived but the draft is still the notice, the prompt could not be
   * verified) is not a delivery: false, so the scheduler neither counts it as an attempt nor
   * moves on to the next retry, and resume() decides later.
   */
  async function send({ held = false, entries = [] } = {}) {
    if (pending) return resume({ held, entries });
    const text = held ? HELD_NOTICE : NOTICE;
    const why = ready();
    blockedLog.note(why);
    if (why) return false;
    const buffer = `hoptell-${crypto.randomBytes(4).toString("hex")}`;
    const typedAt = now() / 1000;
    try {
      run(["load-buffer", "-b", buffer, "-"], text);
      // -p: bracketed paste. Paste and Enter each run only while the pane still hosts the agent.
      if (!guarded(pane, pid, `paste-buffer -d -p -b ${buffer} -t ${pane}`, { run, status: runStatus })) return false;
    } catch (e) {
      runStatus(["delete-buffer", "-b", buffer]);
      console.error(new Date().toISOString(), "tmux error, retrying:", String(e.message).trim());
      return false;
    }
    pending = { typedAt, reported: new Set(), text, covered: [...entries] };
    await wait(400);
    for (let i = 0; i < 30 && paneAlive() && approvalVisible(); i++) await wait(1000);
    if (keySince(typedAt)) {
      const d = pendingDraft();
      // A change seen once is confirmed by resume() on a later check (settle).
      if (d === "empty" || d === "other") return settle(d) === "handover" ? handOver() : false;
    }
    return submit("submitted the inbox notice", typedAt, false);
  }

  /**
   * The notice was typed but not submitted.
   * - A key arrived since the paste and the draft is no longer the notice: the person has it
   *   (handOver).
   * - A key arrived but the draft is still exactly the notice (a key in another pane, or one
   *   that left the draft alone): once no key came for IDLE_S, it is submitted once, and only
   *   if the whole draft is on screen. A key may have changed hidden rows of a capped composer,
   *   so its visible end proves nothing then: it waits for a person.
   * - No key: once nothing blocks, an empty prompt (gone without a key, e.g. the agent cleared
   *   it) gets a new notice, and the notice itself is submitted once.
   * Anything else waits for a person. Unknown content is never cleared (no C-u, no Esc).
   */
  function resume(due) {
    const typed = keySince(pending.typedAt);
    if (typed) {
      const v = settle(pendingDraft());
      if (v === "handover") return handOver();
      if (v === "wait") {
        blockedLog.note("draft-pending (checking whether the draft changed)");
        return false; // unsettled: never submitted on this look, checked again next time
      }
    }
    let why = blocked(); // includes IDLE_S without a key
    if (!why) {
      if (!typed) {
        try {
          if (promptEmpty()) {
            pending = null;
            return send(due); // a new notice, for what is due now
          }
        } catch {
          // not readable: the checks below decide
        }
      }
      const { reason, draft } = draftOwnsPrompt(typed);
      // After a key, quiet means none since the idle check just passed (whole seconds).
      if (!reason) return submit("submitted the inbox notice that was left in the prompt", typed ? now() / 1000 - 1 : pending.typedAt, typed);
      notSubmitted(reason);
      // After a key this look counts too: a change it shows is recorded, so a later single look
      // at the notice (a stale frame) cannot submit it. A moved cursor alone is not a change.
      if (typed && settle(draft) === "handover") return handOver();
      why = reason === PARTLY_VISIBLE || reason === TOO_LITTLE ? `draft-pending (${reason})` : "draft-pending";
    }
    blockedLog.note(why);
    return false;
  }

  /**
   * One read of the pane for the waiting-session watch (lib/prompts.js createWatch), or null when
   * it cannot be read, is in a tmux mode or shows the agent's transcript selection. keyAt is the
   * end of the second of the last key (client_activity has whole seconds, so a key in the same
   * second as a change counts as after it), -Infinity with no client attached, or null unknown.
   */
  const look = () => {
    try {
      if (!paneAlive() || show("#{pane_in_mode}") !== "0") return null;
      const at = now(); // before the capture: a key after it is after what the screen shows
      const screen = run(["capture-pane", "-p", "-t", pane]);
      if (selectionShown(screen)) return null;
      let keyAt = null;
      try {
        const k = lastKey();
        keyAt = k === -Infinity ? k : (k + 1) * 1000 - 1;
      } catch {
        // unknown: never a stall
      }
      let inputShown = false;
      try {
        inputShown = promptEmpty();
      } catch {
        // not readable: no input box seen
      }
      return { screen, command: show("#{pane_current_command}"), keyAt, inputShown, at };
    } catch {
      return null;
    }
  };

  /** The tmux session id of the pane ("$3"), or null when it cannot be read. */
  const sessionId = () => {
    try {
      const id = show("#{session_id}");
      return /^\$\d{1,9}$/.test(id) ? id : null;
    } catch {
      return null;
    }
  };

  /** Is the pane in a mode (copy mode, a chooser)? true when it cannot be told. */
  const inMode = () => {
    try {
      return show("#{pane_in_mode}") !== "0";
    } catch {
      return true;
    }
  };
  /** No key from any attached client for IDLE_S (none attached: true); false when it cannot be told. */
  const keyIdle = () => {
    try {
      return now() / 1000 - lastKey() >= IDLE_S;
    } catch {
      return false;
    }
  };
  /**
   * Send tmux key names `keys` (["1"], ["Enter"]) to `target` ({socket, session, pane}: a prompt
   * manifest's), which must be this pane: on that tmux server only, and only while the pane runs
   * `pid` in that session. True when sent, false when not; throws when tmux gives no clear result.
   */
  const press = (keys, target) => {
    if (!Array.isArray(keys) || !keys.length || keys.some((k) => !/^([1-9]|Enter)$/.test(k))) throw new Error("not a key of the prompt table");
    const { socket, session } = target ?? {};
    if (target?.pane !== pane || !/^\$\d{1,9}$/.test(String(session)) || typeof socket !== "string" || !path.isAbsolute(socket)) return false;
    const on = (args) => ["-S", socket, ...args];
    return guarded(pane, pid, `send-keys -t ${q(pane)} ${keys.map(q).join(" ")}`, { run: (args) => run(on(args)), status: (args) => runStatus(on(args)), session });
  };

  return { pane, pid, send, paneAlive, look, sessionId, inMode, keyIdle, press, resetBlockedLog: () => blockedLog.reset() };
}

const GATE_WATCH_MS = 2000;

/** The agent CLI of a pane's current command, for the prompt table: "codex", "claude", "agy" or null. */
export const cliOfCommand = (c) => (/^(codex|claude|agy)$/.test(String(c)) ? String(c) : null);

/**
 * The waiting-session watch of `name` (design 9, A): every WATCH_MS a read of the pane through
 * `look`, classified and fed to the watcher; an occurrence that starts is kept as the session's
 * record (lib/waits.js) and given to `surface.start(rec)`, and its end to `surface.end(rec)`.
 * `owner()` is this injector's launch and pane ({tmux, pane, injector}), or null while it cannot be
 * read: nothing is kept until it can, and then a record that is not this injector's is removed
 * first. An occurrence whose record could not be written stays pending and is written again on
 * the next ticks while it holds. `unreadSince()` is when the oldest notice still unread was first
 * typed (null: none). Returns tick(), to call from the injector's loop, with close() that removes
 * this injector's record.
 */
export function waitWatch(home, name, { look, unreadSince, owner, surface = {}, stallMs, gate = null, now = Date.now }) {
  const watch = createWatch(stallMs ? { stallMs } : {});
  let next = 0;
  let rec = null;
  let pending = null; // an occurrence that holds and is not written yet
  let me = null;
  const stamp = (t) => new Date(t).toISOString();
  const tick = () => {
    const t = now();
    if (t < next) return null;
    // While the startup trust gate is armed the pane is read more often: the prompt comes first.
    next = t + (gate?.armed() ? GATE_WATCH_MS : WATCH_MS);
    if (!me) {
      me = owner();
      if (!me) return null;
      clearForeignOccurrence(home, name, me);
    }
    const r = look();
    // The launch record names the CLI while the gate is armed (Codex may run under node there).
    const cli = gate?.armed() ? "codex" : cliOfCommand(r?.command);
    const read = r && { ...r, prompt: classifyPrompt(r.screen, { cli, version: gate?.version() ?? null }), unreadSince: unreadSince() };
    // The startup trust gate holds only while every read since the launch showed its dialog
    // (lib/startgate.js): readiness, anything else on the screen or a gap ends it for good.
    gate?.observe(read);
    // A read that ended it is display-only too.
    if (read?.prompt?.actionable && !gate?.armed()) read.prompt = classifyPrompt(r.screen, { cli, version: null });
    const ev = watch.feed(read);
    if (ev.end) {
      pending = null;
      if (rec) {
        closeOccurrence(home, name, rec.nonce);
        const ended = rec;
        rec = null;
        surface.end?.(ended);
      }
    }
    if (ev.start) pending = ev.start;
    if (pending) {
      try {
        rec = openOccurrence(home, name, pending, { owner: me, now });
        const started = pending;
        pending = null;
        console.log(stamp(t), `the session waits: ${waitLine(rec, t)}`);
        surface.start?.(rec, started);
      } catch (e) {
        console.error(stamp(t), "the waiting state could not be kept (tried again):", String(e.message).trim());
      }
    }
    return ev;
  };
  tick.close = () => {
    pending = null;
    if (rec) closeOccurrence(home, name, rec.nonce);
    rec = null;
  };
  return tick;
}

/**
 * The owner of the records an injector of `pane` writes (lib/waits.js): a function that returns
 * {tmux, pane, injector} or null while the tmux session id or this process's identity cannot be
 * read. Each call reads again what is still unknown (waitWatch calls it at most once a tick); only
 * an identity that was read is kept.
 */
export function injectorOwner(pane, { sessionId, identity = () => processIdentity(process.pid) }) {
  let self = null;
  return () => {
    self ??= identity();
    const tmuxId = self && sessionId();
    return tmuxId ? { tmux: tmuxId, pane, injector: self } : null;
  };
}

/**
 * Where an occurrence of session `name` is told (design 9, B), through its control connection
 * (lib/control.js): a team member's lead gets one inbox message per occurrence with the attach
 * command; the owner's bridge gets a note within the home's budget (lib/waits.js ownerBudget),
 * worded by the bridge, never with screen text. `team`: {team, lead} or null; `folder`: the last
 * part of the session's folder, for the note. `cards` (lib/promptflow.js): the startup prompt it
 * can answer goes to the owner as a card with buttons instead of the note (design 9, C).
 */
export function waitSurface(home, name, { control, team = null, folder = null, cards = null, now = Date.now }) {
  return {
    start(rec, started = null) {
      const t = now();
      if (team?.lead) {
        const text = `hoptell: automated notice, not a user message. ${name} (team ${team.team}) needs a look: ${waitLabel(rec, t)} (${rec.id}). Attach: tmux attach -t '=${sessionFor(name)}'`;
        Promise.resolve(control.tell(team.lead, text)).catch(() => {});
      }
      const note = () => {
        const v = ownerBudget(home, name, rec, { now });
        if (v === "send") return control.note(waitNoteText(rec, { session: name, team: team?.team ?? null, folder, now: t }));
        if (v === "summary") return control.note(waitNoteText(null, { session: name }));
      };
      if (cards && started?.prompt) Promise.resolve(cards.publish(rec, started.prompt, started.since)).then((card) => (card ? null : note())).catch(() => {});
      else Promise.resolve(note()).catch(() => {});
    },
  };
}

export async function inject(name, pane, pid, { home, relay, stallMinutes = null, surface = {} }) {
  checkName(name);
  if (!/^%\d+$/.test(pane || "") || !/^\d+$/.test(pid || "")) throw new Error("usage: hoptell inject <name> <tmux pane id> <pane pid>");
  const ij = injector(pane, pid);
  const { send, paneAlive, look, sessionId, inMode, keyIdle, press, resetBlockedLog } = ij;
  console.log(`hoptell injector: announcing messages for "${name}" in pane ${pane}`);
  const list = noticeLister(home, name, relay);
  // The blocked log starts over when nothing waits. It only sees the checks the scheduler asks
  // for: between retries of messages already announced nothing is checked.
  // While messages wait, the time is kept for the team supervisor's idle check (design 8, 3.4):
  // it reads only this file's time, never the messages.
  const activity = activityFileOf(home, name);
  const listed = async () => {
    const files = await list();
    if (!files.length) resetBlockedLog();
    else {
      try {
        fs.writeFileSync(activity, "", { mode: 0o600 });
        fs.utimesSync(activity, new Date(), new Date());
      } catch {}
    }
    return files;
  };
  const scheduler = new NoticeScheduler({ list: listed, send });
  // The oldest notice typed and still unread (its file still waits): the scheduler's first try.
  const unreadSince = () => {
    const firsts = [...scheduler.state.values()].map((v) => v.first).filter(Number.isFinite);
    return firsts.length ? Math.min(...firsts) : null;
  };
  const owner = injectorOwner(pane, { sessionId });
  let socket = null;
  try {
    socket = tmux(["display-message", "-p", "-t", pane, "#{socket_path}"]).trim() || null;
  } catch {}
  const gate = startGate(home, name, { pane, pid, session: sessionId(), socket, log: (l) => console.log(new Date().toISOString(), l) });
  if (gate.armed()) console.log(new Date().toISOString(), `the startup trust gate of this launch is armed (Codex ${gate.version()})`);
  // Notices are held back while a prompt answer runs: hold(fn) waits for a notice being typed now.
  let held = 0;
  let ticking = Promise.resolve();
  const hold = async (fn) => {
    held++;
    try {
      await ticking;
      return await fn();
    } finally {
      held--;
    }
  };
  // `surface` may be made from the gate and the pane's operations (the startup prompt's card
  // publisher and the owner's answer need them). Its tick() runs on every turn of the loop (a
  // prompt result not reported yet), and drain() once the pane is gone (for a short while).
  const ops = { pane: ij.pane, pid: ij.pid, look, paneAlive, inMode, keyIdle, press };
  const surfaces = typeof surface === "function" ? surface(gate, { ops, hold }) : surface;
  const watching = waitWatch(home, name, { look, unreadSince, owner, surface: surfaces, gate, stallMs: stallMinutes ? stallMinutes * 60_000 : undefined });
  try {
    while (paneAlive()) {
      if (!held) {
        ticking = scheduler.tick().catch(() => {});
        await ticking;
      }
      watching();
      Promise.resolve(surfaces.tick?.()).catch(() => {});
      await sleep(500);
    }
  } finally {
    watching.close(); // the pane is gone: it waits on nothing
    if (surfaces.drain) await Promise.race([Promise.resolve(surfaces.drain()).catch(() => {}), sleep(5000)]);
  }
  console.log("hoptell injector: agent pane is gone; messages stay in the inbox");
}
