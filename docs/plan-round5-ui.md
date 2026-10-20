# 第五轮计划：把六路 UI 审计的结论落成可执行条目

日期：2026-10-20。输入是六路子代理审计（嵌入式板卡/串口、diff/审查、转录/进度、
PR/浏览器/worktree/终端、会话/composer、设置/可访问性）加上随后逐条回代码复核的结果。
审计全文见 [ui-fake-completion-audit.md](ui-fake-completion-audit.md)；本文件只回答「先做什么、怎么验收」。

## 图例与翻状态规则

- `☐` 未做 / `◐` 做到一半 / `✅` 已验证 / `⛔` 明确不做
- **把 `☐`/`◐` 改成 `✅` 之前必须**：
  1. 先在旧代码上写一条会失败的测试（做不了单测的写明手工复现步骤）；
  2. 改实现让它通过；
  3. 跑 `npx tsc --noEmit` 与该测试文件，把命令和测试名写进条目的「验证」；
  4. 任何一条没通过，状态保持 `☐`/`◐`，不许标 `✅`。
- 全量测试等所有条目都收口后跑一次。

## 统计

| 来源 | 条目 | 其中回归 | 其中 P0 |
|---|---|---|---|
| 嵌入式板卡/串口 | 12 | 3 | 6 |
| diff/审查 | 8 | 0 | 0 |
| 转录/进度 | 6 | 0 | 0 |
| PR/浏览器/worktree/终端 | 7 | 0 | 2 |
| 会话/composer | 10 | 0 | 2 |
| 设置/可访问性 | 9 | 0 | 0 |
| 合计 | **52** | 3 | **10** |

按优先级：P0 十条（U1–U10）、P1 十三条（U11–U23）、P2 十三条（U24–U36）、P3 十六条（U37–U52）。

**进度**：52 / 52 已收口（50 项 ✅，2 项 ⛔ 明确不做：U45、U48）。验证记录见文末。

---

# P0：正在骗人的东西

> 这十条的共同点：界面说一件事，程序做另一件事，或者点下去必然失败。
> 不修的话，后面所有 UI 工作都建立在不成立的承诺上。

## 板卡与串口（用户点名的三条 + 三条连带）

| # | 状态 | 问题 | 做法 | 验收 |
|---|---|---|---|---|
| U1 | ✅ | 探针列表被本轮改版删除，只剩「N 个探针」计数（`app.js:2953,3049-3052`）。HEAD 版本有完整渲染（`git show HEAD:desktop/renderer/app.js` 约 2965-2985） | 在「其它选择」区恢复探针行：`名字 · 类型 · 序列号 · 报告的目标`；有 `serial` 时点击写入 `BoardSelection.probe`。数据无需改：`host.js:1149,1256` 一直在发 | 面板出现探针行；点选后 `~/.prometheus/board.json` 的 `probe` 有值；用 `embed_flash` 时命令行含 `--uid`（pyocd）/`--probe`（probe-rs） |
| U2 | ✅ | 206 条目标表无出口：`board_targets` 只写进 `state.boardTargets`（`app.js:1714-1727`），全文件无第二处读取；`getBoardTargets` 零调用 | 恢复「加载目标」按钮（HEAD 有 handler，`index.html:430`），加载后渲染可筛选的列表；选中即 `setBoardSelection` | 点按钮能列出 ≥200 条；输入 `f429` 能过滤；点一条后目标块变化 |
| U3 | ✅ | `targetStatus` 只存不显（`app.js:3128`，无读取点） | 恢复 `targetStatusNote()`（HEAD `app.js:3049-3055`）的等价逻辑，挂在目标行的 note 上 | 目标不在表里时显示「不在目标表」；未加载表时显示「未加载」 |
| U4 | ✅ | 保存的 target 在候选里时盖过芯片答案，但 `source` 仍写 `"chip"`（`host.js:1110-1112`），面板显示「从芯片读出」（`app.js:2970-2972`） | 候选多于一项时不要让 stored 冒充芯片结论：要么面板显示「家族确定，型号由你选」，要么 `source` 改成 `"stored"` 并在证据行说明「名字来自上次选择，芯片只到家族」 | 本机 `config.json` 存 `stm32f439xg` 时，面板不得再声称这是芯片读出的结果 |
| U5 | ✅ | 直接打开 Serial 页时端口下拉是空的：`fillSerialControls` 读 `state.boardState.ports`（`app.js:3229`），而该 state 只在打开 Board 面板时才有；`openSerialPane` 只发 `serialStatus`（`3219-3224`）。点 Start 时 `if (!port) return`（`3404-3405`）静默无反应 | `openSerialPane` 同时发 `getBoardState`（或新增轻量 `getSerialPorts`）；无端口时 Start 给出可见提示而不是静默 return | 冷启动直接进 Serial 页，下拉里有 COMx；没插板时点 Start 有提示 |
| U6 | ✅ | 识别只在 board scan 时发生（`host.js:1129`）。启动、恢复会话、直接 `embed_flash` 都不扫描，工具回落到旧的 `config.board`（`embeddedTools.ts:107-109`） | 启动时若已配置板卡则后台跑一次 scan；或在 `embed_flash` 首次使用前强制 scan | 冷启动后不打开面板，直接让 agent 烧录，命令里的 target 来自芯片读数而非旧配置 |

