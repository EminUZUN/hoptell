// How incoming messages reach a local agent session. Exactly one way per session:
//   channel  - Claude Code with the hoptell channel: a <channel> notice wakes it
//   hook     - Claude Code with the hoptell hooks (lib/wake.js): a fixed hook notice wakes it
//   tmux     - `hoptell tmux`: an injector types a fixed notice into the agent's terminal
//   listener - the agent runs `hoptell listen` in the background, or checks read_inbox itself
// HOPTELL_PUSH chooses one; unset means auto: channel when the channel flag is on, else hook
// when the hooks answered a silent check for this Claude Code process, else listener.
import { channelEnabled, findClaudeHost } from "./host.js";

export const MODES = ["channel", "hook", "tmux", "listener"];

/** Parse HOPTELL_PUSH: "auto" when unset or empty; throws a fixed message when invalid. */
export function requestedMode(value = process.env.HOPTELL_PUSH) {
  const v = String(value ?? "").trim();
  if (v === "") return "auto";
  if (MODES.includes(v)) return v;
  throw new Error("HOPTELL_PUSH must be channel, hook, tmux or listener (or unset for automatic)");
}

/**
 * Pick the mode for an MCP server. `armHook(host)` tries hook delivery for a Claude Code
 * process and resolves to {state: "verified"|"unverified"|"busy", channel}. Returns
 * {mode, requested, hook: channel or null, verified}.
 */
export async function resolveDelivery({ value = process.env.HOPTELL_PUSH, armHook, findHost = findClaudeHost } = {}) {
  const requested = requestedMode(value);
  if (requested === "channel" || requested === "tmux" || requested === "listener") return { mode: requested, requested, hook: null, verified: false };
  const host = findHost(); // inspects processes only when the mode is automatic or hook
  if (requested === "auto" && host && channelEnabled(host)) return { mode: "channel", requested, hook: null, verified: false };
  if (!host) return { mode: requested === "hook" ? "hook" : "listener", requested, hook: null, verified: false };
  const { state, channel } = await armHook(host);
  if (state === "verified") return { mode: "hook", requested, hook: channel, verified: true };
  if (requested === "hook") return { mode: "hook", requested, hook: state === "busy" ? null : channel, verified: false };
  channel?.close();
  return { mode: "listener", requested, hook: null, verified: false };
}
