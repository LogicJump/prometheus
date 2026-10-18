# 嵌入式工具链：许可、打包、探测

调研日期：2026-10-18。所有体积都是**实测下载资源**（GitHub/GitLab API、HTTP `Content-Length`），不是估计。

---

## 零、一句话结论

> **这里几乎每个编译器/调试工具都是 GPL，但它们全是独立可执行文件 —— 专有 Electron 应用可以把它们当作独立进程打包并调用**，只要为 GPL 二进制提供源码和声明，且不把 GPL 代码链接进自己的进程。

例外是 LLVM/Clang（Apache-2.0）和宽松许可的调试服务器（pyOCD、probe-rs、stlink）。

---

## 一、能不能打包

| 需要 | 最佳选择 | 许可 | 能打包？ |
|---|---|---|---|
| ARM 裸机 GCC | Arm GNU Toolchain 15.3.rel2 | GPLv3 + RLE；newlib BSD | **能**，需源码提供 + `license.txt` |
| ARM，宽松许可 | Arm Toolchain for Embedded 23.1.0（LLVM） | Apache-2.0 w/ LLVM exception | **能，最省事** |
| 通用 RISC-V | xPack riscv-none-elf-gcc 15.2.0-1 | GPLv3 + RLE | 能，需源码 |
| ESP32-C3/C6 | Espressif `riscv32-esp-elf` 16.1.0 | GPLv3 + RLE | 能 |
| 构建工具 | CMake 4.4.4 / Ninja 1.13.2 / Meson 1.12.1 | BSD-3 / Apache-2.0 / Apache-2.0 | 能 |
| GNU Make | 4.4.1 | **GPLv3+** | 能，但**别用** —— 换 Ninja |
| 调试/烧录 | probe-rs、pyOCD、OpenOCD、stlink、esptool、dfu-util | MIT/Apache、Apache、GPLv2、BSD-3、GPLv2、GPLv2 | 能（GPL 的需源码） |
| **J-Link / Keil / IAR / CubeProgrammer / NI-VISA** | 专有 | 不可再分发 | **只探测，用户自己装** |

---

## 二、体积预算（Windows x64）

| 方案 | 压缩后下载 | 安装后 |
|---|---|---|
| **瘦安装包**（Electron + CMake/Ninja + probe-rs + pyOCD + OpenOCD + stlink），SDK 首次运行时下载 | **~120–150 MB** | ~400 MB + SDK |
| **只做 ARM**（Arm GCC + 构建工具 + 调试烧录） | **~435 MB** | ~1.5 GB |
| **ARM + ESP C3/C6**（riscv32-esp-elf + esptool + openocd-esp32） | **~930 MB** | ~3.0 GB |
| ARM + ESP C3/C6 + **ESP-IDF 源码一起打包** | ~2.9 GB | ~5.5 GB |
| ARM + RISC-V + ESP + Zephyr（精简） | ~1.35 GB | ~4.5 GB |
| **全都打包** | **~5.0–5.4 GB** | **~11–13 GB** |

**建议**：瘦安装包 + 按生态可选的离线「SDK 包」，下载钉版本、校验 SHA-256。只需要 ARM 的用户不该被迫下 2 GB 的 Zephyr。离线包同时也是满足 GPL 源码提供义务最干净的方式。

---

## 三、GPL 的边界（这是整个方案成立的基础）

FSF GPL FAQ 原文：

> "By contrast, pipes, sockets and command-line arguments are communication mechanisms normally used between two separate programs. So when they are used for communication, the modules normally are separate programs."

GPLv2 补充：

> "mere aggregation of another work not based on the Program … on a volume of a storage or distribution medium does not bring the other work under the scope of this License."

所以：

**允许**
- 把 `arm-none-eabi-gcc`、`openocd`、`esptool`、`dfu-util`、`JLinkGDBServerCL.exe` 作为子进程启动
- 传文件路径和参数、读 stdout/stderr
- 用自己的代码解析 JSON/SVD/ELF
- 把它们放进同一个安装包

