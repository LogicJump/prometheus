# 计划：把已损坏的部分修好，再做深化

> **状态（2026-10-19，第三轮补完）**：阶段一、二、三，以及阶段四全部六项都已落地，
> 每条都有回归测试。第三轮复核后补掉了上一轮"只修一半"的 5 条，以及调研里
> 从未进过计划的 20 余条 P0/P1。测试数从 277 增加到 **370**（2 条按平台跳过）。
> 详见文末"第二轮补记"、"第三轮补记"、"第四轮补记"与"调研全量核对"。

> **调研全量核对（2026-10-19，HEAD 2f49a93）**：五份 gap 报告的 180 余条已逐条
> 回到源码核实，状态写回各自的"状态核对"段（✅ 已实现 / ◐ 部分实现 / ☐ 未实现）。
> 本计划只覆盖了其中的"会坏掉的部分"；调研里的其余条目**不是都做完了**。
> 汇总：核心架构 11/31 已实现，嵌入式 3/35，工具权限 8/35，UI 3/34，
> 会话自动化 5/28，早期 competitive-research 22/30。未实现的大头在
> 嵌入式调试深化（fault 解码、RTT、实时寄存器）、UI 审查闭环（Keep/Undo、
> 回合中改动推送）与子代理可寻址/任务面板。

日期：2026-10-19。来源是五路并行调研
（`.research/gap-core-architecture.md`、`gap-embedded.md`、
`gap-tools-permissions.md`、`gap-ui-interaction.md`、`gap-sessions-automation.md`），
每一路都读了真实代码、实测了本机安装的 Claude Code 2.1.193 / codex-cli 0.142.2，
并跑了最小复现脚本。

计划**不按调研报告的结构组织**。那些报告回答的是"我们和三家差什么"，
而这一轮要回答的是"哪里的代码现在是坏的、哪里的承诺是空的"。
两者重叠不大：调研里最响的几条（OS 级沙箱、LSP、Cmd-K、云执行）都不是 P0，
P0 全是能复现的 bug。

---

## 已亲自复核的事实（不是转述子代理）

以下七条我都回到源码确认过，行号是复核时看到的：

| # | 事实 | 位置 | 后果 |
|---|---|---|---|
| 1 | 只有历史为空时才写 system prompt | `agent.ts:90-92` | `-r` 恢复的会话、fork 出来的会话**没有系统提示词**——模式、规则、板卡信息全部丢失 |
| 2 | 无头模式的 `confirm()` 永远返回 `"no"` | `headless.ts:105-113` | CI 里 `npm install`、`git reset --hard` 这类命令静默失败，模型只能看到"被拒绝" |
| 3 | `worktreeDiff` 的 base 是字面量 `"HEAD"` | `worktree.ts:142` | `worktreeDiff` 命令先 `commitWorktree` 再 diff，**结果恒为空** |
| 4 | `agent.usage` 每次 `run` 归零 | `query.ts:114`、`agent.ts:470` | host 用它算每轮增量（`host.js:896`），第二轮起增量为负被夹到 0，**用量只记一轮** |
| 5 | `Always allow` 只进内存 Set | `permissions.ts:169`（已修） | 关窗口失效；`Saved approvals` 永远为空 |
| 6 | `ruleFromChoice` 被 import 但零调用 | `permissions.ts:10` | 同上的另一半：根本没有落盘路径 |
| 7 | `permission_choice` 的 UI 和宿主都写好了 | `host.js:382`、`app.js:1408` | 没有任何调用方——"记住这次批准的范围"这个界面永远不会出现 |

第 5、6、7 条指向同一个功能的三个断点，其中 5、6 已在 `4704394` 修掉，
7 在第二轮接线（见文末）。

---

## 阶段一：正确性（P0，全部有复现步骤）

这一阶段的判据是"用户能看见错误行为"，不是"代码不够优雅"。

### 1.1 会话恢复必须带系统提示词

`Agent` 构造时只在 `messages.length === 0` 时插入 system 消息。恢复会话时
历史非空，于是系统提示词永远缺席。

