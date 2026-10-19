/**
 * Tools that run, trace, measure and power-cycle a board.
 *
 * These are the capabilities the research calls the "differentiated" half of
 * an embedded workbench: testing, logging without a UART, and knowing what the
 * firmware costs in milliamps. They are kept in their own module so
 * `embeddedTools.ts` stays about the build/flash/debug core, and because each
 * one is a thin adapter over a `src/embedded/*` primitive that can be tested
 * without hardware.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Tool, ToolResult } from "../types.ts";
import { detectProject } from "../embedded/project.ts";
import { detectToolchains } from "../embedded/toolchain.ts";
import {
  ctestDir,
  frameworkFor,
  parseTestOutput,
  summarizeTests,
  testCommand,
  type TestFramework,
  type TestRunResult,
} from "../embedded/testRunner.ts";
import { emulatorCommand, describeEmulator, isEmulatorTarget, type Emulator } from "../embedded/emulator.ts";
import { searchDatasheets, formatDatasheetHits } from "../embedded/datasheet.ts";
import { powerCommands, runPowerCommand, describePlan, CYCLE_DEFAULTS, type PowerDevice } from "../embedded/hil.ts";
import {
  formatMeasurement,
  parseScpi,
  summarizeSamples,
  INSTRUMENTS,
  scpiCommands,
} from "../embedded/instruments.ts";
import { splitTraceChunk, parseTraceLine, traceCommand, jlinkRttScript, type TraceChannel } from "../embedded/trace.ts";
import { findDeviceInPacks, installedPacks, readPackIndex, citePack } from "../embedded/cmsisPack.ts";

/** Run a command with a cap, returning combined output. */
function run(program: string, args: string[], cwd: string, timeoutMs: number): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(program, args, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const append = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.length > 400_000) child.kill();
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: null, output: `${output}\n${err.message}`.trim() });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });
}

// ---- embed_test ------------------------------------------------------------

const testTool: Tool = {
  name: "embed_test",
  description:
    "Run the project's tests and return a normalised pass/fail list. Uses Zephyr twister, PlatformIO `pio test`, CMake ctest or ESP-IDF `idf.py test` depending on the project. Prefer this over running the test command through bash: the result is parsed, so a failure is a named test rather than a wall of output.",
  readonly: false,
  parameters: {
    type: "object",
    properties: {
      framework: {
        type: "string",
        enum: ["twister", "pio", "ctest", "idf", "pytest", "unity"],
        description: "Force a runner; by default it follows the detected project",
      },
      target: { type: "string", description: "Board or environment name, when the runner needs one" },
      native: { type: "boolean", description: "Use the emulator/native runner instead of hardware (`--platform native_sim` for twister)" },
      timeout_ms: { type: "integer", description: "Overall cap, default 600000" },
      extra_args: { type: "array", items: { type: "string" }, description: "Passed through to the runner" },
    },
    additionalProperties: false,
  },
  summarize: (input) => `${input.framework ? String(input.framework) : "tests"}${input.target ? ` on ${input.target}` : ""}`,
  async execute(input, ctx): Promise<ToolResult> {
    const project = detectProject(ctx.cwd);
    const framework = (input.framework as TestFramework | undefined) ?? frameworkFor(project);
    if (!framework) {
      return {
        isError: true,
        content: `No test runner for a ${project.kind} project. Supported: Zephyr, PlatformIO, CMake/ctest, ESP-IDF.`,
        display: "no runner",
      };
    }
    const report = await detectToolchains();
    const byKind = new Map(report.tools.map((entry) => [entry.kind, entry.path]));
    const program =
      framework === "twister"
        ? byKind.get("west") ?? "twister"
        : framework === "pio"
          ? byKind.get("pio") ?? "pio"
          : framework === "ctest"
            ? byKind.get("cmake")?.replace(/cmake(\.exe)?$/, process.platform === "win32" ? "ctest.exe" : "ctest") ?? "ctest"
            : framework === "idf"
              ? byKind.get("idf") ?? "idf.py"
              : framework === "pytest"
                ? process.platform === "win32" ? "python" : "python3"
                : "test";
    const target =
      framework === "twister" && input.native === true ? "native_sim" : input.target ? String(input.target) : undefined;
    const command = testCommand({
      framework,
      program,
      cwd: framework === "ctest" ? ctestDir(ctx.cwd) : ctx.cwd,
      ...(target ? { target } : {}),
      ...(Array.isArray(input.extra_args) ? { extraArgs: input.extra_args.map(String) } : {}),
    });
    const started = Date.now();
    const result = await run(command.program, command.args, ctx.cwd, Math.min(600_000, Number(input.timeout_ms ?? 600_000)));
    const parsed = parseTestOutput(framework, result.output);
    const runResult: TestRunResult = {
      framework,
      command: `${command.program} ${command.args.join(" ")}`,
      ok: result.code === 0 && (parsed.totals?.failed ?? parsed.cases.filter((entry) => entry.status === "failed").length) === 0,
      cases: parsed.cases,
      ...(parsed.totals ? { totals: parsed.totals } : {}),
      durationMs: Date.now() - started,
      output: result.output,
    };
    const summary = summarizeTests(runResult);
    return {
      ...(runResult.ok ? {} : { isError: true }),
      content: `${summary}\n\ncommand: ${runResult.command}`,
      display: runResult.ok ? "tests passed" : "tests failed",
      data: {
        ok: runResult.ok,
        framework,
        cases: runResult.cases,
        ...(runResult.totals ? { totals: runResult.totals } : {}),
      },
    };
  },
};

