// The owner's commands for larger transfers (design 6), EXPERIMENTAL: `hoptell transfers` (what is
// staged, fetching or waiting, by local id, with relay_expires), `hoptell transfers cancel <t_id>`,
// `hoptell save <t_id> <path> [--overwrite] [--yes]`, `hoptell save --forget <t_id>`, and the
// transfer part of `hoptell doctor` (interrupted saves are recovered; leftovers are reported and,
// with --fix, removed). Names and labels from peers are shown quoted, never used as paths.
import fs from "node:fs";
import path from "node:path";
import { contactsFile, readContacts } from "./contacts.js";
import { createStaging, incomingDir } from "./transferin.js";
import { OUTBOX_LIFETIME_MS, outgoingDir } from "./transferout.js";
import { SaveError, forgetSave, listJournals, recoverSave, resolveDestination, saveTransfer } from "./transfersave.js";
import { plural } from "./words.js";

// eslint-disable-next-line no-control-regex -- removing control characters is the point
const shown = (s) => JSON.stringify(String(s ?? "").replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, "").slice(0, 255));
const when = (t) => (Number.isSafeInteger(t) ? new Date(t).toISOString() : "unknown");
const stagingOf = (home) => createStaging({ home, contacts: () => readContacts(contactsFile(home)).doc });

/** `hoptell transfers [cancel <t_id>]`; returns the exit code. */
export async function transfersCommand({ args, home, out = console.log, err = console.error }) {
  // A usage error goes to stderr and is said before anything is opened.
  if (args[0] === "cancel" && args.length !== 2) {
    err("hoptell: transfers cancel needs one <t_id>\nusage: hoptell transfers cancel <t_id>");
    return 2;
  }
  if (args.length && args[0] !== "cancel") {
    err(`hoptell: unknown transfers command ${JSON.stringify(String(args[0]).slice(0, 40))} (see hoptell transfers --help)`);
    return 2;
  }
  const staging = stagingOf(home);
  if (args[0] === "cancel") {
    try {
      const r = await staging.cancel(args[1]);
      out(r.state === "removed" ? `${args[1]}: cancelled and deleted on this device (the sender's copy at the relay is not affected).` : `${args[1]}: cancelling; the download stops at its next chunk.`);
      return 0;
    } catch (e) {
      err(`hoptell: ${e.message}`);
      return 1;
    }
  }
  const list = staging.list().filter((e) => e.state !== "removed");
  if (!list.length) out("No transfers are waiting for you.");
  for (const e of list) {
    const what = e.kind === "review_set" ? "review set" : "file";
    out(`${e.t}  ${e.state}  ${what} from ${shown(e.from?.session)} (member ${e.from?.member})  ${e.bytes} bytes  label ${shown(e.name)}`);
    out(`    relay copy expires ${when(e.relay_expires)}`);
    if (e.state === "staged") out(`    staged here ${when(e.staged_at)}; cleaned up after 7 days unless saved`);
    if (e.error) out(`    problem: ${e.error}`);
  }
  if (list.some((e) => e.state === "staged" && e.kind === "file")) out("Next: hoptell save <t_id> <path>   (or hoptell transfers cancel <t_id>)");
  const recent = staging.list().filter((e) => e.state === "removed" && e.error).slice(0, 5);
  for (const e of recent) out(`${e.t}  removed: ${e.error}`);
  return 0;
}

/**
 * `hoptell save <t_id> <path> [--overwrite] [--yes]` | `hoptell save --forget <t_id>`; returns the
 * exit code. `confirm(question)` asks the owner (a terminal); without one, --overwrite needs --yes.
 */
export async function saveCommand({ args, home, out = console.log, err = console.error, confirm = null }) {
  const flags = args.filter((a) => a.startsWith("--"));
  const rest = args.filter((a) => !a.startsWith("--"));
  const usage = (cause) => (err(`hoptell: ${cause}\nusage: hoptell save <t_id> <path> [--overwrite] [--yes]\n       hoptell save --forget <t_id>`), 2);
  const bad = flags.find((f) => !["--overwrite", "--yes", "--forget"].includes(f));
  if (bad) return usage(`unknown option ${bad} for hoptell save`);
  const staging = stagingOf(home);
  try {
    if (flags.includes("--forget")) {
      if (rest.length !== 1 || flags.length !== 1) return usage("save --forget takes one <t_id> and no other option");
      forgetSave({ home, staging, t: rest[0] });
      out(`The save record of ${rest[0]} was dropped; no file was deleted.`);
      return 0;
    }
    if (rest.length !== 2) return usage("save needs a <t_id> and a <path>");
    const [t, dest] = rest;
    const overwrite = flags.includes("--overwrite");
    const yes = flags.includes("--yes");
    const target = resolveDestination(dest);
    out(`Saving ${t} to ${target.dest}`);
    if (overwrite && target.existing && !yes && !confirm) {
      err("hoptell: --overwrite replaces an existing file: run this in a terminal to confirm, or add --yes; nothing was saved");
      return 1;
    }
    const r = await saveTransfer({
      home,
      staging,
      t,
      destination: dest,
      overwrite,
      yes,
      confirm: async ({ dest: d, existing }) => confirm(`${d} exists (${plural(existing.size, "byte")}). Replace it? Type yes to replace it, anything else cancels: `),
    });
    if (r.state === "replaced_unconfirmed") {
      err(`hoptell: ${r.message}`);
      return 1;
    }
    out(`Saved ${r.bytes} bytes to ${r.dest}; the staging copy was deleted.`);
    return 0;
  } catch (e) {
    if (e instanceof SaveError || e.code === "unknown") {
      err(`hoptell: ${e.message}`);
      return 1;
    }
    throw e;
  }
}

