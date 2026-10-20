# UI 假完成审计（2026-10-20）

把历次调研里**标为已完成**的 UI 条目逐条回到代码核实，找出「渲染了但没接线」「有数据但没出口」「按钮在但底层必失败」的条目。

## 判定标准

| 标记 | 含义 |
|---|---|
| **REAL** | 入口 → handler → 命令 → 实现 → 回写 UI，五环齐全 |
| **HALF** | 链路存在但断在某一环 |
| **FAKE** | 只有文案/样式/函数定义，或点了必然失败 |

「函数存在」不算实现；判据是**用户能不能触发，触发后有没有真实行为**。

## 可复跑的机械检查

脚本在 `.research/`：`i18n-audit.cjs`、`dom-audit.cjs`、`dead-functions.cjs`。它们分别检查：
i18n 键是否有引用、index.html 的 `hidden` 元素是否有代码清除、renderer 函数是否有第二个引用。
命令/IPC 双向差集用内联 node 脚本做过一遍（渲染层 82 条 cmd 对 host 102 个 case、preload 27 成员对 main 23 个 handler），当时无缺。

---

## 一、点下去必然失败的按钮（最严重）

### 1.1 PR「Re-run checks」和「Fix failing CI」永远失败（FAKE，已实测）

- 按钮：`index.html:387-388`；handler：`app.js:4765-4773`；host：`host.js:3320-3342`。链路看着是全的。
- 断在底层 gh 调用：
  - `desktop/git.js:216` `gh run rerun --failed` —— **没有 run-id**。本机实测退出码 1：`` `<run-id>` or `--job` required when not running interactively ``。
  - `desktop/git.js:233` `gh run view --log-failed --limit 500` —— **`--limit` 不是 `gh run view` 的合法参数**。实测输出 `unknown flag: --limit`。
- 后果：点「Re-run checks」只弹一条 error notice；点「Fix failing CI」在 `failedCheckLog` 就返回 `ok:false`，`host.js:3337` 的 `runPrompt` 永远不可达——**失败日志从未交给 agent**。
- `desktop/git.js` 全文件没有从 check link 解析 run-id 的逻辑。

这是本次审计里唯一「连对照测试都不需要，命令行一跑就复现」的条目。

### 1.2 拖入非图片文件必然被拒（FAKE）

`app.js:4688` 用 `file.path` 取拖入文件的磁盘路径。Electron 44 已移除该属性，替代品是 `webUtils.getPathForFile`（`node_modules/electron/electron.d.ts:20399` 的注释明确写了 "superseded the previous augmentation to the `File` object with the `path` property"）。`desktop/preload.cjs` **没有暴露 webUtils**。

后果：`app.js:4690` 落到 `attachmentUnsupported`，所有拖入的 `.log`/`.md`/`.pdf` 都被拒。计划 F16「PDF/文本/日志拖入」在拖放这条路上是假的。

仍可用的替代路径：`+` 按钮 → `pickFile`（`app.js:5151-5157`）能拿到路径。

---

## 二、探针与目标板（用户点名的问题）

> **重要前提**：2.1–2.3 是**本轮工作区里未提交的面板改版引入的回归**，不是「从来没做过」。
> `git show HEAD:desktop/renderer/app.js` 的 `renderBoard()` 里有完整的探针列表、
> 串口端口列表、「加载目标」按钮和 `targetStatusNote()`。
> 改版为了「一个目标块」把这些整段删掉了，但 host 侧的数据管线一行没动。
> 所以修复不是从零实现，而是**把删掉的出口接回来**（探针、目标表、状态），
> 同时保留改版解决的「两个目标并列」问题。
>
> 其余各条（2.4 起）是原有缺口或本轮修复的残留，不是这次改版造成的。

### 2.1 探针列表被删掉（本轮回归）

HEAD 版本（`git show HEAD:desktop/renderer/app.js`，约 2965-2985 行）渲染每个探针：
```js
for (const probe of board.probes) {
  const id = probe.serial ? ` · ${probe.serial}` : "";
  const target = probe.target ? `${t.boardReported} ${probe.target}` : t.boardNoReportedTarget;
  row(probe.name || probe.kind, `${probe.kind}${id}`, "", target);
}
```

当前工作区版本里，`app.js` 对 `probes` 只剩两处用法：`2953`（判断有没有）和 `3049-3052`（一行「N 个探针」）。**名字、类型、序列号、它报的目标全部不显示，也没有选择控件。**

`BoardSelection.probe`（`src/types.ts:47`）仍然存在，`embed_flash`/`embed_debug` 接受 `probe` 参数（`embeddedTools.ts:278,653`）——但界面没有写入入口。

用户原话「连探测功能都没了」，成立，且是这次改版造成的。

### 2.2 目标表：按钮被删、数据无人读（本轮回归 + 原有缺口）

