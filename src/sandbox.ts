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
 *
 * One shape is handled structurally even though it looks like "just another
 * regex": after `cd` to a directory outside the workspace, every relative path
 * in the rest of the line resolves somewhere the scan never looked. Refusing
 * that prefix is not a rules contest — it closes the one escape hatch the path
 * scan structurally cannot see.
 */

import { homedir } from "node:os";
import { isAbsolute, resolve, relative } from "node:path";

export type CommandClass = "allow" | "confirm" | "deny";

export interface SandboxPolicy {
  /** "off" restores the pre-sandbox behaviour (full env, no classification). */
  mode: "off" | "enforce";
  network: "off" | "proxy" | "open";
  allowedDirs: string[];
  /** Environment variables injected without entering the model's context. */
  credentials?: Record<string, string>;
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
  // In-place edits and bulk deletes destroy content without matching any shape
  // above. Each is one command that can rewrite every file it matches or
  // remove a tree, so they are confirms rather than routine work.
  { class: "confirm", pattern: /\bsed\s+(-[a-zA-Z]*i|--in-place)\b/i, reason: "editing files in place" },
  { class: "confirm", pattern: /\b(find|fd)\b[^|;&]*\s-(delete|exec\s+rm)\b/i, reason: "deleting files by search" },
  { class: "confirm", pattern: /\btruncate\s+(-s\s*0|--size[= ]0)\b/i, reason: "truncating a file" },
  { class: "confirm", pattern: /\bgit\s+push\b[^|;&]*(--mirror|--all)\b/i, reason: "pushing every ref" },
  { class: "confirm", pattern: /\bgit\s+(filter-branch|filter-repo)\b/i, reason: "rewriting repository history" },
  { class: "confirm", pattern: />\s*\S*\.(env|pem|key|pfx)\b/i, reason: "writing over a credential file" },
];

const NETWORK_FETCHERS = /\b(curl|wget|Invoke-WebRequest|Invoke-RestMethod|iwr|irm|git\s+clone|ssh|scp|sftp|nc|ncat|telnet)\b/i;

/**
 * Inline code passed to an interpreter: `python -c "..."`, `node -e`,
 * `powershell -Command`, `sh -c`, `perl -e`, `ruby -e`.
 *
 * The path scan below reads the command line, so a script body is opaque to
 * it: `python -c "open('/etc/passwd').read()"` contains no absolute path in an
 * argument position. Judging the body would be a regex contest the defender
 * loses, so the rule is structural — an inline program is a confirm, and one
 * that names a network module is a deny when the network is off.
 */