修法不是"把 system 塞进 messages 再存"——那样每次改模式都要重写历史。正确做法是
**渲染请求时把 system prompt 放在最前**，`messages` 只存对话。`agent.ts` 里
`refreshSystemPrompt` 已经存在，把它改成"改的是 prompt 字段"而不是"改 messages[0]"。

验收：`node bin/prometheus.js -r <id> --output-format json` 发出的请求体首条是
`role: "system"`；fork 同理。

### 1.2 无头模式要能授权

现在 `confirm()` 恒返回 `"no"`，等于 CI 里所有需要批准的工具都不可用。

需要：
- `--allowed-tools <list>` / `--dont-ask` 之类的显式开关
- 未授权的工具仍然拒绝，但拒绝理由要能区分"策略拒绝"与"无人可问"
- `--output-schema` 校验失败必须非零退出

验收：mock 端点上跑 `--dont-ask`，`bash` 调用被执行；不加时被拒绝且退出码非零。

### 1.3 worktree diff 的基准

`base` 存成 `"HEAD"` 是错的——它应该存**创建 worktree 那一刻的 commit sha**。
`git diff HEAD` 只显示未提交改动，而调用前刚 commit 过。

验收：worktree 里改一个文件 → `worktreeDiff` 返回非空的 unified diff。

顺带修 `host.js:1864` 的 `createAgent([])`：进入 worktree 会把对话清空，
用户看到的是历史消失。

### 1.4 用量记账

两个独立问题：
- `agent.usage` 每轮归零，host 的增量算法拿不到真实值
- CLI 完全不记账；fallback 模型的消耗记在 `config.model` 名下

修法：`query()` 返回本轮 usage，而不是覆盖一个字段；host 用返回值而不是做差。

验收：mock 端点跑两轮，`usage.jsonl` 里两条记录且金额正确。

### 1.5 中断留下 orphan tool_call

一批 2 个调用、第一个执行中 abort，消息序列变成
`assistant(calls=[a,b]) → tool(a)`，缺 b。下一轮原样发出，兼容端点通常 400。

修法：abort 时给未执行的调用补 `tool` 消息，内容说明"被中断，未执行"。

验收：复现脚本里 abort 后，`messages` 里每个 tool_call 都有对应 tool 消息。

### 1.6 流式失败丢 partial

已经推给用户的内容在 abort 后从 transcript 消失。

验收：abort 后 `messages` 最后一条是带 partial 内容的 assistant 消息。

### 1.7 网络错误不能判为 terminal

`TypeError("terminated")`（cause `UND_ERR_SOCKET`）和自家 timeout 都被
`classifyError` 判为 terminal，于是不重试、不降级。

验收：mock 端点第一轮断连、第二轮成功，客户端应自动重试而不是失败。

---

## 阶段二：安全边界（P0，可被利用）

### 2.1 junction / symlink 逃逸

`resolveSafePath` 只做词法检查。Windows 的 junction 能穿过去读到工作区外文件。

修法：解析后用 `realpath` 再判一次。注意 `realpath` 对不存在的路径会抛，
新建文件的检查要退回到父目录。

### 2.2 解释器绕过

`classifyCommand` 对 `python -c 'import urllib.request; ...'`、
`node -e 'http.get(...)'`、`cd / && cat etc/passwd` 全部返回 allow。
`networkPolicy: "proxy"` 没有任何实现分支。

这一条不该用"再补几个正则"解决——那是一场必输的军备竞赛。诚实的做法是：
- 把 `networkPolicy` 的未实现状态**明确暴露**给用户（现在它看起来是个可用的开关）
- 对解释器的 `-c` / `-e` 形式一律要求确认，而不是尝试判断脚本内容
- 文档里说清楚"策略层的沙箱是便利功能，不是安全边界"

### 2.3 嵌入式工具绕过沙箱

`embed_*` spawn 时继承完整 `process.env`，且不经过命令分类。

### 2.4 hooks 信任

项目目录里的 hooks 没有信任门槛——克隆一个仓库就可能执行任意命令。
Claude Code 和 Codex 都对 hook 做了一次性信任确认。

---

