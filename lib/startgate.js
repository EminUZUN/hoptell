// The startup folder-trust gate of a Codex, Claude Code or agy launch (design 9, C, with the v2
// correction 4 and the owner's decision of 29 October 2026; design 10, trust buttons): tied to one
// launch hoptell started and to the injector's unbroken view of it, not to a screen regex alone;
// it samples the startup, it does not prove it (the limit is below). `hoptell tmux` writes a
// launch record, sessions/<name>.launch.json, when it starts a session:
//   {v: 1, id, cli: {name, path, version} | null, folder, root, scope, built, tmux: {socket,
//    session, pane}, host: {pid, start, uid, boot} | null, untested, started,
//    gate: {state: "armed" | "off", why, at}}
// It is written before the session's injector starts. `untested` is the launch's test switch
// (HOPTELL_PROMPT_UNTESTED=1 for `hoptell tmux`, for the owner's live check only): the prompt's
// options not checked live yet are shown on the card and pressed too (lib/promptcards.js). The
// gate is armed only for a fresh interactive launch of one of the three CLIs (launchGate: only
// the words its fresh rules allow) whose executable hoptell resolved and asked its version (any
// verified version: the dialog must match the prompt table exactly, lib/prompts.js), with the folder whose trust the
// dialog records (`root`: Codex's and Claude Code's is the repository's main folder, also from a
// linked worktree, or the launch folder outside a repository; agy's is the launch folder) and,
// for Claude Code and agy, what that covers (`scope`: lib/promptcards.js SCOPE_KINDS). The agent
// then runs that very executable. A team member's launch (hoptell team up and restart) carries
// `built`, what lib/teams.js memberCommand made it from: its CLI and mode, and the digest of its
// words.
//
// The injector of that pane takes the record, and only when the tmux server, the session, the
// pane and the agent's process ({pid, start, uid, boot}) are all the recorded ones, and only by
// creating its claim first: sessions/<name>.launch.claim, created exclusively (O_EXCL) with the
// launch id, the pane and pid, and the injector's own process identity. Exactly one injector can
// ever create it; it is removed only by the next launch, together with the record. A claim that
// exists (a restart, or a second injector) makes the launch notification-only for good. A claim
// that cannot be written makes it notification-only for that injector; if it also cannot write
// the off state, another injector started within FIRST_READ_MS of the launch can still make the
// first successful claim once storage recovers. A record still unclaimed FIRST_READ_MS after the
// launch is off for any injector.
//
// While the gate is armed, the folder-trust prompt can be answerable. The gate is a continuity
// rule over the injector's reads (observe): it stays armed only while (the dialog: the launch
// CLI's startup trust subtype, lib/promptcards.js ANSWERABLE_OF)
//   - the injector's first read came within FIRST_READ_MS of the launch, and the trust dialog
//     within DIALOG_MS (blank screens before it: Codex still drawing);
//   - the first screen that shows anything is that dialog, naming the launch's folder as that CLI
//     shows it (Codex: `root`; Claude Code and agy: the launch folder);
//   - every read since shows the same dialog (`frame`: whichever row is selected): any other
//     screen (transcript, another prompt, a blank screen) ends it, and so does Codex's input box
//     or work under way in any read, even one whose captured text still shows the dialog (the
//     input rows are sampled after the screen);
//   - no two successful reads are more than GAP_MS apart (a sleep, a stalled tmux, a failed read);
//   - and at the latest START_MS + CARD_MS after the launch.
// Once off, it is off for good, in the record. armed() reads the record and the claim again each
// time: off in the record, another launch, or a claim that is not this injector's is off.
//
// The limit (the owner's decision of 29 October 2026: this sampled start model is accepted): the
// injector sees the pane in snapshots, so none of this proves what Codex did between them, nor
// that it is still starting up. A Codex that was already past its startup prompt before the first
// read (a folder trusted earlier) and then shows text that looks exactly like the dialog, with
// the launch's folder and nothing else on the screen, passes every check: a tap then types a stray
// "1" and Enter, or "2", into the session. Arming the gate authorizes nothing: only the owner's
// tap on a card sends keys, and what those keys do then is up to the program on the screen.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { checkName, ensurePrivateDir } from "./config.js";
import { writeRecord } from "./locks.js";
import { findGit } from "./gitsafe.js";
import { identityState, processIdentity } from "./host.js";
import { ANSWERABLE_OF, CARD_MS, START_MS, answerableOptions } from "./promptcards.js";
import { busyShown } from "./prompts.js";

