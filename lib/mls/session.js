// Encrypted direct messages in an agent session (design 3.3, "Require-encryption policy",
// "Receive pipeline integration"). EXPERIMENTAL: the engine (lib/engine.js) creates this only
// with HOPTELL_EXPERIMENTAL_E2EE=1 on a protocol-2 relay profile; without the flag nothing here
// runs and sending and receiving are unchanged.
//
// Sending follows the contacts' encryption policy (lib/contacts.js encryptionMode):
//   required   only encrypted: a missing capability, device or group is an error, never plaintext
//   preferred  encrypted when it can be (both sides have devices), else plaintext, said so
//   off        plaintext (the default)
// A relay without the "e2ee" capability (an older relay) carries plaintext only: under
// "required" that is an error, never a silent downgrade. Fan-out (@role, @all) is encrypted per
// recipient session (design 4.3, lib/mls/fanout.js) once the realm has an encryption policy and
// this session's device is attached; it is never mixed (no plaintext copies). Without encryption
// available it is plaintext, and refused while any contact of the realm requires encryption.
// Receiving: decrypted messages enter the session's receive pipeline like relay messages, with the
// authenticated member, device and target session (the contacts gates and quarantine apply).
//
// Hosted custody (design 4.5): a recipient whose host can read its messages is never reached
// encrypted. Under "required" a send to it is refused, also when the owner set custody
// "allow-hosted" for that contact; under "preferred" it is refused unless the owner set
// "allow-hosted", and then it goes as a separate direct plaintext send. An encrypted fan-out
// follows 4.3's hosted-custody matrix (lib/mls/e2ee.js audience, lib/mls/fanout.js selectRole):
// an @role/@all hosted candidate is excluded before any copy (not-encrypted, or unavailable under
// "required"); a hosted name in an explicit list is refused; while the relay's fence is up hosted
// members are not candidates. exclude_hosted (the relay leaves hosted members out of a plaintext
// fan-out) remains only for the plaintext @role/@all send under an encryption policy, when
// encrypted sending is not available here: that send has no per-candidate audience to apply the
// matrix to, and the relay picks its recipients. A relay without hosted custody ignores the field.
import { allowsHosted, encryptionMode, sendPolicy } from "../contacts.js";
import { E2EE_CAP, TRANSFER_CAP } from "../relay.js";
import { storeFor } from "./cli.js";
import { E2EE_LABEL, driverLabel } from "./driver.js";
import { createE2ee } from "./e2ee.js";

/**
 * The encryption policy's decision for a send to `to` (a session name, @role or @all), shared by
 * agent sessions and the CLI: {mode, member, encrypt, fanout?, refuse (a reason, or null), note?}.
 * `doc` is the contacts document, `realm` the relay's realm id, `caps` its capabilities, `rpc`
 * asks it (member_of), `list` returns its peers list (custody for a relay without the e2ee
 * service), `active` whether encrypted sending is available here and `why` why not.
 * Resolving the member asks the relay only when the realm has an encryption policy.
 */
