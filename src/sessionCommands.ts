/**
 * `prometheus session` commands: the terminal's half of the session store.
 *
 * The desktop app has a sidebar; a terminal has a list and a set of verbs. The
 * verbs match what the sidebar can do — fork, rename, archive, delete — so the
 * two front ends do not teach different models of what a session is.
 *
 * Selectors accept a full id or a unique prefix, because typing a whole id is
 * the kind of friction that makes people stop using saved sessions. An
 * ambiguous prefix lists the candidates instead of guessing.
 */

import { dirname, isAbsolute, join, resolve } from "node:path";
import { execFile } from "node:child_process";
import {
  deleteSessionFile,
  listSessions,
  loadSession,
  newSessionId,
  saveSession,
  updateSessionFlags,
  type SessionFile,
  type SessionSummary,
} from "./sessions.ts";
import { loadCheckpoints, restoreTo, type CheckpointEntry } from "./checkpoints.ts";
import { CONFIG_HOME } from "./config.ts";
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";

export type SelectResult =
  | { ok: true; session: SessionSummary }
  | { ok: false; error: string; candidates: SessionSummary[] };

/**
 * Resolve an id or prefix against the saved sessions.
 *
 * An exact id wins even when it is also a prefix of a longer one, which is the
 * only sane reading of "I typed the whole id".
 */
export function selectSession(selector: string, includeArchived = true): SelectResult {
  const all = listSessions(false, includeArchived);
  const exact = all.find((session) => session.id === selector);
  if (exact) return { ok: true, session: exact };
  const prefixed = all.filter((session) => session.id.startsWith(selector));
  if (prefixed.length === 1) return { ok: true, session: prefixed[0] };
  if (prefixed.length === 0) return { ok: false, error: `no session matches "${selector}"`, candidates: [] };
  return { ok: false, error: `"${selector}" matches ${prefixed.length} sessions`, candidates: prefixed.slice(0, 12) };
}

/** A session with the same messages, under a fresh id. The original is untouched. */
export function forkSessionRecord(id: string, title?: string): { ok: true; id: string } | { ok: false; error: string; candidates?: SessionSummary[] } {
  const found = selectSession(id);
  if (!found.ok) return { ok: false, error: found.error, candidates: found.candidates };
  const source = loadSession(found.session.id);
  if (!source) return { ok: false, error: `session ${found.session.id} could not be read` };
  const next = newSessionId();
  const forked: SessionFile = {
    ...source,
    id: next,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    title: title?.trim() || (source.title ? `${source.title} (fork)` : undefined),
    generation: undefined,
  };
  saveSession(forked);
  return { ok: true, id: next };
}

export interface UsageExportRow {
  at: string;
  sessionId: string;
  cwd: string;
  model: string;
  source: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  cost: number | null;
}

/** One row per stored request, for CSV/JSON export. */
export function usageRows(records: { at: string; sessionId: string; cwd: string; model: string; inputTokens: number; outputTokens: number; cachedTokens: number; cacheWriteTokens?: number; cost?: number | null; source?: string }[]): UsageExportRow[] {
  return records.map((record) => ({
    at: record.at,
    sessionId: record.sessionId,
    cwd: record.cwd,
    model: record.model,
    source: record.source ?? "main",
    inputTokens: record.inputTokens,
    outputTokens: record.outputTokens,
    cachedTokens: record.cachedTokens ?? 0,
    cacheWriteTokens: record.cacheWriteTokens ?? 0,
    cost: record.cost ?? null,
  }));
}

const CSV_COLUMNS: (keyof UsageExportRow)[] = [
  "at",
  "sessionId",
  "cwd",
  "model",
  "source",
  "inputTokens",
  "outputTokens",
  "cachedTokens",
  "cacheWriteTokens",
  "cost",
];

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(rows: UsageExportRow[]): string {
  return [CSV_COLUMNS.join(","), ...rows.map((row) => CSV_COLUMNS.map((key) => csvCell(row[key])).join(","))].join("\n") + "\n";
}

/**
 * Write usage to a file. `.csv` and `.json` are the two formats a spreadsheet
 * and a script respectively can read; an unknown extension is refused rather
 * than guessed, because a file that says one thing and contains another is
 * worse than an error.
 */
