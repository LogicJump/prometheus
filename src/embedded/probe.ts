/**
 * What can this machine talk to?
 *
 * Two different questions that the agent must not confuse:
 *
 *   - Which debug probes are physically attached? (`pyocd list`, `probe-rs list`)
 *   - Which chips could this toolchain target? (pyOCD ships 200+ builtin
 *     targets; Zephyr ships boards; PlatformIO ships boards.)
 *
 * The first is a fact about the desk. The second is a fact about the install.
 * A flash attempt needs both: a target name the tool recognises, and a probe
 * that is actually plugged in. Reporting them separately means the agent can
 * say "no probe detected" instead of "unknown target stm32f411re".
 *
 * Everything here shells out to a tool that may not be installed. A missing
 * tool degrades to an empty list plus a reason, never an exception.
 */

import { execFile } from "node:child_process";
import { toolEnv } from "./toolEnv.ts";

export type ProbeKind = "pyocd" | "probe-rs" | "openocd" | "jlink" | "stlink" | "esptool" | "dfu";

export interface Probe {
  kind: ProbeKind;
  /** Vendor string from the tool, e.g. `STLink V2` or `SEGGER J-Link`. */
  name: string;
  /** USB serial or unique id, when the tool reports one. */
  serial?: string;
  /** The tool's own target/board name for this probe, when it knows. */
  target?: string;
}

export interface Target {
  /** The name to pass to `--target` / `--chip`. */
  name: string;
  vendor: string;
  /** Part number as the vendor writes it, when distinct from `name`. */
  part?: string;
  /** Families the target belongs to (`STM32F4 Series`, `nRF52`). */
  families?: string[];
  /** Which tool knows this target. */
  source: ProbeKind;
  /** pyOCD's own origin for the target: builtin, a CMSIS pack, or cbuild-run. */
  packSource?: string;
  /** The register-map file this target names, when the tool reports one. */
  svdPath?: string;
}

export interface DiscoveryResult {
  probes: Probe[];
  /** One line per tool: what happened when we asked. */
  notes: string[];
}

export interface TargetResult {
  targets: Target[];
  notes: string[];
  /** The tool's own count, before any filtering. */
  total: number;
}

function run(program: string, args: string[], timeout = 20000): Promise<{ ok: boolean; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile(program, args, { env: toolEnv(), timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ ok: !error, out: String(stdout ?? ""), err: String(stderr ?? "") });
    });
  });
}

/** `pyocd list` prints a sentence on an empty desk; that is not an error. */
export function pyocdProbes(output: string): Probe[] {
  const probes: Probe[] = [];
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || /^No available debug probes/i.test(line)) continue;
    // Dashed rules only separate the header from the table.
    if (/^-{3,}$/.test(line)) continue;
    // `  #   Probe/Board    Unique ID                  Target`
    //
    // Without this the header parses as a probe named `#` attached to a chip
    // called `Probe/Board`, which then appears in the UI as real hardware.
    if (CELL_HEADER.test(line)) continue;
    // `  0   STLink V2  0673FF...   STM32F411RETx   ...`
    const cells = line.split(/\s{2,}/).map((cell) => cell.trim()).filter(Boolean);
    if (cells.length < 2) continue;
    // The first cell is an index when it is a bare integer.
    const body = /^\d+$/.test(cells[0]) ? cells.slice(1) : cells;
    if (body.length < 1) continue;
    const probe: Probe = { kind: "pyocd", name: body[0] };
    // A serial is a long hex/uppercase token; a target is the last cell.
    // pyOCD prints `n/a` when the probe does not know what it is attached to;
    // that is the absence of a target, not a target named "n/a".
    for (const cell of body.slice(1)) {
      if (isNoValue(cell)) continue;
      if (!probe.serial && /^[0-9A-F]{8,}$/i.test(cell.replace(/[^0-9A-Za-z]/g, ""))) probe.serial = cell;
      else if (!probe.target) probe.target = cell;
    }
    probes.push(probe);
  }
  return probes;
}

/** The column titles pyOCD prints above the probe table. */
const CELL_HEADER = /(^|\s)(Probe\/Board|Unique ID)(\s|$)/i;

