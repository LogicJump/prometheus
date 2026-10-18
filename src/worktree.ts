/**
 * Isolated git worktrees for sessions.
 *
 * A session can run in its own worktree so its edits never mix with another
 * session's or with the user's own uncommitted work. Worktrees are created
 * under the repository's `.prometheus/worktrees/` (ignored by git) on a
 * dedicated branch, and merged back only when the user asks.
 */

import { execFile } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { SessionFile } from "./sessions.ts";
import { sessionToMarkdown } from "./export.ts";

function git(cwd: string, args: string[], timeout = 60_000): Promise<{ ok: boolean; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-c", "core.quotepath=false", ...args],
      { cwd, windowsHide: true, timeout, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        resolve({ ok: !error, out: String(stdout ?? ""), err: String(stderr ?? "").trim() });
      },
    );
  });
}

/** Copy a working tree into a new worktree, skipping git metadata and build output. */
function copyWorkingTree(from: string, to: string, depth = 0): void {
  if (depth > 12) return;
  let entries;
  try {
    entries = readdirSync(from, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === "node_modules" || entry.name === ".prometheus") continue;
    const source = join(from, entry.name);
    const target = join(to, entry.name);
    if (entry.isDirectory()) {
      mkdirSync(target, { recursive: true });
      copyWorkingTree(source, target, depth + 1);
    } else if (entry.isFile()) {
      try {
        copyFileSync(source, target);
      } catch {
        /* skip unreadable files */
      }
    }
  }
}

/** Short, filesystem- and branch-safe label derived from a session id. */
function slug(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9-]/g, "-").slice(0, 40);
}

export async function isRepository(cwd: string): Promise<boolean> {
  const result = await git(cwd, ["rev-parse", "--show-toplevel"]);
  return result.ok;
}

/** Commit state that would block `git worktree add` from a removed base. */
export async function hasCommits(cwd: string): Promise<boolean> {
  const result = await git(cwd, ["rev-parse", "--verify", "HEAD"]);
  return result.ok;
}

export interface Worktree {
  path: string;
  branch: string;
  base: string;
}

/**
 * Create (or reuse) a worktree for a session.
 *
 * @param repoRoot the repository root the session's workspace belongs to
 */
export async function createWorktree(
  repoRoot: string,
  sessionId: string,
  base = "HEAD",
  branchPrefix = "prometheus/",
): Promise<{ ok: true; worktree: Worktree } | { ok: false; error: string }> {
  const root = await git(repoRoot, ["rev-parse", "--show-toplevel"]);
  if (!root.ok) return { ok: false, error: "this workspace is not a git repository" };

  const top = root.out.trim();
  const name = slug(sessionId);
  const prefix = branchPrefix.trim() ? (branchPrefix.trim().endsWith("/") ? branchPrefix.trim() : `${branchPrefix.trim()}/`) : "";
  const branch = `${prefix}${name}`;
  const parent = join(top, ".prometheus", "worktrees");
  const path = join(parent, name);

  if (existsSync(path)) {
    return { ok: true, worktree: { path, branch, base } };
  }
  mkdirSync(parent, { recursive: true });

  // A fresh repository with no commits cannot branch from HEAD; an orphan
  // worktree starts the branch rather than attaching to one.
  const committed = await hasCommits(top);
  const args = committed
    ? ["worktree", "add", "-b", branch, path]
    : ["worktree", "add", "--orphan", "-b", branch, path];
  const added = await git(top, args);
  if (added.ok) {
    if (!committed) {
      // An orphan worktree starts empty, and the repository's files are still
      // untracked, so copy the working tree across before the baseline commit.
      copyWorkingTree(top, path);
      await git(path, ["add", "-A"]);
      await git(path, ["-c", "user.name=Prometheus", "-c", "user.email=prometheus@localhost", "commit", "-m", "Prometheus worktree baseline"]);
    }
    const head = await git(path, ["rev-parse", "--abbrev-ref", "HEAD"]);
    return { ok: true, worktree: { path, branch: head.ok ? head.out.trim() : branch, base } };
  }

  // The branch may already exist from an earlier session; attach to it instead.
  const retry = await git(top, ["worktree", "add", path, branch]);
  if (retry.ok) return { ok: true, worktree: { path, branch, base } };
  return { ok: false, error: added.err || retry.err || "could not create a worktree" };
}

