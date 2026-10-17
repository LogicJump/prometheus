/** Prometheus desktop renderer. */

import { detectLocale, getDict } from "./i18n.js";

/** Saved preferences are restored here; the host gets them on init. */
const savedLocale = localStorage.getItem("prometheus.locale");
const savedTheme = localStorage.getItem("prometheus.theme");

const api = window.prometheus;

const $ = (id) => document.getElementById(id);
const transcript = $("transcript");
const emptyState = $("empty-state");
const input = $("input");
const sendButton = $("send-button");
const stopButton = $("stop-button");
const statusDot = $("status-dot");
const statusText = $("status-text");
const workspacePath = $("workspace-path");
const modeControl = $("mode-control");
const effortControl = $("effort-control");
const modelPicker = $("model-picker");
const modelMenu = $("model-menu");
const modelLabel = $("model-label");
const contextLabel = $("context-label");
const contextFill = $("context-fill");
const usageLabel = $("usage-label");
const pendingPermission = $("pending-permission");
const pendingQuestion = $("pending-question");
const sessionList = $("session-list");
const localeSwitch = $("locale-switch");
const transcriptScroll = $("transcript-scroll");
const workbench = $("workbench");
const workbenchTabs = $("workbench-tabs");
const workbenchMeta = $("workbench-meta");
const diffFilelist = $("diff-filelist");
const diffRoot = $("diff-root");
const fileRoot = $("file-root");
const fileTree = $("file-tree");
const changesList = $("changes-list");
const changesSummary = $("changes-summary");
const checkpointList = $("checkpoint-list");
const sidebarTabs = $("sidebar-tabs");
const terminalRoot = $("terminal-root");
const terminalOutput = $("terminal-output");
const terminalInput = $("terminal-input");
const terminalPrompt = $("terminal-prompt");

const state = {
  busy: false,
  mode: "ask",
  effort: "auto",
  model: "",
  models: [],
  modelsSource: "",
  sessionId: "",
  sessions: [],
  locale: savedLocale === "zh" || savedLocale === "en" ? savedLocale : detectLocale(),
  theme: savedTheme || "dark",
  statusKey: "statusStarting",
  currentAssistant: null,
  currentThinking: null,
  currentTool: null,
  lastToolNode: null,
  pendingPermissionId: null,
  changedFiles: [],
  changes: { files: [], additions: 0, deletions: 0 },
  checkpoints: [],
  selectedChange: null,
  selectedFile: null,
  tree: [],
  pane: "diff",
  sidebarTab: "files",
};

let t = getDict(state.locale);

/* ---------- localization ---------- */

function applyLocale(locale, { announce = false } = {}) {
  state.locale = locale;
  t = getDict(locale);
  localStorage.setItem("prometheus.locale", locale);
  document.documentElement.lang = locale === "zh" ? "zh-CN" : "en";
  document.querySelectorAll("[data-i18n]").forEach((node) => {
    const value = t[node.dataset.i18n];
    if (typeof value === "string") node.textContent = value;
  });
  document.querySelectorAll("[data-prompt-key]").forEach((node) => {
    node.dataset.prompt = t[node.dataset.promptKey] || "";
  });
  document.querySelectorAll("[data-i18n-title]").forEach((node) => {
    const value = t[node.dataset.i18nTitle];
    if (typeof value === "string") node.title = value;
  });
  input.placeholder = t.placeholder;
  terminalInput.placeholder = terminalInput.disabled ? t.terminalExited : t.terminalPlaceholder;
  $("terminal-restart").textContent = t.terminalRestart;
  const terminalTab = workbenchTabs.querySelector('[data-pane="terminal"]');
  if (terminalTab) terminalTab.textContent = t.paneTerminal;
  sendButton.title = `${t.send} (Enter)`;
  stopButton.title = `${t.stop} (Esc)`;
  $("workspace-button").title = t.changeWorkspace;
  $("clear-button").title = t.clearSession;
  $("sidebar-toggle").title = t.sessions;
  $("refresh-sessions").title = t.sessions;
  $("theme-button").title = state.theme === "light" ? "Dark" : "Light";
  modelPicker.title = t.refreshModels;
  if (state.sessions.length > 0) renderSessions(state.sessions);
  localeSwitch.querySelectorAll("button").forEach((button) => {
    button.classList.toggle("active", button.dataset.locale === locale);
  });
  setStatus(state.statusKey);
  if (state.models.length > 0) renderModelMenu();
  if (announce) api.send({ cmd: "setLocale", locale });
  void announce;
}

function statusLabel(key) {
  return t[key] ?? key;
}

/* ---------- utilities ---------- */

function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
}

