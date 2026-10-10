#!/usr/bin/env node
// The reviewed-input (provenance) manifest of the release gate (design 3.5, "Scope"): every file
// of the three groups (library lock and vendored provider, WASM binding, hoptell's encrypted path)
// with its SHA-256; a vendored crate (a path entry in the lock, no registry checksum) is recorded
// with the crates.io checksum vendor/PATCHES.md gives and a digest of its vendored tree,
// from the fixed lists in scripts/gate-lib.mjs. Fails if a listed path is missing. Group 3 includes
// lib/decisions.js (owner decisions reaching the pins) but not lib/ownerui.js; 4.3's
// lib/mls/fanout.js is covered by the lib/mls/** glob once 4.3 merges. Group 3 also lists the
// static import closure of its entry points; a module of that closure that is neither listed nor
// excluded with a reason (CLOSURE_EXCLUDED), or a non-literal load not named in DYNAMIC_LOADS,
// fails the generator.
//
//   node scripts/reviewed-manifest.mjs [--binding-root DIR] [--out FILE]   write it (canonical JSON)
//   node scripts/reviewed-manifest.mjs --check [--binding-root DIR] [--out FILE]
//                                                         compare the committed one with the tree
//   node scripts/reviewed-manifest.mjs --print                              write it to stdout
//   --repo DIR                                            another checkout (default: this one)
//
// The binding root defaults to the bake-off's openmls-wasm in the sibling worktree
// (HOPTELL_BINDING_ROOT overrides). The manifest goes to release-gate/reviewed-inputs.json, which is
// committed at the commit to be reviewed (entry criterion 5), not before.
import fs from "node:fs";
import path from "node:path";
import { BINDING_ROOT_DEFAULT, RECORDS, REPO, canonical, opt, reviewedInputs } from "./gate-lib.mjs";

const argv = process.argv.slice(2);
const bindingRoot = path.resolve(opt(argv, "--binding-root", process.env.HOPTELL_BINDING_ROOT || BINDING_ROOT_DEFAULT));
const repo = path.resolve(opt(argv, "--repo", REPO));
const out = path.resolve(opt(argv, "--out", path.join(repo, path.relative(REPO, RECORDS.inputs))));
try {
  const text = canonical(reviewedInputs({ repo, bindingRoot }));
  if (argv.includes("--print")) process.stdout.write(text);
  else if (argv.includes("--check")) {
    let recorded;
    try {
      recorded = fs.readFileSync(out, "utf8");
    } catch (e) {
      throw new Error(`no recorded manifest at ${out} (${e.code})`);
    }
    if (recorded !== text) {
      const a = JSON.parse(recorded);
      const b = JSON.parse(text);
      const flat = (m) => Object.assign({}, ...["library", "binding", "hoptell"].map((g) => m[g]?.files ?? {}));
      const [fa, fb] = [flat(a), flat(b)];
      const changed = [...new Set([...Object.keys(fa), ...Object.keys(fb)])].sort().filter((k) => fa[k] !== fb[k]);
      console.error(`reviewed-input manifest: ${out} does not match the tree${changed.length ? `:\n  ${changed.join("\n  ")}` : " (format or crate entries)"}`);
      process.exit(1);
    }
    console.log(`reviewed-input manifest: ${out} matches the tree`);
  } else {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, text);
    console.log(`reviewed-input manifest written to ${out}`);
  }
} catch (e) {
  console.error(`reviewed-input manifest: ${e.message}`);
  process.exit(1);
}
