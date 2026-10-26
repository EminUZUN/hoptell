// Isolation helpers for the real-session tests (sessions.test.js), kept apart so that
// test/real-session-isolation.test.js can check them in `npm test` without a model.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

/** The real tmux binary on `PATH`, resolved, never one of this test's wrappers in `skip`. */
export function realTmux(PATH = process.env.PATH, skip = []) {
  const dirs = PATH.split(path.delimiter).filter((d) => d && !skip.includes(d));
  for (const d of dirs) {
    const f = path.join(d, "tmux");
    try {
      fs.accessSync(f, fs.constants.X_OK);
      return fs.realpathSync(f);
    } catch {
      // not here
    }
  }
  throw new Error("tmux not found on PATH");
}

/**
 * A `tmux` wrapper that always talks to one private server and never reads a tmux config file:
 * every call becomes `<real> -S <socket> -f /dev/null <command> ...`. The first argument must be a
 * tmux command, or `-V` alone (hoptell's version probe); any other leading global option is
 * refused with exit 2 before the real tmux runs, because one that takes an argument (`-T 256`,
 * `-c cmd`) would hide a later `-S`, `-L` or `-f` from a scan. Options after the command
 * (`capture-pane -S -200`) pass through.
 */
export function writeTmuxWrapper(file, { real, socket }) {
  const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
  const body = [
    "#!/bin/sh",
    "# tmux for the hoptell real-session tests: one private server, no config files.",
    'if [ "$#" -eq 1 ] && [ "$1" = "-V" ]; then',
    `  exec ${q(real)} -V`,
    "fi",
    'case "${1-}" in',
    '  ""|-*) echo "tmux (test wrapper): a leading option is refused (${1-none}): this test uses one private server and no config" >&2; exit 2 ;;',
    "esac",
    `exec ${q(real)} -S ${q(socket)} -f /dev/null "$@"`,
    "",
  ].join("\n");
  fs.writeFileSync(file, body, { mode: 0o755 });
  return file;
}

/** The private server's own `kill-server`, only when the socket is the expected one. */
export function killPrivateServer({ real, socket }) {
  if (!fs.existsSync(socket)) return;
  try {
    execFileSync(real, ["-S", socket, "-f", "/dev/null", "kill-server"], { stdio: "ignore" });
  } catch {
    // already gone
  }
}

/**
 * A `hoptell` wrapper that pins every launch (CLI, launcher, a reviewer's MCP server) to the test
 * relay: the relay, token, relays file, home and config folders are exported before the
 * checkout's CLI runs, so a value from the caller's environment never wins. The settings file is
 * kept only when it lies inside the test folder `base` (a launched session's own file under the
 * test's hoptell home); any other value becomes the test's `envFile`.
 */
export function writeHoptellWrapper(file, { node, bin, pinned, envFile, base }) {
  const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
  const exports = Object.entries(pinned).map(([k, v]) => `export ${k}=${q(v)}`).join("\n");
  const env = `case "\${HOPTELL_ENV:-}" in\n  */../*) HOPTELL_ENV=${q(envFile)} ;;\n  ${q(base)}/*) ;;\n  *) HOPTELL_ENV=${q(envFile)} ;;\nesac\nexport HOPTELL_ENV`;
  fs.writeFileSync(file, `#!/bin/sh\n${exports}\n${env}\nexec ${q(node)} ${q(bin)} "$@"\n`, { mode: 0o755 });
  return file;
}

/** The only MCP configuration a test session may load: this checkout's hoptell server. */
export function writeMcpConfig(file, { node, bin, env }) {
  fs.writeFileSync(file, JSON.stringify({ mcpServers: { hoptell: { command: node, args: [bin, "mcp"], env } } }, null, 2), { mode: 0o600 });
  return file;
}

/**
 * Before a session starts: its arguments load MCP servers from exactly one file, with
 * --strict-mcp-config, and that file names only the expected hoptell server. Throws otherwise,
 * so no other server is ever started.
 */
export function assertExclusiveMcp(args, { bin }) {
  if (!args.includes("--strict-mcp-config")) throw new Error("the session must start with --strict-mcp-config");
  const at = args.indexOf("--mcp-config");
  if (at < 0 || args.indexOf("--mcp-config", at + 1) >= 0) throw new Error("the session must name exactly one --mcp-config");
  const cfg = JSON.parse(fs.readFileSync(args[at + 1], "utf8"));
  const names = Object.keys(cfg.mcpServers ?? {});
  if (names.length !== 1 || names[0] !== "hoptell") throw new Error(`unexpected MCP servers: ${names.join(", ")}`);
  const s = cfg.mcpServers.hoptell;
  if (s.args?.[0] !== bin || s.args?.[1] !== "mcp") throw new Error(`the hoptell server must be this checkout's: ${JSON.stringify(s.args)}`);
  for (const k of ["HOPTELL_RELAY", "HOPTELL_TOKEN", "HOPTELL_ENV", "HOPTELL_RELAYS", "HOPTELL_HOME"]) if (!s.env?.[k]) throw new Error(`the hoptell server must pin ${k}`);
}
