# 嵌入式测试台：电源循环、电流测量、确定性

调研日期：2026-10-18。**[V]** = 本次对官方文档核实；**[U]** = 工程实践/未核实。

---

## 一、电源循环

### uhubctl（USB 集线器按口断电）

```bash
sudo uhubctl                                    # 枚举支持的 hub 与端口状态
sudo uhubctl -l 1-1 -p 2 -a cycle -d 2          # 端口 2 断电 2 秒再上电
sudo uhubctl -l 1-2 -p 1,2 -a off               # 多端口
```

- 标志：`-l/--location`、`-p/--ports`（逗号或范围 `2-5`）、`-a off|on|cycle|toggle`、`-d/--delay` **默认 2 秒**、`-r/--repeat` **默认 1**、`-w/--wait` **默认 20 ms**、`-e/--exact`、`-s/--search`。
- `cycle` 语义：**关 → 等 `-d` 秒 → 开**。`-d` 只控制断电停留，不等枚举完成。
- 只对支持 **per-port power switching** 的 hub 有效。用 `lsusb -v` 看 `Per-port power switching` 和 `wHubCharacteristic 0x0009`。很多 hub（包括部分树莓派）是**整组供电**。
- **Windows：能编译，但电源切换不工作** —— libusb 的 `winusb.sys` 不携带所需控制请求。
- 权限：root 或 udev 规则。

### usbrelay（USB-HID 继电器板）

```bash
sudo usbrelay                    # 列出：PSUIS_1=1 / PSUIS_2=0
sudo usbrelay PSUIS_2=0          # 继电器 2 断电
sudo usbrelay PSUIS_9=0          # 索引 9 = 整板全部
```

- 输出格式：每行 `序列号_N=0|1`。
- VID/PID：`16c0:05df`（可读状态+序列号）、`0519:2018`（**不能读回状态**、无序列号，靠设备路径区分）。
- **注意 `-h` 不是帮助**，用 `-?` 或 `--help`。
- Python：`usbrelay_py`，必须先 `board_count()` 再枚举。

### Numato USB 继电器（虚拟串口）

```
relay on 0        # 编号从 0 开始
relay off 0
relay read 0      # 返回 "on" / "off"
ver
```

- USB CDC，**波特率无关**，流控 None，**命令终止符是 CR（ASCII 13），不是 CRLF**，提示符 `>`，设备回显命令。
- 1/2 通道板可能没有 `readall`/`writeall`。

### 网络智能插座

- **python-kasa**：`kasa discover`、`kasa --host 192.168.1.10 on|off|toggle|state`、`--json`。
- **Shelly Gen1**：`GET http://<ip>/relay/0?turn=on|off|toggle` → JSON `{"ison":false,...}`。
  **Gen2**：`GET /rpc/Switch.Set?id=0&on=true`、`/rpc/Switch.GetStatus?id=0`。
- **Tasmota**：`GET http://<ip>/cm?cmnd=Power%20On`（也支持 `Off`/`Toggle`/`1`/`0`）。
- Wi-Fi 插座加 50–500 ms 延迟和抖动，**不要用于时序敏感场景**。

### 树莓派 GPIO

```python
from gpiozero import DigitalOutputDevice
pwr = DigitalOutputDevice(17, active_high=True, initial_value=False)
pwr.on(); pwr.off(); pwr.toggle(); pwr.close()
```

- **只有 lgpio 能在 Pi 5 上工作**：`GPIOZERO_PIN_FACTORY=lgpio`。
- Pi 5 用 `pinctrl`：`sudo pinctrl 4,6 op dl`（设 GPIO4/6 输出低）、`pinctrl poll BT_CTS,BT_RTS`（穷人版逻辑分析仪）。
- **安全**：低边 N-MOSFET（栅极经 100 Ω、10 kΩ 下拉）用于共地 DUT；需要 DUT 地保持共地时用高边 P-MOSFET/负载开关。**绝不要从 Pi 的 3V3 给 DUT 供电**。

### 时序参考

| 事件 | 典型值 |
|---|---|
| USB 主机察觉断开 | 10–100 ms |
| 继电器触点抖动 | 2–15 ms |
| 继电器命令→触点动作 | 5–20 ms |
| USB 重新枚举 + tty 节点 | 0.5–5 s |
| 电源轨放电到 <0.1 V | 取决于电容，**要测不要猜** |

**正确顺序**：`uhubctl -a off` → 睡 ≥ `-d` → `uhubctl -a on` → **按稳定 USB 路径/序列号轮询**（不是 `/dev/ttyUSBn`）→ 等启动横幅（带超时）→ 才开始测量。

---

## 二、电流测量

### Joulescope（JS110 / JS220）

```python
import joulescope
device = joulescope.scan_require_one(config='auto')   # 0 或 >1 个会抛异常
device.open(mode='defaults')
device.start(duration=1.0)
data = device.read(duration=1.0)                      # Nx2 float32 [电流, 电压]
for s in device.statistics_iter(count=20):
    s['signals']['current']['µ']['value']             # 均值；σ2 方差；min/max/p2p
device.stop(); device.close()
```

- 统计结构：`{time, signals{current,voltage,power}, accumulators{charge,energy}}`。
- **JS220/JS320 忽略 `'host'` 统计来源**（只有 JS110 支持），会报警告。
- **关键**：流缓冲里的样本带 `gpi0..gpi3` 和 `trigger_in` 字段 —— 这是**电流与固件事件对齐**的路径，同一采样流，零漂移。
- JS220 规格：2 MS/s、16 位同时采样 V/I、300 kHz 带宽、±3 A 连续（10 A 脉冲）、0.5 nA 分辨率、**1 µs 分流切换**、±15 V。
- 数据文件 `.jls`：32 字节头 + TLV，带 CRC32，可选加密。
- 安装：`pip install -U joulescope`；Linux 需 udev 规则 `99-joulescope.rules`。

