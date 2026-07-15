# sunabot

sunabot 是面向个人自托管场景的多 Agent QQ 服务。每个 Agent 可以绑定多个 QQ 账号，并拥有独立的人格、记忆、会话、图片和工具配置；Provider、系统提示词与管理安全由同一个 Sunabot Core 统一管理。

## 功能

- QQ 私聊、群聊、@、引用回复、戳一戳、文件和图片消息
- 多 Agent、多 QQ，以及按 Agent 隔离的会话、记忆、图片和任务
- 单会话顺序执行、按 QQ 隔离的 SQLite outbox、两阶段外发、断线恢复和异步任务回传
- 工作记忆、长期记忆、用户画像和 BM25 召回
- OpenAI、Codex 订阅、Gemini、Anthropic 与 OpenAI 兼容 Provider
- 联网搜索、图像生成、自拍、Codex 任务和管理员工作区工具
- PDF、DOCX、PPTX、XLSX、代码、文本和图片附件解析
- 桌面与移动端管理台，支持浅色、深色和跟随系统主题
- 管理员会话、CSRF、Origin 校验、登录限流和远程入口熔断

## 运行结构

| 组件 | 运行方式 | 数据边界 |
| --- | --- | --- |
| Sunabot Core | macOS 默认 Native；WSL2/Linux 默认 Docker | 配置、Agent、SQLite、媒体与管理 API |
| NapCat | 每个 QQ 一个独立 Docker 容器 | QQ 登录态、OneBot 配置、插件与缓存 |
| 管理台 | 由 Core 提供 | `http://127.0.0.1:8787` |

NapCat 通过带 access token 的 OneBot v11 反向 WebSocket 连接 Core。Core 与 NapCat 之间的图片使用 `base64://` 传输，不依赖共享绝对路径。

所有平台使用同一个运行入口：

```bash
./sunabot.sh up
```

| 平台 | `auto` 模式 | 支持范围 |
| --- | --- | --- |
| macOS | Native Core + NapCat Docker | Intel 与 Apple Silicon；`workspace_bash` 安全关闭 |
| Windows 11 / Windows Server | WSL2 Docker Core + NapCat Docker | 在 Ubuntu WSL2 终端运行，Windows Native 不受支持 |
| Linux x86_64 | Docker Core + NapCat Docker | 可切换 Linux Native Core |

当前 Docker Core 交付目标是 `linux/amd64`。

## 环境要求

所有模式需要：

- Node.js `24.18.0`
- Docker Engine 与 Docker Compose 插件，或 Docker Desktop
- 拥有仓库与 workspace 的非 root 用户

源码安装和后续 `git pull` 需要 Git。解压后的 Linux 发行包不包含 `.git`，运行与迁移不需要 Git。

Native Core 还需要：

- LibreOffice
- Codex CLI `0.139.0`
- Linux/WSL2 Native Core：`bubblewrap`

Codex CLI 可以通过 npm 安装：

```bash
npm install -g @openai/codex@0.139.0
```

macOS 可安装 Docker Desktop 与 LibreOffice：

```bash
brew install --cask docker libreoffice
```

Ubuntu WSL2 或 Linux Native Core 可安装宿主依赖：

```bash
sudo apt update
sudo apt install -y ca-certificates git build-essential python3 libreoffice fonts-noto-cjk bubblewrap
```

WSL2 默认使用 Docker Core，镜像已经包含 LibreOffice、Codex CLI、字体与 bubblewrap。Windows 11 可使用 Docker Desktop WSL2 后端；Windows Server 需要在 WSL2 发行版内安装 Docker Engine 与 Compose 插件。

## 首次启动

```bash
git clone https://github.com/CatREFuse/sunabot.git
cd sunabot
./sunabot.sh up
```

启动脚本会校验 Node 版本、按需执行 `npm ci`、初始化 `workspace/`、生成 OneBot 与 NapCat WebUI 令牌，并在当前终端要求设置管理员账号密码。密码至少 12 个字符。

首次运行会在每个持久化边界记录可校验 journal。中断后再次执行 `./sunabot.sh up` 会继续；需要放弃未完成的首次运行时执行 `./sunabot.sh rollback-first-run`，未知文件会保留。

如果 `up` 将在无 TTY 环境运行，请在有 TTY 的终端提前创建管理员凭据：

```bash
npm run workspace:init
npm run admin:set-password -- admin
./sunabot.sh up
```

服务启动后打开：

```text
管理台:        http://127.0.0.1:8787
首个 NapCat:  http://127.0.0.1:6099/webui
```

NapCat WebUI 用于故障诊断，日常 QQ 登录在管理台完成。

## 配置 Provider

打开 `http://127.0.0.1:8787/settings/providers`。

使用 Codex 订阅时，选择“Codex 订阅”，点击“开始登录”，在 OpenAI 设备授权页面输入管理台显示的授权码；登录完成后测试连接并保存。授权文件保存在当前 workspace 的 `secrets/codex/auth.json`。

使用 API Provider 时，把密钥写入 `workspace/secrets/runtime.env` 对应字段，例如：

```text
OPENAI_API_KEY=
GEMINI_API_KEY=
ANTHROPIC_API_KEY=
```

修改环境变量后执行 `./sunabot.sh restart`，随后在“模型服务”中启用目标 Provider、选择默认 Provider、拉取或填写模型、测试连接并保存。仅填写 API Key 不会自动切换默认 Provider。

## 登录 QQ

首次启动会创建 Plana 和“主账号”。打开 `http://127.0.0.1:8787/agents`，选择 Plana，在“QQ 账号”中点击“登录”并扫描二维码。管理台会持续刷新登录状态。主账号可以退出 QQ 登录，不能移除；其他离线账号可以移除。

