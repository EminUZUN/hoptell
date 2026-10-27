// Environment switches and choices: a value that is not one of the accepted spellings is never
// taken silently. A switch that guards something (HOPTELL_REQUIRE_MEMBERS, HOPTELL_OWNER_APP,
// HOPTELL_EXPERIMENTAL_E2EE, HOPTELL_AUTH, HOPTELL_CREDENTIAL_STORE, HOPTELL_AGENTS_MAX for
// spawning) is refused, naming the variable and the accepted values, before anything changes; the
// others (HOPTELL_NOTIFY, HOPTELL_OWNER_CHANNEL, HOPTELL_ELICITATION) are reported with the value used.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { BIN, ROOT, envAuth, envChoice, envCredentialStore, envElicitation, envNotify, envOwnerChannel, envSwitch, testBarrier } from "../lib/config.js";
import { readSettings, settingsProblem } from "../lib/settings.js";
import { createEngine } from "../lib/engine.js";
import { settingsContext } from "../lib/decisions.js";
import { installLocalRelay } from "../lib/localrelay.js";

const settingsFor = (env) => readSettings({ env, homedir: "/nonexistent-home", pid: process.pid, hostname: "testhost" });

test("envSwitch: the documented spellings in any case and with spaces; anything else is refused with the accepted values", () => {
  for (const v of ["1", "true", "on", "yes", "ON", " True ", "YES"]) assert.equal(envSwitch({ X: v }, "X"), true, v);
  for (const v of [undefined, "", "  ", "0", "false", "off", "no", "OFF", " No "]) assert.equal(envSwitch({ X: v }, "X"), false, String(v));
  for (const v of ["2", "maybe", "enabled", "of", "-1"]) {
    assert.throws(() => envSwitch({ HOPTELL_REQUIRE_MEMBERS: v }, "HOPTELL_REQUIRE_MEMBERS"), (e) => {
      assert.equal(e.message, `HOPTELL_REQUIRE_MEMBERS must be on or off (1, true and yes also mean on; 0, false and no mean off), not ${JSON.stringify(v)}`);
      return true;
    });
  }
  assert.throws(() => envSwitch({ X: "y".repeat(500) }, "X"), (e) => e.message.length < 200, "a long value is shortened");
});

test("envAuth and envCredentialStore: accepted values, defaults and refusals", () => {
  assert.equal(envAuth({}), "token");
  assert.equal(envAuth({ HOPTELL_AUTH: " Login " }), "login");
  assert.equal(envAuth({ HOPTELL_AUTH: "TOKEN" }), "token");
  assert.throws(() => envAuth({ HOPTELL_AUTH: "magic" }), /^Error: HOPTELL_AUTH must be token or login, not "magic"$/);
  assert.equal(envCredentialStore({}), "auto");
  assert.equal(envCredentialStore({ HOPTELL_CREDENTIAL_STORE: "keychain" }), "auto");
  assert.equal(envCredentialStore({ HOPTELL_CREDENTIAL_STORE: "file" }), "file");
  assert.equal(envCredentialStore({ HOPTELL_CREDENTIAL_STORE: " FILE " }), "file", "not the keychain for a case variant");
  assert.throws(() => envCredentialStore({ HOPTELL_CREDENTIAL_STORE: "vault" }), /^Error: HOPTELL_CREDENTIAL_STORE must be file or keychain \(the default when unset\), not "vault"$/);
});

