import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { BoardProfile, BoardSelection, Config, PermissionMode, ThinkingEffort } from "./types.ts";
import { resolveProvider } from "./providers.ts";
import { applyManaged, loadManagedSettings } from "./managed.ts";

/**
 * Where config, sessions, rules and caches live.
 *
 * `PROMETHEUS_HOME` overrides it. That exists for tests — a suite that writes
 * into the real `~/.prometheus` leaves rules behind that change the next run's
 * results (a "always allow bash" clicked in the app once made an unrelated
 * rule-ordering assertion fail forever), and a config directory a test can
 * point at a temp folder makes the suite independent of the developer's own
 * settings.
 */
const HOME_DIR = process.env.PROMETHEUS_HOME?.trim() || join(homedir(), ".prometheus");
export const CONFIG_HOME = HOME_DIR;
export const SESSIONS_DIR = join(HOME_DIR, "sessions");

/** Roughly the smallest window a current tool-calling model ships with. */
export const DEFAULT_CONTEXT_WINDOW = 128_000;

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
  disallowedTools?: string[];
  sandbox?: "off" | "enforce";
  networkPolicy?: "off" | "open";
  fallbackModels?: string[];
  board?: unknown;
  boardProfiles?: unknown;
  echoReasoning?: boolean;
  contextWindowByModel?: Record<string, number>;
  subagentContextWindow?: number;
  idleCompactMinutes?: number;
  maxBudgetUsd?: number;
  sessionTokenBudget?: number;
  goalBudgetUsd?: number;
  sandboxFailIfUnavailable?: boolean;
  sandboxCredentials?: Record<string, string>;
  /**
   * Run shell commands inside WSL2 instead of on Windows.
   *
   * `policy` is the classifier only, which is what this build did before the
   * kernel sandbox existed. `wsl` adds a private network namespace, a
   * read-only or read-write bind of the workspace, and a tmpfs home. `auto`
   * uses WSL when it is installed and falls back to `policy` when it is not,
   * saying so in the status line rather than silently downgrading.
   */
  kernelSandbox?: "off" | "auto" | "wsl";
  /** WSL distribution name; empty means the first one listed. */
  kernelSandboxDistro?: string;
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

/**
 * Every permission mode the runtime implements.
 *
 * Exported because the same list was written out by hand in six places — the
 * CLI's `--mode` check, the REPL's `/mode`, the host's `setMode`, its settings
 * save, its "keep the live mode" fallback, and the renderer's menu — and they
 * drifted. Three of them still accepted only ask/auto/plan, so choosing
 * `acceptEdits` in the desktop window and then saving an unrelated setting
 * silently put the session back in `ask`. A mode that exists in exactly one
 * place cannot disagree with itself.
 */
export const PERMISSION_MODES: readonly PermissionMode[] = [
  "ask",
  "auto",
  "plan",
  "acceptEdits",
  "dontAsk",
  "bypassPermissions",
];

/** True for a string that names a mode, unmatched case. */
export function isPermissionMode(value: unknown): value is PermissionMode {
  const text = String(value ?? "").toLowerCase();
  return PERMISSION_MODES.some((mode) => mode.toLowerCase() === text);
}


/** A mode name from an environment variable, a flag, or a saved session. */
export function validMode(value: string | undefined): PermissionMode | undefined {
  return PERMISSION_MODES.find((mode) => mode.toLowerCase() === String(value ?? "").toLowerCase());
}

function validSandbox(value: string | undefined): "off" | "enforce" | undefined {
  return value === "off" || value === "enforce" ? value : undefined;
}

/**
 * `proxy` was an option in the settings UI and in old config files, but no
 * code ever implemented it: the loader silently rewrote it to `off`. A choice
 * that is accepted and then quietly discarded is worse than one that is not
 * offered, so the type no longer has it and a file that still says `proxy`
 * loads as `off` with the same behaviour it always had.
 */
export function validNetwork(value: string | undefined): "off" | "open" | undefined {
  if (value === "proxy") return "off";
  return value === "off" || value === "open" ? value : undefined;
}

/**
 * A reasoning level from a config file, a flag, or an environment variable.
 *
 * The set is per model and advertised by the gateway, so this cannot be an
 * allowlist of four names any more. What it can still reject is a value that
 * is not a level at all: empty, very long, or containing whitespace — each of
 * those would go on the wire as a malformed parameter. `auto` is kept as the
 * sentinel meaning "send nothing".
 */
