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
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

function resolveForDiff(path: string, cwd: string): string | null {
  try {
    const abs = isAbsolute(path) ? resolve(path) : resolve(cwd, path);
    // A path outside the workspace is not shown inline: the diff would name a
    // file the Changes pane cannot open either.
    const rel = relative(cwd, abs);
    return rel.startsWith("..") || isAbsolute(rel) ? null : abs;
  } catch {
    return null;
  }
}

function relativeForDiff(cwd: string, abs: string): string {
  return relative(cwd, abs).split("\\").join("/");
}

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
  runSubagent: (prompt: string, options?: { context?: "none" | "summary" | "full" }) => Promise<string>;
  /** Run several sub-tasks concurrently (optional; falls back to serial). */
  runSubagents?: (prompts: string[], options?: { context?: "none" | "summary" | "full" }) => Promise<{ ok: boolean; report: string }[]>;
  /** Start a sub-task that outlives the call; false when the cap is reached. */
  runSubagentInBackground?: (prompt: string) => boolean;
  /** A hook supplied context; the agent appends it to the conversation. */
  onContext?: (text: string) => void;
  subagents?: {
    list(): { id: string; label: string; status: string; context: string; turns: number }[];
    message(id: string, text: string): Promise<string>;
    stop(id: string): boolean;
    report(id: string): string | null;
  };
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

/**
 * Fill in the methods a caller left out, without copying the caller's object.
 *
 * A class instance keeps its methods on the prototype; `{ ...instance }` sees
 * only own properties, so spreading one into a fresh object throws every
 * method away. This returns the original object when it is complete, and a
 * Proxy over it otherwise, forwarding each call to the real method when one
 * exists and to the no-op when it does not.
 */
function fillUi(ui: Ui | undefined): Ui {
  if (!ui) return SILENT_UI;
  let complete = true;
  for (const key of Object.keys(SILENT_UI) as (keyof Ui)[]) {
    if (typeof ui[key] !== "function") {
      complete = false;
      break;
    }
  }
  if (complete) return ui;
  return new Proxy(ui, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (value !== undefined) return value;
      return SILENT_UI[property as keyof Ui];
    },
  });
}

export class ToolPipeline {
  private readonly tools: () => Tool[];
  private readonly deps: PipelineDeps;
  /** Prior content of file writes in the current call, for the inline diff. */
  private readonly diffBaseline = new Map<string, string | null>();

