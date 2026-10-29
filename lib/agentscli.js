// `hoptell agents ...` (design 7.1): agent profiles, their approval, and runs.
import path from "node:path";
import { CODEX_APPROVAL_WARNING, HARDENING_APPROVAL_TEXT, HEADLESS_MODE_LABEL, agentsPaths, approvalOf, listProfiles, readApproved } from "./agents.js";

const STATE_TEXT = { approved: "approved", changed: "CHANGED since you approved it (not usable until approved again)", unapproved: "not approved yet (not usable)", invalid: "INVALID (not usable)" };

const VALUE_FLAGS = ["--home", "--run", "--revoke", "--role", "--model", "--effort", "--lead", "--template"];

/**
 * Run one `hoptell agents` command. `env` and `homedir` are the CLI's (an entry point reads them);
 * `fail(message, code)` ends the process; `warn` prints a warning (standard error).
 */
export async function agentsCommand({ args, home: defaultHome, env, homedir, fail, out = console.log, warn = console.error, sources = {} }) {
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
      // Model and effort as the profile sets them; unset, the CLI's own default applies.
      const o = r.profile?.cliOptions ?? {};
      out(`${r.id}  ${STATE_TEXT[state]}${r.profile ? `  ${r.profile.cli}, ${r.profile.modes.join("/")}, ${r.profile.sandbox}, model ${o.model ?? "CLI default"}, effort ${o.effort ?? "CLI default"}` : ""}`);
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
  if (sub === "trust-cli") return trustCli({ args, rest, home, env, homedir, fail, out, sources });
  if (sub === "capabilities") return capabilitiesCommand({ args, rest, home, env, homedir, fail, out, sources });
  if (sub === "flags") return flagsCommand({ args, rest, home, env, homedir, fail, out, warn, sources });
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
    for (const r of rows) out(`${r.run}  ${r.state}  ${r.profile}  ${r.name}  ${r.mode}  ${r.cwd}${r.ends ? `  ends ${r.ends}` : ""}${r.result ? `  result ${r.result.bytes} bytes` : ""}${r.cliTrusted ? "  (untested CLI, approved by you)" : r.cliVersionUntested ? "  (CLI version untested)" : ""}`);
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

/** What an approval of an untested Codex binary does not cover, shown before it is given. */
const TRUST_CAVEAT =
  "hoptell has not run its gates on this build: its sandbox, approvals and tool catalog were not observed, only its help and feature list were checked. As for tested builds, the plain mode does not check cloud-delivered Codex configuration. The approval covers this exact binary only; an update needs a new approval.";

/**
 * `hoptell agents trust-cli <profile>`: show the Codex binary the profile runs (version, launcher
 * and native digests), its checks and what changed against the newest tested build, and approve
 * it after the owner types "trust" in a terminal. `--list` shows the approvals, `--revoke <digest
 * prefix>` removes one. Refused inside an agent run (HOPTELL_RUN) and without a terminal: a
 * defense in depth, not the boundary (no MCP tool, peer message or setting reaches this code).
 * `sources.tty` ({isTTY, ask}) and `sources.deps` ({check, gates, managed}) are for tests.
 */
async function trustCli({ args, rest, home, env, homedir, fail, out, sources }) {
  const trust = await import("./agenttrust.js");
  if (args.includes("--list")) {
    const t = trust.readTrusted(home);
    if (t.problem) fail(t.problem);
    if (!t.binaries.length) return out("No approved untested CLI binaries.");
    for (const b of t.binaries) out(`${b.cli} ${b.version}  launcher ${b.launcher}  native ${b.native}  approved ${b.approved}`);
    return;
  }
  const at = args.indexOf("--revoke");
  if (at >= 0) {
    const prefix = args[at + 1];
    let removed;
    try {
      removed = await withAgentsLockOf(home, () => trust.revokeTrustedCli(home, prefix));
    } catch (e) {
      fail(e.message, 2);
    }
    if (!removed.length) fail(`no approval matches ${String(prefix).slice(0, 64)}`);
    for (const b of removed) out(`Revoked: ${b.cli} ${b.version} (launcher ${b.launcher.slice(0, 12)}, native ${b.native.slice(0, 12)}).`);
    return;
  }
  const id = rest[0];
  if (!id) fail("usage: hoptell agents trust-cli <profile> | --list | --revoke <digest prefix>", 2);
  if (env?.HOPTELL_RUN) fail("an agent run cannot approve a CLI binary; run hoptell agents trust-cli in your own terminal");
  const tty = sources.tty ?? { isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY), ask: askLine };
  if (!tty.isTTY) fail("hoptell agents trust-cli asks for your confirmation: run it in an interactive terminal");
  const deps = sources.deps ?? {};
  const { readProfile } = await import("./agents.js");
  const { checkCli, gateRefusal, gateShape, headlessModeOf, resolveCommand } = await import("./agentadapters.js");
  const { agentEnv } = await import("./agentruns.js");
  const read = readProfile(home, id, { homedir, env });
  if (read.missing) fail(`no agent profile ${id}`);
  if (read.problems.length) fail(`agent profile ${id} is invalid: ${read.problems.join("; ")}`);
  const profile = read.profile;
  if (profile.cli !== "codex" || !profile.modes.includes("headless") || headlessModeOf(profile) !== "plain") fail(`only a Codex profile in headless mode plain can run an untested binary; agent profile ${id} is ${profile.cli}, ${profile.modes.join("/")}${profile.cli === "codex" ? `, headless mode ${headlessModeOf(profile)}` : ""}`);
  const cmd = resolveCommand(profile, { pathVar: env?.PATH ?? "" });
  if (cmd.code) fail(cmd.problem);
  const runEnv = agentEnv(env ?? {}, { home, run: "r_0000000000000000", name: "trust-cli", roles: [], pass: profile.env.pass });
  const cli = (deps.check ?? checkCli)(home, profile, "headless", cmd.command, { env: runEnv });
  if (cli.code) fail(cli.missing ? `codex no longer lists ${cli.missing.join(", ")} (version ${cli.version ?? "unknown"}): it cannot be approved` : cli.problem);
  const facts = { version: cli.version ?? null, digest: cli.digest, native: cli.native ?? null, shape: gateShape(profile, "headless") };
  const gates = deps.gates;
  out(`Codex for agent profile ${id}: ${cmd.command}`);
  out(`  version ${facts.version ?? "unknown"}`);
  out(`  launcher SHA-256 ${facts.digest}`);
  out(`  native binary SHA-256 ${facts.native ?? "(not found)"}`);
  if (!gateRefusal("codex", "headless", facts, ...(gates ? [gates] : []))) return out("This binary passed hoptell's gate runs; nothing to approve.");
  if (!trust.trustApplies("codex", "headless", "plain", facts, ...(gates ? [gates] : []))) fail(`the arguments of agent profile ${id} are not a gated shape (sandbox ${profile.sandbox}); an approval cannot change that`);
  if (!facts.version || !facts.native) fail("its version or native binary cannot be identified, so it cannot be approved");
  const f = trust.featureCheck(cli.features ?? "");
  out(`Tested build: ${trust.TESTED_FEATURES.version}. Help of codex exec: as the adapter needs.`);
  out(`New features (not in ${trust.TESTED_FEATURES.version}): ${f.added.join(", ") || "none"}`);
  out(`Changed defaults against ${trust.TESTED_FEATURES.version}: ${f.changed.join(", ") || "none"}`);
  const m = (deps.managed ?? trust.localManagedConfig)();
  out(`Local managed Codex configuration: ${m?.present ? m.present.join(", ") : m?.problem ? `cannot be ruled out (${m.problem})` : "none"}`);
  if (f.problems.length) fail(`not approved: the feature check fails: ${f.problems.join("; ")}`);
  if (m?.problem || m?.present) fail("not approved: local managed Codex configuration is present or cannot be ruled out");
  if (trust.isTrusted(home, "codex", facts)) return out("Already approved.");
  out(TRUST_CAVEAT);
  const answer = String((await tty.ask('Type "trust" to approve this exact binary: ')) ?? "").trim();
  if (answer !== "trust") fail("Nothing was approved.");
  await withAgentsLockOf(home, () => trust.writeTrustedCli(home, { cli: "codex", version: facts.version, launcher: facts.digest, native: facts.native }));
  out(`Approved: codex ${facts.version} (launcher ${facts.digest.slice(0, 12)}, native ${facts.native.slice(0, 12)}) for plain headless runs. Revoke with: hoptell agents trust-cli --revoke ${facts.native.slice(0, 12)}`);
}

