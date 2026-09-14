# ESP32 传感器实时 Web 监控平台

通过 USB 串口（或 WiFi）读取 ESP32 开发板的真实传感器数据，实时展示在网页上。
**开发板拔掉后，页面立即清空所有数值并提示"未检测到开发板"——平台不含任何模拟/随机/占位数据。**

## 一、快速开始

### 1. 启动平台

双击 `start.bat`，或在项目目录执行：

```bash
npm start          # 等价于 node server.js
```

启动后浏览器访问 <http://localhost:8080>

### 2. 烧录固件到 ESP32

用 Arduino IDE 打开 `firmware/esp32_monitor.ino`：

- 选择开发板（ESP32 Dev Module / ESP32-S3 / ESP32-C3 等）
- 选择端口，波特率 **115200**
- 点击上传

**无需外接任何传感器**即可看到数据（使用芯片内部温度传感器、霍尔传感器、ADC 引脚）。

### 3. 接线（可选）

**各芯片的 ADC 引脚完全不同**，固件已按型号自动切换（不用手动改代码）：

| 芯片 | ADC1 可用引脚 | 固件默认值 |
|---|---|---|
| **ESP32-S3** | GPIO1~GPIO10 | **GPIO4、GPIO5** |
| ESP32（经典款） | GPIO32~GPIO39 | GPIO34、GPIO35 |
| ESP32-C3 / C6 / H2 | GPIO0~GPIO4（GPIO0 是启动脚，别用） | GPIO3、GPIO4 |

> ESP32-S3 注意：**不要**用 GPIO26~32（Flash/PSRAM）和 GPIO33~37（八线 PSRAM）。
> DHT22 默认接 GPIO4 —— 若与上面的 ADC0 冲突，改 `DHT_PIN` 或 `ADC_PIN_0` 即可。

信号范围 **0~3.3V，超过会烧 IO**。

### 4. 查看数据

开发板上电后，平台会自动识别串口并连接，页面顶部状态变为绿色「已连接 · 串口」，随后显示实时数值、趋势曲线与原始数据日志。

## 二、断开行为（关键）

平台区分**三种状态**，由 `config.json` 的 `stalePolicy` 控制停采后的行为（默认 `keep`，契合作业「停采后保留旧时间、提示未更新」要求）：

| 状态 | 触发 | 页面表现 |
|---|---|---|
| **实时**(live) | 持续收到真实数据 | 绿色「已连接」，数值与曲线实时刷新 |
| **停采保留**(stale) | 收到过数据但超过 `staleAfterMs`（默认 5s）无新数据 | 黄色「已停采 · 保留末次数据」+「未更新」徽章，**保留最后一次真实值与旧时间** |
| **离线**(cleared) | 串口 `close`（物理拔线）/ 手动「释放串口」 | 立即清空全部数值与曲线，横幅提示「未检测到开发板」，**无任何模拟数据** |

> `stalePolicy: 'clear'` 时，停采超过 `offlineAfterMs`（默认 15s）会进一步清空（满足"拔线即无数据"的原始要求）。物理拔线/手动释放**在任何策略下都立即清空**。

| 情况 | 页面表现 |
|---|---|
| 拔掉 USB（串口 close） | 立即清空全部数值与曲线，横幅提示「未检测到开发板」 |
| 驱动未上报拔线 | 超过 `offlineAfterMs`（默认 15s）无任何数据 → 判定设备已移除，同样清空 |
| 上报非 JSON / 无数值 | 只记入「原始数据」日志，**不作为数据显示** |

离线时所有卡片显示占位符，重新插上开发板后自动重连并恢复显示。

## 三、目录结构

