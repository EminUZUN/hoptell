// A stand-in for Codex 0.165.0's startup folder-trust dialog, for the prompt answer tests (design 9,
// C). It draws the live capture `codex-0.165.0-trust-hoptelltmux-w200` (test/fixtures/
// prompt-screens.json) and acts as Codex 0.165.0's source does (tui/src/onboarding/
// trust_directory.rs): "1" only selects Trust, "2" quits at once, Enter acts on the selected row.
// Every key it gets is appended to the log file (argv[2]), one per line, with what it did.
// argv[3] ("normal", "start-on-2", "one-selects-two" or "foreign-after-one") changes what it shows
// or does, for the refusal tests: "foreign-after-one" starts on Quit, and "1" shows another
// program's approval prompt for a moment, then the dialog again with Trust selected. A line "redraw <folder>" in the
// control file (argv[4]) redraws with another folder (the screen changed between the card and the
// tap). argv[5], when given, is the folder the dialog names from the start (a real launch's).
const fs = require("node:fs");
const path = require("node:path");

const [log, mode = "normal", ctl = null, folder = null] = process.argv.slice(2);
const screens = JSON.parse(fs.readFileSync(path.join(__dirname, "prompt-screens.json"), "utf8")).screens;
const rows = screens.find((s) => s.name === "codex-0.165.0-trust-hoptelltmux-w200").rows.slice();
let selected = mode === "start-on-2" || mode === "foreign-after-one" ? 2 : 1;
let folderRows = folder ? [`  ${folder}`, ""] : null;
const note = (line) => fs.appendFileSync(log, `${line}\n`);

function draw() {
  const out = rows.map((r) => r);
  if (folderRows) out.splice(2, 2, ...folderRows);
  const i = out.findIndex((r) => /^(› | {2})1\. /.test(r));
  out[i] = `${selected === 1 ? "›" : " "} 1. Trust and continue`;
  out[i + 1] = `${selected === 2 ? "›" : " "} 2. Quit`;
  process.stdout.write(`\x1b[2J\x1b[H${out.join("\r\n")}\r\n`);
}

function done(word) {
  note(word);
  process.stdout.write(`\x1b[2J\x1b[H${word}\r\n`);
  setTimeout(() => process.exit(0), 50);
}

process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on("data", (b) => {
  for (const ch of b.toString("utf8")) {
    if (ch === "1") {
      selected = mode === "one-selects-two" ? 2 : 1;
      note("key 1");
      if (mode === "foreign-after-one") {
        process.stdout.write("\x1b[2J\x1b[HWould you like to run the following command?\r\n\r\n  $ rm -rf build\r\n\r\n› 1. Yes, proceed\r\n  2. No\r\n");
        setTimeout(draw, 400);
      } else draw();
    } else if (ch === "2") {
      note("key 2");
      return done("QUIT");
    } else if (ch === "\r") {
      note("key Enter");
      return done(selected === 1 ? "TRUSTED" : "QUIT");
    } else {
      note(`key ${JSON.stringify(ch)}`);
    }
  }
});
if (ctl && ctl !== "-") {
  setInterval(() => {
    try {
      const m = fs.readFileSync(ctl, "utf8").match(/^redraw (.+)$/m);
      if (m && !folderRows) {
        folderRows = [`  ${m[1]}`, ""];
        draw();
      }
    } catch {}
  }, 50);
}
draw();
note("ready");
