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
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { loadConfig, ALLOWED_MODELS, isModelAllowed } from "../src/config.ts";
import { ChatClient } from "../src/llm.ts";
import { Agent } from "../src/agent.ts";
import { Permissions } from "../src/permissions.ts";
import { ALL_TOOLS } from "../src/tools/index.ts";
import { listSessions, loadSession, newSessionId, saveSession } from "../src/sessions.ts";
import { compactForce } from "../src/context.ts";
import { discoverModels, FALLBACK_MODELS } from "../src/models.ts";
import { detectLocale, isLocale } from "../src/i18n.ts";
import { buildChange } from "../src/diff.ts";
import { loadCheckpoints, restoreTo, clearCheckpoints, captureBefore } from "../src/checkpoints.ts";
import { loadFilePreview, readWorkspaceTree } from "../src/workspace.ts";
import { maskKey, readUiSettings, writeConfigFile, writeUiSettings } from "../src/settings.ts";
import { TerminalSession } from "./terminal.js";
import { gitCommit, gitStatus } from "./git.js";

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
/** Persistent shell behind the terminal pane; created on first use. */
let terminal = null;
const persistedUi = readUiSettings();
let locale = isLocale(persistedUi.locale) ? persistedUi.locale : detectLocale();
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

/** Per-session change set: prior content of every file the agent touched. */
const changeBaseline = new Map();

function resetChanges() {
  changeBaseline.clear();
}

function recordChange(name, input) {
  if ((name !== "write_file" && name !== "edit_file") || typeof input.path !== "string") return;
  const abs = resolvePathForChange(cwd, input.path);
  if (!abs || changeBaseline.has(abs)) return;
  let before = null;
  try {
    before = existsSync(abs) ? readFileSync(abs, "utf8") : null;
  } catch {
    before = null;
  }
  changeBaseline.set(abs, before);
}

function resolvePathForChange(root, inputPath) {
  const abs = isAbsolute(inputPath) ? resolve(inputPath) : resolve(root, inputPath);
  const rel = relative(resolve(root), abs);
  return rel.startsWith("..") || isAbsolute(rel) ? null : abs;
}

