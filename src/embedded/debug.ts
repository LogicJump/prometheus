/**
 * Debugging through GDB's machine interface.
 *
 * Every debug probe in the ecosystem speaks GDB remote protocol, and every
 * toolchain ships a GDB that speaks MI back. So this is the one adapter that
 * works across OpenOCD, pyOCD, probe-rs and J-Link: start the probe's GDB
 * server, point `arm-none-eabi-gdb -i=mi2` at it, and drive it with MI.
 *
 * Why MI and not plain GDB commands: plain GDB prints for a human. `print x`
 * gives `$1 = 42` and `bt` gives a formatted stack, both of which have to be
 * re-parsed and both of which change with the user's settings. MI gives
 * `^done,value="42"` and a structured frame list, which is what the model
 * needs.
 *
 * MI is line-oriented. A command produces zero or more `*` (async exec),
 * `+` (status), `=` (notify) and `~`/`@`/`&` (stream) records, then exactly
 * one `^done` or `^error` with the same token it was sent with. Everything
 * here keys on that token so a lost reply cannot be mistaken for the next
 * command's.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { toolEnv } from "./toolEnv.ts";

export interface MiRecord {
  kind: "result" | "exec" | "status" | "notify" | "stream" | "console" | "log" | "target";
  /** The token the record replies to, when it is a result record. */
  token?: number;
  /** The MI command class: `done`, `error`, `running`, `stopped`, ... */
  class?: string;
  /** Raw payload after the class. */
  body: string;
}

/**
 * Parse one MI line.
 *
 * The format is `[token]<char><class>[,<results>]`. Results are
 * comma-separated `name=value` where a value may be a C string, a tuple
 * `{...}` or a list `[...]`, and both nest — so the body is kept raw and
 * parsed by `miFields` where it is needed, rather than by a full grammar here.
 */
export function parseMiLine(line: string): MiRecord | null {
  const trimmed = line.replace(/\r$/, "");
  if (!trimmed) return null;
  // A stream record is `~"text"` — no class, and the payload is the C string.
  // Results and exec records are `^class[,fields]` / `*class[,fields]`.
  const match = /^(\d*)([\^*+=~@&])([a-z-]*)(.*)$/.exec(trimmed);
  if (!match) return null;
  const [, token, marker, cls, remainder = ""] = match;
  const body = remainder.startsWith(",") ? remainder.slice(1) : remainder;
  const kind: MiRecord["kind"] =
    marker === "^" ? "result" : marker === "*" ? "exec" : marker === "+" ? "status" : marker === "=" ? "notify" : marker === "~" ? "stream" : marker === "@" ? "target" : "log";
  return {
    kind,
    ...(token ? { token: Number(token) } : {}),
    ...(cls ? { class: cls } : {}),
    body,
  };
}

/**
 * Pull `name="value"` pairs out of an MI result body.
 *
 * Values may be C strings with escapes, braces or brackets. Nested structures
 * are returned as their raw text: the callers here want flat fields
 * (`frame={level="0",func="main",file="main.c",line="7"}` → level, func, ...),
 * and their children are parsed by calling this again on the raw text.
 */
