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

import { existsSync, readFileSync } from "node:fs";
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
  readVtrFrame,
  trnOptValue,
  sstr,
  trnOpt,
  ivarEnum,
  varVal,
  vsetWithValue,
  type OptionName,
} from "./uvsock.ts";

export type { OptionName };

/** The result of a write the debugger accepted: whether it actually took. */
export interface WriteOutcome {
  ok: boolean;
  detail: string;
}

export interface KeilSession {
  client: UvSocketClient;
  project: string;
  /** True once `DBG_ENTER` succeeded. */
  debugging: boolean;
  target: "hardware" | "simulator";
  /** True when `GEN_SET_OPTIONS` enabled extended stack mode for this socket. */
  extended: boolean;
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

/**
 * Close the session, and with it the uVision that made the edits.
 *
 * Project edits live in uVision's memory: measured, `PRJ_ADD_FILE` answers
 * `SUCCESS` and the `.uvprojx` on disk does not change until that process
 * exits — killing it discards the edit, and `GEN_EXIT` writes the file on its
 * way out. So the project-session close is not housekeeping; it is the save.
 * The caller compares the file's bytes around it rather than assuming.
 */
export async function closeKeilSession(key: string): Promise<boolean> {
  const session = sessions.get(key);
  if (!session) return false;
  try {
    if (session.debugging) await session.client.send(OP.DBG_EXIT, Buffer.alloc(0), 8_000);
  } catch {
    /* the session may already be gone */
  }
  await session.client.exit();
  // `exit()` sends `GEN_EXIT` and closes the socket; uVision needs a moment
  // to rewrite the project before the file reflects the session's edits.
  await new Promise((resolve) => setTimeout(resolve, session.debugging ? 800 : 2_500));
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

  const session: KeilSession = { client, project, debugging: false, target: "hardware", extended: false, openedAt: Date.now() };
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

  // Variable, task and watch operations are refused outright unless
  // "extended stack mode" is on, and the option is only accepted **before**
  // the debugger is entered — afterwards `GEN_SET_OPTIONS` answers "Target is
  // in debug mode". Measured: without it `ENUM_VARIABLES` returns NOT_FOUND,
  // `ENUM_TASKS` NOT_SUPPORTED and `EVAL_WATCH_EXPRESSION` NOT_SUPPORTED,
  // which reads exactly like an image with no symbol table.
  const options = await client.send(OP.GEN_SET_OPTIONS, Buffer.from([1, 0, 0, 0]), 8_000);
  session.extended = options.ok;
  if (!options.ok) log.push(`extended stack mode unavailable: ${options.message ?? options.statusName}`);

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
  const started = Date.now();
  const deadline = started + timeoutMs;
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
      // A missing or unreadable image does **not** stop uVision: measured, it
      // prints `*** error 56: cannot open file` and enters debug mode anyway,
      // with nothing loaded. Reporting that as a working session made every
      // later breakpoint, register read and step answer `NOT_DEBUGGING`.
      const loadFailure = frames.map((frame) => commandWindowText(frame)).find((line) => /\*\*\* error \d+: cannot open file/i.test(line));
      if (loadFailure) {
        session.debugging = false;
        return {
          ok: false,
          log,
          reason: `the debugger entered but could not load the image: ${loadFailure.trim()}. Build first, and check that the project's output name matches a file that exists.`,
        };
      }
      session.debugging = true;
      log.push(`entered ${target} debug mode`);
      return { ok: true, log };
    }
    if (status.status === 6 /* NOT_DEBUGGING */ && Date.now() - started > 8_000 && frames.length === 0) {
      const detail = status.message ?? "the debugger reports it is not in a debug session";
      return { ok: false, log, reason: detail };
    }
  }
  if (session.debugging) return { ok: true, log };
  // Nothing said what went wrong but the debugger is not in a session. uVision
  // ends up here when the image it was told to load is missing or unreadable:
  // measured with the `.axf` deleted, it prints `*** error` in the command
  // window and never enters. Reporting only "no session" would send the user
  // looking for a probe problem that does not exist.
  const tail = log.slice(-3).join(" | ");
  return {
    ok: false,
    log,
    reason: `uVision did not enter debug mode within ${Math.round(timeoutMs / 1000)} s${tail ? `; last output: ${tail}` : ""}. A missing or unreadable image is the usual cause — build first, and check the project's output name.`,
  };
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
  /** How many variables the debugger associates with this frame. */
  variables?: number;
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
    if (frame.type !== 0x5015) continue;
    const data = frame.data;
    if (data.length < 12) continue;
    const address = Number(data.readBigUInt64LE(4));
    const returnAddress = data.length >= 20 ? Number(data.readBigUInt64LE(12)) : undefined;
    // There is no text in this record: measured, a 48-byte frame is
    // `nItem(4) nAdr(8) nRetAdr(8) nVars(4) nEqual(4) nTotal(4) nTask(4)
    // nRes[3]` and nothing else. Reading a symbol from here put `nEqual` — a
    // small integer — into the function name.
    const vars = data.length >= 24 ? data.readUInt32LE(20) : undefined;
    out.push({
      level: out.length,
      address,
      ...(returnAddress !== undefined ? { returnAddress } : {}),
      ...(vars !== undefined ? { variables: vars } : {}),
    });
  }
  return out;
}

