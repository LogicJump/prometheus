/**
 * Running a project's tests, wherever its ecosystem puts them.
 *
 * "Change it, then check it still works" is the loop an agent needs to close,
 * and every embedded ecosystem expresses it differently: Zephyr has
 * `twister`, PlatformIO has `pio test`, CMake has `ctest`, ESP-IDF has
 * `idf.py test`. All of them report in a shape a human reads and a program
 * cannot, so this normalises the common output into one result object.
 *
 * Nothing here runs a GUI or a proprietary runner; the command is built from
 * the same `DetectedProject` the build step uses, so a project that builds is
 * a project that can be tested.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { DetectedProject } from "./project.ts";

export type TestFramework = "twister" | "pio" | "ctest" | "idf" | "pytest" | "unity";

export interface TestCase {
  name: string;
  suite?: string;
  status: "passed" | "failed" | "skipped";
  /** One line of failure detail, when the runner gives one. */
  message?: string;
  durationMs?: number;
}

export interface TestRunRequest {
  framework: TestFramework;
  /** Resolved executable. */
  program: string;
  /** Board or environment, when the framework needs one. */
  target?: string;
  /** Extra arguments passed through. */
  extraArgs?: string[];
  cwd: string;
}

export interface TestRunResult {
  framework: TestFramework;
  command: string;
  ok: boolean;
  cases: TestCase[];
  /** Cases the runner reported only as totals (twister does this). */
  totals?: { passed: number; failed: number; skipped: number };
  durationMs: number;
  output: string;
}

/** Build the command for a framework. */
export function testCommand(request: TestRunRequest): { program: string; args: string[] } {
  const extra = request.extraArgs ?? [];
  switch (request.framework) {
    case "twister": {
      // `twister` runs a whole test suite by default; `-T` points it at one
      // directory and `--platform` names the board.
      const args = ["-T", request.cwd, "-O", join(request.cwd, "twister-out"), "--inline-logs"];
      if (request.target) args.push("--platform", request.target);
      return { program: request.program, args: [...args, ...extra] };
    }
    case "pio": {
      const args = ["test"];
      if (request.target) args.push("-e", request.target);
      return { program: request.program, args: [...args, ...extra] };
    }
    case "ctest": {
      // `--output-on-failure` is what makes a failed case's message reach the
      // agent instead of "see Testing/Temporary/LastTest.log".
      return { program: request.program, args: ["--output-on-failure", ...extra] };
    }
    case "idf": {
      const args = ["test"];
      if (request.target) args.push("-t", request.target);
      return { program: request.program, args: [...args, ...extra] };
    }
    case "pytest":
      return { program: request.program, args: ["-q", ...extra] };
    case "unity":
      // A Unity binary is its own test runner; the program is the test binary.
      return { program: request.program, args: extra };
  }
}

/** Pick a framework from a detected project, or null when there is none. */
export function frameworkFor(project: DetectedProject): TestFramework | null {
  switch (project.kind) {
    case "zephyr":
      return "twister";
    case "platformio":
      return "pio";
    case "esp-idf":
      return "idf";
    case "cmake":
    case "make":
      return "ctest";
    default:
      return null;
  }
}

const FAIL = /(?:FAILED|FAIL|ERROR|\[  FAILED  \]|Failure|\bnot ok\b)/i;
const PASS = /(?:\bPASSED\b|\bPASS\b|\bok\b|\bOK\b|\[  PASSED  \])/;

/**
 * Parse a runner's output into cases.
 *
 * Each parser reads the one line format its runner emits; the totals are kept
 * separately because twister and idf.py often report counts rather than one
 * line per test. An unrecognised output yields an empty list and the caller
 * reports "the runner did not print recognisable results" rather than a false
 * green.
 */
