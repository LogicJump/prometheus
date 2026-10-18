/** Prometheus desktop renderer. */

import { detectLocale, getDict } from "./i18n.js";
import { escapeHtml, renderMarkdown } from "./markdown.js";

/** Saved preferences are restored here; the host gets them on init. */
const savedLocale = localStorage.getItem("prometheus.locale");
const savedTheme = localStorage.getItem("prometheus.theme");
const savedDensity = localStorage.getItem("prometheus.density");
const savedWorkbench = localStorage.getItem("prometheus.workbench");
const savedPane = localStorage.getItem("prometheus.pane");

const api = window.prometheus;

const $ = (id) => document.getElementById(id);
const transcript = $("transcript");
const emptyState = $("empty-state");
const input = $("input");
const sendButton = $("send-button");
const stopButton = $("stop-button");
const statusDot = $("status-dot");
const statusText = $("status-text");
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

const transcriptScroll = $("transcript-scroll");
const workbench = $("workbench");
const workbenchTabs = $("workbench-tabs");
const workbenchMeta = $("workbench-meta");
const diffFilelist = $("diff-filelist");
const diffRoot = $("diff-root");
const fileRoot = $("file-root");
const fileTree = $("pane-tree");
const changesList = $("changes-list");
const changesSummary = $("changes-summary");
const checkpointList = $("checkpoint-list");
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
  providers: [],
  sessionId: "",
  sessions: [],
  locale: savedLocale === "zh" || savedLocale === "en" ? savedLocale : detectLocale(),
  theme: savedTheme || "dark",
  density: savedDensity === "compact" || savedDensity === "detailed" ? savedDensity : "balanced",
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
  cwd: "",
  context: { tokens: 0, percent: 0 },
  sandbox: "enforce",
  usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
  /** Explicit project fold states; anything not listed follows the active-project default. */
  expandedProjects: new Set(JSON.parse(localStorage.getItem("prometheus.expandedProjects") || "[]")),
  collapsedProjects: new Set(JSON.parse(localStorage.getItem("prometheus.collapsedProjects") || "[]")),
  workbenchOpen: savedWorkbench === "1",
  pane: ["files", "diff", "history", "artifact", "terminal", "browser", "file"].includes(savedPane) ? savedPane : "diff",
  git: null,
  worktree: null,
  worktreeDiffText: "",
  artifacts: [],
  selectedArtifact: null,
  queuedCount: 0,
  sessionQuery: "",
  showArchived: false,
  comments: [],
  attachments: [],
  pr: null,
  commands: [],
  diffScope: "session",
  currentSubagent: null,
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
  $("topbar-cwd").title = t.changeWorkspace;
  $("refresh-sessions").title = t.sessions;
  const search = $("session-search");
  search.placeholder = t.searchSessions;
  search.title = t.searchSessions;
  $("find-input").placeholder = t.findPlaceholder;
  $("check-update").textContent = t.checkUpdate;
  modelPicker.title = t.refreshModels;
  // applyLocale also runs during startup, before the voice state is declared.
  $("voice-button").title = $("voice-button").classList.contains("recording") ? t.voiceStop : t.voiceStart;
  if (state.sessions.length > 0) renderSessions(state.sessions);
  syncMenuControls();
  setStatus(state.statusKey);
  if (state.models.length > 0) renderModelMenu();
  if (announce) api.send({ cmd: "setLocale", locale });
  const message = $("git-message");
  if (message) message.placeholder = t.commitPlaceholder;
  const commitButton = $("git-commit-button");
  if (commitButton) commitButton.textContent = t.commitAll;
  if (state.git) renderGitBar();
  void announce;
}

function statusLabel(key) {
  return t[key] ?? key;
}

/* ---------- utilities ---------- */

const md = (source) => renderMarkdown(source, t.copy);

/** The element that actually scrolls: the transcript, or its inner column when
 *  the workbench splits the pane. */
function scrollTarget() {
  return transcript;
}

function scrollToBottom(force = false) {
  const target = scrollTarget();
  const nearBottom = target.scrollHeight - target.scrollTop - target.clientHeight < 140;
  if (force || nearBottom) target.scrollTop = target.scrollHeight;
  updateScrollButton();
}

function updateScrollButton() {
  const button = $("scroll-bottom");
  if (!button) return;
  const target = scrollTarget();
  const away = target.scrollHeight - target.scrollTop - target.clientHeight > 220;
  button.hidden = !away;
}

function hideEmptyState() {
  if (emptyState && !emptyState.hidden) emptyState.hidden = true;
}

function addNode(html) {
  hideEmptyState();
  const wrapper = document.createElement("div");
  wrapper.innerHTML = html;
  const node = wrapper.firstElementChild;
  // Streaming keeps the view pinned to the bottom; inserting a new turn
  // mid-scroll should not yank the reader away.
  const target = scrollTarget();
  const pinned = target.scrollHeight - target.scrollTop - target.clientHeight < 140;
  target.appendChild(node);
  if (pinned) scrollToBottom(true);
  return node;
}

/* ---------- transcript rendering ---------- */

function addUserTurn(text, imageCount = 0) {
  const queued = state.busy;
  const images = imageCount > 0 ? `<span class="user-images">${t.imageCount(imageCount)}</span>` : "";
  const node = addNode(
    `<div class="turn user${queued ? " queued" : ""}">` +
      `<div class="user-bubble">${escapeHtml(text)}${images}${queued ? `<span class="queued-tag">${escapeHtml(t.queuedTag)}</span>` : ""}</div>` +
      `</div>`,
  );
  node.dataset.queued = queued ? "1" : "";
  return node;
}

/** Offer "rewind to here" on a user turn once the conversation moved past it. */
function attachRewind(node, index) {
  if (!node || !Number.isFinite(index)) return;
  node.dataset.index = String(index);
  if (node.querySelector(".rewind-button")) return;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "rewind-button";
  button.dataset.i18n = "rewindHere";
  button.textContent = t.rewindHere;
  button.title = t.rewindTitle;
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    if (!confirm(t.rewindConfirm)) return;
    api.send({ cmd: "rewindTo", index });
  });
  node.appendChild(button);
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
  if (last && (last.classList.contains("tool-row") || last.classList.contains("tool-group"))) node.classList.add("after-tools");
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
  const hadText = current.text.trim().length > 0;
  current.body.innerHTML = md(current.text);
  current.body.classList.remove("streaming");
  state.currentAssistant = null;
  bindCodeCopy(current.node);
  // A turn that produced no prose leaves an empty bubble behind.
  if (!hadText) current.node.remove();
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

/** Human labels for tool ids: the transcript should read as actions. */
const TOOL_LABELS = {
  read_file: "Read",
  write_file: "Write",
  edit_file: "Edit",
  list_files: "List",
  glob: "Find files",
  grep: "Search",
  search_codebase: "Search code",
  bash: "Run",
  todo_write: "Plan",
  remember: "Remember",
  delegate: "Delegate",
  web_fetch: "Fetch",
};

function toolLabel(name) {
  return TOOL_LABELS[name] ?? name;
}

/** Consecutive calls belong to one activity block, not a stream of lines. */
function toolGroup() {
  const last = transcript.lastElementChild;
  if (last && last.classList.contains("tool-group")) return last;
  return addNode(`<div class="tool-group"></div>`);
}

function addToolRow(name, summary) {
  const glyph = name === "bash" ? "›" : ["read_file", "list_files", "grep", "glob", "search_codebase"].includes(name) ? "◦" : "✦";
  const row = document.createElement("div");
  row.className = "tool-row running";
  row.innerHTML =
    `<span class="tool-glyph">${glyph}</span>` +
    `<span class="tool-name">${escapeHtml(toolLabel(name))}</span>` +
    `<span class="tool-summary">${escapeHtml(summary || "")}</span>` +
    `<button class="tool-expand" hidden>${escapeHtml(t.details)}</button>`;
  row.dataset.path = summary || "";
  toolGroup().appendChild(row);
  // The summary of a file tool is its path; clicking opens it in the
  // workbench, like clicking a path in an editor's output pane.
  if (FILE_TOOLS.has(name) && summary) {
    row.classList.add("openable");
    row.title = `${t.openFile}: ${summary}`;
    row.addEventListener("click", (event) => {
      if (event.target.closest(".tool-expand")) return;
      openFile(summary);
    });
  }
  state.currentTool = { node: row, name, summary };
  state.lastToolNode = row;
  return row;
}

const FILE_TOOLS = new Set(["read_file", "write_file", "edit_file"]);

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
  // A detail block belongs to its call, so it is wrapped with it rather than
  // being a sibling inside the activity group.
  const block = document.createElement("div");
  block.className = "tool-item";
  row.before(block);
  block.append(row, outputNode);
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
  // Finishing a turn must not paint "ready" over a stopped host or a config
  // error that is still the actual state.
  if (busy) setStatus("statusWorking");
  else if (!BUSY_OVERRIDES.has(state.statusKey)) setStatus("statusReady");
}

const BUSY_OVERRIDES = new Set(["statusHostStopped", "statusConfigError", "statusError"]);

function setStatus(key) {
  state.statusKey = key;
  const dotKind = key === "statusWorking" || key === "statusConnecting" ? "working" : key.startsWith("statusError") || key === "statusHostStopped" || key === "statusConfigError" ? "error" : "ready";
  statusDot.className = `status-dot ${dotKind}`;
  statusText.textContent = statusLabel(key);
  // "Ready" is the resting state and needs no label; anything else is news.
  statusText.hidden = dotKind === "ready";
}

/* ---------- in-conversation search ---------- */

const findBar = $("find-bar");
const findInput = $("find-input");
let findHits = [];
let findIndex = 0;

function clearFindMarks() {
  transcript.querySelectorAll("mark.find-hit").forEach((mark) => {
    const parent = mark.parentNode;
    if (!parent) return;
    parent.replaceChild(document.createTextNode(mark.textContent), mark);
    parent.normalize();
  });
  findHits = [];
}

function openFind() {
  findBar.hidden = false;
  findInput.focus();
  findInput.select();
}

function closeFind() {
  findBar.hidden = true;
  clearFindMarks();
  $("find-count").textContent = "";
  input.focus();
}

/**
 * Highlight every literal occurrence of `query` in the transcript. Only text
 * nodes are touched, so markup and tool rows survive.
 */
