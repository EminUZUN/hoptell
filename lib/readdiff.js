// read_diff (lib/mcp.js, a local stdio session only): the commits and the diff between two commits
// of the git repository around the session's working folder, so a reviewer can read a change
// without git in a shell, where every option of git log, diff and show could run a program
// (submodule diffs, filters, signature checks, remerge diffs) and a permission rule cannot tell
// them apart. hoptell's controlled git runs it (lib/gitsafe.js and the worktree pins): no system
// or global configuration, no hooks, fsmonitor, external diff, textconv or signature check,
// attributes from an empty tree, no replacement objects, submodules as one line each. The
// repository's configuration and info/attributes are checked as for hoptell worktree, and one that
// could run a program is refused, as are grafts and objects stored outside the repository
// (alternates), which could show other content under the commit ids asked for. Only commit ids and
// plain branch or tag names (with ~N or ^N) are taken, and the working tree is never read.
// The .git folder's own files are trusted beyond these checks: whoever can write there can make
// the user's own git run a program anyway. A huge object git must inflate there (a commit or tag
// message, a delta base) costs memory in git only, for its time limit at most. When a
// file over BIG_FILE changed, only the list of changed files is shown: git reads a file whole to
// diff it (or to detect a rename), even one it then shows as binary.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GitError, controlledGit, findGit } from "./gitsafe.js";
import { attributesState, checkConfig, checkGit, commonFor, readGitFile, worktreePins } from "./worktrees.js";

export const READ_DIFF_MAX = 256 * 1024; // characters of the answer
const OUTPUT_CAP = 16 * 1024 * 1024; // bytes git may write per call
const BIG_FILE = 8 * 1024 * 1024; // bytes
// A commit id or a plain branch or tag name, with ~N or ^N steps: no option, range or path.
const REV_RE = /^(?![-./])(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9._/-]{1,200}(?<![./])(?:[~^]\d{0,3}){0,10}$/;

/** The git folder and the common git folder of the repository around `dir`, or null. */
function locate(dir) {
  for (let d = dir; ; d = path.dirname(d)) {
    let st = null;
    try {
      st = fs.lstatSync(path.join(d, ".git"));
    } catch {}
    if (st?.isDirectory()) {
      const gitdir = fs.realpathSync(path.join(d, ".git"));
      const common = commonFor(gitdir);
      return common ? { gitdir, common, top: d } : null;
    }
    if (st?.isFile()) {
      const gitdir = readGitFile(d);
      const common = gitdir && commonFor(gitdir);
      return common ? { gitdir, common, top: d } : null;
    }
    if (path.dirname(d) === d) return null;
  }
}

/**
 * The reader for `folder` (the session's working folder): {read({base, head, stat}), close()}.
 * read() resolves to the text for the agent and never rejects. `git`: tests.
 */
