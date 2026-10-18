# 嵌入式 agent 竞争格局调研

调研日期：2026-10-18。**[H]** 一手页面核实；**[M]** 新闻标题/摘要；**[L]** 二手或单一来源。

---

## 零、先纠正几个前提

调研提纲里的三个名字不是嵌入式 AI 玩家：

- **Quartr** 是投资者关系/财报 AI 公司，无嵌入式产品。
- **Grit** 是 GritQL 代码改写工具，2025-04 被 Honeycomb 收购。
- **Zephtor** 查不到任何产品证据。

真正的嵌入式原生玩家要小得多：**Embedder、BootLoop、logcat.ai、H2LooP**，加上厂商项目。

---

## 一、最重要的结论

> **截至 2026 年 10 月，没有任何一个通用编程 agent 把嵌入式做成一等能力。**

Claude Code、Codex、Cursor、Copilot、Windsurf、Gemini CLI —— **全部为零**。所有硬件能力都来自第三方 MCP，星数 2–200。这直接回答了「值不值得做」：通用 agent 的嵌入式层是空的。

---

## 二、嵌入式原生产品

| 产品 | 今天实际做什么 | 许可 |
|---|---|---|
| **Embedder** | 硬件感知 agent 平台，VS Code 扩展 + CLI。吃仓库、原理图、数据手册、勘误；把寄存器/时序决策落到引用文档上。驱动串口/GDB/逻辑分析仪/示波器/功耗分析仪，跑 编译→烧录→测试→诊断→修复 闭环和 HIL。声称 600+ 平台、14 厂商、5,800+ 外设 | 个人非商用免费 / 创业版 / 企业版（本地部署、BYOC、气隙）。YC 投资，2025-04 成立 |
| **BootLoop** | 三个产品：Develop（bring-up、驱动、迁移，读 Altium/网表/数据手册/寄存器图）、Sentinel（崩溃根因 + 机构记忆）、Test（AI 编排的 HIL：调度板子、驱动 Keysight/Rigol/Saleae/B&K/Joulescope/SEGGER）。创始人是 SpaceX Raptor 固件 | 云默认，支持单租户/GovCloud(ITAR)/本地。无公开定价。embedded world 2026 最佳展示 |
| **logcat.ai** | 「OS 栈的 AI 工程层」：bugreport、logcat、dmesg、modem trace、CAN、ROS 录制 → 带引用的根因报告；跨层补丁提案（研究预览，需人审） | 企业定制，BYOC/本地。$2.55M 融资 |
| **H2LooP** | 「硬件里隐藏的软件」的 AI 编程工具，产品细节很少 | $2M 种子 |

### 厂商侧

| 厂商 | 内容 | 性质 |
|---|---|---|
| **Arduino App Lab 0.10 "Agentic Mode"**（2026-08-12） | 检查工作区、增删文件、启停应用、响应运行时错误；**通过 MCP 连 Arduino App CLI**。自带 key，Claude 优先。GPL-3.0 | 构建设备的 agent |
| **ESP-IDF 6.0 MCP server**（2026-03-24） | 官方 MCP，随 SDK 发布，另有托管端点 | 构建设备的 agent |
| **Nordic**（2026-06-02） | MCP 暴露 nRF Connect SDK 文档、API、器件配置，以及 **nRF Cloud 现场数据**给 Claude Code/Cursor/Copilot。用微调模型降 token | **唯一真正跨工具**的厂商 agent |
| **AMD Ross**（2026-09-30） | Vivado、Vitis HLS、20+ 开源工具；FPGA/自适应 SoC；时序违例分析、HLS 优化、功耗估算、原理图审阅 | **明确客户端无关**（自带 LLM/IDE），发 MCP + 知识库 + agent skills |
| **Silicon Labs Simplicity AI SDK**（beta） | 无线 MCU 的 AI 编程 SDK | beta |
| **NXP eIQ / ESP-Claw / Golioth** | **跑在设备上**的 agent 运行时，不是编程 agent | 与编程无关 |

**结构性观察**：厂商的「agentic AI」分两类 —— *跑在设备上*（NXP eIQ、ESP-Claw）和 *帮助构建设备*（Nordic、AMD Ross、Arduino）。只有 Nordic 跨工具，只有 AMD 明确客户端无关。

---

## 三、通用 agent 的嵌入式支持

