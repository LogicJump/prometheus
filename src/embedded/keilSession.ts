/**
 * A Keil debug session the agent can drive.
 *
 * The plain-GDB path in `debug.ts` covers probes that expose a GDB server. A
 * Keil project often does not: the debugger is uVision's own, configured in
 * the `.uvoptx`, and on an MDK-only machine there is no OpenOCD, no pyOCD and
 * no `arm-none-eabi-gdb` at all. Before this, "debug the Keil project" meant
 * "install a second toolchain and hope the chip is supported".
 *
 * This drives the same debugger uVision itself uses, through UVSOCK, so the
 * project's own device, flash algorithm and probe configuration are the ones
 * in effect. That is the difference between debugging *the* Keil project and
 * debugging *a* board.
 *
 * Real target or simulator is a property of the project target and is switched
 * explicitly, because the two answer completely differently when a register is
 * read twice and the difference matters to whoever asked.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { detectToolchains } from "./toolchain.ts";
import { detectProject } from "./project.ts";
import {
  connect,
  isStopNotification,
  stopReason,
  type AsyncFrame,
  type Reply,
  type UvSocketClient,
  OPT,
  OP,
  TARGET,
  asyncText,
  breakpointParam,
  commandWindowText,
  fixedString,
  readCountedString,
  memoryRequest,
  memoryWrite,
  BREAK,
  prjData,
  readMemoryReply,
  readSstr,
  readTrnOpt,
  trnOptValue,
  sstr,
  trnOpt,
  type OptionName,
} from "./uvsock.ts";

export type { OptionName };

export interface KeilSession {
  client: UvSocketClient;
  project: string;
  /** True once `DBG_ENTER` succeeded. */
  debugging: boolean;
  target: "hardware" | "simulator";
  openedAt: number;
}

const sessions = new Map<string, KeilSession>();

/** The key a session is remembered under: the project plus its port. */
export function sessionKey(project: string, port: number): string {
  return `${project.toLowerCase()}|${port}`;
}

export function getKeilSession(key: string): KeilSession | undefined {
  return sessions.get(key);
}

export async function closeKeilSession(key: string): Promise<boolean> {
  const session = sessions.get(key);
  if (!session) return false;
  try {
    if (session.debugging) await session.client.send(OP.DBG_EXIT, Buffer.alloc(0), 8_000);
  } catch {
    /* the session may already be gone */
  }
  await session.client.exit();
  sessions.delete(key);
  return true;
}

export async function closeAllKeilSessions(): Promise<void> {
  for (const key of [...sessions.keys()]) await closeKeilSession(key);
}

export function listKeilSessions(): { key: string; project: string; target: string; debugging: boolean; openedAt: number }[] {
  return [...sessions.entries()].map(([key, session]) => ({
    key,
    project: session.project,
    target: session.target,
    debugging: session.debugging,
    openedAt: session.openedAt,
  }));
}

/** Where UV4.exe is, if Keil is installed. */
export async function uv4Path(): Promise<string | null> {
  const report = await detectToolchains();
  return report.tools.find((entry) => entry.kind === "keil")?.path ?? null;
}

/** The project file for a workspace, when it is a Keil project. */
export function keilProjectFor(cwd: string): string | null {
  const project = detectProject(cwd);
  if (project.kind !== "keil") return null;
  return project.file ?? null;
}

export interface OpenOptions {
  cwd: string;
  /** Override the detected project file. */
  project?: string;
  target?: "hardware" | "simulator";
  port?: number;
  /** Skip `DBG_ENTER`; just connect and let the caller drive. */
  connectOnly?: boolean;
  timeoutMs?: number;
}

export interface OpenResult {
  ok: boolean;
  session?: KeilSession;
  key?: string;
  /** What happened, in the order it happened, for the transcript. */
  log: string[];
  reason?: string;
}

/**
 * Open a session, reusing one that is already running for this project.
 *
 * Re-entering uVision's debug mode drops every breakpoint and re-flashes the
 * target, so reusing the live session is not an optimisation — it is what
 * makes "set a breakpoint, run, look, step" a sequence rather than four
 * unrelated attachments.
 */