/**
 * The transfer part of hoptell doctor: interrupted saves are recovered (their algorithm never
 * deletes what it cannot prove it created); the staging ledger, failed cleanups, old staged files
 * and old outbox entries are reported, and with `fix` removed. `line(level, area, text)`.
 */
export async function transfersDoctor({ home, fix = false, line, now = () => Date.now() }) {
  const staging = createStaging({ home, contacts: () => readContacts(contactsFile(home)).doc, now });
  let problems = 0;
  for (const j of listJournals(home)) {
    const r = await recoverSave({ home, staging, t: j.t }).catch((e) => ({ state: "attention", message: e.message }));
    const level = r.state === "saved" || r.state === "forgotten" || r.state === "none" ? "ok" : r.state === "not_completed" ? "warn" : "FAIL";
    if (level === "FAIL") problems++;
    line(level, "transfers", r.message);
  }
  if (!fs.existsSync(incomingDir(home)) && !fs.existsSync(outgoingDir(home))) return problems;
  let ledger;
  try {
    ledger = staging.readLedger();
  } catch (e) {
    line("FAIL", "transfers", e.message);
    return problems + 1;
  }
  const entries = Object.values(ledger.entries);
  const live = entries.filter((e) => ["reserved", "staged", "saved"].includes(e.state));
  const stuck = entries.filter((e) => e.error && e.state !== "removed");
  const old = live.filter((e) => e.state === "staged" && now() - e.staged_at >= 7 * 86_400_000);
  let strays = [];
  try {
    strays = fs.readdirSync(incomingDir(home), { withFileTypes: true }).filter((d) => d.isDirectory() && /^t_[0-9a-f]{24}$/.test(d.name) && !live.some((e) => e.t === d.name)).map((d) => d.name);
  } catch {}
  const missing = live.filter((e) => !fs.existsSync(path.join(incomingDir(home), e.t)));
  let outbox = [];
  try {
    outbox = fs.readdirSync(outgoingDir(home)).filter((n) => /^o_[0-9a-f]{24}$/.test(n));
  } catch {}
  const created = (n) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(outgoingDir(home), n, "state.json"), "utf8")).created ?? 0;
    } catch {
      return 0;
    }
  };
  const staleOutbox = outbox.filter((n) => now() - created(n) >= OUTBOX_LIFETIME_MS);
  line("info", "transfers", `${live.filter((e) => e.state === "staged").length} staged, ${live.filter((e) => e.state === "reserved").length} fetching, ${plural(live.reduce((n, e) => n + e.bytes, 0), "byte")} charged; ${plural(outbox.length, "upload")} in the outbox`);
  const leftovers = stuck.length + old.length + strays.length + missing.length + staleOutbox.length;
  if (!leftovers) return problems;
  if (!fix) {
    line("warn", "transfers", `leftovers: ${plural(stuck.length, "failed cleanup")}, ${plural(old.length, "staged file")} older than 7 days, ${plural(strays.length, "folder")} without a ledger entry, ${plural(missing.length, "entry", "entries")} without a folder, ${plural(staleOutbox.length, "outbox entry", "outbox entries")} older than 24 hours; run hoptell doctor --fix to remove them`);
    return problems;
  }
  const r = await staging.reconcile();
  let removed = 0;
  for (const e of [...stuck, ...old]) {
    const release = staging.saveLock(e.t);
    if (typeof release !== "function") continue;
    try {
      if (await staging.remove(e.t, e.error ?? "not saved within 7 days")) removed++;
    } finally {
      release();
    }
  }
  for (const n of staleOutbox) fs.rmSync(path.join(outgoingDir(home), n), { recursive: true, force: true });
  line("ok", "transfers", `removed ${plural(removed, "staged leftover")}, ${plural(r.foldersDeleted, "stray folder")}, ${plural(r.entriesRemoved, "entry", "entries")} without a folder and ${plural(staleOutbox.length, "old outbox entry", "old outbox entries")}`);
  return problems;
}
