// A private relay on this machine for one's own agent sessions (`hoptell local-relay`), run as a
// user service (macOS LaunchAgent, Linux systemd user unit). Loopback only; members only, with one
// member whose token is readable by this account alone: other local accounts can reach the port,
// but not sign in.
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { BIN, ensurePrivateDir, envAuth } from "./config.js";
import { withLock, writeRecord, writeText } from "./locks.js";
import { newMemberId, validateMembers } from "./relay.js";

export const LABEL = "io.github.eminuzun.hoptell.local-relay"; // this feature's own service, never another
export const UNIT = "hoptell-local-relay.service";
export const DEFAULT_PORT = 7788;

const defaultRun = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 15_000 });
  return { status: r.error ? -1 : r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};

/** Where the local relay keeps its files (under the hoptell home). */
export function localRelayPaths(home) {
  const dir = path.join(home, "local-relay");
  return { dir, members: path.join(dir, "members.json"), token: path.join(dir, "token"), state: path.join(dir, "state"), meta: path.join(dir, "local-relay.json"), log: path.join(dir, "relay.log"), env: path.join(dir, "relay.env") };
}

/** The service definition for this platform: {path, content}, or null where none is supported. */
export function serviceFile({ platform, homedir, node, bin, port, paths }) {
  const args = [node, bin, "relay", "--host", "127.0.0.1", "--port", String(port), "--members", paths.members, "--require-members", "--state-dir", paths.state];
  if (platform === "darwin") {
    const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const content = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    <string>${esc(a)}</string>`).join("\n")}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOPTELL_ENV</key><string>${esc(paths.env)}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${esc(paths.log)}</string>
  <key>StandardErrorPath</key><string>${esc(paths.log)}</string>
</dict>
</plist>
`;
    return { path: path.join(homedir, "Library", "LaunchAgents", `${LABEL}.plist`), content };
  }
  if (platform === "linux") {
    // systemd quoting: each argument in double quotes, with \ and " escaped.
    const q = (s) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
    const content = `[Unit]
Description=hoptell private local relay (loopback only)

[Service]
Environment=${q(`HOPTELL_ENV=${paths.env}`)}
ExecStart=${args.map(q).join(" ")}
Restart=on-failure

[Install]
WantedBy=default.target
`;
    return { path: path.join(homedir, ".config", "systemd", "user", UNIT), content };
  }
  return null;
}


const firstLine = (r) => (r.stderr || r.stdout).trim().split("\n")[0] || `exit ${r.status}`;

/**
 * The service manager commands of this platform. `run(cmd, args)` is injectable for tests;
 * only this feature's own label/unit is ever addressed. `state()` is "loaded", "absent" (known
 * not to run) or "unknown" (the manager could not tell: nothing may be removed on that basis).
 * `pid()` is the running instance's process id, or null.
 */
