/**
 * Settings persistence for the desktop app.
 *
 * The host owns ~/.prometheus/config.json; it also keeps a small UI state file
 * (locale, theme, transcript preferences, notifications) so both survive
 * restarts without the renderer touching the filesystem.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_HOME } from "./config.ts";

export type ThemePreference = "dark" | "light" | "system";

export interface UiSettings {
  locale?: "en" | "zh";
  theme?: ThemePreference;
  /** How much detail tool calls show in the transcript. */
  density?: "compact" | "balanced" | "detailed";
  /** Transcript body size multiplier: 0.9 small, 1 default, 1.12 large. */
  fontScale?: number;
  /** Reading column width for the conversation. */
  transcriptWidth?: "narrow" | "standard" | "wide";
  /** What the transcript shows by default: collapsed tools, thinking, or everything. */
  transcriptView?: "normal" | "thinking" | "verbose";
  /** Disable entrance animations and transitions. */
  reduceMotion?: boolean;
  /** "system" follows the platform monospace stack. */
  codeFont?: string;
  /** Desktop notification when a turn finishes while the window is not focused. */
  notifications?: boolean;
  /** Keep the machine from idle-sleeping while a turn runs. */
  keepAwake?: boolean;
  /** Prefix for branches created by an isolated worktree. */
  branchPrefix?: string;
  /** Default response style injected into the system prompt. */
  outputStyle?: "default" | "concise" | "explanatory";
  /** Archive sessions untouched for this many days; 0 disables. */
  archiveAfterDays?: number;
}

const UI_FILE = join(CONFIG_HOME, "ui.json");
const CONFIG_FILE = join(CONFIG_HOME, "config.json");

export function readUiSettings(): UiSettings {
  try {
    if (!existsSync(UI_FILE)) return {};
    return JSON.parse(readFileSync(UI_FILE, "utf8")) as UiSettings;
  } catch {
    return {};
  }
}

export function writeUiSettings(patch: UiSettings): void {
  mkdirSync(CONFIG_HOME, { recursive: true });
  const next = { ...readUiSettings(), ...patch };
  writeFileSync(UI_FILE, JSON.stringify(next, null, 2), "utf8");
}

export interface EditableConfig {
  provider?: string;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  permissionMode?: string;
  thinkingEffort?: string;
  maxTokens?: number;
  contextWindow?: number;
  fallbackModels?: string[];
}

/** Merge the given fields into ~/.prometheus/config.json, preserving everything else. */
export function writeConfigFile(patch: EditableConfig): void {
  mkdirSync(CONFIG_HOME, { recursive: true });
  let existing: Record<string, unknown> = {};
  try {
    if (existsSync(CONFIG_FILE)) existing = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
  } catch {
    existing = {};
  }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || value === null || value === "") continue;
    existing[key] = value;
  }
  writeFileSync(CONFIG_FILE, JSON.stringify(existing, null, 2), "utf8");
}

/** Mask a key for display: keep the first 4 and last 4 characters. */
export function maskKey(key: string): string {
  if (!key) return "";
  if (key.length <= 10) return "•".repeat(key.length);
  return `${key.slice(0, 4)}${"•".repeat(Math.min(20, key.length - 8))}${key.slice(-4)}`;
}
