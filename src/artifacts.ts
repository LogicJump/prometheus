/**
 * Artifacts: files the agent produced that are worth looking at rather than
 * reading as source — reports, HTML pages, diagrams, data tables.
 *
 * A file counts as an artifact when it has a previewable extension and the
 * session touched it. That keeps the list to what this conversation produced
 * instead of every markdown file in the repository.
 */

import { readdirSync, statSync, existsSync, readFileSync } from "node:fs";
import { join, relative, resolve, isAbsolute } from "node:path";

const PREVIEWABLE: Record<string, "markdown" | "html" | "svg" | "json" | "csv"> = {
  md: "markdown",
  markdown: "markdown",
  html: "html",
  htm: "html",
  svg: "svg",
  json: "json",
  csv: "csv",
};

export interface Artifact {
  path: string;
  kind: "markdown" | "html" | "svg" | "json" | "csv";
  size: number;
  modifiedAt: string;
}

export function artifactKind(path: string): Artifact["kind"] | null {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return PREVIEWABLE[ext] ?? null;
}

/**
 * @param candidates workspace-relative or absolute paths the session touched
 * @param since ISO timestamp; files older than this are not considered
 */
export function collectArtifacts(cwd: string, candidates: string[], since: string): Artifact[] {
  const sinceMs = new Date(since).getTime() || 0;
  const seen = new Set<string>();
  const out: Artifact[] = [];
  for (const candidate of candidates) {
    const abs = isAbsolute(candidate) ? resolve(candidate) : resolve(cwd, candidate);
    const rel = relative(resolve(cwd), abs);
    if (rel.startsWith("..") || isAbsolute(rel)) continue;
    if (seen.has(rel)) continue;
    seen.add(rel);
    const kind = artifactKind(rel);
    if (!kind || !existsSync(abs)) continue;
    try {
      const info = statSync(abs);
      if (!info.isFile() || info.mtimeMs < sinceMs) continue;
      out.push({
        path: rel.split("\\").join("/"),
        kind,
        size: info.size,
        modifiedAt: new Date(info.mtimeMs).toISOString(),
      });
    } catch {
      /* skip unreadable files */
    }
  }
  return out.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
}

/** Every previewable file in a directory, for the empty-state browser. */
export function artifactCandidates(dir: string, depth = 0): string[] {
  if (depth > 6) return [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".git" || entry.name === ".prometheus") continue;
    if (entry.isDirectory()) out.push(...artifactCandidates(join(dir, entry.name), depth + 1));
    else if (artifactKind(entry.name)) out.push(join(dir, entry.name));
  }
  return out;
}

const MAX_ARTIFACT_BYTES = 512 * 1024;

export interface ArtifactContent {
  path: string;
  kind: Artifact["kind"];
  content: string;
  truncated: boolean;
}

export function readArtifact(cwd: string, relPath: string): ArtifactContent {
  const abs = resolve(cwd, relPath);
  const rel = relative(resolve(cwd), abs);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`path escapes the workspace: ${relPath}`);
  const kind = artifactKind(relPath);
  if (!kind) throw new Error(`not a previewable artifact: ${relPath}`);
  if (!existsSync(abs)) throw new Error(`file not found: ${relPath}`);
  const text = readFileSync(abs, "utf8");
  return {
    path: relPath,
    kind,
    content: text.length > MAX_ARTIFACT_BYTES ? text.slice(0, MAX_ARTIFACT_BYTES) : text,
    truncated: text.length > MAX_ARTIFACT_BYTES,
  };
}

/** Small CSV parser: quoted fields, escaped quotes, CRLF. */
export function parseCsv(text: string, limit = 500): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length && rows.length < limit; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((cell) => cell !== "")) rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    if (row.some((cell) => cell !== "")) rows.push(row);
  }
  return rows;
}
