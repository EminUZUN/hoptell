// The release gate's in-repo records (design 3.5, "Scope" and "Tests"): the reviewed-input
// (provenance) manifest, the runtime-artifact manifest, the reviewed build mapping, and the
// release check over the three. Shared by the scripts next to this file; nothing here is shipped.
//
// Every record is canonical JSON (keys sorted at every level, two-space indent, one trailing
// newline) with no hosts or absolute paths, so the same inputs give the same bytes. The only times
// are the build attestations' start and end in the build mapping (format 2), which record the builds.
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
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
 * The binding's source tree (groups 1 and 2): native/openmls-wasm/ in this repository (amendment
 * A11; the bake-off keeps its own copy for its gates). HOPTELL_BINDING_ROOT or --binding-root names
 * another place. Its files are recorded as "openmls-wasm/<path>", never by where they were found.
 */
export const BINDING_ROOT_DEFAULT = path.join(REPO, "native", "openmls-wasm");
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
  // 2. hoptell's WASM binding: Rust source, Cargo.toml, build script, toolchain pin, and the
  //    reproducible build (amendment A11): the Dockerfile of the pinned build image, the script that
  //    builds the image and runs each build, and the deterministic glue wrapper. Each is listed by
  //    name, so a change to any of them changes this manifest. The glue and WASM the build produced
  //    are the shipped bundle, lib/mls/binding/, recorded in group 3 (lib/mls/**) and in the build
  //    mapping.
  binding: { root: "binding", paths: ["Cargo.toml", "build.sh", "rust-toolchain.toml", "src/**", "Dockerfile", "build-image.sh", "wrap-glue.mjs"] },
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
  //    generator and test/release-gate.test.js). A file run by path rather than imported (a
//    spawn target) is listed by name; every file shipped under bin/ or lib/ must be in this group
//    or in SHIPPED_EXCLUDED (shippedUnlisted), which catches the ones the closure cannot see.
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
      "lib/agentadapters.js",
      "lib/agentdeny.js",
      "lib/agentruns.js",
      "lib/agents.js",
      "lib/agentscli.js",
      "lib/agentspawn.js",
      "lib/agenttrust.js",
      "lib/apply.js",
      "lib/apptunnel.js",
      "lib/attested.js",
      "lib/backup.js",
      "lib/broker.js",
      "lib/capabilities.js",
      "lib/claims.js",
      "lib/clihelp.js",
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
      "lib/icons.js",
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
      "lib/ownerapp.js",
      "lib/ownerappauth.js",
      "lib/ownerapppage.js",
      "lib/ownerchannel.js",
      "lib/ownerchannelcli.js",
      "lib/ownerpeople.js",
      "lib/ownersig.js",
      "lib/ownertexts.js",
      "lib/profiles.js",
      "lib/realm.js",
      "lib/records.js",
      "lib/relays.js",
      "lib/reviewsets.js",
      "lib/roles.js",
      "lib/routes.js",
      "lib/session.js",
      "lib/settings.js",
      "lib/snapshot.js",
      "lib/telegram.js",
      "lib/teams.js",
      "lib/tmux.js",
      "lib/transfercli.js",
      "lib/transferin.js",
      "lib/transferout.js",
      "lib/transfers.js",
      "lib/transfersave.js",
      "lib/transferwire.js",
      "lib/wake.js",
      "lib/words.js",
      "lib/worktrees.js",
      // not imported but run: lib/files.js starts it as a child process (spawn of process.execPath
      // with its path) for every guarded read, a transfer's capture included
      "lib/read-helper.mjs",
      // not imported but run: lib/worktrees.js starts it as a child process (worktree commit capture)
      "lib/capture-helper.mjs",
      // not imported but read: lib/ownerapppage.js reads these at bridge start and serves them as
      // the owner app's page (design 7.4)
      "lib/miniapp/app.css",
      "lib/miniapp/app.js",
      "lib/miniapp/index.html",
      "lib/miniapp/tg.js",
      // not imported but read: lib/icons.js reads these at import (favicons, serverInfo icons) and
      // passes the 180 px file's path to notify-send
      "lib/icons/apple-touch-icon.png",
      "lib/icons/favicon-32.png",
      "lib/icons/icon-64.png",
      // not imported but read: lib/capabilities.js reads the role presets
      // (launch and safety flags per CLI); lib/roles.js reads the role templates (design 8)
      "presets/roles.json",
      "templates/roles/implementer.md",
      "templates/roles/reviewer.md",
      "templates/roles/tester.md",
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
    "createRequire(file)": "HOPTELL_MLS_WASM, an owner-given binding evaluated as CommonJS with a require relative to its own file (loadBindingFrom); always labeled experimental",
  },
};

