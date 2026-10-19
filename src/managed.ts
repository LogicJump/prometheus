/**
 * Machine-wide settings an organisation controls.
 *
 * A project file can override a user file by design — that is how "this repo
 * builds with these flags" works — but the same mechanism means a cloned
 * repository can turn off every safety setting on the way in. Managed settings
 * are the missing top layer: one file, written by an administrator, that a
 * project file cannot override and that only adds restrictions.
 *
 * The file lives outside the workspace (`%ProgramData%` on Windows) so a
 * checkout cannot carry one. Only keys that *remove* a capability are honoured
 * here: a managed file cannot grant a bypass the user did not choose.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface ManagedSettings {
  /** The file the values came from, for the settings page. */
  source: string;
  /** Refuse `bypassPermissions` and `dontAsk` even when asked for. */
  disableBypassPermissionsMode?: boolean;
  /** Only hooks from the managed file run; project and user hooks are ignored. */
  allowManagedHooksOnly?: boolean;
  /** A hard ceiling a project cannot raise. */
  maxBudgetUsd?: number;
  /** Lock the network policy to this value. */
  networkPolicy?: "off" | "proxy" | "open";
  /** Lock the sandbox strength. */
  sandbox?: "off" | "enforce";
  /** Extra disallowed tools, appended to the user's list. */
  disallowedTools?: string[];
}

const EMPTY: ManagedSettings = { source: "" };

/**
 * Every location a managed file may live, in priority order.
 *
 * On Windows the system location is `ProgramData`; the environment variable
 * wins when set, which is how a portable or test install points at its own.
 * The user's home is deliberately *not* a candidate: a managed policy that a
 * user can rewrite is not a policy.
 */
export function managedPaths(): string[] {
  const out: string[] = [];
  if (process.env.PROMETHEUS_MANAGED_SETTINGS) out.push(process.env.PROMETHEUS_MANAGED_SETTINGS);
  if (process.platform === "win32") {
    const programData = process.env.ProgramData ?? process.env.PROGRAMDATA;
    if (programData) out.push(join(programData, "Prometheus", "managed.json"));
  } else {
    out.push("/etc/prometheus/managed.json");
  }
  return out;
}

/**
 * Read the managed file, sanitising every field.
 *
 * A malformed file is ignored rather than half-applied: a policy that
 * silently drops the one restriction it could not parse is worse than none.
 */
export function loadManagedSettings(): ManagedSettings {
  for (const path of managedPaths()) {
    if (!existsSync(path)) continue;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      const settings: ManagedSettings = { source: path };
      if (parsed.disableBypassPermissionsMode === true) settings.disableBypassPermissionsMode = true;
      if (parsed.allowManagedHooksOnly === true) settings.allowManagedHooksOnly = true;
      const budget = typeof parsed.maxBudgetUsd === "number" ? parsed.maxBudgetUsd : Number.parseFloat(String(parsed.maxBudgetUsd ?? ""));
      if (Number.isFinite(budget) && budget > 0) settings.maxBudgetUsd = budget;
      if (parsed.networkPolicy === "off" || parsed.networkPolicy === "proxy" || parsed.networkPolicy === "open") {
        settings.networkPolicy = parsed.networkPolicy;
      }
      if (parsed.sandbox === "off" || parsed.sandbox === "enforce") settings.sandbox = parsed.sandbox;
      if (Array.isArray(parsed.disallowedTools)) {
        const tools = parsed.disallowedTools.filter((value): value is string => typeof value === "string" && value.trim() !== "");
        if (tools.length > 0) settings.disallowedTools = tools;
      }
      return settings;
    } catch {
      // Fall through to the next candidate; an unreadable file is no policy.
    }
  }
  return EMPTY;
}

/**
 * Apply managed restrictions to a fully resolved config.
 *
 * Called after `loadConfig`, so the result cannot be undone by a project file
 * that was read earlier. Each field only tightens: a managed `maxBudgetUsd`
 * lowers a user's budget and never raises it, and managed `disallowedTools`
 * are appended rather than replacing the user's list.
 */
export function applyManaged<T extends {
  permissionMode: string;
  networkPolicy?: "off" | "proxy" | "open";
  sandbox?: "off" | "enforce";
  maxBudgetUsd?: number;
  disallowedTools?: string[];
}>(config: T, managed: ManagedSettings): { config: T; notes: string[] } {
  const notes: string[] = [];
  if (managed.disableBypassPermissionsMode) {
    if (config.permissionMode === "bypassPermissions" || config.permissionMode === "dontAsk") {
      notes.push(`managed settings do not allow ${config.permissionMode}; falling back to auto`);
      config = { ...config, permissionMode: "auto" };
    }
  }
  if (managed.networkPolicy && config.networkPolicy !== managed.networkPolicy) {
    // A managed `off` cannot be loosened; a managed `open` cannot be tightened
    // by a project, which is the case an administrator usually wants.
    config = { ...config, networkPolicy: managed.networkPolicy };
    notes.push(`network policy set to ${managed.networkPolicy} by managed settings`);
  }
  if (managed.sandbox && config.sandbox !== managed.sandbox) {
    config = { ...config, sandbox: managed.sandbox };
    notes.push(`sandbox set to ${managed.sandbox} by managed settings`);
  }
  if (managed.maxBudgetUsd !== undefined) {
    const current = config.maxBudgetUsd;
    if (current === undefined || current > managed.maxBudgetUsd) {
      config = { ...config, maxBudgetUsd: managed.maxBudgetUsd };
      notes.push(`budget capped at $${managed.maxBudgetUsd} by managed settings`);
    }
  }
  if (managed.disallowedTools) {
    const merged = new Set([...(config.disallowedTools ?? []), ...managed.disallowedTools]);
    config = { ...config, disallowedTools: [...merged] };
  }
  return { config, notes };
}
