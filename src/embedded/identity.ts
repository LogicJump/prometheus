/**
 * Which chip is actually attached, read from the chip.
 *
 * The Board pane used to show whatever target was last stored in the config.
 * That is a record of what the user picked once, not a fact about the board in
 * front of them: swap an F103 for an F429 and the pane keeps happily saying
 * `stm32f103rc`, because nothing ever asks the hardware.
 *
 * There is no vendor-neutral way to ask "what are you" over SWD. There is a
 * vendor-neutral way to ask "what registers do you have", and on Arm parts the
 * answer is enough:
 *
 *   1. **DP IDCODE** (`0x2BA01477` on SW-DP) says there is a debug port at all.
 *   2. **ROM table** at `0xE00FF000` says which debug components exist.
 *   3. The vendor's **device-identity register** names the part. On every ARM
 *      Cortex-M vendor it lives in a per-vendor "debug MCU" block; ST puts
 *      DBGMCU_IDCODE at `0xE0042000`, and its low 12 bits (`0x419`) are the
 *      device id in the reference manual.
 *
 * Only the third step is vendor-specific, and it is one line in a table. When
 * no driver in the table matches, this module reports *that* — the identity is
 * unknown, not guessed at. Reporting a wrong part number here means the next
 * flash call writes to the wrong chip.
 *
 * Reading the registers goes through a probe the machine already has. pyOCD's
 * generic `cortex_m` target can attach to any Cortex-M without knowing the
 * part, which is exactly the bootstrap a discovery step needs; OpenOCD's `dap`
 * and probe-rs can do the same, and each has its own adapter below.
 */

import { execFile, spawn } from "node:child_process";
import { toolEnv } from "./toolEnv.ts";

/** A device-identity register and how to read the part out of it. */
export interface IdentityDriver {
  /** Vendor whose parts this driver recognises, used in the report. */
  vendor: string;
  /** Where the identity word lives. */
  address: number;
  /** Width of the load: 32 bits for every vendor seen so far. */
  width: 32;
  /** Pull the device id out of the word. */
  deviceId: (word: number) => number;
  /** Human name for a device id, when the vendor's manual names it. */
  family: (deviceId: number) => string | undefined;
  /**
   * Optional: read the flash size in KiB from a second register.
   *
   * The address depends on the family (`flashSizeAddress`), so this takes the
   * family rather than a fixed address — a vendor that publishes the size in
   * different system-memory locations per family has to be read per family.
   */
  flashSize?: {
    address: (family: string | undefined) => number | undefined;
    kib: (word: number) => number;
  };
}

/** `DBGMCU_IDCODE` on the STM32 families that use the `0xE0042000` block. */
const STM32_IDCODE = 0xe0042000;
/** `DBGMCU_IDCODE` on the F0 family, which predates that block layout. */
const STM32_IDCODE_F0 = 0x40015800;

/**
 * Flash size registers, by family.
 *
 * There is no single address: ST published the size in whatever spare system
 * memory each family had. Reading the F4 address on an F103 returns unrelated
 * bytes, and a confidently wrong capacity is worse than no capacity — the
 * flash-code matching downstream would pick a target from it.
 */
const STM32_FLASHSIZE_BY_FAMILY: Record<string, number> = {
  // 0x1FFF7A22 — RM0090 (F4), RM0385 (F7).
  f4: 0x1fff7a22,
  f7: 0x1fff7a22,
  // 0x1FFFF7E0 — RM0008.
  f1: 0x1ffff7e0,
  // 0x1FFFF7CC — RM0091.
  f0: 0x1ffff7cc,
  // 0x1FFF75E0 — RM0351.
  l4: 0x1fff75e0,
  // 0x1FF1E880 — RM0433.
  h7: 0x1ff1e880,
};

/**
 * Family key for the flash-size table, from the family name.
 *
 * `STM32F42x/43x` -> `f4`, `STM32F103xx` -> `f1`. A family the table does not
 * cover returns undefined, and the caller omits the size rather than reading
 * an address that means something else on that part.
 */
function flashFamily(family: string | undefined): string | undefined {
  if (!family) return undefined;
  const match = /stm32([a-z]+)(\d)/i.exec(family);
  if (!match) return undefined;
  const key = `${match[1].toLowerCase()}${match[2]}`;
  return key in STM32_FLASHSIZE_BY_FAMILY ? key : undefined;
}

