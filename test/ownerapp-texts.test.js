// Every text the app shows (design 7.4, sections 7 and 8; tests of section 11, "Display"): the
// page's own strings and every text the API answers pass the bot's text scan (no wire-name prefix,
// relay alias, reference, long hex run, UUID or internal word); colliding names show wire names.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { PAGE_DIR } from "../lib/ownerapppage.js";
import { agent, appClient, appSet, bridgeOn, fakeTelegram, newKey, newOp, ownerRelay, paired, setPeople, textProblems, tmpHome, until } from "./owner-helpers.js";

test("display: the page's own strings pass the scan", () => {
  const src = fs.readFileSync(path.join(PAGE_DIR, "app.js"), "utf8");
  const block = src.slice(src.indexOf("const T = Object.freeze({"), src.indexOf("});", src.indexOf("const T = Object.freeze({")));
  const strings = [...block.matchAll(/"((?:[^"\\]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g)].map((m) => (m[1] ?? m[2]).replace(/\$\{[^}]*\}/g, "x"));
  assert.ok(strings.length > 40, `${strings.length} strings`);
  for (const s of strings) assert.deepEqual(textProblems(s), [], s);
});

test("display: every text in the API's answers passes the scan; colliding labels follow the display rule", async (t) => {
  const r = await ownerRelay(t, { ownerApp: true });
  const home = tmpHome(t);
  paired(home);
  appSet(home, "on", Date.now() - 120_000);
  await setPeople(home, ["me-alice"], { alias: "Main", alias_host: "old-mac", fav: true });
  await setPeople(home, ["me-bob"], { alias: "Main" });
  const alice = await agent(t, r.url, r.tokens.me, "me-alice");
  await agent(t, r.url, r.tokens.me, "me-bob");
  const tg = fakeTelegram();
  const { bridge } = bridgeOn(t, { home, telegram: tg.client(), url: r.url, token: r.tokens.me, key: newKey() });
  await until(() => bridge.appAvailable(), 4000, "registered");
  const app = appClient(r.http, bridge.state().app.id);
  await app.open();
  await alice.ask("Deploy now?", { choices: ["yes", "no"] });
  await until(() => tg.cards().length, 4000, "card");
  const bodies = [];
  const keep = (x) => (bodies.push(x.body), x);
  const list = keep(await app.get("sessions")).json.sessions;
  const labels = list.map((s) => s.label).sort();
  // Two agents named Main show their full forms (the 7.3 display rule); alice's alias was saved on
  // another computer, so it is marked "?".
  assert.deepEqual(labels, ["Main (alice)?", "Main (bob)"]);
  const h = list[0].h;
  keep(await app.get(`session/${h}`));
  keep(await app.get("questions"));
  keep(await app.post("prefs", { h, op: newOp(), set: { alias: "bob" } }));
  keep(await app.post("draft", { h, op: newOp(), text: "x".repeat(3501) }));
  keep(await app.post("draft", { h: "aaaaaaaaaa", op: newOp(), text: "hi" }));
  keep(await app.post("questions/show", { n: 999, op: newOp() }));
  const texts = [];
  const walk = (v, k = "") => {
    if (typeof v === "string" && ["text", "warning", "age", "last_talked", "asker"].includes(k)) texts.push(v);
    else if (v && typeof v === "object") for (const [kk, vv] of Object.entries(v)) walk(vv, kk);
  };
  for (const b of bodies) walk(JSON.parse(b));
  assert.ok(texts.length >= 4, texts.join(" | "));
  // Labels may be wire names when they collide (the display rule); every other text must scan clean.
  for (const s of texts) assert.deepEqual(textProblems(s), [], s);
});
