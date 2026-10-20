/**
 * Model discovery for OpenAI-compatible endpoints.
 *
 * Reads GET /models, keeps the models that can call tools, and caches the
 * result per base URL so startup stays fast and works offline. Anything the
 * endpoint does not describe (many proxies return only ids) is assumed capable.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_HOME } from "./config.ts";

export interface ModelInfo {
  id: string;
  name: string;
  contextLength: number;
  supportsTools: boolean;
  supportsVision: boolean;
  supportsReasoning: boolean;
  /**
   * The reasoning levels this model accepts, in the endpoint's own spelling,
   * low to high.
   *
   * Advertised by OpenAI-compatible gateways as `reasoning_efforts`, and the
   * reason a fixed four-value enum cannot work: one model offers
   * `low/high/max`, another `high/xhigh`, a third only `medium`. Sending a
   * level the model does not list is a 400 on a strict gateway and silently
   * ignored on a lenient one, so the picker is built from this list.
   */
  reasoningEfforts?: string[];
  /** The level to send when the user chose "auto". */
  reasoningDefault?: string;
  /** A model that always reasons at one level and takes no parameter. */
  reasoningFixed?: string;
  /** False when the model cannot turn reasoning off at all. */
  reasoningCanDisable?: boolean;
}

export interface ModelCatalog {
  models: ModelInfo[];
  fetchedAt: string;
  source: "remote" | "cache" | "fallback";
}

const CACHE_FILE = join(CONFIG_HOME, "models-cache.json");
const CACHE_TTL_MS = 60 * 60 * 1000;

