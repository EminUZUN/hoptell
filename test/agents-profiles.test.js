// Agent profiles (design 7.1): schema, file checks, approval through the decision service.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { BIN } from "../lib/config.js";
import { CODEX_APPROVAL_WARNING, agentsPaths, approvalOf, readPrivateFile, listProfiles, readApproved, readAudit, readProfile, unsafe, validateProfile, withDefaults, confirmOf, lifetimeOf, audit } from "../lib/agents.js";
import * as decisions from "../lib/decisions.js";
import { agentsWorld, profileDoc, writeProfile } from "./agents-helpers.js";

test("profiles: the schema file and the checker agree on fields, caps and refusals", (t) => {
  const w = agentsWorld(t);
  const schema = JSON.parse(fs.readFileSync(new URL("../schema/agent-profile.schema.json", import.meta.url), "utf8"));
  assert.equal(schema.properties.version.const, 1);
  assert.deepEqual(schema.properties.cli.enum, ["codex", "claude", "gemini", "agy"]);
  assert.deepEqual(schema.properties.sandbox.enum, ["read-only", "workspace-write", "full"]);
  assert.equal(schema.properties.limits.properties.concurrent.maximum, 8);
  assert.equal(schema.properties.limits.properties.perHour.maximum, 60);
  assert.equal(schema.properties.limits.properties.lifetimeMinutes.maximum, 1440);
  assert.equal(schema.properties.limits.properties.taskBytes.maximum, 256 * 1024);
  assert.equal(schema.properties.limits.properties.resultBytes.maximum, 1024 * 1024);
  const v = (over) => validateProfile(profileDoc(w.work, over), { home: w.home, homedir: w.homedir }).join("; ");
  assert.equal(v({}), "");
  assert.equal(v({ limits: { concurrent: 8, perHour: 60, lifetimeMinutes: 240, taskBytes: 262144, resultBytes: 1048576 } }), "");
  const bad = [
    [{ version: 2 }, /version must be 1/],
    [{ id: "Bad_Id" }, /id must be/],
    [{ extra: 1 }, /unknown field "extra"/],
    [{ cli: "bash" }, /cli must be one of/],
    [{ command: "codex" }, /command must be an absolute path/],
    [{ modes: [] }, /modes must list/],
    [{ modes: ["headless", "headless"] }, /modes must list/],
    [{ modes: ["daemon"] }, /modes must list/],
    [{ sandbox: "full" }, /sandbox full is refused/],
    [{ sandbox: "danger-full-access" }, /sandbox must be/],
    [{ folders: { roots: ["relative/dir"], default: "relative/dir" } }, /relative paths are refused/],
    [{ folders: { roots: [w.work], default: "/elsewhere" } }, /default must be one of/],
    [{ folders: { roots: [w.work], default: w.work, more: 1 } }, /folders must be/],
    [{ folders: { roots: [path.join(w.work, "gone")], default: path.join(w.work, "gone") } }, /does not exist/],
    [{ name: { prefix: "-x" } }, /name.prefix must be/],
    [{ name: { prefix: "ok", extra: 1 } }, /name must be/],
    [{ roles: ["spawned"] }, /cannot include "all" or "spawned"/],
    [{ roles: ["all"] }, /cannot include "all" or "spawned"/],
    [{ roles: ["bad role"] }, /roles must be/],
    [{ relays: [] }, /relays must list/],
    [{ relays: ["Bad"] }, /relays must list/],
    [{ env: { pass: ["HOPTELL_TOKEN"] } }, /cannot pass HOPTELL_/],
    [{ env: { pass: ["1BAD"] } }, /env.pass must be/],
    [{ env: { other: [] } }, /env must be/],
    [{ cliOptions: { model: "gpt 5" } }, /cliOptions.model/],
    [{ cliOptions: { flags: "--yolo" } }, /unknown option "flags"/],
    [{ cliOptions: { effort: "huge" } }, /cliOptions.effort must be/],
    [{ cli: "gemini", cliOptions: { effort: "high" } }, /only for codex and claude/],
    [{ cliOptions: { allowedTools: ["Read"] } }, /only for claude/],
    [{ cli: "claude", cliOptions: { allowedTools: ["--dangerously-skip-permissions"] } }, /allowedTools must list/],
    [{ spawners: { names: ["a b"] } }, /spawners.names/],
    [{ spawners: { groups: [] } }, /spawners must be/],
    [{ confirm: "sometimes" }, /confirm must be/],
    [{ limits: { concurrent: 9 } }, /concurrent must be a whole number from 1 to 8/],
    [{ limits: { perHour: 61 } }, /perHour/],
    [{ limits: { lifetimeMinutes: 1441 } }, /lifetimeMinutes must be a whole number/],
    [{ limits: { lifetimeMinutes: 241 } }, /at most 240 for a profile with headless mode/],
    [{ limits: { taskBytes: 262145 } }, /taskBytes/],
    [{ limits: { resultBytes: 1048577 } }, /resultBytes/],
    [{ limits: { budgetUsd: 5 } }, /only for cli claude/],
    [{ cli: "claude", limits: { budgetUsd: -1 } }, /budgetUsd must be a number/],
    [{ limits: { other: 1 } }, /limits: unknown field/],
  ];
  for (const [over, re] of bad) assert.match(v(over), re, JSON.stringify(over));
  for (const k of ["version", "id", "cli", "modes", "sandbox", "folders", "name"]) {
    const d = profileDoc(w.work);
    delete d[k];
    assert.match(validateProfile(d, { home: w.home }).join("; "), new RegExp(`${k} is required`));
  }
  // tmux allows the longer lifetime; claude headless takes a budget.
  assert.equal(v({ modes: ["tmux"], limits: { lifetimeMinutes: 1440 } }), "");
  assert.equal(v({ cli: "claude", limits: { budgetUsd: 2.5 }, cliOptions: { allowedTools: ["Read", "Bash(git diff:*)"], effort: "high" } }), "");
});

