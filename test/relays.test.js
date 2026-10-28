// Several relays per engine (lib/relays.js): the relays file, addresses and routing.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { labelOf, parseAddress, readRelaysFile, routeOf } from "../lib/relays.js";

const tmp = (t) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "hoptell-relays-"));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};
const write = (file, obj, mode = 0o600) => {
  fs.writeFileSync(file, typeof obj === "string" ? obj : JSON.stringify(obj));
  fs.chmodSync(file, mode);
};

test("the relays file: tokens from files or the environment, broken entries reported, not fatal", (t) => {
  const d = tmp(t);
  write(path.join(d, "local.token"), "local-token-0123456789\n");
  write(path.join(d, "open.token"), "x", 0o644);
  const file = path.join(d, "relays.json");
  write(file, {
    version: 1,
    default: "work",
    relays: [
      { alias: "work", url: "wss://relay.example.com/", auth: "login" },
      { alias: "local", url: "ws://127.0.0.1:7788", tokenFile: "~/local.token" },
      { alias: "lab", url: "wss://lab.example.org", tokenEnv: "LAB_TOKEN", join: false, name: "alice-lab" },
      { alias: "open", url: "ws://127.0.0.1:1", tokenFile: path.join(d, "open.token") },
      { alias: "inline", url: "ws://127.0.0.1:2", token: "secret" },
      { alias: "Bad Alias", url: "ws://x" },
      { alias: "both", url: "ws://127.0.0.1:3", tokenEnv: "LAB_TOKEN", tokenFile: "x" },
      { alias: "login-tok", url: "ws://127.0.0.1:4", auth: "login", tokenEnv: "LAB_TOKEN" },
      { alias: "rel", url: "ws://127.0.0.1:5", tokenFile: "local.token", profile: "p1" },
      { alias: "prof", url: "ws://127.0.0.1:6", tokenEnv: "LAB_TOKEN", profile: "p1" },
      { alias: "nofile", url: "ws://127.0.0.1:7", tokenFile: "missing.token" },
      { alias: "http", url: "https://not-ws.example" },
    ],
  });
  const r = readRelaysFile(file, { env: { LAB_TOKEN: "lab-token" }, homedir: d });
  assert.equal(r.default, "work");
  const by = Object.fromEntries(r.relays.map((x) => [x.alias, x]));
  assert.deepEqual(Object.keys(by), ["work", "local", "lab", "open", "rel", "nofile"]);
  assert.equal(by.work.auth, "login");
  assert.equal(by.work.url, "wss://relay.example.com");
  assert.equal(by.local.token, "local-token-0123456789");
  assert.equal(by.lab.token, "lab-token");
  assert.equal(by.lab.join, false);
  assert.equal(by.lab.name, "alice-lab");
  assert.match(by.open.tokenProblem, /readable by other users/);
  const problems = Object.fromEntries(r.problems.map((p) => [p.alias, p.problem]));
  assert.match(problems.inline, /not in the relays file/);
  assert.match(problems["Bad Alias"], /lowercase/);
  assert.match(problems.both, /exactly one/);
  assert.match(problems["login-tok"], /takes no token/);
  assert.equal(by.rel.token, "local-token-0123456789", "relative to the relays file");
  assert.match(problems.prof, /already used/);
  assert.match(by.nofile.tokenProblem, /is missing/);
  assert.match(problems.http, /ws:\/\//);
  write(file, { version: 1, relays: [{ alias: "a", url: "ws://127.0.0.1:1", tokenEnv: "T" }, { alias: "a", url: "ws://127.0.0.1:2", tokenEnv: "T" }] });
  assert.throws(() => readRelaysFile(file, { env: {}, homedir: d }), /used twice/, "duplicate aliases stop everything");
  write(file, { version: 1, default: "a", relays: [{ alias: "a", url: "ws://127.0.0.1:1", tokenEnv: "T" }] });
  const unset = readRelaysFile(file, { env: {}, homedir: d });
  assert.equal(unset.default, null, "a default without a usable token: bare addresses are refused");
  write(file, { version: 1, relays: [{ alias: "a", url: "ws://127.0.0.1:1", tokenEnv: "T" }] }, 0o644);
  assert.throws(() => readRelaysFile(file, { env: {}, homedir: d }), /chmod 600/);
});

test("addresses and routing: bare names only to the default; @all and @role scoped to one relay", () => {
  assert.deepEqual(parseAddress("alice"), { kind: "peer", target: "alice", alias: null });
  assert.deepEqual(parseAddress("alice@work"), { kind: "peer", target: "alice", alias: "work" });
  assert.deepEqual(parseAddress("@reviewer@lab"), { kind: "role", target: "reviewer", alias: "lab" });
  assert.deepEqual(parseAddress("@all"), { kind: "all", target: "all", alias: null });
  for (const bad of ["", "a b", "alice@Work", "alice@work@x", "@", "alice@"]) assert.throws(() => parseAddress(bad), /not an address/, bad);
  const two = { aliases: ["work", "local"], defaultAlias: "work" };
  assert.equal(routeOf("alice", two).relay, "work");
  assert.equal(routeOf("alice@local", two).relay, "local");
  assert.throws(() => routeOf("alice@lab", two), /no relay "lab"/);
  assert.throws(() => routeOf("alice", { aliases: ["work", "local"], defaultAlias: null }), /say which relay: alice@<alias>/);
  assert.throws(() => routeOf("@all", { aliases: ["work", "local"], defaultAlias: null }), /@all@<alias>/);
  assert.equal(labelOf("alice", "work", true), "alice@work");
  assert.equal(labelOf("alice", "default", false), "alice");
});

test("doctor with a relays file: no HOPTELL_RELAY or HOPTELL_TOKEN is not a failure", (t) => {
  const d = tmp(t);
  write(path.join(d, "local.token"), "local-token-0123456789\n");
  const file = path.join(d, "relays.json");
  write(file, { version: 1, default: "local", relays: [{ alias: "local", url: "ws://127.0.0.1:1", tokenFile: path.join(d, "local.token") }] });
  // A fresh process, so no settings file loaded by another test leaks in.
  const doctorUrl = new URL("../lib/doctor.js", import.meta.url).href;
  const run = (env) => {
    const script = `const { doctor } = await import(${JSON.stringify(doctorUrl)});
      const lines = [];
      await doctor(${JSON.stringify({ HOPTELL_HOME: path.join(d, "home"), ...env })}, (l) => lines.push(l), { homedir: ${JSON.stringify(d)} });
      process.stdout.write(lines.join("\\n"));`;
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], { cwd: d, encoding: "utf8", env: { PATH: process.env.PATH, HOME: d } });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  };
  const withFile = run({ HOPTELL_RELAYS: file });
  assert.match(withFile, /info +relay URL: HOPTELL_RELAY is not set: sessions use the relays file/);
  assert.match(withFile, /info +token: HOPTELL_TOKEN is not set: each relay in the relays file has its own token/);
  assert.match(withFile, /ok +relays: local; bare names go to local/);
  assert.doesNotMatch(withFile, /FAIL +(relay URL|token):/);
  const without = run({});
  assert.match(without, /FAIL +relay URL: HOPTELL_RELAY is not set/);
  assert.match(without, /FAIL +token: HOPTELL_TOKEN is not set/);
});
