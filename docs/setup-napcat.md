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

`up`、`start` 与 `restart` 使用同一套清空后启动流程。启动器先停止能够同时证明仓库入口与 `SUNABOT_WORKSPACE` 身份的 Native Core 进程组、全部当前 workspace 标签的 Docker 容器、运行网络和 account runtime daemon，再确认 launcher state、进程、容器、网络及 8787、8788 和开发模式 5173 端口均已清空。身份无法验证的进程不会收到信号；未知进程仍占用端口时以非零状态退出。随后启动所选 Core、注册表中全部已启用 NapCat 与 account runtime daemon。Native OneBot 容器连通性探针最多运行 15 秒，Core、管理 API、OneBot listener 与 account runtime daemon 必须连续稳定 3 秒，并且全部 liveness/readiness 检查通过后启动命令才成功退出；Codex 登录等可选 capability 可以保持降级。

Core 启动还会校验固定版本的 Codex CLI；Docker Core 使用镜像内的 `/usr/local/bin/codex`，Native Core 使用 `SUNABOT_CODEX_EXECUTABLE` 或 `PATH`。Codex 授权保存在 `workspace/secrets/codex/auth.json`，未登录时可以先启动管理台完成设备授权，工具在授权完成前保持不可调用。

### MCP 扩展运行环境

OAuth 凭据库需要独立的 32 字节 base64url 主密钥。生成后把结果写入 `workspace/secrets/runtime.env`，不要提交到 Git：

```bash
node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))'
```

```dotenv
SUNABOT_MCP_CREDENTIAL_VAULT_KEY=<上一步生成的结果>
```

stdio MCP 默认关闭。macOS Native Core 使用独立 Docker 沙箱，并只接受包含已预装 server、入口和批准清单的 digest 固定自定义镜像：

```dotenv
SUNABOT_MCP_STDIO_BACKEND=docker
SUNABOT_MCP_STDIO_DOCKER_IMAGE=registry.example/sunabot-mcp@sha256:<64位小写摘要>
SUNABOT_MCP_STDIO_EXECUTABLE_MANIFEST_SHA256=<镜像内 /opt/sunabot/mcp/executables.json 的 SHA-256>
```

Linux/WSL Native Core 或定制 Docker Core 可以使用 bubblewrap。批准清单必须是绝对路径、root 所有、单硬链接的普通文件并具有 `0444` 权限；清单中的每个绝对可执行路径都要记录当前文件的 SHA-256。Docker Core 使用该模式时，可执行文件与同一清单必须在构建镜像时预装：

```dotenv
SUNABOT_MCP_STDIO_BACKEND=bubblewrap
SUNABOT_MCP_STDIO_EXECUTABLE_MANIFEST=/opt/sunabot/mcp/executables.json
```

运行时不下载 `npx`、`uvx`、`pip` 或其他依赖，也不会把 Docker socket、宿主环境或代理变量交给 stdio server。每个 server 的秘密使用管理 API 返回的 `SUNABOT_MCP_STDIO_SECRET_<摘要>` 环境变量名单独配置；同名逻辑 key 在不同 Agent 或 server 下使用不同宿主变量名。修改后执行 `./sunabot.sh doctor`，确认 `mcp-oauth` 与 `mcp-stdio` capability 通过；缺失或非法配置时对应能力保持不可用。

Apple Silicon 上的 linux/amd64 Docker 模拟内核若以 `EINVAL` 拒绝 bubblewrap user namespace，启动器会停止 Docker Core 并保持 Bash 不可用。该环境需要改用能够通过 namespace probe 的 Linux/amd64 或 WSL2 主机，不能关闭隔离或回退到普通 Bash。

停止、重启和诊断：

```bash
./sunabot.sh down
./sunabot.sh restart
./sunabot.sh status
./sunabot.sh logs
./sunabot.sh doctor
```

不要直接执行旧的 `npm run qq:*`、单容器 Compose 或 Native NapCat systemd 命令。运行模式切换可直接执行 `up`、`start` 或 `restart`，同一个 workspace 只能由当前 launcher 管理一个 Core 和注册表中的 NapCat 账号容器。

`up`、`start`、`down` 和 `restart` 会预检当前 workspace 的 Compose one-off 探针。若 Docker 列表仍显示探针运行，但 `docker inspect` 已返回容器不存在，macOS Colima 的交互终端会提示重启 Colima，并明确说明其他 Docker 容器会短暂中断；确认后启动器重启 Colima、等待 Docker Engine 恢复、复验悬空记录已消失，再继续原命令。非交互命令或其他 Docker Engine 保持失败关闭，并返回 `colima restart` 或重启当前 Docker Engine 的操作提示。该修复不绕过停服、迁移、恢复点或数据库完整性门禁。

macOS Native Core 启动时由 launcher 按 `DOCKER_CONTEXT`、`DOCKER_HOST`、当前 Context 的顺序解析实际 Unix endpoint，并把固定路径作为 `SUNABOT_DOCKER_SOCKET` 注入 Core；非 Unix endpoint 会关闭 Docker Bash capability。Core 不跟随运行中 Context 切换，切换 Docker daemon 后必须通过 `./sunabot.sh restart` 重新固定 endpoint。`SUNABOT_WORKSPACE_ID` 与 `SUNABOT_RUNTIME_ID` 同样由 launcher 覆盖，不能在 `runtime.env` 中伪造。`status`、`doctor`、启停与恢复使用有界 Docker 命令；macOS Docker Bash 异常显示 `DOCKER_BASH_UNAVAILABLE`。

每条 Bash 命令使用独立短生命周期容器，最长执行 30 秒；Core 只在首次 capability 和熔断恢复时创建完整探针容器，普通命令前不再额外 `docker run` 探针。命令容器采用 `sunabot-bash-<32hex>` 名称和 `io.sunabot.*` owner/调用/过期标签；Core 在线删除失败会重试，launcher 在启动和停止流程中回收当前 workspace 的合法残留。排查残留时不得按名称批量删除，也不得删除 NapCat；先执行 `./sunabot.sh doctor`，再按完整标签确认归属。

带 `.remove-on-stop` 的 NapCat 目录只有在账号注册行已经删除后才会清理。Agent 删除流程中断、账号仍在注册表时保留目录和登录态，避免后续启动被迁移完整性门禁锁死。

## QQ 登录

首次启动会为 Plana 创建“主账号”。打开管理台 `http://127.0.0.1:8787/agents`，选择 Agent 后进入对应账号登录；管理台每 2 秒同步登录状态，二维码轮换后自动更新，也可以主动刷新。

每个 Agent 可以新增多个 QQ。管理台使用“新建 NapCat QQ Docker”登记账号，未运行时点击“运行”创建或启动对应独立容器，成功后点击“登录”扫码。新增、启停、运行或移除账号写入注册表后，宿主 account runtime daemon 只调和对应 NapCat；Docker Core 通过 workspace request/result bridge 请求宿主执行，不挂载 Docker socket。管理台显示期望状态、实际状态、是否仍需调和和最近错误；注册库不可读、daemon 缺失或请求超时时失败关闭，不停止或删除其他容器。QQ 在线后，账号弹窗提供退出操作；确认退出后该 NapCat 自动回到扫码态，扫描新账号成功后保存 QQ 号供后续快速登录。账号收到 `KICKEDOFFLINE` 时，管理台自动请求强制重建该账号自己的 NapCat 容器并刷新二维码，无需重启 Core 或其他 QQ 容器。各 NapCat 原生 WebUI 只作为故障诊断入口。

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
