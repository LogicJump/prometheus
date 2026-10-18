/**
 * Workspace index: a cheap symbol and keyword map, built lazily and cached.
 *
 * This is not an embedding index. It parses each source file just enough to
 * find declarations (functions, classes, types, exports) and keeps a token
 * frequency map of the rest, so a query like "where is compaction defined" or
 * "auth token refresh" can jump to the right file before the agent starts
 * grepping. Everything stays local, the index lives in ~/.prometheus/index/,
 * and it is rebuilt only when files change.
 *
 * Design choices:
 * - No dependency and no daemon: the index is a JSON file per workspace.
 * - Bounded: caps on file size, file count, and tokens keep it small.
 * - Best effort: a file that cannot be read is skipped, never an error.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { CONFIG_HOME } from "./config.ts";
import { walk } from "./tools/fsUtil.ts";

export interface SymbolEntry {
  name: string;
  kind: "function" | "class" | "type" | "const" | "method";
  line: number;
}

export interface FileEntry {
  path: string;
  size: number;
  mtimeMs: number;
  symbols: SymbolEntry[];
  /** Top tokens for keyword search, with their weights. */
  tokens: Record<string, number>;
}

export interface WorkspaceIndex {
  version: 1;
  cwd: string;
  builtAt: string;
  files: FileEntry[];
}

const INDEX_DIR = join(CONFIG_HOME, "index");
const MAX_FILES = 4_000;
const MAX_BYTES = 400 * 1024;
const MAX_TOKENS_PER_FILE = 200;
const SOURCE_EXT = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".rb", ".go", ".rs", ".java", ".kt",
  ".cs", ".php", ".c", ".h", ".cpp", ".hpp", ".swift", ".scala", ".sh", ".ps1", ".sql", ".vue", ".svelte",
]);

const STOP = new Set([
  "the", "and", "for", "with", "this", "that", "from", "const", "let", "var", "function", "return",
  "import", "export", "class", "type", "interface", "async", "await", "true", "false", "null",
  "undefined", "if", "else", "while", "new", "try", "catch", "throw", "void", "string", "number",
  "boolean", "public", "private", "static", "readonly", "default", "extends", "implements",
]);

function indexFile(cwd: string): string {
  const hash = createHash("sha1").update(cwd).digest("hex").slice(0, 16);
  return join(INDEX_DIR, `${hash}.json`);
}

function isSource(path: string): boolean {
  const dot = path.lastIndexOf(".");
  return dot > 0 && SOURCE_EXT.has(path.slice(dot).toLowerCase());
}

/** Research dumps, build output, and dot-directories are not project code. */
function skipPath(relPath: string): boolean {
  const segments = relPath.split("/");
  return segments.some(
    (segment, index) =>
      segment.startsWith(".") ||
      segment === "release" ||
      /^release(\d+|-.*)?$/i.test(segment) ||
      (index === segments.length - 1 ? false : /^(dist|build|out|coverage|vendor)$/i.test(segment)),
  );
}

