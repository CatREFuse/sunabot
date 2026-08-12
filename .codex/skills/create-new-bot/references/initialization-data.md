# Sunabot 新角色初始化数据

本参考以 2026-07-28 当前源码和运行中的 `arona` 为基准；它随项目级 Skill 一同位于 `.codex/skills/create-new-bot/`。源码变化时重新核对：

- `services/agents/agentRegistry.ts`
- `services/agents/agentWorkspaceBootstrap.ts`
- `services/agents/agentConfigImport.ts`
- `services/agents/agentConfigImportProjection.ts`
- `apps/api/plugins/agentRoutes.ts`
- `apps/api/server.ts`
- `src/runtime/lifecycle.ts`
- `apps/api/bundledAgentSkills.ts`

## 四层数据边界

| 层级 | 创建时机 | 数据 |
| --- | --- | --- |
| Agent 身份 | `POST /api/agents` | 共享主库 `agents` 注册行、`agent.json`、可选头像 |
| 干净工作区 | `POST /api/agents` | 8 个人格文件、空工作记忆、自拍提示词、单一 Workbench 入口、自拍/表情/Skill/知识库/MCP 空索引 |
| Runtime 初始状态 | 创建回调 | `workbench-config` 的安装/审核/启用、Agent 业务库、Session 队列库、附件缓存和调度器初始状态 |
| 外部与角色素材 | 显式后续操作 | QQ/NapCat、语音、自拍图、表情、知识库、其他 Skills、MCP、系统提示词覆盖、真实 Provider/QQ 验收 |

## 创建时立即写入

### 共享注册表

`workspace/business/data/sunabot.sqlite` 的 `agents` 表新增一行：

- `id`
- `name`
- `enabled=true`
- `workspace=workspace/business/agents/<agentId>`
- 可选 `avatar_path`
- `created_at`
- `updated_at`

Agent 的 QQ 账号不会随 Agent 自动创建。账号通过独立接口创建后才写入共享主库 `agent_accounts`。

### Agent manifest

`workspace/business/agents/<agentId>/agent.json` 包含：

- schema、ID、名称、启用状态和时间；
- `prompts.overrideSystem=false`；
- 从当前共享配置复制的 Agent 级 Bot 行为；
- 从共享 OneBot 配置派生的回复开关；
- 默认 `mentionNames=[name,id]`；
- 默认 `commandPrefixes=[/<id>,name]`；
- 可选头像相对路径。

导入旧 `agent.json` 时只合并当前已知字段。新 ID、名称、启用状态和时间由创建请求决定；管理员身份与 WebSearch credential 字段保留当前安全基线，来源包中的同类值不会被采用。

不要把完整 manifest 当作审计输出。当前运行数据可能包含 key-like 配置值。

### 人格与记忆起点

立即创建：

- `AGENTS.md`：角色工作规则；
- `SOUL.md`：身份、性格与稳定表达；
- `PREFERENCE.md`：偏好和行为边界；
- `DIALOGUE_STYLE_EXAMPLES.md`：对话风格样本；
- `USER.md`：对用户的称呼与认知；
- `RELATION.md`：明确关系；
- `AIR.md`：场域知识；
- `DIRECTOR_SEED.md`：日常导演种子；
- `WORKING_MEMORY.md`：空的结构化工作记忆文档；
- `selfie_prompt_rewrite.json`：非默认 Agent 使用通用自拍提示词，不带普拉娜身份。

新角色不应预置虚构的对话事实、用户画像、长期记忆或关系历史。角色设定写入人格文件；实际经历从干净运行状态开始积累。

### 固定资源入口

立即创建：

- `workbench/index.md`
- `workbench/selfie/references.jsonl`
- `workbench/emoji/emojis.jsonl`
- `workbench/skills/index.json`
- `workbench/knowledge/index.json`
- `extensions/mcp/servers.json`

