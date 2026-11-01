// Stable names, the client side (design 10, section 5): the start rule and the local records
// (lib/names.js), the relay client's continue, recovery and overlap wait, and new clients on an
// old relay or a relay rolled back to one without name tickets.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { startRelay } from "../lib/relay.js";
import { RelayClient } from "../lib/client.js";
import { ROOT } from "../lib/config.js";
import { appendSessionEvent, readSessionEvents } from "../lib/sessionevents.js";
import { ALIASES_MAX, bindName, decideStart, entryFile, linkSession, nameFile, pruneNames, publishTicket, readEntry, readName, touchName } from "../lib/names.js";
import { withLock, writeRecord } from "../lib/locks.js";
import { fakeToken, sleep } from "./helpers.js";

const T1 = "A".repeat(43);
const T2 = "B".repeat(43);
const P = "profile-1";
const SC = { realm: "r_realm", member: "m_alice" };

const tmp = (t) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "hoptell-names-"));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};
/** A session events log with the events `list` ([session_id, source]), read back as a set. */
const events = (t, list) => {
  const dir = tmp(t);
  for (const [session_id, source] of list) appendSessionEvent(dir, "k", { session_id, source });
  return readSessionEvents(dir, "k");
};
async function until(fn, ms = 10_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(50);
  }
  return false;
}

// ---- the start rule and the records -----------------------------------------------------------

test("start rule: a new conversation binds, the same one continues, clear and compact follow it", async (t) => {
  const home = tmp(t);
  assert.deepEqual(decideStart(home, P, { state: "none" }).kind, "off");
  assert.equal(decideStart(home, P, { state: "full" }).kind, "off");
  assert.equal(decideStart(home, P, { state: "unreadable" }).kind, "off");
  const first = events(t, [["s1", "startup"]]);
  assert.deepEqual(decideStart(home, P, first, SC), { kind: "bind", ids: ["s1"] });
  assert.equal(await bindName(home, P, "alice-pc-1", T1, ["s1"], { scope: SC }), "bound");
  assert.deepEqual(decideStart(home, P, first, SC), { kind: "continue", name: "alice-pc-1", ticket: T1, ids: [] });
  // The record is used only for the realm and member it was kept for.
  for (const other of [null, { ...SC, member: "m_bob" }, { ...SC, member: null }, { ...SC, realm: "r_other" }]) assert.match(decideStart(home, P, first, other).reason, /another account/, JSON.stringify(other));
  // /clear and compaction start new ids from the same conversation: still that name, in either order.
  for (const order of [
    [["s1", "startup"], ["s2", "clear"], ["s3", "compact"]],
    [["s3", "compact"], ["s2", "clear"], ["s1", "startup"]],
  ]) {
    const d = decideStart(home, P, events(t, order), SC);
    assert.equal(d.kind, "continue");
    assert.deepEqual(d.ids.sort(), ["s2", "s3"]);
  }
  // Another profile sees nothing; a name record that is gone turns it off.
  assert.equal(decideStart(home, "other", first, SC).kind, "bind");
  fs.rmSync(nameFile(home, P, "alice-pc-1"));
  assert.equal(decideStart(home, P, first, SC).kind, "off");
});

test("start rule: anything unclear is off (a resume or branch, two names, two new conversations)", async (t) => {
  const home = tmp(t);
  await bindName(home, P, "n-one", T1, ["s1"], { scope: SC });
  await bindName(home, P, "n-two", T2, ["s2"], { scope: SC });
  const off = (list) => decideStart(home, P, events(t, list), SC);
  assert.match(off([["s1", "startup"], ["r9", "resume"]]).reason, /switched conversations/);
  assert.match(off([["r9", "resume"], ["s1", "startup"]]).reason, /switched conversations/, "the order does not matter");
  assert.match(off([["s1", "startup"], ["s2", "resume"]]).reason, /different names/);
  assert.match(off([["x1", "startup"], ["x2", "resume"]]).reason, /more than one conversation/);
  assert.match(off([["c1", "clear"]]).reason, /more than one conversation/, "a clear id alone has no origin");
  // A resumed conversation that already has a name continues it.
  assert.equal(off([["s2", "resume"]]).kind, "continue");
});

