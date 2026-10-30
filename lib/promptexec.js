// The owner's answer to a prompt card, carried out by the session's injector (design 9, C,
// "Execution in the injector", with the v2 corrections 3 and 5 and the owner's decision of 29
// October 2026). The answer comes to the control connection (lib/control.js) as a signed owner
// envelope of kind prompt_answer (lib/ownersig.js) and is taken only when
//   - it verifies against the pinned bridge, addressed to the control name and the own member;
//   - it names this session's prompt record (lib/promptflow.js): its manifest's digest and nonce,
//     still "published" (the first decision wins: any other state is never tried again);
//   - the manifest is this injector's target: the launch, the home, the trust scope, the CLI, the
//     agent's process, the tmux server, session and pane, the test switch (lib/startgate.js), and
//     the realm, member and control name it was sent to;
//   - the option is one an answer may press (checked live, or the launch's test switch is on);
//   - the card has not expired and the tap is at most START_MS old.
// Then, under the prompt's lock and with notices held back, the record becomes "attempting"
// (durably, before any key; it cannot be written: nothing is sent), and the option's steps run
// (lib/prompts.js): each key step only right after the press checks hold, a "revalidate" step only
// when a fresh read shows the same dialog with that option selected. The press checks: the gate
// still armed (lib/startgate.js: record, claim, continuity; every read here is one of its reads
// too), the agent's process the manifest's, the pane alive with that process and in the manifest's
// tmux session, not in copy mode, no key from an attached client since the read the card was made
// from (a key in the same second counts: tmux keeps whole seconds; unknown counts too) nor for
// IDLE_S, and the screen the manifest's dialog exactly. tmux keeps no time of other input to a
// pane (a paste, another program's send-keys): the screen check is all there is for it.
//
// The result is "done" (every key sent), "refused" (none) or "unknown" (some may have been), kept
// in the record with its report, which goes to the owner's bridge until the relay took it (a
// bounded number of tries: on the injector's ticks, at a reconnect, and when the answer comes
// again) and, best effort, once to the team's lead. The bridge is the backstop: a card whose
// result never comes says so after a while (lib/ownerchannel.js RESULT_WAIT_MS). "unknown" is
// never tried again. A record left "attempting" (an injector stopped while pressing) becomes
// unknown/interrupted when the next injector starts, and is reported.
//
// The race between the last read and the key stays: hoptell does not see the screen between them.
// Showing the buttons authorizes nothing; only the owner's tap sends keys.
import fs from "node:fs";
import path from "node:path";
import { checkName } from "./config.js";
import { canonicalize } from "./jcs.js";
import { withLock } from "./locks.js";
import { identityState } from "./host.js";
import { parseEnvelope, pinFor, verifyEnvelope } from "./ownersig.js";
import { ANSWERABLE, PROMPT_ANSWER_KIND, START_MS, executableOptions, homeIdOf, parseAnswer, resultText } from "./promptcards.js";
import { readPromptRecord, writePromptRecord } from "./promptflow.js";
import { classifyPrompt } from "./prompts.js";

