// The owner UI (design 3.4, lib/ownerui.js): Host, Origin and Sec-Fetch-Site checks, the launch
// token and the session cookie, form tokens bound to their allowed set, bodies, headers on every
// response, untrusted text rendered inert, no GET that changes anything, and decisions and
// settings that end exactly as through the CLI.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { BIN } from "../lib/config.js";
import { settingsContext } from "../lib/decisions.js";
import { LIMITS, SECURITY_HEADERS, esc, startOwnerUi } from "../lib/ownerui.js";
import { openBound } from "../lib/session.js";
import { openStore, processConsumer } from "../lib/store.js";
import { openContacts } from "../lib/quarantine.js";
import { fakeDevice, seedOwn } from "./mls-helpers.js";

const R = "a".repeat(32);
const ALICE = "m_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const BOB = "m_bbbbbbbbbbbbbbbbbbbbbbbbbb";
const RLO = String.fromCharCode(0x202e);
const tmpHome = (t) => {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), "hoptell-ui-"));
  t.after(() => fs.rmSync(h, { recursive: true, force: true }));
  return h;
};
const from = (member, name, text) => ({ type: "message", id: crypto.randomUUID(), from: `${name}-x`, fromHost: "h", text, ts: 1, sender: { auth: "member", member: { id: member, name }, realm: R } });
const session = (name) => ({ realm: R, name });
const digestOf = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
function snapshot(home) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (!e.name.endsWith(".lock")) out[path.relative(home, p)] = digestOf(p);
    }
  };
  walk(home);
  return out;
}

/** A home with held messages from alice (and bob), and a UI on it. */
async function setup(t, { requests = [], clock = null, fault = null } = {}) {
  const home = tmpHome(t);
  const c = await openContacts(home, { notify: false, ...(fault ? { fault } : {}) });
  const bound = await openBound(home, { realm: R, member: null, key: "s" });
  const store = await openStore(bound);
  await c.hold(bound.dir, session("s"), from(ALICE, "alice", "hello <script>alert(1)</script> " + RLO + "evil"), "ask");
  await c.hold(bound.dir, session("s"), from(BOB, "bob", "from bob"), "ask");
  const relaysFile = path.join(home, "relays.json");
  fs.writeFileSync(relaysFile, `${JSON.stringify({ version: 1, relays: [{ alias: "lab", url: "ws://192.0.2.1:7777", tokenFile: "t" }] }, null, 2)}\n`, { mode: 0o600 });
  const sources = { contacts: c, relay: { contactRequests: async () => requests } };
  const ui = await startOwnerUi({ home, sources, ctx: settingsContext({ env: {}, fromFile: [], envFile: path.join(home, "settings.env"), relaysFile }), ...(clock ? { now: () => clock.t } : {}) });
  t.after(() => ui.close());
  const st = await c.status();
  const idOf = (label) => `contact:${st.requests.find((r) => r.sender.label === label).id}`;
  return { home, c, bound, store, ui, relaysFile, alice: idOf("member alice"), bob: idOf("member bob") };
}

const responses = [];
function request(ui, { method = "GET", path: p = "/", headers = {}, body = null, host = `127.0.0.1:${ui.port}` } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port: ui.port, method, path: p, headers: { Host: host, ...headers } }, (res) => {
      let d = "";
      res.setEncoding("utf8");
      res.on("data", (x) => (d += x));
      res.on("end", () => {
        responses.push({ status: res.statusCode, headers: res.headers });
        resolve({ status: res.statusCode, headers: res.headers, body: d });
      });
    });
    r.on("error", reject);
    if (body) r.write(body);
    r.end();
  });
}
async function launch(ui) {
  const u = new URL(ui.launchUrl());
  const r = await request(ui, { path: u.pathname + u.search });
  assert.equal(r.status, 303);
  return r.headers["set-cookie"][0].split(";")[0];
}
const get = (ui, cookie, p, headers = {}) => request(ui, { path: p, headers: { Cookie: cookie, ...headers } });
const post = (ui, cookie, p, fields, headers = {}) =>
  request(ui, { method: "POST", path: p, body: new URLSearchParams(fields).toString(), headers: { Cookie: cookie, Origin: `http://127.0.0.1:${ui.port}`, "Content-Type": "application/x-www-form-urlencoded", "Sec-Fetch-Site": "same-origin", ...headers } });
