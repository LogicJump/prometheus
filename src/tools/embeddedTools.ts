/**
 * The tools the model calls to touch hardware.
 *
 * These are thin on purpose. Every one of them delegates to an adapter in
 * `src/embedded/` and returns that adapter's structured result verbatim, so
 * the model never has to parse a flasher's prose and the adapters can be
 * tested without a model in the loop.
 *
 * What is *not* thin is the guard rails:
 *
 *   - `embed_flash` and `embed_reset` change physical state, so they are not
 *     readonly and the pipeline asks the user in `ask` mode.
 *   - Both refuse to run when no probe is attached, and the refusal names what
 *     was looked for. "No probe" is a different problem from "wrong target",
 *     and the model must be able to tell them apart.
 *   - A build that produced no artifact does not silently proceed to flash.
 */

import type { BoardSelection, Tool, ToolContext, ToolResult } from "../types.ts";
import { toolEnv } from "../embedded/toolEnv.ts";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import { build } from "../embedded/build.ts";
import { flash, type FlasherKind } from "../embedded/flash.ts";
import { recordFlash, readFlashHistory, formatFlashHistory } from "../embedded/flashHistory.ts";
import { findFlasherArgs } from "../embedded/espIdf.ts";
import { findDeviceInPacks, packRoots as packRootsFor } from "../embedded/cmsisPack.ts";
import { runtimeTools } from "./embeddedRuntimeTools.ts";
import { installHintLines } from "../embedded/installHints.ts";
import { checkServerPort } from "../embedded/serverPort.ts";
import { isPortOpen, recentPortLines } from "../embedded/serial.ts";
import { decodeFault, faultAddressValidity, faultReadCommands, formatFault, parseMemoryBytes, type FaultWords } from "../embedded/fault.ts";
import {
  decodeValue,
  encodeValue,
  getSession,
  putSession,
  readMemory,
  sessionKey,
  writeMemory,
} from "../embedded/debugSession.ts";
import { capture, listSerialPorts, openPort } from "../embedded/serial.ts";
import { listProbes, listTargets, matchTarget } from "../embedded/probe.ts";
import { detectToolchains } from "../embedded/toolchain.ts";
import { detectProject, buildCommand } from "../embedded/project.ts";
import { findRegister, parseSvd, peripheralDetail } from "../embedded/svd.ts";
import { analyze, parseStackUsage } from "../embedded/analyze.ts";
import {
  MiSession,
  type MiRecord,
  openocdConfigsFor,
  parseStackFrames,
  parseStopReason,
  parseVariables,
  serverCommand,
} from "../embedded/debug.ts";

/** The flasher paths the machine actually has, keyed by kind. */
async function flasherPaths(): Promise<{ paths: Partial<Record<FlasherKind, string>>; report: Awaited<ReturnType<typeof detectToolchains>> }> {
  const report = await detectToolchains();
  const byKind = new Map(report.tools.map((entry) => [entry.kind, entry.path]));
  return {
    paths: {
      pyocd: byKind.get("pyocd"),
      openocd: byKind.get("openocd"),
      "probe-rs": byKind.get("probe-rs"),
      jlink: byKind.get("jlink"),
      esptool: byKind.get("esptool"),
      "st-flash": byKind.get("st-flash"),
      "dfu-util": byKind.get("dfu-util"),
      avrdude: byKind.get("avrdude"),
    } as Partial<Record<FlasherKind, string>>,
    report,
  };
}

/** Pick a flasher: the requested one, else the first installed in preference order. */
const FLASHER_PREFERENCE: FlasherKind[] = ["pyocd", "probe-rs", "openocd", "esptool", "st-flash", "dfu-util", "avrdude", "jlink"];

function chooseFlasher(requested: string | undefined, paths: Partial<Record<FlasherKind, string>>): FlasherKind | null {
  if (requested) {
    const kind = requested as FlasherKind;
    return paths[kind] ? kind : null;
  }
  return FLASHER_PREFERENCE.find((kind) => Boolean(paths[kind])) ?? null;
}

function flasherHint(paths: Partial<Record<FlasherKind, string>>): string {
  const installed = Object.keys(paths).filter((kind) => paths[kind as FlasherKind]);
  return installed.length
    ? `Installed: ${installed.join(", ")}.`
    : "None installed. pyOCD (pip install pyocd) or probe-rs (cargo install probe-rs-tools) are the easiest starting points.";
}

/**
 * The board a tool should act on.
 *
 * `effectiveBoard` wins over the saved selection: it carries a target derived
 * from the part that answered the probe, while `config.board` is a memory of
 * the last board someone picked. A tool that used the saved value would flash
 * the wrong chip on a desk where the board was swapped and the pane reopened —
 * which is exactly the case the pane was rebuilt to prevent.
 *
 * The CLI never sets `effectiveBoard`, so it keeps using the selection there.
 */
function selectedBoard(ctx: ToolContext): BoardSelection {
  const live = ctx.config.effectiveBoard;
  if (!live) return ctx.config.board ?? {};
  const saved = ctx.config.board ?? {};
  return {
    ...saved,
    ...(live.target ? { target: live.target } : {}),
    ...(live.port ? { port: live.port } : {}),
    ...(live.baud ? { baud: live.baud } : {}),
    ...(live.flasher ? { flasher: live.flasher as BoardSelection["flasher"] } : {}),
  };
}

/**
 * An explicit argument wins over the pane selection, and the selection wins
 * over nothing at all.
 *
 * Only three tools consult this, because only these three do something whose
 * meaning depends on which board is attached. `embed_build` takes a Zephyr
 * board name, which is a different namespace from the flasher's chip name.
 */
function useBoard<T>(explicit: T | undefined, fromBoard: T | undefined): T | undefined {
  return explicit !== undefined ? explicit : fromBoard;
}

// ---- embed_build -----------------------------------------------------------

const buildTool: Tool = {
  name: "embed_build",
  description:
    "Build the embedded project in the workspace and return structured diagnostics. Detects Zephyr (west), ESP-IDF, PlatformIO, Arduino, Rust embedded, CMake, Make and recognises Keil/IAR projects it cannot build. Returns errors with file/line/column, the artifacts produced, and flash/RAM usage. Use this instead of `bash` for builds: it parses the compiler's output so you get diagnostics rather than log noise.",
  readonly: false,
  parameters: {
    type: "object",
    properties: {
      target: { type: "string", description: "Board or MCU name for ecosystems that need one, e.g. `nucleo_f411re` for Zephyr or a FQBN for Arduino" },
      release: { type: "boolean", description: "Build the release configuration when the ecosystem has one" },
      preset: { type: "string", description: "CMake preset name, when the project defines CMakePresets.json" },
      cwd: { type: "string", description: "Project directory relative to the workspace root; defaults to the workspace root" },
    },
    additionalProperties: false,
  },
  summarize: (input) => String(input.target ?? input.preset ?? "build"),
  async execute(input, ctx): Promise<ToolResult> {
    const cwd = input.cwd ? String(input.cwd) : ctx.cwd;
    const result = await build({
      ...(cwd ? { cwd } : {}),
      ...(input.target ? { target: String(input.target) } : {}),
      ...(input.release !== undefined ? { release: Boolean(input.release) } : {}),
      ...(input.preset ? { preset: String(input.preset) } : {}),
    });

    const sections = [result.summary];
    if (result.error) sections.push(`reason: ${result.error}`);
    if (!result.ok && result.diagnostics.length === 0 && result.tail) {
      sections.push("raw output (tail):", result.tail);
    }
    const content = sections.join("\n\n");

    return {
      ...(result.ok ? {} : { isError: true }),
      content,
      display: result.ok ? `built in ${(result.durationMs / 1000).toFixed(1)}s` : "build failed",
      data: {
        ok: result.ok,
        ...(result.usage ? { usage: { flash: result.usage.flash, ram: result.usage.ram } } : {}),
        artifacts: result.artifacts.map((artifact) => ({
          path: artifact.relative,
          bytes: artifact.bytes,
          kind: artifact.kind,
        })),
        diagnostics: result.diagnostics.length,
      },
    };
  },
};

