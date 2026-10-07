#!/usr/bin/env node
// hoptell: let AI coding agents (Claude Code, Codex, ...) message each other
// across sessions, machines and accounts through a small self-hosted relay.
import fs from "node:fs";
import { HOSTNAME, checkName, envFiles, loadEnv, parseRoles } from "../lib/config.js";

// Claude Code hook commands (lib/wake.js) print only what Claude Code expects, never errors.
const HOOKS = { "hook-session-start": "hookSessionStart", "hook-file-changed": "hookFileChanged" };
if (Object.hasOwn(HOOKS, process.argv[2] ?? "")) {
  let code = 0;
  try {
    const i = process.argv.indexOf("--home", 3);
    if (i > 0 && process.argv[i + 1]) process.env.HOPTELL_HOME = process.argv[i + 1];
    loadEnv();
    const wake = await import("../lib/wake.js");
    code = wake[HOOKS[process.argv[2]]]();
  } catch {
    code = 0;
  }
  process.exit(code);
}

try {
  loadEnv();
} catch (e) {
  console.error(`hoptell: ${e.message}`);
  process.exit(1);
}

const USAGE = `hoptell - messaging between AI coding agents over your own LAN/VPN

Usage:
  hoptell relay --host <ip> [--port 7777] [--members file.json]
                                            run the relay (one machine per team)
  hoptell mcp                               MCP server for an agent session (stdio)
  hoptell tmux <name> [--roles a,b] -- <agent command>
                                            run an agent in tmux; attempt an inbox notice when its prompt appears idle
  hoptell list                              list peers on the relay
  hoptell send [--ttl 10m] [--reply-to <reference>] [--] <to> <message...>
                                            send a message (as $HOPTELL_NAME, without going online);
                                            --ttl: request relay queue expiry; older relays ignore it;
                                            --reply-to: the "Message reference" you are answering
  hoptell snapshot <file>                   print a UTF-8 file snapshot with its SHA-256, for review
  hoptell snapshot --check <sha256> <file>  exit 0 if the bytes match; nonzero if different or the check fails
  hoptell wait [seconds]                    go online as $HOPTELL_NAME, print the next message, exit
  hoptell listen <name> [seconds]           wait for the next message in <name>'s local inbox, print it, exit
  hoptell doctor                            check settings, relay, login, inbox and tmux on this machine
  hoptell hooks                             print Claude Code hook settings for hook delivery without the plugin

Settings: environment variables, else the first file found of
${envFiles().map((f) => `  ${f}`).join("\n")}
Peers:  HOPTELL_RELAY, HOPTELL_TOKEN, HOPTELL_NAME, HOPTELL_ROLES (e.g. reviewer,backend),
        HOPTELL_PUSH (channel, hook, tmux or listener; unset for automatic)
Relay:  HOPTELL_HOST, HOPTELL_PORT, HOPTELL_TOKEN and/or HOPTELL_MEMBERS (members file);
        HOPTELL_LOG_FINGERPRINTS=on with HOPTELL_LOG_FINGERPRINT_KEY_FILE for keyed log fingerprints

Send to a peer name, to @<role> (every online peer with the role) or to @all.`;

const fail = (msg, code = 1) => {
  console.error(`hoptell: ${msg}`);
  process.exit(code);
};

const [cmd, ...args] = process.argv.slice(2);
const opt = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const cliName = () => checkName(process.env.HOPTELL_NAME || `${HOSTNAME}-cli`, "HOPTELL_NAME");

/** Connect to the relay. `onMessage` is attached before connecting, so queued messages are not missed. */
async function connect(mode, onMessage) {
  const { RelayClient } = await import("../lib/client.js");
  const roles = mode === "peer" ? parseRoles(process.env.HOPTELL_ROLES) : [];
  const c = new RelayClient({ url: process.env.HOPTELL_RELAY, token: process.env.HOPTELL_TOKEN, name: cliName(), mode, roles, reconnect: false });
  if (onMessage) c.on("message", onMessage);
  c.start();
  await c.ready();
  return c;
}

