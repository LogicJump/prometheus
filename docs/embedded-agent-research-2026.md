# 嵌入式软硬件 AI Agent 应用现状调研（截至 2026 年 10 月）

> 调研方法：四路并行检索（嵌入式软件开发、机器人/具身智能、端侧与边缘、EDA/硬件设计），
> 以 arXiv、厂商官网/新闻室、行业媒体、GitHub API 与中文产业媒体交叉验证。
> **可信度标注**：〔已核实〕= 一手来源或受控实验；〔厂商宣称〕= 厂商自报，无第三方验证；
> 〔未证实〕= 多路检索未能确认，不应引用。

---

## 零、一页结论

1. **嵌入式软件 Agent 的胜负手已从"模型能力"转向"反馈回路"**。Embedded Arena（arXiv 2606.16190，2026-06-15）的对照实验显示：前沿模型在没有硬件反馈时部署成功率为 0%，接入真机编译—烧录—测量闭环后 3 次迭代内首次成功、7 次内超过人类专家。谁掌握工具链 MCP 暴露权与仪器访问权，谁掌握分发。
2. **芯片厂商分成两派，且常被媒体混淆**。"在 MCU 上跑模型"（ST、Infineon、TI）与"让 AI 帮你写固件"（Microchip、Silicon Labs、Nordic、Espressif、AMD Ross）是两件事；NXP 的 Agentic AI 在 2026 年仍主要是"用 Agent 开发嵌入式"，不是设备运行时 Agent。
3. **端侧的真实现状是"设备侧 MCP 工具面 + 边缘/云模型"**。MCU 上跑通用指令模型仍不可行（0.03M–29M 参数、1–19 tok/s、只会写 TinyStories 式文本）；量产级"AI 硬件"几乎都是本地唤醒 + 云端推理 + MCP 工具。
4. **EDA/芯片设计呈"两端成熟、中间悬空"**。单点 ML 优化（PPA、DFM、布线）已生产化多年；agentic 层在 RTL/验证/PCB 进入少量客户产线；端到端自主设计仍是 demo——Build-A-Chip-Bench 中约 40% 任务过功能验证，仅约 10% 达 PPA 目标。
5. **机器人"量产"被滥用**。IDC 口径下 2026 H1 全球人形出货约 2.5 万台，但 69% 流向科研/教育/展演；真正连续产线运行的只有 Figure@BMW、Agility@GXO/Toyota、银河通用@宁德时代等少数案例。
6. **信任与认证是共同瓶颈**。ISO 26262/DO-178C 要求工具鉴定与确定性证据链；目前没有任何厂商宣称可交付"经认证的自主生成固件"。业界第一条合规路径是 MathWorks 2026-10-14 获 TÜV SÜD 认证的"通用 AI 工具分类 + 人工担责 + 可追溯"指引。

---

## 一、嵌入式软件开发 Agent

### 1.1 通用编码 Agent 的落地路径

通用 Agent 厂商**没有推出嵌入式专用产品**，路径是被厂商工具链接入：

- **AMD Ross**（2026-09-30）〔厂商宣称〕：内置知识库、专家撰写的 agent skills、MCP server，支持 Codex CLI、Claude Code、GitHub Copilot CLI，覆盖 Vivado 与 Vitis HLS。
- **Cadence VLAB**（Embedded World 2026）〔厂商演示〕：Claude 经 VS Code 接入虚拟开发机，读运行时输出→定位硬件寄存器冲突→改代码→重建。
- **Devin、Cursor、Windsurf 未找到公开的嵌入式/HIL 案例**——其沙箱模型与物理硬件天然冲突。
- **代码量增长≠软件产出增长**：哈佛 Chen & Stratton 基于 Jellyfish 700+ 企业数据的研究〔第三方〕显示，Agent 引入后代码行数 +30%、PR +23%，但 Issue 解决率无显著变化，PR 评审时长 +49%，需返工的 PR 近乎翻倍。

### 1.2 芯片厂商（严格区分状态）

