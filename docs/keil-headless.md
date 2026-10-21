# Keil MDK：无头能做的全部事

日期：2026-10-21（第三版）。前两版声称「公开接口全部接通」；逐个报文在真实 MDK 5.43a +
真实 STM32F429 工程上重新核对后，发现**寄存器、变量、任务、反汇编四条链路每一条都读错了
字节**，另有三处「接口回 SUCCESS 但什么都没发生」。这一版把它们修掉，并把结论按证据重写。

---

## 一、先回答「无头到底能做什么」

Keil 自己没有 Linux 那种「一个命令做所有事」的入口。它公开的是三类东西：

| 入口 | 能做什么 | 不能做什么 |
|---|---|---|
| `UV4.exe -b/-r/-c/-cr/-f/-X/-et/-ep/-5/-t` | 构建、重译、清理、烧录、生成符号头、导出 cprj、转换工程 | 断点、单步、读变量 |
| `fromelf` / `armclang` / `cpackget` / `cbuild` / `svdconv` | 读镜像、单独编译、装包、CMSIS-Toolbox 构建 | 驱动调试器 |
| **UVSOCK（TCP）** | 调试器的全套操作 + 工程模型 + 编译选项 | 编辑器本身、工程保存（见第四节） |

**启动方式**：`UV4.exe <project.uvprojx> -s 4823 -j0`，实测约 4 秒后端口可用。

---

## 二、协议本身

消息 = 32 字节头 + 负载：
`{ u32 totalLen, u32 cmd, u32 bufLen, u64 cycles, u64 tStamp, u32 id }`。
应答用 `0x3000`，负载 `{ u32 回显命令, u32 状态, … }`，**按回显命令匹配，不按到达顺序**。
枚举类命令先回 `^done`，再流式推 `0x50xx` 帧。

### 关键：接口是 `#pragma pack(1)`

这是上一版所有解析错误的共同根因。头文件里的结构体没有对齐填充，而实现按自然对齐去读，
于是每个「字段偏移」都错开一到三个字节，错出来的值**看起来又很像真的**：

| 结构 | 正确布局（pack(1)） | 上一版读成 | 后果 |
|---|---|---|---|
| `REGENUM` | `u16 nGi, u16 nItem, char szReg[16], u8 flags, char szVal[32]` | flags 当成 `u32@20`，值从 24 起 | `0x08006458` → `8006460`，PC 少三位、看着像个合法地址 |
| `VSET` | `{ TVAL val; SSTR str }`，val 在 4，str 在 12 | value 从 8 读 | `0x08006458` → `0x006458`，跑到内存低半区 |
| `VARINFO` | `nID, index, count, typeSize, flags, value(SSTR), type, name, qualified` | 偏移对、但请求里 count=0 | 见下 |
| `STACKENUM`（任务） | `nItem, nAdr, nRetAdr, nVars, nEqual, nTotal, nTask, nRes[3], 计数名字@36/文本@40` | 名字从 44 读 | 有线程的目标报「没有任务」 |
| `AMEM`（反汇编） | `nAddr, nBytes, ErrAddr, nErr, **文本**` —— 字节是窗口里的字符串 | 当成 32 位指令字 | 把 ASCII `"0x00"`(`0x30307830`) 当成操作码打印出来 |

### 只有实测才知道的几个语义

- `IVARENUM` 的 **count 为 0 时回 SUCCESS 且一条不推**。「没有符号表」和「没请求任何东西」
  长得一模一样；现在固定请求 128 条。
- 变量 / 任务 / Watch 需要 **extended stack mode**（`GEN_SET_OPTIONS` 的
  `bExtendedStack`）。该选项**只在进调试之前**被接受；进调试后设会回
  `Target is in debug mode`。上一版把它当「只管界面布局、无行为」标成不可用，
  于是整组功能都是 `NOT_SUPPORTED`。
- `PRJ_FLASH_DOWNLOAD` 是工程操作：调试会话里回 `Target is in debug mode`。
- `PRJ_FLASH_ERASE` 在 5.43a 上**从不回复**（15 s / 20 s / 60 s 都试过）。
- `DBG_ENTER` 是异步的，失败出现在后面的 `0x4000` 帧里。

### 状态码

`0` 成功、`6` 未调试、`9` 找不到、`10` 正在调试、`11` 目标运行中、`12` 目标已停止、
`19` 断点重定义、`28` 不支持、`29` 超时、`32` 无地址映射。

其中三个不能当失败：`12` 对 `halt` 是已满足；`11` 对 `run` 是已在跑；`9` 对变量枚举是空列表。