// ---- embed_targets ---------------------------------------------------------

const targetsTool: Tool = {
  name: "embed_targets",
  description:
    "Report what this machine can build for and flash. Returns the installed toolchains with versions, the debug probes physically attached, the serial ports, the target chips this install knows, and the detected project kind. Call this before flashing when you do not already know the target name or whether a probe is connected.",
  readonly: true,
  parameters: {
    type: "object",
    properties: {
      filter: { type: "string", description: "Only show targets whose name, vendor, part or family contains this" },
      include_targets: { type: "boolean", description: "Include the full target list (can be long; default false shows a count and the first 20)" },
    },
    additionalProperties: false,
  },
  summarize: (input) => (input.filter ? `targets matching ${input.filter}` : "embedded inventory"),
  async execute(input, ctx): Promise<ToolResult> {
    const { paths, report } = await flasherPaths();
    const project = detectProject(ctx.cwd);
    // Build/board CLIs are not flashers, so they are not in `paths`; the
    // target fallback needs them and they are already detected in `report`.
    const byKind = new Map(report.tools.map((entry) => [entry.kind, entry.path]));
    const [probes, ports, targets] = await Promise.all([
      listProbes({ pyocd: paths.pyocd, "probe-rs": paths["probe-rs"], jlink: paths.jlink }),
      listSerialPorts(),
      listTargets(
        { pyocd: paths.pyocd },
        { filter: input.filter ? String(input.filter) : undefined, limit: input.include_targets ? 0 : 20 },
        {
          ...(byKind.get("pio") ? { pio: byKind.get("pio") } : {}),
          ...(byKind.get("west") ? { west: byKind.get("west") } : {}),
          ...(byKind.get("arduino-cli") ? { arduino: byKind.get("arduino-cli") } : {}),
          ...(paths["probe-rs"] ? { probeRs: paths["probe-rs"] } : {}),
        },
      ),
    ]);

    const lines: string[] = [];
    lines.push(`project: ${project.kind}${project.root !== ctx.cwd ? ` (${project.root})` : ""}`);
    if (project.evidence.length) lines.push(`  evidence: ${project.evidence.join(", ")}`);

    lines.push("", `toolchains: ${report.tools.length} found, ${report.missing.length} missing`);
    for (const entry of report.tools) lines.push(`  ${entry.kind}: ${entry.version || "installed"} (${entry.path})`);
    if (report.missing.length) {
      lines.push(`  missing: ${report.missing.join(", ")}`);
      lines.push(...installHintLines(report.missing).filter((line) => line.trim()));
    }

    lines.push("", `probes: ${probes.probes.length}`);
    for (const probe of probes.probes) {
      lines.push(`  ${probe.kind}: ${probe.name}${probe.serial ? ` [${probe.serial}]` : ""}${probe.target ? ` → ${probe.target}` : ""}`);
    }
    for (const note of probes.notes) lines.push(`  ${note}`);

    lines.push("", `serial ports: ${ports.length}`);
    for (const port of ports) lines.push(`  ${port.path}${port.board ? ` (${port.board})` : port.description ? ` (${port.description})` : ""}`);

    lines.push("", `targets: ${targets.total} known`);
    for (const note of targets.notes) lines.push(`  ${note}`);
    for (const target of targets.targets) {
      lines.push(`  ${target.name}  ${target.vendor}${target.part && target.part !== target.name ? ` / ${target.part}` : ""}`);
    }

    return {
      content: lines.join("\n"),
      display: `${probes.probes.length} probe(s), ${targets.total} targets`,
      data: {
        project: project.kind,
        toolchains: {
          found: report.tools.map((entry) => ({ kind: entry.kind, version: entry.version ?? null })),
          missing: report.missing,
        },
        probes: probes.probes,
        ports,
        targets: { total: targets.total, notes: targets.notes },
      },
    };
  },
};

// ---- embed_flash -----------------------------------------------------------

const flashTool: Tool = {
  name: "embed_flash",
  description:
    "Write firmware to the attached board and verify it. Build first — this does not build. Returns whether the write succeeded, whether the tool verified it, and the exact command. Refuses when no probe is attached, when the target is ambiguous, or when a raw .bin is given without a load address. Defaults to the board selected in the Board pane when omitted.",
  readonly: false,
  parameters: {
    type: "object",
    properties: {
      firmware: { type: "string", description: "Path to the .elf, .hex, .bin or .uf2 to write, relative to the workspace root" },
      target: { type: "string", description: "Target chip name, e.g. `stm32f412xe`. Required by pyOCD and probe-rs; for OpenOCD pass a .cfg path in target_config instead" },
      flasher: { type: "string", enum: ["pyocd", "probe-rs", "openocd", "esptool", "st-flash", "dfu-util", "avrdude", "jlink"], description: "Which tool to use; defaults to the first installed" },
      address: { type: "integer", description: "Load address for a raw .bin (0x08000000 on STM32, 0x0 on ESP32 boot images)" },
      probe: { type: "string", description: "Probe serial/uid, when several are attached" },
      interface_config: { type: "string", description: "OpenOCD interface config, e.g. `interface/stlink.cfg`" },
      target_config: { type: "string", description: "OpenOCD target config, e.g. `target/stm32f4x.cfg`" },
      reset: { type: "boolean", description: "Reset the board after writing; default true" },
      programmer: { type: "string", description: "avrdude programmer id (`-c`), e.g. `arduino` or `usbasp`. Required for avrdude" },
      part: { type: "string", description: "avrdude part id (`-p`), e.g. `atmega328p`. Required for avrdude" },
      port: { type: "string", description: "Serial port for a flasher that programs over one (avrdude, esptool), e.g. `COM3`" },
      history: { type: "boolean", description: "Return the recorded flash history for this session instead of flashing" },
    },
    required: [],
    additionalProperties: false,
  },
  summarize: (input) => String(input.firmware ?? ""),
  async execute(input, ctx): Promise<ToolResult> {
    const board = selectedBoard(ctx);
    if (input.history === true) {
      const records = readFlashHistory(ctx.sessionId ?? "");
      return { content: formatFlashHistory(records), display: `${records.length} flashes`, data: { records } };
    }
    if (!input.firmware) return { isError: true, content: "firmware is required (or pass history: true to list past flashes)" };
    const { paths } = await flasherPaths();
    const requestedFlasher = useBoard(input.flasher ? String(input.flasher) : undefined, board.flasher);
    const kind = chooseFlasher(requestedFlasher, paths);
    if (!kind) {
      return {
        isError: true,
        content: `No flasher installed. ${flasherHint(paths)}`,
        display: "no flasher",
      };
    }
    const program = paths[kind];
    if (!program) {
      return { isError: true, content: `${kind} is not installed. ${flasherHint(paths)}`, display: "no flasher" };
    }

    // Only refuse on a missing probe for the tools that enumerate one. OpenOCD
    // finds its own adapter from the interface config.
    if (kind === "pyocd" || kind === "probe-rs") {
      const probes = await listProbes({ pyocd: paths.pyocd, "probe-rs": paths["probe-rs"] });
      if (probes.probes.length === 0) {
        return {
          isError: true,
          content:
            `No debug probe is connected, so ${kind} has nothing to talk to. ` +
            `Check the USB cable and that the board is powered; run embed_targets to see what is detected.`,
          display: "no probe",
        };
      }
    }

    const target = useBoard(input.target ? String(input.target) : undefined, board.target);
    const probe = useBoard(input.probe ? String(input.probe) : undefined, board.probe);

    // An ESP-IDF build is several images at fixed offsets; the file next to
    // the application describes all of them. Flashing the application alone
    // produced a board that did not boot while the tool reported success.
    let espImages: { path: string; offset: number }[] | undefined;
    let espNote = "";
    if (kind === "esptool") {
      const plan = findFlasherArgs(String(input.firmware));
      if (typeof plan === "string") espNote = `\nnote: ${plan}`;
      else if (plan) {
        espImages = plan.images;
        espNote = `\nimages (from ${plan.source}): ` + plan.images.map((image) => `0x${image.offset.toString(16)} ${image.path}`).join(", ");
      }
    }

    const result = await flash({
      kind,
      program,
      firmware: String(input.firmware),
      ...(espImages ? { images: espImages } : {}),
      ...(target ? { target } : {}),
      ...(input.address !== undefined ? { address: Number(input.address) } : {}),
      ...(probe ? { probe } : {}),
      ...(input.interface_config ? { interfaceConfig: String(input.interface_config) } : {}),
      ...(input.target_config ? { targetConfig: String(input.target_config) } : {}),
      ...(input.reset !== undefined ? { reset: Boolean(input.reset) } : {}),
      ...(input.programmer ? { programmer: String(input.programmer) } : {}),
      ...(input.part ? { part: String(input.part) } : {}),
      ...((input.port ? String(input.port) : board.port) ? { port: String(input.port ?? board.port) } : {}),
    });

    // Every flash is recorded, successful or not: "what was on the board last
    // time this worked" is the question a regression actually asks, and the
    // transcript cannot answer it after a compaction.
    const recorded = ctx.sessionId
      ? recordFlash(ctx.sessionId, result, {
          firmware: String(input.firmware),
          ...(target ? { target } : {}),
          flasher: kind,
        })
      : null;
    const lines = [result.detail];
    if (result.reason && result.reason !== result.detail) lines.push(`reason: ${result.reason}`);
    if (recorded?.hash) lines.push(`image: ${recorded.hash}`);
    if (espNote) lines.push(...espNote.trim().split("\n"));
    if (result.command) lines.push(`command: ${result.command}`);
    if (result.verified !== undefined) lines.push(`verified: ${result.verified ? "yes" : "no"}`);
    lines.push(`elapsed: ${(result.durationMs / 1000).toFixed(1)}s`);
    if (!result.ok) lines.push("", "tool output (tail):", result.output.split("\n").slice(-25).join("\n"));

    return {
      ...(result.ok ? {} : { isError: true }),
      content: lines.join("\n"),
      display: result.ok ? "flashed" : "flash failed",
      data: {
        ok: result.ok,
        ...(result.verified !== undefined ? { verified: result.verified } : {}),
        ...(target ? { target } : {}),
        firmware: String(input.firmware),
        durationMs: result.durationMs,
      },
    };
  },
};

