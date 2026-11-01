// Sessions waiting on a prompt, or stalled (design 9, A, with the v2 correction 3). `hoptell inject`
// reads the agent's visible pane every WATCH_MS and classifies it here; nothing in this module reads
// tmux, files or the environment. The screen is only classified: no pane text leaves this module,
// and none is ever shown to the owner or the lead.
//
// A known prompt is a row of PROMPTS. Its lines match the bottom rows of the screen exactly (after
// trailing spaces), never a loose normalization. Only a subtype marked actionable on a tested CLI
// version can ever get buttons (design 9, C); every other one, and every subtype on a version not
// in its list, is display-only. A stall is a screen that stays the same, once known spinner and
// timer animation is removed, for stallMinutes while the agent shows a busy marker, or while its
// input box shows and a hoptell notice stays unread longer than that.
import crypto from "node:crypto";

export const WATCH_MS = 15_000;
/** How long no attached client may send a key before hoptell types or presses in a pane. */
export const KEY_QUIET_MS = 8000;
export const STALL_MINUTES = 10;
const BOTTOM = 12; // rows from the bottom where agents draw prompts and footers

// eslint-disable-next-line no-control-regex -- terminal escape sequences
const unstyle = (s) => String(s ?? "").replace(/\x1b\[[0-9;:?]*[A-Za-z]/g, "");
const rowsOf = (screen) => unstyle(screen).replace(/\s+$/, "").split("\n").map((r) => r.replace(/\s+$/, ""));

/**
 * The prompt table, first match wins. `lines`: regular expressions that each match one whole row
 * (trailing spaces aside), in this order; a line's `gap` is how many other rows may come before it
 * since the previous one (none: any number). `footer`: the last line must be the screen's last
 * non-blank row (an agent's dialog, not text in its transcript), and the whole screen is searched;
 * otherwise only its bottom BOTTOM rows. `cli`: the CLI the row is for (null: any; an unknown CLI
 * matches every row). `versions`: the CLI versions the row was recorded on (live captures in
 * test/fixtures/prompt-screens.json). An actionable row is actionable on any version the launch
 * verified (CLIs release often): the screen must match the row exactly, every line, gap and the
 * footer, so a version that changes the dialog's words or layout is display-only. The card says
 * when the version is not one the row was recorded on (recordedOn).
 * `options` (actionable rows): the choices in screen order, each with its digit (`key`: the
 * option's number on the screen, the owner's choice), the button label as the screen words it,
 * `steps` (what is sent, in order: a list of tmux key names, or "revalidate", a fresh read of the
 * pane that must still show this dialog with this option selected before the next keys) and
 * `live` (true only when that very sequence was checked live on that version: v2 correction 5).
 * In Codex 0.165.0's source (tui/src/onboarding/trust_directory.rs), "1" only selects Trust, which
 * always takes an Enter after it; "2" (like q and Esc) quits or goes back at once. Claude Code
 * and agy show no digits: an option's `key` is its row on the screen (design 10, trust buttons).
 * Their rows have `read` (lib/prompts.js readFolderDialog): how the dialog's folder, words and
 * selection are read back; `after` (agy): the one row that may follow the footer.
 */
const L = (re, gap) => Object.freeze({ re, gap });
/** A CLI version as the launch verifies it (lib/startgate.js cliVersion): three numbers. */
export const isCliVersion = (v) => typeof v === "string" && /^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(v);
const STEPS = (...steps) => Object.freeze(steps.map((x) => (Array.isArray(x) ? Object.freeze([...x]) : x)));
const OPTION = (key, action, label, steps, live) => Object.freeze({ key, action, label, steps, live });
// In a linked worktree (or any subfolder) of a repository, Codex 0.165.0 adds a note and the
// repository's root between the folder it was started in and the risk text: its trust applies to
// that root. `note`: this variant (its own rows; the plain one never takes a screen with a note).
const NOTE_TEXT = "Note: You’re in a subdirectory of a Git project. Trusting will apply to the repository root:";
// The risk text's words in every capture, however it wrapped: on a version the row was not
// recorded on, a dialog that adds to it or changes it must not take buttons.
const CODEX_RISK = "Trust this folder? Codex can read, edit, and run files here, subject to your permission settings. Folder settings can run code automatically, even without a model request. Continue only if you trust these files. Your trust decision will be saved.";
const CODEX_TRUST = (second, action, label, footer, live, note = false) =>
  Object.freeze({
    cli: "codex",
    subtype: "codex-startup-trust",
    actionable: true,
    versions: Object.freeze(["0.165.0"]),
    footer: true,
    note,
    lines: Object.freeze([
      L(/^ {2}Folder access$/),
      ...(note ? [L(/^ {2}Note: You’re in a subdirectory of a Git project\.( .*)?$/, 5)] : []),
      L(/^ {2}Trust this folder\? Codex can read, edit, and run files here, subject to your( .*)?$/, note ? 8 : 5),
      L(/^(› | {2})1\. Trust and continue$/, 6),
      L(new RegExp(`^(› | {2})2\\. ${second}$`), 0),
      L(new RegExp(`^ {2}enter continue · esc ${footer}$`), 1),
    ]),
    options: Object.freeze([OPTION("1", "trust", "Trust folder", STEPS(["1"], "revalidate", ["Enter"]), live.trust), OPTION("2", action, label, STEPS(["2"]), live.second)]),
  });
// Claude Code 2.1.314 and agy 1.4.11 (design 10, trust buttons; live captures of 30 October 2026,
// each run directly in plain tmux, test/fixtures/prompt-screens.json). Both show the folder they
// were started in: the title, the folder's rows between two blank rows, their risk text, the two
// options and the footer, with exactly one blank row between the blocks.
//   Claude Code: "No, exit" first and selected, the marker "❯" in the second column, the cursor on
// the selected row. Esc exits whichever row is selected (checked live); Down moves the selection
// and wraps, digits do nothing, Enter on "No, exit" exits. Trust is Down, a fresh read with "Yes"
// selected (marker and cursor), then Enter, and only from "No, exit" (optionReady): a lost Down
// stops before the Enter. The variant whose project settings pre-approve permissions has warning
// rows before "Security guide" (and in its source its cancel may not exit): not this row.
//   agy: "Yes, I trust this folder" first and selected, so one Enter trusts; Esc exits (checked
// live). Its status line (model and mode, right-aligned) comes 1 to 3 s after the dialog, below
// the footer: it may be there or not, and it is never part of what the dialog says. Its cursor
// sits at the end of that line and says nothing about the selection.
//   Each option was tapped on the owner's Telegram card through the live bridge on 30 and 31
// October 2026, under hoptell tmux with the test switch: Claude Code 2.1.314's Trust in a plain
// folder and in a linked worktree (it recorded the repository's main folder) and its Quit; agy
// 1.4.12's Trust in a plain folder and in a linked worktree (it recorded that folder) and its
// Quit, its dialog the 1.4.11 row exactly. Each Trust took the agent on to its input box, each
// Quit ended it with nothing trusted.
const CLAUDE_RISK = "Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source project, or work from your team). If not, take a moment to review what's in this folder first. Claude Code'll be able to read, edit, and execute files here.";
const AGY_RISK = "Do you trust the contents of this project? Antigravity CLI requires permission to read, edit, and execute files here.";
const CLAUDE_TRUST = Object.freeze({
  cli: "claude",
  subtype: "claude-startup-trust",
  actionable: true,
  versions: Object.freeze(["2.1.314"]),
  footer: true,
  lines: Object.freeze([
    L(/^ Accessing workspace:$/),
    L(/^ Quick safety check: Is this a project you created or one you trust\?( .*)?$/),
    L(/^ Claude Code'll be able to read, edit, and execute files here\.$/, 6),
    L(/^ Security guide$/, 1),
    L(/^( ❯ | {3})No, exit$/, 1),
    L(/^( ❯ | {3})Yes, I trust this folder$/, 0),
    L(/^ Enter to confirm · Esc to cancel$/, 1),
  ]),
  options: Object.freeze([OPTION("1", "quit", "Quit", STEPS(["Escape"]), true), OPTION("2", "trust", "Trust folder", STEPS(["Down"], "revalidate", ["Enter"]), true)]),
  read: Object.freeze({ indent: " ", risk: CLAUDE_RISK, riskAt: [1, 2], blocks: [[2, 3], [3, 4], [5, 6]], optAt: 4, markAt: " ❯ ", unmarked: "   ", cursor: true }),
});
const AGY_TRUST = Object.freeze({
  cli: "agy",
  subtype: "agy-startup-trust",
  actionable: true,
  versions: Object.freeze(["1.4.11"]),
  footer: true,
  after: /^ {8,}\S(.*\S)?$/,
  lines: Object.freeze([
    L(/^Accessing workspace:$/),
    L(/^Do you trust the contents of this project\?$/),
    L(/^Antigravity CLI requires permission to read, edit, and execute files here\.$/, 1),
    L(/^(> | {2})Yes, I trust this folder$/, 1),
    L(/^(> | {2})No, exit$/, 0),
    L(/^ {2}↑\/↓ Navigate · enter Confirm$/, 1),
  ]),
  options: Object.freeze([OPTION("1", "trust", "Trust folder", STEPS("revalidate", ["Enter"]), true), OPTION("2", "quit", "Quit", STEPS(["Escape"]), true)]),
  read: Object.freeze({ indent: "", risk: AGY_RISK, riskAt: [1, 2], blocks: [[1, 2], [2, 3], [4, 5]], optAt: 3, markAt: "> ", unmarked: "  ", cursor: false }),
});
const SHOWN = (subtype, re, extra = {}) => Object.freeze({ cli: null, subtype, actionable: false, versions: null, footer: false, lines: Object.freeze([L(re)]), ...extra });
export const PROMPTS = Object.freeze([
  // Started through hoptell tmux, option 2 quits Codex; started in a Codex app window, it goes back.
  // All three sequences were checked live on Codex 0.165.0: Back ("2", Codex run directly in plain
  // tmux) first; Quit ("2") and Trust ("1", the fresh read, Enter) on 30 October 2026, under
  // hoptell tmux with the launch's test switch, each tapped on the owner's Telegram card through
  // the live bridge: Quit ended Codex without trusting the folder, Trust took Codex on to its
  // input box and recorded the folder in its config.
  CODEX_TRUST("Quit", "quit", "Quit", "quit", { trust: true, second: true }),
  CODEX_TRUST("Back to Agent Command Center", "back", "Back to Agent Command Center", "back", { trust: true, second: true }),
  // The worktree variant (30 October 2026, 0.165.0, a prompt and -c model_reasoning_effort on the
  // command line): Back ("2", Codex run directly in plain tmux) first; Trust ("1", the fresh read,
  // Enter) on 30 October 2026 for two team members started by hoptell team up in their worktrees,
  // and Quit ("2") the same day in a linked worktree under hoptell tmux, each with the test switch
  // and tapped on the owner's Telegram card through the live bridge: Trust took Codex on to its
  // input box, Quit ended Codex without trusting the repository root.
  CODEX_TRUST("Quit", "quit", "Quit", "quit", { trust: true, second: true }, true),
  CODEX_TRUST("Back to Agent Command Center", "back", "Back to Agent Command Center", "back", { trust: true, second: true }, true),
  CLAUDE_TRUST,
  AGY_TRUST,
  // Claude Code 2.1.312 (and any other dialog with these rows): display-only.
  Object.freeze({ cli: null, subtype: "folder-trust", actionable: false, versions: null, footer: true, lines: Object.freeze([L(/^ Accessing workspace:$/), L(/^ {3}Yes, I trust this folder$|^ ❯ Yes, I trust this folder$/), L(/^ Enter to confirm · Esc to cancel$/, 1)]) }),
  SHOWN("mcp-trust", /New MCP server found in this project/),
  SHOWN("hook-trust", /\bhooks?\b.*\b(trust|approve|review)\b|\b(trust|approve|review)\b.*\bhooks?\b/i),
  SHOWN("login", /Sign in with ChatGPT|Select login method|Log in with your|Please (log|sign) in|\/login to sign in|Invalid API key/i),
  SHOWN("update", /Update (available|now)|A new version of .* is available|Would you like to update/i),
  SHOWN("folder-trust", /trust this folder|Trust the files|Do you trust the (files|contents)/i),
  SHOWN("approval", /Do you want to (proceed|make this edit|run|create|allow)|Would you like to (run|make|apply|allow)|Allow (command|this|once)\b|\((y\/n|Y\/n|y\/N)\)|\[(y\/n|Y\/n|y\/N)\]|Yes, (and )?don't ask|Yes, allow|Press enter to confirm|Enter to confirm/i),
  // A numbered choice with the selection marker, that no row above names.
  SHOWN("unknown-dialog", /^\s*[│┃|]?\s*[❯›>]\s*1\.\s+\S/),
]);
export const SUBTYPES = Object.freeze([...new Set(PROMPTS.map((p) => p.subtype))]);

/**
 * May option `opt` start from selected row `selected`? An option whose first key moves the
 * selection (Claude Code's Down) assumes the first row is selected: the selection wraps, so a
 * Down from any other row would land elsewhere.
 */
export function optionReady(opt, selected) {
  const first = opt?.steps?.find(Array.isArray);
  return first?.[0] === "Down" ? selected === 1 : true;
}

/**
 * The rows of a Claude Code or agy trust dialog read back (design 10): null when they are not
 * exactly its layout. `at`: the matched rows of p.lines. The folder's rows sit between two blank
 * rows below the title; the risk text's words are exactly `risk`; each pair of `blocks` has
 * exactly one blank row between them. The selection is the option row with the marker, and,
 * for Claude Code when `cursor` is given, the row the cursor is on (column 1): both or none.
 */
function readFolderDialog(p, rows, at, cursor) {
  const R = p.read;
  const between = rows.slice(at[0] + 1, at[1]);
  if (between.length < 3 || between[0] !== "" || between.at(-1) !== "") return null;
  const folder = between.slice(1, -1);
  if (folder.some((x) => !x.trim() || !x.startsWith(R.indent) || (R.indent === "" && /^\s/.test(x)))) return null;
  const words = (from, to) => rows.slice(from, to).map((x) => x.trim()).filter(Boolean).join(" ").split(/\s+/).join(" ");
  if (words(at[R.riskAt[0]], at[R.riskAt[1]] + 1) !== R.risk) return null;
  for (const [a, b] of R.blocks) if (at[b] !== at[a] + 2 || rows[at[a] + 1] !== "") return null;
  const options = rows.slice(at[R.optAt], at[R.optAt] + p.options.length);
  const marked = options.map((x) => x.startsWith(R.markAt));
  let selected = marked.filter(Boolean).length === 1 ? marked.indexOf(true) + 1 : null;
  // Claude Code: the cursor must be read and on the marked row; unread or elsewhere, no selection.
  if (R.cursor && selected !== null && !(Number.isSafeInteger(cursor?.y) && Number.isSafeInteger(cursor?.x) && cursor.y === at[R.optAt] + selected - 1 && cursor.x === 1)) selected = null;
  return { folder: folder.map((x) => x.slice(R.indent.length)), options, selected, words: words(at[R.riskAt[0]], at[R.riskAt[1]] + 1) };
}

/** Do `rows` hold `lines` in order, within their gaps? The indexes of the matched rows, or null. */
function holds(rows, lines) {
  const at = [];
  let from = 0;
  for (const [n, { re, gap }] of lines.entries()) {
    const end = n === 0 || gap === undefined ? rows.length : Math.min(rows.length, from + gap + 1);
    let i = from;
    while (i < end && !re.test(rows[i])) i++;
    if (i >= end) return null;
    at.push(i);
    from = i + 1;
  }
  return at;
}

/**
 * The known prompt the screen shows, or null: {subtype, actionable, options, selected}. `cli`
 * ("codex", "claude", "agy" or null when unknown) and `version` (the verified version, or null)
 * decide whether a row applies and whether it is actionable; `options` are given only then, and
 * `selected` is the option row that shows the selection marker (1-based; null: none or unknown).
 * An actionable prompt also gives `dialog`: the sha256 of what it says, whatever the pane's width
 * (its title, the folder rows joined as wrapped, the risk text's words, every option row with the
 * selection marker, any other row before the footer, the footer),
 * `frame`: the same with the selection marker left out (the dialog whichever row is selected), and
 * `folders`: the folder rows between its first two lines (Codex's worktree variant: the
 * repository root's rows after its note), read back as a path (joined as wrapped, and joined with
 * spaces); only the caller can tell which, if either, is the launch's folder.
 */
export function classifyPrompt(screen, { cli = null, version = null, cursor = null } = {}) {
  const all = rowsOf(screen);
  for (const p of PROMPTS) {
    if (p.cli && cli && p.cli !== cli) continue;
    const rows = p.footer ? all : all.slice(-BOTTOM);
    const at = holds(rows, p.lines);
    if (!at) continue;
    if (p.footer) {
      // Only blank rows may follow the dialog's last line: the agent's own screen, not transcript
      // (agy: and at most one status row, `after`).
      const rest = rows.slice(at.at(-1) + 1).filter((r) => r.trim());
      if (rest.length > (p.after ? 1 : 0) || (rest.length && !p.after.test(rest[0]))) continue;
    }
    const tested = p.actionable && p.cli === cli && isCliVersion(version);
    if (p.read) {
      const d = readFolderDialog(p, rows, at, cursor);
      if (!d) continue;
      const r = { subtype: p.subtype, actionable: tested, options: tested ? p.options.map((o) => ({ ...o, steps: o.steps.map((x) => (Array.isArray(x) ? [...x] : x)) })) : [], selected: d.selected };
      if (tested) {
        // What it says, whatever the width: the title, the folder joined as wrapped, the risk
        // text's words, the option rows (with and without the marker), the footer.
        const sha = (o) => crypto.createHash("sha256").update(JSON.stringify([rows[at[0]].trim(), d.folder.join(""), d.words, ...o, rows[at.at(-1)].trim()])).digest("hex");
        r.dialog = sha(d.options);
        r.frame = sha(d.options.map((x) => (x.startsWith(p.read.markAt) ? p.read.unmarked + x.slice(p.read.markAt.length) : x)));
        r.folders = [...new Set([d.folder.join(""), d.folder.join(" ")])];
      }
      return r;
    }
    // The rows of the risk text and of the options (the variant has the note's line before them).
    const [riskAt, optAt] = [at.length - 4, at.length - 3];
    let selected = null;
    if (p.options) {
      const marked = p.options.map((o, i) => /^› /.test(rows[at[optAt] + i] ?? ""));
      selected = marked.filter(Boolean).length === 1 ? marked.indexOf(true) + 1 : null;
    }
    const words = (from, to) => rows.slice(from, to).map((x) => x.trim()).filter(Boolean).join(" ").split(/\s+/).join(" ");
    const pathRows = (from, to) => {
      const x = rows.slice(from, to).map((y) => y.replace(/^ {2}/, ""));
      while (x.length && !x.at(-1)) x.pop();
      return x;
    };
    // The variant: the folder's rows, then the note (its words exactly, however it wrapped, up to
    // the row that ends it), then the repository root's rows, each block without a blank row in it.
    // The plain dialog never has the note: a screen with it is the variant's or no known one.
    let head = null;
    if (p.note) {
      let end = at[1];
      while (end < at[riskAt] && rows[end].trim() && words(at[1], end + 1) !== NOTE_TEXT) end++;
      const folder = pathRows(at[0] + 1, at[1]);
      const root = pathRows(end + 1, at[riskAt]);
      if (words(at[1], end + 1) !== NOTE_TEXT || !folder.length || !root.length || [...folder, ...root].some((x) => !x.trim())) continue;
      head = { folder, note: NOTE_TEXT, root };
    } else if (p.cli === "codex" && rows.slice(at[0] + 1, at[riskAt]).some((x) => /^ {2}Note: /.test(x))) continue;
    // Codex's layout exactly as captured: each block of rows without a blank row in it and exactly
    // one blank row between them (the folder, the note and root, the risk text with its words
    // exactly, the options, the footer). Anything added or moved is not this dialog.
    if (p.cli === "codex") {
      const filled = (from, to) => to > from && rows.slice(from, to).every((x) => x.trim());
      const blocks = head ? [[at[0] + 1, at[1] - 1], [at[1], at[riskAt] - 1]] : [[at[0] + 1, at[riskAt] - 1]];
      if (blocks.some(([a, b]) => !filled(a, b) || rows[b] !== "")) continue;
      if (!filled(at[riskAt], at[optAt] - 1) || rows[at[optAt] - 1] !== "" || words(at[riskAt], at[optAt]) !== CODEX_RISK) continue;
      if (at.at(-1) !== at[optAt] + p.options.length + 1 || rows[at[optAt] + p.options.length] !== "") continue;
    }
    const r = { subtype: p.subtype, actionable: tested, options: tested ? p.options.map((o) => ({ ...o, steps: o.steps.map((x) => (Array.isArray(x) ? [...x] : x)) })) : [], selected };
    if (tested) {
      // Every row from its title to its footer counts, in order; only wrapping is undone (the
      // folder's rows joined as wrapped, the other text as words). The variant's note and the
      // repository root's rows are part of it, and its `folders` are the root's rows: the folder
      // Codex trusts.
      const folder = head ? head.folder : rows.slice(at[0] + 1, at[1]).map((x) => x.replace(/^ {2}/, ""));
      const options = rows.slice(at[optAt], at[optAt] + p.options.length);
      const after = words(at[optAt] + p.options.length, at.at(-1));
      const middle = head ? [head.note, head.root.join("")] : [];
      const sha = (o) => crypto.createHash("sha256").update(JSON.stringify([rows[at[0]].trim(), folder.join(""), ...middle, words(at[riskAt], at[optAt]), ...o, after, rows[at.at(-1)].trim()])).digest("hex");
      r.dialog = sha(options);
      r.frame = sha(options.map((x) => x.replace(/^› /, "  ")));
      const asked = head ? head.root : folder;
      r.folders = [...new Set([asked.join(""), asked.join(" ")])];
    }
    return r;
  }
  return null;
}

// Animation removed before two screens are compared: spinners, elapsed-time counters and token
// counters change while nothing else does.
const SPINNERS = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⠁⠂⠄⡀⢀⠠⠐⠈✻✽✶✳✢✺·•◐◓◑◒◴◷◶◵▖▘▝▗]{1,2}(?=\s)/g;
const TIMERS = /\b\d+(\.\d+)?\s*(ms|s|sec|secs|m|min|h)\b(\s+\d+\s*(s|m))?/gi;
const COUNTS = /[↑↓]?\s*\d+(\.\d+)?k?\s*tokens?\b/gi;

/** The screen with known animation removed, for comparing two reads. */
export function stillScreen(screen) {
  return rowsOf(screen)
    .map((r) => r.replace(TIMERS, "#").replace(COUNTS, "#").replace(SPINNERS, " ").replace(/\s+/g, " ").trim())
    .join("\n");
}

// The agent is working (Claude Code and Codex draw these while a turn runs).
const BUSY = /esc to interrupt|Esc to interrupt|ctrl\+c to interrupt|\bWorking \(|\bThinking…|\bRunning…/;
/** Does the screen show a busy marker in its bottom rows? */
export const busyShown = (screen) => BUSY.test(rowsOf(screen).slice(-BOTTOM).join("\n"));

const digest = (s) => crypto.createHash("sha256").update(s).digest("hex");

/**
 * The watcher of one pane: feed it a read every WATCH_MS and it says when an occurrence starts or
 * ends. A classification holds after two equal reads in a row (the same class on the same still
 * screen) and ends when the pane changes. A read:
 *   {screen, prompt: classifyPrompt(...) or null, inputShown, unreadSince (ms of the oldest
 *    notice still unread, or null), keyAt (ms of the last key of an attached client; -Infinity
 *    with none attached; null when it cannot be read), at (ms)}
 * or null when the pane cannot be read (it ends nothing and starts nothing).
 * feed returns {start: {kind, subtype, actionable, since}} | {end: true} | {}: the caller makes and
 * keeps the occurrence record. A prompt starts only from a read taken KEY_QUIET_MS after the last
 * key, so its card can be answered. Quiet time counts from the later of the last change of the still
 * screen and the last key from a person (keyAt): a stall needs a full stallMs of both. A key time
 * that cannot be read never makes a stall (the v2 correction 3: unknown refuses).
 */
export function createWatch({ stallMs = STALL_MINUTES * 60_000 } = {}) {
  let still = null; // {hash, since}: the still screen and when it was first seen
  let candidate = null; // the class of the last read, waiting for a second equal one
  let held = null; // the class that holds
  const same = (a, b) => Boolean(a && b) && a.kind === b.kind && a.subtype === b.subtype && a.hash === b.hash;
  return {
    get held() {
      return held;
    },
    feed(read) {
      if (!read) return {};
      const hash = digest(stillScreen(read.screen));
      const changed = !still || still.hash !== hash;
      if (changed) still = { hash, since: read.at };
      let now = null;
      const quiet = read.keyAt === null ? null : Math.max(still.since, read.keyAt);
      if (read.prompt) now = { kind: "prompt", subtype: read.prompt.subtype, actionable: read.prompt.actionable, hash };
      else if (!changed && quiet !== null && read.at - quiet >= stallMs) {
        const busy = busyShown(read.screen);
        const unread = read.inputShown && read.unreadSince !== null && read.at - read.unreadSince >= stallMs;
        if (busy || unread) now = { kind: "stall", subtype: busy ? "busy" : "unread", actionable: false, hash };
      }
      if (held && !same(held, now)) {
        held = null;
        candidate = now;
        return { end: true };
      }
      if (held) return {};
      // A prompt starts only from a read taken KEY_QUIET_MS after the last key (keyAt has whole
      // seconds): a press needs that long without a key (lib/tmux.js keyIdle) and no key after the
      // card's read, so a card from an earlier read, such as one drawn as a terminal attaches,
      // could be refused at once. The key is any attached client's activity in the tmux session,
      // not only in this pane: while it goes on, the prompt's card waits.
      if (now?.kind === "prompt" && read.keyAt !== null && read.at - read.keyAt < KEY_QUIET_MS) {
        candidate = now;
        return {};
      }
      if (now && same(candidate, now)) {
        held = now;
        candidate = null;
        // A prompt's start carries what was classified (lib/promptcards.js builds its card from it).
        return { start: { kind: now.kind, subtype: now.subtype, actionable: now.actionable, since: now.kind === "stall" ? quiet : read.at, ...(now.kind === "prompt" ? { prompt: read.prompt } : {}) } };
      }
      candidate = now;
      return {};
    },
  };
}
