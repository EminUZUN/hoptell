// Shared setup for the client-side transfer tests (design 6, experimental): a real relay with the
// transfer store, devices with fake-driver MLS, an encrypted-messaging engine per session, and per
// home the sender's outbox (lib/transferout.js) and the receiver's staging (lib/transferin.js).
import crypto from "node:crypto";
import fs from "node:fs";
import { deviceStore } from "../lib/mls/device.js";
import { createE2ee } from "../lib/mls/e2ee.js";
import { createOutbox } from "../lib/transferout.js";
import { createStaging } from "../lib/transferin.js";
import { createFakeDriver } from "./fake-mls-driver.js";
import { deviceRelay, memoryContacts, ownFor, tmpDir } from "./mls-helpers.js";

const PASS = "correct horse battery staple";
export const settle = (ms = 100) => new Promise((r) => setTimeout(r, ms));
export const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

/** Wait until `fn()` holds (polling). */
export async function until(fn, what = "condition", ms = 8000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await settle(25);
  }
}

/** A relay with transfers (relay chunk size: the wire format's). */
export const transferRelay = (t, opts = {}) => deviceRelay(t, { e2ee: true, transfers: opts.transfers ?? true, ...opts });

/**
 * A device of `member` with its home, and sessions on it. Each session gets an e2ee engine whose
 * onTransfer runs the home's staging intake and fetches what it accepted (recorded in `fetches`).
 * `contacts` is the home's contacts document holder (memoryContacts), `stagingOpts` extra options.
 */
export async function device(t, w, member, { sessions = [member], dir = tmpDir(t), contacts = memoryContacts(), admitted = () => true, stagingOpts = {}, outboxOpts = {}, autoFetch = true } = {}) {
  const driver = createFakeDriver({ seed: `${member}-${dir}`, now: w.clock.now });
  const store = deviceStore({ home: dir, profile: "relay-test", driver, store: "file", passphrase: PASS, keychainBackend: null, machine: "m", now: w.clock.now, own: ownFor(contacts, dir, "relay-test") });
  contacts.doc.encryption ??= [{ realm: w.realm, mode: "preferred" }];
  const enrollClient = await w.client(member);
  await store.enroll(enrollClient);
  const d = { dir, store, driver, member, id: w.members[member].id, device: store.record().device, contacts, s: {}, fetches: [], staged: [] };
  d.staging = createStaging({ home: dir, contacts: () => contacts.doc, admitted, now: w.clock.now, onStaged: async (e, file) => void d.staged.push({ e, bytes: fs.readFileSync(file) }), ...stagingOpts });
  d.open = async (session) => {
    const client = await w.client(member, { session });
    const got = [];
    const s = { client, got };
    s.e2ee = createE2ee({
      store, driver, client, session, home: dir, profile: "relay-test", contacts, now: w.clock.now,
      deliver: async (m) => void got.push(m),
      onTransfer: async (x) => {
        const r = await d.staging.intake(x);
        if (r.fetch && autoFetch) d.fetches.push(d.staging.fetch(r.t_id, (f) => client.rpc(f)));
        return r;
      },
    });
    s.outbox = createOutbox({ home: dir, rpc: (f) => client.rpc(f), device: () => d.device, now: w.clock.now, ...outboxOpts });
    await s.e2ee.attach();
    d.s[session] = s;
    return s;
  };
  for (const s of sessions) await d.open(s);
  return d;
}

/** A capture of `bytes` (what the guarded reader writes into the outbox). */
export const captureOf = (bytes) => async (fd) => {
  for (let off = 0; off < bytes.length; ) off += fs.writeSync(fd, bytes, off, bytes.length - off);
  return { bytes: bytes.length, sha256: sha(bytes) };
};

/** Send `bytes` from session `s` of `from` to session `toSession` of member `to` as a file transfer. */
export const sendFile = (from, s, to, bytes, { toSession = to.member, name = "report.bin", capture = captureOf(bytes) } = {}) =>
  from.s[s].outbox.send({
    capture,
    name,
    meta: { to: { member: to.id, session: toSession }, purpose: "file" },
    publish: (descriptor, blobs) => from.s[s].e2ee.send({ to: { member: to.id, session: toSession }, kind: "file", body: { transfer: descriptor }, blobs }),
    messageState: (ref) => from.s[s].e2ee.messageState(ref),
  });

/** Allow transfers from member `fromId` in contacts holder `c` (realm `realm`). */
export function allowTransfers(c, realm, fromId, maxBytes = undefined, caps = {}) {
  c.doc.transfers = { ...(c.doc.transfers ?? {}), ...caps, contacts: [...(c.doc.transfers?.contacts ?? []).filter((e) => e.member !== fromId), { realm, member: fromId, allowed: true, ...(maxBytes === undefined ? {} : { maxBytes }) }] };
}

/** Pattern bytes (byte i = i mod 251), as the vectors use. */
export const pattern = (n, seed = 0) => Buffer.from(Array.from({ length: n }, (_, i) => (i + seed) % 251));