// ---- embed_serial ----------------------------------------------------------

const serialTool: Tool = {
  name: "embed_serial",
  description:
    "Read the board's serial console for a bounded time and return parsed log lines with timestamps, levels and tags. Use it to see whether the firmware booted, to catch a panic, or to wait for a readiness message. The read always stops: on the timeout, on a matching pattern, or at a line cap. Defaults to the board selected in the Board pane when omitted.",
  // Read-only, except for one argument. The label keeps a plain log tail free
  // of prompts (plan mode, ask-mode reads); `write` sends bytes to hardware,
  // which is why the tool also declares `mutation` — the permission layer then
  // stops treating the call as a read when that argument is present.
  readonly: true,
  /**
   * The one argument that makes this call a write.
   *
   * `readonly` is a static property of the tool, but this tool's danger is an
   * argument: reading the console is safe, sending bytes to a board is not.
   * The permission layer asks `mutation` when it is present, so `write` is
   * gated by the mode and never runs in plan mode.
   */
  mutation: (input) => (typeof input.write === "string" && input.write !== "" ? `serial write: ${String(input.write).slice(0, 40)}` : null),
  parameters: {
    type: "object",
    properties: {
      port: { type: "string", description: "Port name, e.g. `COM7` or `/dev/ttyACM0`. Omit to use the only attached port" },
      baud: { type: "integer", description: "Baud rate, default 115200" },
      timeout_ms: { type: "integer", description: "How long to listen, default 5000, max 60000" },
      until: { type: "string", description: "Stop as soon as a received line matches this regular expression" },
      max_lines: { type: "integer", description: "Stop after this many lines, default 2000" },
      only_errors: { type: "boolean", description: "Return only lines parsed as error or warning level" },
      write: { type: "string", description: "Text to send to the port after reading (no line ending is added)" },
      from_monitor: {
        type: "boolean",
        description: "Read what the Serial pane has already captured instead of opening the port; use when the monitor owns it",
      },
    },
    required: [],
    additionalProperties: false,
  },
  summarize: (input) => String(input.port ?? "serial"),
  async execute(input, ctx): Promise<ToolResult> {
    // The tool is readonly, so plan mode and the ask-mode auto-approval both
    // let it run without a confirmation. Asserting DTR resets most boards,
    // which changes physical state — a read must not do that behind a
    // read-only label. The switch is gone from the schema; an older model or a
    // saved prompt that still passes it gets told why instead of a silent reset.
    if (input.reset_on_connect === true) {
      return {
        isError: true,
        content:
          "embed_serial is read-only and never resets the board. It does not assert DTR. " +
          "If you need the boot banner, reset the board yourself (or use embed_reset) and then read.",
        display: "read-only",
      };
    }
    const board = selectedBoard(ctx);
    const ports = await listSerialPorts();
    let port = useBoard(input.port ? String(input.port) : undefined, board.port);
    if (!port) {
      if (ports.length === 0) {
        return { isError: true, content: "No serial ports found. Is the board plugged in?", display: "no port" };
      }
      if (ports.length > 1) {
        return {
          isError: true,
          content:
            `Several serial ports are attached; name one:\n` +
            ports.map((entry) => `  ${entry.path}${entry.board ? ` (${entry.board})` : entry.description ? ` (${entry.description})` : ""}`).join("\n"),
          display: "ambiguous port",
        };
      }
      port = ports[0].path;
    }

    let until: RegExp | undefined;
    if (input.until) {
      try {
        until = new RegExp(String(input.until));
      } catch (error) {
        return { isError: true, content: `invalid pattern: ${error instanceof Error ? error.message : String(error)}`, display: "bad pattern" };
      }
    }

    const timeoutMs = Math.min(60_000, Math.max(100, Number(input.timeout_ms ?? 5000)));
    const baud = Number(useBoard(input.baud !== undefined ? Number(input.baud) : undefined, board.baud) ?? 115200);

    // The Serial pane and this tool are the same process. When the monitor
    // holds the port, opening it again fails with an access error that reads
    // like a hardware problem; reading its ring is the honest answer, and it
    // is also what the user is looking at.
    if (input.from_monitor === true || isPortOpen(port)) {
      const recent = recentPortLines(port, Number(input.max_lines ?? 200));
      if (recent.length === 0) {
        return {
          content:
            `${port} is open in the Serial pane but has captured nothing yet. ` +
            `Start the monitor (or reset the board) and try again.`,
          display: "monitor buffer empty",
        };
      }
      const filtered = input.only_errors
        ? recent.filter((line) => /\b(ERR|ERROR|WARN|WARNING|FATAL)\b/i.test(line))
        : recent;
      return {
        content: `${port}: ${filtered.length} line(s) from the Serial pane buffer\n${filtered.slice(-500).join("\n")}`,
        display: `${filtered.length} line(s)`,
        data: { port, baud, lines: filtered.length, matched: false, timedOut: false, source: "monitor" },
      };
    }

    // Never assert DTR: a read must not reset the board, and the tool is
    // marked read-only so neither plan mode nor an auto-approval asks first.
    const result = await capture((path, rate) => openPort(path, rate, { assertDtr: false }), port, {
      timeoutMs,
      baud,
      ...(until ? { until } : {}),
      ...(input.max_lines !== undefined ? { maxLines: Number(input.max_lines) } : {}),
    });

    // A write is a separate open of the same port, which the OS will refuse
    // while the reader above still holds it. The reader has closed by the time
    // `capture` resolves, so the write opens its own short-lived handle.
    if (input.write !== undefined && String(input.write) !== "") {
      const text = String(input.write);
      if (process.platform === "win32") {
        try {
          await writePortText(port, baud, text);
          result.lines.push({ text: `(sent ${JSON.stringify(text)})`, raw: `(sent ${JSON.stringify(text)})` });
        } catch (err) {
          result.errors.push(`write failed: ${(err as Error).message}`);
        }
      } else {
        result.errors.push("serial write is implemented for Windows only");
      }
    }

    let lines = result.lines;
    if (input.only_errors) lines = lines.filter((line) => line.level === "error" || line.level === "warn");

    const body: string[] = [];
    body.push(`${port}: ${lines.length} line(s)${result.matched ? " (pattern matched)" : result.timedOut ? " (timed out)" : ""}`);
    for (const line of lines.slice(0, 500)) {
      const stamp = line.t !== undefined ? `[${(line.t / 1000).toFixed(3)}] ` : "";
      const level = line.level ? `${line.level.toUpperCase().padEnd(5)} ` : "";
      const tag = line.tag ? `${line.tag}: ` : "";
      body.push(`${stamp}${level}${tag}${line.text}`);
    }
    if (lines.length > 500) body.push(`… and ${lines.length - 500} more`);
    if (result.errors.length) body.push(`errors: ${result.errors.join("; ")}`);

    return {
      content: body.join("\n"),
      display: `${lines.length} line(s)`,
      data: {
        port,
        baud,
        lines: lines.length,
        matched: result.matched,
        timedOut: result.timedOut,
        levels: {
          error: lines.filter((line) => line.level === "error").length,
          warn: lines.filter((line) => line.level === "warn").length,
        },
      },
    };
  },
};