## 阶段三：嵌入式（差异化，但先止血）

### 3.1 J-Link 假成功（最严重）

`commandFor` 的 jlink 分支不使用 `firmware`，也没有 CommanderScript。
而 JLinkExe 连接成功会打印 `O.K.`，正好命中成功标记 —— **报告成功，实际没写**。

这一类错误比"功能缺失"危险得多：用户会带着没烧进去的固件去调试，
然后把时间花在错误的假设上。

### 3.2 只读工具会复位板子

`embed_serial` 标 `readonly: true`，但 `reset_on_connect` 用 DTR 复位。
plan 模式也放行。

### 3.3 SVD 的 FLASH/RAM 启发式

在本机 F429 上把 Flash **控制器**（`0x40023C00`）当成了 Flash **存储器**。

### 3.4 烧录器参数缺失

- avrdude 缺 programmer/part，工具层不暴露 `extra_args`，经工具调用必然失败
- `.uf2` 被接受但没有烧录器能写

### 3.5 四个空壳要么做要么删

`embed_measure` / `embed_waveform` / `embed_pinmap` / `embed_datasheet`
在设计文档里承诺过，代码里不存在。

建议**删掉承诺，而不是补空壳**：这些能力需要硬件（仪器）或大量知识工程
（手册索引），现在做只会是半成品。等有了 sigrok 或 datasheet 索引再回来。

---

## 阶段四：日常使用（P1）

按用户能感知的程度排序：

1. **Ask 模式是盲批**：批准前只看到 `edit_file: <path>`，没有 diff；
   Changes 面板只在回合结束更新
2. **单窗口单会话**，且同一会话可被两个窗口同时写同一个 JSONL
   （第二轮完成：单实例 + 会话锁，见文末）
3. **压缩丢原始目标**：trim 层直接删最早消息，`/compact` 只做关键字摘要
4. **工具输出只保头部 30k**，失败信息在尾部被丢且不落盘
5. **上下文计量漏掉 tools schema**（40 个 MCP 工具约 1.5 万 token 未计）
6. **CJK token 估算偏低 2–4 倍**

---

## 明确不做

来自五份报告的"不要抄"清单，合并去重后：

- 云执行、远程控制、定时任务（依赖托管基础设施）
- Agent teams / 多智能体编排（Codex 的线程树在这里是负担）
- 插件市场
- LSP 诊断、Tab 补全、Cmd-K 行内编辑（属于 IDE 形态）
- preserved-thinking 签名链（依赖特定厂商语义）
- 重写权限模型为 Claude Code 的四档（现有三档 + 可保存规则已经够用）

---

## 顺序与验收

**每个阶段结束都必须**：`npx tsc --noEmit` 干净、`node --test "tests/*.test.ts"`
全绿、并且**有一条能复现原 bug 的测试**——阶段一的每一条都应该先写出失败的
测试，再修。

阶段一和阶段二的 2.1/2.4 优先：它们让当前的错误结论变成正确结论，
而不是增加新功能。

阶段三的排序理由：3.1 和 3.2 是"工具对用户撒谎"，3.3 是"知识层给错答案"，
这三条的代价都比缺功能高。3.5 是减法，不占开发时间。

---

## 落地记录（2026-10-19）

每条都先写了一个在旧代码上失败的测试，再改实现使其通过。

