/**
 * Context compaction: three progressive levels.
 *
 * Trim is local and free. Summarize asks the model when a summarizer is
 * supplied; without one it falls back to a deterministic local recap. Neither
 * path may drop the original goal — a long session that forgets why it started
 * is the most expensive bug in an agent.
 */

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

/**
 * Estimate the tokens a piece of text costs.
 *
 * Four characters per token is the rule of thumb for English prose. CJK text
 * is not four characters per token — a Chinese character is commonly one token
 * on its own, and at worst two bytes of a merged token — so the ASCII ratio
 * under-counted it by 2–4x. The conversation then looked half as long as it
 * was and compaction ran too late.
 */
export function estimateTextTokens(text: string): number {
  let ascii = 0;
  let wide = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    // CJK ideographs, kana, hangul, full-width forms and the CJK punctuation
    // that travels with them.
    if (
      (code >= 0x1100 && code <= 0x11ff) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xa960 && code <= 0xa97f) ||
      (code >= 0xac00 && code <= 0xd7ff) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe10 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xffef) ||
      (code >= 0x1f200 && code <= 0x1f2ff) ||
      (code >= 0x20000 && code <= 0x3ffff)
    ) {
      wide++;
    } else {
      ascii++;
    }
  }
  return ascii / 4 + wide;
}

/**
 * Cut a long tool output down to a budget, keeping the head and the tail.
 *
 * The tail is where a compiler puts its error summary and a test runner puts
 * its failures, and the old head-only cut threw exactly that away. The marker
 * says how much was dropped so the model knows it is not seeing everything.
 */
export function trimToolOutput(text: string, limit = 30_000): string {
  if (text.length <= limit) return text;
  const keep = Math.floor((limit - 200) / 2);
  const head = text.slice(0, keep);
  const tail = text.slice(text.length - keep);
  const omitted = text.length - head.length - tail.length;
  return `${head}\n\n[… ${omitted} characters omitted; showing the start and the end …]\n\n${tail}`;
}

/** Rough token estimate: ~4 characters per ASCII token, ~1 per CJK character, plus overhead per message. */
export function estimateTokens(messages: ChatMessage[]): number {
  let total = 0;
  for (const message of messages) {
    if (typeof message.content === "string") total += estimateTextTokens(message.content);
    else if (Array.isArray(message.content)) {
      // An image costs roughly the same as a thousand words regardless of size.
      for (const part of message.content) {
        total += part.type === "text" ? estimateTextTokens(part.text) : 800;
      }
    }
    if (message.role === "assistant" && message.tool_calls) {
      for (const call of message.tool_calls) {
        total += estimateTextTokens(call.function.name) + estimateTextTokens(call.function.arguments) + 8;
      }
    }
    total += 6;
  }
  return Math.ceil(total);
}

export type CompactionLevel = "trim" | "summarize" | "aggressive" | "local-fallback";

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

/** Cheap pre-check: will `compactWithModel` do anything at this size? */
export function needsCompaction(messages: ChatMessage[], contextWindow: number): boolean {
  return estimateTokens(messages) > Math.floor(contextWindow * BUDGET_RATIO);
}

export interface CompactOptions {
  /** Ask the model for the recap. Without it the local keyword recap is used. */
  summarize: (old: ChatMessage[], localSummary: string, focus?: string) => Promise<string>;
  signal?: AbortSignal;
  /**
   * Lines re-injected after the recap. Compaction drops the parts of the
   * context that are cheapest to rebuild — the plan, the files in play, the
   * project rules — and the model otherwise loses them silently.
   */
  rehydrate?: () => string;
  /** What the user wants this recap to concentrate on (`/compact <focus>`). */
  focus?: string;
  /**
   * Compact even when the conversation fits. `/compact` is an explicit
   * request, not a reaction to size, so it must not become a no-op.
   */
  force?: boolean;
}

/**
 * Model-assisted compaction.
 *
 * Level 1 (trim) drops the oldest turns but keeps a recap of what it dropped,
 * so the original goal survives — the first version returned the trimmed
 * transcript with the literal summary "(oldest turns trimmed)", and a long
 * session forgot why it had started. Levels 2-3 need a full summary, and a
 * keyword recap loses the reasons behind decisions, so the caller supplies a
 * model-backed `summarize`. Any failure falls back to the local recap; the
 * result names which path ran so the UI can say so.
 */