/** Commit everything in a worktree; returns the commit summary. */
export async function commitWorktree(worktree: Worktree, message: string): Promise<{ ok: boolean; error?: string; summary?: string }> {
  if (!existsSync(worktree.path)) return { ok: false, error: "the worktree is gone" };
  await git(worktree.path, ["add", "-A"]);
  const status = await git(worktree.path, ["status", "--porcelain"]);
  if (status.ok && status.out.trim() === "") return { ok: true, summary: "nothing to commit" };
  const commit = await git(worktree.path, ["commit", "-m", message]);
  if (!commit.ok) return { ok: false, error: commit.err || "commit failed" };
  const summary = (commit.out.match(/^\[[^\]]+\]\s*(.*)$/m) ?? [])[1] ?? message;
  return { ok: true, summary };
}

/** The changes in a worktree relative to its base, as a unified diff. */
export async function worktreeDiff(worktree: Worktree): Promise<string> {
  const result = await git(worktree.path, ["diff", worktree.base]);
  const untracked = await git(worktree.path, ["ls-files", "--others", "--exclude-standard"]);
  const parts = [result.out];
  if (untracked.ok && untracked.out.trim()) {
    parts.push(untracked.out.trim().split("\n").map((file) => `?? ${file}`).join("\n"));
  }
  return parts.filter(Boolean).join("\n");
}

/** Merge the worktree's branch back into the base and remove the worktree. */
export async function mergeWorktree(repoRoot: string, worktree: Worktree): Promise<{ ok: boolean; error?: string }> {
  const base = await git(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!base.ok) return { ok: false, error: "cannot read the base branch" };
  const merge = await git(repoRoot, ["merge", "--no-edit", worktree.branch], 120_000);
  if (!merge.ok) {
    return {
      ok: false,
      error: `merge conflict: resolve it in ${repoRoot} (the worktree has not been removed)`,
    };
  }
  return { ok: true };
}

export async function removeWorktree(repoRoot: string, worktree: Worktree): Promise<{ ok: boolean; error?: string }> {
  const removed = await git(repoRoot, ["worktree", "remove", "--force", worktree.path]);
  if (!removed.ok) {
    try {
      rmSync(worktree.path, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
  await git(repoRoot, ["branch", "-D", worktree.branch]);
  return { ok: true };
}

/**
 * Write a session's transcript into an isolated worktree so a resumed session
 * keeps its history while the original workspace stays untouched.
 */
export function carrySession(targetDir: string, session: SessionFile): void {
  try {
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(join(targetDir, "session.md"), sessionToMarkdown(session), "utf8");
    writeFileSync(
      join(targetDir, "session.json"),
      JSON.stringify({ id: session.id, cwd: session.cwd, model: session.model, messages: session.messages }, null, 2),
      "utf8",
    );
  } catch {
    /* carrying artifacts is best effort */
  }
}

/** Default branch label for display. */
export function worktreeLabel(worktree: Worktree): string {
  return `${worktree.branch} · ${basename(worktree.path)}`;
}

/** The ignore rule that keeps worktrees out of the user's own commits. */
export const WORKTREE_IGNORE = ".prometheus/worktrees/";

export function ensureWorktreeIgnored(repoRoot: string): void {
  const ignore = join(repoRoot, ".gitignore");
  try {
    const text = existsSync(ignore) ? readFileSync(ignore, "utf8") : "";
    if (text.split(/\r?\n/).some((line) => line.trim() === WORKTREE_IGNORE)) return;
    const separator = text && !text.endsWith("\n") ? "\n" : "";
    writeFileSync(ignore, `${text}${separator}${WORKTREE_IGNORE}\n`, "utf8");
  } catch {
    /* not fatal */
  }
}
