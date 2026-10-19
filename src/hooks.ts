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
 * becomes the reason the model sees; UserPromptSubmit can veto the prompt and
 * PreCompact can cancel the compaction. Other hooks only report their output.
 *
 * Hooks are a trust boundary: they run arbitrary local commands, so they are
 * only loaded from files the user controls, never from a remote source.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CONFIG_HOME } from "./config.ts";

export type HookEvent =
  | "PreToolUse"
  | "PostToolUse"
  | "UserPromptSubmit"
  | "PreCompact"
  | "PostCompact"
  | "SubagentStart"
  | "SubagentStop"
  | "SessionStart"
  | "Stop";

/** Events whose non-zero exit blocks the action rather than only reporting. */
const BLOCKING: HookEvent[] = ["PreToolUse", "UserPromptSubmit", "PreCompact"];

export interface Hook {
  event: HookEvent;
  matcher?: string;
  command: string;
  timeoutMs?: number;
}

interface HookFile {
  hooks?: Partial<Record<HookEvent, { matcher?: string; command?: string; timeout_ms?: number }[]>>;
}

const EVENTS: HookEvent[] = [
  "PreToolUse",
  "PostToolUse",
  "UserPromptSubmit",
  "PreCompact",
  "PostCompact",
  "SubagentStart",
  "SubagentStop",
  "SessionStart",
  "Stop",
];

export interface HookResult {
  code: number;
  output: string;
  blocked: boolean;
  /** A replacement tool input (PreToolUse) or prompt (UserPromptSubmit). */
  replace?: unknown;
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
  const global = readFile(join(CONFIG_HOME, "hooks.json"));
  // A cloned repository is not a trust decision. A project hook runs an
  // arbitrary command, so it stays dormant until the user has looked at this
  // checkout's hook file and accepted it.
  const project = projectHooksTrusted(cwd) ? readFile(projectHooksFile(cwd)) : [];
  return [...global, ...project];
}

function projectHooksFile(cwd: string): string {
  return join(cwd, ".prometheus", "hooks.json");
}

/** Where the decision is recorded. Local to the machine, one entry per path. */
function trustFile(): string {
  return join(CONFIG_HOME, "trusted-hooks.json");
}

function readTrust(): Record<string, string> {
  try {
    const parsed = JSON.parse(readFileSync(trustFile(), "utf8")) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [dir, hash] of Object.entries(parsed)) if (typeof hash === "string") out[dir] = hash;
    return out;
  } catch {
    return {};
  }
}

function hashFile(file: string): string {
  try {
    return createHash("sha256").update(readFileSync(file)).digest("hex").slice(0, 32);
  } catch {
    return "";
  }
}

/**
 * Whether this checkout's project hooks may run.
 *
 * A boolean per folder is not enough: `git pull` can add a hook, and the user
 * never approved that file. The recorded hash is of the hook file itself, so
 * any change — a new entry, an edited command — asks again.
 */
export function projectHooksTrusted(cwd: string): boolean {
  const file = projectHooksFile(cwd);
  if (!existsSync(file)) return false;
  const recorded = readTrust()[resolve(cwd)];
  return Boolean(recorded) && recorded === hashFile(file);
}

/** Accept this checkout's hooks as they are now. */
export function trustProjectHooks(cwd: string): void {
  const file = projectHooksFile(cwd);
  const hash = hashFile(file);
  if (!hash) return;
  const trust = readTrust();
  trust[resolve(cwd)] = hash;
  try {
    mkdirSync(CONFIG_HOME, { recursive: true });
    writeFileSync(trustFile(), JSON.stringify(trust, null, 2), "utf8");
  } catch {
    /* a trust file we cannot write means nothing runs, which is the safe side */
  }
}

/** Withdraw a decision (the Settings page's "revoke" action). */
export function revokeProjectHooks(cwd: string): void {
  const trust = readTrust();
  delete trust[resolve(cwd)];
  try {
    writeFileSync(trustFile(), JSON.stringify(trust, null, 2), "utf8");
  } catch {
    /* nothing to do */
  }
}

export interface HookStatus {
  file: string;
  exists: boolean;
  trusted: boolean;
  /** What the project file asks to run, one line per hook. */
  entries: { event: string; command: string }[];
  global: number;
}

/** What the user needs to see before deciding whether to trust this checkout. */
export function hooksStatus(cwd: string): HookStatus {
  const file = projectHooksFile(cwd);
  const exists = existsSync(file);
  return {
    file,
    exists,
    trusted: projectHooksTrusted(cwd),
    entries: exists
      ? readFile(file).map((hook) => ({ event: hook.event, command: hook.command }))
      : [],
    global: readFile(join(CONFIG_HOME, "hooks.json")).length,
  };
}

export function hooksFor(hooks: Hook[], event: HookEvent, toolName = ""): Hook[] {
  return hooks.filter((hook) => {
    if (hook.event !== event) return false;
    if (!hook.matcher) return true;
    if (event !== "PreToolUse" && event !== "PostToolUse" && event !== "SubagentStart" && event !== "SubagentStop") {
      return true;
    }
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
    // stdout is the hook's answer; stderr is commentary. Keeping them apart is
    // what lets a PreToolUse hook return a rewritten input as JSON on stdout
    // while still logging freely on stderr.
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < 20_000) stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 20_000) stderr += chunk.toString("utf8");
    });
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    }, hook.timeoutMs ?? 30_000);
    const settle = (exitCode: number) => {
      clearTimeout(timer);
      const output = (stdout.trim() || stderr.trim()).slice(0, 20_000);
      // Exit code 2 is the explicit "block" signal; any other non-zero is a
      // failure the user should see, but only blocking events act on it.
      const blocking = BLOCKING.includes(hook.event);
      const blocked = blocking && exitCode !== 0;
      let replace: unknown;
      if (stdout.trim().startsWith("{")) {
        try {
          const parsed = JSON.parse(stdout.trim()) as { input?: unknown; prompt?: unknown };
          if (hook.event === "PreToolUse" && parsed.input && typeof parsed.input === "object") replace = parsed.input;
          if (hook.event === "UserPromptSubmit" && typeof parsed.prompt === "string") replace = parsed.prompt;
        } catch {
          /* stdout was prose, not a control message */
        }
      }
      resolve({ code: exitCode, output, blocked, ...(replace !== undefined ? { replace } : {}) });
    };
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: 1, output: err.message, blocked: BLOCKING.includes(hook.event) });
    });
    child.on("exit", (code) => settle(code ?? 1));
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

/**
 * Run the prompt hooks and return the text the turn should actually use.
 * A hook that prints `{"prompt": "..."}` replaces the user's message, which is
 * how a project can expand its own shorthand without teaching the model a new
 * syntax.
 */
export async function applyPromptHooks(
  hooks: Hook[],
  text: string,
  cwd: string,
): Promise<{ text: string; blocked: boolean; output: string }> {
  const matched = hooksFor(hooks, "UserPromptSubmit");
  if (matched.length === 0) return { text, blocked: false, output: "" };
  const results = await runHooks(matched, "UserPromptSubmit", { prompt: text }, cwd);
  const blocker = results.find((result) => result.blocked);
  if (blocker) return { text, blocked: true, output: blocker.output };
  let next = text;
  for (const result of results) if (typeof result.replace === "string") next = result.replace;
  const output = results.map((result) => result.output).filter(Boolean).join("\n");
  return { text: next, blocked: false, output };
}
