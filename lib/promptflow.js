// A waiting session's startup prompt on the owner's Telegram (design 9, C), on the injector's side:
// the card is published from the control connection (lib/control.js) with a frozen manifest of the
// prompt (lib/promptcards.js), only while the launch's startup trust gate is armed
// (lib/startgate.js) and only when the folder on the screen is the folder the launch recorded.
//
// The session's prompt record, sessions/<name>.prompt.json, is written before the card is asked
// for: {v: 1, digest, manifest, state, why, answer, report, at}. One card at a time: while a card
// of this launch is open (unexpired), a new occurrence of the same prompt (a resize, a repaint)
// asks for no other. `answer` ({choice, result_key}) is the owner's answer once it is taken;
// `report` ({outcome, why, label, note, lead, tries}) is what became of it, and whether the owner's
// bridge (`note`) and the team's lead (`lead`) were told yet (lib/promptexec.js).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { checkName, ensurePrivateDir } from "./config.js";
import { writeRecord } from "./locks.js";
import { ANSWERABLE, CARD_MS, RESULT_OUTCOMES, RESULT_WHY, START_MS, executableOptions, homeIdOf, manifestDigest, manifestProblem, promptRequestText } from "./promptcards.js";

const RECORD_MAX = 32 * 1024;
// published: the card is out; attempting: keys may be sent now (left so by a crash: unknown);
// done: every key was sent; refused: none was; unknown: some were, and then a check failed.
export const PROMPT_STATES = ["published", "attempting", "done", "refused", "unknown"];

export const promptFileOf = (home, name) => path.join(home, "sessions", `${checkName(name)}.prompt.json`);

/** Session `name`'s prompt record (its manifest checked again, its digest recomputed), or null. */
export function readPromptRecord(home, name) {
  try {
    const file = promptFileOf(home, name);
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.size > RECORD_MAX) return null;
    const r = JSON.parse(fs.readFileSync(file, "utf8"));
    const keys = ["v", "digest", "manifest", "state", "why", "answer", "report", "at"];
    if (!plain(r, keys) || r.v !== 1) return null;
    if (manifestProblem(r.manifest) || manifestDigest(r.manifest) !== r.digest || !PROMPT_STATES.includes(r.state) || !Number.isSafeInteger(r.at)) return null;
    if (!(r.why === null || (typeof r.why === "string" && r.why.length <= 200))) return null;
    const a = r.answer;
    if (!(a === null || (plain(a, ["choice", "result_key"]) && typeof a.choice === "string" && /^[1-9]$/.test(a.choice) && typeof a.result_key === "string" && /^[0-9a-f]{64}$/.test(a.result_key)))) return null;
    const p = r.report;
    if (p !== null) {
      if (!a || !plain(p, ["outcome", "why", "label", "note", "lead", "tries"]) || !RESULT_OUTCOMES.includes(p.outcome) || !(p.outcome === "done" ? p.why === null : RESULT_WHY.includes(p.why))) return null;
      if (!(p.label === null || (typeof p.label === "string" && p.label.length <= 200)) || typeof p.note !== "boolean" || typeof p.lead !== "boolean" || !Number.isSafeInteger(p.tries) || p.tries < 0) return null;
    }
    return r;
  } catch {
    return null;
  }
}

const plain = (o, keys) => o !== null && typeof o === "object" && !Array.isArray(o) && Object.keys(o).length === keys.length && keys.every((k) => Object.hasOwn(o, k));

/** Write session `name`'s prompt record durably (throws when it cannot be written). */
export function writePromptRecord(home, name, { digest, manifest, state, why = null, answer = null, report = null, now = Date.now }) {
  ensurePrivateDir(path.join(home, "sessions"));
  writeRecord(promptFileOf(home, name), { v: 1, digest, manifest, state, why, answer, report, at: now() });
}

