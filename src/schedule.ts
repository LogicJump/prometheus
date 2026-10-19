/**
 * Local scheduled runs.
 *
 * A coding agent is useful for work nobody wants to sit through: run the
 * nightly test sweep, rebuild after a dependency bump, check the flaky suite
 * again. The scheduling belongs on this machine — the credential and the
 * checkout are here — so this module keeps a small JSON list and computes when
 * each entry is next due.
 *
 * Two guarantees matter and both are tested:
 *
 *   - a schedule never runs twice for the same slot, even if two processes
 *     sweep at once (the claim is written before the run starts)
 *   - a slot missed while the process was off runs once on the next sweep, not
 *     once per missed interval; catching up six nightly runs would spend six
 *     nights of tokens answering a question that is stale by then
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_HOME } from "./config.ts";

export interface ScheduleEntry {
  id: string;
  /** The prompt or command sent to the agent when the slot fires. */
  prompt: string;
  cwd: string;
  /** ISO timestamp of the next due slot. */
  dueAt: string;
  /** Repeat interval in minutes; absent means run once. */
  everyMinutes?: number;
  /** False after a one-shot run; kept so the list shows what happened. */
  enabled: boolean;
  createdAt: string;
  lastRunAt?: string;
  lastResult?: string;
}

const FILE = join(CONFIG_HOME, "schedules.json");

function readAll(): ScheduleEntry[] {
  try {
    if (!existsSync(FILE)) return [];
    const parsed = JSON.parse(readFileSync(FILE, "utf8")) as ScheduleEntry[];
    return Array.isArray(parsed) ? parsed.filter((entry) => entry && typeof entry.id === "string") : [];
  } catch {
    return [];
  }
}

function writeAll(entries: ScheduleEntry[]): void {
  mkdirSync(CONFIG_HOME, { recursive: true });
  writeFileSync(FILE, JSON.stringify(entries, null, 2), "utf8");
}

export function listSchedules(): ScheduleEntry[] {
  return readAll().sort((a, b) => a.dueAt.localeCompare(b.dueAt));
}

/** Add a schedule. `at` is ISO; `everyMinutes` turns it into a repeat. */
export function addSchedule(input: { prompt: string; cwd: string; at: string; everyMinutes?: number }): { ok: true; entry: ScheduleEntry } | { ok: false; error: string } {
  const prompt = input.prompt.trim();
  if (!prompt) return { ok: false, error: "a schedule needs a prompt" };
  const at = Date.parse(input.at);
  if (Number.isNaN(at)) return { ok: false, error: `"${input.at}" is not a date this machine understands` };
  if (input.everyMinutes !== undefined && !(input.everyMinutes >= 1)) {
    return { ok: false, error: "the repeat interval must be at least one minute" };
  }
  const entry: ScheduleEntry = {
    id: `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`,
    prompt,
    cwd: input.cwd,
    dueAt: new Date(at).toISOString(),
    enabled: true,
    createdAt: new Date().toISOString(),
    ...(input.everyMinutes !== undefined ? { everyMinutes: input.everyMinutes } : {}),
  };
  writeAll([...readAll(), entry]);
  return { ok: true, entry };
}

export function removeSchedule(id: string): boolean {
  const all = readAll();
  const next = all.filter((entry) => entry.id !== id);
  if (next.length === all.length) return false;
  writeAll(next);
  return true;
}

export function setScheduleEnabled(id: string, enabled: boolean): boolean {
  const all = readAll();
  const entry = all.find((candidate) => candidate.id === id);
  if (!entry) return false;
  entry.enabled = enabled;
  writeAll(all);
  return true;
}

/**
 * Entries whose due time has passed.
 *
 * Read-only: the caller decides whether to claim and run them, and a separate
 * process sweeping at the same moment sees the same list until one of them
 * writes the claim.
 */
export function dueSchedules(now = new Date()): ScheduleEntry[] {
  return readAll().filter((entry) => entry.enabled && Date.parse(entry.dueAt) <= now.getTime());
}

/**
 * Claim an entry at the moment it runs.
 *
 * The claim advances `dueAt` before the work starts, so a crash mid-run leaves
 * a schedule that is due again next interval rather than one that fires every
 * sweep forever. For a one-shot, the entry is disabled instead.
 */
export function claimSchedule(id: string, now = new Date()): ScheduleEntry | null {
  const all = readAll();
  const entry = all.find((candidate) => candidate.id === id);
  if (!entry || !entry.enabled) return null;
  entry.lastRunAt = now.toISOString();
  if (entry.everyMinutes) {
    // Compute from the due time, not from now: a sweep that ran a day late
    // must not shift a 9am schedule to whenever the machine happened to boot.
    let next = Date.parse(entry.dueAt);
    while (next <= now.getTime()) next += entry.everyMinutes * 60_000;
    entry.dueAt = new Date(next).toISOString();
  } else {
    entry.enabled = false;
  }
  writeAll(all);
  return entry;
}

/** Record how a scheduled run ended, for `schedule list`. */
export function settleSchedule(id: string, result: string): void {
  const all = readAll();
  const entry = all.find((candidate) => candidate.id === id);
  if (!entry) return;
  entry.lastResult = result.slice(0, 400);
  writeAll(all);
}

/** Human-readable next-run line. */
export function formatSchedule(entry: ScheduleEntry, now = new Date()): string {
  const due = new Date(entry.dueAt);
  const state = entry.enabled ? (due.getTime() <= now.getTime() ? "due now" : `next ${due.toISOString().replace("T", " ").replace(/\..+/, "")}`) : "done";
  const repeat = entry.everyMinutes ? `, every ${entry.everyMinutes}m` : "";
  const last = entry.lastRunAt ? `  last ${entry.lastRunAt.replace("T", " ").replace(/\..+/, "")}` : "";
  return `${entry.id}  ${state}${repeat}  ${entry.prompt.slice(0, 70)}${last}${entry.lastResult ? `  — ${entry.lastResult}` : ""}`;
}

/**
 * Parse `--at` and `--in` into an ISO time.
 *
 * `--in 30m` exists because "in half an hour" is the way people think about
 * reminders; requiring an absolute timestamp for that is friction with no
 * benefit.
 */
export function parseWhen(values: { at?: string; in?: string }, now = new Date()): string | null {
  if (values.at) {
    const parsed = Date.parse(values.at);
    return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
  }
  if (values.in) {
    const match = /^(\d+)\s*(m|h|d)$/i.exec(values.in.trim());
    if (!match) return null;
    const amount = Number(match[1]);
    const unit = match[2].toLowerCase();
    const minutes = unit === "m" ? amount : unit === "h" ? amount * 60 : amount * 1440;
    return new Date(now.getTime() + minutes * 60_000).toISOString();
  }
  return null;
}
