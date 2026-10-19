/**
 * Workers that outlive the turn that started them.
 *
 * A long task — wait for CI, run the full suite five times, poll a device —
 * does not fit inside one `bash` call: the tool has a timeout and the user
 * wants their prompt back. A background worker runs in this process after the
 * turn returns, appends a report to the conversation when it finishes, and
 * writes its own log so `prometheus logs <id>` works from another terminal.
 *
 * The registry is deliberately small. It owns:
 *
 *   - one record per worker (id, kind, label, state, times, log path)
 *   - an ordered, size-capped log on disk, written by the worker itself
 *   - cancellation, and a report that says whether the work finished or was cut
 *
 * It does not own the work. The caller passes a function; this module only
 * tracks and records. That keeps it testable without spawning anything.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { CONFIG_HOME } from "./config.ts";

export type WorkerState = "running" | "done" | "failed" | "cancelled";

/**
 * Workers started by an agent tool, written by the `work` entry point.
 *
 * A tool cannot keep a spawn alive after its turn: the pipeline aborts running
 * commands when the turn ends. Launching a separate process that owns the
 * command is what makes "start this and tell me later" honest.
 */
export interface DetachedWorkerSpec {
  command: string;
  cwd: string;
  /** Where a report goes when it finishes, so the caller can surface it. */
  note?: string;
}

/** Start `bin/work.js` detached and return its worker id. */
export function startDetachedWorker(spec: DetachedWorkerSpec): string {
  const worker = startWorker("bash", spec.command);
  const entry = join(process.cwd(), "bin", "work.js");
  const child = spawn(process.execPath, [entry, "--worker-id", worker.id, "--", spec.command], {
    cwd: spec.cwd,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: process.env,
  });
  child.unref();
  return worker.id;
}

export interface WorkerRecord {
  id: string;
  kind: "bash" | "subagent" | "goal" | "task";
  label: string;
  state: WorkerState;
  startedAt: string;
  endedAt?: string;
  /** One-line outcome for the list; the log holds the detail. */
  summary?: string;
  /** Absolute path to this worker's log. */
  log: string;
}

export interface WorkerHandle {
  id: string;
  log: string;
  /** Append a line to the log; no-op after the worker settles. */
  write(text: string): void;
  /** Mark the worker finished. Called exactly once. */
  settle(state: Exclude<WorkerState, "running">, summary: string): void;
  readonly cancelled: boolean;
}

/** Cap a single worker's log so a chatty one cannot fill the disk. */
const LOG_LIMIT = 8 * 1024 * 1024;
const ROOT = join(CONFIG_HOME, "workers");

function workerDir(id: string): string {
  return join(ROOT, id);
}