test("profiles: a root that is, contains or lies inside the hoptell home is invalid (also through a symlink)", (t) => {
  const w = agentsWorld(t);
  const v = (root) => validateProfile(profileDoc(w.work, { folders: { roots: [root], default: root } }), { home: w.home, homedir: w.homedir }).join("; ");
  assert.match(v(w.home), /is, contains or lies inside the hoptell home/);
  assert.match(v(w.base), /is, contains or lies inside the hoptell home/);
  assert.match(v(path.join(w.home, "agents")), /is, contains or lies inside the hoptell home/);
  fs.symlinkSync(w.home, path.join(w.work, "link-to-home"));
  assert.match(v(path.join(w.work, "link-to-home")), /inside the hoptell home/);
  // "~/" expands to the home folder.
  assert.equal(v("~/work"), "");
  assert.equal(withDefaults(profileDoc(w.work, { folders: { roots: ["~/work"], default: "~/work" } }), w.homedir).folders.default, w.work);
});

test("profiles: defaults, confirmation default and lifetime per mode", (t) => {
  const w = agentsWorld(t);
  const p = withDefaults(profileDoc(w.work, { roles: undefined, relays: undefined }), w.homedir);
  assert.deepEqual(p.relays, ["local"]);
  assert.deepEqual(p.roles, []);
  assert.deepEqual(p.env.pass, []);
  assert.equal(p.limits.concurrent, 2);
  assert.equal(p.limits.perHour, 10);
  assert.equal(p.limits.taskBytes, 32768);
  assert.equal(p.limits.resultBytes, 65536);
  assert.equal(p.limits.budgetUsd, null);
  assert.equal(lifetimeOf(p, "headless"), 30);
  assert.equal(lifetimeOf(p, "tmux"), 480);
  const local = (a) => a !== "local";
  assert.equal(confirmOf(p, local), "never");
  assert.equal(confirmOf({ ...p, sandbox: "workspace-write" }, local), "always");
  assert.equal(confirmOf({ ...p, relays: ["local", "team"] }, local), "always");
  assert.equal(confirmOf({ ...p, sandbox: "workspace-write", confirm: "never" }, local), "never");
  assert.equal(confirmOf({ ...p, confirm: "always" }, local), "always");
});