// ---- embed_ports -----------------------------------------------------------

const portsTool: Tool = {
  name: "embed_ports",
  description: "List the serial ports attached to this machine, with the USB vendor identified where possible. Use it to find the port name for embed_serial.",
  readonly: true,
  parameters: { type: "object", properties: {}, additionalProperties: false },
  summarize: () => "serial ports",
  async execute(): Promise<ToolResult> {
    const ports = await listSerialPorts();
    if (ports.length === 0) return { content: "No serial ports attached.", display: "none" };
    const lines = ports.map(
      (port) => `${port.path}${port.board ? ` — ${port.board}` : port.description ? ` — ${port.description}` : ""}${port.vid ? ` [${port.vid}:${port.pid ?? "?"}]` : ""}`,
    );
    return { content: lines.join("\n"), display: `${ports.length} port(s)` };
  },
};

// ---- embed_project ---------------------------------------------------------

const projectTool: Tool = {
  name: "embed_project",
  description:
    "Detect the embedded project in the workspace and report how it builds: the ecosystem, the evidence, the exact build command, and the artifacts it expects. Use it when embed_build reports an unrecognised project, or to check what command a build will run before running it.",
  readonly: true,
  parameters: {
    type: "object",
    properties: {
      cwd: { type: "string", description: "Directory to detect from, relative to the workspace root" },
    },
    additionalProperties: false,
  },
  summarize: () => "detect project",
  async execute(input, ctx): Promise<ToolResult> {
    const project = detectProject(input.cwd ? String(input.cwd) : ctx.cwd);
    const report = await detectToolchains();
    const map = Object.fromEntries(report.tools.map((entry) => [entry.kind, entry.path]));
    const command = buildCommand(project, map, {});

    const lines = [`kind: ${project.kind}`, `root: ${project.root}`];
    if (project.evidence.length) lines.push(`evidence: ${project.evidence.join(", ")}`);
    if (project.buildDir) lines.push(`build dir: ${project.buildDir}`);
    if (project.presets?.length) lines.push(`presets: ${project.presets.join(", ")}`);
    if (command) {
      lines.push("", `build: ${command.program} ${command.args.join(" ")}`, `in: ${command.cwd}`);
      if (command.artifactPatterns?.length) lines.push(`expects: ${command.artifactPatterns.join(", ")}`);
    } else if (project.kind === "keil" || project.kind === "iar") {
      lines.push("", `This is a ${project.kind === "keil" ? "Keil MDK" : "IAR EWARM"} project; its build needs the licensed IDE.`);
    } else {
      lines.push("", "no build command for this project kind");
    }
    return { content: lines.join("\n"), display: project.kind };
  },
};

// ---- embed_debug -----------------------------------------------------------

