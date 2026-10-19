/**
 * Turning a byte stream into log lines.
 *
 * The serial port hands over raw chunks with no regard for line boundaries: a
 * chunk can end mid-line, contain three lines, or be a fragment of one. The
 * monitor needs whole lines, and it needs them in bounded batches — a firmware
 * that floods the UART must not turn into one stdout write per byte.
 *
 * So this module owns two things and nothing else:
 *
 *   1. Split a chunk stream into lines, parsed by `parseLine`.
 *   2. Hand them over in bounded batches with an explicit drop count, so a
 *      consumer that falls behind loses the oldest lines and *knows* it did.
 *
 * It holds no timer and spawns nothing, which is what makes it testable. The
 * host owns the flush interval.
 */

import { parseLine, type LogLevel } from "./serial.ts";

export interface SerialLine {
  /** Host wall-clock milliseconds; `parseLine`'s `t` is device time and may be absent. */
  at: number;
  /** Device-reported milliseconds, when the log format has a timestamp. */
  t?: number;
  level?: LogLevel;
  tag?: string;
  text: string;
  raw: string;
}

export interface SerialLineBufferOptions {
  /** Lines kept for re-render and export. Oldest are dropped past this. */
  maxLines?: number;
  /** Lines allowed to queue between drains. Oldest are dropped past this. */
  maxPending?: number;
  /** A partial line longer than this is cut, so a firmware that never prints a newline cannot grow memory. */
  maxPartial?: number;
}

export const DEFAULT_MAX_LINES = 4000;
export const DEFAULT_MAX_PENDING = 4000;
export const DEFAULT_MAX_PARTIAL = 64 * 1024;

export class SerialLineBuffer {
  private readonly maxLines: number;
  private readonly maxPending: number;
  private readonly maxPartial: number;

  /** Everything retained, for re-render and export. */
  private lines: SerialLine[] = [];
  /** Lines produced but not yet drained. */
  private pending: SerialLine[] = [];
  /** Bytes of a line whose newline has not arrived yet. */
  private partial = "";
  /** Lines lost to the ring and the pending cap since the last drain. */
  private dropped = 0;

  constructor(options: SerialLineBufferOptions = {}) {
    this.maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
    this.maxPending = options.maxPending ?? DEFAULT_MAX_PENDING;
    this.maxPartial = options.maxPartial ?? DEFAULT_MAX_PARTIAL;
  }

  /** Feed raw device bytes. No parsing happens here beyond line splitting. */
  push(chunk: string): void {
    if (!chunk) return;
    this.partial += chunk;
    let index = this.partial.indexOf("\n");
    while (index >= 0) {
      const raw = this.partial.slice(0, index).replace(/\r$/, "");
      this.partial = this.partial.slice(index + 1);
      this.append(raw);
      index = this.partial.indexOf("\n");
    }
    // A line that never terminates is still bounded.
    if (this.partial.length > this.maxPartial) {
      this.append(this.partial.slice(0, this.maxPartial));
      this.partial = "";
    }
  }

  private append(raw: string): void {
    const parsed = parseLine(raw);
    const line: SerialLine = {
      at: Date.now(),
      ...(parsed.t !== undefined ? { t: parsed.t } : {}),
      ...(parsed.level ? { level: parsed.level } : {}),
      ...(parsed.tag ? { tag: parsed.tag } : {}),
      text: parsed.text,
      raw: parsed.raw,
    };
    this.lines.push(line);
    this.pending.push(line);
    if (this.lines.length > this.maxLines) {
      this.lines.splice(0, this.lines.length - this.maxLines);
      // Losing a line the ring still needed is not a drop — the ring is a
      // bounded window by design. Only lines that never reached the consumer
      // count, which is what the pending cap below measures.
    }
    if (this.pending.length > this.maxPending) {
      const excess = this.pending.length - this.maxPending;
      this.pending.splice(0, excess);
      this.dropped += excess;
    }
  }

  /**
   * Take up to `max` queued lines. The caller flushes on a timer and calls
   * again while `remaining > 0`, so one flood becomes several bounded
   * messages instead of one enormous one.
   */
  drain(max = 300): { lines: SerialLine[]; dropped: number; remaining: number } {
    const lines = this.pending.slice(0, max);
    this.pending = this.pending.slice(lines.length);
    const dropped = this.dropped;
    this.dropped = 0;
    return { lines, dropped, remaining: this.pending.length };
  }

  /** The retained window, oldest first. For re-render and export. */
  peek(): SerialLine[] {
    return [...this.lines];
  }

  /** How many lines are waiting for the next drain. */
  get queued(): number {
    return this.pending.length;
  }

  /** Drop everything, including the partial line. */
  clear(): void {
    this.lines = [];
    this.pending = [];
    this.partial = "";
    this.dropped = 0;
  }

  /**
   * Flush a trailing partial line.
   *
   * Only for a deliberate stop: a device that prints a prompt with no newline
   * should show it once the port is closed, but doing this mid-stream would
   * split one line into two every time the reader paused.
   */
  flushPartial(): void {
    if (!this.partial) return;
    this.append(this.partial);
    this.partial = "";
  }
}
