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

> 第十轮复核（本机 STM32F429）：`R0` 回 `SUCCESS` 但读回仍是旧值
> （`0x200003A8` 写 `0x42` 后没变），`R15 (PC)` 回 `Register index is out of range`。
> 两种失败都如实报出；命令窗口的 `R0 = 0x42` 实测生效。

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

## 四之三、第三轮复审又找出来的三处

这一轮把每条链路的输出拿调试器自己的命令窗口（`EVAL`）当第二来源逐个对了一遍。

**1. 任务列表恒为空——而且是上一轮我「修」出来的。** 实测任务帧是
`nItem(4) nAdr(4) nRetAdr(4) nVars(4) len(4) 文本@20`；我上一轮把名字改到 40，
越过文本了，于是 `tasks` 一律回「没有任务」。现在回 `#0 Main Thread`。

**2. `write` 回读不一致仍报成功。** 写内存后回读不同，说明这块区域拒写（只读、
写保护、位被屏蔽），原来照样报「wrote」。现在回读不一致就是失败。

**3. 烧写的判定只靠「过程结束」这一帧。** `0x5001` 是下载结束时发的，失败时也发；
真正的证据是前面有没有 `Flashed OK`／失败文本。现在先查失败文本再认结束帧，
并且**下载后把芯片里的前 64 字节读回来，和 `.hex` 逐字节比**：

```
Flashed OK
Flash Load finished at 20:41:14
flash check: flash at 0x8000000 matches …\OBJ\TOUCH.hex for 64 byte(s)
```

这个对照必须从镜像的加载地址比，不能从文件第 0 字节比——`.axf` 是 ELF，
开头是 `7f 45 4c 46`，拿它比会在烧写完全正确时报不一致。

顺带一提：这台机器上**接了一块 ST-Link**（设备列表里的 `STM32 STLink`，COM7），
所以这里的烧写结论是在真实板子上得到的，不是模拟器。

## 四之四、第四轮：查「用户能不能走到」

前三轮查的是「代码对不对」，这一轮查的是「**有没有入口**」。我写了一个可达性审计:
把 Keil 层导出的每个函数拿去全仓库找调用点,结果 **16 个导出函数没有任何调用**——
写好了、测过了、也贴着「已接通」,但没有任何工具动作能触发它们。

逐个在真实会话上验过之后,分三类处理:

**确实可用、只是缺入口的,补成动作:**

| 新动作 | 实测 |
|---|---|
| `keil_project targets` | `* TOUCH`(列出全部目标并标出当前) |
| `keil_project set_output_name` | 写入后回读核对 |
| `keil_debug watch_remove` | 实测**要表达式本身**,不是 `watch_add` 给的 id |
| `keil_debug trace_get` | 读得到目标自己枚举的 `CURR_TID`/`STCLK`/`STLINK_PM`/`CORE_CLK`/`TRACE_CLK`；`TRAPS` 不在枚举里，被拒 |
| `keil_debug itm` | 通道模式字必须是 0;之前发的 1 被拒(`16Bit Mode not supported`) |
| `keil_debug event_recorder` | 启动后列出 SCVD;没有就是「这个镜像不描述事件」 |
| `keil_debug show_code` | 在 IDE 里定位到地址 |

`set_target`/`output_name` 等原本就有,但 `info` 里只说「去跑 groups」,没有把目标列表、
输出名、组列表放在一处——现在 `info` 一次给全。

**实现本身就是错的:**

- `debugTargetKind` 读 `PRJ_GET_DEBUG_TARGET` 的首字,实测**硬件和仿真器都回 1**,
  按它判断会给出看似合理的错答案。改成用会话自己记录的 target。
- `removeWatch` 按 id 删,实测 `NOT_FOUND`;按表达式删才是 `SUCCESS`。
- `sendRegisterSet` 对非数字静默发 0——现在报错而不是写一个猜测值。

**真的没法接的,在代码里写明原因而不是留着:**

