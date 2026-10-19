/**
 * Isolated git worktrees for sessions.
 *
 * A session can run in its own worktree so its edits never mix with another
 * session's or with the user's own uncommitted work. Worktrees are created
 * under the repository's `.prometheus/worktrees/` (ignored by git) on a
 * dedicated branch, and merged back only when the user asks.
 */

import { execFile } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
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

/**
 * Paths a fresh worktree needs that git will not carry: local env files,
 * generated config, anything a project lists in `.worktreeinclude`.
 *
 * One pattern per line, gitignore syntax, `#` for comments. Only names are
 * copied, never directories recursively unless the pattern names one.
 */
export function readWorktreeInclude(repoRoot: string): string[] {
  const file = join(repoRoot, ".worktreeinclude");
  try {
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#") && !line.startsWith("!"));
  } catch {
    return [];
  }
}

/** Does a repo-relative path match one of the include patterns? */
export function matchesInclude(relativePath: string, patterns: string[]): boolean {
  const normalized = relativePath.split("\\").join("/");
  return patterns.some((pattern) => {
    const directory = pattern.endsWith("/");
    const clean = pattern.replace(/^\//, "").replace(/\/$/, "");
    if (!clean) return false;
    if (directory) return normalized === clean || normalized.startsWith(`${clean}/`);
    if (!clean.includes("*")) return normalized === clean || normalized.startsWith(`${clean}/`);
    const regex = new RegExp(`^${clean.split("*").map(escapeRegex).join("[^/]*")}$`);
    return regex.test(normalized) || regex.test(normalized.split("/").pop() ?? "");
  });
}

function escapeRegex(text: string): string {
  // Written without a regex literal so the backslash escapes stay readable:
  // a literal would need four levels of escaping to mean "any of these".
  const special = "^$.*+?()[]{}|";
  let out = "";
  for (const char of text) out += special.includes(char) ? "\\" + char : char;
  return out;
}

/** Copy the paths `.worktreeinclude` names from the main tree into a worktree. */
function copyIncluded(from: string, to: string, patterns: string[]): string[] {
  const copied: string[] = [];
  if (patterns.length === 0) return copied;
  const walk = (dir: string, depth: number) => {
    if (depth > 8) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === "node_modules" || entry.name === ".prometheus") continue;
      const source = join(dir, entry.name);
      const relativePath = source.slice(from.length + 1);
      if (entry.isDirectory()) {
        walk(source, depth + 1);
        continue;
      }
      if (!entry.isFile() || !matchesInclude(relativePath, patterns)) continue;
      const target = join(to, relativePath);
      try {
        mkdirSync(dirname(target), { recursive: true });
        copyFileSync(source, target);
        copied.push(relativePath.split("\\").join("/"));
      } catch {
        /* an unreadable include is not worth failing the worktree for */
      }
    }
  };
  walk(from, 0);
  return copied;
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
 * `base` names the revision to fork from (default `HEAD`), but the worktree
 * records the **commit sha** it actually started at. The label is useless as a
 * diff base later: by the time a session asks for its diff it has committed,
 * and `git diff HEAD` is then empty by definition.
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

  // The commit the worktree forks from, resolved before any branch is made.
  const resolved = await git(top, ["rev-parse", "--verify", `${base}^{commit}`]);
  const baseSha = resolved.ok ? resolved.out.trim() : "";

  if (existsSync(path)) {
    return { ok: true, worktree: { path, branch, base: baseSha || base } };
  }
  mkdirSync(parent, { recursive: true });

  // A fresh repository with no commits cannot branch from HEAD; an orphan
  // worktree starts the branch rather than attaching to one.
  const committed = await hasCommits(top);
  const args = committed
    ? ["worktree", "add", "-b", branch, path, base]
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
    // Files git cannot carry (env files, generated configs) come from the
    // project's own list rather than a guess about which ones matter.
    copyIncluded(top, path, readWorktreeInclude(top));
    const head = await git(path, ["rev-parse", "--abbrev-ref", "HEAD"]);
    // For an empty repository the baseline commit is the fork point.
    const forkedAt = baseSha || (await git(path, ["rev-parse", "HEAD"])).out.trim() || base;
    return { ok: true, worktree: { path, branch: head.ok ? head.out.trim() : branch, base: forkedAt } };
  }

  // The branch may already exist from an earlier session; attach to it instead.
  const retry = await git(top, ["worktree", "add", path, branch]);
  if (retry.ok) return { ok: true, worktree: { path, branch, base: baseSha || base } };
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
  // `base` is the commit the worktree forked from, so committed work still
  // shows. With a literal "HEAD" the diff was empty exactly when a session had
  // just committed, which is the only time the command is called.
  const result = await git(worktree.path, ["diff", worktree.base, "--"]);
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
    // The carry folder is disposable: the transcript itself lives in the
    // session store, and a stale copy inside the worktree would be committed
    // into the user's branch. Ignoring it is part of writing it.
    const ignore = join(targetDir, ".gitignore");
    const existing = existsSync(ignore) ? readFileSync(ignore, "utf8") : "";
    const entry = "session.md\n" + "session.json\n";
    if (!existing.includes("session.md")) {
      const separator = existing && !existing.endsWith("\n") ? "\n" : "";
      writeFileSync(ignore, `${existing}${separator}${entry}`, "utf8");
    }
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


