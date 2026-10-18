/**
 * Toolchain discovery.
 *
 * Embedded work is the one place where "it compiles" depends on a dozen
 * programs the agent did not install: a cross-compiler, a build system, a
 * debug probe driver, a flasher. Rather than assume a PATH, this module
 * probes for each of them once, caches the answer for the process, and reports
 * what it found — including the version — so the agent can say "you have no
 * ARM toolchain" instead of failing with ENOENT halfway through a task.
 *
 * Everything here is read-only. Installing anything is the user's decision.
 */

import { execFile } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, delimiter } from "node:path";
import { homedir } from "node:os";

export type ToolchainKind =
  | "gcc-arm"
  | "gcc-riscv"
  | "cmake"
  | "ninja"
  | "make"
  | "west"
  | "idf"
  | "pio"
  | "arduino-cli"
  | "cargo"
  | "openocd"
  | "pyocd"
  | "probe-rs"
  | "jlink"
  | "esptool"
  | "st-flash"
  | "dfu-util"
  | "avrdude"
  | "qemu"
  | "renode"
  | "sigrok"
  | "cppcheck"
  | "clang-tidy";

export interface FoundTool {
  kind: ToolchainKind;
  /** Absolute path to the executable. */
  path: string;
  version: string;
}

export interface ToolchainReport {
  tools: FoundTool[];
  /** Kinds that were searched for and not found. */
  missing: ToolchainKind[];
  /** Extra install locations that were searched, for the settings UI. */
  searchPaths: string[];
}

interface Spec {
  kind: ToolchainKind;
  /** Candidate executable names, in preference order. */
  names: string[];
  /** Arguments that print a version. */
  versionArgs: string[];
  /** Optional extra directories (beyond PATH) to search. */
  extraDirs?: () => string[];
}

/**
 * Windows is where this matters most: vendors install into fixed directories
 * that are not always on PATH, and the xPack/winlibs layouts differ.
 */
function windowsDirs(): string[] {
  const roots = [
    process.env["ProgramFiles"],
    process.env["ProgramFiles(x86)"],
    process.env.LOCALAPPDATA,
    process.env.USERPROFILE,
    "C:\\",
  ].filter((value): value is string => Boolean(value));

  const candidates: string[] = [];
  for (const root of roots) {
    candidates.push(
      join(root, "Arm GNU Toolchain arm-none-eabi"),
      join(root, "GNU Arm Embedded Toolchain"),
      join(root, "RISC-V Embedded GCC"),
      join(root, "SEGGER", "JLink"),
      join(root, "STMicroelectronics", "STM32Cube", "STM32CubeProgrammer", "bin"),
      join(root, "xPacks"),
      join(root, "Renesas"),
    );
  }
  // The Arm toolchain installs into a versioned folder; take the newest.
  const out: string[] = [];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    out.push(candidate);
    try {
      for (const entry of readdirSync(candidate)) {
        const nested = join(candidate, entry, "bin");
        if (existsSync(nested)) out.push(nested);
        const nestedArm = join(candidate, entry);
        if (existsSync(join(nestedArm, "bin"))) out.push(join(nestedArm, "bin"));
      }
    } catch {
      /* unreadable install directory */
    }
  }
  return out;
}

function unixDirs(): string[] {
  return [
    "/usr/local/bin",
    "/usr/bin",
    "/opt/homebrew/bin",
    "/opt/local/bin",
    join(homedir(), ".local", "bin"),
    join(homedir(), ".cargo", "bin"),
    join(homedir(), ".espressif", "tools"),
    join(homedir(), ".platformio", "penv", "bin"),
  ].filter((dir) => existsSync(dir));
}

function extraSearchPaths(): string[] {
  const fromEnv = (process.env.PROMETHEUS_TOOLCHAINS ?? "")
    .split(delimiter)
    .map((value) => value.trim())
    .filter(Boolean);
  return [...fromEnv, ...(process.platform === "win32" ? windowsDirs() : unixDirs())];
}

