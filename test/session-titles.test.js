// Session titles (design "readable session names", phase 1): HOPTELL_TITLE, the hello title, the
// "title" capability, peers entries bound to the claim, cleaning and list_peers rendering.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import WebSocket from "ws";
import { startRelay } from "../lib/relay.js";
import { RelayClient, formatPeer, formatPeers } from "../lib/client.js";
import { ClaimTable, GRACE_MS } from "../lib/claims.js";
import { ROOT, TITLE_MAX_BYTES, cleanTitle, envTitle, slugTitle, titleResembles } from "../lib/config.js";
import { readSettings } from "../lib/settings.js";
import { createAccess } from "../lib/access.js";
import { fakeToken, sleep, world } from "./helpers.js";

/** A raw connection that records frames and its close code. */
function connect(url, hello) {
  const ws = new WebSocket(url);
  const frames = [];
  const waiters = [];
  ws.on("message", (d) => {
    const f = JSON.parse(d);
    frames.push(f);
    for (const w of [...waiters]) if (w.match(f)) waiters.splice(waiters.indexOf(w), 1) && w.resolve(f);
  });
  const closed = new Promise((r) => ws.on("close", (code) => r(code)));
  ws.on("error", () => {});
  ws.on("open", () => ws.send(JSON.stringify(hello)));
  const next = (match, ms = 3000) => {
    const seen = frames.find(match);
    if (seen) return Promise.resolve(seen);
    return new Promise((resolve, reject) => {
      waiters.push({ match, resolve });
      setTimeout(() => reject(new Error(`no frame; got ${JSON.stringify(frames.map((x) => x.type))}`)), ms);
    });
  };
  let n = 0;
  const rpc = async (o) => {
    const id = `r${++n}`;
    ws.send(JSON.stringify({ ...o, id }));
    return next((f) => f.id === id);
  };
  return { ws, frames, closed, next, rpc, send: (o) => ws.send(JSON.stringify(o)) };
}

async function setup(t, opts = {}) {
  const tokens = { alice: fakeToken(), bob: fakeToken(), shared: fakeToken() };
  const relay = await startRelay({
    host: "127.0.0.1",
    port: 0,
    token: tokens.shared,
    members: [{ name: "alice", id: "m_aaaaaaaaaaaaaaaaaaaaaaaaaa", token: tokens.alice }, { name: "bob", token: tokens.bob }],
    log: () => {},
    ...opts,
  });
  t.after(() => relay.close());
  const url = `ws://127.0.0.1:${relay.port}`;
  const conns = [];
  t.after(() => conns.forEach((c) => c.ws.terminate()));
  const v2 = (name, token, claim, extra = {}) => {
    const c = connect(url, { type: "hello", v: 2, name, token, host: "pc", mode: "peer", claim, ...extra });
    conns.push(c);
    return c;
  };
  const sender = async (token, name) => {
    const c = connect(url, { type: "hello", v: 2, name, token, host: "pc", mode: "send" });
    conns.push(c);
    await c.next((f) => f.type === "welcome");
    return c;
  };
  const peersOf = async (c) => (await c.rpc({ type: "list" })).peers;
  return { relay, url, tokens, v2, sender, peersOf, conns };
}

const row = (peers, name) => peers.find((p) => p.name === name);

// ---- cleaning -------------------------------------------------------------------------------