export async function openKeilSession(options: OpenOptions): Promise<OpenResult> {
  const log: string[] = [];
  const uv4 = await uv4Path();
  if (!uv4) {
    return {
      ok: false,
      log,
      reason:
        "Keil MDK is not installed on this machine (UV4.exe was not found). Its debugger is licensed and is never bundled with this app, " +
        "so headless Keil debugging needs a local MDK install. Install MDK, or use embed_debug with an OpenOCD/pyOCD/J-Link probe instead.",
    };
  }
  const project = options.project ? options.project : keilProjectFor(options.cwd);
  if (!project) {
    return {
      ok: false,
      log,
      reason: "No Keil project found in this workspace. Point `project` at the .uvprojx, or run this from the project directory.",
    };
  }
  if (!existsSync(project)) return { ok: false, log, reason: `The project file does not exist: ${project}` };

  const port = options.port && options.port > 0 ? options.port : 4823;
  const key = sessionKey(project, port);
  const existing = sessions.get(key);
  if (existing && !existing.client.closed) {
    log.push(`reused the open uVision session on port ${port}`);
    return { ok: true, session: existing, key, log };
  }

  log.push(`${uv4} ${project} -s ${port} -j0`);
  const connection = await connect({ uv4, project, port, ...(options.timeoutMs !== undefined ? { startTimeoutMs: options.timeoutMs } : {}) });
  if (!connection.ok) return { ok: false, log, reason: connection.reason };
  const client = connection.client;
  log.push(`connected to uVision on 127.0.0.1:${port}`);

  const version = await client.send(OP.GEN_GET_VERSION, Buffer.alloc(0), 10_000);
  if (!version.ok) {
    client.close();
    return { ok: false, log, reason: `uVision did not answer the version request: ${version.message ?? version.statusName}` };
  }
  log.push(`socket interface version ${version.data.readUInt32LE(0) / 100}`);

  const session: KeilSession = { client, project, debugging: false, target: "hardware", openedAt: Date.now() };
  sessions.set(key, session);

  if (options.connectOnly) return { ok: true, session, key, log };

  const entered = await enterDebug(session, options.target ?? "hardware", options.timeoutMs ?? 40_000);
  log.push(...entered.log);
  if (!entered.ok) {
    sessions.delete(key);
    await client.exit();
    return { ok: false, log, reason: entered.reason };
  }
  return { ok: true, session, key, log };
}

/**
 * Enter (or re-enter) uVision's debug mode on the chosen target.
 *
 * `DBG_ENTER` replies `SUCCESS` immediately and then works: it resets the
 * target, flashes the image and starts execution. A failure arrives as a
 * later 0x4000 frame — `Cannot access target`, `Flash Download failed` — so
 * the outcome is read from `DBG_STATUS` and those frames, not from the reply
 * to the request.
 */
export async function enterDebug(
  session: KeilSession,
  target: "hardware" | "simulator",
  timeoutMs = 40_000,
): Promise<{ ok: boolean; log: string[]; reason?: string }> {
  const log: string[] = [];
  const { client } = session;

  const mark = client.mark;
  const pick = Buffer.alloc(44);
  pick.writeUInt32LE(target === "simulator" ? TARGET.SIM : TARGET.HW, 0);
  const chosen = await client.send(OP.PRJ_SET_DEBUG_TARGET, pick, 10_000);
  if (!chosen.ok) return { ok: false, log, reason: `could not select the ${target}: ${chosen.message ?? chosen.statusName}` };
  session.target = target;
  log.push(`target: ${target}`);

  const enter = await client.send(OP.DBG_ENTER, Buffer.alloc(0), 15_000);
  if (!enter.ok) return { ok: false, log, reason: `the debugger refused to start: ${enter.message ?? enter.statusName}` };

  // Entering is asynchronous: poll the status and read the stream for the
  // failure frames uVision sends instead of a bad reply.
  const deadline = Date.now() + timeoutMs;
  let lastLines = 0;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 400));
    const frames = client.since(mark);
    for (const frame of frames.slice(lastLines)) {
      const text = asyncText(frame) || commandWindowText(frame);
      if (text) log.push(text.trim());
    }
    lastLines = frames.length;

    const failure = frames.map((frame) => asyncText(frame)).find((text) => /cannot access target|flash download failed|error \d+:/i.test(text));
    if (failure) {
      session.debugging = false;
      return { ok: false, log, reason: `uVision could not start the debug session: ${failure.trim()}` };
    }

    const status = await client.send(OP.DBG_STATUS, Buffer.alloc(0), 5_000);
    if (status.ok && status.data.length >= 4 && status.data.readUInt32LE(0) === 0) {
      session.debugging = true;
      log.push(`entered ${target} debug mode`);
      return { ok: true, log };
    }
    if (status.status === 6 /* NOT_DEBUGGING */ && Date.now() - mark > 8_000 && frames.length === 0) {
      const detail = status.message ?? "the debugger reports it is not in a debug session";
      return { ok: false, log, reason: detail };
    }
  }
  if (session.debugging) return { ok: true, log };
  return { ok: false, log, reason: `uVision did not enter debug mode within ${Math.round(timeoutMs / 1000)} s` };
}

/* ---------- execution control ---------- */

export interface StopInfo {
  stopped: boolean;
  reason?: string;
  /** `STOPREASON` from the stop notification: 0 none, 1 breakpoint, 2 fault, … */
  reasonCode?: number;
  /** Where the program counter is, when the interface reports it. */
  pc?: number;
  /** Hardware breakpoint slot that fired, when the interface reports one. */
  slot?: number;
  /** The debugger's own words for the stop, when it sent any. */
  reasonText?: string;
  /** The command-window lines produced while running. */
  output: string[];
}

/** Start execution and wait until the target stops or times out. */
export async function run(session: KeilSession, timeoutMs = 30_000): Promise<StopInfo> {
  const mark = session.client.mark;
  const started = await session.client.send(OP.DBG_START_EXECUTION, Buffer.alloc(0), 8_000);
  // `TARGET_EXECUTING` means it is already running — which is what `run` was
  // asked to do, not a failure. Waiting for the next stop is the right answer.
  if (!started.ok && started.status !== 11) return { stopped: false, reason: started.message ?? started.statusName, output: [] };
  return waitForStop(session, mark, timeoutMs);
}

