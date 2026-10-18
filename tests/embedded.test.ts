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
import { matchTarget, parsePyocdTargets, pyocdProbes } from "../src/embedded/probe.ts";
import { capture, parseLine } from "../src/embedded/serial.ts";

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

// ---- probes and targets ----------------------------------------------------

const PYOCD_TARGETS = `  air001                    AirM2M                   Air001                          builtin  \r
  nrf52840                  Nordic Semiconductor     NRF52840                                builtin  \r
  stm32f412xe               STMicroelectronics       STM32F412xE                             builtin  \r
  stm32f412xg               STMicroelectronics       STM32F412xG                             builtin  \r
  my_board                  Acme                     ACME1234                 M33 Series     pack  \r
`;

test("the pyOCD target table parses by value, not by column position", () => {
  const targets = parsePyocdTargets(PYOCD_TARGETS);
  assert.equal(targets.length, 5);

  const stm = targets.find((target) => target.name === "stm32f412xe");
  assert.ok(stm);
  assert.equal(stm.vendor, "STMicroelectronics");
  assert.equal(stm.part, "STM32F412xE");
  // The empty Families column must not swallow the Source column.
  assert.equal(stm.packSource, "builtin");
  assert.equal(stm.families, undefined);

  // A pack target that does have a family keeps it.
  const packed = targets.find((target) => target.name === "my_board");
  assert.deepEqual(packed?.families, ["M33 Series"]);
  assert.equal(packed?.packSource, "pack");
});

test("target matching prefers exact, ignores case, and reports ambiguity", () => {
  const targets = parsePyocdTargets(PYOCD_TARGETS);

  assert.equal(matchTarget(targets, "nrf52840").target?.name, "nrf52840");
  assert.equal(matchTarget(targets, "STM32F412XE").target?.name, "stm32f412xe");

  // Two parts share a prefix: report both rather than pick one.
  const ambiguous = matchTarget(targets, "stm32f412");
  assert.equal(ambiguous.target, undefined);
  assert.deepEqual(ambiguous.candidates.map((target) => target.name).sort(), ["stm32f412xe", "stm32f412xg"]);

  assert.deepEqual(matchTarget(targets, "").candidates, []);
});

test("pyOCD's empty-desk sentence is not mistaken for a probe", () => {
  const probes = pyocdProbes("No available debug probes are connected\n");
  assert.equal(probes.length, 0);
});

test("an attached probe yields name, serial and target", () => {
  const probes = pyocdProbes("  0   STLink V2   0673FF515052887167234822   STM32F412RETx   \n");
  assert.equal(probes.length, 1);
  assert.equal(probes[0].kind, "pyocd");
  assert.equal(probes[0].name, "STLink V2");
  assert.equal(probes[0].serial, "0673FF515052887167234822");
  assert.equal(probes[0].target, "STM32F412RETx");
});

// ---- serial ----------------------------------------------------------------

test("the four console formats parse into level, tag and timestamp", () => {
  const zephyr = parseLine("[00:00:01.234,567] <err> i2c_nrfx: NACK received");
  assert.equal(zephyr.t, 1234);
  assert.equal(zephyr.level, "error");
  assert.equal(zephyr.tag, "i2c_nrfx");
  assert.equal(zephyr.text, "NACK received");

  const idf = parseLine("W (1734) wifi: retry limit reached");
  assert.equal(idf.t, 1734);
  assert.equal(idf.level, "warn");
  assert.equal(idf.tag, "wifi");

  const rtos = parseLine("[42] sensor: reading 512");
  assert.equal(rtos.t, 42);
  assert.equal(rtos.tag, "sensor");

  // Plain printf is the common case and must survive untouched.
  const plain = parseLine("hello from main");
  assert.equal(plain.level, undefined);
  assert.equal(plain.text, "hello from main");
  assert.equal(plain.raw, "hello from main");
});

test("ANSI colour and CRLF are stripped before parsing", () => {
  const line = parseLine("\x1b[0;31mE (5) boot: panic\x1b[0m\r");
  assert.equal(line.level, "error");
  assert.equal(line.text, "panic");
});

/** A port that replays a scripted set of chunks. */
function fakePort(chunks: string[], onDone?: () => void) {
  let listener: ((chunk: string) => void) | undefined;
  return (_path: string, _baud: number) => ({
    onData(fn: (chunk: string) => void) {
      listener = fn;
      setTimeout(() => {
        for (const chunk of chunks) fn(chunk);
        onDone?.();
      }, 0);
    },
    close() {
      listener = undefined;
    },
  });
}

test("capture stops at the pattern and returns the matching line", async () => {
  const open = fakePort(["booting\nready\n", "listening\n", "more that never arrives\n"]);
  const result = await capture(open, "COM7", { until: /listening/, timeoutMs: 500 });
  assert.equal(result.timedOut, false);
  assert.equal(result.matched?.text, "listening");
  assert.deepEqual(result.lines.map((line) => line.text), ["booting", "ready", "listening"]);
});

test("capture times out cleanly on a silent device", async () => {
  const open = fakePort([]);
  const result = await capture(open, "COM7", { timeoutMs: 60 });
  assert.equal(result.timedOut, true);
  assert.equal(result.lines.length, 0);
});

test("a line split across chunks is reassembled", async () => {
  const open = fakePort(["partial li", "ne\nnext\n"]);
  const result = await capture(open, "COM7", { timeoutMs: 100, maxLines: 2 });
  assert.deepEqual(result.lines.map((line) => line.text), ["partial line", "next"]);
});

test("a flooding device is capped instead of filling the context", async () => {
  const flood = Array.from({ length: 500 }, (_, index) => `line ${index}\n`).join("");
  const open = fakePort([flood]);
  const result = await capture(open, "COM7", { maxLines: 10, timeoutMs: 500 });
  assert.equal(result.lines.length, 10);
  assert.equal(result.timedOut, true);
});

test("skipUntil drops the boot banner", async () => {
  const open = fakePort(["*** Booting Zephyr ***\ninit\n[00:00:00.100,000] <inf> app: started\n"]);
  const result = await capture(open, "COM7", { skipUntil: /<inf>/, timeoutMs: 100, maxLines: 5 });
  assert.equal(result.lines.length, 1);
  assert.equal(result.lines[0].tag, "app");
});

test("a port that cannot be opened reports the reason, not a hang", async () => {
  const result = await capture(() => {
    throw new Error("Access denied");
  }, "COM7", { timeoutMs: 100 });
  assert.equal(result.lines.length, 0);
  assert.match(result.errors.join(" "), /Access denied/);
});
