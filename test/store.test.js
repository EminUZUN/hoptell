// The receive pipeline store (lib/store.js): receipts, leases, recovery, quotas, dedup, faults.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { currentBoot } from "../lib/host.js";
import { openBound } from "../lib/session.js";
import { openStore, processConsumer } from "../lib/store.js";

async function bound(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "hoptell-store-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return openBound(home, { realm: "a".repeat(32), member: null, key: "s" });
}
const msg = (text, id = crypto.randomUUID()) => ({ type: "message", id, from: "x", fromHost: "h", text, ts: 1 });
const texts = (batch) => batch.messages.map((m) => m.msg.text);
const clock = (t0 = 1_000_000) => {
  let t = t0;
  return { now: () => t, advance: (ms) => (t += ms) };
};
const files = (dir) => fs.readdirSync(dir).filter((f) => f.endsWith(".json"));

// A live consumer of this test process (its real pid, start time and boot).
const live = (kind, id) => processConsumer(kind, id);

test("take hands out a batch with a receipt; reading again repeats it; ack removes it once", async (t) => {
  const s = await openStore(await bound(t));
  for (const x of ["a", "b", "c"]) assert.equal((await s.append(msg(x))).state, "stored");
  const me = live("engine", "e1");
  const b1 = await s.take(me);
  assert.match(b1.receipt, /^r_[a-z2-7]{26}$/);
  assert.deepEqual(texts(b1), ["a", "b", "c"]);
  const again = await s.take(me);
  assert.equal(again.receipt, b1.receipt, "an unacknowledged batch is returned again");
  assert.equal(again.again, true);
  assert.equal(await s.take(live("engine", "e2")), null, "nothing else is pending");
  assert.equal(await s.ack(b1.receipt), "ok");
  assert.equal(await s.ack(b1.receipt), "ok", "a repeated acknowledgement succeeds");
  assert.equal(await s.ack("r_" + "a".repeat(26)), "unknown");
  assert.equal(await s.ack("nonsense"), "unknown");
  assert.equal(await s.take(me), null);
});

test("batches: at most 20 messages and 256 KiB, but one large message always goes", async (t) => {
  const s = await openStore(await bound(t));
  for (let i = 0; i < 25; i++) await s.append(msg(`m${i}`));
  const me = live("engine");
  const b = await s.take(me);
  assert.equal(b.messages.length, 20);
  await s.ack(b.receipt);
  assert.equal((await s.take(me)).messages.length, 5);
  const s2 = await openStore(await bound(t));
  await s2.append(msg("é".repeat(100_000))); // 200 KB of UTF-8, plus JSON
  await s2.append(msg("ü".repeat(100_000)));
  const big = await s2.take(me);
  assert.equal(big.messages.length, 1, "the second does not fit with the first");
  await s2.append(msg("€".repeat(100_000))); // 300 KB alone: over the budget, still taken
  await s2.ack(big.receipt);
  const next = await s2.take(me);
  assert.equal(next.messages.length, 1);
  await s2.ack(next.receipt);
  assert.equal((await s2.take(me)).messages[0].msg.text.length, 100_000);
});

test("leases expire: the batch returns marked as redelivered and its old receipt is unknown", async (t) => {
  const c = clock();
  const s = await openStore(await bound(t), { now: c.now, leaseMs: 60_000 });
  await s.append(msg("late"));
  const first = await s.take(live("engine", "e1"));
  c.advance(60_001);
  const second = await s.take(live("engine", "e2"));
  assert.deepEqual(texts(second), ["late"]);
  assert.equal(second.messages[0].redelivered, 1);
  assert.equal(await s.ack(first.receipt), "unknown", "an expired receipt deletes nothing");
  assert.equal(await s.ack(second.receipt), "ok");
});

