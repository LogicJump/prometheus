/** Session persistence: one JSON file per session under ~/.prometheus/sessions. */

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { SESSIONS_DIR } from "./config.ts";
import type { ChatMessage } from "./llm.ts";

export interface SessionFile {
  id: string;
  cwd: string;
  model: string;
  baseUrl: string;
  createdAt: string;
  updatedAt: string;
  messages: ChatMessage[];
}

function fileFor(id: string): string {
  return join(SESSIONS_DIR, `${id}.json`);
}

export function newSessionId(): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
  const rand = Math.random().toString(36).slice(2, 6);
  return `${stamp}-${rand}`;
}

export function saveSession(session: SessionFile): void {
  mkdirSync(SESSIONS_DIR, { recursive: true });
  session.updatedAt = new Date().toISOString();
  writeFileSync(fileFor(session.id), JSON.stringify(session, null, 2), "utf8");
}

export function loadSession(idOrPrefix: string): SessionFile | null {
  if (!existsSync(SESSIONS_DIR)) return null;
  const files = readdirSync(SESSIONS_DIR).filter((f) => f.endsWith(".json"));
  const exact = files.find((f) => f === `${idOrPrefix}.json`);
  const match = exact ?? files.find((f) => f.startsWith(idOrPrefix));
  if (!match) return null;
  try {
    return JSON.parse(readFileSync(join(SESSIONS_DIR, match), "utf8")) as SessionFile;
  } catch {
    return null;
  }
}

export interface SessionSummary {
  id: string;
  cwd: string;
  updatedAt: string;
  summary: string;
}

export function listSessions(cwdOnly: boolean): SessionSummary[] {
  if (!existsSync(SESSIONS_DIR)) return [];
  const out: SessionSummary[] = [];
  for (const file of readdirSync(SESSIONS_DIR).filter((f) => f.endsWith(".json"))) {
    try {
      const session = JSON.parse(readFileSync(join(SESSIONS_DIR, file), "utf8")) as SessionFile;
      if (cwdOnly && session.cwd !== process.cwd()) continue;
      const firstUser = session.messages.find((m) => m.role === "user");
      const summary = typeof firstUser?.content === "string" ? firstUser.content : "(no messages)";
      out.push({
        id: session.id,
        cwd: session.cwd,
        updatedAt: session.updatedAt,
        summary: summary.replace(/\s+/g, " ").slice(0, 100),
      });
    } catch {
      /* skip unreadable sessions */
    }
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** Hash used for project-scoped config/memory lookups. */
export function projectKey(dir = process.cwd()): string {
  return createHash("sha1").update(dir).digest("hex").slice(0, 12);
}
