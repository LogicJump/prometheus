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
import type { Identity } from "./identity.ts";
import { familyStems, flashCodeFor } from "./identity.ts";

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
  /**
   * Where `effective.target` came from.
   *
   * `chip` — read from the attached part and matched to a name a flasher
   * accepts. `manual` — typed by the user, with nothing attached to check it
   * against. `unlisted` — the part answered but no tool has a name for it.
   * `none` — nothing to flash.
   */
  targetSource?: "chip" | "manual" | "unlisted" | "none";
  /** The names the attached chip answers to, when it was identified. */
  targetOptions?: string[];
  /** `null` until toolchains and devices have been scanned. */
  scannedAt: string | null;
  build: BoardBuildInfo | null;
  /**
   * What the attached part says it is, read from the part itself.
   *
   * This is the only field here that describes the hardware rather than the
   * configuration. `selection.target` is what the user last chose and may be
   * months out of date; this is what answered when the probe asked.
   */
  identity?: Identity | null;
  /** Why identification did not happen, when it was attempted and failed. */
  identityNote?: string;
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
  identity?: Identity | null;
  identityNote?: string;
  /** Filled in by the caller when the target came from the chip. */
  target?: string;
  targetOptions?: string[];
  targetSource?: BoardState["targetSource"];
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
  const effective = boardDefaults(selection, ports);
  // A target derived from the attached chip replaces the stored one, because
  // the stored one is a memory of the last board. When nothing narrowed it,
  // the stored name stays exactly as it was.
  if (input.target) effective.target = input.target;
  else if (input.targetSource === "unlisted" || input.targetSource === "none") delete effective.target;
  return {
    project: input.project,
    tools: input.tools ?? [],
    missing: input.missing ?? [],
    probes: input.probes ?? [],
    probeNotes: input.probeNotes ?? [],
    ports,
    selection,
    effective,
    ...(input.targetSource ? { targetSource: input.targetSource } : {}),
    ...(input.targetOptions ? { targetOptions: input.targetOptions } : {}),
    scannedAt: input.scannedAt ?? null,
    build: input.build ?? null,
    ...(input.identity !== undefined ? { identity: input.identity } : {}),
    ...(input.identityNote ? { identityNote: input.identityNote } : {}),
  };
}

/**
 * The board a tool should act on, with provenance attached.
 *
 * `effective` is a `BoardSelection` and says nothing about where its target
 * came from. Tools need that: a name derived from the chip and a name typed by
 * hand are used the same way, but only one of them can be trusted without
 * checking, and a tool that reports what it did should be able to say which it
 * was. The host builds this once per scan and hands the same object to the
 * pane, the system prompt and every board tool.
 */
export interface EffectiveBoard {
  /** The name a flasher would be given, when there is one. */
  target?: string;
  port?: string;
  baud?: number;
  flasher?: string;
  /** Where `target` came from. Mirrors `BoardState.targetSource`. */
  source: "chip" | "manual" | "unlisted" | "none";
  /** The part the probe read, when it read one. */
  identity?: Identity | null;
}

/** Build the effective board from a selection and what was discovered. */
export function effectiveBoard(
  selection: BoardSelection,
  identity: Identity | null,
  resolvedTarget: string | undefined,
  source: EffectiveBoard["source"],
  ports: { path: string }[] = [],
): EffectiveBoard {
  const filled = boardDefaults(selection, ports as never);
  const board: EffectiveBoard = { source };
  if (resolvedTarget) board.target = resolvedTarget;
  if (filled.port) board.port = filled.port;
  if (filled.baud) board.baud = filled.baud;
  if (filled.flasher) board.flasher = filled.flasher;
  if (identity) board.identity = identity;
  return board;
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
  /**
   * Set when the selection names a part the attached chip is not.
   *
   * Being in the target table says the name is spellable, not that it is the
   * board on the desk. A stored `stm32f103rc` with an F429 attached is a
   * perfectly valid entry for a part that is not plugged in, and calling that
   * "found in the target table" is how a wrong flash gets written.
   */
  mismatch?: { selected: string; attached: string };
}