function runFind() {
  clearFindMarks();
  const query = findInput.value.trim();
  if (!query) {
    $("find-count").textContent = "";
    return;
  }
  const needle = query.toLowerCase();
  const walker = document.createTreeWalker(transcriptScroll, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      if (!node.nodeValue || !node.nodeValue.toLowerCase().includes(needle)) return NodeFilter.FILTER_REJECT;
      const parent = node.parentElement;
      if (!parent || parent.closest(".find-bar, .empty-state, script, style")) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const targets = [];
  while (walker.nextNode()) targets.push(walker.currentNode);

  for (const node of targets) {
    const text = node.nodeValue;
    const fragment = document.createDocumentFragment();
    let from = 0;
    for (;;) {
      const at = text.toLowerCase().indexOf(needle, from);
      if (at < 0) {
        fragment.appendChild(document.createTextNode(text.slice(from)));
        break;
      }
      if (at > from) fragment.appendChild(document.createTextNode(text.slice(from, at)));
      const mark = document.createElement("mark");
      mark.className = "find-hit";
      mark.textContent = text.slice(at, at + needle.length);
      fragment.appendChild(mark);
      findHits.push(mark);
      from = at + needle.length;
    }
    node.parentNode.replaceChild(fragment, node);
  }

  findIndex = 0;
  focusFindHit();
}

function focusFindHit() {
  findHits.forEach((hit, index) => hit.classList.toggle("current", index === findIndex));
  const current = findHits[findIndex];
  if (current) current.scrollIntoView({ block: "center", behavior: "smooth" });
  $("find-count").textContent = findHits.length === 0 ? t.findNone : `${findIndex + 1}/${findHits.length}`;
}

function stepFind(delta) {
  if (findHits.length === 0) return;
  findIndex = (findIndex + delta + findHits.length) % findHits.length;
  focusFindHit();
}

let findTimer = null;
findInput.addEventListener("input", () => {
  clearTimeout(findTimer);
  findTimer = setTimeout(runFind, 120);
});
findInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    stepFind(event.shiftKey ? -1 : 1);
  }
});
$("find-next").addEventListener("click", () => stepFind(1));
$("find-prev").addEventListener("click", () => stepFind(-1));
$("find-close").addEventListener("click", closeFind);

/* ---------- slash commands ---------- */

const commandMenu = $("command-menu");
let commandState = null;

function commandsAtCaret() {
  const before = input.value.slice(0, input.selectionStart);
  const match = /(^|\n)\/([a-z0-9][a-z0-9-_]*)?$/i.exec(before);
  return match ? match[2] ?? "" : null;
}

function updateCommandMenu() {
  const query = commandsAtCaret();
  if (query === null || state.commands.length === 0) {
    closeCommandMenu();
    return;
  }
  const matches = state.commands.filter((command) => command.name.startsWith(query.toLowerCase()));
  if (matches.length === 0) {
    closeCommandMenu();
    return;
  }
  commandState = { matches, index: 0 };
  commandMenu.innerHTML = "";
  matches.forEach((command, index) => {
    const row = document.createElement("button");
    row.className = `mention-row command-row${index === 0 ? " active" : ""}`;
    row.setAttribute("role", "option");
    row.innerHTML =
      `<span class="command-name">/${escapeHtml(command.name)}</span>` +
      `<span class="command-hint">${escapeHtml(command.argumentHint || command.description || "")}</span>`;
    row.addEventListener("mousedown", (event) => {
      event.preventDefault();
      applyCommand(command);
    });
    commandMenu.appendChild(row);
  });
  commandMenu.hidden = false;
}

function closeCommandMenu() {
  commandState = null;
  commandMenu.hidden = true;
}

function applyCommand(command) {
  input.value = `/${command.name} `;
  input.setSelectionRange(input.value.length, input.value.length);
  closeCommandMenu();
  autoSize();
  input.focus();
}

function moveCommand(delta) {
  if (!commandState) return;
  commandState.index = (commandState.index + delta + commandState.matches.length) % commandState.matches.length;
  commandMenu.querySelectorAll(".command-row").forEach((row, index) => {
    row.classList.toggle("active", index === commandState.index);
  });
  commandMenu.children[commandState.index]?.scrollIntoView({ block: "nearest" });
}

/* ---------- @ file references ---------- */

const fileMention = $("file-mention");
let mention = null;

/** The `@fragment` under the caret, if the token starts a word. */
function mentionAtCaret() {
  const before = input.value.slice(0, input.selectionStart);
  const match = /(^|\s)@([^\s@]*)$/.exec(before);
  if (!match) return null;
  return { start: input.selectionStart - match[2].length - 1, query: match[2] };
}

function updateMention() {
  updateCommandMenu();
  if (state.mentionTimer) clearTimeout(state.mentionTimer);
  const found = mentionAtCaret();
  if (!found) {
    closeMention();
    return;
  }
  mention = { ...found, files: [], index: 0 };
  // Debounce so typing does not walk the tree on every keystroke.
  state.mentionTimer = setTimeout(() => {
    if (mention) api.send({ cmd: "searchFiles", query: found.query });
  }, 120);
}

function renderMention(files) {
  if (!mention) return;
  mention.files = files;
  mention.index = 0;
  fileMention.innerHTML = "";
  if (files.length === 0) {
    fileMention.hidden = true;
    return;
  }
  files.forEach((path, index) => {
    const row = document.createElement("button");
    row.className = `mention-row${index === 0 ? " active" : ""}`;
    row.setAttribute("role", "option");
    const cut = path.lastIndexOf("/");
    row.innerHTML =
      `<span class="mention-name">${escapeHtml(path.slice(cut + 1))}</span>` +
      (cut > 0 ? `<span class="mention-dir">${escapeHtml(path.slice(0, cut))}</span>` : "");
    row.addEventListener("mousedown", (event) => {
      event.preventDefault();
      applyMention(path);
    });
    fileMention.appendChild(row);
  });
  fileMention.hidden = false;
}

function closeMention() {
  mention = null;
  fileMention.hidden = true;
}

function applyMention(path) {
  if (!mention) return;
  const caret = input.selectionStart;
  const before = input.value.slice(0, mention.start);
  const after = input.value.slice(caret);
  const inserted = `@${path} `;
  input.value = `${before}${inserted}${after}`;
  const position = before.length + inserted.length;
  input.setSelectionRange(position, position);
  closeMention();
  autoSize();
  input.focus();
}

function moveMention(delta) {
  if (!mention || mention.files.length === 0) return;
  mention.index = (mention.index + delta + mention.files.length) % mention.files.length;
  fileMention.querySelectorAll(".mention-row").forEach((row, index) => {
    row.classList.toggle("active", index === mention.index);
  });
  fileMention.children[mention.index]?.scrollIntoView({ block: "nearest" });
}

input.addEventListener("input", updateMention);
input.addEventListener("click", updateMention);
input.addEventListener("blur", () => setTimeout(closeMention, 120));

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

function formatTokens(n) {
  const value = Number(n) || 0;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

/**
 * The composer meter is the session's token accounting: how full the context
 * window is, and what the conversation has spent so far. Clicking it opens the
 * breakdown instead of hiding the numbers in a tooltip.
 */
function updateMeter(context, usage) {
  if (context) {
    state.context = { tokens: context.tokens ?? 0, percent: Math.min(100, Math.round(context.percent ?? 0)) };
    const percent = state.context.percent;
    contextLabel.textContent = `${percent}%`;
    contextFill.style.width = `${percent}%`;
    contextFill.style.background = percent > 85 ? "var(--danger)" : percent > 60 ? "var(--warn)" : "var(--accent)";
  }
  if (usage) {
    state.usage = {
      inputTokens: usage.inputTokens ?? 0,
      outputTokens: usage.outputTokens ?? 0,
      cachedTokens: usage.cachedTokens ?? 0,
    };
    const total = state.usage.inputTokens + state.usage.outputTokens;
    usageLabel.textContent = `${formatTokens(total)} ${t.tokens}`;
  }
  renderUsage();
}

/** Fill the usage popover from state. Harmless while it is closed. */
function renderUsage() {
  const context = state.context ?? { tokens: 0, percent: 0 };
  const usage = state.usage ?? { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
  $("usage-context-value").textContent = `${formatTokens(context.tokens)} · ${context.percent}%`;
  $("usage-context-fill").style.width = `${context.percent}%`;
  $("usage-input-value").textContent = formatTokens(usage.inputTokens);
  $("usage-cached-value").textContent = formatTokens(usage.cachedTokens);
  $("usage-output-value").textContent = formatTokens(usage.outputTokens);
  $("usage-total-value").textContent = formatTokens(usage.inputTokens + usage.outputTokens);
}

function setUsagePopover(open) {
  const popover = $("usage-popover");
  if (!popover) return;
  popover.hidden = !open;
  $("usage-meter").setAttribute("aria-expanded", open ? "true" : "false");
  if (open) renderUsage();
}

$("usage-meter").addEventListener("click", (event) => {
  event.stopPropagation();
  setUsagePopover($("usage-popover").hidden);
});

$("usage-meter").addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    setUsagePopover($("usage-popover").hidden);
  }
});

$("usage-reset").addEventListener("click", () => {
  // The host owns the counters; a fresh baseline keeps the display honest
  // without pretending the spend never happened.
  state.usage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
  usageLabel.textContent = `0 ${t.tokens}`;
  renderUsage();
  setUsagePopover(false);
});

document.addEventListener("click", (event) => {
  if (!event.target.closest("#usage-popover") && !event.target.closest("#usage-meter")) setUsagePopover(false);
});

function setMode(mode) {
  state.mode = mode;
  modeControl.querySelectorAll("button").forEach((button) => {
    button.classList.toggle("active", button.dataset.mode === mode);
  });
  // Make "auto without isolation" visible instead of implicit.
  const autoButton = modeControl.querySelector('[data-mode="auto"]');
  if (autoButton) {
    const unsafe = state.sandbox === "off";
    autoButton.classList.toggle("unsandboxed", unsafe);
    autoButton.title = unsafe ? t.sandboxOffBadge : "";
  }
}

function setEffort(effort) {
  state.effort = effort;
  effortControl.querySelectorAll("[data-effort]").forEach((button) => {
    const active = button.dataset.effort === effort;
    button.classList.toggle("active", active);
    button.setAttribute("aria-checked", String(active));
  });
  const label = effortControl.querySelector(`[data-effort="${effort}"]`);
  $("effort-label").textContent = label ? label.textContent : t.effortAuto;
}

/* ---------- model picker ---------- */

