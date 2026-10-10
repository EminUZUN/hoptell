// The experimental device-key commands (design 3.2): `hoptell device ...`, `hoptell contacts verify`
// and `hoptell contacts accept-device`. bin/hoptell.js reaches them only with
// HOPTELL_EXPERIMENTAL_E2EE=1. Keys are never printed, only display fingerprints and safety numbers.
import { DEVICE_CAP } from "../relay.js";
import { canPrune, loadDriver, signingRefusal } from "./driver.js";
import { deviceStore } from "./device.js";
import crypto from "node:crypto";
import { b64, displayFingerprint } from "./identity.js";
import { confirmationCode, evaluate, heldQueue, pairSafetyNumber, pinOf } from "./trust.js";
import fs from "node:fs";
import path from "node:path";
import { contactsFile, readContacts } from "../contacts.js";
import { retireOwn, evaluateOwn, ownKeeper, ownOf, realmConflict } from "./own.js";

/** A relay client for the device frames: the relay must have been started with --experimental-e2ee. */
async function deviceClient(connect) {
  const c = await connect();
  if (!c.caps?.includes(DEVICE_CAP)) {
    c.close();
    throw new Error("this relay does not offer device keys: it was not started with --experimental-e2ee (or speaks an older protocol)");
  }
  return c;
}

const DEVICE_USAGE = "usage: hoptell device enroll [--new-baseline --yes]|status|list|accept <device> [--set <code>]|retire [--yes]|replenish|rotate|revoke <device>|backup <file>|restore <file>|migrate <backup>";

/** The device store of this home and relay profile, with the configured driver and credential store. */
export async function storeFor({ home, profile, env, contacts = null }) {
  const driver = await loadDriver(env);
  // The driver goes with the store: 3.3's encrypted messaging uses the same one. The own-device
  // keeper (A1) writes the baseline at enrollment through the home's contacts.
  const own = contacts ? ownKeeper({ contacts, home, profile }) : null;
  return Object.assign(deviceStore({ home, profile, driver, own, store: env.HOPTELL_CREDENTIAL_STORE === "file" ? "file" : "auto", passphrase: env.HOPTELL_CREDENTIAL_PASSPHRASE || null }), { driver, own });
}

