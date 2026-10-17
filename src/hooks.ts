/**
 * Hooks: user commands run around agent activity.
 *
 * Configuration lives in ~/.prometheus/hooks.json (or
 * <workspace>/.prometheus/hooks.json):
 *
 *   {
 *     "hooks": {
 *       "PreToolUse":  [{ "matcher": "bash", "command": "./scripts/guard.sh" }],
 *       "PostToolUse": [{ "command": "npm run lint --silent" }],
 *       "SessionStart": [{ "command": "echo session started" }],
 *       "Stop": [{ "command": "notify-send done" }]
 *     }
 *   }
 *
 * The hook receives a JSON object on stdin describing the event and the
 * workspace. A non-zero exit from PreToolUse blocks the tool and its stderr
 * becomes the reason the model sees; other hooks only report their output.
 *
 * Hooks are a trust boundary: they run arbitrary local commands, so they are
 * only loaded from files the user controls, never from a remote source.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_HOME } from "./config.ts";

export type HookEvent = "PreToolUse" | "PostToolUse" | "SessionStart" | "Stop" | "UserPromptSubmit";

export interface Hook {
  event: HookEvent;
  matcher?: string;
  command: string;
  timeoutMs?: number;
}

interface HookFile {
  hooks?: Partial<Record<HookEvent, { matcher?: string; command?: string; timeout_ms?: number }[]>>;
}

const EVENTS: HookEvent[] = ["PreToolUse", "PostToolUse", "SessionStart", "Stop", "UserPromptSubmit"];

export interface HookResult {
  /** Non-zero for PreToolUse means "block the tool". */
  code: number;
  output: string;
  blocked: boolean;
}

function readFile(file: string): Hook[] {
  if (!existsSync(file)) return [];
  let parsed: HookFile;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8")) as HookFile;
  } catch {
    return [];
  }
  const out: Hook[] = [];
  for (const event of EVENTS) {
    for (const entry of parsed.hooks?.[event] ?? []) {
      if (!entry || typeof entry.command !== "string" || !entry.command.trim()) continue;
      out.push({
        event,
        matcher: typeof entry.matcher === "string" && entry.matcher !== "*" ? entry.matcher : undefined,
        command: entry.command,
        timeoutMs: Number.isFinite(entry.timeout_ms) ? Number(entry.timeout_ms) : 30_000,
      });
    }
  }
  return out;
}

/** Global hooks first, then project hooks; both run. */
export function loadHooks(cwd: string): Hook[] {
  return [...readFile(join(CONFIG_HOME, "hooks.json")), ...readFile(join(cwd, ".prometheus", "hooks.json"))];
}

export function hooksFor(hooks: Hook[], event: HookEvent, toolName = ""): Hook[] {
  return hooks.filter((hook) => {
    if (hook.event !== event) return false;
    if (!hook.matcher) return true;
    if (event !== "PreToolUse" && event !== "PostToolUse") return true;
    try {
      return new RegExp(hook.matcher).test(toolName);
    } catch {
      return hook.matcher === toolName;
    }
  });
}

function runOne(hook: Hook, payload: Record<string, unknown>, cwd: string): Promise<HookResult> {
  return new Promise((resolve) => {
    const shell = process.platform === "win32" ? process.env.ComSpec || "cmd.exe" : "/bin/sh";
    const args =
      process.platform === "win32" ? ["/d", "/s", "/c", hook.command] : ["-c", hook.command];
    const child = spawn(shell, args, { cwd, env: { ...process.env }, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    const append = (chunk: Buffer) => {
      if (output.length < 20_000) output += chunk.toString("utf8");
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    }, hook.timeoutMs ?? 30_000);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: 1, output: err.message, blocked: hook.event === "PreToolUse" });
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      const exitCode = code ?? 1;
      resolve({ code: exitCode, output: output.trim(), blocked: hook.event === "PreToolUse" && exitCode !== 0 });
    });
    child.stdin.end(`${JSON.stringify(payload)}\n`);
  });
}

/** Run every matching hook in order; stops at the first blocker. */
export async function runHooks(
  hooks: Hook[],
  event: HookEvent,
  payload: Record<string, unknown>,
  cwd: string,
): Promise<HookResult[]> {
  const results: HookResult[] = [];
  for (const hook of hooks) {
    const result = await runOne(hook, { event, cwd, ...payload }, cwd);
    results.push(result);
    if (result.blocked) break;
  }
  return results;
}
