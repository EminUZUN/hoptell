// Own-device trust (design 3.2 v2.2, amendments-3.5-prep A1), hoptell's own layer. EXPERIMENTAL.
//
// The owner's own devices are never trusted because the relay lists them. contacts.json keeps
// them in one top-level object `own`, keyed by realm id:
//   own.<realm> = {member, profile, devices: [...], unconfirmed: [...], upgradedAt?, retiredAt?, history?, approvals?}
// Each device record has the encoding of a contact's pin (device, key, pin, seq, retired) plus
// its provenance: how "enrolled" (the local device of `profile`, exactly one per realm) or
// "accepted" (by the owner's `hoptell device accept` on an own device, `by` naming that device),
// and `at`. `unconfirmed` holds the devices an older hoptell had pinned relay-tofu for the own
// member (moved there by the upgrade, never authority) with `seen`. Invariants (checkOwn, on
// every read and write of the document): one entry per realm; device ids unique across devices
// and unconfirmed; exactly one enrolled device; each pin recomputed from (realm, member, device,
// key) equals the stored one; the own member is never in `pins`.
//
// A home holds one device per realm: enrolling a second profile in a realm that already has an
// own entry (or another profile's active device) is refused, and an older home with two is
// stopped for that realm until the owner retires one (hoptell device retire). Retiring the profile
// that holds the entry keeps it, marked `retiredAt`: a later enrollment in that realm needs
// `--new-baseline`, which keeps the replaced entry in `history` (at most MAX_OWN_HISTORY, for review
// only, never authority).
import fs from "node:fs";
import path from "node:path";
import { writeDurable } from "../credentials.js";
import { b64, checkRevocation, displayFingerprint, followRotations, pinIdentity, unb64 } from "./identity.js";

const REALM_RE = /^[0-9a-f]{32}$/;
const MEMBER_RE = /^(m_[a-z2-7]{26}|name:[A-Za-z0-9][A-Za-z0-9_-]{0,63})$/;
const PROFILE_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const DEVICE_RE = /^[a-z2-7]{25}[aeimquy4]$/;
const ENTRY_KEYS = new Set(["member", "profile", "devices", "unconfirmed", "upgradedAt", "retiredAt", "history", "approvals"]);
// A12: the approval outbox, in the own entry beside the pins it was written with: approvals this
// home's device signed for a new own device, kept until the relay confirms them (or reports the
// request consumed, expired or gone). Bounded like the own devices.
// A12: `requested` is the relay's creation time (ms) of the pending request the approval was
// signed for, as device_pending reported it: the request instance, compared exactly before a re-sign.
const APPROVAL_KEYS = new Set(["device", "key", "approval", "at", "requested"]);
const APPROVAL_WIRE_KEYS = ["realm", "member", "approver", "device", "key", "issued_at", "expiry", "sig"];
export const MAX_OWN_APPROVALS = 20;
export const MAX_OWN_HISTORY = 10;
// A12: `awaiting` (true) marks an accepted device whose registration at the relay is still
// pending: a durable acceptance, kept out of safety numbers until the relay lists the device.
const DEVICE_KEYS = new Set(["device", "key", "pin", "seq", "retired", "how", "at", "by", "awaiting"]);
const UNCONFIRMED_KEYS = new Set(["device", "key", "pin", "seq", "retired", "seen"]);
export const MAX_OWN_DEVICES = 20;

export class OwnError extends Error {
  constructor(message, code = "own") {
    super(message);
    this.code = code;
  }
}

const isStr = (x) => typeof x === "string";
const b64Of = (x, n) => isStr(x) && /^[A-Za-z0-9+/]*={0,2}$/.test(x) && Buffer.from(x, "base64").length === n;
const whole = (x) => Number.isSafeInteger(x) && x >= 0;

/** Whether the stored pin of an own record is the one computed from its key. */
function pinMatches(realm, member, d) {
  try {
    return pinIdentity({ realm, member, device: d.device, key: Buffer.from(d.key, "base64") }).equals(Buffer.from(d.pin, "base64"));
  } catch {
    return false;
  }
}

