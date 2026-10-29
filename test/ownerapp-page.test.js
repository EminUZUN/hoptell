// The app's page (design 7.4, section 6; tests of section 11, "Page, automated"): SRI hashes, the
// fixed file table and headers, a source scan, and the Telegram shim in a VM.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { PAGE_DIR, buildPage } from "../lib/ownerapppage.js";
import { agent, appSet, bridgeOn, fakeTelegram, httpRequest, newKey, ownerRelay, paired, tmpHome, until } from "./owner-helpers.js";

const read = (f) => fs.readFileSync(path.join(PAGE_DIR, f), "utf8");

test("page: index.html names every file by its hash, with SRI hashes that match the files", () => {
  const table = buildPage();
  const index = table.get("").body;
  const refs = [...index.matchAll(/(?:href|src)="([^"]+)" integrity="([^"]+)"/g)];
  assert.equal(refs.length, 3);
  for (const [, name, sri] of refs) {
    assert.match(name, /^(app|tg)\.[0-9a-f]{16}\.(js|css)$/);
    const f = table.get(name);
    assert.ok(f, name);
    const d = crypto.createHash("sha256").update(f.body, "utf8").digest();
    assert.equal(sri, `sha256-${d.toString("base64")}`);
    assert.ok(name.includes(d.toString("hex").slice(0, 16)));
    assert.equal(f.body, read(`${name.split(".")[0]}.${name.split(".")[2]}`));
  }
  assert.deepEqual([...table.keys()].sort(), ["", ...refs.map((r) => r[1])].sort());
});

