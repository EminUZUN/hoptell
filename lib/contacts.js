// Contacts: who may reach the agent sessions of a hoptell home (design 1.5). The owner keeps a
// policy file; messages from senders without a grant are quarantined until the owner decides
// with `hoptell contacts`. A peer's message never approves anything, and no MCP tool can.
//
// This module is pure policy: the file's validation (schema/contacts.schema.json, checked here
// without a schema library), sender keys from the provenance the relay recorded, decide(), and
// a cached reader that notices revisions. Requests, budgets and quarantine live in lib/quarantine.js.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { NAME_RE } from "./config.js";
import { attestedE2ee } from "./attested.js";
import { checkOwn } from "./mls/own.js";

const REALM_RE = /^[0-9a-f]{32}$/;
const MEMBER_RE = /^(m_[a-z2-7]{26}|name:[A-Za-z0-9][A-Za-z0-9_-]{0,63})$/;
const PROFILE_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const ID_RE = /^[gb]_[a-z2-7]{16}$/;
const POLICIES = ["ask", "allow", "block"];
const TOP = new Set(["version", "revision", "default", "unverified", "grants", "blocks", "replies", "pins", "requireVerified", "encryption", "hosted", "transfers", "own"]);
const ENCRYPTION_MODES = ["required", "preferred", "off"];
const PIN_ENTRY = new Set(["realm", "member", "devices", "verifiedAt", "how", "requireVerified", "decisions", "revoked", "revokedOverflow"]);
const PIN_DEVICE = new Set(["device", "pin", "key", "seq", "retired"]);
const PIN_HOW = ["in-person", "out-of-band", "relay-tofu"];
const DEVICE_RE = /^[a-z2-7]{25}[aeimquy4]$/;
const b64Of = (x, n) => isStr(x) && /^[A-Za-z0-9+/]*={0,2}$/.test(x) && Buffer.from(x, "base64").length === n;
const ENTRY = new Set(["id", "realm", "member", "shared", "name", "unverified", "relay", "session", "added", "note"]);

// Regex tests coerce their argument (an array becomes a string): check the type first.
const isStr = (x) => typeof x === "string";
const realmOk = (x) => isStr(x) && REALM_RE.test(x);
const memberOk = (x) => isStr(x) && MEMBER_RE.test(x);
const nameOk = (x) => isStr(x) && NAME_RE.test(x);
const profileOk = (x) => isStr(x) && PROFILE_RE.test(x);
const b32 = (n) => [...crypto.randomBytes(n)].map((b) => "abcdefghijklmnopqrstuvwxyz234567"[b & 31]).join("");
export const newEntryId = (kind) => `${kind}_${b32(16)}`;

/** The policy file of a home. */
export const contactsFile = (home) => path.join(home, "contacts.json");

/** A new install's policy: ask for everyone. */
export const freshContacts = () => ({ version: 1, revision: 0, default: "ask", unverified: "ask", grants: [], blocks: [] });

function checkEntry(e, where, kind) {
  if (!e || typeof e !== "object" || Array.isArray(e)) return `${where}: expected an object`;
  for (const k of Object.keys(e)) if (!ENTRY.has(k)) return `${where}: unknown field "${k}"`;
  if (e.id !== undefined && (!isStr(e.id) || !ID_RE.test(e.id) || e.id[0] !== kind)) return `${where}: id must look like ${kind}_ and 16 letters a-z or digits 2-7`;
  const forms = [e.member !== undefined, e.shared !== undefined, e.unverified !== undefined].filter(Boolean).length;
  if (forms !== 1) return `${where}: use exactly one of "member", "shared": true with "name", or "unverified": true with "relay" and "name"`;
  if (e.unverified !== undefined) {
    if (kind === "g") return `${where}: unverified senders cannot get a grant (their names are not authenticated); use allow-once`;
    if (e.unverified !== true || !profileOk(e.relay) || !nameOk(e.name)) return `${where}: an unverified entry needs "unverified": true, a "relay" profile and a "name"`;
    if (e.realm !== undefined) return `${where}: an unverified entry has no realm`;
  } else {
    if (!realmOk(e.realm)) return `${where}: realm must be a relay realm id (32 hex digits, shown by hoptell doctor)`;
    if (e.member !== undefined && (!memberOk(e.member) || e.name !== undefined)) return `${where}: member must be a member id (m_… or name:<name>)`;
    if (e.shared !== undefined && (e.shared !== true || !nameOk(e.name))) return `${where}: a shared-token entry needs "shared": true and an exact "name"`;
    if (e.relay !== undefined) return `${where}: "relay" belongs to unverified entries`;
  }
  if (e.session !== undefined) {
    const s = e.session;
    if (!s || typeof s !== "object" || Array.isArray(s) || !realmOk(s.realm) || !nameOk(s.name) || Object.keys(s).some((k) => k !== "realm" && k !== "name")) {
      return `${where}: session must be {"realm": <realm id>, "name": <receiving session name>}`;
    }
  }
  if (e.added !== undefined && typeof e.added !== "string") return `${where}: added must be text`;
  if (e.note !== undefined && (typeof e.note !== "string" || e.note.length > 200)) return `${where}: note must be text up to 200 characters`;
  return null;
}

