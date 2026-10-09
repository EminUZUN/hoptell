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

const REALM_RE = /^[0-9a-f]{32}$/;
const MEMBER_RE = /^(m_[a-z2-7]{26}|name:[A-Za-z0-9][A-Za-z0-9_-]{0,63})$/;
const PROFILE_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const ID_RE = /^[gb]_[a-z2-7]{16}$/;
const POLICIES = ["ask", "allow", "block"];
const TOP = new Set(["version", "revision", "default", "unverified", "grants", "blocks", "replies"]);
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
  if (doc.replies !== undefined) {
    const r = doc.replies;
    if (!r || typeof r !== "object" || Array.isArray(r) || Object.keys(r).some((k) => k !== "allowWithin")) problems.push("replies must be an object with allowWithin");
    else if (r.allowWithin !== undefined && r.allowWithin !== null) problems.push("replies.allowWithin is not supported yet (reply allowances come later); remove it or set it to null");
  }
  return problems;
}

/**
 * The sender key of a stored message, from the provenance the relay recorded (never inferred or
 * upgraded later): {realm, member} for member tokens, {realm, shared, name} for the shared
 * token, and {unverified, relay, name} otherwise (protocol 1, missing or malformed provenance),
 * where relay is the profile recorded with the message when it arrived (or null: unknown).
 */
export function senderKey(msg) {
  const s = msg?.sender;
  const realm = realmOk(s?.realm) ? s.realm : null;
  if (s?.auth === "member" && realm && memberOk(s.member?.id)) return { realm, member: s.member.id, label: `member ${nameOk(s.member.name) ? s.member.name : s.member.id}` };
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
 * policy in managed mode, which means "ask" for everyone). Returns "allow", "ask" or "block".
 * First match wins: a block; for unverified senders a blocking policy, else ask; a grant; the default.
 */
export function decide(contacts, k, session) {
  if (!contacts) return "ask";
  if ((contacts.blocks ?? []).some((e) => matches(e, k, session))) return "block";
  if (k.unverified) return contacts.unverified === "block" || contacts.default === "block" ? "block" : "ask";
  if ((contacts.grants ?? []).some((e) => matches(e, k, session))) return "allow";
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
