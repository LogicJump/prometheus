/**
 * Drivers for the instruments the toolchain probe can find.
 *
 * `instruments.ts` holds the shape every measurement has and the SCPI text
 * protocol. This module is the layer below it: for each program a user may
 * have installed, what command to run, how to read its output, and what to say
 * when its output is not what the version we tested against produces.
 *
 * The rule that shapes all of it: **never report a number the instrument did
 * not produce.** A driver that cannot parse its program's output returns an
 * error naming the program and the first line of what it saw, not a zero. A
 * power reading of 0 mA is a real and alarming fact; a driver that guesses it
 * from a parse failure turns every broken install into "your board is asleep".
 *
 * Each driver is pure with respect to the process: it builds an argument list,
 * and parses a string. Running the program is the caller's job, which is what
 * makes every parser here testable without hardware.
 */

export interface DriverCommand {
  program: string;
  args: string[];
  /** How long the capture may run before the caller kills it. */
  timeoutMs: number;
  /** Set when this driver prints a waveform rather than scalars. */
  produces?: "samples" | "vcd";
}

export interface DriverResult {
  ok: boolean;
  /** Parsed samples, when the output had them. */
  samples?: { t: number; voltage?: number; current?: number }[];
  /** Raw VCD text, when the driver produces a waveform. */
  vcd?: string;
  /** Why it failed, in a sentence a user can act on. */
  error?: string;
  notes: string[];
}

export interface MeasureOptions {
  durationMs: number;
  rateHz?: number;
  /** Instrument address: serial port, VISA resource, or device path. */
  port?: string;
}

/* ---------- Joulescope ---------- */

/**
 * Joulescope's CLI is a CSV logger: `joulescope capture --duration N` writes
 * rows of `time,current,voltage,power`. The column order differs between the
 * JS110 and JS220 utilities, so the parser maps by header, not by position.
 */
export function joulescopeCommand(options: MeasureOptions): DriverCommand | null {
  const seconds = Math.max(0.1, options.durationMs / 1000);
  // The Python `joulescope` CLI takes `capture` with `--duration`; a device
  // selector exists but the default opens the only attached one.
  return {
    program: "joulescope",
    args: ["capture", "--duration", String(seconds), "--device", options.port ?? "auto"],
    timeoutMs: options.durationMs + 15_000,
    produces: "samples",
  };
}

/**
 * Parse Joulescope CSV.
 *
 * Header-driven on purpose: the columns are `time,current,voltage,power` on
 * one build and `time,voltage,current` on another, and a positional parser
 * silently swaps volts and amps — a plausible-looking measurement that is
 * nonsense. A file with no recognisable header is refused.
 */
export function parseJoulescopeCsv(text: string): DriverResult {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return { ok: false, error: "no output", notes: [] };
  const header = lines[0].toLowerCase();
  if (!header.includes("time")) {
    return { ok: false, error: `the first line is not a header: ${lines[0].slice(0, 120)}`, notes: [] };
  }
  const columns = header.split(",").map((part) => part.trim());
  const at = (name: string) => columns.findIndex((column) => column === name || column.startsWith(name));
  const timeAt = at("time");
  const currentAt = at("current");
  const voltageAt = at("voltage");
  if (timeAt < 0 || (currentAt < 0 && voltageAt < 0)) {
    return { ok: false, error: `the header names no time/current/voltage columns: ${lines[0].slice(0, 120)}`, notes: [] };
  }
  const samples: { t: number; voltage?: number; current?: number }[] = [];
  let skipped = 0;
  for (const line of lines.slice(1)) {
    const cells = line.split(",").map((cell) => Number(cell));
    const t = cells[timeAt];
    if (!Number.isFinite(t)) {
      skipped++;
      continue;
    }
    const voltage = voltageAt >= 0 ? cells[voltageAt] : undefined;
    const current = currentAt >= 0 ? cells[currentAt] : undefined;
    if (!Number.isFinite(voltage ?? 0) || !Number.isFinite(current ?? 0)) {
      skipped++;
      continue;
    }
    samples.push({ t, ...(voltage !== undefined ? { voltage } : {}), ...(current !== undefined ? { current } : {}) });
  }
  if (samples.length === 0) {
    return { ok: false, error: `every data row was malformed (${skipped} skipped)`, notes: [] };
  }
  return { ok: true, samples, notes: skipped ? [`${skipped} malformed row(s) were skipped`] : [] };
}

/* ---------- Nordic Power Profiler Kit II ---------- */

/**
 * PPK2's own tool is `ppk2` (or `nrfutil ppk2`); both export a CSV with
 * `timestamp_us` and `current_uA`, and a voltage column only when the source
 * meter mode was used.
 */
export function ppk2Command(options: MeasureOptions): DriverCommand | null {
  const ms = Math.max(100, options.durationMs);
  return {
    program: "ppk2",
    args: ["--duration", String(ms), "--json"],
    timeoutMs: ms + 15_000,
    produces: "samples",
  };
}

/**
 * Parse PPK2 output.
 *
 * `ppk2` prints JSON when asked (`{"samples":[{"t_us":..,"current_ua":..}]}`)
 * and CSV otherwise; both are accepted because which one a user has installed
 * is not something this build can know. Units are converted once, here:
 * microseconds to seconds and microamps to amps, so every caller downstream
 * sees the same units as SCPI.
 */
