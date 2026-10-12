// Larger transfers in an agent session (design 6). EXPERIMENTAL: lib/mls/session.js creates this
// with the session's encrypted messaging, only with HOPTELL_EXPERIMENTAL_E2EE=1 on a relay with
// the "transfers" capability.
//
// Sending: send_transfer (lib/filetools.js) captures a file with the guarded reader into the
// home's outbox (lib/transferout.js), which encrypts, uploads, commits and publishes the
// descriptor in an encrypted kind "file" message with the relay-visible reference. A review set
// too large for one frame sends its manifest in that message and its contents (RFC 8785 JSON of
// {file_id: {encoding, text}}) as the transfer.
// Receiving: the encrypted messaging hands each checked descriptor to the staging intake
// (lib/transferin.js), which decides before any fetch and then downloads in the background over
// the session's connection. File transfers wait staged for the owner (hoptell transfers, hoptell
// save); a review set is checked against its manifest once fetched and delivered to its target
// session as a review set message (the normal review intake and contacts gate apply), and its
// staging copy is deleted.
import fs from "node:fs";
import { canonicalize } from "./jcs.js";
import { checkReceivedSet } from "./reviewsets.js";
import { createOutbox } from "./transferout.js";
import { createStaging } from "./transferin.js";
import { refToId } from "./mls/content.js";
import crypto from "node:crypto";

const SWEEP_MS = 86_400_000; // the staging area's daily sweep
const HANDOFF_RETRY_MS = 5_000; // a staged review set's hand-on is retried after this, doubling ...
const HANDOFF_RETRY_MAX_MS = 600_000; // ... up to this (and at every attachment)

/**
 * The transfers of one agent session. `relay` is the session's RelayClient (attached to this
 * home's device for the encrypted messaging), `engine()` the session's e2ee engine (lib/mls/e2ee.js),
 * `contacts` the home's contacts manager, `admitted(sender)` whether the contacts gate lets that
 * sender reach this session, `deliver(message)` the session's receive pipeline (for review sets).
 */
