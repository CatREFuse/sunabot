# 多 Agent 与多 QQ 信息架构

版本：2026-07-13

## 目标

Sunabot Core 运行多个相互隔离的 Agent。每个 Agent 可以绑定多个 QQ 账号，每个 QQ 账号由独立 NapCat 容器承载。Provider、模型目录、管理员安全、运行资源限制、平台开关和公共系统提示词继续全局共用；人格、回复行为、可选系统提示词覆盖、记忆、工具覆盖、图片历史和工作目录归 Agent 所有。

首批 Agent 为普拉娜与阿罗娜。新增 Agent 由管理台创建，创建完成后立即拥有独立目录、默认人格、空记忆、公共系统提示词继承关系和可绑定的 QQ 账号列表。

## 运行拓扑

```text
Sunabot Core
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

QQ 账号只归属一个 Agent。消息进入 Core 后先由连接确定 `accountId`，再由注册表确定 `agentId`。所有会话、队列、日志、记忆和外发动作都携带这两个稳定 ID，禁止依靠当前选中的 Agent 或任意在线 WebSocket 猜测路由。

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
│   │   │   ├── selfie/
│   │   │   └── files/
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

`/agents` 使用左右分栏。左侧是 Agent 列表和“新增 Agent”；右侧显示所选 Agent 的身份、运行状态、QQ 账号和快捷入口。窄屏使用列表页进入详情页。

Agent 列表行只显示头像、名称、在线账号数和启用状态。详情区包含：

| 区域 | 内容 | 操作 |
| --- | --- | --- |
| 身份 | 头像、名称、Agent ID、状态 | 编辑名称与头像、启用或停用 |
| QQ 账号 | 账号名称、QQ 号、登录状态、NapCat 状态 | 新建 NapCat QQ Docker、运行、登录、退出、查看 WebUI、移除未登录账号 |
| 用量 | 今日 Token、请求数、上下文缓存 | 查看完整统计 |
| 工作区 | 提示词、记忆、图像、文件入口 | 打开对应页面 |

新增 Agent 使用模态表单，字段为“名称”“Agent ID”“头像”。Agent ID 根据名称生成，可在创建前修改，只允许小写字母、数字和连字符。提交按钮文案为“创建 Agent”。成功后切换到新 Agent 详情。

新增 QQ 账号使用“新建 NapCat QQ Docker”模态表单，字段为“名称”。创建后生成稳定 `accountId`；容器未运行时显示“运行”，启动成功后进入扫码登录状态，QQ 号在 NapCat 登录成功后回填。

### 状态与统计

状态页顶部提供“全部 Agent / 当前 Agent”范围切换。全局范围显示总 Token、全部 Agent 请求数、在线 Agent 数和在线 QQ 数；Agent 范围显示当前 Agent 的 Token、请求数、账号状态和记忆数量。Token 图表沿用模型与行为筛选，并在查询中增加 `agentId`。

每条统计记录必须保存 `agentId`。OneBot 消息产生的记录同时保存 `accountId`；Web Chat 记录保存当前 `agentId`，`accountId` 为空。旧记录前向回填为 `plana`，旧 QQ 接入回填为 `primary`。

### 设置

设置与提示词拆成四条入口：

| 入口 | 内容 |
| --- | --- |
| Agent 设置 | 身份、回复行为、记忆、群聊编排、Agent 工具、命令执行 |
| 系统设置 | Provider、模型、管理员安全、通知、OneBot listener |
| Agent 提示词 | 六个人格文件和自拍提示词改写；可开启覆盖并编辑当前 Agent 的完整系统提示词 |
| 系统提示词 | 所有 Agent 默认继承的完整系统提示词 |

页面标题和保存请求始终携带明确 Agent，切换 Agent 前若有未保存内容，继续使用现有离开确认流程。

## Vue 组件边界

```text
AppShell
├── AgentSwitcher
├── DesktopNavigation
├── MobileNavigation
└── RouterView
    └── AgentsView
        ├── AgentDirectory
        ├── AgentProfile
        ├── AgentAccountList
        ├── CreateAgentDialog
        └── CreateAgentAccountDialog
```

- `useAgents` 负责列表、当前 Agent、创建、单账号容器启动、更新与 API 错误状态。
- `AgentSwitcher` 只接收 Agent 列表和当前 ID，通过事件请求切换。
- `AgentsView` 组合列表与详情，不直接实现 API 请求。
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
- Native Core 与 Docker Core 均能连接多个独立 NapCat 容器。
- 管理台通过单元、E2E、视觉与浅色/深色检查。