/**
 * Files the package ships under bin/ or lib/ that are deliberately not in group 3, each with the
 * reason (reviewed like the list). None today. Every other shipped file there must be in group 3
 * (shippedUnlisted): the import closure cannot see a file run by path (a spawn or fork target, a
 * worker, a file read and evaluated), so completeness is checked against what is shipped.
 */
export const SHIPPED_EXCLUDED = {};
/** The package directories whose every file runs or can run with hoptell's code. */
const SHIPPED_DIRS = ["bin", "lib"];
// What npm never packs from a repository, so a stray Finder or editor file in a checkout is not
// taken for a shipped file. Mirrors npm-packlist 10.0.4 (npm 11.11.1, lib/index.js `defaults` and
// the strict rules of processPackage), in gitignore semantics: a rule without a leading "/" matches
// a file or directory of that name at any depth (and everything under it); a rule with one matches
// only at the package root. Used on the repository side only; an unpacked package is checked as
// it is (it holds only packed files). A nested .npmignore or .gitignore that drops further files is
// not followed: such a file is still required to be listed (fail closed).
const NPM_IGNORED_ANY_DEPTH = /^(?:\.npmignore|\.gitignore|\.git|\.svn|\.hg|CVS|npm-debug\.log|\.npmrc|\..*\.swp|\.DS_Store|\._.*|.*\.orig)$/;
const NPM_IGNORED_ROOT_ONLY = [/^\.lock-wscript$/, /^\.wafpickle-[^/]*$/, /^build\/config\.gypi$/, /^archived-packages\//, /^\.git$/, /^node_modules(?:\/|$)/, /^package-lock\.json$/, /^yarn\.lock$/, /^pnpm-lock\.yaml$/, /^bun\.lockb$/];
const npmIgnored = (rel) => rel.split("/").some((seg) => NPM_IGNORED_ANY_DEPTH.test(seg)) || NPM_IGNORED_ROOT_ONLY.some((re) => re.test(rel));

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

const inGroup3 = (f) => GROUPS.hoptell.paths.some((p) => (p.endsWith("/**") ? f.startsWith(p.slice(0, -2)) : f === p));
/**
 * The files under bin/ and lib/ of `root` that are neither in group 3 nor in SHIPPED_EXCLUDED,
 * sorted. `root` is a repository (what npm would not pack is skipped, npmIgnored) or, with
 * {packed: true}, an unpacked package (every file counts: it holds only what was packed). A
 * symlink fails.
 */
export function shippedUnlisted(root = REPO, { packed = false } = {}) {
  const files = [];
  for (const d of SHIPPED_DIRS) if (fs.existsSync(path.join(root, d))) files.push(...walk(root, d));
  return files.filter((f) => (packed || !npmIgnored(f)) && !inGroup3(f) && !Object.hasOwn(SHIPPED_EXCLUDED, f));
}
const assertShippedListed = (root, label, opts) => {
  const unlisted = shippedUnlisted(root, opts);
  if (unlisted.length) throw new Error(`${label} ships files under bin/ or lib/ that are neither in group 3 nor excluded: ${unlisted.join(", ")}`);
};

/** The reviewed-input manifest of the repository at `repo` and the binding at `bindingRoot`. */
export function reviewedInputs({ repo = REPO, bindingRoot = BINDING_ROOT_DEFAULT } = {}) {
  const { unlisted, dynamic } = hoptellClosure(repo);
  if (unlisted.length) throw new Error(`group 3's import closure has files neither listed nor excluded: ${unlisted.join(", ")}`);
  if (dynamic.length) throw new Error(`group 3 has non-literal loads the closure cannot follow: ${dynamic.map((d) => `${d.file}: ${d.load}`).join(", ")}`);
  assertShippedListed(repo, "the repository");
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
 * A shipped group-3 file missing from the package fails, and so does a file the package ships
 * under bin/ or lib/ that is neither in group 3 nor in SHIPPED_EXCLUDED; the bundle may be absent.
 */
export function runtimeArtifacts(pkgDir) {
  assertShippedListed(pkgDir, "the package", { packed: true });
  const shipped = GROUPS.hoptell.paths.filter((p) => !NOT_SHIPPED.has(p));
  const files = hashPaths(pkgDir, shipped, { label: `the package ${pkgDir}` });
  Object.assign(files, hashPaths(pkgDir, [`${BUNDLE_DIR}/**`], { optional: true }));
  return { format: "hoptell-runtime-artifacts-1", files };
}

export const GLUE_KEY = `${BUNDLE_DIR}/openmls_wasm.js`;
export const WASM_KEY = `${BUNDLE_DIR}/openmls_wasm_bg.wasm`;
/** The outputs of one build (build.sh): the wasm-bindgen glue before and after wrap-glue.mjs, and the WASM. */
const OUTPUT_KEYS = ["glue", "glueUnwrapped", "wasm"];
const DIGEST = /^[0-9a-f]{64}$/;
const IMAGE_ID = /^sha256:[0-9a-f]{64}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

/**
 * The pins of the build image's Dockerfile: the Rust base and the Node image it copies node from,
 * each "name:tag@sha256:<digest>" (a FROM line pinned by digest), and the wasm-bindgen-cli version
 * it installs. Throws when one is missing or not pinned by digest.
 */
export function dockerfilePins(text) {
  const froms = [...String(text).matchAll(/^FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+\S+)?\s*$/gim)].map((m) => m[1]);
  const pick = (name) => {
    const found = froms.filter((f) => f.startsWith(`${name}:`));
    if (found.length !== 1) throw new Error(`the Dockerfile has ${found.length} FROM ${name}:… lines (expected one)`);
    if (!/@sha256:[0-9a-f]{64}$/.test(found[0])) throw new Error(`the Dockerfile's ${name} image is not pinned by digest: ${found[0]}`);
    return found[0];
  };
  const bindgen = [...String(text).matchAll(/cargo install wasm-bindgen-cli --version (\S+) --locked/g)].map((m) => m[1]);
  if (bindgen.length !== 1) throw new Error("the Dockerfile does not install exactly one wasm-bindgen-cli --version <v> --locked");
  return { base: pick("rust"), node: pick("node"), wasmBindgen: bindgen[0] };
}

/** The toolchain channel of rust-toolchain.toml. */
export const toolchainChannel = (text) => /^channel\s*=\s*"([^"]+)"/m.exec(String(text))?.[1] ?? null;

