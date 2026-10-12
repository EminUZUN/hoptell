// Pins and key-change stops (design 3.2, "Pinning and key change", "Loss and revocation"),
// hoptell's own layer. EXPERIMENTAL: 3.3's encrypted send and receive paths call it; nothing in the
// plaintext paths does.
//
// The relay's device list is not trusted for keys: evaluate() compares it with the owner's pins in
// contacts.json (by realm and member id, comparing 32-byte pin identities) and decides:
//   first-use  no pin yet: the device set is accepted only as unverified (pinned "relay-tofu")
//   ok         deliver (marked unverified unless the pin was verified in person or out of band)
//   hold       a new device of a pinned contact: messages TO the contact wait for the owner's
//              decision; so do they while a pinned device is no longer listed by the relay (A4:
//              a missing row is not a revocation; it reappears, a trusted revocation arrives, or
//              the owner forgets it); requireVerified without a verified pin: messages both ways wait
//   stop       a replaced key (same device id, another key, no valid rotation from the pinned
//              key): traffic stops in both directions until the owner decides
// A planned rotation that chains from the pinned key (lib/mls/identity.js followRotations) is
// accepted without a stop and persisted with the pins. A revocation signed by another pinned
// device of the member is trusted: sending to that device holds at once (in every group that
// still contains it, until 3.3's accepted removal); a relay-only or admin revocation is advisory.
// A trusted revocation, once observed, is kept in the pin entry (applyRevocations) until 3.3's
// accepted removal clears it (clearRevocation): a later directory answer that omits it, or serves
// the device again, does not lift the hold.
//
// Held messages wait in <home>/mls/<profile>/held/, one durable file each; the agent sees only
// "N messages wait for a key decision". release() hands each one out exactly once to a sink that
// deduplicates by the held id (3.3's sender uses it as the operation id), and removes it after.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ensurePrivateDir } from "../config.js";
import { removeDurable, writeDurable } from "../credentials.js";
import { withLock } from "../locks.js";
import { b64, checkRevocation, displayFingerprint, followRotations, parseCredentialIdentity, pinIdentity, safetyNumber, unb64 } from "./identity.js";

const HOWS = ["in-person", "out-of-band", "relay-tofu"];
const MAX_DECISIONS = 20;
const MAX_KEPT_REVOCATIONS = 100;

/** A served device (from device_list) as {device, key: Buffer, pin: Buffer, seq, rotations}, or null when malformed. */
function servedDevice(realm, member, d) {
  const key = unb64(d?.key, 32);
  if (!key || typeof d.device !== "string") return null;
  let pin;
  try {
    pin = pinIdentity({ realm, member, device: d.device, key });
  } catch {
    return null;
  }
  // The relay's pin must be the one we compute: anything else is a malformed answer.
  if (!unb64(d.pin, 32)?.equals(pin)) return null;
  return { device: d.device, key, pin, seq: Number.isSafeInteger(d.seq) ? d.seq : 0, rotations: Array.isArray(d.rotations) ? d.rotations : [] };
}
const fpOf = (realm, member, device, key) => displayFingerprint({ realm, member, device, key });

/** The pin entry of (realm, member) in a contacts document, or null. */
export const pinOf = (doc, realm, member) => (doc?.pins ?? []).find((p) => p.realm === realm && p.member === member) ?? null;

/**
 * Compare what the relay serves for (realm, member) with the pin entry and policy. `doc` is the
 * contacts document (or null); `served` the device_list answer's devices. Returns
 * {state, reason, holdOut, holdIn, verified, active, newDevices, changed, rotated, revoked,
 * holdDevices, missing}: holdOut / holdIn name why messages to / from the contact are held (null:
 * they are not), so a new device holds sending only, and requireVerified both directions.
 * `missing`: pinned devices the relay no longer lists at all (neither served nor revoked; A4: a
 * missing row is not a revocation, the device stays pinned).
 */
