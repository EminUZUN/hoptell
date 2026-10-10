// The release gate's in-repo records (design 3.5, "Scope" and "Tests"): the reviewed-input
// (provenance) manifest, the runtime-artifact manifest, the reviewed build mapping, and the
// release check over the three. Shared by the scripts next to this file; nothing here is shipped.
//
// Every record is canonical JSON (keys sorted at every level, two-space indent, one trailing
// newline) with no times, hosts or absolute paths, so the same inputs give the same bytes.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
/** Where the records are committed at the reviewed commit. */
export const RECORDS_DIR = path.join(REPO, "release-gate");
export const RECORDS = {
  inputs: path.join(RECORDS_DIR, "reviewed-inputs.json"),
  runtime: path.join(RECORDS_DIR, "runtime-artifacts.json"),
  mapping: path.join(RECORDS_DIR, "build-mapping.json"),
};
/**
 * The binding's source tree (groups 1 and 2). It lives in the bake-off today, in the sibling
 * worktree; HOPTELL_BINDING_ROOT or --binding-root names another place (for instance once it
 * moves into this repository). Its files are recorded as "openmls-wasm/<path>", never by where
 * they were found.
 */
export const BINDING_ROOT_DEFAULT = path.join(REPO, "..", "mls-bakeoff", "spike", "mls-bakeoff", "openmls-wasm");
export const BINDING_PREFIX = "openmls-wasm";

// The fixed lists of the design's three groups. "dir/**" is every file under dir (a new file is
// in scope automatically); any other entry is one file. A listed path that is missing fails.
export const GROUPS = {
  // 1. The library and provider: the build's complete Cargo.lock (every transitive crate, version
  //    and checksum), and the two crates' entries in it; the vendored provider (design 3.5 v3.2:
  //    the published crates with upstream's advisory fix, wired in through [patch.crates-io]) with
  //    PATCHES.md, which records the diffs and each crate's crates.io checksum. A vendored crate is
  //    a path entry in the lock (no source, no checksum): its entry records PATCHES.md's registry
  //    checksum and a digest of its vendored tree instead (vendoredCrates below).
  library: { root: "binding", paths: ["Cargo.lock", "vendor/PATCHES.md", "vendor/**"], crates: ["openmls", "openmls_libcrux_crypto"] },
  // 2. hoptell's WASM binding: Rust source, Cargo.toml, build script, toolchain pin, and the glue
  //    and WASM file it produced. (The glue is the bake-off's --target nodejs form until the
  //    initSync form the package will ship exists.)
  binding: { root: "binding", paths: ["Cargo.toml", "build.sh", "rust-toolchain.toml", "src/**", "pkg/openmls_wasm.js", "pkg/openmls_wasm_bg.wasm"] },
  // 3. hoptell's own layer: every file on the encrypted path. The entry points are the design's
  //    list; migrations are in lib/relaystore.js (and the lib/mls/ files it assembles);
  //    lib/decisions.js is where an owner decision reaches the pins and trust (updatePins). 4.3's
  //    encrypted fan-out (lib/mls/fanout.js) is covered by lib/mls/**. Added by the 3.5
  //    preparation (N7), because they change encrypted-path state or decide it: lib/restore.js
  //    (the relay's restore: revocations, suspensions, replace_required, operations),
  //    lib/admin.js and lib/admincli.js (reinstating suspended devices), bin/hoptell.js (turns the
  //    relay's encrypted service on, also from HOPTELL_EXPERIMENTAL_E2EE) and lib/ownerui.js (owner
  //    decisions on device pins and own devices).
  //    Then the static import closure of those entry points within the repository: every module
  //    they load, directly or not, runs in the same process and can change what they do, so it is
  //    listed (a file of the closure that is neither listed nor in CLOSURE_EXCLUDED fails the
  //    generator and test/release-gate.test.js).
  hoptell: {
    root: "repo",
    paths: [
      // entry points (design 3.5, group 3)
      "lib/mls/**",
      "lib/relaydb.js",
      "lib/relaystore.js",
      "lib/relay.js",
      "lib/client.js",
      "lib/access.js",
      "lib/decisions.js",
      "lib/engine.js",
      "lib/delivery.js",
      "lib/quarantine.js",
      "lib/store.js",
      "lib/inbox.js",
      "lib/restore.js",
      "lib/admin.js",
      "lib/admincli.js",
      "bin/hoptell.js",
      "lib/ownerui.js",
      // their import closure (with the N7 entry points, bin/hoptell.js loads most of lib/)
      "lib/adminui.js",
      "lib/apply.js",
      "lib/backup.js",
      "lib/broker.js",
      "lib/claims.js",
      "lib/composer.js",
      "lib/config.js",
      "lib/contacts.js",
      "lib/credentials.js",
      "lib/doctor.js",
      "lib/elicit.js",
      "lib/files.js",
      "lib/filetools.js",
      "lib/fingerprint.js",
      "lib/gitsafe.js",
      "lib/host.js",
      "lib/hosted.js",
      "lib/hostedcli.js",
      "lib/hostedlinks.js",
      "lib/hostedowner.js",
      "lib/hostedretention.js",
      "lib/hostedstorage.js",
      "lib/hostedtenants.js",
      "lib/httpmcp.js",
      "lib/jcs.js",
      "lib/localrelay.js",
      "lib/locks.js",
      "lib/login.js",
      "lib/loopbackui.js",
      "lib/mcp.js",
      "lib/members.js",
      "lib/metrics.js",
      "lib/notices.js",
      "lib/oidc.js",
      "lib/profiles.js",
      "lib/realm.js",
      "lib/records.js",
      "lib/relays.js",
      "lib/reviewsets.js",
      "lib/routes.js",
      "lib/session.js",
      "lib/settings.js",
      "lib/snapshot.js",
      "lib/tmux.js",
      "lib/transfercli.js",
      "lib/transferin.js",
      "lib/transferout.js",
      "lib/transfers.js",
      "lib/transfersave.js",
      "lib/transferwire.js",
      "lib/wake.js",
      // the Node dependencies loaded on this path
      "package.json",
      "package-lock.json",
    ],
  },
};
/**
 * Files of the closure deliberately left out of group 3, each with the reason (reviewed by the
 * external reviewer like the list itself). None today: the whole closure is listed.
 */
