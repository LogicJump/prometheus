/** Permission gating: plan/readonly/ask/auto modes, session-level "always" approvals, and audit logging. */

import { appendFileSync, mkdirSync } from "node:fs";
import { join, relative, isAbsolute, resolve, basename, dirname } from "node:path";
import { homedir } from "node:os";
import type { Config, PermissionManager, PermissionMode, Tool } from "./types.ts";
import type { TerminalUi } from "./ui.ts";
import { CONFIG_HOME } from "./config.ts";
import { classifyCommand, type SandboxPolicy } from "./sandbox.ts";
import { matchRule, ruleFromChoice, rulesFor, type ApprovalRule } from "./rules.ts";

/**
 * Paths that are never covered by an allow rule.
 *
 * A saved "always allow write_file" is a statement about the project's source,
 * not about the machinery that runs the project. Editing `.git/hooks` or a
 * shell profile turns a routine write into code execution on the next command,
 * so those paths ask in every mode — including auto — and a deny here cannot be
 * overridden by an allow rule above it.
 */
const PROTECTED_SEGMENTS = [".git", ".vscode", ".idea", ".prometheus"];
const PROTECTED_FILES = new Set([
  ".mcp.json",
  ".bashrc",
  ".bash_profile",
  ".zshrc",
  ".zprofile",
  ".profile",
  ".gitconfig",
  "Microsoft.PowerShell_profile.ps1",
]);

/** True when the path names a file whose content can change how the agent runs. */
export function isProtectedPath(target: string, cwd: string): boolean {
  const rel = relative(resolve(cwd), resolve(target));
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return false;
  const parts = rel.split(/[\\/]/);
  if (parts.some((part) => PROTECTED_SEGMENTS.includes(part))) return true;
  return PROTECTED_FILES.has(basename(target).toLowerCase()) || PROTECTED_FILES.has(basename(target));
}

/**
 * Commands whose blast radius is the machine, not the project. These bypass
 * every allow rule and the session's "always" set: no saved approval should be
 * able to authorise deleting the workspace root or the home directory.
 */
export function isCriticalCommand(command: string, cwd: string): string | null {
  const text = command.trim();
  const deleteMatch = /\b(rm|rmdir|del|erase|Remove-Item|ri)\b/i.exec(text);
  if (deleteMatch) {
    const targets = commandTargets(text);
    const roots = new Set([resolve(cwd), resolve(homedir())]);
    for (const target of targets) {
      const resolved = resolve(cwd, target);
      if (roots.has(resolved) || resolved === resolve("/") || /^[A-Za-z]:[\\/]?$/.test(resolved)) {
        return `refusing to delete ${target === "/" ? "the filesystem root" : target}`;
      }
    }
  }
  // `git clean -fdx` at the root of a repository removes every untracked file,
  // including the ones the user never committed. It stays a confirm, never an
  // allow.
  if (/\bgit\s+clean\s+-[a-z]*[fdx]/i.test(text) && /\s\.\s*$|\s\.\s*[;&|]/.test(text)) {
    return "refusing to clean the entire working tree";
  }
  return null;
}

