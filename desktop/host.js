/**
 * Agent host for the desktop app.
 *
 * Runs under plain Node (not Electron), owns one Agent instance, and speaks
 * newline-delimited JSON over stdio:
 *
 *   stdin  <- { cmd: "...", ... }
 *   stdout -> { type: "...", ... }
 *
 * Keeping the runtime in its own process means a crash or an abort cannot take
 * the window down, and the TypeScript sources run natively under Node's type
 * stripping.
 */

import process from "node:process";
import { existsSync } from "node:fs";
import { loadConfig, ALLOWED_MODELS, isModelAllowed } from "../src/config.ts";
import { ChatClient } from "../src/llm.ts";
import { Agent } from "../src/agent.ts";
import { Permissions } from "../src/permissions.ts";
import { ALL_TOOLS } from "../src/tools/index.ts";
import { listSessions, loadSession, newSessionId, saveSession } from "../src/sessions.ts";
import { compactForce } from "../src/context.ts";
import { discoverModels, FALLBACK_MODELS } from "../src/models.ts";
import { detectLocale, isLocale } from "../src/i18n.ts";

let config;
let client;
let agent;
let permissions;
let sessionId = newSessionId();
let sessionCreatedAt = new Date().toISOString();
let cwd = process.cwd();
let pendingPermissions = new Map();
let permissionSeq = 0;
let running = false;
let locale = detectLocale();
/** Discovered model catalog; replaced whenever /models is (re)read. */
let catalog = { models: FALLBACK_MODELS, fetchedAt: new Date().toISOString(), source: "fallback" };

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function pickerModels() {
  const usable = catalog.models.filter((m) => m.supportsTools);
  const models = ALLOWED_MODELS.length > 0 ? usable.filter((m) => ALLOWED_MODELS.includes(m.id)) : usable;
  return models.length > 0 ? models : catalog.models;
}

function configModelAllowed(model) {
  return isModelAllowed(model) && pickerModels().some((m) => m.id === model);
}

async function refreshCatalog(force = false) {
  if (!config?.baseUrl) return;
  const next = await discoverModels(config.baseUrl, config.apiKey, { force });
  catalog = next;
  // Keep the active model if the endpoint still lists it; otherwise fall back to
  // the first advertised model so the next turn can actually run.
  if (config.model && !pickerModels().some((m) => m.id === config.model) && next.models.length > 0) {
    const replacement = pickerModels()[0].id;
    config.model = replacement;
    if (client) client.options.model = replacement;
    if (agent) agent.refreshSystemPrompt();
  }
  send({ type: "models", models: pickerModels(), model: config.model, source: next.source, fetchedAt: next.fetchedAt });
}

class HostUi {
  constructor() {
    this.thinkingActive = false;
    this.assistantActive = false;
    this.spinner = null;
  }
  setModelName(name) {
    // emitState() carries the catalog; this hook only records the active model.
    this.model = name;
  }
  info(text) {
    send({ type: "notice", level: "info", text });
  }
  dim(text) {
    send({ type: "notice", level: "dim", text });
  }
  warn(text) {
    send({ type: "notice", level: "warn", text });
  }
  error(text) {
    send({ type: "notice", level: "error", text });
  }
  assistantText(delta) {
    if (this.thinkingActive) this.thinkingEnd();
    if (!this.assistantActive) {
      this.assistantActive = true;
      send({ type: "assistant_start" });
    }
    send({ type: "assistant_delta", text: delta });
  }
  assistantEnd() {
    if (this.assistantActive) {
      this.assistantActive = false;
      send({ type: "assistant_end" });
    }
  }
  thinking() {
    if (this.assistantActive) this.assistantEnd();
    if (!this.thinkingActive) {
      this.thinkingActive = true;
      send({ type: "thinking_start" });
    }
  }
  thinkingEnd() {
    if (this.thinkingActive) {
      this.thinkingActive = false;
      send({ type: "thinking_end" });
    }
  }
  toolStart(name, summary) {
    this.assistantEnd();
    this.thinkingEnd();
    send({ type: "tool_start", name, summary });
  }
  toolEnd(name, ok, summary) {
    send({ type: "tool_end", name, ok, summary });
  }
  toolOutput(name, content) {
    send({ type: "tool_output", name, content: String(content).slice(0, 20000) });
  }
  todos(items) {
    send({ type: "todos", items });
  }
  spinnerStart(text) {
    this.spinner = text;
  }
  spinnerStop() {
    this.spinner = null;
  }
  async confirm(question) {
    const id = ++permissionSeq;
    send({ type: "permission_request", id, question });
    return await new Promise((resolve) => pendingPermissions.set(id, resolve));
  }
  takeLineDirty() {
    return false;
  }
}