export const CLOSURE_EXCLUDED = {};
/**
 * The loads in group 3 whose specifier is not a literal, so the static closure cannot follow
 * them; each is named here with why it cannot reach an unlisted repository file. A new one fails.
 */
export const DYNAMIC_LOADS = {
  "lib/mls/driver.js": { "import(pathToFileURL(file).href)": "HOPTELL_MLS_DRIVER, an owner-given module outside the package; always labeled experimental" },
  "lib/mls/openmls.js": {
    "require(`node:${name}`)": "the shipped glue's built-ins, only names on GLUE_BUILTINS, always with the node: prefix",
    "require(wasmPath)": "HOPTELL_MLS_WASM, an owner-given binding outside the package; always labeled experimental",
  },
};

/** Group-3 files the npm package does not carry (build or install inputs only). */
const NOT_SHIPPED = new Set(["package-lock.json"]);
/** The binding bundle's place in the package (lib/mls/openmls.js BINDING_DIR). */
export const BUNDLE_DIR = "lib/mls/binding";

export const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");

const sortDeep = (v) => (Array.isArray(v) ? v.map(sortDeep) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortDeep(v[k])])) : v);
/** The canonical bytes of a record. */
export const canonical = (obj) => JSON.stringify(sortDeep(obj), null, 2) + "\n";

/** Every regular file under `dir`, as paths relative to `base` with "/" separators, sorted. Symlinks fail. */
function walk(base, dir, out = []) {
  for (const name of fs.readdirSync(path.join(base, dir)).sort()) {
    const rel = dir ? `${dir}/${name}` : name;
    const st = fs.lstatSync(path.join(base, rel));
    if (st.isSymbolicLink()) throw new Error(`${rel}: a symbolic link (the manifest records files only)`);
    if (st.isDirectory()) walk(base, rel, out);
    else if (st.isFile()) out.push(rel);
    else throw new Error(`${rel}: not a regular file`);
  }
  return out;
}

