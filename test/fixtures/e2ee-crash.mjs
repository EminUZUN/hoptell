// A device killed at a send or receive point of encrypted messaging (test/mls-e2ee.test.js):
// SIGKILL, no rollback, no close. argv: relay url, home, session, point, role ("send" <member id>
// <session> <body>, or "receive"); the member's token in HOPTELL_TEST_TOKEN. Deliveries are
// appended to <home>/delivered.jsonl.
import fs from "node:fs";
import path from "node:path";
import { RelayClient } from "../../lib/client.js";
import { deviceStore } from "../../lib/mls/device.js";
import { createE2ee } from "../../lib/mls/e2ee.js";
import { createFakeDriver } from "../fake-mls-driver.js";

const [url, home, session, point, role, ...rest] = process.argv.slice(2);
const driver = createFakeDriver({ seed: `crash-${process.pid}` });
const store = deviceStore({ home, profile: "relay-test", driver, store: "file", passphrase: "correct horse battery staple", keychainBackend: null, machine: "m" });
const client = new RelayClient({ url, token: process.env.HOPTELL_TEST_TOKEN, name: session, mode: "peer", reconnect: false });
client.on("error", () => {});
client.start();
await client.ready(5000);
const e2ee = createE2ee({
  store, driver, client, session, home, profile: "relay-test",
  deliver: async (m) => fs.appendFileSync(path.join(home, "delivered.jsonl"), `${JSON.stringify({ id: m.id, message_id: m.message_id, text: m.text, by: "child" })}\n`),
  fault: (p) => p === point && process.kill(process.pid, "SIGKILL"),
});
await e2ee.attach();
if (role === "send") {
  const [member, to, body] = rest;
  await e2ee.send({ to: { member, session: to }, body });
} else await new Promise((r) => setTimeout(r, 8000));
process.stdout.write("survived\n");
process.exit(0);
