/**
 * Tool execution as one explicit pipeline.
 *
 * Every tool call walks five stages; each stage has exactly one responsibility
 * and a stage can stop the call:
 *
 *   1. resolve   parse arguments, find the tool, reject unknown/malformed calls
 *   2. guard     permission check and PreToolUse hooks (a hook may veto in any mode)
 *   3. prepare   checkpoint the file and record the change baseline
 *   4. execute   run the tool with a ToolContext
 *   5. settle    PostToolUse hooks, UI reporting, and error shaping
 *
 * Keeping the stages named means a tool never has to think about permissions
 * or checkpointing, and the loop never has to re-implement ordering.
 */

import type { Config, Tool, ToolContext, ToolResult, TodoList } from "../types.ts";
import type { Ui, PermissionManager } from "../types.ts";
import { captureBefore } from "../checkpoints.ts";
import { hooksFor, runHooks, type Hook } from "../hooks.ts";

export interface PipelineDeps {
  config: Config;
  ui?: Ui;
  permissions: PermissionManager;
  todos: TodoList;
  hooks: Hook[];
  /** Checkpoint file mutations for this session; empty disables it. */
  sessionId: string;
  /** Called before a mutating file tool runs. */
  onBeforeMutate?: ((toolName: string, input: Record<string, unknown>) => void) | null;
  /** Run a sub-task; only the top-level agent provides this. */
  runSubagent: (prompt: string) => Promise<string>;
  /** Run several sub-tasks concurrently (optional; falls back to serial). */
  runSubagents?: (prompts: string[]) => Promise<{ ok: boolean; report: string }[]>;
  /** Conversation length right now, recorded on each checkpoint for rewind. */
  messageIndex?: () => number;
  /** Skip permission prompts and hooks (sub-agents run under the parent's grant). */
  trusted?: boolean;
  cwd: string;
}

export interface PipelineOutcome {
  /** The text sent back to the model as the tool message. */
  content: string;
  ok: boolean;
}

const MUTATING_FILE_TOOLS = new Set(["write_file", "edit_file"]);

/** No-op UI for tests and headless callers that only want tool results. */
const SILENT_UI: Ui = {
  info() {},
  dim() {},
  warn() {},
  error() {},
  assistantText() {},
  assistantEnd() {},
  toolStart() {},
  toolEnd() {},
  thinking() {},
  thinkingEnd() {},
  todos() {},
  confirm: async () => "no",
  spinnerStart() {},
  spinnerStop() {},
};

export class ToolPipeline {
  private readonly tools: () => Tool[];
  private readonly deps: PipelineDeps;

  constructor(tools: () => Tool[], deps: PipelineDeps) {
    this.tools = tools;
    // Tests pass partial UI doubles; fill any missing methods with no-ops.
    this.deps = { ...deps, ui: { ...SILENT_UI, ...(deps.ui ?? {}) } };
  }

  async run(name: string, rawArgs: string, signal: AbortSignal): Promise<PipelineOutcome> {
    const ui = this.deps.ui as Ui;

    // 1. resolve
    const tool = this.tools().find((candidate) => candidate.name === name);
    if (!tool) {
      ui.error(`Unknown tool: ${name}`);
      return {
        ok: false,
        content: `Error: unknown tool "${name}". Available tools: ${this.tools().map((t) => t.name).join(", ")}`,
      };
    }
    let input: Record<string, unknown>;
    try {
      input = rawArgs.trim() ? (JSON.parse(rawArgs) as Record<string, unknown>) : {};
    } catch (err) {
      ui.error(`Invalid JSON for ${name}`);
      return {
        ok: false,
        content: `Error: arguments were not valid JSON (${(err as Error).message}). Re-issue the call with valid JSON.`,
      };
    }

    ui.toolStart(name, safeSummarize(tool, input));

    // 2. guard - hooks run first so a guard script can veto even in auto mode.
    if (!this.deps.trusted) {
      try {
        const verdict = await this.deps.permissions.check(tool, input);
        if (!verdict.allowed) {
          ui.toolEnd(name, false, verdict.reason ?? "denied");
          return { ok: false, content: `Error: ${verdict.reason ?? "permission denied"}. Do not retry; adjust your approach.` };
        }
      } catch (err) {
        ui.toolEnd(name, false, (err as Error).message);
        return { ok: false, content: `Error: permission check failed: ${(err as Error).message}` };
      }

      const preHooks = hooksFor(this.deps.hooks, "PreToolUse", name);
      if (preHooks.length > 0) {
        const results = await runHooks(preHooks, "PreToolUse", { tool: name, input }, this.deps.cwd);
        const blocked = results.find((result) => result.blocked);
        if (blocked) {
          const reason = blocked.output || `hook exited with code ${blocked.code}`;
          ui.toolEnd(name, false, `blocked by hook: ${reason.slice(0, 120)}`);
          return { ok: false, content: `Error: a PreToolUse hook blocked this call: ${reason}` };
        }
        const noise = results.map((result) => result.output).filter(Boolean).join("\n");
        if (noise) ui.toolOutput?.(name, noise);
      }
    }

    // 3. prepare
    if (this.deps.sessionId && MUTATING_FILE_TOOLS.has(name) && typeof input.path === "string") {
      try {
        captureBefore(this.deps.sessionId, name, this.deps.cwd, input.path, this.deps.messageIndex?.());
      } catch {
        /* checkpointing must never block a tool */
      }
    }
    try {
      this.deps.onBeforeMutate?.(name, input);
    } catch {
      /* diff snapshots must never block a tool */
    }

    // 4. execute
    const ctx: ToolContext = {
      cwd: this.deps.cwd,
      signal,
      config: this.deps.config,
      permissions: this.deps.permissions,
      ui,
      todo: this.deps.todos,
      runSubagent: this.deps.runSubagent,
      ...(this.deps.runSubagents ? { runSubagents: this.deps.runSubagents } : {}),
    };
    let result: ToolResult;
    try {
      result = await tool.execute(input, ctx);
    } catch (err) {
      // 5. settle (failure path)
      const message = (err as Error).message ?? String(err);
      ui.toolEnd(name, false, message.slice(0, 160));
      ui.toolOutput?.(name, message);
      return { ok: false, content: `Error: ${message}` };
    }

    // 5. settle
    ui.toolEnd(name, !result.isError, result.display ?? "");
    ui.toolOutput?.(name, result.content);
    if (!this.deps.trusted) {
      const postHooks = hooksFor(this.deps.hooks, "PostToolUse", name);
      if (postHooks.length > 0) {
        const results = await runHooks(
          postHooks,
          "PostToolUse",
          { tool: name, input, output: result.content },
          this.deps.cwd,
        );
        const noise = results.map((entry) => entry.output).filter(Boolean).join("\n");
        if (noise) ui.toolOutput?.(name, noise);
      }
    }
    return { ok: !result.isError, content: result.isError ? `Error: ${result.content}` : result.content };
  }
}

function safeSummarize(tool: Tool, input: Record<string, unknown>): string {
  try {
    return tool.summarize(input) ?? "";
  } catch {
    return "";
  }
}