function checkRecord(d, where, keys) {
  if (!d || typeof d !== "object" || Array.isArray(d)) return `${where}: expected an object`;
  for (const k of Object.keys(d)) if (!keys.has(k)) return `${where}: unknown field "${k}"`;
  if (!isStr(d.device) || !DEVICE_RE.test(d.device)) return `${where}: device must be a device id`;
  if (!b64Of(d.key, 32) || !b64Of(d.pin, 32)) return `${where}: key and pin are 32 bytes, base64`;
  if (!whole(d.seq)) return `${where}: seq must be a whole number`;
  if (!(Array.isArray(d.retired) && d.retired.length <= 100 && d.retired.every((h) => isStr(h) && /^[0-9a-f]{64}$/.test(h)))) return `${where}: retired must be a list of keys (hex)`;
  return null;
}

/**
 * The problems of a document's `own` object (empty when valid or absent): its shape and the
 * invariants above. lib/contacts.js validateContacts runs it on every read and write.
 */
export function checkOwn(doc) {
  if (doc?.own === undefined) return [];
  const own = doc.own;
  if (!own || typeof own !== "object" || Array.isArray(own)) return ["own must be an object keyed by realm id"];
  const problems = [];
  for (const [realm, e] of Object.entries(own)) {
    const at = `own.${realm}`;
    if (!REALM_RE.test(realm)) {
      problems.push(`${at}: the key must be a realm id`);
      continue;
    }
    if (!e || typeof e !== "object" || Array.isArray(e)) {
      problems.push(`${at}: expected an object`);
      continue;
    }
    const bad = Object.keys(e).find((k) => !ENTRY_KEYS.has(k));
    if (bad) {
      problems.push(`${at}: unknown field "${bad}"`);
      continue;
    }
    if (!isStr(e.member) || !MEMBER_RE.test(e.member)) problems.push(`${at}: member must be a member id`);
    if (!isStr(e.profile) || !PROFILE_RE.test(e.profile)) problems.push(`${at}: profile must be a relay profile name`);
    if (e.upgradedAt !== undefined && !whole(e.upgradedAt)) problems.push(`${at}: upgradedAt must be a time (ms)`);
    if (e.retiredAt !== undefined && !whole(e.retiredAt)) problems.push(`${at}: retiredAt must be a time (ms)`);
    // Earlier baselines of the realm, kept for review (never authority).
    if (e.history !== undefined && !(Array.isArray(e.history) && e.history.length <= MAX_OWN_HISTORY && e.history.every((h) => h && typeof h === "object" && !Array.isArray(h)))) problems.push(`${at}: history must be a list of at most ${MAX_OWN_HISTORY} earlier entries`);
    if (!Array.isArray(e.devices) || e.devices.length > MAX_OWN_DEVICES) {
      problems.push(`${at}: devices must be a list of at most ${MAX_OWN_DEVICES}`);
      continue;
    }
    if (!Array.isArray(e.unconfirmed) || e.unconfirmed.length > MAX_OWN_DEVICES) {
      problems.push(`${at}: unconfirmed must be a list of at most ${MAX_OWN_DEVICES}`);
      continue;
    }
    const ids = new Set();
    let enrolled = 0;
    e.devices.forEach((d, i) => {
      const where = `${at}.devices[${i}]`;
      const p = checkRecord(d, where, DEVICE_KEYS);
      if (p) return problems.push(p);
      if (!["enrolled", "accepted"].includes(d.how)) return problems.push(`${where}: how must be "enrolled" or "accepted"`);
      if (!whole(d.at)) return problems.push(`${where}: at must be a time (ms)`);
      if (d.how === "accepted" && !(isStr(d.by) && DEVICE_RE.test(d.by))) return problems.push(`${where}: an accepted device names the device that accepted it (by)`);
      if (d.how === "enrolled" && d.by !== undefined) return problems.push(`${where}: an enrolled device has no "by"`);
      if (d.awaiting !== undefined && !(d.awaiting === true && d.how === "accepted")) return problems.push(`${where}: awaiting is true, on an accepted device only`);
      if (d.how === "enrolled") enrolled++;
      if (ids.has(d.device)) return problems.push(`${where}: device ${d.device} is listed twice`);
      ids.add(d.device);
      if (isStr(e.member) && MEMBER_RE.test(e.member) && !pinMatches(realm, e.member, d)) problems.push(`${where}: the pin does not match the device's key`);
    });
    e.unconfirmed.forEach((d, i) => {
      const where = `${at}.unconfirmed[${i}]`;
      const p = checkRecord(d, where, UNCONFIRMED_KEYS);
      if (p) return problems.push(p);
      if (!whole(d.seen)) return problems.push(`${where}: seen must be a time (ms)`);
      if (ids.has(d.device)) return problems.push(`${where}: device ${d.device} is listed twice`);
      ids.add(d.device);
      if (isStr(e.member) && MEMBER_RE.test(e.member) && !pinMatches(realm, e.member, d)) problems.push(`${where}: the pin does not match the device's key`);
    });
    if (e.approvals !== undefined) {
      if (!Array.isArray(e.approvals) || e.approvals.length > MAX_OWN_APPROVALS) problems.push(`${at}: approvals must be a list of at most ${MAX_OWN_APPROVALS}`);
      else e.approvals.forEach((x, i) => {
        const p = checkApprovalEntry(realm, e.member, x);
        if (p) problems.push(`${at}.approvals[${i}]: ${p}`);
      });
    }
    if (enrolled !== 1) problems.push(`${at}: exactly one enrolled device (this home's own) is required, found ${enrolled}`);
    if ((doc.pins ?? []).some((p) => p?.realm === realm && p?.member === e.member)) problems.push(`${at}: the own member ${e.member} must not be in pins (own devices are kept only here)`);
  }
  return problems;
}

