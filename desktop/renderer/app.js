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
  const nearBottom = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 140;
  if (force || nearBottom) transcript.scrollTop = transcript.scrollHeight;
}

function hideEmptyState() {
  if (emptyState && !emptyState.hidden) emptyState.hidden = true;
}

function addNode(html) {
  hideEmptyState();
  const wrapper = document.createElement("div");
  wrapper.innerHTML = html;
  const node = wrapper.firstElementChild;
  transcript.appendChild(node);
  scrollToBottom();
  return node;
}

/* ---------- transcript rendering ---------- */

function addUserTurn(text) {
  addNode(`<div class="turn user"><div class="user-bubble">${escapeHtml(text)}</div></div>`);
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
      if (message.files && message.files.length > 0) {
        const list = message.files.slice(0, 8).map((f) => f.path).join(", ");
        addNode(
          `<div class="notice dim">${escapeHtml(t.changedFiles(message.files.length, list + (message.files.length > 8 ? "…" : "")))}</div>`,
        );
      }
      break;

    case "session_loaded":
      transcript.querySelectorAll(".turn, .tool-row, .tool-output, .notice, .plan, .thinking").forEach((node) => node.remove());
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
        transcript.appendChild(emptyState);
        emptyState.hidden = false;
      }
      if (message.cwd) {
        workspacePath.textContent = message.cwd;
        workspacePath.title = message.cwd;
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
  if (!text || state.busy) return;
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
    if (!modelMenu.hidden) {
      closeModelMenu();
      return;
    }
    if (!pendingPermission.hidden) {
      answerPermission("no");
      return;
    }
    if (state.busy) api.send({ cmd: "abort" });
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "n") {
    event.preventDefault();
    api.send({ cmd: "newSession" });
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "b") {
    event.preventDefault();
    toggleSidebar();
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

$("theme-button").addEventListener("click", () => {
  setTheme(state.theme === "light" ? "dark" : "light");
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
api.send({ cmd: "setLocale", locale: state.locale });
input.focus();
