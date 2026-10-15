// Relay-side access (design 4.1/4.2): who may reach whom. Three gates must all pass for a message:
// the relay admin's policy (gate 1, policy.json), the recipient's published inbound grants (gate 2,
// per member, set by the member) and the machine owner's local release (gate 3, contacts on the
// recipient's machine; not here). Each gate can only refuse. Group claims come from one durable
// claim view per authenticated identity, ordered by source version, failing closed on conflict.
//
// Inactive until configured: without a policy file and without any published grants, every
// decision is "allow" and nothing changes for existing relays (claim views are still recorded, so
// a policy added later decides with them).
//
// Durability follows the broker's discipline (writeDurable's phase): memory changes only after a
// write succeeded; a write that failed before the replace leaves both unchanged; after the replace
// memory follows the file as read back, and if that read fails every decision holds until it
// succeeds. Restrictive changes (closing a claim view) apply at once and are retried until written.
//
// Pending recipients (design 4.4, "Prerequisites"): after a restore that lost the access state,
// `access/restore.json` lists members whose grants may be older than what they last published.
// Such a member is undecided as a recipient: dispatch holds and a send answers "retry", checked
// before anything that could allow the message (an inactive realm, gate 1, a reply allowance,
// which is then neither consulted nor used). A publish of the member's grants clears its mark:
// the grants are durable first, then restore.json is rewritten without it. The file records each
// member's grants revision at the restore; a load that finds another revision clears the mark (it
// published since, perhaps just before a crash). It only refuses or delays, never allows.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { writeDurable } from "./credentials.js";

const DAY = 86_400_000;
const REQUESTS_PER_RECIPIENT = 10;
const REQUESTS_PER_SENDER_DAY = 20;
const REQUEST_TTL_MS = 7 * DAY;
const REPLY_ALLOWANCE_MS = 7 * DAY;
const GRANT_ENTRIES_MAX = 500;
export const GROUPS_MAX = 100;
export const REASONS = ["collaborate", "review", "handoff", "other"];
export const SELECTOR_RE = /^(\*|group:[A-Za-z0-9][A-Za-z0-9_.-]{0,63}|member:m_[a-z2-7]{26}|member:name:[A-Za-z0-9_-]{1,64})$/;

/** Read and validate the admin policy file (gate 1). Throws with a fixed message. */
export function loadPolicy(file) {
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(e instanceof SyntaxError ? `${file}: invalid JSON` : `${file}: ${e.code ?? "cannot read"}`);
  }
  if (doc?.v !== 1) throw new Error(`${file}: v must be 1`);
  const groups = doc.groups ?? {};
  if (typeof groups !== "object" || Array.isArray(groups)) throw new Error(`${file}: groups must map names to {members, oidcGroups}`);
  for (const [name, g] of Object.entries(groups)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(name)) throw new Error(`${file}: invalid group name "${name}"`);
    if (!Array.isArray(g?.members ?? []) || !(g.members ?? []).every((m) => typeof m === "string")) throw new Error(`${file}: groups.${name}.members must be member ids`);
    if (!Array.isArray(g?.oidcGroups ?? []) || !(g.oidcGroups ?? []).every((o) => typeof o?.issuer === "string" && typeof o?.group === "string")) throw new Error(`${file}: groups.${name}.oidcGroups must be [{issuer, group}]`);
  }
  const rules = doc.rules ?? [];
  if (!Array.isArray(rules) || !rules.every((r) => SELECTOR_RE.test(r?.from ?? "") && SELECTOR_RE.test(r?.to ?? "") && ["allow", "deny"].includes(r?.action))) {
    throw new Error(`${file}: rules must be [{from, to, action: "allow"|"deny"}] with selectors *, group:<name> or member:<id>`);
  }
  if (!["allow", "deny"].includes(doc.defaultAction ?? "allow")) throw new Error(`${file}: defaultAction must be allow or deny`);
  // Larger transfers (design 6, experimental): who may upload them, first match wins, default allow.
  const transfers = doc.transfers ?? [];
  if (!Array.isArray(transfers) || !transfers.every((r) => r && SELECTOR_RE.test(r.from ?? "") && ["allow", "deny"].includes(r.action) && Object.keys(r).every((k) => ["from", "action"].includes(k)))) {
    throw new Error(`${file}: transfers must be [{from, action: "allow"|"deny"}] with selectors *, group:<name> or member:<id>`);
  }
  return { groups, rules, defaultAction: doc.defaultAction ?? "allow", requireGrants: doc.requireGrants === true, transfers };
}

/**
 * Which rule of policy `pol` decides gate 1 from member `fromId` to member `toId`, by the groups
 * the policy gives member ids (provider groups need a sign-in's claim view, so they are not seen
 * here): {action, rule} with the rule's index, or "default". For the relay admin's policy check.
 */
