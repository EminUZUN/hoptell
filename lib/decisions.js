// The decision service (design 3.4): the one authority through which every surface (the CLI, the
// owner UI and the elicitation adapter) shows and decides what waits for the owner, and reads and
// changes settings. A library, not a daemon: each call opens the home's contacts, whose
// operations run the 1.5 recovery (journals, reconciliation) first.
//
// The service takes no lock of its own around a decision. It passes the expected token into the
// native operation, which compares it inside its own lock acquisition and mutates in the same
// one (decideRequest's rev/policy-rev and `check`, updatePins' callback, setPolicy's digest).
// Settings files without a native lock (relays.json, the settings file) are written under one
// settings lock, <home>/settings.lock, with the digest compared again just before the rename.
//
//   list({home, kinds?, sources?, problems?})            -> [{id, kind, summary, created, expires}]
//   show({home, id, sources?, text?})                     -> {id, kind, view, token, nativeToken, actions}
//                                                            | {refused, reason}
//   decide({home, id, action, token, options, sources?})  -> {done, effects} | {stale, view, token}
//                                                            | {refused, reason} | {busy, reason}
//   settings.list / settings.show / settings.set           (below)
//
// Ids are "<kind>:<native id>". A token is opaque to surfaces; the CLI keeps its native forms
// (--rev N --policy-rev P, --set <code>), which the service accepts too.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { NAME_RE, envFiles } from "./config.js";
import { contactsFile, encryptionMode, validateContacts } from "./contacts.js";
import { writeDurable } from "./credentials.js";
import { canonicalize } from "./jcs.js";
import { withLock } from "./locks.js";
import { ALIAS_RE } from "./relays.js";
import { DecisionError, fileDigest, openContacts, staleError } from "./quarantine.js";

/**
 * A12 (lib/mls/own.js settleAwaiting): record a registration the relay's own list shows, before
 * anything is reported. Loaded only with the device decisions, like the rest of mls. A failed write
 * (a busy lock, a full disk) never hides the list: it returns the problem, and the view is shown
 * with it while every confirmation stays blocked until the transition is recorded.
 */
async function settleAwaiting(c, list) {
  try {
    await (await import("./mls/own.js")).settleAwaiting(c, list);
    return null;
  } catch (e) {
    return `what the relay lists of your own devices could not be recorded in your contacts (${e.message}); shown as the relay lists them now, nothing can be confirmed until it is recorded (run the command again)`;
  }
}

