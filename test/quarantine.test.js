// The contacts manager (lib/quarantine.js): install modes, holding, budgets, decisions, journal.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openBound } from "../lib/session.js";
import { openStore, processConsumer } from "../lib/store.js";
import { DecisionError, KEY_MAX_MESSAGES, openContacts } from "../lib/quarantine.js";

const R = "a".repeat(32);
const ALICE = "m_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const tmpHome = (t) => {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), "hoptell-q-"));
  t.after(() => fs.rmSync(h, { recursive: true, force: true }));
  return h;
};
const fromAlice = (text, id = ALICE) => ({ type: "message", id: crypto.randomUUID(), from: "alice-x", fromHost: "h", text, ts: 1, sender: { auth: "member", member: { id, name: "alice" }, realm: R } });
const session = (name) => ({ realm: R, name });
async function sessionStore(home, name) {
  const bound = await openBound(home, { realm: R, member: null, key: name });
  return { bound, store: await openStore(bound) };
}

test("install modes: new install is managed; existing state is legacy-allow; a policy or witness keeps managed", async (t) => {
  const fresh = tmpHome(t);
  const a = await openContacts(fresh, { notify: false });
  assert.equal(a.mode, "managed");
  assert.equal(JSON.parse(fs.readFileSync(path.join(fresh, "contacts.json"), "utf8")).default, "ask");

  const old = tmpHome(t);
  fs.mkdirSync(path.join(old, "inbox"));
  const b = await openContacts(old, { notify: false });
  assert.equal(b.mode, "legacy-allow");
  assert.equal(b.verdict(fromAlice("x"), session("s")), "allow", "today's behavior until migrated");
  assert.deepEqual(await b.init(), { already: false });
  const b2 = await openContacts(old, { notify: false });
  assert.equal(b2.mode, "managed");
  assert.equal(b2.verdict(fromAlice("x"), session("s")), "ask");

  // Marker lost, policy removed, but a managed session store remains: still managed (fail closed).
  const w = tmpHome(t);
  await openContacts(w, { notify: false });
  const { bound } = await sessionStore(w, "s");
  fs.writeFileSync(path.join(bound.dir, "store.json"), JSON.stringify({ v: 1, storage: 2, receipts: "on", gen: 0, contacts: "managed" }));
  fs.rmSync(path.join(w, "contacts.json"));
  fs.rmSync(path.join(w, "contacts", "state.json"));
  const c = await openContacts(w, { notify: false });
  assert.equal(c.mode, "managed");
  assert.equal(c.verdict(fromAlice("x"), session("s")), "ask", "no usable policy: everyone waits");
  // A corrupt marker alone is also managed.
  const z = tmpHome(t);
  fs.mkdirSync(path.join(z, "contacts"), { recursive: true });
  fs.mkdirSync(path.join(z, "inbox"));
  fs.writeFileSync(path.join(z, "contacts", "state.json"), "{broken");
  assert.equal((await openContacts(z, { notify: false })).mode, "managed");
});

test("held messages: quarantine, one request per sender, one rate-limited notification, budgets drop new arrivals", async (t) => {
  const home = tmpHome(t);
  const notes = [];
  const titles = [];
  const c = await openContacts(home, { notifier: (title, text) => (titles.push(title), notes.push(text)) });
  const { bound, store } = await sessionStore(home, "s");
  const r1 = await c.hold(bound.dir, session("s"), fromAlice("one"), "ask");
  assert.equal(r1.disposition, "quarantined");
  await c.hold(bound.dir, session("s"), fromAlice("two"), "ask");
  const st = await c.status();
  assert.equal(st.requests.length, 1);
  assert.equal(st.requests[0].items, 2);
  assert.equal(notes.length, 1, "one notification per request");
  assert.doesNotMatch(notes[0], /one|two/, "no message text");
  assert.deepEqual(titles, ["hoptell · Message held"]);
  assert.match(notes[0], / wants to reach s\. Review it with hoptell contacts or hoptell ui\.$/);
  assert.equal(await store.take(processConsumer("engine", "e")), null, "nothing reaches the inbox");
  // A second sender within the minute: listed, not notified (rate limit).
  await c.hold(bound.dir, session("s"), fromAlice("bob", "m_bbbbbbbbbbbbbbbbbbbbbbbbbb"), "ask");
  assert.equal(notes.length, 1);
  // Blocked: counted, not stored.
  assert.equal((await c.hold(bound.dir, session("s"), fromAlice("no"), "block")).disposition, "blocked");
  // Per-sender budget: arrivals beyond it are dropped and counted.
  for (let i = 2; i < KEY_MAX_MESSAGES; i++) await c.hold(bound.dir, session("s"), fromAlice(`m${i}`), "ask");
  assert.equal((await c.hold(bound.dir, session("s"), fromAlice("over"), "ask")).disposition, "dropped");
  const after = await c.status();
  const alice = after.requests.find((r) => r.sender.member === ALICE);
  assert.equal(alice.items, KEY_MAX_MESSAGES);
  assert.equal(alice.dropped, 1);
  assert.equal(after.dropped.blocked, 1);
});