/** The shape problem of one approval outbox entry (A12), or null. */
function checkApprovalEntry(realm, member, x) {
  if (!x || typeof x !== "object" || Array.isArray(x)) return "expected an object";
  for (const k of Object.keys(x)) if (!APPROVAL_KEYS.has(k)) return `unknown field "${k}"`;
  if (!isStr(x.device) || !DEVICE_RE.test(x.device)) return "device must be a device id";
  if (!b64Of(x.key, 32)) return "key is 32 bytes, base64";
  if (!whole(x.at)) return "at must be a time (ms)";
  if (x.requested !== undefined && !whole(x.requested)) return "requested must be a time (ms)";
  const a = x.approval;
  if (!a || typeof a !== "object" || Array.isArray(a) || Object.keys(a).some((k) => !APPROVAL_WIRE_KEYS.includes(k))) return "approval must be an approval statement";
  if (a.realm !== realm || a.member !== member || a.device !== x.device || a.key !== x.key || !isStr(a.approver) || !DEVICE_RE.test(a.approver) || !b64Of(a.sig, 64) || !whole(a.issued_at) || !whole(a.expiry)) return "the approval does not match its entry";
  return null;
}

/** The own entry of `realm` in a contacts document (checked; throws on a damaged one), or null. */
export function ownOf(doc, realm) {
  const e = doc?.own?.[realm];
  if (!e) return null;
  const problems = checkOwn(doc);
  if (problems.length) throw new OwnError(`the own devices in contacts.json are refused: ${problems[0]}`, "own_damaged");
  return e;
}

/** The enrolled device of an own entry. */
export const enrolledOf = (e) => e?.devices.find((d) => d.how === "enrolled") ?? null;

/** An own record (or unconfirmed record) as {device, key: Buffer, pin: Buffer, seq, retired}. */
const asServed = (d) => ({ device: d.device, key: Buffer.from(d.key, "base64"), pin: Buffer.from(d.pin, "base64"), seq: d.seq, retired: d.retired ?? [] });

/** The baseline record of the local device record `rec` (device.json): its key, never the relay's row. */
export function baselineOf(rec, at) {
  const key = Buffer.from(rec.key, "base64");
  return { device: rec.device, key: b64(key), pin: b64(pinIdentity({ realm: rec.realm, member: rec.member, device: rec.device, key })), seq: rec.seq ?? 0, retired: [...(rec.retiredKeys ?? [])].slice(-100), how: "enrolled", at };
}