| 厂商 | 产品 | 状态 | 性质 |
|---|---|---|---|
| ST | STM32Cube AI Studio 新 UI（2026-02）、AI Model Zoo | GA | 边缘推理部署 |
| NXP | eIQ Agentic AI（2026-01） | 实验性 beta | **用 Agent 开发嵌入式**（MCUXpresso Agent/Copilot 视图、文档 MCP、FreeMASTER MCP），非设备运行时 |
| Renesas | Renesas 365（2026-03 GA）+ Pictorus 收购（2026-06） | GA | 模型驱动设计→Rust 代码生成 |
| Infineon | DEEPCRAFT AI Suite / AI Hub | 已发布 | 边缘模型工具链 |
| Microchip | MPLAB AI Coding Assistant（2025-02，基于 Continue） | GA | 唯一早期就做编码助手的 MCU 厂 |
| Silicon Labs | Simplicity AI SDK 公测（2026-10） | Beta | 用板级原理图生成固件工程 |
| Nordic | nRF Connect SDK + nRF Cloud **MCP server**（2026-06） | 已发布 | 明确接入 Claude Code、Cursor、Copilot |
| Espressif | ESP-Claw（2026-04）、文档 MCP、ESP-IDF VS Code 扩展 v2.3.0（2026-10-16） | 已开源/GA | AI Chat + 两个官方 MCP server（文档、组件注册表） |
| Arduino | AI Assistant（2025-04）、UNO Q（2025-10）、VENTUNO Q（2026-08） | GA/预购 | UNO Q = QRB2210 + STM32U585，Linux 侧跑 OpenCode 等 Agent |
| TI / ADI | 未发现 Agentic 编码产品 | — | 空白 |

### 1.3 专用工具与初创

- **Embedder**〔厂商宣称〕：硬件目录覆盖 300+ 平台，datasheet 实时索引；2026-07 与 Verkor 合作为 RISC-V 核 VerCore 从零生成 bring-up 固件；接入 Joulescope（功耗闭环）与 SEGGER J-Link/J-Trace；支持 Zephyr/FreeRTOS、容器化气隙部署、主打 ITAR。
- **BootLoop**（YC）〔厂商宣称〕：读 PCB 设计文件与 datasheet，自动生成寄存器级测试，一条命令从零到真机 CI。
- **Embedd**〔厂商宣称〕：270 万美元 pre-seed，用硬件数字孪生为 Agent 提供上下文。
- **注意品类**：Memfault（2025-06 被 Nordic 以 1.2 亿美元收购）、Golioth、Particle、Edge Impulse 属"AI-ready IoT 基础设施/可观测性"，**不是编码 Agent**。

### 1.4 学术与基准（关键证据）

| 工作 | 时间 | 核心结论 |
|---|---|---|
| Embedded Arena（arXiv 2606.16190） | 2026-06-15 | 无硬件反馈时前沿模型部署成功率 0%；有 HIL 反馈 3 次迭代内成功、7 次内超专家 |
| Closed-loop evaluation（arXiv 2610.11447） | 2026-10-08 | ESP32 仿真，420 次运行；gpt-5.4 最高但未饱和；qwen3.5-27B 最强本地模型 |
| Skilled AI Agents / IoT-SkillsBench（arXiv 2603.19583） | 2026-03-20 | 378 次真机实验；**简洁的人类专家 skill 带来接近满分成功率**——知识注入比模型规模更关键 |
| AutoEmbed（SenSys 2026，港城大） | 2026 | 355 个 IoT 任务、71 个模块、4 平台；coding accuracy 95.7%、端到端任务成功率 86.5%〔已核实项目页与论文 PDF〕 |
| Securing LLM-Generated Firmware（arXiv 2509.09970） | 2025-09 | QEMU+FreeRTOS，三 Agent 协同；92.4% 漏洞修复率、95.8% 威胁模型合规、8.6ms WCET |
| HardSecBench（arXiv 2601.13864） | 2026-01 | 924 任务、76 个 CWE；模型常满足功能但引入安全弱点 |
| DCP / Device Context Protocol（arXiv 2605.26159） | 2026-05 | ESP32 上 27.6KB flash / 0.6KB RAM；越权拦截 100%、提示注入拦截 78%（裸 MCP 仅 0–1%） |
| ReproBench（arXiv 2609.34450） | 2026-09 | 30 个 IoT 固件漏洞，仅 5.3% 的 CVE-模型组合真正复现 |
| PLCBench（arXiv 2608.26882） | 2026-08 | 240 次真 PLC HIL 实验，31.3% 达成持续物理目标 |

### 1.5 失败模式（一手记录）

1. **外设幻觉**：CNX Software 实测 Nordic MCP 工作流，Agent 生成 DeviceTree/Kconfig 时"随机添加按键和额外 LED"。
2. **语法正确≠安全**：Veracode 跨 100+ 模型版本，44% 的 AI 代码含至少一个 OWASP Top 10 漏洞，语法正确率却达 99%。
3. **并发/DMA/缓存一致性**：生成代码把 volatile 当同步、假设内存一致、缺 cache clean/invalidate；在 Cortex-M4 上通过、在 Cortex-M7 上小比例损坏。
4. **供应商勘误**：生成序列可能先开外设后开时钟、跳过 errata workaround。
5. **可追溯性缺失**：生成模块"无来源、无失效模式推理、无验证证据"，无法支撑安全案例。

