/**
 * Settings persistence for the desktop app.
 *
 * The host owns ~/.prometheus/config.json; it also keeps a small UI state file
 * (locale, theme, transcript preferences, notifications) so both survive
 * restarts without the renderer touching the filesystem.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_HOME } from "./config.ts";
import type { BoardSelection } from "./types.ts";

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
  /**
   * Open every new session in an isolated worktree.
   *
   * Per-workspace by nature (a worktree needs a repository), so it is a
   * preference read where the workspace is known rather than a global switch.
   */
  isolateByDefault?: boolean;
  /** Reopen the conversation this window was in when it restarts. */
  restartSession?: boolean;
  /** Offer a next-step suggestion in an empty composer. */
  suggestions?: boolean;
  /** Check for updates in the background at launch. */
  updateCheck?: boolean;
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
  board?: BoardSelection | null;
  /** Ceilings a user can set from Settings; null clears one. */
  maxBudgetUsd?: number | null;
  sessionTokenBudget?: number | null;
  goalBudgetUsd?: number | null;
}

/**
 * Merge the given fields into a config.json, preserving everything else.
 *
 * A `null` value deletes the key, which is how the UI clears a board
 * selection; `undefined` and `""` leave it alone so that a patch built from a
 * partially filled form cannot erase settings it did not mean to touch.
 */
export function mergeConfigFile(path: string, patch: object): void {
  mkdirSync(dirname(path), { recursive: true });
  let existing: Record<string, unknown> = {};
  try {
    if (existsSync(path)) existing = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    existing = {};
  }
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete existing[key];
      continue;
    }
    if (value === undefined || value === "") continue;
    existing[key] = value;
  }
  writeFileSync(path, JSON.stringify(existing, null, 2), "utf8");
}

/** Merge the given fields into ~/.prometheus/config.json, preserving everything else. */
export function writeConfigFile(patch: EditableConfig): void {
  mergeConfigFile(CONFIG_FILE, patch);
}

/**
 * Where a board selection belongs.
 *
 * A project that already carries `.prometheus/config.json` has stated its own
 * settings, and `loadConfig` merges that file over the global one. Writing the
 * selection to the global file in that case would look like it worked and be
 * silently overridden on the next load, so the project file wins here too.
 */
export function boardConfigPath(cwd?: string): string {
  if (cwd) {
    const project = join(cwd, ".prometheus", "config.json");
    if (existsSync(project)) return project;
  }
  return CONFIG_FILE;
}

export function writeBoardConfig(selection: BoardSelection | null, cwd?: string): string {
  const path = boardConfigPath(cwd);
  mergeConfigFile(path, { board: selection });
  return path;
}

/** Mask a key for display: keep the first 4 and last 4 characters. */
export function maskKey(key: string): string {
  if (!key) return "";
  if (key.length <= 10) return "•".repeat(key.length);
  return `${key.slice(0, 4)}${"•".repeat(Math.min(20, key.length - 8))}${key.slice(-4)}`;
}