---

## 三、这一版修掉的「假完成」

每一条都是「接口说成功、结果不是那么回事」，也都是拿真实工程跑出来的。

### 1. 寄存器值是错的

见上表。`register_read PC` 之前回 `8006460`，现在是 `0x08006458`。
寄存器枚举返回的 152 条里，值现在完整。

### 2. 写寄存器：SUCCESS，但值不变

`REGISTER_SET` 收的是 `VSET`，**新值必须在 value 字段里**。上一版发的是两个前后相接的
`SSTR`，uVision 回 `SUCCESS`，寄存器一动不动。现在写后**回读核对**，没变就报
「accepted but reads back …」，并且能按人写的名字找到寄存器——调试器列的是
`R15 (PC)`、`R13 (SP)`，直接找 `PC` 是找不到的。

### 3. 写变量：SUCCESS，但请求里没有值

`VARIABLE_SET` 收 `VARVAL`（`IVARENUM` + 新值），按 **nID** 定位，不是按名字。
上一版按名字发，得到一个「看起来成功」的回复。现在先枚举、按 id 写、再回读：
实测 `uwTick` 从 `0x00000000` 写到 `0x00003039`。

### 4. 变量列表一直是空的

三个原因叠加：没开 extended stack mode、请求 count=0、以及把 `NOT_FOUND` 当「没有符号表」。
现在 `variables` 列出全局（36 个，带类型、数组长度、只读标记），`frame` 参数可列栈帧局部量。

### 5. 任务：有线程也报「没有任务」

名字偏移错（44 → 40）。实测该目标的 RTOS 感知插件报 `Main Thread`。

### 6. 反汇编：把 ASCII 当指令打印

`DSM_READ` 回的是**已经反汇编好的文本**，不是指令字。现在原样输出，并且知道
「请求 32 字节会回空、要 128」这个实测特性，会自动加大再试一次：

```
    35:     HAL_Init();                     //初始化HAL库
0x08006BE0 F7F9FF38  BL.W          0x08000A54 HAL_Init
```

### 7. 栈：`#0` 报的是最外层

调试器**自底向上**报帧（`Reset_Handler` 的返回地址是 `0xffffffff`），且帧里没有符号文本。
上一版既没倒序，又把 `nEqual` 当函数名读。现在倒序，符号靠 `ADR_TOFILELINE` 补：

```
#0 SystemInit system_stm32f4xx.c:174  (0x8006460)
#1 Reset_Handler ../CORE/startup_stm32f429xx.s:200  (0x8000258)
```

### 8. 烧写：在调试会话里根本不会执行

`flash` 之前走的是调试会话，拿到 `Target is in debug mode` 就结束。现在构建/烧写/擦除
走 4824 的非调试会话；实测 `0x5001` 完成帧 + 无失败帧时报 `Flashed OK`。

### 9. `-5` 转换：把输入当输出

`convert` 的「期望产物」写成 `TOUCH.uvprojx`（输入本身），所以永远存在、永远「成功」。
现在 `.uvprojx` 上跑 `-5` 直接说明「没有可转换的」。

---

## 四、工程编辑：改得动，但**保存要靠关会话**

这一节是这一轮最费劲的发现。

`PRJ_ADD_GROUP` / `PRJ_ADD_FILE` / `PRJ_DEL_*` / `SET_OPTITEM` 都回 `SUCCESS`，
但 `.uvprojx` 在磁盘上**一个字都不变**。实测排除掉了所有其他可能：

- `GEN_EXIT`（接口自己的退出）：进程退出、文件回写成**空组**，`Files` 没了；
- 强制杀进程：丢失；
- 用命令行 `-b` / 空跑到同一工程：文件不变；
- `close_project` + 2.5 s 等待：仍然不变。

也就是说 uVision 把编辑攒在内存里，退出时按它自己的时机写盘，写不写、什么时候写不受
接口控制。**结论不是「已实现」，是「接口能改，落盘不可靠」**，所以在文档和工具输出里
如实写成这样：

- `keil_project` 的编辑会立即在会话内生效；
- `close` 会报告是否真的写入了文件（对比关闭前后字节）；
- 不保证写入。

### 另外两条实测的编辑限制

1. **一个文件只能出现一次**。`PRJ_ADD_FILE` 对工程里任何组已存在的文件回
   `ALREADY_PRESENT`。现在会在本地先查并说明「它在 USER 组里，uVision 不允许重复列出」，
   而不是把 `ALREADY_PRESENT` 直接抛给用户。