/** `hoptell device <sub>`. `connect()` opens a send-mode relay client; `say` prints. */
export async function deviceCommand({ args, home, profile, env, connect, contacts, say = console.log }) {
  const [sub, arg] = args.filter((a) => !a.startsWith("--"));
  const store = await storeFor({ home, profile, env, contacts });
  const withClient = async (fn) => {
    const c = await deviceClient(connect);
    try {
      return await fn(c);
    } finally {
      c.close();
    }
  };
  // A3: device-signed operations check the binding's capability before any local or relay change.
  const preflight = (what) => {
    const no = signingRefusal(store.driver, what);
    if (no) throw no;
  };
  switch (sub) {
    case "enroll": {
      const newBaseline = args.includes("--new-baseline");
      if (newBaseline && !args.includes("--yes")) {
        // A1: only on the owner's explicit confirmation (every own device lost, or the local record unreadable).
        return say("hoptell device enroll --new-baseline creates a new device with a new device id and makes it this home's only own device in the realm; your previously accepted devices are dropped here (accept them again with hoptell device accept, in both directions). Your contacts see a new device of yours, held until they accept or verify it; your old device ids stay pinned on their side, shown as missing, until they forget them. Confirm with: hoptell device enroll --new-baseline --yes");
      }
      const r = await withClient((c) => store.enroll(c, { newBaseline }));
      const rec = store.record();
      say(`${r.created ? "Enrolled" : "Already enrolled:"} device ${rec.device} of member ${rec.member} (realm ${rec.realm}); ${r.published} KeyPackage(s) published, ${r.available} available.`);
      say(`Fingerprint: ${rec.fingerprint}`);
      return say("EXPERIMENTAL: encrypted messages are experimental and unreviewed. This device is your own baseline in this realm: another device of yours is trusted only after hoptell device accept <device> on this one (and this one on it).");
    }
    case "accept": {
      // A1: another device of this home's own member, accepted from an own device through the
      // decision service; its pin is never copied from the relay without this confirmation.
      if (!arg) throw new Error("usage: hoptell device accept <device> [--set <code>]");
      const decisions = await import("../decisions.js");
      const rec = store.record();
      if (!rec) throw new Error("this home has no device for this relay yet: hoptell device enroll");
      let listed = null;
      const sources = { contacts, devices: { own: async () => ({ list: (listed ??= await fetchOwnDevices(connect)), thisDevice: rec.device }) } };
      const id = `device-own:${arg}`;
      const shown = await decisions.show({ home, id, sources });
      if (shown.refused) throw new Error(shown.reason);
      const v = shown.view;
      if (v.refusal) throw new Error(v.refusal);
      if (!v.waiting) return say(`Device ${arg} of yours is not waiting for a decision (${v.state}).`);
      say(`Device ${arg} of yours (member ${v.member}, realm ${v.realm})${v.state === "unconfirmed" ? ", pinned on the relay's word by an older hoptell," : ""} is not accepted.`);
      say(`Its fingerprint: ${v.fingerprint}`);
      say(`Compare it with what hoptell device status shows on that device. Accepting it here makes it one of your devices for this home (${rec.device}); run hoptell device accept ${rec.device} on it for the other direction.`);
      if (!args.includes("--set")) return say(`To accept exactly this device: hoptell device accept ${arg} --set ${shown.nativeToken}`);
      const set = args[args.indexOf("--set") + 1] ?? null;
      const r = await decisions.decide({ home, id, action: "accept", token: set, sources });
      if (r.stale) throw new Error(`your devices or pins changed since that code was shown (--set ${set}); compare what is shown above, then confirm with --set ${r.nativeToken}`);
      if (r.refused || r.busy) throw new Error(r.reason);
      return say(`Accepted device ${arg} as one of yours. Conversations it was stopped in resume when their messages are next sent.`);
    }
    case "retire": {
      // A1: give up this profile's device (one device per home and realm): retired durably here
      // first, then its own entry dropped. A device-signed revocation at the relay is separate (A3).
      const rec = store.record();
      if (!rec) throw new Error("this profile has no device to retire");
      if (!args.includes("--yes")) return say(`hoptell device retire marks device ${rec.device} (profile ${profile}, realm ${rec.realm}) retired: it may read what it can still decrypt, never send again, and it stops being this home's own device in that realm. Confirm with: hoptell device retire --yes`);
      const r = await retireDevice({ store, contacts, profile });
      say(`Retired device ${r.device} (profile ${profile}); its conversations stop here.`);
      if (r.baseline) say(`It was this home's own device in realm ${store.record()?.realm ?? ""}: that baseline is kept, marked retired. A new device in this realm needs your explicit confirmation: hoptell device enroll --new-baseline (your contacts then see a new device of yours).`);
      return say("Ask the relay admin to revoke it there (hoptell members device-revoke), or revoke it from another of your devices.");
    }
    case "status": {
      const rec = store.record();
      if (!rec) return say("No device for this relay yet: hoptell device enroll");
      say(`Device ${rec.device} (${rec.status}) of member ${rec.member} in realm ${rec.realm}, key sequence ${rec.seq}; MLS library ${rec.driver.name} ${rec.driver.version}.`);
      say(`Fingerprint: ${rec.fingerprint}`);
      if (rec.mayAct) say(`It cannot send: ${rec.mayAct}`);
      for (const r of store.retired()) say(`Retired: ${r.device} (${r.retiredWhy})`);
      const line = heldQueue({ home, profile }).line();
      if (line) say(line);
      return;
    }
    case "list": {
      // A1: the relay's list judged against this home's own pins (never the other way round).
      return withClient(async (c) => {
        const r = await c.rpc({ type: "device_list" });
        const rec = store.record();
        for (const line of ownLines({ list: r, doc: contacts?.currentPolicy().doc ?? null, thisDevice: rec?.device ?? null })) say(line);
      });
    }
    case "replenish": {
      const r = await withClient((c) => store.replenish(c, args.includes("--force") ? { force: 1 } : {}));
      return say(`${r.published} KeyPackage(s) published; ${r.available} available.`);
    }
    case "rotate": {
      preflight("hoptell device rotate");
      const r = await withClient((c) => store.rotate(c));
      return say(`Rotated to key sequence ${r.seq}; peers that pinned the previous key accept the new one through the signed statement. New fingerprint: ${store.record().fingerprint}`);
    }
    case "revoke": {
      if (!arg) throw new Error("usage: hoptell device revoke <device>");
      preflight("hoptell device revoke");
      const r = await withClient((c) => store.revoke(c, arg));
      return say(r.state === "already" ? `Device ${arg} was already revoked.` : `Revoked device ${arg}: the relay no longer serves its KeyPackages or directory entry; peers that pinned it hold sending to it.`);
    }
    case "backup": {
      if (!arg) throw new Error("usage: hoptell device backup <file> (with HOPTELL_CREDENTIAL_PASSPHRASE)");
      await store.backup(arg, env.HOPTELL_CREDENTIAL_PASSPHRASE || null);
      return say(`Backed up to ${arg}. A restore never sends: it comes back retired, and that machine enrolls a new device.`);
    }
    case "restore": {
      if (!arg) throw new Error("usage: hoptell device restore <backup> (with HOPTELL_CREDENTIAL_PASSPHRASE)");
      const r = await store.restore(arg, env.HOPTELL_CREDENTIAL_PASSPHRASE || null);
      return say(`Restored device ${r.device} as retired: it may read what it can still decrypt, never send. Enroll this machine with hoptell device enroll.`);
    }
    case "migrate": {
      if (!arg) throw new Error("usage: hoptell device migrate <backup of the old device> (with HOPTELL_CREDENTIAL_PASSPHRASE)");
      // A3: migrate ends with a device-signed revocation: checked before the restore, the retire
      // marker and the new enrollment.
      preflight("hoptell device migrate");
      // The old device is retired here durably before anything else, then this machine enrolls and
      // revokes the old one at the relay with its new key.
      const old = await store.restore(arg, env.HOPTELL_CREDENTIAL_PASSPHRASE || null);
      return withClient(async (c) => {
        const r = await store.enroll(c);
        await store.revoke(c, old.device);
        say(`Migrated: device ${old.device} is retired here and revoked at the relay; this machine is device ${r.device}. Peers see a new device to verify.`);
      });
    }
    default:
      throw new Error(DEVICE_USAGE);
  }
}

