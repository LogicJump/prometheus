/**
 * The operations beyond the core loop, kept in their own module so the session
 * file stays about "stop here, look, step".
 *
 * Every one of these was probed against MDK 5.43a before being written down.
 * Some work on this build, some answer `NOT_SUPPORTED` or time out, and the
 * ones that do not work say so with the interface's own words instead of
 * pretending an empty result means "nothing found".
 */

import type { Reply } from "./uvsock.ts";
import {
  OP,
  asyncText,
  commandWindowText,
  prjData,
  readDisassembly,
  readMenu,
  readSstr,
  readVset,
  sstr,
  vset,
  type MenuEntry,
  type UvSocketClient,
} from "./uvsock.ts";
import type { KeilSession, StopInfo } from "./keilSession.ts";
import { readRegisters } from "./keilSession.ts";

/* ---------- expression evaluation ---------- */

/**
 * Evaluate an expression.
 *
 * `DBG_CALC_EXPRESSION` is the interface's own evaluator and the one to use:
 * it answers with a 64-bit value **and** the debugger's rendering, where the
 * command window gives text that has to be parsed. Measured:
 *
 *   `main`  → 0x08006be0, "main"
 *   `$+4`   → 0x0800645c, "$+4"
 *
 * `DBG_EVAL_WATCH_EXPRESSION` answers `NOT_SUPPORTED` on this build for every
 * expression, so it is not used here.
 */
export async function evaluate(session: KeilSession, expression: string): Promise<{ ok: boolean; value?: bigint; text?: string; message?: string }> {
  const reply = await session.client.send(OP.DBG_CALC_EXPRESSION, vset(expression), 10_000);
  if (!reply.ok) {
    // A symbol that is out of scope is a normal answer to "what is this?",
    // reported in the debugger's own words rather than as a failure.
    return { ok: false, message: reply.message ?? reply.statusName };
  }
  const decoded = readVset(reply.data);
  if (!decoded) return { ok: false, message: "the reply carried no value" };
  return { ok: true, value: decoded.value, ...(decoded.text ? { text: decoded.text } : {}) };
}

/** Evaluate through the command window, the path `EVAL` reaches. */
export async function evalInWindow(session: KeilSession, expression: string): Promise<{ ok: boolean; value?: string; lines: string[] }> {
  const payload = Buffer.alloc(4 + 28 + 260);
  payload.writeUInt32LE(1, 0);
  sstr(`EVAL ${expression}`).copy(payload, 32);
  const reply = await session.client.send(OP.DBG_EXEC_CMD, payload, 12_000);
  const frames = await session.client.collect(400);
  const lines = frames.map((frame) => commandWindowText(frame)).filter(Boolean);
  const answer = lines.filter((line) => line.trim() !== `EVAL ${expression}` && !/^\s*\^/.test(line));
  const text = answer.join(" ").trim();
  return { ok: reply.ok && text.length > 0 && !/^\*\*\* error/i.test(text), ...(text ? { value: text } : {}), lines };
}

/**
 * Run a debugger command exactly as typed into uVision's Command window.
 *
 * This is the escape hatch for the whole command language: breakpoints with
 * conditions, tracepoints, `SAVE`, `LOG`, `PerformanceAnalyze`, `LOGIC`,
 * `COVERAGE`, and every system variable — the interface exposes them through
 * one command channel rather than one operation each. The reply comes back on
 * the `0x5020` stream, not in the response, so it is read from there.
 */
export async function debugCommand(session: KeilSession, command: string): Promise<{ ok: boolean; lines: string[]; message?: string }> {
  const payload = Buffer.alloc(4 + 28 + 260);
  payload.writeUInt32LE(1, 0); // echo the command and its output
  sstr(command).copy(payload, 32);
  const reply = await session.client.send(OP.DBG_EXEC_CMD, payload, 12_000);
  // `EXIT` makes uVision leave debug mode and answer on the stream after a
  // delay; a short wait reported it as a silent success and the session kept
  // claiming it was still debugging.
  const leaving = /^EXIT$/i.test(command.trim());
  const frames = await session.client.collect(leaving ? 2500 : 600);
  const lines = frames.map((frame) => commandWindowText(frame)).filter(Boolean);
  return {
    ok: reply.ok,
    lines,
    ...(reply.ok ? {} : { message: reply.message ?? reply.statusName }),
  };
}

