/**
 * Turning compiler noise into diagnostics.
 *
 * An agent that reads raw compiler output spends its context on banner lines
 * and repeats. This module parses the formats embedded toolchains actually
 * emit into one shape:
 *
 *   GCC / Clang   file:line:col: error: message [-Wflag]
 *                 file:line: error: message
 *                 In function 'x':  (attached to the next error)
 *   Keil / ARMCC  file(line): error:  #1234-D: message
 *   IAR           file(line) : error[Pe123]: message
 *   MSVC / cl     file(line): error C2065: message
 *   Zephyr        (cmake wrappers prefix a path, sometimes with `../`)
 *
 * The parser is deliberately line-oriented and conservative: an unrecognised
 * line is ignored rather than guessed at. When a build fails and nothing
 * parses, the caller keeps the tail of the raw output, so the agent is never
 * left with an empty error.
 */

export interface Diagnostic {
  file: string;
  line: number;
  column?: number;
  severity: "error" | "warning" | "note";
  /** Compiler code such as `-Wunused-variable` or `#1234-D`. */
  code?: string;
  message: string;
  /** The enclosing function/context line when the compiler printed one. */
  context?: string;
}

export interface ParseResult {
  diagnostics: Diagnostic[];
  /** Lines that looked like diagnostics but could not be parsed. */
  unparsed: string[];
}

