// A fake terminal agent for injector tests. It draws a Claude Code style prompt ("❯" and a
// no-break space) and logs every Enter with what was in its input. A control file switches
// what is on screen: "prompt", "dialog" (an approval prompt), "shell" (an unknown layout),
// "dialog-on-paste" (an approval prompt comes up right as a paste arrives, for 3 seconds) or
// "draft-below" (an empty prompt row with the cursor on it, and a draft on the rows below) or
// "draft-rule" (the same, with a draft row drawn with box characters).
// Codex layouts (Codex 0.162.1: "›", a dim placeholder, input wrapped by the agent with
// two-space continuation rows, a footer row below): "codex"; "codex-selected" (its transcript
// selection footer is open, the cursor still on the empty prompt); "codex-select-on-paste" (the
// selection opens as a paste arrives and closes 3 seconds later; meanwhile the cursor is hidden
// and away from the prompt, and Enter copies instead of submitting, logged as mode "selection");
// "codex-select-foreign" (the same, and the draft changes as the selection closes). Codex
// modes with "-dialog" show an approval prompt for 3 seconds as a paste arrives; with "-capped"
// the composer shows at most 4 rows, scrolled to the end, with "↑" on its first row as Codex
// 0.162.1 draws it; with "-edit" the draft's first characters (hidden when capped) change as the
// approval prompt closes. "flash:<mode>" shows one frame with another draft for 700 ms (as a
// capture taken mid-redraw or mid-resize can), then switches to <mode> with the draft unchanged.
// "eflash:<mode>" switches to <mode> and edits the draft for good (as a person would), but the
// screen shows the old draft again for 700 ms after 600 ms (a stale frame), then the edit.
const fs = require("fs");
const [ctl, log] = process.argv.slice(2);
let input = "";
let mode = "prompt";
let onPaste = false;
let selecting = false;
let dialog = false;
let display = null; // a passing frame: the draft shown instead of the real one
const history = [];
const SELECTION_FOOTER = "New activity · ⌃c copy · enter copy & follow · esc clear"; // as observed on Codex 0.162.1