function renderModels(models, current, source) {
  state.models = models || [];
  state.model = current;
  state.modelsSource = source || "";
  if (current) {
    modelLabel.textContent = current;
    modelPicker.classList.remove("unavailable");
    // The meter is a share of the model's real context, not a placeholder.
    const active = state.models.find((model) => model.id === current);
    if (active && Number.isFinite(active.contextLength)) state.contextWindow = active.contextLength;
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
      if (state.needsSetup) {
        state.needsSetup = false;
        $("setup-button").hidden = true;
        addNode(`<div class="notice dim">${escapeHtml(t.setupBody)}</div>`);
      }
      break;

    case "state":
      state.sessionId = message.sessionId;
      if (message.cwd) state.cwd = message.cwd;
      state.locale = message.locale || state.locale;
      applyLocale(state.locale);
      setMode(message.mode);
      setEffort(message.effort || "auto");
      if (message.sandbox) state.sandbox = message.sandbox;
  if (Array.isArray(message.models) && message.models.length > 0) {
        renderModels(message.models, message.model, message.modelsSource);
      } else if (message.model) {
        renderModels(state.models, message.model, state.modelsSource);
      }
      state.cwd = message.cwd;
      renderTopbarLocation();
      updateMeter(message.context, message.usage);
      break;

    case "models":
      renderModels(message.models, message.model, message.source);
      break;

    case "changes":
      state.changes = {
        files: message.files ?? [],
        additions: message.additions ?? 0,
        deletions: message.deletions ?? 0,
        lastTurn: message.lastTurn ?? { files: [], additions: 0, deletions: 0 },
      };
      if (message.files?.length > 0 && !message.files.some((file) => file.path === state.selectedChange)) {
        state.selectedChange = message.files[0].path;
      }
      renderChangesPanel();
      renderChangesBadge();
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

    case "artifacts":
      state.artifacts = message.artifacts ?? [];
      renderArtifacts();
      break;

    case "artifact":
      renderArtifact(message.artifact);
      break;

    case "file_matches":
      if (message.query === mention?.query) renderMention(message.files ?? []);
      break;

    case "subagent_start": {
      const node = addNode(
        `<div class="subagent running">` +
          `<div class="subagent-head"><span class="subagent-glyph">↳</span>` +
          `<span class="subagent-title">${escapeHtml(t.subagentLabel)}</span>` +
          `<span class="subagent-count"></span></div>` +
          `<div class="subagent-prompt">${escapeHtml(message.prompt ?? "")}</div>` +
          `<div class="subagent-activities"></div>` +
          `</div>`,
      );
      state.currentSubagent = { node, count: 0 };
      break;
    }

    case "subagent_activity": {
      const sub = state.currentSubagent;
      if (!sub) break;
      sub.count += 1;
      const list = sub.node.querySelector(".subagent-activities");
      const line = document.createElement("div");
      line.className = "subagent-line";
      line.textContent = `${message.kind === "tool" ? "›" : "·"} ${message.text}`;
      list.appendChild(line);
      while (list.children.length > 40) list.removeChild(list.firstElementChild);
      sub.node.querySelector(".subagent-count").textContent = String(sub.count);
      break;
    }

    case "subagent_end": {
      const sub = state.currentSubagent;
      if (!sub) break;
      sub.node.classList.remove("running");
      if (!message.ok) sub.node.classList.add("failed");
      sub.node.querySelector(".subagent-count").textContent = message.ok ? t.subagentDone : t.subagentFailed;
      state.currentSubagent = null;
      break;
    }

    case "export_ready":
      exportSessionFile(message.markdown, message.filename);
      break;

    case "commands":
      state.commands = message.commands ?? [];
      break;

    case "command_expanded":
      addNotice("dim", `/${message.name}`);
      break;

    case "file":
      renderFilePreview(message.file);
      break;

    case "terminal_output":
      appendTerminalText(message.text ?? "");
      break;

    case "terminal_state":
      setTerminalState(message);
      break;

    case "git_status":
      state.git = message;
      state.worktree = message.worktree ?? null;
      renderGitBar();
      renderWorktree();
      break;

    case "pr_status":
      state.pr = message;
      renderPrBar();
      break;

    case "pr_created":
      if (message.ok) {
        addNotice("dim", `${t.prCreated} ${message.url ?? ""}`);
        api.send({ cmd: "prStatus" });
      } else {
        addNotice("warn", `${t.prFailed} ${message.error ?? ""}`);
      }
      break;

    case "worktree_diff":
      state.worktreeDiffText = message.diff || "";
      addNotice("dim", `${t.worktreeDiff} · ${message.branch}`);
      showWorktreeDiff();
      break;

    case "git_commit": {
      const note = $("git-commit-note");
      if (message.ok) {
        note.textContent = t.commitDone;
        $("git-message").value = "";
        addNode(`<div class="notice dim">${escapeHtml(t.commitDone)} ${escapeHtml(message.summary ?? "")}</div>`);
        scrollToBottom();
      } else {
        note.textContent = `${t.commitFailed} ${message.error ?? ""}`;
      }
      break;
    }

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

    case "rules": {
      const current = $("setting-rules");
      if (current) {
        renderRules(message.rules ?? []);
        api.send({ cmd: "getSettings" });
      }
      break;
    }

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

    case "usage":
      updateMeter(state.context, message.usage);
      break;

    case "run_start":
      setBusy(true);
      endThinking();
      // Keep typing possible while the turn runs; the message is queued.
      input.focus();
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
          current.body.innerHTML = `${md(current.text)}<span class="caret"></span>`;
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
        row.classList.add("done");
        if (!message.ok) row.classList.add("failed");
        const summaryEl = row.querySelector(".tool-summary");
        if (message.summary) summaryEl.textContent = message.summary;
        if (!message.ok) summaryEl.style.color = "var(--danger)";
        row.querySelector(".tool-glyph").textContent = message.ok ? "✓" : "✕";
        // An edit's result is a diff size: make it read like one.
        if (message.ok && message.name === "edit_file") {
          const parts = String(message.summary).match(/\+(\d+)\s+-(\d+)/);
          if (parts) {
            summaryEl.innerHTML =
              `<span class="add">+${parts[1]}</span> <span class="del">−${parts[2]}</span>` +
              `<span class="tool-path">${escapeHtml(row.dataset.path ?? "")}</span>`;
          }
        }
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

    case "permission_choice": {
      // Second-stage question after "always allow": remember all calls of a
      // tool, or only this exact one.
      state.pendingPermissionId = message.id;
      pendingQuestion.textContent = t.rememberScope || message.question;
      const choices = $("pending-choices");
      choices.innerHTML = "";
      for (const option of message.options ?? []) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "btn small";
        button.textContent = (option.i18nKey && t[option.i18nKey]) || option.label;
        button.addEventListener("click", () => answerPermission(option.value));
        choices.appendChild(button);
      }
      choices.hidden = false;
      pendingPermission.hidden = false;
      pendingPermission.querySelectorAll("[data-permission]").forEach((button) => (button.hidden = true));
      choices.querySelector("button")?.focus();
      break;
    }

    case "permission_request":
      state.pendingPermissionId = message.id;
      pendingQuestion.textContent = message.question;
      $("pending-choices").hidden = true;
      $("pending-choices").innerHTML = "";
      pendingPermission.querySelectorAll("[data-permission]").forEach((button) => (button.hidden = false));
      pendingPermission.hidden = false;
      pendingPermission.querySelector('[data-permission="yes"]').focus();
      notifyIfAway(t.notifyNeedsInput, message.question);
      break;

    case "notice":
      addNotice(message.level, message.text);
      scrollToBottom();
      break;

    case "compacted":
      // A visible seam in the transcript: earlier turns were summarised here.
      addNode(
        `<div class="compact-marker" title="${escapeHtml(t.compactedDetail(message.before, message.after))}">` +
          `<span class="compact-line"></span>` +
          `<span class="compact-label">${escapeHtml(t.compactedLabel(message.removed, message.level))}</span>` +
          `<span class="compact-line"></span>` +
          `</div>`,
      );
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

    case "session_loaded": {
      const target = scrollTarget();
      target
        .querySelectorAll(".turn, .tool-row, .tool-group, .tool-output, .notice, .plan, .thinking, .subagent, .compact-marker")
        .forEach((node) => node.remove());
      state.currentAssistant = null;
      state.currentThinking = null;
      state.currentTool = null;
      state.lastToolNode = null;
      for (const item of message.messages || []) {
        if (item.role === "user") {
          const node = addUserTurn(item.text, item.images ?? 0);
          attachRewind(node, item.index);
        }
        else if (item.role === "assistant") {
          const node = addNode(`<div class="turn assistant"><div class="markdown">${md(item.text)}</div></div>`);
          bindCodeCopy(node);
        } else if (item.role === "tool") {
          const row = document.createElement("div");
          row.className = "tool-row done";
          row.innerHTML =
            `<span class="tool-glyph">✓</span>` +
            `<span class="tool-name">${escapeHtml(toolLabel(item.name))}</span>` +
            `<span class="tool-summary">${escapeHtml(item.summary || "")}</span>`;
          toolGroup().appendChild(row);
        }
      }
      if ((message.messages || []).length === 0) {
        target.appendChild(emptyState);
        emptyState.hidden = false;
      }
      if (message.cwd) {
        state.cwd = message.cwd;
        renderTopbarLocation();
        api.send({ cmd: "getTree", path: "." });
        api.send({ cmd: "listSessions", includeArchived: state.showArchived });
      }
      scrollToBottom(true);
      break;
    }

    case "sessions":
      renderSessions(message.sessions);
      break;

    case "session_saved":
      api.send({ cmd: "listSessions", includeArchived: state.showArchived });
      break;

    case "session_title":
      if (state.sessions.length > 0) {
        const current = state.sessions.find((session) => session.id === state.sessionId);
        if (current) current.title = message.title;
        renderSessions(state.sessions);
      }
      break;

    case "host_exit":
      setBusy(false);
      setStatus("statusHostStopped");
      addNode(
        `<div class="notice error">${escapeHtml(t.hostStopped)} ` +
          `<button class="link-button" id="host-retry">${escapeHtml(t.hostRestart)}</button></div>`,
      );
      $("host-retry")?.addEventListener("click", () => {
        $("host-retry")?.closest(".notice")?.remove();
        api.restartHost();
      });
      break;

    case "fatal":
      setBusy(false);
      setStatus("statusConfigError");
      state.needsSetup = true;
      $("setup-button").hidden = false;
      addNode(
        `<div class="notice error">${escapeHtml(t.configError(message.message))} ` +
          `<button class="link-button" id="inline-setup">${escapeHtml(t.setupTitle)}</button></div>`,
      );
      $("inline-setup")?.addEventListener("click", openSetup);
      break;

    default:
      if (message.type) console.debug("unhandled host event", message);
  }
}