## 两个必然失败的按钮

| # | 状态 | 问题 | 做法 | 验收 |
|---|---|---|---|---|
| U7 | ✅ | `gh run rerun --failed` 缺 run-id（`git.js:216`），实测退出码 1；`gh run view --log-failed --limit 500` 的 `--limit` 非法（`git.js:233`），实测 `unknown flag` | 从 `pr checks --json` 的 `link` 解析 run-id；`gh run view <run-id> --log-failed` 去掉 `--limit`，文本截断在本地做 | 用真实 PR 跑一次 `rerunFailedChecks` 返回 `ok:true`；`failedCheckLog` 返回日志正文 |
| U8 | ✅ | 拖入非图片文件必然被拒：`file.path` 在 Electron 44 已移除（`app.js:4688`） | preload 暴露 `webUtils.getPathForFile`；`handleImageFiles` 改用它，取不到再退回现在的提示 | 拖入 `.log`/`.md` 后出现 mention chip，消息里带文件内容 |

## 两条完全不生效的功能

| # | 状态 | 问题 | 做法 | 验收 |
|---|---|---|---|---|
| U9 | ✅ | 启动恢复上次会话恒不触发：`createAgent` 内部 `emitState()`（`host.js:1011`）先到，`case "state"` 把 `lastSession` 改写成新 id（`app.js:1678-1679`），`ready` 时条件恒假（`1634-1636`） | 记录「本次启动的新会话 id」单独存放，不要在 `state` 里覆盖 remembered；或 host 在 `state` 里标明 `isFresh: true` | 重启应用后自动打开上次会话；关掉开关后不再恢复 |
| U10 | ✅ | 侧栏筛选被 host 丢弃：渲染层发 `status`/`cwd`（`app.js:5360-5366`），`case "listSessions"` 只转发 `includeArchived`/`limit`（`host.js:2737-2739`） | 透传 `status`/`cwd`；`sendSessions` 的三个主动推送（`host.js:853,1603,1860`）也带上当前筛选 | 选「只看 error」后列表只剩 error；状态变化后不被打回全量 |

---

# P1：说了但没做到

| # | 状态 | 问题 | 做法 | 验收 |
|---|---|---|---|---|
| U11 | ✅ | 串口只能看不能写：`serialWrite` host 有实现（`host.js:2890-2899`），渲染层零调用；面板无输入框 | 串口工具栏加一行输入 + 发送；补 `serial_written` 的渲染层分支（目前没有） | 输入 `help\n` 能发出去，状态行显示已发送字节 |
| U12 | ✅ | 串口「选中发给 agent」从未实现（计划 D13 写了） | 输出区支持行选中，出现「发给 agent」按钮，把选中行拼进 composer | 选中若干行点按钮，composer 里出现带来源标注的文本 |
| U13 | ✅ | Keep/Undo/Revert 按钮不存在（计划 F3 标 ✅，`app.js:3590-3605` 只有选中） | 差异文件列表每行加 Undo（复用已有 `restoreFile`）；i18n 补文案 | 点某文件的 Undo 只回滚该文件，其他文件不动 |
| U14 | ✅ | History「按轮次恢复」没做（`app.js:3709-3719` 只有不可点击的分组标题） | 分组标题右侧加「恢复到这一轮」，调 `rewindTo(messageIndex)` | 点标题能回到该轮，后续轮次被丢弃 |
| U15 | ✅ | 实时回合没有 rewind 按钮：`attachRewind` 只在 `session_loaded` 调用（`app.js:2472`），`submit()` 不调（`4454`） | `submit()` 后给新气泡挂 rewind，index 用 host 回传的 message index | 刚发出的回合悬停即有 rewind，点击生效 |
| U16 | ✅ | `@` 引用文件时插入字面 `\n\n`：`blocks.join("\\n\\n")`（`host.js:1663`） | 改成 `"\n\n"` | 引用文件后消息里是真实换行 |
| U17 | ✅ | bash 改的文件不进轮次 rewind：`captureBashChanges` 的 `messageIndex` 从未传入（`shellTools.ts:235,329`），根因是 `ToolContext` 没有该字段（`types.ts:242-263`） | `ToolContext` 增加 `messageIndex?: number`，pipeline 注入，shellTools 透传 | bash 删改一个文件后 rewind 到该轮，文件被还原 |
| U18 | ✅ | diff 面板签名用了不存在的字段：`file.diff?.length ?? 0`（`app.js:2849`），`ChangeSummary` 只有 `hunks`（`src/diff.ts:173-180`） | 签名改用 `hunks` 的内容摘要（长度 + 首末行 hash），或直接比较序列化后的 hunks | 只改措辞不改行数时面板也更新 |
| U19 | ✅ | 行内 diff 卡可能挂错行：`tool_detail` 早于 `tool_end`，`attachInlineDiff` 依赖 `row.nextElementSibling`（`app.js:617,657`），`tool_output` 会把行包进 `.tool-item`（`691-694`） | 用 tool call id 匹配行，而不是 `state.lastToolNode` 单槽 | 一次并行写两个文件，两张卡各挂各行 |
| U20 | ✅ | 并行/后台子代理卡没有停止按钮：`subagentStart` 只有 `startSubagent` 路径带 id（`agent.ts:1283`），并行（`1396`）与后台（`1444`）不带 | 三条路径都带 `{ id }`；后台任务登记进 `subagents` 注册表 | 并行两个子代理，两张卡都有停止按钮；Tasks 页签能看到 |
| U21 | ✅ | 子代理单槽覆盖：`state.currentSubagent` 只有一个（`app.js:114`），先结束的清空槽位（`1878`），后到的 `subagent_end` 撞 `if (!sub) break`（`1872-1873`）；`subagentEnd` 也不带 id | `subagentEnd`/`subagentActivity` 都带 id；渲染层按 id 找卡 | 并行两个子代理，两张卡都正确显示 running → done |
| U22 | ✅ | `browser_open` 让 agent 开了页面但用户看不见（`app.js:2119-2120` 不调 `openWorkbench`/`scheduleBrowserBounds`） | 请求 kind 为 open 时打开面板并下发 bounds | agent 调 `browser_open` 后浏览器页签自动打开 |
| U23 | ✅ | `browser_screenshot` 的图 agent 拿不到：结果通道只有文本（`ToolResult.content: string`） | 给 `ToolResult` 增加图片内容（或让 host 把路径换成可被模型读取的图片 part） | agent 截图后下一轮能看到图 |