export function explainPolicy(pol, fromId, toId) {
  const who = (id) => ({ memberId: id, groups: Object.entries(pol.groups).filter(([, g]) => (g.members ?? []).includes(id)).map(([n]) => n) });
  const match = (sel, w) => sel === "*" || sel === `member:${w.memberId}` || (sel.startsWith("group:") && w.groups.includes(sel.slice(6)));
  const [a, b] = [who(fromId), who(toId)];
  const i = pol.rules.findIndex((r) => match(r.from, a) && match(r.to, b));
  return i >= 0 ? { action: pol.rules[i].action, rule: i, from: pol.rules[i].from, to: pol.rules[i].to } : { action: pol.defaultAction, rule: "default" };
}

/** Validate a member's grants document as published (gate 2). Throws with a fixed message. */
export function validateGrants(g) {
  if (!g || typeof g !== "object") throw new Error("grants must be an object");
  if (!["allow", "deny"].includes(g.default)) throw new Error('default must be "allow" or "deny"');
  if (!["all", "grantees"].includes(g.visible ?? "all")) throw new Error('visible must be "all" or "grantees"');
  if (!Array.isArray(g.entries) || g.entries.length > GRANT_ENTRIES_MAX) throw new Error(`entries must be a list of at most ${GRANT_ENTRIES_MAX}`);
  for (const e of g.entries) {
    if (!SELECTOR_RE.test(e?.selector ?? "") || !["allow", "deny"].includes(e?.action)) throw new Error("an entry needs a selector (*, group:<name>, member:<id>) and an action (allow, deny)");
    if (e.until !== undefined && !Number.isSafeInteger(e.until)) throw new Error("until must be a time in milliseconds");
    if (e.requests !== undefined && (e.requests !== "blocked" || e.action !== "deny" || !e.selector.startsWith("member:"))) throw new Error('requests: "blocked" belongs to a member deny (deny-forever)');
  }
  return { default: g.default, visible: g.visible ?? "all", entries: g.entries.map((e) => ({ selector: e.selector, action: e.action, ...(e.until !== undefined ? { until: e.until } : {}), ...(e.requests ? { requests: e.requests } : {}) })) };
}

const specificity = (sel) => (sel.startsWith("member:") ? 3 : sel.startsWith("group:") ? 2 : 1);
const isObj = (x) => x && typeof x === "object" && !Array.isArray(x);
const time = (x) => x === null || Number.isSafeInteger(x);
const int = (x) => Number.isSafeInteger(x) && x >= 0;
const str = (x, max) => typeof x === "string" && x.length > 0 && x.length <= max;
const memberKey = (x) => str(x, 200); // m_<id>, name:<name>, or an unknown target's placeholder
const grantsOk = (g) => {
  try {
    validateGrants(g);
  } catch {
    return false;
  }
  return Number.isSafeInteger(g.revision) && g.revision > 0 && (g.updatedAt === undefined || int(g.updatedAt));
};
const viewOk = (v) =>
  isObj(v) && time(v.version) && Array.isArray(v.groups) && v.groups.every((g) => str(g, 1024)) && time(v.freshUntil) && (v.memberId === null || memberKey(v.memberId)) && typeof v.conflict === "boolean" && (v.invalidated === null || str(v.invalidated, 100));
const requestOk = (r) => isObj(r) && /^cr_[A-Za-z0-9_-]{12}$/.test(r.id ?? "") && memberKey(r.from) && typeof r.name === "string" && r.name.length <= 64 && memberKey(r.to) && REASONS.includes(r.reason) && int(r.at) && int(r.expires);
const usedOk = (u) => u === null || (isObj(u) && (u.op === null || str(u.op, 64)) && /^[0-9a-f]{64}$/.test(u.digest ?? "") && str(u.messageId, 64) && str(u.deliveryId, 64) && int(u.at) && int(u.ts) && (u.expires === null || int(u.expires)));
const allowanceOk = (e) => isObj(e) && memberKey(e.from) && memberKey(e.to) && str(e.message, 64) && int(e.expires) && usedOk(e.used);

/** The files of the access state, each with its empty document and a full shape check on load. */
const FILES = {
  grants: { file: "grants.json", empty: () => ({ v: 1, members: {} }), ok: (d) => isObj(d.members) && Object.entries(d.members).every(([k, g]) => memberKey(k) && grantsOk(g)) },
  claims: { file: "claims.json", empty: () => ({ v: 1, views: {} }), ok: (d) => isObj(d.views) && Object.entries(d.views).every(([k, v]) => str(k, 2048) && viewOk(v)) },
  requests: { file: "requests.json", empty: () => ({ v: 1, pending: [], sent: {} }), ok: (d) => Array.isArray(d.pending) && d.pending.every(requestOk) && isObj(d.sent) && Object.entries(d.sent).every(([k, n]) => str(k, 256) && int(n)) },
  allowances: { file: "allowances.json", empty: () => ({ v: 1, entries: [] }), ok: (d) => Array.isArray(d.entries) && d.entries.every(allowanceOk) },
};
const KEYS = Object.keys(FILES);
const RESTORE_FILE = "restore.json";
const restoreOk = (d) => isObj(d.pending) && Object.entries(d.pending).every(([k, r]) => memberKey(k) && (r === null || (Number.isSafeInteger(r) && r > 0))) && int(d.at) && /^[0-9a-f]{16}$/.test(d.restore ?? "");