const REQ_RE = /^q_[a-z2-7]{16}$/;
const REALM_RE = /^[0-9a-f]{32}$/;
const MEMBER_RE = /^(m_[a-z2-7]{26}|name:[A-Za-z0-9][A-Za-z0-9_-]{0,63})$/;
const DEVICE_RE = /^[a-z2-7]{25}[aeimquy4]$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RELAY_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const SESSION_RE = /^([0-9a-f]{32}|legacy)\/[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const HOWS = ["in-person", "out-of-band"];

/**
 * The kinds, their native ids and the actions and options each allows. Kinds without actions are
 * shown only (v1): the view names the CLI command. decide() checks a request against this table
 * before anything else.
 */
export const KINDS = {
  contact: { id: (n) => REQ_RE.test(n), actions: { allow: ["session"], "allow-once": ["session"], block: [] } },
  "device-verify": { id: (n) => MEMBER_RE.test(n), actions: { verify: ["how"] } },
  "device-accept": { id: (n) => /^[^/]+\/[^/]+$/.test(n) && MEMBER_RE.test(n.split("/")[0]) && DEVICE_RE.test(n.split("/")[1]), actions: { accept: [] } },
  // A1: another device of this home's own member, accepted from an own device (hoptell device accept).
  "device-own": { id: (n) => DEVICE_RE.test(n), actions: { accept: [] } },
  // A4: a pinned device of a contact that the relay no longer lists (hoptell contacts forget-device).
  "device-forget": { id: (n) => /^[^/]+\/[^/]+$/.test(n) && MEMBER_RE.test(n.split("/")[0]) && DEVICE_RE.test(n.split("/")[1]), actions: { forget: [] } },
  // Plaintext held from a contact whose encryption is required (3.3): no decision releases it;
  // the view links to that contact's encryption setting (and the request's block).
  "encryption-violation": { id: (n) => REQ_RE.test(n), actions: {} },
  "contact-request": { id: (n) => RELAY_ID_RE.test(n), actions: {} },
  proposal: { id: (n) => UUID_RE.test(n), actions: {} },
  // An agent profile, new or changed since the owner approved it (design 7.1); token: its digest.
  "agent-profile": { id: (n) => /^[a-z0-9][a-z0-9-]{0,31}$/.test(n), actions: { approve: [] } },
  // A spawn waiting for the owner's confirmation (design 7.1, confirm: "always"); id: the run.
  spawn: { id: (n) => /^r_[0-9a-f]{16}$/.test(n), actions: { start: [], discard: [] } },
};

const refused = (reason) => ({ refused: true, reason });

/** Split an id into its kind and native id; null when it is not one. */
export function parseId(id) {
  const m = /^([a-z-]+):(.{1,200})$/.exec(typeof id === "string" ? id : "");
  if (!m || !Object.hasOwn(KINDS, m[1]) || !KINDS[m[1]].id(m[2])) return null;
  return { kind: m[1], native: m[2] };
}

/** The refusal for an id that is not one: as the native operation words it for a request id. */
const notAnId = (id, decided = false) => {
  const m = /^contact:(.{0,80})/.exec(String(id));
  return refused(m ? `no pending request ${m[1]}${decided ? " (it may have been decided or expired)" : ""}` : `"${String(id).slice(0, 80)}" is not a decision id`);
};

/** Whether `action` and `options` are within what the kind allows; returns a reason or null. */
export function checkRequest(kind, action, options) {
  const allowed = KINDS[kind]?.actions ?? {};
  if (typeof action !== "string" || !Object.hasOwn(allowed, action)) return `"${String(action).slice(0, 40)}" is not an action for ${kind}${Object.keys(allowed).length ? ` (${Object.keys(allowed).join(", ")})` : " (it is shown only; use the command in its view)"}`;
  if (!options || typeof options !== "object" || Array.isArray(options)) return "options must be an object";
  for (const [k, v] of Object.entries(options)) {
    if (v === undefined || v === null) continue;
    if (!allowed[action].includes(k)) return `option "${k.slice(0, 40)}" is not allowed for ${action}`;
    if (k === "session" && !(typeof v === "string" && SESSION_RE.test(v))) return "session must be <realm>/<name> or legacy/<name>";
    if (k === "how" && !HOWS.includes(v)) return "how must be in-person or out-of-band";
  }
  if (action === "verify" && !HOWS.includes(options.how)) return "verify needs how: in-person or out-of-band";
  return null;
}

/** The digest of a view: anything a surface shows is part of the token. */
export const viewDigest = (view) => crypto.createHash("sha256").update(canonicalize(view)).digest("hex").slice(0, 32);

// ---- contact (1.5 quarantined-message requests) --------------------------------------------------

/** The decision view of a contact request: exactly what is shown (not the dropped counter). */
export function contactView(shown) {
  const s = shown.sender;
  return {
    sender: { label: s.label, auth: s.auth, realm: s.realm ?? null, member: s.member ?? null, name: s.name ?? null, relay: s.relay ?? null },
    items: shown.items.map((i) => ({ session: i.session, arrived: i.arrived, bytes: i.bytes })),
    rev: shown.rev,
    policyRevision: shown.policyRevision,
    violation: Boolean(shown.violation),
  };
}
export const contactToken = (view) => `${view.rev}.${view.policyRevision}.${viewDigest(view)}`;

function contactActions(view) {
  const sessions = [...new Set(view.items.map((i) => i.session))];
  const scope = sessions.length > 1 ? { session: sessions } : {};
  // Plaintext from a contact whose encryption is required: only a block (or a change of that
  // contact's encryption setting) ends it.
  if (view.violation) return [{ action: "block", options: {} }];
  return [...(view.sender.auth !== "unverified" ? [{ action: "allow", options: scope }] : []), { action: "allow-once", options: scope }, { action: "block", options: {} }];
}

async function contactShow(c, native, text) {
  const shown = await c.show(native, { text });
  const view = contactView(shown);
  const out = { view, token: contactToken(view), nativeToken: { rev: shown.rev, policyRev: shown.policyRevision }, actions: contactActions(view) };
  if (text) out.text = shown.items.map((i) => ({ session: i.session, arrived: i.arrived, text: i.text ?? null }));
  return out;
}

/** The parts of a contact token: the service form "rev.policyRev.digest" or the CLI's {rev, policyRev}. */
function contactParts(token) {
  if (token && typeof token === "object" && Number.isSafeInteger(token.rev) && Number.isSafeInteger(token.policyRev)) return { rev: token.rev, policyRev: token.policyRev, digest: null };
  const m = /^(\d{1,15})\.(\d{1,15})\.([0-9a-f]{32})$/.exec(typeof token === "string" ? token : "");
  return m ? { rev: Number(m[1]), policyRev: Number(m[2]), digest: m[3] } : null;
}

// ---- device-verify and device-accept (3.2, experimental) -----------------------------------------

function deviceArgs(kind, native) {
  return kind === "device-verify" ? { sub: "verify", member: native, device: null } : { sub: kind === "device-forget" ? "forget-device" : "accept-device", member: native.split("/")[0], device: native.split("/")[1] };
}

// ---- device-own (A1): accept another device of this home's own member ----------------------------

async function ownShow(c, sources, native) {
  if (!sources.devices?.own) return refused("own-device decisions need the relay's list of your devices (experimental device keys, a reachable relay)");
  const { ownDeviceDecision } = await import("./mls/cli.js");
  let own;
  try {
    own = await sources.devices.own();
  } catch (e) {
    return refused(`the device list cannot be checked: ${e.message}`);
  }
  const unrecorded = await settleAwaiting(c, own.list); // A12: a registered awaiting pin is recorded first
  const d = ownDeviceDecision({ device: native, list: own.list, thisDevice: own.thisDevice, doc: c.currentPolicy().doc, pending: own.pending ?? null });
  if (unrecorded) d.view.unrecorded = unrecorded;
  return { view: d.view, token: `${d.code}.${viewDigest(d.view)}`, nativeToken: d.code, actions: d.view.waiting && !unrecorded ? [{ action: "accept", options: {} }] : [] };
}

async function ownDecide(c, sources, native, token) {
  if (!sources.devices?.own) return refused("own-device decisions need the relay's list of your devices (experimental device keys, a reachable relay)");
  const m = /^([0-9a-f]{32})(?:\.([0-9a-f]{32}))?$/.exec(typeof token === "string" ? token : "");
  if (!m) return refused("the token is not one this service issued");
  const [, code, digest = null] = m;
  const { ownDeviceDecision } = await import("./mls/cli.js");
  const { acceptOwn, addApproval } = await import("./mls/own.js");
  let own;
  try {
    own = await sources.devices.own();
  } catch (e) {
    return refused(`the device list cannot be checked: ${e.message}`);
  }
  const unrecorded = await settleAwaiting(c, own.list); // A12
  if (unrecorded) return refused(unrecorded);
  const make = (doc) => ownDeviceDecision({ device: native, list: own.list, thisDevice: own.thisDevice, doc, pending: own.pending ?? null });
  const matches = (d) => d.code === code && (digest === null || viewDigest(d.view) === digest);
  const stale = () => {
    const d = make(c.currentPolicy().doc);
    return { stale: true, view: d.view, token: `${d.code}.${viewDigest(d.view)}`, nativeToken: d.code };
  };
  const first = make(c.currentPolicy().doc);
  if (!matches(first)) return stale();
  if (first.view.refusal) return refused(first.view.refusal);
  if (!first.view.waiting) return refused(`device ${native} of yours is not waiting for a decision (${first.view.state})`);
  // A12: a pending request is approved with a statement this device signs before the one contacts
  // write that records the pin and the approval outbox entry together (signing changes no state).
  let approval = null;
  if (first.target.pending) {
    if (!own.sign) return refused(`device ${native} of yours is not registered yet: approve it with hoptell device accept ${native}`);
    approval = await own.sign(first.target);
  }
  try {
    await c.updatePins((doc) => {
      const now = make(doc);
      if (!matches(now)) throw staleError("the devices or the pins changed since they were shown");
      // A12: a device accepted from its pending request is marked awaiting until the relay lists it.
      if (!doc.own?.[now.realm]?.devices.some((d) => d.device === native)) acceptOwn(doc, now.realm, now.target, { by: own.thisDevice, now: Date.now(), awaiting: Boolean(approval) });
      // The request instance it approves (the relay's `requested`), so a renewal is never re-signed for.
      if (approval) addApproval(doc, now.realm, { device: native, key: approval.key, approval, at: Date.now(), ...(Number.isSafeInteger(now.target.requested) && now.target.requested >= 0 ? { requested: now.target.requested } : {}) });
    });
    return { done: true, effects: { decisions: [{ device: native, decision: first.view.already ? "approved own device again" : "accepted own device", new: first.view.fingerprint }], pinned: [], ...(approval ? { approval: true } : {}) } };
  } catch (e) {
    if (e instanceof DecisionError && e.code === "stale") return stale();
    if (e.code === "key_changed" || e.code === "too_many" || e.code === "not_own") return refused(e.message);
    throw e;
  }
}

async function deviceShow(c, sources, kind, native) {
  if (kind === "device-own") return ownShow(c, sources, native);
  if (!sources.devices) return refused("device decisions need the relay's device lists (experimental device keys, a reachable relay)");
  const { deviceDecision } = await import("./mls/cli.js");
  const a = deviceArgs(kind, native);
  let lists;
  try {
    lists = await sources.devices.fetch(a.member);
  } catch (e) {
    return refused(`the device list cannot be checked: ${e.message}`);
  }
  const unrecorded = await settleAwaiting(c, lists.mine); // A12: a registered awaiting own pin is recorded first
  const d = deviceDecision({ ...a, ...lists, doc: c.currentPolicy().doc });
  if (unrecorded) d.view.unrecorded = unrecorded;
  // A1: an own device not accepted refuses verify and accept-device; a missing pinned device
  // refuses verify (A4: forget-device decides it).
  const waiting = kind === "device-forget" ? d.view.target.waiting : d.view.refusal ? false : kind === "device-verify" ? !d.view.empty && !d.view.blocked : d.view.target.waiting;
  const actions = !waiting || unrecorded ? [] : kind === "device-verify" ? [{ action: "verify", options: { how: HOWS } }] : kind === "device-forget" ? [{ action: "forget", options: {} }] : [{ action: "accept", options: {} }];
  return { view: d.view, token: `${d.code}.${viewDigest(d.view)}`, nativeToken: d.code, actions };
}

async function deviceDecide(c, sources, kind, native, action, token, options) {
  if (kind === "device-own") return ownDecide(c, sources, native, token);
  if (!sources.devices) return refused("device decisions need the relay's device lists (experimental device keys, a reachable relay)");
  const m = /^([0-9a-f]{32})(?:\.([0-9a-f]{32}))?$/.exec(typeof token === "string" ? token : "");
  if (!m) return refused("the token is not one this service issued");
  const [, code, digest = null] = m;
  const { deviceDecision } = await import("./mls/cli.js");
  const { b64 } = await import("./mls/identity.js");
  const { decide: pin, forgetDevice } = await import("./mls/trust.js");
  const a = deviceArgs(kind, native);
  let lists;
  try {
    lists = await sources.devices.fetch(a.member);
  } catch (e) {
    return refused(`the device list cannot be checked: ${e.message}`);
  }
  const unrecorded = await settleAwaiting(c, lists.mine); // A12: a registered awaiting own pin is recorded first
  if (unrecorded) return refused(unrecorded);
  const matches = (d) => d.code === code && (digest === null || viewDigest(d.view) === digest);
  const stale = () => {
    const d = deviceDecision({ ...a, ...lists, doc: c.currentPolicy().doc });
    return { stale: true, view: d.view, token: `${d.code}.${viewDigest(d.view)}`, nativeToken: d.code };
  };
  const first = deviceDecision({ ...a, ...lists, doc: c.currentPolicy().doc });
  if (!matches(first)) return stale();
  if (first.view.refusal && kind !== "device-forget") return refused(first.view.refusal);
  if (kind === "device-forget" && !first.view.target.waiting) return refused(`device ${a.device} of ${a.member} is not missing: the relay still lists it (or it is not pinned)`);
  if (kind === "device-verify" && first.view.blocked) return refused(`nothing is pinned: ${first.view.blocked}`);
  if (kind === "device-accept" && !first.view.target.waiting) return refused(`device ${a.device} of ${a.member} is not waiting for a decision`);
  if (first.view.empty) return refused(`member ${a.member} has no enrolled devices you can see`);
  let shown;
  try {
    const { result } = await c.updatePins((doc) => {
      // Under the contacts lock: the pins are still those the token was made from.
      const now = deviceDecision({ ...a, ...lists, doc });
      if (!matches(now)) throw staleError("the devices or the pins changed since they were shown");
      shown = now;
      if (kind === "device-forget") return { decisions: [forgetDevice(doc, now.realm, a.member, a.device, now.ev)] };
      return pin(doc, now.realm, a.member, now.ev, { accept: kind === "device-verify" ? "all" : [a.device], how: action === "verify" ? options.how : null });
    });
    return { done: true, effects: { decisions: result.decisions, pinned: shown.ev.active.map((d) => b64(d.pin)) } };
  } catch (e) {
    if (e instanceof DecisionError && e.code === "stale") return stale();
    if (e.code === "revocations_full") return refused(e.message);
    throw e;
  }
}

// ---- spawn (design 7.1, "Owner confirmation") --------------------------------------------------------

/**
 * A pending spawn: the profile id and digest, mode, name, cwd, the generated command line, the
 * task in full, the spawner. Token: spawnToken over the profile's current digest and the spawn.
 * `sources.agents`: {homedir, env (the environment the supervisor's is built from), surface, deps}.
 */
async function spawnShow(home, id, native, sources) {
  const { readRun, runPaths } = await import("./agentruns.js");
  const { readProfile, readPrivateFile, readApproved, approvalOf, sha256 } = await import("./agents.js");
  const { spawnToken } = await import("./agentspawn.js");
  const { shellLine } = await import("./agentadapters.js");
  const rec = readRun(home, native);
  if (!rec || rec.state !== "pending-confirmation") return refused(`run ${native} is not waiting for a confirmation`);
  const read = readProfile(home, rec.profile, { homedir: sources.agents?.homedir ?? null, env: sources.agents?.env ?? null, relaysFile: rec.ownerRelays ?? null, ...(sources.agents?.deps?.gates ? { gates: sources.agents.deps.gates } : {}) });
  const approved = !read.problems.length && read.digest === rec.profileDigest && approvalOf(read, readApproved(home)) === "approved";
  const t0 = readPrivateFile(runPaths(home, native).task, rec.limits?.taskBytes ?? 32768);
  // The owner sees only the task the spawn was made with (its digest), never a later file.
  const t = t0.problem || sha256(t0.bytes) === rec.taskDigest ? t0 : { problem: "not the one the spawn was made with" };
  const plan = rec.mode === "tmux" ? rec.plan?.cli : rec.plan;
  const view = {
    run: rec.run,
    profile: rec.profile,
    profileDigest: rec.profileDigest,
    profileState: approved ? "approved" : read.missing ? "missing" : "changed or no longer approved",
    mode: rec.mode,
    ...(rec.plan?.mode ? { headlessMode: rec.plan.mode } : {}),
    name: rec.name,
    roles: rec.roles,
    cwd: rec.cwd,
    wireNames: rec.wireNames,
    spawner: rec.spawner?.name ?? null,
    commandLine: plan ? `${shellLine(plan.command, plan.args)}${rec.mode === "headless" ? " < task" : ""}` : null,
    task: t.problem ? null : t.bytes.toString("utf8"),
    taskProblem: t.problem ?? null,
    expires: rec.pendingUntil ?? null,
    command: `hoptell agents confirm ${rec.run}`,
  };
  return { id, kind: "spawn", view, token: spawnToken(rec, read.digest), nativeToken: null, actions: [...(approved && !t.problem ? [{ action: "start", options: {} }] : []), { action: "discard", options: {} }] };
}

async function spawnDecide(home, id, native, action, token, sources) {
  const { audit } = await import("./agents.js");
  const { startConfirmed, discardPending } = await import("./agentspawn.js");
  const shown = await spawnShow(home, id, native, sources);
  if (shown.refused) return shown;
  if (typeof token !== "string" || token !== shown.token) return { stale: true, view: shown.view, token: shown.token, nativeToken: null };
  const surface = sources.agents?.surface ?? "cli";
  const refuseStart = (code, reason) => {
    if (action === "start") audit(home, "confirm-refused", { run: native, decision: id, surface, error: code, reason });
    return refused(reason);
  };
  if (shown.view.expires && Date.parse(shown.view.expires) < Date.now()) return refuseStart("failed", `the spawn ${native} expired; it is discarded at the next sweep`);
  if (action === "discard") {
    const r = await discardPending(home, native);
    if (r.error) return refused(r.message);
    audit(home, "discarded", { run: native, decision: id, surface });
    return { done: true, effects: { run: native, state: "discarded" } };
  }
  if (!shown.actions.some((a) => a.action === "start")) return refuseStart(shown.view.profileState === "approved" ? "failed" : "profile_not_approved", `the spawn ${native} cannot start: its profile is ${shown.view.profileState}${shown.view.taskProblem ? `, its task is ${shown.view.taskProblem}` : ""}`);
  // `confirmed` is written once the run moved to starting; a refused start writes confirm-refused.
  const r = await startConfirmed(home, native, { env: sources.agents?.env ?? {}, deps: sources.agents?.deps ?? {}, homedir: sources.agents?.homedir ?? null, auditAs: { decision: id, surface } });
  if (r.error) return refused(`${r.error}: ${r.message}`);
  return { done: true, effects: r };
}

// ---- agent-profile (design 7.1) -----------------------------------------------------------------

/**
 * The approval's context: the environment and owner relays file a hardened profile's deny roots
 * are resolved from (the surface's own, else this process's), and the gates (tests: deps.gates).
 */
async function approvalContext(sources) {
  const a = sources.agents ?? {};
  const { ownerRelaysFile } = await import("./agentdeny.js");
  const env = a.env ?? process.env;
  return { homedir: a.homedir ?? null, env, relaysFile: a.relaysFile ?? ownerRelaysFile(env, a.homedir ?? null), ...(a.deps?.gates ? { gates: a.deps.gates } : {}) };
}

/** `sources.agents`: {homedir, env, relaysFile, commandLines(profile), deps} (tests and the CLI); the defaults otherwise. */
async function agentProfileShow(home, id, native, sources) {
  const { profileView } = await import("./agents.js");
  const { commandLines } = await import("./agentadapters.js");
  const { BIN } = await import("./config.js");
  const ctx = await approvalContext(sources);
  const v = profileView(home, native, { commandLines: (p) => commandLines(p, { node: process.execPath, bin: BIN, ...(ctx.gates ? { gates: ctx.gates } : {}) }), ...(sources.agents ?? {}), ...ctx });
  if (!v) return refused(`no agent profile ${native}`);
  const waiting = v.view.state === "unapproved" || v.view.state === "changed";
  return { id, kind: "agent-profile", view: v.view, token: v.read.digest, nativeToken: v.read.digest, actions: waiting ? [{ action: "approve", options: {} }] : [] };
}

/**
 * Approve: under the agents lock the file is read again and its digest compared with the token,
 * then approved.json is written in the same acquisition. A changed file is `stale`.
 */
async function agentProfileDecide(home, native, token, sources) {
  const { profileView, withAgentsLock, writeApproved, audit } = await import("./agents.js");
  if (typeof token !== "string" || !/^[0-9a-f]{64}$/.test(token)) return refused("the token is not one this service issued");
  const ctx = await approvalContext(sources);
  try {
    return await withAgentsLock(home, () => {
      const v = profileView(home, native, { ...(sources.agents ?? {}), ...ctx });
      if (!v) return refused(`no agent profile ${native}`);
      if (v.read.digest !== token) return { stale: true, view: v.view, token: v.read.digest, nativeToken: v.read.digest };
      if (v.view.state === "invalid") return refused(`agent profile ${native} is invalid: ${v.read.problems.join("; ")}`);
      // A headless mode that is not offered or not gated now is never approved.
      if (v.view.modeRefusal) return refused(`${v.view.modeRefusal}: agent profile ${native} asks for headless mode ${v.view.headlessMode}, which is not available on this hoptell (its gate has not passed, or it is not offered)`);
      if (v.view.state === "approved") return refused(`agent profile ${native} is already approved with this digest`);
      writeApproved(home, native, token);
      audit(home, "profile-approved", { id: native, digest: token });
      return { done: true, effects: { id: native, digest: token } };
    });
  } catch (e) {
    if (e?.code === "busy") return { busy: true, reason: "another hoptell process holds the agents lock; try again" };
    throw e;
  }
}

// ---- show-only kinds ------------------------------------------------------------------------------

async function contactRequests(sources) {
  const rows = await sources.relay.contactRequests();
  // The display name is the relay's: kept as text, bounded.
  return rows.map((r) => ({ id: String(r.id), from: String(r.from), name: String(r.name ?? "").slice(0, 64), reason: String(r.reason), at: Number(r.at) }));
}

async function proposals(home) {
  const { listPending } = await import("./apply.js");
  return listPending(home);
}

// ---- the service ------------------------------------------------------------------------------------

/** The opened contacts manager: the caller's, or this home's (no notifications). */
const contactsFor = (home, sources) => sources.contacts ?? openContacts(home, { notify: false, ...(sources.contactsOptions ?? {}) });

/** Map the native refusals: a stale token, a busy lock, an owner-facing refusal. */
async function guarded(fn, onStale) {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof DecisionError) return e.code === "stale" ? onStale(e) : refused(e.message);
    if (e?.code === "busy") return { busy: true, reason: "another hoptell process holds the lock; try again" };
    throw e;
  }
}