export async function compactWithModel(
  messages: ChatMessage[],
  contextWindow: number,
  options: CompactOptions,
): Promise<CompactionResult | null> {
  const budget = options.force ? 0 : Math.floor(contextWindow * BUDGET_RATIO);
  const before = estimateTokens(messages);
  if (!options.force && before <= budget) return null;

  const system = messages[0]?.role === "system" ? messages[0] : undefined;
  const rest = system ? messages.slice(1) : messages;
  if (rest.length <= 2) return null;
  const restored = safeRehydrate(options.rehydrate);

  // A forced compaction still wants a recent window to keep verbatim; budget 0
  // only means "the trim candidate is not acceptable on size alone".
  if (!options.force) {
    const trimSplit = splitPoint(rest, TRIM_KEEP);
    if (trimSplit > 0) {
      const dropped = rest.slice(0, trimSplit);
      const recap = trimRecap(dropped, restored);
      const candidate: ChatMessage[] = system ? [system, recap, ...rest.slice(trimSplit)] : [recap, ...rest.slice(trimSplit)];
      if (estimateTokens(candidate) <= budget) {
        return result(candidate, trimSplit, "trim", String(recap.content), before);
      }
    }
  }

  // 2/3. summarize with the model
  const summarizeSplit = splitPoint(rest, SUMMARIZE_KEEP);
  const old = rest.slice(0, summarizeSplit);
  const recent = rest.slice(summarizeSplit);
  const local = summarize(old);
  let summary = local;
  let level: CompactionLevel = "summarize";
  try {
    if (!options.signal?.aborted) {
      const generated = (await options.summarize(old, local, options.focus)).trim();
      if (generated.length > 0) summary = generated;
      else level = "local-fallback";
    } else {
      level = "local-fallback";
    }
  } catch {
    level = "local-fallback";
  }

  const recap = recapMessage(summary, restored, options.focus);
  const summarized: ChatMessage[] = system ? [system, recap, ...recent] : [recap, ...recent];
  if (estimateTokens(summarized) <= budget || options.force) {
    return result(summarized, old.length, level, summary, before);
  }

  const aggressiveSplit = splitPoint(recent, AGGRESSIVE_KEEP);
  const clipped = recent.slice(aggressiveSplit).map(clipMessage);
  const aggressiveRecap = recapMessage(summary, restored, options.focus);
  const aggressive: ChatMessage[] = system ? [system, aggressiveRecap, ...clipped] : [aggressiveRecap, ...clipped];
  return result(aggressive, old.length + aggressiveSplit, "aggressive", summary, before);
}

/**
 * Build the transcript the summarizer sees: text plus clipped tool results.
 *
 * The budget is split between the start and the end. Concatenating from the
 * first message and stopping at `maxChars` silently dropped the *later* part
 * of the segment being compacted — which is where the most recent decisions
 * live. A summary that knows the first request but not the last decision makes
 * the model re-propose what was already rejected. So the earliest messages get
 * a small share (enough for the goal) and the rest goes to the tail.
 */
export function summarizerInput(messages: ChatMessage[], maxChars = 60_000): string {
  const lines: string[] = [];
  for (const message of messages) {
    let line = "";
    if (message.role === "user") {
      const text = typeof message.content === "string"
        ? message.content
        : message.content.filter((part) => part.type === "text").map((part) => part.text).join(" ");
      line = `USER: ${text}`;
    } else if (message.role === "assistant") {
      const text = typeof message.content === "string" ? message.content : "";
      const calls = (message.tool_calls ?? []).map((call) => `${call.function.name}(${call.function.arguments.slice(0, 400)})`);
      line = `ASSISTANT: ${text}${calls.length ? `\n  tools: ${calls.join("; ")}` : ""}`;
    } else if (message.role === "tool") {
      const body = String(message.content);
      line = `TOOL RESULT: ${body.length > 4_000 ? `${body.slice(0, 4_000)} [...${body.length - 4_000} chars clipped]` : body}`;
    }
    if (line) lines.push(line);
  }
  if (lines.length === 0) return "";

  const total = lines.reduce((sum, line) => sum + line.length + 2, 0);
  if (total <= maxChars) return lines.join("\n\n");

  // 20% for the opening (the goal), 80% for the newest part (the decisions).
  const headBudget = Math.floor(maxChars * 0.2);
  const tailBudget = maxChars - headBudget;

  const head: string[] = [];
  let used = 0;
  let headEnd = 0;
  for (; headEnd < lines.length; headEnd++) {
    const cost = lines[headEnd].length + 2;
    if (used + cost > headBudget) break;
    head.push(lines[headEnd]);
    used += cost;
  }

  const tail: string[] = [];
  let tailUsed = 0;
  let tailStart = lines.length;
  while (tailStart > headEnd) {
    const cost = lines[tailStart - 1].length + 2;
    if (tailUsed + cost > tailBudget) break;
    tailStart--;
    tail.push(lines[tailStart]);
    tailUsed += cost;
  }
  tail.reverse();

  const omitted = tailStart - headEnd;
  if (omitted > 0) {
    // Say what was cut, so the summarizer does not believe it saw everything.
    head.push(`[... ${omitted} message(s) between these two parts were not shown ...]`);
  }
  return [...head, ...tail].join("\n\n");
}