/**
 * Lines describing this home's own devices in the realm of `list` (the relay's device_list of the
 * own member) against the own pins: this device, accepted, missing (pinned, not listed), changed,
 * not accepted (listed, not an own pin), unconfirmed (from the upgrade), revoked.
 */
export function ownLines({ list, doc, thisDevice }) {
  const out = [];
  let entry = null;
  try {
    entry = ownOf(doc, list.realm);
  } catch (e) {
    return [`Your own devices cannot be judged: ${e.message}`];
  }
  if (!entry) return [`No own device is recorded in this home for realm ${list.realm}: hoptell device enroll`];
  const ev = evaluateOwn(entry, list.realm, list.devices);
  const f = (d) => displayFingerprint({ realm: list.realm, member: entry.member, device: d.device, key: Buffer.isBuffer(d.key) ? d.key : Buffer.from(d.key, "base64") });
  const missing = new Set(ev.missing.map((d) => d.device));
  const changed = new Map(ev.changed.map((d) => [d.device, d]));
  for (const d of entry.devices) {
    const what = d.device === thisDevice ? "this device" : d.how === "enrolled" ? "enrolled here (another profile?)" : `accepted${d.by ? ` from ${d.by}` : ""}`;
    say1(`${d.device}  ${f(d)}  (${what}${missing.has(d.device) ? "; the relay no longer lists it" : ""}${changed.has(d.device) ? `; KEY CHANGED: ${changed.get(d.device).reason}` : ""})`);
  }
  for (const d of ev.unaccepted) say1(`${d.device}  ${d.fingerprint}  (${d.unconfirmed ? "unconfirmed: pinned on the relay's word by an older hoptell" : "listed by the relay, NOT accepted by you"}: accept it with hoptell device accept ${d.device} if it is yours, or revoke it)`);
  for (const u of entry.unconfirmed) if (!ev.unaccepted.some((d) => d.device === u.device)) say1(`${u.device}  ${f(u)}  (unconfirmed, not listed by the relay now: accept or revoke it; conversations holding it stay stopped)`);
  for (const d of list.devices.filter((x) => x.revoked)) {
    const trusted = ev.revoked.find((r) => r.device === d.device)?.trusted;
    say1(`${d.device}  revoked ${new Date(d.revoked.at).toISOString()} by ${d.revoked.by === "admin" ? "the relay admin" : `device ${d.revoked.device}`}${trusted ? " (signed by one of your devices)" : ""}`);
  }
  return out;
  function say1(x) {
    out.push(x);
  }
}

/**
 * `hoptell device retire`: the record retired durably (it reads, never sends: its conversations
 * stop here), then, when this profile holds the realm's own entry, that entry marked retired and
 * kept (a later enrollment in the realm needs --new-baseline, which keeps it in history). Another
 * profile's entry is never touched (the duplicate-profile repair). Both steps are idempotent.
 */
