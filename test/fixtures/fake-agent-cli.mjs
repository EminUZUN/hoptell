#!/usr/bin/env node
// A stand-in for an agent CLI in the agent-spawn tests (design 7.1). Behaviour by argument:
//   echo            print "answer: <stdin>" and exit 0
//   env             print the environment as JSON
//   json            print {"result": "json answer: <stdin>"} (Claude Code's --output-format json)
//   file <path>     write "file answer: <stdin>" to <path> (codex exec -o), print "progress"
//   exit3           print "partial" and exit 3
//   crash           print "before crash" and kill itself with SIGKILL
//   big <bytes>     print <bytes> bytes of "x"
//   sleep           print "partial answer" then wait (stopped from outside)
//   stubborn        like sleep, but ignore SIGTERM (needs SIGKILL)
//   pwd             print the working directory
//   help <text>     print <text> (a CLI's --help)
//   orphan <file>   start `sleep 300` in a session of its own, write its pid to <file>, print
//                   "partial answer", wait (a CLI's command outside the agent's process group)
//   orphan-exit <file>  the same, then exit after 2.5 s, leaving the sleep behind
//   orphan-wait <file> <go>  the same, then exit once the file <go> exists (the test decides when)
//   many <n> <file>  start n `sleep 300` processes, each in a session of its own, write their
//                   pids (a JSON list) to <file>, print "partial answer", wait
import fs from "node:fs";
import { spawn } from "node:child_process";

const [mode, arg] = process.argv.slice(2);
const stdin = () => {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
};
const hold = () => setInterval(() => {}, 1000);
switch (mode) {
  case "echo":
    process.stdout.write(`answer: ${stdin()}`);
    break;
  case "env":
    process.stdout.write(JSON.stringify(process.env));
    break;
  case "json":
    process.stdout.write(JSON.stringify({ type: "result", result: `json answer: ${stdin()}` }));
    break;
  case "file":
    fs.writeFileSync(arg, `file answer: ${stdin()}`);
    process.stdout.write("progress\n");
    break;
  case "exit3":
    process.stdout.write("partial");
    process.exitCode = 3;
    break;
  case "crash":
    process.stdout.write("before crash");
    setTimeout(() => process.kill(process.pid, "SIGKILL"), 50);
    hold();
    break;
  case "big":
    process.stdout.write("x".repeat(Number(arg)));
    break;
  case "sleep":
    process.stdout.write("partial answer");
    hold();
    break;
  case "stubborn":
    process.on("SIGTERM", () => {});
    process.stdout.write("partial answer");
    hold();
    break;
  case "pwd":
    process.stdout.write(process.cwd());
    break;
  case "orphan":
  case "orphan-exit": {
    const c = spawn("sleep", ["300"], { detached: true, stdio: "ignore" });
    c.unref();
    fs.writeFileSync(arg, String(c.pid));
    process.stdout.write("partial answer");
    if (mode === "orphan") hold();
    else setTimeout(() => process.exit(0), 2500);
    break;
  }
  case "orphan-wait": {
    const c = spawn("sleep", ["300"], { detached: true, stdio: "ignore" });
    c.unref();
    fs.writeFileSync(arg, String(c.pid));
    process.stdout.write("partial answer");
    const go = process.argv[4];
    setInterval(() => fs.existsSync(go) && process.exit(0), 100);
    break;
  }
  case "many": {
    const file = process.argv[4];
    const pids = [];
    for (let i = 0; i < Number(arg); i++) {
      const c = spawn("sleep", ["300"], { detached: true, stdio: "ignore" });
      c.unref();
      pids.push(c.pid);
    }
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(pids));
    fs.renameSync(`${file}.tmp`, file);
    process.stdout.write("partial answer");
    hold();
    break;
  }
  case "help":
    process.stdout.write(arg ?? "");
    break;
  default:
    process.stderr.write(`unknown mode ${mode}\n`);
    process.exitCode = 2;
}
