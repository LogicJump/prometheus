import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { BoardSelection, Config, PermissionMode, ThinkingEffort } from "./types.ts";
import { resolveProvider } from "./providers.ts";

const HOME_DIR = join(homedir(), ".prometheus");
export const CONFIG_HOME = HOME_DIR;
export const SESSIONS_DIR = join(HOME_DIR, "sessions");

export const DEFAULT_MODEL = "glm-5.3-flash";
/**
 * Optional allowlist. Empty (the default) means "whatever the endpoint
 * advertises", discovered at startup from GET /models. Set PROMETHEUS_MODELS
 * to a comma list to restrict the picker anyway.
 */
export const ALLOWED_MODELS: string[] = (process.env.PROMETHEUS_MODELS ?? "")
  .split(",")
  .map((m) => m.trim())
  .filter(Boolean);

export function isModelAllowed(model: string): boolean {
  return ALLOWED_MODELS.length === 0 || ALLOWED_MODELS.includes(model);
}

export function allowedModelError(model: string): string {
  return `model "${model}" is not permitted on this deployment. Allowed: ${ALLOWED_MODELS.join(", ")}.`;
}

interface FileConfig {
  baseUrl?: string;
  apiKey?: string;
  provider?: string;
  model?: string;
  maxTokens?: number;
  permissionMode?: PermissionMode;
  thinkingEffort?: ThinkingEffort;
  contextWindow?: number;
  maxTurns?: number;
  allowedDirs?: string[];
  autoApprove?: string[];
  sandbox?: "off" | "enforce";
  networkPolicy?: "off" | "proxy" | "open";
  fallbackModels?: string[];
  board?: unknown;
}

function readJson(path: string): FileConfig {
  try {
    if (!existsSync(path)) return {};
    return JSON.parse(readFileSync(path, "utf8")) as FileConfig;
  } catch (err) {
    console.error(`Warning: could not parse ${path}: ${(err as Error).message}`);
    return {};
  }
}

function validMode(value: string | undefined): PermissionMode | undefined {
  return value === "ask" || value === "auto" || value === "plan" ? value : undefined;
}

function validSandbox(value: string | undefined): "off" | "enforce" | undefined {
  return value === "off" || value === "enforce" ? value : undefined;
}

function validNetwork(value: string | undefined): "off" | "proxy" | "open" | undefined {
  return value === "off" || value === "proxy" || value === "open" ? value : undefined;
}

function validEffort(value: string | undefined): ThinkingEffort | undefined {
  return value === "auto" || value === "low" || value === "medium" || value === "high" ? value : undefined;
}

const FLASHERS = ["pyocd", "probe-rs", "openocd", "esptool", "st-flash", "dfu-util", "avrdude", "jlink"] as const;

function text(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) return undefined;
  return trimmed;
}

/**
 * Sanitise a board selection read from a config file.
 *
 * The file is hand-editable and may come from another version, so every field
 * is checked rather than trusted. An unrecognised flasher is dropped instead
 * of being passed to a spawn, and the baud is clamped to a range a UART can
 * actually use.
 */
export function validBoard(value: unknown): BoardSelection | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const board: BoardSelection = {};
  const port = text(raw.port, 64);
  if (port) board.port = port;
  const target = text(raw.target, 120);
  if (target) board.target = target;
  const probe = text(raw.probe, 120);
  if (probe) board.probe = probe;
  const baud = typeof raw.baud === "number" ? Math.round(raw.baud) : Number.parseInt(String(raw.baud ?? ""), 10);
  if (Number.isFinite(baud) && baud > 0) board.baud = Math.min(4_000_000, Math.max(300, baud));
  if (typeof raw.flasher === "string" && (FLASHERS as readonly string[]).includes(raw.flasher)) {
    board.flasher = raw.flasher as BoardSelection["flasher"];
  }
  if (typeof raw.assertDtr === "boolean") board.assertDtr = raw.assertDtr;
  return Object.keys(board).length > 0 ? board : undefined;
}

export function loadConfig(cli: Partial<Config> = {}): Config {
  mkdirSync(HOME_DIR, { recursive: true });
  const global = readJson(join(HOME_DIR, "config.json"));
  const project = readJson(join(process.cwd(), ".prometheus", "config.json"));
  const file: FileConfig = { ...global, ...project };

  // The provider registry turns a provider id into its base URL and key
  // environment variables; an explicit base URL still wins so existing
  // configs and custom gateways keep working unchanged.
  const providerId = cli.provider ?? process.env.PROMETHEUS_PROVIDER ?? file.provider;
  const claimedKey = cli.apiKey || process.env.PROMETHEUS_API_KEY || process.env.OPENAI_API_KEY || file.apiKey || "";
  const configuredBaseUrl =
    cli.baseUrl || process.env.PROMETHEUS_BASE_URL || process.env.OPENAI_BASE_URL || file.baseUrl || undefined;
  const provider = resolveProvider(providerId, configuredBaseUrl, claimedKey);
  const apiKey = claimedKey || provider.apiKey;
  const baseUrl = provider.baseUrl;
  const model = cli.model || process.env.PROMETHEUS_MODEL || file.model || DEFAULT_MODEL;
  if (!isModelAllowed(model)) {
    throw new Error(`${allowedModelError(model)} Set PROMETHEUS_MODELS to change the allowlist.`);
  }

  const config: Config = {
    baseUrl,
    apiKey,
    provider: provider.provider.id,
    model,
    maxTokens: cli.maxTokens ?? file.maxTokens ?? 16000,
    permissionMode:
      cli.permissionMode ??
      validMode(process.env.PROMETHEUS_PERMISSION_MODE) ??
      file.permissionMode ??
      "ask",
    thinkingEffort:
      validEffort(cli.thinkingEffort) ??
      validEffort(process.env.PROMETHEUS_THINKING_EFFORT) ??
      validEffort(file.thinkingEffort) ??
      "auto",
    contextWindow: cli.contextWindow ?? file.contextWindow ?? 1_000_000,
    maxTurns: cli.maxTurns ?? file.maxTurns ?? 60,
    allowedDirs: cli.allowedDirs ?? file.allowedDirs ?? [],
    autoApprove: cli.autoApprove ?? file.autoApprove ?? [],
    sandbox:
      cli.sandbox ??
      validSandbox(process.env.PROMETHEUS_SANDBOX) ??
      file.sandbox ??
      "enforce",
    networkPolicy:
      cli.networkPolicy ??
      validNetwork(process.env.PROMETHEUS_NETWORK_POLICY) ??
      file.networkPolicy ??
      "off",
    fallbackModels: cli.fallbackModels ?? file.fallbackModels ?? [],
    board: validBoard(cli.board ?? file.board),
  };

  if (!config.apiKey) {
    const envHint = provider.provider.apiKeyEnv?.length
      ? ` Set ${provider.provider.apiKeyEnv.join(" or ")}`
      : " Set an API key environment variable";
    throw new Error(
      `No API key found for ${provider.provider.label}.${envHint}, or add "apiKey" to ~/.prometheus/config.json.`,
    );
  }
  return config;
}

export function saveSession(id: string, data: unknown): void {
  mkdirSync(SESSIONS_DIR, { recursive: true });
  writeFileSync(join(SESSIONS_DIR, `${id}.json`), JSON.stringify(data, null, 2), "utf8");
}