// ---- embed_trace -----------------------------------------------------------

const traceTool: Tool = {
  name: "embed_trace",
  description:
    "Capture a log channel that does not need a UART: J-Link or probe-rs RTT, or SWO. Use it when the board has no spare serial port, or when the console is already wired to something else. Output is parsed into the same line model as embed_serial.",
  readonly: true,
  parameters: {
    type: "object",
    properties: {
      channel: { type: "string", enum: ["rtt", "swo"], description: "Which channel to read (default rtt)" },
      tool: { type: "string", enum: ["probe-rs", "jlink"], description: "Which tool to drive; defaults to what is installed" },
      target: { type: "string", description: "Target chip name" },
      probe: { type: "string", description: "Probe serial/uid" },
      timeout_ms: { type: "integer", description: "How long to capture, default 5000" },
      until: { type: "string", description: "Stop when a line matches this pattern" },
      max_lines: { type: "integer", description: "Stop after this many lines, default 500" },
    },
    additionalProperties: false,
  },
  summarize: (input) => `${input.channel ?? "rtt"} trace`,
  async execute(input, ctx): Promise<ToolResult> {
    const report = await detectToolchains();
    const byKind = new Map(report.tools.map((entry) => [entry.kind, entry.path]));
    const requested = input.tool === "jlink" ? "jlink" : input.tool === "probe-rs" ? "probe-rs" : byKind.get("probe-rs") ? "probe-rs" : byKind.get("jlink") ? "jlink" : null;
    if (!requested) {
      return {
        isError: true,
        content: "Neither probe-rs nor J-Link is installed, so no RTT or SWO channel is available.",
        display: "no probe tool",
      };
    }
    const program = byKind.get(requested) ?? requested;
    const channel = (input.channel as TraceChannel | undefined) ?? "rtt";
    const plan = traceCommand({
      channel,
      program: requested,
      ...(input.target ? { target: String(input.target) } : {}),
      ...(input.probe ? { probe: String(input.probe) } : {}),
    });
    if (!plan) {
      return { isError: true, content: `SWO is not available through ${requested}; use probe-rs.`, display: "unsupported" };
    }
    const timeoutMs = Math.min(60_000, Math.max(200, Number(input.timeout_ms ?? 5000)));
    const maxLines = Math.max(1, Math.min(2000, Number(input.max_lines ?? 500)));
    let until: RegExp | undefined;
    if (input.until) {
      try {
        until = new RegExp(String(input.until));
      } catch (err) {
        return { isError: true, content: `invalid pattern: ${(err as Error).message}`, display: "bad pattern" };
      }
    }

    // J-Link has no RTT subcommand: the channel is started by a Commander
    // script fed on stdin.
    const args = requested === "jlink" && channel === "rtt" ? ["-NoGui", "1", "-CommandFile", "-"] : plan.args;
    const result = await new Promise<{ code: number | null; output: string; timedOut: boolean }>((resolve) => {
      const child = spawn(program, args, { cwd: ctx.cwd, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      let output = "";
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill();
        } catch {
          /* gone */
        }
      }, timeoutMs);
      const stop = () => {
        if (until && until.test(output)) {
          try {
            child.kill();
          } catch {
            /* gone */
          }
        }
      };
      child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString("utf8");
        stop();
      });
      child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
      child.on("error", (err) => {
        clearTimeout(timer);
        resolve({ code: null, output: `${output}\n${err.message}`, timedOut });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code, output, timedOut });
      });
      if (requested === "jlink" && channel === "rtt") child.stdin.end(jlinkRttScript(String(input.target ?? "")));
      else child.stdin.end();
    });

    const split = splitTraceChunk("", result.output);
    const lines = split.lines.map((raw, index) => parseTraceLine(raw, index)).slice(0, maxLines);
    if (lines.length === 0) {
      return {
        content:
          `${channel} on ${requested}: no lines in ${timeoutMs} ms` +
          (result.code !== 0 && result.code !== null ? ` (exit ${result.code})` : "") +
          `\nraw output tail:\n${result.output.split(/\r?\n/).slice(-15).join("\n")}`,
        display: "0 lines",
      };
    }
    const body = lines.map((line) => `${line.level ? `${line.level.toUpperCase().padEnd(5)} ` : ""}${line.tag ? `${line.tag}: ` : ""}${line.text}`);
    return {
      content: `${channel} on ${requested}: ${lines.length} line(s)${result.timedOut ? " (timed out)" : ""}\n${body.join("\n")}`,
      display: `${lines.length} lines`,
      data: { channel, tool: requested, lines: lines.length },
    };
  },
};