export function writeUsageExport(path: string, rows: UsageExportRow[]): { ok: boolean; error?: string; format?: "csv" | "json" } {
  const ext = path.toLowerCase().endsWith(".csv") ? "csv" : path.toLowerCase().endsWith(".json") ? "json" : null;
  if (!ext) return { ok: false, error: `unknown export format for ${path}; use .csv or .json` };
  try {
    mkdirSync(dirname(resolve(path)), { recursive: true });
    writeFileSync(path, ext === "csv" ? toCsv(rows) : `${JSON.stringify(rows, null, 2)}\n`, "utf8");
    return { ok: true, format: ext };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

interface BaselineRecord {
  path: string;
  before: string | null;
}

function baselinePath(sessionId: string): string {
  return join(CONFIG_HOME, "baselines", `${sessionId}.json`);
}

/**
 * Record a file's content before the first turn touches it.
 *
 * The desktop host keeps this in memory, which is enough for a rewind inside
 * one window but not for `prometheus apply` in a new process. Writing the
 * baseline beside the checkpoints makes the diff of a finished session
 * reconstructible after the fact.
 */
export function saveBaseline(sessionId: string, files: Map<string, string | null>): void {
  try {
    const records: BaselineRecord[] = [...files.entries()].map(([path, before]) => ({ path, before }));
    mkdirSync(dirname(baselinePath(sessionId)), { recursive: true });
    writeFileSync(baselinePath(sessionId), JSON.stringify(records, null, 2), "utf8");
  } catch {
    /* the baseline is a convenience; never block a turn on it */
  }
}

export function loadBaseline(sessionId: string): BaselineRecord[] {
  try {
    return JSON.parse(readFileSync(baselinePath(sessionId), "utf8")) as BaselineRecord[];
  } catch {
    return [];
  }
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** Build a unified diff with three lines of context, the shape `git apply` takes. */
export function unifiedDiff(relativePath: string, before: string | null, after: string | null): string {
  // A trailing newline terminates the last line; splitting without dropping
  // it makes every hunk one line too long, and `git apply` rejects the patch.
  const linesOf = (text: string | null) =>
    text === null ? [] : (text.endsWith("\n") ? text.slice(0, -1) : text).replace(/\r\n/g, "\n").split("\n");
  const a = linesOf(before);
  const b = linesOf(after);
  const header = [`--- ${before === null ? "/dev/null" : `a/${relativePath}`}`, `+++ ${after === null ? "/dev/null" : `b/${relativePath}`}`];

  // A small LCS over lines, same shape as src/diff.ts, kept local so this
  // module has no dependency on the renderer's change model.
  const n = a.length;
  const m = b.length;
  const table: Uint32Array = new Uint32Array((n + 1) * (m + 1));
  const at = (i: number, j: number) => i * (m + 1) + j;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[at(i, j)] = a[i] === b[j] ? table[at(i + 1, j + 1)] + 1 : Math.max(table[at(i + 1, j)], table[at(i, j + 1)]);
    }
  }
  const ops: { kind: " " | "-" | "+"; text: string; oldNo: number; newNo: number }[] = [];
  let i = 0;
  let j = 0;
  let oldNo = 1;
  let newNo = 1;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: " ", text: a[i], oldNo: oldNo++, newNo: newNo++ });
      i++;
      j++;
    } else if (table[at(i + 1, j)] >= table[at(i, j + 1)]) {
      ops.push({ kind: "-", text: a[i], oldNo: oldNo++, newNo: newNo });
      i++;
    } else {
      ops.push({ kind: "+", text: b[j], oldNo: oldNo, newNo: newNo++ });
      j++;
    }
  }
  while (i < n) ops.push({ kind: "-", text: a[i++], oldNo: oldNo++, newNo: newNo });
  while (j < m) ops.push({ kind: "+", text: b[j++], oldNo: oldNo, newNo: newNo });

  const changed = ops.map((op, index) => (op.kind === " " ? -1 : index)).filter((index) => index >= 0);
  if (changed.length === 0) return "";
  const hunks: string[] = [...header];
  const CONTEXT = 3;
  let lastEnd = -1;
  for (const index of changed) {
    if (index <= lastEnd) continue;
    const from = Math.max(0, index - CONTEXT);
    let to = index;
    // Extend the hunk while the gap to the next change is small enough.
    for (const next of changed) {
      if (next <= to) continue;
      if (next - to <= CONTEXT * 2) to = next;
      else break;
    }
    const end = Math.min(ops.length - 1, to + CONTEXT);
    const slice = ops.slice(from, end + 1);
    const oldStart = slice.find((op) => op.kind !== "+")?.oldNo ?? 1;
    const newStart = slice.find((op) => op.kind !== "-")?.newNo ?? 1;
    const oldCount = slice.filter((op) => op.kind !== "+").length;
    const newCount = slice.filter((op) => op.kind !== "-").length;
    hunks.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (const op of slice) hunks.push(`${op.kind}${op.text}`);
    lastEnd = end;
  }
  return `${hunks.join("\n")}\n`;
}

