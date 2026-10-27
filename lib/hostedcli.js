// `hoptell mcp-hosted` (design 4.5, EXPERIMENTAL): the hosted endpoint and its link table.
// Refused without --experimental.
import fs from "node:fs";
import path from "node:path";
import { HOSTED_USAGE } from "./clihelp.js";
import { shellQuote } from "./config.js";

const USAGE = HOSTED_USAGE;

/** The host credential from its file: private, never logged. */
export function readHostToken(file) {
  if (!file) throw new Error("hostTokenFile must name the file holding this host's token (hoptell members host add <id> shows it once)");
  const st = fs.statSync(file);
  if (process.platform !== "win32" && st.mode & 0o077) throw new Error(`${file} is readable by other users; chmod 600 it`);
  const t = fs.readFileSync(file, "utf8").trim();
  if (t.length < 16) throw new Error(`${file} does not hold a host token`);
  return t;
}

/**
 * The error for a failed link-table write: after its replace the change may be in force, so the
 * outcome is unknown, and the check command names the same state directory (shell-quoted).
 */
export function unknownOutcome(e, stateDir) {
  if (e.phase && e.phase !== "before-replace") return Object.assign(new Error(`the outcome is unknown (the change may be in force: ${e.message}); check with hoptell mcp-hosted --experimental list --state-dir ${shellQuote(stateDir)}`), { exitCode: 1 });
  return e;
}

export async function hostedCommand({ args, opt, log = (...a) => console.error(new Date().toISOString(), ...a), out = console.log }) {
  if (!args.includes("--experimental")) throw Object.assign(new Error("hoptell mcp-hosted is experimental: hosted mode lets the host read every message of its tenants. Pass --experimental to use it."), { exitCode: 2 });
  const stateDir = opt("--state-dir");
  if (!stateDir) throw Object.assign(new Error(USAGE), { exitCode: 2 });
  const values = new Set(["--state-dir", "--config", "--port", "--bind", "--issuer", "--subject", "--member", "--name"]);
  const [sub] = args.filter((a, i) => !a.startsWith("--") && !values.has(args[i - 1]));
  const links = await import("./hostedlinks.js");
  // A link-table write that failed after its replace (writeDurable's after-replace phase) may be in
  // force: its outcome is unknown until the table is read back, never "refused".
  const unknown = (e) => {
    throw unknownOutcome(e, stateDir);
  };
  if (sub === "link") {
    const r = await links.link(stateDir, { issuer: opt("--issuer"), subject: opt("--subject"), member: { id: opt("--member"), name: opt("--name") } }).catch(unknown);
    return out(r.already ? "That link exists already." : `Linked (generation ${r.generation}). Earlier owner-page sessions of that identity or member end.`);
  }
  if (sub === "unlink") {
    const r = await links.unlink(stateDir, { issuer: opt("--issuer"), subject: opt("--subject") }).catch(unknown);
    return out(`Unlinked ${r.member.name}: its engine stops at the server's next sweep and its hosted data is deleted within 24 hours.`);
  }
  if (sub === "list") {
    const rows = links.readLinks(stateDir).links;
    if (!rows.length) out("No links.");
    for (const l of rows) out(`${l.issuer}\t${l.subject}\t${l.member.name} (${l.member.id})\tgeneration ${l.generation}`);
    return;
  }
  if (sub) throw Object.assign(new Error(USAGE), { exitCode: 2 });
  const cfgFile = opt("--config");
  if (!cfgFile) throw Object.assign(new Error(USAGE), { exitCode: 2 });
  const { loadHostedConfig, startHosted } = await import("./hosted.js");
  const { createTenants } = await import("./hostedtenants.js");
  const { createVerifier } = await import("./oidc.js");
  const { serveEngine } = await import("./mcp.js");
  const config = await loadHostedConfig(cfgFile);
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const hostToken = readHostToken(config.hostTokenFile && path.resolve(path.dirname(cfgFile), config.hostTokenFile));
  const verifier = await createVerifier(config.oidc, { log });
  const tenants = createTenants({ config, stateDir, hostToken, log });
  log(`EXPERIMENTAL: hosted mode: this host reads every message of its tenants; host id ${config.hostId}`);
  const port = Number(opt("--port") ?? 7791);
  let owner = null;
  if (config.owner) {
    const { createOwnerPage } = await import("./hostedowner.js");
    const { linkTable } = links;
    const secret = config.owner.clientSecretFile ? readHostToken(path.resolve(path.dirname(cfgFile), config.owner.clientSecretFile)) : undefined;
    owner = createOwnerPage({ config: { ...config, owner: { ...config.owner, clientSecret: secret } }, stateDir, links: linkTable(stateDir), tenants, storage: tenants.storage, log });
  }
  const h = await startHosted({ config, stateDir, verifier, tenants, owner, serve: (e, t, o) => serveEngine(e, t, { front: "hosted", elicitation: e.elicitation ?? null, ...o }), bind: opt("--bind") ?? "127.0.0.1", port, log });
  await tenants.resume(links.readLinks(stateDir).links);
  const { createRetention } = await import("./hostedretention.js");
  const retention = createRetention({ config, stateDir, links: links.linkTable(stateDir), tenants, server: h, log });
  retention.sweep().catch((e) => log(`retention: ${e.message}`));
  let ending = false;
  const shutdown = () => {
    if (ending) return;
    ending = true;
    setTimeout(() => process.exit(0), 5000).unref();
    retention.stop();
    h.close().then(() => tenants.close()).finally(() => process.exit(0));
  };
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(sig, shutdown);
}