export function parsePpk2Output(text: string): DriverResult {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, error: "no output", notes: [] };
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      const rows = Array.isArray(parsed)
        ? parsed
        : typeof parsed === "object" && parsed !== null && Array.isArray((parsed as { samples?: unknown }).samples)
          ? ((parsed as { samples: unknown[] }).samples)
          : null;
      if (!rows) return { ok: false, error: "the JSON has no samples array", notes: [] };
      const samples: { t: number; current?: number }[] = [];
      let skipped = 0;
      for (const row of rows) {
        const entry = row as Record<string, unknown>;
        const tUs = Number(entry.t_us ?? entry.timestamp_us ?? entry.t);
        const currentUa = Number(entry.current_ua ?? entry.current);
        if (!Number.isFinite(tUs) || !Number.isFinite(currentUa)) {
          skipped++;
          continue;
        }
        samples.push({ t: tUs / 1e6, current: currentUa / 1e6 });
      }
      if (samples.length === 0) return { ok: false, error: "no usable sample in the JSON", notes: [] };
      return { ok: true, samples, notes: skipped ? [`${skipped} sample(s) had no time or current`] : [] };
    } catch (err) {
      return { ok: false, error: `the output is not valid JSON: ${(err as Error).message}`, notes: [] };
    }
  }
  const lines = trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const header = lines[0].toLowerCase();
  if (!header.includes("time")) return { ok: false, error: `unreadable first line: ${lines[0].slice(0, 120)}`, notes: [] };
  const columns = header.split(/[,\t]/).map((part) => part.trim());
  const timeAt = columns.findIndex((column) => column.includes("time"));
  const currentAt = columns.findIndex((column) => column.includes("current"));
  if (timeAt < 0 || currentAt < 0) return { ok: false, error: "the header names no time/current columns", notes: [] };
  const samples: { t: number; current?: number }[] = [];
  for (const line of lines.slice(1)) {
    const cells = line.split(/[,\t]/).map(Number);
    const t = cells[timeAt];
    const current = cells[currentAt];
    if (!Number.isFinite(t) || !Number.isFinite(current)) continue;
    // A PPK2 export uses microseconds; values in the 1e6 range are obvious.
    samples.push({ t: t > 1000 ? t / 1e6 : t, current: Math.abs(current) > 0.5 ? current / 1e6 : current });
  }
  if (samples.length === 0) return { ok: false, error: "no numeric rows", notes: [] };
  return { ok: true, samples, notes: [] };
}

/* ---------- sigrok (logic analyser) ---------- */

/**
 * sigrok's `sigrok-cli` is the one open capture front end that speaks to many
 * logic analysers and scopes. Its VCD output is the interchange format this
 * build understands (`waveform.ts`), so the driver's job is only to build the
 * right command and to say what to do when the device list is empty.
 */
export function sigrokCommand(options: MeasureOptions & { driver?: string; channels?: string }): DriverCommand | null {
  const seconds = Math.max(0.001, options.durationMs / 1000);
  // `--time` is seconds for sigrok-cli; `-O vcd` is the only output this build
  // parses, and asking for it explicitly avoids a config default.
  const args = ["--time", String(seconds), "-O", "vcd"];
  if (options.driver) args.push("-d", options.driver);
  if (options.channels) args.push("-C", options.channels);
  return { program: "sigrok-cli", args, timeoutMs: options.durationMs + 20_000, produces: "vcd" };
}

/** Wrap sigrok's VCD stdout as a driver result. */
export function sigrokResult(text: string): DriverResult {
  if (!/(\$var|#\d)/.test(text)) {
    const first = text.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "";
    return { ok: false, error: `sigrok-cli produced no VCD (${first.slice(0, 160) || "empty output"})`, notes: [] };
  }
  return { ok: true, vcd: text, notes: [] };
}

/* ---------- discovery ---------- */

export interface DriverInfo {
  /** The value `embed_measure` takes as `instrument`. */
  kind: string;
  /** Programs any of which being present makes this driver usable. */
  programs: string[];
  /** What it measures, for the "none installed" message. */
  detail: string;
  /** True when the device has to be named explicitly rather than auto-detected. */
  needsAddress?: boolean;
}

/**
 * Every driver this module actually implements.
 *
 * Kept separate from `INSTRUMENTS` because the two lists answer different
 * questions: `INSTRUMENTS` says which programs exist in the ecosystem,
 * `DRIVERS` says which ones this build can talk to. A tool that lists an
 * instrument it has no driver for is the bug this split prevents.
 */
export const DRIVERS: DriverInfo[] = [
  { kind: "pyvisa", programs: ["python", "python3"], detail: "SCPI bench instruments through pyvisa" },
  { kind: "joulescope", programs: ["joulescope"], detail: "Joulescope power measurement" },
  { kind: "ppk2", programs: ["ppk2", "nrfutil"], detail: "Nordic Power Profiler Kit II" },
  { kind: "sigrok", programs: ["sigrok-cli"], detail: "logic analysers and scopes, as VCD" },
];

/** The driver for a requested name, accepting the SCPI alias. */
export function driverFor(name: string | undefined): DriverInfo | undefined {
  if (!name) return undefined;
  const wanted = name === "scpi" ? "pyvisa" : name;
  return DRIVERS.find((driver) => driver.kind === wanted);
}