- `cancelBuild`:`PRJ_BUILD_CANCEL` 无构建时回 `FAILED`;而构建在单次调用里跑完,
  没有第二个调用能插进去的窗口,取消就是超时。
- `closeProject`/`PRJ_CLOSE`:只在非调试会话可用,而这时关掉 uVision 就是关闭会话本身。
- `ideVersion`:只回一串版本号,`version` 动作已经覆盖。
- `buildProject`/`sendRegisterSet`/`getKeilSession`/`filesInGroupFromProject`:已删除。
  它们没有任何调用者,而且各自的能力在别处已经有了(构建走 `-b`/`-r` 的 CLI 路径,
  写寄存器走 `writeRegister` 并回读核对,会话按 key 查是内部细节)。
  留着它们只会让「实现了」看起来比「能被用到」多。

**顺带修掉一个我自己造成的破坏**:测 `set_output_name` 时把 `..\OBJ\TOUCH.axf`
整个写进了 `OutputName`,工程变成 `..\OBJ\..\OBJ\TOUCH.axf` 而无法加载。
`OutputName` 只收文件名,`OutputDirectory` 是另一个选项;现在输入会被截成文件名,
并且写入后**回读核对**,不一致就报失败。这个 bug 是被新加的核对当场抓到的。

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
| `DBG_VTR_GET` | 只认 `DBG_ENUM_VTR` 列出来的名字；`TRAPS` 这类名字**不在**该列表里，回 `Unknown VTR-name` |
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
- **工程编辑立即落盘**：见第四节。接口能改，落盘时机不受接口控制——只在 uVision
  退出时写 `.uvprojx`。这一点已经用字节比对证实（见第五节之五），不是推断。
- **一个文件挂到两个组**：uVision 不允许。
- **`PRJ_FLASH_ERASE`**：接口不回复；下载本身会擦除它写的扇区。
- **寄存器写入**：`REGISTER_SET` 在这块板子上两种失败都出现过——`R0` 回 `SUCCESS` 却
  **不改变值**（`0x200003A8` 写 `0x42` 后仍是 `0x200003A8`），`R15 (PC)` 直接**被拒**
  （`Register index is out of range`）。工具按「接受但读回没变 / 被拒」两种说法分别报出来，
  不会当成成功。命令窗口的 `R0 = 0x42` 实测生效（读回 `0x00000042`），是可行替代。
- **局部变量**：该目标上调试器对任何帧都只报全局（`nVars` 恒为 0），接口层无从列出。
- **`-et` / `-ep` 导出 cprj**：MDK 5.43a 上退 0、零输出、不写文件；带不带 `-j0`/`-o`、
  相对或绝对路径、指定或不指定 `-t` 都一样。调试会话里的菜单模型也没有这一项。
  工具按失败报，不会当成成功。

---

## 五之五、第六轮：把「没验证的」逐条验证掉

这一轮只做一件事：之前列了四项「尚未验证」，逐条拿真机证据坐实或推翻。

### 1. 多 Target 工程 —— 已实测通过

造了一个双 Target 工程（`TOUCH` / `TOUCH_SIM`，各自的 `OutputDirectory`），
在 MDK 5.43a 上跑：

```
projectTargets            → ["TOUCH","TOUCH_SIM"]
currentTarget             → "TOUCH"
getOption CINCL TOUCH     → 16 个 include 路径
getOption CINCL TOUCH_SIM → 独立的一套
setTarget("TOUCH_SIM")    → SUCCESS，currentTarget 随之变成 TOUCH_SIM
setOption COPTIMIZE=2 @TOUCH_SIM
  → TOUCH_SIM 读回 "2,0 [Optimize, OptTime]"
  → TOUCH     读回 "0,0 [Optimize, OptTime]"（未被污染）
关闭后 .uvprojx → <Optim>1</Optim> / <Optim>3</Optim>（各 Target 分别落盘）
```

