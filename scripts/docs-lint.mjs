#!/usr/bin/env node
// The release gate's docs lint (design 3.5, "Tests"): the phrase "cannot read" appears in the
// public docs (README, release notes, listings, policies) only inside a section about the reviewed
// build (a Markdown heading that says "reviewed build"). Until the gate passes, no doc claims that
// admins or relays cannot read messages. A lint, not evidence: it neither proves a claim accurate
// nor finds equivalent wording; the claims list the reviewer receives is the check for that.
// Run by npm test (test/release-gate.test.js); `node scripts/docs-lint.mjs` prints the hits.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { REPO } from "./gate-lib.mjs";

const PHRASE = /cannot\s+read/gi;
const ALLOWED_HEADING = /reviewed build/i;

/** The public docs: Markdown at the top and under examples/, and the listings (server.json, .claude-plugin/). */
export function publicDocs(repo = REPO) {
  const out = [];
  const add = (dir, keep) => {
    let names = [];
    try {
      names = fs.readdirSync(path.join(repo, dir)).sort();
    } catch {}
    for (const n of names) if (keep(n) && fs.statSync(path.join(repo, dir, n)).isFile()) out.push(path.join(dir, n));
  };
  add("", (n) => n.endsWith(".md") || n === "server.json");
  add("examples", () => true);
  add(".claude-plugin", (n) => n.endsWith(".json"));
  return out;
}

/** The hits of the phrase outside an allowed section in one document: [{line, text}]. */
export function lintText(text, { markdown = true } = {}) {
  const lines = String(text).split("\n");
  const hits = [];
  let allowedLevel = 0; // the heading level of the allowed section we are in, 0 when none
  let fence = false;
  // Line starts, to place a match that spans lines.
  const sectionOf = [];
  for (let i = 0; i < lines.length; i++) {
    if (markdown && /^\s*(```|~~~)/.test(lines[i])) fence = !fence;
    const h = markdown && !fence ? /^(#{1,6})\s+(.*)$/.exec(lines[i]) : null;
    if (h) {
      const level = h[1].length;
      if (allowedLevel && level <= allowedLevel) allowedLevel = 0;
      if (!allowedLevel && ALLOWED_HEADING.test(h[2])) allowedLevel = level;
    }
    sectionOf.push(Boolean(allowedLevel));
  }
  const starts = [];
  let o = 0;
  for (const l of lines) {
    starts.push(o);
    o += l.length + 1;
  }
  for (const m of String(text).matchAll(PHRASE)) {
    let line = starts.findLastIndex((s) => s <= m.index);
    if (!sectionOf[line]) hits.push({ line: line + 1, text: lines[line].trim() });
  }
  return hits;
}

/** Every hit in the repository's public docs: [{file, line, text}]. */
export function lintDocs(repo = REPO) {
  return publicDocs(repo).flatMap((f) => lintText(fs.readFileSync(path.join(repo, f), "utf8"), { markdown: f.endsWith(".md") }).map((h) => ({ file: f, ...h })));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const hits = lintDocs();
  for (const h of hits) console.error(`${h.file}:${h.line}: "cannot read" outside a reviewed-build section: ${h.text}`);
  if (hits.length) process.exit(1);
  console.log("docs lint: no \"cannot read\" claim outside a reviewed-build section");
}
