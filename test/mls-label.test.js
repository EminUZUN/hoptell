// The release gate's load-time label rule (design 3.5, "After the gate"): only the binding bundle
// shipped in lib/mls/binding/, loaded from the very bytes whose digests match the reviewed
// constants, drops the "experimental, unreviewed" label; every external override keeps it. The
// bundles here are fixtures (a small CommonJS glue in initSync form and a hand-assembled WASM).
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { E2EE_LABEL, driverLabel, loadDriver } from "../lib/mls/driver.js";
import { BINDING_DIR, BINDING_FILES, REVIEWED_BINDING, checkGlueSource, loadShippedBinding, reviewedDigestsDeclared, shippedBindingStatus } from "../lib/mls/openmls.js";
import { doctor } from "../lib/doctor.js";
import { describeE2ee, describeFanout } from "../lib/mls/session.js";
import { tmpDir } from "./mls-helpers.js";

const FAKE_DRIVER = path.resolve("test/fake-mls-driver.js");
const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");

/** A valid WASM module exporting v() -> n (type, function, export and code sections). */
const wasmOf = (n) => Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x05, 0x01, 0x60, 0x00, 0x01, 0x7f, 0x03, 0x02, 0x01, 0x00, 0x07, 0x05, 0x01, 0x01, 0x76, 0x00, 0x00, 0x0a, 0x06, 0x01, 0x04, 0x00, 0x41, n, 0x0b]);
/** A glue in initSync form that names itself (marker) and offers what the driver calls at creation. */
const glueOf = (marker, extra = "") =>
  Buffer.from(`let inst;
exports.initSync = ({ module }) => { inst = new WebAssembly.Instance(module, {}); };
exports.marker = () => ${JSON.stringify(marker)};
exports.v = () => inst.exports.v();
exports.supported_suites = () => [0x4d];
${extra}
`);

function bundle(t, { glue = glueOf("A"), wasm = wasmOf(1) } = {}) {
  const dir = path.join(tmpDir(t), "binding");
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, BINDING_FILES.glue), glue);
  fs.writeFileSync(path.join(dir, BINDING_FILES.wasm), wasm);
  return dir;
}
const REVIEWED = { glue: sha256(glueOf("A")), wasm: sha256(wasmOf(1)) };

test("today: no reviewed digests, so the label always stays; the shipped bundle (A11) is never loaded without an owner-given path", async () => {
  assert.deepEqual({ ...REVIEWED_BINDING }, { glue: null, wasm: null });
  assert.ok(Object.isFrozen(REVIEWED_BINDING));
  assert.equal(fs.existsSync(BINDING_DIR), true, "the package ships the binding bundle before the gate (amendment A11), unreviewed");
  await assert.rejects(loadDriver({}), /no MLS library is configured/);
});

test("the shipped bundle with matching glue and WASM drops the label, instantiated from the verified bytes", async (t) => {
  const dir = bundle(t);
  const r = loadShippedBinding({ dir, reviewed: REVIEWED });
  assert.equal(r.reviewed, true);
  assert.deepEqual(r.digests, REVIEWED);
  assert.equal(r.binding.marker(), "A");
  assert.equal(r.binding.v(), 1);
  const d = await loadDriver({}, { shipped: { dir, reviewed: REVIEWED } });
  assert.equal(driverLabel(d), null);
  assert.equal(shippedBindingStatus({ dir, reviewed: REVIEWED }).reviewed, true);
});

test("before the gate (null constants) a bundle directory is never loaded: no driver without an owner-given path", async (t) => {
  const dir = bundle(t);
  assert.equal(reviewedDigestsDeclared(), false, "today's constants");
  for (const reviewed of [undefined, REVIEWED_BINDING, { glue: null, wasm: null }, { glue: REVIEWED.glue, wasm: null }, { glue: "x", wasm: "y" }]) {
    await assert.rejects(loadDriver({}, { shipped: { dir, reviewed } }), /no MLS library is configured/);
  }
  // The owner-given path still loads, labeled.
  assert.equal(driverLabel(await loadDriver({ HOPTELL_MLS_WASM: path.join(dir, BINDING_FILES.glue) }, { shipped: { dir } })), E2EE_LABEL);
});