顺带发现并排除一个假象：手工拼出来的第二个 `<Target>` 块如果丢了 BOM 或字段顺序，
uVision 会静默拒绝打开，接口只会回 `NO_PROJECT`。这不是代码缺陷，但值得知道——
`projectTargets` 返回空数组时，`info` 现在会显示「没有 Target」而不是假装工程正常。

### 2. `csolution` / CMSIS-Toolbox —— 已实测通过，并修掉两个真缺陷

先用 `cpackget` 把包装进它自己的 store（`ARM.CMSIS`、`ARM.CMSIS-Compiler`、
`Keil::STM32F4xx_DFP`），再用一个最小 csolution 工程走产品自己的 `build()` 路径。
过程中暴露两个**此前完全没被测到的缺陷**：

1. **`cbuild` 找不到编译器。** 它不打任何路径猜测，要求
   `<name>_TOOLCHAIN_<major>_<minor>_<patch>` 环境变量。之前没有任何代码设它，
   所以任何 csolution 工程都必然 `error cbuild2cmake: compiler registration
   environment variable missing` —— 而 `armclang --version` 明明是好的。
   现在 `toolEnv.ts` 从 Keil 安装目录识别 AC6/AC5，用**编译器自己的版本号**
   （`Component: Arm Compiler for Embedded 6.24`）注册，用户已显式设过的变量不覆盖。

   > 踩到的坑：`armclang --version` 第一行是 `Product: MDK Plus 5.43`，
   > 那是 IDE 版本。第一版抓到 5.43，注册成 `AC6_TOOLCHAIN_5_43_0`，
   > `cbuild` 照样说「没有注册 AC6」。

2. **产物发现不到。** `out/**/*.elf` 里的 `**` 被当成普通通配（只能匹配一层），
   而 csolution 的输出是 `out/<project>/<target>/<build>/`。构建报成功、`artifacts`
   却是空数组。现在 `**` 会递归（限 6 层），并且 csolution 的 pattern 补上了
   `.axf`（Arm 的链接器默认就产出 `.axf`，不是 `.elf`）。

修完后清掉 `out/` 与 `tmp/` 重跑：

```
ok: true  exit: 0
artifacts: out/Demo/MyBoard/Debug/Demo.axf, out/Demo/MyBoard/Debug/Demo.hex
Build summary: 1 succeeded, 0 failed
```

### 3. `-et` / `-ep` 导出 cprj —— 确认**不可用**，如实报失败

在真工程上把能想到的组合都试了：`-et` / `-ep`；带 `-j0` / 不带；带 `-o` / 不带；
相对路径 / 绝对路径；指定 `-t <target>` / 不指定。**全部退 0、零输出、不产生任何
`.cprj`。** 菜单模型里也没有 `Project → Export → Save Project to CPRJ` 这一项
（`readMenus` 只回了 12 个条目，过滤 `cprj|export` 为空）。

`keilCli` 本来就把「该产文件却一个都没产」判为失败，所以工具层是诚实的；
这一轮补的是文档和一条测试，把结论固定下来。

### 4. 硬件调试链路 —— 已用真芯片验证，并修掉一个**假完成**

先用独立于 Keil 的证据确认板子真在线：
`STM32_Programmer_CLI -c port=SWD` → `Device name: STM32F42xxx/F43xxx`、
`Flash size: 1 MBytes`、`Voltage 3.26V`。然后走 uVision 自己的 ST-Link 驱动。

实测通过的：

```
enterDebug(hardware)        → debugging: true
addBreakpoint("UI_Update")  → SUCCESS
run()                       → stopped, reasonCode=1 (breakpoint), PC=0x08006994
currentLocation             → ui.c:497
step over / instruction     → 0x08006996 → 0x0800699E → 0x080069A0，行号同步
readStack                   → #0 0x08006994 … #1 0x0800699E
readVariables               → LTDC_Handler / DMA2D_Handler / lcdltdc / ltdc_lcd_framebuf …
addressToSource(0x08006994) → ../HARDWARE/UI/ui.c:497 UI_Update
readMemory(0x08000000)      → a8 09 00 20 55 02 00 08 …（正确的向量表）
```