export async function retireDevice({ store, contacts, profile, now = Date.now() }) {
  const rec = store.record();
  if (rec.status !== "retired") await store.retire("retired by the owner (hoptell device retire)");
  let baseline = false;
  if (contacts?.updatePins && !contacts.currentPolicy().legacy) {
    const { result } = await contacts.updatePins((doc) => retireOwn(doc, rec.realm, profile, now));
    baseline = result === "retired";
  }
  return { device: rec.device, baseline };
}

/** The relay's list of the caller's own devices: {realm, member, devices}. */
export async function fetchOwnDevices(connect) {
  const c = await deviceClient(connect);
  try {
    return await c.rpc({ type: "device_list" });
  } finally {
    c.close();
  }
}

/** The relay's device lists for `member` and for the caller (one connection). */
export async function fetchDevices(connect, member) {
  const c = await deviceClient(connect);
  try {
    const theirs = await c.rpc({ type: "device_list", member });
    const mine = member === c.member?.id ? theirs : await c.rpc({ type: "device_list" });
    return { theirs, mine };
  } finally {
    c.close();
  }
}

/** The refusal for an own device the relay lists that is not an own pin (A1), or null. */
function ownRefusal(ownEv, entry) {
  const x = ownEv.unaccepted[0];
  if (x) return `the relay lists device ${x.device} of yours that you have not accepted: accept it from one of your devices (hoptell device accept ${x.device}) or revoke it`;
  const u = entry?.unconfirmed[0];
  if (u) return `device ${u.device} of yours was pinned on the relay's word by an older hoptell and is not accepted: accept it from one of your devices (hoptell device accept ${u.device}) or revoke it`;
  if (ownEv.changed.length) return ownEv.stop;
  return null;
}

/**
 * What a verify or accept-device decision shows, from the relay's lists and a contacts policy
 * document: a pure function of them. Returns {view, code, ev, realm}: `code` is the confirmation
 * code (the --set value) over exactly that state; `view` holds only what a surface displays, with
 * fingerprints and the safety number computed from the key bytes, never from relay text.
 *
 * A1: the own half of the safety number comes from this home's own pins only (contacts.json
 * `own`), never from the relay's list of the caller's devices; the peer half is the caller's view
 * of the peer: its pins (missing ones included) plus every device the relay lists for it (new ones
 * marked). Both sets are shown. An own device the relay lists that is not an own pin (or an
 * unconfirmed one) refuses the comparison and the confirmation (`view.refusal`); a pinned peer
 * device the relay no longer lists is shown as missing and refuses re-pinning until the owner
 * decides it (`view.blocked`: it reappears, a trusted revocation, or hoptell contacts forget-device).
 */
