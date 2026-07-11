# sunabot

sunabot 是一个面向个人自托管场景的 QQ Agent 服务：NapCat 通过 OneBot v11 反向 WebSocket 接入 Node.js 后端，后端负责会话编排、长期记忆、文件理解、联网搜索、图像生成、Codex 异步任务和 Vue 管理台。

## OneBot 与 NapCat 运行体系

OneBot 与 NapCat 被固定为一个本机 QQ Runtime。OneBot 是 Sunabot 内部协议，不是独立服务；NapCat 主动通过回环地址连接 Sunabot，消息事件、回复 action 和 action 回包共用这条连接。生成图片只通过共享文件系统传递本地绝对路径。

```text
QQ ↔ NapCat ── OneBot v11 reverse WebSocket ── Sunabot
                                                    ├── Provider / tools
                                                    ├── session queue / outbox
                                                    └── shared workspace files
```

固定通信契约：

```text
WebSocket:      ws://127.0.0.1:8787/onebot/v11/ws
共享目录:       /srv/sunabot/workspace
图片传输:       /srv/sunabot/workspace/business/media/images/<file>.png
```

Docker 下 Sunabot 与 NapCat 是同一容器内的两个受监督进程，只挂载一个 workspace；非 Docker 下二者必须运行在同一 Linux/WSL 环境。两种运行方式使用完全相同的地址和文件路径。不支持远程 NapCat、公开 OneBot 端口、`host.docker.internal` 或 HTTP 图片回调。

NapCat 依赖定义位于 [`components/napcat/`](components/napcat/README.md)，Docker 入口位于 [`deploy/docker/`](deploy/docker/README.md)。完整配置见 [NapCat 与 OneBot 配置](docs/setup-napcat.md)。

## 代码与数据边界

仓库只托管可审阅、可协作的业务代码、测试和文档。所有终端相关内容都位于 `workspace/`，并被 Git 整体忽略：

```text
sunabot/
├── src/                       后端业务逻辑
├── apps/admin-web/            Vue 管理台
├── tests/                     单元、集成和端到端测试
├── components/napcat/        NapCat 外部依赖组件
├── deploy/                   Native 与 Docker 运行入口
├── tooling/                  Codex、开发、迁移与 workspace 脚手架
├── config/env.example         环境变量模板
└── workspace/                 本机用户数据，不进入 Git
    ├── business/              配置、Agent、SQLite 与持久媒体
    ├── runtime/               NapCat 登录态、日志与临时运行状态
    ├── secrets/               令牌、管理员密码哈希与 Codex 授权
    ├── cache/                 可重建附件缓存
    └── backups/               业务备份
```

`git pull`、切换分支和重新克隆只改变业务代码，不覆盖 `workspace/`。运行中的 SQLite/WAL 不应直接放入普通云盘；本项目提供 checkpoint 后的 AES-256-GCM 加密快照同步。

## 依赖

- Node.js 24.18.0（由 `.node-version`、`.nvmrc` 和 runtime contract 固定）
- npm
- Docker Engine 与 Compose 插件（推荐生产运行方式）
- LibreOffice（读取 Office 文档）
- Chromium（仅端到端/视觉测试需要，可由 Playwright 安装）
- Windows 推荐 WSL2；生产数据优先位于 WSL ext4

## Docker 开箱启动

首次终端：

```bash
git clone https://github.com/CatREFuse/sunabot.git
cd sunabot
npm ci
npm run workspace:init
nano workspace/secrets/runtime.env
npm run admin:set-password -- admin
npm run qq:configure
npm run qq:up
```

至少在 `workspace/secrets/runtime.env` 设置 `NAPCAT_ACCOUNT` 与 `ONEBOT_ACCESS_TOKEN`。`qq:up` 会构建单一 QQ Runtime 镜像并启动一个 Compose service；查看日志使用 `npm run qq:logs`，停止使用 `npm run qq:down`。

默认管理台和内部 OneBot 地址为：

```text
http://127.0.0.1:8787
ws://127.0.0.1:8787/onebot/v11/ws
```

外网发布必须先配置 `SUNABOT_ADMIN_ORIGINS=https://你的域名`，只允许 HTTPS 反向代理访问，不直接公开 8787 或 6099。

## 非 Docker 启动

Sunabot 与 NapCat 必须安装在同一 Linux/WSL 环境，并共同访问 `/srv/sunabot/workspace`。先运行 `npm run qq:configure -- /path/to/napcat/config` 写入本机反向 WebSocket 配置，再分别由同一个 systemd 用户会话启动 NapCat 和 Sunabot。不得把 NapCat 或 OneBot 迁到另一台服务器。

## ChatGPT 订阅登录

安装官方 Codex CLI 后，可在服务器终端运行 `codex login --device-auth`，或在管理台的 Provider 页面点击“重新登录”。设备授权码会显示在管理台，但令牌只写入 `workspace/secrets/codex/auth.json`，不会发送到浏览器或进入 Git。多终端应分别授权，不要通过公共仓库分发 `auth.json`。

如果 `codex` 不在服务进程的 `PATH` 中，请在 `workspace/secrets/runtime.env` 设置 `SUNABOT_CODEX_EXECUTABLE` 为其绝对路径。

