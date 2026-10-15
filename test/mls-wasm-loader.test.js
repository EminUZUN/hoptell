// HOPTELL_MLS_WASM (lib/mls/openmls.js loadBindingFrom): the owner can point it at the bundle
// shipped in lib/mls/binding/ (an initSync glue inside this "type": "module" package), at its
// folder, or at a Node.js build; every refusal says why. An override is always labeled experimental.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { E2EE_LABEL, driverLabel, loadDriver } from "../lib/mls/driver.js";
import { BINDING_DIR, BINDING_FILES } from "../lib/mls/openmls.js";

const shipped = fs.existsSync(path.join(BINDING_DIR, BINDING_FILES.glue)) && fs.existsSync(path.join(BINDING_DIR, BINDING_FILES.wasm));
const tmp = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hoptell-wasm-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test("the shipped bundle loads through HOPTELL_MLS_WASM (file or folder), labeled experimental", { skip: shipped ? false : "no shipped binding in lib/mls/binding" }, async () => {
  for (const p of [path.join(BINDING_DIR, BINDING_FILES.glue), BINDING_DIR]) {
    const d = await loadDriver({ HOPTELL_MLS_WASM: p });
    assert.equal(d.suite, 0x004d);
    assert.equal(driverLabel(d), E2EE_LABEL);
    const dev = await d.createDevice(Buffer.from("loader-test"));
    assert.equal(Buffer.from(dev.signaturePublicKey()).length, 32);
  }
});

test("HOPTELL_MLS_WASM refusals say why and which formats it takes", async (t) => {
  const dir = tmp(t);
  const why = async (p, re) => {
    await assert.rejects(loadDriver({ HOPTELL_MLS_WASM: p }), (e) => {
      assert.match(e.message, /could not be loaded from .* \(HOPTELL_MLS_WASM\): /);
      assert.match(e.message, re);
      assert.match(e.message, /--target nodejs/);
      return true;
    });
  };
  await why("relative/openmls_wasm.js", /not an absolute path/);
  await why(path.join(dir, "missing.js"), /no such file/);
  fs.writeFileSync(path.join(dir, "esm.js"), "export const x = 1;\n");
  await why(path.join(dir, "esm.js"), /it is an ES module/);
  fs.writeFileSync(path.join(dir, "other.js"), "module.exports = { hello: 1 };\n");
  await why(path.join(dir, "other.js"), /does not export the OpenMLS binding/);
  fs.writeFileSync(path.join(dir, "broken.js"), "throw new Error('boom');\n");
  await why(path.join(dir, "broken.js"), /evaluating it failed \(boom\)/);
  // An initSync glue without its WASM file next to it.
  fs.writeFileSync(path.join(dir, "glue.js"), "module.exports = { initSync() {}, supported_suites() { return []; } };\n");
  await why(path.join(dir, "glue.js"), /needs glue_bg\.wasm next to it, which is missing/);
  if (shipped) {
    const copy = path.join(dir, "copy");
    fs.mkdirSync(copy);
    fs.copyFileSync(path.join(BINDING_DIR, BINDING_FILES.glue), path.join(copy, BINDING_FILES.glue));
    await why(copy, /needs openmls_wasm_bg\.wasm next to it, which is missing/);
  }
});
