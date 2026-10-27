// Hook delivery for Claude Code: wake an idle session through its own hooks, never by typing.
//
// The plugin's SessionStart hook (`hoptell hook-session-start`) registers a private "bell"
// file for its Claude Code process and asks Claude Code to watch it. The MCP server writes a
// request and changes the bell; Claude Code then runs the FileChanged hook
// (`hoptell hook-file-changed`, asyncRewake), which checks the request and either
// acknowledges a silent probe or prints the fixed notice and exits 2, which wakes Claude.
// The notice never contains message text; the agent reads messages with read_inbox.
//
// Files in ~/.hoptell/wake/ (0700), per Claude Code process key K:
//   K.bell      a 16-byte counter, changed in place (watched by Claude Code)
//   K.reg.json  written by SessionStart: host identity, session id, epoch
//   K.mcp.json  written by the MCP server: its identity, peer name, current request
//   K.ack.json  written by FileChanged: the last request it handled
//   K.owner-N   the MCP server that owns hook delivery for this process (highest N wins;
//               a closed owner leaves a closed record, so numbers are never reused)
//   K.claim-ID  marks that notice ID was shown once
//   K.title.json  written by SessionStart and UserPromptSubmit, unless HOPTELL_TITLE_AUTO is off:
//               Claude Code's custom session title (session_title) and the session id, cleaned
//               and at most 1 KiB; read by the MCP server for the session title (never through
//               the bell, never a notice)
// No message text, sender, relay URL, token, prompt or transcript is stored.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { BIN, cleanTitle, ensurePrivateDir, envTitle, envTitleAuto } from "./config.js";
import { currentBoot, findClaudeHost, hostKey, processInfo, sameProcess, startedAtMs } from "./host.js";
import { HELD_NOTICE, NOTICE } from "./notices.js";

const BELL_BYTES = 16;
const MAX_RECORD = 4096;
const MAX_HOOK_INPUT = 256 * 1024;
const MAX_PROMPT_INPUT = 4 * 1024 * 1024; // UserPromptSubmit input (it carries the prompt, never used)
const MAX_TITLE_RECORD = 1024;
const STALE_MS = 7 * 86400_000;
const { O_RDONLY, O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW } = fs.constants;
const O_NONBLOCK = fs.constants.O_NONBLOCK ?? 0;

export const wakeDir = (home) => path.join(home, "wake");

/** The wake directory, created private if needed, as a canonical path. */
export function ensureWakeDir(home) {
  ensurePrivateDir(home);
  return fs.realpathSync(ensurePrivateDir(wakeDir(home)));
}

/** The canonical wake directory if it exists and is private, else null. */
function existingWakeDir(home) {
  try {
    const dir = fs.realpathSync(wakeDir(home));
    const st = fs.lstatSync(dir);
    return st.isDirectory() && st.uid === process.getuid() && (st.mode & 0o077) === 0 ? dir : null;
  } catch {
    return null;
  }
}

export const filesFor = (dir, key) => ({
  bell: path.join(dir, `${key}.bell`),
  reg: path.join(dir, `${key}.reg.json`),
  runtime: path.join(dir, `${key}.mcp.json`),
  ack: path.join(dir, `${key}.ack.json`),
  owner: (n) => path.join(dir, `${key}.owner-${n}`),
  claim: (id) => path.join(dir, `${key}.claim-${id}`),
  title: path.join(dir, `${key}.title.json`),
});

/**
 * The current owner of hook delivery for `key`: the record in the highest-numbered owner file.
 * {n: 0} when there is none; rec is null while a record is unreadable.
 */
export function readOwner(dir, key) {
  let n = 0;
  try {
    for (const name of fs.readdirSync(dir)) {
      const m = name.startsWith(`${key}.owner-`) && name.slice(key.length + 7).match(/^(\d{1,9})$/);
      if (m) n = Math.max(n, Number(m[1]));
    }
  } catch {
    return { n: 0, rec: null };
  }
  // An owner file has a second link for a moment while it is published (see takeOwnership).
  return { n, rec: n ? readRecord(filesFor(dir, key).owner(n), 2) : null };
}

/** A plain, private file of ours with at most maxLinks hard links (fstat result), or throws. */
export function checkPrivate(st, maxSize, maxLinks = 1, what = "wake file") {
  if (!st.isFile() || st.uid !== process.getuid() || (st.mode & 0o077) !== 0 || st.nlink < 1 || st.nlink > maxLinks || st.size > maxSize) throw new Error(`unsafe ${what}`);
}

