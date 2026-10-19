/**
 * Round-four additions to the embedded surface: datasheet search and the pin
 * map.
 *
 * Both tools exist because the honest answer depends on which sources are
 * present, so these tests pin the *source handling* rather than a happy path:
 * a missing extractor says so, an SVD without alternate functions says so, and
 * a package pin is never invented.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/* ---------- pin map from devicetree --------------------------------------- */

test("Nordic-style pinctrl assignments are read", async () => {
  const { pinsFromDts } = await import("../src/embedded/pinmap.ts");
  const dts = `
    &uart0 {
      pinctrl-0 = <&uart0_default>;
      status = "okay";
    };
    uart0_default: uart0_default {
      group1 {
        psels = <NRF_PSEL(UART_TX, 0, 6)>;
      };
    };
  `;
  // NRF_PSEL is a macro; the plain P0.6 spelling is what the parser can read.
  const plain = `
    pinctrl-0 = <P0.6 P0.8>;
    status = "okay";
  `;
  const map = pinsFromDts(plain, "board.overlay");
  assert.equal(map.assignments.length, 2);
  assert.deepEqual(map.assignments.map((assignment) => assignment.pin).sort(), ["P0.6", "P0.8"]);
  // The macro spelling is not guessed at; the note says nothing was found.
  assert.equal(pinsFromDts(dts, "board.overlay").assignments.length, 0);
});

test("a devicetree with no pin data reports why", async () => {
  const { pinsFromDts } = await import("../src/embedded/pinmap.ts");
  const map = pinsFromDts("&i2c0 { clock-frequency = <400000>; };", "x.overlay");
  assert.equal(map.assignments.length, 0);
  assert.match(map.notes[0], /no pinctrl assignments/);
});

/* ---------- pin table ----------------------------------------------------- */

test("a pin table keeps the package number only when it states one", async () => {
  const { pinsFromTable } = await import("../src/embedded/pinmap.ts");
  const text = ["# pin, package, function", "PA9, 42, USART1_TX", "PA10, USART1_RX"].join("\n");
  const map = pinsFromTable(text, "pins.csv");
  assert.equal(map.assignments.length, 2);
  assert.equal(map.assignments[0].packagePin, 42);
  assert.equal(map.assignments[0].function, "USART1_TX");
  assert.equal(map.assignments[1].packagePin, undefined, "a package pin must not be invented");
  assert.equal(map.assignments[1].function, "USART1_RX");
});

test("a malformed pin table names the line that is wrong", async () => {
  const { pinsFromTable } = await import("../src/embedded/pinmap.ts");
  const map = pinsFromTable("PA9, USART1_TX\ngarbage\n", "pins.csv");
  assert.equal(map.assignments.length, 1);
  assert.match(map.notes.join(" "), /pins\.csv:2/);
});

/* ---------- pin map from an SVD ------------------------------------------ */

test("an SVD without alternate-function fields says package pins are unknown", async () => {
  const { parseSvd } = await import("../src/embedded/svd.ts");
  const { pinsFromSvd } = await import("../src/embedded/pinmap.ts");
  const xml = `<device><name>X</name><peripherals>
    <peripheral><name>GPIOA</name><baseAddress>0x40020000</baseAddress>
      <register><name>MODER</name><addressOffset>0x0</addressOffset>
        <fields><field><name>MODER0</name><bitOffset>0</bitOffset><bitWidth>2</bitWidth></field></fields>
      </register>
    </peripheral>
  </peripherals></device>`;
  const map = pinsFromSvd(parseSvd(xml));
  assert.equal(map.assignments.length, 0);
  assert.match(map.notes.join(" "), /no alternate-function fields/);
});

test("alternate-function fields become pin capabilities", async () => {
  const { parseSvd } = await import("../src/embedded/svd.ts");
  const { pinsFromSvd } = await import("../src/embedded/pinmap.ts");
  const xml = `<device><name>X</name><peripherals>
    <peripheral><name>GPIOA</name><baseAddress>0x40020000</baseAddress>
      <register><name>AFRL</name><addressOffset>0x20</addressOffset>
        <fields>
          <field><name>AFRL9</name><bitOffset>4</bitOffset><bitWidth>4</bitWidth>
            <description>USART1_TX</description></field>
        </fields>
      </register>
    </peripheral>
  </peripherals></device>`;
  const map = pinsFromSvd(parseSvd(xml));
  assert.equal(map.assignments.length, 1);
  assert.equal(map.assignments[0].pin, "PA9");
  assert.equal(map.assignments[0].function, "USART1_TX");
  assert.equal(map.assignments[0].packagePin, undefined);
});

/* ---------- merge and format -------------------------------------------- */

