/** Shared types for the Prometheus agent runtime. */

/**
 * How a tool call is approved.
 *
 * The original three modes could not express the two workflows people actually
 * ask for: "edits are fine, commands still ask" (`acceptEdits`) and "this is
 * unattended, refuse rather than hang" (`dontAsk`). `bypassPermissions` is the
 * explicit opt-out of every prompt, kept separate from `auto` because `auto`
 * is still bounded by the sandbox classifier.
 */
export type PermissionMode = "ask" | "auto" | "plan" | "acceptEdits" | "dontAsk" | "bypassPermissions";
/**
 * A reasoning level, in the endpoint's own spelling.
 *
 * Deliberately an open string. The four levels this build started with
 * (`low`/`medium`/`high` plus `auto`) are what OpenAI's first `reasoning_effort`
 * accepted; gateways now advertise their own sets — `low/high/max`,
 * `high/xhigh`, `minimal` — per model, and a closed union made every one of
 * them a type error to send. `"auto"` is the one value that is never sent: it
 * means "use the model's own default", which `/models` reports.
 */
export type ThinkingEffort = string;
/** The sentinel meaning "do not send a level; let the model choose". */
export const EFFORT_AUTO = "auto";

/**
 * The board the user is working with, chosen in the Board pane.
 *
 * Persisted in config rather than UI preferences because it changes what the
 * agent does: `embed_flash` and `embed_serial` fall back to it when the model
 * does not name a port or target. A UI preference never reaches `ToolContext`.
 */
export interface BoardSelection {
  /** Serial console, e.g. `COM7`. */
  port?: string;
  /** Baud for that port. */
  baud?: number;
  /**
   * Target name the flashing tool understands (pyOCD's `stm32f103rc`), not a
   * Zephyr board or an Arduino FQBN — `embed_build` has its own `target`.
   */
  target?: string;
  /** Probe unique id, used to disambiguate when several are attached. */
  probe?: string;
  flasher?: "pyocd" | "probe-rs" | "openocd" | "esptool" | "st-flash" | "dfu-util" | "avrdude" | "jlink";
  /**
   * OpenOCD config pair. A board profile is the "probe + port + target"
   * object the research calls for, and these two are the part that a user
   * otherwise has to remember verbatim (`interface/stlink.cfg` and
   * `target/stm32f4x.cfg`).
   */
  interfaceConfig?: string;
  targetConfig?: string;
  /** Assert DTR when opening the console. Resets most boards; off by default. */
  assertDtr?: boolean;
}

/**
 * A saved, reusable board: the selection plus a name.
 *
 * The selection alone is "what is plugged in now". A profile is "the board I
 * work on", which is what a user with several boards wants to switch between
 * without re-deriving OpenOCD's two config files each time.
 */
export interface BoardProfile extends BoardSelection {
  name: string;
}

