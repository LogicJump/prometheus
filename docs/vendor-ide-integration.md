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

---

## 八、真实工程实测（2026-10-20）

工程：`G:\Develop\qianrushishiyan\实验3 触摸屏UI实验`（正点原子阿波罗 STM32F429，Keil MDK 5.43a，AC5）。
Keil 装在 `G:\software\keil5`，**不在** `C:\Keil_v5`。

这一轮把「跑一次真实工程」当作验收标准，而不是只跑单测。下面是实测中发现、并且已经修掉的：

| # | 问题 | 怎么发现的 | 修法 |
|---|---|---|---|
| 1 | 只扫根目录，找不到 `USER\TOUCH.uvprojx` | 工程根下只有 CORE/HALLIB/OBJ，工程文件在 `USER\` | `detectProject` 与 `keilProjectFile` 都改为根目录优先、再下一层（排除 OBJ/build 等输出目录） |
| 2 | 产物只扫根目录，`..\OBJ\TOUCH.axf` 找不到 | 工程把 `<OutputDirectory>` 设为 `..\OBJ\` | 从 `.uvprojx` 读 `OutputDirectory`，据此确定扫描目录 |
| 3 | `-o` 用相对路径时**日志根本没生成** | 第一次构建 exit 0、无诊断、无占用 | `-o` 改绝对路径，并在构建前创建父目录 |
| 4 | `fromelf` 找错位置 | 真机里它在 `ARM\ARMCLANG\bin` 与 `ARM\ARM_Compiler_5.06u7\bin`，不在 `UV4.exe` 旁边 | 按安装根下的 `ARM\` 两个位置查，再退化为扫描 `ARM_Compiler_*` |
| 5 | `fromelf --text -c` 不输出尺寸 | 占用报 0 | 换 `--text -z`；且优先用链接器打印的 `Program Size:` |
| 6 | 链接错误一条都没解析 | 故意写一个未定义符号，exit 2 但报告「0 error」 | 新增 armlink/armclang 格式 `file: Error: Lxxxx:` |
| 7 | `build()` 里旧的拒绝分支在命令生成之前就返回 | 修好命令后仍然报「UV4.exe 未找到」 | 删掉该分支，是否装了 IDE 交给实际运行去回答 |

还有一个**没有**修、但已经如实说明的：Keil 增量构建不必重新链接，日志里就没有 `Program Size:`，
此时占用只能来自 `fromelf`，而它的 `ROM Totals` 把 ZI 记成 0。这种情况报告会附一句话说明
「RAM 只含已初始化部分，全量重建才有精确值」，而不是把 108 字节当成 2 MB 镜像的 RAM。

### 实测结果

```
UV4.exe -b ...\USER\TOUCH.uvprojx -j0 -o ...\build\keil-build.log → ok   (4.7 s)
image: 50820 bytes flash, 2050472 bytes RAM
artifacts: TOUCH.axf (669952 B), TOUCH.hex (143286 B)
```

故意注入一个未定义符号后：

```
exit 2 · 1 error(s)
error: ../OBJ/TOUCH.axf:0 [L6218E] Undefined symbol undefined_symbol_x (referred from main.o).
```

### 非标准安装路径

`G:\software\keil5` 不在默认探测列表里。两条路都可用：

- 设 `PROMETHEUS_TOOLCHAINS=G:\software\keil5\UV4`（本次实测用这条验证）
- 读取 `TOOLS.INI`（`[ARM] PATH="G:\software\keil5\ARM\"`），从中反推安装根

第二个是从这份实测的 `TOOLS.INI` 里发现的真实格式，已加进 `keilRoots()`。
**注意**：这条是照着真实文件写的，但本次实测是用环境变量跑的，没有单独验证「只靠 TOOLS.INI
能否在默认位置之外找到」；如果 keil 装在别处，先用环境变量最稳。

### 遗留

- **需要全量重建才准确的 RAM**：见上。可以在构建前删除 `.axf` 强制重链接，但那会让每次
  构建都变慢，目前选择如实标注。
- **器件包路径**：Keil 的 pack 在 `TOOLS.INI` 的 `RTEPATH`（这里是 `G:\software\keil5pack`），
  不在现有 CMSIS pack 搜索路径里，SVD/器件参数仍可能找不到。
- **多 Target**：`TOUCH.uvprojx` 只有一个 Target，没测多 Target 情况。