const debugTool: Tool = {
  name: "embed_debug",
  description:
    "Start a debug session on the attached board: halt at a breakpoint, read the call stack, inspect variables, step, and continue. Starts the probe's GDB server itself (OpenOCD, pyOCD, probe-rs or J-Link) and drives GDB over its machine interface. Returns structured frames and variables, not GDB's formatted text. Use it when the firmware runs but misbehaves — a wrong value, a hang, a hard fault — instead of adding print statements. Defaults to the target selected in the Board pane when omitted.",
  readonly: false,
  parameters: {
    type: "object",
    properties: {
      elf: { type: "string", description: "The .elf with debug symbols, relative to the workspace root" },
      target: { type: "string", description: "Target chip name the GDB server should use, e.g. `stm32f412xe`" },
      server: { type: "string", enum: ["openocd", "pyocd", "probe-rs", "jlink"], description: "Which GDB server to start; defaults to the first installed" },
      target_config: { type: "string", description: "OpenOCD target config, e.g. `target/stm32f4x.cfg`" },
      interface_config: { type: "string", description: "OpenOCD interface config, e.g. `interface/stlink.cfg`" },
      breakpoints: { type: "array", items: { type: "string" }, description: "Functions or file:line locations to break at before running" },
      action: {
        type: "string",
        enum: [
          "run",
          "backtrace",
          "variables",
          "continue",
          "step",
          "fault",
          "read",
          "write",
          "breakpoints",
          "breakpoint_delete",
          "watch",
          "threads",
          "close",
        ],
        description: "What to do once attached: run to the first breakpoint, read a backtrace, read variables, continue, or step one line. Default `run`.",
      },
      remote: { type: "string", description: "An already-running GDB server endpoint, e.g. `localhost:3333`. Skips starting a server." },
      probe: { type: "string", description: "Probe serial/uid, when several are attached" },
      address: { type: "integer", description: "For read/write: the memory or register address" },
      width: { type: "string", enum: ["u8", "u16", "u32"], description: "For read/write: access width (default u32)" },
      value: { type: "integer", description: "For write: the value to store" },
      count: { type: "integer", description: "For read: how many words to read (default 1)" },
      location: { type: "string", description: "For breakpoint_delete/watch: the breakpoint number or the watched expression" },
    },
    required: [],
    additionalProperties: false,
  },
  summarize: (input) => String(input.action ?? "debug"),
  async execute(input, ctx): Promise<ToolResult> {
    const board = selectedBoard(ctx);
    const target = useBoard(input.target ? String(input.target) : undefined, board.target);
    const probe = useBoard(input.probe ? String(input.probe) : undefined, board.probe);
    const action = (input.action as string | undefined) ?? "run";
    // An attach that only reads memory, registers or a fault status needs no
    // symbols. Requiring an ELF for a field investigation was the difference
    // between "look at the stuck board" and "go back and get the build output".
    const SYMBOL_FREE = new Set(["fault", "read", "write", "breakpoints", "threads", "close"]);
    const elf = input.elf ? String(input.elf) : "";
    if (!elf && !SYMBOL_FREE.has(action)) {
      return {
        isError: true,
        content:
          `this action needs an \`elf\` for symbols; pass one, or use one of ${[...SYMBOL_FREE].join(", ")} ` +
          `to work on the target without symbols.`,
        display: "no elf",
      };
    }
    const { paths } = await flasherPaths();
    const gdb = await gdbPath();
    if (!gdb) {
      return { isError: true, content: "No GDB found. Install the Arm GNU Toolchain, which ships arm-none-eabi-gdb.", display: "no gdb" };
    }

    const serverKind = (input.server as "openocd" | "pyocd" | "probe-rs" | "jlink" | undefined) ?? firstServer(paths);
    let server: ChildProcess | undefined;
    let remote = input.remote ? String(input.remote) : "";

    if (!remote) {
      if (!serverKind) {
        return {
          isError: true,
          content: `No GDB server installed, and no remote endpoint given. ${flasherHint(paths)}`,
          display: "no server",
        };
      }
      const program = paths[serverKind];
      if (!program) {
        return { isError: true, content: `${serverKind} is not installed.`, display: "no server" };
      }
      // Derive the OpenOCD target config from the chip name when the caller
      // did not name one; otherwise "tell me the chip and attach" cannot work.
      const derived =
        serverKind === "openocd" ? openocdConfigsFor(target) : {};
      const command = serverCommand(serverKind, program, {
        ...(target ? { target } : {}),
        ...(elf ? { elf } : {}),
        ...(probe ? { probe } : {}),
        ...(input.interface_config ? { interfaceConfig: String(input.interface_config) } : {}),
        ...(input.target_config ? { targetConfig: String(input.target_config) } : {}),
      });
      if (!command) {
        return {
          isError: true,
          content:
            serverKind === "openocd"
              ? "OpenOCD needs `target_config` (e.g. target/stm32f4x.cfg) and usually `interface_config`."
              : `${serverKind} needs a \`target\` chip name.`,
          display: "incomplete",
        };
      }

      // Something on the port is either the server this session wants or a
      // program fighting for the probe. Starting a second one fails with a USB
      // error that names neither.
      const conflict = await checkServerPort(command.port);
      if (conflict.open) {
        return {
          isError: true,
          content: conflict.message,
          display: "port busy",
        };
      }
      const started = await startServer(command);
      if (!started.ok) {
        return { isError: true, content: started.reason, display: "server failed" };
      }
      server = started.child;
      remote = `localhost:${command.port}`;
    }

    const events: MiRecord[] = [];
    const session = new MiSession({ gdb, elf, remote, onEvent: (record) => events.push(record) });
    try {
      const attach = await session.connect();
      if (!attach.ok) {
        return { isError: true, content: `could not attach: ${attach.body}`, display: "attach failed" };
      }

      const breakpoints = Array.isArray(input.breakpoints) ? input.breakpoints.map(String) : [];
      const inserted: string[] = [];
      for (const location of breakpoints) {
        const result = await session.send(`-break-insert ${JSON.stringify(location).slice(1, -1)}`);
        if (result.ok) inserted.push(location);
        else inserted.push(`${location} (failed: ${result.body})`);
      }

      const action = (input.action as string | undefined) ?? "run";
      const sections: string[] = [`attached to ${remote}${serverKind ? ` via ${serverKind}` : ""}`];
      if (inserted.length) sections.push(`breakpoints: ${inserted.join(", ")}`);

      if (action === "run") {
        // A remote target is already running when we attach; `run` only works
        // for a local process. GDB reports the remote case as an error, not a
        // failure of the session, so it becomes a continue.
        const result = await session.send("-exec-run", 20_000);
        if (!result.ok) await session.send("-exec-continue", 20_000);
        const stop = await waitForStop(events, 15_000);
        sections.push(...describeStop(stop));
      } else if (action === "continue") {
        await session.send("-exec-continue", 20_000);
        const stop = await waitForStop(events, 15_000);
        sections.push(...describeStop(stop));
      } else if (action === "step") {
        await session.send("-exec-step", 20_000);
        const stop = await waitForStop(events, 10_000);
        sections.push(...describeStop(stop));
      }

      if (action === "backtrace" || action === "run" || action === "continue" || action === "step") {
        const frames = await session.send("-stack-list-frames");
        const parsed = parseStackFrames(frames.body);
        if (parsed.length) {
          sections.push("", "backtrace:");
          for (const frame of parsed) {
            const where = frame.file ? ` at ${frame.file}:${frame.line ?? "?"}` : "";
            sections.push(`  #${frame.level} ${frame.func ?? "?"}${where}${frame.address ? ` (${frame.address})` : ""}`);
          }
        }
      }

      if (action === "variables" || action === "run" || action === "step") {
        const variables = await session.send("-stack-list-variables --simple-values");
        const parsed = parseVariables(variables.body);
        if (parsed.length) {
          sections.push("", "locals:");
          for (const variable of parsed) sections.push(`  ${variable.name} = ${variable.value}`);
        }
      }

      if (action === "fault") {
        const words = await readFaultWords(session);
        if (!words) {
          sections.push("could not read the fault registers; is the target a Cortex-M and stopped?");
        } else {
          sections.push(formatFault(decodeFault(words), words));
        }
      }

      if (action === "read") {
        const address = Number(input.address);
        if (!Number.isFinite(address)) {
          return { isError: true, content: "read needs an `address`", display: "missing address" };
        }
        const width = (input.width as "u8" | "u16" | "u32" | undefined) ?? "u32";
        const size = width === "u8" ? 1 : width === "u16" ? 2 : 4;
        const count = Math.max(1, Math.min(64, Number(input.count ?? 1)));
        const bytes = await readMemory(session, address, size * count);
        if (!bytes) {
          sections.push(`could not read ${count} ${width} at 0x${address.toString(16)}`);
        } else {
          sections.push(`memory at 0x${address.toString(16)} (${width} x${count}):`);
          for (let index = 0; index < count; index++) {
            const slice = bytes.slice(index * size, index * size + size);
            if (slice.length < size) break;
            const value = decodeValue(slice, width);
            sections.push(`  0x${(address + index * size).toString(16)} = ${value} (0x${value.toString(16)})`);
          }
        }
      }

      if (action === "write") {
        const address = Number(input.address);
        if (!Number.isFinite(address)) {
          return { isError: true, content: "write needs an `address`", display: "missing address" };
        }
        const value = Number(input.value);
        if (!Number.isFinite(value)) {
          return { isError: true, content: "write needs a `value`", display: "missing value" };
        }
        const width = (input.width as "u8" | "u16" | "u32" | undefined) ?? "u32";
        const outcome = await writeMemory(session, address, encodeValue(value, width));
        sections.push(outcome.detail);
        if (outcome.readBack) {
          sections.push(`read back: ${outcome.readBack.map((byte) => byte.toString(16).padStart(2, "0")).join(" ")}`);
        }
      }

      if (action === "breakpoints") {
        const list = await session.send("-break-list");
        sections.push(list.body || "(no breakpoints)");
      }

      if (action === "breakpoint_delete") {
        const number = Number(String(input.location ?? "").replace(/^#/, ""));
        if (!Number.isFinite(number)) {
          return { isError: true, content: "breakpoint_delete needs the breakpoint `location` number", display: "missing number" };
        }
        const result = await session.send(`-break-delete ${number}`);
        sections.push(result.ok ? `deleted breakpoint ${number}` : `could not delete ${number}: ${result.body}`);
      }

      if (action === "watch") {
        const expression = String(input.location ?? "").trim();
        if (!expression) {
          return { isError: true, content: "watch needs an expression in `location`", display: "missing expression" };
        }
        const result = await session.send(`-break-watch ${JSON.stringify(expression).slice(1, -1)}`);
        sections.push(result.ok ? `watching ${expression}` : `could not watch ${expression}: ${result.body}`);
      }

      if (action === "threads") {
        const result = await session.send("-thread-info");
        const threads = parseThreads(result.body);
        sections.push(threads.length ? "threads:" : "the target reports no threads (bare-metal, or no RTOS awareness)");
        for (const thread of threads) sections.push(`  #${thread.id} ${thread.name ?? ""}`);
      }

      if (action === "close") sections.push("debug session closed");

      // Keep the session alive between calls unless asked to close it. The
      // server holds the probe and the breakpoints, so re-attaching on every
      // call threw away exactly the state debugging is about.
      const key = sessionKey(remote, target, elf);
      if (action !== "close") {
        putSession({ key, session, ...(server ? { server } : {}), remote, events, openedAt: Date.now() });
        sections.push("", `session: ${key} (kept open; pass action "close" to release the probe)`);
      }
      return { content: sections.join("\n"), display: `debug: ${action}` };
    } finally {
      // A session that was stored stays open; a closed or failed one is torn
      // down here, because its server would otherwise hold the probe.
      const key = sessionKey(remote, target, elf);
      const kept = getSession(key);
      if (!kept) {
        await session.close();
        server?.kill();
      }
    }
  },
};

/**
 * Send text to a COM port on Windows.
 *
 * The same PowerShell serialisation the reader uses; a separate, short-lived
 * open because the writer cannot share the reader's handle.
 */
async function writePortText(port: string, baud: number, text: string): Promise<void> {
  const { spawn } = await import("node:child_process");
  const payload = Buffer.from(text, "utf8").toString("base64");
  const script = [
    "$ErrorActionPreference='Stop'",
    `$p=New-Object System.IO.Ports.SerialPort '${port.replace(/'/g, "''")}',${baud || 115200}`,
    "$p.Open()",
    "$bytes=[Convert]::FromBase64String($env:PROM_WRITE)",
    "$p.Write($bytes,0,$bytes.Length)",
    "Start-Sleep -Milliseconds 80",
    "$p.Close()",
  ].join("\n");
  await new Promise<void>((resolve, reject) => {
    const child = spawn("powershell", ["-NoProfile", "-NonInteractive", "-Command", "-"], {
      env: { ...toolEnv(), PROM_WRITE: payload },
      windowsHide: true,
      stdio: ["pipe", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(stderr.trim() || `write failed (${code})`))));
    child.stdin.end(script);
  });
}

/** Read CFSR/HFSR/MMFAR/BFAR through the live session. */
async function readFaultWords(session: MiSession): Promise<FaultWords | null> {
  const [cfsr, hfsr, mmfar, bfar] = await Promise.all(faultReadCommands().map((command) => session.send(command)));
  const cfsrValue = parseMemoryBytes(cfsr.body);
  const hfsrValue = parseMemoryBytes(hfsr.body);
  if (cfsrValue === null || hfsrValue === null) return null;
  const validity = faultAddressValidity(cfsrValue);
  return {
    cfsr: cfsrValue,
    hfsr: hfsrValue,
    ...(validity.mmfarValid ? { mmfar: parseMemoryBytes(mmfar.body) ?? 0 } : {}),
    ...(validity.bfarValid ? { bfar: parseMemoryBytes(bfar.body) ?? 0 } : {}),
    ...validity,
  };
}

/** Parse `-thread-info` into a short list. */
function parseThreads(body: string): { id: string; name?: string }[] {
  const out: { id: string; name?: string }[] = [];
  const pattern = /id="([^"]+)"(?:[^}]*?name="([^"]+)")?/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(body)) !== null) {
    out.push({ id: match[1], ...(match[2] ? { name: match[2] } : {}) });
  }
  return out;
}

