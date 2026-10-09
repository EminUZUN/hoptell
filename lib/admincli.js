// `hoptell relay admin ...` (design 4.4): the relay owner's commands. With the relay running, the
// CLI asks it over the admin socket and never opens the store; with it stopped, the CLI takes the
// state directory's lock and opens the store itself (one owner of the store at a time). An
// unfinished restore fences the offline commands except `restore --resume`, `--abort` and
// `status`. Nothing printed holds a token, a token digest or key material.
import fs from "node:fs";
import path from "node:path";
import { AdminError, adminRequest, createAdmin, membersFileDigest } from "./admin.js";
import { clean } from "./metrics.js";
import { REALM_ID_RE, fencedMessage, lockStateDir, readRestoreIntent } from "./realm.js";
import { openRelayStore } from "./relaystore.js";

/** The realm id stored in `stateDir`, or null (read only: never created here). */
export function readRealmId(stateDir) {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(stateDir, "realm.json"), "utf8"));
    return REALM_ID_RE.test(d?.id ?? "") ? d.id : null;
  } catch {
    return null;
  }
}

/**
 * Run fn(admin) with the relay's admin operations: over the socket when the relay runs, else on
 * the store opened by this process under the state directory's lock. `online: false` refuses the
 * running relay (offline-only commands); `fencedOk` lets status through an unfinished restore.
 */
export async function withAdmin({ stateDir, config = {}, e2ee = false, online = true, fencedOk = false }, fn) {
  let running = true;
  try {
    await adminRequest(stateDir, "status", {}, { timeoutMs: 10_000 });
  } catch (e) {
    if (!(e instanceof AdminError) || e.code !== "not_running") throw e;
    running = false;
  }
  if (running) {
    if (!online) throw new AdminError("running", "the relay is running: this command runs only while it is stopped");
    // A backup of a large store may run long: its answer is awaited, not timed out.
    return fn({ online: true, call: (op, args = {}) => adminRequest(stateDir, op, args, op === "backup" ? { timeoutMs: 24 * 3600_000 } : {}) });
  }
  let release;
  try {
    release = lockStateDir(stateDir);
  } catch (e) {
    throw new AdminError("running", `${e.message}, but it does not answer on its admin socket; the relay is running: use the admin socket (is it a hoptell without relay admin?)`);
  }
  try {
    let intent;
    try {
      intent = readRestoreIntent(stateDir);
    } catch (e) {
      throw new AdminError("fenced", e.message);
    }
    if (intent && !fencedOk) throw new AdminError("fenced", fencedMessage(intent));
    if (intent) return await fn({ online: false, fenced: intent, call: () => Promise.reject(new AdminError("fenced", fencedMessage(intent))) });
    const db = openRelayStore({ dir: stateDir });
    try {
      const admin = createAdmin({ stateDir, db, realm: readRealmId(stateDir), config, flags: { e2ee } });
      return await fn({ online: false, call: (op, args = {}) => admin.call(op, args, { actor: "offline-cli" }) });
    } finally {
      db.close();
    }
  } finally {
    release();
  }
}

/** Every page of a paged view. */
async function allRows(a, op, args) {
  const rows = [];
  let cursor = null;
  for (;;) {
    const r = await a.call(op, { ...args, ...(cursor ? { cursor } : {}) });
    rows.push(...r.rows);
    if (!r.next) return { ...r, rows };
    cursor = r.next;
  }
}

const show = (v) => (v === null || v === undefined ? "-" : clean(v));
const iso = (t) => (Number.isSafeInteger(t) ? new Date(t).toISOString() : "-");

/** --since: a time in ms, an ISO date, or an age like 7d, 12h, 30m. */
export function parseSince(v, now = Date.now()) {
  if (v === undefined || v === null) return undefined;
  const rel = /^(\d{1,6})([dhm])$/.exec(v);
  if (rel) return now - Number(rel[1]) * { d: 86_400_000, h: 3_600_000, m: 60_000 }[rel[2]];
  if (/^\d{1,15}$/.test(v)) return Number(v);
  const t = Date.parse(v);
  if (Number.isNaN(t)) throw new AdminError("bad_request", "--since takes a time (ISO date or ms) or an age (7d, 12h, 30m)");
  return t;
}