test("records: a ticket changes only from the one read, entries are never re-pointed, unsafe files are left", async (t) => {
  const home = tmp(t);
  assert.equal(await publishTicket(home, P, "n", { expect: null, ticket: T1, scope: SC }), "written");
  assert.equal(await publishTicket(home, P, "n", { expect: null, ticket: T2, scope: SC }), "changed");
  assert.equal(await publishTicket(home, P, "n", { expect: T1, ticket: T2, scope: { ...SC, member: "m_bob" } }), "changed", "another member's record");
  assert.deepEqual(readName(home, P, "n"), { name: "n", ticket: T1, ...SC });
  // Two recoveries of the same old ticket at once: exactly one replaces it.
  const both = await Promise.all([publishTicket(home, P, "n", { expect: T1, ticket: T2, scope: SC }), publishTicket(home, P, "n", { expect: T1, ticket: "C".repeat(43), scope: SC })]);
  assert.deepEqual(both.sort(), ["changed", "written"]);
  assert.notEqual(readName(home, P, "n").ticket, T1);
  await assert.rejects(publishTicket(home, P, "n", { ticket: "short", scope: SC }), /bad name ticket/);
  await assert.rejects(publishTicket(home, P, "n", { ticket: T1 }), /bad name ticket/, "no scope");
  assert.equal(await linkSession(home, P, "s1", "n", { scope: SC }), "created");
  assert.equal(await linkSession(home, P, "s1", "n", { scope: SC }), "same");
  await publishTicket(home, P, "m", { ticket: T2, scope: SC });
  assert.equal(await linkSession(home, P, "s1", "m", { scope: SC }), "other");
  assert.deepEqual(readEntry(home, P, "s1"), { name: "n", ...SC });
  assert.equal(await linkSession(home, P, "s2", "n", { scope: { ...SC, member: "m_bob" } }), "changed", "not into another scope's name");
  // A conflicting entry stops a bind; what was written stays.
  await linkSession(home, P, "s9", "m", { scope: SC });
  assert.equal(await bindName(home, P, "fresh", T1, ["s8", "s9", "s7"], { scope: SC }), "other");
  assert.equal(readEntry(home, P, "s8").name, "fresh");
  assert.equal(readEntry(home, P, "s7"), null, "nothing after the conflict");
  // A bind that is no longer allowed stops before its next write.
  let writes = 3; // the name record, then l1's alias and entry
  assert.equal(await bindName(home, P, "late", T1, ["l1", "l2", "l3"], { scope: SC, allowed: () => writes-- > 0 }), "stopped");
  assert.equal(readEntry(home, P, "l1").name, "late");
  assert.equal(readEntry(home, P, "l2"), null);
  // An unreadable name record is never replaced.
  fs.writeFileSync(nameFile(home, P, "bad"), "not json", { mode: 0o600 });
  assert.equal(await publishTicket(home, P, "bad", { ticket: T1, scope: SC }), "changed");
  assert.equal(fs.readFileSync(nameFile(home, P, "bad"), "utf8"), "not json");
  assert.equal(fs.statSync(path.join(home, "names")).mode & 0o777, 0o700);
  assert.equal(fs.statSync(nameFile(home, P, "n")).mode & 0o777, 0o600);
});

test("records: a name reused after an account change: the bind goes off, the old conversation does not continue", async (t) => {
  const home = tmp(t);
  const A = SC;
  const B = { ...SC, member: "m_bob" };
  assert.equal(await bindName(home, P, "n", T1, ["old-A"], { scope: A }), "bound");
  // The same profile now authenticates as another member, and the relay gives the same name again.
  assert.equal(await bindName(home, P, "n", T2, ["new-B"], { scope: B }), "other");
  assert.deepEqual(readName(home, P, "n"), { name: "n", ticket: T1, ...A }, "A's record is left as it was");
  assert.equal(readEntry(home, P, "new-B"), null);
  assert.match(decideStart(home, P, events(t, [["old-A", "startup"]]), B).reason, /another account/);
  assert.equal(decideStart(home, P, events(t, [["old-A", "startup"]]), A).kind, "continue");
  // An entry of another scope is never followed, even to a name of this scope.
  await bindName(home, P, "nb", T2, ["sb"], { scope: B });
  writeRecord(entryFile(home, P, "mixed"), { v: 1, profile: P, ...A, name: "nb", used: Date.now() });
  assert.match(decideStart(home, P, events(t, [["mixed", "startup"]]), B).reason, /another account/);
});

