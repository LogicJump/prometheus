/** Context compaction: summarize older turns locally when the window fills up. */

import type { ChatMessage } from "../llm.ts";

const KEEP_RECENT_MESSAGES = 8;

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

export interface CompactionResult {
  messages: ChatMessage[];
  removed: number;
  summary: string;
}

/**
 * Build a deterministic local summary of old turns (no extra model call), then
 * keep a synthetic recap message plus the most recent messages. Compaction
 * points are aligned to turn boundaries: a `tool` message is never separated
 * from the assistant turn that requested it.
 */
export function compact(messages: ChatMessage[], contextWindow: number): CompactionResult | null {
  const budget = Math.floor(contextWindow * 0.75);
  return compactAt(messages, budget, Math.max(1, messages.length - KEEP_RECENT_MESSAGES));
}

/** Force a compaction regardless of the size, keeping the most recent messages. */
export function compactForce(messages: ChatMessage[]): ChatMessage[] {
  const result = compactAt(messages, 0, Math.max(1, messages.length - KEEP_RECENT_MESSAGES));
  return result?.messages ?? messages;
}

function compactAt(messages: ChatMessage[], budget: number, keepRecent: number): CompactionResult | null {
  if (estimateTokens(messages) <= budget) return null;

  const system = messages[0]?.role === "system" ? messages[0] : undefined;
  const rest = system ? messages.slice(1) : messages;
  if (rest.length <= 2) return null;

  // Walk back from the end keeping a recent window, then snap to a user boundary.
  let split = Math.max(1, Math.min(rest.length - 2, keepRecent));
  while (split > 0 && rest[split].role !== "user") split--;
  if (split <= 0) split = Math.max(1, rest.length - 2);

  const old = rest.slice(0, split);
  const recent = rest.slice(split);
  const summary = summarize(old);

  const recap: ChatMessage = {
    role: "user",
    content:
      `[Earlier context was compacted to save space. Recap of what happened:\n${summary}\n]\n\n` +
      `Continue from here. Do not repeat completed work; re-read files if you need their current contents.`,
  };
  const next: ChatMessage[] = system ? [system, recap, ...recent] : [recap, ...recent];
  return { messages: next, removed: old.length, summary };
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
