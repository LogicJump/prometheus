# 嵌入式全能工作台：集成设计

日期：2026-10-18。目标是把 Prometheus 从「通用编程 agent」扩展成「嵌入式软硬件工作台」。

> **状态（2026-10-19）**：本文是**设计愿景**，不是交付清单。第五节"工具清单"里
> 标注为已实现的那几行是真实的；`embed_measure`、`embed_waveform`、`embed_pinmap`、
> `embed_datasheet` 四个**没有实现，也刻意没有暴露给模型**——
> 它们分别需要仪器驱动、采集硬件和手册索引，补空壳只会让模型以为自己在测量。
> 第六节的"测量"面板同理。第七节逐阶段写了实际交付了什么。

---

## 一、为什么不能只是「加几个工具」

通用 agent 在嵌入式上的失败不是因为不会写 C，而是因为**它拿不到反馈**。
Embedded Arena（arXiv 2606.16190）的对照实验：没有硬件反馈时前沿模型部署成功率 0%；
接上编译—烧录—测量闭环后 3 次迭代内首次成功、7 次内超过人类专家。

所以集成的核心不是"多接几个 MCP server"，而是把下面这条回路做成**一等公民**：

```
改代码 → 编译（结构化诊断）→ 烧录（校验）→ 串口/调试（读状态）→ 仪器（测量）→ 判断 → 再改
```

每一段都必须返回**机器可读**的结果，agent 才能判断"这次是不是真的好了"。

---

## 二、分层

```
┌──────────────────────────────────────────────────────────┐
│ 工作台 UI（现有 Electron）                                │
│  目标板面板 · 串口监视 · 烧录状态                          │
├──────────────────────────────────────────────────────────┤
│ Agent 工具（全部返回结构化结果）                            │
│  embed_build  embed_flash  embed_serial  embed_debug      │
│  embed_targets  embed_ports  embed_project                │
│  embed_registers  embed_analyze                           │
├──────────────────────────────────────────────────────────┤
│ 适配层 src/embedded/                                      │
│  toolchain/  probe/  serial/  debug/  board/  svd/        │
├──────────────────────────────────────────────────────────┤
│ 外部程序（不重造）                                         │
│  cmake · ninja · west · idf.py · pio · arm-none-eabi-gcc  │
│  openocd · pyocd · probe-rs · J-Link · esptool · QEMU     │
└──────────────────────────────────────────────────────────┘
```

**原则**：不自己实现编译器、调试器、烧录器。把它们的能力**探测出来、统一成一种结果形状**，
再交给模型。每层都可以缺——缺了就降级并明确告诉模型"这一段不可用"。

---

## 三、核心抽象

### 3.1 目标板（Board）

一块板子的描述，来自 CMSIS-Pack、PlatformIO manifest、Zephyr board yaml，或手写：

```ts
interface BoardTarget {
  id: string;                 // "nucleo-f411re"
  name: string;
  mcu: string;                // "STM32F411RETx"
  vendor: string;
  core: string;               // "cortex-m4f"
  flashBytes: number;
  ramBytes: number;
  /** 探针与烧录方式 */
  probe?: { kind: "openocd" | "pyocd" | "probe-rs" | "jlink" | "esptool" | "dfu"; config?: string };
  /** 串口与波特率 */
  console?: { port: string; baud: number };
  /** 可用的调试符号 */
  svd?: string;
  /** 引脚与外设能力 */
  pins?: PinCapability[];
}
```

探测顺序：项目文件（`platformio.ini`、`CMakePresets.json`、`prj.conf`、`sdkconfig`）→
已连接的探针（`pyocd list --json`、`probe-rs list`）→ 用户手动指定。

### 3.2 统一的诊断形状

不管编译器是 GCC、Keil 还是 IAR，编译结果统一成：

```ts
interface Diagnostic {
  file: string; line: number; column?: number;
  severity: "error" | "warning" | "note";
  code?: string;              // "Werror=unused-variable"
  message: string;
  /** 能定位到源码时附带上下文行 */
  context?: string;
}
```

`compile_commands.json` 是主路径；没有时用正则解析 GCC/Keil/IAR 输出。

### 3.3 统一的测量形状（未实现）

保留这一节是因为它说明"如果要做需要什么形状"，而不是因为代码里有它。
`src/` 下不存在 `instrument/` 目录，也没有任何工具产出这个类型。

