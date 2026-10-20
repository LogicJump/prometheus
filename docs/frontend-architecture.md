# Prometheus 前端 — 迁移文档

> 面向准备把这套前端迁到另一个项目的人。读完这份文档，你应当能在不看源码的情况下
> 说清楚：它由哪些进程组成、数据怎么流、状态存在哪、哪些是设计约束、哪些地方是坑。
>
> 对应代码：`desktop/` 目录，约 22,000 行，无构建步骤、无前端框架、无运行时依赖
> （Electron 除外）。

---

## 一、这是什么

一个 Electron 桌面应用的前端，包住一个通用编程 agent（Prometheus）。它的职责是：

- 把对话流（流式文本、思考、工具调用、工具输出）渲染成可读的转录；
- 收集用户输入（提示词、斜杠命令、`@` 文件引用、图片、语音）；
- 呈现 agent 的工作产物（diff、文件树、检查点、终端、git、PR、嵌入式板卡、串口、浏览器）；
- 承担全部交互决策（权限确认、模式切换、模型选择、设置）。

**它本身不做任何 agent 逻辑**。所有智能、工具执行、文件访问都在 host 进程里的
TypeScript runtime 中。前端是纯粹的呈现层 + 输入层。

---

## 二、进程结构

四个进程，边界清晰：

```
┌──────────────────────────────────────────────────────────────┐
│  渲染进程 (renderer)                                          │
│  desktop/renderer/*.js  — 纯 ES 模块，无打包                   │
│  index.html / styles.css / settings.css                       │
│  运行在 sandbox + 严格 CSP 下                                  │
└───────────────┬──────────────────────────────────────────────┘
                │  window.prometheus.*（preload 暴露的唯一接口）
┌───────────────▼──────────────────────────────────────────────┐
│  主进程 (main)                                                │
│  desktop/main.js — 窗口、菜单、IPC、host 生命周期、浏览器视图    │
│  desktop/browser.js — 原生 WebContentsView                     │
│  desktop/system.js — 系统级信息与设置                           │
└───────────────┬──────────────────────────────────────────────┘
                │  stdin/stdout，换行分隔的 JSON（NDJSON）
┌───────────────▼──────────────────────────────────────────────┐
│  host 进程                                                    │
│  desktop/host.js — 持有 Agent，处理命令，发出事件               │
│  desktop/terminal.js — 常驻 shell（命令运行器，不是 PTY）       │
│  desktop/git.js — git 状态与提交                                │
└───────────────┬──────────────────────────────────────────────┘
                │  直接 import
┌───────────────▼──────────────────────────────────────────────┐
│  agent runtime（不属于前端，src/）                             │
│  Agent / 工具 / 权限 / 会话 / MCP / 嵌入式适配层                │
└──────────────────────────────────────────────────────────────┘
```

### 为什么 host 是独立进程

两个原因，都很实际：

1. **TypeScript 原生运行**。`src/` 是 `.ts`，Node 24 能直接跑（`--experimental-strip-types`
   或原生支持）。放进 Electron 主进程就要打一次包，那就引入了构建步骤。
2. **隔离崩溃**。工具可以跑任意命令，一次 OOM 或原生崩溃只带走 host，窗口还在，
   可以重连。

代价是所有数据要过一遍序列化。这就是下面协议存在的原因。

---

## 三、通信协议（迁移时最需要原样带走的部分）

### 3.1 三层桥

```
renderer  ──window.prometheus.send({cmd})──▶  main  ──stdin──▶  host
renderer  ◀──window.prometheus.onEvent()───  main  ◀──stdout──  host
```

`preload.cjs` 用 `contextBridge` 暴露一个对象，渲染进程拿不到 `require`、拿不到 Node。

```js
// preload.cjs（45 行，全部内容都是桥）
contextBridge.exposeInMainWorld("prometheus", {
  send: (payload) => ipcRenderer.send("host-send", payload),
  onEvent: (handler) => { /* 订阅 host-event，返回取消函数 */ },
  pickDirectory, pickFile, readImage,      // 文件选择
  newWindow, splitWindow, windowControl, windowState,
  restartHost, saveFile,
  browserOpen, browserBounds, browserNavigate, browserSnapshot, browserScreenshot, browserClose,
  checkUpdate, appVersion,
  systemState, systemSet,
  revealFile, openExternal, notify,
  platform: process.platform,
});
```