export async function encryptionPlan({ doc, realm, caps = [], rpc, list = async () => [], to, active, why }) {
  const entries = (doc?.encryption ?? []).filter((e) => e.realm === realm && e.mode !== "off");
  if (!entries.length) return { mode: "off", member: null, encrypt: false, refuse: null };
  const anyRequired = entries.some((e) => e.mode === "required");
  if (to.startsWith("@")) {
    const mode = anyRequired ? "required" : "preferred";
    if (active) return { mode, member: null, encrypt: true, fanout: true, refuse: null };
    return { mode, member: null, encrypt: false, excludeHosted: true, refuse: anyRequired ? `fan-out (${to}) cannot be encrypted now (${why}), and your policy requires encryption for some contacts of this realm; nothing was sent` : null, note: `not encrypted: ${why}` };
  }
  let member = null;
  let hosted = false;
  if (caps?.includes(E2EE_CAP)) {
    const r = await rpc({ type: "member_of", name: to });
    member = r.member;
    hosted = r.custody === "hosted";
  } else if (anyRequired) return { mode: "required", member: null, encrypt: false, refuse: `this relay does not carry encrypted messages and your policy requires encryption for some contacts of this realm; hoptell cannot tell whether ${to} is one of them, so nothing was sent` };
  else {
    // Without the e2ee service the relay's list names a hosted peer's member id (only peers
    // the caller may reach are listed).
    const peer = (await list()).find((p) => p.name === to && p.custody === "hosted");
    hosted = Boolean(peer);
    if (peer && typeof peer.member_id === "string") member = peer.member_id;
  }
  // A name that is no member's (a shared-token session, or unknown) has no contact entry; under a
  // realm default of "required" it is refused all the same (never a silent downgrade).
  const realmDefault = entries.find((e) => e.member === undefined)?.mode ?? "off";
  if (hosted) {
    // Hosted, but the member is not known (an older relay): any policy entry of this realm
    // refuses, never a silent plaintext send.
    if (!member) return { mode: "preferred", member: null, encrypt: false, hosted, refuse: `hosted custody: the host can read; not sent (${to} is hosted and hoptell cannot tell which contact it is, so your encryption policy for this realm cannot be checked)` };
    const mode = encryptionMode(doc, realm, member);
    if (mode === "required") return { mode, member, encrypt: false, hosted, refuse: `hosted custody: the host can read; not sent (encryption is required for ${to}, and allow-hosted never changes that)` };
    if (mode === "preferred" && !allowsHosted(doc, realm, member)) return { mode, member, encrypt: false, hosted, refuse: `hosted custody: the host can read; not sent (${to} is hosted; your owner may allow a plaintext send to this contact with custody "allow-hosted" in contacts.json)` };
    return { mode, member, encrypt: false, hosted, refuse: null, ...(mode === "preferred" ? { note: "hosted custody: sent as plaintext, the host can read it" } : {}) };
  }
  if (!member) return { mode: realmDefault, member: null, encrypt: false, refuse: realmDefault === "required" ? `encryption is required in this realm, and ${to} is not a member's session that can be reached encrypted; nothing was sent (never as plaintext)` : null };
  const mode = encryptionMode(doc, realm, member);
  if (mode === "off") return { mode, member, encrypt: false, refuse: null };
  if (!active) return { mode, member, encrypt: false, refuse: mode === "required" ? `encryption is required for ${to}, but ${why}; nothing was sent (never as plaintext)` : null, note: `not encrypted: ${why}` };
  return { mode, member, encrypt: true, refuse: null };
}

export const CLI_NO_E2EE = "the hoptell CLI does not send encrypted messages yet (use the agent's send_message tool)";

/**
 * The encryption policy for a plaintext send from the CLI (`hoptell send`) over `client` (a
 * connected RelayClient), which cannot encrypt: {refuse (a reason, or null), note (or null)}.
 * A direct name gets the agent session's decision (required: refused, never plaintext;
 * preferred: plaintext, said so). @role / @all is refused whenever the realm has a policy entry
 * other than off; with no policy for the realm nothing changes.
 */
export async function cliSendPolicy({ doc, client, to }) {
  const realm = client.realm?.id ?? null;
  const entries = (doc?.encryption ?? []).filter((e) => e.realm === realm && e.mode !== "off");
  if (!entries.length) return { refuse: null, note: null };
  const rpc = (f) => client.rpc(f);
  if (!to.startsWith("@")) {
    const p = await encryptionPlan({ doc, realm, caps: client.caps, rpc, list: () => client.list(), to, active: false, why: CLI_NO_E2EE });
    return { refuse: p.refuse, note: p.mode === "preferred" ? (p.note ?? `not encrypted: ${CLI_NO_E2EE}`) : null };
  }
  // A broadcast's recipients are chosen by the relay when it executes the send, not when they are
  // checked here (a session can join the role in between): with any policy for the realm the
  // CLI, which cannot encrypt, sends no broadcast at all.
  return { refuse: `fan-out (${to}) is plaintext from the hoptell CLI, and your contacts have an encryption policy for this realm; use the agent's send_message tool with encrypted sending enabled, or send to each name; nothing was sent (never as plaintext)`, note: null };
}