test("cleaning: byte limit, controls, Bidi_Control, default-ignorables, separators, the 80 code-point cap, empty", () => {
  assert.equal(cleanTitle("  review   docs "), "review docs");
  // Over 1024 UTF-8 bytes is refused before anything else, also when cleaning would shorten it.
  assert.equal(cleanTitle("a".repeat(TITLE_MAX_BYTES)), `${"a".repeat(79)}…`);
  assert.equal(cleanTitle("a".repeat(TITLE_MAX_BYTES + 1)), null);
  assert.equal(cleanTitle(`x${"​".repeat(400)}`), null, "1201 bytes of mostly invisible text: refused, not cleaned");
  assert.equal(cleanTitle("é".repeat(512)), `${"é".repeat(79)}…`, "512 two-byte letters are exactly 1024 bytes");
  assert.equal(cleanTitle("é".repeat(513)), null);
  // C0, DEL and C1 (U+0085 too) are removed, also tab and newline (Cc).
  assert.equal(cleanTitle("a\u0000b\u0007c\u001bd\u007fe\u0080f\u0085g\u009fh"), "abcdefgh");
  assert.equal(cleanTitle("one\ttwo\nthree\r"), "onetwothree");
  // Every Bidi_Control, U+061C (ARABIC LETTER MARK) included.
  for (const c of ["؜", "‎", "‏", "‪", "‫", "‬", "‭", "‮", "⁦", "⁧", "⁨", "⁩"]) {
    assert.equal(cleanTitle(`ab${c}cd`), "abcd", `U+${c.codePointAt(0).toString(16)}`);
  }
  assert.equal(cleanTitle("‮gnp.exe"), "gnp.exe", "no right-to-left override");
  // Zero-width characters and other default-ignorables: ZWSP, ZWNJ, ZWJ, word joiner, BOM, soft
  // hyphen, a variation selector, a tag character, the Hangul filler; emoji ZWJ sequences split.
  for (const c of ["​", "‌", "‍", "⁠", "﻿", "­", "️", "\u{e0041}", "ㅤ", "͏"]) {
    assert.equal(cleanTitle(`ab${c}cd`), "abcd", `U+${c.codePointAt(0).toString(16)}`);
  }
  assert.equal(cleanTitle("👨‍💻"), "👨💻");
  // U+2028, U+2029 and other whitespace become one space.
  assert.equal(cleanTitle("line two three four　five"), "line two three four five");
  // NFC.
  assert.equal(cleanTitle("é"), "é");
  // Exactly 80 code points stay; 81 become 79 and the ellipsis (80 in all). Astral characters
  // count once.
  const eighty = "x".repeat(80);
  assert.equal(cleanTitle(eighty), eighty);
  const cut = cleanTitle(`${"x".repeat(80)}y`);
  assert.equal(cut, `${"x".repeat(79)}…`);
  assert.equal([...cut].length, 80);
  const astral = cleanTitle("😀".repeat(81));
  assert.equal([...astral].length, 80);
  assert.equal(astral, `${"😀".repeat(79)}…`);
  assert.equal(cleanTitle("😀".repeat(80)), "😀".repeat(80));
  // Empty after cleaning: no title.
  for (const v of ["", "   ", "​‍", "\u0000\u0007", "   ", "‮"]) assert.equal(cleanTitle(v), null, JSON.stringify(v));
  for (const v of [null, undefined, 7, {}, ["x"]]) assert.equal(cleanTitle(v), null);
  // An unpaired surrogate is replaced, never passed on.
  assert.equal(cleanTitle("a\ud800b"), "a�b");
});

test("HOPTELL_TITLE: text, off or unset; an unusable value is reported and nothing is sent", () => {
  assert.equal(envTitle({}), null);
  assert.equal(envTitle({ HOPTELL_TITLE: "" }), null);
  assert.equal(envTitle({ HOPTELL_TITLE: "off" }), "off");
  assert.equal(envTitle({ HOPTELL_TITLE: " OFF " }), "off");
  assert.equal(envTitle({ HOPTELL_TITLE: "  review​ docs " }), "review docs");
  assert.throws(() => envTitle({ HOPTELL_TITLE: "x".repeat(1025) }), /HOPTELL_TITLE is longer than 1024 bytes/);
  assert.throws(() => envTitle({ HOPTELL_TITLE: "​​" }), /HOPTELL_TITLE is empty after removing/);
  const base = { homedir: "/home/u", pid: 1 };
  assert.equal(readSettings({ ...base, env: { HOPTELL_TITLE: "docs" } }).title, "docs");
  assert.equal(readSettings({ ...base, env: {} }).title, null);
  const bad = readSettings({ ...base, env: { HOPTELL_TITLE: "‮" } });
  assert.equal(bad.title, "off", "an unusable title is not replaced by another one");
  assert.match(bad.errors.title, /HOPTELL_TITLE/);
  assert.equal(bad.errors.name, undefined, "not fatal: the session still starts");
});