**注意**：`send` 与 `onEvent` 是 host 通道；其余是直达主进程的 IPC（文件对话框、窗口控制、
浏览器视图、系统信息）。两套通道不要混。

### 3.2 渲染 → host：命令

`{ cmd: "<名字>", ...参数 }`。host 里是一个 `switch`，共 **102 条**。

按领域分组：

| 领域 | 命令 |
|---|---|
| 会话 | `init` `prompt` `abort` `newSession` `loadSession` `listSessions` `deleteSession` `forkSession` `searchSessions` `sessionFlags` `clearHistory` `rewindTo` `compact` `context` |
| 模型 | `setModel` `model` `models` `refreshModels` `setEffort` `effort` |
| 模式/权限 | `setMode` `mode` `plan` `permission` |
| 工作区 | `setCwd` `getTree` `getFile` `searchFiles` |
| 改动 | `getChanges` `getCheckpoints` `restoreCheckpoint` `restoreFile` `clearCheckpoints` `redo` |
| git | `gitStatus` `gitCommit` |
| PR | `prStatus` `prRerun` `prFixCi` `createPr` |
| 终端 | `terminalOpen` `terminalRun` `terminalInterrupt` `terminalRestart` `terminalClose` |
| worktree | `worktreeStart` `worktreeMerge` `worktreeDiscard` `worktreeDiff` `worktreeStale` `worktreePrune` |
| 嵌入式 | `getBoardState` `getBoardTargets` `setBoardSelection` `serialOpen` `serialClose` `serialClear` `serialStatus` `serialWrite` |
| 设置 | `getSettings` `saveSettings` `setUiPreference` `setLocale` |
| 自定义 | `getMcp` `saveMcpServer` `removeMcpServer` `addMcpPreset` `getSkills` `saveSkill` `removeSkill` `getMemory` `deleteMemory` `getInstructions` `saveInstructions` `getHooks` `hookTrust` `removeRule` |
| 工具链 | `getPacks` `getPackCatalog` `installPack` `removePack` `verifyPack` `prunePacks` `installFromManifest` `cancelPack` |
| 其它 | `getUsage` `getArtifacts` `getArtifact` `export` `exportSession` `subagents` `stopSubagent` `startGoal` `stopGoal` `resumeGoal` `startTaskLoop` `listCommands` `getSetupChecklist` `initProject` `browserResult` `clear` `shutdown` |

### 3.3 host → 渲染：事件

`{ type: "<名字>", ...载荷 }`。host 自己发出 95 种；另有 `host_exit` 由**主进程**发出
（host 进程退出时），渲染层一视同仁地处理，所以也算进协议。

| 类别 | 事件 |
|---|---|
| 生命周期 | `hello` `ready` `state` `fatal` `error` `notice` `host_exit`（主进程发） |
| 回合 | `run_start` `run_end` `queued` `user_queued_delivered` `turn_progress` `usage` |
| 流式内容 | `assistant_start` `assistant_delta` `assistant_end` `assistant_discard` `thinking_start` `thinking_text` `thinking_end` |
| 工具 | `tool_start` `tool_delta` `tool_output` `tool_end` `tool_detail` |
| 权限 | `permission_request` `permission_choice` |
| 会话 | `sessions` `session_loaded` `session_saved` `session_matches` `session_status` `session_title` |
| 工作区 | `tree` `file` `file_matches` `changes` `checkpoints` `artifact` `artifacts` |
| git / worktree | `git_status` `git_commit` `worktree_diff` `worktrees_stale` |
| PR | `pr_status` `pr_created` |
| 终端 | `terminal_output` `terminal_state` |
| 嵌入式 | `board_state` `board_targets` `board_selection` `serial_state` `serial_snapshot` `serial_lines` `serial_cleared` `serial_written` |
| 浏览器 | `browser_request` `image_url` `open_external` |
| 设置 | `settings` `settings_saved` `ui_preference` `locale` `models` `rules` `commands` |
| 自定义 | `skills` `memory` `instructions` `hook_status` `mcp_servers` |
| 工具链包 | `packs` `pack_catalog` `pack_progress` `pack_installed` `pack_verified` `pack_pruned` `pack_error` |
| 其它 | `todos` `subagents` `subagent_start` `subagent_end` `subagent_activity` `background_report` `goal_start` `goal_round` `goal_end` `recovery` `setup_checklist` `usage_summary` `command_expanded` `compact` `compacted` `context_report` `export_ready` `ask_user` `ephemeral_done` |

