// A relay killed at a take's commit (test/mls-relay.test.js): a device with one KeyPackage is
// enrolled and committed, then a kp_take is killed (SIGKILL: no rollback, no close) at `point`.
import { lockStateDir } from "../../lib/realm.js";
import { openRelayDb } from "../../lib/relaydb.js";
import { createDeviceDirectory } from "../../lib/mls/relaydir.js";
import { RELAY_MIGRATIONS } from "../../lib/relaystore.js";
import { b64, pinIdentity } from "../../lib/mls/identity.js";

const [dir, point] = process.argv.slice(2);
lockStateDir(dir);
let armed = false;
const db = openRelayDb({ dir, migrations: RELAY_MIGRATIONS, fault: (p) => armed && p === point && process.kill(process.pid, "SIGKILL") });
const realm = "0".repeat(32);
const [a, b] = [`m_${"a".repeat(26)}`, `m_${"b".repeat(26)}`];
const [da, db2] = [`${"a".repeat(25)}a`, `${"b".repeat(25)}a`];
const dir2 = createDeviceDirectory({ db, realm });
for (const [member, device, k] of [[a, da, 1], [b, db2, 2]]) {
  const key = Buffer.alloc(32, k);
  dir2.register({ member, device, key, pin: pinIdentity({ realm, member, device, key }) });
}
dir2.upload({ member: b, device: db2, packages: [{ kp: Buffer.from("a key package"), notAfter: Date.now() + 86_400_000 }] });
armed = true;
dir2.take({ requester: { member: a, device: da }, request: "req-crash-1", target: { member: b, device: db2 } });
process.stdout.write(`survived ${b64(Buffer.alloc(1))}\n`);
