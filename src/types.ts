/** Shared types for the Prometheus agent runtime. */

export type PermissionMode = "ask" | "auto" | "plan";
export type ThinkingEffort = "auto" | "low" | "medium" | "high";

export interface Config {
  baseUrl: string;
  apiKey: string;
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
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface ToolResult {
  content: string;
  isError?: boolean;
  /** Short human-readable summary for the transcript UI. */
  display?: string;
}

export interface ToolContext {
  cwd: string;
  signal: AbortSignal;
  config: Config;
  permissions: PermissionManager;
  ui: Ui;
  todo: TodoList;
  runSubagent: (prompt: string) => Promise<string>;
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