/** Minimal, dependency-free markdown renderer (headings, lists, code, inline). */
function renderMarkdown(source) {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let i = 0;
  let paragraph = [];

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    out.push(`<p>${inline(paragraph.join(" "))}</p>`);
    paragraph = [];
  };

  const inline = (text) =>
    escapeHtml(text)
      .replace(/`([^`]+)`/g, (_m, code) => `<code>${code}</code>`)
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|\s)\*([^*\s][^*]*)\*/g, "$1<em>$2</em>")
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_m, label, url) => `<a href="${url}">${label}</a>`);

  while (i < lines.length) {
    const line = lines[i];

    if (/^\s*```/.test(line)) {
      const lang = line.trim().replace(/^```/, "") || "text";
      const body = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) {
        body.push(lines[i]);
        i++;
      }
      i++; // closing fence
      out.push(
        `<pre><div class="code-head"><span>${escapeHtml(lang)}</span>` +
          `<button class="code-copy" data-code>${escapeHtml(t.copy)}</button></div>` +
          `<code>${escapeHtml(body.join("\n"))}</code></pre>`,
      );
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushParagraph();
      const level = Math.min(3, heading[1].length);
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      i++;
      continue;
    }

    if (/^\s*([-*])\s+/.test(line) || /^\s*\d+\.\s+/.test(line)) {
      flushParagraph();
      const ordered = /^\s*\d+\.\s+/.test(line);
      const items = [];
      while (i < lines.length && (/^\s*([-*])\s+/.test(lines[i]) || /^\s*\d+\.\s+/.test(lines[i]))) {
        items.push(lines[i].replace(/^\s*([-*]|\d+\.)\s+/, ""));
        i++;
      }
      const tag = ordered ? "ol" : "ul";
      out.push(`<${tag}>${items.map((item) => `<li>${inline(item)}</li>`).join("")}</${tag}>`);
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      flushParagraph();
      const quote = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        quote.push(lines[i].replace(/^\s*>\s?/, ""));
        i++;
      }
      out.push(`<blockquote>${inline(quote.join(" "))}</blockquote>`);
      continue;
    }

    if (line.trim() === "") {
      flushParagraph();
      i++;
      continue;
    }

    paragraph.push(line.trim());
    i++;
  }
  flushParagraph();
  return out.join("");
}

function scrollToBottom(force = false) {
  const target = transcriptScroll || transcript;
  const nearBottom = target.scrollHeight - target.scrollTop - target.clientHeight < 140;
  if (force || nearBottom) target.scrollTop = target.scrollHeight;
}

function hideEmptyState() {
  if (emptyState && !emptyState.hidden) emptyState.hidden = true;
}

function addNode(html) {
  hideEmptyState();
  const wrapper = document.createElement("div");
  wrapper.innerHTML = html;
  const node = wrapper.firstElementChild;
  (transcriptScroll || transcript).appendChild(node);
  scrollToBottom();
  return node;
}

/* ---------- transcript rendering ---------- */

function addUserTurn(text) {
  const queued = state.busy;
  const node = addNode(
    `<div class="turn user${queued ? " queued" : ""}">` +
      `<div class="user-bubble">${escapeHtml(text)}${queued ? `<span class="queued-tag">${escapeHtml(t.queuedTag)}</span>` : ""}</div>` +
      `</div>`,
  );
  node.dataset.queued = queued ? "1" : "";
}

function markQueuedDelivered() {
  const pending = transcript.querySelector('.turn.user.queued');
  if (!pending) return;
  pending.classList.remove("queued");
  pending.dataset.queued = "";
  pending.querySelector(".queued-tag")?.remove();
}

function setQueuedBadge(count) {
  state.queuedCount = count;
  const badge = $("queued-badge");
  if (!badge) return;
  badge.hidden = count <= 0;
  badge.textContent = t.queuedCount(count);
}

function addAssistantTurn() {
  const last = transcript.lastElementChild;
  const node = addNode(`<div class="turn assistant"><div class="markdown"></div></div>`);
  if (last && last.classList.contains("tool-row")) node.classList.add("after-tools");
  state.currentAssistant = { node, body: node.querySelector(".markdown"), text: "", raf: 0 };
  return state.currentAssistant;
}

function flushAssistant() {
  const current = state.currentAssistant;
  if (!current) return;
  if (current.raf) {
    cancelAnimationFrame(current.raf);
    current.raf = 0;
  }
  current.body.innerHTML = renderMarkdown(current.text);
  current.body.classList.remove("streaming");
  state.currentAssistant = null;
  bindCodeCopy(current.node);
}

function bindCodeCopy(root) {
  root.querySelectorAll("[data-code]").forEach((button) => {
    if (button.dataset.bound) return;
    button.dataset.bound = "1";
    button.addEventListener("click", async () => {
      const code = button.closest("pre").querySelector("code").textContent;
      await navigator.clipboard.writeText(code);
      button.textContent = t.copied;
      setTimeout(() => (button.textContent = t.copy), 1200);
    });
  });
}

function addToolRow(name, summary) {
  const glyph = name === "bash" ? "›" : ["read_file", "list_files", "grep", "glob"].includes(name) ? "◦" : "✦";
  const node = addNode(
    `<div class="tool-row running">` +
      `<span class="tool-glyph">${glyph}</span>` +
      `<span class="tool-name">${escapeHtml(name)}</span>` +
      `<span class="tool-summary">${escapeHtml(summary || "")}</span>` +
      `<button class="tool-expand" hidden>${escapeHtml(t.details)}</button>` +
      `</div>`,
  );
  state.currentTool = { node, name, summary };
  state.lastToolNode = node;
  return node;
}

function lastToolRow() {
  return state.lastToolNode && state.lastToolNode.isConnected ? state.lastToolNode : null;
}

function attachToolOutput(node, name, output) {
  if (!output || output.trim() === "") return;
  const row = node;
  const existing = row.nextElementSibling;
  if (existing && existing.classList.contains("tool-output")) {
    existing.textContent = output;
    return;
  }
  const outputNode = document.createElement("pre");
  outputNode.className = "tool-output";
  outputNode.hidden = true;
  outputNode.textContent = output;
  row.after(outputNode);
  const button = row.querySelector(".tool-expand");
  button.hidden = false;
  button.addEventListener("click", () => {
    outputNode.hidden = !outputNode.hidden;
    button.textContent = outputNode.hidden ? t.details : t.hide;
    row.classList.toggle("open", !outputNode.hidden);
    if (!outputNode.hidden) outputNode.scrollTop = outputNode.scrollHeight;
  });
}

function startThinking() {
  if (state.currentThinking) return;
  state.currentThinking = addNode(`<div class="thinking">${escapeHtml(t.thinking)}</div>`);
}

function endThinking() {
  if (state.currentThinking) {
    state.currentThinking.remove();
    state.currentThinking = null;
  }
}

function addNotice(level, text) {
  const cls = level === "warn" ? "warn" : level === "error" ? "error" : level === "dim" ? "dim" : "";
  if (!cls) return;
  addNode(`<div class="notice ${cls}">${escapeHtml(text)}</div>`);
}

function renderPlan(items) {
  document.querySelectorAll(".plan").forEach((node) => node.remove());
  if (!items || items.length === 0) return;
  addNode(
    `<div class="plan"><div class="plan-card">` +
      `<div class="plan-title">${escapeHtml(t.plan)}</div>` +
      items
        .map(
          (item) =>
            `<div class="plan-item ${item.status}"><span class="box">${item.status === "completed" ? "✓" : ""}</span>` +
            `<span class="label">${escapeHtml(item.content)}</span></div>`,
        )
        .join("") +
      `</div></div>`,
  );
}

/* ---------- state ---------- */

function setBusy(busy) {
  state.busy = busy;
  stopButton.hidden = !busy;
  sendButton.disabled = busy;
  setStatus(busy ? "statusWorking" : "statusReady");
}

function setStatus(key) {
  state.statusKey = key;
  const dotKind = key === "statusWorking" || key === "statusConnecting" ? "working" : key.startsWith("statusError") || key === "statusHostStopped" || key === "statusConfigError" ? "error" : "ready";
  statusDot.className = `status-dot ${dotKind}`;
  statusText.textContent = statusLabel(key);
}

/* ---------- notifications ---------- */

/** Only notify when the window is not in front; otherwise the UI already told them. */
function notifyIfAway(title, body) {
  if (!api.notify || !body) return;
  if (document.visibilityState === "visible" && document.hasFocus()) return;
  void api.notify(title, body.slice(0, 180));
}

function summariseLastAssistant() {
  const turns = transcript.querySelectorAll(".turn.assistant .markdown");
  const last = turns[turns.length - 1];
  const text = last?.textContent?.trim() ?? "";
  return text.replace(/\s+/g, " ").slice(0, 160);
}

function updateMeter(context, usage) {
  if (context) {
    const percent = Math.min(100, Math.round(context.percent));
    contextLabel.textContent = `${percent}%`;
    contextFill.style.width = `${percent}%`;
    contextFill.style.background = percent > 85 ? "var(--danger)" : percent > 60 ? "var(--warn)" : "var(--accent)";
  }
  if (usage) {
    const total = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
    usageLabel.textContent = total >= 1000 ? `${(total / 1000).toFixed(1)}k ${t.tokens}` : `${total} ${t.tokens}`;
  }
}

function setMode(mode) {
  state.mode = mode;
  modeControl.querySelectorAll("button").forEach((button) => {
    button.classList.toggle("active", button.dataset.mode === mode);
  });
}

function setEffort(effort) {
  state.effort = effort;
  effortControl.querySelectorAll("button").forEach((button) => {
    button.classList.toggle("active", button.dataset.effort === effort);
  });
}

/* ---------- model picker ---------- */

function renderModels(models, current, source) {
  state.models = models || [];
  state.model = current;
  state.modelsSource = source || "";
  if (current) {
    modelLabel.textContent = current;
    modelPicker.classList.remove("unavailable");
  }
  if (!modelMenu.hidden) renderModelMenu();
}
function renderModelMenu() {
  modelMenu.innerHTML = "";
  if (state.models.length === 0) {
    modelMenu.innerHTML = `<div class="model-empty">${escapeHtml(t.modelsUnavailable)}</div>`;
    return;
  }
  for (const model of state.models) {
    const option = document.createElement("button");
    option.className = `model-option${model.id === state.model ? " active" : ""}`;
    option.setAttribute("role", "option");
    option.setAttribute("aria-selected", String(model.id === state.model));
    const meta = [
      model.contextLength ? `${formatContext(model.contextLength)}` : "",
      model.supportsReasoning ? "reasoning" : "",
      model.supportsVision ? "vision" : "",
    ]
      .filter(Boolean)
      .join(" · ");
    option.innerHTML =
      `<span class="model-id">${escapeHtml(model.id)}</span>` +
      (model.name && model.name !== model.id ? `<span class="model-name">${escapeHtml(model.name)}</span>` : "") +
      (meta ? `<span class="model-meta">${escapeHtml(meta)}</span>` : "");
    option.addEventListener("click", () => {
      api.send({ cmd: "setModel", model: model.id });
      closeModelMenu();
    });
    modelMenu.appendChild(option);
  }
  const footer = document.createElement("button");
  footer.className = "model-refresh";
  footer.textContent = t.refreshModels;
  footer.addEventListener("click", () => {
    modelMenu.innerHTML = `<div class="model-empty">${escapeHtml(t.loadingModels)}</div>`;
    api.send({ cmd: "refreshModels" });
  });
  modelMenu.appendChild(footer);
}

function formatContext(value) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value % 1_000_000 === 0 ? 0 : 1)}M`;
  if (value >= 1000) return `${Math.round(value / 1000)}K`;
  return String(value);
}

function openModelMenu() {
  renderModelMenu();
  modelMenu.hidden = false;
  modelPicker.setAttribute("aria-expanded", "true");
  const active = modelMenu.querySelector(".model-option.active");
  if (active) active.scrollIntoView({ block: "center" });
}

function closeModelMenu() {
  modelMenu.hidden = true;
  modelPicker.setAttribute("aria-expanded", "false");
}

/* ---------- host events ---------- */

function handleEvent(message) {
  switch (message.type) {
    case "hello":
      setStatus("statusConnecting");
      break;

    case "ready":
      setBusy(false);
      if (state.statusKey !== "statusError") setStatus("statusReady");
      break;

    case "state":
      state.sessionId = message.sessionId;
      state.locale = message.locale || state.locale;
      applyLocale(state.locale);
      setMode(message.mode);
      setEffort(message.effort || "auto");
      if (Array.isArray(message.models) && message.models.length > 0) {
        renderModels(message.models, message.model, message.modelsSource);
      } else if (message.model) {
        renderModels(state.models, message.model, state.modelsSource);
      }
      workspacePath.textContent = message.cwd;
      workspacePath.title = message.cwd;
      updateMeter(message.context, message.usage);
      break;

    case "models":
      renderModels(message.models, message.model, message.source);
      break;

    case "changes":
      state.changes = { files: message.files ?? [], additions: message.additions ?? 0, deletions: message.deletions ?? 0 };
      if (message.files?.length > 0 && !message.files.some((file) => file.path === state.selectedChange)) {
        state.selectedChange = message.files[0].path;
      }
      renderChangesPanel();
      if (state.pane === "diff" && !workbench.hidden) renderDiff();
      break;

    case "checkpoints":
      state.checkpoints = message.entries ?? [];
      renderCheckpoints();
      break;

    case "tree": {
      const target = pendingTreeTarget ?? fileTree;
      pendingTreeTarget = null;
      target.innerHTML = "";
      for (const node of message.nodes ?? []) target.appendChild(treeRow(node));
      break;
    }

    case "file":
      renderFilePreview(message.file);
      break;

    case "terminal_output":
      appendTerminalText(message.text ?? "");
      break;

    case "terminal_state":
      setTerminalState(message);
      break;

    case "queued":
      setQueuedBadge(message.count ?? 0);
      break;

    case "user_queued_delivered":
      // The host echoed the message when it reached the model, so the bubble
      // can lose its "queued" marker.
      markQueuedDelivered();
      break;

    case "settings":
      fillSettings(message.settings);
      break;

    case "settings_saved":
      if (message.ok) {
        $("settings-note").textContent = t.settingsSaved;
        setTimeout(() => closeModal(settingsDialog), 700);
      } else {
        $("settings-note").textContent = `${t.settingsError} ${message.error ?? ""}`;
        $("settings-note").style.color = "var(--danger)";
      }
      break;

    case "locale":
      applyLocale(message.locale);
      break;

    case "run_start":
      setBusy(true);
      endThinking();
      break;

    case "assistant_start":
      endThinking();
      if (!state.currentAssistant) addAssistantTurn();
      break;

    case "assistant_delta": {
      endThinking();
      if (!state.currentAssistant) addAssistantTurn();
      const current = state.currentAssistant;
      current.text += message.text;
      if (!current.raf) {
        current.raf = requestAnimationFrame(() => {
          current.raf = 0;
          current.body.innerHTML = `${renderMarkdown(current.text)}<span class="caret"></span>`;
          scrollToBottom();
        });
      }
      break;
    }

    case "assistant_end":
      flushAssistant();
      break;

    case "thinking_start":
      if (state.currentAssistant) flushAssistant();
      startThinking();
      scrollToBottom();
      break;

    case "thinking_end":
      endThinking();
      break;

    case "tool_start":
      endThinking();
      if (state.currentAssistant) flushAssistant();
      addToolRow(message.name, message.summary);
      break;

    case "tool_end": {
      const row = state.currentTool?.node;
      if (row) {
        row.classList.remove("running");
        if (!message.ok) row.classList.add("failed");
        const summaryEl = row.querySelector(".tool-summary");
        if (message.summary) summaryEl.textContent = message.summary;
        if (!message.ok) summaryEl.style.color = "var(--danger)";
        row.querySelector(".tool-glyph").textContent = message.ok ? "✓" : "✕";
        state.currentTool = null;
      }
      break;
    }

    case "tool_output": {
      const row = lastToolRow();
      if (row) attachToolOutput(row, message.name, message.content);
      scrollToBottom();
      break;
    }

    case "todos":
      renderPlan(message.items);
      scrollToBottom();
      break;

    case "permission_request":
      state.pendingPermissionId = message.id;
      pendingQuestion.textContent = message.question;
      pendingPermission.hidden = false;
      pendingPermission.querySelector('[data-permission="yes"]').focus();
      notifyIfAway(t.notifyNeedsInput, message.question);
      break;

    case "notice":
      addNotice(message.level, message.text);
      scrollToBottom();
      break;

    case "error":
      flushAssistant();
      endThinking();
      addNode(`<div class="notice error">${escapeHtml(message.message)}</div>`);
      setBusy(false);
      setStatus("statusError");
      scrollToBottom();
      break;

    case "run_end":
      flushAssistant();
      endThinking();
      setBusy(false);
      updateMeter(message.context, message.usage);
      notifyIfAway(t.notifyTurnDone, summariseLastAssistant());
      if (message.files && message.files.length > 0) {
        const list = message.files.slice(0, 8).map((f) => f.path).join(", ");
        addNode(
          `<div class="notice dim">${escapeHtml(t.changedFiles(message.files.length, list + (message.files.length > 8 ? "…" : "")))}</div>`,
        );
      }
      break;

    case "session_loaded":
      (transcriptScroll || transcript)
        .querySelectorAll(".turn, .tool-row, .tool-output, .notice, .plan, .thinking")
        .forEach((node) => node.remove());
      state.currentAssistant = null;
      state.currentThinking = null;
      state.currentTool = null;
      state.lastToolNode = null;
      for (const item of message.messages || []) {
        if (item.role === "user") addUserTurn(item.text);
        else if (item.role === "assistant") {
          const node = addNode(`<div class="turn assistant"><div class="markdown">${renderMarkdown(item.text)}</div></div>`);
          bindCodeCopy(node);
        } else if (item.role === "tool") {
          addNode(
            `<div class="tool-row"><span class="tool-glyph">✦</span><span class="tool-name">${escapeHtml(item.name)}</span>` +
              `<span class="tool-summary">${escapeHtml(item.summary || "")}</span></div>`,
          );
        }
      }
      if ((message.messages || []).length === 0) {
        (transcriptScroll || transcript).appendChild(emptyState);
        emptyState.hidden = false;
      }
      if (message.cwd) {
        workspacePath.textContent = message.cwd;
        workspacePath.title = message.cwd;
        api.send({ cmd: "getTree", path: "." });
      }
      scrollToBottom(true);
      break;

    case "sessions":
      renderSessions(message.sessions);
      break;

    case "session_saved":
      api.send({ cmd: "listSessions" });
      break;

    case "host_exit":
      setBusy(false);
      setStatus("statusHostStopped");
      break;

    case "fatal":
      setBusy(false);
      setStatus("statusConfigError");
      addNode(`<div class="notice error">${escapeHtml(t.configError(message.message))}</div>`);
      break;

    default:
      if (message.type) console.debug("unhandled host event", message);
  }
}

/* ---------- workbench: diff, file, tree, checkpoints ---------- */

function openWorkbench(pane) {
  state.pane = pane ?? state.pane;
  workbench.hidden = false;
  transcript.classList.add("with-workbench");
  workbenchTabs.querySelectorAll("button").forEach((button) => {
    button.classList.toggle("active", button.dataset.pane === state.pane);
  });
  const showDiff = state.pane === "diff";
  const showTerminal = state.pane === "terminal";
  diffRoot.hidden = !showDiff;
  diffFilelist.hidden = !showDiff || state.changes.files.length === 0;
  fileRoot.hidden = state.pane !== "file";
  terminalRoot.hidden = !showTerminal;
  if (showDiff) renderDiff();
  if (showTerminal) {
    openTerminal();
  }
}

function closeWorkbench() {
  workbench.hidden = true;
  transcript.classList.remove("with-workbench");
}

/* ---------- terminal pane ---------- */

let terminalCwd = "";
let terminalBusy = false;
const terminalLines = [];

function openTerminal() {
  api.send({ cmd: "terminalOpen" });
  terminalInput.focus();
}

/** The pane is a fixed-width transcript, so text is appended as plain lines. */
function appendTerminalText(text) {
  const parts = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  for (let i = 0; i < parts.length; i++) {
    if (i > 0) terminalLines.push("");
    const last = terminalLines.length - 1;
    if (last < 0) terminalLines.push(parts[i]);
    else terminalLines[last] += parts[i];
  }
  while (terminalLines.length > 4000) terminalLines.shift();
  const pinned = terminalOutput.scrollTop + terminalOutput.clientHeight >= terminalOutput.scrollHeight - 24;
  terminalOutput.textContent = terminalLines.join("\n");
  if (pinned) terminalOutput.scrollTop = terminalOutput.scrollHeight;
}

function setTerminalState({ cwd: nextCwd, busy, exited, scrollback }) {
  if (typeof nextCwd === "string" && nextCwd) terminalCwd = nextCwd;
  terminalBusy = Boolean(busy);
  terminalPrompt.textContent = terminalCwd ? `${terminalCwd}>` : ">";
  terminalPrompt.title = terminalCwd;
  terminalInput.disabled = Boolean(exited);
  terminalInput.placeholder = exited ? t.terminalExited : t.terminalPlaceholder;
  if (typeof scrollback === "string") {
    terminalLines.length = 0;
    if (scrollback) appendTerminalText(scrollback);
    terminalOutput.scrollTop = terminalOutput.scrollHeight;
  }
}

terminalInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.isComposing) {
    event.preventDefault();
    const command = terminalInput.value;
    if (!command.trim()) return;
    terminalInput.value = "";
    api.send({ cmd: "terminalRun", command });
  } else if (event.ctrlKey && event.key.toLowerCase() === "c") {
    event.preventDefault();
    api.send({ cmd: "terminalInterrupt" });
  }
});

