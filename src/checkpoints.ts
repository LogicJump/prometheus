/**
 * Checkpoints: snapshot files before the agent mutates them so a session can be
 * rewound. Stored per session under ~/.prometheus/checkpoints/<session>/.
 *
 * Each checkpoint records the file's prior content (or its absence), the tool
 * that caused the change, and a timestamp. Restoring walks checkpoints newest
 * to oldest until the target point.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync, statSync } from "node:fs";
import { join, dirname, resolve, relative, isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import { CONFIG_HOME } from "./config.ts";

const ROOT = join(CONFIG_HOME, "checkpoints");

export interface CheckpointEntry {
  id: string;
  at: string;
  tool: string;
  path: string;
  /** Absolute path at capture time. */
  absPath: string;
  /** "created" means the file did not exist; "modified" keeps the prior content. */
  kind: "created" | "modified" | "deleted";
  /** Conversation length when this change ran; used to rewind by message. */
  messageIndex?: number;
  /** Relative blob file holding prior content, when kind === "modified" or "deleted". */
  blob?: string;
  bytes: number;
}

export interface CheckpointState {
  sessionId: string;
  entries: CheckpointEntry[];
}

function sessionDir(sessionId: string): string {
  return join(ROOT, sanitize(sessionId));
}

function sanitize(id: string): string {
  return id.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

function statePath(sessionId: string): string {
  return join(sessionDir(sessionId), "checkpoints.json");
}

export function loadCheckpoints(sessionId: string): CheckpointState {
  try {
    const file = statePath(sessionId);
    if (!existsSync(file)) return { sessionId, entries: [] };
    return JSON.parse(readFileSync(file, "utf8")) as CheckpointState;
  } catch {
    return { sessionId, entries: [] };
  }
}

function saveCheckpoints(state: CheckpointState): void {
  mkdirSync(sessionDir(state.sessionId), { recursive: true });
  writeFileSync(statePath(state.sessionId), JSON.stringify(state, null, 2), "utf8");
}

/** Capture a file's content before a tool mutates it. No-op for reads. */
export function captureBefore(
  sessionId: string,
  tool: string,
  cwd: string,
  inputPath: string,
  messageIndex?: number,
): CheckpointEntry | null {
  const absPath = isAbsolute(inputPath) ? resolve(inputPath) : resolve(cwd, inputPath);
  const existed = existsSync(absPath);
  let prior = "";
  if (existed) {
    try {
      const info = statSync(absPath);
      if (!info.isFile() || info.size > 2 * 1024 * 1024) return null;
      prior = readFileSync(absPath, "utf8");
    } catch {
      return null;
    }
  }

  const state = loadCheckpoints(sessionId);
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  let blob: string | undefined;
  if (existed) {
    const dir = sessionDir(sessionId);
    const blobDir = join(dir, "blobs");
    mkdirSync(blobDir, { recursive: true });
    blob = join("blobs", `${createHash("sha1").update(absPath).digest("hex").slice(0, 12)}-${id}.txt`);
    writeFileSync(join(dir, blob), prior, "utf8");
  }

  const entry: CheckpointEntry = {
    id,
    at: new Date().toISOString(),
    tool,
    path: relative(cwd, absPath).split("\\").join("/") || ".",
    absPath,
    kind: existed ? "modified" : "created",
    blob,
    bytes: Buffer.byteLength(prior, "utf8"),
    ...(Number.isFinite(messageIndex) ? { messageIndex } : {}),
  };
  state.entries.push(entry);
  // Keep the log bounded; old blobs are pruned with the entries.
  if (state.entries.length > 500) {
    for (const dropped of state.entries.splice(0, state.entries.length - 500)) dropBlob(sessionId, dropped);
  }
  saveCheckpoints(state);
  return entry;
}

function dropBlob(sessionId: string, entry: CheckpointEntry): void {
  if (!entry.blob) return;
  try {
    rmSync(join(sessionDir(sessionId), entry.blob), { force: true });
  } catch {
    /* best effort */
  }
}

/** Restore every file changed after (and including) `checkpointId`, newest first. */
export function restoreTo(sessionId: string, checkpointId: string | "start"): { restored: string[]; errors: string[] } {
  const state = loadCheckpoints(sessionId);
  const restored: string[] = [];
  const errors: string[] = [];

  if (state.entries.length === 0) return { restored, errors };

  let stopIndex = 0;
  if (checkpointId !== "start") {
    stopIndex = state.entries.findIndex((entry) => entry.id === checkpointId);
    if (stopIndex === -1) return { restored, errors: [`checkpoint not found: ${checkpointId}`] };
  }

  // Reverse iteration so the earliest prior state wins for repeated edits.
  for (let index = state.entries.length - 1; index >= stopIndex; index--) {
    const entry = state.entries[index];
    try {
      if (entry.kind === "created") {
        rmSync(entry.absPath, { force: true });
      } else if (entry.blob) {
        const dir = sessionDir(sessionId);
        const rel = relative(dir, join(dir, entry.blob));
        if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("invalid blob path");
        const content = readFileSync(join(dir, entry.blob), "utf8");
        mkdirSync(dirname(entry.absPath), { recursive: true });
        writeFileSync(entry.absPath, content, "utf8");
      }
      restored.push(entry.path);
    } catch (err) {
      errors.push(`${entry.path}: ${(err as Error).message}`);
    }
  }

  // Everything after the restore point is now applied; drop those entries.
  state.entries = state.entries.slice(0, stopIndex);
  saveCheckpoints(state);
  return { restored: [...new Set(restored)], errors };
}

/**
 * Rewind files to the state at a message index: every change recorded at or
 * after that point is undone, newest first, and pruned. Mirrors `restoreTo`,
 * which rewinds by checkpoint id.
 */
export function restoreAfterMessage(sessionId: string, messageIndex: number): { restored: string[]; errors: string[]; affected: number } {
  const state = loadCheckpoints(sessionId);
  const restored: string[] = [];
  const errors: string[] = [];
  const affected = state.entries.filter((entry) => entry.messageIndex !== undefined && entry.messageIndex >= messageIndex);
  if (affected.length === 0) return { restored, errors, affected: 0 };

  for (let index = state.entries.length - 1; index >= 0; index--) {
    const entry = state.entries[index];
    // Entries from before message indexes existed cannot be placed in time,
    // so they are never rolled back by this path.
    if (entry.messageIndex === undefined || entry.messageIndex < messageIndex) continue;
    try {
      if (entry.kind === "created") {
        rmSync(entry.absPath, { force: true });
      } else if (entry.blob) {
        const dir = sessionDir(sessionId);
        const rel = relative(dir, join(dir, entry.blob));
        if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("invalid blob path");
        const content = readFileSync(join(dir, entry.blob), "utf8");
        mkdirSync(dirname(entry.absPath), { recursive: true });
        writeFileSync(entry.absPath, content, "utf8");
      }
      restored.push(entry.path);
    } catch (err) {
      errors.push(`${entry.path}: ${(err as Error).message}`);
    }
  }

  state.entries = state.entries.filter((entry) => entry.messageIndex === undefined || entry.messageIndex < messageIndex);
  saveCheckpoints(state);
  return { restored: [...new Set(restored)], errors, affected: affected.length };
}

/** Discard a session's checkpoint history. */
export function clearCheckpoints(sessionId: string): void {
  rmSync(sessionDir(sessionId), { recursive: true, force: true });
}

export function listCheckpointSessions(): string[] {
  if (!existsSync(ROOT)) return [];
  return readdirSync(ROOT).filter((name) => existsSync(join(ROOT, name, "checkpoints.json")));
}
