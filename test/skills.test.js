// The Claude Code plugin's skills (skills/<name>/SKILL.md) and slash commands (commands/*.md):
// their frontmatter, the hoptell commands they show, the skills the commands name, and no
// personal paths, private addresses or credentials.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HELP } from "../lib/clihelp.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKILLS = path.join(REPO, "skills");
const COMMANDS = path.join(REPO, "commands");

const skillNames = () => fs.readdirSync(SKILLS, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
const commandFiles = () => fs.readdirSync(COMMANDS).filter((n) => n.endsWith(".md")).sort();

/** Every Markdown file under skills/ and commands/ (paths relative to the repo). */
function pluginDocs() {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(path.join(REPO, dir), { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out.push(p);
    }
  };
  walk("skills");
  walk("commands");
  return out.sort();
}

/** The frontmatter of a Markdown file as {key: string value}, or null when it has none. Flat `key: value` lines only. */
function frontmatter(text) {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!m) return null;
  const out = {};
  for (const line of m[1].split("\n")) {
    if (!line.trim()) continue;
    const kv = /^([a-z][a-z0-9-]*):\s*(.*)$/.exec(line);
    assert.ok(kv, `frontmatter line is not "key: value": ${line}`);
    let v = kv[2].trim();
    if (/^".*"$/.test(v)) v = JSON.parse(v);
    out[kv[1]] = v;
  }
  return out;
}

const read = (rel) => fs.readFileSync(path.join(REPO, rel), "utf8");

test("skills: each SKILL.md has a name that matches its folder and a sensible description", () => {
  const names = skillNames();
  assert.deepEqual(names, ["hoptell-owner-channel", "hoptell-reviewers", "hoptell-safe-ops"]);
  for (const n of names) {
    const fm = frontmatter(read(path.join("skills", n, "SKILL.md")));
    assert.ok(fm, `${n}: no frontmatter`);
    assert.equal(fm.name, n);
    assert.match(fm.name, /^[a-z0-9-]{1,64}$/);
    assert.ok(fm.description.length >= 80 && fm.description.length <= 1024, `${n}: description length ${fm.description.length}`);
    assert.match(fm.description, /^This skill should be used when/);
    const body = read(path.join("skills", n, "SKILL.md")).replace(/^---\n[\s\S]*?\n---\n/, "");
    const words = body.split(/\s+/).filter(Boolean).length;
    assert.ok(words >= 150 && words <= 2000, `${n}: body has ${words} words`);
  }
});

