# 设置页信息层级

版本：2026-07-13

## 一级结构

| 分组 | 页面 | 主要内容 | 明确移除或迁移 |
| --- | --- | --- | --- |
| Agent | Agent 身份、回复行为 | Agent 工作目录、记忆容量、管理员 QQ、管理员称呼、上下文、引用、回复范围、名称与命令前缀 | 固定运行路径不作为日常表单项；自拍参考图归入图像页 |
| 模型与记忆 | 模型服务、记忆处理、群聊编排 | Provider、记忆模型、阈值、容量、编排模型与窗口 | Env File 固定为 workspace secret；Provider 创建后不可切换类型；同一字段只出现一次 |
| 工具 | Agent 工具、命令执行 | 七项 Agent 工具目录、运行参数、联网、Codex Worker、图像与隔离命令 | 工具目录中的 Codex 与 Bash 开关直接控制对应运行配置；平台强制值显示状态，不伪装成可编辑项 |
| 系统 | 账户安全、连接与通知 | 管理员密码、Bark 监控、OneBot WebSocket 路径与 Access Token 状态 | 固定监听地址与端口移出日常设置；退出登录放在设置页页头，不进入全局侧栏 |

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

Agent 工具页分为“工具目录”和“运行参数”两个 Tab。工具目录固定展示 `assistant_text`、`memory_recall`、`websearch`、`generate_img`、`selfie`、`workspace_bash`、`codex`；运行参数保留单轮调用上限、Tavily、Codex Worker 和图像默认值。

| 区域 | 内容 | 交互 |
| --- | --- | --- |
| 工具目录 | 图标、名称、Function 名、摘要、执行方式、启用状态 | 行内切换启停；不可用时显示原因并锁定开关；点击详情查看参数和完整说明 |
| 工具详情 | 最终说明、参数名称、类型、必填状态、参数说明、严格模式 | 编辑全局说明；“恢复继承说明”删除说明覆盖并回到当前提示词或内置说明 |
| 运行参数 | 单轮调用上限、Web Search、Codex Worker、图像生成 | 使用当前分区保存栏；Codex Worker 停止后禁用其模型、可执行文件、超时和并发输入 |

工具启用与运行能力使用不同状态。用户配置决定启用或停用，平台、会话权限和依赖决定能力是否可用；两者同时满足时实际状态才可运行。状态使用 Boxicons、文字和语义色共同表达。说明覆盖和启用覆盖随“Agent 工具”分区一起保存，切换 Tab 不丢失草稿，离开设置页时继续参加未保存修改确认。

## 页面交互约束

- 新增 Provider 先打开类型选择，再创建草稿。
- Provider 列表负责选择与状态，不在列表内编辑协议。
- 工具目录与诊断抽屉读取同一有效状态；保存后以已保存配置显示。
- 保存栏只属于当前设置区域，移动端保持在可见安全区内。
- 危险操作使用二次确认，退出登录不与运行时配置保存混用。
- 修改管理员密码必须验证当前密码；成功后当前浏览器保持登录，其他管理会话失效。
- 页面使用 Space Grotesk、Space Mono 与 Doto；Doto 只用于大号拉丁状态和数字指标，中文标题、正文与操作文案继续使用界面字体。
