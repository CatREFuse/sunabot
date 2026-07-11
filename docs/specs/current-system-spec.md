# sunabot 当前系统规范

版本：2026-07-11
状态：当前实现的唯一规范
适用范围：sunabot 后端、Plana Agent、OneBot 接入、管理台、持久化、测试和部署

## 1. 产品范围

sunabot 是面向个人自托管场景的 QQ Agent 服务。系统通过 OneBot v11 反向 WebSocket 接入 NapCat，以普拉娜人格处理私聊和用户群聊，支持上下文回复、群聊编排、长期记忆、用户画像、文件读取、联网搜索、图像生成、自拍、Codex 异步任务和本地管理台。

当前运行目标是单实例、单管理员、单默认 Agent。多 Agent、多租户、完整 OneBot v12 和公网多用户管理台不属于当前版本。

## 2. 运行结构

```text
QQ Runtime（单机内聚组件）
QQ / NapCat ── 127.0.0.1 OneBot v11 reverse WebSocket ── OneBotGateway
                                                               │
                                                               ▼
                SunaRuntime ── SessionCoordinator ── provider / tools
                       │                 │
                       │                 └── session-queue.sqlite
                       ▼
              sunabot.sqlite
              会话、消息、记忆、调度、日志、图片历史

NapCat ── /srv/sunabot/workspace/business/media/images ── Sunabot

Browser ── Fastify Admin API ── Vue 管理台
```

QQ Runtime 不支持远程 OneBot 或远程 NapCat。Docker 下 Compose 只有一个 service 和一个容器，容器内由监督器运行 Sunabot 与 NapCat/QQ 两个进程；非 Docker 下二者运行在同一 Linux/WSL 环境。两种方式的 OneBot、NapCat 与本机健康通信固定使用 `127.0.0.1` 和 `/srv/sunabot/workspace`，不使用容器 DNS、宿主机网关或局域网地址。

Provider、Codex CLI 与联网工具的出站 HTTP(S) 可独立使用代理。API 在载入 composition root 前由 `packages/platform/proxy.mjs` 解析并安装 Undici dispatcher，优先级为 `SUNABOT_PROXY_URL`、标准 `HTTP_PROXY`/`HTTPS_PROXY`、WSL 默认网关与配置端口探测。`SUNABOT_PROXY_MODE` 支持 `auto`、`env`、`wsl-host` 和 `off`；网关只从当前默认路由动态发现，不写死地址。Native、Docker 和 `qq-compose` 使用 `deploy/runtime-contract.json` 中的同一代理契约。`NO_PROXY` 必须包含 `localhost`、`127.0.0.1` 和 IPv6 回环，代理 URL 与凭据不得进入日志、状态接口或 Git。

后端固定使用 Node.js 24.18.0、TypeScript 和 Fastify，管理台由 Vue 3、Vue Router 和 Vite 构建。`.node-version`、`.nvmrc`、package/lock、CI、Native release manifest、runtime contract、component lock 和 Docker 必须保持同一 Node 版本；`npm run runtime:contract` 静态拒绝入口漂移，但不比较开发机当前进程。CI、Linux/WSL Native 构建/安装/启动与 Docker 构建/运行会执行实际版本检查。生产服务由 `dist/apps/api/main.js` 启动，并提供 API、Web 静态资源、深链接回退、生成图片和 OneBot WebSocket 入口。

## 3. 消息接入与回复

### 3.1 OneBot 接入

- 仅接收配置路径上的 OneBot v11 反向 WebSocket。
- NapCat 只能通过同一 QQ Runtime 的回环地址连接，不支持公开或远程 OneBot 入口。
- 连接使用环境变量指定的 access token 校验。
- 支持私聊、用户群聊和 bot 群聊范围识别。
- 支持文本、CQ 码、图片、回复引用、@、QQ 文件和 OneBot action 回包。
- 好友名、备注、群名和群名片用于显示层补全，不改变 QQ 号这一身份主键。
- 私聊、用户群聊、bot 群聊和命令接受具有合法 QQ 号的发送者；管理员身份仍由 `bot.adminQq` 精确识别，并用于管理员专属工具和称呼。非法发送者在进入会话记录和命令匹配前静默丢弃，恢复任务与 outbox 外发前必须再次校验发送者格式和当前回复门控。

### 3.2 路由

每条消息按以下优先级进入运行时：

1. 显式命令，例如群聊总结。
2. 私聊或明确 @ 的直接回复。
3. 用户群聊的唤醒词与编排器判断。
4. bot 群聊仅记录上下文，不主动编排。

