/**
 * What the Board pane shows, assembled from parts that are discovered
 * separately.
 *
 * The pieces have wildly different costs — project detection is synchronous
 * and free, toolchain detection spawns a dozen binaries, target listing can
 * take forty seconds — so this module does no discovery of its own. It takes
 * whatever the caller already has and turns it into one shape the UI can
 * render, including the distinction between "there is no such target" and
 * "nobody has looked yet". Conflating those two is how a UI ends up telling
 * someone their chip does not exist.
 */

import type { BoardSelection } from "../types.ts";
import type { DetectedProject } from "./project.ts";
import type { Probe, Target } from "./probe.ts";
import type { SerialPortInfo } from "./serial.ts";
import type { FoundTool, ToolchainKind } from "./toolchain.ts";

export interface BoardBuildInfo {
  ok: boolean;
  /** Bytes of flash and RAM from `arm-none-eabi-size`. Absent when not measured. */
  usage?: { flash: number; ram: number };
  /** Where the numbers came from, so the UI can say so. */
  at: string;
}

export interface BoardState {
  project: DetectedProject;
  tools: FoundTool[];
  missing: ToolchainKind[];
  probes: Probe[];
  probeNotes: string[];
  ports: SerialPortInfo[];
  /** What the user picked, verbatim. */
  selection: BoardSelection;
  /**
   * What the tools will actually use: the selection, with the only attached
   * port filled in when exactly one is present. Never invents a target.
   */
  effective: BoardSelection;
  /** `null` until toolchains and devices have been scanned. */
  scannedAt: string | null;
  build: BoardBuildInfo | null;
}

export interface BoardInputs {
  project: DetectedProject;
  tools?: FoundTool[];
  missing?: ToolchainKind[];
  probes?: Probe[];
  probeNotes?: string[];
  ports?: SerialPortInfo[];
  selection?: BoardSelection;
  scannedAt?: string | null;
  build?: BoardBuildInfo | null;
}

/**
 * Fill in an unattended default: when exactly one serial port is attached and
 * the user has not chosen one, that port is what they mean. Any other guess
 * (the first of several, a port whose VID looks familiar) is a coin flip that
 * can open the wrong device.
 */
export function boardDefaults(selection: BoardSelection, ports: SerialPortInfo[]): BoardSelection {
  const effective: BoardSelection = { ...selection };
  if (!effective.port && ports.length === 1) effective.port = ports[0].path;
  if (!effective.baud) effective.baud = 115200;
  if (effective.assertDtr === undefined) effective.assertDtr = false;
  return effective;
}

export function assembleBoardState(input: BoardInputs): BoardState {
  const selection = input.selection ?? {};
  const ports = input.ports ?? [];
  return {
    project: input.project,
    tools: input.tools ?? [],
    missing: input.missing ?? [],
    probes: input.probes ?? [],
    probeNotes: input.probeNotes ?? [],
    ports,
    selection,
    effective: boardDefaults(selection, ports),
    scannedAt: input.scannedAt ?? null,
    build: input.build ?? null,
  };
}

export type TargetStatusKind = "exact" | "candidates" | "absent" | "unloaded";

export interface TargetStatus {
  kind: TargetStatusKind;
  /** The target the tools would use, when it exists in the table. */
  target?: Target;
  /** Close matches, for "did you mean" and for the absent case. */
  candidates: Target[];
  /** How many targets the table held when this was computed. */
  total: number;
}

/**
 * Whether the selected target is real.
 *
 * `unloaded` is not `absent`. A pane that says "no such chip" before anyone
 * has loaded the target table is wrong in the most damaging way — it tells
 * someone their hardware is unsupported when the answer is that we have not
 * looked.
 */
export function boardTargetStatus(selected: string | undefined, table: Target[] | null): TargetStatus {
  if (table === null) return { kind: "unloaded", candidates: [], total: 0 };
  if (!selected) return { kind: "unloaded", candidates: [], total: table.length };

  const needle = selected.trim().toLowerCase();
  const exact = table.find((entry) => entry.name.toLowerCase() === needle);
  if (exact) return { kind: "exact", target: exact, candidates: [exact], total: table.length };

  // Part number and name are different fields, and the user may type either.
  const byPart = table.find((entry) => entry.part?.toLowerCase() === needle);
  if (byPart) return { kind: "exact", target: byPart, candidates: [byPart], total: table.length };

  const normalise = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
  const compact = normalise(selected);
  const related = table.filter(
    (entry) =>
      normalise(entry.name).includes(compact) ||
      normalise(entry.part ?? "").includes(compact) ||
      compact.includes(normalise(entry.name)),
  );
  if (related.length > 0) return { kind: "candidates", candidates: related.slice(0, 8), total: table.length };

  // Nothing contains the string, but a part number is not a free-form name:
  // `stm32f103ze` and `stm32f103rc` are the same family and differ only in
  // flash size and package. Dropping the trailing package codes is what turns
  // "not in the table" into "these are close". Only trailing letters (plus any
  // digits glued to them) are dropped, so `stm32f103` and `stm32f105` stay
  // distinct: suggesting the wrong family is worse than suggesting nothing.
  const stem = (value: string) => normalise(value).replace(/[a-z]+\d*$/, "");
  const needleStem = stem(selected);
  if (needleStem.length >= 6) {
    const near = table.filter((entry) => stem(entry.name) === needleStem || stem(entry.part ?? "") === needleStem);
    if (near.length > 0) return { kind: "candidates", candidates: near.slice(0, 8), total: table.length };
  }
  return { kind: "absent", candidates: [], total: table.length };
}

/** The target a flash or debug call should use, given everything known. */
export function resolveTarget(selection: BoardSelection, status: TargetStatus): string | undefined {
  if (status.kind === "exact" && status.target) return status.target.name;
  // An unverified name is still worth passing through: the tools have their own
  // validation and may understand a target this table does not list.
  return selection.target;
}
