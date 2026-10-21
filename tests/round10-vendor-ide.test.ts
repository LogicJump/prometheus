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
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TOOLCHAIN_INFO, type ToolchainKind } from "../src/embedded/toolchain.ts";
import { buildCommand, detectProject, iarProjectFile, keilProjectFile } from "../src/embedded/project.ts";
import { parseFromelf, findArtifacts, findArtifactsIn } from "../src/embedded/build.ts";
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

test("UV4's exit code 1 means warnings, not a failed build", async () => {
  // Documented UV4 return codes, measured: 0 clean, 1 built with warnings,
  // 2 errors. A project that links with one warning has a fresh image and was
  // being reported as failed, with its artifacts thrown away.
  const { buildSucceeded } = await import("../src/embedded/build.ts");
  assert.equal(buildSucceeded("keil", 0, 0), true);
  assert.equal(buildSucceeded("keil", 1, 0), true, "warnings still produce the image");
  assert.equal(buildSucceeded("keil", 2, 0), false);
  assert.equal(buildSucceeded("keil", 1, 1), false, "an error inside the log wins");
  assert.equal(buildSucceeded("cmake", 1, 0), false, "the same code means failure elsewhere");
  assert.equal(buildSucceeded("keil", null, 0), false, "a timeout is not a build");
});

