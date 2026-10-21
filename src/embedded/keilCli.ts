/**
 * The `UV4.exe` command-line switches as explicit operations.
 *
 * The build path already runs `-b`/`-r`; these are the rest of what the
 * documented interface offers and a project workflow actually uses:
 *
 *   -c / -cr   clean, and clean-then-re-translate
 *   -f         download to flash
 *   -ep / -et  export the target(s) as a `cprj` for CMSIS-Toolbox builds
 *   -X / -X1   generate `co-arm_<target>.h` preprocessor symbol files
 *   -5         convert a µVision 4 `.uvproj` to `.uvprojx`
 *
 * Each is one headless run of UV4 with its own log, so the exit code and the
 * log are read the same way the build reads them.
 */

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { toolEnv } from "./toolEnv.ts";
import { keilProjectFile } from "./project.ts";

export type KeilCliOperation = "clean" | "clean-rebuild" | "export-cprj" | "export-cprjs" | "symbols" | "symbols-all" | "convert" | "save";

export interface KeilCliResult {
  ok: boolean;
  command: string;
  exitCode: number | null;
  /** The log's contents, which is where UV4 writes its report. */
  log: string;
  /** Files the operation should have produced, when it produces files. */
  produced: string[];
  durationMs: number;
  reason?: string;
}

const SWITCH: Record<KeilCliOperation, string> = {
  clean: "-c",
  "clean-rebuild": "-cr",
  "export-cprj": "-et",
  "export-cprjs": "-ep",
  symbols: "-X",
  "symbols-all": "-X1",
  convert: "-5",
  // Not a UV4 switch: uVision rewrites the `.uvprojx` when it exits, and that
  // is the only way an interface edit reaches the file. See `saveProject`.
  save: "",
};

/**
 * The `cprj` a `-et` run writes.
 *
 * `<projectName>.<targetName>.cprj` next to the project, with the target read
 * from the project file so the answer does not depend on which target uVision
 * last had current.
 */
export function cprjPaths(projectFile: string): string[] {
  const dir = dirname(projectFile);
  const base = (projectFile.split(/[\\/]/).pop() ?? "").replace(/\.uvprojx?$/i, "");
  const text = readFileSync(projectFile, "utf8").replace(/^﻿/, "");
  const targets = [...text.matchAll(/<TargetName>([^<]*)<\/TargetName>/g)].map((match) => match[1]).filter(Boolean);
  if (targets.length === 0) return [join(dir, `${base}.cprj`)];
  return targets.map((target) => join(dir, `${base}.${target}.cprj`));
}

/** The `co-arm_<target>.h` a `-X` run writes into the target's output folder. */
export function symbolHeaderPaths(projectFile: string): string[] {
  const dir = dirname(projectFile);
  const text = readFileSync(projectFile, "utf8").replace(/^﻿/, "");
  const output = /<OutputDirectory>([^<]*)<\/OutputDirectory>/.exec(text)?.[1] ?? ".\\";
  const outDir = join(dir, output.replace(/\\/g, "/"));
  return [...text.matchAll(/<TargetName>([^<]*)<\/TargetName>/g)]
    .map((match) => match[1])
    .filter(Boolean)
    .map((target) => join(outDir, `co-arm_${target}.h`));
}

/**
 * Write interface-made edits into the `.uvprojx`.
 *
 * `PRJ_ADD_FILE`, `PRJ_ADD_GROUP` and the option setters change uVision's
 * in-memory project and answer `SUCCESS`, but they never touch the file: a
 * clean exit, a `-b` run and a killed process all leave the `.uvprojx` exactly
 * as it was. Measured — a group's `Files` stayed empty through all three.
 *
 * uVision rewrites the project when one *opens* it, so an empty headless run
 * is what performs the save: it loads the file, writes it back, and exits.
 * The method is verified by the caller, which compares the file's bytes
 * before and after, so "saved" is never reported without evidence.
 */
async function saveProject(options: KeilCliOptions, projectFile: string, started: number): Promise<KeilCliResult> {
  const before = readFileSync(projectFile);
  const result = await new Promise<{ code: number | null; out: string }>((resolve) => {
    execFile(
      options.uv4,
      [projectFile, "-j0", "-sg"],
      { cwd: options.cwd, timeout: options.timeoutMs ?? 120_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024, env: toolEnv() },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
        resolve({ code, out: `${stdout ?? ""}${stderr ?? ""}` });
      },
    );
  });
  let changed = false;
  try {
    changed = !readFileSync(projectFile).equals(before);
  } catch {
    changed = false;
  }
  return {
    ok: result.code === 0,
    command: `${options.uv4} ${projectFile} -j0 -sg`,
    exitCode: result.code,
    log: result.out.trim(),
    produced: changed ? [projectFile] : [],
    durationMs: Date.now() - started,
    ...(changed
      ? {}
      : {
          reason:
            "the project file is unchanged after uVision opened and closed it. Interface edits live in uVision's memory until it rewrites the project, " +
            "and this run did not. Nothing was lost that was on disk, but the edit is not persisted.",
        }),
  };
}

