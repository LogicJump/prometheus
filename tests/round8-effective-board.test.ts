/**
 * The board the tools act on is the board the pane shows.
 *
 * The pane used to derive a target from the attached chip and display it, while
 * `embed_flash` read `config.board` — a saved value that would still say
 * `stm32f103rc` after the board was swapped. The pane then announced "this is
 * what gets flashed". Both halves were individually reasonable, and together
 * they were the worst bug in the feature: a confident UI in front of a tool
 * writing to the wrong part.
 *
 * These tests pin the rule: a target derived from the chip outranks the saved
 * selection, and the saved selection survives only where nothing overrides it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { effectiveBoard } from "../src/embedded/board.ts";
import type { Identity } from "../src/embedded/identity.ts";

const F429: Identity = {
  probe: "pyocd",
  vendor: "STMicroelectronics",
  word: 0x20036419,
  deviceId: 0x419,
  family: "STM32F42x/43x",
  flashKib: 1024,
};

test("a target derived from the chip is what the tools get", () => {
  const board = effectiveBoard({ target: "stm32f103rc" }, F429, "stm32f429xg", "chip");
  assert.equal(board.target, "stm32f429xg", "the saved name must not survive a chip reading");
  assert.equal(board.source, "chip");
});

test("the effective board carries the identity, so a tool can say what it read", () => {
  const board = effectiveBoard({}, F429, "stm32f429xg", "chip");
  assert.equal(board.identity?.family, "STM32F42x/43x");
  assert.equal(board.identity?.flashKib, 1024);
});

test("without a chip reading the saved target is used, labelled as manual", () => {
  const board = effectiveBoard({ target: "stm32f103rc" }, null, "stm32f103rc", "manual");
  assert.equal(board.target, "stm32f103rc");
  assert.equal(board.source, "manual");
});

test("a chip that no tool can name yields no target rather than falling back", () => {
  // This is the case that would otherwise resurrect the stale value: the part
  // answered, so the saved name is already known to be about something else.
  const board = effectiveBoard({ target: "stm32f103rc" }, F429, undefined, "unlisted");
  assert.equal(board.target, undefined);
  assert.equal(board.source, "unlisted");
});

test("port and baud reach the tools from the same object", () => {
  const board = effectiveBoard({ port: "COM7", baud: 921600 }, F429, "stm32f429xg", "chip", [{ path: "COM7" }]);
  assert.equal(board.port, "COM7");
  assert.equal(board.baud, 921600);
});

test("an absent port is not invented from the port list", () => {
  // `boardDefaults` fills a port only when exactly one exists; the effective
  // board must not claim a port that was never selected among several.
  const board = effectiveBoard({}, F429, "stm32f429xg", "chip", [{ path: "COM7" }, { path: "COM8" }]);
  assert.equal(board.port, undefined);
});
