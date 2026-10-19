/** Permission gating: plan/readonly/ask/auto modes, persistent approval rules, and audit logging. */

import { appendFileSync, mkdirSync, realpathSync } from "node:fs";
import { join, relative, isAbsolute, resolve, basename, dirname } from "node:path";
import { homedir } from "node:os";
import type { Config, PermissionDetail, PermissionManager, PermissionMode, Tool } from "./types.ts";
import type { TerminalUi } from "./ui.ts";
import { CONFIG_HOME } from "./config.ts";
import { classifyCommand, type SandboxPolicy } from "./sandbox.ts";
import { matchRule, ruleFromChoice, rulesFor, type ApprovalRule } from "./rules.ts";

/** The scope answers `ui.ask` offers after "always allow". */
export const REMEMBER_SCOPE_OPTIONS = [
  { value: "always-detail", label: "Only this exact call" },
  { value: "always-tool", label: "Every call of this tool" },
] as const;

/**
 * Paths that are never covered by an allow rule.
 *
 * A saved "always allow write_file" is a statement about the project's source,
 * not about the machinery that runs the project. Editing `.git/hooks` or a
 * shell profile turns a routine write into code execution on the next command,
 * so those paths ask in every mode — including auto — and a deny here cannot be
 * overridden by an allow rule above it.
 */
const PROTECTED_SEGMENTS = [".git", ".vscode", ".idea", ".prometheus", ".ssh", ".gnupg", ".aws"];
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

/**
 * True when the path names a file whose content can change how the agent runs.
 *
 * The check is on the full path, not only on the part inside the workspace.
 * It used to return false for anything outside cwd, which meant `~/.ssh/config`
 * and `~/.prometheus/config.json` — files that decide how every later command
 * and every later session behaves — were less protected than `.git/hooks`
 * inside the project. A write there is exactly the escalation the list exists
 * to stop.
 */