```
imu-monitor/                    # ← 本项目即一个自包含文件夹，所有文件都在此目录内
├── server.js                 # 后端：串口管理 + HTTP + WebSocket 推送 + NDJSON 落盘
├── config.json               # 配置文件（端口、波特率、超时、字段单位与中文名）
├── README.md                 # 本文件：运行/接线/验证说明
├── ASSIGNMENT.md             # 课程作业提交说明（分工/单位时间核对/风险/部署/一人一记录）
├── package.json
├── start.bat                 # 一键启动（双击即可）
├── .gitignore                # 排除构建产物 / 依赖 / 运行时数据
├── scripts/
│   └── idfwrap.py            # ESP-IDF 构建/烧录封装（自动注入工具链环境）
├── data/                     # NDJSON 原始记录（持久化存储，运行后生成）
├── recordings/               # 录制导出的 CSV（运行后生成）
├── public/
│   ├── index.html            # 监控页面（三轴 IMU 面板、原始记录查询、未更新提示）
│   ├── style.css
│   └── app.js                # WebSocket 接收、卡片渲染、Canvas 绘制（含滑动平均）、记录查询
├── firmware/
│   ├── s3eye_imu_idf/        # ★ 当前使用：ESP-IDF 工程（QMA7981 三轴 + 10Hz 上报 + 校准）
│   │   ├── CMakeLists.txt
│   │   ├── sdkconfig.defaults
│   │   └── main/
│   │       ├── main.c        # 主程序：IMU 读取 / JSON 组帧 / USB-CDC + WiFi 上报
│   │       └── app_config.h  # ★ 唯一需要改的配置：WiFi 凭据 / 服务器 IP / 设备 ID
│   ├── esp32_monitor.ino       # （旧）Arduino USB 串口版草稿
│   ├── esp32_monitor_wifi.ino  # （旧）Arduino 通用 WiFi 版草稿
│   └── s3eye_imu_wifi/          # （旧）Arduino S3-EYE 专用草稿
│       └── s3eye_imu_wifi.ino
└── test/
    ├── acceptance-test.js    # 全链路验收：固件帧→落盘→页面→停采（隔离端口 8096）
    ├── e2e-test.js           # 链路自检：空状态 / 上报解析 / 停采保留 / 断开清空
    ├── verify-test.js        # 本组身份校验：device ↔ expectedDeviceId（隔离端口 8095）
    ├── feature-test.js       # 诊断接口 / 录制导出 / CSV
    ├── parse-test.js         # 通用解析：JSON / 键值 / 中文键
    ├── storage-test.js       # 持久化 + 查询 + 停采保留
    ├── ws-test.js            # WebSocket sample/stale/cleared 推送结构
    └── listen.js COM4 25     # 原样监听某串口 N 秒，看板子在发什么
```

> 所有文件均在本目录内；除 ESP-IDF 工具链（`C:\Espressif`）与本机 Node.js 外，
> 项目不依赖任何目录外资源。整体复制本文件夹即可迁移。

## 四、配置说明（config.json）

| 字段 | 默认 | 说明 |
|---|---|---|
| `httpPort` | 8080 | Web 服务端口 |
| `host` | 0.0.0.0 | 监听地址。默认 `0.0.0.0` 允许局域网设备（开发板）直接上报；仅本机调试可改为 `127.0.0.1` |
| `baudRate` | 115200 | 串口波特率，须与固件一致 |
| `portPath` | null | 指定串口（如 `COM3`）；`null` = 自动识别 |
| `autoDetect` | true | 自动扫描 ESP32（按 VID 打分：Espressif > CP210x > CH34x > FTDI） |
| `autoReconnect` | true | 断开后自动重连 |
| `staleAfterMs` | 5000 | 超过此时间无数据 → 标记「设备无数据」 |
| `offlineAfterMs` | 15000 | 超过此时间无数据 → 判定设备已移除并清空 |
| `wifiTimeoutMs` | 8000 | WiFi 上报心跳超时（预留，停采阈值统一用 `staleAfterMs`） |
| `stalePolicy` | `keep` | 停采策略：`keep`=保留末次数据与旧时间并提示"未更新"（作业默认）；`clear`=超时后清空 |
| `expectedDeviceId` | null | **本组设备身份校验**：设为固件里的 `DEVICE_ID` 后，平台标记每帧数据是否来自本组（前端显示 ✓本组/⚠非本组），避免邻组数据混显 |
| `storageEnabled` | true | 是否把每帧真实采样落盘为 NDJSON（`data/records.ndjson`） |
| `storageMaxMb` | 32 | 单记录文件超过该大小自动滚动归档 |
| `fieldUnits` / `fieldLabels` | — | 字段单位与中文显示名映射 |

修改后重启服务生效（也可通过 `POST /api/config` 热更新部分字段）。

**环境变量**（部署 VPS 时常用，覆盖配置里的端口/监听）：`PORT=8080`、`HOST=0.0.0.0`（允许局域网/外网访问）。

## 五、接入自己的传感器

固件只需保证每隔一段时间向串口 `print` 一行 JSON：

```cpp
Serial.println("{\"temperature\":26.5,\"humidity\":58.2,\"soil\":1890}");
```

