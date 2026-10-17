/** Interface strings. Two locales, one dictionary each, no runtime dependency. */

export type Locale = "en" | "zh";

export interface Dict {
  appName: string;
  tagline: string;
  emptyTitle: string;
  emptyBody: string;
  suggestionSummarize: string;
  suggestionFailingTests: string;
  suggestionDocument: string;
  placeholder: string;
  send: string;
  stop: string;
  modeAsk: string;
  modeAuto: string;
  modePlan: string;
  workspace: string;
  changeWorkspace: string;
  sessions: string;
  newSession: string;
  clearSession: string;
  clearConfirm: string;
  close: string;
  allow: string;
  alwaysAllow: string;
  deny: string;
  statusStarting: string;
  statusConnecting: string;
  statusReady: string;
  statusWorking: string;
  statusError: string;
  statusHostStopped: string;
  statusConfigError: string;
  thinking: string;
  copy: string;
  copied: string;
  details: string;
  hide: string;
  plan: string;
  changedFiles: (count: number, list: string) => string;
  noSessions: string;
  noMessages: string;
  loadingModels: string;
  modelsUnavailable: string;
  refreshModels: string;
  language: string;
  permissionDenied: string;
  runInterrupted: string;
  compaction: string;
  hostError: (message: string) => string;
  configError: (message: string) => string;
  toolFailed: string;
  contextMeter: string;
  tokens: string;
  sessionSaved: string;
}

const en: Dict = {
  appName: "Prometheus",
  tagline: "A general-purpose coding agent",
  emptyTitle: "What should we build?",
  emptyBody: "Prometheus reads, edits, and runs your code. It asks before changing files unless you switch the mode.",
  suggestionSummarize: "Summarize this project",
  suggestionFailingTests: "Fix the failing tests",
  suggestionDocument: "Document the repo",
  placeholder: "Ask Prometheus to change, explain, or build something…",
  send: "Send",
  stop: "Stop",
  modeAsk: "Ask",
  modeAuto: "Auto",
  modePlan: "Plan",
  workspace: "Workspace",
  changeWorkspace: "Change workspace folder",
  sessions: "Sessions",
  newSession: "New session",
  clearSession: "Clear conversation",
  clearConfirm: "Start a new conversation? This session is already saved.",
  close: "Close",
  allow: "Allow",
  alwaysAllow: "Always allow",
  deny: "Deny",
  statusStarting: "starting",
  statusConnecting: "connecting",
  statusReady: "ready",
  statusWorking: "working",
  statusError: "error",
  statusHostStopped: "host stopped",
  statusConfigError: "config error",
  thinking: "thinking…",
  copy: "copy",
  copied: "copied",
  details: "details",
  hide: "hide",
  plan: "Plan",
  changedFiles: (count, list) => `changed ${count} file${count === 1 ? "" : "s"}: ${list}`,
  noSessions: "No saved sessions yet.",
  noMessages: "(no messages)",
  loadingModels: "loading models…",
  modelsUnavailable: "Model list unavailable",
  refreshModels: "Refresh model list",
  language: "Language",
  permissionDenied: "Permission denied",
  runInterrupted: "Stopped",
  compaction: "compacted the conversation",
  hostError: (message) => `Host error: ${message}`,
  configError: (message) => `Configuration error: ${message}`,
  toolFailed: "failed",
  contextMeter: "context",
  tokens: "tok",
  sessionSaved: "Session saved",
};

const zh: Dict = {
  appName: "Prometheus",
  tagline: "通用编程智能体",
  emptyTitle: "要构建点什么？",
  emptyBody: "Prometheus 会读取、修改并运行你的代码。除非切换模式，否则改动文件前会先征求你的同意。",
  suggestionSummarize: "总结这个项目",
  suggestionFailingTests: "修复失败的测试",
  suggestionDocument: "为仓库写文档",
  placeholder: "让 Prometheus 修改、解释或构建点什么…",
  send: "发送",
  stop: "停止",
  modeAsk: "询问",
  modeAuto: "自动",
  modePlan: "计划",
  workspace: "工作区",
  changeWorkspace: "切换工作区目录",
  sessions: "会话",
  newSession: "新建会话",
  clearSession: "清空对话",
  clearConfirm: "开始新对话？当前会话已经保存。",
  close: "关闭",
  allow: "允许",
  alwaysAllow: "始终允许",
  deny: "拒绝",
  statusStarting: "启动中",
  statusConnecting: "连接中",
  statusReady: "就绪",
  statusWorking: "工作中",
  statusError: "出错",
  statusHostStopped: "宿主进程已停止",
  statusConfigError: "配置错误",
  thinking: "思考中…",
  copy: "复制",
  copied: "已复制",
  details: "详情",
  hide: "收起",
  plan: "计划",
  changedFiles: (count, list) => `修改了 ${count} 个文件：${list}`,
  noSessions: "还没有已保存的会话。",
  noMessages: "（没有消息）",
  loadingModels: "正在加载模型…",
  modelsUnavailable: "无法获取模型列表",
  refreshModels: "刷新模型列表",
  language: "语言",
  permissionDenied: "已拒绝",
  runInterrupted: "已停止",
  compaction: "已压缩对话",
  hostError: (message) => `宿主进程错误：${message}`,
  configError: (message) => `配置错误：${message}`,
  toolFailed: "失败",
  contextMeter: "上下文",
  tokens: "tokens",
  sessionSaved: "会话已保存",
};

export const dictionaries: Record<Locale, Dict> = { en, zh };

/** Resolve once per process; the desktop host forwards the renderer's choice explicitly. */
export function detectLocale(): Locale {
  const explicit = (process.env.PROMETHEUS_LANG || "").toLowerCase();
  if (explicit.startsWith("zh")) return "zh";
  if (explicit.startsWith("en")) return "en";
  try {
    const system = Intl.DateTimeFormat().resolvedOptions().locale || "";
    if (system.toLowerCase().startsWith("zh")) return "zh";
  } catch {
    /* Intl unavailable */
  }
  return "en";
}

export function isLocale(value: unknown): value is Locale {
  return value === "en" || value === "zh";
}