| 条目 | 测试文件 | 做法 |
|---|---|---|
| 1.1 恢复会话带系统提示词 | `tests/round3.test.ts` | system 不再写进 `messages`，改为 `query()` 每次请求前渲染，历史里遗留的旧 system 在构造时丢弃 |
| 1.2 无头模式授权 | `tests/round3.test.ts` | 新增 `--allowed-tools` / `--dont-ask`；`Config.unattended` 让拒绝理由区分"策略拒绝"与"无人可问"；`--output-schema` 不匹配时非零退出 |
| 1.3 worktree diff 基准 | `tests/round3.test.ts` | `createWorktree` 记录分叉 commit sha；进入 worktree 不再清空对话 |
| 1.4 用量记账 | `tests/round3.test.ts` | `Agent` 保留 `usageBase` 与 `subagentUsage`，每轮累加而不是覆盖 |
| 1.5 中断留下 orphan tool_call | `tests/round3.test.ts` | abort 时为未执行的调用补一条"未执行"的 tool 消息 |
| 1.6 流式失败丢 partial | `tests/round3.test.ts` | abort 时把已推给用户的文本写回 transcript |
| 1.7 网络错误判为 terminal | `tests/round3.test.ts` | `classifyError` 递归读 `cause.code`，`terminated`/`UND_ERR_SOCKET`/超时都改为可重试 |
| 2.1 junction/symlink 逃逸 | `tests/round3-security.test.ts` | `resolveSafePath` 改为 `realpath` 判定；不存在的路径回退到最近存在的祖先 |
| 2.2 解释器绕过 | `tests/round3-security.test.ts` | 内联脚本一律 confirm；联网模块在 `network: off` 时 deny；`proxy` 明确报"未实现" |
| 2.3 嵌入式工具绕过沙箱 | `tests/round3-security.test.ts` | `toolEnv()` 基础环境改为 `sandboxEnv()`，只放行工具链前缀变量 |
| 2.4 hooks 信任 | `tests/round3-security.test.ts` | 项目 hooks 需在设置页确认；信任记录绑定文件哈希，改动后重新询问 |
| 3.1 J-Link 假成功 | `tests/round3-embedded.test.ts` | 生成 CommanderScript 并 `-CommanderScript`；没有写入证据时不再判成功 |
| 3.2 只读工具会复位板子 | `tests/round3-embedded.test.ts` | `embed_serial` 去掉 `reset_on_connect`，永远不置 DTR；旧参数传入时明确拒绝 |
| 3.4 烧录器参数缺失 | `tests/round3-embedded.test.ts` | avrdude 要求 `programmer`/`part`，esptool/avrdude 支持 `port`；`.uf2` 明确拒绝 |
| 3.5 四个空壳 | `tests/round3-embedded.test.ts` | 确认未暴露；设计文档待下一轮修订 |
| 4.1 盲批 | 手工验收（截图） | `edit_file` 批准前在终端和桌面端都显示将要改动的具体行 |
| 4.3 压缩丢原始目标 | `tests/round3-daily.test.ts` | 摘要固定保留"Original goal"，后续请求单独列出 |
| 4.4 工具输出只保头部 | `tests/round3-daily.test.ts` | `trimToolOutput` 保留头尾各一半，失败信息不再被截掉 |
| 4.5 计量漏掉 tools schema | 同上（`contextUsage`） | `contextUsage()` 计入 system prompt 与工具 schema |
| 4.6 CJK token 估算偏低 | `tests/round3-daily.test.ts` | `estimateTextTokens` 按字符区间区分 CJK 与 ASCII |

### 过程中发现、计划外修掉的

- **一次性 CLI 在 Windows 上必崩**：Node 24.15 上，两次以上 `fetch()` 后
  `process.exit()` 会触发 `uv async.c:76` 断言，结果是任务成功却以失败码退出。
  改为先让 keep-alive 套接字退场再退出。
- **一次性 CLI 的权限提示永久挂起**：`stdin` 是 ignore 时仍会打开 readline 提问。
  现在一次性运行一律按 `unattended` 处理。
- **`hook_status` 没进渲染层的转发列表**：设置页收不到状态。
- **`INLINE_NETWORK` 末尾的 `\b` 让 `require('https')` 等模式永不匹配**。
- **`embed_serial` 的 `useBoard` 会把面板上的 `assertDtr` 带进来**，已移除。

### 未完成

第二轮（见下）把这里的前三项做完了。留在这里作为记录：

- ~~4.2 单窗口单会话、两个窗口写同一 JSONL~~
- ~~3.3 SVD 的 FLASH/RAM 启发式~~
- ~~`docs/embedded-workbench-design.md` 里四个未实现工具的承诺~~
- ~~`permission_choice` 那套死 UI~~

---

## 第二轮补记（2026-10-19）

首轮明确留下的四项，这一轮逐个做掉。

