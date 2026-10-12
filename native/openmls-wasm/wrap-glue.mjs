#!/usr/bin/env node
// The deterministic glue wrapper of the shipped binding bundle (amendment A11). wasm-bindgen's
// `--target no-modules` output is a plain script that defines `wasm_bindgen` (with `initSync`),
// with no module system and no file access. hoptell's loader (lib/mls/openmls.js
// loadShippedBinding) evaluates the glue as CommonJS in a fresh context whose globals are only
// WebAssembly, TextEncoder and TextDecoder, with a `require` limited to node:crypto. This wrapper
// turns the one into the other and does nothing else: it prepends HEAD and appends TAIL, each one
// fixed line. HEAD gives the fresh context the Web Crypto object the binding's randomness reads
// (`globalThis.crypto.getRandomValues`), only where none exists; TAIL exports `wasm_bindgen`.
// Same input, same output: no time, path or environment goes in.
//
//   node wrap-glue.mjs <no-modules glue> <wrapped glue>
import fs from "node:fs";
import { fileURLToPath } from "node:url";

export const HEAD = 'if (typeof globalThis.crypto === "undefined") globalThis.crypto = require("node:crypto").webcrypto;\n';
export const TAIL = "module.exports = wasm_bindgen;\n";

/** The wrapped glue of a `--target no-modules` glue (a Buffer); refuses any other form. */
export function wrapGlue(source) {
  const src = Buffer.from(source);
  const text = src.toString("utf8");
  if (!/^let wasm_bindgen = \(function\(exports\) \{\n/.test(text)) throw new Error("not wasm-bindgen --target no-modules output (it starts with `let wasm_bindgen = (function(exports) {`)");
  if (!/\binitSync\b/.test(text)) throw new Error("the glue has no initSync");
  if (!text.endsWith("\n")) throw new Error("the glue does not end with a line break");
  return Buffer.concat([Buffer.from(HEAD), src, Buffer.from(TAIL)]);
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) {
    console.error("usage: node wrap-glue.mjs <no-modules glue> <wrapped glue>");
    process.exit(2);
  }
  try {
    fs.writeFileSync(output, wrapGlue(fs.readFileSync(input)));
  } catch (e) {
    console.error(`wrap-glue: ${e.message}`);
    process.exit(1);
  }
}
