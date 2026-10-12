#!/usr/bin/env node
// The release check of the release gate (design 3.5, "Tests"), for the publishing workflow. A
// package whose lib/mls/openmls.js declares no reviewed binding digests (REVIEWED_BINDING null, as
// today) keeps the experimental label whatever it loads, and passes. A package that declares them
// claims a reviewed build and is refused unless the packed contents equal the recorded
// runtime-artifact manifest (every file), the reviewed build mapping verifies (both build
// attestations, the image, the Dockerfile, Cargo.lock and toolchain) and ties its glue and WASM to
// the recorded reviewed-input manifest (JavaScript by identity), the reviewed-input manifest
// regenerated at this commit equals the recorded one, and the declared digests are the mapping's.
//
// --records (amendment A11) is the strict check of the committed records, whatever REVIEWED_BINDING
// says: the same three conditions, without the release label. It is what shows, before the external
// review, that the committed records describe this package; the ordinary check keeps the label
// closed until the review's digests are declared in the code. Without --package it packs this
// repository (npm pack) into a temporary directory and checks that.
//
// The release workflow (.github/workflows/release.yml) runs it on the packed package in the step
// "Release gate (design 3.5)", before "Stage the npm release".
//
//   node scripts/release-check.mjs --package DIR [--binding-root DIR]
//   node scripts/release-check.mjs --records [--package DIR] [--repo DIR] [--records-dir DIR] [--binding-root DIR]
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BINDING_PREFIX, RECORDS, REPO, opt, recordsCheck, releaseCheck } from "./gate-lib.mjs";

const argv = process.argv.slice(2);
const strict = argv.includes("--records");
let pkgDir = opt(argv, "--package");
if (!pkgDir && !strict) {
  console.error("usage: node scripts/release-check.mjs --package <unpacked package dir> [--binding-root DIR]\n       node scripts/release-check.mjs --records [--package DIR] [--repo DIR] [--records-dir DIR] [--binding-root DIR]");
  process.exit(2);
}
const repo = path.resolve(opt(argv, "--repo", REPO));
const recordsDir = opt(argv, "--records-dir");
const records = recordsDir ? Object.fromEntries(Object.entries(RECORDS).map(([k, f]) => [k, path.join(path.resolve(recordsDir), path.basename(f))])) : Object.fromEntries(Object.entries(RECORDS).map(([k, f]) => [k, path.join(repo, path.relative(REPO, f))]));
const bindingRoot = path.resolve(opt(argv, "--binding-root", process.env.HOPTELL_BINDING_ROOT || path.join(repo, "native", BINDING_PREFIX)));
let tmp = null;
try {
  if (!pkgDir) {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hoptell-release-check-"));
    const [{ filename }] = JSON.parse(execFileSync("npm", ["pack", "--json", "--pack-destination", tmp], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
    execFileSync("tar", ["xzf", path.join(tmp, filename), "-C", tmp]);
    pkgDir = path.join(tmp, "package");
    console.log(`release gate: packed ${filename}`);
  }
  pkgDir = path.resolve(pkgDir);
  if (strict) {
    const { problems } = recordsCheck({ pkgDir, repo, bindingRoot, records });
    if (problems.length) {
      console.error(`release gate --records: the committed records do not describe this package:\n  ${problems.join("\n  ")}`);
      process.exitCode = 1;
    } else {
      console.log("release gate --records: the package equals the recorded runtime artifacts, the build mapping and both build attestations verify, and the reviewed inputs regenerated now equal the recorded ones (the release label is a separate check: REVIEWED_BINDING)");
    }
  } else {
    const r = releaseCheck({ pkgDir, repo, bindingRoot, records });
    if (!r.reviewedBuild) {
      console.log("release gate: not a reviewed build (no reviewed binding digests); encrypted messaging stays labeled experimental, unreviewed");
    } else if (r.problems.length) {
      console.error(`release gate: the package claims a reviewed build and is refused:\n  ${r.problems.join("\n  ")}`);
      process.exitCode = 1;
    } else {
      console.log("release gate: reviewed build; the package, the build mapping and the reviewed inputs agree");
    }
  }
} catch (e) {
  console.error(`release gate: ${e.message}`);
  process.exitCode = 1;
} finally {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
}