/** Read a small private JSON record, or null if it is missing, unsafe or malformed. */
export function readRecord(file, maxLinks = 1, maxSize = MAX_RECORD) {
  let fd;
  try {
    fd = fs.openSync(file, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    checkPrivate(fs.fstatSync(fd), maxSize, maxLinks);
    const buf = Buffer.alloc(maxSize + 1);
    let n = 0;
    let r;
    while (n < buf.length && (r = fs.readSync(fd, buf, n, buf.length - n, null)) > 0) n += r;
    if (n > maxSize) return null;
    const v = JSON.parse(buf.subarray(0, n).toString("utf8"));
    return v && typeof v === "object" && !Array.isArray(v) && v.v === 1 ? v : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** Replace a record atomically (write a private temporary file, fsync, rename). */
export function writeRecord(file, value, maxSize = MAX_RECORD) {
  const tmp = `${file}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  const fd = fs.openSync(tmp, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600);
  try {
    const data = Buffer.from(JSON.stringify({ v: 1, ...value }));
    if (data.length > maxSize) throw new Error("wake record too large");
    let n = 0;
    while (n < data.length) n += fs.writeSync(fd, data, n, data.length - n, n);
    fs.fsyncSync(fd);
  } catch (e) {
    fs.closeSync(fd);
    fs.rmSync(tmp, { force: true });
    throw e;
  }
  fs.closeSync(fd);
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

/** Create the bell if needed; returns its {dev, ino}. Never replaces an existing one. */
export function ensureBell(file) {
  try {
    const fd = fs.openSync(file, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600);
    try {
      fs.writeSync(fd, Buffer.alloc(BELL_BYTES, "0"), 0, BELL_BYTES, 0);
    } finally {
      fs.closeSync(fd);
    }
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
  }
  return ringBell(file, null, false);
}

let ringCount = 0;
/**
 * Change the bell in place (Claude Code watches this inode), after checking that it is our
 * plain private file and, when `expect` is given, still the same inode. Returns {dev, ino}.
 */
export function ringBell(file, expect = null, write = true) {
  const fd = fs.openSync(file, (write ? O_WRONLY : O_RDONLY) | O_NOFOLLOW | O_NONBLOCK);
  try {
    const st = fs.fstatSync(fd);
    checkPrivate(st, BELL_BYTES);
    if (expect && (st.dev !== expect.dev || st.ino !== expect.ino)) throw new Error("bell was replaced");
    if (write) {
      const data = Buffer.from(`${Date.now().toString(36)}${(++ringCount).toString(36)}`.slice(-BELL_BYTES).padStart(BELL_BYTES, "0"));
      let n = 0;
      while (n < BELL_BYTES) n += fs.writeSync(fd, data, n, BELL_BYTES - n, n);
    }
    return { dev: st.dev, ino: st.ino };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Read a hook's JSON input from stdin (bounded); null if unusable. With `drain`, input past the
 * bound is read to its end and dropped, so the writer never meets a closed pipe; with `parse`
 * false nothing is parsed.
 */
function readHookInput(max = MAX_HOOK_INPUT, { drain = false, parse = true } = {}) {
  try {
    const buf = Buffer.alloc(max + 1);
    let n = 0;
    let r;
    while (n < buf.length && (r = fs.readSync(0, buf, n, buf.length - n, null)) > 0) n += r;
    if (drain) {
      const sink = Buffer.alloc(64 * 1024);
      while (fs.readSync(0, sink, 0, sink.length, null) > 0);
    }
    if (n > max || !parse) return null;
    const v = JSON.parse(buf.subarray(0, n).toString("utf8"));
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const KEEP_CLAIMS = 8; // claims of the latest notices are kept, so a delayed callback finds its own

// Race tests only: with a barrier path (HOPTELL_WAKE_TEST_BARRIER, read by the entry point and
// passed in), pause at the one step named in <barrier>.step until <barrier>.go exists (at most
// 10 seconds). Steps: "claim" (a callback, before claiming a notice), "publish" and "linked" (an
// MCP server, before and after publishing its ownership).
function testBarrier(b, step) {
  if (!b) return;
  let at = "";
  try {
    at = fs.readFileSync(`${b}.step`, "utf8").trim();
  } catch {
    return;
  }
  if (at !== step) return;
  fs.writeFileSync(`${b}.at-${process.pid}`, step);
  const until = Date.now() + 10_000;
  while (!fs.existsSync(`${b}.go`) && Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
}
const sameHost = (a, b) => Boolean(a && b && a.pid === b.pid && a.start === b.start && a.uid === b.uid && a.boot === b.boot);
const hostRecord = (h) => ({ pid: h.pid, start: h.start, uid: h.uid, boot: h.boot });

/** Remove files of Claude Code processes that ended long ago (bounded work). */
function pruneStale(dir) {
  let names;
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith(".reg.json")).slice(0, 64);
  } catch {
    return;
  }
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      if (Date.now() - fs.lstatSync(file).mtimeMs < STALE_MS) continue;
      const reg = readRecord(file);
      if (reg && sameProcess(reg.host)) continue;
      const key = name.slice(0, -".reg.json".length);
      for (const other of fs.readdirSync(dir)) if (other.startsWith(`${key}.`)) fs.rmSync(path.join(dir, other), { force: true });
    } catch {
      // leave it
    }
  }
}

/**
 * Whether the hooks keep Claude Code's session title for the MCP server: only when a session could
 * send it (no HOPTELL_TITLE, and HOPTELL_TITLE_AUTO on or unset; when unset the server sends it only
 * once the relay names a member). Otherwise no copy is written.
 */
export function hookTitleWanted(env) {
  try {
    return envTitle(env) === null && envTitleAuto(env) !== "off";
  } catch {
    return false;
  }
}

/**
 * Record the session's title (cleaned; a missing or unusable session_title is none) for the
 * verified registration `reg`, when it changed. The record names that registration (session id,
 * http_reg and epoch), so a reader never pairs it with another generation.
 */
function noteTitle(f, reg, raw) {
  const title = cleanTitle(raw);
  const cur = readRecord(f.title, 1, MAX_TITLE_RECORD);
  if (cur && cur.session_id === reg.session_id && cur.http_reg === reg.http_reg && cur.epoch === reg.epoch && (cur.title ?? null) === title) return;
  writeRecord(f.title, { session_id: reg.session_id, http_reg: reg.http_reg, epoch: reg.epoch, title, at: Date.now() }, MAX_TITLE_RECORD);
}

/**
 * `hoptell hook-session-start`: register this Claude Code process and ask it to watch the
 * bell. Prints only the hook's JSON output; prints nothing when it cannot register.
 */
export function hookSessionStart({ home, env = {} }) {
  try {
    const input = readHookInput();
    const host = findClaudeHost(process.ppid);
    if (!input || !host || typeof input.session_id !== "string" || !SAFE_ID.test(input.session_id)) return 0;
    const dir = ensureWakeDir(home);
    const key = hostKey(host);
    const f = filesFor(dir, key);
    const bell = ensureBell(f.bell);
    const reg = {
      key,
      host: hostRecord(host),
      session_id: input.session_id,
      source: typeof input.source === "string" ? input.source.slice(0, 16) : "",
      epoch: crypto.randomBytes(8).toString("hex"),
      // For hoptell mcp-http (design 2.3): an unpredictable id the client sends on initialize
      // (hoptell hook-header), so the HTTP session can use this process's hooks.
      http_reg: crypto.randomBytes(16).toString("hex"),
      bell: f.bell,
      bell_id: { dev: bell.dev, ino: bell.ino },
      at: Date.now(),
    };
    writeRecord(f.reg, reg);
    // The session's custom title (documented session_title input), in its own file: never the
    // bell, never a notice. With HOPTELL_TITLE_AUTO=off no copy is kept.
    try {
      if (hookTitleWanted(env)) noteTitle(f, reg, input.session_title);
      else fs.rmSync(f.title, { force: true });
    } catch {
      // registration and hook delivery go on without a title
    }
    pruneStale(dir);
    fs.writeSync(1, JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", watchPaths: [f.bell] } }));
  } catch {
    // no output: Claude Code continues without hook delivery
  }
  return 0;
}

/**
 * `hoptell hook-file-changed`: runs for every watched file of every plugin. Acts only on this
 * process's own bell and only for a current request from the live MCP server that owns hook
 * delivery here. A probe is acknowledged silently (exit 0); a notice is shown once (exit 2).
 */
export function hookFileChanged({ home, barrier = null }) {
  try {
    const input = readHookInput();
    const host = findClaudeHost(process.ppid);
    const dir = existingWakeDir(home);
    if (!input || !host || !dir) return 0;
    const key = hostKey(host);
    const f = filesFor(dir, key);
    if (input.file_path !== f.bell) return 0;
    const check = () => {
      const reg = readRecord(f.reg);
      const rt = readRecord(f.runtime);
      const owner = readOwner(dir, key).rec;
      if (owner?.closed) return null;
      if (!reg || reg.key !== key || !sameHost(reg.host, host) || reg.session_id !== input.session_id) return null;
      if (!rt || rt.key !== key || rt.mode !== "hook" || !sameHost(rt.host, host) || !rt.request) return null;
      if (!owner || owner.generation !== rt.generation || owner.mcp?.pid !== rt.mcp?.pid || !sameProcess(rt.mcp)) return null;
      const req = rt.request;
      if (req.epoch !== reg.epoch || !SAFE_ID.test(req.id || "") || !["probe", "notice", "held"].includes(req.kind)) return null;
      return { reg, rt, req };
    };
    const ok = check();
    if (!ok) return 0;
    const { req, rt, reg } = ok;
    if (req.kind === "probe") {
      writeRecord(f.ack, { key, generation: rt.generation, epoch: reg.epoch, kind: "probe", id: req.id, at: Date.now() });
      return 0;
    }
    // A notice is shown at most once, even if several callbacks run for it.
    testBarrier(barrier, "claim");
    try {
      fs.closeSync(fs.openSync(f.claim(req.id), O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600));
    } catch {
      return 0;
    }
    const again = check(); // still the same request, owner and conversation?
    if (!again || again.req.id !== req.id || again.reg.epoch !== reg.epoch) return 0;
    writeRecord(f.ack, { key, generation: rt.generation, epoch: reg.epoch, kind: req.kind, id: req.id, at: Date.now() });
    // Both texts are fixed: a held message's sender is named only by read_inbox.
    fs.writeSync(2, req.kind === "held" ? HELD_NOTICE : NOTICE);
    return 2;
  } catch {
    return 0;
  }
}

/**
 * `hoptell hook-user-prompt-submit`: keep Claude Code's current custom session title (a later
 * /rename) for the MCP server, unless HOPTELL_TITLE_AUTO is off. Copies only session_title and
 * session_id; never uses the prompt, prints nothing (its output would become context) and never
 * blocks the prompt (always exit 0). Only for this process's current registration.
 */
export function hookUserPromptSubmit({ home, env = {} }) {
  try {
    const wanted = hookTitleWanted(env);
    const input = readHookInput(MAX_PROMPT_INPUT, { drain: true, parse: wanted });
    if (!wanted || !input || typeof input.session_id !== "string" || !SAFE_ID.test(input.session_id)) return 0;
    const dir = existingWakeDir(home);
    if (!dir) return 0;
    const host = findClaudeHost(process.ppid);
    if (!host) return 0;
    const key = hostKey(host);
    const f = filesFor(dir, key);
    const reg = readRecord(f.reg);
    if (!reg || reg.key !== key || !sameHost(reg.host, host) || reg.session_id !== input.session_id || typeof reg.http_reg !== "string" || typeof reg.epoch !== "string") return 0;
    noteTitle(f, reg, input.session_title);
  } catch {
    // no title update; the prompt goes on
  }
  return 0;
}

/**
 * The session title the hooks recorded for the Claude Code process `host`, or null. Accepted only
 * when the title record names exactly the registration captured here (session id, http_reg and
 * epoch; a record missing any of them gives none), so a registration replaced between the two
 * reads, even with the same session id, never lends its title. An HTTP session's host carries the
 * exact registration it was bound to (`host.registration`: its http_reg id and epoch); a later
 * registration for the same process gives no title. `read`: the record reader (tests).
 */
export function readSessionTitle(home, host, { read = readRecord } = {}) {
  if (!host) return null;
  const dir = existingWakeDir(home);
  if (!dir) return null;
  const key = hostKey(host);
  const f = filesFor(dir, key);
  const reg = read(f.reg);
  if (!reg || reg.key !== key || !sameHost(reg.host, host) || typeof reg.session_id !== "string" || !SAFE_ID.test(reg.session_id)) return null;
  if (typeof reg.http_reg !== "string" || typeof reg.epoch !== "string") return null;
  const bound = host.registration;
  if (bound && (reg.http_reg !== bound.id || reg.epoch !== bound.epoch)) return null;
  const t = read(f.title, 1, MAX_TITLE_RECORD);
  if (!t || t.session_id !== reg.session_id || t.http_reg !== reg.http_reg || t.epoch !== reg.epoch) return null;
  return cleanTitle(t.title);
}

/** A millisecond timestamp that a Date can show. */
const validTime = (t) => Number.isSafeInteger(t) && t >= 0 && t <= 8.64e15;

/** Hook delivery of MCP servers on this machine, for doctor: what was verified, not what is configured. */
export function hookSessions(home) {
  const dir = existingWakeDir(home);
  if (!dir) return [];
  const out = [];
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith(".mcp.json")).slice(0, 64);
  } catch {
    return [];
  }
  for (const name of names) {
    const key = name.slice(0, -".mcp.json".length);
    const f = filesFor(dir, key);
    const rt = readRecord(f.runtime);
    if (!rt || rt.key !== key || typeof rt.peer !== "string") continue;
    const ack = readRecord(f.ack);
    const mine = ack && ack.generation === rt.generation;
    out.push({
      peer: rt.peer,
      pid: Number.isSafeInteger(rt.mcp?.pid) ? rt.mcp.pid : null,
      live: sameProcess(rt.mcp),
      // The server's start time, or null: settings read at start may be older.
      started: startedAtMs(rt.mcp?.start),
      verifiedAt: mine && validTime(rt.verified_at) ? rt.verified_at : null,
      lastNoticeAt: mine && (ack.kind === "notice" || ack.kind === "held") && validTime(ack.at) ? ack.at : null,
    });
  }
  return out;
}

/** A hook session as doctor and the settings pages name it: its peer name, or what is known before the name. */
export const hookSessionLabel = (s) => s.peer || `a session without a name yet (MCP server pid ${s.pid ?? "unknown"})`;

/** Claude Code hook settings that run this installation's hook commands (exec form). */
export function hooksSnippet(node, home) {
  const run = (cmd) => ({ type: "command", command: node, args: [BIN, cmd, ...(home ? ["--home", home] : [])] });
  return {
    hooks: {
      SessionStart: [{ hooks: [{ ...run("hook-session-start"), timeout: 10 }] }],
      UserPromptSubmit: [{ hooks: [{ ...run("hook-user-prompt-submit"), timeout: 5 }] }],
      FileChanged: [{ hooks: [{ ...run("hook-file-changed"), asyncRewake: true, timeout: 10 }] }],
    },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const newId = () => crypto.randomBytes(8).toString("hex");

export const PROBE_BUDGET_MS = 5000;
const REG_WAIT_MS = 3000;
const RING_EVERY_MS = 1000;
const NOTICE_BUDGET_MS = 9000;

/**
 * The MCP server's side of hook delivery for the Claude Code process `host`. `arm()` takes
 * ownership and verifies the file-event path with a silent probe; `notify()` sends the
 * notice. Returns null if this process cannot use hook delivery.
 */
export function hookChannel({ home, host, peer: peerOf, log = () => {}, barrier = null, signal = null }) {
  // `signal` (the engine stopping) ends waits and probes early; nothing is published after it.
  const cancelled = () => Boolean(signal?.aborted);
  // The peer name may be known only after the relay's welcome (automatic names): read it at use.
  const peerName = () => (typeof peerOf === "function" ? peerOf() : peerOf) ?? "";
  const dir = ensureWakeDir(home);
  const key = hostKey(host);
  const f = filesFor(dir, key);
  const me = processInfo(process.pid);
  if (!me) return null;
  const mcp = { pid: process.pid, start: me.start };
  const generation = newId();
  let owned = false;
  let ownerN = 0;
  let bellId = null;
  let verifiedAt = null;

  const register = () => {
    const reg = readRecord(f.reg);
    return reg && reg.key === key && sameHost(reg.host, host) && reg.bell === f.bell ? reg : null;
  };

  /**
   * Become the owner: publish a complete record as the next owner number with link(), which
   * fails if another server got that number first. An active live owner blocks acquisition.
   * Closing retains the highest number; a stale publication must pass stillOwner() before use.
   */
  async function takeOwnership() {
    for (let i = 0; i < 20; i++) {
      if (cancelled()) return false;
      const cur = readOwner(dir, key);
      if (cur.n && !cur.rec) {
        await sleep(50); // unreadable: look again, then treat it as ended
        if (i < 10) continue;
      }
      if (cur.rec && !cur.rec.closed && cur.rec.generation !== generation && sameProcess(cur.rec.mcp)) return false; // a live hoptell server owns it
      const n = cur.n + 1;
      const tmp = `${f.owner(n)}.${newId()}.tmp`;
      writeRecord(tmp, { key, mcp, generation, peer: peerName() });
      testBarrier(barrier, "publish");
      let linked = false;
      try {
        fs.linkSync(tmp, f.owner(n));
        linked = true;
        testBarrier(barrier, "linked");
      } catch (e) {
        if (e.code !== "EEXIST") return false;
      } finally {
        fs.rmSync(tmp, { force: true });
      }
      if (!linked) continue; // someone else got that number: look again
      ownerN = n;
      owned = true;
      if (!stillOwner()) {
        // A higher number exists: this number was free only because it had been cleaned up.
        if (readRecord(f.owner(n))?.generation === generation) fs.rmSync(f.owner(n), { force: true });
        return false;
      }
      removeOwnersBelow(n); // superseded: they can never be current again
      return true;
    }
    return false;
  }


  function removeOwnersBelow(limit) {
    for (const n of fs.readdirSync(dir)) {
      const m = n.startsWith(`${key}.owner-`) && n.slice(key.length + 7).match(/^(\d{1,9})$/);
      if (m && Number(m[1]) < limit) fs.rmSync(path.join(dir, n), { force: true });
    }
  }

  /** Still the owner? Checked before every request. */
  function stillOwner() {
    const cur = readOwner(dir, key);
    if (!owned || cur.n !== ownerN || cur.rec?.generation !== generation) owned = false;
    return owned;
  }

  /** Remove old notice claims, keeping the latest ones (all of them with `all`). */
  function dropClaims(all = false) {
    const claims = fs
      .readdirSync(dir)
      .filter((n) => n.startsWith(`${key}.claim-`))
      .map((n) => {
        try {
          return { n, t: fs.lstatSync(path.join(dir, n)).mtimeMs };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => b.t - a.t);
    for (const c of all ? claims : claims.slice(KEEP_CLAIMS)) fs.rmSync(path.join(dir, c.n), { force: true });
  }

  function request(kind, id) {
    const reg = register();
    if (!reg || !stillOwner()) return false;
    writeRecord(f.runtime, { key, host: hostRecord(host), mcp, generation, peer: peerName(), mode: "hook", verified_at: verifiedAt, request: { kind, id, epoch: reg.epoch }, at: Date.now() });
    dropClaims(); // after publishing: a claim is never removed while its request is current
    bellId = ringBell(f.bell, reg.bell_id ? { dev: reg.bell_id.dev, ino: reg.bell_id.ino } : bellId);
    return true;
  }

  const acked = (id) => {
    const ack = readRecord(f.ack);
    return Boolean(ack && ack.generation === generation && ack.id === id);
  };

  async function attempt(kind, budgetMs, id = newId()) {
    const until = Date.now() + budgetMs;
    while (Date.now() < until && !cancelled()) {
      try {
        request(kind, id);
      } catch (e) {
        log("hook delivery: could not ring the bell:", e.code || "unsafe_file");
      }
      const next = Math.min(until, Date.now() + RING_EVERY_MS);
      while (Date.now() < next && !cancelled()) {
        if (acked(id)) return true;
        await sleep(50);
      }
    }
    return acked(id);
  }

  const api = {
    key,
    files: f,
    /** Take ownership and run the silent probe. Returns "verified", "unverified" or "busy". */
    async arm() {
      const until = Date.now() + REG_WAIT_MS;
      while (!register() && Date.now() < until && !cancelled()) await sleep(50);
      if (cancelled() || !register()) return "unverified"; // no hooks here: leave no ownership record behind
      if (!(await takeOwnership())) return cancelled() ? "unverified" : "busy";
      if (cancelled()) {
        api.close();
        return "unverified";
      }
      const probed = await attempt("probe", PROBE_BUDGET_MS);
      if (cancelled()) {
        api.close(); // stopped while probing: give ownership back now
        return "unverified";
      }
      if (!probed) return "unverified";
      verifiedAt = Date.now();
      const rt = readRecord(f.runtime);
      if (rt && rt.generation === generation) writeRecord(f.runtime, { ...rt, verified_at: verifiedAt });
      return "verified";
    },
    /**
     * Write the current peer name into this server's runtime record. An automatic name is known
     * only after the relay's welcome, which may come after the probe wrote the record.
     */
    refresh() {
      if (!owned || !stillOwner()) return;
      const rt = readRecord(f.runtime);
      const peer = peerName();
      if (rt && rt.generation === generation && rt.peer !== peer) writeRecord(f.runtime, { ...rt, peer });
    },
    /** Send one notice (`held`: the held-message notice); true once it was shown or its tries are used up. */
    async notify({ held = false } = {}) {
      if (!owned) return true;
      // One id for all tries: a late callback for an earlier try cannot show a second notice.
      const id = newId();
      if (!(await attempt(held ? "held" : "notice", NOTICE_BUDGET_MS, id))) log("hook delivery: a notice was not acknowledged; messages stay in the inbox");
      return true; // the attempt is used either way, so an unreachable hook cannot cause endless rings
    },
    close() {
      if (!stillOwner()) return;
      fs.rmSync(f.runtime, { force: true });
      dropClaims(true);
      removeOwnersBelow(ownerN);
      // Keep the number as a closed record, so owner numbers only grow and are never reused.
      writeRecord(f.owner(ownerN), { key, mcp, generation, peer: peerName(), closed: true });
      owned = false;
    },
  };
  return api;
}

/**
 * `hoptell hook-header` (a client's headers helper for hoptell mcp-http): the registration id of
 * the Claude Code process this runs under, as {"X-Hoptell-Hook-Registration": id}, or {}.
 */
export function hookHeader({ home }) {
  try {
    const host = findClaudeHost(process.ppid);
    if (!host) return {};
    const f = filesFor(ensureWakeDir(home), hostKey(host));
    const reg = readRecord(f.reg);
    return reg && sameHost(reg.host, host) && typeof reg.http_reg === "string" ? { "X-Hoptell-Hook-Registration": reg.http_reg } : {};
  } catch {
    return {};
  }
}

const REG_SCAN_MAX = 1024; // registrations examined at most for one lookup

/**
 * The live Claude Code host of a registration id (hoptell mcp-http): the account's own record,
 * not older than the stale limit, named for the host it describes, of this boot and account,
 * naming a process that still runs (same pid and start time). Exactly one record may carry the
 * id: none or several give null (no hooks for that session).
 */
export function hostOfRegistration(home, id) {
  if (typeof id !== "string" || !/^[0-9a-f]{32}$/.test(id)) return null;
  let dir;
  let names;
  try {
    dir = ensureWakeDir(home);
    names = fs.readdirSync(dir).filter((n) => n.endsWith(".reg.json"));
  } catch {
    return null;
  }
  // Uniqueness must be proven over every registration: beyond the bound it cannot be, so no hooks.
  if (names.length > REG_SCAN_MAX) return null;
  const boot = currentBoot();
  const uid = process.getuid?.();
  const found = [];
  for (const name of names) {
    const reg = readRecord(path.join(dir, name));
    if (!reg || reg.http_reg !== id) continue;
    found.push({ name, reg }); // counted before the checks: an id in two records is ambiguous either way
    if (found.length > 1) return null;
  }
  if (!found.length) return null;
  const { name, reg } = found[0];
  if (!reg?.host || Date.now() - (reg.at ?? 0) > STALE_MS) return null;
  const h = reg.host;
  // The record names its own file and describes the host its key is made from.
  if (typeof reg.key !== "string" || name !== `${reg.key}.reg.json` || hostKey(h) !== reg.key) return null;
  if (!boot || h.boot !== boot || h.uid !== uid) return null; // another boot or account
  const info = processInfo(h.pid);
  if (!info || info.start !== h.start || info.uid !== h.uid) return null; // ended
  // registration: the exact record accepted (its id and epoch), to which title data is bound.
  return { pid: h.pid, uid: h.uid, start: h.start, boot: h.boot, args: info.args, registration: { id: reg.http_reg, epoch: typeof reg.epoch === "string" ? reg.epoch : null } };
}