/**
 * The reviewed build mapping (format 2, amendment A11), written after two clean builds in fresh
 * containers from one final build image: the reviewed-input manifest's digest; the image (its id as
 * `docker image inspect` gives it, the Dockerfile's digest, the base and Node images by digest); the
 * toolchain; the Cargo.lock digest; the outputs (unwrapped glue, wrapped glue, WASM) and where the
 * package carries them; and both builds' attestations (the image id, the container's start and end
 * time, each output digest). JavaScript maps by identity.
 */
export function buildMapping({ inputsBytes, dockerfile, cargoLock, toolchainToml, imageId, glue, wasm, attestations }) {
  const pins = dockerfilePins(dockerfile);
  const rust = toolchainChannel(toolchainToml);
  if (!rust) throw new Error("rust-toolchain.toml names no channel");
  if (!IMAGE_ID.test(String(imageId))) throw new Error(`the image id must be sha256:<64 hex>, not ${imageId}`);
  if (!Array.isArray(attestations) || attestations.length !== 2) throw new Error("the build mapping needs the attestations of two builds");
  const outputs = { ...attestations[0].outputs };
  const mapping = {
    format: "hoptell-build-mapping-2",
    reviewedInputs: sha256(inputsBytes),
    image: { id: imageId, dockerfile: sha256(dockerfile), base: pins.base, node: pins.node },
    toolchain: { rust, wasmBindgen: pins.wasmBindgen },
    cargoLock: sha256(cargoLock),
    outputs,
    binding: { [GLUE_KEY]: sha256(glue), [WASM_KEY]: sha256(wasm) },
    attestations: attestations.map((a) => ({ image: a.image, started: a.started, finished: a.finished, outputs: a.outputs })),
    javascript: "identity",
  };
  const problems = verifyBuildMapping(mapping, { inputsBytes, dockerfile, cargoLock, toolchainToml, glue, wasm });
  if (problems.length) throw new Error(`the builds do not make a valid mapping: ${problems.join("; ")}`);
  return mapping;
}

