// Relay-side member administration (`hoptell members ...`), run on the relay host against its
// members file. New tokens are shown once and stored only as their SHA-256; the file is checked
// with the same rules as the relay before it is replaced, and other fields are kept as they are.
import crypto from "node:crypto";
import fs from "node:fs";
import { NAME_RE } from "./config.js";
import { withLock, writeRecord } from "./locks.js";
import { HOST_ID_RE, newMemberId, validateMembers } from "./relay.js";

function readFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return { members: [] };
    throw new Error(`${file}: ${e.code || "cannot read"}`);
  }
  if (process.platform !== "win32" && fs.statSync(file).mode & 0o077) throw new Error(`${file} holds tokens; restrict it first: chmod 600 ${file}`);
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new Error(`${file}: invalid JSON`); // never quote the file: it holds tokens
  }
  if (!doc || !Array.isArray(doc.members)) throw new Error(`${file}: expected {"members": [...]}`);
  if (doc.hosts !== undefined && !Array.isArray(doc.hosts)) throw new Error(`${file}: hosts must be a list`);
  return doc;
}

/**
 * The file a members path names: a symlink is followed once, so the lock and the atomic replace
 * act on the file the relay reads, and the link itself stays (a missing file: the path as given).
 */
export function membersTarget(file) {
  try {
    return fs.realpathSync(file);
  } catch (e) {
    if (e.code === "ENOENT") return file;
    throw new Error(`${file}: ${e.code || "cannot resolve"}`);
  }
}

/** Change the members file under a lock; `change(doc)` returns the result to report. */
async function update(given, change) {
  const file = membersTarget(given);
  return withLock(file, () => {
    const doc = readFile(file);
    const result = change(doc);
    validateMembers(doc.members, doc.hosts ?? []); // the relay's own rules: names, ids, tokens, overlaps, hosts
    writeRecord(file, doc, 2);
    return result;
  });
}

export const tokenKind = (t) => (/^sha256:/i.test(t || "") ? "hashed" : "plain");

/** The members file as the admin tools read it (tokens are in it: never print or log them). */
export const readMembersDoc = (file) => readFile(file);

/**
 * The members list as the relay loads it at start and reload: the file must exist, be private and
 * hold {"members": [...]}. Errors never quote the file (it holds tokens).
 */
export function loadMembersFile(file) {
  return loadMembersAndHosts(file).members;
}

/**
 * The members list and the host credentials (design 4.5) in one read, as the relay loads them:
 * {members, hosts} (hosts [] when the file lists none).
 */
export function loadMembersAndHosts(file) {
  const st = fs.statSync(file);
  if (process.platform !== "win32" && st.mode & 0o077) throw new Error(`${file} holds tokens; restrict it first: chmod 600 ${file}`);
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    // JSON.parse messages can quote the file, and the file holds tokens.
    throw new Error(e instanceof SyntaxError ? `${file}: invalid JSON` : `${file}: ${e.code || "cannot read"}`);
  }
  if (!Array.isArray(doc?.members)) throw new Error(`${file}: expected {"members": [{"name": "...", "token": "..."}]}`);
  if (doc.hosts !== undefined && !Array.isArray(doc.hosts)) throw new Error(`${file}: hosts must be a list of {"id", "token"}`);
  return { members: doc.members, hosts: doc.hosts ?? [] };
}

/** Members without their tokens. */
export function listMembers(file) {
  return readFile(file).members.map((m) => ({ name: m.name, id: m.id ?? null, token: m.custody === "hosted" ? "none" : tokenKind(m.token), ...(m.custody === "hosted" ? { custody: "hosted", host: m.host } : {}) }));
}

/** Hosts (design 4.5) without their tokens. */
export function listHosts(file) {
  return (readFile(file).hosts ?? []).map((h) => ({ id: h.id, token: tokenKind(h.token) }));
}

/**
 * Add a host credential (design 4.5): returns {id, token}; the token is shown once and stored as
 * its SHA-256. With it the host may open protocol-2 connections only for members hosted by it.
 */
export function addHost(file, id) {
  if (!HOST_ID_RE.test(id || "")) throw new Error(`invalid host id "${id}": 1-32 lowercase letters, digits or "-"`);
  const token = crypto.randomBytes(32).toString("hex");
  return update(file, (doc) => {
    doc.hosts ??= [];
    if (doc.hosts.some((h) => h.id === id)) throw new Error(`host "${id}" already exists; remove it first to issue a new token`);
    doc.hosts.push({ id, token: `sha256:${crypto.createHash("sha256").update(token).digest("hex")}` });
    return { id, token };
  });
}

/** Remove a host credential; refused while a member is hosted by it (custody does not move). */
export function removeHost(file, id) {
  return update(file, (doc) => {
    if (!(doc.hosts ?? []).some((h) => h.id === id)) throw new Error(`no host "${id}"`);
    const held = doc.members.filter((m) => m.custody === "hosted" && m.host === id).map((m) => m.name);
    if (held.length) throw new Error(`host "${id}" holds ${held.join(", ")}; revoke those members first`);
    doc.hosts = doc.hosts.filter((h) => h.id !== id);
    if (!doc.hosts.length) delete doc.hosts;
    return { id };
  });
}

