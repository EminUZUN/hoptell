// Where messages came from (design 2.1): each message reference read in the last seven days, with
// every (relay profile, realm) it was seen on. Shared by the sessions of a home and the CLI: read
// fresh each time, changed only under the file's lock (merged, never overwritten).
import fs from "node:fs";
import path from "node:path";
import { ensurePrivateDir } from "./config.js";
import { withLock, writeRecord } from "./locks.js";

const ROUTES_MAX = 10_000;
const KEEP_MS = 7 * 86400_000;

export function routesStore(home, { now = () => Date.now() } = {}) {
  const file = path.join(home, "routes.json");
  const read = () => {
    try {
      const d = JSON.parse(fs.readFileSync(file, "utf8"));
      if (d?.v === 2 && d.routes && typeof d.routes === "object") return d.routes;
    } catch {}
    return {};
  };
  return {
    /** The origins of a message reference: [{profile, realm, at}] (possibly several, or none). */
    lookup: (ref) => (Array.isArray(read()[ref]) ? read()[ref] : []),
    /** Record origins of messages just read: [{ref, profile, realm}]. */
    async note(entries) {
      const fresh = entries.filter((e) => e.ref && e.profile);
      if (!fresh.length) return;
      ensurePrivateDir(home);
      await withLock(file, () => {
        const r = read();
        const t = now();
        for (const e of fresh) {
          const list = (r[e.ref] ?? []).filter((o) => !(o.profile === e.profile && o.realm === (e.realm ?? null)));
          r[e.ref] = [...list, { profile: e.profile, realm: e.realm ?? null, at: t }];
        }
        const keep = Object.entries(r)
          .map(([ref, list]) => [ref, list.filter((o) => t - o.at < KEEP_MS)])
          .filter(([, list]) => list.length)
          .sort((a, b) => Math.max(...b[1].map((o) => o.at)) - Math.max(...a[1].map((o) => o.at)))
          .slice(0, ROUTES_MAX);
        writeRecord(file, { v: 2, routes: Object.fromEntries(keep) });
      });
    },
  };
}

/**
 * The reply rule, the same for sessions and the CLI: the destination is resolved first (bare goes
 * to the default); a known reference must have been seen on that relay. Throws with the right
 * address when it came through another relay; an unknown reference needs a qualified address when
 * there are several relays.
 */
export function checkReply({ origins, routeProfile, target, qualified, several, aliasOf, aliases }) {
  const profiles = [...new Set(origins.map((o) => o.profile))];
  // Seen on several relays: only a qualified destination says which one is meant.
  if (profiles.length > 1 && !qualified) {
    const names = profiles.map(aliasOf).filter(Boolean);
    throw new Error(`that message reference was seen on several relays: say which, as ${names.length ? names.map((a) => `${target}@${a}`).join(" or ") : `${target}@<relay>`}`);
  }
  if (profiles.includes(routeProfile)) return;
  if (origins.length) {
    const names = [...new Set(origins.map((o) => aliasOf(o.profile)).filter(Boolean))];
    throw new Error(`that message came through ${names.length ? names.map((a) => `relay "${a}"`).join(" or ") : "another relay"}: reply to ${names.length ? names.map((a) => `${target}@${a}`).join(" or ") : `${target}@<its relay>`}`);
  }
  if (several && !qualified) throw new Error(`the referenced message is not known here: address the reply explicitly as ${target}@<relay> (relays: ${aliases.join(", ")})`);
}