test("slug and the resemblance check", () => {
  assert.equal(slugTitle("Emin Mac 61034"), "emin-mac-61034");
  assert.equal(slugTitle("İstanbul şehir çay ğ ö ü"), "istanbul-sehir-cay-g-o-u");
  assert.equal(slugTitle("Straße Ærø Łódź þorn"), "strasse-aero-lodz-thorn");
  assert.equal(slugTitle("--__x--"), "x");
  assert.equal(slugTitle("a//b..c-"), "a-b-c");
  assert.ok(titleResembles("bob", ["bob"]));
  assert.ok(titleResembles("Bob", ["bob"]));
  assert.ok(titleResembles("emin mac 61034", ["emin-mac-61034"]));
  assert.ok(titleResembles("emin-mac-61034", ["Emin-Mac-61034"]));
  assert.ok(!titleResembles("review docs", ["bob", "alice"]));
  assert.ok(!titleResembles("!!!", ["x"]));
});

test("the resemblance mark is linear in the list: each address and each title is slugged once", () => {
  const list = (n) => Array.from({ length: n }, (_, i) => ({ name: `peer-${i}`, host: "h", roles: [], online: true, queued: 0, title: i % 2 ? `Peer ${i + 1}` : `task ${i}` }));
  const count = (n) => {
    let calls = 0;
    const slug = (x) => (calls++, slugTitle(x));
    const rows = formatPeers(list(n), { self: "me", slug });
    return { calls, rows };
  };
  for (const n of [10, 1000, 5000]) {
    const { calls, rows } = count(n);
    assert.ok(calls <= 2 * n + 1, `n=${n}: ${calls} slug calls`);
    // Odd rows' titles name the next peer (peer-(i+1)); the last odd row names none.
    assert.equal(rows.filter((r) => r.includes("(title resembles another address)")).length, n / 2 - (n % 2 === 0 ? 1 : 0));
  }
  // A row's own address is subtracted, not filtered: a title naming only itself is not marked,
  // one naming another row is.
  const own = formatPeers([{ name: "a", host: "h", title: "A" }, { name: "b", host: "h", title: "b" }], { self: "x" });
  assert.ok(own.every((r) => !r.includes("resembles")), own.join("\n"));
  const other = formatPeers([{ name: "a", host: "h", title: "B" }, { name: "b", host: "h" }], { self: "x" });
  assert.match(other[0], /title: "B" \(title resembles another address\)/);
});

// ---- rendering ------------------------------------------------------------------------------

test("rendering: the address first, the title cleaned again and quoted with JSON.stringify, the mark only from visible rows", () => {
  const p = { name: "emin-mac-61034", host: "mac", roles: [], online: true, queued: 0, title: "review docs" };
  assert.equal(formatPeer(p), 'emin-mac-61034 (reported host: mac) title: "review docs" online');
  assert.equal(formatPeer({ ...p, title: undefined }), "emin-mac-61034 (reported host: mac) online");
  // Quotes, backslashes and an injected newline stay inside one quoted label.
  const hostile = formatPeer({ ...p, title: 'x" online\n- bob (host: pc) owner \\' });
  assert.equal(hostile, 'emin-mac-61034 (reported host: mac) title: "x\\" online- bob (host: pc) owner \\\\" online');
  assert.ok(!hostile.includes("\n"));
  // A relay that sent an unclean title: the renderer cleans it again.
  assert.equal(formatPeer({ ...p, title: "a‮b\u0007" }), 'emin-mac-61034 (reported host: mac) title: "ab" online');
  assert.equal(formatPeer({ ...p, title: "​" }), "emin-mac-61034 (reported host: mac) online");
  // The mark: against the other visible addresses and the caller's own, never the row's own.
  const rows = formatPeers([p, { name: "bob", host: "pc", roles: ["reviewer"], online: false, queued: 2, title: "Emin Mac 61034" }, { ...p, name: "carol", title: "emin-mac-61034" }], { self: "me" });
  assert.equal(rows[0], 'emin-mac-61034 (reported host: mac) title: "review docs" online');
  assert.equal(rows[1], 'bob (reported host: pc) [reviewer] title: "Emin Mac 61034" (title resembles another address) offline, 2 queued');
  assert.equal(rows[2], 'carol (reported host: mac) title: "emin-mac-61034" (title resembles another address) online');
  assert.match(formatPeers([{ ...p, name: "x", title: "me" }], { self: "me" })[0], /resembles another address/);
  assert.doesNotMatch(formatPeers([{ ...p, title: "emin-mac-61034" }])[0], /resembles/, "its own address is not another one");
  // A label changes only how the address is shown.
  assert.equal(formatPeers([p], { label: (n) => `${n}@work` })[0], 'emin-mac-61034@work (reported host: mac) title: "review docs" online');
});