/**
 * A members-file change with its intent and result (design 4.4, "Outcomes"): the intent is
 * recorded first (refused: nothing is touched), then the file is edited under its lock, then the
 * running relay reloads it and records the result (offline: this process records it). Returns
 * {value, outcome: "ok" | "failed" | "unknown", online}.
 */
export async function auditedChange({ stateDir, config, action, target = null, change, e2ee = false, online = true }) {
  return withAdmin({ stateDir, config, e2ee, online }, async (a) => {
    // The running relay must apply the file this command edits: checked before anything is written.
    if (a.online && action.startsWith("members.")) {
      const st = await a.call("status");
      if (!config.members || st.membersFile !== membersFileDigest(config.members)) throw new AdminError("other_file", `the running relay uses another members file${st.membersFile ? "" : " (none)"}: run this with the file it was started with (--members or HOPTELL_MEMBERS); nothing was changed`);
    }
    const { intent } = await a.call("audit_intent", { action, target });
    let value;
    try {
      value = await change();
    } catch (e) {
      // Nothing was written: the result says so (if even that fails, the next start finds the intent).
      await a.call("audit_result", { intent, result: "failed", detail: { code: "not_written" } }).catch(() => {});
      throw e;
    }
    let outcome = "unknown";
    try {
      if (a.online) {
        const r = await a.call("reload", { intent });
        outcome = r.result ?? "unknown";
      } else {
        const r = await a.call("audit_result", { intent, result: "ok" });
        outcome = r.recorded ? "ok" : r.outcome;
      }
    } catch {
      outcome = "unknown";
    }
    return { value, outcome, online: a.online };
  });
}

/** The end of a members command's message: what the relay did with the change. */
export function appliedNote({ outcome, online }) {
  if (outcome === "unknown") return "Outcome unknown: the file was written, but the relay's result was not recorded; see hoptell relay admin audit.";
  if (outcome === "failed") return "The file was written, but the relay could not apply it (see hoptell relay admin audit); it keeps the previous list.";
  return online ? "The relay reloaded it." : "The relay applies it when it starts.";
}

const USAGE = `usage: hoptell relay admin <command> [--state-dir <dir>] [--json]
  status | members [--member <name>] | devices [--member <name>] | devices reinstate <member> <device>
  policy [check <from> <to>] | grants [--member <name>] | grants --entries --member <name>
  revocations [--since <time>] | metrics | store | checkpoint | backup <dir> [--pages <n>]
  restore <dir> | restore --resume | restore --abort | restore --discard-evidence <id>
  audit [--since <time>] | reload | ui [--port <n>]`;

/**
 * `hoptell relay admin <args>`. `config` = {members, policy, oidc} file paths, `out` and `err`
 * print one line each. Returns the exit code.
 */
