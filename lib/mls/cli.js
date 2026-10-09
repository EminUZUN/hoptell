// The experimental device-key commands (design 3.2): `hoptell device ...`, `hoptell contacts verify`
// and `hoptell contacts accept-device`. bin/hoptell.js reaches them only with
// HOPTELL_EXPERIMENTAL_E2EE=1. Keys are never printed, only display fingerprints and safety numbers.
import { DEVICE_CAP } from "../relay.js";
import { loadDriver } from "./driver.js";
import { deviceStore } from "./device.js";
import { displayFingerprint } from "./identity.js";
import { confirmationCode, evaluate, heldQueue, pairSafetyNumber, pinOf } from "./trust.js";

/** A relay client for the device frames: the relay must have been started with --experimental-e2ee. */
async function deviceClient(connect) {
  const c = await connect();
  if (!c.caps?.includes(DEVICE_CAP)) {
    c.close();
    throw new Error("this relay does not offer device keys: it was not started with --experimental-e2ee (or speaks an older protocol)");
  }
  return c;
}

const DEVICE_USAGE = "usage: hoptell device enroll|status|list|replenish|rotate|revoke <device>|backup <file>|restore <file>|migrate <backup>";

/** The device store of this home and relay profile, with the configured driver and credential store. */
export async function storeFor({ home, profile, env }) {
  const driver = await loadDriver(env);
  // The driver goes with the store: 3.3's encrypted messaging uses the same one.
  return Object.assign(deviceStore({ home, profile, driver, store: env.HOPTELL_CREDENTIAL_STORE === "file" ? "file" : "auto", passphrase: env.HOPTELL_CREDENTIAL_PASSPHRASE || null }), { driver });
}

const fp = (realm, member, d) => displayFingerprint({ realm, member, device: d.device, key: Buffer.from(d.key, "base64") });

