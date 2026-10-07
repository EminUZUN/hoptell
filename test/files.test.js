// Guarded reads for the file tools: settings, path rules, refusals and race tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { FileToolError, checkRelPath, guardedRead, openRoots, parseRoots, supported } from "../lib/files.js";

const skip = !supported() && "the guarded reader needs macOS or Linux";

/** A fresh approved folder with the given files; returns {dir, root, outside}. */
function setup(files = {}) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hoptell-files-")));
  const dir = path.join(base, "approved");
  const outside = path.join(base, "outside");
  fs.mkdirSync(dir);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "secret.txt"), "SECRET OUTSIDE");
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  const root = openRoots([{ id: "app", path: dir }]).get("app");
  return { base, dir, root, outside, close: () => (fs.closeSync(root.fd), fs.rmSync(base, { recursive: true, force: true })) };
}

const code = async (p) => {
  try {
    await p;
    return "ok";
  } catch (e) {
    assert.ok(e instanceof FileToolError, `unexpected error: ${e.stack}`);
    return e.code;
  }
};

test("settings: approved folders are parsed strictly and never echoed", () => {
  assert.deepEqual(parseRoots(""), []);
  assert.deepEqual(parseRoots("  "), []);
  assert.deepEqual(parseRoots("[]"), []);
  assert.deepEqual(parseRoots('[{"id":"app","path":"/tmp/x"}]'), [{ id: "app", path: "/tmp/x" }]);
  const bad = [
    "not json SECRET_VALUE",
    "{}",
    '[{"id":"app"}]',
    '[{"id":"app","path":"/x","extra":1}]',
    '[{"id":"App","path":"/x"}]',
    '[{"id":"1app","path":"/x"}]',
    '[{"id":"app","path":"relative/x"}]',
    '[{"id":"app","path":"/x"},{"id":"app","path":"/y"}]',
    '[{"id":"app","path":5}]',
    "[1]",
    JSON.stringify(Array.from({ length: 17 }, (_, i) => ({ id: `r${i}`, path: "/x" }))),
    JSON.stringify([{ id: "app", path: `/${"x".repeat(9000)}` }]),
  ];
  for (const v of bad) {
    assert.throws(() => parseRoots(v), (e) => e.code === "invalid_config" && !e.message.includes("SECRET_VALUE"), v.slice(0, 60));
  }
});

test("settings: folders must exist, not be a filesystem root, and are resolved once", { skip }, () => {
  assert.throws(() => openRoots([{ id: "app", path: "/definitely/not/here" }]), /does not exist/);
  assert.throws(() => openRoots([{ id: "app", path: "/" }]), /filesystem root/);
  const t = setup();
  const link = path.join(t.base, "link-to-approved");
  fs.symlinkSync(t.dir, link);
  const viaLink = openRoots([{ id: "app", path: link }]).get("app");
  assert.equal(viaLink.canonical, t.dir); // a configured alias resolves to the real folder
  fs.closeSync(viaLink.fd);
  t.close();
});

test("paths: only plain relative paths inside the folder", () => {
  for (const ok of ["a.js", "src/a.js", "dir with space/ünïcode.txt", "a/b/c/d.e"]) assert.equal(checkRelPath(ok), ok);
  const bad = ["", "/etc/passwd", "../x", "a/../b", "./a", "a/./b", "a//b", "a/", "~/x", "C:\\x", "a\\b", "c:x", "a\x00b", "a\nb", "a\u2028b", "x".repeat(1025), Array(33).fill("a").join("/"), 7, null];
  for (const p of bad) assert.throws(() => checkRelPath(p), (e) => e.code === "path_unsafe", String(p).slice(0, 30));
});

test("reads: exact bytes of regular files, at the size limit and not past it", { skip }, async (t) => {
  const exact = Buffer.from("\ufeffline 1\r\nline 2\nno final newline", "utf8");
  const s = setup({ "greet.js": exact, "dir with space/ünï.txt": "unicode path", "limit.txt": "x".repeat(100), "over.txt": "x".repeat(101), "empty.txt": "" });
  t.after(s.close);
  assert.ok((await guardedRead(s.root, "greet.js", 100)).equals(exact));
  assert.equal((await guardedRead(s.root, "dir with space/ünï.txt", 100)).toString(), "unicode path");
  assert.equal((await guardedRead(s.root, "limit.txt", 100)).length, 100);
  assert.equal(await code(guardedRead(s.root, "over.txt", 100)), "too_large");
  assert.equal((await guardedRead(s.root, "empty.txt", 100)).length, 0);
});

test("reads: symlinks, hard links, special files and missing or unreadable files are refused", { skip }, async (t) => {
  const s = setup({ "real.txt": "real", "sub/inner.txt": "inner" });
  t.after(s.close);
  fs.symlinkSync(path.join(s.outside, "secret.txt"), path.join(s.dir, "link.txt"));
  fs.symlinkSync(s.outside, path.join(s.dir, "linkdir"));
  fs.symlinkSync("real.txt", path.join(s.dir, "relative-link.txt"));
  fs.linkSync(path.join(s.outside, "secret.txt"), path.join(s.dir, "hard.txt"));
  spawnSync("mkfifo", [path.join(s.dir, "fifo")]);
  fs.writeFileSync(path.join(s.dir, "locked.txt"), "locked", { mode: 0o000 });
  const cases = {
    "link.txt": "path_unsafe",
    "linkdir/secret.txt": "path_unsafe",
    "relative-link.txt": "path_unsafe",
    "hard.txt": "path_unsafe",
    fifo: "path_unsafe",
    sub: "path_unsafe",
    "nope.txt": "file_missing",
    "real.txt/x": "file_missing",
    ...(process.getuid?.() !== 0 ? { "locked.txt": "file_unreadable" } : {}),
  };
  for (const [rel, want] of Object.entries(cases)) assert.equal(await code(guardedRead(s.root, rel, 1000)), want, rel);
  assert.equal((await guardedRead(s.root, "sub/inner.txt", 1000)).toString(), "inner");
  fs.chmodSync(path.join(s.dir, "locked.txt"), 0o600);
});