$("terminal-restart").addEventListener("click", () => {
  terminalLines.length = 0;
  terminalOutput.textContent = "";
  api.send({ cmd: "terminalRestart" });
});

function renderDiff() {
  const files = state.changes.files;
  renderDiffFileList();
  diffRoot.innerHTML = "";
  if (files.length === 0) {
    diffRoot.innerHTML = `<div class="diff-empty">${escapeHtml(t.noChanges)}</div>`;
    workbenchMeta.textContent = "";
    return;
  }
  const selected = files.find((file) => file.path === state.selectedChange) ?? files[0];
  state.selectedChange = selected.path;
  workbenchMeta.innerHTML =
    `<span class="add">+${selected.additions}</span> <span class="del">−${selected.deletions}</span> · ${escapeHtml(selected.path)}`;
  if (selected.skipped) {
    diffRoot.innerHTML = `<div class="diff-empty">${escapeHtml(selected.skipped)}</div>`;
    return;
  }
  for (const hunk of selected.hunks) {
    const header = document.createElement("div");
    header.className = "diff-hunk-header";
    header.textContent = `@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`;
    diffRoot.appendChild(header);
    for (const line of hunk.lines) {
      const row = document.createElement("div");
      row.className = `diff-line ${line.kind}`;
      const marker = line.kind === "add" ? "+" : line.kind === "del" ? "−" : " ";
      const gutter = document.createElement("span");
      gutter.className = "diff-gutter";
      gutter.textContent = `${line.oldNo ?? ""}`.padStart(5) + " " + `${line.newNo ?? ""}`.padStart(5);
      const text = document.createElement("span");
      text.className = "diff-text";
      text.textContent = `${marker} ${line.text}`;
      row.append(gutter, text);
      diffRoot.appendChild(row);
    }
  }
}

