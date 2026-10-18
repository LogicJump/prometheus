# 嵌入式知识格式调研

调研日期：2026-10-18。目标：为 agent 找到「寄存器在哪、引脚能做什么、板子有什么」的机器可读来源。
**所有尺寸与计数均为实测下载文件得出**，不是回忆。

---

## 一、格式总表

| 格式 | 编码什么 | 来源 | 许可 | 解析 |
|---|---|---|---|---|
| CMSIS-Pack `.pdsc` | 器件/系列树、内存映射、烧录算法、调试 AP、SVD 指针、板卡挂载 | `keil.com/pack/index.pidx` → 各厂商 pack | 每厂商不同 | `cpackget`、`cmsis-pack-manager`、XML |
| CMSIS-SVD `.svd` | 外设→寄存器→字段→枚举 | DFP pack 内 `CMSIS/SVD/`、厂商仓库 | 混合，常 Apache-2.0 / BSD-3 | `cmsis-svd`(py)、`svd-parser`(rust) |
| Zephyr board YAML | 板子身份、架构、RAM/flash、支持的外设 | `zephyr/boards/<arch>/<board>/*.yaml` | Apache-2.0 | PyYAML |
| Zephyr DT bindings | DTS 节点 schema | `zephyr/dts/bindings/**`（v4.2.0 共 2,952 个） | Apache-2.0 | `edtlib` |
| PlatformIO `boards/*.json` | MCU、主频、flash/RAM 上限、烧录协议、**`debug.svd_path`** | `platformio/platform-*/boards/` | Apache-2.0 | JSON |
| Arduino `boards.txt` | 板子 ID → MCU、F_CPU、variant、上限、VID/PID | Arduino core 仓库 | 各异 | properties |
| Embassy `stm32-data-generated` JSON | 封装引脚 AF 映射、内存、RCC 使能位 | `embassy-rs/stm32-data-generated` | MIT/Apache | JSON |
| probe-rs target YAML | 核心类型、AP、内存、烧录算法 | `probe-rs/probe-rs` `targets/`（199 个文件） | Apache-2.0 | YAML |
| ST `STM32_open_pin_data` XML | 引脚→复用功能表 | `STMicroelectronics/STM32_open_pin_data` | BSD-3 | XML |

---

## 二、SVD：核心数据源

### 实测规模

| SVD | 字节 | 外设 | 寄存器 | 字段 | 枚举 | 簇 | 派生 |
|---|---|---|---|---|---|---|---|
| STM32H743 | 4.03 MB | 71 | 1,988 | 11,127 | 544 | 0 | 51 个外设 |
| STM32F401 | 855 KB | 31 | 459 | 2,847 | 0 | 0 | — |
| nRF52840 | 2.15 MB | 74 | 875 | 2,429 | 4,914 | 59 | 31 |
| ESP32 | 1.73 MB | 36 | 1,381 | 5,262 | 35 | 0 | — |
| RP2040 | 2.59 MB | 32 | 1,014 | 5,247 | 2,314 | 0 | 5 |

### 关键发现：两级检索是可行的

在 STM32F401 上实测：

- **完整压缩表**（`PERIPH.REG @offset w<size>: FIELD[bit:width], …`）：855 KB XML → **47,370 字符 ≈ 12k token**
- **名称/偏移索引**：**8,985 字符 ≈ 2.2k token**

所以设计是三级的：

1. **索引层**（每次嵌入式对话都带）：外设.寄存器 → 偏移、大小。约 2k token。
2. **外设详情层**（问题提到某外设时才取）：STM32F401 最大的五个外设各 2.5–4.8 k 字符。
3. **枚举层**（配置类问题才取）：nRF52840 有 4,914 个枚举，占大头。

**索引必须带解析后的基地址**，否则派生外设看起来是空的。

### 必须处理的脏数据

| 问题 | 说明 |
|---|---|
| `derivedFrom` 链 | 派生外设可以只有 name + baseAddress + 中断。STM32H743 71 个外设里 51 个是派生的 |
| `lsb/msb` vs `bitOffset/bitWidth` | 同一文件里两种混用，都得支持 |
| 数组 | `dim`、`dimIncrement`、`dimIndex` 作用于外设、簇、寄存器 |
| 保留位被省略 | 只能从空隙推断 |
| 枚举位置不一 | 有时挂在父寄存器，有时每字段重复 |
| 簇嵌套 | 1.3 版本起 cluster 可嵌套 cluster |
| 版本不一 | 厂商写 `schemaVersion="1.1"` 或 `1.2`，规范是 1.3.12 —— **宽松解析，不要严格校验** |

`svdtools` 这个项目的存在本身就是证据：厂商 SVD 需要先修再用。

### 许可的陷阱

**同一份 ST SVD，两套许可故事**：
- pack 内文件头写 Apache-2.0
- `cmsis-svd-data` 里同一批文件带 ST 自己的 EULA（仅限"开发 LICENSEE 的开发工具"）

