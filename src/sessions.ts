/**
 * Session persistence: one append-only, generation-per-file JSONL transcript.
 *
 * A session lives in `~/.prometheus/sessions/<id>/` as:
 *
 *   meta.json              title, flags, timestamps, model, workspace
 *   messages.0001.jsonl    one JSON message per line, in order
 *   messages.0002.jsonl    (only after a compaction split the history)
 *
 * Append-only is the contract: `appendMessages` writes only new records and
 * never rewrites existing ones, so a crash mid-turn loses at most the last
 * line, and two writers (desktop host, CLI) cannot corrupt each other's
 * history. When compaction rewrites the conversation, the writer starts a new
 * generation file instead of editing the old one: earlier generations stay on
 * disk as an audit trail of what the model actually saw.
 *
 * Legacy single-file sessions (`<id>.json`) are still read and are migrated
 * to the directory layout on first write.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { SESSIONS_DIR } from "./config.ts";
import { sessionLockHolder, type SessionHolder } from "./sessionLock.ts";
import type { BoardSelection, ChatMessage } from "./types.ts";

export interface SessionFile {
  id: string;
  cwd: string;
  model: string;
  baseUrl: string;
  createdAt: string;
  updatedAt: string;
  messages: ChatMessage[];
  /** User-chosen title; falls back to the first message. */
  title?: string;
  pinned?: boolean;
  archived?: boolean;
  /** Highest generation on disk; internal, maintained by the writer. */
  generation?: number;
  /** Last known task state, shown as a dot in the sidebar. */
  status?: SessionStatus;
  /**
   * The settings the conversation was running with.
   *
   * A resumed session used to come back on whatever the current config said,
   * so a plan-mode investigation reopened in auto mode and a concise reply
   * style was forgotten. Only values the user actually set are stored; the
   * caller decides whether to apply them.
   */
  mode?: "ask" | "auto" | "plan";
  effort?: "auto" | "low" | "medium" | "high";
  sandbox?: "off" | "enforce";
  networkPolicy?: "off" | "proxy" | "open";
  /** Board selection in force when the session was last used. */
  board?: BoardSelection;
}

/**
 * The task state of a conversation. `needs-input` is set while a permission
 * prompt is open, which is the only state a user can be blocking without
 * having asked a question.
 */
export type SessionStatus = "ready" | "working" | "needs-input" | "error";

export interface SessionMeta {
  id: string;
  cwd: string;
  model: string;
  baseUrl: string;
  createdAt: string;
  updatedAt: string;
  title?: string;
  pinned?: boolean;
  archived?: boolean;
  generation: number;
  /** Message count at the time the meta was last written. */
  messageCount: number;
  /** Hash of the last stored message, so an append can verify its prefix in O(1). */
  lastHash?: string;
  status?: SessionStatus;
  mode?: "ask" | "auto" | "plan";
  effort?: "auto" | "low" | "medium" | "high";
  sandbox?: "off" | "enforce";
  networkPolicy?: "off" | "proxy" | "open";
  board?: BoardSelection;
}

function hashMessage(message: ChatMessage): string {
  return createHash("sha1").update(JSON.stringify(message)).digest("hex").slice(0, 16);
}

function sessionDir(id: string): string {
  return join(SESSIONS_DIR, id);
}

function legacyFile(id: string): string {
  return join(SESSIONS_DIR, `${id}.json`);
}

function generationFile(id: string, generation: number): string {
  return join(sessionDir(id), `messages.${String(generation).padStart(4, "0")}.jsonl`);
}

export function newSessionId(): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
  const rand = Math.random().toString(36).slice(2, 6);
  return `${stamp}-${rand}`;
}

function readMeta(id: string): SessionMeta | null {
  try {
    return JSON.parse(readFileSync(join(sessionDir(id), "meta.json"), "utf8")) as SessionMeta;
  } catch {
    return null;
  }
}

function writeMeta(meta: SessionMeta): void {
  mkdirSync(sessionDir(meta.id), { recursive: true });
  writeFileSync(join(sessionDir(meta.id), "meta.json"), JSON.stringify(meta, null, 2), "utf8");
}

/** Generation files present for a session, ascending. */
function generations(id: string): number[] {
  const dir = sessionDir(id);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((file) => /^messages\.(\d+)\.jsonl$/.exec(file))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => Number(match[1]))
    .sort((a, b) => a - b);
}