export function miFields(body: string): Record<string, string> {
  const fields: Record<string, string> = {};
  let index = 0;
  while (index < body.length) {
    // name= at the current position
    const nameMatch = /^([A-Za-z_][\w-]*)=/.exec(body.slice(index));
    if (!nameMatch) {
      index++;
      continue;
    }
    const name = nameMatch[1];
    index += nameMatch[0].length;

    if (body[index] === '"') {
      // C string: honour the escapes GDB emits.
      let value = "";
      index++;
      while (index < body.length && body[index] !== '"') {
        if (body[index] === "\\" && index + 1 < body.length) {
          const next = body[index + 1];
          index += 2;
          if (next === "n") value += "\n";
          else if (next === "t") value += "\t";
          else if (next === "r") value += "\r";
          else if (next === '"') value += '"';
          else if (next === "\\") value += "\\";
          else value += next;
          continue;
        }
        value += body[index++];
      }
      index++; // closing quote
      fields[name] = value;
    } else if (body[index] === "{" || body[index] === "[") {
      // Nested tuple or list: take the balanced span.
      const open = body[index];
      const close = open === "{" ? "}" : "]";
      let depth = 0;
      const start = index;
      let quoted = false;
      while (index < body.length) {
        const ch = body[index];
        if (quoted) {
          if (ch === "\\") index++;
          else if (ch === '"') quoted = false;
        } else if (ch === '"') quoted = true;
        else if (ch === open) depth++;
        else if (ch === close) {
          depth--;
          if (depth === 0) {
            index++;
            break;
          }
        }
        index++;
      }
      fields[name] = body.slice(start, index);
    } else {
      // bare word
      const bare = /^[^,}]+/.exec(body.slice(index));
      if (bare) {
        fields[name] = bare[0];
        index += bare[0].length;
      }
    }
    if (body[index] === ",") index++;
  }
  return fields;
}

/** Split a GDB MI list body (`[{a="1"},{a="2"}]`) into its element texts. */
export function miList(body: string): string[] {
  const trimmed = body.trim();
  if (!trimmed.startsWith("[")) return [];
  const inner = trimmed.slice(1, trimmed.endsWith("]") ? -1 : undefined);
  const out: string[] = [];
  let index = 0;
  let quoted = false;
  let depth = 0;
  let start = 0;
  while (index < inner.length) {
    const ch = inner[index];
    if (quoted) {
      if (ch === "\\") index++;
      else if (ch === '"') quoted = false;
    } else if (ch === '"') quoted = true;
    else if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") depth--;
    else if (ch === "," && depth === 0) {
      out.push(inner.slice(start, index));
      start = index + 1;
    }
    index++;
  }
  if (start < inner.length) out.push(inner.slice(start));
  return out.filter((item) => item.trim());
}

// ---- the session -----------------------------------------------------------

export interface MiSessionOptions {
  gdb: string;
  /** The ELF to load symbols from. */
  elf: string;
  /** The GDB server endpoint, e.g. `localhost:3333`. */
  remote: string;
  /** Called for every `*stopped`, `=breakpoint-modified`, and console record. */
  onEvent?: (record: MiRecord) => void;
  timeoutMs?: number;
}

export interface MiResult {
  ok: boolean;
  class?: string;
  body: string;
  /** Console/stream output produced while the command ran. */
  console: string;
}

/**
 * A live GDB/MI session.
 *
 * One process per debug session, not per command: connecting to a target is
 * slow and halts the CPU, so the session connects once and issue commands
 * against it. `close()` kills the process, which also releases the port the
 * probe's GDB server is holding open.
 */
export class MiSession {
  private child: ChildProcessWithoutNullStreams;
  private nextToken = 1;
  private pending = new Map<number, { resolve: (result: MiResult) => void; console: string[]; timer: NodeJS.Timeout }>();
  private buffer = "";
  private closed = false;
  private readonly timeoutMs: number;
  private readonly onEvent?: (record: MiRecord) => void;
  private readonly remote: string;
  private readonly elfPath: string;

  constructor(options: MiSessionOptions) {
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.onEvent = options.onEvent;
    this.remote = options.remote;
    this.elfPath = options.elf;
    this.child = spawn(options.gdb, ["-q", "-i=mi2", "--interpreter=mi2", options.elf], {
      env: toolEnv(),
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.consume(chunk));
    this.child.on("exit", () => {
      this.closed = true;
      // Every in-flight command fails, rather than hanging to its timeout.
      for (const [token, entry] of this.pending) {
        clearTimeout(entry.timer);
        entry.resolve({ ok: false, class: "error", body: "gdb exited", console: entry.console.join("") });
        this.pending.delete(token);
      }
    });
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    let index = this.buffer.indexOf("\n");
    while (index >= 0) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      this.dispatch(line);
      index = this.buffer.indexOf("\n");
    }
  }