/** The flash-size register for an identity, when one is known for the family. */
export function flashSizeAddress(family: string | undefined): number | undefined {
  const key = flashFamily(family);
  return key ? STM32_FLASHSIZE_BY_FAMILY[key] : undefined;
}

/**
 * ST's device ids, from RM0090 (F4), RM0385/RM0435 (F7) and RM0433 (H7).
 *
 * Only the families this project has actually been pointed at are listed. An
 * unlisted id is reported as a raw number rather than mapped to a guessed
 * family: `0x419` means "F42x/F43x", and calling it "F429" would be a lie
 * whenever the part is an F427.
 */
const STM32_FAMILIES: Record<number, string> = {
  0x413: "STM32F40x/41x",
  0x419: "STM32F42x/43x",
  0x421: "STM32F446",
  0x423: "STM32F401xB/C",
  0x431: "STM32F411",
  0x433: "STM32F401xD/E",
  0x441: "STM32F412",
  0x458: "STM32F410",
  0x461: "STM32F423",
  0x463: "STM32F413/423",
  0x449: "STM32F74x/75x",
  0x451: "STM32F76x/77x",
  0x452: "STM32F72x/73x",
  0x450: "STM32H742/743/753/750",
  0x480: "STM32H7A3/H7B3",
  0x483: "STM32H72x/723",
  0x484: "STM32H7B0",
  0x410: "STM32F10x Low-density",
  0x412: "STM32F10x Medium-density",
  0x414: "STM32F10x High-density",
  0x416: "STM32L1xx Medium-density",
  0x418: "STM32F1xx Connectivity",
  0x420: "STM32F10x Medium-density VL",
  0x428: "STM32F10x High-density VL",
  0x430: "STM32F10x XL-density",
  0x440: "STM32F05x/030",
  0x442: "STM32F09x",
};

export const ST_STM32_IDENTITY: IdentityDriver = {
  vendor: "STMicroelectronics",
  address: STM32_IDCODE,
  width: 32,
  // Bits 31:16 are the revision; the part is the low 12 bits.
  deviceId: (word) => word & 0xfff,
  family: (deviceId) => STM32_FAMILIES[deviceId],
  flashSize: {
    address: (family) => flashSizeAddress(family),
    // The low 16 bits are the size in KiB, e.g. 0x0400 -> 1024 KiB.
    kib: (word) => word & 0xffff,
  },
};

export const IDENTITY_DRIVERS: IdentityDriver[] = [ST_STM32_IDENTITY];

/** What the probe could learn about the attached device. */
export interface Identity {
  /** Which probe adapter answered, e.g. `pyocd`. */
  probe: string;
  /** DP IDCODE, when the adapter reports one. */
  dpIdcode?: number;
  /** The vendor driver whose register was read. */
  vendor: string;
  /** Raw identity word as the chip returned it. */
  word: number;
  /** Device id extracted from `word`. */
  deviceId: number;
  /** Family name, when the driver's table has one for this id. */
  family?: string;
  /** Flash size in KiB, when the vendor publishes it next to the identity. */
  flashKib?: number;
}

export interface IdentityFailure {
  /** Every adapter that was tried, and what it said. */
  attempts: { probe: string; reason: string }[];
}

export type IdentityResult = { ok: true; identity: Identity } | { ok: false; failure: IdentityFailure };

/* ------------------------------------------------------------------------- */
/* Adapters                                                                   */
/* ------------------------------------------------------------------------- */

interface RunResult {
  ok: boolean;
  out: string;
  err: string;
}

function run(program: string, args: string[], timeout = 30_000): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      program,
      args,
      { env: toolEnv(), timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      // Some probes print their results on stderr and exit non-zero over a
      // warning; both streams are kept so a parse failure can quote what it saw.
      (error, stdout, stderr) => resolve({ ok: !error, out: String(stdout ?? ""), err: String(stderr ?? "") }),
    );
  });
}

/**
 * Parse pyOCD commander's `read32`.
 *
 * The output is `e0042000:  20036419   | .d.|` — address, value, and an ASCII
 * column that must not be mistaken for part of the number. pyOCD prefixes
 * each line with a two-byte log level (`0001234 I ...`), which is why the match
 * is anchored on the address rather than on the start of the line.
 */
