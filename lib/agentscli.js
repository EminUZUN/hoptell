// `hoptell agents ...` (design 7.1): agent profiles, their approval, and runs.
import path from "node:path";
import { CODEX_APPROVAL_WARNING, HARDENING_APPROVAL_TEXT, HEADLESS_MODE_LABEL, agentsPaths, approvalOf, listProfiles, readApproved } from "./agents.js";

const STATE_TEXT = { approved: "approved", changed: "CHANGED since you approved it (not usable until approved again)", unapproved: "not approved yet (not usable)", invalid: "INVALID (not usable)" };

const VALUE_FLAGS = ["--home", "--run"];

/**
 * Run one `hoptell agents` command. `env` and `homedir` are the CLI's (an entry point reads them);
 * `fail(message, code)` ends the process.
 */
export async function agentsCommand({ args, home: defaultHome, env, homedir, fail, out = console.log, sources = {} }) {
  const pos = args.filter((a, i) => !a.startsWith("--") && !VALUE_FLAGS.includes(args[i - 1]));
  // --home: the internal commands (supervise, exec) name their home explicitly.
  const at = args.indexOf("--home");
  const home = at >= 0 && args[at + 1] ? path.resolve(args[at + 1]) : defaultHome;
  const [sub = "profiles", ...rest] = pos;
  if (sub === "profiles") {
    const rows = listProfiles(home, { homedir });
    const approved = readApproved(home);
    if (approved.problem) out(`note: ${approved.problem}`);
    if (!rows.length) out(`No agent profiles in ${agentsPaths(home).profiles}.`);
    for (const r of rows) {
      const state = approvalOf(r, approved);
      out(`${r.id}  ${STATE_TEXT[state]}${r.profile ? `  ${r.profile.cli}, ${r.profile.modes.join("/")}, ${r.profile.sandbox}` : ""}`);
      for (const p of r.problems) out(`  problem: ${p}`);
      if (state === "unapproved" || state === "changed") out(`  approve with: hoptell agents profile approve ${r.id}`);
    }
    return;
  }
  if (sub === "profile" && rest[0] === "approve") {
    const id = rest[1];
    if (!id) fail("usage: hoptell agents profile approve <id> [--accept-read-risk]", 2);
    const acceptRisk = args.includes("--accept-read-risk");
    const decisions = await import("./decisions.js");
    const src = { agents: { homedir, env, ...sources } };
    const shown = await decisions.show({ home, id: `agent-profile:${id}`, sources: src });
    if (shown.refused || shown.busy) fail(shown.reason);
    const v = shown.view;
    // What cannot be approved is said first, before any warning about approving it.
    if (v.problems.length) fail(`agent profile ${id} is invalid: ${v.problems.join("; ")}`);
    if (v.unusable) fail(`agent profile ${id} cannot run on this hoptell: ${v.unusable}. Nothing was approved.`);
    out(`Agent profile ${id} (SHA-256 ${v.digest}):`);
    out(JSON.stringify(v.profile, null, 2));
    for (const [mode, line] of Object.entries(v.commandLines ?? {})) out(`${mode}: ${line}`);
    // Before anything is approved: what a Codex run can read with this account (R7). The command
    // is not interactive, so a Codex profile is approved only in a second run, with
    // --accept-read-risk, after the owner read the warning; the flag means nothing elsewhere and is
    // refused there.
    const codex = v.profile?.cli === "codex";
    if (v.headlessMode) {
      // The headless mode by name (design-7.1-read-containment.md), then its text: hardening shows
      // the H4 text before R7; plain shows R7 alone.
      out(`Headless mode: ${HEADLESS_MODE_LABEL[v.headlessMode] ?? `${v.headlessMode} (not offered)`}`);
      out(`Headless modes available on this hoptell: ${v.headlessModes.join(", ") || "none"}`);
      if (v.headlessMode === "hardening") out(HARDENING_APPROVAL_TEXT);
    }
    if (codex) out(`warning: ${CODEX_APPROVAL_WARNING}`);
    if (v.modeRefusal) fail(`${v.modeRefusal}: headless mode ${v.headlessMode} is not available on this hoptell (it is not offered, or its gate has not passed). Nothing was approved.`);
    if (!codex && acceptRisk) fail(`--accept-read-risk applies only to codex profiles; agent profile ${id} uses ${v.profile?.cli ?? "another CLI"}. Nothing was approved.`, 2);
    if (v.state === "approved") return out("Already approved with this digest.");
    if (codex && !acceptRisk) fail(`not approved: read the warning above, then run hoptell agents profile approve ${id} --accept-read-risk`, 1);
    const d = await decisions.decide({ home, id: `agent-profile:${id}`, action: "approve", token: shown.token, sources: src });
    if (d.stale) fail(`agent profile ${id} changed while it was shown (now ${d.token}); run the command again`);
    if (d.refused || d.busy) fail(d.reason);
    out(`Approved: sessions of this home may now use agent profile ${id} (digest ${d.effects.digest}).`);
    return;
  }
  if (sub === "supervise") {
    // Internal: the per-run supervisor, started detached by a spawn.
    const { supervise } = await import("./agentruns.js");
    await supervise(home, rest[0], await supervisorHooks(home), { env });
    process.exit(0);
  }
  if (sub === "exec") {
    // Internal: the agent window of a tmux run. Starts the run's CLI with the environment the
    // supervisor wrote to a private file of the run (read and removed here), never from this
    // process's environment (a running tmux server adds its own global variables).
    const { cliProblem, readRun, runPaths, takeAgentEnvFile } = await import("./agentruns.js");
    const rec = readRun(home, rest[0]);
    if (!rec?.plan?.cli) fail("not a tmux run");
    const e = takeAgentEnvFile(runPaths(home, rec.run));
    if (e.problem) fail(e.problem);
    // Only the CLI file the spawn checked (its digest), right before it starts.
    const changed = cliProblem(rec, rec.plan.cli.command, home);
    if (changed) fail(changed.problem);
    const { spawn } = await import("node:child_process");
    const child = spawn(rec.plan.cli.command, rec.plan.cli.args, { cwd: rec.cwd, env: e.env, stdio: "inherit" });
    process.on("SIGINT", () => {}); // the agent handles Ctrl-C
    child.on("error", (err) => fail(err.message));
    child.on("exit", (code, signal) => process.exit(code ?? (signal ? 128 : 1)));
    return;
  }
  if (sub === "list") {
    const { listRuns, sweep, isLive } = await import("./agentruns.js");
    await sweep(home);
    const all = args.includes("--all");
    const rows = listRuns(home).filter((r) => all || isLive(r) || r.state === "pending-confirmation");
    if (!rows.length) out(all ? "No runs." : "No live runs (hoptell agents list --all shows ended ones).");
    for (const r of rows) out(`${r.run}  ${r.state}  ${r.profile}  ${r.name}  ${r.mode}  ${r.cwd}${r.ends ? `  ends ${r.ends}` : ""}${r.result ? `  result ${r.result.bytes} bytes` : ""}${r.cliVersionUntested ? "  (CLI version untested)" : ""}`);
    return;
  }
  if (sub === "stop") {
    const { stopRun } = await import("./agentruns.js");
    if (!rest[0]) fail("usage: hoptell agents stop <run>", 2);
    const r = await stopRun(home, rest[0], { by: "cli" });
    if (r.refused) fail(r.refused);
    out(`${r.run}: ${r.state}`);
    return;
  }
  if (sub === "result") {
    // The kept result of a run (also when the spawner was gone or unreachable).
    const { readRun, runPaths } = await import("./agentruns.js");
    const { readPrivateFile } = await import("./agents.js");
    if (!rest[0]) fail("usage: hoptell agents result <run>", 2);
    const rec = readRun(home, rest[0]);
    if (!rec) fail(`no run ${rest[0]}`);
    const r = readPrivateFile(runPaths(home, rec.run).result, 16 * 1024 * 1024);
    if (r.problem) fail(r.missing ? `run ${rec.run} (${rec.state}) has no result${rec.mode === "tmux" ? ": a tmux run's result is what the agent sends" : " yet"}` : `the result of ${rec.run} is ${r.problem}`);
    out(`run ${rec.run}, profile ${rec.profile}: ${rec.state}${rec.exit ? ` (${rec.exit.signal ? `signal ${rec.exit.signal}` : `exit code ${rec.exit.code}`})` : ""}${rec.result?.notes?.length ? `; notes: ${rec.result.notes.join("; ")}` : ""}${rec.delivery ? `; delivery: ${rec.delivery.state}${rec.delivery.reason ? ` (${rec.delivery.reason})` : ""}` : ""}`);
    out(r.bytes.toString("utf8"));
    return;
  }
  if (sub === "confirm") {
    // A spawn waiting for the owner (decision kind "spawn"): shows it in full, then starts it with
    // --start or discards it with --discard.
    const run = rest[0];
    if (!run || (args.includes("--start") && args.includes("--discard"))) fail("usage: hoptell agents confirm <run> [--start | --discard]", 2);
    const decisions = await import("./decisions.js");
    const src = { agents: { homedir, env, surface: "cli", ...sources } };
    const shown = await decisions.show({ home, id: `spawn:${run}`, sources: src });
    if (shown.refused || shown.busy) fail(shown.reason);
    const v = shown.view;
    out(`Spawn ${v.run} asked by ${v.spawner ?? "a session"}: profile ${v.profile} (${v.profileState}, SHA-256 ${v.profileDigest}), ${v.mode}, name ${v.name}, roles ${v.roles.join(",")}, cwd ${v.cwd}; expires ${v.expires ?? "-"}.`);
    out(`Command line: ${v.commandLine}`);
    out("Task:");
    out(v.task ?? `(cannot be read: ${v.taskProblem})`);
    const action = args.includes("--start") ? "start" : args.includes("--discard") ? "discard" : null;
    if (!action) return out(`Start it with: hoptell agents confirm ${v.run} --start   (or --discard)`);
    const d = await decisions.decide({ home, id: `spawn:${run}`, action, token: shown.token, sources: src });
    if (d.stale) fail(`the spawn ${run} changed while it was shown; run the command again`);
    if (d.refused || d.busy) fail(d.reason);
    out(action === "discard" ? `Discarded: ${run}.` : `Started: ${run} (${d.effects.state}).`);
    return;
  }
  if (sub === "audit") {
    const { readAudit } = await import("./agents.js");
    const at2 = args.indexOf("--run");
    for (const e of readAudit(home, { run: at2 >= 0 ? args[at2 + 1] : null })) out(JSON.stringify(e));
    return;
  }
  fail(`unknown agents command "${sub}" (see hoptell agents --help)`, 2);
}

/** What the supervisor needs beyond lib/agentruns.js: the name probe, the result delivery and the tmux start. */
export async function supervisorHooks(home) {
  const { BIN } = await import("./config.js");
  const { probeNames, deliverResult } = await import("./agentspawn.js");
  return {
    // Runs a spawn created carry `probe` (their relays file has the granted entries).
    beforeAgent: (rec) => (rec.probe ? probeNames(home, rec) : undefined),
    deliver: (rec, result) => (rec.probe ? deliverResult(home, rec, result) : undefined),
    launchTmux: async (rec, { ids, base }) => {
      const { launchDetached } = await import("./tmux.js");
      return launchDetached(rec.name, [process.execPath, BIN, "agents", "exec", rec.run, "--home", home], { ids, base, cwd: rec.cwd });
    },
  };
}