/** Parse one generation file; a truncated final line is skipped. */
function readGeneration(id: string, generation: number): ChatMessage[] {
  let text: string;
  try {
    text = readFileSync(generationFile(id, generation), "utf8");
  } catch {
    return [];
  }
  const out: ChatMessage[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as ChatMessage);
    } catch {
      /* a torn write from a crash - drop the partial record */
    }
  }
  return out;
}

/**
 * The conversation as stored: the newest generation is a full snapshot, so
 * earlier generations are audit history, not part of the live transcript.
 */
export function loadMessages(id: string): ChatMessage[] {
  const all = generations(id);
  if (all.length === 0) return [];
  return readGeneration(id, all[all.length - 1]);
}

/** Every generation's messages, oldest first, for inspection and tests. */
export function loadAllGenerations(id: string): ChatMessage[][] {
  return generations(id).map((generation) => readGeneration(id, generation));
}

/** Start a new generation (compaction rewrote the conversation). */
function startGeneration(id: string, messages: ChatMessage[], meta: SessionMeta): number {
  const next = meta.generation + 1;
  mkdirSync(sessionDir(id), { recursive: true });
  writeFileSync(generationFile(id, next), messages.map((message) => `${JSON.stringify(message)}\n`).join(""), "utf8");
  meta.lastHash = messages.length > 0 ? hashMessage(messages[messages.length - 1]) : undefined;
  return next;
}

/**
 * Replace the stored conversation. Only called when compaction rewrote the
 * window (or a caller explicitly wants a rewrite); appends are the norm.
 */
export function replaceMessages(id: string, messages: ChatMessage[]): void {
  const meta = readMeta(id);
  if (!meta) return;
  meta.generation = startGeneration(id, messages, meta);
  meta.messageCount = messages.length;
  meta.updatedAt = new Date().toISOString();
  writeMeta(meta);
}

/**
 * Append new messages to the newest generation and refresh the meta.
 * Returns the number of messages appended.
 */
export function appendMessages(id: string, messages: ChatMessage[]): number {
  const meta = readMeta(id);
  if (!meta || messages.length === 0) return 0;
  mkdirSync(sessionDir(id), { recursive: true });
  const payload = messages.map((message) => `${JSON.stringify(message)}\n`).join("");
  appendFileSync(generationFile(id, meta.generation), payload, "utf8");
  meta.messageCount += messages.length;
  meta.lastHash = hashMessage(messages[messages.length - 1]);
  meta.updatedAt = new Date().toISOString();
  writeMeta(meta);
  return messages.length;
}

/**
 * Save a session. New sessions get a directory; existing ones append only the
 * messages past `messageCount`, and a shorter conversation (compaction) starts
 * a new generation.
 *
 * A session another process has claimed is not written to. Both callers that
 * write (the desktop host, the CLI) take the lock first; this check is the
 * backstop for a caller that did not, because the failure mode — two writers
 * interleaving appends and disagreeing about `messageCount` — corrupts a
 * conversation rather than failing loudly.
 */
