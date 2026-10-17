/**
 * Settings persistence for the desktop app.
 *
 * The host owns ~/.prometheus/config.json; it also keeps a small UI state file
 * (locale, theme, last workspace) so both survive restarts without the
 * renderer touching the filesystem.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_HOME } from "./config.ts";

export interface UiSettings {
  locale?: "en" | "zh";
  theme?: "dark" | "light";
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
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  permissionMode?: string;
  thinkingEffort?: string;
  maxTokens?: number;
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
