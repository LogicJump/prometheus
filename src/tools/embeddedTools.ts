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

import type { Tool, ToolContext, ToolResult } from "../types.ts";
import { build } from "../embedded/build.ts";
import { flash, type FlasherKind } from "../embedded/flash.ts";
import { capture, listSerialPorts, openPort } from "../embedded/serial.ts";
import { listProbes, listTargets, matchTarget } from "../embedded/probe.ts";
import { detectToolchains } from "../embedded/toolchain.ts";
import { detectProject, buildCommand } from "../embedded/project.ts";

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
    const report = await detectToolchains();
    const { paths } = await flasherPaths();
    const project = detectProject(ctx.cwd);
    const [probes, ports, targets] = await Promise.all([
      listProbes({ pyocd: paths.pyocd, "probe-rs": paths["probe-rs"], jlink: paths.jlink }),
      listSerialPorts(),
      listTargets({ pyocd: paths.pyocd }, { filter: input.filter ? String(input.filter) : undefined, limit: input.include_targets ? 0 : 20 }),
    ]);

    const lines: string[] = [];
    lines.push(`project: ${project.kind}${project.root !== ctx.cwd ? ` (${project.root})` : ""}`);
    if (project.evidence.length) lines.push(`  evidence: ${project.evidence.join(", ")}`);

    lines.push("", `toolchains: ${report.tools.length} found, ${report.missing.length} missing`);
    for (const entry of report.tools) lines.push(`  ${entry.kind}: ${entry.version || "installed"} (${entry.path})`);
    if (report.missing.length) lines.push(`  missing: ${report.missing.join(", ")}`);

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

    return { content: lines.join("\n"), display: `${probes.probes.length} probe(s), ${targets.total} targets` };
  },
};

// ---- embed_flash -----------------------------------------------------------

const flashTool: Tool = {
  name: "embed_flash",
  description:
    "Write firmware to the attached board and verify it. Build first — this does not build. Returns whether the write succeeded, whether the tool verified it, and the exact command. Refuses when no probe is attached, when the target is ambiguous, or when a raw .bin is given without a load address.",
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
    },
    required: ["firmware"],
    additionalProperties: false,
  },
  summarize: (input) => String(input.firmware ?? ""),
  async execute(input, ctx): Promise<ToolResult> {
    const { paths } = await flasherPaths();
    const kind = chooseFlasher(input.flasher ? String(input.flasher) : undefined, paths);
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

    const result = await flash({
      kind,
      program,
      firmware: String(input.firmware),
      ...(input.target ? { target: String(input.target) } : {}),
      ...(input.address !== undefined ? { address: Number(input.address) } : {}),
      ...(input.probe ? { probe: String(input.probe) } : {}),
      ...(input.interface_config ? { interfaceConfig: String(input.interface_config) } : {}),
      ...(input.target_config ? { targetConfig: String(input.target_config) } : {}),
      ...(input.reset !== undefined ? { reset: Boolean(input.reset) } : {}),
    });

    const lines = [result.detail];
    if (result.reason && result.reason !== result.detail) lines.push(`reason: ${result.reason}`);
    if (result.command) lines.push(`command: ${result.command}`);
    if (result.verified !== undefined) lines.push(`verified: ${result.verified ? "yes" : "no"}`);
    lines.push(`elapsed: ${(result.durationMs / 1000).toFixed(1)}s`);
    if (!result.ok) lines.push("", "tool output (tail):", result.output.split("\n").slice(-25).join("\n"));

    return {
      ...(result.ok ? {} : { isError: true }),
      content: lines.join("\n"),
      display: result.ok ? "flashed" : "flash failed",
    };
  },
};

// ---- embed_serial ----------------------------------------------------------

const serialTool: Tool = {
  name: "embed_serial",
  description:
    "Read the board's serial console for a bounded time and return parsed log lines with timestamps, levels and tags. Use it to see whether the firmware booted, to catch a panic, or to wait for a readiness message. The read always stops: on the timeout, on a matching pattern, or at a line cap.",
  readonly: true,
  parameters: {
    type: "object",
    properties: {
      port: { type: "string", description: "Port name, e.g. `COM7` or `/dev/ttyACM0`. Omit to use the only attached port" },
      baud: { type: "integer", description: "Baud rate, default 115200" },
      timeout_ms: { type: "integer", description: "How long to listen, default 5000, max 60000" },
      until: { type: "string", description: "Stop as soon as a received line matches this regular expression" },
      max_lines: { type: "integer", description: "Stop after this many lines, default 2000" },
      only_errors: { type: "boolean", description: "Return only lines parsed as error or warning level" },
    },
    additionalProperties: false,
  },
  summarize: (input) => String(input.port ?? "serial"),
  async execute(input, _ctx): Promise<ToolResult> {
    const ports = await listSerialPorts();
    let port = input.port ? String(input.port) : undefined;
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
    const result = await capture(openPort, port, {
      timeoutMs,
      baud: Number(input.baud ?? 115200),
      ...(until ? { until } : {}),
      ...(input.max_lines !== undefined ? { maxLines: Number(input.max_lines) } : {}),
    });

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

    return { content: body.join("\n"), display: `${lines.length} line(s)` };
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

export const embeddedTools: Tool[] = [buildTool, flashTool, serialTool, portsTool, targetsTool, projectTool];