/**
 * The session's encrypted messaging over `relay` (the session's RelayClient). `env` holds the
 * settings' MLS driver location and credential store (HOPTELL_MLS_WASM or HOPTELL_MLS_DRIVER,
 * HOPTELL_CREDENTIAL_STORE, HOPTELL_CREDENTIAL_PASSPHRASE). `deliver(message)`
 * stores a decrypted message through the session's pipeline (resolves once stored or held).
 * Returns {ready(), plan(to), send(...), why, label}.
 */
export function sessionE2ee({ env, home, profile, relay, contacts, deliver, admitted = () => true, log = () => {} }) {
  let e2ee = null;
  // Larger transfers (design 6): created with the engine when the relay stores transfers.
  let transfers = null;
  let driver = null; // the store's MLS driver, for the release-gate label (design 3.5)
  let why = "not connected yet";
  let setting = null;
  let closed = false;

  /** After each welcome: attach this connection's device (once the engine exists, again on reconnects). */
  async function ready() {
    if (!relay.caps?.includes(E2EE_CAP)) {
      why = "this relay does not carry encrypted messages (no e2ee capability: an older relay, or one started without --experimental-e2ee)";
      return;
    }
    if (!relay.member?.id) {
      why = "encrypted messages need a member credential";
      return;
    }
    setting ??= (async () => {
      const store = await storeFor({ home, profile, env, contacts });
      if (!store.record()) throw Object.assign(new Error("this home has no device for this relay: hoptell device enroll"), { code: "no_device" });
      driver = store.driver;
      if (relay.caps?.includes(TRANSFER_CAP)) {
        const { sessionTransfers } = await import("../transfers.js");
        transfers = sessionTransfers({ home, relay, engine: () => e2ee, contacts, admitted, deliver, log });
      }
      return createE2ee({ store, driver: store.driver, client: relay, session: relay.name, home, profile, contacts, deliver, log, onTransfer: transfers ? (t) => transfers.intake(t) : null });
    })();
    try {
      e2ee = await setting;
      if (closed) {
        e2ee.close();
        e2ee = null;
        return;
      }
      await e2ee.attach();
      why = null;
      transfers?.ready().catch((e) => log(`transfers: ${e.message}`));
    } catch (e) {
      setting = e.code === "no_device" ? null : setting;
      e2ee = null;
      why = e.message;
      log(`e2ee: not available: ${e.message}`);
    }
  }

  /**
   * How a send to session name `to` goes: {mode, member, encrypt (bool), refuse (a reason, or
   * null)}. Resolving the member asks the relay only when the realm has an encryption policy.
   */
  const plan = async (to) => {
    // Fail closed: a managed policy that cannot be read refuses every send (never plaintext).
    const current = sendPolicy(contacts?.currentPolicy() ?? null);
    if (current.refuse) return { mode: "required", member: null, encrypt: false, refuse: current.refuse, unreadable: true };
    return encryptionPlan({ doc: current.doc, realm: relay.realm?.id ?? null, caps: relay.caps, rpc: (f) => relay.rpc(f), list: () => relay.list(), to, active: Boolean(e2ee), why });
  };

  return {
    ready,
    plan,
    get active() {
      return Boolean(e2ee) && !e2ee.detached?.();
    },
    get why() {
      return e2ee?.detached?.() ?? why;
    },
    /** "experimental, unreviewed" unless the driver is a reviewed build's own binding (design 3.5). */
    get label() {
      return driver ? driverLabel(driver) : E2EE_LABEL;
    },
    /** Send encrypted to {member, session}; throws when it cannot. */
    send: (args) => e2ee.send(args),
    /** An encrypted fan-out (design 4.3); throws when nothing could be sent. */
    fanout: (args) => e2ee.fanout(args),
    /**
     * Larger transfers (design 6) to session name `to`, or null when they cannot go there now: the
     * relay stores transfers, encrypted messaging is attached, and the contact's policy sends to
     * it encrypted. {member, sendFile, sendReviewSet}.
     */
    async transfersTo(to) {
      if (!transfers || !e2ee) return null;
      const p = await plan(to);
      // A policy that cannot be read refuses with its own reason (fail closed, never plaintext).
      if (p.unreadable) throw new Error(p.refuse);
      if (!p.encrypt || p.fanout || !p.member) return null;
      return { member: p.member, sendFile: (a) => transfers.sendFile({ ...a, to: { member: p.member, session: to } }), sendReviewSet: (a) => transfers.sendReviewSet({ ...a, to: { member: p.member, session: to } }) };
    },
    /** Why transfers cannot go now (for a tool's refusal). */
    get transfersWhy() {
      if (!relay.caps?.includes(TRANSFER_CAP)) return "this relay does not store transfers (no transfers capability)";
      return why ?? "encrypted messaging is not attached";
    },
    /** Stop the engine's timers (its scheduled reseal and delivery retries); with the session. */
    close() {
      closed = true;
      transfers?.close();
      e2ee?.close();
      setting?.then((x) => x.close(), () => {});
    },
    engine: () => e2ee,
  };
}

