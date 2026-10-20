/**
 * The context window popover: the parts must add up to the total.
 *
 * The chip showed "17%" and the popover one number, which told the user the
 * window was filling and nothing about what to do: compacting the
 * conversation, dropping an MCP server, and shrinking the project
 * instructions are three different fixes with three different numbers.
 * `contextBreakdown` is that split, and it has to stay consistent with the
 * single figure `contextUsage` reports or the popover contradicts the chip.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A temp config home: memory, project instructions and rules all live there.
const home = mkdtempSync(join(tmpdir(), "prometheus-breakdown-"));
process.env.PROMETHEUS_HOME = home;

const { Agent } = await import("../src/agent.ts");
const { Permissions } = await import("../src/permissions.ts");

test.after(() => {
  rmSync(home, { recursive: true, force: true });
});

class SilentUi {
  info() {}
  dim() {}
  warn() {}
  error() {}
  assistantText() {}
  assistantEnd() {}
  toolStart() {}
  toolEnd() {}
  thinking() {}
  thinkingEnd() {}
  todos() {}
  async confirm() {
    return "no" as const;
  }
  spinnerStart() {}
  spinnerStop() {}
}

function makeAgent(workspace: string) {
  const config = {
    baseUrl: "http://127.0.0.1:1/v1",
    apiKey: "k",
    model: "m",
    maxTokens: 1000,
    permissionMode: "auto" as const,
    contextWindow: 128000,
    maxTurns: 10,
    allowedDirs: [],
    autoApprove: [],
  };
  const client = { chat: async () => ({ content: "", reasoning: "", toolCalls: [], finishReason: "stop", usage: {} }) };
  const ui = new SilentUi();
  return new Agent(config, ui as never, client as never, undefined, new Permissions(config, ui as never), []);
}

test("the breakdown's parts sum to the total the chip shows", () => {
  const workspace = mkdtempSync(join(tmpdir(), "prometheus-breakdown-ws-"));
  const previous = process.cwd();
  process.chdir(workspace);
  try {
    const agent = makeAgent(workspace);
    agent.messages.push({ role: "user", content: "hello there ".repeat(200) });
    agent.messages.push({ role: "assistant", content: "an answer ".repeat(200) });
    agent.messages.push({ role: "tool", tool_call_id: "t1", content: "tool output ".repeat(400) });

    const breakdown = agent.contextBreakdown();
    const usage = agent.contextUsage();
    const sum = breakdown.parts.reduce((total, part) => total + part.tokens, 0);

    // The two figures come from the same estimators, so a difference means a
    // category is counted twice or dropped.
    assert.ok(
      Math.abs(sum - usage.tokens) <= Math.ceil(usage.tokens * 0.02),
      `parts (${sum}) and total (${usage.tokens}) disagree`,
    );
    assert.equal(breakdown.window, 128000);
    assert.ok(breakdown.percent > 0);
    assert.ok(breakdown.compactAt > 0 && breakdown.compactAt < breakdown.window, "compaction starts before the window ends");
  } finally {
    process.chdir(previous);
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("tool results are broken out from the rest of the conversation", () => {
  const workspace = mkdtempSync(join(tmpdir(), "prometheus-breakdown-ws-"));
  const previous = process.cwd();
  process.chdir(workspace);
  try {
    const agent = makeAgent(workspace);
    agent.messages.push({ role: "user", content: "short question" });
    agent.messages.push({ role: "tool", tool_call_id: "t1", content: "x".repeat(4000) });

    const breakdown = agent.contextBreakdown();
    const toolResults = breakdown.parts.find((part) => part.key === "toolResults");
    const messages = breakdown.parts.find((part) => part.key === "messages");
    assert.ok(toolResults, "tool results are a category of their own");
    assert.ok(messages, "the remaining conversation is another");
    // The only large content is the tool result, so it must dominate.
    assert.ok(toolResults!.tokens > messages!.tokens * 5);
  } finally {
    process.chdir(previous);
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("memory and project instructions are named rather than buried in the system prompt", () => {
  const workspace = mkdtempSync(join(tmpdir(), "prometheus-breakdown-ws-"));
  const previous = process.cwd();
  try {
    mkdirSync(join(home, "memory"), { recursive: true });
    writeFileSync(join(home, "memory", "global.md"), "### A remembered fact\n- a remembered fact ".repeat(50) + "\n");
    writeFileSync(join(workspace, "PROMETHEUS.md"), "# Project\n" + "- a rule for this project\n".repeat(60));
    process.chdir(workspace);

    const agent = makeAgent(workspace);
    const breakdown = agent.contextBreakdown();
    const keys = breakdown.parts.map((part) => part.key);
    assert.ok(keys.includes("memory"), "the memory file gets its own row");
    assert.ok(keys.includes("instructions"), "the project instructions get their own row");
    assert.equal(
      breakdown.parts.find((part) => part.key === "memory")?.label,
      "",
      "labels are supplied by the renderer, which is the only place that knows the locale",
    );
    assert.ok((breakdown.parts.find((part) => part.key === "instructions")?.tokens ?? 0) > 0);
  } finally {
    process.chdir(previous);
    rmSync(workspace, { recursive: true, force: true });
    rmSync(join(home, "memory"), { recursive: true, force: true });
  }
});
