// Per-session device proofs at the relay (amendments 3.5 part 2, A9). EXPERIMENTAL, with the
// device directory (lib/mls/relaydir.js).
//
// A connection proves that it holds a device's signature key before it acts for that device:
//   proof_challenge {purpose: "attach" | "register", device, key?}  -> {challenge}
// 32 random bytes bound to this connection, the purpose, the device and (for "register") the key,
// valid for 30 seconds, at most one outstanding per connection, consumed by any proof attempt
// (valid or not). The proof is SignWithLabel(device key, "hoptell-attach-v1" |
// "hoptell-register-v1", proofContent(...)) (lib/mls/identity.js): for "attach" it is checked
// against the device's currently registered key, for "register" against the key being registered.
//
// A proven attachment is (member, device, key, seq). Every device-scoped frame goes through
// guard(): the connection holds a proven attachment for its member and the device the frame
// names, and the device's registered key and sequence are still the ones the proof was checked
// against. A change of either drops every attachment of that device (drop()); those connections
// prove again with the new key. Nothing carries over to a new connection.
import crypto from "node:crypto";
import { DEVICE_ID_RE, PROOF_LABELS, b64url, proofContent, unb64, unb64url, verifyWithLabel } from "./identity.js";
import { DirectoryError } from "./relaydir.js";

/** The capability of a relay that requires device proofs (announced with the device keys one). */
export const ATTACH_PROOF_CAP = "attach-proof";
export const CHALLENGE_MS = 30_000;

/** A new connection id: 16 random bytes, base64url, never reused. */
export const newConnId = () => b64url(crypto.randomBytes(16));

const refuse = (code, message) => {
  throw new DirectoryError(code, message);
};

/**
 * The proofs and attachments of a relay over `directory` (its `current({member, device})`), for
 * realm `realm`; `now()` is the clock. `onDrop(ws)` is told when an attachment is dropped (the
 * encrypted-message frames stop delivering to that connection).
 */
export function createDeviceProofs({ directory, realm, now = () => Date.now() }) {
  /** ws -> {bytes, purpose, device, key, expires}: the one outstanding challenge. */
  const challenges = new WeakMap();
  /** "member|device" -> attached sockets. */
  const byDevice = new Map();
  const dropListeners = new Set();
  const keyOf = (member, device) => `${member}|${device}`;

  function challenge(ws, { purpose, device, key }) {
    if (purpose !== "attach" && purpose !== "register") refuse("bad_request", 'proof_challenge needs purpose "attach" or "register"');
    if (typeof device !== "string" || !DEVICE_ID_RE.test(device)) refuse("bad_request", "proof_challenge needs a device id");
    let k = null;
    if (purpose === "register") k = unb64(key, 32) ?? refuse("bad_request", "a register challenge needs the key (32 bytes, base64) the device will register");
    else if (key !== undefined && key !== null) refuse("bad_request", "an attach challenge names no key: the proof is checked against the registered one");
    const bytes = crypto.randomBytes(32);
    challenges.set(ws, { bytes, purpose, device, key: k, expires: now() + CHALLENGE_MS }); // replaces any earlier one
    return { challenge: b64url(bytes), expires_in_ms: CHALLENGE_MS };
  }

  /**
   * Check `proof` (base64 signature) for `purpose` on this connection: the outstanding challenge is
   * consumed first, whatever the outcome. For "attach" returns the device's current {key, seq}.
   */
  function verify(ws, { purpose, device, key = null, proof }) {
    const c = challenges.get(ws);
    challenges.delete(ws);
    const fail = (why) => refuse("attach_proof", `${why}; ask for a new challenge (proof_challenge) and sign it with the device key (an older hoptell needs an update to attach)`);
    if (proof === undefined || proof === null) fail("this relay requires a proof of the device key");
    if (!c) fail("no challenge is outstanding on this connection");
    if (c.expires <= now()) fail("the challenge expired");
    if (c.purpose !== purpose || c.device !== device || (purpose === "register" && !c.key.equals(Buffer.from(key)))) fail("the challenge was issued for another purpose, device or key");
    const sig = unb64(proof, 64) ?? fail("the proof is not a signature");
    const member = ws.cred.memberId;
    const cur = purpose === "attach" ? directory.current({ member, device }) : null;
    const content = proofContent({ purpose, realm, member, device, key: purpose === "register" ? Buffer.from(key) : null, conn: unb64url(ws.conn, 16), challenge: c.bytes });
    if (!verifyWithLabel(purpose === "attach" ? cur.key : key, PROOF_LABELS[purpose], content, sig)) fail("the proof does not verify with the device's key");
    return cur;
  }

  /** Attach `ws` to `device` of its member after a valid attach proof (cur: its key and seq). */
  function attach(ws, device, cur) {
    const member = ws.cred.memberId;
    if (ws.attachment && (ws.attachment.member !== member || ws.attachment.device !== device)) refuse("bad_request", "this connection is attached to another device");
    ws.attachment = { member, device, key: Buffer.from(cur.key), seq: cur.seq };
    const k = keyOf(member, device);
    if (!byDevice.has(k)) byDevice.set(k, new Set());
    byDevice.get(k).add(ws);
  }

  function detach(ws, notify = true) {
    const a = ws.attachment;
    if (!a) return;
    ws.attachment = null;
    const k = keyOf(a.member, a.device);
    byDevice.get(k)?.delete(ws);
    if (!byDevice.get(k)?.size) byDevice.delete(k);
    if (notify) for (const f of dropListeners) f(ws, a);
  }

  /** Whether `ws`'s attachment is still current (same key and sequence registered); throws a directory refusal for a revoked, suspended or unknown device. */
  function current(ws) {
    const a = ws.attachment;
    const cur = directory.current({ member: a.member, device: a.device });
    return cur.key.equals(a.key) && cur.seq === a.seq;
  }

  /**
   * The one guard of every device-scoped frame: the connection's proven attachment, for its member
   * and for `device` when the frame names one, with its key and sequence current. Returns
   * {member, device}; refuses not_attached (and does nothing) otherwise.
   */
  function guard(ws, device) {
    const a = ws.attachment;
    if (!a || a.member !== ws.cred?.memberId) refuse("not_attached", "this connection is not attached to a device: prove the device key first (proof_challenge, then e2ee_attach)");
    if (device !== undefined && device !== a.device) refuse("not_attached", "this connection is attached to another device");
    if (!current(ws)) {
      detach(ws);
      refuse("not_attached", "this device's key changed since this connection proved it; prove it again with the current key");
    }
    return { member: a.member, device: a.device };
  }

  /** The device's registered key or sequence changed (a rotation): every attachment of it is dropped. */
  function drop(member, device) {
    for (const ws of [...(byDevice.get(keyOf(member, device)) ?? [])]) detach(ws);
  }

  return {
    challenge,
    verify,
    attach,
    detach,
    guard,
    drop,
    current,
    onDrop: (f) => dropListeners.add(f),
    /** A connection closed: its challenge and attachment end with it. */
    closed(ws) {
      challenges.delete(ws);
      detach(ws, false);
    },
  };
}
