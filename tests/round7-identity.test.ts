/**
 * Identifying the attached chip, and what the Board pane does with it.
 *
 * The bug this covers: the pane showed `stm32f103rc` for a board that was an
 * F429. Nothing was broken in the rendering — the value was read from the
 * config file, which still held whatever had been picked the last time an F103
 * was on the desk. A target that exists in the table says the *name* is valid,
 * not that the part is attached, and the pane never distinguished the two.
 *
 * The identification itself is checked against real captured tool output: the
 * lines below are copied from pyOCD 0.45 against an STM32F429IGT6, and the
 * parse has to ignore the ASCII column pyOCD prints beside the value.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  familyStems,
  ST_STM32_IDENTITY,
  parsePyocdRead32,
  flashCodeFor,
  formatIdentity,
  suggestTargets,
  type Identity,
} from "../src/embedded/identity.ts";
import { boardTargetStatus, targetMatchesIdentity } from "../src/embedded/board.ts";
import type { Target } from "../src/embedded/probe.ts";

/** What pyOCD commander actually printed for an STM32F429IGT6. */
const REAL_PYOCD_IDCODE = "e0042000:  20036419                               | .d.|";
const REAL_PYOCD_FLASHSIZE = "1fff7a22:  0400                                       |..|";

function target(name: string): Target {
  return { name, vendor: "STMicroelectronics", source: "pyocd" };
}

test("a pyOCD read32 line parses despite the ASCII column", () => {
  assert.equal(parsePyocdRead32(REAL_PYOCD_IDCODE, 0xe0042000), 0x20036419);
  assert.equal(parsePyocdRead32(REAL_PYOCD_FLASHSIZE, 0x1fff7a22), 0x0400);
});

test("a read32 line for a different address is not accepted", () => {
  // Reading the wrong register and taking its value would map the part to a
  // device id that happens to be a valid number.
  assert.equal(parsePyocdRead32(REAL_PYOCD_IDCODE, 0x1fff7a22), undefined);
});

test("pyOCD log prefixes do not defeat the address match", () => {
  // pyOCD prints a two-byte log level before some lines.
  assert.equal(parsePyocdRead32("0001234 I e0042000:  20036419  | .d.|", 0xe0042000), 0x20036419);
});

test("the STM32 device id is the low 12 bits of the identity word", () => {
  assert.equal(ST_STM32_IDENTITY.deviceId(0x20036419), 0x419);
});

test("an F429 identity names the family, not a made-up part number", () => {
  // 0x419 covers F42x and F43x. Calling it "STM32F429" would be wrong for
  // every F427, and that mistake is what gets flashed.
  assert.equal(ST_STM32_IDENTITY.family(0x419), "STM32F42x/43x");
});

test("the flash size register reports KiB in its low 16 bits", () => {
  assert.equal(ST_STM32_IDENTITY.flashSize?.kib(0x0400), 1024);
});

test("a stored F103 target does not match an attached F429", () => {
  const identity: Identity = { probe: "pyocd", vendor: "STMicroelectronics", word: 0x20036419, deviceId: 0x419, family: "STM32F42x/43x", flashKib: 1024 };
  assert.equal(targetMatchesIdentity("stm32f103rc", identity), false);
});

test("a target in the attached part's family is not a conflict", () => {
  const identity: Identity = { probe: "pyocd", vendor: "STMicroelectronics", word: 0x20036419, deviceId: 0x419, family: "STM32F42x/43x", flashKib: 1024 };
  // Two tools spell the same silicon differently; neither is a mismatch.
  assert.equal(targetMatchesIdentity("stm32f429xg", identity), true);
  assert.equal(targetMatchesIdentity("stm32f439xg", identity), true);
  // A whole-family entry states no size, so it does not disagree about one.
  assert.equal(targetMatchesIdentity("stm32f42x", identity), true);
});

test("a target whose flash code disagrees with the part is a conflict", () => {
  // `xi` is 2 MiB and the part reports 1 MiB. Flashing that image writes
  // addresses the part does not have.
  const identity: Identity = { probe: "pyocd", vendor: "STMicroelectronics", word: 0x20036419, deviceId: 0x419, family: "STM32F42x/43x", flashKib: 1024 };
  assert.equal(targetMatchesIdentity("stm32f427zi", identity), false);
});

