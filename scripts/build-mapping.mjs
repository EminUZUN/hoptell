#!/usr/bin/env node
// The reviewed build mapping of the release gate (design 3.5, "Shipped artifacts"), written by the
// CI build of the binding from the reviewed inputs (and confirmed by a second, byte-identical
// build): the recorded reviewed-input manifest's digest, the toolchain, and the digests of the glue
// and the WASM it produced, as placed in lib/mls/binding/.
//
//   node scripts/build-mapping.mjs --glue FILE --wasm FILE --rust 1.99.0 --wasm-bindgen 0.2.129 \
//     [--inputs release-gate/reviewed-inputs.json] [--out release-gate/build-mapping.json]
import fs from "node:fs";
import path from "node:path";
import { RECORDS, buildMapping, canonical, opt } from "./gate-lib.mjs";

const argv = process.argv.slice(2);
const need = (name) => opt(argv, name) ?? (console.error(`build mapping: ${name} is required`), process.exit(2));
try {
  const mapping = buildMapping({
    inputsBytes: fs.readFileSync(path.resolve(opt(argv, "--inputs", RECORDS.inputs))),
    glue: fs.readFileSync(path.resolve(need("--glue"))),
    wasm: fs.readFileSync(path.resolve(need("--wasm"))),
    rust: need("--rust"),
    wasmBindgen: need("--wasm-bindgen"),
  });
  const out = path.resolve(opt(argv, "--out", RECORDS.mapping));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, canonical(mapping));
  console.log(`build mapping written to ${out}`);
} catch (e) {
  console.error(`build mapping: ${e.message}`);
  process.exit(1);
}
