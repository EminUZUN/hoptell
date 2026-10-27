// `--help`, `-h`, `help` and `--version` on every command: help is printed and nothing else
// happens (no state directory, no connection, nothing listening, no member removed); options a
// command does not know are refused before it runs.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { BIN } from "../lib/config.js";
import { HELP, preflight, unknownFlag, usage, version } from "../lib/clihelp.js";

// Every command of bin/hoptell.js a user can type (hook-header and the hook commands answer
// Claude Code only and are left out; inject is internal).
const COMMANDS = ["login", "logout", "grants", "contacts", "ui", "local-relay", "members", "relay", "device", "mcp-hosted", "mcp-http", "agents", "mcp", "tmux", "list", "send", "wait", "snapshot", "apply", "telegram", "hooks", "doctor", "transfers", "save", "listen", "ack"];

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

/** A sandbox: its own HOME, settings and state directories, configured as a relay host would be. */
async function sandbox(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hoptell-help-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const port = await freePort();
  fs.writeFileSync(path.join(root, "empty.env"), ""); // no settings file of the developer's
  const env = {
    PATH: process.env.PATH,
    HOME: root,
    HOPTELL_HOME: path.join(root, "hoptell"),
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_STATE_HOME: path.join(root, "state"),
    HOPTELL_ENV: path.join(root, "empty.env"),
    HOPTELL_NOTIFY: "off",
    HOPTELL_HOST: "127.0.0.1",
    HOPTELL_PORT: String(port),
    HOPTELL_RELAY: `ws://127.0.0.1:${port}`,
    HOPTELL_TOKEN: crypto.randomBytes(16).toString("hex"),
    HOPTELL_STATE_DIR: path.join(root, "relay-state"),
    HOPTELL_EXPERIMENTAL_E2EE: "1",
  };
  const run = (args, extra = {}) => spawnSync(process.execPath, [BIN, ...args], { cwd: root, env: { ...env, ...extra }, encoding: "utf8", timeout: 15_000 });
  return { root, env, run, port };
}

/** Every path under `dir` with its bytes' digest: what a command left behind. */
function tree(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        out[`${path.relative(dir, p)}/`] = "dir";
        walk(p);
      } else out[path.relative(dir, p)] = e.isFile() ? crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex") : "other";
    }
  };
  walk(dir);
  return out;
}

test("every command prints its help for --help and -h, and does nothing else", async (t) => {
  const s = await sandbox(t);
  const before = tree(s.root);
  for (const cmd of COMMANDS) {
    for (const flag of ["--help", "-h"]) {
      const r = s.run([cmd, flag]);
      assert.equal(r.status, 0, `${cmd} ${flag}: exit ${r.status} (${r.signal ?? ""}) ${r.stderr}`);
      assert.match(r.stdout, new RegExp(`hoptell ${cmd.replace("-", "\\-")}\\b`), `${cmd} ${flag} prints its own usage`);
      assert.doesNotMatch(r.stdout + r.stderr, /listening|MCP over HTTP at|launch\?t=/, `${cmd} ${flag} starts nothing`);
      assert.equal(r.stderr, "", `${cmd} ${flag} prints no error`);
    }
  }
  assert.deepEqual(tree(s.root), before, "no command created or changed anything");
});

