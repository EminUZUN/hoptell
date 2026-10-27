// The hosted link table under write failures (design 4.5, "Write errors"): a failure after
// writeDurable's replace is an unknown outcome, never "refused"; after an ordinary reopen the new
// table is there and a retry changes nothing; after a simulated loss of unsynced metadata (the old
// file back under the name) recovery reads the table actually there and the change is applied once.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { link, readLinks } from "../lib/hostedlinks.js";
import { HANNA, HUGO } from "./hosted-helpers.js";

const ISS = "https://idp.example";
const dirOf = (t) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "hoptell-links-"));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};
const dirFsyncFails = (point) => {
  if (point === "dir-fsync") throw Object.assign(new Error("EIO: injected"), { code: "EIO" });
};

test("before the replace: the old table stands and the error says so", async (t) => {
  const d = dirOf(t);
  await link(d, { issuer: ISS, subject: "a", member: HANNA });
  const before = fs.readFileSync(path.join(d, "links.json"), "utf8");
  await assert.rejects(link(d, { issuer: ISS, subject: "b", member: HUGO }, { fault: (p) => p === "rename" && dirFsyncFails("dir-fsync") }), (e) => e.phase === "before-replace");
  assert.equal(fs.readFileSync(path.join(d, "links.json"), "utf8"), before);
});

test("after the replace, then an ordinary reopen: the new table is there and a retry does not apply the change twice", async (t) => {
  const d = dirOf(t);
  await link(d, { issuer: ISS, subject: "a", member: HANNA });
  await assert.rejects(link(d, { issuer: ISS, subject: "b", member: HUGO }, { fault: dirFsyncFails }), (e) => e.phase === "after-replace");
  const reopened = readLinks(d);
  const g = reopened.links.find((l) => l.member.id === HUGO.id)?.generation;
  assert.ok(g, "the new entry is visible after a reopen");
  const again = await link(d, { issuer: ISS, subject: "b", member: HUGO });
  assert.equal(again.already, true);
  assert.equal(readLinks(d).counter, reopened.counter, "no second generation");
});

test("an unknown outcome names a check command that runs: with the same --state-dir, shell-quoted", async (t) => {
  const d = path.join(dirOf(t), "it's here");
  fs.mkdirSync(d);
  const e = await link(d, { issuer: ISS, subject: "b", member: HUGO }, { fault: dirFsyncFails }).catch((x) => x);
  assert.equal(e.phase, "after-replace");
  const { unknownOutcome } = await import("../lib/hostedcli.js");
  const shown = unknownOutcome(e, d);
  assert.equal(shown.exitCode, 1);
  assert.ok(shown.message.endsWith(`; check with hoptell mcp-hosted --experimental list --state-dir '${d.replace(/'/g, "'\\''")}'`), shown.message);
  const before = Object.assign(new Error("x"), { phase: "before-replace" });
  assert.equal(unknownOutcome(before, d), before, "a refused write stays refused");
});

test("after the replace, then a loss of unsynced metadata (the old file back): recovery reads the actual table and applies the change once", async (t) => {
  const d = dirOf(t);
  await link(d, { issuer: ISS, subject: "a", member: HANNA });
  const old = fs.readFileSync(path.join(d, "links.json"), "utf8");
  await assert.rejects(link(d, { issuer: ISS, subject: "b", member: HUGO }, { fault: dirFsyncFails }), (e) => e.phase === "after-replace");
  fs.writeFileSync(path.join(d, "links.json"), old, { mode: 0o600 }); // the rename did not survive
  assert.equal(readLinks(d).links.some((l) => l.member.id === HUGO.id), false, "the actual table is the old one");
  const r = await link(d, { issuer: ISS, subject: "b", member: HUGO });
  assert.equal(r.already, false);
  const now = readLinks(d);
  assert.equal(now.links.filter((l) => l.member.id === HUGO.id).length, 1, "applied once");
  assert.equal(await link(d, { issuer: ISS, subject: "b", member: HUGO }).then((x) => x.already), true);
});