### Nordic PPK2

```python
from ppk2_api.ppk2_api import PPK2_API
PPK2_API.list_devices()              # [(port, serial8)]
p = PPK2_API("/dev/ttyACM3")
p.get_modifiers()                    # 必须先调
p.use_source_meter()                 # 或 use_ampere_meter()
p.set_source_voltage(3300)           # mV，夹在 800..5000
p.toggle_DUT_power("ON")             # 只接受 "ON"/"OFF"，其它字符串是空操作
p.start_measuring()
samples, raw_digital = p.get_samples(p.get_data())
p.digital_channels(raw_digital)      # 8 个通道的 0/1
```

- 规格：**100 ksps**、**200 nA–1 A**、源 0.8–5 V、**8 路数字输入 D0–D7**。
- **独占设备**：nRF Connect 应用必须关掉。
- `get_data()` 无数据时返回 `b''`，要循环。
- 库在 **IRNAS/ppk2-api-python**，不在 Nordic 官方仓库。

### INA219（I²C，板载测量）

**`pi-ina219`（注意修正）**：

```python
from pi_ina219 import INA219
ina = INA219(shunt_ohms, address=0x40)   # 是 address= 不是 addr=；shunt_ohms 必填
ina.configure()
ina.voltage()        # V（总线）
ina.current()        # mA   ← 方法是调用，不是属性
ina.power()          # mW
ina.shunt_voltage()  # mV
```

- Adafruit 的 CircuitPython 库约定不同：`.current` 是 **mA**、`.power` 是 **W**、都是**属性**。
- 采样率 ≤ 1–2 ksps，**会严重混叠短电流尖峰**，不适合 µs 级休眠电流。

### 事件对齐

| 机制 | 钩子 | 漂移 |
|---|---|---|
| Joulescope GPI | 流字段 `gpi0..gpi3`、`trigger_in` | **零**（同一采样流） |
| PPK2 数字 | 原始样本高 8 位 + `digital_channels()` | **零**（共享 100 ksps 时基） |
| 逻辑分析仪模拟+数字 | 共享采集时钟 | 零 |
| 串口日志时间戳 | 主机打时间 | 1–10 ms 抖动 |
| 主机墙钟 | `time.time()` 包住 | 最差 |

**对齐方法**：在固件的已知点翻转一个空闲 GPIO，接到仪器的数字通道，以该边沿为锚。

---

## 三、确定性

### 种子与顺序

```bash
PYTHONHASHSEED=0 pytest ...             # 关闭哈希随机化
pytest --randomly-seed=1234             # 复现打乱顺序
pytest -p no:randomly                   # 关闭插件
PYTHONHASHSEED 接受 random 或 0..4294967295
```

### 主机时间控制

- **libfaketime**：`faketime '2026-01-01 00:00:00' ./test`（冻结）、`FAKETIME="@..."`（开始并推进）、`faketime -f '+1y x2'`。
  **无 `-r` 选项**。**Windows 不支持**（没有 `LD_PRELOAD`）。JVM 下需要 `FAKETIME_DONT_FAKE_MONOTONIC=1` 否则挂死。
- **time-machine**（纯 Python，Windows 可用）：`time_machine.travel(dest, tick=True)`，**`tick` 默认 True 是推进的**，要冻结断言就设 `tick=False`。在 C 层打补丁，所以已导入的引用也受影响。

### 模拟器确定性

- **Zephyr native_sim**：`west build -b native_sim`，`./build/zephyr/zephyr.exe --seed=1234`。虚拟时间与主机解耦，**通常确定性**（无异步/随机组件）。加 `--rt` 就失去确定性。
- **QEMU**：`-icount shift=N,align=off,sleep=off`、`-rtc clock=vm`、`-seed <n>`。
  `sleep=off` **是确定性时序的必要条件**。`-icount rr=record,rrfile=x.bin` 支持反向调试。
- **Renode**：`emulation SetGlobalQuantum "0.0008"`（参数是**字符串**）、`emulation SetAdvanceImmediately true`、`emulation Mode SynchronizedTimers`（`SynchronizedIO` 在大 quantum 下会丢 UART 输入）。
  快照是**顶层** `Save @file.save` / `Load @file.save`，**不是** `machine Save`。`SetSerializationMode` **不存在**。

### 可复现 CI 配方

1. 钉死模拟器版本（Renode 状态文件不跨版本）
2. 所有随机都播种
3. 断开墙钟：native_sim 不加 `--rt`；QEMU `-icount ...,sleep=off` + `-rtc clock=vm`
4. 钉死顺序：`-p no:randomly`、`-p no:cacheprovider`、`-x`
5. 确定性 I/O：mock HAL（fff/CMock）、`native_sim` 外设
6. **HIL 永远做不到逐位复现** —— 录制而不是重放：存 `.jls` + GPIO 标记，按统计带断言

**永远无法确定的**：USB 枚举顺序与时序、模拟测量噪声、RF、实时中断延迟、Wi-Fi、继电器抖动、主机调度、DUT 启动时间。

---

## 四、对最初提纲的修正

- `pi-ina219` 用 `address=`，读数是**方法**，单位是 **mA / V / mW**；Adafruit 版是**属性**，**mA / V / W**。
- `uhubctl -d` 默认 **2 秒**（不是 1），`-w` 默认 20 ms。
- `usbrelay` 没有 `-h`。
- Renode 快照是顶层 `Save`/`Load`。
- `time_machine.travel` 默认 `tick=True`。
- `ppk2-api` 在 IRNAS，不在 Nordic。
