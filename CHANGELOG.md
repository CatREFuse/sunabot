# 更新日志

## [0.3.0] - 2026-08-12

### 原生运行

- Core、WebFetch、Bash、MCP 与 Skill Script 统一在宿主原生运行。
- 每个 Agent 只保留一个 Workbench，配置与资源使用同一份权威目录。
- NapCat 保持每个账号一个独立 Docker 容器，NapCat 与 QQ 不随 Sunabot 发行归档重分发。

### 网页与灵魂

- 动态 WebFetch 改用 Lightpanda 0.3.3，无需 Chrome 或 Chromium。
- 管理台支持灵魂文件导出、预览和冲突保护导入。
- 命令行支持灵魂文件导出、检查和导入。

### 安装与启动

- Linux amd64、Linux arm64 与 WSL2 发行包内置 Node.js、生产依赖、Codex CLI、Lightpanda 与 Bubblewrap。
- 安装脚本完成发行包校验、锁定 NapCat 镜像准备和原子版本切换；普通启动不再下载依赖。
- 首次启动在命令行设置管理员名称、密码与密码确认。

## [0.2.0] - 2026-07-29

### 动态渲染

- macOS Native Core 使用独立 Docker Renderer，Linux 与 WSL Native Core 使用 Bubblewrap Renderer。
- Docker Core 继续通过 Compose 私有网络访问独立 Renderer。
- Renderer 不可用时保留静态 WebFetch，并明确报告动态能力降级。

### 隔离与鉴权

- 宿主 Renderer 只监听回环地址，并使用每次启动重新生成的 bearer token。
- Renderer 不挂载 Agent workspace、数据库、Provider、Codex 或 OneBot 凭据。
- doctor 会验证 Renderer 运行环境与 Chromium sandbox，缺失时不会静默降级。

### 启动与升级

- Chromium 在首次依赖同步或 Playwright 升级时安装，普通启动和重启复用现有镜像或浏览器。
- 启动器监管 Native Renderer 的进程组、健康、日志、退出与残留回收。
- 0.1.4 可通过版本专用脚本创建恢复点并完成重启、状态和运行检查。

## [0.1.4] - 2026-07-28

### 图片参考

- 当前、引用和历史图片会在任务派发时下载并写入内容寻址媒体归档。
- 图片下载最多重试三次，队列只保存不可变摘要和归档引用。
- Provider 请求前核对参考图数量，必需图片解析失败会返回明确错误。

### 群聊稳定性

- 群聊编排器内部结果不会进入主回复模型的会话上下文。
- thread 分类器等待时间延长到 20 秒。

### 升级

- 0.1.3 可通过版本专用脚本创建恢复点并完成重启、状态和运行检查。
- 本次升级不修改 SQLite schema、系统提示词或资源目录。

## [0.1.3] - 2026-07-25

### 聊天媒体

- 当前消息和明确引用消息中的图片、文件会提供受控媒体句柄。
- `export_chat_media` 把原始媒体保存为当前 Agent Workbench 根目录下的 `chat-media-<sha256>.<ext>`，并返回相对路径、SHA-256、MIME、扩展名、宽高与字节数。
- Native Bash 直接使用返回路径，Docker Bash 通过 `native-workbench/<path>` 只读访问同一文件。

### 表情导入

- 当前 Agent 的管理员可在 QQ 私聊或群聊中使用 `import_chat_emoji`，把本轮图片导入同一表情库。
- 导入复用 8 MiB 图片门禁、1024×1024 PNG 规范化、哈希命名、内容去重和 `emojis.jsonl` 原子发布。
- 普通 QQ 用户没有表情库写入端口，Bash 也不能绕过专用导入流程直接修改清单。

### 安全与升级

- 工具参数不接受 URL、Base64、宿主路径、目标路径、账号或 Agent ID，只解析运行时绑定的本轮句柄。
- 导出会复核缓存文件身份、大小、摘要、MIME 与扩展名，拒绝符号链接、路径穿越、跨 Agent、过期回合和并发冲突。
- 从 `0.1.2` 升级时会停服创建全 Agent SQLite 恢复点，启动后保留式升级系统提示词并执行状态与运行检查。

## [0.1.2] - 2026-07-25

### 双工作区

- 自拍、表情、Skills 与知识库直接位于每个 Agent 的 Native `workbench/`。
- Docker Bash 使用独立可写 `docker-workbench/`，并通过 `native-workbench/` 只读访问同一份 Native 工作区内容。
- Native Bash 通过 `SUNABOT_DOCKER_WORKBENCH` 寻址当前 Agent 的 Docker 工作区。
- 两个 `index.md` 分别列出当前环境可用的自拍、表情、Skills 与知识库入口。

### 升级与恢复

- 版本升级到 `0.1.2`。
- 停服迁移会为全部 Agent 创建文件备份与校验清单，再迁移资源并补齐投影入口。
- 迁移支持幂等验证与防覆盖回滚，完成后自动执行状态和运行检查。

## [0.1.1] - 2026-07-25

Bot 工作台、资源管理入口与 JSONL 清单完成统一升级。

### 工作台

- Bot 可在授权范围内通过 Bash 访问并操作自己的 workbench。
- 工作目录、Skills、MCP、自拍、表情和知识库提供固定管理入口。
- 系统提示词会先引导 Bot 查询目录入口，再使用对应资源。

### 资源管理

- 自拍参考图改用同目录 `references.jsonl` 清单。
- 表情图片改用同目录 `emojis.jsonl` 清单，保留多版本记录。
- 知识库提供可重建的 `index.json`，管理台修改仍会同步到资源目录。

### 升级与恢复

- 提供 0.1.0 到 0.1.1 的预检、离线备份、迁移和重启脚本。
- 自拍清单迁移支持内容校验、冲突拒绝和独立回滚。
- 资源布局迁移支持全 Agent 清单、文件备份、校验和冲突保护回滚。
- 升级完成后自动执行运行状态与配置检查。

## [0.1.0] - 2026-07-22

首次发布，多 Agent、消息投递、记忆与管理台能力完成首个可用版本整合。

### 核心能力

- 支持多 Agent 与多 QQ 账号独立管理。
- 私聊、群聊、定时任务和 Web Chat 使用统一会话队列。
- 支持记忆、知识库、图像、表情和在线语音。

### 稳定性

- 消息进入持久投递队列，连接恢复后可继续发送。
- 模型过载采用有界重试，请求日志保留原始错误。
- 加强运行检查、配置修复和工具权限边界。

### 管理台

- 集中管理 Agent、账号、会话、提示词、设置、日志和扩展。
- 提示词编辑支持变量补全、搜索、折叠与冲突处理。
- 新增当前版本与更新日志页面。

[0.3.0]: https://github.com/CatREFuse/sunabot/releases/tag/v0.3.0
[0.2.0]: https://github.com/CatREFuse/sunabot/releases/tag/v0.2.0
[0.1.4]: https://github.com/CatREFuse/sunabot/releases/tag/v0.1.4
[0.1.3]: https://github.com/CatREFuse/sunabot/releases/tag/v0.1.3
[0.1.2]: https://github.com/CatREFuse/sunabot/releases/tag/v0.1.2
[0.1.1]: https://github.com/CatREFuse/sunabot/releases/tag/v0.1.1
[0.1.0]: https://github.com/CatREFuse/sunabot/releases/tag/v0.1.0
