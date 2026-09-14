# 课程作业提交说明：ESP32 三轴传感器实时上云监控

> 适用场景：把一块开发板上**真实的三轴传感器（IMU）数据**，经网络上报到自己的 VPS/Web 平台，并在网页上展示、可回溯。
> 本说明对应作业要求：前 2 学时确定分工与采集，后 2 学时完成"最小接收+存储服务、查询接口、网页"，并在当堂用**一个已验证传感源**对照"采集值 ↔ VPS 原始记录 ↔ 页面变化"。

---

## 0. 教师要求 → 交付物对照表（提交即用）

| # | 教师要求 | 本项目交付物 / 证据 |
|---|---|---|
| 1 | 用智能体采集**一个真实传感源**并上报自己的 VPS/Web 平台并验证 | 板端 `firmware/s3eye_imu_idf/`（ESP-IDF 工程）：QMA7981 三轴 IMU 采集 + WiFi HTTP 上报 + USB 串口兜底；服务端 `/api/data` 接收 |
| 2 | 前 2 学时：分析 **板 / VPS / 浏览器** 分工 | 见 §1 三方分工图与表 |
| 3 | 基于**设备型号、实际接线、驱动参考**建立项目、编译、烧录、采集、**验证单位与时间** | §2 依据（ESP32-S3-EYE + QMA7981 @ I²C GPIO4/5，来自官方 BSP）；§3 单位与时间核对 |
| 4 | 后 2 学时：**最小接收 + 存储服务、查询接口、网页** | `server.js`（NDJSON 落盘 + `/api/records` + `/api/devices` + `/api/records.csv`）；`public/*` 网页 |
| 5 | 部署到**分配的 VPS 空间** | §5 部署入口（`HOST`/`PORT` 环境变量、`config.json`） |
| 6 | **修改板端上传逻辑** | 固件 `upload()` 定时 HTTP POST JSON 到 `/api/data`（含 device/mac/ts/iso + IMU 三轴） |
| 7 | 联调**数据/来源/时间**；显示**"无数据"和失败状态**；说明嵌入式调试过程 | 三态显示：实时 / 停采保留(未更新) / 离线清空；`expectedDeviceId` 来源校验；§3 时间核对 |
| 8 | 课前：智能体开发、工具链、Git、VPS 权限检查 | 依赖仅 `serialport` + `ws`（`npm install`）；无构建步骤 |
| 9 | 各组共享设备但用**独立标识与项目空间** | 固件 `DEVICE_ID` + 服务端 `expectedDeviceId`；VPS 记录按 `device_id` 隔离 |
| 10 | 当堂验证：操作一个**已验证传感源(IMU)**，对照**采集值 ↔ VPS 原始记录 ↔ 页面变化** | §3.3 一帧观测=一条记录；网页「VPS 原始记录」面板；`/api/records` |
| 11 | **停采后保留旧时间、提示"未更新"** | `stalePolicy:'keep'` + 前端「未更新」徽章（§2） |
| 12 | 核对数据来自**本组设备**；**页面未写死数值** | 前端「✓ 本组设备 / ⚠ 非本组」徽章；字段由数据驱动动态生成 |
| 13 | 提交：板端/服务端/网页代码 + **部署入口**；**一帧观测→一条记录**；**个人修改与运行说明** | 本目录全部代码；§0.1 个人必改项；§6 运行步骤；§8 提交清单 |
| 14 | 备用路径：**无 VPS 时用自己电脑当服务器** | §5：`HOST=0.0.0.0` 本机/局域网；VPS 故障时本地先跑通 |
| 15 | **USB 仅用于调试，不能冒充独立网络上传** | 数据经 **WiFi 独立网络**上报；USB 仅用于烧录与串口诊断 |

---

## 0.1 提交前个人必改项（每人必做，改完即可运行）

**A. 板端固件** `firmware/s3eye_imu_idf/main/app_config.h`：

```c
#define APP_WIFI_SSID   "你的WiFi名称"      // ← 改成能上网的 WiFi
#define APP_WIFI_PASS   "你的WiFi密码"      // ← WiFi 密码
#define APP_SERVER_HOST "192.168.1.20"     // ← 运行 server.js 的电脑 / VPS 的 IP（启动服务后控制台会打印局域网访问地址）
#define APP_SERVER_PORT 8080               // ← 与服务端端口一致
#define APP_DEVICE_ID   "S3EYE-GROUP01"    // ← 本组独立编号（各组必须不同）
```

**B. 服务端** `config.json`：

```json
"expectedDeviceId": "S3EYE-GROUP01"   // ← 必须与固件 DEVICE_ID 完全相同（本组身份校验）
```

**C. 部署到 VPS**（或本机当服务器）：

