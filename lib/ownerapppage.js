// The app's page files (design 7.4, section 6): plain HTML, CSS and JavaScript from lib/miniapp/,
// no build step. At the bridge's start they are read once into a fixed table: each script and
// stylesheet under a name that carries the first 16 hex characters of its sha256, and index.html
// rendered with those names and their SRI hashes. Only the table's paths are served; any other
// path is 404. The favicon is a data: URI in index.html (the CSP allows img-src data:), so the
// tunnel carries no binary file.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ICON_FILES } from "./icons.js";

export const PAGE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "miniapp");
const ASSETS = [
  ["app.css", "text/css"],
  ["tg.js", "text/javascript"],
  ["app.js", "text/javascript"],
];

/** The page table: Map(path -> {body, mime}); "" is index.html. Throws when a file is missing or index.html names an unknown file. */
export function buildPage(dir = PAGE_DIR) {
  const table = new Map();
  const names = { favicon: `data:image/png;base64,${ICON_FILES["favicon.png"].toString("base64")}` };
  for (const [file, mime] of ASSETS) {
    const body = fs.readFileSync(path.join(dir, file), "utf8");
    const sha = crypto.createHash("sha256").update(body, "utf8");
    const digest = sha.copy().digest();
    const [base, ext] = file.split(".");
    const name = `${base}.${digest.toString("hex").slice(0, 16)}.${ext}`;
    names[file] = name;
    names[`${file}:sri`] = `sha256-${digest.toString("base64")}`;
    table.set(name, { body, mime });
  }
  const index = fs.readFileSync(path.join(dir, "index.html"), "utf8").replace(/\{\{([a-z.]+(?::sri)?)\}\}/g, (m, k) => {
    if (!Object.hasOwn(names, k)) throw new Error(`index.html names an unknown file: ${k}`);
    return names[k];
  });
  table.set("", { body: index, mime: "text/html" });
  return table;
}
