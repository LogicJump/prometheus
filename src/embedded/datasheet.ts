/**
 * A searchable index over datasheet PDFs in the workspace.
 *
 * A chip's reference manual is the ground truth for a register the SVD does
 * not describe, and the agent reading it page by page is not an option. This
 * extracts text once per file (via `pdftotext`, which ships with poppler and
 * with MiKTeX on Windows) and keeps a small JSON index beside the workspace's
 * `.prometheus` folder, so a second search costs one file read.
 *
 * Two honest limits, both surfaced rather than papered over:
 *
 *   - without `pdftotext` there is no text, and the tool says which command
 *     installs it instead of returning an empty result that looks like "no
 *     match"
 *   - page numbers come from the extractor's form feeds; a PDF whose text layer
 *     is missing (a scan) produces nothing, and the index records that so the
 *     next search does not silently retry forever
 */

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { extname, join, relative } from "node:path";

export interface DatasheetEntry {
  path: string;
  pages: string[];
  /** Set when the file produced no text at all. */
  empty?: boolean;
}

export interface DatasheetHit {
  path: string;
  page: number;
  excerpt: string;
}

const CACHE_DIR = ".prometheus/datasheets";
const MAX_FILES = 200;
const MAX_BYTES = 80 * 1024 * 1024;

/** `pdftotext` on PATH, or null. */
export function findPdfExtractor(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("pdftotext", ["-v"], { windowsHide: true, timeout: 5_000 }, (error) => {
      // `pdftotext -v` exits non-zero on every version; the signal is whether
      // the executable ran at all.
      resolve((error as NodeJS.ErrnoException | null)?.code === "ENOENT" ? null : "pdftotext");
    });
  });
}

function cachePath(cwd: string, file: string): string {
  const key = createHash("sha1").update(file).digest("hex").slice(0, 16);
  return join(cwd, CACHE_DIR, `${key}.json`);
}

function extract(file: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      "pdftotext",
      ["-layout", file, "-"],
      { windowsHide: true, timeout: 120_000, maxBuffer: 64 * 1024 * 1024, encoding: "utf8" },
      (error, stdout) => resolve(error ? null : String(stdout)),
    );
  });
}

/**
 * Load or build one file's index.
 *
 * The cache is keyed by absolute path and invalidated by mtime+size, so a file
 * the user replaced is re-extracted while an unchanged one costs one read.
 */
async function indexFile(cwd: string, file: string): Promise<DatasheetEntry | null> {
  let info;
  try {
    info = statSync(file);
  } catch {
    return null;
  }
  if (info.size > MAX_BYTES) return null;
  const stamp = `${info.mtimeMs}:${info.size}`;
  const cache = cachePath(cwd, file);
  try {
    const cached = JSON.parse(readFileSync(cache, "utf8")) as DatasheetEntry & { stamp?: string };
    if (cached.stamp === stamp) return cached;
  } catch {
    /* no usable cache */
  }
  const text = await extract(file);
  if (text === null) return null;
  const pages = text.split("\f").map((page) => page.replace(/\r\n/g, "\n"));
  const entry: DatasheetEntry & { stamp?: string } = {
    path: relative(cwd, file).split("\\").join("/"),
    pages,
    ...(text.trim() ? {} : { empty: true }),
    stamp,
  };
  try {
    mkdirSync(join(cwd, CACHE_DIR), { recursive: true });
    writeFileSync(cache, JSON.stringify(entry), "utf8");
  } catch {
    /* the index is a cache; losing it costs time, not correctness */
  }
  return entry;
}

/** Every PDF under the workspace, capped so a huge tree is still cheap. */
export function datasheetFiles(cwd: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 6 || out.length >= MAX_FILES) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= MAX_FILES) return;
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
        continue;
      }
      if (extname(entry.name).toLowerCase() === ".pdf") out.push(full);
    }
  };
  walk(cwd, 0);
  return out;
}

export interface DatasheetSearch {
  hits: DatasheetHit[];
  /** Files that could not be indexed, with the reason. */
  skipped: { path: string; reason: string }[];
  extractor: string | null;
}

/**
 * Search every datasheet for a phrase.
 *
 * Matching is case-insensitive and whole-phrase; a page is reported once even
 * when the phrase appears several times on it, because the user wants the page.
 */
export async function searchDatasheets(cwd: string, query: string, limit = 12): Promise<DatasheetSearch> {
  const needle = query.trim().toLowerCase();
  const extractor = await findPdfExtractor();
  if (!needle) return { hits: [], skipped: [], extractor };
  if (!extractor) {
    return {
      hits: [],
      skipped: [{ path: ".", reason: "pdftotext is not installed (winget install oschwartz10612.Poppler, or use MiKTeX's copy)" }],
      extractor: null,
    };
  }
  const hits: DatasheetHit[] = [];
  const skipped: { path: string; reason: string }[] = [];
  for (const file of datasheetFiles(cwd)) {
    if (hits.length >= limit) break;
    const entry = await indexFile(cwd, file);
    if (!entry) {
      skipped.push({ path: relative(cwd, file), reason: "could not extract text (missing, too large, or unreadable)" });
      continue;
    }
    if (entry.empty) {
      skipped.push({ path: entry.path, reason: "the PDF has no text layer (scanned images cannot be searched)" });
      continue;
    }
    for (let page = 0; page < entry.pages.length; page++) {
      const at = entry.pages[page].toLowerCase().indexOf(needle);
      if (at < 0) continue;
      const start = Math.max(0, at - 120);
      const excerpt = entry.pages[page].slice(start, at + needle.length + 200).replace(/\s+/g, " ").trim();
      hits.push({ path: entry.path, page: page + 1, excerpt });
      break;
    }
  }
  return { hits, skipped, extractor };
}

/** One line per hit, for a tool result. */
export function formatDatasheetHits(result: DatasheetSearch): string {
  if (!result.extractor) {
    return `datasheet search is unavailable: ${result.skipped[0]?.reason ?? "no PDF extractor"}`;
  }
  const lines = result.hits.map((hit) => `${hit.path}:${hit.page}  ${hit.excerpt}`);
  for (const skip of result.skipped) lines.push(`(${skip.path}: ${skip.reason})`);
  return lines.length > 0 ? lines.join("\n") : "no datasheet in this workspace matched";
}

/** True when the workspace has at least one PDF that could hold a datasheet. */
export function hasDatasheets(cwd: string): boolean {
  return datasheetFiles(cwd).length > 0;
}
