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

import { execFile, execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, delimiter } from "node:path";
import { homedir } from "node:os";
import { packBinDirs } from "../packs/registry.ts";

export type ToolchainKind =
  | "cbuild"
  | "cpackget"
  | "svdconv"
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
  | "keil"
  | "iar"
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

/**
 * What each tool is for, in one line, for the settings page.
 *
 * The page used to list kinds as bare identifiers (`gcc-arm`, `pyocd`), which
 * means something to the people who built this and nothing to the person who
 * installed it. A missing toolchain is only actionable if the reader knows
 * which task stops working without it, so each line names the task.
 *
 * `group` decides where it appears: a compiler is needed to build, a probe
 * tool to flash and debug, a monitor to see output. That grouping is also the
 * order in which a firmware session needs them.
 */
export const TOOLCHAIN_INFO: Record<ToolchainKind, { label: string; purpose: string; group: "build" | "flash" | "monitor" | "analyze" }> = {
  "gcc-arm": { label: "Arm GNU Toolchain", purpose: "Compiles and links firmware for Cortex-M and Cortex-A parts", group: "build" },
  "gcc-riscv": { label: "RISC-V GCC", purpose: "Compiles firmware for RISC-V cores (ESP32-C, GD32V, CH32V)", group: "build" },
  cmake: { label: "CMake", purpose: "Configures projects that ship a CMakeLists.txt", group: "build" },
  ninja: { label: "Ninja", purpose: "Fast build backend that CMake and Zephyr prefer", group: "build" },
  make: { label: "Make", purpose: "Runs Makefile projects and the generated build files", group: "build" },
  west: { label: "west", purpose: "Zephyr's build and flash front end", group: "build" },
  idf: { label: "ESP-IDF", purpose: "Builds ESP32 projects and exposes idf.py", group: "build" },
  pio: { label: "PlatformIO", purpose: "Builds platformio.ini projects across boards and frameworks", group: "build" },
  "arduino-cli": { label: "Arduino CLI", purpose: "Compiles and uploads Arduino sketches", group: "build" },
  cargo: { label: "Cargo", purpose: "Builds Rust firmware and embedded Rust crates", group: "build" },
  cbuild: {
    label: "CMSIS-Toolbox (cbuild)",
    purpose: "Builds csolution/cprj projects; ships with Keil MDK and the standalone Arm CMSIS-Toolbox",
    group: "build",
  },
  cpackget: {
    label: "cpackget",
    purpose: "Installs and removes CMSIS-Packs; the same layout the device/SVD lookup reads",
    group: "build",
  },
  svdconv: {
    label: "SVDConv",
    purpose: "Validates and converts CMSIS-SVD files, including the vendor SVDs a pack ships",
    group: "analyze",
  },
  keil: {
    label: "Keil MDK",
    purpose: "Builds .uvprojx projects headless; its compilers and device packs are licensed and are never bundled",
    group: "build",
  },
  iar: {
    label: "IAR EWARM",
    purpose: "Builds .ewp projects headless; licensed, never bundled",
    group: "build",
  },
  openocd: { label: "OpenOCD", purpose: "Debugs and flashes through many probes, and serves GDB", group: "flash" },
  pyocd: { label: "pyOCD", purpose: "Flashes and debugs Arm Cortex-M targets, with a built-in target table", group: "flash" },
  "probe-rs": { label: "probe-rs", purpose: "Flashes and debugs Rust targets through CMSIS-DAP and J-Link", group: "flash" },
  jlink: { label: "J-Link", purpose: "SEGGER's flasher and debugger for J-Link probes", group: "flash" },
  esptool: { label: "esptool", purpose: "Flashes ESP32 and ESP8266 over the serial bootloader", group: "flash" },
  "st-flash": { label: "st-flash", purpose: "Writes STM32 flash through an ST-Link", group: "flash" },
  "dfu-util": { label: "dfu-util", purpose: "Flashes parts that expose a USB DFU bootloader", group: "flash" },
  avrdude: { label: "avrdude", purpose: "Flashes AVR parts over ISP, JTAG or the bootloader", group: "flash" },
  qemu: { label: "QEMU", purpose: "Runs firmware without hardware, for tests and CI", group: "flash" },
  renode: { label: "Renode", purpose: "Simulates whole boards and peripherals", group: "flash" },
  sigrok: { label: "sigrok", purpose: "Reads logic analysers and oscilloscopes", group: "monitor" },
  cppcheck: { label: "cppcheck", purpose: "Static analysis for the bugs a clean compile still ships", group: "analyze" },
  "clang-tidy": { label: "clang-tidy", purpose: "Deeper static analysis once a compile database exists", group: "analyze" },
};

