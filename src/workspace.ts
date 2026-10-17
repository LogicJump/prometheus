/** Workspace browsing for the renderer: file tree and file previews. */

import { readdirSync, statSync, existsSync, readFileSync } from "node:fs";
import { join, relative, resolve, isAbsolute } from "node:path";

const SKIP = new Set([
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
  "release",
]);

export interface TreeNode {
  name: string;
  path: string;
  type: "file" | "dir";
  children?: TreeNode[];
}

/** Shallow tree: one level under `relPath`, directories first. */
export function readWorkspaceTree(cwd: string, relPath = "."): TreeNode[] {
  const abs = resolvePath(cwd, relPath);
  if (!existsSync(abs)) return [];
  let entries;
  try {
    entries = readdirSync(abs, { withFileTypes: true });
  } catch {
    return [];
  }
  const nodes: TreeNode[] = [];
  for (const entry of entries) {
    if (SKIP.has(entry.name) || entry.name.startsWith(".DS_Store")) continue;
    const full = join(abs, entry.name);
    const rel = relative(cwd, full).split("\\").join("/");
    if (entry.isDirectory()) nodes.push({ name: entry.name, path: rel, type: "dir" });
    else if (entry.isFile()) nodes.push({ name: entry.name, path: rel, type: "file" });
  }
  nodes.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
  return nodes;
}

const TEXT_LIMIT = 400 * 1024;

export interface FilePreview {
  path: string;
  content: string;
  language: string;
  truncated: boolean;
  binary: boolean;
}

export function loadFilePreview(cwd: string, relPath: string): FilePreview {
  const abs = resolvePath(cwd, relPath);
  const preview: FilePreview = { path: relPath, content: "", language: languageOf(relPath), truncated: false, binary: false };
  if (!existsSync(abs)) {
    preview.content = "";
    return preview;
  }
  const info = statSync(abs);
  if (!info.isFile()) return preview;
  const buf = readFileSync(abs);
  if (buf.subarray(0, 8000).includes(0)) {
    preview.binary = true;
    return preview;
  }
  const text = buf.toString("utf8");
  preview.truncated = text.length > TEXT_LIMIT;
  preview.content = preview.truncated ? text.slice(0, TEXT_LIMIT) : text;
  return preview;
}

function resolvePath(cwd: string, relPath: string): string {
  const abs = isAbsolute(relPath) ? resolve(relPath) : resolve(cwd, relPath);
  const rel = relative(resolve(cwd), abs);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`path escapes the workspace: ${relPath}`);
  return abs;
}

function languageOf(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    ts: "typescript",
    tsx: "tsx",
    js: "javascript",
    jsx: "jsx",
    mjs: "javascript",
    cjs: "javascript",
    json: "json",
    md: "markdown",
    css: "css",
    html: "html",
    py: "python",
    rs: "rust",
    go: "go",
    java: "java",
    c: "c",
    h: "c",
    cpp: "cpp",
    hpp: "cpp",
    sh: "shell",
    bash: "shell",
    yml: "yaml",
    yaml: "yaml",
    toml: "toml",
    sql: "sql",
    xml: "xml",
  };
  return map[ext] ?? "text";
}