  constructor(tools: () => Tool[], deps: PipelineDeps) {
    this.tools = tools;
    // Fill in only the methods a test double omitted. The previous
    // implementation spread the whole `ui` into a fresh object, which copies
    // *own* properties and silently drops every method defined on the class
    // prototype — so `HostUi.toolStart` became the no-op from `SILENT_UI`,
    // `typeof` was still "function", and the transcript lost every tool row
    // while the tools themselves ran and reported. A prototype-preserving
    // fill-in keeps the real object when it already has the method.
    this.deps = { ...deps, ui: fillUi(deps.ui) };
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

    const callId = `tool-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const startedAt = new Date().toISOString();
    ui.toolStart(name, safeSummarize(tool, input), { id: callId, input, at: startedAt });
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
      const detail = name === "edit_file" ? await this.editDetail(input) : name === "write_file" ? await this.writeDetail(input) : undefined;
      // A PermissionRequest hook answers on the user's behalf. This is the
      // extension point for "this project's test command is always fine": it
      // runs before the prompt, so an `allow` decision costs no dialog.
      let hookDecision;
      const permissionHooks = hooksFor(this.deps.hooks, "PermissionRequest", name);
      if (permissionHooks.length > 0) {
        const results = await runHooks(permissionHooks, "PermissionRequest", { tool: name, input, detail }, this.deps.cwd);
        for (const result of results) {
          if (result.permissionDecision && result.permissionDecision !== "ask") {
            hookDecision = result.permissionDecision;
            break;
          }
        }
        const context = results
          .map((result) => result.additionalContext)
          .filter(Boolean)
          .join("\n");
        if (context) this.deps.onContext?.(context);
        const blocked = results.find((result) => result.blocked);
        if (blocked) {
          ui.toolEnd(name, false, `blocked by hook: ${blocked.output.slice(0, 120)}`, { id: callId, at: new Date().toISOString() });
          return { ok: false, content: `Error: a PermissionRequest hook blocked this call: ${blocked.output}` };
        }
      }
      if (hookDecision === "deny") {
        ui.toolEnd(name, false, "denied by a PermissionRequest hook", { id: callId, at: new Date().toISOString() });
        return { ok: false, content: "Error: a PermissionRequest hook denied this call. Do not retry; adjust your approach." };
      }
      try {
        const verdict =
          hookDecision === "allow"
            ? { allowed: true }
            : await this.deps.permissions.check(tool, input, detail);
        if (!verdict.allowed) {
          ui.toolEnd(name, false, verdict.reason ?? "denied", { id: callId, at: new Date().toISOString() });
          return { ok: false, content: `Error: ${verdict.reason ?? "permission denied"}. Do not retry; adjust your approach.` };
        }
      } catch (err) {
        ui.toolEnd(name, false, (err as Error).message, { id: callId, at: new Date().toISOString() });
        return { ok: false, content: `Error: permission check failed: ${(err as Error).message}` };
      }

      const preHooks = hooksFor(this.deps.hooks, "PreToolUse", name);
      if (preHooks.length > 0) {
        const results = await runHooks(preHooks, "PreToolUse", { tool: name, input }, this.deps.cwd);
        const blocked = results.find((result) => result.blocked);
        if (blocked) {
          const reason = blocked.output || `hook exited with code ${blocked.code}`;
          ui.toolEnd(name, false, `blocked by hook: ${reason.slice(0, 120)}`, { id: callId, at: new Date().toISOString() });
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
    // The inline diff needs the before side, captured at the moment the tool
    // is about to run; after it returns the file already holds the new text.
    if (MUTATING_FILE_TOOLS.has(name) && typeof input.path === "string") {
      try {
        const abs = resolveForDiff(input.path, this.deps.cwd);
        if (abs) this.diffBaseline.set(input.path, existsSync(abs) ? readFileSync(abs, "utf8") : null);
      } catch {
        /* no inline diff for this call */
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
      ...(this.deps.subagents ? { subagents: this.deps.subagents } : {}),
    };
    let result: ToolResult;
    try {
      result = await tool.execute(input, ctx);
    } catch (err) {
      // 5. settle (failure path)
      const message = (err as Error).message ?? String(err);
      ui.toolEnd(name, false, message.slice(0, 160), { id: callId, at: new Date().toISOString() });
      ui.toolOutput?.(name, message);
      return { ok: false, content: `Error: ${message}` };
    }

    // 5. settle
    ui.toolEnd(name, !result.isError, result.display ?? "", { id: callId, at: new Date().toISOString() });
    ui.toolOutput?.(name, result.content);
    // A tool that may produce a very long result keeps the whole thing on disk
    // and names the file, so a truncated message is not a dead end.
    let content = result.content;
    if (tool.persistOutput && this.deps.sessionId) {
      content = withSpillPointer(result, this.deps.sessionId, name, result.content).content;
    }
    // The diff a file write produced, so the transcript can show it in place
    // rather than making the user open the Changes pane to see what changed.
    // The baseline was captured above, before the tool ran; reading the file
    // now gives the after side, and the pair is the same diff the pane shows.
    if (MUTATING_FILE_TOOLS.has(name) && typeof input.path === "string") {
      try {
        const hadBaseline = this.diffBaseline.has(input.path);
        const before = this.diffBaseline.get(input.path) ?? null;
        // A missing baseline means the file could not be read (permissions, a
        // directory); showing a full-file addition would be a lie.
        if (hadBaseline) {
          const abs = resolveForDiff(input.path, this.deps.cwd);
          const after = abs && existsSync(abs) ? readFileSync(abs, "utf8") : null;
          if (abs) {
            const summary = diffFile(relativeForDiff(this.deps.cwd, abs), before, after);
            if (summary.additions || summary.deletions || summary.status !== "modified") {
              ui.toolDetail?.(name, {
                change: {
                  path: summary.path,
                  status: summary.status,
                  additions: summary.additions,
                  deletions: summary.deletions,
                  hunks: summary.hunks,
                },
              });
            }
          }
        }
      } catch {
        /* an inline diff is a nicety; the Changes pane still has the change */
      } finally {
        this.diffBaseline.delete(input.path);
      }
    }
    // A structured result goes to a UI that can render it; the transcript text
    // above is still what the model reads, so this is additive and optional.
    if (result.data !== undefined) ui.toolDetail?.(name, result.data);
    if (!this.deps.trusted) {
      // A failed call has its own event: a hook that wants to suggest a fix or
      // record the failure could only guess from a successful one before.
      const postEvent = result.isError ? "PostToolUseFailure" : "PostToolUse";
      const postHooks = hooksFor(this.deps.hooks, postEvent, name);
      if (postHooks.length > 0) {
        const results = await runHooks(
          postHooks,
          postEvent,
          { tool: name, input, output: result.content, ...(result.isError ? { error: result.content } : {}) },
          this.deps.cwd,
        );
        const noise = results.map((entry) => entry.output).filter(Boolean).join("\n");
        if (noise) ui.toolOutput?.(name, noise);
        // A hook may replace an MCP tool's answer (a cache, a redaction).
        const replaced = results.find((entry) => entry.updatedMCPToolOutput !== undefined);
        if (replaced?.updatedMCPToolOutput !== undefined) content = replaced.updatedMCPToolOutput;
        const extra = results.map((entry) => entry.additionalContext).filter(Boolean).join("\n");
        if (extra) this.deps.onContext?.(extra);
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
  /**
   * The diff a `write_file` approval is about.
   *
   * `edit_file` showed its change and `write_file` only named the path, so
   * approving an overwrite of a file that already existed meant approving a
   * blank form. The content is already in the arguments; building the diff is
   * a read and a diff, nothing is written.
   */
  private async writeDetail(input: Record<string, unknown>): Promise<PermissionDetail | undefined> {
    try {
      const { resolveSafePath } = await import("../permissions.ts");
      const path = resolveSafePath(String(input.path ?? ""), this.deps.cwd, this.deps.config.allowedDirs ?? []);
      const before = existsSync(path) ? readFileSync(path, "utf8") : null;
      const after = String(input.content ?? "");
      if (before === after) return undefined;
      const summary = diffFile(path, before, after);
      return { path, before, after, additions: summary.additions, deletions: summary.deletions };
    } catch {
      return undefined;
    }
  }

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