function manager({ platform, uid, run, file }) {
  const must = (r, what) => {
    if (r.status !== 0) throw new Error(`${what} failed (${firstLine(r)})`);
    return r;
  };
  // Removal goes on only once the job is known to be gone.
  const gone = (state, r) => {
    const st = state();
    if (st === "loaded") throw new Error(`the service could not be stopped (${firstLine(r)})`);
    if (st !== "absent") throw new Error(`the service manager could not confirm that the service stopped (${firstLine(r)})`);
  };
  if (platform === "darwin") {
    const target = `gui/${uid}/${LABEL}`;
    const state = () => {
      const r = run("launchctl", ["print", target]);
      if (r.status === 0) return "loaded";
      return r.status === 113 || /could not find service/i.test(r.stderr) ? "absent" : "unknown";
    };
    // Stopping unloads the job (KeepAlive would relaunch a killed one); the file stays in
    // LaunchAgents, so it is loaded again at the next login.
    const unload = () => gone(state, run("launchctl", ["bootout", target]));
    return {
      state,
      loaded: () => state() === "loaded",
      pid: () => {
        const r = run("launchctl", ["print", target]);
        const m = r.status === 0 && /^\s*pid = (\d+)\s*$/m.exec(r.stdout);
        return m ? Number(m[1]) : null;
      },
      install: () => {
        if (state() !== "absent") unload(); // the previous installation's instance
        must(run("launchctl", ["bootstrap", `gui/${uid}`, file]), "loading the service");
      },
      start: () => (state() === "loaded" ? must(run("launchctl", ["kickstart", target]), "start") : must(run("launchctl", ["bootstrap", `gui/${uid}`, file]), "start")),
      stop: unload,
      remove: unload,
      removed: () => {},
    };
  }
  const state = () => {
    const r = run("systemctl", ["--user", "is-active", UNIT]);
    const word = r.stdout.trim();
    if (["active", "activating", "deactivating", "reloading", "refreshing"].includes(word)) return "loaded";
    return ["inactive", "failed"].includes(word) ? "absent" : "unknown"; // a missing unit is "inactive"
  };
  return {
    state,
    loaded: () => state() === "loaded",
    pid: () => {
      const r = run("systemctl", ["--user", "show", "-p", "MainPID", "--value", UNIT]);
      const n = r.status === 0 ? Number(r.stdout.trim()) : 0;
      return Number.isInteger(n) && n > 0 ? n : null;
    },
    install: () => {
      must(run("systemctl", ["--user", "daemon-reload"]), "reloading the user services");
      must(run("systemctl", ["--user", "enable", UNIT]), "enabling the service");
      must(run("systemctl", ["--user", "restart", UNIT]), "starting the service"); // a running instance is replaced
    },
    start: () => must(run("systemctl", ["--user", "start", UNIT]), "start"),
    stop: () => gone(state, run("systemctl", ["--user", "stop", UNIT])),
    remove: () => gone(state, run("systemctl", ["--user", "disable", "--now", UNIT])),
    removed: () => must(run("systemctl", ["--user", "daemon-reload"]), "reloading the user services"), // after its unit file is gone
  };
}

/** Where the service's output goes: a file on macOS, the user journal on Linux (the unit sets no log file). */
const logHint = (c) => (c.platform === "linux" ? `check its log with journalctl --user -u ${UNIT}` : `see ${c.paths.log}`);

const context = (o = {}) => {
  const platform = o.platform ?? process.platform;
  const homedir = o.homedir ?? null; // needed only to place a new service file (install)
  const uid = o.uid ?? process.getuid?.() ?? 0;
  return { ...o, platform, homedir, uid, run: o.run ?? defaultRun, paths: localRelayPaths(o.home) };
};

/** Install, start/stop and uninstall run one at a time (the lock is outside the purged directory). */
const serialized = (c, fn) => {
  ensurePrivateDir(c.home);
  return withLock(c.paths.dir, fn, { waitMs: 60_000 });
};