- HEAD 版本有 `#board-load-targets` 按钮（`index.html:430`）和它的 handler（`app.js:3154-3161`，发 `getBoardTargets`），`case "board_targets"` 也会回写按钮文字和 notice（`1707-1726`）。
- 当前版本：按钮从 HTML 删除（`round8-board-pane.test.ts:60` 主动断言它不存在），handler 删除，`case "board_targets"` 里的按钮操作也删除。
- 现在的 `case "board_targets"`（`app.js:1714-1727`）只把数据写进 `state.boardTargets` / `state.boardSuggested`，**全文件没有第二处读取**。
- `getBoardTargets` 在渲染层零调用。

后果：用户只能从 `targetOptions`（芯片识别推导出的少数候选）里选，206 条目标表打不开。

顺带说明：HEAD 版本其实也**没有**渲染完整目标表（`state.boardTargets.targets` 同样没人读），
「加载目标」只更新了一个计数 notice。所以这是「原来只有半个出口，现在连那半个也没了」。

### 2.3 `targetStatus` 展示被删掉（本轮回归）

HEAD 版本有 `targetStatusNote()`（`app.js:3049-3055`），把 exact/candidates/absent/unloaded 翻译成一句话，挂在目标行的 note 上。

当前版本该函数已删除；`app.js:3128` 仍把 `targetStatus` 存进 `state.boardTargetStatus`，但**没有任何渲染代码读它**（全文件只有声明 `124` 和赋值 `3128`）。

`tests/board.test.ts:33-62` 测的是后端计算，前端现在完全不用。

### 2.4 串口只能看不能写（原有缺口）

`host.js:2890-2899` 有完整的 `case "serialWrite"`，真调 `writeToPort`。渲染层 `serialWrite` **零调用**；串口工具栏（`index.html:434-470`）只有 Port/Baud/Start/Pause/Clear/Export/Follow，**没有输入框和发送按钮**。

agent 能通过 `embed_serial` 的 `write` 参数往串口写（`embeddedTools.ts:424`），人不能。

### 2.5 串口「选中发给 agent」不存在（计划写了、从未实现）

`plan-round4-full.md` D13 写了「UI『发给 agent』按钮」。代码里没有该元素、没有选中行逻辑、i18n 里也没有文案。

### 2.6 关于「面板改版本身」

改版解决的问题是真实的：HEAD 版本同时显示「板上实测芯片」和「保存的 target」两行，制造了一个不存在的冲突（`round8-board-pane.test.ts` 的注释说得很清楚）。

但改版把「证据」和「清单」一起删了：探针、端口、目标表、目标状态都不再显示，只留了一个从芯片推导出的目标名。**正确的方向是保留单一目标块，同时把探针列表和「换一个目标」的出口放回面板**，而不是靠删掉它们来消除冲突。

### 2.7 保存的 target 会盖过芯片答案，但面板标「从芯片读出」（本轮修复的残留缺陷）

`targetForIdentity()`（`host.js:1101-1114`）：
```js
const stored = selection?.target ? String(selection.target).toLowerCase() : "";
const chosen = options.find((name) => name.toLowerCase() === stored) ?? options[0];
return { target: chosen, options, source: "chip" };
```

只要保存的名字**恰好也在候选里**，它就会赢过表序第一项；而 `source` 仍固定写 `"chip"`。面板（`app.js:2970-2972`）于是显示：

> `stm32f439xg` · STM32F42x/43x · 1024 KiB · 由上方芯片推导，烧录用的就是它

**这是把一个存储值/表序选择说成了芯片结论。** 0x419 只能识别到 F42x/43x 家族（`identity.ts:110-117` 明确不猜具体型号），芯片本身分不出 F429 和 F439。

本机实测：`suggestTargets(0x419, 1MiB)` 返回 `["stm32f429xg","stm32f439xg","stm32f42xg","stm32f43xg"]`（按目标表顺序），而本机 `~/.prometheus/config.json` 当前存的是 `stm32f439xg`。

后果：这块 F429 板子会被写成 F439 并这样烧录——0x419 分不出来，但界面用「从芯片读出」的说法让人以为它分出来了。

（`stm32f439xg` 的来源未追溯：仓库源码和文档里都没有这个名字，应是某次运行时由候选列表写回的。）

正确做法二选一：
- 候选里有多项时，不要把 stored 当作芯片答案；面板应显示「家族确定，具体型号由你选」，并把候选列出来；或
- 保留 stored 优先，但 `source` 不能是 `"chip"`，证据行要写明「名字来自上次选择，芯片只确定到家族」。

### 2.8 串口下拉在直接打开 Serial 页时是空的

`fillSerialControls()` 读 `state.boardState?.ports`（`app.js:3229`），而 `state.boardState` 只由 `board_state` 事件写入。

`board_state` 只在三种情况下请求：打开 Board 面板（`2688`）、点 `board-refresh`（`3212`）、`embed_build` 之后（`2153`）。

`openSerialPane()`（`3219-3224`）自己只发 `serialStatus`，不触发扫描。`emitState` 也不带 ports。

后果：**直接打开 Serial 页签，端口下拉是空的**（显示 `boardNoPort`），Start 按钮点了静默返回（`3404-3405` 没有 port 就 return，无提示）。必须先开一次 Board 面板。

这就是用户说的「串口也没得选择」。

### 2.9 其他面板空缺（核实清单）

