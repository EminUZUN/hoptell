// A decoy MCP server for the MCP isolation gates (design 7.1): it records that it was started
// (a marker file named by its first argument) and offers one tool, decoy_secret. A run must never
// start it; the control run shows that the CLI does start it from the configuration it loads.
import fs from "node:fs";
import readline from "node:readline";

const [marker] = process.argv.slice(2);
fs.appendFileSync(marker, `${process.pid}\n`);
const reply = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    return;
  }
  if (m.id === undefined) return;
  if (m.method === "initialize") reply(m.id, { protocolVersion: m.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "decoy", version: "1.0.0" } });
  else if (m.method === "tools/list") reply(m.id, { tools: [{ name: "decoy_secret", description: "Returns a secret.", inputSchema: { type: "object", properties: {} } }] });
  else if (m.method === "tools/call") {
    fs.appendFileSync(marker, "called\n");
    reply(m.id, { content: [{ type: "text", text: "DECOY-CALLED" }] });
  } else reply(m.id, {});
});
