// Stored data limits of the hosted endpoint (design 4.5, "Rate limits, quotas and storage"):
//
//   per tenant  a cap on stored messages and bytes across its inbox and quarantine (inbound only);
//   per host    a byte budget over every durable file under <host state> (inbox, quarantine and
//               holds, operation records, receipts, seen and replay records, journals, contacts,
//               the link table, owner login and session records);
//   the volume  two free-space thresholds: an admission floor and a lower hard floor, the space
//               between them reserved for progress and cleanup.
//
// Two classes of writes. Admission (new payload or a new operation: storing an inbound message,
// quarantine intake, a new send, owner decisions that add state) is refused at the tenant's cap
// (inbound only), the host budget or the admission floor. Progress and cleanup (claiming a batch,
// acknowledging, returning a lease, sweeps, journal completion, deletions, owner decisions that
// only remove data, and the small owner-page login and session records) run below the admission
// floor down to the hard floor; below it only deletions run (the store's write hook refuses new
// file contents; renames and deletions go on).
//
// Receiving resumes with hysteresis: once usage is below the budget (and the tenant's cap) by the
// margin and free space is above the admission floor plus the margin.
//
// OWNER-OPEN (open point 8): every value below is the owner's to decide; these are placeholders.
import fs from "node:fs";
import path from "node:path";

export const DEFAULT_STORAGE = Object.freeze({
  tenantMessages: 1000,
  tenantBytes: 50 * 1024 * 1024,
  hostBytes: 10 * 1024 * 1024 * 1024,
  admissionFloorBytes: 2 * 1024 * 1024 * 1024,
  hardFloorBytes: 512 * 1024 * 1024,
  resumeMarginBytes: 64 * 1024 * 1024,
  resumeMarginMessages: 10,
  usageCacheMs: 5000,
});

/** Total size of every regular file under `dir` (symbolic links are not followed). */
function treeBytes(dir) {
  let n = 0;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    if (e.code === "ENOENT") return 0;
    throw e;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) n += treeBytes(p);
    else if (e.isFile()) {
      try {
        n += fs.statSync(p).size;
      } catch {}
    }
  }
  return n;
}

/** Messages a tenant stores: JSON files in its inbox, claimed batches and quarantine. */
function tenantMessages(home) {
  const out = { count: 0, bytes: 0 };
  const walk = (dir, inMessages) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, inMessages || ["inbox", "claimed", "quarantine"].includes(e.name));
      else if (inMessages && e.isFile() && e.name.endsWith(".json") && !/^r_[a-z2-7]{26}\.json$/.test(e.name)) {
        out.count++;
        try {
          out.bytes += fs.statSync(p).size;
        } catch {}
      }
    }
  };
  walk(home, false);
  return out;
}

const statfsFree = (dir) => {
  const s = fs.statfsSync(dir);
  return s.bavail * s.bsize;
};

/**
 * The host's storage guard. `freeBytes(dir)` (tests) replaces the volume's free space. Returns
 * {forTenant(home) -> {admit, hasRoom, fault, full}, admitHost(bytes), state()}.
 */
export function createStorageGuard({ stateDir, limits = {}, freeBytes = statfsFree, log = () => {}, now = () => Date.now() }) {
  const L = { ...DEFAULT_STORAGE, ...limits };
  for (const [k, v] of Object.entries(L)) if (!Number.isSafeInteger(v) || v < 0) throw new Error(`storage.${k} must be a whole number of bytes (or ms)`);
  if (L.hardFloorBytes > L.admissionFloorBytes) throw new Error("storage.hardFloorBytes must not be above storage.admissionFloorBytes");
  let cache = null; // {bytes, at}
  const hostUsage = () => {
    if (!cache || now() - cache.at >= L.usageCacheMs) cache = { bytes: treeBytes(stateDir), at: now() };
    return cache.bytes;
  };
  const free = () => freeBytes(stateDir);
  const counts = { refusedAdmission: 0, refusedProgress: 0 };

  /** Why an admission of `bytes` is refused at the host (budget or floor), or null. */
  function hostRefusal(bytes, margin = 0) {
    if (free() - bytes < L.admissionFloorBytes + margin) return "the host's disk is at its admission floor";
    if (hostUsage() + bytes > L.hostBytes - margin) return "the host's storage budget is used up";
    return null;
  }

  return {
    limits: L,
    counts,
    /** An admission write of `bytes` outside a tenant's inbox (a new send's operation, an owner decision): refusal text or null. */
    admitHost(bytes) {
      const why = hostRefusal(bytes);
      if (why) counts.refusedAdmission++;
      else if (cache) cache.bytes += bytes;
      return why;
    },
    /** Whether a progress write may still run (above the hard floor). */
    progressAllowed: () => free() >= L.hardFloorBytes,
    /** The hooks for one tenant's stores. */
    forTenant(home) {
      const t = { full: false };
      const tenantRefusal = (bytes, margin = 0) => {
        const u = tenantMessages(home);
        if (u.count + 1 > L.tenantMessages - (margin ? L.resumeMarginMessages : 0) || u.bytes + bytes > L.tenantBytes - margin) return "the hosted inbox is full; read or acknowledge messages";
        return null;
      };
      return {
        get full() {
          return t.full;
        },
        /** Admission of an inbound message (inbox or quarantine): refusal text or null. */
        admit(bytes) {
          const why = tenantRefusal(bytes) ?? hostRefusal(bytes);
          if (why) {
            counts.refusedAdmission++;
            if (!t.full) log(`storage: inbound refused for a tenant (${why}); it waits at the relay`);
            t.full = true;
          } else if (cache) cache.bytes += bytes;
          return why;
        },
        /** Resume check (hysteresis): room for `bytes` with the margin on every limit. */
        hasRoom(bytes) {
          const ok = !tenantRefusal(bytes, L.resumeMarginBytes) && !hostRefusal(bytes, L.resumeMarginBytes);
          if (ok) t.full = false;
          return ok;
        },
        /** The store's write hook: below the hard floor no new file contents are written (deletions and renames go on). */
        fault(point) {
          if (point === "write" && free() < L.hardFloorBytes) {
            counts.refusedProgress++;
            throw Object.assign(new Error("ENOSPC: the host's disk is below its hard floor"), { code: "ENOSPC" });
          }
        },
      };
    },
    state: () => ({ hostBytes: hostUsage(), freeBytes: free(), ...counts }),
  };
}