/* ---------- workbench: diff, file, tree, checkpoints ---------- */

function openWorkbench(pane) {
  state.pane = pane ?? state.pane;
  // Use the attribute directly: a stale hidden="false" still matches
  // [hidden]{display:none} and would keep the pane invisible.
  workbench.removeAttribute("hidden");
  state.workbenchOpen = true;
  localStorage.setItem("prometheus.workbench", "1");
  localStorage.setItem("prometheus.pane", state.pane);
  workbenchTabs.querySelectorAll("button").forEach((button) => {
    button.classList.toggle("active", button.dataset.pane === state.pane);
  });
  const showDiff = state.pane === "diff";
  const showTerminal = state.pane === "terminal";
  const showArtifact = state.pane === "artifact";
  const showBrowser = state.pane === "browser";
  const showFiles = state.pane === "files";
  const showHistory = state.pane === "history";
  const showFile = state.pane === "file";
  $("diff-pane").hidden = !showDiff;
  diffRoot.hidden = !showDiff;
  diffFilelist.hidden = !showDiff || state.changes.files.length === 0;
  $("diff-scope").hidden = !showDiff;
  $("pane-tree").hidden = !showFiles;
  $("changes-list").hidden = !showDiff;
  $("history-root").hidden = !showHistory;
  $("artifact-list-pane").hidden = !showArtifact || Boolean(state.selectedArtifact);
  fileRoot.hidden = !showFile;
  terminalRoot.hidden = !showTerminal;
  $("artifact-root").hidden = !showArtifact || !state.selectedArtifact;
  $("browser-root").hidden = !showBrowser;
  if (showDiff) renderDiff();
  if (showFiles) api.send({ cmd: "getTree", path: "." });
  if (showHistory) api.send({ cmd: "getCheckpoints" });
  if (showArtifact) api.send({ cmd: "getArtifacts" });
  if (showTerminal) {
    openTerminal();
  }
  if (showBrowser) {
    void api.browserOpen();
    scheduleBrowserBounds();
  }
  if (!showBrowser) void api.browserClose?.();
}

function closeWorkbench() {
  workbench.setAttribute("hidden", "");
  state.workbenchOpen = false;
  localStorage.setItem("prometheus.workbench", "0");
  // The page view floats above the window, so it must be removed explicitly.
  void api.browserClose?.();
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

function showWorktreeDiff() {
  // openWorkbench("diff") renders the session diff, so paint over it with the
  // worktree diff afterwards.
  openWorkbench("diff");
  workbenchMeta.textContent = t.worktreeDiff;
  diffFilelist.hidden = true;
  diffRoot.innerHTML = state.worktreeDiffText
    ? `<pre class="raw-diff">${escapeHtml(state.worktreeDiffText)}</pre>`
    : `<div class="diff-empty">${escapeHtml(t.noChanges)}</div>`;
}

function renderDiff() {
  const scope = state.diffScope;
  const active = scope === "turn" ? state.changes.lastTurn ?? { files: [], additions: 0, deletions: 0 } : state.changes;
  const files = active.files;
  renderDiffFileList(files);
  diffRoot.innerHTML = "";
  commentEditor = null;
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
  renderCommentRows(selected.path);
  for (const hunk of selected.hunks) {
    const header = document.createElement("div");
    header.className = "diff-hunk-header";
    header.textContent = `@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`;
    diffRoot.appendChild(header);
    for (const line of hunk.lines) {
      const row = document.createElement("div");
      row.className = `diff-line ${line.kind}`;
      const lineNo = line.newNo ?? line.oldNo;
      if (lineNo != null) row.dataset.line = String(lineNo);
      const marker = line.kind === "add" ? "+" : line.kind === "del" ? "−" : " ";
      const gutter = document.createElement("span");
      gutter.className = "diff-gutter";
      gutter.textContent = `${line.oldNo ?? ""}`.padStart(5) + " " + `${line.newNo ?? ""}`.padStart(5);
      const text = document.createElement("span");
      text.className = "diff-text";
      text.textContent = `${marker} ${line.text}`;
      row.append(gutter, text);
      if (lineNo != null && line.kind !== "del") {
        // Clicking a line attaches a review comment to it.
        row.title = t.commentHint;
        row.addEventListener("click", (event) => openLineComment(event, selected.path, lineNo, line.text));
      }
      diffRoot.appendChild(row);
    }
  }
}

/* ---------- inline review comments ---------- */

let commentEditor = null;

function openLineComment(event, path, line, text) {
  if (event.target.closest(".line-comment, .comment-editor")) return;
  closeCommentEditor();
  const editor = document.createElement("div");
  editor.className = "comment-editor";
  editor.innerHTML =
    `<div class="comment-context">${escapeHtml(path)}:${line}</div>` +
    `<textarea rows="2" placeholder="${escapeHtml(t.commentPlaceholder)}"></textarea>` +
    `<div class="comment-actions">` +
    `<button class="btn small" data-cancel>${escapeHtml(t.cancel)}</button>` +
    `<button class="btn btn-primary small" data-save>${escapeHtml(t.commentAdd)}</button>` +
    `</div>`;
  const row = event.currentTarget;
  row.after(editor);
  const area = editor.querySelector("textarea");
  area.focus();
  const save = () => {
    const body = area.value.trim();
    if (!body) return closeCommentEditor();
    state.comments.push({ path, line, body, text: String(text ?? "").slice(0, 160) });
    closeCommentEditor();
    renderCommentsBar();
    renderDiff();
  };
  editor.querySelector("[data-save]").addEventListener("click", save);
  editor.querySelector("[data-cancel]").addEventListener("click", closeCommentEditor);
  area.addEventListener("keydown", (keyEvent) => {
    if (keyEvent.key === "Enter" && (keyEvent.metaKey || keyEvent.ctrlKey)) {
      keyEvent.preventDefault();
      save();
    }
    if (keyEvent.key === "Escape") {
      keyEvent.stopPropagation();
      closeCommentEditor();
    }
  });
  commentEditor = editor;
}

function closeCommentEditor() {
  if (commentEditor) {
    commentEditor.remove();
    commentEditor = null;
  }
}

/** Comments on the current file, shown as sticky rows above the diff. */
function renderCommentRows(path) {
  const mine = state.comments.filter((comment) => comment.path === path);
  for (const comment of mine) {
    const row = document.createElement("div");
    row.className = "line-comment";
    row.innerHTML =
      `<span class="line-comment-where">${escapeHtml(String(comment.line))}</span>` +
      `<span class="line-comment-body">${escapeHtml(comment.body)}</span>` +
      `<button class="line-comment-remove" title="${escapeHtml(t.commentRemove)}">×</button>`;
    row.querySelector(".line-comment-remove").addEventListener("click", (clickEvent) => {
      clickEvent.stopPropagation();
      state.comments = state.comments.filter((item) => item !== comment);
      renderCommentsBar();
      renderDiff();
    });
    diffRoot.appendChild(row);
  }
}

/**
 * Pending comments become one message: file, line, and the reviewer's note.
 * Sending clears the list so the next review starts empty.
 */
function sendComments() {
  if (state.comments.length === 0) return;
  const lines = state.comments.map(
    (comment) => `- ${comment.path}:${comment.line} — ${comment.body}${comment.text ? `\n  (line: ${comment.text})` : ""}`,
  );
  const message = `${t.commentMessageIntro}\n\n${lines.join("\n")}`;
  const previous = input.value.trim();
  input.value = previous ? `${previous}\n\n${message}` : message;
  state.comments = [];
  renderCommentsBar();
  autoSize();
  input.focus();
  if (!workbench.hidden) closeWorkbench();
}

function renderCommentsBar() {
  const bar = $("comments-bar");
  if (!bar) return;
  const count = state.comments.length;
  bar.hidden = count === 0;
  $("comments-count").textContent = t.commentCount(count);
  $("comments-clear").hidden = count === 0;
}

$("comments-send").addEventListener("click", sendComments);
$("comments-clear").addEventListener("click", () => {
  state.comments = [];
  renderCommentsBar();
});


function renderDiffFileList(files = state.changes.files) {
  diffFilelist.innerHTML = "";
  for (const file of files) {
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
  renderGitBar();
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
      state.selectedChange = file.path;
      openWorkbench("diff");
      renderDiff();
    });
    changesList.appendChild(row);
  }
}

/* ---------- git ---------- */

function renderGitBar() {
  const bar = $("git-bar");
  const git = state.git;
  if (!git || !git.available) {
    renderTopbarLocation();
    bar.hidden = false;
    $("git-branch-name").textContent = t.gitNotRepo;
    $("git-sync").textContent = "";
    $("git-commit").hidden = true;
    return;
  }
  bar.hidden = false;
  renderTopbarLocation();
  $("git-branch-name").textContent = git.branch || "HEAD";
  const sync = [];
  if (git.ahead > 0) sync.push(t.gitAhead(git.ahead));
  if (git.behind > 0) sync.push(t.gitBehind(git.behind));
  if (sync.length === 0 && git.clean) sync.push(t.gitClean);
  $("git-sync").textContent = sync.join(" ");
  $("git-commit").hidden = git.clean;
}

function sendCommit() {
  const message = $("git-message").value.trim();
  const note = $("git-commit-note");
  if (!message) {
    note.textContent = t.commitEmpty;
    return;
  }
  note.textContent = "";
  api.send({ cmd: "gitCommit", message });
}

$("git-commit-button").addEventListener("click", sendCommit);
$("git-message").addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
    event.preventDefault();
    sendCommit();
  }
});
$("git-branch").addEventListener("click", () => {
  const name = state.git?.branch;
  if (name) void navigator.clipboard.writeText(name);
});

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

/* ---------- voice input ---------- */

/**
 * Dictation uses the Web Speech API. It is only present when Electron was built
 * with speech support and the OS exposes a recognizer, so the button stays
 * hidden when unavailable instead of failing on click.
 */
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null;
let voiceBase = "";

function setupVoice() {
  if (!SpeechRecognition) return;
  $("voice-button").hidden = false;
  $("voice-button").addEventListener("click", () => {
    if (recognition) {
      recognition.stop();
      return;
    }
    recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = state.locale === "zh" ? "zh-CN" : "en-US";
    voiceBase = input.value ? `${input.value} ` : "";

    recognition.onresult = (event) => {
      let final = "";
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) final += result[0].transcript;
        else interim += result[0].transcript;
      }
      if (final) {
        voiceBase += final;
      }
      input.value = `${voiceBase}${interim}`;
      autoSize();
    };
    recognition.onerror = () => stopVoice();
    recognition.onend = () => stopVoice();
    $("voice-button").classList.add("recording");
    $("voice-button").title = t.voiceStop;
    try {
      recognition.start();
    } catch {
      stopVoice();
    }
  });
}

