// check_snapshot (lib/mcp.js, lib/checksnapshot.js): the snapshot --check step as a read-only
// tool of a local stdio session, for plain files inside its working folder only.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { serveEngine } from "../lib/mcp.js";
import { folderChecker } from "../lib/checksnapshot.js";
import { sha256Of } from "../lib/snapshot.js";

const tmp = (t, name) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `hoptell-${name}-`));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};

test("folderChecker: the same answers as snapshot --check, only for plain files inside the folder it opened", async (t) => {
  const root = tmp(t, "chk");
  const outside = tmp(t, "chk-out");
  fs.writeFileSync(path.join(root, "a.js"), "one\n");
  fs.mkdirSync(path.join(root, "sub"));
  fs.writeFileSync(path.join(root, "sub", "b.js"), "one\n");
  fs.writeFileSync(path.join(outside, "secret"), "two\n");
  const one = sha256Of(Buffer.from("one\n"));
  const two = sha256Of(Buffer.from("two\n"));
  const c = folderChecker(root);
  t.after(() => c.close());
  assert.equal(await c.check(one, "a.js"), `unchanged: a.js still matches ${one}`);
  assert.equal(await c.check(one, "./sub/b.js"), `unchanged: ./sub/b.js still matches ${one}`);
  assert.equal(await c.check(one, path.join(root, "a.js")), `unchanged: ${path.join(root, "a.js")} still matches ${one}`);
  assert.equal(await c.check(one, path.join(c.folder, "a.js")), `unchanged: ${path.join(c.folder, "a.js")} still matches ${one}`);
  assert.match(await c.check(two, "a.js"), /^changed: a\.js is now sha256:[0-9a-f]{64}, not sha256:/);
  // Elsewhere: by path or by .., the folder itself.
  for (const f of [path.join(outside, "secret"), `../${path.basename(outside)}/secret`, "sub/../a.js", ".", root]) {
    assert.match(await c.check(two, f), /^unable to check: .* is not inside this session's folder /, f);
  }
  // A link to a file elsewhere, a link to a folder elsewhere and a hard link: refused.
  fs.symlinkSync(path.join(outside, "secret"), path.join(root, "link"));
  fs.symlinkSync(outside, path.join(root, "dirlink"));
  fs.linkSync(path.join(outside, "secret"), path.join(root, "hard"));
  for (const f of ["link", "dirlink/secret", "hard"]) assert.match(await c.check(two, f), /: it is not a plain file inside this session's folder/, f);
  assert.match(await c.check(one, "missing.js"), /: it does not exist$/);
  assert.match(await c.check("sha256:12", "a.js"), /^unable to check: invalid digest/);
  assert.equal(await c.check(one, ""), "unable to check: give sha256 and file");
  assert.equal(await c.check(undefined, "a.js"), "unable to check: give sha256 and file");
  // The folder is the one opened at the start: a new folder at the same path does not count.
  fs.renameSync(root, `${root}-old`);
  t.after(() => fs.rmSync(`${root}-old`, { recursive: true, force: true }));
  fs.mkdirSync(root);
  fs.symlinkSync(path.join(outside, "secret"), path.join(root, "a.js"));
  assert.match(await c.check(two, "a.js"), /^unable to check: a\.js: /);
  assert.equal(folderChecker("/"), null, "never a filesystem root");
});

test("check_snapshot: listed read-only by a local stdio session with its folder; never by a run or another front", async (t) => {
  const root = tmp(t, "chk-mcp");
  fs.writeFileSync(path.join(root, "a.js"), "one\n");
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
  const c = await serve({ front: "stdio", checkRoot: root });
  const tool = (await c.listTools()).tools.find((x) => x.name === "check_snapshot");
  assert.equal(tool?.annotations?.readOnlyHint, true);
  const r = await c.callTool({ name: "check_snapshot", arguments: { sha256: sha256Of(Buffer.from("one\n")), file: "a.js" } });
  assert.match(r.content[0].text, /^unchanged: a\.js still matches sha256:/);
  for (const opts of [{ front: "stdio" }, { front: "http", checkRoot: root }, { front: "hosted", checkRoot: root }, { front: "stdio", checkRoot: root, run: { id: "r1" } }]) {
    const names = (await (await serve(opts)).listTools()).tools.map((x) => x.name);
    assert.ok(!names.includes("check_snapshot"), JSON.stringify(opts));
  }
});
