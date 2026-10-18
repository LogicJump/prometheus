/**
 * The Settings page.
 *
 * Built as a factory because it shares the renderer's state and helpers: the
 * app passes them in once and gets back the entry points it needs. Every
 * control applies immediately — there is no Save step, and no draft state to
 * lose when the page is closed.
 */

import { settingsStrings } from "./settings-i18n.js";
import { iconEl } from "./icons.js";

export function createSettings(deps) {
  const { state, $, api, formatTokens, setTheme, setDensity, setMode, applyLocale, openModal, closeModal, getT, applyCodeFont } = deps;
  // `t` is rebound on every locale change, so every read goes through getT().
  const t = new Proxy({}, { get: (_, key) => getT()[key] });
  const settingsDialog = $("settings-dialog");
  const shortcutsDialog = $("shortcuts-dialog");
  const modalScrim = $("modal-scrim");

/* ---------- settings ---------- */

/** Newest settings payload from the host; controls read from here on refill. */
state.settings = null;
state.settingsTab = "general";
state.usageRange = 30;
state.usageSummary = null;
state.mcpServers = [];
state.skills = [];
state.memory = { global: [], project: [] };
state.systemState = null;
state.packState = null;
state.packProgress = null;
/** The pack id whose Remove button is awaiting its second click. */
state.packRemoveArmed = null;
state.settingsQuery = "";

const S = () => settingsStrings[state.locale] ?? settingsStrings.en;

/** Rail glyphs, named from the shared sprite so the rail and the toolbar
 *  speak the same visual language. */
const SETTINGS_ICON_NAMES = {
  general: "user",
  appearance: "palette",
  usage: "chart",
  connection: "plug",
  behavior: "sliders",
  sessions: "layers",
  mcp: "robot",
  skills: "sparkle",
  memory: "book",
  instructions: "file-code",
  tools: "layers",
  system: "monitor",
  about: "info",
};
/**
 * One settings page: a rail entry and a builder. Builders return the pane
 * element and may refresh themselves later (usage, MCP, skills, memory).
 */
function settingsPages() {
  const s = S();
  return [
    { id: "general", group: s.groupSettings, title: s.pageGeneral, build: buildGeneralPage },
    { id: "appearance", group: s.groupSettings, title: s.pageAppearance, build: buildAppearancePage },
    { id: "usage", group: s.groupSettings, title: s.pageUsage, build: buildUsagePage },
    { id: "connection", group: s.groupSettings, title: s.pageConnection, build: buildConnectionPage },
    { id: "behavior", group: s.groupSettings, title: s.pageBehavior, build: buildBehaviorPage },
    { id: "sessions", group: s.groupSettings, title: s.pageSessions, build: buildSessionsPage },
    { id: "mcp", group: s.groupCustomize, title: s.pageMcp, build: buildMcpPage },
    { id: "skills", group: s.groupCustomize, title: s.pageSkills, build: buildSkillsPage },
    { id: "memory", group: s.groupCustomize, title: s.pageMemory, build: buildMemoryPage },
    { id: "instructions", group: s.groupCustomize, title: s.pageInstructions, build: buildInstructionsPage },
    { id: "tools", group: s.groupComputer, title: s.pageTools, build: buildToolsPage },
    { id: "system", group: s.groupComputer, title: s.pageSystem, build: buildSystemPage },
    { id: "about", group: s.groupComputer, title: s.pageAbout, build: buildAboutPage },
  ];
}

/* ---------- small builders ---------- */

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function sRow({ label, desc, control, id, wide = false }) {
  const row = el("div", `setting-row${wide ? " wide" : ""}`);
  row.dataset.search = `${label} ${desc ?? ""}`.toLowerCase();
  const copy = el("div", "setting-copy");
  const labelNode = el("label", "setting-label", label);
  if (id) labelNode.htmlFor = id;
  copy.appendChild(labelNode);
  if (desc) copy.appendChild(el("p", "setting-desc", desc));
  const controlNode = el("div", "setting-control");
  controlNode.appendChild(control);
  row.append(copy, controlNode);
  return row;
}

function sGroup(title, rows) {
  const group = el("section", "setting-group");
  if (title) group.appendChild(el("h3", "setting-group-title", title));
  for (const row of rows) group.appendChild(row);
  return group;
}

function sSelect({ id, value, options, onChange, disabled = false }) {
  const select = document.createElement("select");
  select.className = "setting-select";
  if (id) select.id = id;
  for (const option of options) {
    const node = document.createElement("option");
    node.value = option.value;
    node.textContent = option.label;
    select.appendChild(node);
  }
  select.value = value;
  select.disabled = disabled;
  select.addEventListener("change", () => onChange(select.value));
  return select;
}

function sToggle({ id, checked, onChange, disabled = false }) {
  const button = el("button", `setting-switch${checked ? " on" : ""}`);
  button.type = "button";
  button.setAttribute("role", "switch");
  button.setAttribute("aria-checked", checked ? "true" : "false");
  if (id) button.id = id;
  button.disabled = disabled;
  button.appendChild(el("span", "setting-switch-knob"));
  button.addEventListener("click", () => {
    const next = !button.classList.contains("on");
    button.classList.toggle("on", next);
    button.setAttribute("aria-checked", next ? "true" : "false");
    onChange(next);
  });
  return button;
}

function sText({ id, value, placeholder, type = "text", mono = false, onChange, min, max, step, disabled = false }) {
  const input = document.createElement("input");
  input.className = `setting-input${mono ? " mono" : ""}`;
  input.type = type;
  if (id) input.id = id;
  if (placeholder) input.placeholder = placeholder;
  if (min !== undefined) input.min = String(min);
  if (max !== undefined) input.max = String(max);
  if (step !== undefined) input.step = String(step);
  input.value = value ?? "";
  input.disabled = disabled;
  input.spellcheck = false;
  // Text commits on blur/Enter so a save round-trip does not fight typing.
  input.addEventListener("change", () => onChange(input.value));
  return input;
}

function sTextarea({ id, value, placeholder, rows = 8, onSave, saveLabel }) {
  const wrap = el("div", "setting-textarea-wrap");
  const area = document.createElement("textarea");
  area.className = "setting-textarea";
  if (id) area.id = id;
  if (placeholder) area.placeholder = placeholder;
  area.rows = rows;
  area.spellcheck = false;
  area.value = value ?? "";
  const foot = el("div", "setting-textarea-foot");
  const status = el("span", "setting-inline-status", "");
  const save = el("button", "btn btn-primary small", saveLabel);
  save.type = "button";
  save.addEventListener("click", () => {
    onSave(area.value);
    status.textContent = S().saved;
    setTimeout(() => (status.textContent = ""), 1600);
  });
  foot.append(status, save);
  wrap.append(area, foot);
  return wrap;
}

function sSegmented({ options, value, onChange, previews = false }) {
  const wrap = el("div", `setting-segmented${previews ? " with-previews" : ""}`);
  wrap.setAttribute("role", "radiogroup");
  for (const option of options) {
    const button = el("button", `setting-segment${option.value === value ? " active" : ""}`);
    button.type = "button";
    button.setAttribute("role", "radio");
    button.setAttribute("aria-checked", option.value === value ? "true" : "false");
    if (option.preview) {
      const preview = el("span", `setting-preview setting-preview-${option.preview}`);
      preview.append(el("span", "setting-preview-bar"), el("span", "setting-preview-bar short"));
      button.appendChild(preview);
    }
    button.appendChild(el("span", "setting-segment-label", option.label));
    button.addEventListener("click", () => {
      wrap.querySelectorAll(".setting-segment").forEach((node) => {
        const active = node === button;
        node.classList.toggle("active", active);
        node.setAttribute("aria-checked", active ? "true" : "false");
      });
      onChange(option.value);
    });
    wrap.appendChild(button);
  }
  return wrap;
}

function sPage(title, description) {
  const pane = el("div", "settings-page");
  const head = el("header", "settings-page-head");
  head.appendChild(el("h1", "", title));
  if (description) head.appendChild(el("p", "", description));
  pane.appendChild(head);
  return pane;
}

function sHint(text) {
  return el("p", "setting-note", text);
}

function sButton(label, onClick, { primary = false, quiet = false, danger = false } = {}) {
  const button = el("button", `btn small${primary ? " btn-primary" : ""}${quiet ? " btn-quiet" : ""}${danger ? " danger" : ""}`, label);
  button.type = "button";
  button.addEventListener("click", onClick);
  return button;
}

/* ---------- apply helpers ---------- */

/** Appearance and behaviour toggles: immediate, no save step. */
function applyPref(key, value) {
  api.send({ cmd: "setUiPreference", key, value });
  applyUiPreference(key, value);
}

/** Configuration values: written straight through, without re-fetching models. */
function applyConfig(patch) {
  api.send({ cmd: "saveSettings", settings: patch, skipCatalog: true });
}

function applyUiPreference(key, value) {
  switch (key) {
    case "theme":
      setTheme(value);
      break;
    case "density":
      setDensity(value);
      break;
    case "fontScale":
      state.fontScale = Number(value);
      document.documentElement.style.setProperty("--font-scale", String(value));
      localStorage.setItem("prometheus.fontScale", String(value));
      break;
    case "transcriptWidth":
      document.documentElement.dataset.width = value;
      localStorage.setItem("prometheus.width", value);
      break;
    case "transcriptView":
      state.transcriptView = value;
      document.documentElement.dataset.view = value;
      localStorage.setItem("prometheus.view", value);
      break;
    case "reduceMotion":
      document.documentElement.dataset.motion = value ? "reduced" : "full";
      localStorage.setItem("prometheus.motion", value ? "reduced" : "full");
      break;
    case "codeFont":
      applyCodeFont(value);
      break;
    case "notifications":
      state.notifications = Boolean(value);
      break;
    case "keepAwake":
      state.keepAwake = Boolean(value);
      break;
    case "branchPrefix":
      state.branchPrefix = value;
      break;
    case "outputStyle":
      state.outputStyle = value;
      break;
    case "archiveAfterDays":
      state.archiveAfterDays = Number(value);
      break;
    default:
      break;
  }
}

/* ---------- pages ---------- */

function buildGeneralPage() {
  const s = S();
  const pane = sPage(s.pageGeneral, s.pageGeneralDesc);

  const profile = el("section", "setting-group profile-card");
  const avatar = el("span", "profile-avatar", "P");
  const copy = el("div", "profile-copy");
  copy.appendChild(el("strong", "", state.cwd ? basename(state.cwd) : s.noWorkspace));
  copy.appendChild(el("span", "profile-path", state.cwd || "—"));
  const actions = el("div", "profile-actions");
  actions.appendChild(
    sButton(s.changeFolder, async () => {
      const dir = await api.pickDirectory();
      if (dir) api.send({ cmd: "setCwd", cwd: dir });
    }),
  );
  profile.append(avatar, copy, actions);
  pane.appendChild(profile);

  pane.appendChild(
    sGroup(s.groupLanguage, [
      sRow({
        id: "setting-locale",
        label: s.language,
        desc: s.languageDesc,
        control: sSelect({
          id: "setting-locale",
          value: state.locale,
          options: [
            { value: "en", label: "English" },
            { value: "zh", label: "中文" },
          ],
          onChange: (value) => {
            applyConfig({ locale: value });
            applyLocale(value);
          },
        }),
      }),
    ]),
  );

  pane.appendChild(
    sGroup(s.groupStartup, [
      sRow({
        label: s.outputStyle,
        desc: s.outputStyleDesc,
        control: sSelect({
          value: state.outputStyle ?? "default",
          options: [
            { value: "default", label: s.outputDefault },
            { value: "concise", label: s.outputConcise },
            { value: "explanatory", label: s.outputExplanatory },
          ],
          onChange: (value) => applyPref("outputStyle", value),
        }),
      }),
    ]),
  );
  return pane;
}

function buildAppearancePage() {
  const s = S();
  const pane = sPage(s.pageAppearance, s.pageAppearanceDesc);

  pane.appendChild(
    sGroup(s.groupTheme, [
      sRow({
        id: "setting-theme",
        label: s.theme,
        desc: s.themeDesc,
        control: sSegmented({
          value: state.theme,
          previews: true,
          options: [
            { value: "system", label: s.themeSystem, preview: "system" },
            { value: "light", label: s.themeLight, preview: "light" },
            { value: "dark", label: s.themeDark, preview: "dark" },
          ],
          onChange: (value) => applyPref("theme", value),
        }),
      }),
    ]),
  );

  pane.appendChild(
    sGroup(s.groupText, [
      sRow({
        label: s.fontSize,
        desc: s.fontSizeDesc,
        control: sSegmented({
          value: String(state.fontScale ?? 1),
          options: [
            { value: "0.9", label: s.fontSmall },
            { value: "1", label: s.fontDefault },
            { value: "1.12", label: s.fontLarge },
          ],
          onChange: (value) => applyPref("fontScale", Number(value)),
        }),
      }),
      sRow({
        label: s.width,
        desc: s.widthDesc,
        control: sSegmented({
          value: state.transcriptWidth ?? "standard",
          options: [
            { value: "narrow", label: s.widthNarrow },
            { value: "standard", label: s.widthStandard },
            { value: "wide", label: s.widthWide },
          ],
          onChange: (value) => applyPref("transcriptWidth", value),
        }),
      }),
      sRow({
        label: s.codeFont,
        desc: s.codeFontDesc,
        control: sText({
          value: state.codeFont ?? "",
          placeholder: "SF Mono, Cascadia Code",
          onChange: (value) => applyPref("codeFont", value),
        }),
      }),
    ]),
  );

  pane.appendChild(
    sGroup(s.groupTranscript, [
      sRow({
        label: s.view,
        desc: s.viewDesc,
        control: sSelect({
          value: state.transcriptView ?? "normal",
          options: [
            { value: "normal", label: s.viewNormal },
            { value: "thinking", label: s.viewThinking },
            { value: "verbose", label: s.viewVerbose },
          ],
          onChange: (value) => applyPref("transcriptView", value),
        }),
      }),
      sRow({
        id: "setting-density",
        label: s.density,
        desc: s.densityDesc,
        control: sSegmented({
          value: state.density,
          options: [
            { value: "compact", label: s.densityCompact },
            { value: "balanced", label: s.densityBalanced },
            { value: "detailed", label: s.densityDetailed },
          ],
          onChange: (value) => applyPref("density", value),
        }),
      }),
      sRow({
        label: s.reduceMotion,
        desc: s.reduceMotionDesc,
        control: sToggle({
          checked: Boolean(state.reduceMotion),
          onChange: (value) => applyPref("reduceMotion", value),
        }),
      }),
    ]),
  );
  return pane;
}

function buildUsagePage() {
  const s = S();
  const pane = sPage(s.pageUsage, s.pageUsageDesc);
  const body = el("div", "usage-page-body");
  pane.appendChild(body);

  const render = () => {
    body.innerHTML = "";
    const summary = state.usageSummary;
    const range = el("div", "setting-segmented usage-range");
    for (const days of [7, 30, 90]) {
      const button = el("button", `setting-segment${state.usageRange === days ? " active" : ""}`, s.rangeDays(days));
      button.type = "button";
      button.addEventListener("click", () => {
        state.usageRange = days;
        api.send({ cmd: "getUsage", days });
        render();
      });
      range.appendChild(button);
    }
    body.appendChild(range);

    if (!summary) {
      body.appendChild(el("p", "setting-note", s.loading));
      return;
    }

    const tiles = el("div", "usage-tiles");
    const total = summary.totals.inputTokens + summary.totals.outputTokens;
    const tile = (label, value, sub) => {
      const node = el("div", "usage-tile");
      node.appendChild(el("span", "usage-tile-label", label));
      node.appendChild(el("strong", "usage-tile-value", value));
      if (sub) node.appendChild(el("span", "usage-tile-sub", sub));
      return node;
    };
    tiles.append(
      tile(s.usageTotal, formatTokens(total), s.rangeDays(state.usageRange)),
      tile(s.usageInput, formatTokens(summary.totals.inputTokens)),
      tile(s.usageOutput, formatTokens(summary.totals.outputTokens)),
      tile(s.usageCached, formatTokens(summary.totals.cachedTokens)),
      tile(s.usageTurns, String(summary.totals.turns)),
    );
    // Money is the number people actually act on; token counts only explain it.
    if (summary.totals.cost > 0) {
      tiles.append(tile(s.usageCost, formatMoney(summary.totals.cost), s.usageEstimate));
    }
    body.appendChild(tiles);

    const chart = el("div", "usage-chart");
    const max = Math.max(1, ...summary.days.map((day) => day.inputTokens + day.outputTokens));
    for (const day of summary.days) {
      const column = el("div", "usage-day");
      const value = day.inputTokens + day.outputTokens;
      const bar = el("div", "usage-bar");
      bar.style.height = `${Math.max(value > 0 ? 3 : 0, Math.round((value / max) * 100))}%`;
      bar.title = `${day.date} · ${formatTokens(value)} ${t.tokens}`;
      if (value === 0) bar.classList.add("empty");
      column.appendChild(bar);
      const [year, month, date] = day.date.split("-");
      if (summary.days.length <= 14 || Number(date) % 7 === 1) {
        column.appendChild(el("span", "usage-day-label", `${month}/${date}`));
      }
      column.title = `${day.date} · ${formatTokens(value)} ${t.tokens}`;
      chart.appendChild(column);
    }
    body.appendChild(chart);

    if (summary.models.length > 0) {
      const models = el("div", "usage-models");
      models.appendChild(el("h3", "setting-group-title", s.usageByModel));
      for (const model of summary.models) {
        const row = el("div", "usage-model-row");
        row.appendChild(el("span", "usage-model-name", model.model));
        const value = el("span", "usage-model-value", formatTokens(model.inputTokens + model.outputTokens));
        if (model.cost > 0) value.textContent += ` · ${formatMoney(model.cost)}`;
        row.appendChild(value);
        models.appendChild(row);
      }
      body.appendChild(models);
    } else {
      body.appendChild(el("p", "setting-note", s.usageEmpty));
    }
    body.appendChild(el("p", "setting-note", s.usageNote));
  };

  state.renderUsagePage = render;
  render();
  return pane;
}

/** Prices are an estimate from a local table, so the label says so. */
function formatMoney(dollars) {
  if (!dollars) return "$0";
  if (dollars < 0.01) return `$${dollars.toFixed(4)}`;
  if (dollars < 1) return `$${dollars.toFixed(3)}`;
  return `$${dollars.toFixed(2)}`;
}

function buildConnectionPage() {
  const s = S();
  const pane = sPage(s.pageConnection, s.pageConnectionDesc);
  pane.classList.add("page-wide");
  const settings = state.settings ?? {};

  const providerSelect = sSelect({
    id: "setting-provider",
    value: settings.provider ?? "custom",
    options: [],
    onChange: (value) => {
      const provider = (settings.providers ?? []).find((entry) => entry.id === value);
      if (provider) $("setting-base-url").value = provider.baseUrl;
      applyConfig({ provider: value, baseUrl: provider?.baseUrl ?? "" });
    },
  });
  for (const provider of settings.providers ?? []) {
    const option = document.createElement("option");
    option.value = provider.id;
    option.textContent = provider.configured ? provider.label : `${provider.label} · ${t.providerNoKey}`;
    providerSelect.appendChild(option);
  }
  if (![...providerSelect.options].some((option) => option.value === settings.provider)) {
    const option = document.createElement("option");
    option.value = settings.provider ?? "custom";
    option.textContent = t.providerCustom;
    providerSelect.appendChild(option);
  }
  providerSelect.value = settings.provider ?? "custom";

  const modelSelect = sSelect({
    id: "setting-model",
    value: settings.model ?? "",
    options: [],
    onChange: (value) => applyConfig({ model: value }),
  });
  for (const model of settings.models ?? []) {
    const option = document.createElement("option");
    option.value = model.id;
    option.textContent = model.id;
    modelSelect.appendChild(option);
  }
  if (settings.model && ![...modelSelect.options].some((option) => option.value === settings.model)) {
    const option = document.createElement("option");
    option.value = settings.model;
    option.textContent = settings.model;
    modelSelect.appendChild(option);
  }
  modelSelect.value = settings.model ?? "";

  const keyInput = sText({
    id: "setting-api-key",
    type: "password",
    value: settings.apiKeyMasked ?? "",
    onChange: (value) => {
      if (!value.includes("•")) applyConfig({ apiKey: value });
    },
  });
  keyInput.dataset.masked = "1";
  keyInput.addEventListener("focus", () => {
    if (keyInput.dataset.masked === "1") {
      keyInput.value = "";
      keyInput.dataset.masked = "";
    }
  });

  pane.appendChild(
    sGroup(s.groupProvider, [
      sRow({ id: "setting-provider", label: s.provider, desc: s.providerDesc, control: providerSelect }),
      sRow({
        id: "setting-base-url",
        label: s.baseUrl,
        desc: s.baseUrlDesc,
        control: sText({
          id: "setting-base-url",
          value: settings.baseUrl ?? "",
          mono: true,
          placeholder: "https://api.example.com/v1",
          onChange: (value) => applyConfig({ baseUrl: value }),
        }),
      }),
      sRow({ id: "setting-api-key", label: s.apiKey, desc: s.apiKeyDesc, control: keyInput }),
      sRow({ id: "setting-model", label: s.defaultModel, desc: s.defaultModelDesc, control: modelSelect }),
    ]),
  );

  const hint = el("div", "setting-note", "");
  hint.id = "models-hint";
  pane.appendChild(hint);

  pane.appendChild(
    sGroup(s.groupModels, [
      sRow({
        id: "setting-fallback",
        label: s.fallback,
        desc: s.fallbackDesc,
        control: sText({
          id: "setting-fallback",
          value: (settings.fallbackModels ?? []).join(", "),
          mono: true,
          placeholder: "deepseek-v4.1-flash",
          onChange: (value) => applyConfig({ fallbackModels: value }),
        }),
      }),
      sRow({
        label: s.refreshModels,
        desc: s.refreshModelsDesc,
        control: sButton(s.refreshNow, () => {
          api.send({ cmd: "refreshModels" });
        }),
      }),
    ]),
  );
  return pane;
}

function buildBehaviorPage() {
  const s = S();
  const pane = sPage(s.pageBehavior, s.pageBehaviorDesc);
  const settings = state.settings ?? {};

  pane.appendChild(
    sGroup(s.groupModel, [
      sRow({
        id: "setting-mode",
        label: s.mode,
        desc: s.modeDesc,
        control: sSelect({
          id: "setting-mode",
          value: settings.mode ?? "ask",
          options: [
            { value: "ask", label: t.modeAsk },
            { value: "auto", label: t.modeAuto },
            { value: "plan", label: t.modePlan },
          ],
          onChange: (value) => applyConfig({ mode: value }),
        }),
      }),
      sRow({
        id: "setting-effort",
        label: s.effort,
        desc: s.effortDesc,
        control: sSelect({
          id: "setting-effort",
          value: settings.effort ?? "auto",
          options: [
            { value: "auto", label: t.effortAuto },
            { value: "low", label: t.effortLow },
            { value: "medium", label: t.effortMedium },
            { value: "high", label: t.effortHigh },
          ],
          onChange: (value) => applyConfig({ effort: value }),
        }),
      }),
      sRow({
        id: "setting-max-tokens",
        label: s.maxTokens,
        desc: s.maxTokensDesc,
        control: sText({
          id: "setting-max-tokens",
          type: "number",
          min: 256,
          max: 128000,
          step: 256,
          value: settings.maxTokens ?? 16000,
          onChange: (value) => applyConfig({ maxTokens: Number(value) }),
        }),
      }),
      sRow({
        id: "setting-context",
        label: s.context,
        desc: s.contextDesc,
        control: sText({
          id: "setting-context",
          type: "number",
          min: 8000,
          max: 4000000,
          step: 1000,
          value: settings.contextWindow ?? 1000000,
          onChange: (value) => applyConfig({ contextWindow: Number(value) }),
        }),
      }),
    ]),
  );

  pane.appendChild(
    sGroup(s.groupSafety, [
      sRow({
        id: "setting-sandbox",
        label: s.sandbox,
        desc: s.sandboxDesc,
        control: sSelect({
          id: "setting-sandbox",
          value: settings.sandbox === "off" ? "off" : "enforce",
          options: [
            { value: "enforce", label: s.on },
            { value: "off", label: s.off },
          ],
          onChange: (value) => applyConfig({ sandbox: value }),
        }),
      }),
      sRow({
        id: "setting-network",
        label: s.network,
        desc: s.networkDesc,
        control: sSelect({
          id: "setting-network",
          value: ["off", "proxy", "open"].includes(settings.networkPolicy) ? settings.networkPolicy : "off",
          options: [
            { value: "off", label: s.networkOff },
            { value: "proxy", label: s.networkProxy },
            { value: "open", label: s.networkOpen },
          ],
          onChange: (value) => applyConfig({ networkPolicy: value }),
        }),
      }),
      sRow({
        id: "setting-auto-approve",
        label: s.autoApprove,
        desc: s.autoApproveDesc,
        control: sText({
          id: "setting-auto-approve",
          value: (settings.autoApprove ?? []).join(", "),
          mono: true,
          placeholder: "read_file, glob, grep",
          onChange: (value) => applyConfig({ autoApprove: value }),
        }),
      }),
      sHint(s.sandboxHint),
    ]),
  );

  const rules = el("div", "rules-list");
  rules.id = "setting-rules";
  renderRules(settings.rules ?? []);
  const rulesGroup = el("section", "setting-group");
  rulesGroup.appendChild(el("h3", "setting-group-title", s.groupRules));
  rulesGroup.appendChild(el("p", "setting-note", s.rulesDesc));
  rulesGroup.appendChild(rules);
  pane.appendChild(rulesGroup);
  return pane;
}

function buildSessionsPage() {
  const s = S();
  const pane = sPage(s.pageSessions, s.pageSessionsDesc);
  pane.appendChild(
    sGroup(s.groupNotifications, [
      sRow({
        label: s.notifications,
        desc: s.notificationsDesc,
        control: sToggle({ checked: state.notifications !== false, onChange: (value) => applyPref("notifications", value) }),
      }),
    ]),
  );
  pane.appendChild(
    sGroup(s.groupSessions, [
      sRow({
        label: s.archiveInactive,
        desc: s.archiveInactiveDesc,
        control: sSelect({
          value: String(state.archiveAfterDays ?? 0),
          options: [
            { value: "0", label: s.never },
            { value: "7", label: s.days(7) },
            { value: "30", label: s.days(30) },
            { value: "90", label: s.days(90) },
          ],
          onChange: (value) => applyPref("archiveAfterDays", Number(value)),
        }),
      }),
      sRow({
        label: s.branchPrefix,
        desc: s.branchPrefixDesc,
        control: sText({
          value: state.branchPrefix ?? "prometheus/",
          mono: true,
          placeholder: "prometheus/",
          onChange: (value) => applyPref("branchPrefix", value),
        }),
      }),
      sRow({
        label: s.worktreeLocation,
        desc: s.worktreeLocationDesc,
        control: el("code", "setting-code", "<repo>/.prometheus/worktrees"),
      }),
    ]),
  );
  return pane;
}

function buildMcpPage() {
  const s = S();
  const pane = sPage(s.pageMcp, s.pageMcpDesc);
  const list = el("div", "mcp-list");
  pane.appendChild(list);

  const render = () => {
    list.innerHTML = "";
    if (state.mcpServers.length === 0) {
      const empty = el("div", "settings-empty-card");
      empty.appendChild(el("h3", "", s.mcpEmptyTitle));
      empty.appendChild(el("p", "", s.mcpEmptyBody));
      const actions = el("div", "settings-empty-actions");
      actions.append(
        sButton(s.mcpAdd, () => openMcpForm(null), { primary: true }),
        sButton(s.mcpEditConfig, () => revealMcpConfig(), { quiet: true }),
      );
      empty.appendChild(actions);
      list.appendChild(empty);
      return;
    }
    for (const server of state.mcpServers) {
      const row = el("div", "mcp-row");
      const main = el("div", "mcp-main");
      const title = el("div", "mcp-title");
      title.appendChild(el("strong", "", server.name));
      title.appendChild(el("span", `mcp-scope scope-${server.scope}`, server.scope === "project" ? s.scopeProject : s.scopeUser));
      if (server.disabled) title.appendChild(el("span", "mcp-scope disabled", s.disabled));
      main.appendChild(title);
      main.appendChild(el("code", "mcp-command", server.url || [server.command, ...(server.args ?? [])].filter(Boolean).join(" ")));
      const actions = el("div", "mcp-actions");
      actions.appendChild(
        sToggle({
          checked: !server.disabled,
          onChange: (value) => {
            api.send({ cmd: "saveMcpServer", server: { ...server, disabled: !value } });
          },
        }),
      );
      actions.appendChild(sButton(s.edit, () => openMcpForm(server), { quiet: true }));
      actions.appendChild(
        sButton(s.remove, () => api.send({ cmd: "removeMcpServer", scope: server.scope, name: server.name }), {
          quiet: true,
          danger: true,
        }),
      );
      row.append(main, actions);
      list.appendChild(row);
    }
    const foot = el("div", "settings-list-foot");
    foot.appendChild(sButton(s.mcpAdd, () => openMcpForm(null), { primary: true }));
    list.appendChild(foot);
  };

  const openMcpForm = (server) => {
    const form = el("form", "settings-form-card");
    const title = el("h3", "", server ? s.mcpEditTitle(server.name) : s.mcpAddTitle);
    form.appendChild(title);

    const name = sText({ value: server?.name ?? "", placeholder: "filesystem", mono: true });
    const scope = sSelect({
      value: server?.scope ?? "user",
      options: [
        { value: "user", label: s.scopeUser },
        { value: "project", label: s.scopeProject },
      ],
      onChange: () => {},
    });
    const command = sText({ value: server?.command ?? "", placeholder: "npx", mono: true });
    const args = sText({ value: (server?.args ?? []).join(" "), placeholder: "-y @modelcontextprotocol/server-filesystem .", mono: true });
    const url = sText({ value: server?.url ?? "", placeholder: "https://mcp.example.com/mcp", mono: true });

    form.append(
      sRow({ label: s.name, control: name }),
      sRow({ label: s.scope, control: scope }),
      sRow({ label: s.command, desc: s.commandDesc, control: command }),
      sRow({ label: s.arguments, desc: s.argumentsDesc, control: args }),
      sRow({ label: s.url, desc: s.urlDesc, control: url }),
    );
    const actions = el("div", "settings-form-actions");
    actions.append(
      sButton(s.cancel, () => form.remove(), { quiet: true }),
      sButton(s.save, () => {
        if (!name.value.trim()) {
          name.focus();
          return;
        }
        api.send({
          cmd: "saveMcpServer",
          server: {
            name: name.value.trim(),
            scope: scope.value,
            command: command.value.trim(),
            args: args.value.trim(),
            url: url.value.trim(),
            disabled: Boolean(server?.disabled),
          },
        });
        dismiss();
      }, { primary: true }),
    );
    form.appendChild(actions);
    // One thing to act on at a time: the empty state and the add button step
    // aside while the form is open, and come back when it is dismissed.
    const empty = list.querySelector(".settings-empty-card");
    const foot = list.querySelector(".settings-list-foot");
    const dismiss = () => {
      form.remove();
      if (empty) empty.hidden = false;
      if (foot) foot.hidden = false;
    };
    if (empty) empty.hidden = true;
    if (foot) foot.hidden = true;
    list.prepend(form);
    name.focus();
    form.querySelectorAll(".settings-form-actions .btn").forEach((button, index, all) => {
      if (index === all.length - 1) return;
      button.addEventListener("click", dismiss);
    });
  };

  state.renderMcpPage = render;
  render();
  return pane;
}

function revealMcpConfig() {
  // The config files live under ~/.prometheus; the Settings page can only
  // open a folder the shell knows, so point the user at the path instead.
  const list = document.querySelector(".mcp-list");
  if (!list || list.querySelector(".config-path-note")) return;
  const note = el("p", "setting-note config-path-note", S().mcpConfigPath);
  list.appendChild(note);
}

function buildSkillsPage() {
  const s = S();
  const pane = sPage(s.pageSkills, s.pageSkillsDesc);
  const body = el("div", "skills-body");
  pane.appendChild(body);

  const render = () => {
    body.innerHTML = "";
    const search = el("input", "setting-input skill-search");
    search.type = "search";
    search.placeholder = s.searchSkills;
    const list = el("div", "skills-list");
    const draw = () => {
      const query = search.value.trim().toLowerCase();
      list.innerHTML = "";
      const matches = state.skills.filter(
        (skill) => !query || `${skill.name} ${skill.description}`.toLowerCase().includes(query),
      );
      if (matches.length === 0) {
        const empty = el("div", "settings-empty-card");
        empty.appendChild(el("h3", "", query ? s.skillsNoMatch : s.skillsEmptyTitle));
        if (!query) {
          empty.appendChild(el("p", "", s.skillsEmptyBody));
          empty.appendChild(sButton(s.skillNew, () => openForm(null), { primary: true }));
        }
        list.appendChild(empty);
        return;
      }
      for (const skill of matches) {
        const row = el("div", "skill-row");
        const main = el("div", "skill-main");
        const title = el("div", "skill-title");
        title.appendChild(el("code", "skill-name", `/${skill.name}`));
        title.appendChild(el("span", `mcp-scope scope-${skill.scope}`, skill.scope === "project" ? s.scopeProject : s.scopeUser));
        main.appendChild(title);
        main.appendChild(el("p", "skill-desc", skill.description || s.skillNoDescription));
        const actions = el("div", "mcp-actions");
        actions.appendChild(sButton(s.edit, () => openForm(skill), { quiet: true }));
        actions.appendChild(
          sButton(s.remove, () => api.send({ cmd: "removeSkill", scope: skill.scope, name: skill.name }), {
            quiet: true,
            danger: true,
          }),
        );
        row.append(main, actions);
        list.appendChild(row);
      }
      const foot = el("div", "settings-list-foot");
      foot.appendChild(sButton(s.skillNew, () => openForm(null), { primary: true }));
      list.appendChild(foot);
    };
    search.addEventListener("input", draw);
    body.append(search, list);
    draw();
  };

  const openForm = (skill) => {
    const form = el("form", "settings-form-card");
    form.appendChild(el("h3", "", skill ? s.skillEditTitle(skill.name) : s.skillNewTitle));
    const name = sText({ value: skill?.name ?? "", placeholder: "review", mono: true });
    const description = sText({ value: skill?.description ?? "", placeholder: s.skillDescriptionPlaceholder });
    const hint = sText({ value: skill?.argumentHint ?? "", placeholder: "[path]" });
    const scope = sSelect({
      value: skill?.scope ?? "user",
      options: [
        { value: "user", label: s.scopeUser },
        { value: "project", label: s.scopeProject },
      ],
      onChange: () => {},
    });
    const bodyArea = document.createElement("textarea");
    bodyArea.className = "setting-textarea";
    bodyArea.rows = 7;
    bodyArea.spellcheck = false;
    bodyArea.placeholder = s.skillBodyPlaceholder;
    bodyArea.value = skill?.body ?? "";
    form.append(
      sRow({ label: s.name, desc: s.skillNameDesc, control: name }),
      sRow({ label: s.description, control: description }),
      sRow({ label: s.argumentHint, desc: s.argumentHintDesc, control: hint }),
      sRow({ label: s.scope, control: scope }),
      sRow({ label: s.prompt, desc: s.skillPromptDesc, control: bodyArea, wide: true }),
    );
    const actions = el("div", "settings-form-actions");
    actions.append(
      sButton(s.cancel, () => form.remove(), { quiet: true }),
      sButton(s.save, () => {
        api.send({
          cmd: "saveSkill",
          skill: {
            name: name.value.trim(),
            description: description.value.trim(),
            argumentHint: hint.value.trim(),
            scope: scope.value,
            body: bodyArea.value,
          },
        });
        form.remove();
      }, { primary: true }),
    );
    form.appendChild(actions);
    body.prepend(form);
    name.focus();
  };

  state.renderSkillsPage = render;
  render();
  return pane;
}

function buildMemoryPage() {
  const s = S();
  const pane = sPage(s.pageMemory, s.pageMemoryDesc);
  const body = el("div", "memory-body");
  pane.appendChild(body);

  const render = () => {
    body.innerHTML = "";
    const sections = [
      { key: "global", title: s.memoryGlobal, items: state.memory.global ?? [] },
      { key: "project", title: s.memoryProject, items: state.memory.project ?? [] },
    ];
    for (const section of sections) {
      const group = el("section", "setting-group");
      group.appendChild(el("h3", "setting-group-title", section.title));
      if (section.items.length === 0) {
        group.appendChild(el("p", "setting-note", s.memoryEmpty));
      }
      for (const entry of section.items) {
        const card = el("div", "memory-card");
        const head = el("div", "memory-head");
        head.appendChild(el("strong", "", entry.name));
        if (entry.description) head.appendChild(el("span", "memory-desc", entry.description));
        card.appendChild(head);
        card.appendChild(el("p", "memory-body-text", entry.body));
        const actions = el("div", "memory-actions");
        actions.appendChild(
          sButton(s.remove, () => api.send({ cmd: "deleteMemory", scope: section.key, name: entry.name }), {
            quiet: true,
            danger: true,
          }),
        );
        card.appendChild(actions);
        group.appendChild(card);
      }
      body.appendChild(group);
    }
    body.appendChild(el("p", "setting-note", s.memoryHowTo));
  };

  state.renderMemoryPage = render;
  render();
  return pane;
}

function buildInstructionsPage() {
  const s = S();
  const pane = sPage(s.pageInstructions, s.pageInstructionsDesc);
  const wrap = sTextarea({
    id: "setting-instructions",
    value: state.instructionsText ?? "",
    placeholder: s.instructionsPlaceholder,
    rows: 14,
    saveLabel: s.save,
    onSave: (value) => api.send({ cmd: "saveInstructions", text: value }),
  });
  pane.appendChild(wrap);
  pane.appendChild(el("p", "setting-note", s.instructionsNote));
  pane.appendChild(el("p", "setting-note", s.instructionsProject));
  return pane;
}

/**
 * 工具链包。
 *
 * 这一页要回答的第一个问题不是"装了什么"，而是"磁盘被谁占了、能不能删"。
 * 所以最上面一行永远是根目录、已用、剩余 —— 用户装了几个 GB 的编译器之后
 * 第一件想确认的事就是这个。
 *
 * 进度是确定的（显示百分比和阶段），因为下载 289 MB 时一个转圈什么都说明
 * 不了；到底是在下载、校验、解压还是验证，决定了用户要不要等。
 */
function buildToolsPage() {
  const s = S();
  const pane = sPage(s.pageTools, s.pageToolsDesc);
  // 顺序即优先级：根目录与占用在第一行，进度条其次，包列表最后。
  const summary = el("div", "pack-summary");
  pane.appendChild(summary);

  const list = el("div", "pack-list");
  pane.appendChild(list);

  const formatBytes = (bytes) => {
    if (!bytes) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB"];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024;
      unit++;
    }
    return `${value.toFixed(unit >= 3 ? 2 : 1)} ${units[unit]}`;
  };

  const render = () => {
    const packs = state.packState;
    list.innerHTML = "";

    if (!packs) {
      list.appendChild(el("p", "setting-note", s.packLoading));
      return;
    }

    // 错误要留在页面上，而不是变成一个一闪而过的提示：安装失败的原因
    // （磁盘不够、哈希不对、包已损坏）恰恰是用户需要读的东西。
    if (state.packError) {
      const box = el("div", "pack-error");
      box.textContent = state.packError;
      list.appendChild(box);
    }

    // 根目录与占用：这是"别把文件系统搞乱"这个问题最直接的回答。
    summary.innerHTML = "";
    summary.appendChild(el("code", "pack-root", packs.root));
    summary.appendChild(
      el(
        "span",
        "pack-usage",
        `${s.packUsed} ${formatBytes(packs.totalBytes)}${packs.freeBytes ? ` · ${s.packFree} ${formatBytes(packs.freeBytes)}` : ""}`,
      ),
    );

    if (packs.packs.length === 0) {
      const empty = el("div", "settings-empty-card");
      empty.appendChild(el("h3", "", s.packEmptyTitle));
      empty.appendChild(el("p", "", s.packEmptyBody));
      list.appendChild(empty);
    }

    for (const pack of packs.packs) {
      const row = el("div", "pack-row");

      const main = el("div", "pack-main");
      const title = el("div", "pack-title");
      title.appendChild(el("strong", "", pack.manifest.name));
      title.appendChild(el("span", "pack-version", pack.manifest.version));
      if (pack.status === "broken") title.appendChild(el("span", "mcp-scope disabled", s.packBroken));
      main.appendChild(title);

      const meta = el("div", "pack-meta");
      meta.appendChild(el("span", "pack-size", formatBytes(pack.bytes)));
      if (pack.manifest.provides.length) meta.appendChild(el("span", "pack-provides", pack.manifest.provides.join(", ")));
      if (pack.manifest.license?.url) {
        const link = el("button", "link-button", s.packLicence);
        link.type = "button";
        link.addEventListener("click", () => api.openExternal?.(pack.manifest.license.url));
        meta.appendChild(link);
      }
      main.appendChild(meta);

      if (pack.problem) main.appendChild(el("p", "setting-note pack-problem", pack.problem));

      const actions = el("div", "pack-actions");
      actions.appendChild(sButton(s.packVerify, () => api.send({ cmd: "verifyPack", id: pack.manifest.id }), { quiet: true }));

      // 删除要两次点击：一个 pack 是一 GB，误删的代价是重新下载十分钟。
      // 确认状态放在 `state` 上而不是闭包里 —— `render()` 会重建整个列表，
      // 闭包里的 armed 会跟着旧按钮一起消失，用户第二次点的是新按钮，
      // 于是永远要求"再点一次"。
      const remove = sButton(s.packRemove, () => {
        if (state.packRemoveArmed !== pack.manifest.id) {
          state.packRemoveArmed = pack.manifest.id;
          render();
          setTimeout(() => {
            if (state.packRemoveArmed === pack.manifest.id) {
              state.packRemoveArmed = null;
              render();
            }
          }, 4000);
          return;
        }
        state.packRemoveArmed = null;
        api.send({ cmd: "removePack", id: pack.manifest.id });
      }, { quiet: true, danger: true });
      if (state.packRemoveArmed === pack.manifest.id) {
        remove.textContent = s.packRemoveConfirm;
        remove.classList.add("danger");
      }
      actions.appendChild(remove);

      row.append(main, actions);
      list.appendChild(row);
    }

    // 可安装的条目。已经装过的那个不再列出来 —— 同一份东西出现在
    // "已安装"和"可安装"两处，用户只会读成"还能再装一次"。
    const installedIds = new Set((packs.packs ?? []).map((pack) => pack.manifest.id));
    const available = (state.packCatalog ?? []).filter((entry) => !installedIds.has(entry.id));
    if (available.length) {
      const group = el("section", "setting-group");
      group.appendChild(el("h3", "setting-group-title", s.packAvailable));
      for (const entry of available) {
        const row = el("div", "pack-row pack-available");
        const main = el("div", "pack-main");
        const title = el("div", "pack-title");
        title.appendChild(el("strong", "", entry.name));
        title.appendChild(el("span", "pack-version", entry.version));
        main.appendChild(title);
        main.appendChild(el("div", "pack-meta", `${formatBytes(entry.downloadBytes)} · ${entry.provides.join(", ")}`));

        const actions = el("div", "pack-actions");
        actions.appendChild(sButton(s.packInstall, () => api.send({ cmd: "installPack", id: entry.id }), { primary: true }));
        row.append(main, actions);
        group.appendChild(row);
      }
      list.appendChild(group);
    }

    // 离线安装：内网机器连不上下载站时，用户手上只有别人拷过来的
    // pack.json 和压缩包。它和在线安装走同一个事务，只是字节来源不同。
    const offline = el("div", "pack-offline");
    offline.appendChild(el("p", "setting-note", s.packOfflineHint));
    offline.appendChild(
      sButton(s.packOffline, async () => {
        const manifestPath = await api.pickFile?.({ filters: [{ name: "pack.json", extensions: ["json"] }] });
        if (!manifestPath) return;
        // 同一个目录里的 .zip / .tar.xz 就是它的归档；找不到就让安装器
        // 自己按 manifest 里的 URL 去取。
        const dir = manifestPath.replace(/[\\/][^\\/]+$/, "");
        const archive = await api.pickFile?.({
          defaultPath: dir,
          filters: [{ name: "Archive", extensions: ["zip", "xz", "gz"] }],
        });
        api.send({ cmd: "installFromManifest", path: manifestPath, files: archive ? [archive] : [] });
      }),
    );
    list.appendChild(offline);
  };

  // 进度条独立于列表，安装时它出现在最上面。
  const progressBar = el("div", "pack-progress");
  progressBar.hidden = true;
  progressBar.appendChild(el("div", "pack-progress-label"));
  const bar = el("div", "pack-progress-track");
  const fill = el("div", "pack-progress-fill");
  bar.appendChild(fill);
  progressBar.appendChild(bar);
  pane.insertBefore(progressBar, list);

  state.renderPackPage = render;
  state.renderPackProgress = (progress) => {
    if (!progress) {
      progressBar.hidden = true;
      return;
    }
    progressBar.hidden = false;
    const label = progressBar.querySelector(".pack-progress-label");
    const phaseText = {
      preflight: s.packPhasePreflight,
      download: s.packPhaseDownload,
      verify: s.packPhaseVerify,
      extract: s.packPhaseExtract,
      inspect: s.packPhaseInspect,
      validate: s.packPhaseValidate,
      commit: s.packPhaseCommit,
    }[progress.phase] ?? progress.phase;

    if (progress.phase === "download" && progress.total) {
      const pct = Math.min(100, Math.round(((progress.received ?? 0) / progress.total) * 100));
      label.textContent = `${phaseText} ${pct}% · ${formatBytes(progress.received ?? 0)} / ${formatBytes(progress.total)}`;
      fill.style.width = `${pct}%`;
    } else {
      label.textContent = phaseText;
      // 非下载阶段没有可比的量，用一个不确定宽度表示"在动"而不是假装有进度。
      fill.style.width = progress.phase === "commit" ? "100%" : "60%";
    }
  };

  api.send({ cmd: "getPacks" });
  api.send({ cmd: "getPackCatalog" });
  render();
  return pane;
}

