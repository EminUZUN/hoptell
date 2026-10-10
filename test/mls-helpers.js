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
import { createTransferStore } from "../lib/mls/relaytransfers.js";
import { RELAY_MIGRATIONS } from "../lib/relaystore.js";
import { PROOF_LABELS, b64, credentialIdentity, newDeviceId, pinIdentity, proofContent, unb64url } from "../lib/mls/identity.js";
import { newMemberId } from "../lib/relay.js";
import { createFakeDriver } from "./fake-mls-driver.js";
import { validateContacts } from "../lib/contacts.js";
import { acceptOwn, ownKeeper } from "../lib/mls/own.js";

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
export async function deviceRelay(t, { devices = true, e2ee = false, limits = {}, visible = null, access = null, members: extra = [], hosted = [], shared = null, sweepMs = 3_600_000, audit = () => {}, transfers: xfer = null, admission = {}, dsCompat = {} } = {}) {
  const dir = tmpDir(t, "hoptell-mls-relay-");
  const release = lockStateDir(dir);
  t.after(() => release());
  const c = clock();
  const realm = crypto.randomBytes(16).toString("hex");
  const members = Object.fromEntries(["alice", "bob", "carol", ...extra].map((name) => [name, { name, id: newMemberId(), token: tokenOf() }]));
  // Hosted members (design 4.5): held by host "h1", which signs in for them with `hostToken`.
  for (const name of hosted) members[name] = { name, id: newMemberId(), custody: "hosted", host: "h1" };
  const hostToken = tokenOf();
  let faultAt = null;
  let faultTimes = 0;
  // arm(point) fails the next transaction at `point`; arm(point, n) the next n (Infinity: until disarmed).
  const fault = { arm: (point, times = 1) => ((faultAt = point), (faultTimes = times)), disarm: () => (faultAt = null) };
  const open = () => openRelayDb({ dir, migrations: RELAY_MIGRATIONS, fullfsync: false, admission, fault: (p) => {
    if (faultAt === p) {
      if (--faultTimes <= 0) faultAt = null;
      throw Object.assign(new Error(`fault at ${p}`), { code: "EFAULT" });
    }
  } });
  let db = devices ? open() : null;
  let directory = db ? createDeviceDirectory({ db, realm, now: c.now }) : null;
  // Larger transfers (design 6): `transfers` is true or {limits, chunkSize} for the transfer store.
  const makeTransfers = () => (db && e2ee && xfer ? createTransferStore({ db, now: c.now, ...(xfer === true ? {} : xfer) }) : null);
  let transfers = makeTransfers();
  let ds = db && e2ee ? createDeliveryService({ db, directory, realm, now: c.now, limits, transfers, compat: dsCompat }) : null;
  const start = () => startRelay({ host: "127.0.0.1", port: 0, ...(shared ? { token: shared } : {}), members: Object.values(members), ...(hosted.length ? { hosts: [{ id: "h1", token: hostToken }] } : {}), realm: { id: realm }, devices: directory ? { directory, visible, now: c.now, ...(ds ? { ds } : {}), ...(transfers ? { transfers } : {}) } : null, ...(access ? { access: access(members) } : {}), sweepMs, pingMs: 15_000, audit, log: () => {} });
  let relay = await start();
  const clients = [];
  const w = {
    dir,
    realm,
    members,
    hostToken,
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
    get transfers() {
      return transfers;
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
    /**
     * A9: a member's client that acts for several fake devices (fakeDevice) at once, as the tests
     * before A9 did over one connection: each device gets its own connection of the member,
     * registered and attached with proofs by its key (again after a refusal not_attached, e.g. a
     * rotation dropped it). Frames without a device go to a base connection; `on` listens on all.
     * Tests of the proofs themselves use plain clients.
     */
    async member(name, opts = {}) {
      const base = await w.client(name, opts);
      const subs = new Map();
      const handlers = [];
      // One connection per device, and one attachment at a time (concurrent frames share it).
      const subOf = (device) => {
        if (!subs.has(device)) {
          subs.set(device, (async () => {
            const c = await w.client(name);
            for (const [ev, fn] of handlers) c.on(ev, fn);
            return { c, attached: false, attaching: null };
          })());
        }
        return subs.get(device);
      };
      const attach = (sub, device) => {
        sub.attaching ??= (async () => {
          const d = FAKES.get(device);
          if (!d) throw new Error(`no fake device ${device} to prove`);
          await sub.c.rpc({ type: "e2ee_attach", device, proof: await d.proof(sub.c, "attach") });
          sub.attached = true;
        })().finally(() => (sub.attaching = null));
        return sub.attaching;
      };
      const m = {
        base,
        get caps() {
          return base.caps;
        },
        get realm() {
          return base.realm;
        },
        get member() {
          return base.member;
        },
        on(ev, fn) {
          handlers.push([ev, fn]);
          base.on(ev, fn);
          for (const p of subs.values()) p.then(({ c }) => c.on(ev, fn));
          return m;
        },
        /** The connection acting for `device` (registered and attached on first use). */
        async connection(device) {
          const sub = await subOf(device);
          if (!sub.attached) await attach(sub, device);
          return sub.c;
        },
        async rpc(frame) {
          if (frame.type === "device_register") {
            const sub = await subOf(frame.device);
            const d = FAKES.get(frame.device);
            if (frame.proof !== undefined || !d || frame.rotation) return sub.c.rpc(frame);
            return sub.c.rpc({ ...frame, proof: await d.proof(sub.c, "register") });
          }
          if (frame.type === "e2ee_attach") {
            const sub = await subOf(frame.device);
            if (frame.proof !== undefined) return sub.c.rpc(frame);
            await attach(sub, frame.device);
            return { type: "e2ee_attached", device: frame.device };
          }
          const device = frame.type === "device_revoke" ? frame.by_device : frame.device;
          if (typeof device !== "string" || !FAKES.has(device) || ["device_list", "conversation", "member_of", "proof_challenge"].includes(frame.type)) return base.rpc(frame);
          const sub = await subOf(device);
          if (!sub.attached) {
            try {
              await attach(sub, device);
            } catch (e) {
              // Not attachable (another member's, revoked, unknown): the frame goes unattached and the relay answers it.
              if (e.kind !== "relay_error") throw e;
            }
          }
          try {
            return await sub.c.rpc(frame);
          } catch (e) {
            if (e.code !== "not_attached" || !sub.attached) throw e;
            sub.attached = false;
            await attach(sub, device);
            return sub.c.rpc(frame);
          }
        },
        list: () => base.list(),
        close() {
          base.close();
          for (const p of subs.values()) p.then(({ c }) => c.close());
        },
      };
      return m;
    },
    /** Restart the relay and reopen the store (as after a crash or a deploy). */
    async restart() {
      for (const rc of clients.splice(0)) rc.close();
      await relay.close();
      if (db) {
        db.close();
        db = open();
        directory = createDeviceDirectory({ db, realm, now: c.now });
        transfers = makeTransfers();
        if (e2ee) ds = createDeliveryService({ db, directory, realm, now: c.now, limits, transfers, compat: dsCompat });
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

/** Fake devices by device id, for w.member's proofs (A9). */
const FAKES = new Map();

/**
 * A9: the proof field for `purpose` ("attach", or "register" with `key`) by device `dev` of
 * (realm, member, device) on `client`'s connection: a fresh challenge, signed with the device key.
 */
export async function proveOn(client, { realm, member, device, dev, key = null }, purpose = "attach") {
  const ch = await client.rpc({ type: "proof_challenge", purpose, device, ...(purpose === "register" ? { key: b64(key) } : {}) });
  const content = proofContent({ purpose, realm, member, device, key: purpose === "register" ? Buffer.from(key) : null, conn: unb64url(client.conn, 16), challenge: unb64url(ch.challenge, 32) });
  return b64(await dev.sign(PROOF_LABELS[purpose], content));
}

/**
 * A fake-driver device of `member` in `realm`, with its register frame and KeyPackages; with A9's
 * proofs: proof(client, purpose), registerOn(client) and attachOn(client).
 */
export async function fakeDevice(realm, member, { driver = createFakeDriver({ seed: crypto.randomBytes(8).toString("hex") }), device = newDeviceId() } = {}) {
  const dev = await driver.createDevice(credentialIdentity({ realm, member, device }));
  const key = Buffer.from(dev.signaturePublicKey());
  const register = () => ({ type: "device_register", device, key: b64(key), pin: b64(pinIdentity({ realm, member, device, key })) });
  const proof = (client, purpose = "attach") => proveOn(client, { realm, member, device, dev, key }, purpose);
  const fake = {
    device,
    dev,
    driver,
    key,
    register,
    proof,
    registerOn: async (client, extra = {}) => client.rpc({ ...register(), proof: await proof(client, "register"), ...extra }),
    attachOn: async (client) => client.rpc({ type: "e2ee_attach", device, proof: await proof(client, "attach") }),
    async packages(n, notAfter) {
      const out = [];
      for (let i = 0; i < n; i++) out.push({ kp: Buffer.from(await dev.keyPackage({ lifetimeSeconds: 14 * 86400 })).toString("base64"), not_after: notAfter });
      return out;
    },
  };
  FAKES.set(device, fake);
  return fake;
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

/**
 * An in-memory contacts policy with pins (the shape lib/quarantine.js offers the e2ee layer): a
 * change is validated as the real file's is (lib/contacts.js validateContacts, the own-device
 * invariants included) and refused as a whole otherwise.
 */
export function memoryContacts(doc = { version: 1, revision: 0, default: "ask", grants: [], blocks: [] }, { file = null } = {}) {
  // `file`: the document is also kept there (loaded when it exists, written after every change),
  // for a test's child process sharing the home (test/fixtures/e2ee-crash.mjs).
  if (file && fs.existsSync(file)) doc = JSON.parse(fs.readFileSync(file, "utf8"));
  const c = {
    doc,
    currentPolicy: () => ({ doc: c.doc }),
    async updatePins(mutate) {
      const before = structuredClone(c.doc);
      let result;
      try {
        result = mutate(c.doc);
        const problems = validateContacts(c.doc);
        if (problems.length) throw new Error(problems[0]);
      } catch (e) {
        for (const k of Object.keys(c.doc)) delete c.doc[k];
        Object.assign(c.doc, before);
        throw e;
      }
      c.doc.revision++;
      if (file) fs.writeFileSync(file, JSON.stringify(c.doc));
      return { revision: c.doc.revision, result };
    },
  };
  return c;
}

/** The own-device keeper (A1) of a home on `contacts`, for deviceStore({own}). */
export const ownFor = (contacts, home, profile) => ownKeeper({ contacts, home, profile });

/**
 * The owner's two-way acceptance of own devices (A1, hoptell device accept on each): every device
 * of `devs` (test devices {store, contacts, device}, one member) accepts every other one as an own
 * pin, recorded in its own home's contacts.
 */
export async function acceptOwnDevices(...devs) {
  for (const a of devs) {
    for (const b of devs) {
      if (a === b) continue;
      const r = b.store.record();
      await a.contacts.updatePins((doc) => acceptOwn(doc, r.realm, { device: r.device, key: Buffer.from(r.key, "base64"), pin: Buffer.from(r.pin, "base64"), seq: r.seq }, { by: a.device, now: Date.now() }));
    }
  }
}

/**
 * An enrolled test device of `member` (its own home, contacts and own baseline, fake driver), with
 * e2ee engines on sessions: open(session, opts) attaches one and records its deliveries in `got`.
 */
export async function e2eeDevice(t, w, member, { sessions = [member], dir = tmpDir(t), contacts = memoryContacts(undefined, { file: path.join(dir, "contacts.json") }), profile = "relay-test", driver = createFakeDriver({ seed: `${member}-${dir}`, now: w.clock.now }), fault = null } = {}) {
  const { deviceStore } = await import("../lib/mls/device.js");
  const { createE2ee } = await import("../lib/mls/e2ee.js");
  contacts.doc.encryption ??= [{ realm: w.realm, mode: "preferred" }];
  const store = deviceStore({ home: dir, profile, driver, store: "file", passphrase: "correct horse battery staple", keychainBackend: null, machine: "m", now: w.clock.now, own: ownFor(contacts, dir, profile), fault });
  await store.enroll(await w.client(member));
  const d = { dir, store, driver, member, profile, id: w.members[member].id, device: store.record().device, contacts, s: {} };
  d.engine = (client, session, opts = {}) => {
    const got = [];
    const e2ee = createE2ee({ store, driver, client, session, home: dir, profile, contacts, deliver: async (m) => void got.push(m), now: w.clock.now, ...opts });
    t.after(() => e2ee.close());
    return { client, e2ee, got };
  };
  /** A9: a command-style (send-mode) connection of the member with this device proven on it. */
  d.proven = async () => {
    const c = await w.client(member);
    await store.attach(c);
    return c;
  };
  d.open = async (session, opts = {}) => {
    const s = d.engine(await w.client(member, { session }), session, opts);
    await s.e2ee.attach();
    d.s[session] = s;
    return s;
  };
  for (const s of sessions) await d.open(s);
  return d;
}

/** Wait until `fn()` holds (polling). */
export async function until(fn, what = "condition", ms = 4000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 30));
  }
}

/** Record fake device `d` (fakeDevice) of `member` as this home's enrolled own device in `realm` (A1). */
export async function seedOwn(contacts, realm, member, d, profile = "p") {
  const { writeBaseline } = await import("../lib/mls/own.js");
  await contacts.updatePins((doc) => void writeBaseline(doc, { rec: { realm, member, device: d.device, key: d.key.toString("base64"), seq: 0, retiredKeys: [] }, profile, now: 1 }));
}