结论：**运行时从厂商自己的 pack 拉取，不要 vendor 进仓库**；真要分发，逐个厂商做法律审查。

---

## 三、板卡元数据：最便宜的信息源

- **Zephyr board YAML**（几百字节）：`identifier`、`name`、`arch`、`ram`(KB)、`flash`(KB)、`supported`（`adc`、`i2c`、`netif:openthread`…）、`vendor`。回答「这块板有没有 I2C」最便宜的来源。
- **PlatformIO board JSON**：`upload.maximum_size`、`upload.maximum_ram_size`、`debug.openocd_target`、**`debug.svd_path`** —— 每块板免费附带的 SVD 线索。
- **Embassy chip JSON**：目前最好的开源「哪个引脚能做 USART2_TX」和「哪个 RCC 位门控 SPI1」的来源。字段包括 `packages[].pins[].signals[]`、`cores[].peripherals[].rcc{enable{register,field}}`。

---

## 四、PDF 手册：只做第二等公民

**实测的失败模式**：在 TI SLAU208Q（1,190 页）的 DMACTL3 寄存器页上，`pdftotext -layout` 把位域和名字错行配对 —— `15-13 Reserved R 0h` 后面跟着 `12-8 DMA7TSEL RW 0h Reserved. Always reads as 0.`，值挂到了错误的行上。

这不是边缘情况：双栏寄存器图的表格是**定位文本**画出来的，layout 模式保留 x/y 坐标，不保留单元格归属。

排序：

1. **有 SVD 或 CMSIS 头文件时，永远不要 RAG 寄存器表**。SVD 是偏移和字段的 ground truth；手册只用来查 **语义**（这个字段*做什么*）。
2. `pdfplumber`（MIT）：机器生成的 PDF 里通用表格抽取最好。
3. `Camelot`（MIT）：lattice 模式处理有框线的表。
4. `pdftotext -layout`：散文和简单表可以，位域图不可靠。
5. **PyMuPDF 是 AGPL-3.0**：分发产品里的许可陷阱，避开。

**索引布局**：按*章节*切块，不是按页 —— 一个寄存器一块（标题 + 位域表 + 描述），元数据 `{device, peripheral, register, offset, manual, page}`，并把 SVD 推导出的偏移存进去做交叉校验。

---

## 五、推荐的摄取流程

1. **确定器件身份** → `(vendor, Dname)`；查 `index.pidx`（240 KB，1,824 条 pack，73 个厂商）找到所属 pack 和版本。索引缓存，每周刷一次。
2. **取 pack 并解包** → `cpackget init` 到受管目录；只要烧录/内存数据的话 `probe-rs target-gen pack` 更轻。
3. **分层抽取**：
   - pdsc → 内存映射、烧录算法、SVD 路径、板卡挂载、**`<book>` 元素直接给出参考手册和数据的正确 URL**（用这个去种 RAG，别猜手册版本）
   - SVD → 解析派生、展开数组、归一化位域 → 输出索引层 + 外设详情层
   - 板卡层 → Zephyr YAML（能力）/ PlatformIO JSON（`svd_path`、上限）/ Arduino `boards.txt` / probe-rs YAML
   - 引脚层 → Embassy JSON 或 ST pin data
4. **每个事实带出处**：`{source_format, pack_name, pack_version, file_path, extraction_date}`。寄存器偏移没有 pack 版本就是不可证伪的。
5. **手册 RAG 排第二**：按寄存器章节索引；SVD 偏移做交叉校验；抽取失败的表标出来人工看，不要静默嵌入。
6. **回答策略**：索引层常驻；外设详情按需；手册散文只答 SVD 表达不了的（副作用、勘误、时序）。**SVD 和手册冲突时两个都摆出来并标出处，不要静默挑一个。**

---

## 六、厂商 SVD 质量

| 厂商 | 位置 | 许可 | 质量 |
|---|---|---|---|
| ST STM32 | `Keil.STM32xxxx_DFP` pack 内 | 文件头 Apache-2.0；`cmsis-svd-data` 里是 ST EULA | 派生很重；枚举覆盖不一（H743 有 544，F401 是 0） |
| Nordic nRF | Nordic DFP | BSD-3 | 结构最好：59 个簇、4,914 枚举；pack 2021 年后没更新 |
| Microchip SAM | `packs.download.microchip.com` | Apache-2.0 | 每个型号一个 SVD |
| Raspberry Pi RP2040 | `pico-sdk` | BSD-3 | 完整但命名稀疏 |
| Espressif ESP32 | `github.com/espressif/svd` | Apache-2.0 | README 自己说"in-progress，可能缺外设/中断/寄存器"；S3 有 0 枚举 |
| 聚合 | `cmsis-svd-data` | **混合** | 方便但陈旧（2025-01 最后推送） |