---

## 二、端侧 / 边缘 AI Agent

### 2.1 MCU 级：可行性边界清楚，产品级为零

| 项目 | 模型 | 硬件 | 性能 |
|---|---|---|---|
| esp32-llm | 260K TinyStories | ESP32-S3 + 2MB PSRAM | 19.1 tok/s |
| esp32-ai | 28.9M，4-bit 14.9MB | ESP32-S3（8MB PSRAM） | 9.9 tok/s；借用 Gemma 3n PLE 把 embedding 放 Flash |
| atome-lm | 944K 三值 | ESP32 | ~1 tok/s，作者自认"research demo, not a product" |
| Oído（arXiv） | 13M Conformer + 1.3M LM | ESP32-S3 | WER 3.70%/8.23%，**非实时**（1.97× 音频时长） |

**结论**：MCU 预算约 8–16MB PSRAM、512KB SRAM、1–10 tok/s、无 MMU。**参数上限由 PSRAM 与带宽决定，而非算力**。够跑唤醒词/分类/异常检测，不够跑通用指令模型。MLPerf Tiny v1.4（2026-07，9 家机构 25 个配置）仍只测关键词识别、视觉唤醒、CIFAR、异常检测，**不含任何 LLM 任务**。

**当前最务实的形态**：端侧负责实时性、隐私边界与执行，云侧负责推理——ESP-Claw、xiaozhi-esp32 均为此路线。

### 2.2 边缘 SoC/NPU：真落地，但"TOPS ≠ Agent 体验"

- **Jetson Thor T5000**〔厂商宣称〕：2070 FP4 TFLOPS sparse、128GB LPDDR5X、40–130W；官方定位 agentic-ready，支持 VLA/LLM/VLM/GR00T。
- **Qualcomm Dragonwing**：IQ9 50–100 TOPS（Llama2-7B 22 tok/s，厂商数据）；Q-8750（CES 2026）77 dense TOPS、支持 11B 模型。IQ9 2024 年发布时**未给量产时间**，Q-8750 也未公布价格与上市。
- **ARM Ethos-U85 / Alif Ensemble**：204 GOPS、36mW、9.75MB SRAM，MCU 级"能跑 SLM"的最强公开方案；但**未点名任何模型**，属厂商数据待验证。
- **关键反例**：Raspberry Pi AI HAT+ 2（Hailo-10H，40 TOPS）在 CNX 实测中**全面慢于 Pi 5 CPU**（DeepSeek-R1 1.5B：6.72 vs 9.04 tok/s）；RK3588 NPU 14.9 tok/s vs CPU 18–20 tok/s。NPU 的真实优势是首 token 时延（2039ms→320ms）与功耗（7.2W vs 10.2W）。Sixfab/DEEPX DX-M1M（25 TOPS、3W）上 Qwen3-1.7B 为 4.64 tok/s、TTFT 599ms，同样是能效优先。
- **一句话规律**：NPU 擅长 prefill、不擅长 decode，瓶颈是内存带宽而非算力。

### 2.3 端侧模型与框架

- **Gemma 4**（2026-04-02，Apache 2.0）：E2B 2.3B 有效 / E4B 4.5B，128K 上下文，原生 function calling。
- **FunctionGemma**：270M，量化后 288MB，Mobile Actions 微调后 58%→85%。
- **Needle 2**（2026-09-22，Apache 2.0）：**14MB** 函数调用模型，RPi 5 纯 CPU，单次调用 76–149ms——全离线窄任务 Agent 的现实路径。
- **LiteRT-LM**：支持工具调用与约束解码，覆盖 Android/iOS/Web/Desktop/IoT（含 Raspberry Pi），`serve` 提供 OpenAI 兼容端点。Pi 5 上 Gemma 4 E2B 为 9 tok/s、峰值 1432MB；Gemma 3 270M 为 23 tok/s、680MB。
- **ExecuTorch**：唯一有大规模量产证据的端侧栈（Meta 六大 App、Ray-Ban Meta）；2026-10-15 新增 **Cortex-M 后端**（Alif E8 上 MLPerf Tiny 四模型 <21.5ms、<90KiB RAM；Renesas EK-RA8D1 µYOLO 24ms/12.7FPS）。
- **Apple Foundation Models**（iOS 26）：开发者可直接调用端侧模型，离线、App 内无推理成本。
- **Android AppFunctions**（2026-09，实验预览）：App 像"设备端 MCP server"一样暴露函数，Agent 本地调用。
- **FunctionGemma**：270M，量化后 288MB；BFCL simple 61.6，Mobile Actions 微调后从 58% 升到 85%。
- **端侧实测横评**（2026-04）：Gemma 3 4B 在 iPhone 16 Pro 约 27 tok/s、Pi 5 约 6 tok/s；Gemma 3 1B 在 iPhone 约 55 tok/s、仅 0.8GB；手机持续推理 2–3 分钟后因发热降至峰值 60–70%。