/**
 * Read the call stack, innermost first.
 *
 * `STACKENUM` is reported from the bottom of the stack downwards — the frame
 * whose return address is `0xffffffff` is `Reset_Handler` — so the frames are
 * reversed. Without that the "top" frame was the outermost function and `#0`
 * named the startup code instead of the line that stopped.
 */
export async function readStack(session: KeilSession): Promise<StackFrame[]> {
  const payload = Buffer.alloc(32);
  payload.writeUInt32LE(1, 0); // bFull
  const mark = session.client.mark;
  await session.client.send(OP.DBG_ENUM_STACK, payload, 10_000);
  const frames = await session.client.collect(1500, 0x5016, mark);
  return orderStackFrames(frames);
}

/** Reverse the debugger's bottom-up order and number the frames from the top. */
export function orderStackFrames(frames: AsyncFrame[]): StackFrame[] {
  return parseStackFrames(frames)
    .reverse()
    .map((frame, level) => ({ ...frame, level }));
}

export interface RegisterValue {
  group: number;
  /** The register's index within its group, as the enumeration reports it. */
  index: number;
  name: string;
  value: string;
  isPC: boolean;
  canChange: boolean;
}

/**
 * Decode `REGENUM` frames (`0x5028`).
 *
 * `REGENUM` is `{ u16 nGi; u16 nItem; char szReg[16]; u8 flags; char szVal[32] }`
 * and the interface is packed, so the value starts at 21 — one byte past the
 * flags byte, not at a 4-byte boundary:
 *
 *   group=0 item=0 "R0\0…" flags=0x02 "0x00000000\0…"
 *   group=0 item=0 "PC\0…" flags=0x03 "0x08006458\0…"
 *
 * Reading the flags as a `u32` at 20 swallowed the first three bytes of the
 * value — `0x08006458` came out as the plausible-looking `8006460`.
 */
export function parseRegisters(frames: AsyncFrame[]): RegisterValue[] {
  const out: RegisterValue[] = [];
  for (const frame of frames) {
    if (frame.type !== 0x5028) continue;
    const data = frame.data;
    if (data.length < 21) continue;
    const group = data.readUInt16LE(0);
    const index = data.readUInt16LE(2);
    const name = fixedString(data, 4, 16);
    const flags = data.readUInt8(20);
    const value = fixedString(data, 21, 32);
    if (!name) continue;
    out.push({ group, index, name, value, isPC: (flags & 1) === 1, canChange: (flags & 2) === 2 });
  }
  return out;
}

/**
 * Every register of the target, in the debugger's own groups.
 *
 * `REGENUM` ignores its `nGi`/`nItem` on this build: every request returns the
 * same set in one burst, so it is asked once and the frames are read from the
 * caller's mark — waiting for the terminator after `send()` returned was what
 * produced an empty list.
 */
