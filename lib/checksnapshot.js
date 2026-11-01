// check_snapshot (lib/mcp.js, a local stdio session only): the `snapshot --check` step for a file
// in the session's working folder, as a read-only tool. Reads go through the file tools' guarded
// reader (lib/files.js, lib/read-helper.mjs): the folder is resolved and opened once at startup,
// and links, hard links, special files and anything replaced while it is read are refused, so a
// peer's request cannot use it to learn the digest of a file elsewhere.
import fs from "node:fs";
import path from "node:path";
import { FileToolError, checkRelPath, createReader, openRoots, supported } from "./files.js";
import { DIGEST_RE, MAX_SNAPSHOT_BYTES, checkText, sha256Of } from "./snapshot.js";

const REFUSED = {
  path_unsafe: "it is not a plain file inside this session's folder (links, hard links and special files are refused)",
  file_missing: "it does not exist",
  file_unreadable: "it cannot be read",
  too_large: `it is larger than ${MAX_SNAPSHOT_BYTES} bytes`,
  changed_during_read: "it changed while it was read",
  root_changed: "this session's folder was replaced after the session started",
  helper_failed: "the file could not be read",
};

/**
 * The checker for `folder` (the session's working folder): {folder, check(digest, file), close()},
 * or null where the guarded reader cannot run or the folder cannot be opened (a filesystem root).
 * check() resolves to the text for the agent and never rejects.
 */
export function folderChecker(folder, { reader = null } = {}) {
  if (!supported()) return null;
  let root;
  try {
    root = openRoots([{ id: "session", path: folder }]).get("session");
  } catch {
    return null;
  }
  const guarded = reader ?? createReader();
  const outside = (file) => `unable to check: ${file} is not inside this session's folder ${root.canonical}`;
  return {
    folder: root.canonical,
    async check(digest, file) {
      if (typeof digest !== "string" || typeof file !== "string" || file === "") return "unable to check: give sha256 and file";
      const expected = digest.trim().toLowerCase();
      if (!DIGEST_RE.test(expected)) return `unable to check: invalid digest "${digest.slice(0, 80)}": expected sha256: followed by 64 hex digits`;
      // An absolute path names the folder as the session saw it or as resolved; either way the
      // rest is checked name by name by the reader.
      let rel = file.replace(/^(?:\.\/)+/, "");
      if (path.isAbsolute(file)) {
        rel = [root.canonical, folder].map((b) => path.relative(b, path.normalize(file))).find((r) => r && !r.startsWith("..") && !path.isAbsolute(r));
        if (!rel) return outside(file);
      }
      try {
        checkRelPath(rel);
      } catch {
        return outside(file);
      }
      try {
        const current = sha256Of(await guarded.read(root, rel, MAX_SNAPSHOT_BYTES));
        return checkText({ matches: current === expected, current, expected }, file);
      } catch (e) {
        return `unable to check: ${file}: ${e instanceof FileToolError ? (REFUSED[e.code] ?? REFUSED.helper_failed) : REFUSED.helper_failed}`;
      }
    },
    close() {
      guarded.close();
      fs.closeSync(root.fd);
    },
  };
}
