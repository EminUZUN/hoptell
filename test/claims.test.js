// The name-claim state machine (lib/claims.js): single transitions, traces and a full matrix.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ClaimTable, GRACE_MS } from "../lib/claims.js";

const alice = { kind: "member", id: "m_aaaaaaaaaaaaaaaaaaaaaaaaaa" };
const bob = { kind: "member", id: "m_bbbbbbbbbbbbbbbbbbbbbbbbbb" };
const shared = { kind: "shared" };
const sock = (label) => ({ label });
const clock = () => {
  let t = 1_000_000;
  return { now: () => t, advance: (ms) => (t += ms) };
};

test("legacy hellos keep today's behavior among themselves and never replace a lease", () => {
  const ct = new ClaimTable();
  const [a, b, c] = [sock("a"), sock("b"), sock("c")];
  assert.deepEqual(ct.hello({ name: "n", socket: a, principal: shared, version: 1 }), { ok: true });
  assert.deepEqual(ct.hello({ name: "n", socket: b, principal: shared, version: 1 }), { ok: true, evict: a }, "legacy replaces legacy");
  const lease = ct.hello({ name: "m", socket: c, principal: alice, version: 2, claim: { action: "acquire" } });
  assert.equal(lease.ok, true);
  assert.deepEqual(ct.hello({ name: "m", socket: sock("old"), principal: alice, version: 1 }), { ok: false, code: "name_in_use", close: 4002 });
});

test("acquire takes only free names and never evicts, not even a legacy holder", () => {
  const ct = new ClaimTable();
  const a = sock("a");
  const r = ct.hello({ name: "n", socket: a, principal: alice, version: 2, claim: { action: "acquire" } });
  assert.equal(r.ok, true);
  assert.match(r.claim.lease, /^[0-9a-f]{32}$/);
  assert.equal(r.claim.gen, 1);
  assert.deepEqual(ct.hello({ name: "n", socket: sock("b"), principal: alice, version: 2, claim: { action: "acquire" } }), { ok: false, code: "name_in_use", close: 4006, retryAfterMs: undefined });
  ct.hello({ name: "legacy", socket: sock("l"), principal: alice, version: 1 });
  assert.equal(ct.hello({ name: "legacy", socket: sock("x"), principal: alice, version: 2, claim: { action: "acquire" } }).code, "name_in_use");
  assert.equal(ct.status("n").state, "taken");
});

test("a closed lease is reserved for the grace period, then free", () => {
  const k = clock();
  const ct = new ClaimTable({ now: k.now });
  const a = sock("a");
  ct.hello({ name: "n", socket: a, principal: alice, version: 2, claim: { action: "acquire" } });
  ct.closed("n", a);
  const r = ct.hello({ name: "n", socket: sock("b"), principal: bob, version: 2, claim: { action: "acquire" } });
  assert.equal(r.code, "reserved", "another principal waits for the reservation");
  assert.equal(r.retryAfterMs, GRACE_MS);
  assert.equal(ct.status("n").state, "reserved");
  assert.equal(ct.hello({ name: "n", socket: sock("l"), principal: bob, version: 1 }).close, 4002, "legacy cannot take a reserved name");
  k.advance(GRACE_MS);
  assert.equal(ct.status("n").state, "free");
  assert.equal(ct.hello({ name: "n", socket: sock("b"), principal: bob, version: 2, claim: { action: "acquire" } }).ok, true);
});

test("resume needs the lease, its secret, the same principal and this relay incarnation", () => {
  const ct = new ClaimTable({ incarnation: "inc1" });
  const a = sock("a");
  const { claim } = ct.hello({ name: "n", socket: a, principal: alice, version: 2, claim: { action: "acquire" } });
  const resume = (over = {}, principal = alice, socket = sock("r")) => ct.hello({ name: "n", socket, principal, version: 2, claim: { action: "resume", lease: claim.lease, secret: claim.secret, gen: claim.gen, incarnation: "inc1", attempt: "t1", ...over } });
  assert.equal(resume({ secret: "wrong" }).code, "lease_unknown");
  assert.equal(resume({ lease: "0".repeat(32) }).code, "lease_unknown");
  assert.equal(resume({}, bob).code, "lease_unknown", "another principal never resumes");
  assert.equal(resume({ incarnation: "inc0" }).code, "relay_restarted");
  // Valid resume while the old socket is still open: the old one is fenced.
  const b = sock("b");
  const r = resume({}, alice, b);
  assert.equal(r.ok, true);
  assert.equal(r.fence, a);
  assert.equal(r.claim.gen, 2);
  assert.equal(ct.isCurrent("n", a), false);
  assert.equal(ct.isCurrent("n", b), true);
  ct.closed("n", a); // a late close of the fenced socket changes nothing
  assert.equal(ct.isCurrent("n", b), true);
});