/**
 * The last diff a session produced, reconstructed from its baseline.
 *
 * Returns an empty string when the session version has no baseline (it ran in
 * the desktop before baselines were written) — an empty patch is honest;
 * inventing one from the checkpoint log would produce a diff that does not
 * apply.
 */
export function sessionDiff(sessionId: string, root = process.cwd()): string {
  const records = loadBaseline(sessionId);
  const parts: string[] = [];
  for (const record of records) {
    const abs = isAbsolute(record.path) ? record.path : resolve(root, record.path);
    const after = readText(abs);
    if (after === record.before) continue;
    const relative = isAbsolute(record.path) ? record.path : record.path.split("\\").join("/");
    const diff = unifiedDiff(relative, record.before, after);
    if (diff) parts.push(diff);
  }
  return parts.join("");
}

/** `git apply` a patch, falling back to `patch -p1` where git is absent. */
export function applyPatch(patchFile: string, root = process.cwd()): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolvePromise) => {
    execFile("git", ["apply", "--3way", patchFile], { cwd: root, windowsHide: true, timeout: 60_000 }, (error, stdout, stderr) => {
      if (!error) return resolvePromise({ ok: true, output: String(stdout || "").trim() });
      // --3way needs blobs in the index; a plain apply handles a fresh tree.
      execFile("git", ["apply", patchFile], { cwd: root, windowsHide: true, timeout: 60_000 }, (retryError, retryOut, retryErr) => {
        const output = String(retryErr || retryOut || "").trim();
        resolvePromise({ ok: !retryError, output: output || String(error.message) });
      });
    });
  });
}

/** Format a checkpoint list for the terminal. */
export function formatCheckpoints(sessionId: string, entries: CheckpointEntry[], root = process.cwd()): string[] {
  if (entries.length === 0) return [`no checkpoints recorded for ${sessionId}`];
  return entries.map((entry, index) => {
    const when = entry.at.replace("T", " ").replace(/\..+/, "");
    const message = entry.messageIndex === undefined ? "" : `  msg ${entry.messageIndex}`;
    return `${String(index + 1).padStart(3)}. ${entry.id}  ${when}  ${entry.kind.padEnd(8)} ${entry.path}${message}`;
  });
}

export interface SessionCommandDeps {
  out: (text: string) => void;
  err: (text: string) => void;
}

/**
 * Run one `prometheus sessions …` subcommand. Returns an exit code.
 *
 * Kept out of bin/prometheus.js so it can be tested without spawning a
 * process, and so the argument parsing is one visible function rather than
 * spread through the entry point.
 */