/**
 * Everything waiting for the owner, oldest first. Kinds whose source is missing or unreachable
 * are left out, with a note in `problems`.
 */
export async function list({ home, kinds = null, sources = {}, problems = [] }) {
  const want = (k) => !kinds || kinds.includes(k);
  const out = [];
  if (want("agent-profile")) {
    try {
      const { pendingProfiles } = await import("./agents.js");
      for (const p of pendingProfiles(home, { homedir: sources.agents?.homedir ?? null })) out.push({ id: `agent-profile:${p.id}`, kind: "agent-profile", summary: `agent profile ${p.id} ${p.state === "changed" ? "changed since you approved it" : "is not approved yet"}`, created: null, expires: null });
    } catch (e) {
      problems.push(`agent profiles: ${e.message}`);
    }
  }
  if (want("spawn")) {
    try {
      const { pendingSpawns } = await import("./agentspawn.js");
      for (const r of pendingSpawns(home)) out.push({ id: `spawn:${r.run}`, kind: "spawn", summary: `spawn of ${r.name} (profile ${r.profile}, ${r.mode}) asked by ${r.spawner?.name ?? "a session"}`, created: r.created, expires: r.pendingUntil ?? null });
    } catch (e) {
      problems.push(`agent spawns: ${e.message}`);
    }
  }
  if (kinds && !kinds.some((k) => k !== "agent-profile" && k !== "spawn")) return out;
  const c = await contactsFor(home, sources);
  if (want("contact") || want("encryption-violation")) {
    const st = await c.status();
    for (const r of st.requests) {
      const kind = r.violation ? "encryption-violation" : "contact";
      if (!want(kind)) continue;
      out.push({ id: `${kind}:${r.id}`, kind, summary: `${r.sender.label}: ${r.items} ${r.violation ? "unencrypted message(s), but encryption is required," : "message(s)"} for ${r.sessions.join(", ")}`, created: r.created, expires: new Date(r.expires).toISOString() });
    }
  }
  if ((want("device-accept") || want("device-verify")) && sources.devices) {
    // New devices and key changes of pinned contacts; leaving them undecided keeps traffic stopped.
    const { deviceDecision } = await import("./mls/cli.js");
    const doc = c.currentPolicy().doc;
    for (const p of doc?.pins ?? []) {
      try {
        const lists = await sources.devices.fetch(p.member);
        if (lists.theirs.realm !== p.realm) continue;
        const unrecorded = await settleAwaiting(c, lists.mine); // A12
        if (unrecorded) problems.push(unrecorded);
        const d = deviceDecision({ sub: "verify", member: p.member, ...lists, doc: c.currentPolicy().doc });
        for (const x of d.view.devices.filter((y) => y.state !== "pinned")) {
          if (want("device-accept")) out.push({ id: `device-accept:${p.member}/${x.device}`, kind: "device-accept", summary: `${x.state === "new" ? "new device" : "key change"} ${x.device} of ${p.member}`, created: null, expires: null });
        }
      } catch (e) {
        problems.push(`devices of ${p.member}: ${e.message}`);
      }
    }
  }
  if (want("contact-request") && sources.relay) {
    try {
      for (const r of await contactRequests(sources)) out.push({ id: `contact-request:${r.id}`, kind: "contact-request", summary: `contact request from member ${r.from} (${r.reason})`, created: new Date(r.at).toISOString(), expires: null });
    } catch (e) {
      problems.push(`contact requests at the relay: ${e.message}`);
    }
  }
  if (want("proposal")) {
    try {
      for (const p of await proposals(home)) out.push({ id: `proposal:${p.proposal_id}`, kind: "proposal", summary: `proposal from ${p.from}: ${p.files.length} file(s)`, created: p.received, expires: null });
    } catch (e) {
      problems.push(`proposals: ${e.message}`);
    }
  }
  return out.sort((a, b) => String(a.created ?? "~").localeCompare(String(b.created ?? "~")));
}