管理员 QQ 默认为空。QQ 登录完成后，在“Agent 设置 → 回复行为”填写管理员 QQ；管理员工作区工具只接受该 QQ 的指令。

每个 Agent 可以添加多个 QQ：

1. 在 Agent 页面点击“新增 QQ”并填写账号名称。
2. 等待账号状态进入扫码态。
3. 点击“登录”并扫码。

宿主账号调和进程会按注册表启动、停止或移除目标 NapCat；Docker Core 不挂载 Docker socket。管理台会显示期望状态、实际状态、是否仍需调和和最近错误。注册库不可读时不会停止或删除现有容器。

每个账号使用独立 WebUI 端口，首个账号从 `6099` 开始。账号运行目录位于：

```text
workspace/runtime/napcat/accounts/<accountId>/
```

## 创建 Agent

在管理台的“Agent”页面点击“新增 Agent”，填写不可变的 Agent ID、名称和可选头像。新 Agent 会获得独立的人格文件、配置、双 SQLite 数据库、媒体目录和 QQ 账号列表，并继承公共 Provider 与系统提示词。

创建完成后添加 QQ、完成扫码，再进入“Agent 设置”配置管理员 QQ、回复行为、记忆、工具和群聊编排。

## 运行命令

```bash
./sunabot.sh up
./sunabot.sh down
./sunabot.sh restart
./sunabot.sh status
./sunabot.sh logs
./sunabot.sh doctor
./sunabot.sh bootstrap
./sunabot.sh rollback-first-run
./sunabot.sh --help
```

`status`、`doctor`、`logs` 和 `down` 不安装依赖。`bootstrap` 显式安装锁定依赖；`up` 与 `restart` 在需要时执行安装。`status`、`doctor` 与管理 API 共用同一只读探针，分别报告 Core、OneBot、每个 QQ、Provider、Codex、LibreOffice、bubblewrap、workspace 和迁移状态。Provider 状态区分“已验证可用”“当前不可用”和“未配置”。

Core 模式可以通过环境变量或参数选择：

```bash
SUNABOT_CORE_MODE=native ./sunabot.sh up
SUNABOT_CORE_MODE=docker ./sunabot.sh up
./sunabot.sh up --core=native
./sunabot.sh up --core=docker
```

macOS 开发模式会启动 API watch 与 Vite：

```bash
./sunabot.sh up --dev
```

开发管理台位于 `http://127.0.0.1:5173`，API 继续使用 `127.0.0.1:8787`。

## 更新与迁移

常规更新：

```bash
git pull --ff-only
./sunabot.sh up
```

`workspace/` 整体不进入 Git，更新代码不会覆盖配置、数据库、凭据、媒体或 QQ 登录态。

遇到以下旧实例时，必须停服并完成对应迁移，再启动当前版本：

- 旧 `sunabot-qq-runtime` 容器或 `qq-runtime` Compose service：[单容器到分离运行时](docs/migrations/one-container-to-split-runtime.md)
- 旧单 Agent workspace：[单 Agent 到多 Agent](docs/migrations/single-agent-to-multi-agent.md)
- Windows/WSL2 迁移：[WSL2 部署与迁移](docs/migrations/wsl2-migration-plan.md)

launcher 会在写入 workspace 前校验 `business/migrations/multi-agent-v1.json`。真正空目录会自动创建首次安装标记；主库出现后，门禁会核对全部 Agent 的 manifest 与双库、全部 QQ 的归属与运行目录、Plana/primary 基线，以及所有必需路径。完成标记还绑定迁移目标的 workspace 和 primary 端口。既有目录缺少标记、状态漂移或路径含符号链接时停止启动；结构已就绪但未标记的 workspace 仍需停服执行 `migrate:multi-agent --apply --quiesced`，由迁移器在确认全部账号端口和当前 workspace 的活动容器已经停止后创建恢复点、四类复制/保留证据、迁移报告和完成标记。

workspace、恢复点与恢复目标的绝对路径会逐级检查父目录；用户创建的符号链接路径会在任何 marker、配置、凭据、SQLite 或注册表写入前拒绝。迁移与恢复先持久化 journal intent，中断后可继续或回滚；未知替换不会被自动删除。

备份、验证、恢复和演练命令见 [SQLite 备份与恢复](docs/operations/sqlite-backup-recovery.md)。运行中的旧实例与新实例不能同时连接同一 QQ 或写入同一个 workspace。

## 端口与安全

| 端口 | 用途 | 暴露范围 |
| --- | --- | --- |
| `8787` | 管理台与管理 API | 宿主回环 |
| `8788` | OneBot v11 | Compose 私有网络或同机容器到宿主网关 |
| `6099+` | 各 QQ 的 NapCat WebUI | 宿主回环 |

不要把管理台、NapCat WebUI 或 OneBot 端口直接发布到局域网或公网。远程访问管理台时使用 HTTPS 反向代理，并在 `workspace/secrets/runtime.env` 中配置精确的 `SUNABOT_ADMIN_ORIGINS`。

凭据、QQ 登录态、SQLite、请求日志、生成图片和备份都保存在 `workspace/`，不得提交到 Git。运行与迁移命令不得使用 root。

## 验证

```bash
npm run verify
npm run test:visual
./sunabot.sh doctor
./sunabot.sh status
```

界面截图需要人工检查。运行契约、架构门禁、恢复门禁、类型检查、单元与集成测试、运行时 smoke、容量基线、生产构建和 E2E 都包含在 `npm run verify` 中。

跨平台发布前还需要在真实 macOS Native Core + 多 NapCat Docker 与 Linux/WSL Docker Core + 多 NapCat Docker 环境完成双 QQ 登录、账号定向文字/图片/文件外发和重启恢复。
