// Name claims for receiving sessions (protocol 2 leases, protocol 1 legacy holders).
// Pure bookkeeping: the relay asks for a decision, then fences, hands off and closes sockets.
//
// States per name: FREE, ACTIVE_LEGACY (a protocol-1 holder), ACTIVE_LEASED (a protocol-2 lease),
// RESERVED (a lease whose socket closed, kept for a grace period). See the state table in the
// identity design: legacy hellos can never replace a lease; acquires never evict; resumes need
// the lease secret, the same principal and the current or retried generation; replace is a
// one-shot action for the same principal.
//
// Name tickets (cap "name-ticket", design 10): a session that asks for one with `ticket: true` on
// an acquire gets a random ticket with its new claim. Only that ticket, with the same principal,
// can claim the name again (action "continue") until it expires: the name is "protected", so the
// automatic allocator skips it, other acquires and legacy hellos are refused, and claim_status
// says "taken" to anyone without the ticket. A ticket never displaces a live holder. The relay
// keeps only its digest, in memory: a relay restart forgets every ticket (the relay has one realm,
// so a ticket is bound to that realm by the table it lives in).
import crypto from "node:crypto";

export const GRACE_MS = 30_000;
/** A ticket lasts this long after its last use; it does not expire while its name is held. */
export const TICKET_TTL_MS = 7 * 86400_000;
/** At most this many tickets per principal; a new one evicts the least recently used one whose name is not live. */
export const TICKETS_PER_PRINCIPAL = 256;
const TICKET_RE = /^[A-Za-z0-9_-]{43}$/;
const digestOf = (ticket) => crypto.createHash("sha256").update(String(ticket)).digest();
const sameSecret = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
/** A principal as a comparable key: "member:<id>" or "shared". */
export const principalKey = (p) => {
  if (p?.kind === "member" && typeof p.id === "string" && p.id) return `member:${p.id}`;
  if (p?.kind === "shared") return "shared";
  throw new TypeError("a principal is {kind: 'member', id} or {kind: 'shared'}");
};
const ATTEMPT_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** A resume claim the table can evaluate: bounded strings and a positive generation. */
const wellFormedResume = (c) =>
  typeof c.lease === "string" && c.lease.length <= 64 &&
  typeof c.secret === "string" && c.secret.length <= 128 &&
  typeof c.incarnation === "string" && c.incarnation.length <= 64 &&
  typeof c.attempt === "string" && ATTEMPT_RE.test(c.attempt) &&
  Number.isSafeInteger(c.gen) && c.gen >= 1;

export class ClaimTable {
  constructor({ incarnation = crypto.randomBytes(8).toString("hex"), graceMs = GRACE_MS, now = () => Date.now(), ticketTtlMs = TICKET_TTL_MS, ticketsPerPrincipal = TICKETS_PER_PRINCIPAL } = {}) {
    Object.assign(this, { incarnation, graceMs, now, ticketTtlMs, ticketsPerPrincipal });
    /** name -> {principal: principal key, digest: sha256 of the ticket, usedAt} (never the ticket itself) */
    this.tickets = new Map();
    /**
     * name -> {state, socket, principal, version, lease?, secretDigest?, gen, lastResume?, reservedUntil?, title?, status?}
     * title: the display-only session title of this lease (never of a legacy claim). It belongs to
     * the claim, not to the name: a resume keeps it, and every new claim starts with its own.
     * status: the owner-only status text of this lease (cap "status"), kept the same way; a new
     * claim starts without one.
     */
    this.claims = new Map();
  }

