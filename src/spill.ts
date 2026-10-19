/**
 * Full tool output on disk, with a path the model can read back.
 *
 * A truncated tool result is lossy in a way the model cannot notice: it sees
 * "(120000 characters omitted)" and has no way to ask for the rest, so its
 * only option is to run the command again. The desktop host has always had a
 * place to put a session's files (`~/.prometheus/sessions/<id>/`), so a large
 * result is written there and the tool message names the file.
 *
 * The write is best-effort. A read-only home directory, a full disk, or a
 * session with no id must never fail a tool that already did its work.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SESSIONS_DIR } from "./config.ts";
import type { ToolResult } from "./types.ts";

/** Results longer than this are spilled in full. */
export const SPILL_THRESHOLD = 30_000;

let counter = 0;

/**
 * Keep the whole result on disk and return the path, or null when there is
 * nowhere sensible to put it.
 *
 * `sessionId` is the directory name under the sessions root. The one-shot CLI
 * passes the id it is about to save under, so the path in the transcript is
 * still resolvable after the run.
 */
export function spillToolOutput(sessionId: string, toolName: string, content: string): string | null {
  if (!sessionId) return null;
  if (content.length <= SPILL_THRESHOLD) return null;
  try {
    const dir = join(SESSIONS_DIR, sessionId, "tool-results");
    mkdirSync(dir, { recursive: true });
    const safeName = toolName.replace(/[^\w.-]+/g, "_").slice(0, 40) || "tool";
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "");
    const file = join(dir, `${stamp}-${String(++counter).padStart(3, "0")}-${safeName}.txt`);
    writeFileSync(file, content, "utf8");
    return file;
  } catch {
    return null;
  }
}

/**
 * Add a pointer to the full output when the content was cut.
 *
 * Called by the pipeline for tools that asked for it (`persistOutput`) and for
 * bash, which keeps a capped buffer. The pointer is one line so it survives a
 * second truncation at the front of the message.
 */
export function withSpillPointer(tool: ToolResult, sessionId: string, toolName: string, full: string): ToolResult {
  if (full.length <= SPILL_THRESHOLD) return tool;
  const path = spillToolOutput(sessionId, toolName, full);
  if (!path) return tool;
  return { ...tool, content: `${tool.content}\n\n[full output: ${path}]` };
}
