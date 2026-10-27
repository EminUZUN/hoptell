import { test } from "node:test";
import assert from "node:assert/strict";
import { NOTICE } from "../lib/notices.js";
import { MIN_VISIBLE_NOTICE, draftHolds, draftState, promptHolds } from "../lib/tmux.js";

// Codex draws its composer text in the pane width less 3 columns, after a two-column prefix,
// and puts "↑" for hidden rows in the last column. When a row's text fills the text area, the
// "↑" follows the text with no space before it.
test("a capped Codex composer whose top row ends exactly at the wrap edge: the '↑' in the last column is the marker", () => {
  const W = 40;
  const T = W - 3;
  const chunks = NOTICE.match(new RegExp(`.{1,${T}}`, "g"));
  const squashed = (k) => chunks.slice(-k).join("").replace(/\s/g, "").length;
  // The smallest number of visible rows whose top row is a full row ending in a non-space,
  // with enough of the notice visible.
  const k = chunks.findIndex((_, i) => {
    const top = chunks.at(-(i + 1));
    return i + 1 < chunks.length && top.length === T && !/\s$/.test(top) && squashed(i + 1) >= MIN_VISIBLE_NOTICE;
  }) + 1;
  assert.ok(k > 1, "the notice is long enough for this layout");
  const visible = chunks.slice(-k);
  const top = `› ${visible[0]}↑`;
  assert.equal([...top].length, W, "the marker is in the last column, right after the text");
  const rows = ["• output", "", top, ...visible.slice(1).map((r) => `  ${r}`), "", "  GPT default · ~/work", ""];
  const y = 2 + k - 1;
  const x = 2 + visible.at(-1).length;
  assert.equal(promptHolds(rows, x, y, NOTICE, { width: W }), true, "the visible end of the notice, rows hidden above");
  assert.equal(promptHolds(rows, x, y, NOTICE, { width: W, whole: true }), false, "the first row is hidden");
  assert.equal(draftState(rows, y, NOTICE, W), "notice");
  assert.equal(draftHolds(rows, 2, NOTICE, W), true, "cursor moved up to the marker row");
  // Without the pane width the last column is unknown: the row is not read as the notice.
  assert.equal(promptHolds(rows, x, y, NOTICE), false);
  // A "↑" one column short of the edge is inside the text area: typed text, not the marker.
  const short = [...rows];
  short[2] = `› ${visible[0].slice(0, -1)}↑`;
  assert.equal(promptHolds(short, x, y, NOTICE, { width: W }), false);
  assert.equal(draftState(short, y, NOTICE, W), "other");

  // A one-row capped composer: the cursor row is the marker row, the cursor on the "↑" cell.
  const W1 = 80;
  const end = NOTICE.slice(-(W1 - 3));
  assert.ok(!/\s$/.test(end) && end.replace(/\s/g, "").length >= MIN_VISIBLE_NOTICE);
  const one = ["• output", "", `› ${end}↑`, "", "  GPT default · ~/work"];
  assert.equal(promptHolds(one, W1 - 1, 2, NOTICE, { width: W1 }), true);
  assert.equal(promptHolds(one, W1 - 1, 2, NOTICE), false, "unknown width");
});

test("a draft ending in '↑' at the last column is not a marker outside a Codex prompt row", () => {
  const W = 80;
  // Claude Code style (❯, the terminal wraps): a user's draft of the notice's end plus a typed "↑"
  // that lands in the last column.
  const text = NOTICE.slice(-(W - 3));
  const row = `❯\u00a0${text}↑`;
  assert.equal([...row].length, W);
  const rows = ["─".repeat(W), row, "─".repeat(W)];
  for (const x of [W - 1, W]) assert.equal(promptHolds(rows, x, 1, NOTICE, { width: W }), false, `cursor at ${x}`);
  assert.equal(draftState(rows, 1, NOTICE, W), "other");
  // A Codex continuation row (no prompt glyph) is not a marker row either.
  const cont = ["", `  ${NOTICE.slice(-(W - 3))}↑`, ""];
  assert.equal(promptHolds(cont, W - 1, 1, NOTICE, { width: W }), false);
});