export interface Config {
  baseUrl: string;
  apiKey: string;
  /** Provider id from the registry (openai, deepseek, custom, ...). */
  provider?: string;
  model: string;
  maxTokens: number;
  permissionMode: PermissionMode;
  thinkingEffort: ThinkingEffort;
  contextWindow: number;
  maxTurns: number;
  /** Extra directories the agent may touch outside cwd. */
  allowedDirs: string[];
  /** Tool names auto-approved in ask mode. */
  autoApprove: string[];
  /**
   * `Tool(specifier)` entries refused outright, in every mode including auto.
   *
   * The counterpart to `autoApprove`: a CI run needs to say "these are fine"
   * and "these never run" in the same breath, and the second half had no
   * expression at all.
   */
  disallowedTools?: string[];
  /**
   * A non-interactive run that was told it may act without a person
   * (`--dont-ask`, or `--allowed-tools`). Only tools in `autoApprove` are then
   * granted; everything else is refused with a reason the model can act on
   * instead of a prompt nobody can answer.
   */
  unattended?: boolean;
  /** Command sandbox strength. "enforce" classifies and confines commands. */
  sandbox?: "off" | "enforce";
  /** Network access for commands: off rejects fetchers and injects a dead proxy. */
  networkPolicy?: "off" | "open";
  /** Model ids tried in order when the active model is unavailable. */
  fallbackModels?: string[];
  /** Board selected in the UI; tools use it as a default when an argument is omitted. */
  board?: BoardSelection;
  /** Saved boards the user can switch between. */
  boardProfiles?: BoardProfile[];
  /**
   * Set when `contextWindow` came from the built-in default rather than a
   * configured value. The agent warns once at the first turn, because a
   * gateway that serves a smaller window than the default would otherwise
   * reject a long request with no earlier signal.
   */
  contextWindowAssumed?: boolean;
  /**
   * Per-model context windows, keyed by model id prefix (longest prefix wins).
   *
   * A gateway that serves several models rarely serves them with the same
   * window, and one global number made the smaller model compact too late and
   * the larger one compact far too early.
   */
  contextWindowByModel?: Record<string, number>;
  /**
   * Window a sub-agent compacts against. Defaults to the session's own.
   *
   * A sub-agent exists to keep the parent's context small; giving it the same
   * window means it fills up just as fast and its report arrives after the
   * same number of turns the parent would have needed.
   */
  subagentContextWindow?: number;
  /**
   * Compact a conversation that has been idle for this many minutes.
   *
   * Off by default. It exists because a long-lived window may sit open for
   * hours with a warm prompt cache; compacting once while idle makes the first
   * message after the break cheaper. Gateways have no agreed cache TTL, so it
   * is a setting rather than behaviour.
   */
  idleCompactMinutes?: number;
  /**
   * Money ceiling for a CLI/REPL session, in US dollars. Checked between
   * turns; a turn already in flight is allowed to finish.
   */
  maxBudgetUsd?: number;
  /**
   * Token ceiling for the whole session, across runs. Checked between turns.
   */
  sessionTokenBudget?: number;
  /**
   * Money ceiling for a single goal/task loop, in US dollars.
   *
   * A loop is many turns started from one request, so it needs an allowance of
   * its own: `maxBudgetUsd` covers the session and a loop can spend all of it
   * before the user sees the first round's result.
   */
  goalBudgetUsd?: number;
  /**
   * Refuse to run a command when OS-level containment cannot be established,
   * instead of silently falling back to the policy layer alone.
   */
  sandboxFailIfUnavailable?: boolean;
  /**
   * Values a sandboxed command may read from its environment, keyed by
   * variable name. Stored in settings, never shown to the model and never
   * written to a transcript.
   */
  sandboxCredentials?: Record<string, string>;
  /** Kernel sandbox: `off` = policy only, `auto` = WSL when present, `wsl` = require it. */
  kernelSandbox?: "off" | "auto" | "wsl";
  /** WSL distribution to run sandboxed commands in; empty = the first listed. */
  kernelSandboxDistro?: string;
  /**
   * Send `reasoning_content` back on later turns. Only for providers whose
   * tool loop needs the previous reasoning; an unknown field is a 400 risk on
   * every other gateway.
   */
  echoReasoning?: boolean;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/** A pasted image, stored as a data URL the endpoint can decode. */
export interface ImagePart {
  type: "image_url";
  image_url: { url: string };
}

export type TextPart = { type: "text"; text: string };

/** User turns may carry images alongside text for vision-capable models. */
export type UserContentPart = TextPart | ImagePart;

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | UserContentPart[] }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: ToolCall[];
      /**
       * Reasoning the model produced for this turn, kept so it can be sent back.
       *
       * Some endpoints require the reasoning of the previous tool call to be
       * echoed verbatim; others reject an unknown field. `Agent` sends it only
       * when the provider is known to accept it (`Config.echoReasoning`), so
       * the default request shape stays exactly what it was.
       */
      reasoning_content?: string;
    }
  | { role: "tool"; tool_call_id: string; content: string };

export interface ToolResult {
  content: string;
  isError?: boolean;
  /** Short human-readable summary for the transcript UI. */
  display?: string;
  /**
   * Structured result for a UI that can do more than print text. Small enough
   * to send over the event stream; the CLI and sub-agents ignore it.
   */
  data?: unknown;
}

export interface ToolContext {
  cwd: string;
  signal: AbortSignal;
  config: Config;
  permissions: PermissionManager;
  ui: Ui;
  todo: TodoList;
  /** Session id, so a long tool result can be written next to the transcript. */
  sessionId?: string;
  runSubagent: (prompt: string, options?: { context?: "none" | "summary" | "full" }) => Promise<string>;
  /** Run several independent sub-tasks concurrently; results are in input order. */
  runSubagents?: (prompts: string[], options?: { context?: "none" | "summary" | "full" }) => Promise<{ ok: boolean; report: string }[]>;
  /** Start a sub-task that outlives the tool call; false when the cap is reached. */
  runSubagentInBackground?: (prompt: string) => boolean;
  /** Addressable sub-agents: list, message, stop, read. */
  subagents?: {
    list(): { id: string; label: string; status: string; context: string; turns: number }[];
    message(id: string, text: string): Promise<string>;
    stop(id: string): boolean;
    report(id: string): string | null;
  };
}

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /** Read-only tools never prompt in ask mode and are the only ones allowed in plan mode. */
  readonly: boolean;
  /**
   * A per-call escape from `readonly`: the arguments that make this call a
   * write, or null when it is a plain read.
   *
   * `readonly` is a property of the tool, but some tools are only dangerous
   * for one argument. `embed_serial` tails a console (safe) or sends bytes to
   * a board (not safe); under a static `readonly: true` the second half ran in
   * plan mode and without a prompt. The permission layer treats a non-null
   * answer exactly as it treats `readonly: false`.
   */
  mutation?: (input: Record<string, unknown>) => string | null;
  /**
   * Safe to run alongside another call in the same batch.
   *
   * Defaults to `readonly`: reads do not observe each other's effects, and a
   * mutating tool is serialized so two writes cannot interleave. A tool that
   * is not readonly but is still safe to batch (todo_write, remember) says so.
   */
  parallelSafe?: boolean;
  /** Keep the full output on disk and tell the model where, when it is truncated. */
  persistOutput?: boolean;
  /**
   * Hide the full schema until the model asks for it.
   *
   * Every tool definition is part of every request, and forty MCP tools cost
   * roughly fifteen thousand tokens whether or not they are used. A deferred
   * tool is announced by name in `tool_search` instead; calling that tool
   * returns the schemas and makes them callable for the rest of the session.
   */
  deferred?: boolean;
  summarize: (input: Record<string, unknown>) => string;
  execute: (input: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;
}

