#!/usr/bin/env node
// The reviewed build mapping of the release gate (design 3.5, "Shipped artifacts"; amendment A11,
// format hoptell-build-mapping-2), written after two clean builds of the binding in fresh
// containers from one final build image (native/openmls-wasm/build-image.sh): the recorded
// reviewed-input manifest's digest, the image id, the Dockerfile's digest and the images it pins by
// digest, the toolchain, the Cargo.lock digest, the outputs, and both builds' attestations (each
// build's attestation.json). It refuses builds that disagree, name another image, or did not
// produce the bundle in lib/mls/binding/.
//
//   node scripts/build-mapping.mjs --image-id sha256:<id> --attestation DIR1/attestation.json \
//     --attestation DIR2/attestation.json [--glue FILE] [--wasm FILE] [--binding-root DIR] \
//     [--inputs release-gate/reviewed-inputs.json] [--out release-gate/build-mapping.json]
import fs from "node:fs";
import path from "node:path";
import { BINDING_ROOT_DEFAULT, GLUE_KEY, RECORDS, REPO, WASM_KEY, buildMapping, canonical, opt } from "./gate-lib.mjs";

const argv = process.argv.slice(2);
const need = (name) => opt(argv, name) ?? (console.error(`build mapping: ${name} is required`), process.exit(2));
const all = (name) => argv.flatMap((a, i) => (a === name && i + 1 < argv.length ? [argv[i + 1]] : []));
try {
  const root = path.resolve(opt(argv, "--binding-root", process.env.HOPTELL_BINDING_ROOT || BINDING_ROOT_DEFAULT));
  const attestations = all("--attestation").map((f) => {
    const a = JSON.parse(fs.readFileSync(path.resolve(f), "utf8"));
    if (a.format !== "hoptell-build-attestation-1") throw new Error(`${f}: not a build attestation (format ${a.format})`);
    return a;
  });
  const mapping = buildMapping({
    inputsBytes: fs.readFileSync(path.resolve(opt(argv, "--inputs", RECORDS.inputs))),
    dockerfile: fs.readFileSync(path.join(root, "Dockerfile")),
    cargoLock: fs.readFileSync(path.join(root, "Cargo.lock")),
    toolchainToml: fs.readFileSync(path.join(root, "rust-toolchain.toml")),
    imageId: need("--image-id"),
    glue: fs.readFileSync(path.resolve(opt(argv, "--glue", path.join(REPO, GLUE_KEY)))),
    wasm: fs.readFileSync(path.resolve(opt(argv, "--wasm", path.join(REPO, WASM_KEY)))),
    attestations,
  });
  const out = path.resolve(opt(argv, "--out", RECORDS.mapping));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, canonical(mapping));
  console.log(`build mapping written to ${out}`);
} catch (e) {
  console.error(`build mapping: ${e.message}`);
  process.exit(1);
}