```ts
interface Measurement {
  kind: "voltage" | "current" | "power" | "energy" | "waveform" | "frequency" | "custom";
  value?: number;
  unit?: string;
  samples?: { t: number; v: number }[];   // 波形
  at: string;
}
```

---

## 四、工具清单

| 工具 | 做什么 | 返回 |
|---|---|---|
| `embed_build` | 调项目自己的构建命令，解析诊断 | `{ ok, diagnostics[], artifacts[], durationMs }` |
| `embed_flash` | 烧录并校验 | `{ ok, size, elapsedMs, verified }` |
| `embed_serial` | 打开串口，读 N 秒或读到匹配模式 | `{ lines[], matched?, timedOut }` |
| `embed_debug` | 启动 GDB/pyOCD，设断点、读变量、取回溯 | `{ halted, reason, frames[], variables }` |
| `embed_targets` | 列出可用板子与探针 | `BoardTarget[]` |
| `embed_ports` | 列出串口及其 VID/PID | `SerialPort[]` |
| `embed_project` | 识别项目类型和构建命令 | `{ kind, buildCommand, ... }` |
| `embed_registers` | 从 CMSIS-SVD 查寄存器/字段/枚举 | index / detail |
| `embed_analyze` | 静态分析：栈用量、内存占用、cppcheck | `{ findings[] }` |

~~`embed_measure`~~、~~`embed_waveform`~~、~~`embed_pinmap`~~、~~`embed_datasheet`~~
**未实现**：它们需要仪器驱动（pyvisa/sigrok）、采集硬件或手册知识工程，不属于
"再写一个适配器"的量级。空壳工具比没有工具更糟——模型会以为自己测到了东西。

**所有工具都遵守现有的五段管线**（resolve → guard → prepare → execute → settle），
所以权限、审计、检查点自动生效。烧录和调试属于「改变设备状态」，在 `ask` 模式下要确认。

---

## 五、知识层

嵌入式最大的上下文不是代码，是**手册**。三条来源：

1. **CMSIS-Pack / SVD** — 机器可读的寄存器定义，直接变成 agent 能查的表。
2. **本地文档索引** — 用户把厂商 PDF 放进 `.prometheus/datasheets/`，后台抽成文本块并建索引。
3. **厂商 MCP** — Espressif 文档 MCP、Nordic nRF Cloud MCP、Arduino 文档等，配置即用。

检索结果必须带**出处**（文档名 + 页码/章节），因为嵌入式里"差不多对"的寄存器值会烧板子。

---

## 六、UI 增量

在现有工作台上加两个面板，都复用现有的标签式工作区：

- **目标板**：当前板子、探针、串口、最近一次构建的闪存/RAM 占用（数字，不画条——
  分区总量来自 `--print-memory-usage`，目前没有请求它，画条等于编数据）。
- **串口**：滚动日志、按级别过滤、暂停、导出；可把选中的日志段发给 agent。

~~**测量**面板~~ 未实现，随 `embed_measure` / `embed_waveform` 一起推迟。

composer 增加一个 `目标` 芯片，显示当前板子；没有连接时显示"未选择目标"。

---

## 七、分阶段

**阶段一（能编译能烧录）**——已交付
工具链探测、`embed_build`、`embed_flash`、`embed_serial`、`embed_targets`。
覆盖 Zephyr / ESP-IDF / PlatformIO / CMake 裸机四种项目。

**阶段二（能调试）**——调试已交付，测量未做
`embed_debug`（GDB/MI）已实现；`embed_measure`、`embed_waveform` 推迟。

**阶段三（有知识）**——SVD 已交付，其余未做
SVD/CMSIS-Pack 索引已实现（`embed_registers`）；本地 datasheet 索引、
`embed_pinmap`、厂商 MCP 预设推迟。

**阶段四（工作台）**——目标板 / 串口两个面板已交付
测量面板、烧录历史、HIL 测试录制回放推迟。

---

## 八、明确不做

- 不做自己的编译器、调试器、烧录器。
- 不做 PCB 布线（Flux/Quilter 的领域，且需要几何求解）。
- 不做 OS 级隔离的替代品：烧录和调试天然需要访问 USB 设备，沙箱边界要单独说明。
- 不承诺"生成的固件可认证"：ISO 26262 / DO-178C 要求工具鉴定，agent 输出只能作为草稿。
