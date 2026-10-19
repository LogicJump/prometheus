/**
 * Hardware in the loop: power cycling, capture, replay.
 *
 * Some failures only happen from a cold boot, and some only happen after the
 * supply is cut at the wrong moment. Reproducing them by hand is a person
 * unplugging a cable for twenty minutes; a relay (or a USB hub with per-port
 * switching) does it the same way every time.
 *
 * The device is behind a small interface so the tool does not depend on a
 * particular relay vendor: `uhubctl` and a smart plug are both `power on` and
 * `power off`. The recorder captures the serial output around each cycle and
 * keeps it, so a boot banner and the failure that follows are one artifact.
 */

import { spawn } from "node:child_process";

export interface PowerDevice {
  kind: "uhubctl" | "command";
  /** Port selector for uhubctl (`-p`) or the program to run for `command`. */
  target: string;
  /** For `command`: the arguments that turn the port on. */
  onArgs?: string[];
  /** For `command`: the arguments that turn it off. */
  offArgs?: string[];
  /** How long to wait after switching before reading the console. */
  settleMs?: number;
}

export interface PowerCycleTask {
  on: string[];
  off: string[];
  program: string;
}

/**
 * Build the two commands that switch a port.
 *
 * uhubctl is the common case: a powered hub whose per-port switches can be
 * toggled. A `command` device is the escape hatch for a USB relay or a smart
 * plug's CLI.
 */
export function powerCommands(device: PowerDevice): PowerCycleTask {
  if (device.kind === "uhubctl") {
    return {
      program: "uhubctl",
      on: ["-p", device.target, "-a", "on"],
      off: ["-p", device.target, "-a", "off"],
    };
  }
  return {
    program: device.target,
    on: device.onArgs ?? ["on"],
    off: device.offArgs ?? ["off"],
  };
}

/** Run one command to completion; the caller decides what a failure means. */
export function runPowerCommand(program: string, args: string[], timeoutMs = 15_000): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(program, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: null, output: `${output}\n${err.message}`.trim() });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, output: output.trim() });
    });
  });
}

export interface PowerCycleRecord {
  cycle: number;
  at: string;
  /** Lines captured from the console after the power came back. */
  lines: string[];
  /** True when the capture matched the expected banner. */
  banner?: boolean;
  error?: string;
}

/** The plan for a cycle run, in the shape a tool reports before starting it. */
export interface CyclePlan {
  count: number;
  settleMs: number;
  captureMs: number;
  until?: string;
  /** What the user is about to have done to their hardware. */
  description: string;
}

/**
 * Describe a cycle run so the approval prompt can say what will happen.
 *
 * A power cycle is a physical action with a cost (a relay clicking twenty
 * times is not a free operation, and on a battery-powered board it is a real
 * one), so the plan is stated before it runs rather than discovered from the
 * output.
 */
export function describePlan(plan: CyclePlan, device: PowerDevice): string {
  return (
    `Power-cycle ${device.kind === "uhubctl" ? `port ${device.target}` : `via ${device.target}`} ` +
    `${plan.count} time(s), waiting ${plan.settleMs} ms after power-on, ` +
    `capturing ${plan.captureMs} ms of console each cycle` +
    (plan.until ? `, stopping at "${plan.until}"` : "") +
    "."
  );
}

/** Timing defaults: long enough for a boot banner, short enough to iterate. */
export const CYCLE_DEFAULTS = { settleMs: 800, captureMs: 5_000, count: 3 } as const;
