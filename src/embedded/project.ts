/**
 * What kind of embedded project is this, and how do you build it?
 *
 * There is no single answer. A repository may be Zephyr (west), ESP-IDF
 * (idf.py), PlatformIO (pio), Arduino, or a hand-written CMake/Makefile
 * cross-build. Rather than ask the user, this module looks at the files that
 * each ecosystem leaves behind and returns the command that ecosystem expects.
 *
 * Detection is ordered: the most specific marker wins. A Zephyr app has a
 * `prj.conf`; an ESP-IDF project has `sdkconfig` or `CMakeLists.txt` including
 * `$ENV{IDF_PATH}`; a PlatformIO project has `platformio.ini`. A bare
 * `CMakeLists.txt` is treated as generic CMake only when nothing more specific
 * matched, because every other ecosystem also ships one.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export type ProjectKind =
  | "zephyr"
  | "esp-idf"
  | "platformio"
  | "arduino"
  | "cargo-embedded"
  | "cmake"
  | "make"
  | "keil"
  | "iar"
  | "unknown";

export interface BuildCommand {
  kind: ProjectKind;
  /** The program to run (already resolved to a path or a bare name). */
  program: string;
  args: string[];
  /** Directory to run in. */
  cwd: string;
  /** Where the final binary should be, when the ecosystem has a convention. */
  artifactHint?: string;
  /** Build outputs to look for, newest first. */
  artifactPatterns?: string[];
}

export interface DetectedProject {
  kind: ProjectKind;
  root: string;
  /** Human-readable evidence for the detection, shown in the UI. */
  evidence: string[];
  /** Build directory when one is already configured. */
  buildDir?: string;
  /** CMake presets or west boards discovered in the tree. */
  presets?: string[];
}

function readIfExists(file: string): string | null {
  try {
    return existsSync(file) ? readFileSync(file, "utf8") : null;
  } catch {
    return null;
  }
}

