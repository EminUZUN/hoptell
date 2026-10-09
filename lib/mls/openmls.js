// The experimental OpenMLS driver (lib/mls/driver.js) over the bake-off's WASM binding
// (spike/mls-bakeoff/openmls-wasm/pkg, wasm-bindgen --target nodejs). EXPERIMENTAL and not a
// dependency: the binding is loaded from the path the owner gives (HOPTELL_MLS_WASM), never from
// the package. It sits on the binding directly, not on the bake-off's adapter, because hoptell's
// credential identity is its own (hoptell-device-v1|realm|member|device), not "user/device".
//
// Binding gaps (for manifest 3): no SignWithLabel export (sign() throws "unsupported", so planned
// rotation and signed revocation need a binding change), no KeyPackage lifetime in
// key_package_info (notAfter is null: the library's validate() checks the lifetime), and no way
// to delete an unused KeyPackage's private key once it expired, and no KeyPackageRef of the package
// a staged Welcome consumed (the adapter reads it from the storage entry staging deleted). 3.3
// adds: no query for whether a group has a pending commit (hoptell's committer record says so), no
// in-place change of the signature key in a group (rotation still replaces the whole state), and
// the ratchet tree travels beside the Welcome (join_stage takes it separately), and process
// reports a sender only as a leaf index (no credential): for a message of a retained past epoch
// the adapter resolves it in the roster it recorded when that epoch began (kept with the epoch
// start times, exported with them), never in the current roster, where the leaf may be empty or
// reused by another device after a removal.
//
// Groups (3.3) follow DRIVER-V2 and the bake-off adapter (adapters/openmls.js): retention by both
// thresholds (3 epochs and 7 days, from when each epoch began here, recomputed before every
// process and after every epoch change; no count ceiling), the pending-commit lifecycle, process
// with the binding's rollback on failure, staged commits refused with refuse_staged (as if never
// received). The state is the binding's export behind a small header with the epoch start times;
// a 3.2 state (the binding's export alone) still imports.
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { DriverError } from "./driver.js";

const require = createRequire(import.meta.url);
const MIN_PAST_EPOCHS = 3;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const NO_LEAF = 0xffffffff;
const MAGIC = Buffer.from("hoptell-openmls-state-v2\n");
const hexOf = (b) => Buffer.from(b).toString("hex");
const XWING_SUITE = 0x004d; // decision-3.1: the post-quantum suite (a provisional code point)
const CONTROL_SUITE = 0x0001;

// The library's KeyPackageRef (RFC 9420 5.2: RefHash("MLS 1.0 KeyPackage Reference", KeyPackage))
// uses the suite's hash: SHA-256 for both suites hoptell asks for. Another suite has no ref here,
// and a Welcome for it is refused (lib/mls/device.js acceptWelcome).
const REF_HASH = { [CONTROL_SUITE]: "sha256", [XWING_SUITE]: "sha256" };
const REF_LABEL = Buffer.from("MLS 1.0 KeyPackage Reference");
const varint = (n) => (n < 64 ? Buffer.from([n]) : n < 16384 ? Buffer.from([0x40 | (n >> 8), n & 255]) : Buffer.from([0x80 | ((n >>> 24) & 0x3f), (n >>> 16) & 255, (n >>> 8) & 255, n & 255]));
/** The KeyPackageRef of a KeyPackage MLSMessage (version, wire format, then the KeyPackage), or null. */
function keyPackageRef(suite, message) {
  const hash = REF_HASH[suite];
  if (!hash) return null;
  const kp = Buffer.from(message).subarray(4);
  return Uint8Array.from(crypto.createHash(hash).update(Buffer.concat([varint(REF_LABEL.length), REF_LABEL, varint(kp.length), kp])).digest());
}

/**
 * The KeyPackageRefs held in an exported state ([lib] adapter: the binding's export format, then
 * OpenMLS MemoryStorage's "KeyPackage" entries keyed by the serialized ref), as hex strings. The
 * binding does not say which package a Welcome consumed; the entry it deleted while staging does.
 */