test("--help after a command's arguments: printed instead of running it (a member is not revoked)", async (t) => {
  const s = await sandbox(t);
  const members = path.join(s.root, "members.json");
  const add = s.run(["members", "add", "victim", "--members", members]);
  assert.equal(add.status, 0, add.stderr);
  const before = tree(s.root);
  const lines = [
    ["members", "revoke", "victim", "--members", members, "--help"],
    ["members", "revoke", "victim", "-h", "--members", members],
    ["relay", "--host", "127.0.0.1", "--help"],
    ["relay", "admin", "status", "--help"],
    ["relay", "admin", "restore", "/nowhere", "--help"],
    ["relay", "broker-reset", "--yes", "--help"],
    ["wait", "--help"],
    ["wait", "5", "-h"],
    ["contacts", "block", "q_1", "--rev", "1", "--policy-rev", "1", "--help"],
    ["grants", "allow", "*", "--yes", "--rev", "0", "--help"],
    ["agents", "stop", "r_0000000000000000", "--help"],
    ["telegram", "unpair", "--all", "--help"],
    ["local-relay", "uninstall", "--purge", "--help"],
    ["mcp", "--run", "r_0000000000000000", "--home", path.join(s.root, "x"), "--help"],
    ["mcp-http", "--port", "0", "--help"],
    ["ui", "--help"],
    ["device", "retire", "--yes", "--help"],
    ["save", "t_1", path.join(s.root, "out"), "--yes", "--help"],
    ["snapshot", "--help"],
    ["send", "--ttl", "5m", "--help"],
    ["send", "bob", "--help"],
    ["tmux", "--help"],
  ];
  for (const args of lines) {
    const r = s.run(args);
    assert.equal(r.status, 0, `${args.join(" ")}: exit ${r.status} ${r.stderr}`);
    assert.match(r.stdout, /usage/i, args.join(" "));
    assert.doesNotMatch(r.stdout + r.stderr, /listening|Removed member/, args.join(" "));
  }
  assert.deepEqual(tree(s.root), before, "nothing changed: the member is still there");
  assert.match(s.run(["members", "list", "--members", members]).stdout, /^victim\t/m);
  // relay admin --help prints the admin commands.
  assert.match(s.run(["relay", "admin", "status", "--help"]).stdout, /hoptell relay admin <command>/);
});

test("help as a word: agents, contacts, telegram, members, relay admin; hoptell help <command>", async (t) => {
  const s = await sandbox(t);
  const before = tree(s.root);
  for (const args of [["agents", "help"], ["contacts", "help"], ["telegram", "help"], ["members", "help"], ["grants", "help"], ["relay", "admin", "help"], ["local-relay", "help"], ["help", "wait"], ["help", "relay"]]) {
    const r = s.run(args);
    assert.equal(r.status, 0, `${args.join(" ")}: ${r.stderr}`);
    assert.match(r.stdout, new RegExp(`hoptell ${args[0] === "help" ? args[1] : args[0]}`), args.join(" "));
  }
  const unknown = s.run(["help", "nosuch"]);
  assert.equal(unknown.status, 2);
  assert.equal(unknown.stdout, "");
  assert.equal(unknown.stderr, 'hoptell: no help for "nosuch" (see hoptell --help)\n', "one line, not the whole help");
  assert.deepEqual(tree(s.root), before);
});

test("usage errors: one line on stderr naming the word, exit 2, nothing started or created", async (t) => {
  const s = await sandbox(t);
  const before = tree(s.root);
  for (const [args, line] of [
    [["nosuch"], 'hoptell: unknown command "nosuch" (see hoptell --help)'],
    [["mcp-http", "bogus"], 'hoptell: unknown mcp-http command "bogus" (see hoptell mcp-http --help)'],
    [["mcp-http", "--port", "0", "bogus"], 'hoptell: unknown mcp-http command "bogus" (see hoptell mcp-http --help)'],
    [["members", "bogus"], 'hoptell: unknown members command "bogus" (see hoptell members --help)'],
    [["members"], "hoptell: members needs a command (see hoptell members --help)"],
    [["relay", "admin", "bogus"], 'hoptell: unknown relay admin command "bogus" (see hoptell relay admin --help)'],
    [["transfers", "bogus"], 'hoptell: unknown transfers command "bogus" (see hoptell transfers --help)'],
  ]) {
    const r = s.run(args, { HOPTELL_MEMBERS: "" });
    assert.deepEqual([r.status, r.stdout, r.stderr], [2, "", `${line}\n`], args.join(" "));
  }
  assert.deepEqual(tree(s.root), before, "nothing was created");
});

