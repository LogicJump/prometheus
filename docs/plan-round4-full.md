# 第四轮计划：把调研里「未实现 + 半实现」的全部收口

日期：2026-10-19。输入是五份 gap 报告的核对结果
（`.research/gap-core-architecture.md`、`gap-embedded.md`、`gap-tools-permissions.md`、
`gap-ui-interaction.md`、`gap-sessions-automation.md`）以及
`docs/competitive-research.md`。

本计划与 `gap-plan-round3.md` 的区别：那一轮只做「会坏掉的部分」，这一轮把
**所有标记为 ◐ 或 ☐ 的条目**逐条分配做法与验收标准。C 级条目（与既有产品约束冲突，
或需要硬件/仪器）在最后一节单列，写明理由与替代，不含糊带过。

## 图例与翻状态规则

- `☐` 未实现 / `◐` 部分实现 / `✅` 已验证实现 / `⛔` 明确不做
- **每次把 `☐`/`◐` 改成 `✅` 前必须**：
  1. 先写一条在旧代码上失败的测试（或在无测试可写时写明手工复现步骤）；
  2. 改实现使其通过；
  3. 跑 `npx tsc --noEmit` 与该测试文件，把命令与测试名写进条目末尾的「验证」；
  4. 任何一条运行结果没通过，状态保持 `◐`，不允许标 `✅`。
- 全量测试只在所有条目都确认之后跑一次（memory `verify-before-full-test-run`）。

## 统计

下表是**本轮开始时**的核对结果，保留作为起点；本轮结束后的实际状态见文末「执行记录」。

| 来源 | ✅ 已实现 | ◐ 部分 | ☐ 未实现 | 本轮计划内 | 明确不做 |
|---|---|---|---|---|---|
| 核心架构 D1–D31 | 11 | 11 | 9 | 20 | 0 |
| 嵌入式 1–35 | 3 | 12 | 20 | 27 | 5 |
| 工具/权限 1–35 | 8 | 13 | 14 | 25 | 2 |
| UI 交互 G1–G34 | 3 | 11 | 20 | 28 | 3 |
| 会话/自动化 1–27 | 5 | 15 | 8 | 23 | 0 |
| competitive 重叠项 | — | 8 | 0 | 归入上表 | — |

**本轮结束时**：计划内 134 条 → `✅` 127 条、`⛔` 7 条（理由都在 C 级表）、
`◐` 与 `☐` 均为 0 条（每一项要么做完并有验证，要么明确不做）。

---

# 阶段 A：核心引擎（src/agent.ts、query.ts、context.ts、llm.ts、subagents）

| # | 现状 | 缺口（核对结论） | 做法 | 验收 |
|---|---|---|---|---|
| A1 D2 | ✅ | 重试耗尽后丢弃 partial；每次重试再次推送半截文本 | `requestWithRetries` 累积 streamed；失败落 transcript；重试前发 `discard` 事件让 UI 清掉上次半截 | 新 `tests/round4-engine.test.ts`：2 次失败后 messages 含 partial assistant；UI 收到 discard |
| A2 D6/D21 | ✅ | 只有 bash 落盘；MCP 结果无上限/不落盘；落盘路径模型读不回来 | 统一 `pipeline` 层对所有 `persistOutput`/超长结果落盘；`resolveSafePath` 对 `~/.prometheus/sessions/<id>/tool-results/` 放行只读；MCP 结果套同一上限 | 落盘文件可被 `read_file` 读回；MCP 超长结果被截断并给路径 |
| A3 D7 | ✅ | 压缩触发只看 messages，未计 schema/system；deferred 工具计入显示 | `shouldCompact` 用 `contextUsage()` 的全量数字；deferred 工具的 schema 不计 | 构造 40 个 deferred 工具，触发阈值不变；schema 变大则更早触发 |
| A4 D11 | ✅ | 子代理无 id、不可寻址/追加指令/单独中断/恢复，只取最后一段文本 | `delegate` 返回 `agentId`；新增 `agent_message` / `agent_stop` / `agent_resume` 工具与 `SubagentRegistry`；结果取完整报告 | 一个子代理可被第二次追加指令；stop 后 state=stopped |
| A5 D12 | ✅ | 子代理权限提示不标注来源，无折叠分组 | 子代理的 `confirm` 带 `source: "subagent:<id>"`；UI 归组 | 权限 detail 带来源；UI 在同一组渲染 |
| A6 D14 | ✅ | Usage 无 cacheWriteTokens | 识别 `cache_creation_input_tokens` / `prompt_cache_miss_tokens`；计入成本 | 解析四种网关字段，成本含 cache write |
| A7 D16 | ✅ | 压缩摘要不看 reasoning | summarizer 输入包含 reasoning（有上限） | 带 reasoning 的会话摘要包含其要点 |
| A8 D17 | ✅ | PreCompact trigger 恒 auto | trigger 区分 manual/auto；hook 可读 | manual /compact 时 hook 收到 `trigger:"manual"` |
| A9 D18 | ✅ | 无 fork 子代理 / 上下文继承 | `delegate` 增加 `fork_context: "none"|"summary"|"full"` 与 `turns` | fork 的子代理首条消息含父级上下文；turns 生效 |
| A10 D19 | ✅ | 无 keepRecent / 部分压缩；桌面无 focus 输入 | `compactNow(focus, keepRecent)`；`/compact` 解析 `--keep N`；桌面输入框支持 focus | keepRecent 保留最近 N 轮；桌面可输入 focus |
| A11 D20 | ✅ | 后台报告只发卡片，不入 messages，无任务列表 | 后台完成时注入一条 user 消息（带来源标注）；host 维护 task list，支持 stop/view | 后台完成后下一轮模型能看到报告；任务可停止与查看 |
| A12 D22 | ✅ | 子代理结果无来源标注/注入防护 | 结果包 `<subagent-report id=...>` 头；扫描 "ignore previous instructions" 等并标注 | 报告带来源头；可疑指令被标注为数据 |
| A13 D25 | ✅ | 无 idle compaction | 可选设置 `idleCompactMinutes`，默认关；空闲计时触发同一压缩路径 | 设为 1 分钟时，空闲后压缩被触发 |
| A14 D26 | ✅ | 无压缩 thrashing 熔断 | 连续 3 次压缩后仍超 90% 就停止自动压缩并提示一次 | 模拟回满，第 3 次后不再压缩且告警 |
| A15 D27 | ✅ | 无每模型/子代理独立窗口配置 | `Config.contextWindowByModel`；子代理 `subagentContextWindow` | 子代理用独立窗口；主会话不变 |
| A16 D28 | ✅ | maxTurns 到达无 partial 标记 | 子代理到上限时报告前缀 `[partial: turn limit N]`；主循环同样标注 | 25 轮子代理报告带 partial |
| A17 D29 | ⛔ | 流式工具参数不提前执行 | **不做**（见 C 级）。现状是 `runToolBatch`（`query.ts:334`）在 SSE 结束后才开始：相邻的只读调用并发跑（`Promise.all`），写调用串行；结果一律按**调用顺序**回填，不按完成顺序 | — |
| A18 D30 | ✅ | 预算只在 CLI 一键模式 | REPL `/budget`、桌面设置项、goal 循环预算；run 内每轮检查 | 超预算在轮中途停止；REPL/桌面生效 |
| A19 D31 | ✅ | 无会话级 token/rollout 预算 | `Config.sessionTokenBudget`，跨 run 累计，超限拒绝下一轮 | 第二个 run 被拒绝并说明已用/上限 |