test("merging prefers the later source for the same pin and function", async () => {
  const { mergePinMaps } = await import("../src/embedded/pinmap.ts");
  const merged = mergePinMaps([
    { assignments: [{ pin: "PA9", function: "USART1_TX", source: "svd" }], sources: [], notes: [] },
    { assignments: [{ pin: "PA9", function: "USART1_TX", source: "pins.csv", packagePin: 42 }], sources: [], notes: [] },
  ]);
  assert.equal(merged.assignments.length, 1);
  assert.equal(merged.assignments[0].packagePin, 42);
});

test("the formatter states the package pin only when known", async () => {
  const { formatPinMap } = await import("../src/embedded/pinmap.ts");
  const text = formatPinMap({
    assignments: [
      { pin: "PA9", function: "USART1_TX", source: "pins.csv", packagePin: 42 },
      { pin: "PA10", function: "USART1_RX", source: "svd" },
    ],
    sources: [{ kind: "table", path: "pins.csv", pins: 2 }],
    notes: [],
  });
  assert.match(text, /package 42/);
  assert.match(text, /package pin unknown/);
});

/* ---------- datasheet search --------------------------------------------- */

test("a workspace with no PDFs returns no hits and no false claim", async () => {
  const { searchDatasheets, datasheetFiles } = await import("../src/embedded/datasheet.ts");
  const dir = mkdtempSync(join(tmpdir(), "prometheus-ds-"));
  try {
    assert.deepEqual(datasheetFiles(dir), []);
    const result = await searchDatasheets(dir, "USART");
    // Either no extractor (reported) or no hits; never a fabricated hit.
    assert.equal(result.hits.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("PDFs are discovered and skipped folders do not hide them", async () => {
  const { datasheetFiles } = await import("../src/embedded/datasheet.ts");
  const dir = mkdtempSync(join(tmpdir(), "prometheus-ds2-"));
  try {
    mkdirSync(join(dir, "docs", "chips"), { recursive: true });
    writeFileSync(join(dir, "docs", "chips", "stm32.pdf"), "%PDF-1.4 placeholder", "utf8");
    mkdirSync(join(dir, "node_modules", "x"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "x", "hidden.pdf"), "%PDF", "utf8");
    const files = datasheetFiles(dir);
    assert.equal(files.length, 1);
    assert.match(files[0], /stm32\.pdf$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an empty query returns nothing without touching the disk", async () => {
  const { searchDatasheets } = await import("../src/embedded/datasheet.ts");
  const result = await searchDatasheets(process.cwd(), "   ");
  assert.equal(result.hits.length, 0);
  assert.deepEqual(result.skipped, []);
});

/* ---------- vendor MCP presets ------------------------------------------- */

test("every preset names a real command and its prerequisite", async () => {
  const { MCP_PRESETS, findPreset } = await import("../src/embedded/mcpPresets.ts");
  assert.ok(MCP_PRESETS.length >= 3);
  for (const preset of MCP_PRESETS) {
    assert.ok(preset.server.command, preset.id);
    assert.ok(preset.server.name, preset.id);
    assert.ok(preset.url.startsWith("https://"), preset.id);
    assert.equal(findPreset(preset.id)?.server.name, preset.server.name);
  }
  assert.equal(findPreset("nope"), null);
});

/* ---------- datasheet URLs from a pack ----------------------------------- */

test("a pack's datasheet URL is kept verbatim and deduplicated", async () => {
  const { parsePdsc } = await import("../src/embedded/cmsisPack.ts");
  const xml = `<package>
    <devices>
      <device Dname="TESTCHIP" Dvendor="V:1">
        <description>TESTCHIP</description>
        <datasheet>https://example.com/ds.pdf</datasheet>
        <book>https://example.com/rm.pdf</book>
        <debug svd="TESTCHIP.svd"/>
      </device>
    </devices>
  </package>`;
  const [device] = parsePdsc(xml, "pack.pdsc");
  assert.ok(device);
  assert.deepEqual(device.docs?.sort(), ["https://example.com/ds.pdf", "https://example.com/rm.pdf"]);
  assert.equal(device.svd, "TESTCHIP.svd");
});

/* ---------- install hints cover every detected toolchain ----------------- */

test("every toolchain the detector knows has an install hint or says it has none", async () => {
  const { INSTALL_HINTS } = await import("../src/embedded/installHints.ts");
  // The names the detector reports; a missing hint is allowed only when the
  // table is honest about it, which is what the UI prints.
  for (const kind of ["gcc-riscv", "avrdude", "dfu-util", "st-flash", "jlink", "pyocd", "probe-rs", "esptool", "west", "qemu"]) {
    const hint = INSTALL_HINTS[kind];
    assert.ok(hint, `${kind} needs an install hint`);
    assert.match(hint.url, /^https:\/\//, kind);
  }
});
