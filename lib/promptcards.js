// Answering Codex's startup folder-trust prompt from the owner's Telegram (design 9, C, with the v2
// corrections 1, 4 and 5). Only codex-startup-trust, only on a Codex version its captures were
// recorded on (lib/prompts.js PROMPTS), and only for the launch hoptell started.
//
// The injector of the session keeps a frozen manifest of the prompt it saw and sends it to the
// owner's bridge as one message, {hoptell_prompt: 1, manifest}, in canonical JSON. The bridge
// trusts none of it: it checks the manifest's shape and its options against the prompt table, and
// computes the manifest's digest itself. The owner's tap comes back as a signed owner envelope of
// kind prompt_answer (lib/ownersig.js), addressed to the injector's control name, whose text is
// {hoptell_prompt_answer: 1, digest, nonce, choice, issued_at}. A card is valid for CARD_MS from the
// manifest's creation; the injector starts within START_MS of the tap or not at all. Both are
// checked apart from the owner envelope's own time window.
import crypto from "node:crypto";
import path from "node:path";
import { canonicalize } from "./jcs.js";
import { NAME_RE } from "./config.js";
import { MEMBER_ID_RE } from "./ownersig.js";
import { REALM_ID_RE } from "./realm.js";
import { PROMPTS } from "./prompts.js";

export const PROMPT_ANSWER_KIND = "prompt_answer";
export const CARD_MS = 10 * 60_000;
export const START_MS = 2 * 60_000;
export const ANSWERABLE = "codex-startup-trust";
const REQUEST_MAX = 16 * 1024;

const isPlain = (x) => x !== null && typeof x === "object" && !Array.isArray(x) && Object.getPrototypeOf(x) === Object.prototype;
const keysAre = (o, keys) => isPlain(o) && Object.keys(o).length === keys.length && keys.every((k) => Object.hasOwn(o, k));
const isHex = (x, n) => typeof x === "string" && new RegExp(`^[0-9a-f]{${n}}$`).test(x);
const isMs = (x) => Number.isSafeInteger(x) && x > 0;
const isAbsPath = (x) => typeof x === "string" && x.length > 0 && x.length <= 4096 && path.isAbsolute(x) && !/[\0\n\r]/.test(x);
const isName = (x) => typeof x === "string" && NAME_RE.test(x);
const isStr = (x, max) => typeof x === "string" && x.length > 0 && x.length <= max;
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

const MANIFEST_KEYS = ["hoptell_prompt_manifest", "realm", "profile", "home", "recipient", "launch", "team", "session", "scope", "cli", "host", "tmux", "subtype", "options", "untested", "selected", "dialog", "captured_at", "created_at", "expires_at", "nonce"];

/** The id of a hoptell home in manifests: a digest of its real path, never the path. */
export const homeIdOf = (realHome) => sha256(`hoptell-home/1\n${realHome}`).slice(0, 32);

/** The answerable rows of the prompt table for `version`: their option lists (frozen). */
export function answerableOptions(version) {
  return PROMPTS.filter((p) => p.subtype === ANSWERABLE && p.actionable && p.versions.includes(version)).map((p) => p.options);
}
// Exactly a row's options, key sequences and live marks included (the manifest's digest covers them).
const sameOptions = (a, b) => {
  try {
    return Array.isArray(a) && a.length === b.length && a.every((o, i) => keysAre(o, ["key", "action", "label", "steps", "live"]) && canonicalize(o) === canonicalize(b[i]));
  } catch {
    return false;
  }
};

/**
 * What is wrong with a prompt manifest (the first problem), or null. Every field exact: the realm,
 * profile and home; the recipient member and its control name; the launch id and team; the
 * session's name (display only); the trust scope (the folder Codex asks about, `root`, and the
 * launch folder, `folder`); the verified CLI; the agent process and its tmux pane; the subtype, its
 * options exactly as the prompt table has them for that version, `untested` (the launch's test
 * switch: options not checked live are shown and pressed too), the selected row, the dialog's
 * digest; the times (the read the dialog came from, `captured_at`, at most CARD_MS before the
 * creation; expiry at most CARD_MS after it) and the nonce.
 */
