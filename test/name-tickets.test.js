// Name tickets (design 10, cap "name-ticket"): the claim table's rules, the relay's frames and
// codes, and old clients on a relay that protects names.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import WebSocket from "ws";
import { startRelay } from "../lib/relay.js";
import { ClaimTable, GRACE_MS, TICKET_TTL_MS } from "../lib/claims.js";
import { ROOT } from "../lib/config.js";
import { fakeToken, sleep } from "./helpers.js";

const alice = { kind: "member", id: "m_aaaaaaaaaaaaaaaaaaaaaaaaaa" };
const bob = { kind: "member", id: "m_bbbbbbbbbbbbbbbbbbbbbbbbbb" };
const shared = { kind: "shared" };
const sock = (label) => ({ label });
const clock = () => {
  let t = 1_000_000;
  return { now: () => t, advance: (ms) => (t += ms) };
};
const acquire = (ct, name, socket, principal, ticket = true) => ct.hello({ name, socket, principal, version: 2, claim: { action: "acquire", ...(ticket ? { ticket: true } : {}) } });
const cont = (ct, name, socket, principal, ticket) => ct.hello({ name, socket, principal, version: 2, claim: { action: "continue", ticket } });

// ---- the claim table --------------------------------------------------------------------------

test("claims: a ticket comes only with a new acquire that asks for it, never with a resume", () => {
  const ct = new ClaimTable();
  const a = sock("a");
  const r = acquire(ct, "n", a, alice);
  assert.equal(r.ok, true);
  assert.match(r.claim.ticket, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(acquire(ct, "plain", sock("p"), alice, false).claim.ticket, undefined, "no ticket unless asked");
  const resumed = ct.hello({ name: "n", socket: sock("a2"), principal: alice, version: 2, claim: { action: "resume", ...r.claim, attempt: "x1" } });
  assert.equal(resumed.ok, true);
  assert.equal(resumed.claim.ticket, undefined, "a resume does not resend it");
  assert.equal(ct.hello({ name: "bad", socket: sock("b"), principal: alice, version: 2, claim: { action: "acquire", ticket: "yes" } }).code, "bad_claim");
  assert.equal(JSON.stringify([...ct.tickets.values()]).includes(r.claim.ticket), false, "only a digest is kept");
});

test("claims: continue takes a free or own-reserved name, keeps the ticket, never displaces a live holder", () => {
  const k = clock();
  const ct = new ClaimTable({ now: k.now });
  const a = sock("a");
  const { ticket } = acquire(ct, "n", a, alice).claim;
  const b = sock("b");
  assert.deepEqual(cont(ct, "n", b, alice, ticket), { ok: false, code: "ticket_in_use", close: 4006, retryAfterMs: GRACE_MS }, "a live holder keeps the name");
  assert.equal(ct.isCurrent("n", a), true);
  ct.closed("n", a);
  const r = cont(ct, "n", b, alice, ticket);
  assert.equal(r.ok, true, "its own reservation");
  assert.equal(r.claim.ticket, undefined);
  ct.release("n", b);
  assert.equal(cont(ct, "n", sock("c"), alice, ticket).ok, true, "a released name, the same ticket");
});

test("claims: every ticket failure is the same answer", () => {
  const k = clock();
  const ct = new ClaimTable({ now: k.now });
  const a = sock("a");
  const { ticket } = acquire(ct, "n", a, alice).claim;
  ct.release("n", a);
  const unknown = { ok: false, code: "ticket_unknown", close: 4006 };
  assert.deepEqual(cont(ct, "n", sock("x"), alice, "A".repeat(43)), unknown, "a wrong ticket");
  assert.deepEqual(cont(ct, "n", sock("x"), bob, ticket), unknown, "another member");
  assert.deepEqual(cont(ct, "n", sock("x"), shared, ticket), unknown, "a shared-token client");
  assert.deepEqual(cont(ct, "other", sock("x"), alice, ticket), unknown, "another name");
  assert.deepEqual(cont(ct, "n", sock("x"), alice, 42), unknown, "not a string");
  k.advance(TICKET_TTL_MS);
  assert.deepEqual(cont(ct, "n", sock("x"), alice, ticket), unknown, "expired");
  assert.equal(ct.protected("n"), false);
});

test("claims: a held name's ticket does not expire; the lifetime starts again when the holder goes", () => {
  const k = clock();
  const ct = new ClaimTable({ now: k.now });
  const a = sock("a");
  const { ticket } = acquire(ct, "n", a, alice).claim;
  k.advance(TICKET_TTL_MS * 2);
  assert.equal(ct.protected("n"), true);
  ct.release("n", a);
  k.advance(TICKET_TTL_MS - 1);
  ct.sweep();
  assert.equal(cont(ct, "n", sock("b"), alice, ticket).ok, true);
});

test("claims: a protected name: the allocator check, acquires of every principal, legacy hellos, claim_status", () => {
  const k = clock();
  const ct = new ClaimTable({ now: k.now });
  const a = sock("a");
  const { ticket } = acquire(ct, "n", a, alice).claim;
  ct.closed("n", a);
  k.advance(GRACE_MS);
  assert.equal(ct.status("n").state, "taken", "the automatic allocator (no principal) skips it");
  assert.deepEqual(acquire(ct, "n", sock("b"), alice, false), { ok: false, code: "name_in_use", close: 4006, bound: true }, "even its own principal, without the ticket");
  assert.equal(acquire(ct, "n", sock("b"), bob).code, "name_in_use");
  assert.deepEqual(ct.hello({ name: "n", socket: sock("l"), principal: alice, version: 1 }), { ok: false, code: "name_in_use", close: 4002 }, "a legacy hello after its reservation ended");
  assert.equal(ct.status("n", alice).state, "taken", "without the ticket");
  assert.equal(ct.status("n", alice, ticket).state, "free", "with it");
  assert.equal(ct.status("n", bob, ticket).state, "taken", "a ticket of another principal");
  // Within the reservation, legacy is refused too (as before), and the same principal without the ticket waits.
  const c = sock("c");
  cont(ct, "n", c, alice, ticket);
  ct.closed("n", c);
  assert.equal(ct.hello({ name: "n", socket: sock("l2"), principal: alice, version: 1 }).close, 4002);
  assert.equal(acquire(ct, "n", sock("d"), alice, false).bound, true);
});

test("claims: replace by the ticket's principal ends the ticket; another principal may not", () => {
  const ct = new ClaimTable();
  const a = sock("a");
  const { ticket } = acquire(ct, "n", a, alice).claim;
  ct.release("n", a);
  assert.deepEqual(ct.hello({ name: "n", socket: sock("s"), principal: shared, version: 2, claim: { action: "replace" } }), { ok: false, code: "not_allowed", close: 4002 });
  assert.equal(ct.hello({ name: "n", socket: sock("b"), principal: alice, version: 2, claim: { action: "replace" } }).ok, true);
  assert.equal(ct.protected("n"), false);
  assert.equal(cont(ct, "n", sock("c"), alice, ticket).code, "ticket_unknown");
});

test("claims: the per-principal limit evicts the least recently used idle ticket, and none of a live name", () => {
  const k = clock();
  const ct = new ClaimTable({ now: k.now, ticketsPerPrincipal: 2 });
  const [a, b, c] = [sock("a"), sock("b"), sock("c")];
  const ta = acquire(ct, "na", a, alice).claim.ticket;
  k.advance(1);
  acquire(ct, "nb", b, alice);
  k.advance(1);
  const live = acquire(ct, "nc", c, alice);
  assert.equal(live.ok, true);
  assert.equal(live.claim.ticket_limit, true, "both earlier names are live: nothing evicted, no ticket");
  assert.equal(live.claim.ticket, undefined);
  assert.equal(ct.protected("na") && ct.protected("nb"), true);
  ct.release("na", a);
  const d = acquire(ct, "nd", sock("d"), alice);
  assert.match(d.claim.ticket, /^[A-Za-z0-9_-]{43}$/, "the idle one is evicted");
  assert.equal(cont(ct, "na", sock("e"), alice, ta).code, "ticket_unknown");
  assert.match(acquire(ct, "ne", sock("e"), bob).claim.ticket, /^[A-Za-z0-9_-]{43}$/, "another principal has its own limit");
});

test("claims: tickets of a narrowed credential are pruned", () => {
  const ct = new ClaimTable();
  const a = sock("a");
  const { ticket } = acquire(ct, "alice-x", a, alice).claim;
  ct.release("alice-x", a);
  acquire(ct, "shared-x", sock("s"), shared);
  ct.pruneReservations((_n, p) => p.kind === "shared");
  assert.equal(ct.protected("alice-x"), false);
  assert.equal(ct.protected("shared-x"), true);
  assert.equal(cont(ct, "alice-x", sock("b"), alice, ticket).code, "ticket_unknown");
});

// ---- the relay --------------------------------------------------------------------------------

/** A raw connection that records frames and its close code. */
function connect(url, hello) {
  const ws = new WebSocket(url);
  const frames = [];
  const waiters = [];
  ws.on("message", (d) => {
    const f = JSON.parse(d);
    frames.push(f);
    for (const w of [...waiters]) if (w.match(f)) waiters.splice(waiters.indexOf(w), 1) && w.resolve(f);
  });
  const closed = new Promise((r) => ws.on("close", (code) => r(code)));
  ws.on("error", () => {});
  ws.on("open", () => ws.send(JSON.stringify(hello)));
  const next = (match, ms = 3000) => {
    const seen = frames.find(match);
    if (seen) return Promise.resolve(seen);
    return new Promise((resolve, reject) => {
      waiters.push({ match, resolve });
      setTimeout(() => reject(new Error(`no frame; got ${JSON.stringify(frames.map((x) => x.type))}`)), ms);
    });
  };
  let n = 0;
  const rpc = async (o) => {
    const id = `r${++n}`;
    ws.send(JSON.stringify({ ...o, id }));
    return next((f) => f.id === id);
  };
  return { ws, frames, closed, next, rpc, send: (o) => ws.send(JSON.stringify(o)) };
}

async function setup(t, opts = {}) {
  const tokens = { alice: fakeToken(), bob: fakeToken(), shared: fakeToken() };
  const lines = [];
  const relay = await startRelay({
    host: "127.0.0.1",
    port: 0,
    token: tokens.shared,
    members: [{ name: "alice", id: alice.id, token: tokens.alice }, { name: "bob", token: tokens.bob }],
    log: (...a) => lines.push(a.join(" ")),
    ...opts,
  });
  t.after(() => relay.close());
  const url = `ws://127.0.0.1:${relay.port}`;
  const conns = [];
  t.after(() => conns.forEach((c) => c.ws.terminate()));
  const hello = (fields) => {
    const c = connect(url, { type: "hello", v: 2, host: "pc", mode: "peer", ...fields });
    conns.push(c);
    return c;
  };
  return { relay, url, tokens, hello, lines };
}

test("relay: the cap, a ticket in the welcome of an automatic name, continue after a restart, the queue kept", async (t) => {
  const { tokens, hello, lines } = await setup(t);
  const a = hello({ name: null, auto: { host: "pc", n: 4242 }, token: tokens.alice, claim: { action: "acquire", ticket: true } });
  const w = await a.next((f) => f.type === "welcome");
  assert.ok(w.caps.includes("name-ticket"));
  assert.equal(w.name, "alice-pc-4242");
  const { ticket } = w.claim;
  assert.match(ticket, /^[A-Za-z0-9_-]{43}$/);
  a.ws.close();
  await a.closed;
  // A message while it is away waits in its queue.
  const tx = hello({ name: "bob", token: tokens.bob, mode: "send", claim: undefined });
  await tx.next((f) => f.type === "welcome");
  const ack = await tx.rpc({ type: "send", to: "alice-pc-4242", text: "while away" });
  assert.equal(ack.state, "queued");
  // A new process with a new pid: the allocator skips the protected name; the ticket gets it back.
  const other = hello({ name: null, auto: { host: "pc", n: 4242 }, token: tokens.alice, claim: { action: "acquire" } });
  assert.equal((await other.next((f) => f.type === "welcome")).name, "alice-pc-4242-2", "the allocator skips it");
  const b = hello({ name: "alice-pc-4242", token: tokens.alice, claim: { action: "continue", ticket } });
  const w2 = await b.next((f) => f.type === "welcome");
  assert.equal(w2.name, "alice-pc-4242");
  assert.equal(w2.claim.ticket, undefined);
  const msg = await b.next((f) => f.type === "message");
  assert.equal(msg.text, "while away");
  assert.equal(lines.some((l) => l.includes(ticket)), false, "the ticket is never logged");
});

test("relay: continue refusals: unknown alike, in use without displacing, a disallowed name, a budget", async (t) => {
  const { tokens, hello } = await setup(t);
  const a = hello({ name: "alice-x", token: tokens.alice, claim: { action: "acquire", ticket: true } });
  const { ticket } = (await a.next((f) => f.type === "welcome")).claim;
  const live = hello({ name: "alice-x", token: tokens.alice, claim: { action: "continue", ticket } });
  assert.equal((await live.next((f) => f.type === "hello_error")).code, "ticket_in_use");
  assert.equal(await live.closed, 4006);
  assert.equal(a.ws.readyState, WebSocket.OPEN, "the holder stays");
  const wrong = hello({ name: "alice-x", token: tokens.bob, claim: { action: "continue", ticket } });
  assert.equal((await wrong.next((f) => f.type === "hello_error")).code, "ticket_unknown", "bob may not use alice's names: the same answer");
  assert.equal(await wrong.closed, 4006);
  const auto = hello({ name: null, auto: { host: "pc" }, token: tokens.alice, claim: { action: "continue", ticket } });
  assert.equal(await auto.closed, 4001, "continue needs the recorded name");
  // The budget: after 10 refusals a minute from one address, refused unchecked (still the same answer).
  for (let i = 0; i < 10; i++) {
    const g = hello({ name: "alice-x", token: tokens.alice, claim: { action: "continue", ticket: "B".repeat(43) } });
    assert.equal((await g.next((f) => f.type === "hello_error")).code, "ticket_unknown");
  }
  a.ws.close();
  await a.closed;
  const late = hello({ name: "alice-x", token: tokens.alice, claim: { action: "continue", ticket } });
  assert.equal((await late.next((f) => f.type === "hello_error")).code, "ticket_unknown", "over budget: not checked");
});

test("relay: another acquire of a protected name waits with bound:true; claim_status answers the ticket", async (t) => {
  const { tokens, hello } = await setup(t);
  const a = hello({ name: "alice-y", token: tokens.alice, claim: { action: "acquire", ticket: true } });
  const { ticket } = (await a.next((f) => f.type === "welcome")).claim;
  a.send({ type: "release" });
  a.ws.close();
  await a.closed;
  const b = hello({ name: "alice-y", token: tokens.alice, claim: { action: "acquire" } });
  const e = await b.next((f) => f.type === "hello_error");
  assert.deepEqual([e.code, e.bound], ["name_in_use", true]);
  assert.equal(await b.closed, 4006);
  const probe = hello({ name: "alice-probe", token: tokens.alice, mode: "send", claim: undefined });
  await probe.next((f) => f.type === "welcome");
  assert.equal((await probe.rpc({ type: "claim_status", name: "alice-y" })).state, "taken");
  assert.equal((await probe.rpc({ type: "claim_status", name: "alice-y", ticket })).state, "free");
});

test("relay: the ticket limit gives an ordinary welcome with ticket_limit", async (t) => {
  const { tokens, hello } = await setup(t, { names: { ticketsPerPrincipal: 1 } });
  const a = hello({ name: "alice-1", token: tokens.alice, claim: { action: "acquire", ticket: true } });
  assert.ok((await a.next((f) => f.type === "welcome")).claim.ticket);
  const b = hello({ name: "alice-2", token: tokens.alice, claim: { action: "acquire", ticket: true } });
  const w = await b.next((f) => f.type === "welcome");
  assert.equal(w.claim.ticket_limit, true);
  assert.equal(w.claim.ticket, undefined);
});

// ---- old clients on a relay with tickets ------------------------------------------------------

const BASELINE = "53690a4";

/** The client of BASELINE (before name tickets) from the git history, or null when unavailable. */
function oldRelease(t) {
  try {
    execFileSync("git", ["-C", ROOT, "cat-file", "-e", `${BASELINE}^{commit}`], { stdio: "ignore" });
  } catch {
    return null;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `hoptell-${BASELINE}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const tar = execFileSync("git", ["-C", ROOT, "archive", "--format=tar", BASELINE, "lib", "package.json"], { maxBuffer: 256 * 1024 * 1024 });
  execFileSync("tar", ["-x", "-C", dir], { input: tar });
  fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(dir, "node_modules"));
  return dir;
}

test("compatibility: old protocol-2 and protocol-1 clients on a relay that protects a name", async (t) => {
  const dir = oldRelease(t);
  if (!dir && process.env.CI) assert.fail(`the ${BASELINE} baseline is not in the git history; CI checkouts need full history`);
  if (!dir) return t.skip(`the ${BASELINE} baseline is unavailable here`);
  const old = await import(path.join(dir, "lib/client.js"));
  const { url, tokens, hello } = await setup(t);
  const a = hello({ name: "alice-lead", token: tokens.alice, claim: { action: "acquire", ticket: true } });
  const { ticket } = (await a.next((f) => f.type === "welcome")).claim;
  a.ws.close();
  await a.closed;
  // An old protocol-2 client with an automatic name gets another one, as on a taken name.
  const auto = new old.RelayClient({ url, token: tokens.alice, name: null, reconnect: false });
  await auto.start().ready(5000);
  t.after(() => auto.close());
  assert.notEqual(auto.name, "alice-lead");
  // An old protocol-2 client with the protected name as its explicit name waits (its own
  // principal's reservation included), without spinning, and gets the name when the ticket ends.
  const waiter = new old.RelayClient({ url, token: tokens.alice, name: "alice-lead", nameCheckMs: [200, 400] });
  let hellos = 0;
  waiter.on("replaced", () => hellos++);
  waiter.start();
  t.after(() => waiter.close());
  await sleep(1500);
  assert.equal(waiter.connected, false);
  assert.equal(waiter.waitingForName, true);
  assert.ok(hellos <= 2, `it waits with claim_status probes, not new hellos (${hellos})`);
  // The owner's override ends the ticket; the waiter then gets the name.
  const r = hello({ name: "alice-lead", token: tokens.alice, claim: { action: "replace" } });
  await r.next((f) => f.type === "welcome");
  r.send({ type: "release" });
  r.ws.close();
  await waiter.ready(10_000);
  assert.equal(waiter.name, "alice-lead");
  const gone = hello({ name: "alice-lead", token: tokens.alice, claim: { action: "continue", ticket } });
  assert.equal((await gone.next((f) => f.type === "hello_error")).code, "ticket_unknown");
  // A protocol-1 client: refused with 4002 for a protected name; other names work.
  const b = hello({ name: "alice-v1", token: tokens.alice, claim: { action: "acquire", ticket: true } });
  await b.next((f) => f.type === "welcome");
  b.ws.close();
  await b.closed;
  const v1 = new old.RelayClient({ url, token: tokens.alice, name: "alice-v1", protocol: 1, reconnect: false });
  const fatal = new Promise((resolve) => v1.on("fatal", resolve));
  v1.start();
  t.after(() => v1.close());
  assert.match(await fatal, /4002|in use/);
  const v1ok = new old.RelayClient({ url, token: tokens.alice, name: "alice-v1-other", protocol: 1, reconnect: false });
  await v1ok.start().ready(5000);
  t.after(() => v1ok.close());
  assert.equal(v1ok.protocolInUse, 1);
});