/** The prompt the summarizer model answers. */
export const SUMMARIZE_PROMPT = `Summarize the earlier part of a coding session so the agent can continue without it.
Use short markdown sections and keep every fact needed to continue:
- Goal: what the user asked for.
- Decisions: choices made and why; reject approaches only if the reason still matters.
- Files: paths changed and what changed in each; paths read only if still relevant.
- Commands: what was run and its result (tests failing, build errors).
- Open items: what is unfinished or uncertain, and the next concrete step.
Do not invent anything. Do not repeat the transcript. Aim for 200-400 words.`;

/** Force a compaction regardless of size (the local fallback for /compact). */
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

  // 1. trim — keep a recap of what was dropped, so the goal survives.
  const trimSplit = splitPoint(rest, TRIM_KEEP);
  if (trimSplit > 0) {
    // Keep the first kept message a user turn so the conversation stays valid.
    const dropped = rest.slice(0, trimSplit);
    const recap = trimRecap(dropped, "");
    const candidate: ChatMessage[] = system ? [system, recap, ...rest.slice(trimSplit)] : [recap, ...rest.slice(trimSplit)];
    if (estimateTokens(candidate) <= budget) {
      return result(candidate, trimSplit, "trim", String(recap.content), before);
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

function recapMessage(summary: string, rehydrate = "", focus?: string): ChatMessage {
  const restored = rehydrate.trim() ? `\n\nStill in effect:\n${rehydrate.trim()}` : "";
  const asked = focus?.trim() ? `\n\nFocus asked for: ${focus.trim().slice(0, 500)}` : "";
  return {
    role: "user",
    content:
      `[Earlier context was compacted to save space. Recap of what happened:\n${summary}\n]${restored}${asked}\n\n` +
      `Continue from here. Do not repeat completed work; re-read files if you need their current contents.`,
  };
}

/**
 * The recap a trim carries.
 *
 * Trim used to leave nothing behind but "(oldest turns trimmed)". The turns it
 * drops are exactly the ones holding the original request and the decisions
 * made so far, so the model came back to a long session without knowing why it
 * existed. The local keyword recap is cheap and keeps those facts; the dropped
 * segment is bounded by TRIM_KEEP so this stays a small message.
 */
function trimRecap(dropped: ChatMessage[], rehydrate: string): ChatMessage {
  return recapMessage(summarize(dropped), rehydrate);
}

function safeRehydrate(rehydrate?: () => string): string {
  if (!rehydrate) return "";
  try {
    return rehydrate().slice(0, 4000);
  } catch {
    return "";
  }
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
  // The first request is the goal. A recap built only from "the last eight
  // requests" loses it, and an agent that no longer knows why it is working
  // drifts or declares victory early.
  if (requests.length) parts.push(`Original goal: ${requests[0]}`);
  if (requests.length > 1) parts.push(`Later requests: ${requests.slice(1, 9).join(" | ")}`);
  if (filesChanged.size) parts.push(`Files written: ${[...filesChanged].slice(0, 30).join(", ")}`);
  if (filesRead.size) parts.push(`Files inspected: ${[...filesRead].slice(0, 30).join(", ")}`);
  if (commands.length) parts.push(`Commands run: ${commands.slice(-10).join(" ; ")}`);
  return parts.join("\n") || "(no durable details)";
}