/** Argument-like tokens in a delete command, minus flags and the command name. */
function commandTargets(text: string): string[] {
  const tokens = text.split(/\s+/).slice(1);
  return tokens
    .map((token) => token.replace(/^["']|["']$/g, ""))
    .filter((token) => Boolean(token) && !token.startsWith("-"));
}

export class Permissions implements PermissionManager {
  mode: PermissionMode;
  private readonly config: Config;
  private readonly ui: TerminalUi;
  private readonly always = new Set<string>();
  private readonly rules: ApprovalRule[];
  private readonly logPath: string;

  constructor(config: Config, ui: TerminalUi) {
    this.config = config;
    this.ui = ui;
    this.mode = config.permissionMode;
    for (const name of config.autoApprove) this.always.add(name);
    this.rules = rulesFor(process.cwd());
    mkdirSync(CONFIG_HOME, { recursive: true });
    this.logPath = join(CONFIG_HOME, "audit.log");
  }

  async check(tool: Tool, input: Record<string, unknown>): Promise<{ allowed: boolean; reason?: string }> {
    const summary = tool.summarize(input);

    if (this.mode === "plan" && !tool.readonly) {
      return { allowed: false, reason: "plan mode: only read-only tools are allowed" };
    }

    // The machine-wide circuit breakers run before any mode, rule, or saved
    // approval: they exist precisely for the case where everything else says yes.
    if (tool.name === "bash") {
      const critical = isCriticalCommand(String(input.command ?? ""), process.cwd());
      if (critical) {
        this.audit(tool.name, summary, `refused: ${critical}`);
        return { allowed: false, reason: `${critical}. This is refused in every mode; run it yourself if you mean it.` };
      }
    }

    if (typeof input.path === "string" && isProtectedPath(resolvePath(input.path), process.cwd())) {
      // Read-only tools may inspect these paths; only mutation is gated.
      if (!tool.readonly) {
        this.audit(tool.name, summary, "protected path");
        return this.prompt(tool.name, `${summary} (protected path — this can change how the agent itself runs)`);
      }
    }

    if (tool.readonly) return this.allow(tool.name, summary);

    if (this.mode === "auto") {
      if (tool.name === "bash") {
        const command = String(input.command ?? "");
        const verdict = classifyCommand(command, process.cwd(), this.sandboxPolicy());
        if (verdict.class === "deny") {
          this.audit(tool.name, summary, `denied by sandbox: ${verdict.reason}`);
          return { allowed: false, reason: `the command sandbox blocked this: ${verdict.reason}` };
        }
        if (verdict.class === "confirm") return this.prompt(tool.name, `${summary} (${verdict.reason})`);
      }
      return this.allow(tool.name, summary);
    }

    // Saved rules apply to every mode below plan; a deny beats a prompt.
    const rule = matchRule(this.rules, tool.name, summary);
    if (rule) {
      if (rule.action === "deny") {
        this.audit(tool.name, summary, "denied by rule");
        return { allowed: false, reason: `a saved rule denies ${tool.name} for "${summary}"` };
      }
      this.audit(tool.name, summary, "allowed by rule");
      return { allowed: true };
    }

    if (this.always.has(tool.name)) return this.allow(tool.name, summary);
    return this.prompt(tool.name, summary);
  }

  private sandboxPolicy(): SandboxPolicy {
    return {
      mode: this.config.sandbox ?? "enforce",
      network: this.config.networkPolicy ?? "off",
      allowedDirs: this.config.allowedDirs ?? [],
    };
  }

  private allow(tool: string, summary: string): { allowed: boolean } {
    this.audit(tool, summary, "allowed");
    return { allowed: true };
  }

  private async prompt(tool: string, summary: string): Promise<{ allowed: boolean; reason?: string }> {
    const answer = await this.ui.confirm(`\n${tool}: ${summary}\nAllow?`);
    if (answer === "no") {
      this.audit(tool, summary, "denied");
      return { allowed: false, reason: "the user denied this tool call" };
    }
    if (answer === "always") {
      // Persist, not just remember. A session-level Set used to be the whole
      // story, which meant "always allow" silently expired with the window and
      // the Settings page's Saved approvals list could never fill up.
      //
      // The rule matches the exact summary the user saw (a path, a command
      // line) rather than the whole tool: "always allow rm" is not a preference
      // anyone means to express by approving one `rm build/`. A tool with no
      // summary is safely tool-wide, because there is nothing to narrow to.
      this.always.add(tool);
      try {
        ruleFromChoice(tool, summary, "project", process.cwd(), "always-detail");
        this.rules.push(...rulesFor(process.cwd()).slice(this.rules.length));
      } catch {
        /* A rule file that cannot be written must not block the approval the
           user just gave; the in-memory grant still applies to this session. */
      }
    }
    this.audit(tool, summary, answer === "always" ? "allowed (always)" : "allowed");
    return { allowed: true };
  }

  private audit(tool: string, summary: string, verdict: string): void {
    try {
      appendFileSync(this.logPath, `${new Date().toISOString()}\t${verdict}\t${tool}\t${summary}\n`, "utf8");
    } catch {
      /* auditing must never break the run */
    }
  }
}

/** Resolve a model-supplied path against the workspace without the confinement check. */
function resolvePath(inputPath: string): string {
  return isAbsolute(inputPath) ? resolve(inputPath) : resolve(process.cwd(), inputPath);
}

/** Resolve a model-supplied path and confine it to the workspace (plus explicitly allowed dirs). */
export function resolveSafePath(inputPath: string, cwd: string, allowedDirs: string[]): string {
  const target = isAbsolute(inputPath) ? resolve(inputPath) : resolve(cwd, inputPath);
  const roots = [resolve(cwd), ...allowedDirs.map((d) => resolve(cwd, d))];
  const inside = roots.some((root) => {
    const rel = relative(root, target);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  });
  if (!inside) {
    throw new Error(`path escapes the workspace: ${inputPath}`);
  }
  return target;
}

/** Lexical containment check for tools that need the relative form. */
export function relativeToRoot(target: string, cwd: string): string {
  return relative(cwd, target) || ".";
}
