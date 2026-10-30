// Worktree capture for hoptell worktree commit (design 8, topic 2). Started by lib/worktrees.js as
// a separate process with its working directory set to the member's worktree and that folder's
// open descriptor as fd 3. For each changed path it walks one name at a time, opening each folder
// without following a symbolic link and entering it only when the folder it stands in is the one
// it opened (device and inode), so a folder swapped for a link on the way is refused, never
// followed (the model is lib/read-helper.mjs). The last name is read where it was checked: a
// regular file through a descriptor, a symbolic link with readlink in the folder it was found in.
// A folder it enters below the root that holds a .git (a nested repository) is refused.
//
// Input (stdin, JSON): {paths, gone, root, rootDev, rootIno, maxBytes} (gone: the paths git reports
// deleted; a folder at one of them is a file replaced by a folder, read as missing)
// Output (stdout, JSON): {ok: true, entries: [{path, kind: "file"|"link"|"missing", exec?, data?}]}
// (data: base64) or {ok: false, code, path}.
import fs from "node:fs";

const { O_RDONLY, O_DIRECTORY, O_NOFOLLOW, O_NONBLOCK } = fs.constants;

class Refusal extends Error {
  constructor(code, where) {
    super(code);
    this.code = code;
    this.where = where;
  }
}
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;

// Race tests only: with HOPTELL_CAPTURE_TEST_BARRIER set, announce each step and wait until the
// test allows it. Only lib/worktrees.js sets it, in the minimal environment it gives this
// process, and only when a test passes a barrier to it.
const BARRIER = process.env.HOPTELL_CAPTURE_TEST_BARRIER;
const PAUSE_AT = BARRIER ? fs.readFileSync(`${BARRIER}.step`, "utf8").trim() : null;
function barrier(step) {
  if (!BARRIER || step !== PAUSE_AT) return;
  fs.writeFileSync(`${BARRIER}.at`, step);
  const until = Date.now() + 5000;
  while (!fs.existsSync(`${BARRIER}.go`)) {
    if (Date.now() > until) throw new Refusal("helper_failed", step);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
}

function readJob() {
  const chunks = [];
  const buf = Buffer.alloc(65536);
  let n;
  while ((n = fs.readSync(0, buf, 0, buf.length, null)) > 0) chunks.push(Buffer.from(buf.subarray(0, n)));
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

const missing = (e) => e?.code === "ENOENT" || e?.code === "ENOTDIR";
const exists = (p) => {
  try {
    fs.lstatSync(p);
    return true;
  } catch (e) {
    if (missing(e)) return false;
    throw e;
  }
};

/** One path, from the worktree's root: an entry, or a Refusal. */
function capture(rel, job, held, budget) {
  const rootDev = BigInt(job.rootDev);
  // Back to the root by its path, then check it is still the folder we were given.
  process.chdir(job.root);
  if (!same(fs.statSync(".", { bigint: true }), held)) throw new Refusal("root_changed", rel);
  const parts = rel.split("/");
  const open = [];
  try {
    for (const name of parts.slice(0, -1)) {
      let entry;
      try {
        entry = fs.lstatSync(name, { bigint: true });
      } catch (e) {
        if (missing(e)) return { path: rel, kind: "missing" };
        throw e;
      }
      if (entry.isSymbolicLink()) throw new Refusal("outside_worktree", rel);
      if (!entry.isDirectory()) return { path: rel, kind: "missing" }; // a file where a folder was
      if (entry.dev !== rootDev) throw new Refusal("other_device", rel);
      const fd = fs.openSync(name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
      open.push(fd);
      const opened = fs.fstatSync(fd, { bigint: true });
      if (!same(opened, entry)) throw new Refusal("changed_during_capture", rel);
      barrier(`opened-${name}`);
      process.chdir(name);
      if (!same(fs.statSync(".", { bigint: true }), opened)) throw new Refusal("changed_during_capture", rel);
      // A folder with a .git in it (a folder, a file or a link) is a nested repository: git can
      // list its files as the worktree's own when it took the place of a tracked folder.
      if (exists(".git")) throw new Refusal("not_a_file", rel);
    }
    const name = parts.at(-1);
    let entry;
    try {
      entry = fs.lstatSync(name, { bigint: true });
    } catch (e) {
      if (missing(e)) return { path: rel, kind: "missing" };
      throw e;
    }
    if (entry.isSymbolicLink()) {
      // Read in the folder it was found in (we stand in it), then checked again.
      const target = fs.readlinkSync(name, { encoding: "buffer" });
      if (!same(fs.lstatSync(name, { bigint: true }), entry)) throw new Refusal("changed_during_capture", rel);
      return { path: rel, kind: "link", data: target.toString("base64") };
    }
    if (entry.isDirectory()) {
      // A deleted file whose place a folder took: the file goes, the folder's files come as their
      // own paths. A nested repository there is refused: git lists none of its files.
      if (job.gone.has(rel) && !exists(`${name}/.git`)) return { path: rel, kind: "missing" };
      throw new Refusal("not_a_file", rel);
    }
    if (!entry.isFile()) throw new Refusal("not_a_file", rel);
    // A second hard link could bring in a file from outside the worktree.
    if (entry.nlink !== 1n) throw new Refusal("hard_link", rel);
    if (entry.dev !== rootDev) throw new Refusal("other_device", rel);
    const fd = fs.openSync(name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    open.push(fd);
    const before = fs.fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || !same(before, entry)) throw new Refusal("changed_during_capture", rel);
    if (before.size > BigInt(budget.left)) throw new Refusal("too_large", rel);
    const data = Buffer.alloc(Number(before.size) + 1);
    let got = 0;
    let r;
    while (got < data.length && (r = fs.readSync(fd, data, got, data.length - got, null)) > 0) got += r;
    const after = fs.fstatSync(fd, { bigint: true });
    if (BigInt(got) !== after.size || after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) throw new Refusal("changed_during_capture", rel);
    if (!same(fs.lstatSync(name, { bigint: true }), after)) throw new Refusal("changed_during_capture", rel);
    budget.left -= got;
    return { path: rel, kind: "file", exec: (Number(after.mode) & 0o111) !== 0, data: data.subarray(0, got).toString("base64") };
  } finally {
    for (const d of open) fs.closeSync(d);
  }
}

let out;
let current = null;
try {
  const job = readJob();
  const held = fs.fstatSync(3, { bigint: true });
  if (held.dev !== BigInt(job.rootDev) || held.ino !== BigInt(job.rootIno)) throw new Refusal("root_changed", null);
  job.gone = new Set(Array.isArray(job.gone) ? job.gone : []);
  const budget = { left: Number(job.maxBytes) };
  const entries = [];
  for (const rel of job.paths) {
    current = rel;
    entries.push(capture(rel, job, held, budget));
  }
  out = { ok: true, entries };
} catch (e) {
  out = { ok: false, code: e instanceof Refusal ? e.code : e?.code === "ELOOP" ? "outside_worktree" : "capture_failed", path: e?.where ?? current };
}
process.stdout.write(JSON.stringify(out));
