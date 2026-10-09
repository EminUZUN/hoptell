// This home's MLS device for one relay profile (design 3.2, "Identities", "KeyPackages", "Device
// lifecycle", "Backup and restore"). EXPERIMENTAL: reached only with HOPTELL_EXPERIMENTAL_E2EE=1,
// and only through lib/mls/driver.js (no library is imported here).
//
// Storage: <home>/mls/<profile>/device.json, one record written durably as a whole (the public
// identity, the KeyPackage ledger, the rotation chain, and the library's exported state encrypted
// with AES-256-GCM). Its 32-byte key is the secret: it is kept in the 1.6 credential store (the OS
// keychain, or the encrypted file the owner chose), account "d_<digest>". The library keeps the
// signature private key inside its own state ([lib]: OpenMLS has no separate key export), so the
// keychain holds the key that opens that state, not the signature key itself.
//
// Discipline (gate 5): one writer per device (<dir>/device.json.lock for every operation); state
// is durable before anything is published (KeyPackages before kp_upload, a new key before its
// registration); a Welcome's group state, consumed private key and replay record land in one write
// before it is acknowledged; a restored or migrated state is marked retired before any other
// operation. The record names the machine it was made on: state found on another machine refuses
// to publish or send until it goes through `hoptell device restore`. That catches some copies; it
// is not a freshness anchor (a same-machine raw rollback of ~/.hoptell is not detected: see
// SECURITY.md and hoptell doctor).
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ensurePrivateDir } from "../config.js";
import { credentialStore, writeDurable } from "../credentials.js";
import { withLock } from "../locks.js";
import { checkDevice } from "./driver.js";
import { b64, credentialIdentity, displayFingerprint, makeRevocation, makeRotation, newDeviceId, pinIdentity, unb64 } from "./identity.js";
import { KP_LIFETIME_MS, KP_MAX_PER_DEVICE, WELCOME_REPLAY_KEEP_MS, replenishCount } from "./policy.js";

const PROFILE_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
export class DeviceError extends Error {
  constructor(message, code = "device") {
    super(message);
    this.code = code;
  }
}

let cachedMachine = null;
/**
 * A machine identifier (a digest; never the raw id): IOPlatformUUID on macOS, /etc/machine-id on
 * Linux, else the host name. HOPTELL_MACHINE_ID overrides it (tests).
 */
