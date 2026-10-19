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
import { FallbackChatClient, buildFallbackClients } from "../src/fallback.ts";
import { Agent } from "../src/agent.ts";
import { Permissions } from "../src/permissions.ts";
import { ALL_TOOLS } from "../src/tools/index.ts";
import { listSessions, loadSession, newSessionId, saveSession, updateSessionFlags, deleteSessionFile } from "../src/sessions.ts";
import { acquireSessionLock, releaseSessionLock, lockConflictMessage, sessionLockHolder, removeSessionLockFile } from "../src/sessionLock.ts";
import { compactForce } from "../src/context.ts";
import { discoverModels, FALLBACK_MODELS } from "../src/models.ts";
import { detectLocale, isLocale } from "../src/i18n.ts";
import { buildChange } from "../src/diff.ts";
import { loadCheckpoints, restoreTo, restoreAfterMessage, clearCheckpoints, captureBefore } from "../src/checkpoints.ts";
import { loadFilePreview, readWorkspaceTree, searchWorkspaceFiles } from "../src/workspace.ts";
import { maskKey, readUiSettings, writeBoardConfig, writeConfigFile, writeUiSettings } from "../src/settings.ts";
import { loadRules, removeRule } from "../src/rules.ts";
import { publicProviders, providerFor } from "../src/providers.ts";
import { recordUsage, usageSummary } from "../src/usage.ts";
import {
  listMcpServers,
  listSkills,
  readInstructions,
  removeMcpServer,
  removeSkill,
  saveMcpServer,
  saveSkill,
  writeInstructions,
} from "../src/settingsFiles.ts";
import { readMemorySections, deleteMemory } from "../src/memory.ts";
import { installFromManifest, installPack } from "../src/packs/install.ts";
import { packsSummary, removePack, verifyPack, pruneTmp } from "../src/packs/registry.ts";
import { catalogFor, isInstallable, toInstallEntry } from "../src/packs/catalog.ts";
import { runGoal, runTaskLoop } from "../src/autoloop.ts";
import { detectToolchains, resetToolchainCache, TOOLCHAIN_INFO } from "../src/embedded/toolchain.ts";
import { detectProject } from "../src/embedded/project.ts";
import { hooksStatus, trustProjectHooks, revokeProjectHooks } from "../src/hooks.ts";
import { listProbes, listTargets } from "../src/embedded/probe.ts";
import { listSerialPorts, openPort } from "../src/embedded/serial.ts";
import { SerialLineBuffer } from "../src/embedded/serialStream.ts";
import { assembleBoardState, boardTargetStatus } from "../src/embedded/board.ts";
import { TerminalSession } from "./terminal.js";
import { gitCommit, gitStatus, prStatus, createPullRequest, ghAvailable } from "./git.js";
import { expandSlash, listCommands } from "../src/commands.ts";
import { loadMcpTools, refreshServerTools, elicitationQuestions } from "../src/mcp.ts";
import { interactiveAuthorize } from "../src/oauth.ts";
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
/** Task state of this conversation, mirrored into the sidebar. */
let sessionStatus = "ready";
/** Prompts advertised by MCP servers, exposed as slash commands. */
let mcpPrompts = [];
/** Canonical workspace spelling: one project must not appear twice. */
function canonicalCwd(path) {
  try {
    const resolved = resolve(path);
    return process.platform === "win32" ? resolved.replace(/[\\]+/g, "/") : resolved;
  } catch {
    return path;
  }
}

let cwd = canonicalCwd(process.cwd());
let pendingPermissions = new Map();
let permissionSeq = 0;
let running = false;
/** Persistent shell behind the terminal pane; created on first use. */
let terminal = null;
/** MCP servers started for the current workspace. */
let mcpClients = [];
/** Server name → client, so a prompt or resource is asked of its owner. */
let mcpByServer = new Map();
/** Set when this session runs in an isolated worktree. */
let worktree = null;
/** The workspace the session started from, before switching into a worktree. */
let baseCwd = null;
const persistedUi = readUiSettings();
/** Settings written by the renderer; re-read on save so this process stays current. */
let uiPrefs = { ...persistedUi };
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
  // The value came from the endpoint, not from a guess.
  config.contextWindowAssumed = false;
  if (agent) {
    agent.config.contextWindow = entry.contextLength;
    agent.config.contextWindowAssumed = false;
  }
}

/**
 * Refresh the model list without ever leaving the picker on "loading models…".
 * Callers use `void refreshCatalog()`, so an exception here would be an
 * unhandled rejection that the renderer never hears about. Reporting the
 * failure explicitly is what lets the picker leave the loading state.
 */
async function refreshCatalog(force = false) {
  if (!config?.baseUrl) {
    send({ type: "models", models: [], model: config?.model ?? "", source: "unconfigured", fetchedAt: null });
    return;
  }
  try {
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
  } catch (err) {
    // Still send the catalogue we have — fallback models are usually enough to
    // run — but say why it is stale so the picker stops spinning.
    send({
      type: "models",
      models: pickerModels(),
      model: config.model,
      source: "error",
      error: err instanceof Error ? err.message : String(err),
      fetchedAt: null,
    });
  }
}

/**
 * Build the client for the current config: a primary plus the configured
 * fallbacks. The agent only ever sees the wrapper.
 */