| 控件 | 状态 | 说明 |
|---|---|---|
| 波特率下拉 | HALF | 8 档静态值（`app.js:3216`）；**没有 change 监听**，改完不保存，只有改端口时才顺带写进 selection（`3476-3478`） |
| 串口「清空」 | HALF | `serialClear`（`host.js:2900-2904`）只清 UI 那份 `SerialLineBuffer`。agent 读的是 `serial.ts:550-560` 的 `recentLines`，**没有任何清空它的导出函数**——点「清空」后 agent 仍能读到旧行 |
| 串口等级过滤 | HALF | 只识别 Zephyr/ESP-IDF/`[ms]`/syslog 四种格式（`serial.ts:206-275`）；普通 `printf` 的 WARN/ERROR 识别不到，过滤形同摆设 |
| 串口输出区选中/发送 | MISSING | 只有 scroll 监听（`3455-3464`），没有选中行逻辑 |
| `serial_written` 事件无消费方 | 附带 | host 发（`2894`），渲染层 switch 里没有 case；因为渲染层从不发 `serialWrite`，所以目前不会触发，补输入框时要一起加 |
| 面板内烧录/擦除/清理按钮 | MISSING | `index.html` 全文件无此类控件；烧录只能让 agent 调 `embed_flash` |
| 面板内连接/断开探针 | MISSING | 无此控件 |
| J-Link 参与芯片识别 | MISSING | `host.js:1129` 只传 pyocd/openocd；`listProbes` 对 jlink 只写一条 note（`probe.ts:157-162`） |
| OpenOCD 识别 | HALF | `host.js:1083` 不传 `openocdTarget`，`identity.ts:305-310` 无 cfg 直接失败——只有装了 pyOCD 时识别才可能成功 |
| RAM 总量 | MISSING | 只显示用量（`app.js:3035`）；i18n `boardRamUnknown` 明说总量不从芯片读 |
| 识别结果的 device id / 哪根探针 | MISSING | 面板只显示家族名，`identity.probe` 未被使用 |

### 2.10 识别只在打开面板时发生

`identifyAttached` 挂在 `boardInventory()` 里（`host.js:1129`），只在 board scan 时跑。

应用启动、恢复会话、直接让 agent `embed_flash`，**都不会触发扫描**。此时 `config.effectiveBoard` 未设置，工具回落到 `config.board`（`embeddedTools.ts:107-109`）——也就是上一次保存的旧名字。

所以「工具用的是芯片读数」这个保证，只在用户打开过 Board 面板之后才成立。

### 2.11 恢复探针和目标表时必须遵守的既有约束

`tests/round8-board-pane.test.ts` 是当前面板形状的守门测试，恢复探针和目标表时不能撞上它：

| 约束 | 出处 | 含义 |
|---|---|---|
| 只有一个目标行 | `:28-35` | `t.boardTarget` 在 `renderBoard()` 里只能出现 1 次 |
| 不显示 `t.boardAttached` | `:32` | 芯片家族是目标的证据，不是并列的行 |
| 没有 mismatch 裁决 | `:37-42` | 不要恢复「保存的 target vs 实测芯片」两行对比 |
| unlisted 分支不得回退到 `effective.target` | `:44-51` | 芯片读到了但没有工具认识它时，不能显示保存的旧名字 |
| 不列全部工具链 | `:53-58` | `for (const tool of board.tools` 不能出现在 `renderBoard()` |

探针列表和目标表**不与这些冲突**：探针是「选哪个探针去读」，目标表是「换一个烧录名」，都不涉及「哪个才是目标」。但工具链清单不能在面板里恢复——它属于设置页。

数据侧无需改动：`boardStateCached()`（`host.js:1249-1260`）和 `emitBoardState()`（`1268-1290`）一直在发 `probes`/`probeNotes`/`ports`；`board.build` 也仍然由 `HostUi.toolDetail`（`443-457`）记录。缺的只有 `renderBoard()` 里那几十行渲染。

探针的形状（`src/embedded/probe.ts:24-32`）是 `{ kind, name, serial?, target? }`——足以渲染「名字 · 类型 · 序列号 · 它报告的目标」，并在 `serial` 存在时把它写进 `BoardSelection.probe`。这就是「选择探针」需要的最小信息。

后端已经完全就绪，三个烧录器都把 probe 接进了命令行：
- pyOCD：`--uid <serial>`（`src/embedded/flash.ts:209`）
- probe-rs：`--probe <serial>`（`232`）
- J-Link：`-SelectEmuBySN <serial>`（`243`）

也就是说，只要面板能把 `serial` 写进 `BoardSelection.probe`，`embed_flash`/`embed_debug` 就会用它选探针——不需要改任何后端代码。

本机实测（ST-LINK V2）：`pyocd list` 输出 `STM32 STLink  37FF71064E573436C88F1A43  n/a`，
经 `pyocdProbes()` 解析得到 `{ kind: "pyocd", name: "STM32 STLink", serial: "37FF71064E573436C88F1A43" }`，
`n/a` 被正确忽略。所以面板要显示的 `serial` 确实拿得到。

---

## 三、会话与恢复

