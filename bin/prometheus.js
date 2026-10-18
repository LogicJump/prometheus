#!/usr/bin/env node
// @ts-nocheck -- JavaScript entry point; the typed implementation lives in src/.

import { parseArgs } from "node:util";
import { loadConfig } from "../src/config.ts";
import { loadSession } from "../src/sessions.ts";
import { Repl } from "../src/repl.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    model: { type: "string", short: "m" },
    "base-url": { type: "string" },
    key: { type: "string" },
    mode: { type: "string" },
    effort: { type: "string" },
    resume: { type: "string", short: "r" },
    "max-tokens": { type: "string" },
    "context-window": { type: "string" },
    "max-turns": { type: "string" },
    "output-format": { type: "string" },
    "output-schema": { type: "string" },
    "max-budget-usd": { type: "string" },
    help: { type: "boolean", short: "h" },
    version: { type: "boolean", short: "v" },
  },
});

if (values.help) {
  console.log(`Prometheus - a general-purpose terminal coding agent

Usage:
  prometheus [options] [prompt]

Options:
  -m, --model <name>          model id (default: $PROMETHEUS_MODEL or gpt-4o)
      --base-url <url>        OpenAI-compatible base URL (default: $OPENAI_BASE_URL or https://api.openai.com/v1)
      --key <key>             API key (default: $OPENAI_API_KEY)
      --mode <mode>           ask | auto | plan (default: ask)
      --effort <level>        thinking effort: auto | low | medium | high
  -r, --resume <session-id>   resume a saved session
      --max-tokens <n>        per-response token cap (default: 16000)
      --context-window <n>    context window for compaction (default: 128000)
      --max-turns <n>         tool-loop turn cap per message (default: 60)
      --output-format <fmt>   text (default) | json | stream-json
      --output-schema <file>  validate the final JSON against a JSON Schema
      --max-budget-usd <n>    stop before a turn that would exceed this spend
  -h, --help                  show this help
  -v, --version               show the version

If [prompt] is given, runs one turn and exits. Otherwise starts the interactive REPL.

Examples:
  prometheus "add tests for src/parser.ts"
  prometheus --mode plan "how does auth work here?"
  prometheus -r 20261017-193000-ab12
  prometheus --model deepseek-chat --base-url https://api.deepseek.com/v1
`);
  process.exit(0);
}

if (values.version) {
  console.log("prometheus 0.1.0");
  process.exit(0);
}

const mode = values.mode;
if (mode && mode !== "ask" && mode !== "auto" && mode !== "plan") {
  console.error(`Invalid --mode "${mode}". Use ask, auto, or plan.`);
  process.exit(2);
}

const effort = values.effort;
if (effort && !["auto", "low", "medium", "high"].includes(effort)) {
  console.error(`Invalid --effort "${effort}". Use auto, low, medium, or high.`);
  process.exit(2);
}

const outputFormat = values["output-format"] ?? "text";
if (!["text", "json", "stream-json"].includes(outputFormat)) {
  console.error(`Invalid --output-format "${outputFormat}". Use text, json, or stream-json.`);
  process.exit(2);
}

const maxBudget = values["max-budget-usd"] ? Number(values["max-budget-usd"]) : null;
if (maxBudget !== null && !(maxBudget > 0)) {
  console.error("--max-budget-usd must be a positive number.");
  process.exit(2);
}

let config;
try {
  config = loadConfig({
    model: values.model,
    baseUrl: values["base-url"],
    apiKey: values.key,
    permissionMode: mode,
    thinkingEffort: effort,
    maxTokens: values["max-tokens"] ? Number(values["max-tokens"]) : undefined,
    contextWindow: values["context-window"] ? Number(values["context-window"]) : undefined,
    maxTurns: values["max-turns"] ? Number(values["max-turns"]) : undefined,
  });
} catch (err) {
  console.error(`prometheus: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

let session = null;
if (values.resume) {
  session = loadSession(values.resume);
  if (!session) {
    console.error(`prometheus: session not found: ${values.resume}`);
    process.exit(1);
  }
}

if (positionals.length > 0) {
  // One-shot mode. `text` keeps the terminal UI; the JSON formats swap in a UI
  // that emits events instead of drawing them, so the same turn can be consumed
  // by a script without parsing ANSI output.
  const { Agent } = await import("../src/agent.ts");
  const { ChatClient } = await import("../src/llm.ts");
  const headless = outputFormat !== "text";
  const ui = headless
    ? new (await import("../src/headless.ts")).JsonUi({ stream: outputFormat === "stream-json" })
    : new (await import("../src/ui.ts")).TerminalUi();
  const client = new ChatClient({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    model: config.model,
    maxTokens: config.maxTokens,
    reasoningEffort: config.thinkingEffort,
    timeoutMs: 300_000,
  });
  const agent = new Agent(config, ui, client, undefined, undefined, session?.messages ?? []);

  // A budget check runs between turns: the agent's counters are live, so a run
  // that has already spent its allowance stops before starting more work.
  if (maxBudget !== null) {
    const { costOf } = await import("../src/pricing.ts");
    let lastCost = 0;
    const originalRun = agent.run.bind(agent);
    agent.run = async (text) => {
      const before = { ...agent.usage };
      await originalRun(text);
      const spent = costOf(config.model, {
        inputTokens: agent.usage.inputTokens - before.inputTokens,
        outputTokens: agent.usage.outputTokens - before.outputTokens,
        cachedTokens: agent.usage.cachedTokens - before.cachedTokens,
      });
      lastCost = (lastCost ?? 0) + (spent ?? 0);
      if (lastCost > maxBudget) {
        throw new Error(`stopped: this run has spent about $${lastCost.toFixed(4)}, over the $${maxBudget} budget`);
      }
    };
  }

  let failure = null;
  try {
    await agent.run(positionals.join(" "));
  } catch (err) {
    failure = err instanceof Error ? err.message : String(err);
    ui.error(failure);
  }

  const { saveSession } = await import("../src/sessions.ts");
  saveSession({
    id: session?.id ?? `oneshot-${Date.now()}`,
    cwd: process.cwd(),
    model: config.model,
    baseUrl: config.baseUrl,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    messages: agent.messages.filter((m) => m.role !== "system"),
  });

  if (headless) {
    const finalText = [...agent.messages]
      .reverse()
      .find((message) => message.role === "assistant" && typeof message.content === "string" && message.content.trim());
    const payload = {
      type: "result",
      ok: !failure,
      text: typeof finalText?.content === "string" ? finalText.content : "",
      usage: agent.usage,
      cost: (await import("../src/pricing.ts")).costOf(config.model, agent.usage),
      sessionId: session?.id ?? null,
      ...(failure ? { error: failure } : {}),
      events: ui.events,
    };
    if (values["output-schema"]) {
      const { validateAgainstSchema, readSchema } = await import("../src/schema.ts");
      const check = validateAgainstSchema(payload.text, readSchema(values["output-schema"]));
      payload.schemaValid = check.valid;
      if (!check.valid) payload.schemaError = check.error;
    }
    process.stdout.write(`${JSON.stringify(payload)}
`);
  }
  process.exit(failure ? 1 : 0);
}

const repl = new Repl({ config, session });
await repl.start();
process.exit(0);
