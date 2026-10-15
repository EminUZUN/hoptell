// The experimental OpenMLS driver (lib/mls/driver.js) over the bake-off's WASM binding
// (spike/mls-bakeoff/openmls-wasm/pkg, wasm-bindgen --target nodejs). EXPERIMENTAL and not a
// dependency: the binding is loaded from the path the owner gives (HOPTELL_MLS_WASM), or from the
// bundle the package carries in lib/mls/binding/, which loads only from verified bytes and only in a
// reviewed build (REVIEWED_BINDING set, below). It sits on the binding directly, not on the bake-off's adapter, because hoptell's
// credential identity is its own (hoptell-device-v1|realm|member|device), not "user/device".
//
// SignWithLabel (amendment A3, manifest 5): a binding that exports sign_with_label and
// verify_with_label signs hoptell's statements (rotation, revocation) with the device's key, for
// labels starting with "hoptell-" only, and the driver says so (`signing: true`); an older binding
// has neither, and sign() throws "unsupported" (`signing: false`): rotate, revoke and migrate
// then refuse before any change. The skipped-key bounds the
// binding applies are read with skip_limits() (amendment A6; null for an older binding).
// Standalone proposals are refused by the binding itself, which restores its storage first
// (amendment A7); an older binding returned kind "proposal", which the adapter still refuses.
//
// Pruning (amendments 3.5 part 2, A10, manifest 6): a binding that exports
// Device.prune_key_packages(now_seconds, grace_seconds) deletes the bundles of KeyPackages whose
// not_after is earlier than now - grace and returns their refs; the driver then offers
// pruneKeyPackages(). An older binding has no such export, the driver offers none, and expired
// unused private keys stay in the state until re-enrollment (hoptell doctor says so).
//
// Binding gaps: no KeyPackage lifetime in
// key_package_info (notAfter is null: the library's validate() checks the lifetime), and no KeyPackageRef of the package
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
// process and after every epoch change; at most MAX_PAST_EPOCHS, design 3.2 v2.1), the pending-commit lifecycle, process
// with the binding's rollback on failure, staged commits refused with refuse_staged (as if never
// received). The state is the binding's export behind a small header with the epoch start times;
// a 3.2 state (the binding's export alone) still imports.
import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { DriverError } from "./driver.js";
import { MAX_PAST_EPOCHS, MIN_PAST_EPOCHS, PAST_EPOCH_MS } from "./policy.js";

const require = createRequire(import.meta.url);
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
 * The binding's formats: 1 is version, suite, identity, signature key, group ids, storage
 * entries; 2 appends the past-epoch limit per group (group id, u32). Another version, or a state
 * that does not end where its format says, is refused.
 */