### 2.4 边缘 Agent 协议与框架

- **MCP 2026-07-28 规范**：移除 initialize 握手与会话 ID，改为无状态；列表结果带 ttlMs/cacheScope——对 RAM 紧张的 MCU 极友好。
- **xiaozhi-esp32**：31.4k stars、138 个板型；本地只跑唤醒词，ASR/LLM/TTS 在服务端，设备端与云侧各一套 MCP。
- **ESP-Claw**：事件驱动 Agent Loop、Lua 沙箱、片上记忆、MCP server+client；但 LLM 必须走云端点，门槛 8MB Flash + 8MB PSRAM。
- **Esparagus**（2026-08）：面向 agent 的 ESP32 烧录工具，NDJSON 事件 + 稳定退出码 + MCP server，支撑"烧录—观察—分类失败—改固件"闭环。
- **Rohde & Schwarz MXO AI Connect**：免费 MCP server，自然语言控制 MXO 系列示波器，支持 Claude Code/Cursor/Copilot。
- **NVIDIA NemoClaw** + Jetson agent skills：OpenClaw 的安全加固参考栈。
- **Windows On-device Agent Registry (ODR)**：MCP server 发现、沙箱隔离、Intune 管控与审计，内置 File Explorer MCP connector——目前最完整的端侧 Agent 基础设施官方实现。
- **云厂商现状**：AWS Greengrass V1 于 2026-06-01 终止支持，V2 仍是组件化边缘运行时，Bedrock AgentCore 明确面向云侧；Azure IoT Operations 是 K8s 边缘数据面，离线最长 72 小时，AI 分析仍在云上。

### 2.4b 端云分工的量化证据

- **AgBench**（arXiv 2609.38652，60 任务、162M 数据点）：本地执行并发 1 时 RTX 5090 上 35/60 成功，并发 8 时跌到 12/60；云侧稳定 48–50。本地执行的云 API 成本与敏感信息暴露均为 0，全云暴露 76%，本地主导的混合仅 13–22%。
- **EdgeWise**（arXiv 2610.17560）：步级强化学习决定何时上云，SWE-Rebench 成本降 62%、Terminal-Bench 2.1 降 34%。
- **EdgeAgent**（arXiv 2610.03394）：Apple M4 统一内存上多 Agent 调度，工具调用阻塞场景加速 1.77 倍。
- **小模型工具调用可靠性**（arXiv 2609.07370）：sub-2B 测试中 Qwen2.5-1.5B greedy 75%、采样 79%；Qwen2.5-0.5B 从 72% 崩到 32%；Phi-1.5 为 0%；1000 条原始输出仅 5 条可直接解析为 JSON。

### 2.5 市场数据（口径差异大，引用须注明）

| 来源 | 2025 | 2026 | 远期 | CAGR |
|---|---:|---:|---:|---:|
| Grand View（2026-06） | $24.9B | $30.0B | $118.7B（2033） | 21.7% |
| Precedence（2026-09） | $25.65B | $31.05B | $165.05B（2035） | 20.46% |
| MarketsandMarkets（2026-09） | — | $20.73B | $120.31B（2032） | 34.1%（仅软件） |

2026 年估计落在 $20.7B–31.1B，差异来自"软件/整体/是否含硬件"。

### 2.6 设计侧的关键数据

- **AI 信任缺口**（IoT Analytics，2026-08 报告，120 家制造企业决策者）：87% 期望 AI 内建于 CAD/PLM/ALM；但仅 24% 高度信任 AI 做文档、17% 信任仿真输入、16% 信任验证与确认、13% 信任零件选型；**没有任何活动达到 3% 的"完全信任并依赖"**。
- **端侧 Agent 权限边界**：家庭自动化实测中，Gemma 4 E2B 对"非本站点所属设备"的请求 **87.2% 直接执行**；另一模型全部拒绝。权限模型远未成熟。
- **KV cache 与并发**：AgBench 中上下文超限是本地执行失败的主因之一；MCP 无状态化与 Tasks 扩展正是为此设计。
- **OTA 与模型生命周期**：Android AICore 由系统统一分发 Gemini Nano、应用零负担；Foundry Local 做版本化模型缓存与执行提供程序自动更新；MCU 侧仍靠整包固件刷新。

