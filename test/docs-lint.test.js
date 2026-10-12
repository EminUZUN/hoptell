// The release gate's docs lint (design 3.5, "Tests"), run with the suite: the phrase "cannot read"
// appears in the public docs only in a reviewed-build section.
import { test } from "node:test";
import assert from "node:assert/strict";
import { lintDocs, lintText } from "../scripts/docs-lint.mjs";

test("docs lint: no \"cannot read\" in the public docs outside a reviewed-build section", () => {
  assert.deepEqual(lintDocs(), []);
  const doc = [
    "# hoptell",
    "Admins cannot read nothing.", // flagged
    "## In a reviewed build",
    "The relay cannot read message content of verified contacts.", // allowed
    "### Limits",
    "Still cannot read here.", // allowed: a subsection
    "```",
    "# not a heading in a fence",
    "```",
    "Nor cannot read here.", // allowed
    "## Other",
    "The relay cannot",
    "read it.", // flagged: across a line break
    "CANNOT READ",
  ].join("\n");
  assert.deepEqual(lintText(doc).map((h) => h.line), [2, 12, 14]);
  assert.deepEqual(lintText('{"description": "the relay cannot read"}', { markdown: false }).map((h) => h.line), [1]);
  assert.deepEqual(lintText("# Before the gate\n## Reviewed build\nx cannot read\n# Next\ncannot read").map((h) => h.line), [5]);
});