export function evaluate(doc, realm, member, served) {
  const pin = pinOf(doc, realm, member);
  const requireVerified = Boolean(pin?.requireVerified) || (doc?.requireVerified ?? []).includes(realm);
  // Trusted revocations observed before stay in force whatever the relay serves now.
  const kept = new Map((pin?.revoked ?? []).map((r) => [r.device, r]));
  const active = [];
  const revoked = [];
  for (const d of served ?? []) {
    if (d?.revoked) revoked.push(d);
    else if (!kept.has(d?.device)) {
      const s = servedDevice(realm, member, d);
      if (s) active.push(s);
    }
  }
  if (!pin) {
    const reason = requireVerified ? "requireVerified: not verified yet" : null;
    return { state: requireVerified ? "hold" : "first-use", reason, holdOut: reason, holdIn: reason, verified: false, active, newDevices: active, changed: [], rotated: [], revoked: [], holdDevices: [], missing: [] };
  }

  const pinned = new Map(pin.devices.map((d) => [d.device, d]));
  const listed = new Set((served ?? []).map((d) => d?.device));
  const missing = pin.devices.filter((d) => !listed.has(d.device) && !kept.has(d.device)).map((d) => ({ device: d.device, key: Buffer.from(d.key, "base64"), pin: Buffer.from(d.pin, "base64"), seq: d.seq ?? 0 }));
  const newDevices = [];
  const changed = [];
  const rotated = [];
  for (const s of active) {
    const p = pinned.get(s.device);
    if (!p) {
      newDevices.push(s);
      continue;
    }
    if (Buffer.from(p.pin, "base64").equals(s.pin)) continue;
    const r = followRotations({ realm, member, device: s.device, key: Buffer.from(p.key, "base64"), sequence: p.seq, retired: p.retired ?? [] }, s.rotations, s.key);
    if (r.ok) rotated.push({ device: s.device, key: r.key, seq: r.sequence, retired: r.retired, pin: s.pin });
    else changed.push({ device: s.device, old: fpOf(realm, member, s.device, Buffer.from(p.key, "base64")), new: fpOf(realm, member, s.device, s.key), reason: r.reason, key: s.key, pin: s.pin, seq: s.seq });
  }
  // Revocations: trusted when signed by another device pinned for this member.
  const revokedOut = [];
  const holdDevices = [];
  for (const d of revoked) {
    if (kept.has(d.device)) continue;
    const st = d.revoked?.statement;
    const by = st && pinned.get(st.by);
    const trusted = Boolean(by && st.by !== d.device && st.device === d.device && st.realm === realm && st.member === member && checkRevocation(st, Buffer.from(by.key, "base64")));
    revokedOut.push({ device: d.device, trusted, by: d.revoked?.by ?? null, ...(trusted ? { signer: st.by, at: Number.isSafeInteger(d.revoked?.at) ? d.revoked.at : null } : {}) });
    if (trusted && pinned.has(d.device)) holdDevices.push(d.device);
  }
  for (const r of kept.values()) {
    revokedOut.push({ device: r.device, trusted: true, by: "device", signer: r.by, at: r.at, kept: true });
    holdDevices.push(r.device);
  }
  const verified = pin.how !== "relay-tofu";
  let state = "ok";
  let reason = null;
  let holdOut = null;
  let holdIn = null;
  const unverified = requireVerified && !verified ? "requireVerified: this contact is not verified (relay-tofu does not count)" : null;
  // More unresolved revocations than the pin can keep: none was dropped, but which devices are
  // held is no longer fully known, so everything with this contact stops until the owner resolves
  // the removals (DKI7).
  if (pin.revokedOverflow) [state, reason] = ["stop", `more than ${MAX_KEPT_REVOCATIONS} revoked devices are not removed yet; resolve them before messages go either way`];
  else if (changed.length) [state, reason] = ["stop", `a key changed without a valid rotation (${changed.map((c) => c.device).join(", ")})`];
  else if (newDevices.length) [state, reason] = ["hold", `${newDevices.length} new device(s) wait for your decision`];
  else if (missing.length) [state, reason] = ["hold", `the relay no longer lists device ${missing.map((m) => m.device).join(", ")} of ${member}`];
  else if (unverified) [state, reason] = ["hold", unverified];
  if (state === "stop") holdOut = holdIn = reason;
  else {
    holdOut = newDevices.length || missing.length ? reason : unverified;
    holdIn = unverified; // a new device can only send once it is in the group, which takes the owner's acceptance
  }
  return { state, reason, holdOut, holdIn, verified, active, newDevices, changed, rotated, revoked: revokedOut, holdDevices, missing };
}