/**
 * Write the own baseline of local device record `rec` for `profile` (mutate-style on `doc`):
 * a new entry with only that device, or nothing when it is already the entry's enrolled device.
 * Refuses another profile's entry in the realm, and another enrolled device of this profile
 * (only `newBaseline` replaces it: hoptell device enroll --new-baseline). Also the upgrade of
 * an older home: the old relay-tofu pin entry of the own member is removed in the same write and
 * its other devices go to `unconfirmed`, unchanged. Returns {written, upgraded, unconfirmed}.
 */
export function writeBaseline(doc, { rec, profile, now, newBaseline = false }) {
  const realm = rec.realm;
  doc.own ??= {};
  const cur = doc.own[realm];
  // A retired baseline (hoptell device retire) is replaced only by an explicit new baseline, from
  // any profile of the home; an active one only by its own profile's --new-baseline.
  if (cur && cur.profile !== profile && !(newBaseline && cur.retiredAt !== undefined)) {
    throw new OwnError(cur.retiredAt !== undefined ? `this home's own device in realm ${realm} (profile ${cur.profile}) was retired: a device of another profile becomes the baseline only through hoptell device enroll --new-baseline` : `this home already has a device in realm ${realm}, profile ${cur.profile}: one device per home and realm`, cur.retiredAt !== undefined ? "baseline_retired" : "realm_taken");
  }
  if (cur && !newBaseline) {
    const e = enrolledOf(cur);
    if (e?.device === rec.device && cur.member === rec.member && cur.retiredAt === undefined) return { written: false, upgraded: false, unconfirmed: [] };
    throw new OwnError(cur.retiredAt !== undefined ? `this home's own device in realm ${realm} was retired: a new device becomes the baseline only through hoptell device enroll --new-baseline` : `this home's own device in realm ${realm} is ${e?.device ?? "missing"}, not ${rec.device}: make a new baseline with hoptell device enroll --new-baseline`, cur.retiredAt !== undefined ? "baseline_retired" : "baseline_mismatch");
  }
  // The baseline replaced is kept for review (bounded), never as authority.
  const history = cur ? [...(cur.history ?? []), { ...Object.fromEntries(Object.entries(cur).filter(([k]) => k !== "history")), replacedAt: now }].slice(-MAX_OWN_HISTORY) : [];
  const old = (doc.pins ?? []).find((p) => p.realm === realm && p.member === rec.member) ?? null;
  const unconfirmed = (old?.devices ?? [])
    .filter((d) => d.device !== rec.device)
    .map((d) => ({ device: d.device, key: d.key, pin: d.pin, seq: d.seq ?? 0, retired: [...(d.retired ?? [])], seen: now }));
  if (old) doc.pins = doc.pins.filter((p) => p !== old);
  if (doc.pins && !doc.pins.length) delete doc.pins;
  doc.own[realm] = { member: rec.member, profile, devices: [baselineOf(rec, now)], unconfirmed: newBaseline ? [] : unconfirmed, ...(old && !newBaseline ? { upgradedAt: now } : {}), ...(history.length ? { history } : {}) };
  return { written: true, upgraded: Boolean(old) && !newBaseline, unconfirmed: unconfirmed.map((d) => d.device) };
}

/**
 * hoptell device retire of `profile` (mutate-style). When the realm's own entry belongs to that
 * profile (the authoritative one), it is not dropped: it is marked retired (`retiredAt`), so no
 * later enrollment or upgrade in the realm takes a fresh baseline without the explicit
 * --new-baseline recovery (which keeps it in `history`). Another profile's entry is never touched.
 * Returns "retired" or null (nothing of this profile's in the own pins).
 */
export function retireOwn(doc, realm, profile, now) {
  const e = doc.own?.[realm];
  if (!e || e.profile !== profile) return null;
  e.retiredAt ??= now;
  return "retired";
}

/** The local device records of every profile of `home` in `realm` that are not retired or revoked: [{profile, device, status}]. */
export function activeProfiles(home, realm) {
  const dir = path.join(home, "mls");
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const profile of names) {
    let rec;
    try {
      rec = JSON.parse(fs.readFileSync(path.join(dir, profile, "device.json"), "utf8"));
    } catch {
      continue;
    }
    if (rec?.realm === realm && rec.status !== "retired" && rec.status !== "revoked") out.push({ profile, device: rec.device, status: rec.status });
  }
  return out.sort((a, b) => (a.profile < b.profile ? -1 : 1));
}