/** One decision with its view, token and the actions (with their allowed options) it offers. */
export async function show({ home, id, sources = {}, text = false }) {
  const p = parseId(id);
  if (!p) return notAnId(id);
  if (p.kind === "agent-profile") return agentProfileShow(home, id, p.native, sources);
  if (p.kind === "spawn") return spawnShow(home, id, p.native, sources);
  const c = await contactsFor(home, sources);
  const r = await guarded(
    async () => {
      if (p.kind === "contact") return contactShow(c, p.native, text);
      if (p.kind === "encryption-violation") {
        const r = await contactShow(c, p.native, false);
        if (!r.view.violation) return refused(`request ${p.native} is no longer an encryption violation: hoptell contacts show ${p.native}`);
        const s = r.view.sender;
        const view = { ...r.view, setting: `encryption.${s.realm}.${s.member}`, request: `contact:${p.native}`, command: `hoptell contacts encryption ${s.member} preferred|off` };
        return { view, token: `${r.view.policyRevision}.${viewDigest(view)}`, nativeToken: null, actions: [] };
      }
      if (["device-verify", "device-accept", "device-own", "device-forget"].includes(p.kind)) return deviceShow(c, sources, p.kind, p.native);
      if (p.kind === "contact-request") {
        if (!sources.relay) return refused("contact requests are kept at the relay, which this view cannot reach");
        const r = (await contactRequests(sources)).find((x) => x.id === p.native);
        if (!r) return refused(`no contact request ${p.native}`);
        return { view: { ...r, command: `hoptell contacts requests accept|deny|deny-forever ${r.id}` }, token: null, nativeToken: null, actions: [] };
      }
      const r = (await proposals(home)).find((x) => x.proposal_id === p.native);
      if (!r) return refused(`no proposal ${p.native} is waiting`);
      return { view: { ...r, command: `hoptell apply ${r.proposal_id} --preview` }, token: null, nativeToken: null, actions: [] };
    },
    (e) => refused(e.message),
  );
  return r.refused || r.busy ? r : { id, kind: p.kind, ...r };
}

