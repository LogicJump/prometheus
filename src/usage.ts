/**
 * Token accounting that survives restarts.
 *
 * Every completed turn appends one record to ~/.prometheus/usage.jsonl. The
 * agent's own counters are per-session and reset when the host restarts, so the
 * Usage page reads from this log instead: totals, a per-day series, and a
 * per-model split. Records are append-only and one line each, which keeps a
 * crash from corrupting earlier history.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_HOME } from "./config.ts";
import { costOf } from "./pricing.ts";

export interface UsageRecord {
  at: string;
  sessionId: string;
  cwd: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  /** Estimated US dollars for the turn; absent when the model has no price. */
  cost?: number | null;
}

export interface UsageDay {
  date: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  turns: number;
}

export interface UsageModel {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
}

export interface UsageSummary {
  days: UsageDay[];
  totals: { inputTokens: number; outputTokens: number; cachedTokens: number; turns: number; cost: number };
  models: UsageModel[];
}

const FILE = join(CONFIG_HOME, "usage.jsonl");

export function recordUsage(record: Omit<UsageRecord, "at"> & { at?: string }): void {
  const inputTokens = Math.max(0, Math.round(record.inputTokens || 0));
  const outputTokens = Math.max(0, Math.round(record.outputTokens || 0));
  if (inputTokens === 0 && outputTokens === 0) return;
  try {
    mkdirSync(CONFIG_HOME, { recursive: true });
    const entry: UsageRecord = {
      at: record.at ?? new Date().toISOString(),
      sessionId: record.sessionId,
      cwd: record.cwd,
      model: record.model,
      inputTokens,
      outputTokens,
      cachedTokens: Math.max(0, Math.round(record.cachedTokens || 0)),
    };
    entry.cost = costOf(entry.model, entry);
    appendFileSync(FILE, `${JSON.stringify(entry)}\n`, "utf8");
  } catch {
    /* accounting must never break a turn */
  }
}

export function readUsage(): UsageRecord[] {
  if (!existsSync(FILE)) return [];
  let text: string;
  try {
    text = readFileSync(FILE, "utf8");
  } catch {
    return [];
  }
  const out: UsageRecord[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const entry = JSON.parse(trimmed) as UsageRecord;
      if (!entry?.at || typeof entry.inputTokens !== "number") continue;
      out.push(entry);
    } catch {
      /* a torn final line from a crash */
    }
  }
  return out;
}

function dayKey(date: Date): string {
  // Local calendar day, so the chart matches the user's clock.
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** A contiguous series ending today, so empty days are visible as gaps. */
export function usageSummary(days = 30): UsageSummary {
  const span = Math.max(1, Math.min(365, Math.round(days)));
  const records = readUsage();
  const cutoff = new Date();
  cutoff.setHours(0, 0, 0, 0);
  cutoff.setDate(cutoff.getDate() - (span - 1));

  const byDay = new Map<string, UsageDay>();
  for (let offset = 0; offset < span; offset++) {
    const date = new Date(cutoff);
    date.setDate(cutoff.getDate() + offset);
    const key = dayKey(date);
    byDay.set(key, { date: key, inputTokens: 0, outputTokens: 0, cachedTokens: 0, turns: 0 });
  }

  const totals = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, turns: 0, cost: 0 };
  const models = new Map<string, UsageModel>();

  for (const record of records) {
    const at = new Date(record.at);
    if (Number.isNaN(at.getTime()) || at < cutoff) continue;
    const day = byDay.get(dayKey(at));
    if (!day) continue;
    day.inputTokens += record.inputTokens;
    day.outputTokens += record.outputTokens;
    day.cachedTokens += record.cachedTokens ?? 0;
    day.turns += 1;
    totals.inputTokens += record.inputTokens;
    totals.outputTokens += record.outputTokens;
    totals.cachedTokens += record.cachedTokens ?? 0;
    totals.turns += 1;
    totals.cost += record.cost ?? costOf(record.model, record) ?? 0;
    const model = record.model || "unknown";
    const entry = models.get(model) ?? { model, inputTokens: 0, outputTokens: 0, cost: 0 };
    entry.inputTokens += record.inputTokens;
    entry.outputTokens += record.outputTokens;
    entry.cost += record.cost ?? costOf(record.model, record) ?? 0;
    models.set(model, entry);
  }

  return {
    days: [...byDay.values()],
    totals,
    models: [...models.values()].sort((a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens)),
  };
}