const pinDevice = (d) => ({ device: d.device, pin: b64(d.pin), key: b64(d.key), seq: d.seq ?? 0, ...(d.retired?.length ? { retired: d.retired } : {}) });

/**
 * The pins after first use: the served device set, recorded as "relay-tofu" (provenance only).
 * `mutate`-style: changes doc.pins in place; returns the entry.
 */
export function pinFirstUse(doc, realm, member, active, now = new Date()) {
  if (pinOf(doc, realm, member)) return pinOf(doc, realm, member);
  const entry = { realm, member, devices: active.map(pinDevice), verifiedAt: now.toISOString(), how: "relay-tofu" };
  (doc.pins ??= []).push(entry);
  return entry;
}

/** Persist accepted rotations (new key and sequence, the old key retired) into the pin entry. */
export function applyRotations(doc, realm, member, rotated) {
  const pin = pinOf(doc, realm, member);
  if (!pin) return;
  for (const r of rotated) {
    const d = pin.devices.find((x) => x.device === r.device);
    if (d) Object.assign(d, { key: b64(r.key), pin: b64(r.pin), seq: r.seq, retired: r.retired.slice(-100) });
  }
}

/**
 * Keep the trusted revocations of an evaluation in the pin entry (a pinned device revoked by
 * another pinned device): the hold lasts until clearRevocation, whatever the relay serves later.
 * `mutate`-style; returns the devices newly kept.
 */
export function applyRevocations(doc, realm, member, ev) {
  const pin = pinOf(doc, realm, member);
  if (!pin) return [];
  const added = [];
  let overflow = false;
  for (const r of ev.revoked) {
    if (!r.trusted || r.kept || (pin.revoked ?? []).some((x) => x.device === r.device)) continue;
    if (!pin.devices.some((d) => d.device === r.device) && !ev.holdDevices.includes(r.device)) continue;
    // Never evict an unresolved hold to make room: past the bound, a member-wide stop is kept
    // instead (revokedOverflow). decide() reserves room for every pinned device, so this only
    // happens with state from before that reservation or a damaged file.
    if ((pin.revoked?.length ?? 0) >= MAX_KEPT_REVOCATIONS) {
      overflow = true;
      continue;
    }
    (pin.revoked ??= []).push({ device: r.device, by: r.signer, ...(r.at !== null ? { at: r.at } : {}) });
    added.push(r.device);
  }
  // Latched: a directory answer is not an inventory of earlier revocations, so no evaluation
  // clears it; only clearRevocationOverflow does, after every group with the member is rebuilt.
  if (overflow) pin.revokedOverflow = true;
  return added;
}

/**
 * Recovery from a revocation overflow: which devices were revoked is no longer fully known, so
 * the hold ends only when every encrypted conversation with the member has been rebuilt from its
 * currently pinned devices (3.3: group_replace of each, accepted), which `proof.groupsReplaced`
 * states. Kept revocations stay as they are.
 */
export function clearRevocationOverflow(doc, realm, member, proof = {}) {
  if (proof.groupsReplaced !== true) throw Object.assign(new Error("a revocation overflow ends only after every conversation with the member is rebuilt"), { code: "groups_not_replaced" });
  const pin = pinOf(doc, realm, member);
  if (!pin?.revokedOverflow) return false;
  delete pin.revokedOverflow;
  return true;
}

