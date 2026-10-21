# Keil MDK：无头能做的全部事

日期：2026-10-21。上一版只做到「探测 + 用 `UV4 -b` 构建」。这一版把 Keil 自己公开的
**远程控制接口（UVSOCK）** 接通了：断点、单步、寄存器、变量、内存、栈、地址到源码行、
工程结构编辑、编译选项读写、在 IDE 里构建与烧录。全部在无头会话里完成，不需要 uVision
窗口，也不打包、不分发任何 Keil 二进制。

---

## 一、先回答「无头到底能做什么」

Keil 自己没有 Linux 那种「一个命令做所有事」的入口。它公开的是三类东西，能力边界很清楚：

| 入口 | 能做什么 | 不能做什么 |
|---|---|---|
| `UV4.exe -b/-r/-c/-f/-d/-i/-n/-et/-ep/-X` | 构建、重译、清理、烧录、进调试、用 XML 导入/新建工程、导出 cprj、生成预处理器符号文件 | 断点、单步、读变量（`-d` 只是进调试，命令要另给） |
| `fromelf.exe`、`armclang.exe`、`armlink.exe`、`armasm.exe`、`armar.exe`、`UV4\SVDConv.exe`、`PackInstaller.exe` | 读镜像尺寸/符号/反汇编、单独编译、链接、打包、生成 SVD | 驱动调试器；`fromelf` 也不在 `UV4.exe` 旁边 |
| **UVSOCK（TCP）** | 调试器的全套操作 + 工程模型 + 每一类编译选项 | 编辑器里没有暴露成 API 的 GUI 专属功能 |

第三类是这个产品的关键。`UVSC64.dll` 导出的符号表和公开的 `UVSOCK.h` 说明了它覆盖什么，
本轮把其中有意义的部分逐个接通并实测。

**启动方式**（文档 `uv4_commandline.html` 的 `-s port`）：

```
UV4.exe <project.uvprojx> -s 4823 -j0
```

`-j0` 压住 GUI 和对话框，`-s` 打开 TCP 监听。实测约 4 秒后端口可用。

---

## 二、协议本身（全部来自实测，不是照抄头文件）

一个消息 = **32 字节头 + 负载**：

```
偏移  长度  字段
 0     4    m_nTotalLen   整条消息长度（含头）
 4     4    m_eCmd        操作码
 8     4    m_nBufLen     负载长度
12     8    cycles        仅仿真器
20     8    tStamp        仅仿真器
28     4    m_Id          保留，恒为 0
32     …    负载
```

应答用 `m_eCmd = 0x3000`，负载是 `{ u32 回显的命令, u32 状态, … }`。**应答按回显的命令匹配，
不是按到达顺序**——枚举类命令先回 `^done`，再流式推 `0x50xx` 帧。

### 头文件没写、只能实测出来的五处

这几处第一版全错，而且每一处都产生了一个**看起来合理的错误结果**：

| 现象 | 真实原因 | 实测证据 |
|---|---|---|
| 断点列表永远是 `[]` | 枚举帧可能在 `^done` 之前到达，而从「现在」开始收集会漏掉它们 | 帧在 `send()` 返回前就已入队 |
| 每个停止都是 `reason 0` | `BPREASON` 的 reason 在偏移 12，不是 0；PC 在 16，地址在 24 | 断点命中帧：`1,0,0,1,0x08006460,0x08006460,-1` |
| 寄存器组名是 `"\u0004"` | 枚举帧是 `{u32 长度, 文本}`，长度**不含**结尾 0；`SSTR` 的含 | `04 00 00 00 "Core\0"` |
| 选项读出来是 `TOUCH, A=1,B=2` | `TRNOPT` 的第 0 个字符串永远是 target 名 | 实测 `CDEF` 应答 |
| 每次停止都报「(no source)」 | `AFLMAP` 的文件名不在 40，前面还有保留字 | 实测回复里字符串从 44 开始 |

还有一处不是解析问题而是**语义**：`0xffffffff` 在 `TRNOPT` 里不是「未指定」，`0` 才是。
送 `0xffffffff` 会让 uVision 从一个无意义偏移读出 group 名，回你 `Group 'ÿ'`。

### 状态码

`0` 成功、`6` 未调试、`9` 找不到、`10` 正在调试、`11` 目标运行中、`12` 目标已停止、
`28` 不支持。其中三个不能当失败：

- `12 TARGET_STOPPED` 对 `halt` 是**已经满足的请求**，不是错误。
- `11 TARGET_EXECUTING` 对 `run` 是**已经在跑**，应继续等停止而不是报错。
- `9 NOT_FOUND` 对变量枚举是**没有符号表**，应当作空列表。