export function sessionTransfers({ home, relay, engine, contacts, admitted = () => true, deliver = async () => {}, log = () => {}, now = () => Date.now(), retryMs = HANDOFF_RETRY_MS }) {
  const running = new Map();
  let started = false;
  let closed = false;
  let timer = null;
  const doc = () => contacts?.currentPolicy().doc ?? null;
  const staging = createStaging({ home, contacts: doc, admitted: (sender) => admitted(sender), now, log, onStaged: (e) => (e.kind === "review_set" ? handOn(e.t) : null) });
  const outbox = createOutbox({ home, rpc: (f) => relay.rpc(f), device: () => engine().device(), now, log });

  /** The encrypted message carrying a descriptor: a file's, or a review set's with its manifest. */
  const publish = (descriptor, blobs, st) =>
    engine().send({ to: st.to, kind: "file", body: st.purpose === "review_set" ? { review_set: st.review_set, transfer: descriptor } : { transfer: descriptor }, blobs });
  const messageState = (ref) => engine().messageState(ref);

  function start(t) {
    if (running.has(t)) return running.get(t);
    const p = staging
      .fetch(t, (f) => relay.rpc(f))
      .then((r) => {
        if (r.state === "failed") log(`transfers: ${t} failed: ${r.reason}`);
        return r;
      })
      .catch((e) => log(`transfers: fetching ${t} stopped (${e.message}); it resumes later`))
      .finally(() => running.delete(t));
    running.set(t, p);
    return p;
  }

  /**
   * Hand a staged review set on to its target session (reviewSetStaged). Until a hand-over is
   * confirmed the entry stays staged with its copy: a failed or blocked one is retried after a
   * delay (doubling, at most HANDOFF_RETRY_MAX_MS) and at every attachment (ready), always with
   * the same delivery id, so the receive pipeline takes it once. The daily sweep's 7 days stay the
   * backstop. Never throws.
   */
  const handing = new Map(); // t -> the running hand-over
  const retries = new Map(); // t -> {timer, delay}
  function handOn(t) {
    if (closed || handing.has(t)) return handing.get(t);
    const r = retries.get(t);
    if (r) clearTimeout(r.timer);
    const p = (async () => {
      const e = staging.readLedger().entries[t];
      if (e?.state !== "staged" || e.kind !== "review_set") return "none";
      return (await reviewSetStaged(e, staging.dataFile(t))) ? "delivered" : "locked";
    })()
      .then(
        (state) => {
          if (state === "locked") return later(t, "its save lock is held");
          retries.delete(t);
          return state;
        },
        (x) => later(t, x.message),
      )
      .finally(() => handing.delete(t));
    handing.set(t, p);
    return p;
  }
  function later(t, why) {
    const delay = Math.min((retries.get(t)?.delay ?? retryMs / 2) * 2, HANDOFF_RETRY_MAX_MS);
    log(`transfers: the review set ${t} could not be handed on yet (${why}); retried in ${Math.round(delay / 1000)}s`);
    if (closed) return "retry";
    const timer = setTimeout(() => handOn(t), delay);
    timer.unref?.();
    retries.set(t, { timer, delay });
    return "retry";
  }

  /**
   * A staged review set: its contents reconstructed from the verified plaintext (exactly RFC 8785
   * JSON), checked against the manifest, then delivered as a review set message to its target
   * session; the staging copy is deleted only once that delivery resolved (either way). Returns
   * false when the entry's save lock is held (nothing done); throws when the delivery failed (the
   * copy stays).
   */
  async function reviewSetStaged(e, file) {
    const release = staging.saveLock(e.t);
    if (typeof release !== "function") return false;
    try {
      const cur = staging.readLedger().entries[e.t];
      if (cur?.state !== "staged") return true; // handed on meanwhile
      // Delivered before, its copy not removed yet (a failed deletion, a crash): only the removal.
      if (cur.handed) {
        if (!(await staging.remove(e.t, cur.handed === "refused" ? "its contents do not match its manifest" : null))) throw new Error("the staging copy could not be deleted");
        return true;
      }
      const bytes = fs.readFileSync(file);
      let contents = null;
      try {
        const text = bytes.toString("utf8");
        const parsed = JSON.parse(text);
        if (canonicalize(parsed) === text && parsed && typeof parsed === "object" && !Array.isArray(parsed)) contents = parsed;
      } catch {}
      const text = contents ? JSON.stringify({ hoptell_review_set: 1, review_set_id: e.review.review_set_id, manifest: e.review.manifest, contents }) : null;
      const check = text ? checkReceivedSet(text) : null;
      // A stable delivery and message id per transfer, so a repeated hand-over is deduplicated.
      const id = crypto.createHash("sha256").update(`hoptell-transfer-review-set\0${e.t}`).digest("hex");
      const messageId = `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20, 32)}`;
      const ok = check?.ok === true;
      await deliver({
        id: `transfer-${e.t}`,
        message_id: idOk(messageId),
        from: e.from.session,
        fromHost: "e2ee",
        to: e.to.session,
        text: ok ? text : `(hoptell: a review set from ${e.from.session} sent as a file transfer was refused: its contents do not match its manifest. Nothing of it is shown here.)`,
        ts: now(),
        expires: now() + 7 * 86_400_000,
        sender: { member: { id: e.from.member, name: e.from.member }, auth: "member", realm: e.from.realm },
        e2ee: { device: e.from.device, kind: "file", verified: Boolean(e.verified) },
      });
      // Confirmed: recorded before the copy goes, so a retry never delivers it twice.
      await staging.change((l) => {
        if (l.entries[e.t]?.state === "staged") l.entries[e.t].handed = ok ? "delivered" : "refused";
      });
      if (!(await staging.remove(e.t, ok ? null : "its contents do not match its manifest"))) throw new Error("the staging copy could not be deleted");
      return true;
    } finally {
      release();
    }
  }
  /**
   * Staging at an attachment: reconcile once, then resume reserved downloads and hand on staged
   * review sets. A ledger that cannot be read as it is leaves staging untouched (no reconcile, no
   * resume, no sweep) until the owner looks (hoptell doctor reports it); the next attachment tries
   * again.
   */
  async function readyStaging() {
    let ledger;
    try {
      if (!started) {
        await staging.reconcile();
        started = true;
        timer = setInterval(() => staging.sweep().catch((e) => log(`transfers: sweep failed (${e.message})`)), SWEEP_MS);
        timer.unref?.();
        staging.sweep().catch(() => {});
      }
      ledger = staging.readLedger().entries;
    } catch (e) {
      log(`transfers: the staging ledger could not be reconciled (${e.message}); staging waits for hoptell doctor`);
      return;
    }
    // File transfers resume in any session of the home; a review set only in its target session.
    for (const e of Object.values(ledger)) if (e.state === "reserved" && (e.kind === "file" || e.to?.session === relay.name)) start(e.t);
    // Review sets staged but not handed on yet (a delivery that failed, a crash before it).
    for (const e of Object.values(ledger)) if (e.kind === "review_set" && e.state === "staged" && e.to?.session === relay.name) handOn(e.t);
  }
  const idOk = (ref) => (refToId(ref).length === 16 ? ref : crypto.randomUUID());

  return {
    staging,
    outbox,
    /** The e2ee layer's onTransfer: the intake decides; an accepted transfer is fetched in the background. */
    async intake(t) {
      const r = await staging.intake(t);
      if (r.fetch) start(r.t_id);
      return { note: r.note };
    },
    /** After each attachment: reconcile once, resume reserved downloads, finish the outbox's interrupted uploads. */
    async ready() {
      await readyStaging();
      // The outbox (uploads) is apart from staging: a damaged incoming ledger never holds it up.
      try {
        const out = await outbox.recover({ publish, messageState });
        for (const o of out) if (o.state === "abandoned") log(`transfers: an interrupted upload was abandoned: ${o.reason}`);
      } catch (e) {
        if (e.code !== "busy") log(`transfers: interrupted uploads could not be finished (${e.message})`);
      }
    },
    /** Send a file: `capture(fd)` writes it once into the outbox. `to` = {member, session}. */
    sendFile: ({ to, capture, name, mediaType }) => outbox.send({ capture, publish, messageState, name, mediaType, meta: { to, purpose: "file" } }),
    /** Send a review set's contents (Buffer: RFC 8785 JSON) as a transfer, its manifest in the message. */
    sendReviewSet: ({ to, reviewSet, contents }) =>
      outbox.send({
        capture: async (fd) => {
          for (let off = 0; off < contents.length; ) off += fs.writeSync(fd, contents, off, contents.length - off);
          return { bytes: contents.length, sha256: crypto.createHash("sha256").update(contents).digest("hex") };
        },
        publish,
        messageState,
        name: `review set ${reviewSet.review_set_id}`,
        mediaType: "application/json",
        meta: { to, purpose: "review_set", review_set: reviewSet },
      }),
    /** Downloads running in this process (tests). */
    running: () => [...running.values()],
    /** Hand-overs of staged review sets running in this process (tests). */
    handing: () => [...handing.values()],
    close() {
      closed = true;
      clearInterval(timer);
      for (const r of retries.values()) clearTimeout(r.timer);
      retries.clear();
    },
  };
}

/** The serialized contents of a review set sent as a transfer (RFC 8785 JSON). */
export const reviewSetContents = (set) => Buffer.from(canonicalize(set.contents), "utf8");