WSL 中如果 Windows 侧 Clash 使用默认 HTTP 代理端口 `7890`，systemd 可将 `ExecStart` 指向 `deploy/native/bin/start-sunabot.sh`；脚本会动态识别 Windows 网关并为 Node `fetch` 启用环境代理。其他端口可通过 unit 的 `SUNABOT_WINDOWS_PROXY_PORT` 指定，完全禁用则设置 `SUNABOT_WINDOWS_PROXY_MODE=off`。

## API Provider

Provider 页面提供 Google Gemini 和 Anthropic Claude 的 OpenAI 兼容预设。预设分别使用 Gemini 官方兼容端点 `https://generativelanguage.googleapis.com/v1beta/openai/` 与 Anthropic 官方端点 `https://api.anthropic.com/v1/`；密钥只需写入 `workspace/secrets/runtime.env` 的 `GEMINI_API_KEY` 或 `ANTHROPIC_API_KEY`。参考：[Gemini OpenAI compatibility](https://ai.google.dev/gemini-api/docs/openai)、[Anthropic OpenAI SDK compatibility](https://platform.claude.com/docs/en/api/openai-sdk)。

这两种兼容 Provider 当前用于 Chat Completions；图像生成请单独选择 OpenAI Responses 或 Codex Provider。
Anthropic 官方将兼容层定位为快速测试与比较方案；长期生产使用若需要完整 Claude 特性，应改用其原生 Messages API。

## Bark 与服务监控

在管理台 OneBot 设置页填写 Bark URL。该地址只保存到被忽略的 `workspace/secrets/runtime.env`，读取 API 只返回“是否已配置”，不会回显地址。通知按配置窗口聚合，同一窗口内同类事件合并为一条：

- OneBot 事件依据反向 WebSocket 的连接、断开和事件心跳判断，不再扫描 NapCat kickoff 日志。
- 服务器启动、停止和未处理异常使用独立的 Bark 通知组。
- 可分别关闭 OneBot 事件或服务器事件，并可从管理台发送测试通知。

## 交给 coding agent 启动

推荐使用 [ChatGPT Codex](https://developers.openai.com/codex/) 打开项目文件夹，让它按照 `AGENTS.md` 和本 README 完成初始化、验证与启动。

## 更新业务代码

普通更新：

```bash
git status
git pull --ff-only
npm ci
npm run build
```

也可以使用安全更新命令：

```bash
npm run code:update
```

该命令要求 tracked worktree 无修改，使用 `git pull --ff-only`，仅在锁文件变化时重新安装依赖，随后构建。它不会修改 `workspace/`。涉及数据库 schema 的版本仍需按发布说明运行迁移命令。

## 新终端恢复 workspace

方案一是在新终端执行 `npm run workspace:init`，得到空白 workspace 后自行配置。

方案二是从加密云盘快照恢复：

```bash
npm run workspace:sync -- pull \
  --sync-dir "/path/to/BaiduSyncdisk/sunabot-workspace-sync" \
  --key-file "/separate/secure/location/sunabot-sync.key"
```

恢复命令只接受空目标目录，且在解包前审计归档路径。同步密钥不能放进百度同步盘；丢失密钥将无法恢复快照。

## 百度同步盘加密备份

首次创建独立密钥：

```bash
npm run workspace:sync -- init-key --key-file "/separate/secure/location/sunabot-sync.key"
```

在 `workspace/secrets/runtime.env` 设置 `SUNABOT_SYNC_DIR` 与 `SUNABOT_SYNC_KEY_FILE` 后执行：

```bash
npm run workspace:sync -- push
```

默认命令会先 checkpoint 业务 SQLite，只打包 `workspace/business`，并向同步盘写入经过认证加密的快照及 SHA-256 清单。NapCat 登录态使用 `--tier runtime` 单独快照；秘密使用 `--tier secrets` 和独立的 `SUNABOT_SECRETS_SYNC_KEY_FILE`，不能与业务快照共用密钥。`cache`、日志和临时文件永不进入快照。

Windows + WSL 终端应使用 `tooling/workspace/sync-workspace-wsl.ps1` 创建定时任务，确保备份的是 `/srv/sunabot/workspace` 中的实际运行数据，而不是 Windows 侧的空白副本。

## 管理台安全与熔断

- 密码使用 scrypt 哈希，明文不落盘。
- 浏览器只持有 `HttpOnly; SameSite=Strict` 会话 Cookie，不使用 localStorage/sessionStorage 保存凭据。
- 写请求必须通过 CSRF 和 Origin 白名单校验。
- 单来源连续失败会锁定 30 分钟；全局异常登录触发 15 分钟自动熔断。
- 紧急关闭远程管理入口：`npm run admin:fuse -- trip incident`
- 本机确认安全后解除：`npm run admin:fuse -- reset`
- WebUI 中的紧急熔断只关闭远程管理面，不停止 QQ 业务运行。

详细部署和安全边界见 [管理员访问安全](docs/security/admin-access.md) 与 [分布式终端和 workspace](docs/deployment/distributed-workspace.md)。

## 验证

```bash
npm run check
npm test
npm run build
npx playwright install chromium
npm run test:e2e
npm run test:visual
```

不要把 `.env`、SQLite、NapCat 登录态、请求日志、图片、附件缓存或云盘同步密钥提交到 GitHub。