test("a Keil log is decoded by what its bytes are, not by assuming UTF-8", async () => {
  // Measured: UV4 writes its log in the ANSI code page (GBK here) and mixes
  // ASCII with GBK inside one quoted source line. Reading that as UTF-8 turned
  // every Chinese character in the context into a replacement mark.
  const { readBuildLog } = await import("../src/embedded/build.ts");
  const dir = scratch("prometheus-keil-encoding-");
  const path = join(dir, "build.log");
  try {
    writeFileSync(
      path,
      Buffer.concat([
        Buffer.from("main.c(76): error:  #29: expected an expression\r\n      int ", "latin1"),
        Buffer.from([0xe5, 0x8f, 0x98, 0xe9, 0x87, 0x8f]),
        Buffer.from(" = ;\r\n", "latin1"),
      ]),
    );
    const text = readBuildLog(path);
    assert.match(text, /expected an expression/);
    assert.ok(text.includes("变量"), "the GBK source line survives");
    assert.ok(!text.includes("�"), "nothing is replaced with a marker");

    // A log that really is UTF-8 must not be re-decoded as GBK.
    writeFileSync(path, "hello 变量\r\n", "utf8");
    assert.equal(readBuildLog(path), "hello 变量\r\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a Keil project is checked on disk before it is built", async () => {
  // A `remove_file` deleted the startup assembly on this project once, and the
  // build failed in the linker naming the scatter file. Reading the project
  // finds the entry itself.
  const { validateKeilProject } = await import("../src/embedded/project.ts");
  const dir = scratch("prometheus-keil-validate-");
  try {
    mkdirSync(join(dir, "Src"), { recursive: true });
    writeFileSync(join(dir, "Src", "main.c"), "int main(void){return 0;}\n");
    mkdirSync(join(dir, "Inc"), { recursive: true });
    const project = join(dir, "app.uvprojx");
    writeFileSync(
      project,
      [
        "<Project><Targets><Target><TargetName>App</TargetName>",
        "<TargetOption><TargetArmAds><Cads><VariousControls>",
        "<IncludePath>..\\Inc;..\\Missing</IncludePath>",
        "</VariousControls></Cads></TargetArmAds></TargetOption>",
        "<Groups>",
        "<Group><GroupName>Source</GroupName><Files>",
        "<File><FileName>main.c</FileName><FilePath>.\\Src\\main.c</FilePath></File>",
        "<File><FileName>gone.c</FileName><FilePath>.\\Src\\gone.c</FilePath></File>",
        "</Files></Group>",
        "<Group><GroupName>Empty</GroupName></Group>",
        "</Groups></Target></Targets></Project>",
      ].join(""),
    );
    const issues = validateKeilProject(project);
    const byPath = (path: string) => issues.find((issue) => issue.path.includes(path));
    assert.ok(byPath("gone.c"), "a missing source is reported");
    assert.equal(byPath("main.c"), undefined, "a present source is not");
    assert.ok(byPath("Missing"), "a missing include directory is reported");
    assert.ok(issues.some((issue) => issue.path === "Empty"), "an empty group is reported by name");
    // Paths come back as the project writes them, so the caller can act on them.
    assert.equal(byPath("gone.c")?.path, ".\\Src\\gone.c");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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

/* ---------- size, from Keil's own output ---------- */

test("the linker's Program Size line becomes flash and RAM", () => {
  // This is the line a real build writes into the log (Keil MDK 5.43, AC5):
  // flash is Code + RO-data, RAM is RW-data + ZI-data.
  const usage = parseFromelf("Program Size: Code=31978 RO-data=18842 RW-data=108 ZI-data=2050364  ");
  assert.ok(usage);
  assert.equal(usage.flash, 31978 + 18842);
  assert.equal(usage.ram, 108 + 2050364);
});

test("fromelf -z ROM Totals is the fallback when the linker line is absent", () => {
  // `fromelf --text -z` prints one row per object and a `ROM Totals` row. The
  // ROM row counts only what lives in ROM, so its ZI column is 0; the image's
  // own row is where ZI is reported. Flash is Code + RO Data either way.
  const output = [
    "      Code (inc. data)   RO Data    RW Data    ZI Data      Debug   Object Name",
    "     31978       1164      18842        108    2050364     534843   OBJ/TOUCH.axf",
    "     31978       1164      18842        108          0          0   ROM Totals for OBJ/TOUCH.axf",
  ].join("\n");
  const usage = parseFromelf(output);
  assert.ok(usage);
  assert.equal(usage.flash, 31978 + 18842);
  // The ROM Totals row is the one used, so ZI there is 0: RAM is the RW bytes
  // only. This is a fallback because it under-reports, which is why the
  // linker's own Program Size line is preferred when a build produced one.
  assert.equal(usage.ram, 108);
});

test("output without totals yields no usage rather than zeros", () => {
  // A zero would be read as "the image is empty", which is worse than a blank.
  // `--text -c` disassembles and prints no totals at all; that is the exact
  // mistake the first version made on the real project.
  assert.equal(parseFromelf("Error: cannot open file"), undefined);
  assert.equal(parseFromelf("** Section #1 '.text'\n    Size   : 31978 bytes"), undefined);
});

/* ---------- found on a real project ---------- */

test("a project in USER\ is detected from the repository root", () => {
  // The layout every Keil template uses, and the one the first version of this
  // missed: CORE/HALLIB/OBJ at the root, the project one level down.
  const root = scratch("prometheus-keil-user-");
  try {
    mkdirSync(join(root, "USER"));
    mkdirSync(join(root, "OBJ"));
    writeFileSync(join(root, "USER", "TOUCH.uvprojx"), "<Project/>");
    assert.equal(detectProject(root).kind, "keil");
    assert.equal(keilProjectFile(root), join(root, "USER", "TOUCH.uvprojx"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a stale .uvprojx in a sibling directory does not make this tree a Keil project", () => {
  const root = scratch("prometheus-not-keil-");
  try {
    writeFileSync(join(root, "main.c"), "int main(void){return 0;}");
    mkdirSync(join(root, "OBJ"));
    writeFileSync(join(root, "OBJ", "old.uvprojx"), "<Project/>");
    assert.equal(keilProjectFile(root), null, "the output directory is not searched");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("artifacts are found in the project's OutputDirectory, not just the root", () => {
  // `..\OBJ\` relative to `USER\TOUCH.uvprojx` is the real project's layout.
  const root = scratch("prometheus-keil-out-");
  try {
    mkdirSync(join(root, "USER"));
    mkdirSync(join(root, "OBJ"));
    writeFileSync(join(root, "USER", "TOUCH.uvprojx"), `<OutputDirectory>..${String.fromCharCode(92)}OBJ${String.fromCharCode(92)}</OutputDirectory>`);
    writeFileSync(join(root, "OBJ", "TOUCH.axf"), "\x7fELF rest");
    const project = detectProject(root);
    const command = buildCommand(project, { keil: "UV4.exe" });
    // Normalise separators before comparing: the path comes back with the
    // platform's own, and a trailing one.
    const normal = (dir: string) => dir.replace(/\\/g, "/").replace(/\/+$/, "");
    assert.ok(command.artifactRoots?.some((dir) => normal(dir).endsWith("OBJ")), JSON.stringify(command.artifactRoots));
    const found = findArtifactsIn(command.artifactRoots ?? [], command.artifactPatterns, undefined, root);
    assert.equal(found.length, 1);
    assert.equal(found[0].kind, "elf");
    // Reported against the workspace, so the rest of the app reads it the same.
    assert.equal(found[0].relative, "OBJ/TOUCH.axf");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the log path is absolute and its directory is created", () => {
  // UV4 resolves `-o` against the project file, and does not create the parent.
  // A relative path silently produced no log at all on the real project.
  const root = scratch("prometheus-keil-logpath-");
  try {
    mkdirSync(join(root, "USER"));
    writeFileSync(join(root, "USER", "TOUCH.uvprojx"), "<Project/>");
    const command = buildCommand(detectProject(root), { keil: "UV4.exe" });
    const index = command.args.indexOf("-o");
    const logPath = command.args[index + 1];
    assert.ok(logPath === command.buildLog);
    assert.ok(/^[A-Za-z]:/.test(logPath), "an absolute path");
    assert.ok(existsSync(join(root, "build")), "the directory exists before the build runs");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an armlink error is a diagnostic, not an unparsed line", () => {
  // The real failure: `..\OBJ\TOUCH.axf: Error: L6218E: Undefined symbol ...`
  // was ignored, so a failed link reported "0 error(s)".
  const log = [
    "compiling main.c...",
    "main.c(74): warning:  #223-D: function \"x\" declared implicitly",
    "linking...",
    `..${String.fromCharCode(92)}OBJ${String.fromCharCode(92)}TOUCH.axf: Error: L6218E: Undefined symbol undefined_symbol_x (referred from main.o).`,
    "Target not created.",
  ].join("\n");
  const parsed = parseDiagnostics(log);
  const link = parsed.diagnostics.find((entry) => entry.code === "L6218E");
  assert.ok(link, "the linker error is present");
  assert.equal(link.severity, "error");
  assert.equal(link.file, "../OBJ/TOUCH.axf");
  assert.equal(parsed.unparsed.filter((line) => /L6218E/.test(line)).length, 0, "not left unparsed");
});

test("an incremental build says its RAM figure is partial instead of quoting it", () => {
  // Keil only prints `Program Size:` when it relinks. Everything up to date
  // means the log has no size line, `fromelf` reports ZI as 0, and the honest
  // answer is "these are the initialised bytes" — not "108 bytes of RAM" for
  // an image that reserves two megabytes.
  const fromelfOnly = parseFromelf("ROM Totals for x.axf");
  assert.equal(fromelfOnly, undefined, "no totals at all rather than zeros");
  const romRow = parseFromelf(
    "     31978       1164      18842        108          0          0   ROM Totals for OBJ/TOUCH.axf",
  );
  assert.ok(romRow);
  // The parser returns what the source says; the caller marks it partial. This
  // asserts the number the partial path would carry.
  assert.equal(romRow.ram, 108);
});
