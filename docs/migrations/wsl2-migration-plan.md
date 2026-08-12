# sunabot WSL2 部署与迁移

日期：2026-08-12（v0.3.0）

目标：在 Windows WSL2 中使用自包含 Linux 发行包运行一个 Sunabot Native Core，并为每个 QQ 账号运行一个独立 NapCat Docker 容器；完整保留 Agent 业务数据、队列、凭据和 QQ 登录态。

## 1. 支持范围

推荐 Ubuntu 24.04 WSL2。安装目录和 workspace 放在 WSL ext4 文件系统，例如默认的 `$HOME/.local/share/sunabot` 或 `/srv/sunabot`，不要放在 `/mnt/c`。Windows Native 不在当前支持范围。

| 主机 | Docker 方案 |
| --- | --- |
| Windows 11 | Docker Desktop WSL2 后端，并为目标发行版开启 WSL Integration |
| Windows Server 2022/2025 | 在 Ubuntu WSL2 内安装 Docker Engine 与 Compose 插件 |

Docker Desktop 的 Windows 支持范围以 [Docker 官方文档](https://docs.docker.com/desktop/setup/install/windows-install/) 为准；Windows Server 的 WSL 安装以 [Microsoft 官方文档](https://learn.microsoft.com/en-us/windows/wsl/install-on-server) 为准。

发行平台为 `linux/amd64` 与 `linux/arm64`。安装脚本按 WSL 内核报告的架构选择归档，不允许跨架构模拟绕过门禁。

## 2. v0.3.0 运行形态

```text
WSL2
├── Sunabot Native Core
│   ├── Native Bash / MCP / Skill / Codex
│   └── Lightpanda Native renderer（Bubblewrap）
└── NapCat Docker × 已启用 QQ 账号
```

Core 固定 Native。NapCat 是唯一 Docker 例外；Bash、MCP、Skill、Codex 和 WebFetch 不创建容器。每个 QQ 账号对应一个 NapCat 容器、`workspace/runtime/napcat/accounts/<accountId>/` 目录和独立 WebUI 端口。

Native Core 监听宿主回环管理端口 `8787`，OneBot listener 使用专用 `8788`。WSL 内安装的 Docker Engine 会在当前发行版网络命名空间创建 bridge gateway，Launcher 只绑定该本机 gateway；Docker Desktop 在独立 `docker-desktop` 发行版维护 bridge gateway，Launcher 只绑定 `127.0.0.1`，NapCat 通过 `host.docker.internal` 和 WSL localhost forwarding 连接。两种路径都必须通过 NapCat 容器内 `/healthz` 探针并携带 access token，不能回退到 `0.0.0.0`、WSL `eth0` 或局域网地址。跨组件图片使用 `base64://`，不共享绝对文件路径。

Docker Desktop 官方将 `host.docker.internal` 定义为容器访问宿主服务的地址；WSL 官方文档确认 Linux 服务默认转发到 Windows `localhost`。相关边界见 [Docker Desktop networking](https://docs.docker.com/desktop/features/networking/networking-how-tos/#connect-a-container-to-a-service-on-the-host) 与 [WSL networking](https://learn.microsoft.com/en-us/windows/wsl/networking#accessing-linux-networking-apps-from-windows-localhost)。

## 3. 环境准备

管理员 PowerShell：

```powershell
wsl.exe --install -d Ubuntu-24.04
wsl.exe --update
wsl.exe -l -v
```

Ubuntu WSL2：

```bash
sudo apt update
sudo apt install -y ca-certificates curl tar
docker version
docker compose version
```

Docker Engine、Compose 插件和当前 WSL 用户的 Docker 访问权限必须在安装前就绪。不要用 root 运行安装、launcher 或迁移；安装用户必须拥有安装目录和 workspace。

Docker Desktop 用户需要为目标发行版启用 WSL Integration。WSL 内置 Docker Engine 用户不得同时启用 Docker Desktop integration；`docker context show`、`docker info` 与实际 daemon 必须指向同一实现。Launcher 根据运行网络 gateway 是否属于当前 WSL 网络命名空间选择安全监听方式，不依赖 daemon 名称或可伪造环境变量。

发行归档已经内置 Node `24.18.0`、生产 `node_modules`、Codex CLI `0.139.0`、Lightpanda `0.3.3`、对应源码与许可，以及锁定的 Bubblewrap。WSL 不需要另行安装 Node、npm、Codex、Lightpanda 或 Bubblewrap。

## 4. 新实例安装

```bash
curl -fsSL https://github.com/CatREFuse/sunabot/releases/latest/download/install.sh | bash
bash "$HOME/.local/share/sunabot/current/sunabot.sh" up
```

安装程序执行以下有界步骤：

1. 识别 `linux/amd64` 或 `linux/arm64`，下载对应 release 归档及 SHA-256。
2. 校验归档摘要、release manifest、内置 Node、Bubblewrap 和 Lightpanda。
3. 检查本机是否已有 component lock 指定的 NapCat image digest；缺失时只在安装阶段从上游准备该锁定镜像。
4. 在版本目录运行离线 `bootstrap`，然后原子切换 `current` 链接。

NapCat/QQ 不随 Sunabot release 重新分发。NapCat 的公开再分发授权尚未确认；安装程序使用上游镜像引用和固定摘要准备本机运行资产。

首次交互式 `up` 进入 CLI Landing，要求设置管理员名称、至少 12 字符的密码和密码确认；输入不回显。凭据派生结果写入共享 workspace 的 `secrets/admin-credentials.json`。缺少凭据时从无 TTY 的会话启动会明确失败，不接受明文密码命令行参数。

Landing 完成后，打开：

```text
管理台:       http://127.0.0.1:8787
首个 NapCat: http://127.0.0.1:6099/webui
```

NapCat WebUI 只作诊断入口。QQ 扫码、Agent 归属和账号操作使用 Sunabot 管理台。

## 5. 离线启动合同

安装完成后的以下命令不得访问软件仓库、npm registry、浏览器下载站或容器 registry：

```bash
bash "$HOME/.local/share/sunabot/current/sunabot.sh" up
bash "$HOME/.local/share/sunabot/current/sunabot.sh" start
bash "$HOME/.local/share/sunabot/current/sunabot.sh" restart
```

Launcher 对 NapCat 固定使用 `--pull never`。本机缺少锁定摘要镜像时返回 `NAPCAT_IMAGE_MISSING`，不能在启动流程补拉。`bootstrap` 在发行版中只校验和准备归档内资产，不执行依赖下载。

Linux/WSL 的 Native Bash、MCP 与 Skill Script 必须通过随包 Bubblewrap 的 capability probe。Lightpanda renderer 也在独立 Bubblewrap 边界内运行；缺失文件、namespace probe 失败、摘要或版本不匹配时对应能力明确不可用，不降级到普通宿主进程。

## 6. 迁移现有实例

### 6.1 确定升级路径

- 发现旧 `sunabot-qq-runtime` 容器或 `qq-runtime` service：执行 [旧单容器切换备忘录](./one-container-to-split-runtime.md)。
- 仍是单 Agent workspace：执行 [单 Agent 到多 Agent](./single-agent-to-multi-agent.md)。
- 版本早于 0.2.0：按 [老版本逐级升级](./upgrade-old-versions-to-current.md) 执行到 0.2.0。
- 0.2.0 workspace：执行 [0.2.0 到 0.3.0](./upgrade-0.2.0-to-0.3.0.md)，把双 Workbench 合并为 canonical `workbench/`。

新 launcher 不会把缺少迁移标记的旧 workspace 当成 fresh install。marker、双库、Agent/QQ 注册、路径或恢复点状态不一致时在业务写入前停止。

### 6.2 源实例停服与恢复点

由 workspace 所有者在源实例执行：

```bash
export SUNABOT_WORKSPACE=/absolute/path/to/workspace
./sunabot.sh down
./sunabot.sh status
npm run backup:create -- --workspace "$SUNABOT_WORKSPACE" --quiesced
```

确认 Native Core、account runtime daemon、当前 workspace 标签下全部 NapCat 容器和端口都已停止。Docker 状态不可读时停止迁移。备份 manifest 必须覆盖 Plana 和全部启用/停用 Agent 的业务库与 queue；注册缺库、单边数据库、孤儿库、符号链接或路径越界都属于阻断。

将完整 workspace 归档到访问受限的传输目录，同时记录源版本、revision 和归档 SHA-256。归档包含业务数据、凭据和 QQ 登录态，传输与保存权限必须等同于生产 secret；`node_modules`、`dist`、缓存、日志、PID 和临时文件不需要转移。

源实例在目标验收结束前保持停止，源机与目标机不能同时登录同一 QQ 或写入同一 workspace。

### 6.3 目标 WSL 恢复与升级

1. 使用 v0.3.0 安装程序准备自包含发行版和锁定 NapCat 镜像，不执行 `up`。
2. 将归档恢复到 WSL ext4 中由运行用户独占的 workspace，复验传输摘要和文件权限。
3. 复验源恢复点；按版本路径执行 dry-run、停服 apply 和迁移后验证。
4. 0.2→0.3 Workbench 迁移发现普通文件内容冲突、资源入口冲突或 SQLite 状态冲突时，资源和数据库保持零修改；解决冲突后重新 plan。
5. 成功迁移必须保留恢复点、报告和旧 `docker-workbench/` 归档。重复运行只验证既有结果，不再次覆盖目标。
6. 执行 `sunabot.sh up`、`status` 与 `doctor`，再完成真实账号验收。

目标代码版本、迁移报告或 manifest 与源记录不一致，恢复点复验失败，或者目标 workspace 出现未知文件时不能启动。

## 7. 账号与日常运行

```bash
SUNABOT="$HOME/.local/share/sunabot/current/sunabot.sh"
bash "$SUNABOT" up
bash "$SUNABOT" status
bash "$SUNABOT" doctor
```

Launcher 从 `agent_accounts` 读取已启用账号并逐个启动 NapCat。一个账号等待扫码不会共享其他账号的登录态。管理台新增、启停或移除账号后，宿主 account runtime daemon 只调和目标账号，不重启 Core 或其他 NapCat。

Windows 与 WSL localhost 转发异常时修复 WSL/Docker 集成。管理 listener、OneBot、NapCat WebUI 和 Lightpanda renderer 都不能为绕过转发问题改成公网监听。

## 8. 验收

| 检查 | 验收结果 |
| --- | --- |
| 安装 | amd64/arm64 选择正确，归档和 manifest 摘要通过，版本目录原子切换 |
| 运行所有权 | 同一 workspace 只有一个 Native Core；业务容器只有每账号 NapCat |
| 离线启动 | 断开外网或监控网络后 `up|restart` 无依赖下载、镜像拉取或构建 |
| Landing | fresh workspace 设置管理员名称与密码，中断可继续或显式回滚 |
| Agent 双库 | 全部业务库与 queue 在 manifest 中，`integrity_check=ok`，队列不变量一致 |
| 单一 Workbench | Native Bash、Codex、媒体、自拍、表情、知识与 Skill 只访问 canonical `workbench/` |
| Native 工具 | Bash/MCP/Skill/Lightpanda 的 Bubblewrap probe 通过，失败不降级 |
| WebFetch | 静态与 Lightpanda 动态页面均成功，健康结果为 `engine=lightpanda`，无 Chromium 依赖 |
| NapCat | 每个启用 QQ 有独立容器、目录、WebUI 端口和登录态 |
| OneBot | 专用 8788、token、`account_id` 路由和双 QQ 定向 action 通过 |
| 媒体与文件 | 图片使用 `base64://`，消息与数据库无跨组件绝对路径 |
| 灵魂文件 | WebUI 与 CLI 导出、预览、冲突导入和再次导出往返通过 |
| 重启恢复 | Native Core、outbox、全部 QQ 登录态和 OneBot 连接恢复 |
| 冷启动 | Windows 重启并启动 WSL/Docker 后，同一 `up` 恢复服务 |

当前开放验收固定为 Linux Native Core + 多 NapCat Docker 与 WSL2 Native Core + 多 NapCat Docker。单元测试、端口监听、容器 healthy 或受控 E2E 不能替代双环境、双 QQ 的真实私聊、群聊、引用、图片、文件、定向外发和冷启动证据。

## 9. 回滚

目标验收完成前保留源代码、原 workspace、离线归档、SQLite 恢复点和旧 Workbench 归档。目标失败时停止 Native Core 与全部 NapCat，保存失败现场，并按对应版本迁移文档恢复数据库和资源。恢复后再次核对 revision、manifest、文件摘要、SQLite 完整性和注册表，再选择目标或源实例重新上线。

任一时刻只能有一台机器连接同一 QQ 并写入对应业务数据。
