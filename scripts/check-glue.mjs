#!/usr/bin/env node
// An advisory lint of the shipped binding glue (design 3.5, "After the gate"): the glue placed in
// lib/mls/binding/ should take the compiled WASM module as an argument (initSync), name no file
// API, and load only the built-ins on lib/mls/openmls.js GLUE_BUILTINS. It is a text check that
// catches mistakes early; it does not enforce the contract against a glue written to evade it.
// The guarantee is the reviewed glue's pinned digest (REVIEWED_BINDING) plus the reviewer's source
// review. The client runs the same lint before it evaluates the glue, in a fresh context (also
// not a sandbox).
//
//   node scripts/check-glue.mjs [lib/mls/binding/openmls_wasm.js]
import fs from "node:fs";
import path from "node:path";
import { BINDING_FILES, checkGlueSource } from "../lib/mls/openmls.js";
import { BUNDLE_DIR, REPO } from "./gate-lib.mjs";

const file = path.resolve(process.argv[2] ?? path.join(REPO, BUNDLE_DIR, BINDING_FILES.glue));
let src;
try {
  src = fs.readFileSync(file);
} catch (e) {
  console.error(`glue lint (advisory): cannot open ${file}: ${e.code ?? e.message}`);
  process.exit(2);
}
const problems = checkGlueSource(src);
if (problems.length) {
  console.error(`glue lint (advisory): ${file} is flagged: it ${problems.join(", ")} (the reviewed digest and source review are the guarantee, not this lint)`);
  process.exit(1);
}
console.log(`glue lint (advisory): ${file} has no finding (the reviewed digest and source review are the guarantee, not this lint)`);