/**
 * After an accepted, durable removal of `device` (3.3): its kept revocation is cleared and the
 * device unpinned, together (one `mutate` of the pins, so neither is ever written without the
 * other). A revoked id is never used again; unpinned, the relay's lasting revocation record does
 * not bring the kept revocation back (applyRevocations keeps only pinned devices). Returns
 * whether a kept revocation was cleared (nothing changes otherwise).
 */
export function retireRemovedDevice(doc, realm, member, device) {
  if (!clearRevocation(doc, realm, member, device)) return false;
  const pin = pinOf(doc, realm, member);
  if (pin) pin.devices = pin.devices.filter((x) => x.device !== device);
  return true;
}

/**
 * The owner forgets pinned device `device` of (realm, member) that the relay no longer lists
 * (hoptell contacts forget-device, A4): the only owner-driven removal of a pinned device. It
 * leaves the pins (the conversation then removes it with one commit). Refused for a device the
 * relay still lists. `mutate`-style; returns the decision recorded.
 */
export function forgetDevice(doc, realm, member, device, ev, { now = new Date() } = {}) {
  const pin = pinOf(doc, realm, member);
  if (!pin?.devices.some((d) => d.device === device)) throw Object.assign(new Error(`device ${device} of ${member} is not pinned`), { code: "not_pinned" });
  if (!ev.missing.some((m) => m.device === device)) throw Object.assign(new Error(`the relay still lists device ${device} of ${member}; only a device it no longer lists is forgotten`), { code: "not_missing" });
  const old = pin.devices.find((d) => d.device === device);
  pin.devices = pin.devices.filter((d) => d.device !== device);
  const decision = { at: now.toISOString(), device, decision: "forgot a device the relay no longer lists", old: fpOf(realm, member, device, Buffer.from(old.key, "base64")) };
  pin.decisions = [...(pin.decisions ?? []), decision].slice(-MAX_DECISIONS);
  return decision;
}

/** 3.3's accepted removal of `device` from every group: its kept revocation is no longer needed. */
export function clearRevocation(doc, realm, member, device) {
  const pin = pinOf(doc, realm, member);
  if (!pin?.revoked) return false;
  const before = pin.revoked.length;
  pin.revoked = pin.revoked.filter((r) => r.device !== device);
  if (!pin.revoked.length) delete pin.revoked;
  return before !== (pin.revoked?.length ?? 0);
}

/**
 * The owner's decision for (realm, member): pin the devices it accepts. `accept` is "all" (the
 * current served set: hoptell contacts verify) or a list of device ids (accept-device); `how`
 * upgrades the provenance when given. Replaced keys accepted here are recorded with their old and
 * new fingerprints. Returns {decisions}.
 */
export function decide(doc, realm, member, ev, { accept = "all", how = null, now = new Date() } = {}) {
  if (how !== null && !HOWS.includes(how)) throw new Error('how must be "in-person", "out-of-band" or "relay-tofu"');
  let pin = pinOf(doc, realm, member);
  if (!pin) pin = pinFirstUse(doc, realm, member, [], now);
  const wanted = (device) => accept === "all" || accept.includes(device);
  const decisions = [];
  for (const c of ev.changed) {
    if (!wanted(c.device)) continue;
    const d = pin.devices.find((x) => x.device === c.device);
    Object.assign(d, { key: b64(c.key), pin: b64(c.pin), seq: c.seq ?? 0 });
    decisions.push({ at: now.toISOString(), device: c.device, decision: "accepted replaced key", old: c.old, new: c.new });
  }
  // Room is reserved: every pinned device may later need a kept revocation, so kept revocations
  // plus pinned devices never pass the bound, and no device is accepted during an overflow.
  const adding = ev.newDevices.filter((n) => wanted(n.device) && !pin.devices.some((x) => x.device === n.device)).length;
  const full = pin.revokedOverflow || (pin.revoked?.length ?? 0) + pin.devices.length + adding > MAX_KEPT_REVOCATIONS;
  if (adding && full) {
    throw Object.assign(new Error(`${MAX_KEPT_REVOCATIONS} revoked devices of this contact are not removed yet: resolve them before accepting another device`), { code: "revocations_full" });
  }
  for (const n of ev.newDevices) {
    if (!wanted(n.device) || pin.devices.some((x) => x.device === n.device)) continue;
    pin.devices.push(pinDevice(n));
    decisions.push({ at: now.toISOString(), device: n.device, decision: "accepted new device", new: fpOf(realm, member, n.device, n.key) });
  }
  applyRotations(doc, realm, member, ev.rotated);
  applyRevocations(doc, realm, member, ev);
  if (accept === "all") {
    // Verify pins the current set: a pinned device the relay serves as revoked leaves it (its
    // kept revocation stays). A pinned device the relay no longer lists at all is never dropped
    // here (A1/A4): verify refuses while one is missing; only forgetDevice removes it.
    const current = new Set([...ev.active.map((a) => a.device), ...ev.missing.map((m) => m.device)]);
    pin.devices = pin.devices.filter((d) => current.has(d.device));
  }
  if (how) {
    pin.how = how;
    pin.verifiedAt = now.toISOString();
  }
  pin.decisions = [...(pin.decisions ?? []), ...decisions].slice(-MAX_DECISIONS);
  return { decisions };
}