function buildSystemPage() {
  const s = S();
  const pane = sPage(s.pageSystem, s.pageSystemDesc);
  const sys = state.systemState ?? {};

  pane.appendChild(
    sGroup(s.groupComputer, [
      sRow({
        label: s.launchAtLogin,
        desc: s.launchAtLoginDesc,
        control: sToggle({
          checked: Boolean(sys.launchAtLogin),
          onChange: (value) => setSystem("launchAtLogin", value),
        }),
      }),
      sRow({
        label: s.tray,
        desc: s.trayDesc,
        control: sToggle({ checked: Boolean(sys.tray), onChange: (value) => setSystem("tray", value) }),
      }),
      sRow({
        label: s.keepAwake,
        desc: s.keepAwakeDesc,
        control: sToggle({ checked: Boolean(sys.keepAwake), onChange: (value) => setSystem("keepAwake", value) }),
      }),
      sRow({
        label: s.quickEntry,
        desc: s.quickEntryDesc,
        control: sText({
          value: sys.quickEntry ?? "",
          placeholder: api.platform === "darwin" ? "Cmd+Shift+Space" : "Ctrl+Alt+Space",
          mono: true,
          onChange: (value) => setSystem("quickEntry", value),
        }),
      }),
    ]),
  );
  pane.appendChild(el("p", "setting-note", s.systemNote));
  return pane;
}