function renderDiffFileList() {
  diffFilelist.innerHTML = "";
  for (const file of state.changes.files) {
    const row = document.createElement("button");
    row.className = `change-row${file.path === state.selectedChange ? " active" : ""}`;
    row.innerHTML =
      `<span class="change-path">${escapeHtml(file.path)}</span>` +
      `<span class="change-stat"><span class="add">+${file.additions}</span> <span class="del">−${file.deletions}</span></span>`;
    row.addEventListener("click", () => {
      state.selectedChange = file.path;
      openWorkbench("diff");
      renderDiff();
    });
    diffFilelist.appendChild(row);
  }
}

function renderChangesPanel() {
  changesList.innerHTML = "";
  const { files, additions, deletions } = state.changes;
  changesSummary.innerHTML = files.length
    ? `${files.length} file${files.length === 1 ? "" : "s"} · <span class="add">+${additions}</span> <span class="del">−${deletions}</span>`
    : escapeHtml(t.noChanges);
  for (const file of files) {
    const row = document.createElement("button");
    row.className = "change-row";
    row.innerHTML =
      `<span class="change-path">${escapeHtml(file.path)}</span>` +
      `<span class="change-stat"><span class="add">+${file.additions}</span> <span class="del">−${file.deletions}</span></span>`;
    row.addEventListener("click", () => {
      selectSidebarTab("changes");
      state.selectedChange = file.path;
      openWorkbench("diff");
      renderDiff();
    });
    changesList.appendChild(row);
  }
}

