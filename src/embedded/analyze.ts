/**
 * Finding the bugs the compiler is happy to accept.
 *
 * A cross-build that links is not a correct program: an out-of-bounds index, a
 * null dereference, an uninitialised read and a missing `volatile` all compile
 * cleanly and then fail on the board in ways that look like hardware faults.
 * This module runs the analysers that are actually installed, normalises their
 * output into the same `Diagnostic` shape the build uses, and ranks what it
 * finds.
 *
 * Each analyser reports differently — cppcheck writes XML with nested
 * locations, clang-tidy writes YAML with an offsets array, gcc's `-fanalyzer`
 * writes text — so the parsing lives here rather than in the caller.
 */

import { execFile } from "node:child_process";
import { cpus } from "node:os";
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Diagnostic } from "./diagnostics.ts";

export type AnalyzerKind = "cppcheck" | "clang-tidy";

export interface Finding extends Diagnostic {
  /** The analyser that produced it. */
  analyzer: AnalyzerKind;
  /** The analyser's own rule id, e.g. `arrayIndexOutOfBounds` or `bugprone-*`. */
  rule: string;
  /** CWE number when the analyser names one. */
  cwe?: string;
  /** Secondary locations (the assignment behind a null deref, the declaration…). */
  notes?: { file: string; line: number; message?: string }[];
}

export interface AnalysisResult {
  ok: boolean;
  findings: Finding[];
  summary: string;
  /** Analyses that were attempted and what happened. */
  ran: { analyzer: AnalyzerKind; files: number; durationMs: number; error?: string }[];
  durationMs: number;
}

// ---- cppcheck --------------------------------------------------------------

function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * cppcheck `--xml --xml-version=2`.
 *
 * Each `<error>` carries an id, a severity and one or more `<location>`
 * elements outside the C/C++ source's own naming: the first location is where
 * the problem is, the rest are supporting evidence. `file0` is the file the
 * error was reported for and may differ from the first location when the
 * problem crosses files.
 */
export function parseCppcheckXml(xml: string): Finding[] {
  const findings: Finding[] = [];
  const errors = xml.match(/<error\s[\s\S]*?<\/error>/g) ?? [];

  for (const block of errors) {
    const attrs = (name: string) => {
      const match = new RegExp(`\\b${name}="([^"]*)"`).exec(block);
      return match ? decodeEntities(match[1]) : undefined;
    };
    const id = attrs("id") ?? "unknown";
    const severityRaw = attrs("severity") ?? "style";
    // cppcheck's `style` and `performance` are advisory; `error` and
    // `warning` are the ones that predict a crash.
    const severity: Diagnostic["severity"] =
      severityRaw === "error" ? "error" : severityRaw === "warning" ? "warning" : "note";

    const locations: { file: string; line: number; column?: number; message?: string }[] = [];
    for (const location of block.match(/<location\s[^>]*\/?>/g) ?? []) {
      const file = /\bfile="([^"]*)"/.exec(location)?.[1];
      const line = Number(/\bline="(\d+)"/.exec(location)?.[1] ?? 0);
      const column = Number(/\bcolumn="(\d+)"/.exec(location)?.[1] ?? 0);
      const info = /\binfo="([^"]*)"/.exec(location)?.[1];
      if (!file || !line) continue;
      locations.push({
        file: decodeEntities(file).replace(/\\/g, "/"),
        line,
        ...(column ? { column } : {}),
        ...(info ? { message: decodeEntities(info) } : {}),
      });
    }
    if (locations.length === 0) continue;

    const [primary, ...rest] = locations;
    findings.push({
      analyzer: "cppcheck",
      file: primary.file,
      line: primary.line,
      ...(primary.column ? { column: primary.column } : {}),
      severity,
      rule: id,
      ...(attrs("cwe") ? { cwe: attrs("cwe") } : {}),
      message: attrs("msg") ?? attrs("verbose") ?? id,
      ...(rest.length
        ? { notes: rest.map((entry) => ({ file: entry.file, line: entry.line, ...(entry.message ? { message: entry.message } : {}) })) }
        : {}),
    });
  }
  return findings;
}

// ---- clang-tidy ------------------------------------------------------------

/**
 * clang-tidy's `-export-fixes` YAML.
 *
 * The format is a list of `Diagnostic:` entries under `Diagnostics:`, each with
 * a `Message`, a `Level` (`Error`/`Warning`/`Note`/`Remark`) and either
 * `FilePath`/`FileOffset` or a list of `Replacements`. Offsets are bytes from
 * the start of the file, not line numbers, so the line is resolved by the
 * caller when it has the file; here it is kept as the offset.
 */