export function isProtectedPath(target: string, cwd: string): boolean {
  const absolute = resolve(target);
  const parts = absolute.split(/[\\/]/).filter(Boolean);
  if (parts.some((part) => PROTECTED_SEGMENTS.includes(part))) return true;
  return PROTECTED_FILES.has(basename(absolute).toLowerCase()) || PROTECTED_FILES.has(basename(absolute));
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
  /**
   * Calls refused because no approval was available (not policy denials).
   * A one-shot run uses this to exit non-zero: the turn "completed" but the
   * work it was asked for did not happen.
   */
  deniedWithoutApproval = 0;
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

  async check(
    tool: Tool,
    input: Record<string, unknown>,
    detail?: PermissionDetail,
  ): Promise<{ allowed: boolean; reason?: string }> {
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
        return this.prompt(tool.name, `${summary} (protected path — this can change how the agent itself runs)`, detail);
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
        if (verdict.class === "confirm") return this.prompt(tool.name, `${summary} (${verdict.reason})`, detail);
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

    if (this.always.has(tool.name) || this.always.has("*")) return this.allow(tool.name, summary);
    // A saved rule can only see the summary, so a tool whose arguments vary
    // (bash) still needs a person on each call. An unattended run has nobody
    // to ask, and the old code answered "no" for every such tool: CI could
    // never run a build. Refuse with the grant that would have worked instead.
    if (this.config.unattended) {
      this.deniedWithoutApproval += 1;
      this.audit(tool.name, summary, "denied (no grant)");
      return {
        allowed: false,
        reason:
          `${tool.name} has no standing approval in this non-interactive run. ` +
          `Add it to --allowed-tools (or pass --dont-ask) if it should be permitted, ` +
          `or use a tool that needs no approval.`,
      };
    }
    return this.prompt(tool.name, summary, detail);
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

  private async prompt(tool: string, summary: string, detail?: PermissionDetail): Promise<{ allowed: boolean; reason?: string }> {
    // A run with no person behind it cannot answer a prompt. Refusing is right,
    // but the reason has to say which of the two things happened: a policy
    // said no, or nobody was there to say yes. "The user denied this tool
    // call" sent the model down the wrong path in CI.
    if (this.config.unattended || (this.ui as { canPrompt?: boolean }).canPrompt === false) {
      this.deniedWithoutApproval += 1;
      this.audit(tool, summary, "denied (no grant)");
      return {
        allowed: false,
        reason:
          `no approval was granted for ${tool} in this non-interactive run. ` +
          `Re-run with --allowed-tools ${tool} (or --dont-ask) if it should be permitted, ` +
          `or use a tool that needs no approval.`,
      };
    }

    // No leading newline: the terminal UI writes its own blank line before the
    // prompt, and the desktop bar rendered the separator as an empty first
    // line above the tool name.
    const answer = await this.ui.confirm(`${tool}: ${summary}\nAllow?`, detail);
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
      //
      // Which one to remember is a second question, and the one place where
      // the answer changes what the user is trusting. A UI that can ask it
      // gets a choice; one that cannot (the terminal, a script) keeps the
      // narrow default.
      const choice = await this.rememberScope(tool);
      // "Every call of this tool" is the whole-tool grant. "Only this exact
      // call" must not fall back to it: the session-level Set would then wave
      // through every later `rm`, which is precisely what the user declined.
      // The saved rule covers the exact summary instead.
      if (choice === "always-tool") this.always.add(tool);
      let persisted = false;
      try {
        ruleFromChoice(tool, choice === "always-tool" ? "" : summary, "project", process.cwd(), choice);
        this.rules.splice(0, this.rules.length, ...rulesFor(process.cwd()));
        persisted = true;
      } catch {
        /* A rule file that cannot be written must not block the approval the
           user just gave; a whole-tool grant still applies to this session. */
      }
      const verdict =
        choice === "always-tool" ? "allowed (always, whole tool)" : "allowed (always, this call)";
      this.audit(tool, summary, persisted ? verdict : `${verdict}, rule not saved`);
      return { allowed: true };
    }
    this.audit(tool, summary, "allowed");
    return { allowed: true };
  }

  /**
   * Ask what "always" should cover, when the UI can render the question.
   * The permission bar is already open at this point; `ask` reuses it for two
   * more buttons. The terminal has no such bar, so it keeps the old behaviour:
   * always means this exact call, which is the choice that grants the least.
   */
  private async rememberScope(tool: string): Promise<"always-tool" | "always-detail"> {
    const ui = this.ui as TerminalUi & { ask?: (q: string, o: { value: string; label: string }[]) => Promise<string> };
    if (!ui.ask) return "always-detail";
    try {
      const answer = await ui.ask(`Remember this approval for…`, [...REMEMBER_SCOPE_OPTIONS]);
      return answer === "always-tool" ? "always-tool" : "always-detail";
    } catch {
      // The question was dismissed or the window closed. The approval stands;
      // fall back to the narrower grant rather than failing the tool call.
      return "always-detail";
    }
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

/**
 * True when `target` resolves inside the workspace or an allowed directory.
 *
 * A lexical check is not enough on Windows: a junction (and, with developer
 * mode, a directory symlink) passes every string test and still hands back a
 * file from elsewhere. So the resolved path is compared with the real path of
 * each root. A path that does not exist yet cannot be resolved, so its nearest
 * existing ancestor is checked instead — the file being created is then inside
 * a directory that was itself verified.
 */
export function isWorkspaceConfinedPath(target: string, cwd: string, allowedDirs: string[] = []): boolean {
  const roots = [resolve(cwd), ...allowedDirs.map((dir) => resolve(cwd, dir))];
  const real = realPathOfNearest(target);
  return roots.some((root) => {
    const realRoot = realPathOfNearest(root);
    const rel = relative(realRoot, real);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  });
}

/** realpath of `target`, or of its nearest existing ancestor for a new file. */
function realPathOfNearest(target: string): string {
  let current = resolve(target);
  for (let depth = 0; depth < 64; depth++) {
    try {
      return realpathSync.native(current);
    } catch {
      const parent = dirname(current);
      if (parent === current) return resolve(target);
      current = parent;
    }
  }
  return resolve(target);
}

/** Resolve a model-supplied path and confine it to the workspace (plus explicitly allowed dirs). */
export function resolveSafePath(inputPath: string, cwd: string, allowedDirs: string[]): string {
  const target = isAbsolute(inputPath) ? resolve(inputPath) : resolve(cwd, inputPath);
  if (!isWorkspaceConfinedPath(target, cwd, allowedDirs)) {
    throw new Error(`path escapes the workspace: ${inputPath}`);
  }
  return target;
}

/** Lexical containment check for tools that need the relative form. */
export function relativeToRoot(target: string, cwd: string): string {
  return relative(cwd, target) || ".";
}
