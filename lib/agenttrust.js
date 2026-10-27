// Owner approval of an untested Codex binary for plain headless runs. A gate run qualifies exact
// binaries (lib/agentadapters.js GATES); a newer Codex build is refused until the owner approves
// that exact binary (version, launcher digest, native binary digest) once, in a terminal, with
// `hoptell agents trust-cli <profile>`. Only the binary may differ: the profile's argument shape
// must be a gated shape, and at every spawn the automatic checks must pass (the help of
// `codex exec`, the feature list with the run's overrides, no local managed Codex configuration).
// Hardening, tmux and the other CLIs stay exact-gated.
//
//   <home>/agents/trusted-cli.json   0600, {version: 1, binaries: [{cli, version, launcher, native, approved}]}
//
// Only lib/agentscli.js (the owner's terminal command) writes the file: no MCP tool, peer message,
// UI action or environment variable approves a binary.
import fs from "node:fs";
import path from "node:path";
import { agentsPaths, ensureAgentsDirs, readPrivateFile } from "./agents.js";
import { writeRecord } from "./locks.js";
import { CODEX_FEATURES_OFF, GATES, TESTED, featuresNotOff, gateFor } from "./agentadapters.js";
import { ETC_CODEX, managedSources } from "./agentdeny.js";

const TRUSTED_MAX = 64 * 1024;
const HEX = /^[0-9a-f]{64}$/;

/** The approvals file of a home. */
export const trustedPath = (home) => path.join(agentsPaths(home).dir, "trusted-cli.json");

/**
 * `codex features list` of the newest tested build (0.164.0) with the run's overrides
 * (test/fixtures/help/codex-features-0.164.0.txt): the features on, and the features off.
 */
export const TESTED_FEATURES = {
  version: "0.164.0",
  on: [
    "api_key_cyber_access_programs", "api_key_model_discovery", "auth_elicitation",
    "bedrock_setup_wizard", "browser_annotation_api", "cli_daybreak", "code_mode_host",
    "code_mode_interrupt", "collaboration_modes", "compaction_image_budget", "content_item_kinds",
    "daemon_auto_start", "enable_request_compression", "fast_mode", "guardian_approval",
    "guardian_reuse_parent_compaction", "in_app_browser", "in_app_chat", "in_app_dictation",
    "in_app_local_automation", "in_app_updates", "in_app_voice", "instant_interrupt", "item_ids",
    "mcp_oauth_refresh_coordination", "mentions_v2", "plugin_sharing", "realtime_conversation",
    "remote_plugin", "resize_all_images", "shell_snapshot", "shell_tool",
    "skill_mcp_dependency_install", "skill_search", "sleep_tool", "sqlite", "steer",
    "system_proxy_fallback", "terminal_resize_reflow", "tool_call_mcp_elicitation",
    "tool_search_always_defer_mcp_tools", "tool_suggest", "tui_app_server", "ultrafast_mode",
    "unbounded_connection_retries", "unified_exec", "unified_exec_tty", "view_image",
    "workspace_dependencies", "worktrees", "write_stdin_approval",
  ],
  off: [
    "agent_message_board", "analytics_plan_history", "app_server_websocket_compression",
    "apply_patch_freeform", "apply_patch_preserve_line_endings", "apply_patch_streaming_events",
    "apps", "apps_mcp_path_override", "artifact", "async_compaction",
    "background_paginated_rollout_migration", "browser_use", "browser_use_external",
    "browser_use_full_cdp_access", "chronicle", "code_mode", "code_mode_buffered_exec",
    "code_mode_host_grpc", "code_mode_only", "code_mode_only_strict_3p_tools", "code_mode_prewarm",
    "code_mode_tool_description_first", "code_mode_tool_search", "codex_apps_mcp_2026_07_28",
    "codex_git_commit", "computer_use", "concurrent_reasoning_summaries", "context_management",
    "credential_masking", "current_time_reminder", "cwd_relative_turn_diffs",
    "default_mode_request_user_input", "defer_mailbox_preemption", "deferred_executor",
    "deferred_tool_world_state", "elevated_windows_sandbox", "enable_fanout", "enable_mcp_apps",
    "exec_permission_approvals", "executed_tool_call_metadata", "executor_capability_discovery",
    "executor_capability_discovery_v2", "experimental_windows_sandbox",
    "external_agent_memory_import", "external_migration", "goals",
    "guardian_conversation_history_tools", "guardian_enhanced_node_repl_transcripts", "guardian_ext",
    "guardian_node_repl_transcript_images", "guardian_root_handoff_context",
    "guardian_trust_orchestrator_connectors", "guardianv2", "guardianv2.thread_context",
    "guardianv2_decisions_comparison", "hooks", "image_detail_original", "image_generation",
    "image_resize_notice", "incremental_tools", "js_repl", "js_repl_tools_only",
    "local_thread_store_compression", "local_thread_store_shared_compression",
    "login_shell_package_path", "mcp_2026_07_28", "mcp_tool_list_changed", "memories",
    "model_catalog_in_context", "multi_agent", "multi_agent_mode", "multi_agent_v2",
    "multi_agent_v2_dynamic_tools", "multi_env_copy_file", "network_proxy",
    "non_prefixed_mcp_tool_names", "nonfatal_clock_read_errors",
    "omit_app_server_notification_media", "output_token_replay", "personality", "plugin_hooks",
    "plugins", "powershell_shell_version", "prefer_mxc", "prevent_idle_sleep", "psp",
    "reasoning_effort_override", "recommended_plugins", "remote_compaction_v2", "remote_control",
    "remote_models", "request_permissions_tool", "request_rule", "respect_system_proxy",
    "responses_websockets", "responses_websockets_v2", "retain_client_developer_messages",
    "retain_client_tool_outputs", "rollout_budget", "runtime_agent_instances", "runtime_metrics",
    "search_tool", "secret_auth_storage", "send_async_message", "send_message_to_user_async",
    "shell_snapshot_v2", "shell_zsh_fork", "skill_env_var_dependency_prompt",
    "skip_host_skill_discovery", "stable_environment_tools", "standalone_web_search",
    "step_model_switching", "subagent_default_context_limits", "subagent_thread_environments",
    "terminal_visualization_instructions", "token_budget", "tool_search", "transcript_v2",
    "unavailable_dummy_tools", "undo", "unified_exec_zsh_fork", "unified_image_budget",
    "use_agent_identity", "use_legacy_landlock", "use_linux_sandbox_bwrap", "use_xaa",
    "wake_on_agent_messages", "web_search_cached", "web_search_request", "windows_sandbox_service",
    "workspace_owner_usage_nudge",
  ],
};
/**
 * The features that may be on in an untested binary: those on in a build whose gates all passed,
 * with the arguments it was gated with (0.164.0; 0.162.1 adds unified_exec_zsh_fork).
 */
