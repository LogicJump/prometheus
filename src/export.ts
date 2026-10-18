/**
 * Session export and crash markers.
 *
 * A saved session is a JSON file; export turns it into a readable markdown
 * transcript with tool calls folded into short lines, which is what people
 * actually paste into a review or a bug report.
 */

import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_HOME } from "./config.ts";
import type { ChatMessage } from "./types.ts";
import type { SessionFile } from "./sessions.ts";

const SUMMARY_LIMIT = 160;

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, SUMMARY_LIMIT);
}

function toolSummary(call: { function: { name: string; arguments: string } }): string {
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>;
  } catch {
    /* keep the raw name only */
  }
  const detail = args.path ?? args.command ?? args.pattern ?? args.prompt ?? "";
  return String(detail).slice(0, 140).replace(/\s+/g, " ");
}

/** Markdown transcript. System prompts and tool output bodies are omitted. */
export function sessionToMarkdown(session: SessionFile): string {
  const lines: string[] = [];
  lines.push(`# Prometheus session ${session.id}`);
  lines.push("");
  lines.push(`- Workspace: \`${session.cwd}\``);
  lines.push(`- Model: \`${session.model}\``);
  lines.push(`- Started: ${session.createdAt}`);
  lines.push(`- Updated: ${session.updatedAt}`);
  lines.push("");
  lines.push("---");
  lines.push("");

  let toolCount = 0;
  const messages = session.messages as ChatMessage[];  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (message.role === "system") continue;
    if (message.role === "user") {
      lines.push("## You");
      lines.push("");
      lines.push(String(message.content));
      lines.push("");
    } else if (message.role === "assistant") {
      const text = typeof message.content === "string" ? message.content.trim() : "";
      if (text) {
        lines.push("## Prometheus");
        lines.push("");
        lines.push(text);
        lines.push("");
      }
      const calls = message.tool_calls ?? [];
      if (calls.length > 0) {
        toolCount += calls.length;
        lines.push("<details><summary>Tool calls</summary>");
        lines.push("");
        for (const call of calls) {
          lines.push(`- \`${call.function.name}\` ${toolSummary(call)}`);
        }
        lines.push("");
        // The tool results follow this assistant message in order.
        let looked = index + 1;
        while (looked < messages.length && messages[looked].role === "tool") {
          const content = String((messages[looked] as { content: string }).content ?? "");
          lines.push(`  - ↳ ${oneLine(content) || "(no output)"}`);
          looked += 1;
        }
        lines.push("");
        lines.push("</details>");
        lines.push("");
        index = looked - 1;
      }
    }
  }
  if (toolCount > 0) {
    // The details blocks above already carry the calls; nothing else to add.
  }
  return `${lines.join("\n").trim()}\n`;
}

/** A filesystem-safe name for the export dialog. */
export function exportFilename(session: SessionFile): string {
  const stamp = session.createdAt.replace(/[:T]/g, "-").replace(/\..+/, "");
  return `prometheus-${stamp}.md`;
}

interface ActiveMarker {
  sessionId: string;
  cwd: string;
  startedAt: string;
}

function activeFile(): string {
  return join(CONFIG_HOME, "active-run.json");
}

/** Record that a turn is running, so an unclean exit can be detected. */
export function markRunActive(marker: ActiveMarker): void {
  try {
    writeFileSync(activeFile(), JSON.stringify(marker), "utf8");
  } catch {
    /* best effort */
  }
}

export function clearRunActive(): void {
  try {
    rmSync(activeFile(), { force: true });
  } catch {
    /* best effort */
  }
}

/** The interrupted run's session id, if the previous process died mid-turn. */
export function findInterruptedRun(cwd: string): ActiveMarker | null {
  const file = activeFile();
  if (!existsSync(file)) return null;
  try {
    const marker = JSON.parse(readFileSync(file, "utf8")) as ActiveMarker;
    rmSync(file, { force: true });
    if (marker.cwd !== cwd) return null;
    return marker;
  } catch {
    return null;
  }
}