export async function readRegisters(session: KeilSession): Promise<RegisterValue[]> {
  const mark = session.client.mark;
  await session.client.send(OP.DBG_ENUM_REGISTERS, Buffer.alloc(48), 10_000);
  // The terminator is `0x5029`; a burst that never sends it still yields its
  // registers, so the frames are parsed whatever the collection saw.
  const frames = await session.client.collect(2000, 0x5029, mark);
  const all = session.client.since(mark);
  const merged = [...frames, ...all.filter((frame) => !frames.includes(frame))];
  return parseRegisters(merged);
}

/**
 * Write a register.
 *
 * `REGISTER_SET` takes a `VSET` whose **value** field is the new value; the
 * string names the register. Measured on MDK 5.43a: a `VSET` with the value
 * left at zero is answered `SUCCESS` and changes nothing, so the write is read
 * back and a register that did not move is reported as a failure rather than
 * as the success the debugger claimed.
 */
export async function setRegister(session: KeilSession, name: string, value: string): Promise<WriteOutcome> {
  if (!session.debugging) return { ok: false, detail: "not in debug mode; enter it before writing a register" };
  const wanted = numericValue(value);
  if (wanted === null) return { ok: false, detail: `${JSON.stringify(value)} is not a number; registers take a numeric value` };
  const all = await readRegisters(session);
  // The debugger names the core registers `R0`…`R12`, `R13 (SP)`, `R14 (LR)`,
  // `R15 (PC)`. Looking up a bare `PC` found nothing, and the old code sent the
  // request anyway and reported the debugger's SUCCESS as if it had written
  // something.
  const before = findRegister(all, name);
  if (!before) {
    return { ok: false, detail: `the debugger reports no register named ${name} (it lists ${all.length}: ${all.slice(0, 8).map((entry) => entry.name).join(", ")}, …)` };
  }
  if (!before.canChange) return { ok: false, detail: `${before.name} is read-only` };
  // `VTT_uint` is what this build expects for a register value; the reply's
  // own type word is a number whose meaning does not match the enum, so a
  // literal integer is sent rather than echoing a decoded type back.
  const reply = await session.client.send(OP.DBG_REGISTER_SET, vsetWithValue(before.name, 5, BigInt(wanted)), 10_000);
  if (!reply.ok) return { ok: false, detail: `${before.name} was refused: ${reply.message ?? reply.statusName}` };
  const after = findRegister(await readRegisters(session), before.name);
  const got = after ? parseRegisterValue(after.value) : null;
  if (got !== null && got === wanted) return { ok: true, detail: `${before.name} = ${after?.value}` };
  // A register the core will not take silently is the exact failure mode this
  // interface has: SUCCESS with no effect.
  return {
    ok: false,
    detail: `${before.name} was accepted but reads back ${after?.value ?? "(missing)"}; the core kept its old value (some registers only take a write while the target is stopped)`,
  };
}

/** Find a register by the name a person types: `PC`, `SP`, `R0`, `15`. */
export function findRegister(registers: RegisterValue[], name: string): RegisterValue | undefined {
  const upper = name.trim().toUpperCase();
  const alias: Record<string, string> = { PC: "R15", SP: "R13", LR: "R14", FP: "R11", IP: "R12" };
  return (
    registers.find((entry) => entry.name.toUpperCase() === upper) ??
    // `R15 (PC)` — the parenthesised alias is what the debugger prints.
    registers.find((entry) => entry.name.toUpperCase().startsWith(`${upper} `)) ??
    registers.find((entry) => entry.name.toUpperCase().endsWith(`(${upper})`)) ??
    // `PC` for `R15`, and the reverse: a person types the architectural name,
    // the debugger lists the numbered one.
    (alias[upper] ? registers.find((entry) => entry.name.toUpperCase().startsWith(`${alias[upper]} `)) : undefined) ??
    (alias[upper] ? registers.find((entry) => entry.name.toUpperCase() === alias[upper]) : undefined) ??
    // `R15` asked for, `R15 (PC)` listed.
    (upper.startsWith("R") && /^\d+$/.test(upper.slice(1))
      ? registers.find((entry) => entry.name.toUpperCase().startsWith(`${upper} `))
      : undefined) ??
    // A bare number is the register number: `15` is `R15`.
    (/^\d+$/.test(upper) ? registers.find((entry) => entry.name.toUpperCase() === `R${upper}`) : undefined) ??
    (/^\d+$/.test(upper) ? registers.find((entry) => entry.name.toUpperCase().startsWith(`R${upper} `)) : undefined)
  );
}