/**
 * The checks of a format-2 build mapping against the bytes it claims: the recorded reviewed-input
 * manifest (and, through it, the Dockerfile and Cargo.lock digests it lists), the Dockerfile, the
 * Cargo.lock and rust-toolchain.toml of the binding root, and the glue and WASM a package carries.
 * Both attestations must name the recorded image id and have the same outputs, equal to the recorded
 * outputs, whose glue and WASM are the package's. Returns the problems found ([] when it holds).
 */
export function verifyBuildMapping(mapping, { inputsBytes, dockerfile, cargoLock, toolchainToml, glue, wasm }) {
  const problems = [];
  const m = mapping ?? {};
  if (m.format !== "hoptell-build-mapping-2") return [`the build mapping has format ${m.format} (expected hoptell-build-mapping-2)`];
  if (m.javascript !== "identity") problems.push("the build mapping does not map JavaScript by identity");
  if (inputsBytes && m.reviewedInputs !== sha256(inputsBytes)) problems.push("the build mapping names another reviewed-input manifest");
  let inputs = null;
  try {
    inputs = inputsBytes ? JSON.parse(inputsBytes) : null;
  } catch {
    problems.push("the reviewed-input manifest is not JSON");
  }
  const img = m.image ?? {};
  if (!IMAGE_ID.test(String(img.id))) problems.push(`the build mapping's image id is not sha256:<64 hex>: ${img.id}`);
  if (dockerfile) {
    if (img.dockerfile !== sha256(dockerfile)) problems.push("the build mapping names another Dockerfile");
    try {
      const pins = dockerfilePins(dockerfile);
      if (img.base !== pins.base) problems.push(`the build mapping names another base image (${img.base}; the Dockerfile pins ${pins.base})`);
      if (img.node !== pins.node) problems.push(`the build mapping names another Node image (${img.node}; the Dockerfile pins ${pins.node})`);
      if (m.toolchain?.wasmBindgen !== pins.wasmBindgen) problems.push(`the build mapping names wasm-bindgen ${m.toolchain?.wasmBindgen}, the Dockerfile installs ${pins.wasmBindgen}`);
    } catch (e) {
      problems.push(e.message);
    }
  }
  if (toolchainToml && m.toolchain?.rust !== toolchainChannel(toolchainToml)) problems.push(`the build mapping names Rust ${m.toolchain?.rust}, rust-toolchain.toml ${toolchainChannel(toolchainToml)}`);
  if (cargoLock && m.cargoLock !== sha256(cargoLock)) problems.push("the build mapping names another Cargo.lock");
  if (inputs) {
    if (inputs.binding?.files?.[`${BINDING_PREFIX}/Dockerfile`] !== img.dockerfile) problems.push("the reviewed-input manifest records another Dockerfile than the build mapping");
    if (inputs.library?.files?.[`${BINDING_PREFIX}/Cargo.lock`] !== m.cargoLock) problems.push("the reviewed-input manifest records another Cargo.lock than the build mapping");
  }
  const out = m.outputs ?? {};
  for (const k of OUTPUT_KEYS) if (!DIGEST.test(String(out[k]))) problems.push(`the build mapping's outputs lack the ${k} digest`);
  if (Object.keys(out).sort().join() !== [...OUTPUT_KEYS].sort().join()) problems.push(`the build mapping's outputs are not exactly ${OUTPUT_KEYS.join(", ")}`);
  if (m.binding?.[GLUE_KEY] !== out.glue || m.binding?.[WASM_KEY] !== out.wasm) problems.push("the build mapping places other outputs in the package than it records");
  if (glue && out.glue !== sha256(glue)) problems.push(`the build mapping does not produce the package's ${GLUE_KEY}`);
  if (wasm && out.wasm !== sha256(wasm)) problems.push(`the build mapping does not produce the package's ${WASM_KEY}`);
  const att = Array.isArray(m.attestations) ? m.attestations : [];
  if (att.length !== 2) problems.push(`the build mapping has ${att.length} build attestations (expected two)`);
  att.forEach((a, i) => {
    const n = `build attestation ${i + 1}`;
    if (a?.image !== img.id) problems.push(`${n} names another image (${a?.image}) than the recorded ${img.id}`);
    if (!ISO.test(String(a?.started)) || !ISO.test(String(a?.finished)) || !(a.started <= a.finished)) problems.push(`${n} has no valid start and end time`);
    if (canonical(a?.outputs ?? {}) !== canonical(out)) problems.push(`${n}'s outputs differ from the recorded outputs`);
  });
  if (att.length === 2 && canonical(att[0]?.outputs ?? {}) !== canonical(att[1]?.outputs ?? {})) problems.push("the two builds' outputs differ (not byte-identical)");
  if (att.length === 2 && att[0]?.started === att[1]?.started) problems.push("the two build attestations are the same build");
  return problems;
}