test("profiles: file checks (mode, symlink, links, size, owner), id/file-name mismatch, a broken profile next to a good one", (t) => {
  const w = agentsWorld(t);
  const dir = agentsPaths(w.home).profiles;
  writeProfile(w.home, profileDoc(w.work));
  const good = readProfile(w.home, "codex-reviewer", { homedir: w.homedir });
  assert.deepEqual(good.problems, []);
  assert.match(good.digest, /^[0-9a-f]{64}$/);
  // mode
  writeProfile(w.home, profileDoc(w.work, { id: "wide" }), { mode: 0o644 });
  assert.match(readProfile(w.home, "wide").problems.join(), /readable or writable by other users/);
  // symlink
  fs.symlinkSync(path.join(dir, "codex-reviewer.json"), path.join(dir, "linked.json"));
  assert.match(readProfile(w.home, "linked").problems.join(), /symbolic link/);
  // hard links
  writeProfile(w.home, profileDoc(w.work, { id: "twice" }));
  fs.linkSync(path.join(dir, "twice.json"), path.join(w.base, "twice-copy.json"));
  assert.match(readProfile(w.home, "twice").problems.join(), /more than one hard link/);
  // size
  writeProfile(w.home, profileDoc(w.work, { id: "big", description: "x".repeat(200) }));
  fs.appendFileSync(path.join(dir, "big.json"), " ".repeat(17 * 1024));
  assert.match(readProfile(w.home, "big").problems.join(), /larger than 16384 bytes/);
  // owner (the descriptor's stat; another user's file cannot be made without root)
  const st = fs.statSync(path.join(dir, "codex-reviewer.json"));
  assert.equal(unsafe(st, 16384), null);
  assert.equal(unsafe({ isFile: () => true, uid: process.getuid() + 1, mode: 0o100600, nlink: 1, size: 10 }, 16384), "not owned by this user");
  assert.equal(unsafe({ isFile: () => false, uid: process.getuid(), mode: 0o040700, nlink: 1, size: 10 }, 16384), "not a regular file");
  // id and file name
  writeProfile(w.home, profileDoc(w.work, { id: "other" }), { id: "mismatch" });
  assert.match(readProfile(w.home, "mismatch").problems.join(), /does not match the file name mismatch.json/);
  // invalid JSON
  fs.writeFileSync(path.join(dir, "broken.json"), "{oops", { mode: 0o600 });
  assert.match(readProfile(w.home, "broken").problems.join(), /not valid JSON/);
  // the list keeps the good one usable next to the broken ones
  const all = listProfiles(w.home, { homedir: w.homedir });
  assert.deepEqual(all.map((r) => r.id), ["big", "broken", "codex-reviewer", "linked", "mismatch", "twice", "wide"]);
  assert.deepEqual(all.filter((r) => !r.problems.length).map((r) => r.id), ["codex-reviewer"]);
  // a profiles directory readable by others is not used
  fs.chmodSync(dir, 0o755);
  assert.match(readProfile(w.home, "codex-reviewer").problems.join(), /not a private directory/);
  fs.chmodSync(dir, 0o700);
});

test("approval through the decision service: unapproved, approve, changed digest, stale token, invalid", async (t) => {
  const w = agentsWorld(t);
  const sources = { agents: { homedir: w.homedir } };
  writeProfile(w.home, profileDoc(w.work));
  const listed = await decisions.list({ home: w.home, kinds: ["agent-profile"] });
  assert.deepEqual(listed.map((i) => i.id), ["agent-profile:codex-reviewer"]);
  assert.match(listed[0].summary, /not approved yet/);
  const shown = await decisions.show({ home: w.home, id: "agent-profile:codex-reviewer", sources });
  assert.equal(shown.kind, "agent-profile");
  assert.equal(shown.view.state, "unapproved");
  assert.equal(shown.token, shown.view.digest);
  assert.deepEqual(shown.actions, [{ action: "approve", options: {} }]);
  // A wrong action or a malformed token is refused before anything is read.
  assert.match((await decisions.decide({ home: w.home, id: "agent-profile:codex-reviewer", action: "allow", token: shown.token })).reason, /not an action/);
  assert.match((await decisions.decide({ home: w.home, id: "agent-profile:codex-reviewer", action: "approve", token: "x" })).reason, /not one this service issued/);
  const d = await decisions.decide({ home: w.home, id: "agent-profile:codex-reviewer", action: "approve", token: shown.token, sources });
  assert.equal(d.done, true);
  assert.equal(readApproved(w.home).profiles["codex-reviewer"].digest, shown.token);
  assert.equal(fs.statSync(agentsPaths(w.home).approved).mode & 0o777, 0o600);
  assert.equal(approvalOf(readProfile(w.home, "codex-reviewer", { homedir: w.homedir }), readApproved(w.home)), "approved");
  assert.deepEqual(await decisions.list({ home: w.home, kinds: ["agent-profile"] }), []);
  assert.deepEqual((await decisions.show({ home: w.home, id: "agent-profile:codex-reviewer", sources })).actions, []);
  // An edit makes it "changed": not usable until approved again; the old token is stale.
  writeProfile(w.home, profileDoc(w.work, { sandbox: "workspace-write" }));
  assert.equal(approvalOf(readProfile(w.home, "codex-reviewer", { homedir: w.homedir }), readApproved(w.home)), "changed");
  assert.match((await decisions.list({ home: w.home, kinds: ["agent-profile"] }))[0].summary, /changed since you approved it/);
  const stale = await decisions.decide({ home: w.home, id: "agent-profile:codex-reviewer", action: "approve", token: shown.token, sources });
  assert.equal(stale.stale, true);
  assert.notEqual(stale.token, shown.token);
  assert.equal(readApproved(w.home).profiles["codex-reviewer"].digest, shown.token, "nothing written");
  // An invalid profile cannot be approved.
  writeProfile(w.home, profileDoc(w.work, { sandbox: "full" }));
  const inv = await decisions.show({ home: w.home, id: "agent-profile:codex-reviewer", sources });
  assert.equal(inv.view.state, "invalid");
  assert.deepEqual(inv.actions, []);
  assert.match((await decisions.decide({ home: w.home, id: "agent-profile:codex-reviewer", action: "approve", token: inv.token, sources })).reason, /invalid/);
  assert.match((await decisions.show({ home: w.home, id: "agent-profile:nope", sources })).reason, /no agent profile nope/);
  // The approval is audited (id and digest only).
  const ev = readAudit(w.home).filter((e) => e.event === "profile-approved");
  assert.deepEqual(ev.map((e) => [e.id, e.digest]), [["codex-reviewer", shown.token]]);
});

