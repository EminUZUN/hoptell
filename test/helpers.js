import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startRelay } from "../lib/relay.js";
import { BIN } from "../lib/config.js";

export const TOKEN = "EXAMPLE_TOKEN_xxxxxxxxxxxx";
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Isolated world: a relay on a random port and a private state dir. */
export async function world() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "hoptell-test-"));
  fs.writeFileSync(path.join(home, "empty.env"), ""); // never read the developer's real settings
  const relay = await startRelay({ host: "127.0.0.1", port: 0, token: TOKEN, log: () => {} });
  const env = {
    ...process.env,
    HOPTELL_ENV: path.join(home, "empty.env"),
    HOPTELL_HOME: home,
    HOPTELL_RELAY: `ws://127.0.0.1:${relay.port}`,
    HOPTELL_TOKEN: TOKEN,
    HOPTELL_PUSH: "listener",
  };
  delete env.HOPTELL_NAME;
  const clients = [];
  return {
    home,
    env,
    relay,
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
    /** Run the CLI. */
    cli(args, extra = {}) {
      return new Promise((resolve) =>
        execFile(process.execPath, [BIN, ...args], { env: { ...env, ...extra } }, (err, stdout, stderr) =>
          resolve({ code: err ? err.code : 0, stdout, stderr }),
        ),
      );
    },
    async close() {
      for (const c of clients) await c.close().catch(() => {});
      await relay.close();
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}