---

## 三、EDA / PCB / 芯片设计

### 3.1 PCB / 电子系统设计

- **Flux.ai**：$37M（2026-02，2700 万 B 轮）；prompt→原理图→选型→布局→Gerber；2025-10 发布 "First AI Hardware Engineer"（规划→执行多步 PCB 工作流，可改原理图、布线、跑 ERC/DRC）；布局摆放仍标注 "coming soon"。
- **Quilter**（物理驱动而非 LLM）：Project Speedrun 用 i.MX 8M Mini 双板、843 元件、5141 引脚、8 层，98% 布线覆盖、零 DRC、一次点亮 Debian；但 **38.5 人时中的 30–40 小时是人工清理**（CEO 自述）。Sierra Circuits 复盘列出 58 项 DFM/DFA 问题，其中 48 项是文档/库/BOM/供应链，仅 10 项涉及物理布局。
- **Diode**（$11.4M）、**Circuit Mind**、**CELUS**、**JITX** 各有定位；Cadence **AuraStack**（2026-07）自称"首个 PCB/先进封装 agentic 平台"，The Register 指其"高度辅助而非全自主"。
- **共同缺口**：原理图→布局的"智能网表"handoff（电流、阻抗、长度匹配、热、信号敏感度），目前靠会议与人工传递。

### 3.2 芯片设计

- **Synopsys**：AgentEngineer + Autopilot（2026-09），7 家公开合作方（AheadComputing、Fujitsu、Intel、MediaTek、NVIDIA、Samsung、TSMC），Fujitsu 报告 RTL 生成 10–30% 提效；**GA 定在 2026 年底**。2026-09-30 与 OpenAI 发布 **GPT-Synopsys**（模型直接操作 EDA 工具，OpenAI 托管，收入分成），GA 未披露。
- **Cadence**：ChipStack（前端，2026-02）、ViraStack、InnoStack、AuraStack；ChipStack RTL agent 相对基座模型面积 -24%、功耗 -18%（厂商数据）。
- **Siemens**：Fuse（2026-03，跨厂商工具编排，支持 API/MCP），**20+ 客户装机、仅个位数进产线**（TechWire Asia，2026-08）；Questa One Agentic Toolkit 五个 agent（RTL/Lint/CDC/验证规划/Debug），早期访问，兼容 Copilot/Claude Code/Cursor。
- **NVIDIA**：CVDP（783 题，最好 pass@1 ≤34%）；Agent Toolkit + ACE-RTL。
- **ChipAgents**：$134M；与 NVIDIA 发布 **Build-A-Chip-Bench**（2026-10-14）：约 40% 任务过功能验证，**仅约 10% 达 PPA 目标**。

### 3.3 模拟/混合信号

Vibe Tapeout（2026-10）用云端 agent 做 SKY130 SAR ADC，DRC/LVS clean、后仿达标，但出现 **false pass**；SABLE（2026-07）用白名单 SKILL + 脱敏反馈解决 NDA，11 个模型中 7 个过 LC-VCO。**判断**：sizing/表征/版图迁移可辅助生产；拓扑生成仍是研究。

### 3.4 测试与实验室自动化

- **R&S MXO AI Connect**〔已核实〕：免费 MCP server，MXO3/4/5/5C + ScopeStudio，自然语言测量、SCPI 检索、截图；Win/macOS，不支持 Linux。
- **Tektronix**：2026-05 技术简报，用 agent 生成 TSP/ATE 脚本。
- **自驱动实验室**：Argonne SYNAPS-I、KIT E-MAP 等偏材料表征。
- **HIL 的公开 agent 闭环证据仍薄**，多为脚本生成 + 人工判读。

### 3.5 基准

CVDP 783 题（≤34%）；HWE-Bench 417 个真实硬件 bug（最好 70.7%，SoC 级 <65%）；PDAgent-Bench 353 题（Innovus 脚本仅 42.2%）；Build-A-Chip-Bench（~40% 功能 / ~10% PPA）；PCBWorld 679 板；OmniLayout/OmniRouting 各 1681 设计。**规律：概念题好、工具执行与长程推理差。**

---

## 四、机器人与具身智能

### 4.1 基础模型