**新增事件时必须同步的地方**：host 的 `send()` 调用、渲染端 `handleEvent` 的 `switch`、
本节表格。（迁移时建议把这张表变成生成式的，见第十四节。）

### 3.4 主进程 IPC

`main.js` 注册了 **23 个** IPC 通道（`host-send` 各注册了一次 `ipcMain.on` 和
`ipcMain.handle`，所以代码里是 24 处注册调用）：

```
app-version  browser-bounds  browser-close  browser-navigate  browser-open
browser-screenshot  browser-snapshot  check-update  notify  open-external
pick-directory  pick-file  read-image  reveal-file  save-file  split-window
new-window  system-set  system-state  window-control  window-state  host-restart  host-send
```

---

## 四、文件结构与职责

```
desktop/
├── main.js            594 行  主进程：窗口、菜单、IPC、host 启动/重启、自动更新
├── preload.cjs         45 行  contextBridge 桥（唯一的渲染→主接口）
├── host.js           3444 行  agent 宿主：命令处理、事件发射、板卡/串口/终端/git 状态
├── terminal.js        322 行  常驻 shell（命令运行器，非 PTY）
├── git.js             238 行  git status / commit
├── browser.js         154 行  原生 WebContentsView 浏览器面板
├── system.js          192 行  系统信息与系统级设置
└── renderer/
    ├── index.html     561 行  全部 DOM（单页，无模板引擎）
    ├── app.js        5848 行  状态、事件、面板、命令面板、输入框
    ├── settings.js   2201 行  设置窗口（14 个页面，按需构建）
    ├── styles.css    5473 行  主题、布局、所有面板样式
    ├── settings.css  1243 行  设置窗口专有样式
    ├── i18n.js        944 行  主界面 en/zh 字典
    ├── settings-i18n.js 604 行 设置界面 en/zh 字典
    ├── markdown.js    185 行  本地 markdown 渲染器（转录、预览共用）
    └── icons.js       139 行  SVG sprite（24×24、1.75 描边）
```

### renderer/app.js 内部分区

文件用 `/* ---------- 名字 ---------- */` 分了 36 个区，按出现顺序：

| 区 | 行 | 作用 |
|---|---|---|
| localization | 148 | `applyLocale`：切语言时遍历 `data-i18n` 节点 |
| utilities | 230 | `$`、`escapeHtml`、`formatTokens`、`basename` 等 |
| transcript rendering | 295 | 消息、工具行、思考块的增量渲染 |
| state | 840 | 六十三个字段的全局状态、`setBusy`、`setStatus` |
| confirmation dialog | 919 | 自绘确认框（不用原生 `confirm`） |
| in-conversation search | 975 | 转录内查找（Ctrl+F） |
| slash commands | 1084 | 斜杠补全菜单 |
| @ file references | 1159 | `@` 路径补全 |
| notifications | 1249 | 用量条、上下文分解、状态提示 |
| model picker | 1536 | 模型菜单 |
| host events | 1620 | **`handleEvent` 巨型 switch（1000 行）** |
| workbench: diff/file/tree/checkpoints | 2629 | 右侧检查器 |
| terminal pane | 2708 | 终端面板 |
| board pane | 2910 | 嵌入式目标板面板 |
| board chip | 3133 | 输入框上方的板卡芯片 |
| serial pane | 3214 | 串口监视器 |
| inline review comments | 3480 | 选中代码行写意见 |
| git | 3635 | git 条、提交 |
| voice input | 3805 | Web Speech API 听写 |
| browser pane | 3870 | 浏览器面板控制 |
| artifacts | 3938 | 产物列表 |
| sessions | 4035 | 会话抽屉 |
| composer | 4424 | 输入框、发送、附件 |
| pasted images | 4635 | 粘贴图片 |
| pull request and checks | 4716 | PR 条与 CI |
| command palette | 4876 | Ctrl+K 命令面板 |
| scroll-to-latest | 5017 | 回到底部按钮 |
| "+" menu | 5132 | 输入框左边的加号菜单 |
| isolated worktree | 5250 | worktree 开关 |
| session filter | 5304 | 会话过滤与归档 |
| sidebar width | 5408 | 侧栏拖拽 |
| top bar | 5532 | 顶栏按钮 |
| window controls | 5591 | 自绘最小化/最大化/关闭 |
| settings | 5610 | 打开设置窗口 |
| shortcuts sheet | 5652 | 快捷键表 |
| top bar overflow menu | 5705 | 顶栏溢出菜单 |

