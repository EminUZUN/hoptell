// Resuming a member's conversation (design 10, Part R): the Claude Code event-set rule and its
// session-file cross-check, the Codex rollout checks across restarts, and the thread record of a
// member's MCP server.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { claudeConversation, claudeProjectDir, claudeUnexplained, codexConversation, isConversation, readThread, recordThread, resumeDefault, threadFileOf } from "../lib/resume.js";
import { serveEngine } from "../lib/mcp.js";
import { restartPrompt } from "../lib/roles.js";

const id = () => crypto.randomUUID();
function tmp(t) {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hoptell-resume-")));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

test("Claude Code: the conversation from the set of the process's SessionStart events", () => {
  const L = id();
  const X = id();
  const C = id();
  const D = id();
  const B = id();
  const ev = (session_id, source) => ({ session_id, source });
  assert.deepEqual(claudeConversation([ev(L, "startup")], L, "startup"), { id: L });
  assert.deepEqual(claudeConversation([ev(L, "startup"), ev(L, "startup")], L, "startup"), { id: L }, "a line twice is one event");
  assert.deepEqual(claudeConversation([ev(L, "startup"), ev(X, "clear")], L, "startup"), { id: X });
  assert.deepEqual(claudeConversation([ev(X, "clear"), ev(L, "startup")], L, "startup"), { id: X }, "order does not matter");
  assert.deepEqual(claudeConversation([ev(L, "startup"), ev(L, "compact")], L, "startup"), { id: L });
  assert.deepEqual(claudeConversation([ev(L, "resume")], L, "resume"), { id: L }, "a resumed launch");
  // Two clears: their order cannot be told from a set, in either completion order.
  for (const events of [[ev(L, "startup"), ev(C, "clear"), ev(D, "clear")], [ev(L, "startup"), ev(D, "clear"), ev(C, "clear")]]) assert.match(claudeConversation(events, L, "startup").why, /changed more than once/);
  // An interactive switch, also when a clear was written after it; a branch; a second startup.
  assert.match(claudeConversation([ev(L, "startup"), ev(B, "resume")], L, "startup").why, /changed in the session \(resume\)/);
  assert.match(claudeConversation([ev(L, "startup"), ev(B, "resume"), ev(C, "clear")], L, "startup").why, /changed in the session \(resume\)/);
  assert.match(claudeConversation([ev(L, "startup"), ev(B, "fork")], L, "startup").why, /\(fork\)/);
  assert.match(claudeConversation([ev(L, "startup"), ev(B, "startup")], L, "startup").why, /\(startup\)/, "a delayed second startup");
  assert.match(claudeConversation([ev(L, "startup"), ev(X, "odd")], L, "startup").why, /\(odd\)/);
  // The launch's own event missing, or of the other kind.
  assert.match(claudeConversation([ev(X, "clear")], L, "startup").why, /does not show this launch/);
  assert.match(claudeConversation([ev(L, "startup")], L, "resume").why, /does not show this launch/);
  assert.match(claudeConversation([], L, "startup").why, /no session hook data/);
  assert.match(claudeConversation(null, L, "startup").why, /no session hook data/);
  assert.match(claudeConversation([{ session_id: "not-a-uuid", source: "startup" }], L, "startup").why, /cannot read/);
});

test("Claude Code: the session-file cross-check counts only ids outside the event set", (t) => {
  const home = tmp(t);
  const cwd = path.join(home, "wt", "dana-n1-impl-1");
  fs.mkdirSync(cwd, { recursive: true });
  const dir = claudeProjectDir(home, cwd);
  assert.equal(path.basename(dir), cwd.replace(/[^A-Za-z0-9]/g, "-"));
  const L = id();
  const X = id();
  const B = id();
  const from = Date.now() - 60_000;
  const to = Date.now() + 1000;
  assert.match(claudeUnexplained(dir, new Set([L]), from, to, L), /folder of the member is missing/);
  fs.mkdirSync(dir, { recursive: true });
  const touch = (n, at) => {
    fs.writeFileSync(path.join(dir, n), "{}\n");
    fs.utimesSync(path.join(dir, n), at / 1000, at / 1000);
  };
  // A /clear continuation: L and X both changed during the launch; resumes X.
  touch(`${L}.jsonl`, Date.now());
  touch(`${X}.jsonl`, Date.now());
  fs.mkdirSync(path.join(dir, X)); // a session's own folder
  assert.equal(claudeUnexplained(dir, new Set([L, X]), from, to, X), null);
  // An older transcript of another id, changed before the launch: no matter.
  touch(`${B}.jsonl`, from - 3_600_000);
  assert.equal(claudeUnexplained(dir, new Set([L, X]), from, to, X), null);
  // The same id B changed during the launch: an event nobody wrote.
  touch(`${B}.jsonl`, Date.now());
  assert.match(claudeUnexplained(dir, new Set([L, X]), from, to, X), new RegExp(`another conversation \\(${B.slice(0, 8)}\\) changed during the launch`));
  fs.rmSync(path.join(dir, `${B}.jsonl`));
  // Only <uuid>.jsonl files and <uuid> folders belong there; the chosen id's file must exist.
  fs.writeFileSync(path.join(dir, "notes.txt"), "x");
  assert.match(claudeUnexplained(dir, new Set([L, X]), from, to, X), /unexpected entry notes\.txt/);
  fs.rmSync(path.join(dir, "notes.txt"));
  assert.match(claudeUnexplained(dir, new Set([L, X]), from, to, id()), /session file is missing/);
});

/** A rollout file of Codex as 0.165.0 writes it: the first line is the session_meta. */
function rollout(codexHome, { thread, cwd, at }) {
  const d = new Date(at);
  const dir = path.join(codexHome, "sessions", String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0"));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-${d.toISOString().slice(0, 19).replace(/:/g, "-")}-${thread}.jsonl`);
  fs.writeFileSync(file, `${JSON.stringify({ timestamp: d.toISOString(), type: "session_meta", payload: { id: thread, timestamp: d.toISOString(), cwd, cli_version: "0.165.0" } })}\n{"type":"event_msg"}\n`);
  return file;
}

test("Codex: first discovery binds a thread of this launch in this folder; later restarts need the same session_meta", (t) => {
  const root = tmp(t);
  const codexHome = path.join(root, "codex");
  const cwd = path.join(root, "wt");
  fs.mkdirSync(cwd);
  const T = id();
  const launch1 = Date.now() - 600_000;
  // The thread from the MCP server's record, or a scan of the folder's rollouts (implementers).
  assert.match(codexConversation({ codexHome, rec: null, launchMs: launch1, cwd, thread: null, scan: false }).why, /no conversation was recorded/);
  assert.match(codexConversation({ codexHome, rec: null, launchMs: launch1, cwd, thread: T, scan: false }).why, /no conversation of this launch/);
  const file = rollout(codexHome, { thread: T, cwd, at: launch1 + 2000 });
  const first = codexConversation({ codexHome, rec: null, launchMs: launch1, cwd, thread: T, scan: false });
  assert.equal(first.rec.id, T);
  assert.equal(first.rec.source, "mcp");
  assert.equal(first.rec.created, new Date(launch1 + 2000).toISOString());
  assert.ok(isConversation(first.rec));
  // The evidence keys a resume compares: optional (an older record has none), checked when present.
  assert.ok(!Object.hasOwn(first.rec, "cliVersion"), "no launch evidence given");
  assert.ok(isConversation({ ...first.rec, cliVersion: "0.165.0", templateDigest: "a".repeat(64) }));
  assert.ok(isConversation({ ...first.rec, cliVersion: null, templateDigest: null }));
  assert.ok(!isConversation({ ...first.rec, templateDigest: "x" }));
  assert.ok(!isConversation({ ...first.rec, extra: 1 }));
  assert.deepEqual(codexConversation({ codexHome, rec: null, launchMs: launch1, cwd, thread: T, scan: false, evidence: { cliVersion: "0.165.0", templateDigest: null } }).rec.cliVersion, "0.165.0");
  assert.equal(codexConversation({ codexHome, rec: null, launchMs: launch1, cwd, thread: null, scan: true }).rec.source, "rollout");
  // Rejected at first discovery: another folder, a thread older than the launch, a malformed line.
  assert.match(codexConversation({ codexHome, rec: null, launchMs: launch1, cwd: root, thread: T, scan: false }).why, /no conversation of this launch/);
  assert.match(codexConversation({ codexHome, rec: null, launchMs: launch1 + 5000, cwd, thread: T, scan: false }).why, /no conversation of this launch/);
  // Two threads started in the folder: the scan does not pick one.
  const U = id();
  const other = rollout(codexHome, { thread: U, cwd, at: launch1 + 3000 });
  assert.match(codexConversation({ codexHome, rec: null, launchMs: launch1, cwd, thread: null, scan: true }).why, /several conversations/);
  fs.rmSync(other);
  // Launch, stop, resume, stop, resume: the resumed launches start after the thread's session_meta.
  let rec = first.rec;
  for (const later of [launch1 + 120_000, launch1 + 300_000]) {
    const again = codexConversation({ codexHome, rec, launchMs: later, cwd, thread: null, scan: true });
    assert.equal(again.rec?.id, T, again.why);
    rec = { ...again.rec, lastLaunch: new Date(later).toISOString(), launchedAs: "resume" };
    // The same thread reported again by the resumed launch's MCP server.
    assert.equal(codexConversation({ codexHome, rec, launchMs: later, cwd, thread: T, scan: true }).rec.id, T);
  }
  // The record written to disk and read back by another process (a new supervisor) gives the same.
  const saved = JSON.parse(JSON.stringify(rec));
  assert.equal(codexConversation({ codexHome, rec: saved, launchMs: launch1 + 400_000, cwd, thread: null, scan: true }).rec.id, T);
  // A rollout whose session_meta is not the recorded one, another folder, or gone: not resumable.
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replaceAll(new Date(launch1 + 2000).toISOString(), new Date(launch1 + 9000).toISOString()));
  assert.match(codexConversation({ codexHome, rec, launchMs: launch1 + 400_000, cwd, thread: null, scan: true }).why, /not the one recorded/);
  assert.match(codexConversation({ codexHome, rec, launchMs: launch1 + 400_000, cwd: root, thread: null, scan: true }).why, /belongs to/);
  fs.writeFileSync(file, "not json\n");
  assert.match(codexConversation({ codexHome, rec, launchMs: launch1 + 400_000, cwd, thread: null, scan: true }).why, /could not be read/);
  fs.rmSync(file);
  assert.match(codexConversation({ codexHome, rec, launchMs: launch1 + 400_000, cwd, thread: null, scan: true }).why, /was not found/);
});

test("a member's MCP server records the Codex thread of its read_task call; nothing else does", async (t) => {
  const home = tmp(t);
  fs.mkdirSync(path.join(home, "sessions"), { mode: 0o700 });
  const name = "dana-n1-impl-1";
  fs.writeFileSync(path.join(home, "sessions", `${name}.task`), "Implement it.\n", { mode: 0o600 });
  const digest = crypto.createHash("sha256").update("Implement it.\n").digest("hex");
  const engine = { attach: () => ({ detach() {} }), start: async () => {}, instructions: () => "", tools: async () => [], call: async () => ({ content: [] }), delivery: { mode: "tmux" } };
  const serve = async (member) => {
    const [a, b] = InMemoryTransport.createLinkedPair();
    const close = await serveEngine(engine, a, { front: "stdio", task: { home, name, digest }, member });
    const c = new Client({ name: "codex-mcp-client", version: "0" });
    await c.connect(b);
    t.after(async () => {
      await c.close().catch(() => {});
      await close();
    });
    return c;
  };
  const T = id();
  const before = Date.now() - 1;
  // Not a team member: nothing is recorded.
  let c = await serve(null);
  assert.equal((await c.callTool({ name: "read_task", arguments: {}, _meta: { threadId: T } })).content[0].text, "Implement it.\n");
  assert.equal(fs.existsSync(threadFileOf(home, name)), false);
  c = await serve({ role: "implementer", team: "n1" });
  await c.callTool({ name: "read_task", arguments: {}, _meta: { threadId: "not-a-uuid" } });
  assert.equal(fs.existsSync(threadFileOf(home, name)), false);
  const r = await c.callTool({ name: "read_task", arguments: {}, _meta: { threadId: T, sessionId: T } });
  assert.equal(r.content[0].text, "Implement it.\n", "the call itself is unchanged");
  assert.equal(fs.statSync(threadFileOf(home, name)).mode & 0o777, 0o600);
  assert.equal(readThread(home, name, before), T);
  assert.equal(readThread(home, name, Date.now() + 60_000), null, "only a record written during the launch counts");
  assert.equal(recordThread(home, name, { threadId: 42 }), false);
});

test("restart prompts and resume defaults", () => {
  assert.equal(resumeDefault("implementer"), "auto");
  assert.equal(resumeDefault("reviewer"), "never");
  assert.equal(resumeDefault("tester"), "never");
  const where = { branch: "team/n1/dana-n1-impl-1", head: "a".repeat(40) };
  assert.equal(restartPrompt("implementer", "dana-lead", where), `You are the implementer for dana-lead, restarted in your worktree; your branch is team/n1/dana-n1-impl-1 at ${"a".repeat(40)}; read your task with the hoptell read_task tool and continue; requests from dana-lead are your task.`);
  assert.match(restartPrompt("implementer", "dana-lead", where, { fresh: true }), /restarted in your worktree with a fresh conversation \(you remember nothing of before\); your branch is/);
  assert.match(restartPrompt("implementer", "dana-lead", where, { resumed: true }), /restarted with your conversation in your worktree; your branch is .*; continue;/);
  assert.match(restartPrompt("reviewer", "dana-lead", null, { resumed: true }), /^You are the reviewer for dana-lead, restarted with your conversation; continue;/);
  assert.throws(() => restartPrompt("reviewer", "not a name", null), /lead name/);
});
