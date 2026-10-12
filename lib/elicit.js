// The elicitation adapter (design 3.4): during a read_inbox call, ask the owner through the MCP
// client's own question UI about one pending quarantined-message request (kind "contact"), with
// the choices allow-once and later only. Off unless HOPTELL_ELICITATION=read_inbox.
//
// Legacy flow only (`elicitation/create` in form mode, answered inside the pending tool call): a
// session is asked only when the protocol revision it requested and the one negotiated are both
// on LEGACY_REVISIONS and its client declared form elicitation. Any other revision, the
// 2026-07-28 one (input_required) or an unknown future one, is never asked.
//
// The question binds the server-side record {decision id, service token, asked at}; the form
// carries nothing the answer could alter except the enum choice. The question ends (answer,
// decline, cancel, timeout or error) before read_inbox claims its batch, so it never holds a
// lease. An answer is not proof that a human answered: a client may answer automatically.
import * as decisions from "./decisions.js";
import { visible } from "./ownerui.js";
import { openContacts } from "./quarantine.js";

/** The legacy revisions with form elicitation that this adapter asks in (the tested-client matrix). */
export const LEGACY_REVISIONS = Object.freeze(["2025-06-18", "2025-11-25"]);
export const ASK_TIMEOUT_MS = 60_000;
export const COOLDOWN_MS = 30 * 60_000;
export const CHOICES = Object.freeze(["allow-once", "later"]);

/** Whether a session may be asked: an allow-listed revision, requested and negotiated, and form support. */
export function mayAsk({ requested = null, negotiated = null, capabilities = null } = {}) {
  return LEGACY_REVISIONS.includes(requested) && LEGACY_REVISIONS.includes(negotiated) && Boolean(capabilities?.elicitation?.form);
}

/** The question for a contact view: who (as authenticated), how many, for which sessions. Never text. */
export function questionOf(view) {
  const s = view.sender;
  const n = view.items.length;
  const who =
    s.auth === "member"
      ? `member ${s.member} in realm ${s.realm}, authenticated by the relay`
      : s.auth === "shared"
        ? `a shared-token sender in realm ${s.realm} (any holder of that token can use this name)`
        : `an unverified sender (the relay ${s.relay ?? "(unknown)"} does not authenticate senders)`;
  const sessions = [...new Set(view.items.map((i) => i.session))].join(", ");
  return {
    message:
      `hoptell: ${n} message${n === 1 ? "" : "s"} from ${who} ${n === 1 ? "is" : "are"} waiting for your decision.\n` +
      `Name as reported by the relay: "${visible(s.label).slice(0, 64)}".\nFor: ${sessions}.\n\n` +
      `allow-once releases only ${n === 1 ? "this message" : `these ${n} messages`}; later keeps ${n === 1 ? "it" : "them"} waiting. ` +
      "Lasting decisions (allow, block) and device keys are made with hoptell contacts or hoptell ui. The message text is not shown here.",
    requestedSchema: {
      type: "object",
      properties: { decision: { type: "string", title: "Decision", description: "allow-once: release only these messages. later: keep them waiting.", enum: [...CHOICES], default: "later" } },
      required: ["decision"],
    },
  };
}

/**
 * The adapter of one hoptell home. beforeRead({session, ask, signal}) asks at most one question
 * and returns {asked, outcome}; it never throws (read_inbox goes on whatever happens).
 * `session` is {requested, negotiated, capabilities}; `ask(params, {timeout, signal})` sends
 * `elicitation/create` within the tool call.
 */
export function createElicitation({ home, now = () => Date.now(), timeoutMs = ASK_TIMEOUT_MS, cooldownMs = COOLDOWN_MS, log = () => {}, contacts = null }) {
  const cooldown = new Map(); // decision id -> until
  let opened = contacts;
  const sources = async () => ({ contacts: (opened ??= await openContacts(home, { notify: false, log })) });
  const cool = (id) => cooldown.set(id, now() + cooldownMs);

  async function beforeRead({ session, ask, signal = null }) {
    if (!mayAsk(session)) return { asked: false, outcome: "not-supported" };
    try {
      const src = await sources();
      const t = now();
      for (const [id, until] of cooldown) if (until <= t) cooldown.delete(id);
      const item = (await decisions.list({ home, kinds: ["contact"], sources: src })).find((i) => !cooldown.has(i.id));
      if (!item) return { asked: false, outcome: "nothing" };
      const shown = await decisions.show({ home, id: item.id, sources: src });
      if (shown.refused || shown.busy) return { asked: false, outcome: "unavailable" };
      // The binding: kept here, never sent; the answer is the response to this very request.
      const record = { id: shown.id, token: shown.token, askedAt: now() };
      let result;
      try {
        result = await ask(questionOf(shown.view), { timeout: timeoutMs, signal });
      } catch (e) {
        cool(record.id);
        return { asked: true, outcome: /timed? ?out/i.test(e.message) || e.code === -32001 ? "timeout" : "error" };
      }
      if (now() - record.askedAt > timeoutMs) {
        cool(record.id); // an answer after the bound is ignored
        return { asked: true, outcome: "late" };
      }
      const choice = result?.action === "accept" && CHOICES.includes(result.content?.decision) ? result.content.decision : "later";
      if (choice !== "allow-once") {
        cool(record.id);
        return { asked: true, outcome: result?.action === "accept" ? "later" : String(result?.action ?? "error") };
      }
      const d = await decisions.decide({ home, id: record.id, action: "allow-once", token: record.token, options: {}, sources: src });
      if (d.done) return { asked: true, outcome: "allowed-once" };
      if (d.stale) return { asked: true, outcome: "stale" }; // the next read_inbox may ask with the new view
      cool(record.id);
      return { asked: true, outcome: "refused" };
    } catch (e) {
      log(`elicitation: ${e.message}`);
      return { asked: false, outcome: "error" };
    }
  }
  return { beforeRead, cooling: (id) => cooldown.has(id) };
}
