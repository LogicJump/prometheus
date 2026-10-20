/**
 * The embedded adapters, tested against fixtures rather than a live toolchain,
 * so the suite passes on a machine with nothing installed.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { parseDiagnostics, sortDiagnostics, summarizeDiagnostics, collapseCascades } from "../src/embedded/diagnostics.ts";
import { detectProject, buildCommand } from "../src/embedded/project.ts";
import { matchTarget, parsePyocdTargets, pyocdProbes } from "../src/embedded/probe.ts";
import { capture, parseLine, windowsSerialScript } from "../src/embedded/serial.ts";
import { classifyOutput, commandFor, flash, parseSize, validate } from "../src/embedded/flash.ts";
import { findArtifacts } from "../src/embedded/build.ts";
import { miFields, miList, parseMiLine, parseStackFrames, parseStopReason, parseVariables, SERVER_PORTS, serverCommand } from "../src/embedded/debug.ts";
import { findRegister, parseSvd, peripheralIndex, registerAddress } from "../src/embedded/svd.ts";
import { parseClangTidyYaml, parseCppcheckXml, parseMemoryUsage, parseStackUsage } from "../src/embedded/analyze.ts";
import type { FoundTool } from "../src/embedded/toolchain.ts";
import { existsSync } from "node:fs";

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

test("Keil and IAR produce a headless build command once the IDE is installed", () => {
  const keil = scratch("prometheus-keil-");
  writeFileSync(join(keil, "app.uvprojx"), "<Project/>");
  const project = detectProject(keil);
  assert.equal(project.kind, "keil");
  // No IDE installed: the command still points at the program, so the error
  // names UV4.exe rather than saying "unsupported project".
  assert.equal(buildCommand(project, {}).program, "UV4.exe");

  const command = buildCommand(project, { keil: "C:\\Keil_v5\\UV4\\UV4.exe" });
  assert.equal(command.program, "C:\\Keil_v5\\UV4\\UV4.exe");
  // -b is the documented batch build; -o names the file the diagnostics land in.
  assert.deepEqual(command.args.slice(0, 1), ["-b"]);
  assert.ok(command.args.includes(join(keil, "app.uvprojx")));
  assert.ok(command.buildLog, "the build log is where UV4 writes its errors");
  // A Keil ELF is an `.axf`, and that is what the artifact scan must accept.
  assert.ok(command.artifactPatterns.some((pattern) => pattern.endsWith(".axf")));

  const iar = scratch("prometheus-iar-");
  writeFileSync(join(iar, "app.ewp"), "<project/>");
  const iarCommand = buildCommand(detectProject(iar), { iar: "C:\\iar\\IarBuild.exe" });
  assert.equal(iarCommand.program, "C:\\iar\\IarBuild.exe");
  assert.deepEqual(iarCommand.args.slice(1), ["-build", "Debug"]);
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

test("the table header and rule are not probes", () => {
  // Real output, CRLF and all. The header used to survive as a probe named
  // "#" attached to a chip called "Probe/Board".
  const output =
    "  #   Probe/Board    Unique ID                  Target  \r\n" +
    "--------------------------------------------------------\r\n" +
    "  0   STM32 STLink   37FF71064E573436C88F1A43   n/a     \r\n";
  const probes = pyocdProbes(output);
  assert.equal(probes.length, 1);
  assert.equal(probes[0].name, "STM32 STLink");
  assert.equal(probes[0].serial, "37FF71064E573436C88F1A43");
  // `n/a` is the absence of a target, not a target.
  assert.equal(probes[0].target, undefined);
});

test("the Windows serial script is valid PowerShell", () => {
  // This is the test that would have caught the original bug: the script used
  // to be joined with "; ", which produces `while($true){; try {...}; catch ...`
  // and PowerShell rejects a catch that does not follow the closing brace.
  // Nothing else in the suite ran real PowerShell, so serial capture shipped
  // broken on Windows.
  const script = windowsSerialScript(false);
  assert.equal(script.includes("}; catch"), false);

  const powershell = process.platform === "win32" ? "powershell" : null;
  if (!powershell) return;
  // Encode as UTF-16LE base64: the script contains newlines and braces, and
  // -EncodedCommand is the only spelling that survives quoting intact.
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const probe = spawnSync(
    powershell,
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `$errors=$null; $null=[System.Management.Automation.Language.Parser]::ParseInput([Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encoded}')), [ref]$null, [ref]$errors); if ($errors.Count) { $errors | ForEach-Object { $_.Message }; exit 1 }`,
    ],
    { encoding: "utf8" },
  );
  assert.equal(probe.status, 0, `PowerShell rejected the serial script:\n${probe.stdout}${probe.stderr}`);
});

test("the serial script reads raw bytes, not lines", () => {
  // ReadLine discards its buffer on every timeout, which is how a firmware
  // printing without a newline lost data in 500 ms slices.
  const script = windowsSerialScript(false);
  assert.equal(script.includes("BaseStream.Read"), true);
  assert.equal(script.includes("ReadLine"), false);
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

// ---- flashing --------------------------------------------------------------

// These two tests read real files that only exist on a machine where a
// toolchain and a vendor SVD pack have been installed by hand. They are opt-in
// through the environment so a fresh clone never silently skips a test it was
// meant to run, and so no contributor's home directory ends up in the repo.
const ELF_FIXTURE = process.env.PROMETHEUS_TEST_ELF ?? "";
const SVD_FIXTURE = process.env.PROMETHEUS_TEST_SVD ?? "";
const hasFixture = ELF_FIXTURE !== "" && existsSync(ELF_FIXTURE);
const hasStm32Svd = SVD_FIXTURE !== "" && existsSync(SVD_FIXTURE);

test("a flash is refused before running when it would be ambiguous", () => {
  const tmp = scratch("prometheus-flash-");
  const bin = join(tmp, "fw.bin");
  writeFileSync(bin, Buffer.alloc(64, 0xff));

  // A raw .bin with no address: every tool defaults differently.
  assert.match(String(validate({ kind: "pyocd", program: "pyocd", firmware: bin, target: "stm32f412xe" })), /load address/);
  assert.equal(validate({ kind: "pyocd", program: "pyocd", firmware: bin, target: "stm32f412xe", address: 0x08000000 }), null);

  // No target means the tool picks one, which is how the wrong board gets flashed.
  const elf = join(tmp, "fw.elf");
  writeFileSync(elf, "not really an elf");
  assert.match(String(validate({ kind: "pyocd", program: "pyocd", firmware: elf })), /needs a target/);
  assert.match(String(validate({ kind: "openocd", program: "openocd", firmware: elf })), /target config/);

  // A missing file and an empty one are both refused.
  assert.match(String(validate({ kind: "pyocd", program: "pyocd", firmware: join(tmp, "nope.elf"), target: "x" })), /not found/);
  const empty = join(tmp, "empty.elf");
  writeFileSync(empty, "");
  assert.match(String(validate({ kind: "pyocd", program: "pyocd", firmware: empty, target: "x" })), /empty/);
});

test("the command vector matches what each tool actually expects", () => {
  const pyocd = commandFor({ kind: "pyocd", program: "pyocd", firmware: "fw.elf", target: "stm32f412xe" });
  // The image is positional; pyOCD's -f is --frequency (the SWD clock), and
  // handing it a filename aborts the command before the probe is touched.
  assert.deepEqual(pyocd, ["flash", "fw.elf", "--target", "stm32f412xe"]);
  assert.equal(pyocd.includes("-f"), false);

  const openocd = commandFor({
    kind: "openocd",
    program: "openocd",
    firmware: "fw.elf",
    interfaceConfig: "interface/stlink.cfg",
    targetConfig: "target/stm32f4x.cfg",
  });
  assert.deepEqual(openocd.slice(0, 4), ["-f", "interface/stlink.cfg", "-f", "target/stm32f4x.cfg"]);
  // The whole program/verify/reset/exit sequence is one -c string.
  assert.match(openocd[5], /^program fw\.elf verify reset exit$/);

  const esptool = commandFor({ kind: "esptool", program: "esptool", firmware: "app.bin", address: 0x10000 });
  assert.deepEqual(esptool, ["--chip", "auto", "--baud", "460800", "write_flash", "0x10000", "app.bin"]);
});

test("a tool that says it failed is not rescued by a zero exit code", () => {
  // pyOCD prints "loaded" and then "verify failed"; the second must win.
  const pyocd = classifyOutput("pyocd", "[flasher] loaded 1024 bytes\nERROR: Verify failed", 0);
  assert.equal(pyocd.ok, false);
  assert.match(String(pyocd.reason), /Verify failed/i);

  const openocd = classifyOutput("openocd", "** Programming Started **\n** Programming Failed **", 0);
  assert.equal(openocd.ok, false);

  const esptool = classifyOutput("esptool", "Writing at 0x1000... (100%)\nA fatal error occurred: Failed to connect", 0);
  assert.equal(esptool.ok, false);
});

test("a success with a verify step reports verified", () => {
  const verified = classifyOutput("openocd", "** Programming Started **\n** Programming Finished **\n** Verified OK **\nshutdown command invoked", 0);
  assert.equal(verified.ok, true);
  assert.equal(verified.verified, true);

  const esptool = classifyOutput("esptool", "Hash of data verified.\nLeaving...", 0);
  assert.equal(esptool.ok, true);
  assert.equal(esptool.verified, true);
});

test("no status phrase falls back to the exit code and says so", () => {
  const quiet = classifyOutput("probe-rs", "some unfamiliar output", 0);
  assert.equal(quiet.ok, true);
  assert.match(String(quiet.reason), /exit code 0/);

  const crashed = classifyOutput("probe-rs", "some unfamiliar output", 2);
  assert.equal(crashed.ok, false);
});

test("a flash with a missing firmware never spawns a process", async () => {
  const result = await flash({ kind: "pyocd", program: "definitely-not-a-program", firmware: "does-not-exist.elf", target: "x" });
  assert.equal(result.ok, false);
  assert.equal(result.command, "");
  assert.match(String(result.reason), /not found/);
});

test("size parsing separates what reaches flash from what stays on disk", { skip: !hasFixture }, () => {
  // Real `arm-none-eabi-size -A` output for a tiny Cortex-M image.
  const output = [
    "t.elf  :",
    "section           size        addr",
    ".text               14   134217728",
    ".persistent          0   134221840",
    ".noinit              0   134221840",
    ".comment            69           0",
    ".ARM.attributes     46           0",
    "Total              129",
  ].join("\n");

  const usage = parseSize(output);
  // .comment and .ARM.attributes never reach the chip.
  assert.equal(usage.flash, 14);
  assert.equal(usage.sections.length, 3);
  assert.equal(usage.sections[0].address, 0x08000000);
});

test("a .data section counts against both flash and RAM", () => {
  const output = [
    "section           size        addr",
    ".text             1024   134217728",
    ".data               64   536870912",
    ".bss               512   536871000",
  ].join("\n");
  const usage = parseSize(output);
  // .data's initialiser lives in flash, its storage in RAM.
  assert.equal(usage.flash, 1024 + 64);
  assert.equal(usage.ram, 64 + 512);
});

// ---- artifacts -------------------------------------------------------------

test("an artifact finder trusts ELF magic over the file extension", () => {
  const root = scratch("prometheus-artifacts-");
  mkdirSync(join(root, "build"), { recursive: true });

  // CMake's OUTPUT_NAME strips the suffix; this is a real ELF with no extension.
  const magic = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]);
  writeFileSync(join(root, "build", "firmware"), magic);
  // A text file with no extension must not be mistaken for one.
  writeFileSync(join(root, "build", "CMakeCache.txt"), "not an elf");
  writeFileSync(join(root, "build", "notes"), "plain text");
  writeFileSync(join(root, "build", "app.hex"), ":00000001FF\n");

  const artifacts = findArtifacts(root, ["build/*.elf", "build/*.hex"]);
  const kinds = artifacts.map((artifact) => `${artifact.relative}:${artifact.kind}`).sort();
  assert.deepEqual(kinds, ["build/app.hex:hex", "build/firmware:elf"]);
});

test("the newest artifact wins, and an ELF beats its own hex", () => {
  const root = scratch("prometheus-artifacts2-");
  mkdirSync(join(root, "build"), { recursive: true });
  const magic = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);
  writeFileSync(join(root, "build", "old.elf"), magic);
  // Same-size, same-mtime ELF and hex: the ELF carries the debug symbols.
  writeFileSync(join(root, "build", "fw.elf"), magic);
  writeFileSync(join(root, "build", "fw.hex"), ":00000001FF\n");

  const artifacts = findArtifacts(root, ["build/*.elf", "build/*.hex"]);
  assert.equal(artifacts[0].kind, "elf");
});

// ---- GDB/MI ----------------------------------------------------------------

test("MI records parse with their token, class and body", () => {
  assert.equal(parseMiLine("(gdb)"), null);
  // A stream record has no class: `~"text"`.
  const stream = parseMiLine('~"Reading symbols\\n"');
  assert.equal(stream?.kind, "stream");
  assert.equal(stream?.body, '"Reading symbols\\n"');

  const done = parseMiLine("1^done");
  assert.equal(done?.kind, "result");
  assert.equal(done?.token, 1);
  assert.equal(done?.class, "done");

  const error = parseMiLine('2^error,msg="No symbol table is loaded"');
  assert.equal(error?.class, "error");
  assert.match(error.body, /No symbol table/);

  const running = parseMiLine('*running,thread-id="all"');
  assert.equal(running?.kind, "exec");
  assert.equal(running?.class, "running");
});

test("MI field extraction handles escapes, nesting and bare words", () => {
  const fields = miFields('msg="a \\"quoted\\" word",frame={level="0"},count=3');
  assert.equal(fields.msg, 'a "quoted" word');
  assert.equal(fields.frame, '{level="0"}');
  // A nested tuple is returned as raw text so its children can be parsed later.
  assert.equal(miFields(fields.frame).level, "0");
  assert.equal(fields.count, "3");
});

test("a MI list keeps commas that live inside strings", () => {
  const items = miList('[{a="1",b="x,y"},{a="2"}]');
  assert.equal(items.length, 2);
  assert.match(items[0], /x,y/);
});

test("stack frames parse from both `frame=` and bare tuple forms", () => {
  // Real `-stack-list-frames` output.
  const frames = parseStackFrames(
    'stack=[frame={level="0",addr="0x08000010",func="main",file="src/main.c",line="7"},' +
      'frame={level="1",addr="0x08000020",func="Reset_Handler",file="startup.c",line="3"}]',
  );
  assert.equal(frames.length, 2);
  assert.deepEqual(frames[0], { level: 0, func: "main", file: "src/main.c", line: 7, address: "0x08000010" });
  assert.equal(frames[1].func, "Reset_Handler");

  // `-stack-list-variables` uses bare tuples; the same unwrap must work.
  const variables = parseVariables('variables=[{name="counter",type="uint32_t",value="1"},{name="i",type="int",value="0"}]');
  assert.deepEqual(variables, [
    { name: "counter", value: "1" },
    { name: "i", value: "0" },
  ]);

  // An empty list is empty, not a crash.
  assert.deepEqual(parseStackFrames("stack=[]"), []);
  assert.deepEqual(parseStackFrames("nothing here"), []);
});

test("a stop reason carries its frame even without a level", () => {
  const stop = parseStopReason(
    'reason="breakpoint-hit",disp="keep",bkptno="1",frame={addr="0x08000010",func="main",file="src/main.c",line="7"},thread-id="1"',
  );
  assert.equal(stop.reason, "breakpoint-hit");
  // Real stop records omit `level`; the top frame is level 0.
  assert.equal(stop.frame?.level, 0);
  assert.equal(stop.frame?.func, "main");
});

test("each probe family gets the GDB server command it actually accepts", () => {
  const openocd = serverCommand("openocd", "openocd", { targetConfig: "target/stm32f4x.cfg", interfaceConfig: "interface/stlink.cfg" });
  assert.ok(openocd);
  assert.equal(openocd.port, 3333);
  assert.deepEqual(openocd.args.slice(0, 4), ["-f", "interface/stlink.cfg", "-f", "target/stm32f4x.cfg"]);

  const pyocd = serverCommand("pyocd", "pyocd", { target: "stm32f412xe" });
  assert.ok(pyocd);
  assert.deepEqual(pyocd.args.slice(0, 2), ["gdbserver", "--target"]);

  // Without the config a server cannot start, and saying so beats a hang.
  assert.equal(serverCommand("openocd", "openocd", {}), null);
  assert.equal(serverCommand("pyocd", "pyocd", {}), null);
  // Ports differ per tool; getting this wrong is a silent timeout.
  assert.equal(SERVER_PORTS["probe-rs"], 1337);
  assert.equal(SERVER_PORTS.jlink, 2331);
});

// ---- SVD ------------------------------------------------------------------

const SVD_MINIMAL = `<?xml version="1.0"?>
<device schemaVersion="1.1">
  <name>TESTCHIP</name>
  <vendor>Acme</vendor>
  <cpu><name>CM4</name><revision>r0p1</revision><fpuPresent>true</fpuPresent></cpu>
  <peripherals>
    <peripheral>
      <name>UART1</name>
      <description>Universal async receiver</description>
      <baseAddress>0x40010000</baseAddress>
      <interrupt><name>UART1</name><value>37</value></interrupt>
      <registers>
        <register>
          <name>CR1</name><addressOffset>0xC</addressOffset><size>32</size>
          <access>read-write</access><resetValue>0x0</resetValue>
          <fields>
            <field><name>RE</name><bitOffset>2</bitOffset><bitWidth>1</bitWidth></field>
            <field><name>TE</name><lsb>3</lsb><msb>3</msb></field>
            <field>
              <name>MODE</name><bitOffset>4</bitOffset><bitWidth>2</bitWidth>
              <enumeratedValues>
                <enumeratedValue><name>EIGHT_BIT</name><value>0</value></enumeratedValue>
                <enumeratedValue><name>NINE_BIT</name><value>1</value></enumeratedValue>
              </enumeratedValues>
            </field>
          </fields>
        </register>
        <register><name>DR</name><addressOffset>0x4</addressOffset><size>32</size></register>
      </registers>
    </peripheral>
    <peripheral derivedFrom="UART1">
      <name>UART2</name>
      <baseAddress>0x40011000</baseAddress>
    </peripheral>
  </peripherals>
</device>`;

test("a minimal SVD parses into a device with cpu, peripherals and interrupts", () => {
  const device = parseSvd(SVD_MINIMAL);
  assert.equal(device.name, "TESTCHIP");
  assert.equal(device.vendor, "Acme");
  assert.equal(device.cpu?.name, "CM4");
  assert.equal(device.cpu?.fpuPresent, true);
  assert.equal(device.peripherals.length, 2);

  const uart = device.peripherals.find((peripheral) => peripheral.name === "UART1");
  assert.ok(uart);
  assert.equal(uart.baseAddress, 0x40010000);
  assert.equal(uart.interrupts?.[0].value, 37);
});

test("both bit spellings yield the same field geometry", () => {
  const device = parseSvd(SVD_MINIMAL);
  const uart = device.peripherals.find((peripheral) => peripheral.name === "UART1");
  const cr1 = uart?.registers.find((register) => register.name === "CR1");
  assert.ok(cr1);

  const re = cr1.fields.find((field) => field.name === "RE");
  const te = cr1.fields.find((field) => field.name === "TE");
  // bitOffset/bitWidth and lsb/msb describe the same one-bit field.
  assert.equal(re?.bitOffset, 2);
  assert.equal(re?.bitWidth, 1);
  assert.equal(te?.bitOffset, 3);
  assert.equal(te?.bitWidth, 1);
  // Fields come back in bit order.
  assert.deepEqual(cr1.fields.map((field) => field.bitOffset), [2, 3, 4]);
});

test("enumerated values are attached to their field", () => {
  const device = parseSvd(SVD_MINIMAL);
  const mode = findRegister(device, "UART1.CR1.MODE")?.field;
  assert.ok(mode);
  assert.deepEqual(mode.enums, { EIGHT_BIT: "0", NINE_BIT: "1" });
});

test("derivedFrom inherits the parent's registers and keeps its own address", () => {
  const device = parseSvd(SVD_MINIMAL);
  const uart2 = device.peripherals.find((peripheral) => peripheral.name === "UART2");
  assert.ok(uart2);
  // Without resolution a derived peripheral looks empty, which is the bug.
  assert.equal(uart2.registers.length, 2);
  assert.equal(uart2.baseAddress, 0x40011000);
  assert.equal(uart2.interrupts?.[0].value, 37);

  // Register lookup works through the derivation.
  assert.equal(registerAddress(device, "UART2.CR1"), 0x40011000 + 0xc);
  assert.equal(registerAddress(device, "UART1.CR1"), 0x40010000 + 0xc);
});

test("clusters flatten their registers to the right offsets", () => {
  const xml = `<device><name>C</name><peripherals><peripheral><name>P</name><baseAddress>0x1000</baseAddress>
    <registers>
      <register><name>DIRECT</name><addressOffset>0x0</addressOffset></register>
      <cluster><name>CH</name><addressOffset>0x100</addressOffset>
        <register><name>CTRL</name><addressOffset>0x8</addressOffset></register>
      </cluster>
    </registers></peripheral></peripherals></device>`;
  const device = parseSvd(xml);
  assert.equal(registerAddress(device, "P.CTRL"), 0x1000 + 0x100 + 0x8);
  assert.equal(registerAddress(device, "P.DIRECT"), 0x1000);
});

test("a file that is not an SVD is refused by name", () => {
  assert.throws(() => parseSvd("#include <stdio.h>\nint main(void){return 0;}\n", { source: "notes.svd" }), /not an SVD/);
});

test("the index fits a context window and carries base addresses", () => {
  const device = parseSvd(SVD_MINIMAL);
  const index = peripheralIndex(device);
  assert.match(index, /UART1 @0x40010000/);
  // A derived peripheral must still show its own base address.
  assert.match(index, /UART2 @0x40011000/);
  assert.match(index, /CR1\+0xC/);
});

test("reading a real vendor SVD gives the right register addresses", { skip: !hasStm32Svd }, () => {
  const device = parseSvd(SVD_FIXTURE);
  assert.ok(device.peripherals.length > 30, `expected many peripherals, got ${device.peripherals.length}`);

  // USART2 is a derived peripheral on STM32: without resolution it is empty.
  const uart2 = device.peripherals.find((peripheral) => peripheral.name === "USART2");
  assert.ok(uart2);
  assert.ok(uart2.registers.length >= 6, "USART2 must inherit its registers from USART1");

  // The datasheet values: USART2 base 0x40004400, CR1 at +0x0C, UE is bit 13.
  assert.equal(registerAddress(device, "USART2.CR1"), 0x4000440c);
  const ue = findRegister(device, "USART2.CR1.UE")?.field;
  assert.ok(ue);
  assert.equal(ue.bitOffset, 13);
  assert.equal(ue.bitWidth, 1);

  // The whole chip's index stays inside a context window.
  const index = peripheralIndex(device);
  assert.ok(index.length < 20_000, `index is ${index.length} chars, too big for the context`);
});

// ---- static analysis -------------------------------------------------------

test("cppcheck XML becomes findings with code, CWE and supporting locations", () => {
  const xml = `<?xml version="1.0"?>
<results version="2"><cppcheck version="2.19.0"/><errors>
  <error id="arrayIndexOutOfBounds" severity="error" msg="Array &apos;arr[4]&apos; accessed at index 10." cwe="788" file0="bad.c">
    <location file="bad.c" line="5" column="6" info="Array index out of bounds"/>
  </error>
  <error id="nullPointerRedundantCheck" severity="warning" msg="Possible null pointer dereference: p." cwe="476" file0="bad.c">
    <location file="bad.c" line="10" column="12" info="Null pointer dereference"/>
    <location file="bad.c" line="9" column="7" info="Assuming the condition is not redundant"/>
    <symbol>p</symbol>
  </error>
</results>`;
  const findings = parseCppcheckXml(xml);
  assert.equal(findings.length, 2);

  const oob = findings[0];
  assert.equal(oob.severity, "error");
  assert.equal(oob.rule, "arrayIndexOutOfBounds");
  assert.equal(oob.cwe, "788");
  assert.equal(oob.line, 5);
  // The entities in the analyser's own message are decoded.
  assert.match(oob.message, /arr\[4\]/);

  // The second location is supporting evidence, not a separate finding.
  assert.equal(findings[1].notes?.length, 1);
  assert.equal(findings[1].notes?.[0].line, 9);
});

test("cppcheck's style severity is advisory, not an error", () => {
  const xml = `<results><errors>
    <error id="unreadVariable" severity="style" msg="never used">
      <location file="a.c" line="3" column="7"/>
    </error>
  </errors></results>`;
  const [finding] = parseCppcheckXml(xml);
  assert.equal(finding.severity, "note");
});

test("an empty or malformed analysis is empty, not a crash", () => {
  assert.deepEqual(parseCppcheckXml(""), []);
  assert.deepEqual(parseCppcheckXml("<results><errors></errors></results>"), []);
  assert.deepEqual(parseCppcheckXml("not xml at all"), []);
});

test("clang-tidy YAML yields the checker name and a level", () => {
  const yaml = `---\nMainSourceFile:  'src/main.cpp'\nDiagnostics:\n  - DiagnosticName:  'bugprone-use-after-move'\n    Message:         'std::move of the variable is used after'\n    Level:           Warning\n    BuildDirectory:  '/tmp/build'\n    FilePath:        'src/main.cpp'\n    FileOffset:      128\n`;
  const findings = parseClangTidyYaml(yaml);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].analyzer, "clang-tidy");
  assert.equal(findings[0].severity, "warning");
  assert.match(findings[0].message, /used after/);
  assert.equal(findings[0].file, "src/main.cpp");
});

test("linker memory usage separates used from total", () => {
  const output = "Memory region         Used Size  Region Size  %age Used\n           FLASH:       12345 B        64 KB     18.83%\n             RAM:        4096 B       128 KB      3.13%";
  const regions = parseMemoryUsage(output);
  assert.equal(regions.length, 2);
  assert.equal(regions[0].region, "FLASH");
  assert.equal(regions[0].used, 12345);
  assert.equal(regions[0].total, 64000);
});

test("stack usage marks a dynamic frame as a lower bound", () => {
  const su = "src/main.c:12:5:main\t128\tstatic\nsrc/main.c:30:6:recurse\t64\tdynamic\nsrc/lib.c:4:7:helper\t24\tstatic";
  const frames = parseStackUsage(su);
  // Largest first: that is the one that risks the stack.
  assert.equal(frames[0].function, "main");
  assert.equal(frames[0].bytes, 128);
  assert.equal(frames.find((frame) => frame.function === "recurse")?.kind, "dynamic");
});

// ---- toolchain health ------------------------------------------------------

test("a toolchain source is recorded so the UI can show where it came from", () => {
  // The report distinguishes PATH finds from install-root finds; the shape is
  // what the settings screen and the build guard both read.
  const found: FoundTool = {
    kind: "gcc-arm",
    path: "C:/tools/arm/bin/arm-none-eabi-gcc.exe",
    version: "15.3.1",
    source: "install-root",
    complete: true,
  };
  assert.equal(found.source, "install-root");
  assert.equal(found.complete, true);

  const broken: FoundTool = {
    kind: "gcc-arm",
    path: "/opt/homebrew/bin/arm-none-eabi-gcc",
    version: "16.2.0",
    source: "path",
    complete: false,
    problem: "this compiler has no C library",
  };
  assert.equal(broken.complete, false);
});