test("envChoice: the default with a warning naming the variable and the value used", () => {
  assert.deepEqual(envNotify({}), { value: true, warning: null });
  assert.deepEqual(envNotify({ HOPTELL_NOTIFY: "OFF" }), { value: false, warning: null });
  assert.deepEqual(envNotify({ HOPTELL_NOTIFY: "of" }), { value: true, warning: 'HOPTELL_NOTIFY must be on or off, not "of"; using on' });
  assert.deepEqual(envOwnerChannel({ HOPTELL_OWNER_CHANNEL: "0" }), { value: true, warning: 'HOPTELL_OWNER_CHANNEL must be on or off, not "0"; using on' });
  assert.deepEqual(envOwnerChannel({ HOPTELL_OWNER_CHANNEL: "off" }), { value: false, warning: null });
  assert.deepEqual(envElicitation({ HOPTELL_ELICITATION: "read_inbox" }), { value: "read_inbox", warning: null });
  assert.deepEqual(envElicitation({ HOPTELL_ELICITATION: "off" }), { value: "off", warning: null });
  assert.deepEqual(envElicitation({ HOPTELL_ELICITATION: "readinbox" }), { value: "off", warning: 'HOPTELL_ELICITATION must be off or read_inbox, not "readinbox"; using off' });
  assert.deepEqual(envChoice({}, "X", { "": 1, a: 1 }), { value: 1, warning: null });
});

test("session settings: an invalid encryption switch or credential store stops the session; the others warn", () => {
  const ok = settingsFor({ HOPTELL_EXPERIMENTAL_E2EE: "yes", HOPTELL_CREDENTIAL_STORE: "file" });
  assert.equal(settingsProblem(ok), null);
  assert.ok(ok.e2ee, "on");
  assert.equal(ok.signIn.credentialStore, "file");
  for (const [env, re] of [
    [{ HOPTELL_EXPERIMENTAL_E2EE: "2" }, /HOPTELL_EXPERIMENTAL_E2EE must be on or off .*not "2"/],
    [{ HOPTELL_CREDENTIAL_STORE: "vault" }, /HOPTELL_CREDENTIAL_STORE must be file or keychain/],
  ]) {
    const s = settingsFor(env);
    assert.match(settingsProblem(s), re);
    assert.equal(s.e2ee, undefined, "encryption stays off");
    assert.throws(() => createEngine(s), re, "the engine does not start");
  }
  // HOPTELL_AUTH is part of the relay settings: the relay tools report it (as before).
  assert.match(settingsFor({ HOPTELL_RELAY: "ws://127.0.0.1:1", HOPTELL_AUTH: "magic" }).errors.relay, /HOPTELL_AUTH must be token or login, not "magic"/);
  const warned = settingsFor({ HOPTELL_NOTIFY: "of", HOPTELL_OWNER_CHANNEL: "disabled", HOPTELL_ELICITATION: "yes" });
  assert.equal(settingsProblem(warned), null);
  assert.deepEqual([warned.notify, warned.ownerChannel, warned.elicitation], [true, true, "off"]);
  assert.deepEqual(warned.warnings, [
    'HOPTELL_ELICITATION must be off or read_inbox, not "yes"; using off',
    'HOPTELL_OWNER_CHANNEL must be on or off, not "disabled"; using on',
    'HOPTELL_NOTIFY must be on or off, not "of"; using on',
  ]);
  assert.deepEqual(settingsFor({ HOPTELL_NOTIFY: "off", HOPTELL_OWNER_CHANNEL: "OFF", HOPTELL_ELICITATION: "read_inbox" }).warnings, []);
});

test("the settings decisions refuse an invalid encryption switch", () => {
  assert.equal(settingsContext({ env: { HOPTELL_EXPERIMENTAL_E2EE: "on" }, fromFile: [], envFile: "/x", relaysFile: "/y" }).experimental, true);
  assert.throws(() => settingsContext({ env: { HOPTELL_EXPERIMENTAL_E2EE: "maybe" }, fromFile: [], envFile: "/x", relaysFile: "/y" }), /HOPTELL_EXPERIMENTAL_E2EE must be on or off/);
});