function renderCheckpoints() {
  checkpointList.innerHTML = "";
  const entries = state.checkpoints;
  if (entries.length === 0) {
    checkpointList.innerHTML = `<div class="sidebar-empty">${escapeHtml(t.noCheckpoints)}</div>`;
    return;
  }
  const restoreAll = document.createElement("button");
  restoreAll.className = "restore-start";
  restoreAll.textContent = t.restoreStart;
  restoreAll.addEventListener("click", () => {
    if (confirm(t.restoreConfirm)) api.send({ cmd: "restoreCheckpoint", id: "start" });
  });
  checkpointList.appendChild(restoreAll);

  for (const entry of [...entries].reverse()) {
    const row = document.createElement("button");
    row.className = "checkpoint-row";
    const time = new Date(entry.at).toLocaleTimeString(state.locale === "zh" ? "zh-CN" : "en-US", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    row.innerHTML =
      `<span class="checkpoint-time">${escapeHtml(time)}</span>` +
      `<span class="checkpoint-path">${escapeHtml(entry.path)}</span>`;
    row.title = `${entry.tool} · ${t.restore}`;
    row.addEventListener("click", () => {
      if (confirm(`${t.restore} ${entry.path}?`)) api.send({ cmd: "restoreCheckpoint", id: entry.id });
    });
    checkpointList.appendChild(row);
  }
}

function renderTree() {
  fileTree.innerHTML = "";
  const nodes = state.tree ?? [];
  if (nodes.length === 0) {
    fileTree.innerHTML = `<div class="sidebar-empty">…</div>`;
    return;
  }
  for (const node of nodes) fileTree.appendChild(treeRow(node));
}

function treeRow(node) {
  const row = document.createElement("button");
  row.className = "tree-row";
  row.innerHTML =
    `<span class="twisty">${node.type === "dir" ? "▸" : ""}</span>` +
    `<span class="tree-name">${escapeHtml(node.name)}</span>`;
  row.title = node.path;
  row.addEventListener("click", () => {
    if (node.type === "file") {
      openFile(node.path);
      return;
    }
    const existing = row.nextElementSibling;
    if (existing && existing.classList.contains("tree-children")) {
      existing.hidden = !existing.hidden;
      row.querySelector(".twisty").textContent = existing.hidden ? "▸" : "▾";
      return;
    }
    const container = document.createElement("div");
    container.className = "tree-children";
    row.after(container);
    row.querySelector(".twisty").textContent = "▾";
    api.send({ cmd: "getTree", path: node.path });
    pendingTreeTarget = container;
  });
  return row;
}

let pendingTreeTarget = null;

function openFile(path) {
  state.selectedFile = path;
  openWorkbench("file");
  fileRoot.innerHTML = `<div class="diff-empty">…</div>`;
  api.send({ cmd: "getFile", path });
  transcript.classList.add("with-workbench");
}

function renderFilePreview(file) {
  if (!file || file.path !== state.selectedFile) return;
  workbenchMeta.textContent = `${file.path}${file.truncated ? " · truncated" : ""}`;
  if (file.binary) {
    fileRoot.innerHTML = `<div class="diff-empty">binary file</div>`;
    return;
  }
  const lines = file.content.replace(/\r\n/g, "\n").split("\n");
  fileRoot.innerHTML = `<pre class="file-view-code">${lines
    .map((line, index) => {
      const gutter = `<span class="diff-gutter">${String(index + 1).padStart(4)}</span>`;
      return `<div class="file-line">${gutter}<span class="diff-text">${escapeHtml(line)}</span></div>`;
    })
    .join("")}</pre>`;
}

function selectSidebarTab(tab) {
  state.sidebarTab = tab;
  sidebarTabs.querySelectorAll("button").forEach((button) => {
    button.classList.toggle("active", button.dataset.tab === tab);
  });
  document.querySelectorAll(".panel-view").forEach((view) => {
    view.hidden = view.dataset.view !== tab;
  });
  if (tab === "files") api.send({ cmd: "getTree", path: "." });
  if (tab === "changes") renderChangesPanel();
  if (tab === "history") api.send({ cmd: "getCheckpoints" });
}

/* ---------- sessions ---------- */

function relativeDate(iso) {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const minutes = Math.round((Date.now() - then) / 60000);
  if (minutes < 1) return state.locale === "zh" ? "刚刚" : "just now";
  if (minutes < 60) return state.locale === "zh" ? `${minutes} 分钟前` : `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return state.locale === "zh" ? `${hours} 小时前` : `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return state.locale === "zh" ? "昨天" : "yesterday";
  if (days < 7) return state.locale === "zh" ? `${days} 天前` : `${days}d ago`;
  return new Date(iso).toLocaleDateString(state.locale === "zh" ? "zh-CN" : "en-US");
}

function renderSessions(sessions) {
  state.sessions = sessions || [];
  sessionList.innerHTML = "";
  if (state.sessions.length === 0) {
    const empty = document.createElement("div");
    empty.className = "sidebar-empty";
    empty.textContent = t.noSessions;
    sessionList.appendChild(empty);
    return;
  }
  for (const session of state.sessions) {
    const button = document.createElement("button");
    button.className = `session-item${session.id === state.sessionId ? " active" : ""}`;
    const title = session.summary && session.summary !== "(no messages)" ? session.summary : t.noMessages;
    button.innerHTML =
      `<div class="session-title">${escapeHtml(title)}</div>` +
      `<div class="session-meta">${escapeHtml(relativeDate(session.updatedAt))}</div>`;
    button.title = `${title}\n${session.id}`;
    button.addEventListener("click", () => {
      api.send({ cmd: "loadSession", id: session.id });
    });
    sessionList.appendChild(button);
  }
}

function setTheme(theme) {
  state.theme = theme;
  document.documentElement.dataset.theme = theme;
  localStorage.setItem("prometheus.theme", theme);
  $("theme-button").title = theme === "light" ? "Dark" : "Light";
}

/* ---------- composer ---------- */

function autoSize() {
  input.style.height = "auto";
  input.style.height = `${Math.min(220, input.scrollHeight)}px`;
}

function submit() {
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  autoSize();
  addUserTurn(text);
  api.send({ cmd: "prompt", text });
}

input.addEventListener("input", autoSize);
input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    submit();
  }
});