/** Best-effort declaration scan; language-agnostic regexes on purpose. */
export function extractSymbols(text: string): SymbolEntry[] {
  const symbols: SymbolEntry[] = [];
  const patterns: { kind: SymbolEntry["kind"]; re: RegExp }[] = [
    { kind: "function", re: /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/ },
    { kind: "function", re: /^\s*(?:export\s+)?(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/ },
    { kind: "class", re: /^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/ },
    { kind: "type", re: /^\s*(?:export\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/ },
    { kind: "const", re: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/ },
    { kind: "function", re: /^\s*def\s+([A-Za-z_]\w*)/ },
    { kind: "class", re: /^\s*class\s+([A-Za-z_]\w*)/ },
    { kind: "function", re: /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/ },
    { kind: "function", re: /^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/ },
  ];
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (line.length > 240) continue;
    for (const { kind, re } of patterns) {
      const match = re.exec(line);
      if (match) {
        symbols.push({ name: match[1], kind, line: index + 1 });
        break;
      }
    }
    if (symbols.length >= 400) break;
  }
  return symbols;
}

export function tokenize(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const raw of text.match(/[A-Za-z_][A-Za-z0-9_]{2,}/g) ?? []) {
    const token = raw.toLowerCase();
    if (STOP.has(token)) continue;
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  return counts;
}

function topTokens(counts: Map<string, number>): Record<string, number> {
  return Object.fromEntries([...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_TOKENS_PER_FILE));
}

export function buildIndex(cwd: string): WorkspaceIndex {
  const files: FileEntry[] = [];
  for (const abs of walk(cwd, { maxDepth: 12 })) {
    if (files.length >= MAX_FILES) break;
    if (!isSource(abs)) continue;
    const rel = relative(cwd, abs).split("\\").join("/");
    if (skipPath(rel)) continue;
    let size = 0;
    let mtimeMs = 0;
    try {
      const info = statSync(abs);
      size = info.size;
      mtimeMs = info.mtimeMs;
    } catch {
      continue;
    }
    if (size > MAX_BYTES) continue;
    let text = "";
    try {
      text = readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    files.push({
      path: rel,
      size,
      mtimeMs,
      symbols: extractSymbols(text),
      tokens: topTokens(tokenize(text)),
    });
  }
  return { version: 1, cwd, builtAt: new Date().toISOString(), files };
}

/**
 * Load the index, rebuilding it when missing, stale (a file changed), or when
 * `force` is set. Rebuild costs one directory walk; it is only triggered by an
 * explicit search, never at startup.
 */
export function loadIndex(cwd: string, options: { force?: boolean } = {}): WorkspaceIndex {
  const file = indexFile(cwd);
  if (!options.force && existsSync(file)) {
    try {
      const cached = JSON.parse(readFileSync(file, "utf8")) as WorkspaceIndex;
      if (cached.version === 1 && cached.cwd === cwd && !isStale(cwd, cached)) return cached;
    } catch {
      /* fall through to a rebuild */
    }
  }
  const rebuilt = buildIndex(cwd);
  try {
    mkdirSync(INDEX_DIR, { recursive: true });
    writeFileSync(file, JSON.stringify(rebuilt), "utf8");
  } catch {
    /* the index is an optimisation; failing to persist it is fine */
  }
  return rebuilt;
}

function isStale(cwd: string, index: WorkspaceIndex): boolean {
  // Sample up to 40 files: a full stat of thousands on every search is worse
  // than a slightly stale index.
  const sample = index.files.slice(0, 40);
  for (const entry of sample) {
    try {
      if (statSync(join(cwd, entry.path)).mtimeMs !== entry.mtimeMs) return true;
    } catch {
      return true;
    }
  }
  return false;
}

export interface SearchHit {
  path: string;
  score: number;
  symbols: SymbolEntry[];
  /** Why this file matched, for the model's benefit. */
  matched: string[];
}

/** Rank files by symbol name, path, and token overlap. */
export function searchIndex(index: WorkspaceIndex, query: string, limit = 12): SearchHit[] {
  const terms = (query.toLowerCase().match(/[a-z_][a-z0-9_]{1,}/g) ?? []).filter((term) => !STOP.has(term));
  if (terms.length === 0) return [];
  const hits: SearchHit[] = [];

  for (const file of index.files) {
    let score = 0;
    const matched: string[] = [];
    const pathLower = file.path.toLowerCase();

    for (const term of terms) {
      if (pathLower.includes(term)) {
        score += 3;
        matched.push(`path:${term}`);
      }
      const named = file.symbols.filter((symbol) => symbol.name.toLowerCase().includes(term));
      for (const symbol of named.slice(0, 3)) {
        score += symbol.name.toLowerCase() === term ? 6 : 4;
        matched.push(`${symbol.kind} ${symbol.name}`);
      }
      const weight = file.tokens[term];
      if (weight) {
        score += Math.min(3, weight * 0.4);
        matched.push(`text:${term}x${weight}`);
      }
    }
    if (score > 0) hits.push({ path: file.path, score, symbols: file.symbols.slice(0, 12), matched: [...new Set(matched)].slice(0, 6) });
  }

  return hits.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, limit);
}

/** Compact text result for the tool. */
export function formatSearch(hits: SearchHit[], query: string): string {
  if (hits.length === 0) {
    return `No indexed file matches "${query}". Try grep for a literal string, or search_codebase with different words.`;
  }
  const lines = hits.map((hit) => {
    const symbols = hit.symbols.length
      ? hit.symbols.slice(0, 5).map((symbol) => `${symbol.name} (${symbol.kind}, L${symbol.line})`).join(", ")
      : "(no declarations found)";
    return `- ${hit.path} [${hit.score.toFixed(1)}]\n    ${symbols}\n    why: ${hit.matched.join(", ")}`;
  });
  return `Files matching "${query}":\n${lines.join("\n")}`;
}
