// Real-CLI flag checks for agy (design 8, 3.6 and topic 0): the flags hoptell emits for an agy
// reviewer exist in the installed `agy --help`, read under the probe contract (an empty HOME and
// working folder; no model is started, nothing is signed in). Opt-in only:
//   HOPTELL_REAL_CLI=agy node --test test/real-cli/agy.test.js
// Skipped when agy is not on PATH (it is not installed on the Linux host).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { capabilities, loadPresets, resolveLaunch, verifiedFor } from "../../lib/capabilities.js";
import { helpNeeds } from "../../lib/agentadapters.js";
import { requireRealCli } from "./harness.js";

requireRealCli("agy");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "hoptell-agy-flags-"));
test.after(() => fs.rmSync(home, { recursive: true, force: true }));
// The probes get PATH and LANG only, and never this process's HOME.
const opts = { home, pathVar: process.env.PATH ?? "", homedir: fs.mkdtempSync(path.join(home, "home-")), lang: process.env.LANG };
const { record } = capabilities("agy", opts);
const absent = record.present ? false : "agy is not on PATH";

test(`agy ${record.version ?? ""}: every flag and value hoptell emits for an agy reviewer is in agy --help`, { skip: absent }, () => {
  assert.deepEqual(record.warnings, [], "the probes read agy's version and help");
  const presets = loadPresets(home);
  for (const request of [{}, { model: "gemini-4-argon-high" }]) {
    const r = resolveLaunch("agy", "reviewer", request, { record, presets });
    assert.ok(!r.refused, r.refused);
    assert.ok(!r.args.includes("--effort"), "hoptell never passes --effort to agy");
    // The launch prompt goes with -i (stays interactive).
    const tokens = [...r.args, "-i"].filter((a) => /^--?[A-Za-z]/.test(a));
    assert.deepEqual(tokens.filter((f) => !record.flags.includes(f)), [], `agy ${record.version} no longer lists these flags`);
    assert.ok(record.enums.mode.includes(r.args[r.args.indexOf("--mode") + 1]), `--mode values: ${record.enums.mode.join(", ")}`);
  }
});

test(`agy ${record.version ?? ""}: the spawn adapter's flags and mode values are in agy --help too`, { skip: absent }, () => {
  for (const mode of ["headless", "tmux"]) {
    for (const sandbox of ["read-only", "workspace-write"]) {
      const needs = helpNeeds({ cli: "agy", sandbox, cliOptions: { model: "m" } }, mode);
      assert.deepEqual(needs.flags.filter((f) => !record.flags.includes(f)), [], `${mode} ${sandbox}`);
      for (const { value } of needs.values) assert.ok(record.enums.mode.includes(value), `${mode} ${sandbox}: --mode ${value}`);
    }
  }
});

test(`agy ${record.version ?? ""}: the verified table covers this version (otherwise the sandbox and plan-mode test needs rerunning)`, { skip: absent }, (t) => {
  const rows = verifiedFor("agy", record.version);
  const stale = rows.filter((r) => !r.holds);
  if (stale.length) t.skip(`agy ${record.version} is outside the tested range of ${stale.map((r) => `${r.mechanism} (${r.min} to ${r.max})`).join(", ")}: rerun the sandbox and plan-mode test`);
  else assert.ok(rows.length >= 2);
});