### 3.1 侧栏状态筛选被 host 丢弃（FAKE）

渲染层 `app.js:5360-5366` 的 `sendSessionList()` 会带 `status` 或 `cwd`。

host `case "listSessions"`（`host.js:2737-2739`）只转发 `includeArchived` 和 `limit`——**`status`/`cwd` 被丢掉**。而 `sendSessions()` 里明明实现了过滤（`host.js:791-797`）。

即使修好这里，还有第二层问题：`host.js:853`（会话状态变化）、`1603`、`1860` 三处主动推送 `sendSessions()` 都不带过滤参数，会把筛选后的列表重置成全量。

### 3.2 启动恢复上次会话永远不触发（FAKE）

- `createAgent()` 内部就调用 `emitState()`（`host.js:1011`，函数体 `958-1011`），所以启动时 `state` 事件先到。渲染层 `case "state"`（`app.js:1678-1679`）会**立刻把 `prometheus.lastSession` 改写成新会话 id**。
- 随后 `ready` 到达时读 `lastSession`（`app.js:1634-1636`），此时它等于 `state.sessionId`，条件 `remembered !== state.sessionId` 恒假。

结论：**正常启动永远不会 `loadSession`**。F12/G13 的验收「重启回到上次」是假的。

附带：`state.restartSession` 从未被赋值（见 3.3），所以那个开关的显示也不可信。

### 3.3 设置页四个开关永远显示默认值（HALF）
`fillSettings()`（`settings.js:2041-2066`）从 host 返回的 settings 里回填了很多字段，但**没有**回填：
`restartSession`、`suggestions`、`updateCheck`、`isolateByDefault`、`uiScale`。

而 `settings.js:374/382/390/398/521` 读的正是 `state.restartSession` 等。这些 state 全仓库只有读取点、没有赋值点（机械扫描确认）。

后果：
- 用户关掉「启动时检查更新」，重开设置页又显示开；
- 用户关掉「下一句建议」，重开又显示开；
- 用户打开「新会话默认隔离」，重开显示关，再点一次只会再发 `true` —— **无法关闭已开启的默认隔离**。

### 3.4 自动标题没有开关，也没有「免费规则优先」（HALF）

- `host.js:1779` 的守卫只有 `!sessionTitle && !titleAttempted`，**没有任何 uiPrefs 判断**；设置页也没有这个开关。计划 F14 的「可关」不存在。
- `agent.proposeTitle`（`agent.ts:1031-1055`）直接 `this.client.chat(...)` 用当前模型，注释里写的 "cheap asks for the smallest model" 没有对应参数。计划 F14 的「免费规则优先」不存在。
- 六词限制只写在提示词里，代码只校验了长度 ≤ 80。

### 3.5 「排队」按钮没有视觉表达（HALF）

`app.js:900` 给发送按钮加 `.queues` 类，但 `styles.css` 里**没有任何 `.queues` 规则**。busy 时按钮既不换字也不换图标，用户看不出点击会排队。行为本身是对的（与 Enter 一致），只是没有表达。

### 3.6 消息级复制/重试/编辑三件套不存在（FAKE）

计划 F18 写了「消息复制/重试/编辑」。代码里只有代码块的复制按钮（`app.js:496-507`）。没有任何消息级 copy/retry/edit 按钮，也没有对应的 host 命令。

### 3.7 Rewind 只在重载的历史回合上出现（HALF）

`attachRewind()` 唯一的调用点是 `session_loaded` 的回放循环（`app.js:2472`）。`submit()`（`4449-4460`）调用 `addUserTurn()` 后**没有** `attachRewind`。

所以用户刚发出的那一轮，气泡上没有 rewind 按钮；必须切走再切回来才出现。这与 F31 的验收标准不符。

### 3.8 `@` 引用文件时插入字面 `\n\n`（bug）
`host.js:1663`：`return blocks.join("\\n\\n") + "\\n\\n" + text;`

在 JS 源码里 `"\\n\\n"` 是**反斜杠 + n 两个字符**，不是换行。用户用 `@` 引用文件时，消息里会出现四个可见的 `\n` 字符，格式坏掉（文件内容本身仍会到达）。

### 3.9 色盲主题完全没做（MISSING，计划 F25 三项之一）

`plan-round4-full.md` F25 G28 写的是「`--ui-scale`；高对比主题；色盲安全配色（保留现有语义色）」。

前两项有（高对比是 REAL，缩放有缺陷见 3.3）。色盲：全仓库搜 `daltonized`/`colorblind`/`deuteran`/`protan` **零命中**，主题列表里没有该选项，也没有配色校验脚本。这条从未实现。

---

## 四、子代理与进度

### 4.1 并行、后台子代理卡没有停止按钮（HALF）

`subagentStart` 只在 `agent.ts:1283`（`startSubagent` 路径）带 `{ id }`。并行路径（`1396`）和后台路径（`1444`）都不带 id。

渲染层 `app.js:1824` 用 `message.id` 决定是否渲染停止按钮，所以这两类卡上**没有停止按钮**，尽管 `stopSubagent` 命令和 host case 都存在。

### 4.2 渲染层只有一个子代理槽（bug）