export interface TodoItem {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed";
}

export interface TodoList {
  items: TodoItem[];
}

export interface Ui {
  info(text: string): void;
  dim(text: string): void;
  warn(text: string): void;
  error(text: string): void;
  assistantText(delta: string): void;
  assistantEnd(): void;
  /** Drop the reply currently being streamed; a retried request starts over. */
  discardAssistant?(): void;
  /** A tool call's arguments are arriving; `text` is the newest fragment. */
  toolDelta?(name: string, text: string): void;
  /**
   * `meta` carries what a machine consumer needs to pair a call with its
   * result and to see what was actually passed: a per-call id, the resolved
   * arguments, and when it started. Human UIs ignore it.
   */
  toolStart(name: string, summary: string, meta?: { id: string; input: Record<string, unknown>; at: string }): void;
  toolEnd(name: string, ok: boolean, summary: string, meta?: { id: string; at: string }): void;
  /** Full, possibly long tool output for inspection. */
  toolOutput?(name: string, content: string): void;
  /** Structured result from a tool, for UIs that render it rather than print it. */
  toolDetail?(name: string, data: unknown): void;
  thinking(delta: string): void;
  thinkingEnd(): void;
  todos(items: TodoItem[]): void;
  /**
   * Ask before a tool runs. `detail` is what the approval is about — for a
   * file edit, the before/after so the user can see the change instead of
   * approving a path.
   */
  confirm(question: string, detail?: PermissionDetail): Promise<"yes" | "always" | "no">;
  /** False for a UI with no user behind it (headless JSON output). */
  canPrompt?: boolean;
  /**
   * Release timers and streams before the process exits. Exiting with a
   * spinner interval still armed trips a libuv assertion on Windows, which
   * turns a finished run into a crash with no useful message.
   */
  dispose?(): void;
  /** A retry the loop is about to attempt, so a UI can show "retry 1/3". */
  retryAttempt?(attempt: number, delayMs: number, message: string): void;
  spinnerStart(text: string): void;
  spinnerStop(): void;
  setModelName?(name: string): void;
  /** Echo a submitted user message into the transcript. */
  echoUser?(text: string): void;
  /** A sub-agent's lifecycle, shown as a nested group in the transcript. */
  subagentStart?(prompt: string, meta?: { id: string }): void;
  subagentActivity?(kind: "tool" | "text", text: string): void;
  subagentEnd?(ok: boolean, summary: string): void;
  /** True if the last streamed text ended mid-line. */
  takeLineDirty?(): boolean;
  /** Inline question with extra answers; falls back to `confirm` when absent. */
  ask?(question: string, options: { value: string; label: string }[]): Promise<string>;
  /**
   * A richer question channel for `ask_user`: options may carry a monospace
   * preview and the question may allow several answers. Falls back to `ask`.
   */
  askWithOptions?(
    question: string,
    options: { value: string; label: string; preview?: string }[],
    extra?: { multiSelect?: boolean; header?: string },
  ): Promise<string>;
}

export interface PermissionManager {
  mode: PermissionMode;
  check(
    tool: Tool,
    input: Record<string, unknown>,
    detail?: PermissionDetail,
  ): Promise<{ allowed: boolean; reason?: string }>;
}

/** The change a permission prompt is asking about. */
export interface PermissionDetail {
  path: string;
  /** Absent for a file that does not exist yet. */
  before: string | null;
  after: string | null;
  additions: number;
  deletions: number;
}

/**
 * A permission prompt that can show what is about to change.
 *
 * `detail` is optional so a manager that has nothing to add (a test double, a
 * tool that touches no file) is unchanged; a UI that does not render it can
 * ignore it.
 */
export interface PermissionAsk {
  question: string;
  detail?: PermissionDetail;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  /**
   * Input tokens written into a prompt cache on this request.
   *
   * Gateways bill these differently from an ordinary uncached token
   * (Anthropic-style `cache_creation_input_tokens`, and some proxies expose
   * `prompt_cache_miss_tokens`). Optional so every existing arithmetic site
   * keeps compiling; `usage.ts` adds the cost only when it is present.
   */
  cacheWriteTokens?: number;
}

/**
 * Usage split by who spent it.
 *
 * The main loop and its sub-agents share one bill today, so `delegate` cannot
 * be judged on cost. `Agent.usageBySource` keeps the split so a host can record
 * one line per source instead of one opaque total.
 */
export interface UsageBreakdown {
  main: Usage;
  subagent: Usage;
  background: Usage;
}