test("decisions: stale tokens are refused; allow-once releases exactly its cohort with approval; allow grants; block deletes", async (t) => {
  const home = tmpHome(t);
  const c = await openContacts(home, { notify: false });
  const { bound, store } = await sessionStore(home, "s");
  const me = processConsumer("engine", "d");
  await c.hold(bound.dir, session("s"), fromAlice("first"), "ask");
  let shown = (await c.status()).requests[0];
  const pr = (await c.status()).policyRevision;
  await c.hold(bound.dir, session("s"), fromAlice("second"), "ask"); // arrives after it was shown
  await assert.rejects(c.allowOnce(shown.id, { rev: shown.rev, policyRev: pr }), DecisionError);
  shown = (await c.status()).requests[0];
  await c.allowOnce(shown.id, { rev: shown.rev, policyRev: pr });
  const got = await store.take(me, { screen: c.screenFor(session("s")) });
  assert.deepEqual(got.messages.map((m) => m.msg.text), ["first", "second"], "approved messages pass a normal ask");
  assert.ok(got.messages.every((m) => m.file.endsWith(".a.json")));
  await store.ack(got.receipt);
  // allow: a grant, and later messages flow without asking.
  await c.hold(bound.dir, session("s"), fromAlice("third"), "ask");
  const r = (await c.status()).requests[0];
  await c.allow(r.id, { rev: r.rev, policyRev: pr });
  const doc = JSON.parse(fs.readFileSync(path.join(home, "contacts.json"), "utf8"));
  assert.equal(doc.grants.length, 1);
  assert.match(doc.grants[0].id, /^g_/);
  assert.equal(c.verdict(fromAlice("x"), session("s")), "allow");
  const third = await store.take(me, { screen: c.screenFor(session("s")) });
  assert.deepEqual(third.messages.map((m) => m.msg.text), ["third"]);
  assert.ok(!third.messages[0].file.endsWith(".a.json"), "released under a grant, not one-time approved");
  await store.ack(third.receipt);
  // An old token after the policy changed is refused (another terminal edited it).
  await c.hold(bound.dir, session("s"), fromAlice("mallory", "m_cccccccccccccccccccccccccc"), "ask");
  const m = (await c.status()).requests[0];
  await assert.rejects(c.block(m.id, { rev: m.rev, policyRev: pr }), /changed since it was shown/);
  const now = (await c.status()).policyRevision;
  await c.block(m.id, { rev: m.rev, policyRev: now });
  assert.equal((await c.status()).requests.length, 0);
  assert.equal(c.verdict(fromAlice("x", "m_cccccccccccccccccccccccccc"), session("s")), "block");
  // revoke by id with the current policy revision.
  const doc2 = JSON.parse(fs.readFileSync(path.join(home, "contacts.json"), "utf8"));
  await assert.rejects(c.revoke(doc2.grants[0].id, { policyRev: 0 }), /policy changed/);
  await c.revoke(doc2.grants[0].id, { policyRev: doc2.revision });
  assert.equal(c.verdict(fromAlice("x"), session("s")), "ask");
});

