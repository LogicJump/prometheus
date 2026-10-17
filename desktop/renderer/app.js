/** Prometheus desktop renderer. */

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
const modelControl = $("model-control");
const contextLabel = $("context-label");
const contextFill = $("context-fill");
const usageLabel = $("usage-label");
const pendingPermission = $("pending-permission");
const pendingQuestion = $("pending-question");
const drawer = $("drawer");
const scrim = $("scrim");
const sessionList = $("session-list");

const state = {
  busy: false,
  mode: "ask",
  model: "",
  allowed: [],
  sessionId: "",
  currentAssistant: null,
  currentThinking: null,
  currentTool: null,
  lastToolNode: null,
  pendingPermissionId: null,
};

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
    const text = inline(paragraph.join(" "));
    out.push(`<p>${text}</p>`);
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
          `<button class="code-copy" data-code>copy</button></div>` +
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
  // Keep a comfortable gap between tool activity and the answer that follows.
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
      button.textContent = "copied";
      setTimeout(() => (button.textContent = "copy"), 1200);
    });
  });
}

function addToolRow(name, summary) {
  const glyph = name === "bash" ? "›" : name === "read_file" || name === "list_files" || name === "grep" || name === "glob" ? "◦" : "✦";
  const node = addNode(
    `<div class="tool-row running">` +
      `<span class="tool-glyph">${glyph}</span>` +
      `<span class="tool-name">${escapeHtml(name)}</span>` +
      `<span class="tool-summary">${escapeHtml(summary || "")}</span>` +
      `<button class="tool-expand" hidden>details</button>` +
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
    button.textContent = outputNode.hidden ? "details" : "hide";
    row.classList.toggle("open", !outputNode.hidden);
    if (!outputNode.hidden) outputNode.scrollTop = outputNode.scrollHeight;
  });
}

function startThinking() {
  if (state.currentThinking) return;
  state.currentThinking = addNode(`<div class="thinking">thinking…</div>`);
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
      `<div class="plan-title">Plan</div>` +
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
  statusDot.className = `status-dot ${busy ? "working" : "ready"}`;
  statusText.textContent = busy ? "working" : "ready";
}

function setStatus(kind, text) {
  statusDot.className = `status-dot ${kind}`;
  statusText.textContent = text;
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
    usageLabel.textContent = total >= 1000 ? `${(total / 1000).toFixed(1)}k tok` : `${total} tok`;
  }
}

function setMode(mode) {
  state.mode = mode;
  modeControl.querySelectorAll("button").forEach((button) => {
    button.classList.toggle("active", button.dataset.mode === mode);
  });
}

function renderModels(allowed, current) {
  state.allowed = allowed || [];
  state.model = current;
  modelControl.innerHTML = "";
  for (const model of state.allowed) {
    const button = document.createElement("button");
    button.textContent = model;
    button.dataset.model = model;
    button.classList.toggle("active", model === current);
    button.addEventListener("click", () => {
      if (model !== state.model) api.send({ cmd: "setModel", model });
    });
    modelControl.appendChild(button);
  }
}

/* ---------- host events ---------- */

function handleEvent(message) {
  switch (message.type) {
    case "hello":
      setStatus("working", "connecting");
      break;

    case "ready":
      setBusy(false);
      setStatus("ready", "ready");
      break;

    case "state":
      state.sessionId = message.sessionId;
      setMode(message.mode);
      renderModels(message.allowedModels, message.model);
      workspacePath.textContent = message.cwd;
      workspacePath.title = message.cwd;
      updateMeter(message.context, message.usage);
      break;

    case "model":
      renderModels(message.allowed, message.model);
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
      setStatus("error", "error");
      scrollToBottom();
      break;

    case "run_end":
      flushAssistant();
      endThinking();
      setBusy(false);
      updateMeter(message.context, message.usage);
      if (message.files && message.files.length > 0) {
        const list = message.files
          .slice(0, 8)
          .map((f) => `${f.path}`)
          .join(", ");
        addNode(`<div class="notice dim">changed ${message.files.length} file${message.files.length === 1 ? "" : "s"}: ${escapeHtml(list)}${message.files.length > 8 ? "…" : ""}</div>`);
      }
      break;

    case "session_loaded":
      transcript.querySelectorAll(".turn, .tool-row, .tool-output, .notice, .plan, .thinking").forEach((node) => node.remove());
      state.currentAssistant = null;
      state.currentThinking = null;
      state.currentTool = null;
      for (const item of message.messages || []) {
        if (item.role === "user") addUserTurn(item.text);
        else if (item.role === "assistant") {
          const node = addNode(`<div class="turn assistant"><div class="markdown">${renderMarkdown(item.text)}</div></div>`);
          bindCodeCopy(node);
        } else if (item.role === "tool") {
          const node = addNode(
            `<div class="tool-row"><span class="tool-glyph">✦</span><span class="tool-name">${escapeHtml(item.name)}</span>` +
              `<span class="tool-summary">${escapeHtml(item.summary || "")}</span></div>`,
          );
          void node;
        }
      }
      if ((message.messages || []).length === 0) {
        transcript.appendChild(emptyState);
        emptyState.hidden = false;
      }
      scrollToBottom(true);
      break;

    case "sessions":
      renderSessions(message.sessions);
      break;

    case "host_exit":
      setBusy(false);
      setStatus("error", "host stopped");
      break;

    case "fatal":
      setBusy(false);
      setStatus("error", "config error");
      addNode(`<div class="notice error">${escapeHtml(message.message)}</div>`);
      break;

    default:
      if (message.type) console.debug("unhandled host event", message);
  }
}

/* ---------- sessions ---------- */

function renderSessions(sessions) {
  sessionList.innerHTML = "";
  if (!sessions || sessions.length === 0) {
    sessionList.innerHTML = `<div class="notice dim" style="padding:0">No saved sessions yet.</div>`;
    return;
  }
  for (const session of sessions) {
    const button = document.createElement("button");
    button.className = `session-item${session.id === state.sessionId ? " active" : ""}`;
    button.innerHTML =
      `<div class="session-title">${escapeHtml(session.summary || "(no messages)")}</div>` +
      `<div class="session-meta">${escapeHtml(new Date(session.updatedAt).toLocaleString())} · ${escapeHtml(session.id)}</div>`;
    button.addEventListener("click", () => {
      api.send({ cmd: "loadSession", id: session.id });
      closeDrawer();
    });
    sessionList.appendChild(button);
  }
}

function openDrawer() {
  api.send({ cmd: "listSessions" });
  drawer.hidden = false;
  scrim.hidden = false;
}

function closeDrawer() {
  drawer.hidden = true;
  scrim.hidden = true;
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
    if (!pendingPermission.hidden) {
      answerPermission("no");
      return;
    }
    if (!drawer.hidden) {
      closeDrawer();
      return;
    }
    if (state.busy) api.send({ cmd: "abort" });
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "n") {
    event.preventDefault();
    api.send({ cmd: "newSession" });
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    closeDrawer();
  }
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

$("workspace-button").addEventListener("click", async () => {
  const dir = await api.pickDirectory();
  if (dir) api.send({ cmd: "setCwd", cwd: dir });
});

$("sessions-button").addEventListener("click", openDrawer);
$("drawer-close").addEventListener("click", closeDrawer);
scrim.addEventListener("click", closeDrawer);
$("new-session").addEventListener("click", () => {
  api.send({ cmd: "newSession" });
  closeDrawer();
});

document.querySelectorAll(".suggestion").forEach((button) => {
  button.addEventListener("click", () => {
    input.value = button.dataset.prompt;
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
input.focus();