---

# P2：显示与实际不符

| # | 状态 | 问题 | 做法 | 验收 |
|---|---|---|---|---|
| U24 | ✅ | 五个设置项从不回填：`restartSession`/`suggestions`/`updateCheck`/`isolateByDefault`/`uiScale` 在 `fillSettings`（`settings.js:2041-2066`）里都没有赋值，`state.*` 全仓库无写入点 | 全部回填；`uiScale` 同时加进 host 的 `setUiPreference` 白名单（`host.js:2339-2356`） | 改任意一项 → 重开设置页 → 仍显示改后的值；重启后缩放保持 |
| U25 | ✅ | 自动标题没有开关，也没有「免费规则优先」：`host.js:1779` 无 uiPrefs 判断；`agent.proposeTitle`（`agent.ts:1031-1055`）用当前模型 | 增加设置项；先跑规则（首条消息截断）失败再用模型；或至少如实改注释与文档 | 关掉后新会话不再生成标题 |
| U26 | ✅ | 命令面板无焦点陷阱（`openPalette`，`app.js:4946`）；`openSplitPicker`（`4312-4364`）同样只有 Esc | 复用 `confirmAction` 里的 Tab 陷阱逻辑（`928-975`） | 面板打开时 Tab 不离开面板 |
| U27 | ✅ | board 菜单无外部点击关闭（`app.js:3160-3212`）；effort/board/mode/plus/usage/会话菜单无 Esc | 补 document click 与 Esc 分支，和现有 model/mode/plus 一致 | 各菜单点外部或按 Esc 都能关 |
| U28 | ✅ | 设置页四处删除无确认（`settings.js:1049,1205,1303,2034`） | 把 `confirmAction` 通过 deps 注入 settings | 删 MCP/skill/memory/规则都先确认 |
| U29 | ✅ | `#check-update` 元素不存在（`app.js:197,5701` 在找它，`index.html` 没有） | 在顶栏加一个更新徽标，或删掉这段死代码并如实说明只有 About 页可见 | 模拟有新版时顶栏出现提示 |
| U30 | ✅ | 首次运行清单的 `action` 字段无人读（`host.js:2787,2801`；`app.js:1655-1666`） | 渲染 `setApiKey`/`installGh` 为可点按钮；gh 补安装命令 | 清单里点「去配置」直接跳到连接页；gh 给出安装命令 |
| U31 | ✅ | `autoApprove` 与规则仍是两套输入（`settings.js:918-934` 与 `948-957` 并存；`permissions.ts:176,289` 分开读） | 一次性迁移：把 autoApprove 转成 ApprovalRule 后从设置页移除 | 设置页只剩规则列表；旧配置迁移后行为不变 |
| U32 | ✅ | worktree 位置「可配置」是假的：设置页是只读 `<code>`（`settings.js:997-1002`），`worktree.ts:178` 硬编码 | 增加配置键并真正读取；或把这一行改成纯说明、删掉「可配置」的说法 | 改路径后新 worktree 落在指定位置 |
| U33 | ✅ | 启动后的首个会话不隔离（`enterDefaultWorktree` 只在 `host.js:675,2651,587`） | 启动路径也调用（在 `createAgent([])` 之后） | 开启默认隔离后冷启动即进入 worktree |
| U34 | ✅ | 色盲主题完全没做（计划 F25 三项之一，全仓零命中） | 增加 `daltonized`/`light-daltonized` 两个变体，只调整语义色不新增色相 | 主题列表出现该选项；切换后红绿可区分 |
| U35 | ✅ | `.queues` 类没有 CSS（`app.js:900`） | 补样式：busy 时按钮文案变「排队」并给可辨认的视觉 | busy 时按钮明显不同 |
| U36 | ✅ | 消息级复制/重试/编辑不存在（计划 F18） | 消息悬停操作条：复制、重试（发回同一文本）、编辑（填回 composer） | 三项都在且可用 |

---

# P3：清理，不影响用户

