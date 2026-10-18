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
  if (cause?.code && NETWORK_CODES.has(cause.code)) {
    return {
      level: "recoverable",
      message: cause.message ?? cause.code,
      status: 0,
      retryAfterMs: backoff(attempt),
      cause: error,
    };
  }
  // A fetch timeout surfaces as a DOMException named TimeoutError.
  if (cause?.name === "TimeoutError") {
    return { level: "recoverable", message: cause.message ?? "request timed out", status: 0, retryAfterMs: backoff(attempt), cause: error };
  }
  return { level: "terminal", message: cause?.message ?? String(error), status: 0, retryAfterMs: 0, cause: error };
}

function backoff(attempt: number): number {
  return Math.min(15_000, 800 * 2 ** Math.max(0, attempt - 1));
}