/** The refusal for a home with more than one profile's device in one realm (null: one or none). */
export function realmConflict(home, realm) {
  const list = activeProfiles(home, realm);
  if (list.length <= 1) return null;
  return `this home has devices in realm ${realm} under ${list.length} profiles (${list.map((x) => x.profile).join(", ")}): one device per home and realm. Encryption stops for that realm until you retire all but one (hoptell device retire, in the profile to give up) or remove that profile's state`;
}

/**
 * The keeper of a home's own baseline, for the device store (enrollment step 2) and the engine:
 * ensure(rec) writes or confirms the baseline of local record `rec` under the contacts lock
 * (contacts.updatePins), after checking one profile per realm. `contacts` is the contacts manager
 * (lib/quarantine.js) or a test's; without managed contacts there is no baseline, and nothing
 * enrolls or encrypts.
 */
export function ownKeeper({ contacts, home, profile, now = () => Date.now() }) {
  const usable = () => Boolean(contacts?.updatePins) && !contacts.currentPolicy().legacy;
  return {
    usable,
    /** The own entry of `realm` now (checked), or null. */
    entry: (realm) => (usable() ? ownOf(contacts.currentPolicy().doc ?? null, realm) : null),
    /**
     * Before a new device of this profile is created in `realm`: refused for another profile's
     * device or entry in the realm, and for an own entry of this profile (its enrolled device is
     * another one) unless `newBaseline`.
     */
    precheck(realm, { newBaseline = false } = {}) {
      if (!usable()) throw new OwnError("own devices are kept in the contacts policy, and this home's contacts are not managed yet: run hoptell contacts init first", "no_baseline");
      const others = activeProfiles(home, realm).filter((x) => x.profile !== profile);
      if (others.length) throw new OwnError(`this home already has a device in realm ${realm}, profile ${others[0].profile}: one device per home and realm`, "realm_taken");
      const cur = ownOf(contacts.currentPolicy().doc ?? null, realm);
      if (cur && cur.retiredAt !== undefined && !newBaseline) throw new OwnError(`this home's own device in realm ${realm} (profile ${cur.profile}) was retired: a new device becomes the baseline only on your explicit confirmation: hoptell device enroll --new-baseline (peers then see a new device of yours)`, "baseline_retired");
      if (cur && cur.profile !== profile && !(newBaseline && cur.retiredAt !== undefined)) throw new OwnError(`this home already has a device in realm ${realm}, profile ${cur.profile}: one device per home and realm`, "realm_taken");
      if (cur && !newBaseline) throw new OwnError(`this home's own device in realm ${realm} is ${enrolledOf(cur)?.device}; a new device of this profile becomes a new baseline only on your explicit confirmation: hoptell device enroll --new-baseline (peers then see a new device of yours)`, "baseline_mismatch");
    },
    /** A12: drop the outbox entry of approval signature `sig` once the relay answered it for good. */
    settleApproval: (realm, sig) => contacts.updatePins((doc) => removeApproval(doc, realm, sig)),
    /** A12: replace the outbox entry of approval signature `sig` with `next` (a fresh signature), in one write. */
    replaceApproval: (realm, sig, next) =>
      contacts.updatePins((doc) => {
        if (!removeApproval(doc, realm, sig)) throw new OwnError("the approval left the outbox meanwhile", "stale");
        addApproval(doc, realm, next);
      }),
    async ensure(rec, { newBaseline = false } = {}) {
      // A retired or revoked device may read what it can still decrypt; it never claims the
      // realm's baseline (hoptell device retire marks it retired; only --new-baseline replaces it).
      if (rec.status === "retired" || rec.status === "revoked") throw new OwnError(`device ${rec.device} is ${rec.status}: it is not this home's own device in realm ${rec.realm}, and it records no baseline`, "no_baseline");
      if (!usable()) throw new OwnError("own devices are kept in the contacts policy, and this home's contacts are not managed yet: run hoptell contacts init first", "no_baseline");
      const conflict = realmConflict(home, rec.realm);
      if (conflict && activeProfiles(home, rec.realm).some((x) => x.profile !== profile)) throw new OwnError(conflict, "realm_taken");
      const cur = ownOf(contacts.currentPolicy().doc ?? null, rec.realm);
      if (cur && !newBaseline && cur.retiredAt === undefined && cur.profile === profile && enrolledOf(cur)?.device === rec.device && cur.member === rec.member) return { written: false, upgraded: false, unconfirmed: [] };
      const r = await contacts.updatePins((doc) => writeBaseline(doc, { rec, profile, now: now(), newBaseline }));
      return r.result ?? r;
    },
  };
}