/**
 * Whether the selected target is real.
 *
 * `unloaded` is not `absent`. A pane that says "no such chip" before anyone
 * has loaded the target table is wrong in the most damaging way — it tells
 * someone their hardware is unsupported when the answer is that we have not
 * looked.
 */
export function boardTargetStatus(
  selected: string | undefined,
  table: Target[] | null,
  identity?: Identity | null,
): TargetStatus {
  if (table === null) return { kind: "unloaded", candidates: [], total: 0 };
  if (!selected) return { kind: "unloaded", candidates: [], total: table.length };

  // A valid entry for a chip that is not attached is the most expensive kind of
  // wrong: everything looks green and the flash goes to the wrong part.
  const matches = targetMatchesIdentity(selected, identity);
  const mismatch = matches === false ? { selected, attached: identity?.family ?? "" } : undefined;

  const needle = selected.trim().toLowerCase();
  const exact = table.find((entry) => entry.name.toLowerCase() === needle);
  if (exact) return { kind: "exact", target: exact, candidates: [exact], total: table.length, ...(mismatch ? { mismatch } : {}) };

  // Part number and name are different fields, and the user may type either.
  const byPart = table.find((entry) => entry.part?.toLowerCase() === needle);
  if (byPart) return { kind: "exact", target: byPart, candidates: [byPart], total: table.length, ...(mismatch ? { mismatch } : {}) };

  const normalise = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
  const compact = normalise(selected);
  const related = table.filter(
    (entry) =>
      normalise(entry.name).includes(compact) ||
      normalise(entry.part ?? "").includes(compact) ||
      compact.includes(normalise(entry.name)),
  );
  if (related.length > 0) {
    return { kind: "candidates", candidates: related.slice(0, 8), total: table.length, ...(mismatch ? { mismatch } : {}) };
  }

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
    if (near.length > 0) {
      return { kind: "candidates", candidates: near.slice(0, 8), total: table.length, ...(mismatch ? { mismatch } : {}) };
    }
  }
  return { kind: "absent", candidates: [], total: table.length, ...(mismatch ? { mismatch } : {}) };
}

/** The target a flash or debug call should use, given everything known. */
export function resolveTarget(selection: BoardSelection, status: TargetStatus): string | undefined {
  if (status.kind === "exact" && status.target) return status.target.name;
  // An unverified name is still worth passing through: the tools have their own
  // validation and may understand a target this table does not list.
  return selection.target;
}

/**
 * Whether a target name is the part that is actually attached.
 *
 * Compared on the family stem: `stm32f429xg` and `stm32f429zi` are two
 * spellings of the same silicon offered by two tools, and refusing one because
 * the other was stored would be noise.
 *
 * The flash code is a second check and it is a real one: `stm32f429xi` (2 MiB)
 * against a 1 MiB part means an image that overwrites what the part does not
 * have. It is applied only when both sides state a size — a target name with
 * no trailing code is a whole-family entry and matches anything in the family.
 */
export function targetMatchesIdentity(
  target: string | undefined,
  identity: Identity | null | undefined,
): boolean | undefined {
  // `undefined` is "cannot tell", which is different from "no". A pane that
  // shows a red conflict before reading the chip is worse than one that waits.
  if (!target || !identity?.family) return undefined;

  const stems = familyStems(identity.family);
  if (stems.length === 0) return undefined;
  const name = target.toLowerCase();
  const stem = stems.find((candidate) => name.startsWith(candidate));
  if (!stem) return false;

  // The trailing letter is the flash-size code. No suffix means the tool's
  // entry covers the whole family, which is not a disagreement about size.
  // `stm32f42x` ends in an `x` that stands for the family wildcard, not a
  // size — the size letters are a subset of the ones ST actually publishes.
  const suffix = name.slice(stem.length);
  const code = /[a-z]$/.exec(suffix)?.[0];
  if (!code || !"89bcdefgi".includes(code) || identity.flashKib === undefined) return true;
  const expected = flashCodeFor(identity.flashKib);
  return expected === undefined ? true : code === expected;
}
