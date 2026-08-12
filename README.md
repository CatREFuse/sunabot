# sunabot

sunabot 是面向个人自托管场景的多 Agent QQ 服务。每个 Agent 可以绑定多个 QQ 账号，并拥有独立的人格、记忆、会话、图片、工具配置和唯一 Workbench；Provider、系统提示词与管理安全由同一个 Sunabot Core 统一管理。

当前版本：`0.3.0` · [更新日志](CHANGELOG.md) · [GitHub Releases](https://github.com/CatREFuse/sunabot/releases)

## 功能

- QQ 私聊、群聊、@、引用回复、戳一戳、文件和图片消息
- 多 Agent、多 QQ，以及按 Agent 隔离的会话、记忆、媒体、任务与 Workbench
- 单会话顺序执行、按 QQ 隔离的 SQLite outbox、两阶段外发、断线恢复和异步任务回传
- 工作记忆、长期记忆、用户画像、场域知识、每日 Dream 和 BM25 召回
- OpenAI、Codex 订阅、Gemini、Anthropic 与兼容协议 Provider
- 联网搜索、静态与动态网页抓取、图像生成、自拍、Codex 任务和管理员 Workbench 工具
- PDF、DOCX、PPTX、XLSX、代码、文本和图片附件解析
- 灵魂文件导出、预览、冲突保护导入，支持管理台与命令行
- 桌面与移动端管理台，支持浅色、深色和跟随系统主题
- 管理员会话、CSRF、Origin 校验、登录限流和远程入口熔断

## 运行结构

| 组件 | 运行方式 | 数据边界 |
| --- | --- | --- |
| Sunabot Core | Native | 配置、Agent、SQLite、媒体、工具与管理 API |
| WebFetch | Core 内静态抓取；Linux/WSL 使用 Native Lightpanda 动态 Renderer | 无持久浏览器资料，不挂载 workspace 或 secrets |
| Bash、MCP、Skill Script | Native；Linux/WSL 使用 Bubblewrap 隔离 | 当前 Agent 唯一 Workbench 与受控扩展目录 |
| NapCat | 每个 QQ 一个独立 Docker 容器 | QQ 登录态、OneBot 配置、插件与缓存 |
| 管理台 | 由 Core 提供 | `http://127.0.0.1:8787` |

NapCat 是 v0.3.0 唯一的 Docker 运行组件。Core、Bash、MCP、Skill Script 与 WebFetch 不创建 Docker 容器。NapCat 通过带 access token 的 OneBot v11 反向 WebSocket 连接 Core；跨组件图片使用 `base64://` 传输，不依赖共享绝对路径。

每个 Agent 的资源与产物只使用：

```text
workspace/business/agents/<agentId>/workbench/
```

运行时和管理 API 不创建、读取或展示 `docker-workbench/`。该旧目录只作为 0.2.0 升级到 0.3.0 的停服迁移输入。

## 发行版安装

Linux x86_64、Linux arm64 与 WSL2 可以使用发行安装脚本：

```bash
curl -fsSL https://github.com/CatREFuse/sunabot/releases/latest/download/install.sh | bash
bash "$HOME/.local/share/sunabot/current/sunabot.sh" up
```

安装脚本下载对应架构的发行归档和 SHA-256，完成校验后原子切换版本，并在本机准备版本与摘要锁定的 NapCat 上游镜像。NapCat/QQ 的公开再分发授权尚未确认，因此不包含在 Sunabot 发行归档中。

发行归档内置：

- Node.js `24.18.0`
- 生产 `node_modules` 与 Codex CLI `0.139.0`
- Lightpanda `0.3.3` 二进制、许可证和对应源码
- Bubblewrap `0.8.0-2+deb12u1`
- Core、管理台、迁移工具、运行合同与文档

安装完成后的 `up|start|restart` 不执行 `npm install`、`npm ci`、浏览器安装或组件下载，并以 `pull never` 启动本机已有的锁定 NapCat 镜像。

默认安装位置为 `$XDG_DATA_HOME/sunabot`，未设置 `XDG_DATA_HOME` 时使用 `$HOME/.local/share/sunabot`。可以指定版本和绝对安装目录：

```bash
bash install.sh --version 0.3.0 --prefix /opt/sunabot
```

## 环境要求

发行版需要：

- Linux x86_64、Linux arm64，或 WSL2 中的 Linux
- Docker Engine 与 Docker Compose 插件，用于 NapCat
- `curl` 与 `tar`，只在安装阶段使用
- 拥有安装目录与 workspace 的非 root 用户

源码运行还需要 Node.js `24.18.0` 和 npm。macOS 支持源码形态的 Native Core + NapCat Docker；静态 WebFetch 可用，Lightpanda 动态 Renderer 在 macOS 明确报告 unavailable。

## 首次启动

首次执行 `up` 会进入命令行 Landing 流程，要求设置管理员名称、管理员密码和密码确认。密码至少 12 个字符，输入过程不回显；成功后继续初始化 workspace、OneBot token 和 NapCat WebUI token。

```bash
bash "$HOME/.local/share/sunabot/current/sunabot.sh" up
```

首次运行使用持久 journal。中断后再次执行同一命令会继续；需要放弃未完成的首次运行时执行：

```bash
bash "$HOME/.local/share/sunabot/current/sunabot.sh" rollback-first-run
```

服务启动后打开：

```text
管理台:        http://127.0.0.1:8787
首个 NapCat:  http://127.0.0.1:6099/webui
```

NapCat WebUI 用于故障诊断，日常 QQ 登录在管理台完成。

## 配置 Provider

打开 `http://127.0.0.1:8787/settings/providers`。

使用 Codex 订阅时，选择“Codex 订阅”，点击“开始登录”，完成设备授权后测试连接并保存。授权文件保存在当前 workspace 的 `secrets/codex/auth.json`。

使用 API Provider 时，把密钥写入 `workspace/secrets/runtime.env` 对应字段，再执行 `sunabot.sh restart`。随后在“模型服务”中启用目标 Provider、选择默认 Provider、拉取或填写模型、测试连接并保存。

## 登录 QQ

首次启动会创建 Plana 和“主账号”。打开 `http://127.0.0.1:8787/agents`，选择 Plana，在“QQ 账号”中点击“登录”并扫描二维码。管理员 QQ 默认为空；扫码完成后，在“Agent 设置 → 回复行为”中保存管理员 QQ。

每个账号拥有独立 NapCat 容器、运行目录和回环 WebUI 端口。首个账号从 `6099` 开始，运行目录为：

```text
workspace/runtime/napcat/accounts/<accountId>/
```

## 创建 Agent

在管理台的“Agent”页面点击“新增 Agent”，填写不可变的 Agent ID、名称和可选头像。新 Agent 会获得独立人格、配置、双 SQLite 数据库、媒体目录、唯一 Workbench 和 QQ 账号列表，并继承公共 Provider 与系统提示词。

## 灵魂文件

管理台“提示词”页面提供当前 Agent 的灵魂文件导出、导入预览与确认导入。灵魂文件扩展名为 `.sunabot-soul.json`，只包含 `scope=persona` 的人格提示词；不会包含 Agent 身份、管理员、Provider、密钥、QQ、NapCat、数据库、记忆或 Workbench。

命令行通过本机管理 API 使用同一预览、revision 冲突保护和原子导入合同：

```bash
./sunabot.sh soul export --agent plana --output plana.sunabot-soul.json
./sunabot.sh soul inspect --agent arona --input plana.sunabot-soul.json
./sunabot.sh soul import --agent arona --input plana.sunabot-soul.json
```

CLI 在交互终端读取管理员名称和密码，不接受明文密码参数。非交互确认需要显式增加 `--yes`。

## 运行命令

```bash
./sunabot.sh up
./sunabot.sh start
./sunabot.sh down
./sunabot.sh restart
./sunabot.sh status
./sunabot.sh logs
./sunabot.sh doctor
./sunabot.sh bootstrap
./sunabot.sh rollback-first-run
./sunabot.sh soul --help
./sunabot.sh --help
```

`status`、`doctor`、`logs` 和 `down` 保持只读且不安装依赖。发行版的 `bootstrap` 只验证随包运行时、生产依赖与组件完整性；源码形态可以按锁文件准备开发依赖。`SUNABOT_CORE_MODE` 与 `--core` 已移除，传入时会返回明确错误。

macOS 源码开发模式可以启动 API watch 与 Vite：

```bash
./sunabot.sh up --dev
```

## 更新与迁移

发行版更新重新运行安装脚本；版本目录原子切换，持久 workspace 保持在安装前缀下的共享目录。

源码更新：

```bash
git pull --ff-only
./sunabot.sh up
```

从 0.2.0 升级到 0.3.0 时，停服运行单 Workbench 迁移：

```bash
./sunabot.sh upgrade-0.3.0 plan --workspace /absolute/path/to/workspace
./sunabot.sh upgrade-0.3.0 apply --quiesced --workspace /absolute/path/to/workspace
```

迁移只合并目标缺失或字节完全相同的普通文件；冲突时资源和 SQLite 保持零修改。完整验证、恢复点和 rollback 见 [0.2.0 升级到 0.3.0](docs/migrations/upgrade-0.2.0-to-0.3.0.md)。更早版本按 [老版本逐级升级](docs/migrations/upgrade-old-versions-to-current.md) 执行。

## 端口与安全

| 端口 | 用途 | 暴露范围 |
| --- | --- | --- |
| `8787` | 管理台与管理 API | 宿主回环 |
| `8788` | OneBot v11 | 同机 NapCat 网络到宿主网关 |
| `6099+` | 各 QQ 的 NapCat WebUI | 宿主回环 |
| `8790` | Linux/WSL Native Lightpanda Renderer | 宿主回环 |

不得把管理台、NapCat WebUI、OneBot 或 Renderer 端口直接发布到局域网或公网。远程访问管理台时使用 HTTPS 反向代理，并配置精确的 `SUNABOT_ADMIN_ORIGINS`。

凭据、QQ 登录态、SQLite、请求日志、生成图片和备份都保存在 `workspace/`，不得提交到 Git。运行与迁移命令不得使用 root。

## 验证

```bash
npm run verify
npm run test:visual
./sunabot.sh doctor
./sunabot.sh status
```

发布前还需要在真实 Linux Native Core + 多 NapCat Docker 与 WSL2 Native Core + 多 NapCat Docker 环境完成 amd64/arm64 安装、双 QQ 登录、账号定向文字/图片/文件外发、动态 WebFetch、灵魂文件往返、首次 Landing、启动零下载和重启恢复验收。
