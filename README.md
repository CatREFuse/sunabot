# sunabot

sunabot 是面向个人自托管场景的 QQ Agent 服务。NapCat 通过 OneBot v11 接入 Sunabot Core，提供私聊与群聊回复、长期记忆、文件理解、联网搜索、图像生成、异步任务和本地管理台。

## 功能

- QQ 私聊、群聊、@、引用回复、文件和图片消息
- 单会话顺序执行、持久化 outbox、断线恢复和异步任务回传
- 工作记忆、长期记忆、用户画像和 BM25 召回
- Plana 人格文件、结构化提示词和管理台热更新
- OpenAI Responses、Codex Responses、Gemini 与 Anthropic 兼容 Provider
- 联网搜索、图像生成、自拍、Codex 异步任务和管理员工作区工具
- 文本、代码、图片、PDF、DOCX、PPTX、XLSX 等附件解析
- 会话、记忆、请求日志、图片历史和任务队列的 SQLite 持久化
- Vue 管理台，支持桌面与移动端、浅色、深色和跟随系统主题
- 管理员会话鉴权、CSRF、Origin 校验、登录限流和远程入口熔断

## 平台部署

所有平台使用同一个入口：

```bash
./sunabot.sh up
```

NapCat 始终运行在独立 Docker 容器中。Sunabot Core 支持 Native 与 Docker 两种模式：

| 平台 | `auto` 默认模式 | 可选模式 |
| --- | --- | --- |
| macOS | Native Core + NapCat Docker | Docker Core + NapCat Docker（需 Docker VM 支持 user namespace） |
| Windows 11 / Windows Server WSL2 | Docker Core + NapCat Docker | Native Core + NapCat Docker |
| Linux x86_64 | Docker Core + NapCat Docker | Native Core + NapCat Docker |

Windows Native 不在支持范围内，请在 WSL2 终端执行脚本。

### 准备

安装 Git、Node.js `24.18.0`、Docker Engine 与 Docker Compose，并使用拥有仓库和 workspace 的非 root 用户执行脚本。macOS 和 Windows 11 可以使用 Docker Desktop；Windows Server 在 WSL2 发行版内安装 Docker Engine。当前 Docker Core 生产镜像目标为 `linux/amd64`。

```bash
git clone https://github.com/CatREFuse/sunabot.git
cd sunabot
./sunabot.sh up
```

首次启动会初始化 `workspace/`，并为 OneBot 与 NapCat WebUI 生成随机令牌。根据需要编辑 `workspace/secrets/runtime.env`：

```text
NAPCAT_ACCOUNT=你的QQ号
OPENAI_API_KEY=你的Provider密钥
```

也可以在管理台完成 Provider 配置。首次 QQ 登录未完成时，启动状态会显示 `awaiting-login`；访问 `http://127.0.0.1:6099/webui` 完成登录后，NapCat 会自动连接 Core。

本机入口：

```text
管理台:        http://127.0.0.1:8787
NapCat WebUI: http://127.0.0.1:6099/webui
```

### macOS

安装 LibreOffice，确保 Docker Desktop 已启动，再执行：

```bash
brew install --cask libreoffice
```

```bash
./sunabot.sh up
```

`auto` 使用 Native Core。快速开发模式会启动 API watch 与 Vite：

```bash
./sunabot.sh up --dev
```

开发管理台地址为 `http://127.0.0.1:5173`，API 仍为 `http://127.0.0.1:8787`。

生产式 Native 启动使用 `./sunabot.sh up`。需要验证完整容器部署且 Docker VM 支持 bubblewrap user namespace 时使用：

```bash
SUNABOT_CORE_MODE=docker ./sunabot.sh up
```

若 Docker VM 禁止嵌套 user namespace，启动器会在 bubblewrap probe 阶段停止并清理容器；macOS 开发使用默认 Native Core。

macOS Native Core 会安全关闭 `workspace_bash`，其他业务功能、SQLite 和 OneBot 消息格式与生产模式一致。

### Windows / WSL2

在 Ubuntu WSL2 的 Linux 文件系统中保存仓库和 workspace，例如 `~/sunabot` 或 `/srv/sunabot`，避免放入 `/mnt/c`。确保 Docker Desktop 已启用该发行版的 WSL Integration，或已在发行版内启动 Docker Engine。

```bash
./sunabot.sh up
```

`auto` 使用 Docker Core。需要在 WSL2 中直接运行 Core 时使用：

```bash
SUNABOT_CORE_MODE=native ./sunabot.sh up
```

### Linux

安装并启动 Docker Engine 与 Compose 插件后执行：

```bash
./sunabot.sh up
```

`auto` 使用 Docker Core。需要 Native Core 时，还需安装 runtime contract 要求的 Node.js、bubblewrap 和 LibreOffice：

```bash
SUNABOT_CORE_MODE=native ./sunabot.sh up
```

### 更新

`workspace/` 已被 Git 整体忽略，拉取代码不会覆盖 SQLite、配置、凭据或 NapCat 登录态。

```bash
git pull --ff-only
./sunabot.sh up
```

从旧单容器版本升级时，按 [单容器服务端迁移备忘录](docs/migrations/one-container-to-split-runtime.md) 执行，旧运行时与新运行时不能同时启动。

### 运行命令

```bash
./sunabot.sh up
./sunabot.sh down
./sunabot.sh restart
./sunabot.sh status
./sunabot.sh logs
./sunabot.sh doctor
```

运行模式可以通过 `SUNABOT_CORE_MODE=auto|native|docker` 或 `--core=auto|native|docker` 选择。Native Core 可使用 `--dev` 或 `SUNABOT_DEV=1` 启动开发服务。管理台始终只发布到宿主回环 `127.0.0.1:8787`；不要直接向局域网或公网公开管理端口、NapCat WebUI 或 OneBot 端口。
