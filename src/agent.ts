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
import type { FallbackChatClient } from "./fallback.ts";
import type { Config, TodoList, Tool, Usage, UsageBreakdown, UserContentPart } from "./types.ts";
import type { TerminalUi } from "./ui.ts";
import { Permissions } from "./permissions.ts";
import { compactWithModel, estimateTextTokens, estimateTokens, summarizerInput, SUMMARIZE_PROMPT, type CompactionLevel } from "./context.ts";
import { loadMemory } from "./memory.ts";
import { SUBAGENT_TOOLS, ALL_TOOLS } from "./tools/index.ts";
import { loadProjectInstructions, loadRules, renderRules } from "./instructions.ts";
import { loadHooks, hooksFor, runHooks, applyPromptHooks, type Hook } from "./hooks.ts";
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

/**
 * What the tool schemas cost, in tokens.
 *
 * They are part of every request but are not messages, so the meter ignored
 * them: with a few MCP servers attached, 40 tool definitions are ~15k tokens
 * that were missing from the percentage and from the compaction decision.
 */
function toolSchemaTokens(tools: Tool[]): number {
  let total = 0;
  for (const tool of tools) {
    total += estimateTextTokens(tool.name) + estimateTextTokens(tool.description);
    try {
      total += estimateTextTokens(JSON.stringify(tool.parameters));
    } catch {
      /* a schema that cannot be serialised is not counted; the request would fail anyway */
    }
  }
  return total;
}

export class Agent {
  messages: ChatMessage[];
  readonly config: Config;
  /** Not readonly: a sub-agent gets a proxy that folds its tool activity into the parent's view. */
  ui: TerminalUi;
  /**
   * The primary client. A `FallbackChatClient` has the same chat shape, so the
   * loop and the summarizer use it without knowing whether a fallback exists.
   */
  readonly client: ChatClient | FallbackChatClient;
  readonly todos: TodoList = { items: [] };
  usage: Usage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
  /** The usage balance at the moment the current run started. */
  private usageBase: Usage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
  /**
   * Tokens spent by sub-agents during this run. A usage event carries only the
   * main loop's own count, so the children's share is tracked separately and
   * added back when the event overwrites `usage` with the base plus this run.
   */
  private subagentUsage: Usage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
  /**
   * The same total, split by who spent it.
   *
   * `usage` answers "what did this session cost"; this answers "what did
   * delegation cost", which is the only way to tell whether a sub-agent was
   * worth using. Background sub-tasks are counted apart from foreground ones
   * because they are the ones that outlive a turn and surprise a user.
   */
  readonly usageBySource: UsageBreakdown = {
    main: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
    subagent: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
    background: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
  };
  /** The model that produced the latest usage, as the client reports it. */
  lastUsedModel = "";
  private subagentKind: "subagent" | "background" = "subagent";
  /** Set by the host so file mutations can be checkpointed per session. */
  sessionId = "";
  /** Balance carried into this run, and the loop's cumulative for this run. */
  private reportedUsage: Usage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
  /** Called before a mutating tool runs; used to snapshot file state for diffs. */
  onBeforeMutate: ((toolName: string, input: Record<string, unknown>) => void) | null = null;
  /** Set by the host so a turn can stream to the renderer instead of a terminal. */
  onQueryEvent: ((event: QueryEvent) => void) | null = null;
  /** Called when a background sub-task finishes, with its report. */
  onBackgroundReport: ((prompt: string, report: string, ok: boolean) => void) | null = null;
  /** Called by the host so it can persist or count a compacted history. */
  onCompacted:
    | ((info: { removed: number; before: number; after: number; summary: string; level: string; kept: number }) => void)
    | null = null;

  /** Mutable so MCP tools can be added after startup. */
  private tools: Tool[];
  /**
   * Names of deferred tools the model has unlocked with `tool_search`.
   *
   * Deferred schemas are the largest fixed cost in a request, and a session
   * that never touches MCP should not pay for forty tool descriptions.
   */
  private readonly unlocked = new Set<string>();
  /** Workspace-relative paths the conversation has read or written, for scoped rules. */
  private readonly touched = new Set<string>();
  /** Background sub-tasks still running; capped so a loop cannot spawn hundreds. */
  private readonly background = new Set<Promise<void>>();
  /** Hooks loaded at construction (PreToolUse can veto a tool). */
  private hooks: Hook[] = [];
  private readonly permissions: Permissions;
  private readonly isSubagent: boolean;
  private abortController: AbortController | null = null;
  private readonly queued: string[] = [];