test("the decision list of a home without agent profiles is unchanged", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hoptell-agents-none-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.deepEqual(await decisions.list({ home: dir, kinds: ["agent-profile"] }), []);
  assert.equal(fs.existsSync(path.join(dir, "agents")), false, "listing creates nothing");
});

test("audit: one JSON line per event, private, rotated with two files kept", (t) => {
  const w = agentsWorld(t);
  for (let i = 0; i < 30; i++) audit(w.home, "spawn-requested", { n: i }, { max: 400 });
  const file = agentsPaths(w.home).audit;
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.ok(fs.existsSync(`${file}.1`));
  assert.equal(fs.existsSync(`${file}.2`), false);
  assert.ok(fs.statSync(file).size <= 400);
  const all = readAudit(w.home);
  assert.equal(all.at(-1).n, 29);
  assert.ok(all.every((e, i) => i === 0 || e.n === all[i - 1].n + 1), "oldest first, contiguous");
});

test("hoptell agents profiles and profile approve", async (t) => {
  const w = agentsWorld(t);
  writeProfile(w.home, profileDoc(w.work));
  fs.writeFileSync(path.join(agentsPaths(w.home).profiles, "broken.json"), "{", { mode: 0o600 });
  fs.writeFileSync(path.join(w.base, "empty.env"), "");
  const env = { ...process.env, HOPTELL_HOME: w.home, HOPTELL_ENV: path.join(w.base, "empty.env"), XDG_CONFIG_HOME: path.join(w.base, "config"), HOME: w.homedir };
  const run = (...args) => new Promise((resolve) => execFile(process.execPath, [BIN, "agents", ...args], { env }, (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stdout, stderr })));
  let r = await run("profiles");
  assert.match(r.stdout, /codex-reviewer {2}not approved yet/);
  assert.match(r.stdout, /broken {2}INVALID/);
  assert.match(r.stdout, /approve with: hoptell agents profile approve codex-reviewer/);
  // R7: a codex profile without --accept-read-risk: the warning, verbatim, then a refusal naming
  // the second step; nothing is approved and no decision is recorded.
  const auditBefore = readAudit(w.home).length;
  r = await run("profile", "approve", "codex-reviewer");
  assert.equal(r.code, 1, r.stdout);
  assert.match(r.stdout, /SHA-256 [0-9a-f]{64}/);
  assert.match(r.stdout, /"cli": "codex"/);
  assert.ok(r.stdout.includes(`WARNING: ${CODEX_APPROVAL_WARNING}`), "the Codex approval warning is shown");
  assert.match(r.stderr, /Not approved: read the warning above, then approve with: hoptell agents profile approve codex-reviewer --accept-read-risk/);
  assert.doesNotMatch(r.stdout, /Approved/);
  assert.equal(readApproved(w.home).profiles?.["codex-reviewer"], undefined, "no approval recorded");
  assert.equal(approvalOf(readProfile(w.home, "codex-reviewer"), readApproved(w.home)), "unapproved");
  assert.equal(readAudit(w.home).length, auditBefore, "no decision recorded");
  // The second step: with the flag, the warning again, then the approval.
  r = await run("profile", "approve", "codex-reviewer", "--accept-read-risk");
  assert.equal(r.code, 0, r.stderr);
  const warning = r.stdout.indexOf(`WARNING: ${CODEX_APPROVAL_WARNING}`);
  assert.ok(warning >= 0, "the warning is shown again");
  assert.ok(warning < r.stdout.indexOf("Approved:"), "before the profile is approved");
  assert.match(CODEX_APPROVAL_WARNING, /^Spawned Codex runs use your macOS account\. .*Access to the Keychain and the device-state sealing key has not been tested\.$/);
  r = await run("profiles");
  assert.match(r.stdout, /codex-reviewer {2}approved/);
  // The flag on a profile of another CLI: refused (it means nothing there), nothing approved.
  writeProfile(w.home, profileDoc(w.work, { id: "claude-helper", cli: "claude", name: { prefix: "claude-h" } }));
  r = await run("profile", "approve", "claude-helper", "--accept-read-risk");
  assert.equal(r.code, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /--accept-read-risk applies only to codex profiles/);
  assert.doesNotMatch(r.stdout, /WARNING:/);
  r = await run("profiles");
  assert.match(r.stdout, /claude-helper {2}not approved yet/);
  r = await run("profile", "approve", "claude-helper");
  assert.equal(r.code, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /WARNING:/);
  // Also refused once that profile is approved (not "Already approved").
  r = await run("profile", "approve", "claude-helper", "--accept-read-risk");
  assert.equal(r.code, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /--accept-read-risk applies only to codex profiles/);
  r = await run("profile", "approve", "broken");
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /invalid/);
  r = await run("profile", "approve");
  assert.equal(r.code, 2);
  // An invalid codex profile is refused before the read-risk warning is shown.
  writeProfile(w.home, profileDoc(w.work, { id: "codex-bad", sandbox: "full" }));
  r = await run("profile", "approve", "codex-bad", "--accept-read-risk");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /agent profile codex-bad is invalid/);
  assert.doesNotMatch(r.stdout, /WARNING:/);
  // Codex profiles that can never run on this hoptell (workspace-write headless, tmux) are not
  // approved: refused before the warning, nothing recorded.
  for (const [id, over, why] of [
    ["codex-ww", { sandbox: "workspace-write" }, /codex in headless mode runs only with the arguments its gates passed with \(sandbox read-only\), not with sandbox workspace-write/],
    ["codex-tmux", { modes: ["tmux"] }, /codex in tmux mode is not available yet/],
  ]) {
    writeProfile(w.home, profileDoc(w.work, { id, name: { prefix: id }, ...over }));
    r = await run("profile", "approve", id, "--accept-read-risk");
    assert.equal(r.code, 1, r.stdout + r.stderr);
    assert.match(r.stderr, new RegExp(`agent profile ${id} cannot run on this hoptell: `));
    assert.match(r.stderr, why);
    assert.doesNotMatch(r.stdout, /WARNING:/);
    assert.equal(readApproved(w.home).profiles?.[id], undefined, `${id} is not approved`);
  }
  // A codex profile with a mode that can run is approved as before.
  writeProfile(w.home, profileDoc(w.work, { id: "codex-both", name: { prefix: "codex-both" }, modes: ["headless", "tmux"] }));
  r = await run("profile", "approve", "codex-both", "--accept-read-risk");
  assert.equal(r.code, 0, r.stderr);
});