全局开关、群类型开关、会话开关、连接状态和编排器 epoch 共同构成回复门控。门控关闭后，旧的在途编排结果不能继续外发。

### 3.3 会话执行

- 每个会话拥有有序事件流，事件、turn、异步工具任务和 outbox 使用 SQLite 持久化。
- 同一会话按序处理；不同会话允许受控并发。
- 外发使用 outbox，支持租约、有限重试、断线恢复和幂等键。
- Codex 长任务先返回确认消息，任务完成后通过持久化事件恢复原会话。
- 会话最多保留 2,000 条消息，最多保留最近 80 个会话。

## 4. Provider、提示词与工具

### 4.1 Provider

支持 OpenAI Responses 和 Codex Responses。Provider 配置包含模型、图像模型、base URL、API key 环境变量、推理强度、温度和输出 token 上限。模型请求、响应、重试和工具结果写入请求日志，密钥和授权字段必须脱敏。

Provider 请求使用应用启动时安装的统一出站 dispatcher。显式代理和标准代理环境变量从 `workspace/secrets/runtime.env` 或进程环境读取；WSL 自动模式仅在没有显式代理时探测当前默认网关。代理选择不改变 OneBot 回环链路。

### 4.2 最终提示词

最终提示词使用 JSON 文档，支持：

- 多条 system、user、assistant 消息；
- 变量槽位；
- function tools；
- JSON Schema response format；
- 管理台编辑、结构校验、冲突检测和运行时热更新；
- 运行时默认值与 Agent 工作区文件一致性测试。

人格正文保存在 `AGENTS.md`、`SOUL.md`、`PREFERENCE.md`、`USER.md` 和 `RELATION.md`。提示词和人格是小型、可审阅配置文件，不进入 SQLite。

### 4.3 工具

当前工具包括 `memory_recall`、`websearch`、`generate_img`、`selfie`、`workspace_bash` 和 Codex 异步工具。工具启用状态、权限、超时和并发由配置控制。`workspace_bash` 仅供管理员使用，Docker 与 Native 均固定通过 `/usr/bin/bwrap` 执行：宿主文件系统只读，Agent workspace 是唯一可写宿主绑定，沙箱自带的 `/dev` 仅提供非持久设备 I/O；子进程继承相同 mount/PID/IPC/UTS/cgroup 隔离且全部 capability 被丢弃。命令与路径规则只作为附加拒绝层；bubblewrap 缺失、不可执行或内核 namespace probe 失败时必须拒绝命令，不能回退到普通 Bash。群聊默认不可用。

## 5. 记忆系统

### 5.1 数据边界

| 来源 | 内容 | 主键和更新方式 |
| --- | --- | --- |
| 工作记忆 | 近期动作、变化、决定、进展、结果和待跟进事件 | 稳定 ID；完整集合替换；快照冲突保护 |
| 长期记忆 | 对未来回复仍有价值的已发生或进行中事件 | event key 与 fingerprint 合并；保留来源工作记忆 ID |
| 用户画像 | 身份、能力、资源、偏好、习惯、边界、长期目标和明确称呼 | QQ 号聚合；管理员称呼由配置强制 |

一次性事件不能写入用户画像。人物属性不能写入长期记忆。工作记忆压缩、长期记忆晋升和用户画像更新在一个 SQLite 事务中提交，批次 ID 用于幂等重放。

### 5.2 调度

记忆调度器按会话保存待处理消息、静默截止时间、当前批次、失败次数和重试时间。服务重启时，运行中的批次恢复为待处理状态。已提交游标之前的消息不能重复入队。

### 5.3 召回

当前召回使用内存 BM25，在工作记忆、长期记忆和用户画像中搜索。返回结果包含来源、事件时间、用户身份和称呼信息。SQLite 负责持久化和有序读取，后续可在不改变调用接口的情况下增加 FTS 索引。

## 6. 文件与图片

### 6.1 QQ 文件

- 支持文本、代码、PDF、图片和常见 Office 文档。
- 原文件按内容哈希进入附件缓存。
- 文本解析流式执行，单文件最多索引 20,000,000 字符。
- 文本分块保存在每个缓存项的 `chunks.sqlite`。
- 模型上下文按查询相关性选择文本块和视觉页，并执行字符数、页数和文件大小限制。
- 原始文件、视觉文件和缓存清单按 TTL 与引用计数回收。

### 6.2 图像生成

