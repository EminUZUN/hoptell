#!/usr/bin/env node
// The runtime-artifact manifest of the release gate (design 3.5, "Shipped artifacts"): every file
// the npm package carries on the encrypted path (group-3 JavaScript as shipped, package.json, and
// the binding bundle in lib/mls/binding/), with its SHA-256, computed on an unpacked package:
//
//   npm pack --pack-destination "$tmp" && tar xzf "$tmp"/hoptell-*.tgz -C "$tmp"
//   node scripts/runtime-manifest.mjs "$tmp/package" [--out FILE]      write it
//   node scripts/runtime-manifest.mjs "$tmp/package" --check [--out FILE]  compare with the record
//
// The record is release-gate/runtime-artifacts.json, committed with the reviewed-input manifest.
import fs from "node:fs";
import path from "node:path";
import { RECORDS, canonical, opt, runtimeArtifacts } from "./gate-lib.mjs";

const argv = process.argv.slice(2);
const pkgDir = argv.find((a, i) => !a.startsWith("--") && argv[i - 1] !== "--out");
if (!pkgDir) {
  console.error("usage: node scripts/runtime-manifest.mjs <unpacked package dir> [--check] [--out FILE]");
  process.exit(2);
}
const out = path.resolve(opt(argv, "--out", RECORDS.runtime));
try {
  const text = canonical(runtimeArtifacts(path.resolve(pkgDir)));
  if (argv.includes("--check")) {
    if (!fs.existsSync(out) || fs.readFileSync(out, "utf8") !== text) {
      console.error(`runtime-artifact manifest: the package does not match ${out}`);
      process.exit(1);
    }
    console.log(`runtime-artifact manifest: the package matches ${out}`);
  } else {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, text);
    console.log(`runtime-artifact manifest written to ${out}`);
  }
} catch (e) {
  console.error(`runtime-artifact manifest: ${e.message}`);
  process.exit(1);
}