test("a changed WASM with unchanged glue keeps the label", async (t) => {
  const dir = bundle(t, { wasm: wasmOf(2) });
  assert.equal(loadShippedBinding({ dir, reviewed: REVIEWED }).reviewed, false);
  assert.equal(driverLabel(await loadDriver({}, { shipped: { dir, reviewed: REVIEWED } })), E2EE_LABEL);
  assert.equal(shippedBindingStatus({ dir, reviewed: REVIEWED }).reviewed, false);
});

test("a changed glue with unchanged WASM keeps the label", async (t) => {
  const dir = bundle(t, { glue: glueOf("B") });
  const r = loadShippedBinding({ dir, reviewed: REVIEWED });
  assert.equal(r.reviewed, false);
  assert.equal(r.digests.wasm, REVIEWED.wasm, "the WASM alone matching is not enough");
  assert.equal(driverLabel(await loadDriver({}, { shipped: { dir, reviewed: REVIEWED } })), E2EE_LABEL);
});

test("files replaced between hashing and instantiation have no effect: each file is read once and the hashed bytes run", (t) => {
  const swapAfterReads = (dir) => {
    const reads = [];
    const read = (file) => {
      const b = fs.readFileSync(file);
      reads.push(path.basename(file));
      if (reads.length === 2) {
        fs.writeFileSync(path.join(dir, BINDING_FILES.glue), glueOf("B"));
        fs.writeFileSync(path.join(dir, BINDING_FILES.wasm), wasmOf(2));
      }
      return b;
    };
    return { reads, read };
  };
  // Reviewed bytes hashed, other bytes on disk by load time: still the reviewed bytes run.
  let dir = bundle(t);
  let s = swapAfterReads(dir);
  let r = loadShippedBinding({ dir, reviewed: REVIEWED, read: s.read });
  assert.deepEqual(s.reads.sort(), [BINDING_FILES.glue, BINDING_FILES.wasm].sort());
  assert.equal(r.reviewed, true);
  assert.equal(r.binding.marker(), "A");
  assert.equal(r.binding.v(), 1);
  // Other bytes hashed, the reviewed ones on disk by load time: the label stays, and the hashed
  // (unreviewed) bytes are what runs, never the files read again.
  dir = bundle(t, { glue: glueOf("B"), wasm: wasmOf(2) });
  s = swapAfterReads(dir);
  const read = (file) => {
    const b = s.read(file);
    if (s.reads.length === 2) {
      fs.writeFileSync(path.join(dir, BINDING_FILES.glue), glueOf("A"));
      fs.writeFileSync(path.join(dir, BINDING_FILES.wasm), wasmOf(1));
    }
    return b;
  };
  r = loadShippedBinding({ dir, reviewed: REVIEWED, read });
  assert.equal(r.reviewed, false);
  assert.equal(r.binding.marker(), "B");
  assert.equal(r.binding.v(), 2);
});

test("HOPTELL_MLS_WASM at a byte-identical copy of the reviewed bundle keeps the label", async (t) => {
  const shipped = bundle(t);
  const copy = bundle(t);
  for (const f of Object.values(BINDING_FILES)) assert.ok(fs.readFileSync(path.join(copy, f)).equals(fs.readFileSync(path.join(shipped, f))));
  const d = await loadDriver({ HOPTELL_MLS_WASM: path.join(copy, BINDING_FILES.glue) }, { shipped: { dir: shipped, reviewed: REVIEWED } });
  assert.equal(driverLabel(d), E2EE_LABEL);
  // Even the shipped directory itself, named as an override, is an override.
  const same = await loadDriver({ HOPTELL_MLS_WASM: path.join(shipped, BINDING_FILES.glue) }, { shipped: { dir: shipped, reviewed: REVIEWED } });
  assert.equal(driverLabel(same), E2EE_LABEL);
});