export function saveSession(session: SessionFile): void {
  const now = new Date().toISOString();
  session.updatedAt = now;
  const existing = readMeta(session.id);
  if (existing) {
    const holder = sessionLockHolder(session.id);
    if (holder && holder.pid !== process.pid) throw new ForeignSessionWriter(session.id, holder);
  }

  if (!existing) {
    const createdAt = session.createdAt || now;
    const meta: SessionMeta = {
      id: session.id,
      cwd: session.cwd,
      model: session.model,
      baseUrl: session.baseUrl,
      createdAt,
      updatedAt: now,
      title: session.title,
      pinned: session.pinned,
      archived: session.archived,
      generation: 1,
      messageCount: session.messages.length,
      status: session.status,
      ...sessionSettings(session),
    };
    mkdirSync(sessionDir(session.id), { recursive: true });
    writeFileSync(
      generationFile(session.id, 1),
      session.messages.map((message) => `${JSON.stringify(message)}\n`).join(""),
      "utf8",
    );
    if (session.messages.length > 0) meta.lastHash = hashMessage(session.messages[session.messages.length - 1]);
    writeMeta(meta);
    session.generation = 1;
    // A migrated legacy file must not shadow the directory.
    try {
      rmSync(legacyFile(session.id), { force: true });
    } catch {
      /* best effort */
    }
    return;
  }

  const meta: SessionMeta = {
    ...existing,
    cwd: session.cwd ?? existing.cwd,
    model: session.model ?? existing.model,
    baseUrl: session.baseUrl ?? existing.baseUrl,
    title: session.title !== undefined ? session.title : existing.title,
    pinned: session.pinned !== undefined ? session.pinned : existing.pinned,
    archived: session.archived !== undefined ? session.archived : existing.archived,
    status: session.status !== undefined ? session.status : existing.status,
    ...sessionSettings(session),
    updatedAt: now,
  };
  const stored = loadMessages(session.id);
  const identical = sameMessages(stored, session.messages);
  if (identical) {
    // Nothing changed; only the meta timestamp moves.
  } else if (session.messages.length < stored.length) {
    // The conversation shrank: compaction replaced it.
    meta.generation = startGeneration(session.id, session.messages, meta);
    meta.messageCount = session.messages.length;
  } else {
    // Append only the new tail. The stored prefix must be untouched; the
    // meta's last-message hash catches a rewritten history in O(1), and a
    // full compare is the fallback for sessions written before the hash.
    const sameTail =
      meta.lastHash && stored.length > 0
        ? hashMessage(stored[stored.length - 1]) === meta.lastHash && sameMessages(stored, session.messages.slice(0, stored.length))
        : sameMessages(stored, session.messages.slice(0, stored.length));
    if (sameTail) {
      const fresh = session.messages.slice(stored.length);
      appendFileSync(
        generationFile(session.id, meta.generation),
        fresh.map((message) => `${JSON.stringify(message)}\n`).join(""),
        "utf8",
      );
      meta.messageCount = session.messages.length;
    } else {
      meta.generation = startGeneration(session.id, session.messages, meta);
      meta.messageCount = session.messages.length;
    }
  }
  if (session.messages.length > 0) meta.lastHash = hashMessage(session.messages[session.messages.length - 1]);
  writeMeta(meta);
  session.generation = meta.generation;
}

/**
 * Raised when a session is owned by a different process. Callers can present
 * `holder` to the user instead of a generic write failure.
 */
export class ForeignSessionWriter extends Error {
  readonly sessionId: string;
  readonly holder: SessionHolder;

  constructor(sessionId: string, holder: SessionHolder) {
    super(
      `session ${sessionId} is open in another process (pid ${holder.pid}` +
        `${holder.label ? `, ${holder.label}` : ""}); refusing to write a transcript someone else owns`,
    );
    this.name = "ForeignSessionWriter";
    this.sessionId = sessionId;
    this.holder = holder;
  }
}

/** The runtime settings a session carries, when the caller supplied them. */
function sessionSettings(session: SessionFile): Partial<SessionMeta> {
  const out: Partial<SessionMeta> = {};
  if (session.mode !== undefined) out.mode = session.mode;
  if (session.effort !== undefined) out.effort = session.effort;
  if (session.sandbox !== undefined) out.sandbox = session.sandbox;
  if (session.networkPolicy !== undefined) out.networkPolicy = session.networkPolicy;
  if (session.board !== undefined) out.board = session.board;
  return out;
}

function sameMessages(a: ChatMessage[], b: ChatMessage[]): boolean {  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index++) {
    if (JSON.stringify(a[index]) !== JSON.stringify(b[index])) return false;
  }
  return true;
}

/** Load a session by id or unique prefix. */
export function loadSession(idOrPrefix: string): SessionFile | null {
  if (!existsSync(SESSIONS_DIR)) return null;
  const entries = readdirSync(SESSIONS_DIR);
  const dirs = entries.filter((entry) => existsSync(join(SESSIONS_DIR, entry, "meta.json")));
  const dir = dirs.find((entry) => entry === idOrPrefix) ?? dirs.find((entry) => entry.startsWith(idOrPrefix));
  if (dir) {
    const meta = readMeta(dir);
    if (!meta) return null;
    return {
      id: meta.id,
      cwd: meta.cwd,
      model: meta.model,
      baseUrl: meta.baseUrl,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
      messages: loadMessages(meta.id),
      title: meta.title,
      pinned: meta.pinned,
      archived: meta.archived,
      generation: meta.generation,
      status: meta.status,
      mode: meta.mode,
      effort: meta.effort,
      sandbox: meta.sandbox,
      networkPolicy: meta.networkPolicy,
      board: meta.board,
    };
  }

  // Legacy single-file session.
  const files = entries.filter((entry) => entry.endsWith(".json"));
  const exact = files.find((file) => file === `${idOrPrefix}.json`);
  const match = exact ?? files.find((file) => file.startsWith(idOrPrefix));
  if (!match) return null;
  try {
    return JSON.parse(readFileSync(join(SESSIONS_DIR, match), "utf8")) as SessionFile;
  } catch {
    return null;
  }
}