/** Pause the helper at `step`, run `mutate`, then let it continue; resolves to the read's outcome. */
async function race(s, step, rel, mutate) {
  const barrier = path.join(s.base, "barrier");
  fs.writeFileSync(`${barrier}.step`, step);
  process.env.HOPTELL_READER_TEST_BARRIER = barrier;
  try {
    const read = guardedRead(s.root, rel, 1000).then(
      (b) => ({ ok: b.toString() }),
      (e) => ({ code: e.code }),
    );
    for (let i = 0; i < 300 && !fs.existsSync(`${barrier}.at`); i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(fs.readFileSync(`${barrier}.at`, "utf8"), step, "the helper paused at the expected step");
    mutate();
    fs.writeFileSync(`${barrier}.go-${step}`, "");
    return await read;
  } finally {
    delete process.env.HOPTELL_READER_TEST_BARRIER;
    for (const f of fs.readdirSync(s.base)) if (f.startsWith("barrier.")) fs.rmSync(path.join(s.base, f));
  }
}

test("races: swapping folders and files at each step never reads anything else", { skip }, async (t) => {
  // 1a. The approved folder is replaced after startup, before a read: refused.
  let s = setup({ "a.txt": "authorized" });
  fs.renameSync(s.dir, `${s.dir}-moved`);
  fs.mkdirSync(s.dir);
  fs.writeFileSync(path.join(s.dir, "a.txt"), "SWAPPED");
  assert.equal(await code(guardedRead(s.root, "a.txt", 1000)), "root_changed");
  s.close();

  // 1b. It is replaced after the helper started inside it: the helper keeps the checked folder.
  s = setup({ "a.txt": "authorized" });
  let r = await race(s, "start", "a.txt", () => {
    fs.renameSync(s.dir, `${s.dir}-moved`);
    fs.mkdirSync(s.dir);
    fs.writeFileSync(path.join(s.dir, "a.txt"), "SWAPPED");
  });
  assert.deepEqual(r, { ok: "authorized" });
  s.close();

  // 2. A parent folder is swapped between opening it and entering it: refused.
  s = setup({ "sub/a.txt": "authorized" });
  r = await race(s, "opened-sub", "sub/a.txt", () => {
    fs.renameSync(path.join(s.dir, "sub"), path.join(s.dir, "sub-old"));
    fs.symlinkSync(s.outside, path.join(s.dir, "sub"));
  });
  assert.deepEqual(r, { code: "changed_during_read" });
  s.close();

  // 3. The path is replaced after the helper entered the folder: it keeps reading the
  //    folder it checked, never the replacement.
  s = setup({ "sub/a.txt": "authorized" });
  r = await race(s, "entered-sub", "sub/a.txt", () => {
    fs.renameSync(path.join(s.dir, "sub"), path.join(s.dir, "sub-old"));
    fs.mkdirSync(path.join(s.dir, "sub"));
    fs.writeFileSync(path.join(s.dir, "sub", "a.txt"), "SWAPPED");
  });
  assert.deepEqual(r, { ok: "authorized" });
  s.close();

  // 4a. The file is replaced by a symlink between the check and the open: refused.
  s = setup({ "a.txt": "authorized" });
  r = await race(s, "file-checked", "a.txt", () => {
    fs.rmSync(path.join(s.dir, "a.txt"));
    fs.symlinkSync(path.join(s.outside, "secret.txt"), path.join(s.dir, "a.txt"));
  });
  assert.deepEqual(r, { code: "path_unsafe" });
  s.close();

  // 4b. The file is replaced by another regular file between the check and the open: refused.
  s = setup({ "a.txt": "authorized" });
  r = await race(s, "file-checked", "a.txt", () => {
    fs.renameSync(path.join(s.dir, "a.txt"), path.join(s.dir, "a-old.txt"));
    fs.writeFileSync(path.join(s.dir, "a.txt"), "SWAPPED");
  });
  assert.deepEqual(r, { code: "changed_during_read" });
  s.close();

  // 5. The file changes while it is being read: refused rather than half-read.
  s = setup({ "a.txt": "authorized" });
  r = await race(s, "file-read", "a.txt", () => fs.appendFileSync(path.join(s.dir, "a.txt"), " and more"));
  assert.deepEqual(r, { code: "changed_during_read" });
  s.close();
  t.diagnostic("all race cases refused or read only the checked file");
});

test("helper: one read at a time, a bounded queue, and a deadline", { skip }, async (t) => {
  const s = setup({ "a.txt": "x" });
  t.after(s.close);
  const reads = Array.from({ length: 8 }, () => guardedRead(s.root, "a.txt", 10));
  assert.equal(await code(guardedRead(s.root, "a.txt", 10)), "helper_failed"); // ninth waits too long
  for (const r of reads) assert.equal((await r).toString(), "x");

  // A helper that never gets the go-ahead is killed at the deadline.
  const barrier = path.join(s.base, "stuck");
  fs.writeFileSync(`${barrier}.step`, "start");
  process.env.HOPTELL_READER_TEST_BARRIER = barrier;
  const started = Date.now();
  assert.equal(await code(guardedRead(s.root, "a.txt", 10)), "helper_failed");
  delete process.env.HOPTELL_READER_TEST_BARRIER;
  assert.ok(Date.now() - started < 4000);
});