```bash
# 本机 / 局域网（推荐先用这个跑通）
HOST=0.0.0.0 PORT=8080 npm start
# 或直接改 config.json 的 host / httpPort
```

> 关键点：`SERVER_HOST`（板端）指向运行 `server.js` 的机器 IP；该机器需与板子在同一局域网，或使用 VPS 公网 IP 并放行端口。**数据经 WiFi 独立网络上传，USB 只用于烧录/调试。**

---

## 1. 板 / VPS / 浏览器 三方分工

```
        ┌─────────────┐   WiFi HTTP    ┌──────────────────┐   WebSocket    ┌──────────────┐
        │  ESP32 开发板 │ ──POST /api/data──▶ │  服务端 (Node.js) │ ──实时推送────▶ │  浏览器网页  │
        │ (采集+上传)  │ ◀── 无需回传 ── │ 接收/落盘/查询   │ ◀──GET /api/*──── │ (展示+回溯)  │
        └─────────────┘                 └──────────────────┘                └──────────────┘
        采集方：QMA7981 IMU              中转+存储：NDJSON 落盘              展示方：三轴面板+
        来源必须真实                      一帧观测=一条记录                  VPS记录查询
```

| 角色 | 职责 | 关键产物 |
|---|---|---|
| **板端（ESP32）** | 读取 IMU、打时间戳、通过 WiFi 上传（并同步经 USB 串口输出 JSON 兜底） | `firmware/s3eye_imu_idf/main/main.c` + `app_config.h` |
| **服务端（VPS/本机）** | 接收上报、落盘为 NDJSON、提供查询接口与 WebSocket 推送 | `server.js`，`data/records.ndjson` |
| **浏览器（网页）** | 实时展示三轴加速度(g / m/s²)、来源设备、板端时间 vs 服务端时间、未更新提示、VPS 记录查询 | `public/index.html` `app.js` |

> 无 VPS 时：用自己电脑当服务器即可（本机 `127.0.0.1` 或局域网 `0.0.0.0`）。USB 仅用于**调试与烧录**，不能用来冒充"独立网络上传已验证"。

---

## 2. 设备型号与接线依据（不靠猜测）

本组设备：**ESP32-S3-EYE（SUB_V1.1）**。接线/驱动依据来自官方资料与板上 BSP 头文件，而非杜撰：

| 项目 | 结论 | 依据 |
|---|---|---|
| 三轴传感器 | **QMA7981** 加速度计，I²C 地址 `0x12` | 官方 BSP `BSP_CAPS_IMU` 虽为 0（未暴露驱动），但板上确有 QMA7981；固件先 `i2cScan()` 再按 ID 验证 |
| I²C 引脚 | **SDA = GPIO4，SCL = GPIO5** | `esp-bsp` 中 `BSP_I2C_SDA=GPIO_NUM_4`、`BSP_I2C_SCL=GPIO_NUM_5` |
| 器件 ID 校验 | 读寄存器 `0x00` 应为 `0xE7` | QMA7981 数据手册；固件 `imuInit()` 先验 ID 再启用 |
| 数据寄存器 | X=0x01, Y=0x03, Z=0x05；active 指令写 0x11=`0xC0` | QMA7981 数据手册 |
| 量程/精度 | 14bit 左对齐，默认 ±2g，满量程 `0x1FFF`(8191) | 由 `raw>>2` 还原，再折算 g 与 m/s² |

**重要前提**：ESP32-S3-EYE **没有 USB-UART 桥接芯片**，所有 GPIO 已被摄像头/LCD/麦克风/SD/按键占用，**不外接任何传感器**；三轴数据来自板载 QMA7981。若 IMU 不可用，固件退化为上传芯片内部温度（仍是真实来源），并在日志说明。

---

## 3. 单位与时间核对方法（当堂验证）

### 3.1 单位核对（静止水平放置）
- 理论上：Z 轴 ≈ **+1 g ≈ +9.8 m/s²**，X、Y ≈ 0。
- 固件同时上报 `acc_x_g / acc_x_ms2` 三种形式（raw / g / m/s²），网页三轴面板同屏显示 g 与 m/s²，可直接对照。
- 把板子平放、立起、翻转，观察 Z 与 X/Y 的 g 值变化是否合理（应随之改变，而非恒定或乱跳）。

### 3.2 时间核对（板端时间 vs 服务端接收时间）
- 板端用 NTP 对时，上传 `ts`（毫秒 UTC）+ `iso`（字符串）。
- 服务端记录 `recv_ts`（接收时刻）并算 `skew_ms = board_ts - recv_ts`。
- 网页"状态条"同时显示**板端时间**与**服务端收到时间**；VPS 记录表含"偏差ms"一列，正常情况下偏差应在几百毫秒内（局域网/本地更小）。
- 若 `skew_ms` 异常大（如几万 ms），说明板端未对时或时区/单位错误，需检查 NTP。