const GCC = /^(.+?):(\d+):(?:(\d+):)?\s*(fatal error|error|warning|note|remark):\s*(.*)$/;
const KEIL = /^(.+?)\((\d+)\):\s*(error|warning|note):\s*(?:((?:#|W|L)?\d+[-A-Z]?):\s*)?(.*)$/;
const IAR = /^(.+?)\((\d+)\)\s*:\s*(error|warning|note)\[([^\]]+)\]:\s*(.*)$/;
const MSVC = /^(.+?)\((\d+)(?:,(\d+))?\)\s*:\s*(error|warning)\s+([A-Z]+\d+):\s*(.*)$/;
/**
 * armclang and armlink, which name the output file rather than a source.
 *
 *   ..\OBJ\TOUCH.axf: Error: L6218E: Undefined symbol x (referred from main.o).
 *
 * These carry no line number: a link error is about the whole image. They were
 * ignored entirely, so a build that failed to link reported "0 errors" — the
 * most misleading thing this parser can do.
 */
const ARM_LINK = /^(.+?):\s*(Error|Warning):\s*([A-Z]+\d+[A-Z]?):\s*(.+)$/i;
// GCC prints the context after a `file: ` prefix (`main.c: In function 'main':`)
// or bare (`In function 'main':`), so the prefix is optional.
const CONTEXT = /^(?:\S+:\s*)?(In function|In file included from|At top level|from)\b.*$/;
// CSI sequences beyond SGR: `\x1b[K` (erase line) is emitted by make and ninja.
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

function cleanPath(raw: string): string {
  let path = raw.trim();
  // CMake often prefixes the absolute path with the build directory or `../`.
  path = path.replace(/^["']|["']$/g, "");
  return path.replace(/\\/g, "/");
}

function severityOf(word: string): Diagnostic["severity"] | null {
  if (/fatal error|error/i.test(word)) return "error";
  if (/warning/i.test(word)) return "warning";
  if (/note|remark/i.test(word)) return "note";
  return null;
}

/** Parse a chunk of compiler output. Never throws. */
export function parseDiagnostics(output: string): ParseResult {
  const diagnostics: Diagnostic[] = [];
  const unparsed: string[] = [];
  let pendingContext: string | undefined;

  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.replace(ANSI, "").trimEnd();
    if (!line.trim()) continue;

    if (CONTEXT.test(line)) {
      pendingContext = line.trim().slice(0, 200);
      continue;
    }

    // IAR before Keil: both use `file(line):`, but IAR names the code in brackets.
    let match = IAR.exec(line);
    if (match) {
      const severity = severityOf(match[3]);
      if (severity) {
        diagnostics.push({
          file: cleanPath(match[1]),
          line: Number(match[2]),
          severity,
          code: match[4],
          message: match[5].trim(),
          ...(pendingContext ? { context: pendingContext } : {}),
        });
        pendingContext = undefined;
        continue;
      }
    }

    match = MSVC.exec(line);
    if (match) {
      const severity = severityOf(match[4]);
      if (severity) {
        diagnostics.push({
          file: cleanPath(match[1]),
          line: Number(match[2]),
          ...(match[3] ? { column: Number(match[3]) } : {}),
          severity,
          code: match[5],
          message: match[6].trim(),
          ...(pendingContext ? { context: pendingContext } : {}),
        });
        pendingContext = undefined;
        continue;
      }
    }

    match = KEIL.exec(line);
    if (match) {
      const severity = severityOf(match[3]);
      if (severity) {
        diagnostics.push({
          file: cleanPath(match[1]),
          line: Number(match[2]),
          severity,
          ...(match[4] ? { code: match[4] } : {}),
          message: match[5].trim(),
          ...(pendingContext ? { context: pendingContext } : {}),
        });
        pendingContext = undefined;
        continue;
      }
    }

    match = GCC.exec(line);
    if (match) {
      const severity = severityOf(match[4]);
      if (severity) {
        // GCC appends `[-Wflag]` to the message; pull it out as the code.
        let message = match[5].trim();
        let code: string | undefined;
        const flag = /\s*\[(-[Ww][^\]]+)\]$/.exec(message);
        if (flag) {
          code = flag[1];
          message = message.slice(0, flag.index).trim();
        }
        diagnostics.push({
          file: cleanPath(match[1]),
          line: Number(match[2]),
          ...(match[3] ? { column: Number(match[3]) } : {}),
          severity,
          ...(code ? { code } : {}),
          message,
          ...(pendingContext ? { context: pendingContext } : {}),
        });
        pendingContext = undefined;
        continue;
      }
    }

    // armclang / armlink name the image, not a line. This is checked before
    // GCC because it is the more specific shape (`file: Error: Lxxxx:`), and
    // before the generic "error" test below, which used to swallow these into
    // `unparsed` and let a failed link report zero errors.
    match = ARM_LINK.exec(line);
    if (match) {
      const severity = severityOf(match[2]);
      if (severity) {
        diagnostics.push({
          file: cleanPath(match[1]),
          line: 0,
          severity,
          code: match[3],
          message: match[4].trim().slice(0, 400),
          ...(pendingContext ? { context: pendingContext } : {}),
        });
        pendingContext = undefined;
        continue;
      }
    }

    // Linker errors carry no location; keep the ones that are clearly errors.
    if (/undefined reference to|multiple definition of|region .* overflowed|cannot find -l/.test(line)) {
      diagnostics.push({ file: "", line: 0, severity: "error", message: line.trim().slice(0, 400) });
      continue;
    }

    if (/error|warning/i.test(line)) unparsed.push(line.trim().slice(0, 400));
  }

  return { diagnostics, unparsed };
}

/** Errors first, then warnings, then notes; stable within a severity. */
export function sortDiagnostics(diagnostics: Diagnostic[]): Diagnostic[] {
  const rank = { error: 0, warning: 1, note: 2 } as const;
  return [...diagnostics].sort((a, b) => rank[a.severity] - rank[b.severity]);
}

/**
 * The text an agent should see. Errors are listed first and capped, because a
 * single header mistake can produce hundreds of follow-on errors that all say
 * the same thing.
 */
export function summarizeDiagnostics(result: ParseResult, limit = 40): string {
  const sorted = sortDiagnostics(result.diagnostics);
  const errors = sorted.filter((entry) => entry.severity === "error");
  const warnings = sorted.filter((entry) => entry.severity === "warning");
  const shown = sorted.slice(0, limit);

  const lines: string[] = [];
  lines.push(`${errors.length} error(s), ${warnings.length} warning(s)`);
  for (const entry of shown) {
    const location = entry.file ? `${entry.file}:${entry.line}${entry.column ? `:${entry.column}` : ""}` : "(linker)";
    const code = entry.code ? ` [${entry.code}]` : "";
    lines.push(`${entry.severity}: ${location}${code} ${entry.message}`);
    if (entry.context) lines.push(`  ${entry.context}`);
  }
  if (sorted.length > limit) lines.push(`… and ${sorted.length - limit} more`);
  if (result.unparsed.length > 0 && shown.length === 0) {
    lines.push("", "Unparsed compiler output:");
    lines.push(...result.unparsed.slice(0, 20));
  }
  return lines.join("\n");
}

/** Deduplicate follow-on errors that share a message and differ only by line. */
export function collapseCascades(diagnostics: Diagnostic[], threshold = 3): Diagnostic[] {
  const byMessage = new Map<string, Diagnostic[]>();
  for (const entry of diagnostics) {
    const key = `${entry.severity}|${entry.message}`;
    const list = byMessage.get(key) ?? [];
    list.push(entry);
    byMessage.set(key, list);
  }
  const out: Diagnostic[] = [];
  for (const list of byMessage.values()) {
    if (list.length <= threshold) {
      out.push(...list);
      continue;
    }
    out.push(list[0]);
    out.push({
      file: "",
      line: 0,
      severity: list[0].severity,
      message: `… the same message appears ${list.length - 1} more times`,
    });
  }
  return out;
}
