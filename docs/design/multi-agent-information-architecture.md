# 多 Agent 与多 QQ 信息架构

版本：2026-08-12（v0.3.0）

## 目标

Sunabot Native Core 运行多个相互隔离的 Agent。每个 Agent 可以绑定多个 QQ 账号，每个 QQ 账号由独立 NapCat 容器承载；NapCat 是 v0.3.0 唯一 Docker 例外。Provider、模型目录、管理员安全、运行资源限制、平台开关和公共系统提示词继续全局共用；人格、回复行为、可选系统提示词覆盖、记忆、工具覆盖、图片历史和工作目录归 Agent 所有。

首批 Agent 为普拉娜与阿罗娜。新增 Agent 由管理台创建，创建完成后立即拥有独立目录、默认人格、空记忆、公共系统提示词继承关系和可绑定的 QQ 账号列表。

## 运行拓扑

```text
Sunabot Native Core
├── SharedConfig
│   ├── Provider 与模型
│   ├── 管理员安全
│   └── 平台与资源开关
├── AgentRegistry
│   ├── plana → AgentRuntime → QQ account 1..n
│   ├── arona → AgentRuntime → QQ account 1..n
│   └── custom → AgentRuntime → QQ account 1..n
├── OneBotGateway
│   └── accountId → 已鉴权 WebSocket
└── SQLite
    ├── 全局 Token 总计
    └── agentId / accountId 维度

每个 QQ account
└── 独立 NapCat Docker 容器与独立登录态
```

QQ 账号只归属一个 Agent。消息进入 Core 后先由连接确定 `accountId`，再由注册表确定 `agentId`。所有会话、队列、日志、记忆和外发动作都携带这两个稳定 ID，禁止依靠当前选中的 Agent 或任意在线 WebSocket 猜测路由。管理员在新账号中完成同一 QQ 的登录时，管理登录流程先阻止旧账号快速登录、退出旧连接并强制重建旧账号自己的 NapCat 容器，再原子转移注册归属；`KICKEDOFFLINE` 登录态使用同一单账号重建流程自动取得新二维码。普通消息入站不能发起转移，旧 Agent 的业务数据也不随账号移动。

## 数据归属

| 数据 | 作用域 | 说明 |
| --- | --- | --- |
| Provider、模型、API Key 状态 | 全局 | 所有 Agent 共用同一份配置 |
| 管理员账号、CSRF、代理、运行资源限制 | 全局 | 继续由现有系统设置维护 |
| 公共系统提示词 | 全局 | 位于 `business/prompts/`，所有未开启覆盖的 Agent 共用 |
| Agent 名称、头像、启用状态 | Agent | `agentId` 创建后不可变，显示名称可改 |
| Bot 行为、群聊编排、工具覆盖 | Agent | 由各 Agent 独立保存 |
| 人格提示词 | Agent | 六个人格文件位于 Agent 工作区 |
| 自拍提示词改写与参考图 | Agent | 提示词与角色参考图均位于 Agent 工作区，不进入公共系统提示词 |
| 系统提示词覆盖 | Agent | 可选；开启后位于 Agent 工作区的 `system-prompts/` |
| 工作记忆、长期记忆、用户画像 | Agent | 同一 Agent 的多个 QQ 共享；不同 Agent 完全隔离 |
| 会话与 outbox | Agent + QQ account | 同一 QQ 内保持顺序，跨账号并发 |
| 图片历史与自拍参考 | Agent | 不跨 Agent 展示或召回 |
| Token 统计 | 全局 + Agent + QQ account | 默认显示总计，可切换 Agent，账号维度供详情和诊断使用 |

## Workspace

