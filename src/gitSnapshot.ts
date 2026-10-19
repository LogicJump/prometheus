/**
 * Checkpointing for changes made by shell commands.
 *
 * The file tools call `captureBefore` with the path they are about to write, so
 * their changes are reversible. A shell command has no such call site: `rm`,
 * `mv`, `sed -i`, a code generator, a build script that rewrites sources. Those
 * changes were invisible to rewind, which is why "undo" quietly failed to undo
 * the most destructive thing the agent could do.
 *
 * The mechanism is git's own bookkeeping. Before a command runs we record the
 * set of paths git already reports as dirty; after it runs we look again. A
 * path that became dirty, and was clean before, is a path whose pre-command
 * content still exists in `HEAD` — that is exactly the content to checkpoint.
 *
 * A path that was *already* dirty before the command cannot be recovered this
 * way. Pretending otherwise would restore the wrong content silently, so those
 * are counted and reported, never guessed at.
 */

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { recordSnapshot } from "./checkpoints.ts";

export interface DirtyState {
  /** Repo-relative path → porcelain status letter. */
  paths: Map<string, string>;
  root: string;
}

function git(cwd: string, args: string[], timeout = 5_000): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-c", "core.quotepath=false", ...args],
      { cwd, windowsHide: true, timeout, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout) => resolve({ ok: !error, out: String(stdout ?? "") }),
    );
  });
}

/** The repository root above `cwd`, or null when there is none. */
export async function gitRoot(cwd: string): Promise<string | null> {
  const result = await git(cwd, ["rev-parse", "--show-toplevel"]);
  if (!result.ok) return null;
  const root = result.out.trim();
  return root || null;
}

/**
 * Paths git reports as changed right now.
 *
 * `-z` keeps unusual file names intact; the record separator between the two
 * status columns is handled below.
 */
export async function dirtyState(cwd: string): Promise<DirtyState | null> {
  const root = await gitRoot(cwd);
  if (!root) return null;
  const result = await git(root, ["status", "--porcelain", "-z", "--untracked-files=all"]);
  if (!result.ok) return null;
  const paths = new Map<string, string>();
  const parts = result.out.split("\u0000");
  for (let index = 0; index < parts.length; index++) {
    const entry = parts[index];
    if (!entry || entry.length < 4) continue;
    const status = entry.slice(0, 2);
    const path = entry.slice(3);
    paths.set(path, status);
    // A rename record is followed by the original path in the next slot.
    if (status.includes("R")) index += 1;
  }
  return { paths, root };
}

const MAX_SNAPSHOT = 8 * 1024 * 1024;

/**
 * Checkpoint the paths a command newly changed.
 *
 * Runs after the command, with the pre-command state in hand. Returns how many
 * files were captured and how many could not be (already dirty, too large,
 * binary, or absent from HEAD).
 */
export async function captureBashChanges(
  sessionId: string,
  cwd: string,
  before: DirtyState | null,
  messageIndex?: number,
): Promise<{ captured: number; skipped: number }> {
  if (!before) return { captured: 0, skipped: 0 };
  const after = await dirtyState(cwd);
  if (!after) return { captured: 0, skipped: 0 };

  let captured = 0;
  let skipped = 0;
  for (const [path, status] of after.paths) {
    const wasDirty = before.paths.has(path);
    if (wasDirty) {
      // Already dirty before the command: its prior content is not in HEAD and
      // was not captured by this pass. Count it so the caller can say so.
      skipped += 1;
      continue;
    }
    if (status === "??") {
      // A brand-new file: restoring it means removing it, which needs no blob.
      recordSnapshot(sessionId, "bash", after.root, join(after.root, path), "created", null, messageIndex);
      captured += 1;
      continue;
    }
    const prior = await readHead(after.root, path);
    if (prior === null) {
      skipped += 1;
      continue;
    }
    if (prior !== null && Buffer.byteLength(prior, "utf8") > MAX_SNAPSHOT) {
      skipped += 1;
      continue;
    }
    // A deleted file restores from HEAD's content; the record says "modified"
    // because the path exists at the checkpoint and the index has it.
    recordSnapshot(sessionId, "bash", after.root, join(after.root, path), "modified", prior, messageIndex);
    captured += 1;
  }
  return { captured, skipped };
}

/** The committed content of a path, or null when it is not in HEAD. */
async function readHead(root: string, path: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["show", `HEAD:${path}`],
      { cwd: root, windowsHide: true, timeout: 5_000, maxBuffer: MAX_SNAPSHOT + 1024, encoding: "utf8" },
      (error, stdout) => resolve(error ? null : String(stdout)),
    );
  });
}

/** True when a path is inside the repository root. */
export function isInside(root: string, path: string): boolean {
  const absolute = isAbsolute(path) ? path : join(root, path);
  return absolute.startsWith(root);
}
