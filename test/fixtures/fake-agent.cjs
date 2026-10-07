// A fake terminal agent for injector tests. It draws a Claude Code style prompt ("❯" and a
// no-break space) and logs every Enter with what was in its input. A control file switches
// what is on screen: "prompt", "dialog" (an approval prompt), "shell" (an unknown layout),
// "dialog-on-paste" (an approval prompt comes up right as a paste arrives, for 3 seconds) or
// "draft-below" (an empty prompt row with the cursor on it, and a draft on the rows below) or
// "draft-rule" (the same, with a draft row drawn with box characters).
const fs = require("fs");
const [ctl, log] = process.argv.slice(2);
let input = "";
let mode = "prompt";
let onPaste = false;
const history = [];

function draw() {
  const RULE = "─".repeat(process.stdout.columns || 80); // full-width separator, like Claude Code
  let out = "\x1b[2J\x1b[H";
  for (const h of history.slice(-8)) out += `${h}\r\n`;
  if (mode === "dialog") out += "Do you want to proceed?\r\n❯ 1. Yes\r\n  2. No\r\n";
  else if (mode === "shell") out += `$ ${input}`;
  else if (mode === "draft-below") out += `${RULE}\r\n\x1b[39m❯\u00a0${input}\r\n\r\n  rm -rf build   (an unfinished draft)\r\n${RULE}\x1b[3A\x1b[${3 + input.length}G`;
  // Draft rows are indented, as Claude Code indents continuation lines.
  else if (mode === "draft-rule") out += `${RULE}\r\n\x1b[39m❯\u00a0${input}\r\n  ${RULE.slice(2)}\r\n  rm -rf build\r\n${RULE}\x1b[3A\x1b[${3 + input.length}G`;
  // Like Claude Code: the input row between two separator lines, the cursor after the input.
  else out += `${RULE}\r\n\x1b[39m❯\u00a0${input}\r\n${RULE}\x1b[1A\x1b[${3 + input.length}G`;
  process.stdout.write(out);
}

setInterval(() => {
  let m = "prompt";
  try {
    m = fs.readFileSync(ctl, "utf8").trim() || "prompt";
  } catch {
    // keep the default
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
  for (const ch of s) {
    if (ch === "\r") {
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
