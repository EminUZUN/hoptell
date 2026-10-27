// The contacts manager of a hoptell home (design 1.5): install mode, held-back messages
// (quarantine) and their requests, budgets, the owner's decisions with a journal, and
// best-effort desktop notifications. Everything here runs under the contacts lock; session store
// transactions nest inside (lock order: contacts, then stores).
//
//   <home>/contacts.json                 the policy (lib/contacts.js)
//   <home>/contacts/state.json           mode marker, counters, notification times
//   <home>/contacts/requests/<id>.json   pending requests (one per sender key)
//   <home>/contacts/journal/<id>.json    decisions in progress
//   <home>/contacts/done.json            the last 100 finished requests
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { ensurePrivateDir } from "./config.js";
import { ICON_PATH } from "./icons.js";
import { storedE2eeValid, storedOwner, storedOwnerValid } from "./ownersig.js";
import { ATTESTED } from "./attested.js";
import { contactsFile, decide, encryptionMode, freshContacts, keyId, managedStoreWitness, newEntryId, policyReader, readContacts, senderKey, validateContacts } from "./contacts.js";
import { withLock } from "./locks.js";
import { openStore } from "./store.js";

/**
 * The stable id of a message adopted from a file it was accepted in before (a protocol-1 inbox):
 * the same for every attempt, whichever way the policy decides, so a retry finds the copy.
 */
export const adoptionId = (source) => `adopt_${crypto.createHash("sha256").update(source).digest("hex").slice(0, 32)}`;

export const KEY_MAX_MESSAGES = 50;
export const KEY_MAX_BYTES = 1024 * 1024;
export const HOME_MAX_MESSAGES = 500;
export const HOME_MAX_BYTES = 10 * 1024 * 1024;
export const MAX_REQUESTS = 200;
export const EXPIRY_MS = 7 * 86400_000;
const DONE_MAX = 100;
const NOTIFY_MIN_GAP_MS = 60_000;
const NOTIFY_PER_HOUR = 10;
const EARLIER_STATE = ["inbox", "v2", "profiles", "sessions", "snapshots"];

/**
 * Whether stored message `msg` (sender key `k`) of `home` is an owner-channel message (an answer,
 * an instruction or the bridge's status) delivered by the relay from this session's own member
 * `own` in the session's realm, with this machine's receipt for this session and a signed envelope
 * (kept with it) that still checks out against a key this home trusts: a stored `owner` flag
 * alone never counts (an older writer may have kept a relay's).
 */
const ownerVerified = (home, msg, k, session, own) =>
  msg?.owner?.result === "verified" && typeof own === "string" && !k.unverified && k.member === own && Boolean(session?.realm) && k.realm === session.realm && msg.owner.realm === session.realm && storedOwnerValid(home, msg, { realm: session.realm, member: own, session: session.name });
/**
 * Whether sender key `k` is this session's own member (contacts self-trust): a member key the relay
 * recorded (auth "member", never a shared token, an unverified sender or hosted custody), in the
 * receiving session's realm, whose member id equals `own`, the session's own member id as the relay
 * authenticated it (its welcome, or the binding of the store written from it). Ids only: names and
 * hosts never count. A relay that records no provenance gives an unverified key, so nothing matches.
 */
/**
 * The member id a receiving session trusts as its own (design contacts-self): the member its
 * relay's welcome names, unless that member is in hosted custody (a host could speak for it), or null.
 */
export const ownSelf = (member) => (member && member.custody !== "hosted" && typeof member.id === "string" && member.id !== "" ? member.id : null);
export const selfSender = (k, session, own) => typeof own === "string" && own !== "" && !k.unverified && !k.shared && !k.hosted && typeof k.member === "string" && k.member === own && Boolean(session?.realm) && k.realm === session.realm;
const ALIAS_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

/**
 * Stored message `msg` with what this machine checks now attached (lib/attested.js; the stored
 * fields are left as they are): `owner`, the owner-channel envelope when its receipt is this
 * machine's for this session (`where`: {realm, name: the store key, member: its own member}) and
 * its signature checks against a key this home trusts now, as {kind, address, pairing_at} from
 * the envelope and the pin (`alias`, a local name, names the relay; else the stored address's);
 * `e2ee`, whether its receipt says this device decrypted exactly this message. Records written by
 * an older version have no receipts: they lose the label and the mark, never keep a forged one.
 */
export function attest(home, msg, { realm = null, name = null, member = null, alias = null } = {}) {
  if (!msg || typeof msg !== "object") return msg;
  let owner = null;
  if (msg.owner?.result === "verified" && realm && msg.owner.realm === realm) {
    const env = storedOwner(home, msg, { realm, member, session: name });
    if (env) {
      const stored = typeof msg.owner.address === "string" ? msg.owner.address.split("/")[0] : null;
      const a = ALIAS_RE.test(alias ?? "") ? alias : ALIAS_RE.test(stored ?? "") ? stored : "default";
      owner = { kind: env.kind, address: `${a}/${env.from}`, pairing_at: env.pairing?.at ?? null };
    }
  }
  const e2ee = Object.hasOwn(msg, "e2ee") && storedE2eeValid(home, msg);
  return { ...msg, [ATTESTED]: { owner, e2ee } };
}

const b32 = (n) => [...crypto.randomBytes(n)].map((b) => "abcdefghijklmnopqrstuvwxyz234567"[b & 31]).join("");
const REQ_RE = /^q_[a-z2-7]{16}$/;
const DELIVERY_ID_RE = /^[A-Za-z0-9_-]{1,64}$/; // as the store's delivery ids

const DIR_FSYNC = process.platform !== "win32"; // Windows cannot fsync a directory: skipped by design

/** A refusal the owner should see as is (stale decision, unknown request). `code` "stale": changed since shown. */
export class DecisionError extends Error {}
export const staleError = (msg) => Object.assign(new DecisionError(msg), { code: "stale" });

