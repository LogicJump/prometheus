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
import { packBinDirs } from "../packs/registry.ts";

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
  /**
   * A tool that answers `--version` but cannot link is worse than a missing
   * one, because detection accepts it and the failure moves to link time.
   * Homebrew's arm-none-eabi-gcc is exactly that: a compiler-only bottle with
   * no libc. `complete` is false when the toolchain itself says so.
   */
  complete?: boolean;
  /** Why it is incomplete, when it is. */
  problem?: string;
  /** Where it came from, for the settings UI. */
  source?: "path" | "install-root" | "pack";
  /** The pack that supplied it, when source is "pack". */
  packId?: string;
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

/**
 * Everything a search needs, built once.
 *
 * Previously each of the 23 specs called `extraSearchPaths()` itself, so the
 * platform directory scans (`windowsDirs()` alone walks versioned install
 * directories) ran 23 times per detection pass. Building the context once is
 * the difference between a detection that takes 40 ms and one that takes a
 * second on a machine with several toolchains installed.
 */
interface SearchContext {
  pathDirs: string[];
  /** `PROMETHEUS_TOOLCHAINS` entries first, then the platform install roots. */
  explicitDirs: string[];
  installRoots: string[];
  /** Pack bin directories per toolchain kind. */
  packDirs: Map<string, { dir: string; packId: string }[]>;
}

function buildSearchContext(): SearchContext {
  const pathDirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  const explicit = (process.env.PROMETHEUS_TOOLCHAINS ?? "")
    .split(delimiter)
    .map((value) => value.trim())
    .filter(Boolean);
  return {
    pathDirs,
    explicitDirs: explicit,
    installRoots: process.platform === "win32" ? windowsDirs() : unixDirs(),
    packDirs: packBinDirs(),
  };
}

type FoundSource = "path" | "install-root" | "pack";

/**
 * Find one tool, respecting precedence.
 *
 * Order: an explicit `PROMETHEUS_TOOLCHAINS` entry, then a pack the app itself
 * installed and validated, then a platform install root, then `PATH`. A pack
 * outranks `PATH` because it is something the app checked; `PATH` is where the
 * Homebrew compiler-with-no-libc hides.
 */
function locate(spec: Spec, context: SearchContext): { path: string; source: FoundSource; packId?: string } | null {
  const tryDirs = (dirs: string[], source: FoundSource, packId?: string) => {
    for (const dir of dirs) {
      for (const name of spec.names) {
        const candidate = join(dir, name);
        try {
          if (statSync(candidate).isFile()) return { path: candidate, source, ...(packId ? { packId } : {}) };
        } catch {
          /* not here */
        }
      }
    }
    return null;
  };

  const explicit = tryDirs(context.explicitDirs, "install-root");
  if (explicit) return explicit;

  for (const pack of context.packDirs.get(spec.kind) ?? []) {
    const hit = tryDirs([pack.dir], "pack", pack.packId);
    if (hit) return hit;
  }

  return tryDirs(context.installRoots, "install-root") ?? tryDirs(context.pathDirs, "path");
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
 * Does this Arm GCC have a C library behind it?
 *
 * `-print-file-name=libc.a` resolves to an absolute path in a complete Arm
 * install and echoes the string back when there is no libc — which is what
 * Homebrew's compiler-only bottle does. Without this check the toolchain looks
 * installed, `embed_build` runs, and the failure lands at link time as
 * `cannot find -lc`, pointing at the user's code instead of their toolchain.
 */
async function checkArmCompleteness(gccPath: string): Promise<{ complete?: boolean; problem?: string }> {
  const result = await new Promise<string>((resolve) => {
    execFile(gccPath, ["-print-file-name=libc.a"], { timeout: 8000, windowsHide: true }, (error, stdout) => {
      resolve(error ? "" : String(stdout ?? "").trim());
    });
  });
  if (!result) return {};
  // A resolved path contains a separator; a bare `libc.a` means none was found.
  if (!/[\\/]/.test(result)) {
    return {
      complete: false,
      problem:
        "this compiler has no C library (Homebrew's arm-none-eabi-gcc is built --without-headers and cannot link). " +
        "Install the Arm GNU Toolchain from developer.arm.com instead.",
    };
  }
  return { complete: true };
}

/**
 * Probe every tool once per process. `refresh` re-runs the search, which the
 * settings page uses after the user installs something.
 */
export async function detectToolchains(refresh = false): Promise<ToolchainReport> {
  if (cached && !refresh) return cached;
  // Built once: the platform scans are the expensive part and every spec needs
  // the same answer.
  const context = buildSearchContext();
  const searchPaths = [...context.explicitDirs, ...context.installRoots];
  const found: FoundTool[] = [];
  const missing: ToolchainKind[] = [];

  await Promise.all(
    SPECS.map(async (spec) => {
      const located = locate(spec, context);
      if (!located) {
        missing.push(spec.kind);
        return;
      }
      const version = await runVersion(located.path, spec.versionArgs);
      const health = spec.kind === "gcc-arm" ? await checkArmCompleteness(located.path) : {};
      found.push({
        kind: spec.kind,
        path: located.path,
        version,
        source: located.source,
        ...(located.packId ? { packId: located.packId } : {}),
        ...health,
      });
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