/** Placeholders that mean "this tool has nothing to report here". */
function isNoValue(cell: string): boolean {
  return /^(n\/?a|none|unknown|-{1,2}|—)$/i.test(cell.trim());
}

/** probe-rs prints one block per probe; the useful line is the name. */
function probeRsProbes(output: string): Probe[] {
  const probes: Probe[] = [];
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || /\[\d+\]:/.test(line) === false) continue;
    const match = /\[\d+\]:\s*(.+?)(?:\s+—\s+(\S+))?$/.exec(line);
    if (!match) continue;
    probes.push({ kind: "probe-rs", name: match[1].trim(), ...(match[2] ? { serial: match[2] } : {}) });
  }
  return probes;
}

/**
 * Ask every installed tool what is connected.
 *
 * The tools are independent, so a failure in one must not hide another's
 * answer — each line in `notes` says which tool said what.
 */
export async function listProbes(available: Partial<Record<ProbeKind, string>>): Promise<DiscoveryResult> {
  const probes: Probe[] = [];
  const notes: string[] = [];

  const jobs: Promise<void>[] = [];

  if (available.pyocd) {
    jobs.push(
      run(available.pyocd, ["list"]).then((result) => {
        const found = pyocdProbes(result.out || result.err);
        probes.push(...found);
        notes.push(found.length ? `pyocd: ${found.length} probe(s)` : "pyocd: no probes connected");
      }),
    );
  }

  if (available["probe-rs"]) {
    jobs.push(
      run(available["probe-rs"], ["list"]).then((result) => {
        const found = probeRsProbes(result.out || result.err);
        probes.push(...found);
        notes.push(found.length ? `probe-rs: ${found.length} probe(s)` : "probe-rs: no probes connected");
      }),
    );
  }

  if (available.jlink) {
    // JLinkExe has no list command; `JLinkConfig` or the USB layer does. The
    // probe enumeration lives in JLinkGDBServer; asking it to list would hang,
    // so this tool reports only that it is installed.
    notes.push("jlink: installed (probe enumeration needs JLinkExe -CommanderScript)");
  }

  await Promise.all(jobs);
  return { probes, notes };
}

/**
 * pyOCD's builtin target table, parsed from `pyocd list --targets -H`.
 *
 * Columns are space-aligned with no delimiter, and a cell may itself contain
 * spaces (`STM32F4 Series`), so the split is on runs of two or more spaces
 * rather than single spaces. `-H` drops the header, whose dashes would
 * otherwise parse as a target.
 *
 * The trailing column (`builtin` / `pack` / `cbuild-run`) is the source, and
 * the Families column between the part number and the source is empty for
 * most builtin targets — so the source is identified by value, not position,
 * and anything left over is taken as the family.
 */
/**
 * pyOCD's target table.
 *
 * `pyocd json --targets` is the machine interface and is preferred: it carries
 * `svd_path`, which is the only cheap way to find the register map for a part.
 * `pyocd list --targets` is the fallback for older pyOCD, and its space-aligned
 * table has to be split on runs of spaces because a cell can contain one.
 */
export async function parsePyocdTargetsOutput(output: string): Promise<Target[]> {
  const text = output.trim();
  if (text.startsWith("{")) {
    try {
      const parsed = JSON.parse(text) as {
        targets?: { name?: string; vendor?: string; part_number?: string; part_families?: string[]; source?: string; svd_path?: string }[];
      };
      return (parsed.targets ?? [])
        .filter((entry) => entry.name)
        .map((entry) => ({
          name: String(entry.name),
          vendor: String(entry.vendor ?? ""),
          ...(entry.part_number && entry.part_number !== entry.name ? { part: entry.part_number } : {}),
          ...(entry.part_families?.length ? { families: entry.part_families } : {}),
          source: "pyocd" as const,
          ...(entry.source ? { packSource: entry.source } : {}),
          ...(entry.svd_path ? { svdPath: entry.svd_path } : {}),
        }));
    } catch {
      /* fall through to the table parser */
    }
  }
  return parsePyocdTargets(text);
}