const readMeta = (paths) => {
  try {
    return JSON.parse(fs.readFileSync(paths.meta, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw new Error(`${paths.meta} cannot be read; run hoptell local-relay install again`);
  }
};

const sha256 = (t) => `sha256:${crypto.createHash("sha256").update(t).digest("hex")}`;
const used = (dir) => {
  try {
    return fs.readdirSync(dir).length > 0;
  } catch {
    return false;
  }
};

/**
 * The relay's one member and its token, created once and then only recovered, never replaced.
 * The token (the secret, which its stored hash cannot give back) is written durably first, then
 * the members file from it; an install interrupted between the two is completed from the token.
 * Anything else that is incomplete or inconsistent is left as it is, with a repair instruction.
 */
function ensureIdentity(paths) {
  const repair = `restore it, or start over with hoptell local-relay uninstall --purge (which also removes the realm state)`;
  const hasToken = fs.existsSync(paths.token);
  const hasMembers = fs.existsSync(paths.members);
  if (hasMembers && !hasToken) throw new Error(`the local relay's token file ${paths.token} is missing: ${repair}`);
  if (!hasMembers && used(paths.state)) throw new Error(`the local relay's members file ${paths.members} is missing but its realm state exists: ${repair}`);
  if (hasMembers) {
    let doc;
    try {
      doc = JSON.parse(fs.readFileSync(paths.members, "utf8"));
    } catch {
      throw new Error(`${paths.members} cannot be read: ${repair}`); // never quoted: it holds token hashes
    }
    const token = fs.readFileSync(paths.token, "utf8").trim();
    const ms = Array.isArray(doc?.members) ? doc.members : [];
    if (ms.length !== 1 || ms[0].name !== "me" || ms[0].token !== sha256(token)) throw new Error(`the local relay's members file ${paths.members} does not match its token file: ${repair}`);
    return { created: false };
  }
  let token;
  if (hasToken) token = fs.readFileSync(paths.token, "utf8").trim();
  else {
    token = crypto.randomBytes(32).toString("hex");
    writeText(paths.token, `${token}\n`, 0o600); // this account only
  }
  if (!/^[0-9a-f]{64}$/.test(token)) throw new Error(`the local relay's token file ${paths.token} is not a token: ${repair}`);
  const members = [{ name: "me", id: newMemberId(), token: sha256(token) }];
  validateMembers(members);
  writeRecord(paths.members, { members }, 2);
  return { created: !hasToken };
}

/** Whether an entry still has the fields install gave it for `url` (its alias may be renamed). */
const ownedUnchanged = (e, { url, tokenFile }) => e.url === url && e.tokenFile === tokenFile && (e.auth ?? "token") === "token" && e.tokenEnv === undefined && e.profile === undefined && (e.namePrefix ?? "me-") === "me-";

const readRelaysDoc = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw new Error(`${file} cannot be read (${e instanceof SyntaxError ? "invalid JSON" : e.code}); fix it, then run install again`);
  }
};

/** Our entry may move to `url` only when it is still as install left it at `previousUrl`. */
const checkMove = (file, mine, { url, previousUrl, tokenFile }) => {
  if (mine && mine.url !== url && !(previousUrl && ownedUnchanged(mine, { url: previousUrl, tokenFile }))) throw new Error(`the relays entry "${mine.alias}" in ${file} was changed since install, so it is not moved to ${url}; update or remove it yourself, or install again without --port`);
};

/** Before install changes anything: would the relays entry be refused? */
export function checkRelaysEntry({ file, url, previousUrl, tokenFile, installId }) {
  const doc = readRelaysDoc(file);
  if (doc && (doc.version !== 1 || !Array.isArray(doc.relays))) throw new Error(`${file} has an unknown format; fix it, then run install again`);
  checkMove(file, doc?.relays.find((r) => r.installId === installId), { url, previousUrl, tokenFile });
}

/**
 * Add this feature's entry to the relays file (design 2.1), under a lock, idempotently: an entry
 * with our installId is kept (moved to a new port only while unchanged); otherwise "local" (or
 * "local-2", ...) is added. A missing file is created (`created`; `beforeCreate()` runs first,
 * under the lock) with the current single relay
 * as "default" (its token stays in the environment: tokenEnv HOPTELL_TOKEN; its profile is kept).
 * Other entries are never changed.
 */