/** The order a firmware session needs these in. */
export const TOOLCHAIN_GROUPS: { id: "build" | "flash" | "monitor" | "analyze"; kinds: ToolchainKind[] }[] = (() => {
  const order: ("build" | "flash" | "monitor" | "analyze")[] = ["build", "flash", "monitor", "analyze"];
  return order.map((id) => ({
    id,
    kinds: (Object.keys(TOOLCHAIN_INFO) as ToolchainKind[]).filter((kind) => TOOLCHAIN_INFO[kind].group === id),
  }));
})();

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
  /**
   * Absolute locations to try beyond PATH and the install roots, in order.
   *
   * The vendor IDEs are the reason this exists: Keil and IAR install into
   * fixed directories that are deliberately not on PATH, because two IDEs and
   * the user's own PATH should not have to agree on a `UV4`.
   */
  paths?: string[];
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
  // Keil and IAR install wherever the user said. Keil names its own root in
  // TOOLS.INI; IAR's is under Program Files\IAR Systems.
  for (const root of keilRoots()) {
    candidates.push(join(root, "UV4"));
    // Keil bundles the CMSIS-Toolbox next to its compilers.
    candidates.push(join(root, "ARM", "cmsis-toolbox", "bin"));
  }
  for (const root of roots) {
    for (const product of ["IAR Systems", join("IAR Systems", "Embedded Workbench")]) {
      const base = join(root, product);
      if (!existsSync(base)) continue;
      try {
        for (const entry of readdirSync(base)) {
          const bin = join(base, entry, "common", "bin");
          if (existsSync(bin)) candidates.push(bin);
        }
      } catch {
        /* unreadable install directory */
      }
    }
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
  // Vendor IDEs. Detected only: neither is redistributable, and both refuse to
  // do anything useful without a licence the user installed themselves.
  {
    kind: "keil",
    names: ["UV4.exe", "UV4"],
    // `UV4 -h` would open the GUI. The executable's own file version is what
    // there is to read, so no version args are passed.
    versionArgs: [],
    paths: [
      "C:\\Keil_v5\\UV4\\UV4.exe",
      "C:\\Keil\\UV4\\UV4.exe",
      "C:\\Program Files\\Keil_v5\\UV4\\UV4.exe",
      "C:\\Program Files (x86)\\Keil_v5\\UV4\\UV4.exe",
      "C:\\Program Files\\Keil\\UV4\\UV4.exe",
    ],
  },
  {
    kind: "iar",
    names: ["IarBuild.exe", "IarBuild"],
    versionArgs: [],
    paths: [
      "C:\\Program Files\\IAR Systems\\Embedded Workbench 9.4\\common\\bin\\IarBuild.exe",
      "C:\\Program Files\\IAR Systems\\Embedded Workbench 9.3\\common\\bin\\IarBuild.exe",
      "C:\\Program Files\\IAR Systems\\Embedded Workbench 9.2\\common\\bin\\IarBuild.exe",
      "C:\\Program Files\\IAR Systems\\Embedded Workbench 9.1\\common\\bin\\IarBuild.exe",
      "C:\\Program Files\\IAR Systems\\Embedded Workbench 9.0\\common\\bin\\IarBuild.exe",
      "C:\\Program Files (x86)\\IAR Systems\\Embedded Workbench 8.5\\common\\bin\\IarBuild.exe",
      "C:\\Program Files (x86)\\IAR Systems\\Embedded Workbench 8.4\\common\\bin\\IarBuild.exe",
      "C:\\Program Files (x86)\\IAR Systems\\Embedded Workbench 8.3\\common\\bin\\IarBuild.exe",
    ],
  },
  // The CMSIS-Toolbox ships inside a Keil install (`ARM\cmsis-toolboxin`)
  // and standalone. Without these three the app could not build a csolution
  // project, install a pack, or validate an SVD — all of which the toolbox on
  // this machine can do.
  { kind: "cbuild", names: ["cbuild", "cbuild.exe"], versionArgs: ["--version"] },
  { kind: "cpackget", names: ["cpackget", "cpackget.exe"], versionArgs: ["--version"] },
  { kind: "svdconv", names: ["SVDConv", "SVDConv.exe", "svdconv", "svdconv.exe"], versionArgs: [] },
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

  // A vendor IDE's own install directory. Listed as full paths because the
  // directory name carries the product version and is not a searchable tree.
  for (const candidate of spec.paths ?? []) {
    try {
      if (statSync(candidate).isFile()) return { path: candidate, source: "install-root" };
    } catch {
      /* not installed at this version */
    }
  }

  return tryDirs(context.installRoots, "install-root") ?? tryDirs(context.pathDirs, "path");
}