/**
 * Decide: the action and options are checked against the kind first (refused, nothing written),
 * then the native operation compares the token inside its own lock and mutates in the same
 * acquisition. A mismatch is `stale` with the current view and token; nothing is written.
 */
export async function decide({ home, id, action, token, options = {}, sources = {} }) {
  const p = parseId(id);
  if (!p) return notAnId(id, true);
  const bad = checkRequest(p.kind, action, options ?? {});
  if (bad) return refused(bad);
  if (p.kind === "agent-profile") return agentProfileDecide(home, p.native, token, sources);
  if (p.kind === "spawn") return spawnDecide(home, id, p.native, action, token, sources);
  const c = await contactsFor(home, sources);
  if (p.kind === "contact") {
    const t = contactParts(token);
    if (!t) return refused("the token is not one this service issued");
    const onStale = async () => {
      const again = await guarded(() => contactShow(c, p.native, false), (e) => refused(e.message));
      return again.refused || again.busy ? again : { stale: true, view: again.view, token: again.token, nativeToken: again.nativeToken };
    };
    return guarded(async () => {
      const o = { rev: t.rev, policyRev: t.policyRev, session: options.session ?? null };
      // The view the token was made from is compared under the contacts lock too.
      if (t.digest) o.check = (shown) => {
        if (viewDigest(contactView(shown)) !== t.digest) throw staleError(`request ${p.native} changed since it was shown`);
      };
      const r = await (action === "allow" ? c.allow(p.native, o) : action === "allow-once" ? c.allowOnce(p.native, o) : c.block(p.native, o));
      return { done: true, effects: r };
    }, onStale);
  }
  return guarded(() => deviceDecide(c, sources, p.kind, p.native, action, token, options), (e) => refused(e.message));
}

