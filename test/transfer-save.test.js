// `hoptell save` (design 6, "Save", TR7): no-clobber by link, --overwrite with confirmation and
// rechecks, the save journal's phases and recovery from each, crashes at each step (ambiguous
// files are kept and reported, never deleted), one save at a time per transfer, and the staging
// charge released exactly once.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { forgetSave, journalFile, listJournals, readJournal, recoverSave, saveTransfer } from "../lib/transfersave.js";
import { incomingDir } from "../lib/transferin.js";
import { allowTransfers, device, pattern, sendFile, sha, transferRelay, until } from "./transfer-helpers.js";
import { tmpDir } from "./mls-helpers.js";

/** bob with one staged transfer from alice: {w, bob, t, bytes, out (a destination folder)}. */
async function staged(t, n = 1) {
  const w = await transferRelay(t);
  const alice = await device(t, w, "alice");
  const bob = await device(t, w, "bob");
  allowTransfers(bob.contacts, w.realm, alice.id);
  const list = [];
  for (let i = 0; i < n; i++) {
    const bytes = pattern(5000 + i, i);
    await sendFile(alice, "alice", bob, bytes, { name: "same-name.txt" });
    await until(() => bob.staged.length === i + 1, "staged");
    list.push({ t: bob.staged[i].e.t, bytes });
  }
  return { w, bob, ...list[0], list, out: tmpDir(t, "hoptell-save-out-") };
}
const save = (s, dest, opts = {}) => saveTransfer({ home: s.bob.dir, staging: s.bob.staging, t: s.t, destination: dest, ...opts });
const recover = (s, opts = {}) => recoverSave({ home: s.bob.dir, staging: s.bob.staging, t: s.t, ...opts });
const crash = (point) => (p) => {
  if (p === point) throw Object.assign(new Error(`crash at ${p}`), { code: "EFAULT" });
};
const entry = (s) => s.bob.staging.readLedger().entries[s.t];
const temps = (dir) => fs.readdirSync(dir).filter((n) => n.startsWith(".hoptell-save-"));

test("TR7: a save places the verified bytes, deletes the staging copy and removes the entry; the journal is gone", async (t) => {
  const s = await staged(t);
  const dest = path.join(s.out, "report.txt");
  const r = await save(s, dest);
  assert.deepEqual([r.state, r.dest, r.bytes], ["saved", fs.realpathSync(s.out) + "/report.txt", s.bytes.length]);
  assert.equal(sha(fs.readFileSync(dest)), sha(s.bytes));
  assert.equal((fs.statSync(dest).mode & 0o777).toString(8), "600");
  assert.equal(entry(s).state, "removed");
  assert.equal(fs.existsSync(path.join(incomingDir(s.bob.dir), s.t)), false);
  assert.equal(readJournal(s.bob.dir, s.t), null);
  assert.deepEqual(temps(s.out), []);
});

test("TR7: an existing destination without --overwrite is refused; nothing is replaced and the transfer stays staged", async (t) => {
  const s = await staged(t);
  const dest = path.join(s.out, "exists.txt");
  fs.writeFileSync(dest, "mine");
  await assert.rejects(save(s, dest), (e) => e.code === "exists");
  assert.equal(fs.readFileSync(dest, "utf8"), "mine");
  assert.equal(entry(s).state, "staged");
  assert.deepEqual(temps(s.out), []);
  assert.equal(readJournal(s.bob.dir, s.t), null);
});

test("TR7: a destination created concurrently between the copy and the link: the link fails and nothing is replaced", async (t) => {
  const s = await staged(t);
  const dest = path.join(s.out, "race.txt");
  await assert.rejects(save(s, dest, { fault: (p) => p === "after-created" && fs.writeFileSync(dest, "theirs") }), (e) => e.code === "exists");
  assert.equal(fs.readFileSync(dest, "utf8"), "theirs");
  assert.equal(entry(s).state, "staged");
  assert.deepEqual(temps(s.out), [], "our temporary file was removed (by its inode)");
});

