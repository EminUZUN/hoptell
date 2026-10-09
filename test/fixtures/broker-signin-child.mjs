// One CLI process asking for a broker access token (tests of the client's durable refresh state).
//   node broker-signin-child.mjs <home> <profile> <relayUrl>
// KILL_AT=<fault point>: the process kills itself there (SIGKILL), as a crash would.
import { tokenSource } from "../../lib/login.js";

const [home, profile, relayUrl] = process.argv.slice(2);
const killAt = process.env.KILL_AT ?? null;
const signIn = tokenSource({ home, profile, relayUrl, passphrase: "test-passphrase-123", fault: (p) => p === killAt && process.kill(process.pid, "SIGKILL") });
try {
  const a = await signIn();
  console.log(JSON.stringify({ ok: true, kind: a.kind, issuer: a.issuer }));
} catch (e) {
  console.log(JSON.stringify({ ok: false, terminal: Boolean(e.terminal), error: e.message }));
}