// ---- embed_measure ---------------------------------------------------------

const measureTool: Tool = {
  name: "embed_measure",
  description:
    "Measure voltage, current and power on the target's supply through an instrument the user has attached (SCPI bench supply, Joulescope, Nordic PPK2). Returns mean, peak and charge over the capture window. Reports which instruments are present when none is configured.",
  readonly: true,
  parameters: {
    type: "object",
    properties: {
      duration_ms: { type: "integer", description: "Capture window, default 2000" },
      instrument: { type: "string", description: "Which instrument: scpi, joulescope, ppk2. Default: the first available" },
      port: { type: "string", description: "Serial port or VISA resource for the instrument" },
      rate_hz: { type: "integer", description: "Samples per second, when the instrument allows it" },
    },
    additionalProperties: false,
  },
  summarize: (input) => `measure ${Number(input.duration_ms ?? 2000) / 1000}s`,
  async execute(input): Promise<ToolResult> {
    const report = await detectToolchains();
    // Kinds cover the CLIs this build knows about; a path that merely contains
    // the program name covers a user-installed driver detected as `unknown`.
    const installed = (name: string) =>
      report.tools.some((entry) => entry.kind === name || entry.path.toLowerCase().includes(name.toLowerCase()));
    const available = INSTRUMENTS.map((instrument) => ({
      ...instrument,
      available: instrument.programs.some((program) => installed(program)),
    }));
    const usable = available.filter((instrument) => instrument.available);
    const chosen = input.instrument ? String(input.instrument) : usable[0]?.kind;
    if (!chosen || !usable.some((instrument) => instrument.kind === chosen)) {
      return {
        isError: true,
        content:
          "No measurement instrument is available. Install one of: " +
          available.map((instrument) => `${instrument.kind} (${instrument.detail})`).join(", ") +
          ". Until then, power cannot be measured — do not estimate it from the firmware.",
        display: "no instrument",
      };
    }
    const request = {
      durationMs: Math.max(100, Number(input.duration_ms ?? 2000)),
      ...(input.rate_hz ? { rateHz: Number(input.rate_hz) } : {}),
    };
    if (chosen === "pyvisa" || chosen === "scpi") {
      const python = process.platform === "win32" ? "python" : "python3";
      // A short script keeps the VISA dependency optional: it is only imported
      // when a measurement is actually requested.
      const script = [
        "import sys",
        "import pyvisa",
        "rm = pyvisa.ResourceManager()",
        input.port
          ? `res = rm.open_resource(${JSON.stringify(String(input.port))})`
          : "res = rm.open_resource(rm.list_resources()[0])",
        "for cmd in " + JSON.stringify(scpiCommands(request)) + ":",
        "    res.write(cmd)",
        `import time`,
        `deadline = time.time() + ${request.durationMs} / 1000`,
        "while time.time() < deadline:",
        "    v = float(res.query('MEAS:VOLT?'))",
        "    i = float(res.query('MEAS:CURR?'))",
        "    print(f'{v:.6f} {i:.9f}')",
      ].join("\n");
      const result = await run(python, ["-c", script], process.cwd(), request.durationMs + 10_000);
      if (result.code !== 0) {
        return { isError: true, content: `the instrument did not answer: ${result.output.slice(-800)}`, display: "instrument error" };
      }
      const samples = result.output
        .split(/\r?\n/)
        .map((line) => line.trim().split(/\s+/).map(Number))
        .filter((pair) => pair.length === 2 && pair.every((value) => Number.isFinite(value)))
        .map((pair, index) => ({ t: index, voltage: pair[0], current: pair[1] }));
      const measurement = summarizeSamples(chosen, samples);
      return { content: formatMeasurement(measurement), display: `${samples.length} samples`, data: measurement };
    }
    // A driver without a wired protocol yet says so instead of reporting a
    // zero, which would read as "the board draws no current".
    return {
      isError: true,
      content:
        `${chosen} is installed but this build has no driver for it yet. ` +
        `Use a SCPI instrument (pyvisa) for now, or export its output to a file and read it with read_file.`,
      display: "driver missing",
    };
  },
};