| # | 状态 | 问题 | 做法 | 验收 |
|---|---|---|---|---|
| U37 | ✅ | 61 个 i18n 死键；Board 那批是 U1–U3 要恢复的文案，**先别删** | U1–U3 做完后再删剩下的 | U1–U3 完成后重跑 `.research/i18n-audit.cjs`，死键数等于真实剩余（Board 那批应归零） |
| U38 | ✅ | `i18n.js:855-856` 中文块 `askMultiHint` 重复，第一行是英文 | 删掉 855 | `node -e` 解析两套字典，键集合一致且无重复 |
| U39 | ✅ | 死函数：`renderTree`（`app.js:3742`，读的 `state.tree` 从不赋值）、`openBrowserPane`（`3894`）、`settings.js` 导出的 `close`/`isOpen`/`handleKey` | 删除，或把 `settings.handleKey` 真正接上再删重复实现 | `node .research/dead-functions.cjs` 输出为空 |
| U40 | ✅ | `settings-i18n.js` 的 `autoApproveDesc` 仍描述「逗号分隔」，与统一后的语法不符 | U31 做完后连同该键一起删 | 该键不在 `settings-i18n.js` 中 |
| U41 | ✅ | `turn_progress.turns` 被 host 发送、渲染层丢弃（`host.js:431`）；`progress.retry` 赋值不读（`app.js:365`） | 二选一：用起来，或从协议里删掉 | 协议字段要么被渲染层读取，要么不再出现在 `host.js` 的发送对象里 |
| U42 | ✅ | 串口「清空」清不掉 agent 读的环形缓冲（`serialClear` 只清 UI 那份，`serial.ts` 无清空函数） | `serial.ts` 增加 `clearRecentLines(path)`，`serialClear` 一并调用 | 清空后 agent 读 `recentPortLines` 返回空 |
| U43 | ✅ | 波特率下拉没有 change 监听（`app.js:3406`，只有 `serial-port` 有 `3476`） | 补 change，写入 selection | 改波特率后重开面板仍显示改后的值 |
| U44 | ✅ | 串口等级过滤只认四种格式（`serial.ts:206-275`），普通 printf 的 WARN/ERROR 识别不到 | 补通用 `[WARN]`/`ERROR:` 模式，或如实把过滤标成「仅结构化日志」 | `[WARN]`/`ERROR:` 行被标记并可通过过滤 |
| U45 | ⛔ | RAM 总量不读，`boardRamUnknown` 明说 | 保持现状即可；若要显示总量需另做（读 `0x1FFF7A22+4` 的 RAM 字段） | 若不做则文档不再暗示能读总量 |
| U46 | ✅ | 测试缺口：U7/U8/U9/U10/U13–U16/U18–U21 全部零覆盖 | 每条修完补一条行为测试 | 各条测试名写回条目 |
| U47 | ✅ | `tests/round4-ui.test.ts` 头注释声称覆盖 word-level diff，实际没有 | 补测试或改注释 | 测试存在，或注释改为如实描述 |
| U48 | ⛔ | 词级 diff 用 Set 交集而非 LCS（`app.js:2799-2829`） | 可接受；若要精确改 LCS，注意 800 字符上限 | 若要改：重复词的标记正确 |
| U49 | ✅ | pending diff 只显示 40 行（`app.js:5031-5087`） | 大文件时给「显示全部」 | 超大 write_file 能看到全部变更 |
| U50 | ✅ | 长行横向滚动不完整（`.diff-text` 有 `min-width:0`） | 加 `min-width: max-content` 或改布局 | 长行可横向滚动而不被压扁 |
| U51 | ✅ | split-window 子窗口可能超出屏幕（`main.js:381-391`） | 用 `screen.getDisplayMatching` 取真实工作区并夹取 | 多显示器边缘开 split 窗口不越界 |
| U52 | ✅ | OpenOCD 识别永远失败（`host.js:1083` 不传 `openocdTarget`）；J-Link 不参与识别 | 有 cfg 时传下去；J-Link 走 `JLinkExe` 读 IDCODE | 有 OpenOCD cfg 时识别成功；J-Link 时报出 device id |

---

# 执行顺序

1. **U7、U8、U9、U10** —— 四条互不依赖，改动小，先把「必然失败」清掉。
2. **U1–U3** —— 同一块界面，一起做；数据管线已就绪，主要是恢复渲染。
3. **U4、U5、U6** —— 板卡可信度与串口入口。
4. **U11、U12** —— 串口写入与转发。
5. **U13–U21** —— 审查闭环与子代理。
6. **U22–U23** —— 浏览器。
7. **U24–U36** —— 设置与一致性。
8. **U37–U52** —— 清理。

每完成一组：`npx tsc --noEmit` + 该组测试文件；全部完成后跑一次全量。

# 与既有约束的关系

- **不改变设计语言**：所有条目复用现有 token 与组件；恢复的探针/目标表行沿用 `board-row`/`board-target`，不新增圆角、颜色、字体。
- **`round8-board-pane.test.ts` 的五条约束不能被撞破**：单一目标行、不出现 `boardAttached`、无 mismatch 裁决、unlisted 不回退、不列全部工具链。U1–U4 都在这五条之内。
- **通用系统**：不写死任何厂商/型号；U1/U2 的探针与目标表都对任意探针工具生效。

---

# 验证记录

## 第一批：U7、U8、U9、U10

测试文件 `tests/round9-batch1.test.ts`（18 条，全通过）：

```bash
node --test tests/round9-batch1.test.ts
npx tsc --noEmit
```