/**
 * Keil roots found on this machine, beyond the fixed defaults.
 *
 * `C:\Keil_v5` is only the default. Keil writes its own install root into
 * `TOOLS.INI` next to `UV4\`, and a user who installed to `D:\software\keil5`
 * (which is a real layout, tested against) has nothing at the default path. The
 * registry is read too, because a per-user install writes there and not always
 * to the default INI location.
 *
 * Returns directories that contain `UV4\UV4.exe`, newest first is not needed:
 * one install is the normal case and the first hit wins.
 */
/** The `ARM` directories the registry names, when the keys exist. */
function keilRegistryArmDirs(): string[] {
  if (process.platform !== "win32") return [];
  if (cachedKeilRegistry) return cachedKeilRegistry;
  const dirs: string[] = [];
  for (const key of [
    "HKLM\\SOFTWARE\\WOW6432Node\\Keil\\Products\\MDK",
    "HKLM\\SOFTWARE\\Keil\\Products\\MDK",
    "HKCU\\Software\\Keil\\Products\\MDK",
  ]) {
    try {
      const out = execFileSync("reg", ["query", key, "/v", "Path"], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 4000,
        stdio: ["ignore", "pipe", "ignore"],
      });
      const match = /Path\s+REG_SZ\s+(.+)$/im.exec(out);
      if (match?.[1]?.trim()) dirs.push(match[1].trim());
    } catch {
      /* the key does not exist */
    }
  }
  cachedKeilRegistry = dirs;
  return dirs;
}

/** One registry read per process. */
let cachedKeilRegistry: string[] | null = null;

export function keilRoots(): string[] {
  const roots: string[] = [];
  const addRoot = (armDir: string) => {
    if (!armDir) return;
    const root = join(armDir.replace(/[\/]+$/, ""), "..");
    if (existsSync(join(root, "UV4", "UV4.exe"))) roots.push(root);
  };
  const fromIni = (iniPath: string) => {
    try {
      if (!existsSync(iniPath)) return;
      // INI-shaped: `PATH="G:\\software\\keil5\\ARM\\"` names the ARM
      // subdirectory, so the install root is its parent.
      const text = readFileSync(iniPath, "utf8");
      const match = /^\s*PATH\s*=\s*"([^"]+)"/im.exec(text);
      if (match?.[1]) addRoot(match[1]);
    } catch {
      /* an unreadable INI is not a failure to report */
    }
  };
  // The registry is the install that actually exists. The default locations
  // below are guesses, and on the machine this was built against the guess is
  // wrong: Keil lives in `G:\\software\\keil5`.
  for (const armDir of keilRegistryArmDirs()) {
    fromIni(join(armDir, "..", "TOOLS.INI"));
    addRoot(armDir);
  }
  const programFiles = process.env["ProgramFiles"] ?? "C:\\Program Files";
  for (const ini of [
    join(programFiles, "Keil", "TOOLS.INI"),
    join(programFiles, "Keil_v5", "TOOLS.INI"),
    "C:\\Keil",
    "C:\\Keil_v5",
  ].flatMap((entry) => (entry.toLowerCase().endsWith(".ini") ? [entry] : [join(entry, "TOOLS.INI")]))) {
    fromIni(ini);
  }
  return roots.filter((root, index, all) => all.indexOf(root) === index);
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

/**
 * The file version of a Windows executable.
 *
 * A GUI tool has no `--version` that is safe to run: `UV4 -h` opens Keil, and
 * spawning a licensed IDE to read a number is not something a detection pass
 * should do. The PE resource is the version, and reading it is a few bytes.
 */
async function fileVersion(path: string): Promise<string> {
  if (process.platform !== "win32") return "";
  return new Promise((resolve) => {
    execFile(
      "powershell",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `(Get-Item -LiteralPath ${JSON.stringify(path)}).VersionInfo.FileVersion`,
      ],
      { timeout: 8000, windowsHide: true },
      (error, stdout) => resolve(error ? "" : String(stdout ?? "").trim().slice(0, 60)),
    );
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
      const version = spec.versionArgs.length > 0
        ? await runVersion(located.path, spec.versionArgs)
        : await fileVersion(located.path);
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
