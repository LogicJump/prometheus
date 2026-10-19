/**
 * Pin map: which physical pin a peripheral function lands on, as far as the
 * machine-readable sources actually say.
 *
 * There is no vendor-neutral pin database. What exists, in order of
 * reliability:
 *
 *   1. a project pin config the firmware itself uses (Zephyr `pinctrl` devicetree,
 *      PlatformIO `board` + variant headers, Arduino variant tables)
 *   2. the SVD, which names GPIO ports and their alternate-function fields but
 *      **not** which package pin each port bit is bonded to
 *   3. a `.pincfg`/CSV table the user drops in the workspace, for the schematic
 *
 * This module reads 1 and 2 and merges them. It never invents a package pin
 * number: when the sources only say "PA9", the answer is "PA9", and the
 * package pin is reported as unknown. That distinction is the whole point —
 * a pin map that guesses "pin 42" is worse than one that says "PA9 (package
 * pin not in the SVD)".
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import type { SvdDevice } from "./svd.ts";

export interface PinAssignment {
  /** Port + bit, e.g. `PA9`. */
  pin: string;
  function: string;
  /** The peripheral/register the assignment was read from. */
  source: string;
  /** Package pin, only when a source actually states it. */
  packagePin?: number;
  /** Extra detail the source gave (slew, pull, open-drain). */
  detail?: string;
}

export interface PinMap {
  assignments: PinAssignment[];
  /** Where each part of the map came from. */
  sources: { kind: string; path: string; pins: number }[];
  /** Reasons a source could not contribute. */
  notes: string[];
}

/** GPIO port peripherals, by the names SVDs actually use. */
const PORT_PERIPHERAL = /^(GPIO[A-K]|P[A-K]|PORT[A-K])$/i;

/**
 * Read the alternate-function table out of an SVD.
 *
 * A GPIO peripheral with an `AFR`/`AFRL`/`AFRH` register describes, per bit,
 * which alternate function can be selected — that is a pin *capability*, not an
 * assignment, and it is reported as such. An SVD that also has a pin-name
 * element (rare, vendor-specific) contributes the package number when present.
 */
export function pinsFromSvd(device: SvdDevice): PinMap {
  const assignments: PinAssignment[] = [];
  const notes: string[] = [];
  let contributed = 0;
  for (const peripheral of device.peripherals) {
    if (!PORT_PERIPHERAL.test(peripheral.name)) continue;
    const port = peripheral.name.replace(/^GPIO/i, "").replace(/^PORT/i, "").replace(/^P(?=[A-K]$)/i, "");
    for (const register of peripheral.registers) {
      // AFR registers encode 4-bit function numbers; the field name carries the
      // bit index (`AFRL0`..`AFRL7`), which is the only portable reading.
      if (!/^AFR[LH]?\d*$/i.test(register.name) && !/alternate/i.test(register.description ?? "")) continue;
      for (const field of register.fields) {
        const bit = Number((/(\d+)$/.exec(field.name) ?? [])[1]);
        if (!Number.isFinite(bit)) continue;
        const functionName = field.description?.trim();
        if (!functionName) continue;
        assignments.push({
          pin: `P${port}${bit}`,
          function: functionName,
          source: `${peripheral.name}.${register.name}.${field.name}`,
          detail: "alternate function selectable; check the reference manual for the mode",
        });
        contributed += 1;
      }
    }
  }
  if (contributed === 0) {
    notes.push("the SVD has no alternate-function fields; package pins are not in it");
  }
  return {
    assignments,
    sources: contributed > 0 ? [{ kind: "svd", path: device.name, pins: contributed }] : [],
    notes,
  };
}

/**
 * Read `pinctrl` assignments from a Zephyr devicetree overlay.
 *
 * Zephyr states pins as `NRF_PSEL/UARTE_TX/0/6` or `P0.6` style names inside
 * `pinctrl-0` groups; the parser takes the `P<port>.<bit>` form, which is the
 * stable part across SoC families, and keeps the property name as the function.
 */