  private dispatch(line: string): void {
    const record = parseMiLine(line);
    if (!record) return;

    if (record.kind === "result" && record.token !== undefined) {
      const entry = this.pending.get(record.token);
      if (entry) {
        this.pending.delete(record.token);
        clearTimeout(entry.timer);
        entry.resolve({
          ok: record.class === "done" || record.class === "connected" || record.class === "running",
          ...(record.class ? { class: record.class } : {}),
          body: record.body,
          console: entry.console.join("\n"),
        });
        return;
      }
    }

    // Console and log records belong to whatever command is running.
    if (record.kind === "console" || record.kind === "log" || record.kind === "stream") {
      const target = [...this.pending.values()].pop();
      if (target && record.body) target.console.push(stripCString(record.body));
      return;
    }
    this.onEvent?.(record);
  }

  /** Send one MI command and wait for its result record. */
  send(command: string, timeoutMs = this.timeoutMs): Promise<MiResult> {
    if (this.closed) return Promise.resolve({ ok: false, class: "error", body: "gdb exited", console: "" });
    const token = this.nextToken++;
    const console: string[] = [];
    return new Promise<MiResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(token);
        resolve({ ok: false, class: "error", body: `timed out after ${timeoutMs}ms`, console: console.join("\n") });
      }, timeoutMs);
      this.pending.set(token, { resolve, console, timer });
      this.child.stdin.write(`${token}${command}\n`);
    });
  }

  /** Attach to the remote target and load the symbol file. */
  async connect(): Promise<MiResult> {
    const result = await this.send(`-target-select remote ${this.remote}`);
    if (!result.ok) return result;
    // Symbols are already loaded by the constructor's file argument; this asks
    // GDB to read them from the program header at the remote's addresses.
    await this.send("-file-list-exec-source-files");
    return result;
  }

  /** Open a local process instead of a remote target; used by the tests and by
   *  debug-in-emulator flows where the firmware runs as a host binary. */
  async connectLocal(): Promise<MiResult> {
    return this.send("-file-exec-and-symbols " + JSON.stringify(this.elfPath));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    try {
      // Detach so the target is left running rather than halted, then quit.
      await this.send("-target-disconnect", 3000);
    } catch {
      /* already gone */
    }
    this.closed = true;
    try {
      this.child.kill();
    } catch {
      /* already exited */
    }
  }
}

function stripCString(body: string): string {
  const match = /^"(.*)"$/s.exec(body);
  if (!match) return body;
  return match[1].replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}

// ---- high-level operations -------------------------------------------------

export interface StackFrame {
  level: number;
  func?: string;
  file?: string;
  line?: number;
  address?: string;
}

/**
 * `-stack-list-frames` returns
 * `stack=[frame={level="0",addr="0x08000abc",func="main",file="main.c",line="7"},...]`.
 * The frames are what the model reads first when a target halts, so a parse
 * failure here is worth a fallback rather than an exception.
 */
/**
 * Unwrap one MI tuple element.
 *
 * A list element is either a bare tuple `{level="0",...}` or a named one
 * `frame={level="0",...}` — GDB uses the latter for `stack` and the former for
 * `variables`. Taking the name off is the difference between a parsed frame
 * and a frame whose only field is called "frame".
 */
function tupleFields(item: string): Record<string, string> {
  const text = item.trim().replace(/^[A-Za-z_][\w-]*=/, "");
  const inner = text.startsWith("{") && text.endsWith("}") ? text.slice(1, -1) : text;
  return miFields(inner);
}