test("presentation: a revoke or block applies to stored backlog; one-time approval survives ask but not block", async (t) => {
  const home = tmpHome(t);
  const c = await openContacts(home, { notify: false });
  const { bound, store } = await sessionStore(home, "s");
  const me = processConsumer("engine", "p");
  // Granted, delivered to the inbox, not read yet; then the grant is revoked.
  await c.hold(bound.dir, session("s"), fromAlice("before"), "ask");
  const r = (await c.status()).requests[0];
  const pr = (await c.status()).policyRevision;
  await c.allow(r.id, { rev: r.rev, policyRev: pr });
  await store.append(fromAlice("backlog"));
  const doc = JSON.parse(fs.readFileSync(path.join(home, "contacts.json"), "utf8"));
  await c.revoke(doc.grants[0].id, { policyRev: doc.revision });
  const taken = await store.take(me, { screen: c.screenFor(session("s")) });
  assert.equal(taken.messages.length, 0, "nothing shown after the revoke");
  assert.equal(taken.quarantined.length, 2, "moved to quarantine");
  await c.adopt();
  assert.equal((await c.status()).requests[0].items, 2);
  // allow-once them, then block the sender: the block wins over the approval.
  const q = (await c.status()).requests[0];
  await c.allowOnce(q.id, { rev: q.rev, policyRev: (await c.status()).policyRevision });
  await c.hold(bound.dir, session("s"), fromAlice("later"), "ask");
  const q2 = (await c.status()).requests[0];
  await c.block(q2.id, { rev: q2.rev, policyRev: (await c.status()).policyRevision });
  const final = await store.take(me, { screen: c.screenFor(session("s")) });
  assert.equal(final.messages.length, 0);
  assert.equal(final.blocked, 2);
});

test("scoped decisions leave other sessions pending; releases into a full inbox wait and resume", async (t) => {
  const home = tmpHome(t);
  const c = await openContacts(home, { notify: false });
  const a = await sessionStore(home, "a");
  const b = await sessionStore(home, "b");
  await c.hold(a.bound.dir, session("a"), fromAlice("to a"), "ask");
  await c.hold(b.bound.dir, session("b"), fromAlice("to b"), "ask");
  const r = (await c.status()).requests[0];
  assert.deepEqual(r.sessions.sort(), [`${R}/a`, `${R}/b`]);
  await c.allowOnce(r.id, { rev: r.rev, policyRev: (await c.status()).policyRevision, session: `${R}/a` });
  const rest = (await c.status()).requests[0];
  assert.deepEqual(rest.sessions, [`${R}/b`], "b still pending");
  // b's inbox is full: the release waits in its journal and finishes once there is room.
  const small = await openStore(b.bound, { quotaMessages: 1 });
  await small.append({ id: crypto.randomUUID(), from: "x", text: "filler", ts: 1 });
  // The store refuses a release beyond its quota; the remaining release waits (the manager's
  // journal retries it later).
  const res = await small.releaseQuarantined(fs.readdirSync(path.join(b.bound.dir, "quarantine")).filter((f) => f.endsWith(".json")));
  assert.equal(res.waiting.length, 1, "waits for room, never bypasses the quota");
  const filler = await small.take(processConsumer("engine", "f"));
  await small.ack(filler.receipt);
  const again = await small.releaseQuarantined(res.waiting);
  assert.equal(again.released.length, 1);
});

test("an interrupted release is completed by the next contacts operation", async (t) => {
  const home = tmpHome(t);
  let fail = false;
  const c = await openContacts(home, {
    notify: false,
    fault: (p, f) => {
      if (fail && p === "dir-fsync" && f.endsWith(`${path.sep}inbox`)) {
        fail = false;
        throw Object.assign(new Error("simulated"), { code: "EIO" });
      }
    },
  });
  const { bound, store } = await sessionStore(home, "s");
  await c.hold(bound.dir, session("s"), fromAlice("x"), "ask");
  const r = (await c.status()).requests[0];
  fail = true;
  await assert.rejects(c.allowOnce(r.id, { rev: r.rev, policyRev: (await c.status()).policyRevision }));
  assert.equal(fs.readdirSync(path.join(home, "contacts", "journal")).length, 1, "the journal remains");
  const st = await c.status(); // any operation resumes it
  assert.equal(st.requests.length, 0);
  assert.equal(fs.readdirSync(path.join(home, "contacts", "journal")).length, 0);
  const got = await store.take(processConsumer("engine", "j"), { screen: c.screenFor(session("s")) });
  assert.deepEqual(got.messages.map((m) => m.msg.text), ["x"]);
});

test("a damaged policy is never overwritten by a decision", async (t) => {
  const home = tmpHome(t);
  const c = await openContacts(home, { notify: false });
  const { bound } = await sessionStore(home, "s");
  await c.hold(bound.dir, session("s"), fromAlice("x"), "ask");
  const r = (await c.status()).requests[0];
  fs.writeFileSync(path.join(home, "contacts.json"), "{damaged");
  await assert.rejects(c.allow(r.id, { rev: r.rev, policyRev: 0 }), /fix it/);
  assert.equal(fs.readFileSync(path.join(home, "contacts.json"), "utf8"), "{damaged");
});

