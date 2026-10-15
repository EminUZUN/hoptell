// What this machine has checked about a stored message, as it is read (never stored): the
// owner-channel label and the end-to-end encryption mark count only when this version verified
// them (lib/quarantine.js attest, with the receipts of lib/ownersig.js). A stored "owner" or
// "e2ee" field alone never counts: an older writer may have kept a relay's.

/** The key of a message's checked facts: {owner: env | null, e2ee: boolean}. JSON never carries it. */
export const ATTESTED = Symbol("hoptell.attested");

/** The checked owner-channel envelope of a message, or null. */
export const attestedOwner = (m) => m?.[ATTESTED]?.owner ?? null;
/** Whether this device decrypted the message (checked receipt). */
export const attestedE2ee = (m) => m?.[ATTESTED]?.e2ee === true;
