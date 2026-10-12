// A relay killed at a commit's acceptance (test/mls-ds.test.js): two members with devices and
// KeyPackages, a conversation's group created and committed, then a commit that adds a device is
// killed (SIGKILL: no rollback, no close) at `point` of its transaction.
import { lockStateDir } from "../../lib/realm.js";
import { openRelayDb } from "../../lib/relaydb.js";
import { createDeviceDirectory } from "../../lib/mls/relaydir.js";
import { createDeliveryService } from "../../lib/mls/relayds.js";
import { RELAY_MIGRATIONS } from "../../lib/relaystore.js";
import { displayFingerprint, pinIdentity } from "../../lib/mls/identity.js";

const [dir, point] = process.argv.slice(2);
lockStateDir(dir);
let armed = false;
const db = openRelayDb({ dir, migrations: RELAY_MIGRATIONS, fault: (p) => armed && p === point && process.kill(process.pid, "SIGKILL") });
const realm = "0".repeat(32);
const [a, b] = [`m_${"a".repeat(26)}`, `m_${"b".repeat(26)}`];
const [da, db1, db2] = [`${"a".repeat(25)}a`, `${"b".repeat(25)}a`, `${"c".repeat(25)}a`];
const directory = createDeviceDirectory({ db, realm });
const ds = createDeliveryService({ db, directory, realm });
for (const [member, device, k] of [[a, da, 1], [b, db1, 2], [b, db2, 3]]) {
  const key = Buffer.alloc(32, k);
  // A12: b's second device is approved (here by the admin) after its pending request.
  if (device === db2) {
    directory.request({ member, device, key });
    directory.adminApprove({ member, device, fingerprint: displayFingerprint({ realm, member, device, key }) });
  }
  directory.register({ member, device, key, pin: pinIdentity({ realm, member, device, key }) });
  directory.upload({ member, device, packages: [{ kp: Buffer.from(`a key package of ${device}`), notAfter: Date.now() + 86_400_000 }] });
}
const requester = { member: a, device: da };
const r1 = directory.take({ requester, request: "req-crash-1", target: { member: b, device: db1 } });
const group = "1".repeat(32);
ds.groupCreate({ requester, op: `o_${"a".repeat(26)}`, peer: b, group, epoch: 1, welcome: { recipients: [db1], mls: Buffer.from("welcome").toString("base64") }, reservations: [r1.reservation] });
const r2 = directory.take({ requester, request: "req-crash-2", target: { member: b, device: db2 } });
armed = true;
ds.sendCommit({ requester, op: `o_${"b".repeat(26)}`, group, expectedEpoch: 1, mls: Buffer.from("commit").toString("base64"), delta: { add: [db2], remove: [] }, welcome: { recipients: [db2], mls: Buffer.from("welcome2").toString("base64") }, reservations: [r2.reservation] });
process.stdout.write("survived\n");
