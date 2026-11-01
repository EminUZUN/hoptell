// read_diff (lib/mcp.js, lib/readdiff.js): the commits and diff between two commits of the
// repository around a local session's folder, through hoptell's controlled git only.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { READ_ONLY_TOOLS, serveEngine } from "../lib/mcp.js";
import { READ_DIFF_MAX, diffReader } from "../lib/readdiff.js";

const tmp = (t, name) => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `hoptell-${name}-`)));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};
// The test's own git, with an empty global configuration of its own (never the user's).
const gitIn = (dir, env = {}) => (...args) => {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: dir, encoding: "utf8", env: { PATH: process.env.PATH, HOME: dir, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", ...env } });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
};
const repo = (t) => {
  const dir = tmp(t, "rd");
  const git = gitIn(dir);
  git("init", "-q", "-b", "main");
  fs.writeFileSync(path.join(dir, "a.js"), "one\n");
  git("add", "a.js");
  git("commit", "-q", "-m", "first");
  fs.appendFileSync(path.join(dir, "a.js"), "two\n");
  git("commit", "-q", "-am", "second: add two");
  return { dir, git };
};

test("diffReader: the commits and the diff, or the changed files; only commit ids and plain names", async (t) => {
  const { dir } = repo(t);
  fs.mkdirSync(path.join(dir, "sub"));
  const r = diffReader(path.join(dir, "sub")); // a folder inside the repository
  t.after(() => r.close());
  const full = await r.read({ base: "HEAD~1", head: "main" });
  assert.match(full, /^Commits HEAD~1\.\.main \([0-9a-f]{12}\.\.[0-9a-f]{12}\) in /);
  assert.match(full, /\n {4}second: add two\n/);
  assert.doesNotMatch(full, /\n {4}first\n/, "only the commits after base");
  assert.match(full, /\n\+two\n/);
  const stat = await r.read({ base: "HEAD^", head: "HEAD", stat: true });
  assert.match(stat, /Changed files [0-9a-f]{12} [0-9a-f]{12}:\n a\.js \| 1 \+\n/);
  assert.doesNotMatch(stat, /\+two/);
  for (const bad of ["--output=/tmp/x", "-p", "HEAD..main", "HEAD@{1}", "a b", "HEAD:a.js", "main/", "../x", "", 7, undefined]) {
    assert.match(await r.read({ base: bad, head: "HEAD" }), /^unable to show: base must be a commit id or a branch or tag name/, String(bad));
  }
  assert.equal(await r.read({ base: "nope", head: "HEAD" }), `unable to show: nope is not a commit in ${dir}`);
  const none = diffReader(tmp(t, "rd-none"));
  t.after(() => none.close());
  assert.match(await none.read({ base: "a", head: "b" }), /^unable to show: this session's folder .* is not in a git repository$/);
});

test("diffReader: a configured diff program, filter or textconv never runs; such a repository configuration is refused", async (t) => {
  const { dir, git } = repo(t);
  const marker = path.join(dir, "RAN");
  const helper = path.join(dir, "helper.sh");
  fs.writeFileSync(helper, `#!/bin/sh\ntouch ${marker}\ncat\n`, { mode: 0o755 });
  // A diff driver for every file, selected in .gitattributes, with its programs in a global
  // configuration: the user's git would run them.
  fs.writeFileSync(path.join(dir, ".gitattributes"), "* diff=x filter=x\n");
  git("add", ".gitattributes");
  git("commit", "-q", "-m", "attributes");
  const global = path.join(dir, "global.gitconfig");
  fs.writeFileSync(global, `[diff "x"]\n\ttextconv = ${helper}\n[filter "x"]\n\tclean = ${helper}\n`);
  gitIn(dir, { GIT_CONFIG_GLOBAL: global })("diff", "HEAD~2", "HEAD");
  assert.ok(fs.existsSync(marker), "the helper runs under the user's git");
  fs.rmSync(marker);
  const r = diffReader(dir);
  t.after(() => r.close());
  assert.match(await r.read({ base: "HEAD~2", head: "HEAD" }), /\n\+two\n/);
  assert.ok(!fs.existsSync(marker), "never under read_diff");
  // In the repository's own configuration: refused, and nothing runs.
  git("config", "diff.external", helper);
  assert.match(await r.read({ base: "HEAD~2", head: "HEAD" }), /^unable to show: .*config sets diff\.external, which hoptell's git does not allow .*read the change with git in your shell/);
  git("config", "--unset", "diff.external");
  fs.writeFileSync(path.join(dir, ".git", "info", "attributes"), "* filter=x\n");
  assert.match(await r.read({ base: "HEAD~2", head: "HEAD" }), /^unable to show: .*info\/attributes selects a filter/);
  assert.ok(!fs.existsSync(marker));
});

test("diffReader: a long answer is cut with a note", async (t) => {
  const { dir, git } = repo(t);
  fs.writeFileSync(path.join(dir, "big.txt"), `${"x".repeat(99)}\n`.repeat(4000));
  git("add", "big.txt");
  git("commit", "-q", "-m", "big");
  const r = diffReader(dir);
  t.after(() => r.close());
  const text = await r.read({ base: "HEAD~1", head: "HEAD" });
  assert.ok(text.length < READ_DIFF_MAX + 200);
  assert.match(text, /\[cut at \d+ characters: ask with stat: true, or for a smaller range\]$/);
});

test("read_diff: listed read-only by a local stdio session with its folder; never by a run or another front", async (t) => {
  const { dir } = repo(t);
  assert.ok(READ_ONLY_TOOLS.includes("read_diff"));
  const engine = {
    attach: () => ({ detach() {} }),
    start: async () => {},
    instructions: () => "",
    tools: async () => ["list_peers", "read_inbox"].map((name) => ({ name, description: name, inputSchema: { type: "object" } })),
    call: async (name) => ({ content: [{ type: "text", text: `ran ${name}` }] }),
    delivery: { mode: "tmux" },
  };
  const serve = async (opts) => {
    const [a, b] = InMemoryTransport.createLinkedPair();
    const close = await serveEngine(engine, a, opts);
    const c = new Client({ name: "t", version: "0" });
    await c.connect(b);
    t.after(async () => {
      await c.close().catch(() => {});
      await close();
    });
    return c;
  };
  const c = await serve({ front: "stdio", checkRoot: dir });
  const tool = (await c.listTools()).tools.find((x) => x.name === "read_diff");
  assert.equal(tool?.annotations?.readOnlyHint, true);
  const r = await c.callTool({ name: "read_diff", arguments: { base: "HEAD~1", head: "HEAD" } });
  assert.match(r.content[0].text, /\n\+two\n/);
  for (const opts of [{ front: "stdio" }, { front: "http", checkRoot: dir }, { front: "hosted", checkRoot: dir }, { front: "stdio", checkRoot: dir, run: { id: "r1" } }]) {
    const names = (await (await serve(opts)).listTools()).tools.map((x) => x.name);
    assert.ok(!names.includes("read_diff"), JSON.stringify(opts));
  }
});

test("diffReader: what could show other content, fetch or stall is refused or off", async (t) => {
  const { dir, git } = repo(t);
  const r = diffReader(dir);
  t.after(() => r.close());
  const [head, parent] = [git("rev-parse", "HEAD").trim(), git("rev-parse", "HEAD~1").trim()];
  // A replacement object is not used: the commit shown is the one asked for.
  git("replace", head, parent);
  assert.match(await r.read({ base: "HEAD~1", head }), /\n {4}second: add two\n/);
  git("replace", "-d", head);
  const gitDir = path.join(dir, ".git");
  for (const [file, text, why] of [
    [path.join(gitDir, "info", "grafts"), `${head}\n`, /info\/grafts exists/],
    [path.join(gitDir, "objects", "info", "alternates"), `${tmp(t, "rd-alt")}\n`, /objects\/info\/alternates exists/],
  ]) {
    fs.writeFileSync(file, text);
    assert.match(await r.read({ base: "HEAD~1", head: "HEAD" }), why);
    fs.rmSync(file);
  }
  // Objects or packs through a symlink: refused.
  const elsewhere = repo(t);
  fs.renameSync(path.join(gitDir, "objects", "pack"), path.join(gitDir, "objects", "pack-real"));
  fs.symlinkSync(path.join(elsewhere.dir, ".git", "objects", "pack"), path.join(gitDir, "objects", "pack"));
  assert.match(await r.read({ base: "HEAD~1", head: "HEAD" }), /objects\/pack is a symlink: git could read objects from outside the repository/);
  fs.rmSync(path.join(gitDir, "objects", "pack"));
  fs.renameSync(path.join(gitDir, "objects", "pack-real"), path.join(gitDir, "objects", "pack"));
  // A promisor remote: refused, and git writes nothing into the repository's configuration.
  git("config", "remote.origin.url", tmp(t, "rd-remote"));
  git("config", "remote.origin.promisor", "true");
  const before = fs.readFileSync(path.join(gitDir, "config"), "utf8");
  assert.match(await r.read({ base: "HEAD", head: "1".repeat(40) }), /config sets remote\.origin\.promisor, which hoptell's git does not allow/);
  assert.equal(fs.readFileSync(path.join(gitDir, "config"), "utf8"), before);
  git("config", "--unset", "remote.origin.promisor");
  // A FIFO as info/attributes is refused at once, not read.
  spawnSync("mkfifo", [path.join(gitDir, "info", "attributes")]);
  assert.match(await r.read({ base: "HEAD~1", head: "HEAD" }), /^unable to show: .*info\/attributes could not be read/);
  fs.rmSync(path.join(gitDir, "info", "attributes"));
  // A .git folder whose commondir file leads elsewhere: that repository's configuration is checked.
  const other = repo(t);
  other.git("config", "diff.external", "/bin/false");
  fs.writeFileSync(path.join(gitDir, "commondir"), path.join(other.dir, ".git"));
  assert.match(await r.read({ base: "HEAD~1", head: "HEAD" }), new RegExp(`^unable to show: ${path.join(other.dir, ".git", "config")} sets diff\\.external`));
  // Git keeps spaces in a commondir path; one that cannot be followed is never skipped.
  fs.renameSync(path.join(other.dir, ".git"), path.join(other.dir, ".git "));
  fs.writeFileSync(path.join(gitDir, "commondir"), `${path.join(other.dir, ".git ")}\n`);
  assert.match(await r.read({ base: "HEAD~1", head: "HEAD" }), /\.git \/config sets diff\.external/);
  // A symlink before "..": followed first, as git does.
  fs.mkdirSync(path.join(other.dir, ".git ", "child"));
  fs.symlinkSync(path.join(other.dir, ".git ", "child"), path.join(gitDir, "jump"));
  fs.writeFileSync(path.join(gitDir, "commondir"), "jump/..\n");
  assert.match(await r.read({ base: "HEAD~1", head: "HEAD" }), /\.git \/config sets diff\.external/);
  fs.writeFileSync(path.join(gitDir, "commondir"), `${path.join(other.dir, ".git ")}${"\n".repeat(5000)}`);
  assert.match(await r.read({ base: "HEAD~1", head: "HEAD" }), /^unable to show: this session's folder .* is not in a git repository$/);
});

test("diffReader: with a file over 8 MiB, only the list of changed files is shown", async (t) => {
  const { dir, git } = repo(t);
  fs.writeFileSync(path.join(dir, "big.txt"), `${"y".repeat(99)}\n`.repeat(90_000));
  git("add", "big.txt");
  git("commit", "-q", "-m", "big");
  const r = diffReader(dir);
  t.after(() => r.close());
  const text = await r.read({ base: "HEAD~1", head: "HEAD" });
  assert.match(text, /\(a file over 8 MiB changed, so only the list is shown; read the diff with git in your shell, which asks your user first\):\nA\tbig\.txt\n$/);
  assert.doesNotMatch(await r.read({ base: "HEAD~2", head: "HEAD~1" }), /over 8 MiB/);
});