```text
workspace/
├── business/
│   ├── config/
│   │   └── sunabot.json
│   ├── prompts/
│   │   ├── conversation_private_reply.json
│   │   ├── conversation_group_reply.json
│   │   ├── work_memory_compress_in.json
│   │   ├── work_memory_compress_out.json
│   │   ├── user_profile_prompt.json
│   │   ├── user_groupchat_orchestrator.json
│   │   └── group_chat_summary.json
│   ├── agents/
│   │   ├── plana/
│   │   │   ├── agent.json
│   │   │   ├── data/
│   │   │   │   ├── sunabot.sqlite
│   │   │   │   └── session-queue.sqlite
│   │   │   ├── AGENTS.md
│   │   │   ├── SOUL.md
│   │   │   ├── PREFERENCE.md
│   │   │   ├── DIALOGUE_STYLE_EXAMPLES.md
│   │   │   ├── USER.md
│   │   │   ├── RELATION.md
│   │   │   ├── selfie_prompt_rewrite.json
│   │   │   ├── system-prompts/   # 仅开启覆盖后存在
│   │   │   ├── assets/
│   │   │   │   └── avatar.*
│   │   │   ├── workbench/        # 唯一可写工作台
│   │   │   │   ├── index.md
│   │   │   │   ├── selfie/references.jsonl
│   │   │   │   ├── emoji/emojis.jsonl
│   │   │   │   ├── skills/index.json
│   │   │   │   └── knowledge/index.json
│   │   │   └── extensions/
│   │   │       └── mcp/servers.json
│   │   └── arona/
│   │       └── ...
│   ├── data/
│   │   ├── sunabot.sqlite
│   │   └── session-queue.sqlite
│   └── media/
│       └── agents/<agentId>/images/
└── runtime/
    └── napcat/
        └── accounts/<accountId>/
            ├── config-full/
            ├── qq/
            ├── plugins/
            ├── qrcode.png
            └── manual-login-required
```

`agent.json` 是可人工维护的小型 manifest，保存名称、头像相对路径、`prompts.overrideSystem` 和 Agent 级设置。增长型数据进入各 Agent 的 SQLite。现有主库与 session queue 继续归普拉娜使用，避免搬动在线数据；新增 Agent 在自己的 `data/` 中创建双库。主库同时保存 Agent 与 QQ 账号注册关系，供 Core 在启动时发现所有 Agent。现有普拉娜目录前向补齐 manifest，不复制或重建已有记忆；公共最终提示词复制到 `business/prompts/`，人格文件与 `selfie_prompt_rewrite.json` 继续留在 Plana 工作区。

每个 Agent 只有一个 canonical `workbench/`。Native Bash、Codex、聊天媒体、自拍、表情、知识库和 Skill 都从该目录寻址；Skill 与 MCP 的入口文件分别为 `workbench/skills/index.json` 和 `extensions/mcp/servers.json`。v0.2 的 `docker-workbench/` 只由 0.2→0.3 迁移器识别并合并，当前运行时和管理台不得继续创建、读取或展示它。

## 管理台结构

### 全局导航

桌面侧栏顶部显示当前 Agent 的头像、名称和切换按钮，列表底部提供“管理 Agent”。移动端在页面标题上方显示同一选择器，完整列表放入底部弹层。

导航分为两类：

| 范围 | 页面 |
| --- | --- |
| Agent | 当前 Agent、Agent 设置、状态、Web Chat、会话、Agent 提示词、记忆、图像、日志 |
| 公共系统 | 系统设置、系统提示词 |

切换 Agent 时保持当前功能页，例如从普拉娜的记忆切换到阿罗娜后仍停留在记忆页。会话详情等含资源 ID 的页面回到对应列表，避免跨 Agent 读取旧 ID。

### Agent 页面

`/agents/:section?` 是 Agent 管理与设置的唯一页面，默认显示身份分区。旧 `/agent-settings/:section?` 携带 query/hash 跳转到对应新路由。全局 Agent 下拉菜单只负责切换，移除“管理 Agent”重复入口。

身份分区提供角色切换按钮、“新增 Agent”、当前角色启停、删除、运行时与记忆摘要；QQ 状态统一在 QQ 接入分区查看。各分区包含：

| 区域 | 内容 | 操作 |
| --- | --- | --- |
| 身份 | 头像、名称、Agent ID、状态 | 编辑名称与头像、启用或停用 |
| QQ 接入 | 当前 Agent 的 QQ 接入入口 | 打开 Agent 设置的 QQ 接入页 |
| 用量 | 今日 Token、请求数、上下文缓存 | 查看完整统计 |
| 工作区 | 提示词、记忆、图像 | 通过现有主导航打开对应页面 |

