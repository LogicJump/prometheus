/**
 * Model access layer: a declarative provider registry over one wire protocol.
 *
 * Every provider this agent supports speaks the OpenAI chat-completions shape,
 * so there is exactly one adapter. A provider is data, not code:
 *
 *   {
 *     id: "deepseek",
 *     label: "DeepSeek",
 *     baseUrl: "https://api.deepseek.com/v1",
 *     apiKeyEnv: ["DEEPSEEK_API_KEY"],
 *     models: ["deepseek-chat", ...],        // optional hints for the picker
 *     contextLength: 128_000                // optional default window
 *   }
 *
 * Adding a provider means adding an entry here or in
 * `~/.prometheus/providers.json`; no adapter code changes. There is
 * deliberately no protocol fallback chain (no Anthropic/Responses translation)
 * and no OAuth: a provider that does not speak OpenAI-compatible chat
 * completions is simply not supported.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_HOME } from "./config.ts";

export interface ProviderDefinition {
  id: string;
  label: string;
  /** Base URL without the trailing /chat/completions. */
  baseUrl: string;
  /** Environment variables checked, in order, for the key. */
  apiKeyEnv?: string[];
  /** Model ids to offer before /models has been read. */
  models?: string[];
  /** Default context window when the model endpoint reports none. */
  contextLength?: number;
  /** Whether the picker should prefer this provider by default. */
  default?: boolean;
  /** Recommended thinking-effort control for models on this provider. */
  supportsReasoningEffort?: boolean;
}

export interface ResolvedProvider {
  provider: ProviderDefinition;
  baseUrl: string;
  apiKey: string;
  /** Where the key came from, for the settings UI. */
  keySource: "config" | "env" | "none";
}

/**
 * Built-in registry. Order is picker order; the first entry is the default
 * when nothing else is configured.
 */
export const BUILTIN_PROVIDERS: ProviderDefinition[] = [
  {
    id: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    apiKeyEnv: ["OPENAI_API_KEY"],
    default: true,
    supportsReasoningEffort: true,
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    apiKeyEnv: ["DEEPSEEK_API_KEY"],
    supportsReasoningEffort: false,
  },
  {
    id: "moonshot",
    label: "Moonshot",
    baseUrl: "https://api.moonshot.cn/v1",
    apiKeyEnv: ["MOONSHOT_API_KEY"],
    supportsReasoningEffort: false,
  },
  {
    id: "qwen",
    label: "Qwen (DashScope)",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    apiKeyEnv: ["DASHSCOPE_API_KEY", "QWEN_API_KEY"],
    supportsReasoningEffort: false,
  },
  {
    id: "ollama",
    label: "Ollama",
    baseUrl: "http://localhost:11434/v1",
    apiKeyEnv: ["OLLAMA_API_KEY"],
    supportsReasoningEffort: false,
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    apiKeyEnv: ["OPENROUTER_API_KEY"],
    supportsReasoningEffort: true,
  },
];

interface ProviderFile {
  providers?: ProviderDefinition[];
}

/** Built-ins plus anything the user registered in ~/.prometheus/providers.json. */
export function loadProviders(): ProviderDefinition[] {
  const merged = new Map<string, ProviderDefinition>();
  for (const provider of BUILTIN_PROVIDERS) merged.set(provider.id, provider);
  const file = join(CONFIG_HOME, "providers.json");
  if (!existsSync(file)) return [...merged.values()];
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as ProviderFile;
    for (const provider of parsed.providers ?? []) {
      if (!provider?.id || typeof provider.baseUrl !== "string") continue;
      merged.set(provider.id, { ...provider, baseUrl: provider.baseUrl.replace(/\/+$/, "") });
    }
  } catch {
    /* an unreadable registry must not stop the app */
  }
  return [...merged.values()];
}

/**
 * Pick the provider for a base URL. An exact URL match wins; otherwise the
 * URL is treated as a custom (OpenAI-compatible) endpoint.
 */
export function providerFor(baseUrl: string, providers = loadProviders()): ProviderDefinition {
  const normalized = baseUrl.replace(/\/+$/, "");
  const match = providers.find((provider) => provider.baseUrl.replace(/\/+$/, "") === normalized);
  if (match) return match;
  return { id: "custom", label: "Custom endpoint", baseUrl: normalized, supportsReasoningEffort: true };
}

/** Resolve the key for a provider from config first, then the environment. */
export function resolveProvider(
  providerId: string | undefined,
  baseUrl: string | undefined,
  configKey: string,
  providers = loadProviders(),
): ResolvedProvider {
  const provider =
    (providerId ? providers.find((entry) => entry.id === providerId) : undefined) ??
    providerFor(baseUrl ?? providers[0]?.baseUrl ?? BUILTIN_PROVIDERS[0].baseUrl, providers);

  if (configKey) {
    return { provider, baseUrl: (baseUrl ?? provider.baseUrl).replace(/\/+$/, ""), apiKey: configKey, keySource: "config" };
  }
  for (const name of provider.apiKeyEnv ?? []) {
    const value = process.env[name];
    if (value) {
      return { provider, baseUrl: (baseUrl ?? provider.baseUrl).replace(/\/+$/, ""), apiKey: value, keySource: "env" };
    }
  }
  return { provider, baseUrl: (baseUrl ?? provider.baseUrl).replace(/\/+$/, ""), apiKey: "", keySource: "none" };
}

/** The public shape sent to the settings UI (never includes a key). */
export function publicProviders(): { id: string; label: string; baseUrl: string; models?: string[]; configured: boolean }[] {
  return loadProviders().map((provider) => ({
    id: provider.id,
    label: provider.label,
    baseUrl: provider.baseUrl,
    models: provider.models,
    configured: (provider.apiKeyEnv ?? []).some((name) => Boolean(process.env[name])),
  }));
}
