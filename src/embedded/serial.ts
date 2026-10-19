/**
 * Reading what the board says.
 *
 * A serial console is the only feedback channel every embedded target has, and
 * every ecosystem prints something different: Zephyr's `[00:00:01.234,567]
 * <inf> main: message`, ESP-IDF's `I (1234) TAG: message`, plain `printf`, and
 * FreeRTOS's own conventions. An agent that has to re-read raw bytes spends
 * its context on escape codes and boot banners.
 *
 * This module does two things and nothing else:
 *
 *   1. Opens a serial port for a bounded time and returns what arrived —
 *      either N seconds of it, or up to a pattern.
 *   2. Parses the common embedded log formats into one shape with timestamps,
 *      levels and tags, so the agent can filter to errors.
 *
 * Port enumeration is separate, because "which port" is a question the user
 * answers once and the agent reads afterwards.
 */

import { execFile, spawn, spawnSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { existsSync, readdirSync } from "node:fs";

export interface SerialPortInfo {
  /** The name to open: `COM7`, `/dev/ttyACM0`, `/dev/cu.usbmodem1234`. */
  path: string;
  /** USB description when the OS reports one. */
  description?: string;
  /** USB vendor id, lowercase hex, e.g. `0483` for STMicroelectronics. */
  vid?: string;
  /** USB product id. */
  pid?: string;
  /** Best guess at what board this is, from the VID/PID or the description. */
  board?: string;
}

/**
 * Known USB ids. This is not exhaustive and does not need to be — it exists so
 * that when a machine has three ports the agent can pick the one attached to
 * an ST-Link rather than the one attached to a Bluetooth dongle.
 */
const USB_IDS: { vid: string; pid?: string; name: string }[] = [
  { vid: "0483", name: "STMicroelectronics (ST-Link)" },
  { vid: "1366", name: "SEGGER (J-Link)" },
  { vid: "0d28", pid: "0204", name: "ARM mbed / DAPLink" },
  { vid: "1915", name: "Nordic Semiconductor" },
  { vid: "239a", name: "Adafruit" },
  { vid: "2341", name: "Arduino" },
  { vid: "2e8a", name: "Raspberry Pi" },
  { vid: "303a", name: "Espressif" },
  { vid: "1a86", name: "WCH (CH340/CH9102)" },
  { vid: "10c4", name: "Silicon Labs (CP210x)" },
  { vid: "0403", name: "FTDI" },
  { vid: "1b4f", name: "SparkFun" },
  { vid: "1209", name: "pid.codes (open hardware)" },
];

function boardFor(vid?: string, pid?: string, description?: string): string | undefined {
  if (vid) {
    const byVidPid = USB_IDS.find((entry) => entry.vid === vid.toLowerCase() && entry.pid === pid?.toLowerCase());
    if (byVidPid) return byVidPid.name;
    const byVid = USB_IDS.find((entry) => entry.vid === vid.toLowerCase() && !entry.pid);
    if (byVid) return byVid.name;
  }
  const text = description ?? "";
  if (/STLink|ST-Link/i.test(text)) return "STMicroelectronics (ST-Link)";
  if (/J-Link/i.test(text)) return "SEGGER (J-Link)";
  if (/CP210/i.test(text)) return "Silicon Labs (CP210x)";
  if (/CH340|CH910/i.test(text)) return "WCH (CH340/CH9102)";
  if (/FTDI/i.test(text)) return "FTDI";
  return undefined;
}

function run(program: string, args: string[], timeout = 10000): Promise<string> {
  return new Promise((resolve) => {
    execFile(program, args, { timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      resolve(error && !stdout ? "" : String(stdout ?? ""));
    });
  });
}

/**
 * Enumerate serial ports.
 *
 * There is no cross-platform port list in Node, and adding a native module to
 * a zero-dependency project is not worth it. Each OS has a cheap answer:
 *
 *   Windows  PowerShell `Get-CimInstance Win32_SerialPort` gives name + VID/PID.
 *   Linux    `/dev/serial/by-id` names carry the description; `ttyUSB*`/`ttyACM*` otherwise.
 *   macOS    `/dev/cu.*` with `ioreg` for the description.
 *
 * A machine where the command fails returns an empty list, not an error: the
 * user may simply have no ports, and that is a normal state.
 */
export async function listSerialPorts(): Promise<SerialPortInfo[]> {
  if (process.platform === "win32") return windowsPorts();
  if (process.platform === "darwin") return macPorts();
  return linuxPorts();
}

async function windowsPorts(): Promise<SerialPortInfo[]> {
  // `Get-CimInstance` is present on every supported Windows; `Get-WmiObject`
  // is the fallback for images that stripped the newer module. Both only list
  // devices that expose a PnP entity, so a motherboard COM1 is invisible to
  // them — the SERIALCOMM registry key is the only place that records every
  // port the kernel has registered.
  const script =
    "$a=@(); " +
    "try { $a += Get-CimInstance Win32_PnPEntity -Filter \"Name LIKE 'COM%'\" | " +
    "Select-Object Name,DeviceID } catch { }; " +
    "try { $k=Get-ItemProperty 'HKLM:\\HARDWARE\\DEVICEMAP\\SERIALCOMM'; " +
    "$k.PSObject.Properties | Where-Object { $_.Name -notlike 'PS*' } | " +
    "ForEach-Object { $a += [pscustomobject]@{ Name=$_.Value; DeviceID=$_.Name } } } catch { }; " +
    "$a | ConvertTo-Json -Compress";
  const raw = await run("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], 15000);
  if (!raw.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const items = Array.isArray(parsed) ? parsed : [parsed];
  const byPath = new Map<string, SerialPortInfo>();
  for (const item of items as { Name?: string; DeviceID?: string }[]) {
    const name = item.Name ?? "";
    // PnP entity: `USB Serial Device (COM7)`; registry: Name is `COM1`.
    const port = /\((COM\d+)\)/i.exec(name)?.[1] ?? /^(COM\d+)$/i.exec(name)?.[1];
    if (!port) continue;
    const key = port.toUpperCase();
    const ids = /VID_([0-9A-F]{4})&PID_([0-9A-F]{4})/i.exec(item.DeviceID ?? "");
    const description = name.replace(/\s*\(COM\d+\)\s*$/i, "").trim();
    const board = boardFor(ids?.[1], ids?.[2], description);
    const existing = byPath.get(key);
    byPath.set(key, {
      path: key,
      // The registry entry has no description; prefer whichever source has one.
      ...((existing?.description ?? description) ? { description: existing?.description ?? description } : {}),
      ...(ids ? { vid: ids[1].toLowerCase(), pid: ids[2].toLowerCase() } : existing?.vid ? { vid: existing.vid, pid: existing.pid } : {}),
      ...(board ?? existing?.board ? { board: board ?? existing?.board } : {}),
    });
  }
  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}

function linuxPorts(): SerialPortInfo[] {
  const ports: SerialPortInfo[] = [];
  const byId = "/dev/serial/by-id";
  if (existsSync(byId)) {
    try {
      for (const entry of readdirSync(byId)) {
        ports.push({ path: `/dev/serial/by-id/${entry}`, description: entry });
      }
    } catch {
      /* permission denied on by-id is not fatal */
    }
  }
  if (ports.length === 0 && existsSync("/dev")) {
    try {
      for (const entry of readdirSync("/dev")) {
        if (/^tty(USB|ACM)\d+$/.test(entry)) ports.push({ path: `/dev/${entry}` });
      }
    } catch {
      /* no /dev listing */
    }
  }
  return ports;
}

async function macPorts(): Promise<SerialPortInfo[]> {
  if (!existsSync("/dev")) return [];
  const ports: SerialPortInfo[] = [];
  try {
    for (const entry of readdirSync("/dev")) {
      if (/^cu\.(usb|wchusb|SLAB).+/.test(entry)) ports.push({ path: `/dev/${entry}` });
    }
  } catch {
    return [];
  }
  return ports;
}

// ---- log parsing -----------------------------------------------------------

export type LogLevel = "error" | "warn" | "info" | "debug" | "trace";

export interface LogLine {
  /** Milliseconds since the capture began, when the device printed a timestamp. */
  t?: number;
  level?: LogLevel;
  /** Module or tag, when the format has one. */
  tag?: string;
  text: string;
  /** The line as received, kept so nothing is lost to parsing. */
  raw: string;
}

// Zephyr: `[00:00:01.234,567] <inf> main: message`
const ZEPHYR = /^\[(\d{2}):(\d{2}):(\d{2})\.(\d{3}),(\d{3})\]\s+<(\w+)>\s+(?:([\w.-]+):\s*)?(.*)$/;
// ESP-IDF: `I (1234) TAG: message` — level letter, then milliseconds since boot.
const ESP_IDF = /^([EWIDV])\s+\((\d+)\)\s+([\w.-]+):\s*(.*)$/;
// FreeRTOS+CLI and many RTOS demos: `[1234] TAG: message`
const BRACKET_TIME = /^\[(\d+)\]\s+(?:([\w.-]+):\s*)?(.*)$/;
// A leading syslog-style level: `<3>message`
const SYSLOG = /^<(\d)>(.*)$/;

const ZEPHYR_LEVELS: Record<string, LogLevel> = {
  err: "error",
  wrn: "warn",
  inf: "info",
  dbg: "debug",
};

const ESP_LEVELS: Record<string, LogLevel> = {
  E: "error",
  W: "warn",
  I: "info",
  D: "debug",
  V: "trace",
};

const SYSLOG_LEVELS: LogLevel[] = ["error", "error", "error", "error", "warn", "info", "info", "debug"];

/**
 * Parse one line. Formats are tried in order of specificity; a line that
 * matches nothing is returned as plain text, which is the common case for
 * `printf` debugging.
 */
export function parseLine(raw: string): LogLine {
  const line = raw.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\r$/, "");

  const zephyr = ZEPHYR.exec(line);
  if (zephyr) {
    const ms =
      Number(zephyr[1]) * 3_600_000 +
      Number(zephyr[2]) * 60_000 +
      Number(zephyr[3]) * 1000 +
      Number(zephyr[4]);
    return {
      t: ms,
      level: ZEPHYR_LEVELS[zephyr[6]] ?? "info",
      ...(zephyr[7] ? { tag: zephyr[7] } : {}),
      text: zephyr[8],
      raw: line,
    };
  }

  const idf = ESP_IDF.exec(line);
  if (idf) {
    return {
      t: Number(idf[2]),
      level: ESP_LEVELS[idf[1]] ?? "info",
      tag: idf[3],
      text: idf[4],
      raw: line,
    };
  }

  const bracket = BRACKET_TIME.exec(line);
  if (bracket) {
    return {
      t: Number(bracket[1]),
      ...(bracket[2] ? { tag: bracket[2] } : {}),
      text: bracket[3],
      raw: line,
    };
  }

  const syslog = SYSLOG.exec(line);
  if (syslog) {
    const severity = Number(syslog[1]);
    return { level: SYSLOG_LEVELS[severity] ?? "info", text: syslog[2], raw: line };
  }

  return { text: line, raw: line };
}

export interface CaptureOptions {
  /** How long to listen before giving up, in milliseconds. Default 5000. */
  timeoutMs?: number;
  /** Stop as soon as a received line matches this. */
  until?: RegExp;
  /** Stop after this many lines. */
  maxLines?: number;
  /** Baud rate. Default 115200, which every board's console speaks. */
  baud?: number;
  /**
   * Discard everything up to and including the first line matching this, then
   * start capturing. Useful to skip a boot banner — but the caller decides,
   * because sometimes the banner is the point.
   */
  skipUntil?: RegExp;
  /**
   * Assert DTR when opening. On most dev boards DTR is wired to RESET, so this
   * reboots the target — useful to catch a boot banner, harmful when you are
   * waiting for a message the running firmware will print. Default false.
   */
  assertDtr?: boolean;
}

export interface CaptureResult {
  lines: LogLine[];
  /** The line that satisfied `until`, when one did. */
  matched?: LogLine;
  timedOut: boolean;
  /** Bytes discarded because they were not valid UTF-8 text. */
  errors: string[];
}

/**
 * Open a real port.
 *
 * The project has no runtime dependencies, and a native serial binding would
 * be the largest one in it. Each OS already has a working implementation:
 *
 *   Windows  .NET's `System.IO.Ports.SerialPort` through PowerShell, which
 *            also gives us DTR/RTS control — the thing that resets an ESP32 or
 *            an Arduino on connect.
 *   POSIX    `stty` to configure the line, then a plain file read stream.
 *
 * Both are separate processes. That is deliberate: a wedged driver cannot take
 * the agent down with it, and killing the child closes the port.
 */

/**
 * Ports this process has open. Two readers on one port is not a thing the OS
 * allows, and without this check the second one fails with a native access
 * error that says nothing about who is holding it. The serial monitor and the
 * `embed_serial` tool share a process, so they are the usual pair in conflict.
 */
const activePorts = new Set<string>();

export function openPort(path: string, baud: number, options: { assertDtr?: boolean } = {}): PortHandle {
  const key = portKey(path);
  if (activePorts.has(key)) throw new Error(`${path} is already open in this process`);
  const assertDtr = options.assertDtr ?? false;
  const inner = process.platform === "win32" ? openWindowsPort(path, baud, assertDtr) : openPosixPort(path, baud);
  activePorts.add(key);
  return {
    onData: (listener) => inner.onData(listener),
    onExit: (listener) => inner.onExit?.(listener),
    close() {
      activePorts.delete(key);
      inner.close();
    },
  };
}

/**
 * Windows keys are case-insensitive, so `com7` and `COM7` are the same port.
 * Two handles to one port is the failure this registry exists to prevent.
 */
function portKey(path: string): string {
  return process.platform === "win32" ? path.toUpperCase() : path;
}

/**
 * The PowerShell that reads the port.
 *
 * This is built as separate lines and joined with newlines, not `"; "`. The
 * semicolon form is what used to be here and it does not parse: joining
 * `while($true){ try {…} catch {…} }` with semicolons produces
 * `while($true){;  try {…};  catch {…} }`, and PowerShell rejects a `catch`
 * that does not directly follow the closing brace ("MissingCatchOrFinally").
 * Serial capture was broken on Windows for exactly this reason.
 *
 * `BaseStream.Read` rather than `ReadLine`: ReadLine discards the bytes it has
 * buffered every time ReadTimeout fires, so a firmware that prints without a
 * trailing newline loses data in 500 ms slices. Read returns as soon as any
 * byte arrives and never throws the buffered part away.
 *
 * Exported so the test can hand it to PowerShell's own parser.
 */
export function windowsSerialScript(assertDtr: boolean): string {
  return [
    "$ErrorActionPreference='Stop'",
    "$p=New-Object System.IO.Ports.SerialPort $env:PROM_PORT,$env:PROM_BAUD",
    // DTR is wired to RESET through a capacitor on most dev boards, so
    // asserting it reboots the target. That is sometimes what you want (to
    // catch a boot banner) and sometimes destroys the test (you lose the
    // message you were waiting for). The caller decides.
    `$p.DtrEnable=${assertDtr ? "$true" : "$false"}`,
    "$p.ReadTimeout=1000",
    "try {",
    "  $p.Open()",
    "  $out=[Console]::OpenStandardOutput()",
    "  $buf=New-Object byte[] 4096",
    "  while($true) {",
    "    try {",
    "      $n=$p.BaseStream.Read($buf,0,$buf.Length)",
    "      if($n -gt 0) { $out.Write($buf,0,$n); $out.Flush() }",
    "    } catch [System.TimeoutException] { }",
    "  }",
    "} finally {",
    "  if($p.IsOpen) { $p.Close() }",
    "}",
  ].join("\n");
}

function openWindowsPort(path: string, baud: number, assertDtr: boolean): PortHandle {
  const script = windowsSerialScript(assertDtr);

  const child = spawn("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
    env: { ...process.env, PROM_PORT: path, PROM_BAUD: String(baud) },
    windowsHide: true,
  });

  // PowerShell's errors used to be merged into the data stream, so a failed
  // open looked like the device printing gibberish in Chinese. Keep them apart.
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    if (stderr.length < 8192) stderr += chunk.toString("utf8");
  });

  const exitListeners: ((info: { code: number | null; error?: string }) => void)[] = [];
  let exited = false;
  child.on("exit", (code) => {
    if (exited) return;
    exited = true;
    const error = stderr.trim() || undefined;
    for (const listener of exitListeners) listener({ code, error });
  });
  // A spawn failure (powershell missing) surfaces here, not on "exit".
  child.on("error", (err) => {
    if (exited) return;
    exited = true;
    for (const listener of exitListeners) listener({ code: null, error: err.message });
  });

  return {
    onData(listener) {
      // Raw device bytes. Line splitting belongs to the caller, who decides
      // what a "line" means and how much of it to keep.
      child.stdout.on("data", (chunk: Buffer) => listener(chunk.toString("utf8")));
    },
    onExit(listener) {
      exitListeners.push(listener);
    },
    close() {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    },
  };
}