// ---- settings -----------------------------------------------------------------------------------------

/**
 * The settings context: `env` (the process environment after loadEnv), `fromFile` (the variables
 * loadEnv took from the settings file), `envFile` (that file, or the first candidate), and the
 * relays file. bin/hoptell.js builds it; tests pass their own.
 */
export function settingsContext({ env, fromFile, envFile = null, relaysFile }) {
  // Encryption settings are experimental (3.3), offered with HOPTELL_EXPERIMENTAL_E2EE=1 only.
  const experimental = /^(1|true|on|yes)$/i.test(String(env.HOPTELL_EXPERIMENTAL_E2EE ?? "").trim());
  return { env, fromFile: new Set(fromFile ?? []), envFile: envFile ?? envFiles()[0], relaysFile, experimental };
}

/**
 * One read of a settings file: its text and the digest of exactly those bytes. A key's value,
 * allowed set and token all come from one snapshot, so a token never vouches for bytes other
 * than the ones the value was read from.
 */
function snapshotOf(file) {
  let bytes;
  try {
    bytes = fs.readFileSync(file);
  } catch (e) {
    if (e.code === "ENOENT") return { text: null, token: "none" };
    return { text: null, token: `unreadable:${e.code ?? "error"}` };
  }
  return { text: bytes.toString("utf8"), token: crypto.createHash("sha256").update(bytes).digest("hex") };
}

/** A valid contacts policy from a snapshot's text, else null. */
function policyOf(text) {
  if (text === null) return null;
  try {
    const doc = JSON.parse(text);
    return validateContacts(doc).length ? null : doc;
  } catch {
    return null;
  }
}

const relaysDoc = (text) => {
  try {
    return text === null ? null : JSON.parse(text);
  } catch {
    return null;
  }
};

/** Parse KEY=VALUE from a settings file's text as loadEnv does (the first non-empty value wins). */
function envValue(text, key) {
  for (const line of (text ?? "").split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || m[1] !== key) continue;
    let v = m[2];
    if (/^".*"$/.test(v)) {
      try {
        v = JSON.parse(v);
      } catch {
        v = v.slice(1, -1);
      }
    } else if (/^'.*'$/.test(v)) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, "");
    if (v) return v;
  }
  return "";
}

/** Members with a held request (as the relay authenticated them): their own settings are offered too. */
function pendingMembers(home) {
  const dir = path.join(home, "contacts", "requests");
  const out = [];
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((f) => REQ_RE.test(f.slice(0, -5)));
  } catch {
    return out;
  }
  for (const f of names) {
    try {
      const s = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")).sender;
      if (s?.auth === "member" && REALM_RE.test(s.realm ?? "") && MEMBER_RE.test(s.member ?? "")) out.push({ realm: s.realm, member: s.member });
    } catch {}
  }
  return out;
}