- **NVIDIA GR00T**：N1（2025-03）→N1.5→N1.6（2026-01，Cosmos Reason、全身控制）→N1.7 早期商用（2026-03）→N2 预览（DreamZero 基座，年底可用）。生态位：机器人的 "Android"，靠开源模型 + Jetson Thor 绑定。
- **Google DeepMind**：Gemini Robotics 跳到 2 代（2026-07-30）：VLA（全身控制、多机协作）、ER 2（分钟级规划、多机器人调度、安全拒答）、On-Device 2（不到 200 样本、数小时适配新双臂本体）。2026-10 发布 **Gemini 4 Argon for Robotics**：ERQA 87%，sim-to-real 数据把真机成功率从 56% 提到 75%。
- **Physical Intelligence**：π0→π0.5→π*0.6→π0.7（2026-04，可 steer、组合泛化）→**Pi API beta**（2026-10-13，上传数据、微调、托管推理）。
- **Figure Helix**：Helix 02（2026-01，S2/S1/S0 三层，200Hz 全身 / 1kHz 关节）→**Helix 2.5**（2026-09）：Index 数据集预训练，30 个未见家庭零样本成功率 **56% vs 从零 9%**〔已核实〕；局限：任务仍是整理/折叠/铺床，零样本指环境与物体而非任务。
- **中国**：阿里 RynnBrain/Qwen-Robot、蚂蚁 LingBot-VLA、华为 CloudRobo；优必选 Thinker-WM 在三个具身世界模型基准登顶〔厂商宣称〕。

### 4.2 真实部署

- **Figure + BMW**：F.02 在 Spartanburg，11 个月、1,250+ 小时、90,000+ 零件、支撑 30,000+ 台 X3；**机器人数量与自主率均未披露**〔已核实〕。F.03 于 2026-06 进厂为"首次演示"。
- **Agility**：GXO 搬运超 100,000 个周转箱；Digit 在 GXO/Schaeffler/Amazon/Toyota 加拿大累计 65,000+ 小时；Digit 5（2026-09）载重 22.7kg、90 分钟续航/9 分钟快充、无围栏协同安全；**2027 H1 early access、2027 年底 GA**；3 亿美元多年订单〔已核实〕。
- **优必选**：2026 H1 全尺寸人形销量 921 台、收入 5.9 亿元（+1445%）、毛利率 44.7%，仍亏损；管理层自认效率为人类 30–50%。
- **智元**：H1 出货 8,600+ 台；**宇树**：科创板 IPO，H1 约 5,000 台；**银河通用**：宁德时代 2.36 亿元采购 S1。
- **Tesla Optimus**：V3 推迟，周产数百台，无第三方可验证的外部客户部署。

### 4.3 市场数据

- **IDC**〔第三方〕：2026 H1 全球出货约 2.5 万台（+432%）、销售额 7.4 亿美元、均价 2.96 万美元（-20%）；中国企业占 95%+；**69% 流向科研/教育/展演**，仅 31% 进实际工作场景；2030 年预计年出货 75 万台。
- **Counterpoint**：2025 年全球安装 1.6 万台，中国占 80%+。
- **Reuters**：2025 年"销售"仅约 7,000 台——与安装量并存，说明口径混乱。
- **高盛**（2026-09）：2035 年上调至 650 万台 / 1,380 亿美元；**摩根士丹利**：2026 中国出货翻倍至 5 万台。

### 4.4 安全与监管

ISO 10218-1/-2:2025 完成大修，把 ISO/TS 15066 并入，允许移动平台机械臂，但**移动稳定性风险不在覆盖范围**；人形专属 **ISO 25785-1** 仍在 CD 阶段。欧盟机械法规 2027-01-20 生效，新增"AI 安全功能/自我演化行为"须公告机构评估——Skild AI 这类"执行训练数据之外任务"的模型正落在定义中心。中国提出 2028 年前制定至少 100 项人形/具身智能标准。

---

## 五、横向判断：三条主线

**1. 反馈基础设施比模型能力更决定落地速度。**
嵌入式（HIL 闭环）、EDA（工具交互 + signoff）、机器人（真机数据飞轮）三个领域独立收敛到同一结论。Embedded Arena 的 0%→成功、Quilter 的 30–40 小时人工清理、Build-A-Chip-Bench 的 40%→10% 落差，都是同一件事的不同侧面。

**2. 协议层正在成为新的竞争面。**
MCP（无状态化后对 MCU 友好）、Android AppFunctions（设备端 MCP 等价物）、DCP（能力边界 + 主机侧 bridge）、Anthropic Model Hardware Standard（标准化驱动 + 约束标签）——安全约束写在协议里，比写在模型里更可审计。