test("readProfile never creates the agents directory and reports a missing one", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hoptell-agents-none-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(readProfile(dir, "x").missing, true);
  assert.deepEqual(listProfiles(dir), []);
  assert.equal(fs.existsSync(path.join(dir, "agents")), false);
});

test("private files: a transient second hard link (a rename in progress) is read again; a lasting one and other problems are not retried", (t) => {
  const w = agentsWorld(t);
  const f = path.join(w.base, "rec.json");
  const link = path.join(w.base, "rec.link");
  fs.writeFileSync(f, "{}", { mode: 0o600 });
  fs.linkSync(f, link);
  let pauses = 0;
  // The second link goes away between two reads, as when rename() completes.
  const r = readPrivateFile(f, 1024, { pause: () => (pauses++, fs.unlinkSync(link)) });
  assert.equal(r.bytes.toString(), "{}");
  assert.equal(pauses, 1);
  fs.linkSync(f, link);
  pauses = 0;
  assert.equal(readPrivateFile(f, 1024, { pause: () => pauses++ }).problem, "has more than one hard link");
  assert.equal(pauses, 3, "a lasting second link: three more reads, then the problem");
  fs.unlinkSync(link);
  fs.chmodSync(f, 0o644);
  pauses = 0;
  assert.match(readPrivateFile(f, 1024, { pause: () => pauses++ }).problem, /other users/);
  assert.equal(pauses, 0, "no retry for other problems");
});
