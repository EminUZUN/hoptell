// The real-CLI harness's process matcher (test/real-cli/procmatch.js): only a Codex process whose
// environment assigns exactly CODEX_HOME=<the temporary folder> is selected for a stop.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isCodexProcess, psRows, startedFromCodexHome } from "./real-cli/procmatch.js";

const DIR = "/private/var/folders/xy/T/hoptell-agents-AbC123/codex-home";
const VAR = "/var/folders/xy/T/hoptell-agents-AbC123/codex-home";
const DAEMON = `${VAR}/packages/app-server-daemon/releases/0.162.1/bin/codex app-server daemon pid-update-loop`;

test("procmatch: an exact CODEX_HOME assignment of a Codex process, in either spelling, is selected", () => {
  const rows = [
    { pid: 10, args: DAEMON, env: ` HOME=/x CODEX_HOME=${VAR} PATH=/bin` },
    { pid: 11, args: "/usr/local/bin/codex exec --json -", env: ` CODEX_HOME=${DIR}` },
    { pid: 12, args: "/opt/node/bin/node /opt/node/bin/codex app-server", env: ` CODEX_HOME=${DIR}/ X=1` },
  ];
  assert.deepEqual(startedFromCodexHome(rows, DIR), [10, 11, 12]);
  assert.deepEqual(startedFromCodexHome(rows, VAR), [10, 11, 12]);
});

test("procmatch: decoys are rejected: the path as an argument, in another variable, as a prefix of a longer path, a non-Codex process, the test itself", () => {
  const rows = [
    { pid: 20, args: `/usr/local/bin/codex exec -C ${DIR}`, env: " HOME=/x" }, // an argument only
    { pid: 21, args: "/usr/local/bin/codex exec", env: ` OTHER_HOME=${DIR} XCODEX_HOME=${DIR}` }, // other variables
    { pid: 22, args: "/usr/local/bin/codex exec", env: ` CODEX_HOME=${DIR}-other` }, // a longer path
    { pid: 23, args: "/usr/local/bin/codex exec", env: ` CODEX_HOME=${DIR}/sub` }, // a folder inside it
    { pid: 24, args: "/bin/sleep 600", env: ` CODEX_HOME=${DIR}` }, // not Codex
    { pid: 25, args: `/usr/bin/vim CODEX_HOME=${DIR}`, env: "" }, // the assignment as an argument
    { pid: 26, args: "/usr/local/bin/codex", env: ` CODEX_HOME=${DIR}` }, // the caller itself
  ];
  assert.deepEqual(startedFromCodexHome(rows, DIR, { self: 26 }), []);
  assert.equal(isCodexProcess("/usr/local/bin/codex-wrapper exec"), false);
  assert.equal(isCodexProcess("/bin/sh -c codex"), false);
});

test("procmatch: rows join ps without and with -E by pid; the environment is only what -E adds after the same arguments", () => {
  const plain = `  10 ${DAEMON}\n  20 /usr/local/bin/codex exec\n  30 /usr/local/bin/codex x\n`;
  const withEnv = `  10 ${DAEMON} CODEX_HOME=${VAR}\n  20 /usr/local/bin/codex other CODEX_HOME=${VAR}\n`;
  const rows = psRows(plain, withEnv);
  assert.deepEqual(rows, [{ pid: 10, args: DAEMON, env: ` CODEX_HOME=${VAR}` }]);
  assert.deepEqual(startedFromCodexHome(rows, DIR), [10]);
});