function setSystem(key, value) {
  if (!api.systemSet) return;
  void api.systemSet(key, value).then((next) => {
    state.systemState = next;
    rerenderSettingsPage("system");
  });
}

function buildAboutPage() {
  const s = S();
  const pane = sPage(s.pageAbout, s.pageAboutDesc);
  const row = el("section", "about-row");
  row.appendChild(el("span", "about-version", `Prometheus ${state.appVersion ?? ""}`));
  const check = sButton(t.checkUpdate, async () => {
    const note = $("update-note");
    note.textContent = t.updateChecking;
    const result = await api.checkUpdate();
    if (!result || result.status === "unconfigured") note.textContent = t.updateUnconfigured;
    else if (result.status === "error") note.textContent = `${t.updateError} ${result.message ?? ""}`;
    else if (result.status === "available") {
      note.textContent = `${t.updateAvailable} ${result.latest}`;
      if (result.url) note.appendChild(sButton(t.updateOpen, () => api.openExternal(result.url), { quiet: true }));
    } else note.textContent = t.updateCurrent;
  });
  row.appendChild(check);
  pane.appendChild(row);
  const note = el("div", "settings-hint", "");
  note.id = "update-note";
  pane.appendChild(note);
  pane.appendChild(
    sGroup(s.groupData, [
      sRow({
        label: s.dataFolder,
        desc: s.dataFolderDesc,
        control: el("code", "setting-code", "~/.prometheus"),
      }),
      sRow({
        label: s.localOnly,
        desc: s.localOnlyDesc,
        control: el("span", "setting-badge", s.localBadge),
      }),
    ]),
  );
  return pane;
}