`state.currentSubagent`（`app.js:114`）是单槽，`subagent_activity` / `subagent_end` 都只认它（`1855-1880`）。

并行两个子代理时：第二个 `subagent_start` 覆盖槽位 → 第一个卡永远收不到 activity/end。更糟的是 `subagent_end` 处理完会把槽置空（`1878`），**随后到达的第二个 end 撞上 `if (!sub) break`（`1872-1873`）被直接丢弃**，那张卡也停在 running，停止按钮不消失。

`subagentEnd` 本身也不带 id（`agent.ts:1327/1367/1417/1455`），无法定位到具体哪张卡——这是根因。

### 4.3 后台子代理不进 Tasks 面板（HALF）

`startBackgroundSubagent`（`agent.ts:1441-1468`）只调 `spawnSubagent`，不登记到 `this.subagents`，所以 `listSubagents()` 看不到它，Tasks 页签永远不显示后台任务。

### 4.4 `turn_progress` 的 `turns` 字段被丢弃（HALF）

host 每个心跳都发 `turns`（`host.js:431`），渲染层全文件没有 `message.turns`。另外 `progress.retry`（`app.js:365`）赋了值但 `renderProgress()`（`336-360`）不读。

---

## 五、diff 与审查

### 5.1 Keep / Undo / Revert 按钮根本不存在（FAKE，计划标 ✅）

`plan-round4-full.md` 的 F3 G3 写着：
> 做法：每个文件块加按钮；后端 `restoreFile`。
> 验收：点 Undo 只回滚该文件。

实际：
- `renderDiffFileList()`（`app.js:3590-3605`）每行只有一个 `<button class="change-row">`，点击只做「选中这个文件」。
- `renderChangesPanel()`（`3620-3632`）同理。
- `i18n.js` 里没有任何 keep/undo/revert 文案。

`restoreFile` 后端是完整的（`src/checkpoints.ts:262-291`，`host.js:3085-3098`），并且有真行为测试（`tests/round4-sessions.test.ts:134-198`）。**唯一缺失的是界面入口**，而入口正是这条验收的全部内容。

目前能回滚单个文件的唯一路径：History 页签 → 点文件行（`app.js:3720-3738`）。差异面板里没有。

### 5.2 History「按轮次恢复」也没做（FAKE）

F31 的验收写「History 增加按轮次恢复」。实际 `app.js:3709-3719` 只是给文件列表加了不可点击的分组标题（`checkpointTurn(messageIndex)`）。没有任何「恢复到这一轮」的按钮；轮次恢复只能靠 transcript 里的 rewind 按钮，而它在新回合不出现（见 3.7）。

### 5.3 bash 改动永远不进轮次 rewind（HALF）

`captureBashChanges` 签名有第四个参数 `messageIndex`（`src/gitSnapshot.ts:84-89`），但调用点 `src/tools/shellTools.ts:235`、`329` 只传 3 个参数。

根因不是漏传：`ToolContext`（`src/types.ts:242-263`）**根本没有 `messageIndex` 字段**，bash 工具无从知道自己是第几轮。所以 agent 用 `bash`/`mv`/`sed -i` 改的文件，任何轮次 rewind 都不会回滚。

### 5.4 diff 签名字段不存在，导致漏更新（bug）

`app.js:2849`：
```js
const signature = files.map((file) => `${file.path}:${file.additions}:${file.deletions}:${file.diff?.length ?? 0}`)...
```
`ChangeSummary`（`src/diff.ts:173-180`）**没有 `diff` 字段**，只有 `hunks`。所以 `file.diff?.length ?? 0` 恒为 0。

后果：同一文件「改了措辞但增删行数不变」时签名不变，`2850` 直接 return，**面板不更新**——显示的是旧内容。这不是「增量渲染」，是会显示过期数据。

### 5.5 命令面板没有焦点陷阱（HALF）

`openPalette()`（`4946`）只 `field.focus()`；keydown 只绑在 `palette-input` 上，处理 ↑↓/Enter/Esc，**不拦 Tab**。Tab 会走出面板进入背后页面。

`openSplitPicker()`（`app.js:4312-4364`）同样只有 Esc（`4350-4356`），没有 Tab 陷阱，尽管它用的是和 `confirmAction` 一样的 `.confirm-overlay` 结构。

`confirmAction()`（`928-975`）有正确的 Tab 陷阱和焦点恢复，说明项目里有现成实现，只是这两个地方没用。`askText()` 用的是原生 `<dialog>` + `showModal()`，焦点由浏览器管，没有问题。

### 5.6 board 菜单没有外部点击关闭，多个菜单没有 Esc（HALF）

- board 菜单（`app.js:3160-3212`）：只有 `board-picker` 的 click 切换，**没有 document click 监听**，只能再点一次按钮关闭。
- 全局 Esc（`4545-4568`）只处理 palette / find / settings / shortcuts / topbar / model / permission。**effort、board、mode、plus、usage、会话右键菜单**都没有 Esc 分支。

### 5.7 设置页删除操作没有确认（HALF）