test("local-relay install refuses a misspelled HOPTELL_AUTH before the service is touched", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "hoptell-envsw-lr-"));
  const homedir = fs.mkdtempSync(path.join(os.tmpdir(), "hoptell-envsw-lrh-"));
  t.after(() => [home, homedir].forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
  const calls = [];
  const run = (cmd, args) => (calls.push([cmd, ...args].join(" ")), { status: 1, stdout: "", stderr: "" });
  const relaysFile = path.join(homedir, "relays.json");
  await assert.rejects(
    installLocalRelay({ home, homedir, platform: "linux", uid: 501, run, port: 7799, relaysFile, env: { HOPTELL_RELAY: "ws://127.0.0.1:1", HOPTELL_AUTH: "magic" }, portInUse: async () => false, verify: async () => {} }),
    /HOPTELL_AUTH must be token or login, not "magic"/,
  );
  assert.deepEqual(fs.readdirSync(home), [], "nothing was created");
  assert.equal(fs.existsSync(relaysFile), false);
  assert.ok(!calls.some((c) => /enable|restart|start/.test(c)), calls.join("\n"));
});

/** A sandbox with its own HOME, settings and state, and stubs first in PATH. */
function sandbox(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hoptell-envsw-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stubs = path.join(root, "stubs");
  fs.mkdirSync(stubs);
  for (const cmd of ["launchctl", "systemctl", "open", "xdg-open", "tmux"]) fs.writeFileSync(path.join(stubs, cmd), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  fs.writeFileSync(path.join(root, "empty.env"), "");
  const env = {
    PATH: `${stubs}:${process.env.PATH}`,
    HOME: path.join(root, "home"),
    HOPTELL_HOME: path.join(root, "hoptell"),
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_STATE_HOME: path.join(root, "state"),
    HOPTELL_ENV: path.join(root, "empty.env"),
    HOPTELL_NOTIFY: "off",
    HOPTELL_STATE_DIR: path.join(root, "relay-state"),
    TMUX_TMPDIR: path.join(root, "tmux"),
  };
  fs.mkdirSync(env.HOME);
  const run = (args, extra = {}) => spawnSync(process.execPath, [BIN, ...args], { cwd: root, env: { ...env, ...extra }, encoding: "utf8", timeout: 15_000, input: "" });
  const created = () => ["hoptell", "relay-state", "config", "state"].filter((d) => fs.existsSync(path.join(root, d)));
  return { root, env, run, created };
}

test("relay: a misspelled HOPTELL_REQUIRE_MEMBERS, HOPTELL_OWNER_APP or HOPTELL_EXPERIMENTAL_E2EE refuses the start before the state directory exists", (t) => {
  const s = sandbox(t);
  const token = crypto.randomBytes(24).toString("hex");
  const start = ["relay", "--host", "127.0.0.1", "--port", "0"];
  for (const [extra, flags, re] of [
    [{ HOPTELL_REQUIRE_MEMBERS: "2" }, [], /HOPTELL_REQUIRE_MEMBERS must be on or off \(1, true and yes also mean on; 0, false and no mean off\), not "2"/],
    [{ HOPTELL_REQUIRE_MEMBERS: "2" }, ["--require-members"], /HOPTELL_REQUIRE_MEMBERS must be on or off/],
    [{ HOPTELL_OWNER_APP: "maybe" }, [], /HOPTELL_OWNER_APP must be on or off .*not "maybe"/],
    [{ HOPTELL_EXPERIMENTAL_E2EE: "2" }, [], /HOPTELL_EXPERIMENTAL_E2EE must be on or off .*not "2"/],
    [{ HOPTELL_EXPERIMENTAL_E2EE: "2" }, ["--experimental-e2ee"], /HOPTELL_EXPERIMENTAL_E2EE must be on or off/],
  ]) {
    const r = s.run([...start, ...flags], { HOPTELL_TOKEN: token, ...extra });
    assert.equal(r.status, 1, `${JSON.stringify(extra)}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, re);
    assert.doesNotMatch(r.stdout, /listening/);
    assert.deepEqual(s.created(), [], "nothing was created");
  }
  // An accepted spelling (any case, with spaces) is on: the shared token is refused.
  for (const v of [" TRUE ", "on", "1", "Yes"]) {
    const r = s.run(start, { HOPTELL_TOKEN: token, HOPTELL_REQUIRE_MEMBERS: v });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /--require-members is set, so a shared HOPTELL_TOKEN is not allowed/, v);
  }
  assert.deepEqual(s.created(), []);
});

test("CLI commands refuse a misspelled credential store or encryption switch before anything is created", (t) => {
  const s = sandbox(t);
  const relay = { HOPTELL_RELAY: "ws://127.0.0.1:9", HOPTELL_TOKEN: "t".repeat(32) };
  for (const [args, extra, re] of [
    [["login"], { ...relay, HOPTELL_CREDENTIAL_STORE: "vault" }, /HOPTELL_CREDENTIAL_STORE must be file or keychain \(the default when unset\), not "vault"/],
    [["login", "--store", "file"], { ...relay, HOPTELL_CREDENTIAL_STORE: "vault" }, /HOPTELL_CREDENTIAL_STORE must be file or keychain/],
    [["device", "status"], { ...relay, HOPTELL_EXPERIMENTAL_E2EE: "2" }, /HOPTELL_EXPERIMENTAL_E2EE must be on or off/],
    [["contacts", "encryption", "bob", "required"], { ...relay, HOPTELL_EXPERIMENTAL_E2EE: "maybe" }, /HOPTELL_EXPERIMENTAL_E2EE must be on or off/],
    [["telegram", "status"], { HOPTELL_CREDENTIAL_STORE: "vault" }, /HOPTELL_CREDENTIAL_STORE must be file or keychain/],
    [["list"], { ...relay, HOPTELL_AUTH: "magic" }, /HOPTELL_AUTH must be token or login, not "magic"/],
    [["ui"], { HOPTELL_EXPERIMENTAL_E2EE: "maybe" }, /HOPTELL_EXPERIMENTAL_E2EE must be on or off/],
    [["ui"], { ...relay, HOPTELL_EXPERIMENTAL_E2EE: "1", HOPTELL_CREDENTIAL_STORE: "vault" }, /HOPTELL_CREDENTIAL_STORE must be file or keychain/],
    [["device", "status"], { ...relay, HOPTELL_EXPERIMENTAL_E2EE: "1", HOPTELL_CREDENTIAL_STORE: "vault" }, /HOPTELL_CREDENTIAL_STORE must be file or keychain/],
    [["contacts", "verify", "m_x", "--conversation"], { ...relay, HOPTELL_EXPERIMENTAL_E2EE: "1", HOPTELL_CREDENTIAL_STORE: "vault" }, /HOPTELL_CREDENTIAL_STORE must be file or keychain/],
    // hoptell tmux: both are checked before anything starts, whatever HOPTELL_AUTH says.
    [["tmux", "emin-x", "--", "true"], { HOPTELL_CREDENTIAL_STORE: "vault" }, /HOPTELL_CREDENTIAL_STORE must be file or keychain/],
    [["tmux", "emin-x", "--", "true"], { HOPTELL_AUTH: "magic" }, /HOPTELL_AUTH must be token or login, not "magic"/],
  ]) {
    const r = s.run(args, extra);
    assert.equal(r.status, 1, `${args.join(" ")}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, re, args.join(" "));
    assert.deepEqual(s.created(), [], `${args.join(" ")}: nothing was created`);
  }
});

test("hoptell mcp does not serve with a misspelled encryption switch or credential store", (t) => {
  const s = sandbox(t);
  for (const [extra, re] of [
    [{ HOPTELL_EXPERIMENTAL_E2EE: "2" }, /not serving: HOPTELL_EXPERIMENTAL_E2EE must be on or off/],
    [{ HOPTELL_CREDENTIAL_STORE: "vault" }, /not serving: HOPTELL_CREDENTIAL_STORE must be file or keychain/],
  ]) {
    const r = s.run(["mcp"], extra);
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, re);
    assert.equal(r.stdout, "", "nothing on the MCP stream");
  }
});