---

## 五、状态管理

**没有状态库。** 一个 `const state = {...}` 对象，63 个顶层字段，模块级可变。
渲染是手工的：状态变了就调用对应的 `render*()` 函数。

### 持久化分层

| 位置 | 存什么 | 谁写 |
|---|---|---|
| `localStorage`（渲染进程） | 纯 UI 偏好：语言、主题、密度、工作区是否展开、上次会话 id、侧栏宽度、面板开关 | renderer |
| `~/.prometheus/config.json` | 连接、模型、权限模式、上下文窗口、板卡选择、沙箱策略 | host（经 `src/settings.ts`） |
| `~/.prometheus/ui.json` | 语言、主题、字号缩放、转录视图 | host（`setUiPreference`） |
| `~/.prometheus/sessions/` | 会话 JSONL、检查点、烧录历史 | host |
| 项目内 `.prometheus/` | 项目级配置、命令、worktree | host |

**规则**：UI 偏好走 localStorage（快、无往返）；一切会影响 agent 行为的走配置文件。
两者不要混——主题不会改变 agent 的行为，权限模式会。

### 关键状态字段

```js
state = {
  locale, theme, density, view,        // 呈现
  busy, statusKey, progress,           // 回合状态
  sessions, sessionId, cwd,            // 会话
  models, model, effort, mode,         // 连接
  board, boardState, boardTargetStatus,// 嵌入式
  serial, git, pr, worktree,           // 各面板
  pane, workbenchOpen, diffScope,      // 布局
  usage, contextBreakdown,             // 用量
  // …共 47 个
}
```

---

## 六、设计语言

迁移时如果保持视觉一致，这一节是规范。

### 6.1 颜色

**一个强调色，一个警告色，一个失败色。** 不做第二套色板。

```css
/* 深色（默认） */
--bg: #0e1116;  --sidebar: #13171d;  --surface: #181d24;  --surface-raised: #1f252e;
--border: #262d38;  --border-strong: #38414f;
--text: #e7ecf3;  --text-secondary: #98a3b3;  --text-faint: #6d7889;
--accent: #4c9df0;  --accent-hover: #6cb0f5;  --accent-soft: rgba(76,157,240,.14);
--success: #4fb286;  --warn: #d6a244;  --danger: #e06a5e;
```

主题共五种：`dark`（默认）、`light`、`contrast`（深色高对比）、`light-contrast`、
跟随系统。高对比是**同色板的提亮版本**，不是第三种性格。

上下文的分类色（用量条用）是强调色的"安静兄弟"：

```css
--accent-warm: #c98b4b;  --accent-2: #4b9ac9;  --accent-3: #9a7bd1;
```

**语义约束**：颜色只承载语义。绿=好，琥珀=注意，红=坏，蓝=活动。不用颜色做装饰。

### 6.2 排版

