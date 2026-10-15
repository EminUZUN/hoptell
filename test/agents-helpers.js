// Helpers of the agent-spawn tests (design 7.1): a temporary home, profiles.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { agentsPaths, ensureAgentsDirs } from "../lib/agents.js";
import { startSupervisor } from "../lib/agentruns.js";

/** A temporary hoptell home and a separate folder for roots; removed after the test. */
export function agentsWorld(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hoptell-agents-")));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const home = path.join(base, "home");
  const work = path.join(base, "work");
  fs.mkdirSync(home, { mode: 0o700 });
  fs.mkdirSync(work, { mode: 0o700 });
  // A Git work tree, as codex exec requires (a Codex spawn elsewhere is refused: cwd_not_git_repo).
  execFileSync("git", ["init", "-q", work], { stdio: "ignore" });
  ensureAgentsDirs(home);
  return { base, home, work, homedir: base };
}

export const profileDoc = (work, over = {}) => ({
  version: 1,
  id: "codex-reviewer",
  description: "Read-only Codex review",
  cli: "codex",
  modes: ["headless"],
  sandbox: "read-only",
  folders: { roots: [work], default: work },
  name: { prefix: "codex-rev" },
  roles: ["reviewer"],
  relays: ["local"],
  ...over,
});

export function writeProfile(home, doc, { id = doc.id, mode = 0o600 } = {}) {
  const f = path.join(agentsPaths(home).profiles, `${id}.json`);
  fs.rmSync(f, { force: true });
  fs.writeFileSync(f, JSON.stringify(doc, null, 2), { mode });
  fs.chmodSync(f, mode);
  return f;
}


const SUPERVISE_GATED = fileURLToPath(new URL("./fixtures/supervise-gated.mjs", import.meta.url));
/**
 * A spawn's `start` that runs the shipped supervisor detached, as startSupervisor does, with the
 * test's gates (test/fixtures/supervise-gated.mjs reads them from next to the home), so the
 * supervisor's start-time gate check sees the stand-in CLI as gated.
 */
export function gatedStart(home, gates) {
  fs.writeFileSync(path.join(path.dirname(home), "supervisor-gates.json"), JSON.stringify(gates), { mode: 0o600 });
  return (h, run, opts) => startSupervisor(h, run, { ...opts, bin: SUPERVISE_GATED });
}