test("a resume whose welcome was lost can be retried; a different attempt on an old generation is superseded", () => {
  const ct = new ClaimTable({ incarnation: "i" });
  const a = sock("a");
  const { claim } = ct.hello({ name: "n", socket: a, principal: alice, version: 2, claim: { action: "acquire" } });
  ct.closed("n", a);
  const base = { action: "resume", lease: claim.lease, secret: claim.secret, incarnation: "i" };
  // Accepted resume (gen 1 -> 2) whose welcome is lost; its socket closes.
  const s1 = sock("s1");
  assert.equal(ct.hello({ name: "n", socket: s1, principal: alice, version: 2, claim: { ...base, gen: 1, attempt: "A" } }).claim.gen, 2);
  ct.closed("n", s1);
  // The client retries the same attempt with the generation it knows (1): accepted, still gen 2.
  const s2 = sock("s2");
  const retried = ct.hello({ name: "n", socket: s2, principal: alice, version: 2, claim: { ...base, gen: 1, attempt: "A" } });
  assert.equal(retried.ok, true);
  assert.equal(retried.claim.gen, 2);
  // A different attempt from the old generation loses.
  assert.deepEqual(ct.hello({ name: "n", socket: sock("x"), principal: alice, version: 2, claim: { ...base, gen: 1, attempt: "B" } }), { ok: false, code: "superseded", close: 4007 });
  // The current generation resumes normally.
  assert.equal(ct.hello({ name: "n", socket: sock("s3"), principal: alice, version: 2, claim: { ...base, gen: 2, attempt: "C" } }).claim.gen, 3);
});

test("replace is for the same principal only, and gives a fresh lease", () => {
  const ct = new ClaimTable();
  const a = sock("a");
  const first = ct.hello({ name: "n", socket: a, principal: alice, version: 2, claim: { action: "acquire" } });
  assert.deepEqual(ct.hello({ name: "n", socket: sock("b"), principal: bob, version: 2, claim: { action: "replace" } }), { ok: false, code: "not_allowed", close: 4002 });
  assert.equal(ct.hello({ name: "n", socket: sock("s"), principal: shared, version: 2, claim: { action: "replace" } }).code, "not_allowed", "a shared token cannot replace a member's claim");
  const b = sock("b2");
  const r = ct.hello({ name: "n", socket: b, principal: alice, version: 2, claim: { action: "replace" } });
  assert.equal(r.ok, true);
  assert.equal(r.evict, a);
  assert.notEqual(r.claim.lease, first.claim.lease);
  // The old lease no longer resumes.
  assert.equal(ct.hello({ name: "n", socket: sock("c"), principal: alice, version: 2, claim: { action: "resume", lease: first.claim.lease, secret: first.claim.secret, gen: 1, incarnation: ct.incarnation, attempt: "z" } }).code, "lease_unknown");
});

test("revocation ends a claim at once; owners are tracked for queue ownership", () => {
  const ct = new ClaimTable();
  const a = sock("a");
  ct.hello({ name: "n", socket: a, principal: alice, version: 2, claim: { action: "acquire" } });
  assert.deepEqual(ct.owner("n"), alice);
  ct.revoke("n", sock("stale")); // a stale or replaced socket cannot revoke the current claim
  assert.deepEqual(ct.owner("n"), alice);
  ct.revoke("n", a);
  assert.equal(ct.status("n").state, "free");
  assert.equal(ct.owner("n"), null);
  assert.equal(ct.hello({ name: "n", socket: sock("b"), principal: alice, version: 2, claim: { action: "bogus" } }).close, 4001);
});

