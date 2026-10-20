/**
 * Round 11: Keil's own pack store.
 *
 * An MDK install keeps its device packs wherever `RTEPATH` in `TOOLS.INI`
 * points — on the machine this was written against, `G:\software\keil5pack`,
 * which no existing search path covered. Adding the root was not enough: Keil
 * writes packs one directory deeper than cpackget (`vendor/pack/version` vs
 * `vendor/version`), names the SVD on `<subFamily>` rather than `<device>`, and
 * a project names a `<variant>` (`STM32F429IGTx`) that appears nowhere as a
 * device name.
 *
 * Every case below is a real one from `Keil.STM32F4xx_DFP 3.1.1`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  installedPacks,
  keilPackRoots,
  keilToolsIniPaths,
  packRoots,
  parsePdsc,
  parseRtePath,
  resetPackPathCache,
} from "../src/embedded/cmsisPack.ts";

function scratch(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/* ---------- RTEPATH ---------- */

test("RTEPATH is read from the UV2 section, quoted and untrimmed", () => {
  const ini = [
    "[UV2]",
    'ORGANIZATION="1"',
    'RTEPATH="G:\\software\\keil5pack"',
    'CMSIS_TOOLBOX="G:\\software\\keil5\\ARM\\cmsis-toolbox"',
    "[ARM]",
    'PATH="G:\\software\\keil5\\ARM\\"',
  ].join("\n");
  assert.equal(parseRtePath(ini), "G:\\software\\keil5pack");
});

test("an RTEPATH outside [UV2] does not count", () => {
  // A later section may reuse the name, and reading the wrong one would point
  // the pack search at an unrelated directory.
  const ini = ["[ARM]", 'RTEPATH="D:\\decoy"', "[UV2]", 'PATH="x"'].join("\n");
  assert.equal(parseRtePath(ini), "");
});

test("a commented RTEPATH is ignored", () => {
  assert.equal(parseRtePath("[UV2]\n;RTEPATH=\"G:\\old\"\n"), "");
});

test("a TOOLS.INI with no RTEPATH yields nothing", () => {
  assert.equal(parseRtePath("[UV2]\nORGANIZATION=\"1\"\n"), "");
  assert.equal(parseRtePath(""), "");
});

test("KEIL_TOOLS_INI is searched before the default locations", () => {
  const paths = keilToolsIniPaths({ KEIL_TOOLS_INI: "D:\\custom\\TOOLS.INI" } as NodeJS.ProcessEnv);
  assert.equal(paths[0], "D:\\custom\\TOOLS.INI");
});

test("the pack root named by a TOOLS.INI is added to the search", () => {
  const dir = scratch("prometheus-keil-ini-");
  try {
    const packs = join(dir, "packs");
    mkdirSync(packs, { recursive: true });
    const ini = join(dir, "TOOLS.INI");
    writeFileSync(ini, `[UV2]\nRTEPATH="${packs}"\n`);
    resetPackPathCache();
    const roots = keilPackRoots({ KEIL_TOOLS_INI: ini } as NodeJS.ProcessEnv);
    // The registry-named install (if any) is read too; this asserts that the
    // INI we pointed at contributed its RTEPATH.
    assert.ok(roots.includes(packs), JSON.stringify(roots));
  } finally {
    rmSync(dir, { recursive: true, force: true });
    resetPackPathCache();
  }
});

/* ---------- the two directory layouts ---------- */