const RECORD_MAX = 16 * 1024;
const VERSION_TIMEOUT_MS = 5000;
export const FIRST_READ_MS = 15_000;
export const DIALOG_MS = 30_000;
// What a CLI may draw before its trust dialog, every non-blank row (live capture of agy 1.4.12 on
// 31 October 2026: its logo, then "Signing in..." for a moment): the gate takes it as still
// drawing, like a blank screen. Anything else before the dialog turns the gate off.
const SPLASH = Object.freeze({
  agy: Object.freeze([/^ *[▄▀ ]+$/, /^ Welcome to the Antigravity CLI\.( You are currently not signed in\.)?$/, /^ [⠀-⣿] {2}Signing in\.\.\.$/]),
});
const splashShown = (cli, screen) => {
  const rows = String(screen ?? "").split("\n").map((r) => r.replace(/\s+$/, "")).filter(Boolean);
  const res = Object.hasOwn(SPLASH, cli) ? SPLASH[cli] : null;
  return Boolean(res) && rows.length > 0 && rows.some((r) => res[1].test(r)) && rows.every((r) => res.some((re) => re.test(r)));
};
export const GAP_MS = 5000; // about twice the armed watch's 2 s
const isAbs = (x) => typeof x === "string" && x.length > 0 && x.length <= 4096 && path.isAbsolute(x) && !/[\0\n\r]/.test(x);

// The fresh interactive launch the prompt table was recorded on: `codex` with only these flags,
// none of which changes the folder or the session (a value as the next word, or after "="), and
// at most one prompt, as the last word (a team member's launch: lib/roles.js). `-c`/`--config`
// only for the keys of FRESH_CONFIG, which set the model and its instructions, never a folder,
// trust or project setting; the live check of 30 October 2026 (0.165.0) showed the same startup
// dialog with a prompt and -c model_reasoning_effort. A subcommand (resume, exec, ...), a word
// that could be one, -C/--cd, -p, a second prompt, any other -c key or any other flag:
// notification-only.
const FRESH_VALUE = new Set(["-s", "--sandbox", "-a", "--ask-for-approval", "-m", "--model"]);
const FRESH_BOOL = new Set(["--full-auto", "--dangerously-bypass-approvals-and-sandbox"]);
const FRESH_CONFIG = new Set(["model_reasoning_effort", "model", "developer_instructions"]);
const SUBCOMMAND_LIKE = /^[A-Za-z0-9_-]+$/;

/** Why `-c` value `kv` is not one a fresh launch may carry, or null. */
function configProblem(kv) {
  const eq = String(kv).indexOf("=");
  if (eq <= 0) return "-c without key=value";
  const key = String(kv).slice(0, eq);
  return FRESH_CONFIG.has(key) ? null : `the setting -c ${key.slice(0, 40)}`;
}

/** Why `args` (after the executable) is not a fresh interactive launch of Codex, or null when it is. */
export function freshProblem(args) {
  for (let i = 0; i < args.length; i++) {
    const a = String(args[i]);
    if (FRESH_BOOL.has(a)) continue;
    if (FRESH_VALUE.has(a)) {
      if (i + 1 >= args.length) return `${a} without a value`;
      i++;
      continue;
    }
    if (a === "-c" || a === "--config") {
      if (i + 1 >= args.length) return `${a} without a value`;
      const why = configProblem(args[++i]);
      if (why) return why;
      continue;
    }
    if (a.startsWith("--config=")) {
      const why = configProblem(a.slice("--config=".length));
      if (why) return why;
      continue;
    }
    const eq = a.indexOf("=");
    if (a.startsWith("--") && eq > 2 && FRESH_VALUE.has(a.slice(0, eq))) continue;
    if (/^(-C|--cd)(=|$)/.test(a) || /^-C./.test(a)) return "another folder (-C/--cd)";
    if (!a.startsWith("-")) {
      // The prompt: the last word only, and never one that could be a subcommand.
      if (i !== args.length - 1) return "a subcommand or a prompt before other words";
      if (!a.trim() || SUBCOMMAND_LIKE.test(a)) return "a subcommand or a one-word prompt";
      continue;
    }
    return `the flag ${a.split("=")[0].slice(0, 40)}`;
  }
  return null;
}