图像生成支持尺寸、1K/2K/4K 分辨率、质量、参考图压缩、重试和 OneBot 外发。自拍必须使用角色参考图与自拍重写提示词。生成文件保存在忽略的运行目录，图片历史元数据保存在主 SQLite 数据库。

出站媒体只传递经过边界校验的本地绝对路径。NapCat 与 Sunabot 必须共享 `/srv/sunabot/workspace/business/media/images` 的同一路径视图；不提供 OneBot 专用 HTTP 媒体回调，也不得根据主机名猜测部署形态。

## 7. 管理台

管理台包含总览、对话、图片、记忆、提示词和设置页面，支持 light、dark 和跟随系统主题，并适配桌面、平板和移动端。

管理 API、生成图片和管理台数据使用管理员账号密码建立的 HttpOnly 会话鉴权；写操作还必须通过 CSRF 与 Origin 白名单校验。Bearer Token 仅用于受控自动化客户端，本机回环请求不绕过认证。远程入口包含单来源锁定、全局自动熔断和文件型手动熔断。远程图片代理必须执行协议、域名、DNS、重定向、响应类型、content-length、总字节数和超时校验。

## 8. SQLite 持久化

### 8.1 主库

默认路径：`workspace/business/data/sunabot.sqlite`。可通过 `SUNABOT_DATABASE_PATH` 覆盖。

主库启用 WAL、`synchronous=NORMAL`、外键和 5 秒 busy timeout。当前表如下：

| 表 | 数据 |
| --- | --- |
| `app_metadata` | schema 与旧数据导入标记 |
| `conversations` | 会话及其消息数组，每个会话一行 |
| `memory_records` | 工作记忆、长期记忆和用户画像 |
| `memory_batches` | 已提交记忆批次及幂等结果 |
| `memory_scheduler` | 各会话的记忆待处理队列与重试状态 |
| `request_logs` | 脱敏后的模型、工具和运行日志 |
| `image_history` | 生成图片历史元数据 |

`workspace/business/data/session-queue.sqlite` 独立保存会话事件、turn、异步任务和 outbox。附件缓存中的每个 `chunks.sqlite` 独立保存该文件的文本分块。

### 8.2 文件边界

以下内容继续使用文件：

- `workspace/secrets/runtime.env`：本机凭据，不进入 Git；
- `workspace/business/config/sunabot.json`：应用配置，不保存明文密钥；
- `workspace/business/agents/<agentId>/`：Agent 人格、提示词和人工维护文件；
- `workspace/business/media/`：需要随业务恢复的图片和持久附件；
- `workspace/runtime/napcat/`：QQ 登录态与 NapCat 运行状态；NapCat 配置唯一目录为 `workspace/runtime/napcat/config-full`，由 runtime contract 的 `paths.napcatConfig` 固定；登录二维码唯一文件为 `workspace/runtime/napcat/qrcode.png`，由 `paths.napcatQrCode` 固定，管理 API、Docker 与 Native 共用该路径；
- `workspace/cache/`：可重建缓存，不进入快照；
- Agent 人格和最终提示词：需要人工审阅和管理台编辑；
- 单个附件 manifest、好友/群目录缓存：体积小且可重建；
- 图片与文档二进制：文件系统更适合流式访问；
- Codex JSONL：子进程通信协议，不是持久化引擎。

### 8.3 旧数据迁移

`npm run migrate:sqlite` 执行以下操作：

1. 确认 sunabot 服务已经停止。
2. 检查旧记忆文件事务没有未提交项。
3. 备份旧会话、记忆、调度器、请求日志、图片历史和附件分块。
4. 导入 SQLite，并逐项核对源记录数和数据库记录数。
5. checkpoint 主库。
6. 仅在全部校验通过后删除旧 JSON/JSONL 源文件。

备份保存在 `workspace/backups/sqlite-migration-<timestamp>/`，该目录不进入 Git。

旧的 `config/agents/artifacts/security/napcat/.env` 布局必须在服务停止后通过 `npm run workspace:migrate` 前向迁移。迁移器先 checkpoint 和校验 SQLite，检查目标冲突，生成带 SHA-256 manifest 的业务数据备份，再移动到 `business/runtime/secrets/cache` 边界；不会覆盖内容不同的目标文件。检测到旧布局时，生产启动直接失败，不会静默创建第二套数据库。

## 9. 配置与安全

