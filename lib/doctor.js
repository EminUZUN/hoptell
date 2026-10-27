// `hoptell doctor`: check this machine's hoptell setup and say what to fix.
// Every line goes through redact(), so neither the token nor credentials in the
// relay URL are printed, including inside error messages.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { HOSTNAME, MAX_ROLES, NAME_RE, NAME_RULE, envAuth, envContactsSelf, envCredentialStore, envFiles, envOwnerChannel, envSwitch, loadedEnvFile, parseRoles, shellQuote, defaultHome } from "./config.js";
import { readSettings } from "./settings.js";
import { CLOSE_TEXTS, NAME_REFUSED, RelayClient } from "./client.js";
import { profileKey, readProfile } from "./profiles.js";
import { tmuxEnv, tmuxVersionSupported } from "./tmux.js";
import { requestedMode } from "./delivery.js";
import { hookSessionLabel, hookSessions } from "./wake.js";
import { FingerprintError, fingerprintsEnabled, loadFingerprintKey } from "./fingerprint.js";
import { statusMark } from "./words.js";

const LOOPBACK = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/;

// Fixed text per relay close code: the relay's own reason text is never printed.
const CLOSE_CODES = {
  4001: CLOSE_TEXTS["4001 bad hello"],
  4002: 'the relay refused this name or these roles (4002): a member token may use its member\'s name, or a unique name that starts with that name and "-"',
  4003: "the relay refused authentication or access (4003): check this relay's token or sign-in settings",
  4004: "another connection took over this name (4004)",
  4005: CLOSE_TEXTS["4005 unsupported protocol version"],
};
const FIXED = Object.values(CLOSE_TEXTS);

// Network errors reported by name; any other word in an error is never copied out.
const NETWORK_ERRORS = ["ECONNREFUSED", "ECONNRESET", "ECONNABORTED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "ETIMEDOUT", "EPIPE"];

/** A fixed description of a failed login, built only from known codes, never from relay-supplied text. */
function loginProblem(message) {
  const text = String(message);
  const code = Number([...text.matchAll(/\((\d{4})\)/g)].at(-1)?.[1]); // the client names the close code
  // The client's own texts for the relay's known reasons (lib/client.js CLOSE_TEXTS) hold no relay words.
  const fixed = FIXED.find((t) => text === t || text.endsWith(`: ${t}`));
  if (fixed) return fixed;
  // A name, when the client's text has one, is checked as a name before it is copied.
  const asked = /the relay refused the name "([A-Za-z0-9][A-Za-z0-9_-]{0,63})" \(4002\)/.exec(text)?.[1];
  if (code === 4002 && asked) return `the relay refused the name "${asked}" (4002): ${NAME_RULE}`;
  const who = /this is member ([A-Za-z0-9][A-Za-z0-9_-]{0,63})'s token/.exec(text)?.[1];
  if (code === 4002 && text.includes(`${NAME_REFUSED}: `) && who) return `the relay refused this name: this is member ${who}'s token. Set HOPTELL_NAME to "${who}" or a unique name that starts with "${who}-" (64 characters at most) (4002)`;
  if (code === 4002 && text.includes(`${NAME_REFUSED}: `)) return `the relay refused this name: a member token may use only its member's name, or a unique name that starts with that name and "-"; a shared token may not use a hosted member's names (4002)`;
  if (CLOSE_CODES[code]) return CLOSE_CODES[code];
  if (code >= 4000) return `the relay closed the connection (code ${code})`;
  if (/^could not connect to /.test(text)) return "timed out after 8s without an answer from the relay";
  const errno = NETWORK_ERRORS.find((e) => new RegExp(`\\b${e}\\b`).test(text));
  return errno ? `cannot reach the relay (${errno})` : "the connection to the relay failed";
}
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

export { terminalMarks } from "./words.js";

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
/**
 * --relay-check: deliver one test message from the send-only login to a temporary receiver,
 * "<identity>-check-<random>" (member name rules accept the suffix), and time the confirmed delivery.
 */
export async function roundTrip(sender, identity, line, show = String.raw, { receiveMs = 10_000 } = {}) {
  // A random suffix: the test receiver must never take over a real session's name.
  const rxName = `${identity}-check-${crypto.randomBytes(3).toString("hex")}`;
  if (rxName.length > 64) return line("info", "relay check", show`skipped: "${identity}" is too long for a test receiver name`);
  const rx = new RelayClient({ url: sender.url, token: sender.token, name: rxName, reconnect: false });
  let timer = null;
  try {
    const started = Date.now();
    let arrived;
    const got = new Promise((resolve) => (arrived = resolve));
    rx.on("message", (m, confirm) => {
      if (m.text !== "hoptell doctor relay check") return;
      confirm();
      arrived();
    });
    rx.start();
    await rx.ready(8000);
    const ack = await sender.send(rxName, "hoptell doctor relay check", 60);
    const timedOut = new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(`the test message did not arrive within ${receiveMs / 1000} s`)), receiveMs)));
    await Promise.race([got, timedOut]);
    line("ok", "relay check", `a test message was delivered and confirmed in ${Date.now() - started} ms (${ack.state})`);
  } catch (e) {
    const fixed = /^the test message did not arrive/.test(e.message) ? e.message : loginProblem(e.message);
    line("FAIL", "relay check", show`${fixed}`);
  } finally {
    clearTimeout(timer);
    rx.close();
  }
}

