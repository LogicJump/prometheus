/**
 * Waveforms: turning what an instrument captured into edges with a time on
 * each one.
 *
 * The important decision here is that this module does not parse any vendor's
 * binary format. There are a hundred of them (sigrok's `.sr`, Saleae's
 * `.sal`, each scope's own), they change with every release, and a parser
 * written against a guessed layout produces a plausible-looking waveform that
 * is wrong — the worst possible outcome for a tool meant to explain a bug.
 *
 * What every instrument *can* produce is one of two things this module does
 * understand:
 *
 *   1. **VCD** — the Value Change Dump format defined by IEEE 1364. sigrok
 *      writes it (`sigrok-cli -O vcd`), Verilator writes it, Icarus writes it,
 *      every simulator writes it. It is plain text, fully specified, and the
 *      only sensible common denominator for digital capture.
 *   2. **Two columns of numbers** — time and voltage, which is what a scope
 *      or a DMM exports as CSV and what the SCPI driver in `instruments.ts`
 *      already returns. Digital signals are recovered from it by thresholding,
 *      which is exactly how a scope's own decoder does it.
 *
 * Edges, not pixels: a waveform is reported as "the line was high from
 * 1.234 ms to 1.290 ms", which is what a person reading a debugger wants and
 * what a UI can draw later without re-parsing anything.
 */

/* ---------- VCD ---------- */

export interface WaveChannel {
  /** The VCD identifier code, e.g. `!` or `%#`. Kept for cross-referencing. */
  id: string;
  name: string;
  /** How many distinct transitions were recorded. */
  edges: number;
  /** Value at the start of the capture. */
  initial: string;
  final: string;
  /** Edges, in capture time order. */
  transitions: { t: number; value: string }[];
}

export interface Waveform {
  /** `vcd`, `threshold`, or whatever produced it. */
  source: string;
  /** Timescale as written in the file, e.g. `1ns`; empty when the input had none. */
  timescale: string;
  /** Last timestamp seen, in timescale units. */
  duration: number;
  channels: WaveChannel[];
  notes: string[];
}

/**
 * Parse a VCD file.
 *
 * The format is a header of `$scope`/`$var`/`$timescale` sections followed by
 * a body of timestamp lines (`#123`) and value changes (`1!`, `b1010 #`). This
 * parser handles the parts that appear in real captures and records anything
 * it had to skip in `notes` rather than failing — a slightly malformed export
 * should still yield the channels that were readable.
 */