/**
 * Wait until the target is no longer executing.
 *
 * The stop is a `0x4000` frame echoing `UV_DBG_STOP_EXECUTION`, not a change
 * in `DBG_STATUS`: that reply is `SUCCESS` with a zero word whether the core
 * is running or halted, so polling it alone reported a running target as
 * stopped on the very first test. The notification is the signal; the status
 * is only used to notice that the session itself went away.
 */
export async function waitForStop(session: KeilSession, mark: number, timeoutMs = 30_000): Promise<StopInfo> {
  const { client } = session;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const frames = client.since(mark);
    const output = frames.map((frame) => commandWindowText(frame)).filter(Boolean);
    const stop = frames.find((frame) => isStopNotification(frame));
    if (stop) {
      const decoded = stopReason(stop);
      const reasons = frames.map((frame) => asyncText(frame)).filter(Boolean);
      return {
        stopped: true,
        ...(decoded ? { reasonCode: decoded.reason } : {}),
        ...(decoded?.pc ? { pc: decoded.pc } : {}),
        // `0xffffffff` is "no slot"; it must not be reported as a negative one.
        ...(decoded?.slot !== undefined && decoded.slot >= 0 ? { slot: decoded.slot } : {}),
        ...(reasons.length > 0 ? { reason: reasons[reasons.length - 1].trim() } : {}),
        output,
      };
    }
    const fault = frames.map((frame) => asyncText(frame)).find((text) => /cannot access target|flash download failed/i.test(text));
    if (fault) return { stopped: false, reason: fault.trim(), output };
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return { stopped: false, reason: `still running after ${Math.round(timeoutMs / 1000)} s`, output: client.since(mark).map(commandWindowText).filter(Boolean) };
}

/** Halt a running target. */
export async function halt(session: KeilSession): Promise<StopInfo> {
  const mark = session.client.mark;
  const stopped = await session.client.send(OP.DBG_STOP_EXECUTION, Buffer.alloc(0), 8_000);
  // `TARGET_STOPPED` is not a failure: the caller asked for a halt and the
  // target already was halted. Reporting it as one made `embed_debug halt` on
  // a stopped target look like a broken command.
  const alreadyStopped = stopped.status === 12;
  if (!stopped.ok && !alreadyStopped) return { stopped: false, reason: stopped.message ?? stopped.statusName, output: [] };
  if (alreadyStopped) return { stopped: true, reason: "the target was already stopped", output: [] };
  return waitForStop(session, mark, 10_000);
}

export type StepKind = "over" | "into" | "instruction" | "out";

/** Step and wait for the resulting stop. */
export async function step(session: KeilSession, kind: StepKind = "over", timeoutMs = 15_000): Promise<StopInfo> {
  const command = kind === "into" ? OP.DBG_STEP_INTO : kind === "instruction" ? OP.DBG_STEP_INSTRUCTION : kind === "out" ? OP.DBG_STEP_OUT : OP.DBG_STEP_HLL;
  const mark = session.client.mark;
  const replied = await session.client.send(command, Buffer.alloc(0), 8_000);
  if (!replied.ok) return { stopped: false, reason: replied.message ?? replied.statusName, output: [] };
  return waitForStop(session, mark, timeoutMs);
}

/* ---------- breakpoints ---------- */

export interface Breakpoint {
  number: number;
  type: number;
  enabled: boolean;
  /** The interface's own handle, used to delete or toggle this breakpoint. */
  tickMark: number;
  address?: number;
  expression?: string;
}

/**
 * The breakpoint stream is `0x5004` start / `0x5005` item / `0x5006` end.
 *
 * A real item, byte for byte from `STM32F429` / `main`:
 *
 *   type(4)=1  count(4)=1  enabled(4)=1  tickMark(4)=1
 *   address(8)=0x08006be0  exprLen(4)=5  "main"
 *
 * `tickMark` is the handle `UV_DBG_CHANGE_BP` takes, so it is carried on the
 * struct: deleting a breakpoint by list position is not the same thing.
 */
export function parseBreakpoints(frames: AsyncFrame[]): Breakpoint[] {
  const out: Breakpoint[] = [];
  for (const frame of frames) {
    if (frame.type !== 0x5005 || frame.data.length < 28) continue;
    const type = frame.data.readUInt32LE(0);
    const enabled = frame.data.readUInt32LE(8) !== 0;
    const tickMark = frame.data.readUInt32LE(12);
    const address = Number(frame.data.readBigUInt64LE(16));
    const length = frame.data.readUInt32LE(24);
    const text = length > 0 && 28 + length <= frame.data.length + 1 ? frame.data.subarray(28, 28 + length - 1).toString("latin1") : "";
    out.push({
      number: out.length + 1,
      type,
      enabled,
      tickMark,
      ...(address ? { address } : {}),
      ...(text ? { expression: text } : {}),
    });
  }
  return out;
}

