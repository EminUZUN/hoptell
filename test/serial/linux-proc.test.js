// Linux tests that leave a real process in a state the working-folder scan refuses (or waits out)
// while it lives: a leader that called pthread_exit while its thread runs, an unreaped zombie. They
// run after the main suite, one file at a time (npm test: --test-concurrency=1), so no other test
// file's scan meets them.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { identityState, processCwdsScan, processIdentity, processTable } from "../../lib/host.js";
import { sleep } from "../helpers.js";

test("process working folders on Linux: a real zombie of yours does not make the scan unknown", { skip: process.platform !== "linux" && "Linux only (/proc)" }, async (t) => {
  // sh starts a child that exits at once and is never reaped while sh (now sleep) runs: a zombie.
  // It lives longer than any scan (one may wait out exiting processes for seconds); the test ends
  // it by its handle.
  const sh = spawn("sh", ["-c", "true & exec sleep 60"], { stdio: "ignore" });
  t.after(() => sh.kill());
  let zombie = null;
  for (let i = 0; i < 100 && zombie === null; i++, await sleep(20)) {
    for (const n of fs.readdirSync("/proc").filter((x) => /^\d+$/.test(x))) {
      try {
        const st = fs.readFileSync(`/proc/${n}/stat`, "utf8");
        const f = st.slice(st.lastIndexOf(")") + 2).split(" ");
        if (Number(f[1]) === sh.pid && f[0] === "Z") zombie = Number(n);
      } catch {}
    }
  }
  assert.ok(zombie, "a zombie child of sh");
  const r = processCwdsScan(process.getuid(), { platform: "linux" });
  assert.notEqual(r.rows, null, r.problem);
  assert.ok(!r.rows.some((x) => x.pid === zombie));
});

test("process working folders on Linux: a real leader that called pthread_exit while its thread runs is not taken for exited", { skip: process.platform !== "linux" && "Linux only (/proc)" }, async (t) => {
  if (spawnSync("sh", ["-c", "command -v cc"]).status !== 0) return t.skip("no C compiler (cc)");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hoptell-pthread-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // Its thread runs until the test closes stdin, so it outlives any scan; after 60 s it ends anyway,
  // should the test never close it (and t.after kills it by its handle).
  fs.writeFileSync(path.join(dir, "leader.c"), "#include <poll.h>\n#include <pthread.h>\nstatic void *run(void *a) { struct pollfd p = {0, POLLIN, 0}; (void)a; poll(&p, 1, 60000); return 0; }\nint main(void) { pthread_t t; pthread_create(&t, 0, run, 0); pthread_exit(0); }\n");
  const cc = spawnSync("cc", ["-pthread", "-o", path.join(dir, "leader"), path.join(dir, "leader.c")], { encoding: "utf8" });
  if (cc.status !== 0) return t.skip(`cc failed: ${cc.stderr.slice(0, 200)}`);
  const p = spawn(path.join(dir, "leader"), [], { stdio: ["pipe", "ignore", "ignore"] });
  t.after(() => p.kill());
  const stat = () => {
    const st = fs.readFileSync(`/proc/${p.pid}/stat`, "utf8");
    return st.slice(st.lastIndexOf(")") + 2).split(" ");
  };
  let f = null;
  for (let i = 0; i < 100 && f?.[0] !== "Z"; i++, await sleep(20)) f = stat();
  assert.equal(f[0], "Z", "the leader shows Z after pthread_exit");
  assert.equal(f[17], "2", "with its thread still running");
  const id = processIdentity(p.pid);
  assert.ok(id, "its identity is read");
  assert.equal(identityState(id), "same", "a zombie leader with a live thread still runs");
  assert.equal(processTable().get(p.pid)?.zombie, false);
  const r = processCwdsScan(process.getuid(), { platform: "linux" });
  // Never skipped as exited: listed with its folder, or the scan is unknown.
  assert.ok(r.rows === null || r.rows.some((x) => x.pid === p.pid), "the leader is not skipped");
  p.stdin.end(); // its thread returns, and the program exits
});
