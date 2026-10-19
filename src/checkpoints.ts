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

  // Snapshot what is about to be replaced, so the undo itself can be undone.
  captureRedo(sessionId, state.entries.slice(stopIndex));
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
  // Snapshot what is about to be replaced, so the undo itself can be undone.
  captureRedo(sessionId, affected);

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

/**
 * Record a snapshot whose prior content the caller already has.
 *
 * Git-based capture reads a file's pre-change content from `git show HEAD:` —
 * the working copy is already past that point by the time a command returns.
 * This entry point takes the content as an argument for exactly that case.
 */
export function recordSnapshot(
  sessionId: string,
  tool: string,
  cwd: string,
  absPath: string,
  kind: "created" | "modified" | "deleted",
  priorContent: string | null,
  messageIndex?: number,
): CheckpointEntry {
  const state = loadCheckpoints(sessionId);
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  let blob: string | undefined;
  if (priorContent !== null) {
    const dir = sessionDir(sessionId);
    mkdirSync(join(dir, "blobs"), { recursive: true });
    blob = join("blobs", `${createHash("sha1").update(absPath).digest("hex").slice(0, 12)}-${id}.txt`);
    writeFileSync(join(dir, blob), priorContent, "utf8");
  }
  const entry: CheckpointEntry = {
    id,
    at: new Date().toISOString(),
    tool,
    path: relative(cwd, absPath).split("\\").join("/") || ".",
    absPath,
    kind,
    blob,
    bytes: Buffer.byteLength(priorContent ?? "", "utf8"),
    ...(Number.isFinite(messageIndex) ? { messageIndex } : {}),
  };
  state.entries.push(entry);
  if (state.entries.length > 500) {
    for (const dropped of state.entries.splice(0, state.entries.length - 500)) dropBlob(sessionId, dropped);
  }
  saveCheckpoints(state);
  return entry;
}

/**
 * Restore one file to its earliest recorded state, leaving every other file
 * alone.
 *
 * `restoreTo` walks a whole range, which is right for "undo this turn" and
 * wrong for "this one file is wrong": the user then watched unrelated edits
 * disappear along with it. The earliest entry is the one whose blob holds the
 * content from before this session touched the file at all.
 */
export function restoreFile(sessionId: string, target: string): { restored: string[]; errors: string[] } {
  const state = loadCheckpoints(sessionId);
  const normalized = target.split("\\").join("/");
  const matches = state.entries.filter(
    (entry) => entry.path === normalized || entry.absPath.split("\\").join("/") === normalized,
  );
  if (matches.length === 0) return { restored: [], errors: [`no checkpoint for ${target}`] };
  captureRedo(sessionId, matches);
  const earliest = matches[0];
  const errors: string[] = [];
  try {
    if (earliest.kind === "created") {
      rmSync(earliest.absPath, { force: true });
    } else if (earliest.blob) {
      const dir = sessionDir(sessionId);
      const rel = relative(dir, join(dir, earliest.blob));
      if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("invalid blob path");
      const content = readFileSync(join(dir, earliest.blob), "utf8");
      mkdirSync(dirname(earliest.absPath), { recursive: true });
      writeFileSync(earliest.absPath, content, "utf8");
    }
  } catch (err) {
    errors.push(`${earliest.path}: ${(err as Error).message}`);
  }
  // Drop every entry for this file: the file is back at its pre-session state,
  // so keeping the intermediate records would let a later rewind replay them.
  state.entries = state.entries.filter((entry) => !matches.includes(entry));
  saveCheckpoints(state);
  return { restored: errors.length ? [] : [earliest.path], errors };
}

export interface RedoRecord {
  id: string;
  at: string;
  /** What was undone, one entry per file. */
  files: { absPath: string; path: string; kind: "created" | "modified" | "deleted"; blob?: string }[];
}

/**
 * The last undo, kept so it can be put back.
 *
 * An undo that cannot be undone makes people hesitate to use it, which defeats
 * the point of a one-click rollback. One level is enough: a second rewind
 * replaces the redo, because the branch the user wanted is already gone.
 */
function redoPath(sessionId: string): string {
  return join(sessionDir(sessionId), "redo.json");
}

export function lastRedo(sessionId: string): RedoRecord | null {
  try {
    return JSON.parse(readFileSync(redoPath(sessionId), "utf8")) as RedoRecord;
  } catch {
    return null;
  }
}

/** Snapshot the current content of the given files before undoing them. */
export function captureRedo(sessionId: string, entries: CheckpointEntry[]): void {
  const dir = sessionDir(sessionId);
  const files: RedoRecord["files"] = [];
  for (const entry of entries) {
    try {
      if (existsSync(entry.absPath)) {
        const content = readFileSync(entry.absPath, "utf8");
        mkdirSync(join(dir, "redo"), { recursive: true });
        const blob = join("redo", `${createHash("sha1").update(entry.absPath).digest("hex").slice(0, 12)}-${Date.now().toString(36)}.txt`);
        writeFileSync(join(dir, blob), content, "utf8");
        files.push({ absPath: entry.absPath, path: entry.path, kind: "modified", blob });
      } else {
        files.push({ absPath: entry.absPath, path: entry.path, kind: "deleted" });
      }
    } catch {
      /* a file we cannot read cannot be redone */
    }
  }
  if (files.length === 0) return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(redoPath(sessionId), JSON.stringify({ id: `${Date.now().toString(36)}`, at: new Date().toISOString(), files }, null, 2), "utf8");
}

/** Put back what the last undo removed. Consumes the redo. */
export function applyRedo(sessionId: string): { restored: string[]; errors: string[] } {
  const redo = lastRedo(sessionId);
  if (!redo) return { restored: [], errors: ["nothing to redo"] };
  const dir = sessionDir(sessionId);
  const restored: string[] = [];
  const errors: string[] = [];
  for (const file of redo.files) {
    try {
      if (file.kind === "deleted") {
        rmSync(file.absPath, { force: true });
      } else if (file.blob) {
        const rel = relative(dir, join(dir, file.blob));
        if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("invalid blob path");
        const content = readFileSync(join(dir, file.blob), "utf8");
        mkdirSync(dirname(file.absPath), { recursive: true });
        writeFileSync(file.absPath, content, "utf8");
      }
      restored.push(file.path);
    } catch (err) {
      errors.push(`${file.path}: ${(err as Error).message}`);
    }
  }
  rmSync(redoPath(sessionId), { force: true });
  return { restored, errors };
}

/** Discard a session's checkpoint history. */
export function clearCheckpoints(sessionId: string): void {
  rmSync(sessionDir(sessionId), { recursive: true, force: true });
}

export function listCheckpointSessions(): string[] {
  if (!existsSync(ROOT)) return [];
  return readdirSync(ROOT).filter((name) => existsSync(join(ROOT, name, "checkpoints.json")));
}
