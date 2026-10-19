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
import type { FallbackChatClient } from "./fallback.ts";
import type { Config, Usage } from "./types.ts";
import { compactWithModel, estimateTokens, needsCompaction, type CompactionLevel } from "./context.ts";
import { classifyError, type ClassifiedError } from "./errors.ts";
import type { ToolPipeline } from "./tools/pipeline.ts";

export type QueryEvent =
  | { type: "assistant_start" }
  | { type: "assistant_text"; text: string }
  | { type: "assistant_end" }
  | { type: "thinking"; text: string }
  | { type: "usage"; usage: Usage }
  | { type: "retry"; attempt: number; delayMs: number; message: string }
  | { type: "compacted"; removed: number; summary: string; before: number; after: number; level: CompactionLevel; kept: number }
  | { type: "queued_delivered"; texts: string[] }
  | { type: "warning"; text: string }
  | { type: "turn_end"; reason: TurnEndReason }
  | { type: "error"; error: ClassifiedError };

export type TurnEndReason = "complete" | "aborted" | "max_turns" | "error";

export interface QueryOptions {
  /** Long-lived conversation. Compaction rewrites it in place. */
  messages: ChatMessage[];
  /**
   * The system prompt, rendered at request time rather than stored in
   * `messages`. A restored conversation has no system message on disk, and a
   * mode or rule change must reach the next request without rewriting history.
   */
  system?: () => string;
  config: Config;
  client: ChatClient | FallbackChatClient;
  pipeline: ToolPipeline;
  /** Recomputed each request so tools added at runtime (MCP) are visible. */
  apiTools: () => ApiTool[];
  signal: AbortSignal;
  /** Move queued user messages into the conversation; returns the texts taken. */
  drainQueue?: () => string[];
  /** How many recoverable failures to tolerate in one turn. */
  maxRetries?: number;
  /** Rebuilt state (plan, files in play, rules) to keep across compaction. */
  rehydrate?: () => string;
  /**
   * Ask the model for the recap when compaction needs one. Without it the
   * local keyword summary is used (tests, offline runs).
   */
  summarize?: (old: ChatMessage[], localSummary: string, focus?: string) => Promise<string>;
  /**
   * Runs before compaction rewrites the transcript. Returning `blocked` cancels
   * the compaction for this turn, which is what makes a PreCompact hook able
   * to protect context instead of reporting after the fact.
   */
  beforeCompact?: (info: { before: number; trigger: "auto" }) => Promise<{ blocked?: boolean; reason?: string }>;
  /** Called after the transcript was replaced, for PostCompact hooks. */
  afterCompact?: (result: { removed: number; before: number; after: number; summary: string; level: string; kept: number }) => void;
}

export interface QueryResult {
  usage: Usage;
  reason: TurnEndReason;
}