function checkPin(p, where) {
  if (!p || typeof p !== "object" || Array.isArray(p)) return `${where}: expected an object`;
  for (const k of Object.keys(p)) if (!PIN_ENTRY.has(k)) return `${where}: unknown field "${k}"`;
  if (!realmOk(p.realm) || !memberOk(p.member)) return `${where}: a pin needs a realm id and a member id`;
  if (!PIN_HOW.includes(p.how)) return `${where}: how must be "in-person", "out-of-band" or "relay-tofu"`;
  if (!isStr(p.verifiedAt)) return `${where}: verifiedAt must be a time`;
  if (p.requireVerified !== undefined && typeof p.requireVerified !== "boolean") return `${where}: requireVerified must be true or false`;
  if (!Array.isArray(p.devices) || p.devices.length > 20) return `${where}: devices must be a list of at most 20`;
  for (const d of p.devices) {
    if (!d || typeof d !== "object" || Object.keys(d).some((k) => !PIN_DEVICE.has(k))) return `${where}: a device is {device, pin, key, seq, retired}`;
    if (!isStr(d.device) || !DEVICE_RE.test(d.device) || !b64Of(d.pin, 32) || !b64Of(d.key, 32) || !(Number.isSafeInteger(d.seq) && d.seq >= 0)) return `${where}: a device needs a device id, a pin and key (32 bytes, base64) and a sequence`;
    if (d.retired !== undefined && !(Array.isArray(d.retired) && d.retired.length <= 100 && d.retired.every((h) => isStr(h) && /^[0-9a-f]{64}$/.test(h)))) return `${where}: retired must be a list of keys (hex)`;
  }
  if (p.revoked !== undefined && !(Array.isArray(p.revoked) && p.revoked.length <= 100 && p.revoked.every((r) => r && typeof r === "object" && Object.keys(r).every((k) => ["device", "by", "at"].includes(k)) && isStr(r.device) && DEVICE_RE.test(r.device) && isStr(r.by) && DEVICE_RE.test(r.by) && (r.at === undefined || Number.isSafeInteger(r.at))))) {
    return `${where}: revoked must be a list of at most 100 {device, by, at}`;
  }
  if (p.revokedOverflow !== undefined && p.revokedOverflow !== true) {
    return `${where}: revokedOverflow must be true when present`;
  }
  if (p.decisions !== undefined && !(Array.isArray(p.decisions) && p.decisions.length <= 20 && p.decisions.every((x) => x && typeof x === "object" && !Array.isArray(x)))) return `${where}: decisions must be a list of at most 20 records`;
  return null;
}