/**
 * Check a KeyPackage taken from the relay (kp_take) before a commit adds it: the library decodes
 * and validates it (signature, suite, lifetime), and its credential must be exactly the expected
 * device (realm, member, device) with the expected signature key (the pinned or served one). An
 * expired package is refused here too, whatever the relay said. Throws; returns the inspection.
 */
export function checkKeyPackage(driver, expected, bytes, now = Date.now()) {
  const info = driver.inspectKeyPackage(bytes, { now });
  const id = parseCredentialIdentity(info.identity);
  if (!id || id.realm !== expected.realm || id.member !== expected.member || id.device !== expected.device) throw new Error("the KeyPackage belongs to another device");
  if (!Buffer.from(info.signatureKey).equals(Buffer.from(expected.key))) throw new Error("the KeyPackage is signed by another key than the device's");
  if (info.notAfter !== null && info.notAfter !== undefined && !(now < info.notAfter)) throw new Error("the KeyPackage has expired");
  return info;
}

/**
 * The code that binds an owner's confirmation to what was shown (hoptell contacts verify and
 * accept-device print it; the confirming run must give it back with --set): a digest of `what`
 * ("verify", or "accept-device" and the device), the realm, both members, every active device and
 * its pin identity on both sides, the revoked and changed devices, and the contacts policy
 * revision. Any device added, replaced or removed, or any pin edit, gives another code.
 */
export function confirmationCode({ what, realm, me, myActive = [], member, ev, revision }) {
  const set = (list) => list.map((d) => [d.device, b64(d.pin)]).sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
  const canon = JSON.stringify(["hoptell-confirm-v1", what, realm, me, set(myActive), member, set(ev.active), ev.revoked.map((r) => [r.device, r.trusted]).sort(), ev.changed.map((c) => c.device).sort(), revision ?? 0]);
  return crypto.createHash("sha256").update(canon).digest("hex").slice(0, 32);
}

/** The safety number of me and a contact, from the active device sets. */
export const pairSafetyNumber = (realm, me, myActive, member, theirActive) =>
  safetyNumber(realm, { member: me, pins: myActive.map((d) => d.pin) }, { member, pins: theirActive.map((d) => d.pin) });

// ---- held messages --------------------------------------------------------------------------------

const HELD_RE = /^h_[0-9a-f]{32}\.json$/;