/* ---------- rail, search, and lifecycle ---------- */

function settingsRail() {
  const nav = $("settings-nav");
  nav.innerHTML = "";
  const pages = settingsPages();
  let lastGroup = "";
  for (const page of pages) {
    if (page.group !== lastGroup) {
      lastGroup = page.group;
      nav.appendChild(el("div", "settings-nav-group", page.group));
    }
    const button = el("button", "settings-nav-item");
    button.type = "button";
    button.dataset.settingsTab = page.id;
    button.setAttribute("role", "tab");
    button.append(iconEl(SETTINGS_ICON_NAMES[page.id] ?? "user"), el("span", "", page.title));
    button.addEventListener("click", () => selectSettingsTab(page.id));
    nav.appendChild(button);
  }
}

function openSettings(tab = "general") {
  settingsRail();
  $("settings-search").placeholder = S().searchSettings;
  $("settings-profile-name").textContent = state.cwd ? basename(state.cwd) : S().noWorkspace;
  $("settings-profile-sub").textContent = S().railProfileSub;
  selectSettingsTab(tab);
  openModal(settingsDialog);
  api.send({ cmd: "getSettings" });
  api.send({ cmd: "getUsage", days: state.usageRange });
  api.send({ cmd: "getMcp" });
  api.send({ cmd: "getSkills" });
  api.send({ cmd: "getMemory" });
  api.send({ cmd: "getInstructions" });
  void api.systemState?.().then((next) => {
    state.systemState = next;
  });
  // Focus the page container, not a rail button: a programmatic focus on a
  // button paints the keyboard ring and makes the page look selected-by-error.
  settingsDialog.focus?.();
  void refreshVersion().then(() => {
    if (state.settingsTab === "about") rerenderSettingsPage("about");
  });
}