/**
 * Add a hosted member (design 4.5): a new member id in the custody of `host`, with no token and no
 * linked identity at the relay. Custody is immutable: an existing member is never made hosted.
 */
export function addHostedMember(file, name, host) {
  if (!NAME_RE.test(name || "")) throw new Error(`invalid member name "${name}": letters, digits, "_" and "-", up to 64 characters`);
  const id = newMemberId();
  return update(file, (doc) => {
    if (doc.members.some((m) => m.name === name)) throw new Error(`member "${name}" already exists; custody never changes for a member, so a hosted member needs a new name`);
    if (!(doc.hosts ?? []).some((h) => h.id === host)) throw new Error(`no host "${host}": add it first with hoptell members host add ${host}`);
    doc.members.push({ name, id, custody: "hosted", host });
    return { name, id, host };
  });
}

/** Add a member with a new id and token; returns {name, id, token} (the token is shown once). */
export function addMember(file, name) {
  if (!NAME_RE.test(name || "")) throw new Error(`invalid member name "${name}": letters, digits, "_" and "-", up to 64 characters`);
  const token = crypto.randomBytes(32).toString("hex");
  const id = newMemberId();
  return update(file, (doc) => {
    if (doc.members.some((m) => m.name === name)) throw new Error(`member "${name}" already exists; revoke it first to issue a new token`);
    doc.members.push({ name, id, token: `sha256:${crypto.createHash("sha256").update(token).digest("hex")}` });
    return { name, id, token };
  });
}

/** End a member's broker sign-ins made until now (design 1.7): applied by the relay on reload. */
export function signoutMember(file, name) {
  return update(file, (doc) => {
    const m = doc.members.find((x) => x.name === name);
    if (!m) throw new Error(`no member named "${name}"`);
    m.signedOutAt = Date.now();
    return { name };
  });
}

/**
 * Link an identity-provider identity (issuer + subject) to a member (design 1.6), or unlink it.
 * A member may sign in with its token, its linked identities, or both.
 */
export function linkMember(file, name, { issuer, subject, unlink = false }) {
  if (!/^https?:\/\//.test(issuer ?? "") || !subject) throw new Error("--issuer <URL> and --subject <subject> are required");
  const iss = issuer; // exactly as the provider names itself (its discovery document's "issuer")
  return update(file, (doc) => {
    const m = doc.members.find((x) => x.name === name);
    if (!m) throw new Error(`no member named "${name}"`);
    const has = (m.oidc ?? []).some((l) => l.issuer === iss && l.subject === subject);
    if (unlink) {
      if (!has) throw new Error(`"${name}" has no such linked identity`);
      m.oidc = m.oidc.filter((l) => !(l.issuer === iss && l.subject === subject));
      if (!m.oidc.length) delete m.oidc;
    } else {
      if (has) return { name, already: true };
      m.oidc = [...(m.oidc ?? []), { issuer: iss, subject }];
    }
    return { name };
  });
}

/**
 * Revoke a device of a member as the relay admin (design 3.2, experimental): recorded in the
 * members file and applied durably by the relay at its next start or reload. The relay then stops
 * serving the device's KeyPackages and directory entry; the device id is never accepted again.
 */
export function revokeMemberDevice(file, name, device) {
  if (!/^[a-z2-7]{25}[aeimquy4]$/.test(device ?? "")) throw new Error(`invalid device id "${String(device).slice(0, 40)}"`);
  return update(file, (doc) => {
    const m = doc.members.find((x) => x.name === name);
    if (!m) throw new Error(`no member named "${name}"`);
    if ((m.devicesRevoked ?? []).includes(device)) return { name, device, already: true };
    m.devicesRevoked = [...(m.devicesRevoked ?? []), device];
    return { name, device };
  });
}

/** Remove a member; its sessions are disconnected when the relay reloads the file. */
export function revokeMember(file, name) {
  return update(file, (doc) => {
    const before = doc.members.length;
    doc.members = doc.members.filter((m) => m.name !== name);
    if (doc.members.length === before) throw new Error(`no member named "${name}"`);
    return { name };
  });
}

/**
 * Give generated ids to members that have none. Their identity changes (from the tagged legacy id),
 * so their sessions reconnect and their queued messages are dropped. Without `apply`, only reports.
 */
export async function migrateMembers(file, { apply = false } = {}) {
  const pending = readFile(file).members.filter((m) => m.id === undefined).map((m) => m.name);
  if (!apply || !pending.length) return { pending, applied: false };
  await update(file, (doc) => {
    for (const m of doc.members) if (m.id === undefined) m.id = newMemberId();
  });
  return { pending, applied: true };
}
