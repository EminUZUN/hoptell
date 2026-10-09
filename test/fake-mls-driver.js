// A deterministic fake of lib/mls/driver.js for tests: Ed25519 keys derived from a seed and a
// counter, KeyPackages as signed JSON with a lifetime, a device state as JSON. It follows the
// interface's rules (single-use KeyPackages, a staged Welcome changes nothing until finish(),
// discard() keeps the private key, expired KeyPackages refused) without any MLS. Not a library:
// tests of hoptell's own layer use it; test/mls-openmls.test.js runs the real binding when built.
//
// Groups (3.3) keep the behaviors hoptell relies on, the binding's included: an epoch secret and
// an epoch authenticator derived from the group's whole commit history (two histories that differ
// give different authenticators at the same epoch), commits signed by the committer and bound to
// the epoch, application messages sealed with AES-GCM under a per-sender, per-generation key; a
// generation is consumed before the seal is checked, as OpenMLS does, and every failed process
// restores the state it had (MI5); a device cannot process its own commit; the pending commit is
// in the exported state, a staged received commit only in memory; 3 past epochs are kept.
//
// The module's `driver` uses HOPTELL_FAKE_MLS_SEED (or a random seed), so the CLI can load it with
// HOPTELL_MLS_DRIVER=<this file>.
import crypto from "node:crypto";
import { DriverError } from "../lib/mls/driver.js";
import { signContent } from "../lib/mls/identity.js";

const PKCS8 = Buffer.from("302e020100300506032b657004220420", "hex");
const MAGIC = Buffer.from("FKP1");
const COMMIT = Buffer.from("FCM1");
const APP = Buffer.from("FAP1");
const PAST_KEPT = 3;
const sha = (...parts) => crypto.createHash("sha256").update(parts.map((p) => (typeof p === "string" ? p : Buffer.from(p).toString("hex"))).join("|")).digest();
const ED_SPKI = Buffer.from("302a300506032b6570032100", "hex");
const pubKeyOf = (raw) => crypto.createPublicKey({ key: Buffer.concat([ED_SPKI, Buffer.from(raw)]), format: "der", type: "spki" });
/** Framed bytes: magic, a 4-byte length, a JSON body, then a trailer (MAC, signature or ciphertext). */
const frame = (magic, body, trailer) => {
  const json = Buffer.from(JSON.stringify(body));
  const len = Buffer.alloc(4);
  len.writeUInt32BE(json.length);
  return Buffer.concat([magic, len, json, trailer]);
};
function unframe(magic, bytes) {
  const b = Buffer.from(bytes);
  if (b.length < 8 || !b.subarray(0, 4).equals(magic)) throw new DriverError("malformed message", "library");
  const n = b.readUInt32BE(4);
  if (b.length < 8 + n) throw new DriverError("malformed message", "library");
  let body;
  try {
    body = JSON.parse(b.subarray(8, 8 + n).toString("utf8"));
  } catch {
    throw new DriverError("malformed message", "library");
  }
  return { body, json: b.subarray(8, 8 + n), trailer: b.subarray(8 + n) };
}
const b64 = (b) => Buffer.from(b).toString("base64");

/** The fake's KeyPackage reference (the library's ref: stageWelcome names the one it consumed). */
const refOf = (init) => Uint8Array.from(crypto.createHash("sha256").update(`fake-kp-ref|${init}`).digest());

const keyOf = (seed) => {
  const priv = crypto.createPrivateKey({ key: Buffer.concat([PKCS8, seed]), format: "der", type: "pkcs8" });
  const pub = crypto.createPublicKey(priv).export({ format: "der", type: "spki" }).subarray(-32);
  return { priv, pub: Uint8Array.from(pub) };
};

