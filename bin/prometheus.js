#!/usr/bin/env node
// @ts-nocheck -- JavaScript entry point; the typed implementation lives in src/.

import { parseArgs } from "node:util";
import { loadConfig } from "../src/config.ts";
import { loadSession, latestSession } from "../src/sessions.ts";
import { acquireSessionLock, releaseSessionLock, lockConflictMessage } from "../src/sessionLock.ts";
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
    "allowed-tools": { type: "string" },
    "dont-ask": { type: "boolean" },
    continue: { type: "boolean", short: "c" },
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
  -c, --continue              resume the most recent session in this directory
      --max-tokens <n>        per-response token cap (default: 16000)
      --context-window <n>    context window for compaction (default: 128000)
      --max-turns <n>         tool-loop turn cap per message (default: 60)
      --output-format <fmt>   text (default) | json | stream-json
      --output-schema <file>  validate the final JSON against a JSON Schema
      --max-budget-usd <n>    stop before a turn that would exceed this spend
      --allowed-tools <list>  comma-separated tools approved without asking in a non-interactive run
      --dont-ask              approve every tool in a non-interactive run (dangerous; use in a sandbox)
  -h, --help                  show this help
  -v, --version               show the version

If [prompt] is given, runs one turn and exits. Otherwise starts the interactive REPL.

A one-shot run has nobody to answer a permission prompt. A tool that would ask
is refused with a reason naming --allowed-tools; it does not block waiting for
input that will never come.

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

