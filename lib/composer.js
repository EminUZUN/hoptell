// Several relays for one agent session (design 2.1 v3): one single-relay engine per receiving link,
// composed into one front end. The composer routes addresses (name@alias; bare addresses only to
// the default relay), merges peer lists and reads, issues composite receipts bound to each store's
// immutable identity, and owns the session's one notifier over every link's pending messages.
// Nothing is ever forwarded from one relay to another.
import fs from "node:fs";
import path from "node:path";
import { RelayClient, describeAck, formatPeer, parseRef } from "./client.js";
import { ensurePrivateDir, MAX_TTL_S } from "./config.js";
import { resolveDelivery } from "./delivery.js";
import { createEngine, deliveryLabel } from "./engine.js";
import { findClaudeHost } from "./host.js";
import * as inbox from "./inbox.js";
import { tokenSource } from "./login.js";
import { writeRecord } from "./locks.js";
import { checkReply, routesStore } from "./routes.js";
import { NoticeScheduler } from "./notices.js";
import { profileKey } from "./profiles.js";
import { labelOf, routeOf, parseAddress } from "./relays.js";
import { BATCH_BYTES, BATCH_MAX } from "./store.js";
import { hookChannel } from "./wake.js";

const RECEIPT_MAX = 8 * 1024;
const RECEIPT_PARTS = 16;
const RESERVED_BYTES = RECEIPT_MAX + 4096; // the receipt and the notes are budgeted before taking
const LINK_WAIT_MS = 2000; // one slow link never stalls the others
const WAIT_MAX_S = 1500;

const text = (t, isError = false) => ({ content: [{ type: "text", text: t }], isError });
const within = (p, ms, fallback) => Promise.race([p, new Promise((r) => setTimeout(() => r(fallback), ms).unref?.())]);
const b64url = (s) => Buffer.from(s).toString("base64url");
const randomHex = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((x) => x.toString(16).padStart(2, "0")).join("");
const sameScope = (a, b) => Boolean(a && b) && ["profile", "realm", "member", "folder"].every((k) => (a[k] ?? null) === (b[k] ?? null));

/** Parse a composite receipt strictly: {v:1, parts:[{scope, receipt}]} or null when it is not one. */
export function parseComposite(receipt) {
  const s = String(receipt ?? "");
  if (!s.startsWith("r2.")) return null;
  if (s.length > RECEIPT_MAX) throw new Error("the receipt is too long");
  let doc;
  try {
    doc = JSON.parse(Buffer.from(s.slice(3), "base64url").toString("utf8"));
  } catch {
    throw new Error("the receipt is malformed");
  }
  const str = (v) => v === null || (typeof v === "string" && v.length <= 200);
  const ok =
    doc?.v === 1 &&
    Array.isArray(doc.parts) &&
    doc.parts.length >= 1 &&
    doc.parts.length <= RECEIPT_PARTS &&
    doc.parts.every((p) => p && typeof p.receipt === "string" && p.receipt.length <= 200 && p.scope && ["profile", "realm", "member", "folder"].every((k) => str(p.scope[k] ?? null)));
  if (!ok) throw new Error("the receipt is malformed");
  return doc;
}

/**
 * Create a composed session. `relays`: the parsed relays file ({relays, default, problems}).
 * Returns the same interface as an engine (attach, start, stop, instructions, tools, call).
 */