### 3.3 一帧观测 = 一条记录
- 每收到一帧真实数据，服务端**落盘一条 NDJSON**（含 `device_id`、`board_ts`、`recv_ts`、`fields`）。
- 网页"VPS 原始记录"面板、`/api/records`、`/api/records.csv` 均可查到；**帧数 = 记录数**，可据此核对"一个真实观测对应一条对应记录"。
- 停采后旧记录仍在，便于回看停采前一刻的数值。

---

## 4. 烧录风险与恢复（操作前必读）

> 用户特别强调：操作要考虑风险。以下每条都是真实会发生的后果。

1. **烧录会覆盖出厂固件（ESP-WHO）。** 这是不可逆的——出厂的相机/人脸演示固件将被本采集固件取代。务必确认你**确实要用这块板做采集**再烧。
2. **该板无 USB-UART 桥接芯片**，程序跑飞/串口打不开时，恢复方式不是插拔 USB，而是 **BOOT+RST 组合**：
   按住 **BOOT** → 按一下 **RST** → 松开 RST → 再松开 BOOT，进入 Firmware Download 模式，再用 Arduino IDE/esptool 烧录。
3. **GPIO3（部分版本为电源 LED）风险**：V2.1 之前子板在 GPIO3 上无 R83 限流电阻，若误将其拉高可能烧 LED 甚至影响供电。**本固件不碰 GPIO3**，请勿在代码里新增对该脚的驱动。
4. **Windows 串口独占**：平台占用 COM 口时，Arduino IDE 无法打开。流程必须为：
   `网页点「释放串口」 → Arduino IDE 上传 → 网页点「连接设备」`。
   烧录前先释放，可避免"端口被占用"且无谓地反复重试。
5. **console 必须落在原生 USB（S3 原生 USB）**：本项目 `sdkconfig.defaults` 已设 `CONFIG_ESP_CONSOLE_USB_SERIAL_JTAG=y`，printf 走 USB CDC，USB 口即 COM4。若误设为 UART0，则 USB 口没有输出，平台读不到数据。
6. **备份**：如后续要恢复出厂演示固件，需提前保存/下载官方 `esp-who` 出厂镜像，本仓库不提供该镜像。

---

## 5. 部署入口

| 场景 | 做法 |
|---|---|
| 本机演示 | `npm start`，浏览器开 `http://localhost:8080` |
| 局域网/ VPS | `HOST=0.0.0.0 PORT=8080 npm start`（或改 `config.json` 的 `host`/`httpPort`），防火墙放行对应端口 |
| 板端指向 | 改 `firmware/s3eye_imu_idf/main/app_config.h` 里的 `APP_SERVER_HOST` / `APP_SERVER_PORT` 为服务端 IP |
| 各组独立空间 | 改 `DEVICE_ID`（如 `S3EYE-GROUP01`），落盘记录按 `device_id` 区分，互不混淆 |
| 本组身份校验 | 服务端 `config.json` 的 `expectedDeviceId` 设为同一 `DEVICE_ID`；前端状态条实时显示「✓ 本组设备 / ⚠ 非本组设备」，可当场证明数据来自本组设备、页面未写死数值 |

> **核对数据来自本组设备**是作业的硬性要求。把板端 `DEVICE_ID` 与服务端 `expectedDeviceId` 设为同一字符串后，任何邻组推到同一 VPS 的数据都会被标记为「非本组」，既不会混显，也不会被丢弃（保留在 VPS 记录里且 `device_id` 可区分），便于当堂核对。

> 部署在 VPS 时，WiFi 固件的 `SERVER_HOST` 填 VPS 公网/内网 IP，`SERVER_PORT` 与服务端一致；若 VPS 失败，可先用本机 `0.0.0.0` 调试通过，再切 VPS。

---

## 6. 运行与演示步骤（一人一设备验证）

1. **准备**：安装驱动（本板为原生 USB，VID 303A，无需 CH340/CP210x 驱动）；装好 `serialport`、`ws`（`npm install`）。
2. **烧录**：按第 4 节流程，先在网页点「释放串口」释放 COM4，再用 ESP-IDF 烧录（环境在 `C:\Espressif`）：
   ```bash
   npm run firmware:flash      # = idf.py build + flash -p COM4
   # 或分步：npm run firmware:build  然后  npm run firmware:flash
   ```
   烧录前在 `firmware/s3eye_imu_idf/main/app_config.h` 填好 WiFi、`APP_SERVER_HOST`（服务端局域网 IP）与 `APP_DEVICE_ID`。
