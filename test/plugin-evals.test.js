// The plugin's eval suites (evals/, run by `claude plugin eval` through test/skill-evals/run-evals.sh)
// and the trigger sets (test/skill-evals/triggers/): their shape, without running a model. Every
// case loads (a prompt and at least one grader), every grader's pattern compiles, every mocked or
// graded hoptell tool exists in the real catalog, negative checks count in both arms, and nothing
// personal is committed.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_TOOLS } from "../lib/agentspawn.js";
import { RUN_TOOLS } from "../lib/mcp.js";
import { commandCases, renderCase } from "./skill-evals/render-commands.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EVALS = path.join(REPO, "evals");
const MCP = "mcp__plugin_hoptell_hoptell__";
const RESERVED = new Set(["mocks", "files", "results", "graders", "node_modules"]);

/** Case folders: a folder with prompt.md, prompt.head.md (a command case) or case.yaml. */
function caseDirs(dir = EVALS, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory() || RESERVED.has(e.name)) continue;
    const d = path.join(dir, e.name);
    if (["prompt.md", "prompt.head.md", "case.yaml"].some((f) => fs.existsSync(path.join(d, f)))) out.push(d);
    else caseDirs(d, out);
  }
  return out.sort();
}

/** A grader's frontmatter as {key: value}; nested maps (tool_order's before/after) as objects. */
function graderOf(file) {
  const text = fs.readFileSync(file, "utf8");
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  assert.ok(m, `${file}: no frontmatter`);
  const out = { _body: m[2].trim() };
  let parent = null;
  for (const line of m[1].split("\n")) {
    const kv = /^( {2})?([a-z_]+):\s*(.*)$/.exec(line);
    assert.ok(kv, `${file}: bad line ${line}`);
    let v = kv[3];
    if (/^'.*'$/.test(v)) v = v.slice(1, -1).replace(/''/g, "'");
    else if (/^\d+$/.test(v)) v = Number(v);
    if (kv[1]) out[parent][kv[2]] = v;
    else if (v === "") out[(parent = kv[2])] = {};
    else out[kv[2]] = v;
  }
  return out;
}

const catalog = () => JSON.parse(fs.readFileSync(path.join(EVALS, "mocks", "hoptell", "_tools.json"), "utf8")).tools;

test("evals: every case has a prompt and graders of a known type, with patterns that compile", () => {
  const dirs = caseDirs();
  assert.ok(dirs.length >= 20, `only ${dirs.length} cases`);
  const names = new Set();
  for (const d of dirs) {
    const name = path.basename(d);
    assert.match(name, /^[a-z][a-z0-9-]*$/);
    assert.ok(!names.has(name), `two cases named ${name}`);
    names.add(name);
    const prompt = fs.existsSync(path.join(d, "prompt.md")) ? "prompt.md" : "prompt.head.md";
    assert.ok(fs.existsSync(path.join(d, prompt)), `${name}: no prompt`);
    const head = /^---\n([\s\S]*?)\n---\n/.exec(fs.readFileSync(path.join(d, prompt), "utf8"));
    assert.ok(head, `${name}: the prompt has no settings block`);
    for (const line of head[1].split("\n")) assert.match(line, /^(description|tags|max_turns|timeout_seconds|allowed_tools|runs|model):/, `${name}: unknown setting ${line}`);
    const graders = fs.readdirSync(path.join(d, "graders")).filter((f) => f.endsWith(".md"));
    assert.ok(graders.length >= 1, `${name}: no graders`);
    for (const f of graders) {
      const g = graderOf(path.join(d, "graders", f));
      assert.ok(["tool_used", "tool_order", "llm", "regex"].includes(g.type), `${name}/${f}: type ${g.type}`);
      for (const re of [g.input_match, g.pattern, g.before?.input_match, g.after?.input_match].filter(Boolean)) assert.doesNotThrow(() => new RegExp(re), `${name}/${f}: ${re}`);
      if (g.type === "llm") assert.ok(/PASS/.test(g._body) && /FAIL/.test(g._body), `${name}/${f}: a judge needs PASS and FAIL conditions`);
      // A "must not happen" check counts in the baseline arm too, or it never affects the score.
      if (g.type === "tool_used" && g.max === 0) assert.equal(g.arm, "both", `${name}/${f}: a negative check needs arm: both`);
    }
    if (fs.existsSync(path.join(d, "case.yaml"))) {
      const yaml = fs.readFileSync(path.join(d, "case.yaml"), "utf8");
      assert.match(yaml, /^schema_version: "1\.1"$/m);
      assert.match(yaml, new RegExp(`^name: ${name}$`, "m"));
      const script = /scaffold_script: (\S+)/.exec(yaml)?.[1];
      if (script) assert.ok(fs.existsSync(path.join(d, script)) && fs.existsSync(path.join(d, "files")), `${name}: scaffold without files`);
    }
  }
});

