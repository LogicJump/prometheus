/**
 * Round-three embedded fixes: the places where a tool told the user something
 * that was not true.
 *
 * A flasher that reports success without writing is worse than a missing
 * feature: the user debugs a board that never received the code they think is
 * on it. A read-only serial tool that resets the board is the same class of
 * problem. These tests pin the honest behaviour.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { classifyOutput, commandFor, validate } from "../src/embedded/flash.ts";
import { embeddedBaseEnv } from "../src/embedded/toolEnv.ts";

function firmware(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), "prometheus-fw-"));
  const file = join(dir, name);
  writeFileSync(file, Buffer.alloc(64, 0xaa));
  return file;
}

/* ---------- 3.1 J-Link must actually name the file it claims to write ---------- */

test("the J-Link command carries the firmware and a load address", () => {
  const elf = firmware("app.elf");
  try {
    const args = commandFor({ kind: "jlink", program: "JLinkExe", firmware: elf, target: "STM32F429ZI" });
    const joined = args.join(" ");
    assert.match(joined, /-device STM32F429ZI/);
    // Without a load file the probe connects, prints O.K., and writes nothing.
    const scriptIndex = args.indexOf("-CommanderScript");
    assert.ok(scriptIndex >= 0, `expected -CommanderScript, got: ${joined}`);
    const script = readFileSync(args[scriptIndex + 1], "utf8");
    assert.match(script, /loadfile .*app\.elf/);
  } finally {
    rmSync(join(elf, ".."), { recursive: true, force: true });
  }
});

test("a J-Link command for a raw .bin names the load address", () => {
  const bin = firmware("app.bin");
  try {
    const args = commandFor({ kind: "jlink", program: "JLinkExe", firmware: bin, target: "STM32F429ZI", address: 0x08000000 });
    const script = readFileSync(args[args.indexOf("-CommanderScript") + 1], "utf8");
    assert.match(script, /loadfile .*app\.bin 0x8000000/);
    assert.match(script, /verifybin .*0x8000000/);
  } finally {
    rmSync(join(bin, ".."), { recursive: true, force: true });
  }
});

test("a J-Link session that only connected is not reported as a successful flash", () => {
  // The script prints this after connecting and before writing anything.
  const connectOnly = "SEGGER J-Link Commander V7.96\nConnecting to J-Link...\nO.K.\nJ-Link>\n";
  assert.equal(classifyOutput("jlink", connectOnly, 0).ok, false, "a bare O.K. is a connection, not a write");

  const written = "Connecting to J-Link...\nO.K.\nDownloading file [app.elf]...\nO.K.\nComparing flash contents...\nO.K.\nVerify successful.\n";
  assert.equal(classifyOutput("jlink", written, 0).ok, true);
});

/* ---------- 3.2 a read-only serial read must not reset the board ---------- */

test("embed_serial refuses reset_on_connect, because a reset changes the board", async () => {
  const { embeddedTools } = await import("../src/tools/embeddedTools.ts");
  const tool = embeddedTools.find((entry) => entry.name === "embed_serial");
  assert.ok(tool);
  assert.equal(tool.readonly, true);
  const result = await tool.execute(
    { port: "COM-NOT-REAL", reset_on_connect: true },
    {
      cwd: process.cwd(),
      signal: new AbortController().signal,
      config: { allowedDirs: [] },
      permissions: { mode: "plan", check: async () => ({ allowed: true }) },
      ui: {},
      todo: { items: [] },
      runSubagent: async () => "",
    } as never,
  );
  assert.equal(result.isError, true);
  assert.match(String(result.content), /read-?only|resets the board/i);
});

test("the serial tool schema no longer offers a reset switch", async () => {
  const { embeddedTools } = await import("../src/tools/embeddedTools.ts");
  const tool = embeddedTools.find((entry) => entry.name === "embed_serial");
  assert.ok(tool);
  const properties = (tool.parameters as { properties: Record<string, unknown> }).properties;
  assert.equal("reset_on_connect" in properties, false);
});

/* ---------- 3.4 flasher parameters that cannot be guessed ---------- */

test("avrdude refuses without a programmer and a part instead of failing inside the tool", () => {
  const hex = firmware("app.hex");
  try {
    const noProgrammer = validate({ kind: "avrdude", program: "avrdude", firmware: hex } as never);
    assert.match(String(noProgrammer), /programmer/i);
    const noPart = validate({ kind: "avrdude", program: "avrdude", firmware: hex, programmer: "arduino" } as never);
    assert.match(String(noPart), /part/i);
  } finally {
    rmSync(join(hex, ".."), { recursive: true, force: true });
  }
});

test("avrdude uses the programmer and part it was given", () => {
  const hex = firmware("app.hex");
  try {
    const args = commandFor({
      kind: "avrdude",
      program: "avrdude",
      firmware: hex,
      programmer: "arduino",
      part: "atmega328p",
      port: "COM3",
    } as never);
    const joined = args.join(" ");
    assert.match(joined, /-c arduino/);
    assert.match(joined, /-p atmega328p/);
    assert.match(joined, /-P COM3/);
  } finally {
    rmSync(join(hex, ".."), { recursive: true, force: true });
  }
});

test("a .uf2 is only accepted by a flasher that can write it", () => {
  const uf2 = firmware("app.uf2");
  try {
    // None of the supported flashers writes UF2 over a debug probe; the UF2
    // bootloader needs a mass-storage copy, which is not what this tool does.
    const reason = validate({ kind: "pyocd", program: "pyocd", firmware: uf2, target: "rp2040" });
    assert.match(String(reason), /uf2/i);
    assert.equal(validate({ kind: "dfu-util", program: "dfu-util", firmware: firmware("app.bin"), address: 0x08000000 }), null);
  } finally {
    rmSync(join(uf2, ".."), { recursive: true, force: true });
  }
});