// The child that reads REVIEWED_BINDING (declaredReviewedDigests). It runs with
// --frozen-intrinsics, so the module cannot change Object.prototype, Promise, JSON, Reflect or the
// other built-in objects while it loads (a module that tries fails to load, and is refused).
// globalThis itself stays writable, so the child takes every global it uses after the import
// (setTimeout, setImmediate, Promise, Error) before it. It reads a one-time nonce from stdin before the import (the module cannot read it
// again) and writes its answer as the last stdout line, carrying the nonce, built by string
// concatenation from checked primitives (no object goes through JSON.stringify, so no toJSON
// hook applies).
const READ_REVIEWED_BINDING = `
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { types } from "node:util";
const nonce = fs.readFileSync(0, "utf8").trim();
const writeSync = fs.writeSync, stringify = JSON.stringify, apply = Reflect.apply, ownKeys = Reflect.ownKeys;
const { isFrozen, getPrototypeOf, getOwnPropertyDescriptor, hasOwn } = Object, OBJECT_PROTOTYPE = Object.prototype;
const isProxy = types.isProxy, isNamespace = types.isModuleNamespaceObject;
const wait = setTimeout, soon = setImmediate, PromiseOf = Promise, ErrorOf = Error;
const test = RegExp.prototype.test, HEX = /^[0-9a-f]{64}$/, url = pathToFileURL(process.argv[1]).href;
const later = () => new PromiseOf((resolve) => soon(() => wait(resolve, 50)));
const digest = (x) => (x === null ? "null" : '"' + x + '"');
let answer;
try {
  const m = await import(url);
  if (!isNamespace(m)) throw new ErrorOf("the import did not give a module namespace");
  if (!("REVIEWED_BINDING" in m)) throw new ErrorOf("it exports no REVIEWED_BINDING");
  const v = m.REVIEWED_BINDING;
  // An export let reassigned right after loading (a microtask, setImmediate or a short timer).
  await later();
  if (m.REVIEWED_BINDING !== v) throw new ErrorOf("its value changed after the module loaded");
  if (v === null) {
    answer = '{"nonce":"' + nonce + '","ok":true,"value":null}';
  } else {
    if (typeof v !== "object") throw new ErrorOf("its value is neither null nor an object");
    if (isProxy(v)) throw new ErrorOf("its value is a Proxy");
    if (getPrototypeOf(v) !== OBJECT_PROTOTYPE) throw new ErrorOf("its value is not a plain object");
    if (!isFrozen(v)) throw new ErrorOf("its value is not frozen (Object.freeze)");
    const keys = ownKeys(v);
    if (keys.length !== 2) throw new ErrorOf("its object must have exactly the keys glue and wasm");
    let glue, wasm, seen = 0;
    for (let i = 0; i < 2; i++) {
      const k = keys[i];
      if (k !== "glue" && k !== "wasm") throw new ErrorOf("its object must have exactly the keys glue and wasm");
      const d = getOwnPropertyDescriptor(v, k);
      if (!hasOwn(d, "value")) throw new ErrorOf(k + " is an accessor, not a value");
      const x = d.value;
      if (x !== null && !(typeof x === "string" && apply(test, HEX, [x]))) throw new ErrorOf(k + " is neither null nor a 64-digit lower-case hex digest");
      if (k === "glue") glue = x;
      else wasm = x;
      seen++;
    }
    if (seen !== 2 || glue === undefined || wasm === undefined) throw new ErrorOf("its object must have exactly the keys glue and wasm");
    answer = '{"nonce":"' + nonce + '","ok":true,"value":' + (glue === null && wasm === null ? "null" : '{"glue":' + digest(glue) + ',"wasm":' + digest(wasm) + "}") + "}";
  }
} catch (e) {
  let text = "the module threw a value that is not an Error";
  try {
    const t = e !== null && typeof e === "object" ? e.message : undefined;
    if (typeof t === "string") text = t;
  } catch {
    // keep the generic text
  }
  answer = '{"nonce":"' + nonce + '","error":' + stringify(text) + "}";
}
writeSync(1, "\\n" + answer + "\\n");
`;