function has(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

/** `west boards` output is expensive; the manifest is enough to identify Zephyr. */
function zephyrEvidence(root: string): string[] {
  const evidence: string[] = [];
  if (has(join(root, "prj.conf"))) evidence.push("prj.conf");
  if (has(join(root, "west.yml"))) evidence.push("west.yml");
  if (has(join(root, "sample.yaml"))) evidence.push("sample.yaml");
  const cmake = readIfExists(join(root, "CMakeLists.txt"));
  if (cmake && /find_package\s*\(\s*Zephyr/i.test(cmake)) evidence.push("CMakeLists.txt finds Zephyr");
  return evidence;
}

function idfEvidence(root: string): string[] {
  const evidence: string[] = [];
  if (has(join(root, "sdkconfig"))) evidence.push("sdkconfig");
  if (has(join(root, "sdkconfig.defaults"))) evidence.push("sdkconfig.defaults");
  if (has(join(root, "idf_component.yml"))) evidence.push("idf_component.yml");
  const cmake = readIfExists(join(root, "CMakeLists.txt"));
  if (cmake && /IDF_PATH|idf_component_register/.test(cmake)) evidence.push("CMakeLists.txt registers IDF components");
  return evidence;
}

function platformioEvidence(root: string): string[] {
  return has(join(root, "platformio.ini")) ? ["platformio.ini"] : [];
}

function arduinoEvidence(root: string): string[] {
  const evidence: string[] = [];
  for (const name of readdirSyncSafe(root)) {
    if (name.endsWith(".ino")) evidence.push(name);
    if (name === "library.properties") evidence.push(name);
  }
  return evidence;
}

function cargoEvidence(root: string): string[] {
  const toml = readIfExists(join(root, "Cargo.toml"));
  if (!toml) return [];
  const evidence: string[] = ["Cargo.toml"];
  if (/cortex-m|embedded-hal|esp-hal|embassy|riscv-rt/i.test(toml)) evidence.push("embedded dependencies");
  // A host-only Rust project is not an embedded project.
  if (!/\[\[bin\]\]|name\s*=/i.test(toml)) return [];
  return evidence.some((item) => item === "embedded dependencies") ? evidence : [];
}

function readdirSyncSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** Detect from the given directory upward, stopping at the first strong match. */
export function detectProject(start = process.cwd()): DetectedProject {
  let dir = start;
  for (let depth = 0; depth < 5; depth++) {
    const zephyr = zephyrEvidence(dir);
    if (zephyr.length > 0) return finish("zephyr", dir, zephyr);
    const idf = idfEvidence(dir);
    if (idf.length > 0) return finish("esp-idf", dir, idf);
    const pio = platformioEvidence(dir);
    if (pio.length > 0) return finish("platformio", dir, pio);
    const cargo = cargoEvidence(dir);
    if (cargo.length > 0) return finish("cargo-embedded", dir, cargo);
    const arduino = arduinoEvidence(dir);
    if (arduino.some((name) => name.endsWith(".ino"))) return finish("arduino", dir, arduino);

    const parent = join(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  // Generic build systems only count at the starting directory, so a build run
  // from `src/` sees nothing. A project's own subtree is the common case for an
  // agent that was told to "build", so walk up for these too — a CMakeLists.txt
  // anywhere above the working directory is the build for this code.
  const ancestors: string[] = [];
  {
    let dir = start;
    for (let depth = 0; depth < 5; depth++) {
      ancestors.push(dir);
      const parent = join(dir, "..");
      if (parent === dir) break;
      dir = parent;
    }
  }
  for (const dir of ancestors) {
    if (has(join(dir, "CMakeLists.txt")) || has(join(dir, "CMakePresets.json"))) {
      return finish("cmake", dir, [dir === start ? "CMakeLists.txt" : `CMakeLists.txt (${dir})`]);
    }
    if (has(join(dir, "Makefile")) || has(join(dir, "makefile"))) {
      return finish("make", dir, [dir === start ? "Makefile" : `Makefile (${dir})`]);
    }
    const keil = readdirSyncSafe(dir).filter((name) => name.endsWith(".uvprojx") || name.endsWith(".uvproj"));
    if (keil.length > 0) return finish("keil", dir, keil);
    const iar = readdirSyncSafe(dir).filter((name) => name.endsWith(".ewp") || name.endsWith(".eww"));
    if (iar.length > 0) return finish("iar", dir, iar);
  }
  return { kind: "unknown", root: start, evidence: [] };
}

function finish(kind: ProjectKind, root: string, evidence: string[]): DetectedProject {
  const buildDir = ["build", "build-debug", "build/release", "cmake-build-debug"]
    .map((name) => join(root, name))
    .find((candidate) => existsSync(join(candidate, "CMakeCache.txt")));
  const presets: string[] = [];
  const presetsFile = readIfExists(join(root, "CMakePresets.json"));
  if (presetsFile) {
    try {
      const parsed = JSON.parse(presetsFile) as { configurePresets?: { name?: string }[] };
      for (const preset of parsed.configurePresets ?? []) if (preset.name) presets.push(preset.name);
    } catch {
      /* a malformed presets file is not a detection failure */
    }
  }
  const westFile = readIfExists(join(root, "west.yml"));
  if (westFile) {
    const match = /manifest:[\s\S]*?path:\s*(\S+)/.exec(westFile);
    if (match) presets.push(`manifest:${match[1]}`);
  }
  return { kind, root, evidence, ...(buildDir ? { buildDir } : {}), ...(presets.length ? { presets } : {}) };
}

/**
 * The build command for a detected project.
 *
 * `toolchains` is the resolved set from detectToolchains(); a project whose
 * ecosystem tool is missing gets a command pointing at the bare name anyway,
 * so the error the agent sees names the missing program instead of a generic
 * "unsupported project".
 */
export function buildCommand(
  project: DetectedProject,
  toolchains: Record<string, string>,
  options: { preset?: string; target?: string; buildDir?: string; release?: boolean } = {},
): BuildCommand | null {
  const root = project.root;
  const buildDir = options.buildDir ?? project.buildDir ?? join(root, "build");

  switch (project.kind) {
    case "zephyr": {
      // `west build` is the documented entry point; -b is required on a clean tree.
      const args = ["build", "-d", buildDir];
      if (options.target) args.push("-b", options.target);
      if (options.preset) args.push("--", `-DEXTRA_CONF_FILE=${options.preset}`);
      return {
        kind: "zephyr",
        program: toolchains.west ?? "west",
        args,
        cwd: root,
        artifactHint: join(buildDir, "zephyr", "zephyr.elf"),
        artifactPatterns: ["zephyr/zephyr.elf", "zephyr/zephyr.hex", "zephyr/zephyr.bin"],
      };
    }
    case "esp-idf": {
      const args = ["build"];
      if (options.release) args.push("-DCMAKE_BUILD_TYPE=Release");
      return {
        kind: "esp-idf",
        program: toolchains.idf ?? "idf.py",
        args,
        cwd: root,
        artifactHint: join(buildDir, "project.elf"),
        artifactPatterns: ["build/*.elf", "build/*.bin"],
      };
    }
    case "platformio": {
      // A platformio.ini with several `[env:...]` sections is common; without
      // `-e` the CLI builds the first one, which is not necessarily the one
      // the user is working on. The selected env is threaded through the same
      // `target` field that names a Zephyr board.
      const args = ["run"];
      if (options.target) args.push("-e", options.target);
      return {
        kind: "platformio",
        program: toolchains.pio ?? "pio",
        args,
        cwd: root,
        artifactHint: join(root, ".pio", "build", options.target ?? "firmware", "firmware.elf"),
        artifactPatterns: [
          ".pio/build/*/firmware.elf",
          ".pio/build/*/firmware.bin",
          ".pio/build/*/firmware.hex",
        ],
      };
    }
    case "arduino": {
      // Without --build-path the CLI writes to a temp directory that it does
      // not tell anyone about, so the .hex was simply not where the flash step
      // looked. Naming the directory makes the artifact discoverable.
      const outputDir = options.buildDir ?? join(root, "build");
      const args = ["compile", "--build-path", outputDir];
      if (options.target) args.push("--fqbn", options.target);
      args.push(root);
      return {
        kind: "arduino",
        program: toolchains["arduino-cli"] ?? "arduino-cli",
        args,
        cwd: root,
        artifactPatterns: ["build/*/*.hex", "build/*/*.bin", "build/*/*.elf"],
      };
    }
    case "cargo-embedded": {
      const args = ["build"];
      if (options.target) args.push("--target", options.target);
      if (options.release) args.push("--release");
      return {
        kind: "cargo-embedded",
        program: toolchains.cargo ?? "cargo",
        args,
        cwd: root,
        artifactPatterns: ["target/*/*/*.elf", "target/*/release/*", "target/*/debug/*"],
      };
    }
    case "cmake": {
      const cmake = toolchains.cmake ?? "cmake";
      const preset = options.preset ?? project.presets?.find((name) => !name.startsWith("manifest:"));
      if (preset) {
        return {
          kind: "cmake",
          program: cmake,
          args: ["--build", "--preset", preset],
          cwd: root,
          artifactPatterns: ["build/*.elf", "build/*.bin", "build/*.hex", "build/**/*.elf"],
        };
      }
      // No preset and no existing cache: `--build` on an unconfigured tree
      // fails with "could not load cache" and no hint that a configure step
      // is missing. Configure into the same directory first.
      const configured = existsSync(join(buildDir, "CMakeCache.txt"));
      return {
        kind: "cmake",
        program: cmake,
        args: configured ? ["--build", buildDir] : ["-S", root, "-B", buildDir],
        cwd: root,
        artifactPatterns: ["build/*.elf", "build/*.bin", "build/*.hex", "build/**/*.elf"],
      };
    }
    case "make": {
      return {
        kind: "make",
        program: toolchains.make ?? "make",
        args: options.release ? ["all", "-j"] : [],
        cwd: root,
        artifactPatterns: ["*.elf", "*.bin", "*.hex", "build/*.elf"],
      };
    }
    case "keil":
    case "iar":
      // Both are Windows-only GUIs with a CLI; they are detected so the agent
      // can say "this is a Keil project" instead of trying to run CMake.
      return null;
    default:
      return null;
  }
}
