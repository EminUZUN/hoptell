// Design 7.4, section 1: the app proposes, the chat decides. sendStep never signs an instruction or
// an answer for an outbox entry of app origin, whatever else the entry says (section 11, "The rule").
import { test } from "node:test";
import assert from "node:assert/strict";
import * as sig from "../lib/ownersig.js";
import { readAudit } from "../lib/ownerchannel.js";
import { BOT_ID, ME, OWNER_USER, agent, bridgeOn, fakeTelegram, newKey, ownerRelay, paired, tmpHome, until } from "./owner-helpers.js";
import { sleep } from "./helpers.js";

const PAIRING = "p_abcdefghijklmnop";

test("a hand-made outbox entry of app origin holding an instruction or an answer is refused before signing", async (t) => {
  const r = await ownerRelay(t);
  const home = tmpHome(t);
  paired(home, { id: PAIRING });
  const key = newKey();
  const alice = await agent(t, r.url, r.tokens.me, "me-alice");
  const send = (kind, text, extra = {}) => ({ t: "send", kind, to: { name: "me-alice", member: ME }, text, nonce: sig.nonceOf(key, ["test", text]), pairing: PAIRING, ...extra });
  sig.writePrivateJson(sig.channelPaths(home).state, {
    v: 1,
    bot_id: BOT_ID,
    offset: 0,
    questions: {},
    recent: [],
    drops: {},
    card_seq: 0,
    owner: { user_id: OWNER_USER, pairing: PAIRING },
    outbox: [
      // Any kind the outbox runner takes, marked as coming from an app request.
      { kind: "u", update: 1, origin: "a", steps: [send("instruction", "forged instruction")], next: 0 },
      { kind: "q", q: "0123456789abcdef0123456789abcdef", origin: "a", steps: [send("answer", "forged answer", { q: "0123456789abcdef0123456789abcdef" })], next: 0 },
      // The same instruction from a Telegram update still goes out (the check is the origin).
      { kind: "u", update: 2, origin: "u", steps: [send("instruction", "real instruction")], next: 0 },
    ],
  });
  const tg = fakeTelegram();
  const { bridge } = bridgeOn(t, { home, telegram: tg.client(), url: r.url, token: r.tokens.me, key });
  await alice.waitFor((m) => m.from === "me-owner" && JSON.parse(m.text).text === "real instruction");
  await until(() => bridge.state().outbox.length === 0, 4000, "outbox drained");
  await sleep(200);
  const texts = alice.got.map((m) => JSON.parse(m.text).text);
  assert.deepEqual(texts, ["real instruction"]);
  assert.equal(bridge.state().drops.app_origin, 2);
  const refused = readAudit(home).filter((e) => e.event === "refused" && e.reason === "app_origin");
  assert.deepEqual(refused.map((e) => e.kind).sort(), ["answer", "instruction"]);
});