/** Add a breakpoint at a function, `file:line`, or `*address`. */
export async function addBreakpoint(session: KeilSession, expression: string): Promise<{ ok: boolean; reply: Reply; breakpoints: Breakpoint[] }> {
  const mark = session.client.mark;
  const reply = await session.client.send(OP.DBG_CREATE_BP, breakpointParam(expression), 12_000);
  // `BP_REDEFINED` (19) is success with a caveat: the same location already
  // had a breakpoint, and uVision kept it. Treating it as failure made a
  // re-add after a delete look like the delete did not work.
  const ok = reply.ok || reply.status === 19 || reply.status === 22 /* BP_CREATED */;
  const frames = await session.client.collect(1500, 0x5006, mark);
  return { ok, reply, breakpoints: parseBreakpoints(frames) };
}

/** List the current breakpoints. */
export async function listBreakpoints(session: KeilSession): Promise<Breakpoint[]> {
  const mark = session.client.mark;
  await session.client.send(OP.DBG_ENUMERATE_BP, Buffer.alloc(0), 10_000);
  const frames = await session.client.collect(1500, 0x5006, mark);
  return parseBreakpoints(frames);
}

/** Delete a breakpoint by kind: `KILLBP` = 1, `ENABLEBP` = 2, `DISABLEBP` = 3. */
export async function changeBreakpoint(session: KeilSession, tickMark: number, operation: 1 | 2 | 3): Promise<Reply> {
  const payload = Buffer.alloc(4 + 4 + 32);
  payload.writeUInt32LE(operation, 0);
  payload.writeUInt32LE(tickMark, 4);
  return session.client.send(OP.DBG_CHANGE_BP, payload, 10_000);
}

/* ---------- inspection ---------- */

export interface StackFrame {
  level: number;
  address: number;
  returnAddress?: number;
  function?: string;
  file?: string;
  line?: number;
}

/**
 * Decode a `STACKENUM` frame (`0x5015`).
 *
 * The interface's own fields are address and return address; the symbol text
 * is appended by the debugger when it has the ELF loaded, so it is kept raw
 * and split rather than assumed to be at a fixed offset.
 */
export function parseStackFrames(frames: AsyncFrame[]): StackFrame[] {
  const out: StackFrame[] = [];
  for (const frame of frames) {
    if (frame.type !== 0x5015 && frame.type !== 0x5016) continue;
    const data = frame.data;
    if (data.length < 12) continue;
    const address = Number(data.readBigUInt64LE(4));
    const returnAddress = data.length >= 20 ? Number(data.readBigUInt64LE(12)) : undefined;
    const text = data.subarray(20).toString("latin1").replace(/\0.*$/s, "").trim();
    const match = /^(.*?)(?::(\d+))?$/.exec(text);
    out.push({
      level: out.length,
      address,
      ...(returnAddress !== undefined ? { returnAddress } : {}),
      ...(text ? { function: match?.[1]?.trim() || text } : {}),
      ...(match?.[2] ? { line: Number(match[2]) } : {}),
    });
  }
  return out;
}

/** Read the call stack, innermost first. */
export async function readStack(session: KeilSession): Promise<StackFrame[]> {
  const payload = Buffer.alloc(32);
  payload.writeUInt32LE(1, 0); // bFull
  const mark = session.client.mark;
  await session.client.send(OP.DBG_ENUM_STACK, payload, 10_000);
  const frames = await session.client.collect(1500, 0x5016, mark);
  return parseStackFrames(frames);
}

export interface RegisterValue {
  group: number;
  name: string;
  value: string;
  isPC: boolean;
  canChange: boolean;
}

/**
 * Decode `REGENUM` frames (`0x5028`).
 *
 * Measured layout, after the reply envelope:
 *
 *   group(u16)=0  index(u16)=0  name[16]="R0"  flags(u32)=0x0a0e0004  value[32]="0x00000000"
 *
 * `flags` packs `isPC:1 canChange:1` into its low bits and uses the high byte
 * for the display width, so only the two low bits are read here.
 */
export function parseRegisters(frames: AsyncFrame[]): RegisterValue[] {
  const out: RegisterValue[] = [];
  for (const frame of frames) {
    if (frame.type !== 0x5028) continue;
    const data = frame.data;
    if (data.length < 24) continue;
    const group = data.readUInt16LE(0);
    const name = fixedString(data, 4, 16);
    const flags = data.readUInt32LE(20);
    const value = fixedString(data, 24, 32);
    if (!name) continue;
    out.push({ group, name, value, isPC: (flags & 1) === 1, canChange: (flags & 2) === 2 });
  }
  return out;
}

/** Every register of the target, in the debugger's own groups. */
export async function readRegisters(session: KeilSession): Promise<RegisterValue[]> {
  // `REGENUM` ignores its `nGi`/`nItem` on this build: every request, including
  // an all-zero one, returns the same 152 registers in one burst. So it is
  // asked once, and the frames are read from the caller's mark — waiting for
  // the terminator after `send()` returned was what produced an empty list.
  const mark = session.client.mark;
  await session.client.send(OP.DBG_ENUM_REGISTERS, Buffer.alloc(48), 10_000);
  // The terminator is `0x5029`; a burst that never sends it still yields its
  // registers, so the frames are parsed whatever the collection saw.
  const frames = await session.client.collect(2000, 0x5029, mark);
  const all = session.client.since(mark);
  const merged = [...frames, ...all.filter((frame) => !frames.includes(frame))];
  return parseRegisters(merged);
}