/** A served device (from device_list) checked against its pin, or null when malformed. */
function served(realm, member, d) {
  const key = unb64(d?.key, 32);
  if (!key || typeof d.device !== "string") return null;
  let pin;
  try {
    pin = pinIdentity({ realm, member, device: d.device, key });
  } catch {
    return null;
  }
  if (!unb64(d.pin, 32)?.equals(pin)) return null;
  return { device: d.device, key, pin, seq: Number.isSafeInteger(d.seq) ? d.seq : 0, rotations: Array.isArray(d.rotations) ? d.rotations : [] };
}

/**
 * The relay's list of the own member judged against the own entry (never the other way round):
 * {entry, member, accepted, missing, unaccepted, changed, rotated, revoked, stop}.
 *   accepted    own pins the relay serves with the pinned key (or a valid rotation from it)
 *   missing     own pins the relay does not list (kept: a missing row is not a revocation)
 *   awaiting    accepted own pins whose registration is pending (A12), not listed yet
 *   registered  awaiting own pins the relay now lists with their pinned key, or with a key a
 *               valid rotation chain from it leads to (markRegistered)
 *   unaccepted  devices the relay lists for the own member that are not own pins (unconfirmed
 *               ones from the upgrade are marked); never trusted
 *   changed     own pins served with another key and no valid rotation: a key change (stop)
 *   rotated     accepted rotations to persist (applyOwnRotations)
 *   revoked     served revocations {device, trusted, pinned}; trusted when signed by another own pin
 * `stop` is the reason sending stops for every conversation of the realm (a key change), or null.
 */
export function evaluateOwn(entry, realm, list) {
  const out = { entry, member: entry?.member ?? null, accepted: [], missing: [], awaiting: [], registered: [], unaccepted: [], changed: [], rotated: [], revoked: [], stop: null };
  if (!entry) return out;
  const member = entry.member;
  const pinned = new Map(entry.devices.map((d) => [d.device, d]));
  const unconf = new Map(entry.unconfirmed.map((d) => [d.device, d]));
  const seen = new Set();
  for (const d of list ?? []) {
    if (typeof d?.device !== "string") continue;
    seen.add(d.device);
    if (d.revoked) {
      const st = d.revoked?.statement;
      const by = st && pinned.get(st.by);
      const trusted = Boolean(by && st.by !== d.device && st.device === d.device && st.realm === realm && st.member === member && checkRevocation(st, Buffer.from(by.key, "base64")));
      out.revoked.push({ device: d.device, trusted, pinned: pinned.has(d.device), by: d.revoked?.by ?? null });
      continue;
    }
    const s = served(realm, member, d);
    if (!s) continue;
    const p = pinned.get(s.device);
    if (!p) {
      out.unaccepted.push({ ...s, unconfirmed: unconf.has(s.device), fingerprint: displayFingerprint({ realm, member, device: s.device, key: s.key }) });
      continue;
    }
    if (Buffer.from(p.pin, "base64").equals(s.pin)) {
      out.accepted.push({ ...asServed(p), how: p.how });
      if (p.awaiting) out.registered.push(p.device); // A12: registered now; its mark is cleared (markRegistered)
      continue;
    }
    const r = followRotations({ realm, member, device: s.device, key: Buffer.from(p.key, "base64"), sequence: p.seq, retired: p.retired ?? [] }, s.rotations, s.key);
    if (r.ok) {
      out.rotated.push({ device: s.device, key: r.key, seq: r.sequence, retired: r.retired, pin: s.pin });
      out.accepted.push({ device: s.device, key: r.key, pin: s.pin, seq: r.sequence, retired: r.retired, how: p.how });
      // A12: a valid rotation chain from the pinned key proves the registration too.
      if (p.awaiting) out.registered.push(p.device);
    } else out.changed.push({ device: s.device, reason: r.reason, old: displayFingerprint({ realm, member, device: s.device, key: Buffer.from(p.key, "base64") }), new: displayFingerprint({ realm, member, device: s.device, key: s.key }) });
  }
  // A12: an accepted device awaiting its registration is not missing: the relay has not listed it yet.
  for (const p of entry.devices) if (!seen.has(p.device)) (p.awaiting ? out.awaiting : out.missing).push(asServed(p));
  if (out.changed.length) out.stop = `a key of your own device ${out.changed.map((c) => c.device).join(", ")} changed without a valid rotation: encrypted sending stops until you decide (hoptell device list)`;
  return out;
}