export function deviceDecision({ sub, member, device = null, theirs, mine, doc }) {
  const realm = theirs.realm;
  const what = sub === "verify" ? "verify" : `${sub}:${device}`;
  const self = member === mine.member;
  let entry = null;
  let ownProblem = null;
  try {
    entry = ownOf(doc, realm);
  } catch (e) {
    ownProblem = e.message;
  }
  if (!entry && !ownProblem) ownProblem = `this home has no own device recorded in realm ${realm} (enroll this device: hoptell device enroll)`;
  else if (entry && entry.member !== mine.member) ownProblem = `this home's own devices in realm ${realm} belong to member ${entry.member}, not ${mine.member}`;
  const ownEv = evaluateOwn(entry, realm, mine.devices);
  const ownPins = (entry?.devices ?? []).map((d) => ({ device: d.device, pin: Buffer.from(d.pin, "base64"), key: Buffer.from(d.key, "base64"), how: d.how }));
  const myActive = self ? [] : ownPins;
  const ev = evaluate(doc, realm, member, theirs.devices);
  // The peer half: every listed (active) device, plus pinned devices the relay no longer lists.
  const theirSet = [...ev.active, ...ev.missing];
  const code = confirmationCode({ what, realm, me: mine.member, myActive, member, ev: { ...ev, active: theirSet }, revision: doc?.revision });
  const n = device ? ev.newDevices.find((x) => x.device === device) : null;
  const x = device ? ev.changed.find((y) => y.device === device) : null;
  const refusal = ownProblem ?? ownRefusal(ownEv, entry);
  const fp = (m, d) => displayFingerprint({ realm, member: m, device: d.device, key: d.key });
  const missingOwn = new Set(ownEv.missing.map((d) => d.device));
  const changedOwn = new Set(ownEv.changed.map((d) => d.device));
  const view = {
    sub,
    realm,
    member,
    me: mine.member,
    self,
    empty: !ev.active.length && !ev.revoked.length && !ev.missing.length,
    safetyNumber: self || refusal ? null : pairSafetyNumber(realm, mine.member, myActive, member, theirSet),
    pinned: pinOf(doc, realm, member)?.how ?? null,
    refusal,
    blocked: ev.missing.length ? `the relay no longer lists device ${ev.missing.map((d) => d.device).join(", ")} of ${member}: decide it first (it reappears, a trusted revocation arrives, or hoptell contacts forget-device ${member} ${ev.missing[0].device})` : null,
    own: [
      ...ownPins.map((d) => ({ device: d.device, fingerprint: fp(mine.member, d), state: d.how === "enrolled" ? "this device" : missingOwn.has(d.device) ? "missing" : changedOwn.has(d.device) ? "changed" : "accepted" })),
      ...ownEv.unaccepted.map((d) => ({ device: d.device, fingerprint: d.fingerprint, state: d.unconfirmed ? "unconfirmed" : "not accepted" })),
      ...(entry?.unconfirmed ?? []).filter((u) => !ownEv.unaccepted.some((d) => d.device === u.device)).map((u) => ({ device: u.device, fingerprint: displayFingerprint({ realm, member: mine.member, device: u.device, key: Buffer.from(u.key, "base64") }), state: "unconfirmed" })),
    ],
    devices: [
      ...ev.active.map((d) => ({ device: d.device, fingerprint: fp(member, d), state: ev.newDevices.some((m) => m.device === d.device) ? "new" : ev.changed.some((c) => c.device === d.device) ? "changed" : "pinned" })),
      ...ev.missing.map((d) => ({ device: d.device, fingerprint: fp(member, d), state: "missing" })),
    ],
    revoked: ev.revoked.map((r) => ({ device: r.device, trusted: Boolean(r.trusted) })),
    changed: ev.changed.map((c) => ({ device: c.device, reason: c.reason, old: c.old, new: c.new })),
    ...(sub === "accept-device" ? { target: { device, waiting: Boolean(n || x), state: n ? "new" : x ? "changed" : null, fingerprint: n ? displayFingerprint({ realm, member, device, key: n.key }) : null } } : {}),
    ...(sub === "forget-device" ? (() => {
      const m = ev.missing.find((d) => d.device === device);
      return { target: { device, waiting: Boolean(m), state: m ? "missing" : null, fingerprint: m ? fp(member, m) : null } };
    })() : {}),
  };
  return { view, code, ev, realm };
}

/**
 * What `hoptell device accept <device>` shows (A1), from the relay's list of the own member and
 * the contacts document: a pure function of them. The accepting device must itself be an own pin;
 * the target must be a device the relay lists for the own member that is not one (an unconfirmed
 * one included). Returns {view, code, target}: `code` binds the confirmation to exactly that
 * device, key, accepting device and pin revision.
 */
export function ownDeviceDecision({ device, list, thisDevice, doc }) {
  const realm = list.realm;
  let entry = null;
  let refusal = null;
  try {
    entry = ownOf(doc, realm);
  } catch (e) {
    refusal = e.message;
  }
  if (!refusal && !entry) refusal = `this home has no own device recorded in realm ${realm} (hoptell device enroll)`;
  else if (!refusal && entry.member !== list.member) refusal = `this home's own devices in realm ${realm} belong to member ${entry.member}, not ${list.member}`;
  else if (!refusal && !entry.devices.some((d) => d.device === thisDevice)) refusal = `this device (${thisDevice ?? "none"}) is not one of your accepted devices; accept ${device} from one that is`;
  const ev = evaluateOwn(entry, realm, list.devices);
  const target = ev.unaccepted.find((d) => d.device === device) ?? null;
  const already = entry?.devices.some((d) => d.device === device) ?? false;
  const revoked = ev.revoked.some((r) => r.device === device);
  const view = {
    realm,
    member: list.member,
    thisDevice,
    device,
    refusal,
    already,
    waiting: !refusal && Boolean(target),
    state: already ? "accepted" : target ? (target.unconfirmed ? "unconfirmed" : "not accepted") : revoked ? "revoked" : "not listed",
    fingerprint: target?.fingerprint ?? null,
  };
  const code = crypto.createHash("sha256").update(JSON.stringify(["hoptell-own-accept-v1", realm, list.member, thisDevice, device, target ? b64(target.pin) : null, doc?.revision ?? 0])).digest("hex").slice(0, 32);
  return { view, code, target, realm };
}