export function pinsFromDts(text: string, path = "overlay.dts"): PinMap {
  const assignments: PinAssignment[] = [];
  const notes: string[] = [];
  // Match `name = < P0 6 ... >` style groups (NXP), `P0.6` (Nordic), and
  // `GPIO6`/`GPIO_6` aliases used by several overlays.
  const propertyPattern = /([a-z0-9_-]+)\s*=\s*<([^>]*)>/gi;
  let match: RegExpExecArray | null;
  while ((match = propertyPattern.exec(text))) {
    const property = match[1];
    const body = match[2];
    if (!/pinctrl|gpio|psel|uart|spi|i2c|pwm|adc|can/i.test(property)) continue;
    for (const pinMatch of body.matchAll(/\bP([0-9])(?:\.|_)([0-9]{1,2})\b/g)) {
      assignments.push({
        // Normalized to the devicetree spelling `P0.6`: joining port and bit
        // without a separator produced `P006`, which is ambiguous for a port
        // that has more than nine bits.
        pin: `P${pinMatch[1]}.${Number(pinMatch[2])}`,
        function: property,
        source: path,
      });
    }
    for (const pinMatch of body.matchAll(/\bGPIO_?([0-9]{1,2})\b/g)) {
      assignments.push({ pin: `GPIO${pinMatch[1]}`, function: property, source: path });
    }
  }
  if (assignments.length === 0) notes.push(`${path}: no pinctrl assignments were found`);
  return {
    assignments,
    sources: assignments.length > 0 ? [{ kind: "devicetree", path, pins: assignments.length }] : [],
    notes,
  };
}

/**
 * Read a user-supplied pin table.
 *
 * The format is deliberately plain: one assignment per line, either
 * `PA9, package 42, USART1_TX` or `PA9,USART1_TX`. This exists because the
 * schematic is the only source that knows the package pin, and no vendor ships
 * it in a parseable form.
 */
export function pinsFromTable(text: string, path = "pins.csv"): PinMap {
  const assignments: PinAssignment[] = [];
  const notes: string[] = [];
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const cells = line.split(",").map((cell) => cell.trim());
    if (cells.length < 2) {
      notes.push(`${path}:${index + 1}: expected pin, function`);
      continue;
    }
    const pin = cells[0];
    let packagePin: number | undefined;
    let cursor = 1;
    if (/^\d+$/.test(cells[1])) {
      packagePin = Number(cells[1]);
      cursor = 2;
    }
    const functionName = cells.slice(cursor).join(", ");
    if (!functionName) {
      notes.push(`${path}:${index + 1}: no function named`);
      continue;
    }
    assignments.push({ pin, function: functionName, source: path, ...(packagePin !== undefined ? { packagePin } : {}) });
  }
  return {
    assignments,
    sources: assignments.length > 0 ? [{ kind: "table", path, pins: assignments.length }] : [],
    notes,
  };
}

/** Merge maps, preferring a later source for the same pin+function. */
export function mergePinMaps(maps: PinMap[]): PinMap {
  const byKey = new Map<string, PinAssignment>();
  const sources: PinMap["sources"] = [];
  const notes: string[] = [];
  for (const map of maps) {
    sources.push(...map.sources);
    notes.push(...map.notes);
    for (const assignment of map.assignments) {
      byKey.set(`${assignment.pin}|${assignment.function}`, assignment);
    }
  }
  return { assignments: [...byKey.values()], sources, notes };
}

/** Workspace files that can contribute a pin map. */
export function pinSourceFiles(cwd: string): { dts: string[]; tables: string[] } {
  const dts: string[] = [];
  const tables: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 3) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name.startsWith(".") || entry.name === "build") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
        continue;
      }
      const ext = extname(entry.name).toLowerCase();
      if (ext === ".dts" || ext === ".dtsi" || ext === ".overlay") dts.push(full);
      else if (/^(pins?|pinmap)\.(csv|txt)$/i.test(entry.name)) tables.push(full);
    }
  };
  walk(cwd, 0);
  return { dts: dts.slice(0, 20), tables };
}

/** One line per assignment, for a tool result. */
export function formatPinMap(map: PinMap): string {
  if (map.assignments.length === 0) {
    return `no pin assignments were found${map.notes.length ? `\n${map.notes.join("\n")}` : ""}`;
  }
  const rows = map.assignments
    .slice()
    .sort((a, b) => a.pin.localeCompare(b.pin, undefined, { numeric: true }))
    .map((assignment) => {
      const pkg = assignment.packagePin !== undefined ? `package ${assignment.packagePin}` : "package pin unknown";
      return `${assignment.pin.padEnd(8)} ${assignment.function.padEnd(28)} ${pkg}  (${assignment.source})`;
    });
  const header = `sources: ${map.sources.map((source) => `${source.kind}:${source.path}`).join(", ")}`;
  return [header, ...rows, ...(map.notes.length ? ["", ...map.notes] : [])].join("\n");
}

/** True when a path looks like a pin table. */
export function isPinTable(path: string): boolean {
  return /^(pins?|pinmap)\.(csv|txt)$/i.test(path.split(/[\\/]/).pop() ?? "");
}

/** Guard for a caller that wants to know whether a file is readable text. */
export function readIfFile(path: string, limit = 256 * 1024): string | null {
  try {
    if (!existsSync(path) || !statSync(path).isFile()) return null;
    return readFileSync(path, "utf8").slice(0, limit);
  } catch {
    return null;
  }
}