/** Set a variable, by name, to a new value. */
export async function setVariable(session: KeilSession, name: string, value: string): Promise<Reply> {
  // `UV_DBG_VARIABLE_SET` takes a `VARINFO` whose `value` is the new value and
  // whose `name` identifies the variable.
  const payload = Buffer.alloc(1100);
  sstr(value).copy(payload, 20);
  sstr(name).copy(payload, 540);
  return session.client.send(OP.DBG_VARIABLE_SET, payload, 10_000);
}

/* ---------- run control beyond the basics ---------- */

/** Reset the target through the debugger. */
export async function resetTarget(session: KeilSession): Promise<{ ok: boolean; lines: string[]; message?: string }> {
  const mark = session.client.mark;
  const reply = await session.client.send(OP.DBG_RESET, Buffer.alloc(0), 10_000);
  const frames = await session.client.collect(1200);
  const lines = frames.map((frame) => asyncText(frame)).filter(Boolean);
  return { ok: reply.ok, lines, ...(reply.ok ? {} : { message: reply.message ?? reply.statusName }) };
}

/** Run until an address, then stop. */
export async function runToAddress(
  session: KeilSession,
  address: number,
  wait: (session: KeilSession, mark: number, timeoutMs: number) => Promise<StopInfo>,
  timeoutMs = 30_000,
): Promise<StopInfo> {
  const mark = session.client.mark;
  const payload = Buffer.alloc(8);
  payload.writeBigUInt64LE(BigInt(address), 0);
  const reply = await session.client.send(OP.DBG_RUN_TO_ADDRESS, payload, 10_000);
  if (!reply.ok && reply.status !== 11) return { stopped: false, reason: reply.message ?? reply.statusName, output: [] };
  return wait(session, mark, timeoutMs);
}

/** Step N source lines or N instructions. */
export async function stepMany(
  session: KeilSession,
  count: number,
  kind: "line" | "instruction",
  wait: (session: KeilSession, mark: number, timeoutMs: number) => Promise<StopInfo>,
  timeoutMs = 30_000,
): Promise<StopInfo> {
  const command = kind === "instruction" ? OP.DBG_STEP_INSTRUCTION_N : OP.DBG_STEP_HLL_N;
  const payload = Buffer.alloc(4);
  payload.writeUInt32LE(Math.max(1, count), 0);
  const mark = session.client.mark;
  const reply = await session.client.send(command, payload, 10_000);
  if (!reply.ok) return { stopped: false, reason: reply.message ?? reply.statusName, output: [] };
  return wait(session, mark, timeoutMs);
}

/**
 * The instructions the debugger holds at an address.
 *
 * Returns `words: []` with `bytes: 0` when the build answers with an empty
 * record — which is what this one does for some addresses — rather than
 * `null`, so "the debugger has no instruction here" is distinguishable from
 * "the request failed".
 */
export async function disassemble(session: KeilSession, address: number, bytes = 32): Promise<{ address: number; words: number[]; bytes: number } | null> {
  const payload = Buffer.alloc(24);
  payload.writeBigUInt64LE(BigInt(address), 0);
  payload.writeUInt32LE(bytes, 8);
  const reply = await session.client.send(OP.DBG_DSM_READ, payload, 10_000);
  if (!reply.ok) return null;
  return readDisassembly(reply.data);
}

/** uVision's own version strings, in the form the IDE reports them. */
export async function ideVersionText(session: KeilSession): Promise<{ uv: string; socket: string } | null> {
  const reply = await session.client.send(OP.GEN_GET_EXTVERSION, Buffer.alloc(0), 8_000);
  if (!reply.ok) return null;
  // Measured tail: "µVision=V5.43.1.0UVSOCK=V2.29".
  const text = reply.data.toString("latin1");
  const uv = /µVision=V([0-9.]+)/.exec(text)?.[1] ?? "";
  const socket = /UVSOCK=V([0-9.]+)/.exec(text)?.[1] ?? "";
  return { uv, socket };
}

/* ---------- menus, trace, recorder ---------- */

/** The debugger's own menu model. */
export async function readMenus(session: KeilSession): Promise<MenuEntry[]> {
  const mark = session.client.mark;
  await session.client.send(OP.DBG_ENUM_MENUS, Buffer.alloc(16), 10_000);
  const frames = await session.client.collect(1500, 0x5062, mark);
  return frames.map(readMenu).filter((entry): entry is MenuEntry => entry !== null);
}

