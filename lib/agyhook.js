// Stop-hook delivery for Antigravity (agy): when an agy turn ends while peer messages wait in this
// session's inbox, the hook keeps agy running with the fixed notice, so it calls read_inbox
// instead of leaving the messages until the user types again.
//
// agy runs hooks only around its own turns (antigravity.google/docs/hooks): a Stop hook that
// answers {"decision": "continue", "reason": ...} re-enters the loop with the reason as a system
// message. No hook runs while agy is idle, so this does not wake an idle session; `hoptell tmux`
// does that. The session is found by HOPTELL_NAME, which the hook inherits from agy; without it the
// hook does nothing. Under `hoptell tmux` (HOPTELL_PUSH=tmux) the injector announces messages, so
// the hook does nothing either.
//
// The notice never contains message text, a sender or other peer-supplied data. Each waiting
// message is announced once: an agent that does not read it is not kept running, and a new
// message always gets a notice.
//
// ~/.hoptell/wake/agy-<name>.stop.json (0600): the inbox entries already announced (entry names
// only, as the tmux injector lists them; no message text, sender, relay URL or token).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { BIN, NAME_RE, shellQuote } from "./config.js";
import { HELD_NOTICE, NOTICE, isHeldEntry } from "./notices.js";
import { noticeLister } from "./tmux.js";
import { ensureWakeDir } from "./wake.js";

const MAX_ANNOUNCED = 1000;
const MAX_STATE = 256 * 1024;
export const ALLOW = Object.freeze({ decision: "allow" });

/**
 * The hooks.json entry for agy (~/.gemini/config/hooks.json or <workspace>/.agents/hooks.json):
 * a hook named "hoptell" with one Stop handler. agy runs `command` as one command line.
 */
export function agyHooksSnippet(node, home) {
  const command = [node, BIN, "hook-agy-stop", ...(home ? ["--home", home] : [])].map(shellQuote).join(" ");
  return { hoptell: { Stop: [{ type: "command", command, timeout: 10 }] } };
}

const stateFile = (home, name) => path.join(ensureWakeDir(home), `agy-${name}.stop.json`);

function readAnnounced(file) {
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.size > MAX_STATE) return [];
    const doc = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(doc?.announced) ? doc.announced.filter((f) => typeof f === "string") : [];
  } catch {
    return [];
  }
}

function writeAnnounced(file, announced) {
  const tmp = `${file}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify({ announced }), { mode: 0o600, flag: "wx" });
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

/**
 * The Stop hook's answer for the agy session of `env` (its HOPTELL_NAME and HOPTELL_PUSH): the
 * fixed notice with "continue" when messages wait that were not announced yet, else ALLOW.
 * `relay` is {relayUrl, protocol, profile} of the session's settings; `list` stands in for
 * noticeLister in tests.
 */
export async function hookAgyStop({ home, env, relay, list = noticeLister }) {
  const name = env.HOPTELL_NAME;
  if (!name || !NAME_RE.test(name)) return ALLOW;
  if (String(env.HOPTELL_PUSH ?? "").trim() === "tmux") return ALLOW;
  const entries = await list(home, name, relay)();
  const file = stateFile(home, name);
  const announced = readAnnounced(file);
  const known = new Set(announced);
  const fresh = entries.filter((f) => !known.has(f));
  // Entries that no longer wait (read or expired) are forgotten; a later message gets its notice.
  const waiting = new Set(entries);
  const next = [...announced.filter((f) => waiting.has(f)), ...fresh].slice(-MAX_ANNOUNCED);
  if (next.length !== announced.length || fresh.length) writeAnnounced(file, next);
  if (!fresh.length) return ALLOW;
  return { decision: "continue", reason: fresh.every(isHeldEntry) ? HELD_NOTICE : NOTICE };
}