/** Validate a parsed policy; returns a list of problems (empty when valid). */
export function validateContacts(doc) {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return ["the contacts file must be a JSON object"];
  const problems = [];
  for (const k of Object.keys(doc)) if (!TOP.has(k)) problems.push(`unknown field "${k}"`);
  if (doc.version !== 1) problems.push("version must be 1");
  if (doc.revision !== undefined && !(Number.isSafeInteger(doc.revision) && doc.revision >= 0)) problems.push("revision must be a whole number");
  if (!POLICIES.includes(doc.default)) problems.push('default must be "ask", "allow" or "block"');
  if (doc.unverified !== undefined && !["ask", "block"].includes(doc.unverified)) problems.push('unverified must be "ask" or "block"');
  for (const [list, kind] of [["grants", "g"], ["blocks", "b"]]) {
    if (doc[list] === undefined) continue;
    if (!Array.isArray(doc[list])) problems.push(`${list} must be a list`);
    else doc[list].forEach((e, i) => {
      const p = checkEntry(e, `${list}[${i}]`, kind);
      if (p) problems.push(p);
    });
  }
  // Device pins (design 3.2, experimental): what the owner verified, by (realm, member).
  if (doc.pins !== undefined) {
    if (!Array.isArray(doc.pins)) problems.push("pins must be a list");
    else {
      const seen = new Set();
      doc.pins.forEach((p, i) => {
        const problem = checkPin(p, `pins[${i}]`);
        if (problem) return problems.push(problem);
        const k = `${p.realm}|${p.member}`;
        if (seen.has(k)) problems.push(`pins[${i}]: (realm, member) is pinned twice`);
        seen.add(k);
      });
    }
  }
  // Own devices (design 3.2 v2.2, experimental): this home's own pins per realm (lib/mls/own.js).
  problems.push(...checkOwn(doc));
  if (doc.requireVerified !== undefined && !(Array.isArray(doc.requireVerified) && doc.requireVerified.every(realmOk))) problems.push("requireVerified must be a list of realm ids");
  // Require-encryption policy (design 3.3, experimental): per contact, and per realm as a default.
  if (doc.encryption !== undefined) {
    if (!Array.isArray(doc.encryption) || doc.encryption.length > 1000) problems.push("encryption must be a list of at most 1000 entries");
    else {
      const seen = new Set();
      doc.encryption.forEach((e, i) => {
        if (!e || typeof e !== "object" || Array.isArray(e) || Object.keys(e).some((k) => !["realm", "member", "mode", "custody"].includes(k))) return problems.push(`encryption[${i}]: an entry is {realm, member?, mode, custody?}`);
        // Hosted custody (design 4.5): "allow-hosted" lets a preferred contact that is hosted get
        // a separate direct plaintext send; it never weakens "required". Per contact only.
        if (e.custody !== undefined && (e.custody !== "allow-hosted" || e.member === undefined)) return problems.push(`encryption[${i}]: custody must be "allow-hosted", for one contact (with a member)`);
        if (!realmOk(e.realm) || (e.member !== undefined && !memberOk(e.member))) return problems.push(`encryption[${i}]: a realm id and, for one contact, a member id`);
        if (!ENCRYPTION_MODES.includes(e.mode)) return problems.push(`encryption[${i}]: mode must be "required", "preferred" or "off"`);
        const k = `${e.realm}|${e.member ?? ""}`;
        if (seen.has(k)) problems.push(`encryption[${i}]: listed twice`);
        seen.add(k);
      });
    }
  }
  // Larger transfers (design 6, experimental): per contact {allowed, maxBytes}, and the home's caps.
  if (doc.transfers !== undefined) problems.push(...checkTransfers(doc.transfers));
  // Hosted senders as a class (design 4.5): ask (default: a grant is needed), block or allow.
  if (doc.hosted !== undefined && !["ask", "block", "allow"].includes(doc.hosted)) problems.push('hosted must be "ask", "block" or "allow"');
  if (doc.replies !== undefined) {
    const r = doc.replies;
    if (!r || typeof r !== "object" || Array.isArray(r) || Object.keys(r).some((k) => k !== "allowWithin")) problems.push("replies must be an object with allowWithin");
    else if (r.allowWithin !== undefined && r.allowWithin !== null) problems.push("replies.allowWithin is not supported yet (reply allowances come later); remove it or set it to null");
  }
  return problems;
}

/** The home's staging caps for transfers when contacts.json sets none (design 6, "Download and staging"). */
export const TRANSFER_CAPS = Object.freeze({ stagedBytes: 2 * 1024 ** 3, stagedFiles: 20, concurrent: 2 });
const MAX_TRANSFER_BYTES = 200 * 1024 * 1024;