/** The held-message queue of a home's device for one relay profile. `fault(point)` is for tests. */
export function heldQueue({ home, profile, now = () => Date.now(), fault = null }) {
  const dir = () => {
    ensurePrivateDir(path.join(ensurePrivateDir(home), "mls"));
    ensurePrivateDir(path.join(home, "mls", profile));
    return ensurePrivateDir(path.join(home, "mls", profile, "held"));
  };
  const all = () => {
    const d = dir();
    return fs
      .readdirSync(d)
      .filter((f) => HELD_RE.test(f))
      .map((f) => {
        try {
          return JSON.parse(fs.readFileSync(path.join(d, f), "utf8"));
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => a.created - b.created || (a.id < b.id ? -1 : 1));
  };
  const lock = (fn) => withLock(path.join(dir(), "queue"), fn, { waitMs: 10_000 });
  const of = (realm, member, direction) => all().filter((h) => h.realm === realm && h.member === member && (!direction || h.direction === direction));
  return {
    /** Hold a message ("out": to the contact, "in": from it) durably; returns its id. */
    hold({ realm, member, direction, reason, message }) {
      if (!["in", "out"].includes(direction)) throw new Error("direction is in or out");
      const id = `h_${crypto.randomBytes(16).toString("hex")}`;
      writeDurable(path.join(dir(), `${id}.json`), `${JSON.stringify({ id, realm, member, direction, reason, created: now(), message })}\n`);
      return id;
    },
    count: (realm, member, direction) => of(realm, member, direction).length,
    /** Whether a message with delivery or reference `id` is held already (a retry never holds it twice). */
    has: (direction, id) => all().some((h) => h.direction === direction && (h.message?.id === id || h.message?.ref === id)),
    /** The (realm, member, direction) triples that have held messages. */
    held() {
      const seen = new Map();
      for (const h of all()) seen.set(`${h.realm}|${h.member}|${h.direction}`, { realm: h.realm, member: h.member, direction: h.direction });
      return [...seen.values()];
    },
    /** What an agent may see: a count, never keys. */
    line() {
      const n = all().length;
      return n ? `${n} message${n === 1 ? "" : "s"} wait${n === 1 ? "s" : ""} for a key decision (the owner runs hoptell contacts verify)` : null;
    },
    /**
     * After the owner's decision: hand each held message of (realm, member) to `deliver(message,
     * id, direction)` and remove it once deliver resolved. A crash between the two hands it out
     * again with the same id, which the sink deduplicates: delivered exactly once. A sink that
     * resolves `false` keeps the message held (not for this caller: another session's, say).
     */
    release(realm, member, deliver, { direction = null } = {}) {
      return lock(async () => {
        let n = 0;
        for (const h of of(realm, member, direction)) {
          if ((await deliver(h.message, h.id, h.direction)) === false) continue;
          fault?.("held-after-deliver", h.id);
          removeDurable(path.join(dir(), `${h.id}.json`));
          n++;
        }
        return n;
      });
    },
    /** The owner refused: the held messages of (realm, member) are dropped. */
    discard(realm, member) {
      return lock(async () => {
        const list = of(realm, member);
        for (const h of list) removeDurable(path.join(dir(), `${h.id}.json`));
        return list.length;
      });
    },
  };
}

/**
 * The gate 3.3's paths call: `outbound` and `inbound` decide one message for (realm, member) from
 * the evaluation (its holdOut and holdIn); held messages go to the queue. Returns {deliver: true, unverified} or
 * {deliver: false, held: id, reason}. A trusted revocation holds sending to that device only;
 * 3.3 applies it per group (every group that still contains it).
 */
export function gate(ev, queue, { realm, member }) {
  return {
    outbound(message) {
      if (ev.holdOut) return { deliver: false, held: queue.hold({ realm, member, direction: "out", reason: ev.holdOut, message }), reason: ev.holdOut };
      return { deliver: true, unverified: !ev.verified, holdDevices: ev.holdDevices };
    },
    inbound(message) {
      // A key change and an unmet requireVerified hold what arrives; a new device does not (it can
      // only send once it is in the group, which takes the owner's acceptance).
      if (ev.holdIn) return { deliver: false, held: queue.hold({ realm, member, direction: "in", reason: ev.holdIn, message }), reason: ev.holdIn };
      return { deliver: true, unverified: !ev.verified };
    },
  };
}