/** Invoke one of those menu entries by the id `readMenus` reported. */
export async function execMenu(session: KeilSession, id: number, group = 0): Promise<Reply> {
  const payload = Buffer.alloc(16);
  payload.writeInt32LE(id, 0);
  payload.writeInt32LE(group, 4);
  return session.client.send(OP.DBG_MENU_EXEC, payload, 10_000);
}

/** Turn an ITM channel on or off. */
export async function registerItm(session: KeilSession, channel: number, enable = true): Promise<Reply> {
  const payload = Buffer.alloc(16);
  payload.writeUInt16LE(channel, 0);
  payload.writeUInt16LE(enable ? 1 : 0, 2);
  return session.client.send(enable ? OP.DBG_ITM_REGISTER : OP.DBG_ITM_UNREGISTER, payload, 10_000);
}

/** Turn the Event Recorder on or off. */
export async function setEventRecorder(session: KeilSession, enable: boolean): Promise<Reply> {
  return session.client.send(enable ? OP.DBG_EVTR_REGISTER : OP.DBG_EVTR_UNREGISTER, Buffer.alloc(0), 10_000);
}

/** The SCVD description files the recorder knows. */
export async function readScvdFiles(session: KeilSession): Promise<string[]> {
  const mark = session.client.mark;
  await session.client.send(OP.DBG_EVTR_ENUMSCVDFILES, Buffer.alloc(0), 10_000);
  const frames = await session.client.collect(1200, 0x5066, mark);
  return frames.map((frame) => readSstr(frame.data, 0)).filter(Boolean);
}

/** Turn a trace variable on or off by name. */
export async function setVtr(session: KeilSession, name: string, on: boolean): Promise<Reply> {
  const payload = Buffer.alloc(12 + 260);
  payload.writeInt32LE(on ? 1 : 0, 0);
  sstr(name).copy(payload, 12);
  return session.client.send(OP.DBG_VTR_SET, payload, 8_000);
}

/** Simulator clock: cycles and the timestamp the debugger reports. */
export async function timeInfo(session: KeilSession): Promise<{ cycles: bigint; seconds: number } | null> {
  const reply = await session.client.send(OP.DBG_TIME_INFO, Buffer.alloc(0), 8_000);
  if (!reply.ok || reply.data.length < 16) return null;
  return { cycles: reply.data.readBigUInt64LE(0), seconds: reply.data.readDoubleLE(8) };
}

/* ---------- project and IDE ---------- */

/** Which target a debug session uses. */
export async function debugTargetKind(session: KeilSession): Promise<"hardware" | "simulator" | null> {
  const reply = await session.client.send(OP.PRJ_GET_DEBUG_TARGET, Buffer.alloc(0), 8_000);
  if (!reply.ok || reply.data.length < 4) return null;
  return reply.data.readUInt32LE(0) === 0 ? "hardware" : "simulator";
}

/** Rename the target's output file; uVision writes it into the project. */
export async function setOutputName(session: KeilSession, name: string): Promise<Reply> {
  return session.client.send(OP.PRJ_SET_OUTPUTNAME, prjData(name), 10_000);
}

/** Show, hide or minimise the uVision window. */
export async function windowState(session: KeilSession, state: "show" | "hide" | "minimize"): Promise<Reply> {
  const command = state === "show" ? OP.GEN_SHOW : state === "hide" ? OP.GEN_HIDE : OP.GEN_MINIMIZE;
  return session.client.send(command, Buffer.alloc(0), 8_000);
}

/** The license state uVision reports. */
export async function licenseInfo(session: KeilSession): Promise<{ licensed: boolean; raw: Buffer }> {
  const reply = await session.client.send(OP.GEN_CHECK_LICENSE, Buffer.alloc(0), 8_000);
  return { licensed: reply.ok && reply.data.length >= 4 && reply.data.readUInt32LE(0) !== 0, raw: reply.data };
}

/** uVision's version, which is not the socket protocol's version. */
export async function ideVersion(session: KeilSession): Promise<{ ide: number; socket: number } | null> {
  const reply = await session.client.send(OP.GEN_GET_EXTVERSION, Buffer.alloc(0), 8_000);
  if (!reply.ok || reply.data.length < 8) return null;
  return { ide: reply.data.readUInt32LE(0), socket: reply.data.readUInt32LE(4) };
}

/**
 * Read registers by name.
 *
 * `UV_DBG_READ_REGISTERS` is **not** used: measured on MDK 5.43a it ignores
 * the names and answers a single `"0x00000000"` for `PC`, `SP`, `R13`,
 * `PC,SP` and `R0,R1` alike — a plausible-looking value that is simply wrong,
 * which is worse than a refusal. The values come from the register
 * enumeration instead, filtered to the names asked for.
 */