/** The Arm GDB, falling back to a plain gdb for host-side emulator runs. */
async function gdbPath(): Promise<string | null> {
  const report = await detectToolchains();
  const arm = report.tools.find((entry) => entry.kind === "gcc-arm");
  if (arm) {
    const candidate = arm.path.replace(/gcc(-ar)?(\.exe)?$/i, arm.path.endsWith(".exe") ? "gdb.exe" : "gdb");
    if (existsSync(candidate)) return candidate;
  }
  for (const name of ["arm-none-eabi-gdb", "arm-none-eabi-gdb.exe", "gdb", "gdb.exe"]) {
    for (const dir of (process.env.PATH ?? "").split(delimiter)) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function firstServer(paths: Partial<Record<FlasherKind, string>>): "openocd" | "pyocd" | "probe-rs" | "jlink" | undefined {
  for (const kind of ["pyocd", "openocd", "probe-rs", "jlink"] as const) if (paths[kind]) return kind;
  return undefined;
}

/** Start the GDB server and wait for its ready line. */
async function startServer(command: { program: string; args: string[]; readyPattern: RegExp; port: number }): Promise<
  { ok: true; child: ChildProcess } | { ok: false; reason: string }
> {
  return new Promise((resolve) => {
    const child = spawn(command.program, command.args, { env: toolEnv(), windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let seen = "";
    const timer = setTimeout(() => {
      child.kill();
      resolve({
        ok: false,
        reason: `the GDB server did not become ready within 15s. Its output:\n${seen.split("\n").slice(-15).join("\n")}`,
      });
    }, 15_000);

    const check = (chunk: Buffer) => {
      seen += chunk.toString("utf8");
      if (command.readyPattern.test(seen)) {
        clearTimeout(timer);
        resolve({ ok: true, child });
      }
    };
    child.stdout?.on("data", check);
    child.stderr?.on("data", check);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ ok: false, reason: `the GDB server exited (code ${code}) before listening:\n${seen.split("\n").slice(-15).join("\n")}` });
    });
  });
}

/**
 * Wait for a stop the agent can act on.
 *
 * A remote target emits stop events while attaching — the loader, a signal, a
 * thread start — none of which is the breakpoint the caller asked for. Waiting
 * for the first `*stopped` reports one of those and looks like the breakpoint
 * never hit. So the interesting reasons are ranked, and an uninteresting stop
 * is returned only if the timeout expires with nothing better.
 */
const INTERESTING_STOPS = /breakpoint-hit|watchpoint-trigger|watchpoint-scope|signal-received|exited|exited-normally|exited-signalled|end-stepping-range|function-finished/;