export async function addRelaysEntry({ file, env, url, previousUrl = null, tokenFile, installId, beforeCreate = () => {} }) {
  ensurePrivateDir(path.dirname(file));
  return withLock(file, () => {
    let doc = readRelaysDoc(file);
    const created = !doc;
    if (!doc) {
      beforeCreate(); // the caller records durably that this file is its own, before it exists
      doc = { version: 1, relays: [] };
      if (env.HOPTELL_RELAY) {
        const login = envAuth(env) === "login"; // throws for a value that is not token or login
        doc.relays.push({ alias: "default", url: env.HOPTELL_RELAY, ...(login ? { auth: "login" } : { tokenEnv: "HOPTELL_TOKEN" }), ...(env.HOPTELL_PROFILE ? { profile: env.HOPTELL_PROFILE } : {}) });
        doc.default = "default";
      }
    }
    if (doc?.version !== 1 || !Array.isArray(doc.relays)) throw new Error(`${file} has an unknown format; fix it, then run install again`);
    const mine = doc.relays.find((r) => r.installId === installId);
    checkMove(file, mine, { url, previousUrl, tokenFile });
    if (mine && mine.url === url) return { alias: mine.alias, added: false, created: false };
    if (mine) {
      mine.url = url;
      writeRecord(file, doc, 2);
      return { alias: mine.alias, added: false, moved: true, created: false };
    }
    let alias = "local";
    for (let n = 2; doc.relays.some((r) => r.alias === alias); n++) alias = `local-${n}`;
    doc.relays.push({ alias, url, tokenFile, namePrefix: "me-", installId }); // names of its one member start with "me-"
    if (!doc.default) doc.default = alias;
    writeRecord(file, doc, 2);
    return { alias, added: true, created };
  });
}

/**
 * Remove our entry: only one with our installId whose owned fields are unchanged. Anything else is
 * left in place, with a note for the user. A relays file would be left without relays (which
 * sessions refuse) only when it was ours alone: a file install created is then removed, and
 * otherwise the entry stays.
 */
export async function removeRelaysEntry({ file, installId, url, tokenFile, created = false }) {
  if (!fs.existsSync(file)) return { removed: false, note: null };
  return withLock(file, () => {
    let doc;
    try {
      doc = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      return { removed: false, note: `${file} could not be read; its local relay entry (if any) was left in place` };
    }
    const mine = (doc.relays ?? []).filter((r) => r.installId === installId);
    if (mine.length !== 1) return { removed: false, note: mine.length ? `${file} has several entries with this installation's id; they were left in place` : null };
    const e = mine[0];
    if (!ownedUnchanged(e, { url, tokenFile })) return { removed: false, note: `the relays entry "${e.alias}" was changed since install; it was left in place` };
    const rest = doc.relays.filter((r) => r !== e);
    if (!rest.length) {
      if (!created) return { removed: false, note: `the relays entry "${e.alias}" is the only relay in ${file}, which would be left empty; it was left in place (remove the file if you no longer use it)` };
      fs.rmSync(file, { force: true });
      return { removed: true, alias: e.alias, fileRemoved: true, note: null };
    }
    doc.relays = rest;
    if (doc.default === e.alias) delete doc.default;
    writeRecord(file, doc, 2);
    return { removed: true, alias: e.alias, note: null };
  });
}

/** Whether something already listens on 127.0.0.1:port. */
const portInUse = (port) =>
  new Promise((resolve) => {
    const sock = net.connect({ host: "127.0.0.1", port });
    sock.once("connect", () => (sock.destroy(), resolve(true)));
    sock.once("error", () => resolve(false));
    sock.setTimeout(1000, () => (sock.destroy(), resolve(false)));
  });

/** After starting: the relay answers and the member token signs in (send-only, no name taken). */
export async function verifyRunning(url, token, { waitMs = 10_000 } = {}) {
  const { RelayClient } = await import("./client.js");
  const end = Date.now() + waitMs;
  let last = null;
  while (Date.now() < end) {
    const c = new RelayClient({ url, token, name: null, mode: "send", reconnect: false });
    try {
      c.start();
      await c.ready(Math.min(3000, Math.max(500, end - Date.now())));
      if (c.member?.name !== "me") throw new Error("the relay answered with another member");
      return;
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 500));
    } finally {
      c.close();
    }
  }
  throw new Error(`the local relay did not accept its token in time (${last?.message ?? "no answer"})`);
}

const urlOf = (port) => `ws://127.0.0.1:${port}`;