/** Read memory through the debugger. */
export async function readMemory(session: KeilSession, address: number, bytes: number): Promise<{ bytes: number[]; errorAddress?: number } | null> {
  const reply = await session.client.send(OP.DBG_MEM_READ, memoryRequest(address, Math.max(1, Math.min(bytes, 0x2000))), 12_000);
  if (!reply.ok) return null;
  const decoded = readMemoryReply(reply.data);
  return decoded ? { bytes: decoded.bytes, ...(decoded.errorAddress !== undefined ? { errorAddress: decoded.errorAddress } : {}) } : null;
}

/** Write memory through the debugger, then read it back. */
export async function writeMemory(session: KeilSession, address: number, bytes: number[]): Promise<{ ok: boolean; readBack: number[] | null; detail: string }> {
  const wrote = await session.client.send(OP.DBG_MEM_WRITE, memoryWrite(address, bytes), 12_000);
  if (!wrote.ok) return { ok: false, readBack: null, detail: wrote.message ?? wrote.statusName };
  const back = await readMemory(session, address, bytes.length);
  const readBack = back?.bytes ?? null;
  const same = readBack !== null && readBack.every((byte, index) => byte === bytes[index]);
  return {
    ok: true,
    readBack,
    detail: same
      ? `wrote ${bytes.length} byte(s) and read them back`
      : `wrote ${bytes.length} byte(s) but the read-back differs — the region may be read-only or mask bits`,
  };
}

/** Evaluate an expression through the command window and return its line(s). */
export async function evaluate(session: KeilSession, expression: string): Promise<{ ok: boolean; lines: string[]; message?: string }> {
  // `EXECCMD { u32 bEcho; u32 nRes[7]; SSTR sCmd }`
  const payload = Buffer.alloc(4 + 28 + 260);
  payload.writeUInt32LE(1, 0); // echo to the command window, which is how the answer comes back
  sstr(expression).copy(payload, 32);
  const reply = await session.client.send(OP.DBG_EXEC_CMD, payload, 12_000);
  const frames = await session.client.collect(400);
  const lines = frames.map((frame) => commandWindowText(frame)).filter(Boolean);
  return {
    ok: reply.ok && lines.length > 0,
    lines,
    ...(!reply.ok ? { message: reply.message ?? reply.statusName } : {}),
  };
}

/** Where the program is stopped, as `file:line` when the symbols allow it. */
export async function currentLocation(session: KeilSession): Promise<{ address: number; file?: string; line?: number } | null> {
  const registers = readPCFrom(await readRegisters(session));
  if (registers === null) return null;
  const request = Buffer.alloc(28);
  request.writeBigUInt64LE(BigInt(registers), 4);
  const reply = await session.client.send(OP.DBG_ADR_TOFILELINE, request, 8_000);
  if (!reply.ok) return { address: registers };
  const data = reply.data;
  if (data.length < 40) return { address: registers };
  const line = data.readUInt32LE(0);
  const start = data.indexOf(0, 36);
  const file = start > 0 ? data.subarray(start + 1).toString("latin1").replace(/\0.*$/s, "") : "";
  return { address: registers, ...(file ? { file } : {}), ...(line ? { line } : {}) };
}

/** The PC register from a register list, whichever name the core uses. */
function readPCFrom(registers: RegisterValue[]): number | null {
  const pc = registers.find((entry) => entry.isPC) ?? registers.find((entry) => /^(PC|R15)$/i.test(entry.name));
  if (!pc) return null;
  const value = Number.parseInt(pc.value.replace(/^0x/i, ""), pc.value.trim().toLowerCase().startsWith("0x") ? 16 : /^[0-9a-f]+$/i.test(pc.value.trim()) ? 16 : 10);
  return Number.isFinite(value) ? value : null;
}

/* ---------- project editing ---------- */

/** The project's targets, as uVision reports them. */
export async function projectTargets(session: KeilSession): Promise<string[]> {
  const mark = session.client.mark;
  await session.client.send(OP.PRJ_ENUM_TARGETS, Buffer.alloc(0), 10_000);
  const frames = await session.client.collect(1200, 0x5023, mark);
  return frames
    .filter((frame) => frame.type === 0x5022)
    .map((frame) => frame.data.subarray(4).toString("latin1").replace(/\0.*$/s, ""))
    .filter(Boolean);
}

/** The project's groups, in order. */
export async function projectGroups(session: KeilSession): Promise<string[]> {
  const mark = session.client.mark;
  await session.client.send(OP.PRJ_ENUM_GROUPS, Buffer.alloc(0), 10_000);
  const frames = await session.client.collect(1200, 0x5009, mark);
  return frames
    .filter((frame) => frame.type === 0x5008)
    .map((frame) => frame.data.subarray(4).toString("latin1").replace(/\0.*$/s, ""))
    .filter(Boolean);
}