/** `hoptell device <sub>`. `connect()` opens a send-mode relay client; `say` prints. */
export async function deviceCommand({ args, home, profile, env, connect, contacts, say = console.log }) {
  const [sub, arg] = args.filter((a) => !a.startsWith("--"));
  const store = await storeFor({ home, profile, env });
  const withClient = async (fn) => {
    const c = await deviceClient(connect);
    try {
      return await fn(c);
    } finally {
      c.close();
    }
  };
  switch (sub) {
    case "enroll": {
      const r = await withClient((c) => store.enroll(c));
      const rec = store.record();
      say(`${r.created ? "Enrolled" : "Already enrolled:"} device ${rec.device} of member ${rec.member} (realm ${rec.realm}); ${r.published} KeyPackage(s) published, ${r.available} available.`);
      say(`Fingerprint: ${rec.fingerprint}`);
      return say("EXPERIMENTAL: device keys are not released; nothing is encrypted yet. Your other devices list this one as new until you verify it there.");
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
      return withClient(async (c) => {
        const r = await c.rpc({ type: "device_list" });
        const rec = store.record();
        const pin = pinOf(contacts?.currentPolicy().doc ?? null, r.realm, r.member);
        for (const d of r.devices) {
          if (d.revoked) {
            say(`${d.device}  revoked ${new Date(d.revoked.at).toISOString()} by ${d.revoked.by === "admin" ? "the relay admin" : `device ${d.revoked.device}`}`);
            continue;
          }
          const mine = rec?.device === d.device;
          const known = pin?.devices.some((p) => p.device === d.device && p.pin === d.pin);
          say(`${d.device}  ${fp(r.realm, r.member, d)}${mine ? "  (this device)" : known ? "" : "  new device of yours: check it (hoptell contacts accept-device " + r.member + " " + d.device + ")"}`);
        }
        if (!r.devices.length) say("No devices enrolled for your member yet.");
      });
    }
    case "replenish": {
      const r = await withClient((c) => store.replenish(c, args.includes("--force") ? { force: 1 } : {}));
      return say(`${r.published} KeyPackage(s) published; ${r.available} available.`);
    }
    case "rotate": {
      const r = await withClient((c) => store.rotate(c));
      return say(`Rotated to key sequence ${r.seq}; peers that pinned the previous key accept the new one through the signed statement. New fingerprint: ${store.record().fingerprint}`);
    }
    case "revoke": {
      if (!arg) throw new Error("usage: hoptell device revoke <device>");
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

/**
 * What a verify or accept-device decision shows, from the relay's lists and a contacts policy
 * document: a pure function of them. Returns {view, code, ev, realm}: `code` is the confirmation
 * code (the --set value) over exactly that state; `view` holds only what a surface displays, with
 * fingerprints and the safety number computed from the key bytes, never from relay text.
 */
export function deviceDecision({ sub, member, device = null, theirs, mine, doc }) {
  const realm = theirs.realm;
  const what = sub === "verify" ? "verify" : `accept-device:${device}`;
  const self = member === mine.member;
  const myActive = self ? [] : evaluate(null, realm, mine.member, mine.devices).active;
  const ev = evaluate(doc, realm, member, theirs.devices);
  const code = confirmationCode({ what, realm, me: mine.member, myActive, member, ev, revision: doc?.revision });
  const n = device ? ev.newDevices.find((x) => x.device === device) : null;
  const x = device ? ev.changed.find((y) => y.device === device) : null;
  const view = {
    sub,
    realm,
    member,
    me: mine.member,
    self,
    empty: !ev.active.length && !ev.revoked.length,
    safetyNumber: self ? null : pairSafetyNumber(realm, mine.member, myActive, member, ev.active),
    pinned: pinOf(doc, realm, member)?.how ?? null,
    devices: ev.active.map((d) => ({ device: d.device, fingerprint: displayFingerprint({ realm, member, device: d.device, key: d.key }), state: ev.newDevices.some((m) => m.device === d.device) ? "new" : ev.changed.some((c) => c.device === d.device) ? "changed" : "pinned" })),
    revoked: ev.revoked.map((r) => ({ device: r.device, trusted: Boolean(r.trusted) })),
    changed: ev.changed.map((c) => ({ device: c.device, reason: c.reason, old: c.old, new: c.new })),
    ...(sub === "verify" ? {} : { target: { device, waiting: Boolean(n || x), state: n ? "new" : x ? "changed" : null, fingerprint: n ? displayFingerprint({ realm, member, device, key: n.key }) : null } }),
  };
  return { view, code, ev, realm };
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
  if (!member) throw new Error(sub === "verify" ? "usage: hoptell contacts verify <member id> [--yes --how in-person|out-of-band --set <code>]" : "usage: hoptell contacts accept-device <member id> <device> [--set <code>]");
  if (sub !== "verify" && !device) throw new Error("usage: hoptell contacts accept-device <member id> <device> [--set <code>]");
  const decisions = await import("../decisions.js");
  // One fetch per run: the confirming step decides on exactly the lists shown above.
  const fetched = new Map();
  const sources = { contacts, devices: { fetch: (m) => (fetched.has(m) ? fetched.get(m) : fetched.set(m, fetchDevices(connect, m)).get(m)) } };
  const id = sub === "verify" ? `device-verify:${member}` : `device-accept:${member}/${device}`;
  const shown = await decisions.show({ home, id, sources });
  if (shown.refused) throw new Error(shown.reason);
  const { view } = shown;
  const code = shown.nativeToken;
  if (view.empty) return say(`Member ${member} has no enrolled devices you can see.`);
  const queue = heldQueue({ home, profile });
  if (sub === "verify") {
    if (!view.self) {
      say(`Safety number with ${member}: ${view.safetyNumber}`);
      say("Compare it with them in person or over a channel you trust; it changes whenever either of you adds, removes or replaces a device.");
    }
    for (const d of view.devices) say(`  ${d.device}  ${d.fingerprint}${d.state === "new" ? "  (new)" : d.state === "changed" ? "  (KEY CHANGED)" : ""}`);
    for (const r of view.revoked) say(`  ${r.device}  revoked${r.trusted ? " (signed by another verified device)" : " (reported by the relay only)"}`);
    for (const x of view.changed) say(`Device ${x.device} has a new key (${x.reason}): old ${x.old}, new ${x.new}. Traffic with ${member} is stopped until you decide.`);
    const confirm = `hoptell contacts verify ${member} --yes --how in-person|out-of-band --set ${code}`;
    if (!yes) return say(`To pin exactly these devices: ${confirm}`);
    if (!["in-person", "out-of-band"].includes(how)) throw new Error("--how in-person or --how out-of-band says how you compared the safety number");
    if (!set) throw new Error(`--set <code> names the device set you compared; for the set shown above: ${confirm}`);
  } else {
    const t = view.target;
    if (!t.waiting) return say(`Device ${device} of ${member} is not waiting for a decision.`);
    const x = view.changed.find((y) => y.device === device);
    say(t.state === "new" ? `New device ${device} of ${member}: ${t.fingerprint}` : `Device ${device} of ${member} has a new key (${x.reason}): old ${x.old}, new ${x.new}.`);
    const confirm = `hoptell contacts accept-device ${member} ${device} --set ${code}`;
    if (!set) return say(`To accept exactly this key: ${confirm}`);
  }
  const r = await decisions.decide({ home, id, action: sub === "verify" ? "verify" : "accept", token: set, options: sub === "verify" ? { how } : {}, sources });
  if (r.stale) throw new Error(`the devices of ${member}, or your pins, changed since that code was shown (--set ${set}); compare what is shown above, then confirm with --set ${r.nativeToken}`);
  if (r.refused || r.busy) throw new Error(r.reason);
  for (const x of r.effects.decisions) say(`Recorded: ${x.decision} ${x.device}${x.old ? ` (old ${x.old})` : ""}${x.new ? ` (new ${x.new})` : ""}`);
  say(sub === "verify" ? `Pinned ${view.devices.length} device(s) of ${member} as verified ${how}.` : `Accepted device ${device} of ${member}.`);
  const n = queue.count(view.realm, member);
  if (n) say(`${n} held message(s) for ${member} are released when the sender next runs.`);
  return { pinned: r.effects.pinned };
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

/** Lines for hoptell doctor about encrypted conversations (forks, refused commits), from the device's sealed records. */
export async function e2eeDoctor({ home, profile, env }) {
  const { createE2ee } = await import("./e2ee.js");
  const store = await storeFor({ home, profile, env });
  if (!store.record()) return [];
  const st = await createE2ee({ store, driver: store.driver, client: null, session: null, home, profile }).status();
  const groups = Object.values(st.groups);
  const out = [["info", `profile ${profile}: ${groups.filter((g) => g.state === "active").length} encrypted conversation(s), ${st.replay} replay record(s), ${st.outbox} message(s) waiting to be sent`]];
  for (const g of groups) {
    if (g.fork) out.push(["warn", `profile ${profile}: fork detected with ${g.peer} at epoch ${g.fork.epoch} (compare checkpoints: hoptell contacts verify ${g.peer} --conversation)`]);
    if (g.state === "broken") out.push(["warn", `profile ${profile}: a commit with ${g.peer} was refused (${g.invalid?.why ?? "invalid"}); the next message replaces the group`]);
    if (g.state === "behind") out.push(["warn", `profile ${profile}: this device fell too far behind with ${g.peer}; the next message replaces the group`]);
  }
  if (st.held) out.push(["warn", st.held]);
  return out;
}