// The access manifest (design 4.4, restore): `access/manifest.json` lists every access file ever
// written in this state directory, durably before the file is first created. A listed file that
// is missing was lost, never "not written yet": the relay refuses to start on it, and a restore
// treats the access state as lost. A first start without a manifest records the files present.
export const MANIFEST_FILE = "manifest.json";
const MANIFEST_NAMES = new Set([...KEYS.map((k) => FILES[k].file), RESTORE_FILE]);
const manifestOk = (d) => d?.v === 1 && Array.isArray(d.files) && d.files.every((f) => MANIFEST_NAMES.has(f));

/** The files the manifest of access folder `dir` lists: a Set, null when there is none; throws when unreadable. */
export function readAccessManifest(dir) {
  let d;
  try {
    d = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST_FILE), "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw new Error(`${path.join(dir, MANIFEST_FILE)} cannot be read; fix it`);
  }
  if (!manifestOk(d)) throw new Error(`${path.join(dir, MANIFEST_FILE)} has an unknown version or shape; fix it`);
  return new Set(d.files);
}
/** Write the manifest of access folder `dir` durably (sorted names). */
export function writeAccessManifest(dir, files, { fault = null } = {}) {
  writeDurable(path.join(dir, MANIFEST_FILE), `${JSON.stringify({ v: 1, files: [...files].sort() })}\n`, { fault });
}

/** Whether `doc` is a valid access file `key` (grants, claims, requests, allowances). */
export const accessDocOk = (key, doc) => doc?.v === 1 && FILES[key].ok(doc);
/** Whether `doc` is a valid restore.json. */
export const restoreDocOk = (doc) => doc?.v === 1 && restoreOk(doc);
export const ACCESS_FILES = Object.fromEntries(KEYS.map((k) => [k, FILES[k].file]));

/**
 * Whether the access state in `stateDir` is readable as it is now (design 4.4, restore phase 0):
 * the folder exists, and each of the four files passes its checks, or is missing while the
 * manifest proves it was never written. A missing folder, a missing or unreadable manifest with a
 * file missing, or a missing file the manifest lists: lost, never an empty state.
 */