/**
 * The reviewed digests a package's lib/mls/openmls.js declares: null when it declares none
 * (REVIEWED_BINDING null, or both digests null: not a reviewed build), else {glue, wasm}.
 *
 * The value is the one the module actually exports: the file is imported in a child Node process
 * (its imports are Node built-ins and lib/mls/ files, so an unpacked package without node_modules
 * loads), not read as text, so a declaration in a comment, a string or a regular expression, or a
 * differently formatted export, cannot make it read another value than the runtime gets. It must
 * be null or a frozen plain object (not a Proxy) with exactly the data properties glue and wasm,
 * each null or a 64-digit lower-case hex digest. Anything else, a module that does not load (a
 * syntax error, a duplicate export, a change to a built-in object), or a child that fails or
 * times out throws (fail closed).
 *
 * The child runs with --frozen-intrinsics (the module cannot change the built-in objects the
 * check relies on), --no-warnings and a minimal environment (no HOPTELL_* variables or tokens;
 * HOME and the working directory an empty temporary directory), and is killed by PID when it
 * overruns the timeout. It is not a file-system or network sandbox: the release workflow runs
 * --records first, so the release check imports only recorded bytes. openmls.js and its imports
 * (lib/mls/driver.js, lib/mls/policy.js) only define constants and functions at the top level.
 *
 * The value is read when the import resolves and again after setImmediate and a 50 ms timer; a
 * change refuses. Known limit: a reassignment of an `export let` after that is not ruled out. The
 * reviewer reads the source, and --records ties every shipped file to its reviewed input.
 *
 * Scope: lib/mls/openmls.js is hoptell's own source, a reviewed input whose bytes --records binds.
 * This function reads the value that source really declares and fails closed on accidental or
 * unknown forms. A module written to deceive the reader is outside its scope (the source review
 * and --records cover that); the isolation above is a margin, not a sandbox for hostile code.
 */
