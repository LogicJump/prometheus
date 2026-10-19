/**
 * Two-level error classification for the agent loop.
 *
 * Every failure that reaches the loop is classified once:
 *
 *   recoverable  transient (rate limit, network blip, 5xx, timeout) - the loop
 *                keeps the error, backs off, and continues the same turn.
 *   terminal     the request cannot succeed as-is (auth, bad request, missing
 *                config, abort) - the turn stops and the error is reported.
 *
 * Tool errors are neither: they are handed back to the model as tool output so
 * it can adapt, which is the loop's normal continuation path.
 */

import { ApiError } from "./llm.ts";

export type ErrorLevel = "recoverable" | "terminal";

export interface ClassifiedError {
  level: ErrorLevel;
  message: string;
  status: number;
  /** Milliseconds to wait before the next attempt; 0 when no retry applies. */
  retryAfterMs: number;
  /** The original error, kept so callers can inspect it (e.g. AbortError). */
  cause: unknown;
}

const NETWORK_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "UND_ERR_SOCKET"]);

/**
 * Network failures nest their code one level down: undici throws
 * `TypeError("terminated")` with `cause.code === "UND_ERR_SOCKET"`, and fetch
 * wraps connect errors the same way. Reading only the top level sent every
 * dropped connection down the terminal path, so the loop never retried a blip.
 */
function networkCode(error: unknown): string | undefined {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const candidate = current as { code?: unknown; cause?: unknown };
    if (typeof candidate.code === "string") return candidate.code;
    current = candidate.cause;
  }
  return undefined;
}

export function classifyError(error: unknown, attempt = 1): ClassifiedError {
  if (error instanceof ApiError) {
    const level: ErrorLevel = error.retryable ? "recoverable" : "terminal";
    return {
      level,
      message: error.message,
      status: error.status,
      retryAfterMs: level === "recoverable" ? backoff(attempt) : 0,
      cause: error,
    };
  }

  const cause = error as { name?: string; code?: string; message?: string } | undefined;
  if (cause?.name === "AbortError") {
    return { level: "terminal", message: "aborted", status: 0, retryAfterMs: 0, cause: error };
  }
  const code = networkCode(error);
  if (code && NETWORK_CODES.has(code)) {
    return {
      level: "recoverable",
      message: cause?.message ?? code,
      status: 0,
      retryAfterMs: backoff(attempt),
      cause: error,
    };
  }
  // A fetch timeout surfaces as a DOMException named TimeoutError. Our own
  // timeout aborts with a plain Error that says "timed out"; either one is a
  // transient condition, not a reason to end the conversation.
  if (cause?.name === "TimeoutError" || /\btimed out\b/i.test(cause?.message ?? "")) {
    return { level: "recoverable", message: cause?.message ?? "request timed out", status: 0, retryAfterMs: backoff(attempt), cause: error };
  }
  return { level: "terminal", message: cause?.message ?? String(error), status: 0, retryAfterMs: 0, cause: error };
}

function backoff(attempt: number): number {
  return Math.min(15_000, 800 * 2 ** Math.max(0, attempt - 1));
}