function heldKeyPackageRefs(state) {
  const b = Buffer.from(state);
  let o = 1;
  const u32 = () => {
    const v = b.readUInt32BE(o);
    o += 4;
    return v;
  };
  const bytes = () => {
    const n = u32();
    o += n;
    return b.subarray(o - n, o);
  };
  u32();
  bytes();
  bytes();
  for (let i = u32(); i > 0; i--) bytes();
  const refs = new Set();
  for (let i = u32(); i > 0; i--) {
    const k = bytes();
    bytes();
    const m = /^KeyPackage\{"value":\{"vec":\[([0-9,]*)\]\}\}/.exec(k.toString("latin1"));
    if (m) refs.add(Buffer.from(m[1].split(",").filter(Boolean).map(Number)).toString("hex"));
  }
  return refs;
}

function call(fn) {
  try {
    return fn();
  } catch (e) {
    if (e instanceof DriverError) throw e;
    const m = /^(library|adapter): ?([\s\S]*)$/.exec(String(e?.message ?? e));
    throw new DriverError(m ? m[2] : String(e?.message ?? e), m ? m[1] : "adapter");
  }
}

/** A driver over the binding at `wasmPath` (its openmls_wasm.js). */
export function createOpenMlsDriver(wasmPath, { suite = null } = {}) {
  let wasm;
  try {
    wasm = require(wasmPath);
  } catch {
    throw new Error(`the OpenMLS binding could not be loaded from ${wasmPath} (HOPTELL_MLS_WASM)`);
  }
  const suites = [...call(() => wasm.supported_suites())];
  const chosen = suite ?? (suites.includes(XWING_SUITE) ? XWING_SUITE : CONTROL_SUITE);
  if (!suites.includes(chosen)) throw new Error(`the OpenMLS binding does not support suite ${chosen}`);
  let checker = null; // a throwaway device whose provider validates KeyPackages
  const checkerDevice = () => (checker ??= call(() => new wasm.Device(chosen, Buffer.from("hoptell-kp-checker"))));

  /** One group of a device, over the binding (the bake-off adapter's Group, with hoptell's shape). */
  function groupOf(dev, starts, rosters, now, id) {
    const gid = Uint8Array.from(id);
    const member = (m) => ({ index: m.index, identity: Uint8Array.from(m.identity), signatureKey: Uint8Array.from(m.signature_key) });
    const members = () => call(() => dev.members(gid)).map(member);
    const byIndex = (list, i) => list.find((m) => m.index === i) ?? { index: i, identity: null, signatureKey: null };
    const startsOf = () => {
      const k = hexOf(gid);
      if (!starts.has(k)) starts.set(k, new Map());
      return starts.get(k);
    };
    const rostersOf = () => {
      const k = hexOf(gid);
      if (!rosters.has(k)) rosters.set(k, new Map());
      return rosters.get(k);
    };
    const epoch = () => Number(call(() => dev.epoch(gid)));
    // DRIVER-V2 section 1: keep every past epoch younger than 7 days and at least 3.
    const young = () => {
      const t = now();
      const current = epoch();
      let oldest = null;
      for (const [e, began] of startsOf()) if (e < current && t - began < RETENTION_MS && (oldest === null || e < oldest)) oldest = e;
      return oldest === null ? 0 : current - oldest;
    };
    const retain = () => call(() => dev.set_past_epoch_limit(gid, Math.max(MIN_PAST_EPOCHS, young())));
    const epochBegan = () => {
      const current = epoch();
      const s = startsOf();
      if (!s.has(current)) s.set(current, now());
      // The epoch's roster, for senders of its messages processed after it ended.
      const r = rostersOf();
      if (!r.has(current)) r.set(current, members());
      retain();
      const held = new Set([...call(() => dev.past_epochs(gid))].map(Number));
      for (const e of [...s.keys()]) if (e < current && !held.has(e)) s.delete(e);
      for (const e of [...r.keys()]) if (e !== current && !held.has(e)) r.delete(e);
    };
    return {
      id: gid,
      _began: epochBegan,
      epoch,
      isActive: () => Boolean(call(() => dev.is_active(gid))),
      members,
      epochAuthenticator: () => Uint8Array.from(call(() => dev.epoch_authenticator(gid))),
      async commit({ add = [], remove = [], update = false } = {}) {
        const out = call(() => dev.commit(gid, add.map((kp) => new wasm.Bytes(Uint8Array.from(kp))), Uint32Array.from(remove), Boolean(update)));
        return { commit: Uint8Array.from(out.commit), welcome: out.welcome.length ? Uint8Array.from(out.welcome) : null, ratchetTree: Uint8Array.from(out.ratchet_tree) };
      },
      async mergePending() {
        call(() => dev.merge_pending(gid));
        epochBegan();
      },
      async clearPending() {
        call(() => dev.clear_pending(gid));
      },
      async encrypt(plaintext, aad = new Uint8Array()) {
        return Uint8Array.from(call(() => dev.encrypt(gid, Uint8Array.from(plaintext), Uint8Array.from(aad))));
      },
      async process(message) {
        retain();
        const current = epoch();
        const before = members(); // indexes resolve against the epoch the message belongs to
        const p = call(() => dev.process(gid, Uint8Array.from(message)));
        const e = Number(p.epoch);
        // A past epoch's message: its sender in that epoch's recorded roster (unknown: no identity).
        const roster = e === current ? before : (rostersOf().get(e) ?? []);
        const sender = p.sender === NO_LEAF ? { index: -1, identity: null, signatureKey: null } : byIndex(roster, p.sender);
        if (p.kind === "application") return { kind: "application", epoch: e, sender, plaintext: Uint8Array.from(p.plaintext), aad: Uint8Array.from(p.aad) };
        if (p.kind !== "commit") throw new DriverError(`unexpected ${p.kind} message (standalone proposals are not used)`, "adapter");
        const handle = p.staged;
        let done = false;
        const once = () => {
          if (done) throw new DriverError("this staged commit was already merged or discarded");
          done = true;
        };
        return {
          kind: "commit",
          epoch: e,
          newEpoch: Number(p.new_epoch),
          sender,
          added: p.added.map(member),
          removed: [...p.removed].map((i) => byIndex(before, i)),
          credentials: p.to_validate.map((l) => ({ identity: Uint8Array.from(l.identity), signatureKey: Uint8Array.from(l.signature_key) })),
          async merge() {
            once();
            call(() => dev.merge_staged(handle));
            epochBegan();
          },
          async discard() {
            once();
            call(() => dev.refuse_staged(handle)); // the group as before this commit arrived
          },
        };
      },
      trace(message) {
        const t = call(() => dev.trace(gid, Uint8Array.from(message)));
        return { epoch: Number(t.epoch), sender: t.sender, ratchet: t.content_type === 1 ? "application" : "handshake", generation: t.generation };
      },
      retention: () => ({ pastEpochsKept: call(() => dev.past_epochs(gid)).length, limit: call(() => dev.past_epoch_limit(gid)) }),
    };
  }

  const wrap = (dev, { epochStarts = {}, epochRosters = {}, now = Date.now } = {}) => {
    const starts = new Map(Object.entries(epochStarts).map(([g, m]) => [g, new Map(Object.entries(m).map(([e, t]) => [Number(e), t]))]));
    const unhexOrNull = (x) => (typeof x === "string" ? Uint8Array.from(Buffer.from(x, "hex")) : null);
    const rosters = new Map(Object.entries(epochRosters).map(([g, m]) => [g, new Map(Object.entries(m).map(([e, list]) => [Number(e), list.map(([index, identity, key]) => ({ index, identity: unhexOrNull(identity), signatureKey: unhexOrNull(key) }))]))]));
    const groups = new Map();
    const groupFor = (id) => {
      const k = hexOf(id);
      if (!groups.has(k)) groups.set(k, groupOf(dev, starts, rosters, now, id));
      return groups.get(k);
    };
    const known = () => new Set(call(() => dev.group_ids()).map((g) => hexOf(g.bytes)));
    return {
      identity: null,
      async createGroup(groupId) {
        call(() => dev.create_group(Uint8Array.from(groupId)));
        const g = groupFor(groupId);
        g._began();
        return g;
      },
      group(groupId) {
        return known().has(hexOf(groupId)) ? groupFor(groupId) : null;
      },
      signaturePublicKey: () => Uint8Array.from(call(() => dev.signature_public_key())),
      keyPackage: async ({ lifetimeSeconds, capabilities = {} } = {}) => {
        const u16 = (l) => (l === undefined ? undefined : Uint16Array.from(l));
        return Uint8Array.from(call(() => dev.key_package(lifetimeSeconds, u16(capabilities.extensions), u16(capabilities.proposals), u16(capabilities.credentials))));
      },
      sign: async () => {
        throw new DriverError("the OpenMLS binding offers no SignWithLabel for application statements", "adapter", { code: "unsupported" });
      },
      stageWelcome: async (welcome, ratchetTree) => {
        const before = heldKeyPackageRefs(call(() => dev.export_state()));
        const staged = call(() => dev.join_stage(welcome, ratchetTree));
        // The package the library consumed: the one entry staging deleted (a refused Welcome
        // deletes none; the binding restores the storage on a refusal and on discard).
        const after = heldKeyPackageRefs(call(() => dev.export_state()));
        const gone = [...before].filter((r) => !after.has(r));
        let done = false;
        return {
          keyPackageRef: gone.length === 1 ? Uint8Array.from(Buffer.from(gone[0], "hex")) : null,
          groupId: Uint8Array.from(staged.group_id),
          members: staged.members.map((m) => ({ identity: Uint8Array.from(m.identity), signatureKey: Uint8Array.from(m.signature_key) })),
          finish: async () => {
            if (done) throw new DriverError("this Welcome was already finished or discarded");
            done = true;
            const id = Uint8Array.from(call(() => dev.join_finish(staged.handle)));
            groupFor(id)._began();
            return id;
          },
          discard: async () => {
            if (done) return;
            done = true;
            call(() => dev.join_discard(staged.handle)); // restores the KeyPackage's private key
          },
        };
      },
      async exportState() {
        const epochRosters = Object.fromEntries([...rosters].map(([g, m]) => [g, Object.fromEntries([...m].map(([e, list]) => [e, list.map((x) => [x.index, x.identity && hexOf(x.identity), x.signatureKey && hexOf(x.signatureKey)])]))]));
        const header = Buffer.from(JSON.stringify({ epochStarts: Object.fromEntries([...starts].map(([g, m]) => [g, Object.fromEntries(m)])), epochRosters }));
        const len = Buffer.alloc(4);
        len.writeUInt32BE(header.length);
        return Uint8Array.from(Buffer.concat([MAGIC, len, header, Buffer.from(call(() => dev.export_state()))]));
      },
      coverage: {
        library: ["signature key pair", "KeyPackage private keys until a Welcome consumes them", "group state, secret trees, pending commits (3.3)"],
        adapter: ["export/import of the whole provider storage map (no public export API in OpenMLS)", "snapshot and restore around a refused or failed Welcome", "each retained epoch's roster, for the sender of a past epoch's message"],
        missing: [
          "SignWithLabel for hoptell statements",
          "the lifetime of a decoded KeyPackage",
          "deleting expired unused KeyPackage private keys",
          "a query for whether a group has a pending commit",
          "changing the signature key in place in a group (rotation replaces the whole state)",
          "staged received commits are not exported (processed again after a restart)",
          "no sender credential in a processed message, only its leaf index (the adapter keeps each retained epoch's roster)",
        ],
      },
    };
  };

  /** A state from exportState(): this driver's header and the binding's export, or a 3.2 export alone. */
  function readState(state) {
    const b = Buffer.from(state);
    if (!b.subarray(0, MAGIC.length).equals(MAGIC)) return { body: b, epochStarts: {}, epochRosters: {} };
    const n = b.readUInt32BE(MAGIC.length);
    let header;
    try {
      header = JSON.parse(b.subarray(MAGIC.length + 4, MAGIC.length + 4 + n).toString("utf8"));
    } catch {
      throw new DriverError("bad device state header", "adapter");
    }
    return { body: b.subarray(MAGIC.length + 4 + n), epochStarts: header.epochStarts ?? {}, epochRosters: header.epochRosters ?? {} };
  }

  return {
    name: "openmls",
    version: "0.9.1",
    suite: chosen,
    async createDevice(identity, { now = Date.now } = {}) {
      const d = wrap(call(() => new wasm.Device(chosen, Uint8Array.from(identity))), { now });
      d.identity = Uint8Array.from(identity);
      return d;
    },
    async importDevice(state, { identity = null, now = Date.now } = {}) {
      const { body, epochStarts, epochRosters } = readState(state);
      const d = wrap(call(() => wasm.Device.import_state(Uint8Array.from(body))), { epochStarts, epochRosters, now });
      d.identity = identity;
      return d;
    },
    inspectKeyPackage(bytes) {
      const info = call(() => checkerDevice().key_package_info(Uint8Array.from(bytes)));
      return { identity: Uint8Array.from(info.identity), signatureKey: Uint8Array.from(info.signature_key), notAfter: null, capabilities: null, ref: keyPackageRef(chosen, bytes) };
    },
  };
}