| Agent | 一等嵌入式能力 | MCP |
|---|---|---|
| Claude Code | **无** | 有。另开源了 `claude-desktop-buddy`（ESP32 BLE 桌面状态牌，PlatformIO/Arduino），但明确「非官方支持的功能」 |
| OpenAI Codex | 无 | 有 |
| Cursor | 无 | 有（可跑 Embedder 扩展） |
| GitHub Copilot | 无 | 有 |
| Windsurf | 无 | 有 |
| Gemini CLI | 无 | 有 |

---

## 四、EDA agent

**商业**：Cadence ChipStack/Virtual Engineer/AuraStack/RTL Generation Agent、Synopsys AgentEngineer + GPT-Synopsys、Siemens Fuse、ChipAgents、Flux、Quilter、AllSpice DRCY、Lattice Prompt、JLCPCB。

**开源里值得注意的**：

| 项目 | ★ | 许可 | 内容 |
|---|---|---|---|
| mixelpixx/KiCAD-MCP-Server | 2,825 | MIT | KiCad 工程/原理图/PCB 编辑、DRC/ERC、JLCPCB 选件、Freerouting |
| aklofas/kicad-happy | 1,443 | MIT | agent skills：原理图/PCB 审阅、44 项 EMC 检查、SPICE + 蒙特卡洛、数据手册抽取、BOM 采购 |
| salitronic/eda-agent | 255 | Apache-2.0 | 驱动**活的 Altium**（约 450 个工具）、KiCad/EasyEDA 后端 |
| IntelligentElectron/universal-netlist | 56 | Apache-2.0 | 读 OrCAD `.DSN`、Altium `.SchDoc`、KiCad，**不需要 EDA 许可** |

**端到端能跑通吗？** 不对称：
- PCB 布局：Quilter 有最强的演示（843 件的 Linux SBC 一次点亮），但基准显示 LLM agent 仍然失败得很惨
- 原理图审阅：DRCY 在 CI 里真实部署，但没有公开的精确率/召回
- 数字 RTL：最好模型 CVDP pass@1 ≤34%，「能用」是辅助，不是自主
- **原理图→布局→固件全闭环：没有人做**

---

## 五、可集成的开源积木

| 层 | 项目 | ★ | 许可 |
|---|---|---|---|
| 编译/烧录/监视 | powerdragonfire/platformio.mcp | 5 | MIT（40 个工具，含 live GDB） |
| 调试探针 | Adancurusul/embedded-debugger-mcp | 205 | MIT（probe-rs + OpenOCD，Cortex-M 故障解码） |
| 调试探针 | Klievan/jlink-mcp | 36 | MIT（47 个工具，CMSIS-SVD 解码，58 个硬件测试） |
| 串口 | Adancurusul/serial-mcp-server | 94 | Rust |
| 仪器 | armchairdeity/mcp-server-scpi | 4 | MIT |
| 仪器基础 | pyvisa/pyvisa | 968 | MIT |
| HIL | jumpstarter-dev/jumpstarter | 227 | Apache-2.0（UART/CAN/SPI/GPIO/电源/USB，K8s 租借） |
| HIL | agentic-hil/agentic-hil | 18 | Apache-2.0（**SHA-256 审计链 + 按设备权限**） |
| 仿真 | renode/renode | 3,038 | MIT |
| 仿真 | wokwi/wokwi-cli | 68 | MIT |
| 工具链 | platformio-core | 9,536 | Apache-2.0 |
| 工具链 | probe-rs | 2,977 | Apache-2.0 |
| 工具链 | arduino-cli | 5,060 | **GPL-3.0** |
| 工具链 | openocd | 2,358 | **GPL-3.0** |

**许可要点**：Arduino CLI 和 OpenOCD 是 GPL-3.0（进程级调用没问题，链接有风险）；PlatformIO 和 probe-rs 是 Apache-2.0（可安全嵌入）。

---

## 六、可量化的难点（这是最有说服力的部分）

### 固件 agent

**Embedded Arena**（arXiv:2606.16190，2026-06-15，MIT 代码）—— ESP32-S3R8 / MAX78000 / STM32N6 上的 HIL 基准：

- **最难的题：没有硬件反馈时部署成功率 0%，接上 HIL 后 80%**
- 首次成功部署在 **3 次迭代内**；**7 次内**超过人类专家基线
- YOLO11/MAX78000：**0.0% → 3.3%（给文档）→ 27.5%（给 HIL）**
- 功耗：MAX78000 峰值电流 **37.19 mA → 17.64 mA（−53%）**；能量 **242.87 → 137.83 mJ**
- 实测部署：麋鹿相机陷阱 96.7% 准确率，**<36 mW 活跃 / 7 mW 平均**