// ---- relay ----------------------------------------------------------------------------------

test("relay: the title cap, a cleaned hello title in peers entries, ignored on send-only, protocol 1 and when unusable", async (t) => {
  const { tokens, v2, sender, peersOf, url, conns } = await setup(t);
  const a = v2("alice-a", tokens.alice, { action: "acquire" }, { title: " review​‮ docs\u0007 " });
  const w = await a.next((f) => f.type === "welcome");
  assert.ok(w.caps.includes("title"));
  const viewer = await sender(tokens.bob, "bob-cli");
  assert.equal(row(await peersOf(viewer), "alice-a").title, "review docs", "cleaned on the relay too");
  // Unusable titles are ignored, and the hello is accepted.
  for (const [n, title] of [["alice-b", "x".repeat(1025)], ["alice-c", 42], ["alice-d", { a: 1 }], ["alice-e", "​​"]]) {
    const c = v2(n, tokens.alice, { action: "acquire" }, { title });
    assert.ok((await c.next((f) => f.type === "welcome" || f.type === "hello_error")).type === "welcome", n);
    assert.equal(Object.hasOwn(row(await peersOf(viewer), n), "title"), false, n);
  }
  // The cap applies at 80 code points.
  const long = v2("alice-f", tokens.alice, { action: "acquire" }, { title: "y".repeat(100) });
  await long.next((f) => f.type === "welcome");
  assert.equal(row(await peersOf(viewer), "alice-f").title, `${"y".repeat(79)}…`);
  // A send-only hello's title is ignored (it has no claim and no peers entry).
  const s = connect(url, { type: "hello", v: 2, name: "alice-cli", token: tokens.alice, mode: "send", title: "sender" });
  conns.push(s);
  await s.next((f) => f.type === "welcome");
  assert.equal(row(await peersOf(viewer), "alice-cli"), undefined);
  // Protocol 1: unchanged, no title.
  const v1 = connect(url, { type: "hello", v: 1, name: "legacy", token: tokens.shared, host: "pc", title: "old" });
  conns.push(v1);
  await v1.next((f) => f.type === "welcome");
  assert.equal(Object.hasOwn(row(await peersOf(viewer), "legacy"), "title"), false);
  // No title: no field.
  const plain = v2("alice-g", tokens.alice, { action: "acquire" });
  await plain.next((f) => f.type === "welcome");
  assert.equal(Object.hasOwn(row(await peersOf(viewer), "alice-g"), "title"), false);
});

test("relay: the title is bound to the claim: a resume keeps it, a reservation keeps it, a new claim never inherits it, a queue-only entry shows none", async (t) => {
  const { tokens, v2, sender, peersOf } = await setup(t);
  const viewer = await sender(tokens.bob, "bob-cli");
  const a = v2("alice-x", tokens.alice, { action: "acquire" }, { title: "first" });
  const w = await a.next((f) => f.type === "welcome");
  // A resume of the same lease keeps the claim's title (a resume hello's title is not applied).
  a.ws.terminate();
  await sleep(100);
  assert.equal(row(await peersOf(viewer), "alice-x").online, false);
  assert.equal(row(await peersOf(viewer), "alice-x").title, "first", "kept during the reservation");
  const r = v2("alice-x", tokens.alice, { action: "resume", ...w.claim, attempt: "a1" }, { title: "other" });
  const rw = await r.next((f) => f.type === "welcome");
  assert.equal(rw.claim.lease, w.claim.lease);
  assert.equal(row(await peersOf(viewer), "alice-x").title, "first");
  // The same principal's new claim (replace) starts with its own hello title...
  const b = v2("alice-x", tokens.alice, { action: "replace" }, { title: "second" });
  await b.next((f) => f.type === "welcome");
  assert.equal(row(await peersOf(viewer), "alice-x").title, "second");
  // ... or none: it never inherits the previous claim's title.
  const c = v2("alice-x", tokens.alice, { action: "replace" });
  await c.next((f) => f.type === "welcome");
  assert.equal(Object.hasOwn(row(await peersOf(viewer), "alice-x"), "title"), false);
  // An acquire of its own reservation (a restart) is a new claim too.
  const d = v2("alice-x", tokens.alice, { action: "replace" }, { title: "third" });
  await d.next((f) => f.type === "welcome");
  d.ws.terminate();
  await sleep(100);
  const e = v2("alice-x", tokens.alice, { action: "acquire" });
  await e.next((f) => f.type === "welcome");
  assert.equal(Object.hasOwn(row(await peersOf(viewer), "alice-x"), "title"), false);

  // A takeover by another principal (after a clean release) starts with its own title or none.
  const m1 = v2("alice-t", tokens.alice, { action: "acquire" }, { title: "alice's" });
  await m1.next((f) => f.type === "welcome");
  m1.send({ type: "release" });
  m1.ws.close();
  await sleep(100);
  // Queue-only: the claim is gone, a queued message keeps the entry; no title is shown.
  const ack = await viewer.rpc({ type: "send", to: "alice-t", text: "waiting" });
  assert.equal(ack.state, "queued");
  const q = row(await peersOf(viewer), "alice-t");
  assert.equal(q.queued, 1);
  assert.equal(q.online, false);
  assert.equal(Object.hasOwn(q, "title"), false);
  const s1 = v2("alice-t", tokens.shared, { action: "acquire" });
  await s1.next((f) => f.type === "welcome");
  assert.equal(Object.hasOwn(row(await peersOf(viewer), "alice-t"), "title"), false, "the shared token's claim does not inherit alice's title");
  s1.send({ type: "release" });
  s1.ws.close();
  await sleep(100);
  const s2 = v2("alice-t", tokens.shared, { action: "acquire" }, { title: "shared one" });
  await s2.next((f) => f.type === "welcome");
  assert.equal(row(await peersOf(viewer), "alice-t").title, "shared one");
});

