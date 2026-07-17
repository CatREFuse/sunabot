# 设置页信息层级

版本：2026-07-18

## 一级入口

| 入口 | 分组 | 页面 | 主要内容 |
| --- | --- | --- | --- |
| Agent 设置 | Agent | Agent 身份、回复行为、语气处理 | WebUI 头像、只读 Agent ID 与工作目录、管理员 QQ、管理员称呼、上下文、输入防抖时间、引用与过滤名单、回复范围、名称与命令前缀、Tone Provider 与独立模型参数 |
| Agent 设置 | 记忆与编排 | 记忆处理、群聊编排 | 记忆模型、阈值、容量、Thread 拆分模型、主动回复编排模型与窗口 |
| Agent 设置 | 工具 | Agent 工具、命令执行 | 十项 Agent 工具目录、运行参数、联网、Codex Worker、图像、文件外发与隔离命令 |
| 扩展 | Agent | Skill、MCP、批准队列 | Skill 安装、审查、启停、卸载与跨 Agent 迁移；MCP 描述符、运行状态、目录、OAuth 与一次性批准 |
| 系统设置 | 公共系统 | 模型服务、回复重试、广播风暴、账户安全、连接与通知 | Provider、正常回复失败重试次数、广播风暴嗅探、m/n/k 参数与补充账号名单、管理员密码、Bark 监控、OneBot WebSocket 路径与 Access Token 状态 |
| 配置医生 | 公共系统 | 配置检查与修复 | 本地规则检查、显式 AI 诊断、修复方案确认与持久备份结果；入口紧邻系统设置下方 |

固定运行路径不作为日常表单项；自拍参考图归入图像页。Env File 固定为 workspace secret；Provider 创建后不可切换类型；同一字段只出现一次。可配置的记忆容量只有工作记忆上限，并且只在“记忆处理”中设置；长期记忆和用户画像当前不设数量上限。工具目录中的 Codex 与 Bash 开关直接控制对应运行配置，运行参数和命令执行页不重复提供启停开关；平台强制值显示状态，不伪装成可编辑项。固定监听地址与端口移出日常设置；退出登录只放在系统设置页页头。

## 提示词入口

| 入口 | 默认内容 | 可选内容 |
| --- | --- | --- |
| Agent 提示词 | `AGENTS.md`、`SOUL.md`、`PREFERENCE.md`、`DIALOGUE_STYLE_EXAMPLES.md`、`USER.md`、`RELATION.md` | 开启“覆盖系统提示词”后显示当前 Agent 的完整系统提示词 |
| 系统提示词 | 公共对话、语气改写、记忆、主动回复编排、群聊 Thread 拆分、群聊总结和自拍改写提示词 | 无 |

开启覆盖时复制当前公共系统提示词到 Agent 的 `system-prompts/`；关闭后恢复继承公共版本，已有私有内容保留。

## 语气处理

| 字段 | 交互 |
| --- | --- |
| 启用语气处理 | 当前 Agent 独立开关，默认关闭 |
| Provider | 空值跟随默认 Provider；下拉只列出已启用 Provider |
| 模型、推理强度 | 独立于普通回复，可选择目录模型或输入自定义模型 ID |
| 随机性、最大输出 Token、失败重试次数 | 当前 Agent 独立保存，服务端执行范围校验 |
| 提示词 | 进入系统提示词中的“语气改写” |

## Provider 创建流程

Provider 类型在创建时选择，保存后只显示类型摘要，不提供协议切换。

| 类型 | 协议 | 默认地址 | 地址是否可改 | 默认凭据变量 |
| --- | --- | --- | --- | --- |
| Codex 订阅 | Codex Responses | ChatGPT Codex 后端 | 否 | Codex 本地授权 |
| OpenAI 官方 | OpenAI Responses | `https://api.openai.com` | 否 | `OPENAI_API_KEY` |
| Anthropic 官方 | Anthropic Messages | `https://api.anthropic.com/v1` | 否 | `ANTHROPIC_API_KEY` |
| OpenAI 兼容格式 | OpenAI Chat Completions | 用户填写 | 是 | `OPENAI_COMPATIBLE_API_KEY` |
| Anthropic 兼容格式 | Anthropic Messages | 用户填写 | 是 | `ANTHROPIC_COMPATIBLE_API_KEY` |
| Gemini 官方 | Gemini GenerateContent | `https://generativelanguage.googleapis.com/v1beta` | 否 | `GEMINI_API_KEY` |
| Gemini 兼容格式 | Gemini GenerateContent | 用户填写 | 是 | `GEMINI_COMPATIBLE_API_KEY` |