/**
 * A lock file naming the session that owns a worktree.
 *
 * Two windows pointed at the same worktree would edit the same checked-out
 * files with different agents, and `worktree add` would have refused anyway;
 * the lock makes the reason legible before anything is changed.
 */
function lockPath(worktreePath: string): string {
  return join(worktreePath, ".prometheus-lock.json");
}

export function lockWorktree(worktreePath: string, sessionId: string): { ok: boolean; holder?: string } {
  const file = lockPath(worktreePath);
  try {
    if (existsSync(file)) {
      const held = JSON.parse(readFileSync(file, "utf8")) as { sessionId?: string; pid?: number };
      // A lock left by a dead process is stale, not a conflict. A live one held
      // by another session is a conflict even inside this process: two sessions
      // in one window (a fork, a resumed worktree) must not share a checkout.
      const alive = held.pid !== undefined && isAlive(held.pid);
      if (alive && held.sessionId && held.sessionId !== sessionId) {
        return { ok: false, holder: held.sessionId };
      }
      if (alive && !held.sessionId) {
        return { ok: false, holder: `pid ${held.pid}` };
      }
    }
    writeFileSync(file, JSON.stringify({ sessionId, pid: process.pid, at: new Date().toISOString() }, null, 2), "utf8");
    return { ok: true };
  } catch (err) {
    return { ok: false, holder: (err as Error).message };
  }
}

export function unlockWorktree(worktreePath: string): void {
  try {
    rmSync(lockPath(worktreePath), { force: true });
  } catch {
    /* best effort */
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export interface StaleWorktree {
  path: string;
  branch: string;
  /** Why it is considered stale: no lock, or a lock whose process is gone. */
  reason: string;
  ageDays: number;
}

/**
 * Worktrees under `.prometheus/worktrees` that no live process owns.
 *
 * A crashed window leaves its checkout and branch behind; enough of them and
 * the folder is confusing and the branch list is noise. The scan is a read;
 * `removeWorktree` does the deletion, and only for what this reports.
 */
export function staleWorktrees(repoRoot: string, olderThanDays = 14): StaleWorktree[] {
  const root = join(repoRoot, ".prometheus", "worktrees");
  if (!existsSync(root)) return [];
  const out: StaleWorktree[] = [];
  for (const entry of readdirSafe(root)) {
    const path = join(root, entry);
    let stat;
    try {
      stat = statSync(path);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    const ageDays = (Date.now() - stat.mtimeMs) / 86_400_000;
    if (ageDays < olderThanDays) continue;
    let reason = "no owner recorded";
    const file = lockPath(path);
    if (existsSync(file)) {
      try {
        const held = JSON.parse(readFileSync(file, "utf8")) as { sessionId?: string; pid?: number };
        if (held.pid && isAlive(held.pid)) continue;
        reason = `owner ${held.sessionId ?? "unknown"} is no longer running`;
      } catch {
        /* an unreadable lock is as good as none */
      }
    }
    const branch = `prometheus/${entry}`;
    out.push({ path, branch, reason, ageDays: Math.floor(ageDays) });
  }
  return out;
}

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** One line per stale worktree, for the CLI and a startup notice. */
export function formatStaleWorktrees(stale: StaleWorktree[]): string[] {
  return stale.map((entry) => `${entry.branch}  ${entry.ageDays}d old  ${entry.reason}  (${entry.path})`);
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
