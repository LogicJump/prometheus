/**
 * Minimal OpenAI-compatible chat-completions client with SSE streaming and
 * tool-call delta accumulation. Works with OpenAI, DeepSeek, Moonshot, Qwen,
 * Ollama, vLLM, LM Studio, and any gateway exposing the same shape.
 */

import type { Usage } from "./types.ts";

export interface ChatCompletionMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_calls?: ApiToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ApiToolCall {
  id: string;
  type?: "function";
  function: { name: string; arguments: string };
}

export interface ApiTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface StreamResult {
  content: string;
  toolCalls: ApiToolCall[];
  finishReason: string | null;
  usage: Usage;
}

export interface ChatClientOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  maxTokens: number;
  timeoutMs?: number;
}

type DeltaToolCall = {
  index: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
};

export class ChatClient {
  options: ChatClientOptions;

  constructor(options: ChatClientOptions) {
    this.options = options;
  }

  /** Whether the endpoint speaks SSE. Disable for servers that only do non-streaming. */
  stream = true;

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.options.apiKey}`,
    };
    return headers;
  }

  async chat(
    messages: ChatCompletionMessage[],
    tools: ApiTool[],
    onText: (delta: string) => void,
    onThinking: (delta: string) => void,
    signal: AbortSignal,
  ): Promise<StreamResult> {
    const body: Record<string, unknown> = {
      model: this.options.model,
      messages,
      max_tokens: this.options.maxTokens,
      stream: this.stream,
    };
    if (tools.length > 0) {
      body.tools = tools;
      body.tool_choice = "auto";
    }
    if (this.stream) body.stream_options = { include_usage: true };

    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(
      () => controller.abort(new Error(`request timed out after ${(this.options.timeoutMs ?? 120000) / 1000}s`)),
      this.options.timeoutMs ?? 120000,
    );

    try {
      const res = await fetch(`${this.options.baseUrl}/chat/completions`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new ApiError(res.status, describeHttpError(res.status, text));
      }
      if (!this.stream) {
        return await this.parseNonStreaming(res);
      }
      return await this.parseStreaming(res, onText, onThinking);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    }
  }

  private async parseNonStreaming(res: Response): Promise<StreamResult> {
    const json = (await res.json()) as {
      choices?: {
        message?: { content?: string | null; tool_calls?: ApiToolCall[] };
        finish_reason?: string;
      }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
    };
    const choice = json.choices?.[0];
    return {
      content: choice?.message?.content ?? "",
      toolCalls: choice?.message?.tool_calls ?? [],
      finishReason: choice?.finish_reason ?? null,
      usage: {
        inputTokens: json.usage?.prompt_tokens ?? 0,
        outputTokens: json.usage?.completion_tokens ?? 0,
        cachedTokens: json.usage?.prompt_tokens_details?.cached_tokens ?? 0,
      },
    };
  }

  private async parseStreaming(
    res: Response,
    onText: (delta: string) => void,
    onThinking: (delta: string) => void,
  ): Promise<StreamResult> {
    if (!res.body) throw new ApiError(0, "Streaming response has no body");

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    let finishReason: string | null = null;
    const usage: Usage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
    const toolCalls = new Map<number, ApiToolCall>();

    const handleLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) return;
      const data = trimmed.slice(5).trim();
      if (!data || data === "[DONE]") return;
      let chunk: {
        choices?: {
          delta?: {
            content?: string | null;
            reasoning_content?: string | null;
            reasoning?: string | null;
            tool_calls?: DeltaToolCall[];
          };
          finish_reason?: string | null;
        }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
      };
      try {
        chunk = JSON.parse(data);
      } catch {
        return; // ignore malformed keep-alives
      }

      if (chunk.usage) {
        usage.inputTokens = chunk.usage.prompt_tokens ?? usage.inputTokens;
        usage.outputTokens = chunk.usage.completion_tokens ?? usage.outputTokens;
        usage.cachedTokens = chunk.usage.prompt_tokens_details?.cached_tokens ?? usage.cachedTokens;
      }

      const choice = chunk.choices?.[0];
      if (!choice) return;
      const delta = choice.delta;
      if (delta?.reasoning_content) onThinking(delta.reasoning_content);
      if (delta?.reasoning) onThinking(delta.reasoning);
      if (delta?.content) {
        content += delta.content;
        onText(delta.content);
      }
      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          const index = tc.index ?? 0;
          let current = toolCalls.get(index);
          if (!current) {
            current = { id: "", type: "function", function: { name: "", arguments: "" } };
            toolCalls.set(index, current);
          }
          if (tc.id) current.id = tc.id;
          if (tc.function?.name) current.function.name += tc.function.name;
          if (tc.function?.arguments) current.function.arguments += tc.function.arguments;
        }
      }
      if (choice.finish_reason) finishReason = choice.finish_reason;
    };

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        handleLine(line);
      }
    }
    if (buffer) handleLine(buffer);

    const calls = [...toolCalls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, call]) => ({
        id: call.id || `call_${Math.random().toString(36).slice(2, 12)}`,
        type: "function" as const,
        function: call.function,
      }));

    return { content, toolCalls: calls, finishReason, usage };
  }
}

export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
  get retryable(): boolean {
    return this.status === 429 || this.status >= 500 || this.status === 0;
  }
}

function describeHttpError(status: number, body: string): string {
  let detail = body.slice(0, 800);
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } | string; message?: string };
    if (typeof parsed.error === "string") detail = parsed.error;
    else if (parsed.error?.message) detail = parsed.error.message;
    else if (parsed.message) detail = parsed.message;
  } catch {
    /* keep raw body */
  }
  const hints: Record<number, string> = {
    401: "authentication failed - check your API key",
    403: "permission denied for this model or endpoint",
    404: "endpoint not found - check the base URL",
    429: "rate limited or out of quota",
  };
  const hint = hints[status] ? `${hints[status]}: ` : "";
  return `HTTP ${status} ${hint}${detail}`.trim();
}