test("warnings: HOPTELL_NOTIFY and HOPTELL_OWNER_CHANNEL with an unaccepted value name the value used", (t) => {
  const s = sandbox(t);
  const r = s.run(["contacts", "list"], { HOPTELL_NOTIFY: "of" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr.match(/HOPTELL_NOTIFY must be on or off, not "of"; using on/g)?.length, 1, r.stderr);
  const st = s.run(["telegram", "status"], { HOPTELL_OWNER_CHANNEL: "disabled" });
  assert.equal(st.status, 0, st.stderr);
  assert.match(st.stdout, /warn {2}settings: HOPTELL_OWNER_CHANNEL must be on or off, not "disabled"; using on/);
});

test("doctor reports refused switches as failures and the others as warnings", (t) => {
  const s = sandbox(t);
  const r = s.run(["doctor"], {
    HOPTELL_RELAY: "ws://127.0.0.1:9",
    HOPTELL_TOKEN: "t".repeat(32),
    HOPTELL_AUTH: "magic",
    HOPTELL_CREDENTIAL_STORE: "vault",
    HOPTELL_EXPERIMENTAL_E2EE: "2",
    HOPTELL_REQUIRE_MEMBERS: "maybe",
    HOPTELL_OWNER_APP: "sure",
    HOPTELL_AGENTS_MAX: "0",
    HOPTELL_NOTIFY: "of",
    HOPTELL_ELICITATION: "on",
  });
  assert.notEqual(r.status, 0);
  for (const re of [
    /FAIL.*settings.*HOPTELL_AUTH must be token or login, not "magic"/,
    /FAIL.*settings.*HOPTELL_CREDENTIAL_STORE must be file or keychain/,
    /FAIL.*settings.*HOPTELL_EXPERIMENTAL_E2EE must be on or off/,
    /FAIL.*settings.*HOPTELL_REQUIRE_MEMBERS must be on or off/,
    /FAIL.*settings.*HOPTELL_OWNER_APP must be on or off/,
    /FAIL.*settings.*HOPTELL_AGENTS_MAX must be a whole number from 1 to 16, not "0" \(spawning agents is refused\)/,
    /warn.*settings.*HOPTELL_NOTIFY must be on or off, not "of"; using on/,
    /warn.*settings.*HOPTELL_ELICITATION must be off or read_inbox, not "on"; using off/,
  ]) assert.match(r.stdout, re);
  // With an invalid HOPTELL_AUTH, the token is not used for a relay login (no token fallback).
  assert.match(r.stdout, /relay login.*not checked: fix the settings above first/);
  assert.doesNotMatch(r.stdout, /token.*set \(not shown\)/);
  assert.doesNotMatch(r.stdout, /relay login.*(accepted|refused|failed)/i);
});

test("test barriers are read only in a source checkout; the package ships no test/ folder", () => {
  const env = { HOPTELL_APPLY_TEST_BARRIER: "/tmp/b", HOPTELL_READER_TEST_BARRIER: "/tmp/r", HOPTELL_WAKE_TEST_BARRIER: "/tmp/w" };
  // This suite runs from a checkout: the barriers work here.
  assert.equal(testBarrier(env, "APPLY"), "/tmp/b");
  assert.equal(settingsFor(env).barriers.reader, "/tmp/r");
  // An installed package (no test/ folder) reads none of them.
  for (const kind of ["APPLY", "READER", "WAKE"]) assert.equal(testBarrier(env, kind, false), null, kind);
  const files = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).files;
  assert.ok(!files.some((f) => /^\.?\/?test(\/|$)/.test(f)), "test/ is not in the package");
  // Nothing else in the shipped code reads a barrier variable directly (lib/files.js only sets
  // the reader's for its helper process).
  const shipped = (dir) => fs.readdirSync(path.join(ROOT, dir), { recursive: true }).filter((f) => /\.(m?js)$/.test(f)).map((f) => path.join(dir, f));
  for (const f of [...shipped("lib"), ...shipped("bin")]) {
    const src = fs.readFileSync(path.join(ROOT, f), "utf8");
    if (f === path.join("lib", "read-helper.mjs")) continue; // its environment comes only from lib/files.js
    assert.doesNotMatch(src.replace(/^\s*\/\/.*$/gm, ""), /env\.HOPTELL_[A-Z]+_TEST_BARRIER(?!\s*=[^=])/, f);
  }
});