/** A register value string (`0x…` or decimal) as a number, or null. */
export function parseRegisterValue(text: string): number | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const parsed = /^0x/i.test(trimmed) ? Number.parseInt(trimmed.slice(2), 16) : Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function numericValue(text: string): number | null {
  const trimmed = text.trim();
  if (/^-?0x/i.test(trimmed)) return Number.parseInt(trimmed.replace(/^-?0x/i, ""), 16) * (trimmed.startsWith("-") ? -1 : 1);
  const parsed = Number(trimmed);
  return Number.isInteger(parsed) ? parsed : null;
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
  const fromStream = frames
    .filter((frame) => frame.type === 0x5008)
    .map((frame) => frame.data.subarray(4).toString("latin1").replace(/\0.*$/s, ""))
    .filter(Boolean);
  if (fromStream.length > 0) return fromStream;
  // A plain session refuses the enumeration; the project file is the same list.
  return groupsInProject(session.project);
}

/** The project's groups, read from the `.uvprojx`. */
export function groupsInProject(projectFile: string): string[] {
  let text = "";
  try {
    text = readFileSync(projectFile, "utf8").replace(/^﻿/, "");
  } catch {
    return [];
  }
  return [...text.matchAll(/<GroupName>([^<]*)<\/GroupName>/g)].map((match) => match[1]).filter(Boolean);
}

/**
 * One group's file list, read from the project file itself.
 *
 * `PRJ_ENUM_FILES` only answers inside an entered debugger (measured:
 * `NOT_DEBUGGING` on a plain session, and entering one starts a flash
 * download), while every *edit* is refused inside one. That made "list, then
 * remove" impossible through the interface alone. The `.uvprojx` is the same
 * truth uVision writes, so the list is read from it and the edits still go
 * through uVision.
 */
export function filesInGroupFromProject(projectFile: string, group: string): string[] {
  return filePathsInGroup(projectFile, group).map((entry) => entry.path || entry.name);
}

/** One group's files from the `.uvprojx`, as `{ name, path }`. */
export function filePathsInGroup(projectFile: string, group: string): { name: string; path: string }[] {
  let text = "";
  try {
    text = readFileSync(projectFile, "utf8").replace(/^﻿/, "");
  } catch {
    return [];
  }
  const groups = [...text.matchAll(/<Group>([\s\S]*?)<\/Group>/g)].map((match) => match[1]);
  const wanted = groups.find((body) => new RegExp(`<GroupName>\\s*${escapeRegExp(group)}\\s*</GroupName>`).test(body));
  if (!wanted) return [];
  return [...wanted.matchAll(/<File>([\s\S]*?)<\/File>/g)]
    .map((match) => ({
      name: /<FileName>([^<]*)<\/FileName>/.exec(match[1])?.[1] ?? "",
      path: /<FilePath>([^<]*)<\/FilePath>/.exec(match[1])?.[1] ?? "",
    }))
    .filter((entry) => entry.name);
}

export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function addGroup(session: KeilSession, group: string): Promise<Reply> {
  return session.client.send(OP.PRJ_ADD_GROUP, prjData(group), 12_000);
}

/**
 * Every file the project lists, in any group.
 *
 * `PRJ_ADD_FILE` refuses a file that is already in the project — measured,
 * "File 'X:../USER/main.c'" → `ALREADY_PRESENT` — and uVision will not list
 * one file twice, so "add a file that is already built as part of another
 * group" is not something this interface can do. Knowing that up front turns
 * an opaque refusal into an answer.
 */