3. **启动服务**：`npm start`，确认控制台无 `EADDRINUSE`。
4. **当堂验证一个传感源（IMU）**：
   - 板子上电 → 网页状态变绿，三轴面板出现 g / m/s² 数值；
   - 平放板子，验证 Z≈1g、X/Y≈0（单位核对）；
   - 打开"VPS 原始记录 → 查询本组"，确认**记录数与上报帧数一致**（一人一记录）；
   - 停止采集（断电或暂停程序），页面出现「未更新」徽章并**保留旧时间与末值**；重新采集后恢复实时。
   - 物理拔掉 USB → 页面**立即清空**，无任何模拟数据。
5. **导出留痕**：记录面板「导出 CSV」可下载 `data/records.csv` 作为提交佐证。

---

## 6.1 嵌入式调试过程说明（教师要求）

当"板子插着却看不到数据"时，按以下顺序定位，平台已内置对应工具（网页「诊断」「波特率探测」按钮）：

| 步骤 | 观察点 | 结论 |
|---|---|---|
| 1 | 网页「诊断」→ `bytesReceived` | 0 = 固件没往该口输出；>0 但 0 行有效 = 格式/换行问题 |
| 2 | 串口 VID | `303A` = S3 原生 USB（波特率无效）；`1a86/10c4` = 外挂芯片（波特率必须匹配） |
| 3 | 「波特率探测」逐个波特率监听 | 全部 0 字节 → 固件未输出到该口（S3 需 `USB CDC On Boot=Enabled`） |
| 4 | 任意串口监视器（如 `npm run firmware:monitor` / 串口调试助手） | 有输出而平台没有 → 监视器独占了串口，先关闭再连网页 |
| 5 | 板子 RST 键 | 看是否打印启动日志，判断 console 是否在 USB 口 |

**本板（ESP32-S3-EYE）的实测结论**：无 USB-UART 桥接芯片，出厂 ESP-IDF 固件的 console 默认在 UART0，因此**从 USB 口读不到它的输出**。这正是采用 **WiFi 独立网络上传**（而非依赖 USB 串口）的原因——既绕开该限制，又满足"独立网络上传"的作业要求。

**无线侧调试**：板端串口日志会打印 `[wifi] IP=… RSSI=…`、`[http] 200 成功=N 失败=M`；服务端 `/api/diag` 与网页「VPS 原始记录」可确认数据是否落盘；两端时间用 `skew_ms` 对照。

---

## 7. 自检脚本（共 84 项，全部通过）

```bash
# 需先在 8080 启动服务：npm start
node test/parse-test.js       # 10 项  通用解析：JSON/键值/中文键/误解析防护
node test/e2e-test.js         # 14 项  空状态 / 上报 / 停采保留 / 断开清空
node test/feature-test.js     # 14 项  诊断接口 / 录制导出 / CSV

# 自带服务，无需先启动（各自用独立端口）
node test/storage-test.js     # 19 项  落盘 + 查询 + 停采保留
node test/ws-test.js          #  9 项  WebSocket sample/stale/cleared 推送结构
node test/acceptance-test.js  # 12 项  全链路验收：固件形状数据→落盘→页面→停采
node test/verify-test.js      #  6 项  本组设备身份校验（本组/非本组/关闭校验）
```

---

## 8. 提交清单（作业要求）

- [x] **板端代码**：`firmware/s3eye_imu_idf/`（ESP-IDF 工程，`main/main.c` + `main/app_config.h`：`APP_DEVICE_ID`、QMA7981 IMU 读取、NTP 对时、WiFi 上传 + USB 串口兜底）
- [x] **服务端代码**：`server.js`（接收 / NDJSON 落盘 / 查询接口 / WebSocket 推送 / 三态策略 / 身份校验）
- [x] **网页代码**：`public/index.html` `app.js` `style.css`（三轴展示、未更新提示、VPS 查询、本组校验；**未写死任何数值**）
- [x] **部署入口**：§5（`HOST`/`PORT` 环境变量、`config.json`、板端 `SERVER_HOST` 对照）
- [x] **一帧真实观测 ↔ 一条对应记录**：§3.3 + 「VPS 原始记录」面板 + `/api/records`
- [x] **个人修改与运行说明**：§0.1 个人必改项 + §6 运行步骤
- [x] **嵌入式调试过程说明**：§6.1
- [x] **备用路径（无 VPS）**：§5（本机 `0.0.0.0` 当服务器）

> 提交前只需完成 **§0.1 的三处个人必改项**（WiFi、`SERVER_HOST`、`DEVICE_ID` ↔ `expectedDeviceId`），其余代码开箱即用。