function openPosixPort(path: string, baud: number): PortHandle {
  // `raw` disables the tty line discipline, so the bytes arrive as the device
  // sent them instead of being echoed, translated, or buffered until newline.
  const configured = spawnSync("stty", ["-F", path, String(baud), "raw", "-echo"], { stdio: "ignore" });
  if (configured.status !== 0) {
    // macOS spells the flag -f; try once before giving up.
    const retry = spawnSync("stty", ["-f", path, String(baud), "raw", "-echo"], { stdio: "ignore" });
    if (retry.status !== 0) throw new Error(`could not configure ${path} at ${baud} baud`);
  }

  const stream = createReadStream(path, { encoding: "utf8" });
  const exitListeners: ((info: { code: number | null; error?: string }) => void)[] = [];
  let exited = false;
  const reportExit = (error?: string) => {
    if (exited) return;
    exited = true;
    for (const listener of exitListeners) listener({ code: null, error });
  };
  // A stream error is emitted asynchronously, so a caller that only guards the
  // synchronous open would never see it.
  stream.on("error", (err) => reportExit(err.message));
  stream.on("close", () => reportExit());
  return {
    onData(listener) {
      stream.on("data", (chunk) => listener(String(chunk)));
    },
    onExit(listener) {
      exitListeners.push(listener);
    },
    close() {
      stream.destroy();
    },
  };
}

