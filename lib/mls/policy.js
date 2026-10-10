// The numbers of design 3.2 (KeyPackages, retention and compromise recovery) and the timer rules
// built on them, as pure functions of the time: the relay, the device store and 3.3's groups use
// these, and tests drive them with a clock. EXPERIMENTAL.
export const DAY = 86_400_000;
export const HOUR = 3_600_000;

// KeyPackages
export const KP_MAX_PER_DEVICE = 20; // published and not yet consumed or expired ("outstanding")
export const KP_LIFETIME_MS = 14 * DAY;
export const KP_LOW_WATER = 5; // replenish below this many available
export const KP_EXPIRY_HORIZON_MS = 2 * DAY; // ... or when the oldest expires within this
export const KP_REPLENISH_MIN_INTERVAL_MS = 60_000; // bounded rate per device
export const RESERVATION_ABANDON_MS = HOUR; // no accepted commit within this: the package burns
export const WELCOME_REPLAY_KEEP_MS = 7 * DAY; // used-package records outlive the package by this
// A10: expired, unused KeyPackage private keys are deleted 1 day after expiry (lib/mls/device.js
// PRUNE_GRACE_S), at engine start, attach, every replenishment and every 6 hours while it runs.
export const PRUNE_EVERY_MS = 6 * HOUR;
export const DEVICES_PER_MEMBER = 20;

// Retention and compromise recovery
export const MIN_PAST_EPOCHS = 3;
export const PAST_EPOCH_MS = 7 * DAY;
export const MAX_PAST_EPOCHS = 16; // the bound on past epochs, however young (design 3.2 v2.1)
export const MAX_SKIPPED_PER_SENDER_EPOCH = 10;
export const MAX_FORWARD_GENERATIONS = 200;
export const UPDATE_EVERY_MS = 7 * DAY;
export const STALE_MEMBER_MS = 30 * DAY;

/**
 * KeyPackage replenishment: how many new packages to publish now, given the relay's view of this
 * device's pool ({available, reserved, oldestExpires}) and when it last replenished. Below
 * KP_LOW_WATER available, or with the oldest expiring within KP_EXPIRY_HORIZON_MS, fill up to
 * KP_MAX_PER_DEVICE outstanding (available + reserved); at most once per interval.
 */
export function replenishCount({ available, reserved = 0, oldestExpires = null }, { now, lastAt = 0 }) {
  const due = available < KP_LOW_WATER || (oldestExpires !== null && oldestExpires - now <= KP_EXPIRY_HORIZON_MS);
  if (!due || now - lastAt < KP_REPLENISH_MIN_INTERVAL_MS) return 0;
  // Packages about to expire still count until they do: replacing them early would exceed the bound.
  return Math.max(0, KP_MAX_PER_DEVICE - available - reserved);
}

/**
 * Old epochs (product rule, design 3.2 v2.1): of past epochs [{epoch, began}], keep those within
 * the last MIN_PAST_EPOCHS or younger than PAST_EPOCH_MS, and of those at most the newest
 * MAX_PAST_EPOCHS (the window and the cap, whichever is stricter); an epoch that began exactly 7
 * days ago is old. Returns the epochs to keep (numbers), newest first. A clock that moves backward
 * makes epochs look younger. A message of an epoch not kept is refused as too old.
 */
export function pastEpochsToKeep(past, now) {
  const sorted = [...past].sort((a, b) => b.epoch - a.epoch);
  return sorted
    .filter((e, i) => i < MIN_PAST_EPOCHS || now - e.began < PAST_EPOCH_MS)
    .slice(0, MAX_PAST_EPOCHS)
    .map((e) => e.epoch);
}

/** Skipped message keys: whether one more may be kept (per sender per epoch, and how far forward). */
export const mayKeepSkipped = ({ keptForSenderEpoch, forward }) => keptForSenderEpoch < MAX_SKIPPED_PER_SENDER_EPOCH && forward <= MAX_FORWARD_GENERATIONS;

/**
 * The fresh-update policy for one conversation's group (design 3.2 v2.2, A2). `lastOwnUpdate` is
 * the age clock: the group's creation or join, then only an own update commit merged after
 * acceptance. An update is due when there was activity since it (`activeSince` set, or an
 * outbound send being attempted now: `sending`) and it is UPDATE_EVERY_MS old; when a member
 * removal was merged since it (`removal`, recorded with the merge); or after a rotation of this device's key since it
 * (`rotatedAt`, which needs rotating in active groups: not possible yet). An idle group owes
 * nothing on the timer; its first send after the interval updates first.
 */
export function updateDue({ lastOwnUpdate, activeSince = null, sending = false, rotatedAt = null, removal = false }, now) {
  if (rotatedAt !== null && rotatedAt > lastOwnUpdate) return { due: true, reason: "rotation" };
  if (removal) return { due: true, reason: "member removal" };
  if ((activeSince !== null || sending) && now - lastOwnUpdate >= UPDATE_EVERY_MS) return { due: true, reason: "7 days since the last update" };
  return { due: false };
}

/** Members whose last update in a group is older than STALE_MEMBER_MS, for the owner. */
export const staleMembers = (lastUpdates, now) => Object.entries(lastUpdates).filter(([, t]) => now - t > STALE_MEMBER_MS).map(([m]) => m);
