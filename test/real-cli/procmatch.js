// Which processes a real-CLI gate run started from its temporary CODEX_HOME (a Codex app-server
// daemon may outlive the run). Pure, so the default suite tests it (test/real-cli-procmatch.test.js).
import path from "node:path";

/** The spellings of a temporary folder on macOS: /var/... and /private/var/... */
export const pathForms = (dir) => [...new Set([dir, dir.replace(/^\/private\/var\//, "/var/"), dir.replace(/^\/var\//, "/private/var/")])];

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A Codex process: its executable is `codex` (the native binary), or node running a `codex` launcher. */
export function isCodexProcess(args) {
  const [exe, first] = args.trim().split(/\s+/);
  const base = path.basename(exe ?? "");
  return base === "codex" || (/^node(\d+)?$/.test(base) && path.basename(first ?? "") === "codex");
}

/**
 * The pids among `rows` ({pid, args, env}: args as `ps -o args=` prints them, env the text `ps -E`
 * adds after them) that are Codex processes whose environment assigns exactly CODEX_HOME=<dir>
 * (in either spelling, a whole token: not a prefix of a longer path, not another variable, not an
 * argument). `self`: a pid never returned.
 */
export function startedFromCodexHome(rows, dir, { self = process.pid } = {}) {
  const re = new RegExp(`(?:^|\\s)CODEX_HOME=(?:${pathForms(dir).map(escape).join("|")})/?(?=\\s|$)`);
  return rows.filter((r) => r.pid !== self && isCodexProcess(r.args) && re.test(r.env)).map((r) => r.pid);
}

/** Rows for startedFromCodexHome from the two ps outputs (without and with -E), joined by pid. */
export function psRows(plain, withEnv) {
  const parse = (text) => new Map(text.split("\n").map((l) => l.match(/^\s*(\d+)\s(.*)$/)).filter(Boolean).map((m) => [Number(m[1]), m[2]]));
  const a = parse(plain);
  const e = parse(withEnv);
  const rows = [];
  for (const [pid, args] of a) {
    const full = e.get(pid);
    // The environment is what -E adds after the same arguments; anything else is not trusted.
    if (full === undefined || !full.startsWith(args)) continue;
    rows.push({ pid, args, env: full.slice(args.length) });
  }
  return rows;
}