新增 Agent 使用模态表单，字段为“名称”“Agent ID”“头像”。Agent ID 根据名称生成，可在创建前修改，只允许小写字母、数字和连字符。提交按钮文案为“创建 Agent”。成功后切换到新 Agent 详情。

QQ 账号管理集中于 `/agents/connection`，显示本地自启动或远程托管、运行主机、OneBot 地址与端口、管理端口及分别核验的 QQ 登录与 OneBot 连接状态。每个 Bot 接一个 QQ，已有账号时隐藏新增入口。没有账号时使用“接入 QQ”模态表单，字段为“名称”；创建后生成稳定 `accountId`，容器未运行时显示“运行”，启动成功后进入扫码登录状态，QQ 号在 NapCat 登录成功后回填。保留原有数据，不通过本次界面调整删除或迁移历史账号。

### 状态与统计

状态页顶部直接提供各 Agent 的切换按钮及“全部 Agent”统计入口，不再提供独立 QQ 下拉框。全局范围显示总 Token、全部 Agent 请求数、已连接 Agent 数和 OneBot 连接数；Agent 范围显示当前 Agent 的 Token、请求数、对应 QQ 状态和记忆数量。Token 图表沿用模型与行为筛选，并在查询中增加 `agentId`。

每条统计记录必须保存 `agentId`。OneBot 消息产生的记录同时保存 `accountId`；Web Chat 记录保存当前 `agentId`，`accountId` 为空。旧记录前向回填为 `plana`，旧 QQ 接入回填为 `primary`。

### 设置

设置与提示词拆成四条入口：

| 入口 | 内容 |
| --- | --- |
| Agent 设置 | 身份、回复行为、记忆、群聊编排、Agent 工具、命令执行 |
| 系统设置 | Provider、模型、管理员安全、通知、OneBot listener |
| Agent 提示词 | 六个人格文件和自拍提示词改写；可开启覆盖并编辑当前 Agent 的完整系统提示词；导出、预览并导入 `.sunabot-soul.json` 灵魂文件 |
| 系统提示词 | 所有 Agent 默认继承的完整系统提示词 |

页面标题和保存请求始终携带明确 Agent，切换 Agent 前若有未保存内容，继续使用现有离开确认流程。

## Vue 组件边界

```text
AppShell
├── AgentSwitcher
├── DesktopNavigation
├── MobileNavigation
└── RouterView
    └── SettingsView
        ├── AgentManagementSettings → CreateAgentDialog / DeleteAgentDialog
        ├── PersonaSettingsForm
        ├── AgentConnectionSettings → AgentAccountList
        └── 其他设置分区
```

- `useAgents` 负责列表、当前 Agent、创建、单账号容器启动、更新与 API 错误状态。
- `AgentSwitcher` 通过 `useAgents` 切换；在统一设置页不重新加载浏览器，由设置页完成保存与切换。
- `SettingsView` 组合管理、身份和 QQ 接入分区；管理组件接收已建立配置上下文的 `agentId` 和保存回调，保持与配置表单一致。
- 创建表单独立为模态组件，关闭时清空草稿。
- Agent 作用域通过显式 `agentId` 进入 API；组件不读取全局可变变量来决定数据归属。

## 视觉与响应式

- 延续现有黑、白、灰与红色强调色，阿罗娜头像作为身份信息使用，不新增装饰性色块。
- 桌面侧栏宽屏显示头像和名称，窄侧栏只显示头像；移动端选择器保持 44px 以上触控高度。
- Agent 列表和详情使用分割线与留白聚合信息，不嵌套卡片。
- 状态同时使用文字和图标，颜色仅作为辅助。
- 浅色、深色和跟随系统继续共用现有 CSS token。
- 360px、768px、1440px 三档截图必须完成视觉检查。