/**
 * `hoptell contacts verify <member> [--yes --how in-person|out-of-band --set <code>]` and
 * `hoptell contacts accept-device <member> <device> [--set <code>]`: show, then (on the owner's
 * confirmation) pin, through the decision service (lib/decisions.js). The display ends with a
 * confirmation code over exactly what it showed (the device sets, keys and the local pins'
 * revision); the confirming run pins only if the code still matches, checked again under the
 * contacts lock, so a device added or replaced meanwhile, or a concurrent pin edit, is refused
 * instead of pinned. `contacts` is the opened contacts manager (lib/quarantine.js).
 */
export async function verifyCommand({ sub, member, device, yes, how, set = null, home, profile, connect, contacts, say = console.log }) {
  const usage = { verify: "usage: hoptell contacts verify <member id> [--yes --how in-person|out-of-band --set <code>]", "accept-device": "usage: hoptell contacts accept-device <member id> <device> [--set <code>]", "forget-device": "usage: hoptell contacts forget-device <member id> <device> [--set <code>]" }[sub];
  if (!member) throw new Error(usage);
  if (sub !== "verify" && !device) throw new Error(usage);
  const decisions = await import("../decisions.js");
  // One fetch per run: the confirming step decides on exactly the lists shown above.
  const fetched = new Map();
  const sources = { contacts, devices: { fetch: (m) => (fetched.has(m) ? fetched.get(m) : fetched.set(m, fetchDevices(connect, m)).get(m)) } };
  const id = sub === "verify" ? `device-verify:${member}` : sub === "forget-device" ? `device-forget:${member}/${device}` : `device-accept:${member}/${device}`;
  const shown = await decisions.show({ home, id, sources });
  if (shown.refused) throw new Error(shown.reason);
  const { view } = shown;
  const code = shown.nativeToken;
  if (view.empty) return say(`Member ${member} has no enrolled devices you can see.`);
  const queue = heldQueue({ home, profile });
  if (sub === "verify") {
    // Both sets (A1): this home's own pinned devices and the peer's devices, each with its
    // fingerprint and state, pinned devices the relay no longer lists included (missing).
    say(`Your devices (member ${view.me}, from your own pins):`);
    for (const d of view.own) say(`  ${d.device}  ${d.fingerprint}  (${d.state})`);
    say(`Devices of ${member}:`);
    for (const d of view.devices) say(`  ${d.device}  ${d.fingerprint}${d.state === "new" ? "  (new)" : d.state === "changed" ? "  (KEY CHANGED)" : d.state === "missing" ? "  (missing: the relay no longer lists it)" : ""}`);
    for (const r of view.revoked) say(`  ${r.device}  revoked${r.trusted ? " (signed by another verified device)" : " (reported by the relay only)"}`);
    for (const x of view.changed) say(`Device ${x.device} has a new key (${x.reason}): old ${x.old}, new ${x.new}. Traffic with ${member} is stopped until you decide.`);
    // An own device the owner has not accepted: no number to compare, nothing to confirm.
    if (view.refusal) throw new Error(`verify refused: ${view.refusal}`);
    if (!view.self) {
      say(`Safety number with ${member}: ${view.safetyNumber}`);
      say("Compare it with them in person or over a channel you trust; it changes whenever either of you adds, removes or replaces a device.");
    }
    if (view.blocked) {
      if (yes) throw new Error(`nothing is pinned: ${view.blocked}`);
      return say(`Not pinned until you decide: ${view.blocked}.`);
    }
    const confirm = `hoptell contacts verify ${member} --yes --how in-person|out-of-band --set ${code}`;
    if (!yes) return say(`To pin exactly these devices: ${confirm}`);
    if (!["in-person", "out-of-band"].includes(how)) throw new Error("--how in-person or --how out-of-band says how you compared the safety number");
    if (!set) throw new Error(`--set <code> names the device set you compared; for the set shown above: ${confirm}`);
  } else if (sub === "forget-device") {
    // A4: the only owner-driven removal of a pinned device, for one the relay no longer lists.
    const t = view.target;
    if (!t.waiting) return say(`Device ${device} of ${member} is not missing: the relay still lists it, or it is not pinned. Nothing to forget.`);
    say(`Device ${device} of ${member} (${t.fingerprint}) is pinned, but the relay no longer lists it. Forgetting it unpins it; your next message to ${member} removes it from the conversation with one commit.`);
    const confirm = `hoptell contacts forget-device ${member} ${device} --set ${code}`;
    if (!set) return say(`To forget exactly this device: ${confirm}`);
  } else {
    if (view.refusal) throw new Error(`accept-device refused: ${view.refusal}`);
    const t = view.target;
    if (!t.waiting) return say(`Device ${device} of ${member} is not waiting for a decision.`);
    const x = view.changed.find((y) => y.device === device);
    say(t.state === "new" ? `New device ${device} of ${member}: ${t.fingerprint}` : `Device ${device} of ${member} has a new key (${x.reason}): old ${x.old}, new ${x.new}.`);
    const confirm = `hoptell contacts accept-device ${member} ${device} --set ${code}`;
    if (!set) return say(`To accept exactly this key: ${confirm}`);
  }
  const r = await decisions.decide({ home, id, action: sub === "verify" ? "verify" : sub === "forget-device" ? "forget" : "accept", token: set, options: sub === "verify" ? { how } : {}, sources });
  if (r.stale) throw new Error(`the devices of ${member}, or your pins, changed since that code was shown (--set ${set}); compare what is shown above, then confirm with --set ${r.nativeToken}`);
  if (r.refused || r.busy) throw new Error(r.reason);
  for (const x of r.effects.decisions) say(`Recorded: ${x.decision} ${x.device}${x.old ? ` (old ${x.old})` : ""}${x.new ? ` (new ${x.new})` : ""}`);
  say(sub === "verify" ? `Pinned ${view.devices.length} device(s) of ${member} as verified ${how}.` : sub === "forget-device" ? `Forgot device ${device} of ${member}.` : `Accepted device ${device} of ${member}.`);
  const n = queue.count(view.realm, member);
  if (n) say(`${n} held message(s) for ${member} are released when the sender next runs.`);
  return { pinned: r.effects.pinned ?? [] };
}