export function createFakeDriver({ seed = "hoptell-fake", now = () => Date.now(), faults = new Set() } = {}) {
  let counter = 0;
  const derive = (label) => crypto.createHash("sha256").update(`${seed}|${label}|${counter++}`).digest();
  const fail = (point) => {
    if (faults.has(point)) {
      faults.delete(point);
      throw new DriverError(`fault at ${point}`, "library");
    }
  };

  function makeDevice(state) {
    const { priv, pub } = keyOf(Buffer.from(state.seed, "base64"));
    const signRaw = (bytes) => crypto.sign(null, bytes, priv);
    // ---- groups ----------------------------------------------------------------------------------
    const secretOf = (history) => sha("fake-epoch-secret", history);
    const memberOut = (m) => (m ? { index: m.index, identity: Buffer.from(m.identity, "base64"), signatureKey: Buffer.from(m.key, "base64") } : null);
    /** Apply a commit body to a copy of group state G; returns the new state. */
    function applied(G, body, json) {
      const next = structuredClone(G);
      next.past[G.epoch] = { history: G.history, members: G.members };
      for (const e of Object.keys(next.past)) if (Number(e) < G.epoch + 1 - PAST_KEPT) delete next.past[e];
      for (const i of body.removes) next.members = next.members.filter((m) => m.index !== i);
      let free = 0;
      for (const kp of body.adds) {
        const info = inspect(Buffer.from(kp, "base64"));
        while (next.members.some((m) => m.index === free)) free++;
        next.members.push({ index: free, identity: b64(info.identity), key: b64(info.signatureKey) });
      }
      next.members.sort((a, b) => a.index - b.index);
      next.epoch = G.epoch + 1;
      next.history = sha(G.history, json).toString("hex");
      next.gen = 0;
      next.pending = null;
      if (body.removes.includes(G.own)) next.active = false;
      return next;
    }
    function groupApi(g) {
      const G = () => state.mls[g];
      const id = Buffer.from(g, "hex");
      /** MI5: a failed process leaves the state exactly as it was (the snapshot around it). */
      const guarded = async (fn) => {
        const snapshot = structuredClone(state.mls[g]);
        try {
          return await fn();
        } catch (e) {
          state.mls[g] = snapshot;
          throw e instanceof DriverError ? e : new DriverError(e.message, "library");
        }
      };
      return {
        id,
        epoch: () => G().epoch,
        isActive: () => G().active,
        members: () => G().members.map(memberOut),
        epochAuthenticator: () => sha("fake-epoch-authenticator", G().history),
        async commit({ add = [], remove = [], update = false } = {}) {
          fail("commit");
          const cur = G();
          if (!cur.active) throw new DriverError("this device is no longer in the group", "library");
          for (const kp of add) inspect(kp);
          for (const i of remove) if (!cur.members.some((m) => m.index === i)) throw new DriverError(`no member at index ${i}`, "library");
          const body = { t: "fake-commit", group: g, epoch: cur.epoch, sender: cur.own, adds: add.map(b64), removes: remove, update: Boolean(update), nonce: derive("nonce").subarray(0, 8).toString("hex") };
          const json = Buffer.from(JSON.stringify(body));
          const mac = crypto.createHmac("sha256", secretOf(cur.history)).update(json).digest();
          const signed = frame(COMMIT, body, mac);
          const commit = Buffer.concat([signed, signRaw(signed)]);
          const next = applied(cur, body, json);
          const welcome = add.length ? Buffer.from(JSON.stringify({ t: "fake-welcome", group: g, inits: add.map((kp) => inspect(kp).init), snapshot: { epoch: next.epoch, members: next.members, history: next.history } })) : null;
          cur.pending = { next };
          return { commit: Uint8Array.from(commit), welcome: welcome && Uint8Array.from(welcome), ratchetTree: Uint8Array.from(Buffer.from(JSON.stringify(next.members))) };
        },
        async mergePending() {
          fail("mergePending");
          if (!G().pending) throw new DriverError("no pending commit", "library");
          state.mls[g] = { ...G().pending.next, own: G().own };
        },
        async clearPending() {
          G().pending = null;
        },
        async encrypt(plaintext, aad = new Uint8Array()) {
          fail("encrypt");
          const cur = G();
          if (!cur.active) throw new DriverError("this device is no longer in the group", "library");
          const gen = cur.gen++;
          const iv = derive("iv").subarray(0, 12);
          const header = { group: g, epoch: cur.epoch, sender: cur.own, gen, iv: b64(iv), aad: b64(aad) };
          const key = sha(secretOf(cur.history), String(cur.own), String(gen));
          const c = crypto.createCipheriv("aes-256-gcm", key, iv);
          c.setAAD(Buffer.from(JSON.stringify(header)));
          const ct = Buffer.concat([c.update(plaintext), c.final(), c.getAuthTag()]);
          return Uint8Array.from(frame(APP, header, ct));
        },
        process(message) {
          return guarded(async () => {
            fail("process");
            const b = Buffer.from(message ?? []);
            const cur = G();
            if (b.subarray(0, 4).equals(APP)) {
              const { body, json, trailer } = unframe(APP, b);
              if (body.group !== g) throw new DriverError("another group", "library");
              const epochState = body.epoch === cur.epoch ? { history: cur.history, members: cur.members } : cur.past[body.epoch];
              if (!epochState) throw new DriverError("ValidationError(WrongEpoch)", "library");
              const sender = epochState.members.find((m) => m.index === body.sender);
              if (!sender) throw new DriverError("unknown sender", "library");
              if (body.sender === cur.own && body.epoch === cur.epoch) throw new DriverError("CannotDecryptOwnMessage", "library");
              // Consumed before the seal is checked, as OpenMLS 0.9.1 advances its secret tree.
              const used = ((cur.consumed[body.epoch] ??= {})[body.sender] ??= []);
              if (used.includes(body.gen)) throw new DriverError("SecretTreeError(SecretReuseError)", "library");
              used.push(body.gen);
              const key = sha(secretOf(epochState.history), String(body.sender), String(body.gen));
              let plaintext;
              try {
                const d = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(body.iv, "base64"));
                d.setAAD(json);
                d.setAuthTag(trailer.subarray(-16));
                plaintext = Buffer.concat([d.update(trailer.subarray(0, -16)), d.final()]);
              } catch {
                throw new DriverError("AEAD error", "library");
              }
              return { kind: "application", epoch: body.epoch, sender: memberOut(sender), plaintext: Uint8Array.from(plaintext), aad: Uint8Array.from(Buffer.from(body.aad, "base64")) };
            }
            if (!b.subarray(0, 4).equals(COMMIT) || b.length < 8 + 32 + 64) throw new DriverError("malformed message", "library");
            const signed = b.subarray(0, b.length - 64);
            const { body, json, trailer } = unframe(COMMIT, signed);
            if (body.t !== "fake-commit" || body.group !== g || !Array.isArray(body.adds) || !Array.isArray(body.removes)) throw new DriverError("malformed commit", "library");
            if (body.epoch !== cur.epoch) throw new DriverError("ValidationError(WrongEpoch)", "library");
            if (body.sender === cur.own) throw new DriverError("ValidationError(CannotDecryptOwnMessage)", "library");
            if (!crypto.timingSafeEqual(trailer, crypto.createHmac("sha256", secretOf(cur.history)).update(json).digest())) throw new DriverError("AEAD error", "library");
            const sender = cur.members.find((m) => m.index === body.sender);
            if (!sender || !crypto.verify(null, signed, pubKeyOf(Buffer.from(sender.key, "base64")), b.subarray(b.length - 64))) throw new DriverError("invalid signature", "library");
            for (const i of body.removes) if (!cur.members.some((m) => m.index === i)) throw new DriverError(`no member at index ${i}`, "library");
            const next = applied(cur, body, json);
            const added = next.members.filter((m) => !cur.members.some((x) => x.index === m.index && x.identity === m.identity));
            let done = false;
            return {
              kind: "commit",
              epoch: cur.epoch,
              newEpoch: next.epoch,
              sender: memberOut(sender),
              added: added.map(memberOut),
              removed: body.removes.map((i) => memberOut(cur.members.find((m) => m.index === i))),
              credentials: [sender, ...added].map((m) => ({ identity: Buffer.from(m.identity, "base64"), signatureKey: Buffer.from(m.key, "base64") })),
              async merge() {
                if (done) throw new DriverError("this staged commit was already merged or discarded");
                fail("merge");
                done = true;
                if (state.mls[g].epoch !== cur.epoch) throw new DriverError("the group moved on", "library");
                state.mls[g] = { ...next, own: cur.own, pending: null };
              },
              async discard() {
                done = true;
              },
            };
          });
        },
      };
    }

    return {
      identity: Buffer.from(state.identity, "base64"),
      signaturePublicKey: () => pub,
      async keyPackage({ lifetimeSeconds = 14 * 86400, capabilities = null } = {}) {
        fail("keyPackage");
        const init = derive("init").subarray(0, 16).toString("hex");
        const body = Buffer.from(JSON.stringify({ t: "fake-kp", identity: state.identity, key: b64(pub), init, notAfter: now() + lifetimeSeconds * 1000, capabilities }));
        state.kps[init] = now() + lifetimeSeconds * 1000;
        const len = Buffer.alloc(4);
        len.writeUInt32BE(body.length);
        const signed = Buffer.concat([MAGIC, len, body]);
        return Uint8Array.from(Buffer.concat([signed, signRaw(signed)]));
      },
      async sign(label, content) {
        fail("sign");
        return Uint8Array.from(signRaw(signContent(label, content)));
      },
      async stageWelcome(welcome) {
        fail("stageWelcome");
        let w;
        try {
          w = JSON.parse(Buffer.from(welcome).toString("utf8"));
        } catch {
          throw new DriverError("not a Welcome", "library");
        }
        if (w?.t !== "fake-welcome" || (typeof w.init !== "string" && !Array.isArray(w.inits))) throw new DriverError("not a Welcome", "library");
        if (Array.isArray(w.inits)) w.init = w.inits.find((i) => i in state.kps);
        if (!(w.init in state.kps)) throw new DriverError("no KeyPackage of this device matches the Welcome", "library");
        let done = false;
        return {
          groupId: Buffer.from(w.group, "hex"),
          members: (w.snapshot?.members ?? []).map((m) => ({ identity: Buffer.from(m.identity, "base64"), signatureKey: Buffer.from(m.key, "base64") })),
          keyPackageRef: refOf(w.init),
          async finish() {
            if (done) throw new DriverError("this Welcome was already finished or discarded");
            fail("finishWelcome");
            done = true;
            delete state.kps[w.init]; // the private key is deleted on use
            if (!state.groups.includes(w.group)) state.groups.push(w.group);
            if (w.snapshot) {
              const own = w.snapshot.members.find((m) => m.identity === state.identity && m.key === b64(pub));
              if (!own) throw new DriverError("this device is not in the Welcome's group", "library");
              state.mls[w.group] = { ...w.snapshot, own: own.index, active: true, gen: 0, consumed: {}, past: {}, pending: null };
            }
            return Buffer.from(w.group, "hex");
          },
          async discard() {
            done = true;
          },
        };
      },
      async exportState() {
        fail("exportState");
        return Uint8Array.from(Buffer.from(JSON.stringify(state)));
      },
      async createGroup(groupId) {
        fail("createGroup");
        const g = Buffer.from(groupId).toString("hex");
        if (state.mls[g]) throw new DriverError("a group with this id exists", "library");
        state.mls[g] = { epoch: 0, members: [{ index: 0, identity: state.identity, key: b64(pub) }], own: 0, history: sha("fake-group", g).toString("hex"), active: true, gen: 0, consumed: {}, past: {}, pending: null };
        return groupApi(g);
      },
      group(groupId) {
        const g = Buffer.from(groupId).toString("hex");
        return state.mls[g] ? groupApi(g) : null;
      },
      coverage: { library: ["everything (a fake)"], adapter: [], missing: [] },
      _state: state,
    };
  }

  return {
    name: "fake",
    version: "0",
    suite: 1,
    async createDevice(identity) {
      fail("createDevice");
      return makeDevice({ v: 1, seed: b64(derive("device")), identity: b64(identity), kps: {}, groups: [], mls: {} });
    },
    async importDevice(bytes) {
      let state;
      try {
        state = JSON.parse(Buffer.from(bytes).toString("utf8"));
      } catch {
        throw new DriverError("bad device state", "adapter");
      }
      if (state?.v !== 1) throw new DriverError("bad device state", "adapter");
      state.mls ??= {};
      return makeDevice(state);
    },
    inspectKeyPackage: (bytes, opts) => inspect(bytes, opts),
  };

  function inspect(bytes, { now: at = now() } = {}) {
    const b = Buffer.from(bytes);
    if (b.length < 8 + 64 || !b.subarray(0, 4).equals(MAGIC)) throw new DriverError("not a KeyPackage", "library");
    const n = b.readUInt32BE(4);
    if (b.length !== 8 + n + 64) throw new DriverError("trailing or missing bytes", "library");
    let kp;
    try {
      kp = JSON.parse(b.subarray(8, 8 + n).toString("utf8"));
    } catch {
      throw new DriverError("not a KeyPackage", "library");
    }
    const key = Buffer.from(kp.key ?? "", "base64");
    if (kp.t !== "fake-kp" || key.length !== 32) throw new DriverError("not a KeyPackage", "library");
    const pub = crypto.createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), key]), format: "der", type: "spki" });
    if (!crypto.verify(null, b.subarray(0, 8 + n), pub, b.subarray(8 + n))) throw new DriverError("bad KeyPackage signature", "library");
    if (!(at < kp.notAfter)) throw new DriverError("LifetimeError(Expired)", "library");
    return { identity: Buffer.from(kp.identity, "base64"), signatureKey: Uint8Array.from(key), notAfter: kp.notAfter, capabilities: kp.capabilities, init: kp.init, ref: refOf(kp.init) };
  }
}

/** A fake Welcome for a fake KeyPackage (what 3.3's committer would send). */
export function fakeWelcome(kpBytes, groupId = "00") {
  const b = Buffer.from(kpBytes);
  const kp = JSON.parse(b.subarray(8, 8 + b.readUInt32BE(4)).toString("utf8"));
  return Uint8Array.from(Buffer.from(JSON.stringify({ t: "fake-welcome", group: groupId, init: kp.init })));
}

export const driver = createFakeDriver({ seed: process.env.HOPTELL_FAKE_MLS_SEED || crypto.randomBytes(16).toString("hex") });