export function manifestProblem(m) {
  if (!keysAre(m, MANIFEST_KEYS) || m.hoptell_prompt_manifest !== 1) return "fields";
  if (typeof m.realm !== "string" || !REALM_ID_RE.test(m.realm)) return "realm";
  if (!(m.profile === null || isStr(m.profile, 200))) return "profile";
  if (!isHex(m.home, 32)) return "home";
  if (!keysAre(m.recipient, ["member", "control"]) || typeof m.recipient.member !== "string" || !MEMBER_ID_RE.test(m.recipient.member) || !isName(m.recipient.control)) return "recipient";
  if (!isHex(m.launch, 32)) return "launch";
  if (!(m.team === null || (typeof m.team === "string" && /^[a-z0-9][a-z0-9-]{0,31}$/.test(m.team)))) return "team";
  if (!isName(m.session)) return "session";
  if (!keysAre(m.scope, ["root", "folder"]) || !isAbsPath(m.scope.root) || !isAbsPath(m.scope.folder)) return "scope";
  if (!keysAre(m.cli, ["name", "path", "version"]) || m.cli.name !== "codex" || !isAbsPath(m.cli.path) || !isStr(m.cli.version, 40)) return "cli";
  const h = m.host;
  if (!keysAre(h, ["pid", "start", "uid", "boot"]) || !Number.isSafeInteger(h.pid) || h.pid < 2 || !isStr(h.start, 64) || !Number.isSafeInteger(h.uid) || !isStr(h.boot, 64)) return "host";
  const x = m.tmux;
  if (!keysAre(x, ["socket", "session", "pane"]) || !isAbsPath(x.socket) || typeof x.session !== "string" || !/^\$\d{1,9}$/.test(x.session) || typeof x.pane !== "string" || !/^%\d{1,9}$/.test(x.pane)) return "tmux";
  if (m.subtype !== ANSWERABLE) return "subtype";
  if (!answerableOptions(m.cli.version).some((o) => sameOptions(m.options, o))) return "options";
  if (typeof m.untested !== "boolean") return "untested";
  if (!Number.isSafeInteger(m.selected) || m.selected < 1 || m.selected > m.options.length) return "selected";
  if (!isHex(m.dialog, 64)) return "dialog";
  if (!isMs(m.captured_at) || !isMs(m.created_at) || !isMs(m.expires_at) || m.captured_at > m.created_at || m.created_at - m.captured_at > CARD_MS) return "times";
  if (m.expires_at <= m.created_at || m.expires_at - m.created_at > CARD_MS) return "times";
  if (!isHex(m.nonce, 32)) return "nonce";
  return null;
}

/** A manifest's digest: the sha256 of its canonical JSON. */
export const manifestDigest = (m) => sha256(canonicalize(m));

/**
 * The options of manifest `m` an answer may press: those checked live (`live`), and under the
 * launch's test switch (`untested`) the others too. The card shows only these.
 */
export const executableOptions = (m) => m.options.filter((o) => o.live || m.untested);

/** The message that asks the owner's bridge for a card: {hoptell_prompt: 1, manifest}. */
export function promptRequestText(m) {
  const problem = manifestProblem(m);
  if (problem) throw new Error(`not a prompt manifest (${problem})`);
  return canonicalize({ hoptell_prompt: 1, manifest: m });
}

/**
 * A message `text` read as a request for a prompt card: null when it does not claim to be one,
 * {problem} when it does and is not exactly one, {manifest, digest} otherwise. Never throws.
 */
export function parsePromptRequest(text) {
  if (typeof text !== "string" || !text.startsWith("{") || !text.includes('"hoptell_prompt"')) return null;
  try {
    if (text.length > REQUEST_MAX) return { problem: "too long" };
    const v = JSON.parse(text);
    if (!isPlain(v) || !Object.hasOwn(v, "hoptell_prompt")) return null;
    if (!keysAre(v, ["hoptell_prompt", "manifest"]) || v.hoptell_prompt !== 1) return { problem: "fields" };
    const problem = manifestProblem(v.manifest);
    if (problem) return { problem };
    if (canonicalize(v) !== text) return { problem: "not canonical" };
    return { manifest: v.manifest, digest: manifestDigest(v.manifest) };
  } catch {
    return { problem: "not valid JSON" };
  }
}

/**
 * The text of the owner's answer (the envelope's text): which option of which manifest, and
 * `result_key`, a fresh random key the bridge made for this answer: only the session that holds
 * the control name's lease gets it, and the result it sends back proves it (resultText).
 */
