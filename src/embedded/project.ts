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

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

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
  /**
   * A CMSIS-Toolbox solution (`*.csolution.yml`) or bare project
   * (`*.cprj`), built by `cbuild` rather than by an IDE.
   */
  | "csolution"
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
  /**
   * A log the tool writes instead of stdout.
   *
   * Keil's `UV4 -b` prints nothing useful to the console; the diagnostics are
   * in the `-o` file. Parsing the file is the difference between a build that
   * reports "#20: identifier undefined" and one that reports "exit 2".
   */
  buildLog?: string;
  /**
   * Directories to search for artifacts, when the project decides where they
   * go. Keil names an `OutputDirectory` relative to its project file and the
   * default is `..\OBJ\`; a scan of the repository root finds nothing there.
   */
  artifactRoots?: string[];
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
  /**
   * The project file itself (`.uvprojx`, `.ewp`), when the ecosystem has one.
   *
   * The Keil debugger is driven per project rather than per directory: its
   * device, flash algorithm and probe configuration live in this file, so a
   * caller that wants to open a debug session needs the path, not the root.
   */
  file?: string;
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

/**
 * The `.uvprojx` to hand to `UV4 -b`.
 *
 * Keil's own convention puts the project in a subdirectory (`USER\`, `MDK-ARM\`,
 * `Project\`), not at the repository root — this was found on a real project
 * whose `.uvprojx` lives in `USER\` while the root only holds `CORE`,
 * `HALLIB`, `OBJ` and friends. So the root is searched first and then one level
 * down, which is where every Keil template puts it.
 *
 * Deterministic: same order every call, so a rebuild does not flip projects.
 */
export function keilProjectFile(root: string): string | null {
  return findProjectFile(root, /\.uvprojx?$/i);
}

/** The `.ewp` for `IarBuild`, same convention as Keil's. */
export function iarProjectFile(root: string): string | null {
  return findProjectFile(root, /\.ewp$/i);
}

/**
 * A static check of a Keil project, before anything is built.
 *
 * The build is the real test, but it costs a full compile to learn that a file
 * listed in the `.uvprojx` is not on disk — and on this project that happened
 * for real: a `remove_file` call deleted the startup assembly, and the next
 * build failed in the linker with `no section to be FIRST/LAST`, which names
 * the scatter file rather than the missing source. Reading the project takes
 * milliseconds and points at the actual entry.
 *
 * Only what the project states is checked: the files it lists, the include
 * directories it names, deleted or missing output directory, and groups with
 * no files. Nothing is guessed, and paths are reported as the project writes
 * them.
 */
export interface KeilProjectIssue {
  kind: "file" | "include" | "output";
  /** The path exactly as the project writes it. */
  path: string;
  /** What is wrong, in one line. */
  detail: string;
}

export function validateKeilProject(projectFile: string): KeilProjectIssue[] {
  const issues: KeilProjectIssue[] = [];
  let xml = "";
  try {
    xml = readFileSync(projectFile, "utf8").replace(/^﻿/, "");
  } catch {
    return [{ kind: "file", path: projectFile, detail: "the project file could not be read" }];
  }
  const dir = resolve(projectFile, "..");
  const resolveFromProject = (raw: string) => resolve(dir, raw.trim().replace(/\\/g, "/"));

  const files = [...xml.matchAll(/<FilePath>([^<]*)<\/FilePath>/g)].map((match) => match[1]);
  for (const raw of files) {
    if (!raw.trim()) continue;
    if (!existsSync(resolveFromProject(raw))) {
      issues.push({ kind: "file", path: raw, detail: "listed in the project, but not on disk" });
    }
  }

  // Include paths are per target and separated by semicolons.
  const includes = [...xml.matchAll(/<IncludePath>([^<]*)<\/IncludePath>/g)].flatMap((match) => match[1].split(";"));
  for (const raw of includes) {
    if (!raw.trim()) continue;
    if (!existsSync(resolveFromProject(raw))) {
      issues.push({ kind: "include", path: raw.trim(), detail: "an include directory that is not on disk" });
    }
  }

  const output = /<OutputDirectory>([^<]*)<\/OutputDirectory>/.exec(xml)?.[1]?.trim();
  if (output && !existsSync(resolveFromProject(output))) {
    issues.push({
      kind: "output",
      path: output,
      detail: "the output directory does not exist; uVision creates it on a build, but flashing before one will not find an image",
    });
  }

  // An empty group is legal, but one the user meant to fill is worth saying
  // out loud. Only checked when the project has files at all: an empty project
  // is a different problem.
  if (files.length > 0) {
    for (const match of xml.matchAll(/<Group>([\s\S]*?)<\/Group>/g)) {
      const body = match[1];
      const name = /<GroupName>([^<]*)<\/GroupName>/.exec(body)?.[1];
      if (name && !/<File>/.test(body)) {
        issues.push({ kind: "file", path: name, detail: "a group with no files" });
      }
    }
  }
  return issues;
}

