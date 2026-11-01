// Read without a reply: a request this session read and left unanswered. When the session's turn
// ends with no message back to the sender, the sender gets one automated notice, so a peer that
// waits for a reply is not left waiting on an agent that declined, stopped or waits on its user.
// The end of a turn: for a tmux session, no change on its pane's screen for QUIET_MS; for Claude
// Code with the hoptell hooks, TURN_GRACE_MS after the Stop hook's record (lib/wake.js
// readTurnEnd). Requests only: a reply (reply_to), an owner-channel message, a command-line send
// without a reply destination, a message to @all and hoptell's own automated notices are never
// tracked. Any message to the sender by name counts as the answer.
import { spawnSync } from "node:child_process";

export const QUIET_MS = 60_000;
export const TURN_GRACE_MS = 30_000;
export const CHECK_MS = 5000;
export const RETRY_MS = 60_000; // a notice the relay did not take is tried again after this
export const TRIES = 5;
export const AUTO_PREFIX = "hoptell: automated notice";
const DONE_MAX = 1000;
const REF_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Is `m` (a stored message) a request whose sender waits for a reply from `self`? */
export function isRequest(m, self) {
  if (!m || typeof m.from !== "string" || !m.from || m.from === self) return false;
  if (m.owner || m.noReply || m.reply_to != null || m.to === "@all") return false;
  return !String(m.text ?? "").startsWith(AUTO_PREFIX);
}

/**
 * The tracker: read(msgs, self) notes the requests among messages the agent was shown;
 * answered(to) drops a sender once the session sent it something by name; due({stillSince,
 * turnEnd}) lists the senders to tell now ([{to, refs, at}]) without changing anything; told(d)
 * forgets what a notice covered (a request read since stays); failed(d) keeps it for another try
 * after RETRY_MS, at most TRIES times (a notice that may have reached the relay counts as told:
 * maybeSent). `at` is when the latest request was read, so a turn must
 * end after it. `stillSince`: since when the pane's screen has not changed (tmux); `turnEnd`:
 * when the last turn ended (Claude Code hooks); either may be null (unknown: never taken for an
 * ended turn).
 */
export function unansweredTracker({ now = Date.now, quietMs = QUIET_MS, graceMs = TURN_GRACE_MS, retryMs = RETRY_MS } = {}) {
  const open = new Map(); // sender -> {refs, at, tries, next}
  const done = new Set(); // refs answered or told: a redelivered copy is not tracked again
  const busy = new Map(); // sender -> messages to it being sent now
  const finish = (refs) => {
    for (const r of refs) {
      done.add(r);
      if (done.size > DONE_MAX) done.delete(done.values().next().value);
    }
  };
  return {
    read(msgs, self) {
      for (const m of msgs) {
        if (!isRequest(m, self)) continue;
        const ref = REF_RE.test(String(m.message_id)) ? m.message_id : null;
        if (ref && done.has(ref)) continue;
        const e = open.get(m.from) ?? { refs: [], at: 0, tries: 0, next: 0 };
        if (ref && e.refs.includes(ref)) continue; // shown again (redelivered): its read time stays
        if (ref) e.refs.push(ref);
        // A new request: its own turn end, and its own tries.
        Object.assign(e, { at: now(), tries: 0, next: 0 });
        open.set(m.from, e);
      }
    },
    answered(to) {
      const e = open.get(to);
      if (!e) return;
      finish(e.refs);
      open.delete(to);
    },
    due({ stillSince = null, turnEnd = null } = {}) {
      const t = now();
      const out = [];
      for (const [to, e] of open) {
        if (t < e.next) continue;
        const quiet = Number.isFinite(stillSince) && t - Math.max(stillSince, e.at) >= quietMs;
        const ended = Number.isFinite(turnEnd) && turnEnd > e.at && t - turnEnd >= graceMs;
        if (quiet || ended) out.push({ to, refs: [...e.refs], at: e.at });
      }
      return out;
    },
    /**
     * Is `d` (from due()) still unanswered, with nothing read since and no message to its sender
     * being sent (sending(to) to done(to))? Asked right before its send.
     */
    still(d) {
      const e = open.get(d.to);
      return Boolean(e && e.at === d.at && !busy.has(d.to));
    },
    /** A message to `to` by name is being sent: no notice goes to it meanwhile. */
    sending(to) {
      busy.set(to, (busy.get(to) ?? 0) + 1);
    },
    sent(to) {
      const n = (busy.get(to) ?? 1) - 1;
      if (n > 0) busy.set(to, n);
      else busy.delete(to);
    },
    told(d) {
      finish(d.refs);
      const e = open.get(d.to);
      if (!e) return;
      e.refs = e.refs.filter((r) => !d.refs.includes(r));
      if (!e.refs.length && e.at === d.at) open.delete(d.to);
    },
    failed(d) {
      const e = open.get(d.to);
      if (!e || e.at !== d.at) return; // a request read since starts over
      e.tries++;
      e.next = now() + retryMs;
      if (e.tries >= TRIES) this.answered(d.to);
    },
    size: () => open.size,
  };
}

/**
 * Did a failed send perhaps reach the relay? The connection was lost, the client closed, or the
 * relay did not answer in time, after the frame went out (lib/client.js). A notice is then not
 * sent again, so a sender never gets it twice; a reply is then taken as given.
 */
export const maybeSent = (text) => /connection to relay lost|closed before the relay answered|relay did not answer in time/.test(String(text));

/** The notice to a sender: what is known (read, no reply yet), never the agent's screen or reasons. */
export function unansweredText(self, { refs, at }) {
  const which = refs.length > 1 ? `your messages ${refs.join(", ")}` : refs.length ? `your message ${refs[0]}` : "your message";
  return (
    `${AUTO_PREFIX}, not a reply from ${self}. ${self} read ${which} at ${new Date(at).toISOString().slice(11, 16)} UTC, and its turn ended without a reply to you. ` +
    "It may have declined, be waiting on its user, or still be working in the background. Send it a follow-up or check its session."
  );
}

/**
 * The text tmux pane `pane` (the agent's TMUX_PANE) shows now, or null. `env`: the agent's
 * environment (TMUX names its server), given by the caller, without hoptell settings.
 */
export function paneScreen(pane, { env = {}, run = spawnSync } = {}) {
  if (!/^%\d+$/.test(String(pane ?? ""))) return null;
  const clean = Object.fromEntries(Object.entries(env).filter(([k]) => !k.startsWith("HOPTELL_")));
  const r = run("tmux", ["capture-pane", "-p", "-t", pane], { encoding: "utf8", env: clean, timeout: 2000 });
  return r.status === 0 && typeof r.stdout === "string" ? r.stdout : null;
}

/**
 * Since when the screen `read()` returns has not changed (ms), or null while it cannot be read.
 * Text, not output: agy redraws an idle screen all the time without changing it, while a working
 * Codex or Claude Code changes its timer or spinner every second. The first read starts the count.
 */
export function screenSince(read, { now = Date.now } = {}) {
  let last = null;
  let since = null;
  return () => {
    const s = read();
    if (s === null) return null;
    if (s !== last) [last, since] = [s, now()];
    return since;
  };
}