/** Build one pane on demand; each page owns its own state and refresh. */
function selectSettingsTab(tab) {
  const pages = settingsPages();
  const page = pages.find((entry) => entry.id === tab) ?? pages[0];
  document.querySelectorAll("[data-settings-tab]").forEach((button) => {
    const active = button.dataset.settingsTab === page.id;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", active ? "true" : "false");
  });
  const panes = $("settings-panes");
  panes.innerHTML = "";
  panes.appendChild(page.build());
  const empty = el("div", "settings-empty");
  empty.id = "settings-empty";
  empty.hidden = true;
  panes.appendChild(empty);
  panes.scrollTop = 0;
  state.settingsTab = page.id;
  applySettingsSearch();
}

function rerenderSettingsPage(tab) {
  if (state.settingsTab !== tab) return;
  const scroll = $("settings-panes").scrollTop;
  selectSettingsTab(tab);
  $("settings-panes").scrollTop = scroll;
}

$("settings-nav").addEventListener("click", (event) => {
  const button = event.target.closest("[data-settings-tab]");
  if (button) selectSettingsTab(button.dataset.settingsTab);
});

$("settings-back").addEventListener("click", () => closeModal(settingsDialog));

$("settings-search").addEventListener("input", (event) => {
  state.settingsQuery = event.target.value.trim().toLowerCase();
  applySettingsSearch();
});