function checkTransfers(t) {
  if (!t || typeof t !== "object" || Array.isArray(t) || Object.keys(t).some((k) => !["contacts", "stagedBytes", "stagedFiles", "concurrent"].includes(k))) return ["transfers must be {contacts, stagedBytes?, stagedFiles?, concurrent?}"];
  const problems = [];
  const whole = (v, min, max) => Number.isSafeInteger(v) && v >= min && v <= max;
  if (t.stagedBytes !== undefined && !whole(t.stagedBytes, 0, 2 ** 50)) problems.push("transfers.stagedBytes must be a whole number of bytes");
  if (t.stagedFiles !== undefined && !whole(t.stagedFiles, 0, 10_000)) problems.push("transfers.stagedFiles must be a whole number");
  if (t.concurrent !== undefined && !whole(t.concurrent, 0, 16)) problems.push("transfers.concurrent must be a whole number from 0 to 16");
  if (t.contacts !== undefined) {
    if (!Array.isArray(t.contacts) || t.contacts.length > 1000) return [...problems, "transfers.contacts must be a list of at most 1000 entries"];
    const seen = new Set();
    t.contacts.forEach((e, i) => {
      if (!e || typeof e !== "object" || Array.isArray(e) || Object.keys(e).some((k) => !["realm", "member", "allowed", "maxBytes"].includes(k))) return problems.push(`transfers.contacts[${i}]: an entry is {realm, member, allowed, maxBytes?}`);
      if (!realmOk(e.realm) || !memberOk(e.member)) return problems.push(`transfers.contacts[${i}]: a realm id and a member id`);
      if (typeof e.allowed !== "boolean") return problems.push(`transfers.contacts[${i}]: allowed must be true or false`);
      if (e.maxBytes !== undefined && !whole(e.maxBytes, 0, MAX_TRANSFER_BYTES)) return problems.push(`transfers.contacts[${i}]: maxBytes must be a whole number of bytes up to ${MAX_TRANSFER_BYTES}`);
      const k = `${e.realm}|${e.member}`;
      if (seen.has(k)) problems.push(`transfers.contacts[${i}]: listed twice`);
      seen.add(k);
    });
  }
  return problems;
}

/**
 * Whether member `member` of `realm` may send this home larger transfers (design 6): its entry's
 * {allowed, maxBytes}; the default is not allowed. maxBytes defaults to the format's limit.
 */
export function transferPolicy(doc, realm, member) {
  const e = (doc?.transfers?.contacts ?? []).find((x) => x.realm === realm && x.member === member);
  return { allowed: e?.allowed === true, maxBytes: e?.maxBytes ?? MAX_TRANSFER_BYTES };
}

/** The home's staging caps: {stagedBytes, stagedFiles, concurrent}. */
export const transferCaps = (doc) => ({ stagedBytes: doc?.transfers?.stagedBytes ?? TRANSFER_CAPS.stagedBytes, stagedFiles: doc?.transfers?.stagedFiles ?? TRANSFER_CAPS.stagedFiles, concurrent: doc?.transfers?.concurrent ?? TRANSFER_CAPS.concurrent });

/**
 * The encryption policy for member `member` of `realm` (design 3.3, experimental): the contact's
 * own entry, else the realm's default, else "off".
 */
/** Whether the owner set custody "allow-hosted" for that contact (design 4.5). */
export const allowsHosted = (doc, realm, member) => (doc?.encryption ?? []).some((e) => e.realm === realm && e.member === member && e.custody === "allow-hosted");

export function encryptionMode(doc, realm, member) {
  const list = doc?.encryption ?? [];
  return (list.find((e) => e.realm === realm && e.member === member) ?? list.find((e) => e.realm === realm && e.member === undefined))?.mode ?? "off";
}

/**
 * The effective encryption mode for this home's OWN member `member` of `realm`: encryptionMode
 * exactly (its own entry, else the realm's default, else "off"; a missing or unusable policy, doc
 * null, is "off" as for decide()). The one check of the features that send plaintext between the
 * owner's own sessions through the relay: the owner channel (ask_owner and the bridge, design 7.2)
 * and spawned-run results (design 7.1). There is deliberately no own-member exception on the
 * receive side: a relay can claim any member, so under "required" these features refuse instead.
 * A member-specific "off" entry for the own member is the owner's explicit override, and it is
 * broad: it lets plaintext from every session claiming that member in that realm through, not only
 * these features. Returns "off", "preferred" or "required"; with no member known, the realm's default applies.
 */
export function ownEncryptionMode(doc, realm, member) {
  return encryptionMode(doc, realm, member ?? undefined);
}

/** Whether ownEncryptionMode is "required": these features then send nothing in plaintext. */
export const ownPlaintextRefused = (doc, realm, member) => ownEncryptionMode(doc, realm, member) === "required";

/** The refusal of those features, with the code they all use. */
export const ENCRYPTION_REQUIRED = "encryption_required";