test("without an identification there is no verdict, not a red light", () => {
  // "Cannot tell" is different from "no": a pane that shows a conflict before
  // reading the chip is worse than one that waits.
  assert.equal(targetMatchesIdentity("stm32f103rc", null), undefined);
  assert.equal(targetMatchesIdentity(undefined, { probe: "pyocd", vendor: "ST", word: 0, deviceId: 0x419 }), undefined);
});

test("the family stem drops the family's own package placeholder", () => {
  assert.deepEqual(familyStems("STM32F42x/43x"), ["stm32f42", "stm32f43"]);
  assert.deepEqual(familyStems("STM32F103xx"), ["stm32f103"]);
});

test("status marks a valid target for a part that is not attached", () => {
  const table = [target("stm32f103rc"), target("stm32f429xg")];
  const identity: Identity = { probe: "pyocd", vendor: "STMicroelectronics", word: 0x20036419, deviceId: 0x419, family: "STM32F42x/43x", flashKib: 1024 };
  const status = boardTargetStatus("stm32f103rc", table, identity);
  // Still an exact entry — the name is real, and saying otherwise would be a
  // different lie. The mismatch rides alongside so the pane can say both.
  assert.equal(status.kind, "exact");
  assert.deepEqual(status.mismatch, { selected: "stm32f103rc", attached: "STM32F42x/43x" });
});

test("status is unchanged when the chip agrees or was not read", () => {
  const table = [target("stm32f429xg")];
  const attached: Identity = { probe: "pyocd", vendor: "STMicroelectronics", word: 0x20036419, deviceId: 0x419, family: "STM32F42x/43x", flashKib: 1024 };
  assert.equal(boardTargetStatus("stm32f429xg", table, attached).mismatch, undefined);
  assert.equal(boardTargetStatus("stm32f429xg", table, null).mismatch, undefined);
});

test("the flash size picks the matching target code", () => {
  // stm32f429xg and stm32f429xi differ only in flash; flashing the wrong one
  // truncates the image silently.
  assert.equal(flashCodeFor(1024), "g");
  assert.equal(flashCodeFor(2048), "i");
  assert.equal(flashCodeFor(512), "e");
  assert.equal(flashCodeFor(256), "c");
});

test("suggestions narrow the table to the attached family and flash size", () => {
  const identity: Identity = { probe: "pyocd", vendor: "STMicroelectronics", word: 0x20036419, deviceId: 0x419, family: "STM32F42x/43x", flashKib: 1024 };
  const table = [
    target("stm32f429xg"),
    target("stm32f429xi"),
    target("stm32f439xg"),
    target("stm32f103rc"),
    target("stm32f407vg"),
  ];
  const names = suggestTargets(identity, table);
  assert.deepEqual(names, ["stm32f429xg", "stm32f439xg"]);
  assert.ok(!names.includes("stm32f429xi"), "the 2 MiB target does not match a 1 MiB part");
});

test("an unknown family suggests nothing rather than everything", () => {
  const identity: Identity = { probe: "pyocd", vendor: "STMicroelectronics", word: 0x20036000, deviceId: 0x600 };
  assert.deepEqual(suggestTargets(identity, [target("stm32f429xg")]), []);
});

test("a failed identification reports what was tried, not a fabricated part", () => {
  const text = formatIdentity({ ok: false, failure: { attempts: [{ probe: "pyocd", reason: "no probe detected" }] } });
  assert.match(text, /Could not identify/);
  assert.match(text, /pyocd: no probe detected/);
  assert.ok(!/STM32/.test(text), "a failure must not name a chip");
});

test("a successful identification states the family, id, and flash", () => {
  const text = formatIdentity({
    ok: true,
    identity: { probe: "pyocd", vendor: "STMicroelectronics", word: 0x20036419, deviceId: 0x419, family: "STM32F42x/43x", flashKib: 1024 },
  });
  assert.match(text, /STM32F42x\/43x/);
  assert.match(text, /0x419/);
  assert.match(text, /1024 KiB/);
});