**不允许（除非整个应用 GPL 化）**
- 把 `libopenocd`/`libgcc`/`libstdc++` 链接进 Node 原生模块或 Electron 进程
- 用 FFI 加载 GPL DLL
- 在跑专有 Python 的同一个解释器里 `import esptool`
- 通过 WASM 嵌入 GPL 代码
- 以复杂内部结构作为主要接口共享内存

**打包 GPL 二进制时的义务**
1. 提供对应源码（GPLv3 §6）—— 打包 ~360 MB 的 Arm 源码快照，或托管并提供等效访问，或有效期 ≥3 年的书面承诺
2. 附上全部许可文本和声明（Arm 的 `license.txt` 553 KB，newlib 的逐文件声明）
3. 不得附加额外限制（GPLv3 §10）—— 你的 EULA 必须豁免工具链，允许反向工程/重新链接
4. 改过就要标记（§5a）

**GPLv3 反 Tivo 化（§6 "Installation Information"）**：只有当你在「用户产品」中、且阻止替换二进制时才触发。**装到用户可写的普通目录、不要用校验和锁住二进制**就没事。桌面 PC 是否算「用户产品」有争议，但这条风险对普通 Electron 安装包很低。

---

## 四、一个重要发现：Homebrew 的 GCC 是残缺的

| | Arm 官方 | xPack | **Homebrew** |
|---|---|---|---|
| 版本 | 15.3.rel2（GCC 15.3） | 15.2.1-1.1 | GCC 16.2.0 |
| C 库 | newlib + newlib-nano，完整 multilib | 同左 | **无** —— `--without-headers`，只有 `all-gcc` + target-libgcc |
| 能链接 libc 程序吗 | 能 | 能 | **不能** |
| 结论 | **推荐打包** | 需要 GDB+Python/XML 时好用 | **作为完整工具链不可用** |

**这是个真实的陷阱**：基于 `gcc --version` 的探测会愉快地接受 Homebrew 的版本，然后在链接阶段失败。

**正确的探测方式**：

```bash
arm-none-eabi-gcc -print-file-name=libc.a
```

- Homebrew 返回原样的 `libc.a`
- 完整的 Arm 安装返回 `…/thumb/v6-m/nofp/libc.a`

其他验证：
- `arm-none-eabi-gcc -dumpmachine` 必须是 `arm-none-eabi`
- `-dumpfullversion` 给出版本号
- 标记文件：Arm 根目录有 `license.txt` + `<version>-<host>-<triple>-manifest.txt` + `arm-none-eabi/lib/thumb/…`；xPack 有 `package.json` + `licenses/`

---

## 五、LLVM 是不是更好打包？

**是，明显更好。**

Apache-2.0 with LLVM exception 是宽松许可：**没有源码提供义务，没有 copyleft，有明确专利授权**。义务只有：附许可、保留声明、修改则说明。

**但缺什么**：
- 没有 libstdc++（用 libc++，其 ABI 明确**不稳定**）
- 没有 Fortran、没有 gcov
- 没有 GNU 驱动名 —— 构建系统和厂商 SDK 硬编码了 `arm-none-eabi-gcc`，需要包装脚本和参数转换
- multilib 矩阵不同，默认 FPU 选择不同
- **厂商生态是 GCC 优先的**：STM32Cube、MCUXpresso、Xtensa 版 ESP-IDF、大多数 CMSIS 启动/链接脚本
- 没有 GDB（给的是 lldb），没有 `-specs=nano.specs`/`nosys.specs` 兼容层

**结论**：想省掉 GPL 义务就用 ATfE，但现阶段用户生态是 GCC 的。**我们的方案：打包 Arm GNU GCC（带源码），ATfE 作为可选替代。**

---

## 六、专有工具的正确模式