export function answerText({ digest, nonce, choice, issuedAt, resultKey }) {
  const a = { hoptell_prompt_answer: 1, digest, nonce, choice, issued_at: issuedAt, result_key: resultKey };
  if (answerProblem(a)) throw new Error(`not a prompt answer (${answerProblem(a)})`);
  return canonicalize(a);
}
function answerProblem(a) {
  if (!keysAre(a, ["hoptell_prompt_answer", "digest", "nonce", "choice", "issued_at", "result_key"]) || a.hoptell_prompt_answer !== 1) return "fields";
  if (!isHex(a.digest, 64) || !isHex(a.nonce, 32)) return "manifest";
  if (typeof a.choice !== "string" || !/^[1-9]$/.test(a.choice)) return "choice";
  if (!isMs(a.issued_at)) return "time";
  if (!isHex(a.result_key, 64)) return "result key";
  return null;
}

/** An answer text read back exactly: its fields, or null. Never throws. */
export function parseAnswer(text) {
  try {
    if (typeof text !== "string" || text.length > 1024) return null;
    const a = JSON.parse(text);
    return answerProblem(a) || canonicalize(a) !== text ? null : a;
  } catch {
    return null;
  }
}

// What became of an answer, from the injector back to the owner's bridge (and the card):
// {hoptell_prompt_result: 1, digest, nonce, outcome, why, result_key, mac}. `outcome`: "done"
// (every key of the chosen option was sent), "refused" (none was) or "unknown" (some may have
// been: a check failed after a key, tmux gave no clear result, or the injector stopped while
// trying). `why` is null for "done", else one of RESULT_WHY: never text from the screen.
// `result_key` is the answer's key, and `mac` HMAC-SHA256 under it of the canonical
// {digest, nonce, outcome, why}: the bridge keeps only the key's digest (resultKeyId), so a result
// from a session that never got the answer (one that sends under the control name without holding
// it) is not taken.
export const RESULT_OUTCOMES = Object.freeze(["done", "refused", "unknown"]);
export const RESULT_WHY = Object.freeze(["late", "changed", "busy", "gone", "storage", "tmux", "interrupted"]);
function resultProblem(r) {
  if (!keysAre(r, ["hoptell_prompt_result", "digest", "nonce", "outcome", "why", "result_key", "mac"]) || r.hoptell_prompt_result !== 1) return "fields";
  if (!isHex(r.digest, 64) || !isHex(r.nonce, 32)) return "manifest";
  if (!RESULT_OUTCOMES.includes(r.outcome)) return "outcome";
  if (r.outcome === "done" ? r.why !== null : !RESULT_WHY.includes(r.why)) return "why";
  if (!isHex(r.result_key, 64) || !isHex(r.mac, 64)) return "mac";
  return null;
}

/** The digest of a result key, as the bridge keeps it. */
export const resultKeyId = (key) => sha256(`hoptell-prompt-result/1\n${key}`);
const resultMac = (key, { digest, nonce, outcome, why }) => crypto.createHmac("sha256", Buffer.from(key, "hex")).update(canonicalize({ digest, nonce, outcome, why })).digest("hex");

/** Does result `r` (parseResult) prove the key whose digest is `keyId`? Never throws. */
export function resultVerifies(r, keyId) {
  try {
    if (typeof keyId !== "string" || resultKeyId(r.result_key) !== keyId) return false;
    return crypto.timingSafeEqual(Buffer.from(resultMac(r.result_key, r), "hex"), Buffer.from(r.mac, "hex"));
  } catch {
    return false;
  }
}

/** The result message for the bridge, under the answer's result key `key`. */
export function resultText({ digest, nonce, outcome, why = null, key }) {
  const r = { hoptell_prompt_result: 1, digest, nonce, outcome, why, result_key: key, mac: isHex(key, 64) ? resultMac(key, { digest, nonce, outcome, why }) : null };
  if (resultProblem(r)) throw new Error(`not a prompt result (${resultProblem(r)})`);
  return canonicalize(r);
}

/** A message `text` read as a prompt result: null when it is not exactly one. Never throws. */
export function parseResult(text) {
  try {
    if (typeof text !== "string" || text.length > 1024 || !text.includes('"hoptell_prompt_result"')) return null;
    const r = JSON.parse(text);
    return resultProblem(r) || canonicalize(r) !== text ? null : r;
  } catch {
    return null;
  }
}