// ---- embed_power -----------------------------------------------------------

const powerTool: Tool = {
  name: "embed_power",
  description:
    "Power-cycle the board through a controllable USB port (uhubctl) or a relay command, optionally capturing the console after each cycle. Use it to reproduce cold-boot failures, or to see whether a problem survives a power cycle. Requires a relay or a powered hub the user has configured; nothing is switched without one.",
  readonly: false,
  parameters: {
    type: "object",
    properties: {
      cycles: { type: "integer", description: "How many cycles, default 3, max 20" },
      port: { type: "string", description: "uhubctl port number, e.g. `2`" },
      command_on: { type: "string", description: "A shell command that turns the port on, instead of uhubctl" },
      command_off: { type: "string", description: "A shell command that turns it off" },
      settle_ms: { type: "integer", description: "Wait after power-on before capturing, default 800" },
    },
    additionalProperties: false,
  },
  summarize: (input) => `${Number(input.cycles ?? 3)} power cycles`,
  async execute(input): Promise<ToolResult> {
    const device: PowerDevice | null = input.command_on
      ? { kind: "command", target: String(input.command_on), offArgs: input.command_off ? [String(input.command_off)] : undefined }
      : input.port
        ? { kind: "uhubctl", target: String(input.port) }
        : null;
    if (!device) {
      return {
        isError: true,
        content:
          "No power control is configured. Pass `port` (a uhubctl port number) or `command_on`/`command_off` " +
          "(commands that switch the supply). Without a switchable port this tool cannot do anything, and pretending otherwise would be worse than saying so.",
        display: "no power control",
      };
    }
    const count = Math.max(1, Math.min(20, Number(input.cycles ?? CYCLE_DEFAULTS.count)));
    const settle = Math.max(100, Math.min(10_000, Number(input.settle_ms ?? CYCLE_DEFAULTS.settleMs)));
    const plan = { count, settleMs: settle, captureMs: CYCLE_DEFAULTS.captureMs, description: "" };
    const description = describePlan(plan, device);
    const commands = powerCommands(device);
    const cycles: { cycle: number; ok: boolean; output: string }[] = [];
    for (let cycle = 1; cycle <= count; cycle++) {
      const off = await runPowerCommand(commands.program, commands.off, 10_000);
      await new Promise((resolve) => setTimeout(resolve, settle));
      const on = await runPowerCommand(commands.program, commands.on, 10_000);
      cycles.push({ cycle, ok: off.code === 0 && on.code === 0, output: `${off.output}\n${on.output}`.trim() });
      if (!on || on.code !== 0) break;
      await new Promise((resolve) => setTimeout(resolve, settle));
    }
    const failed = cycles.filter((entry) => !entry.ok).length;
    return {
      ...(failed > 0 ? { isError: true } : {}),
      content:
        `${description}\n` +
        cycles.map((entry) => `cycle ${entry.cycle}: ${entry.ok ? "ok" : "failed"}${entry.output ? ` (${entry.output.slice(0, 200)})` : ""}`).join("\n"),
      display: `${cycles.length - failed}/${cycles.length} cycles`,
      data: { plan: description, cycles },
    };
  },
};