const MAX_RETRIES = 3;
/** How many empty / thinking-only replies are retried before the turn ends. */
const MAX_EMPTY_RETRIES = 1;
/** How many times a `finish_reason: "length"` reply is continued. */
const MAX_CONTINUATIONS = 2;

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
  let emptyRetries = 0;
  let continuations = 0;
  let compactionBlocked = false;

  for (;;) {
    if (signal.aborted) return finish(usage, "aborted");
    if (turns++ >= config.maxTurns) {
      yield { type: "warning", text: `Stopped after ${config.maxTurns} turns. Send another message to continue.` };
      return finish(usage, "max_turns");
    }

    // compact: shrink the window before paying for a request
    if (!compactionBlocked && needsCompaction(messages, config.contextWindow)) {
      const before = estimateTokensOf(messages);
      const verdict = (await options.beforeCompact?.({ before, trigger: "auto" })) ?? {};
      if (verdict.blocked) {
        // A PreCompact hook said no. Do not try again this turn: the hook was
        // asked, gave its reason, and repeating the question every iteration
        // would spam it. The request goes out over budget, which is the honest
        // consequence of refusing to compact.
        compactionBlocked = true;
        yield {
          type: "warning",
          text: `compaction was blocked by a PreCompact hook${verdict.reason ? `: ${verdict.reason}` : ""}; continuing with the full context`,
        };
      } else {
        const compaction = await compactWithModel(messages, config.contextWindow, {
          summarize: options.summarize ?? (async () => ""),
          signal,
          ...(options.rehydrate ? { rehydrate: options.rehydrate } : {}),
        });
        if (compaction) {
          messages.splice(0, messages.length, ...compaction.messages);
          yield {
            type: "compacted",
            removed: compaction.removed,
            summary: compaction.summary,
            before: compaction.before,
            after: compaction.after,
            level: compaction.level,
            kept: compaction.messages.length,
          };
          options.afterCompact?.({
            removed: compaction.removed,
            before: compaction.before,
            after: compaction.after,
            summary: compaction.summary,
            level: compaction.level,
            kept: compaction.messages.length,
          });
        }
      }
    }

    // requesting -> streaming, with recoverable-error retries
    const result = yield* requestWithRetries(options, usage, maxRetries);
    if (result.kind === "failed") {
      yield { type: "error", error: result.error };
      return finish(usage, "error");
    }
    if (result.kind === "aborted") {
      // Keep what the user already saw. Dropping it made an interrupted turn
      // look like it never said anything, and the next request lost that
      // context too.
      const partial = result.partial.trim();
      if (partial) messages.push({ role: "assistant", content: partial });
      return finish(usage, "aborted");
    }
    const response = result.value;

    usage.inputTokens += response.usage.inputTokens;
    usage.outputTokens += response.usage.outputTokens;
    usage.cachedTokens += response.usage.cachedTokens;
    yield { type: "usage", usage };

    // A gateway that answers with nothing at all — no text, no tool call, no
    // reasoning — produces a turn the user cannot even react to. Ask once
    // more before giving up; the retry is cheap and the failure is transient
    // far more often than it is real.
    const emptyReply =
      !response.content.trim() && response.toolCalls.length === 0 && !response.reasoning.trim();
    if (emptyReply && emptyRetries < MAX_EMPTY_RETRIES && !signal.aborted) {
      emptyRetries++;
      yield { type: "warning", text: "the model returned an empty reply; asking once more" };
      continue;
    }

    messages.push({
      role: "assistant",
      content: response.content || null,
      ...(response.toolCalls.length ? { tool_calls: response.toolCalls.map((call) => ({ ...call, type: "function" as const })) } : {}),
      ...(response.reasoning ? { reasoning_content: response.reasoning } : {}),
    });

    if (response.toolCalls.length === 0) {
      if (response.finishReason === "length" && continuations < MAX_CONTINUATIONS) {
        // A long file write or a long explanation was cut off at max_tokens.
        // The partial answer is already in the transcript; asking it to carry
        // on finishes the job instead of making the user type "continue".
        continuations++;
        yield { type: "warning", text: "the reply hit the max_tokens limit; continuing" };
        messages.push({ role: "user", content: "Continue exactly where you left off. Do not repeat what you already wrote." });
        continue;
      }
      if (response.finishReason === "length") {
        yield { type: "warning", text: "Response hit the max_tokens limit. Ask for a smaller step or raise maxTokens." };
      }
      // Anything typed while the model was writing has not been seen yet.
      // Ending the turn here used to leave it queued until the user typed
      // again, which both lost it and reordered it.
      const pending = options.drainQueue?.() ?? [];
      if (pending.length > 0 && !signal.aborted) {
        for (const text of pending) messages.push({ role: "user", content: text });
        yield { type: "queued_delivered", texts: pending };
        continue;
      }
      return finish(usage, "complete");
    }

    // tools — the pipeline owns tool UI (start/end/output) and the five stages.
    //
    // Every call in the assistant turn must get a tool message, even the ones
    // an interrupt stopped from running. A request whose tool_calls are not all
    // answered is rejected by most compatible endpoints on the next turn, which
    // turned a single Esc into a conversation that could no longer continue.
    const cancelledFrom = yield* runToolBatch(response.toolCalls, pipeline, signal, messages);
    if (cancelledFrom !== null) return finish(usage, "aborted");

    // Queued text joins the conversation at the tool boundary, which is the
    // only point where a user turn cannot split an assistant/tool pair.
    const delivered = options.drainQueue?.() ?? [];
    if (delivered.length > 0) {
      for (const text of delivered) messages.push({ role: "user", content: text });
      yield { type: "queued_delivered", texts: delivered };
    }
  }
}