```
--sans: "Inter", "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif
--mono: "SF Mono", "Cascadia Code", "JetBrains Mono", ui-monospace, Menlo, Consolas
```

三档字号，全部随 `--ui-scale` 缩放：

```css
--text-xs:   calc(11px * var(--ui-scale));
--text-sm:   calc(12px * var(--ui-scale));
--text-base: calc(13px * var(--ui-scale));   /* 界面默认 */
--text-md:   calc(14px * var(--ui-scale));   /* 转录正文 */
--text-lg:   calc(17px * var(--ui-scale));
--text-xl:   22px;
```

转录有独立的 `--font-scale`（用户偏好），和界面缩放分开。

### 6.3 几何

三个圆角，不多不少：`--radius-sm: 6px`（小控件）、`--radius: 10px`（卡片、按钮）、
`--radius-lg: 14px`（弹层、模态）。

圆角不随元素大小分级——同一个 10px 用在按钮和面板上。

### 6.4 动效

```css
--ease: cubic-bezier(0.2, 0.7, 0.3, 1);
--fast: 110ms;    /* 悬停、按下 */
--normal: 170ms;  /* 展开、淡入 */
```

`prefers-reduced-motion` 映射为 `:root[data-motion="reduced"]`，把 `animation-duration`
和 `transition-duration` 全压到 0.01ms。

**原则**：动效只用来解释"发生了什么变化"，不做入场动画。转录里的每个元素都在流式
增量更新，给每块加入场动画会变成噪音。

### 6.5 布局

```
┌────────────┬───────────────────────────┬──────────────┐
│  侧栏      │  顶栏                     │              │
│  264px     │  ─────────────────────────│   检查器      │
│  可拖拽    │  转录（阅读宽度 780px）    │   420px      │
│            │                           │   可开关      │
│  会话列表  │  ─────────────────────────│              │
│            │  输入框                   │              │
│            │  底栏：+ 模式 … 模型 用量   │              │
└────────────┴───────────────────────────┴──────────────┘
```

- 侧栏宽度写在 `--sidebar-width`，拖拽时写 `--sidebar-drag-width` 到元素上（绕开过渡）。
- 转录列宽 `--reading-width` 由用户在设置里选三档：narrow 620px / standard 780px /
  wide 980px。它是**用户偏好**，不是窗口断点——这点和大多数编辑器相反，迁移时别改成
  响应式。
- 检查器固定 420px（下限 320、上限 560）——**不要用百分比**，百分比算的是剩余空间，
  会挤压对话区（这是修过的真实 bug）。
- 底栏和标签栏都必须 `flex-wrap: nowrap`，否则窄窗口下变两行。

---

## 七、界面结构（DOM）

单页 `index.html`，所有面板都在 DOM 里，靠 `hidden` 属性和 class 切换。没有路由。

### 主要区块

| id / class | 作用 |
|---|---|
| `.app-shell` | 三栏网格根 |
| `#sidebar` | 会话抽屉、搜索、过滤、归档 |
| `.topbar` | 工作区芯片、worktree、目标、改动、终端、更多 |
| `#transcript` | 消息流（`aria-live`，busy 时 `aria-busy`） |
| `.composer` | 输入框、附件、建议、权限条 |
| `.composer-bar` | 底栏：`+`菜单、模式、板卡芯片 / 模型、上下文、思考强度 |
| `#workbench` | 右侧检查器，9 个标签页 |
| `#settings-dialog` | 设置模态（14 页，按需构建） |
| `#palette` | 命令面板 |
| `#shortcuts-dialog` | 快捷键表 |

### 检查器标签页（9 个）

`files` · `diff` · `history` · `tasks` · `artifact` · `terminal` · `board` · `serial` · `browser`

标签栏单行横向滚动，不折行。

### 国际化的实现

**没有 i18n 框架**，两套字典 + 一次 DOM 遍历：

- `i18n.js` 导出 `dictionaries.en` / `dictionaries.zh`，主界面用。
- `settings-i18n.js` 同样结构，设置窗口用（独立因为设置页有 600+ 条文案）。
- `index.html` 里静态节点标 `data-i18n="key"`（文本）、`data-i18n-title`（tooltip）、
  `data-i18n-placeholder`（输入框）。
