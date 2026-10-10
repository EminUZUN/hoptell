// Own-device trust (design 3.2 v2.2, amendments-3.5-prep A1), hoptell's own layer. EXPERIMENTAL.
//
// The owner's own devices are never trusted because the relay lists them. contacts.json keeps
// them in one top-level object `own`, keyed by realm id:
//   own.<realm> = {member, profile, devices: [...], unconfirmed: [...], upgradedAt?, retiredAt?, history?}
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
import { b64, checkRevocation, displayFingerprint, followRotations, pinIdentity, unb64 } from "./identity.js";

const REALM_RE = /^[0-9a-f]{32}$/;
const MEMBER_RE = /^(m_[a-z2-7]{26}|name:[A-Za-z0-9][A-Za-z0-9_-]{0,63})$/;
const PROFILE_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const DEVICE_RE = /^[a-z2-7]{25}[aeimquy4]$/;
const ENTRY_KEYS = new Set(["member", "profile", "devices", "unconfirmed", "upgradedAt", "retiredAt", "history"]);
export const MAX_OWN_HISTORY = 10;
const DEVICE_KEYS = new Set(["device", "key", "pin", "seq", "retired", "how", "at", "by"]);
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
    if (enrolled !== 1) problems.push(`${at}: exactly one enrolled device (this home's own) is required, found ${enrolled}`);
    if ((doc.pins ?? []).some((p) => p?.realm === realm && p?.member === e.member)) problems.push(`${at}: the own member ${e.member} must not be in pins (own devices are kept only here)`);
  }
  return problems;
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
 *   unaccepted  devices the relay lists for the own member that are not own pins (unconfirmed
 *               ones from the upgrade are marked); never trusted
 *   changed     own pins served with another key and no valid rotation: a key change (stop)
 *   rotated     accepted rotations to persist (applyOwnRotations)
 *   revoked     served revocations {device, trusted, pinned}; trusted when signed by another own pin
 * `stop` is the reason sending stops for every conversation of the realm (a key change), or null.
 */
export function evaluateOwn(entry, realm, list) {
  const out = { entry, member: entry?.member ?? null, accepted: [], missing: [], unaccepted: [], changed: [], rotated: [], revoked: [], stop: null };
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
      continue;
    }
    const r = followRotations({ realm, member, device: s.device, key: Buffer.from(p.key, "base64"), sequence: p.seq, retired: p.retired ?? [] }, s.rotations, s.key);
    if (r.ok) {
      out.rotated.push({ device: s.device, key: r.key, seq: r.sequence, retired: r.retired, pin: s.pin });
      out.accepted.push({ device: s.device, key: r.key, pin: s.pin, seq: r.sequence, retired: r.retired, how: p.how });
    } else out.changed.push({ device: s.device, reason: r.reason, old: displayFingerprint({ realm, member, device: s.device, key: Buffer.from(p.key, "base64") }), new: displayFingerprint({ realm, member, device: s.device, key: s.key }) });
  }
  for (const p of entry.devices) if (!seen.has(p.device)) out.missing.push(asServed(p));
  if (out.changed.length) out.stop = `a key of your own device ${out.changed.map((c) => c.device).join(", ")} changed without a valid rotation: encrypted sending stops until you decide (hoptell device list)`;
  return out;
}

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
export function acceptOwn(doc, realm, s, { by, now }) {
  const e = doc.own?.[realm];
  if (!e) throw new OwnError(`this home has no own device in realm ${realm}`, "no_baseline");
  if (!e.devices.some((d) => d.device === by)) throw new OwnError(`device ${by} is not one of your accepted devices`, "not_own");
  if (e.devices.some((d) => d.device === s.device)) return false;
  if (e.devices.length >= MAX_OWN_DEVICES) throw new OwnError(`at most ${MAX_OWN_DEVICES} own devices`, "too_many");
  const u = e.unconfirmed.find((d) => d.device === s.device);
  if (u && !Buffer.from(u.pin, "base64").equals(Buffer.from(s.pin))) throw new OwnError(`the relay serves another key for device ${s.device} than the one recorded before the upgrade; that is a key change, not an acceptance`, "key_changed");
  e.unconfirmed = e.unconfirmed.filter((d) => d.device !== s.device);
  e.devices.push({ device: s.device, key: b64(s.key), pin: b64(s.pin), seq: s.seq ?? 0, retired: [...(s.retired ?? [])], how: "accepted", at: now, by });
  return true;
}
