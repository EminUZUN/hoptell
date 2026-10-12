// Fixtures for the review-set and apply tests: a private home, approved folders, review sets
// captured through the real send_review_set tool (with a stand-in relay), and proposals received
// through the real intake. No relay, no network.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, spawnSync } from "node:child_process";
import { createFileTools } from "../lib/filetools.js";
import { createReader } from "../lib/files.js";
import { ReviewSetStore } from "../lib/reviewsets.js";
import { BIN } from "../lib/config.js";

export const REALM = "0123456789abcdef0123456789abcdef";
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A fresh folder under the system tmpdir (real path), removed after the test. */
export function tmpDir(t, label) {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `hoptell-${label}-`)));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

/** Write files {rel: content} under dir. */
export function writeFiles(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
}

/** git in a test repository (never the developer's configuration). */
export function git(cwd, ...args) {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", ...args], {
    cwd,
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: cwd, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
  });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

/**
 * A machine: home (state) and approved folders {id: dir}. Returns {home, roots: [{id, path}],
 * setting, tools (the file tools with a stand-in relay), sent (texts sent), env (for the CLI)}.
 */
export function machine(t, folders = { app: {} }, { realm = REALM, recipient = undefined, transfers = null } = {}) {
  const base = tmpDir(t, "rw");
  const home = path.join(base, "state");
  fs.mkdirSync(home, { mode: 0o700 });
  // A folder is {files} under its id, or {dir, files} at another relative place (e.g. inside .git).
  const roots = Object.entries(folders).map(([id, spec]) => {
    const files = spec?.dir ? spec.files : spec;
    const dir = path.join(base, spec?.dir ?? id);
    fs.mkdirSync(dir, { recursive: true });
    writeFiles(dir, files);
    return { id, path: dir };
  });
  const setting = JSON.stringify(roots);
  const tools = createFileTools({ setting, home, peerName: "sam", realm: () => realm, log: () => {}, reader: createReader(), transfers });
  t.after(() => tools?.dispose());
  const sent = [];
  const relay = {
    send: async (to, text) => {
      sent.push({ to, text });
      // `recipient`: what the stand-in relay says about the target (undefined: an older relay).
      return { type: "ack", state: "delivered", message_id: crypto.randomUUID(), ...(recipient ? { recipient: { realm, ...recipient } } : {}) };
    },
  };
  fs.writeFileSync(path.join(base, "empty.env"), "");
  const env = { PATH: process.env.PATH, HOPTELL_HOME: home, HOPTELL_SNAPSHOT_ROOTS: setting, HOPTELL_ENV: path.join(base, "empty.env"), XDG_CONFIG_HOME: path.join(base, "config") };
  const call = async (name, args, opts = {}) => {
    const r = await tools.handle(name, args, relay, opts);
    return { ...r.structuredContent, isError: r.isError };
  };
  return { base, home, roots, dir: Object.fromEntries(roots.map((r) => [r.id, r.path])), setting, tools, call, sent, env, store: new ReviewSetStore({ home }) };
}

/** The sender as the relay describes it: the reviewer "alex" in the same realm. */
export const fromAlex = (text, over = {}) => ({ from: "alex", fromHost: "h", text, ts: Date.now(), sender: { auth: "shared", realm: REALM, member: null }, ...over });

/** A proposal envelope for a sent set. */
export function proposal(sent, changes, over = {}) {
  return { hoptell_proposal: 1, proposal_id: crypto.randomUUID(), review_set_id: sent.review_set_id, based_on: sent.bundle_digest, changes, ...over };
}

/** Receive a proposal through the real intake; returns "stored"/"repeat" or the refusal code. */
export async function receive(m, p, msg = fromAlex(JSON.stringify(p))) {
  const { parseProposal } = await import("../lib/reviewsets.js");
  try {
    return await m.store.receive(parseProposal(msg.text), msg);
  } catch (e) {
    return e.code;
  }
}

/** A unified diff for one file from old to new text (the whole file as one hunk). */
export function wholeDiff(rel, before, after) {
  const a = before.split("\n");
  const b = after.split("\n");
  if (a.at(-1) === "") a.pop();
  if (b.at(-1) === "") b.pop();
  return [`--- a/${rel}`, `+++ b/${rel}`, `@@ -1,${a.length} +1,${b.length} @@`, ...a.map((l) => `-${l}`), ...b.map((l) => `+${l}`), ""].join("\n");
}

/** A one-line change at line `n` (1-based) of `before`, with up to 3 lines of context. */
export function lineDiff(rel, before, n, replacement) {
  const a = before.split("\n");
  if (a.at(-1) === "") a.pop();
  const from = Math.max(0, n - 1 - 3);
  const to = Math.min(a.length, n + 3);
  const ctx = a.slice(from, to);
  const body = ctx.map((l, i) => (from + i === n - 1 ? [`-${l}`, `+${replacement}`] : [` ${l}`])).flat();
  return [`--- a/${rel}`, `+++ b/${rel}`, `@@ -${from + 1},${ctx.length} +${from + 1},${ctx.length} @@`, ...body, ""].join("\n");
}

/** Run the CLI; resolves {code, stdout, stderr}. */
export function cli(env, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, [BIN, ...args], { env, timeout: 60_000, ...opts }, (err, stdout, stderr) => resolve({ code: err ? (err.code ?? 1) : 0, stdout, stderr }));
  });
}
