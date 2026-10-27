// Encrypted direct messages between members, at one device (design 3.3). EXPERIMENTAL: reached
// only with HOPTELL_EXPERIMENTAL_E2EE=1, through lib/mls/driver.js (no library is imported here)
// and the relay's encrypted-message frames (lib/relay.js, capability "e2ee").
//
// One conversation per member pair, mapped by the relay to its current group; the group holds the
// owner-accepted devices of both members (3.2's pins). The relay sequences commits; this device
// accepts them cryptographically and cross-checks every roster delta against the authenticated
// commit and its pins.
//
// State (gate 5's discipline): everything lives in the device record (lib/mls/device.js), in
// rec.e2ee, and is written with the library state as one durable write (ctx.save()), under the
// device's one-writer lock. So a change of group state is never durable without the records that
// go with it:
//   committer   per group, the pending commit's exact bundle and op id, with an explicit phase:
//               prepared -> published -> merged | cleared (MI2). The merge and its phase change are
//               one write, so a restart after the merge finds "merged" and never merges again;
//               "prepared" or "published" after a restart publishes the same op id and bundle
//               again and the relay returns the original result.
//   outbox      application messages sealed and durable (state plus the exact ciphertext) before
//               they are sent; cleared once the relay accepted them. Its phase: sealed ->
//               published (written just before the ciphertext goes out). Recovery never publishes
//               a saved ciphertext unchecked (MII3): a "published" one is reconciled by its op id
//               (the relay returns the original result without accepting anything new, or, for an
//               op id it never accepted, cancels it in the same transaction so a delayed original
//               request is refused); only a sealed or cancelled one is dropped and its logical
//               message sealed again through the current trust decision and group (holds,
//               requireVerified, removals first). Without a cancellation the entry is kept.
//   logical     each logical message's encoded content, so a resend into a replacement group keeps
//               its id, created and expires unchanged (MI3).
//   replay      (conversation, from member, message id) -> when the record may go (expires + 5 min).
//   inbound     decrypted messages not yet acknowledged to the relay (state, decrypted record and
//               replay record land together before the session's pipeline sees them).
//   checkpoints (group, epoch) -> (epoch authenticator, accepted commit digest), the last 30 (MI6).
//   fanout      per encrypted fan-out (4.3, lib/mls/fanout.js): its frozen audience and each copy's
//               final result, written with the copies' logical messages and their terminal states.
//   freshness   per group (design 3.2 v2.2, A2), with the group's record: lastOwnUpdate (its
//               creation or join, then only an own update commit merged after acceptance),
//               activeSince (the first accepted outbound or processed inbound application message
//               after it), removalAt (a removal merged since it), and updates (device -> when its leaf was
//               last replaced by a merged commit). An update due by policy.js updateDue is one
//               committer operation, recovered like any commit.
// The retained send state (logical, outbox, fanout) is bounded per device (4.3): a new send is
// refused with storage_full before anything is written; recovery and reseals never are.
// A failed or refused step simply does not save: the next transaction loads the state as it was.
import crypto from "node:crypto";
import path from "node:path";
import { checkGroups, DriverError } from "./driver.js";
import { MAX_LIFETIME_MS, SKEW_MS, decodeContent, encodeContent, idToRef, newContent, outsideWindow } from "./content.js";
import { base32, b64, displayDigits, encodeFields, parseCredentialIdentity } from "./identity.js";
import { applyRevocations, applyRotations, checkKeyPackage, evaluate, gate, heldQueue, pinFirstUse, pinOf, retireRemovedDevice } from "./trust.js";
import { applyOwnRotations, dropRevokedOwn, enrolledOf, evaluateOwn, forgetRemovedOwn, markRegistered, ownKeeper, ownOf, realmConflict, writeOwnSeen } from "./own.js";
import { MAX_FRAME_BYTES } from "./relayds.js";
import { HOUR, PRUNE_EVERY_MS, MAX_FORWARD_GENERATIONS, MAX_SKIPPED_PER_SENDER_EPOCH, staleMembers, updateDue } from "./policy.js";
import { FANOUT_KEEP_MS, FANOUT_VERSION, LIMITS, RESEALABLE, TERMINAL, UNAVAILABLE_CODES, admit, bodyDigest, finalOf, frameBound, inProgress, logicalBytes, recordBytes, selectRole, summary } from "./fanout.js";
import { allowsHosted, encryptionMode } from "../contacts.js";
import { TransferFormatError, checkDescriptor } from "../transferwire.js";

export const REPLAY_CAPACITY = 100_000; // replay records per device (MI3)
export const CHECKPOINTS_KEPT = 30;
const CHECKPOINT_DOMAIN = "hoptell-checkpoint-display-v1";
const INBOUND_KEEP_MS = MAX_LIFETIME_MS + 2 * SKEW_MS + 86_400_000;
const NOTICES_KEPT = 50;
const RESEND_RETRY_MS = 1_000; // a reseal pass stopped by a transient error runs again after this,
const RESEND_RETRY_MAX_MS = 16_000; // ... doubling up to this; stopped by the relay's rate limit
// (whose window slides and does not count refused requests), every RESEND_RETRY_MS
// Errors after which a reseal is simply tried again later (nothing was accepted or changed).
const TRANSIENT = new Set(["rate_limited", "no_answer", "lost", "not_sent", "unavailable", "trust_unavailable"]);
const PACE_MS = 1_000; // a fan-out request refused as rate_limited is asked again after this
const PACE_TRIES = 30; // ... at most this often (the relay's window is 10 s)
export const REATTACH_TRIES = 5; // a connection the relay detached (a key change) proves again this often quickly,
const REATTACH_BASE_MS = 500; // ... after 0.5 s, 1 s, 2 s, 4 s; then on, doubling with jitter up to
const REATTACH_MAX_MS = 60_000; // ... then a wait capped at a minute (30 to 60 s with jitter), for as long as this connection is up

export class E2eeError extends Error {
  constructor(message, code = "e2ee", extra = {}) {
    super(message);
    this.code = code;
    Object.assign(this, extra);
  }
}

/**
 * Whether an accepted application op reached no device of the other member (A4), from its
 * evidence only: the relay's peerRecipients when it answers one (0: none), else (an older relay)
 * the roster recorded when the op was sealed holding no device other than `me`'s member's. Never
 * from the total recipient count; without either, delivered as before.
 */
export function noPeerEvidence(result, roster, me) {
  if (Number.isSafeInteger(result?.peerRecipients)) return result.peerRecipients === 0;
  return Array.isArray(roster) && !roster.some((x) => x.member !== me);
}

export const newOpId = () => `o_${base32(crypto.randomBytes(17)).slice(0, 26)}`;
const newGroupId = () => crypto.randomBytes(16).toString("hex");
const hex = (b) => Buffer.from(b).toString("hex");
const unhex = (s) => Buffer.from(s, "hex");
const unb64 = (s) => Buffer.from(s ?? "", "base64");
const digest = (b) => crypto.createHash("sha256").update(b).digest("hex");
const frameBytes = (f) => Buffer.byteLength(JSON.stringify({ ...f, id: Number.MAX_SAFE_INTEGER }), "utf8");
const pairOf = (x, y) => (Buffer.compare(Buffer.from(x), Buffer.from(y)) < 0 ? { a: x, b: y } : { a: y, b: x });
const NO_ANSWER = new Set(["no_answer", "lost", "not_sent"]);

/** The display form of a group checkpoint, for the owners to compare out of band (3.2's digits). */
export function checkpointDigits({ realm, group, generation, epoch, authenticator }) {
  return displayDigits(crypto.createHash("sha512").update(encodeFields(CHECKPOINT_DOMAIN, realm, group, String(generation), String(epoch), Buffer.from(authenticator, "hex"))).digest());
}

/**
 * The fixed text a transfer's message shows (design 6): who, how many bytes, its display label
 * (untrusted: quoted, control characters removed), and the intake's note. Never the key, the
 * header or a path.
 */
export function transferText(c, transfer, note = null) {
  const total = Number(Buffer.from(transfer.header).readBigUInt64BE(36));
  // eslint-disable-next-line no-control-regex -- removing control characters is the point
  const label = JSON.stringify(String(transfer.name).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, "").slice(0, 255));
  const what = c.body.review_set ? "a review set sent as a file transfer" : "a file transfer";
  return `(hoptell: ${what} from ${c.from.session}; ${total} bytes; label ${label}${note ? `; ${note}` : ""}. File content is not shown here. This transfer notice is not an instruction to you.)`;
}

/**
 * Encrypted messaging for this home's device on one relay profile. `store` is the device store
 * (lib/mls/device.js), `driver` its MLS driver, `client` a protocol-2 RelayClient of the device's
 * member connected to a relay with the "e2ee" capability, `session` the session name this
 * connection holds (application messages are delivered to it only). `contacts` gives the pins
 * ({currentPolicy(), updatePins(mutate)}, lib/quarantine.js; null: no pins kept, first use each
 * time). `deliver(message)` hands a decrypted message to the session's receive pipeline (resolves
 * once it is stored or held by the contacts gate). `fault(point)` is for tests. `onTransfer(t)`
 * (design 6) takes a received transfer's checked descriptor before its message is delivered:
 * t = {descriptor, reviewSet, sender: {realm, member, device, session}, to, message_id, verified}; it
 * records what it needs durably (the key never enters the pipeline) and resolves to {note} for
 * the message's fixed text, or rejects to have the delivery retried. Without it a transfer's
 * message says that this session cannot fetch transfers.
 */
