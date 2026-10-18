/** Permission gating: plan/readonly/ask/auto modes, session-level "always" approvals, and audit logging. */

import { appendFileSync, mkdirSync } from "node:fs";
import { join, relative, isAbsolute, resolve } from "node:path";
import type { Config, PermissionManager, PermissionMode, Tool } from "./types.ts";
import type { TerminalUi } from "./ui.ts";
import { CONFIG_HOME } from "./config.ts";
import { classifyCommand, type SandboxPolicy } from "./sandbox.ts";


export class Permissions implements PermissionManager {
  mode: PermissionMode;
  private readonly config: Config;
  private readonly ui: TerminalUi;
  private readonly always = new Set<string>();
  private readonly logPath: string;

  constructor(config: Config, ui: TerminalUi) {
    this.config = config;
    this.ui = ui;
    this.mode = config.permissionMode;
    for (const name of config.autoApprove) this.always.add(name);
    mkdirSync(CONFIG_HOME, { recursive: true });
    this.logPath = join(CONFIG_HOME, "audit.log");
  }

  async check(tool: Tool, input: Record<string, unknown>): Promise<{ allowed: boolean; reason?: string }> {
    const summary = tool.summarize(input);

    if (this.mode === "plan" && !tool.readonly) {
      return { allowed: false, reason: "plan mode: only read-only tools are allowed" };
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
    if (answer === "always") this.always.add(tool);
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
