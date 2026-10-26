#!/usr/bin/env node
// Render the slash-command eval cases: `claude plugin eval` sends a case's prompt as plain text and
// does not expand plugin commands, so each case under evals/commands/ gets the body of
// commands/<command>.md with its arguments filled in, framed as Claude Code frames an expanded
// command. Run it before `claude plugin eval` (test/skill-evals/run-evals.sh does), so the cases
// always use the current command text.
//
//   node test/skill-evals/render-commands.mjs [--check]
//
// --check: exit 1 when a rendered prompt.md is missing or out of date (nothing is written).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CASES = path.join(REPO, "evals", "commands");

/** The prompt.md text of one command case: its settings block, then the expanded command. */
export function renderCase({ name, command, args }) {
  const head = fs.readFileSync(path.join(CASES, name, "prompt.head.md"), "utf8");
  const source = fs.readFileSync(path.join(REPO, "commands", `${command}.md`), "utf8");
  const body = source.replace(/^---\n[\s\S]*?\n---\n/, "").trim();
  const expanded = body.includes("$ARGUMENTS") ? body.replaceAll("$ARGUMENTS", args) : `${body}\n\nARGUMENTS: ${args}`;
  const frame = [`<command-message>hoptell:${command}</command-message>`, `<command-name>/hoptell:${command}</command-name>`, `<command-args>${args}</command-args>`].join("\n");
  return `${head}\n${frame}\n\n${expanded}\n`;
}

export const commandCases = () => JSON.parse(fs.readFileSync(path.join(CASES, "commands.json"), "utf8"));

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes("--check");
  let stale = 0;
  for (const c of commandCases()) {
    const file = path.join(CASES, c.name, "prompt.md");
    const text = renderCase(c);
    const now = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
    if (now === text) continue;
    stale++;
    if (check) console.error(`out of date: ${path.relative(REPO, file)}`);
    else fs.writeFileSync(file, text);
  }
  if (check && stale) process.exit(1);
  if (!check) console.log(`rendered ${commandCases().length} command cases`);
}
