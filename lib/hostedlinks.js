// The hosted endpoint's link table (design 4.5, "Links"): (issuer, subject) -> hosted member, a
// deliberate admin link kept in the host's own state (`<host state>/links.json`, 0600, written
// with writeDurable), never in the relay's members file. Each entry carries a generation: a
// host-wide counter, never reused, assigned whenever the entry is created or changed (link,
// relink to another member, relink of the member to another subject); unlinking removes it.
// Owner-page sessions bind to (issuer, subject, member, generation), so no change ever revives an
// earlier session.
//
// The server re-reads the file when it changes on disk (the CLI edits it while the server runs);
// a table that cannot be read is an error, never "not linked".
import fs from "node:fs";
import path from "node:path";
import { writeDurable } from "./credentials.js";
import { withLock } from "./locks.js";
import { MEMBER_ID_RE } from "./relay.js";
import { NAME_RE } from "./config.js";

export const LINKS_FILE = "links.json";
/**
 * Members the relay said it no longer holds for this host (design 4.5, member removal):
 * `<host state>/removed.json`, {v: 1, members: {<member id>: {generation, at}}}. A mark applies
 * while the member's link keeps the generation it was made under; a new link (a new generation)
 * clears it in effect. Written only after the relay's explicit answer, confirmed (hostedtenants).
 */
export const REMOVED_FILE = "removed.json";

function readRemoved(stateDir) {
  const file = path.join(stateDir, REMOVED_FILE);
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return { v: 1, members: {} };
    throw new Error(e instanceof SyntaxError ? "removed.json: invalid JSON" : `removed.json: ${e.code ?? e.message}`);
  }
  const ok = doc?.v === 1 && doc.members && typeof doc.members === "object" && Object.entries(doc.members).every(([id, m]) => MEMBER_ID_RE.test(id) && Number.isSafeInteger(m?.generation) && Number.isSafeInteger(m?.at));
  if (!ok) throw new Error("removed.json: unknown format");
  return doc;
}

/** Mark a member removed at the relay under its current link generation (durable, under the lock). */
export async function markRemoved(stateDir, memberId, generation, { now = Date.now() } = {}) {
  const file = path.join(stateDir, REMOVED_FILE);
  return withLock(file, () => {
    const doc = readRemoved(stateDir);
    doc.members[memberId] = { generation, at: now };
    writeDurable(file, `${JSON.stringify(doc, null, 2)}\n`);
  });
}
const MAX_LINKS = 100_000;

const linkOk = (l) =>
  l &&
  typeof l.issuer === "string" &&
  /^https?:\/\//.test(l.issuer) &&
  typeof l.subject === "string" &&
  l.subject.length > 0 &&
  l.subject.length <= 255 &&
  MEMBER_ID_RE.test(l.member?.id ?? "") &&
  NAME_RE.test(l.member?.name ?? "") &&
  Number.isSafeInteger(l.generation) &&
  l.generation > 0;

/** Validate a links document as stored; throws with a fixed message (never quoting the file). */
export function checkLinks(doc) {
  if (doc?.v !== 1 || !Number.isSafeInteger(doc.counter) || doc.counter < 0 || !Array.isArray(doc.links) || doc.links.length > MAX_LINKS) throw new Error("links.json: unknown format");
  const subjects = new Set();
  const members = new Set();
  for (const l of doc.links) {
    if (!linkOk(l)) throw new Error("links.json: an entry is not {issuer, subject, member: {id, name}, generation}");
    if (l.generation > doc.counter) throw new Error("links.json: a generation is above the counter");
    const k = `${l.issuer}|${l.subject}`;
    if (subjects.has(k)) throw new Error("links.json: an identity is linked twice");
    if (members.has(l.member.id)) throw new Error("links.json: a member is linked twice");
    subjects.add(k);
    members.add(l.member.id);
  }
  return doc;
}

const empty = () => ({ v: 1, counter: 0, links: [] });

/** Read the table: an absent file is empty; anything unreadable or invalid throws. */
export function readLinks(stateDir) {
  const file = path.join(stateDir, LINKS_FILE);
  let text;
  try {
    const st = fs.statSync(file);
    if (process.platform !== "win32" && st.mode & 0o077) throw new Error(`${file} is readable by other users; chmod 600 it`);
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return empty();
    throw e;
  }
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new Error("links.json: invalid JSON");
  }
  return checkLinks(doc);
}