/** The files of a fixed path list under `base`, {path: sha256}; throws on the first missing entry. */
export function hashPaths(base, paths, { label = base, optional = false } = {}) {
  const files = {};
  for (const p of paths) {
    const glob = p.endsWith("/**");
    const rel = glob ? p.slice(0, -3) : p;
    const abs = path.join(base, rel);
    let st;
    try {
      st = fs.lstatSync(abs);
    } catch {
      if (optional) continue;
      throw new Error(`a listed path is missing: ${p} (under ${label})`);
    }
    if (glob) {
      if (!st.isDirectory()) throw new Error(`a listed directory is not a directory: ${p} (under ${label})`);
      for (const f of walk(base, rel)) files[f] = sha256(fs.readFileSync(path.join(base, f)));
    } else {
      if (!st.isFile()) throw new Error(`a listed file is not a regular file: ${p} (under ${label})`);
      files[rel] = sha256(fs.readFileSync(abs));
    }
  }
  return files;
}

/**
 * {name: entry} of `names` in a Cargo.lock's text; each must appear exactly once. A registry crate's
 * entry is {version, checksum} (it must have one). A crate that is a path entry (no source) must be
 * one of `vendored` (vendoredCrates), and its entry is {version, source: "path", path,
 * registryChecksum, vendoredTree}; without `vendored`, a crate without a checksum fails.
 */
export function lockedCrates(text, names, vendored = null) {
  const pkgs = parseCargoLock(text);
  const out = {};
  for (const n of names) {
    const found = pkgs.filter((p) => p.name === n);
    if (found.length !== 1) throw new Error(`Cargo.lock: ${n} appears ${found.length} times (expected once)`);
    const v = vendored && !found[0].source ? vendored[n] : null;
    if (v) {
      out[n] = { version: found[0].version, source: "path", path: v.path, registryChecksum: v.registryChecksum, vendoredTree: v.vendoredTree };
      continue;
    }
    if (!found[0].checksum) throw new Error(`Cargo.lock: ${n} has no checksum (not a registry crate)`);
    out[n] = { version: found[0].version, checksum: found[0].checksum };
  }
  return out;
}

/**
 * The crates.io checksums PATCHES.md records, {name: {version, checksum}}: under each "## <name>"
 * heading, exactly one "Published version: <version> (crates.io checksum `<64 hex>`)" (whitespace,
 * line breaks included, between the words). A heading without exactly one such line records none.
 */
export function patchesChecksums(text) {
  const out = {};
  for (const section of String(text).split(/^## /m).slice(1)) {
    const name = /^([A-Za-z0-9_-]+)\s*$/m.exec(section.split("\n")[0])?.[1];
    if (!name) continue;
    const found = [...section.matchAll(/Published version:\s*([0-9][0-9A-Za-z.+-]*)\s*\(crates\.io checksum\s*`([0-9a-f]{64})`\)/g)];
    if (found.length === 1 && !Object.hasOwn(out, name)) out[name] = { version: found[0][1], checksum: found[0][2] };
  }
  return out;
}

/** The digest of a vendored crate's tree: SHA-256 over "<sha256>  <path>\n" per file, paths (relative to the crate) sorted. */
export function treeDigest(dir) {
  // Sorted as whole relative paths (walk is depth first: "a/x" would come before "a.txt").
  const lines = walk(dir, "").sort().map((f) => `${sha256(fs.readFileSync(path.join(dir, f)))}  ${f}\n`);
  return sha256(lines.join(""));
}

/**
 * Every path entry of the lock (a package without a source) other than the binding itself (the
 * package Cargo.toml names) must be a vendored crate: its tree at vendor/<name>/, whose Cargo.toml
 * has the lock's version, and a record in vendor/PATCHES.md of the same version with its crates.io
 * checksum. Returns {name: {version, path, registryChecksum, vendoredTree}}; anything else fails.
 */
export function vendoredCrates(bindingRoot, lockText) {
  const own = /^\[package\][^[]*?^name\s*=\s*"([^"]+)"/ms.exec(fs.readFileSync(path.join(bindingRoot, "Cargo.toml"), "utf8"))?.[1] ?? null;
  const pathEntries = parseCargoLock(lockText).filter((p) => !p.source && p.name !== own);
  if (!pathEntries.length) return {};
  const patches = patchesChecksums(fs.readFileSync(path.join(bindingRoot, "vendor", "PATCHES.md"), "utf8"));
  const out = {};
  for (const p of pathEntries) {
    const rec = patches[p.name];
    if (!rec) throw new Error(`Cargo.lock: ${p.name} is a path dependency without a registry checksum in vendor/PATCHES.md (a vendored crate needs its "## ${p.name}" record)`);
    if (rec.version !== p.version) throw new Error(`vendor/PATCHES.md records ${p.name} ${rec.version}, the lock ${p.version}`);
    const rel = `vendor/${p.name}`;
    const dir = path.join(bindingRoot, rel);
    if (!fs.existsSync(dir) || !fs.lstatSync(dir).isDirectory()) throw new Error(`${p.name}: no vendored tree at ${rel}`);
    let manifest;
    try {
      manifest = fs.readFileSync(path.join(dir, "Cargo.toml"), "utf8");
    } catch {
      throw new Error(`${p.name}: ${rel}/Cargo.toml is missing`);
    }
    const version = /^\[package\][^[]*?^version\s*=\s*"([^"]+)"/ms.exec(manifest)?.[1];
    if (version !== p.version) throw new Error(`${rel}/Cargo.toml is version ${version ?? "(none)"}, the lock ${p.version}`);
    out[p.name] = { version: p.version, path: rel, registryChecksum: rec.checksum, vendoredTree: treeDigest(dir) };
  }
  return out;
}