function stopVoice() {
  if (recognition) {
    try {
      recognition.stop();
    } catch {
      /* already stopped */
    }
    recognition = null;
  }
  voiceBase = "";
  $("voice-button").classList.remove("recording");
  $("voice-button").title = t.voiceStart;
}

/* ---------- browser pane ---------- */

let browserBoundsTimer = null;

/** The page is a native view overlaying the window; keep it over its slot. */
function syncBrowserBounds() {
  if (state.pane !== "browser" || workbench.hidden) return;
  const slot = $("browser-page");
  if (!slot) return;
  const rect = slot.getBoundingClientRect();
  // Electron view bounds are in device-independent pixels, same as CSS pixels.
  void api.browserBounds({
    x: rect.left,
    y: rect.top,
    width: rect.width,
    height: rect.height,
  });
}

function scheduleBrowserBounds() {
  clearTimeout(browserBoundsTimer);
  browserBoundsTimer = setTimeout(syncBrowserBounds, 60);
}

function openBrowserPane(url) {
  openWorkbench("browser");
  if (url) {
    $("browser-url").value = url;
    void api.browserOpen(url);
  } else {
    void api.browserOpen("about:blank");
  }
  scheduleBrowserBounds();
}

function renderBrowserState(message) {
  if (!message) return;
  if (typeof message.url === "string" && message.url !== "about:blank" && document.activeElement !== $("browser-url")) {
    $("browser-url").value = message.url;
  }
  $("browser-back").disabled = !message.canGoBack;
  $("browser-forward").disabled = !message.canGoForward;
  $("browser-reload").textContent = "";
  workbenchMeta.textContent = message.title || message.url || t.paneBrowser;
}

$("browser-back").addEventListener("click", () => api.browserNavigate("back"));
$("browser-forward").addEventListener("click", () => api.browserNavigate("forward"));
$("browser-reload").addEventListener("click", () => api.browserNavigate("reload"));
$("browser-url").addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    api.browserNavigate("load", $("browser-url").value);
  }
});
$("browser-use").addEventListener("click", async () => {
  const snapshot = await api.browserSnapshot();
  if (!snapshot) return;
  const text = `${t.browserUsePrefix}\n${snapshot.url}\n\n${snapshot.text ?? ""}`;
  input.value = input.value.trim() ? `${input.value}\n\n${text}` : text;
  autoSize();
  input.focus();
  closeWorkbench();
});

window.addEventListener("resize", scheduleBrowserBounds);
api.onBrowserState?.(renderBrowserState);

/* ---------- artifacts ---------- */

function renderArtifacts() {
  const list = $("artifact-list");
  list.innerHTML = "";
  if (state.artifacts.length === 0) {
    list.innerHTML = `<div class="sidebar-empty">${escapeHtml(t.noArtifacts)}</div>`;
    return;
  }
  for (const artifact of state.artifacts) {
    const row = document.createElement("button");
    row.className = "artifact-row";
    row.innerHTML =
      `<span class="artifact-kind">${escapeHtml(artifact.kind)}</span>` +
      `<span class="artifact-path">${escapeHtml(artifact.path)}</span>`;
    row.title = `${artifact.path} · ${Math.round(artifact.size / 1024)} KB`;
    row.addEventListener("click", () => {
      state.selectedArtifact = artifact.path;
      api.send({ cmd: "getArtifact", path: artifact.path });
    });
    list.appendChild(row);
  }
}

/** Render one artifact in the right-hand workbench. */
function renderArtifact(artifact) {
  const tab = workbenchTabs.querySelector('[data-pane="artifact"]');
  if (tab) tab.hidden = false;
  // Open the artifact's own tab through the normal path so every other pane
  // is hidden consistently.
  state.selectedArtifact = artifact.path;
  openWorkbench("artifact");
  $("artifact-list-pane").hidden = true;
  const root = $("artifact-root");
  root.hidden = false;
  workbenchMeta.textContent = `${artifact.kind} · ${artifact.path}${artifact.truncated ? " · truncated" : ""}`;
  if (artifact.kind === "html") {
    // Scripts stay disabled: an agent-written page should not run in the app.
    root.innerHTML = `<iframe class="artifact-frame" sandbox="" referrerpolicy="no-referrer" srcdoc="${escapeHtml(artifact.content)}"></iframe>`;
  } else if (artifact.kind === "svg") {
    root.innerHTML = `<div class="artifact-svg">${artifact.content}</div>`;
  } else if (artifact.kind === "markdown") {
    root.innerHTML = `<div class="artifact-markdown markdown">${md(artifact.content)}</div>`;
  } else if (artifact.kind === "csv") {
    renderCsvTable(root, artifact.content);
  } else {
    root.innerHTML = `<pre class="artifact-json">${escapeHtml(artifact.content)}</pre>`;
  }
}

function renderCsvTable(root, text) {
  const rows = parseCsvLocal(text);
  if (rows.length === 0) {
    root.innerHTML = `<div class="diff-empty">${escapeHtml(t.emptyFile)}</div>`;
    return;
  }
  const head = rows[0].map((cell) => `<th>${escapeHtml(cell)}</th>`).join("");
  const body = rows
    .slice(1)
    .map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`)
    .join("");
  root.innerHTML = `<div class="artifact-table-wrap"><table class="artifact-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

/** Local CSV parse (the host parser is not importable from the renderer). */
function parseCsvLocal(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length && rows.length < 500; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((cell) => cell !== "")) rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    if (row.some((cell) => cell !== "")) rows.push(row);
  }
  return rows;
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

/** One canonical spelling per workspace, for grouping only. */
function normalizeCwd(cwd) {
  return String(cwd || "").replace(/[\\/]+/g, "/").replace(/\/+$/, "").toLowerCase();
}

/**
 * Folder names for project headers. Two different folders can share a leaf
 * name; those get their parent as a suffix so they stay distinguishable.
 */
function projectLabels(keys, displayPaths) {
  const labels = new Map();
  const used = new Map();
  const partsFor = (key) => String(displayPaths?.get(key) || key).split(/[\\/]/).filter(Boolean);
  // Keys are lowercased for comparison; labels keep the original spelling.
  for (const key of keys) {
    const parts = partsFor(key);
    const label = (parts.length > 0 ? parts[parts.length - 1] : "").toLowerCase();
    used.set(label, (used.get(label) ?? 0) + 1);
  }
  for (const key of keys) {
    const parts = partsFor(key);
    const label = parts.length > 0 ? parts[parts.length - 1] : t.noProject;
    if ((used.get(label.toLowerCase()) ?? 0) > 1 && parts.length > 1) {
      labels.set(key, `${parts[parts.length - 2]}/${label}`);
    } else {
      labels.set(key, label);
    }
  }
  return labels;
}

function projectLabel(cwd) {
  const parts = String(cwd || "").split(/[\\/]/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : t.noProject;
}

/**
 * Sessions are grouped by workspace, the way every coding agent organizes
 * them: one collapsible project header, its conversations underneath, and the
 * active project expanded. A flat list mixed folders together and made it
 * impossible to tell which project a conversation belonged to.
 */
function renderSessions(sessions) {
  state.sessions = sessions || [];
  sessionList.innerHTML = "";
  const query = state.sessionQuery.trim().toLowerCase();
  const visible = query
    ? state.sessions.filter(
        (session) =>
          (session.title ?? session.summary).toLowerCase().includes(query) ||
          session.summary.toLowerCase().includes(query) ||
          session.cwd.toLowerCase().includes(query),
      )
    : state.sessions;
  if (visible.length === 0) {
    const empty = document.createElement("div");
    empty.className = "sidebar-empty";
    empty.textContent = state.sessions.length === 0 ? t.noSessions : t.noSessionMatches;
    sessionList.appendChild(empty);
    return;
  }

  // Group by workspace, keeping the recency order of first appearance so the
  // project you just worked in stays on top. Older sessions stored the same
  // folder with different separators (G:\x vs G:/x), so keys are normalized.
  const groups = new Map();
  const displayPath = new Map();
  const lastUsed = new Map();
  for (const session of visible) {
    const key = normalizeCwd(session.cwd);
    if (!groups.has(key)) {
      groups.set(key, []);
      displayPath.set(key, session.cwd || "");
      lastUsed.set(key, session.updatedAt);
    }
    groups.get(key).push(session);
  }
  const activeProject = normalizeCwd(state.cwd);
  // A search result should reveal its projects rather than hide them.
  const expandAll = Boolean(query);

  const labels = projectLabels([...groups.keys()], displayPath);
  for (const [cwd, items] of groups) {
    // The open project folds to a single row that carries the conversation
    // count; collapsed projects show their most recent few conversations, so
    // every project stays reachable without a second click.
    const explicitOpen = state.expandedProjects.has(cwd) && !state.collapsedProjects.has(cwd);
    const explicitClosed = state.collapsedProjects.has(cwd);
    const open = expandAll || explicitOpen || (!explicitClosed && cwd === activeProject);
    const head = document.createElement("button");
    head.className = `session-group${cwd === activeProject ? " active" : ""}`;
    head.setAttribute("aria-expanded", open ? "true" : "false");
    const count = document.createElement("span");
    count.className = "session-group-count";
    count.textContent = String(items.length);
    const name = document.createElement("span");
    name.className = "session-group-name";
    name.textContent = labels.get(cwd) ?? projectLabel(displayPath.get(cwd) || cwd);
    name.title = displayPath.get(cwd) || cwd || t.noProject;
    const twisty = document.createElement("span");
    twisty.className = "session-group-twisty";
    twisty.textContent = open ? "▾" : "▸";
    // New chat inside this project, without leaving the current conversation.
    const add = document.createElement("span");
    add.className = "session-group-add";
    add.title = t.newSessionIn(projectLabel(cwd));
    add.textContent = "+";
    add.addEventListener("click", (event) => {
      event.stopPropagation();
      const target = displayPath.get(cwd) || cwd;
      if (target && target !== state.cwd) api.send({ cmd: "setCwd", cwd: target });
      else api.send({ cmd: "newSession" });
    });
    head.append(twisty, name, count, add);
    head.addEventListener("click", () => {
      if (open) {
        state.expandedProjects.delete(cwd);
        state.collapsedProjects.add(cwd);
      } else {
        state.expandedProjects.add(cwd);
        state.collapsedProjects.delete(cwd);
      }
      localStorage.setItem("prometheus.expandedProjects", JSON.stringify([...state.expandedProjects]));
      localStorage.setItem("prometheus.collapsedProjects", JSON.stringify([...state.collapsedProjects]));
      renderSessions(state.sessions);
    });
    sessionList.appendChild(head);
    // A folded project keeps its three latest conversations in view.
    const shown = open ? items : items.slice(0, 3);

    for (const session of shown) {
      const button = document.createElement("button");
      button.className = `session-item${session.id === state.sessionId ? " active" : ""}${session.pinned ? " pinned" : ""}`;
      const title = session.title || (session.summary && session.summary !== "(no messages)" ? session.summary : t.noMessages);
      // The timestamp is reference, not navigation: it appears on hover and
      // gives the row back its second line of height.
      button.innerHTML =
        (session.pinned ? `<span class="session-pin" title="${escapeHtml(t.sessionPinned)}">◆</span>` : "") +
        `<div class="session-title">${escapeHtml(title)}</div>` +
        `<span class="session-meta">${escapeHtml(relativeDate(session.updatedAt))}</span>`;
      button.title = `${title}\n${relativeDate(session.updatedAt)}\n${session.cwd}`;
      button.addEventListener("click", () => {
        api.send({ cmd: "loadSession", id: session.id });
        // On a narrow window the drawer covers the conversation once opened.
        if (window.matchMedia("(max-width: 860px)").matches) document.querySelector(".shell").classList.add("collapsed");
      });
      button.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        openSessionMenu(event, session);
      });
      sessionList.appendChild(button);
    }
  }
}