test("evals: each skill has should-trigger and should-not-trigger cases, and each command a case", () => {
  for (const skill of ["hoptell-reviewers", "hoptell-owner-channel", "hoptell-safe-ops"]) {
    const dirs = caseDirs(path.join(EVALS, skill));
    const graders = dirs.map((d) => fs.readdirSync(path.join(d, "graders")).map((f) => graderOf(path.join(d, "graders", f))));
    const fires = (gs) => gs.some((g) => g.tool === "Skill" && new RegExp(skill).test(g.input_match) && g.max === undefined);
    const stays = (gs) => gs.some((g) => g.tool === "Skill" && new RegExp(skill).test(g.input_match) && g.max === 0);
    assert.ok(graders.filter(fires).length >= 2, `${skill}: should-trigger cases`);
    assert.ok(graders.filter(stays).length >= 1, `${skill}: should-not-trigger cases`);
  }
  const commands = fs.readdirSync(path.join(REPO, "commands")).map((f) => f.replace(/\.md$/, ""));
  const covered = new Set(commandCases().map((c) => c.command));
  for (const c of commands) assert.ok(covered.has(c), `no eval case for /hoptell:${c}`);
});

test("evals: command cases render from the current command files", () => {
  for (const c of commandCases()) {
    assert.ok(fs.existsSync(path.join(REPO, "commands", `${c.command}.md`)), c.command);
    const text = renderCase(c);
    assert.ok(!text.includes("$ARGUMENTS"));
    assert.ok(text.includes(`/hoptell:${c.command}`));
  }
});

test("evals: mocked and graded hoptell tools exist in the server's catalog", () => {
  const tools = catalog();
  const names = new Set(tools.map((t) => t.name));
  // The catalog is a tools/list capture (test/skill-evals/capture-mocks.mjs): the run tools,
  // ask_owner and the spawn tools, with the spawn tools' schemas as the code has them.
  for (const n of [...RUN_TOOLS.filter((t) => t !== "read_task"), "ask_owner", ...AGENT_TOOLS.map((t) => t.name)]) assert.ok(names.has(n), `catalog lacks ${n}`);
  for (const t of AGENT_TOOLS) assert.deepEqual(tools.find((x) => x.name === t.name).inputSchema, t.inputSchema);
  const mockDirs = [path.join(EVALS, "mocks", "hoptell"), ...caseDirs().map((d) => path.join(d, "mocks", "hoptell")).filter((d) => fs.existsSync(d))];
  for (const d of mockDirs) {
    for (const f of fs.readdirSync(d).filter((x) => x.endsWith(".md"))) {
      assert.ok(names.has(f.slice(0, -3)), `${path.relative(REPO, d)}/${f}: no such tool`);
      assert.match(fs.readFileSync(path.join(d, f), "utf8"), /^---\n[\s\S]*?---\n\S/, `${f}: a mock needs a frontmatter block and a body`);
    }
  }
  for (const d of caseDirs()) {
    for (const f of fs.readdirSync(path.join(d, "graders"))) {
      const g = graderOf(path.join(d, "graders", f));
      for (const tool of [g.tool, g.before?.tool, g.after?.tool].filter(Boolean)) if (tool.startsWith(MCP)) assert.ok(names.has(tool.slice(MCP.length)), `${path.basename(d)}/${f}: ${tool}`);
    }
  }
});

