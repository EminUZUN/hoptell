// hoptell's boundary to an MLS library (design 3.2, implementation plan 3.2). EXPERIMENTAL: the
// library is not chosen (decision-3.1-mls.md: nothing ships until manifest 3 qualifies one), so
// everything library-specific sits behind this small interface and the rest of hoptell imports
// none. No library is a dependency of the package: a driver is loaded only when the owner names
// it, from a module file (HOPTELL_MLS_DRIVER) or the experimental OpenMLS WASM build
// (HOPTELL_MLS_WASM, see lib/mls/openmls.js).
//
// The interface (every byte string is a Uint8Array; KeyPackages are MLSMessage wire encodings):
//
//   driver.name, driver.version, driver.suite           the library, its pinned release, the suite
//   driver.createDevice(identity) -> Device              a new signature key (Ed25519) and a
//                                                        BasicCredential with `identity` (bytes)
//   driver.importDevice(state) -> Device                 from device.exportState(), any process
//   driver.inspectKeyPackage(bytes, {now}) -> {identity, signatureKey, notAfter, capabilities, ref}
//                                                        decode and validate (signature, version,
//                                                        suite, lifetime); throws DriverError.
//                                                        notAfter (ms) or null when the library
//                                                        validates the lifetime but cannot show it;
//                                                        ref: the library's KeyPackageRef (bytes)
//   driver.verify(publicKey, label, content, signature)  optional; hoptell verifies Ed25519 itself
//
//   device.identity                                      the credential identity (bytes)
//   device.signaturePublicKey() -> bytes (32)
//   device.keyPackage({lifetimeSeconds, capabilities}) -> bytes
//                                                        a single-use KeyPackage; its private keys
//                                                        stay in the device state until used
//   device.sign(label, content) -> bytes (64)            SignWithLabel with the signature key, for
//                                                        hoptell's statements (rotation, revocation)
//   device.stageWelcome(welcome, ratchetTree) -> {groupId, members, keyPackageRef, finish(), discard()}
//                                                        the one 3.3 operation 3.2 needs (the
//                                                        Welcome replay record): nothing changes
//                                                        until finish(); discard() keeps the
//                                                        KeyPackage's private key. keyPackageRef:
//                                                        the ref (as inspectKeyPackage's) of the
//                                                        package this Welcome consumes, or null
//   device.exportState() -> bytes                        everything a fresh process needs,
//                                                        groups and their pending commits included
//   device.coverage                                      {library, adapter, missing}: what is kept
//                                                        where (design 3.2 "Storage", [lib])
//
// Groups (design 3.3; DRIVER-V2 for retention and the commit lifecycle). A Welcome's finish()
// returns the group id; the group is then device.group(id).
//
//   device.createGroup(groupId) -> Group                 a new group at epoch 0 with this device
//   device.group(groupId) -> Group | null
//   group.id, group.epoch() -> number, group.isActive() -> boolean (false once removed)
//   group.members() -> [{index, identity, signatureKey}] the authenticated membership
//   group.epochAuthenticator() -> bytes                  RFC 9420 epoch_authenticator (fork evidence)
//   group.commit({add: [KeyPackage], remove: [leaf index], update}) -> {commit, welcome|null,
//                                                        ratchetTree}: kept as the group's pending
//                                                        commit (in exportState) until one of
//   group.mergePending() / group.clearPending()          our own commit accepted / lost
//   group.encrypt(plaintext, aad) -> bytes               an application message (PrivateMessage)
//   group.process(message) -> one of
//     {kind: "application", epoch, sender, plaintext, aad}
//     {kind: "commit", epoch, newEpoch, sender, added: [member], removed: [member],
//      credentials: [{identity, signatureKey}], merge(), discard()}
//                                                        sender and removed are members ({index,
//                                                        identity, signatureKey}) resolved before
//                                                        the commit applies; credentials are every
//                                                        credential the commit brings in, for the
//                                                        caller's checks. Nothing changes until
//                                                        merge(); discard() puts the group back as
//                                                        if the commit had never arrived. A staged
//                                                        commit lives in memory only: after a
//                                                        restart the commit is processed again.
//                                                        A failed process changes nothing (MI5: the
//                                                        binding snapshots around it), and a device
//                                                        cannot process its own commit.
//   group.trace(message) -> {epoch, sender, ratchet, generation}  optional, read-only evidence
//   group.retention() -> {pastEpochsKept, limit}         optional (DRIVER-V2 section 1)
//
// Errors are DriverErrors with `attribution` "library" (the library refused), "adapter" (misuse or
// a binding gap, with code "unsupported" for an operation the binding does not offer) or "oracle".
import path from "node:path";
import { pathToFileURL } from "node:url";