export function validEffort(value: string | undefined): ThinkingEffort | undefined {
  const level = String(value ?? "").trim();
  if (!level) return undefined;
  if (level === "auto") return level;
  return /^[A-Za-z][A-Za-z0-9_-]{0,23}$/.test(level) ? level : undefined;
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
export function validBoard(value: unknown): BoardSelection | undefined {  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
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
  const interfaceConfig = text(raw.interfaceConfig, 200);
  if (interfaceConfig) board.interfaceConfig = interfaceConfig;
  const targetConfig = text(raw.targetConfig, 200);
  if (targetConfig) board.targetConfig = targetConfig;
  if (typeof raw.assertDtr === "boolean") board.assertDtr = raw.assertDtr;
  return Object.keys(board).length > 0 ? board : undefined;
}

/** Named board profiles, dropping any entry without a usable name. */
function validProfiles(value: unknown): BoardProfile[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: BoardProfile[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const name = text((entry as Record<string, unknown>).name, 60);
    if (!name) continue;
    const board = validBoard(entry);
    if (!board) continue;
    out.push({ name, ...board });
  }
  return out.length > 0 ? out : undefined;
}

/** A positive integer from a hand-edited config, or undefined. */
function positive(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : undefined;
}

/** A positive dollar amount; keeps cents, unlike the integer helper. */
function positiveNumber(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : Number.parseFloat(String(value ?? ""));
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

/**
 * A sanitised `model id prefix -> window` map.
 *
 * The file is hand-edited: a key that is not a string or a window smaller than
 * a usable minimum would otherwise produce a session that compacts on every
 * message. Longer prefixes win, matching `pricing.ts`.
 */
function validWindowMap(value: unknown): Record<string, number> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const name = key.trim();
    const window = positive(raw);
    if (!name || !window || window < 8_000) continue;
    out[name] = window;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** The longest matching prefix's window, or undefined when none matches. */
export function windowForModel(model: string, table: Record<string, number> | undefined): number | undefined {
  if (!table) return undefined;
  const id = String(model ?? "").toLowerCase();
  let best: string | undefined;
  for (const prefix of Object.keys(table)) {
    if (!id.startsWith(prefix.toLowerCase())) continue;
    if (best === undefined || prefix.length > best.length) best = prefix;
  }
  return best ? table[best] : undefined;
}

/** `NAME -> value` pairs whose names a shell can actually assign. */
function validCredentials(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [name, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
    if (typeof raw !== "string") continue;
    out[name] = raw;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Kernel sandbox mode.
 *
 * An unrecognised value falls back to `auto`, never to `off`: a typo must not
 * be the thing that removes confinement. `off` has to be chosen explicitly.
 */
function validKernelSandbox(value: unknown): "off" | "auto" | "wsl" {
  return value === "off" || value === "wsl" ? value : "auto";
}

/** Split a comma- or space-separated tool list; empty entries are dropped. */
export function parseToolList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(/[,\s]+/)
    .map((name) => name.trim())
    .filter(Boolean);
}

export function loadConfig(cli: Partial<Config> = {}): Config {  mkdirSync(HOME_DIR, { recursive: true });
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
      validMode(cli.permissionMode as string | undefined) ??
      validMode(process.env.PROMETHEUS_PERMISSION_MODE) ??
      validMode(file.permissionMode) ??
      "ask",
    thinkingEffort:
      validEffort(cli.thinkingEffort) ??
      validEffort(process.env.PROMETHEUS_THINKING_EFFORT) ??
      validEffort(file.thinkingEffort) ??
      "auto",
    contextWindow:
      cli.contextWindow ??
      file.contextWindow ??
      (Number.isFinite(Number(process.env.PROMETHEUS_CONTEXT_WINDOW)) && Number(process.env.PROMETHEUS_CONTEXT_WINDOW) > 0
        ? Number(process.env.PROMETHEUS_CONTEXT_WINDOW)
        : DEFAULT_CONTEXT_WINDOW),
    maxTurns: cli.maxTurns ?? file.maxTurns ?? 60,
    allowedDirs: cli.allowedDirs ?? file.allowedDirs ?? [],
    autoApprove: cli.autoApprove ?? file.autoApprove ?? [],
    disallowedTools: cli.disallowedTools ?? file.disallowedTools ?? [],
    unattended: cli.unattended,
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
    boardProfiles: validProfiles(cli.boardProfiles ?? file.boardProfiles),
    // A default window is a guess. Say so once, so a gateway with a smaller
    // window produces a warning at startup instead of a 400 mid-task.
    contextWindowAssumed:
      cli.contextWindow === undefined &&
      file.contextWindow === undefined &&
      !Number.isFinite(Number(process.env.PROMETHEUS_CONTEXT_WINDOW)),
    echoReasoning: cli.echoReasoning ?? file.echoReasoning ?? false,
    contextWindowByModel: validWindowMap(cli.contextWindowByModel ?? file.contextWindowByModel),
    subagentContextWindow: positive(cli.subagentContextWindow ?? file.subagentContextWindow),
    idleCompactMinutes: positive(file.idleCompactMinutes) ?? cli.idleCompactMinutes,
    maxBudgetUsd: positiveNumber(cli.maxBudgetUsd ?? file.maxBudgetUsd),
    sessionTokenBudget: positive(cli.sessionTokenBudget ?? file.sessionTokenBudget),
    goalBudgetUsd: positiveNumber(cli.goalBudgetUsd ?? file.goalBudgetUsd),
    sandboxFailIfUnavailable: cli.sandboxFailIfUnavailable ?? file.sandboxFailIfUnavailable ?? false,
    sandboxCredentials: validCredentials(cli.sandboxCredentials ?? file.sandboxCredentials),
    // Default is `auto`: a machine with WSL gets real confinement with no
    // configuration, and one without it behaves exactly as before. A typo in
    // the value must not silently weaken the sandbox, so unknown strings fall
    // back to the default rather than to `off`.
    kernelSandbox: validKernelSandbox(cli.kernelSandbox ?? file.kernelSandbox),
    kernelSandboxDistro:
      typeof (cli.kernelSandboxDistro ?? file.kernelSandboxDistro) === "string"
        ? String(cli.kernelSandboxDistro ?? file.kernelSandboxDistro).trim() || undefined
        : undefined,
  };

  // A per-model window only helps if it is actually consulted.
  config.contextWindow = windowForModel(config.model, config.contextWindowByModel) ?? config.contextWindow;

  // The managed layer is applied last and only tightens: a project file that
  // tried to disable a sandbox or raise a budget cannot undo it.
  const managed = loadManagedSettings();
  if (managed.source) {
    const applied = applyManaged(config, managed);
    Object.assign(config, applied.config);
    for (const note of applied.notes) console.error(`prometheus: ${note}`);
  }
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