/**
 * Run every call in one assistant turn, returning the index the batch was
 * cancelled at (or null when all of them ran).
 *
 * Independent reads run concurrently; a mutating call takes the batch
 * serialized. The bug this fixes was `for (const call of calls) await …` for
 * everything: five `read_file` calls took five round-trips of wall clock even
 * though none of them could observe the others. Order is preserved by writing
 * each result into a slot, never by waiting in sequence.
 */
async function* runToolBatch(
  calls: { id: string; function: { name: string; arguments: string } }[],
  pipeline: ToolPipeline,
  signal: AbortSignal,
  messages: ChatMessage[],
): AsyncGenerator<QueryEvent, number | null> {
  const tools = pipeline.available();

  for (let index = 0; index < calls.length; ) {
    if (signal.aborted) {
      for (let skipped = index; skipped < calls.length; skipped++) {
        messages.push({
          role: "tool",
          tool_call_id: calls[skipped].id,
          content: "Error: the turn was interrupted before this tool ran; the call was not executed.",
        });
      }
      return calls.length;
    }

    const call = calls[index];
    const tool = tools.find((candidate) => candidate.name === call.function.name);
    const batchable = tool ? (tool.parallelSafe ?? tool.readonly) : false;
    if (!batchable) {
      const outcome = await pipeline.run(call.function.name, call.function.arguments, signal);
      messages.push({ role: "tool", tool_call_id: call.id, content: outcome.content });
      index++;
      continue;
    }

    // A run of consecutive parallel-safe calls is one concurrent batch.
    let end = index + 1;
    while (end < calls.length) {
      const next = calls[end];
      const nextTool = tools.find((candidate) => candidate.name === next.function.name);
      if (!(nextTool ? (nextTool.parallelSafe ?? nextTool.readonly) : false)) break;
      end++;
    }
    const batch = calls.slice(index, end);
    // `run` turns a tool failure into tool content rather than rejecting, but a
    // bug that does throw must not leave the other results unaccounted for.
    const results = await Promise.all(
      batch.map((entry) =>
        pipeline
          .run(entry.function.name, entry.function.arguments, signal)
          .catch((err: unknown) => ({ ok: false, content: `Error: ${err instanceof Error ? err.message : String(err)}` })),
      ),
    );
    // Appended in call order, not completion order: the transcript and the
    // next request both depend on the assistant/tool pairing being stable.
    for (let offset = 0; offset < batch.length; offset++) {
      messages.push({ role: "tool", tool_call_id: batch[offset].id, content: results[offset].content });
    }
    if (signal.aborted) {
      for (let skipped = end; skipped < calls.length; skipped++) {
        messages.push({
          role: "tool",
          tool_call_id: calls[skipped].id,
          content: "Error: the turn was interrupted before this tool ran; the call was not executed.",
        });
      }
      return calls.length;
    }
    index = end;
  }
  return null;
}

function estimateTokensOf(messages: ChatMessage[]): number {
  return estimateTokens(messages);
}

type RequestOutcome =
  | { kind: "ok"; value: Awaited<ReturnType<ChatClient["chat"]>> }
  | { kind: "failed"; error: ClassifiedError }
  | { kind: "aborted"; partial: string };

/**
 * The messages a request actually sends: the conversation, led by the system
 * prompt. It is prepended here rather than stored, so a transcript restored
 * from disk (which has no system message) and a prompt rebuilt after a mode
 * change both reach the model without rewriting history.
 */
function requestMessages(options: QueryOptions): ChatMessage[] {
  const system = options.system?.().trim();
  if (!system) return options.messages;
  if (options.messages[0]?.role === "system") return options.messages;
  return [{ role: "system", content: system }, ...options.messages];
}

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
    let streamed = "";

    const request = client.chat(
      requestMessages(options),
      options.apiTools(),
      (delta) => {
        if (!started) {
          started = true;
          channel.push({ type: "assistant_start" });
        }
        streamed += delta;
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
    if (signal.aborted) return { kind: "aborted", partial: streamed };
    const classified = classifyError(failure, attempt);
    if (classified.level === "terminal" || attempt >= maxRetries) {
      return { kind: "failed", error: classified };
    }
    yield { type: "retry", attempt, delayMs: classified.retryAfterMs, message: classified.message };
    await sleep(classified.retryAfterMs, signal);
    if (signal.aborted) return { kind: "aborted", partial: streamed };
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