test("a consumer whose process ended releases its batch; manual consumers keep theirs", async (t) => {
  const s = await openStore(await bound(t));
  for (const x of ["a", "b"]) await s.append(msg(x));
  const dead = { kind: "listen", pid: 999_999_999, start: "x", boot: currentBoot() };
  const reused = { kind: "listen", pid: process.pid, start: "not this process", boot: currentBoot() }; // PID reuse
  await s.take(dead, { max: 1 });
  await s.take(reused, { max: 1 });
  const back = await s.take(live("engine"));
  assert.deepEqual(texts(back).sort(), ["a", "b"], "both batches came back");
  await s.ack(back.receipt);
  // Two manual invocations are two consumers; a later process acknowledges by receipt alone.
  await s.append(msg("m1"));
  await s.append(msg("m2"));
  const m1 = await s.take({ kind: "manual", id: "one" }, { max: 1 });
  const m2 = await s.take({ kind: "manual", id: "two" }, { max: 1 });
  assert.notEqual(m1.receipt, m2.receipt);
  assert.deepEqual([...texts(m1), ...texts(m2)], ["m1", "m2"]);
  assert.equal(await s.take(live("engine", "e3")), null, "manual batches are still held");
  const other = await openStore({ dir: s.dir, inbox: s.inbox, seen: s.seen }); // another process
  assert.equal(await other.ack(m1.receipt), "ok");
  assert.equal(await other.ack(m2.receipt), "ok");
});

test("a lost ack+take response: repeating the ack succeeds and the same next batch comes back, even after many other acks", async (t) => {
  const s = await openStore(await bound(t));
  const me = live("engine", "me");
  for (const x of ["a1", "b1"]) await s.append(msg(x));
  const a = await s.take(me, { max: 1 });
  await s.ack(a.receipt);
  const b = await s.take(me, { max: 1 }); // this response is "lost"
  // 300 other acknowledgements push tombstones out.
  for (let i = 0; i < 300; i++) {
    await s.append(msg(`o${i}`));
    const o = await s.take(live("engine", `o${i}`));
    await s.ack(o.receipt);
  }
  assert.equal(await s.ack(a.receipt), "ok", "the predecessor's tombstone is kept while its successor is held");
  const retry = await s.take(me);
  assert.equal(retry.receipt, b.receipt);
  assert.deepEqual(texts(retry), ["b1"]);
});

test("receipts off: a take deletes at once; the policy changes only without outstanding claims", async (t) => {
  const b = await bound(t);
  const on = await openStore(b);
  await on.append(msg("held"));
  const held = await on.take(live("engine"));
  const logs = [];
  const off = await openStore(b, { receipts: "off", log: (x) => logs.push(x) });
  assert.equal(await off.policy(), "on", "kept: a claim is outstanding");
  assert.match(logs[0], /receipts stay on/);
  await on.ack(held.receipt);
  const off2 = await openStore(b, { receipts: "off" });
  assert.equal(await off2.policy(), "off");
  await off2.append(msg("gone"));
  const r = await off2.take(live("engine"));
  assert.equal(r.receipt, null);
  assert.deepEqual(texts(r), ["gone"]);
  assert.equal(await off2.take(live("engine")), null);
});

test("duplicates: a stored or seen delivery is confirmed again, never stored twice", async (t) => {
  const s = await openStore(await bound(t));
  const m = msg("once");
  assert.equal((await s.append(m)).state, "stored");
  assert.equal((await s.append(m)).state, "duplicate");
  // Without its marker, the stored file still deduplicates.
  fs.rmSync(path.join(s.seen, m.id));
  assert.equal((await s.append(m)).state, "duplicate");
  assert.ok(fs.existsSync(path.join(s.seen, m.id)), "the marker is restored");
  const b = await s.take(live("engine"));
  assert.equal(b.messages.length, 1);
  assert.equal((await s.append(m)).state, "duplicate", "while claimed");
  await s.ack(b.receipt);
  assert.equal((await s.append(m)).state, "duplicate", "after acknowledgement (marker)");
});

test("quota: full refuses (not stored); duplicates still confirm; acknowledgement frees room", async (t) => {
  const s = await openStore(await bound(t), { quotaMessages: 3 });
  const first = msg("1");
  for (const m of [first, msg("2"), msg("3")]) await s.append(m);
  await assert.rejects(s.append(msg("4")), (e) => e.code === "full");
  assert.equal(await s.hasRoom(), false);
  assert.equal((await s.append(first)).state, "duplicate", "dedup comes before the quota");
  const b = await s.take(live("engine"));
  assert.equal(await s.hasRoom(), false, "reading alone frees nothing");
  await s.ack(b.receipt);
  assert.equal(await s.hasRoom(), true);
  assert.equal((await s.append(msg("4"))).state, "stored");
});