/** The capability options of this CLI's environment; `sources.capabilities` (tests): {run, now, tmpdir, shipped}. */
const capOptions = (home, env, homedir, sources) => ({ home, pathVar: env?.PATH ?? "", homedir, codexHome: env?.CODEX_HOME || undefined, lang: env?.LANG, ...(sources.capabilities ?? {}) });

/** A model list in one line: listed ids with their efforts and default; hidden ones counted. */
function modelsLine(l, now, ageOf) {
  const shown = l.list.filter((m) => !m.hidden);
  const hidden = l.list.length - shown.length;
  const label = l.source === "codex debug models --bundled" ? "bundled with this binary" : `cached account list, fetched ${l.fetched_at ? ageOf(l.fetched_at, now) : "at an unknown time"}, account not verified${l.client_version ? `, by version ${l.client_version}` : ""}`;
  const items = shown.map((m) => `${m.id}${m.aliases.length ? ` (${m.aliases.join(", ")})` : ""} [${m.efforts.join(", ") || "no effort levels"}${m.default_effort ? `; default ${m.default_effort}` : ""}]`);
  return `models (${label}): ${items.join(", ") || "none listed"}${hidden ? `; ${hidden} hidden` : ""}`;
}

/**
 * `hoptell agents capabilities [codex|claude|agy] [--refresh] [--diff] [--json]`: what each CLI
 * offers (availability), what hoptell's tests verified (behaviour), and what changed.
 */