export function parsePyocdTargets(output: string): Target[] {
  const SOURCES = new Set(["builtin", "pack", "cbuild-run"]);
  const targets: Target[] = [];
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || /^-+$/.test(line.replace(/\s+/g, ""))) continue;
    if (/^Name\s+Vendor/i.test(line)) continue;
    const cells = line.split(/\s{2,}/).map((cell) => cell.trim()).filter(Boolean);
    if (cells.length < 2) continue;

    const source = cells.length > 2 && SOURCES.has(cells[cells.length - 1]) ? cells.pop() ?? undefined : undefined;
    const [name, vendor, ...rest] = cells;
    if (!name || !vendor) continue;
    const [part, ...familyCells] = rest;

    targets.push({
      name,
      vendor,
      ...(part && part !== name ? { part } : {}),
      ...(familyCells.length ? { families: familyCells } : {}),
      source: "pyocd",
      ...(source ? { packSource: source } : {}),
    });
  }
  return targets;
}

/**
 * Targets this machine could flash.
 *
 * pyOCD is the only tool here that publishes its whole target list cheaply
 * (Zephyr needs a west workspace, PlatformIO needs a project). When the agent
 * needs a name for a chip, this is the table to search.
 */
/**
 * Extra target sources, so "no pyOCD installed" does not mean no target table.
 *
 * Each ecosystem already ships a machine-readable list, and the projects this
 * agent is pointed at are usually one of those three. pyOCD stays first
 * because its table is the most detailed, but the others are enough to pick a
 * chip name and they are the only option on a machine without Python tooling.
 */
export interface ExtraTargetSources {
  west?: string;
  pio?: string;
  arduino?: string;
  probeRs?: string;
}

async function targetsFromEcosystems(
  available: Partial<Record<ProbeKind, string>>,
  sources: ExtraTargetSources,
): Promise<{ targets: Target[]; notes: string[] }> {
  const targets: Target[] = [];
  const notes: string[] = [];
  const jobs: Promise<void>[] = [];

  if (sources.pio) {
    jobs.push(
      (async () => {
        const result = await run(sources.pio!, ["boards", "--json-output"], 40_000);
        if (!result.ok) return;
        try {
          const boards = JSON.parse(result.out) as { id?: string; name?: string; platform?: string; mcu?: string }[];
          for (const board of boards) {
            if (!board.id) continue;
            targets.push({
              name: board.mcu ?? board.id,
              vendor: board.platform ?? "platformio",
              source: "pyocd",
              ...(board.id ? { part: board.id } : {}),
            });
          }
          notes.push(`platformio: ${boards.length} boards`);
        } catch {
          notes.push("platformio: board list was not valid JSON");
        }
      })(),
    );
  }

  if (sources.arduino) {
    jobs.push(
      (async () => {
        const result = await run(sources.arduino!, ["board", "listall", "--format", "json"], 40_000);
        if (!result.ok) return;
        try {
          const boards = JSON.parse(result.out) as { boards?: { name?: string; fqbn?: string }[] };
          for (const board of boards.boards ?? []) {
            if (!board.name) continue;
            targets.push({ name: board.name, vendor: "arduino", source: "pyocd", ...(board.fqbn ? { part: board.fqbn } : {}) });
          }
          notes.push(`arduino: ${(boards.boards ?? []).length} boards`);
        } catch {
          notes.push("arduino: board list was not valid JSON");
        }
      })(),
    );
  }

  if (sources.west) {
    jobs.push(
      (async () => {
        const result = await run(sources.west!, ["boards"], 40_000);
        if (!result.ok) return;
        // `west boards` prints a table; the first column is the board name.
        const lines = result.out.split(/\r?\n/).filter((line) => line.trim() && !/^\s*-+\s*$/.test(line));
        let count = 0;
        for (const line of lines) {
          const name = line.trim().split(/\s+/)[0];
          if (!name || /^board$/i.test(name) || /^-/.test(name)) continue;
          targets.push({ name, vendor: "zephyr", source: "pyocd" });
          count++;
        }
        notes.push(`zephyr: ${count} boards`);
      })(),
    );
  }

  if (sources.probeRs) {
    jobs.push(
      (async () => {
        const result = await run(sources.probeRs!, ["chip", "list"], 40_000);
        if (!result.ok) return;
        let count = 0;
        for (const line of result.out.split(/\r?\n/)) {
          const name = line.trim().split(/\s+/)[0];
          if (!name || /^chip$/i.test(name)) continue;
          targets.push({ name, vendor: "probe-rs", source: "probe-rs" });
          count++;
        }
        notes.push(`probe-rs: ${count} chips`);
      })(),
    );
  }

  await Promise.all(jobs);
  return { targets, notes };
}

