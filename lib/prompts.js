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
 * test/fixtures/prompt-screens.json); only those can make an actionable row actionable.
 * `options` (actionable rows): the choices in screen order, each with its digit (`key`: the
 * option's number on the screen, the owner's choice), the button label as the screen words it,
 * `steps` (what is sent, in order: a list of tmux key names, or "revalidate", a fresh read of the
 * pane that must still show this dialog with this option selected before the next keys) and
 * `live` (true only when that very sequence was checked live on that version: v2 correction 5).
 * In Codex 0.165.0's source (tui/src/onboarding/trust_directory.rs), "1" only selects Trust, which
 * always takes an Enter after it; "2" (like q and Esc) quits or goes back at once.
 */
const L = (re, gap) => Object.freeze({ re, gap });
const STEPS = (...steps) => Object.freeze(steps.map((x) => (Array.isArray(x) ? Object.freeze([...x]) : x)));
const OPTION = (key, action, label, steps, live) => Object.freeze({ key, action, label, steps, live });
const CODEX_TRUST = (second, action, label, footer, live) =>
  Object.freeze({
    cli: "codex",
    subtype: "codex-startup-trust",
    actionable: true,
    versions: Object.freeze(["0.165.0"]),
    footer: true,
    lines: Object.freeze([
      L(/^ {2}Folder access$/),
      L(/^ {2}Trust this folder\? Codex can read, edit, and run files here, subject to your( .*)?$/, 5),
      L(/^(› | {2})1\. Trust and continue$/, 6),
      L(new RegExp(`^(› | {2})2\\. ${second}$`), 0),
      L(new RegExp(`^ {2}enter continue · esc ${footer}$`), 1),
    ]),
    options: Object.freeze([OPTION("1", "trust", "Trust folder", STEPS(["1"], "revalidate", ["Enter"]), true), OPTION("2", action, label, STEPS(["2"]), live)]),
  });
const SHOWN = (subtype, re, extra = {}) => Object.freeze({ cli: null, subtype, actionable: false, versions: null, footer: false, lines: Object.freeze([L(re)]), ...extra });
export const PROMPTS = Object.freeze([
  // Started through hoptell tmux, option 2 quits Codex; started in a Codex app window, it goes back.
  // All three sequences were checked live on Codex 0.165.0: Back ("2", Codex run directly in plain
  // tmux) first; Quit ("2") and Trust ("1", the fresh read, Enter) on 30 October 2026, under
  // hoptell tmux with the launch's test switch, each tapped on the owner's Telegram card through
  // the live bridge: Quit ended Codex without trusting the folder, Trust took Codex on to its
  // input box and recorded the folder in its config.
  CODEX_TRUST("Quit", "quit", "Quit", "quit", true),
  CODEX_TRUST("Back to Agent Command Center", "back", "Back to Agent Command Center", "back", true),
  // Claude Code 2.1.312: "No, exit" first and selected, no digits: display-only in 0.4.0.
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
 * `folders`: the folder rows between its first two lines, read back as a path (joined as wrapped,
 * and joined with spaces); only the caller can tell which, if either, is the launch's folder.
 */
export function classifyPrompt(screen, { cli = null, version = null } = {}) {
  const all = rowsOf(screen);
  for (const p of PROMPTS) {
    if (p.cli && cli && p.cli !== cli) continue;
    const rows = p.footer ? all : all.slice(-BOTTOM);
    const at = holds(rows, p.lines);
    if (!at) continue;
    if (p.footer) {
      // Only blank rows may follow the dialog's last line: the agent's own screen, not transcript.
      if (rows.slice(at.at(-1) + 1).some((r) => r.trim())) continue;
    }
    const tested = p.actionable && p.cli === cli && Boolean(version) && p.versions.includes(version);
    let selected = null;
    if (p.options) {
      const marked = p.options.map((o, i) => /^› /.test(rows[at[2] + i] ?? ""));
      selected = marked.filter(Boolean).length === 1 ? marked.indexOf(true) + 1 : null;
    }
    const r = { subtype: p.subtype, actionable: tested, options: tested ? p.options.map((o) => ({ ...o, steps: o.steps.map((x) => (Array.isArray(x) ? [...x] : x)) })) : [], selected };
    if (tested) {
      // Every row from its title to its footer counts, in order; only wrapping is undone (the
      // folder's rows joined as wrapped, the other text as words). A row the matcher lets through
      // between the options and the footer is part of it too.
      const folder = rows.slice(at[0] + 1, at[1]).map((x) => x.replace(/^ {2}/, ""));
      const words = (from, to) => rows.slice(from, to).map((x) => x.trim()).filter(Boolean).join(" ").split(/\s+/).join(" ");
      const options = rows.slice(at[2], at[2] + p.options.length);
      const after = words(at[2] + p.options.length, at.at(-1));
      const sha = (o) => crypto.createHash("sha256").update(JSON.stringify([rows[at[0]].trim(), folder.join(""), words(at[1], at[2]), ...o, after, rows[at.at(-1)].trim()])).digest("hex");
      r.dialog = sha(options);
      r.frame = sha(options.map((x) => x.replace(/^› /, "  ")));
      r.folders = [...new Set([folder.join(""), folder.join(" ")])];
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
 * keeps the occurrence record. Quiet time counts from the later of the last change of the still
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
