/**
 * The agent's main loop, written as one async generator state machine.
 *
 * The loop yields events instead of calling the UI directly, so the same
 * machine drives the terminal, the desktop host, and tests without knowing
 * which one is listening. The states are explicit:
 *
 *   idle -> compact -> requesting -> streaming -> tools -> (requesting | idle)
 *                          ^                          |
 *                          +------- retrying <--------+   (recoverable only)
 *
 * Invariants:
 * - messages is mutated in place, so the caller's reference stays valid even
 *   when compaction rewrites the conversation.
 * - A tool message is never separated from the assistant turn that requested
 *   it; queued user text joins only at a tool boundary.
 * - Terminal errors end the turn; recoverable errors are retried with backoff
 *   and keep the same conversation intact.
 * - Streaming deltas reach the consumer live: the client pushes into a
 *   channel that the generator drains while the request is in flight.
 */

import type { ChatMessage } from "./types.ts";
import type { ApiTool, ChatClient } from "./llm.ts";
import type { Config, Usage } from "./types.ts";
import { compactWithModel, type CompactionLevel } from "./context.ts";
import { classifyError, type ClassifiedError } from "./errors.ts";
import type { ToolPipeline } from "./tools/pipeline.ts";

export type QueryEvent =
  | { type: "assistant_start" }
  | { type: "assistant_text"; text: string }
  | { type: "assistant_end" }
  | { type: "thinking"; text: string }
  | { type: "usage"; usage: Usage }
  | { type: "retry"; attempt: number; delayMs: number; message: string }
  | { type: "compacted"; removed: number; summary: string; before: number; after: number; level: CompactionLevel }
  | { type: "queued_delivered"; texts: string[] }
  | { type: "warning"; text: string }
  | { type: "turn_end"; reason: TurnEndReason }
  | { type: "error"; error: ClassifiedError };

export type TurnEndReason = "complete" | "aborted" | "max_turns" | "error";

export interface QueryOptions {
  /** Long-lived conversation. Compaction rewrites it in place. */
  messages: ChatMessage[];
  config: Config;
  client: ChatClient;
  pipeline: ToolPipeline;
  /** Recomputed each request so tools added at runtime (MCP) are visible. */
  apiTools: () => ApiTool[];
  signal: AbortSignal;
  /** Move queued user messages into the conversation; returns the texts taken. */
  drainQueue?: () => string[];
  /** How many recoverable failures to tolerate in one turn. */
  maxRetries?: number;
  /**
   * Ask the model for the recap when compaction needs one. Without it the
   * local keyword summary is used (tests, offline runs).
   */
  summarize?: (old: ChatMessage[], localSummary: string) => Promise<string>;
}

export interface QueryResult {
  usage: Usage;
  reason: TurnEndReason;
}

const MAX_RETRIES = 3;

/** A single-consumer push queue; callbacks can deliver events mid-request. */
class Channel<T> {
  private readonly items: T[] = [];
  private waiter: ((value: T | null) => void) | null = null;
  private closed = false;

  push(item: T): void {
    if (this.closed) return;
    const waiter = this.waiter;
    if (waiter) {
      this.waiter = null;
      waiter(item);
    } else {
      this.items.push(item);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const waiter = this.waiter;
    if (waiter) {
      this.waiter = null;
      waiter(null);
    }
  }

  take(): Promise<T | null> {
    if (this.items.length > 0) return Promise.resolve(this.items.shift() as T);
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => {
      this.waiter = resolve;
    });
  }
}