---

## 三、接通了什么

`src/embedded/uvsock.ts` 是协议层（封包、字符串、`TRNOPT`、`BPREASON`、内存读写），
`src/embedded/keilSession.ts` 是会话层（把原始命令变成有意义的动作），
`src/tools/keilTools.ts` 是两个工具。

### 调试（`keil_debug`）

| 动作 | 底层 | 实测 |
|---|---|---|
| `open` | `PRJ_SET_DEBUG_TARGET` + `DBG_ENTER` | 硬件与仿真器都能进 |
| `run` / `continue` | `DBG_START_EXECUTION` + 等停止通知 | 停在 `main`，报出源码行 |
| `halt` | `DBG_STOP_EXECUTION` | 已停止时如实说「已经停了」 |
| `step` / `step_into` / `step_instruction` / `step_out` | `DBG_STEP_HLL/INTO/INSTRUCTION/OUT` | 帧级单步从 `main.c:35` 走到 `:38` |
| `breakpoints` / `breakpoint_add` / `breakpoint_delete` | `DBG_ENUMERATE_BP` / `CREATE_BP` / `CHANGE_BP` | 列出 `#1 exec main @ 0x08006be0` |
| 读 / 写 / 访问断点 | `CREATE_BP` 带 `BKTYPE` | 已接 |
| `registers` / `register_set` | `DBG_ENUM_REGISTERS` / `REGISTER_SET` | 152 个寄存器，PC 标出来 |
| `variables` | `DBG_ENUM_VARIABLES` | 无符号表时明确说明 |
| `stack` | `DBG_ENUM_STACK` + `ADR_TOFILELINE` | `#0 SystemInit system_stm32f4xx.c:174` |
| `where` | `DBG_READ_REGISTERS` + `ADR_TOFILELINE` | `main.c:35 (main)` |
| `read` / `write` | `DBG_MEM_READ` / `MEM_WRITE`，写后回读 | 回读不一致会明说 |
| `evaluate` | `DBG_EXEC_CMD` 的 `EVAL` | `$ = 0x08006460` |
| `tasks` / `trace` | `DBG_ENUM_TASKS` / `ENUM_VTR` | 无 RTOS 时明确说没有 |
| `build` / `rebuild` / `flash` / `erase` | `PRJ_BUILD/REBUILD/FLASH_DOWNLOAD/FLASH_ERASE` | 已接 |
| `sessions` / `close` | 进程内会话表 | 复用会话，不重复进调试 |

### 工程（`keil_project`）

`info`、`groups`/`files`、`add_group`、`add_file`、`remove_file`、`remove_group`、
`get_option`、`set_option`、`set_target`、`output_name`。

**实测确认真的写进 `.uvprojx`**：加一个 `ProbeGroup` 和一个文件后，文件从 24591 字节变成
24907 字节，`ProbeGroup` 和文件名都在里面；`SET_OPTITEM` 写的 `PROBE_MARKER=1` 也能读回来。

---

## 四、两处「看起来能用其实不行」的坑

### 1. 调试模式和工程操作是**互斥**的

实测 MDK 5.43a：

- 进了调试模式 → `PRJ_ADD_GROUP`、`PRJ_GET_OPTITEM`、`PRJ_SET_TARGET` 全部回
  `10 DEBUGGING  Target is in debug mode`
- 没进调试模式 → 上面这些正常，但 `PRJ_ENUM_TARGETS` / `ENUM_GROUPS` / `ENUM_FILES`
  回 `10 DEBUGGING`

所以两类操作各用一个 uVision 实例：调试会话在 4823，工程读写会话在 4824。
这不是设计选择，是接口的实际约束。

### 2. 目标板不在时，`DBG_ENTER` 仍然回 `SUCCESS`

进调试是**异步**的：`DBG_ENTER` 立刻回成功，然后真正去复位、烧录、启动。失败出现在后面的
`0x4000` 帧里：

```
Cannot access target.
Shutting down debug session.
Error: Flash Download failed  -  Target DLL has been cancelled
```

所以「进没进去」不能看应答，要看 `DBG_STATUS` 加这些帧。这条错误路径是拿真实板子
（未响应）测出来的，不是构造的。

---

## 四之二、上一版真正漏掉的：烧写

这一条不是接口清单的问题，是**整条产品链路断了**：`embed_flash` 拒绝 `.axf`，
而 `.axf` 就是 Keil 构建出的 ELF。也就是说 Keil 工程能构建、能调试，**不能烧到板上**。