/**
 * Install (or reinstall) the local relay: its member and token (created once, then kept), its
 * state directory and the user service, then (re)start it. An omitted port keeps the installed
 * one. Success only once a new instance runs and the token signs in. Returns {url, tokenFile,
 * service, alias, relaysFile}.
 */
export async function installLocalRelay(o) {
  const c = context(o);
  if (!c.homedir) throw new Error("installLocalRelay needs the user's home directory (homedir)");
  return serialized(c, async () => {
    const meta = readMeta(c.paths);
    const port = Number(o.port ?? meta?.port ?? DEFAULT_PORT);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("--port must be a number from 1024 to 65535");
    const svc = serviceFile({ platform: c.platform, homedir: c.homedir, node: o.node ?? process.execPath, bin: o.bin ?? BIN, port, paths: c.paths });
    if (!svc) throw new Error(`hoptell local-relay supports macOS (launchd) and Linux (systemd user services); on ${c.platform}, run hoptell relay --host 127.0.0.1 yourself`);
    const url = urlOf(port);
    const relaysFile = o.relaysFile ?? null;
    const sameFile = meta?.relaysFile === relaysFile;
    const previousUrl = sameFile ? (meta?.entry?.url ?? null) : null;
    // Refusals come before anything is changed: a port held by something else (a rerun of this
    // feature's own running service is fine), a relays entry that may not be moved.
    const m = manager({ ...c, file: svc.path });
    const ours = meta?.port === port && manager({ ...c, file: meta.service }).loaded();
    if (!ours && (await (o.portInUse ?? portInUse)(port))) throw new Error(`port ${port} on 127.0.0.1 is already in use; choose another with --port`);
    const installId = meta?.installId ?? crypto.randomBytes(12).toString("hex"); // kept across reinstalls
    if (relaysFile) checkRelaysEntry({ file: relaysFile, url, previousUrl, tokenFile: c.paths.token, installId });
    // A relays file created here records HOPTELL_RELAY with its HOPTELL_AUTH: a misspelled one is refused now.
    if (relaysFile && o.env?.HOPTELL_RELAY) envAuth(o.env);
    ensurePrivateDir(c.paths.dir);
    ensurePrivateDir(c.paths.state);
    ensureIdentity(c.paths);
    // The service reads only its own settings file, never the user's shared settings (which may
    // hold a shared token or another relay's options).
    if (!fs.existsSync(c.paths.env)) writeText(c.paths.env, "# Settings of the local relay service only (the shared hoptell settings are not read).\n", 0o600);
    fs.mkdirSync(path.dirname(svc.path), { recursive: true });
    writeText(svc.path, svc.content, 0o644);
    // `relaysCreated`: the relays file is this feature's own (install created it). Recorded before
    // the file is created, so an interruption in between cannot lose it.
    let relaysCreated = Boolean(sameFile && (meta?.relaysCreated || meta?.entry?.created));
    let current = sameFile ? (meta?.entry ?? null) : null; // the relays entry as it still is
    const record = () => writeRecord(c.paths.meta, { v: 1, installId, port, node: o.node ?? process.execPath, bin: o.bin ?? BIN, service: svc.path, relaysFile, relaysCreated, entry: current, installedAt: new Date().toISOString() });
    record();
    const before = m.loaded() ? m.pid() : null;
    try {
      m.install();
    } catch (e) {
      throw new Error(`the service could not be started: ${e.message}; ${logHint(c)}`);
    }
    await (o.verify ?? verifyRunning)(url, fs.readFileSync(c.paths.token, "utf8").trim());
    // The instance that answered is the new one: a running one was replaced, not reused.
    const after = m.pid();
    if (!after) throw new Error(`the service is not running after its start; ${logHint(c)}`);
    if (before && after === before) throw new Error(`the previous instance (pid ${before}) is still running; run hoptell local-relay install again`);
    // Sessions find it through the relays file (several relays, design 2.1).
    let entry = null;
    if (relaysFile) {
      const r = await addRelaysEntry({ file: relaysFile, env: o.env ?? {}, url, previousUrl, tokenFile: c.paths.token, installId, beforeCreate: () => ((relaysCreated = true), record()) });
      o.fault?.("relays entry written"); // tests: an interruption before the entry is recorded
      entry = current = { url, alias: r.alias, created: relaysCreated };
      record();
    }
    return { url, tokenFile: c.paths.token, service: svc.path, alias: entry?.alias ?? null, relaysFile };
  });
}