test("records: every write checks that it is still allowed inside its lock, after any wait", async (t) => {
  const home = tmp(t);
  const hold = (file, ms) => withLock(file, () => sleep(ms));
  const flip = () => {
    let ok = true;
    setTimeout(() => (ok = false), 100);
    return () => ok;
  };
  fs.mkdirSync(path.join(home, "names"), { mode: 0o700 });
  // The name record: published only if still allowed once the lock is taken.
  let held = hold(nameFile(home, P, "n"), 400);
  assert.equal(await publishTicket(home, P, "n", { ticket: T1, scope: SC, allowed: flip() }), "stopped");
  await held;
  assert.equal(readName(home, P, "n"), null);
  assert.equal(await bindName(home, P, "n", T1, [], { scope: SC }), "bound");
  // A session entry: not created (and the bind does not say bound).
  held = hold(entryFile(home, P, "s1"), 400);
  assert.equal(await bindName(home, P, "n", T2, ["s1"], { scope: SC, allowed: flip() }), "stopped");
  await held;
  assert.equal(readEntry(home, P, "s1"), null);
  // A recovery and a touch.
  held = hold(nameFile(home, P, "n"), 400);
  assert.equal(await publishTicket(home, P, "n", { expect: T2, ticket: T1, scope: SC, allowed: flip() }), "stopped");
  await held;
  assert.equal(readName(home, P, "n").ticket, T2);
  const before = JSON.parse(fs.readFileSync(nameFile(home, P, "n"), "utf8")).used;
  held = hold(nameFile(home, P, "n"), 400);
  await touchName(home, P, "n", { scope: SC, allowed: flip(), now: before + 1000 });
  await held;
  assert.equal(JSON.parse(fs.readFileSync(nameFile(home, P, "n"), "utf8")).used, before);
});

test("records: the expiry prune removes only unused records; a holder's touch keeps its name and every alias", async (t) => {
  const home = tmp(t);
  const day = 86_400_000;
  const now = Date.now();
  await bindName(home, P, "old", T1, ["s-old"], { scope: SC });
  await bindName(home, P, "kept", T2, ["s-kept"], { scope: SC });
  // Aliases from earlier processes (older conversations /clear started), not in this process's log.
  for (const id of ["s-alias-1", "s-alias-2"]) await linkSession(home, P, id, "kept", { scope: SC });
  // Thousands of unrelated records, and an alias whose file sorts after all of them.
  const dir = path.join(home, "names");
  for (let i = 0; i < 4096; i++) fs.writeFileSync(path.join(dir, `S-${String(i).padStart(40, "0")}.json`), "{}", { mode: 0o600 });
  let late = null;
  for (let i = 0; !late; i++) if (path.basename(entryFile(home, P, `late-${i}`)) > "S-f") late = `late-${i}`;
  await linkSession(home, P, late, "kept", { scope: SC });
  for (const f of fs.readdirSync(dir).filter((n) => /^[NS]-[0-9a-f]{40}\.json$/.test(n))) {
    const file = path.join(dir, f);
    const r = JSON.parse(fs.readFileSync(file, "utf8"));
    if (r.v) writeRecord(file, { ...r, used: now - 8 * day });
  }
  await touchName(home, P, "kept", { scope: SC, now });
  for (const id of ["s-kept", "s-alias-1", "s-alias-2", late]) assert.equal(JSON.parse(fs.readFileSync(entryFile(home, P, id), "utf8")).used, now, id);
  for (const f of fs.readdirSync(dir).filter((n) => n.startsWith("S-0"))) fs.rmSync(path.join(dir, f));
  await pruneNames(home, { now });
  await pruneNames(home, { now });
  assert.equal(fs.existsSync(nameFile(home, P, "old")), false);
  assert.equal(fs.existsSync(entryFile(home, P, "s-old")), false);
  assert.equal(readName(home, P, "kept").ticket, T2);
  for (const id of ["s-kept", "s-alias-1", "s-alias-2", late]) assert.equal(readEntry(home, P, id).name, "kept", id);
});

