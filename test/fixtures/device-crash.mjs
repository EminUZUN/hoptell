// A device store killed at a point of a device operation (test/mls-proof-e2e.test.js,
// test/mls-prune.test.js): SIGKILL, no rollback, no close. argv: relay url (or "-" for none), home,
// point, action ("rotate" | "prune"); the member's token in HOPTELL_TEST_TOKEN, the clock in
// HOPTELL_TEST_NOW (ms, optional). The home's contacts are shared through
// <home>/contacts-test.json (mls-helpers memoryContacts).
import path from "node:path";
import { RelayClient } from "../../lib/client.js";
import { deviceStore } from "../../lib/mls/device.js";
import { createFakeDriver } from "../fake-mls-driver.js";
import { memoryContacts, ownFor } from "../mls-helpers.js";

const [url, home, point, action] = process.argv.slice(2);
const now = () => (process.env.HOPTELL_TEST_NOW ? Number(process.env.HOPTELL_TEST_NOW) : Date.now());
const driver = createFakeDriver({ seed: `crash-${process.pid}`, now });
const contacts = memoryContacts(undefined, { file: path.join(home, "contacts-test.json") });
const store = deviceStore({ home, profile: "relay-test", driver, store: "file", passphrase: "correct horse battery staple", keychainBackend: null, machine: "m", now, own: ownFor(contacts, home, "relay-test"), fault: (p) => p === point && process.kill(process.pid, "SIGKILL") });
let client = null;
if (url !== "-") {
  client = new RelayClient({ url, token: process.env.HOPTELL_TEST_TOKEN, name: `${process.env.HOPTELL_TEST_MEMBER ?? "alice"}-crash-${process.pid}`, mode: "send", reconnect: false });
  client.on("error", () => {});
  client.start();
  await client.ready(5000);
}
if (action === "rotate") await store.rotate(client);
else if (action === "prune") await store.prune();
else throw new Error(`unknown action ${action}`);
process.stdout.write("survived\n");
process.exit(0);