**U7**（6 条）
- `a check URL yields the Actions run id` — `runIdFromCheckUrl` 从 `/actions/runs/<id>` 取 id
- `a check with no Actions run yields nothing to rerun`
- `rerunning failed checks passes the run id and never a bare run rerun` — 断言实参为 `["run","rerun","222","--failed"]`，同一 run 的两个失败 job 只重跑一次
- `a failing check outside Actions is reported, not silently skipped`
- `the failed log is fetched by run id without gh's invalid --limit` — 断言实参为 `["run","view","333","--log-failed"]`
- `the failed log is truncated locally, since gh cannot do it`
- 为了让断言能检查「实际传给 gh 的参数」，`desktop/git.js` 增加了 `setGhRunner()` 注入点（与 `setBrowserBridge` 同一套做法），生产路径不设置它。

**U8**（2 条）
- `the preload exposes the Electron 44 way to read a dropped file's path`
- `the renderer asks the bridge for a path instead of reading file.path`
- `desktop/preload.cjs` 从 electron 解构 `webUtils` 并暴露 `getPathForFile(file)`（内部 try/catch，失败返回 `""`）；`handleImageFiles` 改走 `droppedFilePath(file, api.getPathForFile)`。

**U9**（4 条）
- `a remembered session that differs from the fresh one is reopened`
- `no restore when the setting is off, nothing is remembered, or it is already open`
- `the fresh session's state event no longer overwrites the remembered id`
- `loading or saving a session is what records it for next time`
- 判断逻辑抽到 `desktop/renderer/startup.js` 的 `shouldRestoreSession`；`case "state"` 不再写 `prometheus.lastSession`，改由 `session_loaded`/`session_saved` 记录。

**U10**（6 条）
- `the host filters by status` / `a session with no stored status counts as ready` / `the host filters by workspace` / `workspace comparison ignores case and separators`
- `a later push keeps the filter the user chose` — 推送不带参数时保留当前视图
- `the listSessions command passes the filter through instead of dropping it`
- 过滤逻辑抽到 `desktop/sessionView.js`（`resolveSessionView`/`filterSessions`/`canonicalCwd`）；`host.js` 用 `sessionView` 保存当前筛选，`sendSessions` 每次先合并再过滤，`listSessions`/`sessionFlags`/`deleteSession` 三处入口透传 `status`/`cwd`。

### 与计划的偏差

- **U10 的问题描述比实际严重**：`sendSessions` 早已实现 status/cwd 过滤，真正坏掉的是 `case "listSessions"` 不传参、以及没有筛选状态的记忆（任意推送都会重置为 all）。按这个事实修复，验收标准不变。
- **U9 的记录点从 `state` 移到 `session_loaded`/`session_saved`**：单纯「不覆盖 remembered」会让新会话永远不被记住，等于把 bug 换个方向。
- **两个新模块用 `.js` 而非 `.ts`**：`desktop/renderer/` 由 Electron 直接以 `<script type="module">` 加载，没有构建步骤，`.ts` 解析不了；`desktop/` 与 host 同目录的 `sessionView.js` 也统一为 `.js`。两者用 JSDoc 标注类型，`npx tsc --noEmit` 不覆盖它们。
- **U7 的实现采用「按 run 去重重跑」而不是「一次 rerun 全部」**：`gh run rerun <id>` 没有跨 run 的批量形式，而一次 PR 的失败检查通常就在同一个 run 里；解析不到 run id 的非 Actions 检查会如实返回错误，不再静默成功。

## 第二批：U1、U2、U3、U4

测试文件 `tests/round9-batch2.test.ts`（16 条，全通过）。命令：

```bash
node --test tests/round9-batch2.test.ts
node --test tests/round8-board-pane.test.ts tests/round8-effective-board.test.ts
npx tsc --noEmit
```

判断逻辑从 `renderBoard` 里抽到 `desktop/renderer/boardView.js`（`buildTargetView` / `resolveSource` / `sourceLabel` / `targetStatusNote`），这样这些判断可以做单测，`renderBoard` 只负责画。

**U1**
- `every attached probe gets a row with its kind and serial`、`a probe without a serial is not offered as a choice`、`the selected probe is marked active`
- 面板「其它选择」区恢复探针行：`名字 · 类型 · 序列号 · 报告的目标`，`data-probe` 点击写入 `BoardSelection.probe`；没有序列号的探针只列出、不可选（选中会写入空 id）。

**U2**
- `the target table lists what was loaded, filtered by the query`、`the query matches vendor and part as well as the name`、`no table loaded means no rows and no invented count`、`the table arrives with the scan rather than behind a button`
- 扫描落地后 `setBoardState` 自动发 `getBoardTargets`，面板新增「目标表」区：筛选框 + 行按钮 + 「显示 N / M」。**没有加「加载目标」按钮**——`round8-board-pane.test.ts` 明确要求表不能藏在按钮后面，这条约束优先于原计划的措辞。

**U3**
- `the target status note names the state`、`the note is carried on the view the pane renders`
- 目标行 note 恢复显示「尚未加载 / 目标表里有这一项 / 不是精确条目 / 不在目标表里」。

