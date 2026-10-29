// The startup folder-trust gate of a Codex launch (design 9, C, with the v2 correction 4 and the
// owner's decision of 29 October 2026): tied to one launch hoptell started and to the injector's
// unbroken view of it, not to a screen regex alone; it samples the startup, it does not prove it
// (the limit is below). `hoptell tmux` writes a launch record, sessions/<name>.launch.json,
// when it starts a session:
//   {v: 1, id, cli: {name, path, version} | null, folder, root, tmux: {socket, session, pane},
//    host: {pid, start, uid, boot} | null, untested, started, gate: {state: "armed" | "off", why, at}}
// It is written before the session's injector starts. `untested` is the launch's test switch
// (HOPTELL_PROMPT_UNTESTED=1 for `hoptell tmux`, for the owner's live check only): the prompt's
// options not checked live yet are shown on the card and pressed too (lib/promptcards.js). The gate is armed only for a fresh
// interactive launch of Codex (`codex` with only the flags of FRESH_FLAGS) whose executable
// hoptell resolved and asked its version, a version the prompt table was recorded on
// (lib/prompts.js), with the folder Codex will ask about (`root`: the repository's main folder,
// also from a linked worktree; the launch folder outside a repository). The agent then runs that
// very executable.
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
// rule over the injector's reads (observe): it stays armed only while
//   - the injector's first read came within FIRST_READ_MS of the launch, and the trust dialog
//     within DIALOG_MS (blank screens before it: Codex still drawing);
//   - the first screen that shows anything is that dialog, naming the launch's `root`;
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
import { ANSWERABLE, CARD_MS, START_MS, answerableOptions } from "./promptcards.js";
import { busyShown } from "./prompts.js";

const RECORD_MAX = 16 * 1024;
const VERSION_TIMEOUT_MS = 5000;
export const FIRST_READ_MS = 15_000;
export const DIALOG_MS = 30_000;
export const GAP_MS = 5000; // about twice the armed watch's 2 s
const isAbs = (x) => typeof x === "string" && x.length > 0 && x.length <= 4096 && path.isAbsolute(x) && !/[\0\n\r]/.test(x);

// The fresh interactive launch the prompt table was recorded on: `codex` with only these flags,
// none of which changes the folder or the session (a value as the next word, or after "=").
// A subcommand (resume, exec, ...), -C/--cd, a prompt, -c, -p or any other flag: notification-only.
const FRESH_VALUE = new Set(["-s", "--sandbox", "-a", "--ask-for-approval", "-m", "--model"]);
const FRESH_BOOL = new Set(["--full-auto", "--dangerously-bypass-approvals-and-sandbox"]);

/** Why `args` (after the executable) is not a fresh interactive launch, or null when it is. */
export function freshProblem(args) {
  for (let i = 0; i < args.length; i++) {
    const a = String(args[i]);
    if (FRESH_BOOL.has(a)) continue;
    if (FRESH_VALUE.has(a)) {
      if (i + 1 >= args.length) return `${a} without a value`;
      i++;
      continue;
    }
    const eq = a.indexOf("=");
    if (a.startsWith("--") && eq > 2 && FRESH_VALUE.has(a.slice(0, eq))) continue;
    if (/^(-C|--cd)(=|$)/.test(a) || /^-C./.test(a)) return "another folder (-C/--cd)";
    if (!a.startsWith("-")) return "a subcommand or a prompt";
    return `the flag ${a.split("=")[0].slice(0, 40)}`;
  }
  return null;
}

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

