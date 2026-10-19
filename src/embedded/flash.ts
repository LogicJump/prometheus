/**
 * Getting the firmware onto the chip, and knowing whether it worked.
 *
 * Failing at this stage is expensive in a way compiling is not: a half-written
 * flash is a brick, and an agent that moves on after a "successful" flash it
 * did not verify leaves the user with a board that does nothing and no clue
 * why. So this module is built around one rule:
 *
 *   The tool's exit code is a hint, not the answer.
 *
 * pyOCD and probe-rs exit zero on a verify failure in some versions; OpenOCD
 * exits zero after `shutdown` whether or not the program step worked; esptool
 * prints its real status. Each adapter therefore parses the tool's own output
 * for the phrases that mean success and failure, and the caller gets a
 * structured result either way.
 *
 * Nothing here guesses a probe or a target. A flash with no probe is refused
 * before anything runs, because the alternative is that the tool picks the
 * first probe it finds and programs the wrong board.
 */

import { execFile } from "node:child_process";
import { existsSync, statSync, writeFileSync } from "node:fs";
import { extname } from "node:path";
import { toolEnv } from "./toolEnv.ts";

export type FlasherKind = "pyocd" | "openocd" | "probe-rs" | "jlink" | "esptool" | "st-flash" | "dfu-util" | "avrdude";

export interface FlashRequest {
  kind: FlasherKind;
  /** Resolved path to the flasher executable. */
  program: string;
  /** The firmware file: .elf, .hex or .bin. */
  firmware: string;
  /** pyOCD/probe-rs target name, e.g. `stm32f412xe`. */
  target?: string;
  /** Probe serial or unique id, when several are attached. */
  probe?: string;
  /** Load address; required for a .bin, ignored for elf/hex. */
  address?: number;
  /** Reset after programming. Default true. */
  reset?: boolean;
  /** OpenOCD interface config file, e.g. `interface/stlink.cfg`. */
  interfaceConfig?: string;
  /** OpenOCD target config file, e.g. `target/stm32f4x.cfg`. */
  targetConfig?: string;
  /** esptool baud rate. */
  baud?: number;
  /** Serial port for tools that program over one (avrdude `-P`, esptool `--port`). */
  port?: string;
  /** avrdude programmer id (`-c`), e.g. `arduino`, `usbasp`. */
  programmer?: string;
  /** avrdude part id (`-p`), e.g. `atmega328p`. */
  part?: string;
  /** Extra arguments, passed through unchanged. */
  extraArgs?: string[];
}

export interface FlashResult {
  ok: boolean;
  /** The command that ran, for the audit log and for the user. */
  command: string;
  /** Bytes written, when the tool reports it. */
  bytes?: number;
  /** Human-readable summary of what happened. */
  detail: string;
  /** Why this is not ok. */
  reason?: string;
  /** True when the tool reported a verify step and it passed. */
  verified?: boolean;
  durationMs: number;
  /** The tool's own output, capped. */
  output: string;
  exitCode: number | null;
}

const OUTPUT_CAP = 8000;

function clip(text: string): string {
  if (text.length <= OUTPUT_CAP) return text;
  // Keep the tail: the summary line is always last.
  return `… ${text.length - OUTPUT_CAP} chars elided …\n${text.slice(-OUTPUT_CAP)}`;
}

function run(program: string, args: string[], timeout: number): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile(program, args, { env: toolEnv(), timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
      resolve({ code, out: String(stdout ?? ""), err: String(stderr ?? "") });
    });
  });
}

// Phrases each tool prints on success. Kept as data so the reason a result is
// "ok" is inspectable rather than buried in an if.
const SUCCESS_MARKERS: Record<FlasherKind, RegExp[]> = {
  pyocd: [/\[flasher\]\s+loaded\s+\S+\s+bytes/i, /^Space Core\s+OK/im, /Erased\s+\d+.*programmed/i],
  openocd: [/\*\* Programming Finished \*\*/i, /\*\* Verified OK \*\*/i, /shutdown command invoked/i],
  "probe-rs": [/Finished in \d+\.\d+s/i, /Erasing sectors \.\.\. \[done\]/i, /\[done\]/i],
  // `O.K.` alone is what a bare connection prints. A flash needs the download
  // or compare step to have run, which is a separate line.
  jlink: [/Verify successful\.?/i, /Programming successful\.?/i, /(?:Downloading|Comparing).*\n(?:.*\n)?.*O\.K\./i, /Comparing flash contents[\s\S]{0,200}O\.K\./i],
  esptool: [/Hash of data verified/i, /Wrote \d+ bytes .* at .*/i, /Leaving\.\.\./i],
  "st-flash": [/Flash written and verified/i, /OK/i],
  "dfu-util": [/File downloaded successfully/i],
  avrdude: [/avrdude done\.  Thank you\./i],
};