现在 `flasher: "keil"` 走文档里的无头下载：

```
UV4.exe -f <project.uvprojx> -j0 -o <project>uild\keil-flash.log
```

两个只有实测才会发现的细节：

1. **判定必须读日志，不能看退出码。** `UV4 -f` 的控制台什么都不打印。不读 `-o` 文件时
   结果是「无状态、退出码 0」，一个**真实的失败会被当成成功**。第一版就是这样。
2. **日志把各步骤挤在一行、用单空格**，不是文档里那种分行排版：
   `Erase Done.Programming Done.Verify OK.Flash Load finished at 11:39:30`。
   按行首匹配失败，所以匹配器改成在全文里找。现在这条日志报 `verified: yes`。

`.axf` 只对 Keil 下载器放行；给别的 flasher 时说明「这是 Keil 的 ELF 后缀，请改名或用
`flasher: keil`」，而不是一句笼统的「不是固件格式」。

## 四之三、调试命令通道

uVision 的调试器有一整套命令语言（`BS`/`BA`/`BL`/`SAVE`/`LOG`/`COVERAGE`/
`PerformanceAnalyze`/`LOGICAnalyze`…），它们不是一个个独立操作，而是走
`UV_DBG_EXEC_CMD` 一个通道。上一版只把它当成「求值的备选路径」，等于漏了大半个
调试器。现在 `keil_debug action: "command"` 直接执行任意命令并回显输出：

```
> command BL
 0: (E 0x08006BE0) 'main', CNT=1, enabled
> command BS main
（静默成功）
> command EXIT
left debug mode; the debugger's breakpoints were cleared with it
```

`EXIT` 是其中一个真实的坑：它让 uVision 自己退出调试，而会话对象不知道，之后每个
命令都会回 `Target is not in debug mode`。现在会同步状态，并在下一次 `open` 时重新进入。

## 五、接口清单与覆盖情况

公开接口共 **88 个操作**，当前：**71 个已接通并实测**，**17 个在该版本上不可用**（逐个列在下面，
并在 `UNSUPPORTED_ON_MDK_5_43` 里带实测理由）。没有「定义了但从不调用」的。

### 本轮补上的（上一版漏掉的）

| 操作 | 实测结果 |
|---|---|
| `DBG_CALC_EXPRESSION` | **可用且比命令窗口好**：一次拿到 64 位值加调试器自己的渲染（`main` → `0x08006be0`） |
| `DBG_RESET` | 可用，复位后目标重新走到 `SystemInit` |
| `DBG_RUN_TO_ADDRESS` | 可用，停在目标地址 |
| `DBG_STEP_HLL_N` / `STEP_INSTRUCTION_N` | 可用，按行/按指令走 N 步 |
| `DBG_DSM_READ` | 可用但**内容很少**：该版本只回一个指令字且 `nLen=0`，如实报告而不是伪造反汇编 |
| `DBG_ENUM_MENUS` / `MENU_EXEC` | 可用，列出 Trace Data / Performance Analyzer 等 12 项及启用状态 |
| `DBG_ENUM_VTR` / `VTR_SET` | 枚举可用（`CURR_TID`、`TRAPS`、`STCLK`…）；`VTR_SET` 只对枚举出的名字生效 |
| `DBG_ITM_REGISTER` / `EVTR_REGISTER` / `EVTR_ENUMSCVDFILES` | 均可用 |
| `DBG_TIME_INFO` | 可用（仿真器时钟：周期数 + 时间戳） |
| `PRJ_GET_DEBUG_TARGET` / `PRJ_SET_OUTPUTNAME` | 可用 |
| `GEN_CHECK_LICENSE` / `GEN_GET_EXTVERSION` | 可用，回 `uVision V5.43.1.0 / UVSOCK V2.29` |
| `GEN_SHOW` / `HIDE` / `MINIMIZE` | 可用 |
| `DBG_ADR_SHOWCODE` | 可用（在 IDE 里定位到地址） |

### 该版本上不可用的（不是没写，是接口不工作）