### 4.2 会话并发写

问题不是"两个窗口能不能开"，而是**同一个会话能不能被两个进程同时追加**。
首轮把两个写入方的存在写进了 `sessions.ts` 的注释，却没有真正拦住。

做法：

- 新增 `src/sessionLock.ts`。锁是 `~/.prometheus/sessions/<id>/.lock`，
  用 `openSync(..., "wx")` 原子创建——这是各平台都有的独占创建语义。
  文件里记 `{pid, host, acquiredAt, label}`。
- **进程没了，锁就是死的**：`process.kill(pid, 0)` 判活，无效就清掉重取。
  崩溃不能把会话变成永远打不开。跨机器的锁不当活锁——pid 是每台机器自己的命名空间。
- **`saveSession` 会拒绝**：另一个进程持有锁时抛 `ForeignSessionWriter`，
  而不是默默追加。这是兜底：两个写入方交错追加会让 `messageCount` 和
  `lastHash` 与磁盘上的内容对不上，下一次写入就会误开新 generation。
- 三个写入方都先取锁：桌面 host（`newSession` / `loadSession` / `forkSession`）、
  CLI（`--resume`）、REPL（构造时与 `/resume`）。删会话前也检查锁。
- **单实例**：`app.requestSingleInstanceLock()`。两个窗口仍然支持（各自一个 host），
  但两次启动不行——第二次会加载第二份托盘、快捷键、更新检查，并互相覆盖
  `workspace.json`。第二次启动改为聚焦已有窗口。

测试：`tests/round3-session-lock.test.ts`（7 条 + 1 条权限范围）。其中"死锁被接管"
用 `pid 999_999_999` 模拟崩溃写入方；"另一个进程持有"用 `pid+1` 模拟窗口。

### 3.3 SVD 的 FLASH/RAM 判定

原实现按名字：`name === "FLASH" || name === "RAM"` 就当成存储器。

实测本机 113 个 STM32CubeProgrammer 附带 SVD：

- **108 个**有叫 `FLASH` 的外设，基地址全部是 `0x40023C00` 或 `0x52002000`
  （即 0x40000000 以上的外设空间），`<addressBlock><usage>registers</usage>`，
  寄存器是 ACR / CR / LATENCY——**这是 Flash 控制器**。
- **0 个** SVD 有 `<memory>` 元素（解析器写了支持，但从没被真实文件走过）。
- **0 个**名字含 flash/ram 的外设落在 code（<0x20000000）或 SRAM（0x20000000–0x3FFFFFFF）区域。

所以规则改成结构判定，不再看名字：

1. 地址必须在 code 区或 SRAM 区；外设空间里的一律是控制寄存器。
2. `<memory>` 元素直接采纳（schema 里它就是这么定义的）。
3. 地址块 `usage="registers"` 排除；剩下只认 `buffer` / `reserved` 之类。
4. 尺寸至少 4 KiB，控制器寄存器没有这么大。
5. 同一基地址只计一次（Cortex-M 的 SRAM 经常被列两遍）。

新增 `memoryTotals(device)`，`peripheralIndex` 与 `embed_registers` 都会先报存储器
大小，并且**在没有数据时明说"这个 SVD 没有建模存储器"**，而不是从外设里编一个数。

测试：`tests/round3-embedded.test.ts` 末尾三条。其中一条直接读本机真实
`STM32F429.svd`，断言 `FLASH @0x40023C00` 不被计入存储器。

### 设计文档里的空头承诺

`docs/embedded-workbench-design.md` 原来在工具清单里列了 `embed_measure`、
`embed_waveform`、`embed_pinmap`、`embed_datasheet`，UI 里承诺"波形 / 引脚图 / 测量面板"，
架构图里有 `instrument/` 目录。代码里这些都不存在。

改法是**删承诺**，不是补空壳：空壳工具比没有工具更危险，模型会以为自己测到了东西。
现在文档开头有状态说明，工具表把已实现的九个列出来、未实现四个划掉并说明原因，
架构图与分阶段逐项标注了交付状态。

### `permission_choice` 的死 UI

