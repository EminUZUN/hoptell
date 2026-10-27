// Option values on the command line: a value-taking option without a value is refused (never read
// as left out, which quietly used its default: `local-relay install --port` installed the service on
// the default port); invalid values are refused with a clear message and a nonzero exit status; and a refused command
// changes nothing on disk (no relay state directory, no contacts, no client file).
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { BIN } from "../lib/config.js";
import { missingValue, unknownFlag } from "../lib/clihelp.js";
import { relayDiscovery } from "../lib/login.js";
import { telegramCommand } from "../lib/ownerchannelcli.js";

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

/**
 * A sandbox with its own HOME, settings and state directories, and stubs first in PATH: no
 * service manager, opener or tmux server of the machine is ever reached, even by a regression.
 */
async function sandbox(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hoptell-opts-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stubs = path.join(root, "stubs");
  fs.mkdirSync(stubs);
  for (const cmd of ["launchctl", "systemctl", "open", "xdg-open", "tmux"]) fs.writeFileSync(path.join(stubs, cmd), `#!/bin/sh\necho "${cmd} $*" >> "${path.join(root, "stub.log")}"\nexit 1\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(root, "empty.env"), "");
  const port = await freePort();
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
  const run = (args, extra = {}) => spawnSync(process.execPath, [BIN, ...args], { cwd: root, env: { ...env, ...extra }, encoding: "utf8", timeout: 15_000 });
  return { root, env, run, port, relayUrl: `ws://127.0.0.1:${port}` };
}

/** Every path under `dir` (but the stubs' log) with its bytes' digest. */
function tree(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (p.endsWith("stub.log")) continue;
      if (e.isDirectory()) {
        out[`${path.relative(dir, p)}/`] = "dir";
        walk(p);
      } else out[path.relative(dir, p)] = e.isFile() ? crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex") : "other";
    }
  };
  walk(dir);
  return out;
}

test("missingValue: per command, before a lone --, a value that is another option", () => {
  assert.equal(missingValue("ui", ["--port"]), "--port");
  assert.equal(missingValue("ui", ["--port", "--open"]), "--port");
  assert.equal(missingValue("ui", ["--port", "0"]), null);
  assert.equal(missingValue("grants", ["allow", "*", "--until"]), "--until");
  assert.equal(missingValue("local-relay", ["install", "--port"]), "--port");
  // --purge takes an id in relay apps, nothing in local-relay uninstall.
  assert.equal(missingValue("relay", ["apps", "--purge"]), "--purge");
  assert.equal(missingValue("local-relay", ["uninstall", "--purge"]), null);
  assert.equal(missingValue("relay", ["admin", "revocations", "--since"]), "--since");
  assert.equal(missingValue("relay", ["admin", "status", "--json"]), null);
  assert.equal(missingValue("relay", ["--host", "127.0.0.1", "--port"]), "--port");
  // After a lone "--" come another program's arguments.
  assert.equal(missingValue("tmux", ["me", "--", "codex", "--port"]), null);
  assert.equal(missingValue("members", ["list", "--", "--members"]), null);
  // Commands that check their own arguments.
  assert.equal(missingValue("send", ["--ttl"]), null);
  // An empty value is no value (the default port is never chosen for it).
  assert.equal(missingValue("relay", ["--host", "127.0.0.1", "--port", ""]), "--port");
  assert.equal(missingValue("mcp-http", ["--port", ""]), "--port");
  assert.equal(missingValue("members", ["link", "a", "--issuer", "https://i", "--subject="]), "--subject");
  // A subject is opaque: "-sub" is a value, and one that starts with "--" is written --subject=<value>.
  assert.equal(missingValue("members", ["link", "a", "--issuer", "https://i", "--subject", "-sub"]), null);
  assert.equal(missingValue("members", ["link", "a", "--issuer", "https://i", "--subject=--host"]), null);
  assert.equal(missingValue("members", ["link", "a", "--issuer", "https://i", "--subject", "--host"]), "--subject");
  assert.equal(missingValue("grants", ["allow", "*", "--until", "--yes"]), "--until");
  assert.equal(unknownFlag("members", ["link", "a", "--subject=--host"]), null);
  assert.equal(unknownFlag("mcp-hosted", ["--experimental", "link", "--subject=--x"]), null);
  assert.equal(unknownFlag("members", ["list", "--yes=1"]), "--yes=1");
  assert.equal(unknownFlag("grants", ["--subject=x"]), "--subject=x");
});