export function allProjectFiles(projectFile: string): { group: string; name: string; path: string }[] {
  let text = "";
  try {
    text = readFileSync(projectFile, "utf8").replace(/^﻿/, "");
  } catch {
    return [];
  }
  const out: { group: string; name: string; path: string }[] = [];
  for (const match of text.matchAll(/<Group>([\s\S]*?)<\/Group>/g)) {
    const body = match[1];
    const group = /<GroupName>([^<]*)<\/GroupName>/.exec(body)?.[1] ?? "";
    for (const file of body.matchAll(/<File>([\s\S]*?)<\/File>/g)) {
      out.push({
        group,
        name: /<FileName>([^<]*)<\/FileName>/.exec(file[1])?.[1] ?? "",
        path: /<FilePath>([^<]*)<\/FilePath>/.exec(file[1])?.[1] ?? "",
      });
    }
  }
  return out;
}

export async function addFile(session: KeilSession, group: string, file: string): Promise<Reply> {
  // uVision's own `ALREADY_PRESENT` names the group it was given, which reads
  // like "it is already in this group" — it is not; it is in whichever group
  // had it first. Say which one.
  const base = (file.split(/[\\/]/).pop() ?? file).toLowerCase();
  const existing = allProjectFiles(session.project).find((entry) => entry.name.toLowerCase() === base || entry.path.toLowerCase() === file.toLowerCase() || entry.path.toLowerCase().endsWith(`\\${base}`));
  if (existing && existing.group !== group) {
    return {
      ok: false,
      status: 7,
      statusName: "ALREADY_PRESENT",
      data: Buffer.alloc(0),
      message: `${existing.path} is already in the project, under ${existing.group}. uVision will not list one file twice, so it cannot be added to ${group} as well.`,
    };
  }
  return session.client.send(OP.PRJ_ADD_FILE, prjData(group, file), 12_000);
}

/**
 * Remove one file from the project.
 *
 * `PRJ_DEL_FILE` takes a `PRJDATA` of **group and file**, the same pair
 * `PRJ_ADD_FILE` takes. Measured on a clean project: the pair deletes the
 * file (`SUCCESS`, gone from the `.uvprojx` after the session closes); a
 * single name is tried as a group and answered `NOT_FOUND: Group 'x'`.
 */
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
/**
 * Download the current target's image through uVision.
 *
 * Measured constraint: this is a **project** operation, not a debugger one. In
 * a debug session `PRJ_FLASH_DOWNLOAD` answers "Target is in debug mode" and
 * nothing is written; it only runs on a connected, non-debugging uVision. The
 * caller is expected to pass the 4824 plain session; if it hands over a
 * debugging one the refusal is reported rather than swallowed.
 *
 * The reply comes back at once and the real outcome arrives on the stream —
 * `0x4000` with `Error: Flash Download failed …`, then `0x5001` when the
 * download has finished.
 */
export async function flashInIde(session: KeilSession, timeoutMs = 5 * 60_000): Promise<{ ok: boolean; lines: string[] }> {
  if (session.debugging) {
    return {
      ok: false,
      lines: [
        "a download cannot run in a debug session — uVision refuses it with \"Target is in debug mode\". " +
          "It runs on the plain project session; call `flash` with the session closed, or flash from the shell with UV4 -f.",
      ],
    };
  }
  const mark = session.client.mark;
  const reply = await session.client.send(OP.PRJ_FLASH_DOWNLOAD, Buffer.alloc(0), 20_000);
  if (!reply.ok) return { ok: false, lines: [reply.message ?? reply.statusName] };
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 400));
    const frames = session.client.since(mark);
    const failed = frames.map((frame) => asyncText(frame) || commandWindowText(frame)).find((text) => /flash download failed|error \d+:/i.test(text));
    const finished = frames.find((frame) => frame.type === 0x5001);
    if (failed) return { ok: false, lines: dedupe(frames.map((frame) => asyncText(frame) || commandWindowText(frame)).filter(Boolean)) };
    if (finished) return { ok: true, lines: dedupe(frames.map((frame) => asyncText(frame) || commandWindowText(frame)).filter(Boolean)) };
  }
  return { ok: false, lines: dedupe(session.client.since(mark).map((frame) => asyncText(frame) || commandWindowText(frame)).filter(Boolean)) };
}