export function parseStackFrames(body: string): StackFrame[] {
  // Take the list through miFields rather than a regex: the list contains
  // nested tuples, and a greedy `\[(.*)\]` would swallow the inner brackets.
  const stack = miFields(body).stack;
  if (!stack) return [];
  const frames: StackFrame[] = [];
  for (const item of miList(stack)) {
    const fields = tupleFields(item);
    if (!fields.level) continue;
    frames.push({
      level: Number(fields.level),
      ...(fields.func ? { func: fields.func } : {}),
      ...(fields.file ? { file: fields.file } : {}),
      ...(fields.line ? { line: Number(fields.line) } : {}),
      ...(fields.addr ? { address: fields.addr } : {}),
    });
  }
  return frames;
}

export interface Variable {
  name: string;
  value: string;
}

/** `-stack-list-variables --simple-values` → `variables=[{name="i",value="0"}]`. */
export function parseVariables(body: string): Variable[] {
  const list = miFields(body).variables;
  if (!list) return [];
  const out: Variable[] = [];
  for (const item of miList(list)) {
    const fields = tupleFields(item);
    if (fields.name) out.push({ name: fields.name, value: fields.value ?? "" });
  }
  return out;
}

/**
 * The stopping reason from a `*stopped` record:
 * `*stopped,reason="breakpoint-hit",bkptno="1",frame={...}`.
 */
export function parseStopReason(body: string): { reason: string; frame?: StackFrame } {
  const fields = miFields(body);
  const frameRaw = fields.frame;
  let frame: StackFrame | undefined;
  if (frameRaw) {
    const inner = tupleFields(frameRaw);
    // A `*stopped` frame often omits `level` — the top frame is level 0.
    if (inner.func || inner.file || inner.addr) {
      frame = {
        level: inner.level ? Number(inner.level) : 0,
        ...(inner.func ? { func: inner.func } : {}),
        ...(inner.file ? { file: inner.file } : {}),
        ...(inner.line ? { line: Number(inner.line) } : {}),
        ...(inner.addr ? { address: inner.addr } : {}),
      };
    }
  }
  return { reason: fields.reason ?? "unknown", ...(frame ? { frame } : {}) };
}

/**
 * The GDB server each flasher family starts, and the port it listens on.
 *
 * OpenOCD defaults to 3333, pyOCD to 3333 as well, probe-rs to 1337. J-Link's
 * GDB server uses 2331. Getting this wrong is a silent hang, so it is data.
 */
export const SERVER_PORTS: Record<string, number> = {
  openocd: 3333,
  pyocd: 3333,
  "probe-rs": 1337,
  jlink: 2331,
};

/** Default executable names, used when the toolchain reported a directory only. */
export const SERVER_PROGRAMS: Record<"openocd" | "pyocd" | "probe-rs" | "jlink", string[]> = {
  openocd: ["openocd"],
  pyocd: ["pyocd"],
  "probe-rs": ["probe-rs"],
  // The debug server is a different binary from the flasher (JLinkExe); the
  // toolchain probe used to look only for JLinkExe and hand its path here.
  jlink: ["JLinkGDBServerCL", "JLinkGDBServerCL.exe", "JLinkGDBServer", "JLinkGDBServer.exe"],
};

/**
 * OpenOCD config files implied by a chip name.
 *
 * Users should not have to know that `stm32f407` needs
 * `target/stm32f4x.cfg`. The mapping is by family prefix — an architecture
 * fact OpenOCD already encodes in its file names — not a chip allowlist, so an
 * older or newer part of the same family resolves the same way.
 */