/**
 * Load the newest session for a workspace (the `--continue` case).
 *
 * `listSessions` floats pinned sessions to the top, which is the right order
 * for the sidebar and the wrong one here: `--continue` means "the one I was
 * just in", so pinned-ness is ignored and recency decides.
 */
export function latestSession(cwd = process.cwd()): SessionFile | null {
  const candidates = listSessions(false)
    .filter((session) => session.cwd === cwd && !session.archived)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return candidates.length > 0 ? loadSession(candidates[0].id) : null;
}

export interface SessionSummary {
  id: string;
  cwd: string;
  updatedAt: string;
  summary: string;
  title?: string;
  pinned?: boolean;
  archived?: boolean;
  status?: SessionStatus;
}

/** Rewrite flags on a saved session without touching its messages. */
export function updateSessionFlags(
  id: string,
  patch: { title?: string | null; pinned?: boolean; archived?: boolean; status?: SessionStatus },
): SessionFile | null {
  const session = loadSession(id);
  if (!session) return null;
  const meta = readMeta(session.id);
  if (meta) {
    if (patch.title !== undefined) meta.title = patch.title?.trim() || undefined;
    if (patch.pinned !== undefined) meta.pinned = patch.pinned;
    if (patch.archived !== undefined) meta.archived = patch.archived;
    if (patch.status !== undefined) meta.status = patch.status;
    meta.updatedAt = new Date().toISOString();
    writeMeta(meta);
    return loadSession(session.id);
  }
  // Legacy file: keep the old shape for a session that was never migrated.
  if (patch.title !== undefined) session.title = patch.title?.trim() || undefined;
  if (patch.pinned !== undefined) session.pinned = patch.pinned;
  if (patch.archived !== undefined) session.archived = patch.archived;
  if (patch.status !== undefined) session.status = patch.status;
  saveSession(session);
  return session;
}

export function deleteSessionFile(id: string): boolean {
  const session = loadSession(id);
  if (!session) return false;
  try {
    rmSync(sessionDir(session.id), { recursive: true, force: true });
    rmSync(legacyFile(session.id), { force: true });
    return true;
  } catch {
    return false;
  }
}

function firstUserText(messages: ChatMessage[]): string {
  for (const message of messages) {
    if (message.role !== "user") continue;
    if (typeof message.content === "string") return message.content;
    return message.content.filter((part) => part.type === "text").map((part) => part.text).join(" ");
  }
  return "";
}

export function listSessions(cwdOnly: boolean, includeArchived = false): SessionSummary[] {
  if (!existsSync(SESSIONS_DIR)) return [];
  const out: SessionSummary[] = [];

  // Directory-based sessions read only meta.json plus the first generation
  // (for the preview line), so listing stays fast with many sessions.
  for (const entry of readdirSync(SESSIONS_DIR)) {
    const meta = readMeta(entry);
    if (!meta) continue;
    if (cwdOnly && meta.cwd !== process.cwd()) continue;
    if (meta.archived && !includeArchived) continue;
    const preview = firstUserText(readGeneration(meta.id, 1)).replace(/\s+/g, " ").slice(0, 100);
    out.push({
      id: meta.id,
      cwd: meta.cwd,
      updatedAt: meta.updatedAt,
      summary: preview || "(no messages)",
      title: meta.title,
      pinned: meta.pinned,
      archived: meta.archived,
      status: meta.status,
    });
  }

  // Legacy single-file sessions.
  for (const file of readdirSync(SESSIONS_DIR).filter((entry) => entry.endsWith(".json"))) {
    try {
      const session = JSON.parse(readFileSync(join(SESSIONS_DIR, file), "utf8")) as SessionFile;
      if (cwdOnly && session.cwd !== process.cwd()) continue;
      if (session.archived && !includeArchived) continue;
      out.push({
        id: session.id,
        cwd: session.cwd,
        updatedAt: session.updatedAt,
        summary: firstUserText(session.messages).replace(/\s+/g, " ").slice(0, 100) || "(no messages)",
        title: session.title,
        pinned: session.pinned,
        archived: session.archived,
        status: session.status,
      });
    } catch {
      /* skip unreadable sessions */
    }
  }

  // Pinned sessions stay on top; everything else by recency.
  return out.sort((a, b) => {
    if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;
    return b.updatedAt.localeCompare(a.updatedAt);
  });
}

/** Hash used for project-scoped config/memory lookups. */
export function projectKey(dir = process.cwd()): string {
  return createHash("sha1").update(dir).digest("hex").slice(0, 12);
}
