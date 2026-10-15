// A stand-in for `codex exec` in the spawn tests (design 7.1): logs its arguments, environment and
// working folder, reads the task on stdin and writes the answer to the -o file, as codex does.
// Usage (through a shell wrapper the test writes): fake-codex.mjs <log dir> <codex arguments...>
// A task containing "WAIT:<file>" waits until that file exists; "SLEEP" sleeps for ten minutes;
// "CLOUD:<kinds>" writes those codex_cloud_config log lines to stderr first (comma-separated: none,
// loaded, cached, other), each written at once so the order on one stream is kept.
import fs from "node:fs";
import path from "node:path";

const [logDir, ...args] = process.argv.slice(2);
fs.writeFileSync(path.join(logDir, `call-${process.pid}.json`), JSON.stringify({ args, env: process.env, cwd: process.cwd() }));
let task = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => (task += d));
const CLOUD = {
  none: "2026-10-13T00:00:00.000000Z  INFO codex_cloud_config::service: Cloud config bundle load completed (none) elapsed_ms=0\n",
  loaded: "2026-10-13T00:00:00.000000Z  INFO codex_cloud_config::service: Cloud config bundle load completed config_fragments=2 requirements_fragments=1 elapsed_ms=3 secret-looking-text\n",
  cached: "2026-10-13T00:00:00.000000Z  INFO codex_cloud_config::service: Using cached cloud config bundle secret-looking-text\n",
  other: "2026-10-13T00:00:00.000000Z  WARN codex_cloud_config::service: refresh failed secret-looking-text\n",
};
process.stdin.on("end", async () => {
  const cloud = /CLOUD:(\S+)/.exec(task);
  if (cloud) for (const k of cloud[1].split(",")) fs.writeSync(2, CLOUD[k] ?? "");
  const wait = /WAIT:(\S+)/.exec(task);
  if (wait) while (!fs.existsSync(wait[1])) await new Promise((r) => setTimeout(r, 50));
  if (task.includes("SLEEP")) await new Promise((r) => setTimeout(r, 600_000));
  const o = args.indexOf("-o");
  if (o >= 0) fs.writeFileSync(args[o + 1], `answer: ${task}`);
  fs.writeSync(1, `{"type":"done"}\n`);
  // Cloud lines after the first event (a refresh during the run).
  const late = /LATE:(\S+)/.exec(task);
  if (late) for (const k of late[1].split(",")) fs.writeSync(2, CLOUD[k] ?? "");
});