export function machineId(env = process.env) {
  if (env.HOPTELL_MACHINE_ID) return crypto.createHash("sha256").update(`hoptell-machine|${env.HOPTELL_MACHINE_ID}`).digest("hex").slice(0, 32);
  if (cachedMachine) return cachedMachine;
  let raw = null;
  try {
    if (process.platform === "darwin") {
      const r = spawnSync("ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], { encoding: "utf8", timeout: 5000 });
      raw = /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(r.stdout ?? "")?.[1] ?? null;
    } else if (process.platform === "linux") {
      for (const f of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
        try {
          raw = fs.readFileSync(f, "utf8").trim() || null;
          if (raw) break;
        } catch {}
      }
    }
  } catch {}
  return (cachedMachine = crypto.createHash("sha256").update(`hoptell-machine|${raw ?? `host:${os.hostname()}`}`).digest("hex").slice(0, 32));
}

export const deviceDir = (home, profile) => path.join(home, "mls", profile);

/**
 * The device store of `home` for relay profile `profile`, using MLS driver `driver`. Credential
 * store options as for sign-in (store "auto" | "file", passphrase, keychainBackend). `fault(point)`
 * is for tests (thrown before a durable step); `now()` the clock.
 */
export function deviceStore({ home, profile, driver, store = "auto", passphrase = null, keychainBackend, machine = machineId(), now = () => Date.now(), fault = null }) {
  if (!PROFILE_RE.test(profile ?? "")) throw new Error("invalid relay profile name");
  const dir = () => {
    ensurePrivateDir(path.join(ensurePrivateDir(home), "mls"));
    return ensurePrivateDir(deviceDir(home, profile));
  };
  const file = () => path.join(dir(), "device.json");
  const archive = (device) => path.join(dir(), `retired-${device}.json`);
  const accountOf = (device) => `d_${crypto.createHash("sha256").update(JSON.stringify([path.resolve(home), profile, device])).digest("hex").slice(0, 32)}`;
  const creds = (account) => credentialStore(home, account, { store, passphrase, ...(keychainBackend !== undefined ? { keychainBackend } : {}) });

  const read = (f = file()) => {
    let text;
    try {
      text = fs.readFileSync(f, "utf8");
    } catch (e) {
      if (e.code === "ENOENT") return null;
      throw new DeviceError(`the device record ${f} cannot be read (${e.code})`);
    }
    try {
      const rec = JSON.parse(text);
      if (rec?.v !== 1) throw new Error();
      return rec;
    } catch {
      throw new DeviceError(`the device record ${f} is damaged; restore it from a backup (hoptell device restore) or enroll a new device`);
    }
  };
  const write = (rec, f = file()) => {
    fault?.("device-write", f);
    writeDurable(f, `${JSON.stringify(sealE2ee(rec))}\n`);
  };
  // 3.3's records (rec.e2ee: committer bundles, decrypted messages awaiting acknowledgement,
  // replay records) are sealed like the library state, in the same write.
  const sealE2ee = (rec) => {
    if (rec.e2ee === undefined) return rec;
    const out = { ...rec, e2eeSealed: seal(rec, Buffer.from(JSON.stringify(rec.e2ee))) };
    delete out.e2ee;
    return out;
  };
  const openE2ee = (rec) => {
    if (rec?.e2eeSealed) {
      rec.e2ee = JSON.parse(open(rec, rec.e2eeSealed).toString("utf8"));
      delete rec.e2eeSealed;
    }
    return rec;
  };

  // ---- the encrypted library state ------------------------------------------------------------

  const keyCache = new Map();
  function stateKey(rec, create = false) {
    if (keyCache.has(rec.account)) return keyCache.get(rec.account);
    const c = creds(rec.account);
    let v = c.read();
    if (!v && create) {
      v = { kind: "device", key: crypto.randomBytes(32).toString("base64") };
      c.write(v);
    }
    const key = v?.kind === "device" ? unb64(v.key, 32) : null;
    if (!key) throw new DeviceError(`the key of this device's state is not in the ${c.kind} (another machine, or a removed credential); restore it with hoptell device restore`, "no_state_key");
    keyCache.set(rec.account, key);
    return key;
  }
  const aad = (rec) => Buffer.from(`hoptell-device-state|${profile}|${rec.device}`);
  function seal(rec, bytes, key = stateKey(rec)) {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv("aes-256-gcm", key, iv);
    c.setAAD(aad(rec));
    const data = Buffer.concat([c.update(bytes), c.final()]);
    return { iv: b64(iv), tag: b64(c.getAuthTag()), data: b64(data) };
  }
  function open(rec, sealed = rec.state, key = stateKey(rec)) {
    try {
      const d = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(sealed.iv, "base64"));
      d.setAAD(aad(rec));
      d.setAuthTag(Buffer.from(sealed.tag, "base64"));
      return Buffer.concat([d.update(Buffer.from(sealed.data, "base64")), d.final()]);
    } catch {
      throw new DeviceError("this device's state cannot be decrypted (a changed file or another key)", "bad_state");
    }
  }
  async function load(rec) {
    const dev = checkDevice(await driver.importDevice(open(rec), { identity: credentialIdentity(rec), now }));
    if (!Buffer.from(dev.signaturePublicKey()).equals(Buffer.from(rec.key, "base64"))) throw new DeviceError("this device's state does not hold its enrolled key", "bad_state");
    return dev;
  }
  async function saveWith(rec, dev) {
    rec.state = seal(rec, Buffer.from(await dev.exportState()));
    write(rec);
  }

  // ---- checks ----------------------------------------------------------------------------------

  const locked = (fn) => withLock(path.join(dir(), "device.json"), fn, { waitMs: 10_000 });
  const local = (rec) => rec.machine === machine;
  /** Whether this device may publish or send now; else the reason. */
  function mayAct(rec) {
    if (!rec) return "this home has no device for this relay yet: hoptell device enroll";
    if (rec.status === "retired") return `this device is retired (${rec.retiredWhy ?? "retired"}); it may read what it can still decrypt, never send: enroll a new device`;
    if (rec.status === "revoked") return "this device was revoked; enroll a new device";
    if (rec.pendingRevocation) return `this device's revocation is not confirmed by the relay yet; finish it with hoptell device revoke ${rec.pendingRevocation.target}`;
    if (!local(rec)) return "this device's state was made on another machine and cannot send here; bring it over with hoptell device restore (it is then retired) and enroll this machine";
    return null;
  }
  const must = (rec) => {
    const why = mayAct(rec);
    if (why) throw new DeviceError(why, "not_allowed");
    return rec;
  };
  /** The relay client must authenticate the member and realm this device belongs to. */
  const sameIdentity = (rec, client) => {
    if (client.realm?.id !== rec.realm || (client.member?.id ?? null) !== rec.member) {
      throw new DeviceError(`this device belongs to member ${rec.member} of realm ${rec.realm}; the relay now authenticates ${client.member?.id ?? "no member"} of realm ${client.realm?.id}`, "identity_changed");
    }
  };
  const ask = async (client, frame) => {
    try {
      return await client.rpc(frame);
    } catch (e) {
      throw Object.assign(new DeviceError(e.message, e.code ?? e.kind ?? "relay"), { kind: e.kind });
    }
  };

  // ---- the ledger of this device's KeyPackages (the Welcome replay record) -----------------------

  function pruneLedger(rec) {
    const t = now();
    for (const [ref, e] of Object.entries(rec.kps)) if (e.notAfter + WELCOME_REPLAY_KEEP_MS <= t) delete rec.kps[ref];
  }

  /**
   * Publish KeyPackages when the pool runs low (or `force` a count). The packages and their private
   * keys are durable before the upload; an upload whose answer was lost is repeated with the same
   * bytes (the relay ignores duplicates). Returns {published, available}.
   */
  async function replenishLocked(rec, client, { force = null } = {}) {
    must(rec);
    // An unfinished rotation: the old key's packages are never published again, and the new key
    // publishes only once the relay took it (rotate() resumes it).
    if (rec.pendingRotation) throw new DeviceError("a key rotation is not finished; finish it with hoptell device rotate", "rotation_pending");
    // Packages made but not confirmed as published are offered again first.
    let pending = rec.unpublished ?? [];
    if (!pending.length) {
      const st = await ask(client, { type: "kp_status", device: rec.device });
      const n = force ?? replenishCount({ available: st.available, reserved: st.reserved, oldestExpires: st.oldest_expires }, { now: now(), lastAt: rec.lastReplenish ?? 0 });
      if (!n) return { published: 0, available: st.available };
      const dev = await load(rec);
      const lifetimeSeconds = Math.floor(KP_LIFETIME_MS / 1000);
      for (let i = 0; i < n; i++) {
        const kp = Buffer.from(await dev.keyPackage({ lifetimeSeconds }));
        const notAfter = now() + KP_LIFETIME_MS;
        const ref = crypto.createHash("sha256").update(kp).digest("hex");
        // The library's own reference of the package: a Welcome is matched to it (acceptWelcome).
        const libRef = driver.inspectKeyPackage(kp, { now: now() }).ref;
        rec.kps[ref] = { notAfter, state: "open", ...(libRef ? { libRef: Buffer.from(libRef).toString("hex") } : {}) };
        pending.push({ kp: kp.toString("base64"), not_after: notAfter });
      }
      pruneLedger(rec);
      rec.unpublished = pending;
      rec.lastReplenish = now();
      await saveWith(rec, dev);
    }
    const r = await ask(client, { type: "kp_upload", device: rec.device, packages: pending });
    rec.unpublished = [];
    write(rec);
    return { published: r.accepted, available: r.available };
  }

  /**
   * A Welcome for KeyPackage `ref`, inside the lock (nothing is written here): an unknown, used
   * or expired package is refused, and so is a Welcome that consumes another package than `ref`;
   * `validate({groupId, members, ref})` may refuse the staged group by throwing. A refused or
   * failed Welcome leaves the private key in place. Returns the group id; the caller persists
   * group state, consumed key and replay record in one write.
   */
  async function welcomeLocked(rec, dev, ref, welcome, { ratchetTree, validate = null } = {}) {
    const e = Object.hasOwn(rec.kps, ref) ? rec.kps[ref] : null;
    if (!e) throw new DeviceError("a Welcome for an unknown KeyPackage is refused", "unknown_key_package");
    if (e.state === "used") throw new DeviceError("a Welcome for a KeyPackage already used is refused (replay)", "replayed_welcome");
    if (e.notAfter <= now()) throw new DeviceError("a Welcome for an expired KeyPackage is refused", "expired_key_package");
    const staged = await dev.stageWelcome(welcome, ratchetTree);
    let group;
    try {
      const consumed = staged.keyPackageRef ? Buffer.from(staged.keyPackageRef).toString("hex") : null;
      if (!e.libRef || consumed !== e.libRef) throw new DeviceError("the Welcome is for another KeyPackage than the one named; refused", "key_package_mismatch");
      if (validate) await validate({ groupId: staged.groupId, members: staged.members, ref });
      group = await staged.finish();
    } catch (err) {
      await staged.discard().catch(() => {});
      throw err;
    }
    e.state = "used";
    e.usedAt = now();
    return group;
  }

  /** Register (or confirm) this record at the relay, then mark it active. */
  async function registerLocked(rec, client) {
    const r = await ask(client, { type: "device_register", device: rec.device, key: rec.key, pin: rec.pin });
    if (rec.status !== "active") {
      rec.status = "active";
      rec.enrolledAt = now();
      write(rec);
    }
    return r;
  }

  return {
    dir: () => deviceDir(home, profile),
    /** The public record (never the state), or null. */
    record() {
      const rec = read();
      if (!rec) return null;
      const pub = { ...rec };
      delete pub.state;
      delete pub.e2eeSealed;
      delete pub.unpublished;
      delete pub.pendingRotation;
      delete pub.pendingRevocation;
      return { ...pub, local: local(rec), fingerprint: displayFingerprint({ realm: rec.realm, member: rec.member, device: rec.device, key: Buffer.from(rec.key, "base64") }), mayAct: mayAct(rec) };
    },
    mayAct: () => mayAct(read()),

    /**
     * Enroll this home for the relay `client` is connected to (protocol 2, a member credential):
     * a new key and device id, durable first, then registered with the relay and KeyPackages
     * published. Running it again resumes an interrupted enrollment and tops up the pool. A
     * retired device is archived (still readable) and a new one enrolled.
     */
    enroll(client) {
      return locked(async () => {
        if (!client.realm?.id || !client.member?.id) throw new DeviceError("devices need a protocol-2 relay and a member credential (a member token or sign-in)", "member_only");
        let rec = read();
        if (rec && rec.status !== "retired" && rec.status !== "revoked") {
          sameIdentity(rec, client);
          must(rec);
          if (rec.pendingRotation) throw new DeviceError("a key rotation is not finished; finish it with hoptell device rotate", "rotation_pending");
          await registerLocked(rec, client);
          return { created: false, ...(await replenishLocked(rec, client)), device: rec.device };
        }
        if (rec) {
          // The old state stays readable in its archive; it can never send again.
          write({ ...rec, status: "retired", retiredWhy: rec.retiredWhy ?? rec.status }, archive(rec.device));
        }
        const device = newDeviceId();
        const identity = { realm: client.realm.id, member: client.member.id, device };
        const dev = checkDevice(await driver.createDevice(credentialIdentity(identity)));
        const key = Buffer.from(dev.signaturePublicKey());
        rec = {
          v: 1,
          ...identity,
          key: b64(key),
          pin: b64(pinIdentity({ ...identity, key })),
          seq: 0,
          retiredKeys: [],
          status: "pending",
          machine,
          created: now(),
          driver: { name: driver.name, version: driver.version, suite: driver.suite },
          account: accountOf(device),
          kps: {},
          unpublished: [],
        };
        rec.state = seal(rec, Buffer.from(await dev.exportState()), stateKey(rec, true));
        write(rec); // the key exists durably before the relay hears of it
        await registerLocked(rec, client);
        return { created: true, ...(await replenishLocked(rec, client)), device };
      });
    },

    /** Top up the KeyPackage pool when it is low (or publish `force` more). */
    replenish(client, opts) {
      return locked(async () => {
        const rec = must(read());
        sameIdentity(rec, client);
        if (rec.status === "pending") await registerLocked(rec, client);
        return replenishLocked(rec, client, opts);
      });
    },

    /**
     * Process a Welcome for KeyPackage `ref` (3.3 calls this with the joiner's group logic; 3.2
     * provides the replay record): an unknown, used or expired package is refused; the package the
     * library actually consumed must be `ref` (a Welcome for another package is refused); then
     * `validate({groupId, members, ref})` (3.3's check of the staged group, awaited) may refuse it
     * by throwing. A Welcome refused anywhere (or that fails to finish) leaves the private key in
     * place; a successful one persists the group state, the consumed private key and the replay
     * record in one write, before the caller acknowledges it.
     */
    acceptWelcome(ref, welcome, { ratchetTree, validate = null } = {}) {
      return locked(async () => {
        const rec = must(read()); // joining is taking part: a retired or foreign state never does
        const dev = await load(rec);
        const group = await welcomeLocked(rec, dev, ref, welcome, { ratchetTree, validate });
        await saveWith(rec, dev); // one write: group state, consumed key, replay record
        return { group: Buffer.from(group).toString("hex") };
      });
    },

    /**
     * 3.3's one state writer: run `fn(ctx)` under this device's lock with the record and the
     * library state loaded, ctx = {rec, dev, save(), write(), acceptWelcome(ref, welcome,
     * {ratchetTree, validate})} (as acceptWelcome, without its write). save() writes the library state and the record (with whatever fn put
     * in rec.e2ee) as one durable write; nothing fn changed is kept unless it calls save(). `act`
     * (the default) refuses a retired, revoked or foreign device; receiving passes act: false (a
     * retired device may read what it can still decrypt).
     */
    transact(fn, { act = true } = {}) {
      return locked(async () => {
        const rec = openE2ee(act ? must(read()) : read());
        if (!rec) throw new DeviceError("this home has no device for this relay yet: hoptell device enroll", "not_allowed");
        const dev = await load(rec);
        return fn({
          rec,
          dev,
          save: () => saveWith(rec, dev),
          write: () => write(rec),
          acceptWelcome: (ref, welcome, opts) => {
            must(rec);
            return welcomeLocked(rec, dev, ref, welcome, opts);
          },
        });
      });
    },

    /**
     * A planned rotation: a new signature key, a statement signed by the old key and the new one
     * (sequence + 1), durable as pending before the relay hears of it, then registered; the relay
     * serves the chain to peers, who accept it without a stop.
     *
     * 3.2 only: the new key comes with a new library state, which replaces the old one. That is
     * right while the device has no groups; before 3.3 it needs a library operation that changes
     * the signature key in place (an Update with the new key in every group), which the OpenMLS
     * binding does not offer yet.
     */
    rotate(client) {
      return locked(async () => {
        const rec = must(read());
        sameIdentity(rec, client);
        if (!rec.pendingRotation) {
          // 3.3: the new key comes with a new library state, which would drop every group. Until
          // the library can change the key in place in each group (manifest 3), a device with
          // encrypted conversations does not rotate.
          const groups = Object.values(openE2ee({ ...rec }).e2ee?.groups ?? {}).filter((g) => g.state === "active");
          if (groups.length) throw new DeviceError(`this device has ${groups.length} encrypted conversation(s); a planned rotation would end them (the library cannot change the key in place yet; experimental)`, "rotation_unsupported");
          const old = await load(rec);
          const next = checkDevice(await driver.createDevice(credentialIdentity(rec)));
          const newKey = Buffer.from(next.signaturePublicKey());
          const statement = await makeRotation({ realm: rec.realm, member: rec.member, device: rec.device, oldKey: Buffer.from(rec.key, "base64"), newKey, sequence: rec.seq + 1 }, (l, c) => old.sign(l, c), (l, c) => next.sign(l, c));
          rec.pendingRotation = { statement, state: seal(rec, Buffer.from(await next.exportState())) };
          write(rec);
        }
        const { statement } = rec.pendingRotation;
        const key = Buffer.from(statement.new_key, "base64");
        await ask(client, { type: "device_register", device: rec.device, key: statement.new_key, pin: b64(pinIdentity({ realm: rec.realm, member: rec.member, device: rec.device, key })), rotation: statement });
        rec.retiredKeys = [...(rec.retiredKeys ?? []), Buffer.from(rec.key, "base64").toString("hex")];
        rec.rotations = [...(rec.rotations ?? []), statement].slice(-10);
        rec.key = statement.new_key;
        rec.pin = b64(pinIdentity({ realm: rec.realm, member: rec.member, device: rec.device, key }));
        rec.seq = statement.sequence;
        rec.state = rec.pendingRotation.state;
        rec.rotatedAt = now();
        // The old key's packages retire with the old state, in this write: the relay dropped the
        // published ones, and the unpublished batch is never offered again (it is signed by the
        // retired key). Packages come from the new state only.
        rec.kps = {};
        rec.unpublished = [];
        delete rec.pendingRotation;
        write(rec);
        // The relay dropped the old key's pool: a full one is published at once.
        return { seq: rec.seq, ...(await replenishLocked(rec, client, { force: KP_MAX_PER_DEVICE })) };
      });
    },

    /**
     * Revoke device `target` of this member, from this device (a signed statement): the relay stops
     * serving it at once. Revoking this device itself first persists the signed statement as
     * pending, which stops every other operation; only that same revocation is sent again (after a
     * lost answer or a restart) until the relay confirms it, and then the device is revoked here.
     */
    revoke(client, target) {
      return locked(async () => {
        let rec = read();
        const resuming = Boolean(rec?.pendingRevocation);
        if (resuming && rec.pendingRevocation.target !== target) throw new DeviceError(`this device's own revocation is not finished: hoptell device revoke ${rec.pendingRevocation.target}`, "not_allowed");
        if (!resuming) must(rec);
        sameIdentity(rec, client);
        if (!resuming && rec.pendingRotation) throw new DeviceError("a key rotation is not finished; finish it with hoptell device rotate", "rotation_pending");
        let statement = rec.pendingRevocation?.statement;
        if (!statement) {
          const dev = await load(rec);
          statement = await makeRevocation({ realm: rec.realm, member: rec.member, device: target, by: rec.device, at: now() }, (l, c) => dev.sign(l, c));
          if (target === rec.device) {
            rec.pendingRevocation = { target, statement };
            write(rec); // durable before the relay hears of it
          }
        }
        const r = await ask(client, { type: "device_revoke", device: target, by_device: rec.device, statement });
        if (target === rec.device) {
          rec = read();
          rec.status = "revoked";
          rec.revokedAt = r.at ?? now();
          delete rec.pendingRevocation;
          write(rec);
        }
        return r;
      });
    },

    /** Mark this device retired durably (it reads, never sends); `why` is recorded. */
    retire(why) {
      return locked(async () => {
        const rec = read();
        if (!rec) throw new DeviceError("no device to retire", "not_allowed");
        rec.status = "retired";
        rec.retiredWhy = why;
        rec.retiredAt = now();
        write(rec);
        return { device: rec.device };
      });
    },

    /**
     * A backup of this device: the record and its state key, wrapped under `backupPassphrase`
     * (scrypt, AES-256-GCM). It restores only as a retired device.
     */
    backup(target, backupPassphrase) {
      return locked(async () => {
        const rec = read();
        if (!rec) throw new DeviceError("no device to back up", "not_allowed");
        if (!backupPassphrase || backupPassphrase.length < 12) throw new DeviceError("a backup needs a passphrase of at least 12 characters (HOPTELL_CREDENTIAL_PASSPHRASE)", "bad_request");
        const salt = crypto.randomBytes(16);
        const iv = crypto.randomBytes(12);
        const c = crypto.createCipheriv("aes-256-gcm", crypto.scryptSync(backupPassphrase, salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }), iv);
        c.setAAD(Buffer.from("hoptell-device-backup-v1"));
        const data = Buffer.concat([c.update(JSON.stringify({ record: rec, key: b64(stateKey(rec)) })), c.final()]);
        writeDurable(target, `${JSON.stringify({ v: 1, kind: "hoptell-device-backup", salt: b64(salt), iv: b64(iv), tag: b64(c.getAuthTag()), data: b64(data) })}\n`);
        return { device: rec.device };
      });
    },

    /**
     * The supported restore path: the backup's device is written here **retired** (before anything
     * else can use it) under its own archive name, readable but never sending; the owner enrolls a
     * new device for sending. Returns {device}.
     */
    restore(source, backupPassphrase) {
      return locked(async () => {
        let b;
        try {
          b = JSON.parse(fs.readFileSync(source, "utf8"));
        } catch {
          throw new DeviceError(`${source} is not a device backup`, "bad_request");
        }
        if (b?.v !== 1 || b.kind !== "hoptell-device-backup") throw new DeviceError(`${source} is not a device backup`, "bad_request");
        let inner;
        try {
          const d = crypto.createDecipheriv("aes-256-gcm", crypto.scryptSync(backupPassphrase ?? "", Buffer.from(b.salt, "base64"), 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }), Buffer.from(b.iv, "base64"));
          d.setAAD(Buffer.from("hoptell-device-backup-v1"));
          d.setAuthTag(Buffer.from(b.tag, "base64"));
          inner = JSON.parse(Buffer.concat([d.update(Buffer.from(b.data, "base64")), d.final()]).toString("utf8"));
        } catch {
          throw new DeviceError("the backup cannot be decrypted (wrong passphrase, or the file changed)", "bad_request");
        }
        const rec = { ...inner.record, status: "retired", retiredWhy: "restored from a backup", retiredAt: now(), unpublished: [] };
        if (rec.v !== 1 || !rec.device) throw new DeviceError("the backup holds no device", "bad_request");
        const current = read();
        // Retired first, durably, under the archive name: nothing can send with it, ever.
        write(rec, current?.device === rec.device ? file() : archive(rec.device));
        creds(rec.account).write({ kind: "device", key: inner.key });
        keyCache.delete(rec.account);
        return { device: rec.device };
      });
    },

    /** The archived (retired) devices of this profile. */
    retired() {
      const d = deviceDir(home, profile);
      if (!fs.existsSync(d)) return [];
      return fs.readdirSync(d).filter((f) => /^retired-[a-z2-7]{26}\.json$/.test(f)).map((f) => {
        const r = read(path.join(d, f));
        return { device: r.device, retiredWhy: r.retiredWhy, retiredAt: r.retiredAt };
      });
    },
  };
}
