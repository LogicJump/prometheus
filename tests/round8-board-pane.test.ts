/**
 * The Board pane states one target, and it is the one the tools use.
 *
 * The pane had two rows — "attached chip" and "target" — and a stored
 * `stm32f103rc` next to a measured `STM32F42x/43x` read as a conflict the user
 * was asked to settle. There was never a conflict: the chip that answered the
 * probe *is* the target, and the saved name was a memory of the previous board.
 *
 * These assertions are on the shipped files. The structure is what made the
 * pane confusing, and a structural change is what keeps it from coming back.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync("desktop/renderer/app.js", "utf8");
const html = readFileSync("desktop/renderer/index.html", "utf8");

/** The body of `renderBoard`, which is the pane. */
function renderBoardBody(): string {
  const start = app.indexOf("function renderBoard()");
  assert.ok(start > -1, "renderBoard must exist");
  const end = app.indexOf("\n/** Whether the baud rate shown", start);
  return end > start ? app.slice(start, end) : app.slice(start, start + 6000);
}

test("the pane has one target row, not a chip row beside a target row", () => {
  const body = renderBoardBody();
  // The old structure pushed a `boardAttached` row and then a `boardTarget`
  // row. The family is evidence for the target now, not a peer of it.
  assert.ok(!body.includes("t.boardAttached"), "the attached chip is not a separate row");
  const targetRows = body.match(/t\.boardTarget\b/g) ?? [];
  assert.equal(targetRows.length, 1, "exactly one target row");
});

test("the pane never shows a stored target next to the measured chip", () => {
  const body = renderBoardBody();
  // A mismatch verdict was the mechanism that produced the two-row conflict.
  assert.ok(!body.includes("mismatch"), "no mismatch adjudication in the pane");
  assert.ok(!body.includes("boardTargetMismatch"), "no mismatch copy in the pane");
});

test("an unread chip yields no target rather than the saved one", () => {
  // `targetSource: "unlisted"` means the part answered and no tool names it.
  // Falling back to the stored name there is the stale-value bug in new paint.
  const body = renderBoardBody();
  const unlisted = body.slice(body.indexOf('source === "unlisted"'), body.indexOf('source === "manual"'));
  assert.ok(unlisted.length > 0);
  assert.ok(!unlisted.includes("effective.target"), "no stored target in the unlisted branch");
});

test("the pane does not list every installed toolchain", () => {
  const body = renderBoardBody();
  // The machine section is a count, not an inventory; the inventory is in
  // Settings and in `embed_targets`.
  assert.ok(!/for \(const tool of board\.tools/.test(body), "the toolchain list is not rendered here");
});

test("a target table load is not behind a button", () => {
  assert.ok(!html.includes('id="board-load-targets"'), "the table loads with the scan");
  assert.ok(!app.includes('"board-load-targets"'));
});

test("the composer chip reads the effective board, not the saved selection", () => {
  const start = app.indexOf("function renderBoardChip()");
  const body = app.slice(start, start + 1200);
  assert.match(body, /state\.boardState\?\.effective/, "a saved target with a swapped board is the bug being fixed");
});
