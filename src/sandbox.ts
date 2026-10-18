/**
 * Command sandbox: one policy layer for every shell command the agent runs.
 *
 * This is a policy sandbox, not an OS sandbox. It classifies a command line,
 * confines absolute paths to the workspace, scrubs the environment, and can cut
 * network access off. That stops accidents and casual misuse; it cannot stop a
 * determined program from doing something else. The settings UI says so.
 *
 * The classification table is shared with the permission layer, so `auto` mode,
 * the audit log, and the shell tool all agree on what a command is.
 */

import { homedir } from "node:os";
import { isAbsolute, resolve, relative } from "node:path";

export type CommandClass = "allow" | "confirm" | "deny";

export interface SandboxPolicy {
  /** "off" restores the pre-sandbox behaviour (full env, no classification). */
  mode: "off" | "enforce";
  network: "off" | "proxy" | "open";
  allowedDirs: string[];
}

export interface CommandVerdict {
  class: CommandClass;
  reason?: string;
  /** Paths or patterns that triggered the verdict. */
  violations: string[];
}

interface Rule {
  class: CommandClass;
  pattern: RegExp;
  reason: string;
}

/**
 * Ordered rules; the first match wins, so `deny` sits above `confirm`.
 * Patterns are intentionally simple line-level tests - anything cleverer turns
 * into a bypass contest.
 */
const RULES: Rule[] = [
  { class: "deny", pattern: /\bmkfs(\.\w+)?\b/i, reason: "formatting a filesystem" },
  { class: "deny", pattern: /\bdd\s+[^|;&]*of=\s*\/dev\/(sd|nvme|hd|disk)/i, reason: "writing to a raw disk" },
  { class: "deny", pattern: /\b(shutdown|reboot|halt|poweroff)\b/i, reason: "powering off the machine" },
  { class: "deny", pattern: /:\s*\(\s*\)\s*\{[^}]*:\s*\|\s*:/, reason: "fork bomb" },
  { class: "deny", pattern: /\bchmod\s+-R\s+777\s+\/(\s|$)/i, reason: "making the filesystem world-writable" },
  { class: "deny", pattern: /\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)*\/\s*$/i, reason: "recursive delete of the filesystem root" },
  { class: "deny", pattern: /\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)*(~|\$HOME)\s*$/i, reason: "recursive delete of the home directory" },
  { class: "deny", pattern: /\b(curl|wget)\b[^|;&]*\|\s*(sudo\s+)?(sh|bash|zsh|python|node)\b/i, reason: "piping a download into an interpreter" },
  { class: "deny", pattern: />\s*\/dev\/(sd|nvme|disk)/i, reason: "redirecting output to a raw disk" },

  // Recursive deletes are the destructive shape; `-f` alone only suppresses
  // the prompt, so it must not be labelled "recursive" (it was, because a
  // single `[rf]` matched the `f` in `rm -f file`).
  { class: "confirm", pattern: /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*\s+|--recursive\s+)/i, reason: "recursive delete" },
  { class: "confirm", pattern: /\bgit\s+reset\s+--hard\b/i, reason: "discarding uncommitted work" },
  { class: "confirm", pattern: /\bgit\s+clean\s+-[a-z]*f/i, reason: "deleting untracked files" },
  { class: "confirm", pattern: /\bgit\s+push\b[^|;&]*--force/i, reason: "force-pushing" },
  { class: "confirm", pattern: /\bgit\s+checkout\s+--\s+\./i, reason: "discarding working-tree changes" },
  { class: "confirm", pattern: /\b(npm|pnpm|yarn)\s+(install|add|i)\b/i, reason: "installing packages" },
  { class: "confirm", pattern: /\b(pip|pip3|uv)\s+(install|add)\b/i, reason: "installing packages" },
  { class: "confirm", pattern: /\b(apt|apt-get|brew|choco|winget|scoop)\s+(install|upgrade|remove)\b/i, reason: "changing system packages" },
  { class: "confirm", pattern: /\b(sudo|runas|Start-Process\s+.*-Verb\s+RunAs)\b/i, reason: "elevating privileges" },
  { class: "confirm", pattern: /&\s*$|\bnohup\b|\bstart\s+\/b\b/i, reason: "starting a background process" },
];

const NETWORK_FETCHERS = /\b(curl|wget|Invoke-WebRequest|Invoke-RestMethod|iwr|irm|git\s+clone|ssh|scp|sftp|nc|ncat|telnet)\b/i;

export class SandboxError extends Error {
  verdict: CommandVerdict;