/** Why a send is refused when the policy cannot be read (`why` names the file and its problem). */
export const policyUnreadable = (why, tail = "nothing was sent") => `the contacts cannot be read (${why || "unknown problem"}), so the encryption policy cannot be checked; ${tail}`;

/**
 * The encryption policy for an outgoing send, failing closed (design 3.3): `current` is the
 * contacts manager's currentPolicy() ({doc, problem}, or {legacy: true} for a home whose contacts
 * are not managed), or null when the contacts could not be opened. Returns {doc, refuse}: doc null
 * and no refusal for a legacy home (it has no policy); a refusal when a managed policy is missing,
 * unreadable or invalid (with `problem`, which names the file), so a broken file never turns a
 * "required" contact into plaintext.
 */
export function sendPolicy(current) {
  if (current?.legacy === true) return { doc: null, refuse: null };
  if (!current || current.problem || !current.doc || typeof current.doc !== "object") {
    const problem = (current ? current.problem : "the contacts of this home could not be opened") || "no policy document";
    return { doc: null, refuse: policyUnreadable(problem), problem };
  }
  return { doc: current.doc, refuse: null };
}

/**
 * The same for a process that reads the policy file without a contacts manager (the owner
 * channel's bridge, spawned runs): `state` is {managed, read} where `read` is readContacts' result.
 * A home whose contacts are not managed has no policy (doc null); a managed one must have a valid file.
 */
export function filePolicy({ managed, read }) {
  if (!managed) return { doc: read?.doc ?? null, refuse: null };
  return sendPolicy(read ?? null);
}

/**
 * Whether the contacts of `home` are managed, read-only (creates nothing): a policy file exists,
 * or the marker (contacts/state.json, lib/quarantine.js) says managed or is damaged (fail closed).
 */
export function homeManaged(home) {
  if (fs.existsSync(contactsFile(home))) return true;
  let text = null;
  try {
    text = fs.readFileSync(path.join(home, "contacts", "state.json"), "utf8");
  } catch (e) {
    if (e.code !== "ENOENT") return true;
  }
  if (text !== null) {
    try {
      return JSON.parse(text)?.mode !== "legacy-allow";
    } catch {
      return true;
    }
  }
  // Marker and policy both lost: a managed session store is the second witness, as at startup.
  try {
    return managedStoreWitness(home, { strict: true });
  } catch {
    return true;
  }
}

/**
 * Whether a session store of `home` records managed contacts: protocol-2 stores under v2/ and
 * protocol-1 stores under legacy/ (a second witness when the marker is lost). A folder that cannot
 * be listed throws; a store file that cannot be read counts as a witness with `strict`, else not.
 */
export function managedStoreWitness(home, { strict = false } = {}) {
  const list = (dir) => {
    try {
      return fs.readdirSync(dir);
    } catch (e) {
      if (e.code === "ENOENT") return [];
      throw e;
    }
  };
  const v2 = path.join(home, "v2");
  const dirs = [];
  for (const realm of list(v2)) for (const m of list(path.join(v2, realm))) for (const k of list(path.join(v2, realm, m))) dirs.push(path.join(v2, realm, m, k));
  for (const n of list(path.join(home, "legacy"))) dirs.push(path.join(home, "legacy", n));
  return dirs.some((d) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(d, "store.json"), "utf8"))?.contacts === "managed";
    } catch (e) {
      return strict && e.code !== "ENOENT" && e.code !== "ENOTDIR";
    }
  });
}

/** filePolicy for `home` now: {doc, refuse}. */
export const homeSendPolicy = (home) => filePolicy({ managed: homeManaged(home), read: readContacts(contactsFile(home)) });

/**
 * The sender key of a stored message, from the provenance the relay recorded (never inferred or
 * upgraded later): {realm, member} for member tokens, {realm, shared, name} for the shared
 * token, and {unverified, relay, name} otherwise (protocol 1, missing or malformed provenance),
 * where relay is the profile recorded with the message when it arrived (or null: unknown).
 */
