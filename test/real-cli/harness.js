// The real-CLI adapter gate tests (design 7.1, "Adapter gates"): shared setup. These tests are
// outside `npm test` (its glob is test/*.test.js) and run only through `npm run test:real-cli`
// with HOPTELL_REAL_CLI naming the CLI; without it every file fails instead of passing.
// Everything is temporary: the hoptell home, the relay (a test relay, never the user's), the home
// folder of the agent and, for Codex, a CODEX_HOME holding only a copy of the auth file. A Codex
// trace (it holds auth material) is read only on a pipe, by catalog-tap.mjs, and never stored.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { BIN } from "../../lib/config.js";
import { RelayClient } from "../../lib/client.js";
import { agentsPaths, readProfile, withAgentsLock, writeApproved } from "../../lib/agents.js";
import { cliDigest, gateShape, nativeDigest } from "../../lib/agentadapters.js";
import { ENDED, readRun, signalChecked } from "../../lib/agentruns.js";
import { sameIdentity } from "../../lib/host.js";
import { agentsWorld, profileDoc, writeProfile } from "../agents-helpers.js";
import { sleep } from "../helpers.js";
import { deviceRelay } from "../mls-helpers.js";

export const DECOY = fileURLToPath(new URL("./decoy-mcp.mjs", import.meta.url));

/** The opt-in: HOPTELL_REAL_CLI must name this CLI, or the file fails (never a vacuous pass). */
export function requireRealCli(cli) {
  const flag = process.env.HOPTELL_REAL_CLI ?? "";
  if (!flag.split(",").includes(cli)) throw new Error(`real-CLI gate tests for ${cli} run only with HOPTELL_REAL_CLI=${cli} (npm run test:real-cli)`);
}

/** The real CLI on PATH: {command, version}. */
export function realCli(name) {
  const command = execFileSync("/bin/sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).trim();
  const version = (execFileSync(command, ["--version"], { encoding: "utf8" }).match(/\d+\.\d+\.\d+[\w.-]*/) ?? [null])[0];
  return { command, version };
}

/**
 * A gates table in which only `cli`/`mode` passes, for the binary under test (the gate run): the
 * approved gate profile's command as it is now (the real CLI, or the tap in front of it), its
 * launcher and native binary digests as a spawn computes them, and the profile's argument shape.
 */
export function gatesUnderTest(s, cli, mode, version, { headlessModes = null } = {}) {
  const profile = readProfile(s.w.home, "gate", { homedir: s.w.homedir }).profile;
  const launcher = cliDigest(profile.command).digest;
  const native = nativeDigest(s.w.home, cli, profile.command).digest ?? null;
  const entry = (p) => ({ passed: { binaries: [{ version, launcher, native }], shapes: [gateShape(p, mode)] }, family: version, refusal: "adapter_gate_unverified" });
  if (!headlessModes) return { [cli]: { [mode]: entry(profile) } };
  // Per Codex headless mode: each named mode passes for this profile with that mode.
  return { [cli]: { [mode]: { modes: Object.fromEntries(headlessModes.map((m) => [m, entry({ ...profile, codex: { ...profile.codex, headlessMode: m } })])) } } };
}

/**
 * A temporary home with an approved profile for `cli` whose command is the real binary, a test
 * relay with member "me", the owner's relays file and the owner's session "me-owner" (the
 * spawner, which receives the result). `env`: the spawner's environment (the run gets only its
 * allow list and the profile's env.pass).
 */
export async function realWorld(t, { cli, command, profile = {}, env = {} }) {
  let w = null;
  // Registered first, so it runs before the home is removed: a run left behind is stopped by
  // exact pid after the identity check.
  t.after(() => {
    if (!w) return;
    for (const f of fs.readdirSync(agentsPaths(w.home).runs).filter((x) => x.endsWith(".json"))) {
      const r = readRun(w.home, f.slice(0, -5));
      for (const id of [r?.agent, r?.supervisor]) if (id && id.pid !== process.pid && sameIdentity(id)) signalChecked(id, "SIGKILL", { group: true });
    }
  });
  const relay = await deviceRelay(t, { members: ["me"], devices: false });
  w = agentsWorld(t);
  const token = path.join(w.base, "me.token");
  fs.writeFileSync(token, relay.members.me.token, { mode: 0o600 });
  const relaysFile = path.join(w.base, "relays.json");
  fs.writeFileSync(relaysFile, JSON.stringify({ version: 1, relays: [{ alias: "local", url: relay.url, tokenFile: "me.token", namePrefix: "me-", installId: "i-gate" }], default: "local" }), { mode: 0o600 });
  // codex exec refuses a folder outside a Git repository (no --skip-git-repo-check is passed).
  execFileSync("git", ["init", "-q", w.work]);
  writeProfile(w.home, profileDoc(w.work, { id: "gate", cli, command, name: { prefix: "gate" }, ...profile }));
  const digest = readProfile(w.home, "gate", { homedir: w.homedir }).digest;
  await withAgentsLock(w.home, () => writeApproved(w.home, "gate", digest));
  const owner = new RelayClient({ url: relay.url, token: relay.members.me.token, name: "me-owner", mode: "peer", reconnect: false });
  const inbox = [];
  owner.on("message", (m, confirm) => {
    inbox.push(m);
    confirm();
  });
  owner.start();
  await owner.ready();
  t.after(() => owner.close());
  const ctx = {
    home: w.home,
    homedir: w.homedir,
    env: { PATH: process.env.PATH, HOME: w.homedir, ...env },
    relaysFile,
    agentsMax: 4,
    spawner: { name: "owner", roles: ["lead"], front: "stdio", client: null },
    // The spawning tools' private capability (agentTools): stop_agent stops only runs it spawned.
    caller: crypto.randomBytes(32).toString("base64url"),
    links: new Map([["local", { wireName: "me-owner", peers: () => owner.list() }]]),
    deps: { hoptell: { node: process.execPath, bin: BIN } },
  };
  return { w, relay, ctx, inbox, owner };
}

/** Wait until the run ended and its supervisor exited. */
export async function ended(home, run, ms) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(200)) {
    const r = readRun(home, run);
    if (r && ENDED.includes(r.state) && !(r.supervisor && sameIdentity(r.supervisor))) return r;
  }
  throw new Error(`run ${run} did not end in ${ms} ms: ${readRun(home, run)?.state}`);
}