export function declaredReviewedDigests(openmlsPath, { timeoutMs = 20000 } = {}) {
  const refuse = (why) => {
    throw new Error(`lib/mls/openmls.js: cannot read REVIEWED_BINDING: ${why}`);
  };
  const nonce = crypto.randomBytes(16).toString("hex");
  // A minimal environment: no HOPTELL_* settings or tokens, no NODE_OPTIONS or npm_config_*, and
  // HOME and the working directory a new empty directory (no user .npmrc or hoptell state in
  // reach). On timeout spawnSync kills the child by its PID with SIGKILL.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "hoptell-read-binding-"));
  let r;
  try {
    r = spawnSync(process.execPath, ["--frozen-intrinsics", "--no-warnings", "--input-type=module", "-e", READ_REVIEWED_BINDING, "--", path.resolve(openmlsPath)], { cwd: home, env: { HOME: home, TMPDIR: home, LANG: "C" }, encoding: "utf8", input: `${nonce}\n`, timeout: timeoutMs, killSignal: "SIGKILL", stdio: ["pipe", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024 });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
  if (r.error) refuse(r.error.code === "ETIMEDOUT" ? `the module did not load within ${timeoutMs} ms` : r.error.message);
  const last = String(r.stdout).trimEnd().split("\n").at(-1);
  let out = null;
  try {
    out = JSON.parse(last);
  } catch {
    // handled below
  }
  if (r.status !== 0 || !out || typeof out !== "object") refuse(`the reading process failed (exit ${r.status ?? r.signal})${r.stderr ? `: ${String(r.stderr).trim().split("\n").slice(-3).join(" | ")}` : ""}`);
  if (out.nonce !== nonce) refuse("the reading process's answer does not carry its nonce (the module wrote it, or exited before the check)");
  if (out.error) refuse(String(out.error).split("\n")[0]);
  if (out.ok !== true) refuse("the reading process gave no result");
  return out.value;
}

const readRecord = (file, what) => {
  try {
    return fs.readFileSync(file);
  } catch (e) {
    throw new Error(`the ${what} is not recorded (${path.relative(REPO, file)}: ${e.code ?? e.message})`);
  }
};

/**
 * The strict check of the committed records against a package (amendment A11), whatever the
 * package's REVIEWED_BINDING says: (1) the runtime-artifact manifest of the unpacked package equals
 * the recorded one, every file, and the bundle is exactly the glue and the WASM; (2) the build
 * mapping verifies (verifyBuildMapping: both attestations, the image, the Dockerfile, Cargo.lock,
 * toolchain) against the recorded reviewed inputs and the package's glue and WASM, and each shipped
 * JavaScript file is its reviewed input (identity); (3) the reviewed-input manifest regenerated now
 * equals the recorded one. Returns {problems, mapping}.
 */
export function recordsCheck({ pkgDir, repo = REPO, bindingRoot = BINDING_ROOT_DEFAULT, records = RECORDS }) {
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
  if (runtime) {
    for (const k of [GLUE_KEY, WASM_KEY]) if (!runtime.files[k]) problems.push(`the package carries no ${k}`);
    const extra = Object.keys(runtime.files).filter((k) => k.startsWith(`${BUNDLE_DIR}/`) && k !== GLUE_KEY && k !== WASM_KEY);
    if (extra.length) problems.push(`the binding bundle has files beyond the glue and the WASM: ${extra.join(", ")}`);
    if (recordedRuntime && canonical(runtime) !== canonical(recordedRuntime)) {
      const keys = new Set([...Object.keys(runtime.files), ...Object.keys(recordedRuntime.files ?? {})]);
      const diff = [...keys].sort().filter((k) => runtime.files[k] !== recordedRuntime.files?.[k]);
      problems.push(`the package differs from the recorded runtime-artifact manifest: ${diff.join(", ") || "format"}`);
    }
  }
  // (2) the mapping against the recorded inputs, the binding root's build inputs and the package's
  // bundle; JavaScript by identity.
  if (mapping && recordedInputsBytes) {
    const read = (rel) => {
      try {
        return fs.readFileSync(path.join(bindingRoot, rel));
      } catch (e) {
        problems.push(`the binding root has no ${rel} (${e.code ?? e.message})`);
        return null;
      }
    };
    const bundle = (k) => {
      try {
        return fs.readFileSync(path.join(pkgDir, k));
      } catch {
        return null;
      }
    };
    const glue = bundle(GLUE_KEY);
    const wasm = bundle(WASM_KEY);
    problems.push(...verifyBuildMapping(mapping, { inputsBytes: recordedInputsBytes, dockerfile: read("Dockerfile"), cargoLock: read("Cargo.lock"), toolchainToml: read("rust-toolchain.toml"), glue, wasm }));
    if (runtime) {
      for (const [k, v] of Object.entries(runtime.files)) {
        if (k.startsWith(`${BUNDLE_DIR}/`)) continue;
        if (recordedInputs?.hoptell?.files?.[k] !== v) problems.push(`${k} in the package is not its reviewed input`);
      }
    }
  }
  // (3) the reviewed inputs, regenerated now, against the recorded ones.
  if (recordedInputsBytes) attempt(() => {
    if (canonical(reviewedInputs({ repo, bindingRoot })) !== recordedInputsBytes.toString("utf8")) problems.push("the reviewed-input manifest regenerated now differs from the recorded one");
  });
  return { problems, mapping };
}

/**
 * The release check (design 3.5 "Tests"). A package whose openmls.js declares no reviewed digests
 * keeps the experimental label whatever it loads, and passes. Otherwise it claims a reviewed build:
 * every condition of recordsCheck must hold, and the declared digests must be the mapping's glue
 * and WASM. Returns {reviewedBuild, problems}.
 */
export function releaseCheck({ pkgDir, repo = REPO, bindingRoot = BINDING_ROOT_DEFAULT, records = RECORDS }) {
  const openmls = path.join(pkgDir, "lib", "mls", "openmls.js");
  const declared = declaredReviewedDigests(openmls);
  if (!declared) return { reviewedBuild: false, problems: [] };
  const { problems, mapping } = recordsCheck({ pkgDir, repo, bindingRoot, records });
  if (mapping && (declared.glue !== mapping.binding?.[GLUE_KEY] || declared.wasm !== mapping.binding?.[WASM_KEY])) problems.push("REVIEWED_BINDING in the package's lib/mls/openmls.js is not the mapping's glue and WASM");
  return { reviewedBuild: true, problems };
}

/** The value of `--name value` in argv, or the default. */
export const opt = (argv, name, dflt = null) => {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : dflt;
};