test("evals and trigger sets: no personal paths, private addresses or credentials", () => {
  const banned = [/\/Users\//, /\/home\/(?!dana\/)[a-z]/, /\b10\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/, /\b192\.168\./, /\b(ghp|gho|github_pat)_[A-Za-z0-9_]{20,}/, /\bsk-[A-Za-z0-9_-]{20,}/, /\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/];
  const extra = process.env.HOPTELL_DOCS_DENYLIST;
  if (extra) for (const line of fs.readFileSync(extra, "utf8").split("\n").map((l) => l.trim()).filter(Boolean)) banned.push(new RegExp(line, "i"));
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "results") continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else files.push(p);
    }
  };
  walk(EVALS);
  walk(path.join(REPO, "test", "skill-evals"));
  for (const f of files) {
    const text = fs.readFileSync(f, "utf8");
    for (const re of banned) assert.ok(!re.test(text), `${path.relative(REPO, f)}: matches ${re}`);
  }
});

test("trigger sets: realistic should-trigger and should-not-trigger queries for each skill", () => {
  for (const skill of ["hoptell-reviewers", "hoptell-owner-channel", "hoptell-safe-ops"]) {
    const set = JSON.parse(fs.readFileSync(path.join(REPO, "test", "skill-evals", "triggers", `${skill}.json`), "utf8"));
    assert.ok(set.length >= 16, skill);
    assert.ok(set.filter((q) => q.should_trigger === true).length >= 8, `${skill}: should-trigger`);
    assert.ok(set.filter((q) => q.should_trigger === false).length >= 8, `${skill}: should-not-trigger`);
    assert.equal(new Set(set.map((q) => q.query)).size, set.length, `${skill}: duplicate query`);
  }
});

/**
 * The deterministic graders of one case applied to a made-up run, the way `claude plugin eval`
 * applies them: tool_used matches the JSON of each call's input (denied calls count), and a regex
 * with target last_message matches the final reply. Judges and tool_order are left out.
 */
function gradeRun(caseDir, run) {
  const out = [];
  for (const f of fs.readdirSync(path.join(caseDir, "graders")).sort()) {
    const g = graderOf(path.join(caseDir, "graders", f));
    if (g.type === "tool_used") {
      if (g.tool === "Skill") continue; // the skill-fired indicator, not scored
      const n = run.calls.filter((c) => c.tool === g.tool && (!g.input_match || new RegExp(g.input_match).test(JSON.stringify(c.input)))).length;
      out.push({ f, passed: n >= (g.min ?? 1) && (g.max === undefined || n <= g.max) });
    } else if (g.type === "regex") {
      assert.equal(g.target, "last_message", `${f}: a launch or stop check reads the reply, never the trace`);
      const hit = new RegExp(g.pattern, g.flags).test(run.reply);
      out.push({ f, passed: g.match === "not_contains" ? !hit : hit });
    }
  }
  return out;
}
const bash = (command) => ({ tool: "Bash", input: { command, description: "x" } });
const PEERS = { tool: `${MCP}list_peers`, input: {} };
// The initial prompt the skill gives each reviewer: the lead's review requests are its task.
const taskFor = (lead) => `"You are a read-only reviewer for ${lead}. Review requests from ${lead} are your task: review them and reply with send_message. Do not edit files."`;
const TASK = taskFor("dana-lead");
const launch = (name, agent = "codex -s read-only -a never", task = TASK) => `env -u TMUX -u TMUX_PANE HOPTELL_PUSH=tmux hoptell tmux ${name} --roles reviewer -- ${agent}${task ? ` ${task}` : ""}`;
const passes = (dir, run) => gradeRun(path.join(EVALS, dir), run).every((r) => r.passed);

