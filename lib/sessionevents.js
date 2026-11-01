// The session events of one Claude Code process (design 10, 5.2): an append-only log in the wake
// folder, `<key>.events`, next to `<key>.reg.json`, for the process key K of lib/host.js hostKey.
//
// hoptell's SessionStart hook appends one line per hook run: {"session_id": ..., "source": ...},
// copied from the hook's own input. Nothing is ever overwritten, so a reader sees every session id
// registered for that process since it started, whatever order the hooks finished in. Readers use
// it as a set; it is a snapshot of the hooks that have appended so far, never proof that a hook
// running right now has finished.
//
// Bounds: a line is one write of at most EVENT_MAX_BYTES (O_APPEND, so lines never interleave).
// A reader reports "full" from EVENTS_MAX lines on, so a set it calls "ok" is always complete: the
// writer stops only at EVENTS_MAX * EVENT_MAX_BYTES bytes, which takes at least EVENTS_MAX lines,
// and an event it cannot record (an unusable session id) leaves a line that makes the file
// unreadable instead of nothing. The file is private (0600, ours, one link), like the other wake
// files, and goes with them (lib/wake.js pruneStale).
import fs from "node:fs";
import path from "node:path";

export const EVENTS_MAX = 64;
export const EVENT_MAX_BYTES = 512;
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const SOURCE_RE = /^[a-z_]{0,16}$/;
const { O_RDONLY, O_WRONLY, O_CREAT, O_APPEND, O_NOFOLLOW } = fs.constants;
const O_NONBLOCK = fs.constants.O_NONBLOCK ?? 0;
const MAX_FILE = EVENTS_MAX * EVENT_MAX_BYTES;

/** The events file of process key `key` in the wake folder `dir`. */
export const eventsFile = (dir, key) => path.join(dir, `${key}.events`);

const privateFile = (st) => st.isFile() && st.uid === process.getuid() && (st.mode & 0o077) === 0 && st.nlink === 1;

/**
 * Append one event {session_id, source} for process key `key`. Returns true when it was written,
 * false when it was not: an unusable id (a line that makes the file unreadable is written
 * instead), or a full or unsafe file. Throws only on I/O errors.
 */
export function appendSessionEvent(dir, key, { session_id, source = "" }) {
  const usable = typeof session_id === "string" && SAFE_ID.test(session_id);
  const src = typeof source === "string" && SOURCE_RE.test(source) ? source : "";
  const line = Buffer.from(usable ? `${JSON.stringify({ session_id, source: src })}\n` : `{"unusable":true}\n`);
  let fd;
  try {
    // Non-blocking: a FIFO in its place fails here (or below) instead of holding up the hook.
    fd = fs.openSync(eventsFile(dir, key), O_WRONLY | O_APPEND | O_CREAT | O_NOFOLLOW | O_NONBLOCK, 0o600);
  } catch (e) {
    if (e.code === "ENXIO") return false;
    throw e;
  }
  try {
    const st = fs.fstatSync(fd);
    if (!privateFile(st) || st.size + line.length > MAX_FILE) return false;
    fs.writeSync(fd, line); // one write of a whole line: appends never interleave
    return usable;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * The events of process key `key`:
 *   {state: "ok", events: [{session_id, source}], ids: Map(session_id -> Set(sources))}
 *   {state: "none"}                    no event yet (no file, or an empty one)
 *   {state: "full" | "unreadable"}     EVENTS_MAX lines or more, or an unsafe or malformed file
 *                                      (a line over EVENT_MAX_BYTES, a field of the wrong type)
 * Lines are in append order, but callers must not read meaning into that order.
 */
export function readSessionEvents(dir, key) {
  let fd;
  try {
    fd = fs.openSync(eventsFile(dir, key), O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  } catch (e) {
    return e.code === "ENOENT" ? { state: "none" } : { state: "unreadable" };
  }
  try {
    const st = fs.fstatSync(fd);
    if (!privateFile(st)) return { state: "unreadable" };
    if (st.size > MAX_FILE) return { state: "full" };
    const buf = Buffer.alloc(MAX_FILE + 1);
    let n = 0;
    let r;
    while (n < buf.length && (r = fs.readSync(fd, buf, n, buf.length - n, null)) > 0) n += r;
    if (n > MAX_FILE) return { state: "full" };
    const text = buf.subarray(0, n).toString("utf8");
    if (!text) return { state: "none" };
    if (!text.endsWith("\n")) return { state: "unreadable" }; // a line still being written, or a torn one
    const lines = text.slice(0, -1).split("\n");
    if (lines.length >= EVENTS_MAX) return { state: "full" }; // events may have been left out
    const events = [];
    const ids = new Map();
    for (const l of lines) {
      if (Buffer.byteLength(l) + 1 > EVENT_MAX_BYTES) return { state: "unreadable" };
      let e;
      try {
        e = JSON.parse(l);
      } catch {
        return { state: "unreadable" };
      }
      if (!e || typeof e !== "object" || typeof e.session_id !== "string" || !SAFE_ID.test(e.session_id) || typeof e.source !== "string" || !SOURCE_RE.test(e.source)) return { state: "unreadable" };
      events.push({ session_id: e.session_id, source: e.source });
      if (!ids.has(e.session_id)) ids.set(e.session_id, new Set());
      ids.get(e.session_id).add(e.source);
    }
    return { state: "ok", events, ids };
  } catch {
    return { state: "unreadable" };
  } finally {
    fs.closeSync(fd);
  }
}
