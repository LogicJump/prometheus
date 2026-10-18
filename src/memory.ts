/** File-backed memory: project facts and user preferences that persist across sessions. */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { CONFIG_HOME } from "./config.ts";

const MEMORY_DIR = join(CONFIG_HOME, "memory");
const MAX_ENTRY_CHARS = 4000;

export interface MemoryEntry {
  name: string;
  description: string;
  type: "user" | "feedback" | "project" | "reference";
  body: string;
}

function projectFile(): string {
  const hash = createHash("sha1").update(process.cwd()).digest("hex").slice(0, 12);
  return join(MEMORY_DIR, `${hash}.md`);
}

export function paths(): { global: string; project: string } {
  return { global: join(MEMORY_DIR, "global.md"), project: projectFile() };
}

function readSection(file: string): string {
  if (!existsSync(file)) return "";
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

/** Markdown that gets injected into the system prompt at session start. */
export function loadMemory(): string {
  const { global, project } = paths();
  const parts: string[] = [];
  const g = readSection(global).trim();
  const p = readSection(project).trim();
  if (g) parts.push(`## About the user (global)\n${g}`);
  if (p) parts.push(`## Project memory\n${p}`);
  return parts.join("\n\n");
}

export interface MemorySection {
  name: string;
  description: string;
  body: string;
}

/** Split one memory file into its `### name` blocks. */
export function readMemorySections(scope: "global" | "project"): MemorySection[] {
  const file = scope === "project" ? paths().project : paths().global;
  const text = readSection(file);
  const out: MemorySection[] = [];
  const pattern = /^###\s+(.+)\n(?:_(.+)_\n)?\n?([\s\S]*?)(?=\n###\s|\s*$)/gm;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    out.push({
      name: match[1].trim(),
      description: (match[2] ?? "").trim(),
      body: match[3].trim(),
    });
  }
  return out;
}

/** Remove one `### name` block; the file stays even when it empties. */
export function deleteMemory(scope: "global" | "project", name: string): void {
  const file = scope === "project" ? paths().project : paths().global;
  if (!existsSync(file)) return;
  const text = readSection(file);
  const marker = `### ${name}`;
  const start = text.indexOf(marker);
  if (start < 0) return;
  const next = text.indexOf("\n### ", start + marker.length);
  const updated = (text.slice(0, start) + (next >= 0 ? text.slice(next + 1) : "")).trim();
  writeFileSync(file, updated ? `${updated}\n` : "", "utf8");
}

export function saveMemory(entry: MemoryEntry): string {
  mkdirSync(MEMORY_DIR, { recursive: true });
  const file = entry.type === "project" ? paths().project : paths().global;
  const body = entry.body.slice(0, MAX_ENTRY_CHARS);
  const block = `\n### ${entry.name}\n_${entry.description}_\n\n${body}\n`;
  const existing = readSection(file);
  const marker = `### ${entry.name}`;
  let updated: string;
  if (existing.includes(marker)) {
    const start = existing.indexOf(marker);
    const nextHeading = existing.indexOf("\n### ", start + marker.length);
    updated = existing.slice(0, start) + block.trimStart() + (nextHeading >= 0 ? existing.slice(nextHeading) : "");
  } else {
    updated = `${existing.trimEnd()}\n${block}`;
  }
  writeFileSync(file, updated.trimStart(), "utf8");
  return file;
}