test("claims: a reservation keeps the title until it expires; a new claim starts with its own", () => {
  let now = 1_000_000;
  const ct = new ClaimTable({ now: () => now });
  const alice = { kind: "member", id: "m_aaaaaaaaaaaaaaaaaaaaaaaaaa" };
  const bob = { kind: "member", id: "m_bbbbbbbbbbbbbbbbbbbbbbbbbb" };
  const a = { label: "a" };
  ct.hello({ name: "n", socket: a, principal: alice, version: 2, claim: { action: "acquire" }, title: "mine" });
  assert.equal(ct.titleOf("n"), "mine");
  ct.closed("n", a);
  assert.equal(ct.titleOf("n"), "mine");
  now += GRACE_MS;
  assert.equal(ct.titleOf("n"), null, "the reservation expired");
  ct.hello({ name: "n", socket: { label: "b" }, principal: bob, version: 2, claim: { action: "acquire" } });
  assert.equal(ct.titleOf("n"), null, "another principal's claim: no inherited title");
  ct.release("n", { label: "x" }); // not the holder: nothing happens
  assert.equal(ct.status("n").state, "taken");
  ct.hello({ name: "l", socket: { label: "l" }, principal: alice, version: 1, title: "legacy" });
  assert.equal(ct.titleOf("l"), null, "legacy claims have no title");
});