export function accessStateReadable(stateDir) {
  const dir = path.join(stateDir, "access");
  try {
    if (!fs.lstatSync(dir).isDirectory()) return false;
    // The start's own reader: whatever a start would refuse is lost here too.
    const listed = readAccessManifest(dir);
    if (!listed) return false; // nothing proves which files existed
    for (const k of KEYS) readAccessFile(dir, k, listed);
    readAccessFile(dir, "restore", listed);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read one access file of folder `dir` as a start does: `key` is one of the four or "restore".
 * Missing and not in `listed` (the files known to exist): its empty state (null for restore.json).
 * Missing but listed, unreadable, or of an unknown shape: throws.
 */
export function readAccessFile(dir, key, listed) {
  const restore = key === "restore";
  const file = path.join(dir, restore ? RESTORE_FILE : FILES[key].file);
  const fix = restore ? "fix it (members listed there stay held)" : "fix or remove it";
  let d;
  try {
    d = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT" && !listed.has(path.basename(file))) return restore ? null : FILES[key].empty();
    throw new Error(`${file} cannot be read; ${fix}`);
  }
  if (restore ? !restoreDocOk(d) : !accessDocOk(key, d)) throw new Error(`${file} has an unknown version or shape; ${fix}`);
  return d;
}

/**
 * The access state of a relay: policy (gate 1), grants (gate 2), claim views, contact requests and
 * reply allowances, durable in `<state dir>/access/`. `now()` is injectable for tests; `onChange`
 * is called when a change may let held or queued messages go (claims, grants, policy).
 */
export function createAccess({ stateDir, policy = null, now = () => Date.now(), fault = null, onChange = () => {} }) {
  let listener = onChange;
  const dir = path.join(stateDir, "access");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Files that exist (found at startup, listed in the manifest, or written since): a later read
  // that finds one missing is a failure, never an empty state.
  const known = new Set();
  let materialized = readAccessManifest(dir);
  if (!materialized) {
    // A first start with the manifest: what exists now is what was written.
    materialized = new Set([...MANIFEST_NAMES].filter((f) => fs.existsSync(path.join(dir, f))));
    writeAccessManifest(dir, materialized, { fault });
  }
  for (const k of KEYS) if (materialized.has(FILES[k].file)) known.add(k);
  const load = (key) => {
    const d = readAccessFile(dir, key, new Set([...known].map((k) => FILES[k].file)));
    if (fs.existsSync(path.join(dir, FILES[key].file))) known.add(key);
    return d;
  };
  const S = Object.fromEntries(KEYS.map((k) => [k, load(k)]));
  // restore.json: member id -> its grants revision at the restore (null: none). Loaded like the
  // four files: an unreadable one refuses the start (removing it is the owner's act, never ours).
  const restoreFile = path.join(dir, RESTORE_FILE);
  let restoreDoc = null;
  const loadRestore = () => readAccessFile(dir, "restore", materialized);
  restoreDoc = loadRestore();
  const pending = () => restoreDoc?.pending ?? {};
  /**
   * Clear the marks of members that published since the restore (another revision now; written
   * before the mark could be cleared), or of `also`. The marks go only once the rewrite is
   * durable; until then they stay.
   */
  function clearPending(also = null) {
    if (!restoreDoc) return;
    const keep = Object.fromEntries(Object.entries(restoreDoc.pending).filter(([m, rev]) => m !== also && (S.grants.members[m]?.revision ?? null) === rev));
    if (Object.keys(keep).length === Object.keys(restoreDoc.pending).length) return;
    const next = { ...restoreDoc, pending: keep };
    try {
      writeDurable(restoreFile, `${JSON.stringify(next)}\n`, { fault });
      restoreDoc = next;
    } catch (e) {
      if (e.phase !== "before-replace") {
        try {
          restoreDoc = loadRestore(); // memory follows the file as read back
        } catch {
          // kept as it was: still held
        }
      }
      return;
    }
    changed(); // held messages to those members may go now
  }
  let pol = policy;
  let fenced = false; // memory may differ from disk: decisions hold and changes wait until a re-read succeeds
  // Listeners run after the change that triggered them, once per burst (never inside a decision).
  let notifying = false;
  const changed = () => {
    if (notifying) return;
    notifying = true;
    setImmediate(() => {
      notifying = false;
      try {
        listener();
      } catch {
        // a listener's failure is its own
      }
    });
  };
  const unavailable = () => Object.assign(new Error("the access state is being recovered; try again"), { code: "unavailable", outcome: "unchanged" });
  /** Every change starts here: while fenced, the state is re-read first, and the change refused. */
  function ready() {
    if (!fenced) return;
    unfence();
    throw unavailable(); // built from a state that may have changed: the caller tries again
  }

  /**
   * Make `doc` the durable state of `key`. Throws {outcome: "unchanged"} when nothing was replaced,
   * {outcome: "unknown"} otherwise (memory then follows the file, or the state is fenced).
   */
  function commit(key, doc) {
    if (fenced) throw unavailable();
    // What is written must load again: the loader's checks run on every document first, so no
    // accepted input can leave a state that refuses the next start.
    if (doc?.v !== 1 || !FILES[key].ok(doc)) throw Object.assign(new Error("the access state would not be valid; refused"), { code: "invalid", outcome: "unchanged" });
    // Recorded before the file is first created: a file that exists is always listed. A failed
    // manifest write leaves the file unwritten (whatever the manifest holds, it lists no less).
    if (!materialized.has(FILES[key].file)) {
      const next = new Set([...materialized, FILES[key].file]);
      try {
        writeAccessManifest(dir, next, { fault });
      } catch (e) {
        if (e.phase !== "before-replace") materialized = next; // replaced: it lists the file
        throw Object.assign(e, { outcome: "unchanged" });
      }
      materialized = next;
    }
    try {
      writeDurable(path.join(dir, FILES[key].file), `${JSON.stringify(doc)}\n`, { fault });
    } catch (e) {
      if (e.phase === "before-replace") throw Object.assign(e, { outcome: "unchanged" });
      known.add(key); // replaced: from now on the file must be there
      try {
        S[key] = load(key);
        changed(); // memory took the file's state: held messages may go, or no longer
      } catch {
        fenced = true;
      }
      throw Object.assign(e, { outcome: "unknown" });
    }
    known.add(key);
    S[key] = doc;
  }
  /** Leave the fence once every file reads back; queued messages are looked at again then. */
  function unfence() {
    try {
      const next = Object.fromEntries(KEYS.map((k) => [k, load(k)]));
      const r = loadRestore();
      Object.assign(S, next);
      restoreDoc = r;
      fenced = false;
      changed();
    } catch {
      // still fenced
    }
  }

  /** Active when an admin policy exists or any member published grants. */
  const active = () => Boolean(pol) || Object.keys(S.grants.members).length > 0;

  // ---- claim views ---------------------------------------------------------------------------

  // Closings not yet written: identity -> {version, why}. They apply at once (fail closed) and are
  // retried on later calls; a strictly newer authentication replaces them.
  // The closed view keeps the newest version seen (the high-water mark), so no older
  // authentication can reopen it, also after a restart.
  const closing = new Map();
  const newest = (a, b) => (a === null ? b : b === null ? a : Math.max(a, b));
  function retryClosings() {
    if (!closing.size || fenced) return;
    const views = { ...S.claims.views };
    const done = [];
    for (const [identity, c] of closing) {
      const v = views[identity];
      done.push(identity);
      // A strictly newer authentication was written since: it replaced this closing.
      if (v && !v.invalidated && v.version !== null && c.version !== null && v.version > c.version) continue;
      views[identity] = { ...(v ?? { freshUntil: null, memberId: c.memberId ?? null, conflict: false }), version: newest(v?.version ?? null, c.version), groups: [], invalidated: c.why };
    }
    try {
      commit("claims", { ...S.claims, views });
      for (const i of done) closing.delete(i);
    } catch {
      // kept, still applied
    }
  }

  /**
   * Note an authentication of `identity` (e.g. "member:<id>" or "<issuer>|<subject>"): its group
   * claims at `version` (the source's issue time), fresh until `freshUntil` (null: no bound). Only a
   * strictly newer version replaces the view; an equal version with different groups is a durable
   * conflict (fail closed until a newer authentication). A claim-bearing authentication without an
   * issue time (`version` null) cannot be ordered: the view closes until a versioned one arrives.
   * Throws when the view could not be written (the identity is then closed until it is).
   */
  function noteAuth(identity, { version, groups = [], freshUntil = null, memberId = null }) {
    // Not recorded: closed at once, at the newest version seen, until a write succeeds.
    const close = (e) => {
      closing.set(identity, { version: newest(version, newest(S.claims.views[identity]?.version ?? null, closing.get(identity)?.version ?? null)), why: "not recorded", memberId });
      throw e;
    };
    try {
      ready();
    } catch (e) {
      close(e);
    }
    retryClosings();
    const v = S.claims.views[identity];
    const sorted = [...new Set(groups)].sort();
    let next = v;
    if (version === null) next = { version: v?.version ?? null, groups: [], freshUntil: null, memberId, conflict: false, invalidated: "no issue time" };
    else if (!v || v.version === null || version > v.version) next = { version, groups: sorted, freshUntil, memberId, conflict: false, invalidated: null };
    else if (version === v.version && !v.invalidated && JSON.stringify(sorted) !== JSON.stringify(v.groups)) next = { ...v, conflict: true, groups: [] };
    else if (version === v.version && !v.conflict && !v.invalidated) next = { ...v, freshUntil: v.freshUntil === null || freshUntil === null ? null : Math.max(v.freshUntil, freshUntil) };
    if (JSON.stringify(next) === JSON.stringify(v)) return;
    try {
      commit("claims", { ...S.claims, views: { ...S.claims.views, [identity]: next } });
    } catch (e) {
      close(e);
    }
    if (version !== null && closing.has(identity) && (closing.get(identity).version === null || version > closing.get(identity).version)) closing.delete(identity);
    changed();
  }
  /** A sign-out, unlink, member removal or token revocation: closed until a newer authentication. */
  function invalidate(identity, why) {
    const v = S.claims.views[identity];
    // While fenced memory may be behind the file: the closing applies whatever it shows.
    if (!fenced && (!v || (v.invalidated && !closing.has(identity)))) return;
    closing.set(identity, { version: newest(v?.version ?? null, closing.get(identity)?.version ?? null), why, memberId: v?.memberId ?? null });
    if (fenced) unfence();
    retryClosings();
  }
  /** The identities with an open claim view: [{identity, memberId, version}] (for reload checks). */
  const identities = () => Object.entries(S.claims.views).filter(([i, v]) => !v.invalidated && !closing.has(i)).map(([identity, v]) => ({ identity, memberId: v.memberId, version: v.version }));
  /** "ok" with groups, "stale" (hold), or "closed" (missing, conflict, invalidated: drop). */
  function viewOf(identity) {
    const v = S.claims.views[identity];
    if (!v || v.conflict || v.invalidated || closing.has(identity)) return { state: "closed" };
    if (v.freshUntil !== null && now() >= v.freshUntil) return { state: "stale" };
    return { state: "ok", groups: v.groups };
  }

  // ---- gates ---------------------------------------------------------------------------------

  /** The admin groups of a principal: by member id, and by provider groups in its claim view. */
  function adminGroups(memberId, identityGroups) {
    if (!pol) return [];
    return Object.entries(pol.groups)
      .filter(([, g]) => (memberId && (g.members ?? []).includes(memberId)) || (g.oidcGroups ?? []).some((o) => identityGroups.includes(`${o.issuer}|${o.group}`)))
      .map(([n]) => n);
  }
  const matches = (sel, who) => sel === "*" || (sel.startsWith("member:") && who.memberId && sel === `member:${who.memberId}`) || (sel.startsWith("group:") && who.groups.includes(sel.slice(6)));

  function gate1(sender, recipient) {
    if (!pol) return true;
    for (const r of pol.rules) if (matches(r.from, sender) && matches(r.to, recipient)) return r.action === "allow";
    return pol.defaultAction === "allow";
  }
  /**
   * Gate 2 for `sender` at recipient member `rid`: the most specific live entry wins, deny on ties.
   * {result, explicit}: explicit when an entry (of any specificity) denies this sender.
   */
  function gate2(sender, rid) {
    const g = S.grants.members[rid];
    if (!g) return { result: pol?.requireGrants ? "deny" : "allow", explicit: false };
    const t = now();
    const hits = g.entries.filter((e) => (e.until === undefined || e.until > t) && matches(e.selector, sender));
    const explicit = hits.some((e) => e.action === "deny");
    if (!hits.length) return { result: g.default, explicit };
    const top = Math.max(...hits.map((e) => specificity(e.selector)));
    const best = hits.filter((e) => specificity(e.selector) === top);
    return { result: best.some((e) => e.action === "deny") ? "deny" : "allow", explicit };
  }

  /**
   * A principal as policy sees it: {state, memberId, groups}. `identity` is its claim-view key;
   * without one (a shared token, or a recipient not seen since the relay started) only the member
   * id counts.
   */
  function principalOf({ memberId = null, identity = null }) {
    if (!identity) return { state: "ok", memberId, groups: adminGroups(memberId, []) };
    const v = viewOf(identity);
    if (v.state !== "ok") return { state: v.state, memberId, groups: [] };
    return { state: "ok", memberId, groups: adminGroups(memberId, v.groups) };
  }

  /**
   * Gates 1 and 2 for one delivery from `from` to `to` ({memberId, identity} each): "allow",
   * "deny", "hold" (a stale claim view, or unresolved state: decide again later), or "reply"
   * (gate 2 refuses, but a reply allowance for `replyTo` may pass it: see useAllowance).
   * `usedBy`: the message already holding that allowance (dispatch of an accepted reply).
   *
   * `send`: a decision for a new send, whose answer the sender sees. Nothing unresolved may tell
   * a hidden member from an unknown name there: unresolved state on the sender's side answers
   * "retry" for every target (before any target is looked at); a pending or stale recipient denies.
   */
  function decide(from, to, { replyTo = null, usedBy = null, send = false } = {}) {
    if (fenced) unfence();
    if (fenced) return send ? "retry" : "hold";
    // A pending recipient (design 4.4): before an inactive realm's "allow", gate 1, and the reply
    // allowance, which is neither consulted nor used for it. At dispatch it is held. A new send to
    // it is answered as for an unknown name or a member that refuses the sender, after the
    // sender's own (target-independent) state: "retry" or a different order would tell any sender
    // which names are held by members (hidden ones included) after a restore.
    const pendingTo = Boolean(to?.memberId && Object.hasOwn(pending(), to.memberId));
    if (pendingTo && !send) return "hold";
    let sender = null;
    if (active()) {
      retryClosings();
      sender = principalOf(from);
      if (sender.state === "closed") return "deny";
      if (sender.state === "stale") return send ? "retry" : "hold";
    }
    if (pendingTo) return "deny";
    if (!sender) return "allow";
    const recipient = principalOf(to ?? {});
    if (recipient.state === "closed") return "deny";
    if (recipient.state === "stale") return send ? "deny" : "hold";
    if (!gate1(sender, recipient)) return "deny";
    if (!to?.memberId) return "allow"; // gate 2 belongs to a member
    const g2 = gate2(sender, to.memberId);
    if (g2.result === "allow") return "allow";
    if (replyTo && from.memberId && !g2.explicit && allowanceFor(from.memberId, to.memberId, replyTo, usedBy)) return usedBy ? "allow" : "reply";
    return "deny";
  }

  /**
   * Gate 1's `transfers` rules (design 6: the relay's policy can refuse a member larger transfers)
   * for an uploader `from` ({memberId, identity}) as it is signed in now, with the same claim-view
   * semantics as gate 1: its admin groups come from its member id and from the provider groups of
   * its current claim view. The first matching rule decides, default allow. "allow", "deny" (also a
   * missing, conflicting or invalidated view), or "retry" (a stale view, or unresolved state: never
   * read as an empty claim set, which could skip a group deny).
   */
  function mayUpload(from) {
    if (fenced) unfence();
    if (fenced) return "retry";
    if (!active()) return "allow";
    // The uploader's claim view first, as gate 1 does: a signed-out or stale sign-in is refused
    // also when the policy has no transfers rules.
    retryClosings();
    const who = principalOf(from ?? {});
    if (who.state === "closed") return "deny";
    if (who.state !== "ok") return "retry";
    const rules = pol?.transfers ?? [];
    if (!rules.length) return "allow";
    const r = rules.find((x) => matches(x.from, who));
    return (r?.action ?? "allow") === "allow" ? "allow" : "deny";
  }

  /** Whether a member is hidden (shown only to those its gates allow). */
  const hidden = (memberId) => S.grants.members[memberId]?.visible === "grantees";
  /** A realm that requires grants or has hidden members refuses protocol-1 clients. */
  const strict = () => Boolean(pol?.requireGrants) || Object.values(S.grants.members).some((g) => g.visible === "grantees");

  // ---- grants (gate 2) -----------------------------------------------------------------------

  function grantsOf(memberId) {
    const g = S.grants.members[memberId];
    return g ? { ...g } : { revision: 0, default: pol?.requireGrants ? "deny" : "allow", visible: "all", entries: [] };
  }
  /**
   * Publish a member's grants: compare-and-swap on `baseRevision`; the relay assigns the next
   * revision. Returns {revision} or throws {code: "stale", revision}.
   */
  function putGrants(memberId, baseRevision, doc, { sharedToken = false } = {}) {
    ready();
    const g = validateGrants(doc);
    if (g.visible === "grantees" && sharedToken) throw Object.assign(new Error("this realm has a shared token: members cannot be hidden"), { code: "not_allowed" });
    const cur = grantsOf(memberId);
    if (baseRevision !== cur.revision) throw Object.assign(new Error("the grants changed meanwhile"), { code: "stale", revision: cur.revision });
    const next = { revision: cur.revision + 1, ...g, updatedAt: now() };
    try {
      commit("grants", { ...S.grants, members: { ...S.grants.members, [memberId]: next } });
    } catch (e) {
      throw Object.assign(new Error(e.outcome === "unchanged" ? "the grants could not be saved; nothing changed" : "the grants may not have been saved; check them"), { code: "unavailable" });
    }
    // Only now, with the grants durable: a pending mark of this member goes.
    clearPending(memberId);
    changed();
    return { revision: next.revision };
  }

  // ---- contact requests ----------------------------------------------------------------------

  /** Whether `rid`'s grants block requests from member `senderId` (deny-forever, still live). */
  const requestsBlocked = (rid, senderId) => (S.grants.members[rid]?.entries ?? []).some((e) => e.selector === `member:${senderId}` && e.requests === "blocked" && (e.until === undefined || e.until > now()));

  /**
   * A fixed-format contact request from `sender` ({memberId, identity, name}) to `to` ({memberId,
   * identity} or null when the name is unknown). The sender is charged the same and gets the same
   * answer whatever happens: it is recorded only when the sender passes gate 1 with a fresh claim
   * view, gate 2 refuses it, the recipient has not blocked requests from it, and the bounds allow.
   */
  function requestContact(sender, to, reason) {
    try {
      ready();
    } catch {
      return { limited: false, recorded: false }; // the same answer
    }
    const t = now();
    const day = Math.floor(t / DAY);
    const key = `${sender.memberId}|${day}`;
    const sentToday = S.requests.sent[key] ?? 0;
    if (sentToday >= REQUESTS_PER_SENDER_DAY) return { limited: true };
    const pending = S.requests.pending.filter((r) => r.expires > t);
    let store = pending;
    const rid = to?.memberId ?? null;
    const s = principalOf(sender);
    const r = principalOf(to ?? {});
    const eligible =
      rid &&
      s.state === "ok" &&
      r.state === "ok" &&
      gate1(s, r) &&
      gate2(s, rid).result !== "allow" &&
      !requestsBlocked(rid, sender.memberId) &&
      !pending.some((x) => x.to === rid && x.from === sender.memberId) &&
      pending.filter((x) => x.to === rid).length < REQUESTS_PER_RECIPIENT;
    if (eligible) store = [...pending, { id: `cr_${crypto.randomBytes(9).toString("base64url")}`, from: sender.memberId, name: String(sender.name ?? "").slice(0, 64), to: rid, reason: REASONS.includes(reason) ? reason : "other", at: t, expires: t + REQUEST_TTL_MS }];
    const sent = Object.fromEntries(Object.entries({ ...S.requests.sent, [key]: sentToday + 1 }).filter(([k]) => Number(k.split("|")[1]) >= day - 1));
    try {
      commit("requests", { ...S.requests, pending: store, sent });
    } catch {
      // the same answer either way: a request that could not be recorded is like any other
    }
    return { limited: false, recorded: Boolean(eligible) };
  }
  const requestsFor = (rid) => S.requests.pending.filter((r) => r.to === rid && r.expires > now() && !requestsBlocked(rid, r.from));
  /**
   * The recipient's owner answers: accept (a member allow in gate 2), deny, or deny-forever (a
   * member deny that also blocks requests). The grants change is written first; a failure after it
   * leaves the request pending, and answering again is harmless.
   */
  function answerRequest(rid, id, action) {
    ready();
    const r = requestsFor(rid).find((x) => x.id === id);
    if (!r) throw Object.assign(new Error("no such request"), { code: "not_found" });
    if (!["accept", "deny", "deny-forever"].includes(action)) throw Object.assign(new Error("action must be accept, deny or deny-forever"), { code: "bad_request" });
    const cur = grantsOf(rid);
    const others = cur.entries.filter((e) => e.selector !== `member:${r.from}`);
    if (action === "accept") putGrants(rid, cur.revision, { ...cur, entries: [...others, { selector: `member:${r.from}`, action: "allow" }] });
    if (action === "deny-forever") putGrants(rid, cur.revision, { ...cur, entries: [...others, { selector: `member:${r.from}`, action: "deny", requests: "blocked" }] });
    try {
      commit("requests", { ...S.requests, pending: S.requests.pending.filter((x) => x.id !== id) });
    } catch {
      throw Object.assign(new Error("the answer was applied, but the request could not be cleared; answer it again"), { code: "unavailable" });
    }
    return { action, from: r.from };
  }

  // ---- reply allowances ------------------------------------------------------------------------

  /**
   * After a message from member A to member B passed every gate, including B's local release: B may
   * reply once to A within 7 days even if A's gate 2 refuses B by default. Recorded only when that
   * exception would be needed. Best effort: an allowance that could not be written does not exist.
   */
  function noteRelease(fromMemberId, toMemberId, messageId) {
    if (!active() || !fromMemberId || !toMemberId) return;
    try {
      ready();
    } catch {
      return;
    }
    if (gate2({ memberId: toMemberId, groups: adminGroups(toMemberId, []) }, fromMemberId).result === "allow") return;
    const t = now();
    const entries = S.allowances.entries.filter((e) => (e.used ? e.used.at + REPLY_ALLOWANCE_MS > t : e.expires > t));
    if (entries.some((e) => e.message === messageId && e.from === toMemberId)) return;
    try {
      commit("allowances", { ...S.allowances, entries: [...entries, { from: toMemberId, to: fromMemberId, message: messageId, expires: t + REPLY_ALLOWANCE_MS, used: null }] });
    } catch {
      // not recorded
    }
  }
  /**
   * The allowance `from` holds for replying to `to` about `messageId`: at dispatch, the one used by
   * `usedBy`; at send, an unused live one, or a used one (useAllowance then tells a repeat of the
   * same operation from a second reply). Horizons are checked here, not left to the sweep: an
   * unused allowance lasts 7 days from the release, a used one 7 days from its use (its reply
   * may wait in a queue until then).
   */
  function allowanceFor(from, to, messageId, usedBy = null) {
    const e = S.allowances.entries.find((x) => x.from === from && x.to === to && x.message === messageId);
    if (!e) return null;
    const t = now();
    if (e.used) return e.used.at + REPLY_ALLOWANCE_MS > t && (!usedBy || e.used.messageId === usedBy) ? e : null;
    return !usedBy && e.expires > t ? e : null;
  }
  /**
   * Use the allowance for one reply, durably, before the reply is accepted: bound to the reply
   * operation `op` and its payload `digest` at member scope, with the reply's message and delivery
   * ids and its envelope times (`ts`, and `expires` or null). Returns {use: "new"} (the caller
   * accepts that message), {use: "repeat", messageId, deliveryId, ts, expires} (the same operation
   * again: the caller answers with that message if it accepted it, and otherwise accepts it now
   * exactly as recorded, unless its expiry has passed: a use recorded by an uncertain write, or
   * before a restart), or {use: "refused"}. Throws when it could not be written.
   */
  function useAllowance(from, to, replyTo, { op, digest, messageId, deliveryId, ts, expires = null }) {
    ready();
    const e = allowanceFor(from, to, replyTo);
    if (!e) return { use: "refused" };
    if (e.used) return op && e.used.op === op && e.used.digest === digest ? { use: "repeat", messageId: e.used.messageId, deliveryId: e.used.deliveryId, ts: e.used.ts, expires: e.used.expires } : { use: "refused" };
    const used = { op: op ?? null, digest, messageId, deliveryId, ts, expires, at: now() };
    commit("allowances", { ...S.allowances, entries: S.allowances.entries.map((x) => (x === e ? { ...x, used } : x)) });
    return { use: "new" };
  }

  // ---- cleanup ----------------------------------------------------------------------------------

  /**
   * Remove what has expired: pending requests and unused allowances after their 7 days, used
   * allowances 7 days after use (their reply may still be queued until then), request counters
   * older than a day; and the group lists of closed views (a closed view keeps its version and
   * reason, so an older authentication can never reopen it).
   */
  function sweep() {
    try {
      ready();
    } catch {
      return;
    }
    retryClosings();
    clearPending(); // a rewrite that failed earlier is tried again
    const t = now();
    const day = Math.floor(t / DAY);
    const pending = S.requests.pending.filter((r) => r.expires > t);
    const sent = Object.fromEntries(Object.entries(S.requests.sent).filter(([k]) => Number(k.split("|")[1]) >= day - 1));
    const entries = S.allowances.entries.filter((e) => (e.used ? e.used.at + REPLY_ALLOWANCE_MS > t : e.expires > t));
    const views = Object.fromEntries(Object.entries(S.claims.views).map(([i, v]) => [i, (v.invalidated || v.conflict) && v.groups.length ? { ...v, groups: [] } : v]));
    try {
      if (pending.length !== S.requests.pending.length || Object.keys(sent).length !== Object.keys(S.requests.sent).length) commit("requests", { ...S.requests, pending, sent });
      if (entries.length !== S.allowances.entries.length) commit("allowances", { ...S.allowances, entries });
      if (JSON.stringify(views) !== JSON.stringify(S.claims.views)) commit("claims", { ...S.claims, views });
    } catch {
      // tried again at the next sweep
    }
  }

  clearPending(); // at load: members that published since the restore

  return {
    active,
    decide,
    hidden,
    strict,
    subscribe: (fn) => (listener = fn),
    noteAuth,
    invalidate,
    identities,
    viewOf,
    grantsOf,
    putGrants,
    requestContact,
    requestsFor,
    answerRequest,
    noteRelease,
    useAllowance,
    sweep,
    fenced: () => fenced,
    /** Pending recipients after a restore (design 4.4): [{memberId, revision}] (revision at the restore). */
    pendingRecipients: () => Object.entries(pending()).map(([memberId, revision]) => ({ memberId, revision })),
    /** Re-read restore.json (reload); throws when it cannot be read, keeping the marks in force. */
    reloadRestore() {
      restoreDoc = loadRestore();
      clearPending();
    },
    /** Every member's published grants (the relay admin's read-only views). */
    allGrants: () => ({ ...S.grants.members }),
    setPolicy: (p) => {
      pol = p;
      changed();
    },
    policy: () => pol,
    mayUpload,
  };
}
