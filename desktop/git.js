/**
 * Git status and commits for the workspace.
 *
 * Everything goes through the `git` binary with `-c core.quotepath=false` so
 * paths with non-ASCII characters come back as plain UTF-8 rather than octal
 * escapes. Nothing here is interactive: committing uses `-m`, never an editor.
 */

import { execFile } from "node:child_process";

const BASE_ARGS = ["-c", "core.quotepath=false", "-c", "color.ui=false"];

function git(cwd, args, { maxBuffer = 4 * 1024 * 1024 } = {}) {
  return new Promise((resolve) => {
    execFile(
      "git",
      [...BASE_ARGS, ...args],
      { cwd, windowsHide: true, maxBuffer, timeout: 20_000 },
      (error, stdout, stderr) => {
        resolve({
          ok: !error,
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? "").trim(),
          code: error?.code ?? 0,
        });
      },
    );
  });
}

/** Parse `git status --porcelain=v1 -z` into path/status pairs. */
export function parseStatus(output) {
  const entries = [];
  const parts = output.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const record = parts[i];
    if (!record || record.length < 4) continue;
    const x = record[0];
    const y = record[1];
    let path = record.slice(3);
    // A rename record carries the new path first; the next -z record is the
    // original. Show it as `old -> new`.
    if (x === "R" || x === "C") {
      i += 1;
      path = `${parts[i] ?? ""} -> ${path}`;
    }
    entries.push({ path, x, y, status: statusLabel(x, y) });
  }
  return entries;
}

function statusLabel(x, y) {
  if (x === "?" || (x === "?" && y === "?")) return "untracked";
  if (x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D")) return "conflicted";
  if (x === "R") return "renamed";
  if (x === "A") return "added";
  if (x === "D" || y === "D") return "deleted";
  if (x === "M" || y === "M") return "modified";
  return "changed";
}

/**
 * @returns {Promise<{available: boolean, branch?: string, upstream?: string,
 *   ahead?: number, behind?: number, files?: object[], clean?: boolean,
 *   error?: string}>}
 */
export async function gitStatus(cwd) {
  const head = await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (!head.ok) {
    return { available: false, error: head.stderr || "not a git repository" };
  }

  const [branchResult, statusResult, countsResult] = await Promise.all([
    git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]),
    git(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=normal"]),
    git(cwd, ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"]),
  ]);

  let ahead = 0;
  let behind = 0;
  if (countsResult.ok) {
    const [left, right] = countsResult.stdout.trim().split(/\s+/).map(Number);
    behind = Number.isFinite(left) ? left : 0;
    ahead = Number.isFinite(right) ? right : 0;
  }
  const upstreamResult = await git(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
  const files = statusResult.ok ? parseStatus(statusResult.stdout) : [];
  return {
    available: true,
    branch: branchResult.ok ? branchResult.stdout.trim() : "HEAD",
    upstream: upstreamResult.ok ? upstreamResult.stdout.trim() : "",
    ahead,
    behind,
    files,
    clean: files.length === 0,
  };
}

/** Stage the given paths (or everything) and commit with a one-line message. */
export async function gitCommit(cwd, message, paths = []) {
  const text = String(message ?? "").trim();
  if (!text) return { ok: false, error: "commit message is empty" };
  const add = paths.length > 0 ? await git(cwd, ["add", "--", ...paths]) : await git(cwd, ["add", "-A"]);
  if (!add.ok) return { ok: false, error: add.stderr || "git add failed" };
  const commit = await git(cwd, ["commit", "-m", text]);
  if (!commit.ok) {
    const detail = [commit.stderr, commit.stdout].filter(Boolean).join("\n").trim();
    return { ok: false, error: detail || "git commit failed" };
  }
  const summary = (commit.stdout.match(/^\[[^\]]+\]\s*(.*)$/m) ?? [])[1] ?? text;
  return { ok: true, summary };
}