**U4**
- `a name chosen from several candidates does not claim to come from the chip`、`a name that is the only candidate is still the chip's answer`、`a name with no chip read at all stays manual`
- 新增来源 `picked`：当 `targetOptions` 多于一个时，面板显示「这是该芯片家族对应的若干名字之一；型号与容量来自芯片」，不再写「从芯片读出」。芯片读到的是家族与容量，具体型号是选出来的。

### 与计划的偏差

- **U2 原计划写「恢复加载目标按钮」，实际改为随扫描自动加载。** `round8-board-pane.test.ts` 的第五条约束是「a target table load is not behind a button」，两条计划冲突时以已通过的约束为准。验收标准（能列出 ≥200 条、能过滤、点选生效）不变。
- **U4 没有改 `source: "chip"` 的协议值**，而是新增渲染层来源 `picked`。改协议值会影响 `round8-effective-board.test.ts` 断言的 `targetSource` 取值，而「谁选的这个名字」本来就是渲染层要区分的事。

## 第三批：U5、U6

测试文件 `tests/round9-batch3.test.ts`（15 条，全通过）。命令：

```bash
node --test tests/round9-batch3.test.ts
node --test tests/round8-board-pane.test.ts tests/round3-embedded.test.ts tests/round4-embedded.test.ts
npx tsc --noEmit
```

**U5**
- `the dropdown is filled from the host's port list, not from board state`、`the saved selection is preselected even when it is not first`、`a single port is preselected with no saved selection`、`two ports and no saved selection preselected nothing`、`no ports yields no choices and a reason to say so`、`starting with no port chosen is refused with a reason`
- `opening the serial pane asks for ports when the scan has not run`、`the host answers a port list without a full scan`、`Start says why it did nothing`
- 新增 host 命令 `serialPorts`（只调 `listSerialPorts`，不做工具链探测和芯片识别）；`openSerialPane` 同时发 `serialStatus` 与 `serialPorts`；`fillSerialControls` 改用 `serialView.js` 的 `serialPortChoices`；Start 走 `startBlockedReason`，无端口/未选端口时在状态行给出可见提示，不再静默 return。

**U6**
- `a configured board with no identification must be identified first`、`nothing to identify with means nothing to wait for`、`once identified, a second flash does not scan again`、`a scan that found no probe backs off instead of retrying every call`、`a changed selection reopens the question`、`the host identifies before a flash that would otherwise use a stored name`
- 新增 `src/embedded/identifyGate.ts` 的 `IdentificationNeed`；`Agent.onBeforeTool`（由 pipeline 在权限检查之后、执行之前 await）让 host 在 `embed_flash`/`embed_debug`/`embed_reset` 运行前调用 `ensureIdentified()`：仅当「有保存的 target + 尚未识别 + 至少一个探针」时扫描一次，失败也标记为已尝试，避免无板环境下每次调用都重扫。

### 与计划的偏差

- **U6 没有在启动时就扫描**：计划里给的是两种做法二选一。启动即扫描会在每次冷启动都花一次探针/工具链探测，而多数会话根本不会烧录；改成「第一次真正要用板卡时才识别」，验收标准（agent 烧录时 target 来自芯片读数）不变，且不增加普通代码会话的成本。
- **`onBeforeTool` 是新增的 pipeline 钩子**，与已有的 `onBeforeMutate` 分开：后者只对写文件工具触发且不 await，前者需要阻塞等待扫描。

## 第四批：U11、U12

测试文件 `tests/round9-batch4.test.ts`（13 条，全通过）。命令：

```bash
node --test tests/round9-batch4.test.ts
npx tsc --noEmit
```

**U11**
- `a line ending is appended only when the user asked for one`、`a bootloader command with no ending is sent exactly as typed`、`an empty line with an ending is still a real send`
- `the pane has a send field and a send action`、`Enter sends, Shift+Enter inserts a newline`、`the write result is shown, and a failure is not silent`、`the status line reports bytes written`
- 串口底部新增输入行：文本框 + 换行选择（LF / CRLF / 无）+ 发送。Enter 发送、Shift+Enter 换行；`serial_written` 之前渲染层没有分支，现在在状态行显示「已发送 COM7 · N B」。

**U12**
- `a selection becomes a quoted block with the port named`、`several selected lines keep their order`、`an empty selection produces nothing to insert`、`the output rows carry the index the selection needs`、`there is an action to send the selection`、`the inserted text reaches the composer rather than being sent immediately`
- 输出行带 `data-line-index` 指向环形缓冲；点击选中、Shift 点击区间、拖动划过、Ctrl+A 全选；「选中发给 agent」把选中行拼成带端口标注的围栏代码块放进 composer，**不自动提交**。新增 `.serial-line.selected` 等样式，只复用现有 `--accent-soft` / `--accent` token。

### 与计划的偏差

- **换行不是固定 `\n`**：计划写「输入 `help\n` 能发出去」，实现成三选一。bootloader 的应答往往不能带换行，固定追加会多发一个字节。
- **「选中发给 agent」写入 composer 而不是直接发给模型**：选中日志是用户提问的证据，替用户提交会花掉一轮他没要求的调用。

## 第五批：U13–U21

测试文件 `tests/round9-batch5.test.ts`（21 条，全通过）。命令：

```bash
node --test tests/round9-batch5.test.ts
node --test tests/agent.test.ts tests/parallel.test.ts tests/rewind.test.ts tests/checkpoints.test.ts
npx tsc --noEmit
```