test("faults: a failed write or fsync is not confirmed; the redelivery completes the barriers first", async (t) => {
  for (const point of ["write", "file-fsync", "dir-fsync"]) {
    const b = await bound(t);
    let armed = null;
    const seenBarriers = [];
    const fault = (p) => {
      seenBarriers.push(p);
      if (p === armed) {
        armed = null;
        throw Object.assign(new Error("simulated"), { code: point === "write" ? "ENOSPC" : "EIO" });
      }
    };
    const s = await openStore(b, { fault });
    armed = point;
    const m = msg(`f-${point}`);
    await assert.rejects(s.append(m), (e) => e.code === "storage", "disk full and I/O errors are storage errors, not the quota");
    seenBarriers.length = 0;
    const second = (await s.append(m)).state;
    assert.ok(second === "stored" || second === "duplicate", point);
    if (second === "duplicate") assert.ok(seenBarriers.includes("file-fsync") && seenBarriers.includes("dir-fsync"), `${point}: the barriers ran before confirming`);
    const got = await s.take(live("engine"));
    assert.deepEqual(texts(got), [`f-${point}`], `${point}: stored exactly once`);
  }
});

test("interrupted transactions are completed or rolled back by the next one", async (t) => {
  // Take interrupted after the first move: rolled back, nothing lost or duplicated.
  let moves = 0;
  let failMove = 0;
  const fault = (p) => {
    if (p === "move" && failMove && ++moves === failMove) throw new Error("crash");
  };
  const b = await bound(t);
  const s = await openStore(b, { fault });
  for (const x of ["a", "b", "c"]) await s.append(msg(x));
  failMove = 2;
  await assert.rejects(s.take(live("engine", "x")));
  failMove = 0;
  const all = await s.take(live("engine", "y"));
  assert.deepEqual(texts(all).sort(), ["a", "b", "c"]);
  // Requeue interrupted after the first move: one copy each, one increment.
  const c = clock(Date.now());
  const s2 = await openStore(b, { fault, now: c.now, leaseMs: 1000 });
  c.advance(10_000_000);
  moves = 0;
  failMove = 2;
  await assert.rejects(s2.take(live("engine", "z")));
  failMove = 0;
  const back = await s2.take(live("engine", "z"));
  assert.deepEqual(texts(back).sort(), ["a", "b", "c"]);
  assert.deepEqual(back.messages.map((m) => m.redelivered), [1, 1, 1]);
  assert.equal(await s2.ack(all.receipt), "unknown", "the requeued receipt cannot be acknowledged");
  // Ack interrupted after its commit point: finished by the next transaction; the ack stands.
  let failDone = true;
  const s3 = await openStore(b, {
    now: c.now,
    fault: (p, f) => {
      if (failDone && p === "write" && f?.includes(`${path.sep}done${path.sep}`)) {
        failDone = false;
        throw new Error("crash");
      }
    },
  });
  await assert.rejects(s3.ack(back.receipt));
  assert.equal(await s3.ack(back.receipt), "ok");
  assert.equal(await s3.take(live("engine", "z")), null, "acknowledged messages never come back");
  assert.deepEqual(files(path.join(b.dir, "claimed")), []);
});

test("several processes appending and taking at once lose and duplicate nothing", async (t) => {
  const b = await bound(t);
  await openStore(b);
  const mod = new URL("../lib/store.js", import.meta.url).href;
  const code = (role, n) => `
    const { openStore, processConsumer } = await import(${JSON.stringify(mod)});
    const s = await openStore(${JSON.stringify(b)});
    // The store lock is short but not fair: under load a call can give up waiting ("busy",
    // before it changed anything), as a real caller sees it. It is tried again, as they do.
    const again = async (f) => {
      for (let i = 0; ; i++) {
        try { return await f(); } catch (e) { if (e?.code !== "busy" || i >= 20) throw e; }
      }
    };
    const out = [];
    if (${JSON.stringify(role)} === "writer") {
      for (let i = 0; i < ${n}; i++) { const m = { id: crypto.randomUUID(), text: process.pid + "-" + i, ts: 1 }; await again(() => s.append(m)); }
    } else {
      const me = processConsumer("listen");
      for (let i = 0; i < 200; i++) {
        const got = await again(() => s.take(me));
        if (got) { for (const m of got.messages) out.push(m.msg.text); await again(() => s.ack(got.receipt)); }
        else await new Promise((r) => setTimeout(r, 20));
      }
    }
    process.stdout.write(JSON.stringify(out));`;
  const run = (role, n = 0) =>
    new Promise((resolve, reject) => {
      const c = spawn(process.execPath, ["--input-type=module", "-e", code(role, n)], { stdio: ["ignore", "pipe", "inherit"] });
      let out = "";
      c.stdout.on("data", (d) => (out += d));
      c.on("exit", (code) => (code === 0 ? resolve(JSON.parse(out || "[]")) : reject(new Error(`exit ${code}`))));
    });
  const results = await Promise.all([run("writer", 30), run("writer", 30), run("reader"), run("reader")]);
  const read = [...results[2], ...results[3]];
  const s = await openStore(b);
  for (let got = await s.take(live("engine", "rest")); got; got = await s.take(live("engine", "rest"))) {
    read.push(...texts(got));
    await s.ack(got.receipt);
  }
  assert.equal(read.length, 60);
  assert.equal(new Set(read).size, 60, "no duplicates");
});