/** The settings keys this version offers, with their source file, allowed values, token and effect. */
function keysOf(home, ctx) {
  const keys = [];
  const cfile = contactsFile(home);
  const csnap = snapshotOf(cfile);
  const policy = policyOf(csnap.text);
  const onContacts = (k) => keys.push({ file: cfile, kind: "contacts", token: csnap.token, effect: "next policy read", ...k });
  onContacts({ key: "contacts.default", value: policy?.default ?? null, allowed: { enum: ["ask", "allow", "block"] }, widens: (from, to) => rank.default[to] > rank.default[from] });
  onContacts({ key: "contacts.unverified", value: policy ? (policy.unverified ?? "ask") : null, allowed: { enum: ["ask", "block"] }, widens: (from, to) => from === "block" && to === "ask" });
  if (policy && ctx.experimental) {
    // Per-contact encryption (3.3, experimental): the contacts the policy names (grants, pins and
    // existing entries) and members whose messages are held (a realm default can hold them).
    // Lowering a contact's encryption widens access.
    const contacts = new Map();
    for (const e of [...(policy.grants ?? []), ...(policy.pins ?? []), ...(policy.encryption ?? []), ...pendingMembers(home)]) if (e.member && e.realm) contacts.set(`${e.realm}.${e.member}`, { realm: e.realm, member: e.member });
    for (const [id, { realm, member }] of contacts) {
      const own = (policy.encryption ?? []).find((e) => e.realm === realm && e.member === member)?.mode;
      onContacts({ key: `encryption.${id}`, encryption: { realm, member }, value: own ?? encryptionMode(policy, realm, member), inherited: own === undefined, allowed: { enum: ["off", "preferred", "required"] }, widens: (from, to) => rank.encryption[to] < rank.encryption[from] });
    }
    // requireVerified (3.2, experimental): per realm (every contact there must be verified) and
    // per pinned contact. Turning it off widens access.
    const realms = new Set([...(policy.requireVerified ?? []), ...(policy.pins ?? []).map((p) => p.realm)]);
    for (const realm of realms) onContacts({ key: `verified.${realm}`, verified: { realm }, value: String((policy.requireVerified ?? []).includes(realm)), allowed: { enum: ["true", "false"] }, widens: (from, to) => from === "true" && to === "false" });
    for (const p of policy.pins ?? []) {
      const realmWide = (policy.requireVerified ?? []).includes(p.realm);
      // Enforced is the contact's flag OR the realm's requirement: with the realm requiring it,
      // turning the contact's flag off changes nothing, so it is not marked as widening.
      const own = Boolean(p.requireVerified);
      onContacts({
        key: `verified.${p.realm}.${p.member}`,
        verified: { realm: p.realm, member: p.member },
        value: String(own),
        ...(realmWide ? { note: "the realm requires it for every contact", related: `verified.${p.realm}` } : {}),
        effective: { value: String(own || realmWide), why: realmWide ? `required by the realm (verified.${p.realm})${own ? " and by this contact's flag" : ""}` : own ? "required by this contact's flag" : "not required" },
        allowed: { enum: ["true", "false"] },
        widens: (from, to) => !realmWide && from === "true" && to === "false",
      });
    }
  }
  const esnap = snapshotOf(ctx.envFile);
  const rootsFromEnv = Boolean(ctx.env.HOPTELL_SNAPSHOT_ROOTS) && !ctx.fromFile.has("HOPTELL_SNAPSHOT_ROOTS");
  keys.push({
    key: "files.roots",
    file: ctx.envFile,
    kind: "env",
    token: esnap.token,
    variable: "HOPTELL_SNAPSHOT_ROOTS",
    fromEnv: rootsFromEnv,
    value: rootsFromEnv ? ctx.env.HOPTELL_SNAPSHOT_ROOTS : envValue(esnap.text, "HOPTELL_SNAPSHOT_ROOTS"),
    allowed: { form: "roots" },
    widens: rootsWiden,
    effect: "session restart",
  });
  const rsnap = snapshotOf(ctx.relaysFile);
  const doc = relaysDoc(rsnap.text);
  if (doc && Array.isArray(doc.relays)) {
    const onRelays = (k) => keys.push({ file: ctx.relaysFile, kind: "relays", token: rsnap.token, effect: "engine restart", ...k });
    const aliases = doc.relays.map((r) => r?.alias).filter((a) => typeof a === "string" && ALIAS_RE.test(a));
    onRelays({ key: "relays.default", value: typeof doc.default === "string" ? doc.default : "", allowed: { enum: ["", ...aliases] }, widens: () => false });
    for (const a of aliases) {
      const r = doc.relays.find((x) => x?.alias === a);
      onRelays({ key: `relays.${a}.join`, value: r.join === false ? "false" : "true", allowed: { enum: ["true", "false"] }, widens: (from, to) => from === "false" && to === "true" });
      onRelays({ key: `relays.${a}.name`, value: typeof r.name === "string" ? r.name : "", allowed: { form: "name" }, widens: () => false });
    }
  }
  return keys;
}
/** A key's provenance note: an inherited value, or what else decides it. */
const noteOf = (k) => (k.inherited ? { note: "from the realm's default" } : k.note ? { note: k.note } : {});

const rank = { default: { block: 0, ask: 1, allow: 2 }, encryption: { off: 0, preferred: 1, required: 2 } };

/** Roots widen access when a folder is added or an id points somewhere else. */
function rootsWiden(from, to) {
  const parse = (v) => {
    try {
      return JSON.parse(v || "[]");
    } catch {
      return [];
    }
  };
  const before = new Set(parse(from).map((r) => `${r.id}\0${r.path}`));
  return parse(to).some((r) => !before.has(`${r.id}\0${r.path}`));
}

/** Whether `value` is in the key's allowed set; returns a reason or null. */
async function checkValue(k, value) {
  if (typeof value !== "string" || value.length > 16 * 1024) return "the value must be text up to 16 KB";
  if (k.allowed.enum) return k.allowed.enum.includes(value) ? null : `${k.key} must be one of ${k.allowed.enum.map((v) => (v === "" ? '"" (none)' : v)).join(", ")}`;
  if (k.allowed.form === "name") return value === "" || NAME_RE.test(value) ? null : `${k.key} must be a peer name (or empty for none)`;
  if (k.allowed.form === "roots") {
    const { parseRoots } = await import("./files.js");
    try {
      parseRoots(value);
      return null;
    } catch (e) {
      return e.message;
    }
  }
  return "unknown value form";
}

const tokenOf = (file) => fileDigest(file) ?? "none";

/**
 * Sessions that run with an older value of a file read at their start: the live MCP servers with
 * a hook registration (lib/wake.js) that started before the file last changed. Sessions without
 * a registration are not known here.
 */
async function restartList(file, home) {
  let mtime;
  try {
    mtime = fs.statSync(file).mtimeMs;
  } catch {
    return [];
  }
  const { hookSessions } = await import("./wake.js");
  return hookSessions(home)
    .filter((s) => s.live && s.started !== null && s.started < mtime)
    .map((s) => s.peer);
}