/**
 * Poll the process table while `until()` is false: the processes whose arguments contain
 * `needle`, with their ancestry (pids up to 1) as seen at that moment. Read-only (ps).
 */
export async function watchProcesses(needle, until, every = 250) {
  const seen = new Map();
  while (!until()) {
    let rows = [];
    try {
      rows = execFileSync("ps", ["-axo", "pid=,ppid=,args="], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 })
        .split("\n")
        .map((l) => l.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/))
        .filter(Boolean)
        .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), args: m[3] }));
    } catch {}
    const byPid = new Map(rows.map((r) => [r.pid, r]));
    for (const r of rows) {
      if (!r.args.includes(needle) || seen.has(r.pid)) continue;
      const ancestry = [];
      for (let p = r.ppid, i = 0; p > 1 && i < 30; i++) {
        ancestry.push(p);
        p = byPid.get(p)?.ppid ?? 0;
      }
      seen.set(r.pid, { ...r, ancestry });
    }
    await sleep(every);
  }
  return [...seen.values()];
}

/** The JSON lines of a run's captured stdout (a CLI's --json event stream). */
export function jsonLines(file) {
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .filter((l) => l.startsWith("{"))
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

/** Every object nested in `v` (events carry their items at different depths across versions). */
export function* objects(v) {
  if (!v || typeof v !== "object") return;
  yield v;
  for (const x of Object.values(v)) yield* objects(x);
}

/**
 * Where a gate run's evidence goes (the event streams and run logs, never an environment or an
 * auth file): $HOPTELL_GATE_EVIDENCE/<name>, or a new temporary folder. Printed by the tests.
 */
export function evidenceDir(name) {
  const base = process.env.HOPTELL_GATE_EVIDENCE || fs.mkdtempSync(path.join(os.tmpdir(), "hoptell-gate-evidence-"));
  const dir = path.join(base, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