/** The files in one group. */
export async function projectFiles(session: KeilSession, group: string): Promise<string[]> {
  const mark = session.client.mark;
  await session.client.send(OP.PRJ_ENUM_FILES, prjData(group), 10_000);
  const frames = await session.client.collect(1500, 0x500c, mark);
  return frames
    .filter((frame) => frame.type === 0x500b)
    .map((frame) => frame.data.subarray(4).toString("latin1").replace(/\0.*$/s, ""))
    .filter(Boolean);
}

export async function addGroup(session: KeilSession, group: string): Promise<Reply> {
  return session.client.send(OP.PRJ_ADD_GROUP, prjData(group), 12_000);
}

export async function addFile(session: KeilSession, group: string, file: string): Promise<Reply> {
  return session.client.send(OP.PRJ_ADD_FILE, prjData(group, file), 12_000);
}

export async function removeFile(session: KeilSession, group: string, file: string): Promise<Reply> {
  return session.client.send(OP.PRJ_DEL_FILE, prjData(group, file), 12_000);
}

export async function removeGroup(session: KeilSession, group: string): Promise<Reply> {
  return session.client.send(OP.PRJ_DEL_GROUP, prjData(group), 12_000);
}

/** The current target's name. */
export async function currentTarget(session: KeilSession): Promise<string> {
  const reply = await session.client.send(OP.PRJ_GET_CUR_TARGET, Buffer.alloc(4), 8_000);
  return reply.ok ? reply.data.subarray(4).toString("latin1").replace(/\0.*$/s, "") : "";
}

export async function setTarget(session: KeilSession, target: string): Promise<Reply> {
  return session.client.send(OP.PRJ_SET_TARGET, prjData(target), 10_000);
}

/** Read a per-target option (defines, include paths, optimisation, …). */
export async function getOption(session: KeilSession, option: OptionName, target?: string): Promise<{ ok: boolean; values: string[]; message?: string }> {
  const name = target ?? (await currentTarget(session));
  const reply = await session.client.send(OP.PRJ_GET_OPTITEM, trnOpt(OPT[option], { target: name }), 10_000);
  return {
    ok: reply.ok,
    values: reply.ok ? [trnOptValue(reply.data)].filter(Boolean) : [],
    ...(!reply.ok ? { message: reply.message ?? reply.statusName } : {}),
  };
}

/** Write a per-target option. The value replaces the current one wholesale. */
export async function setOption(session: KeilSession, option: OptionName, value: string, target?: string): Promise<Reply> {
  const name = target ?? (await currentTarget(session));
  return session.client.send(OP.PRJ_SET_OPTITEM, trnOpt(OPT[option], { target: name, item: value }), 10_000);
}

/** Build through the running uVision, returning its output lines. */
export async function buildInIde(session: KeilSession, rebuild = false, timeoutMs = 10 * 60_000): Promise<{ ok: boolean; status: number; lines: string[] }> {
  const mark = session.client.mark;
  const started = Date.now();
  const reply = await session.client.send(rebuild ? OP.PRJ_REBUILD : OP.PRJ_BUILD, Buffer.alloc(0), 15_000);
  if (!reply.ok) return { ok: false, status: reply.status, lines: [reply.message ?? reply.statusName] };
  let status = 0;
  while (Date.now() - started < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const frames = session.client.since(mark);
    // `0x5000` is "build complete" and its payload starts with the build code.
    const done = frames.find((frame) => frame.type === 0x5000);
    if (done && done.data.length >= 8) {
      status = done.data.readUInt32LE(4);
      break;
    }
  }
  const lines: string[] = [];
  for (const frame of session.client.since(mark)) {
    if (frame.type === 0x5001 || frame.type === 0x5020) {
      const text = frame.type === 0x5020 ? commandWindowText(frame) : frame.data.subarray(8).toString("latin1").replace(/\0+$/, "");
      if (text) lines.push(text);
    }
  }
  // UVBUILDCODES: 1 ok, 2 warnings, 3 errors, 4 cancelled, 5 cleaned.
  return { ok: status === 1 || status === 2, status, lines: dedupe(lines) };
}

/** The NUL-terminated printable strings in a buffer, in order. */
function printableRuns(buffer: Buffer): string[] {
  const out: string[] = [];
  let current = "";
  for (const byte of buffer) {
    if (byte >= 0x20 && byte <= 0x7e) {
      current += String.fromCharCode(byte);
      continue;
    }
    if (current.length > 1) out.push(current);
    current = "";
  }
  if (current.length > 1) out.push(current);
  return out;
}

