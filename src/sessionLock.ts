/**
 * One writer per session.
 *
 * A session is an append-only JSONL transcript plus a meta file. Two processes
 * appending to the same generation is not a hypothetical: the desktop opens a
 * second window for a second session, both windows list every session, and a
 * CLI `--resume` can land on the same id the window already has open. Appends
 * from two writers interleave, `messageCount` and `lastHash` disagree with the
 * file, and the next append either starts a spurious generation or refuses to
 * append at all — the conversation silently forks on disk.
 *
 * The lock is a file created with `wx` (exclusive create), which is atomic on
 * every platform Node supports. It records the owning process so a lock left by
 * a crashed process can be recognised: a lock whose pid is gone is stale and is
 * taken over rather than blocking the session forever.
 *
 * The lock is advisory in the sense that nothing on disk enforces it — the
 * reader of the transcript does not need it. It exists so a *writer* can tell
 * another writer it is not alone.
 */

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { SESSIONS_DIR } from "./config.ts";

export interface SessionHolder {
  /** Process id of the owner. */
  pid: number;
  /** Machine name, so a lock copied between machines is not mistaken for a live one. */
  host: string;
  /** When the owner took the lock. */
  acquiredAt: string;
  /** What the owner is, for the message shown to the user: "desktop", "cli". */
  label?: string;
  /**
   * The conversation id the owner believes it is writing. A lock left behind by
   * a crashed writer is recognised by the pid; this field exists for the
   * message, and to tell a reload from a second writer.
   */
  sessionId?: string;
}

/**
 * How old a lock may be before a writer stops believing it.
 *
 * A lock with a live pid is honoured indefinitely — a long turn can take an
 * hour. The age only matters when the pid cannot be checked (another host) or
 * a process id was reused by an unrelated program: a day-old lock is treated as
 * abandoned rather than blocking a session forever.
 */
const MAX_LOCK_AGE_MS = 24 * 60 * 60 * 1000;

function lockIsAncient(holder: SessionHolder): boolean {
  const taken = Date.parse(holder.acquiredAt);
  return Number.isFinite(taken) && Date.now() - taken > MAX_LOCK_AGE_MS;
}

export type AcquireResult = { ok: true; holder: SessionHolder } | { ok: false; holder: SessionHolder };

function lockFile(id: string): string {
  return join(SESSIONS_DIR, id, ".lock");
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    // Signal 0 does not deliver anything; it only asks the OS whether the
    // process exists. EPERM means it exists but belongs to someone else.
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readHolder(id: string): SessionHolder | null {
  try {
    const parsed = JSON.parse(readFileSync(lockFile(id), "utf8")) as SessionHolder;
    if (typeof parsed?.pid !== "number") return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * The holder of a session's lock, or null when the session is free.
 *
 * A lock whose process is gone (or that was taken on another machine) is
 * removed and reported as free, so a crash does not make a session unopenable.
 */
export function sessionLockHolder(id: string): SessionHolder | null {
  const holder = readHolder(id);
  if (!holder) return null;
  const sameMachine = holder.host === hostname();
  const alive = sameMachine && isProcessAlive(holder.pid);
  // A live pid owns the session, unless the lock is old enough that the pid
  // was almost certainly reused by an unrelated program — honouring that
  // forever would make the session unopenable with no way out.
  if (alive && !lockIsAncient(holder)) return holder;
  try {
    rmSync(lockFile(id), { force: true });
  } catch {
    /* another process may have removed it first */
  }
  return null;
}

/**
 * Take the session's write lock.
 *
 * Re-acquiring a lock this process already holds succeeds: the desktop host
 * reloads sessions, and a reload must not lock itself out.
 */
export function acquireSessionLock(id: string, label = "process"): AcquireResult {
  const holder: SessionHolder = { pid: process.pid, host: hostname(), acquiredAt: new Date().toISOString(), label };
  mkdirSync(join(SESSIONS_DIR, id), { recursive: true });

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lockFile(id), "wx");
      try {
        writeSync(fd, JSON.stringify(holder));
      } finally {
        closeSync(fd);
      }
      return { ok: true, holder };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = readHolder(id);
      if (existing && existing.pid === process.pid && existing.host === holder.host) {
        return { ok: true, holder: existing };
      }
      // A live owner stays the owner. A dead one is cleared by
      // sessionLockHolder(), and the second pass creates the file.
      const live = sessionLockHolder(id);
      if (live) return { ok: false, holder: live };
    }
  }
  // The stale lock could not be cleared (permissions, a race). Treat the last
  // known holder as the answer rather than pretending the lock was taken.
  return { ok: false, holder: readHolder(id) ?? holder };
}

/** Release the lock, but only if this process is the owner. */
export function releaseSessionLock(id: string, pid = process.pid): void {
  const holder = readHolder(id);
  if (holder && holder.host === hostname() && holder.pid !== pid) return;
  try {
    rmSync(lockFile(id), { force: true });
  } catch {
    /* already gone */
  }
}

/** A one-line reason suitable for showing the user. */
export function lockConflictMessage(id: string, holder: SessionHolder): string {
  const who = holder.label ? `the ${holder.label}` : "another process";
  return `session ${id} is open in ${who} (pid ${holder.pid}, since ${holder.acquiredAt}); close it there or open a different session`;
}

/** True when this process holds the session (used before releasing on exit). */
export function holdsSessionLock(id: string): boolean {
  const holder = readHolder(id);
  return Boolean(holder && holder.host === hostname() && holder.pid === process.pid);
}

/** Remove a session's lock file as part of deleting the session. */
export function removeSessionLockFile(id: string): void {
  if (!existsSync(join(SESSIONS_DIR, id))) return;
  try {
    rmSync(lockFile(id), { force: true });
  } catch {
    /* best effort */
  }
}
