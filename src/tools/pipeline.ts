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

import type { Config, PermissionDetail, Tool, ToolContext, ToolResult, TodoList } from "../types.ts";
import type { Ui, PermissionManager } from "../types.ts";
import { captureBefore } from "../checkpoints.ts";
import { hooksFor, runHooks, type Hook } from "../hooks.ts";
import { diffFile } from "../diff.ts";
import { withSpillPointer } from "../spill.ts";

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
  /** Start a sub-task that outlives the call; false when the cap is reached. */
  runSubagentInBackground?: (prompt: string) => boolean;
  /** Conversation length right now, recorded on each checkpoint for rewind. */
  messageIndex?: () => number;
  /** Called with a path the tool touched, so scoped rules can load. */
  onTouch?: (path: string) => void;
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

  /** The current tool list, so the loop can tell which calls may run together. */
  available(): Tool[] {
    return this.tools();
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
    if (typeof input.path === "string") {
      try {
        this.deps.onTouch?.(input.path);
      } catch {
        /* rule scoping must never block a tool */
      }
    }

    // 2. guard - hooks run first so a guard script can veto even in auto mode.
    if (!this.deps.trusted) {
      // A file edit is approved on what it does, not on the path it names.
      // The plan is computed here, before the write, with the same matching
      // code the tool will run, so the diff shown is the diff that lands.
      const detail = name === "edit_file" ? await this.editDetail(input) : undefined;
      try {
        const verdict = await this.deps.permissions.check(tool, input, detail);
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
        // A hook may rewrite the arguments (a path normaliser, a policy that
        // pins a flag); the tool then runs with the merged input.
        for (const result of results) {
          if (result.replace && typeof result.replace === "object") {
            input = { ...input, ...(result.replace as Record<string, unknown>) };
          }
        }
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
      sessionId: this.deps.sessionId,
      runSubagent: this.deps.runSubagent,
      ...(this.deps.runSubagents ? { runSubagents: this.deps.runSubagents } : {}),
      ...(this.deps.runSubagentInBackground ? { runSubagentInBackground: this.deps.runSubagentInBackground } : {}),
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
    // A tool that may produce a very long result keeps the whole thing on disk
    // and names the file, so a truncated message is not a dead end.
    let content = result.content;
    if (tool.persistOutput && this.deps.sessionId) {
      content = withSpillPointer(result, this.deps.sessionId, name, result.content).content;
    }
    // A structured result goes to a UI that can render it; the transcript text
    // above is still what the model reads, so this is additive and optional.
    if (result.data !== undefined) ui.toolDetail?.(name, result.data);
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
    return { ok: !result.isError, content: result.isError ? `Error: ${content}` : content };
  }

  /**
   * The diff an `edit_file` approval is about.
   *
   * Absent when it cannot be computed; the approval then falls back to the
   * plain summary and the tool reports its own error after the answer.
   */
  private async editDetail(input: Record<string, unknown>): Promise<PermissionDetail | undefined> {
    try {
      const { planEdit } = await import("./fileTools.ts");
      const plan = await planEdit(input, this.deps.cwd, this.deps.config.allowedDirs ?? []);
      if (typeof plan === "string") return undefined;
      const summary = diffFile(plan.path, plan.before, plan.after);
      return { path: plan.path, before: plan.before, after: plan.after, additions: summary.additions, deletions: summary.deletions };
    } catch {
      return undefined;
    }
  }
}

function safeSummarize(tool: Tool, input: Record<string, unknown>): string {
  try {
    return tool.summarize(input) ?? "";
  } catch {
    return "";
  }
}