/** Start or stop the installed service. */
export async function controlLocalRelay(o, action) {
  const c = context(o);
  return serialized(c, () => {
    const meta = readMeta(c.paths);
    if (!meta) throw new Error("the local relay is not installed: run hoptell local-relay install");
    const m = manager({ ...c, file: meta.service });
    if (action === "start") m.start();
    else m.stop();
  });
}

/**
 * The state of the local relay: {installed, loaded, port, healthy, signedIn, problems[]}. Checks
 * the service, the port, that its token signs in, and that the recorded node and hoptell paths
 * still exist.
 */
export async function localRelayStatus(o) {
  const c = context(o);
  const meta = readMeta(c.paths);
  if (!meta) return { installed: false, problems: [] };
  const problems = [];
  for (const [what, p] of [["node", meta.node], ["hoptell", meta.bin]]) if (!fs.existsSync(p)) problems.push(`the recorded ${what} path ${p} no longer exists (moved by an upgrade?): run hoptell local-relay install again`);
  const hasToken = fs.existsSync(c.paths.token);
  if (!hasToken) problems.push(`the token file ${c.paths.token} is missing: run hoptell local-relay install again`);
  const loaded = manager({ ...c, file: meta.service }).loaded();
  const url = urlOf(meta.port);
  let healthy = false;
  try {
    healthy = (await (o.fetch ?? fetch)(`http://127.0.0.1:${meta.port}/healthz`, { signal: AbortSignal.timeout(2000) })).ok;
  } catch {}
  // Answering is not enough: the token must sign in as the relay's member.
  let signedIn = false;
  if (healthy && hasToken) {
    try {
      await (o.verify ?? verifyRunning)(url, fs.readFileSync(c.paths.token, "utf8").trim(), { waitMs: 3000 });
      signedIn = true;
    } catch (e) {
      problems.push(`the relay answers, but its token does not sign in (${e.message}): run hoptell local-relay install again`);
    }
  }
  return { installed: true, loaded, port: meta.port, url, tokenFile: c.paths.token, healthy, signedIn, problems };
}

/**
 * Remove the service; with `purge` also the member, token and realm state. Nothing is removed
 * while the service still runs, and the install record stays until the relays entry is handled,
 * so a failed uninstall can be run again.
 */
export async function uninstallLocalRelay(o, { purge = false } = {}) {
  const c = context(o);
  return serialized(c, async () => {
    const meta = readMeta(c.paths);
    let entry = { removed: false, note: null };
    if (meta) {
      const m = manager({ ...c, file: meta.service });
      try {
        m.remove();
      } catch (e) {
        throw new Error(`${e.message}; nothing was removed: run hoptell local-relay uninstall again`);
      }
      if (meta.relaysFile && meta.installId) entry = await removeRelaysEntry({ file: meta.relaysFile, installId: meta.installId, url: meta.entry?.url ?? urlOf(meta.port), tokenFile: c.paths.token, created: Boolean(meta.relaysCreated || meta.entry?.created) });
      fs.rmSync(meta.service, { force: true });
      try {
        m.removed();
      } catch (e) {
        throw new Error(`${e.message}; run hoptell local-relay uninstall again`); // the install record is kept
      }
    }
    if (purge) fs.rmSync(c.paths.dir, { recursive: true, force: true });
    else fs.rmSync(c.paths.meta, { force: true });
    return { removed: Boolean(meta), purged: purge, entryRemoved: entry.removed, note: entry.note };
  });
}
