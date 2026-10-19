#!/usr/bin/env node
// @ts-nocheck -- JavaScript entry point; the typed implementation lives in src/.

import { parseArgs } from "node:util";
import { loadConfig } from "../src/config.ts";
import { loadSession, latestSession, updateSessionFlags } from "../src/sessions.ts";
import { acquireSessionLock, releaseSessionLock, lockConflictMessage } from "../src/sessionLock.ts";
import { Repl } from "../src/repl.ts";

// Subcommands that take their own flags (`schedule add … --in 30m`,
// `sessions checkpoints … --restore start`) must not go through this parser:
// it rejects any option it was not told about, and teaching it every flag of
// every subcommand would put their argument grammar in the wrong place.
// Everything else keeps the strict parsing that catches a mistyped flag.
const SUBCOMMANDS = new Set(["sessions", "session", "schedule", "checkpoints", "apply", "usage", "workers", "attach", "work", "mcp", "goal"]);
// Only the first positional decides; a prompt whose text happens to contain
// the word "sessions" must still be a prompt.
const firstArg = process.argv.slice(2).find((arg) => !arg.startsWith("-"));
const rawParse = firstArg !== undefined && SUBCOMMANDS.has(firstArg) && !process.argv.slice(2).some((arg) => arg === "--detach");