test("skills: every references/ file a SKILL.md names exists, and every references/ file is named", () => {
  for (const n of skillNames()) {
    const text = read(path.join("skills", n, "SKILL.md"));
    const named = new Set([...text.matchAll(/`(references\/[^`]+)`/g)].map((m) => m[1]));
    for (const r of named) assert.ok(fs.existsSync(path.join(SKILLS, n, r)), `${n}: ${r} is missing`);
    const dir = path.join(SKILLS, n, "references");
    const present = fs.existsSync(dir) ? fs.readdirSync(dir).map((f) => `references/${f}`) : [];
    for (const r of present) assert.ok(named.has(r), `${n}: ${r} is not named in SKILL.md`);
  }
});

test("commands: each has a description, narrow allowed-tools, and names an existing skill", () => {
  const files = commandFiles();
  assert.deepEqual(files, ["ask-owner.md", "peers.md", "review.md", "reviewers.md"]);
  const skills = skillNames();
  for (const f of files) {
    const text = read(path.join("commands", f));
    const fm = frontmatter(text);
    assert.ok(fm, `${f}: no frontmatter`);
    assert.ok(fm.description && fm.description.length >= 10 && fm.description.length <= 120, `${f}: description`);
    assert.ok(fm["allowed-tools"], `${f}: no allowed-tools`);
    for (const t of fm["allowed-tools"].split(",").map((s) => s.trim())) {
      // Only the Skill and Read tools, hoptell's own MCP tools, and `hoptell snapshot` in Bash.
      assert.match(t, /^(Skill|Read|mcp__plugin_hoptell_hoptell__[a-z_]+|Bash\(hoptell snapshot:\*\))$/, `${f}: ${t}`);
    }
    assert.ok(!/\bBash\b(?!\(hoptell snapshot)/.test(fm["allowed-tools"]), `${f}: broad Bash`);
    const named = skills.filter((s) => new RegExp(`\\b${s}\\b`).test(text));
    assert.ok(named.length >= 1, `${f}: names no existing skill`);
    for (const m of text.matchAll(/\b(hoptell-[a-z-]+) skill\b/g)) assert.ok(skills.includes(m[1]), `${f}: unknown skill ${m[1]}`);
  }
});

test("skills and commands: every `hoptell <command>` in a code fence or code span exists", () => {
  const known = new Set(Object.keys(HELP));
  for (const f of pluginDocs()) {
    const text = read(f);
    const code = [...text.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map((m) => m[1]);
    code.push(...[...text.replace(/```[\s\S]*?```/g, "").matchAll(/`([^`\n]+)`/g)].map((m) => m[1]));
    let seen = 0;
    for (const c of code) {
      for (const m of c.matchAll(/(?:^|[\s"'(])hoptell\s+([a-z][a-z-]*)/g)) {
        seen++;
        assert.ok(known.has(m[1]), `${f}: unknown command "hoptell ${m[1]}"`);
      }
    }
    if (f.endsWith("hoptell-reviewers/SKILL.md")) assert.ok(seen >= 3, "the reviewers skill shows its commands");
  }
});

test("skills and commands: no personal paths, private addresses or credentials", () => {
  const banned = [
    /\/Users\//, // a macOS home folder
    /\/home\/[a-z]/, // a Linux home folder
    /\b10\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/, // private IPv4 ranges
    /\b192\.168\.\d{1,3}\.\d{1,3}\b/,
    /\b172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}\b/,
    /\b(ghp|gho|github_pat)_[A-Za-z0-9_]{20,}/, // GitHub tokens
    /\bsk-[A-Za-z0-9_-]{20,}/, // API keys
    /\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/, // Telegram bot tokens
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  ];
  // Names that must stay out of the repository can be kept in a local file outside it, one
  // regular expression per line: HOPTELL_DOCS_DENYLIST=/path/to/file.
  const extra = process.env.HOPTELL_DOCS_DENYLIST;
  if (extra) for (const line of fs.readFileSync(extra, "utf8").split("\n").map((l) => l.trim()).filter(Boolean)) banned.push(new RegExp(line, "i"));
  for (const f of pluginDocs()) {
    const text = read(f);
    for (const re of banned) assert.ok(!re.test(text), `${f}: matches ${re}`);
  }
});

test("commands: each is user-only (disable-model-invocation), and the skills are model-only (user-invocable: false)", () => {
  // The menu shows exactly the four commands; the skills still load on their own.
  for (const f of commandFiles()) assert.equal(frontmatter(read(path.join("commands", f)))["disable-model-invocation"], "true", f);
  for (const n of skillNames()) assert.equal(frontmatter(read(path.join("skills", n, "SKILL.md")))["user-invocable"], "false", n);
});

/** The plugin's docs plus the README section about reviewers. */
function recipeDocs() {
  const readme = read("README.md");
  const start = readme.indexOf("## Working with reviewer agents");
  assert.ok(start >= 0);
  const end = readme.indexOf("\n## ", start + 3);
  return [...pluginDocs().map((f) => [f, read(f)]), ["README.md (reviewer agents)", readme.slice(start, end)]];
}

test("recipes: tmux targets name the exact session, with =", () => {
  for (const [f, text] of recipeDocs()) {
    // `-t hoptell-x` prefix-matches a longer name such as hoptell-x-10; `-t '=hoptell-x'` does not.
    for (const m of text.matchAll(/tmux (kill-session|attach|attach-session|has-session|display-message)[^\n`]*?-t\s+(\S+)/g)) {
      assert.match(m[2], /^['"]?=/, `${f}: ${m[0]}`);
    }
  }
});

test("recipes: reviewer launches set HOPTELL_PUSH=tmux, Codex is read-only and Claude Code starts in plan mode", () => {
  let launches = 0;
  for (const [f, text] of recipeDocs()) {
    assert.ok(!/-u HOPTELL_PUSH\b/.test(text), `${f}: unsetting HOPTELL_PUSH can load another value from the settings file`);
    for (const line of text.split("\n").filter((l) => /hoptell tmux \S+ --roles reviewer -- /.test(l))) {
      launches++;
      assert.match(line, /HOPTELL_PUSH=tmux hoptell tmux/, `${f}: ${line}`);
      const agent = line.slice(line.indexOf(" -- ") + 4);
      // A new reviewer gets its task from the user's launch command (hoptell tells agents to
      // handle peer requests only within their user's task); a resumed one keeps its history.
      if (!/^codex resume\b/.test(agent)) assert.match(agent, / "(You are a read-only reviewer for (\S+)\. Review requests from \2 are your task: review them and reply with send_message\. Do not edit files\.|<prompt>)"/, `${f}: ${line}`);
      if (/^codex\b/.test(agent)) assert.match(agent, /-s read-only\b.*-a never\b/, `${f}: ${line}`);
      if (/^claude\b/.test(agent)) {
        assert.match(agent, /--permission-mode plan\b/, `${f}: ${line}`);
        assert.ok(!/server:hoptell|--channels|dangerously|bypassPermissions|acceptEdits/.test(agent), `${f}: ${line}`);
      }
    }
  }
  assert.ok(launches >= 4, `only ${launches} reviewer launch lines`);
});

test("plugin: skills and commands sit where the plugin's manifest auto-discovers them", () => {
  const manifest = JSON.parse(read(".claude-plugin/plugin.json"));
  // No custom paths: Claude Code then loads commands/ and skills/ at the plugin root.
  assert.equal(manifest.commands, undefined);
  assert.equal(manifest.skills, undefined);
  const market = JSON.parse(read(".claude-plugin/marketplace.json"));
  assert.equal(market.plugins.find((p) => p.name === manifest.name)?.source, "./");
});
