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
    resume: { type: "string", short: "r" },
    "max-tokens": { type: "string" },
    "context-window": { type: "string" },
    "max-turns": { type: "string" },
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
  -r, --resume <session-id>   resume a saved session
      --max-tokens <n>        per-response token cap (default: 16000)
      --context-window <n>    context window for compaction (default: 128000)
      --max-turns <n>         tool-loop turn cap per message (default: 60)
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

let config;
try {
  config = loadConfig({
    model: values.model,
    baseUrl: values["base-url"],
    apiKey: values.key,
    permissionMode: mode,
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
  // One-shot mode.
  const { Agent } = await import("../src/agent.ts");
  const { TerminalUi } = await import("../src/ui.ts");
  const { ChatClient } = await import("../src/llm.ts");
  const ui = new TerminalUi();
  const client = new ChatClient({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    model: config.model,
    maxTokens: config.maxTokens,
    timeoutMs: 300_000,
  });
  const agent = new Agent(config, ui, client, undefined, undefined, session?.messages ?? []);
  try {
    await agent.run(positionals.join(" "));
  } catch (err) {
    ui.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
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
  process.exit(0);
}

const repl = new Repl({ config, session });
await repl.start();
process.exit(0);