export function parseVcd(text: string): Waveform {
  const notes: string[] = [];
  const channels = new Map<string, WaveChannel>();
  let timescale = "";
  let time = 0;
  let duration = 0;
  let sawEnd = false;

  const lines = text.split(/\r?\n/);
  let index = 0;
  let scopeDepth = 0;
  const scopeNames: string[] = [];

  // Header. Directives may open and close on the same line (`$timescale 1ns
  // $end`) or span lines (`$timescale` / `1ns` / `$end`); both occur in real
  // exports, so a directive is accumulated until `$end` appears exactly once.
  /** Collect the tokens of a directive that starts on `lines[start]`. */
  const readDirective = (start: number): { text: string; next: number } => {
    const parts: string[] = [];
    let cursor = start;
    let text = lines[cursor].trim();
    // `$timescale 1ns $end` is complete on the first line.
    if (/\$end\b/.test(text)) {
      return { text: text.replace(/\$end\b/g, "").replace(/^\$\w+\s*/, "").trim(), next: cursor };
    }
    parts.push(text.replace(/^\$\w+\s*/, ""));
    while (cursor + 1 < lines.length) {
      cursor++;
      text = lines[cursor].trim();
      const closed = /\$end\b/.test(text);
      parts.push(text.replace(/\$end\b/g, "").trim());
      if (closed) break;
    }
    return { text: parts.join(" ").replace(/\s+/g, " ").trim(), next: cursor };
  };

  for (; index < lines.length; index++) {
    const line = lines[index].trim();
    if (!line) continue;
    if (line.startsWith("$timescale")) {
      const directive = readDirective(index);
      timescale = directive.text;
      index = directive.next;
      continue;
    }
    if (line.startsWith("$scope")) {
      // `$scope module top $end`. The name is the token after the scope type.
      const parts = line.replace(/\$end\b/g, "").trim().split(/\s+/).filter(Boolean);
      const name = parts.slice(2).join(" ");
      if (name) scopeNames.push(name);
      scopeDepth += 1;
      continue;
    }
    if (line.startsWith("$upscope")) {
      scopeDepth = Math.max(0, scopeDepth - 1);
      scopeNames.pop();
      continue;
    }
    if (line.startsWith("$var")) {
      // `$var wire 1 ! clk $end`: type, width, id, then the name. The id is
      // token 3 and the name is everything after it.
      const parts = line.replace(/\$end\b/g, "").trim().split(/\s+/).filter(Boolean);
      const id = parts[3];
      const name = parts.slice(4).join(" ");
      if (!id || !name) {
        notes.push(`unreadable $var line: ${line.slice(0, 80)}`);
        continue;
      }
      const qualified = [...scopeNames, name].filter(Boolean).join(".");
      if (!channels.has(id)) {
        channels.set(id, { id, name: qualified, edges: 0, initial: "", final: "", transitions: [] });
      }
      continue;
    }
    if (line.startsWith("$enddefinitions")) {
      // The body starts on the next line. `index` is advanced here because the
      // loop's own `index++` is what `break` skips.
      index++;
      break;
    }
    // Comments and other header directives are ignored on purpose.
  }

  // Body.
  for (; index < lines.length; index++) {
    const line = lines[index].trim();
    if (!line) continue;
    if (line.startsWith("$comment")) continue;
    if (line.startsWith("$dumpvars") || line === "$end") continue;
    if (line === "$finish" || line.startsWith("$finish")) {
      sawEnd = true;
      continue;
    }
    if (line.startsWith("#")) {
      const parsed = Number(line.slice(1));
      if (Number.isFinite(parsed)) {
        time = parsed;
        duration = Math.max(duration, time);
      } else {
        notes.push(`unreadable timestamp: ${line.slice(0, 40)}`);
      }
      continue;
    }
    // Value change lines: scalar (`1!`, `0"`, `x#`) or vector (`b1010 %`).
    const scalar = /^([01xzXZ])(\S+)$/.exec(line);
    if (scalar) {
      record(scalar[2], scalar[1]);
      continue;
    }
    const vector = /^[bB]([01xzXZ]+)\s+(\S+)$/.exec(line);
    if (vector) {
      record(vector[2], vector[1]);
      continue;
    }
    const real = /^[rR](\S+)\s+(\S+)$/.exec(line);
    if (real) {
      record(real[2], real[1]);
      continue;
    }
    // Anything else (system tasks, malformed lines) is noted once per shape.
    const shape = line.slice(0, 20);
    if (!notes.includes(`unreadable body line: ${shape}`)) notes.push(`unreadable body line: ${shape}`);
  }

  if (!sawEnd) notes.push("the file has no $finish; it may be truncated");

  function record(id: string, value: string): void {
    const channel = channels.get(id);
    if (!channel) {
      // A value change for a channel the header never declared: keep it so a
      // partial header does not silently drop data, and say so once.
      const note = `value change for undeclared id ${id}`;
      if (!notes.includes(note)) notes.push(note);
      channels.set(id, { id, name: `unknown(${id})`, edges: 1, initial: value, final: value, transitions: [{ t: time, value }] });
      return;
    }
    if (channel.transitions.length === 0) channel.initial = value;
    channel.final = value;
    channel.edges = channel.transitions.length + 1;
    channel.transitions.push({ t: time, value });
  }

  if (channels.size === 0) notes.push("no $var declarations were found; this is not a VCD file");

  return {
    source: "vcd",
    timescale,
    duration,
    channels: [...channels.values()].map((channel) => ({ ...channel, edges: channel.transitions.length })),
    notes,
  };
}

/* ---------- numeric capture → digital edges ---------- */

export interface NumericSample {
  /** Seconds since the start of the capture. */
  t: number;
  value: number;
}

export interface Edge {
  /** Seconds. */
  t: number;
  /** `rise`, `fall`, or a level for the first state. */
  edge: "rise" | "fall" | "start";
  /** The level after the edge. */
  level: 0 | 1;
}

export interface DigitalTrace {
  name: string;
  threshold: number;
  initial: 0 | 1;
  edges: Edge[];
  /** Fractions of the window spent high and low, for a duty cycle readout. */
  duty: number;
  notes: string[];
}

