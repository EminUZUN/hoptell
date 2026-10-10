// Data retention of the hosted endpoint (design 4.5, "Data retention"):
//
//   inbox messages    until acknowledged; at the latest 7 days after arrival (deleted here)
//   quarantine        1.5's rules (7 days per message, by the contacts' own expiry)
//   receipts, seen    the store's own pruning (done markers 24 hours, seen records 8 days)
//   tenant data       after an unlink or member removal: the engine stops at once (its sessions
//                     end) and the home is deleted at the next sweep, within 24 hours; logged
//
// A member the relay confirmed it no longer holds (removed.json, see lib/hostedtenants.js) is
// cleaned up the same way as an unlink.
//
// Deletions are progress writes: they run at either free-space floor. Nothing is deleted while
// the link table cannot be read (an unreadable table never means "unlinked"). OWNER-OPEN (open
// point 4): retention periods, backups of tenant stores and encryption at rest are the
// operator's and owner's to decide; the values below are the design's defaults.
import fs from "node:fs";
import path from "node:path";
import { openStore } from "./store.js";
import { tenantKey } from "./hosted.js";

export const DEFAULT_RETENTION = Object.freeze({ messageDays: 7, sweepMs: 3600_000, unlinkCheckMs: 30_000, stopWaitMs: 5000 });

/** The bound session stores under a tenant home (<home>/v2/<realm>/<member>/<key>/). */
function storesOf(home) {
  const out = [];
  const v2 = path.join(home, "v2");
  const dirs = (d) => {
    try {
      return fs.readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.isSymbolicLink()).map((e) => path.join(d, e.name));
    } catch {
      return [];
    }
  };
  for (const realm of dirs(v2)) for (const member of dirs(realm)) for (const key of dirs(member)) if (fs.existsSync(path.join(key, "store.json"))) out.push(key);
  return out;
}

/**
 * The retention sweep. `server` (lib/hosted.js) ends a tenant's sessions; `tenants` stops its
 * engine. Returns {sweep(), stop()}; sweep() resolves to what it did.
 */
export function createRetention({ config, stateDir, links, tenants, server = null, log = () => {}, now = () => Date.now(), retention = {}, rm = fs.rmSync, storeFault = null }) {
  const R = { ...DEFAULT_RETENTION, ...(config.retention ?? {}), ...retention };
  if (!Number.isSafeInteger(R.messageDays) || R.messageDays < 1) throw new Error("retention.messageDays must be a whole number of days, at least 1");
  const root = path.join(stateDir, "tenants");

  async function sweep({ expire = true } = {}) {
    const done = { stopped: 0, deleted: 0, expired: 0 };
    let linked;
    try {
      // Linked and still held by the relay: a member the relay confirmed removed goes like an unlink.
      linked = new Set(links.all().filter((l) => !links.removed(l.member.id)).map((l) => tenantKey(config.realm, l.member.id)));
    } catch (e) {
      log(`retention: the link table cannot be read (${e.message}); nothing is deleted`);
      return done;
    }
    // Unlinked or removed tenants: the engine stops at once, then the home goes.
    for (const r of tenants.runtimes()) {
      if (linked.has(r.key)) continue;
      await server?.endTenant(r.key, "unlinked");
      // The engine's stop drains its store work: its home is deleted only once the stop has
      // finished (the runtime goes then), at this sweep if it ends soon, else at a later one.
      const stopped = tenants.stopTenant(r.key).catch(() => {});
      await Promise.race([stopped, new Promise((res) => setTimeout(res, R.stopWaitMs).unref?.())]);
      done.stopped++;
    }
    let homes = [];
    try {
      homes = fs.readdirSync(root).filter((n) => /^[0-9a-f]{64}$/.test(n));
    } catch {}
    for (const key of homes) {
      if (linked.has(key) || tenants.runtime(key)) continue;
      try {
        rm(path.join(root, key), { recursive: true, force: true });
        done.deleted++;
        log(JSON.stringify({ event: "hosted.tenant-deleted", tenant: key.slice(0, 12), at: new Date(now()).toISOString() }));
      } catch (e) {
        log(`retention: a tenant home could not be deleted (${e.code ?? e.message}); tried again at the next sweep`);
      }
    }
    if (!expire) return done;
    // Inbox messages: at the latest messageDays after arrival, acknowledged or not.
    const cutoff = now() - R.messageDays * 86_400_000;
    for (const key of homes.filter((k) => linked.has(k))) {
      for (const store of storesOf(path.join(root, key))) {
        try {
          // The store's own expiry, under its lock and journal: claimed batches are reconciled as units.
          const st = await openStore({ dir: store, inbox: path.join(store, "inbox"), seen: path.join(store, "seen") }, { fault: storeFault });
          done.expired += await st.expire(cutoff);
        } catch (e) {
          log(`retention: an expiry sweep failed (${e.code ?? e.message}); tried again at the next sweep`);
        }
      }
    }
    return done;
  }

  const timer = setInterval(() => sweep().catch((e) => log(`retention: ${e.message}`)), R.sweepMs);
  timer.unref();
  // An unlink stops the tenant's engine within this check (its sessions end at once with it).
  const quick = setInterval(() => sweep({ expire: false }).catch((e) => log(`retention: ${e.message}`)), R.unlinkCheckMs);
  quick.unref();
  return { sweep, stop: () => (clearInterval(timer), clearInterval(quick)) };
}
