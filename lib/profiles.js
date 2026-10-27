// Client profiles: per configured relay, the realm it was first seen with and whether protocol 2
// is required. Pinning is an interprocess compare-and-set under a short lock, so two first
// connections cannot pin different realms. A record that cannot be read is an error, never a
// fresh profile.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { withLock, writeRecord } from "./locks.js";

const PROFILE_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

/** The profile key for a relay URL: the explicit profile (HOPTELL_PROFILE), or a digest of the normalized URL. */
export function profileKey(relayUrl, explicit = null) {
  if (explicit) {
    if (!PROFILE_RE.test(explicit)) throw new Error('HOPTELL_PROFILE must be 1 to 64 letters, digits, ".", "_" or "-", starting with a letter or digit');
    return explicit;
  }
  const u = new URL(relayUrl);
  const normal = `${u.protocol}//${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, "")}`;
  return `relay-${crypto.createHash("sha256").update(normal).digest("hex").slice(0, 16)}`;
}

const dirFor = (home) => {
  const dir = path.join(home, "profiles");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
};

function readRecord(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw new Error(`cannot read the relay profile ${file}: ${e.code}`);
  }
  let rec;
  try {
    rec = JSON.parse(text);
  } catch {
    throw new Error(`the relay profile ${file} is damaged; check it, or remove it to start this relay's profile again`);
  }
  if (rec?.v !== 1 || typeof rec.require !== "boolean" || (rec.realm !== null && !/^[0-9a-f]{32}$/.test(rec.realm))) {
    throw new Error(`the relay profile ${file} is not valid; check it, or remove it to start this relay's profile again`);
  }
  return rec;
}

/** Read a profile (null if none yet). */
export function readProfile(home, key) {
  return readRecord(path.join(dirFor(home), `${key}.json`));
}

/**
 * After a protocol-2 welcome: pin the realm (first time) or check it, and require protocol 2
 * from now on. Throws if this profile was pinned to a different realm.
 */
export async function commitWelcome(home, key, { realm, member }) {
  const file = path.join(dirFor(home), `${key}.json`);
  return withLock(file, () => {
    const rec = readRecord(file);
    if (rec?.realm && rec.realm !== realm) throw new Error(`this profile's relay realm changed (pinned ${rec.realm}, the relay reports ${realm}); if the relay was replaced on purpose, remove ${file}`);
    const next = { v: 1, realm, require: true, member: member?.id ?? null, updated: new Date().toISOString() };
    if (!rec || rec.realm !== next.realm || rec.require !== true || rec.member !== next.member) writeRecord(file, next);
    return next;
  });
}

/** Record that this profile talks to a protocol-1 relay (only for profiles that do not require 2). */
export async function noteLegacy(home, key) {
  const file = path.join(dirFor(home), `${key}.json`);
  return withLock(file, () => {
    const rec = readRecord(file);
    if (rec?.require) throw new Error("this relay profile requires protocol 2, but the relay only speaks protocol 1; it may have been replaced by an older relay");
    if (!rec) writeRecord(file, { v: 1, realm: null, require: false, member: null, updated: new Date().toISOString() });
    return rec;
  });
}
