/**
 * The Agent: session state plus the turn lifecycle.
 *
 * The loop itself lives in query.ts as a generator; this class owns the
 * conversation, the tools, permissions, hooks, sub-agents, and the translation
 * of loop events into UI calls. Keeping that split means the loop can be
 * tested without a UI and the UI can be swapped (terminal vs desktop host).
 */

import os from "node:os";
import type { ChatMessage } from "./types.ts";
import { ChatClient, type ApiTool } from "./llm.ts";
import type { Config, TodoList, Tool, Usage, UserContentPart } from "./types.ts";
import type { TerminalUi } from "./ui.ts";
import { Permissions } from "./permissions.ts";
import { estimateTokens, summarizerInput, SUMMARIZE_PROMPT } from "./context.ts";
import { loadMemory } from "./memory.ts";
import { SUBAGENT_TOOLS, ALL_TOOLS } from "./tools/index.ts";
import { loadProjectInstructions } from "./instructions.ts";
import { loadHooks, hooksFor, runHooks, type Hook } from "./hooks.ts";
import { ToolPipeline } from "./tools/pipeline.ts";
import { query, type QueryEvent } from "./query.ts";

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
  /** Set by the host so a turn can stream to the renderer instead of a terminal. */
  onQueryEvent: ((event: QueryEvent) => void) | null = null;
  /** Called by the host so it can persist or count a compacted history. */
  onCompacted: ((info: { removed: number; before: number; after: number; summary: string }) => void) | null = null;

  /** Mutable so MCP tools can be added after startup. */
  private tools: Tool[];
  /** Hooks loaded at construction (PreToolUse can veto a tool). */
  private hooks: Hook[] = [];
  private readonly permissions: Permissions;
  private readonly isSubagent: boolean;
  private abortController: AbortController | null = null;
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

  /** Stream one assistant turn and execute any tool calls until the model stops. */
  async run(text: string): Promise<void> {
    this.pushUser(text);
    await this.loop();
  }

  private buildPipeline(): ToolPipeline {
    return new ToolPipeline(
      () => this.tools,
      {
        config: this.config,
        ui: this.ui,
        permissions: this.permissions,
        todos: this.todos,
        hooks: this.hooks,
        sessionId: this.sessionId,
        onBeforeMutate: this.onBeforeMutate,
        runSubagent: (prompt) => this.runSubagent(prompt, this.abortController?.signal ?? new AbortController().signal),
        messageIndex: () => this.messages.length,
        trusted: this.isSubagent,
        cwd: process.cwd(),
      },
    );
  }

  private async loop(): Promise<void> {
    this.abortController = new AbortController();
    const signal = this.abortController.signal;
    this.ui.spinnerStart("waiting for model");

    try {
      const events = query({
        messages: this.messages,
        config: this.config,
        client: this.client,
        pipeline: this.buildPipeline(),
        apiTools: () => toApiTools(this.tools),
        signal,
        drainQueue: () => this.queued.splice(0),
        summarize: (old, local) => this.summarizeWithModel(old, local, signal),
        maxRetries: 3,
      });

      for await (const event of events) {
        this.onQueryEvent?.(event);
        this.dispatch(event);
      }
    } finally {
      this.ui.spinnerStop();
      this.ui.assistantEnd();
      this.ui.thinkingEnd();
      this.abortController = null;
    }
  }

  /**
   * One non-streaming request for a compaction recap. It reuses the session's
   * client (same provider, key, and model) and never touches the transcript.
   */
  private async summarizeWithModel(old: ChatMessage[], localSummary: string, signal: AbortSignal): Promise<string> {
    if (this.isSubagent) return localSummary;
    const input = summarizerInput(old);
    if (!input.trim()) return localSummary;
    const request = this.client.chat(
      [
        { role: "system", content: SUMMARIZE_PROMPT },
        { role: "user", content: `Transcript to summarize:\n\n${input}` },
      ],
      [],
      () => {},
      () => {},
      signal,
    );
    // A slow summarizer must not stall the turn indefinitely.
    const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 45_000));
    const result = await Promise.race([request, timeout]);
    if (!result) return localSummary;
    return result.content.trim() || localSummary;
  }

  /** Translate a loop event into the terminal UI calls. */
  private dispatch(event: QueryEvent): void {
    const ui = this.ui;
    switch (event.type) {
      case "assistant_start":
        ui.spinnerStop();
        break;
      case "assistant_text":
        ui.assistantText(event.text);
        break;
      case "thinking":
        ui.spinnerStop();
        ui.thinking(event.text);
        break;
      case "retry":
        ui.spinnerStop();
        ui.warn(`${event.message} - retrying in ${event.delayMs / 1000}s (attempt ${event.attempt + 1})`);
        break;
      case "compacted":
        ui.dim(`compacted (${event.level}) ${event.removed} earlier messages (~${event.before} -> ~${event.after} tokens)`);
        this.onCompacted?.({ removed: event.removed, before: event.before, after: event.after, summary: event.summary });
        break;
      case "queued_delivered":
        // The query loop already appended the user turns; echo them here.
        for (const text of event.texts) ui.echoUser?.(text);
        break;
      case "warning":
        ui.warn(event.text);
        break;
      case "error":
        if (event.error.cause instanceof Error && (event.error.cause as Error).name !== "AbortError") {
          ui.error(event.error.message);
        }
        break;
      case "usage":
        this.usage = event.usage;
        break;
      default:
        break;
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

  contextUsage(): { tokens: number; percent: number } {
    const tokens = estimateTokens(this.messages);
    return { tokens, percent: Math.min(100, Math.round((tokens / this.config.contextWindow) * 100)) };
  }
}