自拍与表情清单为空；Skill、知识库和 MCP 索引为 schema v1 的空索引。`assets/`、`data/`、`files/` 和相关资源目录在创建过程中按需建立。

## 创建回调与首次 Runtime 初始化

管理 API 的 `onAgentCreated` 顺序执行：

1. 安装或升级项目内置 `workbench-config` Skill；
2. 对该固定 bundle 执行确定性审核与双摘要批准；
3. 启用该 Skill；
4. 启动新 Agent Runtime。

Runtime 构造或初始化产生：

- `data/sunabot.sqlite`：该 Agent 的会话、记忆、日志、图片、任务、Director、Dream 等业务 schema；
- `data/session-queue.sqlite`：Session、turn、tool job、event 与 outbox schema；
- 附件缓存目录与索引；
- 工作记忆、记忆事务和事件 schema 的空状态校验；
- 记忆调度器、定时任务、Director 和 Dream 的启动状态。

数据库存在只证明持久化边界已初始化。它不证明角色已有记忆、Provider 可用、QQ 已连接或消息已成功收发。

## 导入包支持的数据

允许导入：

- `agent.json`
- 8 个人格 Markdown 文件
- `selfie_prompt_rewrite.json`
- 已知的 `system-prompts/*.json`
- 一个 `assets/avatar.png|jpg|webp`
- `selfie/references.json` 或 `selfie/references.jsonl`
- 与清单匹配的有限自拍图片

不允许导入：

- `WORKING_MEMORY.md`
- Agent SQLite 或 Session Queue
- QQ 账号、QQ 号、NapCat 配置和登录态
- voice profile 或语音参考文件
- emoji、knowledge、Skills、MCP 的现有数据
- workbench 任务产物
- cache、runtime、backup、迁移记录
- `.env`、token、key 或其他 credential

导入预览列出的“缺少”只是完整度提示。创建逻辑会用安全默认值补齐缺失的人格、自拍提示词和空入口；不要为了消除提示而复制无关的阿罗娜数据。

## 阿罗娜当前状态对照

当前 `arona` 可确认：

- ID 为 `arona`，名称为“阿罗娜”，启用且有头像；
- 共享注册表有 1 个独立 QQ 账号，创建时间晚于 Agent 本身；
- 8 个人格文件已从默认占位内容扩展为完整角色设定；
- `WORKING_MEMORY.md`、业务库、队列库和资源目录已经积累运行数据；
- 已配置日语语音参考；
- 自拍、表情、知识库、Workbench 和 Skill 目录含后续运营数据；
- `prompts.overrideSystem=false`，当前应使用公共系统提示词；
- Agent 目录中的 `system-prompts/` 和旧根级 final prompt 文件属于保留或历史产物，在 override 关闭时不是当前系统提示词来源。

将阿罗娜用于检查“一个成熟角色可能有哪些能力”，不要把成熟运行状态复制成新角色的初始数据。

## 新角色完成矩阵

| 项目 | 最低可运行 | 对齐阿罗娜的成熟状态 |
| --- | --- | --- |
| ID、名称、manifest、注册行 | 必须 | 必须 |
| 8 个人格文件 | 必须，可先使用安全默认值 | 需要完整角色设定 |
| 空工作记忆与两套 SQLite | 必须 | 后续自然积累 |
| 固定资源入口 | 必须 | 按角色补充资源 |
| 头像 | 可选 | 建议 |
| QQ 账号与 NapCat | 可选，独立创建 | 需要真实 QQ 时配置 |
| 语音 | 默认关闭或无文件 | 按合法来源配置 |
| 自拍参考图 | 可选 | 需要自拍能力时配置 |
| 表情、知识库、额外 Skills、MCP | 空起点 | 按角色任务配置 |
| 系统提示词覆盖 | 默认关闭 | 只有明确差异时开启 |
| Provider 与 QQ 实测 | 独立验收 | 上线前必须分别验证 |