**3. 信任缺口是跨行业共同瓶颈。**
设计工程软件：仅 13–24% 高度信任 AI 的各类输出；嵌入式：没有任何厂商宣称可交付认证固件；机器人：ISO 25785-1 未定稿、欧盟法规 2027 生效。**"AI 作为审计者"的信任度显著高于"AI 作为作者"**（Coldcard 在 1 亿美元失窃后称 AI 帮助发现更多 bug）。

---

## 六、对工程实践的启示（面向构建嵌入式 Agent 的团队）

1. **先建回路，再谈模型**：编译—烧录—串口/调试探针—仪器测量，四段闭环缺一段，成功率断崖。
2. **把知识做成 skill，而不是塞进 prompt**：IoT-SkillsBench 的对比说明专家撰写的简洁 skill 比模型规模更关键。
3. **不要用通用 MCP 直连硬件**：DCP 的实验显示裸 MCP 对能力越权与提示注入几乎无防护（0–1% vs 100%/78%）。
4. **设备端只做窄任务模型**：Needle（14MB，78ms）与 FunctionGemma（288MB）是现实路径；通用小模型在 1–3B 才勉强可用，且工具调用成功率仍是瓶颈。
5. **选型看功耗与首 token 时延，不看 TOPS**：Pi AI HAT+ 2 的实测反例说明 NPU 解码吞吐可能不如 CPU。
6. **为认证预留证据链**：生成代码只能作为"不可信草稿"，需与手写代码同样经过评审、静态分析、可追溯性与测试；工具置信度负担应放在编译器/静态分析器等确定性环节。

---

## 七、来源索引（精选，按主题）

### 嵌入式软件
- Embedded Arena — https://arxiv.org/abs/2606.16190
- Closed-loop evaluation of LLM agents for embedded software development — https://arxiv.org/abs/2610.11447
- Skilled AI Agents for Embedded and IoT Systems (IoT-SkillsBench) — https://arxiv.org/abs/2603.19583
- AutoEmbed（SenSys 2026）— https://autoembed.github.io/ ；论文 PDF https://www.cs.cityu.edu.hk/~zhenjili/2026-SenSys-AutoEmbed.pdf
- Securing LLM-Generated Embedded Firmware — https://arxiv.org/abs/2509.09970
- HardSecBench — https://arxiv.org/abs/2601.13864
- Device Context Protocol — https://arxiv.org/abs/2605.26159
- PLCBench — https://arxiv.org/abs/2608.26882
- ReproBench — https://arxiv.org/abs/2609.34450
- Promwad：GenAI 在真实固件中的失败模式 — https://promwad.com/news/genai-for-firmware-llm-code-generation-certification-risks
- AMD Ross（报道）— https://techrepublic.com/article/news-amd-ross-ai-embedded-development/
- Siemens Questa One Agentic Toolkit — https://www.semiconductor-digest.com/siemens-accelerates-ic-design-and-verification-with-agentic-ai-in-questa-one/
- Espressif ESP-IDF VS Code 扩展 v2.3.0 — https://developer.espressif.com/blog/2026/10/esp-idf-vscode-extension-v230/
- Esparagus（面向 agent 的 ESP32 烧录）— https://developer.espressif.com/blog/2026/08/esparagus-esp32-flashing-for-ci-and-agents/

### 端侧/边缘
- ExecuTorch on Arm Cortex-M — https://pytorch.org/blog/bringing-executorch-to-arm-cortex-m-cpus/
- Raspberry Pi：Needle 14MB 函数调用模型 — https://www.raspberrypi.com/news/turn-text-input-into-actions-with-needle-a-14mb-function-calling-llm/
- CNX：28.9M 参数 LLM 在 ESP32-S3 跑 9 tok/s — https://www.cnx-software.com/2026/08/03/28-9m-parameter-llm-runs-locally-on-esp32-s3-at-9-tokens-s/
- CNX：Raspberry Pi AI HAT+ 2 实测 — https://www.cnx-software.com/2026/01/20/raspberry-pi-ai-hat-2-review-a-40-tops-ai-accelerator-tested-with-computer-vision-llm-and-vlm-workloads/
- Oído（ESP32-S3 语音识别）— arXiv 检索 "Oído"
- LiteRT-LM — https://developers.google.com/edge/litert-lm/overview
- Android AppFunctions — https://developer.android.com/ai/appfunctions
- MCP 2026-07-28 规范变更 — https://modelcontextprotocol.io/specification/2026-07-28/changelog
- Jetson Thor — https://www.nvidia.com/en-us/autonomous-machines/embedded-systems/jetson-thor/
- Arduino UNO Q — https://www.arduino.cc/product-uno-q/
- R&S MXO AI Connect — https://www.rohde-schwarz.com/us/products/test-and-measurement/ai-workplace-software/mxo-ai-connect-ai-for-mxo-oscilloscopes_258817.html
- 边缘 AI 市场（Grand View）— https://www.grandviewresearch.com/industry-analysis/edge-ai-market-report
- AI 信任缺口（IoT Analytics）— https://iot-analytics.com/the-ai-trust-gap-in-design-and-engineering-software/

