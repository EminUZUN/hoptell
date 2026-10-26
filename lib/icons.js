// The hoptell icon at runtime: small PNGs made from assets/icon.png and shipped in lib/icons/ (lib/
// is in the npm package and the relay's container image; assets/ is in neither). The web pages
// serve them as their favicon and Apple touch icon, the MCP server names the 64 px one in its
// serverInfo as a data: URI (no network fetch, and a stdio server has no origin of its own), and
// notify-send on Linux shows the 180 px one.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ICON_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "icons");
/** The 180 px icon file, for notification daemons that take an icon path. */
export const ICON_PATH = path.join(ICON_DIR, "apple-touch-icon.png");

const read = (name) => fs.readFileSync(path.join(ICON_DIR, name));
/** The files a page serves, by the name it serves them under. */
export const ICON_FILES = { "favicon.png": read("favicon-32.png"), "apple-touch-icon.png": read("apple-touch-icon.png") };

/** The MCP `icons` of hoptell's Implementation (serverInfo), per the 2025-11-25 revision. */
export const MCP_ICONS = [{ src: `data:image/png;base64,${read("icon-64.png").toString("base64")}`, mimeType: "image/png", sizes: ["64x64"] }];

/** The <link> tags of a page whose icon routes are under `prefix` (e.g. "" or "/owner"). */
export const iconLinks = (prefix = "") => `<link rel="icon" type="image/png" sizes="32x32" href="${prefix}/favicon.png"><link rel="apple-touch-icon" sizes="180x180" href="${prefix}/apple-touch-icon.png">`;

/**
 * The icon file a request names under `prefix`, as {body, headers}, or null. The pages are
 * no-store; the icons are public and cached for a day. The caller adds its security headers.
 */
export function iconFor(pathname, prefix = "") {
  if (!pathname.startsWith(`${prefix}/`)) return null;
  const name = pathname.slice(prefix.length + 1);
  if (!Object.hasOwn(ICON_FILES, name)) return null;
  const body = ICON_FILES[name];
  return { body, headers: { "Content-Type": "image/png", "Content-Length": String(body.length), "Cache-Control": "public, max-age=86400" } };
}
