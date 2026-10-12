// hoptell's boundary to an MLS library (design 3.2, implementation plan 3.2). EXPERIMENTAL: the
// library is not released (decision-3.1-mls.md: nothing ships before a qualified manifest and the 3.5 review), so
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
//   driver.signing                                       true when device.sign works (amendment
//                                                        A3); absent or false: sign() refuses with
//                                                        code "unsupported", and rotate, revoke and
//                                                        migrate refuse before any change
//   driver.skipLimits() -> {perSenderEpoch, forward}|null optional (amendment A6): the skipped-key
//                                                        bounds the library applies to new groups
//   driver.pruneKeyPackages(device, {nowSeconds, graceSeconds}) -> [ref]
//                                                        optional (amendments 3.5 part 2, A10):
//                                                        deletes from the device state the
//                                                        KeyPackage bundles (init and leaf private
//                                                        keys) whose not_after is earlier than
//                                                        now - grace, never a later one, and returns
//                                                        their refs (as inspectKeyPackage's); a
//                                                        failure leaves the state as it was. Absent:
//                                                        expired unused keys stay until re-enrollment
//
//   device.identity                                      the credential identity (bytes)
//   device.signaturePublicKey() -> bytes (32)
//   device.keyPackage({lifetimeSeconds, capabilities}) -> bytes
//                                                        a single-use KeyPackage; its private keys
//                                                        stay in the device state until used
//   device.sign(label, content) -> bytes (64)            SignWithLabel with the signature key, for
//                                                        hoptell's statements (rotation, revocation)
//                                                        and the per-session device proofs (A9:
//                                                        registration and attachment need it)
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
//   group.skipLimits() -> {perSenderEpoch, forward}|null optional (amendment A6): the group's own
//     skipped-key bounds; a group made by an earlier binding may differ from driver.skipLimits()
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

/** Whether the driver can sign hoptell's statements (A3): only an explicit `signing: true` (fail closed). */
export const canSign = (d) => d?.signing === true;

/** The refusal of a device-signed operation on a driver without signing (A3), or null. */
export function signingRefusal(d, what) {
  if (canSign(d)) return null;
  return new DriverError(`${what} needs a device-signed statement, and this MLS binding has no SignWithLabel (device-signed revocation and rotation are unavailable with it); nothing was changed. A relay admin can still revoke a device: hoptell members device-revoke`, "adapter", { code: "unsupported" });
}

/** Whether the driver can delete expired, unused KeyPackage private keys (A10). */
export const canPrune = (d) => typeof d?.pruneKeyPackages === "function";

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

// The release gate (design 3.5): every encrypted surface carries this label unless the driver is
// the package's own binding bundle, loaded by loadDriver from bytes that matched the reviewed
// digests (lib/mls/openmls.js REVIEWED_BINDING). The set is private and filled only below, from
// the branch loadDriver took: a driver cannot mark itself, and an external binding override
// (HOPTELL_MLS_WASM, HOPTELL_MLS_DRIVER) never drops the label, whatever its bytes.
export const E2EE_LABEL = "experimental, unreviewed";
const reviewedDrivers = new WeakSet();

/** The label of encrypted sends over driver `d`: E2EE_LABEL, or null for a reviewed build's own binding. */
export const driverLabel = (d) => (reviewedDrivers.has(d) ? null : E2EE_LABEL);

/**
 * The driver named by the environment: HOPTELL_MLS_DRIVER (an absolute path to an ES module
 * exporting `driver`, or `createDriver()`), else HOPTELL_MLS_WASM (the OpenMLS binding's
 * openmls_wasm.js), else, in a reviewed build only (REVIEWED_BINDING set), the binding bundle
 * shipped in lib/mls/binding/. Before the gate the constants are null, so the binding loads only
 * from a path the owner gives, even if a bundle directory exists, and without one there is no
 * driver: there is no default library. `shipped` is for tests only (the bundle's directory and
 * the reviewed digests).
 */
export async function loadDriver(env = process.env, { shipped = {} } = {}) {
  if (env.HOPTELL_MLS_DRIVER) {
    const file = env.HOPTELL_MLS_DRIVER;
    if (!path.isAbsolute(file)) throw new Error("HOPTELL_MLS_DRIVER must be an absolute path to a driver module");
    const mod = await import(pathToFileURL(file).href);
    const d = checkDriver(mod.driver ?? (await mod.createDriver?.()));
    reviewedDrivers.delete(d); // even the package's own driver object, handed back by a module
    return d;
  }
  if (env.HOPTELL_MLS_WASM) {
    const { createOpenMlsDriver } = await import("./openmls.js");
    return checkDriver(createOpenMlsDriver(env.HOPTELL_MLS_WASM));
  }
  const { createShippedOpenMlsDriver, reviewedDigestsDeclared, shippedBindingPresent } = await import("./openmls.js");
  if (reviewedDigestsDeclared(shipped) && shippedBindingPresent(shipped)) {
    const { driver, reviewed } = createShippedOpenMlsDriver(shipped);
    if (reviewed === true) reviewedDrivers.add(checkDriver(driver));
    return checkDriver(driver);
  }
  throw new Error("no MLS library is configured (experimental): set HOPTELL_MLS_WASM to the OpenMLS binding's openmls_wasm.js, or HOPTELL_MLS_DRIVER to a driver module");
}