/**
 * Search filters the rows on the current page and, when nothing on this page
 * matches, points at the pages that do. A settings page without search makes
 * the user guess which tab hides the control they want.
 */
function applySettingsSearch() {
  const query = state.settingsQuery;
  const panes = $("settings-panes");
  const empty = $("settings-empty");
  if (!query) {
    panes.querySelectorAll(".setting-row, .setting-group, .settings-page").forEach((node) => {
      node.hidden = false;
    });
    if (empty) empty.hidden = true;
    return;
  }
  let visible = 0;
  panes.querySelectorAll(".setting-row").forEach((row) => {
    const match = (row.dataset.search ?? "").includes(query);
    row.hidden = !match;
    if (match) visible++;
  });
  panes.querySelectorAll(".setting-group").forEach((group) => {
    group.hidden = ![...group.querySelectorAll(".setting-row")].some((row) => !row.hidden);
  });
  if (!empty) return;
  empty.hidden = visible > 0;
  if (visible === 0) {
    const s = S();
    const pages = settingsPages().filter((entry) => {
      if (entry.id === state.settingsTab) return false;
      return true;
    });
    empty.innerHTML = "";
    empty.appendChild(el("p", "", s.noMatches(query)));
    const links = el("div", "settings-empty-actions");
    for (const entry of pages) {
      const button = el("button", "chip-button", entry.title);
      button.type = "button";
      button.addEventListener("click", () => {
        $("settings-search").value = "";
        state.settingsQuery = "";
        selectSettingsTab(entry.id);
        // Carry the query over so the target page opens already filtered.
        state.settingsQuery = query;
        $("settings-search").value = query;
        applySettingsSearch();
      });
      links.appendChild(button);
    }
    empty.appendChild(links);
  }
}

