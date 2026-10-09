// Bound storage for protocol-2 sessions: ~/.hoptell/v2/<realm>/<member>/<session key>/, with an
// immutable binding.json naming the realm, member and session key it belongs to. Protocol-1
// sessions keep the legacy inbox/<name>; messages are never moved between the two.
import fs from "node:fs";
import path from "node:path";
import { NAME_RE, ensurePrivateDir } from "./config.js";
import { legacyStore } from "./inbox.js";
import { withLock, writeRecord } from "./locks.js";
import { profileKey, readProfile } from "./profiles.js";

const REALM_RE = /^[0-9a-f]{32}$/;
const MEMBER_DIR_RE = /^(m_[a-z2-7]{26}|name-[A-Za-z0-9][A-Za-z0-9_-]{0,63}|shared)$/;

/** The directory part for a member id: "m_…", "name-<name>" for tagged legacy ids, or "shared". */
export function memberDir(member) {
  if (!member) return "shared";
  const id = String(member.id);
  const dir = id.startsWith("name:") ? `name-${id.slice(5)}` : id;
  if (!MEMBER_DIR_RE.test(dir) || dir === "shared") throw new Error(`the relay reported a member id this client cannot store: ${JSON.stringify(id).slice(0, 80)}`);
  return dir;
}

/**
 * The session key: an explicit HOPTELL_NAME as is, or an automatic name's local stem (without the
 * "<member>-" prefix), so the same storage is found again whatever the relay calls the member.
 */
export function sessionKey(name, { explicit, member }) {
  const prefix = member?.name ? `${member.name}-` : "";
  const key = !explicit && prefix && name.startsWith(prefix) ? name.slice(prefix.length) : name;
  if (!NAME_RE.test(key)) throw new Error(`invalid session key ${JSON.stringify(key).slice(0, 80)}`);
  return key;
}

const v2Root = (home) => path.join(home, "v2");

/** Read and check a binding record; throws on anything unexpected. */
function readBinding(file, expect) {
  let rec;
  try {
    rec = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw new Error(`the session binding ${file} cannot be read; check it, or remove its folder to start the session's storage again`);
  }
  const same = rec?.v === 1 && rec.realm === expect.realm && rec.member === expect.member && rec.session_key === expect.session_key;
  if (!same) throw new Error(`the session storage ${path.dirname(file)} belongs to another realm, member or session; it was not changed`);
  return rec;
}

/**
 * Open (creating if needed) the bound storage for a protocol-2 session. Returns {dir, inbox, seen}.
 * The lock is held only while the binding is created or checked.
 */
export async function openBound(home, { realm, member, key }) {
  if (!REALM_RE.test(realm || "")) throw new Error("the relay reported no valid realm id");
  const m = memberDir(member);
  ensurePrivateDir(home);
  ensurePrivateDir(v2Root(home));
  ensurePrivateDir(path.join(v2Root(home), realm));
  ensurePrivateDir(path.join(v2Root(home), realm, m));
  const dir = ensurePrivateDir(path.join(v2Root(home), realm, m, key));
  const file = path.join(dir, "binding.json");
  const expect = { realm, member: m, session_key: key };
  await withLock(file, () => {
    if (!readBinding(file, expect)) writeRecord(file, { v: 1, ...expect, created: new Date().toISOString() });
  });
  return { dir, inbox: ensurePrivateDir(path.join(dir, "inbox")), seen: ensurePrivateDir(path.join(dir, "seen")) };
}

/**
 * Record which member's storage holds an explicit name in a realm, for local consumers that know
 * only the name (tmux injector, `hoptell listen <name>`). The relay leases a name to one session
 * per realm, so the session that connected last with the name is the one to follow.
 */
export function noteNameOwner(home, { realm, member, name }) {
  const dir = ensurePrivateDir(path.join(v2Root(home), realm, "names"));
  writeRecord(path.join(dir, `${name}.json`), { v: 1, member: memberDir(member), updated: new Date().toISOString() });
}

/**
 * A bound storage folder given on the command line (`hoptell listen --session <dir>`): it must be
 * one this installation created, under its v2 folder, with a valid binding.
 */
export function boundFromPath(home, dir) {
  const real = fs.realpathSync(dir);
  const root = fs.realpathSync(v2Root(home));
  const rel = path.relative(root, real).split(path.sep);
  if (rel.length !== 3 || rel[0] === ".." || !REALM_RE.test(rel[0]) || !MEMBER_DIR_RE.test(rel[1]) || !NAME_RE.test(rel[2])) {
    throw new Error(`${dir} is not a hoptell session folder`);
  }
  readBinding(path.join(real, "binding.json"), { realm: rel[0], member: rel[1], session_key: rel[2] }) ?? (() => {
    throw new Error(`${dir} has no session binding`);
  })();
  return { dir: real, inbox: path.join(real, "inbox"), seen: path.join(real, "seen") };
}

/**
 * Where a local consumer that knows only an explicit peer name (tmux injector, `hoptell listen
 * <name>`) finds that session's messages, resolved at each use:
 *   {state: "bound", store}   the receiving session's protocol-2 storage, as it recorded it;
 *   {state: "legacy", store}  the legacy inbox/<name>: protocol 1 was chosen or negotiated;
 *   {state: "pending"}        no receiver has connected with this name yet: wait;
 *   {state: "invalid", error} a record is damaged: never fall back to another storage.
 */
export function resolveNameStore(home, name, { relayUrl, protocol = 2, profile = null }) {
  if (protocol === 1) return { state: "legacy", store: legacyStore(home, name) };
  let rec;
  try {
    rec = relayUrl ? readProfile(home, profileKey(relayUrl, profile)) : null;
  } catch (e) {
    return { state: "invalid", error: e.message };
  }
  if (!rec) return { state: "pending" };
  if (!rec.require) return { state: "legacy", store: legacyStore(home, name) }; // this relay was negotiated as protocol 1
  const file = path.join(v2Root(home), rec.realm, "names", `${name}.json`);
  let owner;
  try {
    owner = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    return e.code === "ENOENT" ? { state: "pending" } : { state: "invalid", error: `${file} cannot be read` };
  }
  if (owner?.v !== 1 || !MEMBER_DIR_RE.test(owner.member ?? "")) return { state: "invalid", error: `${file} is not valid` };
  try {
    return { state: "bound", store: boundFromPath(home, path.join(v2Root(home), rec.realm, owner.member, name)) };
  } catch (e) {
    return { state: "invalid", error: e.message };
  }
}