页面会**自动识别所有数值字段**并生成卡片与曲线，无需改前端。
若字段名不在 `config.json` 的 `fieldLabels` 中，会按原始 key 显示（可自行补映射）。

### 5.1 已有固件、不想重烧？用通用解析

平台不只认 JSON。`config.json` 里的 `parseMode` 控制解析策略：

| parseMode | 支持 |
|---|---|
| `auto`（默认） | JSON，以及 `键=值` / `键: 值` 形式 |
| `json` | 只认 JSON |
| `kv` | 只认 `键=值` / `键: 值` |
| `csv` | 纯数字序列，按 `ch1…chN` 命名（可能把日志里的数字误当数据，慎用） |

以下格式都能直接出卡片和曲线：

```
Temp=25.3,Hum=60.1
Temp: 25.3 C  Hum: 60.1 %
temperature:26.5 humidity:58.2
温度: 26.5 湿度: 58.2
```

必须是"有标签"的键值形式；`[info] connected in 1234 ms`、`Time: 12:34:56` 这类不会被误当成传感器值（已有测试覆盖）。

## 六、HTTP 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/state` | 当前连接状态与最新字段 |
| GET | `/api/ports` | 可用串口列表 |
| POST | `/api/connect` | `{portPath, baudRate, autoDetect}` 连接设备 |
| POST | `/api/disconnect` | 断开 |
| GET/POST | `/api/config` | 读写配置 |
| GET | `/api/diag` | 诊断信息：串口列表、开关状态、字节数、报文统计、排查建议 |
| POST | `/api/probe` | `{portPath, ms}` 波特率探测，返回每个波特率收到的字节与样例 |
| POST | `/api/record` | `{action:'start'\|'stop'}` 录制真实数据；`stop` 返回 CSV 文件名 |
| GET | `/api/record/download?file=` | 下载录制好的 CSV |
| POST | `/api/data` | WiFi 上报入口（ESP32 或其他设备推送 JSON，支持 `device`/`mac`/`ts`/`iso` 元数据） |
| GET | `/api/records?device=&limit=&since=&until=` | 查询 VPS 落盘的真实记录（一帧观测一条） |
| GET | `/api/devices` | 列出所有出现过的设备（计数、首次/末次出现） |
| GET | `/api/records.csv?device=&limit=` | 导出原始记录为 CSV（BOM） |
| WS | `/ws` | 实时推送 `sample` / `status` / `raw` / `cleared` / `stale` / `hello` |

## 六之一、ESP32-S3-EYE 专项说明

ESP32-S3-EYE（含 SUB_V1.1 子板）有三个与其他板子不同的关键点：

**1. 没有 USB-UART 桥接芯片**
通信完全靠 ESP32-S3 内置 USB Serial/JTAG（GPIO19/20）。所以 COM 口的 VID 一定是 `303A`，**这是唯一通道，没有第二个串口可选**。

**2. 所有 GPIO 都已被占用**
摄像头 OV2640、1.3" LCD（SPI）、I2S 数字麦克风、MicroSD、QMA7981 加速度计（I2C）、6 个按键已占满全部 GPIO，官方文档明确写明 *"all GPIOs ... have already been used"*。
→ **外接 ADC 传感器在这块板上不可行**。可用的是芯片内部数据源：`temperatureRead()`（内部温度）、`ESP.getFreeHeap()`、`millis()`；若要用加速度计/麦克风需自行驱动其总线。

**3. 出厂固件是 ESP-IDF + ESP-WHO，console 可能不在 USB 口**
ESP-IDF 默认把 console 输出到 UART0；只有 menuconfig 里设为 `CONFIG_ESP_CONSOLE_USB_SERIAL_JTAG` 才会走 USB 口。**出厂固件若未在 USB 口输出，平台必然收不到任何字节** —— 这与平台无关。

**判定方法**：平台连接状态下按一下板上的 **RST** 键，看页面「原始数据」里有没有 ESP-IDF 启动日志。
- 有日志 → console 在 USB 口，把日志贴出来，我按它的实际格式配置解析
- 完全没有 → console 在 UART0，不重新烧录就无法从这个口取到数据

**烧录恢复方法**（此板无桥接芯片，程序跑飞时）：按住 **BOOT** → 按一下 **RST** → 松开 RST → 再松开 BOOT，进入 Firmware Download 模式。

## 六之二、ESP32-S3 专项说明

S3 用的是**原生 USB Serial/JTAG 口**（VID 303A / PID 1001），不是外挂的 CH340/CP210x。由此带来三点必须注意：