export function parsePyocdRead32(output: string, address: number): number | undefined {
  const wanted = `0x${(address >>> 0).toString(16).padStart(8, "0")}`;
  const bare = (address >>> 0).toString(16).padStart(8, "0");
  for (const line of output.split(/\r?\n/)) {
    // The value column is as wide as the load: `read32` prints eight digits,
    // a narrower load prints fewer, and the ASCII column follows.
    const match = /([0-9a-f]{8})\s*:\s*([0-9a-f]{4,8})\b/i.exec(line);
    if (!match) continue;
    const found = Number.parseInt(match[1], 16).toString(16).padStart(8, "0");
    if (found !== bare && `0x${found}` !== wanted) continue;
    return Number.parseInt(match[2], 16);
  }
  return undefined;
}

/** pyOCD, through its generic `cortex_m` target, which needs no part name. */
async function viaPyocd(path: string, driver: IdentityDriver): Promise<IdentityResult> {
  const attempts: { probe: string; reason: string }[] = [];
  const read = async (address: number, label: string) => {
    const result = await run(path, [
      "commander",
      "--no-config",
      // pyOCD's default `connect_mode` is `halt`, which stops every core on
      // connect. Reading an identity register does not need the core stopped,
      // and this runs while the user may be watching a live firmware, so the
      // scan attaches instead of halting. Verified on an STM32F429: the id
      // reads the same in `attach` mode.
      "-O",
      "connect_mode=attach",
      "-t",
      "cortex_m",
      "-c",
      `read32 0x${address.toString(16)}`,
    ]);
    const text = `${result.out}\n${result.err}`;
    const value = parsePyocdRead32(text, address);
    if (value === undefined) {
      attempts.push({ probe: "pyocd", reason: `${label} read failed: ${firstMeaningful(text)}` });
    }
    return value;
  };

  const word = await read(driver.address, "identity");
  if (word === undefined) return { ok: false, failure: { attempts } };

  const identity: Identity = {
    probe: "pyocd",
    vendor: driver.vendor,
    word,
    deviceId: driver.deviceId(word),
  };
  const family = driver.family(identity.deviceId);
  if (family) identity.family = family;
  if (driver.flashSize) {
    // The size register moves between families, so the family that was just
    // read decides whether there is an address to read at all.
    const address = driver.flashSize.address(family);
    if (address !== undefined) {
      const sizeWord = await read(address, "flash size");
      if (sizeWord !== undefined) {
        const kib = driver.flashSize.kib(sizeWord);
        // A zero here is what a part returns when the register is not
        // implemented; it is not a 0 KiB chip.
        if (kib > 0) identity.flashKib = kib;
      }
    }
  }
  return { ok: true, identity };
}

/**
 * OpenOCD.
 *
 * OpenOCD has no generic target: `init` without a `target create` leaves it
 * with nothing to `mdw` against, and the read fails with "current_target out of
 * bounds". The adapter therefore only works when a target config is supplied,
 * and says so plainly when it is not rather than burning twenty seconds on a
 * command that cannot succeed.
 *
 * The interface file is a parameter for the same reason: naming `stlink.cfg`
 * for a J-Link would fail after `init` with a message about transports.
 */
async function viaOpenocd(
  path: string,
  driver: IdentityDriver,
  config: { interfaceCfg?: string; targetCfg?: string } = {},
): Promise<IdentityResult> {
  const attempts: { probe: string; reason: string }[] = [];
  if (!config.targetCfg) {
    return {
      ok: false,
      failure: { attempts: [{ probe: "openocd", reason: "no target config, so OpenOCD has nothing to read through" }] },
    };
  }
  const commands = ["adapter speed 950", "init", `target create discovered ${config.targetCfg}`];
  commands.push(`mdw 0x${driver.address.toString(16)}`, "shutdown");
  const result = await run(path, [
    "-f",
    config.interfaceCfg ?? "interface/stlink.cfg",
    "-c",
    "transport select swd",
    ...commands.flatMap((command) => ["-c", command]),
  ]);
  const text = `${result.out}\n${result.err}`;
  // OpenOCD echoes each `-c` command before running it, so the first 32-bit
  // hex on the line is the address we passed rather than the value read back.
  const match = /^0x([0-9a-f]{8})\b/im.exec(text);
  if (!match) {
    attempts.push({ probe: "openocd", reason: firstMeaningful(text) });
    return { ok: false, failure: { attempts } };
  }
  const word = Number.parseInt(match[1], 16);
  const identity: Identity = {
    probe: "openocd",
    vendor: driver.vendor,
    word,
    deviceId: driver.deviceId(word),
  };
  const family = driver.family(identity.deviceId);
  if (family) identity.family = family;
  return { ok: true, identity };
}