async function waitForStop(events: MiRecord[], timeoutMs: number): Promise<MiRecord | null> {
  const deadline = Date.now() + timeoutMs;
  let fallback: MiRecord | null = null;
  while (Date.now() < deadline) {
    const stops = events.filter((record) => record.class === "stopped");
    for (const stop of stops) {
      if (INTERESTING_STOPS.test(stop.body)) return stop;
      fallback ??= stop;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return fallback;
}

function describeStop(stop: MiRecord | null): string[] {
  if (!stop) return ["", "the target did not stop within the timeout (it may be running, or waiting on a breakpoint that was never reached)"];
  const parsed = parseStopReason(stop.body);
  const where = parsed.frame
    ? `${parsed.frame.func ?? "?"}${parsed.frame.file ? ` at ${parsed.frame.file}:${parsed.frame.line ?? "?"}` : ""}`
    : "(no frame reported)";
  return ["", `stopped: ${parsed.reason} in ${where}`];
}

// ---- embed_registers -------------------------------------------------------

/**
 * Where a CMSIS-SVD for a chip might be.
 *
 * No vendor or IDE is named here. Packs land in whatever root the pack manager
 * was told to use (`CMSIS_PACK_ROOT`), the two cmsis-pack-manager caches, and
 * any directory the user points at (`PROMETHEUS_SVD_DIRS`, path-separator
 * separated). The project may also carry its own under `.prometheus/svd/`.
 * Vendors differ in layout, so the lookup walks a pack root rather than
 * assuming one flat naming scheme.
 */
export function svdSearchDirs(cwd: string): string[] {
  const dirs: string[] = [];
  const push = (dir: string | undefined | null) => {
    if (!dir) return;
    const trimmed = dir.trim();
    if (trimmed && !dirs.includes(trimmed)) dirs.push(trimmed);
  };
  for (const entry of (process.env.PROMETHEUS_SVD_DIRS ?? "").split(delimiter)) push(entry);
  push(join(cwd, ".prometheus", "svd"));
  // The roots the CMSIS pack tools actually use, on every platform the
  // project runs on; the pack module owns the list so the two cannot drift.
  const packRoots = packRootsFor(cwd);
  for (const root of packRoots) {
    if (!root) continue;
    push(root);
    push(join(root, "CMSIS", "Packs"));
    push(join(root, ".Web"));
  }
  return dirs.filter((dir) => existsSync(dir));
}

/** Depth-limited walk for a file whose base name matches, so vendor trees work. */
function findUnder(root: string, wanted: string, depth = 6): string | null {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (entry.toLowerCase() === `${wanted}.svd`) return join(root, entry);
  }
  for (const entry of entries) {
    if (depth <= 0) break;
    const full = join(root, entry);
    try {
      if (!statSync(full).isDirectory()) continue;
    } catch {
      continue;
    }
    const found = findUnder(full, wanted, depth - 1);
    if (found) return found;
  }
  return null;
}

function findSvd(name: string, dirs: string[]): string | null {
  const wanted = name.toLowerCase();
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    const direct = join(dir, `${name}.svd`);
    if (existsSync(direct)) return direct;
    try {
      for (const entry of readdirSync(dir)) {
        if (entry.toLowerCase() === `${wanted}.svd`) return join(dir, entry);
      }
    } catch {
      /* unreadable */
    }
    const walked = findUnder(dir, wanted);
    if (walked) return walked;
  }
  return null;
}

/**
 * The chip names a project implies, most specific first.
 *
 * Project formats name their part in their own way (`nucleo_f411re`,
 * `CONFIG_IDF_TARGET="esp32s3"`, `-mcpu=cortex-m4`); none of them is a CMSIS
 * device name. Rather than hard-code one ecosystem's naming, read the likely
 * tokens out of the project files and let the SVD lookup find whichever one
 * has a matching file. The caller still states `device` explicitly when it
 * knows the part.
 */