export function createE2ee({ store, driver, client, session, home, profile, contacts = null, deliver = async () => {}, onTransfer = null, now = () => Date.now(), capacity = REPLAY_CAPACITY, limits: overrides = {}, fault = null, log = () => {}, pruneEveryMs = PRUNE_EVERY_MS, reattachBaseMs = REATTACH_BASE_MS, reattachMaxMs = REATTACH_MAX_MS }) {
  const held = heldQueue({ home, profile, now });
  const keeper = ownKeeper({ contacts, home, profile, now });
  const limits = { ...LIMITS, ...overrides };
  let chain = Promise.resolve();
  /** One operation of this process at a time (the device lock serializes processes). */
  const serial = (fn) => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => {});
    return run;
  };
  const deferred = new Map(); // delivery -> {frame, ack}: waiting for a Welcome or catch-up
  let listening = false;
  let retryTimer = null;
  let closed = false;
  const resendTimers = new Map(); // conversation -> the timer of its next reseal pass
  let freshTimer = null; // A2: the fresh-update check while attached
  let pruneTimer = null; // A10: the KeyPackage maintenance while the engine runs
  let started = false;
  /** A10: expired, unused KeyPackage private keys deleted (one device transaction); never fatal. */
  const prunePass = async (when) => {
    try {
      const r = await store.prune?.();
      if (r?.pruned || r?.orphans) log(`e2ee: deleted the private keys of ${r.pruned + r.orphans} expired, unused KeyPackage(s) (${when})`);
      return r ?? null;
    } catch (e) {
      log(`e2ee: KeyPackage pruning failed (${when}): ${e.message}`);
      return null;
    }
  };

  // The freshness contract of the relay's device lists: one answer is reused only within the
  // sealing of one message (sendLogical: its trust gate and its group's roster check judge the same
  // answer, which halves the device requests against the relay's per-connection rate limit), never
  // across messages. Every message asks again, so a device enrolled or revoked while a fan-out, a
  // recovery or a replacement's reseals are under way is seen by the next message sealed. Each
  // message's gate judges the answer against the current pins.
  let deviceMemo = null;
  const deviceList = async (member) => {
    const key = member ?? "";
    if (deviceMemo?.has(key)) return deviceMemo.get(key);
    const r = await ask({ type: "device_list", member });
    deviceMemo?.set(key, r);
    return r;
  };
  /** Run `fn` again while the relay answers rate_limited (a fan-out's requests, paced). */
  const paced = async (fn) => {
    for (let i = 0; ; i++) {
      try {
        return await fn();
      } catch (e) {
        if (e.code !== "rate_limited" || i >= PACE_TRIES) throw e;
        await new Promise((r) => setTimeout(r, PACE_MS));
      }
    }
  };
  const ask = async (frame) => {
    try {
      return await client.rpc(frame);
    } catch (e) {
      throw new E2eeError(e.message, e.code ?? e.kind ?? "relay", { kind: e.kind, group: e.group, generation: e.generation });
    }
  };
  const S = (rec) => {
    rec.e2ee ??= {};
    const s = rec.e2ee;
    for (const k of ["groups", "conversations", "committer", "outbox", "logical", "replay", "inbound", "checkpoints", "fanout"]) s[k] ??= {};
    s.notices ??= [];
    return s;
  };
  const tx = (fn, opts) =>
    store.transact(async (ctx) => {
      checkGroups(ctx.dev);
      const s = S(ctx.rec);
      const me = { realm: ctx.rec.realm, member: ctx.rec.member, device: ctx.rec.device };
      return fn({ ...ctx, s, me });
    }, opts);
  const notice = (s, text) => {
    s.notices = [...s.notices, { at: now(), text }].slice(-NOTICES_KEPT);
    log(`e2ee: ${text}`);
  };
  const groupOf = (ctx, gid) => {
    const g = ctx.dev.group(unhex(gid));
    if (g) checkGroups(ctx.dev, g);
    return g;
  };
  /** Record the checkpoint of the group's current epoch (MI6). */
  const checkpoint = (ctx, gid, g, commitMls = null) => {
    const list = (ctx.s.checkpoints[gid] ??= []).filter((c) => c.epoch !== g.epoch());
    list.push({ epoch: g.epoch(), auth: hex(g.epochAuthenticator()), commit: commitMls ? digest(unb64(commitMls)) : null });
    ctx.s.checkpoints[gid] = list.sort((x, y) => x.epoch - y.epoch).slice(-CHECKPOINTS_KEPT);
  };

  // ---- whom a conversation's group holds (3.2's pins decide) -----------------------------------

  /**
   * Whether this home keeps pins: contacts given, and managed (a legacy-allow home cannot write
   * them; it is treated as having none: first use each time, as without contacts).
   */
  const pinsKept = () => Boolean(contacts?.updatePins) && !contacts.currentPolicy().legacy;

  /**
   * The relay's devices of contact `member` judged against the pins ({ev, accepted, revoked, pin}); first
   * use pins TOFU; accepted rotations and trusted revocations are written to the pins (a kept
   * revocation holds until the device's removal is accepted, whatever the relay serves later).
   * Never for this home's own member: its devices are judged by ownView, against the own pins.
   */
  async function view(member, realm) {
    const r = await deviceList(member);
    const doc = () => (pinsKept() ? contacts.currentPolicy().doc : null);
    let ev = evaluate(doc(), realm, member, r.devices);
    const fresh = ev.revoked.some((x) => x.trusted && !x.kept);
    if (pinsKept() && (ev.state === "first-use" || ev.rotated.length || fresh)) {
      await contacts.updatePins((d) => {
        if (ev.state === "first-use") return pinFirstUse(d, realm, member, ev.active);
        applyRotations(d, realm, member, ev.rotated);
        applyRevocations(d, realm, member, ev);
      });
      ev = evaluate(doc(), realm, member, r.devices);
    }
    const pin = pinOf(doc(), realm, member);
    // The devices a group may hold: active, pinned (all active ones on first use without pins),
    // not changed, not under a trusted revocation.
    const pinned = pin ? new Set(pin.devices.map((d) => d.device)) : null;
    const bad = new Set([...ev.changed.map((c) => c.device), ...ev.holdDevices]);
    const accepted = ev.active.filter((d) => (!pinned || pinned.has(d.device)) && !bad.has(d.device));
    return { ev, accepted, revoked: new Set(ev.revoked.map((x) => x.device)), pin };
  }

  /**
   * This home's own devices (A1): the relay's list of the own member judged against the own pins
   * in contacts.json, never the other way round (lib/mls/own.js evaluateOwn). Without the own
   * baseline nothing encrypts: an older home's baseline is written here once (the upgrade, under
   * the contacts lock); a home with two profiles' devices in the realm, or whose baseline names
   * another device, stops. Accepted rotations of own devices are written to the own pins, and an
   * own pin under a trusted revocation stops being one.
   */
  async function ownView(ctx) {
    if (!pinsKept()) throw new E2eeError("encrypted messages need this home's own-device baseline, kept in managed contacts: run hoptell contacts init, then hoptell device enroll", "no_baseline");
    const conflict = realmConflict(home, ctx.me.realm);
    if (conflict) throw new E2eeError(conflict, "realm_conflict");
    const doc = () => contacts.currentPolicy().doc ?? null;
    let entry;
    try {
      entry = ownOf(doc(), ctx.me.realm);
      if (!entry) {
        await keeper.ensure(ctx.rec);
        entry = ownOf(doc(), ctx.me.realm);
      }
    } catch (e) {
      throw new E2eeError(e.message, e.code ?? "no_baseline");
    }
    if (!entry || entry.profile !== profile || entry.member !== ctx.me.member || enrolledOf(entry)?.device !== ctx.me.device) {
      throw new E2eeError(`this home's own device in realm ${ctx.me.realm} is ${enrolledOf(entry)?.device ?? "not recorded"} (profile ${entry?.profile ?? "none"}), not this device ${ctx.me.device}: encryption stops (hoptell device enroll --new-baseline makes a new baseline)`, "baseline_mismatch");
    }
    const r = await deviceList(ctx.me.member);
    let ev = evaluateOwn(entry, ctx.me.realm, r.devices);
    if (ev.rotated.length || ev.registered.length || ev.revoked.some((x) => x.trusted && x.pinned)) {
      await contacts.updatePins((d) => {
        applyOwnRotations(d, ctx.me.realm, ev.rotated);
        markRegistered(d, ctx.me.realm, ev.registered); // A12: no longer awaiting its registration
        dropRevokedOwn(d, ctx.me.realm, ev.revoked);
      });
      ev = evaluateOwn(ownOf(doc(), ctx.me.realm), ctx.me.realm, r.devices);
    }
    noteOwn(ev);
    return ev;
  }
  /**
   * What the last look at the own devices found, for hoptell doctor (lib/mls/cli.js e2eeDoctor):
   * devices the relay lists that the owner has not accepted, own pins it no longer lists, key
   * changes. Public facts only (ids and fingerprints), in <home>/mls/<profile>/own-seen.json.
   */
  function noteOwn(ev) {
    try {
      writeOwnSeen(path.join(store.dir(), "own-seen.json"), ev, now()); // A12: compared with the file
    } catch (e) {
      log(`e2ee: what was seen of your own devices could not be recorded: ${e.message}`);
    }
  }

  /**
   * The device ids the conversation's group should hold, with their expected keys: the contact's
   * accepted devices and this home's own pins the relay serves with their pinned keys (A1: an own
   * device the relay lists but the owner has not accepted is never added).
   */
  async function desired(ctx, peer) {
    const theirs = await view(peer, ctx.me.realm);
    const own = await ownView(ctx);
    const mine = own.accepted.filter((d) => d.device !== ctx.me.device).map((d) => ({ member: ctx.me.member, device: d.device, key: d.key }));
    const out = [...theirs.accepted.map((d) => ({ member: peer, device: d.device, key: d.key })), ...mine];
    return { theirs, own, devices: out, revoked: new Set([...theirs.revoked, ...own.revoked.map((x) => x.device)]) };
  }

  /**
   * Devices removed by an accepted, merged commit: a kept revocation of a contact's device is
   * cleared (its one group with this device), one of this member's own devices only once no group
   * here still holds it.
   */
  async function removed(ctx, devices) {
    if (!pinsKept() || !devices.length) return;
    const holders = (device) => Object.entries(ctx.s.groups).some(([gid, G]) => G.state === "active" && groupOf(ctx, gid)?.members().some((m) => parseCredentialIdentity(m.identity)?.device === device));
    const clear = devices.filter((d) => d.member !== ctx.me.member || !holders(d.device));
    if (!clear.length) return;
    await contacts.updatePins((doc) => {
      for (const d of clear) {
        if (d.member !== ctx.me.member) retireRemovedDevice(doc, ctx.me.realm, d.member, d.device);
        else {
          // An own device removed from every group here (it was revoked): it leaves the own
          // records (an unconfirmed one, or a revoked own pin; never the enrolled device).
          forgetRemovedOwn(doc, ctx.me.realm, d.device);
          const e = doc.own?.[ctx.me.realm];
          if (e) e.devices = e.devices.filter((x) => x.device !== d.device || x.how === "enrolled");
        }
      }
    }).catch((e) => log(`e2ee: the pins could not be updated after a removal: ${e.message}`));
  }

  // ---- the committer (MI2) ---------------------------------------------------------------------

  async function abandon(ctx, reservations) {
    for (const reservation of reservations ?? []) await ask({ type: "kp_abandon", device: ctx.me.device, reservation }).catch(() => {});
  }

  /** Take and check one KeyPackage per target device; returns {kps, reservations}. */
  async function takeAll(ctx, op, targets) {
    const kps = [];
    const reservations = [];
    for (const t of targets) {
      // The request id derives from the op id: a retry of the same commit takes the same package.
      const r = await ask({ type: "kp_take", request: `${op}-${t.device}`, device: ctx.me.device, target: { member: t.member, device: t.device } });
      const kp = unb64(r.kp);
      checkKeyPackage(driver, { realm: ctx.me.realm, member: t.member, device: t.device, key: t.key }, kp, now());
      kps.push(kp);
      reservations.push(r.reservation);
    }
    return { kps, reservations };
  }

  /**
   * Bring the committer record of group `gid` to an end: publish (again) the exact bundle, then
   * merge on acceptance, clear on a conflict (the winner is then processed like any commit), and
   * leave it as it is when there is no answer (a later call publishes the same op id again).
   */
  async function runCommitter(ctx, gid) {
    const c = ctx.s.committer[gid];
    if (!c || c.phase === "merged" || c.phase === "cleared") return c ?? null;
    const g = groupOf(ctx, gid);
    if (!g) throw new E2eeError("a committer record without its group", "bad_state");
    if (c.phase === "prepared") {
      c.phase = "published"; // from here on the relay may have it: never discarded silently
      ctx.write();
    }
    let r;
    try {
      r = await ask(c.frame);
    } catch (e) {
      if (NO_ANSWER.has(e.code) || NO_ANSWER.has(e.kind) || e.code === "unavailable") throw new E2eeError(`no answer for the commit (${e.message}); it is published again later with the same operation id`, "no_answer");
      await g.clearPending();
      c.phase = "cleared";
      c.refused = e.code;
      if (ctx.s.groups[gid]?.state === "pending") ctx.s.groups[gid].state = "abandoned";
      await ctx.save();
      await abandon(ctx, c.frame.kp_reservations);
      throw e;
    }
    fault?.("commit-after-answer");
    const G = ctx.s.groups[gid];
    const won = c.kind === "commit" ? r.state === "accepted" : r.created === true && r.group === gid;
    if (won) {
      await g.mergePending();
      c.phase = "merged";
      c.result = r;
      let resealAfter = null;
      if (c.kind === "commit") {
        Object.assign(G, { epoch: g.epoch(), position: r.position });
        c.removedDevices = (c.frame.roster_delta.remove ?? []).map((device) => ({ device, member: c.removedMembers?.[device] ?? G.peer }));
        ownMerged(ctx, G, c, g);
      }
      else {
        Object.assign(G, { generation: r.generation, epoch: g.epoch(), position: 0, state: "active" });
        startFresh(G, g);
        const prev = ctx.s.conversations[G.peer];
        if (prev && prev !== gid && ctx.s.groups[prev]) {
          ctx.s.groups[prev].state = "replaced";
          // Messages sent into the replaced group are sealed again (same ids, created, expires).
          for (const L of Object.values(ctx.s.logical)) if (L.peer === G.peer && L.group === prev && L.state === "sent") L.state = "resend";
          resealAfter = G.conversation;
        }
        ctx.s.conversations[G.peer] = gid;
      }
      checkpoint(ctx, gid, g, c.kind === "commit" ? c.frame.mls : null);
      await ctx.save(); // the merge and the phase change, together
      fault?.("commit-after-merge");
      // Whichever path replaced the group (replace(), or a send or update that found it broken or
      // too far behind): queued after this operation, once its transaction has ended. A crash
      // before this leaves them "resend", sealed again by recover().
      if (resealAfter) resendPending(resealAfter);
      await removed(ctx, c.removedDevices ?? []);
      return c;
    }
    // Lost: another commit (or another group) won. Our reservations stay unconsumed and burn.
    await g.clearPending();
    c.phase = "cleared";
    c.result = r;
    if (c.kind !== "commit") {
      G.state = "abandoned";
      if (r.group && ctx.s.groups[r.group]) ctx.s.conversations[G.peer] = r.group;
    }
    await ctx.save();
    await abandon(ctx, c.frame.kp_reservations);
    if (c.kind === "commit") await catchUp(ctx, gid);
    return c;
  }

  /** Prepare a commit (adds and removes), persist it with the state, then run it. */
  async function commitChange(ctx, gid, { add = [], remove = [], update = false }) {
    const g = groupOf(ctx, gid);
    const members = g.members().map((m) => ({ ...m, id: parseCredentialIdentity(m.identity) }));
    const indexes = remove.map((device) => members.find((m) => m.id?.device === device)?.index).filter((i) => i !== undefined);
    const op = newOpId();
    const { kps, reservations } = await takeAll(ctx, op, add);
    const out = await g.commit({ add: kps, remove: indexes, update });
    const frame = {
      type: "send_e2ee", kind: "commit", op, device: ctx.me.device, group: gid, expected_epoch: g.epoch(), mls: b64(out.commit),
      roster_delta: { add: add.map((t) => t.device), remove: members.filter((m) => indexes.includes(m.index)).map((m) => m.id.device) },
      ...(out.welcome ? { welcome: { recipients: add.map((t) => t.device), mls: b64(out.welcome), ratchet_tree: b64(out.ratchetTree) } } : {}),
      kp_reservations: reservations,
    };
    if (frameBytes(frame) > MAX_FRAME_BYTES) {
      await g.clearPending();
      await abandon(ctx, reservations);
      throw new E2eeError(`the commit bundle would need ${frameBytes(frame)} bytes; at most ${MAX_FRAME_BYTES} (it is refused, not split)`, "too_large");
    }
    const removedMembers = Object.fromEntries(members.filter((m) => indexes.includes(m.index)).map((m) => [m.id.device, m.id.member]));
    ctx.s.committer[gid] = { kind: "commit", op, phase: "prepared", frame, removedMembers, at: now(), ...(update ? { update: true } : {}) };
    await ctx.save(); // the pending commit (in the library state), the bundle and the op id
    fault?.("commit-after-persist");
    return runCommitter(ctx, gid);
  }

  /** A new group for the conversation with `peer` (group_create), or its replacement (group_replace). */
  async function newGroup(ctx, peer, devices, { expectedGeneration = null } = {}) {
    const targets = devices.filter((d) => d.device !== ctx.me.device);
    if (!targets.some((d) => d.member === peer)) throw new E2eeError(`no device of ${peer} can be reached with encryption (none enrolled, accepted or with a KeyPackage)`, "no_device");
    // A6: a new group (a first conversation or a replacement) only from a driver that makes it with
    // the policy's skipped-key bounds, checked before anything reaches the relay; and the created
    // group's own bounds checked before it is announced or used. On a mismatch the group is never
    // announced, and the transaction ends without saving it.
    boundsReplaceable();
    const gid = newGroupId();
    const op = newOpId();
    const g = await ctx.dev.createGroup(unhex(gid));
    checkGroups(ctx.dev, g);
    if (!groupBoundsOk(g)) throw new E2eeError(`the new group does not apply the required skipped-key bounds (${MAX_SKIPPED_PER_SENDER_EPOCH} per sender and epoch, ${MAX_FORWARD_GENERATIONS} ahead); it is discarded and nothing is sent`, "skip_limits");
    let taken;
    try {
      taken = await takeAll(ctx, op, targets);
    } catch (e) {
      throw new E2eeError(`a KeyPackage could not be taken: ${e.message}`, e.code ?? "no_key_package");
    }
    const out = await g.commit({ add: taken.kps });
    const frame = {
      type: expectedGeneration === null ? "group_create" : "group_replace", op, device: ctx.me.device, peer, group: gid, epoch: g.epoch() + 1,
      ...(expectedGeneration === null ? {} : { expected_generation: expectedGeneration }),
      welcome: { recipients: targets.map((t) => t.device), mls: b64(out.welcome), ratchet_tree: b64(out.ratchetTree) },
      kp_reservations: taken.reservations,
    };
    if (frameBytes(frame) > MAX_FRAME_BYTES) {
      await abandon(ctx, taken.reservations);
      throw new E2eeError(`the group's Welcome bundle would need ${frameBytes(frame)} bytes; at most ${MAX_FRAME_BYTES}`, "too_large");
    }
    ctx.s.groups[gid] = { peer, conversation: pairOf(ctx.me.member, peer), generation: null, epoch: 0, position: 0, state: "pending", created: now() };
    ctx.s.committer[gid] = { kind: expectedGeneration === null ? "create" : "replace", op, phase: "prepared", frame, at: now() };
    await ctx.save();
    fault?.("commit-after-persist");
    await runCommitter(ctx, gid);
    return ctx.s.conversations[peer] ?? null;
  }

  // ---- the skipped-key bounds (design 3.2 v2.2, A6) ---------------------------------------------

  /** Whether bounds {perSenderEpoch, forward} are policy.js's (null, unknown: not). */
  const boundsOk = (l) => Boolean(l) && l.perSenderEpoch === MAX_SKIPPED_PER_SENDER_EPOCH && l.forward === MAX_FORWARD_GENERATIONS;
  /** Whether group `g` applies the policy's skipped-key bounds (a group without the query: unknown, not). */
  const groupBoundsOk = (g) => typeof g?.skipLimits === "function" && boundsOk(g.skipLimits());
  /**
   * A group made by an earlier binding keeps its own bounds (5 and 1000 for manifest 4's): it is
   * replaced before more application traffic, but only by a driver whose new groups apply the
   * policy's bounds (otherwise a replacement would not help, and encrypted messaging stops).
   */
  function boundsReplaceable() {
    if (typeof driver.skipLimits === "function" && boundsOk(driver.skipLimits())) return true;
    throw new E2eeError(`this MLS binding does not apply the required skipped-key bounds (${MAX_SKIPPED_PER_SENDER_EPOCH} per sender and epoch, ${MAX_FORWARD_GENERATIONS} ahead) to new groups; encrypted messages stop until it does`, "skip_limits");
  }

  // ---- the fresh-update policy (design 3.2 v2.2, A2) ---------------------------------------------

  /**
   * A group's freshness fields. A record from before A2 gets them from its creation or join: the
   * age clock, and (given the group `g`) every current roster device without an entry counted as
   * last updated then, so the stale-member clock keeps running; later timestamps are kept.
   */
  function freshOf(G, g = null) {
    G.lastOwnUpdate ??= G.joined ?? G.created ?? now();
    G.updates ??= {};
    if (g) {
      const base = G.joined ?? G.created ?? G.lastOwnUpdate;
      for (const m of g.members()) {
        const id = parseCredentialIdentity(m.identity);
        if (id && G.updates[id.device] === undefined) G.updates[id.device] = base;
      }
    }
    return G;
  }
  /** A new or joined group: the age clock starts, every member's leaf counts as fresh. */
  function startFresh(G, g) {
    Object.assign(G, { lastOwnUpdate: now(), updates: {} });
    delete G.activeSince;
    delete G.removalAt;
    for (const m of g.members()) {
      const id = parseCredentialIdentity(m.identity);
      if (id) G.updates[id.device] = now();
    }
  }
  /** Activity since the last own update (an accepted outbound or processed inbound message). */
  function active(G) {
    if (!G) return;
    freshOf(G);
    G.activeSince ??= now();
  }
  /** This device's own commit, merged after acceptance. */
  function ownMerged(ctx, G, c, g) {
    freshOf(G, g);
    const removed = c.frame.roster_delta?.remove ?? [];
    for (const d of removed) delete G.updates[d];
    for (const d of c.frame.roster_delta?.add ?? []) G.updates[d] = now();
    if (removed.length) G.removalAt = now();
    if (c.update || removed.length) G.updates[ctx.me.device] = now();
    if (c.update || removed.length) {
      // An own commit that replaces this device's leaf moves the age clock (A2): an update, or a
      // removal (RFC 9420 requires an UpdatePath for a commit with Remove proposals).
      G.lastOwnUpdate = now();
      delete G.activeSince;
      delete G.removalAt;
    }
  }
  /**
   * A received commit, merged: its added devices' leaves are new; the committer's leaf is replaced
   * by its UpdatePath unless the commit only adds (OpenMLS commits that add carry no path).
   */
  function receivedMerged(G, p, g) {
    freshOf(G, g);
    const ids = (list) => list.map((m) => parseCredentialIdentity(m.identity)).filter(Boolean);
    const removed = ids(p.removed ?? []);
    const added = ids(p.added ?? []);
    for (const x of removed) delete G.updates[x.device];
    for (const x of added) G.updates[x.device] = now();
    if (removed.length) G.removalAt = now();
    const sender = parseCredentialIdentity(p.sender?.identity ?? Buffer.alloc(0));
    if (sender && (removed.length || !added.length)) G.updates[sender.device] = now();
  }
  /** Whether group `gid` owes an update now (`sending`: an outbound message is being attempted). */
  function due(ctx, gid, sending) {
    const G = ctx.s.groups[gid];
    if (!G || G.state !== "active") return { due: false };
    freshOf(G, groupOf(ctx, gid));
    return updateDue({ lastOwnUpdate: G.lastOwnUpdate, activeSince: G.activeSince ?? null, sending, removal: G.removalAt !== undefined, rotatedAt: ctx.rec.rotatedAt ?? null }, now());
  }
  /**
   * The update a group owes, as one committer operation (A2): an unfinished commit of the group is
   * brought to its end first (a lost answer or a crash resumes that same op; never a second update
   * for the same due point), then, when still due, one update commit. Returns the committer record,
   * or null when nothing was owed.
   */
  async function freshen(ctx, gid, { sending = false } = {}) {
    const c = ctx.s.committer[gid];
    if (c && (c.phase === "prepared" || c.phase === "published")) await runCommitter(ctx, gid);
    const d = due(ctx, gid, sending);
    if (!d.due) return null;
    log(`e2ee: an update is due in the conversation with ${ctx.s.groups[gid].peer} (${d.reason})`);
    return commitChange(ctx, gid, { update: true });
  }
  /** Members (devices of others) whose last update in group G is older than 30 days. */
  const staleOf = (G, me, g) => staleMembers(Object.fromEntries(Object.entries(freshOf(G, g).updates).filter(([d]) => d !== me)), now());

  // ---- applying the commit log ------------------------------------------------------------------

  /** Why a processed commit disagrees with its log entry or the pins (null when it agrees). */
  function crossCheck(ctx, G, p, entry) {
    const conv = [G.conversation.a, G.conversation.b];
    const ids = (list) => list.map((m) => parseCredentialIdentity(m.identity));
    const sender = parseCredentialIdentity(p.sender?.identity ?? Buffer.alloc(0));
    if (!sender || sender.realm !== ctx.me.realm || sender.member !== entry.from_member || sender.device !== entry.from_device) return "the commit's authenticated sender is not the relay's sender";
    const added = ids(p.added);
    const removed = ids(p.removed);
    if (added.some((x) => !x) || removed.some((x) => !x)) return "a member of the commit is not a hoptell device";
    const same = (xs, ys) => xs.length === ys.length && [...xs].sort().every((x, i) => x === [...ys].sort()[i]);
    if (!same(added.map((x) => x.device), entry.roster_delta?.add ?? [])) return "the roster delta's additions disagree with the commit";
    if (!same(removed.map((x) => x.device), entry.roster_delta?.remove ?? [])) return "the roster delta's removals disagree with the commit";
    for (const c of p.credentials ?? []) {
      const id = parseCredentialIdentity(c.identity);
      if (!id || id.realm !== ctx.me.realm || !conv.includes(id.member)) return "the commit brings in a device of neither member";
    }
    return null;
  }

  /**
   * Whether the owner's pins admit device `id` ({member, device}) with signature key `key` into a
   * group this device is in (MII2): null when they do; {defer} while the owner's decision is
   * pending (not pinned yet: a new device, or a contact with no decision yet under
   * requireVerified); {refuse} for a device under a kept trusted revocation or with another key
   * than the pinned one. Without pins kept (no contacts) every device is first use. Call after
   * refreshPins, so first use is pinned (TOFU) only for a member's very first device set.
   */
  function admits(ctx, id, key) {
    if (id.member === ctx.me.member && id.device === ctx.me.device) return null;
    if (id.member === ctx.me.member) {
      // This home's own devices (A1): only own pins, never the relay's list or the contact pins.
      if (!pinsKept()) return { refuse: "this home keeps no own-device baseline (managed contacts are needed)" };
      const own = ownOf(contacts.currentPolicy().doc ?? null, ctx.me.realm);
      const od = own?.devices.find((d) => d.device === id.device);
      if (!od) return { defer: `device ${id.device} of yours is not accepted (hoptell device accept ${id.device} on one of your devices, or revoke it)` };
      if (key && !unb64(od.key).equals(Buffer.from(key))) return { refuse: `your device ${id.device} appears with another key than the one pinned` };
      return null;
    }
    if (!pinsKept()) return null;
    const pin = pinOf(contacts.currentPolicy().doc ?? null, ctx.me.realm, id.member);
    if (!pin) return { defer: `no decision about the devices of ${id.member} yet` };
    if ((pin.revoked ?? []).some((r) => r.device === id.device)) return { refuse: `device ${id.device} of ${id.member} is revoked` };
    const pd = pin.devices.find((d) => d.device === id.device);
    if (!pd) return { defer: `device ${id.device} of ${id.member} waits for the owner's decision` };
    if (key && !unb64(pd.key).equals(Buffer.from(key))) return { refuse: `device ${id.device} appears with another key than the one pinned` };
    return null;
  }
  /** The first of the devices' admission verdicts that is not null (refusals first). */
  const admitAll = (ctx, list) => {
    const out = list.map((x) => (x.id ? admits(ctx, x.id, x.key) : { refuse: "a member of the group is not a hoptell device" })).filter(Boolean);
    return out.find((x) => x.refuse) ?? out[0] ?? null;
  };
  /**
   * The current evaluation of both members' devices written to the pins (first use, rotations,
   * trusted revocations) before a commit or Welcome is judged; throws when it cannot be made.
   */
  async function refreshPins(ctx, members) {
    for (const m of new Set(members)) {
      if (m === ctx.me.member) await ownView(ctx).catch((e) => {
        throw new E2eeError(`the trust decision for your own devices cannot be made now (${e.message})`, e.code === "no_answer" ? "trust_unavailable" : e.code);
      });
      else if (pinsKept()) await holdIn(m, ctx.me.realm);
    }
  }

  /**
   * A commit this device refuses: the group needs a replacement; the owner and the relay are told.
   * Only hoptell's own records are written (ctx.write): the library state is never saved for a
   * refused entry (A7: a standalone proposal in the log, or anything that did not validate, leaves
   * nothing of itself behind; the binding restored its snapshot, and what an older binding may
   * have advanced in memory is not persisted here).
   */
  async function invalid(ctx, gid, entry, why) {
    const G = ctx.s.groups[gid];
    G.state = "broken";
    G.invalid = { epoch: entry.epoch, why, at: now() };
    notice(ctx.s, `a commit for epoch ${entry.epoch} of the conversation with ${G.peer} was refused (${why}); the conversation is recovered by a replacement group`);
    ctx.write();
    await ask({ type: "commit_invalid", device: ctx.me.device, group: gid, epoch: entry.epoch, reason: why }).catch(() => {});
  }

  /**
   * Apply one log entry {position, epoch (expected), op, from_member, from_device, mls,
   * roster_delta} to group `gid`. Returns "merged" | "own" | "old" | "ahead" | "invalid" | "unknown".
   * Saves what it changed.
   */
  async function applyEntry(ctx, gid, entry) {
    const G = ctx.s.groups[gid];
    const g = groupOf(ctx, gid);
    if (!G || !g || G.state === "pending" || G.state === "abandoned") return "unknown";
    const local = g.epoch();
    if (entry.epoch < local) {
      // Already past this epoch: the history the relay serves must be the one accepted here.
      const cp = (ctx.s.checkpoints[gid] ?? []).find((x) => x.epoch === entry.epoch + 1);
      if (cp?.commit && cp.commit !== digest(unb64(entry.mls))) {
        G.fork = { epoch: entry.epoch + 1, at: now(), seen: digest(unb64(entry.mls)), accepted: cp.commit };
        notice(ctx.s, `fork suspected in the conversation with ${G.peer}: the relay's commit for epoch ${entry.epoch} differs from the one this device accepted; compare checkpoints with hoptell contacts verify ${G.peer} --conversation`);
        await ctx.save();
      }
      return "old";
    }
    if (entry.epoch > local) return "ahead";
    const c = ctx.s.committer[gid];
    if (c?.kind === "commit" && (c.phase === "prepared" || c.phase === "published") && c.frame.expected_epoch === entry.epoch) {
      if (c.frame.op === entry.op && entry.from_device === ctx.me.device) {
        // Our own commit, accepted (its answer was lost): merge it, never process it.
        await g.mergePending();
        Object.assign(c, { phase: "merged", result: { state: "accepted", position: entry.position } });
        Object.assign(G, { epoch: g.epoch(), position: entry.position });
        ownMerged(ctx, G, c, g);
        c.removedDevices = (c.frame.roster_delta?.remove ?? []).map((device) => ({ device, member: c.removedMembers?.[device] ?? G.peer }));
        checkpoint(ctx, gid, g, entry.mls);
        await ctx.save();
        // As after an answered commit: the removed devices' kept revocations are cleared.
        await removed(ctx, c.removedDevices);
        return "own";
      }
      await g.clearPending();
      Object.assign(c, { phase: "cleared", result: { state: "conflict", winner: { position: entry.position, op: entry.op } } });
      await ctx.save();
      await abandon(ctx, c.frame.kp_reservations);
    }
    if (entry.from_device === ctx.me.device) {
      await invalid(ctx, gid, entry, "a commit of this device that it has no record of");
      return "invalid";
    }
    let p;
    try {
      p = await g.process(unb64(entry.mls));
    } catch (e) {
      await invalid(ctx, gid, entry, `it does not validate (${e.message})`);
      return "invalid";
    }
    if (p.kind !== "commit") {
      // A standalone proposal (or anything else): refused, nothing of it saved (A7, row 11).
      await invalid(ctx, gid, entry, `not a commit (${p.kind})`);
      return "invalid";
    }
    const adm = admitAll(ctx, (p.credentials ?? []).map((c) => ({ id: parseCredentialIdentity(c.identity), key: c.signatureKey })));
    const why = crossCheck(ctx, G, p, entry) ?? adm?.refuse ?? null;
    if (why) {
      await p.discard();
      await invalid(ctx, gid, entry, why);
      return "invalid";
    }
    if (adm?.defer) {
      // Not merged until the owner decides (a refusal would only lead to a replacement the peer
      // fills the same way): the state stays as before this commit; it is processed again later.
      await p.discard();
      if (G.pending?.epoch !== entry.epoch) {
        G.pending = { epoch: entry.epoch, why: adm.defer, at: now() };
        notice(ctx.s, `a commit of the conversation with ${G.peer} waits: ${adm.defer} (hoptell contacts accept-device or verify)`);
        await ctx.save();
      }
      return "pending";
    }
    delete G.pending;
    await p.merge();
    fault?.("commit-receive-after-merge"); // checklist row 8: merged in memory, not saved yet
    Object.assign(G, { epoch: g.epoch(), position: entry.position });
    receivedMerged(G, p, g);
    if (!g.isActive()) G.state = "removed";
    checkpoint(ctx, gid, g, entry.mls);
    await ctx.save();
    await removed(ctx, p.removed.map((m) => parseCredentialIdentity(m.identity)).filter(Boolean));
    return "merged";
  }

  /** Fetch and apply the log from the group's epoch on. */
  async function catchUp(ctx, gid) {
    for (let rounds = 0; rounds < 100; rounds++) {
      const g = groupOf(ctx, gid);
      const G = ctx.s.groups[gid];
      if (!g || !G || G.state !== "active") return;
      let r;
      try {
        r = await ask({ type: "commits_since", device: ctx.me.device, group: gid, epoch: g.epoch() });
      } catch (e) {
        if (e.code === "too_far_behind") {
          G.state = "behind";
          notice(ctx.s, `this device fell too far behind in the conversation with ${G.peer}; it is recovered by a replacement group`);
          await ctx.save();
          return;
        }
        if (e.code === "not_member") {
          // Out of the routing roster: removed by a commit whose notification was coalesced away
          // (the relay keeps the newest per group); a new message replaces the group if needed.
          G.state = "removed";
          notice(ctx.s, `this device is no longer in the conversation with ${G.peer}'s group; the next message replaces it`);
          await ctx.save();
          return;
        }
        throw e;
      }
      // A restored relay's rolled-back log is not applied: the group is replaced (ensureGroup).
      if (r.replace_required) return;
      for (const entry of r.entries) {
        const res = await applyEntry(ctx, gid, entry);
        if (res === "invalid" || res === "unknown" || res === "ahead" || res === "pending") return;
      }
      if (!r.more) return;
    }
  }

  // ---- the conversation's group ----------------------------------------------------------------

  /**
   * The current group of the conversation with `peer`, created, caught up, replaced or updated as
   * needed so that it holds exactly the accepted devices (removals of revoked devices merged
   * before anything is sent). Returns the group id only once this device's state of it is usable
   * at the relay's epoch (MII11): a catch-up that has not reached it (a commit waiting for the
   * owner's decision, an own new device's admission among them) holds sending
   * ("held_for_catch_up"), never seals in an epoch the peer has left.
   */
  async function ensureGroup(ctx, peer) {
    // Unfinished commits first (a restart between publication and answer).
    for (const [gid, c] of Object.entries(ctx.s.committer)) if (ctx.s.groups[gid]?.peer === peer && (c.phase === "prepared" || c.phase === "published")) await runCommitter(ctx, gid);
    const want = await desired(ctx, peer);
    const cur = await ask({ type: "conversation", peer });
    if (!cur.group) return newGroup(ctx, peer, want.devices);
    let G = ctx.s.groups[cur.group];
    if (!G || !groupOf(ctx, cur.group)) {
      throw new E2eeError(`the conversation with ${peer} has a group this device is not in yet; its Welcome may be on the way (try again shortly)`, "not_joined");
    }
    ctx.s.conversations[peer] = cur.group;
    // The relay's store was restored (design 4.4): its log was rolled back and the devices' epochs
    // may have diverged from it, so nothing is caught up or sealed there; the group is replaced
    // like a broken one, and messages sent into it are sealed again in the new generation.
    if (cur.replace_required) {
      try {
        return await newGroup(ctx, peer, want.devices, { expectedGeneration: cur.generation });
      } catch (e) {
        if (e.code === "stale_generation") throw new E2eeError("the conversation was replaced meanwhile; its Welcome is on the way (try again shortly)", "not_joined");
        throw e;
      }
    }
    if (G.state === "active" && cur.epoch > groupOf(ctx, cur.group).epoch()) await catchUp(ctx, cur.group);
    G = ctx.s.groups[cur.group];
    // A6: a group whose skipped-key bounds are not the policy's (or unknown) is replaced first.
    const outOfBounds = G.state === "active" && !G.fork && !groupBoundsOk(groupOf(ctx, cur.group)) && boundsReplaceable();
    if (outOfBounds) notice(ctx.s, `the conversation with ${peer} was made by an earlier MLS binding with other skipped-key bounds; it is replaced by a new group`);
    if (G.state !== "active" || G.fork || outOfBounds) {
      // Broken (a refused commit), too far behind, forked, removed, or out of bounds: a replacement group.
      try {
        return await newGroup(ctx, peer, want.devices, { expectedGeneration: G.generation });
      } catch (e) {
        if (e.code === "stale_generation") throw new E2eeError("the conversation was replaced meanwhile; its Welcome is on the way (try again shortly)", "not_joined");
        throw e;
      }
    }
    const g = groupOf(ctx, cur.group);
    const inGroup = g.members().map((m) => parseCredentialIdentity(m.identity)).filter(Boolean);
    const add = want.devices.filter((d) => !inGroup.some((x) => x.device === d.device));
    // Removed: revoked devices (held until the removal is merged) and contact devices no longer
    // served. This home's own devices (A1): an own pin stays; an own device that is not one (an
    // unconfirmed device from the upgrade, or one a contact added) stops the conversation, no
    // send and no commit, until the owner accepts it or it is revoked (then it is removed).
    const keep = new Set([ctx.me.device, ...want.devices.map((d) => d.device)]);
    const ownPinned = new Set((want.own.entry?.devices ?? []).map((d) => d.device));
    const unaccepted = inGroup.filter((x) => x.member === ctx.me.member && x.device !== ctx.me.device && !ownPinned.has(x.device) && !want.revoked.has(x.device));
    if (unaccepted.length) {
      const ids = unaccepted.map((x) => x.device).join(", ");
      throw new E2eeError(`The conversation with ${peer} includes your device ${ids}, which your user has not accepted. Nothing is sent or committed until your user accepts it from another device (hoptell device accept ${unaccepted[0].device}) or revokes it.`, "held_own");
    }
    // A contact's device leaves only when revoked or no longer pinned (forgotten by the owner,
    // hoptell contacts forget-device): a pinned device the relay stops listing stays (A4: a
    // missing row is not a revocation; sending to that contact is held meanwhile).
    const peerPinned = new Set((want.theirs.pin?.devices ?? []).map((d) => d.device));
    const remove = inGroup.filter((x) => !keep.has(x.device) && (want.revoked.has(x.device) || (x.member === peer && !peerPinned.has(x.device)) || (x.member === ctx.me.member && !ownPinned.has(x.device)))).map((x) => x.device);
    const behind = () => {
      const P = ctx.s.groups[cur.group];
      if (P.pending) return `a commit of the conversation with ${peer} waits for the owner's decision (${P.pending.why})`;
      if (P.state !== "active" || g.epoch() < cur.epoch) return `this device has not caught up with the conversation with ${peer} (epoch ${g.epoch()}, the relay's ${cur.epoch})`;
      return null;
    };
    const wait = behind();
    if (wait) throw new E2eeError(`sending waits: ${wait}`, "held_for_catch_up");
    if (add.length || remove.length) {
      const c = await commitChange(ctx, cur.group, { add, remove });
      if (c?.phase !== "merged") {
        if (remove.length) throw new E2eeError(`sending waits until the removal of ${remove.join(", ")} is accepted and merged`, "held_for_removal");
        // Lost to another commit: caught up since (runCommitter), but maybe not to the relay's epoch.
        const lost = behind();
        if (lost) throw new E2eeError(`sending waits: ${lost}`, "held_for_catch_up");
      }
    }
    return cur.group;
  }

  // ---- sending -----------------------------------------------------------------------------------

  /**
   * Publish one sealed outbox entry (the exact ciphertext); the relay answers the same op once.
   * With `reconcile`, only learn the result of an earlier publication: the relay answers
   * {state: "cancelled"} when it never accepted it (and never will: reconcile-or-cancel), and
   * accepts nothing. Any other failure of a reconciliation keeps the entry ({state: "unsent"}).
   */
  async function publishApp(ctx, op, { reconcile = false } = {}) {
    const o = ctx.s.outbox[op];
    const L = ctx.s.logical[o.ref];
    if (!reconcile && o.phase !== "published") {
      o.phase = "published"; // from here on the relay may have it: reconciled by op id, never resealed blindly
      ctx.write();
    }
    let r;
    try {
      r = await ask(reconcile ? { ...o.frame, reconcile: true } : o.frame);
    } catch (e) {
      // A reconciliation that did not cancel leaves the relay free to accept the original later:
      // the entry stays (never dropped or resealed without a cancellation).
      if (reconcile || NO_ANSWER.has(e.code) || NO_ANSWER.has(e.kind) || e.code === "unavailable") return { state: "unsent", message_id: o.ref, reason: e.message, code: e.code ?? e.kind };
      delete ctx.s.outbox[op];
      if (e.code === "rate_limited" && (L?.fanout || L?.group)) {
        // Refused before the relay recorded the op id (its rate limit comes first): never
        // accepted. A fan-out copy, or a message accepted before and now sealed again (after a
        // replacement), is sealed again after a pause (fanout paces it; resendPending retries),
        // not failed.
        L.state = "resend";
        await ctx.save();
        return { state: "unsent", message_id: o.ref, reason: e.message, code: "rate_limited", limited: true };
      }
      if (e.code === "no_recipient" && L) {
        // The relay's second line (A4): refused before acceptance, nothing recorded there.
        L.state = "held";
        await ctx.save();
        return { state: "held", message_id: o.ref, reason: e.message };
      }
      if (e.code === "group_replaced" && L) {
        L.state = "resend";
        await ctx.save();
        return { state: "replaced", message_id: o.ref, group: e.group };
      }
      // A group a restored relay marked (design 4.4): not a failure; sealed again after its replacement.
      if (e.code === "replace_required" && L) {
        L.state = "resend";
        await ctx.save();
        return { state: "replace_required", message_id: o.ref, group: e.group };
      }
      if (L) {
        L.state = "failed";
        finalize(ctx, o.ref, finalOf(UNAVAILABLE_CODES.has(e.code) ? "unavailable" : "refused", { reason: e.code }));
      }
      await ctx.save(); // the terminal state and the copy's final result together
      throw e;
    }
    fault?.("send-after-publish");
    if (reconcile && r.state === "cancelled") return { state: "cancelled", message_id: o.ref };
    delete ctx.s.outbox[op];
    if (L && noPeer(ctx, r, o)) {
      // Accepted with no device of the contact (A4: an older relay, or a race): its exact result is
      // kept (a lost reply reconciles to it, never resent as this op), the message is reported not
      // delivered, and it is sealed again as a new op once the conversation holds a contact device.
      Object.assign(L, { state: "held", group: o.frame.group, undelivered: { op, result: r, group: o.frame.group, epoch: o.epoch ?? null, at: now() } });
      await ctx.save();
      return { state: "undelivered", message_id: o.ref, reason: `accepted by the relay with no device of ${L.peer} to receive it; sent again once one is in the conversation`, recipients: r.recipients };
    }
    if (L) delete L.undelivered;
    active(ctx.s.groups[o.frame.group]); // A2: activity, in the same write as the message's state
    // Accepted into a group replaced meanwhile (a reconciliation after the replacement): sealed
    // again in the current group, as a message sent before the replacement is (a device that never
    // joined the replaced group refuses its copy, MII8).
    if (L) {
      Object.assign(L, { state: ctx.s.groups[o.frame.group]?.state === "replaced" ? "resend" : "sent", group: o.frame.group });
      // A fan-out copy's first acceptance is its final result (a later reseal into a replacement
      // group is 3.3's delivery work, not a new state).
      finalize(ctx, o.ref, finalOf("accepted", { result: { state: "accepted", recipients: r.recipients } }));
    }
    ctx.write(); // the library state is unchanged since the seal; state and final result in one write
    return { state: "accepted", message_id: o.ref, recipients: r.recipients };
  }

  /**
   * Whether an accepted op reached no device of the contact (A4): the relay's peerRecipients is 0,
   * or, from a relay without it, the roster recorded when the op was sealed holds no device other
   * than this member's. Never inferred from the total recipient count.
   */
  const noPeer = (ctx, r, o) => noPeerEvidence(r, o.roster, ctx.me.member);

  /** Seal logical message `ref` in the conversation's current group and publish it. */
  async function sendLogical(ctx, ref, opts) {
    deviceMemo = new Map(); // this message's device lists (see deviceList)
    try {
      return await sealLogical(ctx, ref, opts);
    } finally {
      deviceMemo = null;
    }
  }
  async function sealLogical(ctx, ref, { tries = 2 } = {}) {
    const L = ctx.s.logical[ref];
    if (!L) throw new E2eeError("no such message", "unknown_message");
    // Failed and expired are terminal: never sealed again, whichever path asks (their reservation
    // is released, 4.3).
    if (TERMINAL.has(L.state)) throw new E2eeError(`the message is ${L.state}; it is never sealed again`, "terminal");
    const bytes = unb64(L.content);
    const c = decodeContent(bytes);
    if (outsideWindow(c, now())) {
      L.state = "expired";
      finalize(ctx, ref, finalOf("expired"));
      await ctx.save();
      throw new E2eeError("the message expired before it could be sent", "expired");
    }
    // The contact's current encryption policy, before every sealing (the first, a reseal, a
    // release): a contact whose encryption is now off gets nothing more. The message is refused,
    // never sent as plaintext instead; a copy's accepted result is kept as it was (finalize keeps
    // the first final).
    if (contacts && encryptionMode(contacts.currentPolicy().doc ?? null, ctx.me.realm, L.peer) === "off") {
      L.state = "failed";
      finalize(ctx, ref, finalOf("refused", { reason: "policy" }));
      await ctx.save();
      throw new E2eeError("encryption is off for this contact now; the message is not sent (and never as plaintext)", "policy");
    }
    const { theirs, own } = await desired(ctx, L.peer);
    if (own.stop) {
      // A key change of one of this home's own devices: nothing is sealed until the owner decides.
      L.state = "held";
      await ctx.save();
      return { state: "held", message_id: ref, reason: own.stop };
    }
    const verdict = gate(theirs.ev, held, { realm: ctx.me.realm, member: L.peer }).outbound({ ref });
    if (!verdict.deliver) {
      L.state = "held_key"; // in the held queue until the owner decides (releaseHeld)
      await ctx.save();
      return { state: "held", message_id: ref, reason: verdict.reason, line: held.line() };
    }
    let gid;
    try {
      gid = await ensureGroup(ctx, L.peer);
    } catch (e) {
      if (!["held_for_removal", "held_for_catch_up", "held_own", "not_joined", "no_answer"].includes(e.code)) {
        // A fan-out copy whose recipient has no device or KeyPackage, or cannot be reached: final
        // as "unavailable" (a direct send reports the error and keeps nothing).
        if (L.fanout && UNAVAILABLE_CODES.has(e.code)) {
          L.state = "failed";
          finalize(ctx, ref, finalOf("unavailable", { reason: e.code }));
          await ctx.save();
        }
        throw e;
      }
      // Not sent yet: recover() (or the Welcome or commit it waits for) sends it, sealed in the right group.
      L.state = e.code === "held_for_removal" || e.code === "held_own" ? "held" : "resend";
      await ctx.save();
      return { state: e.code === "no_answer" ? "unsent" : "held", message_id: ref, reason: e.message, ...(e.code === "no_answer" ? { code: "no_answer" } : {}) };
    }
    let g = gid && ctx.s.groups[gid]?.state === "active" ? groupOf(ctx, gid) : null;
    if (!g) {
      L.state = "resend";
      await ctx.save();
      return { state: "held", message_id: ref, reason: "the conversation's group is being set up; the message is sent once this device has joined it" };
    }
    // A2: an update this conversation owes goes first (an idle or offline device updates before
    // its next send); its answer lost: the message waits, and recovery finishes that same op.
    try {
      // An update that lost to another commit is tried once more at the caught-up epoch; a
      // message is never sealed while the update is still owed (it waits for the next pass).
      for (let i = 0; i < 2 && due(ctx, gid, true).due; i++) {
        await freshen(ctx, gid, { sending: true });
        if (ctx.s.groups[gid]?.state !== "active") break;
      }
      g = ctx.s.groups[gid]?.state === "active" ? groupOf(ctx, gid) : null;
      if (g && due(ctx, gid, true).due) {
        L.state = "resend";
        await ctx.save();
        return { state: "held", message_id: ref, reason: "an update of this conversation goes first and is not merged yet; the message is sent after it" };
      }
    } catch (e) {
      if (e.code !== "no_answer" && !NO_ANSWER.has(e.code)) throw e;
      L.state = "resend";
      await ctx.save();
      return { state: "unsent", message_id: ref, reason: e.message, code: "no_answer" };
    }
    if (!g) {
      L.state = "resend";
      await ctx.save();
      return { state: "held", message_id: ref, reason: "the conversation's group changed while it was updated; the message is sent once this device has caught up" };
    }
    // A4: an op whose roster holds no device of the target member is never submitted (the
    // sender's own other devices do not count): the message waits until a device of the
    // contact is in the conversation again.
    const roster = g.members().map((m) => parseCredentialIdentity(m.identity)).filter(Boolean).map((x) => ({ member: x.member, device: x.device }));
    if (!roster.some((x) => x.member === L.peer)) {
      L.state = "held";
      await ctx.save();
      return { state: "held", message_id: ref, reason: `no device of ${L.peer} is in the conversation now; the message waits until one is`, ...(L.undelivered ? { undelivered: true } : {}) };
    }
    // Accepted before with no device of the contact (A4): sealed again as a new op only once the
    // conversation was repaired (another epoch or group than the one it reached nobody in).
    if (L.undelivered && L.undelivered.group === gid && L.undelivered.epoch === g.epoch()) {
      L.state = "held";
      await ctx.save();
      return { state: "undelivered", message_id: ref, reason: `accepted by the relay with no device of ${L.peer} to receive it; sent again once the conversation changes` };
    }
    const op = newOpId();
    const frame = { type: "send_e2ee", kind: "app", op, device: ctx.me.device, group: gid, mls: b64(await g.encrypt(bytes, new Uint8Array())), target: L.target, ...(L.blobs ? { blobs: L.blobs } : {}) };
    // At most its reservation R (4.3: also after a release from held or a reseal in recovery), so
    // the outbox entry stays within the space reserved at admission.
    const bound = Math.min(MAX_FRAME_BYTES, L.reserve ?? MAX_FRAME_BYTES);
    if (frameBytes(frame) > bound) {
      L.state = "failed";
      finalize(ctx, ref, finalOf("refused", { reason: "too_large" }));
      await ctx.save();
      throw new E2eeError(`the encrypted message would need ${frameBytes(frame)} bytes; at most ${bound}`, "too_large");
    }
    // The roster the op is sealed for, durable with it (A4: the evidence for a relay without peerRecipients).
    ctx.s.outbox[op] = { ref, frame, phase: "sealed", at: now(), roster, epoch: g.epoch() };
    L.state = "sealed";
    await ctx.save(); // state and the exact ciphertext, before it is sent
    fault?.("send-after-persist");
    const r = await publishApp(ctx, op);
    // Marked by a restore since the conversation was read: the next round replaces the group first.
    if (r.state === "replace_required") return tries > 1 ? sendLogical(ctx, ref, { tries: tries - 1 }) : { state: "held", message_id: ref, reason: "the conversation's group is replaced after a restore of the relay; the message is sent there" };
    if (r.state === "replaced" && tries > 1) {
      // The group was replaced: once its Welcome is processed, the same logical message is sealed again.
      throw new E2eeError("the conversation's group was replaced; the message is sent again once this device has joined the new group", "not_joined", { ref });
    }
    return { ...r, unverified: !theirs.ev.verified };
  }

  /** Drop what has expired; returns whether a logical message or fan-out record changed. */
  function prune(ctx) {
    const t = now();
    let changed = false;
    for (const [k, until] of Object.entries(ctx.s.replay)) if (until <= t) delete ctx.s.replay[k]; // at expires + 5 min exactly
    for (const [d, x] of Object.entries(ctx.s.inbound)) if (t - x.at > INBOUND_KEEP_MS) delete ctx.s.inbound[d];
    const sealed = new Set(Object.values(ctx.s.outbox).map((o) => o.ref));
    for (const [ref, L] of Object.entries(ctx.s.logical)) {
      // Past its window and not sealed (a held copy nobody released, a resend that never found its
      // group): it can never be delivered, so it is expired (with its copy's final result).
      if (RESEALABLE.has(L.state) && L.state !== "sent" && !sealed.has(ref) && t >= L.expires + SKEW_MS) {
        L.state = "expired";
        finalize(ctx, ref, finalOf("expired"));
        changed = true;
      }
      if (["sent", "failed", "expired"].includes(L.state) && t >= L.expires + SKEW_MS) {
        delete ctx.s.logical[ref];
        changed = true;
      }
    }
    for (const [id, F] of Object.entries(ctx.s.fanout)) {
      if (F.done && t >= F.done + FANOUT_KEEP_MS) {
        delete ctx.s.fanout[id];
        changed = true;
      }
    }
    return changed;
  }

  /**
   * The completion hook (4.3): a fan-out copy's final result, recorded in the same write as its
   * logical message's terminal state (call before that write). The first final is kept.
   */
  function finalize(ctx, ref, final) {
    const L = ctx.s.logical[ref];
    const F = L?.fanout ? ctx.s.fanout[L.fanout] : null;
    const copy = F?.copies.find((c) => c.ref === ref);
    if (!copy || copy.final) return;
    copy.final = final;
    if (!inProgress(F)) F.done = now();
  }

  /** Refuse a new send at the retained-send-state bound (nothing is written). */
  function admitOrRefuse(ctx, add) {
    const full = admit(ctx.s, add, limits, { skewMs: SKEW_MS });
    if (!full) return;
    const when = full.retryAt ? ` (the oldest may be pruned at ${new Date(full.retryAt).toISOString()})` : "";
    throw new E2eeError(`this device keeps the most send state it may (${full.count} entries, ${full.bytes} bytes counted; at most ${limits.retainedEntries} and ${limits.retainedBytes}); nothing was sent${when}`, "storage_full", { retryAt: full.retryAt });
  }

  // ---- fan-out (4.3) -----------------------------------------------------------------------------

  /**
   * Whom a fan-out goes to: {addressed, candidates, excluded, copies: [{name, member}], names?}.
   * Pins are read, never written, for "@"-resolved candidates (an excluded first contact is not
   * pinned by being looked at); then the encryption check: a candidate that would get plaintext
   * under its policy ("off"), or that has no enrolled device, is excluded, as "not_encrypted"
   * ("preferred", "off") or "unavailable" ("required"). Never mixed: no plaintext copy.
   * Hosted custody (design 4.3's hosted-custody matrix, 4.5): the relay's `list` names a hosted
   * peer's custody and member id. An "@"-resolved hosted candidate is excluded before any copy
   * (selectRole); a hosted name in an explicit list is refused at preflight, as a direct send to
   * it is (excluded.refused), and never gets a copy or a logical message. While the relay's
   * hosted-custody fence is up, hosted members are absent from `list` and member_of answers as
   * for an unknown name, so they are neither candidates nor counted, or "unavailable" by name.
   */
  async function audience(ctx, to) {
    const doc = contacts?.currentPolicy().doc ?? null;
    const realm = ctx.me.realm;
    const memberOf = async (name) => {
      const r = await paced(() => ask({ type: "member_of", name }));
      return { member: r.member ?? null, hosted: r.custody === "hosted" };
    };
    const listed = async () => (await paced(() => ask({ type: "list" }))).peers ?? [];
    let sel;
    let names = null;
    if (typeof to === "string" && /^@/.test(to)) {
      const role = to.slice(1);
      const peers = (await listed()).filter((p) => p.name !== session && (role === "all" || (p.roles ?? []).includes(role)));
      const members = new Map();
      // A hosted peer's member id comes with its list entry (it has no devices to ask about).
      for (const p of peers) members.set(p.name, p.custody === "hosted" && typeof p.member_id === "string" ? p.member_id : (await memberOf(p.name)).member);
      sel = selectRole({ to, peers, members, doc, pins: pinsKept(), realm, me: { member: ctx.me.member, session } });
    } else if (Array.isArray(to) && to.length && to.every((n) => typeof n === "string")) {
      // Explicit names: within this relay (name or name@<this profile>), each once, as direct sends.
      const list = [...new Set(to.map((n) => {
        const [name, alias] = n.split("@");
        if (alias !== undefined && alias !== profile) throw new E2eeError(`${n} is on another relay; a fan-out stays within one relay`, "bad_request");
        return name;
      }))];
      sel = { candidates: list.length, targets: [], excluded: { first_contact: 0, not_encrypted: 0, unavailable: 0, refused: 0 } };
      names = list.map((name) => ({ name }));
      const hostedNames = new Set((await listed()).filter((p) => p.custody === "hosted").map((p) => p.name));
      for (const n of names) {
        const { member, hosted } = n.name === session ? { member: null, hosted: false } : await memberOf(n.name);
        if (!member || member === ctx.me.member) {
          // Unknown and unreachable alike (4.2), as a direct send answers.
          sel.excluded.unavailable++;
          n.state = "unavailable";
        } else if (hosted || hostedNames.has(n.name)) {
          // Hosted custody: the direct send's refusal; "allow-hosted" never applies inside a
          // fan-out (that direct send would go separately, as plaintext).
          sel.excluded.refused++;
          n.state = "refused";
          n.reason = encryptionMode(doc, realm, member) === "preferred" && allowsHosted(doc, realm, member) ? "hosted_separately" : "hosted_custody";
        } else sel.targets.push({ name: n.name, member });
      }
    } else throw new E2eeError("a fan-out goes to @role, @all or a list of session names", "bad_request");
    const copies = [];
    const devices = new Map();
    for (const t of sel.targets) {
      const mode = encryptionMode(doc, realm, t.member);
      if (mode !== "off" && !devices.has(t.member)) devices.set(t.member, ((await paced(() => deviceList(t.member))).devices ?? []).some((d) => d.key));
      const why = mode === "off" ? "not_encrypted" : devices.get(t.member) ? null : mode === "required" ? "unavailable" : "not_encrypted";
      const entry = names?.find((n) => n.name === t.name);
      if (why) {
        sel.excluded[why]++;
        if (entry) entry.state = why === "not_encrypted" ? "not-encrypted" : "unavailable";
        continue;
      }
      if (entry) entry.copy = copies.length;
      copies.push(t);
    }
    return { addressed: typeof to === "string" ? to : null, candidates: sel.candidates, excluded: sel.excluded, copies, names };
  }

  /**
   * Preflight, admission and the creation write of a fan-out: refused before any copy for more
   * than limits.copies copies, a copy's reservation R above the frame bound, their sum above
   * limits.bytes, limits.inProgress fan-outs still in progress, or the retained-send-state bound;
   * then the record and all of its copies' logical messages in one ctx.save().
   */
  async function create(ctx, { body, replyTo, sendOp, lifetimeMs, plan }) {
    const excluded = plan.excluded;
    // No copy: nothing to send. Without a send_op nothing could match a retry, so nothing is kept;
    // with one, the empty result is kept (final at once, counted, pruned like any record), so a
    // retry returns it instead of resolving the audience again.
    if (!plan.copies.length && sendOp === null) return { none: { id: null, addressed: plan.addressed, candidates: plan.candidates, excluded, copies: 0, states: { pending: 0, held: 0, accepted: 0, unavailable: 0, refused: 0, expired: 0 }, ...(plan.names ? { names: plan.names } : {}) } };
    if (plan.copies.length > limits.copies) throw new E2eeError(`${plan.copies.length} sessions would get a copy; a fan-out has at most ${limits.copies} (nothing was sent)`, "too_many_recipients");
    const running = Object.values(ctx.s.fanout).filter(inProgress).length;
    if (running >= limits.inProgress) throw new E2eeError(`${running} fan-outs are still in progress on this device; at most ${limits.inProgress} (nothing was sent)`, "too_many_fanouts");
    const id = crypto.randomBytes(16).toString("hex");
    const created = now();
    const logical = {};
    const copies = [];
    let total = 0;
    for (const t of plan.copies) {
      const c = newContent({ realm: ctx.me.realm, from: { member: ctx.me.member, device: ctx.me.device, session }, to: { member: t.member, session: t.name }, kind: replyTo ? "reply" : "text", body, replyTo: replyTo ? Buffer.from(replyTo.replace(/-/g, ""), "hex") : null, now: created, lifetimeMs });
      const content = encodeContent(c);
      const R = frameBound(content.length);
      if (R > MAX_FRAME_BYTES) throw new E2eeError(`a copy would need up to ${R} bytes; at most ${MAX_FRAME_BYTES} (nothing was sent)`, "too_large");
      total += R;
      const ref = idToRef(c.message_id);
      logical[ref] = { content: b64(content), peer: t.member, target: t.name, state: "new", created: c.created, expires: c.expires, reserve: R, fanout: id };
      copies.push({ member: t.member, session: t.name, ref });
    }
    if (total > limits.bytes) throw new E2eeError(`the copies would need up to ${total} bytes; a fan-out has at most ${limits.bytes} (nothing was sent)`, "too_large");
    const F = {
      v: FANOUT_VERSION, id, send_op: sendOp, created, expires: created + Math.min(lifetimeMs, MAX_LIFETIME_MS), addressed: plan.addressed, profile, realm: ctx.me.realm, body_digest: bodyDigest(body),
      reservation: Math.max(0, ...Object.values(logical).map((L) => L.reserve)), excluded, candidates: plan.candidates, copies,
      ...(plan.names ? { names: plan.names } : {}),
      ...(copies.length ? {} : { done: created }),
    };
    admitOrRefuse(ctx, { count: copies.length + 1, bytes: Object.entries(logical).reduce((n, [ref, L]) => n + logicalBytes(ref, L), 0) + recordBytes(id, F) });
    Object.assign(ctx.s.logical, logical);
    ctx.s.fanout[id] = F;
    fault?.("fanout-before-save");
    await ctx.save(); // the record and every copy: one write
    fault?.("fanout-after-save");
    return { id, refs: copies.map((c) => c.ref) };
  }

  // ---- receiving -------------------------------------------------------------------------------

  /** The pipeline form of decrypted content (the shape of a relay "message", provenance in e2ee). */
  function pipelineMessage(frame, c, ev, transferNote = null) {
    const file = c.kind === "file";
    const transfer = file && Object.hasOwn(c.body, "transfer") ? c.body.transfer : null;
    return {
      id: frame.delivery,
      message_id: idToRef(c.message_id),
      ...(c.reply_to ? { reply_to: idToRef(c.reply_to) } : {}),
      from: c.from.session,
      fromHost: "e2ee",
      to: c.to.session,
      text: transfer ? transferText(c, transfer, transferNote) : file ? `[an encrypted file snapshot]\n${JSON.stringify(c.body, (k, v) => (v?.type === "Buffer" ? Buffer.from(v.data).toString("base64") : v))}` : c.body,
      ts: c.created,
      expires: c.expires + SKEW_MS,
      sender: { member: { id: c.from.member, name: c.from.member }, auth: "member", realm: c.conversation.realm },
      e2ee: { device: c.from.device, group: frame.group, generation: frame.generation, kind: c.kind, verified: Boolean(ev?.verified) },
    };
  }

  async function receiveWelcome(frame) {
    return tx(async (ctx) => {
      prune(ctx);
      const conv = frame.conversation;
      if (!conv || conv.realm !== ctx.me.realm || (conv.a !== ctx.me.member && conv.b !== ctx.me.member)) return "refused";
      const peer = conv.a === ctx.me.member ? conv.b : conv.a;
      try {
        await refreshPins(ctx, [conv.a, conv.b]);
      } catch (e) {
        log(`e2ee: ${e.message}`);
        return "later";
      }
      // The joined group, checked before the join is committed (3.2's validate hook): every
      // device in it must be one the owner accepted (MII2).
      const validate = async (staged) => {
        if (hex(staged.groupId) !== frame.group) throw new E2eeError("the Welcome is for another group than the relay's", "bad_welcome");
        const ms = (staged.members ?? []).map((m) => ({ id: parseCredentialIdentity(m.identity), key: m.signatureKey }));
        if (ms.some((m) => !m.id || m.id.realm !== ctx.me.realm || ![conv.a, conv.b].includes(m.id.member))) throw new E2eeError("the Welcome's group holds a device of neither member", "bad_welcome");
        if (ms.length && !ms.some((m) => m.id.device === frame.from_device && m.id.member === frame.from_member)) throw new E2eeError("the Welcome's sender is not in its group", "bad_welcome");
        const adm = admitAll(ctx, ms);
        if (adm?.refuse) throw new E2eeError(adm.refuse, "bad_welcome");
        if (adm?.defer) throw new E2eeError(adm.defer, "pending");
      };
      let gidBytes;
      try {
        gidBytes = await ctx.acceptWelcome(frame.kp_ref, unb64(frame.mls), { ratchetTree: frame.ratchet_tree ? unb64(frame.ratchet_tree) : undefined, validate });
      } catch (e) {
        if (e.code === "pending") {
          // Not joined (the KeyPackage is kept): tried again after the owner's decision.
          log(`e2ee: a Welcome waits: ${e.message}`);
          return "pending";
        }
        log(`e2ee: a Welcome was refused: ${e.message}`);
        return "refused";
      }
      const gid = hex(gidBytes);
      if (gid !== frame.group) return "refused"; // nothing saved: the key stays
      const g = groupOf(ctx, gid);
      ctx.s.groups[gid] = { peer, conversation: { a: conv.a, b: conv.b }, generation: frame.generation, epoch: g.epoch(), position: frame.log?.position ?? 0, state: "active", joined: now() };
      startFresh(ctx.s.groups[gid], g);
      const prev = ctx.s.conversations[peer];
      if (!prev || prev === gid || (ctx.s.groups[prev]?.generation ?? 0) < frame.generation || ctx.s.groups[prev]?.state !== "active") {
        if (prev && prev !== gid && ctx.s.groups[prev]) {
          ctx.s.groups[prev].state = "replaced";
          // Messages sent into the replaced group are sealed again (same ids, created, expires).
          // Accepted ones only: a failed or expired message is never sealed again, and a sealed one
          // with its outbox entry is resolved by reconciliation first.
          for (const L of Object.values(ctx.s.logical)) if (L.peer === peer && ((L.group === prev && L.state === "sent") || L.state === "resend")) L.state = "resend";
        }
        ctx.s.conversations[peer] = gid;
      }
      checkpoint(ctx, gid, g);
      await ctx.save(); // group state, consumed key, replay record, mapping: one write
      fault?.("welcome-after-persist");
      return "delivered";
    });
  }

  async function receiveCommit(frame) {
    const entry = { ...frame.log, epoch: frame.log?.expected_epoch, from_member: frame.from_member, from_device: frame.from_device, mls: frame.mls };
    return tx(
      async (ctx) => {
        prune(ctx);
        const G = ctx.s.groups[frame.group];
        if (!G) return "delivered"; // a group this device is not in (it joins later by Welcome)
        try {
          await refreshPins(ctx, [G.conversation.a, G.conversation.b]);
        } catch (e) {
          log(`e2ee: ${e.message}`);
          return "later";
        }
        let res = await applyEntry(ctx, frame.group, entry);
        if (res === "ahead") {
          await catchUp(ctx, frame.group);
          // Removed meanwhile, or too far behind: this commit is moot (the group is replaced).
          if (["removed", "behind"].includes(ctx.s.groups[frame.group]?.state)) return "delivered";
          res = await applyEntry(ctx, frame.group, entry);
          if (res === "ahead") return "later";
        }
        if (res === "pending") return "pending";
        return res === "invalid" ? "refused" : "delivered";
      },
      { act: false },
    );
  }

  /**
   * The hold for messages from `member` now (null: none), from a current evaluation of its
   * devices against the pins; throws when the evaluation cannot be made (the directory does not
   * answer): a missing evaluation is never taken as permission (MII6).
   */
  async function holdIn(member, realm) {
    try {
      return (await view(member, realm)).ev;
    } catch (e) {
      throw new E2eeError(`the trust decision for ${member} cannot be made now (${e.message}); the message waits`, "trust_unavailable");
    }
  }
  /** Why a decrypted record may not go to this session's pipeline now (null: it may). */
  function undeliverable(message) {
    const t = now();
    if (t >= message.expires || t < message.ts - SKEW_MS) return "outside its acceptance window"; // for every session
    if (message.to !== session) return "not_mine"; // its authenticated target session only
    return null;
  }

  async function receiveApp(frame) {
    let out = null;
    const r = await tx(
      async (ctx) => {
        prune(ctx);
        if (frame.target !== session) return "not_mine";
        // A delivery decrypted before (the acknowledgement was lost, or a crash before delivery):
        // its record, checked again as a first delivery is (MII1): the authenticated target, the
        // acceptance window and the hold its sender needs now.
        const known = ctx.s.inbound[frame.delivery];
        if (known) {
          if (!known.message) return "delivered";
          const why = undeliverable(known.message);
          if (why === "not_mine") return why;
          if (why) {
            log(`e2ee: a kept message was refused: ${why}`);
            ctx.s.inbound[frame.delivery] = { at: known.at, message: null };
            ctx.write();
            return "refused";
          }
          let ev;
          try {
            ev = await holdIn(known.message.sender.member.id, ctx.me.realm);
          } catch (e) {
            log(`e2ee: ${e.message}`);
            return "later";
          }
          // The current decision only: a hold recorded before the crash may since have been lifted.
          out = { ...known, stop: ev.holdIn ?? null };
          return "deliver";
        }
        const G = ctx.s.groups[frame.group];
        let g = G ? groupOf(ctx, frame.group) : null;
        if (!G || !g) {
          // A group this device never joined, of a generation older than the one it holds for the
          // conversation: its Welcome is gone (a replacement drops the superseded generations'
          // Welcomes, MII8), so it can never be read here; its sender seals the message again in
          // the current group (its logical messages stay until they expire). Waiting would hold a
          // delivery slot for ever.
          const conv = frame.conversation;
          const peer = conv && (conv.a === ctx.me.member ? conv.b : conv.b === ctx.me.member ? conv.a : null);
          const cur = peer ? ctx.s.groups[ctx.s.conversations[peer]] : null;
          if (Number.isSafeInteger(frame.generation) && cur?.generation > frame.generation) {
            log(`e2ee: a message was refused: it is for a superseded generation (${frame.generation}) this device never joined`);
            return "refused";
          }
          return "later"; // its Welcome has not been processed yet
        }
        // A6: no application traffic in a group with other skipped-key bounds; it is replaced (the
        // sender seals its messages again in the replacement, MII8). Checked before anything is
        // decrypted, for every inbound application message (also one arriving at startup, before
        // attach's checkBounds pass); the commit log carries no application messages.
        if (!groupBoundsOk(g)) {
          log("e2ee: a message in a group made with other skipped-key bounds was refused; the group is replaced");
          setImmediate(() => checkBounds().catch(() => {}));
          return "refused";
        }
        // The trust decision first: when it cannot be made nothing is processed (or saved), so the
        // message's generation stays available for the next attempt (MII6). Catching up judges
        // commits against current pins, the own member's too.
        const behind = frame.epoch !== undefined && frame.epoch > g.epoch() && G.state === "active";
        let ev;
        try {
          ev = await holdIn(G.peer, ctx.me.realm);
          if (behind) await refreshPins(ctx, [ctx.me.member]);
        } catch (e) {
          log(`e2ee: ${e.message}`);
          return "later";
        }
        if (behind) {
          await catchUp(ctx, frame.group);
          g = groupOf(ctx, frame.group);
          if (frame.epoch > g.epoch()) return "later";
        }
        const refuse = async (why) => {
          // Nothing is saved: the state stays as before this copy (as for a failed process), so a
          // changed copy sent first never costs the genuine one its generation.
          log(`e2ee: a message was refused: ${why}`);
          return "refused";
        };
        let p;
        try {
          p = await g.process(unb64(frame.mls));
        } catch (e) {
          // Not decryptable (the binding put the state back). Not, alone, evidence of a fork.
          log(`e2ee: a message did not decrypt: ${e.message}`);
          return e instanceof DriverError && /WrongEpoch/.test(e.message) && G.state === "active" ? "later" : "refused";
        }
        if (p.kind !== "application") return refuse("not an application message");
        const cred = parseCredentialIdentity(p.sender?.identity ?? Buffer.alloc(0));
        if (!cred || cred.realm !== ctx.me.realm || cred.member !== frame.from_member || cred.device !== frame.from_device) return refuse("the authenticated sender is not the relay's sender");
        let c;
        try {
          c = decodeContent(p.plaintext);
        } catch (e) {
          return refuse(e.message);
        }
        if (c.from.member !== cred.member || c.from.device !== cred.device) return refuse("the content's sender is not the authenticated sender");
        if (c.to.member !== ctx.me.member || c.from.member !== G.peer) return refuse("the content is not addressed to this member by the conversation's peer");
        if (c.conversation.realm !== ctx.me.realm || c.conversation.a !== G.conversation.a || c.conversation.b !== G.conversation.b) return refuse("the content names another conversation");
        if (c.to.session !== frame.target) return refuse("the outer target differs from the authenticated target session");
        const window = outsideWindow(c, now());
        if (window) return refuse(`the message is ${window.replace(/_/g, " ")}`);
        const key = `${c.conversation.a}|${c.conversation.b}|${c.from.member}|${hex(c.message_id)}`;
        if (ctx.s.replay[key] !== undefined) {
          await ctx.save(); // a known id: acknowledged, never delivered twice (MI3)
          return "delivered";
        }
        if (Object.keys(ctx.s.replay).length >= capacity) return "quota"; // nothing saved: backpressure
        // A transfer's descriptor (design 6): bound to the outer reference and the authenticated
        // sender's device; a mismatch is tampering (reported to the owner and the relay). Its key
        // goes to the staging intake only, never into the pipeline's text.
        let transferNote = null;
        if (c.kind === "file" && Object.hasOwn(c.body, "transfer")) {
          let d;
          try {
            const outer = Array.isArray(frame.blobs) && frame.blobs.length === 1 ? frame.blobs[0] : null;
            if (!outer) throw new TransferFormatError("binding", "the message carries no single relay-visible reference");
            d = checkDescriptor(c.body.transfer, { uploaderDevice: outer.uploader_device, transferId: outer.transfer_id, fromDevice: cred.device });
          } catch (e) {
            if (!(e instanceof TransferFormatError)) throw e;
            notice(ctx.s, `a file transfer from ${c.from.member} was dropped: its reference does not match its sender (${e.message}); the relay was told`);
            await ctx.save();
            await ask({ type: "commit_invalid", device: ctx.me.device, group: frame.group, epoch: Number.isSafeInteger(frame.epoch) ? frame.epoch : 0, reason: "transfer reference mismatch" }).catch(() => {});
            return refuse(e.message);
          }
          const t = { descriptor: d, reviewSet: c.body.review_set ?? null, sender: { realm: c.conversation.realm, member: c.from.member, device: c.from.device, session: c.from.session }, to: c.to, message_id: idToRef(c.message_id), verified: Boolean(ev?.verified) };
          if (!onTransfer) transferNote = "this session cannot fetch transfers";
          else {
            try {
              transferNote = (await onTransfer(t))?.note ?? null;
            } catch (e) {
              log(`e2ee: a transfer could not be recorded (${e.message}); the relay delivers it again`);
              return "later";
            }
          }
        }
        const message = pipelineMessage(frame, c, ev, transferNote);
        ctx.s.replay[key] = c.expires + SKEW_MS;
        ctx.s.inbound[frame.delivery] = { at: now(), message, stop: ev?.holdIn ?? null };
        active(G); // A2: activity, in the same write as the message's records
        out = ctx.s.inbound[frame.delivery];
        await ctx.save(); // state, decrypted record and replay record together, before any delivery
        fault?.("receive-after-persist");
        return "deliver";
      },
      { act: false },
    );
    if (r !== "deliver") return r;
    if (out.stop) {
      // A key change (or an unmet requireVerified) holds what arrives: it waits for the owner.
      if (!held.has("in", out.message.id)) held.hold({ realm: out.message.sender.realm, member: out.message.sender.member.id, direction: "in", reason: out.stop, message: out.message });
    } else await deliver(out.message);
    fault?.("receive-after-deliver");
    // Delivered: the record keeps only that it was (a repeat is acknowledged, never delivered again).
    await tx(
      async (ctx) => {
        if (ctx.s.inbound[frame.delivery]?.message) {
          ctx.s.inbound[frame.delivery] = { at: ctx.s.inbound[frame.delivery].at, message: null };
          ctx.write();
        }
      },
      { act: false },
    ).catch(() => {});
    return "delivered";
  }

  // ---- held messages (3.2's queue), reassessed after the owner's decisions (MII10) ---------------

  let seenRevision = contacts?.currentPolicy().doc?.revision ?? null;
  /** Whether the contacts policy (pins, requireVerified) changed since this was last asked. */
  const policyMoved = () => {
    const rev = contacts?.currentPolicy().doc?.revision ?? null;
    if (rev === seenRevision) return false;
    seenRevision = rev;
    return true;
  };

  /**
   * Release what the current decision allows (all members with held messages, or `only`):
   * messages to a member once nothing holds sending to it, sealed through sendLogical's gate and
   * group like any send; messages from it once nothing holds receiving, to this session only (its
   * authenticated target; another session's stay held for it), within their acceptance window,
   * deduplicated by delivery id in the pipeline. Runs inside serial(), each step its own
   * transaction. Returns how many left the queue.
   */
  async function sweepHeld(only = null) {
    const rec = store.record();
    if (!rec) return 0;
    let n = 0;
    for (const { realm, member, direction } of held.held()) {
      if (realm !== rec.realm || (only && member !== only)) continue;
      let ev;
      try {
        ev = (await view(member, realm)).ev;
      } catch (e) {
        log(`e2ee: held messages of ${member} wait: ${e.message}`);
        continue;
      }
      if (direction === "out" && !ev.holdOut) {
        n += await held.release(
          realm,
          member,
          async (message) => {
            if (!message?.ref) return true;
            try {
              await tx((ctx) => (ctx.s.logical[message.ref] && ["held_key", "new"].includes(ctx.s.logical[message.ref].state) ? sendLogical(ctx, message.ref) : null));
              return true;
            } catch (e) {
              log(`e2ee: a held message stays held: ${e.message}`);
              return false;
            }
          },
          { direction: "out" },
        );
      } else if (direction === "in" && !ev.holdIn) {
        n += await held.release(
          realm,
          member,
          async (message) => {
            if (!message?.id) return true;
            const why = undeliverable(message);
            if (why === "not_mine") return false;
            if (why) {
              log(`e2ee: a held message was dropped: ${why}`);
              return true;
            }
            await deliver(message);
            return true;
          },
          { direction: "in" },
        );
      }
    }
    return n;
  }
  /** After a change of the owner's decisions: held messages, and deliveries deferred for a decision. */
  async function reassess() {
    if (!policyMoved()) return;
    await sweepHeld().catch((e) => log(`e2ee: releasing held messages failed: ${e.message}`));
    // Messages stopped in their conversation (an own device not accepted yet, a removal not
    // merged): an owner's decision may let them go now (A1: hoptell device accept resumes them).
    await tx((ctx) => resealMarked(ctx, null, { states: ["held"] })).catch((e) => log(`e2ee: resealing stopped messages failed: ${e.message}`));
    if (deferred.size) setImmediate(retryDeferred);
  }

  /** Handle one message_e2ee frame; `ack(outcome)` acknowledges it to the relay. */
  function receive(frame, ack) {
    return serial(async () => {
      await reassess();
      let outcome;
      try {
        if (frame.kind === "welcome") outcome = await receiveWelcome(frame);
        else if (frame.kind === "commit") outcome = await receiveCommit(frame);
        else if (frame.kind === "app") outcome = await receiveApp(frame);
        else outcome = "refused";
      } catch (e) {
        log(`e2ee: receiving failed (${e.message}); the relay delivers it again`);
        outcome = "later";
      }
      if (outcome === "delivered" || outcome === "refused") {
        deferred.delete(frame.delivery);
        ack(outcome);
        if (frame.kind !== "app") retryDeferred();
        // A joined group or a merged commit may let messages waiting for it go (MII11).
        if (frame.kind !== "app" && outcome === "delivered") resendPending(frame.conversation);
        // A2: a merged commit (a removal among them) may make an update due.
        if (frame.kind === "commit" && outcome === "delivered") checkFresh(frame.group).catch(() => {});
      } else if (outcome === "later" || outcome === "quota" || outcome === "pending") {
        // "pending": waits for the owner's decision; a change of the pins retries it (reassess).
        deferred.set(frame.delivery, { frame, ack });
        clearTimeout(retryTimer);
        if (!closed) {
          retryTimer = setTimeout(retryDeferred, outcome === "later" ? 2_000 : 60_000);
          retryTimer.unref?.();
        }
      }
      return outcome === "pending" ? "later" : outcome;
    });
  }
  function retryDeferred() {
    const list = [...deferred.values()];
    deferred.clear();
    for (const { frame, ack } of list) receive(frame, ack);
  }

  /**
   * Seal again the logical messages whose group was replaced or not usable yet (same id, created
   * and expires); with `conversation` ({a, b}), only those of that conversation.
   */
  function resendPending(conversation = null, attempt = 0) {
    return serial(() => tx((ctx) => resealMarked(ctx, conversation, { tries: 1 })))
      .then((out) => {
        if (out.some(transientResult)) retryResend(conversation, attempt, out.some(limitedResult));
      })
      .catch((e) => {
        log(`e2ee: resending failed: ${e.message}`);
        if (TRANSIENT.has(e.code)) retryResend(conversation, attempt, e.code === "rate_limited");
      });
  }
  /** Whether a reseal's result asks for another pass (a transient refusal, or not confirmed). */
  const transientResult = (x) => Boolean(x) && (x.limited || TRANSIENT.has(x.code));
  const limitedResult = (x) => Boolean(x) && (x.limited || x.code === "rate_limited");
  /**
   * Run resendPending(conversation) again after a delay (doubling per attempt), so the messages a
   * replacement marked are all sealed again without an explicit recover() (MII8, 4.3): at most one
   * timer per conversation; none after close() or once the client stopped.
   */
  function retryResend(conversation, attempt, limited = false) {
    retryLater(conversation ? `${conversation.a}|${conversation.b}` : "*", (n) => resendPending(conversation, n), attempt, limited);
  }
  /** Run `run(attempt + 1)` after the retry delay, once per `key` at a time (see retryResend). */
  function retryLater(key, run, attempt, limited) {
    if (closed || client?.stopped) return;
    if (resendTimers.has(key)) return;
    const timer = setTimeout(() => {
      resendTimers.delete(key);
      run(attempt + 1);
    }, limited ? RESEND_RETRY_MS : Math.min(RESEND_RETRY_MS * 2 ** attempt, RESEND_RETRY_MAX_MS));
    timer.unref?.();
    resendTimers.set(key, timer);
  }
  /**
   * Finish what a restart interrupted (recover()); a pass that leaves messages behind for a
   * transient reason (the relay's rate limit, no answer) runs again on its own, as reseal passes do.
   */
  function recoverPass(attempt = 0) {
    return serial(async () => {
      let transient = false;
      let limited = false;
      const note = (r) => {
        if (transientResult(r)) transient = true;
        if (limitedResult(r)) limited = true;
        return r;
      };
      const failed = (e) => (note({ code: e.code }), log(`e2ee: resend: ${e.message}`));
      const done = await tx(async (ctx) => {
        if (prune(ctx)) ctx.write(); // also expires what can no longer be delivered (with its final result)
        const done = { commits: 0, messages: 0 };
        for (const [gid, c] of Object.entries(ctx.s.committer)) {
          if (c.phase !== "prepared" && c.phase !== "published") continue;
          await runCommitter(ctx, gid).catch((e) => (note({ code: e.code }), log(`e2ee: commit recovery: ${e.message}`)));
          done.commits++;
        }
        for (const [op, o] of Object.entries(ctx.s.outbox)) {
          try {
            if (o.phase === "published") {
              const r = note(await publishApp(ctx, op, { reconcile: true }));
              if (r.state !== "cancelled") {
                done.messages++;
                continue;
              }
            }
            // Never accepted by the relay (cancelled there, or never published): "was sealed" is
            // not "may be published now". The ciphertext goes; the logical message (same id, created, expires) is sealed again
            // through the current gate and group, or held.
            delete ctx.s.outbox[op];
            if (ctx.s.logical[o.ref]) note(await sendLogical(ctx, o.ref));
            else ctx.write();
          } catch (e) {
            failed(e);
          }
          done.messages++;
        }
        const sealed = new Set(Object.values(ctx.s.outbox).map((o) => o.ref));
        for (const [ref, L] of Object.entries(ctx.s.logical)) {
          // "new": a crash while its group was being set up; "resend": its group was replaced
          // or not joined yet; "held": a removal was not merged yet; "sealed" without its outbox
          // entry: a recovery interrupted after dropping the stale ciphertext.
          if (!["new", "resend", "held"].includes(L.state) && !(L.state === "sealed" && !sealed.has(ref))) continue;
          await sendLogical(ctx, ref).then(note, failed);
          done.messages++;
        }
        return done;
      }).catch((e) => {
        note({ code: e.code });
        throw e;
      }).finally(() => {
        if (transient) retryLater("recover", recoverPass, attempt, limited);
      });
      policyMoved();
      done.released = await sweepHeld().catch((e) => (log(`e2ee: releasing held messages failed: ${e.message}`), 0));
      return done;
    });
  }
  /** Inside a transaction: seal again the logical messages marked "resend" (of `conversation` only, when given). */
  async function resealMarked(ctx, conversation = null, { states = ["resend"], ...opts } = {}) {
    const out = [];
    for (const [ref, L] of Object.entries(ctx.s.logical)) {
      if (!states.includes(L.state) || (conversation && ![conversation.a, conversation.b].includes(L.peer))) continue;
      let r;
      try {
        r = await sendLogical(ctx, ref, opts);
      } catch (e) {
        log(`e2ee: resending ${ref} failed: ${e.message}`);
        r = { state: "error", message_id: ref, code: e.code };
      }
      out.push(r);
      // The relay's rate limit: the rest wait for the next pass (resendPending schedules it).
      if (limitedResult(r)) break;
    }
    return out;
  }

  /**
   * A6 on load: every conversation whose current group does not apply the policy's skipped-key
   * bounds is replaced (one replacement each, through ensureGroup's replacement path). Returns the
   * peers whose conversation was replaced.
   */
  function checkBounds() {
    return serial(async () => {
      if (closed || store.mayAct()) return [];
      const peers = await tx((ctx) => Object.entries(ctx.s.conversations).filter(([, gid]) => ctx.s.groups[gid]?.state === "active" && !groupBoundsOk(groupOf(ctx, gid))).map(([peer]) => peer), { act: false });
      const done = [];
      for (const peer of peers) {
        try {
          await tx(async (ctx) => {
            await ensureGroup(ctx, peer);
            const out = await resealMarked(ctx);
            if (out.some(transientResult)) retryResend(null, 0, out.some(limitedResult));
          });
          done.push(peer);
        } catch (e) {
          log(`e2ee: a conversation with other skipped-key bounds is not replaced yet: ${e.message}`);
        }
      }
      return done;
    });
  }

  /**
   * The fresh-update check (A2) of every active group (or `only`): each owed update is committed,
   * one at a time, in its own transaction. Run at engine start and after recovery, after each
   * merged commit, and on a timer while attached; before each outbound message sealLogical runs
   * its own. A device that may not act (retired, foreign) commits nothing. Returns the groups updated.
   */
  function checkFresh(only = null) {
    return serial(async () => {
      if (closed || store.mayAct()) return [];
      const gids = await tx((ctx) => Object.keys(ctx.s.groups).filter((gid) => ctx.s.groups[gid].state === "active" && (!only || gid === only) && (due(ctx, gid, false).due || ["prepared", "published"].includes(ctx.s.committer[gid]?.phase))), { act: false });
      const done = [];
      for (const gid of gids) {
        try {
          const c = await tx((ctx) => freshen(ctx, gid));
          if (c?.phase === "merged") done.push(gid);
        } catch (e) {
          log(`e2ee: an update of a conversation waits: ${e.message}`);
        }
      }
      return done;
    });
  }

  /**
   * The relay detached this connection (e2ee_detached, A9): the device's key changed (a rotation,
   * possibly by a command on another connection), so the session proves again on the same
   * connection with the key the store now holds: 5 quick tries, then on at a bounded rate (doubling
   * capped at a minute, with jitter: 30 to 60 s between tries) while this connection is up; a reconnect ends the loop
   * (the session attaches on every welcome). A revoked device does not attach again.
   */
  let detachedWhy = null;
  let reattaching = null;
  let connection = 0;
  function onDetached(m) {
    if (closed || (typeof m.device === "string" && m.device !== store.record()?.device)) return;
    if (m.reason === "revoked") {
      detachedWhy = "the relay detached this device: it was revoked";
      log(`e2ee: ${detachedWhy}; it does not attach again`);
      return;
    }
    if (reattaching) return;
    const gen = connection;
    const live = () => !closed && gen === connection && client.connected !== false;
    reattaching = (async () => {
      for (let i = 0; live(); i++) {
        try {
          await engine.attach();
          log("e2ee: the device's key changed; this connection proved it again");
          return;
        } catch (e) {
          if (e.code === "device_revoked" || e.code === "no_device") {
            detachedWhy = e.message;
            log(`e2ee: not attaching again: ${e.message}`);
            return;
          }
          if (i < REATTACH_TRIES) log(`e2ee: attaching again failed (${i + 1}): ${e.message}`);
          const quick = reattachBaseMs * 2 ** Math.min(i, 20);
          const wait = i + 1 < REATTACH_TRIES ? quick : Math.min(reattachMaxMs, quick) * (0.5 + Math.random() / 2);
          await new Promise((r) => setTimeout(r, wait).unref?.());
        }
      }
    })().finally(() => {
      reattaching = null;
    });
  }

  const engine = {
    /** Receive this device's message_e2ee frames on the client's connection, then finish what a restart interrupted. */
    async attach() {
      const rec = store.record();
      if (!rec) throw new E2eeError("This home has no device for this relay. Your user can enroll one with hoptell device enroll.", "no_device");
      // Once per client; the attachment itself is per connection (again after every reconnect).
      if (!listening) {
        listening = true;
        client.on("message_e2ee", (frame, ack) => receive(frame, ack));
        client.on("e2ee_detached", (m) => onDetached(m));
        client.on("down", () => connection++); // a reattach loop belongs to one connection
      }
      // A10: the KeyPackage maintenance starts with the engine (its first attach) and runs every 6
      // hours while the engine runs, whether or not the relay takes the attach: a relay refusing
      // the device, or transient errors, never stop expired keys from being deleted.
      if (!started && !closed) {
        started = true;
        pruneTimer = setInterval(() => prunePass("timer"), pruneEveryMs);
        pruneTimer.unref?.();
        await prunePass("start");
      }
      // The own baseline first (A1): an older home's upgrade runs here, once; without a baseline
      // (unmanaged contacts, two profiles in the realm, another enrolled device) nothing attaches.
      await serial(() => tx((ctx) => ownView(ctx), { act: false }));
      // A9: the store proves the device key on this connection (a pending rotation is finished
      // first); each reconnect proves again.
      if (detachedWhy) throw new E2eeError(detachedWhy, "device_revoked");
      try {
        await store.attach(client);
      } catch (e) {
        throw new E2eeError(e.message, e.code ?? e.kind ?? "relay", { kind: e.kind });
      }
      await prunePass("attach");
      const done = await this.recover();
      // A6: groups made with other skipped-key bounds are replaced on load.
      await checkBounds().catch((e) => log(`e2ee: the skipped-key bounds check failed: ${e.message}`));
      // A2: owed updates at start and after recovery, then on a timer while attached.
      await checkFresh().catch((e) => log(`e2ee: the fresh-update check failed: ${e.message}`));
      if (!freshTimer && !closed) {
        freshTimer = setInterval(() => checkFresh().catch((e) => log(`e2ee: the fresh-update check failed: ${e.message}`)), HOUR);
        freshTimer.unref?.();
      }
      return done;
    },
    receive,
    /**
     * Send an encrypted message to `to` ({member, session}) from this session: {kind, body,
     * replyTo (a message reference), blobs (design 6: the transfer references it publishes)}.
     * Returns {state: "accepted" | "unsent" | "held", message_id, unverified?}. A missing group or
     * device is an error, never a plaintext fallback.
     */
    send({ to, body, replyTo = null, kind = replyTo ? "reply" : "text", lifetimeMs = MAX_LIFETIME_MS, blobs = null }) {
      return serial(async () => {
        await reassess();
        return tx(async (ctx) => {
          prune(ctx);
          const c = newContent({ realm: ctx.me.realm, from: { member: ctx.me.member, device: ctx.me.device, session }, to, kind, body, replyTo: replyTo ? Buffer.from(replyTo.replace(/-/g, ""), "hex") : null, now: now(), lifetimeMs });
          const ref = idToRef(c.message_id);
          const content = encodeContent(c);
          // A transfer's references (design 6) are published with every sealing of this message.
          const L = { content: b64(content), peer: to.member, target: to.session, state: "new", created: c.created, expires: c.expires, reserve: frameBound(content.length), ...(blobs ? { blobs } : {}) };
          admitOrRefuse(ctx, { count: 1, bytes: logicalBytes(ref, L) });
          ctx.s.logical[ref] = L;
          return sendLogical(ctx, ref);
        });
      });
    },
    /**
     * An encrypted fan-out (design 4.3) from this session: `to` is "@role" / "@all" (resolved from
     * the relay's gate-filtered list; pinned members only) or a list of session names (each as a
     * direct send would be: first use pins). One copy per recipient session, each a 3.3 logical
     * message; the record and every copy are written in one ctx.save(), then each copy goes
     * through sendLogical (recover() finishes what a crash interrupted). `sendOp`: the tool call's
     * idempotency key; a retry with it returns the same fan-out's result, never a second fan-out.
     * Returns the counts by state (lib/mls/fanout.js summary), without plaintext copies ever.
     */
    fanout({ to, body, replyTo = null, sendOp = null, lifetimeMs = MAX_LIFETIME_MS }) {
      return serial(async () => {
        await reassess();
        const made = await tx(async (ctx) => {
          prune(ctx);
          if (sendOp !== null) {
            const prior = Object.values(ctx.s.fanout).find((F) => F.send_op === sendOp);
            if (prior) return { id: prior.id, refs: [] }; // the frozen audience: never resolved again
          }
          const plan = await audience(ctx, to);
          return create(ctx, { body, replyTo, sendOp, lifetimeMs, plan });
        });
        if (made.none) return made.none;
        for (const ref of made.refs) {
          // Each copy through 3.3's send path; a rate limit of the relay is waited out (paced).
          for (let i = 0, retry = true; retry; i++) {
            retry = false;
            const r = await tx((ctx) => {
              const L = ctx.s.logical[ref];
              return L?.state === "new" || (i > 0 && L?.state === "resend") ? sendLogical(ctx, ref) : null;
            }).catch((e) => (e.code === "rate_limited" ? { limited: true } : (log(`e2ee: a fan-out copy is not sent yet: ${e.message}`), null)));
            if (r?.limited && i < PACE_TRIES) {
              retry = true;
              await new Promise((res) => setTimeout(res, PACE_MS));
            }
          }
        }
        return tx((ctx) => summary(ctx.s, ctx.s.fanout[made.id]), { act: false });
      });
    },
    /** The counts of fan-out `id` now (null once its record was pruned). */
    fanoutStatus(id) {
      return serial(() => tx((ctx) => (ctx.s.fanout[id] ? summary(ctx.s, ctx.s.fanout[id]) : null), { act: false }));
    },
    /** An update commit in the conversation with `peer` (the fresh-update policy). Returns the committer record. */
    update(peer) {
      return serial(() =>
        tx(async (ctx) => {
          const gid = await ensureGroup(ctx, peer);
          if (!gid) throw new E2eeError("the conversation has no group yet", "not_joined");
          return commitChange(ctx, gid, { update: true });
        }),
      );
    },
    /** Replace the conversation's group (a fork, a broken group): generation + 1; pending messages are sealed again there. */
    replace(peer) {
      return serial(() =>
        tx(async (ctx) => {
          const cur = await ask({ type: "conversation", peer });
          if (!cur.group) throw new E2eeError("the conversation has no group yet", "not_joined");
          const want = await desired(ctx, peer);
          const gid = await newGroup(ctx, peer, want.devices, { expectedGeneration: cur.generation });
          const out = await resealMarked(ctx);
          if (out.some(transientResult)) retryResend(null, 0, out.some(limitedResult));
          return { group: gid, generation: ctx.s.groups[gid]?.generation ?? null };
        }),
      );
    },
    /** Seal again a logical message (after a replacement), keeping its id, created and expires. */
    resend(ref) {
      return serial(() =>
        tx((ctx) => {
          // A sealed copy not yet resolved may still be accepted: recover() reconciles it first (MII3).
          const L = ctx.s.logical[ref];
          if (!L) throw new E2eeError("no such message", "unknown_message");
          if (TERMINAL.has(L.state)) throw new E2eeError(`the message is ${L.state}; it is never sealed again`, "terminal");
          if (Object.values(ctx.s.outbox).some((o) => o.ref === ref)) throw new E2eeError("the message has a sealed copy whose outcome is not known yet; recover() resolves it first", "unresolved");
          return sendLogical(ctx, ref);
        }),
      );
    },
    resendPending,
    /** The fresh-update check now (A2; the timer runs it while attached). Resolves to the groups updated. */
    checkFresh: (only = null) => checkFresh(only),
    /** A10: prune expired, unused KeyPackage keys now (it runs at start, attach and on a timer). */
    prune: () => prunePass("request"),
    /** The skipped-key bounds check now (A6; it runs on attach). Resolves to the peers whose conversation was replaced. */
    checkBounds: () => checkBounds(),
    /** Stop the timers of this engine (scheduled reseal passes, deferred deliveries). */
    close() {
      closed = true;
      clearInterval(freshTimer);
      freshTimer = null;
      clearInterval(pruneTimer);
      pruneTimer = null;
      for (const timer of resendTimers.values()) clearTimeout(timer);
      resendTimers.clear();
      clearTimeout(retryTimer);
    },
    /**
     * Finish what a restart interrupted: commits being published, sealed messages not yet sent;
     * then release the held messages the owner's current decisions allow (MII10).
     */
    recover() {
      return recoverPass(0);
    },
    /** Messages held for a key decision of `member`, released as far as the owner's current decision allows. */
    releaseHeld(member) {
      return serial(() => sweepHeld(member));
    },
    /** The conversation's current checkpoint, for the owners to compare (hoptell contacts verify --conversation). */
    checkpoint(peer) {
      return serial(() =>
        tx(
          async (ctx) => {
            const gid = ctx.s.conversations[peer];
            const G = gid && ctx.s.groups[gid];
            const g = G && groupOf(ctx, gid);
            if (!g) return null;
            const cp = { realm: ctx.me.realm, group: gid, generation: G.generation, epoch: g.epoch(), authenticator: hex(g.epochAuthenticator()) };
            return { ...cp, digits: checkpointDigits(cp), fork: G.fork ?? null };
          },
          { act: false },
        ),
      );
    },
    /**
     * Compare the other owner's checkpoint ({group, epoch, authenticator}) with this device's
     * record: "match", "fork" (recorded and reported) or "unknown" (an epoch no longer kept).
     */
    compareCheckpoint(peer, other) {
      return serial(() =>
        tx(
          async (ctx) => {
            const cp = (ctx.s.checkpoints[other.group] ?? []).find((x) => x.epoch === other.epoch);
            if (!cp) return "unknown";
            if (cp.auth === other.authenticator) return "match";
            const G = ctx.s.groups[other.group];
            if (G) G.fork = { epoch: other.epoch, at: now(), by: "checkpoint" };
            notice(ctx.s, `fork detected in the conversation with ${peer}: the checkpoints of epoch ${other.epoch} differ; the conversation is recovered by a replacement group`);
            await ctx.save();
            return "fork";
          },
          { act: false },
        ),
      );
    },
    /** For hoptell doctor and the owner: forks, refused commits, notices. */
    status() {
      return serial(() => tx(async (ctx) => {
        // A2: per conversation, the devices whose last update is older than 30 days.
        const stale = Object.fromEntries(Object.entries(ctx.s.groups).filter(([, G]) => G.state === "active").map(([gid, G]) => [gid, staleOf(structuredClone(G), ctx.me.device, groupOf(ctx, gid))]));
        return { notices: ctx.s.notices, groups: ctx.s.groups, stale, replay: Object.keys(ctx.s.replay).length, outbox: Object.keys(ctx.s.outbox).length, held: held.line() };
      }, { act: false }));
    },
    /**
     * The state of logical message `ref` (design 6: a transfer's outbox is kept until its message
     * is accepted): "new", "sealed", "sent", "held", "resend", "failed", "expired"..., or null once
     * it is gone (pruned after its lifetime).
     */
    messageState(ref) {
      return serial(() => tx((ctx) => ctx.s.logical[ref]?.state ?? null, { act: false }));
    },
    /**
     * A frame to the relay on this device's attached connection (design 6: transfer frames use
     * the attachment's device), with the relay's refusal details kept (retry_after_ms, missing).
     */
    rpc: (frame) => client.rpc(frame),
    /** This device's id. */
    device: () => store.record()?.device ?? null,
    /** Deliveries waiting for a Welcome or catch-up (tests). */
    deferredCount: () => deferred.size,
    idle: () => serial(() => null),
    /** Why the relay detached this connection for good (a revoked device), or null. */
    detached: () => detachedWhy,
  };
  return engine;
}
