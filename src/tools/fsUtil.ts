/** Shared file helpers used by the read/write/edit/glob/grep tools. */

import { readFileSync, writeFileSync, statSync, existsSync, readdirSync } from "node:fs";
import { readFile, writeFile, stat } from "node:fs/promises";
import path from "node:path";

export const MAX_READ_BYTES = 2 * 1024 * 1024;
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  "target",
  ".next",
  ".nuxt",
  "vendor",
  "__pycache__",
  ".venv",
  "venv",
  ".idea",
  ".cache",
  "coverage",
  ".prometheus",
]);

export function detectBinary(buf: Buffer): boolean {
  const sample = buf.subarray(0, 8000);
  for (const byte of sample) if (byte === 0) return true;
  return false;
}

export async function readTextFile(absPath: string): Promise<string> {
  const info = await stat(absPath);
  if (!info.isFile()) throw new Error(`${absPath} is not a regular file`);
  if (info.size > MAX_READ_BYTES) throw new Error(`file is too large (${info.size} bytes, max ${MAX_READ_BYTES})`);
  const buf = await readFile(absPath);
  if (detectBinary(buf)) throw new Error(`${absPath} appears to be a binary file`);
  return buf.toString("utf8");
}

export function readTextFileSync(absPath: string): string {
  const info = statSync(absPath);
  if (info.size > MAX_READ_BYTES) throw new Error(`file is too large (${info.size} bytes)`);
  const buf = readFileSync(absPath);
  if (detectBinary(buf)) throw new Error(`${absPath} appears to be a binary file`);
  return buf.toString("utf8");
}

export async function writeTextFile(absPath: string, content: string): Promise<void> {
  await writeFile(absPath, content, "utf8");
}

export function writeTextFileSync(absPath: string, content: string): void {
  writeFileSync(absPath, content, "utf8");
}

export function withLineNumbers(text: string, startLine = 1): string {
  const lines = text.split("\n");
  const width = String(startLine + lines.length - 1).length;
  return lines.map((line, i) => `${String(startLine + i).padStart(width)}→${line}`).join("\n");
}

/** Walk a directory tree, honoring skip dirs, .gitignore-ish ignores, and a depth cap. */
export function* walk(
  root: string,
  opts: { maxDepth?: number; ignore?: string[]; followSymlinks?: boolean } = {},
): Generator<string> {
  const maxDepth = opts.maxDepth ?? 20;
  const ignore = (opts.ignore ?? []).filter(Boolean);

  function* visit(dir: string, depth: number): Generator<string> {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const name = entry.name;
      if (SKIP_DIRS.has(name)) continue;
      if (ignore.some((pattern) => name === pattern || name.endsWith(pattern))) continue;
      const full = path.join(dir, name);
      if (entry.isSymbolicLink()) {
        if (!opts.followSymlinks) continue;
        yield full;
        continue;
      }
      if (entry.isDirectory()) {
        yield* visit(full, depth + 1);
      } else if (entry.isFile()) {
        yield full;
      }
    }
  }

  yield* visit(root, 0);
}

export function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function exists(p: string): boolean {
  return existsSync(p);
}

export function relPath(abs: string, cwd: string): string {
  return path.relative(cwd, abs).split(path.sep).join("/") || ".";
}

/** Convert a simple glob (with ** support) to a RegExp rooted at the workspace. */
export function globToRegExp(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        const next = glob[i + 2];
        if (next === "/") {
          out += "(?:.*/)?";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else {
        out += "[^/]*";
      }
    } else if (ch === "?") {
      out += "[^/]";
    } else if (ch === "{") {
      const end = glob.indexOf("}", i);
      if (end === -1) out += "\\{";
      else {
        const alts = glob.slice(i + 1, end).split(",").map(escapeRegExp);
        out += `(?:${alts.join("|")})`;
        i = end;
      }
    } else if (ch === "[") {
      const end = glob.indexOf("]", i);
      if (end === -1) out += "\\[";
      else {
        out += glob.slice(i, end + 1);
        i = end;
      }
    } else {
      out += escapeRegExp(ch);
    }
  }
  return new RegExp(`^${out}$`);
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