/**
 * `hoptell contacts verify <member> --conversation` (design 3.3, MI6): this device's checkpoint of
 * the encrypted conversation with `member` (realm, group, generation, epoch and the epoch
 * authenticator in 3.2's display format), for both owners to compare out of band. Device safety
 * numbers identify devices; this compares histories.
 */
export async function conversationCommand({ member, home, profile, env, say = console.log }) {
  if (!member) throw new Error("usage: hoptell contacts verify <member id> --conversation");
  const { createE2ee } = await import("./e2ee.js");
  const store = await storeFor({ home, profile, env });
  if (!store.record()) return say("This home has no device for this relay yet: hoptell device enroll");
  const cp = await createE2ee({ store, driver: store.driver, client: null, session: null, home, profile }).checkpoint(member);
  if (!cp) return say(`This device has no encrypted conversation with ${member} yet.`);
  say(`Encrypted conversation with ${member}: realm ${cp.realm}, group ${cp.group}, generation ${cp.generation}, epoch ${cp.epoch}`);
  say(`Checkpoint: ${cp.digits}`);
  say(`Compare it with the other owner's (hoptell contacts verify <your member id> --conversation) at the same generation and epoch. Different numbers mean your histories differ (a fork): the conversation is then recovered by a new group.`);
  say("Limit: hoptell notices the inconsistent history it sees; a relay can keep two sides apart unnoticed until they meet again or you compare these numbers.");
  if (cp.fork) say(`A fork was detected at epoch ${cp.fork.epoch}; the next message replaces the group.`);
}

/**
 * Lines for hoptell doctor about this home's own devices (A1), from local state only: the own
 * entry in contacts.json, one device per realm, and what the engine last saw at the relay
 * (own-seen.json: devices listed but not accepted, own pins no longer listed, key changes).
 */