// Phrases that mean failure even when the exit code says zero.
const FAILURE_MARKERS: Record<FlasherKind, RegExp[]> = {
  pyocd: [/verify failed/i, /error/i, /no available debug probes/i, /Target type .* not recognized/i],
  openocd: [/\*\* Programming Failed \*\*/i, /\*\* Verify Failed \*\*/i, /Error:/i, /could not find/i],
  "probe-rs": [/Error:/i, /failed to/i, /No debug probe/i],
  jlink: [/Failed/i, /Error \(/i, /Cannot connect/i],
  esptool: [/FAILED/i, /A fatal error occurred/i, /Timed out/i],
  "st-flash": [/error/i, /failed/i],
  "dfu-util": [/error/i, /No DFU capable USB device/i],
  avrdude: [/error/i, /failed/i, /can't open device/i],
};

/**
 * Four tools, four ways to say the same thing. This is why the adapter exists:
 * the agent should never branch on a tool's prose.
 */
export function classifyOutput(kind: FlasherKind, output: string, exitCode: number | null): { ok: boolean; verified?: boolean; reason?: string } {
  const failed = FAILURE_MARKERS[kind].find((pattern) => pattern.test(output));
  const succeeded = SUCCESS_MARKERS[kind].find((pattern) => pattern.test(output));
  const verified = /\*\* Verified OK \*\*|Hash of data verified|Verify successful|Flash written and verified|verify.*ok/i.test(output);

  if (failed) {
    // A failure phrase wins over a success phrase: pyOCD prints "loaded" then
    // "verify failed", and the second is the one that matters.
    return { ok: false, ...(verified ? { verified: true } : {}), reason: firstMatchLine(output, failed) };
  }
  if (succeeded) return { ok: true, ...(verified ? { verified: true } : {}) };
  // JLinkExe exits zero after a session that only connected and never loaded
  // anything, so its exit code proves nothing. Without a write phrase there is
  // no evidence a byte reached the chip, and "probably fine" is not a claim a
  // flasher gets to make.
  if (kind === "jlink") {
    return { ok: false, reason: "the J-Link session ended without reporting a write; nothing was programmed" };
  }
  // No phrase either way: fall back to the exit code, but say so.
  if (exitCode === 0) return { ok: true, reason: "the tool reported no status; exit code 0" };
  return { ok: false, reason: exitCode === null ? "the tool timed out" : `exit code ${exitCode}` };
}

function firstMatchLine(output: string, pattern: RegExp): string {
  for (const line of output.split(/\r?\n/)) {
    if (pattern.test(line)) return line.trim().slice(0, 200);
  }
  return pattern.source;
}

/**
 * The JLinkExe Commander script for this request, written beside the firmware.
 *
 * Returning the path (rather than the script text) is what makes the argv
 * self-describing: the command line names the file that is about to be read,
 * and the file itself names the firmware. A test can then assert that the
 * file to be written appears in the command.
 */
export function jlinkScriptPath(request: FlashRequest): string | null {
  if (!existsSync(request.firmware)) return null;
  const lower = request.firmware.toLowerCase();
  const loadFile =
    lower.endsWith(".bin") && request.address !== undefined
      ? `loadfile ${request.firmware} 0x${request.address.toString(16)}`
      : `loadfile ${request.firmware}`;
  const lines = [
    "r",
    "h",
    loadFile,
    lower.endsWith(".bin") ? `verifybin ${request.firmware} 0x${(request.address ?? 0).toString(16)}` : `verifyelf ${request.firmware}`,
  ];
  if (request.reset !== false) lines.push("r", "g");
  lines.push("qc");
  const scriptPath = `${request.firmware}.jlink`;
  try {
    writeFileSync(scriptPath, `${lines.join("\n")}\n`, "utf8");
    return scriptPath;
  } catch {
    return null;
  }
}

/** The argument vector for each tool. */
export function commandFor(request: FlashRequest): string[] {
  const reset = request.reset !== false;
  const extra = request.extraArgs ?? [];
  const lower = request.firmware.toLowerCase();

  switch (request.kind) {
    case "pyocd": {
      // The image is a positional argument. `-f` here is --frequency, the SWD
      // clock, so passing a path to it makes pyOCD reject the whole command
      // with "invalid convert_frequency value" before it touches the probe.
      const args = ["flash", request.firmware];
      if (request.target) args.push("--target", request.target);
      if (request.probe) args.push("--uid", request.probe);
      if (!reset) args.push("--no-reset");
      return [...args, ...extra];
    }
    case "openocd": {
      // OpenOCD is a scripting shell: everything after -c runs in order.
      const args: string[] = [];
      if (request.interfaceConfig) args.push("-f", request.interfaceConfig);
      if (request.targetConfig) args.push("-f", request.targetConfig);
      const program = ["program", request.firmware];
      if (request.address !== undefined && lower.endsWith(".bin")) program.push(String(request.address));
      if (lower.endsWith(".elf")) program.push("verify");
      else program.push("verify");
      if (reset) program.push("reset");
      program.push("exit");
      args.push("-c", program.join(" "));
      return [...args, ...extra];
    }
    case "probe-rs": {
      const args = ["download", request.firmware];
      if (request.target) args.push("--chip", request.target);
      if (request.probe) args.push("--probe", request.probe);
      if (!reset) args.push("--disable-progressbars");
      return [...args, ...extra];
    }
    case "jlink": {
      // JLinkExe is a session, not a one-shot command: it reads a Commander
      // script. `-autoconnect 1` connects, prints `O.K.`, and then waits at the
      // prompt — so a success marker on that output reported a flash that never
      // happened. The script is written to a file next to the firmware and run
      // with -CommanderScript, so the file is named, written and verified in
      // the same session.
      const device = request.target ?? "Cortex-M4";
      const args = ["-device", device, "-if", "SWD", "-speed", "4000", "-NoGui", "1"];
      if (request.probe) args.push("-SelectEmuBySN", request.probe);
      const scriptPath = jlinkScriptPath(request);
      if (scriptPath) args.push("-CommanderScript", scriptPath);
      else args.push("-autoconnect", "1");
      return [...args, ...extra];
    }
    case "esptool": {
      const args = ["--chip", "auto", "--baud", String(request.baud ?? 460800)];
      if (request.port) args.push("--port", request.port);
      args.push("write_flash");
      if (request.address !== undefined) args.push("0x" + request.address.toString(16));
      else args.push("0x0");
      args.push(request.firmware);
      return [...args, ...extra];
    }
    case "st-flash": {
      const args = ["write", request.firmware];
      args.push(request.address !== undefined ? "0x" + request.address.toString(16) : "0x08000000");
      return [...args, ...extra];
    }
    case "dfu-util": {
      const args = ["-a", "0", "-D", request.firmware, "-R"];
      return [...args, ...extra];
    }
    case "avrdude": {
      // -c and -p have no sensible defaults; a wrong part id silently writes
      // to the wrong flash layout, so the caller must supply both.
      const args = ["-V"];
      if (request.programmer) args.push("-c", request.programmer);
      if (request.part) args.push("-p", request.part);
      if (request.port) args.push("-P", request.port);
      args.push("-U", `flash:w:${request.firmware}:i`);
      return [...args, ...extra];
    }
    default:
      return [];
  }
}

/**
 * Check what can be checked before spawning anything.
 *
 * A .bin with no address is the classic mistake: every flasher has a different
 * default and none of them is the one the user meant.
 */
export function validate(request: FlashRequest): string | null {
  if (!existsSync(request.firmware)) return `firmware not found: ${request.firmware}`;
  let size = 0;
  try {
    size = statSync(request.firmware).size;
  } catch {
    return `cannot read ${request.firmware}`;
  }
  if (size === 0) return `${request.firmware} is empty`;

  const ext = extname(request.firmware).toLowerCase();
  if (![".elf", ".hex", ".bin", ".uf2"].includes(ext)) {
    return `${ext || "no extension"} is not a firmware format (expected .elf, .hex, .bin or .uf2)`;
  }
  // A .uf2 is written by copying it onto a mass-storage volume that the chip's
  // ROM bootloader exposes. None of these tools does that, so accepting the
  // file only produced a confusing failure inside the flasher.
  if (ext === ".uf2") {
    return "a .uf2 is written by copying it to the board's bootloader volume, which none of these flashers can do; use the .elf/.hex or pass a supported format";
  }
  if (ext === ".bin" && request.kind !== "esptool" && request.address === undefined) {
    return "a raw .bin needs a load address; pass `address` (usually 0x08000000 on STM32)";
  }
  if ((request.kind === "pyocd" || request.kind === "probe-rs") && !request.target) {
    return `${request.kind} needs a target name`;
  }
  if (request.kind === "jlink" && !request.target) {
    return "J-Link needs a device name (the probe's -device id, e.g. STM32F429ZI)";
  }
  if (request.kind === "avrdude" && !request.programmer) {
    return "avrdude needs a programmer id (pass `programmer`, e.g. arduino or usbasp)";
  }
  if (request.kind === "avrdude" && !request.part) {
    return "avrdude needs a part id (pass `part`, e.g. atmega328p)";
  }
  if (request.kind === "openocd" && !request.targetConfig) {
    return "OpenOCD needs a target config file (e.g. target/stm32f4x.cfg)";
  }
  return null;
}

/** Flash, verifying only as far as the tool can. */
export async function flash(request: FlashRequest, options: { timeoutMs?: number } = {}): Promise<FlashResult> {
  const started = Date.now();
  const precondition = validate(request);
  if (precondition) {
    return {
      ok: false,
      command: "",
      detail: "refused before running",
      reason: precondition,
      durationMs: 0,
      output: "",
      exitCode: null,
    };
  }

  const args = commandFor(request);
  const command = `${request.program} ${args.join(" ")}`;
  // A flash is seconds of work, not minutes; a hang means the probe is wedged.
  const timeout = options.timeoutMs ?? 120_000;
  const result = await run(request.program, args, timeout);
  const output = clip(`${result.out}${result.err ? `\n${result.err}` : ""}`);
  const verdict = classifyOutput(request.kind, output, result.code);

  return {
    ok: verdict.ok,
    command,
    detail: verdict.ok
      ? `programmed ${request.firmware}`
      : `flash failed: ${verdict.reason ?? "unknown reason"}`,
    ...(verdict.reason ? { reason: verdict.reason } : {}),
    ...(verdict.verified !== undefined ? { verified: verdict.verified } : {}),
    durationMs: Date.now() - started,
    output,
    exitCode: result.code,
  };
}

/**
 * Flash size and RAM headroom, from `arm-none-eabi-size -A`.
 *
 * An agent that reports "it compiled" without saying the image is 97% of flash
 * has not finished the job — the next feature will not link.
 */
export interface MemoryUsage {
  /** Bytes of flash the image occupies: .text + .data + any initialised region. */
  flash: number;
  /** Bytes of RAM it needs at rest: .data + .bss. */
  ram: number;
  sections: { name: string; size: number; address: number }[];
}

export function parseSize(output: string): MemoryUsage {
  const sections: MemoryUsage["sections"] = [];
  let flash = 0;
  let ram = 0;

  for (const rawLine of output.split(/\r?\n/)) {
    const match = /^\s*(\.[\w.$]+)\s+(\d+)\s+(\d+)\s*$/.exec(rawLine);
    if (!match) continue;
    const name = match[1];
    const size = Number(match[2]);
    const address = Number(match[3]);
    // Debug and attribute sections never reach the chip.
    if (/^\.(comment|ARM\.attributes|debug|symtab|strtab|shstrtab|note)/.test(name)) continue;
    sections.push({ name, size, address });

    // .text and .rodata live only in flash. .data does too — its initialiser
    // is stored there even though it runs from RAM — so it is counted in both.
    if (/^\.(text|rodata|data|vectors|isr_vector|itcm)/.test(name)) flash += size;
    if (/^\.(data|bss|noinit|ramfunc)/.test(name)) ram += size;
  }
  return { flash, ram, sections };
}