test("members link: --subject=<value> takes a subject that starts with \"--\"; -sub is a value too", async (t) => {
  const s = await sandbox(t);
  const file = path.join(s.root, "m.json");
  fs.writeFileSync(file, JSON.stringify({ members: [] }), { mode: 0o600 });
  assert.equal(s.run(["members", "add", "alice", "--members", file]).status, 0);
  for (const [flag, subject] of [[["--subject=--host"], "--host"], [["--subject", "-sub"], "-sub"]]) {
    const r = s.run(["members", "link", "alice", "--issuer", "https://127.0.0.1", ...flag, "--members", file]);
    assert.equal(r.status, 0, `${flag.join(" ")}: ${r.stderr}`);
    assert.ok(JSON.stringify(JSON.parse(fs.readFileSync(file, "utf8"))).includes(JSON.stringify(subject)), `${subject} is stored`);
  }
  const r = s.run(["members", "link", "alice", "--issuer", "https://127.0.0.1", "--subject", "--host", "--members", file]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--subject needs a value/);
});

test("an option without its value is refused (exit 2) and nothing runs or changes", async (t) => {
  const s = await sandbox(t);
  const before = tree(s.root);
  const relay = { HOPTELL_RELAY: s.relayUrl, HOPTELL_TOKEN: "t".repeat(32) };
  for (const [args, extra] of [
    [["local-relay", "install", "--port"], {}],
    [["grants", "allow", "*", "--until"], relay],
    // HOPTELL_PORT stays set, so even a regression never reaches the default port 7777.
    [["relay", "--host", "127.0.0.1", "--port"], { ...relay, HOPTELL_PORT: String(s.port) }],
    [["ui", "--port"], {}],
    [["relay", "apps", "--retire"], {}],
    [["relay", "admin", "revocations", "--since"], {}],
    [["members", "list", "--members", path.join(s.root, "m.json"), "--state-dir"], {}],
    [["list", "--relay"], relay],
    [["login", "--mode"], relay],
    [["contacts", "allow", "q_1", "--rev", "--policy-rev", "1"], {}],
    [["mcp-http", "--port"], {}],
    [["telegram", "setup", "--relay"], {}],
  ]) {
    const r = s.run(args, extra);
    assert.equal(r.status, 2, `${args.join(" ")}: exit ${r.status} ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /^hoptell: --[a-z-]+ needs a value \(see hoptell [a-z -]+--help\); nothing was done/, args.join(" "));
  }
  for (const args of [["send", "--ttl"], ["send", "--relay"], ["send", "--reply-to"], ["send", "--relay", "", "bob", "hi"]]) {
    const r = s.run(args, relay);
    assert.equal(r.status, 2, args.join(" "));
    assert.match(r.stderr, /^hoptell: --[a-z-]+ needs a value \(see hoptell send --help\); nothing was sent/);
  }
  assert.deepEqual(tree(s.root), before, "nothing changed");
  assert.equal(fs.existsSync(path.join(s.root, "stub.log")), false, "no service manager was called");
});

test("relay: a refused start creates and locks no state directory, and never says it listens", async (t) => {
  const s = await sandbox(t);
  const token = { HOPTELL_TOKEN: "t".repeat(32) };
  const base = ["relay", "--host", "127.0.0.1", "--port", String(s.port)];
  for (const [args, extra, msg] of [
    [["relay", "--port", String(s.port)], token, /relay host is required/],
    [base, {}, /set HOPTELL_TOKEN \(shared secret\) or HOPTELL_MEMBERS/],
    [base, { HOPTELL_TOKEN: "short" }, /shorter than 16 characters/],
    [[...base, "--require-members"], token, /--require-members is set/],
    [[...base, "--members", path.join(s.root, "none.json")], {}, /none\.json/],
    [[...base, "--policy", path.join(s.root, "none.json")], token, /none\.json/],
    [[...base, "--oidc", path.join(s.root, "none.json")], token, /none\.json/],
    [[...base, "--realm-name", "bad name!"], token, /invalid --realm-name/],
    [[...base, "--wal-soft-limit", "lots"], token, /invalid --wal-soft-limit/],
    [[...base, "--wal-soft-limit", "1GiB", "--wal-hard-limit", "512MiB"], token, /--wal-soft-limit must not be above --wal-hard-limit/],
    [[...base, "--wal-soft-limit", "600MiB"], token, /--wal-soft-limit must not be above the hard limit \(512MiB unless/],
    [[...base, "--wal-hard-limit", "1MiB"], token, /--wal-hard-limit must not be below the soft limit \(256MiB unless/],
    [[...base, "--wal-hard-limit", "0"], token, /--wal-hard-limit must not be below the soft limit/],
    [base, { ...token, HOPTELL_WAL_HARD_LIMIT: "1MiB" }, /--wal-hard-limit must not be below the soft limit/],
    [[...base, "--transfer-quota", "lots"], token, /invalid --transfer-quota/],
    [[...base, "--metrics-port", "abc"], token, /invalid --metrics-port/],
    [base, { ...token, HOPTELL_REALM_ID: "xyz" }, /HOPTELL_REALM_ID must be 32 lowercase hex characters/],
  ]) {
    const r = s.run(args, extra);
    assert.notEqual(r.status, 0, `${args.join(" ")}: ${r.stdout}`);
    assert.match(r.stderr, msg, args.join(" "));
    assert.doesNotMatch(r.stdout, /listening/, args.join(" "));
    assert.equal(fs.existsSync(s.env.HOPTELL_STATE_DIR), false, `${args.join(" ")} created the state directory`);
  }
});

test("relay: transfer quotas without --experimental-e2ee are checked, then noted as ignored; a hard WAL limit alone above the soft default starts", async (t) => {
  const s = await sandbox(t);
  const short = fs.mkdtempSync(path.join(os.platform() === "win32" ? os.tmpdir() : "/tmp", "hto-")); // an admin socket path within 103 bytes
  const p = spawn(process.execPath, [BIN, "relay", "--host", "127.0.0.1", "--port", String(s.port), "--transfer-quota", "2GiB", "--wal-hard-limit", "1GiB"], { env: { ...s.env, HOPTELL_TOKEN: "t".repeat(32), HOPTELL_STATE_DIR: short } });
  const closed = new Promise((resolve) => p.on("close", resolve));
  let out = "";
  let timer;
  try {
    await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`no start: ${out}`)), 10_000);
      p.stdout.on("data", (b) => {
        out += b;
        if (/listening on/.test(out)) resolve();
      });
      p.stderr.on("data", (b) => (out += b));
      p.on("exit", () => reject(new Error(`exited: ${out}`)));
    });
    assert.match(out, /the transfer quotas apply only with --experimental-e2ee; they are ignored/);
  } finally {
    // The relay is stopped, and has exited, before its state directory is removed.
    clearTimeout(timer);
    if (p.exitCode === null && p.signalCode === null) p.kill("SIGKILL");
    await closed;
    fs.rmSync(short, { recursive: true, force: true });
  }
});

test("ports: a clear refusal, never Node's own error", async (t) => {
  const s = await sandbox(t);
  for (const v of ["abc", "70000", "-1", "1.5"]) {
    const r = s.run(["mcp-http", "--port", v]);
    assert.equal(r.status, 2, `mcp-http --port ${v}: ${r.stderr}`);
    assert.match(r.stderr, /^hoptell: invalid --port: a port number from 0 to 65535/);
  }
  // relay admin ui, on a relay state directory (its usage errors exit 1, as every admin usage error).
  const members = path.join(s.root, "members.json");
  assert.equal(s.run(["members", "add", "a", "--members", members]).status, 0);
  for (const v of ["abc", "99999"]) {
    const r = s.run(["relay", "admin", "ui", "--port", v]);
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /invalid --port: a port number from 0 to 65535/);
    assert.doesNotMatch(r.stderr, /options\.port|ERR_/);
  }
});

test("wait and listen: seconds must be a whole number from 1 to 2147483", async (t) => {
  const s = await sandbox(t);
  const relay = { HOPTELL_RELAY: s.relayUrl, HOPTELL_TOKEN: "t".repeat(32) };
  const before = tree(s.root);
  for (const v of ["abc", "0", "-5", "1.5", "2147484", "99999999999"]) {
    const w = s.run(["wait", v], relay);
    assert.equal(w.status, 2, `wait ${v}: ${w.stderr}`);
    assert.match(w.stderr, /invalid seconds .*a whole number from 1 to 2147483/);
    const l = s.run(["listen", "foo", v]);
    assert.equal(l.status, 2, `listen ${v}: ${l.stderr}`);
    assert.match(l.stderr, /invalid seconds/);
  }
  assert.equal(s.run(["wait", "1", "2"], relay).status, 2);
  assert.equal(s.run(["listen", "foo", "1", "2"]).status, 2);
  assert.deepEqual(tree(s.root), before);
  const ok = s.run(["listen", "foo", "1"]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /No messages within 1s/);
});

test("login: options are checked before the home or the relay is touched", async (t) => {
  const s = await sandbox(t);
  const relay = { HOPTELL_RELAY: s.relayUrl };
  const secret = path.join(s.root, "secret");
  fs.writeFileSync(secret, "x");
  const before = tree(s.root);
  for (const [args, msg] of [
    [["--mode", "both"], /--mode must be broker or resource/],
    [["--store", "keychain"], /--store takes only file/],
    [["--client-credentials"], /--client-credentials needs --client-id <id> and --client-secret-file <file>/],
    [["--client-credentials", "--client-id", "x"], /--client-credentials needs/],
    [["--device", "--client-credentials", "--client-id", "x", "--client-secret-file", secret], /use --device or --client-credentials, not both/],
    [["--client-id", "x"], /--client-id and --client-secret-file go with --client-credentials/],
    [["now"], /usage: hoptell login/],
  ]) {
    const r = s.run(["login", ...args], relay);
    assert.equal(r.status, 2, `${args.join(" ")}: ${r.stderr}`);
    assert.match(r.stderr, msg, args.join(" "));
  }
  assert.deepEqual(tree(s.root), before, "no contacts, no credential");
});

test("login: a relay without sign-in (it answers 426) is said to offer none", async (t) => {
  const srv = http.createServer((_req, res) => res.writeHead(426).end("hoptell relay: connect with a hoptell client (WebSocket)\n"));
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  t.after(() => srv.close());
  await assert.rejects(relayDiscovery(`ws://127.0.0.1:${srv.address().port}`), /this relay does not offer sign-in with an identity provider/);
});

test("usage errors and a missing HOPTELL_RELAY create no contacts in a new home", async (t) => {
  const s = await sandbox(t);
  const before = tree(s.root);
  for (const [args, code] of [
    [["contacts", "show"], 2],
    [["contacts", "allow", "q_1"], 2],
    [["contacts", "allow", "q_1", "--rev", "a", "--policy-rev", "1"], 2],
    [["contacts", "block", "q_1", "--rev", "1"], 2],
    [["contacts", "revoke", "g_1"], 2],
    [["contacts", "check", "r1"], 2],
    [["contacts", "frob"], 2],
    [["contacts", "verify", "m_x"], 2],
    [["contacts", "encryption", "m_x", "required"], 2],
    [["list"], 1],
    [["send", "bob", "hi"], 1],
    [["grants"], 1],
    [["wait", "1"], 1],
    [["login"], 1],
  ]) {
    const r = s.run(args);
    assert.equal(r.status, code, `${args.join(" ")}: ${r.stderr}`);
    if (code === 1) assert.match(r.stderr, /HOPTELL_RELAY is not set/, args.join(" "));
    assert.deepEqual(tree(s.root), before, args.join(" "));
  }
  assert.deepEqual(tree(s.root), before);
  // A real command still classifies the new home (its contacts are managed from the start).
  const r = s.run(["contacts"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /managed \(default: ask/);
});

test("mcp-http client: an invalid --name is refused; removing from a home without clients says so", async (t) => {
  const s = await sandbox(t);
  const before = tree(s.root);
  const bad = s.run(["mcp-http", "client", "add", "c1", "--name", "bad name"]);
  assert.equal(bad.status, 1, bad.stderr);
  assert.match(bad.stderr, /invalid --name "bad name"/);
  const rm = s.run(["mcp-http", "client", "remove", "zz"]);
  assert.equal(rm.status, 1);
  assert.match(rm.stderr, /^hoptell: no client "zz"$/m);
  assert.deepEqual(tree(s.root), before);
  const ok = s.run(["mcp-http", "client", "add", "c1", "--name", "alice-x"]);
  assert.equal(ok.status, 0, ok.stderr);
  // The token on a line of its own, as members add shows one.
  assert.match(ok.stdout, /^Client "c1" added\.\nToken, shown only now:\n\n {2}[A-Za-z0-9_-]{43}\n\n/);
  assert.match(s.run(["mcp-http", "client", "list"]).stdout, /c1 {2}name alice-x/);
});

test("telegram: a word or option a subcommand does not take is refused (exit 2)", async (t) => {
  const s = await sandbox(t);
  const errs = [];
  const deps = { home: s.env.HOPTELL_HOME, env: {}, homedir: s.env.HOME, out: () => {}, err: (l) => errs.push(l), stdin: "" };
  for (const argv of [["pair", "--all"], ["status", "extra"], ["run", "now"], ["sessions", "x"], ["unpair", "x"], ["key", "next", "x"], ["setup", "x"]]) {
    errs.length = 0;
    assert.equal(await telegramCommand(argv, deps), 2, argv.join(" "));
    assert.match(errs.join("\n"), /usage:/, argv.join(" "));
  }
  assert.equal(await telegramCommand(["unpair"], deps), 0);
});

test("local-relay: --port goes with install, --purge with uninstall; nothing else is taken", async (t) => {
  const s = await sandbox(t);
  const before = tree(s.root);
  for (const args of [["status", "--purge"], ["start", "--port", "7800"], ["status", "extra"], ["uninstall", "now"], ["frob"]]) {
    const r = s.run(["local-relay", ...args]);
    assert.equal(r.status, 2, `${args.join(" ")}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /usage: hoptell local-relay install/);
  }
  assert.deepEqual(tree(s.root), before);
  assert.equal(s.run(["local-relay", "uninstall", "--purge"]).status, 0);
  assert.equal(fs.existsSync(path.join(s.root, "stub.log")), false);
});

test("hook-header --help prints its help and creates nothing; without it the header", async (t) => {
  const s = await sandbox(t);
  const before = tree(s.root);
  const r = s.run(["hook-header", "--help"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /hoptell hook-header/);
  assert.deepEqual(tree(s.root), before);
  const h = s.run(["hook-header"]);
  assert.equal(h.status, 0);
  assert.equal(h.stdout.trim(), "{}");
});

test("refused before anything is opened: peer settings, grants usage, member names, mcp --home alone", async (t) => {
  const s = await sandbox(t);
  const relay = { HOPTELL_RELAY: s.relayUrl, HOPTELL_TOKEN: "t".repeat(32) };
  const before = tree(s.root);
  for (const [args, extra, code, msg] of [
    [["list"], { ...relay, HOPTELL_AUTH: "invalid" }, 1, /HOPTELL_AUTH must be token or login/],
    [["wait", "1"], { ...relay, HOPTELL_PROTOCOL: "7" }, 1, /HOPTELL_PROTOCOL/],
    [["wait", "1"], { ...relay, HOPTELL_ROLES: "Bad Role" }, 1, /role/],
    [["send", "bob", "hi"], { ...relay, HOPTELL_NAME: "-bad" }, 1, /HOPTELL_NAME/],
    [["grants", "allow", "*", "--until", "-1"], relay, 2, /--until needs a number of seconds/],
    [["grants", "default", "wat"], relay, 2, /usage: hoptell grants/],
    [["grants", "frob"], relay, 2, /usage: hoptell grants/],
    [["grants", "default", "deny", "--yes"], relay, 2, /--yes needs --rev/],
    [["members", "add", "bad name", "--members", path.join(s.root, "m.json")], {}, 1, /invalid member name "bad name"/],
    [["mcp", "--home", "relative"], {}, 2, /usage: hoptell mcp/],
    [["list"], { ...relay, HOPTELL_RELAY: "invalid URL" }, 1, /HOPTELL_RELAY is not a URL/],
    [["list"], { ...relay, HOPTELL_PROFILE: "bad profile" }, 1, /HOPTELL_PROFILE must be 1 to 64 letters, digits, "\.", "_" or "-", starting with a letter or digit/],
    [["login"], { ...relay, HOPTELL_PROFILE: "bad profile" }, 1, /HOPTELL_PROFILE must be 1 to 64 letters, digits, "\.", "_" or "-", starting with a letter or digit/],
    [["login"], { ...relay, HOPTELL_RELAY: "invalid URL" }, 1, /HOPTELL_RELAY is not a URL/],
    // A URL the client cannot connect to, or sign in through (no TLS, not loopback).
    [["list"], { ...relay, HOPTELL_RELAY: s.relayUrl.replace("ws:", "ftp:") }, 1, /must start with ws:\/\/, wss:\/\/, http:\/\/ or https:\/\//],
    [["list"], { ...relay, HOPTELL_RELAY: `${s.relayUrl}/#x` }, 1, /must not contain a fragment/],
    [["list"], { ...relay, HOPTELL_RELAY: "ws+unix://127.0.0.1" }, 1, /names no socket path/],
    [["login"], { ...relay, HOPTELL_RELAY: s.relayUrl.replace("ws:", "ftp:") }, 1, /must start with ws:\/\//],
    [["login"], { ...relay, HOPTELL_RELAY: `ws://192.0.2.10:${s.port}` }, 1, /signing in needs a wss:\/\/ relay URL/],
    // contacts verify: the confirmation's method and code are checked before the contacts are opened.
    [["contacts", "verify", "m_x", "--yes", "--how", "invalid", "--set", "c"], { ...relay, HOPTELL_EXPERIMENTAL_E2EE: "1" }, 1, /--how in-person or --how out-of-band/],
    [["contacts", "verify", "m_x", "--how", "invalid"], { HOPTELL_EXPERIMENTAL_E2EE: "1" }, 1, /--how in-person or --how out-of-band/],
    [["contacts", "verify", "m_x", "--yes"], { ...relay, HOPTELL_EXPERIMENTAL_E2EE: "1" }, 1, /--yes needs --how in-person\|out-of-band and --set <code>/],
    // With device keys on, the subcommands' own usage is checked first too.
    [["contacts", "encryption", "--default", "invalid"], { ...relay, HOPTELL_EXPERIMENTAL_E2EE: "1" }, 2, /usage: hoptell contacts encryption/],
    [["contacts", "verify"], { ...relay, HOPTELL_EXPERIMENTAL_E2EE: "1" }, 2, /usage: hoptell contacts verify/],
    [["contacts", "accept-device", "m_x", "--set", "12"], { ...relay, HOPTELL_EXPERIMENTAL_E2EE: "1" }, 2, /usage: hoptell contacts accept-device/],
    [["contacts", "forget-device", "m_x"], { ...relay, HOPTELL_EXPERIMENTAL_E2EE: "1" }, 2, /usage: hoptell contacts forget-device/],
  ]) {
    const r = s.run(args, extra);
    assert.equal(r.status, code, `${args.join(" ")}: ${r.stderr}`);
    assert.match(r.stderr, msg, args.join(" "));
    assert.deepEqual(tree(s.root), before, args.join(" "));
  }
});

test("relay admin backup --pages: a value that is not a number is refused before the relay is asked", async (t) => {
  const { adminCommand } = await import("../lib/admincli.js");
  const s = await sandbox(t);
  for (const v of ["wat", "8", "1.5"]) {
    await assert.rejects(adminCommand({ args: ["backup", path.join(s.root, "out"), "--pages", v], stateDir: path.join(s.root, "nowhere"), config: {}, out: () => {} }), /--pages must be a whole number of at least 16/);
  }
  assert.equal(fs.existsSync(path.join(s.root, "out")), false);
  assert.equal(fs.existsSync(path.join(s.root, "nowhere")), false);
});
