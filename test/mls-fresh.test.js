// The fresh-update policy driven (design 3.2 v2.2, amendments-3.5-prep A2), experimental, on a
// controlled clock: an update is due 7 days after the last own update once the conversation was
// active (not before), an idle conversation owes nothing on the timer but its first send after the
// interval updates first, a merged removal makes one due, a lost answer or a crash resumes exactly
// one update, and a member that sent no update for 30 days is listed as stale until its update is
// merged. The rotation trigger needs rotating in active groups (not offered by any driver yet).
import { test } from "node:test";
import assert from "node:assert/strict";
import { DAY } from "../lib/mls/policy.js";
import { acceptOwnDevices, deviceRelay, e2eeDevice, until } from "./mls-helpers.js";

/** alice's commits in the relay's log (the update commits she sends). */
const commitsBy = (w, d) => w.db.get("SELECT count(*) AS n FROM e2ee_log WHERE requester_device = ?", d.device).n;
const appsBy = (w, d) => w.db.get("SELECT count(*) AS n FROM e2ee_ops WHERE kind = 'app' AND requester_device = ?", d.device).n;

/** alice and bob; alice's first message at t0 creates the group, and she updates at t0. */
async function conversation(t) {
  const w = await deviceRelay(t, { e2ee: true });
  const a = await e2eeDevice(t, w, "alice");
  const b = await e2eeDevice(t, w, "bob");
  await a.s.alice.e2ee.send({ to: { member: b.id, session: "bob" }, body: "t0" });
  await until(() => b.s.bob.got.length === 1, "first");
  assert.equal((await a.s.alice.e2ee.update(b.id)).phase, "merged", "an update at t0");
  // bob merges it (and runs his own check) at t0, before the test clock moves.
  await until(async () => (await b.s.bob.e2ee.checkpoint(a.id)).epoch === 2, "bob merged the update");
  await b.s.bob.e2ee.idle();
  const gid = (await a.s.alice.e2ee.checkpoint(b.id)).group;
  return { w, a, b, gid };
}

test("A2: an update at t0 and a message at day 1: due at day 7, not before; then not again until the next interval", async (t) => {
  const { w, a, b } = await conversation(t);
  const start = commitsBy(w, a);
  w.clock.advance(1 * DAY);
  await a.s.alice.e2ee.send({ to: { member: b.id, session: "bob" }, body: "day 1" });
  await until(() => b.s.bob.got.length === 2, "day 1");
  w.clock.advance(6 * DAY - 60_000); // day 7 minus a minute
  assert.deepEqual(await a.s.alice.e2ee.checkFresh(), [], "not before day 7");
  assert.equal(commitsBy(w, a), start);
  w.clock.advance(60_000); // day 7
  assert.equal((await a.s.alice.e2ee.checkFresh()).length, 1, "due at day 7");
  assert.equal(commitsBy(w, a), start + 1, "one update");
  assert.deepEqual(await a.s.alice.e2ee.checkFresh(), [], "the age clock restarted: not due again");
  assert.equal(commitsBy(w, a), start + 1);
});

test("A2: an update at t0, idle until day 8: the timer alone never updates; the first send at day 8 sends the update first", async (t) => {
  const { w, a, b } = await conversation(t);
  const start = commitsBy(w, a);
  w.clock.advance(8 * DAY);
  assert.deepEqual(await a.s.alice.e2ee.checkFresh(), [], "idle: nothing owed on the timer");
  assert.equal(commitsBy(w, a), start);
  const apps = appsBy(w, a);
  assert.equal((await a.s.alice.e2ee.send({ to: { member: b.id, session: "bob" }, body: "day 8" })).state, "accepted");
  assert.equal(commitsBy(w, a), start + 1, "the update went first");
  assert.equal(appsBy(w, a), apps + 1);
  const update = w.db.get("SELECT max(position) AS p FROM e2ee_log WHERE requester_device = ?", a.device).p;
  assert.ok(update >= 1);
  await until(() => b.s.bob.got.some((m) => m.text === "day 8"), "read after the update");
  // bob, active since t0, owes his own update after merging alice's at day 8: both end at one epoch.
  await until(async () => (await a.s.alice.e2ee.checkpoint(b.id)).authenticator === (await b.s.bob.e2ee.checkpoint(a.id)).authenticator, "one history");
});

test("A2: a merged removal makes an update due: the member that did not commit it updates", async (t) => {
  const w = await deviceRelay(t, { e2ee: true });
  const a = await e2eeDevice(t, w, "alice");
  const b = await e2eeDevice(t, w, "bob");
  const b2 = await e2eeDevice(t, w, "bob", { sessions: [] });
  await acceptOwnDevices(b, b2);
  await a.s.alice.e2ee.send({ to: { member: b.id, session: "bob" }, body: "one" });
  await until(() => b.s.bob.got.length === 1, "first");
  const start = commitsBy(w, b);
  // b2 is revoked by the relay admin: alice removes it with her next send (her removal carries
  // her own UpdatePath); bob merges that removal and owes an update of his own.
  w.directory.revoke({ member: b.id, device: b2.device, by: { kind: "admin" } });
  await a.s.alice.e2ee.send({ to: { member: b.id, session: "bob" }, body: "after the removal" });
  await until(() => b.s.bob.got.length === 2, "second");
  await until(() => commitsBy(w, b) === start + 1, "bob's update after the merged removal");
  await b.s.bob.e2ee.idle();
  assert.deepEqual(await b.s.bob.e2ee.checkFresh(), [], "one update for that removal");
  assert.equal(commitsBy(w, b), start + 1);
});