test("managed is sticky in a running manager; the store witness survives a receipt-policy change", async (t) => {
  const home = tmpHome(t);
  fs.mkdirSync(path.join(home, "inbox"));
  const old = await openContacts(home, { notify: false });
  assert.equal(old.mode, "legacy-allow");
  await (await openContacts(home, { notify: false })).init(); // another process migrates
  assert.equal(old.verdict(fromAlice("x"), session("s")), "ask");
  fs.rmSync(path.join(home, "contacts.json"));
  assert.equal(old.verdict(fromAlice("x"), session("s")), "ask", "never back to allow once managed");
  // Opening an existing store as managed with another receipt policy keeps the witness.
  const bound = await openBound(home, { realm: R, member: null, key: "w" });
  await openStore(bound);
  await openStore(bound, { managed: true, receipts: "off" });
  const meta = JSON.parse(fs.readFileSync(path.join(bound.dir, "store.json"), "utf8"));
  assert.equal(meta.contacts, "managed");
  assert.equal(meta.receipts, "off");
});

test("strict metadata: a failed journal sync stops the decision; recovery completes it", async (t) => {
  const home = tmpHome(t);
  let armed = false;
  const c = await openContacts(home, {
    notify: false,
    fault: (p, f) => {
      if (armed && p === "contacts-dir-fsync" && f.endsWith(`${path.sep}journal`)) {
        armed = false;
        throw Object.assign(new Error("simulated"), { code: "EIO" });
      }
    },
  });
  const { bound, store } = await sessionStore(home, "s");
  await c.hold(bound.dir, session("s"), fromAlice("j"), "ask");
  const r = (await c.status()).requests[0];
  armed = true;
  await assert.rejects(c.allowOnce(r.id, { rev: r.rev, policyRev: (await c.status()).policyRevision }), /simulated/);
  const st = await c.status(); // recovery resumes the journal
  assert.equal(st.requests.length, 0);
  const got = await store.take(processConsumer("engine", "sj"), { screen: c.screenFor(session("s")) });
  assert.deepEqual(got.messages.map((m) => m.msg.text), ["j"]);
});

test("a refused decision leaves no journal behind; holding continues", async (t) => {
  const home = tmpHome(t);
  const c = await openContacts(home, { notify: false });
  const { bound } = await sessionStore(home, "s");
  await c.hold(bound.dir, session("s"), fromAlice("one"), "ask");
  const r = (await c.status()).requests[0];
  fs.writeFileSync(path.join(home, "contacts.json"), "{damaged");
  await assert.rejects(c.allow(r.id, { rev: r.rev, policyRev: 0 }), /fix it/);
  const jdir = path.join(home, "contacts", "journal");
  assert.deepEqual(fs.existsSync(jdir) ? fs.readdirSync(jdir).filter((f) => f.endsWith(".json")) : [], [], "nothing was journaled");
  assert.equal((await c.hold(bound.dir, session("s"), fromAlice("two"), "ask")).disposition, "quarantined");
  assert.equal((await c.status()).messages, 2);
});

test("an unverified sender keeps the relay recorded at arrival; a reader's profile never relabels it", async (t) => {
  const home = tmpHome(t);
  const c = await openContacts(home, { notify: false });
  const { bound, store } = await sessionStore(home, "s");
  const msg = { id: crypto.randomUUID(), from: "old", fromHost: "h", text: "via A", ts: 1, relayProfile: "profile-a" };
  await c.hold(bound.dir, session("s"), msg, "ask");
  const r = (await c.status()).requests[0];
  assert.equal(r.sender.relay, "profile-a");
  const pr = (await c.status()).policyRevision;
  await c.allowOnce(r.id, { rev: r.rev, policyRev: pr });
  // A block for profile-a/old, added later, applies to the released message.
  const doc = JSON.parse(fs.readFileSync(path.join(home, "contacts.json"), "utf8"));
  doc.blocks = [{ id: "b_aaaaaaaaaaaaaaaa", unverified: true, relay: "profile-a", name: "old" }];
  doc.revision++;
  fs.writeFileSync(path.join(home, "contacts.json"), JSON.stringify(doc));
  const got = await store.take(processConsumer("engine", "u"), { screen: c.screenFor(session("s")) });
  assert.equal(got.messages.length, 0);
  assert.equal(got.blocked, 1);
});

