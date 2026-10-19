/** Shared types for the Prometheus agent runtime. */

export type PermissionMode = "ask" | "auto" | "plan";
export type ThinkingEffort = "auto" | "low" | "medium" | "high";

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
  /** Assert DTR when opening the console. Resets most boards; off by default. */
  assertDtr?: boolean;
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
  /** Command sandbox strength. "enforce" classifies and confines commands. */
  sandbox?: "off" | "enforce";
  /** Network access for commands: off rejects fetchers and injects a dead proxy. */
  networkPolicy?: "off" | "proxy" | "open";
  /** Model ids tried in order when the active model is unavailable. */
  fallbackModels?: string[];
  /** Board selected in the UI; tools use it as a default when an argument is omitted. */
  board?: BoardSelection;
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
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
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
  runSubagent: (prompt: string) => Promise<string>;
  /** Run several independent sub-tasks concurrently; results are in input order. */
  runSubagents?: (prompts: string[]) => Promise<{ ok: boolean; report: string }[]>;
  /** Start a sub-task that outlives the tool call; false when the cap is reached. */
  runSubagentInBackground?: (prompt: string) => boolean;
}

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /** Read-only tools never prompt in ask mode and are the only ones allowed in plan mode. */
  readonly: boolean;
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
  toolStart(name: string, summary: string): void;
  toolEnd(name: string, ok: boolean, summary: string): void;
  /** Full, possibly long tool output for inspection. */
  toolOutput?(name: string, content: string): void;
  /** Structured result from a tool, for UIs that render it rather than print it. */
  toolDetail?(name: string, data: unknown): void;
  thinking(delta: string): void;
  thinkingEnd(): void;
  todos(items: TodoItem[]): void;
  confirm(question: string): Promise<"yes" | "always" | "no">;
  spinnerStart(text: string): void;
  spinnerStop(): void;
  setModelName?(name: string): void;
  /** Echo a submitted user message into the transcript. */
  echoUser?(text: string): void;
  /** A sub-agent's lifecycle, shown as a nested group in the transcript. */
  subagentStart?(prompt: string): void;
  subagentActivity?(kind: "tool" | "text", text: string): void;
  subagentEnd?(ok: boolean, summary: string): void;
  /** True if the last streamed text ended mid-line. */
  takeLineDirty?(): boolean;
  /** Inline question with extra answers; falls back to `confirm` when absent. */
  ask?(question: string, options: { value: string; label: string }[]): Promise<string>;
}

export interface PermissionManager {
  mode: PermissionMode;
  check(tool: Tool, input: Record<string, unknown>): Promise<{ allowed: boolean; reason?: string }>;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
}
