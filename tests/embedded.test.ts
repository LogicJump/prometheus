/**
 * The embedded adapters, tested against fixtures rather than a live toolchain,
 * so the suite passes on a machine with nothing installed.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseDiagnostics, sortDiagnostics, summarizeDiagnostics, collapseCascades } from "../src/embedded/diagnostics.ts";
import { detectProject, buildCommand } from "../src/embedded/project.ts";

function scratch(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

// ---- diagnostics -----------------------------------------------------------

const GCC_OUTPUT = `
main.c: In function 'main':
main.c:7:14: error: 'y' undeclared (first use in this function)
main.c:6:7: warning: unused variable 'unused' [-Wunused-variable]
main.c:8:1: warning: control reaches end of non-void function [-Wreturn-type]
main.c:7:14: note: each undeclared identifier is reported only once
make[2]: *** [CMakeFiles/app.dir/build.make:76: CMakeFiles/app.dir/main.c.obj] Error 1
/usr/lib/gcc/arm-none-eabi/14.2.1/../../../../arm-none-eabi/bin/ld: app.elf: undefined reference to 'HAL_Init'
`;

test("GCC diagnostics keep file, line, column, severity and the warning flag", () => {
  const { diagnostics } = parseDiagnostics(GCC_OUTPUT);
  const error = diagnostics.find((entry) => entry.severity === "error" && entry.file === "main.c");
  assert.ok(error, "the undeclared-identifier error is parsed");
  assert.equal(error.line, 7);
  assert.equal(error.column, 14);
  assert.match(error.message, /undeclared/);

  const unused = diagnostics.find((entry) => entry.code === "-Wunused-variable");
  assert.ok(unused, "the warning flag becomes the code");
  assert.equal(unused.line, 6);
  // The flag is pulled out of the message, not left in it.
  assert.equal(unused.message.includes("[-Wunused-variable]"), false);

  // `In function 'main':` attaches to the diagnostic that follows it.
  assert.match(String(error.context), /In function 'main'/);
});

test("linker errors survive with no location", () => {
  const { diagnostics } = parseDiagnostics(GCC_OUTPUT);
  const linker = diagnostics.find((entry) => entry.file === "" && /undefined reference/.test(entry.message));
  assert.ok(linker, "an undefined reference is a diagnostic even without a file");
  assert.equal(linker.severity, "error");
});

test("Keil, IAR and MSVC formats each parse", () => {
  const keil = parseDiagnostics("..\\Src\\main.c(42): error:  #20: identifier \"x\" is undefined").diagnostics;
  assert.equal(keil.length, 1);
  assert.equal(keil[0].file, "../Src/main.c");
  assert.equal(keil[0].line, 42);
  assert.equal(keil[0].code, "#20");

  const iar = parseDiagnostics("src/main.c(17) : error[Pe020]: identifier \"foo\" is undefined").diagnostics;
  assert.equal(iar.length, 1);
  assert.equal(iar[0].line, 17);
  assert.equal(iar[0].code, "Pe020");

  const msvc = parseDiagnostics("src\\main.c(9,5): error C2065: 'x': undeclared identifier").diagnostics;
  assert.equal(msvc.length, 1);
  assert.equal(msvc[0].column, 5);
  assert.equal(msvc[0].code, "C2065");
});

test("ANSI colour codes do not defeat the parser", () => {
  const coloured = "\x1b[01m\x1b[Kmain.c:3:5:\x1b[m\x1b[K \x1b[01;31m\x1b[Kerror: \x1b[m\x1b[Kboom";
  const { diagnostics } = parseDiagnostics(coloured);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].line, 3);
  assert.match(diagnostics[0].message, /boom/);
});

test("errors sort ahead of warnings, and the summary leads with the count", () => {
  const result = parseDiagnostics(GCC_OUTPUT);
  const sorted = sortDiagnostics(result.diagnostics);
  assert.equal(sorted[0].severity, "error");

  const summary = summarizeDiagnostics(result);
  assert.match(summary, /^2 error\(s\), 2 warning\(s\)/);
  // The first listed line is an error.
  assert.match(summary.split("\n")[1], /^error:/);
});

test("a header mistake that floods the build collapses to one line", () => {
  const flood = Array.from({ length: 60 }, (_, index) => `a.c:${index + 1}:5: error: unknown type name 'foo_t'`).join("\n");
  const { diagnostics } = parseDiagnostics(flood);
  const collapsed = collapseCascades(diagnostics, 3);
  assert.ok(collapsed.length < diagnostics.length);
  assert.match(collapsed[collapsed.length - 1].message, /the same message appears \d+ more times/);
});

test("garbage in produces empty diagnostics, not an exception", () => {
  const result = parseDiagnostics("just some text\nand more text");
  assert.equal(result.diagnostics.length, 0);
  assert.doesNotThrow(() => summarizeDiagnostics(result));
});

// ---- project detection -----------------------------------------------------

test("Zephyr is detected and builds through west", () => {
  const root = scratch("prometheus-zephyr-");
  writeFileSync(join(root, "prj.conf"), "CONFIG_GPIO=y\n");
  writeFileSync(join(root, "CMakeLists.txt"), "find_package(Zephyr REQUIRED HINTS $ENV{ZEPHYR_BASE})\n");

  const project = detectProject(root);
  assert.equal(project.kind, "zephyr");
  assert.ok(project.evidence.includes("prj.conf"));

  const command = buildCommand(project, { west: "C:/west.exe" }, { target: "nucleo_f411re" });
  assert.ok(command);
  assert.equal(command.program, "C:/west.exe");
  assert.deepEqual(command.args.slice(0, 2), ["build", "-d"]);
  assert.ok(command.args.includes("-b"));
  assert.ok(command.args.includes("nucleo_f411re"));
  assert.match(String(command.artifactHint), /zephyr\.elf$/);
});

test("ESP-IDF and PlatformIO are distinguished from a bare CMake tree", () => {
  const idf = scratch("prometheus-idf-");
  writeFileSync(join(idf, "sdkconfig"), "CONFIG_IDF_TARGET=\"esp32s3\"\n");
  writeFileSync(join(idf, "CMakeLists.txt"), "include($ENV{IDF_PATH}/tools/cmake/project.cmake)\n");
  assert.equal(detectProject(idf).kind, "esp-idf");

  const pio = scratch("prometheus-pio-");
  writeFileSync(join(pio, "platformio.ini"), "[env:nucleo_f411re]\nplatform = ststm32\n");
  assert.equal(detectProject(pio).kind, "platformio");

  const plain = scratch("prometheus-cmake-");
  writeFileSync(join(plain, "CMakeLists.txt"), "project(app C)\n");
  assert.equal(detectProject(plain).kind, "cmake");
});

test("a host-only Rust project is not treated as embedded", () => {
  const root = scratch("prometheus-cargo-");
  writeFileSync(join(root, "Cargo.toml"), "[package]\nname = \"cli\"\nversion = \"0.1.0\"\n");
  assert.notEqual(detectProject(root).kind, "cargo-embedded");

  writeFileSync(
    join(root, "Cargo.toml"),
    '[package]\nname = "fw"\n[dependencies]\ncortex-m = "0.7"\nembedded-hal = "1"\n',
  );
  assert.equal(detectProject(root).kind, "cargo-embedded");
});

test("detection walks up from a nested directory", () => {
  const root = scratch("prometheus-nested-");
  writeFileSync(join(root, "prj.conf"), "CONFIG_GPIO=y\n");
  writeFileSync(join(root, "CMakeLists.txt"), "find_package(Zephyr)\n");
  mkdirSync(join(root, "src", "drivers"), { recursive: true });
  assert.equal(detectProject(join(root, "src", "drivers")).kind, "zephyr");
});

test("an unrecognised tree reports unknown instead of guessing", () => {
  const root = scratch("prometheus-empty-");
  const project = detectProject(root);
  assert.equal(project.kind, "unknown");
  assert.equal(buildCommand(project, {}), null);
});

test("CMake presets are read and preferred over a bare build directory", () => {
  const root = scratch("prometheus-presets-");
  writeFileSync(join(root, "CMakeLists.txt"), "project(app C)\n");
  writeFileSync(
    join(root, "CMakePresets.json"),
    JSON.stringify({ configurePresets: [{ name: "debug" }, { name: "release" }] }),
  );
  const project = detectProject(root);
  assert.deepEqual(project.presets, ["debug", "release"]);

  const command = buildCommand(project, { cmake: "cmake" }, { preset: "release" });
  assert.ok(command);
  assert.deepEqual(command.args, ["--build", "--preset", "release"]);
});

test("Keil and IAR are identified but produce no build command", () => {
  const keil = scratch("prometheus-keil-");
  writeFileSync(join(keil, "app.uvprojx"), "<Project/>");
  const project = detectProject(keil);
  assert.equal(project.kind, "keil");
  // The agent should say "this is a Keil project", not try to run CMake.
  assert.equal(buildCommand(project, {}), null);
});
