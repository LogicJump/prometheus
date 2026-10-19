/**
 * A record of what was flashed, when, and from which image.
 *
 * The question that comes up during a regression is "what was on the board the
 * last time this worked", and neither the transcript nor the git log answers
 * it: the firmware was built, copied and flashed in some order across two
 * sessions. One append-only line per flash answers it.
 *
 * The log lives beside the session (`sessions/<id>/flashes.jsonl`) rather than
 * in one global file, so a workspace's history travels with the conversation
 * that produced it and a deleted session takes its history with it.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SESSIONS_DIR } from "../config.ts";
import type { FlashResult } from "./flash.ts";

export interface FlashRecord {
  at: string;
  firmware: string;
  /** First 12 hex chars of the firmware's sha256, or null when unreadable. */
  hash: string | null;
  target?: string;
  flasher: string;
  ok: boolean;
  verified?: boolean;
  durationMs: number;
  command: string;
}

/** The log path for a session, or null when there is no session to attach to. */
export function flashLogPath(sessionId: string): string | null {
  if (!sessionId) return null;
  return join(SESSIONS_DIR, sessionId, "flashes.jsonl");
}

/** sha256 of a file, truncated for display; null when the file cannot be read. */
export function firmwareHash(path: string): string | null {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex").slice(0, 12);
  } catch {
    return null;
  }
}

/**
 * Append one flash to the log.
 *
 * Best-effort like the rest of the session files: a read-only home directory
 * must not turn a successful flash into a failure.
 */
export function recordFlash(
  sessionId: string,
  result: FlashResult,
  info: { firmware: string; target?: string; flasher: string },
): FlashRecord | null {
  const path = flashLogPath(sessionId);
  if (!path) return null;
  const record: FlashRecord = {
    at: new Date().toISOString(),
    firmware: info.firmware,
    hash: firmwareHash(info.firmware),
    ...(info.target ? { target: info.target } : {}),
    flasher: info.flasher,
    ok: result.ok,
    ...(result.verified !== undefined ? { verified: result.verified } : {}),
    durationMs: result.durationMs,
    command: result.command,
  };
  try {
    mkdirSync(join(SESSIONS_DIR, sessionId), { recursive: true });
    appendFileSync(path, `${JSON.stringify(record)}\n`, "utf8");
    return record;
  } catch {
    return null;
  }
}

/** The recorded flashes for a session, oldest first. */
export function readFlashHistory(sessionId: string): FlashRecord[] {
  const path = flashLogPath(sessionId);
  if (!path) return [];
  try {
    return readFileSync(path, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as FlashRecord;
        } catch {
          return null;
        }
      })
      .filter((record): record is FlashRecord => record !== null);
  } catch {
    return [];
  }
}

/** One line per flash, newest last, for a tool result or a panel. */
export function formatFlashHistory(records: FlashRecord[], limit = 10): string {
  if (records.length === 0) return "No flashes have been recorded for this session.";
  return records
    .slice(-limit)
    .map((record) => {
      const when = record.at.replace("T", " ").replace(/\..*/, "");
      const verified = record.verified === undefined ? "" : record.verified ? " verified" : " unverified";
      return `${when}  ${record.ok ? "ok  " : "fail"}${verified}  ${record.hash ?? "no-hash"}  ${record.flasher}  ${record.firmware}`;
    })
    .join("\n");
}