宿主和渲染层都写好了"记住这次批准的范围…（整个工具 / 仅这一次）"这个第二问，
但没有任何调用方——`Permissions.prompt` 收到 `"always"` 就直接把整个工具加进
内存 Set，界面上永远不出现这个选择。

补上之后还发现一个更深的问题：**"仅限这一次调用"从来没被兑现过**。旧代码无论选
哪个都会 `always.add(tool)`，也就是"只记这一次"实际等于"这个工具以后全放行"。

现在：

- `Permissions.prompt` 在 `"always"` 后调用可选的 `ui.ask`（`REMEMBER_SCOPE_OPTIONS`）。
- 选"整个工具"：加入会话级 Set + 写一条工具级规则。
- 选"仅这一次"：**不**加入会话级 Set，只写一条匹配该 summary 的规则。
  后续不同的命令仍然会问。
- 没有 `ui.ask` 的 UI（终端、无头）退回"仅这一次"——授权最少的那个默认。
- `ruleFromChoice` 在 detail 为空时把 note 写成 `bash: every call`，
  不再是断掉的 `bash: `。

测试：`tests/round3-session-lock.test.ts` 最后一条，含"第二个不同命令必须再问一次"。

### 过程中发现并修掉的

- **`SVD` 测试污染真实规则文件**：`Permissions` 会把批准的规则写进
  `~/.prometheus/rules.json`，我第一版测试直接写了进去。现在测试快照并还原该文件，
  且用随机命令名避免命中已有规则。
- **`sizes()` 被我的编辑弄成了单行**（`export function sizes(...) {  const ...`），
  tsc 能过但可读性极差，已还原。

---

## 第三轮补记（2026-10-19）：复核发现的残留

第二轮补完后做了一次逐条复核，发现"声称已修"里有若干只修了一半，
另有几条调研标为 P0 的从未进过计划。这一轮把它们全部做掉，测试数 313 → 335。

### 上一轮打折扣的

| 条目 | 问题 | 这一轮的做法 |
|---|---|---|
| 4.3 压缩丢原始目标 | 只有 summarize 路径保留目标；**trim 路径仍返回 `"(oldest turns trimmed)"`**，而自动压缩最常走这条路 | trim 也生成 recap（局部关键字摘要 + rehydrate），并补了专门走 trim 路径的测试 |
| 4.3 `/compact` | 仍调本地 `compactForce`，是全文最差的摘要；不支持 focus | `Agent.compactNow()` 走模型摘要、接受 `/compact <focus>`、触发同一套 hooks |
| 4.1 盲批 | 只修了 `edit_file` 的 diff；**bash 摘要仍优先 `description`**，可完全遮蔽真实命令 | 摘要以命令行为主体，description 只作为尾部提示 |
| 1.4 用量记账 | 只修了桌面端每轮归因；**CLI / REPL 完全不记账**，fallback 归因仍用 `config.model` | CLI 一次性运行与 REPL 每轮都写 `usage.jsonl`；`Agent.lastUsedModel` 读实际应答的模型 |
| 2.2 安全边界 | 内联解释器修了，**`cd / && cat etc/passwd` 与 `cat ../../…` 仍 allow** | 新增 `cdOutsideWorkspace`（cd 到工作区外后带相对路径 → deny）与 `..` 逃逸扫描 |

### 计划从未覆盖的 P0/P1