- `applyLocale()` 遍历这些属性写值。
- **动态节点不能带 `data-i18n`**，否则切换语言时会被占位文本覆盖。这类节点由各自的
  `render*()` 负责（板卡芯片值、串口状态、模型 id 都是）。

键必须两侧都有，缺一个会在切换时显示空白。有脚本校验（`node --input-type=module`
比较两个字典的键集），迁移时建议做成测试。

---

## 八、数据流：一个回合

以用户发一条消息为例：

```
1. 用户回车
   → renderer 清空输入框、setBusy(true)、本地回显用户气泡
   → api.send({ cmd: "prompt", text })

2. host 收到
   → runPrompt()：开始一个 agent 回合
   → send({ type: "run_start" })

3. agent 流式输出
   → send({ type: "assistant_start" })
   → send({ type: "assistant_delta", text })，每帧一次
   → 若模型带思考：thinking_start / thinking_text / thinking_end
   → send({ type: "assistant_end" })

4. 工具调用
   → send({ type: "tool_start", name, input })
   → send({ type: "tool_output", text })（可选，流式）
   → send({ type: "tool_end", result })
   → 若工具返回结构化载荷：tool_detail

5. 需要权限
   → send({ type: "permission_request", id, tool, summary, scope })
   → renderer 在输入框上方显示确认条（不是模态）
   → 用户点"允许" → api.send({ cmd: "permission", id, answer })

6. 回合结束
   → send({ type: "run_end" })
   → renderer setBusy(false)、显示"下一句建议"
```

### 流式渲染的性能约束

转录在流式时每帧都可能更新。已做的优化（迁移时别退回）：

- 每帧只读一次布局，不重复触发强制同步布局；
- 光标是一个元素，移动它而不是每帧重建；
- markdown 增量渲染不再每帧整段签名比较；
- 未闭合代码块有 300 字符的渲染预算（超过就不重新解析）；
- 思考流按帧合并，且只在贴底时跟随滚动；
- diff 面板按内容签名跳过重建，保留滚动位置。

---

## 九、关键交互约定

### 权限确认不是模态

出现在输入框上方的一行，带三个选项（允许 / 始终允许 / 拒绝）。转录保持可读。
`always` 的作用域由 `permissions.ts` 决定，前端只回传选择。

### 发送按钮在忙时不禁用

按回车一直是排队的，按钮之前却是禁用的，两个入口行为不一致。现在按钮也排队，
并改变文案（"排队"）和样式（`.queues`）。

### 自己画窗口控件

Windows 和 Linux 用自绘的最小化/最大化/关闭（`#window-controls`），这样标题栏和顶栏
颜色一致、跟随主题。macOS 保留原生红绿灯。

### 空状态不制造警报

"没有连接探针"是琥珀色，不是红色——没有硬件不是错误。缺失的工具链只显示**当前项目
需要的那几个**，不列全部 23 种。

### 不显示没观测到的数

一条硬性规则，踩过的坑：

- 上下文窗口没被端点声明时，用量条标"（默认窗口）"；
- 波特率无法从端口读回，未选择时标"默认"；
- Flash 占用只有在芯片报告了容量时才算百分比；
- 目标板的"目标"必须来自芯片读数或用户显式输入，不能来自配置文件里的旧值。

---

## 十、已知的坑（迁移必读）

### 1. 百分比宽度在 flex 行里算的是「剩余空间」

`.workbench { width: 46% }` 在 1360px 窗口、346px 侧栏下只得到 466px，不是 626px。
对话区被压到 548px，底栏和标签栏都折行。**用固定像素 + min/max**。

### 2. `flex-wrap: wrap` 在挤压时会翻倍行高

底栏从 36px 变 75px，正好发生在垂直空间最紧张的时候。

### 3. 面板内部的 `position: absolute` 定位上下文

`.composer` 是 `position: relative` 且贴在窗口底部，这会让 `bottom: 100%` 的弹层
跑到视口外。斜杠命令菜单必须用 `left/right` 定位而不是 `bottom: 100%`。