export const REVIEWED_ON = [...TESTED_FEATURES.on, "unified_exec_zsh_fork"];

/** The rows of a `codex features list` output: Map name -> on (true/false); null when unreadable. */
function featureRows(list) {
  const rows = new Map();
  for (const line of String(list).split("\n")) {
    if (!line.trim()) continue;
    const m = line.match(/^(\S+)\s+(stable|experimental|under development|deprecated|removed)\s+(true|false)\s*$/);
    if (!m || rows.has(m[1])) return null;
    rows.set(m[1], m[3] === "true");
  }
  return rows;
}

/**
 * The feature check of an untested binary (`list`: its `codex features list` with the run's
 * overrides): {problems, added, changed}. A problem: a CODEX_FEATURES_OFF entry missing or on, or
 * any feature on outside REVIEWED_ON (a new one included). `added`: names the tested build does
 * not list (off ones do not block); `changed`: names whose on/off differs from the tested build.
 */
export function featureCheck(list) {
  const problems = [...featuresNotOff(list, CODEX_FEATURES_OFF)];
  const rows = featureRows(list);
  if (!rows) return { problems: problems.length ? problems : ["the feature list cannot be read"], added: [], changed: [] };
  const tested = new Map([...TESTED_FEATURES.on.map((f) => [f, true]), ...TESTED_FEATURES.off.map((f) => [f, false])]);
  for (const [f, on] of rows) if (on && !REVIEWED_ON.includes(f)) problems.push(`feature ${f} is on and was not on in a gated build`);
  const added = [...rows.keys()].filter((f) => !tested.has(f)).map((f) => `${f} (${rows.get(f) ? "on" : "off"})`);
  const changed = [...rows.keys()].filter((f) => tested.has(f) && tested.get(f) !== rows.get(f)).map((f) => `${f} (${rows.get(f) ? "off -> on" : "on -> off"})`);
  const gone = [...tested.keys()].filter((f) => !rows.has(f)).map((f) => `${f} (no longer listed)`);
  return { problems, added, changed: [...changed, ...gone] };
}

/** The approved binaries: {binaries, problem}. */
export function readTrusted(home) {
  const file = trustedPath(home);
  const r = readPrivateFile(file, TRUSTED_MAX);
  if (r.missing) return { binaries: [], problem: null };
  if (r.problem) return { binaries: [], problem: `${file}: ${r.problem}` };
  try {
    const doc = JSON.parse(r.bytes.toString("utf8"));
    if (doc?.version !== 1 || !Array.isArray(doc.binaries)) throw new Error();
    const binaries = doc.binaries.filter((b) => b && b.cli === "codex" && typeof b.version === "string" && HEX.test(b.launcher ?? "") && HEX.test(b.native ?? "")).map((b) => ({ cli: b.cli, version: b.version, launcher: b.launcher, native: b.native, approved: String(b.approved ?? "") }));
    return { binaries, problem: null };
  } catch {
    return { binaries: [], problem: `${file}: not a valid approvals file` };
  }
}