test("a new arrival over the budget is dropped before anything is written, even if storage fails", async (t) => {
  const home = tmpHome(t);
  let armed = false;
  const c = await openContacts(home, {
    notify: false,
    fault: (p) => {
      if (armed && p === "dir-fsync") {
        armed = false;
        throw Object.assign(new Error("simulated"), { code: "EIO" });
      }
    },
  });
  const { bound } = await sessionStore(home, "s");
  for (let i = 0; i < KEY_MAX_MESSAGES; i++) await c.hold(bound.dir, session("s"), fromAlice(`m${i}`), "ask");
  const over = fromAlice("over");
  armed = true;
  assert.equal((await c.hold(bound.dir, session("s"), over, "ask")).disposition, "dropped");
  const st = await c.status();
  assert.equal(st.messages, KEY_MAX_MESSAGES);
  assert.equal(st.withheld, 0);
  assert.equal(fs.readdirSync(path.join(bound.dir, "quarantine")).filter((f) => f.endsWith(".json")).length, KEY_MAX_MESSAGES);
});

test("recovery completes barriers it finds already applied (persistent faults stop it)", async (t) => {
  for (const which of ["home", "requests", "contacts"]) {
    const home = tmpHome(t);
    let failing = false;
    const target = () => ({ home, requests: path.join(home, "contacts", "requests"), contacts: path.join(home, "contacts") })[which];
    const fault = (p, f) => {
      if (failing && p === "contacts-dir-fsync" && f === target()) throw Object.assign(new Error("simulated"), { code: "EIO" });
    };
    const c = await openContacts(home, { notify: false, fault });
    const { bound } = await sessionStore(home, "s");
    await c.hold(bound.dir, session("s"), fromAlice("x"), "ask");
    const r = (await c.status()).requests[0];
    failing = true;
    await assert.rejects(c.allow(r.id, { rev: r.rev, policyRev: (await c.status()).policyRevision }), /simulated/, which);
    // The same fault, still there: recovery must not skip the barrier and claim completion.
    await assert.rejects(c.status(), /simulated/, `${which}: the barrier is retried, not skipped`);
    await assert.rejects((await openContacts(home, { notify: false, fault })).status(), /simulated/, `${which}: also after a reopen`);
    failing = false;
    const st = await c.status();
    assert.equal(st.requests.length, 0, which);
    assert.equal(fs.readdirSync(path.join(home, "contacts", "journal")).filter((f) => f.endsWith(".json")).length, 0);
    const done = JSON.parse(fs.readFileSync(path.join(home, "contacts", "done.json"), "utf8"));
    assert.ok(done.some((d) => d.id === r.id), `${which}: the done record is written`);
  }
});

test("witnesses in protocol-1 stores keep a home managed; an invalid marker fails closed in a running manager", async (t) => {
  const home = tmpHome(t);
  fs.mkdirSync(path.join(home, "inbox"));
  const c = await openContacts(home, { notify: false });
  await c.init();
  const c2 = await openContacts(home, { notify: false });
  await c2.hold(path.join(home, "legacy", "s"), { realm: null, name: "s" }, { id: crypto.randomUUID(), from: "old", text: "x", ts: 1 }, "ask");
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, "legacy", "s", "store.json"), "utf8")).contacts, "managed");
  fs.rmSync(path.join(home, "contacts.json"));
  fs.rmSync(path.join(home, "contacts", "state.json"));
  assert.equal((await openContacts(home, { notify: false })).mode, "managed", "the protocol-1 witness counts");
  const other = tmpHome(t);
  fs.mkdirSync(path.join(other, "inbox"));
  const live = await openContacts(other, { notify: false });
  assert.equal(live.verdict(fromAlice("x"), session("s")), "allow");
  fs.writeFileSync(path.join(other, "contacts", "state.json"), JSON.stringify({ v: 1, mode: "damaged" }));
  assert.equal(live.verdict(fromAlice("x"), session("s")), "ask", "a marker with an unknown mode fails closed");
});

