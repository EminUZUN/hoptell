// Small interprocess helpers for local state files: a short exclusive lock (stale locks of ended
// processes are removed) and a durable atomic write (temporary file, fsync, rename, directory fsync).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return pid > 0;
  } catch (e) {
    return e.code === "EPERM";
  }
};
const holder = (lock) => {
  try {
    return Number(fs.readFileSync(lock, "utf8").trim()) || 0;
  } catch {
    return null; // gone
  }
};

/**
 * Try to take a lock file. It is published complete (written to a private file, then linked into
 * place), so another process never sees it without its process id. Only acquiring (link) and the
 * owner's release touch a live lock. A lock whose process has ended is removed only while holding
 * a second lock, `<lock>.break`, after checking again that it is still that dead holder's lock:
 * nobody else can remove or replace it in between (link never replaces, and other breakers wait).
 * A break lock left by an ended process is not recovered automatically.
 * Returns a release function, or {pid} of a live holder. `afterCheck` and `beforeBreak` are test hooks.
 */
export function tryLock(lock, { afterCheck, beforeBreak } = {}) {
  const tmp = `${lock}.${process.pid}.${crypto.randomBytes(6).toString("hex")}`;
  fs.writeFileSync(tmp, `${process.pid}\n`, { flag: "wx", mode: 0o600 });
  try {
    for (let i = 0; i < 3; i++) {
      try {
        fs.linkSync(tmp, lock);
        let released = false;
        return () => {
          if (released) return;
          released = true;
          if (holder(lock) === process.pid) fs.rmSync(lock, { force: true });
        };
      } catch (e) {
        if (e.code !== "EEXIST") throw e;
      }
      const pid = holder(lock);
      if (pid === null) continue; // released meanwhile: try again
      if (alive(pid)) return { pid };
      afterCheck?.(); // tests: other processes act between the check and the break lock
      const brk = `${lock}.break`;
      try {
        fs.linkSync(tmp, brk);
      } catch (e) {
        if (e.code !== "EEXIST") throw e;
        const b = holder(brk);
        if (b === null) continue;
        if (alive(b)) return { pid: b }; // another process is removing the stale lock
        throw new Error(`removing a stale lock was interrupted; if no hoptell process is running, delete ${brk}`);
      }
      try {
        beforeBreak?.(); // tests: other processes act while this one holds the break lock
        if (holder(lock) === pid) fs.rmSync(lock, { force: true });
      } finally {
        if (holder(brk) === process.pid) fs.rmSync(brk, { force: true });
      }
    }
    return { pid: holder(lock) ?? 0 };
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/** Run fn while holding `<file>.lock`; waits briefly for a live holder. */
export async function withLock(file, fn, { waitMs = 2000 } = {}) {
  const lock = `${file}.lock`;
  for (let i = 0; i < Math.ceil(waitMs / 20); i++) {
    const release = tryLock(lock);
    if (typeof release !== "function") {
      await sleep(20);
      continue;
    }
    try {
      return await fn();
    } finally {
      release();
    }
  }
  throw Object.assign(new Error(`${file} is locked by another process`), { code: "busy" });
}

/** Write a JSON record durably: readers see the old or the new record, never a partial one. */
export function writeRecord(file, rec, space = undefined) {
  writeText(file, `${JSON.stringify(rec, null, space)}\n`);
}

/** Write a text file durably in the same way (temporary file, fsync, rename, directory fsync). */
export function writeText(file, text, mode = 0o600) {
  const tmp = `${file}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, mode);
  try {
    fs.writeSync(fd, text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  try {
    const d = fs.openSync(path.dirname(file), "r");
    fs.fsyncSync(d);
    fs.closeSync(d);
  } catch {}
}
