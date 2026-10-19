/**
 * Model fallback: when the primary model is unavailable, try the next one.
 *
 * The user can list fallback model ids in settings. A request is only handed to
 * the next model when the failure is about the model rather than the request:
 *
 *   model unavailable   404 / 400 "model not found", 503, 529
 *   rate limited        429 (after the loop's own retries are exhausted)
 *   auth / bad input    never - another model will fail the same way
 *
 * The wrapper implements the same `chat` shape as `ChatClient`, so the agent
 * and the query loop cannot tell the difference. Fallbacks are per request:
 * once a model answers, it stays the active one for that request only.
 */

import { ApiError, ChatClient, type ApiTool, type StreamResult } from "./llm.ts";
import type { ChatCompletionMessage } from "./llm.ts";

export interface FallbackClientOptions {
  primary: ChatClient;
  /** Lazily built clients for the fallback ids, in order. */
  fallbacks: () => ChatClient[];
  /** Called when a fallback takes over, for the UI. */
  onFallback?: (from: string, to: string, reason: string) => void;
}

/** Whether another model plausibly fixes this failure. */
export function shouldFallBack(error: unknown): boolean {
  if (error instanceof ApiError) {
    if (error.status === 404 || error.status === 429 || error.status === 503 || error.status === 529) return true;
    if (error.status === 400) return /model|not found|does not exist|unsupported/i.test(error.message);
    return false;
  }
  // Network failures are worth trying on another model: the same gateway may
  // reject one model and serve another, and a transient reset affects both.
  // fetch wraps the cause, so inspect both levels.
  const code = (error as { code?: string; cause?: { code?: string } } | undefined)?.code
    ?? (error as { cause?: { code?: string } } | undefined)?.cause?.code;
  return code === "ECONNRESET" || code === "ETIMEDOUT" || code === "ENOTFOUND" || code === "ECONNREFUSED" || code === "UND_ERR_SOCKET";
}

export class FallbackChatClient {
  constructor(options: FallbackClientOptions) {
    this.options_ = options;
  }

  /**
   * The live primary options. The host mutates `client.options.model` when the
   * user switches models, so it must be the same object the primary holds.
   */
  get options(): ChatClient["options"] {
    return this.options_.primary.options;
  }

  private readonly options_: FallbackClientOptions;

  /**
   * The client that answered most recently in this request.
   *
   * This used to return the primary unconditionally, so a request served by a
   * fallback was still billed and reported under the configured model. The
   * symptom (the wrong model name in the usage log) looks cosmetic until the
   * budget is computed from it.
   */
  private lastClient: ChatClient | null = null;

  /** The client currently answering, so callers can read `options.model`. */
  get active(): ChatClient {
    return this.lastClient ?? this.options_.primary;
  }

  async chat(
    messages: ChatCompletionMessage[],
    tools: ApiTool[],
    onText: (delta: string) => void,
    onThinking: (delta: string) => void,
    signal: AbortSignal,
    onToolDelta?: (index: number, name: string, delta: string) => void,
  ): Promise<StreamResult> {
    let lastError: unknown;
    const chain = [this.options_.primary, ...this.options_.fallbacks()];

    for (let index = 0; index < chain.length; index++) {
      const client = chain[index];
      try {
        const result = await client.chat(messages, tools, onText, onThinking, signal, onToolDelta);
        this.lastClient = client;
        return result;
      } catch (error) {
        lastError = error;
        if (signal.aborted) throw error;
        const next = chain[index + 1];
        if (!next || !shouldFallBack(error)) throw error;
        const reason = error instanceof ApiError ? `HTTP ${error.status}` : ((error as Error).message ?? "request failed");
        this.options_.onFallback?.(client.options.model, next.options.model, reason);
      }
    }
    throw lastError;
  }
}

/** Build fallback clients from model ids, reusing the primary's endpoint and key. */
export function buildFallbackClients(primary: ChatClient, models: string[]): ChatClient[] {
  return models
    .filter((model) => model && model !== primary.options.model)
    .map(
      (model) =>
        new ChatClient({
          ...primary.options,
          model,
          // "auto" leaves it to the endpoint; a concrete effort may be rejected
          // by a different model, so fallbacks never send one.
          reasoningEffort: "auto",
        }),
    );
}