/**
 * Where a Keil project writes its image.
 *
 * `OutputDirectory` is relative to the project file (`..\OBJ\` on the project
 * this was tested against). Falls back to the project file's own directory,
 * which is where an unmodified template puts it.
 */
export function keilOutputDirs(projectFile: string, root: string): string[] {
  const dirs: string[] = [];
  try {
    const xml = readFileSync(projectFile, "utf8").replace(/^﻿/, "");
    // Every target has its own `<OutputDirectory>`. Reading the first one meant
    // a build of the second target wrote to `OBJ_SIM\` while the artifact scan
    // only looked in `OBJ\`, so a successful build reported no image.
    for (const match of xml.matchAll(/<OutputDirectory>([^<]*)<\/OutputDirectory>/g)) {
      if (!match[1]?.trim()) continue;
      const output = match[1].trim().replace(/\\/g, "/");
      // Relative output directories resolve against the project file's
      // **directory**, not against the workspace root — that is Keil's own
      // rule. `join(projectFile, "..", output)` resolved against the file path
      // itself and produced `<dir>/USER/<dir>`.
      dirs.push(resolve(dirname(projectFile), output));
    }
  } catch {
    /* an unreadable project is reported by the build itself */
  }
  dirs.push(join(projectFile, ".."));
  dirs.push(root);
  return dirs.filter((dir, index, all) => all.indexOf(dir) === index && existsSync(dir));
}

/** A project file, at the root or one directory below it, in a stable order. */
function findProjectFile(root: string, pattern: RegExp): string | null {
  // A backup must never be opened as the project: `TOUCH.uvprojx.orig` matches
  // `*.uvprojx*` and sorts before the real file, so an edit would be written
  // into a copy that nothing builds.
  const matches = (dir: string): string[] =>
    readdirSyncSafe(dir)
      .filter((name) => pattern.test(name) && !/\.(bak|orig|backup|save|tmp)$/i.test(name))
      .sort((a, b) => a.localeCompare(b))
      .map((name) => join(dir, name));

  const atRoot = matches(root);
  if (atRoot.length > 0) return atRoot[0];

  // One level down, but not into the output directory: `OBJ\` holds the
  // generated files, and a stale copy there is not the project.
  const subdirs = readdirSyncSafe(root)
    .filter((name) => !/^(OBJ|obj|build|Build|DebugConfig|RTE|\.|node_modules)$/.test(name))
    .sort((a, b) => a.localeCompare(b));
  for (const name of subdirs) {
    const dir = join(root, name);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    const found = matches(dir);
    if (found.length > 0) return found[0];
  }
  return null;
}

function readdirSyncSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * A project file inside `start`'s own subtree, when walking up from it.
 *
 * `findProjectFile` answers for "this directory or one level below", which at
 * an ancestor of several projects means a sibling. This variant accepts only a
 * project whose directory is `start` or lies under it, so walking up cannot
 * re-point detection at a different source tree.
 */
function findProjectFileAbove(root: string, start: string, pattern: RegExp): string | null {
  const under = resolve(start);
  const candidates = [
    ...readdirSyncSafe(root)
      .filter((name) => pattern.test(name) && !/\.(bak|orig|backup|save|tmp)$/i.test(name))
      .map((name) => join(root, name)),
    ...readdirSyncSafe(root)
      .filter((name) => !/^(OBJ|obj|build|Build|DebugConfig|RTE|\.|node_modules)$/.test(name))
      .flatMap((name) => {
        const dir = join(root, name);
        try {
          if (!statSync(dir).isDirectory()) return [];
        } catch {
          return [];
        }
        return readdirSyncSafe(dir)
          .filter((entry) => pattern.test(entry) && !/\.(bak|orig|backup|save|tmp)$/i.test(entry))
          .map((entry) => join(dir, entry));
      }),
  ];
  const inside = candidates.filter((path) => insideRoot(resolve(path, ".."), under));
  return inside.sort((a, b) => a.localeCompare(b))[0] ?? null;
}

