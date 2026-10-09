// The elicitation adapter (design 3.4, lib/elicit.js) through the real MCP front end
// (serveEngine) and an SDK client per row of the tested-client matrix: who is asked (legacy
// revisions on the allow list, form support), the choices, the binding to what was shown, the
// 60-second bound and the cooldown, and the order: the question ends before the read claims.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { ASK_TIMEOUT_MS, CHOICES, COOLDOWN_MS, LEGACY_REVISIONS, createElicitation, mayAsk } from "../lib/elicit.js";
import { serveEngine } from "../lib/mcp.js";
import { readSettings } from "../lib/settings.js";
import { openBound } from "../lib/session.js";
import { openStore, processConsumer } from "../lib/store.js";
import { openContacts } from "../lib/quarantine.js";

const R = "a".repeat(32);
const ALICE = "m_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const SECRET = "the secret plan";
const fromAlice = (text) => ({ type: "message", id: crypto.randomUUID(), from: "alice-x", fromHost: "h", text, ts: 1, sender: { auth: "member", member: { id: ALICE, name: "alice" }, realm: R } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const NOTE = /message.* waiting for your user's decision: hoptell contacts/;

async function home(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hoptell-el-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const c = await openContacts(dir, { notify: false });
  const bound = await openBound(dir, { realm: R, member: null, key: "s" });
  const store = await openStore(bound);
  await c.hold(bound.dir, { realm: R, name: "s" }, fromAlice(SECRET), "ask");
  return { dir, c, bound, store };
}

/** An engine stand-in: read_inbox records when it ran and answers like the engine (the 1.5 note). */
function fakeEngine(h, events) {
  return {
    attach: () => ({ detach() {} }),
    start: async () => {},
    instructions: () => "",
    tools: async () => [{ name: "read_inbox", description: "read", inputSchema: { type: "object" } }],
    call: async (name) => {
      events.push(`call:${name}`);
      const s = h.c.summary();
      return { content: [{ type: "text", text: `Inbox empty.${s.messages ? `\n\n(${s.messages} message${s.messages === 1 ? "" : "s"} from ${s.senders} sender is waiting for your user's decision: hoptell contacts.)` : ""}` }] };
    },
  };
}

/**
 * A client of one matrix row: its name and version, whether it declares form elicitation, the
 * revision it requests (rewritten on the wire when the SDK would not send it), and its answer.
 */
async function connect(t, h, { adapter, info = { name: "client", version: "0" }, form = true, revision = null, answer = null, events = [] }) {
  const [server, client] = InMemoryTransport.createLinkedPair();
  const close = await serveEngine(fakeEngine(h, events), server, { elicitation: adapter });
  if (revision) {
    const send = client.send.bind(client);
    client.send = (m, o) => send(m.method === "initialize" ? { ...m, params: { ...m.params, protocolVersion: revision } } : m, o);
  }
  const c = new Client(info, { capabilities: form ? { elicitation: { form: {} } } : {} });
  const asked = [];
  if (form) {
    c.setRequestHandler(ElicitRequestSchema, async (req) => {
      asked.push({ params: req.params, callsBefore: events.filter((e) => e === "call:read_inbox").length });
      events.push("asked");
      return answer(req);
    });
  }
  await c.connect(client);
  t.after(async () => {
    await c.close().catch(() => {});
    await close();
  });
  const read = async () => (await c.callTool({ name: "read_inbox", arguments: {} })).content[0].text;
  return { client: c, asked, read, events };
}
const pending = async (h) => (await h.c.status()).requests;

test("off by default; mayAsk is an allow list of legacy revisions with form support, never a test against 2026-07-28", () => {
  assert.equal(readSettings({ env: {}, homedir: os.tmpdir(), pid: 1 }).elicitation, "off");
  assert.equal(readSettings({ env: { HOPTELL_ELICITATION: "on" }, homedir: os.tmpdir(), pid: 1 }).elicitation, "off");
  assert.equal(readSettings({ env: { HOPTELL_ELICITATION: "read_inbox" }, homedir: os.tmpdir(), pid: 1 }).elicitation, "read_inbox");
  assert.deepEqual([...LEGACY_REVISIONS], ["2025-06-18", "2025-11-25"]);
  assert.deepEqual([...CHOICES], ["allow-once", "later"]);
  assert.equal(ASK_TIMEOUT_MS, 60_000);
  assert.equal(COOLDOWN_MS, 30 * 60_000);
  const form = { elicitation: { form: {} } };
  for (const r of LEGACY_REVISIONS) assert.equal(mayAsk({ requested: r, negotiated: r, capabilities: form }), true, r);
  for (const r of ["2026-07-28", "2027-01-01", "2025-03-26", "2024-11-05", null, "", "2025-11-25 "]) assert.equal(mayAsk({ requested: r, negotiated: r, capabilities: form }), false, String(r));
  assert.equal(mayAsk({ requested: "2026-07-28", negotiated: "2025-11-25", capabilities: form }), false, "a client that asked for the modern flow");
  assert.equal(mayAsk({ requested: "2025-11-25", negotiated: "2025-11-25", capabilities: {} }), false, "no form support");
});

test("Claude Code (accept): allow-once releases exactly what was shown, before the read claims; the form has no text", async (t) => {
  const h = await home(t);
  const adapter = createElicitation({ home: h.dir });
  const s = await connect(t, h, { adapter, info: { name: "claude-code", version: "2.1.294" }, answer: () => ({ action: "accept", content: { decision: "allow-once" } }) });
  const out = await s.read();
  assert.equal(s.asked.length, 1);
  assert.equal(s.asked[0].callsBefore, 0, "no read (no lease) while the question was open");
  assert.deepEqual(s.events, ["asked", "call:read_inbox"]);
  const q = s.asked[0].params;
  assert.ok(!JSON.stringify(q).includes(SECRET), "never message text");
  assert.match(q.message, new RegExp(`member ${ALICE} in realm ${R}, authenticated by the relay`));
  assert.match(q.message, /Name as reported by the relay: "member alice"/);
  assert.match(q.message, new RegExp(`For: ${R}/s`));
  assert.deepEqual(Object.keys(q.requestedSchema.properties), ["decision"]);
  assert.deepEqual(q.requestedSchema.properties.decision.enum, ["allow-once", "later"]);
  assert.doesNotMatch(out, NOTE, "released before the read: no note left");
  assert.equal((await pending(h)).length, 0);
  const got = await h.store.take(processConsumer("engine", "e"), { screen: h.c.screenFor({ realm: R, name: "s" }) });
  assert.deepEqual(got.messages.map((m) => m.msg.text), [SECRET]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(h.dir, "contacts.json"), "utf8")).grants.length, 0, "no lasting grant");
});

for (const [row, info, answer, outcome] of [
  ["Claude Code (cancel)", { name: "claude-code", version: "2.1.294" }, () => ({ action: "cancel" }), "cancel"],
  ["Codex with approval_policy never (instant decline)", { name: "codex-mcp-client", version: "0.161.0" }, () => ({ action: "decline" }), "decline"],
  ["Antigravity (cancel)", { name: "antigravity", version: "1.3.1" }, () => ({ action: "cancel" }), "cancel"],
]) {
  test(`${row}: the request stays pending, a cooldown starts, read_inbox returns its normal result with the note`, async (t) => {
    const h = await home(t);
    const adapter = createElicitation({ home: h.dir });
    const s = await connect(t, h, { adapter, info, answer });
    assert.match(await s.read(), NOTE);
    assert.equal(s.asked.length, 1, outcome);
    assert.equal((await pending(h)).length, 1);
    assert.equal(adapter.cooling(`contact:${(await pending(h))[0].id}`), true);
    assert.match(await s.read(), NOTE);
    assert.equal(s.asked.length, 1, "not asked again during the cooldown");
  });
}

test("never asked: a client without form support, a session that requested 2026-07-28, an unknown future or an older revision", async (t) => {
  for (const [why, o] of [
    ["no form support", { form: false }],
    ["2026-07-28", { revision: "2026-07-28" }],
    ["an unknown future revision", { revision: "2027-03-01" }],
    ["a revision not on the allow list", { revision: "2025-03-26" }],
  ]) {
    const h = await home(t);
    const s = await connect(t, h, { adapter: createElicitation({ home: h.dir }), ...o, answer: () => ({ action: "accept", content: { decision: "allow-once" } }) });
    assert.match(await s.read(), NOTE, why);
    assert.equal(s.asked.length, 0, why);
    assert.equal((await pending(h)).length, 1, why);
  }
  // Without the adapter (the default) nothing is asked either.
  const h = await home(t);
  const s = await connect(t, h, { adapter: null, answer: () => ({ action: "accept", content: { decision: "allow-once" } }) });
  assert.match(await s.read(), NOTE);
  assert.equal(s.asked.length, 0);
});

test("an answer outside the enum (block, allow, anything) is treated as later", async (t) => {
  for (const decision of ["block", "allow", "yes"]) {
    const h = await home(t);
    const adapter = createElicitation({ home: h.dir });
    const s = await connect(t, h, { adapter, answer: () => ({ action: "accept", content: { decision } }) });
    assert.match(await s.read(), NOTE, decision);
    assert.equal(s.asked.length, 1);
    assert.equal((await pending(h)).length, 1, `${decision}: still pending`);
    const doc = JSON.parse(fs.readFileSync(path.join(h.dir, "contacts.json"), "utf8"));
    assert.deepEqual([doc.grants.length, doc.blocks.length], [0, 0], `${decision}: nothing lasting`);
    assert.equal(adapter.cooling(`contact:${(await pending(h))[0].id}`), true);
  }
  // The adapter's own check, without the SDK's schema validation in front of it: only an
  // accepted allow-once releases; a declined or cancelled form with that value does not.
  const session = { requested: "2025-11-25", negotiated: "2025-11-25", capabilities: { elicitation: { form: {} } } };
  for (const result of [{ action: "decline", content: { decision: "allow-once" } }, { action: "cancel", content: { decision: "allow-once" } }, { action: "accept", content: { decision: "block" } }, { action: "accept", content: { decision: ["allow-once"] } }, { action: "accept" }]) {
    const h = await home(t);
    const r = await createElicitation({ home: h.dir }).beforeRead({ session, ask: async () => result });
    assert.equal(r.asked, true);
    assert.equal((await pending(h)).length, 1, JSON.stringify(result));
  }
  // later itself.
  const h = await home(t);
  const s = await connect(t, h, { adapter: createElicitation({ home: h.dir }), answer: () => ({ action: "accept", content: { decision: "later" } }) });
  assert.match(await s.read(), NOTE);
  assert.equal((await pending(h)).length, 1);
});

test("a new arrival while the question is open makes the stored token stale: nothing is released, the next read asks again", async (t) => {
  const h = await home(t);
  const adapter = createElicitation({ home: h.dir });
  const s = await connect(t, h, {
    adapter,
    answer: async () => {
      if (s.asked.length === 1) await h.c.hold(h.bound.dir, { realm: R, name: "s" }, fromAlice("second"), "ask");
      return { action: "accept", content: { decision: "allow-once" } };
    },
  });
  assert.match(await s.read(), /2 messages/);
  assert.equal((await pending(h))[0].items, 2, "nothing was released");
  assert.equal(adapter.cooling(`contact:${(await pending(h))[0].id}`), false, "stale starts no cooldown");
  await s.read();
  assert.equal(s.asked.length, 2, "asked again with the new view");
  assert.match(s.asked[1].params.message, /2 messages/);
  assert.equal((await pending(h)).length, 0, "the second answer released both");
});

test("the bound: an answer after the timeout is ignored, the request stays pending with a cooldown, read_inbox goes on", async (t) => {
  const h = await home(t);
  const adapter = createElicitation({ home: h.dir, timeoutMs: 200 });
  // The answer comes well after the bound; the read must have returned before it (an order, not
  // a wall-clock budget, so a loaded machine cannot make this flaky).
  let answered = null;
  let lateSent;
  const late = new Promise((r) => (lateSent = r));
  const s = await connect(t, h, {
    adapter,
    answer: async () => {
      await sleep(1500);
      answered = Date.now();
      lateSent();
      return { action: "accept", content: { decision: "allow-once" } };
    },
  });
  assert.match(await s.read(), NOTE);
  assert.equal(answered, null, "the read did not wait for the late answer");
  await late;
  await sleep(200); // the late answer reaches the server
  assert.equal((await pending(h)).length, 1, "ignored");
  assert.equal(adapter.cooling(`contact:${(await pending(h))[0].id}`), true);
  // The default bound passed to the client request is 60 seconds.
  const seen = [];
  const a2 = createElicitation({ home: h.dir });
  await a2.beforeRead({ session: { requested: "2025-11-25", negotiated: "2025-11-25", capabilities: { elicitation: { form: {} } } }, ask: async (_q, o) => (seen.push(o.timeout), { action: "cancel" }) });
  assert.deepEqual(seen, [60_000]);
});