/** A12: clear the awaiting mark of own pins the relay now lists (mutate-style); returns how many. */
export function markRegistered(doc, realm, devices) {
  let n = 0;
  for (const d of doc.own?.[realm]?.devices ?? []) {
    if (d.awaiting && devices.includes(d.device)) {
      delete d.awaiting;
      n++;
    }
  }
  return n;
}

/**
 * A12: persist what `list` (the relay's device_list of the own member) shows of awaiting own pins:
 * a pin the relay now serves with its pinned key (or one a valid rotation chain leads to) is
 * registered, and its mark is cleared in one contacts write, with the validated rotations of own
 * pins, before the caller reports anything. Every path that looks at the own list
 * calls it (device list, verify and the decisions, the owner UI, the e2ee engine's ownView), so a
 * device that registered and is later omitted shows as missing, never as awaiting. Returns
 * whether it wrote.
 */
export async function settleAwaiting(contacts, list) {
  if (!contacts?.updatePins || !list?.realm || !Array.isArray(list.devices)) return false;
  // Also the validated rotations of own pins, as the engine's ownView records them, in the same
  // write: a registration proven by a rotation chain leaves the pin on the served key, so the own
  // half of a safety number never uses a key the relay no longer serves.
  const seenIn = (doc) => {
    try {
      const entry = ownOf(doc, list.realm);
      return entry && entry.member === list.member ? evaluateOwn(entry, list.realm, list.devices) : null;
    } catch {
      return null;
    }
  };
  const ev = seenIn(contacts.currentPolicy?.().doc ?? null);
  if (!ev || (!ev.registered.length && !ev.rotated.length)) return false;
  await contacts.updatePins((doc) => {
    const now = seenIn(doc);
    if (!now) return;
    applyOwnRotations(doc, list.realm, now.rotated);
    markRegistered(doc, list.realm, now.registered);
  });
  return true;
}

/**
 * A12: record what a look at the own devices found in `file` (own-seen.json), unless the file
 * already says exactly that. Compared with the file, not with a writer's memory: the e2ee engine,
 * hoptell device list and verify all write it, so a cache could skip a write the file needs.
 * Returns whether it wrote; a write error throws.
 */