export function openocdConfigsFor(target: string | undefined): { interfaceConfig?: string; targetConfig?: string } {
  const lower = String(target ?? "").toLowerCase();
  if (!lower) return {};
  const families: [RegExp, string][] = [
    [/^stm32f0/, "target/stm32f0x.cfg"],
    [/^stm32f1/, "target/stm32f1x.cfg"],
    [/^stm32f2/, "target/stm32f2x.cfg"],
    [/^stm32f3/, "target/stm32f3x.cfg"],
    [/^stm32f4/, "target/stm32f4x.cfg"],
    [/^stm32f7/, "target/stm32f7x.cfg"],
    [/^stm32h7/, "target/stm32h7x.cfg"],
    [/^stm32g0/, "target/stm32g0x.cfg"],
    [/^stm32g4/, "target/stm32g4x.cfg"],
    [/^stm32l0/, "target/stm32l0.cfg"],
    [/^stm32l1/, "target/stm32l1.cfg"],
    [/^stm32l4/, "target/stm32l4x.cfg"],
    [/^stm32l5/, "target/stm32l5x.cfg"],
    [/^stm32u5/, "target/stm32u5x.cfg"],
    [/^stm32wb/, "target/stm32wbx.cfg"],
    [/^stm32wl/, "target/stm32wlx.cfg"],
    [/^nrf51/, "target/nrf51.cfg"],
    [/^nrf52/, "target/nrf52.cfg"],
    [/^nrf53/, "target/nrf53.cfg"],
    [/^nrf91/, "target/nrf91.cfg"],
    [/^rp2040|^rp2350/, "target/rp2040.cfg"],
    [/^samd2/, "target/at91samdXX.cfg"],
    [/^same7/, "target/atsame70.cfg"],
    [/^lpc17/, "target/lpc17xx.cfg"],
    [/^lpc40/, "target/lpc40xx.cfg"],
    [/^kinetis|^mk[0-9]/, "target/kx.cfg"],
    [/^esp32s3/, "target/esp32s3.cfg"],
    [/^esp32c3/, "target/esp32c3.cfg"],
    [/^esp32/, "target/esp32.cfg"],
  ];
  for (const [pattern, file] of families) {
    if (pattern.test(lower)) return { targetConfig: file };
  }
  return {};
}

export interface ServerCommand {
  program: string;
  args: string[];
  /** Wait for this line on stdout before connecting GDB. */
  readyPattern: RegExp;
  port: number;
}

/**
 * The command that starts a GDB server for a probe, or null when the tool
 * cannot serve one from a bare invocation.
 */
export function serverCommand(
  kind: "openocd" | "pyocd" | "probe-rs" | "jlink",
  program: string,
  options: { target?: string; elf?: string; interfaceConfig?: string; targetConfig?: string; probe?: string } = {},
): ServerCommand | null {
  switch (kind) {
    case "openocd": {
      // A target config can be derived from the chip name; without one the
      // server cannot be started at all, so the derivation is what makes
      // "just tell me the chip" work.
      if (!options.targetConfig) return null;
      const args: string[] = [];
      if (options.interfaceConfig) args.push("-f", options.interfaceConfig);
      args.push("-f", options.targetConfig);
      return { program, args, readyPattern: /Listening on port 3333 for gdb connections/i, port: 3333 };
    }
    case "pyocd": {
      if (!options.target) return null;
      const args = ["gdbserver", "--target", options.target, "--port", "3333"];
      if (options.probe) args.push("--uid", options.probe);
      return { program, args, readyPattern: /GDB server listening|Waiting for gdb connection/i, port: 3333 };
    }
    case "probe-rs": {
      if (!options.target) return null;
      const args = ["gdb", "--chip", options.target, "--port", "1337"];
      if (options.elf) args.push(options.elf);
      return { program, args, readyPattern: /Waiting for a GDB connection|listening on/i, port: 1337 };
    }
    case "jlink": {
      if (!options.target) return null;
      const args = ["-device", options.target, "-if", "SWD", "-speed", "4000", "-port", "2331", "-singlerun", "-NoGui", "1"];
      // Several probes on one machine need the server told which one; the
      // flash path already selected by serial, the debug path silently used
      // whichever answered first.
      if (options.probe) args.push("-SelectEmuBySN", options.probe);
      if (options.elf) args.push("-elf", options.elf);
      return { program, args, readyPattern: /Waiting for GDB connection|Listening/i, port: 2331 };
    }
    default:
      return null;
  }
}