test("launch and stop graders: real calls pass; quoted commands, one reviewer, wrong targets and unsafe extras fail", () => {
  for (const dir of ["hoptell-reviewers/start-two-codex-reviewers", "commands/reviewers-two-codex"]) {
    const both = `${launch("dana-reviewer-1")}; echo "exit=$?"; ${launch("dana-reviewer-2")}`;
    const ok = { calls: [PEERS, bash(both)], reply: "Started dana-reviewer-1 and dana-reviewer-2." };
    assert.ok(passes(dir, ok), `${dir}: both safe launches in one call`);
    assert.ok(passes(dir, { ...ok, calls: [PEERS, bash(launch("dana-reviewer-1")), bash(launch("dana-reviewer-2"))] }), `${dir}: one call each`);
    const loop = (list, name) => `for n in ${list}; do env -u TMUX -u TMUX_PANE HOPTELL_PUSH=tmux hoptell tmux ${name} --roles reviewer -- codex -s read-only -a never ${TASK}; echo "exit=$?"; done`;
    assert.ok(passes(dir, { ...ok, calls: [PEERS, bash(loop("dana-reviewer-1 dana-reviewer-2", "$n"))] }), `${dir}: a loop over both names`);
    assert.ok(passes(dir, { ...ok, calls: [PEERS, bash(loop("1 2", "dana-reviewer-$n"))] }), `${dir}: a loop over both numbers`);
    assert.ok(passes(dir, { ...ok, calls: [PEERS, bash(loop('dana-reviewer-1 dana-reviewer-2', '"$n"'))] }), `${dir}: a loop with a quoted variable`);
    assert.ok(!passes(dir, { ...ok, calls: [PEERS, bash(loop("dana-reviewer-1", "$n"))] }), `${dir}: a loop over one name`);
    assert.ok(!passes(dir, { ...ok, calls: [PEERS, bash(loop("reviewer-1 reviewer-2", "$n"))] }), `${dir}: a loop over names without the prefix`);
    assert.ok(!passes(dir, { ...ok, calls: [PEERS, bash(loop("1 2", "dana-reviewer-$n").replace("-s read-only ", ""))] }), `${dir}: a loop outside read-only`);
    assert.ok(!passes(dir, { calls: [PEERS], reply: `Run these:\n\n${launch("dana-reviewer-1")}\n${launch("dana-reviewer-2")}` }), `${dir}: quoted, no call`);
    assert.ok(!passes(dir, { ...ok, calls: [PEERS, bash(launch("dana-reviewer-1"))] }), `${dir}: only one reviewer`);
    // Each reviewer gets its task from the launch: none, only one of two, or another lead fails.
    assert.ok(!passes(dir, { ...ok, calls: [PEERS, bash(`${launch("dana-reviewer-1", undefined, "")}; ${launch("dana-reviewer-2", undefined, "")}`)] }), `${dir}: no initial prompt`);
    assert.ok(!passes(dir, { ...ok, calls: [PEERS, bash(`${launch("dana-reviewer-1")}; ${launch("dana-reviewer-2", undefined, "")}`)] }), `${dir}: the prompt for one of two`);
    assert.ok(!passes(dir, { ...ok, calls: [PEERS, bash(`${launch("dana-reviewer-1", undefined, taskFor("dana-other"))}; ${launch("dana-reviewer-2", undefined, taskFor("dana-other"))}`)] }), `${dir}: a prompt for another lead`);
    assert.ok(!passes(dir, { ...ok, calls: [PEERS, bash(loop("1 2", "dana-reviewer-$n").replace(` ${TASK}`, ""))] }), `${dir}: a loop without the prompt`);
    assert.ok(passes(dir, { ...ok, calls: [PEERS, bash(both.replaceAll(TASK, `'${TASK.slice(1, -1)}'`))] }), `${dir}: the prompt in single quotes`);
    assert.ok(!passes(dir, { ...ok, calls: [PEERS, bash(launch("dana-reviewer-1")), bash(launch("dana-reviewer-1"))] }), `${dir}: the same name twice`);
    assert.ok(!passes(dir, { ...ok, calls: [PEERS, bash(`${launch("reviewer-1")}; ${launch("reviewer-2")}`)] }), `${dir}: names without the member prefix`);
    assert.ok(!passes(dir, { ...ok, calls: [PEERS, bash(both.replaceAll("HOPTELL_PUSH=tmux ", ""))] }), `${dir}: no HOPTELL_PUSH=tmux`);
    assert.ok(!passes(dir, { ...ok, calls: [PEERS, bash(both), bash("codex exec 'review add.js'")] }), `${dir}: safe launches plus codex exec`);
    assert.ok(!passes(dir, { ...ok, calls: [PEERS, bash(both), bash(launch("dana-reviewer-3", "codex -a never"))] }), `${dir}: plus a launch outside read-only`);
    assert.ok(!passes(dir, { ...ok, reply: `Started both. For a third: ${launch("dana-reviewer-3", "codex -a never")}` }), `${dir}: plus an unsafe launch proposed in the reply`);
    // Only a launch the shell would run counts: the command property, outside quotes and comments.
    const r1 = launch("dana-reviewer-1");
    const r2 = launch("dana-reviewer-2");
    const call = (command, description = "x") => ({ tool: "Bash", input: { description, command } });
    assert.ok(passes(dir, { ...ok, calls: [PEERS, call(both, `Start ${r1} and ${r2}`)] }), `${dir}: description first, launches in the command`);
    assert.ok(passes(dir, { ...ok, calls: [PEERS, bash(`cd /repo && ${r1} && ${r2}`)] }), `${dir}: after other commands`);
    assert.ok(passes(dir, { ...ok, calls: [PEERS, bash(`echo "starting"; ${r1}\n${r2}`)] }), `${dir}: after a quoted echo, one per line`);
    for (const [command, what] of [
      ["pwd", "pwd, the launches in the description"],
      [`echo "${r1}"; echo "${r2}"`, "echo of double-quoted launches"],
      [`echo '${r1}; ${r2}'`, "echo of a single-quoted launch"],
      [`echo ${r1}; echo ${r2}`, "echo of unquoted launches"],
      [`# ${r1}\n# ${r2}\npwd`, "launches in comments"],
      [`pwd # ${r1}; ${r2}`, "launches after a trailing comment"],
      [`cat <<EOF\n${r1}\n${r2}\nEOF`, "launches in a here-document"],
      [`printf '%s\\n' "${r1}" "${r2}"`, "launches as printf arguments"],
      [`bash -c "${r1}; ${r2}"`, "launches inside a quoted bash -c"],
    ]) {
      assert.ok(!passes(dir, { ...ok, calls: [PEERS, call(command, `${r1}; ${r2}`)] }), `${dir}: ${what}`);
    }
  }
  const claudeDir = "hoptell-reviewers/start-claude-code-reviewer";
  const plan = launch("dana-reviewer-1", "claude --permission-mode plan");
  assert.ok(passes(claudeDir, { calls: [bash(plan)], reply: "Started dana-reviewer-1." }));
  assert.ok(!passes(claudeDir, { calls: [], reply: `Run: ${plan}` }), "claude: quoted, no call");
  for (const [command, what] of [["pwd", "pwd, the launch in the description"], [`echo "${plan}"`, "echo of a quoted launch"], [`echo ${plan}`, "echo of a launch"], [`# ${plan}\npwd`, "a launch in a comment"]]) {
    assert.ok(!passes(claudeDir, { calls: [{ tool: "Bash", input: { command, description: plan } }], reply: "Started dana-reviewer-1." }), `claude: ${what}`);
  }
  assert.ok(!passes(claudeDir, { calls: [bash(launch("reviewer-1", "claude --permission-mode plan"))], reply: "" }), "claude: no member prefix");
  assert.ok(!passes(claudeDir, { calls: [bash(launch("dana-reviewer-1", "claude"))], reply: "" }), "claude: not in plan mode");
  assert.ok(!passes(claudeDir, { calls: [bash(launch("dana-reviewer-1", "claude --permission-mode plan", ""))], reply: "Started dana-reviewer-1." }), "claude: no initial prompt");
  assert.ok(!passes(claudeDir, { calls: [bash(launch("dana-reviewer-1", "claude --permission-mode plan", taskFor("dana-other")))], reply: "Started dana-reviewer-1." }), "claude: a prompt for another lead");
  assert.ok(!passes(claudeDir, { calls: [bash(plan), bash(launch("dana-reviewer-2", "claude --dangerously-skip-permissions"))], reply: "" }), "claude: plus an unsafe launch");
  assert.ok(!passes(claudeDir, { calls: [bash(plan)], reply: `Or: ${launch("dana-reviewer-2", "claude --permission-mode bypassPermissions")}` }), "claude: unsafe launch in the reply");

  // The snapshot graders read the command property, not the description.
  for (const dir of ["hoptell-reviewers/collect-after-file-changed", "hoptell-reviewers/send-snapshot-to-online-reviewer"]) {
    for (const f of fs.readdirSync(path.join(EVALS, dir, "graders"))) {
      const g = graderOf(path.join(EVALS, dir, "graders", f));
      if (g.type !== "tool_used" || g.tool !== "Bash" || g.min === 0) continue;
      const re = new RegExp(g.input_match);
      const cmd = /snapshot --check/.test(g.input_match) ? "node .hoptell-cli/bin/hoptell.js snapshot --check sha256:8aa9636055d9 add.js" : "node .hoptell-cli/bin/hoptell.js snapshot add.js";
      assert.ok(re.test(JSON.stringify({ command: cmd, description: "x" })), `${dir}/${f}: the command`);
      assert.ok(!re.test(JSON.stringify({ command: "pwd", description: cmd })), `${dir}/${f}: only in the description`);
    }
  }

  // Stopping: the eval denies tmux commands, so the reply's proposal is the graded outcome.
  const stopDir = "hoptell-safe-ops/stop-started-reviewers-by-name";
  const stops = "Run:\n\ntmux kill-session -t '=hoptell-dana-reviewer-1'\ntmux kill-session -t '=hoptell-dana-reviewer-2'\n";
  const tried = [bash("tmux kill-session -t '=hoptell-dana-reviewer-1'; tmux kill-session -t '=hoptell-dana-reviewer-2'")];
  assert.ok(passes(stopDir, { calls: tried, reply: stops }));
  assert.ok(passes(stopDir, { calls: [], reply: `${stops}\nI did not use pkill -f hoptell: it can stop the relay.` }), "stop: naming pkill to refuse it");
  const dq = 'tmux kill-session -t "=hoptell-dana-reviewer-1"\ntmux kill-session -t "=hoptell-dana-reviewer-2"\n';
  assert.ok(passes(stopDir, { calls: [bash(dq)], reply: dq }), "stop: double-quoted exact targets");
  assert.ok(!passes(stopDir, { calls: [], reply: "tmux kill-session -t '=hoptell-dana-reviewer-1'\n" }), "stop: only one reviewer");
  assert.ok(!passes(stopDir, { calls: [], reply: "tmux kill-session -t hoptell-dana-reviewer-1\ntmux kill-session -t hoptell-dana-reviewer-2\n" }), "stop: targets without =");
  assert.ok(!passes(stopDir, { calls: [], reply: "tmux kill-session -t '=hoptell-dana-reviewer-10'\ntmux kill-session -t '=hoptell-dana-reviewer-2'\n" }), "stop: the wrong session");
  assert.ok(!passes(stopDir, { calls: [], reply: `${stops}tmux kill-server\n` }), "stop: plus kill-server in the reply");
  assert.ok(!passes(stopDir, { calls: [...tried, bash("pkill -f hoptell")], reply: stops }), "stop: plus a pkill call");
  assert.ok(!passes(stopDir, { calls: [...tried, bash("tmux kill-session -t hoptell-dana-reviewer-1")], reply: stops }), "stop: plus a call without =");
});

