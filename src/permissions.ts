/** Permission gating: plan/readonly/ask/auto modes, persistent approval rules, and audit logging. */

import { appendFileSync, mkdirSync, realpathSync } from "node:fs";
import { join, relative, isAbsolute, resolve, basename, dirname } from "node:path";
import { homedir } from "node:os";
import type { Config, PermissionDetail, PermissionManager, PermissionMode, Tool } from "./types.ts";
import type { TerminalUi } from "./ui.ts";
import { CONFIG_HOME, SESSIONS_DIR } from "./config.ts";
import { classifyCommand, type SandboxPolicy } from "./sandbox.ts";
import { globMatch, matchRuleAgainst, matchRule, parseRuleSpec, ruleFromChoice, rulesFor, type ApprovalRule } from "./rules.ts";

/** The scope answers `ui.ask` offers after "always allow". */
/**
 * `networkPolicy: "proxy"` is a documented value with no implementation.
 *
 * It is rejected at load time rather than carried to the sandbox, where it
 * would surface as a confirm on the first fetch — a setting that looks like a
 * working allowlist and only reveals itself later. The loader maps it to off,
 * so a config written for it behaves as the safer policy.
 */
export const UNIMPLEMENTED_NETWORK_POLICY: "proxy" | null = "proxy";

/** Tools that change files, for the `acceptEdits` mode. */
const FILE_MUTATORS = new Set(["write_file", "edit_file"]);

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

/**
 * The argument a saved rule is written against, per tool.
 *
 * The approval prompt shows a summary (path, or command plus a prose hint);
 * the rule has to look at the value the user actually typed into it.
 */
function ruleArgument(toolName: string, input: Record<string, unknown>): string | undefined {
  if (toolName === "bash") return typeof input.command === "string" ? input.command : undefined;
  if (typeof input.path === "string") return String(input.path);
  // MCP tools are named `mcp__<server>__<tool>`; a rule on the server prefix
  // matches every tool it serves.
  if (toolName.startsWith("mcp__")) {
    const server = toolName.split("__")[1];
    return server ? `mcp__${server}__` : undefined;
  }
  return undefined;
}

/**
 * Files whose content is a credential or a secret.
 *
 * There is no rule that makes reading `.env` routine: the content goes into
 * the model's context and out to the endpoint. Read-only tools skip the
 * approval prompt entirely, so the check has to run before that shortcut.
 * A saved rule can still grant it deliberately.
 */
const SENSITIVE_FILE = /^(?:\.env(?:\..*)?|\.npmrc|\.netrc|id_(?:rsa|ed25519|ecdsa|dsa)(?:\.pub)?|[^/\\]+\.(?:pem|pfx|p12|key|keystore|jks))$/i;

function isSensitiveFile(target: string): boolean {
  const name = basename(target);
  if (SENSITIVE_FILE.test(name)) return true;
  const parts = resolve(target).split(/[\\/]/).filter(Boolean);
  return parts.some((part) => part === ".ssh" || part === ".gnupg" || part === ".aws" || part === ".docker");
}