### EDA / 芯片设计
- Quilter Speedrun 复盘（58 项 DFM/DFA）— https://www.quilter.ai/blog/ai-designed-motherboard-dfm-dfa-lessons
- VentureBeat：Quilter 843 元件 Linux 电脑 — https://venturebeat.com/ai/quilters-ai-just-designed-an-843-part-linux-computer-that-booted-on-the
- Siemens Fuse 装机与产线数据 — https://techwireasia.com/2026/08/siemens-open-eda-fuse-chip-design/
- Synopsys AgentEngineer — https://www.semiconductor-digest.com/synopsys-powers-autonomous-engineering-with-a-broad-portfolio-of-long-horizon-agents-and-autopilot-platform/
- GPT-Synopsys — https://news.synopsys.com/2026-09-30-OpenAI-and-Synopsys-Announce-GPT-Synopsys-Frontier-Intelligence-to-Revolutionize-Chip-Design
- Build-A-Chip-Bench — https://www.semiconductor-digest.com/chipagents-nvidia-launch-benchmark-for-autonomous-chip-design/
- Flux“First AI Hardware Engineer” — https://www.flux.ai/p/blog/the-first-ai-hardware-engineer
- 原理图→PCB handoff 缺口 — https://www.electronicdesign.com/technologies/eda/article/55410659/speedup-schematic-to-pcb-handoff-for-pcb-layout-automation
- CVDP — https://arxiv.org/abs/2506.14074
- HWE-Bench — https://arxiv.org/abs/2604.14709

### 机器人/具身
- Figure Helix 2.5 — https://www.figure.ai/news/helix-2-5-zero-shot-30-home-generalization
- Figure F.02 @ BMW — https://www.figure.ai/news/production-at-bmw
- Figure F.03 @ BMW — https://www.figure.ai/news/f-03-at-bmw
- Agility Digit 5 — https://agilityrobotics.com/content/agility-unveils-digit-5-humanoid-robot-built-for-cooperatively-safe-work-at-scale
- Gemini 4 Argon for Robotics — https://developers.googleblog.com/gemini-4-argon-for-robotics
- Gemini Robotics ER 2 — https://blog.google/innovation-and-ai/models-and-research/google-deepmind/gemini-robotics-er-2/
- π0.7 — https://www.pi.website/blog/pi07
- Pi API beta — https://www.pi.website/blog/api-beta
- UBTech H1 2026 业绩 — https://kr-asia.com/ubtechs-full-size-humanoid-robot-revenue-jumps-1445-in-h1-2026
- IFR：全球工业机器人存量 500 万台 — https://ifr.org/ifr-press-releases
- Skild AI 与欧盟机械法规 — https://thenextweb.com/news/skild-ai-100m-run-rate-eu-rules
- Siemens CES 2026 工业 AI — https://press.siemens.com/global/en/pressrelease/siemens-unveils-technologies-accelerate-industrial-ai-revolution-ces-2026

---

## 八、方法与局限

- **可靠性分层**：本报告对每条关键结论做了"已核实 / 厂商宣称 / 未证实"标注。凡厂商单方面数字（吞吐、TOPS、提效倍数）均按厂商口径处理。
- **检索限制**：本次通用搜索接口多次返回无关结果，实际证据主要通过 arXiv API、厂商 RSS/新闻室、GitHub API、行业媒体与中文产业媒体获取；部分站点（Cadence、Siemens Press、Reuters、Ars Technica）有反爬或付费墙，相关事实改用其转载源或已标注为未直接核实。
- **口径差异**：人形机器人"出货/安装/销售"三个口径差异可达 2–3 倍；边缘 AI 市场"硬件/软件/整体"口径差异可达 47%。引用时必须保留定义。
- **时效**：本报告截至 2026-10-18。该领域产品状态（GA/预览/宣布）变化很快，建议在决策前复核厂商页面。
