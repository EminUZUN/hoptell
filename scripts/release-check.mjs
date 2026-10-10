#!/usr/bin/env node
// The release check of the release gate (design 3.5, "Tests"), for the publishing workflow. A
// package whose lib/mls/openmls.js declares no reviewed binding digests (REVIEWED_BINDING null, as
// today) keeps the experimental label whatever it loads, and passes. A package that declares them
// claims a reviewed build and is refused unless the packed contents equal the recorded
// runtime-artifact manifest (every file), the reviewed build mapping ties its glue and WASM to the
// recorded reviewed-input manifest (JavaScript by identity), the reviewed-input manifest
// regenerated at this commit equals the recorded one, and the declared digests are the mapping's.
//
// The release workflow (.github/workflows/release.yml) does not call it yet. The step, before
// "Stage the npm release", once the binding's sources are reachable from the release checkout:
//
//   - name: Release gate (design 3.5)
//     run: |
//       tmp="$(mktemp -d)"
//       npm pack --pack-destination "$tmp"
//       tar xzf "$tmp"/hoptell-*.tgz -C "$tmp"
//       node scripts/release-check.mjs --package "$tmp/package"
//
//   node scripts/release-check.mjs --package DIR [--binding-root DIR]
import path from "node:path";
import { BINDING_ROOT_DEFAULT, opt, releaseCheck } from "./gate-lib.mjs";

const argv = process.argv.slice(2);
const pkgDir = opt(argv, "--package");
if (!pkgDir) {
  console.error("usage: node scripts/release-check.mjs --package <unpacked package dir> [--binding-root DIR]");
  process.exit(2);
}
try {
  const bindingRoot = path.resolve(opt(argv, "--binding-root", process.env.HOPTELL_BINDING_ROOT || BINDING_ROOT_DEFAULT));
  const r = releaseCheck({ pkgDir: path.resolve(pkgDir), bindingRoot });
  if (!r.reviewedBuild) {
    console.log("release gate: not a reviewed build (no reviewed binding digests); encrypted messaging stays labeled experimental, unreviewed");
  } else if (r.problems.length) {
    console.error(`release gate: the package claims a reviewed build and is refused:\n  ${r.problems.join("\n  ")}`);
    process.exit(1);
  } else {
    console.log("release gate: reviewed build; the package, the build mapping and the reviewed inputs agree");
  }
} catch (e) {
  console.error(`release gate: ${e.message}`);
  process.exit(1);
}