### 4. 动态节点带 `data-i18n` 会被语言切换覆盖

凡是 `render*()` 写进去的文本节点，都不能带 `data-i18n`。

### 5. `$("id")` 在 DOM 构建前调用会静默失败

`app.js` 顶部大量 `const x = $("id")` 是模块级求值。`index.html` 必须先于 `app.js`
加载（`<script type="module">` 的顺序保证了这一点，但迁移时如果改成动态注入要小心）。

### 6. 设置页按需构建，重建会丢失未保存的编辑

`selectSettingsTab` 会清空并重建议板。语言切换会触发重建，所以编辑中的输入框内容
会丢——这是已知且接受的行为。

### 7. 浏览器面板是原生视图，截图截不到

`WebContentsView` 由主进程持有，`win.webContents.capturePage()` 不包含它。
要验证浏览器面板得用系统截图。

### 8. localStorage 与配置文件的边界

主题在 localStorage，权限模式在配置文件。前者不通知 host，后者要走 `saveSettings`。

---

## 十一、设置窗口

14 个页面，左侧导航分三组：

```
设置      general · appearance · usage · connection · behavior · sessions
自定义    mcp · skills · memory · instructions · hooks
计算机    tools · system · about
```

每个页面是一个 `build*Page()` 函数，返回 DOM 片段。控件由 10 个工厂函数生成：

```js
sPage(title, description)                          // 页面外壳
sGroup(title, rows)                                // 一组行
sRow({ label, desc, control, id, wide, mono })     // 一行：标签 + 说明 + 控件
sHint(text)                                        // 说明文字
sSelect({ id, value, options, onChange, disabled })
sToggle({ id, checked, onChange, disabled })
sText({ id, value, placeholder, type, mono, onChange, min, max, step, disabled })
sTextarea({ id, value, placeholder, rows, onSave, saveLabel })
sSegmented({ options, value, onChange, previews }) // 分段选择器
sButton(label, onClick, { primary, quiet, danger })
```

**不要直接写 HTML**。用这些工厂，样式和可访问性（`role`、`aria-*`）才一致。

设置搜索是行级的：匹配 `label` 和 `desc` 文本，逐行隐藏；本页没有匹配时提示其它页面。

---

## 十二、可访问性

已经做到的，迁移时不要退：

- 转录区 `aria-live="polite"`，流式时 `aria-busy="true"`（否则读屏器逐字符朗读）；
- 所有模态有焦点陷阱，Esc 关闭，关闭后焦点回到触发元素；
- 图标按钮都有 `aria-label` 或 `data-i18n-title`；
- 标签页用 `role="tablist"` / `role="tab"` / `aria-selected`；
- 单选组用 `role="radiogroup"` / `role="radio"` / `aria-checked`；
- `prefers-reduced-motion` 全量尊重；
- 四套主题都过 WCAG AA（正文尺寸）。

---

## 十三、安全

- 渲染进程在 `contextIsolation: true` + `nodeIntegration: false` 下，只有 preload 暴露的接口。
  **注意 `sandbox: false`**：渲染进程不是完整沙箱，它能用 Chromium 的全部能力，只是拿不到
  Node。真正的隔离靠 preload 白名单 + CSP，不要以为沙箱替你兜底。
- CSP 写在 `index.html` 的 `<meta>` 里：`default-src 'self'; style-src 'self'
  'unsafe-inline'; img-src 'self' data:; script-src 'self'`。不加载任何网络资源；
  字体、图标、markdown 全部本地。
- markdown 渲染器自己写（`markdown.js`），输出前转义，不 `innerHTML` 未净化内容。
- 所有从 host 来的文本在插入 DOM 前过 `escapeHtml`。
- 外部链接走 `openExternal`，不在应用内导航。

---

## 十四、如果重写，我会改的

这部分是给迁移者的诚实建议，不是现状描述。