sendButton.addEventListener("click", submit);
stopButton.addEventListener("click", () => api.send({ cmd: "abort" }));

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    if (!settingsDialog.hidden || !shortcutsDialog.hidden) {
      closeModal(settingsDialog);
      closeModal(shortcutsDialog);
      return;
    }
    if (!modelMenu.hidden) {
      closeModelMenu();
      return;
    }
    if (!pendingPermission.hidden) {
      answerPermission("no");
      return;
    }
    if (state.busy) api.send({ cmd: "abort" });
    return;
  }
  const mod = event.ctrlKey || event.metaKey;
  if (!mod) return;
  const key = event.key.toLowerCase();
  if (key === "n") {
    event.preventDefault();
    api.send({ cmd: "newSession" });
  } else if (key === "b") {
    event.preventDefault();
    toggleSidebar();
  } else if (key === ",") {
    event.preventDefault();
    openSettings();
  } else if (key === "/" || key === "?") {
    event.preventDefault();
    openShortcuts();
  } else if (key === "1" || key === "2" || key === "3") {
    event.preventDefault();
    const mode = key === "1" ? "ask" : key === "2" ? "auto" : "plan";
    if (mode !== state.mode) api.send({ cmd: "setMode", mode });
  } else if (key === "d" && event.shiftKey) {
    event.preventDefault();
    selectSidebarTab("changes");
    openWorkbench("diff");
  } else if (key === "e" && event.shiftKey) {
    event.preventDefault();
    selectSidebarTab("files");
  } else if (key === "e") {
    event.preventDefault();
    const order = ["auto", "low", "medium", "high"];
    const next = order[(order.indexOf(state.effort) + 1) % order.length];
    api.send({ cmd: "setEffort", effort: next });
  } else if (key === "\\") {
    event.preventDefault();
    closeWorkbench();
  } else if (key === "`") {
    event.preventDefault();
    openWorkbench("terminal");
  }
});