## API 契约

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| `GET` | `/api/agents` | Agent 列表与当前 Agent |
| `POST` | `/api/agents` | 创建 Agent |
| `GET` | `/api/agents/:agentId` | Agent 详情 |
| `PATCH` | `/api/agents/:agentId` | 更新名称、头像或启用状态 |
| `GET` | `/api/agents/:agentId/avatar` | 读取头像 |
| `GET` | `/api/agents/:agentId/prompt-settings` | 读取系统提示词覆盖状态 |
| `PATCH` | `/api/agents/:agentId/prompt-settings` | 开启或关闭系统提示词覆盖 |
| `GET` | `/api/agents/:agentId/accounts` | QQ 账号列表 |
| `POST` | `/api/agents/:agentId/accounts` | 新增 QQ 账号 |
| `POST` | `/api/agents/:agentId/accounts/:accountId/runtime/start` | 创建或启动目标 NapCat QQ Docker |
| `DELETE` | `/api/agents/:agentId/accounts/:accountId` | 移除未登录账号 |
| `POST` | `/api/agents/:agentId/accounts/:accountId/login` | 刷新二维码 |
| `POST` | `/api/agents/:agentId/accounts/:accountId/logout` | 退出 QQ |
| `GET` | `/api/agents/:agentId/accounts/:accountId/login/status` | 登录状态 |
| `GET/PUT` | `/api/agent-files/:id` | 当前 Agent 的人格或已开启的系统提示词覆盖 |
| `GET/PUT` | `/api/system-prompt-files/:id` | 公共系统提示词 |
| `GET` | `/api/agents/:agentId/soul/export` | 导出当前 Agent 灵魂文件 |
| `POST` | `/api/agents/:agentId/soul/preview` | 校验包并预览差异与冲突 |
| `POST` | `/api/agents/:agentId/soul/import` | 按已确认策略事务导入灵魂文件 |

现有 Agent 级接口增加必填 `agentId` 查询参数或路由参数。兼容期内缺失值映射到 `plana`，新管理台不依赖该兼容行为。

## 数据库与迁移

主库新增 `agents` 与 `agent_accounts`。普拉娜继续使用现有主库与 session queue；新增 Agent 使用其工作区内的双库，因此会话、记忆、调度器、图片历史、请求日志和模型统计在文件系统层隔离。会话 key 使用 `accountId:conversationId`，队列 payload 同时保留结构化 `agentId` 与 `accountId`。全局统计读取注册表中的启用 Agent，汇总各自模型统计表。

迁移必须在服务停止后执行，顺序为双库 checkpoint、完整备份与 SHA-256 manifest、建表和新增列、回填 `plana` 与 `primary`、创建索引、外键和唯一约束校验、SQLite `integrity_check`、重启后 API 与消息回环检查。旧字段与旧目录在兼容期保留读取，迁移不得依赖删除数据库。

## 验收

- 普拉娜与阿罗娜可以同时存在，切换后人格提示词、记忆、图片和设置互不串读。
- 未开启覆盖的 Agent 同时读取公共系统提示词；开启覆盖后只读取私有副本，关闭后恢复公共版本且不删除私有副本。
- 一个 Agent 可以绑定两个 QQ，两个账号同时在线且回复动作回到原账号。
- 未运行账号显示“运行”；启动请求只创建或启动目标账号的 Compose project，其他 QQ 容器保持运行。
- 新增 Agent 后目录和 SQLite 注册信息同时创建，任一步失败时事务性回滚。
- 全局 Token 等于各 Agent Token 之和，单 Agent 筛选不包含其他 Agent。
- Linux、WSL 与 macOS Native Core 均能连接多个独立 NapCat 容器，Core、Bash、MCP、Skill 和 WebFetch 不产生额外业务容器。
- 当前 Agent 的灵魂文件可在 WebUI 与 CLI 导出、预览并导入；冲突策略明确，失败时六个人格文件保持原状。
- Native 工具与全部资源入口只解析当前 Agent 的 canonical `workbench/`；运行时不再访问 `docker-workbench/`。
- 管理台通过单元、E2E、视觉与浅色/深色检查。