**修掉的那个假完成**：`breakpoint_add main.c:38`。uVision 不把 `file:line` 当位置，
它当 C 表达式求值，回 `SUCCESS`，然后在命令窗口打
`*** error 52: left side of '.' requires struct/union`，什么都没有创建。
旧实现只看 `DBG_CREATE_BP` 的状态码，于是报告「断点已设」——用户去跑，永远不会停。

现在：

- `file:line` / `file(line)` 先经 `fromelf --text -g` 的 DWARF 行号表解析成地址
  （`DBG_FILELINE_TO_ADR` 对任何路径都回 `NO_ADRMAP`，这是唯一可用的映射源）。
- 文件按**路径后缀**匹配，`main.c` 和 `USER/main.c` 都能找到镜像里的
  `../USER/main.c`，不同目录的同名文件不会串。
- 行号不存在时，把该文件真实的可执行行列出来；文件不存在时，把镜像里有哪些文件
  列出来。
- 创建后仍会读 `*** error N:` 与断点列表交叉验证，两者都不支持「已创建」时判失败。

实测：

```
add "main.c:38"  → true  → 0x08006bf8
add "ui.c:497"   → true  → 0x08006994
add "main.c:9999"→ false → main.c has no line 9999; its executable lines are 35, 36, 37, …
add "nosuch.c:10"→ false → no source file matching "nosuch.c" is in the image; it knows …
run()            → 停在 0x08006BF8，正好是 main.c:38
```

### 5. 工程编辑落盘 —— 拿到字节级证据

```
打开会话 → addGroup("PROOF_GROUP") → SUCCESS
  此刻 .uvprojx：25271 字节，mtime 不变，组列表里没有 PROOF_GROUP
关闭会话 → 等 3 秒
  .uvprojx：24669 字节，组列表末尾出现 PROOF_GROUP
```

同一行为在第二轮复现（`PROOF_TWO`）。`closeAndReport` 现在会把「已写盘」与
「文件没变（本来就没有编辑，或已经在盘上）」分开说，不再让两者看起来一样。

### 6. 多 Target 工程里的**调试** —— 又查出一条没验证的路

上一轮只验证了「切换 Target 的选项」，没验证「调试哪一个 Target」。补测：

- 调试器加载的镜像跟着**当前 Target** 走。实测日志：
  当前是 `TOUCH` 时 `Load "..\OBJ\TOUCH.axf"`；`set_target TOUCH_SIM` 之后
  变成 `Load "..\OBJ_SIM\TOUCH_SIM.axf"`。
- 也就是说 `keil_debug open` 没有自己的 target 参数，它用的一定是当前那个。
  原实现在这里什么也没说——切完 Target 直接调试，很容易以为自己调的是另一个。
  现在 `set_target` 会回读确认（回 `SUCCESS` 但没切过去就判失败），
  并明确说「下一次调试会加载 `<路径>`」。
- 顺带修掉一个会读错镜像的 bug：`imageLocation` 原来读工程文件里**第一个**
  `<OutputDirectory>`，双 Target 工程里就固定指向第一个 Target 的产物。
  `file:line` 断点是靠它解析地址的，切到第二个 Target 之后会拿错误的镜像去
  解析行号。现在按当前 Target 的 `<Target>` 块取。实测切换后分别得到
  `..\OBJ\TOUCH.axf` 与 `..\OBJ_SIM\TOUCH_SIM.axf`。

### 7. 再确认一遍：又找到三处

- **五个导出函数没有任何调用者。** `getKeilSession`、`buildProject`、`sendRegisterSet`、
  `filesInGroupFromProject` 全部删掉——能力在别处已有（构建走 CLI 路径、写寄存器走
  `writeRegister` 并回读核对）。`closeAllKeilSessions` 保留：它给没有会话句柄的
  调用方（探测脚本、测试、退出）用，而「忘了关会话」正是编辑丢在内存里的原因。
  文档之前把它们写成「辅助函数，没有独立能力」，那是敷衍——它们是死代码。