// ---- embed_packs -----------------------------------------------------------

const packsTool: Tool = {
  name: "embed_packs",
  description:
    "Look up a part in installed CMSIS-Packs: its SVD, flash/RAM size and the pack file it came from. Works for any vendor that ships a pack, which is the vendor-neutral way to answer 'where is this chip's register map'. Also lists what is installed.",
  readonly: true,
  parameters: {
    type: "object",
    properties: {
      device: { type: "string", description: "Part name, e.g. `STM32F429ZI`. Omit to list installed packs" },
      include_svd_path: { type: "boolean", description: "Return the absolute SVD path so embed_registers can use it" },
    },
    additionalProperties: false,
  },
  summarize: (input) => String(input.device ?? "packs"),
  async execute(input, ctx): Promise<ToolResult> {
    if (input.device) {
      const found = findDeviceInPacks(String(input.device), ctx.cwd);
      if (!found) {
        const installed = installedPacks(ctx.cwd);
        return {
          isError: true,
          content:
            installed.length === 0
              ? "No CMSIS-Packs are installed. Install one with `cpackget add <vendor>::<pack>` or from the vendor's pack manager, then try again."
              : `${input.device} was not found in the ${installed.length} installed pack(s). Check the part name, or install its pack.`,
          display: "not found",
        };
      }
      const { device, svdPath } = found;
      const lines = [`${device.name}${device.vendor ? ` (${device.vendor})` : ""}`, `source: ${citePack(device, ctx.cwd)}`];
      if (device.processor) lines.push(`core: ${device.processor}`);
      if (device.flash) lines.push(`flash: ${(device.flash / 1024).toFixed(0)} KiB`);
      if (device.ram) lines.push(`ram: ${(device.ram / 1024).toFixed(0)} KiB`);
      if (svdPath && input.include_svd_path) lines.push(`svd: ${svdPath}`);
      else if (device.svd) lines.push(`svd: ${device.svd}${svdPath ? "" : " (file not present in the pack)"}`);
      return { content: lines.join("\n"), display: device.name, data: { device, svdPath: svdPath ?? null } };
    }
    const index = readPackIndex(ctx.cwd);
    const installed = installedPacks(ctx.cwd);
    if (installed.length === 0) {
      return {
        content:
          "No CMSIS-Packs are installed." +
          (index ? ` The index lists ${index.entries.length} packs (${index.source}).` : " No index.pidx was found either."),
        display: "0 packs",
      };
    }
    return {
      content:
        `${installed.length} pack(s) installed` +
        (index ? `, index lists ${index.entries.length}` : "") +
        `:\n` +
        installed.map((pack) => `  ${pack.path.replace(/\\/g, "/")}`).join("\n"),
      display: `${installed.length} packs`,
    };
  },
};