/**
 * Recover a digital signal from a voltage or current capture.
 *
 * The threshold is passed in rather than assumed: a 3.3 V logic line read on a
 * 5 V probe needs a different level than the same line on a 12 V rail, and
 * guessing 50% of the observed maximum fails exactly when the signal is stuck
 * (every sample equal → the threshold is meaningless). The caller can also let
 * the middle of the observed range be used, which is what a scope's auto
 * threshold does; that is `options.autoThreshold`.
 *
 * Hysteresis is deliberately absent: for a logic decode, a sample that sits
 * near the threshold is reported as noise in `notes` instead of being turned
 * into an edge the firmware never produced.
 */
export function digitize(
  samples: NumericSample[],
  options: { name?: string; threshold?: number; autoThreshold?: boolean; gapFactor?: number } = {},
): DigitalTrace {
  const name = options.name ?? "signal";
  const notes: string[] = [];
  const clean = samples.filter((sample) => Number.isFinite(sample.t) && Number.isFinite(sample.value)).sort((a, b) => a.t - b.t);
  if (clean.length === 0) {
    return { name, threshold: options.threshold ?? 0, initial: 0, edges: [], duty: 0, notes: ["no numeric samples were captured"] };
  }

  const values = clean.map((sample) => sample.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const threshold = options.threshold ?? (options.autoThreshold === false ? min : (min + max) / 2);
  if (max === min) notes.push(`the signal never moved (constant ${min}); no edges can be recovered`);

  // A sample within 5% of the threshold on either side is ambiguous: a real
  // logic line does not sit there, so it is counted and reported.
  const band = Math.max(1e-9, Math.abs(max - min) * 0.05);
  let ambiguous = 0;

  const edges: Edge[] = [];
  let level: 0 | 1 = clean[0].value >= threshold ? 1 : 0;
  edges.push({ t: clean[0].t, edge: "start", level });
  let highTime = 0;
  let last = clean[0];

  for (const sample of clean.slice(1)) {
    if (Math.abs(sample.value - threshold) <= band) ambiguous++;
    const next: 0 | 1 = sample.value >= threshold ? 1 : 0;
    if (level === 1) highTime += sample.t - last.t;
    if (next !== level) {
      edges.push({ t: sample.t, edge: next === 1 ? "rise" : "fall", level: next });
      level = next;
    }
    last = sample;
  }

  const span = clean[clean.length - 1].t - clean[0].t;
  if (ambiguous > 0) notes.push(`${ambiguous} sample(s) sat within 5% of the threshold; they may be noise rather than an edge`);
  // A capture that starts and ends at the same level but never crosses is a
  // flat line, and saying "0 edges" is more useful than a duty cycle of 0.
  if (edges.length === 1) notes.push("no transitions were found in the capture window");

  return {
    name,
    threshold,
    initial: edges[0].level,
    edges,
    duty: span > 0 ? Math.min(1, Math.max(0, highTime / span)) : 0,
    notes,
  };
}

/* ---------- formatting ---------- */

/** A human-readable summary of a VCD capture for a tool result. */
export function formatWaveform(waveform: Waveform, limit = 24): string {
  const lines: string[] = [];
  const unit = waveform.timescale || "ticks";
  lines.push(`VCD: ${waveform.channels.length} channel(s), ${waveform.duration} ${unit}${waveform.notes.length ? "" : ""}`);
  for (const channel of waveform.channels.slice(0, limit)) {
    const changes = channel.transitions.length;
    lines.push(`  ${channel.name.padEnd(24)} ${changes} transition(s), starts ${channel.initial}, ends ${channel.final}`);
    if (changes > 1 && changes <= 12) {
      lines.push(`    ${channel.transitions.map((entry) => `${entry.t}${unit}:${entry.value}`).join(" ")}`);
    }
  }
  if (waveform.channels.length > limit) lines.push(`  … ${waveform.channels.length - limit} more channel(s)`);
  for (const note of waveform.notes) lines.push(`  note: ${note}`);
  return lines.join("\n");
}

/** A human-readable summary of a digitized signal. */
export function formatDigitalTrace(trace: DigitalTrace, limit = 40): string {
  const lines: string[] = [
    `${trace.name}: threshold ${trace.threshold.toFixed(4)}, ${trace.edges.length} edge(s), ${(trace.duty * 100).toFixed(1)}% high`,
  ];
  for (const edge of trace.edges.slice(0, limit)) {
    lines.push(`  ${edge.t.toFixed(6)} s  ${edge.edge.padEnd(5)} → ${edge.level}`);
  }
  if (trace.edges.length > limit) lines.push(`  … ${trace.edges.length - limit} more edge(s)`);
  for (const note of trace.notes) lines.push(`  note: ${note}`);
  return lines.join("\n");
}
