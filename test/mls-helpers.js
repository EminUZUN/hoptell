// Shared setup for the device-key tests (design 3.2, experimental): a relay with the device
// directory on a locked state directory, a movable clock, member clients, fake-driver devices.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RelayClient } from "../lib/client.js";
import { lockStateDir } from "../lib/realm.js";
import { openRelayDb } from "../lib/relaydb.js";
import { startRelay } from "../lib/relay.js";
import { createDeviceDirectory } from "../lib/mls/relaydir.js";
import { createDeliveryService } from "../lib/mls/relayds.js";
import { RELAY_MIGRATIONS } from "../lib/relaystore.js";
import { b64, credentialIdentity, newDeviceId, pinIdentity } from "../lib/mls/identity.js";
import { newMemberId } from "../lib/relay.js";
import { createFakeDriver } from "./fake-mls-driver.js";

export const tmpDir = (t, prefix = "hoptell-mls-") => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.chmodSync(d, 0o700);
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};

/** A clock tests move: now() and advance(ms). */
export function clock(start = Date.now()) {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms), set: (v) => (t = v) };
}

export const tokenOf = () => crypto.randomBytes(16).toString("hex");

/**
 * A relay with the device directory (unless `devices: false`), members alice, bob and carol.
 * Returns {relay, url, realm, members, directory, db, clock, fault, client(name), restart(), dir}.
 */
export async function deviceRelay(t, { devices = true, e2ee = false, limits = {}, visible = null, access = null, members: extra = [], shared = null, sweepMs = 3_600_000, audit = () => {} } = {}) {
  const dir = tmpDir(t, "hoptell-mls-relay-");
  const release = lockStateDir(dir);
  t.after(() => release());
  const c = clock();
  const realm = crypto.randomBytes(16).toString("hex");
  const members = Object.fromEntries(["alice", "bob", "carol", ...extra].map((name) => [name, { name, id: newMemberId(), token: tokenOf() }]));
  let faultAt = null;
  let faultTimes = 0;
  // arm(point) fails the next transaction at `point`; arm(point, n) the next n (Infinity: until disarmed).
  const fault = { arm: (point, times = 1) => ((faultAt = point), (faultTimes = times)), disarm: () => (faultAt = null) };
  const open = () => openRelayDb({ dir, migrations: RELAY_MIGRATIONS, fullfsync: false, fault: (p) => {
    if (faultAt === p) {
      if (--faultTimes <= 0) faultAt = null;
      throw Object.assign(new Error(`fault at ${p}`), { code: "EFAULT" });
    }
  } });
  let db = devices ? open() : null;
  let directory = db ? createDeviceDirectory({ db, realm, now: c.now }) : null;
  let ds = db && e2ee ? createDeliveryService({ db, directory, realm, now: c.now, limits }) : null;
  const start = () => startRelay({ host: "127.0.0.1", port: 0, ...(shared ? { token: shared } : {}), members: Object.values(members), realm: { id: realm }, devices: directory ? { directory, visible, ...(ds ? { ds } : {}) } : null, ...(access ? { access: access(members) } : {}), sweepMs, audit, log: () => {} });
  let relay = await start();
  const clients = [];
  const w = {
    dir,
    realm,
    members,
    clock: c,
    fault,
    get relay() {
      return relay;
    },
    get db() {
      return db;
    },
    get directory() {
      return directory;
    },
    get ds() {
      return ds;
    },
    get url() {
      return `ws://127.0.0.1:${relay.port}`;
    },
    /** A send-only protocol-2 client of member `name` (or the shared token: name null). */
    async client(name, { token = members[name]?.token, session = null } = {}) {
      const rc = new RelayClient({ url: w.url, token, name: session ?? `${name ?? "shared"}-cli-${clients.length}`, mode: session ? "peer" : "send", reconnect: false });
      clients.push(rc);
      rc.on("error", () => {});
      rc.start();
      await rc.ready(5000);
      return rc;
    },
    /** Restart the relay and reopen the store (as after a crash or a deploy). */
    async restart() {
      for (const rc of clients.splice(0)) rc.close();
      await relay.close();
      if (db) {
        db.close();
        db = open();
        directory = createDeviceDirectory({ db, realm, now: c.now });
        if (e2ee) ds = createDeliveryService({ db, directory, realm, now: c.now, limits });
      }
      relay = await start();
    },
  };
  t.after(async () => {
    for (const rc of clients) rc.close();
    await relay.close();
    db?.close();
  });
  return w;
}

/** A fake-driver device of `member` in `realm`, with its register frame and KeyPackages. */
export async function fakeDevice(realm, member, { driver = createFakeDriver({ seed: crypto.randomBytes(8).toString("hex") }), device = newDeviceId() } = {}) {
  const dev = await driver.createDevice(credentialIdentity({ realm, member, device }));
  const key = Buffer.from(dev.signaturePublicKey());
  return {
    device,
    dev,
    driver,
    key,
    register: () => ({ type: "device_register", device, key: b64(key), pin: b64(pinIdentity({ realm, member, device, key })) }),
    async packages(n, notAfter) {
      const out = [];
      for (let i = 0; i < n; i++) out.push({ kp: Buffer.from(await dev.keyPackage({ lifetimeSeconds: 14 * 86400 })).toString("base64"), not_after: notAfter });
      return out;
    },
  };
}

/** The relay's error for a frame (the rpc rejects with kind "relay_error"). */
export async function refusal(promise) {
  try {
    const r = await promise;
    throw Object.assign(new Error(`expected a refusal, got ${JSON.stringify(r).slice(0, 200)}`), { unexpected: true });
  } catch (e) {
    if (e.unexpected) throw e;
    return { code: e.code, message: e.message };
  }
}

/** A new operation id (o_ and 26 base32 characters). */
export { newOpId as newOp } from "../lib/mls/e2ee.js";

/** An in-memory contacts policy with pins (the shape lib/quarantine.js offers the e2ee layer). */
export function memoryContacts(doc = { version: 1, revision: 0, default: "ask", grants: [], blocks: [] }) {
  return {
    doc,
    currentPolicy: () => ({ doc }),
    async updatePins(mutate) {
      const result = mutate(doc);
      doc.revision++;
      return { revision: doc.revision, result };
    },
  };
}