export const settings = {
  /** Every key: its effective value and source, whether it can be written, and who must restart. */
  async list({ home, ctx }) {
    const out = [];
    for (const k of keysOf(home, ctx)) {
      out.push({
        key: k.key,
        value: k.value,
        source: k.fromEnv ? `environment (${k.variable})` : k.file,
        writable: !k.fromEnv && k.value !== null,
        effect: k.effect,
        ...noteOf(k),
        restart: k.kind === "contacts" ? [] : await restartList(k.file, home),
      });
    }
    return out;
  },

  /** One key, with its compare-and-set token and allowed set; null for an unknown key. */
  show({ home, ctx, key }) {
    const k = keysOf(home, ctx).find((x) => x.key === key);
    if (!k) return null;
    return {
      key: k.key,
      value: k.value,
      source: k.fromEnv ? `environment (${k.variable})` : k.file,
      writable: !k.fromEnv && k.value !== null,
      token: k.token,
      allowed: k.allowed,
      effect: k.effect,
      widening: k.allowed.enum ? k.allowed.enum.filter((v) => k.widens(k.value, v)) : null,
      ...noteOf(k),
      ...(k.related ? { related: k.related } : {}),
      ...(k.effective ? { effective: k.effective } : {}),
    };
  },

  /** Whether changing `key` to `value` widens access (shown as information, one confirmation). */
  widens({ home, ctx, key, value }) {
    const k = keysOf(home, ctx).find((x) => x.key === key);
    return Boolean(k && k.widens(k.value, value));
  },

  /**
   * Set `key` to `value`, compare-and-set on the file's digest `token`: the value is checked
   * against the allowed set first (refused, nothing written); then, in one lock acquisition, the
   * digest is compared and the file written. `stale` returns the current value and token.
   */
  async set({ home, ctx, key, value, token, sources = {} }) {
    const k = keysOf(home, ctx).find((x) => x.key === key);
    if (!k) return refused(`no setting "${String(key).slice(0, 80)}"`);
    if (k.fromEnv) return refused(`${k.key} comes from the environment variable ${k.variable}; change it there (and restart the sessions)`);
    const bad = await checkValue(k, value);
    if (bad) return refused(bad);
    if (typeof token !== "string") return refused("the token is missing");
    const stale = () => {
      const now = keysOf(home, ctx).find((x) => x.key === key);
      return { stale: true, value: now?.value ?? null, token: now?.token ?? tokenOf(k.file) };
    };
    if (k.kind === "contacts") {
      if (k.value === null) return refused("the contacts policy is missing or damaged; fix it first (hoptell doctor)");
      const c = await contactsFor(home, sources);
      return guarded(async () => {
        await c.setPolicy(token === "none" ? null : token, (doc) => {
          if (k.verified?.member) {
            const pin = (doc.pins ?? []).find((p) => p.realm === k.verified.realm && p.member === k.verified.member);
            if (!pin) throw new DecisionError(`${k.verified.member} is no longer pinned`);
            if (value === "true") pin.requireVerified = true;
            else delete pin.requireVerified;
          } else if (k.verified) {
            const list = (doc.requireVerified ?? []).filter((r) => r !== k.verified.realm);
            if (value === "true") list.push(k.verified.realm);
            if (list.length) doc.requireVerified = list;
            else delete doc.requireVerified;
          } else if (k.encryption) {
            // The contact's own entry, as hoptell contacts encryption writes it.
            const { realm, member } = k.encryption;
            doc.encryption = [...(doc.encryption ?? []).filter((e) => !(e.realm === realm && e.member === member)), { realm, member, mode: value }];
          } else doc[key === "contacts.default" ? "default" : "unverified"] = value;
        });
        return { done: true, restart: [] };
      }, stale);
    }
    const lockBase = path.join(home, "settings"); // withLock takes <home>/settings.lock
    try {
      return await withLock(lockBase, async () => {
        if (tokenOf(k.file) !== token) return stale();
        const text = k.kind === "relays" ? relaysText(k.file, key, value) : envText(k.file, k.variable, value);
        if (Buffer.byteLength(text) > 64 * 1024) return refused(`${k.file} would be larger than 64 KB`);
        fs.mkdirSync(path.dirname(k.file), { recursive: true, mode: 0o700 });
        let late = false;
        try {
          // A hand edit (which takes no lock) seen here makes the write stale.
          writeDurable(k.file, text, {
            fault: sources.fault ?? null,
            beforeReplace: () => {
              if (tokenOf(k.file) !== token) {
                late = true;
                throw new Error("changed");
              }
            },
          });
        } catch (e) {
          if (late) return stale();
          throw e;
        }
        return { done: true, restart: await restartList(k.file, home) };
      });
    } catch (e) {
      if (e?.code === "busy") return { busy: true, reason: "another hoptell process holds the settings lock; try again" };
      throw e;
    }
  },
};

/** relays.json with one field changed: the document as written (never the parsed entries, which carry tokens). */
function relaysText(file, key, value) {
  const doc = JSON.parse(fs.readFileSync(file, "utf8"));
  if (key === "relays.default") {
    if (value === "") delete doc.default;
    else doc.default = value;
  } else {
    const [, alias, field] = /^relays\.([a-z0-9-]+)\.(join|name)$/.exec(key);
    const r = doc.relays.find((x) => x?.alias === alias);
    if (field === "join") {
      if (value === "true") delete r.join;
      else r.join = false;
    } else if (value === "") delete r.name;
    else r.name = value;
  }
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/** The settings file with `variable` set to `value` (removed when empty); other lines are kept. */
function envText(file, variable, value) {
  let lines = [];
  try {
    lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
    if (lines.at(-1) === "") lines.pop();
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  const re = new RegExp(`^\\s*(?:export\\s+)?${variable}\\s*=`);
  const line = `${variable}=${JSON.stringify(value)}`; // double quotes: loadEnv decodes JSON escapes
  let placed = false;
  const out = [];
  for (const l of lines) {
    if (!re.test(l)) out.push(l);
    else if (!placed && value !== "") {
      out.push(line);
      placed = true;
    } else placed = true;
  }
  if (!placed && value !== "") out.push(line);
  return out.length ? `${out.join("\n")}\n` : "";
}