/** Codex's version from `<file> --version` ("codex-cli 0.165.0"), or null when it cannot be told. */
export function codexVersion(file, { env, run = execFileSync }) {
  try {
    const out = run(file, ["--version"], { encoding: "utf8", env, timeout: VERSION_TIMEOUT_MS, stdio: ["ignore", "pipe", "ignore"] });
    const m = String(out).match(/^codex-cli (\d{1,4}\.\d{1,4}\.\d{1,4})\s*$/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

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
 * What a launch of `cmd` in `folder` knows before it starts: {cli, root, gate, argv}. For Codex
 * (by its command's name) the executable is resolved on the caller's PATH and asked its version;
 * on a version the prompt table has, the gate is armed and `argv` runs that executable by its
 * absolute path, so the agent is the program that was asked. Anything else: the gate is off, and
 * `argv` is `cmd` unchanged.
 */
export function launchGate(cmd, { folder, env, now = Date.now, version = codexVersion, root = trustRootOf }) {
  const off = (why, cli = null) => ({ cli, root: null, gate: { state: "off", why, at: now() }, argv: [...cmd] });
  if (path.basename(String(cmd[0] ?? "")) !== "codex") return off("not codex");
  const fresh = freshProblem(cmd.slice(1));
  if (fresh) return off(`not a fresh interactive launch: ${fresh}`);
  const file = resolveCli(cmd[0], { envPath: env.PATH ?? "", cwd: folder });
  if (!file) return off("codex not found");
  const v = version(file, { env: { PATH: env.PATH ?? "", HOME: env.HOME ?? "" } });
  const cli = { name: "codex", path: file, version: v };
  if (!v) return off("version unknown", cli);
  if (!answerableOptions(v).length) return off("version not recorded", cli);
  const r = root(folder, { envPath: env.PATH ?? "", home: env.HOME ?? "" });
  if (!r) return off("folder unknown", cli);
  return { cli, root: r, gate: { state: "armed", why: null, at: now() }, argv: [file, ...cmd.slice(1)] };
}

/**
 * Write the launch record of session `name` (lib/tmux.js launch, once the agent's pane started and
 * before its injector does). `host` is the agent's process identity (lib/host.js), null when it
 * could not be read: the gate is then off.
 */
export function writeLaunch(home, name, { cli, root, gate, folder, tmux, host, untested = false, now = Date.now }) {
  const g = gate.state === "armed" && !tmux.socket ? { state: "off", why: "tmux server unknown", at: now() } : gate.state === "armed" && !host ? { state: "off", why: "process unknown", at: now() } : gate;
  const rec = { v: 1, id: crypto.randomBytes(16).toString("hex"), cli, folder, root, tmux, host, untested: untested === true, started: now(), gate: g };
  ensurePrivateDir(path.join(home, "sessions"));
  writeRecord(launchFileOf(home, name), rec);
  return rec;
}

/** The launch record `r` checked, or null. */
function checked(r) {
  const plain = (o, keys) => o !== null && typeof o === "object" && !Array.isArray(o) && Object.keys(o).length === keys.length && keys.every((k) => Object.hasOwn(o, k));
  if (!plain(r, ["v", "id", "cli", "folder", "root", "tmux", "host", "untested", "started", "gate"]) || r.v !== 1) return null;
  if (typeof r.id !== "string" || !/^[0-9a-f]{32}$/.test(r.id)) return null;
  if (!(r.cli === null || (plain(r.cli, ["name", "path", "version"]) && r.cli.name === "codex" && isAbs(r.cli.path) && (r.cli.version === null || typeof r.cli.version === "string")))) return null;
  if (!isAbs(r.folder) || !(r.root === null || isAbs(r.root))) return null;
  if (!plain(r.tmux, ["socket", "session", "pane"]) || !(r.tmux.socket === null || isAbs(r.tmux.socket)) || !/^\$\d{1,9}$/.test(String(r.tmux.session)) || !/^%\d{1,9}$/.test(String(r.tmux.pane))) return null;
  const h = r.host;
  if (!(h === null || (plain(h, ["pid", "start", "uid", "boot"]) && Number.isSafeInteger(h.pid) && h.pid >= 2 && typeof h.start === "string" && h.start && Number.isSafeInteger(h.uid) && typeof h.boot === "string"))) return null;
  if (typeof r.untested !== "boolean" || !Number.isSafeInteger(r.started)) return null;
  if (!plain(r.gate, ["state", "why", "at"]) || !["armed", "off"].includes(r.gate.state) || !Number.isSafeInteger(r.gate.at)) return null;
  // Armed only with what arming needs.
  if (r.gate.state === "armed" && !(r.cli?.version && r.root && r.tmux.socket && r.host)) return null;
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

/**
 * The gate as the injector of `pane` (its agent process `pid`, in tmux session `session` of the
 * server at `socket`) sees it: {launch (the record, or null unless the server, session, pane and
 * process are all the recorded ones, the process observed as the same one), armed() (the
 * continuity still holds now), observe(read) (each read of the pane: {screen, prompt, inputShown},
 * or null when it failed), version() (Codex's version while armed, else null), off(why) (turns it
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
      const dialog = p?.actionable && p.subtype === ANSWERABLE ? p.frame : null;
      if (frame === null) {
        if (!String(read.screen ?? "").trim()) {
          lastRead = now(); // blank: Codex still drawing
          return;
        }
        if (!dialog || !p.folders?.includes(launch.root)) return gate.off("startup not observed");
        frame = dialog;
      } else if (dialog !== frame) {
        return gate.off("the startup dialog ended");
      }
      lastRead = now();
    },
    version: () => (gate.armed() ? launch.cli.version : null),
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