test("an arbitrary HOPTELL_MLS_DRIVER keeps the label, even one handing back the reviewed driver object", async (t) => {
  const shipped = bundle(t);
  assert.equal(driverLabel(await loadDriver({ HOPTELL_MLS_DRIVER: FAKE_DRIVER }, { shipped: { dir: shipped, reviewed: REVIEWED } })), E2EE_LABEL);
  const reviewed = await loadDriver({}, { shipped: { dir: shipped, reviewed: REVIEWED } });
  assert.equal(driverLabel(reviewed), null);
  const mod = path.join(tmpDir(t), "handback.mjs");
  fs.writeFileSync(mod, "export const driver = globalThis.__hoptellReviewedDriver;\n");
  globalThis.__hoptellReviewedDriver = reviewed;
  t.after(() => delete globalThis.__hoptellReviewedDriver);
  const d = await loadDriver({ HOPTELL_MLS_DRIVER: mod }, { shipped: { dir: shipped, reviewed: REVIEWED } });
  assert.equal(d, reviewed);
  assert.equal(driverLabel(d), E2EE_LABEL);
  // A driver that claims a status of its own is not believed either.
  assert.equal(driverLabel({ ...reviewed, reviewed: true, label: null }), E2EE_LABEL);
});

test("the advisory glue lint flags a glue that names a file API or a module off the fixed list, and such a glue is not loaded", (t) => {
  const reads = glueOf("A", 'exports.x = require("fs").readFileSync(__dirname + "/openmls_wasm_bg.wasm");');
  assert.deepEqual(checkGlueSource(reads), ["uses readFileSync", "uses __dirname", 'requires "fs"']);
  assert.throws(() => loadShippedBinding({ dir: bundle(t, { glue: reads }), reviewed: { glue: sha256(reads), wasm: REVIEWED.wasm } }), /the glue lint flags that it uses readFileSync/);
  assert.deepEqual(checkGlueSource(glueOf("A", "const n = 'fs'; exports.y = () => require(n);")), ["requires n"]);
  assert.deepEqual(checkGlueSource(Buffer.from('exports.x = require("node:crypto");')), ["has no initSync"]);
  assert.deepEqual(checkGlueSource(glueOf("A", 'const c = require("node:crypto");')), []);
  // A module reached past the static check (through module.require) is refused at run time.
  const indirect = glueOf("A", 'const r = module.require; exports.initSync = () => r("fs");');
  assert.throws(() => loadShippedBinding({ dir: bundle(t, { glue: indirect }), reviewed: REVIEWED }), /may not load fs/);
});

test("encrypted send results carry the label", () => {
  assert.match(describeE2ee("bob", { state: "accepted", message_id: "m1" }), /^Relay accepted the message for bob, encrypted \(experimental, unreviewed\)\. Message reference: m1\./);
  assert.match(describeE2ee("bob", { state: "held", reason: "a removal is pending", message_id: "m2" }), /encrypted \(experimental, unreviewed\)/);
  assert.match(describeE2ee("bob", { state: "sealed", message_id: "m3" }), /encrypted \(experimental, unreviewed\)/);
  assert.match(describeE2ee("bob", { state: "accepted", message_id: "m4" }, null), /end-to-end encrypted/);
  const fan = { states: { accepted: 2, pending: 0, held: 0, unavailable: 0, refused: 0, expired: 0 }, copies: 2, candidates: 2, excluded: { first_contact: 0, not_encrypted: 0, unavailable: 0 } };
  assert.match(describeFanout("@reviewer", fan), /^Broadcast to @reviewer, encrypted \(experimental, unreviewed\): relay accepted 2 of 2 copies/);
  assert.match(describeFanout("@reviewer", fan, null), /^Broadcast to @reviewer, end-to-end encrypted:/);
});

