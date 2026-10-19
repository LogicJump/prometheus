/**
 * Cortex-M crash decoding.
 *
 * A HardFault is the most common "the agent has no idea what it is looking at"
 * moment on an embedded board: the target is stopped, the backtrace is a
 * handful of addresses in the fault handler, and every register that would say
 * *why* is a bitfield spread across CFSR, HFSR, MMFAR and BFAR. This module
 * turns those values into sentences.
 *
 * Nothing here knows about a vendor. The register addresses are defined by the
 * ARMv7-M / ARMv8-M architecture (System Control Space, `0xE000ED00`), which is
 * what makes the diagnosis portable across every Cortex-M part.
 */

/** System Control Space registers for the fault status. */
export const FAULT_REGISTERS = {
  CFSR: 0xe000ed28,
  HFSR: 0xe000ed2c,
  DFSR: 0xe000ed30,
  MMFAR: 0xe000ed34,
  BFAR: 0xe000ed38,
  /** ARMv8-M: secure and non-secure fault addresses. */
  SFSR: 0xe000ede4,
  SFAR: 0xe000ede8,
} as const;

export interface FaultWords {
  cfsr: number;
  hfsr: number;
  mmfar?: number;
  bfar?: number;
  /** Which of MMFAR/BFAR the status register says is valid. */
  mmfarValid: boolean;
  bfarValid: boolean;
}

export interface FaultFinding {
  /** The short name a firmware engineer recognizes: `IBUSERR`, `PRECISERR`. */
  code: string;
  /** One sentence: what happened. */
  summary: string;
  /** The usual cause, phrased as something to check. */
  hint: string;
}

/**
 * Decode the fault registers into findings.
 *
 * The order is deliberate: a precise bus error explains a HardFault, so it is
 * reported before the HardFault itself, which is only the escalation.
 */
export function decodeFault(words: FaultWords): FaultFinding[] {
  const findings: FaultFinding[] = [];
  const { cfsr, hfsr } = words;

  // Memory Management Fault Status (bits 0-7 of CFSR).
  if (cfsr & (1 << 0)) findings.push({ code: "IACCVIOL", summary: "the CPU tried to execute from a region marked non-executable", hint: "check the MPU region permissions and the linker script for XN attributes" });
  if (cfsr & (1 << 1)) findings.push({ code: "DACCVIOL", summary: "a data access hit an MPU-protected region", hint: "check the MPU configuration and the stack pointer for corruption" });
  if (cfsr & (1 << 3)) findings.push({ code: "MUNSTKERR", summary: "unstacking during an exception return faulted", hint: "the stack pointer is likely corrupt; check the MSP/PSP and stack size" });
  if (cfsr & (1 << 4)) findings.push({ code: "MSTKERR", summary: "stacking during exception entry faulted", hint: "the stack pointer is likely corrupt or the stack overflowed" });
  if (cfsr & (1 << 7) && words.mmfarValid) {
    findings.push({ code: "MMARVALID", summary: `the faulting address was ${hex(words.mmfar ?? 0)}`, hint: "this is the address the access tried to reach; map it against your linker script" });
  }

  // Bus Fault Status (bits 8-15).
  if (cfsr & (1 << 8)) findings.push({ code: "IBUSERR", summary: "a prefetch from an invalid address or unprogrammed flash", hint: "check for a corrupted vector table, a bad function pointer, or a flash read past the image" });
  if (cfsr & (1 << 9)) findings.push({ code: "PRECISERR", summary: "a data access faulted at a known address", hint: "usually a null or wild pointer; read BFAR for the address" });
  if (cfsr & (1 << 10)) findings.push({ code: "IMPRECISERR", summary: "a data access faulted but the address is imprecise", hint: "often a write-buffer or DMA access; enable the precise bus fault for a better address" });
  if (cfsr & (1 << 11)) findings.push({ code: "UNSTKERR", summary: "unstacking during an exception return faulted", hint: "the stack pointer is likely corrupt; check the MSP/PSP and stack size" });
  if (cfsr & (1 << 12)) findings.push({ code: "STKERR", summary: "stacking during exception entry faulted", hint: "the stack pointer is likely corrupt or the stack overflowed" });
  if (cfsr & (1 << 13)) findings.push({ code: "LSPERR", summary: "a lazy floating-point state preservation faulted", hint: "check that the FPU context region is accessible" });
  if (cfsr & (1 << 15) && words.bfarValid) {
    findings.push({ code: "BFARVALID", summary: `the faulting address was ${hex(words.bfar ?? 0)}`, hint: "this is the address the access tried to reach; often null + an offset, or a stale peripheral pointer" });
  }

  // Usage Fault (bits 16-25).
  if (cfsr & (1 << 16)) findings.push({ code: "UNDEFINSTR", summary: "the CPU hit an undefined instruction", hint: "likely a corrupted function pointer or a call through a bad vtable" });
  if (cfsr & (1 << 17)) findings.push({ code: "INVSTATE", summary: "the EPSR/T-bit was invalid for the instruction set", hint: "a corrupted function pointer, or a cortex switch without the right bit set" });
  if (cfsr & (1 << 18)) findings.push({ code: "INVPC", summary: "an exception return loaded an invalid PC", hint: "the exception stack frame was corrupted" });
  if (cfsr & (1 << 19)) findings.push({ code: "NOCP", summary: "a coprocessor instruction ran while that coprocessor was disabled", hint: "the FPU is usually not enabled; call the CMSIS FPU enable helper at startup" });
  if (cfsr & (1 << 24)) findings.push({ code: "UNALIGNED", summary: "an unaligned access ran while the trap was enabled", hint: "a packed struct or an odd pointer; check the packed types and casts" });
  if (cfsr & (1 << 25)) findings.push({ code: "DIVBYZERO", summary: "an integer division by zero ran while the trap was enabled", hint: "guard the divisor, or clear the divide-by-zero trap" });

  // HardFault status.
  if (hfsr & (1 << 1)) findings.push({ code: "VECTTBL", summary: "the exception vector table could not be read", hint: "the vector table was relocated and VTOR does not point at a valid table" });
  if (hfsr & (1 << 30)) findings.push({ code: "FORCED", summary: "the fault handler was entered because a configurable fault was escalated", hint: "the specific cause is one of the faults above; enable the corresponding handler if you want a breakpoint there" });
  if (hfsr & (1 << 31)) findings.push({ code: "DEBUGEVT", summary: "the halting debug event faulted", hint: "check the debugger configuration and whether the target was running" });

  return findings;
}