test("A2: a lost answer, and a crash between prepare and acceptance, resume exactly one update", async (t) => {
  for (const how of ["lost", "crash"]) {
    const { w, a, b } = await conversation(t);
    w.clock.advance(1 * DAY);
    await a.s.alice.e2ee.send({ to: { member: b.id, session: "bob" }, body: "day 1" });
    w.clock.advance(7 * DAY);
    const start = commitsBy(w, a);
    let engine = a.s.alice;
    if (how === "lost") {
      const rpc = engine.client.rpc.bind(engine.client);
      let lose = true;
      engine.client.rpc = async (f) => {
        const r = await rpc(f);
        if (lose && f.type === "send_e2ee" && f.kind === "commit") {
          lose = false;
          throw Object.assign(new Error("relay did not answer in time"), { kind: "no_answer" });
        }
        return r;
      };
      assert.deepEqual(await engine.e2ee.checkFresh(), [], "not confirmed");
    } else {
      const crashing = await a.open("alice-crash", { fault: (p) => {
        if (p === "commit-after-persist") throw new Error("crash after the update was prepared");
      } });
      assert.deepEqual(await crashing.e2ee.checkFresh(), []);
      crashing.e2ee.close();
      engine = await a.open("alice-again");
    }
    await engine.e2ee.recover();
    await engine.e2ee.checkFresh();
    await engine.e2ee.checkFresh();
    assert.equal(commitsBy(w, a), start + 1, `${how}: exactly one update`);
    assert.deepEqual(await engine.e2ee.checkFresh(), [], `${how}: not due any more`);
  }
});

test("A2: a member that sent no update for 30 days is listed stale (status and doctor) until its update is merged", async (t) => {
  const { w, a, b, gid } = await conversation(t);
  w.clock.advance(31 * DAY);
  const st = await a.s.alice.e2ee.status();
  assert.deepEqual(st.stale[gid], [b.device], "bob's device is stale");
  // bob updates: once alice merges it, he is no longer listed.
  assert.equal((await b.s.bob.e2ee.update(a.id)).phase, "merged");
  await until(async () => (await a.s.alice.e2ee.status()).stale[gid].length === 0, "not stale once the update is merged");
});

test("A2 rotation trigger: conditional on rotating in active groups, which no driver offers yet: rotation is refused there", async (t) => {
  const { w, a } = await conversation(t);
  // With the capability, a rotation would make an update due at once (policy.js updateDue's
  // "rotation"); without it the device does not rotate while it has conversations.
  await assert.rejects(a.store.rotate(await w.client("alice")), (e) => e.code === "rotation_unsupported");
});

test("A2: the due update loses a race with a peer's commit: it is retried at the caught-up epoch, and the message is sealed only after an own update merged", async (t) => {
  const { w, a, b, gid } = await conversation(t);
  w.clock.advance(1 * DAY);
  await a.s.alice.e2ee.send({ to: { member: b.id, session: "bob" }, body: "day 1" });
  await until(() => b.s.bob.got.length === 2, "day 1");
  await b.s.bob.e2ee.idle();
  b.s.bob.client.close(); // bob's messages now wait at the relay (their frames carry the epoch)
  w.clock.advance(7 * DAY);
  // bob commits just before alice's due update reaches the relay: alice's loses (conflict).
  const bobEngine = b.engine(await b.proven(), "bob-racer");
  const rpc = a.s.alice.client.rpc.bind(a.s.alice.client);
  let race = true;
  a.s.alice.client.rpc = async (f) => {
    if (race && f.type === "send_e2ee" && f.kind === "commit") {
      race = false;
      assert.equal((await bobEngine.e2ee.update(a.id)).phase, "merged", "bob's commit wins the epoch");
    }
    return rpc(f);
  };
  const updatesBefore = commitsBy(w, a);
  assert.equal((await a.s.alice.e2ee.send({ to: { member: b.id, session: "bob" }, body: "day 8" })).state, "accepted");
  assert.equal(race, false, "the race happened");
  assert.equal(commitsBy(w, a), updatesBefore + 1, "alice's own update merged (retried at the caught-up epoch)");
  const update = w.db.get("SELECT epoch, position FROM e2ee_log WHERE group_id = ? AND requester_device = ? ORDER BY position DESC LIMIT 1", gid, a.device);
  const app = w.ds.pending({ member: b.id, device: b.device, limit: 200 }).filter((f) => f.kind === "app").at(-1);
  assert.ok(app.epoch > update.epoch, `the message (epoch ${app.epoch}) follows alice's merged update (log epoch ${update.epoch}, position ${update.position})`);
});

test("A2 upgrade: a group from before A2 keeps its stale-member clock (roster members counted from its creation)", async (t) => {
  const { w, a, b, gid } = await conversation(t);
  // Strip the freshness fields, as a record written before A2 has none.
  await a.store.transact(async (ctx) => {
    const G = ctx.rec.e2ee.groups[gid];
    for (const k of ["lastOwnUpdate", "activeSince", "removalAt", "updates"]) delete G[k];
    G.created = w.clock.now();
    ctx.write();
  });
  w.clock.advance(31 * DAY);
  const st = await a.s.alice.e2ee.status();
  assert.deepEqual(st.stale[gid], [b.device], "bob's device is stale after 31 days");
});
