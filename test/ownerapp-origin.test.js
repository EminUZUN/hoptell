// The app's public origin (HOPTELL_APP_URL): the button's URL and the API's Origin check use it,
// not the bridge's relay URL, which may be a private ws:// address (design 7.4, section 2).
import { test } from "node:test";
import assert from "node:assert/strict";
import { appOriginFor } from "../lib/ownerapp.js";
import { agent, appClient, appSet, bridgeOn, fakeTelegram, initData, newKey, ownerRelay, paired, tmpHome, until } from "./owner-helpers.js";

test("appOriginFor: an explicit https origin, normalized; anything else is invalid and never falls back", () => {
  const relayUrl = "wss://relay.example.com";
  assert.deepEqual(appOriginFor({ explicit: "https://app.example.net", relayUrl: "ws://10.0.0.9:7777" }), { origin: "https://app.example.net" });
  assert.deepEqual(appOriginFor({ explicit: " https://Hoptell.Example.com:443/ ", relayUrl }), { origin: "https://hoptell.example.com" });
  assert.deepEqual(appOriginFor({ explicit: "https://hoptell.example.com:8443", relayUrl }), { origin: "https://hoptell.example.com:8443" });
  assert.deepEqual(appOriginFor({ explicit: "https://10.0.0.5", relayUrl }), { origin: "https://10.0.0.5" }, "an explicit IP is the operator's choice");
  for (const bad of ["http://hoptell.example.com", "hoptell.example.com", "https://hoptell.example.com/app/", "https://hoptell.example.com/?x=1", "https://hoptell.example.com/#x", "https://u:p@hoptell.example.com", "wss://hoptell.example.com", "https://"]) {
    const o = appOriginFor({ explicit: bad, relayUrl });
    assert.equal(o.origin, null, bad);
    assert.match(o.invalid, /^HOPTELL_APP_URL /, bad);
  }
});

test("appOriginFor: unset (or blank), the relay's host only for a wss:// relay named by a host name", () => {
  for (const explicit of [null, undefined, "", "  "]) assert.deepEqual(appOriginFor({ explicit, relayUrl: "wss://relay.example.com" }), { origin: "https://relay.example.com" });
  assert.deepEqual(appOriginFor({ relayUrl: "wss://relay.example.com:443/x" }), { origin: "https://relay.example.com" });
  assert.deepEqual(appOriginFor({ relayUrl: "wss://relay.example.com:8443" }), { origin: "https://relay.example.com:8443" });
  assert.deepEqual(appOriginFor({ relayUrl: "ws://relay.example.com" }), { origin: null, problem: "not_tls" });
  assert.deepEqual(appOriginFor({ relayUrl: "ws://10.0.0.9:7777" }), { origin: null, problem: "not_tls" });
  for (const ip of ["wss://10.0.0.9:7777", "wss://127.1", "wss://0x7f000001", "wss://[::1]:7777"]) assert.deepEqual(appOriginFor({ relayUrl: ip }), { origin: null, problem: "ip" }, ip);
  assert.deepEqual(appOriginFor({ relayUrl: "" }), { origin: null, problem: "no_relay" });
});

async function setup(t, opts) {
  const r = await ownerRelay(t, { ownerApp: true });
  const home = tmpHome(t);
  paired(home);
  appSet(home, "on", Date.now() - 120_000);
  await agent(t, r.url, r.tokens.me, "me-alice");
  const tg = fakeTelegram();
  const logs = [];
  const { bridge } = bridgeOn(t, { home, telegram: tg.client(), url: r.url, token: r.tokens.me, key: newKey(), log: (...a) => logs.push(a.join(" ")), ...opts });
  return { r, tg, bridge, logs };
}

const appButtons = (msg) => (msg.params.reply_markup?.inline_keyboard ?? []).flat().filter((b) => b.web_app);

test("a private ws:// relay with HOPTELL_APP_URL: the button opens the public origin, and only that Origin may post", async (t) => {
  const s = await setup(t, { appUrl: "https://Hoptell.Example.com/" });
  await until(() => s.bridge.appAvailable(), 4000, "the app registered");
  const id = s.bridge.state().app.id;
  s.tg.say("/app");
  await until(() => s.tg.last(/^Your agents, favourites and questions, in one place:$/), 4000, "/app");
  assert.deepEqual(appButtons(s.tg.last(/^Your agents, favourites and questions, in one place:$/)), [{ text: "📱 Open the app", web_app: { url: `https://hoptell.example.com/app/${id}/` } }]);
  assert.ok(!JSON.stringify(s.tg.sent).includes("127.0.0.1"), "never the relay's own address");
  const app = appClient(s.r.http, id);
  assert.equal((await app.open(initData())).status, 200);
  const post = (origin) => app.post("prefs", { h: "aaaaaaaaaa", op: "x", set: {} }, app.token, { origin });
  assert.notEqual((await post("https://hoptell.example.com")).status, 403);
  const internal = await post(`https://127.0.0.1:${s.r.relay.port}`);
  assert.deepEqual([internal.status, internal.json?.error], [403, "origin"], "the relay's address is not the app's origin");
  assert.equal((await post("https://evil.example")).status, 403);
});

for (const [what, opts, logged] of [
  ["no HOPTELL_APP_URL and a ws:// relay", { appUrl: null }, /the relay URL is ws:\/\/, not wss:\/\//],
  ["an invalid HOPTELL_APP_URL (no fallback to the relay)", { appUrl: "http://hoptell.example.com" }, /HOPTELL_APP_URL must start with https:\/\//],
]) {
  test(`${what}: no app button, /app says how to give it an address, the bridge logs why`, async (t) => {
    const s = await setup(t, opts);
    await until(() => s.bridge.appServed(), 4000, "the app registered");
    assert.equal(s.bridge.appAvailable(), false);
    s.tg.say("/app");
    await until(() => s.tg.last(/^The app is on, but this bot has no usable HTTPS address for it\./), 4000, "the no-address text");
    assert.equal(s.tg.last(/^The app is on, but/).params.text, "The app is on, but this bot has no usable HTTPS address for it. Set HOPTELL_APP_URL in the bot's environment to your hoptell server's public HTTPS address, then restart the bot.");
    s.tg.say("/agents");
    await until(() => s.tg.last(/^Your agents: /), 4000, "/agents");
    assert.ok(!JSON.stringify(s.tg.sent).includes("web_app"), "no app button anywhere");
    assert.ok(s.logs.some((l) => /the app is on, but its public HTTPS address could not be determined/.test(l) && logged.test(l)), s.logs.join("\n"));
    assert.ok(s.bridge.leading(), "the bot itself keeps working");
  });
}