export async function* query(options: QueryOptions): AsyncGenerator<QueryEvent, QueryResult> {
  const { messages, config, client, pipeline, signal } = options;
  const maxRetries = options.maxRetries ?? MAX_RETRIES;
  const usage: Usage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
  let turns = 0;

  for (;;) {
    if (signal.aborted) return finish(usage, "aborted");
    if (turns++ >= config.maxTurns) {
      yield { type: "warning", text: `Stopped after ${config.maxTurns} turns. Send another message to continue.` };
      return finish(usage, "max_turns");
    }

    // compact: shrink the window before paying for a request
    const compaction = options.summarize
      ? await compactWithModel(messages, config.contextWindow, { summarize: options.summarize, signal })
      : await compactWithModel(messages, config.contextWindow, { summarize: async () => "" });
    if (compaction) {
      messages.splice(0, messages.length, ...compaction.messages);
      yield {
        type: "compacted",
        removed: compaction.removed,
        summary: compaction.summary,
        before: compaction.before,
        after: compaction.after,
        level: compaction.level,
      };
    }

    // requesting -> streaming, with recoverable-error retries
    const result = yield* requestWithRetries(options, usage, maxRetries);
    if (result.kind === "failed") {
      yield { type: "error", error: result.error };
      return finish(usage, "error");
    }
    if (result.kind === "aborted") return finish(usage, "aborted");
    const response = result.value;

    usage.inputTokens += response.usage.inputTokens;
    usage.outputTokens += response.usage.outputTokens;
    usage.cachedTokens += response.usage.cachedTokens;
    yield { type: "usage", usage };

    messages.push({
      role: "assistant",
      content: response.content || null,
      ...(response.toolCalls.length ? { tool_calls: response.toolCalls.map((call) => ({ ...call, type: "function" as const })) } : {}),
    });

    if (response.toolCalls.length === 0) {
      if (response.finishReason === "length") {
        yield { type: "warning", text: "Response hit the max_tokens limit. Ask for a smaller step or raise maxTokens." };
      }
      return finish(usage, "complete");
    }

    // tools - the pipeline owns tool UI (start/end/output) and the five stages
    for (const call of response.toolCalls) {
      if (signal.aborted) return finish(usage, "aborted");
      const outcome = await pipeline.run(call.function.name, call.function.arguments, signal);
      messages.push({ role: "tool", tool_call_id: call.id, content: outcome.content });
    }

    // Queued text joins the conversation at the tool boundary, which is the
    // only point where a user turn cannot split an assistant/tool pair.
    const delivered = options.drainQueue?.() ?? [];
    if (delivered.length > 0) {
      for (const text of delivered) messages.push({ role: "user", content: text });
      yield { type: "queued_delivered", texts: delivered };
    }
  }
}

type RequestOutcome =
  | { kind: "ok"; value: Awaited<ReturnType<ChatClient["chat"]>> }
  | { kind: "failed"; error: ClassifiedError }
  | { kind: "aborted" };

/** One request with its retry/backoff policy, streaming events as they arrive. */
async function* requestWithRetries(
  options: QueryOptions,
  _usage: Usage,
  maxRetries: number,
): AsyncGenerator<QueryEvent, RequestOutcome> {
  const { messages, client, signal } = options;

  for (let attempt = 1; ; attempt++) {
    const channel = new Channel<QueryEvent>();
    let started = false;

    const request = client.chat(
      messages,
      options.apiTools(),
      (delta) => {
        if (!started) {
          started = true;
          channel.push({ type: "assistant_start" });
        }
        channel.push({ type: "assistant_text", text: delta });
      },
      (delta) => channel.push({ type: "thinking", text: delta }),
      signal,
    );
    // The request closes the channel when it settles, so this loop ends either
    // with the queue drained or with a result recorded below.
    let failure: unknown = null;
    let success: Awaited<ReturnType<ChatClient["chat"]>> | null = null;
    const settled = request.then(
      (value) => {
        success = value;
        channel.close();
      },
      (error: unknown) => {
        failure = error;
        channel.close();
      },
    );

    for (let next = await channel.take(); next !== null; next = await channel.take()) yield next;
    await settled;
    if (started) yield { type: "assistant_end" };
    if (success) return { kind: "ok", value: success };
    if (signal.aborted) return { kind: "aborted" };
    const classified = classifyError(failure, attempt);
    if (classified.level === "terminal" || attempt >= maxRetries) {
      return { kind: "failed", error: classified };
    }
    yield { type: "retry", attempt, delayMs: classified.retryAfterMs, message: classified.message };
    await sleep(classified.retryAfterMs, signal);
    if (signal.aborted) return { kind: "aborted" };
  }
}

function finish(usage: Usage, reason: TurnEndReason): QueryResult {
  return { usage, reason };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