function dedupe(lines: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of lines) {
    const key = line.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

/** Ask uVision to download the built image to flash on its configured target. */
export async function flashInIde(session: KeilSession, timeoutMs = 5 * 60_000): Promise<{ ok: boolean; lines: string[] }> {
  const mark = session.client.mark;
  const reply = await session.client.send(OP.PRJ_FLASH_DOWNLOAD, Buffer.alloc(0), 20_000);
  if (!reply.ok) return { ok: false, lines: [reply.message ?? reply.statusName] };
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 400));
    const frames = session.client.since(mark);
    const failed = frames.map(asyncText).find((text) => /flash download failed|error \d+:/i.test(text));
    const finished = frames.find((frame) => frame.type === 0x5001);
    if (failed) return { ok: false, lines: dedupe(frames.map((frame) => asyncText(frame) || commandWindowText(frame)).filter(Boolean)) };
    if (finished) return { ok: true, lines: dedupe(frames.map((frame) => asyncText(frame) || commandWindowText(frame)).filter(Boolean)) };
  }
  return { ok: false, lines: dedupe(session.client.since(mark).map((frame) => asyncText(frame) || commandWindowText(frame)).filter(Boolean)) };
}



export interface Variable {
  name: string;
  value: string;
  type?: string;
  /** Set when the debugger marks the value editable. */
  editable?: boolean;
  pointer?: boolean;
  struct?: boolean;
  array?: boolean;
  global?: boolean;
  static?: boolean;
}

/**
 * Decode `VARINFO` frames (`0x5041`).
 *
 * Layout after the reply envelope:
 *
 *   nID(4) index(4) count(4) typeSize(4) flags(4) value(SSTR) type(SSTR) name(SSTR) qualified(SSTR)
 *
 * The `SSTR`s are fixed 260-byte blocks, so they are read by offset rather
 * than by scanning for NULs — a struct's rendered value contains plenty of
 * them.
 */
export function parseVariables(frames: AsyncFrame[]): Variable[] {
  const out: Variable[] = [];
  for (const frame of frames) {
    if (frame.type !== 0x5041) continue;
    const data = frame.data;
    if (data.length < 20) continue;
    const flags = data.readUInt32LE(16);
    const value = readSstr(data, 20);
    const type = readSstr(data, 280);
    const name = readSstr(data, 540);
    const qualified = readSstr(data, 800);
    const label = name || qualified;
    if (!label) continue;
    out.push({
      name: label,
      value,
      ...(type ? { type } : {}),
      editable: (flags & 1) === 1,
      pointer: (flags & 2) === 2,
      struct: (flags & 4) === 4,
      array: (flags & 64) === 64,
      global: (flags & 1024) === 1024,
      static: (flags & 512) === 512,
    });
  }
  return out;
}

/** Every local and global the debugger can enumerate. */
export async function readVariables(session: KeilSession): Promise<Variable[]> {
  const request = Buffer.alloc(20);
  request.writeUInt32LE(0, 0); // nID
  request.writeUInt32LE(0, 4); // nFrame
  request.writeUInt32LE(0, 8); // nTask
  const mark = session.client.mark;
  const reply = await session.client.send(OP.DBG_ENUM_VARIABLES, request, 10_000);
  // `NOT_FOUND` here means the debugger has no symbol table to enumerate —
  // an image built without debug info, or the simulator with nothing loaded.
  // That is an empty list, not a transport failure.
  if (!reply.ok && reply.status !== 9) return [];
  const frames = await session.client.collect(3000, 0x5042, mark);
  return parseVariables(frames);
}

/**
 * Evaluate a watch expression.
 *
 * `UV_DBG_EVAL_WATCH_EXPRESSION` answers `NOT_SUPPORTED` on uVision 5.43a for
 * every expression, so the command window is the working path: `EVAL <expr>`
 * prints the value there and the reply echoes it. This is kept as a separate
 * call so a build that does support the interface is used directly.
 */
export async function evaluateWatch(session: KeilSession, expression: string): Promise<{ ok: boolean; value?: string; message?: string }> {
  const payload = Buffer.alloc(520);
  sstr(expression).copy(payload, 0);
  const reply = await session.client.send(OP.DBG_EVAL_WATCH_EXPRESSION, payload, 10_000);
  if (!reply.ok) return { ok: false, message: reply.message ?? reply.statusName };
  const value = readSstr(reply.data, 20);
  return { ok: Boolean(value), ...(value ? { value } : {}) };
}

/** Evaluate through the command window, which every build supports. */
export async function evalInWindow(session: KeilSession, expression: string): Promise<{ ok: boolean; value?: string; lines: string[] }> {
  const result = await evaluate(session, `EVAL ${expression}`);
  // The window echoes the command first, then its answer.
  const answer = result.lines.filter((line) => line.trim() !== `EVAL ${expression}` && !/^\s*\^/.test(line));
  const text = answer.join(" ").trim();
  return { ok: text.length > 0 && !/^\*\*\* error/i.test(text), ...(text ? { value: text } : {}), lines: result.lines };
}

/** Tasks, for an RTOS-aware target (RTX, or FreeRTOS with its awareness plugin). */
export async function readTasks(session: KeilSession): Promise<{ id: number; name: string; address: number }[]> {
  const mark = session.client.mark;
  await session.client.send(OP.DBG_ENUM_TASKS, Buffer.alloc(32), 10_000);
  const frames = await session.client.collect(1500, 0x5052, mark);
  return frames
    .filter((frame) => frame.type === 0x5051)
    .map((frame) => {
      const id = frame.data.readUInt32LE(0);
      const address = frame.data.length >= 12 ? Number(frame.data.readBigUInt64LE(4)) : 0;
      const name = frame.data.subarray(12, 12 + 256).toString("latin1").replace(/\0.*$/s, "");
      return { id, name, address };
    })
    .filter((task) => task.name);
}