export function parseClangTidyYaml(yaml: string): Finding[] {
  const findings: Finding[] = [];
  // Each diagnostic starts with `- DiagnosticName:` (older clang-tidy used the
  // bare key on its own line); the fields follow, indented.
  const blocks = yaml.split(/^\s*-\s+DiagnosticName:\s*/m).slice(1);
  for (const block of blocks) {
    const field = (name: string) => {
      const raw = new RegExp(`^\\s+${name}:\\s*(.+)$`, "m").exec(block)?.[1]?.trim();
      // YAML quotes strings; the quotes are not part of the value.
      return raw?.replace(/^'(.*)'$/, "$1").replace(/^"(.*)"$/, "$1");
    };
    const message = field("Message");
    if (!message) continue;
    const level = field("Level") ?? "warning";
    const severity: Diagnostic["severity"] =
      /^error$/i.test(level) ? "error" : /^warning$/i.test(level) ? "warning" : "note";

    // The checker name appears in the Message's trailing `[check-name]`, and as
    // the first line after `DiagnosticName:`.
    const diagnosticName = /^'?([\w.-]+)'?/.exec(block.trimStart())?.[1];
    const rule = /\[([\w.,-]+)\]\s*$/.exec(message)?.[1] ?? diagnosticName ?? "clang-tidy";

    const filePath = field("FilePath");
    const offset = Number(field("FileOffset") ?? -1);
    if (!filePath) continue;

    findings.push({
      analyzer: "clang-tidy",
      file: filePath.replace(/^file:\/\//, "").replace(/\\/g, "/"),
      // Offsets are byte positions; -1 means unknown. The caller that has the
      // source resolves these to lines.
      line: offset >= 0 ? offset : 0,
      severity,
      rule,
      message: message.replace(/\s*\[[\w.,-]+\]\s*$/, ""),
    });
  }
  return findings;
}

// ---- running ---------------------------------------------------------------

export interface AnalyzeOptions {
  /** Directory to analyse; defaults to the project root. */
  cwd: string;
  /** Restrict to these paths (files or directories), relative to `cwd`. */
  paths?: string[];
  /** cppcheck `--enable=` set. Default `warning,style,performance,portability`. */
  enable?: string;
  /** A compile_commands.json to use, when the project has one. */
  compileCommands?: string;
  /** How many files to analyse at most. Large trees take minutes. */
  maxFiles?: number;
  timeoutMs?: number;
}

const SOURCE_EXT = /\.(c|cc|cpp|cxx|h|hh|hpp|hxx)$/i;

function collectSources(root: string, paths: string[] | undefined, maxFiles: number): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (out.length >= maxFiles || depth > 8) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= maxFiles) return;
      // Build trees and VCS internals are noise and huge.
      if (/^(build|\.git|node_modules|\.pio|target|CMakeFiles|managed_components)$/.test(entry)) continue;
      const full = join(dir, entry);
      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) walk(full, depth + 1);
      else if (SOURCE_EXT.test(entry)) out.push(full);
    }
  };
  for (const target of paths ?? ["."]) {
    const full = join(root, target);
    if (!existsSync(full)) continue;
    if (statSync(full).isDirectory()) walk(full, 0);
    else out.push(full);
  }
  return out;
}

function run(program: string, args: string[], cwd: string, timeout: number): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile(program, args, { cwd, timeout, windowsHide: true, maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({
        code: error ? (typeof error.code === "number" ? error.code : 1) : 0,
        out: String(stdout ?? ""),
        err: String(stderr ?? ""),
      });
    });
  });
}

/**
 * Run every analyser that is present.
 *
 * cppcheck is given `--project` when a compile database exists, which is the
 * difference between "it guessed the include paths" and "it used the real
 * ones" — without it, every `#include` of a vendor header is a false positive.
 */
