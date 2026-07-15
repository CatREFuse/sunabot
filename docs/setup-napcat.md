# Sunabot 与 NapCat 启动配置

## 运行边界

NapCat 在 macOS、WSL2 和 Linux 上始终运行于独立 Docker 容器，每个 QQ 账号使用一个容器。Sunabot Core 可以 Native 运行，也可以作为独立 Docker 容器运行。Core 与各 NapCat 只通过 OneBot v11 和明确的运行状态目录协作。

```text
Browser ── http://127.0.0.1:8787 ── Sunabot Core

NapCat Docker × QQ ── OneBot reverse WebSocket + token + account_id ── Sunabot Core :8788
      │
      └── http://127.0.0.1:6099 起的独立 WebUI 端口
```

固定端口：

| 用途 | 地址 | 边界 |
| --- | --- | --- |
| 管理台 | `http://127.0.0.1:8787` | 仅宿主回环 |
| OneBot | Core 内部端口 `8788` | Compose 私有网络或容器到宿主网关，强制 token |
| NapCat WebUI | 首个账号 `http://127.0.0.1:6099/webui`，后续账号顺延 | 每个账号独立，仅宿主回环 |

Docker Core 模式下，各 NapCat 使用 `ws://core:8788/onebot/v11/ws?account_id=<accountId>`。Native Core 模式下，macOS listener 绑定回环并通过 `host.docker.internal` 转发；WSL2/Linux listener 只绑定当前 Compose 私有网络的 gateway 地址，容器仍通过 host-gateway 映射接入。启动器生成账号参数，用户不需要手工维护这些地址。

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

启动器依次完成 workspace 初始化、运行令牌检查、Core 启动与健康检查、读取 `agent_accounts`、逐账号生成 NapCat OneBot 配置、启动独立容器并检查健康状态。缺失 `ONEBOT_ACCESS_TOKEN` 或 `WEBUI_TOKEN` 时会生成随机令牌并写入 `workspace/secrets/runtime.env`。

Core 启动还会校验固定版本的 Codex CLI；Docker Core 使用镜像内的 `/usr/local/bin/codex`，Native Core 使用 `SUNABOT_CODEX_EXECUTABLE` 或 `PATH`。Codex 授权保存在 `workspace/secrets/codex/auth.json`，未登录时可以先启动管理台完成设备授权，工具在授权完成前保持不可调用。

Apple Silicon 上的 linux/amd64 Docker 模拟内核若以 `EINVAL` 拒绝 bubblewrap user namespace，启动器会停止 Docker Core 并保持 Bash 不可用。该环境需要改用能够通过 namespace probe 的 Linux/amd64 或 WSL2 主机，不能关闭隔离或回退到普通 Bash。

停止、重启和诊断：

```bash
./sunabot.sh down
./sunabot.sh restart
./sunabot.sh status
./sunabot.sh logs
./sunabot.sh doctor
```

不要直接执行旧的 `npm run qq:*`、单容器 Compose 或 Native NapCat systemd 命令。运行模式切换前使用 `./sunabot.sh down`，同一个 workspace 只能由当前 launcher 管理一个 Core 和注册表中的 NapCat 账号容器。

`up`、`down` 和 `restart` 会预检当前 workspace 的 Compose one-off 探针。若 Docker 列表仍显示探针运行，但 `docker inspect` 已返回容器不存在，macOS Colima 的交互终端会提示重启 Colima，并明确说明其他 Docker 容器会短暂中断；确认后启动器重启 Colima、等待 Docker Engine 恢复、复验悬空记录已消失，再继续原命令。非交互命令或其他 Docker Engine 保持失败关闭，并返回 `colima restart` 或重启当前 Docker Engine 的操作提示。该修复不绕过停服、迁移、恢复点或数据库完整性门禁。

## QQ 登录

首次启动会为 Plana 创建“主账号”。打开管理台 `http://127.0.0.1:8787/agents`，选择 Agent 后进入对应账号登录；管理台每 2 秒同步登录状态，二维码轮换后自动更新，也可以主动刷新。

每个 Agent 可以新增多个 QQ。管理台使用“新建 NapCat QQ Docker”登记账号，未运行时点击“运行”创建或启动对应独立容器，成功后点击“登录”扫码。新增、启停、运行或移除账号写入注册表后，宿主 account runtime daemon 只调和对应 NapCat；Docker Core 通过 workspace request/result bridge 请求宿主执行，不挂载 Docker socket。管理台显示期望状态、实际状态、是否仍需调和和最近错误；注册库不可读、daemon 缺失或请求超时时失败关闭，不停止或删除其他容器。QQ 在线后，账号弹窗提供退出操作；确认退出后该 NapCat 自动回到扫码态，扫描新账号成功后保存 QQ 号供后续快速登录。各 NapCat 原生 WebUI 只作为故障诊断入口。

完成扫码后可以执行：

```bash
./sunabot.sh status
```

NapCat 配置、QQ 登录态、插件和二维码位于：

```text
workspace/runtime/napcat/accounts/<accountId>/config-full/
workspace/runtime/napcat/accounts/<accountId>/qq/
workspace/runtime/napcat/accounts/<accountId>/plugins/
workspace/runtime/napcat/accounts/<accountId>/qrcode.png
workspace/runtime/napcat/accounts/<accountId>/account.env
workspace/runtime/napcat/accounts/<accountId>/manual-login-required
```

这些目录会在更新和 Core 模式切换后保留。不要把它们提交到 Git，也不要在容器运行时复制或覆盖。

## OneBot 与媒体

`ONEBOT_ACCESS_TOKEN` 同时注入 Core 与所有 NapCat。空 token、配置不一致、缺少合法 `account_id`、未注册账号或未鉴权连接都会被拒绝。同一账号只允许一个 NapCat 客户端连接，多个注册账号可以同时连接当前 Core；doctor 会逐账号检查容器健康、端口占用和 workspace 身份。

Core 与 NapCat 不共享业务媒体目录。生成图片在 Core 完成路径和大小校验后，通过 OneBot `base64://` 发送；macOS Native、WSL/Linux Native 和 Docker Core 使用同一格式。任何功能都不能向 NapCat 发送 Core 的绝对文件路径，也不能要求两个容器拥有相同挂载点。

QQ 入站文件优先使用 OneBot 返回的受控 URL；启动器固定开启 `get_file` 的 Base64 回退，避免把容器内路径交给 Core。后续大文件能力仍需使用明确、鉴权、限流的流式传输接口。

## 验收

```bash
./sunabot.sh doctor
./sunabot.sh status
```

运行状态应满足：

- 管理台只监听 `127.0.0.1:8787`。
- 每个 NapCat WebUI 使用独立端口，并且只监听宿主回环。
- OneBot 使用专用 `8788` 端口和 access token。
- 当前 workspace 只有一个 Core，每个已启用 QQ 账号只有一个 NapCat 容器。
- 管理台“运行”只创建或启动目标 QQ 容器，其他 NapCat 不重启。
- 两个 QQ 可以同时在线，并且分别路由到所属 Agent。
- 文本 action、图片 `base64://` 外发、QQ 文件读取和 Provider 测试成功。
- 重启后 SQLite、outbox、NapCat 登录态和 OneBot 连接恢复。
- doctor 中 Codex CLI 版本与 workspace 授权均通过；工具目录只在 CLI、授权和配置同时有效时显示可调用。

外网访问管理台时使用 HTTPS 反向代理并配置 `SUNABOT_ADMIN_ORIGINS`。不要公开 8787、任何 NapCat WebUI 端口或 OneBot 端口。