export async function listTargets(
  available: Partial<Record<ProbeKind, string>>,
  options: { filter?: string; limit?: number } = {},
  extra: ExtraTargetSources = {},
): Promise<TargetResult> {
  if (!available.pyocd) {
    // Without pyOCD, fall back to whatever ecosystem CLI is present. A machine
    // that builds Zephyr or PlatformIO already has a target list.
    const fallback = await targetsFromEcosystems(available, extra);
    const filter = options.filter?.toLowerCase();
    const filtered = filter
      ? fallback.targets.filter(
          (target) => target.name.toLowerCase().includes(filter) || target.vendor.toLowerCase().includes(filter),
        )
      : fallback.targets;
    if (filtered.length === 0) {
      return {
        targets: [],
        notes: ["pyocd: not installed, and no other target list was available", ...fallback.notes],
        total: 0,
      };
    }
    const limit = options.limit ?? 0;
    return {
      targets: limit > 0 ? filtered.slice(0, limit) : filtered,
      notes: [...fallback.notes, filter ? `${filtered.length} match "${options.filter}"` : `${filtered.length} targets`],
      total: fallback.targets.length,
    };
  }
  // The JSON subcommand is the machine interface; `list --targets -H` is the
  // fallback for pyOCD versions that predate it.
  let result = await run(available.pyocd, ["json", "--targets"], 40_000);
  let fromJson = true;
  if (!result.ok || !result.out.trim().startsWith("{")) {
    result = await run(available.pyocd, ["list", "--targets", "-H"], 40_000);
    fromJson = false;
  }
  const text = result.out || result.err;
  if (!result.ok && !text) {
    return { targets: [], notes: ["pyocd: listing targets failed"], total: 0 };
  }
  let targets = await parsePyocdTargetsOutput(text);
  const total = targets.length;

  const filter = options.filter?.toLowerCase();
  if (filter) {
    targets = targets.filter(
      (target) =>
        target.name.toLowerCase().includes(filter) ||
        target.vendor.toLowerCase().includes(filter) ||
        (target.part ?? "").toLowerCase().includes(filter) ||
        (target.families ?? []).some((family) => family.toLowerCase().includes(filter)),
    );
  }

  const limit = options.limit ?? 0;
  const notes: string[] = [
    filter ? `pyocd${fromJson ? " (json)" : ""}: ${targets.length} of ${total} targets match "${options.filter}"` : `pyocd: ${total} targets`,
  ];
  if (limit > 0 && targets.length > limit) {
    targets = targets.slice(0, limit);
    notes.push(`showing the first ${limit}`);
  }
  return { targets, notes, total };
}

/**
 * Match a part number or board name to a pyOCD target.
 *
 * Users say `stm32f411` or `NUCLEO-F411RE`; pyOCD wants `stm32f411re`. An
 * exact match wins, then a case-insensitive exact, then a single prefix
 * match. Ambiguity is reported rather than guessed at, because flashing the
 * wrong part numbers is how boards get bricked.
 */
export function matchTarget(targets: Target[], query: string): { target?: Target; candidates: Target[] } {
  const needle = query.trim().toLowerCase();
  if (!needle) return { candidates: [] };

  const exact = targets.find((target) => target.name === query.trim());
  if (exact) return { target: exact, candidates: [exact] };

  const lower = targets.filter((target) => target.name.toLowerCase() === needle);
  if (lower.length === 1) return { target: lower[0], candidates: lower };

  const prefixed = targets.filter(
    (target) =>
      target.name.toLowerCase().startsWith(needle) ||
      (target.part ?? "").toLowerCase().startsWith(needle) ||
      target.name.toLowerCase().replace(/[^a-z0-9]/g, "").includes(needle.replace(/[^a-z0-9]/g, "")),
  );
  if (prefixed.length === 1) return { target: prefixed[0], candidates: prefixed };
  return { candidates: prefixed.slice(0, 20) };
}