/**
 * Read the identity register through J-Link Commander.
 *
 * `JLinkExe` has no one-shot read; it runs a Commander script from stdin and
 * prints `mem<width> <address> = <value>`. That is enough to answer the same
 * question the other adapters answer, and a machine with only SEGGER's tools
 * otherwise gets no identification at all.
 */
async function viaJlink(path: string, driver: IdentityDriver): Promise<IdentityResult> {
  const attempts: { probe: string; reason: string }[] = [];
  const script = [
    "si SWD",
    "speed 4000",
    "connect",
    `mem32 0x${(driver.address >>> 0).toString(16)}, 1`,
    "exit",
  ].join("\n");
  const result = await runWithInput(path, ["-NoGui", "1", "-ExitOnError", "1"], `${script}\n`);
  const text = `${result.out}\n${result.err}`;
  const value = parseJlinkRead32(text, driver.address);
  if (value === undefined) {
    attempts.push({ probe: "jlink", reason: `identity read failed: ${firstMeaningful(text)}` });
    return { ok: false, failure: { attempts } };
  }
  const identity: Identity = { probe: "jlink", vendor: driver.vendor, word: value, deviceId: driver.deviceId(value) };
  const family = driver.family(identity.deviceId);
  if (family) identity.family = family;
  if (driver.flashSize) {
    const address = driver.flashSize.address(family);
    if (address !== undefined) {
      const sizeScript = [`mem32 0x${(address >>> 0).toString(16)}, 1`, "exit"].join("\n");
      const sizeRun = await runWithInput(path, ["-NoGui", "1", "-ExitOnError", "1"], `${sizeScript}\n`);
      const sizeWord = parseJlinkRead32(`${sizeRun.out}\n${sizeRun.err}`, address);
      if (sizeWord !== undefined) {
        const kib = driver.flashSize.kib(sizeWord);
        if (kib > 0) identity.flashKib = kib;
      }
    }
  }
  return { ok: true, identity };
}

/**
 * `mem32 0xE0042000, 1` prints `E0042000 = 20036419`. The address column makes
 * the line unambiguous when a script echoes several reads.
 */
export function parseJlinkRead32(output: string, address: number): number | undefined {
  const wanted = (address >>> 0).toString(16).padStart(8, "0");
  for (const line of output.split(/\r?\n/)) {
    const match = /\b([0-9a-f]{8})\s*=\s*([0-9a-f]{8})\b/i.exec(line);
    if (!match) continue;
    if (match[1].toLowerCase() !== wanted) continue;
    return Number.parseInt(match[2], 16);
  }
  return undefined;
}