  constructor(
    config: Config,
    ui: TerminalUi,
    client: ChatClient | FallbackChatClient,
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
    // The system prompt is rendered per request, not stored in the
    // transcript. A resumed or forked session loads messages from disk with no
    // system message, and a mode or rule change must apply to the next
    // request without rewriting history. A system message left in a restored
    // transcript (an older version wrote one) is dropped here so the request
    // carries exactly one.
    this.messages = messages.filter((message) => message.role !== "system");
    this.ui.setModelName?.(config.model);
    if (!isSubagent) this.hooks = loadHooks(process.cwd());
    // The search tool is how a deferred schema becomes callable. It lives here
    // rather than in ALL_TOOLS because it needs this agent's own catalogue;
    // `syncSearchTool` adds or removes it so a session with no MCP server is
    // not paying for a schema it cannot use.
    this.syncSearchTool();
  }

  /**
   * Keep `tool_search` present exactly when something is deferred. Called
   * after the tool set changes, so a session that adds MCP tools later grows
   * the search tool with them.
   */
  private syncSearchTool(): void {
    const index = this.tools.findIndex((tool) => tool.name === "tool_search");
    const wanted = this.tools.some((tool) => tool.deferred);
    if (wanted) {
      if (index >= 0) return;
      this.tools.push(this.searchTool());
      return;
    }
    if (index >= 0) this.tools.splice(index, 1);
  }