function computeChanges() {
  const files = [];
  for (const [abs, before] of changeBaseline) {
    let after = null;
    try {
      after = existsSync(abs) ? readFileSync(abs, "utf8") : null;
    } catch {
      after = null;
    }
    if (before === after) continue;
    files.push(buildChange(relative(cwd, abs).split("\\").join("/"), before, after));
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return {
    files,
    additions: files.reduce((sum, file) => sum + file.additions, 0),
    deletions: files.reduce((sum, file) => sum + file.deletions, 0),
  };
}

function emitChanges() {
  send({ type: "changes", ...computeChanges() });
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
  echoUser(text) {
    // A queued message was just delivered to the model.
    send({ type: "user_queued_delivered", text });
    send({ type: "queued", count: agent ? agent.queuedCount : 0 });
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
  agent.sessionId = sessionId;
  agent.onBeforeMutate = (name, input) => recordChange(name, input);
  resetChanges();
  sessionCreatedAt = new Date().toISOString();
  ui.setModelName(config.model);
  emitState();
  send({ type: "changes", files: [], additions: 0, deletions: 0 });
  send({ type: "checkpoints", sessionId, entries: [] });
}

function sendTerminalState(state) {
  send({ type: "terminal_state", ...state });
}

/** Start (or restart) the pane's shell. Output streams as `terminal_output`. */
function ensureTerminal() {
  if (terminal && !terminal.exited) return terminal;
  terminal?.dispose();
  terminal = new TerminalSession({
    cwd,
    onOutput: (text) => send({ type: "terminal_output", text }),
    onState: (state) => sendTerminalState(state),
  });
  return terminal;
}

function disposeTerminal() {
  terminal?.dispose();
  terminal = null;
}

async function emitGitStatus() {
  const status = await gitStatus(cwd);
  send({ type: "git_status", ...status });
  return status;
}

async function runPrompt(text) {
  if (running) {
    // A message typed mid-turn is queued and delivered at the next tool
    // boundary; the renderer already echoed it into the transcript.
    agent.enqueue(text);
    send({ type: "queued", count: agent.queuedCount });
    return;
  }
  running = true;
  send({ type: "queued", count: 0 });
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
    emitChanges();
    send({ type: "checkpoints", ...loadCheckpoints(sessionId) });
    void emitGitStatus();
  }
}

async function handle(cmd) {
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
      void emitGitStatus();
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
      writeUiSettings({ locale });
      send({ type: "locale", locale });
      if (config) emitState();
      return;
    }
    case "getSettings":
      send({
        type: "settings",
        settings: {
          baseUrl: config?.baseUrl ?? "",
          apiKeyMasked: maskKey(config?.apiKey ?? ""),
          model: config?.model ?? "",
          models: pickerModels(),
          mode: config?.permissionMode ?? "ask",
          effort: config?.thinkingEffort ?? "auto",
          maxTokens: config?.maxTokens ?? 16000,
          locale,
          theme: persistedUi.theme ?? "dark",
        },
      });
      return;
    case "saveSettings": {
      const patch = cmd.settings ?? {};
      const filePatch = {};
      if (typeof patch.baseUrl === "string" && patch.baseUrl.trim()) filePatch.baseUrl = patch.baseUrl.trim().replace(/\/+$/, "");
      // An unchanged masked key is left alone; a typed replacement is saved as-is.
      if (typeof patch.apiKey === "string" && patch.apiKey.trim() && !patch.apiKey.includes("•")) {
        filePatch.apiKey = patch.apiKey.trim();
      }
      if (typeof patch.model === "string" && patch.model) filePatch.model = patch.model;
      if (["ask", "auto", "plan"].includes(patch.mode)) filePatch.permissionMode = patch.mode;
      if (["auto", "low", "medium", "high"].includes(patch.effort)) filePatch.thinkingEffort = patch.effort;
      if (Number.isFinite(Number(patch.maxTokens))) filePatch.maxTokens = Math.max(256, Math.min(128000, Number(patch.maxTokens)));
      try {
        writeConfigFile(filePatch);
        if (isLocale(patch.locale) || patch.theme === "dark" || patch.theme === "light") {
          writeUiSettings({
            ...(isLocale(patch.locale) ? { locale: patch.locale } : {}),
            ...(patch.theme === "dark" || patch.theme === "light" ? { theme: patch.theme } : {}),
          });
        }
        if (isLocale(patch.locale)) locale = patch.locale;
        config = loadConfig({ permissionMode: config.permissionMode });
        client = new ChatClient({
          baseUrl: config.baseUrl,
          apiKey: config.apiKey,
          model: config.model,
          maxTokens: config.maxTokens,
          reasoningEffort: config.thinkingEffort,
          timeoutMs: 300_000,
        });
        permissions.mode = config.permissionMode;
        agent.config.model = config.model;
        agent.config.maxTokens = config.maxTokens;
        agent.config.thinkingEffort = config.thinkingEffort;
        agent.config.permissionMode = config.permissionMode;
        agent.refreshSystemPrompt();
        emitState();
        void refreshCatalog(true);
        send({ type: "settings_saved", ok: true });
      } catch (err) {
        send({ type: "settings_saved", ok: false, error: err.message });
      }
      return;
    }
    case "prompt":
      void runPrompt(cmd.text);
      return;
    case "abort":
      agent?.clearQueue();
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
        disposeTerminal();
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
        disposeTerminal();
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
        void emitGitStatus();
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
    case "getChanges":
      emitChanges();
      return;
    case "getTree":
      send({ type: "tree", path: cmd.path ?? ".", nodes: readWorkspaceTree(cwd, cmd.path ?? ".") });
      return;
    case "getFile":
      try {
        send({ type: "file", file: loadFilePreview(cwd, String(cmd.path)) });
      } catch (err) {
        send({ type: "notice", level: "error", text: err.message });
      }
      return;
    case "getCheckpoints":
      send({ type: "checkpoints", ...loadCheckpoints(sessionId) });
      return;
    case "restoreCheckpoint": {
      if (running) return send({ type: "notice", level: "warn", text: "stop the current turn first" });
      const result = restoreTo(sessionId, cmd.id);
      resetChanges();
      send({ type: "checkpoints", ...loadCheckpoints(sessionId) });
      emitChanges();
      send({
        type: "notice",
        level: result.errors.length ? "warn" : "info",
        text: result.errors.length
          ? `restored ${result.restored.length} file(s); ${result.errors.join("; ")}`
          : `restored ${result.restored.length} file(s)`,
      });
      return;
    }
    case "clearCheckpoints":
      clearCheckpoints(sessionId);
      send({ type: "checkpoints", sessionId, entries: [] });
      return;
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
    case "terminalOpen": {
      const term = ensureTerminal();
      send({ type: "terminal_state", cwd: term.cwd, busy: term.busy, exited: term.exited, scrollback: term.scrollback });
      return;
    }
    case "terminalRun": {
      const term = ensureTerminal();
      if (running) {
        // The terminal shares the workspace with the agent; interleaving edits
        // could corrupt a file the agent is mid-way through changing.
        send({ type: "notice", level: "warn", text: "the agent is still working; wait for this turn to finish" });
        return;
      }
      term.run(String(cmd.command ?? ""));
      return;
    }
    case "terminalInterrupt":
      terminal?.interrupt();
      return;
    case "terminalRestart": {
      disposeTerminal();
      const term = ensureTerminal();
      send({ type: "terminal_state", cwd: term.cwd, busy: term.busy, exited: term.exited, scrollback: "" });
      return;
    }
    case "terminalClose":
      disposeTerminal();
      return;
    case "gitStatus":
      void emitGitStatus();
      return;
    case "gitCommit": {
      if (running) return send({ type: "notice", level: "warn", text: "stop the current turn first" });
      const paths = Array.isArray(cmd.paths) ? cmd.paths.map(String) : [];
      const result = await gitCommit(cwd, cmd.message, paths);
      send({ type: "git_commit", ...result });
      void emitGitStatus();
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
      void handle(JSON.parse(line)).catch((err) => {
        send({ type: "notice", level: "error", text: `host error: ${err.message}` });
      });
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
