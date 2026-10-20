/**
 * Running a build and returning something the agent can act on.
 *
 * The interesting part is not spawning the command — it is what comes back.
 * A raw compiler log is hundreds of lines of banner, progress and repeats; an
 * agent that reads it spends its context on noise and often edits the wrong
 * file. So a build here returns:
 *
 *   - structured diagnostics, errors first, cascades collapsed;
 *   - the artifacts that were produced, so the next step knows what to flash;
 *   - flash/RAM usage, because "it linked" is not "it fits";
 *   - a bounded tail of the raw output, kept for the case where the parser
 *     recognised nothing and the agent needs the actual text.
 *
 * A failed build is not an exception. It is a result with `ok: false` and
 * diagnostics, because that is the loop's normal state.
 */

import { execFile } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, readdirSync, readSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { detectToolchains, tool } from "./toolchain.ts";
import { buildCommand, type BuildCommand, type DetectedProject, detectProject } from "./project.ts";
import { collapseCascades, parseDiagnostics, summarizeDiagnostics, type Diagnostic } from "./diagnostics.ts";
import { parseSize, type MemoryUsage } from "./flash.ts";
import { toolEnv } from "./toolEnv.ts";

export interface BuildOptions {
  /** Build in the target's release configuration when the ecosystem has one. */
  release?: boolean;
  /** Board or board preset, passed to the ecosystems that need one. */
  target?: string;
  /** CMake preset name. */
  preset?: string;
  /** Override the detected project root. */
  cwd?: string;
  /** Wall-clock limit. A cross-build of a large tree can take minutes. */
  timeoutMs?: number;
  /** How many raw output lines to keep for the agent. */
  tailLines?: number;
}

export interface BuildArtifact {
  path: string;
  /** Path relative to the project root, for display. */
  relative: string;
  bytes: number;
  kind: "elf" | "hex" | "bin" | "uf2";
}

export interface BuildResult {
  ok: boolean;
  project: DetectedProject;
  /** The command that ran; empty when detection failed. */
  command: string;
  exitCode: number | null;
  durationMs: number;
  diagnostics: Diagnostic[];
  /** The human-readable summary the agent reads first. */
  summary: string;
  artifacts: BuildArtifact[];
  /** Flash and RAM, when an ELF was produced and `size` is available. */
  usage?: MemoryUsage;
  /** Last N lines of raw output, for when parsing found nothing. */
  tail: string;
  /** Why the build could not even be attempted. */
  error?: string;
}

function run(program: string, args: string[], cwd: string, timeout: number): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    execFile(
      program,
      args,
      { cwd, timeout, windowsHide: true, maxBuffer: 32 * 1024 * 1024, env: toolEnv() },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
        resolve({ code, out: `${stdout ?? ""}\n${stderr ?? ""}` });
      },
    );
  });
}

/** The tool map `buildCommand` expects, keyed by toolchain kind. */
async function toolMap(): Promise<Record<string, string>> {
  const report = await detectToolchains();
  const map: Record<string, string> = {};
  for (const entry of report.tools) map[entry.kind] = entry.path;
  return map;
}

/**
 * Find what the build produced.
 *
 * Patterns are globs with a single level of `*` resolved by hand rather than a
 * glob library, because the patterns are ours and known. Newest wins: a stale
 * artifact from a previous build is the wrong thing to flash.
 *
 * The extension is not trusted. CMake's `OUTPUT_NAME` strips it, some projects
 * produce `firmware` with no suffix at all, and a `.bin` may be a full image,
 * a bootloader or a partition table. So a file with no extension is accepted
 * when its first four bytes are the ELF magic, and everything else is judged
 * by extension only for the formats that have a signature.
 */
export function findArtifacts(root: string, patterns: string[] | undefined, hint?: string): BuildArtifact[] {
  return findArtifactsIn([root], patterns, hint, root);
}