| 条目 | 做法 |
|---|---|
| D5 摘要只看最早 60k | `summarizerInput` 改为 20% 头 + 80% 尾，并声明中间被略过的条数 |
| MCP 资源索引错位（跨服务器读取） | 资源按服务器名查 client（`byServer`），不再用数组下标 |
| 工作区外受保护文件不设防 | `isProtectedPath` 改为绝对路径判定，并加入 `.ssh` / `.gnupg` / `.aws` |
| 无头 `sessionId` 为 null 但写盘用新 id | 先定 id 再跑：写盘、落盘引用、返回值用同一个 |
| 崩溃丢整个 turn | 桌面回合进行中每 5 秒增量落盘 |
| D10 工具串行 | 一批里连续的只读调用并发执行，写调用串行；结果按调用顺序回填 |
| D9 排队消息滞留 | 回合以纯文本结束时也 drain，排队消息成为下一轮而不是等下次输入 |
| D12/D13 子代理授权与成本 | 子代理继承父模式并走权限检查（不再 `auto + trusted`）；`usageBySource` 分 main/subagent/background 记账 |
| D14 cached token | 同时识别 `prompt_tokens_details.cached_tokens`、`prompt_cache_hit_tokens`、`cache_read_input_tokens`、顶层 `cached_tokens` |
| D15 默认 1M 窗口 | 默认改为 128K，可用 `PROMETHEUS_CONTEXT_WINDOW` 覆盖；沿用默认值时启动提示一次 |
| D16 thinking 不进历史 | assistant 消息保留 `reasoning_content`；只有 `echoReasoning` 打开时才回传（避免严格的网关 400） |
| D17 PreCompact 在压缩之后 | 改为压缩前触发，非零退出可取消压缩；`PostCompact` 在写回后触发 |
| D23 length 不续写 | `finish_reason: "length"` 时自动续写（最多 2 次） |
| D24 空响应不重试 | 空回复（无文本、无调用、无 reasoning）重试一次 |
| 工具输出不落盘 | 新增 `src/spill.ts`：超过 30k 的结果写到 `sessions/<id>/tool-results/`，消息里带路径 |
| 会话恢复不还原运行配置 | `SessionFile` 记录 mode/effort/sandbox/networkPolicy/board，恢复时应用（CLI/REPL/桌面） |
| `--continue` | CLI 新增 `-c/--continue`，续最近一个同目录会话（按活跃时间，不继承侧栏的置顶优先） |
| 会话列表硬上限 80 | host 分页发送 `{sessions,total,limit}`，侧栏有"再显示 N 个" |
| `Ctrl+Shift+E` 冲突 | 快捷键表把"切换 thinking effort"改为实际绑定 `Ctrl+E` |
| `--text-faint` 对比度 | 深色 `#6b7484 → #7d8797`，浅色 `#8b95a4 → #66707e`（达 WCAG AA） |
| 嵌入式 SVD 路径硬编码 STM32Cube/Keil | 改为 `PROMETHEUS_SVD_DIRS` + 项目 `.prometheus/svd/` + `CMSIS_PACK_ROOT` 递归查找 |
| `chipFromProject` 只认 STM32+PlatformIO | 改为从 PlatformIO / ESP-IDF / Zephyr / CMake 读候选芯片名，逐个找 SVD；找到的路径会报出 |

测试：`tests/gap-fixes.test.ts`（14 条）+ `tests/gap-fixes-2.test.ts`（8 条）。
复核 `--continue` 时又发现一个：`latestSession` 直接取 `listSessions()[0]`，而那个列表
把置顶会话排在最前，于是 `--continue` 会跳到最旧的置顶会话。改为按 `updatedAt` 重排，
`tests/jsonl.test.ts` 新增一条同时断言"侧栏仍然置顶优先"与"`--continue` 取最近的"。
顺带删掉了 `src/config.ts` 里没人调用、却仍写老单文件路径的 `saveSession`。

### 仍未做（明确记录，不含糊）

- **OS 级沙箱**：只做到了 Job Object 的进程树终结（见第四轮），没有文件/网络的内核级隔离。
- **终端不是 PTY**：需要伪终端库（原生依赖），与"零运行时依赖"冲突。已把非 PTY 路径做扎实：
  中断后重建 shell、busy 时拒绝交错命令、卡死有提示。交互式程序仍不可用，文档已写明。
- **UI 手动验收项**（新面板、串口、快捷键）需要在真实窗口里点一遍，
  自动化测试只覆盖了逻辑层。

### 第四轮补记（2026-10-19）：MCP 协议补齐、Job Object、终端止血

上一轮把四类问题列为"未做"。这一轮按它们的真实成本逐个处理：

**MCP（七项全部落地）**