| 操作 | 实测行为 |
|---|---|
| `DBG_READ_REGISTERS` | **忽略寄存器名**，对 `PC`/`SP`/`R13`/`R0,R1` 一律回 `0x00000000`。假数据比拒绝更糟，所以改从枚举里按名取 |
| `DBG_EVAL_WATCH_EXPRESSION` / `REMOVE_WATCH_EXPRESSION` | 任何表达式都回 `NOT_SUPPORTED` |
| `DBG_EVAL_EXPRESSION_TO_STR` | 永不回复 |
| `DBG_EVTR_GETSTATUS` | 永不回复 |
| `DBG_ENUM_SYMTP` | 回 `PARSE_ERROR`（缺该版本不暴露的 symbol-table id） |
| `DBG_VTR_GET` | 回 `FAILED: Unknown VTR-name`，即使名字是它自己枚举出来的 |
| `DBG_FILELINE_TO_ADR` | 相对/绝对路径都回 `NO_ADRMAP: Address mapping failed` |
| `DBG_VERIFY_CODE` | 仿真器目标上回 `FAILED`（没有可校验的 flash） |
| `DBG_STEP_INTO_N` | 头文件注明不带计数；`_HLL_N` 与 `_INSTRUCTION_N` 可用 |
| `PRJ_ACTIVE_FILES` / `PRJ_CLOSE` / `PRJ_LOAD` / `GEN_SET_OPTIONS` | 只在非调试会话可用，而这几项在那里没有意义（工程由 `-s` 启动行打开，会话由退出 uVision 结束） |
| `DBG_WAKE` / `DBG_SLEEP` / `DBG_SET_CALLBACK` | 仿真器专有，接受但无可观察效果 |
| `PRJ_CMD_PROGRESS` | 是通知（`0x500D` 一族），不是命令 |

## 六、仍然做不到的

诚实清单，都有实测依据：

- **编辑文件本身**：uVision 的编辑器没有暴露成 API。源码改动走本产品自己的文件工具，
  Keil 只负责构建和调试——这也是它自己的分工。
- **断点只支持「列表里的第几个」删除**：`DBG_CHANGE_BP` 要的是 `tickMark`，已从枚举里取到，
  但不支持按条件批改。
- **`DBG_EVAL_WATCH_EXPRESSION` 在 5.43a 上恒回 `NOT_SUPPORTED`**：所以求值走命令窗口的
  `EVAL`，这条路可用。
- **寄存器组的 `nGi` 被忽略**：这个版本对任何请求都返回全部 152 个寄存器，所以按一次读全。
  换版本后可能需要按组遍历，代码里留了注释。
- **变量枚举依赖符号表**：仿真器 + 只有 `.axf` 时能列；没有调试信息时如实说没有。
- **多 Target 工程**：`set_target` 已接，但只在单 Target 工程上实测过。
- **许可证问题不单独诊断**：没有授权时可能表现为各种失败，目前只能如实转述 uVision 的文字。

---

## 七、验证

`tests/round12-uvsock.test.ts`（17 条）把上面每一条实测到的字节形状固定成断言：
32 字节头、分片重组、`SSTR` 与「计数不含结尾 0」的区别、`TRNOPT` 的 0 与偏移 3、
`BPREASON` 的 12/16/24、命令窗口行没有回显信封、`AMEM` 的地址与错误地址。
其中三条直接对应第一版写错的地方，写错了就会红。

端到端（真实 MDK 5.43a + 真实 STM32F429 工程，取其副本）：

```
keil_debug open     → entered simulator debug mode
keil_debug run      → SystemInit system_stm32f4xx.c:174
keil_debug where    → SystemInit system_stm32f4xx.c:174 (0x8006460)
keil_debug stack    → #0 SystemInit system_stm32f4xx.c:174
                       #1 Reset_Handler ../CORE/startup_stm32f429xx.s:200
keil_debug registers→ 152 个，PC 标出
keil_debug step     → SystemInit system_stm32f4xx.c:177 (0x8006468)
keil_debug read     → 0x0 = 0x200009a8
keil_debug evaluate → $ = 0x08006460 134243424
keil_project add_group/add_file → 写进 .uvprojx（字节数变化已验证）
keil_project set_option CDEF    → 读回包含新值
```

硬件路径同样跑到了 debugger 层，卡在真实板子没有响应
（`Cannot access target`），这属于板子侧，不是代码路径。

---

## 八、边界没有变

- 安装包里仍然没有任何 Keil 二进制、器件包或编译器。
- 不下载、不重分发；没有「一键安装」按钮。
- 探测只读：默认路径 + `TOOLS.INI` + 注册表 `HKLM\SOFTWARE\WOW6432Node\Keil\Products\MDK`
  （本机因此找到 `G:\software\keil5`，而那里不在任何默认位置里）。
- 没有 Keil 的机器上，`keil_debug` 直接说「没有安装 MDK，它是有授权的、不会被捆绑」，
  并指向原有的 OpenOCD / pyOCD / J-Link 链路。