const SPECS: Spec[] = [
  { kind: "gcc-arm", names: ["arm-none-eabi-gcc", "arm-none-eabi-gcc.exe"], versionArgs: ["--version"] },
  { kind: "gcc-riscv", names: ["riscv64-unknown-elf-gcc", "riscv32-esp-elf-gcc"], versionArgs: ["--version"] },
  { kind: "cmake", names: ["cmake", "cmake.exe"], versionArgs: ["--version"] },
  { kind: "ninja", names: ["ninja", "ninja.exe"], versionArgs: ["--version"] },
  { kind: "make", names: ["make", "make.exe", "gmake"], versionArgs: ["--version"] },
  { kind: "west", names: ["west", "west.exe"], versionArgs: ["--version"] },
  { kind: "idf", names: ["idf.py", "idf.py.exe"], versionArgs: ["--version"] },
  { kind: "pio", names: ["pio", "pio.exe", "platformio"], versionArgs: ["--version"] },
  { kind: "arduino-cli", names: ["arduino-cli", "arduino-cli.exe"], versionArgs: ["version", "--format", "json"] },
  { kind: "cargo", names: ["cargo", "cargo.exe"], versionArgs: ["--version"] },
  { kind: "openocd", names: ["openocd", "openocd.exe"], versionArgs: ["--version"] },
  { kind: "pyocd", names: ["pyocd", "pyocd.exe"], versionArgs: ["--version"] },
  { kind: "probe-rs", names: ["probe-rs", "probe-rs.exe"], versionArgs: ["--version"] },
  { kind: "jlink", names: ["JLinkExe", "JLink.exe", "JLink"], versionArgs: [] },
  { kind: "esptool", names: ["esptool.py", "esptool", "esptool.exe"], versionArgs: ["version"] },
  { kind: "st-flash", names: ["st-flash", "st-flash.exe"], versionArgs: ["--version"] },
  { kind: "dfu-util", names: ["dfu-util", "dfu-util.exe"], versionArgs: ["--version"] },
  { kind: "avrdude", names: ["avrdude", "avrdude.exe"], versionArgs: ["-?"] },
  { kind: "qemu", names: ["qemu-system-arm", "qemu-system-arm.exe"], versionArgs: ["--version"] },
  { kind: "renode", names: ["renode", "renode.exe"], versionArgs: ["--version"] },
  { kind: "sigrok", names: ["sigrok-cli", "sigrok-cli.exe"], versionArgs: ["--version"] },
  { kind: "cppcheck", names: ["cppcheck", "cppcheck.exe"], versionArgs: ["--version"] },
  { kind: "clang-tidy", names: ["clang-tidy", "clang-tidy.exe"], versionArgs: ["--version"] },
];

/** PATH first, then the extra directories; the first hit wins. */
function locate(spec: Spec): string | null {
  const dirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  const all = [...dirs, ...extraSearchPaths()];
  for (const dir of all) {
    for (const name of spec.names) {
      const candidate = join(dir, name);
      try {
        if (statSync(candidate).isFile()) return candidate;
      } catch {
        /* not here */
      }
    }
  }
  return null;
}

function firstLine(text: string): string {
  return text.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "";
}

function runVersion(path: string, args: string[]): Promise<string> {
  if (args.length === 0) return Promise.resolve("");
  return new Promise((resolve) => {
    execFile(path, args, { timeout: 6000, windowsHide: true }, (error, stdout, stderr) => {
      // Some tools print their version to stderr and exit non-zero on `--help`.
      const text = `${stdout ?? ""}\n${stderr ?? ""}`.trim();
      if (!text) return resolve(error ? "" : "");
      const line = firstLine(text);
      // Strip the executable name and keep the version-looking part.
      resolve(line.replace(/^.*?([0-9]+(\.[0-9]+)+.*)$/, "$1").slice(0, 80) || line.slice(0, 80));
    });
  });
}

let cached: ToolchainReport | null = null;

/**
 * Probe every tool once per process. `refresh` re-runs the search, which the
 * settings page uses after the user installs something.
 */
export async function detectToolchains(refresh = false): Promise<ToolchainReport> {
  if (cached && !refresh) return cached;
  const searchPaths = extraSearchPaths();
  const found: FoundTool[] = [];
  const missing: ToolchainKind[] = [];

  await Promise.all(
    SPECS.map(async (spec) => {
      const path = locate(spec);
      if (!path) {
        missing.push(spec.kind);
        return;
      }
      const version = await runVersion(path, spec.versionArgs);
      found.push({ kind: spec.kind, path, version });
    }),
  );

  found.sort((a, b) => a.kind.localeCompare(b.kind));
  missing.sort();
  cached = { tools: found, missing, searchPaths };
  return cached;
}

/** One tool by kind, or null when it is not installed. */
export async function tool(kind: ToolchainKind): Promise<FoundTool | null> {
  const report = await detectToolchains();
  return report.tools.find((entry) => entry.kind === kind) ?? null;
}

/** Test seam. */
export function resetToolchainCache(): void {
  cached = null;
}