test("a requeue whose inbox sync failed is completed (barrier first) before its record is removed", async (t) => {
  const b = await bound(t);
  const events = [];
  let failInboxSync = false;
  const fault = (p, f) => {
    events.push([p, f]);
    if (failInboxSync && p === "dir-fsync" && f === b.inbox) {
      failInboxSync = false;
      throw Object.assign(new Error("simulated"), { code: "EIO" });
    }
  };
  const s = await openStore(b, { fault });
  await s.append(msg("keep"));
  const me = live("engine", "rq");
  await s.take(me);
  failInboxSync = true;
  await assert.rejects(s.release(me)); // the rename into inbox/ happened; its folder sync failed
  events.length = 0;
  assert.equal((await s.pending()).length, 1);
  const syncs = events.findIndex(([p, f]) => p === "dir-fsync" && f === b.inbox);
  const removal = events.findIndex(([p, f]) => p === "dir-fsync" && f === path.join(b.dir, "claimed"));
  assert.ok(syncs >= 0 && syncs < removal, "the inbox was synced before the requeue record was removed");
  assert.deepEqual(files(path.join(b.dir, "claimed")), []);
});

test("unreadable messages are never claimed or acknowledged; damaged ones are set aside, not lost", { skip: process.getuid?.() === 0 && "root reads everything" }, async (t) => {
  const b = await bound(t);
  const s = await openStore(b);
  await s.append(msg("readable"));
  await s.append(msg("locked"));
  const [, second] = await s.pending();
  fs.chmodSync(path.join(b.inbox, second), 0o000);
  t.after(() => fs.existsSync(path.join(b.inbox, second)) && fs.chmodSync(path.join(b.inbox, second), 0o600));
  const me = live("engine", "rd");
  const first = await s.take(me);
  assert.deepEqual(texts(first), ["readable"], "the batch stops before the unreadable message");
  await s.ack(first.receipt);
  await assert.rejects(s.take(me), /could not be read/);
  assert.equal((await s.pending()).length, 1, "it stays pending");
  fs.chmodSync(path.join(b.inbox, second), 0o600);
  const later = await s.take(me);
  assert.deepEqual(texts(later), ["locked"]);
  await s.ack(later.receipt);
  // A file that is not valid JSON is moved to damaged/ and reported; the next message still comes.
  await s.append(msg("after"));
  const name = "0000000000001-00000000-deadbeef~bad.json";
  fs.writeFileSync(path.join(b.inbox, name), "{not json", { mode: 0o600 });
  const withDamaged = await s.take(me);
  assert.deepEqual(texts(withDamaged), ["after"]);
  assert.equal(withDamaged.damaged.length, 1);
  assert.ok(fs.existsSync(path.join(b.dir, "damaged", name)), "kept for inspection");
});

test("a consumer whose liveness cannot be read keeps its batch until release or the lease", async (t) => {
  const s = await openStore(await bound(t));
  await s.append(msg("kept"));
  const unknown = { kind: "listen", pid: process.pid, start: null, boot: currentBoot() }; // ps was unavailable
  const r = await s.take(unknown);
  assert.equal(await s.take(live("engine", "other")), null, "not treated as ended");
  assert.equal(await s.ack(r.receipt), "ok");
});

test("messages stored in the same millisecond keep their arrival order", async (t) => {
  const s = await openStore(await bound(t), { now: () => 1_700_000_000_000 });
  for (let i = 0; i < 20; i++) await s.append(msg(`n${i}`));
  const b = await s.take(live("engine"));
  assert.deepEqual(texts(b), Array.from({ length: 20 }, (_, i) => `n${i}`));
});