export async function runSessionCommand(argv: string[], deps: SessionCommandDeps, options: { cwd?: string } = {}): Promise<number> {
  const [verb = "list", ...rest] = argv;
  const cwd = options.cwd ?? process.cwd();

  const pick = (selector: string | undefined): SessionSummary | null => {
    if (!selector) {
      deps.err("usage: prometheus sessions <verb> <session-id>");
      return null;
    }
    const found = selectSession(selector);
    if (found.ok) return found.session;
    deps.err(found.error);
    for (const candidate of found.candidates) {
      deps.out(`  ${candidate.id}  ${candidate.title ?? candidate.summary}`);
    }
    return null;
  };

  switch (verb) {
    case "list":
    case "ls": {
      const all = listSessions(false, rest.includes("--all") || rest.includes("--archived"));
      if (all.length === 0) {
        deps.out("no saved sessions");
        return 0;
      }
      for (const session of all) {
        const flags = [session.pinned ? "pinned" : "", session.archived ? "archived" : "", session.status ?? ""].filter(Boolean).join(",");
        deps.out(`${session.id}  ${session.updatedAt.replace("T", " ").replace(/\..+/, "")}  ${(session.title ?? session.summary).slice(0, 60)}${flags ? `  [${flags}]` : ""}`);
      }
      return 0;
    }
    case "fork": {
      const [selector, ...text] = rest;
      const source = pick(selector);
      if (!source) return 2;
      const forked = forkSessionRecord(source.id);
      if (!forked.ok) {
        deps.err(forked.error);
        return 2;
      }
      deps.out(`forked ${source.id} into ${forked.id}`);
      return 0;
    }
    case "rename": {
      const [selector, ...words] = rest;
      const source = pick(selector);
      if (!source) return 2;
      const title = words.join(" ").trim();
      if (!title) {
        deps.err("usage: prometheus sessions rename <id> <title>");
        return 2;
      }
      updateSessionFlags(source.id, { title });
      deps.out(`renamed ${source.id} to "${title}"`);
      return 0;
    }
    case "archive":
    case "unarchive": {
      const source = pick(rest[0]);
      if (!source) return 2;
      updateSessionFlags(source.id, { archived: verb === "archive" });
      deps.out(`${verb}d ${source.id}`);
      return 0;
    }
    case "delete":
    case "rm": {
      const source = pick(rest[0]);
      if (!source) return 2;
      if (!deleteSessionFile(source.id)) {
        deps.err(`could not delete ${source.id}`);
        return 1;
      }
      deps.out(`deleted ${source.id}`);
      return 0;
    }
    case "show": {
      const source = pick(rest[0]);
      if (!source) return 2;
      const session = loadSession(source.id);
      if (!session) {
        deps.err(`could not read ${source.id}`);
        return 1;
      }
      deps.out(`id: ${session.id}`);
      deps.out(`title: ${session.title ?? "(none)"}`);
      deps.out(`workspace: ${session.cwd}`);
      deps.out(`model: ${session.model}`);
      deps.out(`messages: ${session.messages.length}`);
      deps.out(`updated: ${session.updatedAt}`);
      if (session.goal) {
        deps.out(`goal: ${session.goal.kind} round ${session.goal.round}/${session.goal.maxRounds} — ${session.goal.text}`);
      }
      if (session.worktree) deps.out(`worktree: ${session.worktree.branch} at ${session.worktree.path}`);
      return 0;
    }
    case "checkpoints": {
      const source = pick(rest[0]);
      if (!source) return 2;
      const state = loadCheckpoints(source.id);
      const restoreIndex = rest.indexOf("--restore");
      if (restoreIndex >= 0) {
        const target = rest[restoreIndex + 1];
        if (!target) {
          deps.err("usage: prometheus sessions checkpoints <id> --restore <checkpoint-id|start>");
          return 2;
        }
        const result = restoreTo(source.id, target === "start" ? "start" : target);
        deps.out(`restored ${result.restored.length} file(s)`);
        for (const error of result.errors) deps.err(error);
        return result.errors.length > 0 ? 1 : 0;
      }
      for (const line of formatCheckpoints(source.id, state.entries, cwd)) deps.out(line);
      return 0;
    }
    case "apply": {
      const source = pick(rest[0]);
      if (!source) return 2;
      const patch = sessionDiff(source.id, cwd);
      if (!patch.trim()) {
        deps.err(`session ${source.id} has no recorded baseline, so there is no diff to apply`);
        return 1;
      }
      const file = join(process.env.TEMP || process.env.TMPDIR || ".", `prometheus-${source.id}.patch`);
      writeFileSync(file, patch, "utf8");
      const applied = await applyPatch(file, cwd);
      if (!applied.ok) {
        deps.err(`patch did not apply: ${applied.output}`);
        deps.err(`the patch is at ${file}`);
        return 1;
      }
      deps.out(`applied the last diff of ${source.id}`);
      return 0;
    }
    default:
      deps.err(`unknown session command: ${verb}`);
      deps.err("try: list, show, fork, rename, archive, unarchive, delete, checkpoints, apply");
      return 2;
  }
}