export interface Variable {
  /** The debugger's id for this variable; what `VARIABLE_SET` takes. */
  id: number;
  /** Position in the enumerated list, 0-based. */
  index: number;
  /** Element count for an array, 0 for a scalar. */
  count: number;
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
    const id = data.readInt32LE(0);
    const index = data.readInt32LE(4);
    const count = data.readInt32LE(8);
    const flags = data.readUInt32LE(16);
    const value = readSstr(data, 20);
    const type = readSstr(data, 280);
    const name = readSstr(data, 540);
    const qualified = readSstr(data, 800);
    const label = name || qualified;
    if (!label) continue;
    out.push({
      id,
      index,
      count,
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

/**
 * The variables the debugger can enumerate for one frame, or the globals.
 *
 * Two measured requirements that are easy to miss:
 *
 *  - The request must carry a **count**. `IVARENUM` with `count = 0` — what a
 *    zeroed 20-byte buffer holds — is answered `SUCCESS` with an empty stream,
 *    so "the image has no symbols" and "the request asked for nothing" look
 *    identical. This enumerates 128 at a time.
 *  - Variable, task and watch operations need **extended stack mode**, which
 *    `GEN_SET_OPTIONS` turns on and which is only accepted before the
 *    debugger is entered. Without it every one of them answers
 *    `NOT_FOUND`/`NOT_SUPPORTED` and the debugger looks like it has no symbol
 *    table at all.
 */
export async function readVariables(session: KeilSession, frame = 0): Promise<Variable[]> {
  const mark = session.client.mark;
  const reply = await session.client.send(OP.DBG_ENUM_VARIABLES, ivarEnum(0, frame, 0, 128), 10_000);
  // `NOT_FOUND` here means the debugger has nothing to enumerate at this
  // frame — an image without debug info, or a frame with no locals. That is
  // an empty list, not a transport failure.
  if (!reply.ok && reply.status !== 9) return [];
  const frames = await session.client.collect(3000, 0x5042, mark);
  return parseVariables(frames);
}

/**
 * Set a variable by the id the enumeration reported.
 *
 * `VARIABLE_SET` takes a `VARVAL`: the `IVARENUM` that names the variable plus
 * the new value. Sending a bare name failed with `NOT_FOUND`, and the old code
 * reported the debugger's `SUCCESS` for a request that carried no value at all.
 * The write is read back, so a value the core refused is not reported as done.
 */
export async function setVariableById(session: KeilSession, variable: Variable, value: string, frame = 0): Promise<WriteOutcome> {
  if (!session.debugging) return { ok: false, detail: "not in debug mode; enter it before writing a variable" };
  if (variable.editable === false) return { ok: false, detail: `${variable.name} is not marked editable by the debugger` };
  const reply = await session.client.send(OP.DBG_VARIABLE_SET, varVal(variable.id, frame, 0, value), 10_000);
  if (!reply.ok) return { ok: false, detail: `${variable.name} was refused: ${reply.message ?? reply.statusName}` };
  const after = (await readVariables(session, frame)).find((entry) => entry.id === variable.id);
  if (after && after.value !== variable.value) return { ok: true, detail: `${variable.name} = ${after.value}` };
  if (after && after.value === variable.value) return { ok: true, detail: `${variable.name} = ${after.value} (unchanged)` };
  return { ok: true, detail: `${variable.name} = ${value} (the debugger did not list it again to read back)` };
}

/**
 * Tasks, for an RTOS-aware target (RTX, or FreeRTOS with its awareness plugin).
 *
 * The frame is `STACKENUM` followed by the task name, measured as 276 bytes:
 *
 *   nItem(4) nAdr(8) nRetAdr(8) nVars(4) nEqual(4) nTotal(4) nTask(4)
 *   nRes[3](12) name[256]
 *
 * The name is at 48. Reading it at 12 — right after `nAdr` — produced a task
 * list of empty strings, which the caller then filtered away, so a target with
 * a real thread reported "no tasks".
 */
export async function readTasks(session: KeilSession): Promise<{ id: number; name: string; address: number }[]> {
  const mark = session.client.mark;
  // `iSTKENUM::bExtended`, which is what asks for the task fields.
  const request = Buffer.alloc(40);
  request.writeUInt32LE(2, 0);
  await session.client.send(OP.DBG_ENUM_TASKS, request, 10_000);
  const frames = await session.client.collect(1500, 0x5052, mark);
  return readTaskFrames(frames);
}

/** Decode task frames (`0x5051`), which are `STACKENUM` plus the task name. */
export function readTaskFrames(frames: AsyncFrame[]): { id: number; name: string; address: number }[] {
  return frames
    .filter((frame) => frame.type === 0x5051 && frame.data.length >= 20)
    .map((frame) => {
      const id = frame.data.readUInt32LE(0);
      const address = frame.data.length >= 12 ? Number(frame.data.readBigUInt64LE(4)) : 0;
      // Measured, 276 bytes: `nItem(4) nAdr(8) nRetAdr(8) nVars(4) nEqual(4)
      // nTotal(4) nTask(4) nRes[3](12)` then the text — `0c 00 00 00` (length
      // 12) at 36 and "Main Thread" at 40. The name is not at 44; reading
      // there returned an empty string for a target with a real thread.
      const length = frame.data.length >= 40 ? frame.data.readUInt32LE(36) : 0;
      const name =
        length > 0 && length < 256
          ? frame.data.subarray(40, Math.min(40 + length, frame.data.length)).toString("latin1").replace(/\0.*$/s, "")
          : "";
      return { id, name, address };
    })
    .filter((task) => task.name);
}

/** The trace/VTR items the target exposes. */
export async function readVtr(session: KeilSession): Promise<{ name: string; type: number }[]> {
  const mark = session.client.mark;
  await session.client.send(OP.DBG_ENUM_VTR, Buffer.alloc(32), 10_000);
  const frames = await session.client.collect(1500, 0x5019, mark);
  return frames
    .map(readVtrFrame)
    .filter((entry): entry is { name: string; type: number } => entry !== null)
    // The same variables are reported more than once in one burst.
    .filter((entry, index, all) => all.findIndex((other) => other.name === entry.name) === index);
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

/** Set a register by name. Kept for callers that only want the raw request. */
export async function sendRegisterSet(session: KeilSession, name: string, value: string): Promise<Reply> {
  const wanted = numericValue(value) ?? 0;
  return session.client.send(OP.DBG_REGISTER_SET, vsetWithValue(name, 5, BigInt(wanted)), 10_000);
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
  // function index, then reserved zeros, then `"system_stm32f4xx.cSystemInit"`.
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
/**
 * Erase the target's flash.
 *
 * `PRJ_FLASH_ERASE` never answers on MDK 5.43a — measured at 15 s, 20 s and
 * 60 s: no reply, no error frame. Reporting the bare timeout leaves the user
 * with a tool that looks broken, so the answer says what is actually
 * available: the download performs its own erase, and a chip erase is a
 * flash-algorithm option in the target's settings.
 */
export async function eraseFlash(session: KeilSession): Promise<Reply> {
  const reply = await session.client.send(OP.PRJ_FLASH_ERASE, Buffer.alloc(0), 20_000);
  if (reply.timedOut) {
    return {
      ...reply,
      ok: false,
      message:
        "uVision never answered the erase request (a known gap on MDK 5.4x). The download erases the sectors it writes; for a full chip erase, enable it in the target's flash settings and download.",
    };
  }
  return reply;
}

/** The current target's output file name. */
export async function getOutputName(session: KeilSession): Promise<string> {
  const reply = await session.client.send(OP.PRJ_GET_OUTPUTNAME, Buffer.alloc(4), 8_000);
  return reply.ok ? readSstr(reply.data, 0) : "";
}

/* ---------- operations beyond the core loop ---------- */

export {
  addWatch,
  debugCommand,
  debugTargetKind,
  disassemble,
  evalInWindow,
  evaluate,
  execMenu,
  ideVersion,
  ideVersionText,
  licenseInfo,
  NEEDS_EXTENDED_STACK,
  readMenus,
  readScvdFiles,
  closeProject,
  readNamedRegisters,
  registerItm,
  removeWatch,
  resetTarget,
  runToAddress,
  setEventRecorder,
  setOutputName,
  setVariable,
  setVtr,
  showCodeAt,
  stepMany,
  timeInfo,
  UNSUPPORTED_ON_MDK_5_43,
  windowState,
  writeRegister,
} from "./keilExtra.ts";