test("TR7: symlink, dangling link and special-file destinations are refused in both modes", async (t) => {
  const s = await staged(t);
  const target = path.join(s.out, "target.txt");
  fs.writeFileSync(target, "x");
  fs.symlinkSync(target, path.join(s.out, "link.txt"));
  fs.symlinkSync(path.join(s.out, "nowhere"), path.join(s.out, "dangling.txt"));
  fs.mkdirSync(path.join(s.out, "dir.txt"));
  execFileSync("mkfifo", [path.join(s.out, "fifo.txt")]);
  for (const overwrite of [false, true]) {
    for (const [name, code] of [["link.txt", "symlink"], ["dangling.txt", "symlink"], ["dir.txt", "special"], ["fifo.txt", "special"]]) {
      await assert.rejects(save(s, path.join(s.out, name), { overwrite, yes: true }), (e) => e.code === code, `${name} overwrite=${overwrite}`);
    }
  }
  await assert.rejects(save(s, path.join(s.out, "missing-folder", "x.txt")), (e) => e.code === "no_parent");
  assert.equal(fs.readFileSync(target, "utf8"), "x");
  assert.equal(entry(s).state, "staged");
});

test("TR7: in link mode, a failure before the link leaves the destination unchanged; recovery removes the temporary file by its inode", async (t) => {
  const s = await staged(t);
  const dest = path.join(s.out, "before-link.txt");
  await assert.rejects(save(s, dest, { fault: crash("after-created") }), /crash/);
  assert.equal(fs.existsSync(dest), false);
  assert.equal(temps(s.out).length, 1);
  const r = await recover(s);
  assert.equal(r.state, "not_completed");
  assert.deepEqual(temps(s.out), []);
  assert.equal(fs.existsSync(dest), false);
  assert.equal(entry(s).state, "staged", "the owner can save again");
  assert.equal((await save(s, dest)).state, "saved");
});

test("TR7: with --overwrite, a failed directory sync after the rename is reported as replaced with durability unknown, and recovered", async (t) => {
  const s = await staged(t);
  const dest = path.join(s.out, "old.txt");
  fs.writeFileSync(dest, "old content");
  const shown = [];
  let syncs = 0;
  const r = await save(s, dest, {
    overwrite: true,
    confirm: async (info) => (shown.push(info), true),
    fault: (p) => {
      if (p === "dir-sync" && ++syncs === 1) throw Object.assign(new Error("I/O error"), { code: "EIO" });
    },
  });
  assert.equal(shown.length, 1, "it showed what it replaces and asked");
  assert.equal(shown[0].existing.size, 11);
  assert.equal(r.state, "replaced_unconfirmed");
  assert.match(r.message, /replaced, but not yet confirmed on disk: run hoptell doctor/);
  assert.equal(sha(fs.readFileSync(dest)), sha(s.bytes), "already replaced");
  assert.equal(entry(s).state, "staged", "not reported as saved yet");
  const rec = await recover(s);
  assert.equal(rec.state, "saved");
  assert.equal(entry(s).state, "removed");
  assert.equal(readJournal(s.bob.dir, s.t), null);
});

