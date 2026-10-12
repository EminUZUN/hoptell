// The shipped binding bundle (amendment A11): lib/mls/binding/ holds wasm-bindgen's --target
// no-modules glue wrapped by native/openmls-wasm/wrap-glue.mjs, and the WASM, built in the pinned
// image (native/openmls-wasm/Dockerfile). The loader (lib/mls/openmls.js loadShippedBinding) loads
// it from the bytes it hashed; with REVIEWED_BINDING null it stays labeled experimental.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { BINDING_DIR, BINDING_FILES, REVIEWED_BINDING, checkGlueSource, createShippedOpenMlsDriver, loadShippedBinding } from "../lib/mls/openmls.js";
import { credentialIdentity, newDeviceId, verifyWithLabel } from "../lib/mls/identity.js";
import { HEAD, TAIL, wrapGlue } from "../native/openmls-wasm/wrap-glue.mjs";

const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");
const GLUE = path.join(BINDING_DIR, BINDING_FILES.glue);
const WASM = path.join(BINDING_DIR, BINDING_FILES.wasm);
const id = () => credentialIdentity({ realm: "0".repeat(32), member: `m_${"a".repeat(26)}`, device: newDeviceId() });
/** A loader read hook that serves `glue` instead of the shipped glue file. */
const withGlue = (glue) => (p) => (p === GLUE ? Buffer.from(glue) : fs.readFileSync(p));

test("A11 wrap-glue: one fixed line before, `module.exports = wasm_bindgen;` after, nothing else; deterministic; other forms refused", () => {
  const src = Buffer.from("let wasm_bindgen = (function(exports) {\n    function initSync() {}\n    return exports;\n})({ __proto__: null });\n");
  const a = wrapGlue(src);
  assert.ok(a.equals(wrapGlue(Buffer.from(src))), "same input, same output");
  assert.ok(a.equals(Buffer.concat([Buffer.from(HEAD), src, Buffer.from(TAIL)])));
  assert.equal(TAIL, "module.exports = wasm_bindgen;\n");
  assert.equal(HEAD.split("\n").length, 2, "HEAD is one line");
  assert.deepEqual(checkGlueSource(HEAD), ["has no initSync"], "HEAD alone needs only node:crypto (a GLUE_BUILTINS name)");
  assert.throws(() => wrapGlue(Buffer.from("module.exports.initSync = () => {};\n")), /not wasm-bindgen --target no-modules output/);
  assert.throws(() => wrapGlue(Buffer.from("let wasm_bindgen = (function(exports) {\n})({});\n")), /no initSync/);
  assert.throws(() => wrapGlue(src.subarray(0, src.length - 1)), /line break/);
});

test("A11 the shipped glue is the wrapped no-modules glue (the wrapper reproduces it) and passes the advisory lint", () => {
  const glue = fs.readFileSync(GLUE);
  const text = glue.toString("utf8");
  assert.ok(text.startsWith(HEAD) && text.endsWith(TAIL), "HEAD and TAIL around the generated glue");
  const inner = glue.subarray(Buffer.byteLength(HEAD), glue.length - Buffer.byteLength(TAIL));
  assert.ok(wrapGlue(inner).equals(glue), "wrap-glue.mjs of the unwrapped glue gives the shipped glue byte for byte");
  assert.deepEqual(checkGlueSource(glue), []);
  // Dotfiles (a Finder .DS_Store) are never packed; recordsCheck checks the packed bundle itself.
  assert.deepEqual(fs.readdirSync(BINDING_DIR).filter((f) => !f.startsWith(".")).sort(), [BINDING_FILES.glue, BINDING_FILES.wasm].sort(), "the bundle is the glue and the WASM only");
});

test("A11 the shipped bundle loads with loadShippedBinding and runs a conversation end to end; REVIEWED_BINDING null keeps it experimental", async () => {
  assert.deepEqual(REVIEWED_BINDING, { glue: null, wasm: null });
  const { binding, reviewed, digests } = loadShippedBinding();
  assert.equal(reviewed, false, "no reviewed digests declared: experimental");
  assert.deepEqual(digests, { glue: sha256(fs.readFileSync(GLUE)), wasm: sha256(fs.readFileSync(WASM)) });
  assert.ok([...binding.supported_suites()].includes(0x004d));
  assert.equal(typeof binding.Device.prototype.prune_key_packages, "function", "the bundle carries A10's prune");
  const { driver, reviewed: r2 } = createShippedOpenMlsDriver();
  assert.equal(r2, false);
  const alice = await driver.createDevice(id());
  const bob = await driver.createDevice(id());
  const gid = crypto.randomBytes(16);
  const ga = await alice.createGroup(gid);
  const kp = await bob.keyPackage({ lifetimeSeconds: 14 * 86400 });
  driver.inspectKeyPackage(kp);
  const c = await ga.commit({ add: [kp] });
  await ga.mergePending();
  const staged = await bob.stageWelcome(c.welcome, c.ratchetTree);
  assert.equal(staged.members.length, 2, "alice and bob");
  await staged.finish();
  const gb = bob.group(gid);
  const m1 = await gb.process(await ga.encrypt(Buffer.from("hello from the shipped bundle")));
  assert.equal(Buffer.from(m1.plaintext).toString(), "hello from the shipped bundle");
  const m2 = await ga.process(await gb.encrypt(Buffer.from("and back")));
  assert.equal(Buffer.from(m2.plaintext).toString(), "and back");
  // An update commit by bob, then traffic in the new epoch; export and import.
  const u = await gb.commit({ update: true });
  await gb.mergePending();
  await (await ga.process(u.commit)).merge();
  assert.equal(ga.epoch(), gb.epoch());
  const bob2 = await driver.importDevice(await bob.exportState());
  const m3 = await bob2.group(gid).process(await ga.encrypt(Buffer.from("after import")));
  assert.equal(Buffer.from(m3.plaintext).toString(), "after import");
  assert.equal(verifyWithLabel(alice.signaturePublicKey(), "hoptell-rotate-v1", Buffer.from("x"), await alice.sign("hoptell-rotate-v1", Buffer.from("x"))), true);
});

test("A11 review digests declared (a fixture): only the shipped bytes with exactly those digests drop the label", () => {
  const actual = { glue: sha256(fs.readFileSync(GLUE)), wasm: sha256(fs.readFileSync(WASM)) };
  assert.equal(loadShippedBinding({ reviewed: actual }).reviewed, true, "matching digests");
  assert.equal(loadShippedBinding({ reviewed: { ...actual, wasm: "0".repeat(64) } }).reviewed, false, "another WASM digest: experimental");
  assert.equal(loadShippedBinding({ reviewed: { ...actual, glue: "0".repeat(64) } }).reviewed, false, "another glue digest: experimental");
  // A changed glue byte under the declared digests keeps the label (and still loads).
  const glue = Buffer.from(fs.readFileSync(GLUE).toString("utf8").replace("module.exports = wasm_bindgen;", "module.exports = wasm_bindgen; "));
  assert.equal(loadShippedBinding({ reviewed: actual, read: withGlue(glue) }).reviewed, false);
});

test("A11 the wrapper's first line is needed: without it the binding has no randomness in the loader's fresh context", () => {
  const glue = fs.readFileSync(GLUE);
  const noHead = glue.subarray(Buffer.byteLength(HEAD));
  const { binding } = loadShippedBinding({ read: withGlue(noHead) });
  assert.throws(() => new binding.Device(0x004d, id()), /InsufficientRandomness|crypto|getRandomValues/i);
  const { binding: ok } = loadShippedBinding();
  assert.ok(new ok.Device(0x004d, id()).key_package().length > 0);
});
