// Controlled Git invocations for review sets (provenance at capture) and owner-run apply
// (patches applied in a standalone temporary folder). Git gets an environment built from scratch:
// no system or global configuration, an empty HOME, no inherited GIT_* routing (GIT_DIR,
// GIT_WORK_TREE, GIT_INDEX_FILE, ...), no pager, no prompts. Arguments never pass through a shell.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const GIT_TIMEOUT_MS = 10_000;
const GIT_OUTPUT_CAP = 4 * 1024 * 1024;

/** A Git problem with a fixed reason code (never Git's own text). */
export class GitError extends Error {
  constructor(code, message = code) {
    super(message);
    this.code = code;
  }
}

/** The first `git` executable on PATH (absolute), or null. */
export function findGit(envPath = process.env.PATH ?? "") {
  for (const dir of envPath.split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir)) continue; // a relative PATH entry would depend on the working folder
    const p = path.join(dir, "git");
    try {
      fs.accessSync(p, fs.constants.X_OK);
      if (fs.statSync(p).isFile()) return p;
    } catch {}
  }
  return null;
}

/**
 * Releases with the CVE-2023-23946 fix (git apply writing through a symlink): 2.39.2 and the
 * maintenance releases of the same day in older series. Anything from 2.40 on has it.
 */
const FIXED = { 30: 8, 31: 7, 32: 6, 33: 7, 34: 7, 35: 7, 36: 5, 37: 6, 38: 4, 39: 2 };

/** Does this `git --version` output name a release with the fix? Returns {ok, version}. */
export function gitVersionOk(text) {
  const m = /^git version (\d+)\.(\d+)\.(\d+)/.exec(String(text).trim());
  if (!m) return { ok: false, version: null };
  const [maj, min, patch] = m.slice(1).map(Number);
  const version = `${maj}.${min}.${patch}`;
  if (maj !== 2) return { ok: maj > 2, version };
  if (min >= 40) return { ok: true, version };
  if (min < 30) return { ok: false, version };
  return { ok: patch >= FIXED[min], version };
}

/**
 * A controlled Git runner. `scratch`: a private folder of ours that holds the empty HOME and the
 * empty global configuration. `ceiling`: repository discovery never goes at or above it (apply:
 * the temporary folder, so no repository is ever found).
 */
export function controlledGit({ git = findGit(), scratch, ceiling = null }) {
  if (!git) throw new GitError("git_missing", "Git was not found on PATH");
  const home = path.join(scratch, "git-home");
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const globalConfig = path.join(home, "empty.gitconfig");
  fs.writeFileSync(globalConfig, "", { mode: 0o600 });
  const env = {
    PATH: "/usr/bin:/bin",
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_ATTR_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_PAGER: "cat",
    PAGER: "cat",
    GIT_LITERAL_PATHSPECS: "1",
    GIT_OPTIONAL_LOCKS: "0", // provenance reads never refresh the index
    LC_ALL: "C",
    ...(ceiling ? { GIT_CEILING_DIRECTORIES: ceiling } : {}),
  };
  // Settings that could run a program or reach outside, forced off for every call.
  const pins = ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "core.pager=cat", "-c", "core.attributesFile=/dev/null", "-c", "core.untrackedCache=false", "-c", "protocol.allow=never"];
  /** Run git with `args` in `cwd`; returns {status, stdout (Buffer), stderr (Buffer)}. */
  const run = (args, cwd, input = undefined) => {
    const r = spawnSync(git, [...pins, ...args], { cwd, env, input, shell: false, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_OUTPUT_CAP, stdio: ["pipe", "pipe", "pipe"] });
    if (r.error) throw new GitError("git_failed", "Git could not be run");
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  return {
    git,
    env,
    run,
    /** Refuse Git releases without the CVE-2023-23946 fix. Returns the version. */
    checkVersion() {
      const r = run(["--version"], scratch);
      const v = gitVersionOk(r.status === 0 ? r.stdout.toString("utf8") : "");
      if (!v.ok) throw new GitError("git_too_old", `hoptell apply needs Git 2.39.2 or later (or a fixed release of an older series, for CVE-2023-23946); found ${v.version ?? "an unknown version"}`);
      return v.version;
    },
  };
}

/** The object id Git gives a blob with these bytes, for the repository's hash ("sha1" or "sha256"). */
export function blobId(bytes, format = "sha1") {
  return crypto.createHash(format).update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

/**
 * Git provenance of captured files (not their content): {commit, tree, files: {file_id: state}}
 * where state is "matches-head", "differs-from-head" or "untracked". `files`: [{file_id, root,
 * path, bytes}] (root: an opened approved folder). Every file must be in one work tree.
 * Throws GitError with a fixed reason.
 */
export function provenance(files, { scratch, git = findGit() }) {
  const g = controlledGit({ git, scratch });
  const out = (r) => r.stdout.toString("utf8").trim();
  let top = null;
  const rels = [];
  for (const f of files) {
    const r = g.run(["rev-parse", "--show-toplevel"], f.root.canonical);
    if (r.status !== 0) throw new GitError("not_a_repository", "an approved folder in this set is not inside a Git work tree; send it without git");
    let t;
    try {
      t = fs.realpathSync(out(r));
    } catch {
      throw new GitError("not_a_repository", "the Git work tree could not be resolved");
    }
    if (top !== null && t !== top) throw new GitError("several_repositories", "with git, every file of a set must be in the same Git work tree");
    top = t;
    const rel = path.relative(t, path.join(f.root.canonical, f.path));
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) throw new GitError("not_a_repository", "a file is outside the Git work tree");
    rels.push(rel.split(path.sep).join("/"));
  }
  const commitR = g.run(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], top);
  if (commitR.status !== 0) throw new GitError("no_commit", "the Git repository has no commit yet; send the set without git");
  const commit = out(commitR);
  const tree = out(g.run(["rev-parse", "--verify", "--quiet", "HEAD^{tree}"], top));
  const fmtR = g.run(["rev-parse", "--show-object-format"], top);
  const format = fmtR.status === 0 && out(fmtR) === "sha256" ? "sha256" : "sha1";
  const ls = g.run(["ls-tree", "-z", "--full-tree", commit, "--", ...rels], top);
  if (ls.status !== 0) throw new GitError("git_failed", "Git could not list the commit's files");
  const inHead = new Map();
  for (const entry of ls.stdout.toString("utf8").split("\0")) {
    const m = /^(\d{6}) (\w+) ([0-9a-f]{40,64})\t(.*)$/s.exec(entry);
    if (m) inHead.set(m[4], { mode: m[1], type: m[2], oid: m[3] });
  }
  const states = {};
  files.forEach((f, i) => {
    const h = inHead.get(rels[i]);
    if (!h) states[f.file_id] = "untracked";
    else states[f.file_id] = h.type === "blob" && h.mode !== "120000" && h.oid === blobId(f.bytes, format) ? "matches-head" : "differs-from-head";
  });
  return { commit, tree, files: states };
}