/** First-run path: open Settings on the connection fields with a short prompt. */
function openSetup() {
  openSettings("connection");
  setTimeout(() => {
    const hint = $("models-hint");
    if (hint) {
      hint.textContent = t.setupHint;
      hint.hidden = false;
    }
    $("setting-base-url")?.focus();
  }, 80);
}

$("setup-button").addEventListener("click", openSetup);

/** Saved approval rules with a remove action, newest last. */
function renderRules(rules) {
  const list = $("setting-rules");
  if (!list) return;
  list.innerHTML = "";
  if (rules.length === 0) {
    list.appendChild(el("span", "rules-empty", t.rulesEmpty));
    return;
  }
  for (const rule of rules) {
    const row = el("div", "rules-row");
    const label = el("span", "rules-label", `${rule.action === "deny" ? "✕" : "✓"} ${rule.tool}${rule.match ? ` · ${rule.match}` : ""}`);
    label.title = `${rule.scope}${rule.cwd ? ` · ${rule.cwd}` : ""}`;
    const remove = el("button", "link-button", t.rulesRemove);
    remove.type = "button";
    remove.addEventListener("click", () => api.send({ cmd: "removeRule", id: rule.id }));
    row.append(label, remove);
    list.appendChild(row);
  }
}

/** The host answered getSettings; refill the open page. */
function fillSettings(settings) {
  state.settings = settings;
  state.providers = settings.providers || [];
  state.provider = settings.provider || "custom";
  if (settings.locale) state.locale = settings.locale;
  // The host's copy is authoritative: apply it so a preference edited in
  // another window (or before a restart) lands here too.
  applyUiPreference("theme", settings.theme ?? "dark");
  applyUiPreference("density", settings.density ?? "balanced");
  applyUiPreference("fontScale", settings.fontScale ?? 1);
  applyUiPreference("transcriptWidth", settings.transcriptWidth ?? "standard");
  applyUiPreference("transcriptView", settings.transcriptView ?? "normal");
  applyUiPreference("reduceMotion", Boolean(settings.reduceMotion));
  applyUiPreference("codeFont", settings.codeFont ?? "");
  state.notifications = settings.notifications !== false;
  state.keepAwake = Boolean(settings.keepAwake);
  state.branchPrefix = settings.branchPrefix ?? "prometheus/";
  state.outputStyle = settings.outputStyle ?? "default";
  state.archiveAfterDays = settings.archiveAfterDays ?? 0;
  state.sandbox = settings.sandbox === "off" ? "off" : "enforce";
  setMode(state.mode);
  if (!settingsDialog.hidden) rerenderSettingsPage(state.settingsTab);
}