| 厂商 | 条款要点 | 模式 |
|---|---|---|
| **SEGGER J-Link** | 「软件由 SEGGER 的专有程序组成……所有权利归 SEGGER」「**只能与正品 SEGGER 产品及授权 OEM 产品一起使用**」 | 探测安装（`C:\Program Files\SEGGER\JLink*`、`JLinkGDBServerCL.exe`），显示「从 segger.com 安装」，作为独立进程启动。**绝不打包** |
| Keil MDK | 商业许可 | 探测 `UV4.exe` |
| IAR EWARM | 商业 EULA | 探测 `IarBuild.exe` |
| STM32CubeProgrammer | 专有点击式 EULA | 探测 `STM32_Programmer_CLI.exe`；或用 OpenOCD/pyOCD 完全避开 |
| NI-VISA | 专有，运行时再分发受限 | 探测 `visa32.dll` |
| Saleae Logic 2 | 应用专有；**`logic2-automation` 是 Apache-2.0** | 打包 Apache-2.0 的客户端库，要求用户装 Logic 2，走本地 gRPC |

**统一架构**：一个 `ToolchainLocator` 返回 `{found, path, version, source: 'bundled'|'system'|'vendor'}`，UI 显示「J-Link 已检测到：C:\Program Files\SEGGER\JLink_V986」或「获取 J-Link」按钮。**不抓取、不重新打包厂商安装器。**

---

## 七、探测配方

1. **显式设置优先**，然后已知安装根目录，最后才是 `PATH`。**永远不要假设 `PATH` 里的 `arm-none-eabi-gcc` 是完整的。**
2. **靠执行验证**，带超时：`-dumpmachine` → `arm-none-eabi`；`-dumpfullversion` → 版本
3. **识别 Homebrew 陷阱**：`-print-file-name=libc.a` 必须解析到真实文件
4. **各生态的安装根**：
   - ESP-IDF：`IDF_PATH`、`IDF_TOOLS_PATH`（默认 `%USERPROFILE%\.espressif`）
   - Zephyr：`ZEPHYR_SDK_INSTALL_DIR`、`ZEPHYR_TOOLCHAIN_VARIANT=zephyr`
   - PlatformIO：`PLATFORMIO_CORE_DIR` 或 `~/.platformio`
   - Arduino：`~/.arduino15`
5. **记录来源**（`bundled`/`system`/`vendor`）并在 UI 显示解析后的路径。**绝不悄悄混用不同版本的打包编译器和系统链接器。**
6. **Windows 安装根要短**：`%LOCALAPPDATA%\Prometheus\toolchains\arm\15.3.rel2`，因为 multilib 路径很深（`arm-none-eabi\lib\thumb\v8.1-m.main+pacbti+mve\bp\hard\libstdc++.a`）。装到用户目录避免管理员权限，并保持目录可替换（GPL 合规）。

---

## 八、OpenOCD 的维护风险

**自 2023-01-14 的 0.12.0 之后没有稳定版**。2026-10-16 只有预发布快照（仅 mingw32）。

对策：钉死一个 xPack 构建或自己构建，钉 commit 并归档源码。它也是最需要按目标提供配置/板卡文件的工具 —— 从 `share/openocd/scripts` 取。

---

## 九、我对打包方案的建议

结合上面的数据：

**默认：瘦安装包（~130 MB）**
- Electron 本体
- CMake + Ninja
- probe-rs + pyOCD + OpenOCD + stlink（全部宽松或 GPLv2 且体积小）
- 首次使用时按需下载 SDK

**可选离线包**（每个都是完整的、含源码，满足 GPL）
- ARM（~435 MB）
- ESP32-C3/C6（~500 MB）
- Zephyr 精简（~313 MB）

**理由**：
1. 只做 ARM 的用户不会被迫下 5 GB
2. 离线包里带源码快照，GPL 义务自然满足
3. probe-rs（MIT/Apache）作为默认调试器，OpenOCD 作为备选 —— 前者许可更干净
4. 专有工具全部走探测 + 深链，不进安装包

**需要你定的**：安装包默认是「瘦」还是「ARM 开箱即用」？我倾向瘦，但它意味着第一次用 ARM 要等一次下载（~290 MB，几分钟）。如果目标是「装上就能用」，就选 ARM 开箱即用。