const { values, positionals } = rawParse
  ? { values: {}, positionals: process.argv.slice(2) }
  : parseArgs({
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
    "goal-budget-usd": { type: "string" },
    "token-budget": { type: "string" },
    "disallowed-tools": { type: "string" },
    "dont-ask": { type: "boolean" },
    detach: { type: "boolean" },
    "worker-id": { type: "string" },
    "worker-parent": { type: "string" },
    ephemeral: { type: "boolean" },
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
      --mode <mode>           ask | auto | plan | acceptEdits | dontAsk | bypassPermissions (default: ask)
      --effort <level>        thinking effort: auto | low | medium | high
  -r, --resume <session-id>   resume a saved session
  -c, --continue              resume the most recent session in this directory
      --max-tokens <n>        per-response token cap (default: 16000)
      --context-window <n>    context window for compaction (default: 128000)
      --max-turns <n>         tool-loop turn cap per message (default: 60)
      --output-format <fmt>   text (default) | json | stream-json
      --output-schema <file>  validate the final JSON against a JSON Schema
      --max-budget-usd <n>    stop before a turn that would exceed this spend
      --goal-budget-usd <n>   ceiling for one goal/task loop
      --token-budget <n>      ceiling on tokens for the whole session
      --allowed-tools <list>  comma-separated tools approved without asking (Tool(name) scoped rules allowed)
      --disallowed-tools <list> tools refused outright, even in auto mode
      --dont-ask              approve every tool in a non-interactive run (dangerous; use in a sandbox)
      --detach                run in the background and return at once; follow with "prometheus attach"
      --ephemeral             do not save a session transcript
      --worker-id <id>        internal: the worker record this run belongs to
  -h, --help                  show this help
  -v, --version               show the version

If [prompt] is given, runs one turn and exits. Otherwise starts the interactive REPL.

A one-shot run has nobody to answer a permission prompt. A tool that would ask
is refused with a reason naming --allowed-tools; it does not block waiting for
input that will never come.

Commands:
  prometheus sessions [--all]           list saved sessions (interactive picker on a TTY)
  prometheus sessions fork <id> [text]  branch a session into a new one and run the text
  prometheus sessions rename <id> <t>   set a title
  prometheus sessions archive <id>      archive (keeps the transcript)
  prometheus sessions unarchive <id>
  prometheus sessions delete <id>       remove the transcript for good
  prometheus checkpoints <session>      list checkpoints (restore: checkpoints <s> --restore <id|start>)
  prometheus apply <session>            apply the session's last diff to the working tree
  prometheus workers [--logs <id>]      background workers and their logs
  prometheus attach [worker-id]         follow a worker's log
  prometheus usage [--export file]      usage totals, or write one record per request as CSV/JSON
  prometheus goal <session>             show the saved goal loop for a session

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

/**
 * Subcommands that never start an agent.
 *
 * They are dispatched before config loading: `prometheus sessions` must work
 * on a machine with no endpoint configured, and a broken config should not
 * stop a user from renaming a session.
 */
const COMMANDS = new Set([
  "sessions",
  "session",
  "checkpoints",
  "apply",
  "usage",
  "workers",
  "attach",
  "work",
  "goal",
  "schedule",
  "mcp",
]);
if (positionals.length > 0 && COMMANDS.has(positionals[0])) {
  const [command, ...rest] = positionals;
  const out = (text) => process.stdout.write(`${text}
`);
  const err = (text) => process.stderr.write(`${text}
`);
  if (command === "sessions" || command === "session") {
    const { runSessionCommand } = await import("../src/sessionCommands.ts");
    process.exitCode = await runSessionCommand(rest, { out, err });
  } else if (command === "checkpoints") {
    // `prometheus checkpoints <session>` is the short spelling of the session
    // subcommand; keeping both means neither has to be remembered.
    const { runSessionCommand } = await import("../src/sessionCommands.ts");
    process.exitCode = await runSessionCommand(["checkpoints", ...rest], { out, err });
  } else if (command === "apply") {
    const { runSessionCommand } = await import("../src/sessionCommands.ts");
    process.exitCode = await runSessionCommand(["apply", ...rest], { out, err });
  } else if (command === "work") {
    // Detached worker entry point: started by startDetached below and by the
    // agent's own background tool, never typed by a person.
    await import("./work.js");
  } else if (command === "workers" || command === "attach") {
    const workers = await import("../src/workers.ts");
    const logsAt = rest.indexOf("--logs");
    if (command === "attach" || logsAt >= 0) {
      const id = command === "attach" ? rest[0] : rest[logsAt + 1];
      if (!id) {
        err("usage: prometheus attach <worker-id>");
        process.exitCode = 2;
      } else {
        const text = workers.readWorkerLog(id);
        if (text === null) {
          err(`no log for worker ${id}`);
          process.exitCode = 1;
        } else {
          process.stdout.write(text);
        }
      }
    } else {
      const records = workers.listWorkers();
      if (records.length === 0) out("no background workers recorded");
      for (const line of workers.formatWorkers(records)) out(line);
    }
  } else if (command === "usage") {
    const { readUsage } = await import("../src/usage.ts");
    const { usageRows, writeUsageExport } = await import("../src/sessionCommands.ts");
    const rows = usageRows(readUsage());
    const exportAt = rest.indexOf("--export");
    if (exportAt >= 0) {
      const file = rest[exportAt + 1];
      if (!file) {
        err("usage: prometheus usage --export <file.csv|file.json>");
        process.exitCode = 2;
      } else {
        const written = writeUsageExport(file, rows);
        if (!written.ok) {
          err(written.error);
          process.exitCode = 1;
        } else {
          out(`wrote ${rows.length} record(s) to ${file} (${written.format})`);
        }
      }
    } else {
      const total = rows.reduce((sum, row) => sum + row.inputTokens + row.outputTokens, 0);
      const cost = rows.reduce((sum, row) => sum + (row.cost ?? 0), 0);
      out(`${rows.length} request(s), ${total.toLocaleString()} tokens, $${cost.toFixed(4)}`);
      const bySource = new Map();
      for (const row of rows) {
        const entry = bySource.get(row.source) ?? { tokens: 0, cost: 0 };
        entry.tokens += row.inputTokens + row.outputTokens;
        entry.cost += row.cost ?? 0;
        bySource.set(row.source, entry);
      }
      for (const [source, entry] of bySource) out(`  ${source.padEnd(10)} ${entry.tokens.toLocaleString().padStart(12)} tokens  $${entry.cost.toFixed(4)}`);
    }
  } else if (command === "mcp") {
    // `prometheus mcp login <server>` runs the same OAuth flow the desktop
    // does, so a headless machine can authorize a remote server once and
    // reuse the stored token.
    const [verb, name] = rest;
    if (verb !== "login" && verb !== "logout") {
      err("usage: prometheus mcp login|logout <server-name>");
      process.exitCode = 2;
    } else {
      const { readMcpConfig } = await import("../src/mcp.ts");
      const { deleteToken, loadTokens } = await import("../src/oauth.ts");
      const servers = readMcpConfig(process.cwd());
      const server = name ? servers[name] : undefined;
      if (verb === "logout") {
        if (!name) {
          err("usage: prometheus mcp logout <server-name>");
          process.exitCode = 2;
        } else {
          deleteToken(name);
          out(`removed the stored token for ${name}`);
        }
      } else if (!name || !server) {
        err(name ? `no MCP server named ${name} in this workspace` : "usage: prometheus mcp login <server-name>");
        process.exitCode = 2;
      } else if (!server.url) {
        err(`${name} is a stdio server and needs no login`);
        process.exitCode = 2;
      } else if (loadTokens()[name] && !(await import("../src/oauth.ts")).isExpired(loadTokens()[name])) {
        out(`${name} is already authorized; run logout first to re-authorize`);
      } else {
        try {
          const oauth = await import("../src/oauth.ts");
          const result = await oauth.interactiveAuthorize({
            server: name,
            resourceUrl: server.url,
            metadata: await oauth.discoverMetadata(server.url, undefined),
            open: (url) => out(`open this URL to authorize: ${url}`),
            log: (line) => err(line),
          });
          // `interactiveAuthorize` stores the token itself; a failure throws
          // rather than returning a result, which the catch below reports.
          void result;
          out(`authorized ${name}`);
        } catch (error) {
          err(`authorization failed: ${error.message}`);
          process.exitCode = 1;
        }
      }
    }
  } else if (command === "schedule") {
    const schedule = await import("../src/schedule.ts");
    const [verb = "list", ...args] = rest;
    if (verb === "list" || verb === "ls") {
      const entries = schedule.listSchedules();
      if (entries.length === 0) out("no scheduled runs");
      for (const entry of entries) out(schedule.formatSchedule(entry));
    } else if (verb === "add") {
      const atAt = args.indexOf("--at");
      const inAt = args.indexOf("--in");
      const everyAt = args.indexOf("--every");
      const cwdAt = args.indexOf("--cwd");
      const skip = new Set(["--at", "--in", "--every", "--cwd"]);
      let prompt = "";
      for (let index = 0; index < args.length; index++) {
        const arg = args[index];
        if (skip.has(arg)) {
          index += 1;
          continue;
        }
        prompt += (prompt ? " " : "") + arg;
      }
      const when = schedule.parseWhen({
        ...(atAt >= 0 ? { at: args[atAt + 1] } : {}),
        ...(inAt >= 0 ? { in: args[inAt + 1] } : {}),
      });
      if (!when) {
        err("usage: prometheus schedule add <prompt> --at <iso> | --in <30m|2h|1d> [--every <minutes>] [--cwd <dir>]");
        process.exitCode = 2;
      } else {
        const added = schedule.addSchedule({
          prompt,
          cwd: cwdAt >= 0 ? args[cwdAt + 1] : process.cwd(),
          at: when,
          ...(everyAt >= 0 ? { everyMinutes: Number(args[everyAt + 1]) } : {}),
        });
        if (!added.ok) {
          err(added.error);
          process.exitCode = 2;
        } else {
          out(`scheduled ${added.entry.id} for ${added.entry.dueAt}`);
        }
      }
    } else if (verb === "remove" || verb === "rm") {
      if (!schedule.removeSchedule(args[0])) {
        err(`no schedule ${args[0]}`);
        process.exitCode = 1;
      } else {
        out(`removed ${args[0]}`);
      }
    } else if (verb === "enable" || verb === "disable") {
      if (!schedule.setScheduleEnabled(args[0], verb === "enable")) {
        err(`no schedule ${args[0]}`);
        process.exitCode = 1;
      } else {
        out(`${verb}d ${args[0]}`);
      }
    } else {
      err(`unknown schedule command: ${verb}`);
      err("try: list, add, remove, enable, disable");
      process.exitCode = 2;
    }
  } else if (command === "goal") {
    const id = rest[0];
    if (!id) {
      err("usage: prometheus goal <session-id>");
      process.exitCode = 2;
    } else {
      const { selectSession } = await import("../src/sessionCommands.ts");
      const found = selectSession(id);
      if (!found.ok) {
        err(found.error);
        process.exitCode = 2;
      } else {
        const meta = (await import("../src/sessions.ts")).sessionMeta(found.session.id);
        const goal = meta?.goal;
        if (!goal) {
          out(`${found.session.id} has no saved goal loop`);
        } else {
          out(`${found.session.id}  ${goal.kind}  round ${goal.round}/${goal.maxRounds}`);
          out(`goal: ${goal.text}`);
          for (const line of goal.history ?? []) out(`  ${line}`);
          out("resume in the terminal: prometheus --resume " + found.session.id);
        }
      }
    }
  }
  await exitAfterFlush(process.exitCode ?? 0);
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

// The ceiling belongs on the config so the agent itself enforces it between
// turns. The old wrapper only checked after a run finished, so a single turn
// that ran long spent past the limit before anything stopped it.
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
    ...(values["disallowed-tools"] !== undefined ? { disallowedTools: parseToolList(values["disallowed-tools"]) } : {}),
    ...(maxBudget !== null ? { maxBudgetUsd: maxBudget } : {}),
    ...(values["goal-budget-usd"] !== undefined ? { goalBudgetUsd: Number(values["goal-budget-usd"]) } : {}),
    ...(values["token-budget"] !== undefined ? { sessionTokenBudget: Number(values["token-budget"]) } : {}),
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
/**
 * `--detach`: hand this exact one-shot run to a detached child and return.
 *
 * The child is the same command line without `--detach`, so there is no second
 * code path for background work and no divergence between what runs in the
 * foreground and what runs behind it. Its session is written by the child;
 * `prometheus --resume` and `prometheus attach` both find it because the id is
 * decided here and passed down.
 */
if (values.detach && positionals.length > 0) {
  const { startWorker } = await import("../src/workers.ts");
  const { spawn: spawnDetached } = await import("node:child_process");
  const worker = startWorker("bash", positionals.join(" "));
  const forwarded = process.argv.slice(2).filter((arg) => arg !== "--detach");
  const child = spawnDetached(process.execPath, [process.argv[1], "--worker-id", worker.id, ...forwarded], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    cwd: process.cwd(),
    env: process.env,
  });
  child.unref();
  process.stdout.write(`started in the background: ${worker.id}
`);
  process.stdout.write(`follow with: prometheus attach ${worker.id}  (or prometheus workers)
`);
  await exitAfterFlush(0);
}

if (values.ephemeral) {
  // A run the user asked to leave no trace must not appear in the Usage page
  // either; a token record with the working directory in it is still a trace.
  const { setUsageEphemeral } = await import("../src/usage.ts");
  setUsageEphemeral(true);
}

if (positionals.length > 0) {
  // One-shot mode. `text` keeps the terminal UI; the JSON formats swap in a UI
  // that emits events instead of drawing them, so the same turn can be consumed
  // by a script without parsing ANSI output.
  const { Agent } = await import("../src/agent.ts");
  const { ChatClient } = await import("../src/llm.ts");
  const headless = outputFormat !== "text";
  // The session id is decided before the run, not after: it appears in the
  // init event a stream consumer needs to correlate the run.
  const oneShotId = session?.id ?? `oneshot-${Date.now()}`;
  const ui = headless
    ? new (await import("../src/headless.ts")).JsonUi({ stream: outputFormat === "stream-json", sessionId: oneShotId, model: config.model })
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
  // The id also decides where spill files land, so it is assigned before any
  // tool can run.
  agent.sessionId = oneShotId;

  // The budget is enforced by the agent, before each run, from
  // `config.maxBudgetUsd`. A model with no price row is a configuration to
  // fix, not a silent zero: the old `?? 0` made an unpriced model look free.
  if (maxBudget !== null) {
    const { costOf } = await import("../src/pricing.ts");
    if (costOf(config.model, { inputTokens: 0, outputTokens: 0 }) === null) {
      console.error(`Warning: no price is known for ${config.model}; --max-budget-usd cannot be enforced.`);
    }
  }

  let failure = null;
  // The one-shot CLI now has the same session lifecycle as the desktop and the
  // REPL, so a project's SessionStart/SessionEnd hooks work in CI as well.
  await agent.fireSessionHooks("SessionStart", { sessionId: oneShotId });

  // Persist mid-turn the way the desktop does. A one-shot run can still be
  // long (a build loop, a refactor); without this a kill lost the whole turn,
  // and `--resume` had nothing partial to resume from.
  const oneshotCreatedAt = session?.createdAt ?? new Date().toISOString();
  const oneshotRecord = () => ({
    id: oneShotId,
    cwd: process.cwd(),
    model: config.model,
    baseUrl: config.baseUrl,
    createdAt: oneshotCreatedAt,
    updatedAt: new Date().toISOString(),
    messages: agent.messages.filter((m) => m.role !== "system"),
    mode: config.permissionMode,
    effort: config.thinkingEffort,
    sandbox: config.sandbox,
    networkPolicy: config.networkPolicy,
    board: config.board,
  });
  let autosaveTimer = null;
  if (!values.ephemeral) {
    const { saveSession: savePartial } = await import("../src/sessions.ts");
    autosaveTimer = setInterval(() => {
      try {
        savePartial(oneshotRecord());
      } catch {
        /* a transient write must not interrupt the turn */
      }
    }, 5000);
    autosaveTimer.unref?.();
  }
  try {
    await agent.run(positionals.join(" "));
  } catch (err) {
    failure = err instanceof Error ? err.message : String(err);
    ui.error(failure);
  } finally {
    if (autosaveTimer) clearInterval(autosaveTimer);
  }

  if (values["worker-id"]) {
    const { finishWorker } = await import("../src/workers.ts");
    finishWorker(values["worker-id"], failure ? "failed" : "done", failure ?? "turn finished");
  }
  await agent.fireSessionHooks("SessionEnd", { sessionId: oneShotId });
  const { saveSession } = await import("../src/sessions.ts");
  // `--ephemeral` means "nothing on disk": a run that is a probe, a smoke
  // test, or contains something the user does not want in their history.
  try {
    if (values.ephemeral) throw new Error("ephemeral run");
    saveSession(oneshotRecord());
  } catch (err) {
    // `--ephemeral` means "nothing on disk": a run that is a probe, a smoke
    // test, or contains something the user does not want in their history.
    if (!values.ephemeral) ui.error(`could not save session: ${err.message}`);
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
      ...(usage.cacheWriteTokens ? { cacheWriteTokens: usage.cacheWriteTokens } : {}),
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
      // A missing or malformed schema is a configuration error, not a model
      // failure; it must read as one line and not as a stack trace.
      let schema = null;
      try {
        schema = readSchema(values["output-schema"]);
      } catch (err) {
        ui.error(err.message);
        exitCode = 2;
      }
      if (schema) {
        const check = validateAgainstSchema(payload.text, schema);
        payload.schemaValid = check.valid;
        if (!check.valid) {
          payload.schemaError = check.error;
          // A caller asked for a shape and did not get it. Exiting zero would
          // tell the script that wrapped this run that the answer is usable.
          exitCode = 1;
        }
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
