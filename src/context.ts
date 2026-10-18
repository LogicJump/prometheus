/** Context compaction: three progressive levels, all local (no extra model call). */

import type { ChatMessage } from "./types.ts";

/**
 * Compaction runs in three escalating levels and stops as soon as the
 * conversation fits:
 *
 *   1. trim        drop the oldest complete turns, keep a generous recent
 *                  window. Nothing is lost except the oldest transcript;
 *                  recent tool results stay intact.
 *   2. summarize   replace everything before the recent window with a
 *                  deterministic recap (requests, files, commands) plus the
 *                  most recent messages.
 *   3. aggressive  for conversations whose recent tool output alone overflows
 *                  the window: shrink the window further and clip oversized
 *                  tool payloads. This is the last resort before the request
 *                  would be rejected.
 */

const BUDGET_RATIO = 0.75;
const TRIM_KEEP = 24;
const SUMMARIZE_KEEP = 8;
const AGGRESSIVE_KEEP = 4;
const CLIP_CHARS = 4_000;

/** Rough token estimate: ~4 characters per token, plus overhead per message. */
export function estimateTokens(messages: ChatMessage[]): number {
  let total = 0;
  for (const message of messages) {
    if (typeof message.content === "string") total += message.content.length / 4;
    else if (Array.isArray(message.content)) {
      // An image costs roughly the same as a thousand words regardless of size.
      for (const part of message.content) {
        total += part.type === "text" ? part.text.length / 4 : 800;
      }
    }
    if (message.role === "assistant" && message.tool_calls) {
      for (const call of message.tool_calls) {
        total += call.function.name.length / 4 + call.function.arguments.length / 4 + 8;
      }
    }
    total += 6;
  }
  return Math.ceil(total);
}

export type CompactionLevel = "trim" | "summarize" | "aggressive";

export interface CompactionResult {
  messages: ChatMessage[];
  removed: number;
  summary: string;
  level: CompactionLevel;
  before: number;
  after: number;
}

/** Compact when over budget; returns null when the conversation already fits. */
export function compact(messages: ChatMessage[], contextWindow: number): CompactionResult | null {
  return compactAt(messages, Math.floor(contextWindow * BUDGET_RATIO));
}

/** Force a compaction regardless of size (the /compact command). */
export function compactForce(messages: ChatMessage[]): ChatMessage[] {
  const result = compactAt(messages, 0);
  return result?.messages ?? messages;
}

function compactAt(messages: ChatMessage[], budget: number): CompactionResult | null {
  const before = estimateTokens(messages);
  if (before <= budget) return null;

  const system = messages[0]?.role === "system" ? messages[0] : undefined;
  const rest = system ? messages.slice(1) : messages;
  if (rest.length <= 2) return null;

  // 1. trim
  const trimSplit = splitPoint(rest, TRIM_KEEP);
  if (trimSplit > 0) {
    // Keep the first kept message a user turn so the conversation stays valid.
    const candidate: ChatMessage[] = system ? [system, ...rest.slice(trimSplit)] : rest.slice(trimSplit);
    if (estimateTokens(candidate) <= budget) {
      return result(candidate, trimSplit, "trim", "(oldest turns trimmed)", before);
    }
  }

  // 2. summarize
  const summarizeSplit = splitPoint(rest, SUMMARIZE_KEEP);
  const old = rest.slice(0, summarizeSplit);
  const recent = rest.slice(summarizeSplit);
  const summary = summarize(old);
  const recap = recapMessage(summary);
  const summarized: ChatMessage[] = system ? [system, recap, ...recent] : [recap, ...recent];
  if (estimateTokens(summarized) <= budget || budget === 0) {
    return result(summarized, old.length, "summarize", summary, before);
  }

  // 3. aggressive - the recent window itself is too large
  const aggressiveSplit = splitPoint(recent, AGGRESSIVE_KEEP);
  const clipped = recent.slice(aggressiveSplit).map(clipMessage);
  const aggressive: ChatMessage[] = system ? [system, recapMessage(summary), ...clipped] : [recapMessage(summary), ...clipped];
  return result(aggressive, old.length + aggressiveSplit, "aggressive", summary, before);
}

function result(
  messages: ChatMessage[],
  removed: number,
  level: CompactionLevel,
  summary: string,
  before: number,
): CompactionResult {
  return { messages, removed, level, summary, before, after: estimateTokens(messages) };
}

/**
 * Index in `messages` where the kept window starts, snapped forward to a user
 * boundary so a tool result is never separated from its assistant turn.
 */
function splitPoint(messages: ChatMessage[], keep: number): number {
  let split = Math.max(0, messages.length - keep);
  while (split < messages.length && messages[split].role !== "user") split++;
  return split >= messages.length ? Math.max(0, messages.length - 2) : split;
}

function recapMessage(summary: string): ChatMessage {
  return {
    role: "user",
    content:
      `[Earlier context was compacted to save space. Recap of what happened:\n${summary}\n]\n\n` +
      `Continue from here. Do not repeat completed work; re-read files if you need their current contents.`,
  };
}

function clipMessage(message: ChatMessage): ChatMessage {
  if (message.role !== "tool" || typeof message.content !== "string" || message.content.length <= CLIP_CHARS) {
    return message;
  }
  const omitted = message.content.length - CLIP_CHARS;
  return { ...message, content: `${message.content.slice(0, CLIP_CHARS)}\n[… ${omitted} characters clipped by compaction]` };
}

function summarize(messages: ChatMessage[]): string {
  const filesRead = new Set<string>();
  const filesChanged = new Set<string>();
  const commands: string[] = [];
  const requests: string[] = [];

  for (const message of messages) {
    if (message.role === "user") {
      const raw = typeof message.content === "string"
        ? message.content
        : message.content.filter((part) => part.type === "text").map((part) => part.text).join(" ");
      const text = raw.replace(/\s+/g, " ").trim();
      if (text && !text.startsWith("[") && !text.startsWith("attached image")) requests.push(text.slice(0, 160));
    }
    if (message.role === "assistant" && message.tool_calls) {
      for (const call of message.tool_calls) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>;
        } catch {
          continue;
        }
        const path = typeof args.path === "string" ? args.path : "";
        switch (call.function.name) {
          case "read_file":
          case "grep":
          case "glob":
          case "list_files":
            if (path) filesRead.add(path);
            break;
          case "write_file":
          case "edit_file":
            if (path) filesChanged.add(path);
            break;
          case "bash":
            if (typeof args.command === "string") commands.push(args.command.slice(0, 120));
            break;
        }
      }
    }
  }

  const parts: string[] = [];
  if (requests.length) parts.push(`User requests: ${requests.slice(-8).join(" | ")}`);
  if (filesChanged.size) parts.push(`Files written: ${[...filesChanged].slice(0, 30).join(", ")}`);
  if (filesRead.size) parts.push(`Files inspected: ${[...filesRead].slice(0, 30).join(", ")}`);
  if (commands.length) parts.push(`Commands run: ${commands.slice(-10).join(" ; ")}`);
  return parts.join("\n") || "(no durable details)";
}
