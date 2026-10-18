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
import { listSessions, loadSession, newSessionId, saveSession, updateSessionFlags, deleteSessionFile } from "../src/sessions.ts";
import { compactForce } from "../src/context.ts";
import { discoverModels, FALLBACK_MODELS } from "../src/models.ts";
import { detectLocale, isLocale } from "../src/i18n.ts";
import { buildChange } from "../src/diff.ts";
import { loadCheckpoints, restoreTo, clearCheckpoints, captureBefore } from "../src/checkpoints.ts";
import { loadFilePreview, readWorkspaceTree, searchWorkspaceFiles } from "../src/workspace.ts";
import { maskKey, readUiSettings, writeConfigFile, writeUiSettings } from "../src/settings.ts";
import { TerminalSession } from "./terminal.js";
import { gitCommit, gitStatus, prStatus, createPullRequest, ghAvailable } from "./git.js";
import { expandSlash, listCommands } from "../src/commands.ts";
import { loadMcpTools } from "../src/mcp.ts";
import { sessionToMarkdown, exportFilename, markRunActive, clearRunActive, findInterruptedRun } from "../src/export.ts";
import { createWorktree, commitWorktree, worktreeDiff, mergeWorktree, removeWorktree } from "../src/worktree.ts";
import { artifactCandidates, collectArtifacts, readArtifact } from "../src/artifacts.ts";

let config;
let client;
let agent;
let permissions;
let sessionId = newSessionId();
let sessionCreatedAt = new Date().toISOString();
/** Custom title for the current session, if the user set one. */
let sessionTitle = "";
let cwd = process.cwd();
let pendingPermissions = new Map();
let permissionSeq = 0;
let running = false;
/** Persistent shell behind the terminal pane; created on first use. */
let terminal = null;
/** MCP servers started for the current workspace. */
let mcpClients = [];
/** Set when this session runs in an isolated worktree. */
let worktree = null;
/** The workspace the session started from, before switching into a worktree. */
let baseCwd = null;
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


/** Adopt the endpoint's context length for the active model, if it reports one. */
function applyModelContext(id) {
  const entry = catalog.models.find((model) => model.id === id);
  if (!entry || !Number.isFinite(entry.contextLength) || entry.contextLength <= 0) return;
  config.contextWindow = entry.contextLength;
  if (agent) agent.config.contextWindow = entry.contextLength;
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
  applyModelContext(config.model);
  emitState();
  send({ type: "models", models: pickerModels(), model: config.model, source: next.source, fetchedAt: next.fetchedAt });
}

/** Per-session change set: prior content of every file the agent touched. */
const changeBaseline = new Map();
/** Same, but reset at each turn so the UI can show just the last turn's diff. */
let turnBaseline = new Map();

function resetChanges() {
  changeBaseline.clear();
  turnBaseline.clear();
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
  if (!turnBaseline.has(abs)) turnBaseline.set(abs, before);
}

function resolvePathForChange(root, inputPath) {
  const abs = isAbsolute(inputPath) ? resolve(inputPath) : resolve(root, inputPath);
  const rel = relative(resolve(root), abs);
  return rel.startsWith("..") || isAbsolute(rel) ? null : abs;
}