/** Whether the owner approved this exact binary ({version, digest (the launcher's), native}). */
export function isTrusted(home, cli, facts) {
  const f = facts ?? {};
  if (typeof f.version !== "string" || !HEX.test(f.digest ?? "") || !HEX.test(f.native ?? "")) return false;
  return readTrusted(home).binaries.some((b) => b.cli === cli && b.version === f.version && b.launcher === f.digest && b.native === f.native);
}

/** Record an approval (the owner's terminal command only; the caller holds the agents lock). */
export function writeTrustedCli(home, { cli, version, launcher, native }, now = new Date()) {
  ensureAgentsDirs(home);
  const cur = readTrusted(home);
  if (cur.problem && fs.existsSync(trustedPath(home))) throw new Error(`${cur.problem}; fix or remove it first`);
  const rest = cur.binaries.filter((b) => !(b.cli === cli && b.version === version && b.launcher === launcher && b.native === native));
  writeRecord(trustedPath(home), { version: 1, binaries: [...rest, { cli, version, launcher, native, approved: now.toISOString() }] }, 2);
}

/** Remove the approvals whose launcher or native digest starts with `prefix` (12+ hex); the removed ones. */
export function revokeTrustedCli(home, prefix) {
  if (!/^[0-9a-f]{12,64}$/.test(prefix ?? "")) throw new Error("give at least 12 hex characters of a launcher or native digest");
  const cur = readTrusted(home);
  if (cur.problem) throw new Error(cur.problem);
  const removed = cur.binaries.filter((b) => b.launcher.startsWith(prefix) || b.native.startsWith(prefix));
  if (removed.length) writeRecord(trustedPath(home), { version: 1, binaries: cur.binaries.filter((b) => !removed.includes(b)) }, 2);
  return removed;
}

/**
 * The local managed Codex configuration (lib/agentdeny.js): on macOS the /etc/codex files and the
 * com.openai.codex managed preferences; on Linux the /etc/codex files. null when none is present,
 * {present} or {problem} (refused like present).
 */
export function localManagedConfig({ platform = process.platform, fsx = fs } = {}) {
  if (platform === "darwin") return managedSources();
  if (platform !== "linux") return { problem: `untested Codex binaries can be approved on macOS and Linux only, not ${platform}` };
  const present = [];
  for (const f of ETC_CODEX) {
    try {
      fsx.lstatSync(f);
      present.push(f);
    } catch (e) {
      if (e?.code !== "ENOENT") return { problem: `${f} cannot be checked (${e.code ?? "error"})` };
    }
  }
  return present.length ? { present } : null;
}

/**
 * Whether the untested-binary path applies: Codex headless plain, with a gated argument shape, on
 * a binary the gates did not record. Hardening and the other CLIs and modes never use it.
 */
export function trustApplies(cli, mode, headlessMode, facts, gates = GATES) {
  if (cli !== "codex" || mode !== "headless" || headlessMode !== "plain") return false;
  const g = gateFor(cli, mode, "plain", gates);
  return Boolean(g?.passed && typeof facts?.shape === "string" && g.passed.shapes.includes(facts.shape));
}

/**
 * The untested-binary gate, for a binary the gates refused (gateRefusal): null when it does not
 * apply (the caller keeps the gate's refusal), {trusted: true}, or {code, message}. `features`: the
 * binary's feature list with the run's overrides (checkCli), checked when given; the local managed
 * Codex configuration is checked every time. `profile`: the id the refusal names.
 */
export function untestedGate(home, { cli, mode, headlessMode, facts, gates = GATES, features, profile, managed = localManagedConfig }) {
  if (!trustApplies(cli, mode, headlessMode, facts, gates)) return null;
  // An approval names a version and both digests, so without them it cannot apply: the gate's refusal stands.
  if (!facts.version || !HEX.test(facts.digest ?? "") || !HEX.test(facts.native ?? "")) return null;
  const v = facts.version;
  if (!isTrusted(home, cli, facts)) return { code: "adapter_gate_unverified", message: `codex ${v} (launcher ${facts.digest.slice(0, 12)}, native ${facts.native.slice(0, 12)}) has not passed hoptell's gate runs (tested: ${TESTED.codex.join(", ")}); to use this exact binary, approve it once in your own terminal: hoptell agents trust-cli ${profile ?? "<profile>"}` };
  if (features !== undefined) {
    const f = featureCheck(features);
    if (f.problems.length) return { code: "cli_flags_changed", message: `codex ${v} was approved, but its feature check fails: ${f.problems.join("; ")}` };
  }
  const m = managed();
  if (m?.problem) return { code: "adapter_gate_unverified", message: `codex ${v} was approved, but local managed Codex configuration cannot be ruled out: ${m.problem}` };
  if (m?.present) return { code: "adapter_gate_unverified", message: `codex ${v} was approved, but local managed Codex configuration is present: ${m.present.join(", ")}` };
  return { trusted: true };
}