const unesc = (s) => s.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
function formsOf(html) {
  const out = [];
  for (const m of html.matchAll(/<form[^>]*action="([^"]+)"[^>]*>([\s\S]*?)<\/form>/g)) {
    const fields = {};
    for (const i of m[2].matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)) fields[i[1]] = unesc(i[2]);
    out.push({ action: m[1], fields, html: m[2] });
  }
  return out;
}
const formFor = async (ui, cookie, id, action) => formsOf((await get(ui, cookie, `/decision?id=${encodeURIComponent(id)}`)).body).find((f) => f.fields.action === action);

test("Host must be exactly 127.0.0.1:<port>; POST needs the UI's Origin; Sec-Fetch-Site is checked", async (t) => {
  const { home, ui, alice } = await setup(t);
  const cookie = await launch(ui);
  assert.equal((await get(ui, cookie, "/pending")).status, 200);
  for (const host of [`localhost:${ui.port}`, `127.0.0.1:${ui.port + 1}`, "attacker.example", `127.0.0.1`]) {
    assert.equal((await request(ui, { path: "/pending", host, headers: { Cookie: cookie } })).status, 403, host);
  }
  assert.equal((await get(ui, cookie, "/pending", { "Sec-Fetch-Site": "cross-site" })).status, 403);
  const f = await formFor(ui, cookie, alice, "allow-once");
  const before = snapshot(home);
  const tries = [{ Origin: "http://attacker.example" }, { Origin: `http://localhost:${ui.port}` }, { Origin: "null" }, { Origin: "" }, { "Sec-Fetch-Site": "cross-site" }, { "Sec-Fetch-Site": "same-site" }];
  for (const h of tries) assert.equal((await post(ui, cookie, "/decide", f.fields, h)).status, 403, JSON.stringify(h));
  // The POST without an Origin header at all.
  const bare = await request(ui, { method: "POST", path: "/decide", body: new URLSearchParams(f.fields).toString(), headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" } });
  assert.equal(bare.status, 403);
  assert.deepEqual(snapshot(home), before, "nothing was written");
  // The same form with the right headers is accepted: the refusals above were the checks.
  const ok = await post(ui, cookie, "/decide", f.fields);
  assert.equal(ok.status, 200, ok.body);
  assert.match(ok.body, /Released 1 message/);
});

test("launch token: single use, 60 seconds, not burnt by a prefetch; the cookie is required; one session at a time", async (t) => {
  const clock = { t: Date.now() };
  const { ui } = await setup(t, { clock });
  assert.equal((await request(ui, { path: "/pending" })).status, 403, "no cookie");
  assert.equal((await request(ui, { path: "/pending", headers: { Cookie: `hoptell_ui=${"A".repeat(43)}` } })).status, 403, "a made-up cookie");
  const u = new URL(ui.launchUrl());
  const pre = await request(ui, { path: u.pathname + u.search, headers: { "Sec-Purpose": "prefetch;prerender" } });
  assert.equal(pre.status, 403);
  assert.equal(pre.headers["set-cookie"], undefined);
  assert.equal((await request(ui, { path: u.pathname + u.search, headers: { Purpose: "prefetch" } })).status, 403);
  const head = await request(ui, { method: "HEAD", path: u.pathname + u.search });
  assert.notEqual(head.status, 303, "a HEAD (a link check) never consumes it");
  assert.equal(head.headers["set-cookie"], undefined);
  const first = await request(ui, { path: u.pathname + u.search });
  assert.equal(first.status, 303, "the prefetches and the HEAD did not consume it");
  assert.match(first.headers["set-cookie"][0], /^hoptell_ui=[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Strict; Path=\/$/);
  const replay = await request(ui, { path: u.pathname + u.search });
  assert.equal(replay.status, 403, "replayed");
  assert.equal(replay.headers["set-cookie"], undefined);
  const u2 = new URL(ui.launchUrl());
  clock.t += LIMITS.launchMs + 1;
  assert.equal((await request(ui, { path: u2.pathname + u2.search })).status, 403, "expired");
  assert.equal((await request(ui, { path: "/launch" })).status, 403, "missing");
  const c1 = first.headers["set-cookie"][0].split(";")[0];
  assert.equal((await get(ui, c1, "/pending")).status, 200);
  const c2 = await launch(ui);
  assert.equal((await get(ui, c1, "/pending")).status, 403, "a new launch ends the old session");
  assert.equal((await get(ui, c2, "/pending")).status, 200);
  clock.t += LIMITS.sessionIdleMs + 1;
  assert.equal((await get(ui, c2, "/pending")).status, 403, "idle limit");
});

test("form tokens: expired, from another session, for another decision or setting key, or outside the allowed set are refused; a stale token changes nothing", async (t) => {
  const clock = { t: Date.now() };
  const { home, c, bound, ui, alice, bob } = await setup(t, { clock });
  let cookie = await launch(ui);
  const before = snapshot(home);
  const f = await formFor(ui, cookie, alice, "allow-once");
  const refused = async (fields, why, ck = cookie) => {
    const r = await post(ui, ck, "/decide", fields);
    assert.equal(r.status, 403, `${why}: ${r.status} ${r.body.slice(0, 200)}`);
  };
  await refused({ ...f.fields, id: bob }, "another decision");
  await refused({ ...f.fields, action: "block" }, "an action outside the allowed set");
  await refused({ ...f.fields, action: "allow", allowed: JSON.stringify({ action: "allow", options: {} }) }, "an allowed set the token does not cover");
  await refused({ ...f.fields, session: `${R}/other` }, "an option outside the allowed set");
  await refused({ ...f.fields, ft: f.fields.ft.replace(/^\d+/, (n) => String(Number(n) + 1)) }, "a changed expiry");
  clock.t += LIMITS.formMs + 1;
  await refused(f.fields, "expired");
  clock.t -= LIMITS.formMs + 1;
  const other = await launch(ui); // another session: its key is new
  await refused(f.fields, "from another session", other);
  cookie = other;
  assert.deepEqual(snapshot(home), before, "nothing was written");

  // Settings: another key, a value outside the allowed set.
  const s = formsOf((await get(ui, cookie, "/setting?key=contacts.default")).body);
  assert.deepEqual(s.map((x) => x.fields.value).sort(), ["allow", "block"]);
  const allowForm = s.find((x) => x.fields.value === "allow");
  assert.match(allowForm.html, /widens access/);
  assert.doesNotMatch(s.find((x) => x.fields.value === "block").html, /widens access/);
  for (const [fields, why] of [
    [{ ...allowForm.fields, key: "contacts.unverified" }, "another setting key"],
    [{ ...allowForm.fields, value: "block" }, "a value outside the allowed set"],
  ]) {
    const r = await post(ui, cookie, "/setting", fields);
    assert.equal(r.status, 403, why);
  }
  assert.deepEqual(snapshot(home), before, "nothing was written");

  // A stale token: a new arrival after the page was rendered.
  const g = await formFor(ui, cookie, alice, "allow-once");
  await c.hold(bound.dir, session("s"), from(ALICE, "alice", "later"), "ask");
  const mid = snapshot(home);
  const r = await post(ui, cookie, "/decide", g.fields);
  assert.equal(r.status, 409);
  assert.match(r.body, /changed since you looked/);
  assert.deepEqual(snapshot(home), mid, "nothing was written");
  // The page shows the new state with new forms, which work.
  const fresh = formsOf(r.body).find((x) => x.fields.action === "allow-once");
  assert.equal((await post(ui, cookie, "/decide", fresh.fields)).status, 200);
});

test("bodies: JSON and multipart refused, 65 KB refused, OPTIONS 405; security headers on every response", async (t) => {
  const { ui, alice } = await setup(t);
  const cookie = await launch(ui);
  const f = await formFor(ui, cookie, alice, "allow-once");
  assert.equal((await post(ui, cookie, "/decide", f.fields, { "Content-Type": "application/json" })).status, 415);
  assert.equal((await post(ui, cookie, "/decide", f.fields, { "Content-Type": "multipart/form-data; boundary=x" })).status, 415);
  const big = await request(ui, { method: "POST", path: "/decide", body: `${new URLSearchParams(f.fields)}&pad=${"x".repeat(65 * 1024)}`, headers: { Cookie: cookie, Origin: `http://127.0.0.1:${ui.port}`, "Content-Type": "application/x-www-form-urlencoded" } });
  assert.equal(big.status, 413);
  assert.equal((await request(ui, { method: "OPTIONS", path: "/decide" })).status, 405);
  assert.equal((await request(ui, { method: "PUT", path: "/decide" })).status, 405);
  assert.equal((await get(ui, cookie, "/nowhere")).status, 404);
  assert.equal((await post(ui, cookie, "/decide", { ...f.fields, extra: "1" })).status, 400, "unknown fields");
  assert.equal((await request(ui, { path: "/style.css" })).headers["content-type"], "text/css; charset=utf-8");
  for (const r of responses) {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) assert.equal(r.headers[k.toLowerCase()], v, `${k} on a ${r.status}`);
    assert.equal(r.headers["access-control-allow-origin"], undefined);
  }
  assert.ok(new Set(responses.map((r) => r.status)).size >= 6, "headers were checked on many kinds of responses");
});

test("untrusted text is rendered inert: <script>, U+202E and newlines", async (t) => {
  const name = `<script>alert(1)</script>${RLO}gnp.exe\nsecond line`;
  const { ui, alice } = await setup(t, { requests: [{ id: "cr1", from: ALICE, name, reason: "review", at: Date.now() }] });
  const cookie = await launch(ui);
  const page = (await get(ui, cookie, "/decision?id=contact-request:cr1")).body;
  assert.match(page, /&#60;script&#62;alert\(1\)&#60;\/script&#62;\\u202Egnp\.exe\\u000Asecond line/);
  const text = (await get(ui, cookie, `/text?id=${encodeURIComponent(alice)}`)).body;
  assert.match(text, /untrusted peer text/);
  assert.match(text, /hello &#60;script&#62;alert\(1\)&#60;\/script&#62; \\u202Eevil/);
  for (const p of [page, text, (await get(ui, cookie, "/pending")).body]) {
    assert.doesNotMatch(p, /<script/i);
    assert.ok(!p.includes(RLO), "no raw override character");
  }
  assert.equal(esc(`a\tb\u0007c${String.fromCharCode(0x2066)}`), "a\\u0009b\\u0007c\\u2066");
  assert.equal(esc("line1\nline2", { keepNewlines: true }), "line1\nline2");
});

test("no GET changes anything: a crawler over every link (settled state), and /launch changes no decision or setting", async (t) => {
  const { home, ui } = await setup(t, { requests: [{ id: "cr1", from: ALICE, name: "x", reason: "other", at: Date.now() }] });
  assert.deepEqual(fs.existsSync(path.join(home, "contacts", "journal")) ? fs.readdirSync(path.join(home, "contacts", "journal")) : [], [], "no journal pending");
  const before = snapshot(home);
  const cookie = await launch(ui);
  assert.deepEqual(snapshot(home), before, "/launch changed nothing on disk");
  const seen = new Set();
  const queue = ["/"];
  while (queue.length) {
    const p = queue.shift();
    if (seen.has(p)) continue;
    seen.add(p);
    const r = await get(ui, cookie, p);
    assert.ok([200, 404].includes(r.status), `${p}: ${r.status}`);
    for (const m of r.body.matchAll(/href="([^"]+)"/g)) {
      const link = unesc(m[1]);
      if (link.startsWith("/") && !link.startsWith("/launch")) queue.push(link);
    }
  }
  assert.ok(seen.size >= 10, `crawled ${[...seen].join(" ")}`);
  assert.ok([...seen].some((p) => p.startsWith("/decision")) && [...seen].some((p) => p.startsWith("/text")) && [...seen].some((p) => p.startsWith("/setting?")));
  assert.deepEqual(snapshot(home), before, "nothing changed");
});

test("a GET of a read view completes an interrupted, already authorized decision and starts no other", async (t) => {
  let armed = false;
  const fault = (p, f) => {
    if (armed && p === "contacts-dir-fsync" && f.endsWith(`${path.sep}journal`)) {
      armed = false;
      throw Object.assign(new Error("simulated"), { code: "EIO" });
    }
  };
  const { home, c, store, ui, alice, bob } = await setup(t, { fault });
  const shown = await c.show(alice.slice(8));
  armed = true;
  await assert.rejects(c.allowOnce(alice.slice(8), { rev: shown.rev, policyRev: shown.policyRevision }), /simulated/);
  assert.equal(fs.readdirSync(path.join(home, "contacts", "journal")).filter((f) => f.endsWith(".json")).length, 1, "the authorized decision is journaled");
  const bobFile = path.join(home, "contacts", "requests", `${bob.slice(8)}.json`);
  const bobBefore = fs.readFileSync(bobFile, "utf8");
  const policyBefore = digestOf(path.join(home, "contacts.json"));
  const cookie = await launch(ui);
  const r = await get(ui, cookie, "/pending");
  assert.equal(r.status, 200);
  assert.doesNotMatch(r.body, /member alice/, "the journaled decision completed");
  assert.match(r.body, /member bob/);
  assert.equal(fs.readdirSync(path.join(home, "contacts", "journal")).filter((f) => f.endsWith(".json")).length, 0);
  assert.equal(fs.readFileSync(bobFile, "utf8"), bobBefore, "no other decision started");
  assert.equal(digestOf(path.join(home, "contacts.json")), policyBefore);
  const got = await store.take(processConsumer("engine", "e"), { screen: c.screenFor(session("s")) });
  assert.equal(got.messages.length, 1);
});

/** Run the CLI on a home. */
function cli(home, args) {
  const envFile = path.join(home, "empty.env");
  fs.writeFileSync(envFile, "");
  const env = { ...process.env, HOPTELL_HOME: home, HOPTELL_ENV: envFile, HOPTELL_NOTIFY: "off", XDG_CONFIG_HOME: path.join(home, "config") };
  for (const k of ["HOPTELL_RELAY", "HOPTELL_RELAYS", "HOPTELL_NAME", "HOPTELL_EXPERIMENTAL_E2EE"]) delete env[k];
  return new Promise((resolve) => execFile(process.execPath, [BIN, ...args], { env, timeout: 30_000 }, (err, stdout, stderr) => resolve({ code: err ? (err.code ?? 1) : 0, stdout, stderr })));
}

test("the CLI and the UI give identical effects for the same decision", async (t) => {
  const results = [];
  for (const via of ["cli", "ui"]) {
    const { home, c, store, ui, alice } = await setup(t);
    if (via === "cli") {
      const shown = await cli(home, ["contacts", "show", alice.slice(8)]);
      const [, rev, pr] = /--rev (\d+) --policy-rev (\d+)/.exec(shown.stdout);
      const r = await cli(home, ["contacts", "allow", alice.slice(8), "--rev", rev, "--policy-rev", pr]);
      assert.equal(r.code, 0, r.stderr);
      results.push({ out: r.stdout.trim() });
    } else {
      const cookie = await launch(ui);
      const r = await post(ui, cookie, "/decide", (await formFor(ui, cookie, alice, "allow")).fields);
      results.push({ out: /<p>(Released[^<]*)<\/p>/.exec(r.body)[1] });
    }
    const doc = JSON.parse(fs.readFileSync(path.join(home, "contacts.json"), "utf8"));
    const got = await store.take(processConsumer("engine", via), { screen: c.screenFor(session("s")) });
    Object.assign(results.at(-1), {
      revision: doc.revision,
      grants: doc.grants.map(({ id, added, ...rest }) => (void id, void added, rest)),
      released: got.messages.map((m) => m.msg.text),
      pending: (await c.status()).requests.map((r) => r.sender.label),
    });
  }
  assert.deepEqual(results[1], results[0]);
  assert.equal(results[0].out, "Released 1 message(s) and added a grant.");
});

test("settings through the UI: an enum value in one confirmation; file roots reviewed, then confirmed with a widening mark", async (t) => {
  const { home, ui, relaysFile } = await setup(t);
  const cookie = await launch(ui);
  const join = formsOf((await get(ui, cookie, "/setting?key=relays.lab.join")).body);
  assert.equal(join.length, 1);
  assert.equal((await post(ui, cookie, "/setting", join[0].fields)).status, 200);
  assert.equal(JSON.parse(fs.readFileSync(relaysFile, "utf8")).relays[0].join, false);
  const [review] = formsOf((await get(ui, cookie, "/setting?key=files.roots")).body);
  const confirm = await post(ui, cookie, "/setting/review", { ...review.fields, value: '[{"id":"app","path":"/srv/app"}]' });
  assert.match(confirm.body, /widens access/);
  const [ok] = formsOf(confirm.body);
  const tampered = await post(ui, cookie, "/setting", { ...ok.fields, value: '[{"id":"app","path":"/"}]' });
  assert.equal(tampered.status, 403, "only the reviewed value");
  assert.equal(fs.existsSync(path.join(home, "settings.env")), false);
  assert.equal((await post(ui, cookie, "/setting", ok.fields)).status, 200);
  assert.equal(fs.readFileSync(path.join(home, "settings.env"), "utf8"), 'HOPTELL_SNAPSHOT_ROOTS="[{\\"id\\":\\"app\\",\\"path\\":\\"/srv/app\\"}]"\n');
  // A second confirmation of the same reviewed change is stale (the file's digest moved).
  const again = await post(ui, cookie, "/setting", ok.fields);
  assert.match(again.body, /changed since it was shown/);
});

test("a verify form names no comparison by default: submitted untouched it is refused; relay-tofu is never offered", async (t) => {
  const home = tmpHome(t);
  const c = await openContacts(home, { notify: false });
  const me = `m_${"m".repeat(26)}`;
  const served = (d) => ({ device: d.device, key: d.key.toString("base64"), pin: d.register().pin, seq: 0, rotations: [] });
  const m1 = await fakeDevice(R, me);
  await seedOwn(c, R, me, m1);
  const lists = { [me]: [served(m1)], [BOB]: [served(await fakeDevice(R, BOB))] };
  const devices = { fetch: async (m) => ({ theirs: { realm: R, member: m, devices: lists[m] }, mine: { realm: R, member: me, devices: lists[me] } }) };
  const ui = await startOwnerUi({ home, sources: { contacts: c, devices }, ctx: settingsContext({ env: {}, fromFile: [], envFile: path.join(home, "s.env"), relaysFile: path.join(home, "none.json") }) });
  t.after(() => ui.close());
  const cookie = await launch(ui);
  const page = (await get(ui, cookie, `/decision?id=${encodeURIComponent(`device-verify:${BOB}`)}`)).body;
  assert.match(page, /Safety number/);
  const [form] = formsOf(page);
  assert.match(form.html, /<select name="how"><option value="">choose<\/option><option value="in-person">in-person<\/option><option value="out-of-band">out-of-band<\/option><\/select>/);
  assert.doesNotMatch(form.html, /relay-tofu/);
  const untouched = await post(ui, cookie, "/decide", { ...form.fields, how: "" });
  assert.equal(untouched.status, 403);
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, "contacts.json"), "utf8")).pins, undefined, "nothing pinned");
  assert.equal((await post(ui, cookie, "/decide", { ...form.fields, how: "relay-tofu" })).status, 403);
  const ok = await post(ui, cookie, "/decide", { ...form.fields, how: "out-of-band" });
  assert.equal(ok.status, 200, ok.body);
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, "contacts.json"), "utf8")).pins[0].how, "out-of-band");
});

