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
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import { build } from "../embedded/build.ts";
import { flash, type FlasherKind } from "../embedded/flash.ts";
import { capture, listSerialPorts, openPort } from "../embedded/serial.ts";
import { listProbes, listTargets, matchTarget } from "../embedded/probe.ts";
import { detectToolchains } from "../embedded/toolchain.ts";
import { detectProject, buildCommand } from "../embedded/project.ts";
import { findRegister, parseSvd, peripheralDetail } from "../embedded/svd.ts";
import { analyze, parseStackUsage } from "../embedded/analyze.ts";
import {
  MiSession,
  type MiRecord,
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
      reset_on_connect: {
        type: "boolean",
        description:
          "Assert DTR when opening, which resets most dev boards. Use it to catch a boot banner; leave it off when the firmware is already running and you want what it is printing now. Default false.",
      },
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
    const assertDtr = Boolean(input.reset_on_connect);
    const result = await capture((path, baud) => openPort(path, baud, { assertDtr }), port, {
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

// ---- embed_debug -----------------------------------------------------------

const debugTool: Tool = {
  name: "embed_debug",
  description:
    "Start a debug session on the attached board: halt at a breakpoint, read the call stack, inspect variables, step, and continue. Starts the probe's GDB server itself (OpenOCD, pyOCD, probe-rs or J-Link) and drives GDB over its machine interface. Returns structured frames and variables, not GDB's formatted text. Use it when the firmware runs but misbehaves — a wrong value, a hang, a hard fault — instead of adding print statements.",
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
        enum: ["run", "backtrace", "variables", "continue", "step"],
        description: "What to do once attached: run to the first breakpoint, read a backtrace, read variables, continue, or step one line. Default `run`.",
      },
      remote: { type: "string", description: "An already-running GDB server endpoint, e.g. `localhost:3333`. Skips starting a server." },
    },
    required: ["elf"],
    additionalProperties: false,
  },
  summarize: (input) => String(input.action ?? "debug"),
  async execute(input, ctx): Promise<ToolResult> {
    const elf = String(input.elf);
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
      const command = serverCommand(serverKind, program, {
        ...(input.target ? { target: String(input.target) } : {}),
        ...(elf ? { elf } : {}),
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

      return { content: sections.join("\n"), display: `debug: ${action}` };
    } finally {
      await session.close();
      // The GDB server holds the probe; leaving it running blocks the next flash.
      server?.kill();
    }
  },
};

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
    const child = spawn(command.program, command.args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
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
 * Where an SVD for this chip might be.
 *
 * The packs install into several places and none of them is standard on
 * Windows. Rather than make the user find a file, the tool searches the places
 * a vendor pack actually lands and reports which one it used.
 */
const SVD_DIRS = [
  // STM32CubeProgrammer ships one SVD per sub-family with the tool.
  "C:/Program Files/STMicroelectronics/STM32Cube/STM32CubeProgrammer/bin/SVD",
  "C:/Program Files (x86)/STMicroelectronics/STM32Cube/STM32CubeProgrammer/bin/SVD",
  "C:/Program Files/STMicroelectronics/STM32Cube/STM32CubeProgrammer/SVD",
  // Keil and the CMSIS packs.
  "C:/Keil_v5/ARM/PACK",
  ...(process.env.CMSIS_PACK_ROOT ? [join(process.env.CMSIS_PACK_ROOT, ".Web")] : []),
  ...(process.env.USERPROFILE ? [join(process.env.USERPROFILE, ".cache", "cmsis-pack-manager")] : []),
  ...(process.env.HOME ? [join(process.env.HOME, ".cache", "cmsis-pack-manager")] : []),
];

function findSvd(name: string): string | null {
  const wanted = name.toLowerCase();
  // Exact filename first (`STM32F411.svd`), then a directory walk.
  for (const dir of SVD_DIRS) {
    if (!existsSync(dir)) continue;
    const direct = join(dir, `${name}.svd`);
    if (existsSync(direct)) return direct;
    try {
      for (const entry of readdirSync(dir)) {
        if (entry.toLowerCase() === `${wanted}.svd` || entry.toLowerCase().startsWith(`${wanted}`)) {
          return join(dir, entry);
        }
      }
    } catch {
      /* unreadable */
    }
  }
  return null;
}

/** The chip name implied by the loaded project, when it has one. */
function chipFromProject(): string | null {
  const pio = "platformio.ini";
  if (existsSync(pio)) {
    const text = readFileSync(pio, "utf8");
    const board = /board\s*=\s*(\S+)/.exec(text)?.[1];
    if (board) {
      // `nucleo_f411re` → STM32F411; `esp32dev` → ESP32.
      const normalized = board.replace(/^nucleo[_-]?/i, "").replace(/re$/i, "").toUpperCase();
      const stm = /STM32([A-Z]\d{3})/.exec(normalized);
      if (stm) return `STM32${stm[1]}`;
    }
  }
  return null;
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
    const deviceName = input.device ? String(input.device) : chipFromProject();
    if (!deviceName) {
      return {
        isError: true,
        content:
          "No chip named. Pass `device` (e.g. STM32F411), or run this in a PlatformIO/CMake project whose board identifies the chip.",
        display: "no device",
      };
    }

    const svdPath = findSvd(deviceName);
    if (!svdPath) {
      return {
        isError: true,
        content:
          `No SVD found for ${deviceName}. Looked in:\n` +
          SVD_DIRS.map((dir) => `  ${dir}`).join("\n") +
          `\nSTM32CubeProgrammer installs one per sub-family; CMSIS packs install under CMSIS_PACK_ROOT.`,
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
    "Run static analysis (cppcheck, and clang-tidy when installed) over the firmware and return findings ranked by severity. Finds the bugs that compile cleanly and then fail on the board: out-of-bounds indices, null dereferences, uninitialised reads. Also reports flash/RAM headroom and worst-case stack depth when the build produced them. Use it after embed_build succeeds and before embedding_flash — a clean link is not a correct program.",
  readonly: true,
  parameters: {
    type: "object",
    properties: {
      paths: { type: "array", items: { type: "string" }, description: "Files or directories to analyse, relative to the workspace root. Default: the whole project" },
      enable: { type: "string", description: "cppcheck checks to enable, default `warning,style,performance,portability`" },
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
];