/** True when `candidate` is `root` or under it, compared as whole segments. */
function insideRoot(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
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

    // A CMSIS-Toolbox project states itself before any generic evidence does:
    // `*.csolution.yml` is the solution, `*.cprj` a single project. Both are
    // built by `cbuild`, which Keil ships in `ARM\cmsis-toolboxin`.
    // Only the directory itself: `findProjectFile` walks one level down *and*
    // this loop walks up five, so a match here picked up a `.csolution.yml`
    // from an unrelated sibling — measured, a temp directory detected the
    // solution file of a completely different temp directory. A solution file
    // names its own projects, so it only counts where it sits.
    if (readdirSyncSafe(dir).some((name) => /\.csolution\.yml$/i.test(name))) {
      return { ...finish("csolution", dir, ["csolution"]), file: join(dir, readdirSyncSafe(dir).find((name) => /\.csolution\.yml$/i.test(name))!) };
    }
    const cprj = findProjectFile(dir, /\.cprj$/i);
    if (cprj && dirname(cprj) === dir) return { ...finish("csolution", dir, ["cprj"]), file: cprj };

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
    // Keil and IAR templates put the project in a subdirectory (`USER\`,
    // `MDK-ARM\`, `Project\`). Looking only at the directory itself found
    // nothing on a real project whose root holds CORE/HALLIB/OBJ and whose
    // `.uvprojx` lives one level down.
    //
    // But the search must stay **below** `dir` on the way up: `findProjectFile`
    // also looks one level down, so at an ancestor that is the parent of
    // several projects it answers with a sibling's `.uvprojx`. Measured: a
    // directory with no project of its own was detected as a Keil project
    // pointing at another project in an unrelated tree, and `keil_project`
    // then read and edited that one. Only `start` itself may look downward —
    // that is the "run from the repository root" case the downward search is
    // for; an ancestor may only match a project that *contains* `start`.
    const vendor = dir === start ? findProjectFile(dir, /\.uvprojx?$|\.ewp$/i) : findProjectFileAbove(dir, start, /\.uvprojx?$|\.ewp$/i);
    if (vendor) {
      const name = vendor.split(/[\\/]/).pop() ?? vendor;
      const kind = /\.ewp$/i.test(vendor) ? "iar" : "keil";
      // The file path is carried on the result: a Keil debug session opens the
      // project, not the directory, and the caller should not have to repeat
      // the search to find what detection already found.
      return { ...finish(kind, dir, [dir === start ? name : `${name} (${dir})`]), file: vendor };
    }
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
    case "keil": {
      // The documented headless commands, each with its own switch:
      //
      //   -b  build the current target      -r  re-translate (rebuild)
      //   -c  clean                          -cr clean and re-translate
      //   -f  download to flash              -t  select the target
      //   -o  write the log here             -j0 no GUI, no dialogs
      //
      // `-t` matters on a multi-target project: without it uVision builds
      // whichever target was last current, which is whatever the user happened
      // to leave open — not something a build command should decide.
      const project1 = keilProjectFile(root);
      if (!project1) return null;
      // `-o` is resolved against the project file's directory, not the
      // process's working directory, and the parent must exist before UV4
      // writes anything. Both were found the hard way on a real project: a
      // relative log path produced no log at all and the build looked clean
      // while carrying no diagnostics.
      const logDir = join(root, "build");
      try {
        mkdirSync(logDir, { recursive: true });
      } catch {
        /* the build will report it */
      }
      const log = join(logDir, "keil-build.log");
      const action = options.release ? "-r" : "-b";
      const args = [action, resolve(project1), "-j0", "-o", resolve(log)];
      if (options.target) args.push("-t", options.target);
      return {
        kind: "keil",
        program: toolchains.keil ?? "UV4.exe",
        args,
        cwd: root,
        // The linker prints all four numbers in the log:
        //   Program Size: Code=31978 RO-data=18842 RW-data=108 ZI-data=2050364
        // which is more accurate than `fromelf` for a Keil image because the
        // ZI region is exactly what the linker placed.
        buildLog: log,
        // Where the image lands is the project's own `OutputDirectory`, which
        // is relative to the project file and commonly `..\OBJ\`. Scanning the
        // repository root finds nothing on a real Keil tree, so the directory
        // is read out of the project and the scan runs there.
        // The image formats the target can produce. A stray `.hex` from a
        // debugger `SAVE` is excluded by size in `findArtifactsIn`: a 377 MB
        // memory dump was being listed as a build artifact.
        artifactPatterns: ["*.axf", "*.hex", "*.bin"],
        artifactRoots: keilOutputDirs(project1, root),
      };
    }
    case "csolution": {
      // `cbuild <solution.csolution.yml>` resolves the project list, the packs
      // and the toolchain from the solution; a bare `.cprj` is built the same
      // way. `--outdir` is left at its default (`./out`), which is where the
      // images land.
      const solution = project.file ?? findProjectFile(root, /\.csolution\.yml$/i) ?? findProjectFile(root, /\.cprj$/i);
      if (!solution) return null;
      return {
        kind: "csolution",
        program: toolchains.cbuild ?? "cbuild",
        args: [solution, ...(options.release ? ["--configuration", "Release"] : [])],
        cwd: root,
        artifactPatterns: ["out/**/*.elf", "out/**/*.axf", "out/**/*.hex", "out/**/*.bin", "*.elf"],
      };
    }
    case "iar": {
      const project1 = iarProjectFile(root);
      if (!project1) return null;
      return {
        kind: "iar",
        program: toolchains.iar ?? "IarBuild.exe",
        args: [project1, "-build", options.release ? "Release" : "Debug"],
        cwd: root,
        artifactPatterns: ["**/*.out", "**/*.hex", "**/*.bin", "*.out", "*.hex", "*.bin"],
      };
    }
    default:
      return null;
  }
}