/** The trace/VTR items the target exposes. */
export async function readVtr(session: KeilSession): Promise<{ name: string; value?: number }[]> {
  const mark = session.client.mark;
  await session.client.send(OP.DBG_ENUM_VTR, Buffer.alloc(32), 10_000);
  const frames = await session.client.collect(1500, 0x5019, mark);
  return frames
    .filter((frame) => frame.type === 0x5018)
    .map((frame) => {
      const name = frame.data.subarray(0, 64).toString("latin1").replace(/\0.*$/s, "");
      const value = frame.data.length >= 72 ? frame.data.readUInt32LE(68) : undefined;
      return { name, ...(value !== undefined ? { value } : {}) };
    })
    .filter((entry) => entry.name);
}

/* ---------- registers, memory, addresses ---------- */

/** Register groups (`0x5025`), as the debugger's own panels name them. */
export async function readRegisterGroups(session: KeilSession): Promise<string[]> {
  // Request is a `VSET`; the reply frames are `{ u32 len, char name[] }`
  // (`04 00 00 00 "Core"`), measured against a Cortex-M4 target.
  const mark = session.client.mark;
  await session.client.send(OP.DBG_ENUM_REGISTER_GROUPS, Buffer.alloc(260), 10_000);
  const frames = await session.client.collect(1500, 0x5026, mark);
  return frames
    .filter((frame) => frame.type === 0x5025)
    .map((frame) => readCountedString(frame.data, 0))
    .filter(Boolean);
}

/** Set a register by name. */
export async function setRegister(session: KeilSession, name: string, value: string): Promise<Reply> {
  const payload = Buffer.alloc(520);
  sstr(name).copy(payload, 0);
  sstr(value).copy(payload, 260);
  return session.client.send(OP.DBG_REGISTER_SET, payload, 10_000);
}

/**
 * Resolve an address to `file:line`.
 *
 * `AFLMAP`: `{ u32 nLine, u64 nAdr, u32 iFile, u32 iFunc, i32 nRes[5], char szFile[] }`,
 * so the line is at 0 and the file name starts at 40.
 */
export async function addressToSource(session: KeilSession, address: number): Promise<{ file?: string; line?: number; function?: string } | null> {
  const payload = Buffer.alloc(4 + 8 + 4 + 4 + 20 + 260);
  payload.writeUInt32LE(0, 0);
  payload.writeBigUInt64LE(BigInt(address), 4);
  const reply = await session.client.send(OP.DBG_ADR_TOFILELINE, payload, 8_000);
  if (!reply.ok) return null;
  const data = reply.data;
  if (data.length < 20) return null;
  const line = data.readUInt32LE(0);
  // Measured reply for `0x08006460`: the line, the address, a file index, a
  // function index, then reserved zeros, then `"system_stm32f4xx.c SystemInit "`.
  // The reserved words are not a fixed size this header documents, so the two
  // strings are found by scanning for the first printable runs rather than by
  // trusting an offset — which is what made every stop report "(no source)".
  const [file, func] = printableRuns(data.subarray(20));
  return { ...(file ? { file } : {}), ...(line ? { line } : {}), ...(func ? { function: func } : {}) };
}

/** Watch an address for reads, writes, or both (hardware watchpoint). */
export async function addAccessBreakpoint(
  session: KeilSession,
  expression: string,
  kind: "read" | "write" | "readwrite",
  accessSize = 4,
): Promise<Reply> {
  const type = kind === "read" ? BREAK.READ : kind === "write" ? BREAK.WRITE : BREAK.READWRITE;
  return session.client.send(OP.DBG_CREATE_BP, breakpointParam(expression, { type, accessSize }), 12_000);
}

/* ---------- project management ---------- */

/** Build, rebuild or clean through the running uVision. */
export async function buildProject(session: KeilSession, mode: "build" | "rebuild" | "clean" = "build"): Promise<Reply> {
  const command = mode === "rebuild" ? OP.PRJ_REBUILD : mode === "clean" ? OP.PRJ_CLEAN : OP.PRJ_BUILD;
  return session.client.send(command, Buffer.alloc(0), 15_000);
}

/** Cancel a build in progress. */
export async function cancelBuild(session: KeilSession): Promise<Reply> {
  return session.client.send(OP.PRJ_BUILD_CANCEL, Buffer.alloc(0), 8_000);
}

/** Erase the target's flash (where the algorithm supports it). */
export async function eraseFlash(session: KeilSession): Promise<Reply> {
  return session.client.send(OP.PRJ_FLASH_ERASE, Buffer.alloc(0), 60_000);
}

/** The current target's output file name. */
export async function getOutputName(session: KeilSession): Promise<string> {
  const reply = await session.client.send(OP.PRJ_GET_OUTPUTNAME, Buffer.alloc(4), 8_000);
  return reply.ok ? readSstr(reply.data, 0) : "";
}