test("a retried resume keeps its generation, but no earlier socket or reservation can release the newer one", () => {
  const k = clock();
  const ct = new ClaimTable({ incarnation: "i", now: k.now });
  const a = sock("a");
  const { claim } = ct.hello({ name: "n", socket: a, principal: alice, version: 2, claim: { action: "acquire" } });
  const base = { action: "resume", lease: claim.lease, secret: claim.secret, incarnation: "i" };
  // Attempt X advances to gen 2 on socket A2; its welcome is lost and A2 closes at t=0.
  const a2 = sock("a2");
  ct.hello({ name: "n", socket: a2, principal: alice, version: 2, claim: { ...base, gen: 1, attempt: "X" } });
  ct.closed("n", a2); // reserved until t=30
  k.advance(10_000);
  const b = sock("b");
  assert.equal(ct.hello({ name: "n", socket: b, principal: alice, version: 2, claim: { ...base, gen: 1, attempt: "X" } }).claim.gen, 2);
  k.advance(5_000);
  ct.closed("n", b); // reserved until t=45
  ct.closed("n", a2); // a late close from the earlier socket: no effect
  k.advance(15_000); // t=30: the first reservation's deadline
  assert.equal(ct.status("n").state, "reserved", "the earlier reservation must not release the newer one");
  k.advance(15_000); // t=45
  assert.equal(ct.status("n").state, "free");
});

test("an attempt id reused with different inputs is refused", () => {
  const ct = new ClaimTable({ incarnation: "i" });
  const a = sock("a");
  const { claim } = ct.hello({ name: "n", socket: a, principal: alice, version: 2, claim: { action: "acquire" } });
  const base = { action: "resume", lease: claim.lease, secret: claim.secret, incarnation: "i" };
  assert.equal(ct.hello({ name: "n", socket: sock("b"), principal: alice, version: 2, claim: { ...base, gen: 1, attempt: "X" } }).claim.gen, 2);
  // Same attempt id, but the current generation as input: a different transaction.
  assert.equal(ct.hello({ name: "n", socket: sock("c"), principal: alice, version: 2, claim: { ...base, gen: 2, attempt: "X" } }).code, "superseded");
});

test("the same principal may claim its own reserved name at once (a restart), with either protocol", () => {
  const ct = new ClaimTable();
  const a = sock("a");
  ct.hello({ name: "n", socket: a, principal: alice, version: 2, claim: { action: "acquire" } });
  ct.closed("n", a);
  const restarted = ct.hello({ name: "n", socket: sock("b"), principal: alice, version: 2, claim: { action: "acquire" } });
  assert.equal(restarted.ok, true);
  assert.equal(restarted.claim.gen, 1, "a fresh lease");
  ct.closed("n", ct.claims.get("n").socket);
  assert.deepEqual(ct.hello({ name: "n", socket: sock("c"), principal: alice, version: 1 }), { ok: true });
  // A live lease still cannot be taken by the same principal's acquire or legacy hello.
  const d = sock("d");
  ct.hello({ name: "m", socket: d, principal: alice, version: 2, claim: { action: "acquire" } });
  assert.equal(ct.hello({ name: "m", socket: sock("e"), principal: alice, version: 2, claim: { action: "acquire" } }).code, "name_in_use");
  assert.equal(ct.hello({ name: "m", socket: sock("f"), principal: alice, version: 1 }).close, 4002);
});

test("claim status is per principal; a clean release frees the name at once", () => {
  const ct = new ClaimTable();
  const a = sock("a");
  ct.hello({ name: "n", socket: a, principal: alice, version: 2, claim: { action: "acquire" } });
  ct.closed("n", a);
  assert.equal(ct.status("n", alice).state, "free", "its own reservation is claimable");
  assert.equal(ct.status("n", bob).state, "reserved");
  const b = sock("b");
  ct.hello({ name: "m", socket: b, principal: alice, version: 2, claim: { action: "acquire" } });
  ct.release("m", sock("other")); // only the holder can release
  assert.equal(ct.status("m", bob).state, "taken");
  ct.release("m", b);
  assert.equal(ct.status("m", bob).state, "free");
});