/** Used only when the endpoint cannot be reached and no cache exists. */
export const FALLBACK_MODELS: ModelInfo[] = [
  { id: "glm-5.3-flash", name: "GLM-5.3 Flash", contextLength: 1_000_000, supportsTools: true, supportsVision: true, supportsReasoning: true },
  { id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", contextLength: 1_000_000, supportsTools: true, supportsVision: true, supportsReasoning: true },
];

interface RawModel {
  id?: string;
  name?: string;
  context_length?: number;
  max_input_tokens?: number;
  supports_tool_calls?: boolean;
  supports_vision?: boolean;
  supports_reasoning?: boolean;
  capabilities?: { tool_calls?: boolean; vision?: boolean; reasoning?: boolean; function_call?: boolean };
  abilities?: { functionCall?: boolean; function_call?: boolean; vision?: boolean; reasoning?: boolean };
  /** OpenAI-compatible gateways that describe their reasoning levels. */
  reasoning_efforts?: unknown;
  reasoning_default_effort?: unknown;
  reasoning_fixed_effort?: unknown;
  reasoning_can_disable?: unknown;
}

/**
 * The reasoning levels a model advertises, normalised.
 *
 * Order is the endpoint's, which is low to high for every gateway seen so far;
 * re-sorting alphabetically would put `xhigh` before `high`. An entry that is
 * not a non-empty string is dropped rather than shown as a broken row.
 */
function reasoningEfforts(raw: RawModel): string[] | undefined {
  if (!Array.isArray(raw.reasoning_efforts)) return undefined;
  const levels = raw.reasoning_efforts
    .filter((level): level is string => typeof level === "string" && level.trim().length > 0)
    .map((level) => level.trim());
  // Duplicates would produce two menu rows with the same label.
  const unique = [...new Set(levels)];
  return unique.length > 0 ? unique : undefined;
}

type CacheFile = Record<string, { fetchedAt: string; models: ModelInfo[] }>;

/**
 * Bump when `ModelInfo` gains a field that comes from the endpoint.
 *
 * The cache otherwise keeps a catalogue parsed by an older build for up to
 * `CACHE_TTL_MS`, so a new field (`reasoningEfforts`) stays missing and the
 * feature looks unimplemented until the hour runs out. A version mismatch
 * re-reads the endpoint once.
 */
const CACHE_VERSION = 2;

function readCache(): CacheFile {
  try {
    if (!existsSync(CACHE_FILE)) return {};
    const parsed = JSON.parse(readFileSync(CACHE_FILE, "utf8")) as CacheFile & { version?: number };
    if (parsed.version !== CACHE_VERSION) return {};
    return parsed;
  } catch {
    return {};
  }
}

function writeCache(key: string, models: ModelInfo[]): void {
  try {
    mkdirSync(CONFIG_HOME, { recursive: true });
    const cache = readCache();
    cache[key] = { fetchedAt: new Date().toISOString(), models };
    writeFileSync(CACHE_FILE, JSON.stringify({ version: CACHE_VERSION, ...cache }, null, 2), "utf8");
  } catch {
    /* cache is best-effort */
  }
}

function normalize(raw: RawModel): ModelInfo | null {
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  if (!id) return null;
  const explicitTools =
    raw.supports_tool_calls ?? raw.capabilities?.tool_calls ?? raw.capabilities?.function_call ?? raw.abilities?.functionCall ?? raw.abilities?.function_call;
  const efforts = reasoningEfforts(raw);
  const fixed = typeof raw.reasoning_fixed_effort === "string" ? raw.reasoning_fixed_effort.trim() : "";
  const byDefault = typeof raw.reasoning_default_effort === "string" ? raw.reasoning_default_effort.trim() : "";
  // A default that is not in the advertised list would make "auto" send a
  // level the model does not accept; the highest advertised level is the
  // honest fallback, since that is what "auto" means when a gateway does not
  // say.
  const fallbackDefault = efforts ? efforts[efforts.length - 1] : undefined;
  return {
    id,
    name: raw.name || id,
    contextLength: Number(raw.context_length ?? raw.max_input_tokens ?? 0) || 0,
    supportsTools: explicitTools !== false,
    supportsVision: Boolean(raw.supports_vision ?? raw.capabilities?.vision ?? raw.abilities?.vision),
    supportsReasoning: Boolean(raw.supports_reasoning ?? raw.capabilities?.reasoning ?? raw.abilities?.reasoning),
    ...(efforts ? { reasoningEfforts: efforts } : {}),
    ...(efforts && (byDefault || fallbackDefault)
      ? { reasoningDefault: byDefault && efforts.includes(byDefault) ? byDefault : fallbackDefault }
      : {}),
    ...(fixed ? { reasoningFixed: fixed } : {}),
    ...(typeof raw.reasoning_can_disable === "boolean" ? { reasoningCanDisable: raw.reasoning_can_disable } : {}),
  };
}

/** Filter rules: drop non-tool models; drop embedding/audio/image-only ids. */
function usable(info: ModelInfo): boolean {
  if (!info.supportsTools) return false;
  return !/(embed|whisper|tts|dall-e|moderation|rerank|transcribe)/i.test(info.id);
}

function mergeFallback(models: ModelInfo[]): ModelInfo[] {
  const seen = new Set(models.map((m) => m.id));
  const extra = FALLBACK_MODELS.filter((m) => !seen.has(m.id));
  return [...models, ...extra];
}

export function cachedCatalog(baseUrl: string): ModelCatalog | null {
  const entry = readCache()[baseUrl];
  if (!entry) return null;
  return { models: entry.models, fetchedAt: entry.fetchedAt, source: "cache" };
}

export async function discoverModels(
  baseUrl: string,
  apiKey: string,
  options: { force?: boolean; timeoutMs?: number } = {},
): Promise<ModelCatalog> {
  const cache = readCache()[baseUrl];
  const fresh = cache && Date.now() - Date.parse(cache.fetchedAt) < CACHE_TTL_MS;
  if (fresh && !options.force && cache) {
    return { models: cache.models, fetchedAt: cache.fetchedAt, source: "cache" };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000);
  try {
    const res = await fetch(`${baseUrl}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = (await res.json()) as { data?: RawModel[]; models?: RawModel[] };
    const raw = Array.isArray(json.data) ? json.data : Array.isArray(json.models) ? json.models : [];
    const models = raw.map(normalize).filter((m): m is ModelInfo => m !== null).filter(usable).map(withFallbackMeta);
    if (models.length === 0) throw new Error("endpoint returned no usable models");
    models.sort((a, b) => a.id.localeCompare(b.id));
    writeCache(baseUrl, models);
    return { models, fetchedAt: new Date().toISOString(), source: "remote" };
  } catch {
    if (cache) return { models: cache.models, fetchedAt: cache.fetchedAt, source: "cache" };
    return { models: FALLBACK_MODELS, fetchedAt: new Date().toISOString(), source: "fallback" };
  } finally {
    clearTimeout(timer);
  }
}

/** Keep a sane context window and human name for endpoints with sparse metadata. */
function withFallbackMeta(info: ModelInfo): ModelInfo {
  const fallback = FALLBACK_MODELS.find((m) => m.id === info.id);
  return {
    ...info,
    name: info.name === info.id ? prettyName(info.id) : info.name,
    contextLength: info.contextLength || fallback?.contextLength || 0,
    supportsVision: info.supportsVision || Boolean(fallback?.supportsVision),
    supportsReasoning: info.supportsReasoning || Boolean(fallback?.supportsReasoning),
  };
}

function prettyName(id: string): string {
  return id
    .split(/[-_/]/)
    .filter(Boolean)
    .map((part) => (part.length <= 3 && /^[a-z0-9.]+$/i.test(part) ? part.toUpperCase() : part[0].toUpperCase() + part.slice(1)))
    .join(" ");
}

export function findModel(catalog: ModelInfo[], id: string): ModelInfo | undefined {
  return catalog.find((m) => m.id === id);
}

export { mergeFallback };