test("missing-operand errors: the cause on the first line, then the usage, both on stderr, exit 2", async (t) => {
  const s = await sandbox(t);
  for (const [args, cause] of [
    [["send"], "send needs a recipient and a message"],
    [["grants", "allow"], "grants allow needs a selector"],
    [["grants", "bogus"], 'unknown grants command "bogus"'],
    [["contacts", "request"], "contacts request needs a name"],
    [["contacts", "show"], "contacts show needs an id"],
    [["contacts", "allow"], "contacts allow needs an id"],
    [["contacts", "accept-device", "m_x"], "contacts accept-device needs a member id and a device"],
    [["contacts", "encryption", "m_x", "loud"], "contacts encryption needs a mode: required, preferred, off or clear"],
    [["contacts", "check"], "contacts check is missing an argument"],
    [["local-relay", "bogus"], 'unknown local-relay command "bogus"'],
    [["local-relay", "start", "--purge"], "--purge goes with local-relay uninstall only"],
    [["mcp-http", "client", "add"], "mcp-http client add needs a label"],
    [["mcp-http", "client", "bogus"], 'unknown mcp-http client command "bogus"'],
    [["login", "bogus"], 'login does not take "bogus"'],
  ]) {
    const r = s.run(args, { HOPTELL_MEMBERS: "" });
    const lines = r.stderr.split("\n");
    assert.deepEqual([r.status, r.stdout, lines[0]], [2, "", `hoptell: ${cause}`], `${args.join(" ")}\n${r.stderr}`);
    assert.match(lines[1], /^usage: hoptell /, args.join(" "));
  }
});

test("--version and -v print the package version", async (t) => {
  const s = await sandbox(t);
  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
  assert.equal(version(), pkg);
  for (const a of ["--version", "-v", "version"]) {
    const r = s.run([a]);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, `hoptell ${pkg}\n`);
  }
});

test("options a command does not know are refused before it runs", async (t) => {
  const s = await sandbox(t);
  const members = path.join(s.root, "members.json");
  assert.equal(s.run(["members", "add", "victim", "--members", members]).status, 0);
  const before = tree(s.root);
  for (const args of [
    ["members", "revoke", "victim", "--members", members, "--force"],
    ["members", "revoke", "victim", "--member", members],
    ["relay", "broker-reset", "--yes", "--now"],
    ["relay", "apps", "--purge", "abc", "--al"],
    ["relay", "admin", "restore", "/nowhere", "--yes"],
    ["relay", "--hots", "127.0.0.1"],
    ["contacts", "block", "q_1", "--rev", "1", "--policy-rev", "1", "--force"],
    ["grants", "remove", "*", "--yse"],
    ["local-relay", "uninstall", "--purge-all"],
    ["agents", "stop", "r_0000000000000000", "--force"],
    ["telegram", "unpair", "--everything"],
    ["wait", "--forever"],
  ]) {
    const r = s.run(args);
    assert.equal(r.status, 2, `${args.join(" ")}: exit ${r.status} ${r.stderr}`);
    assert.match(r.stderr, /^hoptell: unknown option --[a-z-]+ for hoptell [a-z-]+/, args.join(" "));
  }
  assert.deepEqual(tree(s.root), before, "nothing ran");
  // The checker itself: what follows a lone "--" is not an option of hoptell's.
  assert.equal(unknownFlag("tmux", ["me", "--", "codex", "--bogus"]), null);
  assert.equal(unknownFlag("members", ["list", "--", "--bogus"]), null);
  assert.equal(unknownFlag("relay", ["admin", "status", "--json"]), null);
  assert.equal(unknownFlag("relay", ["--json"]), "--json");
});

test("preflight: where --help counts, and where it is a message or another program's option", () => {
  assert.deepEqual(preflight(["send", "--help"]), { help: "send", args: [] });
  assert.deepEqual(preflight(["send", "--relay", "x", "-h"]), { help: "send", args: [] });
  assert.deepEqual(preflight(["send", "bob", "--help"]), { help: "send", args: [] }, "a message that is only --help is not sent");
  assert.equal(preflight(["send", "bob", "run", "it", "with", "--help"]), null, "a message may mention --help");
  assert.equal(preflight(["send", "--", "bob", "--help"]), null, "after --, it is the message");
  assert.equal(preflight(["tmux", "me", "--", "codex", "--help"]), null, "codex's own --help");
  assert.deepEqual(preflight(["tmux", "--help"]), { help: "tmux", args: [] });
  assert.equal(preflight(["listen", "help"]), null, "help can be a peer name");
  assert.deepEqual(preflight(["relay", "admin", "help"]), { help: "relay", args: ["admin"] });
  assert.deepEqual(preflight(["help"]), { help: null });
  assert.deepEqual(preflight([]), { help: null });
  assert.equal(preflight(["inject", "--help"]), null, "an internal command is not described");
  // An option's value is not a subcommand: these name a realm, a config file and a members file.
  assert.equal(preflight(["relay", "--realm-name", "help"]), null);
  assert.equal(preflight(["mcp-hosted", "--config", "help", "--experimental"]), null);
  assert.equal(preflight(["members", "--members", "help", "list"]), null);
  assert.equal(preflight(["relay", "--state-dir", "help", "admin", "status"]), null);
  assert.deepEqual(preflight(["relay", "--state-dir", "d", "admin", "help"]), { help: "relay", args: ["admin"] });
  // --help where a send option's value belongs is still an option.
  for (const o of ["--ttl", "--relay", "--reply-to"]) for (const h of ["--help", "-h"]) assert.deepEqual(preflight(["send", o, h]), { help: "send", args: [] }, `${o} ${h}`);
});