## Provider 字段层级

| 层级 | 字段 | 交互 |
| --- | --- | --- |
| 身份 | 名称、ID、启用、设为默认 | ID 创建后保持稳定；默认 Provider 不能停用 |
| 连接 | 类型、Base URL、API Key Env | 类型不可变；官方地址只读；密钥只显示配置状态 |
| 模型 | 模型 ID 来源、模型 ID、自动拉取 | 支持远端目录和自定义输入；目录失败不覆盖当前值 |
| 能力 | 多模态模式、自动检测结果、读图 Provider、读图模型 | `自动 / 支持 / 不支持`；不支持时必须选择读图辅助 Provider，读图模型可留空使用其默认模型 |
| 生成 | Temperature、推理强度、最大输出 Token | 推理强度只对 Codex 与 OpenAI 官方显示；其他参数按协议能力显示 |
| 验证 | 测试连接、刷新模型、检测多模态 | 状态与错误紧邻触发按钮显示 |

## Agent 工具

Agent 工具页分为“工具目录”和“运行参数”两个 Tab。工具目录固定展示 `assistant_text`、`no_reply`、`memory_recall`、`websearch`、`generate_img`、`selfie`、`send_file`、`send_voice_message`、`workspace_bash`、`codex`；运行参数保留单轮调用上限、Tavily、Codex Worker 和图像默认值。`send_file` 分别展示配置状态与实时 OneBot 能力状态，不提供账号或目标参数；`send_voice_message` 当前固定显示不可用，不能通过配置启用。

| 区域 | 内容 | 交互 |
| --- | --- | --- |
| 工具目录 | 图标、名称、Function 名、摘要、执行方式、启用状态 | 行内切换启停；不可用时显示原因并锁定开关；点击详情查看参数和完整说明 |
| 工具详情 | 最终说明、参数名称、类型、必填状态、参数说明、严格模式 | 编辑全局说明；“恢复继承说明”删除说明覆盖并回到当前提示词或内置说明 |
| 运行参数 | 单轮调用上限、Web Search、Codex Worker、图像生成 | 使用当前分区保存栏；Codex Worker 停止后禁用其模型、可执行文件、超时和并发输入 |

工具启用与运行能力使用不同状态。用户配置决定启用或停用，平台、会话权限和依赖决定能力是否可用；两者同时满足时实际状态才可运行。状态使用 Boxicons、文字和语义色共同表达。说明覆盖和启用覆盖随“Agent 工具”分区一起保存，切换 Tab 不丢失草稿，离开设置页时继续参加未保存修改确认。

## 页面交互约束

- WebUI 头像选择后进入圆形裁图，支持拖动、缩放和重置；原图不设置文件大小限制。
- 群聊引用过滤名单按当前 Agent 保存 QQ 号；命中名单时保留回复正文并取消消息引用。
- 正常回复重试次数按系统保存，默认 3，允许 0—10，保存后热更新全部 Agent。
- 广播风暴补充嗅探账号按系统保存 QQ 号，与所有已启用 Agent 的 QQ 合并参与检测。
- 新增 Provider 先打开类型选择，再创建草稿。
- Provider 列表负责选择与状态，不在列表内编辑协议。
- 工具目录与诊断抽屉读取同一有效状态；保存后以已保存配置显示。
- 保存栏只属于当前设置区域，移动端保持在可见安全区内。
- 扩展页始终绑定当前 Agent；Skill 安装、MCP 描述符保存和跨 Agent 迁移均先预览后确认，删除操作使用二次确认。
- stdio MCP 只展示和提交完整命令、逐行参数与环境变量名称；OAuth 只展示绑定状态，浏览器不得读取或保存凭据值。
- 危险操作使用二次确认，退出登录不与运行时配置保存混用。
- 配置医生使用独立页面，不依赖系统设置配置接口成功；AI 诊断前显示 Provider、模型和请求目标，浏览器只提交服务端方案 ID 与源文件 revision。
- 修改管理员密码必须验证当前密码；成功后当前浏览器保持登录，其他管理会话失效。
- 页面使用 Space Grotesk、Space Mono 与 Doto；Doto 只用于大号拉丁状态和数字指标，中文标题、正文与操作文案继续使用界面字体。