// A resumed session carries its own settings; an explicit flag still wins.
// Restoring a plan-mode investigation as auto mode was the kind of silent
// change that makes a session feel like a different agent.
if (values.resume && values.continue) {
  console.error("prometheus: use either --resume or --continue, not both.");
  process.exit(2);
}
let session = values.continue ? latestSession(process.cwd()) : null;
if (values.continue && !session) {
  console.error(`prometheus: no saved session in ${process.cwd()}`);
  process.exit(1);
}
if (values.resume) {
  session = loadSession(values.resume);
  if (!session) {
    console.error(`prometheus: session not found: ${values.resume}`);
    process.exit(1);
  }
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
const { parseToolList } = await import("../src/config.ts");
try {
  config = loadConfig({
    model: values.model,
    baseUrl: values["base-url"],
    apiKey: values.key,
    permissionMode: mode ?? session?.mode,
    thinkingEffort: effort ?? session?.effort,
    maxTokens: values["max-tokens"] ? Number(values["max-tokens"]) : undefined,
    contextWindow: values["context-window"] ? Number(values["context-window"]) : undefined,
    maxTurns: values["max-turns"] ? Number(values["max-turns"]) : undefined,
    ...(values["allowed-tools"] !== undefined ? { autoApprove: parseToolList(values["allowed-tools"]) } : {}),
  });
} catch (err) {
  console.error(`prometheus: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

// A one-shot run exits after one turn, so it has no one to answer a prompt:
// the process used to stop dead on the question with stdin ignored. Saying so
// up front turns that hang into a refusal that names the flag which grants it.
if (positionals.length > 0) {
  config = {
    ...config,
    unattended: true,
    ...(values["dont-ask"] ? { autoApprove: ["*"] } : {}),
  };
}

if (session) {
  // A session already open elsewhere is not resumed here: two writers appending
  // to one transcript interleave their messages. The desktop window holds the
  // lock while it has the session open.
  const claim = acquireSessionLock(session.id, "terminal");
  if (!claim.ok) {
    console.error(`prometheus: ${lockConflictMessage(session.id, claim.holder)}`);
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
    echoReasoning: config.echoReasoning,
    timeoutMs: 300_000,
  });
  const { Permissions } = await import("../src/permissions.ts");
  const permissions = new Permissions(config, ui);
  const agent = new Agent(config, ui, client, undefined, permissions, session?.messages ?? []);
  // The session id is decided before the run, not after: a tool result that is
  // too long is written beside the transcript, and the path it reports has to
  // still resolve once the session is saved under that same id.
  const oneShotId = session?.id ?? `oneshot-${Date.now()}`;
  agent.sessionId = oneShotId;

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
  try {
    saveSession({
      id: oneShotId,
      cwd: process.cwd(),
      model: config.model,
      baseUrl: config.baseUrl,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages: agent.messages.filter((m) => m.role !== "system"),
      mode: config.permissionMode,
      effort: config.thinkingEffort,
      sandbox: config.sandbox,
      networkPolicy: config.networkPolicy,
      board: config.board,
    });
  } catch (err) {
    ui.error(`could not save session: ${err.message}`);
  }
  // A one-shot run used to leave no usage record at all, so every CI job and
  // every script vanished from the Usage page while the desktop window
  // accounted for itself. The record is split by who spent the tokens, which
  // is the only thing that makes a `delegate`-heavy run auditable.
  const { recordUsage } = await import("../src/usage.ts");
  for (const [source, usage] of Object.entries(agent.usageBySource)) {
    if (usage.inputTokens === 0 && usage.outputTokens === 0) continue;
    recordUsage({
      sessionId: oneShotId,
      cwd: process.cwd(),
      model: agent.lastUsedModel || config.model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cachedTokens: usage.cachedTokens,
      source,
    });
  }
  if (session) releaseSessionLock(session.id);

  // Stop the spinner before anything prints a result or exits.
  ui.spinnerStop();
  ui.assistantEnd();
  ui.thinkingEnd();
  ui.dispose?.();

  // A turn that "completed" while every tool it tried was refused did not do
  // the job it was given. Saying so in the exit code lets a script branch on
  // it instead of parsing the answer.
  const refused = permissions.deniedWithoutApproval > 0;
  let exitCode = failure || refused ? 1 : 0;
  if (headless) {
    const finalText = [...agent.messages]
      .reverse()
      .find((message) => message.role === "assistant" && typeof message.content === "string" && message.content.trim());
    const payload = {
      type: "result",
      ok: !failure,
      text: typeof finalText?.content === "string" ? finalText.content : "",
      usage: agent.usage,
      cost: (await import("../src/pricing.ts")).costOf(agent.lastUsedModel || config.model, agent.usage),
      sessionId: oneShotId,
      ...(failure ? { error: failure } : {}),
      ...(refused ? { refusedTools: permissions.deniedWithoutApproval } : {}),
      events: ui.events,
    };
    if (values["output-schema"]) {
      const { validateAgainstSchema, readSchema } = await import("../src/schema.ts");
      const check = validateAgainstSchema(payload.text, readSchema(values["output-schema"]));
      payload.schemaValid = check.valid;
      if (!check.valid) {
        payload.schemaError = check.error;
        // A caller asked for a shape and did not get it. Exiting zero would
        // tell the script that wrapped this run that the answer is usable.
        exitCode = 1;
      }
    }
    await new Promise((resolve) => process.stdout.write(`${JSON.stringify(payload)}\n`, () => resolve()));
  }
  await exitAfterFlush(exitCode);
}

/**
 * Exit with a code without calling `process.exit()` while fetch is in flight.
 *
 * Node 24.15 on Windows asserts (`uv async.c:76`) when `process.exit()` runs
 * after two or more `fetch()` calls: undici's keep-alive sockets are still
 * closing on the event loop. The work is done, so the crash lands after the
 * result and reports failure for a successful run. Waiting one keep-alive
 * interval lets those sockets retire; then `process.exit()` is safe again.
 */
async function exitAfterFlush(code) {
  process.exitCode = code;
  process.stdin.pause();
  await new Promise((resolve) => setTimeout(resolve, 250));
  process.exit(code);
}

let repl;
try {
  repl = new Repl({ config, session });
} catch (err) {
  console.error(`prometheus: ${err.message}`);
  process.exit(1);
}
await repl.start();
process.exit(0);
