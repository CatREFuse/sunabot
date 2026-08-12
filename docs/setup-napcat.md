# Sunabot 与 NapCat 启动配置

版本：2026-08-12（v0.3.0）

## 运行边界

Sunabot Core 在 macOS、WSL2 和 Linux 上固定 Native 运行。每个 QQ 账号使用一个独立 NapCat Docker 容器；NapCat 是唯一 Docker 例外。

```text
Browser ── http://127.0.0.1:8787 ── Sunabot Native Core

NapCat Docker × QQ ── OneBot reverse WebSocket + token + account_id ── :8788
      │
      └── http://127.0.0.1:6099 起的独立 WebUI 端口
```

| 用途 | 地址 | 边界 |
| --- | --- | --- |
| 管理台 | `http://127.0.0.1:8787` | 仅宿主回环 |
| OneBot | Native Core `8788` | Docker Engine 使用当前 bridge gateway；WSL Docker Desktop 使用安全回环主机转发；强制 token |
| NapCat WebUI | 首个账号 `http://127.0.0.1:6099/webui`，后续账号使用注册端口 | 每账号独立，仅宿主回环 |
| Lightpanda renderer | Linux/WSL `127.0.0.1:8790` | Native Core 回环；macOS 不启动 |

Launcher 为每个 NapCat 写入经过容器 `/healthz` 探针确认的 `ws://<reachable-host>:8788/onebot/v11/ws?account_id=<accountId>` 及 access token。WSL 内置 Docker Engine 使用当前运行网络的本机 bridge gateway；Docker Desktop WSL2 后端的 bridge gateway 位于独立 Docker VM，Core 改为只监听 `127.0.0.1`，NapCat 使用 Docker Desktop 提供的 `host.docker.internal` 转发。gateway 不属于 Native Core 网络命名空间且回环转发不可达时，启动明确失败并清理已启动组件。用户不需要维护 OneBot 地址。管理台与 OneBot 使用不同 listener；不能把 `8787` 或 `8788` 改成 `0.0.0.0`、WSL `eth0` 或面向局域网/公网的监听来迁就容器通信。

## 安装与启动

发行版安装：

```bash
curl -fsSL https://github.com/CatREFuse/sunabot/releases/latest/download/install.sh | bash
bash "$HOME/.local/share/sunabot/current/sunabot.sh" up
```

源码运行：

```bash
./sunabot.sh up
```

首次交互式 `up` 在服务启动前进入 CLI Landing，要求设置管理员名称与至少 12 字符的密码。缺少凭据且无 TTY 时明确失败。Landing 写入 `workspace/secrets/admin-credentials.json`；OneBot 与 NapCat WebUI 随机 token 写入 `workspace/secrets/runtime.env`，命令不输出秘密值。

`up`、`start` 与 `restart` 使用同一套清空后启动流程：

1. 校验发行 manifest、Native 依赖和锁定 NapCat 镜像已经存在。
2. 通过 workspace/migration 门禁并完成 Landing 或读取既有管理员凭据。
3. 停止身份可验证的旧 Native Core 进程组、account runtime daemon、当前 workspace 标签的 NapCat 容器和运行网络。
4. 确认 launcher state、进程、容器、网络与 `8787`、`8788`、开发模式 `5173` 端口已清空。
5. 启动 Native Core、平台能力、注册表中全部已启用 NapCat 和 account runtime daemon。
6. Core、管理 API、OneBot listener 与 daemon 连续稳定 3 秒且 readiness 通过后返回成功。

身份无法验证的进程不会收到信号；未知进程占用固定端口时以非零状态退出。普通启动不执行 npm install、浏览器下载、容器构建或镜像拉取。

停止与诊断：

```bash
./sunabot.sh down
./sunabot.sh restart
./sunabot.sh status
./sunabot.sh logs
./sunabot.sh doctor
```

`SUNABOT_CORE_MODE` 与 `--core` 已删除，传入时返回错误。不要运行旧 Core Compose、`npm run qq:*` 或 Native NapCat systemd 命令。

macOS 源码开发模式可以使用：

```bash
./sunabot.sh up --dev
```

开发管理台为 `http://127.0.0.1:5173`，API 继续监听 `127.0.0.1:8787`。

## NapCat 镜像与发行

`components/component.lock.json` 锁定 NapCat 版本、上游镜像和 digest。Sunabot release 不内置 NapCat/QQ 镜像；公开再分发授权尚未确认。安装程序只在安装阶段从上游准备摘要固定的镜像，launcher 固定使用 Docker `--pull never`。

本机缺少锁定镜像时，`up|start|restart` 返回 `NAPCAT_IMAGE_MISSING` 并要求重新执行发行安装程序。启动流程不能临时拉取 latest、回退其他 tag 或构建本地替代镜像。

`deploy/napcat/compose.yml` 是每账号模板。每个 Compose project 只挂载：

```text
workspace/runtime/napcat/accounts/<accountId>/config-full/
workspace/runtime/napcat/accounts/<accountId>/qq/
workspace/runtime/napcat/accounts/<accountId>/plugins/
workspace/runtime/napcat/accounts/<accountId>/
```

NapCat 不挂载 Core 数据库、Agent 目录、canonical Workbench、Provider key、Codex 授权或管理凭据。容器标签绑定 runtime、workspace、组件和稳定 `accountId`；启停与清理必须同时验证完整标签，不能按名称或前缀批量删除。

带 `.remove-on-stop` 的账号目录只有在注册行已经删除后才能清理。Agent 删除中断或账号仍在注册表时保留目录与登录态。

## Native 工具能力

Core、Bash、MCP、Skill Script、Codex 与 WebFetch 都不使用 Docker：

