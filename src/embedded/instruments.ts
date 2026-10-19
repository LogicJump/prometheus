/**
 * Measurement instruments, behind one interface.
 *
 * Power is the number that decides whether a firmware is viable on a battery,
 * and it is the one an agent cannot read from a log. Every instrument in this
 * space — SCPI over USB, Joulescope, Nordic's PPK2, a sigrok-compatible logic
 * analyser — answers the same three questions: what is the voltage, what is
 * the current, and over what window. The interface below is that common
 * shape; each driver translates its own protocol into it.
 *
 * Nothing here assumes one vendor. A driver that is not installed reports
 * itself as unavailable rather than pretending to sample.
 */

export interface Sample {
  /** Seconds since the start of the capture. */
  t: number;
  voltage?: number;
  current?: number;
}

export interface Measurement {
  /** Instrument that produced it. */
  instrument: string;
  samples: Sample[];
  /** Mean values over the window, computed once so every caller agrees. */
  mean?: { voltage?: number; current?: number; power?: number };
  /** Peak current, which is what a sleep-mode bug shows up as. */
  peakCurrent?: number;
  /** Charge used over the window, in coulombs. */
  charge?: number;
  /** Why the capture stopped, when it was not the requested duration. */
  note?: string;
}

export interface MeasurementRequest {
  /** How long to capture. */
  durationMs: number;
  /** Samples per second, when the instrument lets it be chosen. */
  rateHz?: number;
  /** Stop early when the current crosses this (a wake-up, a peak). */
  aboveCurrent?: number;
}

/** What a driver can do, so a tool can say what is missing. */
export interface InstrumentInfo {
  kind: string;
  available: boolean;
  detail: string;
}

/**
 * SCPI: the standard command language for bench instruments.
 *
 * `MEAS:VOLT?` and `MEAS:CURR?` are the two questions every bench supply and
 * DMM answers. A serial or VISA transport both work; this adapter is written
 * against the text protocol so it is testable without hardware.
 */
export function scpiCommands(request: MeasurementRequest): string[] {
  // The first command puts the instrument in a known state; the rest are the
  // per-sample reads.
  const rate = request.rateHz ?? 10;
  return ["*RST", "CONF:VOLT:DC", "CONF:CURR:DC", `SAMP:COUN ${Math.max(1, Math.round((request.durationMs / 1000) * rate))}`];
}

/**
 * Parse a newline-separated SCPI response into samples.
 *
 * Instruments answer `MEAS:VOLT?` with something like `3.300E+00`; a paired
 * read returns two lines. A value that does not parse is skipped rather than
 * recorded as zero, because a zero volt reading means a real thing.
 */
export function parseScpi(text: string, options: { voltage?: boolean } = {}): Sample[] {
  const values = text
    .split(/[\r\n,;]+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => Number(part))
    .filter((value) => Number.isFinite(value));
  return values.map((value, index) => ({
    t: index,
    ...(options.voltage === false ? { current: value } : { voltage: value }),
  }));
}

/** Compute the summary fields from samples; shared by every driver. */
export function summarizeSamples(instrument: string, samples: Sample[]): Measurement {
  if (samples.length === 0) return { instrument, samples, note: "no samples were returned" };
  const voltages = samples.map((sample) => sample.voltage).filter((value): value is number => value !== undefined);
  const currents = samples.map((sample) => sample.current).filter((value): value is number => value !== undefined);
  const meanVoltage = voltages.length ? voltages.reduce((sum, value) => sum + value, 0) / voltages.length : undefined;
  const meanCurrent = currents.length ? currents.reduce((sum, value) => sum + value, 0) / currents.length : undefined;
  const span = samples[samples.length - 1].t - samples[0].t;
  return {
    instrument,
    samples,
    ...(meanVoltage !== undefined || meanCurrent !== undefined
      ? {
          mean: {
            ...(meanVoltage !== undefined ? { voltage: meanVoltage } : {}),
            ...(meanCurrent !== undefined ? { current: meanCurrent } : {}),
            ...(meanVoltage !== undefined && meanCurrent !== undefined
              ? { power: meanVoltage * meanCurrent }
              : {}),
          },
        }
      : {}),
    ...(currents.length ? { peakCurrent: Math.max(...currents) } : {}),
    // Charge is the integral of current over time; with evenly spaced samples
    // the mean times the span is exact enough for a battery estimate.
    ...(meanCurrent !== undefined && span > 0 ? { charge: meanCurrent * span } : {}),
  };
}

/** Format a measurement for a tool result. */
export function formatMeasurement(measurement: Measurement): string {
  if (measurement.samples.length === 0) {
    return `${measurement.instrument}: no samples${measurement.note ? ` (${measurement.note})` : ""}`;
  }
  const lines = [`${measurement.instrument}: ${measurement.samples.length} samples over ${(measurement.samples[measurement.samples.length - 1].t - measurement.samples[0].t).toFixed(2)} s`];
  if (measurement.mean?.voltage !== undefined) lines.push(`  mean voltage: ${measurement.mean.voltage.toFixed(3)} V`);
  if (measurement.mean?.current !== undefined) lines.push(`  mean current: ${(measurement.mean.current * 1000).toFixed(3)} mA`);
  if (measurement.mean?.power !== undefined) lines.push(`  mean power: ${(measurement.mean.power * 1000).toFixed(3)} mW`);
  if (measurement.peakCurrent !== undefined) lines.push(`  peak current: ${(measurement.peakCurrent * 1000).toFixed(3)} mA`);
  if (measurement.charge !== undefined) lines.push(`  charge: ${(measurement.charge * 1000).toFixed(3)} mC`);
  if (measurement.note) lines.push(`  note: ${measurement.note}`);
  return lines.join("\n");
}

/**
 * Which instruments are present.
 *
 * Probed by executable name, not by opening the device: opening a serial
 * instrument to see whether it exists is how a tool ends up stealing a port
 * from the user.
 */
export const INSTRUMENTS: { kind: string; programs: string[]; detail: string }[] = [
  { kind: "uhubctl", programs: ["uhubctl"], detail: "USB hub port power switching" },
  { kind: "sigrok-cli", programs: ["sigrok-cli"], detail: "logic analyser capture" },
  { kind: "pyvisa", programs: ["python", "python3"], detail: "SCPI instruments through VISA" },
  { kind: "joulescope", programs: ["joulescope"], detail: "Joulescope power measurement" },
  { kind: "ppk2", programs: ["ppk2"], detail: "Nordic Power Profiler Kit II" },
];