test("records: a name links at most ALIASES_MAX conversations", async (t) => {
  const home = tmp(t);
  await bindName(home, P, "n", T1, [], { scope: SC });
  for (let i = 0; i < ALIASES_MAX; i++) assert.equal(await linkSession(home, P, `s${i}`, "n", { scope: SC }), "created");
  assert.equal(await linkSession(home, P, "one-more", "n", { scope: SC }), "full");
  assert.equal(readEntry(home, P, "one-more"), null);
  assert.equal(await linkSession(home, P, "s0", "n", { scope: SC }), "same");
});

test("records: the prune rotates, so every record is visited within a few calls", async (t) => {
  const home = tmp(t);
  const day = 86_400_000;
  const now = Date.now();
  const raw = (id, used) => {
    fs.mkdirSync(path.join(home, "names"), { recursive: true, mode: 0o700 });
    writeRecord(entryFile(home, P, id), { v: 1, profile: P, ...SC, name: "n", used });
  };
  for (let i = 0; i < 70; i++) raw(`fresh-${i}`, now);
  // The expired record sorts last (after the first 64 every time without rotation).
  let expired = null;
  for (let i = 0; !expired; i++) {
    const f = entryFile(home, P, `x${i}`);
    const others = fs.readdirSync(path.join(home, "names")).sort();
    if (path.basename(f) > others.at(-1)) expired = `x${i}`;
  }
  raw(expired, now - 8 * day);
  for (let i = 0; i < 3 && fs.existsSync(entryFile(home, P, expired)); i++) await pruneNames(home, { now });
  assert.equal(fs.existsSync(entryFile(home, P, expired)), false);
  assert.equal(fs.readdirSync(path.join(home, "names")).length, 70);
});

// ---- the relay client -------------------------------------------------------------------------

async function relayAt(t, opts = {}, start = startRelay) {
  const token = opts.token ?? fakeToken();
  const relay = await start({ host: "127.0.0.1", port: 0, members: [{ name: "alice", token }], ...opts, token: fakeToken() });
  t.after(() => relay.close());
  return { relay, token, url: `ws://127.0.0.1:${relay.port}` };
}
const clientOf = (t, url, token, plan, opts = {}) => {
  const c = new RelayClient({ url, token, name: null, nameCheckMs: [100, 200], ...opts });
  c.setStable(plan);
  const offs = [];
  c.on("stable", (e) => offs.push(e));
  c.offs = offs;
  t.after(() => c.close());
  return c;
};