test("hoptell help lists every command and the relay's options", async (t) => {
  const s = await sandbox(t);
  const r = s.run(["help"]);
  assert.equal(r.status, 0);
  assert.equal(r.stdout.split("\n")[0], usage().split("\n")[0]);
  for (const cmd of Object.keys(HELP)) assert.match(r.stdout, new RegExp(`hoptell ${cmd === "version" ? "--version" : cmd}\\b`), cmd);
  for (const s2 of ["--state-dir", "--require-members", "--oidc", "--experimental-e2ee", "--transfer-quota", "device-approve", "contacts verify", "encryption <member id>", "telegram app", "fav|unfav", "sessions", "hoptell hook-header", "hoptell device enroll"]) assert.ok(r.stdout.includes(s2), s2);
  assert.doesNotMatch(r.stdout, /LAN\/VPN/);
  assert.doesNotMatch(r.stdout, /design \d/);
  // Every line fits an 80-column terminal (78 columns), apart from the settings file paths.
  const files = new Set(r.stdout.split("\n").filter((l) => l.startsWith(`  ${s.root}`)));
  for (const args of [["help"], ...Object.keys(HELP).filter((c) => c !== "version").map((c) => [c, "--help"]), ["relay", "admin", "--help"]]) {
    for (const line of s.run(args).stdout.split("\n")) if (!files.has(line)) assert.ok(line.length <= 78, `${args.join(" ")}: ${line.length} columns: ${line}`);
  }
  // A newcomer sees the common commands first, and every settings line says what it is.
  assert.match(r.stdout, /^Common commands:\n {2}hoptell list {17}who is on the relay$/m);
  assert.match(r.stdout, /^ {2}HOPTELL_PROFILE {16}relay profile key$/m);
  assert.match(r.stdout, /Invalid values\nare refused or reported; some settings warn and use their default\./);
  // The mcp-hosted entry ends with its own text; the client tokens line belongs to mcp-http.
  assert.match(HELP["mcp-http"], /tokens for those clients/);
  assert.doesNotMatch(HELP["mcp-hosted"], /tokens/);
});

test("relay admin views of a directory without relay state create none", async (t) => {
  const s = await sandbox(t);
  const dir = path.join(s.root, "nowhere");
  for (const sub of ["status", "members", "store", "audit"]) {
    const r = s.run(["relay", "admin", sub, "--state-dir", dir]);
    assert.notEqual(r.status, 0, sub);
    assert.match(r.stdout + r.stderr, /no relay state in .*nowhere/, sub);
    assert.equal(fs.existsSync(dir), false, `${sub} created ${dir}`);
  }
  // The default directory (HOPTELL_STATE_DIR unset: under XDG_STATE_HOME) is not created either.
  const r = s.run(["relay", "admin", "status"], { HOPTELL_STATE_DIR: "" });
  assert.match(r.stdout + r.stderr, /no relay state in /);
  assert.equal(fs.existsSync(path.join(s.root, "state")), false);
});

test("grants: a selector the relay would refuse is refused before the preview", async (t) => {
  const s = await sandbox(t);
  for (const [args, want] of [
    [["grants", "allow", "bogus"], /"bogus" is not a selector: use '\*' \(quote it\), group:<name> or member:<id>/],
    [["grants", "deny", "member:alice"], /"member:alice" is not a selector/],
    [["grants", "deny-forever", "group:x"], /"group:x" is not a member selector/],
  ]) {
    const r = s.run(args);
    assert.equal(r.status, 2, `${args.join(" ")}: ${r.stderr}`);
    assert.match(r.stderr, want);
    assert.doesNotMatch(r.stdout, /Nothing published yet/);
  }
});