document.addEventListener("click", (event) => {
  if (!modelMenu.hidden && !event.target.closest(".model-control")) closeModelMenu();
});

function answerPermission(answer) {
  if (state.pendingPermissionId == null) return;
  api.send({ cmd: "permission", id: state.pendingPermissionId, answer });
  state.pendingPermissionId = null;
  pendingPermission.hidden = true;
  input.focus();
}

pendingPermission.querySelectorAll("[data-permission]").forEach((button) => {
  button.addEventListener("click", () => answerPermission(button.dataset.permission));
});

modeControl.querySelectorAll("button").forEach((button) => {
  button.addEventListener("click", () => {
    if (button.dataset.mode !== state.mode) api.send({ cmd: "setMode", mode: button.dataset.mode });
  });
});

effortControl.querySelectorAll("button").forEach((button) => {
  button.addEventListener("click", () => {
    if (button.dataset.effort !== state.effort) api.send({ cmd: "setEffort", effort: button.dataset.effort });
  });
});

modelPicker.addEventListener("click", (event) => {
  event.stopPropagation();
  if (modelMenu.hidden) openModelMenu();
  else closeModelMenu();
});

localeSwitch.querySelectorAll("button").forEach((button) => {
  button.addEventListener("click", () => {
    const locale = button.dataset.locale;
    if (locale !== state.locale) applyLocale(locale, { announce: true });
  });
});

$("workspace-button").addEventListener("click", async () => {
  const dir = await api.pickDirectory();
  if (dir) api.send({ cmd: "setCwd", cwd: dir });
});