test("visibility: a hidden peer never changes a visible row's title or marks, also one named like the title", async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "hoptell-titles-"));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const ID = { alice: "m_aaaaaaaaaaaaaaaaaaaaaaaaaa", bob: "m_bbbbbbbbbbbbbbbbbbbbbbbbbb", carol: "m_cccccccccccccccccccccccccc", dave: "m_dddddddddddddddddddddddddd" };
  const tok = Object.fromEntries(Object.keys(ID).map((n) => [n, fakeToken()]));
  const relay = await startRelay({ host: "127.0.0.1", port: 0, members: Object.entries(ID).map(([name, id]) => ({ name, id, token: tok[name] })), access: createAccess({ stateDir }), log: () => {} });
  t.after(() => relay.close());
  const url = `ws://127.0.0.1:${relay.port}`;
  const clients = [];
  t.after(() => clients.forEach((c) => c.close()));
  const open = async (o) => {
    const c = new RelayClient({ url, reconnect: false, ...o });
    clients.push(c);
    await c.start().ready(5000);
    return c;
  };
  // carol hides from everyone but alice.
  const carolCli = await open({ token: tok.carol, name: "carol-cli", mode: "send" });
  const cur = (await carolCli.rpc({ type: "grants_get" })).grants;
  await carolCli.rpc({ type: "grants_put", base_revision: cur.revision, grants: { default: "deny", visible: "grantees", entries: [{ selector: `member:${ID.alice}`, action: "allow" }] } });
  const bob = await open({ token: tok.bob, name: "bob" });
  // A visible peer whose title equals the hidden one's address.
  await open({ token: tok.alice, name: "alice", title: "carol" });
  const view = async () => {
    const peers = await bob.list();
    return { alice: row(peers, "alice"), text: formatPeers(peers, { self: "bob" }).find((r) => r.startsWith("alice ")) };
  };
  const before = await view();
  assert.equal(before.alice.title, "carol");
  assert.equal(before.text, `alice (reported host: ${before.alice.host}) title: "carol" online`);
  // Creating the hidden peer, changing it (a new claim with a title) and removing it: no change.
  const carol = await open({ token: tok.carol, name: "carol", title: "alice" });
  assert.equal(row(await bob.list(), "carol"), undefined, "carol is hidden from bob");
  assert.deepEqual(await view(), before);
  carol.close();
  const carol2 = await open({ token: tok.carol, name: "carol", title: "bob" });
  assert.deepEqual(await view(), before);
  carol2.close();
  await sleep(100);
  assert.deepEqual(await view(), before);
  // A visible address of that name does mark it (the check works on what bob can see).
  await open({ token: tok.dave, name: "dave", title: "dave two" });
  const alice2 = await open({ token: tok.alice, name: "alice-2", title: "dave" });
  const rows = formatPeers(await bob.list(), { self: "bob" });
  assert.ok(rows.some((r) => r.startsWith("alice-2 ") && /title: "dave" \(title resembles another address\)/.test(r)), rows.join("\n"));
  assert.ok(rows.some((r) => r.startsWith("alice ") && !/resembles/.test(r)));
  alice2.close();
});

// ---- the client and the MCP -------------------------------------------------------------------

test("client: the title goes only into a protocol-2 receiving hello, cleaned", () => {
  const c = (o) => new RelayClient({ url: "ws://127.0.0.1:1", token: "t".repeat(32), name: "n", ...o });
  assert.equal(c({ title: " a​b " }).hello().title, "ab");
  assert.equal(c({ title: () => "live" }).hello().title, "live");
  assert.equal(Object.hasOwn(c({}).hello(), "title"), false);
  assert.equal(Object.hasOwn(c({ title: "​" }).hello(), "title"), false);
  assert.equal(Object.hasOwn(c({ title: () => { throw new Error("x"); } }).hello(), "title"), false, "a failing source sends none");
  assert.equal(Object.hasOwn(c({ title: "s", mode: "send" }).hello(), "title"), false, "not on send-only hellos");
  assert.equal(Object.hasOwn(c({ title: "p1", protocol: 1 }).hello(), "title"), false, "not on protocol 1");
});

test("MCP: HOPTELL_TITLE shows in other sessions' list_peers, never in message headers; off sends nothing", async (t) => {
  const w = await world();
  t.after(() => w.close());
  const a = await w.mcp("alice", { HOPTELL_TITLE: "Review \"docs\"​" });
  await w.mcp("olga", { HOPTELL_TITLE: "off" });
  const b = await w.mcp("bob");
  const list = await b.call("list_peers");
  assert.match(list, /- alice \(reported host: [^)]+\) title: "Review \\"docs\\"" online/);
  assert.match(list, /- olga \(reported host: [^)]+\) online/);
  assert.doesNotMatch(list, /olga[^\n]*title:/);
  await a.call("send_message", { to: "bob", message: "hello" });
  let inbox = "";
  for (let i = 0; i < 50 && !/hello/.test(inbox); i++) {
    inbox = await b.call("read_inbox");
    if (!/hello/.test(inbox)) await sleep(100);
  }
  assert.match(inbox, /hello/);
  assert.doesNotMatch(inbox, /Review/, "a sender's title is never in a message header");
});

// ---- compatibility --------------------------------------------------------------------------

/**
 * The relay and client of deb1d00 (before titles), from the repository's history, in a temporary
 * folder that reuses this checkout's node_modules. null when git or that commit is not available.
 */
function oldRelease(t) {
  try {
    execFileSync("git", ["-C", ROOT, "cat-file", "-e", "deb1d00^{commit}"], { stdio: "ignore" });
  } catch {
    return null;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hoptell-deb1d00-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const tar = execFileSync("git", ["-C", ROOT, "archive", "--format=tar", "deb1d00", "lib", "package.json"], { maxBuffer: 256 * 1024 * 1024 });
  execFileSync("tar", ["-x", "-C", dir], { input: tar });
  fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(dir, "node_modules"));
  return dir;
}

