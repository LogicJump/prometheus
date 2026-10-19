/**
 * RTT and SWO: log channels that do not need a UART pin.
 *
 * A board often has no spare UART: the console goes to a USB-serial adapter
 * that is not wired, or every pin is used. J-Link RTT and ARM SWO both carry
 * `printf` output over the debug probe instead, which is already attached for
 * flashing. The protocol is the probe's, so this module only knows the two
 * command shapes and how to turn their output into the same line stream the
 * serial console produces.
 *
 * The command is assembled from the tools the user has, never from a vendor
 * default: probe-rs speaks RTT with `rtt attach`, J-Link with its own script,
 * and a plain OpenOCD setup only has SWO.
 */

export type TraceChannel = "rtt" | "swo";

export interface TraceRequest {
  channel: TraceChannel;
  /** The probe tool: `probe-rs` or `jlink`. */
  program: "probe-rs" | "jlink";
  /** Target chip, for probe-rs's `--chip`. */
  target?: string;
  /** Probe serial, when several are attached. */
  probe?: string;
  /** SWO clock in Hz, for the SWO channel. */
  swoFrequency?: number;
}

/**
 * The command that streams the channel.
 *
 * Both tools print to stdout; the caller reads it exactly like a serial port.
 * `probe-rs rtt attach` is the documented spelling for the RTT channel, and
 * J-Link needs a Commander script because `JLinkExe` has no RTT subcommand.
 */
export function traceCommand(request: TraceRequest): { program: string; args: string[] } | null {
  if (request.program === "probe-rs") {
    if (request.channel === "rtt") {
      const args = ["rtt", "attach"];
      if (request.target) args.push("--chip", request.target);
      if (request.probe) args.push("--probe", request.probe);
      return { program: "probe-rs", args };
    }
    // SWO is `probe-rs swo` in recent versions; the caller reports a clear
    // error when the installed version does not have it.
    const args = ["swo"];
    if (request.target) args.push("--chip", request.target);
    if (request.probe) args.push("--probe", request.probe);
    args.push("--frequency", String(request.swoFrequency ?? 2_000_000));
    return { program: "probe-rs", args };
  }
  // J-Link: a Commander script starts RTT and leaves the session open.
  if (request.channel === "rtt") {
    const args = ["-NoGui", "1", "-CommandFile", "-"];
    if (request.probe) args.push("-SelectEmuBySN", request.probe);
    return { program: "JLinkExe", args };
  }
  return null;
}

/** The Commander script body for J-Link RTT. */
export function jlinkRttScript(target: string): string {
  return ["r", "exec SetRTTAddr 0", "exec RTTStart", "exec RTTStart"].join("\n");
}

/**
 * Parse one RTT line into the fields the serial console's line model uses.
 *
 * RTT output is whatever the firmware wrote. A common convention is a logging
 * macro's `[LEVEL] tag: text`; this recognizes that shape and leaves anything
 * else as plain text, because guessing would mangle a `printf` of hex.
 */
export interface TraceLine {
  text: string;
  level?: "error" | "warn" | "info" | "debug";
  tag?: string;
  t?: number;
}

const LEVELED = /^\[\s*(ERR|ERROR|WARN|WARNING|INF|INFO|DBG|DEBUG|TRC|TRACE)\s*\]\s*(?:([\w.-]+):\s*)?(.*)$/i;

export function parseTraceLine(raw: string, elapsedMs?: number): TraceLine {
  const match = LEVELED.exec(raw.trim());
  if (match) {
    const level = match[1].toUpperCase();
    return {
      text: match[3],
      level: level.startsWith("ERR")
        ? "error"
        : level.startsWith("WARN")
          ? "warn"
          : level.startsWith("DBG") || level.startsWith("TRC")
            ? "debug"
            : "info",
      ...(match[2] ? { tag: match[2] } : {}),
      ...(elapsedMs !== undefined ? { t: elapsedMs } : {}),
    };
  }
  return { text: raw, ...(elapsedMs !== undefined ? { t: elapsedMs } : {}) };
}

/** Split a chunk into complete lines, returning the trailing partial one. */
export function splitTraceChunk(carry: string, chunk: string): { lines: string[]; carry: string } {
  const combined = carry + chunk;
  const parts = combined.split(/\r?\n/);
  const rest = parts.pop() ?? "";
  return { lines: parts.filter((line) => line.length > 0), carry: rest.length > 4096 ? rest.slice(-4096) : rest };
}