- **那张「本版本不支持」的表没有任何读者。** 记录了 13 条，但没有任何代码路径会
  把它呈现给用户。现在 `keil_debug action: capabilities` 会列出：能用的、要先进调试
  的、明确被拒的（带原因）、以及要先开 extended stack 的。动作数 53 → 54。
- **表里有一条被我自己判错了，现已改回。** 上一轮把 `DBG_VTR_GET` 判成「表写错了」，
  依据是一次 `TRAPS` 回 `SUCCESS`。再测一遍，目标 `DBG_ENUM_VTR` 列出的只有
  `CURR_TID`、`STCLK`、`STLINK_PM`、`CORE_CLK`、`TRACE_CLK`——**`TRAPS` 不在其中**，
  读它回 `Unknown VTR-name`。表原本是对的，那条「更正」才是错的。现在条目保留，
  但把理由写准：它只认枚举里的名字。

另外核对了 `DBG_READ_REGISTERS` 那条：「对 R0 / PC / SP 都回同一个
`0x00000000`」——解码原始字节确认属实，结论保留。

动作可达性也重新交叉检查了一遍：`keil_debug` 54 个动作、`keil_project` 14 个，
每个都有分支，也没有「有分支但没声明」的动作；两个工具确实在 `ALL_TOOLS` 里。

### 这一轮补的测试

`tests/round12-uvsock.test.ts` 从 41 条增到 49 条，新增覆盖：`file:line` 解析、
`fromelf` 行号表解析（含 `00000000:` 头行被丢弃）、行号/文件不存在时的错误文案、
缺少镜像与缺少 `fromelf` 的失败路径、编译器注册（含「不覆盖用户变量」）、
`**` 递归产物发现、多 Target 工程按当前 Target 取镜像、能力报告可读且不误列可用操作。

全量 792 条，790 通过，2 条原有条件跳过，0 失败。

---

## 八、验证

`tests/round12-uvsock.test.ts`（49 条）把每个实测到的字节形状固定成断言：pack(1) 的
`REGENUM`/`VSET`/`VARINFO`/`STACKENUM` 偏移、`AMEM` 反汇编是文本、`IVARENUM` 的 count、
`PRJDATA` 的长度、`ALREADY_PRESENT` 的组归属、栈的顺序、寄存器别名查找、
`file:line` → 地址的解析、`cbuild` 的编译器注册、`**` 产物发现。

全量测试 781 条、779 通过、2 条原有条件跳过、0 失败。

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

## 八之二、第八轮：全面重扫，八处已修 + 一处 Keil 侧缺陷
这一轮换角度重扫（可达性、参数一致性、失败语义、字节布局、真机逐动作），每一条都是先造出
会失败的测试再改。

**1. `detectProject` 会把兄弟目录的工程当成当前工程。** 从 `projB/work` 向上走到 `projB` 的
父目录时，`findProjectFile` 会再向下看一层，于是 `projA/P.uvprojx` 被当成「当前工程」。
`keil_project info` 会报别人目录的目标，编辑也会写到那个工程上。csolution 分支早就为同一个
问题加过 `dirname(...) === dir` 的防护，厂商分支漏了。现在向上查找只接受**包含**起点的
那些工程。