let sessionMenu = null;

function closeSessionMenu() {
  if (sessionMenu) {
    sessionMenu.remove();
    sessionMenu = null;
  }
}

/** Right-click actions for one session: pin, rename, archive, delete. */
function openSessionMenu(event, session) {
  closeSessionMenu();
  const menu = document.createElement("div");
  menu.className = "session-menu";
  const actions = [
    [session.pinned ? t.sessionUnpin : t.sessionPin, () => sendSessionFlags(session, { pinned: !session.pinned })],
    [t.sessionRename, () => renameSession(session)],
    [t.sessionFork, () => api.send({ cmd: "forkSession", id: session.id })],
    [session.archived ? t.sessionUnarchive : t.sessionArchive, () => {
      sendSessionFlags(session, { archived: !session.archived });
    }],
    [t.sessionDelete, () => {
      if (confirm(t.sessionDeleteConfirm)) api.send({ cmd: "deleteSession", id: session.id, includeArchived: state.showArchived });
    }],
  ];
  for (const [label, action] of actions) {
    const item = document.createElement("button");
    item.className = "session-menu-item";
    item.textContent = label;
    if (label === t.sessionDelete) item.classList.add("danger");
    item.addEventListener("click", () => {
      closeSessionMenu();
      action();
    });
    menu.appendChild(item);
  }
  menu.style.left = `${event.clientX}px`;
  menu.style.top = `${event.clientY}px`;
  document.body.appendChild(menu);
  sessionMenu = menu;
}

function sendSessionFlags(session, flags) {
  api.send({ cmd: "sessionFlags", id: session.id, includeArchived: state.showArchived, ...flags });
}

function renameSession(session) {
  const current = session.title || session.summary || "";
  const next = prompt(t.sessionRenamePrompt, current);
  if (next === null) return;
  sendSessionFlags(session, { title: next.trim() || null });
}

document.addEventListener("mousedown", (event) => {
  if (sessionMenu && !event.target.closest(".session-menu")) closeSessionMenu();
});
window.addEventListener("blur", closeSessionMenu);


function setDensity(density) {
  state.density = density;
  document.documentElement.dataset.density = density;
  localStorage.setItem("prometheus.density", density);
}

function setTheme(theme) {
  state.theme = theme;
  syncMenuControls();
  document.documentElement.dataset.theme = theme;
  localStorage.setItem("prometheus.theme", theme);
}

/* ---------- composer ---------- */

function autoSize() {
  input.style.height = "auto";
  input.style.height = `${Math.min(220, input.scrollHeight)}px`;
}

function submit() {
  const text = input.value.trim();
  const images = state.attachments.map((attachment) => attachment.url);
  if (!text && images.length === 0) return;
  input.value = "";
  autoSize();
  addUserTurn(text || t.imageOnlyPrompt, images.length);
  state.attachments = [];
  renderAttachments();
  api.send({ cmd: "prompt", text, images });
  input.focus();
}

input.addEventListener("input", autoSize);
input.addEventListener("keydown", (event) => {
  if (!commandMenu.hidden && commandState) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      moveCommand(event.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeCommandMenu();
      return;
    }
    if ((event.key === "Enter" || event.key === "Tab") && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      applyCommand(commandState.matches[commandState.index]);
      return;
    }
  }
  if (!fileMention.hidden && mention) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      moveMention(event.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeMention();
      return;
    }
    if ((event.key === "Enter" || event.key === "Tab") && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      const path = mention.files[mention.index];
      if (path) applyMention(path);
      return;
    }
  }
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    submit();
  }
});