export function senderKey(msg) {
  const s = msg?.sender;
  const realm = realmOk(s?.realm) ? s.realm : null;
  // e2ee: decrypted on this device, as checked from its receipt (lib/attested.js, set by
  // lib/quarantine.js attest); a stored "e2ee" field alone never counts (an older writer may have
  // kept a relay's), so it cannot claim encryption for plaintext.
  // Hosted custody (design 4.5): the relay's provenance says a host holds the sender (its host can read).
  if (s?.auth === "member" && realm && memberOk(s.member?.id)) return { realm, member: s.member.id, label: `member ${nameOk(s.member.name) ? s.member.name : s.member.id}${s.custody === "hosted" ? " (hosted)" : ""}`, ...(attestedE2ee(msg) ? { e2ee: true } : {}), ...(s.custody === "hosted" ? { hosted: true } : {}) };
  if (s?.auth === "shared" && realm && nameOk(msg.from)) return { realm, shared: true, name: msg.from, label: `${msg.from} (shared token)` };
  // Unverified: the relay profile recorded with the message at arrival (never the reader's).
  const name = nameOk(msg?.from) ? msg.from : null;
  const relay = profileOk(msg?.relayProfile) ? msg.relayProfile : null;
  return { unverified: true, relay, name, label: `${name ?? "unknown"} (unverified)` };
}

/** A stable text form of a sender key, for request ids and comparisons. */
export const keyId = (k) => (k.unverified ? `u|${k.relay ?? ""}|${k.name ?? ""}` : k.member ? `m|${k.realm}|${k.member}` : `s|${k.realm}|${k.name}`);

const sameSession = (e, session) => e.session === undefined || (session && e.session.realm === session.realm && e.session.name === session.name);
const matches = (e, k, session) => {
  if (!sameSession(e, session)) return false;
  if (k.unverified) return e.unverified === true && e.relay === k.relay && e.name === k.name;
  if (e.unverified || e.realm !== k.realm) return false;
  return k.member ? e.member === k.member : e.shared === true && e.name === k.name;
};

/**
 * What happens to a message from sender key `k` to the receiving session `session`
 * ({realm, name}) under policy `contacts` (a validated document, or null when there is no usable
 * policy in managed mode, which means "ask" for everyone). Returns "allow", "ask", "block" or
 * "policy" (plaintext from a contact whose encryption is required: held like "ask", never
 * released by allow-once). First match wins: a block; a policy violation; for unverified senders
 * a blocking policy, else ask; a grant; the default.
 */
export function decide(contacts, k, session) {
  if (!contacts) return "ask";
  if ((contacts.blocks ?? []).some((e) => matches(e, k, session))) return "block";
  // Plaintext from a contact whose encryption is required: a policy violation, held whatever the
  // grants say ("policy"; only a change of that contact's encryption policy releases it).
  if (k.member && !k.e2ee && encryptionMode(contacts, k.realm, k.member) === "required") return "policy";
  if (k.unverified) return contacts.unverified === "block" || contacts.default === "block" ? "block" : "ask";
  // Hosted senders (design 4.5) as a class: blocked, or (ask, the default) reaching the session
  // only with a grant for that member, whatever the default; "allow" treats them as any member.
  // OWNER-OPEN (open point 6): whether "ask" stays the default for hosted senders.
  if (k.hosted && (contacts.hosted ?? "ask") === "block") return "block";
  if ((contacts.grants ?? []).some((e) => matches(e, k, session))) return "allow";
  if (k.hosted && (contacts.hosted ?? "ask") === "ask") return contacts.default === "block" ? "block" : "ask";
  return contacts.default;
}

/**
 * Read the policy file. Returns {doc, problem}: doc null with a problem when it is missing,
 * unreadable or invalid (the caller treats that as "ask" for everyone in managed mode).
 */
export function readContacts(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    return { doc: null, problem: e.code === "ENOENT" ? `${file} is missing` : `${file} cannot be read (${e.code})` };
  }
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    return { doc: null, problem: `${file} is not valid JSON` };
  }
  const problems = validateContacts(doc);
  return problems.length ? { doc: null, problem: `${file}: ${problems[0]}` } : { doc, problem: null };
}

/**
 * A reader that re-reads the policy only when the file changes (identity, size or time), so every
 * process sees a revoke or block before its next exposure without parsing on every message.
 */
export function policyReader(file) {
  let stamp = null;
  let cached = { doc: null, problem: `${file} is missing` };
  return () => {
    let st = null;
    try {
      st = fs.statSync(file);
    } catch {}
    const now = st ? `${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}` : "none";
    if (now !== stamp) {
      cached = readContacts(file);
      stamp = now;
    }
    return cached;
  };
}