> **解读**：agent 在**被硬件打分时**是很强的优化器，**没有硬件时基本没用**。

**闭环嵌入式软件评测**（arXiv:2610.11447，2026-10-08，420 次运行）：

- gpt-5.4：**93.3%** 真实自验证，**100%** CI 红绿，**86.7%** 一次性盲写
- gpt-5.4-mini **53.3%**；qwen3.5-9B **13.3%**；qwen3.5-2B **0%** —— 而且 2B 每次跑烧掉 **77.4M token / 987 次工具调用**，即「失败靠空转」

**ReproBench**（arXiv:2609.34450）—— 30 个真实 IoT 固件 CVE，只给编号：**只有 5.3% 复现了漏洞；45.3% 的运行是「模拟」出来的**。

**HardSecBench**（arXiv:2601.13864）—— 924 个硬件安全任务：模型满足功能，留下安全漏洞。

### PCB

**OmniLayout**（arXiv:2607.03261）：最佳端到端布局 **62.6%**；**79.8%** 的解析输出至少有一处元件/焊盘重叠；**72.9%** 有边界违例。

**OmniRouting**（arXiv:2608.04434）：人类工程师 NRR/PRR **93.58 / 95.91**；经典 PcbRouter **56.20 / 71.37**；最佳 agentic GPT-5.5 **27.98 / 30.34**。

**PCBWorld**（arXiv:2607.05915）：99 块真实小板上 GPT-5.4 交互式 **CP 0.65**；无引擎 **0.02**。**更大的板上所有 LLM agent CP = 0.00**。

### RTL

CVDP 最佳 pass@1 **≤34%**；RealBench 系统级 **0%**；**SMPS 设计加 SPICE 闭环后求解率 15% → 91%**。

### 贯穿性发现

> **凡是基准里加入真实反馈（HIL、SPICE、DRC、CI）的地方，分数涨 5–20 倍；凡是没加的地方，模型原地不动或崩溃。**

这就是「全能工作台」的实证依据。

---

## 七、新入者能占的位置

1. **通用 agent 的嵌入式层是空的** —— 六家主流，零个一等功能。占住**默认嵌入式运行时**（串口复用、板卡/端口发现、工具链准备、探针抽象、有权限的烧录）是土地抢占。
2. **没有人闭环 原理图 → 固件 → 烧录 → 测量**。Embedder 和 BootLoop 各占三分之二；Flux/Quilter 占原理图/布局；EDA 厂商占芯片/PCB 但不占固件。唯一的开源尝试 OpenBench 只有 4 星。
3. **厂商 agent 是生态孤岛** —— Nordic 只懂 nRF，AMD 只懂 AMD，ESP-Claw 只懂 ESP32。跨厂商层（*使用*厂商知识库但不被任何一家拥有）结构上是开放的。
4. **HIL 被企业合同锁住且碎片化** —— 开源栈真实但很小，没有一个项目同时覆盖 探针 + 串口 + 仪器 + 租借 + 审计。**agentic-hil 的按设备权限 + 审计链是正确模型**。
5. **测量是最弱的一环** —— SCPI MCP 都是 3–11 星的单仪器业余项目。**没有人把测量反馈产品化。**
6. **原理图/板卡感知对编程 agent 很薄** —— 整个领域就是三个项目。除了 Seeed 的 device-tree 生成和 Embedder 的专有摄取，**没有一个把网表连到固件语义**（pinmux、外设初始化、devicetree）。
7. **基准是新的、窄的、可超越的** —— Embedded Arena 衡量的是 ML 部署优化，不是固件正确性。**没有标准的「这个 agent 能否为 X 板产出能工作的固件」排行榜**。发布一个（真板、按板打分、安全项）会是可防御的战略资产，就像 SWE-bench 锚定了编程 agent。
8. **安全与验证无人认领** —— ReproBench 的 5.3% 和 HardSecBench 的「功能对、不安全」意味着一个**证明**而不是**声称**的 agent 有可信的差异化。
9. **许可卫生是护城河** —— 好的积木大多是 MIT/Apache；两个 GPL 陷阱是 Arduino CLI 和 OpenOCD。围绕宽松组件设计、GPL 工具进程级隔离，可以商业发布而不受污染。
