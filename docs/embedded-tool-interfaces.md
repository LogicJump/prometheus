# 嵌入式构建、烧录、调试工具：机器可读接口

调研日期：2026-10-18。目标：agent 要**程序化驱动**这些工具，所以需要确切命令行、输出格式、退出码，不是综述。
CMake/CTest/presets 在本机（CMake 4.2.3、Ninja、Arm GNU 14.2）实测；其余对文档与上游源码核实。

---

## 一、只有五个完全结构化的接口

| 接口 | 格式 |
|---|---|
| CMake File API + `compile_commands.json` + presets | JSON |
| Zephyr twister | `twister.json` / `twister.xml` |
| `idf.py size --format json2` + 构建目录 JSON | JSON |
| `arduino-cli --format json` | JSON |
| PlatformIO `--json-output` / `--junit-output-path` / `pio device list --json-output` | JSON |

**其余全部是「退出码 + 文本启发式」。**

---

## 二、退出码纪律（这是最容易写错的地方）

| 工具 | 成功 | 失败 |
|---|---|---|
| CMake | 0 | 1 |
| GNU make | 0 | **2**（不是 1） |
| Keil UV4 | **0 或 1**（1 = 只有警告） | ≥2 |
| `idf.py` | 0 | **2**（它自己的 FatalError）；底层 Ninja 码打印在消息里 |
| twister | 0 | 1（失败）；**2**（未知 platform / 参数错） |
| PlatformIO | 0 | 1 |
| Arduino CLI | 0 | 1/3/5/6/7/8/9/10/**11**(缺 programmer) |
| `renode-test` | 0 | 1（测试失败）；2（Renode 崩溃） |
| **Renode 本体** | **永远 0** | —— 退出码不能当判定 |

---

## 三、CMake

### 编译数据库

```bash
cmake -S . -B build -G Ninja -DCMAKE_EXPORT_COMPILE_COMMANDS=ON
```

- **只有 Makefile 和 Ninja 生成器**会产出它。VS 生成器即使设了标志也不生成（本机实测）。
- 文件是 JSON **数组**，每个对象四个字段：`directory`、`command`（一个 shell 字符串，不是 argv）、`file`、`output`。
- Windows 上 `command` 可能含 8.3 短路径（`C:\PROGRA~2\...`）。`--sysroot`、`-mcpu` 只在这个字符串里可见。

### Presets

`CMakePresets.json` 与 `CMakeUserPresets.json` 同schema（version 1–13）。agent 关心的字段：`name`、`hidden`、`inherits`、`generator`、`toolchainFile`、`binaryDir`、`cacheVariables`、`environment`。

`--list-presets` 输出是**纯文本**，不是 JSON：

```
Available configure presets:

  "dev" - Debug build
```

解析：按 `Available … presets:` 分节，行匹配 `^\s{2}"([^"]+)"( - (.*))?$`。默认列 configure；`--list-presets=build|test|package|all`。**没有 presets 文件时退出码 1**。

### 识别工具链

`CMakeCache.txt` 里有 `CMAKE_TOOLCHAIN_FILE` 和生成器，但 **`CMAKE_C_COMPILER`/`CMAKE_SYSROOT` 在工具链文件里设置的不会出现在 Cache 里**（本机实测）。

可靠的来源，按优先级：
1. `compile_commands.json` 的 `command` 字符串（有真正的编译器、`--sysroot`、`-mcpu`）
2. **CMake File API** 的 `toolchains-v1`
3. `<build>/CMakeFiles/<ver>/CMakeSystem.cmake`（`CMAKE_CROSSCOMPILING "TRUE"`）和 `CMakeCCompiler.cmake`

---

## 四、Zephyr / west / twister

```bash
west topdir                                   # workspace 绝对路径，一行
west list -f "{name} {abspath}"               # 机器可读；没有 --elements（那是旧接口）
west boards -f "{name} {vendor}"              # 纯文本，无 JSON
west build -b <board> [-d <dir>] [-p always] [app]
```

- 产物在 `<builddir>/zephyr/`：**总是**有 `zephyr.elf`；`zephyr.hex` 取决于 `CONFIG_BUILD_OUTPUT_HEX`；`zephyr.bin` 默认开。
- **Zephyr 强制产出 `compile_commands.json`**（`cmake/modules/kernel.cmake` 里设了），不要自己再设。
- `west flash` / `west debug` 没有 JSON 输出。可靠状态是：退出码 + `build/compile_commands.json` + `build/zephyr/zephyr.elf` + `build/zephyr/.config`。

### twister 测试

```bash
west twister -T tests -p qemu_x86
```

**`--enable-hardware-map` 不存在**（这是流传的错误说法）。正确的是：

```bash
west twister --device-testing --hardware-map map.yml -T samples/hello_world/
west twister --device-testing --device-serial COM1 --device-serial-baud 115200 -p frdm_k64f
west twister --generate-hardware-map map.yml
```

报告写在输出目录根部：`twister.json`（主要机器可读）、`twister.xml`（JUnit 汇总）、`twister_report.xml`（全部用例）、`testplan.json`（**为什么**每个场景被选中/过滤 —— 调试选择问题看这个）。

**hardware map YAML 的键用下划线**：`flash_timeout`、`flash_with_test`。schema 是 `additionalProperties: false`，写成连字符会校验失败。

---

## 五、ESP-IDF

```bash
idf.py build
idf.py -p COM3 flash monitor
idf.py --list-targets          # 一行一个，纯文本
idf.py size --format json2     # 注意：没有 plain json，机器格式是 json2
```

- `json2` 结构：`{version, total_size, layout:[{name,total,used,free,parts:{section:{size}}}]}`。
- 构建目录里最有用的 JSON 是 **`flasher_args.json`** —— 确切知道每个镜像烧到哪里。
- `sdkconfig` 是**构建产物**，由 CMake 重新生成。默认值放 `sdkconfig.defaults`。
- `idf.py menuconfig` 是 TUI，**不可自动化** —— 用 `sdkconfig.defaults` 或 `-DCONFIG_...`。
- `idf.py monitor` 永不自己退出 —— 必须给超时，或用 `--save-log` 再读文件。

---

## 六、PlatformIO / Arduino CLI

### PlatformIO

```bash
pio run -e esp32dev
pio run -e esp32dev -t upload
pio run -t compiledb              # 写 compile_commands.json
pio device list --json-output     # JSON 数组 {port, description, hwid}
pio test --junit-output-path results/junit.xml --json-output-path results/report.json
```

- `pio run` 输出是给人看的文本，**没有 JSON**。靠退出码。
- 产物：`.pio/build/<env>/firmware.elf|hex|bin`。

### Arduino CLI

```bash
arduino-cli compile --fqbn arduino:avr:uno --format json
arduino-cli board list --format json
```

- 真正的开关是隐藏的 `--format text|json|jsonmini`；`--json` 是 `--format json` 的别名。
- **`compile --format json` 是整个工具链里最有用的 JSON**：`success`、`compiler_out`、`compiler_err`、`builder_result{build_path, used_libraries[], executable_sections_size[]}` —— 不用抓文本就能拿到构建路径和分段大小。

---

## 七、Keil / IAR（Windows 专有）

```
UV4 -b <project.uvprojx> [-t "Target"] [-j0] [-o build.log] [-sg]
UV4 -r（重建）/ -c（清理）/ -f（下载）/ -d（调试）
```

ERRORLEVEL：**0 = 无错误无警告；1 = 只有警告；2 = 错误；3 = 致命**；11–20 是工程文件类错误。
→ **成功判定是 `code <= 1`，不是 `code == 0`**。

IAR：`iarbuild.exe <project.ewp> -make|-build|-clean <config> [-log all] [-parallel N]`。退出码 0 成功；另有日志里的 `Total number of errors: N`。

**两者都不能重新分发**，必须用户自装有许可的 IDE。

---

## 八、Renode

```bash
renode --disable-gui --console script.resc
renode -e "emulation SetGlobalQuantum \"0.0008\"" script.resc
```

- **Renode 本体的退出码基本永远是 0**，`quit` 只是结束会话，不是测试判定。
- 自动化判定用 `renode-test test.robot`（外包 Robot Framework）。
- 无头模式抓 UART：`uart CreateFileBackend @uart.log`（第二个参数 `true` 每写即刷）。
- 快照是**顶层** `Save @file.save` / `Load @file.save`，**不是** `machine Save`。`Load` 会清空当前 emulation。

---

## 九、烧录与调试

### OpenOCD

```bash
openocd -f interface/stlink.cfg -f target/stm32f4x.cfg \
        -c "program firmware.elf verify reset exit"
```

- **退出码 0 不代表成功**（`shutdown command invoked` 之后都是 0）。必须看输出里的 `** Programming Finished **` / `** Verified OK **`，失败看 `** Programming Failed **` / `** Verify Failed **`。
- GDB 端口 3333，telnet 4444。

### pyOCD

```bash
pyocd flash -f firmware.elf --target stm32f412xe
pyocd gdbserver --target stm32f412xe --port 3333
pyocd list --targets -H
```

- **`--json` 不存在**（本机实测报 `unrecognized arguments`）。只有表格。
- `-H/--no-header` 去掉表头；列是空格对齐的，按**两个以上空格**切分。
- 内置 **206 个目标**（本机实测 STM32F411 版本）。
- 同一条 `-f` 输出里 `[flasher] loaded` 和 `ERROR: Verify failed` 会同时出现，**失败措辞必须覆盖成功措辞**。

### probe-rs

```bash
probe-rs download firmware.elf --chip stm32f412xe
probe-rs gdb --chip stm32f412xe --port 1337
```

MIT/Apache 双许可 —— **比 GPL 的 OpenOCD 更适合嵌入产品**。

### 各工具的 GDB server 端口

| 工具 | 端口 |
|---|---|
| OpenOCD | 3333 |
| pyOCD | 3333 |
| probe-rs | **1337** |
| J-Link | **2331** |

弄错就是静默挂起。

### GDB/MI

`arm-none-eabi-gdb -q -i=mi2 --interpreter=mi2 firmware.elf`

- 每条命令产生若干 `*`/`+`/`=`/`~` 记录，最后恰好一个 `^done` 或 `^error`，token 相同。
- **按 token 配对**，丢失的回复不会被误认成下一条命令的。
- `-stack-list-frames` → `stack=[frame={level="0",...}]`；**`frame=` 前缀要剥掉**，否则解析出来的唯一字段叫 "frame"。
- `-stack-list-variables --simple-values` → **裸元组** `variables=[{name="x",value="3"}]`。
- `*stopped` 里的 frame **常常没有 `level`** —— 顶层帧是 0。
- 远端目标拒绝 `-exec-run`，要用 `-exec-continue`。
- 远端目标在 attach 过程中会发多个 `*stopped`（加载器、线程启动），**必须按 reason 筛选**（`breakpoint-hit`/`signal-received`/`exited`/…），否则看起来像断点没命中。

---

## 十、烧录器成功率判定表

| 工具 | 成功措辞 | 失败措辞 |
|---|---|---|
| pyOCD | `[flasher] loaded N bytes` | `verify failed`、`error`、`no available debug probes` |
| OpenOCD | `** Programming Finished **`、`** Verified OK **` | `** Programming Failed **`、`** Verify Failed **` |
| probe-rs | `Finished in N.s`、`[done]` | `Error:`、`failed to`、`No debug probe` |
| esptool | `Hash of data verified` | `FAILED`、`A fatal error occurred` |
| st-flash | `Flash written and verified` | `error` |
| dfu-util | `File downloaded successfully` | `No DFU capable USB device` |
| avrdude | `avrdude done.  Thank you.` | `can't open device` |

**规则：失败措辞优先于成功措辞。**

---

## 十一、串口

### 打开时不要复位板子

DTR 在多数开发板上经电容接 RESET。`pyserial` 默认 `dtr=True`，Node 的 `serialport` 默认 `hupcl=true` —— **两者都会复位板子**。

- pyserial：`Serial(port, dtr=False, rts=False)`，或在 `open()` 之前设。
- Node：`new SerialPort({ path, baudRate, hupcl: false })` 然后 `set({ dtr: false, rts: false })`（**必须两个都给**，`set` 会把其它默认值重新断言）。
- Linux：`stty -F /dev/ttyUSB0 -hupcl` 在打开**之前**执行。

**什么时候你想要复位**：想抓启动横幅。**什么时候不想**：固件已经在跑，你要它现在打印的东西。—— 所以这是个选项，不是默认。

### 读超时的语义

`read_until` 超时**返回部分字节，绝不抛异常**。必须按返回长度/终止符断言，不要假设会异常。

### 端口占用

- Windows：`serial.serialutil.SerialException: could not open port 'COM3': PermissionError(13, 'Access is denied.')`
- Linux：`[Errno 16] could not open port /dev/ttyUSB0: [Errno 16] Device or resource busy`
- 诊断：`fuser -v /dev/ttyUSB0`、`lsof`；Windows 用 `handle.exe -a COM3`
- 常见占用者：Arduino IDE 串口监视器、PlatformIO monitor、`screen`/`minicom`、Linux 的 ModemManager 和 brltty

### 日志格式

| 生态 | 格式 |
|---|---|
| Zephyr | `[00:00:01.234,567] <inf> main: message` |
| ESP-IDF | `I (1234) TAG: message`（级别字母 + 毫秒） |
| FreeRTOS/常见 | `[1234] TAG: message` |
| printf | 原样 |

### 高速率的坑

- FTDI 的 latency timer 默认 **16 ms**；Linux 上 `echo 1 > /sys/bus/usb-serial/devices/ttyUSB0/latency_timer` 可以降到 1 ms。
- 921600 在 CH340/CP2102 上不可靠；先用 115200 连上再提速。
- `\\.\COM10` —— COM10 以上必须用这个前缀（Windows 保留名规则）。