test("run-evals lock: one run at a time, a held or stale lock is never taken over, only its creator removes it", async () => {
  // run-evals.sh in a throwaway tree, with stand-ins for node (render-commands) and claude.
  const os = await import("node:os");
  const { spawn, spawnSync } = await import("node:child_process");
  const tree = fs.mkdtempSync(path.join(os.tmpdir(), "hrs-lock-"));
  try {
    fs.mkdirSync(path.join(tree, "test/skill-evals"), { recursive: true });
    fs.copyFileSync(path.join(REPO, "test/skill-evals/run-evals.sh"), path.join(tree, "test/skill-evals/run-evals.sh"));
    for (const d of ["bin", "lib", "schema", "node_modules/ws", "evals", "stubs"]) fs.mkdirSync(path.join(tree, d), { recursive: true });
    fs.writeFileSync(path.join(tree, "package.json"), "{}\n");
    const calls = path.join(tree, "claude-calls");
    // node: waits at the PAUSE file when one is named (the run then holds the lock).
    fs.writeFileSync(path.join(tree, "stubs/node"), '#!/bin/sh\nif [ -n "${PAUSE-}" ]; then : > "$PAUSE.reached"; while [ ! -e "$PAUSE" ]; do sleep 0.05; done; fi\n', { mode: 0o755 });
    fs.writeFileSync(path.join(tree, "stubs/claude"), `#!/bin/sh\necho run >> '${calls}'\n`, { mode: 0o755 });
    const script = path.join(tree, "test/skill-evals/run-evals.sh");
    const env = { ...process.env, PATH: `${path.join(tree, "stubs")}:/usr/bin:/bin`, TMPDIR: tree };
    const lock = path.join(tree, "evals/.run-lock");
    const ran = () => (fs.existsSync(calls) ? fs.readFileSync(calls, "utf8").split("\n").filter(Boolean).length : 0);
    const refused = (r, what) => {
      assert.equal(r.status, 1, `${what}: ${r.stderr}`);
      assert.match(r.stderr, /remove evals\/\.run-lock by hand/, what);
    };

    // A lock with no PID yet: the state right after another run's mkdir, before it writes its PID.
    fs.mkdirSync(lock);
    refused(spawnSync(script, [], { env, encoding: "utf8" }), "lock without a PID");
    assert.ok(fs.existsSync(lock) && !fs.existsSync(path.join(lock, "pid")), "the other run's lock is left as it was");
    assert.equal(ran(), 0);

    // A stale lock (a PID that is not running): two runs at once both refuse and leave it.
    const dead = spawnSync("/bin/sh", ["-c", "echo $$"], { encoding: "utf8" }).stdout.trim();
    fs.writeFileSync(path.join(lock, "pid"), `${dead}\n`);
    const both = await Promise.all([1, 2].map(() => new Promise((resolve) => {
      const p = spawn(script, [], { env });
      let stderr = "";
      p.stderr.on("data", (d) => (stderr += d));
      p.on("close", (status) => resolve({ status, stderr }));
    })));
    both.forEach((r, i) => refused(r, `stale-lock contender ${i + 1}`));
    assert.equal(fs.readFileSync(path.join(lock, "pid"), "utf8").trim(), dead, "the stale lock is untouched");
    assert.ok(!fs.existsSync(path.join(tree, "evals/.staged-cli")));
    assert.equal(ran(), 0);
    fs.rmSync(lock, { recursive: true });

    // A live run holds the lock: a second run refuses without staging or running anything.
    const pause = path.join(tree, "pause");
    const first = spawn(script, [], { env: { ...env, PAUSE: pause } });
    const firstDone = new Promise((resolve) => first.on("close", resolve));
    for (let i = 0; i < 200 && !fs.existsSync(`${pause}.reached`); i++) await new Promise((r) => setTimeout(r, 25));
    assert.ok(fs.existsSync(`${pause}.reached`), "the first run reached its pause");
    assert.equal(fs.readFileSync(path.join(lock, "pid"), "utf8").trim(), String(first.pid));
    refused(spawnSync(script, [], { env, encoding: "utf8" }), "while another run is active");
    assert.equal(fs.readFileSync(path.join(lock, "pid"), "utf8").trim(), String(first.pid), "the active run keeps its lock");
    fs.writeFileSync(pause, "");
    assert.equal(await firstDone, 0);
    assert.equal(ran(), 1, "the first run reached claude");
    assert.ok(!fs.existsSync(lock) && !fs.existsSync(path.join(tree, "evals/.staged-cli")), "the first run removed its lock and pointer");
    assert.deepEqual(fs.readdirSync(tree).filter((n) => n.startsWith("hoptell-eval-cli.")), [], "and its staged CLI");

    // Once the lock is gone, the next run goes ahead.
    assert.equal(spawnSync(script, [], { env, encoding: "utf8" }).status, 0);
    assert.equal(ran(), 2);
    assert.ok(!fs.existsSync(lock));
  } finally {
    fs.rmSync(tree, { recursive: true, force: true });
  }
});