test("compatibility: a new client on the deb1d00 relay; an old client on a new relay", async (t) => {
  const dir = oldRelease(t);
  // In CI the baseline must be there (the checkouts fetch full history): a missing one fails.
  if (!dir && process.env.CI) assert.fail("the deb1d00 baseline is not in the git history; CI checkouts need full history (fetch-depth: 0, GIT_DEPTH: 0)");
  if (!dir) return t.skip("the deb1d00 baseline is unavailable here (not in the git history, or git is missing)");
  const old = { relay: await import(path.join(dir, "lib/relay.js")), client: await import(path.join(dir, "lib/client.js")) };
  const token = fakeToken();
  // New client, old relay: the hello title is dropped, no cap, no titles, messages and receipts work.
  {
    const relay = await old.relay.startRelay({ host: "127.0.0.1", port: 0, token, log: () => {} });
    t.after(() => relay.close());
    const url = `ws://127.0.0.1:${relay.port}`;
    const got = [];
    const rx = new RelayClient({ url, token, name: "rx", reconnect: false, title: "receiver title" });
    rx.on("message", (m, confirm) => (got.push(m), confirm()));
    await rx.start().ready(5000);
    t.after(() => rx.close());
    assert.equal(rx.caps.includes("title"), false);
    const tx = new RelayClient({ url, token, name: "tx", reconnect: false, title: "sender title" });
    await tx.start().ready(5000);
    t.after(() => tx.close());
    const peers = await tx.list();
    assert.equal(Object.hasOwn(row(peers, "rx"), "title"), false);
    assert.equal(formatPeers(peers)[0], `rx (reported host: ${row(peers, "rx").host}) online`);
    const ack = await tx.send("rx", "over the old relay");
    assert.equal(ack.state, "delivered");
    assert.equal(got[0].text, "over the old relay");
  }
  // Old client, new relay: it sends no title and works as before; it ignores other peers' titles.
  {
    const relay = await startRelay({ host: "127.0.0.1", port: 0, token, log: () => {} });
    t.after(() => relay.close());
    const url = `ws://127.0.0.1:${relay.port}`;
    const titled = new RelayClient({ url, token, name: "titled", reconnect: false, title: "new session" });
    await titled.start().ready(5000);
    t.after(() => titled.close());
    const got = [];
    const oldRx = new old.client.RelayClient({ url, token, name: "old-rx", reconnect: false });
    oldRx.on("message", (m, confirm) => (got.push(m), confirm()));
    await oldRx.start().ready(5000);
    t.after(() => oldRx.close());
    const peers = await oldRx.list();
    assert.equal(row(peers, "titled").title, "new session");
    assert.equal(old.client.formatPeer(row(peers, "titled")), `titled (${row(peers, "titled").host}) online`, "the old renderer ignores it");
    assert.equal(Object.hasOwn(row(await titled.list(), "old-rx"), "title"), false);
    assert.equal((await titled.send("old-rx", "to the old client")).state, "delivered");
    assert.equal(got[0].text, "to the old client");
  }
});

test("compatibility: protocol 1 clients on a new relay are unchanged", async (t) => {
  const token = fakeToken();
  const relay = await startRelay({ host: "127.0.0.1", port: 0, token, log: () => {} });
  t.after(() => relay.close());
  const url = `ws://127.0.0.1:${relay.port}`;
  const v1 = new RelayClient({ url, token, name: "v1", protocol: 1, reconnect: false, title: "ignored" });
  const got = [];
  v1.on("message", (m, confirm) => (got.push(m), confirm()));
  await v1.start().ready(5000);
  t.after(() => v1.close());
  assert.equal(v1.protocolInUse, 1);
  const v2 = new RelayClient({ url, token, name: "v2", reconnect: false, title: "titled" });
  await v2.start().ready(5000);
  t.after(() => v2.close());
  assert.equal(Object.hasOwn(row(await v2.list(), "v1"), "title"), false);
  assert.equal(row(await v1.list(), "v2").title, "titled");
  assert.equal((await v2.send("v1", "x")).state, "delivered");
  assert.equal(got.length, 1);
});