**2. `add_file` 的文件路径按工作区解析，不按工程解析。** 工程在 `USER\` 下时，传入
`USER/probe_add.c` 会被 uVision 原样写入，解析成 `USER\USER\probe_add.c`——不存在的文件。
工具回「added」，直到构建失败才暴露。现在按磁盘上真实存在的解释定位，写入工程相对路径。

**3. `set_output_name` 把每一次成功都报成失败。** `PRJ_GET_OUTPUTNAME` 回的是整条路径
（`..\OBJ\app.axf`），而比对用的是裸文件名。实测：改名成功，工具却报「nothing was changed」。

**4. `breakpoint_add` 的 watchpoint 是假成功。** `DBG_CREATE_BP` 对符号名（`uwTick`）回
`SUCCESS` 但一个都不创建；地址形式（`0x20000000`）才生效。现在创建后读断点列表核对，
没新增就判失败并说明用地址。

**5. `breakpoint_delete` 丢掉了回复。** 删不掉时（`BP_NOTFOUND`）也回成功。现在读回复并
重新枚举列表核对。

**6. `erase` 等一批动作失败时不返回 `isError`。** 十几个分支只把「失败」写进文案，调用方
（agent）看不到。现在统一走一个失败标记，工具结果带上 `isError`。

**7. 工程会话的编辑对调试会话不可见。** 编辑只在 4824 那个 uVision 的内存里，调试器从磁盘
加载工程——实测：编辑会话读得到新 define，调试端口上全新的 uVision 读到旧值。现在进入调试
前先把同一工程的编辑会话关闭落盘。真机验证：`add_group` 之后 `open`，磁盘上立刻有该分组，
调试器也看得到。

**8. `symbols_all` / `export_cprjs` 有实现没入口。** `keilCli` 里 `-X1`/`-ep` 完整，
但动作枚举里没有。已补，真机跑通。

另外两处修正：

- **只做增量构建时 RAM 少报 2 MB。** `fromelf -z` 的 `ROM Totals` 行 ZI 恒为 0，真实 ZI
  在上一行的对象行里。旧代码取 totals 行，得到 108 字节而不是 2 MB。旧的单元测试还把这个
  错值当成正确答案断言了——一并更正。
- **`DBG_VTR_GET` 的结论上一轮被我判反了。** 目标枚举的是 `CURR_TID`/`STCLK`/
  `STLINK_PM`/`CORE_CLK`/`TRACE_CLK`，**`TRAPS` 不在其中**。表原本是对的，那条「更正」才错。

### 一条 Keil 侧的缺陷，改不了但要说清

**核心停在某个断点上再 `run`，它不动，uVision 也不发停止帧。** 实测：`DBG_START_EXECUTION`
回 `SUCCESS`，`DBG_STATUS` 一直报「运行中」（1），而 `DBG_STOP_EXECUTION` 立即返回、PC 与
运行前一模一样。命令通道的 `G`、删除全部断点后重跑都一样。真机连续多次、重置后重试都是这个
结果。

工具现在会指出这一点：PC 前后没变、且该地址上有断点，就明确说「核心停在断点上没动，先单步
一步或删掉那个断点再跑」，而不是只回一句「没停下」。

### 这一轮补的测试

`tests/round12-uvsock.test.ts` 从 49 条增到 57 条，新增覆盖：兄弟目录不误识别、文件路径按
工程解析、输出名按文件名比对、watchpoint 以列表为准、`run` 的第二条通道、只做增量构建时的
ZI、`TRAPS` 的真实归属。另有 `tests/round12-close.test.ts` 固定「先退出调试再关进程」。

全量 801 条、799 通过、2 条原有条件跳过、0 失败。

---

## 八之三、第九轮：换角度再扫，又五处

这一轮按「同一份数据的两条路径是否一致」「写操作的回读」「枚举与求值是否对得上」重扫。

**1. 多 Target 工程的分组列表重复。** 每个 `<Target>` 块各带一份 `<Groups>`，直接对整个
文档做正则，`groups` 回 `USER, CORE, USER, CORE`。现在按当前 Target 的块读。同一处修正也
应用到了 `files`、`allProjectFiles`、`imageLocation`。

**2. `clean` 一直绕道 CLI，而接口版 0.4 秒就能做完。** `PRJ_CLEAN` 实测回 `SUCCESS` 并推
同样的报告与完成帧，从未被代码发送过。现在 `keil_debug clean` 走会话内的接口。

**3. 变量列表把地址当值打印。** 结构体的值是 `0x20000240 &LTDC_Handler`，数组的是首元素
地址（`0xC0000000`）。打印成「= 0xC0000000」会让人以为这是它的数值。现在如实写成
「struct at …」「array at …（N 个元素）」。

**4. 栈帧里的 `variables` 是假的。** 真实 48 字节帧是
`nItem(4) nAdr(8) nRetAdr(8) 源码文本@20`——**没有计数字段**。旧代码把 20 处当整数读，
得到 `840967456`，正是源码文本 `"   dot = …"` 的前四个字节。工具没显示它，所以一直没被
发现。现在读出的是源码行，并附在 `stack` 的输出里。

**5. `where` 只给地址，不给文件名。** `currentLocation` 用自己的一套偏移找文件名，在真实
回复上找不到；同一地址走 `addressToSource` 就能拿到 `../HARDWARE/UI/ui.c:497 UI_Update`。
现在两条路径统一。

**6. 求值失败被当成值打印。** 两个求值器对坏表达式都回
`_____^ *** error 34: undefined identifier`，工具原样写成 `uwTick = _____^ *** error …`，
读起来像算出了一个值。现在识别为失败并报原因。

顺带确认一件事：**`uwTick` 这类 HAL 的 `__IO`（volatile）全局在这个求值器里读不出来**
（`Error in expression` / `undefined identifier`），即使核心正停在 `main` 里也一样；同一份
列表里的 `SystemCoreClock`、`main` 都能求值。这是 Keil 侧的限制，`variables` 读它的值和
地址仍然正常。

---

## 八之四、第十轮：写 Flash 的「成功」是假的，与探针掉线的关系

这一轮查的是**写操作的回读到底证明了什么**，结果推翻了一个一直当作已完成的结论。

### 1. `write` 到 Flash 区会「成功并读回一致」，而芯片没变

复现步骤与证据：

```
会话 A：read  0x08000000 → a8 09 00 20 55 02 00 08
        write 0x08000000 = de ad be ef → "wrote 4 byte(s) and read them back"
        read  0x08000000 → de ad be ef 55 02 00 08   ← 会话 A 里"生效"了
