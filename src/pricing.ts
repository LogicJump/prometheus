/**
 * What a token costs.
 *
 * Prices are per million tokens and are only a local estimate: the gateway the
 * user points Prometheus at is the authority on what it bills. The table is
 * deliberately prefix-matched, so `glm-5.3-flash-0915` inherits the
 * `glm-5.3-flash` price without an entry of its own.
 *
 * `~/.prometheus/pricing.json` overrides and extends the table:
 *
 *   { "models": { "my-model": { "input": 0.5, "output": 2, "cachedInput": 0.1 } } }
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_HOME } from "./config.ts";

export interface ModelPrice {
  /** US dollars per million input tokens. */
  input: number;
  /** US dollars per million output tokens. */
  output: number;
  /** Discounted rate for cache hits; defaults to `input` when unknown. */
  cachedInput?: number;
}

/** Prefix-matched, longest prefix wins. */
const BUILTIN: Record<string, ModelPrice> = {
  "glm-5.3-flash": { input: 0.2, output: 1.1, cachedInput: 0.04 },
  "glm-5": { input: 0.6, output: 2.2, cachedInput: 0.11 },
  "deepseek-v4.1-flash": { input: 0.15, output: 0.6, cachedInput: 0.03 },
  "deepseek-v4": { input: 0.28, output: 1.1, cachedInput: 0.05 },
  "deepseek-chat": { input: 0.27, output: 1.1, cachedInput: 0.07 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gpt-4o": { input: 2.5, output: 10 },
  "o3-mini": { input: 1.1, output: 4.4 },
  "qwen": { input: 0.4, output: 1.2 },
  "kimi": { input: 0.6, output: 2.5 },
  "llama": { input: 0.2, output: 0.6 },
};

let overrides: Record<string, ModelPrice> | null = null;

function loadOverrides(): Record<string, ModelPrice> {
  if (overrides) return overrides;
  overrides = {};
  const file = join(CONFIG_HOME, "pricing.json");
  try {
    if (!existsSync(file)) return overrides;
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { models?: Record<string, ModelPrice> };
    for (const [name, price] of Object.entries(parsed.models ?? {})) {
      if (typeof price?.input === "number" && typeof price?.output === "number") overrides[name] = price;
    }
  } catch {
    /* a malformed pricing file must not break accounting */
  }
  return overrides;
}

/** The price for a model id, or null when nothing matches. */
export function priceFor(model: string): ModelPrice | null {
  const id = String(model ?? "").toLowerCase();
  if (!id) return null;
  const table = { ...BUILTIN, ...loadOverrides() };
  let best: string | null = null;
  for (const prefix of Object.keys(table)) {
    if (!id.startsWith(prefix.toLowerCase())) continue;
    if (best === null || prefix.length > best.length) best = prefix;
  }
  return best ? table[best] : null;
}

/**
 * Dollar cost for one turn. Cache hits are billed at the cached rate and are
 * part of the input count, so they are subtracted from the full-price portion
 * instead of being added on top.
 */
export function costOf(
  model: string,
  tokens: { inputTokens: number; outputTokens: number; cachedTokens?: number },
): number | null {
  const price = priceFor(model);
  if (!price) return null;
  const cached = Math.min(Math.max(0, tokens.cachedTokens ?? 0), Math.max(0, tokens.inputTokens));
  const fullPriceInput = Math.max(0, tokens.inputTokens - cached);
  const cachedRate = price.cachedInput ?? price.input;
  const dollars =
    (fullPriceInput / 1_000_000) * price.input +
    (cached / 1_000_000) * cachedRate +
    (Math.max(0, tokens.outputTokens) / 1_000_000) * price.output;
  return Math.round(dollars * 1e6) / 1e6;
}

/** Compact currency for the UI: under a cent still reads as a real number. */
export function formatCost(dollars: number | null): string {
  if (dollars === null) return "—";
  if (dollars === 0) return "$0";
  if (dollars < 0.01) return `$${dollars.toFixed(4)}`;
  if (dollars < 1) return `$${dollars.toFixed(3)}`;
  return `$${dollars.toFixed(2)}`;
}

/** Test seam: drop the cached override table. */
export function resetPricingCache(): void {
  overrides = null;
}