test("expired reservations are swept even when their names are never looked up again", () => {
  const k = clock();
  const ct = new ClaimTable({ incarnation: "i", now: k.now });
  for (let i = 0; i < 1000; i++) {
    const s = sock(i);
    ct.hello({ name: `n${i}`, socket: s, principal: alice, version: 2, claim: { action: "acquire" } });
    ct.closed(`n${i}`, s);
  }
  // Kept: a live claim, a later reservation, and a reservation renewed by a retried resume.
  ct.hello({ name: "live", socket: sock("live"), principal: bob, version: 2, claim: { action: "acquire" } });
  const r = sock("r");
  const { claim } = ct.hello({ name: "renewed", socket: r, principal: bob, version: 2, claim: { action: "acquire" } });
  ct.closed("renewed", r);
  k.advance(GRACE_MS - 1000);
  const r2 = sock("r2");
  ct.hello({ name: "renewed", socket: r2, principal: bob, version: 2, claim: { action: "resume", lease: claim.lease, secret: claim.secret, gen: 1, incarnation: "i", attempt: "A" } });
  ct.closed("renewed", r2);
  const late = sock("late");
  ct.hello({ name: "late", socket: late, principal: bob, version: 2, claim: { action: "acquire" } });
  ct.closed("late", late);
  k.advance(1001);
  ct.sweep();
  assert.deepEqual([...ct.claims.keys()].sort(), ["late", "live", "renewed"]);
  assert.equal(ct.status("renewed", alice).state, "reserved");
});

test("a credential reload drops reservations of principals that lost the name", () => {
  const ct = new ClaimTable();
  for (const [name, principal] of [["a", alice], ["b", bob]]) {
    const s = sock(name);
    ct.hello({ name, socket: s, principal, version: 2, claim: { action: "acquire" } });
    ct.closed(name, s);
  }
  ct.hello({ name: "live", socket: sock("l"), principal: bob, version: 2, claim: { action: "acquire" } });
  ct.pruneReservations((_name, p) => p.id === alice.id);
  assert.deepEqual([...ct.claims.keys()].sort(), ["a", "live"], "live claims are revoked per socket, not pruned");
});

test("inputs the table cannot evaluate are refused, not guessed", () => {
  const ct = new ClaimTable({ incarnation: "i" });
  const a = sock("a");
  const { claim } = ct.hello({ name: "n", socket: a, principal: alice, version: 2, claim: { action: "acquire" } });
  const good = { action: "resume", lease: claim.lease, secret: claim.secret, gen: 1, incarnation: "i", attempt: "A" };
  for (const bad of [{ attempt: undefined }, { attempt: "" }, { attempt: "x".repeat(65) }, { attempt: "a b" }, { gen: 0 }, { gen: 1.5 }, { gen: "1" }, { lease: 5 }, { secret: null }, { secret: "s".repeat(129) }, { incarnation: {} }]) {
    assert.deepEqual(ct.hello({ name: "n", socket: sock("x"), principal: alice, version: 2, claim: { ...good, ...bad } }), { ok: false, code: "bad_claim", close: 4001 }, JSON.stringify(bad));
  }
  for (const version of [0, 3, "2", undefined]) assert.equal(ct.hello({ name: "m", socket: sock("v"), principal: alice, version, claim: { action: "acquire" } }).code, "bad_claim");
  for (const principal of [null, {}, { kind: "member" }, { kind: "member", id: "" }, { kind: "admin" }]) {
    assert.throws(() => ct.hello({ name: "m", socket: sock("p"), principal, version: 2, claim: { action: "acquire" } }), TypeError);
  }
  assert.equal(ct.isCurrent("n", a), true, "nothing above changed the claim");
});