- Linux/WSL `native_bash` 在随包 Bubblewrap 与资源限制下运行，cwd 为当前 Agent 的唯一 `workbench/`。
- macOS Bash 仅向管理员 QQ 私聊与已认证管理员 Web Chat 开放，每条命令通过独立对抗审批后以 Core 用户执行；其他会话不获得 Bash。
- stdio MCP 只支持 Linux/WSL Native Bubblewrap backend，默认关闭；远端 MCP 由 Core Native client 访问。macOS 不存在 Docker stdio backend。
- Skill Script 使用 Native adapter；Linux/WSL 通过 Bubblewrap，依赖必须预装并经批准清单固定，运行时不调用 `npx`、`uvx`、`pip` 或其他安装器。
- Codex CLI 来自源码锁定依赖或发行包，授权保存在 `workspace/secrets/codex/auth.json`。
- WebFetch 静态抓取在所有 Native Core 可用；Linux/WSL 动态抓取使用随包 Lightpanda `0.3.3` 与 Bubblewrap，macOS 动态能力明确 `unavailable`。

每个 Agent 只有一个 canonical `workbench/`。管理员、普通私聊、群聊和 Web Chat 的媒体导出、`send_file`、Codex、Bash、自拍、表情、知识和 Skill 都解析同一目录；当前运行时不创建、读取或展示 `docker-workbench/`。

### MCP 配置

MCP OAuth vault 使用独立 32 字节 base64url 密钥，值只写入 `workspace/secrets/runtime.env`。stdio MCP 的 Native 配置为：

```dotenv
SUNABOT_MCP_STDIO_BACKEND=bubblewrap
SUNABOT_MCP_STDIO_EXECUTABLE_MANIFEST=/opt/sunabot/mcp/executables.json
```

manifest 必须是 root 所有、单硬链接、权限 `0444` 的普通绝对路径文件；每个可执行文件记录绝对路径和 SHA-256。环境只按 server 的显式 allowlist 注入，server A 不能读取 server B、Provider、OneBot、Codex 或宿主通用环境的凭据。配置不完整时 capability 保持不可用，不回退到宿主 shell 或 Docker。

## QQ 登录与账号调和

首次启动为 Plana 创建“主账号”。打开 `http://127.0.0.1:8787/agents`，选择 Agent 后点击“登录”扫码；管理台持续同步二维码与登录状态。

每个 Agent 可以新增多个 QQ。新增账号会获得稳定 `accountId`、独立 NapCat 容器、目录和 WebUI 端口。新增、启停、运行或移除写入注册表后，宿主 account runtime daemon 只调和目标账号。注册库不可读、daemon 缺失或请求超时时失败关闭，不停止或删除其他容器。

QQ 在线后可以从账号弹窗退出；退出只让该账号回到扫码态。`KICKEDOFFLINE` 会请求重建目标 NapCat 并刷新二维码，不重启 Core 或其他账号。NapCat 原生 WebUI 只作故障诊断入口。

账号目录：

```text
workspace/runtime/napcat/accounts/<accountId>/config-full/
workspace/runtime/napcat/accounts/<accountId>/qq/
workspace/runtime/napcat/accounts/<accountId>/plugins/
workspace/runtime/napcat/accounts/<accountId>/qrcode.png
workspace/runtime/napcat/accounts/<accountId>/account.env
workspace/runtime/napcat/accounts/<accountId>/manual-login-required
```

这些目录在 release 更新与 Native Core 重启后保留。不要提交到 Git，也不要在容器运行时复制、覆盖或迁移登录态。

同一 QQ 在另一个 Agent 的账号槽登录时，管理登录流程退出旧连接、重建旧账号自己的 NapCat，再原子转移唯一归属。普通消息入站不能发起账号转移；旧 Agent 的业务数据不随 QQ 归属移动。

## OneBot 与媒体

`ONEBOT_ACCESS_TOKEN` 同时提供给 Native Core 和所有 NapCat。空 token、配置不一致、缺少合法 `account_id`、未注册账号或未鉴权连接都会被拒绝。同一账号只允许一个 NapCat 连接；多个注册账号可同时连接一个 Core。

Core 与 NapCat 不共享业务媒体目录。当前会话的图片与普通文件由 Core 从 canonical Workbench 或会话媒体句柄解析；图片经大小和类型校验后通过 OneBot `base64://` 发送。任何功能都不能把 Core 绝对路径发送给 NapCat，也不能要求容器拥有相同挂载点。

QQ 入站文件优先使用 OneBot 的受控下载结果，必要时使用协议定义的 Base64 回退；NapCat 容器路径不能被 Core 直接打开。

## 验收

```bash
./sunabot.sh doctor
./sunabot.sh status
```

- 管理台只监听 `127.0.0.1:8787`。
- 每个 NapCat WebUI 使用独立回环端口。
- OneBot 使用专用 `8788` 与 access token。
- 当前 workspace 只有一个 Native Core；运行中的业务容器只有每个启用 QQ 的 NapCat。
- 管理台账号操作只影响目标 NapCat。
- 两个 QQ 同时在线并分别路由到所属 Agent。
- 私聊、群聊、引用、图片 `base64://`、普通文件和账号定向外发通过。
- 所有会话的媒体、`send_file` 与 Codex 使用同一 canonical Workbench。
- Linux/WSL Native Bash、MCP、Skill 和 Lightpanda Bubblewrap capability 通过，失败无未隔离降级。
- `restart` 后 SQLite、outbox、QQ 登录态和 OneBot 连接恢复。
- 断开外部依赖源后 `up|restart` 不产生下载或镜像拉取。

远程访问管理台时使用 HTTPS 反向代理并配置精确 `SUNABOT_ADMIN_ORIGINS`。不要直接公开 8787、8788、8790 或任何 NapCat WebUI 端口。