sendButton.addEventListener("click", submit);
stopButton.addEventListener("click", () => {
  api.send({ cmd: "abort" });
  input.focus();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    if (paletteState) {
      closePalette();
      return;
    }
    if (!findBar.hidden) {
      closeFind();
      return;
    }
    if (!settingsDialog.hidden || !shortcutsDialog.hidden) {
      closeModal(settingsDialog);
      closeModal(shortcutsDialog);
      return;
    }
    if (!topbarMenu.hidden) {
      setTopbarMenu(false);
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
  if (key === "k") {
    event.preventDefault();
    openPalette();
  } else if (key === "f") {
    event.preventDefault();
    openFind();
  } else if (key === "n") {
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
    openWorkbench("diff");
  } else if (key === "e" && event.shiftKey) {
    event.preventDefault();
    openWorkbench("files");
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



/* ---------- pasted images ---------- */

const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

function addAttachment(dataUrl, name) {
  if (state.attachments.length >= 6) {
    addNotice("warn", t.attachmentLimit);
    return;
  }
  state.attachments.push({ url: dataUrl, name: name || "image" });
  renderAttachments();
}

function renderAttachments() {
  const strip = $("attachments");
  strip.innerHTML = "";
  strip.hidden = state.attachments.length === 0;
  state.attachments.forEach((attachment, index) => {
    const chip = document.createElement("div");
    chip.className = "attachment";
    chip.innerHTML =
      `<img src="${attachment.url}" alt="${escapeHtml(attachment.name)}" />` +
      `<button class="attachment-remove" title="${escapeHtml(t.attachmentRemove)}">×</button>`;
    chip.querySelector(".attachment-remove").addEventListener("click", () => {
      state.attachments.splice(index, 1);
      renderAttachments();
    });
    strip.appendChild(chip);
  });
}

/** Paste or drop an image into the composer. */
function handleImageFiles(files) {
  for (const file of files) {
    if (!file.type.startsWith("image/")) continue;
    if (file.size > MAX_IMAGE_BYTES) {
      addNotice("warn", t.attachmentTooLarge);
      continue;
    }
    const reader = new FileReader();
    reader.onload = () => addAttachment(String(reader.result), file.name);
    reader.readAsDataURL(file);
  }
}

input.addEventListener("paste", (event) => {
  const files = [...(event.clipboardData?.files ?? [])].filter((file) => file.type.startsWith("image/"));
  if (files.length === 0) return;
  event.preventDefault();
  handleImageFiles(files);
});

document.addEventListener("drop", (event) => {
  const files = [...(event.dataTransfer?.files ?? [])].filter((file) => file.type.startsWith("image/"));
  if (files.length === 0) return;
  event.preventDefault();
  handleImageFiles(files);
});
document.addEventListener("dragover", (event) => {
  if ([...(event.dataTransfer?.types ?? [])].includes("Files")) event.preventDefault();
});


/* ---------- pull request and checks ---------- */

function renderPrBar() {
  const bar = $("pr-bar");
  const info = state.pr;
  if (!info || !info.available) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  const pr = info.pr;
  $("pr-create").hidden = Boolean(pr);
  $("pr-open").hidden = !pr;
  if (!pr) {
    $("pr-state").textContent = t.prNone;
    $("pr-state").className = "pr-state";
    $("pr-title").textContent = "";
    $("pr-checks").textContent = "";
    return;
  }
  const stateLabel = pr.isDraft ? t.prDraft : pr.state === "OPEN" ? t.prOpenState : pr.state === "MERGED" ? t.prMerged : t.prClosed;
  $("pr-state").textContent = `#${pr.number} ${stateLabel}`;
  $("pr-state").className = `pr-state ${pr.state === "MERGED" ? "merged" : pr.state === "OPEN" ? "open" : "closed"}`;
  $("pr-title").textContent = pr.title ?? "";
  $("pr-title").title = pr.title ?? "";
  const checks = pr.checks ?? { total: 0 };
  if (checks.total === 0) {
    $("pr-checks").textContent = "";
  } else if (checks.failed > 0) {
    $("pr-checks").textContent = t.checksFailed(checks.failed, checks.total);
    $("pr-checks").className = "pr-checks failed";
    $("pr-checks").title = checks.failing.join("\n");
  } else if (checks.pending > 0) {
    $("pr-checks").textContent = t.checksPending(checks.pending, checks.total);
    $("pr-checks").className = "pr-checks pending";
  } else {
    $("pr-checks").textContent = t.checksPassed(checks.total);
    $("pr-checks").className = "pr-checks passed";
  }
}

$("pr-open").addEventListener("click", () => {
  if (state.pr?.pr?.url) api.openExternal(state.pr.pr.url);
});

$("pr-create").addEventListener("click", async () => {
  // A PR needs a pushed branch; ask the agent to run the push so the user sees
  // the command in the transcript instead of it happening silently.
  const current = state.sessions.find((session) => session.id === state.sessionId);
  const title = prompt(t.prTitlePrompt, current?.title || current?.summary || "");
  if (title === null) return;
  api.send({ cmd: "createPr", title: title.trim(), body: t.prBodyDefault });
});

/* ---------- command palette ---------- */

/**
 * One searchable list of actions and open commands. It is the discoverable
 * counterpart to the keyboard shortcuts, not a second implementation: every
 * entry calls the same function the button or shortcut calls.
 */
function paletteEntries() {
  const entries = [
    { label: t.newSession, run: () => api.send({ cmd: "newSession" }) },
    { label: t.shortcutSettings, run: openSettings },
    { label: t.shortcutShortcuts, run: openShortcuts },
    { label: t.toggleSidebar, run: toggleSidebar },
    { label: t.newWindow, run: () => api.newWindow() },
    { label: t.exportSession, run: () => api.send({ cmd: "exportSession" }) },
    { label: t.sessionFork, run: () => api.send({ cmd: "forkSession" }) },
    { label: t.paneDiff, run: () => openWorkbench("diff") },
    { label: t.tabFiles, run: () => openWorkbench("files") },
    { label: t.tabChanges, run: () => openWorkbench("diff") },
    { label: t.tabArtifacts, run: () => openWorkbench("artifact") },
    { label: t.tabHistory, run: () => openWorkbench("history") },
    { label: t.paneTerminal, run: () => openWorkbench("terminal") },
    { label: t.paneBrowser, run: () => openWorkbench("browser") },
    { label: t.shortcutFind, run: openFind },
    { label: t.worktreeLabel, run: () => { $("worktree-panel").hidden = false; } },
    { label: t.modeAsk, run: () => api.send({ cmd: "setMode", mode: "ask" }) },
    { label: t.modeAuto, run: () => api.send({ cmd: "setMode", mode: "auto" }) },
    { label: t.modePlan, run: () => api.send({ cmd: "setMode", mode: "plan" }) },
    { label: t.shortcutStop, run: () => api.send({ cmd: "abort" }) },
  ];
  for (const command of state.commands) {
    entries.push({
      label: `/${command.name}`,
      hint: command.description || command.argumentHint || "",
      run: () => {
        input.value = `/${command.name} `;
        autoSize();
        input.focus();
      },
    });
  }
  return entries;
}

let paletteState = null;

function openPalette() {
  paletteState = { index: 0, entries: [] };
  $("palette-scrim").hidden = false;
  $("command-palette").hidden = false;
  const field = $("palette-input");
  field.value = "";
  field.placeholder = t.palettePlaceholder;
  renderPalette();
  field.focus();
}

function closePalette() {
  paletteState = null;
  $("palette-scrim").hidden = true;
  $("command-palette").hidden = true;
  input.focus();
}

function renderPalette() {
  if (!paletteState) return;
  const query = $("palette-input").value.trim().toLowerCase();
  const all = paletteEntries();
  const matches = query
    ? all.filter((entry) => entry.label.toLowerCase().includes(query) || (entry.hint ?? "").toLowerCase().includes(query))
    : all;
  paletteState.entries = matches;
  paletteState.index = Math.min(paletteState.index, Math.max(0, matches.length - 1));
  const list = $("palette-list");
  list.innerHTML = "";
  if (matches.length === 0) {
    list.innerHTML = `<div class="palette-empty">${escapeHtml(t.paletteEmpty)}</div>`;
    return;
  }
  matches.forEach((entry, index) => {
    const row = document.createElement("button");
    row.className = `palette-row${index === paletteState.index ? " active" : ""}`;
    row.innerHTML =
      `<span class="palette-label">${escapeHtml(entry.label)}</span>` +
      (entry.hint ? `<span class="palette-hint">${escapeHtml(entry.hint)}</span>` : "");
    row.addEventListener("mousedown", (event) => {
      event.preventDefault();
      runPaletteEntry(entry);
    });
    list.appendChild(row);
  });
}

function runPaletteEntry(entry) {
  closePalette();
  entry?.run();
}

$("palette-input").addEventListener("input", renderPalette);
$("palette-input").addEventListener("keydown", (event) => {
  if (!paletteState) return;
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const count = paletteState.entries.length;
    if (count === 0) return;
    paletteState.index = (paletteState.index + (event.key === "ArrowDown" ? 1 : -1) + count) % count;
    renderPalette();
    $("palette-list").children[paletteState.index]?.scrollIntoView({ block: "nearest" });
  } else if (event.key === "Enter") {
    event.preventDefault();
    runPaletteEntry(paletteState.entries[paletteState.index]);
  } else if (event.key === "Escape") {
    event.preventDefault();
    closePalette();
  }
});
$("palette-scrim").addEventListener("mousedown", closePalette);

/* ---------- scroll-to-latest ---------- */

transcript.addEventListener("scroll", updateScrollButton);
transcriptScroll.addEventListener("scroll", updateScrollButton);
$("scroll-bottom").addEventListener("click", () => scrollToBottom(true));

function answerPermission(answer) {
  if (state.pendingPermissionId == null) return;
  api.send({ cmd: "permission", id: state.pendingPermissionId, answer });
  state.pendingPermissionId = null;
  pendingPermission.hidden = true;
  $("pending-choices").hidden = true;
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

effortControl.querySelectorAll("[data-effort]").forEach((button) => {
  button.addEventListener("click", () => {
    setEffortMenu(false);
    if (button.dataset.effort !== state.effort) api.send({ cmd: "setEffort", effort: button.dataset.effort });
  });
});

const effortPicker = $("effort-picker");
const effortMenu = $("effort-menu");

function setEffortMenu(open) {
  effortMenu.hidden = !open;
  effortPicker.setAttribute("aria-expanded", String(open));
}

effortPicker.addEventListener("click", (event) => {
  event.stopPropagation();
  setEffortMenu(effortMenu.hidden);
});

document.addEventListener("click", (event) => {
  if (!event.target.closest("#effort-control")) setEffortMenu(false);
});

modelPicker.addEventListener("click", (event) => {
  event.stopPropagation();
  if (modelMenu.hidden) openModelMenu();
  else closeModelMenu();
});

$("topbar-cwd").addEventListener("click", async () => {
  const dir = await api.pickDirectory();
  if (dir) api.send({ cmd: "setCwd", cwd: dir });
});

/* ---------- isolated worktree ---------- */

function renderWorktree() {
  const active = state.worktree;
  // The worktree control lives on the active project's header, so its state
  // reads where the project is named instead of in a second card.
  $("worktree-button").classList.toggle("active", Boolean(active));
  $("worktree-button").title = active ? `${t.worktreeLabel}: ${active.branch}` : t.worktreeLabel;
  $("worktree-actions-off").hidden = Boolean(active);
  $("worktree-actions-on").hidden = !active;
  $("worktree-copy").textContent = active ? `${t.worktreeActive} ${active.path}` : t.worktreeExplain;
}

$("worktree-button").addEventListener("click", (event) => {
  event.stopPropagation();
  const panel = $("worktree-panel");
  panel.hidden = !panel.hidden;
  $("worktree-button").setAttribute("aria-expanded", String(!panel.hidden));
});

document.addEventListener("click", (event) => {
  if (!event.target.closest("#worktree-panel") && !event.target.closest("#worktree-button")) {
    const panel = $("worktree-panel");
    if (!panel.hidden) {
      panel.hidden = true;
      $("worktree-button").setAttribute("aria-expanded", "false");
    }
  }
});

$("worktree-enable").addEventListener("click", () => api.send({ cmd: "worktreeStart" }));
$("worktree-diff").addEventListener("click", () => api.send({ cmd: "worktreeDiff" }));
$("worktree-merge").addEventListener("click", () => {
  if (confirm(t.worktreeMergeConfirm)) api.send({ cmd: "worktreeMerge" });
});
$("worktree-discard").addEventListener("click", () => {
  if (confirm(t.worktreeDiscardConfirm)) api.send({ cmd: "worktreeDiscard" });
});

const clearConversation = () => {
  // Clearing keeps the session and its saved history; only the transcript goes.
  if (confirm(t.clearConfirm)) api.send({ cmd: "clearHistory" });
};
$("new-session").addEventListener("click", () => api.send({ cmd: "newSession" }));
$("refresh-sessions").addEventListener("click", () => {
  api.send({ cmd: "listSessions", includeArchived: state.showArchived });
});

$("toggle-archived").addEventListener("click", () => {
  state.showArchived = !state.showArchived;
  $("toggle-archived").classList.toggle("active", state.showArchived);
  $("toggle-archived").title = state.showArchived ? t.hideArchived : t.showArchived;
  api.send({ cmd: "listSessions", includeArchived: state.showArchived });
});

$("session-search").addEventListener("input", (event) => {
  state.sessionQuery = event.target.value;
  renderSessions(state.sessions);
});

/** Collapse or expand the conversation sidebar; remembered across restarts. */
function toggleSidebar() {
  const collapsed = document.querySelector(".shell").classList.toggle("collapsed");
  localStorage.setItem("prometheus.sidebarCollapsed", collapsed ? "1" : "0");
}
if (localStorage.getItem("prometheus.sidebarCollapsed") === "1") {
  document.querySelector(".shell").classList.add("collapsed");
}

$("topbar-sidebar-toggle").addEventListener("click", toggleSidebar);

/* ---------- top bar: workspace, changes, terminal ---------- */

function renderTopbarLocation() {
  const cwd = state.cwd ?? "";
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  $("topbar-cwd-name").textContent = parts.length > 0 ? parts[parts.length - 1] : t.appName;
  $("topbar-cwd").title = cwd || t.appName;
  const branch = state.git?.available ? state.git.branch : "";
  const branchNode = $("topbar-cwd-branch");
  branchNode.hidden = !branch;
  branchNode.textContent = branch ?? "";
}

function renderChangesBadge() {
  const count = state.changes.files.length;
  const badge = $("changes-badge");
  badge.hidden = count === 0;
  badge.textContent = String(count);
  $("changes-button").title = count > 0 ? `${t.paneDiff} (${count})` : t.paneDiff;
}

$("changes-button").addEventListener("click", () => {
  if (!workbench.hidden && state.pane === "diff") closeWorkbench();
  else openWorkbench("diff");
});
$("terminal-button").addEventListener("click", () => {
  if (!workbench.hidden && state.pane === "terminal") closeWorkbench();
  else openWorkbench("terminal");
});


workbenchTabs.querySelectorAll("button").forEach((button) => {
  button.addEventListener("click", () => openWorkbench(button.dataset.pane));
});

$("close-workbench").addEventListener("click", closeWorkbench);

$("diff-scope").querySelectorAll("button").forEach((button) => {
  button.addEventListener("click", () => {
    state.diffScope = button.dataset.scope;
    $("diff-scope").querySelectorAll("button").forEach((node) => {
      node.classList.toggle("active", node === button);
    });
    state.selectedChange = null;
    renderDiff();
  });
});

/* ---------- window controls ---------- */

// Windows and Linux draw their caption buttons in the renderer so they match
// the top bar; macOS keeps its native traffic lights.
const windowControls = $("window-controls");
if (api.platform && api.platform !== "darwin") {
  windowControls.hidden = false;
  document.documentElement.classList.add("custom-caption");
  windowControls.querySelectorAll("[data-window]").forEach((button) => {
    button.addEventListener("click", () => api.windowControl(button.dataset.window));
  });
  const applyWindowState = ({ maximized }) => {
    document.documentElement.classList.toggle("window-maximized", Boolean(maximized));
    $("window-maximize").title = maximized ? "Restore" : "Maximize";
  };
  api.onWindowState?.(applyWindowState);
  void api.windowState?.().then(applyWindowState);
}

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

function openSettings(tab = "connection") {
  api.send({ cmd: "getSettings" });
  selectSettingsTab(tab);
  openModal(settingsDialog);
  // Land focus on the category rail, not the close button.
  document.querySelector("[data-settings-tab].active")?.focus();
}

function selectSettingsTab(tab) {
  document.querySelectorAll("[data-settings-tab]").forEach((button) => {
    const active = button.dataset.settingsTab === tab;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", active ? "true" : "false");
  });
  document.querySelectorAll("[data-settings-pane]").forEach((pane) => {
    pane.hidden = pane.dataset.settingsPane !== tab;
  });
  state.settingsTab = tab;
}

$("settings-nav").addEventListener("click", (event) => {
  const button = event.target.closest("[data-settings-tab]");
  if (button) selectSettingsTab(button.dataset.settingsTab);
});

/** First-run path: open Settings on the connection fields with a short prompt. */
function openSetup() {
  $("models-hint").textContent = t.setupHint;
  $("models-hint").hidden = false;
  openSettings("connection");
  setTimeout(() => $("setting-base-url").focus(), 60);
}

$("setup-button").addEventListener("click", openSetup);

/** Saved approval rules with a remove action, newest last. */
function renderRules(rules) {
  const list = $("setting-rules");
  list.innerHTML = "";
  if (rules.length === 0) {
    const empty = document.createElement("span");
    empty.className = "rules-empty";
    empty.textContent = t.rulesEmpty;
    list.appendChild(empty);
    return;
  }
  for (const rule of rules) {
    const row = document.createElement("div");
    row.className = "rules-row";
    const label = document.createElement("span");
    label.className = "rules-label";
    label.textContent = `${rule.action === "deny" ? "✕" : "✓"} ${rule.tool}${rule.match ? ` · ${rule.match}` : ""}`;
    label.title = `${rule.scope}${rule.cwd ? ` · ${rule.cwd}` : ""}`;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "link-button";
    remove.textContent = t.rulesRemove;
    remove.addEventListener("click", () => api.send({ cmd: "removeRule", id: rule.id }));
    row.append(label, remove);
    list.appendChild(row);
  }
}

function fillSettings(s) {
  state.providers = s.providers || [];
  state.provider = s.provider || "custom";
  const providerSelect = $("setting-provider");
  providerSelect.innerHTML = "";
  for (const provider of s.providers || []) {
    const option = document.createElement("option");
    option.value = provider.id;
    option.textContent = provider.configured ? provider.label : `${provider.label} · ${t.providerNoKey}`;
    providerSelect.appendChild(option);
  }
  if (s.baseUrl && ![...providerSelect.options].some((option) => option.value === s.provider)) {
    const custom = document.createElement("option");
    custom.value = "custom";
    custom.textContent = t.providerCustom;
    providerSelect.appendChild(custom);
  }
  if (s.provider === "custom" && ![...providerSelect.options].some((option) => option.value === "custom")) {
    const custom = document.createElement("option");
    custom.value = "custom";
    custom.textContent = t.providerCustom;
    providerSelect.appendChild(custom);
  }
  providerSelect.value = s.provider || "custom";
  providerSelect.dataset.last = providerSelect.value;
  $("setting-base-url").value = s.baseUrl || "";
  $("models-hint").hidden = true;
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
  $("setting-auto-approve").value = (s.autoApprove ?? []).join(", ");
  $("setting-fallback").value = (s.fallbackModels ?? []).join(", ");
  renderRules(s.rules ?? []);
  $("setting-sandbox").value = s.sandbox === "off" ? "off" : "enforce";
  $("setting-network").value = ["off", "proxy", "open"].includes(s.networkPolicy) ? s.networkPolicy : "off";
  state.sandbox = $("setting-sandbox").value;
  // Refresh the mode chip so the un-isolated marker tracks the saved value.
  setMode(state.mode);
  $("setting-context").value = s.contextWindow;
  const modelContext = $("setting-context").parentElement.querySelector(".field-hint");
  if (modelContext) modelContext.remove();
  if (s.modelContext) {
    const hint = document.createElement("span");
    hint.className = "field-hint";
    hint.textContent = t.contextFromEndpoint(Math.round(s.modelContext / 1000));
    $("setting-context").parentElement.appendChild(hint);
  }
  $("setting-locale").value = s.locale;
  $("setting-theme").value = s.theme;
  $("setting-density").value = state.density;
  $("settings-note").textContent = "";
}

$("setting-api-key").addEventListener("focus", (event) => {
  if (event.target.dataset.masked === "1") {
    event.target.value = "";
    event.target.dataset.masked = "";
  }
});

// Choosing a provider fills in its base URL so the two controls stay coherent.
$("setting-provider").addEventListener("change", (event) => {
  const providers = state.providers ?? [];
  const chosen = providers.find((provider) => provider.id === event.target.value);
  if (chosen) $("setting-base-url").value = chosen.baseUrl;
});

function saveSettings() {
  api.send({
    cmd: "saveSettings",
    settings: {
      provider: $("setting-provider").value,
      baseUrl: $("setting-base-url").value,
      apiKey: $("setting-api-key").value,
      model: $("setting-model").value,
      mode: $("setting-mode").value,
      effort: $("setting-effort").value,
      maxTokens: Number($("setting-max-tokens").value),
      autoApprove: $("setting-auto-approve").value,
      fallbackModels: $("setting-fallback").value,
      sandbox: $("setting-sandbox").value,
      networkPolicy: $("setting-network").value,
      contextWindow: Number($("setting-context").value),
      locale: $("setting-locale").value,
      theme: $("setting-theme").value,
    },
  });
  setDensity($("setting-density").value);
}

$("settings-button").addEventListener("click", openSettings);
$("settings-close").addEventListener("click", () => closeModal(settingsDialog));
$("settings-cancel").addEventListener("click", () => closeModal(settingsDialog));
$("settings-save").addEventListener("click", saveSettings);

/* ---------- about / update check ---------- */

async function refreshVersion() {
  if (!api.appVersion) return;
  const version = await api.appVersion();
  const node = $("about-version");
  if (node && version) node.textContent = version;
}

$("check-update").addEventListener("click", async () => {
  const note = $("update-note");
  note.textContent = t.updateChecking;
  const result = await api.checkUpdate();
  if (!result || result.status === "unconfigured") {
    note.textContent = t.updateUnconfigured;
  } else if (result.status === "error") {
    note.textContent = `${t.updateError} ${result.message ?? ""}`;
  } else if (result.status === "available") {
    note.innerHTML =
      `${escapeHtml(t.updateAvailable)} ${escapeHtml(result.latest)} ` +
      (result.url ? `<button class="link-button" id="update-open">${escapeHtml(t.updateOpen)}</button>` : "");
    const open = $("update-open");
    if (open) open.addEventListener("click", () => api.openExternal(result.url));
  } else {
    note.textContent = t.updateCurrent;
  }
});

/* ---------- shortcuts sheet ---------- */

function openShortcuts() {
  const mod = api.platform === "darwin" ? "⌘" : "Ctrl";
  const rows = [
    [t.shortcutNewChat, `${mod}+N`],
    [t.shortcutPalette, `${mod}+K`],
    [t.shortcutFind, `${mod}+F`],
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

$("shortcuts-close").addEventListener("click", () => closeModal(shortcutsDialog));

async function exportSessionFile(markdown, filename) {
  if (!api.saveFile) return;
  const result = await api.saveFile(filename, markdown);
  if (result?.saved) addNotice("dim", `${t.exportSaved} ${result.path}`);
}

/* ---------- top bar overflow menu ---------- */

const topbarMenu = $("topbar-menu");

/** Reflect the current theme and language on the overflow menu controls. */
function syncMenuControls() {
  if (!document.getElementById("menu-theme")) return;
  document.querySelectorAll("#menu-theme [data-theme-choice]").forEach((button) => {
    button.classList.toggle("active", button.dataset.themeChoice === state.theme);
  });
  document.querySelectorAll("#menu-locale [data-locale]").forEach((button) => {
    button.classList.toggle("active", button.dataset.locale === state.locale);
  });
}

$("menu-theme").addEventListener("click", (event) => {
  const button = event.target.closest("[data-theme-choice]");
  if (!button) return;
  setTheme(button.dataset.themeChoice);
  syncMenuControls();
});

$("menu-locale").addEventListener("click", (event) => {
  const button = event.target.closest("[data-locale]");
  if (!button) return;
  if (button.dataset.locale !== state.locale) applyLocale(button.dataset.locale, { announce: true });
  syncMenuControls();
});


function setTopbarMenu(open) {
  topbarMenu.hidden = !open;
  $("more-button").setAttribute("aria-expanded", open ? "true" : "false");
}

$("more-button").addEventListener("click", (event) => {
  event.stopPropagation();
  const open = topbarMenu.hidden;
  setTopbarMenu(open);
  if (open) syncMenuControls();
});

topbarMenu.addEventListener("click", (event) => {
  if (event.target.closest(".menu-setting")) return;
  const row = event.target.closest(".menu-row");
  if (!row) return;
  setTopbarMenu(false);
  if (row.id === "menu-export") api.send({ cmd: "exportSession" });
  else if (row.id === "menu-new-window") api.newWindow();
  else if (row.id === "menu-shortcuts") openShortcuts();
  else if (row.id === "menu-clear") clearConversation();
});

document.addEventListener("click", (event) => {
  if (!topbarMenu.hidden && !event.target.closest("#topbar-menu") && !event.target.closest("#more-button")) {
    setTopbarMenu(false);
  }
});

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
setMode(state.mode);
setTheme(state.theme);
setDensity(state.density);
setupVoice();
void refreshVersion();
api.send({ cmd: "listSessions" });
api.send({ cmd: "listCommands" });
// The inspector is opened by the action that needs it, not on launch: a
// remembered pane used to eat half the window before the first message.
if (state.workbenchOpen) {
  state.workbenchOpen = false;
  localStorage.setItem("prometheus.workbench", "0");
}
api.send({ cmd: "getTree", path: "." });
api.send({ cmd: "setLocale", locale: state.locale });
input.focus();