/** Run a tool with text on stdin; Commander scripts are read from there. */
function runWithInput(program: string, args: string[], input: string, timeout = 30_000): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(program, args, { env: toolEnv(), windowsHide: true });
    let out = "";
    let err = "";
    const timer = setTimeout(() => child.kill(), timeout);
    child.stdout?.on("data", (chunk) => {
      out += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      err += String(chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ ok: false, out, err: `${err}\n${error.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, out, err });
    });
    child.stdin?.end(input);
  });
}

/** The first line of tool output that is neither a banner nor a blank line. */
function firstMeaningful(text: string): string {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (/^xPack Open On-Chip|^Licensed|^For bug reports|^executed command|^-+$/.test(line)) continue;
    return line.slice(0, 200);
  }
  return "no output";
}

/**
 * Identify the attached chip, trying every probe the machine has.
 *
 * The drivers are tried in order and the first success wins. A failure is a
 * report, never a guess: the caller shows the attempts so a user whose chip is
 * not in a driver table can see exactly which register was read and what came
 * back.
 */
export async function identifyChip(
  available: { pyocd?: string; openocd?: string; openocdInterface?: string; openocdTarget?: string; jlink?: string },
  drivers: IdentityDriver[] = IDENTITY_DRIVERS,
): Promise<IdentityResult> {
  const attempts: { probe: string; reason: string }[] = [];
  if (!available.pyocd && !available.openocd && !available.jlink) {
    return {
      ok: false,
      failure: { attempts: [{ probe: "none", reason: "no probe tool is installed (pyocd, openocd or jlink)" }] },
    };
  }

  for (const driver of drivers) {
    if (available.pyocd) {
      const result = await viaPyocd(available.pyocd, driver);
      if (result.ok) return result;
      attempts.push(...result.failure.attempts);
    }
    if (available.openocd) {
      const result = await viaOpenocd(available.openocd, driver, {
        ...(available.openocdInterface ? { interfaceCfg: available.openocdInterface } : {}),
        ...(available.openocdTarget ? { targetCfg: available.openocdTarget } : {}),
      });
      if (result.ok) return result;
      attempts.push(...result.failure.attempts);
    }
    if (available.jlink) {
      const result = await viaJlink(available.jlink, driver);
      if (result.ok) return result;
      attempts.push(...result.failure.attempts);
    }
  }
  return { ok: false, failure: { attempts } };
}

/* ------------------------------------------------------------------------- */
/* Matching an identification against the target table                        */
/* ------------------------------------------------------------------------- */

/**
 * Suggest a pyOCD target name from an identification.
 *
 * The device id gives the family (`F42x/43x`), and the flash size pins the
 * code (the `xG`/`xI` suffix in pyOCD's names). Both are needed: `stm32f429xg`
 * and `stm32f429xi` differ only in flash, and flashing an `xi` image to an
 * `xg` part truncates silently.
 *
 * The result is a suggestion. Nothing is written to the selection until the
 * user accepts it, because a wrong part number here is a wrong flash.
 */
export function suggestTargets(identity: Identity, targets: { name: string }[]): string[] {
  if (!identity.family) return [];
  const stems = familyStems(identity.family);
  if (stems.length === 0) return [];

  const flashCode = identity.flashKib === undefined ? undefined : flashCodeFor(identity.flashKib);
  const matches = targets.filter((target) => {
    const name = target.name.toLowerCase();
    const stem = stems.find((candidate) => name.startsWith(candidate));
    if (!stem) return false;
    if (flashCode === undefined) return true;
    // The trailing letter is the flash size code; without one the name is a
    // whole-family target and stays a valid candidate.
    const suffix = name.slice(stem.length);
    return suffix === "" || suffix.endsWith(flashCode);
  });
  return matches.map((target) => target.name);
}

/** pyOCD's trailing flash-size letter, from the size the part reports. */
export function flashCodeFor(kib: number): string | undefined {
  // ST's convention: 8=64, B=128, C=256, D=384, E=512, F=768, G=1024, I=2048.
  const codes: [number, string][] = [
    [64, "8"],
    [128, "b"],
    [256, "c"],
    [384, "d"],
    [512, "e"],
    [768, "f"],
    [1024, "g"],
    [2048, "i"],
  ];
  // Round to the nearest published size: the register reports the part's real
  // flash, which is one of these even when the die also has hidden pages.
  let best: [number, string] | undefined;
  for (const entry of codes) {
    if (!best || Math.abs(entry[0] - kib) < Math.abs(best[0] - kib)) best = entry;
  }
  return best?.[1];
}

/**
 * `STM32F42x/43x` -> `["stm32f42", "stm32f43"]`.
 *
 * The second family is written as a bare suffix (`43x`), so it inherits the
 * first one's vendor prefix rather than being read as a family of its own.
 * Both `suggestTargets` and `targetMatchesIdentity` use this, because a name
 * suggested from an identification must also pass the mismatch check.
 */
export function familyStems(family: string): string[] {
  const parts = family
    .toLowerCase()
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) return [];

  const body = (part: string) => part.replace(/^stm32/, "").replace(/x+$/, "");
  const first = body(parts[0]);
  const prefix = /^([a-z]+)/.exec(first)?.[1] ?? "";

  return parts
    .map((part, index) => (index === 0 ? first : body(part)))
    .filter(Boolean)
    .map((stem) => (/^\d/.test(stem) ? `stm32${prefix}${stem}` : `stm32${stem}`));
}

/** One paragraph a person can read, and the model can quote. */
export function formatIdentity(result: IdentityResult): string {
  if (!result.ok) {
    const lines = result.failure.attempts.map((attempt) => `  ${attempt.probe}: ${attempt.reason}`);
    return "Could not identify the attached chip.\n" + lines.join("\n");
  }
  const id = result.identity;
  const lines = [
    `${id.family ?? "Unknown part"} (${id.vendor})`,
    `device id: 0x${id.deviceId.toString(16)}`,
    `identity word: 0x${id.word.toString(16).padStart(8, "0")} read via ${id.probe}`,
  ];
  if (id.flashKib !== undefined) lines.push(`flash: ${id.flashKib} KiB (reported by the part)`);
  return lines.join("\n");
}
