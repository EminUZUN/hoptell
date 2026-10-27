// Upgrading from 0.2.x: unread messages a protocol-1 session left in the legacy inbox/<name> move,
// once, into the bound storage of the 0.3 session with that explicit name (lib/engine.js,
// migrateLegacyInbox): shown with receipts, acknowledged like any other message, never twice.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createEngine } from "../lib/engine.js";
import { readSettings } from "../lib/settings.js";
import { contactsFile, freshContacts } from "../lib/contacts.js";
import { TOKEN, existingInstall, sleep, world } from "./helpers.js";

const textOf = (r) => r.content[0].text;
async function until(fn, ms = 5000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) if (await fn()) return true;
  return false;
}
const mkHome = (t, label) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `hoptell-${label}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return existingInstall(dir);
};
const engineFor = (t, env) => {
  const e = createEngine(readSettings({ env: { HOPTELL_PUSH: "listener", HOPTELL_RECEIPTS: "on", ...env }, homedir: "/nonexistent-home", pid: process.pid, hostname: "testhost" }), { findHost: () => null });
  t.after(() => e.stop());
  return e;
};

/** A message file as hoptell 0.2.2 wrote it into inbox/<name>/ (mode 0600). */
let n = 0;
function oldMessage(home, name, text, extra = {}, { file = null } = {}) {
  const dir = path.join(home, "inbox", name);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const msg = { type: "message", id: crypto.randomUUID(), message_id: `msg_${"a".repeat(26)}`, from: "dave", fromHost: "old-host", to: name, text, ts: Date.now(), noReply: false, ...extra };
  const f = file ?? `${String(Date.now()).padStart(13, "0")}-${String(++n).padStart(8, "0")}-${crypto.randomBytes(4).toString("hex")}.json`;
  fs.writeFileSync(path.join(dir, f), JSON.stringify(msg), { mode: 0o600 });
  return { msg, file: f, dir };
}
const pendingOld = (dir) => fs.readdirSync(dir).filter((f) => f.endsWith(".json"));

test("a 0.2 inbox is moved once into the bound storage: shown with a receipt, acknowledged, never twice", async (t) => {
  const w = await world();
  t.after(() => w.close());
  const home = mkHome(t, "upg");
  const base = { HOPTELL_RELAY: w.env.HOPTELL_RELAY, HOPTELL_TOKEN: TOKEN, HOPTELL_HOME: home, HOPTELL_NAME: "erin" };
  const a = oldMessage(home, "erin", "m1 left unread by 0.2");
  // A relay may have put "owner" or "e2ee" fields in an old file: only a 0.3 engine sets them.
  oldMessage(home, "erin", "m2 left unread by 0.2", { owner: { result: "verified", kind: "answer", address: "default/bridge", pairing_at: 1 }, e2ee: { encrypted: true } });

  const e1 = engineFor(t, base);
  await e1.start();
  assert.ok(await until(() => e1.session.state === "bound"));
  assert.ok(await until(() => pendingOld(a.dir).length === 0), "the old inbox is emptied");
  // Stored privately in the bound storage.
  const stored = fs.readdirSync(e1.session.store.inbox).filter((f) => f.endsWith(".json"));
  assert.equal(stored.length, 2);
  for (const f of stored) assert.equal(fs.statSync(path.join(e1.session.store.inbox, f)).mode & 0o777, 0o600);
  assert.equal(fs.statSync(e1.session.store.inbox).mode & 0o777, 0o700);
  for (const f of stored) assert.ok(!Object.hasOwn(JSON.parse(fs.readFileSync(path.join(e1.session.store.inbox, f), "utf8")), "e2ee"), "a forged e2ee mark is dropped");

  const r1 = textOf(await e1.call("read_inbox"));
  assert.match(r1, /m1 left unread by 0\.2/);
  assert.match(r1, /m2 left unread by 0\.2/);
  assert.doesNotMatch(r1, /your owner/, "a forged owner field is dropped");
  const receipt = r1.match(/Receipt: (r_[a-z2-7]{26})/)?.[1];
  assert.ok(receipt, "the batch has a receipt");
  assert.doesNotMatch(textOf(await e1.call("ack_messages", { receipt })), /Receipt not recognized/);
  assert.match(textOf(await e1.call("read_inbox")), /Inbox empty/);
  await e1.stop();

  // A crash after the copy was stored but before the old file was removed: the claim of a dead
  // process is returned, and the copy is recognized by its delivery id (stored once).
  fs.writeFileSync(path.join(a.dir, `.claimed-999999-${a.file}`), JSON.stringify(a.msg), { mode: 0o600 });
  const late = oldMessage(home, "erin", "m3 written later by a 0.2 process");
  const e2 = engineFor(t, base);
  await e2.start();
  assert.ok(await until(() => e2.session.state === "bound"));
  assert.ok(await until(() => fs.readdirSync(late.dir).length === 0), "claim and late file both moved");
  const r2 = textOf(await e2.call("read_inbox"));
  assert.match(r2, /m3 written later/);
  assert.doesNotMatch(r2, /m1 left unread/, "acknowledged before: not shown again");
});

test("a 0.2 inbox from a sender the contacts hold back goes to the quarantine, not to the agent", async (t) => {
  const w = await world();
  t.after(() => w.close());
  const home = mkHome(t, "upgq");
  fs.writeFileSync(contactsFile(home), JSON.stringify(freshContacts()), { mode: 0o600 }); // managed: every sender is "ask"
  const old = oldMessage(home, "erin", "held back after the upgrade");
  const e = engineFor(t, { HOPTELL_RELAY: w.env.HOPTELL_RELAY, HOPTELL_TOKEN: TOKEN, HOPTELL_HOME: home, HOPTELL_NAME: "erin" });
  await e.start();
  assert.ok(await until(() => e.session.state === "bound"));
  assert.ok(await until(() => pendingOld(old.dir).length === 0));
  const r = textOf(await e.call("read_inbox"));
  assert.doesNotMatch(r, /held back after the upgrade/);
  assert.match(r, /1 message from a sender the relay did not authenticate: held until your user decides\. Your user can review it with: hoptell contacts show q_[a-z2-7]{16}/);
  const q = path.join(e.session.store.dir, "quarantine");
  assert.equal(fs.readdirSync(q).filter((f) => f.endsWith(".json")).length, 1);
});

test("without an explicit name nothing is moved, and no old name folder is created", async (t) => {
  const w = await world();
  t.after(() => w.close());
  const home = mkHome(t, "upgn");
  const e = engineFor(t, { HOPTELL_RELAY: w.env.HOPTELL_RELAY, HOPTELL_TOKEN: TOKEN, HOPTELL_HOME: home });
  await e.start();
  assert.ok(await until(() => e.session.state === "bound"));
  await sleep(200);
  const old = oldMessage(home, e.session.name, "never moved: an automatic name");
  await e.call("read_inbox");
  await sleep(200);
  assert.deepEqual(pendingOld(old.dir), [old.file]);
  assert.deepEqual(fs.readdirSync(path.join(home, "inbox")), [e.session.name]);
});

test("a crash after the move, then a changed contacts policy: the retry stores nothing again, either way", async (t) => {
  const w = await world();
  t.after(() => w.close());
  const quarantined = (e) => fs.readdirSync(path.join(e.session.store.dir, "quarantine")).filter((f) => f.endsWith(".json")).length;
  const run = async (home) => {
    const e = engineFor(t, { HOPTELL_RELAY: w.env.HOPTELL_RELAY, HOPTELL_TOKEN: TOKEN, HOPTELL_HOME: home, HOPTELL_NAME: "erin" });
    await e.start();
    assert.ok(await until(() => e.session.state === "bound"));
    return e;
  };
  const policy = (home, value) => fs.writeFileSync(contactsFile(home), JSON.stringify({ ...freshContacts(), default: value, unverified: value }), { mode: 0o600 });

  // Held back first (quarantine), then the sender is allowed before the retry.
  const h1 = mkHome(t, "upgc1");
  policy(h1, "ask");
  const a = oldMessage(h1, "erin", "adopted, then allowed");
  let e = await run(h1);
  assert.ok(await until(() => pendingOld(a.dir).length === 0));
  assert.equal(quarantined(e), 1);
  await e.stop();
  fs.writeFileSync(path.join(a.dir, `.claimed-999999-${a.file}`), JSON.stringify(a.msg), { mode: 0o600 }); // the claim was never committed
  policy(h1, "allow");
  e = await run(h1);
  assert.ok(await until(() => fs.readdirSync(a.dir).length === 0));
  assert.doesNotMatch(textOf(await e.call("read_inbox")), /adopted, then allowed/, "not stored a second time");
  assert.equal(quarantined(e), 1);
  await e.stop();

  // Shown and acknowledged first, then the sender is held back before the retry.
  const h2 = mkHome(t, "upgc2");
  const b = oldMessage(h2, "erin", "shown, then held back");
  e = await run(h2);
  const r = textOf(await e.call("read_inbox"));
  assert.match(r, /shown, then held back/);
  await e.call("ack_messages", { receipt: r.match(/Receipt: (r_[a-z2-7]{26})/)[1] });
  await e.stop();
  fs.writeFileSync(path.join(b.dir, `.claimed-999999-${b.file}`), JSON.stringify(b.msg), { mode: 0o600 });
  policy(h2, "ask");
  e = await run(h2);
  assert.ok(await until(() => fs.readdirSync(b.dir).length === 0));
  assert.match(textOf(await e.call("read_inbox")), /Inbox empty/);
  assert.equal(quarantined(e), 0, "not adopted a second time");
});