  #fresh(name, socket, principal, title) {
    const lease = crypto.randomBytes(16).toString("hex");
    const secret = crypto.randomBytes(32).toString("base64url");
    const entry = { state: "ACTIVE_LEASED", socket, principal, version: 2, lease, secret, gen: 1, lastResume: null, title: title ?? null, status: null };
    this.claims.set(name, entry);
    return { lease, secret, gen: 1, incarnation: this.incarnation };
  }

  /** Whether `name` has a live holder (not a reservation). */
  #live(name) {
    const c = this.#current(name);
    return Boolean(c && c.state !== "RESERVED");
  }

  /** The ticket entry of `name` if it has not expired (a held name's ticket never expires). */
  #ticket(name) {
    const t = this.tickets.get(name);
    if (!t) return undefined;
    if (!this.#live(name) && this.now() - t.usedAt >= this.ticketTtlMs) {
      this.tickets.delete(name);
      return undefined;
    }
    return t;
  }

  /** Whether a ticket protects `name` now. */
  protected(name) {
    return Boolean(this.#ticket(name));
  }

  /** Whether `ticket` is the current ticket of `name` for principal key `who`. */
  #ticketMatches(name, who, ticket) {
    const t = this.#ticket(name);
    if (!t || typeof ticket !== "string" || !TICKET_RE.test(ticket)) return false;
    return t.principal === who && crypto.timingSafeEqual(t.digest, digestOf(ticket));
  }

  /**
   * A new ticket for `name`, held by principal key `who`, or null when the principal already has
   * its limit of tickets and all of their names are live (nothing is evicted then).
   */
  #issue(name, who) {
    const mine = [...this.tickets].filter(([n, t]) => n !== name && t.principal === who && this.#ticket(n));
    if (mine.length >= this.ticketsPerPrincipal) {
      const idle = mine.filter(([n]) => !this.#live(n)).sort((a, b) => a[1].usedAt - b[1].usedAt);
      if (!idle.length) return null;
      this.tickets.delete(idle[0][0]);
    }
    const ticket = crypto.randomBytes(32).toString("base64url");
    this.tickets.set(name, { principal: who, digest: digestOf(ticket), usedAt: this.now() });
    return ticket;
  }

  /** Note a use of `name`'s ticket (a continue, or its holder closing). */
  #touch(name) {
    const t = this.tickets.get(name);
    if (t) t.usedAt = this.now();
  }

  /** A new claim, with a ticket when one was asked for: {lease, ..., ticket?, ticket_limit?}. */
  #freshWithTicket(name, socket, principal, title, wantTicket) {
    const claim = this.#fresh(name, socket, principal, title);
    if (!wantTicket) return claim;
    const ticket = this.#issue(name, principalKey(principal));
    return ticket ? { ...claim, ticket } : { ...claim, ticket_limit: true };
  }

  #current(name) {
    const c = this.claims.get(name);
    if (c?.state === "RESERVED" && this.now() >= c.reservedUntil) {
      this.claims.delete(name);
      return undefined;
    }
    return c;
  }

  /** Remaining grace time in ms for a reserved name (for retry hints). */
  #retryAfter(c) {
    return c?.state === "RESERVED" ? Math.max(1000, c.reservedUntil - this.now()) : undefined;
  }

  /**
   * Decide a hello for a receiving session. Returns one of:
   * {ok: true, claim?: {lease, secret, gen, incarnation}, evict?: socket, fence?: socket}
   * {ok: false, code, close, retryAfterMs?, bound?}  (code: hello_error code; close: WebSocket close code)
   */
  hello({ name, socket, principal, version, claim, title = null }) {
    // The relay validates names, credentials and send-only hellos first; the table still refuses
    // inputs it cannot evaluate rather than guessing.
    if (version !== 1 && version !== 2) return { ok: false, code: "bad_claim", close: 4001 };
    const who = principalKey(principal);
    const c = this.#current(name);
    const mine = c && principalKey(c.principal) === who;
    // A reservation protects a briefly disconnected session from other principals. The same
    // principal claiming its own reserved name is almost always a restart: let it have the name.
    const ownReservation = c?.state === "RESERVED" && mine;
    // A name protected by a ticket is not for a legacy hello, whatever the claim's state: one that
    // is not live would otherwise go to the first legacy client that asks.
    if (version !== 2 && this.protected(name)) return { ok: false, code: "name_in_use", close: 4002 };
    if (version !== 2) {
      // Legacy hello: today's behavior among legacy holders; never against a live lease.
      if (!c || ownReservation) {
        this.claims.set(name, { state: "ACTIVE_LEGACY", socket, principal, version: 1 });
        return { ok: true };
      }
      // Among legacy holders the newer hello takes the name, but only from its own principal (a
      // reconnect): a shared-token client never evicts a member's session, nor the reverse.
      if (c.state === "ACTIVE_LEGACY" && mine) {
        const evict = c.socket;
        this.claims.set(name, { state: "ACTIVE_LEGACY", socket, principal, version: 1 });
        return { ok: true, evict };
      }
      return { ok: false, code: "name_in_use", close: 4002 };
    }
    const action = claim?.action;
    if (action === "acquire") {
      if (claim.ticket !== undefined && claim.ticket !== true) return { ok: false, code: "bad_claim", close: 4001 };
      // A protected name waits like a taken one (old clients know name_in_use); `bound` tells new ones why.
      if (this.protected(name) && !this.#live(name)) return { ok: false, code: "name_in_use", close: 4006, bound: true };
      if (!c || ownReservation) return { ok: true, claim: this.#freshWithTicket(name, socket, principal, title, claim.ticket === true) };
      return { ok: false, code: c.state === "RESERVED" ? "reserved" : "name_in_use", close: 4006, retryAfterMs: this.#retryAfter(c) };
    }
    if (action === "continue") {
      // Every ticket failure is the same answer: an unknown, expired, other-principal or wrong
      // ticket cannot be told apart. A ticket never displaces a live holder.
      if (!this.#ticketMatches(name, who, claim.ticket)) return { ok: false, code: "ticket_unknown", close: 4006 };
      if (c && c.state !== "RESERVED") return { ok: false, code: "ticket_in_use", close: 4006, retryAfterMs: this.graceMs };
      if (c && !mine) return { ok: false, code: "reserved", close: 4006, retryAfterMs: this.#retryAfter(c) };
      this.#touch(name);
      return { ok: true, claim: this.#fresh(name, socket, principal, title) };
    }
    if (action === "resume") {
      if (!wellFormedResume(claim)) return { ok: false, code: "bad_claim", close: 4001 };
      if (claim.incarnation !== this.incarnation) return { ok: false, code: "relay_restarted", close: 4006 };
      if (!c || !c.lease || c.lease !== claim.lease || !mine || !sameSecret(c.secret, claim.secret)) return { ok: false, code: "lease_unknown", close: 4006 };
      let toGen;
      // An attempt id belongs to one transaction: reused with other inputs, it is refused.
      if (c.lastResume && claim.attempt === c.lastResume.attempt && claim.gen !== c.lastResume.fromGen) return { ok: false, code: "superseded", close: 4007 };
      if (claim.gen === c.gen) {
        toGen = c.gen + 1;
        c.lastResume = { attempt: claim.attempt, fromGen: c.gen, toGen };
      } else if (c.lastResume && claim.gen === c.lastResume.fromGen && claim.attempt === c.lastResume.attempt) {
        toGen = c.lastResume.toGen; // the same transaction retried after its welcome was lost
      } else {
        return { ok: false, code: "superseded", close: 4007 };
      }
      const fence = c.state === "ACTIVE_LEASED" && c.socket !== socket ? c.socket : undefined;
      Object.assign(c, { state: "ACTIVE_LEASED", socket, gen: toGen, reservedUntil: undefined });
      return { ok: true, claim: { lease: c.lease, secret: c.secret, gen: toGen, incarnation: this.incarnation }, fence };
    }
    if (action === "replace") {
      if (c && !mine) return { ok: false, code: "not_allowed", close: 4002 };
      // Only the principal a ticket belongs to may override it; the override ends the ticket.
      if (this.#ticket(name) && this.#ticket(name).principal !== who) return { ok: false, code: "not_allowed", close: 4002 };
      this.tickets.delete(name);
      const evict = c && c.state !== "RESERVED" ? c.socket : undefined;
      return { ok: true, claim: this.#fresh(name, socket, principal, title), evict };
    }
    return { ok: false, code: "bad_claim", close: 4001 };
  }

  /** The socket currently allowed to act for `name` (others are fenced). */
  isCurrent(name, socket) {
    const c = this.#current(name);
    return Boolean(c && c.state !== "RESERVED" && c.socket === socket);
  }

  /**
   * Set or clear (null) the title of `name`'s lease, only for the socket that currently holds it
   * (isCurrent: not reserved, not fenced). Returns whether it was set.
   */
  setTitle(name, socket, title) {
    if (!this.isCurrent(name, socket)) return false;
    const c = this.claims.get(name);
    if (c.state !== "ACTIVE_LEASED") return false;
    c.title = title ?? null;
    return true;
  }

  /** Set or clear (null) the status of `name`'s lease, as setTitle. Returns whether it was set. */
  setStatus(name, socket, status) {
    if (!this.isCurrent(name, socket)) return false;
    const c = this.claims.get(name);
    if (c.state !== "ACTIVE_LEASED") return false;
    c.status = status ?? null;
    return true;
  }

  /** The status of `name`'s current lease (live or reserved) and the principal that holds it, or null. */
  statusOf(name) {
    const c = this.#current(name);
    return (c?.state === "ACTIVE_LEASED" || c?.state === "RESERVED") && c.status ? { status: c.status, principal: c.principal } : null;
  }

  /** The lease id of the claim `socket` currently holds for `name`, or null (title budgets). */
  leaseOf(name, socket) {
    return this.isCurrent(name, socket) ? (this.claims.get(name).lease ?? null) : null;
  }

  /** The title of `name`'s current lease (live or reserved), or null. */
  titleOf(name) {
    const c = this.#current(name);
    return c?.state === "ACTIVE_LEASED" || c?.state === "RESERVED" ? (c.title ?? null) : null;
  }

  /** A holder's socket closed: a lease is reserved for the grace period, a legacy claim ends. */
  closed(name, socket) {
    const c = this.claims.get(name);
    if (!c || c.socket !== socket || c.state === "RESERVED") return;
    this.#touch(name); // a ticket's lifetime starts again when its holder goes
    if (c.state === "ACTIVE_LEGACY") this.claims.delete(name);
    else Object.assign(c, { state: "RESERVED", socket: null, reservedUntil: this.now() + this.graceMs });
  }

  /** The holder shut down cleanly and gives the name back: no reservation is kept. */
  release(name, socket) {
    const c = this.claims.get(name);
    if (c && c.socket === socket && c.state !== "RESERVED") {
      this.#touch(name); // the claim ends, the ticket stays: a session resumed later keeps its name
      this.claims.delete(name);
    }
  }

  /** A credential was revoked: the claim held by this socket ends at once (no resume). */
  revoke(name, socket) {
    const c = this.claims.get(name);
    if (c && c.socket === socket && c.state !== "RESERVED") this.claims.delete(name);
  }

  /**
   * Drop reservations whose holder may no longer have the name (after a credential reload):
   * `keep(name, principal)` decides. Live claims are revoked per socket instead.
   */
  pruneReservations(keep) {
    for (const [name, c] of this.claims) if (c.state === "RESERVED" && !keep(name, c.principal)) this.claims.delete(name);
    // Tickets the same way: a narrowed or removed credential loses them.
    for (const [name, t] of this.tickets) if (!keep(name, t.principal === "shared" ? { kind: "shared" } : { kind: "member", id: t.principal.slice("member:".length) })) this.tickets.delete(name);
  }

  /** Remove expired reservations; the relay calls this from its periodic housekeeping. */
  sweep() {
    const now = this.now();
    for (const [name, c] of this.claims) if (c.state === "RESERVED" && now >= c.reservedUntil) this.claims.delete(name);
    for (const name of [...this.tickets.keys()]) this.#ticket(name); // drops expired ones
  }

  /** Number of claims held (live and reserved), for metrics and tests. */
  get size() {
    return this.claims.size;
  }

  /**
   * For claim_status: free, taken or reserved (and how long), as seen by `principal`. The relay
   * checks first that the caller may use the name at all.
   */
  status(name, principal = null, ticket = undefined) {
    const c = this.#current(name);
    // A protected name that is not live is free only for its ticket (and that ticket's principal).
    if (this.protected(name) && (!c || c.state === "RESERVED")) {
      if (!principal || !this.#ticketMatches(name, principalKey(principal), ticket)) return { state: "taken" };
      return c && principalKey(c.principal) !== principalKey(principal) ? { state: "reserved", retryAfterMs: this.#retryAfter(c) } : { state: "free" };
    }
    if (!c) return { state: "free" };
    if (c.state === "RESERVED") {
      // The same principal may claim its own reservation (a restart), so for it the name is free.
      if (principal && principalKey(c.principal) === principalKey(principal)) return { state: "free" };
      return { state: "reserved", retryAfterMs: this.#retryAfter(c) };
    }
    return { state: "taken" };
  }

  /** Owner principal of a name's claim (live or reserved), for queue ownership. */
  owner(name) {
    return this.#current(name)?.principal ?? null;
  }
}