`settings.js:1049`（删 MCP server）、`1205`（删 skill）、`1303`（删 memory）、`2034`（删规则）四处直接 `api.send`，没有确认。`confirmAction` 在 app.js 里，settings.js 拿不到，需要注入。

### 5.8 行内 diff 卡与 tool_output 抢节点（bug）

`tool_detail` 在 `tool_end` 之前到达（pipeline `:329` 早于 `:305`）。`attachInlineDiff` 用 `row.nextElementSibling` 定位并插入（`app.js:617`、`657`），随后 `state.lastToolNode = null`（`:658`）。

但 `tool_output` 的 `attachToolOutput`（`app.js:691-694`）会把行包进 `.tool-item`，改变兄弟节点结构；`lastToolRow()`（`670-672`）也因 `lastToolNode` 已清空而找不到行。

后果：并行工具或带输出的写工具，diff 卡可能挂错行或丢失。

### 5.9 词级 diff 不是 LCS，测试也不存在（HALF）

`decorateWordDiff`（`app.js:2799-2829`）按空白切词 + Set 交集标记，重复词会误标；超过 800 字符的行直接放弃（`:2813`）。功能可用，但不是注释里说的 LCS。

`tests/round4-ui.test.ts` 文件头声称覆盖 "the word-level diff decoration"，但全文件没有任何 `decorateWordDiff` / `word-add` 测试。

### 5.10 pending diff 只显示 40 行

`renderPendingDiff`（`app.js:5031-5087`）用集合差而非 LCS，且上限 40 行。大文件 `write_file` 的批准弹窗只显示前 40 行变更，不是计划写的「全文 diff」。

### 5.11 长行横向滚动不完整

`.diff-line` 是 flex（`styles.css:1004-1007`），`.diff-text` 带 `flex: 1; min-width: 0`（`1034-1039`），长行在自身盒子里被压/裁，不是整行横向滚动。全文件没有 `min-width: max-content`。

---

## 六、浏览器与 worktree

### 6.1 `browser_open` 开了页面但用户看不见（HALF）

`app.js:2119-2120`：
```js
if (request.kind === "open") {
  await api.browserOpen(request.url);
  result = { ok: true, url: request.url };
}
```
没有 `openWorkbench("browser")`，没有 `scheduleBrowserBounds()`。用户手动路径（`3894-3905`）两者都有。

后果：页面在后台被创建，但面板不打开、bounds 不下发。工具描述里「the pane stays open for them to see」不成立。

**推断（未实测）**：`browser_screenshot` 多半会拍到未布局的空白，因为 `setBrowserBounds` 从未被调用。要确认这条需要真开一次面板截图。

### 6.2 `browser_screenshot` 的结果 agent 拿不到图（HALF）

`main.js:508-518` 真存 PNG 并返回路径，但工具结果通道只有文本（`ToolResult.content: string`）。agent 只能看到路径，`browserTools.ts:105` 承诺的「从下一轮的图里描述布局」做不到。

### 6.3 worktree 位置「可配置」是假的（HALF）

设置页 `settings.js:997-1002` 那一行长得像设置项，实际是只读 `<code><repo>/.prometheus/worktrees</code>`。`src/worktree.ts:178` 硬编码 `join(top, ".prometheus", "worktrees")`，没有配置键。F22 的「位置可配置」不存在。

### 6.4 启动时的首个会话不隔离（HALF）

`enterDefaultWorktree()` 只挂在 `newSession` / `/clear` 路径（`host.js:675`、`2651`、`587`）。启动时 `createAgent([])`（`2046`）之后没有调用它。所以「新会话默认隔离」对**应用启动后的第一个会话**不生效。

### 6.5 split-window 窗口可能超出屏幕（小 bug）

`main.js:381-391` 子窗口 `x = screen.x + width/2`，`width = max(640, screen.width/2)`。父窗口本身只占屏幕一部分时，子窗口会被推到父窗口右侧之外。

---

## 七、更新检查

### 7.1 `#check-update` 元素不存在（FAKE）

`app.js:197` 和 `5701` 两处查 `$("check-update")`。`index.html` 里**没有这个 id**（全仓 grep 只在 app.js 出现）。

后果：F30 的「标题栏提示」不存在，发现新版本时只有一条 transcript 里的 dim notice。`state.updateAvailable`（`5699`）也没有第二个读取点。

### 7.2 默认永远 unconfigured

`main.js:537-538` 要求 `PROMETHEUS_UPDATE_URL` 环境变量，仓库里任何配置都不设它。默认启动静默返回，什么都不显示。

---

## 八、i18n 与死代码

### 8.1 61 个 i18n 键定义了但无引用

`.research/i18n-audit.cjs` 可复跑。其中一整批是 Board/Serial 改版后的残留：
`boardLoadTargets`、`boardLoadingTargets`、`boardTargetsLoaded`、`boardEvidence`、`boardToolchains`、`boardNone`、`boardInstalled`、`boardProbes`、`boardReported`、`boardNoReportedTarget`、`boardPorts`、`boardSelection`、`boardTargetsUnloaded`、`boardTargetExact`、`boardTargetCandidates`、`boardTargetAbsent`、`boardAttached`、`boardTargetFromChip`、`boardTargetNothing`、`boardLastBuild`、`serialResume`