/**
 * The card publisher of session `name`: publish(rec, prompt, capturedAt) → true when a card for
 * this prompt is open now (published now, or earlier and unexpired), false when the prompt is to
 * be told as a plain note instead. `rec`: the occurrence (lib/waits.js); `prompt`: its
 * classification (lib/prompts.js classifyPrompt, with dialog, folders, options and selected);
 * `capturedAt`: when the read it came from was taken (any key after it refuses the answer). Only
 * the options an answer may press are shown (lib/promptcards.js executableOptions): none, no
 * card. `gate`: the
 * launch's startup trust gate; `control`: the control connection; `team`: the team's name or
 * null; `profile`: the relay profile or null. The agent's process identity is the launch record's
 * (the gate matched it when the injector started). A card closes at the latest when the gate's
 * outer cap does. The gate is asked again after every wait, right before the record is written
 * and the card asked for; a publish while another runs gets that one's result. Never throws.
 */
export function cardPublisher(home, name, { control, gate, team = null, profile = null, now = Date.now, log = () => {} }) {
  let realHome = null;
  try {
    realHome = fs.realpathSync(home);
  } catch {}
  let inflight = null; // one publish at a time: a second asks for no other card
  async function once(rec, prompt, capturedAt) {
    try {
      // The gate (record, claim, continuity: lib/startgate.js) is asked again after every wait.
      const armed = () => Boolean(gate?.armed());
      if (rec?.kind !== "prompt" || rec.subtype !== ANSWERABLE || !rec.actionable || !prompt?.dialog || !Number.isSafeInteger(capturedAt) || !armed()) return false;
      const L = gate.launch;
      if (!executableOptions({ options: prompt.options, untested: L.untested }).length) {
        log("no option of this prompt was checked live yet: it is shown, not answerable from Telegram");
        return false;
      }
      if (!prompt.folders?.includes(L.root)) {
        log("the folder this prompt names is not the one the launch recorded: it is shown, not answerable from Telegram");
        return false;
      }
      // This launch's card: "open" (unexpired), "answered" (an answer was taken: it stands, first
      // decision wins, no other card), or null.
      const card = () => {
        const open = readPromptRecord(home, name);
        if (!open || open.manifest.launch !== L.id) return null;
        if (open.state !== "published") return "answered";
        return now() < open.manifest.expires_at ? "open" : null;
      };
      const seen = (c) => (c === "open" ? true : c === "answered" ? false : null);
      const before = card();
      if (before !== null) return seen(before);
      const me = await control.whoami();
      if (!me?.member?.id || !me.realm?.id || !realHome || !armed()) return false;
      const after = card();
      if (after !== null) return seen(after);
      const t = now();
      const manifest = {
        hoptell_prompt_manifest: 1,
        realm: me.realm.id,
        profile,
        home: homeIdOf(realHome),
        recipient: { member: me.member.id, control: me.name },
        launch: L.id,
        team,
        session: name,
        scope: { root: L.root, folder: L.folder },
        cli: { ...L.cli },
        host: { ...L.host },
        tmux: { ...L.tmux },
        subtype: ANSWERABLE,
        options: prompt.options.map((o) => ({ key: o.key, action: o.action, label: o.label, steps: o.steps.map((x) => (Array.isArray(x) ? [...x] : x)), live: o.live })),
        untested: L.untested,
        selected: prompt.selected,
        dialog: prompt.dialog,
        captured_at: capturedAt,
        created_at: t,
        expires_at: Math.min(t + CARD_MS, L.started + START_MS + CARD_MS),
        nonce: crypto.randomBytes(16).toString("hex"),
      };
      const problem = manifestProblem(manifest);
      if (problem) {
        log(`the prompt card could not be made (${problem}): the prompt is shown, not answerable from Telegram`);
        return false;
      }
      const digest = manifestDigest(manifest);
      if (!armed()) return false; // right before the record and the send: nothing waits in between
      // Kept before it is asked for: an answer always finds the manifest it was given for.
      writePromptRecord(home, name, { digest, manifest, state: "published", now });
      if (await control.note(promptRequestText(manifest))) return true;
      // Not sent: this publish's record goes (only it: another one's is left alone).
      if (readPromptRecord(home, name)?.manifest.nonce === manifest.nonce) fs.rmSync(promptFileOf(home, name), { force: true });
      return false;
    } catch (e) {
      log(`the prompt card could not be published (${e.message}): the prompt is shown, not answerable from Telegram`);
      return false;
    }
  }
  return {
    publish(rec, prompt, capturedAt) {
      inflight ??= once(rec, prompt, capturedAt).finally(() => {
        inflight = null;
      });
      return inflight;
    },
  };
}