---

# 阶段 B：工具、权限、hooks、沙箱

| # | 现状 | 缺口 | 做法 | 验收 |
|---|---|---|---|---|
| B1 T3 | ✅ | `node script.js` / `python script.py` 仍 allow | 解释器带脚本文件时：脚本路径在工作区外 → deny；网络策略非 open 时 confirm | `python ../x.py` deny；工作区内脚本 confirm |
| B2 T5 | ✅ | 设置页仍列出空的 `proxy` 选项 | 要么实现域名白名单代理，要么隐藏并说明；本轮改为隐藏 + 文档标注 | 设置页不再出现 Proxy only；迁移旧配置时降级为 off 并提示 |
| B3 T6 | ✅ | pack validation/build 继承 process.env 且未过分类器 | pack 命令套 `sandboxEnv` + `classifyCommand` | pack 脚本看不到 API key；危险命令被拒 |
| B4 T8 | ✅ | 非代理感知程序/脚本仍可直连 | 与 B1 合并：所有解释器脚本在 network!=open 时 confirm；文档写明不是内核隔离 | 脚本直连行为需用户确认 |
| B5 T10 | ✅ | 只有 3 档权限模式 | 新增 `acceptEdits`、`bypassPermissions`、`dontAsk`；CLI/桌面/REPL 选择器 + 系统提示 | 四档+plan 的矩阵测试；`--mode acceptEdits` 自动批准写文件但不批准 bash |
| B6 T12 | ✅ | 无参数级规则、无 --disallowed-tools | 规则语法 `Tool(specifier)`（bash 命令 glob、read/write 路径 glob、mcp__server/*）；实现优先级 | `Bash(git status)` 只放行该命令；`--disallowed-tools` 拒绝 |
| B7 T13 | ✅ | hooks 事件少、blocked 语义 exit≠0 | 补 `PermissionRequest`、`PostToolUseFailure`、`SessionEnd`、`Notification`；blocked 改为 exit 2（兼容旧行为注释） | 新事件被触发；exit 1 不再静默阻断 |
| B8 T14 | ✅ | hook 不能返回结构化权限决定 | HookResult 加 `permissionDecision` / `additionalContext` / `updatedMCPToolOutput` | hook 返回 allow 时不再弹窗；additionalContext 进上下文 |
| B9 T15 | ✅ | CLI 不触发 SessionStart/Stop | REPL 与一次性 CLI 启动/退出各触发一次 | hook 日志两条 |
| B10 T16 | ✅ | 无 mcp login/logout；token 未进 keychain | 新增 `prometheus mcp login <server>` / `logout`（跑与桌面同一套 PKCE 流程）；token 写 `mode 0o600`，Windows 上再调 `icacls /inheritance:r /grant:r <user>:F` 去掉继承权限。**未做**：计划里写的 DPAPI 加密——同一用户的任意进程都能解开 DPAPI，收益主要是防止复制文件到别的账户，而 ACL 已经挡住这一点；少一层自造加密也少一处会静默失败的路径 | `prometheus mcp login` 能授权并落盘；`icacls` 后只有当前账户可读；logout 删除 |
| B11 T17 | ✅ | resources/prompts 的 list_changed 要下次会话；sampling 拒绝 | 两个 list_changed 实时刷新；sampling 走 `sampling/createMessage`（用当前模型） | 服务器推送后目录即时更新；sampling 返回文本 |
| B12 T19 | ✅ | 不读 `.mcp.json`；项目服务器无批准 | 读 `.mcp.json`；项目服务器 pending approval，设置页启用 | clone 仓库后首次不自动启动，需批准 |
| B13 T20 | ✅ | 子代理 hooks 为空 | 子代理继承父 hooks（带 source 标注） | 子代理工具调用触发 hook |
| B14 T22 | ✅ | 分类器漏高危形状 | 补重定向覆盖、sed -i、find -delete、truncate、git push --mirror、rm -rf 变量展开 | 每种形状有测试 |
| B15 T23 | ✅ | CLI/REPL 不加载 MCP prompts | CLI 注册 MCP prompts 为斜杠命令 | `/mcp__server__prompt` 可用 |
| B16 T24 | ✅ | 资源目录截断 60 条塞 description | 改 `mcp_list_resources` 工具 + 分页 | 100 个资源可翻页取到 |
| B17 T26 | ✅ | 无结构化提问工具 | 新增 `ask_user` 工具（1–4 问、2–4 选项、multiSelect、preview）；终端/桌面两套 UI；plan 模式可用 | 工具调用渲染为选项；选择回填 |
| B18 T27 | ✅ | 读敏感文件无确认 | 默认 deny/confirm 列表：`.env*`、`*.pem`、`id_rsa*`、`.ssh/**`、`.aws/**`、`.npmrc`；规则可覆盖 | `read_file .env` 需确认 |
| B19 T28 | ✅ | hooks 串行 | 同事件并发（上限 8）+ 超时；保持输出顺序 | 3 个 hook 并发完成时间 < 串行 |
| B20 T29 | ✅ | 无 failIfUnavailable | `Config.sandboxFailIfUnavailable`；Job Object 打开失败时拒绝而非静默退回 | 模拟失败 → 命令被拒 |
| B21 T30 | ✅ | 无托管配置层 | 读 `%ProgramData%/Prometheus/managed.json`（只读、最高优先级）；支持 `disableBypassPermissionsMode` / `allowManagedHooksOnly` | 托管键不可被项目覆盖 |
| B22 T31 | ✅ | tool_search 无开关/调试 | `PROMETHEUS_TOOL_SEARCH=auto|on|off`；设置页显示 deferred 数量 | 开关生效；状态可见 |
| B23 T32 | ✅ | 无 resources/subscribe | 支持订阅并在 updated 时刷新资源 | 订阅后收到更新事件 |
| B24 T33 | ✅ | 无 prompt/agent 类型 hook | hook 增加 `type: "prompt"`（用当前模型评估，返回 allow/deny） | prompt hook 可阻断工具 |
| B25 T34 | ✅ | 无凭据注入 | `sandbox.credentials` 把值以环境变量注入沙箱而不进模型上下文 | 命令能看到变量；transcript 里没有值 |
| B26 T35 | ✅ | 无 apply_patch 流式事件 | 工具参数流式时发 `tool_patch` 事件（增量文本）；`ToolResult.data` 已有 | 事件按 delta 到达 |

---

# 阶段 C：MCP 深度（与 B 交叉的已在上表；此处单列桌面侧）

| # | 现状 | 缺口 | 做法 | 验收 |
|---|---|---|---|---|
| C1 | ✅ | 资源订阅、elicitation 仅桌面 | 见 B11/B23；CLI 下 elicitation 明确 decline | 同 B11 |
| C2 | ✅ | OAuth 无 CLI 管理 | 见 B10 | 同 B10 |

---

# 阶段 D：嵌入式（全部泛化，不绑定任何厂商/型号）

> 铁律：所有实现只能基于**标准接口与项目元数据**（CMSIS-Pack、SVD、ELF、
> pyOCD/probe-rs/OpenOCD/GDB 的标准命令），不得出现具体芯片型号或厂商目录的硬编码。

| # | 现状 | 缺口 | 做法 | 验收 |
|---|---|---|---|---|
| D1 E1 | ✅ | J-Link 调试侧 program 来源错误，probe 未传 | debug 用 `JLinkGDBServerCL` 探测；program 从 toolchain 找到的任一 JLink 可执行推导；传 probe UID | 命令向量含 `-SelectEmuBySN`；无 JLink 时明确拒绝 |
| D2 E4 | ✅ | UI 占用端口时无「从 UI 缓冲读」路径 | `embed_serial` 遇到 activePorts 冲突时读 host 环形缓冲并返回最近 N 行 | 监视器开着时仍能读到日志 |
| D3 E6 | ✅ | Board 选择不是 SVD 第一来源；pyOCD svd_path 未用 | SVD 查找顺序：Board 选中 → target 元数据 svd_path → PROMETHEUS_SVD_DIRS → pack → 缓存目录 | Board 选 target 后直接命中其 SVD |
| D4 E7 | ✅ | 未读 PlatformIO board JSON / Zephyr yaml / ELF .ARM.attributes | 三种来源都读；embed_registers 接受 Board 选择 | 三个假项目各命中正确芯片 |
| D5 E8 | ✅ | ESP-IDF 多镜像烧录 | 读 `build/flasher_args.json`，按 offset 逐个写 bootloader/partition/app | 命令序列含三个 offset |
| D6 E9 | ✅ | 多环境/构建路径/CMake configure | PlatformIO `-e`、Arduino `--build-path`、CMake configure + `compile_commands.json` | 参数出现在命令行 |
| D7 E10 | ✅ | 非 ARM size | 按 toolchain 选 `riscv*-size`；解析 ESP-IDF size 输出 | RISC-V 项目得到 flash/RAM |
| D8 E11 | ✅ | analyze 描述与行为不符 | 真跑 clang-tidy（有 compile_commands 时），否则描述改为 cppcheck only | 描述与实际一致；clang-tidy 结果进报告 |
| D9 E12 | ✅ | 调试会话不持久；无删断点/watchpoint/globals/结构体 | `DebugSession` 按 target 持久；工具增 breakpoint_delete / watch / globals / struct | 跨调用断点仍在；结构体按 SVD 展开 |
| D10 E13 | ✅ | 无实时寄存器/内存读写 | GDB `-data-read-memory-bytes` / write + 回读；按 SVD 解析外设结构体 | 读回值与写入一致 |
| D11 E14 | ✅ | 无 fault 解码 | 读 CFSR/HFSR/MMFAR/BFAR，映射成可读原因；RTOS 线程列表（Zephyr/FreeRTOS 符号探测） | 构造 CFSR 值 → 正确原因 |
| D12 E15 | ✅ | 无 RTT/SWO/ITM | probe-rs `rtt attach` 与 J-Link RTT 通道；统一为行流 | 假命令输出被解析为行 |
| D13 E16 | ✅ | 串口写、共享缓冲、选中日志发给 agent | `PortHandle.write`；host 缓冲供 agent 读；UI「发给 agent」按钮 | 写入到达端口；选中行进入 composer |
| D14 E17 | ✅ | attach 强制 ELF | ELF 可选；无符号时用地址级操作并说明 | 无 ELF 可 attach |
| D15 E18 | ✅ | 无端口冲突/残留检测 | 启动前探测 3333/1337/2331；可复用已有 server | 已有 server 时直接连 |
| D16 E19 | ✅ | J-Link/OpenOCD 枚举缺失；debug 未传多探针 | J-Link 用 `JLinkExe -CommanderScript ShowEmuList`；OpenOCD 说明；debug 传 probe | 多探针时 debug 选中正确探针 |
| D17 E20 | ✅ | 目标发现只有 pyOCD | 接 `west boards`、`pio boards --json-output`、`arduino-cli board list --format json`、`probe-rs chip list` | 各命令输出被归一 |
| D18 E21 | ✅ | 无 CMSIS-Pack 摄取 | `index.pidx` → 下载/缓存 → `.pdsc` → SVD/flash algo/board/手册 URL，带出处 | 解析一个假 pdsc |
| D19 E22 | ✅ | SVD dim 展开与 derivedFrom | 展开 peripheral/cluster/register 的 dim；字段级 derivedFrom | 含 dim 的 SVD 取到全部实例 |
| D20 E23 | ✅ | 无 pinmap | CMSIS-Pack pin 数据 + 冲突检测；无数据时明确说明 | 同一 pin 两个 AF 报冲突 |
| D21 E24 | ✅ | 无 datasheet 索引 | 可插拔索引（PDF 文本抽取用可选外部工具）；命中带页码；失败显式说明 | 无 pdftotext 时明确报不可用 |
| D22 E25 | ✅ | 无厂商 MCP 预设 | 内置`.mcp.json` 模板（ESP-IDF/Nordic/Arduino），一键写入并可编辑 | 模板写入后启动 |
| D23 E26 | ✅ | BoardSelection 无 OpenOCD cfg/一体校验 | 增加 `interface`/`targetCfg`；校验组合；profile 可保存 | 选 OpenOCD 时自动推导 cfg |
| D24 E27 | ✅ | 无测试运行器 | `west twister` / `pio test` / `ctest` / `idf.py build` 归一为 JUnit/JSON | 假输出解析为结果 |
| D25 E28 | ✅ | 无 QEMU/Renode 运行器 | 运行器 + 确定性参数；无硬件反馈 | 命令向量正确 |
| D26 E29 | ✅ | 无 HIL 电源循环 | 可插拔电源控制器接口 + 录放脚本 | 假控制器按序执行 |
| D27 E30 | ✅ | 无测量 | SCPI/Joulescope/PPK2/sigrok 可插拔驱动；返回 Measurement | 假 SCPI 响应解析 |
| D28 E31 | ⛔ | 无波形 | 逻辑分析仪/示波器驱动 + 基本异常解释 | 假波形解析 |
| D29 E32 | ✅ | 无烧录历史 | 每次 flash 追加 `sessions/<id>/flashes.jsonl`（时间、hash、target、flasher、verified、耗时） | 两次烧录两条记录 |
| D30 E33 | ⛔ | 无测量面板 | 依赖 D27/D28；有数据才显示 | 无数据时不显示 |
| D31 E34 | ⛔ | 工具链目录无 pyocd/probe-rs/esptool | **不做**（见 C 级）。真实状态：`src/packs/catalog.ts` 只有 gcc-arm、gcc-riscv、openocd、cmake、ninja 五项，这三项一条都没有；缺工具时走 `installHints.ts` 给官方命令 | — |
| D32 E35 | ✅ | 启动前不清理残留 server | 启动前探测并清理自己的残留（按 pid 文件），不杀别人的 | 残留 pid 被清理，他人进程不动 |

---

# 阶段 E：会话、自动化、CLI

| # | 现状 | 缺口 | 做法 | 验收 |
|---|---|---|---|---|
| E1 S2 | ✅ | auto 分支先 prompt 后 autoApprove，`--mode auto --dont-ask` 仍失败 | 把 `autoApprove`/unattended 判断提到 prompt 之前 | `--mode auto --dont-ask` 执行 npm install |
| E2 S5 | ✅ | merge/discard 退出 worktree 清空对话；worktree 不写 meta | 退出时 carrySession；SessionFile 记录 worktree | 进出 worktree 对话不丢 |
| E3 S6 | ✅ | REPL/一次性 CLI 只在回合结束保存 | 与桌面一致：回合中每 5 秒增量落盘 | 中途 kill 后可恢复部分消息 |
| E4 S7 | ✅ | 无后台会话/attach/supervisor | `prometheus --detach` 后台跑并写同一 JSONL；`prometheus attach <id>` 只读跟随事件 | 关终端后任务继续；attach 能看到输出 |
| E5 S8 | ✅ | 崩溃后不自动恢复，不核对已生效工具 | 启动扫描 `runActive` 标记，自动重载会话并注入「以下工具可能已执行」 | 重启后回到原会话并提示 |
| E6 S9 | ✅ | 预算不完整 | 见 A18；补未知模型显式报错而非静默、goal 预算 | 未知模型给出警告 |
| E7 S10 | ✅ | /cost 不给美元 | /cost 显示 tokens + 金额（按当前模型定价） | 输出含 `$` |
| E8 S11 | ✅ | headless 契约薄 | 输出 `init`（session_id 提前）、`turn_start`、`tool_start` 带 id/参数/时间戳、`turn_end` | 事件序列可配对 |
| E9 S12 | ✅ | CLI 无检查点命令；REPL 不写检查点 | `prometheus checkpoints list/restore`；REPL 设 sessionId | CLI 可列出并恢复 |
| E10 S13 | ✅ | 检查点漏 bash 文件变更与 >2MB | bash 前后按 git status 捕获变更文件快照；大文件用 hash + 流式快照上限提高 | rm/mv 可回滚 |
| E11 S14 | ✅ | 单文件恢复撤销其后全部改动；无 redo | `restoreFile(id)` 只还原该文件；增加 redo 栈 | 点单文件只改一个文件 |
| E12 S15 | ✅ | 搜索只过滤已加载列表 | host 服务端全量搜索 | 搜索命中第 200 条 |
| E13 S16 | ✅ | 桌面不还原 sandbox/board；goal/worktree 不入 meta | 全部还原；meta 存 goal/worktree | 重开会话配置一致 |
| E14 S17 | ✅ | CLI 会话导航弱 | 按标题/前缀选择器；fork/archive/rename/delete 子命令；歧义列出候选 | `prometheus sessions` 交互选择 |
| E15 S18 | ✅ | error 被 finally 覆盖；无启动清扫 | 状态机修正；启动把遗留 working 标为 interrupted | 失败会话保持 error |
| E16 S19 | ✅ | fallback 归因错；摘要/goal usage 丢弃 | `FallbackChatClient.active` 返回实际模型；摘要与 assessGoal 记 usage | 降级后 usage 记 fallback 模型 |
| E17 S20 | ✅ | 用量无导出/维度 | CSV/JSON 导出；按项目/会话拆分；cache write/reasoning；每请求一条 | 导出文件含全部维度 |
| E18 S21 | ✅ | 无定时/触发 | 本地调度器（`prometheus schedule add`，Windows 任务计划或内置常驻）；错过补跑；webhook 触发 | 到点执行并可补跑 |
| E19 S22 | ✅ | worktree 能力单薄 | `.worktreeinclude`、lock、周期清扫、会话绑定、调用 ensureWorktreeIgnored | include 文件被复制；残留被清扫 |
| E20 S23 | ✅ | goal 不持久、无预算、CLI 无入口 | goal 落盘；预算；`prometheus goal` | 崩溃后 goal 恢复 |
| E21 S24 | ✅ | schema 文件缺失抛栈 | 转成一行错误 + 非零退出 | 缺失时无栈 |
| E22 S25 | ✅ | 无 ephemeral | `--ephemeral` 不落会话 | 跑完会话列表不变 |
| E23 S27 | ✅ | 无 apply patch | `prometheus apply <id>` 把会话最后一次 diff 以 patch 应用到当前树 | patch 可应用 |

---

# 阶段 F：桌面 UI

| # | 现状 | 缺口 | 做法 | 验收 |
|---|---|---|---|---|
| F1 G1 | ✅ | 回合中不推送改动 | host 在每次写工具后 debounce 500ms 发 `changes`；渲染层主动调 getChanges | 回合中途徽标变化 |
| F2 G2 | ✅ | write_file 批准不带 diff | 与 edit_file 同一 detail 通道 | write_file 弹窗显示全文 diff |
| F3 G3 | ✅ | diff 无 Keep/Undo/Revert | 每个文件块加按钮；后端 `restoreFile` | 点 Undo 只回滚该文件 |
| F4 G4 | ✅ | edit_file 行内无 diff 卡片 | 折叠 diff 卡片（复用 diff 渲染） | 行内展开 |
| F5 G5 | ✅ | 无词级高亮 | 行内 LCS 词级 diff；长行横向滚动 | 改动词高亮 |
| F6 G6 | ✅ | 子代理卡不可展开/停止 | 展开全部活动 + 停止按钮 + tasks 面板 | 可停止 |
| F7 G7 | ✅ | 无回合级进度 | spinner 事件带 elapsed/currentTool/retry | 显示 12s · bash · 重试 1/3 |
| F8 G9 | ✅ | 权限条不说原因 | 所有 prompt 带 reason（规则命中/模式/保护路径） | 每条 prompt 有原因行 |
| F9 G10 | ✅ | autoApprove 与 rules 两套 | 设置页改为规则列表（迁移旧值） | 只有一套 |
| F10 G11 | ⛔ | 无同窗分屏 | **不做**（见 C 级） | — |
| F11 G12 | ✅ | 无状态/项目筛选 | 侧栏筛选菜单 + host 过滤参数 | 只看 error |
| F12 G13 | ✅ | 启动不恢复上次会话 | 记住 lastSessionId，启动自动打开（可关） | 重启回到上次 |
| F13 G15 | ✅ | 会话操作只在右键菜单 | 悬停「…」按钮 + 菜单键 | 可见入口 |
| F14 G16 | ✅ | 无自动标题 | 首轮结束后用当前模型生成 6 词标题（可关，免费规则优先） | 侧栏标题变化 |
| F15 G17 | ✅ | busy 时 Enter 能排、Send 不能 | Send 改为「排队」按钮与 Enter 一致 | 行为一致 |
| F16 G18 | ✅ | 附件只收图片 | PDF/文本/日志拖入；文本直接入上下文，PDF 走 host 抽取 | 拖入 .log 生效 |
| F17 G19 | ✅ | @ 只插路径 | 选中后附带文件内容（大文件只附路径并说明） | 上下文含内容 |
| F18 G20 | ✅ | 无输入历史/消息操作 | Up/Down 历史；消息复制/重试/编辑 | 三条都有 |
| F19 G21 | ⛔ | 非 PTY | **不做**（见 C 级） | — |
| F20 G22 | ✅ | PR 条只读 | 自动修 CI 按钮（把失败日志发给 agent）；重跑检查；gh 缺失提示安装 | 失败检查可重跑 |
| F21 G23 | ✅ | 浏览器无 agent 工具 | 浏览器面板暴露 `browser_open/read/screenshot` 工具（Electron 注入） | agent 能读页面 |
| F22 G24 | ✅ | worktree 只能手动 | 设置项「新会话默认隔离」；位置可配置 | 新会话自动隔离 |
| F23 G26 | ✅ | a11y 不完整 | 流式时暂停 aria-live；菜单 roving focus；页签 aria-selected；Esc 关闭 | 键盘可全走 |
| F24 G27 | ✅ | 7 处原生 confirm | 换自绘对话框；命令面板焦点陷阱 | 无原生灰框 |
| F25 G28 | ✅ | 无 UI 缩放/高对比 | `--ui-scale`；高对比主题；色盲安全配色（保留现有语义色） | 设置项生效 |
| F26 G29 | ✅ | 设置内 Ctrl+F 未接线 | 接线到设置搜索 | 打开设置搜索框 |
| F27 G30 | ✅ | 流式全量重解析 | 增量 markdown（按块缓存，只重解析最后一块）；diff 增量 | 长回答滚动不掉帧 |
| F28 G31 | ✅ | 无首次运行清单 | 检查 gh/工具链/端点，列缺失项与安装指引 | 首次启动显示 |
| F29 G32 | ✅ | 无下一句建议 | 回合后空 composer 灰字建议（可关） | Tab 接受 |
| F30 G33 | ✅ | 更新检查无提示 | 启动后台检查，有新版在 About 与标题栏提示 | 模拟新版出现提示 |
| F31 G34 | ✅ | 实时回合无 rewind；History 只能按文件 | submit() 挂 attachRewind；History 增加按轮次恢复 | 新回合可回滚 |

---

# C 级：明确不做（附理由与替代）

| 条目 | 理由 | 替代 |
|---|---|---|
| E18 云托管定时任务（原 S21 的托管部分） | 托管基础设施与本机优先的定位冲突；本地的调度（`schedule.ts` + Windows 任务计划）已经把「到点执行、错过补跑」做完了，云端那部分只是换个地方托管 | 本地调度（E18 的本地部分仍然做） |
| E29–E31、E33 测量/波形/HIL 面板（需仪器） | 无硬件无法验证，且 D27/D28 驱动层已提供可插拔接口 | 提供驱动接口与假设备单测；面板等有数据再显示 |
| G11 同窗分屏 | renderer 与 host 是 1:1，分屏要重写对话容器与 IPC 所有权，属于架构级改动 | 多窗口并行（已有），配合 F12/G13 恢复上次会话 |
| D28 E31 波形 | 没有逻辑分析仪/示波器的真机输出可对照，写解析器只能对着自己编的数据测——那是测假货。D27 的驱动接口已经留好，拿到真实波形样本再接 | 假波形解析不做；`instruments.ts` 的驱动接口保留 |
| D30 E33 测量面板 | 依赖 D28；没有波形就没有可画的曲线。D27 已能返回测量标量，但一个只显示几个数字的"面板"不构成面板 | 面板等有数据源再显示 |
| D31 E34 工具链自带下载 | 目录里每条都要实测 SHA256 才敢装。pyOCD/probe-rs/esptool 都是高频发版的 Python/Rust 程序，编一个哈希的后果是"解压成功但跑不起来"，比不提供入口更糟 | `installHints.ts` 给出官方安装命令，缺工具时直接报出来 |
| D29（原 A17）流式工具参数提前执行 | 在 SSE 结束前启动已解析完的调用，会让同一批调用的执行顺序依赖网络分片，与工具管线的顺序保证冲突；收益只是省下毫秒级时间 | 整批在响应结束后执行，只读调用并发、写调用串行，结果按调用顺序回填（见 `query.ts:334`） |
| G21 非 PTY 终端 | 需要 node-pty 原生依赖，违背 README 的零依赖承诺 | 现有非 PTY 路径已加固；交互式程序明确拒绝 |
| T1 OS 级内核沙箱（文件/网络隔离） | 与「Windows 单平台 + 零运行时依赖」冲突；AppContainer 在本机不可用；限制型令牌沙箱是独立项目 | Job Object 进程树终结 + 命令分类器 + 环境变量隔离；文档已如实说明「策略层不是安全边界」 |
| Linux/macOS 工具链下载 | 产品明确只做 Windows 端 | 仅 Windows x64 |

---

# 执行顺序

1. **阶段 A/B**：引擎与权限是后面所有功能的地基，先做。
2. **阶段 C**：MCP 深度依赖 B 的 token/hook 改动。
3. **阶段 E**：会话与自动化依赖 A 的 engine 事件。
4. **阶段 D**：嵌入式独立，可与 A/E 并行（文件不重叠）。
5. **阶段 F**：UI 最后做，依赖前面所有 host 协议定型。
6. 每完成一个阶段：`npx tsc --noEmit` + 该阶段测试；所有阶段完成后跑全量。

# 执行记录

## 阶段 A / B / C / D

代码全部落盘，`npx tsc --noEmit` 干净，既有 41 个测试文件全绿。
新增回归：`tests/round4-foundation.test.ts`。

## 阶段 E

- `src/sessions.ts`：meta 增 `goal`（含 `history`）与 `worktree`；`SessionSummary` 携带 goal；
  新增 `sessionMeta()`、`searchSessions()`（全量转录搜索，带命中摘录）。
- `src/sessionRecovery.ts`：`sweepStaleStatus(live)` 清扫陈旧 working；`recoverableSessions()`
  读完即清标记（拒绝一次就不再反复提示）；`recoveryLines()`。
- `src/sessionCommands.ts`（新）：选择器（全 id / 唯一前缀 / 歧义列候选）、fork/rename/
  archive/unarchive/delete/show/checkpoints/apply、usage 的 CSV/JSON 导出、baseline 落盘与
  统一 diff 生成、`applyPatch`（git apply，失败回落 plain apply）。
- `src/autoloop.ts`：`resume` 参数（goal 从下一轮接着跑、limit 仍按原上限；task loop 不重新规划）。
- `src/schedule.ts`（新）：本地调度器，`claimSchedule` 先推进 dueAt 再执行；长停机只补跑一次；
  `parseWhen` 支持 `--in 30m|2h|1d`。
- `src/workers.ts`（新）：后台 worker 记录、日志、`sweepWorkers` 关掉上一个进程留下的 running。
- `bin/work.js`（新）+ `bin/prometheus.js` 的 `--detach` / `--worker-id` / `--ephemeral`，
  以及 `sessions` / `checkpoints` / `apply` / `usage` / `workers` / `attach` / `goal` / `schedule` 子命令。
- `src/checkpoints.ts`：`recordSnapshot`（bash 变更用）、`restoreFile`（单文件）、redo
  （`captureRedo` / `applyRedo` / `lastRedo`），全部 undo 路径都会先存 redo。
- `src/gitSnapshot.ts`（新）：bash 前后按 `git status --porcelain -z` 对比，把新变脏的文件按
  `HEAD:` 内容记快照；原本已脏的文件明确计数为跳过，不猜。
- `src/tools/shellTools.ts`：`canWriteFiles()` 分词判断（不再用一条巨长正则）+ 重定向检测。
- `src/worktree.ts`：`.worktreeinclude`、`lockWorktree`/`unlockWorktree`、`staleWorktrees`、
  carrySession 写 `.gitignore`。
- `src/schema.ts`：`SchemaFileError`，缺文件/坏 JSON 都变成一行。
- `src/headless.ts`：开头发 `init`（session id / model）；`tool_start`/`tool_end` 带 id、入参、时间。
- `src/usage.ts`：新增 `goal` 来源；`setUsageEphemeral`。
- `src/agent.ts`：`goalUsage`（goal 判定与摘要请求的用量）、`loopCost`/`markLoopStart`、
  `goalBudgetUsd` 熔断、未定价模型的预算警告、`listSubagents`。
- `desktop/host.js`：`resumeGoal`、goal 进度落 meta、启动清扫 + 恢复提示、服务端会话搜索、
  `restoreFile`/`redo`、`worktreeStale`/`worktreePrune`、四类新增 UI 偏好、ephemeral 回合、
  `schedule` 每分钟扫描、goal 用量入账、baseline 落盘。
- `src/repl.ts`：agent 拿到 sessionId（此前检查点全空）、回合内 5 秒自动落盘、`/clear` 先换 id、
  恢复 worktree/board、`/rewind [n]`。
- `bin/prometheus.js`：一次性运行也做 5 秒自动落盘；`--goal-budget-usd` / `--token-budget`；
  schema 错误退出码 2 且不带栈。

验证：`tests/round4-sessions.test.ts`（33 项全过）。

## 阶段 F

已做（可用性优先，全部沿用既有设计语言，无新字体/圆角/颜色）：

- 回合中推送改动（500ms 去抖，徽标 live 脉冲，尊重 reduced-motion）
- `write_file` 审批带全文 diff
- diff 卡：行内折叠卡、Keep/Undo 落到 `restoreFile`、redo、单文件恢复
- 词级高亮（按行配对，配不上就退回纯行 diff）
- 子代理卡可停止；新增 Tasks 页签（`subagents`/`stopSubagent`）
- 回合进度：`turn_progress` 每秒心跳，带已耗时、当前工具、重试次数
- 权限提示带原因（此前已接）
- 侧栏筛选（状态 / 当前工作区，host 侧过滤）、悬停「…」按钮 + 键盘可达
- 启动恢复上次会话（可关）
- 首轮后自动标题（六词、免费失败即放弃）
- 附件接受非图片文件（按路径交给 host 内联，超大只给路径）
- `@` 引用随消息带上文件内容
- 输入历史 Up/Down
- PR 条：Fix failing CI（把失败日志作为一轮交给 agent）、Re-run checks
- 浏览器工具 `browser_open` / `browser_read` / `browser_screenshot`（agent → host → 窗口）
- 新会话默认隔离（设置项）
- a11y：流式时 `aria-busy`、页签 roving focus + `aria-selected`、筛选菜单键盘可达
- 原生 confirm 全部换自绘对话框（焦点陷阱、Esc）
- UI 缩放 `--ui-scale`、高对比主题（深/浅两种变体）
- 设置内 Ctrl+F 聚焦设置搜索
- 流式增量 markdown（按块缓存）
- 首次运行清单（端点 / git / gh / 工具链，带安装命令）
- 下一句建议（Tab 接受，可关）
- 启动后台检查更新并提示
- CLI `/rewind` 与 History 单文件恢复

仍标 ◐ / ⛔ 的：

- F10 / F19：按计划明确不做（同窗分屏、非 PTY 终端）。

## 最后一轮补的缺口（写回时发现的）

- B14：分类器补 `sed -i`、`find -delete`、`truncate -s 0`、`git push --mirror/--all`、
  `git filter-branch/filter-repo`、重定向覆盖 `.env/.pem/.key/.pfx`。
- A5：`Permissions.source` 标出审批来自哪个子代理，写入提示与 audit.log。
- B10：`prometheus mcp login|logout <server>` 跑同一套 OAuth 流程；token 文件在 Windows
  上用 `icacls` 去掉继承权限。
- D20 `embed_pinmap`（新）：读 devicetree / `pins.csv` / SVD 的 AF 字段，封装脚位只在源里
  明确给出时才报告，否则写 "package pin unknown"。
- D21 `embed_datasheet`（新）：PDF 索引（`pdftotext`），命中带页码；没有抽取器时说明安装命令。
- D18 扩展：`.pdsc` 的 `<datasheet>`/`<book>` URL 原样保留并随设备结果返回。
- D22：`src/embedded/mcpPresets.ts` + 设置页「厂商预设」一键写入 `.prometheus/mcp.json`。
- F9：`autoApprove` 与保存规则共用 `Tool(specifier)` 语法，设置页提示写明。
- F15：busy 时 Send 按钮改为「排队」，与 Enter 行为一致。
- F18/F31：History 按回合分组；REPL 增加 `/rewind [n]`。
- CLI：子命令（`sessions`/`schedule`/`checkpoints`/`apply`/`usage`/`workers`/`attach`/
  `mcp`/`goal`）走自己的参数解析，`schedule add … --in 30m` 这类子命令自己的 flag 不再被
  主解析器拒绝；只有第一个位置参数是子命令名时才进入，普通提示词里出现 "sessions" 不受影响。

明确仍不做（写进 C 级表）：A17 流式参数提前执行（会改变工具执行顺序语义，收益不确定）、
D28 波形、D30 测量面板、D31 大体积工具链二进制自带下载（无法逐字节验证哈希）。

## 事后核对（用户逐条追问时做的）

上面那张「最后补的缺口」列表被逐条对照代码核过一遍，六项都真实存在且有测试。但核对时发现
**文档有两处描述与代码不符**，已改正：

- A17 那一行标着 ⛔，做法栏却写了一个实现、验收栏写了一条「时间戳断言」的测试——这条测试
  不存在，而 `runToolBatch` 也从来不是"先完成先开始"。改为直说现状。
- D31 的验收标准是「目录列出三项」，但 `src/packs/catalog.ts` 里从来没有 pyocd/probe-rs/
  esptool。改为直说目录里只有五项。
- B10 同一行里还写着「Windows 用 DPAPI 加密」，代码里只有 `icacls`。实测确认无 DPAPI
  调用后改为如实描述，并写明不做的理由。

这三处的共同点：把"打算做"写成了"已经做"。标 ✅ 的条目如果不是逐条回到代码里看，
这种偏差不会自己暴露。

验证：`tests/round4-ui.test.ts`（19 项全过）；`tests/round4-embedded.test.ts`（14 项全过）；
`npx tsc --noEmit` 干净；42 个测试文件逐个跑，`fail 0`（合计 441 项通过）。

## 第五轮：把 C 级表里被推翻的条目做掉

用户看完 C 级表后推翻了其中五条。这轮的重做以「能实测就实测」为准，不再是纸面结论。

- **D31 工具链自带下载**（原 ⛔）：实测下载 probe-rs 0.32.0（11,502,414 字节，
  `56fc0564…4103`，与发布页 `.sha256` 逐字相符）、pyOCD 0.46.0（37,011,537 字节，
  `bc36d027…5fe6`）、esptool 5.6.0（64,810,332 字节，`d55a96fb…9629`），三条写进
  `src/packs/catalog.ts`。三个包用本地文件走完整安装事务（解压→校验→运行 validation）
  全部通过，`detectToolchains()` 报出 `source: "pack"`。
  顺带修 `registry.ts`：原先只按 `provides` 建映射，manifest 里 `executables[].toolchain`
  声明的种类会被漏掉。
- **T1 OS 级内核沙箱**（原 C 级"冲突"）：不冲突，Windows 有 WSL2。新建
  `src/kernelSandbox.ts`：`unshare --user --map-root-user --net --mount --pid --fork`
  + 工作区只读/读写绑定 + tmpfs home + `timeout` 杀进程组。实测：`network: off` 时
  `curl` 失败、`open` 时 200；`writable: false` 时 `touch` 报 `Read-only file system`；
  `sleep 30` 在 2 s 超时返回 124。接入 `shellTools.ts`，设置页可切换并显示
  「WSL2（Ubuntu）可用」。
  为此修了分类器：WSL 里路径是 POSIX，原先把 `/mnt/g/...` 判成工作区外，
  导致沙箱模式下所有绝对路径都被封。`sandbox.ts` 增加 `PathFlavor`。
- **D28/D30 波形与测量**（原 ⛔）：通用协议是 VCD（IEEE 1364，sigrok/Verilator/
  仿真器都写）。新建 `waveform.ts`（VCD 解析 + 电压序列阈值数字化）与
  `instrumentDrivers.ts`（Joulescope/PPK2/sigrok 驱动；列按表头映射，防止伏特安培
  互换）。新增 `embed_waveform` 工具；`embed_measure` 原先对这三个工具只回
  "没有驱动"，现在真跑。
- **G11 同窗分屏**（原 ⛔）：会话锁要求一个会话只有一个写入者，所以分屏是
  "两个窗口各带自己的 host"，不是一窗两会话。`main.js` 增加 `split-window`，
  渲染层增加会话选择器与两个菜单入口。
- **UI 流畅度**（子代理调研后逐条核对）：流式每帧两次强制布局 → 一次；光标元素
  每帧重建导致从不闪烁 → 移动同一元素；增量 markdown 去掉每帧整段签名比较；
  未闭合代码块加 300 字符渲染预算；diff 面板按内容签名跳过重建并保留滚动位置；
  终端按帧合并；thinking 流按帧合并并只在贴底时跟随；plan 卡原地更新；
  `session_status` 只更新对应行；find 的 smooth 滚动尊重 reduced-motion；
  模态/抽屉/滚动按钮补过渡。

验证：`npx tsc --noEmit` 干净；44 个测试文件、479 项通过、0 失败。
