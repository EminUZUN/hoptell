// The lead's team summary, made in a process of its own (design 8, 3.2): started by lib/engine.js
// with a deadline and ended by its handle when late, so that reading the team states and the
// process table never holds up the session's own process.
//
// Arguments: <hoptell home> <the session's name>. Output (stdout): the summary (lib/teams.js
// leadStatus), or nothing when the session leads no team. Exit 0; anything else is a failure,
// and so is any output the engine cannot read as a summary of that session.
import { leadStatus } from "./teams.js";

const [home, lead] = process.argv.slice(2);
if (!home || !lead) process.exit(2);
process.stdout.write(leadStatus(home, lead) ?? "");
