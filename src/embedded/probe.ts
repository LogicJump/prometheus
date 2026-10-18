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
    execFile(program, args, { timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
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
    // `  0   STLink V2  0673FF...   STM32F411RETx   ...`
    const cells = line.split(/\s{2,}/).map((cell) => cell.trim()).filter(Boolean);
    if (cells.length < 2) continue;
    // The first cell is an index when it is a bare integer.
    const body = /^\d+$/.test(cells[0]) ? cells.slice(1) : cells;
    if (body.length < 1) continue;
    const probe: Probe = { kind: "pyocd", name: body[0] };
    // A serial is a long hex/uppercase token; a target is the last cell.
    for (const cell of body.slice(1)) {
      if (!probe.serial && /^[0-9A-F]{8,}$/i.test(cell.replace(/[^0-9A-Za-z]/g, ""))) probe.serial = cell;
      else if (!probe.target) probe.target = cell;
    }
    probes.push(probe);
  }
  return probes;
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
export async function listTargets(
  available: Partial<Record<ProbeKind, string>>,
  options: { filter?: string; limit?: number } = {},
): Promise<TargetResult> {
  if (!available.pyocd) {
    return { targets: [], notes: ["pyocd: not installed, no target table available"], total: 0 };
  }
  const result = await run(available.pyocd, ["list", "--targets", "-H"], 40000);
  const text = result.out || result.err;
  if (!result.ok && !text) {
    return { targets: [], notes: ["pyocd: listing targets failed"], total: 0 };
  }
  let targets = parsePyocdTargets(text);
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
    filter ? `pyocd: ${targets.length} of ${total} targets match "${options.filter}"` : `pyocd: ${total} targets`,
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