/** The [[package]] entries of a Cargo.lock: [{name, version, source, checksum}]. */
export function parseCargoLock(text) {
  const pkgs = [];
  let cur = null;
  for (const raw of String(text).split("\n")) {
    const line = raw.trim();
    if (line.startsWith("[")) {
      cur = line === "[[package]]" ? {} : null;
      if (cur) pkgs.push(cur);
      continue;
    }
    const m = /^(name|version|source|checksum)\s*=\s*"([^"]*)"$/.exec(line);
    if (cur && m) cur[m[1]] = m[2];
  }
  return pkgs;
}

const prefixed = (files) => Object.fromEntries(Object.entries(files).map(([k, v]) => [`${BINDING_PREFIX}/${k}`, v]));

const LOAD = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)(["'`])([^"'`]+)\1/g;
const LITERAL_ARG = /^\(\s*(["'`])[^"'`$]*\1\s*\)$/;
/** The import(...) and require(...) calls of `src` whose argument is not one literal, whitespace removed. */
function dynamicLoads(src) {
  const out = [];
  for (const m of src.matchAll(/\b(?:import|require)\s*\(/g)) {
    let depth = 0;
    let end = m.index + m[0].length - 1;
    for (; end < src.length; end++) {
      if (src[end] === "(") depth++;
      else if (src[end] === ")" && --depth === 0) break;
    }
    const call = src.slice(m.index, end + 1);
    if (!LITERAL_ARG.test(call.slice(call.indexOf("(")))) out.push(call.replace(/\s+/g, ""));
  }
  return out;
}
const isModule = (f) => /\.(?:m?js|cjs)$/.test(f);

/**
 * The static import closure of the group-3 modules under `repo`: every repository file reached
 * from them by a literal import, export ... from, import() or require() of a relative specifier.
 * Returns {closure: [path], unlisted: [path], dynamic: [{file, load}]}: unlisted are the files of
 * the closure neither in group 3 nor in CLOSURE_EXCLUDED; dynamic are the non-literal loads not
 * named in DYNAMIC_LOADS. A relative specifier that resolves to no file fails.
 */
export function hoptellClosure(repo = REPO) {
  const listed = Object.keys(hashPaths(repo, GROUPS.hoptell.paths, { label: "the repository" }));
  const listedSet = new Set(listed);
  const seen = new Set();
  const queue = listed.filter(isModule);
  const dynamic = [];
  while (queue.length) {
    const f = queue.shift();
    if (seen.has(f)) continue;
    seen.add(f);
    const src = fs.readFileSync(path.join(repo, f), "utf8");
    for (const m of src.matchAll(LOAD)) {
      const spec = m[2];
      if (!spec.startsWith(".")) continue; // node: built-ins and packages (package-lock.json)
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(f), spec));
      if (target.startsWith("../") || !fs.existsSync(path.join(repo, target)) || !fs.statSync(path.join(repo, target)).isFile()) throw new Error(`${f}: loads ${spec}, which is no file of the repository`);
      if (isModule(target)) queue.push(target);
      else seen.add(target);
    }
    for (const load of dynamicLoads(src)) if (!Object.hasOwn(DYNAMIC_LOADS[f] ?? {}, load)) dynamic.push({ file: f, load });
  }
  const closure = [...seen].sort();
  return { closure, unlisted: closure.filter((f) => !listedSet.has(f) && !Object.hasOwn(CLOSURE_EXCLUDED, f)), dynamic };
}

/** The reviewed-input manifest of the repository at `repo` and the binding at `bindingRoot`. */
export function reviewedInputs({ repo = REPO, bindingRoot = BINDING_ROOT_DEFAULT } = {}) {
  const { unlisted, dynamic } = hoptellClosure(repo);
  if (unlisted.length) throw new Error(`group 3's import closure has files neither listed nor excluded: ${unlisted.join(", ")}`);
  if (dynamic.length) throw new Error(`group 3 has non-literal loads the closure cannot follow: ${dynamic.map((d) => `${d.file}: ${d.load}`).join(", ")}`);
  const lib = GROUPS.library;
  const lockFile = path.join(bindingRoot, "Cargo.lock");
  const lock = hashPaths(bindingRoot, lib.paths, { label: `the binding root ${bindingRoot}` });
  const lockText = fs.readFileSync(lockFile, "utf8");
  const vendored = vendoredCrates(bindingRoot, lockText);
  return {
    // 2: the library group carries the vendored provider (vendor/**, PATCHES.md, path entries).
    format: "hoptell-reviewed-inputs-2",
    library: { files: prefixed(lock), crates: lockedCrates(lockText, lib.crates, vendored), vendored },
    binding: { files: prefixed(hashPaths(bindingRoot, GROUPS.binding.paths, { label: `the binding root ${bindingRoot}` })) },
    hoptell: { files: hashPaths(repo, GROUPS.hoptell.paths, { label: "the repository" }) },
  };
}

/**
 * The runtime-artifact manifest of an unpacked package at `pkgDir` (the tarball's package/
 * directory): the group-3 files it carries as shipped, and every file of the binding bundle.
 * A shipped group-3 file missing from the package fails; the bundle may be absent (today).
 */
export function runtimeArtifacts(pkgDir) {
  const shipped = GROUPS.hoptell.paths.filter((p) => !NOT_SHIPPED.has(p));
  const files = hashPaths(pkgDir, shipped, { label: `the package ${pkgDir}` });
  Object.assign(files, hashPaths(pkgDir, [`${BUNDLE_DIR}/**`], { optional: true }));
  return { format: "hoptell-runtime-artifacts-1", files };
}

/**
 * The reviewed build mapping CI records when it builds the binding from the reviewed inputs:
 * the reviewed-input manifest's digest, the toolchain, and the glue and WASM it produced (as
 * placed in the package). The JavaScript files map by identity.
 */
export function buildMapping({ inputsBytes, glue, wasm, rust, wasmBindgen }) {
  for (const [k, v] of Object.entries({ rust, wasmBindgen })) if (!v || typeof v !== "string") throw new Error(`the build mapping needs the ${k} version`);
  return {
    format: "hoptell-build-mapping-1",
    reviewedInputs: sha256(inputsBytes),
    toolchain: { rust, wasmBindgen },
    binding: { [`${BUNDLE_DIR}/openmls_wasm.js`]: sha256(glue), [`${BUNDLE_DIR}/openmls_wasm_bg.wasm`]: sha256(wasm) },
    javascript: "identity",
  };
}

/**
 * The reviewed digests a package's lib/mls/openmls.js declares: null when both are null (not a
 * reviewed build), else {glue, wasm}. Anything that is not exactly the expected declaration is
 * treated as a claim (fail closed: the full checks then run, and fail).
 */
export function declaredReviewedDigests(openmlsSource) {
  const re = /^export const REVIEWED_BINDING = Object\.freeze\(\{ glue: (null|"[0-9a-f]{64}"), wasm: (null|"[0-9a-f]{64}") \}\);$/gm;
  const found = [...String(openmlsSource).matchAll(re)];
  if (found.length !== 1) return { glue: "unparsed", wasm: "unparsed" };
  const [, g, w] = found[0];
  if (g === "null" && w === "null") return null;
  return { glue: JSON.parse(g), wasm: JSON.parse(w) };
}

const readRecord = (file, what) => {
  try {
    return fs.readFileSync(file);
  } catch (e) {
    throw new Error(`the ${what} is not recorded (${path.relative(REPO, file)}: ${e.code ?? e.message})`);
  }
};

/**
 * The release check (design 3.5 "Tests"). A package whose openmls.js declares no reviewed digests
 * keeps the experimental label whatever it loads, and passes. Otherwise it claims a reviewed build,
 * and every condition must hold: (1) the runtime-artifact manifest of the unpacked package equals
 * the recorded one, every file; (2) the mapping ties the recorded reviewed-input manifest to the
 * package's glue and WASM, and each shipped JavaScript file is its reviewed input (identity); (3)
 * the reviewed-input manifest regenerated now equals the recorded one; and the declared digests
 * are the mapping's. Returns {reviewedBuild, problems}.
 */
export function releaseCheck({ pkgDir, repo = REPO, bindingRoot = BINDING_ROOT_DEFAULT, records = RECORDS }) {
  const openmls = path.join(pkgDir, "lib", "mls", "openmls.js");
  const declared = declaredReviewedDigests(fs.readFileSync(openmls, "utf8"));
  if (!declared) return { reviewedBuild: false, problems: [] };
  const problems = [];
  const attempt = (fn) => {
    try {
      fn();
    } catch (e) {
      problems.push(e.message);
    }
  };
  let recordedRuntime, recordedInputsBytes, recordedInputs, mapping;
  attempt(() => (recordedRuntime = JSON.parse(readRecord(records.runtime, "runtime-artifact manifest"))));
  attempt(() => {
    recordedInputsBytes = readRecord(records.inputs, "reviewed-input manifest");
    recordedInputs = JSON.parse(recordedInputsBytes);
  });
  attempt(() => (mapping = JSON.parse(readRecord(records.mapping, "reviewed build mapping"))));

  // (1) the package, every file, against the recorded runtime-artifact manifest.
  let runtime = null;
  attempt(() => (runtime = runtimeArtifacts(pkgDir)));
  const glueKey = `${BUNDLE_DIR}/openmls_wasm.js`;
  const wasmKey = `${BUNDLE_DIR}/openmls_wasm_bg.wasm`;
  if (runtime) {
    for (const k of [glueKey, wasmKey]) if (!runtime.files[k]) problems.push(`the package carries no ${k}`);
    const extra = Object.keys(runtime.files).filter((k) => k.startsWith(`${BUNDLE_DIR}/`) && k !== glueKey && k !== wasmKey);
    if (extra.length) problems.push(`the binding bundle has files beyond the glue and the WASM: ${extra.join(", ")}`);
    if (recordedRuntime && canonical(runtime) !== canonical(recordedRuntime)) {
      const keys = new Set([...Object.keys(runtime.files), ...Object.keys(recordedRuntime.files ?? {})]);
      const diff = [...keys].sort().filter((k) => runtime.files[k] !== recordedRuntime.files?.[k]);
      problems.push(`the package differs from the recorded runtime-artifact manifest: ${diff.join(", ") || "format"}`);
    }
  }
  // (2) the mapping: the recorded inputs, the package's glue and WASM, identity for JavaScript.
  if (mapping && recordedInputsBytes) {
    if (mapping.format !== "hoptell-build-mapping-1") problems.push(`the build mapping has format ${mapping.format}`);
    if (mapping.reviewedInputs !== sha256(recordedInputsBytes)) problems.push("the build mapping names another reviewed-input manifest");
    if (mapping.javascript !== "identity") problems.push("the build mapping does not map JavaScript by identity");
    if (runtime) {
      for (const k of [glueKey, wasmKey]) if (!mapping.binding?.[k] || mapping.binding[k] !== runtime.files[k]) problems.push(`the build mapping does not produce the package's ${k}`);
      for (const [k, v] of Object.entries(runtime.files)) {
        if (k.startsWith(`${BUNDLE_DIR}/`)) continue;
        if (recordedInputs?.hoptell?.files?.[k] !== v) problems.push(`${k} in the package is not its reviewed input`);
      }
    }
    if (declared.glue !== mapping.binding?.[glueKey] || declared.wasm !== mapping.binding?.[wasmKey]) problems.push("REVIEWED_BINDING in the package's lib/mls/openmls.js is not the mapping's glue and WASM");
  }
  // (3) the reviewed inputs, regenerated now, against the recorded ones.
  if (recordedInputsBytes) attempt(() => {
    if (canonical(reviewedInputs({ repo, bindingRoot })) !== recordedInputsBytes.toString("utf8")) problems.push("the reviewed-input manifest regenerated now differs from the recorded one");
  });
  return { reviewedBuild: true, problems };
}

/** The value of `--name value` in argv, or the default. */
export const opt = (argv, name, dflt = null) => {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : dflt;
};