  constructor(verdict: CommandVerdict) {
    super(verdict.reason ?? "blocked by the command sandbox");
    this.name = "SandboxError";
    this.verdict = verdict;
  }
}

/** Classify a command line. Pure: no filesystem access, no spawn. */
export function classifyCommand(command: string, cwd: string, policy: SandboxPolicy): CommandVerdict {
  if (policy.mode === "off") return { class: "allow", violations: [] };

  const violations: string[] = [];

  for (const rule of RULES) {
    if (rule.pattern.test(command)) {
      return { class: rule.class, reason: rule.reason, violations: [rule.pattern.source] };
    }
  }

  if (policy.network === "off" && NETWORK_FETCHERS.test(command)) {
    return {
      class: "deny",
      reason: "network access is off for commands in this session",
      violations: ["network"],
    };
  }

  const outside = pathsOutsideWorkspace(command, cwd, policy.allowedDirs);
  if (outside.length > 0) {
    return {
      class: "deny",
      reason: `the command touches paths outside the workspace: ${outside.join(", ")}`,
      violations: outside,
    };
  }

  return { class: "allow", violations };
}

/**
 * Lexical scan for absolute paths and parent escapes. Deliberately
 * conservative: a false positive is reported to the model with the offending
 * path, so it can rewrite the command relative to the workspace.
 */
export function pathsOutsideWorkspace(command: string, cwd: string, allowedDirs: string[]): string[] {
  const roots = [resolve(cwd), ...allowedDirs.map((dir) => resolve(cwd, dir))];
  // Only paths at an argument position count. A slash in the middle of a word
  // (`a/b`, `tests/*.test.ts`, a URL) is relative, not absolute.
  const tokens = command.match(/(?:[A-Za-z]:[\\/]|\/(?=[^\s'"|;&<>()]))[^\s'"|;&<>()]*/g) ?? [];
  const outside: string[] = [];
  for (const token of tokens) {
    // A slash that directly follows a word character belongs to a relative
    // path or a URL, not the start of an absolute one.
    const at = command.indexOf(token);
    if (at > 0 && /[\w.~-]/.test(command[at - 1])) continue;
    if (/^\/\//.test(token) || /^\/dev\/null$/.test(token) || /^\/dev\/std(in|out|err)$/.test(token)) continue;
    if (/^\/tmp(\/|$)/.test(token) || /^\/var\/tmp(\/|$)/.test(token)) continue;
    const target = resolve(cwd, token);
    const inside = roots.some((root) => {
      const rel = relative(root, target);
      return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
    });
    if (!inside) outside.push(token);
  }
  return [...new Set(outside)].slice(0, 5);
}

/** Minimal environment for sandboxed commands; secrets are not inherited. */
export function sandboxEnv(policy: SandboxPolicy): NodeJS.ProcessEnv {
  if (policy.mode === "off") return { ...process.env };

  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "",
    LANG: process.env.LANG ?? "en_US.UTF-8",
    LC_ALL: process.env.LC_ALL ?? "",
    TMPDIR: process.env.TMPDIR ?? "",
    TEMP: process.env.TEMP ?? "",
    TMP: process.env.TMP ?? "",
    NO_COLOR: "1",
    CI: "1",
    FORCE_COLOR: "0",
  };
  if (process.platform === "win32") {
    env.SystemRoot = process.env.SystemRoot ?? "";
    env.windir = process.env.windir ?? "";
    env.PATHEXT = process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD";
    env.ComSpec = process.env.ComSpec ?? "cmd.exe";
    env.USERPROFILE = process.env.USERPROFILE ?? homedir();
    env.APPDATA = process.env.APPDATA ?? "";
    env.LOCALAPPDATA = process.env.LOCALAPPDATA ?? "";
    env.ProgramFiles = process.env.ProgramFiles ?? "";
  }
  if (policy.network === "off") {
    env.HTTP_PROXY = "http://127.0.0.1:9";
    env.HTTPS_PROXY = "http://127.0.0.1:9";
    env.http_proxy = env.HTTP_PROXY;
    env.https_proxy = env.HTTPS_PROXY;
    env.NO_PROXY = "";
    env.no_proxy = "";
  }
  return env;
}

/** The spawn description the bash tool should use for this policy. */
export function shellFor(command: string, policy: SandboxPolicy): { shell: string; args: string[] } {
  const win = process.platform === "win32";
  const shell = win ? process.env.ComSpec || "cmd.exe" : "/bin/sh";
  const args = win ? ["/d", "/s", "/c", command] : ["-c", command];
  void policy;
  return { shell, args };
}