test("client: a new automatic name gets a ticket; the next server continues it", async (t) => {
  const { url, token } = await relayAt(t);
  const a = clientOf(t, url, token, { want: true });
  await a.start().ready();
  assert.equal(a.welcomeStable.phase, "bind");
  const ticket = a.welcomeStable.ticket;
  assert.match(ticket, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(a.ticketHeld, ticket);
  const name = a.name;
  a.close();
  // An ordinary automatic name never gets the protected one.
  const other = clientOf(t, url, token, null);
  await other.start().ready();
  assert.notEqual(other.name, name);
  const b = clientOf(t, url, token, { continue: { name, ticket } });
  await b.start().ready();
  assert.equal(b.name, name);
  assert.deepEqual(b.welcomeStable, { phase: "continue", recovered: null, ticket: null, limit: false });
  assert.equal(b.ticketHeld, ticket);
  assert.deepEqual(b.offs, []);
});

test("client: an unknown ticket recovers the name once with a new ticket; a taken name goes off", async (t) => {
  const { url, token } = await relayAt(t);
  const a = clientOf(t, url, token, { continue: { name: "alice-kept", ticket: T1 } });
  await a.start().ready();
  assert.equal(a.name, "alice-kept");
  assert.equal(a.welcomeStable.phase, "recover");
  assert.deepEqual(a.welcomeStable.recovered, { name: "alice-kept", ticket: T1 });
  assert.match(a.welcomeStable.ticket, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(a.ticketHeld, T1);
  // Another connection holds the name (no ticket): the recovery is refused, the session goes on
  // with an automatic name and says why once.
  const holder = new RelayClient({ url, token, name: "alice-held", reconnect: false });
  await holder.start().ready();
  t.after(() => holder.close());
  const b = clientOf(t, url, token, { continue: { name: "alice-held", ticket: T2 } });
  await b.start().ready();
  assert.notEqual(b.name, "alice-held");
  assert.equal(b.offs.length, 1);
  assert.match(b.offs[0].reason, /another session has the earlier name/);
  assert.equal(b.offs[0].previous, "alice-held");
  assert.equal(b.ticketHeld, null);
});

test("client: two servers recovering the same name at once: one gets it, the other goes off", async (t) => {
  const { url, token } = await relayAt(t);
  const a = clientOf(t, url, token, { continue: { name: "alice-twin", ticket: T1 } });
  const b = clientOf(t, url, token, { continue: { name: "alice-twin", ticket: T1 } });
  await Promise.all([a.start().ready(), b.start().ready()]);
  const names = [a.name, b.name];
  assert.equal(names.filter((n) => n === "alice-twin").length, 1);
  assert.equal(a.offs.length + b.offs.length, 1);
});

test("client: the overlap wait gets the name when the old server leaves, else goes off after it", async (t) => {
  const { url, token } = await relayAt(t);
  const a = clientOf(t, url, token, { want: true });
  await a.start().ready();
  const kept = { name: a.name, ticket: a.ticketHeld };
  const b = clientOf(t, url, token, { continue: kept }, { overlapMs: 5000 });
  b.start();
  await sleep(600);
  assert.equal(b.connected, false, "it waits while the earlier server holds the name");
  a.close(); // a clean exit gives the name back
  assert.ok(await until(() => b.connected));
  assert.equal(b.name, kept.name);
  assert.deepEqual(b.offs, []);
  // The holder never leaves: after the wait, an automatic name and a note.
  const c = clientOf(t, url, token, { continue: kept }, { overlapMs: 800 });
  const t0 = performance.now();
  await c.start().ready();
  assert.ok(performance.now() - t0 >= 700);
  assert.notEqual(c.name, kept.name);
  assert.equal(c.offs.length, 1);
  assert.match(c.offs[0].reason, /still in use by another session/);
});

test("client: a check that ends after the overlap deadline never continues the name (fake clock)", async (t) => {
  const { url, token } = await relayAt(t);
  const a = clientOf(t, url, token, { want: true });
  await a.start().ready();
  const kept = { name: a.name, ticket: a.ticketHeld };
  let offset = 0;
  const b = clientOf(t, url, token, { continue: kept }, { overlapMs: 20_000, clock: () => performance.now() + offset });
  const rpc = RelayClient.prototype.rpc;
  t.after(() => (RelayClient.prototype.rpc = rpc));
  RelayClient.prototype.rpc = async function (m, ...rest) {
    const r = await rpc.call(this, m, ...rest);
    if (m.type === "claim_status") offset = 28_500; // the check took until 28.5 s of a 20 s wait
    return r;
  };
  b.start();
  await sleep(150);
  a.close(); // the name is free by the time of the first check
  await b.ready();
  assert.notEqual(b.name, kept.name);
  assert.equal(b.offs.length, 1);
  assert.match(b.offs[0].reason, /still in use by another session/);
});

test("client: after relay restarts the name is recovered with a new ticket, each time", async (t) => {
  const token = fakeToken();
  let relay = await startRelay({ host: "127.0.0.1", port: 0, token: fakeToken(), members: [{ name: "alice", token }] });
  const port = relay.port;
  t.after(() => relay.close());
  const url = `ws://127.0.0.1:${port}`;
  const a = clientOf(t, url, token, { want: true });
  await a.start().ready();
  const name = a.name;
  let ticket = a.ticketHeld;
  for (let i = 0; i < 2; i++) {
    const welcomes = [];
    a.once("ready", () => welcomes.push(a.welcomeStable));
    await relay.close();
    relay = await startRelay({ host: "127.0.0.1", port, token: fakeToken(), members: [{ name: "alice", token }] });
    assert.ok(await until(() => welcomes.length === 1), `reconnected after restart ${i + 1}`);
    assert.equal(a.name, name);
    assert.equal(welcomes[0].phase, "recover");
    assert.equal(welcomes[0].recovered.ticket, ticket);
    assert.notEqual(a.ticketHeld, ticket);
    ticket = a.ticketHeld;
  }
  assert.deepEqual(a.offs, []);
});

test("client: a relay with no room for more tickets: an automatic name, not asked again", async (t) => {
  const { url, token } = await relayAt(t, { names: { ticketsPerPrincipal: 1 } });
  const a = clientOf(t, url, token, { want: true });
  await a.start().ready();
  assert.ok(a.ticketHeld);
  const b = clientOf(t, url, token, { want: true });
  await b.start().ready();
  assert.equal(b.welcomeStable.limit, true);
  assert.equal(b.ticketHeld, null);
  assert.equal(b.stable, null);
});

// ---- new clients on old relays ----------------------------------------------------------------

const BASELINE = "e6611b5"; // 0.3.2 on main, before name tickets

/** The relay of BASELINE (before name tickets) from the git history, or null when unavailable. */
async function oldRelay(t) {
  try {
    execFileSync("git", ["-C", ROOT, "cat-file", "-e", `${BASELINE}^{commit}`], { stdio: "ignore" });
  } catch {
    if (process.env.CI) assert.fail(`the ${BASELINE} baseline is not in the git history; CI checkouts need full history`);
    return null;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `hoptell-${BASELINE}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const tar = execFileSync("git", ["-C", ROOT, "archive", "--format=tar", BASELINE, "lib", "package.json"], { maxBuffer: 256 * 1024 * 1024 });
  execFileSync("tar", ["-x", "-C", dir], { input: tar });
  fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(dir, "node_modules"));
  return (await import(path.join(dir, "lib/relay.js"))).startRelay;
}

test("compatibility: a new client on an old relay gets no ticket and keeps today's names", async (t) => {
  const start = await oldRelay(t);
  if (!start) return t.skip(`the ${BASELINE} baseline is unavailable here`);
  const { url, token } = await relayAt(t, {}, start);
  const a = clientOf(t, url, token, { want: true });
  await a.start().ready();
  assert.ok(!a.caps.includes("name-ticket"));
  assert.deepEqual(a.welcomeStable, { phase: "bind", recovered: null, ticket: null, limit: false });
  assert.equal(a.ticketHeld, null);
  assert.equal(a.stable.want, true, "no continue is ever sent without a ticket");
});

test("compatibility: a relay rolled back to one without tickets: one fallback to an automatic name", async (t) => {
  const start = await oldRelay(t);
  if (!start) return t.skip(`the ${BASELINE} baseline is unavailable here`);
  const { url, token } = await relayAt(t, {}, start);
  const a = clientOf(t, url, token, { continue: { name: "alice-kept", ticket: T1 } });
  let downs = 0;
  a.on("down", () => downs++);
  await a.start().ready();
  assert.notEqual(a.name, "alice-kept");
  assert.equal(a.offs.length, 1);
  assert.match(a.offs[0].reason, /does not support kept names/);
  assert.ok(downs <= 1, `one fallback (${downs})`);
  assert.equal(a.connected, true);
});

// ---- the engine -------------------------------------------------------------------------------

test("engine: a restarted MCP server of the same conversation keeps its name; a resume elsewhere does not", async (t) => {
  const { createEngine } = await import("../lib/engine.js");
  const { readSettings } = await import("../lib/settings.js");
  const { ensureWakeDir } = await import("../lib/wake.js");
  const { hostKey, processIdentity } = await import("../lib/host.js");
  const { namesStatus } = await import("../lib/names.js");
  const { url, token } = await relayAt(t);
  const home = tmp(t);
  // This test process stands in for the Claude Code process; its parent for the pane's process.
  const host = { ...processIdentity(process.pid), args: "claude" };
  const root = processIdentity(process.ppid);
  const dir = ensureWakeDir(home);
  const key = hostKey(host);
  appendSessionEvent(dir, key, { session_id: "s1", source: "startup" });
  const run = async () => {
    const settings = readSettings({ env: { HOPTELL_RELAY: url, HOPTELL_TOKEN: token, HOPTELL_HOME: home, HOPTELL_PUSH: "listener", HOPTELL_NOTIFY: "off" }, homedir: "/nonexistent-home", pid: process.pid, hostname: "testhost" });
    const engine = createEngine(settings, { findHost: () => host, keepAlive: true, namesWaitMs: 300 });
    t.after(() => engine.stop());
    await engine.start();
    assert.ok(await until(() => engine.session.state === "bound"), "bound");
    return engine;
  };
  const text = async (engine) => (await engine.call("list_peers")).content.map((c) => c.text).join("\n");
  const first = await run();
  const name = first.session.name;
  assert.ok(await until(() => fs.readdirSync(path.join(home, "names")).length === 2), "a name record and an entry");
  assert.deepEqual(namesStatus(dir).map((s) => s.stable), ["on"]);
  assert.doesNotMatch(await text(first), /not kept/);
  await first.stop();
  // The same Claude Code process starts its MCP server again (/mcp reconnect, or a crash).
  appendSessionEvent(dir, key, { session_id: "s2", source: "clear" });
  const second = await run();
  assert.equal(second.session.name, name);
  assert.ok(await until(() => fs.readdirSync(path.join(home, "names")).length === 3), "the clear id points to the name too");
  await second.stop();
  // It switched to another conversation: today's behaviour, said once.
  appendSessionEvent(dir, key, { session_id: "r7", source: "resume" });
  const third = await run();
  assert.notEqual(third.session.name, name);
  assert.match(await text(third), /This session's name is not kept across restarts: this Claude Code process switched conversations/);
  assert.doesNotMatch(await text(third), /not kept/, "said once");
  assert.match(namesStatus(dir)[0].stable, /switched conversations/);
  await third.stop();
  // A session with a fixed name records its peer name for sessionEventsFor, and doctor leaves it out.
  const { sessionEventsFor } = await import("../lib/names.js");
  const fixedAt = Date.now();
  const settings = readSettings({ env: { HOPTELL_RELAY: url, HOPTELL_TOKEN: token, HOPTELL_HOME: home, HOPTELL_NAME: "alice-fixed", HOPTELL_PUSH: "listener", HOPTELL_NOTIFY: "off" }, homedir: "/nonexistent-home", pid: process.pid, hostname: "testhost" });
  const fixed = createEngine(settings, { findHost: () => host, keepAlive: true, namesWaitMs: 300 });
  t.after(() => fixed.stop());
  await fixed.start();
  assert.ok(await until(() => sessionEventsFor(home, "alice-fixed", { since: fixedAt, root }).state === "ok"));
  assert.deepEqual(sessionEventsFor(home, "alice-fixed", { since: fixedAt, root: { ...root, pid: root.pid + 1 } }), { state: "none" }, "another parent");
  assert.deepEqual(namesStatus(dir), []);
  const all = fs.readdirSync(path.join(home, "names")).map((f) => fs.readFileSync(path.join(home, "names", f), "utf8")).join("\n");
  assert.equal(all.split("ticket").length, 2, "one name record holds the only ticket");
});

test("sessionEventsFor: the events of the one process that ran a peer name since a time in a given parent, else none", async (t) => {
  const { writeNamesStatus, sessionEventsFor } = await import("../lib/names.js");
  const { ensureWakeDir } = await import("../lib/wake.js");
  const { writeRecord } = await import("../lib/locks.js");
  const home = tmp(t);
  const dir = ensureWakeDir(home);
  const K1 = "1".repeat(32);
  const K2 = "2".repeat(32);
  const since = Date.now() - 60_000;
  const ROOT = { pid: 4242, start: "Thu Oct 30 10:00:00 2026", uid: 501, boot: "b1" };
  appendSessionEvent(dir, K1, { session_id: "conv-1", source: "startup" });
  appendSessionEvent(dir, K2, { session_id: "conv-2", source: "startup" });
  assert.deepEqual(sessionEventsFor(home, "t5-impl-1", { since, root: ROOT }), { state: "none" }, "no record");
  writeNamesStatus(dir, K1, { peer: "t5-impl-1", parent: ROOT, stable: "none" });
  const one = sessionEventsFor(home, "t5-impl-1", { since, root: ROOT });
  assert.equal(one.state, "ok");
  assert.deepEqual([...one.ids.keys()], ["conv-1"]);
  for (const bad of [NaN, undefined, Infinity, "1"]) assert.deepEqual(sessionEventsFor(home, "t5-impl-1", { since: bad, root: ROOT }), { state: "none" }, `since ${bad}`);
  assert.deepEqual(sessionEventsFor(home, "other-peer", { since, root: ROOT }), { state: "none" }, "another peer");
  // A record from before the launch does not count; one since then does, and two processes are none.
  writeNamesStatus(dir, K2, { peer: "t5-impl-1", parent: ROOT, stable: "none", now: since - 1 });
  assert.deepEqual([...sessionEventsFor(home, "t5-impl-1", { since, root: ROOT }).ids.keys()], ["conv-1"], "an older record");
  writeNamesStatus(dir, K2, { peer: "t5-impl-1", parent: ROOT, stable: "none" });
  assert.deepEqual(sessionEventsFor(home, "t5-impl-1", { since, root: ROOT }), { state: "none" }, "two processes");
  // Malformed or mismatched records are skipped.
  fs.rmSync(path.join(dir, `${K2}.names.json`));
  fs.writeFileSync(path.join(dir, `${"3".repeat(32)}.names.json`), "not json", { mode: 0o600 });
  writeRecord(path.join(dir, `${"4".repeat(32)}.names.json`), { v: 1, key: K2, mcp: { pid: 1, start: "x" }, peer: "t5-impl-1", at: Date.now(), stable: "none" });
  writeRecord(path.join(dir, `${"5".repeat(32)}.names.json`), { v: 1, key: "5".repeat(32), mcp: { pid: 1, start: "x" }, peer: "t5-impl-1", at: "now", stable: "none" });
  writeRecord(path.join(dir, "not-a-key.names.json"), { v: 1, key: "not-a-key", mcp: { pid: 1, start: "x" }, peer: "t5-impl-1", at: Date.now(), stable: "none" });
  assert.deepEqual([...sessionEventsFor(home, "t5-impl-1", { since, root: ROOT }).ids.keys()], ["conv-1"]);
  // The parent must match: a missing root, another root, or a record without a parent never match.
  for (const root of [null, undefined, { ...ROOT, pid: 1 }, { ...ROOT, start: "other" }, { ...ROOT, boot: "b2" }, { pid: ROOT.pid }]) assert.deepEqual(sessionEventsFor(home, "t5-impl-1", { since, root }), { state: "none" }, JSON.stringify(root));
  writeNamesStatus(dir, "6".repeat(32), { peer: "t5-impl-1", stable: "none" });
  assert.deepEqual([...sessionEventsFor(home, "t5-impl-1", { since, root: ROOT }).ids.keys()], ["conv-1"], "a record without a parent is not counted");
});

test("engine: a resume seen between the hello and the welcome means no name is published", async (t) => {
  const { createEngine } = await import("../lib/engine.js");
  const { readSettings } = await import("../lib/settings.js");
  const { ensureWakeDir } = await import("../lib/wake.js");
  const { hostKey, processIdentity } = await import("../lib/host.js");
  const { url, token } = await relayAt(t);
  const home = tmp(t);
  const host = { ...processIdentity(process.pid), args: "claude" };
  const dir = ensureWakeDir(home);
  const key = hostKey(host);
  appendSessionEvent(dir, key, { session_id: "s1", source: "startup" });
  const hello = RelayClient.prototype.hello;
  t.after(() => (RelayClient.prototype.hello = hello));
  RelayClient.prototype.hello = function (...a) {
    if (this.stable?.want) appendSessionEvent(dir, key, { session_id: "r2", source: "resume" });
    return hello.apply(this, a);
  };
  const settings = readSettings({ env: { HOPTELL_RELAY: url, HOPTELL_TOKEN: token, HOPTELL_HOME: home, HOPTELL_PUSH: "listener", HOPTELL_NOTIFY: "off" }, homedir: "/nonexistent-home", pid: process.pid, hostname: "testhost" });
  const engine = createEngine(settings, { findHost: () => host, keepAlive: true, namesWaitMs: 300 });
  t.after(() => engine.stop());
  await engine.start();
  assert.ok(await until(() => engine.session.state === "bound"));
  const text = async () => (await engine.call("list_peers")).content.map((c) => c.text).join("\n");
  assert.ok(await until(async () => /not kept across restarts: this Claude Code process has served more than one conversation/.test(await text())));
  assert.equal(fs.existsSync(entryFile(home, P, "s1")), false);
  assert.deepEqual(fs.existsSync(path.join(home, "names")) ? fs.readdirSync(path.join(home, "names")) : [], [], "no record, no entry");
});
