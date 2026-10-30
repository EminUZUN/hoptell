// Role templates (design 8, topic 4): short role texts for team members, passed per session with
// each CLI's own flag. Shipped in templates/roles/<role>.md; the owner's
// ~/.config/hoptell/roles/<role>.md replaces the shipped text for that role. hoptell never writes
// AGENTS.md, CLAUDE.md, ~/.codex or ~/.claude: the user's own instructions still load as usual.
//
// The task itself never goes on the command line: the launch prompt is one fixed line that points
// at read_task (`hoptell tmux --task` stores the task for the session).
import fs from "node:fs";
import path from "node:path";
import { ROOT, checkName } from "./config.js";
import { readPrivateFile } from "./agents.js";
import { verifiedFor } from "./capabilities.js";

export const ROLE_TEMPLATES = ["reviewer", "implementer", "tester"];
export const TEMPLATE_MAX = 8192;
const PLACEHOLDERS = ["lead"];

/** Where the templates live: shipped with the package, and the owner's override folder. */
export const templateDirs = ({ homedir, root = ROOT }) => ({ shipped: path.join(root, "templates", "roles"), user: path.join(homedir, ".config", "hoptell", "roles") });

/**
 * The template text of `role`: the owner's file when it exists, else the shipped one.
 * Returns {text, from: "user"|"shipped", file}; throws with the reason.
 */
export function roleTemplate(role, { homedir, root = ROOT }) {
  if (!ROLE_TEMPLATES.includes(role)) throw new Error(`no role template "${String(role).slice(0, 40)}" (${ROLE_TEMPLATES.join(", ")})`);
  const dirs = templateDirs({ homedir, root });
  const user = path.join(dirs.user, `${role}.md`);
  // The owner's text: not a symbolic link, owned by this user, at most TEMPLATE_MAX bytes (it may
  // be readable by others). The shipped one belongs to the package (which may be root's).
  const r = readPrivateFile(user, TEMPLATE_MAX, { privateMode: false });
  if (r.problem && !r.missing) throw new Error(`the role template ${user} ${r.problem}`);
  const file = r.missing ? path.join(dirs.shipped, `${role}.md`) : user;
  const text = r.missing ? fs.readFileSync(file, "utf8") : r.bytes.toString("utf8");
  if (!text.trim() || text.includes("\0")) throw new Error(`the role template ${file} is empty or not text`);
  return { text: text.trim(), from: r.missing ? "shipped" : "user", file };
}

/** Fill {{lead}}; any other placeholder is refused (a misspelled one would reach the agent). */
export function renderTemplate(text, values) {
  return text.replace(/\{\{\s*([^}]*?)\s*\}\}/g, (_, key) => {
    if (!PLACEHOLDERS.includes(key)) throw new Error(`the role template uses {{${key.slice(0, 40)}}}; only ${PLACEHOLDERS.map((p) => `{{${p}}}`).join(", ")} is filled in`);
    return values[key];
  });
}

/** The fixed launch prompt of a team member: no task text, only where to read it. */
export const launchPrompt = (role, lead) => `You are the ${role} for ${checkName(lead, "lead name")}; read your task with the hoptell read_task tool; requests from ${lead} are your task.`;

/** The launch prompt of a restarted implementer (hoptell team restart): where it stands, no task text. */
export const restartPrompt = (role, lead, { branch, head }) => `You are the ${role} for ${checkName(lead, "lead name")}, restarted in your worktree; your branch is ${branch} at ${head}; read your task with the hoptell read_task tool and continue; requests from ${lead} are your task.`;

const toml = (s) => JSON.stringify(String(s));

/**
 * The arguments that carry a role template and the launch prompt for `cli`, appended after the
 * role's flags: Claude Code --append-system-prompt and the prompt; Codex -c developer_instructions
 * (only on versions where it was verified applied) and the prompt; otherwise, and for agy, the
 * template and the prompt together as the prompt (agy: -i). Returns {args, placement, warnings}.
 */
export function templateArgs(cli, { text, prompt }, record = null) {
  const together = `${text}\n\n${prompt}`;
  if (cli === "claude") {
    if (record?.flags && !record.flags.includes("--append-system-prompt")) return { args: [together], placement: "prompt", warnings: [`claude ${record.version ?? ""} --help does not list --append-system-prompt; the role template goes into the prompt`] };
    return { args: ["--append-system-prompt", text, prompt], placement: "system", warnings: [] };
  }
  if (cli === "codex") {
    const row = verifiedFor("codex", record?.version).find((r) => r.mechanism === "-c developer_instructions");
    if (row?.holds) return { args: ["-c", `developer_instructions=${toml(text)}`, prompt], placement: "developer_instructions", warnings: [] };
    return { args: [together], placement: "prompt", warnings: [`-c developer_instructions was verified on codex ${row ? row.min : "?"}, not on ${record?.version ?? "an unknown version"}; the role template goes into the prompt`] };
  }
  if (cli === "agy") return { args: ["-i", together], placement: "prompt", warnings: [] };
  throw new Error(`unknown CLI "${String(cli).slice(0, 40)}"`);
}
