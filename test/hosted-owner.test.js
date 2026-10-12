// The hosted owner page (design 4.5): OIDC login with state, PKCE, nonce and the iss check, a Lax
// login cookie and a Strict session cookie bound to (issuer, subject, tenant, link generation);
// request rules (exact Host, the public Origin on POST, form-encoded changes with form tokens);
// contact decisions through the decision service; grants and contact requests show-only.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { contactsFile } from "../lib/contacts.js";
import { link, unlink } from "../lib/hostedlinks.js";
import { AUTHORITY, HANNA, HUGO, proxyFetch } from "./hosted-helpers.js";
import { hostedWorld } from "./hosted-world.js";
import { sleep } from "./helpers.js";

const until = async (fn, ms = 4000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(25)) if (await fn()) return true;
  return Boolean(await fn());
};
const formOf = (html, action) => {
  const m = new RegExp(`<form method="post" action="${action}">([\\s\\S]*?)</form>`).exec(html);
  if (!m) return null;
  const f = {};
  for (const x of m[1].matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)) f[x[1]] = x[2].replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
  return f;
};

test("login: state, PKCE and nonce; a Lax login cookie, then a Strict session cookie; the pages render", async (t) => {
  const w = await hostedWorld(t, { owner: true });
  const start = await w.page("GET", "/owner/login");
  assert.equal(start.status, 302);
  assert.match(start.cookies, /^__Host-hoptell-login=[A-Za-z0-9_-]{43}; Secure; HttpOnly; SameSite=Lax; Path=\/; Max-Age=600$/);
  const to = new URL(start.headers.get("location"));
  assert.equal(to.searchParams.get("redirect_uri"), "https://mcp.example.test/owner/callback");
  assert.equal(to.searchParams.get("code_challenge_method"), "S256");
  assert.ok(to.searchParams.get("nonce") && to.searchParams.get("state").length >= 43);
  const s = await w.ownerLogin("hanna-sub");
  assert.equal(s.status, 303);
  assert.match(s.done.cookies, /__Host-hoptell-owner=[A-Za-z0-9_-]{43}; Secure; HttpOnly; SameSite=Strict; Path=\//);
  assert.match(s.done.cookies, /__Host-hoptell-login=; .*Max-Age=0/, "the login cookie is cleared");
  for (const p of ["/owner", "/owner/pending", "/owner/contacts"]) assert.equal((await w.page("GET", p, { cookie: s.cookie })).status, 200, p);
  assert.match((await w.page("GET", "/owner", { cookie: s.cookie })).text, new RegExp(HANNA.id));
});

test("login refusals: no login cookie, a reused state, a mismatched iss or a wrong nonce get 403 and no session", async (t) => {
  const w = await hostedWorld(t, { owner: true });
  // No login cookie.
  const start = await w.page("GET", "/owner/login");
  const back = await fetch(start.headers.get("location"), { redirect: "manual" });
  const cb = new URL(back.headers.get("location"));
  const none = await w.page("GET", cb.pathname + cb.search);
  assert.equal(none.status, 403);
  assert.equal(w.ownerPage.sessions(), 0);
  // A reused state (the callback replayed with the same login cookie): the record was consumed.
  const ok = await w.ownerLogin("hanna-sub");
  assert.ok(ok.cookie);
  const replay = await w.page("GET", ok.callback.pathname + ok.callback.search, { cookie: `__Host-hoptell-login=${ok.loginCookie}` });
  assert.equal(replay.status, 403);
  // Another state than the one stored.
  assert.equal((await w.ownerLogin("hanna-sub", { tamper: (u) => u.searchParams.set("state", "x".repeat(43)) })).status, 403);
  // A mismatched iss.
  assert.equal((await w.ownerLogin("hanna-sub", { tamper: (u) => u.searchParams.set("iss", "https://evil.example") })).status, 403);
  // A wrong nonce in the ID token.
  w.provider.idTokenTamper = { claims: { nonce: "not-the-one" } };
  const bad = await w.ownerLogin("hanna-sub");
  assert.equal(bad.status, 403);
  assert.equal(bad.cookie, null);
  w.provider.idTokenTamper = null;
  // Not linked.
  assert.equal((await w.ownerLogin("nobody-sub")).status, 403);
  assert.equal(w.ownerPage.sessions(), 1, "only the one good login");
});

test("session: rotated on every login; unlink, relink and moves of the link each end it; idle and absolute expiry", async (t) => {
  const clock = { t: Date.now() };
  const w = await hostedWorld(t, { owner: true, clock });
  const first = await w.ownerLogin("hanna-sub");
  const second = await w.ownerLogin("hanna-sub");
  assert.notEqual(first.cookie, second.cookie);
  const alive = async (c) => (await w.page("GET", "/owner/pending", { cookie: c })).status === 200;
  assert.ok(await alive(second.cookie));
  // Unlink revokes it at its next request; a relink of the same subject does not revive it.
  await unlink(w.state, { issuer: w.provider.issuer, subject: "hanna-sub" });
  assert.equal(await alive(second.cookie), false);
  await link(w.state, { issuer: w.provider.issuer, subject: "hanna-sub", member: HANNA });
  // An unlink and a relink of the same subject and member with no request between: the generation differs.
  const again = await w.ownerLogin("hanna-sub");
  assert.ok(await alive(again.cookie));
  await unlink(w.state, { issuer: w.provider.issuer, subject: "hanna-sub" });
  await link(w.state, { issuer: w.provider.issuer, subject: "hanna-sub", member: HANNA });
  assert.equal(await alive(again.cookie), false, "unlink then relink never revives it");
  // A relink of the member to another subject ends the session of the old subject.
  const third = await w.ownerLogin("hanna-sub");
  assert.ok(await alive(third.cookie));
  await link(w.state, { issuer: w.provider.issuer, subject: "hanna-other", member: HANNA });
  assert.equal(await alive(third.cookie), false);
  // A relink of the subject to another member ends it too.
  const fourth = await w.ownerLogin("hanna-other");
  assert.ok(await alive(fourth.cookie));
  await link(w.state, { issuer: w.provider.issuer, subject: "hanna-other", member: HUGO });
  assert.equal(await alive(fourth.cookie), false);
  // Idle (15 minutes) and absolute (8 hours) limits.
  const idle = await w.ownerLogin("hanna-other");
  clock.t += 16 * 60_000;
  assert.equal(await alive(idle.cookie), false, "idle");
  const busy = await w.ownerLogin("hanna-other");
  for (let i = 0; i < 40; i++) {
    clock.t += 14 * 60_000;
    if (!(await alive(busy.cookie))) break;
  }
  assert.equal(await alive(busy.cookie), false, "absolute");
});

test("requests: POST needs the public Origin (and same-origin fetch metadata); a form POST works with the default MCP allow list; a crawler changes nothing", async (t) => {
  const w = await hostedWorld(t, { owner: true });
  await w.connect("hanna-sub"); // the tenant's home and engine
  const bob = await w.bob();
  await bob.send("hanna", "please let me in");
  const s = await w.ownerLogin("hanna-sub");
  let id = null;
  await until(async () => (id = /decision\?id=(contact%3Aq_[a-z2-7]{16})/.exec((await w.page("GET", "/owner/pending", { cookie: s.cookie })).text)?.[1]));
  assert.ok(id, "the held contact request is listed");
  const decision = await w.page("GET", `/owner/decision?id=${id}`, { cookie: s.cookie });
  const form = formOf(decision.text, "/owner/decide");
  assert.ok(form);
  // A crawler over every page changes nothing.
  const before = fs.readFileSync(contactsFile(w.homeOf(HANNA)), "utf8");
  for (const p of ["/owner", "/owner/pending", `/owner/decision?id=${id}`, `/owner/text?id=${id}`, "/owner/contacts", "/owner/grants", "/owner/decide", "/owner/logout"]) await w.page("GET", p, { cookie: s.cookie });
  assert.equal(fs.readFileSync(contactsFile(w.homeOf(HANNA)), "utf8"), before);
  // CSRF: no Origin, another Origin, cross-site fetch metadata.
  const post = (headers) => w.page("POST", "/owner/decide", { cookie: s.cookie, body: { ...form, action: "allow-once" }, headers });
  assert.equal((await w.page("POST", "/owner/decide", { cookie: s.cookie, body: form, headers: { origin: "" } })).status, 403);
  assert.equal((await post({ origin: "https://evil.example" })).status, 403);
  assert.equal((await post({ "sec-fetch-site": "cross-site" })).status, 403);
  // Another Host: refused before the page.
  assert.equal((await proxyFetch(w.port, { host: "evil.example" })(`https://${AUTHORITY}/owner/pending`, { headers: { cookie: s.cookie } })).status, 403);
  // Form tokens cover the action: another action than the form's is refused.
  assert.equal((await w.page("POST", "/owner/decide", { cookie: s.cookie, body: { ...form, action: "block" } })).status, 403);
  // The form as rendered: done.
  const done = await w.page("POST", "/owner/decide", { cookie: s.cookie, body: form });
  assert.equal(done.status, 200, done.text);
  assert.notEqual(fs.readFileSync(contactsFile(w.homeOf(HANNA)), "utf8"), before);
});

test("grants and contact requests are shown only: no form decides them", async (t) => {
  const w = await hostedWorld(t, { owner: true });
  await w.connect("hanna-sub");
  const s = await w.ownerLogin("hanna-sub");
  const g = await w.page("GET", "/owner/grants", { cookie: s.cookie });
  assert.equal(g.status, 200);
  assert.doesNotMatch(g.text, /<form/);
  const forged = await w.page("POST", "/owner/decide", { cookie: s.cookie, body: { id: "contact-request:cr_abcdefghijkl", token: "", action: "accept", allowed: JSON.stringify({ action: "accept", options: {} }), ft: `${Date.now() + 60_000}.${crypto.randomBytes(32).toString("base64url")}` } });
  assert.equal(forged.status, 403);
});
