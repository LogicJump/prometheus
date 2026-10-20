/**
 * Round 10: the vendor IDEs a Keil or IAR project cannot live without.
 *
 * The reason this is not optional is the projects themselves: a Keil MDK
 * project is built by Keil's compiler against Keil's device packs and its own
 * scatter file. Substituting a GCC build is not a smaller version of the same
 * thing — it is a different binary. So the app has to find the IDE the user
 * installed, drive its documented batch build, and read its log, while never
 * shipping or bundling any of it.
 *
 * These assertions are on the parts that can be checked without a licence:
 * discovery of a fixed install path, the argument vector, the artifact suffix,
 * and the two output formats Keil produces that the rest of the pipeline has
 * to understand.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TOOLCHAIN_INFO, type ToolchainKind } from "../src/embedded/toolchain.ts";
import { buildCommand, detectProject, iarProjectFile, keilProjectFile } from "../src/embedded/project.ts";
import { parseFromelf, findArtifacts } from "../src/embedded/build.ts";
import { parseDiagnostics } from "../src/embedded/diagnostics.ts";

function scratch(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/* ---------- the tools exist as detected kinds ---------- */

test("Keil and IAR are first-class toolchain kinds with an install hint", () => {
  const kinds = Object.keys(TOOLCHAIN_INFO) as ToolchainKind[];
  assert.ok(kinds.includes("keil"));
  assert.ok(kinds.includes("iar"));
  assert.equal(TOOLCHAIN_INFO.keil.group, "build");
  assert.equal(TOOLCHAIN_INFO.iar.group, "build");
  // The label is what the settings page shows; it has to be the product's name.
  assert.match(TOOLCHAIN_INFO.keil.label, /Keil/);
  assert.match(TOOLCHAIN_INFO.iar.label, /IAR/);
  // And it must say out loud that this one is licensed, so a user does not go
  // looking for a download button that cannot exist.
  assert.match(TOOLCHAIN_INFO.keil.purpose, /never bundled|licensed/i);
});

/* ---------- the project file, not the folder ---------- */

test("the Keil project file is the .uvprojx, chosen deterministically", () => {
  const dir = scratch("prometheus-keil-file-");
  try {
    writeFileSync(join(dir, "b.uvprojx"), "<Project/>");
    writeFileSync(join(dir, "a.uvprojx"), "<Project/>");
    writeFileSync(join(dir, "notes.txt"), "x");
    assert.equal(keilProjectFile(dir), join(dir, "a.uvprojx"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an IAR workspace is not mistaken for a buildable project", () => {
  // `.eww` is the workspace; `IarBuild` takes the `.ewp`.
  const dir = scratch("prometheus-iar-file-");
  try {
    writeFileSync(join(dir, "app.eww"), "<workspace/>");
    assert.equal(iarProjectFile(dir), null);
    writeFileSync(join(dir, "app.ewp"), "<project/>");
    assert.equal(iarProjectFile(dir), join(dir, "app.ewp"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a directory with no project file yields no command rather than a bare UV4", () => {
  const dir = scratch("prometheus-keil-empty-");
  try {
    writeFileSync(join(dir, "main.c"), "int main(void){return 0;}");
    const project = { kind: "keil" as const, root: dir, evidence: ["uvprojx"] };
    assert.equal(buildCommand(project, { keil: "C:\\Keil_v5\\UV4\\UV4.exe" }), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------- the build log is where the errors are ---------- */

test("Keil's log parses through the same diagnostic reader as a compiler", () => {
  // The exact shape UV4 writes with `-o`: a banner, a build section, then the
  // tool output. The parser has always understood this line format; what was
  // missing was that nothing ever read the file it appears in.
  const log = [
    "Rebuild target 'Target 1'",
    "compiling main.c...",
    "..\\Src\\main.c(42): error:  #20: identifier \"x\" is undefined",
    "..\\Src\\main.c(50): warning:  #177-D: variable \"y\" was declared but never referenced",
    "Target not created.",
  ].join("\n");
  const parsed = parseDiagnostics(log);
  assert.equal(parsed.diagnostics.length, 2);
  assert.equal(parsed.diagnostics[0].severity, "error");
  assert.equal(parsed.diagnostics[0].line, 42);
  assert.equal(parsed.diagnostics[1].severity, "warning");
});

test("the command names the log the diagnostics come from", () => {
  const dir = scratch("prometheus-keil-log-");
  try {
    writeFileSync(join(dir, "app.uvprojx"), "<Project/>");
    const command = buildCommand(detectProject(dir), {});
    assert.ok(command.buildLog?.endsWith("keil-build.log"));
    // `-o <file>` is the switch that writes it; without it UV4 builds silently
    // and the exit code is all anyone has.
    const index = command.args.indexOf("-o");
    assert.ok(index > -1);
    assert.equal(command.args[index + 1], command.buildLog);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------- artifacts ---------- */

test("a .axf is an ELF for the artifact scan", () => {
  const dir = scratch("prometheus-axf-");
  try {
    writeFileSync(join(dir, "app.axf"), "\x7fELF rest");
    writeFileSync(join(dir, "app.hex"), ":00000001FF");
    const found = findArtifacts(dir, ["*.axf", "*.hex"]);
    assert.equal(found.find((artifact) => artifact.path.endsWith(".axf"))?.kind, "elf");
    assert.equal(found.find((artifact) => artifact.path.endsWith(".hex"))?.kind, "hex");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------- size, from Keil's own tool ---------- */

test("fromelf's totals become flash and RAM", () => {
  const output = [
    "==============================================================================",
    "Program Size:",
    "  Total RO  Size (Code + RO Data)                12345 (  12.06kB)",
    "  Total RW  Size (RW Data + ZI Data)              2345 (   2.29kB)",
    "  Total ROM Size (Code + RO Data + RW Data)      12500 (  12.21kB)",
    "==============================================================================",
  ].join("\n");
  const usage = parseFromelf(output);
  assert.ok(usage);
  assert.equal(usage.flash, 12345);
  assert.equal(usage.ram, 2345);
});

test("an older fromelf without the parenthetical sums still parses", () => {
  const usage = parseFromelf("Total RO  Size:  1000\nTotal RW  Size:  200\n");
  assert.ok(usage);
  assert.equal(usage.flash, 1000);
  assert.equal(usage.ram, 200);
});

test("output without totals yields no usage rather than zeros", () => {
  // A zero would be read as "the image is empty", which is worse than a blank.
  assert.equal(parseFromelf("Error: cannot open file"), undefined);
});