/* ---------- about / update check ---------- */

async function refreshVersion() {
  if (!api.appVersion) return;
  const version = await api.appVersion();
  state.appVersion = version;
  return version;
}

function basename(path) {
  return String(path ?? "").split(/[\\/]/).filter(Boolean).pop() ?? "";
}

  /** Wire the events the host sends back into the open pages. */
  function handleEvent(message) {
    switch (message.type) {
      case "settings":
        fillSettings(message.settings);
        break;
      case "settings_saved":
        // Configuration changes are optimistic: the control already shows the
        // new value, and a failure is reported without closing the page.
        if (message.ok === false) {
          state.settingsError = message.error ?? "";
        }
        break;
      case "usage_summary":
        state.usageSummary = message.summary;
        state.renderUsagePage?.();
        break;
      case "mcp_servers":
        state.mcpServers = message.servers ?? [];
        state.renderMcpPage?.();
        break;
      case "skills":
        state.skills = message.skills ?? [];
        state.renderSkillsPage?.();
        break;
      case "memory":
        state.memory = { global: message.global ?? [], project: message.project ?? [] };
        state.renderMemoryPage?.();
        break;
      case "instructions":
        state.instructionsText = message.text ?? "";
        if (state.settingsTab === "instructions" && !settingsDialog.hidden) {
          const area = $("setting-instructions");
          if (area && document.activeElement !== area) area.value = state.instructionsText;
        }
        break;
      case "rules":
        if (!settingsDialog.hidden) api.send({ cmd: "getSettings" });
        break;
      case "packs":
        state.packState = message;
        state.renderPackPage?.();
        break;
      case "pack_catalog":
        state.packCatalog = message.entries ?? [];
        state.renderPackPage?.();
        break;
      case "pack_progress":
        state.renderPackProgress?.(message);
        break;
      case "pack_installed":
        state.renderPackProgress?.(null);
        // 装完之后目录和列表都变了，重新拉一次而不是就地改状态。
        api.send({ cmd: "getPackCatalog" });
        break;
      case "pack_error":
        state.renderPackProgress?.(null);
        state.packError = message.message ?? "";
        state.renderPackPage?.();
        break;
      case "pack_verified":
        state.packError = message.ok ? "" : (message.problems ?? []).join("; ");
        state.renderPackPage?.();
        break;
      case "pack_pruned":
        api.send({ cmd: "getPacks" });
        break;
      default:
        break;
    }
  }

  return {
    open: openSettings,
    openSetup,
    handleEvent,
    refreshVersion,
    close: () => closeModal(settingsDialog),
    isOpen: () => !settingsDialog.hidden,
    handleKey: (event) => {
      // Cmd/Ctrl+F inside Settings focuses its search, like a document.
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f" && !settingsDialog.hidden) {
        event.preventDefault();
        $("settings-search").focus();
        return true;
      }
      return false;
    },
  };
}