/** The tool result's text for an encrypted send; `label` as sessionE2ee's (design 3.5). */
export function describeE2ee(to, r, label = E2EE_LABEL) {
  const how = label ? `encrypted (${label})` : "end-to-end encrypted";
  if (r.state === "accepted") return `Sent to ${to}, ${how} [message_id: ${r.message_id}]${r.unverified ? "; the contact's devices are not verified yet (hoptell contacts verify)" : ""}.`;
  if (r.state === "held") return `Not sent yet: ${r.reason} [message_id: ${r.message_id}]. It goes out, ${how}, once that is resolved.`;
  // A4: accepted by the relay, but with no device of the contact in the conversation: not delivered.
  if (r.state === "undelivered") return `Not delivered: ${r.reason} [message_id: ${r.message_id}].`;
  return `Sealed, ${how}, but not confirmed by the relay (${r.reason ?? "no answer"}); it is sent again with the same operation [message_id: ${r.message_id}].`;
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
// A hosted name's refusal in an explicit fan-out list (design 4.3's hosted-custody matrix).
const HOSTED_REASONS = { hosted_custody: "hosted custody: the host can read; not sent", hosted_separately: "hosted custody: send it separately" };

/**
 * The tool result's text for an encrypted fan-out (design 4.3, "Results and replies"): counts of
 * sessions by state, with the denominator (candidates = not included + copies). `label` as
 * describeE2ee's (design 3.5).
 */
export function describeFanout(to, r, label = E2EE_LABEL) {
  const s = r.states;
  const done = s.accepted;
  const parts = [`Fan-out to ${to}, ${label ? `encrypted (${label})` : "end-to-end encrypted"}: sent to ${done} of ${plural(r.copies, "copy", "copies")}`];
  if (s.pending) parts.push(`${s.pending} not confirmed yet (sent again automatically)`);
  if (s.held) parts.push(`${s.held} wait${s.held === 1 ? "s" : ""} for a key decision by your user`);
  if (s.unavailable) parts.push(`${s.unavailable} unavailable`);
  if (s.refused) parts.push(`${s.refused} refused`);
  if (s.expired) parts.push(`${s.expired} expired`);
  const ex = r.excluded;
  const not = [
    ex.first_contact && `${plural(ex.first_contact, "session")} need${ex.first_contact === 1 ? "s" : ""} a first direct message (first-contact)`,
    ex.not_encrypted && `${plural(ex.not_encrypted, "session")} cannot receive encrypted messages (not-encrypted)`,
    ex.unavailable && `${plural(ex.unavailable, "session")} unavailable`,
    ex.refused && `${plural(ex.refused, "hosted session")} refused (hosted custody: the host can read; send separately)`,
  ].filter(Boolean);
  let text = `${parts.join("; ")}.`;
  if (not.length) text += ` Not included: ${not.join(", ")}.`;
  if (r.names) text += ` Per name: ${r.names.map((n) => `${n.name} ${n.state}${HOSTED_REASONS[n.reason] ? ` (${HOSTED_REASONS[n.reason]})` : ""}`).join(", ")}.`;
  else text += ` ${plural(r.candidates, "session")} matched ${to}.`;
  return text;
}