/**
 * Open a port, read until a condition or a deadline, close.
 *
 * The read is bounded twice: by time and by line count. A device that floods
 * the console must not be able to fill the agent's context, and a silent
 * device must not hold the turn open forever.
 *
 * `open` is injected so the caller owns the dependency and the tests do not
 * need a physical port.
 */
export interface PortHandle {
  /** Raw bytes as they arrive. Line splitting is the caller's job. */
  onData(listener: (chunk: string) => void): void;
  /** Fired once when the reader stops, with the reason when there is one. */
  onExit?(listener: (info: { code: number | null; error?: string }) => void): void;
  close(): void;
}

export function capture(
  open: (path: string, baud: number) => PortHandle,
  path: string,
  options: CaptureOptions = {},
): Promise<CaptureResult> {
  const timeoutMs = options.timeoutMs ?? 5000;
  const maxLines = options.maxLines ?? 2000;
  const baud = options.baud ?? 115200;

  return new Promise((resolve) => {
    const lines: LogLine[] = [];
    const errors: string[] = [];
    let buffer = "";
    let matched: LogLine | undefined;
    let skipPending = Boolean(options.skipUntil);
    let done = false;
    let handle: PortHandle | undefined;

    const finish = (timedOut: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      // A trailing partial line is still a line — devices often end a message
      // without a newline. But when the capture ended on a line count, the
      // buffer holds whole unread lines, which must not become an eleventh.
      if (buffer.trim() && !buffer.includes("\n") && !options.until?.test(buffer)) {
        lines.push(parseLine(buffer));
      }
      try {
        handle?.close();
      } catch {
        /* the port may already be gone */
      }
      resolve({ lines, ...(matched ? { matched } : {}), timedOut, errors });
    };

    const timer = setTimeout(() => finish(true), timeoutMs);

    const consume = (chunk: string) => {
      buffer += chunk;
      let index = buffer.indexOf("\n");
      while (index >= 0 && !done) {
        const raw = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        handleLine(raw);
        index = buffer.indexOf("\n");
      }
      // A device printing without newlines must not grow the buffer forever.
      if (buffer.length > 64 * 1024) {
        errors.push("line exceeded 64 KiB; truncated");
        buffer = buffer.slice(-1024);
      }
    };

    const handleLine = (raw: string) => {
      if (!raw.trim()) return;
      const line = parseLine(raw);
      // skipUntil is a gate, not a filter: the matching line is kept and every
      // line after it, including later lines that would also match.
      if (skipPending) {
        if (!options.skipUntil?.test(line.text) && !options.skipUntil?.test(line.raw)) return;
        skipPending = false;
      }
      if (options.until) {
        const hit = options.until.exec(line.text) ?? options.until.exec(line.raw);
        lines.push(line);
        if (hit) {
          matched = line;
          finish(false);
        }
        return;
      }
      lines.push(line);
      if (lines.length >= maxLines) finish(true);
    };

    try {
      handle = open(path, baud);
      handle.onData(consume);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
      finish(false);
    }
  });
}