/** The digest of a file's bytes (null when it does not exist): the token of a whole-file setting. */
export function fileDigest(file) {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
};
/** The subfolders of `dir` (files such as .DS_Store and symbolic links are skipped), or none. */
const subdirs = (dir) => {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
};
const list = (dir) => {
  try {
    return fs.readdirSync(dir);
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
};

/** Session store descriptor for a store folder (bound session or legacy/<name>). */
const storeAt = (dir) => ({ dir, inbox: path.join(dir, "inbox"), seen: path.join(dir, "seen") });

/**
 * A message as it came from a relay, without the fields only this machine may set: "e2ee" (this
 * device's decryption, lib/mls/e2ee.js) and "owner" (the engine's owner-channel verification,
 * design 7.2). Every receive path strips them before anything reads or stores the message.
 */
export function fromRelay(msg) {
  if (!msg || typeof msg !== "object" || (!Object.hasOwn(msg, "e2ee") && !Object.hasOwn(msg, "owner"))) return msg;
  const out = { ...msg };
  delete out.e2ee;
  delete out.owner;
  return out;
}

/**
 * Record, on a message from a relay that does not authenticate senders, which relay profile it
 * arrived through: part of its sender's identity from then on (a reader never relabels it).
 */
export function stamp(msg, relayProfile) {
  if (msg?.sender?.auth === "member" || msg?.sender?.auth === "shared" || msg?.relayProfile) return msg;
  return relayProfile ? { ...msg, relayProfile } : msg;
}

/** Human session scope: "<realm>/<name>" for protocol 2, "legacy/<name>" for protocol 1. */
export const scopeOf = (session) => (session.realm ? `${session.realm}/${session.name}` : `legacy/${session.name}`);

/**
 * Open the contacts manager of `home`. Classifies the install first (before any other state is
 * created), under the contacts lock. `notifier(title, text)` defaults to the platform's desktop
 * notification; `notify: false` turns notifications off.
 */
export async function openContacts(home, { now = () => Date.now(), notify = true, notifier = desktopNotify, log = () => {}, fault = null, admitWrite = null, self = "allow" } = {}) {
  if (self !== "allow" && self !== "hold") throw new Error('contacts: self must be "allow" or "hold"');
  const cdir = path.join(home, "contacts");
  const policyPath = contactsFile(home);
  const statePath = path.join(cdir, "state.json");
  const lockFile = statePath;
  const reqDir = path.join(cdir, "requests");
  const journalDir = path.join(cdir, "journal");
  const donePath = path.join(cdir, "done.json");
  const policy = policyReader(policyPath);
  const stores = new Map(); // store dir -> opened store

  // Strict durable metadata (requests, journals, marker, policy): every failure propagates.
  const syncDir = (dir) => {
    fault?.("contacts-dir-fsync", dir);
    if (!DIR_FSYNC) return;
    const fd = fs.openSync(dir, "r");
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  };
  const save = (file, obj, space = undefined) => {
    const tmp = `${file}.${b32(8)}.tmp`;
    try {
      fault?.("contacts-write", file);
      const fd = fs.openSync(tmp, "wx", 0o600);
      try {
        fs.writeSync(fd, `${JSON.stringify(obj, null, space)}\n`);
        fault?.("contacts-file-fsync", file);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmp, file);
    } catch (e) {
      fs.rmSync(tmp, { force: true });
      throw e;
    }
    syncDir(path.dirname(file));
  };
  /** fsync a file that is already in place, then its folder. */
  const settleFile = (file) => {
    if (fs.existsSync(file)) {
      fault?.("contacts-file-fsync", file);
      const fd = fs.openSync(file, "r");
      try {
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    }
    syncDir(path.dirname(file));
  };
  const discard = (file) => {
    fs.rmSync(file, { force: true });
    syncDir(path.dirname(file));
  };

  const storeFor = async (dir) => {
    // `admitWrite` (hosted mode, design 4.5): quarantine intake is an admission write at the host's limits.
    if (!stores.has(dir)) stores.set(dir, await openStore(storeAt(dir), { fault, managed: isManaged(), admit: admitWrite }));
    return stores.get(dir);
  };

  // ---- classification (design 1.5, section 4) -----------------------------------------------
  function classify() {
    ensurePrivateDir(home);
    ensurePrivateDir(cdir);
    let marker = null;
    let markerCorrupt = false;
    try {
      marker = readJson(statePath);
      if (marker && !["managed", "legacy-allow"].includes(marker.mode)) markerCorrupt = true;
    } catch {
      markerCorrupt = true;
    }
    const hasPolicy = fs.existsSync(policyPath);
    // A managed session store records it (a second witness, if the marker is lost).
    const witness = () => managedStoreWitness(home);
    let mode;
    if (hasPolicy) mode = "managed";
    else if (marker && !markerCorrupt) mode = marker.mode;
    else if (markerCorrupt || witness()) mode = "managed"; // fail closed
    else if (EARLIER_STATE.some((d) => fs.existsSync(path.join(home, d)))) mode = "legacy-allow";
    else {
      // A new install: the policy first, then the marker (a policy file alone already means managed).
      save(policyPath, freshContacts(), 2);
      mode = "managed";
    }
    if (!marker || markerCorrupt || marker.mode !== mode || marker.policy !== policyPath) {
      save(statePath, { v: 1, mode, policy: policyPath, since: marker?.since ?? new Date(now()).toISOString(), dropped: marker?.dropped ?? {}, notified: marker?.notified ?? [] });
    }
    return mode;
  }
  // The contacts folder holds the lock, so it exists first (classification does not count it).
  ensurePrivateDir(home);
  ensurePrivateDir(cdir);
  let mode = await withLock(lockFile, classify);
  const state = () => readJson(statePath) ?? { v: 1, mode, dropped: {}, notified: [] };
  const writeState = (s) => save(statePath, s);

  /**
   * Managed is sticky: once this home is managed (a policy file, or the marker says so, possibly
   * written by another process), this manager never goes back to legacy-allow.
   */
  function isManaged() {
    if (mode === "managed") return true;
    let marker = null;
    let damaged = false;
    try {
      marker = readJson(statePath);
      // The same validation as at startup: anything but a known mode is damaged (fail closed).
      if (!marker || !["managed", "legacy-allow"].includes(marker.mode)) damaged = true;
    } catch {
      damaged = true;
    }
    if (damaged || fs.existsSync(policyPath) || marker.mode === "managed") {
      mode = "managed";
      // Stores opened before the home became managed record it too.
      for (const st of stores.values()) st.markManaged().catch(() => {});
    }
    return mode === "managed";
  }

  /**
   * The policy to apply now. Legacy-allow (an existing install not yet migrated) delivers
   * everything, as before; managed without a usable file makes everyone "ask" (doc null).
   */
  let lastProblem = null;
  function currentPolicy() {
    if (!isManaged()) return { doc: null, legacy: true };
    const r = policy();
    if (r.problem && r.problem !== lastProblem) log(`contacts: ${r.problem}; every sender waits for your decision (hoptell contacts)`);
    lastProblem = r.problem;
    return { doc: r.doc, problem: r.problem };
  }
  /**
   * The four-verdict decision for a stored message (its sender as recorded at arrival): decide()
   * with one exception, an owner-channel message (design 7.2) that this machine's
   * engine verified at arrival (pin, signature, realm, addressee, replay: `msg.owner.result` is
   * set only there, never by a peer or the relay) and that the relay delivered from this
   * session's own member (`own`) in its realm. That one is not held as "ask" (no grant needed for
   * your own owner channel); a block still drops it, and plaintext from a member whose encryption
   * is required is still a policy violation. Without a valid policy document everyone stays "ask".
   * The same holds for a message from the session's own member (selfSender) unless `self` is
   * "hold" (HOPTELL_CONTACTS_SELF): only an "ask" becomes "allow", so a block, a default "block"
   * and a require-encryption violation ("policy") still apply.
   */
  /**
   * The sender key of a stored message, its encryption as this machine checks it (the e2ee
   * receipt, never a stored mark alone). `decrypting`: a check before this device decrypts it
   * (lib/mls/e2ee.js admitted), which is encrypted by construction.
   */
  const keyOf = (msg, { decrypting = false } = {}) => {
    if (!msg || typeof msg !== "object") return senderKey(msg);
    const e2ee = decrypting || (Object.hasOwn(msg, "e2ee") && storedE2eeValid(home, msg));
    return senderKey({ ...msg, [ATTESTED]: { owner: null, e2ee } });
  };
  // `opts.self`: the own member for self-trust when it differs from `own` (null: none, e.g. a
  // hosted receiver); unset, `own` is used for both.
  const decision = (msg, session, own = null, opts = {}) => {
    const p = currentPolicy();
    if (p.legacy) return "allow";
    const k = keyOf(msg, opts);
    const v = decide(p.doc, k, session);
    const selfId = opts.self !== undefined ? opts.self : own;
    if (v === "ask" && p.doc && ((self === "allow" && selfSender(k, session, selfId)) || ownerVerified(home, msg, k, session, own))) return "allow";
    return v;
  };
  /** The decision for a stored message, with "policy" held as "ask" (see decision). */
  const verdict = (msg, session, own = null, opts = {}) => {
    const v = decision(msg, session, own, opts);
    // A require-encryption violation is held like "ask" (the store and its screens know three
    // verdicts); its items are marked, and decisions refuse to release them (decideRequest).
    return v === "policy" ? "ask" : v;
  };
  const policyViolation = (msg, session) => {
    const p = currentPolicy();
    return !p.legacy && decide(p.doc, keyOf(msg), session) === "policy";
  };
  /**
   * Whether stored message `msg` is plaintext from a contact whose encryption policy `doc` requires
   * encryption (design 3.3): from the current policy and the message's own provenance (decrypted
   * on this device or not), never from a flag cached when it was held.
   */
  const requiredPlaintext = (doc, msg) => {
    const k = keyOf(msg);
    return Boolean(k.member && !k.e2ee && encryptionMode(doc, k.realm, k.member) === "required");
  };

  // ---- requests ----------------------------------------------------------------------------
  const requests = () =>
    list(reqDir)
      .filter((f) => REQ_RE.test(f.slice(0, -5)))
      .map((f) => readJson(path.join(reqDir, f)))
      .filter(Boolean);
  const writeRequest = (r) => {
    ensurePrivateDir(reqDir);
    save(path.join(reqDir, `${r.id}.json`), r);
  };
  const removeRequest = (r, outcome) => {
    discard(path.join(reqDir, `${r.id}.json`));
    const done = (readJson(donePath) ?? []).concat({ id: r.id, key: r.key, label: r.sender.label, outcome, at: new Date(now()).toISOString() }).slice(-DONE_MAX);
    save(donePath, done);
  };
  const usage = (reqs) => {
    let messages = 0;
    let bytes = 0;
    for (const r of reqs) for (const i of r.items) (messages++, (bytes += i.bytes ?? 0));
    return { messages, bytes };
  };
  const keyUsage = (r) => usage(r ? [r] : []);

  /** Admit an item into its key's request if the budgets allow; returns false when it does not fit. */
  function admit(reqs, key, sender, item) {
    let r = reqs.find((x) => x.key === key);
    const home = usage(reqs);
    const mine = keyUsage(r);
    if (home.messages + 1 > HOME_MAX_MESSAGES || home.bytes + item.bytes > HOME_MAX_BYTES) return false;
    if (mine.messages + 1 > KEY_MAX_MESSAGES || mine.bytes + item.bytes > KEY_MAX_BYTES) return false;
    if (!r) {
      if (reqs.length >= MAX_REQUESTS) return false;
      r = { v: 1, id: `q_${b32(16)}`, rev: 0, key, sender, items: [], created: new Date(now()).toISOString(), notified: false, dropped: 0 };
      reqs.push(r);
    }
    r.items.push(item);
    r.rev++;
    writeRequest(r);
    return r;
  }

  function countDrop(key, reqs) {
    const r = reqs.find((x) => x.key === key);
    if (r) {
      r.dropped = (r.dropped ?? 0) + 1;
      writeRequest(r);
      return;
    }
    const s = state();
    s.dropped = s.dropped ?? {};
    s.dropped.unadmitted = (s.dropped.unadmitted ?? 0) + 1;
    writeState(s);
  }

  /** Best-effort notification for a new request: rate limited, recorded before it runs. */
  function maybeNotify(r, session) {
    if (!notify || r.notified) return;
    const s = state();
    const t = now();
    const recent = (s.notified ?? []).filter((x) => t - x < 3600_000);
    if (recent.length >= NOTIFY_PER_HOUR || (recent.length && t - Math.max(...recent) < NOTIFY_MIN_GAP_MS)) return;
    r.notified = true;
    writeRequest(r);
    s.notified = [...recent, t];
    writeState(s);
    try {
      notifier("hoptell · Message held", `${r.sender.label} wants to reach ${session.name}. Review it with hoptell contacts or hoptell ui.`);
    } catch {}
  }

  /**
   * Reconcile quarantines with requests: payloads no request lists (a crash between the two
   * writes, or backlog withheld by the budgets) join their key's request when the budgets allow;
   * the rest stays withheld. Expired items are deleted; empty requests are retired.
   */
  async function reconcile(reqs) {
    const listed = new Set(reqs.flatMap((r) => r.items.map((i) => `${i.store}|${i.file}`)));
    const dirs = new Set(reqs.flatMap((r) => r.items.map((i) => i.store)));
    for (const d of storeDirs()) dirs.add(d);
    let withheld = 0;
    for (const dir of dirs) {
      const st = await storeFor(dir);
      const q = await st.quarantined();
      const expired = q.filter((x) => now() - x.arrived > EXPIRY_MS).map((x) => x.file);
      if (expired.length) await st.deleteQuarantined(expired);
      for (const x of q) {
        if (expired.includes(x.file) || listed.has(`${dir}|${x.file}`) || !x.msg) continue;
        const k = keyOf(x.msg);
        const item = { store: dir, file: x.file, session: sessionOf(dir), arrived: x.arrived, expires: x.arrived + EXPIRY_MS, bytes: x.bytes };
        if (!admit(reqs, keyId(k), senderOf(k, x.msg), item)) withheld++;
      }
    }
    for (const r of [...reqs]) {
      const before = r.items.length;
      r.items = r.items.filter((i) => now() - i.arrived <= EXPIRY_MS && fs.existsSync(path.join(i.store, "quarantine", i.file)));
      if (!r.items.length) {
        removeRequest(r, before ? "expired" : "empty");
        reqs.splice(reqs.indexOf(r), 1);
      } else if (r.items.length !== before) {
        r.rev++;
        writeRequest(r);
      }
    }
    return withheld;
  }

  /** Session store folders of this home that have a quarantine. */
  function storeDirs() {
    const out = [];
    const v2 = path.join(home, "v2");
    for (const realm of list(v2)) for (const m of list(path.join(v2, realm))) for (const k of list(path.join(v2, realm, m))) {
      if (fs.existsSync(path.join(v2, realm, m, k, "quarantine"))) out.push(path.join(v2, realm, m, k));
    }
    // Protocol 1: legacy/<name>, and legacy/<scope>/<name> for a link of a session over several
    // relays (the engine's holdDir).
    const legacy = path.join(home, "legacy");
    for (const n of subdirs(legacy)) {
      if (fs.existsSync(path.join(legacy, n, "quarantine"))) out.push(path.join(legacy, n));
      for (const k of subdirs(path.join(legacy, n))) if (fs.existsSync(path.join(legacy, n, k, "quarantine"))) out.push(path.join(legacy, n, k));
    }
    return out;
  }
  const sessionOf = (dir) => {
    const rel = path.relative(home, dir).split(path.sep);
    if (rel[0] === "legacy") return { realm: null, name: rel[rel.length === 3 ? 2 : 1] };
    return { realm: rel[1], name: rel[3] };
  };
  const senderOf = (k, msg) => ({ label: k.label, realm: k.realm ?? null, member: k.member ?? null, name: k.name ?? msg?.from ?? null, auth: k.unverified ? "unverified" : k.member ? "member" : "shared", relay: k.relay ?? null });

  /** Run fn under the contacts lock after recovery (journals) and reconciliation. */
  const op = (fn) =>
    withLock(lockFile, async () => {
      await recoverJournals();
      const reqs = requests();
      const withheld = await reconcile(reqs);
      return fn(reqs, withheld);
    });

  // ---- receive and presentation -------------------------------------------------------------

  /**
   * The requests holding messages in the session store folder `store` (exactly that folder, so a
   * reused name or session key in another member's folder never shows), for the agent's notices
   * (design contacts-self): [{id, auth, member, policy, messages, files}], oldest first. `member` is
   * the member name the relay authenticated (null for shared-token and unverified senders, whose
   * names are their own choice and never reach the agent). Read only, without the lock (request
   * files are replaced whole); never any message text.
   */
  function heldFor({ store } = {}) {
    if (typeof store !== "string" || !store) return [];
    const real = (d) => {
      try {
        return fs.realpathSync(d);
      } catch {
        return path.resolve(d);
      }
    };
    const want = real(store);
    let all = [];
    try {
      all = requests();
    } catch {
      return [];
    }
    const out = [];
    for (const r of all) {
      if (!REQ_RE.test(r?.id ?? "")) continue;
      const items = (r.items ?? []).filter((i) => typeof i?.store === "string" && typeof i.file === "string" && now() - i.arrived <= EXPIRY_MS && real(i.store) === want);
      if (!items.length) continue;
      const auth = ["member", "shared"].includes(r.sender?.auth) ? r.sender.auth : "unverified";
      const name = r.sender?.label?.match(/^member ([A-Za-z0-9][A-Za-z0-9_-]{0,63}|m_[a-z2-7]{26})( \(hosted\))?$/);
      // A require-encryption violation from the current policy and each message's own provenance
      // (as requiredPlaintext), never only a flag cached when it was held; read only when that
      // member's encryption is required now. Nothing from the message leaves this function.
      const doc = auth === "member" ? currentPolicy().doc : null;
      const required = Boolean(doc && r.sender?.realm && r.sender?.member && encryptionMode(doc, r.sender.realm, r.sender.member) === "required");
      const violates = (i) => {
        try {
          return requiredPlaintext(doc, JSON.parse(fs.readFileSync(path.join(i.store, "quarantine", i.file), "utf8")));
        } catch {
          return i.policy === "encryption-required";
        }
      };
      out.push({ id: r.id, auth, member: auth === "member" && name ? name[1] : null, hosted: Boolean(name?.[2]), policy: required && items.some(violates), messages: items.length, files: items.map((i) => i.file), created: String(r.created ?? "") });
    }
    return out.sort((a, b) => a.created.localeCompare(b.created));
  }

  /**
   * Which held messages of store `store` were already reported to the agent by a wait or a listener
   * (design contacts-self): a small record per store under contacts/reported/, so a wait that
   * starts after a hold still reports it once, and a restarted wait does not report it again.
   * Returns the held entries (lib/notices.js heldEntries form: "held:<request>/<file>") not yet
   * reported. Best effort: an unreadable record counts as empty (a hold is then reported again).
   */
  const reportedFile = (store) => {
    let real = store;
    try {
      real = fs.realpathSync(store);
    } catch {}
    return path.join(cdir, "reported", `${crypto.createHash("sha256").update(path.resolve(real)).digest("hex").slice(0, 32)}.json`);
  };
  const entriesOf = (held) => held.flatMap((r) => r.files.map((f) => `held:${r.id}/${f}`));
  function heldUnreported({ store } = {}) {
    const all = entriesOf(heldFor({ store }));
    if (!all.length) return [];
    let seen = [];
    try {
      seen = readJson(reportedFile(store))?.files ?? [];
    } catch {}
    const done = new Set(Array.isArray(seen) ? seen : []);
    return all.filter((e) => !done.has(e.slice(e.indexOf("/") + 1)));
  }
  /** Record that held entries `entries` of store `store` were reported (kept only while still held). */
  function noteHeldReported({ store } = {}, entries = []) {
    if (typeof store !== "string" || !store) return;
    const held = new Set(entriesOf(heldFor({ store })).map((e) => e.slice(e.indexOf("/") + 1)));
    let seen = [];
    try {
      seen = readJson(reportedFile(store))?.files ?? [];
    } catch {}
    const files = [...new Set([...(Array.isArray(seen) ? seen : []), ...entries.map((e) => e.slice(e.indexOf("/") + 1))])].filter((f) => held.has(f));
    try {
      ensurePrivateDir(path.join(cdir, "reported"));
      save(reportedFile(store), { v: 1, files });
    } catch (e) {
      log(`contacts: could not record which held messages were reported (${e.message}); they may be reported again`);
    }
  }

  /** A screen for a session's store takes and notice lists: the current decision per message. */
  function screenFor(session, own = null, opts = {}) {
    // "policy" is kept apart from "ask" here: the store never lets an owner's earlier release
    // (approval) show plaintext from a contact whose encryption is required now.
    return (msg) => decision(msg, session, own, opts);
  }

  /**
   * A delivery for `session` (store folder `dir`) that the policy does not allow. "block": dropped
   * (counted). "ask": stored in quarantine and added to its request, or dropped over the budgets.
   * Returns {disposition: "quarantined" | "blocked" | "dropped" | "duplicate", file?}. Storage
   * errors are thrown (the delivery is then not confirmed).
   */
  function hold(dir, session, msg, verdict) {
    return op(async (reqs) => {
      const k = keyOf(msg);
      if (verdict === "block") {
        const s = state();
        s.dropped = s.dropped ?? {};
        s.dropped.blocked = (s.dropped.blocked ?? 0) + 1;
        writeState(s);
        return { disposition: "blocked" };
      }
      const st = await storeFor(dir);
      const bytes = Buffer.byteLength(JSON.stringify(msg));
      const r0 = reqs.find((x) => x.key === keyId(k));
      const homeUse = usage(reqs);
      const keyUse = keyUsage(r0);
      const fits = homeUse.messages + 1 <= HOME_MAX_MESSAGES && homeUse.bytes + bytes <= HOME_MAX_BYTES && keyUse.messages + 1 <= KEY_MAX_MESSAGES && keyUse.bytes + bytes <= KEY_MAX_BYTES && (r0 || reqs.length < MAX_REQUESTS);
      // A repeat of a stored delivery is only confirmed (after completing its barriers).
      const dup = await st.findDelivery(msg);
      if (dup) return { disposition: "duplicate", file: dup.file };
      if (!fits) {
        // A new arrival over the budgets is dropped (confirmed), before anything is written: an
        // interrupted drop can never turn into retained backlog.
        countDrop(keyId(k), reqs);
        return { disposition: "dropped" };
      }
      const stored = await st.quarantineAppend(msg);
      if (stored.state === "duplicate") return { disposition: "duplicate", file: stored.file };
      const item = { store: dir, file: stored.file, session, arrived: Number(stored.file.slice(0, 13)), expires: Number(stored.file.slice(0, 13)) + EXPIRY_MS, bytes, ...(policyViolation(msg, session) ? { policy: "encryption-required" } : {}) };
      const r = admit(reqs, keyId(k), senderOf(k, msg), item);
      if (r) maybeNotify(r, session);
      return { disposition: "quarantined", file: stored.file, request: r ? r.id : null };
    });
  }

  /**
   * Adopt an already accepted message (protocol-1 backlog leaving its old inbox) into quarantine:
   * never dropped by the arrival budgets; beyond them it is kept withheld until there is room.
   * Returns {disposition: "quarantined" | "withheld" | "blocked" | "duplicate"}.
   */
  function adoptBacklog(dir, session, msg, verdict, { source = null } = {}) {
    return op(async (reqs) => {
      if (verdict === "block") return { disposition: "blocked" };
      const st = await storeFor(dir);
      // The copy is stored under a stable adoption id derived from its source (from the first
      // attempt on), so a retry finds it wherever it is now (held, released, read) instead of
      // copying again; the relay delivery id is not used, as the source was accepted on its own.
      const adoptId = adoptionId(source ?? JSON.stringify(msg));
      let stored = !source && DELIVERY_ID_RE.test(msg?.id ?? "") ? await st.quarantineAppend(msg) : { state: "duplicate", where: null };
      if (stored.state === "duplicate" && stored.where !== "quarantine") {
        stored = await st.quarantineAppend({ ...msg, id: adoptId });
        if (stored.state === "duplicate" && stored.where !== "quarantine") return { disposition: "duplicate" }; // adopted before, already released
      }
      // Already held (an interrupted earlier attempt): attach it if its request is missing.
      const k = keyOf(msg);
      const attached = reqs.some((r) => r.items.some((i) => i.store === dir && i.file === stored.file));
      if (attached) return { disposition: "duplicate" };
      const item = { store: dir, file: stored.file, session, arrived: Number(stored.file.slice(0, 13)), expires: Number(stored.file.slice(0, 13)) + EXPIRY_MS, bytes: Buffer.byteLength(JSON.stringify(msg)) };
      const r = admit(reqs, keyId(k), senderOf(k, msg), item);
      if (r) maybeNotify(r, session);
      return { disposition: r ? "quarantined" : "withheld" };
    });
  }

  /**
   * After a take moved backlog into quarantine: reconciliation adds it to requests when the
   * budgets allow, and keeps the rest withheld (never dropped).
   */
  function adopt() {
    return op(async () => {});
  }

  // ---- decisions ----------------------------------------------------------------------------

  const policyRevision = () => currentPolicy().doc?.revision ?? 0;

  function writePolicy(mutate) {
    const r = readContacts(policyPath);
    // A damaged policy is never replaced by a decision: the owner fixes or removes it first.
    if (!r.doc && fs.existsSync(policyPath)) throw new DecisionError(`${r.problem}; fix it (or move it away and run hoptell contacts init) before deciding`);
    const doc = r.doc ?? freshContacts();
    mutate(doc);
    doc.revision = (doc.revision ?? 0) + 1;
    const problems = validateContacts(doc);
    if (problems.length) throw new DecisionError(problems[0]);
    save(policyPath, doc, 2);
    return doc.revision;
  }

  /** Resume every journal at its phase (design 1.5, section 6). */
  async function recoverJournals() {
    for (const f of list(journalDir).filter((x) => x.endsWith(".json"))) {
      const j = readJson(path.join(journalDir, f));
      if (!j) continue;
      try {
        await runJournal(j);
      } catch (e) {
        // A decision that can no longer apply (for example a policy that became invalid) is
        // retired, so it never blocks holding or deciding other messages; storage errors propagate.
        if (!(e instanceof DecisionError)) throw e;
        log(`contacts: a pending decision was dropped: ${e.message}`);
        discard(path.join(journalDir, f));
      }
    }
  }

  const writeJournal = (j) => {
    ensurePrivateDir(journalDir);
    save(path.join(journalDir, `${j.id}.json`), j);
  };

  async function runJournal(j) {
    if (j.phase === "policy") {
      const doc = readContacts(policyPath).doc;
      const applied = j.policyChange && (j.policyChange.add ? [...(doc?.grants ?? []), ...(doc?.blocks ?? [])].some((e) => e.id === j.policyChange.add.id) : !(doc?.[j.policyChange.list] ?? []).some((e) => e.id === j.policyChange.remove));
      if (j.policyChange && !applied) {
        if ((doc?.revision ?? 0) !== j.policyRevision) {
          discard(path.join(journalDir, `${j.id}.json`)); // the policy changed: abort
          return;
        }
        writePolicy((d) => {
          if (j.policyChange.add) d[j.policyChange.list] = [...(d[j.policyChange.list] ?? []), j.policyChange.add];
          else d[j.policyChange.list] = (d[j.policyChange.list] ?? []).filter((e) => e.id !== j.policyChange.remove);
        });
      } else if (j.policyChange) {
        // Already applied (a visible rename): complete its barriers before moving on.
        settleFile(policyPath);
      }
      j.phase = "items";
      writeJournal(j);
    }
    if (j.phase === "items") {
      let waiting = false;
      for (const step of j.steps) {
        if (step.done) continue;
        const st = await storeFor(step.store);
        if (step.action === "delete") {
          await st.deleteQuarantined([step.file]);
          step.done = "deleted";
        } else if ((await storedMessages([step])).some((msg) => requiredPlaintext(readContacts(policyPath).doc, msg))) {
          // The contact's encryption became required since the decision: never released (kept).
          step.done = "policy";
        } else {
          const r = await st.releaseQuarantined([step.file], { approve: step.action === "release-approved" });
          if (r.waiting.length) {
            waiting = true;
            break;
          }
          step.done = r.released.length ? "released" : "missing";
        }
        writeJournal(j);
      }
      if (waiting) {
        j.waiting = true;
        writeJournal(j);
        return;
      }
      j.phase = "request";
      j.waiting = false;
      writeJournal(j);
    }
    if (j.phase === "request") {
      const r = j.request ? readJson(path.join(reqDir, `${j.request}.json`)) : null;
      if (j.request && !r) {
        // Already retired (a visible unlink): complete its barrier and its done record.
        syncDir(reqDir);
        const done = readJson(donePath) ?? [];
        if (!done.some((d) => d.id === j.request)) save(donePath, done.concat({ id: j.request, key: j.key, label: j.label, outcome: j.op, at: new Date(now()).toISOString() }).slice(-DONE_MAX));
        else settleFile(donePath); // visible may not be durable yet (an earlier save failed its barrier)
      }
      if (r) {
        const decided = new Set(j.steps.filter((s) => s.done !== "policy").map((s) => `${s.store}|${s.file}`));
        r.items = r.items.filter((i) => !decided.has(`${i.store}|${i.file}`));
        r.history = [...(r.history ?? []), ...j.steps.filter((s) => s.done === "missing").map((s) => ({ file: s.file, missing: true }))].slice(-50);
        if (!r.items.length) removeRequest(r, j.op);
        else {
          r.rev++;
          writeRequest(r);
        }
      }
      discard(path.join(journalDir, `${j.id}.json`));
    }
  }

  /** A request as the owner sees it (with its held text only when asked). */
  async function present(r, { text = false } = {}) {
    const items = [];
    for (const i of r.items) {
      let body = null;
      if (text) {
        try {
          body = JSON.parse(fs.readFileSync(path.join(i.store, "quarantine", i.file), "utf8")).text ?? null;
        } catch {}
      }
      items.push({ session: scopeOf(i.session), arrived: new Date(i.arrived).toISOString(), bytes: i.bytes, ...(text ? { text: body } : {}) });
    }
    return { id: r.id, rev: r.rev, policyRevision: policyRevision(), sender: r.sender, items, dropped: r.dropped ?? 0, violation: await violates(r) };
  }

  /**
   * Whether a request holds plaintext from a contact whose encryption the current policy requires
   * (design 3.3): judged on each stored message, as decideRequest judges it.
   */
  async function violates(r) {
    const doc = currentPolicy().doc;
    if (r.sender.auth !== "member" || !doc || encryptionMode(doc, r.sender.realm, r.sender.member) !== "required") return false;
    return (await storedMessages(r.items)).some((msg) => requiredPlaintext(doc, msg));
  }

  /** The stored messages of request items (unreadable or missing ones are left out). */
  async function storedMessages(items) {
    const out = [];
    const byStore = new Map();
    for (const i of items) byStore.set(i.store, [...(byStore.get(i.store) ?? []), i.file]);
    for (const [dir, files] of byStore) {
      const want = new Set(files);
      for (const x of await (await storeFor(dir)).quarantined()) if (want.has(x.file) && x.msg) out.push(x.msg);
    }
    return out;
  }

  /**
   * `check(shown)`, when given, runs in the same lock acquisition after the rev comparison, on the
   * request as show() presents it, and throws to refuse (the decision service compares the view
   * it showed there); nothing is written before it passes.
   */
  function decideRequest(id, { rev, policyRev, session = null, opName, check = null }) {
    return op(async (reqs) => {
      const r = reqs.find((x) => x.id === id);
      if (!r) throw new DecisionError(`no pending request ${id} (it may have been decided or expired)`);
      if (r.rev !== rev || policyRevision() !== policyRev) {
        throw staleError(`request ${id} changed since it was shown (now --rev ${r.rev} --policy-rev ${policyRevision()}); show it again before deciding`);
      }
      check?.(await present(r));
      fault?.("contacts-decision-checked", id);
      // Prerequisites first: nothing is journaled for a decision that cannot apply. A damaged
      // policy refuses every decision (fail closed), allow-once included.
      const pol = readContacts(policyPath);
      if (!pol.doc && fs.existsSync(policyPath)) throw new DecisionError(`${pol.problem}; fix it (or move it away and run hoptell contacts init) before deciding`);
      const items = r.items.filter((i) => !session || scopeOf(i.session) === session);
      if (!items.length) throw new DecisionError(`request ${id} has nothing for ${session}`);
      const k = r.sender;
      // Plaintext from a contact whose encryption is required (design 3.3): neither allow-once nor
      // a grant releases it; only a change of the contact's encryption policy does.
      // Judged on each stored message under the current policy (an item held before its contact
      // became required, or adopted later, carries no flag).
      if ((opName === "allow" || opName === "allow-once") && (await storedMessages(items)).some((msg) => requiredPlaintext(pol.doc, msg))) {
        throw new DecisionError(`request ${id} holds plaintext from a contact whose encryption is required (a policy violation); it is released only after you set that contact's encryption to preferred or off (hoptell contacts encryption ${k.member} preferred)`);
      }
      let policyChange = null;
      if (opName === "allow" || opName === "block") {
        if (opName === "allow" && k.auth === "unverified") throw new DecisionError("unverified senders cannot get a grant (their names are not authenticated); use allow-once");
        const scope = session && !session.startsWith("legacy/") ? { realm: session.split("/")[0], name: session.split("/")[1] } : undefined;
        const base = k.auth === "unverified" ? { unverified: true, relay: k.relay, name: k.name } : k.auth === "member" ? { realm: k.realm, member: k.member } : { realm: k.realm, shared: true, name: k.name };
        const entry = { id: newEntryId(opName === "allow" ? "g" : "b"), ...base, ...(scope ? { session: scope } : {}), added: new Date(now()).toISOString() };
        policyChange = { list: opName === "allow" ? "grants" : "blocks", add: entry };
      }
      const action = opName === "block" ? "delete" : opName === "allow-once" ? "release-approved" : "release";
      // A block removes everything pending from the sender; allow and allow-once their selection.
      const chosen = opName === "block" ? r.items : items;
      const j = { v: 1, id: `j_${b32(16)}`, op: opName, request: id, key: r.key, label: r.sender.label, rev, policyRevision: policyRev, policyChange, phase: policyChange ? "policy" : "items", steps: chosen.map((i) => ({ store: i.store, file: i.file, action, done: null })) };
      writeJournal(j);
      await runJournal(j);
      const left = readJson(path.join(journalDir, `${j.id}.json`));
      return { op: opName, waiting: Boolean(left?.waiting), steps: j.steps.length };
    });
  }

  function changePolicy(entryId, { policyRev }) {
    return op(async () => {
      if (policyRevision() !== policyRev) throw staleError(`the policy changed since it was shown (now --policy-rev ${policyRevision()})`);
      const pol = readContacts(policyPath);
      if (!pol.doc) throw new DecisionError(`${pol.problem}; fix it before changing it`);
      const doc = pol.doc;
      const list = entryId.startsWith("g_") ? "grants" : "blocks";
      if (!(doc?.[list] ?? []).some((e) => e.id === entryId)) throw new DecisionError(`no ${list === "grants" ? "grant" : "block"} ${entryId}`);
      const j = { v: 1, id: `j_${b32(16)}`, op: list === "grants" ? "revoke" : "unblock", request: null, rev: null, policyRevision: policyRev, policyChange: { list, remove: entryId }, phase: "policy", steps: [] };
      writeJournal(j);
      await runJournal(j);
      return { op: j.op };
    });
  }

  return {
    home,
    policyPath,
    currentPolicy,
    get mode() {
      return isManaged() ? "managed" : "legacy-allow";
    },
    isManaged,
    verdict,
    screenFor,
    heldFor,
    heldUnreported,
    noteHeldReported,
    hold,
    adoptBacklog,
    adopt,
    /** Pending requests and the summary for the agent and doctor. */
    status() {
      return op(async (reqs, withheld) => ({
        mode,
        policy: currentPolicy(),
        policyRevision: policyRevision(),
        requests: await Promise.all(reqs.map(async (r) => ({ id: r.id, rev: r.rev, sender: r.sender, items: r.items.length, sessions: [...new Set(r.items.map((i) => scopeOf(i.session)))], created: r.created, expires: Math.min(...r.items.map((i) => i.expires)), dropped: r.dropped ?? 0, violation: await violates(r) }))),
        messages: reqs.reduce((n, r) => n + r.items.length, 0),
        withheld,
        dropped: state().dropped ?? {},
        journalsWaiting: list(journalDir).length,
      }));
    },
    /** One request with its items (and their text when asked). */
    show(id, { text = false } = {}) {
      return op(async (reqs) => {
        const r = reqs.find((x) => x.id === id);
        if (!r) throw new DecisionError(`no pending request ${id}`);
        return await present(r, { text });
      });
    },
    allowOnce: (id, o) => decideRequest(id, { ...o, opName: "allow-once" }),
    allow: (id, o) => decideRequest(id, { ...o, opName: "allow" }),
    block: (id, o) => decideRequest(id, { ...o, opName: "block" }),
    revoke: (gid, o) => changePolicy(gid, o),
    unblock: (bid, o) => changePolicy(bid, o),
    /**
     * Change the device pins (design 3.2, experimental) under the contacts lock: `mutate(doc)`
     * edits doc.pins / doc.requireVerified of the current policy, which is validated and written
     * with a new revision. Pins live in the policy, so an unmanaged home refuses: writing the file
     * would make it managed behind the owner's back.
     */
    updatePins(mutate) {
      return withLock(lockFile, () => {
        if (!isManaged()) throw new DecisionError("device pins are kept in the contacts policy, and this home's contacts are not managed yet: run hoptell contacts init first");
        let result;
        const revision = writePolicy((doc) => {
          result = mutate(doc);
        });
        return { revision, result };
      });
    },
    /**
     * Change policy settings (default, unverified) by compare-and-set on the file's digest: after
     * recovery, under the contacts lock, the current bytes must still have `digest` (else a
     * DecisionError with code "stale", nothing written); `mutate(doc)` then edits the policy, which
     * is validated and written with a new revision in the same lock acquisition. An unmanaged home
     * refuses, as for pins.
     */
    setPolicy(digest, mutate) {
      return op(async () => {
        if (!isManaged()) throw new DecisionError("the contacts of this home are not managed yet: run hoptell contacts init first");
        if (fileDigest(policyPath) !== digest) throw staleError(`${policyPath} changed since it was shown`);
        fault?.("contacts-policy-checked", policyPath);
        return { revision: writePolicy(mutate) };
      });
    },
    /**
     * The require-encryption policy (design 3.3, experimental) of contact `member` of `realm`, or
     * the realm's default when member is null: mode "required" | "preferred" | "off", or null to
     * remove the entry. Written like the pins, under the contacts lock.
     */
    setEncryption({ realm, member = null, mode }) {
      return withLock(lockFile, () => {
        if (!isManaged()) throw new DecisionError("the encryption policy is kept in the contacts policy, and this home's contacts are not managed yet: run hoptell contacts init first");
        const revision = writePolicy((doc) => {
          const list = (doc.encryption ?? []).filter((e) => !(e.realm === realm && (e.member ?? null) === member));
          if (mode !== null) list.push({ realm, ...(member ? { member } : {}), mode });
          if (list.length) doc.encryption = list;
          else delete doc.encryption;
        });
        return { revision };
      });
    },
    /** Migrate an existing install to managed mode (grants nobody). */
    init() {
      return withLock(lockFile, () => {
        if (fs.existsSync(policyPath)) return { already: true };
        save(policyPath, freshContacts(), 2);
        const s = state();
        writeState({ ...s, mode: "managed", policy: policyPath });
        return { already: false };
      });
    },
    /**
     * A cheap count of pending requests for the agent-facing line (no lock: request files are
     * written atomically, so a concurrent change shows the old or the new count).
     */
    summary() {
      let messages = 0;
      let senders = 0;
      for (const f of list(reqDir)) {
        if (!REQ_RE.test(f.slice(0, -5))) continue;
        try {
          const r = JSON.parse(fs.readFileSync(path.join(reqDir, f), "utf8"));
          messages += r.items.length;
          senders++;
        } catch {}
      }
      return { messages, senders };
    },
    /** Whether a decision waits for inbox room. */
    hasWaiting: () => list(journalDir).some((f) => f.endsWith(".json")),
    /** Retry journals waiting for inbox room (called by the engine's room check). */
    retry() {
      return op(async () => {});
    },
  };
}

/** The platform's desktop notification, if any (best effort; no message text). */
export function desktopNotify(title, text) {
  const args =
    process.platform === "darwin"
      ? ["osascript", ["-e", `display notification ${JSON.stringify(text)} with title ${JSON.stringify(title)}`]]
      : process.platform === "linux"
        ? ["notify-send", ["-i", ICON_PATH, title, text]]
        : null;
  if (!args) return;
  const child = spawn(args[0], args[1], { stdio: "ignore", detached: true });
  child.on("error", () => {});
  child.unref();
}

/** A read-only look at a home's contacts, for doctor (creates nothing). */
export function inspectContacts(home) {
  const cdir = path.join(home, "contacts");
  let marker = null;
  let markerProblem = null;
  try {
    marker = readJson(path.join(cdir, "state.json"));
  } catch {
    markerProblem = "the contacts marker is damaged";
  }
  const hasPolicy = fs.existsSync(contactsFile(home));
  const policy = hasPolicy ? readContacts(contactsFile(home)) : null;
  const mode = hasPolicy || markerProblem ? "managed" : (marker?.mode ?? "unset");
  const reqs = list(path.join(cdir, "requests"))
    .filter((f) => REQ_RE.test(f.slice(0, -5)))
    .map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(cdir, "requests", f), "utf8"));
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  return {
    mode,
    markerProblem,
    policy: policy?.doc ?? null,
    policyProblem: hasPolicy ? policy.problem : mode === "managed" ? `${contactsFile(home)} is missing` : null,
    requests: reqs.map((r) => ({ id: r.id, label: r.sender.label, items: r.items.length, created: r.created })),
    journals: list(path.join(cdir, "journal")).filter((f) => f.endsWith(".json")).length,
    dropped: marker?.dropped ?? {},
  };
}