function chipHintsFromProject(cwd: string): string[] {
  const hints: string[] = [];
  const add = (value: string | undefined | null) => {
    if (!value) return;
    const token = value.trim().replace(/^["']|["']$/g, "");
    if (!token) return;
    if (!hints.includes(token)) hints.push(token);
    // A board id like `nucleo_f411re` carries the part after the separator.
    for (const part of token.split(/[^A-Za-z0-9]+/)) {
      if (part.length >= 4 && !hints.includes(part)) hints.push(part);
    }
  };
  const read = (relative: string): string | null => {
    const file = join(cwd, relative);
    try {
      return existsSync(file) ? readFileSync(file, "utf8") : null;
    } catch {
      return null;
    }
  };

  const pio = read("platformio.ini");
  if (pio) {
    for (const match of pio.matchAll(/^\s*board\s*=\s*(\S+)/gim)) add(match[1]);
    for (const match of pio.matchAll(/^\s*board_build\.mcu\s*=\s*(\S+)/gim)) add(match[1]);
  }
  const sdkconfig = read("sdkconfig") ?? read("sdkconfig.defaults");
  if (sdkconfig) {
    const target = /CONFIG_IDF_TARGET\s*=\s*"?([\w-]+)"?/.exec(sdkconfig)?.[1];
    add(target);
  }
  const west = read("west.yml") ?? read("west.yaml") ?? read("prj.conf");
  if (west) {
    const soc = /CONFIG_SOC\s*=\s*"?([\w-]+)"?/.exec(west)?.[1] ?? /soc:\s*([\w-]+)/.exec(west)?.[1];
    add(soc);
  }
  // A CMake file usually names the core, and sometimes the device macro.
  for (const name of ["CMakeLists.txt", "CMakePresets.json", "CMakeCache.txt"]) {
    const text = read(name);
    if (!text) continue;
    const device = /(?:-D?)?([A-Za-z]+[0-9]{3,4}[A-Za-z]*)/.exec(text)?.[1];
    add(device);
    const processor = /CMAKE_SYSTEM_PROCESSOR:?[A-Z]*=?\s*"?([\w-]+)"?/.exec(text)?.[1];
    add(processor);
  }
  const mcu = read("mcu.h") ?? read("user_settings.h");
  if (mcu) {
    const define = /#define\s+([A-Za-z]+[0-9]{3,4}[A-Za-z]*)x?/i.exec(mcu)?.[1];
    add(define);
  }
  return hints;
}

const registersTool: Tool = {
  name: "embed_registers",
  description:
    "Look up a chip's register map from its CMSIS-SVD file. Returns peripheral base addresses, register offsets, field bit positions and enumerated values — the ground truth for writing peripheral code. Call it before touching a register you are not certain about: a wrong offset does not fail to compile, it silently drives the wrong peripheral.",
  readonly: true,
  parameters: {
    type: "object",
    properties: {
      device: { type: "string", description: "Chip name matching an installed SVD, e.g. `STM32F411`. Omit to use the board in the project" },
      peripheral: { type: "string", description: "One peripheral in full, e.g. `USART2`. Omit to get the whole chip's index" },
      register: { type: "string", description: "A specific register path, e.g. `USART2.CR1` or `USART2.CR1.UE`, to get its address and fields" },
      search: { type: "string", description: "Only in index mode: show peripherals whose name contains this" },
    },
    additionalProperties: false,
  },
  summarize: (input) => String(input.register ?? input.peripheral ?? input.device ?? "registers"),
  async execute(input, ctx): Promise<ToolResult> {
    const dirs = svdSearchDirs(ctx.cwd);
    // The board the user selected is the first source: they said which part
    // is on the desk, which beats any inference from project files.
    const board = selectedBoard(ctx);
    const hints = chipHintsFromProject(ctx.cwd);
    if (board.target && !hints.includes(board.target)) hints.unshift(board.target);
    const explicit = input.device ? String(input.device) : null;
    // The explicit name first, then whatever the project implies. Guessing a
    // name is only acceptable if the file it names actually exists; the
    // reported source path is what makes the answer checkable.
    const candidates = explicit ? [explicit] : hints;
    let svdPath: string | null = null;
    let deviceName: string | null = null;
    for (const candidate of candidates) {
      const found = findSvd(candidate, dirs);
      if (!found) continue;
      svdPath = found;
      deviceName = candidate;
      break;
    }
    if (!svdPath) {
      // A pack already installed on this machine is the vendor-neutral last
      // resort: its `.pdsc` names the SVD for the part.
      for (const candidate of candidates) {
        const packed = findDeviceInPacks(candidate, ctx.cwd);
        if (packed?.svdPath) {
          svdPath = packed.svdPath;
          deviceName = candidate;
          break;
        }
      }
    }
    if (!svdPath) {
      if (!explicit && hints.length === 0) {
        return {
          isError: true,
          content:
            "No chip named. Pass `device` (the CMSIS device name, e.g. STM32F411), or point PROMETHEUS_SVD_DIRS at a directory of .svd files.",
          display: "no device",
        };
      }
      return {
        isError: true,
        content:
          `No SVD found for ${explicit ?? `any of: ${hints.join(", ")}`}. Looked in:\n` +
          (dirs.length ? dirs.map((dir) => `  ${dir}`).join("\n") : "  (no SVD directory found)") +
          `\nSet PROMETHEUS_SVD_DIRS to a directory of .svd files, put them in .prometheus/svd/, or install a CMSIS pack.`,
        display: "no svd",
      };
    }

    let device;
    try {
      device = parseSvd(svdPath);
    } catch (error) {
      return { isError: true, content: `could not parse ${svdPath}: ${error instanceof Error ? error.message : String(error)}`, display: "parse failed" };
    }

    const provenance = `source: ${svdPath} (device ${device.name}${device.cpu ? `, ${device.cpu.name}` : ""})`;
    // Storage is stated before any peripheral: the file's own memory entries,
    // never a peripheral that merely happens to be called FLASH.
    const storage = device.memories?.length
      ? `memory: ${device.memories
          .map((memory) => `${memory.name} @0x${memory.start.toString(16).toUpperCase()} ${Math.round(memory.size / 1024)} KB`)
          .join(", ")}`
      : "memory: the SVD does not model the flash/SRAM regions, so their sizes are not in this map";

    if (input.register) {
      const path = String(input.register);
      const found = findRegister(device, path);
      if (!found) {
        return { isError: true, content: `${path} not found in ${device.name}.\n${provenance}`, display: "not found" };
      }
      const address = found.peripheral.baseAddress + found.register.offset;
      const lines = [`${path} → 0x${address.toString(16).toUpperCase().padStart(8, "0")}`, provenance, ""];
      lines.push(`${found.peripheral.name} base 0x${found.peripheral.baseAddress.toString(16)}`);
      lines.push(`${found.register.name} +0x${found.register.offset.toString(16)} (${found.register.size}b${found.register.access ? ` ${found.register.access}` : ""})`);
      if (found.register.resetValue !== undefined) lines.push(`reset 0x${found.register.resetValue.toString(16)}`);
      for (const field of found.register.fields) {
        // `[msb:lsb]`, the spelling every datasheet uses.
        const range =
          field.bitWidth === 1
            ? `[${field.bitOffset}]`
            : `[${field.bitOffset + field.bitWidth - 1}:${field.bitOffset}]`;
        const enums = field.enums ? ` {${Object.entries(field.enums).map(([k, v]) => `${k}=${v}`).join(", ")}}` : "";
        lines.push(`  ${field.name}${range}${enums}${field.description ? ` — ${field.description}` : ""}`);
      }
      return { content: lines.join("\n"), display: path };
    }

    if (input.peripheral) {
      const detail = peripheralDetail(device, String(input.peripheral));
      if (!detail) {
        return { isError: true, content: `${input.peripheral} not in ${device.name}.\n${provenance}`, display: "not found" };
      }
      return { content: `${detail}\n\n${provenance}`, display: String(input.peripheral) };
    }

    let periphs = device.peripherals;
    const search = input.search ? String(input.search).toLowerCase() : null;
    if (search) periphs = periphs.filter((peripheral) => peripheral.name.toLowerCase().includes(search));

    const lines: string[] = [];
    for (const peripheral of periphs) {
      const base = `0x${peripheral.baseAddress.toString(16).toUpperCase().padStart(8, "0")}`;
      lines.push(`${peripheral.name} @${base}${peripheral.description ? ` — ${peripheral.description.slice(0, 80)}` : ""}`);
      if (peripheral.registers.length) {
        lines.push(`  ${peripheral.registers.map((register) => `${register.name}+0x${register.offset.toString(16).toUpperCase()}`).join(" ")}`);
      }
    }
    if (!search) lines.unshift(storage, "");
    return {
      content: `${device.name}: ${periphs.length} peripheral(s)\n${lines.join("\n")}\n\n${provenance}\nAsk for a peripheral by name to get its full register and field detail.`,
      display: `${periphs.length} peripherals`,
    };
  },
};

// ---- embed_analyze ---------------------------------------------------------

const analyzeTool: Tool = {
  name: "embed_analyze",
  description:
    "Run static analysis (cppcheck, and clang-tidy when installed) over the firmware and return findings ranked by severity. Finds the bugs that compile cleanly and then fail on the board: out-of-bounds indices, null dereferences, uninitialised reads. Also reports flash/RAM headroom and worst-case stack depth when the build produced them. Use it after embed_build succeeds and before embed_flash — a clean link is not a correct program. A clean result is not proof: current cppcheck does not catch an interprocedural overflow through a pointer, so still read the code you changed.",
  readonly: true,
  parameters: {
    type: "object",
    properties: {
      paths: { type: "array", items: { type: "string" }, description: "Files or directories to analyse, relative to the workspace root. Default: the whole project" },
      enable: { type: "string", description: "cppcheck checks to enable, default `warning,style,performance,portability`" },
      thorough: { type: "boolean", description: "Use cppcheck's most expensive analysis (all checks, inconclusive, exhaustive value flow). Slower; use it when a defect is suspected and the default run was clean." },
      max_files: { type: "integer", description: "Cap on files analysed, default 400" },
    },
    additionalProperties: false,
  },
  summarize: (input) => (Array.isArray(input.paths) ? input.paths.join(" ") : "static analysis"),
  async execute(input, ctx): Promise<ToolResult> {
    const result = await analyze({
      cwd: ctx.cwd,
      ...(Array.isArray(input.paths) ? { paths: input.paths.map(String) } : {}),
      ...(input.enable ? { enable: String(input.enable) } : {}),
      ...(input.thorough !== undefined ? { thorough: Boolean(input.thorough) } : {}),
      ...(input.max_files !== undefined ? { maxFiles: Number(input.max_files) } : {}),
    });

    const lines = [result.summary];
    // The `.su` files a `-fstack-usage` build leaves behind answer the question
    // static analysis cannot: how much stack will this actually use.
    const stack = worstStack(ctx.cwd);
    if (stack.length > 0) {
      lines.push("", "largest stack frames (from .su files):");
      for (const frame of stack.slice(0, 8)) {
        lines.push(`  ${frame.bytes} B  ${frame.function}${frame.kind === "dynamic" ? " (dynamic — a lower bound)" : ""}  ${frame.file}:${frame.line}`);
      }
    }

    return {
      ...(result.ok ? {} : { isError: true }),
      content: lines.join("\n"),
      display: `${result.findings.length} finding(s)`,
    };
  },
};

/** The biggest `.su` frames found anywhere in the build tree. */
function worstStack(cwd: string): ReturnType<typeof parseStackUsage> {
  const frames: ReturnType<typeof parseStackUsage> = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 4) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      try {
        const stat = statSync(full);
        if (stat.isDirectory()) walk(full, depth + 1);
        else if (entry.endsWith(".su")) frames.push(...parseStackUsage(readFileSync(full, "utf8")));
      } catch {
        /* vanished */
      }
    }
  };
  walk(cwd, 0);
  return frames.sort((a, b) => b.bytes - a.bytes);
}

export const embeddedTools: Tool[] = [
  buildTool,
  flashTool,
  serialTool,
  portsTool,
  targetsTool,
  projectTool,
  debugTool,
  registersTool,
  analyzeTool,
  ...runtimeTools,
];
