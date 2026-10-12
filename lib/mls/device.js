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
import { canPrune, checkDevice, signingRefusal } from "./driver.js";
import { APPROVAL_MAX_S, PROOF_LABELS, b64, checkApproval, credentialIdentity, displayFingerprint, makeApproval, makeRevocation, makeRotation, newDeviceId, pinIdentity, proofContent, readApproval, unb64, unb64url } from "./identity.js";
import { ATTACH_PROOF_CAP } from "./relayproof.js";
import { KP_LIFETIME_MS, KP_MAX_PER_DEVICE, WELCOME_REPLAY_KEEP_MS, replenishCount } from "./policy.js";

const PROFILE_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
/** A10: an unused KeyPackage's private keys are deleted this long after its expiry. */
export const PRUNE_GRACE_S = 86_400;
/** A10: pruned refs with no ledger entry, kept for hoptell doctor only (never authority). */
const ORPHANS_KEPT = 100;
const sha256hex = (b) => crypto.createHash("sha256").update(b).digest("hex");
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
 * is for tests (thrown before a durable step); `now()` the clock. `own` is the home's own-device
 * keeper (lib/mls/own.js ownKeeper): enrollment writes the baseline through it (design 3.2 v2.2,
 * A1), and nothing registers with the relay without that baseline.
 */
// A12: how often a new device asks whether it was approved, and how long enroll waits for that.
export const APPROVAL_POLL_MS = 3000;
export const APPROVAL_WAIT_MS = 15 * 60_000;
// A12: the registration's refusals that mean "wait for an approval".
const APPROVAL_WAIT = new Set(["approval_required", "approval_invalid", "approval_expired"]);
// The relay's answers to an outbox approval that end its entry: confirmed, or never to be. A
// bad_approval stays (one issued ahead of the relay's clock becomes valid); every entry ends at
// its own expiry.
const APPROVAL_FINAL = new Set(["no_request", "approval_expired", "key_mismatch", "device_revoked", "request_gone"]);