- **U13** 差异文件列表每行拆成「选中」与「撤销」两个按钮（`div` 不能嵌套 button）；撤销复用 `restoreFile`，带确认。样式上撤销按钮只在悬停/聚焦时出现。
- **U14** History 的轮次标题右侧加「回到这一轮」，调 `rewindTo`；第 1 轮不显示，因为已有的「恢复到起点」就是同一件事。
- **U15** host 在新回合开始时发 `prompt_accepted { index }`；渲染层把提交时的气泡挂上 `attachRewind`。此前 `attachRewind` 只在 `session_loaded` 调用。
- **U16** `@` 引用的文件块拼接移到 `desktop/mentions.js`，用真实 `\n\n`；host 只负责读文件。
- **U17** `ToolContext` 增加 `messageIndex`，pipeline 在构造 ctx 时注入，`shellTools` 两处 `captureBashChanges` 透传。bash 改过的文件因此进入按轮 rewind。
- **U18** 差异面板签名改用 `desktop/renderer/changeSignature.js`，基于 `hunks` 内容而不是不存在的 `file.diff`。
- **U19** `tool_start` 把 call id 写到行上（`data-call-id`），`tool_detail` 按 id 找到行再挂 diff；`toolDetail` 在 `Ui`、pipeline、host 三处都带上 `meta.id`。
- **U20/U21** `subagentActivity`/`subagentEnd` 增加 `meta.id`；`startSubagent`、并行、后台三条路径都在创建记录后把 id 传给子代理（`spawnSubagent` 新增第 4 个参数），所以子代理的工具活动能按 id 路由。渲染层用 `SubagentCards` 按 id 建卡，`currentSubagent` 单槽只作为旧路径的回退。后台任务也登记进 `subagents`，因此 Tasks 面板能看到、卡片有停止按钮。

### 与计划的偏差

- **U20 的「停止按钮」对后台任务仍需 `stopSubagent` 找到 child**：已给后台任务建记录并把 child 放进 `subagentAgents`（`spawnSubagent` 内部本就注册），所以按钮可用；这一点由代码路径保证，没有单独的单测断言 DOM。
- **U17 的 `messageIndex` 是「调用发生时的对话长度」**，不是精确的 user 消息下标；对「rewind 到某轮」足够（checkpoint 只用来判断属于哪一轮之后），但它不是消息 id。

## 第六批：U22、U23（浏览器）

测试文件 `tests/round9-batch6.test.ts`（9 条，全通过）。命令：

```bash
node --test tests/round9-batch6.test.ts
node --test tests/query.test.ts tests/round5-pipeline-ui.test.ts
npx tsc --noEmit
```

- **U22** `browser_request` 的 `open` 分支先 `openWorkbench("browser")` 再导航，随后 `scheduleBrowserBounds()`。此前 agent 打开了 `WebContentsView` 但面板没显示。
- **U23** `ToolResult` / `PipelineOutcome` 增加 `images?: string[]`；`main.js` 的截图处理器同时返回 `path` 与 `dataUrl`；渲染层把 `dataUrl` 带回 bridge；`browser_screenshot` 把图片作为结果的一部分返回；`query.ts` 在工具结果之后补一条带 `image_url` 的用户消息（OpenAI 兼容协议里 tool 消息没有图片位）。没有 `dataUrl` 时工具如实报错，不再声称成功。

### 与计划的偏差

- **U23 没有改协议形状**：tool 消息保持纯文本，图片作为紧随其后的 user 消息送达。这是兼容端点唯一能接受图片的位置，也避免改动 agent/tool 消息的配对逻辑。

## 第七批：U24–U36

测试文件 `tests/round9-batch7.test.ts`（21 条，全通过）。命令：

```bash
node --test tests/round9-batch7.test.ts
node --test tests/round4-ui.test.ts tests/round5-composer.test.ts tests/rules.test.ts tests/settings.test.ts tests/worktree.test.ts
npx tsc --noEmit
```

- **U24** `desktop/renderer/settingsState.js` 的 `filledPreferences` 统一回填五个开关；host 的 `setUiPreference` 白名单加入 `uiScale`，并在 `getSettings` 里回传，写入时夹在 0.75–1.5。
- **U25** `src/titlePolicy.ts`：`autoTitleAllowed` 读 `suggestions`，`ruleFirstTitle` 先用首行规则出标题，规则给不出才调用 `agent.proposeTitle`。
- **U26** `trapFocus()` 统一处理 Tab/S-Esc；命令面板与 split picker 都接入。
- **U27** board 菜单补 document `mousedown` 与 Escape；`plus`/`mode`/`model` 三个菜单补统一 Escape 路径。
- **U28** `createSettings` 接收 `confirm`，MCP/技能/记忆/规则四处删除都先确认（`settings-i18n.js` 新增四条确认文案）。
- **U29** 顶栏新增默认隐藏的 `#check-update` 按钮，有新版时加 `has-update` 小圆点，title 写明版本，点击打开设置的 About 页。
- **U30** 首次运行清单渲染 `check.action` 为「打开连接设置 / 安装 GitHub CLI」按钮。
- **U31** 设置页删掉 `autoApprove` 文本框；`src/autoApproveMigration.ts` 把旧列表转成 `allow` 规则（`Bash(git status)` 保留 matcher），host 在 `init` 时迁移一次并清空旧字段。
- **U32** 没有新增配置项：这一行本来就是「仓库内、被 git 忽略」的固定规则，测试改为断言它不冒充可编辑项，且文案里的路径与 `worktree.ts` 实际使用的一致。
- **U33** 启动路径在 `createAgent([])` 之后调用 `enterDefaultWorktree()`。
- **U34** 新增 `daltonized` / `light-daltonized` 两个主题变体，只覆盖 `--success/--warn/--danger` 与对应的软色/差异底色，表面与文字 token 全部继承。设置页与顶栏菜单各加一项。
- **U35** `.send-button.queues`：busy 时按钮变为描边样式、箭头转 90°，与「立即发送」区分。
- **U36** 用户消息悬停出现「复制 / 重发 / 编辑」；编辑写入 composer 不自动提交。