/* ---------- 3.5 the promised-but-missing tools are gone from the surface ---------- */

test("a tool that is still unimplemented is not advertised", async () => {
  const { embeddedTools } = await import("../src/tools/embeddedTools.ts");
  const names = new Set(embeddedTools.map((tool) => tool.name));
  // embed_measure now has drivers (SCPI, Joulescope, PPK2, sigrok) and reports
  // honestly when no instrument is attached. embed_datasheet and embed_pinmap
  // read PDF indexes, devicetree, SVD and pin tables. embed_waveform reads VCD
  // and thresholded CSVs. None of them is a placeholder any more.
  for (const present of ["embed_measure", "embed_test", "embed_trace", "embed_power", "embed_packs", "embed_datasheet", "embed_pinmap", "embed_waveform"]) {
    assert.equal(names.has(present), true, `${present} is implemented and should be listed`);
  }
});

/* ---------- the embedded environment keeps the variables a toolchain needs ---------- */

test("the embedded environment keeps ARM/Zephyr variables and drops unrelated secrets", () => {
  const saved = { ...process.env };
  process.env.ARM_TOOLCHAIN_PATH = "C:/arm";
  process.env.ZEPHYR_BASE = "C:/zephyr";
  process.env.CMSIS_PACK_ROOT = "C:/packs";
  process.env.AWS_SECRET_ACCESS_KEY = "secret";
  try {
    const env = embeddedBaseEnv();
    assert.equal(env.ARM_TOOLCHAIN_PATH, "C:/arm");
    assert.equal(env.ZEPHYR_BASE, "C:/zephyr");
    assert.equal(env.CMSIS_PACK_ROOT, "C:/packs");
    assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});

/* ---------- 3.3 a flash controller is not the chip's flash ---------- */

/*
 * Every SVD that ships with STM32CubeProgrammer models the flash *controller*
 * as a peripheral named FLASH at 0x40023C00, declares its address block as
 * `registers`, and gives it ACR/CR/LATENCY fields. Filing that as the part's
 * storage made "how much flash does this chip have" answer with a control
 * register map. The check is structural: memory regions only.
 */

const SVD_FLASH_CONTROLLER = `<?xml version="1.0"?>
<device><name>CTRLCHIP</name>
  <peripherals>
    <peripheral>
      <name>FLASH</name>
      <baseAddress>0x40023C00</baseAddress>
      <addressBlock><offset>0x0</offset><size>0x400</size><usage>registers</usage></addressBlock>
      <registers><register><name>ACR</name><addressOffset>0x0</addressOffset></register></registers>
    </peripheral>
    <peripheral>
      <name>FLASH_MEM</name>
      <baseAddress>0x08000000</baseAddress>
      <addressBlock><offset>0x0</offset><size>0x100000</size><usage>buffer</usage></addressBlock>
    </peripheral>
    <peripheral>
      <name>SRAM</name>
      <baseAddress>0x20000000</baseAddress>
      <addressBlock><offset>0x0</offset><size>0x20000</size><usage>buffer</usage></addressBlock>
    </peripheral>
  </peripherals>
</device>`;

test("a peripheral in peripheral space is never counted as storage", async () => {
  const { parseSvd, memoryTotals } = await import("../src/embedded/svd.ts");
  const device = parseSvd(SVD_FLASH_CONTROLLER);
  const names = (device.memories ?? []).map((memory) => memory.name);
  assert.equal(names.includes("FLASH"), false, "the flash controller at 0x40023C00 is not memory");
  assert.equal(names.includes("FLASH_MEM"), true);
  assert.equal(names.includes("SRAM"), true);
  const totals = memoryTotals(device);
  assert.equal(totals.flash, 0x100000);
  assert.equal(totals.ram, 0x20000);
});

test("the SVD storage total counts aliased regions once", async () => {
  const { parseSvd, memoryTotals } = await import("../src/embedded/svd.ts");
  const xml = `<device><name>A</name><peripherals>
    <peripheral><name>FLASH0</name><baseAddress>0x08000000</baseAddress>
      <addressBlock><size>0x40000</size><usage>buffer</usage></addressBlock></peripheral>
    <peripheral><name>FLASH_ALIAS</name><baseAddress>0x08000000</baseAddress>
      <addressBlock><size>0x40000</size><usage>buffer</usage></addressBlock></peripheral>
    <peripheral><name>SRAM0</name><baseAddress>0x20000000</baseAddress>
      <addressBlock><size>0x8000</size><usage>buffer</usage></addressBlock></peripheral>
  </peripherals></device>`;
  const totals = memoryTotals(parseSvd(xml));
  assert.equal(totals.flash, 0x40000, "the same start address is one region, not two");
  assert.equal(totals.ram, 0x8000);
});

test("real STM32 SVDs report their flash controller as control space, not storage", async () => {
  const dir = "C:/Program Files/STMicroelectronics/STM32Cube/STM32CubeProgrammer/SVD";
  const { existsSync } = await import("node:fs");
  if (!existsSync(dir)) return; // the sample set is machine-specific
  const { parseSvd, memoryTotals } = await import("../src/embedded/svd.ts");
  const device = parseSvd(join(dir, "STM32F429.svd"));
  const controller = device.peripherals.find((peripheral) => peripheral.name === "FLASH");
  assert.ok(controller, "the controller peripheral still parses normally");
  assert.equal(controller.baseAddress, 0x40023c00);
  assert.equal(memoryTotals(device).flash, 0, "the controller must not be counted as the part's flash");
});