export async function analyze(options: AnalyzeOptions): Promise<AnalysisResult> {
  const started = Date.now();
  const cwd = options.cwd;
  const findings: Finding[] = [];
  const ran: AnalysisResult["ran"] = [];
  const timeout = options.timeoutMs ?? 180_000;
  const maxFiles = options.maxFiles ?? 400;

  const sources = collectSources(cwd, options.paths, maxFiles);
  const compileDb = options.compileCommands ?? (existsSync(join(cwd, "build", "compile_commands.json")) ? join(cwd, "build", "compile_commands.json") : null);

  const cppcheck = existsSync("C:/Program Files/Cppcheck/cppcheck.exe") ? "C:/Program Files/Cppcheck/cppcheck.exe" : "cppcheck";

  if (sources.length > 0) {
    const began = Date.now();
    // `--xml` writes findings to **stderr** (cppcheck's convention, not stdout),
    // and the exit code is 0 even when it finds errors unless --error-exitcode
    // is given. Both surprises are handled here rather than by each caller.
    const buildDir = join(cwd, "build", "cppcheck");
    const args = [
      "--enable=" + (options.enable ?? "warning,style,performance,portability"),
      "--xml",
      "--xml-version=2",
      "--quiet",
      "--inline-suppr",
      "--suppress=missingIncludeSystem",
      // Parallel analysis is the difference between 13s and 5s on 300 files.
      "-j", String(Math.max(1, Math.min(8, cpus().length))),
    ];
    // A build dir makes repeat runs incremental; it must exist first.
    if (!existsSync(buildDir)) {
      try {
        mkdirSync(buildDir, { recursive: true });
      } catch {
        /* read-only tree: incremental caching is optional */
      }
    }
    if (existsSync(buildDir)) args.push(`--cppcheck-build-dir=${buildDir}`);
    if (compileDb) args.push(`--project=${compileDb}`);
    else args.push(...sources);
    const result = await run(cppcheck, args, cwd, timeout);
    // Findings arrive on stderr; stdout is empty in practice.
    const xml = result.err.includes("<results") ? result.err : result.out;
    const parsed = xml.includes("<results") ? parseCppcheckXml(xml) : [];
    findings.push(...parsed);
    ran.push({
      analyzer: "cppcheck",
      files: sources.length,
      durationMs: Date.now() - began,
      ...(parsed.length === 0 && !xml.includes("<results") ? { error: clip(result.err, 300) } : {}),
    });
  }

  const sorted = [...findings].sort((a, b) => {
    const rank = { error: 0, warning: 1, note: 2 } as const;
    return rank[a.severity] - rank[b.severity] || a.file.localeCompare(b.file) || a.line - b.line;
  });

  const errors = sorted.filter((finding) => finding.severity === "error").length;
  const warnings = sorted.filter((finding) => finding.severity === "warning").length;
  const lines: string[] = [];
  lines.push(`${errors} error(s), ${warnings} warning(s) in ${sources.length} file(s)`);
  for (const analyzer of ran) {
    lines.push(`  ${analyzer.analyzer}: ${analyzer.files} file(s) in ${(analyzer.durationMs / 1000).toFixed(1)}s${analyzer.error ? ` — ${analyzer.error}` : ""}`);
  }
  const limit = 60;
  for (const finding of sorted.slice(0, limit)) {
    const cwe = finding.cwe ? ` [CWE-${finding.cwe}]` : "";
    lines.push(`${finding.severity}: ${finding.file}:${finding.line}${finding.column ? `:${finding.column}` : ""} ${finding.rule}${cwe} — ${finding.message}`);
    for (const note of finding.notes ?? []) lines.push(`    ${note.file}:${note.line}${note.message ? ` ${note.message}` : ""}`);
  }
  if (sorted.length > limit) lines.push(`… and ${sorted.length - limit} more`);

  return {
    ok: errors === 0,
    findings: sorted,
    summary: lines.join("\n"),
    ran,
    durationMs: Date.now() - started,
  };
}

function clip(text: string, limit: number): string {
  const trimmed = text.trim();
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit)}…`;
}

// ---- size and stack --------------------------------------------------------

/**
 * Flash and RAM headroom from a link map, which is what tells the agent
 * whether the next feature will even fit.
 *
 * `arm-none-eabi-size -A` already answers this; this reads the linker's own
 * `--print-memory-usage` output, which also gives the region limits.
 */
export function parseMemoryUsage(output: string): { region: string; used: number; total: number }[] {
  const regions: { region: string; used: number; total: number }[] = [];
  for (const line of output.split(/\r?\n/)) {
    // `FLASH: 12345 B 64 KB 18.83%` and `RAM: 4096 B 128 KB 3.13%`
    const match = /^\s*(\w+):\s+(\d+)\s*B\s+(?:of\s+)?([\d.]+)\s*([KMG]?)B/i.exec(line);
    if (!match) continue;
    const scale = match[4].toUpperCase() === "G" ? 1e9 : match[4].toUpperCase() === "M" ? 1e6 : match[4].toUpperCase() === "K" ? 1e3 : 1;
    regions.push({ region: match[1], used: Number(match[2]), total: Number(match[3]) * scale });
  }
  return regions;
}

/**
 * Worst-case stack depth from `-fstack-usage` `.su` files.
 *
 * The `.su` format is `file:line:column:function<TAB>bytes<TAB>static|dynamic
 * |bounded|unbounded`. A dynamic frame means the number is a lower bound, which
 * the caller must not present as a maximum.
 */
export function parseStackUsage(text: string): { function: string; file: string; line: number; bytes: number; kind: string }[] {
  const out: { function: string; file: string; line: number; bytes: number; kind: string }[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parts = line.split(/\t+/);
    if (parts.length < 2) continue;
    const where = /^(.*):(\d+):(\d+):(.*)$/.exec(parts[0]);
    if (!where) continue;
    out.push({
      file: where[1],
      line: Number(where[2]),
      function: where[4],
      bytes: Number(parts[1]) || 0,
      kind: parts[2] ?? "static",
    });
  }
  return out.sort((a, b) => b.bytes - a.bytes);
}