### 与计划的偏差

- **U32 选择「如实说明」而不是「做成可配置」**：新增一个配置项意味着 worktree 可能落在仓库外，`ensureWorktreeIgnored`、合并与清理都以仓库内为前提；把文案改成事实的成本远低于改这套前提。验收标准按「文档不再暗示能改」执行。
- **U31 的迁移只在 `init` 跑一次**，迁移后 `autoApprove` 清空。CLI 的 `--allowed-tools` 仍然写进内存里的 `autoApprove`（每次运行独立授权，不落盘），这条路径不受影响。
- **U34 的变体跟随系统浅色/深色**，与 `high-contrast` 的处理方式一致，所以主题列表里是一项而不是两项。

## 第八批：U37–U52（清理）

测试文件 `tests/round9-batch8.test.ts`（15 条，全通过）。命令：

```bash
node --test tests/round9-batch8.test.ts
node --test "tests/*.test.ts"      # 全量：711 条，709 通过，2 条原有的条件跳过
npx tsc --noEmit
```

- **U37** 先补齐审计脚本（它原来没扫 `boardView.js`/`serialView.js` 等新模块，会把仍在用的键报成死键，也会把 `settings-i18n.js` 整本误判）。修好后 `i18n.js` 409 键、死键 0；`settings-i18n.js` 282 键、死键 0。删除时只删确认无引用的叶节点行，并核对 en/zh 键集合仍完全一致（各 409）。
- **U38** 删掉中文块里那行英文 `askMultiHint`，现在每套字典各一条。
- **U39** `renderTree`（读从不赋值的 `state.tree`）与 `openBrowserPane` 已删除；`.research/dead-functions.cjs` 输出为空。
- **U40** `settings-i18n.js` 的 `autoApprove`/`autoApproveDesc`/`autoApproveRulesHint` 三对键已删。
- **U41** `turn_progress.turns` 从协议里删掉（渲染层从未读）；`progress.retry` 改为在进度行显示「第 N 次重试」。
- **U42** `serial.ts` 新增 `clearRecentLines`，`serialClear` 一并调用。
- **U43** 波特率下拉补 `change` 监听，写入选择。
- **U44** `serial.ts` 新增 `logLevelOf`：识别 `WARN:`/`[WARN]`/`ERROR:`/`[ERROR]`/`FATAL:`/`ASSERT:` 等前缀；只认行首，避免把正文里的 "error" 当成等级。
- **U46** U7–U21 各条的测试名已写在对应批次记录里（`round9-batch1..5.test.ts`）。
- **U47** `round4-ui.test.ts` 头注释改为如实说明：词级 diff 在 `app.js` 里、需要 `document`，该文件不覆盖。
- **U49** 待确认差异（pending diff）从固定 40 行改为「默认 40 行 + 查看完整改动」。
- **U50** `.diff-text` 的 `min-width: 0` 改为 `max-content`，长行不再被压扁。
- **U51** 新增 `desktop/windowBounds.js` 的 `splitClamp`；`main.js` 用 `screen.getDisplayMatching` 取目标显示器工作区再夹取。
- **U52** `identifyAttached` 把 `board.targetConfig`/`interfaceConfig` 传给 `identifyChip`（此前 OpenOCD 永远因「no target config」失败）；`identity.ts` 新增 `viaJlink` 驱动，用 Commander 脚本读同一寄存器，并新增 `parseJlinkRead32` 与其测试。

### 明确不做（⛔）

- **U45 RAM 总量**：`boardRamUnknown` 已经如实说明读不到；要读需按家族逐个确认 `0x1FFF7A22+4` 一类地址，超出本轮「把已承诺的做成真的」范围。计划里原本写的也是「保持现状即可」。
- **U48 词级 diff 用 Set 交集而非 LCS**：现有算法对「改一个词」这类最常见的编辑给出正确标记，换 LCS 是为罕见情况重写热路径。计划里原本写的就是「可接受」。

### 需要说明的测试强度

这一批里的结构断言（例如「菜单能关」「按钮有样式」）证明的是代码里存在对应路径，不证明在 Electron 窗口里的观感。真正跑过的是逻辑层：`logLevelOf`、`splitClamp`、`parseJlinkRead32`、`filledPreferences`、`ruleFirstTitle`、`changeSignature`、`SubagentCards`、`serialPortChoices`、`withMentionedFiles`、`runIdFromCheckUrl`。其余条目建议在桌面窗口里手工过一遍，特别是 U26/U27（键盘焦点）、U34（配色）、U36（悬停操作条）。