export function writeOwnSeen(file, ev, at = Date.now()) {
  const seen = ownSeenOf(ev);
  let on = null;
  try {
    on = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {}
  if (on && typeof on === "object") {
    delete on.at;
    if (JSON.stringify(on) === JSON.stringify(seen)) return false;
  }
  writeDurable(file, `${JSON.stringify({ at, ...seen })}\n`);
  return true;
}

/** What a look at the own devices found, as recorded for hoptell doctor (own-seen.json; public facts). */
export const ownSeenOf = (ev) => ({ unaccepted: ev.unaccepted.map((d) => ({ device: d.device, fingerprint: d.fingerprint, unconfirmed: d.unconfirmed })), missing: ev.missing.map((d) => d.device), changed: ev.changed.map((d) => d.device), awaiting: ev.awaiting.map((d) => d.device) });

/** Persist accepted rotations of own devices (mutate-style): new key, pin and sequence, the old key retired. */
export function applyOwnRotations(doc, realm, rotated) {
  const e = doc.own?.[realm];
  if (!e) return;
  for (const r of rotated) {
    const d = e.devices.find((x) => x.device === r.device);
    if (d) Object.assign(d, { key: b64(r.key), pin: b64(r.pin), seq: r.seq, retired: r.retired.slice(-100) });
  }
}

/**
 * Own pins under a trusted revocation (signed by another own pin) stop being own pins (mutate-
 * style); they are then removed from every group like any revoked device. Returns the devices dropped.
 */
export function dropRevokedOwn(doc, realm, revoked) {
  const e = doc.own?.[realm];
  if (!e) return [];
  const gone = revoked.filter((r) => r.trusted && r.pinned && enrolledOf(e)?.device !== r.device).map((r) => r.device);
  e.devices = e.devices.filter((d) => !gone.includes(d.device));
  return gone;
}

/** After an accepted removal of own device `device` from every group: it leaves `unconfirmed` (mutate-style). */
export function forgetRemovedOwn(doc, realm, device) {
  const e = doc.own?.[realm];
  if (!e) return false;
  const before = e.unconfirmed.length;
  e.unconfirmed = e.unconfirmed.filter((d) => d.device !== device);
  return before !== e.unconfirmed.length;
}

/**
 * The owner accepts own device `device` (hoptell device accept, on device `by`, an own pin):
 * `s` is the device as the relay serves it now ({device, key, pin, seq}). It becomes an own pin
 * ("accepted", by, at) and leaves `unconfirmed` (mutate-style). An unconfirmed record with
 * another key than the served one is refused (a key change, not an acceptance).
 */
export function acceptOwn(doc, realm, s, { by, now, awaiting = false }) {
  const e = doc.own?.[realm];
  if (!e) throw new OwnError(`this home has no own device in realm ${realm}`, "no_baseline");
  if (!e.devices.some((d) => d.device === by)) throw new OwnError(`device ${by} is not one of your accepted devices`, "not_own");
  if (e.devices.some((d) => d.device === s.device)) return false;
  if (e.devices.length >= MAX_OWN_DEVICES) throw new OwnError(`at most ${MAX_OWN_DEVICES} own devices`, "too_many");
  const u = e.unconfirmed.find((d) => d.device === s.device);
  if (u && !Buffer.from(u.pin, "base64").equals(Buffer.from(s.pin))) throw new OwnError(`the relay serves another key for device ${s.device} than the one recorded before the upgrade; that is a key change, not an acceptance`, "key_changed");
  e.unconfirmed = e.unconfirmed.filter((d) => d.device !== s.device);
  e.devices.push({ device: s.device, key: b64(s.key), pin: b64(s.pin), seq: s.seq ?? 0, retired: [...(s.retired ?? [])], how: "accepted", at: now, by, ...(awaiting ? { awaiting: true } : {}) });
  return true;
}

/**
 * A12: record approval `approval` (wire form, signed by an own device) for new own device `device`
 * with key `key` (base64) in the realm's outbox (mutate-style), in the same write as its pin. An
 * earlier entry for that device is replaced.
 */
export function addApproval(doc, realm, { device, key, approval, at, requested }) {
  const e = doc.own?.[realm];
  if (!e) throw new OwnError(`this home has no own device in realm ${realm}`, "no_baseline");
  const rest = (e.approvals ?? []).filter((x) => x.device !== device);
  if (rest.length >= MAX_OWN_APPROVALS) throw new OwnError(`at most ${MAX_OWN_APPROVALS} approvals wait for the relay`, "too_many");
  e.approvals = [...rest, { device, key, approval, at, ...(requested !== undefined ? { requested } : {}) }];
}

/** A12: drop the outbox entry whose approval has signature `sig` (mutate-style); returns whether one was dropped. */
export function removeApproval(doc, realm, sig) {
  const e = doc.own?.[realm];
  if (!e?.approvals) return false;
  const before = e.approvals.length;
  e.approvals = e.approvals.filter((x) => x.approval.sig !== sig);
  if (!e.approvals.length) delete e.approvals;
  return before !== (e.approvals?.length ?? 0);
}