test("backlog adoption never drops accepted messages over the budgets: they are withheld", async (t) => {
  const home = tmpHome(t);
  const c = await openContacts(home, { notify: false });
  const dir = path.join(home, "legacy", "s");
  const sid = { realm: null, name: "s" };
  for (let i = 0; i < KEY_MAX_MESSAGES; i++) await c.hold(dir, sid, { id: crypto.randomUUID(), from: "old", text: `m${i}`, ts: 1 }, "ask");
  const r = await c.adoptBacklog(dir, sid, { id: crypto.randomUUID(), from: "old", text: "accepted earlier", ts: 1 }, "ask");
  assert.equal(r.disposition, "withheld");
  const st = await c.status();
  assert.equal(st.messages, KEY_MAX_MESSAGES);
  assert.equal(st.withheld, 1);
  assert.equal(st.dropped.unadmitted ?? 0, 0, "nothing dropped");
});

test("an interrupted adoption is retried without a second copy, also for copies under an adoption id", async (t) => {
  for (const kind of ["seen elsewhere", "no delivery id"]) {
    const home = tmpHome(t);
    let failOnce = false;
    const c = await openContacts(home, {
      notify: false,
      fault: (p, f) => {
        if (failOnce && p === "contacts-write" && f.startsWith(path.join(home, "contacts", "requests"))) {
          failOnce = false;
          throw Object.assign(new Error("simulated"), { code: "EIO" });
        }
      },
    });
    const dir = path.join(home, "legacy", "s");
    const sid = { realm: null, name: "s" };
    const msg = { id: kind === "no delivery id" ? undefined : crypto.randomUUID(), from: "old", text: "accepted earlier", ts: 1 };
    if (msg.id) {
      // Its delivery id is already seen in this store (delivered and read before).
      const st = await openStore({ dir, inbox: path.join(dir, "inbox"), seen: path.join(dir, "seen") }, { receipts: "on" });
      await st.append(msg);
      const me = processConsumer("t");
      const b = await st.take(me);
      await st.ack(b.receipt);
    }
    const source = path.join(home, "inbox", "0001.json");
    failOnce = true;
    await assert.rejects(c.adoptBacklog(dir, sid, msg, "ask", { source }), /simulated/, kind);
    // The retry finds the stored copy (reconciliation may already have attached it).
    const again = await c.adoptBacklog(dir, sid, msg, "ask", { source });
    assert.ok(["quarantined", "duplicate"].includes(again.disposition), kind);
    assert.equal((await c.adoptBacklog(dir, sid, msg, "ask", { source })).disposition, "duplicate", `${kind}: a third attempt changes nothing`);
    const st = await c.status();
    assert.equal(st.messages, 1, `${kind}: one request item`);
    assert.equal(fs.readdirSync(path.join(dir, "quarantine")).filter((f) => f.endsWith(".json")).length, 1, `${kind}: one stored copy`);
  }
});

test("an adoption retried after the owner released its first copy recognizes it", async (t) => {
  const home = tmpHome(t);
  let failOnce = false;
  const c = await openContacts(home, {
    notify: false,
    fault: (p, f) => {
      if (failOnce && p === "contacts-write" && f.startsWith(path.join(home, "contacts", "requests"))) {
        failOnce = false;
        throw Object.assign(new Error("simulated"), { code: "EIO" });
      }
    },
  });
  const dir = path.join(home, "legacy", "s");
  const sid = { realm: null, name: "s" };
  const msg = { id: crypto.randomUUID(), from: "old", text: "accepted earlier", ts: 1 }; // a fresh, valid delivery id
  const source = path.join(home, "inbox", "s", "0001.json");
  failOnce = true;
  await assert.rejects(c.adoptBacklog(dir, sid, msg, "ask", { source }), /simulated/);
  // Before the retry: the owner sees the recovered request and lets it through once; it is read.
  const st = await c.status();
  const r = st.requests[0];
  await c.allowOnce(r.id, { rev: r.rev, policyRev: st.policyRevision });
  const store = await openStore({ dir, inbox: path.join(dir, "inbox"), seen: path.join(dir, "seen") }, { receipts: "on" });
  const me = processConsumer("t");
  const b = await store.take(me);
  assert.equal(b.messages.length, 1);
  await store.ack(b.receipt);
  assert.equal((await c.adoptBacklog(dir, sid, msg, "ask", { source })).disposition, "duplicate", "recognized, not copied again");
  assert.equal((await c.status()).messages, 0, "no new request");
  assert.equal(fs.readdirSync(path.join(dir, "quarantine")).filter((f) => f.endsWith(".json")).length, 0);
});
