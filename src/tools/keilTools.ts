/**
 * Tools for driving Keil MDK headless.
 *
 * The plain build path already runs `UV4 -b`, but a Keil project's debugger,
 * project structure and per-target options are not reachable from
 * command-line flags. They are reachable through uVision's own socket
 * interface, and `keil_debug` / `keil_project` expose that: breakpoints,
 * stepping, registers, variables, memory, stack — and adding files, groups,
 * targets and compile options to the `.uvprojx` itself.
 *
 * Everything here works on the user's own licensed install. Nothing is
 * bundled, downloaded or redistributed.
 *
 * Two constraints found by measurement, both reflected below:
 *
 *  - Debug mode and project edits are mutually exclusive: an entered debugger
 *    refuses `PRJ_ADD_GROUP` and `PRJ_GET_OPTITEM` with "Target is in debug
 *    mode", while the structure listers only answer *inside* one.
 *  - `DBG_ENTER` returns `SUCCESS` before it has done anything; a board that
 *    does not answer is reported as a later `0x4000` frame, so the outcome is
 *    read from the status and those frames rather than from the reply.
 */

import { existsSync } from "node:fs";
import type { Tool, ToolResult } from "../types.ts";
import {
  addAccessBreakpoint,
  addBreakpoint,
  addFile,
  addGroup,
  addressToSource,
  buildInIde,
  cancelBuild,
  closeKeilSession,
  currentLocation,
  currentTarget,
  eraseFlash,
  evaluate,
  evalInWindow,
  flashInIde,
  getOption,
  getOutputName,
  halt,
  listBreakpoints,
  listKeilSessions,
  enterDebug,
  openKeilSession,
  projectFiles,
  projectGroups,
  projectTargets,
  readMemory,
  readRegisterGroups,
  readRegisters,
  readStack,
  readTasks,
  readVariables,
  readVtr,
  readNamedRegisters,
  showCodeAt,
  debugCommand,
  disassemble,
  execMenu,
  ideVersionText,
  licenseInfo,
  readMenus,
  resetTarget,
  runToAddress,
  setVariable,
  setVtr,
  stepMany,
  timeInfo,
  windowState,
  waitForStop,
  removeFile,
  removeGroup,
  run,
  setOption,
  setRegister,
  setTarget,
  step,
  writeMemory,
  type KeilSession,
  type OptionName,
} from "../embedded/keilSession.ts";
import { keilCli } from "../embedded/keilCli.ts";
import { stopReasonName } from "../embedded/uvsock.ts";

const hex = (value: number) => `0x${value.toString(16)}`;

/** Opening a session is shared by both tools; failures read the same. */
async function sessionFor(
  input: Record<string, unknown>,
  cwd: string,
  options: { target?: "hardware" | "simulator"; connectOnly?: boolean } = {},
): Promise<{ ok: true; session: KeilSession; key: string; log: string[] } | { ok: false; content: string }> {
  const project = input.project ? String(input.project) : undefined;
  const chosen = (input.target as "hardware" | "simulator" | undefined) ?? options.target;
  // A debug session and a plain project session cannot be the same uVision:
  // the target options refuse to answer while the debugger is entered, so the
  // plain one runs on its own port and is reused only by plain work.
  const port = input.port !== undefined ? Number(input.port) : options.connectOnly ? 4824 : 4823;
  const opened = await openKeilSession({
    cwd,
    ...(project ? { project } : {}),
    ...(chosen ? { target: chosen } : {}),
    port,
    ...(options.connectOnly ? { connectOnly: true } : {}),
  });
  if (!opened.ok || !opened.session) {
    return { ok: false, content: [opened.reason ?? "could not open a Keil session", ...opened.log].join("\n") };
  }
  return { ok: true, session: opened.session, key: opened.key!, log: opened.log };
}

/** `main.c:35 (main) at 0x08006be0` — whichever parts exist. */
function describeWhere(where: { address: number; file?: string; line?: number; function?: string }): string {
  const symbol = where.function ? `${where.function} ` : "";
  const at = where.file ? `${where.file}:${where.line ?? "?"}` : hex(where.address);
  return `${symbol}${at}${where.file ? ` (${hex(where.address)})` : ""}`;
}