function computeChanges(baseline = changeBaseline) {
  const files = [];
  for (const [abs, before] of baseline) {
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
  send({ type: "changes", ...computeChanges(), lastTurn: computeChanges(turnBaseline) });
}

/**
 * Previewable files this session touched, plus recent previewable files in the
 * workspace when the session has not produced any.
 */
function emitArtifacts() {
  const touched = [...changeBaseline.keys()];
  const recent = touched.length > 0
    ? collectArtifacts(cwd, touched, sessionCreatedAt)
    : collectArtifacts(cwd, artifactCandidates(cwd), new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString());
  send({ type: "artifacts", artifacts: recent.slice(0, 60) });
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
  subagentStart(prompt) {
    this.assistantEnd();
    this.thinkingEnd();
    send({ type: "subagent_start", prompt: String(prompt).slice(0, 300) });
  }
  subagentActivity(kind, text) {
    send({ type: "subagent_activity", kind, text: String(text).slice(0, 300) });
  }
  subagentEnd(ok, summary) {
    send({ type: "subagent_end", ok, summary: String(summary ?? "") });
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
  // Keep flags written by sessionFlags; persist() must not erase them.
  const existing = (() => {
    try {
      return loadSession(sessionId);
    } catch {
      return null;
    }
  })();
  return {
    id: sessionId,
    cwd,
    model: config.model,
    baseUrl: config.baseUrl,
    createdAt: sessionCreatedAt,
    updatedAt: new Date().toISOString(),
    messages: agent.messages.filter((m) => m.role !== "system"),
    title: sessionTitle || existing?.title,
    pinned: existing?.pinned,
    archived: existing?.archived,
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

/**
 * Start the configured MCP servers and give their tools to the agent. Failures
 * are reported as notices: one broken server must not block the session.
 */
async function startMcp() {
  for (const client of mcpClients) client.dispose();
  mcpClients = [];
  let loaded;
  try {
    loaded = await loadMcpTools(cwd);
  } catch (err) {
    send({ type: "notice", level: "warn", text: `MCP: ${err.message}` });
    return;
  }
  mcpClients = loaded.clients;
  if (loaded.tools.length > 0) {
    agent?.addTools(loaded.tools);
    send({ type: "notice", level: "dim", text: `MCP: ${loaded.tools.length} tool(s) loaded` });
  }
  for (const error of loaded.errors) send({ type: "notice", level: "warn", text: `MCP: ${error}` });
}

function stopMcp() {
  for (const client of mcpClients) client.dispose();
  mcpClients = [];
}

/** Git status responses are async; ignore the ones overtaken by a workspace change. */
let gitStatusGeneration = 0;

async function emitGitStatus() {
  const generation = ++gitStatusGeneration;
  const status = await gitStatus(cwd);
  if (generation !== gitStatusGeneration) return status;
  send({ type: "git_status", ...status, worktree: worktree ? { branch: worktree.branch, path: worktree.path, base: baseCwd } : null });
  void emitPrStatus(generation);
  return status;
}

/** PR and check status; skipped quietly when gh is absent or unauthenticated. */
async function emitPrStatus(generation = gitStatusGeneration) {
  if (!(await ghAvailable(cwd))) {
    send({ type: "pr_status", available: false });
    return;
  }
  const result = await prStatus(cwd);
  if (generation !== gitStatusGeneration) return;
  send({ type: "pr_status", ...result });
}

async function runPrompt(text, images) {
  if (running) {
    // A message typed mid-turn is queued and delivered at the next tool
    // boundary; the renderer already echoed it into the transcript.
    agent.enqueue(text);
    send({ type: "queued", count: agent.queuedCount });
    return;
  }
  running = true;
  turnBaseline = new Map();
  markRunActive({ sessionId, cwd, startedAt: new Date().toISOString() });
  send({ type: "queued", count: 0 });
  send({ type: "run_start" });
  try {
    if (Array.isArray(images) && images.length > 0) {
      await agent.runWithParts(text, images.map((url) => ({ type: "image_url", image_url: { url } })));
    } else {
      await agent.run(text);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (err?.name !== "AbortError") send({ type: "error", message });
  } finally {
    running = false;
    clearRunActive();
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
    emitArtifacts();
    void emitGitStatus();
    void agent?.fireSessionHooks("Stop", { sessionId });
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
      void startMcp();
      void agent?.fireSessionHooks("SessionStart", { sessionId });
      const interrupted = findInterruptedRun(cwd);
      if (interrupted) {
        send({ type: "notice", level: "warn", text: `the previous run was interrupted (${interrupted.sessionId}); its files are in History` });
      }
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
          autoApprove: config?.autoApprove ?? [],
          contextWindow: config?.contextWindow ?? 1_000_000,
          modelContext: config ? catalog.models.find((model) => model.id === config.model)?.contextLength ?? null : null,
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
      if (Number.isFinite(Number(patch.contextWindow))) {
        filePatch.contextWindow = Math.max(8_000, Math.min(4_000_000, Number(patch.contextWindow)));
      }
      if (typeof patch.autoApprove === "string" || Array.isArray(patch.autoApprove)) {
        const list = Array.isArray(patch.autoApprove) ? patch.autoApprove : String(patch.autoApprove).split(",");
        filePatch.autoApprove = list.map((name) => String(name).trim()).filter(Boolean);
      }
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
        agent.config.contextWindow = config.contextWindow;
        agent.config.autoApprove = config.autoApprove;
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
    case "prompt": {
      // A known slash command expands into its prompt; anything else is sent
      // verbatim so a message starting with "/" is never swallowed.
      const expanded = expandSlash(cwd, String(cmd.text ?? ""));
      if (!expanded) {
        void runPrompt(cmd.text, cmd.images);
        return;
      }
      send({ type: "command_expanded", name: expanded.command.name, prompt: expanded.prompt });
      void runPrompt(expanded.prompt);
      return;
    }
    case "listCommands":
      send({ type: "commands", commands: listCommands(cwd).map(({ name, description, argumentHint }) => ({ name, description, argumentHint })) });
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
      applyModelContext(cmd.model);
      agent.refreshSystemPrompt();
      ui.setModelName(cmd.model);
      emitState();
      return;
    }
    case "newSession": {
      if (running) return send({ type: "notice", level: "warn", text: "stop the current turn first" });
      sessionId = newSessionId();
      sessionTitle = "";
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
      sessionTitle = session.title ?? "";
      createAgent(session.messages);
      sessionCreatedAt = session.createdAt;
      send({ type: "session_loaded", messages: publicMessages(session.messages), cwd });
      return;
    }
    case "forkSession": {
      // Branch the conversation into a new session: the original stays as it
      // was, so trying a different direction does not overwrite history.
      if (running) return send({ type: "notice", level: "warn", text: "stop the current turn first" });
      const source = loadSession(cmd.id ?? sessionId);
      if (!source) return send({ type: "notice", level: "error", text: "session not found" });
      if (source.cwd && existsSync(source.cwd) && source.cwd !== cwd) {
        cwd = source.cwd;
        process.chdir(cwd);
        disposeTerminal();
      }
      sessionId = newSessionId();
      sessionTitle = source.title ? `${source.title} (fork)` : "";
      sessionCreatedAt = new Date().toISOString();
      createAgent(source.messages);
      persist();
      send({ type: "session_loaded", messages: publicMessages(source.messages), cwd });
      send({ type: "notice", level: "info", text: `forked into ${sessionId}` });
      return;
    }
    case "listSessions":
      send({ type: "sessions", sessions: listSessions(false, Boolean(cmd.includeArchived)).slice(0, 80) });
      return;
    case "sessionFlags": {
      const updated = updateSessionFlags(String(cmd.id), {
        title: cmd.title,
        pinned: cmd.pinned,
        archived: cmd.archived,
      });
      if (!updated) return send({ type: "notice", level: "error", text: `session not found: ${cmd.id}` });
      send({ type: "sessions", sessions: listSessions(false, Boolean(cmd.includeArchived)).slice(0, 80) });
      if (updated.id === sessionId) {
        sessionTitle = updated.title ?? "";
        send({ type: "session_title", title: sessionTitle });
      }
      return;
    }
    case "deleteSession": {
      if (String(cmd.id) === sessionId) {
        return send({ type: "notice", level: "warn", text: "open another session before deleting the current one" });
      }
      const deleted = deleteSessionFile(String(cmd.id));
      send({ type: "sessions", sessions: listSessions(false, Boolean(cmd.includeArchived)).slice(0, 80) });
      if (!deleted) send({ type: "notice", level: "error", text: `session not found: ${cmd.id}` });
      return;
    }
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
        stopMcp();
        void startMcp();
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
    case "getArtifacts":
      emitArtifacts();
      return;
    case "getArtifact":
      try {
        send({ type: "artifact", artifact: readArtifact(cwd, String(cmd.path)) });
      } catch (err) {
        send({ type: "notice", level: "error", text: err.message });
      }
      return;    case "getTree":
      send({ type: "tree", path: cmd.path ?? ".", nodes: readWorkspaceTree(cwd, cmd.path ?? ".") });
      return;
    case "searchFiles":
      send({ type: "file_matches", query: cmd.query ?? "", files: searchWorkspaceFiles(cwd, String(cmd.query ?? "")) });
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
    case "exportSession": {
      const markdown = sessionToMarkdown(sessionRecord());
      send({ type: "export_ready", markdown, filename: exportFilename(sessionRecord()) });
      return;
    }
    case "worktreeStart": {
      if (running) return send({ type: "notice", level: "warn", text: "stop the current turn first" });
      if (worktree) return send({ type: "notice", level: "dim", text: "this session is already isolated" });
      baseCwd = cwd;
      const created = await createWorktree(cwd, sessionId);
      if (!created.ok) {
        baseCwd = null;
        return send({ type: "notice", level: "error", text: `worktree: ${created.error}` });
      }
      worktree = created.worktree;
      cwd = worktree.path;
      process.chdir(cwd);
      disposeTerminal();
      createAgent([]);
      send({ type: "session_loaded", messages: [], cwd });
      send({ type: "notice", level: "info", text: `worktree: ${worktree.branch}` });
      void emitGitStatus();
      void startMcp();
      return;
    }
    case "worktreeDiff": {
      if (!worktree) return;
      if (running) return send({ type: "notice", level: "warn", text: "stop the current turn first" });
      const committed = await commitWorktree(worktree, `Prometheus session ${sessionId}`);
      if (!committed.ok) send({ type: "notice", level: "warn", text: `worktree commit: ${committed.error}` });
      const diff = await worktreeDiff(worktree);
      send({ type: "worktree_diff", diff, branch: worktree.branch });
      return;
    }
    case "worktreeMerge": {
      if (!worktree || !baseCwd) return;
      if (running) return send({ type: "notice", level: "warn", text: "stop the current turn first" });
      const committed = await commitWorktree(worktree, `Prometheus session ${sessionId}`);
      if (!committed.ok) return send({ type: "notice", level: "error", text: `worktree commit: ${committed.error}` });
      const merged = await mergeWorktree(baseCwd, worktree);
      if (!merged.ok) return send({ type: "notice", level: "error", text: merged.error });
      const leaving = worktree;
      worktree = null;
      cwd = baseCwd;
      baseCwd = null;
      process.chdir(cwd);
      disposeTerminal();
      createAgent([]);
      send({ type: "session_loaded", messages: [], cwd });
      send({ type: "notice", level: "info", text: `merged ${leaving.branch}` });
      void removeWorktree(cwd, leaving);
      void emitGitStatus();
      return;
    }
    case "worktreeDiscard": {
      if (!worktree || !baseCwd) return;
      if (running) return send({ type: "notice", level: "warn", text: "stop the current turn first" });
      const leaving = worktree;
      worktree = null;
      cwd = baseCwd;
      baseCwd = null;
      process.chdir(cwd);
      disposeTerminal();
      createAgent([]);
      send({ type: "session_loaded", messages: [], cwd });
      send({ type: "notice", level: "warn", text: `discarded ${leaving.branch}` });
      void removeWorktree(cwd, leaving);
      void emitGitStatus();
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
    case "prStatus":
      void emitPrStatus();
      return;
    case "createPr": {
      if (running) return send({ type: "notice", level: "warn", text: "stop the current turn first" });
      const result = await createPullRequest(cwd, {
        title: String(cmd.title ?? ""),
        body: String(cmd.body ?? ""),
        base: cmd.base,
        draft: Boolean(cmd.draft),
      });
      send({ type: "pr_created", ...result });
      if (result.ok) void emitPrStatus();
      return;
    }
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
    if (message.role === "user") {
      if (typeof message.content === "string") {
        out.push({ role: "user", text: message.content });
      } else if (Array.isArray(message.content)) {
        const text = message.content.filter((part) => part.type === "text").map((part) => part.text).join(" ");
        const images = message.content.filter((part) => part.type === "image_url").length;
        out.push({ role: "user", text, images });
      }
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

process.stdin.on("end", () => {
  stopMcp();
  disposeTerminal();
  process.exit(0);
});

process.on("uncaughtException", (err) => {
  send({ type: "error", message: `host crashed: ${err.message}` });
  process.exit(1);
});

send({ type: "hello" });