---

## 九、Keil 的器件包（RTEPATH）

Keil 把器件包放在自己的目录里，路径写在 `TOOLS.INI` 的 `[UV2]` 段：

```ini
[UV2]
RTEPATH="G:\software\keil5pack"
```

这台机器上它不在任何原有搜索路径里，所以 SVD 和器件参数一直是找不到的。

### 做了什么

1. **加进 pack 搜索根**：`packRoots()` 现在会读 `TOOLS.INI` 的 `RTEPATH`。
   `TOOLS.INI` 的位置从**注册表**取——`HKLM\SOFTWARE\WOW6432Node\Keil\Products\MDK`
   的 `Path` 是 `G:\software\keil5\ARM`，父目录就是安装根。这比按 `C:\Keil_v5` 猜可靠，
   而且这就是本机装了非默认路径却能找到它的原因。默认路径仍作为后备保留。
   `KEIL_TOOLS_INI` 可覆盖。

2. **兼容 Keil 的目录层级**：cpackget 与 Arm 官方是 `root/vendor/version/`，
   Keil 是 `root/vendor/packName/version/`（多一层）。`installedPacks()` 两种都认。
   只加根不加这一条的话，扫出来是 0 个包。

3. **SVD 从 `<subFamily>` 继承**：Keil 的 DFP 把 `<debug svd="...">` 写在
   `<subFamily DsubFamily="STM32F429">` 上，而不是每个 `<device>` 里。现在设备继承所属
   子家族的 SVD 与 processor。

4. **器件名支持变体**：工程文件写的是 `<Device>STM32F429IGTx</Device>`，而 pdsc 里
   `STM32F429IGTx` 是 `<variant Dvariant="...">`，`Dname` 只有 `STM32F429IG`。
   变体现在作为 `aliases` 索引，`STM32F429IG`、`STM32F429IGT`、`STM32F429IGTx` 都能命中。

5. **Keil 的内存命名**：DFP 用 `<memory name="Flash">` / `name="SRAM1"`，没有 `id` 属性。
   以前只认 `IROM1`/`IRAM1`，所以 flash/RAM 全是 undefined。现在两种都读；
   Flash 取最大值（多个 bank 是同一地址空间），SRAM 累加。

### 验证

不设任何环境变量、从真实工程目录出发：

```
LTDC.SSCR → 0x40016808 | source: G:\software\keil5pack\Keil\STM32F4xx_DFP\3.1.1\CMSIS\SVD\STM32F429.svd (device STM32F429, CM4)
GPIOB.ODR → 0x40020414 | source: ...（同上）
```

器件查询：

```
STM32F429IG      -> STM32F429IG  flash=1048576 ram=262144 svd=yes
STM32F429IGT     -> STM32F429IG  flash=1048576 ram=262144 svd=yes
STM32F429IGTx    -> STM32F429IG  flash=1048576 ram=262144 svd=yes
STM32F429ZI      -> STM32F429ZI  flash=2097152 ram=262144 svd=yes
STM32F103RC      -> STM32F103RC  flash=262144  ram=49152  svd=yes
```

`tests/round11-keil-packs.test.ts` 13 条覆盖：RTEPATH 只在 `[UV2]` 生效、注释行不算、
两种目录层级、subFamily 继承、变体别名、Keil 内存命名。其中一条会在本机真的装了
Keil 时检查 DFP 里的 STM32F429IG。

### 一条被放宽的断言

`tests/gap-fixes-2.test.ts` 原本断言「SVD 搜索目录里不能出现任何带 Keil 的路径」。
那条约束的本意是**不许猜厂商路径**，而现在的实现是**读实际安装**（TOOLS.INI + 注册表），
没装 Keil 的机器上不会出现任何 Keil 路径。断言改成：出现厂商路径时该目录必须真实存在，
且没装 Keil 的机器上必须为零。

### 仍然要注意

- **注册表读取只在 Windows 上做**，且每次进程缓存一次。装了 Keil 但既没有注册表项、
  也没有默认路径的机器，仍然需要 `KEIL_TOOLS_INI` 或 `PROMETHEUS_TOOLCHAINS`。
- **pack 版本**：同一 pack 装了多个版本时，`findDeviceInPacks` 取目录遍历到的第一个，
  不是最新版本。目前没在真实机器上遇到多版本，属于未验证。
