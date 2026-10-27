// The owner's transfer commands (design 6), through the real CLI: hoptell transfers (staged
// transfers by local id with relay_expires, labels quoted), hoptell transfers cancel, hoptell save
// (no clobber; --overwrite needs a confirmation or --yes), hoptell save --forget, and hoptell
// doctor (recovers an interrupted save; reports leftovers, removes them with --fix).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { BIN } from "../lib/config.js";
import { incomingDir } from "../lib/transferin.js";
import { readJournal, saveTransfer } from "../lib/transfersave.js";
import { allowTransfers, device, pattern, sendFile, sha, transferRelay, until } from "./transfer-helpers.js";
import { tmpDir } from "./mls-helpers.js";

/** Run the CLI with `home` as its HOPTELL_HOME (no settings file, no relay). */
function cli(home, args) {
  if (!fs.existsSync(path.join(home, "none.env"))) fs.writeFileSync(path.join(home, "none.env"), "");
  const env = { PATH: process.env.PATH, HOPTELL_HOME: home, HOPTELL_ENV: path.join(home, "none.env"), XDG_CONFIG_HOME: path.join(home, "xdg"), HOME: home };
  return new Promise((resolve) => execFile(process.execPath, [BIN, ...args], { env, timeout: 30_000 }, (e, stdout, stderr) => resolve({ code: e ? e.code : 0, stdout, stderr })));
}

async function stagedHome(t, n = 1) {
  const w = await transferRelay(t);
  const alice = await device(t, w, "alice");
  const bob = await device(t, w, "bob");
  allowTransfers(bob.contacts, w.realm, alice.id);
  const list = [];
  for (let i = 0; i < n; i++) {
    const bytes = pattern(3000 + i, i);
    await sendFile(alice, "alice", bob, bytes, { name: `report\u0007-${i}.pdf` });
    await until(() => bob.staged.length === i + 1, "staged");
    list.push({ t: bob.staged[i].e.t, bytes });
  }
  return { w, bob, list, out: tmpDir(t, "hoptell-cli-out-") };
}

test("hoptell transfers lists staged transfers by local id with relay_expires; labels are quoted without control characters", async (t) => {
  const s = await stagedHome(t, 2);
  const r = await cli(s.bob.dir, ["transfers"]);
  assert.equal(r.code, 0);
  for (const { t: id } of s.list) assert.match(r.stdout, new RegExp(`${id}  staged  file from "alice"`));
  assert.match(r.stdout, /label "report-0\.pdf"/);
  assert.equal(r.stdout.includes("\u0007"), false);
  assert.match(r.stdout, /^ {4}relay copy expires 20\d\d-/m);
  assert.match(r.stdout, /^ {4}staged here 20\d\d-\S+; cleaned up after 7 days unless saved$/m);
  assert.match(r.stdout, /Next: hoptell save <t_id> <path>/);
  const c = await cli(s.bob.dir, ["transfers", "cancel", s.list[1].t]);
  assert.equal(c.code, 0);
  assert.match(c.stdout, /cancelled and deleted on this device/);
  assert.equal(fs.existsSync(path.join(incomingDir(s.bob.dir), s.list[1].t)), false);
  const again = await cli(s.bob.dir, ["transfers"]);
  assert.equal(again.stdout.includes(`${s.list[1].t}  staged`), false);
  const gone = await cli(s.bob.dir, ["transfers", "cancel", "t_000000000000000000000000"]);
  assert.equal(gone.code, 1);
  assert.match(gone.stderr, /^hoptell: /, "an error goes to stderr");
  assert.equal(gone.stdout, "");
  // Usage errors: stderr, one line naming the cause, exit 2.
  const bogus = await cli(s.bob.dir, ["transfers", "bogus"]);
  assert.deepEqual([bogus.code, bogus.stdout, bogus.stderr], [2, "", 'hoptell: unknown transfers command "bogus" (see hoptell transfers --help)\n']);
  const short = await cli(s.bob.dir, ["transfers", "cancel"]);
  assert.equal(short.code, 2);
  assert.equal(short.stdout, "");
  assert.match(short.stderr, /^hoptell: transfers cancel needs one <t_id>\nusage: hoptell transfers cancel <t_id>\n$/);
});