export function listWorkers(): WorkerRecord[] {
  if (!existsSync(ROOT)) return [];
  const out: WorkerRecord[] = [];
  for (const id of readdirSafe(ROOT)) {
    try {
      out.push(JSON.parse(readFileSync(join(ROOT, id, "worker.json"), "utf8")) as WorkerRecord);
    } catch {
      /* a torn record from a crash is not worth surfacing */
    }
  }
  return out.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** Read the tail of a worker's log, for `prometheus logs` and an attach view. */
export function readWorkerLog(id: string, bytes = 64 * 1024): string | null {
  const file = join(workerDir(id), "worker.log");
  if (!existsSync(file)) return null;
  try {
    const size = statSync(file).size;
    const text = readFileSync(file, "utf8");
    if (size <= bytes) return text;
    return `… ${Math.round((size - bytes) / 1024)} KiB trimmed …\n${text.slice(text.length - bytes)}`;
  } catch {
    return null;
  }
}

export function workerRecord(id: string): WorkerRecord | null {
  try {
    return JSON.parse(readFileSync(join(workerDir(id), "worker.json"), "utf8")) as WorkerRecord;
  } catch {
    return null;
  }
}

/** The worker's log path, whether or not the log exists yet. */
export function workerLogPath(id: string): string {
  const record = workerRecord(id);
  return record?.log ?? join(workerDir(id), "worker.log");
}

/** Append one line to a worker's log from a process that did not start it. */
export function appendWorkerLog(id: string, line: string): void {
  try {
    appendFileSync(workerLogPath(id), `${line}\n`, "utf8");
  } catch {
    /* the log is evidence, not the work */
  }
}

/**
 * Mark a worker finished from the process that ran it.
 *
 * The detached child owns its record; the process that started it only wrote
 * the initial `running` state. This is the child's way of closing it.
 */
export function finishWorker(
  id: string,
  state: Exclude<WorkerState, "running">,
  summary: string,
): void {
  const record = workerRecord(id);
  if (!record) return;
  writeRecord({
    ...record,
    state,
    endedAt: new Date().toISOString(),
    summary: summary.slice(0, 400),
  });
}

/**
 * Register a worker and return the handle it writes through.
 *
 * The record is written before the work starts, so a process killed mid-worker
 * leaves evidence of what was running rather than an empty folder. Such a
 * record stays `running` on disk; `sweepWorkers` closes it at next startup.
 */
export function startWorker(kind: WorkerRecord["kind"], label: string): WorkerHandle {
  const id = `w-${new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-")}-${randomBytes(3).toString("hex")}`;
  mkdirSync(workerDir(id), { recursive: true });
  const record: WorkerRecord = {
    id,
    kind,
    label: label.slice(0, 200),
    state: "running",
    startedAt: new Date().toISOString(),
    log: join(workerDir(id), "worker.log"),
  };
  writeRecord(record);
  writeFileSync(record.log, "", "utf8");

  let settled = false;
  let cancelled = false;
  let bytes = 0;
  return {
    id,
    log: record.log,
    get cancelled() {
      return cancelled;
    },
    write(text: string) {
      if (settled || bytes >= LOG_LIMIT) return;
      const chunk = `${text}\n`;
      bytes += Buffer.byteLength(chunk, "utf8");
      try {
        appendFileSync(record.log, chunk, "utf8");
      } catch {
        /* the log is evidence, not the work */
      }
    },
    settle(state, summary) {
      if (settled) return;
      settled = true;
      record.state = state;
      record.endedAt = new Date().toISOString();
      record.summary = summary.slice(0, 400);
      writeRecord(record);
    },
  };
}

function writeRecord(record: WorkerRecord): void {
  try {
    mkdirSync(workerDir(record.id), { recursive: true });
    writeFileSync(join(workerDir(record.id), "worker.json"), JSON.stringify(record, null, 2), "utf8");
  } catch {
    /* best effort */
  }
}

/**
 * Close records left `running` by a previous process.
 *
 * The worker lived in the dead process; nothing is still working on it. Saying
 * so is better than a list that shows yesterday's run as active forever.
 */
export function sweepWorkers(): WorkerRecord[] {
  const swept: WorkerRecord[] = [];
  for (const record of listWorkers()) {
    if (record.state !== "running") continue;
    const next: WorkerRecord = {
      ...record,
      state: "failed",
      endedAt: record.endedAt ?? new Date().toISOString(),
      summary: "the process running this worker exited before it finished",
    };
    writeRecord(next);
    swept.push(next);
  }
  return swept;
}

/** One line per worker for a terminal list. */
export function formatWorkers(records: WorkerRecord[]): string[] {
  return records.map((record) => {
    const when = record.endedAt ?? record.startedAt;
    const took = record.endedAt
      ? `${Math.max(0, Math.round((Date.parse(record.endedAt) - Date.parse(record.startedAt)) / 1000))}s`
      : "running";
    return `${record.id}  ${record.state.padEnd(9)} ${took.padStart(7)}  ${record.kind.padEnd(8)} ${record.label}  ${when}${record.summary ? `  — ${record.summary}` : ""}`;
  });
}