function makeClient() {
  const primary = new ChatClient({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    model: config.model,
    maxTokens: config.maxTokens,
    reasoningEffort: config.thinkingEffort,
    echoReasoning: Boolean(config.echoReasoning),
    timeoutMs: 300_000,
  });
  const ids = Array.isArray(config.fallbackModels) ? config.fallbackModels : [];
  if (ids.length === 0) return primary;
  return new FallbackChatClient({
    primary,
    fallbacks: () => buildFallbackClients(primary, ids),
    onFallback: (from, to, reason) => {
      send({ type: "notice", level: "warn", text: `model ${from} unavailable (${reason}); retried with ${to}` });
    },
  });
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
  thinking(delta = "") {
    if (this.assistantActive) this.assistantEnd();
    if (!this.thinkingActive) {
      this.thinkingActive = true;
      send({ type: "thinking_start" });
    }
    // The text is forwarded so the transcript can show it in the Thinking and
    // Verbose views; the Normal view keeps only the one-line marker.
    if (delta) send({ type: "thinking_text", text: String(delta) });
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
  /**
   * A tool's structured result.
   *
   * Only embed_build sends something the panes need between calls — the
   * flash/RAM numbers come from the last build, not from a fresh one — so this
   * both records it and forwards it. The renderer ignores names it does not know.
   */
  toolDetail(name, data) {
    if (name === "embed_build" && data && typeof data === "object") {
      const usage = data.usage && typeof data.usage === "object" ? data.usage : null;
      lastBuild = {
        ok: Boolean(data.ok),
        ...(usage ? { usage: { flash: Number(usage.flash) || 0, ram: Number(usage.ram) || 0 } } : {}),
        at: new Date().toISOString(),
      };
    }
    send({ type: "tool_detail", name, data });
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
  async confirm(question, detail) {
    const id = ++permissionSeq;
    // Acceptance harness only: answer permission prompts from a script so a
    // headless run can exercise the approval path without a person clicking.
    const scripted = process.env.PROMETHEUS_ANSWER_PERMISSION;
    if (scripted && ["yes", "always", "no"].includes(scripted)) {
      send({ type: "permission_request", id, question, ...(detail ? { detail } : {}), answered: scripted });
      setTimeout(() => {
        const resolve = pendingPermissions.get(id);
        if (resolve) {
          pendingPermissions.delete(id);
          resolve(scripted);
        }
      }, Number(process.env.PROMETHEUS_ANSWER_DELAY_MS ?? 2500));
      const answer = await new Promise((resolve) => pendingPermissions.set(id, resolve));
      setSessionStatus("working");
      return answer;
    }
    setSessionStatus("needs-input");
    // The diff travels with the question so the bar can show the change the
    // approval is about, not just the file name.
    send({ type: "permission_request", id, question, ...(detail ? { detail } : {}) });
    const answer = await new Promise((resolve) => pendingPermissions.set(id, resolve));
    setSessionStatus("working");
    return answer;
  }
  async ask(question, options) {
    // The permission bar is still open in this flow, so reuse its answer channel
    // with a distinct message shape the renderer renders as extra buttons.
    const id = ++permissionSeq;
    // Options travel with a stable value plus a localisation key; the renderer
    // translates the key and falls back to the English label.
    const withKeys = options.map((option) => ({
      ...option,
      i18nKey: option.value === "always-tool" ? "rememberTool" : option.value === "always-detail" ? "rememberDetail" : "",
    }));
    setSessionStatus("needs-input");
    send({ type: "permission_choice", id, question, options: withKeys });
    const answer = await new Promise((resolve) => pendingPermissions.set(id, resolve));
    setSessionStatus("working");
    pendingPermissions.delete(id);
    return answer;
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

/**
 * Every slash command the composer can offer: the project's markdown commands
 * plus any prompt an MCP server advertises. A project command wins a name
 * collision, because the user wrote it for this workspace.
 */
function availableCommands() {
  const local = listCommands(cwd).map(({ name, description, argumentHint }) => ({ name, description, argumentHint }));
  const names = new Set(local.map((command) => command.name));
  for (const { server, prompt } of mcpPrompts) {
    if (!prompt?.name || names.has(prompt.name)) continue;
    names.add(prompt.name);
    local.push({
      name: prompt.name,
      description: prompt.description ?? `MCP prompt from ${server}`,
      argumentHint: (prompt.arguments ?? []).map((arg) => (arg.required ? `<${arg.name}>` : `[${arg.name}]`)).join(" "),
      mcp: server,
    });
  }
  return local.sort((a, b) => a.name.localeCompare(b.name));
}

/** Expand a slash command typed in the composer, MCP prompts included. */
async function expandAnySlash(text) {
  const expanded = expandSlash(cwd, text);
  if (expanded) return expanded;
  const match = /^\/([a-z0-9][a-z0-9-_]*)\s*([\s\S]*)$/i.exec(text.trim());
  if (!match) return null;
  const entry = mcpPrompts.find(({ prompt }) => prompt.name === match[1]);
  if (!entry) return null;
  return { command: { name: entry.prompt.name }, prompt: await mcpPromptText(entry, match[2]) };
}

/**
 * Expand an MCP prompt by asking the server for it.
 *
 * The old code never sent `prompts/get`: it built a sentence saying "use the
 * MCP prompt X", so a prompt whose body is a review checklist arrived as its
 * own name. The template remains the fallback for a server that lists prompts
 * but cannot serve one, because a failed expansion must not swallow the
 * message.
 */
async function mcpPromptText(entry, tail) {
  const args = entry.prompt.arguments ?? [];
  const values = tail.trim() ? tail.trim().split(/\s+/) : [];
  const filled = {};
  args.forEach((arg, index) => {
    filled[arg.name] = values[index] ?? "";
  });
  const client = mcpByServer.get(entry.server) ?? null;
  if (client?.getPrompt) {
    try {
      const result = await client.getPrompt(entry.prompt.name, filled);
      const text = promptMessagesToText(result.messages);
      if (text) return text;
    } catch (err) {
      send({ type: "notice", level: "dim", text: `MCP: ${entry.server} could not serve prompt ${entry.prompt.name}: ${err.message}` });
    }
  }
  if (args.length === 0) {
    return tail.trim()
      ? `Use the MCP prompt "${entry.prompt.name}" from ${entry.server}. Additional input: ${tail.trim()}`
      : `Use the MCP prompt "${entry.prompt.name}" from ${entry.server}.`;
  }
  const rendered = args.map((arg, index) => `${arg.name}: ${values[index] ?? ""}`).join("\n");
  return `Use the MCP prompt "${entry.prompt.name}" from ${entry.server} with these arguments:\n${rendered}`;
}

/** Flatten `prompts/get` messages into the single string the composer sends. */
function promptMessagesToText(messages) {
  return (messages ?? [])
    .map((message) => {
      const content = message?.content;
      if (typeof content === "string") return content;
      if (content?.type === "text" && typeof content.text === "string") return content.text;
      if (content?.type === "resource" && typeof content.resource?.text === "string") return content.resource.text;
      return "";
    })
    .filter(Boolean)
    .join("\n\n");
}

/**
 * Send the session list.
 *
 * The sidebar used to be capped at 80 with no way past it, so old sessions
 * were not merely below the fold — they were unreachable, and search only saw
 * those 80. The cap is now a page size the renderer can raise; `total` says how
 * many exist so the "show more" row knows when to disappear.
 */
const SESSION_PAGE = 80;
function sendSessions(options = {}) {
  const all = listSessions(false, Boolean(options.includeArchived));
  const limit = Math.max(SESSION_PAGE, Math.min(5000, Number(options.limit) || SESSION_PAGE));
  send({ type: "sessions", sessions: all.slice(0, limit), total: all.length, limit });
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
    status: sessionStatus,
    // The settings the conversation ran with, so reopening it restores the
    // mode and effort the user was actually working in.
    mode: config.permissionMode,
    effort: config.thinkingEffort,
    sandbox: config.sandbox ?? "enforce",
    networkPolicy: config.networkPolicy ?? "off",
    board: config.board,
  };
}

/**
 * Move the session between ready / working / needs-input / error. The sidebar
 * reads this from the saved meta, so a crashed host still shows the last state
 * instead of pretending everything is idle.
 */
function setSessionStatus(next) {
  if (sessionStatus === next) return;
  sessionStatus = next;
  try {
    updateSessionFlags(sessionId, { status: next });
  } catch {
    /* status is cosmetic; never block a turn on it */
  }
  send({ type: "session_status", sessionId, status: next });
  sendSessions();
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
    sandbox: config.sandbox ?? "enforce",
    networkPolicy: config.networkPolicy ?? "off",
    model: config.model,
    models: pickerModels(),
    modelsSource: catalog.source,
    baseUrl: config.baseUrl,
    context: agent ? agent.contextUsage() : { tokens: 0, percent: 0 },
    usage: agent ? agent.usage : { inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
    // Both are cheap: the project detection is synchronous and the serial
    // monitor is our own state. The machine scan is not included — the Board
    // pane asks for it when it opens, so a pure web project pays nothing.
    board: {
      selection: config.board ?? {},
      projectKind: detectProject(cwd).kind,
    },
    serial: serialStatus(),
  });
}

function createAgent(messages = []) {
  permissions = new Permissions(config, ui);
  agent = new Agent(config, ui, client, ALL_TOOLS, permissions, messages);
  agent.sessionId = sessionId;
  agent.outputStyle = uiPrefs.outputStyle ?? "default";
  agent.onBeforeMutate = (name, input) => recordChange(name, input);
  // A background sub-task reports when it is done. The notice is not a user
  // turn: it lands in the transcript as a result, and the conversation only
  // sees it if the user asks a follow-up.
  agent.onBackgroundReport = (prompt, report, ok) => {
    send({
      type: "background_report",
      ok,
      prompt: String(prompt).slice(0, 300),
      report: String(report).slice(0, 20_000),
    });
    if (!ok) send({ type: "notice", level: "error", text: `background task failed: ${String(report).slice(0, 200)}` });
    void emitGitStatus();
  };
  // Compaction rewrote the history; persist the new generation immediately so
  // an interrupted turn cannot leave a stale transcript on disk.
  agent.onCompacted = (info) => {
    persist();
    // The transcript shows a marker at the point where context was compressed,
    // so a long session never silently loses its earlier turns.
    send({ type: "compacted", ...info });
  };
  // Stream token accounting to the window as the turn runs, so the meter is
  // live instead of jumping only when the turn ends.
  agent.onQueryEvent = (event) => {
    if (event.type === "usage") send({ type: "usage", usage: event.usage, context: agent.contextUsage() });
  };
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

// ---- Board and serial monitor ---------------------------------------------
//
// Two panes read from here. The board pane wants a picture of the machine
// (project, toolchains, probes, ports); the serial pane wants a stream. Both
// are expensive enough that doing them on every request would make the pane
// feel broken, so the inventory is cached and single-flighted, and the target
// list is loaded only when the user asks for it.

/** Probes, ports and toolchains, with the time they were last read. */
let boardCache = null;
/** One inventory scan at a time; concurrent callers share the result. */
let boardInflight = null;
/** The target table, once loaded. Never expires within a session. */
let targetCache = null;
/** The monitor's open port, if any. */
let serial = null;
/** The build the agent last ran in this session, shown by the Board pane. */
let lastBuild = null;

const BOARD_TTL_MS = 30_000;

/** Invalidate everything a folder switch or a toolchain change makes stale. */
function forgetBoard() {
  boardCache = null;
  targetCache = null;
}

async function boardInventory(force = false) {
  if (!force && boardCache && Date.now() - boardCache.at < BOARD_TTL_MS) return boardCache;
  // Two panes opening at once must not spawn two pairs of probes.
  if (boardInflight) return boardInflight;
  boardInflight = (async () => {
    const report = await detectToolchains();
    const byKind = new Map(report.tools.map((entry) => [entry.kind, entry.path]));
    const [probes, ports] = await Promise.all([
      listProbes({ pyocd: byKind.get("pyocd"), "probe-rs": byKind.get("probe-rs"), jlink: byKind.get("jlink") }),
      listSerialPorts(),
    ]);
    boardCache = {
      at: Date.now(),
      tools: report.tools,
      missing: report.missing,
      probes: probes.probes,
      probeNotes: probes.notes,
      ports,
      paths: {
        pyocd: byKind.get("pyocd"),
        "probe-rs": byKind.get("probe-rs"),
      },
    };
    return boardCache;
  })().finally(() => {
    boardInflight = null;
  });
  return boardInflight;
}

/**
 * The project half of the board state, which is cheap and synchronous.
 *
 * It is sent first so the pane can draw immediately; the inventory follows as
 * a second message. Awaiting both together would leave the pane blank for a
 * second on a cold start and for twenty seconds when the probe tool hangs.
 */
function boardStateProject() {
  const project = detectProject(cwd);
  return assembleBoardState({
    project,
    selection: config?.board ?? {},
    scannedAt: null,
    build: lastBuild,
  });
}

/**
 * Whether the selected target exists in the table, or that nobody has looked.
 *
 * Computed here rather than in the renderer because the distinction is subtle
 * enough to be worth testing, and `boardTargetStatus` is already tested.
 */
function targetStatusFor(selection) {
  return boardTargetStatus(selection?.target, targetCache ? targetCache.targets : null);
}

/**
 * The project phase, enriched with the last inventory if one has been scanned.
 *
 * A bare project state is right on first open — it draws immediately and the
 * inventory follows. Sending one later (after loading targets, say) would wipe
 * the toolchain and probe rows that are already on screen, so whenever a scan
 * exists it rides along.
 */
function boardStateCached() {
  const base = boardStateProject();
  if (!boardCache) return base;
  return {
    ...base,
    tools: boardCache.tools,
    missing: boardCache.missing,
    probes: boardCache.probes,
    probeNotes: boardCache.probeNotes,
    ports: boardCache.ports,
    scannedAt: new Date(boardCache.at).toISOString(),
  };
}

function sendBoardState(phase, state) {
  send({ type: "board_state", phase, state, targetStatus: targetStatusFor(state.selection) });
}

async function emitBoardState(refresh = "auto") {
  // Phase one is always sent, even when the inventory is cached: the selection
  // may have changed since the last message and the pane rebuilds from it.
  sendBoardState("project", boardStateProject());
  try {
    const inventory = await boardInventory(refresh === "all");
    sendBoardState("inventory", {
      ...boardStateProject(),
      tools: inventory.tools,
      missing: inventory.missing,
      probes: inventory.probes,
      probeNotes: inventory.probeNotes,
      ports: inventory.ports,
      scannedAt: new Date(inventory.at).toISOString(),
    });
  } catch (err) {
    send({ type: "notice", level: "warn", text: `board scan failed: ${err.message}` });
  }
}

/** The target table, or the reason there is none. Only on explicit request. */
async function emitBoardTargets(filter) {
  try {
    if (!targetCache) {
      const inventory = await boardInventory(false);
      const result = await listTargets({ pyocd: inventory.paths.pyocd }, { limit: 0 });
      targetCache = { targets: result.targets, notes: result.notes, total: result.total };
    }
    const needle = filter ? String(filter).trim().toLowerCase() : "";
    const targets = needle
      ? targetCache.targets.filter(
          (entry) =>
            entry.name.toLowerCase().includes(needle) ||
            entry.vendor?.toLowerCase().includes(needle) ||
            entry.part?.toLowerCase().includes(needle),
        )
      : targetCache.targets;
    send({
      type: "board_targets",
      total: targetCache.total,
      notes: targetCache.notes,
      // A filtered list is what the picker shows; it is capped because the
      // unfiltered table is 206 entries and the picker is not a table.
      targets: targets.slice(0, 200),
      filter: filter ?? "",
    });
    // Loading the table turns "unloaded" into a real verdict about the selected
    // target — that is the whole point of loading it — so the pane hears again.
    sendBoardState("project", boardStateCached());
  } catch (err) {
    send({ type: "board_targets", total: 0, notes: [err.message], targets: [], filter: filter ?? "", error: err.message });
  }
}

/** Persist a new selection, tell the agent, and echo the new state. */
function applyBoardSelection(selection) {
  const clean = selection && typeof selection === "object" ? selection : null;
  const path = writeBoardConfig(clean, cwd);
  config.board = clean ?? undefined;
  if (agent) {
    agent.config.board = config.board;
    agent.refreshSystemPrompt(
      clean
        ? `The user changed the board selection in the Board pane${clean.port ? ` to port ${clean.port}` : ""}${clean.target ? `, target ${clean.target}` : ""}.`
        : "The user cleared the board selection in the Board pane.",
    );
  }
  send({ type: "board_selection", selection: config.board ?? {}, path });
  sendBoardState("project", boardStateCached());
  void emitBoardState("auto");
}

function serialStatus() {
  return {
    open: Boolean(serial),
    port: serial?.port ?? null,
    baud: serial?.baud ?? null,
    buffered: serial ? serial.buffer.peek().length : 0,
    queued: serial ? serial.buffer.queued : 0,
  };
}

function flushSerial() {
  if (!serial) return;
  const batch = serial.buffer.drain(300);
  if (batch.lines.length > 0 || batch.dropped > 0) {
    send({ type: "serial_lines", port: serial.port, dropped: batch.dropped, lines: batch.lines });
  }
  if (serial && batch.remaining > 0) setImmediate(flushSerial);
}

function disposeSerial() {
  if (!serial) return;
  if (serial.timer) clearInterval(serial.timer);
  try {
    serial.handle.close();
  } catch {
    /* already gone */
  }
  serial = null;
}

function serialError(message) {
  send({ type: "serial_state", open: false, port: null, baud: null, error: message });
}

/**
 * Start the configured MCP servers and give their tools to the agent. Failures
 * are reported as notices: one broken server must not block the session.
 */
/**
 * Run the browser authorization flow for a remote MCP server.
 *
 * The host cannot open a browser itself (it is a plain Node process beside the
 * window), so it asks the renderer to do it and waits for the loopback
 * redirect. When the user is not there — a headless run, or a window that never
 * answered — the flow is abandoned rather than left pending.
 */
async function authorizeMcpServer(options) {
  if (!ui || ui.canPrompt === false) return null;
  send({
    type: "notice",
    level: "info",
    text: `MCP: ${options.server} requires authorization; a browser window will open`,
  });
  return interactiveAuthorize({
    server: options.server,
    resourceUrl: options.resourceUrl,
    metadata: options.metadata,
    scope: options.scope,
    open: (url) => send({ type: "open_external", url }),
    log: (line) => send({ type: "notice", level: "dim", text: line }),
  });
}

async function startMcp() {
  for (const client of mcpClients) client.dispose();
  mcpClients = [];
  mcpByServer = new Map();
  let loaded;
  try {
    loaded = await loadMcpTools(cwd, 15_000, askElicitation, authorizeMcpServer);
  } catch (err) {
    send({ type: "notice", level: "warn", text: `MCP: ${err.message}` });
    return;
  }
  mcpClients = loaded.clients;
  mcpByServer = loaded.byServer;
  // MCP prompts become slash commands; a project's own command with the same
  // name wins, so this list is only the servers' contribution.
  mcpPrompts = loaded.prompts;
  // A server that adds or removes a tool announces it instead of waiting for a
  // restart. Re-list that one server and replace its tools in place; the other
  // servers' tools are untouched.
  loaded.onRefresh = (server, kind) => {
    if (kind !== "tools") {
      // Resources and prompts are re-read on the next session; the transcript
      // only needs to know the list moved.
      send({ type: "notice", level: "dim", text: `MCP: ${server} announced a ${kind} change` });
      return;
    }
    const client = loaded.byServer.get(server);
    if (!client || !agent) return;
    void refreshServerTools(server, client)
      .then((tools) => {
        agent.replaceToolsByPrefix(`mcp__${server}__`, tools);
        send({ type: "notice", level: "dim", text: `MCP: ${server} now has ${tools.length} tool(s)` });
      })
      .catch((err) => send({ type: "notice", level: "warn", text: `MCP: could not refresh ${server}: ${err.message}` }));
  };
  if (loaded.tools.length > 0) {
    agent?.addTools(loaded.tools);
    send({ type: "notice", level: "dim", text: `MCP: ${loaded.tools.length} tool(s) loaded` });
  }
  if (loaded.prompts.length > 0) {
    send({ type: "notice", level: "dim", text: `MCP: ${loaded.prompts.length} prompt(s) available as commands` });
  }
  for (const error of loaded.errors) send({ type: "notice", level: "warn", text: `MCP: ${error}` });
}

/**
 * Answer a server's `elicitation/create`.
 *
 * The protocol exists so a tool can ask a question mid-call ("which branch?",
 * "the target directory does not exist — create it?"). It is answered through
 * the same composer prompt the permission bar uses, so the question appears
 * where the user already answers things. A run with nobody behind it declines:
 * accepting on the user's behalf would be exactly the wrong default.
 */
async function askElicitation(server, request) {
  const questions = elicitationQuestions(request ?? { message: "" });
  if (!ui || ui.canPrompt === false) return { action: "decline" };
  const message = String(request?.message ?? "").trim() || `${server} is asking for input`;
  if (questions.length === 0) {
    const verdict = await ui.confirm(`${server}: ${message}`);
    return verdict === "no" ? { action: "decline" } : { action: "accept", content: {} };
  }
  const content = {};
  for (const question of questions) {
    // A bounded set of choices maps onto the existing option prompt; a free
    // field has no good terminal shape, so it is declined rather than faked.
    if (!question.options || question.options.length === 0) {
      send({ type: "notice", level: "warn", text: `MCP: ${server} asked for "${question.label}" as free text; answer it from the server's own UI` });
      return { action: "decline" };
    }
    const chosen = await ui.ask?.(`${server}: ${message} — ${question.label}`, question.options.map((value) => ({ value, label: value })));
    if (chosen === undefined || chosen === null || chosen === "") return { action: "decline" };
    content[question.name] = chosen;
  }
  return { action: "accept", content };
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

/** Archive sessions untouched for `days` days; the current one is never touched. */
function archiveInactive(days) {
  const cutoff = Date.now() - Math.max(1, days) * 86_400_000;
  let archived = 0;
  for (const session of listSessions(false)) {
    if (session.id === sessionId || session.archived) continue;
    if (new Date(session.updatedAt).getTime() >= cutoff) continue;
    updateSessionFlags(session.id, { archived: true });
    archived++;
  }
  if (archived > 0) {
    sendSessions();
    send({ type: "notice", level: "dim", text: `archived ${archived} inactive session(s)` });
  }
}

/**
 * Flush the transcript during a running turn.
 *
 * The save used to happen only when the turn ended, so a crash, a kill, or a
 * closed window lost the entire turn — the file's own comment promised "a
 * crash loses at most the last line". A timer writes the append-only tail
 * while the turn runs; `saveSession` appends only what is new, so the cost is
 * proportional to the new messages, not the whole conversation.
 */
let midTurnTimer = null;
function scheduleMidTurnPersist() {
  if (midTurnTimer) return;
  midTurnTimer = setTimeout(function tick() {
    midTurnTimer = null;
    if (running) {
      persist();
      midTurnTimer = setTimeout(tick, 5000);
    }
  }, 5000);
  midTurnTimer.unref?.();
}

async function runPrompt(text, images) {
  if (running) {
    // A message typed mid-turn is queued and delivered at the next tool
    // boundary; the renderer already echoed it into the transcript.
    agent.enqueue(text);
    send({ type: "queued", count: agent.queuedCount });
    return { ok: true, queued: true };
  }
  running = true;
  setSessionStatus("working");
  turnBaseline = new Map();
  const usageBefore = { ...agent.usage };
  const usageBeforeBySource = {
    subagent: { ...agent.usageBySource.subagent },
    background: { ...agent.usageBySource.background },
  };
  markRunActive({ sessionId, cwd, startedAt: new Date().toISOString() });
  send({ type: "queued", count: 0 });
  send({ type: "run_start" });
  scheduleMidTurnPersist();
  let ok = true;
  try {
    if (Array.isArray(images) && images.length > 0) {
      await agent.runWithParts(text, images.map((url) => ({ type: "image_url", image_url: { url } })));
    } else {
      await agent.run(text);
    }
  } catch (err) {
    ok = false;
    const message = err instanceof Error ? err.message : String(err);
    if (err?.name !== "AbortError") {
      send({ type: "error", message });
      setSessionStatus("error");
    }
  } finally {
    running = false;
    setSessionStatus("ready");
    clearRunActive();
    ui.assistantEnd();
    ui.thinkingEnd();
    persist();
    if (midTurnTimer) {
      clearTimeout(midTurnTimer);
      midTurnTimer = null;
    }
    // Persist this turn's spend before the next one starts, so the Usage page
    // has real history instead of a number that dies with the process.
    recordUsage({
      sessionId,
      cwd,
      model: agent.lastUsedModel || config.model,
      inputTokens: agent.usage.inputTokens - usageBefore.inputTokens,
      outputTokens: agent.usage.outputTokens - usageBefore.outputTokens,
      cachedTokens: agent.usage.cachedTokens - usageBefore.cachedTokens,
      source: "main",
    });
    // Sub-agents spend real money too. Recording only the total put the whole
    // bill on the main loop, so `delegate` looked free instead of expensive.
    for (const kind of ["subagent", "background"]) {
      const spent = agent.usageBySource[kind];
      const delta = {
        inputTokens: spent.inputTokens - (usageBeforeBySource[kind]?.inputTokens ?? 0),
        outputTokens: spent.outputTokens - (usageBeforeBySource[kind]?.outputTokens ?? 0),
        cachedTokens: spent.cachedTokens - (usageBeforeBySource[kind]?.cachedTokens ?? 0),
      };
      if (delta.inputTokens !== 0 || delta.outputTokens !== 0) {
        recordUsage({ sessionId, cwd, model: agent.lastUsedModel || config.model, ...delta, source: kind });
      }
    }
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
  return { ok };
}

/** 正在进行的安装；同时只允许一个，取消就是 abort 它。 */
let packAbort = null;

/** 正在跑的自主循环；同一时刻只允许一个。 */
let goalRun = null;

/**
 * The most recent assistant text in this session.
 *
 * Used as a round's conclusion when driving an autonomous loop. It is a
 * summary in the loose sense — whatever the model said last — but the driver
 * only compares consecutive values to notice a stall, so precision is not the
 * point; being comparable is.
 */
function lastAssistantText() {
  const messages = agent?.messages ?? [];
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role !== "assistant") continue;
    if (typeof message.content === "string") return message.content.trim();
    if (Array.isArray(message.content)) {
      const text = message.content
        .filter((part) => part && part.type === "text")
        .map((part) => part.text)
        .join(" ");
      if (text.trim()) return text.trim();
    }
  }
  return "";
}

async function handle(cmd) {
  switch (cmd.cmd) {
    case "init": {
      if (cmd.cwd && existsSync(cmd.cwd)) {
        cwd = canonicalCwd(cmd.cwd);
        process.chdir(cwd);
      }
      if (isLocale(cmd.locale)) locale = cmd.locale;
      try {
        config = loadConfig({ permissionMode: cmd.mode });
      } catch (err) {
        send({ type: "fatal", message: err.message });
        return;
      }
      client = makeClient();
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
      // 上次被强杀留下的半截事务不该一直占着几个 GB。清理是后台的，
      // 而且只删够老的目录 —— 另开一个窗口正在装的包不受影响。
      void pruneTmp()
        .then((result) => {
          if (result.removed.length > 0) {
            send({
              type: "notice",
              level: "info",
              text: `cleaned up ${result.removed.length} abandoned toolchain download(s), ${(result.bytes / 1048576).toFixed(0)} MB`,
            });
          }
        })
        .catch(() => {
          /* 清理失败不影响任何事，下次再说 */
        });
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
    // ---- 工具链包 ----
    // 安装会跑几分钟，所以进度要一边跑一边发；取消用 AbortController 记住。
    case "getPacks": {
      try {
        const summary = packsSummary();
        // 本机检测结果与已安装的 pack 一起发：用户打开这一页想知道的是
        // "我有什么、还缺什么"，而不是"这个应用自己下过什么"。两者分开
        // 显示会让人误以为 Board 面板里看到的 pyocd 不归这里管。
        let detected = null;
        try {
          const report = await detectToolchains();
          detected = {
            tools: report.tools.map((tool) => ({
              kind: tool.kind,
              path: tool.path,
              version: tool.version,
              source: tool.source,
              problem: tool.problem,
            })),
            missing: report.missing,
            searchPaths: report.searchPaths,
          };
        } catch {
          /* detection is optional; the pack list is still worth showing */
        }
        send({
          type: "packs",
          root: summary.root,
          freeBytes: summary.freeBytes,
          totalBytes: summary.totalBytes,
          detected,
          // The renderer cannot import the TypeScript module, and the labels
          // are part of the answer rather than decoration: send the table.
          toolchains: Object.entries(TOOLCHAIN_INFO).map(([kind, info]) => ({ kind, ...info })),
          packs: summary.packs.map((pack) => ({
            manifest: {
              id: pack.manifest.id,
              name: pack.manifest.name,
              version: pack.manifest.version,
              provides: pack.manifest.provides,
              license: pack.manifest.license,
            },
            bytes: pack.bytes,
            status: pack.status,
            problem: pack.problem,
          })),
        });
      } catch (error) {
        send({ type: "notice", level: "warn", text: `toolchain packs: ${error.message}` });
      }
      return;
    }
    case "getPackCatalog": {
      try {
        // includeUnverified: 目录里没填哈希的条目也列出来，但标成不可安装 ——
        // 静默隐藏会让用户以为"没有这个工具链"，而不是"还没准备好"。
        send({
          type: "pack_catalog",
          entries: catalogFor(undefined, undefined, { includeUnverified: true }).map((entry) => ({
            id: entry.id,
            name: entry.name,
            version: entry.version,
            downloadBytes: entry.downloadBytes,
            provides: entry.provides,
            installable: isInstallable(entry),
          })),
        });
      } catch (error) {
        send({ type: "notice", level: "warn", text: `toolchain catalog: ${error.message}` });
      }
      return;
    }
    case "installPack": {
      const entry = catalogFor(undefined, undefined, { includeUnverified: true }).find((item) => item.id === cmd.id);
      if (!entry) {
        send({ type: "pack_error", id: cmd.id, message: "no such pack in the catalog" });
        return;
      }
      if (!isInstallable(entry)) {
        send({ type: "pack_error", id: cmd.id, message: "this pack has not been checksummed yet and cannot be installed" });
        return;
      }
      packAbort?.abort();
      packAbort = new AbortController();
      const controller = packAbort;
      // 不 await：命令循环必须继续响应，否则用户在下载时点取消都没反应。
      installPack(toInstallEntry(entry), {
        signal: controller.signal,
        onProgress: (progress) => send({ type: "pack_progress", ...progress }),
      })
        .then(() => {
          resetToolchainCache();
          send({ type: "pack_installed", id: entry.id });
          handle({ cmd: "getPacks" });
        })
        .catch((error) => {
          send({ type: "pack_error", id: entry.id, message: error.message });
        })
        .finally(() => {
          if (packAbort === controller) packAbort = null;
        });
      return;
    }
    case "cancelPack": {
      packAbort?.abort();
      packAbort = null;
      return;
    }
    // 离线安装：用户手上是别人拷过来的 pack.json + 压缩包，机器连不上
    // 工具链的下载站。校验照样做，哈希来自那个 pack.json。
    case "installFromManifest": {
      packAbort?.abort();
      packAbort = new AbortController();
      const controller = packAbort;
      installFromManifest(cmd.path, {
        signal: controller.signal,
        localFiles: Array.isArray(cmd.files) && cmd.files.length > 0 ? cmd.files : undefined,
        onProgress: (progress) => send({ type: "pack_progress", ...progress }),
      })
        .then((manifest) => {
          resetToolchainCache();
          send({ type: "pack_installed", id: manifest.id });
          handle({ cmd: "getPacks" });
        })
        .catch((error) => {
          send({ type: "pack_error", id: null, message: error.message });
        })
        .finally(() => {
          if (packAbort === controller) packAbort = null;
        });
      return;
    }
    case "removePack": {
      try {
        await removePack(cmd.id);
        resetToolchainCache();
        handle({ cmd: "getPacks" });
      } catch (error) {
        send({ type: "pack_error", id: cmd.id, message: error.message });
      }
      return;
    }
    case "verifyPack": {
      verifyPack(cmd.id, { onProgress: (progress) => send({ type: "pack_progress", ...progress }) })
        .then((result) => {
          send({ type: "pack_verified", id: cmd.id, ok: result.ok, problems: result.problems });
        })
        .catch((error) => send({ type: "pack_error", id: cmd.id, message: error.message }));
      return;
    }
    case "prunePacks": {
      const result = await pruneTmp();
      send({ type: "pack_pruned", removed: result.removed.length, bytes: result.bytes });
      handle({ cmd: "getPacks" });
      return;
    }
    case "getSettings":
      send({
        type: "settings",
        settings: {
          provider: config?.provider ?? providerFor(config?.baseUrl ?? "").id,
          providers: publicProviders(),
          baseUrl: config?.baseUrl ?? "",
          apiKeyMasked: maskKey(config?.apiKey ?? ""),
          model: config?.model ?? "",
          models: pickerModels(),
          mode: config?.permissionMode ?? "ask",
          effort: config?.thinkingEffort ?? "auto",
          maxTokens: config?.maxTokens ?? 16000,
          autoApprove: config?.autoApprove ?? [],
          fallbackModels: config?.fallbackModels ?? [],
          sandbox: config?.sandbox ?? "enforce",
          networkPolicy: config?.networkPolicy ?? "off",
          echoReasoning: Boolean(config?.echoReasoning),
          rules: loadRules().map((rule) => ({
            id: rule.id,
            tool: rule.tool,
            match: rule.match ?? "",
            action: rule.action,
            scope: rule.scope,
            cwd: rule.cwd ?? "",
          })),
          contextWindow: config?.contextWindow ?? 128_000,
          modelContext: config ? catalog.models.find((model) => model.id === config.model)?.contextLength ?? null : null,
          locale,
          theme: uiPrefs.theme ?? "dark",
          density: uiPrefs.density ?? "balanced",
          fontScale: uiPrefs.fontScale ?? 1,
          transcriptWidth: uiPrefs.transcriptWidth ?? "standard",
          transcriptView: uiPrefs.transcriptView ?? "normal",
          reduceMotion: Boolean(uiPrefs.reduceMotion),
          codeFont: uiPrefs.codeFont ?? "",
          notifications: uiPrefs.notifications !== false,
          keepAwake: Boolean(uiPrefs.keepAwake),
          branchPrefix: uiPrefs.branchPrefix ?? "prometheus/",
          outputStyle: uiPrefs.outputStyle ?? "default",
          archiveAfterDays: uiPrefs.archiveAfterDays ?? 0,
        },
      });
      return;
    case "setUiPreference": {
      // Appearance and behaviour toggles apply immediately and survive restarts;
      // the Settings dialog sends them one at a time, with no Save step.
      const key = String(cmd.key ?? "");
      const value = cmd.value;
      const allowed = new Set([
        "theme",
        "density",
        "fontScale",
        "transcriptWidth",
        "transcriptView",
        "reduceMotion",
        "codeFont",
        "notifications",
        "keepAwake",
        "branchPrefix",
        "outputStyle",
        "archiveAfterDays",
      ]);
      if (!allowed.has(key)) return;
      writeUiSettings({ [key]: value });
      uiPrefs = { ...uiPrefs, [key]: value };
      if (key === "outputStyle" && agent) {
        agent.outputStyle = ["concise", "explanatory"].includes(value) ? value : "default";
        agent.refreshSystemPrompt(`The response style is now "${agent.outputStyle}".`);
      }
      if (key === "archiveAfterDays" && Number(value) > 0) archiveInactive(Number(value));
      send({ type: "ui_preference", key, value });
      return;
    }
    case "getUsage":
      send({ type: "usage_summary", days: Number(cmd.days) || 30, summary: usageSummary(Number(cmd.days) || 30) });
      return;
    case "getMcp":
      send({ type: "mcp_servers", servers: listMcpServers(cwd) });
      return;
    case "saveMcpServer":
      try {
        saveMcpServer(cwd, {
          name: String(cmd.server?.name ?? "").trim(),
          scope: cmd.server?.scope === "project" ? "project" : "user",
          command: typeof cmd.server?.command === "string" ? cmd.server.command.trim() : undefined,
          args: Array.isArray(cmd.server?.args) ? cmd.server.args.map(String) : String(cmd.server?.args ?? "").split(/\s+/).filter(Boolean),
          url: typeof cmd.server?.url === "string" ? cmd.server.url.trim() : undefined,
          disabled: Boolean(cmd.server?.disabled),
        });
        send({ type: "mcp_servers", servers: listMcpServers(cwd) });
        if (!running) void startMcp();
      } catch (err) {
        send({ type: "notice", level: "error", text: `MCP: ${err.message}` });
      }
      return;
    case "removeMcpServer":
      removeMcpServer(cwd, cmd.scope === "project" ? "project" : "user", String(cmd.name ?? ""));
      send({ type: "mcp_servers", servers: listMcpServers(cwd) });
      if (!running) void startMcp();
      return;
    case "getSkills":
      send({ type: "skills", skills: listSkills(cwd) });
      return;
    case "saveSkill":
      try {
        saveSkill(cwd, {
          name: String(cmd.skill?.name ?? ""),
          description: String(cmd.skill?.description ?? ""),
          argumentHint: String(cmd.skill?.argumentHint ?? ""),
          scope: cmd.skill?.scope === "project" ? "project" : "user",
          body: String(cmd.skill?.body ?? ""),
        });
        send({ type: "skills", skills: listSkills(cwd) });
        send({ type: "commands", commands: availableCommands() });
      } catch (err) {
        send({ type: "notice", level: "error", text: `skill: ${err.message}` });
      }
      return;
    case "removeSkill":
      removeSkill(cwd, cmd.scope === "project" ? "project" : "user", String(cmd.name ?? ""));
      send({ type: "skills", skills: listSkills(cwd) });
      send({ type: "commands", commands: listCommands(cwd).map(({ name, description, argumentHint }) => ({ name, description, argumentHint })) });
      return;
    case "getInstructions":
      send({ type: "instructions", text: readInstructions() });
      return;
    case "saveInstructions":
      writeInstructions(String(cmd.text ?? ""));
      agent?.refreshSystemPrompt();
      send({ type: "instructions", text: readInstructions() });
      return;
    case "getMemory":
      send({ type: "memory", global: readMemorySections("global"), project: readMemorySections("project") });
      return;
    case "deleteMemory":
      deleteMemory(cmd.scope === "project" ? "project" : "global", String(cmd.name ?? ""));
      agent?.refreshSystemPrompt();
      send({ type: "memory", global: readMemorySections("global"), project: readMemorySections("project") });
      return;
    case "saveSettings": {
      const patch = cmd.settings ?? {};
      const filePatch = {};
      // Switching provider swaps the base URL to the registry's endpoint unless
      // the user also typed one; the key field stays whatever they entered.
      if (typeof patch.provider === "string" && patch.provider.trim()) {
        const provider = publicProviders().find((entry) => entry.id === patch.provider.trim());
        if (provider) {
          filePatch.provider = provider.id;
          if (!(typeof patch.baseUrl === "string" && patch.baseUrl.trim())) filePatch.baseUrl = provider.baseUrl;
        }
      }
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
      if (patch.sandbox === "off" || patch.sandbox === "enforce") filePatch.sandbox = patch.sandbox;
      if (["off", "proxy", "open"].includes(patch.networkPolicy)) filePatch.networkPolicy = patch.networkPolicy;
      if (typeof patch.fallbackModels === "string" || Array.isArray(patch.fallbackModels)) {
        const list = Array.isArray(patch.fallbackModels) ? patch.fallbackModels : String(patch.fallbackModels).split(",");
        filePatch.fallbackModels = list.map((model) => String(model).trim()).filter((model) => model && model !== String(patch.model ?? ""));
      }
      if (typeof patch.autoApprove === "string" || Array.isArray(patch.autoApprove)) {
        const list = Array.isArray(patch.autoApprove) ? patch.autoApprove : String(patch.autoApprove).split(",");
        filePatch.autoApprove = list.map((name) => String(name).trim()).filter(Boolean);
      }
      // Providers whose tool loop needs the previous reasoning echoed back.
      // Off is the safe default: an unknown field on another gateway is a 400.
      if (typeof patch.echoReasoning === "boolean") filePatch.echoReasoning = patch.echoReasoning;
      try {
        writeConfigFile(filePatch);
        const uiPatch = {};
        if (isLocale(patch.locale)) uiPatch.locale = patch.locale;
        if (["dark", "light", "system"].includes(patch.theme)) uiPatch.theme = patch.theme;
        if (["compact", "balanced", "detailed"].includes(patch.density)) uiPatch.density = patch.density;
        if (Number.isFinite(Number(patch.fontScale))) uiPatch.fontScale = Math.max(0.85, Math.min(1.3, Number(patch.fontScale)));
        if (["narrow", "standard", "wide"].includes(patch.transcriptWidth)) uiPatch.transcriptWidth = patch.transcriptWidth;
        if (["normal", "thinking", "verbose"].includes(patch.transcriptView)) uiPatch.transcriptView = patch.transcriptView;
        if (typeof patch.reduceMotion === "boolean") uiPatch.reduceMotion = patch.reduceMotion;
        if (typeof patch.codeFont === "string") uiPatch.codeFont = patch.codeFont.slice(0, 80);
        if (typeof patch.notifications === "boolean") uiPatch.notifications = patch.notifications;
        if (typeof patch.keepAwake === "boolean") uiPatch.keepAwake = patch.keepAwake;
        if (typeof patch.branchPrefix === "string") uiPatch.branchPrefix = patch.branchPrefix.trim().slice(0, 40) || "prometheus/";
        if (["default", "concise", "explanatory"].includes(patch.outputStyle)) uiPatch.outputStyle = patch.outputStyle;
        if (Number.isFinite(Number(patch.archiveAfterDays))) {
          uiPatch.archiveAfterDays = Math.max(0, Math.min(365, Math.round(Number(patch.archiveAfterDays))));
        }
        if (Object.keys(uiPatch).length > 0) {
          writeUiSettings(uiPatch);
          uiPrefs = { ...uiPrefs, ...uiPatch };
        }
        if (isLocale(patch.locale)) locale = patch.locale;
        // The output style is part of the system prompt, so the agent has to
        // be told about it before the next turn rather than at the next restart.
        if (patch.outputStyle !== undefined) {
          agent.outputStyle = uiPrefs.outputStyle ?? "default";
          agent.refreshSystemPrompt(`The response style is now "${agent.outputStyle}".`);
        }
        // The live mode may have been changed from the composer without being
        // written to disk; keep it unless this save explicitly sets a new one.
        const liveMode = config.permissionMode;
        config = loadConfig();
        if (!["ask", "auto", "plan"].includes(patch.mode)) config.permissionMode = liveMode;
        client = makeClient();
        permissions.mode = config.permissionMode;
        agent.config.model = config.model;
        agent.config.maxTokens = config.maxTokens;
        agent.config.contextWindow = config.contextWindow;
        agent.config.autoApprove = config.autoApprove;
        agent.config.fallbackModels = config.fallbackModels;
        agent.config.sandbox = config.sandbox;
        agent.config.networkPolicy = config.networkPolicy;
        agent.config.thinkingEffort = config.thinkingEffort;
        agent.config.permissionMode = config.permissionMode;
        agent.config.echoReasoning = config.echoReasoning;
        agent.refreshSystemPrompt();
        emitState();
        // Only a connection change invalidates the catalog; a slider or a
        // permission toggle must not spend a network round-trip.
        if (!cmd.skipCatalog) void refreshCatalog(true);
        send({ type: "settings_saved", ok: true });
      } catch (err) {
        send({ type: "settings_saved", ok: false, error: err.message });
      }
      return;
    }
    case "prompt": {
      // A known slash command expands into its prompt; anything else is sent
      // verbatim so a message starting with "/" is never swallowed.
      const expanded = await expandAnySlash(String(cmd.text ?? ""));
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
      // The model picked in the composer is the default from now on; keeping it
      // in memory only made a restart silently switch back.
      try {
        writeConfigFile({ model: cmd.model });
      } catch {
        /* a read-only config is not a reason to refuse the switch */
      }
      applyModelContext(cmd.model);
      agent.refreshSystemPrompt();
      ui.setModelName(cmd.model);
      emitState();
      return;
    }
    case "newSession": {
      if (running) return send({ type: "notice", level: "warn", text: "stop the current turn first" });
      releaseSessionLock(sessionId);
      sessionId = newSessionId();
      sessionTitle = "";
      createAgent([]);
      // The new session exists on disk only after the first persist; take its
      // lock now so two windows cannot both create the same id.
      const claimed = acquireSessionLock(sessionId, "desktop window");
      if (!claimed.ok) send({ type: "notice", level: "warn", text: lockConflictMessage(sessionId, claimed.holder) });
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
      // Two windows writing one JSONL interleave their appends and corrupt the
      // message count; refuse the second writer instead of forking the
      // conversation on disk.
      const claim = acquireSessionLock(session.id, "desktop window");
      if (!claim.ok) {
        send({ type: "notice", level: "error", text: lockConflictMessage(session.id, claim.holder) });
        return;
      }
      if (session.cwd && existsSync(session.cwd) && session.cwd !== cwd) {
        cwd = canonicalCwd(session.cwd);
        process.chdir(cwd);
        disposeTerminal();
        try {
          config = loadConfig({});
        } catch {
          /* keep existing config */
        }
      }
      releaseSessionLock(sessionId);
      sessionId = session.id;
      sessionTitle = session.title ?? "";
      // Restore what the conversation was running with. A plan-mode session
      // reopened in auto mode is a different agent, and a resumed conversation
      // should not silently gain write access it never had.
      if (session.mode) config.permissionMode = session.mode;
      if (session.effort) {
        config.thinkingEffort = session.effort;
        if (client) client.options.reasoningEffort = session.effort;
      }
      createAgent(session.messages);
      sessionCreatedAt = session.createdAt;
      send({
        type: "session_loaded",
        messages: publicMessages(session.messages),
        cwd,
        mode: config.permissionMode,
        effort: config.thinkingEffort,
      });
      emitState();
      return;
    }
    case "forkSession": {
      // Branch the conversation into a new session: the original stays as it
      // was, so trying a different direction does not overwrite history.
      if (running) return send({ type: "notice", level: "warn", text: "stop the current turn first" });
      const source = loadSession(cmd.id ?? sessionId);
      if (!source) return send({ type: "notice", level: "error", text: "session not found" });
      if (source.cwd && existsSync(source.cwd) && source.cwd !== cwd) {
        cwd = canonicalCwd(source.cwd);
        process.chdir(cwd);
        disposeTerminal();
      }
      releaseSessionLock(sessionId);
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
      sendSessions({ includeArchived: Boolean(cmd.includeArchived), limit: cmd.limit });
      return;
    case "sessionFlags": {
      const updated = updateSessionFlags(String(cmd.id), {
        title: cmd.title,
        pinned: cmd.pinned,
        archived: cmd.archived,
      });
      if (!updated) return send({ type: "notice", level: "error", text: `session not found: ${cmd.id}` });
      sendSessions({ includeArchived: Boolean(cmd.includeArchived), limit: cmd.limit });
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
      // Another window may have it open; deleting the files under a live
      // writer leaves that window appending into a directory that no longer
      // exists.
      const holder = sessionLockHolder(String(cmd.id));
      if (holder) {
        return send({ type: "notice", level: "warn", text: lockConflictMessage(String(cmd.id), holder) });
      }
      removeSessionLockFile(String(cmd.id));
      const deleted = deleteSessionFile(String(cmd.id));
      sendSessions({ includeArchived: Boolean(cmd.includeArchived), limit: cmd.limit });
      if (!deleted) send({ type: "notice", level: "error", text: `session not found: ${cmd.id}` });
      return;
    }
    // ---- 目标板与串口 ----
    case "getBoardState": {
      void emitBoardState(cmd.refresh === "all" ? "all" : "auto");
      return;
    }
    case "getBoardTargets": {
      void emitBoardTargets(cmd.filter);
      return;
    }
    case "setBoardSelection": {
      try {
        applyBoardSelection(cmd.selection);
      } catch (err) {
        send({ type: "notice", level: "error", text: `could not save the board selection: ${err.message}` });
      }
      return;
    }
    case "serialOpen": {
      if (running) return send({ type: "notice", level: "warn", text: "stop the current turn before opening the serial port" });
      disposeSerial();
      const state = boardStateProject();
      const port = cmd.port ? String(cmd.port) : state.effective.port;
      const baud = Number(cmd.baud ?? state.effective.baud ?? 115200);
      if (!port) {
        return serialError("no serial port selected. Pick one in the Board pane.");
      }
      let handle;
      try {
        handle = openPort(port, baud, { assertDtr: Boolean(cmd.assertDtr ?? state.effective.assertDtr) });
      } catch (err) {
        // "Already open in this process" is the monitor-versus-agent conflict;
        // the raw message names the port, which is what the user needs.
        return serialError(err.message);
      }
      const buffer = new SerialLineBuffer();
      serial = { port, baud, handle, buffer, timer: null };
      handle.onData((chunk) => serial?.buffer.push(chunk));
      handle.onExit(({ code, error }) => {
        // A disposed handle is expected to exit; only a port that died while
        // we were still using it is worth reporting.
        if (!serial || serial.handle !== handle) return;
        flushSerial();
        disposeSerial();
        send({
          type: "serial_state",
          open: false,
          port,
          baud,
          error: error || `the port closed (exit ${code ?? "?"})`,
        });
      });
      // 50 ms batches, 300 lines each: a talkative firmware becomes a handful of
      // messages per second instead of one per line.
      serial.timer = setInterval(flushSerial, 50);
      send({ type: "serial_state", open: true, port, baud, buffered: 0 });
      return;
    }
    case "serialClose": {
      const port = serial?.port ?? null;
      flushSerial();
      disposeSerial();
      send({ type: "serial_state", open: false, port, baud: null });
      return;
    }
    case "serialClear": {
      serial?.buffer.clear();
      send({ type: "serial_cleared", port: serial?.port ?? null });
      return;
    }
    case "serialStatus": {
      send({ type: "serial_snapshot", ...serialStatus(), lines: serial ? serial.buffer.peek() : [] });
      return;
    }
    case "shutdown": {
      disposeSerial();
      disposeTerminal();
      stopMcp();
      releaseSessionLock(sessionId);
      // Give the last writes a tick to reach stdout before the process goes away.
      setTimeout(() => process.exit(0), 30);
      return;
    }
    case "setCwd": {
      if (running) return send({ type: "notice", level: "warn", text: "stop the current turn first" });
      if (cmd.cwd && existsSync(cmd.cwd)) {
        cwd = canonicalCwd(cmd.cwd);
        process.chdir(cwd);
        disposeTerminal();
        sessionId = newSessionId();
        try {
          // The live mode may have been changed from the composer without being
          // written to disk; switching folders is not a settings save, so the
          // live mode is the one to keep.
          config = loadConfig({ permissionMode: config.permissionMode });
          client = makeClient();
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
        // Caches describe the machine, not the folder, but the project half of
        // the board state does change here; invalidate so the next read rebuilds.
        forgetBoard();
      }
      return;
    }
    // ---- 自主循环 ----
    // goal 和 loop 都是"跑一轮、判断、决定要不要再来一轮"。差别只在终止
    // 条件：goal 问"目标达成了吗"，loop 问"清单上还有没做完的吗"。
    // 驱动器在 src/autoloop.ts，这里的职责只是把一轮接进 agent。
    case "startGoal":
    case "startTaskLoop": {
      if (running) return send({ type: "notice", level: "warn", text: "stop the current turn first" });
      if (goalRun) return send({ type: "notice", level: "warn", text: "a goal loop is already running" });
      const goal = String(cmd.goal ?? "").trim();
      if (cmd.cmd === "startGoal" && !goal) {
        return send({ type: "notice", level: "error", text: "a goal needs a description" });
      }
      const controller = new AbortController();
      const kind = cmd.cmd === "startGoal" ? "goal" : "loop";
      goalRun = { controller, kind, goal };
      const maxRounds = Number(cmd.maxRounds) || 8;
      send({ type: "goal_start", kind, goal, maxRounds });

      const runRound = async (prompt) => {
        const result = await runPrompt(prompt);
        // The round's conclusion is what the driver reasons about. The last
        // assistant text is the closest thing to a summary we have without a
        // second request; an empty one means the turn produced nothing, which
        // the repeated-outcome guard will notice.
        return { ok: result?.ok !== false, summary: lastAssistantText() };
      };

      const finish = (result) => {
        goalRun = null;
        send({ type: "goal_end", kind: result.kind, ...result });
        if (result.stop !== "cancelled") {
          send({ type: "notice", level: result.stop === "goal-met" || result.stop === "task-list-complete" ? "info" : "warn", text: result.detail });
        }
      };

      try {
        if (kind === "goal") {
          const result = await runGoal({
            goal,
            maxRounds,
            signal: controller.signal,
            runRound,
            isGoalMet: ({ goal: target, roundSummary, history }) => agent.assessGoal({ goal: target, roundSummary, history }, controller.signal),
            onRound: (event) => send({ type: "goal_round", ...event }),
          });
          finish({ kind, ...result });
        } else {
          const result = await runTaskLoop({
            maxRounds,
            signal: controller.signal,
            plan: async () =>
              runRound(
                goal
                  ? `Plan the work for this request, then stop:\n\n${goal}\n\nUse todo_write to record the steps. Do not start executing yet.`
                  : "Plan the work for the request above, then stop. Use todo_write to record the steps. Do not start executing yet.",
              ),
            readTasks: () => agent.todos.items,
            runRound,
            onRound: (event) => send({ type: "goal_round", ...event }),
          });
          finish({ kind, ...result });
        }
      } catch (error) {
        goalRun = null;
        send({ type: "goal_end", kind, stop: "failed", rounds: 0, detail: error.message, history: [] });
      }
      return;
    }
    case "stopGoal": {
      goalRun?.controller.abort();
      agent?.abort();
      return;
    }
    case "compact": {
      const before = agent.contextUsage().tokens;
      try {
        // The model writes the recap; the old call used the keyword summary,
        // which made the explicit "compact well" command produce the worst
        // recap of all the paths.
        const result = await agent.compactNow({ ...(cmd.focus ? { focus: String(cmd.focus) } : {}) });
        if (!result) {
          send({ type: "notice", level: "dim", text: "nothing to compact" });
        } else {
          send({
            type: "notice",
            level: "dim",
            text: `compacted (${result.level}): ~${before} -> ~${agent.contextUsage().tokens} tokens`,
          });
        }
      } catch (error) {
        send({ type: "notice", level: "warn", text: error instanceof Error ? error.message : String(error) });
      }
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
    case "removeRule": {
      const removed = removeRule(String(cmd.id ?? ""));
      send({ type: "rules", rules: loadRules(), removed });
      return;
    }
    case "getCheckpoints":
      send({ type: "checkpoints", ...loadCheckpoints(sessionId) });
      return;
    case "rewindTo": {
      // Undo everything after a message: truncate the conversation, restore the
      // files those turns changed, and persist as a new JSONL generation.
      if (running) return send({ type: "notice", level: "warn", text: "stop the current turn first" });
      const requested = Number(cmd.index);
      if (!Number.isFinite(requested) || requested < 1) {
        return send({ type: "notice", level: "error", text: "rewind needs a message index" });
      }
      let index = Math.min(Math.floor(requested), agent.messages.length);
      while (index > 1 && agent.messages[index]?.role !== "user") index--;
      const removed = agent.messages.length - index;
      if (removed <= 0) return send({ type: "notice", level: "warn", text: "nothing to rewind" });

      const files = restoreAfterMessage(sessionId, index);
      agent.messages = agent.messages.slice(0, index);
      resetChanges();
      persist();
      send({ type: "session_loaded", messages: publicMessages(agent.messages), cwd });
      send({ type: "checkpoints", ...loadCheckpoints(sessionId) });
      emitChanges();
      emitState();
      send({ type: "run_end", context: agent.contextUsage(), usage: agent.usage, todos: agent.todos.items, files: changedFiles() });
      const restored = files.restored.length;
      send({
        type: "notice",
        level: files.errors.length ? "warn" : "info",
        text: files.errors.length
          ? `rewound ${removed} message(s), restored ${restored} file(s); ${files.errors.join("; ")}`
          : `rewound ${removed} message(s)` + (restored ? `, restored ${restored} file(s)` : ""),
      });
      return;
    }
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
    case "hookTrust": {
      // A project hook is code the checkout supplies. The Settings page shows
      // what it would run, and only this command records the decision.
      const status = hooksStatus(cwd);
      if (cmd.trust === true) {
        if (!status.exists) return send({ type: "notice", level: "warn", text: "this workspace has no .prometheus/hooks.json" });
        trustProjectHooks(cwd);
        // The running agent loaded its hooks at construction; a fresh decision
        // must apply now, not after a restart.
        if (agent) agent.refreshHooks();
      } else if (cmd.trust === false) {
        revokeProjectHooks(cwd);
        if (agent) agent.refreshHooks();
      }
      send({ type: "hook_status", ...hooksStatus(cwd) });
      return;
    }
    case "getHooks":
      send({ type: "hook_status", ...hooksStatus(cwd) });
      return;
    case "worktreeStart": {
      if (running) return send({ type: "notice", level: "warn", text: "stop the current turn first" });
      if (worktree) return send({ type: "notice", level: "dim", text: "this session is already isolated" });
      baseCwd = cwd;
      // Entering a worktree moves the session, it does not restart it: the
      // conversation is carried across so the user does not watch their
      // history disappear and have to repeat themselves.
      const carried = agent.messages;
      const carriedTodos = [...agent.todos.items];
      const created = await createWorktree(cwd, sessionId, "HEAD", uiPrefs.branchPrefix || "prometheus/");
      if (!created.ok) {
        baseCwd = null;
        return send({ type: "notice", level: "error", text: `worktree: ${created.error}` });
      }
      worktree = created.worktree;
      cwd = worktree.path;
      process.chdir(cwd);
      disposeTerminal();
      createAgent(carried);
      agent.todos.items = carriedTodos;
      send({ type: "session_loaded", messages: publicMessages(carried), cwd });
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
      // /clear keeps the session but drops the conversation. The system
      // prompt is not stored in messages any more (it is rendered per
      // request), so there is nothing to preserve at index 0.
      agent.messages = [];
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
      if (!term.run(String(cmd.command ?? ""))) {
        // `run` refuses while a command is in flight or after the shell exited
        // between the pane's last state and this keystroke. Saying so beats a
        // silently swallowed command.
        send({ type: "notice", level: "warn", text: "the terminal is busy; press Stop before running another command" });
      }
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
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (message.role === "user") {
      if (typeof message.content === "string") {
        out.push({ role: "user", text: message.content, index });
      } else if (Array.isArray(message.content)) {
        const text = message.content.filter((part) => part.type === "text").map((part) => part.text).join(" ");
        const images = message.content.filter((part) => part.type === "image_url").length;
        out.push({ role: "user", text, images, index });
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
  disposeSerial();
  releaseSessionLock(sessionId);
  process.exit(0);
});

process.on("uncaughtException", (err) => {
  send({ type: "error", message: `host crashed: ${err.message}` });
  // A crash must not orphan the PowerShell holding COM7: the next open would
  // fail with "access denied" and look like a hardware fault.
  disposeSerial();
  releaseSessionLock(sessionId);
  process.exit(1);
});

// A clean exit through any other path (SIGINT from a debugger, app quit) also
// gives the session back. A lock left by a killed process is detected as stale
// on the next acquire, so this is a courtesy rather than the safety net.
process.on("exit", () => releaseSessionLock(sessionId));

send({ type: "hello" });