/** True when any fault status bit is set. */
export function hasFault(words: FaultWords): boolean {
  return (words.cfsr & 0x03_ff_ff_ff) !== 0 || (words.hfsr & 1 << 30) !== 0;
}

function hex(value: number): string {
  return `0x${(value >>> 0).toString(16).padStart(8, "0")}`;
}

/** Format findings for a tool result; plain sentences the model can quote. */
export function formatFault(findings: FaultFinding[], words: FaultWords): string {
  if (findings.length === 0) {
    return hasFault(words)
      ? "a fault status bit is set but no cause this decoder knows about; read CFSR/HFSR directly"
      : "no fault status is set; the target is stopped for another reason (breakpoint, watchpoint or a manual halt)";
  }
  const lines = findings.map((finding) => `- ${finding.code}: ${finding.summary}\n  check: ${finding.hint}`);
  return `CFSR=0x${words.cfsr.toString(16).padStart(8, "0")} HFSR=0x${words.hfsr.toString(16).padStart(8, "0")}\n${lines.join("\n")}`;
}

/**
 * GDB commands that read the fault registers.
 *
 * `-data-read-memory-bytes` returns hex without needing a `x/` command's output
 * grammar, which is the one MI command whose text is stable across GDB
 * versions.
 */
export function faultReadCommands(): string[] {
  return [
    `-data-read-memory-bytes ${hex(FAULT_REGISTERS.CFSR)} 4`,
    `-data-read-memory-bytes ${hex(FAULT_REGISTERS.HFSR)} 4`,
    `-data-read-memory-bytes ${hex(FAULT_REGISTERS.MMFAR)} 4`,
    `-data-read-memory-bytes ${hex(FAULT_REGISTERS.BFAR)} 4`,
  ];
}

/**
 * Parse `-data-read-memory-bytes` output.
 *
 * GDB answers `^done,memory=[{begin="0xe000ed28",offset="0x0",end="...",
 * contents="00000000"}]` with the bytes little-endian in the order they were
 * read, so a 32-bit word is reversed.
 */
export function parseMemoryBytes(body: string): number | null {
  const match = /contents="([0-9a-fA-F]+)"/.exec(body);
  if (!match) return null;
  const bytes = match[1];
  if (bytes.length < 8) return null;
  // Memory order is little-endian: the first two hex digits are the least
  // significant byte, so they go at the low end of the value.
  let value = 0;
  for (let index = 0; index < 4; index++) {
    const byte = Number.parseInt(bytes.slice(index * 2, index * 2 + 2), 16);
    if (!Number.isFinite(byte)) return null;
    value += byte * 2 ** (8 * index);
  }
  return value >>> 0;
}

/** True when CFSR's MMARVALID / BFARVALID bits say the address registers are meaningful. */
export function faultAddressValidity(cfsr: number): { mmfarValid: boolean; bfarValid: boolean } {
  return { mmfarValid: (cfsr & (1 << 7)) !== 0, bfarValid: (cfsr & (1 << 15)) !== 0 };
}