test("page: the source has no innerHTML, eval, Function, storage, external URL or inline script and style", () => {
  for (const f of ["app.js", "tg.js", "app.css", "index.html"]) {
    const src = read(f);
    for (const bad of [/innerHTML|outerHTML|insertAdjacentHTML|document\.write/, /\beval\s*\(|new Function|setTimeout\s*\(\s*["'`]/, /localStorage|sessionStorage|indexedDB|CloudStorage|DeviceStorage|document\.cookie/, /web_app_open_link|web_app_open_tg_link|web_app_data_send|web_app_invoke_custom_method|initDataUnsafe/]) {
      assert.doesNotMatch(src, bad, `${f}: ${bad}`);
    }
    // No URL out, except Telegram Web's origin in the shim (the postMessage target).
    const urls = [...src.matchAll(/https?:\/\/[^\s"'`)]+/g)].map((m) => m[0]);
    assert.deepEqual(urls.filter((u) => !(f === "tg.js" && u === "https://web.telegram.org")), [], f);
  }
  const index = read("index.html");
  assert.doesNotMatch(index, /<script>(?!<)|<script(?![^>]*\ssrc=)[^>]*>|<style|\sstyle=|\son[a-z]+=/i);
});

/** Run the shim in a VM with a fake window: {win, posted, events}. */
function shim({ hash = "", proxy = true, external = false, framed = false } = {}) {
  const posted = [];
  const listeners = {};
  const win = {
    location: { hash },
    addEventListener: (type, fn) => (listeners[type] ??= []).push(fn),
    ...(proxy ? { TelegramWebviewProxy: { postEvent: (type, data) => posted.push({ via: "proxy", type, data }) } } : {}),
    ...(external ? { external: { notify: (json) => posted.push({ via: "external", ...JSON.parse(json) }) } } : {}),
  };
  win.parent = framed ? { postMessage: (json, origin) => posted.push({ via: "parent", origin, ...JSON.parse(json) }) } : win;
  win.window = win;
  vm.runInNewContext(read("tg.js"), { window: win, URLSearchParams, JSON, Object, Map, Number, String, Array });
  return { win, posted, message: (ev) => listeners.message.forEach((fn) => fn(ev)) };
}
const fragment = (version, extra = "") => `#tgWebAppData=${encodeURIComponent("user=%7B%7D&hash=ab")}&tgWebAppVersion=${version}&tgWebAppPlatform=ios&tgWebAppThemeParams=${encodeURIComponent(JSON.stringify({ bg_color: "#000000" }))}${extra}`;

test("shim: reads the launch data from the fragment; posts only the listed events its version allows", () => {
  const s = shim({ hash: fragment("7.0") });
  const tg = s.win.hoptellTg;
  assert.equal(tg.initData, "user=%7B%7D&hash=ab");
  assert.equal(tg.platform, "ios");
  assert.deepEqual({ ...tg.theme }, { bg_color: "#000000" });
  assert.equal(tg.supported, true);
  assert.equal(tg.post("web_app_ready", {}), true);
  assert.equal(tg.post("web_app_request_safe_area", {}), false, "needs 8.0");
  for (const bad of ["web_app_open_link", "web_app_data_send", "web_app_invoke_custom_method", "web_app_open_tg_link", "toString", "__proto__"]) assert.equal(tg.post(bad, {}), false, bad);
  assert.deepEqual(s.posted, [{ via: "proxy", type: "web_app_ready", data: "{}" }]);
  assert.equal(shim({ hash: fragment("8.0") }).win.hoptellTg.post("web_app_request_safe_area", {}), true);
  assert.equal(shim({ hash: fragment("6.0") }).win.hoptellTg.supported, false);
  assert.equal(shim({ hash: fragment("6.10") }).win.hoptellTg.atLeast("6.9"), true);
  // Older desktop clients, then Telegram Web (framed, to its origin only).
  const ext = shim({ hash: fragment("7.0"), proxy: false, external: true });
  ext.win.hoptellTg.post("web_app_expand", {});
  assert.equal(ext.posted[0].via, "external");
  const web = shim({ hash: fragment("7.0"), proxy: false, framed: true });
  web.win.hoptellTg.post("web_app_close", {});
  assert.deepEqual(web.posted[0], { via: "parent", origin: "https://web.telegram.org", eventType: "web_app_close", eventData: {} });
});

test("shim: receiveEvent and Telegram Web messages reach the handlers; other origins, types and malformed data are ignored", () => {
  const s = shim({ hash: fragment("7.0") });
  const got = [];
  s.win.hoptellTg.on("theme_changed", (d) => got.push(["theme", d.theme_params?.bg_color]));
  s.win.hoptellTg.on("back_button_pressed", () => got.push(["back"]));
  s.win.Telegram.WebView.receiveEvent("theme_changed", { theme_params: { bg_color: "#111111" } });
  s.win.Telegram.WebView.receiveEvent("back_button_pressed");
  s.win.Telegram.WebView.receiveEvent("invoice_closed", {});
  s.win.Telegram.WebView.receiveEvent("theme_changed", "not an object");
  s.message({ origin: "https://web.telegram.org", data: JSON.stringify({ eventType: "back_button_pressed", eventData: {} }) });
  s.message({ origin: "https://evil.example", data: JSON.stringify({ eventType: "back_button_pressed" }) });
  s.message({ origin: "https://web.telegram.org", data: "{not json" });
  s.message({ origin: "https://web.telegram.org", data: { eventType: "back_button_pressed" } });
  assert.deepEqual(got, [["theme", "#111111"], ["back"], ["back"]]);
  // The objects cannot be replaced by later script.
  assert.throws(() => {
    "use strict";
    s.win.Telegram = null;
  });
  assert.ok(Object.isFrozen(s.win.Telegram.WebView));
});

test("page: served through the relay with the fixed headers; other paths are 404", async (t) => {
  const r = await ownerRelay(t, { ownerApp: true });
  const home = tmpHome(t);
  paired(home);
  appSet(home, "on", Date.now() - 120_000);
  await agent(t, r.url, r.tokens.me, "me-alice");
  const { bridge } = bridgeOn(t, { home, telegram: fakeTelegram().client(), url: r.url, token: r.tokens.me, key: newKey() });
  await until(() => bridge.appAvailable(), 4000, "registered");
  const id = bridge.state().app.id;
  const index = await httpRequest(r.http, `/app/${id}/`);
  assert.equal(index.status, 200);
  assert.match(index.headers["content-type"], /^text\/html/);
  assert.equal(index.headers["cache-control"], "no-store");
  assert.match(index.headers["content-security-policy"], /default-src 'none'; script-src 'self'/);
  const js = index.body.match(/src="(app\.[0-9a-f]{16}\.js)"/)[1];
  const f = await httpRequest(r.http, `/app/${id}/${js}`);
  assert.equal(f.status, 200);
  assert.equal(f.headers["cache-control"], "max-age=31536000, immutable");
  assert.match(f.headers["content-type"], /^text\/javascript/);
  for (const p of ["app.js", "index.html", "app.0000000000000000.js", "tg.js"]) assert.equal((await httpRequest(r.http, `/app/${id}/${p}`)).status, 404, p);
});

/** A minimal DOM: enough for app.js (elements with text, children, listeners and a few properties). */
function fakeDom() {
  class El {
    constructor(tag) {
      Object.assign(this, { tag, className: "", children: [], listeners: {}, textContent: "", value: "", type: "", placeholder: "", maxLength: 0, rows: 0 });
    }
    append(...c) {
      this.children.push(...c);
    }
    replaceChildren(...c) {
      this.children = c;
    }
    addEventListener(type, fn) {
      (this.listeners[type] ??= []).push(fn);
    }
    fire(type) {
      for (const fn of this.listeners[type] ?? []) fn({});
    }
    all() {
      return [this, ...this.children.flatMap((c) => c.all())];
    }
    text() {
      return this.all().map((e) => e.textContent).filter(Boolean);
    }
  }
  const app = new El("div");
  const props = new Map();
  return {
    app,
    props,
    document: { getElementById: (id) => (id === "app" ? app : null), createElement: (tag) => new El(tag), documentElement: { style: { setProperty: (k, v) => props.set(k, v) } } },
  };
}

test("page: app.js opens a session from initData, lists, and proposes a draft and a setting through the API only", async () => {
  const dom = fakeDom();
  const calls = [];
  const answers = {
    "POST session": { token: "t".repeat(43), expires_in: 900 },
    "GET sessions": { sessions: [{ h: "aaaaaaaaaa", label: "Main", full: "Main (alice)", logical: "alice", machine: "mbp", online: true, fav: false, hidden: false, alias: "Main", last_talked: "2 hours ago" }, { h: "bbbbbbbbbb", label: "bob", full: "bob", logical: "bob", machine: null, online: false, fav: false, hidden: true, alias: null, last_talked: null }], counts: {} },
    "GET session/aaaaaaaaaa": { h: "aaaaaaaaaa", label: "Main", full: "Main (alice)", logical: "alice", machine: "mbp", online: true, fav: false, hidden: false, alias: "Main", last_talked: "2 hours ago" },
    "POST draft": { ok: true },
    "POST prefs": { ok: true, pending: true },
  };
  const fetch = async (url, o) => {
    const key = `${o.method} ${url.replace(/^api\//, "")}`;
    calls.push({ key, body: o.body ? JSON.parse(o.body) : null, auth: o.headers.authorization ?? null, credentials: o.credentials });
    return { status: 200, json: async () => answers[key] };
  };
  const posted = [];
  const win = { location: { hash: fragment("8.0") }, addEventListener: () => {}, TelegramWebviewProxy: { postEvent: (type) => posted.push(type) } };
  win.parent = win;
  win.window = win;
  const ctx = { window: win, document: dom.document, fetch, crypto: globalThis.crypto, btoa, setTimeout: (fn) => fn(), URLSearchParams, JSON, Object, Map, Number, String, Array, Uint8Array };
  vm.runInNewContext(read("tg.js"), ctx);
  vm.runInNewContext(read("app.js"), ctx);
  const settle = () => new Promise((r) => setTimeout(r, 20));
  await settle();
  assert.deepEqual(calls[0], { key: "POST session", body: { init_data: "user=%7B%7D&hash=ab" }, auth: null, credentials: "omit" });
  assert.equal(calls[1].key, "GET sessions");
  assert.equal(calls[1].auth, `Bearer ${"t".repeat(43)}`);
  assert.ok(posted.includes("web_app_ready") && posted.includes("web_app_expand") && posted.includes("web_app_request_safe_area"));
  const texts = dom.app.text();
  assert.ok(texts.includes("Main"));
  assert.ok(texts.includes("🟢 online · last message 2 hours ago"));
  assert.ok(!texts.includes("bob"), "hidden ones only in a search");
  assert.ok(texts.includes("1 hidden. Search to find it."));
  // Open the row, then write a message.
  dom.app.all().find((e) => e.className === "row").fire("click");
  await settle();
  assert.ok(dom.app.text().includes("Main (alice)"));
  assert.ok(dom.app.text().includes("🟢 Online · on mbp · last message 2 hours ago"));
  dom.app.all().find((e) => e.textContent === "☆ Add favourite").fire("click");
  await settle();
  const pref = calls.find((c) => c.key === "POST prefs");
  assert.deepEqual(Object.keys(pref.body).sort(), ["h", "op", "set"]);
  assert.deepEqual(pref.body.set, { fav: true });
  assert.match(pref.body.op, /^[A-Za-z0-9_-]{22}$/);
  assert.ok(dom.app.text().includes("Check the chat to see whether the change was saved."));
  dom.app.all().find((e) => e.textContent === "Write a message").fire("click");
  await settle();
  const box = dom.app.all().find((e) => e.tag === "textarea");
  box.value = "@bob deploy";
  box.fire("input");
  assert.ok(dom.app.text().includes("11 / 3,500"));
  dom.app.all().find((e) => e.textContent === "Review in chat").fire("click");
  await settle();
  const draft = calls.find((c) => c.key === "POST draft");
  assert.deepEqual({ h: draft.body.h, text: draft.body.text }, { h: "aaaaaaaaaa", text: "@bob deploy" });
  assert.ok(!("name" in draft.body), "the page never sends a name");
  assert.ok(dom.app.text().includes("Open the chat to confirm your message."));
  assert.ok(posted.includes("web_app_close"));
  assert.equal(dom.props.get("--tg-theme-bg-color"), "#000000");
});

test("page: a write without a clear answer is uncertain and keeps its op; the page never retries by itself", async () => {
  const dom = fakeDom();
  const calls = [];
  let draftStatus = 504;
  const fetch = async (url, o) => {
    const key = `${o.method} ${url.replace(/^api\//, "")}`;
    calls.push({ key, body: o.body ? JSON.parse(o.body) : null });
    if (key === "POST session") return { status: 200, json: async () => ({ token: "t".repeat(43) }) };
    if (key === "GET sessions") return { status: 200, json: async () => ({ sessions: [{ h: "aaaaaaaaaa", label: "a", full: "a", logical: "a", machine: null, online: true }] }) };
    if (key === "GET session/aaaaaaaaaa") return { status: 200, json: async () => ({ h: "aaaaaaaaaa", label: "a", full: "a", logical: "a", online: true }) };
    return { status: draftStatus, json: async () => (draftStatus === 200 ? { ok: true } : { error: "slow" }) };
  };
  const win = { location: { hash: fragment("7.0") }, addEventListener: () => {}, TelegramWebviewProxy: { postEvent: () => {} } };
  win.parent = win;
  win.window = win;
  const ctx = { window: win, document: dom.document, fetch, crypto: globalThis.crypto, btoa, setTimeout: () => {}, URLSearchParams, JSON, Object, Map, Number, String, Array, Uint8Array };
  vm.runInNewContext(read("tg.js"), ctx);
  vm.runInNewContext(read("app.js"), ctx);
  const settle = () => new Promise((r) => setTimeout(r, 20));
  await settle();
  dom.app.all().find((e) => e.className === "row").fire("click");
  await settle();
  dom.app.all().find((e) => e.textContent === "Write a message").fire("click");
  await settle();
  const box = dom.app.all().find((e) => e.tag === "textarea");
  box.value = "hello";
  box.fire("input");
  dom.app.all().find((e) => e.textContent === "Review in chat").fire("click");
  await settle();
  assert.equal(calls.filter((c) => c.key === "POST draft").length, 1, "not retried");
  assert.ok(dom.app.text().includes("I'm not sure this went through. Check the chat before you try again."));
  draftStatus = 200;
  dom.app.all().find((e) => e.textContent === "Review in chat").fire("click");
  await settle();
  const drafts = calls.filter((c) => c.key === "POST draft");
  assert.equal(drafts.length, 2);
  assert.equal(drafts[1].body.op, drafts[0].body.op, "a manual retry repeats the same op");
});

test("page: an old Telegram, someone else, and a just-changed app each get their text", async () => {
  const run = async (hash, sessionAnswer) => {
    const dom = fakeDom();
    const fetch = async () => ({ status: sessionAnswer[0], json: async () => sessionAnswer[1] });
    const win = { location: { hash }, addEventListener: () => {}, TelegramWebviewProxy: { postEvent: () => {} } };
    win.parent = win;
    win.window = win;
    const ctx = { window: win, document: dom.document, fetch, crypto: globalThis.crypto, btoa, setTimeout: () => {}, URLSearchParams, JSON, Object, Map, Number, String, Array, Uint8Array };
    vm.runInNewContext(read("tg.js"), ctx);
    vm.runInNewContext(read("app.js"), ctx);
    await new Promise((r) => setTimeout(r, 20));
    return dom.app.text();
  };
  assert.deepEqual(await run(fragment("6.0"), [200, {}]), ["Please update Telegram to use this app."]);
  assert.deepEqual(await run(fragment("7.0"), [403, { error: "not_you" }]), ["Only the bot owner can use this app. Open it from the bot chat. If you're the owner and it won't open, wait five minutes and try again."]);
  assert.deepEqual(await run(fragment("7.0"), [403, { error: "just_changed" }]), ["Please wait a minute, then open the app again."]);
});

test("page: a long list comes in pages; the page reads them all, once each row, then renders", async () => {
  const dom = fakeDom();
  const calls = [];
  const row = (h, label) => ({ h, label, full: label, logical: label, machine: null, online: true, fav: false, hidden: false, alias: null, last_talked: null });
  const answers = {
    "POST session": { token: "t".repeat(43), expires_in: 900 },
    "GET sessions": { sessions: [row("aaaaaaaaaa", "first")], counts: {}, next: "cccccccccc/1" },
    "GET sessions/cccccccccc/1": { sessions: [row("aaaaaaaaaa", "first"), row("bbbbbbbbbb", "second")], counts: {}, next: null },
  };
  const fetch = async (url, o) => {
    const key = `${o.method} ${url.replace(/^api\//, "")}`;
    calls.push(key);
    return { status: 200, json: async () => answers[key] };
  };
  const win = { location: { hash: fragment("8.0") }, addEventListener: () => {}, TelegramWebviewProxy: { postEvent: () => {} } };
  win.parent = win;
  win.window = win;
  const ctx = { window: win, document: dom.document, fetch, crypto: globalThis.crypto, btoa, setTimeout: (fn) => fn(), URLSearchParams, JSON, Object, Map, Number, String, Array, Uint8Array };
  vm.runInNewContext(read("tg.js"), ctx);
  vm.runInNewContext(read("app.js"), ctx);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(calls, ["POST session", "GET sessions", "GET sessions/cccccccccc/1"]);
  const texts = dom.app.text();
  assert.equal(texts.filter((x) => x === "first").length, 1, "a row repeated across pages is shown once");
  assert.ok(texts.includes("second"));
});

test("page: the Teams tab shows each team as text only (hostile names stay text), with nothing to tap", async () => {
  const dom = fakeDom();
  const hostile = "<img src=x onerror=alert(1)>";
  const answers = {
    "POST session": { token: "t".repeat(43), expires_in: 900 },
    "GET sessions": { sessions: [], counts: {} },
    "GET teams": {
      teams: [{ team: "n1", status: "partial", lead: `${hostile} (lead)`, machine: "mbp", members: [{ label: hostile, role: "implementer", cli: "codex", model: "gpt-5", effort: "CLI default", branch: "team/n1/x", state: "in review", online: true }], more: 2, reviews: [{ member: hostile, waiting: ["rev"] }] }],
      more: 1,
    },
  };
  const calls = [];
  const fetch = async (url, o) => {
    const key = `${o.method} ${url.replace(/^api\//, "")}`;
    calls.push(key);
    return { status: 200, json: async () => answers[key] };
  };
  const win = { location: { hash: fragment("8.0") }, addEventListener: () => {}, TelegramWebviewProxy: { postEvent: () => {} } };
  win.parent = win;
  win.window = win;
  const ctx = { window: win, document: dom.document, fetch, crypto: globalThis.crypto, btoa, setTimeout: (fn) => fn(), URLSearchParams, JSON, Object, Map, Number, String, Array, Uint8Array };
  vm.runInNewContext(read("tg.js"), ctx);
  vm.runInNewContext(read("app.js"), ctx);
  const settle = () => new Promise((r) => setTimeout(r, 20));
  await settle();
  dom.app.all().find((e) => e.textContent === "Teams").fire("click");
  await settle();
  assert.ok(calls.includes("GET teams"));
  const texts = dom.app.text();
  for (const line of [`Team n1 · led by ${hostile} (lead)`, "partial · on mbp", hostile, "implementer · codex · model gpt-5, effort CLI default (at launch)", "in review · team/n1/x · 🟢 online", "2 more not shown", `🔎 Review of ${hostile}'s work: waiting for rev`, "1 more team not shown.", "Read-only. The teams report this themselves."]) assert.ok(texts.includes(line), line);
  const screen = dom.app.all().filter((e) => e.tag !== "nav" && !(e.className ?? "").startsWith("tab"));
  assert.ok(!screen.some((e) => e.tag === "img"), "no element from a name");
  assert.ok(!screen.some((e) => e.tag === "button" || Object.keys(e.listeners).length), "nothing to tap outside the tabs");
});