export function ownDoctor({ home, profile, rec }) {
  const out = [];
  if (!rec || rec.status === "retired" || rec.status === "revoked") return out;
  const conflict = realmConflict(home, rec.realm);
  if (conflict) out.push(["warn", `profile ${profile}: ${conflict}`]);
  const r = readContacts(contactsFile(home));
  let entry = null;
  try {
    entry = ownOf(r.doc, rec.realm);
  } catch (e) {
    out.push(["warn", `profile ${profile}: ${e.message}`]);
    return out;
  }
  if (!r.doc) out.push(["warn", `profile ${profile}: this home's contacts are not usable (${r.problem ?? "no contacts.json"}); encrypted messages need its own-device baseline there (hoptell contacts init)`]);
  else if (!entry) out.push(["warn", `profile ${profile}: no own-device baseline in contacts.json yet for realm ${rec.realm}; it is written when encrypted messaging next starts (or hoptell device enroll)`]);
  else if (entry.profile !== profile) out.push(["warn", `profile ${profile}: realm ${rec.realm} belongs to profile ${entry.profile} in this home (one device per home and realm): retire one (hoptell device retire)`]);
  else {
    const enrolled = entry.devices.find((d) => d.how === "enrolled");
    if (enrolled?.device !== rec.device) out.push(["warn", `profile ${profile}: the own baseline names device ${enrolled?.device}, not this device ${rec.device}: encryption stops (hoptell device enroll --new-baseline)`]);
    out.push(["info", `profile ${profile}: ${entry.devices.length} own device(s) accepted in realm ${rec.realm}${entry.upgradedAt ? ` (upgraded ${new Date(entry.upgradedAt).toISOString()})` : ""}`]);
    for (const u of entry.unconfirmed) out.push(["warn", `profile ${profile}: device ${u.device} of yours was pinned on the relay's word by an older hoptell and is unconfirmed; conversations holding it are stopped until you accept it (hoptell device accept ${u.device}) or revoke it`]);
  }
  let seen = null;
  try {
    seen = JSON.parse(fs.readFileSync(path.join(home, "mls", profile, "own-seen.json"), "utf8"));
  } catch {}
  if (seen) {
    const when = new Date(seen.at).toISOString();
    for (const d of seen.unaccepted ?? []) if (!d.unconfirmed) out.push(["warn", `profile ${profile}: the relay lists device ${d.device} of yours (${d.fingerprint}) that you have not accepted (seen ${when}): accept it from one of your devices (hoptell device accept ${d.device}) or revoke it; until then verify refuses and your conversations do not add it`]);
    for (const d of seen.missing ?? []) out.push(["warn", `profile ${profile}: your device ${d} is no longer listed by the relay (seen ${when}); it stays one of yours until you decide`]);
    for (const d of seen.changed ?? []) out.push(["warn", `profile ${profile}: your device ${d} appeared with another key and no valid rotation (seen ${when}); encrypted sending is stopped`]);
  }
  return out;
}

/** Lines for hoptell doctor about encrypted conversations (forks, refused commits), from the device's sealed records. */
export async function e2eeDoctor({ home, profile, env }) {
  const { createE2ee } = await import("./e2ee.js");
  const store = await storeFor({ home, profile, env });
  if (!store.record()) return [];
  const st = await createE2ee({ store, driver: store.driver, client: null, session: null, home, profile }).status();
  const groups = Object.values(st.groups);
  const out = [["info", `profile ${profile}: ${groups.filter((g) => g.state === "active").length} encrypted conversation(s), ${st.replay} replay record(s), ${st.outbox} message(s) waiting to be sent`]];
  out.push(...ownDoctor({ home, profile, rec: store.record() }));
  for (const g of groups) {
    if (g.fork) out.push(["warn", `profile ${profile}: fork detected with ${g.peer} at epoch ${g.fork.epoch} (compare checkpoints: hoptell contacts verify ${g.peer} --conversation)`]);
    if (g.state === "broken") out.push(["warn", `profile ${profile}: a commit with ${g.peer} was refused (${g.invalid?.why ?? "invalid"}); the next message replaces the group`]);
    if (g.state === "behind") out.push(["warn", `profile ${profile}: this device fell too far behind with ${g.peer}; the next message replaces the group`]);
  }
  // A2: members whose last update in a conversation is older than 30 days.
  for (const [gid, devices] of Object.entries(st.stale ?? {})) {
    if (devices.length) out.push(["warn", `profile ${profile}: in the conversation with ${st.groups[gid].peer}, device(s) ${devices.join(", ")} sent no update for more than 30 days (a compromised device keeps reading until it updates or is removed)`]);
  }
  if (st.held) out.push(["warn", st.held]);
  // A10: whether expired, unused KeyPackage private keys are deleted (the binding's prune).
  const rec = store.record();
  const pruned = Object.values(rec.kps ?? {}).filter((e) => e.state === "pruned").length;
  const orphans = rec.prunedOrphans?.length ?? 0;
  if (canPrune(store.driver)) out.push(["info", `profile ${profile}: expired, unused KeyPackage private keys are deleted a day after expiry (${pruned} pruned${orphans ? `, ${orphans} pruned ref(s) with no ledger entry` : ""})`]);
  else out.push(["warn", `profile ${profile}: KeyPackage pruning is unavailable with this MLS binding (it has no prune_key_packages): expired, unused KeyPackage private keys stay in the device state until it is enrolled again`]);
  return out;
}