test("encryption: a violation is shown with a link to the contact's setting and no release; Devices and the conversation checkpoint", async (t) => {
  const home = tmpHome(t);
  const c = await openContacts(home, { notify: false });
  await c.setEncryption({ realm: R, member: ALICE, mode: "required" });
  const bound = await openBound(home, { realm: R, member: null, key: "s" });
  await openStore(bound);
  const msg = from(ALICE, "alice", "plain");
  await c.hold(bound.dir, session("s"), msg, c.verdict(msg, session("s")));
  const me = `m_${"m".repeat(26)}`;
  const served = (d) => ({ device: d.device, key: d.key.toString("base64"), pin: d.register().pin, seq: 0, rotations: [] });
  const a1 = await fakeDevice(R, ALICE);
  const lists = { [me]: [served(await fakeDevice(R, me))], [ALICE]: [served(a1)] };
  const devices = { fetch: async (m) => ({ theirs: { realm: R, member: m, devices: lists[m] }, mine: { realm: R, member: me, devices: lists[me] } }) };
  await c.updatePins((doc) => void (doc.pins = [{ realm: R, member: ALICE, devices: [{ device: a1.device, pin: a1.register().pin, key: a1.key.toString("base64"), seq: 0 }], verifiedAt: new Date().toISOString(), how: "relay-tofu" }]));
  const conversation = { checkpoint: async (m) => (m === ALICE ? { realm: R, group: "g1", generation: 1, epoch: 4, digits: "12345 67890", fork: null } : null) };
  const ui = await startOwnerUi({ home, sources: { contacts: c, devices, conversation }, ctx: settingsContext({ env: { HOPTELL_EXPERIMENTAL_E2EE: "1" }, fromFile: [], envFile: path.join(home, "s.env"), relaysFile: path.join(home, "none.json") }) });
  t.after(() => ui.close());
  const cookie = await launch(ui);
  const pending = (await get(ui, cookie, "/pending")).body;
  const id = /href="\/decision\?id=(encryption-violation%3Aq_[a-z2-7]{16})"/.exec(pending)?.[1];
  assert.ok(id, pending);
  const page = (await get(ui, cookie, `/decision?id=${id}`)).body;
  assert.match(page, /whose encryption you require/);
  assert.equal(formsOf(page).length, 0, "no release offered");
  assert.match(page, new RegExp(`/setting\\?key=encryption\\.${R}\\.${ALICE}`));
  const req = (await get(ui, cookie, `/decision?id=${encodeURIComponent(`contact:${decodeURIComponent(id).slice(21)}`)}`)).body;
  assert.deepEqual(formsOf(req).map((f) => f.fields.action), ["block"]);
  const setting = formsOf((await get(ui, cookie, `/setting?key=${encodeURIComponent(`encryption.${R}.${ALICE}`)}`)).body);
  assert.deepEqual(setting.map((f) => [f.fields.value, /widens access/.test(f.html)]), [["off", true], ["preferred", true]]);
  const dev = (await get(ui, cookie, "/devices")).body;
  assert.match(dev, /<th>Encryption<\/th>/);
  assert.match(dev, />required<\/a>/);
  const cp = (await get(ui, cookie, `/conversation?member=${encodeURIComponent(ALICE)}`)).body;
  assert.match(cp, /Checkpoint: <strong class="fp">12345 67890<\/strong>/);
  assert.match((await get(ui, cookie, `/decision?id=${encodeURIComponent(`device-verify:${ALICE}`)}`)).body, /conversation&#39;s checkpoint|conversation's checkpoint/);
  assert.equal((await get(ui, cookie, "/conversation?member=bad")).status, 404);
});

test("Devices: this member's own devices with fingerprints from the key bytes and their state", async (t) => {
  const { displayFingerprint } = await import("../lib/mls/identity.js");
  const home = tmpHome(t);
  const c = await openContacts(home, { notify: false });
  const me = `m_${"m".repeat(26)}`;
  const [mine, known, fresh, gone] = [await fakeDevice(R, me), await fakeDevice(R, me), await fakeDevice(R, me), await fakeDevice(R, me)];
  // This home's own pins (A1): its enrolled device and one it accepted; never the relay's list.
  const { acceptOwn, writeBaseline } = await import("../lib/mls/own.js");
  await c.updatePins((doc) => {
    writeBaseline(doc, { rec: { realm: R, member: me, device: mine.device, key: mine.key.toString("base64"), seq: 0, retiredKeys: [] }, profile: "p", now: 1 });
    acceptOwn(doc, R, { device: known.device, key: known.key, pin: Buffer.from(known.register().pin, "base64"), seq: 0 }, { by: mine.device, now: 2 });
  });
  const served = (d) => ({ device: d.device, key: d.key.toString("base64"), pin: d.register().pin, seq: 0, rotations: [] });
  const list = { realm: R, member: me, devices: [served(mine), served(known), served(fresh), { device: gone.device, revoked: { at: Date.now(), by: "admin" } }] };
  const devices = { fetch: async () => ({ theirs: list, mine: list }), own: async () => ({ list, thisDevice: mine.device }) };
  const ui = await startOwnerUi({ home, sources: { contacts: c, devices }, ctx: settingsContext({ env: {}, fromFile: [], envFile: path.join(home, "s.env"), relaysFile: path.join(home, "none.json") }) });
  t.after(() => ui.close());
  const cookie = await launch(ui);
  const page = (await get(ui, cookie, "/devices")).body;
  assert.match(page, /<h2>Your devices<\/h2>/);
  const row = (d) => new RegExp(`<tr><td><code>${d.device}</code></td><td class="fp">${displayFingerprint({ realm: R, member: me, device: d.device, key: d.key })}</td><td>([^<]*|<a[^>]*>[^<]*</a>)</td></tr>`).exec(page)?.[1];
  assert.equal(row(mine), "this device");
  assert.equal(row(known), "accepted");
  assert.match(row(fresh), /listed by the relay, not accepted by you: check it/);
  assert.match(page, new RegExp(`device-own%3A${fresh.device}`));
  assert.match(page, new RegExp(`<code>${gone.device}</code></td><td></td><td>revoked [^<]* by the relay admin`));
  // Without the relay's lists the section is not shown, and the page says why.
  const ui2 = await startOwnerUi({ home, sources: { contacts: c }, ctx: settingsContext({ env: {}, fromFile: [], envFile: path.join(home, "s.env"), relaysFile: path.join(home, "none.json") }) });
  t.after(() => ui2.close());
  const p2 = (await get(ui2, await launch(ui2), "/devices")).body;
  assert.doesNotMatch(p2, /Your devices/);
  assert.match(p2, /device lists are not available/);
});

test("requireVerified per contact: the realm's requirement is shown with the contact's flag, and turning the flag off under it is not widening", async (t) => {
  const home = tmpHome(t);
  const c = await openContacts(home, { notify: false });
  const d = await fakeDevice(R, ALICE);
  await c.updatePins((doc) => {
    doc.requireVerified = [R];
    doc.pins = [{ realm: R, member: ALICE, devices: [{ device: d.device, pin: d.register().pin, key: d.key.toString("base64"), seq: 0 }], verifiedAt: new Date().toISOString(), how: "relay-tofu", requireVerified: true }];
  });
  const ctx = settingsContext({ env: { HOPTELL_EXPERIMENTAL_E2EE: "1" }, fromFile: [], envFile: path.join(home, "s.env"), relaysFile: path.join(home, "none.json") });
  const ui = await startOwnerUi({ home, sources: { contacts: c }, ctx });
  t.after(() => ui.close());
  const cookie = await launch(ui);
  const key = `verified.${R}.${ALICE}`;
  const page = (await get(ui, cookie, `/setting?key=${encodeURIComponent(key)}`)).body;
  assert.match(page, /the realm requires it for every contact/);
  assert.match(page, new RegExp(`href="/setting\\?key=verified\\.${R}"`), "links the realm's setting");
  assert.match(page, /In force: <strong>true<\/strong>, required by the realm/);
  const [off] = formsOf(page);
  assert.equal(off.fields.value, "false");
  assert.doesNotMatch(off.html, /widens access/, "the realm still requires it");
  const saved = await post(ui, cookie, "/setting", off.fields);
  assert.equal(saved.status, 200);
  assert.match(saved.body, /is now <code>false<\/code>/);
  assert.match(saved.body, /In force: <strong>true<\/strong>, required by the realm/);
  assert.match(saved.body, /This contact's own flag does not turn it off/);
  // Without the realm's requirement, turning the contact's flag off does widen access.
  const realm = formsOf((await get(ui, cookie, `/setting?key=${encodeURIComponent(`verified.${R}`)}`)).body);
  assert.equal((await post(ui, cookie, "/setting", realm[0].fields)).status, 200);
  const on = formsOf((await get(ui, cookie, `/setting?key=${encodeURIComponent(key)}`)).body);
  assert.equal((await post(ui, cookie, "/setting", on[0].fields)).status, 200); // contact flag back to true
  const p2 = (await get(ui, cookie, `/setting?key=${encodeURIComponent(key)}`)).body;
  assert.match(p2, /In force: <strong>true<\/strong>, required by this contact&#39;s flag/);
  assert.match(formsOf(p2)[0].html, /widens access/);
});
