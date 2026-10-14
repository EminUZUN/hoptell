// A test stand-in for `hoptell agents supervise <run> --home <home>`: the shipped supervisor with
// the shipped hooks, and the gates a test recorded for its stand-in CLI (in supervisor-gates.json
// next to the home), so the start-time gate check runs against them. Test-only: the shipped
// command never reads gates from a file.
import fs from "node:fs";
import path from "node:path";
import { supervise } from "../../lib/agentruns.js";
import { supervisorHooks } from "../../lib/agentscli.js";

const args = process.argv.slice(2);
const run = args[2];
const home = args[args.indexOf("--home") + 1];
const gates = JSON.parse(fs.readFileSync(path.join(path.dirname(home), "supervisor-gates.json"), "utf8"));
await supervise(home, run, { ...(await supervisorHooks(home)), gates }, { env: process.env });
process.exit(0);