// The prompt: the last word only, and never one that could be a subcommand.
const promptProblem = (a, i, args) => {
  if (i !== args.length - 1) return "a subcommand or a prompt before other words";
  return !a.trim() || SUBCOMMAND_LIKE.test(a) ? "a subcommand or a one-word prompt" : null;
};

// The tools a Claude Code team member calls without a permission prompt (lib/teams.js
// memberCommand: --allowedTools, one argument): the hoptell messaging tools of a run (lib/mcp.js
// RUN_TOOLS; test/startgate.test.js checks the two) and the read-only check_snapshot and read_diff
// of a local session, under both ids Claude Code gives them, a plugin install's and a `claude mcp add
// hoptell` or .mcp.json one's. Never a file-sending, agent or owner tool, a wildcard or the
// whole server.
const MEMBER_TOOLS = ["list_peers", "send_message", "wait_for_message", "read_inbox", "ack_messages", "read_task", "check_snapshot", "read_diff"];
export const MEMBER_ALLOWED_TOOLS = ["mcp__plugin_hoptell_hoptell__", "mcp__hoptell__"].flatMap((p) => MEMBER_TOOLS.map((t) => p + t)).join(",");
// The Claude Code reviewer preset's --disallowedTools (presets/roles.json): no file-editing tool.
// Plan mode is not used: Claude Code 2.1.316 runs only read-only tools there, --allowedTools or
// not, so a reviewer could not reply with send_message without a prompt each time.
export const NO_EDIT_TOOLS = "Edit,Write,NotebookEdit";