// Every action against every state, with the same and another principal.
test("transition matrix: FREE, ACTIVE_LEGACY, ACTIVE_LEASED, RESERVED x legacy, acquire, resume, replace", () => {
  const setups = {
    FREE: () => ({}),
    ACTIVE_LEGACY: (ct, s) => (ct.hello({ name: "n", socket: s, principal: alice, version: 1 }), {}),
    ACTIVE_LEASED: (ct, s) => ct.hello({ name: "n", socket: s, principal: alice, version: 2, claim: { action: "acquire" } }),
    RESERVED: (ct, s) => {
      const r = ct.hello({ name: "n", socket: s, principal: alice, version: 2, claim: { action: "acquire" } });
      ct.closed("n", s);
      return r;
    },
  };
  // Expected [same principal, other principal]: "ok", "ok+evict", "ok+fence" or the refusal code.
  const expected = {
    FREE: { legacy: ["ok", "ok"], acquire: ["ok", "ok"], resume: ["lease_unknown", "lease_unknown"], replace: ["ok", "ok"] },
    ACTIVE_LEGACY: { legacy: ["ok+evict", "name_in_use"], acquire: ["name_in_use", "name_in_use"], resume: ["lease_unknown", "lease_unknown"], replace: ["ok+evict", "not_allowed"] },
    ACTIVE_LEASED: { legacy: ["name_in_use", "name_in_use"], acquire: ["name_in_use", "name_in_use"], resume: ["ok+fence", "lease_unknown"], replace: ["ok+evict", "not_allowed"] },
    RESERVED: { legacy: ["ok", "name_in_use"], acquire: ["ok", "reserved"], resume: ["ok", "lease_unknown"], replace: ["ok", "not_allowed"] },
  };
  for (const [state, setup] of Object.entries(setups)) {
    for (const [action, outcomes] of Object.entries(expected[state])) {
      [alice, bob].forEach((principal, i) => {
        const ct = new ClaimTable({ incarnation: "i" });
        const holder = sock("holder");
        const held = setup(ct, holder)?.claim;
        const claim =
          action === "legacy" ? undefined
          : action === "resume" ? { action, lease: held?.lease ?? "0".repeat(32), secret: held?.secret ?? "s", gen: 1, incarnation: "i", attempt: "A" }
          : { action };
        const r = ct.hello({ name: "n", socket: sock("new"), principal, version: action === "legacy" ? 1 : 2, claim });
        const got = r.ok ? (r.evict ? "ok+evict" : r.fence ? "ok+fence" : "ok") : r.code;
        assert.equal(got, outcomes[i], `${state} / ${action} / ${i ? "other" : "same"} principal`);
      });
    }
  }
});

test("legacy hellos: a reconnect of the same principal takes the name; another principal (shared token vs member) never evicts it", () => {
  const ct = new ClaimTable();
  const member = sock("member");
  assert.deepEqual(ct.hello({ name: "alice", socket: member, principal: alice, version: 1 }), { ok: true });
  const r = ct.hello({ name: "alice", socket: sock("shared"), principal: shared, version: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.code, "name_in_use");
  assert.equal(ct.isCurrent("alice", member), true, "the member's session keeps its name");
  const again = sock("member-again");
  assert.equal(ct.hello({ name: "alice", socket: again, principal: alice, version: 1 }).evict, member, "its own reconnect replaces it");
  const s1 = sock("s1");
  ct.hello({ name: "free", socket: s1, principal: shared, version: 1 });
  assert.equal(ct.hello({ name: "free", socket: sock("s2"), principal: shared, version: 1 }).evict, s1, "shared-token holders are one principal");
  assert.equal(ct.hello({ name: "free", socket: sock("m"), principal: alice, version: 1 }).code, "name_in_use", "nor does a member evict a shared-token session");
});

test("legacy close frees the name; a stale close after a replacement changes nothing", () => {
  const ct = new ClaimTable();
  const a = sock("a");
  ct.hello({ name: "n", socket: a, principal: shared, version: 1 });
  ct.closed("n", a);
  assert.equal(ct.status("n").state, "free", "no reservation for a legacy holder");
  const b = sock("b");
  ct.hello({ name: "m", socket: b, principal: alice, version: 2, claim: { action: "acquire" } });
  const c = sock("c");
  ct.hello({ name: "m", socket: c, principal: alice, version: 2, claim: { action: "replace" } });
  ct.closed("m", b);
  assert.equal(ct.isCurrent("m", c), true);
  // A same-attempt retry while the socket that carried it is still open fences that socket.
  const { claim } = ct.hello({ name: "r", socket: sock("r0"), principal: alice, version: 2, claim: { action: "acquire" } });
  const first = sock("r1");
  ct.hello({ name: "r", socket: first, principal: alice, version: 2, claim: { action: "resume", lease: claim.lease, secret: claim.secret, gen: 1, incarnation: ct.incarnation, attempt: "T" } });
  const retry = ct.hello({ name: "r", socket: sock("r2"), principal: alice, version: 2, claim: { action: "resume", lease: claim.lease, secret: claim.secret, gen: 1, incarnation: ct.incarnation, attempt: "T" } });
  assert.equal(retry.claim.gen, 2);
  assert.equal(retry.fence, first);
});