try {
  switch (cmd) {
    case "relay": {
      const { startRelay } = await import("../lib/relay.js");
      const port = Number(opt("--port", process.env.HOPTELL_PORT || 7777));
      if (!Number.isInteger(port) || port < 0 || port > 65535) fail("invalid --port");
      const membersFile = opt("--members", process.env.HOPTELL_MEMBERS);
      const readMembers = () => {
        const st = fs.statSync(membersFile);
        if (process.platform !== "win32" && st.mode & 0o077) throw new Error(`${membersFile} holds tokens; restrict it first: chmod 600 ${membersFile}`);
        let members;
        try {
          members = JSON.parse(fs.readFileSync(membersFile, "utf8")).members;
        } catch (e) {
          // JSON.parse messages can quote the file, and the file holds tokens.
          throw new Error(e instanceof SyntaxError ? `${membersFile}: invalid JSON` : `${membersFile}: ${e.code || "cannot read"}`);
        }
        if (!Array.isArray(members)) throw new Error(`${membersFile}: expected {"members": [{"name": "...", "token": "..."}]}`);
        return members;
      };
      // Opt-in keyed fingerprints in the log: loaded once, before listening; no silent fallback.
      const fpModule = await import("../lib/fingerprint.js");
      const fingerprint = fpModule.fingerprintsEnabled(process.env.HOPTELL_LOG_FINGERPRINTS) ? fpModule.loadFingerprintKey(process.env.HOPTELL_LOG_FINGERPRINT_KEY_FILE) : null;
      const relay = await startRelay({ host: opt("--host", process.env.HOPTELL_HOST), port, token: process.env.HOPTELL_TOKEN, members: membersFile ? readMembers() : null, fingerprint });
      // kill -HUP: re-read the members file (revoked tokens are disconnected); on any problem keep the current list.
      if (membersFile) {
        process.on("SIGHUP", () => {
          try {
            relay.reload(readMembers());
          } catch (e) {
            console.log(new Date().toISOString(), `members reload failed; keeping the active members list: ${e.message}`);
          }
        });
      }
      break;
    }
    case "mcp": {
      const { runMcp } = await import("../lib/mcp.js");
      await runMcp();
      break;
    }
    case "tmux": {
      const sep = args.indexOf("--");
      const head = sep < 0 ? args : args.slice(0, sep);
      if (sep < 0 || !(head.length === 1 || (head.length === 3 && head[1] === "--roles"))) {
        fail("usage: hoptell tmux <peer-name> [--roles a,b] -- <agent command...>", 2);
      }
      const { launch } = await import("../lib/tmux.js");
      launch(head[0], args.slice(sep + 1), head[2] ?? process.env.HOPTELL_ROLES ?? "");
      break;
    }
    case "inject": {
      const { inject } = await import("../lib/tmux.js");
      await inject(args[0], args[1], args[2]);
      break;
    }
    case "list": {
      const c = await connect("send");
      const peers = await c.list();
      const { formatPeer } = await import("../lib/client.js");
      console.log(peers.length ? peers.map(formatPeer).join("\n") : "no other peers");
      c.close();
      break;
    }
    case "send": {
      const { describeAck, parseRef, parseTtl } = await import("../lib/client.js");
      let ttl;
      let replyTo;
      let rest = args;
      // Options come first; "--" ends them, so a message may itself start with "--".
      for (;;) {
        if (rest[0] === "--ttl") ttl = parseTtl(rest[1]);
        else if (rest[0] === "--reply-to") replyTo = parseRef(rest[1]);
        else break;
        rest = rest.slice(2);
      }
      if (rest[0] === "--") rest = rest.slice(1);
      const [to, ...words] = rest;
      if (!to || !words.length) fail("usage: hoptell send [--ttl 10m] [--reply-to <reference>] [--] <to> <message...>", 2);
      const c = await connect("send");
      console.log(describeAck(to, await c.send(to, words.join(" "), ttl, replyTo), ttl, replyTo));
      c.close();
      break;
    }
    case "wait": {
      const secs = Number(args[0]) || 300;
      const { format } = await import("../lib/inbox.js");
      process.stdout.on("error", (err) => fail(`cannot write output: ${err.message}`));
      let c = null;
      let timer = null;
      let idle = null;
      const done = () => (c ? c.close() : setTimeout(done, 50));
      c = await connect("peer", (m, confirm) => {
        clearTimeout(timer);
        // Confirm only once printed; on a write error the relay keeps the message.
        process.stdout.write(`${format(m)}\n`, (err) => (err ? fail(`cannot write output: ${err.message}`) : confirm()));
        clearTimeout(idle);
        idle = setTimeout(done, 500); // also collect messages arriving together
      });
      if (!idle) {
        timer = setTimeout(() => {
          console.log(`No messages within ${secs}s.`);
          c.close();
        }, secs * 1000);
      }
      c.on("fatal", (r) => fail(`relay closed the connection: ${r}`));
      break;
    }
    case "snapshot": {
      const snap = await import("../lib/snapshot.js");
      if (args[0] === "--check") {
        if (args.length !== 3) fail("usage: hoptell snapshot --check <sha256:...> <file>", 2);
        const r = snap.checkSnapshot(args[1], args[2]);
        console.log(
          r.matches
            ? `unchanged: ${args[2]} still matches ${r.expected}`
            : `changed: ${args[2]} is now ${r.current}, not ${r.expected}. Ask for a new review, or reconcile the change deliberately.`,
        );
        process.exitCode = r.matches ? 0 : 1;
      } else {
        if (args.length !== 1) fail("usage: hoptell snapshot <file>   or   hoptell snapshot --check <sha256:...> <file>", 2);
        console.log(snap.snapshotMessage(args[0]));
      }
      break;
    }
    case "hooks": {
      // Settings for Claude Code without the plugin: printed only, never written.
      const { hooksSnippet } = await import("../lib/wake.js");
      console.log(JSON.stringify(hooksSnippet(process.execPath, process.env.HOPTELL_HOME), null, 2));
      break;
    }
    case "doctor": {
      const { doctor } = await import("../lib/doctor.js");
      process.exitCode = (await doctor()) ? 1 : 0;
      break;
    }
    case "listen": {
      const name = checkName(args[0], "name");
      const secs = Number(args[1]) || 3600;
      const inbox = await import("../lib/inbox.js");
      const msgs = await inbox.waitFor(name, secs * 1000);
      // Let stdout drain before exiting so long messages are not cut off.
      process.stdout.write(
        msgs.length
          ? `${msgs.map(inbox.format).join("\n\n")}\n\n${inbox.NOT_YOUR_USER}\nReply with send_message, then start this listener again.\n`
          : `No messages within ${secs}s. Start the listener again to keep receiving.\n`,
      );
      break;
    }
    case undefined:
    case "help":
    case "-h":
    case "--help":
      console.log(USAGE);
      break;
    default:
      fail(`unknown command "${cmd}"\n\n${USAGE}`, 2);
  }
} catch (e) {
  fail(e.message);
}