export async function readNamedRegisters(session: KeilSession, names: string[]): Promise<{ name: string; value: string }[]> {
  const all = await readRegisters(session);
  const wanted = names.map((name) => name.trim().toUpperCase()).filter(Boolean);
  // The debugger names its stack pointer `R13 (SP)`, not `SP`, and likewise
  // `R14 (LR)` and `R15 (PC)`. The parenthesised alias is what a person types.
  const find = (name: string) =>
    all.find((entry) => entry.name.toUpperCase() === name) ??
    all.find((entry) => entry.name.toUpperCase().startsWith(`${name} `)) ??
    all.find((entry) => entry.name.toUpperCase().endsWith(`(${name})`)) ??
    (name === "PC" ? all.find((entry) => entry.isPC) : undefined) ??
    // The architectural name for the same register: R13 = SP, and so on.
    (name === "R13" ? all.find((entry) => /\(SP\)$/i.test(entry.name)) : undefined) ??
    (name === "R14" ? all.find((entry) => /\(LR\)$/i.test(entry.name)) : undefined) ??
    (name === "R15" ? all.find((entry) => entry.isPC) : undefined);
  return wanted.map((name) => ({ name, value: find(name)?.value ?? "" }));
}

/** Show the source at an address in the IDE's editor. */
export async function showCodeAt(session: KeilSession, address: number, source = true): Promise<Reply> {
  // `iSHOWSYNC`: `{ xU64 nAdr; bAsm:1; bHll:1; … }`.
  const payload = Buffer.alloc(40);
  payload.writeBigUInt64LE(BigInt(address), 0);
  payload.writeUInt32LE(source ? 2 : 1, 8);
  return session.client.send(OP.DBG_ADR_SHOWCODE, payload, 8_000);
}

/** Close the project in the running uVision. */
export async function closeProject(session: KeilSession): Promise<Reply> {
  return session.client.send(OP.PRJ_CLOSE, Buffer.alloc(0), 10_000);
}

/**
 * Named operations this build answers `NOT_SUPPORTED`, never answers, or
 * refuses for a reason that is about the operation and not the request.
 *
 * Listed so a caller can say "Keil does not offer this here" instead of
 * leaving a defined-but-unreachable command that looks implemented.
 */
export const UNSUPPORTED_ON_MDK_5_43: Record<string, string> = {
  "DBG_EVAL_WATCH_EXPRESSION": "answers NOT_SUPPORTED for every expression (measured with `main`, `$`, `R0`)",
  "DBG_REMOVE_WATCH_EXPRESSION": "answers NOT_SUPPORTED for every expression",
  "DBG_EVAL_EXPRESSION_TO_STR": "never replies; DBG_CALC_EXPRESSION answers the same question",
  "DBG_EVTR_GETSTATUS": "never replies on this build",
  "DBG_ENUM_SYMTP": "needs a symbol-table id the build does not expose; answers PARSE_ERROR",
  "DBG_VTR_GET": "answers FAILED 'Unknown VTR-name' for names the interface itself enumerates",
  "DBG_VERIFY_CODE": "answers FAILED on a simulator target (no flash to verify against)",
  "DBG_FILELINE_TO_ADR": "answers NO_ADRMAP 'Address mapping failed' for both relative and absolute paths",
  "DBG_STEP_INTO_N": "documented as taking no count; the _HLL_N and _INSTRUCTION_N forms work",
  "PRJ_ACTIVE_FILES": "only answers outside a debug session, where it is not needed",
  "PRJ_CLOSE": "only answers outside a debug session; the session is closed by exiting uVision instead",
  "PRJ_LOAD": "the project is opened by the `-s` launch line; loading a second one mid-session is refused the same way",
  "GEN_SET_OPTIONS": "answers 'Target is in debug mode' and covers layout, not behaviour",
  "PRJ_CMD_PROGRESS": "a progress notification (0x500D family), not a command",
  "DBG_READ_REGISTERS": "ignores the names and answers one 0x00000000 whatever is asked; the enumeration is used instead",
  "DBG_WAKE": "simulator-only; accepted, no observable effect on a hardware build",
  "DBG_SLEEP": "simulator-only; accepted, no observable effect",
  "DBG_SET_CALLBACK": "simulator-only; accepted, no observable effect",
} as const;