export interface KeilCliOptions {
  /** Project directory; the `.uvprojx` is found the same way a build finds it. */
  cwd: string;
  operation: KeilCliOperation;
  /** `UV4.exe`, resolved by toolchain detection. */
  uv4: string;
  /** Target to operate on, for a multi-target project. */
  target?: string;
  /** Project file, when the caller already knows it. */
  project?: string;
  timeoutMs?: number;
}

export async function keilCli(options: KeilCliOptions): Promise<KeilCliResult> {
  const started = Date.now();
  const projectFile = options.project ?? keilProjectFile(options.cwd);
  if (!projectFile || !existsSync(projectFile)) {
    return { ok: false, command: "", exitCode: null, log: "", produced: [], durationMs: 0, reason: "no .uvprojx in this workspace" };
  }
  if (!existsSync(options.uv4)) {
    return { ok: false, command: "", exitCode: null, log: "", produced: [], durationMs: 0, reason: `UV4.exe was not found at ${options.uv4}` };
  }
  if (options.operation === "save") return saveProject(options, projectFile, started);
  const logDir = join(options.cwd, "build");
  try {
    mkdirSync(logDir, { recursive: true });
  } catch {
    /* the run reports it */
  }
  const log = join(logDir, `keil-${options.operation}.log`);
  // `-5` takes only `-l`, not `-o`; every other operation writes its report
  // to `-o`.
  // `-sg` keeps uVision from reading and rewriting the per-user GUI layout
  // files (`*.uvguix.*`), which a batch run should never touch.
  const command: string[] = [SWITCH[options.operation], projectFile, "-j0", "-sg"];
  if (options.operation === "convert") command.push("-l", log);
  else command.push("-o", log);
  if (options.target) command.push("-t", options.target);

  const result = await new Promise<{ code: number | null; out: string }>((resolve) => {
    execFile(
      options.uv4,
      command,
      { cwd: options.cwd, timeout: options.timeoutMs ?? 10 * 60_000, windowsHide: true, maxBuffer: 32 * 1024 * 1024, env: toolEnv() },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
        resolve({ code, out: `${stdout ?? ""}\n${stderr ?? ""}` });
      },
    );
  });

  let report = result.out;
  try {
    if (existsSync(log)) report = readFileSync(log, "utf8");
  } catch {
    /* the console output is all there is */
  }

  // What the operation should have produced, checked rather than assumed.
  // `-5` converts `X.uvproj` into `X.uvprojx`; when the project already *is*
  // a `.uvprojx` there is nothing to convert and the "expected" path was the
  // input itself, which always exists — so the check passed on a run that
  // exited 20 having done nothing.
  const expected =
    options.operation === "export-cprj" || options.operation === "export-cprjs"
      ? cprjPaths(projectFile)
      : options.operation === "symbols" || options.operation === "symbols-all"
        ? symbolHeaderPaths(projectFile)
        : options.operation === "convert" && /\.uvproj$/i.test(projectFile)
          ? [projectFile.replace(/\.uvproj$/i, ".uvprojx")]
          : [];
  const produced = expected.filter((path) => existsSync(path));

  // UV4 exits 0 even when an export writes nothing, so an operation that is
  // supposed to produce a file is only successful when the file is there.
  // Measured: `-et` on this project printed nothing, exited 0 and produced no
  // `.cprj`; reporting that as success would be exactly the false completion
  // this project is trying to avoid.
  const shouldProduce = expected.length > 0;
  // `-5` on a project that is already `.uvprojx` has nothing to do; UV4 exits
  // 20 ("cannot convert") for it, which is a refusal of the request rather
  // than a failure of the tool.
  const alreadyConverted = options.operation === "convert" && !/\.uvproj$/i.test(projectFile);
  const ok = alreadyConverted ? true : (result.code === 0 || result.code === 1) && (!shouldProduce || produced.length > 0);
  return {
    ok,
    command: `${options.uv4} ${command.join(" ")}`,
    exitCode: result.code,
    log: report.trim(),
    produced,
    durationMs: Date.now() - started,
    ...(ok
      ? alreadyConverted
        ? { reason: `${projectFile} is already a .uvprojx; there was nothing to convert` }
        : {}
      : shouldProduce
        ? { reason: `UV4 exited ${result.code} but wrote none of: ${expected.join(", ")}` }
        : {
          reason:
            result.code === 11
              ? "cannot open the project file for writing"
              : result.code === 13
                ? "error writing the project file"
                : result.code === 12
                  ? "the device named in the project is not in the database"
                  : result.code === 20
                    ? "the .uvproj could not be converted"
                    : `UV4 exited with ${result.code}`,
        }),
  };
}