export function parseTestOutput(framework: TestFramework, output: string): { cases: TestCase[]; totals?: { passed: number; failed: number; skipped: number } } {
  const cases: TestCase[] = [];
  const lines = output.split(/\r?\n/);
  switch (framework) {
    case "ctest": {
      // `Test #1: name ........***Failed    0.01 sec`
      for (const line of lines) {
        const match = /^\s*(?:Test\s+)?#?\d+:\s+(.+?)\s+\.{2,}\s*(.*)$/.exec(line);
        if (!match) continue;
        const tail = match[2];
        const status = /Failed/i.test(tail) ? "failed" : /(Not Run|Skipped)/i.test(tail) ? "skipped" : "passed";
        const duration = /([\d.]+)\s*sec/.exec(tail);
        cases.push({
          name: match[1].trim(),
          status,
          ...(duration ? { durationMs: Math.round(Number(duration[1]) * 1000) } : {}),
        });
      }
      break;
    }
    case "pio": {
      // `PASSED: name` / `FAILED: name`
      for (const line of lines) {
        const match = /^(PASSED|FAILED|IGNORED|SKIPPED):\s*(.+)$/i.exec(line.trim());
        if (!match) continue;
        const status = match[1].toUpperCase().startsWith("PASS")
          ? "passed"
          : match[1].toUpperCase().startsWith("FAIL")
            ? "failed"
            : "skipped";
        cases.push({ name: match[2].trim(), status });
      }
      break;
    }
    case "twister": {
      // `SUITE PASS - 100% [test_name]` is the per-suite summary line.
      for (const line of lines) {
        const match = /\b(SUITE|TEST)\s+(PASS|FAIL|SKIP|BLOCK)\b.*?\[([^\]]+)\]/.exec(line);
        if (!match) continue;
        cases.push({
          suite: match[1].toUpperCase() === "SUITE" ? match[3] : undefined,
          name: match[3],
          status: match[2] === "PASS" ? "passed" : match[2] === "FAIL" ? "failed" : "skipped",
        });
      }
      const summary = /(\d+)\s+of\s+(\d+)\s+tests passed/i.exec(output) ?? /(\d+) passed,\s*(\d+) failed/i.exec(output);
      if (summary && cases.length === 0) {
        return {
          cases,
          totals: /of/i.test(summary[0])
            ? { passed: Number(summary[1]), failed: Number(summary[2]) - Number(summary[1]), skipped: 0 }
            : { passed: Number(summary[1]), failed: Number(summary[2]), skipped: 0 },
        };
      }
      break;
    }
    case "idf": {
      for (const line of lines) {
        const match = /^(PASSED|FAILED|SKIPPED)[:\s]+(.+)$/i.exec(line.trim());
        if (!match) continue;
        cases.push({
          name: match[2].trim(),
          status: match[1].toUpperCase() === "PASSED" ? "passed" : match[1].toUpperCase() === "FAILED" ? "failed" : "skipped",
        });
      }
      break;
    }
    case "pytest": {
      for (const line of lines) {
        const match = /^(.+?::.+?)\s+(PASSED|FAILED|SKIPPED|ERROR)\b/.exec(line.trim());
        if (!match) continue;
        cases.push({
          name: match[1],
          status: match[2] === "PASSED" ? "passed" : match[2] === "FAILED" || match[2] === "ERROR" ? "failed" : "skipped",
        });
      }
      const summary = /(\d+) passed(?:,\s*(\d+) failed)?(?:,\s*(\d+) skipped)?/.exec(output);
      if (summary) {
        return {
          cases,
          totals: { passed: Number(summary[1]), failed: Number(summary[2] ?? 0), skipped: Number(summary[3] ?? 0) },
        };
      }
      break;
    }
    case "unity": {
      // Unity prints `Tests: 3 Failures: 1` at the end.
      for (const line of lines) {
        const summary = /Tests:\s*(\d+)\s+Failures:\s*(\d+)/.exec(line);
        if (!summary) continue;
        const total = Number(summary[1]);
        const failed = Number(summary[2]);
        return { cases, totals: { passed: total - failed, failed, skipped: 0 } };
      }
      for (const line of lines) {
        if (line.startsWith("PASS")) cases.push({ name: line.slice(4).trim(), status: "passed" });
        if (line.startsWith("FAIL")) cases.push({ name: line.slice(4).trim(), status: "failed" });
      }
      break;
    }
  }
  if (cases.length === 0) {
    // Runners that print only a summary still give the agent the one number
    // that matters; falling back to line matching beats an empty result.
    for (const line of lines) {
      if (!FAIL.test(line) && !PASS.test(line)) continue;
      cases.push({ name: line.trim().slice(0, 160), status: FAIL.test(line) ? "failed" : "passed" });
      if (cases.length >= 200) break;
    }
  }
  return { cases };
}

/** A one-line summary plus the failed cases, which is what the model needs. */
export function summarizeTests(result: TestRunResult): string {
  const failed = result.cases.filter((entry) => entry.status === "failed");
  const passed = result.cases.filter((entry) => entry.status === "passed").length;
  const skipped = result.cases.filter((entry) => entry.status === "skipped").length;
  const totals = result.totals ?? { passed, failed: failed.length, skipped };
  const head = `${result.framework}: ${totals.passed} passed, ${totals.failed} failed${totals.skipped ? `, ${totals.skipped} skipped` : ""} in ${(result.durationMs / 1000).toFixed(1)}s`;
  if (failed.length === 0) return head;
  const lines = failed.slice(0, 20).map((entry) => `  FAIL ${entry.suite ? `${entry.suite}: ` : ""}${entry.name}`);
  return `${head}\n${lines.join("\n")}`;
}

/** Where a ctest build directory usually is, for the "did they configure" check. */
export function ctestDir(cwd: string): string {
  for (const candidate of ["build", "build/debug", "build/release"]) {
    if (existsSync(join(cwd, candidate, "CTestTestfile.cmake"))) return join(cwd, candidate);
  }
  return join(cwd, "build");
}