test("packs are found in Keil's vendor/pack/version layout", () => {
  const dir = scratch("prometheus-keil-packs-");
  const previous = process.env.CMSIS_PACK_ROOT;
  try {
    const packDir = join(dir, "Keil", "STM32F4xx_DFP", "3.1.1");
    mkdirSync(packDir, { recursive: true });
    writeFileSync(join(packDir, "Keil.STM32F4xx_DFP.pdsc"), "<package/>");
    process.env.CMSIS_PACK_ROOT = dir;
    const found = installedPacks(dir).filter((pack) => pack.packDir.startsWith(dir));
    assert.equal(found.length, 1);
    assert.equal(found[0].packDir, packDir);
  } finally {
    if (previous === undefined) delete process.env.CMSIS_PACK_ROOT;
    else process.env.CMSIS_PACK_ROOT = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("packs are still found in cpackget's vendor/version layout", () => {
  const dir = scratch("prometheus-cpackget-");
  const previous = process.env.CMSIS_PACK_ROOT;
  try {
    const packDir = join(dir, "Arm", "1.0.0");
    mkdirSync(packDir, { recursive: true });
    writeFileSync(join(packDir, "Arm.Pack.pdsc"), "<package/>");
    process.env.CMSIS_PACK_ROOT = dir;
    const found = installedPacks(dir).filter((pack) => pack.packDir.startsWith(dir));
    assert.equal(found.length, 1);
    assert.equal(found[0].packDir, packDir);
  } finally {
    if (previous === undefined) delete process.env.CMSIS_PACK_ROOT;
    else process.env.CMSIS_PACK_ROOT = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------- pdsc shapes from a real DFP ---------- */

/** The parts of Keil.STM32F4xx_DFP 3.1.1 that matter, verbatim in shape. */
const DFP = `<?xml version="1.0" encoding="UTF-8"?>
<package>
  <devices>
    <family Dfamily="STM32F4 Series">
      <subFamily DsubFamily="STM32F429">
        <processor Dclock="180000000"/>
        <debug svd="CMSIS/SVD/STM32F429.svd"/>
        <compile define="STM32F429xx"/>
        <device Dname="STM32F429IG">
          <memory name="Flash" access="rx" start="0x08000000" size="0x00100000" default="1" startup="1"/>
          <memory name="SRAM1" access="rwx" start="0x20000000" size="0x00030000" default="1"/>
          <memory name="SRAM2" access="rwx" start="0x10000000" size="0x00010000" default="0"/>
          <variant Dvariant="STM32F429IGTx"> <feature type="QFP" n="176"/> </variant>
          <variant Dvariant="STM32F429IGHx"> <feature type="BGA" n="176"/> </variant>
        </device>
        <device Dname="STM32F429ZI">
          <memory name="Flash" access="rx" start="0x08000000" size="0x00200000" default="1" startup="1"/>
          <memory name="SRAM1" access="rwx" start="0x20000000" size="0x00030000" default="1"/>
        </device>
      </subFamily>
    </family>
  </devices>
</package>`;

test("a device inherits its SVD from the enclosing subFamily", () => {
  const devices = parsePdsc(DFP, "test.pdsc");
  const ig = devices.find((device) => device.name === "STM32F429IG");
  assert.ok(ig);
  // The `<debug svd=...>` element is on the subFamily, not on this device.
  assert.equal(ig.svd, "CMSIS/SVD/STM32F429.svd");
  // The processor element here carries only Dclock; asserting a core name
  // would be inventing data the fixture does not have.
  assert.equal(ig.processor, undefined);
});

test("Keil's memory names are read without an id attribute", () => {
  const devices = parsePdsc(DFP, "test.pdsc");
  const ig = devices.find((device) => device.name === "STM32F429IG");
  assert.equal(ig?.flash, 0x00100000);
  // SRAM1 + SRAM2; `Math.max` is only for Flash, where a second region would
  // be a bank of the same address space rather than more of it.
  assert.equal(ig?.ram, 0x00030000 + 0x00010000);
  const zi = devices.find((device) => device.name === "STM32F429ZI");
  assert.equal(zi?.flash, 0x00200000);
});

test("package variants are kept as aliases", () => {
  const devices = parsePdsc(DFP, "test.pdsc");
  const ig = devices.find((device) => device.name === "STM32F429IG");
  assert.deepEqual(ig?.aliases, ["STM32F429IGTx", "STM32F429IGHx"]);
});

test("the project's own device name is a variant, not a device", () => {
  // `TOUCH.uvprojx` says `<Device>STM32F429IGTx</Device>`. If only device names
  // were indexed, every real Keil project would fail to find its pack.
  const devices = parsePdsc(DFP, "test.pdsc");
  const names = devices.map((device) => device.name);
  assert.ok(!names.includes("STM32F429IGTx"));
  assert.ok(devices.some((device) => device.aliases?.includes("STM32F429IGTx")));
});

/* ---------- with a real install, when there is one ---------- */

test("this machine's Keil pack store, when present, resolves the tested part", (t) => {
  resetPackPathCache();
  const roots = keilPackRoots();
  if (roots.length === 0) {
    t.skip("no Keil TOOLS.INI on this machine");
    return;
  }
  const rootsNow = packRoots(process.cwd());
  assert.ok(rootsNow.some((root) => roots.includes(root)), "the RTEPATH root is in the search");
  const packs = installedPacks(process.cwd());
  if (packs.length === 0) {
    t.skip("the pack store is empty");
    return;
  }
  const dfp = packs.find((pack) => /STM32F4xx_DFP/i.test(pack.path));
  if (!dfp) {
    t.skip("no STM32F4xx DFP installed");
    return;
  }
  const devices = parsePdsc(readFileSync(dfp.path, "utf8"), dfp.path);
  const ig = devices.find((device) => device.name === "STM32F429IG");
  assert.ok(ig, "the device the test project uses is in the pack");
  assert.ok(ig.svd, "and it inherits an SVD");
});
