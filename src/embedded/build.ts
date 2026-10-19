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
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs";
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
  const found: BuildArtifact[] = [];
  const seen = new Set<string>();

  const kindOf = (path: string): BuildArtifact["kind"] | null => {
    const dot = path.lastIndexOf(".");
    const ext = dot > path.lastIndexOf("/") ? path.slice(dot).toLowerCase() : "";
    if (ext === ".elf") return "elf";
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
      relative: relative(root, path).replace(/\\/g, "/"),
      bytes: size,
      kind,
    });
  };

  if (hint) add(hint);
  for (const pattern of patterns ?? []) {
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
  const buildDir = join(root, "build");
  for (const dir of [buildDir, root]) {
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
async function sizeOf(elf: string): Promise<MemoryUsage | undefined> {
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
  if (project.kind === "keil" || project.kind === "iar") {
    return empty(
      `This is a ${project.kind === "keil" ? "Keil MDK" : "IAR EWARM"} project. ` +
        `Its build is driven by a licensed Windows GUI tool this agent does not bundle; ` +
        `build it in the IDE, or add a CMake/Makefile that produces the same firmware.`,
    );
  }

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
  const parsed = parseDiagnostics(result.out);
  const collapsed = collapseCascades(parsed.diagnostics);
  const errors = collapsed.filter((entry) => entry.severity === "error").length;
  const ok = result.code === 0 && errors === 0;

  const artifacts = ok ? findArtifacts(project.root, command.artifactPatterns, command.artifactHint) : [];
  const elf = artifacts.find((artifact) => artifact.kind === "elf");
  const usage = elf ? await sizeOf(elf.path) : undefined;

  const tailLines = options.tailLines ?? 40;
  const allLines = result.out.split(/\r?\n/).filter((line) => line.trim());
  const tail = allLines.slice(-tailLines).join("\n");

  let summary = `${command.program} ${command.args.join(" ")} → ${ok ? "ok" : `failed (exit ${result.code})`}`;
  if (collapsed.length > 0) summary += `\n${summarizeDiagnostics({ diagnostics: collapsed, unparsed: parsed.unparsed })}`;
  else if (!ok) summary += `\n(the compiler printed no recognisable diagnostic; see the tail)`;
  if (usage) {
    summary += `\nimage: ${usage.flash} bytes flash, ${usage.ram} bytes RAM`;
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