const ui = new HostUi();

function changedFiles() {
  const seen = new Map();
  for (const message of agent?.messages ?? []) {
    if (message.role !== "assistant" || !message.tool_calls) continue;
    for (const call of message.tool_calls) {
      if (call.function.name !== "write_file" && call.function.name !== "edit_file") continue;
      try {
        const args = JSON.parse(call.function.arguments || "{}");
        if (typeof args.path === "string") {
          seen.set(args.path, call.function.name === "write_file" ? "written" : "edited");
        }
      } catch {
        /* ignore malformed arguments in history */
      }
    }
  }
  return [...seen.entries()].map(([path, action]) => ({ path, action }));
}

function sessionRecord() {
  return {
    id: sessionId,
    cwd,
    model: config.model,
    baseUrl: config.baseUrl,
    createdAt: sessionCreatedAt,
    updatedAt: new Date().toISOString(),
    messages: agent.messages.filter((m) => m.role !== "system"),
  };
}

function persist() {
  try {
    saveSession(sessionRecord());
    send({ type: "session_saved", sessionId });
  } catch (err) {
    send({ type: "notice", level: "warn", text: `could not save session: ${err.message}` });
  }
}

function emitState() {
  send({
    type: "state",
    sessionId,
    cwd,
    locale,
    mode: config.permissionMode,
    effort: config.thinkingEffort,
    model: config.model,
    models: pickerModels(),
    modelsSource: catalog.source,
    baseUrl: config.baseUrl,
    context: agent ? agent.contextUsage() : { tokens: 0, percent: 0 },
    usage: agent ? agent.usage : { inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
  });
}

function createAgent(messages = []) {
  permissions = new Permissions(config, ui);
  agent = new Agent(config, ui, client, ALL_TOOLS, permissions, messages);
  sessionCreatedAt = new Date().toISOString();
  ui.setModelName(config.model);
  emitState();
}

async function runPrompt(text) {
  if (running) {
    send({ type: "notice", level: "warn", text: "a turn is already running" });
    return;
  }
  running = true;
  send({ type: "run_start" });
  try {
    await agent.run(text);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (err?.name !== "AbortError") send({ type: "error", message });
  } finally {
    running = false;
    ui.assistantEnd();
    ui.thinkingEnd();
    persist();
    send({
      type: "run_end",
      context: agent.contextUsage(),
      usage: agent.usage,
      todos: agent.todos.items,
      files: changedFiles(),
    });
  }
}

function handle(cmd) {
  switch (cmd.cmd) {
    case "init": {
      if (cmd.cwd && existsSync(cmd.cwd)) {
        cwd = cmd.cwd;
        process.chdir(cwd);
      }
  if (isLocale(cmd.locale)) locale = cmd.locale;
      try {
        config = loadConfig({ permissionMode: cmd.mode });
      } catch (err) {
        send({ type: "fatal", message: err.message });
        return;
      }
      client = new ChatClient({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        model: config.model,
        maxTokens: config.maxTokens,
        reasoningEffort: config.thinkingEffort,
        timeoutMs: 300_000,
      });
      createAgent([]);
      send({ type: "ready" });
      void refreshCatalog(false);
      return;
    }
    case "refreshModels":
      void refreshCatalog(true);
      return;
    case "setEffort": {
      if (!["auto", "low", "medium", "high"].includes(cmd.effort)) return;
      config.thinkingEffort = cmd.effort;
      client.options.reasoningEffort = cmd.effort;
      emitState();
      return;
    }
    case "setLocale": {
      if (!isLocale(cmd.locale)) return;
      locale = cmd.locale;
      send({ type: "locale", locale });
      if (config) emitState();
      return;
    }
    case "prompt":
      void runPrompt(cmd.text);
      return;
    case "abort":
      agent?.abort();
      return;
    case "permission": {
      const resolve = pendingPermissions.get(cmd.id);
      if (resolve) {
        pendingPermissions.delete(cmd.id);
        resolve(cmd.answer);
      }
      return;
    }
    case "setMode": {
      if (!["ask", "auto", "plan"].includes(cmd.mode)) return;
      config.permissionMode = cmd.mode;
      permissions.mode = cmd.mode;
      agent.refreshSystemPrompt();
      emitState();
      return;
    }
    case "setModel": {
      if (!configModelAllowed(cmd.model)) {
        const fallback = pickerModels()[0]?.id;
        if (fallback) {
          config.model = fallback;
          client.options.model = fallback;
          agent.refreshSystemPrompt();
          ui.setModelName(fallback);
          emitState();
          send({ type: "notice", level: "warn", text: `model "${cmd.model}" is not in the endpoint's tool-capable list; switched to ${fallback}` });
        }
        return;
      }
      config.model = cmd.model;
      client.options.model = cmd.model;
      agent.refreshSystemPrompt();
      ui.setModelName(cmd.model);
      emitState();
      return;
    }
    case "newSession": {
      if (running) return send({ type: "notice", level: "warn", text: "stop the current turn first" });
      sessionId = newSessionId();
      createAgent([]);
      send({ type: "session_loaded", messages: [] });
      return;
    }
    case "loadSession": {
      if (running) return send({ type: "notice", level: "warn", text: "stop the current turn first" });
      const session = loadSession(cmd.id);
      if (!session) {
        send({ type: "notice", level: "error", text: `session not found: ${cmd.id}` });
        return;
      }
      if (session.cwd && existsSync(session.cwd) && session.cwd !== cwd) {
        cwd = session.cwd;
        process.chdir(cwd);
        try {
          config = loadConfig({});
        } catch {
          /* keep existing config */
        }
      }
      sessionId = session.id;
      createAgent(session.messages);
      sessionCreatedAt = session.createdAt;
      send({ type: "session_loaded", messages: publicMessages(session.messages), cwd });
      return;
    }
    case "listSessions":
      send({ type: "sessions", sessions: listSessions(false).slice(0, 40) });
      return;
    case "setCwd": {
      if (running) return send({ type: "notice", level: "warn", text: "stop the current turn first" });
      if (cmd.cwd && existsSync(cmd.cwd)) {
        cwd = cmd.cwd;
        process.chdir(cwd);
        sessionId = newSessionId();
        try {
          config = loadConfig({ permissionMode: config.permissionMode });
          client = new ChatClient({
            baseUrl: config.baseUrl,
            apiKey: config.apiKey,
            model: config.model,
            maxTokens: config.maxTokens,
            reasoningEffort: config.thinkingEffort,
            timeoutMs: 300_000,
          });
        } catch (err) {
          send({ type: "fatal", message: err.message });
          return;
        }
        createAgent([]);
        send({ type: "session_loaded", messages: [], cwd });
        void refreshCatalog(false);
      }
      return;
    }
    case "compact": {
      const before = agent.contextUsage().tokens;
      agent.messages = compactForce(agent.messages);
      send({ type: "notice", level: "dim", text: `compacted: ~${before} -> ~${agent.contextUsage().tokens} tokens` });
      send({ type: "run_end", context: agent.contextUsage(), usage: agent.usage, todos: agent.todos.items, files: changedFiles() });
      return;
    }
    case "initProject": {
      void runPrompt(
        "Create a PROMETHEUS.md file in the workspace root. Inspect the repository structure and key config files first. " +
          "Document what the project is, the build/test/lint commands, the directory layout, and conventions an agent must follow. " +
          "Keep it under 120 lines. Do not invent commands you have not confirmed exist.",
      );
      return;
    }
    case "clearHistory": {
      // /clear keeps the session but drops the conversation
      agent.messages = agent.messages.slice(0, 1);
      send({ type: "session_loaded", messages: [] });
      return;
    }
    default:
      send({ type: "notice", level: "warn", text: `unknown command: ${cmd.cmd}` });
  }
}

/** Strip internal assistant/tool structure down to what the transcript needs. */
function publicMessages(messages) {
  const out = [];
  for (const message of messages) {
    if (message.role === "user" && typeof message.content === "string") {
      out.push({ role: "user", text: message.content });
    } else if (message.role === "assistant") {
      if (typeof message.content === "string" && message.content.trim()) {
        out.push({ role: "assistant", text: message.content });
      }
      for (const call of message.tool_calls ?? []) {
        out.push({ role: "tool", name: call.function.name, summary: summarizeCall(call), ok: true, done: true });
      }
    }
  }
  return out;
}

function summarizeCall(call) {
  try {
    const args = JSON.parse(call.function.arguments || "{}");
    const path = args.path ?? args.command ?? args.pattern ?? args.name ?? "";
    return String(path).slice(0, 120);
  } catch {
    return "";
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    try {
      handle(JSON.parse(line));
    } catch (err) {
      send({ type: "notice", level: "error", text: `host error: ${err.message}` });
    }
  }
});

process.stdin.on("end", () => process.exit(0));

process.on("uncaughtException", (err) => {
  send({ type: "error", message: `host crashed: ${err.message}` });
  process.exit(1);
});

send({ type: "hello" });