export class DriverError extends Error {
  constructor(message, attribution = "adapter", extra = {}) {
    super(message);
    this.name = "DriverError";
    this.attribution = attribution;
    Object.assign(this, extra);
  }
}

const DRIVER_FNS = ["createDevice", "importDevice", "inspectKeyPackage"];
const DEVICE_FNS = ["signaturePublicKey", "keyPackage", "sign", "stageWelcome", "exportState"];

/** Check a driver's shape (the parts 3.2 calls); throws with the first missing part. */
export function checkDriver(d) {
  if (!d || typeof d !== "object") throw new Error("an MLS driver must be an object");
  for (const k of ["name", "version"]) if (typeof d[k] !== "string") throw new Error(`the MLS driver has no ${k}`);
  if (!Number.isInteger(d.suite)) throw new Error("the MLS driver has no suite");
  for (const f of DRIVER_FNS) if (typeof d[f] !== "function") throw new Error(`the MLS driver lacks ${f}()`);
  return d;
}

/** Check a device's shape. */
export function checkDevice(dev) {
  for (const f of DEVICE_FNS) if (typeof dev?.[f] !== "function") throw new Error(`the MLS device lacks ${f}()`);
  return dev;
}

const GROUP_DEVICE_FNS = ["createGroup", "group"];
const GROUP_FNS = ["epoch", "isActive", "members", "epochAuthenticator", "commit", "mergePending", "clearPending", "encrypt", "process"];

/** Check that a device offers 3.3's group operations (and a group's shape, when given). */
export function checkGroups(dev, group = null) {
  for (const f of GROUP_DEVICE_FNS) if (typeof dev?.[f] !== "function") throw new DriverError(`the MLS device lacks ${f}() (encrypted messages need 3.3's group operations)`, "adapter", { code: "unsupported" });
  if (group) for (const f of GROUP_FNS) if (typeof group[f] !== "function") throw new DriverError(`the MLS group lacks ${f}()`, "adapter", { code: "unsupported" });
  return dev;
}

/**
 * The driver named by the environment: HOPTELL_MLS_DRIVER (an absolute path to an ES module
 * exporting `driver`, or `createDriver()`), else HOPTELL_MLS_WASM (the OpenMLS binding's
 * openmls_wasm.js). Throws when neither is set: there is no default library.
 */
export async function loadDriver(env = process.env) {
  if (env.HOPTELL_MLS_DRIVER) {
    const file = env.HOPTELL_MLS_DRIVER;
    if (!path.isAbsolute(file)) throw new Error("HOPTELL_MLS_DRIVER must be an absolute path to a driver module");
    const mod = await import(pathToFileURL(file).href);
    return checkDriver(mod.driver ?? (await mod.createDriver?.()));
  }
  if (env.HOPTELL_MLS_WASM) {
    const { createOpenMlsDriver } = await import("./openmls.js");
    return checkDriver(createOpenMlsDriver(env.HOPTELL_MLS_WASM));
  }
  throw new Error("no MLS library is configured (experimental): set HOPTELL_MLS_WASM to the OpenMLS binding's openmls_wasm.js, or HOPTELL_MLS_DRIVER to a driver module");
}