test("TR7: recovery at each journal phase; the temporary file renamed away is found by inode, an unrelated file at the temporary path is not deleted", async (t) => {
  // created (after the link, before its directory sync), the temporary path renamed away: found by inode at the destination.
  {
    const s = await staged(t);
    const dest = path.join(s.out, "a.txt");
    await assert.rejects(save(s, dest, { fault: crash("after-link") }), /crash/);
    const j = readJournal(s.bob.dir, s.t);
    assert.equal(j.phase, "created");
    fs.renameSync(j.temp, path.join(s.out, "moved-away"));
    assert.equal((await recover(s)).state, "saved");
    assert.equal(sha(fs.readFileSync(dest)), sha(s.bytes));
    assert.ok(fs.existsSync(path.join(s.out, "moved-away")), "a file at another path is not touched");
    assert.equal(entry(s).state, "removed");
  }
  // created (before the link), an unrelated file at the temporary path: reported, nothing deleted.
  {
    const s = await staged(t);
    const dest = path.join(s.out, "b.txt");
    await assert.rejects(save(s, dest, { fault: crash("after-created") }), /crash/);
    const j = readJournal(s.bob.dir, s.t);
    fs.unlinkSync(j.temp);
    fs.writeFileSync(j.temp, "someone else's file");
    const r = await recover(s);
    assert.equal(r.state, "attention");
    assert.equal(fs.readFileSync(j.temp, "utf8"), "someone else's file");
    assert.equal(fs.existsSync(dest), false);
    assert.ok(readJournal(s.bob.dir, s.t), "the journal is kept");
    assert.equal(forgetSave({ home: s.bob.dir, staging: s.bob.staging, t: s.t }).state, "forgotten");
    assert.equal(fs.readFileSync(j.temp, "utf8"), "someone else's file", "forget never deletes the file");
  }
  // placed and done: recovery completes.
  for (const point of ["journal-placed-file-fsync", "after-done"]) {
    const s = await staged(t);
    const dest = path.join(s.out, `${point}.txt`);
    await assert.rejects(save(s, dest, { fault: crash(point) }), /crash/);
    assert.equal((await recover(s)).state, "saved", point);
    assert.equal(sha(fs.readFileSync(dest)), sha(s.bytes));
    assert.deepEqual(temps(s.out), [], point);
    assert.equal(entry(s).state, "removed");
  }
});

test("TR7: crashes after the O_EXCL create, during the fill, after the sync and hash, before the created write, and that write failing keep the file and the journal as ambiguous; after the created write recovery removes the file by inode", async (t) => {
  for (const point of ["after-create", "during-fill", "after-hash", "before-created", "journal-created-file-fsync"]) {
    const s = await staged(t);
    const dest = path.join(s.out, "x.txt");
    // The created write failing: an I/O error, not a crash.
    const fault = point === "journal-created-file-fsync" ? (p) => { if (p === point) throw Object.assign(new Error("I/O"), { code: "EIO" }); } : crash(point);
    await assert.rejects(save(s, dest, { fault }));
    const [tmp] = temps(s.out);
    assert.ok(tmp, `${point}: the temporary file exists`);
    for (let i = 0; i < 2; i++) {
      const r = await recover(s);
      assert.equal(r.state, "ambiguous", point);
      assert.match(r.message, /hoptell save --forget/);
    }
    assert.ok(fs.existsSync(path.join(s.out, tmp)), `${point}: kept`);
    assert.equal(readJournal(s.bob.dir, s.t).ambiguous, true);
    assert.equal(entry(s).state, "staged", "the staging entry stays staged and charged");
    assert.deepEqual(listJournals(s.bob.dir), [{ t: s.t, phase: "prepared", ambiguous: true }]);
    assert.equal(forgetSave({ home: s.bob.dir, staging: s.bob.staging, t: s.t }).state, "forgotten");
    assert.ok(fs.existsSync(path.join(s.out, tmp)), "never deleted");
  }
  const s = await staged(t);
  await assert.rejects(save(s, path.join(s.out, "y.txt"), { fault: crash("after-created") }), /crash/);
  assert.equal((await recover(s)).state, "not_completed");
  assert.deepEqual(temps(s.out), []);
  // Nothing created at all: the record is dropped.
  const s2 = await staged(t);
  await assert.rejects(save(s2, path.join(s2.out, "z.txt"), { fault: crash("after-prepared") }), /crash/);
  assert.equal((await recover(s2)).state, "forgotten");
  assert.equal(readJournal(s2.bob.dir, s2.t), null);
});

test("TR7: a crash at done before the journal's deletion, and between the staging deletion and the removed write: repeated recovery completes and releases the charge exactly once", async (t) => {
  for (const point of ["before-journal-delete", "after-staging-delete"]) {
    const s = await staged(t);
    await assert.rejects(save(s, path.join(s.out, "done.txt"), { fault: crash(point) }), /crash/);
    for (let i = 0; i < 3; i++) assert.equal((await recover(s)).state, i === 0 ? "saved" : "none", point);
    const e = entry(s);
    assert.equal(e.state, "removed");
    const removedAt = e.removed_at;
    await recover(s);
    assert.equal(entry(s).removed_at, removedAt, "not released again");
    assert.equal(s.bob.staging.list().filter((x) => x.state !== "removed").length, 0);
  }
});

