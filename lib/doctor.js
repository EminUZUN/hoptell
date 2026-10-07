// `hoptell doctor`: check this machine's hoptell setup and say what to fix.
// Every line goes through redact(), so neither the token nor credentials in the
// relay URL are printed, including inside error messages.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { HOSTNAME, MAX_ROLES, NAME_RE, envFiles, loadedEnvFile, parseRoles, shellQuote, stateDir } from "./config.js";
import { RelayClient } from "./client.js";
import { tmuxVersionSupported } from "./tmux.js";
import { requestedMode } from "./delivery.js";
import { hookSessions } from "./wake.js";
import { FingerprintError, fingerprintsEnabled, loadFingerprintKey } from "./fingerprint.js";

const LOOPBACK = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/;

// Fixed text per relay close code: the relay's own reason text is never printed.
const CLOSE_CODES = {
  4001: "the relay rejected the login message (bad hello)",
  4002: "the relay refused this name or these roles (with a member token, names must be <member> or start with <member>-)",
  4003: "the relay refused the token",
  4004: "another connection took over this name",
  4005: "the relay uses a different protocol version; update hoptell on this machine or the relay",
};

// Network errors reported by name; any other word in an error is never copied out.
const NETWORK_ERRORS = ["ECONNREFUSED", "ECONNRESET", "ECONNABORTED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "ETIMEDOUT", "EPIPE"];

/** A fixed description of a failed login, built only from known codes, never from relay-supplied text. */
function loginProblem(message) {
  const text = String(message);
  const code = Number([...text.matchAll(/\((\d{4})\)/g)].at(-1)?.[1]); // the client appends the close code last
  if (CLOSE_CODES[code]) return `${CLOSE_CODES[code]} (${code})`;
  if (code >= 4000) return `the relay closed the connection (code ${code})`;
  if (/^timed out connecting/.test(text)) return "timed out after 8s without an answer from the relay";
  const errno = NETWORK_ERRORS.find((e) => new RegExp(`\\b${e}\\b`).test(text));
  return errno ? `cannot reach the relay (${errno})` : "the connection to the relay failed";
}
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

const { R_OK, W_OK, X_OK } = fs.constants;
const can = (dir, mode) => {
  try {
    fs.accessSync(dir, mode);
    return true;
  } catch {
    return false;
  }
};

/**
 * Inspect a directory without creating or changing it, the way hoptell will use it.
 * `need` is the access hoptell uses there: search to pass through, more where it writes.
 */
function inspectDir(dir, need, show) {
  let st;
  try {
    st = fs.lstatSync(dir);
  } catch (e) {
    if (e.code !== "ENOENT") return { error: show`cannot check ${dir}: ${e.code || e.message}` };
    // hoptell will create it: the nearest existing parent needs write and search access.
    let parent = path.dirname(dir);
    while (!fs.existsSync(parent) && path.dirname(parent) !== parent) parent = path.dirname(parent);
    return can(parent, W_OK | X_OK) ? { missing: true } : { error: show`cannot create ${dir}: no write access to ${parent}` };
  }
  if (st.isSymbolicLink() || !st.isDirectory()) return { error: show`${dir} is not a plain directory, so hoptell refuses to use it` };
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) return { error: show`${dir} is owned by another user, so hoptell refuses to use it` };
  if (!can(dir, need)) return { error: `missing ${need & R_OK ? "read, write or search" : need & W_OK ? "write or search" : "search"} access to ` + show`${dir}` };
  return { open: (st.mode & 0o077) !== 0 };
}

