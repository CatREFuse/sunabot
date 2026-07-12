# Sunabot 与 NapCat 启动配置

## 运行边界

NapCat 在 macOS、WSL2 和 Linux 上始终运行于独立 Docker 容器。Sunabot Core 可以 Native 运行，也可以作为独立 Docker 容器运行。两者只通过 OneBot v11 和明确的运行状态目录协作。

```text
Browser ── http://127.0.0.1:8787 ── Sunabot Core

NapCat Docker ── OneBot reverse WebSocket + token ── Sunabot Core :8788
      │
      └── http://127.0.0.1:6099/webui
```

固定端口：

| 用途 | 地址 | 边界 |
| --- | --- | --- |
| 管理台 | `http://127.0.0.1:8787` | 仅宿主回环 |
| OneBot | Core 内部端口 `8788` | Compose 私有网络或容器到宿主网关，强制 token |
| NapCat WebUI | `http://127.0.0.1:6099/webui` | 仅宿主回环 |

Docker Core 模式下，NapCat 使用 `ws://core:8788/onebot/v11/ws`。Native Core 模式下，macOS listener 绑定回环并通过 `host.docker.internal` 转发；WSL2/Linux listener 只绑定当前 Compose 私有网络的 gateway 地址，容器仍通过 host-gateway 映射接入。用户不需要手工维护这些地址。

管理台与 OneBot 使用不同 listener。禁止把 Core 管理监听改成 `0.0.0.0:8787` 来迁就容器通信，也禁止把 `8788` 发布到局域网或公网。

## 启动

唯一运行入口是仓库根目录的 `sunabot.sh`：

```bash
./sunabot.sh up
```

`SUNABOT_CORE_MODE=auto` 在 macOS 选择 Native Core，在 WSL2/Linux 选择 Docker Core。显式选择方式：

```bash
SUNABOT_CORE_MODE=native ./sunabot.sh up
SUNABOT_CORE_MODE=docker ./sunabot.sh up
```

macOS 快速开发模式会启动 API watch 与 Vite：

```bash
./sunabot.sh up --dev
```

开发管理台使用 `http://127.0.0.1:5173`，API 继续监听 `127.0.0.1:8787`。

启动器依次完成 workspace 初始化、运行令牌检查、Core 启动与健康检查、NapCat OneBot 配置、NapCat 容器启动和连接状态检查。缺失 `ONEBOT_ACCESS_TOKEN` 或 `WEBUI_TOKEN` 时会生成随机令牌并写入 `workspace/secrets/runtime.env`。

停止、重启和诊断：

```bash
./sunabot.sh down
./sunabot.sh restart
./sunabot.sh status
./sunabot.sh logs
./sunabot.sh doctor
```

不要直接执行旧的 `npm run qq:*`、单容器 Compose 或 Native NapCat systemd 命令。运行模式切换前使用 `./sunabot.sh down`，同一个 workspace 不能同时被两套 Core 或两套 NapCat 使用。

## QQ 登录

首次启动可以在 `workspace/secrets/runtime.env` 预设 QQ 号：

```text
NAPCAT_ACCOUNT=你的QQ号
```

未完成 QQ 登录时，`./sunabot.sh up` 保持服务运行并报告 `awaiting-login`。打开管理台 `http://127.0.0.1:8787/overview`，点击“QQ 登录”即可直接扫码。管理台每 2 秒同步登录状态，二维码轮换后自动更新，也可以主动刷新。

QQ 在线后，“QQ 账号”弹窗提供退出操作。确认退出后 NapCat 自动回到扫码态；扫描新的账号成功后，管理台会保存新的 QQ 号供后续快速登录。整个登录、退出和换号流程不需要 Agent 或终端介入。NapCat 原生 WebUI `http://127.0.0.1:6099/webui` 仅作为故障诊断入口。

完成扫码后可以执行：

```bash
./sunabot.sh status
```

NapCat 配置、QQ 登录态、插件和二维码位于：

```text
workspace/runtime/napcat/config-full/
workspace/runtime/napcat/qq/
workspace/runtime/napcat/plugins/
workspace/runtime/napcat/qrcode.png
workspace/runtime/napcat/manual-login-required
```

这些目录会在更新和 Core 模式切换后保留。不要把它们提交到 Git，也不要在容器运行时复制或覆盖。

## OneBot 与媒体

`ONEBOT_ACCESS_TOKEN` 同时注入 Core 与 NapCat。空 token、配置不一致或未鉴权连接都会被拒绝。正常运行只允许一个 NapCat 客户端连接当前 Core；doctor 会检查重复进程、端口占用和 workspace 身份。

Core 与 NapCat 不共享业务媒体目录。生成图片在 Core 完成路径和大小校验后，通过 OneBot `base64://` 发送；macOS Native、WSL/Linux Native 和 Docker Core 使用同一格式。任何功能都不能向 NapCat 发送 Core 的绝对文件路径，也不能要求两个容器拥有相同挂载点。

QQ 入站文件优先使用 OneBot 返回的受控 URL；启动器固定开启 `get_file` 的 Base64 回退，避免把容器内路径交给 Core。后续大文件能力仍需使用明确、鉴权、限流的流式传输接口。

## 验收

```bash
./sunabot.sh doctor
./sunabot.sh status
```

运行状态应满足：

- 管理台只监听 `127.0.0.1:8787`。
- NapCat WebUI 只监听 `127.0.0.1:6099`。
- OneBot 使用专用 `8788` 端口和 access token。
- 当前 workspace 只有一个 Core 和一个 NapCat 容器。
- QQ 登录状态为 online，或首次登录明确显示 `awaiting-login`。
- 文本 action、图片 `base64://` 外发、QQ 文件读取和 Provider 测试成功。
- 重启后 SQLite、outbox、NapCat 登录态和 OneBot 连接恢复。

外网访问管理台时使用 HTTPS 反向代理并配置 `SUNABOT_ADMIN_ORIGINS`。不要公开 8787、6099 或 OneBot 端口。