- Provider key、Tavily key、OneBot token 和自动化管理令牌只能通过 `workspace/secrets/runtime.env` 或进程环境变量提供。
- Git 不跟踪整个 `workspace/`，其中包括环境变量、配置、Agent 人格、SQLite、WAL、日志、缓存、QQ 登录态、生成图片和备份。
- 浏览器管理台不得把账号、密码、Bearer Token 或会话密钥写入 localStorage/sessionStorage。
- 请求日志递归脱敏授权、token、password、secret 和常见 key 字段，并限制长字符串。
- OneBot、本地媒体路径和 Agent 文件写入均执行边界校验。

## 10. 功能—代码文件索引

| 功能 | 主要代码 |
| --- | --- |
| 服务启动入口 | `apps/api/main.ts` |
| Node 版本一致性门禁 | `.node-version`, `.nvmrc`, `tooling/runtime/node-version-contract.mjs`, `tooling/runtime/validate-contract.mjs` |
| 出站代理解析与安装 | `packages/platform/proxy.mjs`, `deploy/runtime-contract.json` |
| API 组合、生命周期、静态站点与错误映射 | `apps/api/server.ts` |
| 管理鉴权 API | `apps/api/plugins/authRoutes.ts` |
| Provider、Codex 授权与配置 API | `apps/api/plugins/providerConfigRoutes.ts` |
| OneBot 管理 API | `apps/api/plugins/onebotRoutes.ts` |
| 记忆管理 API | `apps/api/plugins/memoryRoutes.ts` |
| 状态与监控 API | `apps/api/plugins/monitoringRoutes.ts` |
| 会话与会话日志 API | `apps/api/plugins/conversationRoutes.ts` |
| 图片、媒体代理、请求日志与图片测试 API | `apps/api/plugins/mediaRoutes.ts` |
| Agent 文件与工具目录 API | `apps/api/plugins/agentToolRoutes.ts` |
| 配置加载、默认值、路径解析 | `src/config.ts`, `src/types.ts` |
| SQLite 主库 | `adapters/sqlite/applicationDataStore.ts` |
| OneBot 连接、事件和 action | `adapters/onebot/onebotGateway.ts`, `adapters/onebot/qqMedia.ts` |
| 回复运行时、上下文、群聊总结 | `src/runtime.ts` |
| 会话事件、turn、工具任务、outbox | `services/sessions/`, `packages/contracts/session/runtimeMessages.ts` |
| 群聊门控与编排策略 | `services/orchestration/groupReplyPolicy.ts` |
| 命令路由与钩子 | `services/messaging/commandRouter.ts`, `services/messaging/hookBus.ts` |
| Provider 与工具循环 | `adapters/model/openaiProvider.ts`, `adapters/model/provider/`, `services/tools/` |
| Codex 异步工具 | `adapters/codex/codexTool.ts` |
| 联网搜索 | `adapters/model/webSearchTool.ts`, `adapters/model/webSearchSettings.ts` |
| Bash、图像生成、自拍 | `services/tools/bashTool.ts`, `services/tools/generateImgTool.ts`, `services/tools/selfieTool.ts` |
| 图片重试和外发 | `adapters/model/imageGenerationRetry.ts`, `services/delivery/outboundMedia.ts` |
| 人格与提示词 | `services/agent/` |
| 记忆 CRUD、合并、召回和批次 | `services/memory/` |
| 记忆调度 | `services/memory/memoryScheduler.ts` |
| 附件接入、解析、缓存和上下文 | `services/media/attachments/` |
| 会话目录和显示名 | `services/conversations/conversationDirectory.ts`, `services/conversations/senderName.ts` |
| 管理配置和 Agent 文件 | `src/admin/` |
| 管理台路由和页面 | `apps/admin-web/src/router.ts`, `apps/admin-web/src/views/` |
| 管理台组件和状态 | `apps/admin-web/src/components/`, `apps/admin-web/src/composables/` |
| 旧数据迁移 | `tooling/migrations/migrate-to-sqlite.mjs` |
| QQ Runtime 打包与启动 | `components/napcat/`, `deploy/`, `tooling/runtime/qq-compose.mjs`, `tooling/runtime/configure-napcat-client.mjs` |
| 单元与集成测试 | `tests/unit/`, `tests/integration/` |
| 浏览器与生产测试 | `tests/e2e/`, `playwright.config.ts` |

## 11. 验证标准

交付前必须通过：

```bash
npm run runtime:contract
npm run check
npm test
npm run build
npm run test:e2e
```

涉及界面时还要运行视觉测试并检查截图。涉及数据迁移时必须核对迁移脚本输出、SQLite 表记录数、旧文件备份和服务重启后的 API 与 OneBot 状态。