/**
 * Search the datasheet PDFs in the workspace.
 *
 * The reference manual is the ground truth for anything the SVD does not
 * describe (a timing rule, an errata workaround, a pin's alternate function).
 * Reading it page by page is not an option, so the pages are indexed locally
 * and a hit names its page. A machine without `pdftotext` is told which
 * command installs it rather than being given an empty result.
 */
const datasheetTool: Tool = {
  name: "embed_datasheet",
  description:
    "Search the PDF datasheets and reference manuals in the workspace for a phrase (a register name, an errata symptom, a pin function). Returns the file, page number, and the surrounding text. Requires pdftotext on PATH; the tool says how to install it when it is missing.",
  readonly: true,
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "A phrase to find, e.g. 'alternate function PA9' or 'Errata 2.1.4'" },
      limit: { type: "integer", description: "Maximum hits to return (default 12)" },
    },
    required: ["query"],
    additionalProperties: false,
  },
  summarize: (input) => String(input.query ?? ""),
  async execute(input, ctx) {
    const query = String(input.query ?? "").trim();
    if (!query) return { isError: true, content: "Provide a phrase to search for." };
    const result = await searchDatasheets(ctx.cwd, query, Number(input.limit) > 0 ? Number(input.limit) : 12);
    const text = formatDatasheetHits(result);
    return {
      isError: result.extractor === null,
      content: text,
      display: result.hits.length ? `${result.hits.length} page(s)` : "no match",
    };
  },
};

/**
 * Which pin a peripheral function is on, from the sources that actually know.
 *
 * There is no vendor-neutral pin database, so this reads what the workspace
 * has (devicetree overlays, a `pins.csv`) and, when the caller names a chip,
 * the SVD's alternate-function fields. It reports the package pin only when a
 * source states one; otherwise the answer is "PA9, package pin unknown" rather
 * than a guessed number.
 */
const pinmapTool: Tool = {
  name: "embed_pinmap",
  description:
    "Report which physical pins peripheral functions use. Reads devicetree overlays and a pins.csv in the workspace, plus the SVD's alternate-function fields when a chip is known. Package pin numbers are only reported when a source states them; otherwise the pin is named by port (PA9) and the package number is marked unknown.",
  readonly: true,
  parameters: {
    type: "object",
    properties: {
      svd: { type: "string", description: "Optional .svd path to read alternate-function data from" },
      filter: { type: "string", description: "Only show pins whose name or function contains this text" },
    },
    additionalProperties: false,
  },
  summarize: (input) => String(input.filter ?? "workspace pins"),
  async execute(input, ctx) {
    const { pinSourceFiles, pinsFromDts, pinsFromTable, pinsFromSvd, mergePinMaps, formatPinMap, readIfFile } = await import(
      "../embedded/pinmap.ts"
    );
    const files = pinSourceFiles(ctx.cwd);
    const maps = [];
    for (const file of files.dts.slice(0, 8)) {
      const text = readIfFile(file);
      if (text) maps.push(pinsFromDts(text, file.slice(ctx.cwd.length + 1)));
    }
    for (const file of files.tables) {
      const text = readIfFile(file);
      if (text) maps.push(pinsFromTable(text, file.slice(ctx.cwd.length + 1)));
    }
    if (input.svd) {
      const { parseSvd } = await import("../embedded/svd.ts");
      const path = join(ctx.cwd, String(input.svd));
      const text = readIfFile(path);
      if (text) maps.push(pinsFromSvd(parseSvd(text)));
      else maps.push({ assignments: [], sources: [], notes: [`${input.svd} could not be read`] });
    }
    const merged = mergePinMaps(maps);
    const filter = String(input.filter ?? "").trim().toLowerCase();
    const filtered = filter
      ? {
          ...merged,
          assignments: merged.assignments.filter(
            (assignment) =>
              assignment.pin.toLowerCase().includes(filter) || assignment.function.toLowerCase().includes(filter),
          ),
        }
      : merged;
    return {
      content: formatPinMap(filtered),
      display: `${filtered.assignments.length} pin(s)`,
    };
  },
};

export const runtimeTools: Tool[] = [testTool, traceTool, measureTool, powerTool, packsTool, datasheetTool, pinmapTool];