// Not a security boundary (Node's vm is not a sandbox): the review of the glue at its pinned digest
// is the guarantee. The fresh context only makes an accidental reach for the host fail loudly.
test("defence in depth, not a sandbox: a glue that passes the lint but reaches for process at evaluation fails there", (t) => {
  const codex = Buffer.from('exports.initSync=()=>globalThis["process"]["getBuiltinModule"]("fs")["read"+"FileSync"]("/etc/hosts");\n');
  assert.deepEqual(checkGlueSource(codex), [], "the text lint does not see it (it is advisory)");
  assert.throws(() => loadShippedBinding({ dir: bundle(t, { glue: codex }), reviewed: { glue: sha256(codex), wasm: REVIEWED.wasm } }), (e) => e.name === "TypeError" && /getBuiltinModule/.test(e.message), "a TypeError of the glue's own context");
  for (const reach of ["typeof process", "typeof Buffer", "typeof setTimeout", "typeof globalThis.require"]) {
    const glue = glueOf("A", `exports.reach = () => ${reach};`);
    assert.equal(loadShippedBinding({ dir: bundle(t, { glue }), reviewed: REVIEWED }).binding.reach(), "undefined", reach);
  }
});

test("doctor follows the label rule: reviewed only for a matching shipped binding with no override", async (t) => {
  const home = tmpDir(t);
  const run = async (extra, binding) => {
    const out = [];
    await doctor({ HOPTELL_HOME: home, HOPTELL_EXPERIMENTAL_E2EE: "1", ...extra }, (l) => out.push(l), { homedir: home, binding });
    return out.filter((l) => l.includes("encrypted messaging:")).join("\n");
  };
  const EXPERIMENTAL = /encrypted messaging: experimental, not independently reviewed/;
  const REVIEWED_LINE = /encrypted messaging: reviewed build: the shipped binding matches the reviewed digests/;
  const dir = bundle(t);
  let text = await run({}, { dir, reviewed: REVIEWED });
  assert.match(text, REVIEWED_LINE);
  assert.doesNotMatch(text, EXPERIMENTAL);
  assert.match(text, /ok +encrypted messaging: shipped binding .* matches the reviewed digests/);
  // An override keeps the label, even beside a matching shipped binding.
  for (const extra of [{ HOPTELL_MLS_WASM: path.join(dir, BINDING_FILES.glue) }, { HOPTELL_MLS_DRIVER: FAKE_DRIVER }]) {
    text = await run(extra, { dir, reviewed: REVIEWED });
    assert.match(text, EXPERIMENTAL);
    assert.doesNotMatch(text, REVIEWED_LINE);
    assert.match(text, /an override .* is used instead, labeled experimental/);
  }
  // A changed glue, today's null digests, or no bundle: experimental.
  text = await run({}, { dir: bundle(t, { glue: glueOf("B") }), reviewed: REVIEWED });
  assert.match(text, EXPERIMENTAL);
  assert.match(text, /warn +encrypted messaging: shipped binding .* does not match reviewed digests/);
  text = await run({}, { dir });
  assert.match(text, EXPERIMENTAL);
  assert.match(text, /which this build does not load by default \(no reviewed digests\)\. To try it, labeled experimental, set HOPTELL_MLS_WASM=/);
  assert.match(await run({}, { dir: path.join(home, "none"), reviewed: REVIEWED }), EXPERIMENTAL);
  assert.match(await run({}, undefined), EXPERIMENTAL);
  // Without the flag, nothing about encrypted messaging.
  const out = [];
  await doctor({ HOPTELL_HOME: home }, (l) => out.push(l), { homedir: home, binding: { dir, reviewed: REVIEWED } });
  assert.ok(!out.some((l) => l.includes("encrypted messaging")));
});
