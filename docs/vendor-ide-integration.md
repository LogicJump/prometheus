# Keil / IAR：从「认得出来」到「能用」

日期：2026-10-20。上一版的行为是：认出 `.uvprojx` / `.ewp`，然后告诉用户「去 IDE 里构建」。
那份文案对一部分人是可执行的，但对 Keil 工程不是——Keil 的构建依赖它自己的编译器、
器件包和 scatter file，补一个 CMake 往往等于重建工程。所以这里把「只有一句拒绝」
补成了「探测 + 驱动 + 读日志」。

范围只到**构建**。调试仍然是探针那条链路（pyOCD / probe-rs / OpenOCD / J-Link），
不用 Keil 或 IAR 的调试器。

---

## 一、不可分发的边界没有动

Keil MDK 与 IAR EWARM 都是商业授权软件。本次改动遵守既有规则
（见 `embedded-toolchain-packaging.md` 第六节）：**只探测、只调用用户自己装的，
不打包、不下载、不重新分发任何厂商二进制**。

具体表现：

- 安装包里仍然没有任何 `UV4.exe` / `IarBuild.exe` / 器件包。
- 没有「安装」按钮，也没有 `winget` / 下载链接——只有产品官网和「需要许可证」的说明。
  给 Keil 编一个包管理器命令会是个死胡同。
- 探测是只读的：只 `stat` 已知路径，不执行 IDE。

---

## 二、探测

`src/embedded/toolchain.ts` 新增两个工具种类 `keil`、`iar`，和现有 23 个工具走同一套
`detectToolchains()`。

**为什么要写死路径。** 厂商 IDE 故意不把自己的目录放进 `PATH`：机器上可能装着两个
IDE，用户自己的 `PATH` 不该被迫和它们达成一致。所以规格里多了一个 `paths` 字段，
列出已知安装位置，按顺序试：

| 工具 | 查找位置 |
|---|---|
| `UV4.exe` | `C:\Keil_v5\UV4`、`C:\Keil\UV4`、`Program Files` / `Program Files (x86)` 下的 `Keil_v5\UV4` 与 `Keil\UV4` |
| `IarBuild.exe` | `Program Files\IAR Systems\Embedded Workbench 9.4 / 9.3 / 9.2 / 9.1 / 9.0\common\bin`，以及 `(x86)` 下的 8.5 / 8.4 / 8.3 |

`PROMETHEUS_TOOLCHAINS` 仍然优先，装在别处的用户可以把目录加进去。

**版本号不从 `--version` 读。** 这两个程序没有安全的版本开关：`UV4 -h` 会打开 Keil 的
图形界面，为了读一个数字去启动一个有授权的 IDE 是不该发生的事。改成读 PE 资源的
`FileVersion`（PowerShell 一句 `Get-Item ... .VersionInfo.FileVersion`）。

设置页的「本机检测到的工具链」会自动多出这两行，和其它工具一样显示已找到/缺失、
路径和来源，不需要页面改动。

---

## 三、构建

`buildCommand()` 里原来的 `case "keil": case "iar": return null` 换成了真实命令。

### Keil

```
UV4.exe -b <project.uvprojx> -j0 -o <project>\build\keil-build.log
```

- `-b` 是官方的批处理构建，不打开 GUI。
- `-j0` 不弹任何对话框——否则构建会停在一个没人能点的窗口上。
- `-o` 指定日志文件。**这是关键**：`UV4 -b` 的控制台输出基本没用，真正的
  `file(line): error: #20: ...` 全在日志里。以前没人读这个文件，所以即使命令跑通了
  也拿不到一条诊断。

退出码是位掩码：`0` 干净，`1` 有警告，`2` 有错误，`11/13/15` 是「打不开工程」那一类。
现在仍然按「退出码 0 且没有 error 级诊断」判定成功——后者更重要，因为 Keil 有时会
在报错的同时返回 0。

产物是 **`.axf`**，也就是 ELF。`findArtifacts()` 之前只认 `.elf`，`.axf` 会被找到然后丢掉；
现在按 ELF 处理（IAR 的 `.out` 同理）。

### IAR

```
IarBuild.exe <project.ewp> -build Debug|Release
```

`-build` 后面是配置名；`release` 选项选 `Release`，否则 `Debug`。产物 `.out` 按 ELF 处理。

---

## 四、占用（flash / RAM）

Keil 构建出的镜像没有 GNU `size` 能读——机器上可能根本没装 GNU 工具链。改成用 Keil
自带的 `fromelf.exe`（在 `UV4.exe` 旁边）：

```
fromelf --text -c <image.axf>
```

输出里的 `Total RO Size` / `Total RW Size` 两行就是 flash 和 RAM。括号里是给人看的
单位（`12.06kB`），字节数在括号前——第一版正则把括号当成字节数，测试立刻抓到了。

没有 `fromelf` 或解析不到合计时返回 `undefined`，**不返回 0**：0 会被读成「镜像是空的」，
比空白更糟。

---

## 五、没装 IDE 时说什么

`embed_build` 的拒绝文案从「去 IDE 里构建，或补一个 CMake/Makefile」改成：

> This is a Keil MDK project, and UV4.exe was not found. Keil MDK is licensed and is never
> bundled with this app, so it has to be installed here first. Install it, then build again;
> the project's own build is what this runs, not a replacement for it.

安装提示（`installHints.ts`）也补了两条，明确「需要许可证」并指向官网，不给假的下载命令。

---

## 六、验证

测试文件 `tests/round10-vendor-ide.test.ts`（10 条）：

| 测的东西 | 断言的依据 |
|---|---|
| 两种工具是一等公民 | 在 `TOOLCHAIN_INFO` 里、属 build 组、文案说明「licensed / never bundled」 |
| 工程文件选择 | 目录里有多个 `.uvprojx` 时取字典序第一个；`.eww` 工作区不算工程；没有工程文件时不生成裸命令 |
| 日志能解析 | 用 UV4 真实日志格式喂给 `parseDiagnostics`，得到 error/warning 两条 |
| 参数 | `-b`、工程路径、`-o` 与 `buildLog` 一致 |
| 产物后缀 | `.axf` 被识别为 `elf` |
| fromelf | 两种格式（带/不带括号单位）都能出 flash/RAM；无合计时返回 `undefined` |

本机实测（未安装 Keil）：

```
missing keil? true | missing iar? true
to install:
  keil: install Keil MDK from keil.com, then reopen this app (a licence is required)
```

用一份假的 `UV4.exe` 放在探测路径上验证过：`detectToolchains()` 能找到它，不再报缺失。

---

## 七、仍然做不到的

- **调试**：Keil/IAR 的调试器没有可用的命令行接口。调试仍走探针链路，用 `.axf` 里的
  符号和 `svd` 里的寄存器定义。
- **器件包**：Keil 的 pack 装在 `C:\Keil_v5\ARM\PACK`，不在现有的 CMSIS pack 搜索路径里。
  SVD 和器件参数目前仍从 `CMSIS_PACK_ROOT` / `%USERPROFILE%\AppData\Local\Arm\Packs` 找。
  把 Keil 的 pack 根加进搜索是个独立的小改动，没有做。
- **多工程/多目标**：一个目录里多个 `.uvprojx`、或一个工程里有多个 Target 时，目前取第一个。
  需要用户在参数里指定。
- **许可证问题不诊断**：没有授权时 `UV4` 可能返回一个位掩码，目前的结论会是「构建失败」，
  而不是「这是许可证问题」。识别它需要更多真实样本。