function drawCodex(cols, top) {
  const text = display ?? input; // what the screen shows (a passing frame may show another draft)
  let out = "\r\n";
  if (dialog) return `${out}Do you want to proceed?\r\n› 1. Yes\r\n  2. No\r\n`;
  const capped = mode.includes("-capped");
  const width = cols - 3; // the right column stays free (Codex draws its "↑" there when capped)
  const all = [];
  for (let i = 0; i < text.length; i += width) all.push(text.slice(i, i + width));
  const rows = capped ? all.slice(-4) : all;
  const hidden = all.length > rows.length;
  if (!text) out += "\x1b[1m›\x1b[0m \x1b[2mAsk Codex to do anything\x1b[0m";
  else out += rows.map((r, i) => (i ? `  ${r}` : `\x1b[1m›\x1b[0m ${hidden ? `${r.padEnd(width)}\x1b[2m↑\x1b[0m` : r}`)).join("\r\n");
  const footer = selecting || mode === "codex-selected" ? SELECTION_FOOTER : "? for shortcuts";
  out += `\r\n\r\n  ${footer}`;
  // Screen rows (1-based): the history, a blank row, the text rows, a blank row, the footer.
  const promptRow = top + 2;
  const last = Math.max(rows.length, 1) - 1;
  const col = 2 + (text ? rows[last].length : 0);
  // While the selection has focus the composer shows no cursor.
  if (selecting) return `${out}\x1b[?25l\x1b[${promptRow + last + 2};1H`;
  return `${out}\x1b[?25h\x1b[${promptRow + last};${col + 1}H`;
}

function draw() {
  const cols = process.stdout.columns || 80;
  const RULE = "─".repeat(cols); // full-width separator, like Claude Code
  let out = "\x1b[2J\x1b[H";
  const shown = history.slice(-8);
  for (const h of shown) out += `${h}\r\n`;
  if (mode.startsWith("codex")) return process.stdout.write(out + drawCodex(cols, shown.length));
  if (mode === "dialog") out += "Do you want to proceed?\r\n❯ 1. Yes\r\n  2. No\r\n";
  else if (mode === "shell") out += `$ ${input}`;
  else if (mode === "draft-below") out += `${RULE}\r\n\x1b[39m❯\u00a0${input}\r\n\r\n  rm -rf build   (an unfinished draft)\r\n${RULE}\x1b[3A\x1b[${3 + input.length}G`;
  // Draft rows are indented, as Claude Code indents continuation lines.
  else if (mode === "draft-rule") out += `${RULE}\r\n\x1b[39m❯\u00a0${input}\r\n  ${RULE.slice(2)}\r\n  rm -rf build\r\n${RULE}\x1b[3A\x1b[${3 + input.length}G`;
  // Like Claude Code: the input row between two separator lines, the cursor after the input
  // (on the terminal's wrapped rows when the input is longer than the pane is wide).
  else {
    const end = 2 + input.length;
    out += `${RULE}\r\n\x1b[39m❯\u00a0${input}\r\n${RULE}\x1b[${shown.length + 2 + Math.floor(end / cols)};${(end % cols) + 1}H`;
  }
  process.stdout.write(out);
}

setInterval(() => {
  let m = "prompt";
  try {
    m = fs.readFileSync(ctl, "utf8").trim() || "prompt";
  } catch {
    // keep the default
  }
  if (m.startsWith("flash:")) {
    const real = input;
    input = "a draft that is not the notice";
    draw();
    input = real;
    try {
      fs.writeFileSync(ctl, m.slice(6));
    } catch {
      // the next poll tries again
    }
    mode = m.slice(6);
    setTimeout(draw, 700);
    return;
  }
  if (m.startsWith("eflash:")) {
    try {
      fs.writeFileSync(ctl, m.slice(7));
    } catch {
      // the next poll tries again
    }
    mode = m.slice(7);
    const old = input;
    input = `${input} and my own words`;
    draw();
    setTimeout(() => {
      display = old;
      draw();
      setTimeout(() => {
        display = null;
        draw();
      }, 700);
    }, 600);
    return;
  }
  onPaste = m === "dialog-on-paste";
  const next = onPaste ? (mode === "dialog" ? "dialog" : "prompt") : m;
  if (next !== mode) {
    mode = next;
    draw();
  }
}, 100);

process.stdout.write("\x1b[?2004h"); // bracketed paste on
process.stdin.setRawMode(true);
process.stdin.on("data", (d) => {
  let s = d.toString();
  // eslint-disable-next-line no-control-regex -- bracketed paste markers
  s = s.replace(/\x1b\[200~([\s\S]*?)\x1b\[201~/g, (_, p) => {
    input += p;
    fs.appendFileSync(`${log}.paste`, `${Date.now()}\n`);
    if (mode.startsWith("codex") && mode.includes("-dialog")) {
      dialog = true;
      setTimeout(() => {
        dialog = false;
        if (mode.includes("-edit")) input = `IGNORE!${input.slice(7)}`;
        draw();
      }, 3000);
    }
    if (mode === "codex-select-on-paste" || mode === "codex-select-foreign") {
      selecting = true;
      setTimeout(() => {
        selecting = false;
        if (mode === "codex-select-foreign") input += " and my own words";
        draw();
      }, 3000);
    }
    if (onPaste) {
      mode = "dialog";
      setTimeout(() => {
        mode = "prompt";
        fs.writeFileSync(ctl, "prompt");
        draw();
      }, 3000);
    }
    return "";
  });
  // eslint-disable-next-line no-control-regex -- cursor keys: the cursor stays at the end, the draft unchanged
  s = s.replace(/\x1b(\[[0-9;]*[A-Za-z]|O[A-Za-z])/g, "");
  for (const ch of s) {
    if (ch === "\r" && selecting) fs.appendFileSync(log, `${JSON.stringify({ mode: "selection", input, at: Date.now() })}\n`); // copy & follow: the draft stays
    else if (selecting) continue;
    else if (ch === "\r") {
      fs.appendFileSync(log, `${JSON.stringify({ mode, input, at: Date.now() })}\n`);
      history.push(`> ${input.slice(0, 40)}`);
      input = "";
    } else if (ch === "\x15") input = ""; // Ctrl-U
    else if (ch >= " ") input += ch;
  }
  draw();
});
process.stdout.on("resize", draw); // redraw at the new width, as real agents do
draw();