export function diffReader(folder, { git = findGit() } = {}) {
  let scratch = null;
  const runner = (pins) => {
    scratch ??= fs.mkdtempSync(path.join(os.tmpdir(), "hoptell-read-diff-"));
    return controlledGit({ git, scratch, pins, maxBuffer: OUTPUT_CAP });
  };
  const unable = (why) => `unable to show: ${why}`;
  return {
    async read({ base, head, stat = false } = {}) {
      for (const [name, rev] of [
        ["base", base],
        ["head", head],
      ]) {
        if (typeof rev !== "string" || !REV_RE.test(rev)) return unable(`${name} must be a commit id or a branch or tag name, such as main, 1a2b3c4 or HEAD~1`);
      }
      const at = locate(folder);
      if (!at) return unable(`this session's folder ${folder} is not in a git repository`);
      try {
        const check = runner(worktreePins());
        checkGit(check, "read_diff");
        checkConfig(check, [...new Set([path.join(at.common, "config"), path.join(at.common, "config.worktree"), path.join(at.gitdir, "config.worktree")])], scratch, { instead: "read the change with git in your shell, which asks your user first" });
        const shell = "read the change with git in your shell, which asks your user first";
        if (attributesState(at.common)?.drivers) return unable(`${path.join(at.common, "info", "attributes")} selects a filter, diff or merge driver or a line-ending conversion, which hoptell's git does not run; ${shell}`);
        const objects = path.join(at.common, "objects");
        if (fs.lstatSync(objects, { throwIfNoEntry: false })?.isDirectory() !== true) return unable(`${objects} is not a folder in the repository; ${shell}`);
        for (const sub of [objects, path.join(objects, "pack")]) {
          const link = fs.existsSync(sub) && fs.readdirSync(sub, { withFileTypes: true }).find((e) => e.isSymbolicLink());
          if (link) return unable(`${path.join(sub, link.name)} is a symlink: git could read objects from outside the repository there; ${shell}`);
        }
        for (const extra of [path.join(objects, "info", "alternates"), path.join(at.common, "info", "grafts")]) {
          if (fs.lstatSync(extra, { throwIfNoEntry: false })) return unable(`${extra} exists: git could read commits from elsewhere or change their parents there; ${shell}`);
        }
        const gd = [`--git-dir=${at.gitdir}`];
        const empty = check.run([...gd, "hash-object", "-t", "tree", "/dev/null"], scratch);
        if (empty.status !== 0) return unable("git could not read the repository");
        const g = runner([...worktreePins(empty.stdout.toString("utf8").trim()), "diff.submodule=short"]);
        const ids = [];
        for (const rev of [base, head]) {
          const r = g.run([...gd, "rev-parse", "--verify", "--quiet", "--end-of-options", `${rev}^{commit}`], scratch);
          if (r.status !== 0) return unable(`${rev} is not a commit in ${at.top}`);
          ids.push(r.stdout.toString("utf8").trim());
        }
        const [B, H] = ids;
        // The changed files and their sizes, from the trees and the object headers: no file is read.
        const raw = g.run([...gd, "diff", "--raw", "-z", "--no-abbrev", "--no-renames", "--no-ext-diff", "--no-textconv", "--submodule=short", B, H, "--"], scratch);
        if (raw.status !== 0) return unable(`git could not compare ${base} and ${head}`);
        const fields = raw.stdout.toString("utf8").split("\0");
        const changed = []; // [status, path, blob ids]
        for (let i = 0; i + 1 < fields.length; i += 2) {
          const [, , from, to, status] = fields[i].split(" ");
          changed.push([status, fields[i + 1], [from, to].filter((id) => !/^0+$/.test(id))]);
        }
        const blobs = [...new Set(changed.flatMap((c) => c[2]))];
        const sizes = blobs.length ? g.run([...gd, "cat-file", "--batch-check=%(objecttype) %(objectsize)"], scratch, `${blobs.join("\n")}\n`) : { status: 0, stdout: Buffer.alloc(0) };
        if (sizes.status !== 0) return unable(`git could not compare ${base} and ${head}`);
        const big = sizes.stdout.toString("utf8").split("\n").some((l) => Number(/^blob (\d+)$/.exec(l)?.[1] ?? 0) > BIG_FILE);
        const log = g.run([...gd, "log", "--no-color", "--no-show-signature", "--date=iso-strict", "--format=commit %H%nAuthor: %an <%ae>%nDate:   %ad%n%n%w(0,4,4)%B", `${B}..${H}`, "--"], scratch);
        const diff = big ? null : g.run([...gd, "diff", "--no-ext-diff", "--no-textconv", "--no-color", "--submodule=short", "-M", ...(stat ? ["--stat"] : []), B, H, "--"], scratch);
        if (log.status !== 0 || (diff && diff.status !== 0)) return unable(`git could not compare ${base} and ${head} (or its output is over ${OUTPUT_CAP / 1024 / 1024} MiB; try stat: true)`);
        const body = diff ? `${stat ? "Changed files" : "Diff"} ${B.slice(0, 12)} ${H.slice(0, 12)}:\n${diff.stdout.toString("utf8") || "(no changes)\n"}` : `Changed files ${B.slice(0, 12)} ${H.slice(0, 12)} (a file over ${BIG_FILE / 1024 / 1024} MiB changed, so only the list is shown; read the diff with git in your shell, which asks your user first):\n${changed.map(([status, file]) => `${status}\t${file}\n`).join("")}`;
        const text = `Commits ${base}..${head} (${B.slice(0, 12)}..${H.slice(0, 12)}) in ${at.top}:\n\n${log.stdout.toString("utf8") || "(no commits)\n"}\n${body}`;
        return text.length <= READ_DIFF_MAX ? text : `${text.slice(0, READ_DIFF_MAX)}\n[cut at ${READ_DIFF_MAX} characters: ask with stat: true, or for a smaller range]`;
      } catch (e) {
        return unable(e instanceof GitError ? e.message : "git could not be run");
      }
    },
    close() {
      if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
    },
  };
}