const INLINE_INTERPRETER =
  /\b(python|python3|py|node|deno|bun|perl|ruby|php|powershell|pwsh|bash|sh|zsh|cmd)\b[^|;&]*?\s(-c|-e|-Command|-command|\/c|\/C)\s+(["'])/;

/**
 * Modules and calls that reach the network from an inline script.
 *
 * No trailing `\b`: `require('https')` ends in `)`, which is not a word
 * character, so a boundary there can never match — the pattern was dead on
 * exactly the shapes it was written for.
 */
const INLINE_NETWORK =
  /\b(?:urllib\.request|urllib3|http\.client|httpx|requests\.(?:get|post)|socket\.socket|aiohttp|urlopen|fetch\(|XMLHttpRequest|require\(['"]https?['"]\)|from\s+['"]https?|Invoke-WebRequest|Invoke-RestMethod|Net\.WebClient|HttpClient)/i;

/** A shelling-out call inside an inline program, which the path scan cannot see. */
const INLINE_SUBPROCESS =
  /\b(subprocess\.|os\.system|os\.popen|child_process|execSync|spawnSync|system\(|`[^`]+`)/;

export class SandboxError extends Error {
  verdict: CommandVerdict;

  constructor(verdict: CommandVerdict) {
    super(verdict.reason ?? "blocked by the command sandbox");
    this.name = "SandboxError";
    this.verdict = verdict;
  }
}

/** Classify a command line. Pure: no filesystem access, no spawn. */
/**
 * Which filesystem the command's paths refer to.
 *
 * Under the WSL kernel sandbox the command runs with Linux paths, so the
 * workspace is `/mnt/g/...` and a Windows `G:\...` string in the command is
 * not an absolute path there at all. Judging a sandboxed command with Windows
 * semantics rejected `cd /mnt/g/Develop/Prometheus && ls` as an escape from
 * the workspace it was actually standing in.
 */
export type PathFlavor = "windows" | "posix";

export function classifyCommand(
  command: string,
  cwd: string,
  policy: SandboxPolicy,
  options: { paths?: PathFlavor } = {},
): CommandVerdict {
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

  // An inline program is judged as a program, not as a command line.
  const inline = INLINE_INTERPRETER.test(command);
  if (inline) {
    if (policy.network === "off" && INLINE_NETWORK.test(command)) {
      return {
        class: "deny",
        reason: "the inline script reaches the network, and network access is off for commands in this session",
        violations: ["network"],
      };
    }
    if (INLINE_SUBPROCESS.test(command)) {
      return {
        class: "confirm",
        reason: "the inline script starts another process, which the path scan cannot inspect",
        violations: ["inline-subprocess"],
      };
    }
  }

  // `proxy` never reached classification: `loadConfig` rejects it and writes
  // `off` instead, because the only honest behaviour is the one the user can
  // predict. The branch stays for callers that build a policy by hand (tests,
  // a future implementation) and must not silently look implemented.
  if (policy.network === "proxy" && NETWORK_FETCHERS.test(command)) {
    return {
      class: "confirm",
      reason: "the per-command proxy policy is not implemented; this will use the network directly",
      violations: ["network"],
    };
  }

  // `cd` out of the workspace and then read with a relative path: the target
  // is invisible to the absolute-path scan, because `etc/passwd` is a relative
  // path resolved by the shell, not by us. The plan for the interpreter bypass
  // named `cd / && cat etc/passwd` as an example and it stayed allowed.
  const cdEscape = cdOutsideWorkspace(command, cwd, policy.allowedDirs, options.paths ?? "windows");
  if (cdEscape) {
    return {
      class: "deny",
      reason: `the command changes directory to ${cdEscape}, outside the workspace, and then runs relative paths`,
      violations: [cdEscape],
    };
  }

  const outside = pathsOutsideWorkspace(command, cwd, policy.allowedDirs, options.paths ?? "windows");
  if (outside.length > 0) {
    return {
      class: "deny",
      reason: `the command touches paths outside the workspace: ${outside.join(", ")}`,
      violations: outside,
    };
  }

  if (inline) {
    return {
      class: "confirm",
      reason: "an inline script cannot be inspected by the path scan; approve it once you have read it",
      violations: ["inline"],
    };
  }

  return { class: "allow", violations };
}

/**
 * A `cd` that leaves the workspace, when the command then does anything else.
 *
 * A bare `cd /tmp` on its own is harmless and common in build scripts. The
 * dangerous shape is `cd X && …` / `cd X; …`: after it, every relative path
 * in the rest of the line resolves somewhere the file-path scan never looked.
 * `cd && npm test` inside the workspace is fine, so only a target outside the
 * confined roots is refused.
 */
export function cdOutsideWorkspace(
  command: string,
  cwd: string,
  allowedDirs: string[],
  paths: PathFlavor = "windows",
): string | null {
  if (paths === "posix") return posixCdOutside(command, cwd, allowedDirs);
  const roots = [resolve(cwd), ...allowedDirs.map((dir) => resolve(cwd, dir))];
  const pattern = /(?:^|[;&|]\s*|\bthen\s+|\bdo\s+)cd(?:\s+\/d)?\s+("[^"]+"|'[^']+'|[^\s;&|]+)/gi;
  for (const match of command.matchAll(pattern)) {
    const raw = match[1].replace(/^["']|["']$/g, "");
    if (!raw || raw === "-" || raw === "~") {
      if (raw === "~" || raw === "-") return raw;
      continue;
    }
    // Only an absolute target can be checked lexically; a relative one starts
    // inside the workspace (or an ancestor the caller already controls).
    if (!isAbsolute(raw)) continue;
    const target = resolve(raw);
    const inside = roots.some((root) => {
      const rel = relative(root, target);
      return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
    });
    if (!inside) return raw;
  }
  return null;
}

/**
 * Lexical scan for absolute paths and parent escapes. Deliberately
 * conservative: a false positive is reported to the model with the offending
 * path, so it can rewrite the command relative to the workspace.
 */
export function pathsOutsideWorkspace(
  command: string,
  cwd: string,
  allowedDirs: string[],
  paths: PathFlavor = "windows",
): string[] {
  if (paths === "posix") return posixPathsOutside(command, cwd, allowedDirs);
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

  // Parent-relative escapes: `cat ../../Windows/win.ini` never appears in the
  // absolute-path scan, because the shell resolves it. A `..` that still lands
  // inside the workspace (the common `../src` case) is fine.
  for (const token of command.match(/(?:\.\.[\\/])+[^\s'"|;&<>()]*/g) ?? []) {
    const target = resolve(cwd, token);
    const inside = roots.some((root) => {
      const rel = relative(root, target);
      return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
    });
    if (!inside) outside.push(token);
  }
  return [...new Set(outside)].slice(0, 5);
}

/* ---------- POSIX path flavour (WSL kernel sandbox) ---------- */

/**
 * The WSL side of the workspace.
 *
 * A sandboxed command sees the workspace at `/mnt/<drive>/<path>` and nothing
 * in it is case-sensitive in the way Windows paths are. Keeping the check
 * lexical, like its Windows counterpart, is deliberate: this is still a policy
 * layer answering "did the model mean to leave the workspace", and the
 * kernel's read-only bind is what enforces it.
 */
function posixRoot(cwd: string): string {
  const drive = /^([A-Za-z]):[\\/]*(.*)$/.exec(cwd);
  if (!drive) return cwd.replace(/\\/g, "/");
  const rest = drive[2].replace(/\\/g, "/").replace(/\/+$/, "");
  return `/mnt/${drive[1].toLowerCase()}${rest ? `/${rest}` : ""}`;
}

function posixInside(roots: string[], target: string): boolean {
  const normalized = normalizePosix(target);
  return roots.some((root) => {
    const base = normalizePosix(root);
    return normalized === base || normalized.startsWith(`${base}/`);
  });
}

/** Resolve `.` and `..` the way the shell's `cd` would, without a filesystem. */
export function normalizePosix(path: string): string {
  const absolute = path.startsWith("/");
  const parts: string[] = [];
  for (const segment of path.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (parts.length === 0) {
        if (absolute) continue;
        parts.push("..");
        continue;
      }
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return `${absolute ? "/" : ""}${parts.join("/")}` || (absolute ? "/" : ".");
}

export function posixCdOutside(command: string, cwd: string, allowedDirs: string[]): string | null {
  const roots = [posixRoot(cwd), ...allowedDirs.map((dir) => posixRoot(resolve(cwd, dir)))];
  const pattern = /(?:^|[;&|]\s*|\bthen\s+|\bdo\s+)cd\s+("[^"]+"|'[^']+'|[^\s;&|]+)/gi;
  for (const match of command.matchAll(pattern)) {
    const raw = match[1].replace(/^["']|["']$/g, "");
    if (!raw || raw === "~" || raw === "-") {
      if (raw === "~" || raw === "-") return raw;
      continue;
    }
    if (!raw.startsWith("/")) continue;
    if (!posixInside(roots, raw)) return raw;
  }
  return null;
}

export function posixPathsOutside(command: string, cwd: string, allowedDirs: string[]): string[] {
  const roots = [posixRoot(cwd), ...allowedDirs.map((dir) => posixRoot(resolve(cwd, dir)))];
  const outside: string[] = [];
  // Absolute tokens, but not the ones the base image itself provides. `/dev`,
  // `/tmp` and `/proc` are inside the namespace and writable; refusing them
  // would fail every shell pipeline that uses `/dev/null`.
  for (const match of command.matchAll(/\/(?=[^\s'"|;&<>()])[^\s'"|;&<>()]*/g)) {
    const token = match[0];
    const at = match.index ?? 0;
    if (at > 0 && /[\w.~-]/.test(command[at - 1])) continue;
    if (/^\/(dev|tmp|proc|sys)(\/|$)/.test(token)) continue;
    if (!posixInside(roots, token)) outside.push(token);
  }
  // `..` escapes are only meaningful relative to the workspace root.
  for (const token of command.match(/(?:\.\.\/)+[^\s'"|;&<>()]*/g) ?? []) {
    const target = normalizePosix(`${roots[0]}/${token}`);
    if (!posixInside(roots, target)) outside.push(token);
  }
  return [...new Set(outside)].slice(0, 5);
}

/** Minimal environment for sandboxed commands; secrets are not inherited. *//**
 * Variables a sandboxed command may see, plus credentials the user injected.
 *
 * `sandbox.credentials` exists so a build can authenticate without the value
 * ever entering the model's context: the user stores it in settings, the
 * sandbox receives it as an environment variable, and the transcript only ever
 * shows the variable name.
 */
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
  // Values the user explicitly injected. They are added last so a credential
  // named PATH cannot replace the toolchain path, and never logged: the
  // transcript names the variable, not the secret.
  for (const [name, value] of Object.entries(policy.credentials ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
    if (name === "PATH" || name === "SystemRoot") continue;
    env[name] = value;
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