**这批键在 HEAD 版本里全部还在用**（`git show HEAD:desktop/renderer/app.js` 的 2941/2965/2983/2997/3028 行）。它们是本轮面板改版删掉的那些行的文案，数据结构也都还在（`board.probes`、`board.ports`、`board.tools`、`board.build` 仍然从 host 发来）。

所以这批「死键」不是垃圾，是**待恢复界面的现成文案**——恢复探针/端口/目标表/最近构建时可以直接用，不必重写。

### 8.2 中文块重复键

`i18n.js:855-856` 里 `askMultiHint` 定义两次，第一行是英文（`"You can choose more than one."`）。当前显示正确（第二行中文覆盖），但是重复键。

### 8.3 死函数

- `renderTree()`（`app.js:3742`）零调用，且读的 `state.tree` 从不被赋值。Files 面板实际走 `case "tree"`（`1797-1802`）。
- `openBrowserPane()`（`app.js:3894`）零调用，实际走 `openWorkbench("browser")`。
- `settings.js:2188-2197` 导出的 `close` / `isOpen` / `handleKey` 三个成员全部零调用（app.js 用了 `open/openSetup/refreshVersion/applyLocaleChange/handleEvent`）。设置内 Ctrl+F 实际由 `app.js:4580-4591` 的重复实现完成。

### 8.4 两套 i18n 体系混用

规则列表的空态文案用 `t.rulesEmpty`（i18n.js），分组标题用 `s.groupRules`（settings-i18n.js）。同一块界面两种来源，切语言时一个自动更新、一个要重建页面。

`settings-i18n.js` 里另有 5 个键从无引用：`autoApproveDesc`、`kernelSandboxDesc`、`kernelSandboxAbsent`、`rulesTitle`、`noRules`。其中 `autoApproveDesc` 写的是「逗号分隔的工具名」，与现在统一后的 `Tool(specifier)` 语法已经不符——留着它是个陷阱。

### 8.5 首次运行清单的 `action` 字段无人消费
`host.js:2787` 给「API 未配置」带 `action: "setApiKey"`，`2801` 给「gh 未装」带 `action: "installGh"`。渲染层 `app.js:1655-1666` 只读 `label/detail/hint`，**从不读 `action`**。

后果：这两行只是文字，不能点。gh 那条连 `hint` 都没有，全仓也没有 gh 的安装命令（`installHints.ts` 只覆盖 pyocd/probe-rs 等工具链）。

### 8.6 `autoApprove` 与保存规则仍是两套（HALF，计划 F9 声称已合并）

`plan-round4-full.md` F09 G10 的方向是「autoApprove 与 rules 共用一套」。实际：

- 语法确实统一了（都接受 `Tool(specifier)`），设置页的提示文案也改了（`settings.js:923` 用 `s.autoApproveRulesHint`）。
- 但**两套输入并存**：设置页仍有逗号分隔的 autoApprove 输入框（`settings.js:918-934`），下面才是规则列表（`:948-957`）。
- 权限层也是分开读的：`permissions.ts:176` 把 autoApprove 塞进 `this.always`，`:289` 单独做 spec 匹配；`rules.ts` 是另一个来源。

没有迁移代码把 autoApprove 转成 ApprovalRule。所以「只有一套」没有达成——只是「两种语法长得一样」。

---

## 九、核实为真实完成的（不要重复劳动）

| 条目 | 证据 |
|---|---|
| 回合中推送改动（write/edit 路径） | `host.js:247,270-278,305`；`recordChange` 挂在 `agent.onBeforeMutate`（`963`）；渲染 `case "changes"`（`1776`） |
| 行内 diff 卡 | `app.js:614-670` 构造、`2153-2159` 挂载；数据 `pipeline.ts:320-340` |
| 词级 diff（可用，非 LCS，无测试） | `app.js:2790-2833`，`renderDiff` 与 `attachInlineDiff` 都用；缺陷见 5.9 |
| History 按文件恢复 + redo | `app.js:3690-3707`；host 三个 case 齐全；`tests/round4-sessions.test.ts:134-198` 真测 |
| 权限条批准前显示 diff（write_file 也有） | `pipeline.ts:191,388-396` → `permissions.ts:347-353,419` → `host.js:489` → `app.js:2268-2271,5031-5087` |
| 子代理卡展开（单条路径） | `app.js:1826-1839` |
| 回合进度三项（耗时/工具/重试） | `host.js:423-437` → `app.js:2387-2400`，字段全用 |
| 首次运行清单内容 | `host.js:2772-2815` 真跑 git/gh/detectToolchains |
| 下一句建议 | `app.js:849-870` + `2430`；Tab 接受 `4524`；可关（读取 `prometheus.suggestions`） |
| 流式 `aria-busy` | `app.js:883` |
| 自绘确认框 + 焦点陷阱 | `app.js:928-975`；renderer 目录原生 `confirm(` 残留 **0 处** |
| 工作台页签 roving focus + aria-selected | `app.js:2639-2647`、`5565-5577` |
| 高对比主题（深/浅两变体） | `app.js:4397-4406`、`styles.css:91-150`；注册进设置页与顶栏 |
| 流式增量 markdown | `markdown.js:105-180`，有行为级测试（`round4-ui.test.ts:21-58/255-282`） |
| 光标复用同一元素 | `app.js:455-461`、`2052` |
| 终端按帧合并 | `app.js:2722-2742` |
| thinking 流按帧合并且贴底才跟随 | `app.js:732-748` |
| plan 卡原地更新 | `app.js:789-843` |
| `session_status` 只更新对应行 | `app.js:2517-2548` |
| find 滚动尊重 reduced-motion | `app.js:1054-1060` |
| 模态/抽屉/滚动按钮过渡 | `styles.css:4742-4781`、`4956-4961`、`3743-3765` |
| 会话悬停「…」菜单 | `app.js:4217-4237`，click + Enter + Space |
| 浏览器工具全链（除两条半成品） | `browserTools.ts` 真发请求；host→renderer→preload→main 全通；`browser_read` 真取 `innerText` |
| split-window 两个入口 | `index.html:120-123`、`app.js:4272`、`4312-4363`；每窗口独立 host |
| 非 PTY 终端加固 | `terminal.js`：ANSI 清除、哨兵、base64、EPIPE、交互拒绝、看门狗、killTree；`terminal.test.ts` 有真实 PowerShell 测试 |
| UI 缩放（部分） | `--ui-scale` 被 `--text-*` 消费；设置项写入 localStorage 并即时生效；缺陷见 3.3 |