async function capabilitiesCommand({ args, rest, home, env, homedir, fail, out, sources }) {
  const cap = await import("./capabilities.js");
  const clis = rest.length ? rest : cap.CAPABILITY_CLIS;
  for (const c of clis) if (!cap.CAPABILITY_CLIS.includes(c)) fail(`usage: hoptell agents capabilities [${cap.CAPABILITY_CLIS.join("|")}] [--refresh] [--diff] [--json] (not "${String(c).slice(0, 40)}")`, 2);
  const now = (sources.capabilities?.now ?? Date.now)();
  const results = clis.map((cli) => {
    const before = cap.storedRecords(home, cli);
    const r = cap.safeCapabilities(cli, { ...capOptions(home, env, homedir, sources), refresh: args.includes("--refresh") });
    // --diff: what changed now, else against the record kept before the last change.
    const prev = r.changes ? before.current : cap.storedRecords(home, cli).previous;
    const diff = r.changes ?? (prev && r.record.fingerprint ? cap.diffRecords(prev, r.record) : null);
    return { cli, ...r, diff, since: prev?.recorded_at ?? null };
  });
  if (args.includes("--json")) {
    out(JSON.stringify(results.map(({ cli, record, changes, diff, since }) => ({ cli, record, verified: cap.verifiedFor(cli, record.version), changes, ...(args.includes("--diff") ? { diff, since } : {}) })), null, 2));
    return;
  }
  for (const { cli, record: r, changes, diff, since } of results) {
    if (!r.present || !r.binary) {
      out(`${cli}: ${r.warnings.join("; ")}`);
      continue;
    }
    out(`${cli} ${r.version ?? "(version unknown)"}  ${r.command}  (launcher ${r.binary.launcher.slice(0, 12)}${r.binary.native && r.binary.native !== r.binary.launcher ? `, native ${r.binary.native.slice(0, 12)}` : ""})`);
    out(`  probed ${r.probed_at ?? "never"}; version first seen ${r.version_first_seen}; fingerprint ${r.fingerprint.slice(0, 12)}`);
    out(`  options in --help: ${r.flags ? r.flags.length : "unknown"} (available, unverified unless listed under "verified")`);
    for (const [k, v] of Object.entries(r.enums ?? {})) out(`  ${k.replace("_", " ")} values: ${v.join(", ") || "unknown"}`);
    if (r.aliases?.length) out(`  model aliases in --help: ${r.aliases.join(", ")}`);
    for (const l of [r.account, r.bundled].filter(Boolean)) out(`  ${modelsLine(l, now, cap.ageOf)}`);
    if (r.models_note) out(`  models: unknown, ${r.models_note}`);
    else if (!r.account && !r.bundled) out("  models: unknown");
    out(`  default model: ${r.default_model} (your CLI settings decide)`);
    if (r.changelog?.length) out(`  changelog: ${r.changelog.slice(0, 5).join(", ")}${r.changelog.length > 5 ? ", ..." : ""}`);
    const v = cap.verifiedFor(cli, r.version);
    out(`  verified by hoptell's tests:${v.length ? "" : " nothing yet"}`);
    for (const x of v) out(`    ${x.mechanism}: ${x.class} on ${x.min === x.max ? x.min : `${x.min} to ${x.max}`}${x.holds ? "" : ` (not verified on ${r.version ?? "this version"})`}; ${x.evidence}`);
    for (const w of r.warnings) out(`  warning: ${w}`);
    if (changes) out(`  changed since the last record: ${changes.join("; ")}`);
    if (args.includes("--diff")) out(diff ? `  difference from the record of ${since ?? "an earlier run"}: ${diff.join("; ")}` : "  no earlier record to compare with");
  }
}