2. **`PRJ_DEL_FILE` 要 `{组, 文件名}`**，且删的是工程级的那个条目。
   只给文件名会被当成组名，回 `NOT_FOUND: Group 'x'`。
3. `PRJ_ENUM_FILES` 要 `SSTR` 而不是 `PRJDATA`，而且**只在调试会话里可用**——
   而所有编辑在调试会话里被拒。所以「列出组里的文件」改为直接读 `.uvprojx`（uVision
   写的也是同一份），编辑仍走 uVision。

---

## 四之二、对照过网上的 Keil skill 之后补的两处

公开的 Keil skill（`zhinkgit/embeddedskills`、`changde-tang/embedded-skills`、
`student-He-1/embedded-agent-skills` 等）走的都是 `UV4.exe -b/-r/-c/-f` 这一层，
和我们最早的路径重合；UVSOCK 那一层它们没有。对照下来有两点它们做对了、我们原来没做：

**1. UV4 的退出码 1 是「带警告构建成功」，不是失败。** 我们只认 0，于是
「有一个未使用变量、镜像正常生成」的工程被判成构建失败、产物被丢掉。现在按 UV4
自己的码表：`0` 干净、`1` 有警告、`2` 错误；其他工具仍然只认 0。

**2. 构建日志不是 UTF-8。** UV4 用系统 ANSI 代码页（中文 Windows 上是 GBK）写日志，
而且**同一条源码引用行里 ASCII 和 GBK 混排**。按 UTF-8 读，中文注释全变成替换符。
现在按字节判断：整体是合法 UTF-8 就按 UTF-8，否则按 GB18030（GBK 的超集）。

另外补了一项它们都有、我们没有的：**构建前的工程静态检查**。`embed_project` 现在会核对
`.uvprojx` 里列出的每个文件、每条 include 路径是否真的在磁盘上，并指出空组。
这条不是理论上的——我在这次审计里就用错的报文把启动文件从工程里删掉过，
构建失败报的是「scatter 文件里没有 FIRST/LAST 段」，指不到真正的原因。

它们没做、我们有的：调试器全部操作（断点、单步、寄存器、变量、栈、内存、命令语言）、
工程结构编辑、烧写判定。它们把烧写交给 J-Link/OpenOCD，我们用工程自带的算法。

## 五、其余已接通的能力
### 调试（`keil_debug`，47 个动作）

`open` / `run` / `continue` / `halt` / `reset` / `run_to` / `step*` / `breakpoints` /
`breakpoint_add` / `breakpoint_delete` / `watch_add` / `registers` / `register_read` /
`register_set` / `variables` / `stack` / `where` / `read` / `write` / `evaluate` /
`command` / `variable_set` / `tasks` / `trace` / `trace_set` / `disassemble` / `menus` /
`menu_exec` / `time` / `license` / `version` / `window` / `build` / `rebuild` / `clean` /
`clean_rebuild` / `export_cprj` / `symbols` / `convert` / `flash` / `erase` / `sessions` /
`close` / `close_project`。

### 命令通道

`action: "command"` 直接执行 uVision 命令语言（`BS`/`BA`/`BL`/`BK`/`SAVE`/`LOG`/
`COVERAGE`/`LOGICAnalyze`…）。实测 `BL` → `0: (E 0x08006BE0) 'main', CNT=1, enabled`。
`EXIT` 会让 uVision 自己退出调试而会话不知道，现在会同步状态。

### UV4 命令行

`-b`/`-r`（全量重译）/`-c`/`-cr`/`-f`/`-X`/`-X1`/`-et`/`-ep`/`-5`/`-t`/`-l`/`-j0`/`-sg` 已接。
`-et` 在该工程上退出 0 但什么都不写，按「没写出文件就是失败」报。

**未接**：`-i`/`-n`/`-np`（会创建或改写工程，属破坏性操作）、`-q`/`-z`（`.uvmpw`
多工程，本机没有可实测的工程）、`-d`/`-x`/`-y`（DDE，被 UVSOCK 完全覆盖）。

### CMSIS-Toolbox

`G:\software\keil5\ARM\cmsis-toolbox\bin` 里的 `cbuild 2.10.0`、`cpackget 2.1.8`、
`svdconv 3.3.48` 成为一等工具链；`*.csolution.yml` / `*.cprj` 成为新的工程类型；
`embed_packs` 能装包（`cpackget add --agree-embedded-license`，失败时它仍回 0，所以看 `E:` 行）。

顺带修掉：工程探测向上走五层会把**另一个无关目录**的 `.csolution.yml` 当成当前工程
（测试里两个临时目录真的串了）。