---

## 十、修复优先级

| 优先级 | 条目 | 理由 |
|---|---|---|
| P0 | 1.1 PR 两个按钮、1.2 拖放 | 点了必然失败/必然被拒，是最直接的「假按钮」 |
| P0 | 2.1 探针列表、2.2 目标表、2.3 targetStatus | 用户点名；且是**本轮未提交改版引入的回归**，HEAD 里有现成实现可对照恢复 |
| P0 | 2.7 存储值冒充芯片结论、2.8 串口页无端口、2.10 不扫描就用旧值 | 直接对应「识别的芯片不对」和「串口没得选择」两个现象 |
| P0 | 3.2 启动恢复、3.1 侧栏筛选 | 功能声明存在但完全不生效 |
| P1 | 5.4 diff 签名漏更新、5.8 行内 diff 抢节点 | 会显示过期数据或挂错行，比不显示更坏 |
| P1 | 5.1 Keep/Undo 按钮、5.2 History 按轮恢复 | 计划标 ✅ 但入口从不存在 |
| P1 | 2.4 串口写入、2.5 发给 agent | 串口监视器缺了「说」的一半 |
| P1 | 3.7 rewind 实时挂载、3.8 字面 `\n` | 前者是计划验收项，后者是格式 bug |
| P1 | 4.1 并行/后台无停止、4.2 单槽覆盖 | 多子代理场景下卡永远停在 running |
| P1 | 6.1 browser_open 面板不打开 | agent 以为用户看得见，实际看不见 |
| P2 | 3.3 开关不回填、3.4 自动标题可关 | 设置项显示与实际不符，用户无法撤销 |
| P2 | 5.5 面板焦点陷阱、5.6 Esc/外部点击、5.7 设置删除确认 | 一致性问题 |
| P2 | 7.1 更新提示常驻位、8.5 清单 action、8.6 autoApprove 合一 | 功能半成品 |
| P2 | 6.3/6.4 worktree 位置与首会话 | 声明与实现不符 |
| P3 | 八、i18n 死键与死代码 | 不影响用户，影响下次改动 |

---

## 十一、方法与限制

- 每条结论都有 `文件:行号`，引用前都读过该行。
- 1.1 的两个 gh 调用做了命令行实测（gh 2.92.0），错误信息与退出码已记录。
- 判定「无第二处读取」用的是全文件正则扫描，不是目测。
- **区分「从未做过」与「做过又被删」**：第二章和 8.1 用 `git show HEAD:` 对照过，
  确认探针列表、目标表按钮、targetStatus 文案在本轮改版前存在。其余章节没有逐条做历史对照，
  只陈述当前代码的事实。
- 本机做过实测的：`gh run rerun --failed` 与 `gh run view --limit` 的真实报错（gh 2.92.0）；
  `pyocd list` 的真实输出与 `pyocdProbes()` 的解析结果；`suggestTargets()` 对 0x419 的真实返回；
  本机 `config.json` 里实际保存的 target。
- **未验证**的：多探针同时插入时面板的行为（只有一根 ST-LINK 可测）；
  `browser_screenshot` 在面板未布局时拍到什么（需真跑一次）。
  这两条在文中标为推断。
- 5.1、5.2 的判定依赖「差异面板里没有按钮」这一事实，已用全文件搜索确认；
  但「当初是否打算做成那样」只能从计划文本推断。
- 测试覆盖普遍很薄：上述 HALF/FAKE 条目里只有流式 markdown、`restoreFile`、`restoreAfterMessage`
  有行为级测试，其余是零覆盖或只断言字符串存在。