/** The stop, in the words a person would use. */
function describeStop(info: { stopped: boolean; reason?: string; reasonCode?: number; pc?: number; slot?: number; reasonText?: string; output: string[] }): string[] {
  const lines: string[] = [];
  if (info.stopped) {
    const why = info.reasonText ?? (info.reasonCode !== undefined ? stopReasonName(info.reasonCode) : "stopped");
    lines.push(`stopped: ${why}${info.pc !== undefined ? ` at ${hex(info.pc)}` : ""}${info.slot !== undefined ? ` (hardware slot ${info.slot})` : ""}`);
  } else {
    lines.push(info.reason ?? "did not come to a stop");
  }
  for (const line of info.output) lines.push(`  ${line}`);
  return lines;
}

// ---- keil_debug ------------------------------------------------------------

const keilDebugTool: Tool = {
  name: "keil_debug",
  description:
    "Debug a Keil MDK project through uVision's own debugger, headless: set breakpoints, run, step, halt, read registers, variables, memory and the stack. This is the path to take on a machine whose only debugger is Keil's — it uses the probe, device and flash algorithm configured in the .uvprojx/.uvoptx, so no second toolchain is needed. `target` chooses the real board (`hardware`, the default) or uVision's instruction set simulator (`simulator`). Sessions stay open between calls; pass action `close` to release the probe.",
  readonly: false,
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: [
          "open",
          "run",
          "continue",
          "halt",
          "reset",
          "run_to",
          "step",
          "step_into",
          "step_instruction",
          "step_out",
          "step_many",
          "breakpoints",
          "breakpoint_add",
          "breakpoint_delete",
          "watch_add",
          "registers",
          "register_read",
          "register_set",
          "variables",
          "stack",
          "where",
          "read",
          "write",
          "evaluate",
          "command",
          "variable_set",
          "tasks",
          "trace",
          "trace_set",
          "disassemble",
          "menus",
          "menu_exec",
          "time",
          "license",
          "version",
          "window",
          "build",
          "rebuild",
          "clean",
          "clean_rebuild",
          "export_cprj",
          "symbols",
          "convert",
          "flash",
          "erase",
          "sessions",
          "close",
        ],
        description: "What to do. Default `run`: start execution and stop at the first breakpoint.",
      },
      project: { type: "string", description: "The .uvprojx path; defaults to the project detected in the workspace" },
      target: { type: "string", enum: ["hardware", "simulator"], description: "Debug the real board or uVision's simulator (default hardware)" },
      port: { type: "integer", description: "UVSOCK TCP port when 4823 is taken" },
      location: { type: "string", description: "For breakpoint_add/breakpoint_delete/watch_add: a function, `file:line`, `*0x08001234`, or the breakpoint number" },
      kind: { type: "string", enum: ["exec", "read", "write", "readwrite"], description: "Breakpoint kind (default exec)" },
      address: { type: "integer", description: "For read/write/run_to/disassemble: the address" },
      width: { type: "string", enum: ["u8", "u16", "u32"], description: "For read/write: access width (default u32)" },
      count: { type: "integer", description: "For read: how many values; for step_many: how many steps (default 1)" },
      value: { type: "integer", description: "For write: the value to store" },
      expression: { type: "string", description: "For evaluate: a debugger expression, e.g. `uwTick` or `&g_state`" },
      command: {
        type: "string",
        description:
          "For action `command`: a uVision Command-window command, e.g. `BS main`, `BA read 0x20000000,4`, `LOG c:\trace.txt`, `SAVE c:\dump.hex 0x08000000,0x1000`, `LOGICAnalyze add ...`. This is the escape hatch for the parts of the debugger that are a command language rather than separate operations.",
      },
      name: { type: "string", description: "For a register write: the register name" },
      register_value: { type: "string", description: "For a register write: the new value" },
      window: { type: "string", enum: ["show", "hide", "minimize"], description: "For action `window`: what to do to the uVision window" },
      timeout_ms: { type: "integer", description: "How long to wait for a stop (default 30000)" },
    },
    required: ["action"],
    additionalProperties: false,
  },
  summarize: (input) => `keil: ${String(input.action)}`,
  async execute(input, ctx): Promise<ToolResult> {
    const action = String(input.action);
    if (action === "sessions") {
      const open = listKeilSessions();
      if (open.length === 0) return { content: "No Keil sessions are open.", display: "no sessions" };
      return {
        content: open.map((entry) => `${entry.project} — ${entry.target}${entry.debugging ? ", in debug mode" : ""}`).join("\n"),
        display: `${open.length} session(s)`,
      };
    }
    if (action === "close") {
      let closed = 0;
      for (const entry of listKeilSessions()) if (await closeKeilSession(entry.key)) closed++;
      return { content: `closed ${closed} Keil session(s)`, display: "closed" };
    }

    const opened = await sessionFor(input, ctx.cwd);
    if (!opened.ok) return { isError: true, content: opened.content, display: "Keil unavailable" };
    const session = opened.session;
    try {
      // The connection log belongs to `open`, where it is what was asked for;
      // repeating it on every action buries the answer.
      const lines: string[] = [];
      const location = input.location ? String(input.location) : "";

      if (action === "open") {
        // Re-entering after `EXIT` from the command window: the session was
        // kept but the debugger had left, so it is entered again rather than
        // reporting a PC that no longer exists.
        if (!session.debugging) {
          const reentered = await enterDebug(session, session.target, 40_000);
          lines.push(...reentered.log);
          if (!reentered.ok) return { isError: true, content: reentered.reason ?? "could not re-enter debug mode", display: "not debugging" };
        }
        // `open` also re-establishes state that a command-window `EXIT` clears.
        lines.push(...opened.log);
        const where = await currentLocation(session);
        lines.push(`project: ${session.project}`);
        lines.push(`target: ${session.target}`);
        if (where) lines.push(`pc: ${hex(where.address)}${where.file ? ` (${where.file}:${where.line ?? "?"})` : ""}`);
      } else if (action === "run" || action === "continue") {
        lines.push(...describeStop(await run(session, Number(input.timeout_ms ?? 30_000))));
        const where = await currentLocation(session);
        if (where) lines.push(`at ${describeWhere(where)}`);
      } else if (action === "reset") {
        const done = await resetTarget(session);
        lines.push(...(done.lines.length > 0 ? done.lines : [done.ok ? "target reset" : `reset failed: ${done.message ?? "no reason given"}`]));
      } else if (action === "run_to") {
        const address = Number(input.address);
        if (!Number.isFinite(address)) return { isError: true, content: "run_to needs an `address`.", display: "missing address" };
        lines.push(...describeStop(await runToAddress(session, address, (_session, mark, timeoutMs) => waitForStop(session, mark, timeoutMs), Number(input.timeout_ms ?? 30_000))));
        const where = await currentLocation(session);
        if (where) lines.push(`at ${describeWhere(where)}`);
      } else if (action === "halt") {
        lines.push(...describeStop(await halt(session)));
      } else if (action === "step" || action === "step_into" || action === "step_instruction" || action === "step_out") {
        const kind = action === "step" ? "over" : action === "step_into" ? "into" : action === "step_instruction" ? "instruction" : "out";
        lines.push(...describeStop(await step(session, kind, Number(input.timeout_ms ?? 15_000))));
        const where = await currentLocation(session);
        if (where) lines.push(`at ${describeWhere(where)}`);
      } else if (action === "step_many") {
        const steps = Math.max(1, Math.min(1000, Number(input.count ?? 1)));
        const kind = input.width === "u8" ? "instruction" : "line";
        lines.push(...describeStop(await stepMany(session, steps, kind, (_session, mark, timeoutMs) => waitForStop(session, mark, timeoutMs))));
        const where = await currentLocation(session);
        if (where) lines.push(`at ${describeWhere(where)}`);
      } else if (action === "breakpoints") {
        const list = await listBreakpoints(session);
        if (list.length === 0) lines.push("(no breakpoints)");
        for (const entry of list) {
          lines.push(`#${entry.number} ${entry.type === 1 ? "exec" : entry.type === 2 ? "read" : entry.type === 3 ? "write" : "access"} ${entry.expression ?? ""}${entry.address ? ` @ ${hex(entry.address)}` : ""}${entry.enabled ? "" : " (disabled)"}`);
        }
      } else if (action === "breakpoint_add") {
        if (!location) return { isError: true, content: "breakpoint_add needs a `location`.", display: "missing location" };
        const kind = String(input.kind ?? "exec");
        const reply =
          kind === "exec"
            ? (await addBreakpoint(session, location)).reply
            : await addAccessBreakpoint(session, location, kind as "read" | "write" | "readwrite", Number(input.width === "u8" ? 1 : input.width === "u16" ? 2 : 4));
        lines.push(reply.ok ? `breakpoint set on ${location}` : `could not set it: ${reply.message ?? reply.statusName}`);
      } else if (action === "breakpoint_delete") {
        const number = Number(location.replace(/^#/, ""));
        const list = await listBreakpoints(session);
        const target = list.find((entry) => entry.number === number);
        if (!target) return { isError: true, content: `there is no breakpoint ${number}; the list has ${list.length}.`, display: "not found" };
        const changed = await session.client.send(0x2016, (() => {
          const payload = Buffer.alloc(40);
          payload.writeUInt32LE(1, 0); // KILLBP
          payload.writeUInt32LE(target.tickMark, 4);
          return payload;
        })(), 10_000);
        lines.push(changed.ok ? `deleted breakpoint ${number}` : `could not delete it: ${changed.message ?? changed.statusName}`);
      } else if (action === "watch_add") {
        if (!location) return { isError: true, content: "watch_add needs a `location` expression.", display: "missing expression" };
        const reply = await session.client.send(0x202b, (() => {
          const payload = Buffer.alloc(520);
          payload.writeInt32LE(location.length + 1, 0);
          Buffer.from(`${location}\0`, "latin1").copy(payload, 4);
          return payload;
        })(), 10_000);
        lines.push(reply.ok ? `watching ${location}` : `could not watch it: ${reply.message ?? reply.statusName}`);
      } else if (action === "registers") {
        const list = await readRegisters(session);
        if (list.length === 0) lines.push("(no registers reported)");
        for (const entry of list) lines.push(`${entry.name.padEnd(6)} ${entry.value}${entry.isPC ? "   <- PC" : ""}`);
        const groups = await readRegisterGroups(session);
        if (groups.length > 0) lines.push("", `groups: ${groups.join(", ")}`);
      } else if (action === "register_read") {
        const list = String(input.location ?? input.expression ?? "").split(/[,\s]+/).filter(Boolean);
        if (list.length === 0) return { isError: true, content: "register_read needs register names in `location`, e.g. `PC,SP,LR`.", display: "missing registers" };
        const values = await readNamedRegisters(session, list);
        for (const entry of values) lines.push(`${entry.name} = ${entry.value || "(not in the register enumeration)"}`);
      } else if (action === "register_set") {
        const name = input.name ? String(input.name) : "";
        const value = input.register_value !== undefined ? String(input.register_value) : "";
        if (!name) return { isError: true, content: "register_set needs a `name`.", display: "missing register" };
        const reply = await setRegister(session, name, value);
        lines.push(reply.ok ? `${name} = ${value}` : `could not write it: ${reply.message ?? reply.statusName}`);
      } else if (action === "variables") {
        const list = await readVariables(session);
        if (list.length === 0) {
          lines.push("the debugger enumerated no variables — the image may have been built without debug info, or nothing is loaded.");
        }
        for (const entry of list.slice(0, 200)) lines.push(`${entry.name}${entry.type ? `: ${entry.type}` : ""} = ${entry.value}`);
        if (list.length > 200) lines.push(`… and ${list.length - 200} more`);
      } else if (action === "stack") {
        const frames = await readStack(session);
        if (frames.length === 0) lines.push("(empty stack)");
        for (const frame of frames) {
          const source = await addressToSource(session, frame.address);
          const fn = source?.function ? `${source.function} ` : "";
          lines.push(`#${frame.level} ${fn}${source?.file ? `${source.file}:${source.line ?? "?"}` : hex(frame.address)}`);
        }
      } else if (action === "where") {
        const where = await currentLocation(session);
        if (!where) lines.push("the debugger could not read the PC");
        else {
          const source = await addressToSource(session, where.address);
          lines.push(`${describeWhere({ ...where, ...(source ?? {}) })}`);
        }
      } else if (action === "read") {
        const address = Number(input.address);
        if (!Number.isFinite(address)) return { isError: true, content: "read needs an `address`.", display: "missing address" };
        const width = (input.width as "u8" | "u16" | "u32" | undefined) ?? "u32";
        const size = width === "u8" ? 1 : width === "u16" ? 2 : 4;
        const count = Math.max(1, Math.min(256, Number(input.count ?? 1)));
        const memory = await readMemory(session, address, size * count);
        if (!memory) lines.push(`could not read at ${hex(address)}`);
        else {
          for (let index = 0; index < count; index++) {
            const slice = memory.bytes.slice(index * size, index * size + size);
            if (slice.length < size) break;
            const value = slice.reduce((total, byte, position) => total + byte * 2 ** (8 * position), 0) >>> 0;
            lines.push(`${hex(address + index * size)} = ${value} (${hex(value)})`);
          }
          if (memory.errorAddress !== undefined) lines.push(`(the bus refused access at ${hex(memory.errorAddress)})`);
        }
      } else if (action === "write") {
        const address = Number(input.address);
        const value = Number(input.value);
        if (!Number.isFinite(address) || !Number.isFinite(value)) return { isError: true, content: "write needs an `address` and a `value`.", display: "missing argument" };
        const width = (input.width as "u8" | "u16" | "u32" | undefined) ?? "u32";
        const size = width === "u8" ? 1 : width === "u16" ? 2 : 4;
        const bytes: number[] = [];
        let rest = value >>> 0;
        for (let index = 0; index < size; index++) {
          bytes.push(rest & 0xff);
          rest >>>= 8;
        }
        const outcome = await writeMemory(session, address, bytes);
        lines.push(outcome.detail);
        if (outcome.readBack) lines.push(`read back: ${outcome.readBack.map((byte) => byte.toString(16).padStart(2, "0")).join(" ")}`);
      } else if (action === "evaluate") {
        const expression = input.expression ? String(input.expression) : "";
        if (!expression) return { isError: true, content: "evaluate needs an `expression`.", display: "missing expression" };
        // `CALC_EXPRESSION` is the interface's own evaluator; the command
        // window is the fallback for forms it refuses.
        const direct = await evaluate(session, expression);
        if (direct.ok) {
          const rendered = direct.text && direct.text !== expression ? direct.text : `0x${(direct.value ?? 0n).toString(16)}`;
          lines.push(`${expression} = ${rendered}${direct.value !== undefined ? ` (${direct.value})` : ""}`);
        } else {
          const viaWindow = await evalInWindow(session, expression);
          lines.push(viaWindow.ok ? `${expression} = ${viaWindow.value}` : `the debugger could not evaluate ${expression}: ${direct.message ?? viaWindow.lines.join(" ")}`);
        }
      } else if (action === "command") {
        const typed = input.command ? String(input.command) : "";
        if (!typed) return { isError: true, content: "command needs a `command` string.", display: "missing command" };
        const ran = await debugCommand(session, typed);
        // The channel echoes the command, then prints its answer on the same
        // stream; the echo is dropped so a silent success reads as silent.
        const said = typed.trim();
        const output = ran.lines.filter((line) => line.trim() !== said && line.trim() !== "");
        // `EXIT` ends the debug session from inside the command language, and
        // nothing else would notice: the session would keep claiming it was
        // in debug mode and answer NOT_DEBUGGING to everything.
        const left = /^EXIT$/i.test(typed.trim());
        if (left) {
          session.debugging = false;
          // Breakpoints live in the debugger, so leaving takes them with it.
          // Saying so is the difference between "add it again" and believing
          // the next `run` will stop where the last one did.
          lines.push("left debug mode; the debugger's breakpoints were cleared with it");
          return { content: lines.join(String.fromCharCode(10)), display: "keil: command" };
        }
        const note: string[] = [];
        // The note is appended in both branches: `EXIT` prints nothing, and
        // "ran, no output" was the one message that most needed it.
        if (output.length > 0) lines.push(...output);
        else if (!ran.ok) lines.push(`refused: ${ran.message ?? "no reason given"}`);
        else if (note.length === 0) lines.push(`ran \`${typed}\` (no output)`);
        lines.push(...note);
      } else if (action === "variable_set") {
        const name = input.expression ? String(input.expression) : "";
        const value = input.value !== undefined ? String(input.value) : "";
        if (!name) return { isError: true, content: "variable_set needs an `expression` naming the variable.", display: "missing variable" };
        const reply = await setVariable(session, name, value);
        lines.push(reply.ok ? `${name} = ${value}` : `could not set it: ${reply.message ?? reply.statusName}`);
      } else if (action === "disassemble") {
        const address = Number(input.address);
        if (!Number.isFinite(address)) return { isError: true, content: "disassemble needs an `address`.", display: "missing address" };
        const decoded = await disassemble(session, address, Math.max(4, Math.min(256, Number(input.count ?? 8) * 4)));
        if (!decoded) lines.push("the debugger refused the disassembly request");
        else if (decoded.words.length === 0) lines.push(`the debugger holds no instruction at ${hex(decoded.address)} (it reported ${decoded.bytes} bytes)`);
        else {
          lines.push(`disassembly at ${hex(decoded.address)}:`);
          decoded.words.forEach((word, index) => lines.push(`  ${hex(decoded.address + index * 4)}  ${word.toString(16).padStart(8, "0")}`));
        }
      } else if (action === "menus" || action === "menu_exec") {
        const entries = await readMenus(session);
        if (action === "menus") {
          const list = entries.map((entry) => `${entry.id} ${entry.enabled ? "" : "(disabled) "}${entry.label}`);
          lines.push(entries.length > 0 ? list.join(", ") : "the debugger reported no menu entries");
        } else {
          const id = Number(input.count ?? input.value ?? -1);
          if (!Number.isFinite(id) || id < 0) return { isError: true, content: "menu_exec needs a menu `id` from the `menus` list.", display: "missing id" };
          const reply = await execMenu(session, id);
          lines.push(reply.ok ? `ran menu ${id}` : `could not run it: ${reply.message ?? reply.statusName}`);
        }
      } else if (action === "time") {
        const clock = await timeInfo(session);
        lines.push(clock ? `${clock.cycles} cycles, tStamp ${clock.seconds}` : "the debugger did not report a clock (it is simulator-only)");
      } else if (action === "license") {
        const info = await licenseInfo(session);
        lines.push(info.licensed ? "uVision reports a valid licence" : "uVision did not report a valid licence");
      } else if (action === "version") {
        const info = await ideVersionText(session);
        lines.push(info ? `uVision V${info.uv}, socket interface V${info.socket}` : "the IDE did not report its version");
      } else if (action === "window") {
        const state = (input.window as "show" | "hide" | "minimize" | undefined) ?? "hide";
        const reply = await windowState(session, state);
        lines.push(reply.ok ? `uVision window: ${state}` : `could not change it: ${reply.message ?? reply.statusName}`);
      } else if (action === "trace_set") {
        const name = input.location ? String(input.location) : "";
        if (!name) return { isError: true, content: "trace_set needs a `location` naming the trace variable.", display: "missing name" };
        const reply = await setVtr(session, name, true);
        lines.push(reply.ok ? `trace variable ${name} enabled` : `could not enable it: ${reply.message ?? reply.statusName}`);
      } else if (action === "tasks") {
        const tasks = await readTasks(session);
        lines.push(tasks.length ? tasks.map((task) => `#${task.id} ${task.name} @ ${hex(task.address)}`).join("\n") : "no RTOS tasks reported (bare-metal target, or no awareness plugin)");
      } else if (action === "trace") {
        const items = await readVtr(session);
        lines.push(items.length ? items.map((item) => item.name).join(", ") : "no trace variables reported");
      } else if (action === "clean" || action === "clean_rebuild" || action === "export_cprj" || action === "symbols" || action === "convert") {
        // These are the rest of UV4's documented switches; each is one headless
        // run, so the build's log/exit-code reading applies unchanged.
        const operation =
          action === "clean"
            ? "clean"
            : action === "clean_rebuild"
              ? "clean-rebuild"
              : action === "export_cprj"
                ? "export-cprj"
                : action === "symbols"
                  ? "symbols"
                  : "convert";
        const result = await keilCli({
          cwd: ctx.cwd,
          operation,
          uv4: session.client.programPath,
          ...(session.project ? { project: session.project } : {}),
          ...(input.target ? { target: String(input.target) } : {}),
        });
        lines.push(`${operation}: ${result.ok ? "done" : "failed"} (exit ${result.exitCode}, ${result.durationMs} ms)`);
        if (result.reason) lines.push(`reason: ${result.reason}`);
        if (result.produced.length > 0) lines.push(`wrote: ${result.produced.join(", ")}`);
        if (result.log) lines.push(...result.log.split(String.fromCharCode(10)).slice(-12));
      } else if (action === "build" || action === "rebuild") {
        const started = await buildInIde(session, action === "rebuild");
        const wanted = started.lines.filter((line) => /error|warning|Program Size|Build target|Rebuild target/i.test(line));
        lines.push(...(wanted.length > 0 ? wanted : started.lines).slice(-60));
        if (!started.ok) lines.push(`build ended with code ${started.status}`);
      } else if (action === "flash") {
        const flashed = await flashInIde(session);
        lines.push(...flashed.lines.slice(-30));
        if (!flashed.ok) lines.push("the download did not finish cleanly");
      } else if (action === "erase") {
        const erased = await eraseFlash(session);
        lines.push(erased.ok ? "flash erase accepted by the configured algorithm" : `erase failed: ${erased.message ?? erased.statusName}`);
      } else {
        return { isError: true, content: `unknown action \`${action}\``, display: "unknown action" };
      }
      return { content: lines.join("\n") || "(no output)", display: `keil: ${action}` };
    } finally {
      // Sessions are kept open deliberately: re-entering debug mode re-flashes
      // the target and drops every breakpoint, which would make a
      // set-and-run sequence impossible across tool calls.
    }
  },
};

// ---- keil_project ----------------------------------------------------------

const keilProjectTool: Tool = {
  name: "keil_project",
  description:
    "Read and change the Keil MDK project itself, headless: list targets, groups and files; add or remove a group or a source file; read and set the compile defines, include paths and optimisation for a target; switch the active target. Changes are written to the .uvprojx by uVision, so the project opens and builds exactly as edited here.",
  readonly: false,
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["info", "groups", "files", "add_group", "add_file", "remove_file", "remove_group", "get_option", "set_option", "set_target", "output_name", "close"],
        description: "What to do. `info` summarises the project.",
      },
      project: { type: "string", description: "The .uvprojx path; defaults to the detected project" },
      group: { type: "string", description: "Group name for files / add_file / add_group / remove_group" },
      file: { type: "string", description: "File path for add_file / remove_file" },
      target: { type: "string", description: "Target name for set_target / get_option / set_option; defaults to the current target" },
      option: {
        type: "string",
        enum: ["CDEF", "CINCL", "ADEF", "AINCL", "COPTIMIZE", "CODEGEN", "CMISC", "AMISC", "LMISC", "MEMRANGES", "UBCOMP1", "UBCOMP2", "UBBUILD1", "UBBUILD2"],
        description: "For get_option/set_option: which target option",
      },
      value: { type: "string", description: "For set_option: the new value (replaces the current one)" },
      port: { type: "integer", description: "UVSOCK TCP port when 4823 is taken" },
    },
    required: ["action"],
    additionalProperties: false,
  },
  summarize: (input) => `keil project: ${String(input.action)}`,
  async execute(input, ctx): Promise<ToolResult> {
    const action = String(input.action);
    if (action === "close") {
      let closed = 0;
      for (const entry of listKeilSessions()) if (await closeKeilSession(entry.key)) closed++;
      return { content: `closed ${closed} Keil session(s)`, display: "closed" };
    }
    // Every project operation runs on a plain (non-debug) session, measured on
    // MDK 5.43a: an entered debugger answers "Target is in debug mode" to all
    // of them. The structure listers additionally need an entered debugger, so
    // those four fail on a plain session with `NOT_DEBUGGING` — that is
    // reported as such instead of being presented as an empty project.
    const listed = new Set(["info", "groups", "files"]);
    const opened = await sessionFor(input, ctx.cwd, { connectOnly: true });
    if (!opened.ok) return { isError: true, content: opened.content, display: "Keil unavailable" };
    const session = opened.session;
    const group = input.group ? String(input.group) : "";
    const lines: string[] = [];

    if (action === "info") {
      lines.push(`project: ${session.project}`);
      lines.push(`target: ${await currentTarget(session)}`);
      const defines = await getOption(session, "CDEF");
      if (defines.ok) lines.push(`defines: ${defines.values.join(", ") || "(none)"}`);
      // The group/file tree is only readable from an entered debugger. It is
      // therefore a separate, explicit ask rather than part of `info`: asking
      // for it here would start a flash download the caller never requested.
      lines.push("for the group and file tree, run `groups` (it enters the debugger, which needs the target to answer)");
    } else if (action === "groups") {
      const groups = await projectGroups(session);
      lines.push(groups.length > 0 ? groups.join("\n") : "(no groups)");
    } else if (action === "files") {
      if (!group) return { isError: true, content: "files needs a `group`.", display: "missing group" };
      const files = await projectFiles(session, group);
      lines.push(files.length > 0 ? files.join("\n") : `(no files in ${group})`);
    } else if (action === "add_group") {
      if (!group) return { isError: true, content: "add_group needs a `group` name.", display: "missing group" };
      const reply = await addGroup(session, group);
      lines.push(reply.ok ? `added group ${group}` : `could not add it: ${reply.message ?? reply.statusName}`);
    } else if (action === "add_file") {
      const file = input.file ? String(input.file) : "";
      if (!group || !file) return { isError: true, content: "add_file needs a `group` and a `file`.", display: "missing argument" };
      if (!existsSync(file) && !file.startsWith(".")) {
        // uVision stores an absolute path; a relative one must already exist
        // relative to the project for it to be useful.
        lines.push(`note: ${file} was not found on disk; adding it anyway`);
      }
      const reply = await addFile(session, group, file);
      lines.push(reply.ok ? `added ${file} to ${group}` : `could not add it: ${reply.message ?? reply.statusName}`);
    } else if (action === "remove_file") {
      const file = input.file ? String(input.file) : "";
      if (!group || !file) return { isError: true, content: "remove_file needs a `group` and a `file`.", display: "missing argument" };
      const reply = await removeFile(session, group, file);
      lines.push(reply.ok ? `removed ${file} from ${group}` : `could not remove it: ${reply.message ?? reply.statusName}`);
    } else if (action === "remove_group") {
      if (!group) return { isError: true, content: "remove_group needs a `group`.", display: "missing group" };
      const reply = await removeGroup(session, group);
      lines.push(reply.ok ? `removed group ${group}` : `could not remove it: ${reply.message ?? reply.statusName}`);
    } else if (action === "get_option") {
      const option = (input.option ? String(input.option) : "CDEF") as OptionName;
      const result = await getOption(session, option, input.target ? String(input.target) : undefined);
      lines.push(result.ok ? `${option}: ${result.values.join(", ") || "(empty)"}` : `could not read it: ${result.message}`);
    } else if (action === "set_option") {
      const option = (input.option ? String(input.option) : "") as OptionName;
      if (!option) return { isError: true, content: "set_option needs an `option`.", display: "missing option" };
      const value = input.value !== undefined ? String(input.value) : "";
      const reply = await setOption(session, option, value, input.target ? String(input.target) : undefined);
      lines.push(reply.ok ? `${option} set to ${value || "(empty)"}` : `could not set it: ${reply.message ?? reply.statusName}`);
    } else if (action === "set_target") {
      const target = input.target ? String(input.target) : "";
      if (!target) return { isError: true, content: "set_target needs a `target`.", display: "missing target" };
      const reply = await setTarget(session, target);
      lines.push(reply.ok ? `active target is now ${target}` : `could not switch: ${reply.message ?? reply.statusName}`);
    } else if (action === "output_name") {
      const name = await getOutputName(session);
      lines.push(name ? `output: ${name}` : "the project did not report an output name");
    } else {
      return { isError: true, content: `unknown action \`${action}\``, display: "unknown action" };
    }
    return { content: lines.join("\n"), display: `keil: ${action}` };
  },
};

export const keilTools: Tool[] = [keilDebugTool, keilProjectTool];