export function deviceStore({ home, profile, driver, store = "auto", passphrase = null, keychainBackend, machine = machineId(), now = () => Date.now(), fault = null, own = null, approvalPollMs = APPROVAL_POLL_MS, approvalWaitMs = APPROVAL_WAIT_MS }) {
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
  const hexSuite = (n) => `0x${Number(n).toString(16).padStart(4, "0")}`;
  /**
   * A5: the suite this device was enrolled with must be the driver's (the post-quantum 0x004D in
   * production). A mismatch is refused: devices do not change suite in place; the migration is a
   * re-enrollment (a new device, which peers see as new).
   */
  function checkSuite(rec) {
    const stored = rec?.driver?.suite;
    if (stored === undefined || stored === driver.suite) return;
    throw new DeviceError(`this device was enrolled with MLS suite ${hexSuite(stored)}, and this MLS binding uses ${hexSuite(driver.suite)}: it cannot be loaded; migrate by re-enrolling (hoptell device retire, then hoptell device enroll)`, "suite_mismatch");
  }
  async function load(rec) {
    checkSuite(rec);
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
  /**
   * The own baseline of record `rec` (A1, enrollment step 2): written under the contacts lock, or
   * confirmed; a crash before it resumes here from the same local record. Nothing is registered
   * with the relay, published or sent for a profile without it.
   */
  async function baseline(rec, opts) {
    if (!own) throw new DeviceError("this home keeps no own-device baseline (managed contacts are needed: hoptell contacts init); nothing is enrolled", "no_baseline");
    fault?.("before-baseline", rec.device);
    try {
      await own.ensure(rec, opts);
    } catch (e) {
      throw new DeviceError(e.message, e.code ?? "no_baseline");
    }
    fault?.("after-baseline", rec.device);
  }

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
   * A10: delete the private keys of expired, unused KeyPackages from the library state `dev` (in
   * memory: the caller's one save writes the library state and the ledger together). Each ref the
   * library returns is mapped through the ledger's libRef: that entry becomes "pruned" and leaves
   * `unpublished` (never uploaded again); a ref without an entry goes to the bounded audit list
   * rec.prunedOrphans (doctor only), never to the ledger. Null without the driver's pruning.
   */
  async function pruneLocked(rec, dev) {
    if (!canPrune(driver)) return null;
    const t = now();
    const refs = await driver.pruneKeyPackages(dev, { nowSeconds: Math.floor(t / 1000), graceSeconds: PRUNE_GRACE_S });
    if (!refs?.length) return { pruned: 0, orphans: 0, changed: false };
    const byLib = new Map(Object.entries(rec.kps ?? {}).filter(([, e]) => e.libRef).map(([ref, e]) => [e.libRef, ref]));
    const gone = new Set();
    const orphans = [];
    for (const r of refs) {
      const hex = Buffer.from(r).toString("hex");
      const ref = byLib.get(hex);
      if (!ref) {
        orphans.push({ ref: hex, at: t });
        continue;
      }
      gone.add(ref);
      const e = rec.kps[ref];
      if (e.state === "open") Object.assign(e, { state: "pruned", prunedAt: t });
    }
    if (gone.size) rec.unpublished = (rec.unpublished ?? []).filter((p) => !gone.has(sha256hex(Buffer.from(p.kp, "base64"))));
    if (orphans.length) rec.prunedOrphans = [...(rec.prunedOrphans ?? []), ...orphans].slice(-ORPHANS_KEPT);
    return { pruned: gone.size, orphans: orphans.length, changed: true };
  }

  /**
   * Publish KeyPackages when the pool runs low (or `force` a count). The packages and their private
   * keys are durable before the upload; an upload whose answer was lost is repeated with the same
   * bytes (the relay ignores duplicates). Expired, unused private keys are pruned first (A10), in
   * the same save. The connection must be attached (A9). Returns {published, available}.
   */
  async function replenishLocked(rec, client, { force = null } = {}) {
    must(rec);
    // An unfinished rotation: the old key's packages are never published again, and the new key
    // publishes only once the relay took it (rotate() resumes it).
    if (rec.pendingRotation) throw new DeviceError("a key rotation is not finished; finish it with hoptell device rotate", "rotation_pending");
    const dev = await load(rec);
    const pruned = await pruneLocked(rec, dev);
    // Packages made but not confirmed as published are offered again first (a pruned one never).
    let pending = rec.unpublished ?? [];
    if (pending.length && pruned?.changed) await saveWith(rec, dev);
    if (!pending.length) {
      const st = await ask(client, { type: "kp_status", device: rec.device });
      const n = force ?? replenishCount({ available: st.available, reserved: st.reserved, oldestExpires: st.oldest_expires }, { now: now(), lastAt: rec.lastReplenish ?? 0 });
      if (!n) {
        if (pruned?.changed) await saveWith(rec, dev);
        return { published: 0, available: st.available };
      }
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
    // A10: only an open package with a valid expiry in the future (a pruned one's keys are gone).
    if (e.state === "pruned") throw new DeviceError("a Welcome for a KeyPackage whose private keys were deleted after it expired is refused", "pruned_key_package");
    if (e.state !== "open") throw new DeviceError(`a Welcome for a KeyPackage in state ${e.state} is refused`, "unknown_key_package");
    if (!Number.isSafeInteger(e.notAfter) || e.notAfter <= now()) throw new DeviceError("a Welcome for an expired KeyPackage is refused", "expired_key_package");
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

  // ---- per-session device proofs (A9) -------------------------------------------------------------

  /**
   * A proof of `dev`'s signature key on `client`'s connection for `purpose` ("attach", or
   * "register" with the 32-byte `key`): a fresh challenge of this connection, signed with
   * SignWithLabel by the device (the key never leaves the library).
   */
  async function proof(rec, client, dev, purpose, key = null) {
    const conn = unb64url(client.conn, 16);
    if (!conn || !client.caps?.includes(ATTACH_PROOF_CAP)) throw new DeviceError("this relay does not take device proofs (no attach-proof capability: an older relay); update the relay", "attach_proof");
    const no = signingRefusal(driver, "Proving this device's key to the relay");
    if (no) throw new DeviceError(no.message, "unsupported");
    const ch = await ask(client, { type: "proof_challenge", purpose, device: rec.device, ...(key ? { key: b64(key) } : {}) });
    const challenge = unb64url(ch.challenge, 32);
    if (!challenge) throw new DeviceError("the relay's challenge is malformed", "relay");
    const content = proofContent({ purpose, realm: rec.realm, member: rec.member, device: rec.device, key, conn, challenge });
    return b64(await dev.sign(PROOF_LABELS[purpose], content));
  }

  /** Attach `client`'s connection to this device with a proof by its current key (A9). */
  async function attachLocked(rec, client) {
    const dev = await load(rec);
    const r = await ask(client, { type: "e2ee_attach", device: rec.device, proof: await proof(rec, client, dev, "attach") });
    fault?.("after-attach", rec.device);
    return r;
  }

  /** The staged library state of a pending rotation, holding the statement's new key. */
  async function loadStaged(rec) {
    const p = rec.pendingRotation;
    const dev = checkDevice(await driver.importDevice(open(rec, p.state), { identity: credentialIdentity(rec), now }));
    if (!Buffer.from(dev.signaturePublicKey()).equals(Buffer.from(p.statement.new_key, "base64"))) throw new DeviceError("this device's staged rotation does not hold its new key", "bad_state");
    return dev;
  }

  /**
   * Rotation steps 2 and 3 (A9): register the staged key at the relay with the dual-signed
   * statement and a register proof by the staged key (a retry after a lost answer registers the
   * same key and sequence again: idempotent); only after the relay accepted it, promote it here
   * and clear the pending rotation in one write. A refusal leaves the pending state.
   */
  async function finishRotationLocked(rec, client) {
    const { statement } = rec.pendingRotation;
    const key = Buffer.from(statement.new_key, "base64");
    const staged = await loadStaged(rec);
    const pin = b64(pinIdentity({ realm: rec.realm, member: rec.member, device: rec.device, key }));
    await ask(client, { type: "device_register", device: rec.device, key: statement.new_key, pin, rotation: statement, proof: await proof(rec, client, staged, "register", key) });
    fault?.("rotate-after-accept", rec.device);
    rec.retiredKeys = [...(rec.retiredKeys ?? []), Buffer.from(rec.key, "base64").toString("hex")];
    rec.rotations = [...(rec.rotations ?? []), statement].slice(-10);
    rec.key = statement.new_key;
    rec.pin = pin;
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
    fault?.("rotate-after-promote", rec.device);
  }

  /**
   * Register (or confirm) this record at the relay with a register proof, then mark it active.
   * A12: when the member already has a device, the relay wants an approval first: the device
   * makes its pending request (device_request, with a register proof), tells `onWaiting` once,
   * and asks again every approvalPollMs until it is approved (then registers) or approvalWaitMs
   * passed (refused "approval_pending": enroll again later resumes the same device).
   */
  async function registerLocked(rec, client, { onWaiting = null } = {}) {
    const dev = await load(rec);
    const key = Buffer.from(rec.key, "base64");
    const register = async () => ask(client, { type: "device_register", device: rec.device, key: rec.key, pin: rec.pin, proof: await proof(rec, client, dev, "register", key) });
    const end = Date.now() + approvalWaitMs;
    let told = false;
    let r;
    for (;;) {
      try {
        r = await register();
        break;
      } catch (e) {
        // Not approved, or the recorded approval no longer holds (its approver was revoked,
        // suspended or rotated, or it expired): back to waiting; the relay reports the request
        // pending again and takes a fresh approval.
        if (!APPROVAL_WAIT.has(e.code)) throw e;
      }
      for (;;) {
        const q = await ask(client, { type: "device_request", device: rec.device, key: rec.key, proof: await proof(rec, client, dev, "register", key) });
        if (q.state !== "pending") break; // approved (or registered, or no approval needed any more)
        if (!told) {
          told = true;
          await onWaiting?.({ device: rec.device, fingerprint: displayFingerprint({ realm: rec.realm, member: rec.member, device: rec.device, key }), pin: Buffer.from(rec.pin, "base64").toString("hex"), expires: q.expires ?? null });
        }
        if (Date.now() >= end) throw new DeviceError(`device ${rec.device} is still waiting for approval from one of your devices (hoptell device accept ${rec.device} there); run hoptell device enroll again once it is approved`, "approval_pending");
        await new Promise((res) => setTimeout(res, approvalPollMs));
      }
    }
    if (rec.status !== "active") {
      rec.status = "active";
      rec.enrolledAt = now();
      write(rec);
    }
    return r;
  }

  /**
   * A12: send this device's outbox approvals (contacts.json own.<realm>.approvals) on `client`'s
   * connection, attached as this device; an entry ends once the relay confirms it or reports the
   * request consumed, expired or gone (an entry past its own expiry ends unsent). Other answers
   * keep it for the next attach. Returns [{device, state}].
   */
  async function flushApprovalsLocked(rec, client) {
    if (!rec || !own?.usable?.()) return [];
    let entry;
    try {
      entry = own.entry(rec.realm);
    } catch {
      return [];
    }
    const out = [];
    const current = Buffer.from(rec.key, "base64");
    const retired = (rec.retiredKeys ?? []).map((h) => Buffer.from(h, "hex"));
    let live = null; // the member's pending requests (device_pending), read once when needed
    for (let x of entry?.approvals ?? []) {
      if (x.approval.approver !== rec.device) continue;
      let state;
      if (x.approval.expiry * 1000 <= now()) state = "expired";
      // An entry without the request instance it approved (written before it was kept) is never
      // sent: the relay records an approval only for the request with that `requested`.
      else if (!Number.isSafeInteger(x.requested)) state = "request_gone";
      else {
        // Signed by a key this device has since rotated away from: the relay would refuse it
        // (bad_approval) until it expired. It is signed again with the current key, replacing the
        // entry in one contacts write before it is sent, but only for the request instance the
        // owner accepted: a live pending request for exactly this (device, key) whose `requested`
        // (the relay's creation time, device_pending) is exactly the one stored with the entry at
        // accept; the signed tuple does not name the request, and the relay's own value compares
        // without clock skew. A request renewed after an expiry or cancellation needs a fresh
        // hoptell device accept: the entry is dropped (the pin stays), never signed again for it.
        const a = readApproval(x.approval);
        if (a && !checkApproval(a, current) && retired.some((k) => checkApproval(a, k))) {
          try {
            live ??= (await ask(client, { type: "device_pending" })).requests ?? [];
            const same = live.some((r) => r.device === x.device && r.key === x.key && Number(r.requested) === x.requested);
            if (same) x = await resignLocked(rec, x);
            else state = "request_gone";
          } catch (e) {
            out.push({ device: x.device, state: "unsent", error: e.message });
            continue;
          }
        }
        if (!state) {
          try {
            // The relay checks `requested` against the live request in the transaction that records
            // the approval, so a renewal between a read and this send is refused (request_gone).
            state = (await ask(client, { type: "device_approve", approval: x.approval, requested: x.requested })).state;
          } catch (e) {
            if (e.kind !== "relay_error" || !APPROVAL_FINAL.has(e.code)) {
              out.push({ device: x.device, state: "unsent", error: e.message });
              continue;
            }
            state = e.code;
          }
        }
      }
      await own.settleApproval(rec.realm, x.approval.sig);
      out.push({ device: x.device, state });
    }
    return out;
  }

  /** A12: outbox entry `x` signed again by this device's current key; the entry replaced durably. */
  async function resignLocked(rec, x) {
    must(rec);
    const dev = await load(rec);
    const issuedAt = Math.floor(now() / 1000);
    const approval = await makeApproval({ realm: rec.realm, member: rec.member, approver: rec.device, device: x.device, key: Buffer.from(x.key, "base64"), issuedAt, expiry: issuedAt + APPROVAL_MAX_S }, (l, c) => dev.sign(l, c));
    const next = { device: x.device, key: x.key, approval, at: now(), ...(x.requested !== undefined ? { requested: x.requested } : {}) };
    await own.replaceApproval(rec.realm, x.approval.sig, next);
    return next;
  }

  const api = {
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
    enroll(client, { newBaseline = false, onWaiting = null } = {}) {
      // A9: the relay takes a registration only with a proof signed by the device key: a driver
      // without SignWithLabel cannot enroll, refused before anything is written.
      const no = signingRefusal(driver, "Enrolling a device (the relay requires a proof of its key)");
      if (no) return Promise.reject(no);
      return locked(async () => {
        if (!client.realm?.id || !client.member?.id) throw new DeviceError("devices need a protocol-2 relay and a member credential (a member token or sign-in)", "member_only");
        if (!own) throw new DeviceError("this home keeps no own-device baseline (managed contacts are needed: hoptell contacts init); nothing is enrolled", "no_baseline");
        let rec;
        try {
          rec = read();
        } catch (e) {
          // A local record that cannot be read: only an explicit new baseline goes on (A1), and
          // the damaged file is kept beside it.
          if (!newBaseline) throw e;
          fs.renameSync(file(), path.join(dir(), `damaged-${now()}.json`));
          rec = null;
        }
        if (rec && rec.status !== "retired" && rec.status !== "revoked" && (!newBaseline || rec.status === "pending")) {
          // An active record, or a pending one (a crash between steps 1 and 3, also of a
          // --new-baseline run): resumed with the same device, never a second one.
          sameIdentity(rec, client);
          must(rec);
          if (rec.pendingRotation) throw new DeviceError("a key rotation is not finished; finish it with hoptell device rotate", "rotation_pending");
          await baseline(rec, { newBaseline }); // (2), again: a crash after (1) resumes here
          await registerLocked(rec, client, { onWaiting }); // (3), with a register proof (A9), approved (A12)
          await attachLocked(rec, client); // (4) an attach proof, before any KeyPackage work
          return { created: false, ...(await replenishLocked(rec, client)), device: rec.device };
        }
        // Refused before anything is written: another profile's device in this realm, or an own
        // baseline of this profile naming another device (only --new-baseline replaces it).
        try {
          own?.precheck?.(client.realm.id, { newBaseline });
        } catch (e) {
          throw new DeviceError(e.message, e.code ?? "no_baseline");
        }
        if (rec) {
          // The old state stays readable in its archive; it can never send again.
          write({ ...rec, status: "retired", retiredWhy: rec.retiredWhy ?? (newBaseline && rec.status !== "retired" && rec.status !== "revoked" ? "replaced by a new baseline" : rec.status) }, archive(rec.device));
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
        write(rec); // (1) the key exists durably before anything else hears of it
        fault?.("after-record", device);
        await baseline(rec, { newBaseline }); // (2) the own baseline, under the contacts lock
        await registerLocked(rec, client, { onWaiting }); // (3) only then the relay, with a register proof (A9), approved (A12)
        await attachLocked(rec, client); // (4) an attach proof, then (5) KeyPackages
        return { created: true, ...(await replenishLocked(rec, client)), device };
      });
    },

    /** Top up the KeyPackage pool when it is low (or publish `force` more). */
    replenish(client, opts) {
      return locked(async () => {
        const rec = must(read());
        sameIdentity(rec, client);
        await baseline(rec);
        if (rec.pendingRotation) throw new DeviceError("a key rotation is not finished; finish it with hoptell device rotate", "rotation_pending");
        if (rec.status === "pending") await registerLocked(rec, client);
        await attachLocked(rec, client); // A9: this command's own connection proves the device first
        return replenishLocked(rec, client, opts);
      });
    },

    /**
     * Attach `client`'s connection to this device (A9) with a proof by the key the relay has
     * registered: a pending rotation is finished first (steps 2 and 3, idempotent); if the relay
     * refuses it, the pending state stays for the owner and the current key attaches. A retired
     * device attaches too (it reads what it can still decrypt). The engine prunes expired, unused
     * KeyPackage keys right after it (A10: prune()).
     */
    attach(client) {
      return locked(async () => {
        const rec = read();
        if (!rec) throw new DeviceError("this home has no device for this relay yet: hoptell device enroll", "no_device");
        sameIdentity(rec, client);
        if (rec.pendingRotation && !mayAct(rec)) {
          try {
            await finishRotationLocked(rec, client);
          } catch (e) {
            if (e.kind !== "relay_error") throw e;
          }
        }
        const r = await attachLocked(rec, client);
        // A12: the outbox approvals go again at every attach until the relay answers them.
        const approvals = await flushApprovalsLocked(rec, client).catch(() => []);
        return approvals.length ? { ...r, approvals } : r;
      });
    },

    /** A12: send the outbox approvals of this device now (`client` attached as it). */
    flushApprovals(client) {
      return locked(async () => flushApprovalsLocked(read(), client));
    },

    /**
     * A12: an approval by this device of new own device `device` with signature key `key` (32
     * bytes), issued now and valid 24 hours: signed before the contacts write that records it
     * (signing changes no state here).
     */
    signApproval({ device, key }) {
      const no = signingRefusal(driver, "Approving a new device (a statement signed by this device)");
      if (no) return Promise.reject(no);
      return locked(async () => {
        const rec = must(read());
        const dev = await load(rec);
        const issuedAt = Math.floor(now() / 1000);
        return makeApproval({ realm: rec.realm, member: rec.member, approver: rec.device, device, key: Buffer.from(key), issuedAt, expiry: issuedAt + APPROVAL_MAX_S }, (l, c) => dev.sign(l, c));
      });
    },

    /**
     * A10: prune expired, unused KeyPackage private keys inside one device transaction: the
     * library state and the ledger are written by its single save, or neither. Returns
     * {pruned, orphans, changed}, or null when the driver cannot prune.
     */
    prune() {
      if (!canPrune(driver)) return Promise.resolve(null);
      return api.transact(
        async (ctx) => {
          const r = await pruneLocked(ctx.rec, ctx.dev);
          if (r?.changed) {
            fault?.("prune-before-save", ctx.rec.device);
            await ctx.save();
            fault?.("prune-after-save", ctx.rec.device);
          }
          return r;
        },
        { act: false },
      );
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
     * (sequence + 1), durable as pending before the relay hears of it (1), then registered with a
     * proof by the new key (2), promoted here only after the relay accepted it (3), then attached
     * with the new key and replenished (4) (A9). Running it again, or any attach, resumes a
     * pending rotation at (2). The relay serves the chain to peers, who accept it without a stop.
     *
     * 3.2 only: the new key comes with a new library state, which replaces the old one. That is
     * right while the device has no groups; before 3.3 it needs a library operation that changes
     * the signature key in place (an Update with the new key in every group), which the OpenMLS
     * binding does not offer yet.
     */
    rotate(client) {
      const no = signingRefusal(driver, "a planned rotation"); // A3: before any change
      if (no) return Promise.reject(no);
      return locked(async () => {
        const rec = must(read());
        sameIdentity(rec, client);
        if (!rec.pendingRotation) {
          // 3.3: the new key comes with a new library state, which would drop every group. Until
          // the binding can change the key in place in each group, a device with
          // encrypted conversations does not rotate.
          const groups = Object.values(openE2ee({ ...rec }).e2ee?.groups ?? {}).filter((g) => g.state === "active");
          if (groups.length) throw new DeviceError(`this device has ${groups.length} encrypted conversation(s); a planned rotation would end them (the library cannot change the key in place yet; experimental)`, "rotation_unsupported");
          const old = await load(rec);
          const next = checkDevice(await driver.createDevice(credentialIdentity(rec)));
          const newKey = Buffer.from(next.signaturePublicKey());
          const statement = await makeRotation({ realm: rec.realm, member: rec.member, device: rec.device, oldKey: Buffer.from(rec.key, "base64"), newKey, sequence: rec.seq + 1 }, (l, c) => old.sign(l, c), (l, c) => next.sign(l, c));
          // (1) durable first: the current key stays the active signer; the staged new key, its
          // sealed state and the dual-signed statement are recorded next to it.
          rec.pendingRotation = { statement, state: seal(rec, Buffer.from(await next.exportState())) };
          write(rec);
          fault?.("rotate-after-pending", rec.device);
        }
        // (2) register the staged key (proved by it), (3) promote it here once the relay took it.
        await finishRotationLocked(rec, client);
        // (4) the relay dropped the old key's attachments and pool: attach with the new key, then
        // publish a full pool at once.
        await attachLocked(rec, client);
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
      const no = signingRefusal(driver, "a device-signed revocation"); // A3: before any change
      if (no) return Promise.reject(no);
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
        // A9: the revoking device acts on a connection attached with its proof. If this device's
        // own revocation was accepted before (its answer lost), the relay refuses the attachment
        // as revoked: that is the confirmation.
        let r;
        try {
          await attachLocked(rec, client);
        } catch (e) {
          if (!(resuming && e.code === "device_revoked")) throw e;
          r = { state: "already", at: null };
        }
        r ??= await ask(client, { type: "device_revoke", device: target, by_device: rec.device, statement });
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
        checkSuite(rec); // A5: a backup of another suite is never imported here
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
  return api;
}