test("room is checked for the declined message's size; old tombstones go even below the count", async (t) => {
  const s = await openStore(await bound(t), { quotaBytes: 1000 });
  const big = msg("x".repeat(450));
  await s.append(big);
  const size = Buffer.byteLength(JSON.stringify(msg("y".repeat(450))));
  await assert.rejects(s.append(msg("y".repeat(450))), (e) => e.code === "full" && e.bytes === size);
  assert.equal(await s.hasRoom(1), true, "a tiny message would fit");
  assert.equal(await s.hasRoom(size), false, "the declined one does not");
  // Tombstones older than a day are removed even when there are few.
  const c = clock(Date.now());
  const s2 = await openStore(await bound(t), { now: c.now });
  await s2.append(msg("t"));
  const r = await s2.take(live("engine"));
  await s2.ack(r.receipt);
  c.advance(26 * 3600_000);
  await s2.append(msg("u")); // any later transaction prunes
  assert.equal(await s2.ack(r.receipt), "unknown");
});

test("an orphaned batch folder whose inbox sync failed is completed by the next recovery", async (t) => {
  const b = await bound(t);
  const events = [];
  let failInboxSync = false;
  const fault = (p, f) => {
    events.push([p, f]);
    if (failInboxSync && p === "dir-fsync" && f === b.inbox) {
      failInboxSync = false;
      throw Object.assign(new Error("simulated"), { code: "EIO" });
    }
  };
  const s = await openStore(b, { fault });
  await s.append(msg("orphan"));
  const r = await s.take(live("engine", "o"));
  fs.rmSync(path.join(b.dir, "claimed", `${r.receipt}.json`)); // a folder without its record
  failInboxSync = true;
  await assert.rejects(s.pending()); // the move into inbox/ happened; its folder sync failed
  events.length = 0;
  assert.equal((await s.pending()).length, 1);
  assert.ok(events.some(([p, f]) => p === "dir-fsync" && f === b.inbox), "the inbox sync is completed on the second attempt");
  assert.deepEqual(fs.readdirSync(path.join(b.dir, "claimed")), []);
});

test("a held batch whose messages are all damaged is closed and does not hide later messages", async (t) => {
  const b = await bound(t);
  const s = await openStore(b);
  await s.append(msg("will break"));
  const me = live("engine", "dm");
  const r = await s.take(me);
  const [f] = fs.readdirSync(path.join(b.dir, "claimed", r.receipt));
  fs.writeFileSync(path.join(b.dir, "claimed", r.receipt, f), "{broken");
  const first = await s.take(me);
  assert.equal(first.messages.length, 0);
  assert.equal(first.damaged.length, 1);
  await s.append(msg("next"));
  const second = await s.take(me);
  assert.deepEqual(texts(second), ["next"], "the later message is not hidden");
  assert.equal(await s.ack(r.receipt), "ok", "the closed batch's receipt still acknowledges");
  assert.equal(await s.damagedCount(), 1);
});

test("setting a damaged held file aside, interrupted at either step, is completed on the next read", async (t) => {
  for (const window of ["record", "damaged-sync"]) {
    const b = await bound(t);
    let armed = false;
    const fault = (p, f) => {
      if (!armed) return;
      const hit = window === "record" ? p === "write" && f.endsWith(".json") && f.includes(`${path.sep}claimed${path.sep}`) : p === "dir-fsync" && f.endsWith(`${path.sep}damaged`);
      if (hit) {
        armed = false;
        throw Object.assign(new Error("simulated"), { code: "EIO" });
      }
    };
    const s = await openStore(b, { fault });
    await s.append(msg("will break"));
    await s.append(msg("healthy"));
    const me = live("engine", `aside-${window}`);
    const r = await s.take(me);
    const [bad] = fs.readdirSync(path.join(b.dir, "claimed", r.receipt)).sort();
    fs.writeFileSync(path.join(b.dir, "claimed", r.receipt, bad), "{broken");
    armed = true;
    await assert.rejects(s.take(me), window);
    await s.append(msg("third"));
    const again = await (await openStore(b)).take(me);
    assert.deepEqual(texts(again), ["healthy"], `${window}: the healthy held message is shown again`);
    assert.equal(await s.damagedCount(), 1, window);
    await s.ack(again.receipt);
    assert.deepEqual(texts(await s.take(me)), ["third"], `${window}: later messages are not blocked`);
  }
});