1. **`app.js` 该拆。** 5848 行、36 个区、一个 1000 行的 `handleEvent` switch。
   按面板拆成模块（每个面板一个 `<pane>.js`，导出 `mount()`），`handleEvent` 改成
   事件类型到处理器的注册表。现在加一个面板要改同一个文件的三个地方。

2. **协议该生成。** 102 条命令、95 种事件、23 个 IPC 通道现在都是手写字符串，靠人同步
   host、renderer、文档三处。应该从一个 schema 生成 TypeScript 联合类型和
   `handleEvent` 的骨架——漏一个就是运行时的静默失败。

3. **`state` 该有边界。** 63 个顶层字段的单一可变对象，谁都能改。至少按面板分片，
   或者引入一个 60 行的可订阅 store。

4. **设置页的 10 个工厂函数是好东西。** 这套做法（声明式表单 + 统一样式 + 搜索）
   值得保留并扩展。它比任何表单库都轻，且完全可控。

5. **i18n 两套字典该合并。** 现在 `i18n.js` 和 `settings-i18n.js` 结构相同但要分别维护，
   切换语言的逻辑也是两套。应该一个字典、一个应用函数。

6. **`render*()` 是命令式 DOM 重建。** 大面板（转录、会话列表）每次全量重建。
   流式场景已经做了增量优化，但 diff、文件树、板卡面板都是 `innerHTML = ...` 全量。
   在数据量小时没问题，数据量大时该做 keyed 更新。

7. **没有组件边界，所以没有组件测试。** 现有测试（583 项）大多是逻辑层的，
   前端行为靠结构断言（读源码检查某处有没有某个模式）。真正需要的是能在
   jsdom 里挂载一个面板并断言其行为。

---

## 十五、打包与运行

```bash
npm run desktop        # 开发：直接跑 Electron
npm run build          # 打包：electron-builder → release/
```

只做 Windows x64。产物是 NSIS 安装包 + 便携版 exe。自绘窗口控件贯穿两者。

---

## 十六、迁移清单

把前端搬到另一个项目时，按依赖顺序：

**必须带走（前端自包含）**

- `desktop/renderer/**`（9 个文件，约 15,000 行）
- `desktop/preload.cjs`
- `desktop/main.js` 的窗口创建、IPC 注册、菜单部分
- `desktop/browser.js`（如果保留浏览器面板）

**必须重新实现（因为绑定 agent）**

- `desktop/host.js`（3444 行）——它是 agent 的宿主，不是通用代码
- `desktop/terminal.js`、`desktop/git.js`、`desktop/system.js`

**必须保留的接口契约**

- 第 3.2 / 3.3 节的命令与事件名。前端所有 `api.send({cmd})` 和 `handleEvent` 的
  `case` 都是硬编码字符串。
- `window.prometheus` 的形状（preload 暴露的 27 个成员）。
- `data-i18n` / `data-i18n-title` / `data-i18n-placeholder` 三属性的约定。
- 所有 `id`——渲染层用 185 个 `$("id")` 直接取节点，改 id 就是改代码。其中 10 个是运行时生成的（设置页动态构建），静态 HTML 里有 186 个。

**可以自由替换的**

- host 的实现语言。协议是纯 JSON，用什么写都行。
- markdown 渲染器（只要输出相同的 DOM 结构，样式就能用）。
- 设置页的具体页面（工厂函数和样式可以留，页面内容按需）。

---

## 十七、术语表

| 词 | 含义 |
|---|---|
| **turn / 回合** | 一次用户输入到 agent 停止的完整过程 |
| **host** | 持有 Agent 的独立 Node 进程，与渲染进程用 NDJSON 通信 |
| **workbench / 检查器** | 右侧 420px 面板，9 个标签页 |
| **pane / 面板** | 检查器里的一个标签页 |
| **chip / 芯片** | 输入框附近那种小标签按钮（模型、板卡、上下文） |
| **transcript / 转录** | 中间的主对话流 |
| **composer** | 输入框及其周边的整个区域 |
| **scope / 作用域** | 权限规则或 diff 的适用范围 |
| **checkpoint** | 一次文件快照，可回滚 |
| **worktree** | git 的隔离工作区，用于试改动 |