$("clear-button").addEventListener("click", () => {
  if (confirm(t.clearConfirm)) api.send({ cmd: "newSession" });
});
$("new-session").addEventListener("click", () => api.send({ cmd: "newSession" }));
$("refresh-sessions").addEventListener("click", () => api.send({ cmd: "listSessions" }));

function toggleSidebar() {
  document.querySelector(".shell").classList.toggle("collapsed");
}

$("sidebar-toggle").addEventListener("click", toggleSidebar);

sidebarTabs.querySelectorAll("button").forEach((button) => {
  button.addEventListener("click", () => selectSidebarTab(button.dataset.tab));
});

workbenchTabs.querySelectorAll("button").forEach((button) => {
  button.addEventListener("click", () => openWorkbench(button.dataset.pane));
});

$("close-workbench").addEventListener("click", closeWorkbench);

$("theme-button").addEventListener("click", () => {
  setTheme(state.theme === "light" ? "dark" : "light");
});

/* ---------- settings dialog ---------- */

const settingsDialog = $("settings-dialog");
const shortcutsDialog = $("shortcuts-dialog");
const modalScrim = $("modal-scrim");

function openModal(dialog) {
  modalScrim.hidden = false;
  dialog.hidden = false;
  dialog.showModal?.();
}

function closeModal(dialog) {
  dialog.hidden = true;
  dialog.close?.();
  if (settingsDialog.hidden && shortcutsDialog.hidden) modalScrim.hidden = true;
}

function openSettings() {
  api.send({ cmd: "getSettings" });
  openModal(settingsDialog);
}

function fillSettings(s) {
  $("setting-base-url").value = s.baseUrl || "";
  $("setting-api-key").value = s.apiKeyMasked || "";
  $("setting-api-key").dataset.masked = "1";
  const modelSelect = $("setting-model");
  modelSelect.innerHTML = "";
  for (const model of s.models || []) {
    const option = document.createElement("option");
    option.value = model.id;
    option.textContent = model.id;
    modelSelect.appendChild(option);
  }
  if (s.model && ![...modelSelect.options].some((o) => o.value === s.model)) {
    const option = document.createElement("option");
    option.value = s.model;
    option.textContent = s.model;
    modelSelect.appendChild(option);
  }
  modelSelect.value = s.model;
  $("setting-mode").value = s.mode;
  $("setting-effort").value = s.effort;
  $("setting-max-tokens").value = s.maxTokens;
  $("setting-locale").value = s.locale;
  $("setting-theme").value = s.theme;
  $("settings-note").textContent = "";
}

$("setting-api-key").addEventListener("focus", (event) => {
  if (event.target.dataset.masked === "1") {
    event.target.value = "";
    event.target.dataset.masked = "";
  }
});

function saveSettings() {
  api.send({
    cmd: "saveSettings",
    settings: {
      baseUrl: $("setting-base-url").value,
      apiKey: $("setting-api-key").value,
      model: $("setting-model").value,
      mode: $("setting-mode").value,
      effort: $("setting-effort").value,
      maxTokens: Number($("setting-max-tokens").value),
      locale: $("setting-locale").value,
      theme: $("setting-theme").value,
    },
  });
}

$("settings-button").addEventListener("click", openSettings);
$("settings-close").addEventListener("click", () => closeModal(settingsDialog));
$("settings-cancel").addEventListener("click", () => closeModal(settingsDialog));
$("settings-save").addEventListener("click", saveSettings);

/* ---------- shortcuts sheet ---------- */

function openShortcuts() {
  const mod = api.platform === "darwin" ? "⌘" : "Ctrl";
  const rows = [
    [t.shortcutNewChat, `${mod}+N`],
    [t.shortcutSettings, `${mod}+,`],
    [t.shortcutShortcuts, `${mod}+/`],
    [t.shortcutToggleSidebar, `${mod}+B`],
    [t.shortcutStop, "Esc"],
    [t.shortcutChanges, `${mod}+Shift+D`],
    [t.shortcutFiles, `${mod}+Shift+E`],
    [t.shortcutTerminal, `${mod}+\``],
    [t.shortcutClosePane, `${mod}+\\`],
    [t.shortcutModeAsk, `${mod}+1`],
    [t.shortcutModeAuto, `${mod}+2`],
    [t.shortcutModePlan, `${mod}+3`],
    [t.shortcutEffort, `${mod}+Shift+E`],
  ];
  const grid = $("shortcut-grid");
  grid.innerHTML = "";
  for (const [label, keys] of rows) {
    const labelNode = document.createElement("div");
    labelNode.className = "label";
    labelNode.textContent = label;
    const keyNode = document.createElement("kbd");
    keyNode.textContent = keys;
    grid.append(labelNode, keyNode);
  }
  openModal(shortcutsDialog);
}

$("shortcuts-button").addEventListener("click", openShortcuts);
$("shortcuts-close").addEventListener("click", () => closeModal(shortcutsDialog));
modalScrim.addEventListener("click", () => {
  closeModal(settingsDialog);
  closeModal(shortcutsDialog);
});

document.querySelectorAll(".suggestion").forEach((button) => {
  button.addEventListener("click", () => {
    input.value = button.dataset.prompt || "";
    autoSize();
    input.focus();
  });
});

transcript.addEventListener("click", (event) => {
  const link = event.target.closest("a");
  if (link && /^https?:/.test(link.href)) {
    event.preventDefault();
    api.openExternal(link.href);
  }
});

api.onEvent(handleEvent);
if (api.platform) document.documentElement.classList.add(`platform-${api.platform}`);
applyLocale(state.locale);
setTheme(state.theme);
api.send({ cmd: "listSessions" });
api.send({ cmd: "getTree", path: "." });
api.send({ cmd: "setLocale", locale: state.locale });
input.focus();
