// A stand-in for the startup folder-trust dialog of Claude Code 2.1.314 or agy 1.4.11, for the
// prompt answer tests (design 10, trust buttons). It draws the live capture
// `claude-2.1.314-trust-w120` or `agy-1.4.11-trust-w120` (test/fixtures/prompt-screens.json) with
// the folder argv[5], and acts as each was seen to act, run directly in tmux: Down and Up move
// the selection and wrap, digits do nothing, Esc exits, Enter acts on the selected row (Claude
// Code: "No, exit" first and selected, the cursor on the selected row; agy: "Yes" first and
// selected). A Trust shows the CLI's empty input between two rules; a Quit exits.
// argv: the log file (every key it gets, one per line, with what it did), the CLI ("claude" or
// "agy"), the mode, a control file ("-": none) and the folder. Modes: "normal", "start-on-2"
// (the other row selected from the start), "lost-down" (a Down is logged and lost), "drop-enter"
// (an Enter is logged and dropped, as Claude Code drops one that comes as it draws),
// "trust-exits" (exits after a Trust), "trust-other" (shows a screen that is none of the known
// ones after a Trust), "quit-stays" (Esc clears the dialog, and it keeps running). A line
// "redraw" in the control file draws the dialog again for another folder (another frame), at once
// or with the next Down.
const fs = require("node:fs");
const path = require("node:path");

const [log, cli, mode = "normal", ctl = null, folder = "/private/tmp/hoptell-fake-folder"] = process.argv.slice(2);
const screens = JSON.parse(fs.readFileSync(path.join(__dirname, "prompt-screens.json"), "utf8")).screens;
const base = screens.find((s) => s.name === (cli === "agy" ? "agy-1.4.11-trust-w120" : "claude-2.1.314-trust-w120")).rows.slice();
const at = base.findIndex((r) => /Accessing workspace:$/.test(r)) + 2;
// The capture's folder rows (Claude Code wraps it at 120 columns) give way to this folder's.
const end = base.findIndex((r, i) => i > at && r === "");
const indent = cli === "agy" ? "" : " ";
base.splice(at, end - at, `${indent}${folder}`);
const claude = cli !== "agy";
const yesRow = claude ? 2 : 1; // the row of "Yes, I trust this folder"
let selected = mode === "start-on-2" ? 2 : 1;
let moved = false;
const note = (line) => fs.appendFileSync(log, `${line}\n`);

function draw() {
  const out = base.slice();
  const i = out.findIndex((r) => /(No, exit|Yes, I trust this folder)$/.test(r));
  const mark = claude ? [" ❯ ", "   "] : ["> ", "  "];
  const text = (r) => r.replace(/^( ❯ | {3}|> | {2})/, "");
  out[i] = `${selected === 1 ? mark[0] : mark[1]}${text(out[i])}`;
  out[i + 1] = `${selected === 2 ? mark[0] : mark[1]}${text(out[i + 1])}`;
  const y = i + selected; // the selected option's row, counted from 1
  process.stdout.write(`\x1b[2J\x1b[H${out.join("\r\n")}\r\n\x1b[${y};${claude ? 2 : 1}H`);
}

function input(word) {
  const w = process.stdout.columns || 80;
  const rule = "─".repeat(w);
  process.stdout.write(`\x1b[2J\x1b[H${word}\r\n\r\n${rule}\r\n${claude ? "❯" : ">"} \r\n${rule}\r\n\x1b[4;3H`);
}

function done(word) {
  note(word);
  if (word === "TRUSTED" && mode === "trust-other") return void process.stdout.write("\x1b[2J\x1b[HSomething else entirely\r\n");
  if (word === "TRUSTED" && mode !== "trust-exits") return input(word);
  if (word === "QUIT" && mode === "quit-stays") return void process.stdout.write("\x1b[2J\x1b[HGoodbye, still here\r\n");
  process.stdout.write(`\x1b[2J\x1b[H${word}\r\n`);
  setTimeout(() => process.exit(0), 50);
}

let gone = false;
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on("data", (b) => {
  if (gone) return note(`key ${JSON.stringify(b.toString("utf8"))} (after)`);
  const s = b.toString("utf8");
  if (s === "\x1b") {
    note("key Escape");
    gone = true;
    return done("QUIT");
  }
  if (s === "\x1b[B" || s === "\x1b[A" || s === "\x1bOB" || s === "\x1bOA") {
    note(s.endsWith("B") ? "key Down" : "key Up");
    if (mode === "lost-down") return;
    selected = selected === 1 ? 2 : 1;
    moveIfAsked();
    return draw();
  }
  for (const ch of s) {
    if (ch === "\r") {
      note("key Enter");
      if (mode === "drop-enter") continue;
      gone = true;
      return done(selected === yesRow ? "TRUSTED" : "QUIT");
    }
    note(`key ${JSON.stringify(ch)}`);
  }
});
/** True when the control file asks for another folder (once). */
function moveIfAsked() {
  try {
    if (moved || !ctl || ctl === "-" || !/^redraw$/m.test(fs.readFileSync(ctl, "utf8"))) return false;
  } catch {
    return false;
  }
  moved = true;
  base[at] = `${indent}${folder}-elsewhere`;
  return true;
}
setInterval(() => moveIfAsked() && draw(), 50);
draw();
note("ready");