test("TR7: a second save or recovery for the same t_id while one holds the lock is refused, naming the holder", async (t) => {
  const s = await staged(t);
  const release = s.bob.staging.saveLock(s.t);
  try {
    await assert.rejects(save(s, path.join(s.out, "a.txt")), (e) => e.code === "locked" && new RegExp(`process ${process.pid}`).test(e.message));
    await assert.rejects(recover(s), (e) => e.code === "locked");
    await assert.rejects(s.bob.staging.cancel(s.t), /in progress/);
  } finally {
    release();
  }
  assert.equal((await save(s, path.join(s.out, "a.txt"))).state, "saved");
});

test("TR7: a crash after the rename but before the directory sync is recovered from the journal", async (t) => {
  const s = await staged(t);
  const dest = path.join(s.out, "replace.txt");
  fs.writeFileSync(dest, "before");
  await assert.rejects(save(s, dest, { overwrite: true, yes: true, fault: crash("after-rename") }), /crash/);
  assert.equal(readJournal(s.bob.dir, s.t).phase, "created");
  assert.equal((await recover(s)).state, "saved");
  assert.equal(sha(fs.readFileSync(dest)), sha(s.bytes));
  assert.equal(entry(s).state, "removed");
});

test("TR7: with --overwrite, a destination or a parent replaced after confirmation is detected; nothing is reported as saved", async (t) => {
  const s = await staged(t);
  const dest = path.join(s.out, "swap.txt");
  fs.writeFileSync(dest, "shown");
  await assert.rejects(save(s, dest, { overwrite: true, confirm: async () => (fs.unlinkSync(dest), fs.writeFileSync(dest, "swapped"), true) }), (e) => e.code === "changed");
  assert.equal(fs.readFileSync(dest, "utf8"), "swapped", "the replacement is left alone");
  assert.equal(entry(s).state, "staged");
  assert.deepEqual(temps(s.out), []);
  // The parent replaced by a link to another folder after confirmation.
  const parent = path.join(s.out, "parent");
  const elsewhere = path.join(s.out, "elsewhere");
  fs.mkdirSync(parent);
  fs.mkdirSync(elsewhere);
  fs.writeFileSync(path.join(parent, "f.txt"), "shown");
  fs.writeFileSync(path.join(elsewhere, "f.txt"), "other");
  await assert.rejects(save(s, path.join(parent, "f.txt"), { overwrite: true, confirm: async () => (fs.renameSync(parent, `${parent}-old`), fs.symlinkSync(elsewhere, parent), true) }), (e) => e.code === "changed");
  assert.equal(fs.readFileSync(path.join(elsewhere, "f.txt"), "utf8"), "other");
  assert.equal(fs.readFileSync(path.join(`${parent}-old`, "f.txt"), "utf8"), "shown");
  assert.equal(entry(s).state, "staged");
  // Not confirmed: nothing saved.
  await assert.rejects(save(s, dest, { overwrite: true, confirm: async () => false }), (e) => e.code === "not_confirmed");
  assert.ok(!fs.existsSync(journalFile(s.bob.dir, s.t)));
});

test("TR7: two transfers with the same name are saved independently; the name never chooses the path", async (t) => {
  const s = await staged(t, 2);
  const [a, b] = s.list;
  assert.equal((await saveTransfer({ home: s.bob.dir, staging: s.bob.staging, t: a.t, destination: path.join(s.out, "one.txt") })).state, "saved");
  assert.equal((await saveTransfer({ home: s.bob.dir, staging: s.bob.staging, t: b.t, destination: path.join(s.out, "two.txt") })).state, "saved");
  assert.equal(sha(fs.readFileSync(path.join(s.out, "one.txt"))), sha(a.bytes));
  assert.equal(sha(fs.readFileSync(path.join(s.out, "two.txt"))), sha(b.bytes));
  assert.equal(fs.existsSync(path.join(s.out, "same-name.txt")), false);
});