关掉会话 A，另开会话 B：
        read  0x08000000 → a8 09 00 20 55 02 00 08   ← 芯片根本没变
用 STM32CubeProgrammer 直接读芯片：
        a8 09 00 20 55 02 00 08                       ← 外部工具确认
```

**同一进程里的第二个会话也是这样**：A 写 → A 读回一致 → B 读回原值 → B 写 → B 读回一致。
两个会话各有一份自己的「影子」，谁也不代表芯片。

而在**新起的会话**里，同样的写入会正确报「读回不一致」：

```
trial 1/2/3: before a8 09 00 20 … | write false (read-back differs) | after a8 09 00 20 …
```

也就是说，回读校验本身是有效的，但它验证的是**调试器自己那份内存视图**，不是 Flash。
把「写后回读一致」当成「写进芯片了」，是这个项目里最像成功的一处假完成。

**结论**：`write` 对 Flash 区不可信，工具的输出不能证明芯片内容。要改 Flash 只能用下载
（`flash`）或擦除+下载。这一条已经写进工具与文档，`write` 的说明会点明它靠不住。

### 2. 探针为什么老是掉线

同一批实验里，写 Flash 之后紧接着出现：

- uVision：`Flash Download failed - Target DLL has been cancelled`
- STM32CubeProgrammer：`ST-LINK error (DEV_USB_COMM_ERR)`

连写几次之后探针进入错误状态，需要等待若干秒（有时要重新插拔）才恢复。两次掉线都发生在
对 Flash 区做写入之后，而不是普通读、断点、单步、下载之后。所以「掉线」不是随机的，是这组
操作把 ST-Link 弄进错误态。

---

## 九、边界没有变
- 安装包里没有任何 Keil 二进制、器件包或编译器；不下载、不重分发。
- 探测只读：默认路径 + `TOOLS.INI` + 注册表 `HKLM\SOFTWARE\WOW6432Node\Keil\Products\MDK`。
- 没有 Keil 的机器上，`keil_debug` 直接说明情况，并指向 OpenOCD / pyOCD / J-Link 链路。
