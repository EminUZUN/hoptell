// The relay's realm: a stable namespace id kept in its state directory, plus a lock so only
// one relay uses a state directory at a time. The id is a public namespace label, not proof
// of the server's identity: TLS authenticates the endpoint.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { tryLock } from "./locks.js";

export const REALM_ID_RE = /^[0-9a-f]{32}$/;
const ownUid = () => (typeof process.getuid === "function" ? process.getuid() : null);

/** Default state directory for a relay run by a user (systemd and Docker set their own). */
export const defaultStateDir = () => path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "hoptell-relay");

/**
 * Create the state directory (0700) if needed and check that it is a private directory of ours.
 * The checks apply to the directory the path resolves to: systemd's StateDirectory= with
 * DynamicUser= makes /var/lib/<name> a symlink to /var/lib/private/<name>.
 */
function ensureStateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = fs.lstatSync(fs.realpathSync(dir));
  if (!st.isDirectory()) throw new Error(`relay state directory ${dir} is not a directory`);
  if (ownUid() !== null && st.uid !== ownUid()) throw new Error(`relay state directory ${dir} belongs to another user`);
  if (process.platform !== "win32" && st.mode & 0o077) throw new Error(`relay state directory ${dir} is open to other users; run: chmod 700 ${dir}`);
}

/** Read and validate an existing realm file; throws on anything unexpected. */
function readRealmFile(file) {
  const st = fs.lstatSync(file);
  if (!st.isFile()) throw new Error(`${file} is not a regular file`);
  if (ownUid() !== null && st.uid !== ownUid()) throw new Error(`${file} belongs to another user`);
  if (process.platform !== "win32" && st.mode & 0o077) throw new Error(`${file} is open to other users; run: chmod 600 ${file}`);
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    throw new Error(`${file} is not valid JSON; restore it from a backup (a new realm id would make every client report a changed realm)`);
  }
  if (data?.v !== 1 || !REALM_ID_RE.test(data.id || "")) throw new Error(`${file} does not contain a valid realm id`);
  return data.id;
}

/**
 * The realm id for `dir`: the existing realm.json, or a new one created exactly once
 * (exclusive create of a temporary file, fsync, link into place, so concurrent starts agree).
 * `override` (HOPTELL_REALM_ID) must match an existing file, or seeds a new one.
 */
export function loadRealm(dir, override = null) {
  if (override != null && !REALM_ID_RE.test(override)) throw new Error("HOPTELL_REALM_ID must be 32 lowercase hex characters");
  ensureStateDir(dir);
  const file = path.join(dir, "realm.json");
  const marker = path.join(dir, ".created");
  if (fs.existsSync(file) || isLink(file)) {
    const id = readRealmFile(file);
    if (override && override !== id) throw new Error(`HOPTELL_REALM_ID differs from the realm id already stored in ${file}; remove the override or restore the matching state`);
    return id;
  }
  // An established directory whose realm file went missing is not a fresh one. A concurrent first
  // start stores the file before the marker, so look at the file again before refusing.
  if (fs.existsSync(marker) && !fs.existsSync(file) && !isLink(file)) throw new Error(`${file} is missing from an established state directory; restore it from a backup (a new realm id would make every client report a changed realm)`);
  const id = override || crypto.randomBytes(16).toString("hex");
  const tmp = path.join(dir, `.realm-${crypto.randomBytes(6).toString("hex")}.tmp`);
  const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
  try {
    fs.writeSync(fd, `${JSON.stringify({ v: 1, id })}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.linkSync(tmp, file); // fails if another relay created the file first
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  fs.writeFileSync(marker, "", { mode: 0o600, flag: "a" });
  syncDir(dir);
  const stored = readRealmFile(file); // ours, or the one a concurrent start stored first
  if (override && stored !== override) throw new Error(`HOPTELL_REALM_ID differs from the realm id another relay just stored in ${file}`);
  return stored;
}

/** Make the new directory entries durable (best effort where directories cannot be opened). */
function syncDir(dir) {
  try {
    const fd = fs.openSync(dir, "r");
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch {}
}

function isLink(file) {
  try {
    return fs.lstatSync(file).isSymbolicLink();
  } catch {
    return false;
  }
}


/**
 * Take the state directory's lock (relay.lock with this process id). A lock left by a process
 * that no longer runs is taken over. Returns a release function.
 */
export function lockStateDir(dir) {
  ensureStateDir(dir);
  const release = tryLock(path.join(dir, "relay.lock"));
  if (typeof release === "function") return release;
  throw new Error(`another relay (process ${release.pid}) already uses the state directory ${dir}`);
}

/** Whether this process holds the state directory's lock (taken with lockStateDir). */
export function holdsStateDirLock(dir) {
  try {
    return Number(fs.readFileSync(path.join(dir, "relay.lock"), "utf8").trim()) === process.pid;
  } catch {
    return false;
  }
}

/**
 * The unfinished restore fencing state directory `dir` (design 4.4, "The fence"): the parsed
 * `restore/intent.json`, or null when there is none. A file that cannot be read or has an unknown
 * shape throws: the fence holds until the owner looks at it, never lifted by a damaged file.
 */
export function readRestoreIntent(dir) {
  const file = path.join(dir, "restore", "intent.json");
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw new Error(`${file} cannot be read (${e.code ?? "error"}); an unfinished restore fences this state directory`);
  }
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    doc = null;
  }
  if (doc?.v !== 1 || !/^[0-9a-f]{16}$/.test(doc.id ?? "") || typeof doc.phase !== "string") throw new Error(`${file} is damaged; an unfinished restore fences this state directory`);
  return doc;
}

/** The refusal every opener of a fenced state directory gives. */
export const fencedMessage = (intent) => `an unfinished restore (${intent.id}, phase ${intent.phase}) fences this state directory: run hoptell relay admin restore --resume (or --abort before installation)`;