/**
 * Find the image across one or more directories.
 *
 * A Keil build writes into the project's own `OutputDirectory`, which is
 * usually a sibling of the project file rather than the workspace root. The
 * scan therefore takes the directories the project named, and every artifact's
 * `relative` path is still computed against the workspace so it reads the same
 * everywhere else in the app.
 */
export function findArtifactsIn(roots: string[], patterns: string[] | undefined, hint?: string, relativeTo = roots[0]): BuildArtifact[] {
  const found: BuildArtifact[] = [];
  const seen = new Set<string>();

  const kindOf = (path: string): BuildArtifact["kind"] | null => {
    const dot = path.lastIndexOf(".");
    const ext = dot > path.lastIndexOf("/") ? path.slice(dot).toLowerCase() : "";
    if (ext === ".elf") return "elf";
    // Keil's name for an ELF. Same file, same magic, different suffix — and
    // without this the artifact was found and then thrown away.
    if (ext === ".axf") return "elf";
    if (ext === ".out" && /iar/i.test(path)) return "elf";
    if (ext === ".hex") return "hex";
    if (ext === ".bin") return "bin";
    if (ext === ".uf2") return "uf2";
    if (ext === "") {
      // An extensionless artifact is an ELF when it starts with \x7fELF.
      try {
        const handle = openSync(path, "r");
        const header = Buffer.alloc(4);
        readSync(handle, header, 0, 4, 0);
        closeSync(handle);
        if (header[0] === 0x7f && header[1] === 0x45 && header[2] === 0x4c && header[3] === 0x46) return "elf";
      } catch {
        return null;
      }
    }
    return null;
  };

  const add = (path: string) => {
    if (seen.has(path) || !existsSync(path)) return;
    let size = 0;
    try {
      const stat = statSync(path);
      if (!stat.isFile()) return;
      size = stat.size;
    } catch {
      return;
    }
    const kind = kindOf(path);
    if (!kind) return;
    seen.add(path);
    found.push({
      path,
      relative: relative(relativeTo, path).replace(/\\/g, "/"),
      bytes: size,
      kind,
    });
  };

  if (hint) add(hint);
  for (const root of roots) for (const pattern of patterns ?? []) {
    const segments = pattern.split("/");
    let frontier = [root];
    for (const segment of segments) {
      const next: string[] = [];
      for (const dir of frontier) {
        if (segment.includes("*")) {
          const regex = new RegExp(`^${segment.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
          try {
            for (const entry of readdirSync(dir)) if (regex.test(entry)) next.push(join(dir, entry));
          } catch {
            /* unreadable directory */
          }
        } else {
          next.push(join(dir, segment));
        }
      }
      frontier = next;
    }
    for (const path of frontier) add(path);
  }

  // Patterns are conventions, and conventions get broken (an OUTPUT_NAME with no
  // suffix, a flavour directory). The scan always runs, so an ELF that a glob
  // missed is still found alongside the ones it caught.
  for (const root of roots) for (const dir of [join(root, "build"), root]) {
    if (!existsSync(dir)) continue;
    try {
      for (const entry of readdirSync(dir)) {
        const candidate = join(dir, entry);
        try {
          if (statSync(candidate).isFile()) add(candidate);
        } catch {
          /* vanished between readdir and stat */
        }
      }
    } catch {
      /* unreadable */
    }
  }

  // Newest first; an ELF beats its own hex/bin at the same timestamp because it
  // carries the debug symbols a debugger step needs.
  found.sort((a, b) => {
    const at = statSync(a.path).mtimeMs;
    const bt = statSync(b.path).mtimeMs;
    if (Math.abs(at - bt) > 500) return bt - at;
    return a.kind === "elf" ? -1 : b.kind === "elf" ? 1 : 0;
  });
  return found;
}

/**
 * Flash/RAM usage from the `size` that belongs to the ELF's own toolchain.
 *
 * Only the Arm `size` was tried, so an ESP32-C or any RISC-V part produced no
 * usage at all - the build succeeded and the one number that tells you whether
 * it fits was missing. The ELF's machine type says which toolchain built it.
 */
async function sizeOf(elf: string, keilPath?: string): Promise<MemoryUsage | undefined> {
  // A Keil build has no GNU `size` anywhere: its artifacts can only be read by
  // Keil's own `fromelf`, which lives beside `UV4.exe`.
  const armKeil = await keilSize(elf, keilPath);
  if (armKeil) return armKeil;
  const families = await sizeFamilies(elf);
  for (const family of families) {
    const sizeTool = await tool(family);
    if (!sizeTool) continue;
    const candidate = sizeTool.path.replace(/gcc(\.exe)?$/, sizeTool.path.endsWith(".exe") ? "size.exe" : "size");
    const program = existsSync(candidate) ? candidate : defaultSizeName(family);
    const result = await run(program, ["-A", elf], process.cwd(), 15_000);
    if (result.code !== 0 || !result.out.includes("section")) continue;
    const parsed = parseSize(result.out);
    if (parsed) return parsed;
  }
  // ESP-IDF's `idf.py size` reports in its own format; when the RISC-V size
  // binary is not installed, still try the plain one so a bug report has a
  // number rather than a blank.
  return undefined;
}

/**
 * Flash and RAM from `fromelf --text -c`, which ships with Keil.
 *
 * The output ends with a summary table:
 *
 *   Code (inc. data)  RO Data  RW Data  RW Zero   ROM Size  ...
 *   total             readonly  readwrite  zero
 *
 * Keil also prints the image size in a header line on newer versions, so both
 * the table and that line are read; whichever is present wins.
 */
async function keilSize(elf: string, uv4Path?: string): Promise<MemoryUsage | undefined> {
  const fromelf = fromelfFor(uv4Path);
  if (!fromelf) return undefined;
  // `-z` is the size summary. `-c` disassembles and never prints totals; the
  // first version of this called `--text -c` and silently got nothing, which
  // is why the build reported "0 bytes flash" on a real project.
  const result = await run(fromelf, ["--text", "-z", elf], process.cwd(), 30_000);
  if (result.code !== 0) return undefined;
  return parseFromelf(result.out);
}

/**
 * Flash and RAM from `fromelf --text -z`.
 *
 * The `ROM Totals` row is:
 *
 *      Code (inc. data)   RO Data    RW Data    ZI Data
 *      31978       1164      18842        108    2050364   ROM Totals for app.axf
 *
 * Flash is Code + RO Data (the two things that live in ROM). RAM is RW Data +
 * ZI Data: the initialised bytes are copied there, and ZI is reserved.
 *
 * The `Debug` column before the name is not part of the image and is ignored.
 * Column positions are not used either — the numbers are parsed by order from
 * the end, because Keil versions add and drop columns.
 */
export function parseFromelf(output: string): MemoryUsage | undefined {
  // The linker's own line is preferred when present: it carries all four
  // numbers, and its ZI figure is what the linker placed rather than what an
  // image reader infers.
  const program = /Program\s+Size:\s*Code=(\d+)\s+RO-data=(\d+)\s+RW-data=(\d+)\s+ZI-data=(\d+)/i.exec(output);
  if (program) {
    const [, code, ro, rw, zi] = program.map(Number);
    return { flash: code + ro, ram: rw + zi, sections: [] };
  }
  for (const line of output.split(/\r?\n/)) {
    if (!/ROM\s+Totals/i.test(line)) continue;
    const numbers = line
      .replace(/ROM\s+Totals.*$/i, "")
      .match(/[\d,]+/g)
      ?.map((value) => Number(value.replace(/,/g, "")))
      .filter((value) => Number.isFinite(value));
    if (!numbers || numbers.length < 5) continue;
    const [code, , roData, rwData, ziData] = numbers;
    return {
      flash: code + roData,
      ram: rwData + ziData,
      sections: [],
    };
  }
  return undefined;
}

/**
 * `fromelf.exe` from the same Keil install as `UV4.exe`.
 *
 * It is not beside `UV4.exe`. In a real MDK install (v5.43a, `G:\software\keil5`)
 * the layout is:
 *
 *   UV4\UV4.exe
 *   ARM\ARMCLANG\bin\fromelf.exe        ← AC6
 *   ARM\ARM_Compiler_5.06u7\bin\fromelf.exe  ← AC5
 *
 * so the sibling guess is the wrong one. The install root is two levels above
 * `UV4\`, and both compiler toolchains are searched under `ARM\`.
 */
function fromelfFor(uv4Path?: string): string | null {
  if (!uv4Path) return null;
  const isExe = /\.exe$/i.test(uv4Path);
  const sibling = uv4Path.replace(/UV4(\.exe)?$/i, isExe ? "fromelf.exe" : "fromelf");
  if (sibling !== uv4Path && existsSync(sibling)) return sibling;

  // <root>\UV4\UV4.exe → <root>
  const root = join(uv4Path, "..", "..");
  const candidates = [
    join(root, "ARM", "ARMCLANG", "bin", isExe ? "fromelf.exe" : "fromelf"),
    join(root, "ARM", "ARM_Compiler_5.06u7", "bin", isExe ? "fromelf.exe" : "fromelf"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  // A version we do not name: take any `ARM_Compiler_*\bin\fromelf.exe`.
  try {
    for (const entry of readdirSync(join(root, "ARM"))) {
      if (!/^ARM_Compiler_/i.test(entry)) continue;
      const candidate = join(root, "ARM", entry, "bin", isExe ? "fromelf.exe" : "fromelf");
      if (existsSync(candidate)) return candidate;
    }
  } catch {
    /* no ARM directory: not a Keil install root */
  }
  return null;
}

/** Toolchain kinds to try for an ELF, most likely first. */
async function sizeFamilies(elf: string): Promise<("gcc-arm" | "gcc-riscv")[]> {
  const machine = await elfMachine(elf);
  if (machine === 243) return ["gcc-riscv", "gcc-arm"]; // EM_RISCV
  if (machine === 40 || machine === 0) return ["gcc-arm", "gcc-riscv"]; // EM_ARM
  return ["gcc-arm", "gcc-riscv"];
}

function defaultSizeName(family: "gcc-arm" | "gcc-riscv"): string {
  return family === "gcc-riscv" ? "riscv64-unknown-elf-size" : "arm-none-eabi-size";
}

/**
 * The ELF header's e_machine field.
 *
 * Bytes 18-19, little-endian. Reading it is a dozen bytes and removes the
 * guesswork about which `size` to run.
 */
async function elfMachine(path: string): Promise<number | null> {
  try {
    const { openSync, readSync, closeSync } = await import("node:fs");
    const fd = openSync(path, "r");
    const header = Buffer.alloc(20);
    try {
      readSync(fd, header, 0, 20, 0);
    } finally {
      closeSync(fd);
    }
    if (header[0] !== 0x7f || header.toString("ascii", 1, 4) !== "ELF") return null;
    return header[18] | (header[19] << 8);
  } catch {
    return null;
  }
}

export async function build(options: BuildOptions = {}): Promise<BuildResult> {
  const started = Date.now();
  const root = options.cwd ?? process.cwd();
  const project = detectProject(root);

  const empty = (error: string): BuildResult => ({
    ok: false,
    project,
    command: "",
    exitCode: null,
    durationMs: Date.now() - started,
    diagnostics: [],
    summary: error,
    artifacts: [],
    tail: "",
    error,
  });

  if (project.kind === "unknown") {
    return empty(
      "No build system recognised here. Looked for prj.conf/west.yml (Zephyr), sdkconfig (ESP-IDF), " +
        "platformio.ini, *.ino, Cargo.toml with embedded dependencies, CMakeLists.txt, Makefile, " +
        "*.uvprojx (Keil) and *.ewp (IAR).",
    );
  }
  // Keil and IAR used to stop here with "go build it in the IDE". They no
  // longer do: `buildCommand` produces the vendor's documented batch command,
  // and whether the IDE is installed is answered by running it — a missing
  // UV4.exe fails to spawn and the error names it. Refusing before trying was
  // the whole gap this replaced.

  const command: BuildCommand | null = buildCommand(project, await toolMap(), {
    ...(options.release !== undefined ? { release: options.release } : {}),
    ...(options.target !== undefined ? { target: options.target } : {}),
    ...(options.preset !== undefined ? { preset: options.preset } : {}),
  });
  if (!command) return empty(`Detected a ${project.kind} project but have no build command for it.`);

  // A compiler with no C library compiles and then fails to link, and the error
  // names the user's code. Say what is actually wrong before running anything.
  const toolchains = await detectToolchains();
  const arm = toolchains.tools.find((entry) => entry.kind === "gcc-arm");
  if (arm && arm.complete === false) {
    return empty(`The Arm toolchain is installed but unusable: ${arm.problem}`);
  }

  const timeout = options.timeoutMs ?? 10 * 60_000;
  const result = await run(command.program, command.args, command.cwd, timeout);
  // Keil prints nothing useful on the console: its diagnostics go to the file
  // `-o` names. Read it and treat it as the output, so the same parser handles
  // both kinds of build.
  let output = result.out;
  if (command.buildLog) {
    try {
      if (existsSync(command.buildLog)) output = readFileSync(command.buildLog, "utf8");
    } catch {
      /* an unreadable log leaves the console output, which is still better */
    }
  }
  const parsed = parseDiagnostics(output);
  const collapsed = collapseCascades(parsed.diagnostics);
  const errors = collapsed.filter((entry) => entry.severity === "error").length;
  const ok = result.code === 0 && errors === 0;

  const artifacts = ok ? findArtifactsIn(command.artifactRoots ?? [project.root], command.artifactPatterns, command.artifactHint) : [];
  const elf = artifacts.find((artifact) => artifact.kind === "elf");
  // Size comes from two places and they are not equivalent:
  //
  //  - the linker's `Program Size:` line is exact, but Keil only prints it
  //    when it actually relinked. An incremental build that found everything
  //    up to date has no such line.
  //  - `fromelf --text -z` always reads the image, but its `ROM Totals` row
  //    reports ZI as 0, so RAM comes out as the RW bytes only.
  //
  // So the linker line wins when present, and `fromelf` fills in otherwise —
  // and `fromelf` on its own is marked as under-reporting RAM rather than
  // being passed off as the exact figure.
  const keilPath = toolchains.tools.find((entry) => entry.kind === "keil")?.path;
  const linked = parseFromelf(output);
  const image = elf ? await sizeOf(elf.path, keilPath) : undefined;
  const usage = linked ?? (image ? { ...image, ramExact: false } : undefined);

  const tailLines = options.tailLines ?? 40;
  const allLines = output.split(/\r?\n/).filter((line) => line.trim());
  const tail = allLines.slice(-tailLines).join("\n");

  let summary = `${command.program} ${command.args.join(" ")} → ${ok ? "ok" : `failed (exit ${result.code})`}`;
  if (collapsed.length > 0) summary += `\n${summarizeDiagnostics({ diagnostics: collapsed, unparsed: parsed.unparsed })}`;
  else if (!ok) summary += `\n(the compiler printed no recognisable diagnostic; see the tail)`;
  if (usage) {
    summary += `\nimage: ${usage.flash} bytes flash, ${usage.ram} bytes RAM`;
    if (usage.ramExact === false) {
      summary += " (RAM is the initialised bytes only: this build did not relink, so no linker size line was printed; a full rebuild reports the exact figure)";
    }
  }
  if (artifacts.length > 0) {
    summary += `\nartifacts: ${artifacts.map((artifact) => `${artifact.relative} (${artifact.bytes} B)`).join(", ")}`;
  }

  return {
    ok,
    project,
    command: `${command.program} ${command.args.join(" ")}`,
    exitCode: result.code,
    durationMs: Date.now() - started,
    diagnostics: collapsed,
    summary,
    artifacts,
    ...(usage ? { usage } : {}),
    tail,
  };
}