export function createComposer(settings, relays, { log = () => {}, findHost = findClaudeHost, keepAlive = false, engineOptions = {}, allowChannel = true } = {}) {
  const { home } = settings;
  const several = relays.relays.length > 1;
  let state = "created";
  let stopping = null;
  let starting = null;
  const attachments = new Set();
  const stopSignal = new AbortController();
  const each = (fn) => {
    for (const a of [...attachments]) {
      try {
        const r = fn(a);
        if (r?.catch) r.catch(() => {});
      } catch {}
    }
  };

  // ---- links ------------------------------------------------------------------------------
  const linkSettings = (entry) => ({
    ...settings,
    name: entry.name ?? (entry.namePrefix && settings.name ? `${entry.namePrefix}${settings.name}`.slice(0, 64) : settings.name),
    push: "listener", // the composer owns notices
    errors: { ...settings.errors, relay: entry.tokenProblem ?? null },
    relay: entry.tokenProblem ? null : { url: entry.url, token: entry.auth === "token" ? entry.token : null, auth: entry.auth, protocol: settings.protocol, profile: entry.profile, credentialStore: settings.signIn.credentialStore, passphrase: settings.signIn.passphrase },
  });
  const links = []; // {entry, profile, engine} for receiving links
  const sendOnly = new Map(); // alias -> {entry, client, opened}
  for (const entry of relays.relays) {
    const profile = (() => {
      try {
        return profileKey(entry.url, entry.profile);
      } catch {
        return null;
      }
    })();
    if (!entry.join) {
      sendOnly.set(entry.alias, { entry, profile, client: null });
      continue;
    }
    const engine = createEngine(linkSettings(entry), { log: (...a) => log(`[${entry.alias}]`, ...a), findHost: () => null, keepAlive: true, link: { alias: entry.alias, legacyScope: several ? profile : null }, ...engineOptions });
    links.push({ entry, profile, engine });
  }
  // The tool catalog and instructions, also when every relay is send-only (no receiving engine):
  // an engine that is never started describes them.
  const first = relays.relays.find((e) => !e.tokenProblem) ?? relays.relays[0];
  const catalog = links[0]?.engine ?? (first ? createEngine(linkSettings(first), { log: () => {}, findHost: () => null, keepAlive: true, link: { alias: first.alias }, ...engineOptions }) : null);
  const aliases = relays.relays.map((e) => e.alias);
  const aliasOfProfile = (profile) => relays.relays.find((e) => profileKeySafe(e) === profile)?.alias ?? null;
  function profileKeySafe(e) {
    try {
      return profileKey(e.url, e.profile);
    } catch {
      return null;
    }
  }
  const linkByAlias = (alias) => links.find((l) => l.entry.alias === alias) ?? null;

  // ---- origins of messages (for reply routing): shared with other sessions and the CLI ------
  const routes = routesStore(home);

  // ---- the session's one notifier ----------------------------------------------------------
  let delivery = { mode: "listener", requested: settings.push, hook: null, verified: false };
  let scheduler = null;
  let schedulerTimer = null;
  const pendingAll = async () => {
    const lists = await Promise.all(links.map((l) => within(l.engine.link.pending().catch(() => []), LINK_WAIT_MS, [])));
    // Stable keys (the scheduler remembers what it announced by these strings).
    return lists.flatMap((list, i) => list.map((f) => `${links[i].entry.alias}/${f}`));
  };
  const storesFile = () => (settings.name ? path.join(home, "sessions", `${settings.name}.stores.json`) : null);
  function publishStores() {
    // For hoptell tmux's injector: every store this composed session reads.
    const f = storesFile();
    if (!f) return;
    const stores = links
      .map((l) => {
        const st = l.engine.session.store;
        return { alias: l.entry.alias, scope: l.engine.link.scope(), dir: st?.dir ?? null, legacy: st?.legacy ? { home: st.home, name: st.name } : null };
      })
      .filter((x) => x.scope);
    try {
      ensurePrivateDir(path.dirname(f));
      writeRecord(f, { v: 1, stores });
    } catch {}
  }

  // ---- reads ------------------------------------------------------------------------------
  let rotate = 0;
  async function gather({ waitMs, signal = null }) {
    const deadline = Date.now() + waitMs;
    const gone = () => stopSignal.signal.aborted || Boolean(signal?.aborted);
    for (;;) {
      const counts = await Promise.all(links.map((l) => within(l.engine.link.pending().then((p) => p.length).catch(() => 0), LINK_WAIT_MS, 0)));
      if (counts.some((n) => n > 0) || Date.now() >= deadline || gone()) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    if (gone()) return { taken: [], parts: [], notes: [], finish: [] }; // a cancelled wait takes nothing
    let maxMessages = BATCH_MAX;
    let maxBytes = BATCH_BYTES - RESERVED_BYTES;
    const taken = [];
    const parts = [];
    const notes = [];
    // How each link's batch is finished: committed once the result is final, released otherwise.
    const finish = [];
    const order = links.map((_, i) => links[(i + rotate) % links.length]);
    rotate = (rotate + 1) % Math.max(1, links.length);
    for (const l of order) {
      if (taken.length && (maxMessages <= 0 || maxBytes <= 0)) break;
      if (parts.length >= RECEIPT_PARTS) break;
      // One link at a time: checking its held batch, taking and registering a new one happen as one
      // step, so overlapping reads never overwrite each other's batches.
      let b;
      let scope;
      try {
        b = await linkLock(l.entry.alias, async () => {
          // A protocol-1 batch already shown and not yet acknowledged comes again first (as a store's
          // held batch does), if it fits.
          const cur = current.get(l.entry.alias);
          const heldBatch = cur && held.get(cur);
          if (heldBatch) {
            const size = heldBatch.messages.reduce((n, m) => n + Buffer.byteLength(JSON.stringify(m.msg ?? {})), 0);
            if (taken.length && (heldBatch.messages.length > maxMessages || size > maxBytes)) return null;
            return { kind: "legacy-held", messages: heldBatch.messages.map((m) => ({ ...m, redelivered: true })), receipt: cur };
          }
          // One-message allowance only for an otherwise empty result; later links take what fits.
          // Never raced against a timer: a take is a local store operation, and whatever it took is
          // returned (or released below), never dropped.
          const r = await l.engine.link.take({ max: Math.max(1, maxMessages), maxBytes: Math.max(1, maxBytes), strict: taken.length > 0 });
          if (r?.kind === "legacy") {
            // Protocol 1 has no receipts: the composer holds the claimed files under its own receipt
            // until it is acknowledged; they come back to the inbox after the lease or at stop.
            const receipt = `l_${randomHex(12)}`;
            held.set(receipt, { alias: l.entry.alias, messages: r.messages, commit: r.commit, release: r.release, until: Date.now() + settings.leaseMinutes * 60_000 });
            current.set(l.entry.alias, receipt);
            return { ...r, receipt };
          }
          return r;
        });
      } catch (e) {
        notes.push(`(Messages from ${l.entry.alias} could not be read now: ${e.message}.)`);
        continue;
      }
      if (!b) continue;
      if (b.kind === "broken") {
        notes.push(`(${b.note})`);
        continue;
      }
      for (const d of b.damaged ?? []) notes.push(`(A stored message was damaged and was set aside, unread, in ${d}.)`);
      if (!b.messages.length) continue;
      scope = l.engine.link.scope();
      // A composed read never deletes anything: every batch is acknowledged only by its receipt
      // (a separate, explicit call), so a read cancelled at any point loses nothing. A cancelled or
      // failed read gives back what it took.
      if (b.kind === "bound" && b.receipt) {
        parts.push({ scope, receipt: b.receipt });
        finish.push({ release: () => l.engine.link.release() });
      } else if (b.kind === "legacy") {
        parts.push({ scope, receipt: b.receipt });
        const receipt = b.receipt;
        finish.push({ release: () => releaseBatch(receipt) });
      } else if (b.kind === "legacy-held") parts.push({ scope, receipt: b.receipt });
      for (const m of b.messages) {
        const bytes = Buffer.byteLength(JSON.stringify(m.msg ?? {}));
        maxBytes -= bytes;
        maxMessages--;
        taken.push({ ...m, alias: l.entry.alias, scope, arrived: Number(String(m.file ?? "").slice(0, 13)) || m.msg?.ts || 0, file: m.file ?? "" });
      }
    }
    taken.sort((a, b) => a.arrived - b.arrived || a.alias.localeCompare(b.alias) || a.file.localeCompare(b.file));
    await routes.note(taken.map((t) => ({ ref: t.msg?.message_id, profile: t.scope?.profile, realm: t.scope?.realm }))).catch((e) => log("could not record message origins:", e.message));
    return { taken, parts, notes, finish };
  }

  /** A cancelled or failed read gives back everything it took (nothing is ever committed here). */
  async function giveBack(g) {
    for (const f of g.finish) await f.release().catch((e) => log("could not give back a read:", e.message));
  }

  // Protocol-1 batches held under the composer's receipts: receipt -> {alias, messages, commit,
  // release, until}; the batch shown again per link; and recently completed receipts (an ack
  // repeated after success is fine). A failed commit or release keeps its batch for a retry.
  const held = new Map();
  const current = new Map();
  const completed = new Map();
  const locks = new Map();
  /** Serialize one link's held-batch transitions (check/take/register, ack, release). */
  function linkLock(alias, fn) {
    const prev = locks.get(alias) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    locks.set(alias, next.catch(() => {}));
    return next;
  }
  const forget = (receipt, alias) => {
    held.delete(receipt);
    if (current.get(alias) === receipt) current.delete(alias);
  };
  /** Give a held batch back to its inbox (lease, stop, a cancelled read). */
  function releaseBatch(receipt) {
    const b = held.get(receipt);
    if (!b) return Promise.resolve();
    return linkLock(b.alias, async () => {
      if (!held.has(receipt)) return;
      await b.release(); // throws: kept, tried again later
      forget(receipt, b.alias);
    });
  }
  /** Acknowledge a held batch: "ok" (also when already done), "unknown" or "error" (kept for a retry). */
  function commitBatch(receipt, alias) {
    return linkLock(alias, async () => {
      if (completed.has(receipt)) return "ok";
      const b = held.get(receipt);
      if (!b || b.alias !== alias) return "unknown";
      try {
        await b.commit();
      } catch {
        return "error";
      }
      forget(receipt, alias);
      completed.set(receipt, Date.now());
      for (const [r, at] of completed) if (completed.size > 512 || Date.now() - at > 86400_000) completed.delete(r);
      return "ok";
    });
  }
  const legacySweep = setInterval(() => {
    for (const [r, b] of held) if (Date.now() > b.until) releaseBatch(r).catch((e) => log("could not give back a held batch:", e.message));
  }, 30_000);
  legacySweep.unref?.();

  function render({ taken, parts, notes }, leaseMinutes) {
    if (!taken.length) return notes.length ? notes.join("\n") : "Inbox empty.";
    const body = taken.map((t) => `${t.redelivered ? "(Shown again: it was not acknowledged in time.)\n" : ""}${inbox.format({ ...t.msg, from: labelOf(t.msg.from, t.alias, several) })}`);
    let receipt = "";
    if (parts.length) {
      const r = `r2.${b64url(JSON.stringify({ v: 1, parts }))}`;
      receipt = `\n\nReceipt: ${r}. When you have handled these messages, pass it as "ack" in your next read_inbox or wait_for_message call, or call ack_messages. Messages not acknowledged are shown again after ${leaseMinutes} minute${leaseMinutes === 1 ? "" : "s"}.`;
    }
    return `${[...notes, ...body].join("\n\n")}\n\n${inbox.batchNote(taken.map((t) => t.msg))}${receipt}`;
  }

  /** Acknowledge a receipt: each part in the link whose store it names. Returns a note or "". */
  async function acknowledge(receipt) {
    if (receipt == null) return "";
    const doc = parseComposite(receipt);
    if (!doc) {
      // A single store's receipt (receipt ids are random per store: it can only match its own).
      for (const l of links) if ((await l.engine.link.ack(receipt).catch(() => "unknown")) === "ok") return "";
      return `(Unknown receipt ${JSON.stringify(String(receipt).slice(0, 40))}: it may have expired, so its messages were shown again, or be mistyped.)\n\n`;
    }
    const failed = [];
    // Right after a start, links may not have their relay's welcome (and store) yet: wait briefly.
    const owner = async (scope) => {
      for (const end = Date.now() + 5000; ; await new Promise((r) => setTimeout(r, 100))) {
        const l = links.find((x) => sameScope(x.engine.link.scope(), scope));
        if (l || Date.now() >= end || links.every((x) => x.engine.link.scope()) || stopSignal.signal.aborted) return l ?? null;
      }
    };
    for (const p of doc.parts) {
      const l = await owner(p.scope);
      let r;
      if (l && p.receipt.startsWith("l_")) {
        r = await commitBatch(p.receipt, l.entry.alias); // a protocol-1 batch held by this composer
      } else r = l ? await l.engine.link.ack(p.receipt).catch(() => "error") : "no such store";
      if (r !== "ok") failed.push(`${l?.entry.alias ?? "an unknown relay"} (${r})`);
    }
    return failed.length ? `(Part of the receipt was not acknowledged: ${failed.join(", ")}. The other parts were; acknowledging the same receipt again retries only what is left.)\n\n` : "";
  }

  // ---- sends ------------------------------------------------------------------------------
  async function sendOnlyClient(alias) {
    const s = sendOnly.get(alias);
    if (s.client) return s.client;
    const e = s.entry;
    if (e.tokenProblem) throw new Error(`relay ${alias}: ${e.tokenProblem}`);
    const signIn = e.auth === "login" ? tokenSource({ home, relayUrl: e.url, profile: s.profile, passphrase: settings.signIn.passphrase }) : null;
    s.client = new RelayClient({ url: e.url, token: signIn ? null : e.token, signIn, name: e.name ?? null, mode: "send", reconnect: true });
    s.client.on("fatal", (r) => log(`[${alias}] relay refused: ${r}`));
    s.client.start();
    await s.client.ready(10_000);
    return s.client;
  }

  async function routeSend(args) {
    if (typeof args.to !== "string") throw new Error("`to` is required");
    const r = routeOf(args.to, { aliases, defaultAlias: relays.default });
    const target = r.kind === "peer" ? r.target : `@${r.target}`;
    if (args.reply_to != null) {
      const ref = parseRef(args.reply_to);
      checkReply({ origins: routes.lookup(ref), routeProfile: profileKeySafe(relays.relays.find((e) => e.alias === r.relay)), target, qualified: Boolean(parseAddress(args.to).alias), several, aliasOf: aliasOfProfile, aliases });
    }
    return { relay: r.relay, target };
  }

  async function call(tool, args = {}, { signal = null } = {}) {
    try {
      if (tool === "ack_messages") {
        if (typeof args.receipt !== "string") throw new Error("`receipt` is required");
        const note = await acknowledge(args.receipt);
        return note ? text(note.trim(), true) : text("Acknowledged.");
      }
      if (tool === "read_inbox" || tool === "wait_for_message") {
        const note = await acknowledge(args.ack);
        const secs = tool === "wait_for_message" ? Math.min(Math.max(Number(args.timeout_seconds) || 300, 1), WAIT_MAX_S) : 0;
        const g = await gather({ waitMs: secs * 1000, signal });
        let result;
        try {
          const decisions = (await links[0]?.engine.link.pendingDecisions?.()) ?? "";
          result = !g.taken.length && tool === "wait_for_message" ? text(`${note}${g.notes.length ? `${g.notes.join("\n")}\n` : ""}No messages within ${secs}s.${decisions}`) : text(note + render(g, settings.leaseMinutes) + decisions);
        } catch (e) {
          await giveBack(g); // nothing taken is lost: it is shown again
          throw e;
        }
        // A request cancelled meanwhile never reaches the agent (the MCP layer drops its result):
        // everything it took goes back. Nothing was deleted either way: only a receipt does that.
        if (signal?.aborted || stopSignal.signal.aborted) {
          await giveBack(g);
          return text("The read was cancelled; its messages stay waiting.", true);
        }
        return result;
      }
      if (tool === "list_peers") {
        const rows = [];
        const wanted = typeof args.relay === "string" ? args.relay : null;
        for (const l of links) {
          if (wanted && wanted !== l.entry.alias) continue;
          const st = l.engine.link.status();
          const peers = await within(l.engine.link.list().catch(() => null), 5000, null);
          rows.push(`${l.entry.alias} (${l.entry.url})${l.entry.alias === relays.default ? ", default" : ""}: ${peers ? `you are "${labelOf(st.name, l.entry.alias, several)}"` : `down${st.error ? ` (${st.error})` : ""}`}`);
          for (const p of peers ?? []) rows.push(`- ${formatPeer({ ...p, name: labelOf(p.name, l.entry.alias, several) })}`);
        }
        for (const [alias, s] of sendOnly) {
          if (wanted !== alias && !s.client) continue;
          try {
            const c = await sendOnlyClient(alias);
            const peers = await c.list();
            rows.push(`${alias} (${s.entry.url}), send-only:`);
            for (const p of peers) rows.push(`- ${formatPeer({ ...p, name: labelOf(p.name, alias, several) })}`);
          } catch (e) {
            rows.push(`${alias} (${s.entry.url}), send-only: down (${e.message})`);
          }
        }
        for (const p of relays.problems) rows.push(`${p.alias}: not usable (${p.problem})`);
        return text(`Delivery: ${deliveryLabel(delivery)}. Bare names go to ${relays.default ? `"${relays.default}"` : "no relay (say name@relay)"}.\n${rows.join("\n")}`);
      }
      if (tool === "send_message" || tool === "send_file" || tool === "send_review_set") {
        const { relay, target } = await routeSend(args);
        const l = linkByAlias(relay);
        if (l) return l.engine.call(tool, { ...args, to: target });
        if (tool !== "send_message") throw new Error(`${tool} needs a relay this session has joined`);
        if (typeof args.message !== "string") throw new Error("`message` is required");
        const ttl = args.ttl_seconds ?? undefined;
        if (ttl !== undefined && !(Number.isInteger(ttl) && ttl >= 1 && ttl <= MAX_TTL_S)) throw new Error(`ttl_seconds must be a whole number from 1 to ${MAX_TTL_S}`);
        const replyTo = args.reply_to == null ? undefined : parseRef(args.reply_to);
        const c = await sendOnlyClient(relay);
        return text(describeAck(`${target}@${relay}`, await c.send(target, args.message, ttl, replyTo), ttl, replyTo));
      }
      if (tool === "ask_owner") {
        // The first joined relay whose realm has a trusted owner channel (design 7.2).
        const l = links.find((x) => x.engine.link.askOwnerReady()) ?? links.find((x) => x.engine.link.askOwnerTool());
        if (!l) throw new Error("no owner channel is trusted for the relays of this session (run hoptell telegram trust on this machine)");
        return l.engine.call(tool, args);
      }
      if (tool === "verify_snapshot" || tool === "verify_review_set") return (links[0] ?? { engine: { call: () => text("no relay", true) } }).engine.call(tool, args);
      return text(`unknown tool ${tool}`, true);
    } catch (e) {
      return text(`hoptell error: ${e.message}`, true);
    }
  }

  async function startUp() {
    for (const l of links) {
      l.engine.attach({
        notify: (m) => each((a) => a.notify?.({ ...m, from: labelOf(m.from, l.entry.alias, several) })),
        onCatalogChanged: () => {
          publishStores();
          each((a) => a.onCatalogChanged?.());
        },
      });
    }
    await Promise.all(links.map((l) => l.engine.start()));
    try {
      delivery = await resolveDelivery({
        value: settings.errors.push ? "listener" : settings.push === "auto" ? "" : settings.push,
        findHost,
        allowChannel,
        armHook: async (host) => {
          let channel = null;
          try {
            channel = hookChannel({ home, host, peer: () => settings.name ?? links[0]?.engine.session.name ?? null, log, barrier: settings.barriers.wake, signal: stopSignal.signal });
          } catch (e) {
            log("hook delivery unavailable:", e.code || "setup failed");
          }
          return channel ? { state: await channel.arm(), channel } : { state: "unverified", channel: null };
        },
      });
    } catch (e) {
      log(e.message);
    }
    if (state !== "running") return;
    if (delivery.channelRefused) log("HOPTELL_PUSH=channel, but this client did not negotiate the channel extension: messages wait for read_inbox");
    if (delivery.hook) {
      // One notifier over every link's pending messages, independent of any one relay.
      scheduler = new NoticeScheduler({ list: pendingAll, send: () => delivery.hook.notify() });
      schedulerTimer = setInterval(() => scheduler.tick().catch(() => {}), 1000);
      schedulerTimer.unref?.();
      scheduler.tick().catch(() => {});
    }
    publishStores();
  }

  return {
    get state() {
      return state;
    },
    get session() {
      return { ...(links[0]?.engine.session ?? { state: "pending" }), composed: true };
    },
    get delivery() {
      return delivery;
    },
    /** The aggregate pending list the notifier uses (stable "alias/file" keys). */
    noticeList: () => pendingAll(),
    get links() {
      return links.map((l) => ({ alias: l.entry.alias, engine: l.engine }));
    },
    attach({ notify, onCatalogChanged } = {}) {
      if (state === "stopping" || state === "stopped") throw new Error("this hoptell session has stopped");
      const a = { notify, onCatalogChanged };
      attachments.add(a);
      let detached = false;
      const composer = this;
      return {
        detach() {
          if (detached) return;
          detached = true;
          attachments.delete(a);
          if (!attachments.size && !keepAlive) composer.stop();
        },
      };
    },
    start() {
      if (state !== "created") return starting ?? Promise.resolve();
      state = "running";
      starting = startUp();
      return starting;
    },
    stop() {
      if (stopping) return stopping;
      state = "stopping";
      attachments.clear();
      stopping = (async () => {
        stopSignal.abort();
        await starting?.catch(() => {});
        clearInterval(schedulerTimer);
        clearInterval(legacySweep);
        for (const r of [...held.keys()]) await releaseBatch(r).catch((e) => log("could not give back a held batch:", e.message));
        delivery.hook?.close();
        for (const s of sendOnly.values()) s.client?.close();
        await Promise.allSettled([...links.map((l) => l.engine.stop()), ...(catalog && !links.some((l) => l.engine === catalog) ? [catalog.stop()] : [])]);
        const f = storesFile();
        if (f) fs.rmSync(f, { force: true });
        state = "stopped";
      })();
      return stopping;
    },
    instructions() {
      const base = catalog?.instructions({ delivery }) ?? ""; // this session's delivery, not the link's
      const note = `This session is connected to several hoptell relays: ${aliases.join(", ")}. Every read ends with a receipt; pass it as "ack" once you handled the messages. Address peers as name@relay (also @role@relay, @all@relay); a bare name goes to ${relays.default ? `"${relays.default}"` : "no relay, so always add @relay"}. Messages show their relay as from "name@relay"; reply through the same relay.`;
      return several ? `${note}\n${base}` : base;
    },
    async tools() {
      let list = (await catalog?.tools()) ?? [];
      // ask_owner is offered when a joined relay's realm has a trusted owner channel (before a
      // link is bound: when this home trusts any; see engine.js ownerListed).
      const ask = links.map((l) => l.engine.link.askOwnerTool()).find(Boolean);
      list = list.filter((t) => t.name !== "ask_owner").concat(ask ? [ask] : []);
      if (!several) return list;
      return list.map((t) =>
        t.name === "send_message" || t.name === "send_file" || t.name === "send_review_set"
          ? { ...t, inputSchema: { ...t.inputSchema, properties: { ...t.inputSchema.properties, to: { ...t.inputSchema.properties.to, description: `${t.inputSchema.properties.to?.description ?? ""} With several relays: name@relay, @role@relay or @all@relay; a bare name goes to the default relay.`.trim() } } } }
          : t.name === "list_peers"
            ? { ...t, inputSchema: { ...(t.inputSchema ?? { type: "object" }), properties: { ...(t.inputSchema?.properties ?? {}), relay: { type: "string", description: "Optional: list only this relay (also a send-only one)." } } } }
            : t,
      );
    },
    call,
  };
}