**1. 必须开启 USB CDC On Boot**
`工具 → USB CDC On Boot: Enabled`。不开的话 `Serial` 会被映射到 GPIO 的 TX/RX 引脚，USB 口上一个字节都收不到 —— 这是"插着板子却完全没数据"的最常见原因。开启后重新烧录并按 RESET。

**2. 波特率对它是无意义的**
USB CDC 是虚拟串口，115200 还是 921600 都一样。所以"波特率探测全 0"不等于波特率不对，而是固件没输出到这个口。

**3. 烧录前必须释放串口**
Windows 的串口是独占的。平台正占着 COM4 时，Arduino IDE 打不开它。流程：

```
平台点「释放串口」→ Arduino IDE 上传固件 → 平台点「连接设备」
```

**看不到数据时的自检顺序：**
1. 页面点「诊断」→ 看 `bytesReceived`
2. 是 0 → 先点「释放串口」，再用 Arduino IDE 打开串口监视器看有没有 `chip=ESP32-S3` 之类的启动横幅
3. 串口监视器有输出、平台没有 → 检查是不是忘了关串口监视器（它会独占串口）
4. 串口监视器也没输出 → USB CDC On Boot 没开，或固件没烧进去

## 七、排查：板子插上了但没数据

页面上有两个按钮专门解决这个问题：

- **诊断**：列出所有串口及其 VID/score、当前串口是否打开、已收字节数、报文统计（总/有效/无效），并直接给出排查建议。
- **波特率探测**：对该串口依次用 9600 → 921600 各监听 1.5 秒，报告哪个波特率能收到数据、收到什么内容，并自动把建议波特率填回下拉框。

常见结论：

| 现象 | 含义 |
|---|---|
| 找不到 score > 0 的串口 | 数据线是纯充电线，或驱动未装（CH340/CP210x） |
| 串口打开但 0 字节 | 波特率不对，或程序没在用 `Serial.println()` |
| 所有波特率都 0 字节 | 板子没烧程序 / 程序无串口输出 / S3、C3 需开启 `USB CDC On Boot` / 板子在下载模式 |
| 有字节但 0 行有效 JSON | 输出不是以 `{` 开头的 JSON，或没换行 |
| 串口是 VID 303A（原生 USB Serial/JTAG） | **波特率对它无意义**，扫波特率没用。收不到数据 = 固件没输出到该口：Arduino IDE 里把 **USB CDC On Boot 设为 Enabled** 后重新烧录，再按 RESET |

> 判断方法：诊断里若某个串口 `vid=303A score=100`，说明是 ESP32-S3/S2/C3/C6/H2 的**原生 USB 口**（虚拟串口，波特率无效）；若是 `1a86`(CH340) 或 `10c4`(CP210x)，则是外挂 USB 转串口芯片，波特率必须与固件一致。

> 注意：Arduino IDE 的**串口监视器**和**烧录器**都会独占串口，用本平台前请先关掉监视器；要烧录则先点平台的「释放串口」。

## 八、真实数据录制

点击 **开始记录** → 平台把设备实际上报的每一条采样记在内存里 → 点 **停止并下载** 导出 CSV（含 BOM，Excel 直接打开不乱码）。

- 只在设备真实上报时写入，**离线期间不产生任何行**
- 录制期间一条数据都没有 → 不生成文件
- 上限 20 万行，超出丢弃最早的

## 九、自检

```bash
node test/e2e-test.js      # 数据链路：空状态 / 上报解析 / 离线清空 / 非法报文过滤
node test/feature-test.js  # 诊断接口 / 录制导出 / CSV 内容
node test/parse-test.js    # 通用解析：JSON / 键值 / 中文键 / 误解析防护
node test/listen.js COM4 25  # 原样监听某个串口 25 秒，看板子到底在发什么
```

## 八、常见问题

**串口打不开 / 一直「未检测到开发板」**
- 确认 Arduino IDE 的串口监视器已关闭（串口被独占）
- 确认波特率与固件一致（默认 115200）
- 在页面串口下拉框手动选择端口

**页面一直显示「串口已打开 · 等待数据」**
- 固件未烧录或未运行；打开串口监视器看是否有 JSON 输出
- 开发板上的程序可能用了 `Serial.print` 但没换行——必须是 `println`

**数值字段显示为原始 key**
- 在 `config.json` 的 `fieldLabels` 里补上映射即可
