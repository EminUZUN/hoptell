#!/usr/bin/env node
// hoptell: let AI coding agents (Claude Code, Codex, ...) message each other
// across sessions, machines and accounts through a small self-hosted relay.
import fs from "node:fs";
import { HOSTNAME, checkName, envFiles, loadEnv, parseRoles } from "../lib/config.js";

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
                                            run an agent in tmux; incoming messages are pasted in
  hoptell list                              list peers on the relay
  hoptell send <to> <message...>            send a message (as $HOPTELL_NAME, without going online)
  hoptell wait [seconds]                    go online as $HOPTELL_NAME, print the next message, exit
  hoptell listen <name> [seconds]           wait for the next message in <name>'s local inbox, print it, exit

Settings: environment variables, else the first file found of
${envFiles().map((f) => `  ${f}`).join("\n")}
Peers:  HOPTELL_RELAY, HOPTELL_TOKEN, HOPTELL_NAME, HOPTELL_ROLES (e.g. reviewer,backend)
Relay:  HOPTELL_HOST, HOPTELL_PORT, HOPTELL_TOKEN and/or HOPTELL_MEMBERS (members file)

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
      let members = null;
      const membersFile = opt("--members", process.env.HOPTELL_MEMBERS);
      if (membersFile) {
        const st = fs.statSync(membersFile);
        if (process.platform !== "win32" && st.mode & 0o077) fail(`${membersFile} holds tokens; restrict it first: chmod 600 ${membersFile}`);
        members = JSON.parse(fs.readFileSync(membersFile, "utf8")).members;
        if (!Array.isArray(members)) fail(`${membersFile}: expected {"members": [{"name": "...", "token": "..."}]}`);
      }
      await startRelay({ host: opt("--host", process.env.HOPTELL_HOST), port, token: process.env.HOPTELL_TOKEN, members });
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
      const [to, ...words] = args;
      if (!to || !words.length) fail("usage: hoptell send <to> <message...>", 2);
      const { describeAck } = await import("../lib/client.js");
      const c = await connect("send");
      console.log(describeAck(to, await c.send(to, words.join(" "))));
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
