# 与三大 agent 的第二轮差距调研与执行计划

调研日期：2026-10-18。覆盖 Claude Code（v2.1.302）、OpenAI Codex、Cursor（Cursor 3）。
上一轮（`docs/competitive-research.md`）解决的是"看起来像不像一个工具"：diff、检查点、终端、
设置页。这一轮调研的结论是：**界面已经不是差距，行为层才是。**

---

## 一、三家已经收敛、而我们没有的东西

| 能力 | Claude Code | Codex | Cursor | Prometheus 现状 |
|---|---|---|---|---|
| 受保护路径 | `.git`/`.vscode`/rc 文件/`.mcp.json` 永不自动批准；`rm` 根目录绕过所有 allow 规则 | 同类 | 同类 | **无** |
| 指令分层 | managed → `~/.claude/CLAUDE.md` → 项目 → 子目录按需加载；`.claude/rules/*.md` 带 `paths:` glob | `AGENTS.md` 逐目录 + override | `.cursor/rules/*.mdc` 四种作用域 | 只读最近一个文件，最多 6 层，无 glob 规则 |
| Hooks | 30+ 事件，退出码 2 阻断，可改写入参 | 11 事件，按 hook 哈希记录信任 | 20+ 事件，兼容 Claude hooks | 5 事件，`UserPromptSubmit` 声明了但**从未触发** |
| 压缩后重注入 | 根记忆、规则、计划、最近改过的文件全部重新注入 | 类似 | 类似 | 只保留 system prompt |
| MCP | tools + resources + prompts + 延迟 schema | tools + OAuth + 按工具审批 | tools + prompts + resources + elicitation + Apps | 只有 tools，schema 全量常驻 |
| 无头输出 | `-p --output-format json/stream-json`、`--json-schema` | `exec --json`、`--output-schema` | `-p --output-format` | 只有终端文本 |
| 成本 | `/cost` 按模型拆分、缓存命中计费 | 按 model/reasoning/speed 计费 | Router 三档 + 花费上限 | 只有 token 数，**没有钱** |
| 会话状态 | working / blocked / done / failed | 同类 | 同类 | 有通知，侧栏无状态 |
| 后台子代理 | 默认后台，可 pin 保活 | `/subagents` 可 steer | 前台/后台可选 | 只有前台并行 |

**三家都没有的东西**：统一的"把代码和对话一起退回到第 N 轮"。Cursor 只还原文件，Codex 只还原对话。
我们上一轮已经做了 `rewindTo`（两者都还原），这是可以明确讲的差异点。

---

## 二、这一轮要做的六件事

### A. 安全底线（受保护路径 + 关键路径熔断）

- `src/permissions.ts` 增加 `PROTECTED_PATHS`：`.git/`、`.vscode/`、`.idea/`、`.mcp.json`、
  `.prometheus/`、shell 启动文件（`.bashrc`、`.zshrc`、`.profile`、PowerShell profile）。
  写这些路径在任何模式下都要单独确认，`auto` 也不行。
- 关键路径熔断：`rm`/`rmdir` 作用于工作区根、家目录、盘根时，**绕过所有 allow 规则和 always 集合**，
  直接拒绝并说明原因。
- 审计日志记录触发的是哪条规则。

### B. Hooks 语义修正

- 退出码 2 = 阻断（沿用），但 `PreToolUse` 的 stdout 作为模型可见的理由；其余非零只报告。
- 新增事件：`PreCompact`、`PostCompact`、`SubagentStart`、`SubagentStop`。
- 真正派发 `UserPromptSubmit`，并允许它修改用户输入（stdout 非空即替换）。
- `PreToolUse` 可以通过 stdout 的 JSON `{"input": {...}}` 改写工具入参。

### C. 上下文分层

- `src/instructions.ts` 支持 `~/.prometheus/rules/*.md` 和 `<workspace>/.prometheus/rules/*.md`，
  frontmatter 支持 `paths: ["src/**"]`，只在 agent 触碰到匹配文件时注入。
- 指令文件不再只取最近一个：从工作区根到 cwd 逐层加载（上限 6 层），并支持 `@path` 导入（4 层深）。
- 压缩后重注入：系统提示词、作用域规则、当前 todo 计划、最近改过的 5 个文件路径。

### D. MCP 扩展

- 客户端增加 `resources/list`、`resources/read`、`prompts/list`、`prompts/get`。
- MCP prompt 变成斜杠命令；resource 通过 `mcp_read_resource` 工具读取。
- 工具 schema 延迟加载：MCP 工具默认只暴露名字和一行描述，`tool_search` 按需取完整 schema。

### E. 无头与成本

- `bin/prometheus.js` 增加 `--output-format text|json|stream-json`、`--output-schema <file>`、
  `--max-budget-usd <n>`。
- `src/pricing.ts`：按模型 id 前缀匹配价格表，`usage.ts` 记录成本，`/cost` 和设置页显示金额。

### F. 会话状态与后台子代理

- 会话记录增加 `status`（ready/working/needs-input/error），侧栏显示圆点，与通知联动。
- `delegate` 支持 `background: true`，子代理在后台跑完把报告写回会话，主循环不被阻塞。

---

## 三、执行顺序与验收

1. A → B（安全与钩子，独立、可测）
2. C（上下文，影响提示词，需要真实模型验证）
3. D → E（扩展与无头）
4. F（状态与后台）

每个阶段结束：`npx tsc --noEmit` 干净、`node --test "tests/*.test.ts"` 全绿、截图确认 UI 变化。
全部结束后打包一次，确认打包版仍能连上网关。

---

## 四、这一轮明确不做

云端执行、远程控制、插件市场、LSP 诊断、Tab 补全、Cmd-K 行内编辑、多仓库环境。
这些要么依赖托管基础设施，要么属于 IDE 形态，不在通用 agent 的核心路径上。
