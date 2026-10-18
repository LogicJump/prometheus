/** The agent loop: streaming response, tool execution, permissions, compaction, sub-agents. */

import os from "node:os";
import type { ChatMessage } from "./llm.ts";
import { ChatClient, ApiError, type ApiTool } from "./llm.ts";
import type { Config, TodoList, Tool, ToolContext, Usage, UserContentPart } from "./types.ts";
import type { TerminalUi } from "./ui.ts";
import { Permissions } from "./permissions.ts";
import { compact, estimateTokens } from "./context.ts";
import { loadMemory } from "./memory.ts";
import { SUBAGENT_TOOLS, ALL_TOOLS } from "./tools/index.ts";
import { loadProjectInstructions } from "./instructions.ts";
import { captureBefore } from "./checkpoints.ts";
import { loadHooks, hooksFor, runHooks, type Hook } from "./hooks.ts";

const MAX_RETRIES = 3;

function toApiTools(tools: Tool[]): ApiTool[] {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

export class Agent {
  messages: ChatMessage[];
  readonly config: Config;
  /** Not readonly: a sub-agent gets a proxy that folds its tool activity into the parent's view. */
  ui: TerminalUi;
  readonly client: ChatClient;
  readonly todos: TodoList = { items: [] };
  usage: Usage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
  /** Set by the host so file mutations can be checkpointed per session. */
  sessionId = "";
  /** Called before a mutating tool runs; used to snapshot file state for diffs. */
  onBeforeMutate: ((toolName: string, input: Record<string, unknown>) => void) | null = null;
  /** Mutable so MCP tools can be added after startup. */
  private tools: Tool[];
  /** Hooks loaded at construction (PreToolUse can veto a tool). */
  private hooks: Hook[] = [];
  private readonly permissions: Permissions;
  private readonly isSubagent: boolean;
  private abortController: AbortController | null = null;
  private lastCompaction = "";
  private readonly queued: string[] = [];

  constructor(
    config: Config,
    ui: TerminalUi,
    client: ChatClient,
    tools: Tool[] = ALL_TOOLS,
    permissions: Permissions = new Permissions(config, ui),
    messages: ChatMessage[] = [],
    isSubagent = false,
  ) {
    this.config = config;
    this.ui = ui;
    this.client = client;
    this.tools = tools;
    this.permissions = permissions;
    this.isSubagent = isSubagent;
    this.messages = messages;
    if (messages.length === 0) {
      this.messages.push({ role: "system", content: this.systemPrompt() });
    }
    this.ui.setModelName?.(config.model);
    if (!isSubagent) this.hooks = loadHooks(process.cwd());
  }

  /** Replace the system prompt (mode or model changed mid-session). */
  refreshSystemPrompt(): void {
    if (this.messages[0]?.role === "system") {
      this.messages[0] = { role: "system", content: this.systemPrompt() };
    }
  }

  get busy(): boolean {
    return this.abortController !== null;
  }

  abort(): void {
    this.abortController?.abort();
  }

  private systemPrompt(): string {
    const memory = loadMemory();
    const instructions = loadProjectInstructions();
    const mode = this.config.permissionMode;
    const modeNote =
      mode === "plan"
        ? "You are in PLAN mode: only read-only tools are available. Investigate, then propose a concrete plan. Do not attempt writes."
        : mode === "auto"
          ? "You are in AUTO mode: most tools run without asking. Stay conservative with destructive commands."
          : "You are in ASK mode: mutating tools require user confirmation. Explain what you are about to do in one short line first.";

    return `You are Prometheus, a general-purpose software engineering agent running in a terminal.

# Environment
- Workspace: ${process.cwd()}
- Platform: ${process.platform} (${os.release()})
- Shell: ${process.platform === "win32" ? "cmd.exe via Git Bash-compatible invocations" : "/bin/sh"}
- Model: ${this.config.model}
- ${modeNote}

# How to work
- Read before you write. Never guess file contents; inspect them.
- Make the smallest change that solves the problem. Do not refactor code you were not asked to touch.
- Match the surrounding code's style, naming, and comment density.
- Verify your work: run the project's build, tests, or type checker when they exist.
- When a task has three or more steps, use todo_write to track the plan and keep exactly one item in progress.
- Work autonomously until the request is satisfied. Do not stop to ask permission for routine steps.
- If a tool call fails, read the error and adapt; do not repeat the same failing call.
- Keep responses short. The user sees tool activity directly, so do not narrate what you are about to do at length.
- Report outcomes faithfully. If a test fails, say so with the output.

# Tools
Prefer dedicated file tools over bash for reading and editing. Use bash for builds, tests, git, and package managers. Never run interactive commands. Paths are relative to the workspace root unless absolute.

# Memory
Use the remember tool for durable facts about the user or project. Do not save transient task state.
${memory ? `\n# Existing memory\n${memory}` : ""}
${instructions ? `\n# Project instructions (follow these)\n${instructions}` : ""}`;
  }

  /** Fire the session-lifecycle hooks; callers do not await the Stop hook. */
  async fireSessionHooks(event: "SessionStart" | "Stop", extra: Record<string, unknown> = {}): Promise<void> {
    const hooks = hooksFor(this.hooks, event);
    if (hooks.length === 0) return;
    const results = await runHooks(hooks, event, extra, process.cwd());
    const noise = results.map((result) => result.output).filter(Boolean).join("\n");
    if (noise) this.ui.dim(`[${event}] ${noise}`);
  }

  /** Add tools at runtime (MCP servers connect after the first turn may start). */
  addTools(extra: Tool[]): void {
    const known = new Set(this.tools.map((tool) => tool.name));
    for (const tool of extra) if (!known.has(tool.name)) this.tools.push(tool);
  }

  /** Add a user message without running the loop (used when restoring sessions). */
  pushUser(text: string): void {
    this.messages.push({ role: "user", content: text });
  }

  /** Queue a user turn that may carry images; `text` is the prompt. */
  async runWithParts(text: string, parts: UserContentPart[]): Promise<void> {
    this.messages.push({ role: "user", content: [{ type: "text", text }, ...parts] });
    await this.loop();
  }

  /**
   * Queue text typed while a turn is already running. It is appended at the
   * next tool boundary, so the model sees it before its next request instead
   * of it being dropped or forcing the user to abort.
   */
  enqueue(text: string): void {
    this.queued.push(text);
  }

  /** Drop queued messages (a fresh session started, or the user hit stop). */
  clearQueue(): number {
    const count = this.queued.length;
    this.queued.length = 0;
    return count;
  }

  get queuedCount(): number {
    return this.queued.length;
  }

  /** Move queued messages into the conversation; returns how many were taken. */
  private drainQueue(): number {
    if (this.queued.length === 0) return 0;
    const taken = this.queued.splice(0);
    for (const text of taken) {
      this.messages.push({ role: "user", content: text });
      this.ui.echoUser?.(text);
    }
    return taken.length;
  }

  /** Stream one assistant turn and execute any tool calls until the model stops. */
  async run(text: string): Promise<void> {
    this.pushUser(text);
    await this.loop();
  }

  private async loop(): Promise<void> {
    this.abortController = new AbortController();
    const signal = this.abortController.signal;
    const apiTools = toApiTools(this.tools);
    let turns = 0;

    try {
      while (turns++ < this.config.maxTurns) {
        if (signal.aborted) break;

        this.maybeCompact();
        this.ui.spinnerStart("waiting for model");

        let result;
        for (let attempt = 1; ; attempt++) {
          try {
            result = await this.client.chat(
              this.messages,
              apiTools,
              (delta) => {
                this.ui.spinnerStop();
                this.ui.assistantText(delta);
              },
              (delta) => {
                this.ui.spinnerStop();
                this.ui.thinking(delta);
              },
              signal,
            );
            break;
          } catch (err) {
            this.ui.spinnerStop();
            if (signal.aborted) return;
            if (err instanceof ApiError && err.retryable && attempt < MAX_RETRIES) {
              const delay = 800 * 2 ** (attempt - 1);
              this.ui.warn(`${err.message} - retrying in ${delay / 1000}s (${attempt}/${MAX_RETRIES - 1})`);
              await sleep(delay, signal);
              continue;
            }
            throw err;
          }
        }

        this.ui.spinnerStop();
        this.ui.assistantEnd();
        this.ui.thinkingEnd();
        this.usage.inputTokens += result.usage.inputTokens;
        this.usage.outputTokens += result.usage.outputTokens;
        this.usage.cachedTokens += result.usage.cachedTokens;

        const assistant: ChatMessage = {
          role: "assistant",
          content: result.content || null,
          ...(result.toolCalls.length ? { tool_calls: result.toolCalls } : {}),
        };
        this.messages.push(assistant);

        if (result.toolCalls.length === 0) {
          if (result.finishReason === "length") {
            this.ui.warn("Response hit the max_tokens limit. Ask for a smaller step or raise maxTokens.");
          }
          return;
        }

        for (const call of result.toolCalls) {
          if (signal.aborted) break;
          const output = await this.executeTool(call.function.name, call.function.arguments, signal);
          this.messages.push({ role: "tool", tool_call_id: call.id, content: output.content });
        }
        if (signal.aborted) return;
        // Text the user typed mid-turn joins the conversation before the model
        // asks for its next step.
        this.drainQueue();
      }
      if (!this.isSubagent) this.ui.warn(`Stopped after ${this.config.maxTurns} turns. Send another message to continue.`);
    } finally {
      this.ui.spinnerStop();
      this.ui.assistantEnd();
      this.abortController = null;
    }
  }

  private async executeTool(name: string, rawArgs: string, signal: AbortSignal): Promise<{ content: string }> {
    const tool = this.tools.find((t) => t.name === name);
    if (!tool) {
      this.ui.error(`Unknown tool: ${name}`);
      return { content: `Error: unknown tool "${name}". Available tools: ${this.tools.map((t) => t.name).join(", ")}` };
    }

    let input: Record<string, unknown>;
    try {
      input = rawArgs.trim() ? (JSON.parse(rawArgs) as Record<string, unknown>) : {};
    } catch (err) {
      this.ui.error(`Invalid JSON for ${name}`);
      return {
        content: `Error: arguments were not valid JSON (${(err as Error).message}). Re-issue the call with valid JSON.`,
      };
    }

    const summary = safeSummarize(tool, input);
    this.ui.toolStart(name, summary);

    let allowed = true;
    if (!this.isSubagent) {
      try {
        const verdict = await this.permissions.check(tool, input);
        if (!verdict.allowed) {
          this.ui.toolEnd(name, false, verdict.reason ?? "denied");
          return { content: `Error: ${verdict.reason ?? "permission denied"}. Do not retry; adjust your approach.` };
        }
      } catch (err) {
        allowed = false;
        this.ui.toolEnd(name, false, (err as Error).message);
        return { content: `Error: permission check failed: ${(err as Error).message}` };
      }
    }
    void allowed;

    // Snapshot mutating file tools before they run so the session can be rewound.
    if (this.sessionId && (name === "write_file" || name === "edit_file") && typeof input.path === "string") {
      try {
        captureBefore(this.sessionId, name, process.cwd(), input.path);
      } catch {
        /* checkpointing must never block a tool */
      }
    }
    try {
      this.onBeforeMutate?.(name, input);
    } catch {
      /* diff snapshots must never block a tool */
    }

    // User hooks run before the permission check so a guard script can veto a
    // tool even in auto mode.
    const preHooks = hooksFor(this.hooks, "PreToolUse", name);
    if (preHooks.length > 0) {
      const results = await runHooks(preHooks, "PreToolUse", { tool: name, input }, process.cwd());
      const blocked = results.find((result) => result.blocked);
      if (blocked) {
        const reason = blocked.output || `hook exited with code ${blocked.code}`;
        this.ui.toolEnd(name, false, `blocked by hook: ${reason.slice(0, 120)}`);
        return { content: `Error: a PreToolUse hook blocked this call: ${reason}` };
      }
      const noise = results.map((result) => result.output).filter(Boolean).join("\n");
      if (noise) this.ui.toolOutput?.(name, noise);
    }

    const ctx: ToolContext = {
      cwd: process.cwd(),
      signal,
      config: this.config,
      permissions: this.permissions,
      ui: this.ui,
      todo: this.todos,
      runSubagent: (prompt) => this.runSubagent(prompt, signal),
    };

    try {
      const result = await tool.execute(input, ctx);
      this.ui.toolEnd(name, !result.isError, result.display ?? "");
      this.ui.toolOutput?.(name, result.content);
      const postHooks = hooksFor(this.hooks, "PostToolUse", name);
      if (postHooks.length > 0) {
        const results = await runHooks(postHooks, "PostToolUse", { tool: name, input, output: result.content }, process.cwd());
        const noise = results.map((entry) => entry.output).filter(Boolean).join("\n");
        if (noise) this.ui.toolOutput?.(name, noise);
      }
      return { content: result.isError ? `Error: ${result.content}` : result.content };
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      this.ui.toolEnd(name, false, message.slice(0, 160));
      this.ui.toolOutput?.(name, message);
      return { content: `Error: ${message}` };
    }
  }

  private async runSubagent(prompt: string, signal: AbortSignal): Promise<string> {
    if (this.isSubagent) throw new Error("sub-agents cannot spawn sub-agents");
    this.ui.info("  ↳ sub-agent started");
    this.ui.subagentStart?.(prompt);
    const child = new Agent(
      { ...this.config, maxTurns: Math.min(25, this.config.maxTurns) },
      this.ui,
      this.client,
      SUBAGENT_TOOLS,
      new Permissions({ ...this.config, permissionMode: this.config.permissionMode === "plan" ? "plan" : "auto" }, this.ui),
      [],
      true,
    );
    // Surface the child's tool activity in the parent transcript's sub-agent group.
    const parentUi = this.ui;
    child.ui = new Proxy(parentUi, {
      get(target, property, receiver) {
        if (property === "toolStart") {
          return (name: string, summary: string) => parentUi.subagentActivity?.("tool", `${name} ${summary}`);
        }
        return Reflect.get(target, property, receiver);
      },
    }) as TerminalUi;
    child.abortController = new AbortController();
    // Propagate parent cancellation to the child.
    const onAbort = () => child.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      await child.run(prompt);
      const text = [...child.messages].reverse().find((m) => m.role === "assistant" && m.content);
      this.usage.inputTokens += child.usage.inputTokens;
      this.usage.outputTokens += child.usage.outputTokens;
      this.ui.info("  ↳ sub-agent finished");
      const report = typeof text?.content === "string" ? text.content : "(sub-agent produced no text report)";
      this.ui.subagentEnd?.(true, report.slice(0, 160));
      return report;
    } catch (err) {
      this.ui.subagentEnd?.(false, (err as Error).message);
      throw err;
    } finally {
      signal.removeEventListener("abort", onAbort);
      child.abortController = null;
    }
  }

  private maybeCompact(): void {
    const before = estimateTokens(this.messages);
    const result = compact(this.messages, this.config.contextWindow);
    if (!result) return;
    this.messages = result.messages;
    this.lastCompaction = result.summary;
    this.ui.dim(`compacted ${result.removed} earlier messages (~${before} tokens) to stay within the context window`);
  }

  contextUsage(): { tokens: number; percent: number } {
    const tokens = estimateTokens(this.messages);
    return { tokens, percent: Math.min(100, Math.round((tokens / this.config.contextWindow) * 100)) };
  }
}

function safeSummarize(tool: Tool, input: Record<string, unknown>): string {
  try {
    return tool.summarize(input) ?? "";
  } catch {
    return "";
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}