  /** The `tool_search` definition, built once per call rather than stored. */
  private searchTool(): Tool {
    return {
      name: "tool_search",
      description:
        "Find and enable a tool that is not currently listed. Deferred tools (MCP servers, embedded tooling) are announced here instead of in every request; searching by name or description returns their schemas and makes them callable.",
      readonly: true,
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Text to match against tool names and descriptions; empty lists everything deferred" },
        },
        required: [],
        additionalProperties: false,
      },
      summarize: (input) => String(input.query ?? "").slice(0, 80),
      execute: async (input) => {
        const matches = this.unlockTools(String(input.query ?? ""));
        if (matches.length === 0) {
          const remaining = this.deferredCatalogue();
          return {
            content: remaining.length === 0
              ? "No deferred tools remain; everything is already available."
              : `No match. Still deferred:\n${remaining.map((tool) => `- ${tool.name}: ${tool.description.split("\n")[0]}`).join("\n")}`,
          };
        }
        return {
          content:
            `Enabled ${matches.length} tool(s); they are callable from the next turn.\n` +
            matches.map((tool) => `- ${tool.name}: ${tool.description.split("\n")[0]}`).join("\n"),
        };
      },
    };
  }

  /** A one-off note appended to the system prompt after a mid-session change. */
  private systemNote = "";

  /**
   * The system prompt for the next request, including any note left by
   * `refreshSystemPrompt`. Rebuilt on every request so a mode change, a newly
   * touched rule, or a board selection is never a turn behind.
   */
  private requestSystemPrompt(): string {
    const base = this.systemPrompt();
    return this.systemNote ? `${base}\n\n# Update\n${this.systemNote}` : base;
  }

  /**
   * Replace the system prompt (mode, model, rules, or output style changed
   * mid-session). An optional note is appended once, so a mid-session change
   * is visible to the model instead of silently rewriting its instructions.
   */
  refreshSystemPrompt(note?: string): void {
    if (note !== undefined) this.systemNote = note;
  }

  /** Response style chosen in Settings; folded into the system prompt. */
  outputStyle: "default" | "concise" | "explanatory" = "default";

  get busy(): boolean {
    return this.abortController !== null;
  }

  abort(): void {
    this.abortController?.abort();
  }

  private systemPrompt(): string {
    const memory = loadMemory();
    const instructions = loadProjectInstructions();
    const rules = renderRules(loadRules(), [...this.touched]);
    const mode = this.config.permissionMode;
    const modeNote =
      mode === "plan"
        ? "You are in PLAN mode: only read-only tools are available. Investigate, then propose a concrete plan. Do not attempt writes."
        : mode === "auto"
          ? "You are in AUTO mode: most tools run without asking. Stay conservative with destructive commands."
          : "You are in ASK mode: mutating tools require user confirmation. Explain what you are about to do in one short line first.";

    const styleNote =
      this.outputStyle === "concise"
        ? "- Reply in the fewest words that still answer. Prefer a sentence over a paragraph; skip preamble and recaps."
        : this.outputStyle === "explanatory"
          ? "- Explain the reasoning behind non-obvious changes in a short paragraph, naming the tradeoff you chose."
          : "";

    // The board the user picked, described in whatever terms they set. Nothing
    // here assumes a vendor or a part: a selection may name only a port, only a
    // target, or both, and the sentence is built from whatever is present.
    const board = this.config.board ?? {};
    const boardParts = [
      board.target ? `target ${board.target}` : "",
      board.port ? `port ${board.port}${board.baud ? ` at ${board.baud} baud` : ""}` : "",
      board.flasher ? `flasher ${board.flasher}` : "",
    ].filter(Boolean);
    const boardNote = boardParts.length
      ? `\n- Board selected in the Board pane: ${boardParts.join(", ")}. embed_flash, embed_serial and embed_debug use it when you omit the matching argument; an explicit argument still wins.`
      : "";

    return `You are Prometheus, a general-purpose software engineering agent running in a terminal.

# Environment
- Workspace: ${process.cwd()}
- Platform: ${process.platform} (${os.release()})
- Shell: ${process.platform === "win32" ? "cmd.exe via Git Bash-compatible invocations" : "/bin/sh"}
- Model: ${this.config.model}
- ${modeNote}
${boardNote}

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
${styleNote}

# Tools
Prefer dedicated file tools over bash for reading and editing. Use bash for builds, tests, git, and package managers. Never run interactive commands. Paths are relative to the workspace root unless absolute.

# Embedded work
When the workspace is firmware, prefer the embed_* tools over bash. They return structured results — parsed diagnostics with file and line, artifact paths, flash/RAM usage, verified flash status, parsed log lines — which a shell command's output does not. The loop is: embed_build, read the diagnostics, fix, embed_build again, then embed_flash, then embed_serial to see whether the board came up. Do not claim a flash worked unless the tool reported it did; several flashers exit zero after a failed verify. When a target name is unknown, call embed_targets before guessing — flashing the wrong part bricks boards.

# Memory
Use the remember tool for durable facts about the user or project. Do not save transient task state.
${memory ? `\n# Existing memory\n${memory}` : ""}
${instructions ? `\n# Project instructions (follow these)\n${instructions}` : ""}`;
  }

  /** SubagentStart/Stop are advisory: a failing hook must not kill the task. */
  private async fireSubagentHooks(event: "SubagentStart" | "SubagentStop", prompt: string, report = ""): Promise<void> {
    const hooks = hooksFor(this.hooks, event);
    if (hooks.length === 0) return;
    try {
      const results = await runHooks(hooks, event, { prompt, report }, process.cwd());
      const noise = results.map((result) => result.output).filter(Boolean).join("\n");
      if (noise) this.ui.dim(`[${event}] ${noise}`);
    } catch {
      /* lifecycle hooks are advisory */
    }
  }

  /** Fire the session-lifecycle hooks; callers do not await the Stop hook. */
  async fireSessionHooks(
    event: "SessionStart" | "Stop" | "PreCompact" | "PostCompact",
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    const hooks = hooksFor(this.hooks, event);
    if (hooks.length === 0) return;
    const results = await runHooks(hooks, event, extra, process.cwd());
    const noise = results.map((result) => result.output).filter(Boolean).join("\n");
    if (noise) this.ui.dim(`[${event}] ${noise}`);
  }

  /**
   * Remember a path the conversation touched. A path that activates a new
   * scoped rule rebuilds the system prompt immediately, so the rule is in
   * effect for the very next request rather than the next turn.
   */
  noteTouched(path: unknown): void {
    if (typeof path !== "string" || !path.trim()) return;
    if (this.touched.size > 200) return;
    const before = renderRules(loadRules(), [...this.touched]);
    this.touched.add(path);
    const after = renderRules(loadRules(), [...this.touched]);
    if (after !== before) this.refreshSystemPrompt();
  }

  /** Add tools at runtime (MCP servers connect after the first turn may start). */
  addTools(extra: Tool[]): void {
    const known = new Set(this.tools.map((tool) => tool.name));
    for (const tool of extra) if (!known.has(tool.name)) this.tools.push(tool);
    this.syncSearchTool();
  }

  /** Tools whose schemas go into the next request: undeferred, plus unlocked. */
  private visibleTools(): Tool[] {
    return this.tools.filter((tool) => !tool.deferred || this.unlocked.has(tool.name));
  }

  /**
   * `visibleTools` for tests. The real one is private because a caller that
   * bypassed the filter would leak a deferred schema back into the request.
   */
  testVisibleTools(): Tool[] {
    return this.visibleTools();
  }

  /**
   * Unlock a deferred tool by name and return its schema.
   *
   * `tool_search` is the only way a deferred tool becomes callable; the search
   * itself matches names and descriptions so a model that knows what it wants
   * does not have to read a catalogue of forty.
   */
  unlockTools(query: string, limit = 8): { name: string; description: string }[] {
    const needle = query.trim().toLowerCase();
    const matches = this.tools.filter((tool) => {
      if (!tool.deferred) return false;
      if (!needle) return true;
      return (
        tool.name.toLowerCase().includes(needle) ||
        tool.description.toLowerCase().includes(needle)
      );
    });
    const chosen = matches.slice(0, limit);
    for (const tool of chosen) this.unlocked.add(tool.name);
    return chosen.map((tool) => ({ name: tool.name, description: tool.description }));
  }

  /** Deferred tools not yet unlocked, for the search tool's own description. */
  deferredCatalogue(): { name: string; description: string }[] {
    return this.tools
      .filter((tool) => tool.deferred && !this.unlocked.has(tool.name))
      .map((tool) => ({ name: tool.name, description: tool.description }));
  }

  /**
   * Replace every tool whose name starts with `prefix`, keeping the rest.
   *
   * `addTools` only ever grows the list, so a server that dropped a tool — or
   * was disabled in Settings — kept its old tools alive until the next session.
   * Replacing a prefix is what makes an MCP `list_changed` refresh honest.
   */
  replaceToolsByPrefix(prefix: string, replacement: Tool[]): void {
    const kept = this.tools.filter((tool) => !tool.name.startsWith(prefix));
    const seen = new Set(kept.map((tool) => tool.name));
    for (const tool of replacement) if (!seen.has(tool.name)) kept.push(tool);
    this.tools.length = 0;
    this.tools.push(...kept);
    this.syncSearchTool();
  }

  /**
   * Re-read the hook files. The project's hooks only load once the user has
   * trusted the checkout, so a decision made in Settings during a session must
   * take effect without a restart.
   */
  refreshHooks(): void {
    if (this.isSubagent) return;
    this.hooks = loadHooks(process.cwd());
  }

  /** Add a user message without running the loop (used when restoring sessions). */
  pushUser(text: string): void {
    this.messages.push({ role: "user", content: text });
  }

  /** Queue a user turn that may carry images; `text` is the prompt. */
  async runWithParts(text: string, parts: UserContentPart[]): Promise<void> {
    const prompt = await this.applyPromptHooks(text);
    if (prompt === null) return;
    this.messages.push({ role: "user", content: [{ type: "text", text: prompt }, ...parts] });
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
    const prompt = await this.applyPromptHooks(text);
    if (prompt === null) return;
    this.pushUser(prompt);
    await this.loop();
  }

  /**
   * UserPromptSubmit hooks run before the message reaches the model. They can
   * rewrite it (stdout `{"prompt": ...}`) or veto the turn (non-zero exit), so
   * a project can enforce a template or refuse an off-limits request without
   * relying on the model to comply.
   */
  private async applyPromptHooks(text: string): Promise<string | null> {
    if (this.isSubagent) return text;
    const result = await applyPromptHooks(this.hooks, text, process.cwd());
    if (result.blocked) {
      this.ui.warn(`the prompt was blocked by a UserPromptSubmit hook: ${result.output.slice(0, 300)}`);
      return null;
    }
    if (result.output) this.ui.dim(`[UserPromptSubmit] ${result.output}`);
    return result.text;
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
        runSubagents: (prompts) => this.runSubagents(prompts, this.abortController?.signal ?? new AbortController().signal),
        runSubagentInBackground: (prompt) => this.startBackgroundSubagent(prompt),
        messageIndex: () => this.messages.length,
        onTouch: (path) => this.noteTouched(path),
        // A sub-agent is not a grant. Its permission layer runs the same checks
        // as the parent's, so approving `delegate` does not silently approve
        // every write the child makes inside that task.
        trusted: false,
        cwd: process.cwd(),
      },
    );
  }

  private async loop(): Promise<void> {
    this.abortController = new AbortController();
    const signal = this.abortController.signal;
    // Tokens already spent before this run. `query()` counts from zero each
    // run, so the balance is carried across, not reset.
    this.usageBase = { ...this.usage };
    this.subagentUsage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
    this.reportedUsage.inputTokens = 0;
    this.reportedUsage.outputTokens = 0;
    this.reportedUsage.cachedTokens = 0;
    if (this.config.contextWindowAssumed && !this.isSubagent && !this.warnedAssumedWindow) {
      // A guessed window that is too large means the first sign of trouble is
      // an endpoint 400 partway through a long task. One line at the start is
      // cheaper than debugging that. Silent when the value was configured.
      this.warnedAssumedWindow = true;
      this.ui.dim(
        `context window not reported by the endpoint; assuming ${this.config.contextWindow.toLocaleString()} tokens. ` +
          `Set "contextWindow" in ~/.prometheus/config.json or PROMETHEUS_CONTEXT_WINDOW if this is wrong.`,
      );
    }
    this.ui.spinnerStart("waiting for model");

    try {
      const events = query({
        messages: this.messages,
        system: () => this.requestSystemPrompt(),
        config: this.config,
        client: this.client,
        pipeline: this.buildPipeline(),
        apiTools: () => toApiTools(this.visibleTools()),
        signal,
        drainQueue: () => this.queued.splice(0),
        summarize: (old, local, focus) => this.summarizeWithModel(old, local, signal, focus),
        rehydrate: () => this.rehydration(),
        maxRetries: 3,
        beforeCompact: (info) => this.beforeCompact(info),
        afterCompact: (info) => {
          void this.fireSessionHooks("PostCompact", {
            removed: info.removed,
            after: info.after,
            summary: info.summary.slice(0, 2000),
          });
        },
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

  private warnedAssumedWindow = false;

  /**
   * Compact on demand (`/compact` and the desktop's compact button).
   *
   * This used to call the local `compactForce`, which summarised with keyword
   * matching instead of the model — so the one command a user issues for a
   * *better* recap produced the worst one. It now shares the model-backed path
   * with automatic compaction, accepts a focus, and fires the same hooks.
   */
  async compactNow(options: { focus?: string } = {}): Promise<{
    removed: number;
    before: number;
    after: number;
    summary: string;
    level: CompactionLevel;
  } | null> {
    if (this.busy) throw new Error("stop the current turn before compacting");
    const before = estimateTokens(this.messages);
    const verdict = await this.beforeCompact({ before, trigger: "auto" });
    if (verdict.blocked) throw new Error(`compaction was blocked by a PreCompact hook${verdict.reason ? `: ${verdict.reason}` : ""}`);
    const signal = new AbortController().signal;
    const result = await compactWithModel(this.messages, this.config.contextWindow, {
      summarize: (old, local, focus) => this.summarizeWithModel(old, local, signal, focus),
      signal,
      rehydrate: () => this.rehydration(),
      ...(options.focus ? { focus: options.focus } : {}),
      force: true,
    });
    if (!result) return null;
    this.messages.splice(0, this.messages.length, ...result.messages);
    void this.fireSessionHooks("PostCompact", {
      removed: result.removed,
      after: result.after,
      summary: result.summary.slice(0, 2000),
    });
    this.onCompacted?.({
      removed: result.removed,
      before: result.before,
      after: result.after,
      summary: result.summary,
      level: result.level,
      kept: result.messages.length,
    });
    return {
      removed: result.removed,
      before: result.before,
      after: result.after,
      summary: result.summary,
      level: result.level,
    };
  }

  /**
   * Ask the PreCompact hooks whether compaction may run.
   *
   * They used to fire from the `compacted` event — after the transcript had
   * already been rewritten — and `PreCompact` was not a blocking event, so a
   * hook that wanted to save context first always arrived too late. A hook
   * that exits non-zero now stops the compaction instead.
   */
  private async beforeCompact(info: { before: number; trigger: "auto" }): Promise<{ blocked?: boolean; reason?: string }> {
    if (this.isSubagent) return {};
    const hooks = hooksFor(this.hooks, "PreCompact");
    if (hooks.length === 0) return {};
    try {
      const results = await runHooks(hooks, "PreCompact", { ...info, sessionId: this.sessionId }, process.cwd());
      const noise = results.map((result) => result.output).filter(Boolean).join("\n");
      if (noise) this.ui.dim(`[PreCompact] ${noise}`);
      const blocker = results.find((result) => result.blocked);
      return blocker ? { blocked: true, reason: blocker.output.slice(0, 300) } : {};
    } catch {
      // A hook that cannot run must not silently change whether compaction
      // happens; the default is to compact.
      return {};
    }
  }

  /**
   * What the model should still know after compaction: the plan, the files the
   * conversation has touched, and the rules currently in force. All three are
   * cheap to rebuild and expensive to lose mid-task.
   */
  private rehydration(): string {
    const parts: string[] = [];
    const open = this.todos.items.filter((item) => item.status !== "completed");
    if (open.length > 0) {
      const lines = open.map((item) => `- [${item.status === "in_progress" ? "x" : " "}] ${item.content}`);
      parts.push(`Open plan:\n${lines.join("\n")}`);
    }
    if (this.touched.size > 0) {
      const recent = [...this.touched].slice(-5);
      parts.push(`Files in play: ${recent.join(", ")}`);
    }
    const rules = renderRules(loadRules(), [...this.touched]);
    if (rules) parts.push(rules);
    return parts.join("\n\n");
  }

  /**
   * One non-streaming request for a compaction recap. It reuses the session's
   * client (same provider, key, and model) and never touches the transcript.
   */
  private async summarizeWithModel(
    old: ChatMessage[],
    localSummary: string,
    signal: AbortSignal,
    focus?: string,
  ): Promise<string> {
    if (this.isSubagent) return localSummary;
    const input = summarizerInput(old);
    if (!input.trim()) return localSummary;
    // The user's `/compact <focus>` is a request about what matters; folding it
    // into the system half keeps the transcript half faithfully untouched.
    const system = focus?.trim()
      ? `${SUMMARIZE_PROMPT}\n\nThe user asked the recap to concentrate on: ${focus.trim().slice(0, 1000)}`
      : SUMMARIZE_PROMPT;
    const request = this.client.chat(
      [
        { role: "system", content: system },
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

  /**
   * Ask the model whether a stated goal has been reached.
   *
   * This is a separate, small request rather than a reading of the last
   * message: an agent that just spent a round working is a poor judge of
   * whether it is done, and its prose is optimistic. A fresh question with only
   * the goal and the round's conclusion gets a sharper answer, and the loop
   * stops on it.
   *
   * Failure to answer is treated as "not met", never as success. A goal loop
   * that reports completion because the checker timed out is worse than one
   * that runs an extra round.
   */
  async assessGoal(input: { goal: string; roundSummary: string; history: string[] }, signal?: AbortSignal): Promise<{ met: boolean; reason: string }> {
    const own = signal ?? new AbortController().signal;
    const transcript = input.history.length ? `What has happened so far:\n${input.history.join("\n")}\n\n` : "";
    const request = this.client.chat(
      [
        {
          role: "system",
          content:
            "You judge whether a goal has been reached. Answer with exactly one line: MET: <reason> or NOT MET: <what is missing>. " +
            "Be strict: a goal is met only if the evidence in the transcript shows it, not because the work felt finished.",
        },
        { role: "user", content: `${transcript}Goal: ${input.goal}\n\nThis round concluded: ${input.roundSummary || "(nothing)"}` },
      ],
      [],
      () => {},
      () => {},
      own,
    );
    const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 30_000));
    const result = await Promise.race([request, timeout]).catch(() => null);
    if (!result) return { met: false, reason: "could not confirm the goal; treating it as unfinished" };

    const text = result.content.trim();
    const met = /^MET\s*:/i.test(text);
    return { met, reason: text.replace(/^(NOT\s+)?MET\s*:\s*/i, "") || (met ? "The goal is met." : "Not yet.") };
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
      // Both used to be fired from the `compacted` event, i.e. after the
      // transcript had already been rewritten. PreCompact now runs in `loop()`
      // before compaction and can block it; only the after-the-fact event is
      // dispatched here.
      case "compacted":
        ui.dim(`compacted (${event.level}) ${event.removed} earlier messages (~${event.before} -> ~${event.after} tokens)`);
        this.onCompacted?.({
          removed: event.removed,
          before: event.before,
          after: event.after,
          summary: event.summary,
          level: event.level,
          kept: event.kept,
        });
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
      case "usage": {
        // `event.usage` counts this run only (the loop starts at zero), so it
        // is added to the balance carried in from earlier runs. Assigning it
        // outright made the second turn overwrite the first, and the host's
        // per-turn delta went negative and was clamped to zero.
        //
        // The delta is what belongs to `main`: the cumulative value already
        // contains every earlier request this run, so adding the cumulative
        // each time would count a multi-step turn several times over.
        const delta = {
          inputTokens: Math.max(0, event.usage.inputTokens - this.reportedUsage.inputTokens),
          outputTokens: Math.max(0, event.usage.outputTokens - this.reportedUsage.outputTokens),
          cachedTokens: Math.max(0, event.usage.cachedTokens - this.reportedUsage.cachedTokens),
        };
        this.reportedUsage = { ...event.usage };
        const main = this.usageBySource.main;
        main.inputTokens += delta.inputTokens;
        main.outputTokens += delta.outputTokens;
        main.cachedTokens += delta.cachedTokens;
        this.lastUsedModel = this.activeModel();
        this.usage = {
          inputTokens: event.usage.inputTokens + this.usageBase.inputTokens + this.subagentUsage.inputTokens,
          outputTokens: event.usage.outputTokens + this.usageBase.outputTokens + this.subagentUsage.outputTokens,
          cachedTokens: event.usage.cachedTokens + this.usageBase.cachedTokens + this.subagentUsage.cachedTokens,
        };
        break;
      }
      default:
        break;
    }
  }

  /**
   * The model that actually answered.
   *
   * With a fallback chain the configured model is not necessarily the one that
   * served the request, so recording every token under `config.model` put the
   * spend on a model that never ran. `FallbackChatClient` exposes the active
   * client; a plain `ChatClient` names itself.
   */
  private activeModel(): string {
    const client = this.client as { options?: { model?: string }; active?: { options?: { model?: string } } };
    return client.active?.options?.model ?? client.options?.model ?? this.config.model;
  }

  private addSubagentUsage(usage: Usage, kind: "subagent" | "background" = "subagent"): void {    this.subagentUsage.inputTokens += usage.inputTokens;
    this.subagentUsage.outputTokens += usage.outputTokens;
    this.subagentUsage.cachedTokens += usage.cachedTokens;
    this.usage.inputTokens += usage.inputTokens;
    this.usage.outputTokens += usage.outputTokens;
    this.usage.cachedTokens += usage.cachedTokens;
    // Kept apart as well as summed: the total answers "what did this session
    // cost", the split answers "was delegate worth it".
    const bucket = this.usageBySource[kind];
    bucket.inputTokens += usage.inputTokens;
    bucket.outputTokens += usage.outputTokens;
    bucket.cachedTokens += usage.cachedTokens;
  }

  /**
   * Build one isolated child agent for a sub-task, with a proxied UI.
   *
   * The child runs with the parent's permission mode. It used to be forced to
   * `auto` and marked trusted, so approving one `delegate` silently approved
   * every write the child would make in that task — a grant the user never saw
   * and never chose. In `ask` mode the child's mutations now prompt like the
   * parent's, and in plan mode the child stays read-only.
   */
  private spawnSubagent(label: string): Agent {    const child = new Agent(
      { ...this.config, maxTurns: Math.min(25, this.config.maxTurns) },
      this.ui,
      this.client,
      SUBAGENT_TOOLS,
      new Permissions({ ...this.config }, this.ui),
      [],
      true,
    );
    // Surface the child's tool activity in the parent transcript's sub-agent group.
    const parentUi = this.ui;
    child.ui = new Proxy(parentUi, {
      get(target, property, receiver) {
        if (property === "toolStart") {
          return (name: string, summary: string) => parentUi.subagentActivity?.("tool", `${label}: ${name} ${summary}`);
        }
        return Reflect.get(target, property, receiver);
      },
    }) as TerminalUi;
    child.abortController = new AbortController();
    return child;
  }

  private async runSubagent(prompt: string, signal: AbortSignal): Promise<string> {
    if (this.isSubagent) throw new Error("sub-agents cannot spawn sub-agents");
    this.ui.info("  ↳ sub-agent started");
    this.ui.subagentStart?.(prompt);
    await this.fireSubagentHooks("SubagentStart", prompt);
    const child = this.spawnSubagent("sub-agent");
    const onAbort = () => child.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      await child.run(prompt);
      const text = [...child.messages].reverse().find((m) => m.role === "assistant" && m.content);
      this.addSubagentUsage(child.usage);
      this.ui.info("  ↳ sub-agent finished");
      const report = typeof text?.content === "string" ? text.content : "(sub-agent produced no text report)";
      this.ui.subagentEnd?.(true, report.slice(0, 160));
      await this.fireSubagentHooks("SubagentStop", prompt, report);
      return report;
    } catch (err) {
      this.ui.subagentEnd?.(false, (err as Error).message);
      await this.fireSubagentHooks("SubagentStop", prompt, (err as Error).message);
      throw err;
    } finally {
      signal.removeEventListener("abort", onAbort);
      child.abortController = null;
    }
  }

  /**
   * Run independent sub-tasks concurrently. Each child has its own abort
   * controller (so one failure does not cancel the others) and its own
   * transcript; only the reports come back.
   */
  private async runSubagents(prompts: string[], signal: AbortSignal): Promise<{ ok: boolean; report: string }[]> {
    if (this.isSubagent) throw new Error("sub-agents cannot spawn sub-agents");
    this.ui.info(`  ↳ ${prompts.length} sub-agents started in parallel`);
    const children = prompts.map((prompt, index) => {
      this.ui.subagentStart?.(`[${index + 1}] ${prompt}`);
      return { prompt, index, child: this.spawnSubagent(`#${index + 1}`) };
    });
    const onAbort = () => children.forEach(({ child }) => child.abort());
    signal.addEventListener("abort", onAbort, { once: true });

    const results = await Promise.all(
      children.map(async ({ prompt, index, child }) => {
        try {
          await child.run(prompt);
          const text = [...child.messages].reverse().find((m) => m.role === "assistant" && m.content);
          this.addSubagentUsage(child.usage);
          const report = typeof text?.content === "string" ? text.content : "(sub-agent produced no text report)";
          this.ui.subagentEnd?.(true, `#${index + 1} ${report.slice(0, 120)}`);
          return { ok: true, report };
        } catch (err) {
          this.ui.subagentEnd?.(false, `#${index + 1} ${(err as Error).message}`);
          return { ok: false, report: `sub-agent failed: ${(err as Error).message}` };
        } finally {
          child.abortController = null;
        }
      }),
    );
    signal.removeEventListener("abort", onAbort);
    this.ui.info(`  ↳ ${results.filter((result) => result.ok).length}/${results.length} sub-agents finished`);
    return results;
  }

  /**
   * Start a sub-task whose report is not needed to continue. The turn ends
   * normally; when the child finishes, the report is handed to
   * `onBackgroundReport` instead of being spliced into the conversation, so a
   * long-running task never holds the main loop open.
   */
  private startBackgroundSubagent(prompt: string): boolean {
    if (this.isSubagent) return false;
    if (this.background.size >= 4) return false;
    this.ui.subagentStart?.(`(background) ${prompt}`);
    const child = this.spawnSubagent("background");
    // `tracked` is assigned after the promise is created, so the finally block
    // can remove exactly this task without capturing a stale binding.
    const tracked = new Set<Promise<void>>();
    const task: Promise<void> = (async () => {
      try {
        await child.run(prompt);
        const text = [...child.messages].reverse().find((m) => m.role === "assistant" && m.content);
        const report = typeof text?.content === "string" ? text.content : "(background sub-agent produced no text report)";
        this.addSubagentUsage(child.usage, "background");
        this.ui.subagentEnd?.(true, `background: ${report.slice(0, 120)}`);
        this.onBackgroundReport?.(prompt, report, true);
      } catch (err) {
        this.ui.subagentEnd?.(false, `background: ${(err as Error).message}`);
        this.onBackgroundReport?.(prompt, (err as Error).message, false);
      } finally {
        child.abortController = null;
        for (const entry of tracked) this.background.delete(entry);
        tracked.clear();
      }
    })();
    tracked.add(task);
    this.background.add(task);
    return true;
  }

  /** Wait for background sub-tasks (tests and graceful shutdown). */
  async drainBackground(): Promise<void> {
    await Promise.allSettled([...this.background]);
  }

  /** Test seam for the parallel path; the delegate tool uses the pipeline copy. */
  async runSubagentsForTest(prompts: string[], signal: AbortSignal): Promise<{ ok: boolean; report: string }[]> {
    return this.runSubagents(prompts, signal);
  }

  contextUsage(): { tokens: number; percent: number } {
    // Everything the request carries: the conversation, the system prompt (not
    // stored in `messages`, it is rendered per request) and the tool schemas
    // (not messages either, but billed on every call).
    const tokens =
      estimateTokens(this.messages) +
      estimateTextTokens(this.requestSystemPrompt()) +
      toolSchemaTokens(this.tools);
    return { tokens, percent: Math.min(100, Math.round((tokens / this.config.contextWindow) * 100)) };
  }
}
