import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startRelay } from "../lib/relay.js";
import { BIN } from "../lib/config.js";

// The suite never shows desktop notifications, also from the CLI and servers it starts (they
// inherit the environment); tests of notifications inject their own notifier.
process.env.HOPTELL_NOTIFY = "off";

// Test tokens are generated per run, so no token value is written in the source.
export const fakeToken = () => crypto.randomBytes(16).toString("hex");
export const TOKEN = fakeToken();
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Make `home` look like an existing install (state from before contacts), so contacts start in
 * legacy-allow mode and every sender is delivered: tests of other features keep their meaning.
 * Contacts tests use fresh homes instead.
 */
export function existingInstall(home) {
  fs.mkdirSync(path.join(home, "inbox"), { recursive: true, mode: 0o700 });
  return home;
}

/** Isolated world: a relay on a random port and a private state dir. */
export async function world({ fresh = false } = {}) {
  // `fresh`: a new install (contacts managed, everyone "ask"); otherwise an existing one.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hoptell-test-"));
  const home = fresh ? dir : existingInstall(dir);
  fs.writeFileSync(path.join(home, "empty.env"), ""); // never read the developer's real settings
  const relay = await startRelay({ host: "127.0.0.1", port: 0, token: TOKEN, log: () => {} });
  const env = {
    ...process.env,
    HOPTELL_ENV: path.join(home, "empty.env"),
    XDG_CONFIG_HOME: path.join(home, "config"), // never the developer's real relays file
    HOPTELL_HOME: home,
    HOPTELL_RELAY: `ws://127.0.0.1:${relay.port}`,
    HOPTELL_TOKEN: TOKEN,
    HOPTELL_PUSH: "listener",
    HOPTELL_STATE_DIR: path.join(home, "relay-state"), // a relay started by a test never uses the real state directory
    // Tests of other features read with today's semantics (a read deletes); receipts have their
    // own tests, which set HOPTELL_RECEIPTS=on.
    HOPTELL_RECEIPTS: "off",
  };
  delete env.HOPTELL_NAME;
  const clients = [];
  const stops = [];
  return {
    home,
    env,
    relay,
    /** Stop a process started for this world before close() removes its files. */
    onClose(stop) {
      stops.push(stop);
    },
    /** Start `hoptell mcp` under an MCP client. */
    async mcp(name, extra = {}) {
      const notes = [];
      const client = new Client({ name: "test", version: "0" });
      client.fallbackNotificationHandler = async (n) => notes.push(n);
      await client.connect(new StdioClientTransport({ command: process.execPath, args: [BIN, "mcp"], env: { ...env, HOPTELL_NAME: name, ...extra }, stderr: "ignore" }));
      clients.push(client);
      const call = async (tool, args = {}) => (await client.callTool({ name: tool, arguments: args })).content[0].text;
      // wait until it is online
      for (let i = 0; i < 50 && !/You are/.test(await call("list_peers")); i++) await sleep(100);
      return { client, call, notes };
    },
    /**
     * The inbox folder of a session named `name`: its protocol-2 bound storage when it has one,
     * else the legacy inbox/<name>.
     */
    inboxOf(name) {
      const v2 = path.join(home, "v2");
      if (fs.existsSync(v2)) {
        for (const realm of fs.readdirSync(v2)) {
          for (const member of fs.readdirSync(path.join(v2, realm))) {
            const dir = path.join(v2, realm, member, name, "inbox");
            if (fs.existsSync(dir)) return dir;
          }
        }
      }
      return path.join(home, "inbox", name);
    },
    /** Run the CLI. */
    cli(args, extra = {}) {
      return new Promise((resolve) =>
        execFile(process.execPath, [BIN, ...args], { env: { ...env, ...extra } }, (err, stdout, stderr) =>
          resolve({ code: err ? err.code : 0, stdout, stderr }),
        ),
      );
    },
    async close() {
      for (const stop of stops) await stop();
      for (const c of clients) await c.close().catch(() => {});
      await relay.close();
      // Retries cover a process that is still finishing a write into the folder.
      fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}