// Claude Code's fresh launch (design 10, trust buttons): a team member's line (lib/teams.js
// memberCommand: the role's --permission-mode, --model, --effort, --append-system-prompt and the
// prompt), with the conversation's --session-id and -n of a team launch (Part R of the
// containment and resume design). `--session-id` only as `built.session_id`, the id hoptell assigned
// for this launch (a hand-typed one may name a conversation that exists: a resume in effect); `-n`
// only with the session's own name. Anything else, a resume or a continue among them:
// notification-only. `--allowedTools` only with MEMBER_ALLOWED_TOOLS and `--disallowedTools` only
// with NO_EDIT_TOOLS, each before another option (they take several values: before the prompt
// they would take the prompt too).
const CLAUDE_VALUE = new Set(["--permission-mode", "--model", "--effort", "--append-system-prompt", "--session-id", "-n", "--name", "--allowedTools", "--disallowedTools"]);
const CLAUDE_MODES = new Set(["plan", "acceptEdits", "manual", "default"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Why `args` is not a fresh interactive launch of Claude Code, or null when it is. */
export function claudeFreshProblem(args, { built = null, name = null } = {}) {
  for (let i = 0; i < args.length; i++) {
    const a = String(args[i]);
    const eq = a.startsWith("--") ? a.indexOf("=") : -1;
    const flag = eq > 2 ? a.slice(0, eq) : a;
    if (CLAUDE_VALUE.has(flag)) {
      let v;
      if (eq > 2) v = a.slice(eq + 1);
      else if (i + 1 >= args.length) return `${a} without a value`;
      else v = String(args[++i]);
      if (flag === "--permission-mode" && !CLAUDE_MODES.has(v)) return `--permission-mode ${v.slice(0, 40)}`;
      if (flag === "--session-id" && !(typeof built?.session_id === "string" && UUID_RE.test(v) && v === built.session_id)) return "a --session-id hoptell did not assign to this launch";
      if ((flag === "-n" || flag === "--name") && v !== name) return "another session name";
      if (flag === "--allowedTools" && (v !== MEMBER_ALLOWED_TOOLS || !String(args[i + 1] ?? "").startsWith("-"))) return "an --allowedTools list hoptell did not build";
      if (flag === "--disallowedTools" && (v !== NO_EDIT_TOOLS || !String(args[i + 1] ?? "").startsWith("-"))) return "a --disallowedTools list hoptell did not build";
      continue;
    }
    if (!a.startsWith("-")) {
      const why = promptProblem(a, i, args);
      if (why) return why;
      continue;
    }
    return `the flag ${flag.slice(0, 40)}`;
  }
  return null;
}

// agy's fresh launch: the reviewer preset's line (--mode, --sandbox, --dangerously-skip-permissions,
// --model), with no prompt (hoptell team types it after the dialog: lib/roles.js templateArgs) or
// a prompt as -i's value; no other word.
const AGY_VALUE = new Set(["--mode", "--model", "-i", "--prompt-interactive"]);
const AGY_BOOL = new Set(["--sandbox", "--dangerously-skip-permissions"]);
const AGY_MODES = new Set(["accept-edits", "auto", "plan"]);

/** Why `args` is not a fresh interactive launch of agy, or null when it is. */
export function agyFreshProblem(args) {
  for (let i = 0; i < args.length; i++) {
    const a = String(args[i]);
    if (AGY_BOOL.has(a)) continue;
    const eq = a.startsWith("--") ? a.indexOf("=") : -1;
    const flag = eq > 2 ? a.slice(0, eq) : a;
    if (AGY_VALUE.has(flag)) {
      let v;
      if (eq > 2) v = a.slice(eq + 1);
      else if (i + 1 >= args.length) return `${a} without a value`;
      else v = String(args[++i]);
      if (flag === "--mode" && !AGY_MODES.has(v)) return `--mode ${v.slice(0, 40)}`;
      continue;
    }
    return a.startsWith("-") ? `the flag ${flag.slice(0, 40)}` : "a subcommand or another word";
  }
  return null;
}

const FRESH = { codex: (args) => freshProblem(args), claude: claudeFreshProblem, agy: (args) => agyFreshProblem(args) };
export const GATE_CLIS = Object.freeze(Object.keys(FRESH));
export const BUILT_MODES = Object.freeze(["fresh", "restart-fresh", "resume"]);

export const launchFileOf = (home, name) => path.join(home, "sessions", `${checkName(name)}.launch.json`);
export const claimFileOf = (home, name) => path.join(home, "sessions", `${checkName(name)}.launch.claim`);
const CLAIM_MAX = 4096;

/** Create `file` exclusively with `text`, durably; throws when it exists or cannot be written (a partial file stays: a fence). */
function createExclusive(file, text) {
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
  try {
    fs.writeSync(fd, text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  const d = fs.openSync(path.dirname(file), "r");
  try {
    fs.fsyncSync(d);
  } finally {
    fs.closeSync(d);
  }
}

/** The claim's text, or null when there is none or it cannot be read. */
function readClaim(file) {
  try {
    const st = fs.lstatSync(file);
    return st.isFile() && st.size <= CLAIM_MAX ? fs.readFileSync(file, "utf8") : null;
  } catch {
    return null;
  }
}

/** The executable `cmd0` names, as an absolute path (searched on `envPath` when it has no slash), or null. */
export function resolveCli(cmd0, { envPath = "", cwd }) {
  const ok = (p) => {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  };
  if (typeof cmd0 !== "string" || !cmd0) return null;
  if (cmd0.includes("/")) {
    const p = path.resolve(cwd, cmd0);
    return ok(p) ? p : null;
  }
  for (const dir of String(envPath).split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir)) continue; // a relative entry would depend on the folder
    const p = path.join(dir, cmd0);
    if (ok(p)) return p;
  }
  return null;
}

// What `--version` prints, exactly: Codex "codex-cli 0.165.0", Claude Code "2.1.314 (Claude
// Code)", agy "1.4.11".
const VERSION_RE = {
  codex: /^codex-cli (\d{1,4}\.\d{1,4}\.\d{1,4})\s*$/,
  claude: /^(\d{1,4}\.\d{1,4}\.\d{1,4}) \(Claude Code\)\s*$/,
  agy: /^(\d{1,4}\.\d{1,4}\.\d{1,4})\s*$/,
};

/** The version of CLI `cli` from `<file> --version`, or null when it cannot be told. */
export function cliVersion(file, { env, cli = "codex", run = execFileSync }) {
  try {
    const out = run(file, ["--version"], { encoding: "utf8", env, timeout: VERSION_TIMEOUT_MS, stdio: ["ignore", "pipe", "ignore"] });
    const m = Object.hasOwn(VERSION_RE, cli) ? String(out).match(VERSION_RE[cli]) : null;
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/** Codex's version from `<file> --version` ("codex-cli 0.165.0"), or null when it cannot be told. */
export const codexVersion = (file, { env, run = execFileSync }) => cliVersion(file, { env, cli: "codex", run });

/**
 * The folder Codex asks about when it starts in `folder`: the main folder of its git repository
 * (the parent of the shared .git folder, also from a linked worktree), or `folder` itself outside
 * a repository; real paths. null when it cannot be told.
 */
export function trustRootOf(folder, { envPath = "", home = "" } = {}) {
  let real;
  try {
    real = fs.realpathSync(folder);
  } catch {
    return null;
  }
  const git = findGit(envPath);
  if (!git) return null;
  let out;
  try {
    out = execFileSync(git, ["-C", real, "rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8", env: { PATH: envPath, HOME: home, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" }, timeout: VERSION_TIMEOUT_MS, stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (e) {
    // Not a repository (git says so on stderr): the launch folder.
    return /not a git repository/i.test(String(e.stderr ?? "")) ? real : null;
  }
  if (!isAbs(out) || path.basename(out) !== ".git") return null; // a bare or unusual layout: not told
  try {
    return fs.realpathSync(path.dirname(out));
  } catch {
    return null;
  }
}

/**
 * What the trust of CLI `cli` started in `folder` covers: {root, kind}, or null when it cannot be
 * told. Codex: `root` (trustRootOf), no kind. Claude Code: `root` likewise (its source, 2.1.314:
 * the canonical git root), and the kind: `repo-member` when that is not the folder itself (a
 * linked worktree or a subfolder), `repo` for a repository's main folder, `folder` outside a
 * repository, and `home` for the home folder itself (Claude Code keeps that trust for the session
 * only: no buttons). agy: the launch folder (as far as its trusted list shows), kind `folder`.
 */
export function trustScopeOf(cli, folder, { envPath = "", home = "", root = trustRootOf } = {}) {
  let real;
  try {
    real = fs.realpathSync(folder);
  } catch {
    return null;
  }
  if (cli === "agy") return { root: real, kind: "folder" };
  const r = root(folder, { envPath, home });
  if (!r) return null;
  if (cli === "codex") return { root: r, kind: null };
  let realHome = null;
  try {
    realHome = home ? fs.realpathSync(home) : null;
  } catch {}
  if (real === realHome) return { root: r, kind: "home" };
  if (r !== real) return { root: r, kind: "repo-member" };
  let git = null;
  try {
    git = fs.lstatSync(path.join(real, ".git"));
  } catch {}
  return { root: r, kind: git?.isDirectory() ? "repo" : "folder" };
}

/** `built` (lib/teams.js memberCommand) as the launch record keeps it: {cli, mode, argv: its digest}. */
const builtRecord = (b) => (b ? { cli: b.cli, mode: b.mode, argv: crypto.createHash("sha256").update(JSON.stringify(b.argv)).digest("hex") } : null);

/** Is `b` a builder's account of a launch: {cli, mode, argv, session_id}? */
function builtOk(b) {
  const keys = ["cli", "mode", "argv", "session_id"];
  return b !== null && typeof b === "object" && !Array.isArray(b) && Object.keys(b).length === keys.length && keys.every((k) => Object.hasOwn(b, k)) && GATE_CLIS.includes(b.cli) && BUILT_MODES.includes(b.mode) && Array.isArray(b.argv) && b.argv.length > 0 && b.argv.every((x) => typeof x === "string") && (b.session_id === null || typeof b.session_id === "string");
}

/**
 * What a launch of `cmd` in `folder` knows before it starts: {cli, root, scope, built, gate, argv}.
 * The CLI is told by the command's name (`codex`, `claude` or `agy`: a wrapper in front, such as
 * env or a shell, is none of them), or, for a team member's launch, by `built` (lib/teams.js
 * memberCommand: {cli, mode, argv, session_id}), whose words `cmd` must be exactly, and whose mode
 * must be a fresh start (a resumed conversation: notification-only). The executable is resolved on
 * the caller's PATH and asked its version; on a version the prompt table has, the gate is armed
 * and `argv` runs that executable by its absolute path, so the agent is the program that was
 * asked. Anything else: the gate is off, and `argv` is `cmd` unchanged. `name`: the session's
 * name (Claude Code's -n must be it).
 */
export function launchGate(cmd, { folder, env, built = null, name = null, now = Date.now, version = cliVersion, root = trustRootOf }) {
  const record = built && builtOk(built) ? builtRecord(built) : null;
  const off = (why, cli = null) => ({ cli, root: null, scope: null, built: record, gate: { state: "off", why, at: now() }, argv: [...cmd] });
  if (built !== null && !builtOk(built)) return off("not the launch hoptell built");
  let cliName = path.basename(String(cmd[0] ?? ""));
  if (built) {
    if (cmd.length !== built.argv.length || cmd.some((w, i) => w !== built.argv[i]) || cliName !== built.cli) return off("not the launch hoptell built");
    if (built.mode === "resume") return off("a resumed conversation");
    cliName = built.cli;
  }
  if (!GATE_CLIS.includes(cliName)) return off("not codex, claude or agy");
  const fresh = FRESH[cliName](cmd.slice(1), { built, name });
  if (fresh) return off(`not a fresh interactive launch: ${fresh}`);
  const file = resolveCli(cmd[0], { envPath: env.PATH ?? "", cwd: folder });
  if (!file) return off(`${cliName} not found`);
  const v = version(file, { env: { PATH: env.PATH ?? "", HOME: env.HOME ?? "" }, cli: cliName });
  const cli = { name: cliName, path: file, version: v };
  if (!v) return off("version unknown", cli);
  if (!answerableOptions(v, cliName).length) return off("version not recorded", cli);
  const sc = trustScopeOf(cliName, folder, { envPath: env.PATH ?? "", home: env.HOME ?? "", root });
  if (!sc) return off("folder unknown", cli);
  if (sc.kind === "home") return off("the home folder (Claude Code trusts it for the session only)", cli);
  return { cli, root: sc.root, scope: sc.kind, built: record, gate: { state: "armed", why: null, at: now() }, argv: [file, ...cmd.slice(1)] };
}

/** A new launch's id: lib/tmux.js launch makes it before the agent's pane starts, for its prompt-wait. */
export const newLaunchId = () => crypto.randomBytes(16).toString("hex");

/**
 * Write the launch record of session `name` (lib/tmux.js launch, once the agent's pane started and
 * before its injector does). `host` is the agent's process identity (lib/host.js), null when it
 * could not be read: the gate is then off.
 */
export function writeLaunch(home, name, { id = newLaunchId(), cli, root, scope = null, built = null, gate, folder, tmux, host, untested = false, now = Date.now }) {
  const g = gate.state === "armed" && !tmux.socket ? { state: "off", why: "tmux server unknown", at: now() } : gate.state === "armed" && !host ? { state: "off", why: "process unknown", at: now() } : gate;
  if (!/^[0-9a-f]{32}$/.test(String(id))) throw new Error("not a launch id");
  const rec = { v: 1, id, cli, folder, root, scope, built, tmux, host, untested: untested === true, started: now(), gate: g };
  ensurePrivateDir(path.join(home, "sessions"));
  writeRecord(launchFileOf(home, name), rec);
  return rec;
}

/** The folder the launch's trust dialog names: Codex the folder it trusts, Claude Code and agy the launch folder. */
export const shownFolder = (launch) => (launch.cli?.name === "codex" ? launch.root : launch.folder);

/** The launch record `r` checked, or null. */
function checked(r) {
  const plain = (o, keys) => o !== null && typeof o === "object" && !Array.isArray(o) && Object.keys(o).length === keys.length && keys.every((k) => Object.hasOwn(o, k));
  if (!plain(r, ["v", "id", "cli", "folder", "root", "scope", "built", "tmux", "host", "untested", "started", "gate"]) || r.v !== 1) return null;
  if (typeof r.id !== "string" || !/^[0-9a-f]{32}$/.test(r.id)) return null;
  if (!(r.cli === null || (plain(r.cli, ["name", "path", "version"]) && GATE_CLIS.includes(r.cli.name) && isAbs(r.cli.path) && (r.cli.version === null || typeof r.cli.version === "string")))) return null;
  if (!isAbs(r.folder) || !(r.root === null || isAbs(r.root))) return null;
  if (!(r.scope === null || ["folder", "repo", "repo-member"].includes(r.scope))) return null;
  if (!(r.built === null || (plain(r.built, ["cli", "mode", "argv"]) && GATE_CLIS.includes(r.built.cli) && BUILT_MODES.includes(r.built.mode) && /^[0-9a-f]{64}$/.test(String(r.built.argv))))) return null;
  if (!plain(r.tmux, ["socket", "session", "pane"]) || !(r.tmux.socket === null || isAbs(r.tmux.socket)) || !/^\$\d{1,9}$/.test(String(r.tmux.session)) || !/^%\d{1,9}$/.test(String(r.tmux.pane))) return null;
  const h = r.host;
  if (!(h === null || (plain(h, ["pid", "start", "uid", "boot"]) && Number.isSafeInteger(h.pid) && h.pid >= 2 && typeof h.start === "string" && h.start && Number.isSafeInteger(h.uid) && typeof h.boot === "string"))) return null;
  if (typeof r.untested !== "boolean" || !Number.isSafeInteger(r.started)) return null;
  if (!plain(r.gate, ["state", "why", "at"]) || !["armed", "off"].includes(r.gate.state) || !Number.isSafeInteger(r.gate.at)) return null;
  // Armed only with what arming needs.
  if (r.gate.state === "armed" && !(r.cli?.version && r.root && r.tmux.socket && r.host && (r.cli.name === "codex" ? r.scope === null : r.scope !== null))) return null;
  return r;
}

/** Session `name`'s launch record, or null (none, or not one). */
export function readLaunch(home, name) {
  try {
    const st = fs.lstatSync(launchFileOf(home, name));
    if (!st.isFile() || st.size > RECORD_MAX) return null;
    return checked(JSON.parse(fs.readFileSync(launchFileOf(home, name), "utf8")));
  } catch {
    return null;
  }
}

// When the agent of a `hoptell tmux` session exits, its window runs `hoptell prompt-wait <name>
// <launch> <status>` (lib/tmux.js agentCommand) before the session ends: that writes the note
// sessions/<name>.exited, {launch, status, at}, only while the record there is that launch's (a
// late one of an earlier launch whose name was reused writes nothing). The window's
// shell (the launch record's process) outlives the agent, so this note is how the injector sees
// that the agent ended (lib/promptexec.js, after a Quit).
export const exitFileOf = (home, name) => path.join(home, "sessions", `${checkName(name)}.exited`);

/** Note that launch `launch` of session `name` ended with exit status `status` ("0" to "255"; else null). Never throws. */
export function writeExit(home, name, launch, status, { now = Date.now } = {}) {
  try {
    const rec = readLaunch(home, name);
    if (!rec || !/^[0-9a-f]{32}$/.test(String(launch)) || rec.id !== launch) return false;
    const st = /^\d{1,3}$/.test(String(status)) && Number(status) <= 255 ? Number(status) : null;
    writeRecord(exitFileOf(home, name), { launch: rec.id, status: st, at: now() });
    return true;
  } catch {
    return false;
  }
}

/** The note that session `name`'s agent of launch `launch` ended: {status, at}, or null. */
export function readExit(home, name, launch) {
  try {
    const st = fs.lstatSync(exitFileOf(home, name));
    if (!st.isFile() || st.size > 4096) return null;
    const r = JSON.parse(fs.readFileSync(exitFileOf(home, name), "utf8"));
    if (!r || r.launch !== launch || !(r.status === null || Number.isSafeInteger(r.status)) || !Number.isSafeInteger(r.at)) return null;
    return { status: r.status, at: r.at };
  } catch {
    return null;
  }
}

/**
 * The gate as the injector of `pane` (its agent process `pid`, in tmux session `session` of the
 * server at `socket`) sees it: {launch (the record, or null unless the server, session, pane and
 * process are all the recorded ones, the process observed as the same one), armed() (the
 * continuity still holds now), observe(read) (each read of the pane: {screen, prompt, inputShown},
 * or null when it failed), version() and cli() (the launch CLI's version and name while armed,
 * else null), off(why) (turns it
 * off for good: in the record first; never throws)}.
 */
export function startGate(home, name, { pane, pid, session, socket, now = Date.now, identity = identityState, self = () => processIdentity(process.pid), log = () => {} }) {
  const rec = readLaunch(home, name);
  const same = (r) => r.tmux.pane === pane && r.host?.pid === Number(pid) && !!socket && r.tmux.socket === socket && r.tmux.session === session && identity(r.host) === "same";
  let launch = null;
  try {
    launch = rec && same(rec) ? rec : null;
  } catch {}
  let armed = launch?.gate.state === "armed";
  let claim = null; // this injector's claim text, once created
  let pending = null; // an off state that could not be written yet
  let lastRead = null; // when the last successful read was
  let frame = null; // the trust dialog the first screen showed
  const gate = {
    launch,
    armed() {
      if (pending && persist(pending)) pending = null; // an off state not written yet: tried again
      if (!armed) return false;
      // The durable state decides: off in the record, another launch, or another claim is off.
      const cur = readLaunch(home, name);
      if (cur?.id !== launch.id || cur.gate.state !== "armed") armed = false;
      else if (readClaim(claimFileOf(home, name)) !== claim) gate.off("claimed by another injector");
      if (!armed) return false;
      const t = now();
      if (t - launch.started > START_MS + CARD_MS) gate.off("startup window over");
      else if (lastRead === null && t - launch.started > FIRST_READ_MS) gate.off("startup not observed");
      else if (frame === null && t - launch.started > DIALOG_MS) gate.off("startup not observed");
      else if (lastRead !== null && t - lastRead > GAP_MS) gate.off("reads interrupted");
      return armed;
    },
    observe(read) {
      if (!read || !gate.armed()) return;
      // Readiness first: the input rows are sampled after the screen, so Codex may have left the
      // dialog between the two.
      if (read.inputShown || busyShown(read.screen)) return gate.off("ready");
      const p = read.prompt;
      const dialog = p?.actionable && p.subtype === ANSWERABLE_OF[launch.cli.name] ? p.frame : null;
      if (frame === null) {
        if (!String(read.screen ?? "").trim() || splashShown(launch.cli.name, read.screen)) {
          lastRead = now(); // blank, or its splash: the agent still drawing
          return;
        }
        if (!dialog || !p.folders?.includes(shownFolder(launch))) return gate.off("startup not observed");
        frame = dialog;
      } else if (dialog !== frame) {
        return gate.off("the startup dialog ended");
      }
      lastRead = now();
    },
    version: () => (gate.armed() ? launch.cli.version : null),
    cli: () => (gate.armed() ? launch.cli.name : null),
    off(why) {
      if (!armed) return;
      armed = false; // in this run at once, whatever the record write does
      if (!persist(why, true)) pending = why;
    },
  };
  /** Write `why` as the record's off state (or remove the record); true once it is not armed on disk. */
  function persist(why, first = false) {
    try {
      const cur = readLaunch(home, name);
      if (cur?.id === launch.id && cur.gate.state === "armed") writeRecord(launchFileOf(home, name), { ...cur, gate: { state: "off", why, at: now() } });
      return true;
    } catch (e) {
      // Never left armed for a later injector: without a record it is notification-only.
      try {
        fs.rmSync(launchFileOf(home, name), { force: true });
        log(`the startup trust state could not be recorded (${e.message}); its launch record was removed`);
        return true;
      } catch {
        if (first) log(`the startup trust state could not be recorded (${e.message}); this injector keeps it off and tries again`);
        return false;
      }
    }
  }
  if (armed) {
    // Claimed before anything is read, exclusively: one injector ever, never a restart.
    let me = null;
    try {
      me = self();
    } catch {}
    if (now() - launch.started > FIRST_READ_MS) gate.off("startup not observed");
    else if (!me) gate.off("injector unknown");
    else {
      const text = `${JSON.stringify({ v: 1, launch: launch.id, pane, pid: Number(pid), injector: me, nonce: crypto.randomBytes(16).toString("hex") })}\n`;
      try {
        createExclusive(claimFileOf(home, name), text);
        claim = text;
      } catch (e) {
        gate.off(e.code === "EEXIST" ? "injector restarted" : `not claimed: ${String(e.code ?? e.message).slice(0, 100)}`);
      }
    }
  }
  return gate;
}