export function heldKeyPackageRefs(state) {
  const b = Buffer.from(state);
  const bad = (why) => new DriverError(`binding state: ${why}`, "adapter");
  const format = b[0];
  if (format !== 1 && format !== 2) throw bad(`unknown format ${format ?? "(empty)"}`);
  let o = 1;
  const u32 = () => {
    if (o + 4 > b.length) throw bad("truncated");
    const v = b.readUInt32BE(o);
    o += 4;
    return v;
  };
  const bytes = () => {
    const n = u32();
    if (o + n > b.length) throw bad("truncated");
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
  if (format === 2) {
    for (let i = u32(); i > 0; i--) {
      bytes();
      u32();
    }
  }
  if (o !== b.length) throw bad("trailing bytes");
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

// ---- The binding bundle shipped in the package (design 3.5, "After the gate") -----------------
// A package may carry the binding in lib/mls/binding/: the glue and the WASM file, nothing else.
// Only that bundle can drop the experimental label, and only when its bytes match these digests,
// which are constants here (this file is itself a reviewed input) and never read from a file next
// to the bundle. No reviewed build exists yet, so both are null and the label always stays.
export const REVIEWED_BINDING = Object.freeze({ glue: null, wasm: null });
export const BINDING_DIR = fileURLToPath(new URL("./binding/", import.meta.url));
export const BINDING_FILES = Object.freeze({ glue: "openmls_wasm.js", wasm: "openmls_wasm_bg.wasm" });
// What keeps the shipped glue honest is its reviewed digest and the reviewer's reading of its
// source: the glue that runs is byte for byte the glue that was reviewed. The contract the review
// checks: the glue takes the compiled module as an argument (wasm-bindgen's initSync form), reads
// no file, and loads only the built-ins below. The lint and the fresh context below catch an
// accidental violation early and loudly; neither is a security boundary (Node's vm is not a
// sandbox, and a deliberate glue can reach the host through the objects it is handed).
export const GLUE_BUILTINS = Object.freeze(["crypto"]);
const GLUE_FORBIDDEN = [/\breadFileSync\b/, /\breadFile\b/, /\b__dirname\b/, /\b__filename\b/, /\bimport\s*\(/, /\bprocess\s*\./, /\beval\s*\(/, /\bFunction\s*\(/];
const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");

/**
 * An advisory lint of a shipped glue's source (design 3.5): it should offer initSync, name no file
 * API, and require only GLUE_BUILTINS by literal name. A text check, so it finds mistakes, not a
 * glue written to evade it; the guarantee is the reviewed digest plus source review. Returns the
 * problems found (none: []).
 */
export function checkGlueSource(source) {
  const src = Buffer.isBuffer(source) ? source.toString("utf8") : String(source);
  const problems = GLUE_FORBIDDEN.filter((re) => re.test(src)).map((re) => `uses ${re.source.replace(/\\[bs]\*?/g, "").replace(/\\/g, "")}`);
  for (const m of src.matchAll(/\brequire\s*\(\s*([^)]*?)\s*\)/g)) {
    const lit = /^(["'])(?:node:)?([a-z_/]+)\1$/.exec(m[1]);
    if (!lit || !GLUE_BUILTINS.includes(lit[2])) problems.push(`requires ${m[1]}`);
  }
  if (!/\binitSync\b/.test(src)) problems.push("has no initSync");
  return problems;
}

/** Whether this build declares reviewed digests (a reviewed build); null constants: not one. */
export const reviewedDigestsDeclared = ({ reviewed = REVIEWED_BINDING } = {}) => isDigest(reviewed?.glue) && isDigest(reviewed?.wasm);

/** Whether the package carries a binding bundle (the directory exists). */
export const shippedBindingPresent = ({ dir = BINDING_DIR } = {}) => fs.existsSync(dir);

/** The digests of the shipped bundle, as read now, and whether they are the reviewed ones (doctor). */
export function shippedBindingStatus({ dir = BINDING_DIR, reviewed = REVIEWED_BINDING } = {}) {
  const digests = { glue: sha256(fs.readFileSync(path.join(dir, BINDING_FILES.glue))), wasm: sha256(fs.readFileSync(path.join(dir, BINDING_FILES.wasm))) };
  return { digests, reviewed: digestsMatch(digests, reviewed) };
}

const isDigest = (d) => typeof d === "string" && /^[0-9a-f]{64}$/.test(d);
const digestsMatch = (got, want) => isDigest(want?.glue) && isDigest(want?.wasm) && got.glue === want.glue && got.wasm === want.wasm;

/**
 * Load the shipped bundle from the bytes it verifies: read the glue and the WASM file once each,
 * hash those buffers, compile the WASM from the same buffer and evaluate the glue from the same
 * source buffer (never `require` of a path), handing it the compiled module. Nothing is read
 * again after hashing, so a file replaced meanwhile has no effect. Returns {binding, reviewed,
 * digests}; reviewed is true only when both digests equal `reviewed`'s. `read` is for tests.
 *
 * Defence in depth, not isolation: a glue the lint flags is not loaded, and the glue is evaluated
 * in a fresh context whose globals are only WebAssembly, TextEncoder and TextDecoder, with a
 * require limited to GLUE_BUILTINS, so an accidental use of process, fs or the host's require
 * fails at once instead of working quietly.
 */
export function loadShippedBinding({ dir = BINDING_DIR, reviewed = REVIEWED_BINDING, read = fs.readFileSync } = {}) {
  const glue = Buffer.from(read(path.join(dir, BINDING_FILES.glue)));
  const wasmBytes = Buffer.from(read(path.join(dir, BINDING_FILES.wasm)));
  const digests = { glue: sha256(glue), wasm: sha256(wasmBytes) };
  const problems = checkGlueSource(glue);
  if (problems.length) throw new Error(`the shipped OpenMLS glue (lib/mls/binding/${BINDING_FILES.glue}) is not loaded: the glue lint flags that it ${problems.join(", ")}`);
  const module = new WebAssembly.Module(wasmBytes);
  const glueRequire = (id) => {
    const name = String(id).replace(/^node:/, "");
    if (!GLUE_BUILTINS.includes(name)) throw new Error(`the shipped OpenMLS glue may not load ${id}`);
    return require(`node:${name}`);
  };
  const cjs = { exports: {}, require: glueRequire };
  const context = vm.createContext({ WebAssembly, TextEncoder, TextDecoder });
  vm.compileFunction(glue.toString("utf8"), ["exports", "require", "module", "__filename", "__dirname"], { filename: `lib/mls/binding/${BINDING_FILES.glue}`, parsingContext: context })(cjs.exports, glueRequire, cjs, undefined, undefined);
  const binding = cjs.exports;
  if (typeof binding?.initSync !== "function") throw new Error("the shipped OpenMLS glue has no initSync");
  // The options object is made inside the glue's context: wasm-bindgen's initSync takes `{ module }`
  // only when its prototype is that context's Object.prototype (an object made here, in another
  // realm, would be taken for the deprecated bare-module argument and refused).
  const init = vm.runInContext("({})", context);
  init.module = module;
  binding.initSync(init);
  return { binding, reviewed: digestsMatch(digests, reviewed), digests };
}

/** A driver over the shipped bundle: {driver, reviewed, digests} (lib/mls/driver.js loadDriver labels it). */
export function createShippedOpenMlsDriver(opts = {}) {
  const { binding, reviewed, digests } = loadShippedBinding(opts);
  // The shipped bundle never takes a suite option: 0x004D only (A5).
  return { driver: openMlsDriver(binding), reviewed, digests };
}

/**
 * A driver over the binding at `wasmPath` (its openmls_wasm.js). Always labeled experimental.
 * `testOnlySuite` is for tests and control rows only (the classical suite 0x0001 against the
 * post-quantum one): nothing in a user's home sets it, and no environment variable reaches it.
 */
export function createOpenMlsDriver(wasmPath, { testOnlySuite = null } = {}) {
  return openMlsDriver(loadBindingFrom(wasmPath), { testOnlySuite });
}

// What HOPTELL_MLS_WASM accepts, said in every refusal.
const WASM_FORMATS =
  "HOPTELL_MLS_WASM takes an absolute path to the binding's openmls_wasm.js (or its folder): a wasm-bindgen build for Node.js (--target nodejs), " +
  "or a build that offers initSync with its openmls_wasm_bg.wasm next to it, such as the bundle in hoptell's own lib/mls/binding/";
const loadedBindings = new Map(); // one instance per file, as a CommonJS require keeps it

/**
 * Load the OpenMLS binding the owner names (HOPTELL_MLS_WASM). The glue is evaluated as a
 * CommonJS module whatever the package around it declares (hoptell is "type": "module", so a plain
 * require of the shipped glue would fail), with a require relative to its own file. A glue that
 * offers initSync (wasm-bindgen's no-modules and web forms, the shipped bundle) is initialized with
 * the <name>_bg.wasm next to it; a Node.js build initializes itself. This is the owner's explicit
 * choice of code to run, so it is not confined; it is always labeled experimental (driver.js).
 * Errors say why the binding could not be loaded.
 */
export function loadBindingFrom(wasmPath) {
  const fail = (why) => new Error(`the OpenMLS binding could not be loaded from ${wasmPath} (HOPTELL_MLS_WASM): ${why}. ${WASM_FORMATS}`);
  if (typeof wasmPath !== "string" || !path.isAbsolute(wasmPath)) throw fail("it is not an absolute path");
  let file = wasmPath;
  try {
    if (fs.statSync(file).isDirectory()) file = path.join(file, BINDING_FILES.glue);
    file = fs.realpathSync(file);
  } catch (e) {
    throw fail(e.code === "ENOENT" ? "no such file" : `it cannot be read (${e.code || e.message})`);
  }
  if (loadedBindings.has(file)) return loadedBindings.get(file);
  let source;
  try {
    source = fs.readFileSync(file, "utf8");
  } catch (e) {
    throw fail(`it cannot be read (${e.code || e.message})`);
  }
  const cjs = { exports: {} };
  const local = createRequire(file);
  try {
    vm.compileFunction(source, ["exports", "require", "module", "__filename", "__dirname"], { filename: file })(cjs.exports, local, cjs, file, path.dirname(file));
  } catch (e) {
    const esm = e instanceof SyntaxError && /\b(import|export)\b/.test(e.message);
    throw fail(esm ? "it is an ES module; build the binding for Node.js (--target nodejs) or use the no-modules glue" : `evaluating it failed (${e?.message ?? e})`);
  }
  const binding = cjs.exports;
  if (typeof binding?.initSync === "function") {
    const wasmFile = file.replace(/\.js$/, "_bg.wasm");
    let module;
    try {
      module = new WebAssembly.Module(fs.readFileSync(wasmFile));
    } catch (e) {
      throw fail(`its glue needs ${path.basename(wasmFile)} next to it, which ${e.code === "ENOENT" ? "is missing" : `could not be compiled (${e.code || e.message})`}`);
    }
    try {
      binding.initSync({ module });
    } catch (e) {
      throw fail(`initializing the WASM module failed (${e?.message ?? e})`);
    }
  }
  if (typeof binding?.supported_suites !== "function") throw fail("it does not export the OpenMLS binding (supported_suites is missing)");
  loadedBindings.set(file, binding);
  return binding;
}

/** A10: whether the binding deletes expired, unused KeyPackage bundles (manifest 6). */
export const bindingPrunes = (wasm) => typeof wasm.Device?.prototype?.prune_key_packages === "function";
/** Whether a binding offers SignWithLabel and VerifyWithLabel for hoptell's statements (amendment A3). */
const bindingSigns = (wasm) => typeof wasm.verify_with_label === "function" && typeof wasm.Device?.prototype?.sign_with_label === "function";

/**
 * A5 (N8): production uses the post-quantum suite 0x004D only; a binding without it is refused,
 * never silently replaced by the classical suite. `testOnlySuite` picks another suite for tests.
 */
function openMlsDriver(wasm, { testOnlySuite = null } = {}) {
  const suites = [...call(() => wasm.supported_suites())];
  if (testOnlySuite === null && !suites.includes(XWING_SUITE)) throw new Error("this MLS binding lacks the required post-quantum suite (0x004D); hoptell does not fall back to the classical suite");
  const chosen = testOnlySuite ?? XWING_SUITE;
  if (!suites.includes(chosen)) throw new Error(`the OpenMLS binding does not support suite ${chosen}`);
  // A3: SignWithLabel (RFC 9420 5.1.2) for hoptell's statements, when the binding exports it.
  const signing = bindingSigns(wasm);
  const pruning = bindingPrunes(wasm);
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
    // DRIVER-V2 section 1 (design 3.2 v2.1): keep every past epoch younger than 7 days and at
    // least 3, and never more than MAX_PAST_EPOCHS.
    const young = () => {
      const t = now();
      const current = epoch();
      let oldest = null;
      for (const [e, began] of startsOf()) if (e < current && t - began < PAST_EPOCH_MS && (oldest === null || e < oldest)) oldest = e;
      return oldest === null ? 0 : current - oldest;
    };
    const retain = () => call(() => dev.set_past_epoch_limit(gid, Math.min(MAX_PAST_EPOCHS, Math.max(MIN_PAST_EPOCHS, young()))));
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
        // A7: the binding refuses a standalone proposal itself (restoring its snapshot); an older
        // binding returned it, already processed: refused here, and hoptell saves nothing after it.
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
      /** Amendment A6: this group's own skipped-key bounds (a group made by an earlier binding keeps its own), or null without the export. */
      skipLimits() {
        if (typeof dev.group_skip_limits !== "function") return null;
        const [perSenderEpoch, forward] = [...call(() => dev.group_skip_limits(gid))];
        return { perSenderEpoch, forward };
      },
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
      // SignWithLabel (RFC 9420 5.1.2) with the device's signature key; the key stays in the binding.
      sign: async (label, content) => {
        if (!signing) throw new DriverError("the OpenMLS binding offers no SignWithLabel for application statements", "adapter", { code: "unsupported" });
        return Uint8Array.from(call(() => dev.sign_with_label(String(label), Uint8Array.from(content))));
      },
      // A10: the binding's prune (seconds as u64: BigInt), for driver.pruneKeyPackages; the refs
      // come back as Bytes.
      _prune: pruning ? (nowSeconds, graceSeconds) => call(() => [...dev.prune_key_packages(BigInt(nowSeconds), BigInt(graceSeconds))].map((r) => Uint8Array.from(r.bytes))) : null,
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
          ...(signing ? [] : ["SignWithLabel for hoptell statements"]),
          "the lifetime of a decoded KeyPackage",
          ...(pruning ? [] : ["deleting expired unused KeyPackage private keys"]),
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
    /** Amendment A3: this binding signs hoptell's statements with the device key (rotate, revoke, migrate). */
    signing,
    /**
     * Amendment A10: delete the expired, unused KeyPackage bundles of `device` (not_after earlier
     * than now - grace) from its state in memory; returns their KeyPackageRefs. Absent for a
     * binding without prune_key_packages.
     */
    ...(pruning
      ? {
          pruneKeyPackages: async (device, { nowSeconds, graceSeconds }) => {
            if (typeof device?._prune !== "function") throw new DriverError("not a device of this driver", "adapter");
            if (!Number.isSafeInteger(nowSeconds) || !Number.isSafeInteger(graceSeconds) || nowSeconds < 0 || graceSeconds < 0) throw new DriverError("prune needs whole seconds", "adapter");
            return device._prune(nowSeconds, graceSeconds);
          },
        }
      : {}),
    /** VerifyWithLabel by the binding (hoptell verifies statements itself too: identity.js verifyWithLabel). */
    ...(signing ? { verify: (publicKey, label, content, signature) => Boolean(call(() => wasm.verify_with_label(chosen, Uint8Array.from(publicKey), String(label), Uint8Array.from(content), Uint8Array.from(signature)))) } : {}),
    /**
     * Amendment A6: the skipped-key bounds the binding applies to the groups it creates and joins,
     * {perSenderEpoch, forward} (contract-tested against policy.js), or null for a binding without
     * skip_limits(). A group made by an earlier binding keeps the bounds it was made with.
     */
    skipLimits() {
      if (typeof wasm.skip_limits !== "function") return null;
      const [perSenderEpoch, forward] = [...call(() => wasm.skip_limits())];
      return { perSenderEpoch, forward };
    },
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
/**
 * A driver over an already loaded binding object (A5's tests use a stand-in binding). Production
 * uses createOpenMlsDriver / createShippedOpenMlsDriver.
 */
export const openMlsDriverOver = (wasm, { testOnlySuite = null } = {}) => openMlsDriver(wasm, { testOnlySuite });