export async function adminCommand({ args, stateDir, config, e2ee = false, out = console.log, testFault = null }) {
  const flagsWithValue = ["--member", "--since", "--pages", "--port", "--state-dir", "--members", "--policy", "--oidc", "--discard-evidence"];
  const opt = (f) => {
    const i = args.indexOf(f);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const words = args.filter((a, i) => !a.startsWith("--") && !flagsWithValue.includes(args[i - 1]));
  const [sub, ...rest] = words;
  const json = args.includes("--json");
  const print = (v, text) => (json ? out(JSON.stringify(v, null, 2)) : text(v));
  const member = opt("--member");
  const run = (fn, o = {}) => withAdmin({ stateDir, config, e2ee, ...o }, fn);

  switch (sub) {
    case "status":
      return run(
        async (a) => {
          if (a.fenced) {
            print({ realm: readRealmId(stateDir), running: false, restore: { id: a.fenced.id, phase: a.fenced.phase } }, (s) => {
              out(`realm ${show(s.realm)}; relay stopped`);
              out(`restore: unfinished ${s.restore.id} at ${s.restore.phase} (hoptell relay admin restore --resume, or --abort before installation)`);
            });
            return 0;
          }
          const s = await a.call("status");
          print(s, () => {
            out(`realm ${show(s.realm)}; hoptell ${show(s.version)}; relay ${s.running ? `running for ${s.uptimeSeconds}s, auth ${show(s.auth)}` : "stopped"}`);
            if (s.caps) out(`capabilities: ${s.caps.map(show).join(", ")}`);
            out(`flags: e2ee experimental ${s.flags.e2ee ? "on" : "off"}; store instance ${show(s.instance)}`);
            out(`restore: ${s.restore ? `unfinished ${s.restore.id} at ${s.restore.phase}` : "none"}`);
          });
          return 0;
        },
        { fencedOk: true },
      );
    case "members":
      return run(async (a) => {
        const r = await allRows(a, "members", member ? { member } : {});
        print(r.rows, (rows) => {
          if (!rows.length) out("No members.");
          for (const m of rows) {
            out(
              `${show(m.name)}\t${show(m.id)}\ttoken ${m.tokenPresent ? `present (${m.tokenFormat})` : "none"}\tlinked ${m.linked.length}\tbroker ${m.brokerFamilies}\tdevices ${m.devices}${m.suspended ? ` (${m.suspended} suspended)` : ""}\tsessions ${m.sessions ?? "-"}\tqueued ${m.quota ? `${m.quota.queued}/${m.quota.limits.queuedPerSender}` : "-"}`,
            );
            for (const l of m.linked) out(`  linked ${show(l.issuer)} ${show(l.subject)}`);
          }
        });
        return 0;
      });
    case "devices": {
      if (rest[0] === "reinstate") {
        const [, who, device] = rest;
        if (!who || !device) throw new AdminError("bad_request", "usage: hoptell relay admin devices reinstate <member> <device>");
        return run(async (a) => {
          const r = await a.call("reinstate", { member: who, device });
          print(r, () => out(r.state === "reinstated" ? `Device ${device} of ${who} is in service again (recorded in the audit log).` : `Device ${device} of ${who} was not suspended; nothing changed.`));
          return 0;
        });
      }
      return run(async (a) => {
        const r = await allRows(a, "devices", member ? { member } : {});
        print(r.rows, (rows) => {
          if (!rows.length) out("No devices.");
          for (const d of rows) out(`${show(d.name ?? d.member)}\t${d.device}\t${show(d.fingerprint)}\tenrolled ${iso(d.enrolled)}${d.revoked ? `\trevoked ${iso(d.revoked.at)} by ${d.revoked.by}` : ""}${d.suspended && !d.revoked ? "\tSUSPENDED" : ""}\tKeyPackages ${d.keyPackages.available} available, ${d.keyPackages.reserved} reserved, ${d.keyPackages.burned} burned`);
        });
        return 0;
      });
    }
    case "policy":
      return run(async (a) => {
        if (rest[0] === "check") {
          if (!rest[1] || !rest[2]) throw new AdminError("bad_request", "usage: hoptell relay admin policy check <from> <to>");
          const r = await a.call("policy_check", { from: rest[1], to: rest[2] });
          print(r, () => out(`${r.action}: ${r.rule === "default" ? "the policy's default" : r.rule === "no policy" ? "no policy file" : `rule ${r.rule} (${show(r.from)} -> ${show(r.to)})`} (a static check by member ids${r.certain ? "" : "; a signed-in session's provider groups can match other rules"})`));
          return 0;
        }
        const r = await a.call("policy");
        print(r, () => {
          out(`policy file: ${show(r.file)}${r.revision ? ` (revision ${r.revision})` : ""}; file check: ${show(r.fileResult)}`);
          if (r.loaded) {
            out(`in force: default ${r.loaded.defaultAction}, ${r.loaded.rules.length} rule(s), ${Object.keys(r.loaded.groups).length} group(s)${r.loaded.requireGrants ? ", grants required" : ""}`);
            r.loaded.rules.forEach((x, i) => out(`  ${i}: ${x.action} ${show(x.from)} -> ${show(x.to)}`));
          } else out(r.error ? `not loaded: ${show(r.error)}` : "no policy in force");
        });
        return 0;
      });
    case "grants":
      return run(async (a) => {
        if (args.includes("--entries")) {
          if (!member) throw new AdminError("bad_request", "grants --entries needs --member <name> (each read is recorded in the audit log)");
          const r = await a.call("grants_entries", { member });
          print(r, () => {
            out(`${show(member)}: revision ${r.revision} (this read is recorded in the audit log)`);
            if (!r.entries.length) out("  (no entries)");
            for (const e of r.entries) out(`  ${e.action.padEnd(5)} ${show(e.selector)}${e.until ? ` until ${iso(e.until)}` : ""}${e.requests === "blocked" ? " (no contact requests)" : ""}`);
          });
          return 0;
        }
        const r = await allRows(a, "grants", member ? { member } : {});
        print(r.rows, (rows) => {
          if (!rows.length) out("No member published grants.");
          for (const g of rows) out(`${show(g.name ?? g.member)}\tdefault ${show(g.default)}\tvisible ${show(g.visible)}\t${g.entries} entries\trevision ${g.revision}\tupdated ${iso(g.updated)}${g.pending ? "\tPENDING re-publication after a restore (held)" : ""}`);
        });
        return 0;
      });
    case "revocations":
      return run(async (a) => {
        const r = await allRows(a, "revocations", { since: parseSince(opt("--since")) });
        print(r.rows, (rows) => {
          if (!rows.length) out("No revocations.");
          for (const x of rows) out(`${iso(x.at)}\t${x.kind}\t${show(x.name ?? x.member)}${x.device ? `\t${x.device}` : ""}\tby ${show(x.actor)}${x.why ? ` (${show(x.why)})` : ""}`);
        });
        return 0;
      });
    case "metrics":
    case "store":
      return run(async (a) => {
        const r = await a.call(sub);
        out(JSON.stringify(r, null, 2));
        return 0;
      });
    case "checkpoint":
      return run(async (a) => {
        const r = await a.call("checkpoint");
        print(r, () => out(`Checkpoint ${r.result}${r.pages !== null ? `: ${r.pages} page(s) written` : ""}.`));
        return 0;
      });
    case "backup": {
      if (!rest[0]) throw new AdminError("bad_request", "usage: hoptell relay admin backup <dir> [--pages <n>]");
      const pages = opt("--pages") === undefined ? undefined : Number(opt("--pages"));
      return run(async (a) => {
        const r = await a.call("backup", { dir: path.resolve(rest[0]), ...(pages !== undefined ? { pages } : {}) });
        print(r, () => {
          out(`Backed up to ${r.dir}: ${r.bytes} bytes of store, ${r.files} file(s), verified; ${r.steps} step(s) of ${r.pages} pages, the longest ${r.maxStepMs} ms.`);
          if (r.warning) out(`warning: a step took over 1 s (${r.maxStepMs} ms); the copy is valid, but consider --pages ${Math.max(16, Math.floor(r.pages / 2))}`);
          if (r.auditMissing) out("warning: audit record missing (the backup is complete)");
          out("The folder holds the members file's token digests: keep it private.");
        });
        return 0;
      });
    }
    case "restore": {
      const { runRestore } = await import("./restore.js");
      const discard = opt("--discard-evidence");
      if (discard) {
        return run(async (a) => {
          const r = await a.call("discard_evidence", { id: discard });
          print(r, () => out(`Removed the evidence of restore ${r.id} (${r.bytes} bytes); recorded in the audit log.`));
          return 0;
        });
      }
      const mode = args.includes("--resume") ? "resume" : args.includes("--abort") ? "abort" : "start";
      if (mode === "start" && !rest[0]) throw new AdminError("bad_request", "usage: hoptell relay admin restore <dir> | --resume | --abort | --discard-evidence <id>");
      try {
        await adminRequest(stateDir, "status", {}, { timeoutMs: 10_000 });
        throw new AdminError("running", "the relay is running: restore runs only while it is stopped");
      } catch (e) {
        if (!(e instanceof AdminError) || e.code !== "not_running") throw e;
      }
      const r = await runRestore({ stateDir, mode, backupDir: rest[0] ? path.resolve(rest[0]) : null, membersFile: config.members ?? null, fault: testFault });
      print(r, () => {
        if (r.aborted) return out(`Restore ${r.id} aborted: the state directory is as it was before it.`);
        const c = r.counts;
        out(`Restore ${r.id} complete. The store has a new instance id (${show(c.new_instance)}); clients re-read everything.`);
        out(`- device revocations merged from the replaced store: ${c.revocations_merged}${c.devices_suspended ? `; ${c.devices_suspended} device(s) SUSPENDED (the replaced store was unreadable): reinstate each after checking with its member (hoptell relay admin devices reinstate), or the member enrolls a new device` : ""}`);
        out(`- KeyPackages cleared: ${c.key_packages_cleared}, reservations: ${c.reservations_cleared} (devices replenish)`);
        out(`- audit rows carried over: ${c.audit_copied}${c.audit_rechained ? ` (re-anchored: ${c.audit_rechained})` : ""}`);
        if (c.conversations_replace_required || c.e2ee_queue_lost) out(`- encrypted conversations to replace: ${c.conversations_replace_required} (their next commit is refused until a member device replaces the group); encrypted messages accepted after the backup and lost: ${c.e2ee_queue_lost}`);
        out(c.access === "kept" ? "- access state kept as it is now (no grant, deny or used allowance rolled back)" : `- access state was lost: ${c.members_pending} member(s) PENDING: messages to each are held until it publishes its grants again; ${c.claim_views_stale} sign-in view(s) stale until the next sign-in`);
        out(`- broker sign-ins ended: ${c.broker_families} (users run hoptell login again)`);
        out(`The replaced state is kept in ${path.join(stateDir, "restore", r.id, "before")} (remove it with restore --discard-evidence ${r.id}).`);
        out("The members, policy and OIDC files were not written. Copying a backup's members file back can restore a removed member's credential.");
      });
      return 0;
    }
    case "audit":
      return run(async (a) => {
        const r = await allRows(a, "audit", { since: parseSince(opt("--since")) });
        print(r, () => {
          for (const x of r.rows) out(`${x.seq}\t${iso(x.time)}\t${show(x.actor)}\t${x.action}\t${show(x.target)}\t${x.state}${x.result ? `\t${x.result}` : ""}${Object.keys(x.detail).length ? `\t${show(JSON.stringify(x.detail))}` : ""}`);
          if (!r.rows.length) out("No audit rows.");
          if (r.chain) out(r.chain.ok ? `hash chain verified: ${r.chain.rows} row(s) from ${r.chain.from ? `the anchor at seq ${r.chain.from}` : "the start"}` : `HASH CHAIN BROKEN at seq ${r.chain.brokenAt}: a row was changed outside hoptell`);
        });
        return 0;
      });
    case "reload":
      return run(async (a) => {
        if (!a.online) throw new AdminError("not_running", "the relay is not running; it reads its files when it starts");
        const r = await a.call("reload");
        print(r, () => {
          if (r.members) out(r.members.ok ? `members: applied (${r.members.count}; ${r.members.added} added, ${r.members.removed} removed, ${r.members.changed} changed)` : `members: ${r.members.applied ? "applied, but" : "refused, the previous list stays:"} ${show(r.members.error)}`);
          if (r.policy) out(r.policy.ok ? `policy: applied (revision ${r.policy.revision})` : `policy: refused, the previous policy stays: ${show(r.policy.error)}`);
          out(`oidc: ${r.oidc}`);
        });
        return r.members?.ok === false || r.policy?.ok === false ? 1 : 0;
      });
    case "ui": {
      const { startAdminUi } = await import("./adminui.js");
      const port = opt("--port") === undefined ? 0 : Number(opt("--port"));
      const ui = await startAdminUi({ stateDir, port });
      out(`The relay admin UI (read only) is at ${ui.launchUrl()}`);
      out("Open that address in a browser on this machine within a minute; the link works once. Stop with Ctrl-C.");
      await new Promise(() => {}); // until interrupted
      return 0;
    }
    default:
      out(USAGE);
      return sub && sub !== "help" ? 2 : 0;
  }
}