/**
 * `hoptell agents flags <cli> --role <role> [--model m] [--effort e] [--json]`: the CLI and flags of
 * an interactive launch (`hoptell tmux <name> --roles ... -- <these> <prompt>`), from the role
 * preset and the request, checked against the capability record. Warnings never refuse; a refusal
 * is an agy effort without a model id, a role that is not offered, or a malformed value.
 */
async function flagsCommand({ args, rest, home, env, homedir, fail, out, warn, sources }) {
  const cap = await import("./capabilities.js");
  const { shellLine } = await import("./agentadapters.js");
  const opt = (name) => {
    const at = args.indexOf(name);
    if (at < 0) return undefined;
    const v = args[at + 1];
    if (v === undefined || v.startsWith("--")) fail(`${name} needs a value`, 2);
    return v;
  };
  const cli = rest[0];
  const role = opt("--role");
  const usage = `usage: hoptell agents flags <${cap.CAPABILITY_CLIS.join("|")}> --role <${cap.ROLES.join("|")}> [--model <model>] [--effort <effort>] [--lead <name> [--template <reviewer|implementer|tester>]] [--json]`;
  if (!cli || rest.length > 1 || !role) fail(usage, 2);
  if (!cap.CAPABILITY_CLIS.includes(cli)) fail(`${usage} (not "${String(cli).slice(0, 40)}")`, 2);
  let presets;
  try {
    presets = cap.loadPresets(home, sources.capabilities?.shipped ? { shipped: sources.capabilities.shipped } : {});
  } catch (e) {
    fail(e.message);
  }
  const { record, changes } = cap.safeCapabilities(cli, capOptions(home, env, homedir, sources));
  const r = cap.resolveLaunch(cli, role, { model: opt("--model"), effort: opt("--effort") }, { record, presets, now: (sources.capabilities?.now ?? Date.now)() });
  if (r.refused) fail(r.refused);
  // A team member (design 8, topic 4): the role template and the fixed launch prompt, placed with
  // the CLI's own per-session flag. The task goes to hoptell tmux --task, never here.
  const lead = opt("--lead");
  const templateName = opt("--template");
  if (templateName !== undefined && lead === undefined) fail(`--template needs --lead\n${usage}`, 2);
  let template = null;
  let launchArgs = r.args;
  if (lead !== undefined) {
    const roles = await import("./roles.js");
    try {
      const name = templateName ?? role;
      const t = roles.roleTemplate(name, { homedir });
      const placed = roles.templateArgs(cli, { text: roles.renderTemplate(t.text, { lead }), prompt: roles.launchPrompt(name, lead) }, record);
      template = { name, from: t.from, file: t.file, placement: placed.placement };
      launchArgs = [...r.args, ...placed.args];
      r.warnings.push(...placed.warnings);
    } catch (e) {
      fail(e.message);
    }
  }
  const warnings = [...presets.warnings, ...record.warnings, ...(changes ? [`${cli} changed since its last capability record (${changes.join("; ")}); see hoptell agents capabilities ${cli} --diff`] : []), ...r.warnings];
  if (args.includes("--json")) return out(JSON.stringify({ cli, role, command: cli, args: launchArgs, line: shellLine(cli, launchArgs), model: r.model, effort: r.effort, preset: { from: r.preset.from, source: r.preset.source ?? null, checked: r.preset.checked ?? null }, template, warnings }, null, 2));
  out(shellLine(cli, launchArgs));
  for (const w of warnings) warn(`warning: ${w}`);
}

const withAgentsLockOf = async (home, fn) => (await import("./agents.js")).withAgentsLock(home, fn);

/** One line from the terminal. */
async function askLine(question) {
  const readline = await import("node:readline/promises");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}