/**
 * Change the table under its lock: `change(doc)` edits a copy and returns the result. Every created
 * or changed entry gets the next generation. Written with writeDurable (its errors keep `phase`).
 */
async function update(stateDir, change, { fault = null } = {}) {
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const file = path.join(stateDir, LINKS_FILE);
  return withLock(file, () => {
    const doc = structuredClone(readLinks(stateDir));
    const result = change(doc);
    checkLinks(doc);
    writeDurable(file, `${JSON.stringify(doc, null, 2)}\n`, { fault });
    return result;
  });
}

/**
 * Link (issuer, subject) to a hosted member {id, name}. A relink of the subject to another member,
 * or of the member to another subject, replaces the old entry (one link per identity and per
 * member) with a new generation; the same link again changes nothing.
 */
export function link(stateDir, { issuer, subject, member }, { fault = null } = {}) {
  if (!/^https?:\/\//.test(issuer ?? "") || typeof subject !== "string" || !subject || subject.length > 255) throw new Error("--issuer <URL> and --subject <subject> are required");
  if (!MEMBER_ID_RE.test(member?.id ?? "") || !NAME_RE.test(member?.name ?? "")) throw new Error("--member needs the hosted member's id (m_...) and --name its member name");
  return update(stateDir, (doc) => {
    const same = doc.links.find((l) => l.issuer === issuer && l.subject === subject && l.member.id === member.id && l.member.name === member.name);
    if (same) return { already: true, generation: same.generation };
    doc.links = doc.links.filter((l) => !(l.issuer === issuer && l.subject === subject) && l.member.id !== member.id);
    doc.counter += 1;
    doc.links.push({ issuer, subject, member: { id: member.id, name: member.name }, generation: doc.counter });
    return { already: false, generation: doc.counter };
  }, { fault });
}

/** Remove the link of (issuer, subject); returns the member it named. */
export function unlink(stateDir, { issuer, subject }, { fault = null } = {}) {
  return update(stateDir, (doc) => {
    const l = doc.links.find((x) => x.issuer === issuer && x.subject === subject);
    if (!l) throw new Error("no such link");
    doc.links = doc.links.filter((x) => x !== l);
    return { member: l.member };
  }, { fault });
}

/**
 * The server's view of the table: re-read when the file changes (mtime, size, inode), so CLI edits
 * apply at the next request. `lookup` throws when the table cannot be read (the caller answers
 * 503, never "not linked").
 */
export function linkTable(stateDir) {
  const file = path.join(stateDir, LINKS_FILE);
  let cache = null;
  let sig = null;
  const current = () => {
    let st = null;
    try {
      st = fs.statSync(file);
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    const s = st ? `${st.ino}:${st.size}:${st.mtimeMs}` : "absent";
    if (s !== sig || !cache) {
      cache = readLinks(stateDir);
      sig = s;
    }
    return cache;
  };
  const removedFile = path.join(stateDir, REMOVED_FILE);
  let removedCache = null;
  let removedSig = null;
  const removedDoc = () => {
    let st = null;
    try {
      st = fs.statSync(removedFile);
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    const s = st ? `${st.ino}:${st.size}:${st.mtimeMs}` : "absent";
    if (s !== removedSig || !removedCache) {
      removedCache = readRemoved(stateDir);
      removedSig = s;
    }
    return removedCache;
  };
  return {
    /**
     * Whether the relay said it no longer holds this member, under its current link. Throws when
     * either file cannot be read (callers fail closed).
     */
    removed(memberId) {
      const m = removedDoc().members[memberId];
      if (!m) return false;
      const l = current().links.find((x) => x.member.id === memberId);
      return !l || l.generation === m.generation;
    },
    /** The current link generation of a member, or null. */
    generationOf(memberId) {
      return current().links.find((x) => x.member.id === memberId)?.generation ?? null;
    },
    /** The link of (issuer, subject): {member, generation} or null. */
    lookup(issuer, subject) {
      const l = current().links.find((x) => x.issuer === issuer && x.subject === subject);
      return l ? { member: { ...l.member }, generation: l.generation } : null;
    },
    /** Whether a member id is linked at all (a tenant whose link is gone is unlinked). */
    linkedMember(memberId) {
      return current().links.some((l) => l.member.id === memberId);
    },
    all: () => current().links.map((l) => ({ ...l, member: { ...l.member } })),
  };
}