/** Print one line per check; resolves to the number of failed checks. */
export async function doctor(env = process.env, out = console.log) {
  let url = null;
  try {
    url = env.HOPTELL_RELAY ? new URL(env.HOPTELL_RELAY) : null;
  } catch {}
  // Only scheme and host are shown: a path can carry an access token too.
  const shownUrl = url ? `${url.protocol}//${url.host}/${url.pathname !== "/" && url.pathname !== "" ? "[path hidden]" : ""}` : "[relay URL]";
  // Defense in depth: login errors are already fixed text (loginProblem), but every line
  // is still scrubbed of the token and URL credentials, raw and percent-encoded.
  const secrets = [env.HOPTELL_TOKEN];
  if (url) {
    const userinfo = env.HOPTELL_RELAY.match(/^[a-z]+:\/\/([^@/]*)@/i)?.[1];
    secrets.push(userinfo, url.username, url.password, ...url.searchParams.values(), ...url.search.slice(1).split("&").map((kv) => kv.split("=").slice(1).join("=")));
    if (url.pathname !== "/") secrets.push(url.pathname, ...url.pathname.split("/"));
  }
  const variants = secrets.filter(Boolean).flatMap((s) => {
    const out = [s, encodeURIComponent(s)];
    try {
      out.push(decodeURIComponent(s));
    } catch {}
    return out;
  });
  // Relay metadata can repeat credentials of any length; scrub known credential values before displaying it.
  const credentials = [...new Set(variants)];
  const scrub = (value) => (credentials.some((c) => String(value).includes(c)) ? "[redacted]" : String(value));
  // Template tag: scrubs every interpolated value, keeps the literal text.
  const show = (parts, ...values) => parts.reduce((acc, part, i) => acc + part + (i < values.length ? scrub(values[i]) : ""), "");
  // In whole lines, values under 4 characters would blank out ordinary words; dynamic
  // relay data goes through scrub() instead, which hides any field containing one.
  const hidden = credentials.filter((s) => s.length >= 4).sort((a, b) => b.length - a.length);
  const redact = (text) => {
    let t = String(text);
    for (const s of hidden) t = t.split(s).join("[redacted]");
    return t;
  };

  let failed = 0;
  const line = (level, what, detail) => {
    if (level === "FAIL") failed++;
    out(redact(`${level.padEnd(4)}  ${what}: ${detail}`));
  };

  const major = Number(process.versions.node.split(".")[0]);
  line(major >= 20 ? "ok" : "FAIL", "Node.js", show`${process.versions.node}` + (major >= 20 ? "" : " (hoptell needs 20 or newer)"));

  if (loadedEnvFile) {
    const open = process.platform !== "win32" && fs.statSync(loadedEnvFile).mode & 0o077;
    line(open ? "warn" : "ok", "settings file", open ? show`${loadedEnvFile} has permissions for other users; run: chmod 600 ${shellQuote(loadedEnvFile)}` : show`${loadedEnvFile}`);
  } else {
    line("info", "settings file", show`none found (looked for ${envFiles().join(", ")}); using environment variables only`);
  }

  if (!env.HOPTELL_RELAY) line("FAIL", "relay URL", "HOPTELL_RELAY is not set (e.g. ws://192.0.2.10:7777)");
  else if (!url || !/^wss?:$/.test(url.protocol)) {
    line("FAIL", "relay URL", "HOPTELL_RELAY is not a ws:// or wss:// URL");
    url = null;
  } else {
    const plain = url.protocol === "ws:" && !LOOPBACK.test(url.hostname);
    line("ok", "relay URL", show`${shownUrl}` + (plain ? " (unencrypted: keep it on a LAN or VPN, or use wss://)" : ""));
  }

  line(env.HOPTELL_TOKEN ? "ok" : "FAIL", "token", env.HOPTELL_TOKEN ? "set (not shown)" : "HOPTELL_TOKEN is not set; use the relay's shared token or your member token");

  const name = env.HOPTELL_NAME || null;
  const nameOk = !name || NAME_RE.test(name);
  if (!name) line("info", "peer name", show`HOPTELL_NAME is not set: agent sessions are named ${HOSTNAME}-<process id>, CLI commands ${HOSTNAME}-cli`);
  else line(nameOk ? "ok" : "FAIL", "peer name", nameOk ? show`${name}` : show`"${name}" is invalid: use letters, digits, "_" and "-"; start with a letter or digit (max 64 characters)`);
  try {
    const roles = parseRoles(env.HOPTELL_ROLES);
    if (roles.length > MAX_ROLES) line("FAIL", "roles", `${roles.length} roles; the relay accepts at most ${MAX_ROLES}`);
    else if (roles.length) line("ok", "roles", show`${roles.join(", ")}`);
  } catch (e) {
    line("FAIL", "roles", show`${e.message}`);
  }

  const push = env.HOPTELL_PUSH;
  let requested = null;
  try {
    requested = requestedMode(push);
  } catch {
    line("FAIL", "delivery", show`HOPTELL_PUSH="${push}" is invalid: use channel, hook, tmux or listener, or leave it unset`);
  }
  if (requested === "auto") {
    line("info", "delivery", "automatic per session: channel notices when the hoptell channel is enabled, else hook notices when the hoptell hooks answer a check, else read_inbox or a background listener; hoptell tmux uses tmux notices");
  } else if (requested) line("ok", "delivery", show`HOPTELL_PUSH=${push} for sessions using these settings`);
  // Hook delivery of running Claude Code sessions on this machine (evidence, not configuration).
  const sessions = hookSessions();
  if (!sessions.length) line("info", "hook sessions", "none running with hook delivery");
  for (const h of sessions) {
    const state = !h.live ? "ended" : h.verifiedAt ? `verified at ${new Date(h.verifiedAt).toISOString()}` : "registered, not verified";
    line(h.live ? "ok" : "info", "hook sessions", show`peer ${h.peer}: ${state}${h.lastNoticeAt ? `, last notice ${new Date(h.lastNoticeAt).toISOString()}` : ""}`);
  }

  if (url) {
    const health = `${url.protocol === "wss:" ? "https:" : "http:"}//${url.host}/healthz`;
    try {
      const r = await fetch(health, { signal: AbortSignal.timeout(5000) });
      line(r.ok ? "ok" : "warn", "relay health", show`${health} returned HTTP ${r.status}`);
    } catch (e) {
      line("warn", "relay health", show`${health}: ${e.cause?.code || e.cause?.errors?.[0]?.code || e.message}`);
    }
    if (env.HOPTELL_TOKEN && nameOk) {
      // Log in send-only, which never takes over a session's name. Use the CLI identity plus
      // "-doctor" when it fits, so member-token name rules hold and the relay, which leaves
      // the caller out of its peer list, still lists a session that uses the name itself.
      const identity = name || `${HOSTNAME}-cli`;
      const as = identity.length <= 57 ? `${identity}-doctor` : identity;
      const c = new RelayClient({ url: env.HOPTELL_RELAY, token: env.HOPTELL_TOKEN, name: as, mode: "send", reconnect: false });
      try {
        c.start();
        await c.ready(8000);
        const peers = await c.list();
        line("ok", "relay login", "token and protocol version accepted");
        const online = peers.filter((p) => p.online).map((p) => scrub(p.name));
        line("ok", "peers", online.length ? `${online.length} online: ${online.join(", ")}` : "none online");
        if (name && as === name) line("info", "session", show`cannot determine whether a session is online as "${name}": this diagnostic uses the same name, which the relay omits from its peer list`);
        else if (name) {
          const me = peers.find((p) => p.name === name);
          line("info", "session", me?.online ? show`an agent session is online as "${name}"` : show`no agent session is online as "${name}" right now`);
        }
      } catch (e) {
        line("FAIL", "relay login", show`${loginProblem(e.message)}`);
      } finally {
        c.close();
      }
    }
  }

  const root = stateDir();
  const dirs = [root, path.join(root, "inbox"), ...(name && nameOk ? [path.join(root, "inbox", name)] : [])];
  let inboxNote = null;
  let open = false;
  for (const [i, dir] of dirs.entries()) {
    // Parents are only passed through. hoptell creates peer folders in inbox/ (write and
    // search) and writes and consumes message files in a peer's folder (read as well).
    const need = i < dirs.length - 1 ? X_OK : i === 2 ? R_OK | W_OK | X_OK : W_OK | X_OK;
    const r = inspectDir(dir, need, show);
    if (r.error) {
      line("FAIL", "inbox", r.error);
      inboxNote = false;
      break;
    }
    if (r.missing) {
      inboxNote = show`${dir} does not exist yet; hoptell creates it on first use`;
      break;
    }
    open ||= r.open;
  }
  if (inboxNote !== false) {
    let detail = inboxNote || show`${root}`;
    if (!inboxNote && name && nameOk) {
      try {
        const n = fs.readdirSync(dirs[2]).filter((f) => /^\d{13}-\d{8}-[0-9a-f]{8}\.json$/.test(f)).length;
        detail += show`; ${plural(n, "pending message file")} for ${name}`;
      } catch (e) {
        line("FAIL", "inbox", show`cannot read ${dirs[2]}: ${e.code || e.message}`);
        detail = null;
      }
    }
    if (detail) line(open ? "warn" : inboxNote ? "info" : "ok", "inbox", `${detail}${open ? " (open to other users; hoptell tightens it on next use)" : ""}`);
  }

  // Relay fingerprint logging, as configured in these local settings (not the running relay).
  try {
    if (!fingerprintsEnabled(env.HOPTELL_LOG_FINGERPRINTS)) line("info", "relay fingerprints", "disabled in these local settings; the running relay was not checked");
    else {
      try {
        const { id } = loadFingerprintKey(env.HOPTELL_LOG_FINGERPRINT_KEY_FILE);
        line("ok", "relay fingerprints", show`local key file is valid (id ${id}); the running relay was not checked`);
      } catch (e) {
        line("FAIL", "relay fingerprints", `local key file could not be used (${e instanceof FingerprintError ? e.code : "unreadable"})`);
      }
    }
  } catch {
    line("FAIL", "relay fingerprints", "HOPTELL_LOG_FINGERPRINTS must be on or off");
  }

  const tmux = spawnSync("tmux", ["-V"], { encoding: "utf8" });
  if (tmux.status !== 0) line("info", "tmux", "not available (required only for hoptell tmux; version 3.2 or newer)");
  else if (!tmuxVersionSupported(tmux.stdout)) line("warn", "tmux", show`${tmux.stdout.trim()} is too old for hoptell tmux (3.2 or newer)`);
  else line("ok", "tmux", show`${tmux.stdout.trim()}`);

  out(failed ? `\n${plural(failed, "check")} failed.` : "\nNo checks failed.");
  return failed;
}