const REDRAW_MS = 2000; // how long a revalidation waits for the screen to show the selection
const REDRAW_STEP_MS = 100;
const TAP_FUTURE_MS = 60_000;
export const REPORT_TRIES = 10; // a result's report is tried this often, 2 s apart and doubling to 60 s
const REPORT_WAIT_MS = 5000; // how long an agent's exit waits for its result to go out
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The answer handler of session `name`: {onMessage(m, confirm, me) for its control connection
 * (`me`: the connection's {name, member, realm}), flush({force}) to send a result's report not
 * sent yet (true when nothing is left to send)}.
 * `gate`: the launch's startup gate; `ops`: the injector's pane operations ({pane, pid, look,
 * paneAlive, inMode, keyIdle, press(keys, target)}: press sends tmux key names to the target's
 * pane on its tmux server, only while the pane runs its process in its session, true when sent,
 * false when not, throws when unclear); `hold(fn)`: runs `fn` with notices held back;
 * `report({outcome, why, label, digest, nonce, key, note, lead})`: tells the owner (`note`) and
 * the lead (`lead`), resolving to {note, lead}: each true once taken (or not needed).
 * Never throws; what arrives is always confirmed (after its record was written).
 */
export function promptAnswers(home, name, { gate, ops, hold = (fn) => fn(), report = async () => ({ note: true, lead: true }), now = Date.now, wait = sleep, identity = identityState, pin = (realm) => pinFor(home, realm), lockMs = 10_000, log = () => {} }) {
  const lockFile = path.join(home, "sessions", `${checkName(name)}.prompt`);
  let homeId = null;
  try {
    homeId = homeIdOf(fs.realpathSync(home));
  } catch {}
  const same = (a, b) => canonicalize(a) === canonicalize(b);

  /** What of manifest `M` is not this injector's target (for the connection `me`), or null. */
  function unbound(M, me) {
    const L = gate.launch;
    if (!L || !homeId || M.launch !== L.id || M.home !== homeId || M.untested !== L.untested || M.scope.root !== L.root || M.scope.folder !== L.folder) return "changed";
    if (!same(M.cli, L.cli) || !same(M.host, L.host) || !same(M.tmux, L.tmux)) return "changed";
    if (M.realm !== me.realm.id || M.recipient.member !== me.member.id || M.recipient.control !== me.name) return "changed";
    if (ops.pane !== M.tmux.pane || String(ops.pid) !== String(M.host.pid)) return "gone";
    return null;
  }

  /**
   * What fails of the press checks against `expect` ({dialog} or {frame, selected}), or {p}. A
   * revalidation may wait only on {why, retry}: the same dialog, the selection not moved yet.
   */
  function check(M, me, expect) {
    try {
      if (!gate.armed()) return { why: "changed" };
      const u = unbound(M, me);
      if (u) return { why: u };
      if (identity(M.host) !== "same" || !ops.paneAlive()) return { why: "gone" };
      if (ops.inMode() || !ops.keyIdle()) return { why: "busy" };
      const r = ops.look();
      if (!r) return { why: "busy" };
      const p = classifyPrompt(r.screen, { cli: "codex", version: M.cli.version });
      gate.observe({ ...r, prompt: p }); // the gate's continuity sees this read too
      if (r.keyAt === null || r.keyAt >= M.captured_at) return { why: "busy" }; // a key since the card's read, or unknown
      if (r.inputShown || !gate.armed()) return { why: "changed" };
      if (!p?.actionable || p.subtype !== ANSWERABLE) return { why: "changed" };
      if (expect.dialog) return p.dialog === expect.dialog ? { p } : { why: "changed" };
      if (p.frame !== expect.frame) return { why: "changed" };
      return p.selected === expect.selected ? { p } : { why: "changed", retry: true };
    } catch {
      return { why: "busy" };
    }
  }

  let unsaved = []; // reports whose record could not be written: tried from here, as often as the others
  let again = false; // the answer came again: the next flush tries whatever the bound says

  async function run(a, me) {
    const rec = readPromptRecord(home, name);
    if (!rec || rec.digest !== a.digest || rec.manifest.nonce !== a.nonce) return log("a prompt answer for a card this session does not hold: ignored");
    const M = rec.manifest;
    const opt = M.options.find((o) => o.key === a.choice);
    const end = (outcome, why, answer = { choice: a.choice, result_key: a.result_key }) => {
      const r = { outcome, why, label: opt?.label ?? null, note: false, lead: false, tries: 0 };
      try {
        writePromptRecord(home, name, { digest: rec.digest, manifest: M, state: outcome, why, answer, report: r, now });
      } catch (e) {
        log(`the prompt's result could not be recorded (${e.message})`);
        unsaved.push({ ...r, digest: rec.digest, nonce: M.nonce, key: answer.result_key, lead: false });
      }
      gate.off("answered");
      log(`the owner's answer (${opt?.label ?? "?"}): ${outcome}${why ? ` (${why})` : ""}`);
    };
    if (rec.state === "attempting") return end("unknown", "interrupted", rec.answer ?? undefined); // the injector stopped while trying
    if (rec.state !== "published") {
      if (rec.report && !rec.report.note) again = true; // its report goes out again; nothing is pressed
      return log(`a prompt answer again: it was ${rec.state} already`);
    }
    const t = now();
    if (t > M.expires_at || t - a.issued_at > START_MS || a.issued_at > t + TAP_FUTURE_MS) return end("refused", "late");
    if (!opt || !executableOptions(M).includes(opt)) return end("refused", "changed");
    const u = unbound(M, me);
    if (u) return end("refused", u);
    try {
      writePromptRecord(home, name, { digest: rec.digest, manifest: M, state: "attempting", answer: { choice: a.choice, result_key: a.result_key }, now });
    } catch {
      return end("refused", "storage");
    }
    const first = check(M, me, { dialog: M.dialog });
    if (first.why) return end("refused", first.why);
    const expect = { frame: first.p.frame, selected: M.options.indexOf(opt) + 1 };
    let sent = false;
    for (const step of opt.steps) {
      if (step === "revalidate") {
        // Waits only while the same dialog shows, its selection not moved yet: anything else
        // (another screen, readiness, a mode, a key, the process, the gate, an unreadable pane)
        // ends it at once, and no further key is sent.
        let c = check(M, me, expect);
        for (let waited = 0; c.retry && waited < REDRAW_MS; waited += REDRAW_STEP_MS) {
          await wait(REDRAW_STEP_MS);
          c = check(M, me, expect);
        }
        if (c.why) return end(sent ? "unknown" : "refused", c.why);
        continue;
      }
      let ran;
      try {
        ran = ops.press(step, M.tmux);
      } catch {
        return end("unknown", "tmux");
      }
      if (!ran) return end(sent ? "unknown" : "refused", "gone");
      sent = true;
    }
    return end("done", null);
  }

  let flushing = null;
  let nextAt = 0;
  /** One try at the report not taken yet (single flight); true when nothing is left to send. */
  /**
   * A record left "attempting" (an injector stopped while pressing: its lock is free again, nothing
   * is pressed now) becomes unknown/interrupted, with its report, without waiting for the answer to
   * come again. Once, at the first flush, under the prompt's lock.
   */
  let recovered = false;
  async function recover() {
    if (recovered) return;
    recovered = true;
    try {
      await withLock(
        lockFile,
        () => {
          const rec = readPromptRecord(home, name);
          if (rec?.state !== "attempting" || !rec.answer) return;
          const label = rec.manifest.options.find((o) => o.key === rec.answer.choice)?.label ?? null;
          writePromptRecord(home, name, { digest: rec.digest, manifest: rec.manifest, state: "unknown", why: "interrupted", answer: rec.answer, report: { outcome: "unknown", why: "interrupted", label, note: false, lead: false, tries: 0 }, now });
          gate.off("answered");
          log(`the owner's answer (${label ?? "?"}) was being pressed when this session's injector stopped: unknown (interrupted)`);
        },
        { waitMs: lockMs },
      );
    } catch (e) {
      log(`the prompt's state could not be checked (${e.message})`);
    }
  }

  // What a report attempt `sent` ({note, lead}) leaves: the lead is told once, best effort (a
  // failure is logged, it holds nothing up); the owner's note is tried until taken, within the bound.
  const after = (sent, lead) => {
    if (lead && sent.lead !== true) log("the team's lead was not told of the prompt's result (best effort, not tried again)");
    return { note: sent.note === true, lead: true };
  };
  const tryReport = async (r) => {
    try {
      return (await report(r)) ?? {};
    } catch {
      return {};
    }
  };

  /** One try at the reports not taken yet (single flight); true when nothing is left to send. */
  async function flushOnce(force) {
    await recover();
    const due = force || again || now() >= nextAt;
    let left = false;
    if (due) {
      // Reports kept here (their record could not be written): a failed send is kept, within the bound.
      for (const u of unsaved.splice(0)) {
        const got = after(await tryReport({ ...u, note: !u.note, lead: !u.lead }), !u.lead);
        const k = { ...u, note: u.note || got.note, lead: true, tries: (u.tries ?? 0) + 1 };
        if (!k.note && k.tries < REPORT_TRIES) unsaved.push(k);
      }
    }
    left = unsaved.length > 0;
    const rec = readPromptRecord(home, name);
    const p = rec?.report;
    if (!p || p.note) {
      if (due) nextAt = now() + 2000;
      return !left;
    }
    if (!force && !again && (p.tries >= REPORT_TRIES || now() < nextAt)) return false;
    again = false;
    const sent = after(await tryReport({ outcome: p.outcome, why: p.why, label: p.label, digest: rec.digest, nonce: rec.manifest.nonce, key: rec.answer.result_key, note: true, lead: !p.lead }), !p.lead);
    nextAt = now() + Math.min(60_000, 2000 * 2 ** p.tries);
    try {
      // Written back onto the same record only, under the prompt's lock.
      await withLock(
        lockFile,
        () => {
          const cur = readPromptRecord(home, name);
          if (!cur?.report || cur.manifest.nonce !== rec.manifest.nonce) return;
          const r = { ...cur.report, note: cur.report.note || sent.note, lead: true, tries: cur.report.tries + 1 };
          writePromptRecord(home, name, { digest: cur.digest, manifest: cur.manifest, state: cur.state, why: cur.why, answer: cur.answer, report: r, now });
        },
        { waitMs: lockMs },
      );
    } catch (e) {
      log(`the prompt's report state could not be recorded (${e.message})`);
    }
    return sent.note && !left;
  }
  const flush = ({ force = false } = {}) => {
    flushing ??= flushOnce(force)
      .catch(() => false)
      .finally(() => {
        flushing = null;
      });
    return flushing;
  };

  return {
    flush,
    async onMessage(m, confirm, me) {
      try {
        if (!parseEnvelope(m?.text)) return;
        if (!me?.name || !me.realm?.id || !me.member?.id) return log("a prompt answer arrived before this connection knew its realm: ignored");
        const v = verifyEnvelope(m.text, { pin: pin(me.realm.id), realm: me.realm.id, sender: m.from, me: { name: me.name, member: me.member.id }, now: now() });
        if (!v.ok) return log(`an owner message that does not verify (${v.reason}): ignored`);
        if (v.env.kind !== PROMPT_ANSWER_KIND) return log(`an owner message of kind ${v.env.kind}: not for the control connection, ignored`);
        const a = parseAnswer(v.env.text);
        if (!a) return log("a prompt answer that is not one: ignored");
        let ran = false;
        try {
          await withLock(lockFile, () => ((ran = true), hold(() => run(a, me))), { waitMs: lockMs });
        } catch (e) {
          if (ran) throw e;
          // The prompt's lock could not be taken (storage, or another answer running too long):
          // nothing is sent; the owner hears so once, the record stays for a later answer.
          const rec = readPromptRecord(home, name);
          if (rec?.state === "published" && rec.digest === a.digest && rec.manifest.nonce === a.nonce) {
            log(`the prompt's lock could not be taken (${e.message}): nothing pressed`);
            gate.off("answered");
            unsaved.push({ outcome: "refused", why: "storage", label: rec.manifest.options.find((o) => o.key === a.choice)?.label ?? null, digest: rec.digest, nonce: rec.manifest.nonce, key: a.result_key, note: false, lead: false, tries: 0 });
          }
        }
      } catch (e) {
        log(`a prompt answer could not be handled (${e.message})`);
      } finally {
        confirm();
      }
      await flush({ force: true });
    },
  };
}

/**
 * Wait, at most `ms`, while session `name`'s prompt answer is being carried out or its report has
 * not reached the owner's bridge yet: for the agent's tmux window when the agent exits (a Quit),
 * so its injector can still send the result before the session ends. Reads only the record.
 */
export async function reportSettled(home, name, { ms = REPORT_WAIT_MS, now = Date.now, wait = sleep } = {}) {
  const end = now() + ms;
  for (;;) {
    const r = readPromptRecord(home, name);
    const busy = r && (r.state === "attempting" || (r.report && !r.report.note && r.report.tries < REPORT_TRIES));
    if (!busy) return true;
    if (now() >= end) return false;
    await wait(100);
  }
}

const LEAD_RESULT = {
  done: (label) => `the owner chose "${label}" and hoptell pressed it`,
  refused: (label, why) => `the owner chose "${label}"; nothing was pressed (${why})`,
  unknown: (label, why) => `the owner chose "${label}"; hoptell may have pressed part of it (${why}): look at the session`,
};

/**
 * The report of session `name`'s prompt results: to the owner's bridge (which words it and closes
 * the card), under the answer's result key, and, for a team member, to its lead. Resolves to
 * {note, lead}: each true once the relay took it (or nothing was to be sent). Never throws.
 */
export function resultReport(name, { control, team = null }) {
  return async ({ outcome, why, label, digest, nonce, key, note = true, lead = true }) => {
    const sent = { note: true, lead: true };
    const tried = async (fn) => {
      try {
        return (await fn()) === true;
      } catch {
        return false;
      }
    };
    if (note) sent.note = await tried(() => control.note(resultText({ digest, nonce, outcome, why, key })));
    if (lead && team?.lead) {
      const text = `hoptell: automated notice, not a user message. ${name} (team ${team.team}), Codex's folder trust prompt: ${LEAD_RESULT[outcome](label ?? "?", why)}.`;
      sent.lead = await tried(() => control.tell(team.lead, text));
    }
    return sent;
  };
}