test("hoptell save: no clobber without --overwrite; --overwrite without a terminal needs --yes; then saved and the staging copy deleted", async (t) => {
  const s = await stagedHome(t);
  const [{ t: id, bytes }] = s.list;
  const dest = path.join(s.out, "out.bin");
  fs.writeFileSync(dest, "keep me");
  const r1 = await cli(s.bob.dir, ["save", id, dest]);
  assert.equal(r1.code, 1);
  assert.match(r1.stderr, /^hoptell: .* exists; nothing was replaced \(use --overwrite/);
  assert.equal(fs.readFileSync(dest, "utf8"), "keep me");
  const r2 = await cli(s.bob.dir, ["save", id, dest, "--overwrite"]);
  assert.equal(r2.code, 1);
  assert.match(r2.stderr, /add --yes; nothing was saved/);
  assert.equal(fs.readFileSync(dest, "utf8"), "keep me");
  const r3 = await cli(s.bob.dir, ["save", id, dest, "--overwrite", "--yes"]);
  assert.equal(r3.code, 0, r3.stdout + r3.stderr);
  assert.match(r3.stdout, new RegExp(`Saving ${id} to ${fs.realpathSync(s.out)}/out\\.bin`));
  assert.match(r3.stdout, /Saved 3000 bytes/);
  assert.equal(sha(fs.readFileSync(dest)), sha(bytes));
  assert.equal(fs.existsSync(path.join(incomingDir(s.bob.dir), id)), false);
  assert.equal((await cli(s.bob.dir, ["save", id, path.join(s.out, "again.bin")])).code, 1, "no longer staged");
  const noArgs = await cli(s.bob.dir, ["save"]);
  assert.equal(noArgs.code, 2);
  assert.equal(noArgs.stdout, "");
  assert.match(noArgs.stderr, /^hoptell: save needs a <t_id> and a <path>\nusage: hoptell save /);
  assert.match((await cli(s.bob.dir, ["save", id, dest, "--bogus"])).stderr, /^hoptell: unknown option --bogus for hoptell save\n/);
});

test("hoptell doctor recovers an interrupted save, reports leftovers, and removes them with --fix; save --forget drops an ambiguous record only", async (t) => {
  const s = await stagedHome(t, 2);
  const [a, b] = s.list;
  // An interrupted save of a (crash after the link): doctor finishes it.
  await assert.rejects(saveTransfer({ home: s.bob.dir, staging: s.bob.staging, t: a.t, destination: path.join(s.out, "a.bin"), fault: (p) => { if (p === "after-link") throw Object.assign(new Error("crash"), { code: "EFAULT" }); } }));
  const d1 = await cli(s.bob.dir, ["doctor"]);
  assert.match(d1.stdout, new RegExp(`the save of ${a.t} to .*a\\.bin is complete`));
  assert.equal(sha(fs.readFileSync(path.join(s.out, "a.bin"))), sha(a.bytes));
  assert.equal(readJournal(s.bob.dir, a.t), null);
  // An ambiguous save of b: reported, kept; --forget drops the record, never the file.
  await assert.rejects(saveTransfer({ home: s.bob.dir, staging: s.bob.staging, t: b.t, destination: path.join(s.out, "b.bin"), fault: (p) => { if (p === "after-hash") throw Object.assign(new Error("crash"), { code: "EFAULT" }); } }));
  const d2 = await cli(s.bob.dir, ["doctor"]);
  assert.match(d2.stdout, /may be a partial or complete copy/);
  const tmpFile = fs.readdirSync(s.out).find((n) => n.startsWith(".hoptell-save-"));
  assert.ok(tmpFile);
  assert.equal((await cli(s.bob.dir, ["save", "--forget", b.t])).code, 0);
  assert.ok(fs.existsSync(path.join(s.out, tmpFile)), "the file is kept");
  // Leftovers: a stray folder; doctor reports it; --fix removes it.
  fs.mkdirSync(path.join(incomingDir(s.bob.dir), "t_0123456789abcdef01234567"));
  const d3 = await cli(s.bob.dir, ["doctor"]);
  assert.match(d3.stdout, /0 failed cleanups, 0 staged files older than 7 days, 1 folder without a ledger entry, 0 entries without a folder, 0 outbox entries older/);
  assert.match(d3.stdout, /run hoptell doctor --fix/);
  const d4 = await cli(s.bob.dir, ["doctor", "--fix"]);
  assert.match(d4.stdout, /1 stray folder,/);
  assert.equal(fs.existsSync(path.join(incomingDir(s.bob.dir), "t_0123456789abcdef01234567")), false);
  assert.equal(fs.existsSync(path.join(incomingDir(s.bob.dir), b.t)), true, "a staged transfer is not a leftover");
});