export async function doctor(env, out = console.log, { relayCheck = false, fix = false, homedir, binding = {}, marks = false } = {}) {
  const home = defaultHome(env, homedir);
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
  // `marks` (a terminal that takes colour): a coloured symbol before the word, which stays as it is.
  const mark = (level) => statusMark(level, marks);
  const line = (level, what, detail) => {
    if (level === "FAIL") failed++;
    out(redact(`${mark(level)}${level.padEnd(4)}  ${what}: ${detail}`));
  };

  const major = Number(process.versions.node.split(".")[0]);
  line(major >= 22 ? "ok" : "FAIL", "Node.js", show`${process.versions.node}` + (major >= 22 ? "" : " (hoptell needs 22 or newer)"));

  if (loadedEnvFile) {
    const open = process.platform !== "win32" && fs.statSync(loadedEnvFile).mode & 0o077;
    line(open ? "warn" : "ok", "settings file", open ? show`${loadedEnvFile} has permissions for other users; run: chmod 600 ${shellQuote(loadedEnvFile)}` : show`${loadedEnvFile}`);
  } else {
    line("info", "settings file", show`none found (looked for ${envFiles().join(", ")}); using environment variables only`);
  }

  // Switches and choices: a value that is not accepted is a failure where the session, command
  // or relay refuses it, and a warning where the default is used instead.
  const refused = [];
  for (const check of [() => envAuth(env), () => envCredentialStore(env), () => envContactsSelf(env), ...["HOPTELL_EXPERIMENTAL_E2EE", "HOPTELL_REQUIRE_MEMBERS", "HOPTELL_OWNER_APP", "HOPTELL_TITLE_AUTO"].map((n) => () => envSwitch(env, n))]) {
    try {
      check();
    } catch (e) {
      refused.push(e.message);
    }
  }
  const parsed = readSettings({ env, homedir: homedir ?? "", pid: process.pid });
  if (parsed.errors.agentsMax) refused.push(`${parsed.errors.agentsMax} (spawning agents is refused)`);
  for (const m of refused) line("FAIL", "settings", show`${m}`);
  for (const w of parsed.warnings) line("warn", "settings", show`${w}`);
  if (parsed.errors.title) line("warn", "settings", show`${parsed.errors.title}`);

  if (!env.HOPTELL_RELAY) line("FAIL", "relay URL", "HOPTELL_RELAY is not set (e.g. ws://192.0.2.10:7777)");
  else if (!url || !/^wss?:$/.test(url.protocol)) {
    line("FAIL", "relay URL", "HOPTELL_RELAY is not a ws:// or wss:// URL");
    url = null;
  } else {
    const plain = url.protocol === "ws:" && !LOOPBACK.test(url.hostname);
    line("ok", "relay URL", show`${shownUrl}` + (plain ? " (unencrypted: keep it on a LAN or VPN, or use wss://)" : ""));
  }

  // HOPTELL_AUTH=login: signed in with an identity provider (design 1.6) instead of a token.
  // An invalid HOPTELL_AUTH or HOPTELL_CREDENTIAL_STORE (reported under settings): no token or
  // sign-in is used and the relay login is not tried, as a session would not try it either.
  const auth = (() => {
    try {
      envCredentialStore(env);
      return envAuth(env);
    } catch {
      return null;
    }
  })();
  const signedIn = auth === "login";
  let signIn = null;
  if (!auth) line("info", "relay login", "not checked: fix the settings above first");
  else if (!signedIn) line(env.HOPTELL_TOKEN ? "ok" : "FAIL", "token", env.HOPTELL_TOKEN ? "set (not shown)" : "HOPTELL_TOKEN is not set; use the relay's shared token or your member token");
  else if (url) {
    try {
      const { signInStatus, tokenSource } = await import("./login.js");
      const profile = profileKey(env.HOPTELL_RELAY, env.HOPTELL_PROFILE);
      const st = signInStatus(home, profile);
      if (!st) line("FAIL", "sign-in", "HOPTELL_AUTH=login, but this relay profile is not signed in: run hoptell login");
      else {
        line("ok", "sign-in", st.broker ? show`with ${st.issuer} through the relay (broker ${st.broker}); the credential is kept in the ${st.store}` : show`with ${st.issuer} as client ${st.clientId}; the credential is kept in the ${st.store}`);
        signIn = tokenSource({ home, profile, relayUrl: env.HOPTELL_RELAY, passphrase: env.HOPTELL_CREDENTIAL_PASSPHRASE || null });
      }
    } catch (e) {
      line("FAIL", "sign-in", show`${e.message}`);
    }
  }

  const name = env.HOPTELL_NAME || null;
  const nameOk = !name || NAME_RE.test(name);
  if (!name) line("info", "peer name", show`HOPTELL_NAME is not set: the relay names each session (<member>-${HOSTNAME}-<n> with a member token, ${HOSTNAME}-<n> with the shared token); older relays use ${HOSTNAME}-<process id> and ${HOSTNAME}-cli`);
  else line(nameOk ? "ok" : "FAIL", "peer name", nameOk ? show`${name}` : show`"${name}" is invalid: ${NAME_RULE}`);
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
    line("info", "delivery", "automatic per session: channel notices when the hoptell\n      channel is enabled, else hook notices when the hoptell hooks answer a\n      check, else read_inbox or a background listener; hoptell tmux uses tmux\n      notices");
  } else if (requested) line("ok", "delivery", show`HOPTELL_PUSH=${push} for sessions using these settings`);
  // Hook delivery of running Claude Code sessions on this machine (evidence, not configuration).
  const sessions = hookSessions(home);
  if (!sessions.length) line("info", "hook sessions", "none running with hook delivery");
  for (const h of sessions) {
    const state = !h.live ? "ended" : h.verifiedAt ? `verified at ${new Date(h.verifiedAt).toISOString()}` : "registered, not verified";
    line(h.live ? "ok" : "info", "hook sessions", show`${h.peer ? `peer ${h.peer}` : hookSessionLabel(h)}: ${state}${h.lastNoticeAt ? `, last notice ${new Date(h.lastNoticeAt).toISOString()}` : ""}`);
  }

  // Device keys (design 3.2): EXPERIMENTAL, reported only when enabled. Public parts only.
  if (!parsed.errors.e2ee && envSwitch(env, "HOPTELL_EXPERIMENTAL_E2EE")) {
    // The release gate (design 3.5), by the same rule as lib/mls/driver.js loadDriver: only a
    // reviewed build (REVIEWED_BINDING set) whose shipped bundle matches those digests, with no
    // override (HOPTELL_MLS_WASM, HOPTELL_MLS_DRIVER, which keep the label whatever their bytes),
    // is reviewed; anything else is experimental. `binding` is for tests only.
    const override = Boolean(env.HOPTELL_MLS_WASM || env.HOPTELL_MLS_DRIVER);
    let reviewedBuild = false;
    const details = [];
    try {
      const { BINDING_DIR, reviewedDigestsDeclared, shippedBindingPresent, shippedBindingStatus } = await import("./mls/openmls.js");
      if (shippedBindingPresent(binding) && !reviewedDigestsDeclared(binding)) details.push(["info", override ? "the package carries a binding bundle, which this build does not load by default (no reviewed digests); the binding named by HOPTELL_MLS_WASM or HOPTELL_MLS_DRIVER is used, labeled experimental" : show`the package carries a binding bundle, which this build does not load by default (no reviewed digests). To try it, labeled experimental, set HOPTELL_MLS_WASM=${path.resolve(binding.dir ?? BINDING_DIR)} (or HOPTELL_MLS_DRIVER to a driver module)`]);
      else if (shippedBindingPresent(binding)) {
        const s = shippedBindingStatus(binding);
        reviewedBuild = s.reviewed && !override;
        details.push([s.reviewed ? "ok" : "warn", show`shipped binding (glue ${s.digests.glue.slice(0, 12)}, WASM ${s.digests.wasm.slice(0, 12)}) ${s.reviewed ? "matches the reviewed digests" : "does not match reviewed digests; it stays experimental"}${override ? "; an override (HOPTELL_MLS_WASM or HOPTELL_MLS_DRIVER) is set and is used instead, labeled experimental" : ""}`]);
      }
    } catch (e) {
      details.push(["warn", show`the shipped binding could not be checked (${e.message}); it stays experimental`]);
    }
    line("info", "encrypted messaging", reviewedBuild ? "reviewed build: the shipped binding matches the reviewed digests" : "experimental, not independently reviewed");
    for (const [level, text] of details) line(level, "encrypted messaging", text);
    const mls = path.join(home, "mls");
    let profiles = [];
    try {
      profiles = fs.readdirSync(mls);
    } catch {}
    const found = profiles.flatMap((p) => {
      try {
        const r = JSON.parse(fs.readFileSync(path.join(mls, p, "device.json"), "utf8"));
        return [{ profile: p, device: r.device, status: r.status }];
      } catch {
        return [];
      }
    });
    if (!found.length) line("info", "device keys", "experimental; no device enrolled in this home (hoptell device enroll)");
    for (const d of found) line(d.status === "active" ? "ok" : "warn", "device keys", show`experimental; profile ${d.profile}: device ${d.device} is ${d.status}`);
    // Encrypted conversations (design 3.3): forks and refused commits, from the device's sealed records.
    for (const d of found) {
      try {
        const { e2eeDoctor } = await import("./mls/cli.js");
        for (const [level, text] of await e2eeDoctor({ home, profile: d.profile, env })) line(level, "encrypted messages", show`${text}`);
      } catch (e) {
        line("info", "encrypted messages", show`profile ${d.profile}: not checked (${e.message})`);
      }
    }
    if (found.length) line("info", "encrypted messages", "limit: a device notices inconsistent histories it sees; a relay can keep two sides apart unnoticed until they meet or the owners compare checkpoints (hoptell contacts verify <member> --conversation)");
    line("info", "device keys", "limit: restoring an older raw copy of this home on the same machine (outside hoptell device restore) brings back old keys and is not detected; there is no freshness anchor yet");
  }

  if (url) {
    const health = `${url.protocol === "wss:" ? "https:" : "http:"}//${url.host}/healthz`;
    try {
      const r = await fetch(health, { signal: AbortSignal.timeout(5000) });
      line(r.ok ? "ok" : "warn", "relay health", show`${health} returned HTTP ${r.status}`);
    } catch (e) {
      // The cause in words where it is known; "fetch failed" alone never says which.
      const code = e.cause?.code || e.cause?.errors?.[0]?.code || e.cause?.cause?.code;
      if (code === "ECONNREFUSED") line("warn", "relay health", show`no answer from ${health} (connection refused); is the relay running?`);
      else if (e.cause?.message === "bad port") line("warn", "relay health", show`cannot fetch ${health}: the HTTP client blocks this port; check HOPTELL_RELAY`);
      else line("warn", "relay health", show`${health}: ${code || e.message}`);
    }
    if (auth && (signedIn ? signIn : env.HOPTELL_TOKEN) && nameOk) {
      // Log in send-only, which never takes over a session's name. Use the CLI identity plus
      // "-doctor" when it fits, so member-token name rules hold and the relay, which leaves
      // the caller out of its peer list, still lists a session that uses the name itself.
      // Without HOPTELL_NAME the relay picks the CLI name (protocol 2), or <host>-cli (protocol 1).
      const as = name ? (name.length <= 57 ? `${name}-doctor` : name) : null;
      const c = new RelayClient({ url: env.HOPTELL_RELAY, ...(signedIn ? { signIn } : { token: env.HOPTELL_TOKEN }), name: as, mode: "send", reconnect: false });
      let identity = name;
      try {
        c.start();
        await c.ready(8000);
        const peers = await c.list();
        identity ??= c.name;
        line("ok", "relay login", signedIn ? "sign-in and protocol version accepted" : "token and protocol version accepted");
        relayIdentity(c, env, home, line, show);
        // After a relay restore that lost the access state (design 4.4), this member's grants wait
        // to be published again. Only the member's own state; a relay without grants answers an error.
        if (c.protocolInUse === 2 && c.member?.id) {
          const g = await c.rpc({ type: "grants_get" }).catch(() => null);
          if (g?.pending) line("warn", "grants", show`the relay was restored and waits for member ${c.member.name} to publish its grants again: until then, sends to its sessions fail with "unknown peer". Check them with hoptell grants, then run hoptell grants publish --yes --rev ${g.grants?.revision ?? "N"}`);
        }
        const authNote = {
          shared: ["info", "one shared token: any token holder can use any peer name, so names identify sessions, not people"],
          members: ["ok", "per-member tokens only: each name belongs to its member"],
          mixed: ["warn", "per-member tokens and a shared token: a shared-token holder can use any member's name; remove the shared token to make member names trustworthy"],
        }[c.relayAuth];
        line(...(authNote ? [authNote[0], "relay authentication", authNote[1]] : ["info", "relay authentication", "this relay does not report its authentication mode (version before 0.3)"]));
        const online = peers.filter((p) => p.online).map((p) => scrub(p.name));
        line("ok", "peers", online.length ? `${online.length} online: ${online.join(", ")}` : "none online");
        if (relayCheck) await roundTrip(c, identity, line, show);
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

  // Who may reach the sessions of this home (contacts, design 1.5).
  try {
    const { inspectContacts } = await import("./quarantine.js");
    const k = inspectContacts(home);
    if (k.mode === "legacy-allow") line("warn", "contacts", "not managed yet: every sender reaches your sessions as before; run hoptell contacts init to decide who may");
    else if (k.mode === "unset") line("info", "contacts", "not set up yet: the first agent session or command sets them up");
    else if (k.markerProblem || k.policyProblem) line("FAIL", "contacts", show`managed, but ${k.markerProblem ?? k.policyProblem}: every sender waits for your decision`);
    else {
      const p = k.policy;
      line("ok", "contacts", show`managed: default ${p.default}, unverified senders ${p.unverified ?? "ask"}, ${plural((p.grants ?? []).length, "grant")}, ${plural((p.blocks ?? []).length, "block")}`);
    }
    if (k.mode === "managed") {
      let self = null;
      try {
        self = envContactsSelf(env);
      } catch {} // reported under settings
      if (self === "allow") line("info", "contacts self", "allow: messages the relay attributes to your own member\n      in the same realm, with neither side hosted, can bypass the default\n      hold; blocks and encryption requirements still apply.\n      HOPTELL_CONTACTS_SELF=hold applies the usual contacts policy");
      else if (self === "hold") line("info", "contacts self", "hold: messages from your own member follow the\n      usual contacts policy (HOPTELL_CONTACTS_SELF=hold)");
    }
    if (k.requests.length) {
      const oldest = k.requests.map((r) => r.created).sort()[0];
      line("info", "waiting senders", show`${plural(k.requests.length, "sender")}, ${plural(k.requests.reduce((n, r) => n + r.items, 0), "message")}, oldest since ${oldest}: hoptell contacts`);
    }
    if (k.journals) line("info", "contacts decisions", show`${plural(k.journals, "decision")} waiting for room in an inbox`);
    const dropped = Object.entries(k.dropped).filter(([, n]) => n);
    if (dropped.length) line("info", "contacts drops", show`${dropped.map(([w, n]) => `${n} ${w}`).join(", ")}`);
    if (k.mode === "managed") line("info", "contacts receivers", "every process that receives for this home must run this hoptell version or later; older ones do not apply your contacts");
  } catch (e) {
    line("warn", "contacts", show`could not be read: ${e.message}`);
  }

  const root = home;
  const dirs = [root, path.join(root, "inbox"), ...(name && nameOk ? [path.join(root, "inbox", name)] : [])];
  let inboxNote = null;
  let missingAt = -1;
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
      missingAt = i;
      break;
    }
    open ||= r.open;
  }
  if (inboxNote !== false) {
    let detail = inboxNote || show`${root}`;
    // Also when only the configured name's folder is missing: inbox/ may still hold other names'.
    if (!inboxNote || missingAt === 2) {
      // Message files hoptell 0.2 (or a protocol-1 relay) left in inbox/<name>, for every name: a
      // session that used an automatic name, or a HOPTELL_NAME since changed, left its own.
      const MESSAGE_FILE = /^\d{13}-\d{8}-[0-9a-f]{8}\.json$/;
      const counts = new Map();
      let folders = [];
      let unlisted = null;
      try {
        folders = fs.readdirSync(dirs[1], { withFileTypes: true }).filter((d) => d.isDirectory() && NAME_RE.test(d.name)).map((d) => d.name).sort();
      } catch (e) {
        unlisted = e.code || e.message; // inbox/ needs no read access for hoptell's own use
      }
      if (name && nameOk && !folders.includes(name) && fs.existsSync(dirs[2])) folders.push(name);
      for (const f of folders) {
        try {
          const n = fs.readdirSync(path.join(dirs[1], f)).filter((x) => MESSAGE_FILE.test(x)).length;
          if (n) counts.set(f, n);
        } catch (e) {
          line(f === name ? "FAIL" : "warn", "inbox", show`cannot read ${path.join(dirs[1], f)}: ${e.code || e.message}`);
          if (f === name) detail = null;
        }
      }
      if (detail && name && nameOk && missingAt !== 2) {
        const n = counts.get(name) ?? 0;
        detail += show`; ${plural(n, "pending message file")} for ${name}`;
        // A session with this name reads them, or on a current relay moves them into its own
        // storage when it connects (lib/engine.js).
        if (n) detail += " (a session with this name reads them, or moves them into its own storage when it connects to a current relay)";
      }
      const others = [...counts].filter(([f]) => f !== name);
      if (detail && others.length) {
        const total = others.reduce((a, [, n]) => a + n, 0);
        const shown = others.slice(0, 5).map(([f, n]) => `${f} (${n})`).join(", ");
        const more = others.length > 5 ? ` and ${plural(others.length - 5, "more name")}` : "";
        detail += show`; ${plural(total, "pending message file")} for other names: ${shown}${more}`;
        detail += " (left by hoptell 0.2 or a protocol-1 relay, for an automatic name or an earlier HOPTELL_NAME: a session with HOPTELL_NAME set to that name reads them, or moves them into its own storage when it connects to a current relay that lets it use the name; else read them with hoptell 0.2.2)";
      }
      if (detail && unlisted) detail += show`; files for other names not counted (cannot list ${dirs[1]}: ${unlisted})`;
    }
    if (detail) line(open ? "warn" : inboxNote ? "info" : "ok", "inbox", `${detail}${open ? " (open to other users; hoptell tightens it on next use)" : ""}`);
  }

  // Several relays (design 2.1): the relays file, its default and each entry's problems.
  try {
    const file = env.HOPTELL_RELAYS || path.join(env.XDG_CONFIG_HOME || path.join(homedir ?? "", ".config"), "hoptell", "relays.json");
    if (env.HOPTELL_RELAYS || fs.existsSync(file)) {
      const { readRelaysFile } = await import("./relays.js");
      const r = readRelaysFile(file, { env, homedir });
      line(r.default ? "ok" : "warn", "relays", show`${r.relays.map((x) => `${x.alias}${x.join ? "" : " (send-only)"}`).join(", ")}; bare names go to ${r.default ?? "no relay (say name@relay)"}`);
      for (const x of r.relays.filter((x) => x.tokenProblem)) line("FAIL", "relays", show`${x.alias}: ${x.tokenProblem}`);
      for (const p of r.problems) line("FAIL", "relays", show`${p.alias}: ${p.problem}`);
    }
  } catch (e) {
    line("FAIL", "relays", show`${e.message}`);
  }

  // Owner-run apply (design 5.2): an interrupted apply leaves a recovery journal.
  try {
    const { journals } = await import("./apply.js");
    const left = journals(home);
    if (left.length) line("FAIL", "apply", `${plural(left.length, "interrupted apply")} left a recovery journal in ${path.join(home, "apply")}; run hoptell apply --recover`);
  } catch {}

  // Larger transfers (design 6, experimental): interrupted saves are recovered; leftovers are
  // reported, and removed with --fix.
  try {
    const { transfersDoctor } = await import("./transfercli.js");
    await transfersDoctor({ home, fix, line: (level, area, text) => line(level, area, show`${text}`) });
  } catch (e) {
    line("FAIL", "transfers", show`${e.message}`);
  }

  // The private local relay (hoptell local-relay), when installed.
  try {
    const { localRelayStatus } = await import("./localrelay.js");
    const st = await localRelayStatus({ home });
    if (st.installed) {
      line(st.signedIn && !st.problems.length ? "ok" : "warn", "local relay", show`${st.url}: service ${st.loaded ? "loaded" : "not loaded"}, ${st.signedIn ? "its token signs in" : st.healthy ? "answering" : "not answering"}`);
      for (const p of st.problems) line("warn", "local relay", show`${p}`);
    }
  } catch (e) {
    line("warn", "local relay", show`${e.message}`);
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

  // Spawned agents (design 7.1): profiles that fail their checks or wait for approval, live runs,
  // runs marked lost in the last day. The sweep runs first.
  try {
    const { listProfiles, readApproved, approvalOf, agentsPaths } = await import("./agents.js");
    if (fs.existsSync(agentsPaths(home).dir)) {
      const { sweep, listRuns, isLive } = await import("./agentruns.js");
      await sweep(home);
      const approved = readApproved(home);
      if (approved.problem) line("warn", "agent profiles", show`${approved.problem}`);
      const profiles = listProfiles(home, { homedir });
      for (const r of profiles) {
        const st = approvalOf(r, approved);
        if (st === "invalid") line("warn", "agent profile", show`${r.id} fails its checks: ${r.problems.join("; ")}`);
        else if (st !== "approved") line("warn", "agent profile", show`${r.id} is ${st === "changed" ? "changed since you approved it" : "not approved"}; approve it with: hoptell agents profile approve ${r.id}`);
      }
      const runs = listRuns(home);
      const live = runs.filter((x) => isLive(x));
      const pending = runs.filter((x) => x.state === "pending-confirmation");
      const lost = runs.filter((x) => x.state === "lost" && Date.parse(x.ended ?? x.created) > Date.now() - 86_400_000);
      line(lost.length ? "warn" : "ok", "agent runs", show`${plural(profiles.length, "profile")}, ${plural(live.length, "live run")}${pending.length ? `, ${pending.length} waiting for your confirmation (hoptell agents confirm <run>)` : ""}${lost.length ? `, ${lost.length} marked lost in the last day: ${lost.map((x) => x.run).join(", ")}` : ""}`);
    }
  } catch (e) {
    line("warn", "agent runs", show`${e.message}`);
  }

  const tmux = spawnSync("tmux", ["-V"], { encoding: "utf8" });
  if (tmux.status !== 0) line("info", "tmux", "not available (required only for hoptell tmux; version 3.2 or newer)");
  else if (!tmuxVersionSupported(tmux.stdout)) line("warn", "tmux", show`${tmux.stdout.trim()} is too old for hoptell tmux (3.2 or newer)`);
  else line("ok", "tmux", show`${tmux.stdout.trim()}`);
  if (tmux.status === 0) {
    // A tmux server started with hoptell settings in its environment (as earlier versions of
    // hoptell tmux did) hands them to every later session, e.g. HOPTELL_PUSH=tmux to a plain
    // Claude Code session, which then waits for a tmux injector that does not exist.
    const global = spawnSync("tmux", ["show-environment", "-g"], { encoding: "utf8", env: tmuxEnv(env) });
    const names = global.status === 0 ? [...global.stdout.matchAll(/^(HOPTELL_[A-Z0-9_]+)=/gm)].map((m) => m[1]) : [];
    if (names.length) {
      line("warn", "tmux server", `global environment contains ${names.join(", ")}; new tmux sessions can inherit these settings. To remove them, run: ${names.map((n) => `tmux set-environment -g -u ${n}`).join("; ")}`);
    }
  }

  // The owner channel (design 7.2): pins, the bridge on this home, verification counts. Never a
  // token, chat id, key or text.
  try {
    const { statusLines } = await import("./ownerchannel.js");
    for (const l of statusLines(home, { ownerChannel: envOwnerChannel(env).value })) line(l.level, l.what, show`${l.detail}`);
  } catch (e) {
    line("warn", "owner channel", show`could not be checked (${e.message})`);
  }

  out(failed ? `\n${mark("FAIL")}${plural(failed, "check")} failed.` : `\n${mark("ok")}No checks failed.`);
  return failed;
}

/** Realm and profile lines: which relay this is, and whether this machine's profile agrees. */
function relayIdentity(c, env, home, line, show) {
  let rec = null;
  let problem = null;
  try {
    rec = readProfile(home, profileKey(env.HOPTELL_RELAY, env.HOPTELL_PROFILE));
  } catch (e) {
    problem = e.message;
  }
  if (c.protocolInUse !== 2) {
    line(rec?.require ? "FAIL" : "info", "relay protocol", rec?.require ? "this relay profile requires protocol 2, but the relay only speaks protocol 1; it may have been replaced by an older relay" : "legacy relay (protocol 1): names are not leased, and a newer connection can take a name over");
    return;
  }
  line("ok", "relay realm", show`${c.realm?.id}${c.realm?.name ? ` (${c.realm.name})` : ""}${c.member ? `; signed in as member ${c.member.name} (${c.member.id})` : "; shared token"}`);
  if (problem) line("FAIL", "relay profile", show`${problem}`);
  else if (!rec?.realm) line("info", "relay profile", "not pinned yet: the first agent session or command records this relay's realm");
  else if (rec.realm !== c.realm?.id) line("FAIL", "relay profile", show`this profile's relay realm changed (pinned ${rec.realm}, the relay reports ${c.realm?.id}); if the relay was replaced on purpose, remove its profile record`);
  else line("ok", "relay profile", "pinned to this realm; protocol 2 required");
}