---

## 六、接口清单与覆盖

88 个公开操作码：**71 个已接通并实测**，**14 个在该版本上不可用**（逐个带实测理由），
**3 个需要前置条件**（extended stack mode）。没有「定义了但从没调用」的。

### 该版本上真的不工作

| 操作 | 实测 |
|---|---|
| `DBG_READ_REGISTERS` | 忽略名字，对 `PC`/`SP`/`R0,R1` 都回 `0x00000001`；改用枚举 |
| `DBG_VTR_GET` | 回 `Unknown VTR-name`，即使名字是它自己枚举出来的 |
| `DBG_EVAL_EXPRESSION_TO_STR` / `DBG_EVTR_GETSTATUS` | 永不回复 |
| `DBG_ENUM_SYMTP` | 回 `PARSE_ERROR`（缺该版本不暴露的 symbol-table id） |
| `DBG_FILELINE_TO_ADR` | 相对/绝对路径都回 `NO_ADRMAP` |
| `DBG_VERIFY_CODE` | 仿真器目标上回 `FAILED` |
| `DBG_STEP_INTO_N` | 头文件注明不带计数；`_HLL_N`/`_INSTRUCTION_N` 可用 |
| `PRJ_ACTIVE_FILES` / `PRJ_LOAD` / `PRJ_CMD_PROGRESS` | 只在非调试会话可用 / 由启动行打开 / 是通知不是命令 |
| `DBG_WAKE` / `DBG_SLEEP` / `DBG_SET_CALLBACK` | 仿真器专有，接受但无可观察效果 |
| `PRJ_FLASH_ERASE` | 从不回复 |

### 需要 extended stack mode 才有意义

`DBG_ENUM_VARIABLES`、`DBG_VARIABLE_SET`、`DBG_ENUM_TASKS`、
`DBG_EVAL_WATCH_EXPRESSION`、`DBG_REMOVE_WATCH_EXPRESSION`。
会话在进调试前自动打开这个模式。

---

## 七、仍然做不到的

- **编辑源文件**：uVision 的编辑器没有 API；源码改动走本产品自己的文件工具。
- **可靠保存工程编辑**：见第四节。接口能改，落盘时机不受控制。
- **一个文件挂到两个组**：uVision 不允许。
- **`PRJ_FLASH_ERASE`**：接口不回复；下载本身会擦除它写的扇区。
- **寄存器写入**：`REGISTER_SET` 对 R0 一路回 SUCCESS 却不改变值（`R0 = 0x42` 走命令
  窗口可以）；工具会明确报「接受了但读回没变」，命令通道是可行替代。
- **局部变量**：该目标上调试器对任何帧都只报全局（`nVars` 恒为 0），接口层无从列出。
- **多 Target 工程**：`set_target` 已接，只在单 target 工程上实测过。

---

## 八、验证

`tests/round12-uvsock.test.ts`（41 条）把每个实测到的字节形状固定成断言：pack(1) 的
`REGENUM`/`VSET`/`VARINFO`/`STACKENUM` 偏移、`AMEM` 反汇编是文本、`IVARENUM` 的 count、
`PRJDATA` 的长度、`ALREADY_PRESENT` 的组归属、栈的顺序、寄存器别名查找。

全量测试 780 条、778 通过、2 条原有条件跳过、0 失败。

端到端（真实 MDK 5.43a + 真实 STM32F429 工程，取副本）：

```
keil_debug open            → 进入仿真器调试
keil_debug breakpoint_add  → 断点设在 main
keil_debug run             → 停在 SystemInit system_stm32f4xx.c:174
keil_debug stack           → #0 SystemInit …  #1 Reset_Handler …:200
keil_debug variables       → 36 个全局，带类型与数组长度
keil_debug watch_add "$"   → watch #… = 0x08006460
keil_debug disassemble     → 源码行 + BL.W 0x08000A54 HAL_Init
keil_debug variable_set    → uwTick = 0x00003039（回读确认）
keil_debug flash           → Flashed OK
keil_project add_file/close→ 编辑生效；close 报告是否写盘
```

---

## 九、边界没有变

- 安装包里没有任何 Keil 二进制、器件包或编译器；不下载、不重分发。
- 探测只读：默认路径 + `TOOLS.INI` + 注册表 `HKLM\SOFTWARE\WOW6432Node\Keil\Products\MDK`。
- 没有 Keil 的机器上，`keil_debug` 直接说明情况，并指向 OpenOCD / pyOCD / J-Link 链路。