/** Whether a `Tool(specifier)` entry names this call. */
function matchesSpec(spec: string, toolName: string, summary: string, argument: string | undefined): boolean {
  const parsed = parseRuleSpec(spec);
  if (!parsed) return false;
  if (parsed.tool !== "*" && parsed.tool !== toolName) return false;
  if (!parsed.match) return true;
  const candidate = argument ?? summary;
  return globMatch(parsed.match, candidate) || globMatch(parsed.match, summary);
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

  /**
   * Where an approval came from, when this manager belongs to a sub-agent.
   *
   * A prompt that says only "bash: npm test" gives the user no way to tell
   * whether their own turn is asking or a child spawned three levels down is.
   * The label travels with the prompt and is stored in the audit log.
   */
  source = "";

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

    // `bypassPermissions` is the explicit "I mean it" mode. It still respects
    // plan mode above (which is a stronger statement about what may run) and
    // the critical-command breakers below, but it does not ask.
    if (this.mode === "bypassPermissions") {
      return this.allow(tool.name, summary);
    }

    // A credential file is data the model would send to the endpoint. Reading
    // one is a decision, not a routine read, and a read-only tool would
    // otherwise never prompt for it.
    if (typeof input.path === "string" && isSensitiveFile(resolvePath(input.path))) {
      if (!tool.readonly || this.mode === "ask") {
        this.audit(tool.name, summary, "sensitive file");
        return this.prompt(tool.name, `${summary} (credential file - its contents reach the model)`, detail, "credential file");
      }
    }

    // `--disallowed-tools` is a hard refusal, evaluated before every mode and
    // every saved rule. It is how a CI run says "never run this" alongside the
    // grants that say "these are fine".
    const forbidden = (this.config.disallowedTools ?? []).some((spec) => matchesSpec(spec, tool.name, summary, ruleArgument(tool.name, input)));
    if (forbidden) {
      this.audit(tool.name, summary, "denied by --disallowed-tools");
      return { allowed: false, reason: `${tool.name} is on the disallowed list for this run` };
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
        return this.prompt(tool.name, `${summary} (protected path — this can change how the agent itself runs)`, detail, "protected path");
      }
    }

    // Read-only tools are always safe to run. `dontAsk` is the one mode that
    // turns a would-be prompt into a refusal, so it is checked before this
    // shortcut only for mutating tools; reads never ask in the first place.
    if (tool.readonly) return this.allow(tool.name, summary);

    // `acceptEdits` is the common workflow that the three-mode model could not
    // express: file edits go through, shell commands still ask. The edit tools
    // are exactly the built-in pair; `bash` and MCP tools are not.
    if (this.mode === "acceptEdits" && !tool.name.startsWith("mcp__") && FILE_MUTATORS.has(tool.name)) {
      const rule = matchRuleAgainst(this.rules, tool.name, summary, ruleArgument(tool.name, input));
      if (rule?.action === "deny") {
        this.audit(tool.name, summary, "denied by rule");
        return { allowed: false, reason: `a saved rule denies ${tool.name} for "${summary}"` };
      }
      return this.allow(tool.name, summary);
    }

    // A standing grant has to be read before the mode branches, not after
    // them. `--mode auto --dont-ask` puts "*" in `autoApprove`, but the auto
    // branch asked a person about sandbox `confirm` commands first, and with
    // stdin closed that question could only be answered "no". The result was
    // that the one combination built for CI could not run `npm install`.
    // `--allowed-tools` accepts the same `Tool(specifier)` shape as a saved
    // rule, so a CI job can grant `Bash(git *)` without granting every command.
    const preApproved =
      this.always.has(tool.name) ||
      this.always.has("*") ||
      (this.config.autoApprove ?? []).some(
        (spec) => spec.includes("(") && matchesSpec(spec, tool.name, summary, ruleArgument(tool.name, input)),
      );

    if (this.mode === "auto") {
      if (tool.name === "bash") {
        const command = String(input.command ?? "");
        const verdict = classifyCommand(command, process.cwd(), this.sandboxPolicy());
        if (verdict.class === "deny") {
          this.audit(tool.name, summary, `denied by sandbox: ${verdict.reason}`);
          return { allowed: false, reason: `the command sandbox blocked this: ${verdict.reason}` };
        }
        if (verdict.class === "confirm" && !preApproved) {
          return this.prompt(tool.name, `${summary} (${verdict.reason})`, detail, `auto mode asks for this one: ${verdict.reason}`);
        }
      }
      return this.allow(tool.name, summary);
    }

    // Saved rules apply to every mode below plan; a deny beats a prompt.
    // The rule is matched against the argument it was written for — the
    // command line for bash, the path for file tools, the tool name for an
    // MCP server prefix — because the summary carries the model's prose
    // description after the real text and a scoped rule would miss its call.
    const rule = matchRuleAgainst(this.rules, tool.name, summary, ruleArgument(tool.name, input));
    if (rule) {
      if (rule.action === "deny") {
        this.audit(tool.name, summary, "denied by rule");
        return { allowed: false, reason: `a saved rule denies ${tool.name} for "${summary}"` };
      }
      this.audit(tool.name, summary, "allowed by rule");
      return { allowed: true };
    }

    if (preApproved) return this.allow(tool.name, summary);
    // A saved rule can only see the summary, so a tool whose arguments vary
    // (bash) still needs a person on each call. An unattended run has nobody
    // to ask, and the old code answered "no" for every such tool: CI could
    // never run a build. Refuse with the grant that would have worked instead.
    if (this.mode === "dontAsk") {
      this.audit(tool.name, summary, "denied (dontAsk mode)");
      return {
        allowed: false,
        reason: `dontAsk mode refuses ${tool.name} rather than prompting. Add a rule or switch mode if it should run.`,
      };
    }
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
    return this.prompt(
      tool.name,
      summary,
      detail,
      this.mode === "ask" ? "ask mode: this tool is not in a saved rule" : "not covered by a rule",
    );
  }
  private sandboxPolicy(): SandboxPolicy {
    return {
      mode: this.config.sandbox ?? "enforce",
      network: this.config.networkPolicy ?? "off",
      allowedDirs: this.config.allowedDirs ?? [],
      ...(this.config.sandboxCredentials ? { credentials: this.config.sandboxCredentials } : {}),
    };
  }

  private allow(tool: string, summary: string): { allowed: boolean } {
    this.audit(tool, summary, "allowed");
    return { allowed: true };
  }

  private async prompt(
    tool: string,
    summary: string,
    detail?: PermissionDetail,
    why?: string,
  ): Promise<{ allowed: boolean; reason?: string }> {
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
    const question = this.source ? `${tool}: ${summary} — ${this.source}\nAllow?` : `${tool}: ${summary}\nAllow?`;
    const answer = await this.ui.confirm(question, detail);
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
      // The origin is part of the record: an audit that cannot say which
      // child asked for a command is not an audit of a delegated run.
      const origin = this.source ? `${this.source} ` : "";
      appendFileSync(this.logPath, `${new Date().toISOString()}\t${verdict}\t${origin}${tool}\t${summary}\n`, "utf8");
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

/**
 * Read-only access to the session's own spilled tool output.
 *
 * A truncated result is written to `~/.prometheus/sessions/<id>/tool-results/`
 * and the tool message names that path, but reading it back was refused as an
 * escape from the workspace — the pointer was a dead end, and the model's only
 * option was to re-run the command. These files are produced by the agent
 * itself and live under the app's own directory, so reads there are allowed.
 * Writes and deletes still go through the normal confinement check.
 */
export function resolveReadablePath(inputPath: string, cwd: string, allowedDirs: string[]): string {
  const target = isAbsolute(inputPath) ? resolve(inputPath) : resolve(cwd, inputPath);
  if (isWorkspaceConfinedPath(target, cwd, allowedDirs) || isInsideToolResults(target)) return target;
  throw new Error(`path escapes the workspace: ${inputPath}`);
}

/** True when the real path sits under the sessions root's `tool-results` subtree. */
export function isInsideToolResults(target: string): boolean {
  const root = realPathOfNearest(SESSIONS_DIR);
  const real = realPathOfNearest(target);
  const rel = relative(root, real);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return false;
  // `<id>/tool-results/...` — anything else under sessions is not readable.
  const parts = rel.split(/[\\/]/);
  return parts.length >= 3 && parts[1] === "tool-results";
}

/** Lexical containment check for tools that need the relative form. */
export function relativeToRoot(target: string, cwd: string): string {
  return relative(cwd, target) || ".";
}