| 条目 | 做法 | 测试 |
|---|---|---|
| `list_changed` | `settle`/`readSse` 把无 id 的 notification 交给回调；host 重新 list 该服务器并用 `Agent.replaceToolsByPrefix` 原位替换，顺带修掉"删掉的服务器旧工具还在" | `tests/mcp.test.ts` |
| `prompts/get` | 新增方法；host 的 `/name` 真正取回服务端消息，失败才退回模板 | `tests/mcp.test.ts` |
| 分页 | `nextCursor` 跟随，上限 50 页防死循环 | 同上 |
| 错误保真 | `rpcError` 保留 `code`/`data` | 同上 |
| 非文本内容 | image/audio/resource 报告为占位说明而不是 "(no output)" | 同上 |
| 工具延迟加载 | 超过 10 个 MCP 工具才延迟；`tool_search` 解锁；无延迟工具时搜索工具自动移除 | `tests/deferred-tools.test.ts` |
| elicitation | 声明 capability、路由 `elicitation/create`、经权限通道提问，无 UI 时明确 decline | `tests/mcp.test.ts` |
| OAuth | 新增 `src/oauth.ts`：challenge 解析、RFC 9728/8414 发现、动态注册、PKCE、刷新、令牌落盘（mode 600）；401 只重试一次 | `tests/oauth.test.ts`（9 条） |

**Windows 进程树（`src/winsandbox.ts`）**

`bash` 每次调用跑在一个 Job Object 宿主里，调用结束/超时/中断时 `TerminateJobObject`
结束整棵树。实测两个限制写进文档：宿主已在 job 里时分配会被拒（退回 `taskkill /T`）；
`start /b` 这类主动脱离仍能逃出。AppContainer 在本机不导出 `CreateAppContainerProfile`，
因此不提供该模式，设置页如实说明。

**终端**

调研实测发现三个真实缺陷，都不需要 PTY 就能修：

- **多行块会让面板永久 busy**。`if (...) {` … `}` 写进 `-Command -` 会让 shell 停在续行状态，
  紧跟的哨兵被当成块的一部分，命令和哨兵都不执行，之后只能 Restart。现在命令走
  base64 + `[ScriptBlock]::Create`，顺带解决了中文输入被按 936 代码页误解的问题。
- **stderr 中文乱码**：PowerShell 的错误流按控制台代码页编码。启动时设置
  `[Console]::OutputEncoding` 与 `$OutputEncoding` 为 UTF-8。
- **Stop 留下孤儿进程**：`child.kill()` 在 Windows 上是 `TerminateProcess`，只打到 shell。
  改用 `killTree`（`taskkill /T`）。
- 另外：ANSI 转义序列（颜色、清屏）此前原样出现在文本里，现在在切割哨兵前剥离；
  交互式程序（`vim`、REPL、`ssh`）直接拒绝并说明原因，而不是让用户等十分钟看门狗；
  中断立即标记 `exited`，下一条命令自动重建 shell；busy 时拒绝交错命令并提示；
  stdin 的 EPIPE 不再变成未捕获异常。

PTY 本身仍然不做：`node-pty` 会自动带 Windows prebuild，但 64 MB 的包体和第一个运行时依赖
推翻了 README 的公开承诺；`child_process` 无法驱动 ConPTY；自写绑定成本更高。
`README.md` 与 `desktop/README.md` 已补上与 `docs/reference.md` 一致的限制说明。

测试：`tests/mcp.test.ts`（13）、`tests/deferred-tools.test.ts`（5）、
`tests/oauth.test.ts`（9）、`tests/winsandbox.test.ts`（4，3 条 Windows 专用）、
`tests/terminal.test.ts`（12，3 条真 shell）。

**跑测试时抓到的一个真实泄漏**：`openJob()` 是异步的，一条几十毫秒就能跑完的命令
在 job 宿主就绪前就结束了，而清理逻辑只关"已存在"的 job，于是每个快速命令都留下
一个 PowerShell 宿主进程。症状是 `tests/agent.test.ts` 从 1 秒变成 200 秒
（runner 等所有子进程退出）。修法是加一个 `done` 标记：命令结束时置位，
之后就绪的宿主立即 `dispose()`。

