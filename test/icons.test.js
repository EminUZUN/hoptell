// The hoptell icon at runtime (lib/icons.js): the shipped PNGs, the MCP serverInfo icons, the
// favicon routes of the loopback UIs, the Mini App's data: favicon, and the npm package contents.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ICON_FILES, ICON_PATH, MCP_ICONS, iconFor, iconLinks } from "../lib/icons.js";
import { SECURITY_HEADERS } from "../lib/loopbackui.js";
import { startAdminUi } from "../lib/adminui.js";
import { startOwnerUi } from "../lib/ownerui.js";
import { settingsContext } from "../lib/decisions.js";
import { buildPage } from "../lib/ownerapppage.js";
import { ROOT } from "../lib/config.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** {width, height, colorType} from a PNG's IHDR. */
function png(buf) {
  assert.ok(buf.subarray(0, 8).equals(PNG), "PNG signature");
  assert.equal(buf.toString("latin1", 12, 16), "IHDR");
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), colorType: buf[25] };
}
const tmp = (t) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "hoptell-icons-"));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};
function get(port, p, method = "GET") {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port, path: p, method, headers: { host: `127.0.0.1:${port}` } }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    r.on("error", reject);
    r.end();
  });
}

test("icon files: a 32 px favicon and an opaque 180 px Apple touch icon, both small PNGs", () => {
  assert.deepEqual(png(ICON_FILES["favicon.png"]), { width: 32, height: 32, colorType: 2 });
  assert.deepEqual(png(ICON_FILES["apple-touch-icon.png"]), { width: 180, height: 180, colorType: 2 }, "RGB without alpha: opaque");
  for (const b of Object.values(ICON_FILES)) assert.ok(b.length < 16 * 1024);
  assert.ok(path.isAbsolute(ICON_PATH) && fs.existsSync(ICON_PATH), "notify-send's icon is an absolute path to a shipped file");
});

test("serverInfo icons: one 64 px PNG as a small data: URI, in the 2025-11-25 Icon shape", () => {
  assert.equal(MCP_ICONS.length, 1);
  const [i] = MCP_ICONS;
  assert.deepEqual(Object.keys(i).sort(), ["mimeType", "sizes", "src"]);
  assert.equal(i.mimeType, "image/png");
  assert.deepEqual(i.sizes, ["64x64"]);
  const m = /^data:image\/png;base64,([A-Za-z0-9+/]+=*)$/.exec(i.src);
  assert.ok(m, "a base64 PNG data: URI");
  assert.ok(i.src.length < 4096, "sent on every initialize: kept under 4 KB");
  assert.deepEqual(png(Buffer.from(m[1], "base64")), { width: 64, height: 64, colorType: 2 });
});

test("iconFor: only the two icon names under the prefix, cached for a day", () => {
  assert.equal(iconFor("/favicon.png").headers["Content-Type"], "image/png");
  assert.equal(iconFor("/owner/apple-touch-icon.png", "/owner").headers["Cache-Control"], "public, max-age=86400");
  for (const p of ["/favicon.ico", "/owner/favicon.png", "/favicon.png/", "/icons/favicon-32.png", "/../icons/favicon-32.png"]) assert.equal(iconFor(p), null, p);
  assert.equal(iconFor("/favicon.png", "/owner"), null);
  assert.match(iconLinks("/owner"), /href="\/owner\/favicon\.png".*href="\/owner\/apple-touch-icon\.png"/);
});

/** The icon routes of a loopback UI: served before any session, with the UI's own CSP. */
async function checkUi(port, { head }) {
  for (const [p, size] of [["/favicon.png", 32], ["/apple-touch-icon.png", 180]]) {
    const r = await get(port, p);
    assert.equal(r.status, 200, p);
    assert.equal(r.headers["content-type"], "image/png");
    assert.equal(r.headers["content-security-policy"], SECURITY_HEADERS["Content-Security-Policy"], "the CSP is unchanged (img-src 'self')");
    assert.equal(r.headers["x-content-type-options"], "nosniff");
    assert.equal(r.headers["cache-control"], "public, max-age=86400");
    assert.equal(png(r.body).width, size);
    if (head) {
      const h = await get(port, p, "HEAD");
      assert.equal(h.status, 200);
      assert.equal(h.body.length, 0);
    }
  }
  const page = await get(port, "/");
  assert.equal(page.status, 403, "no session");
  assert.equal(page.headers["cache-control"], "no-store", "pages stay no-store");
  assert.ok(page.body.toString().includes(iconLinks()), "the page links its icons");
  assert.equal((await get(port, "/favicon.ico")).status, 403, "no other file is served before a session");
}

test("relay admin UI: favicon and Apple touch icon routes, GET and HEAD", async (t) => {
  const ui = await startAdminUi({ stateDir: tmp(t) });
  t.after(() => ui.close());
  await checkUi(ui.port, { head: true });
});

test("owner UI: favicon and Apple touch icon routes", async (t) => {
  const home = tmp(t);
  const ui = await startOwnerUi({ home, ctx: settingsContext({ env: {}, fromFile: [], envFile: path.join(home, "s.env"), relaysFile: path.join(home, "none.json") }) });
  t.after(() => ui.close());
  await checkUi(ui.port, { head: false });
});

test("Mini App: index.html carries the 32 px favicon as a data: URI (the tunnel serves no binary file)", () => {
  const index = buildPage().get("").body;
  const m = /<link rel="icon" type="image\/png" sizes="32x32" href="data:image\/png;base64,([A-Za-z0-9+/]+=*)" \/>/.exec(index);
  assert.ok(m);
  assert.ok(Buffer.from(m[1], "base64").equals(ICON_FILES["favicon.png"]));
  assert.doesNotMatch(index, /\{\{|\}\}/, "every template name was filled");
});

test("npm package: ships lib/icons.js and the icon files it reads", async () => {
  const { stdout } = await promisify(execFile)("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: ROOT, maxBuffer: 16 * 1024 * 1024 });
  const files = new Set(JSON.parse(stdout)[0].files.map((f) => f.path));
  for (const f of ["lib/icons.js", "lib/icons/favicon-32.png", "lib/icons/icon-64.png", "lib/icons/apple-touch-icon.png"]) assert.ok(files.has(f), f);
});
