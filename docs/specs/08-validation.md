# 验证标准与已知限制

[返回当前系统规范索引](./index.md)

## 11. 验证标准

交付前必须通过：

```bash
npm run verify
```

`verify` 依次执行 runtime contract、architecture、SQLite recovery、类型检查、单元与集成测试、独立 runtime smoke、CI 容量基线、生产构建和 E2E。消息专项回归必须证明 `assistant_text` 写入 durable outbox 后即可继续 inline 工具，远端发送仍在进行或重试时不能阻塞工具；事件重试不能重复发送已提交的中间消息。deferred `dispatch_message` 与任务必须原子持久化，worker 在 acknowledgement 仍待发送时即可 claim，callback 随后按同一会话 FIFO 投递。

涉及界面时还要运行视觉测试并检查截图；正常回复重试必须覆盖默认 3 次、0—10 配置校验、公共分区热更新、SDK 与原生 HTTP Provider 的相同请求重试、取消后停止、请求日志尝试序号，以及 light/dark 和移动端设置页。Web Chat 必须覆盖管理员身份、每 Agent 顺序执行、连续消息 ID、目标 Agent 日志与 Token 选库、Web/QQ 外发隔离、消息轮询、发送校验、键盘操作、图片缩略图和移动端布局。多 Agent 测试必须覆盖 Agent 原子创建与运行时失败补偿、路径校验、独立 SQLite 与队列、独立人格、公共系统提示词继承、Agent 系统提示词覆盖、QQ 唯一归属、WebUI 端口唯一性、primary 不可移除、同一 OneBot listener 的多账号并发连接、重启恢复、secondary 账号引用与身份查询、primary 兼容接口定向 action、Agent 级和全部 Agent Token 汇总。广播风暴测试必须覆盖同一 Agent 不计数、同群所有不同 Agent 对共同累计、不同群分开计数、补充嗅探账号、重复 OneBot 事件去重、m 窗口淘汰、n 阈值触发、k 静默期、静默期不创建新任务、已 dispatch 任务与 outbox 不受影响、静默期消息只记录、自动恢复、关闭功能与配置热更新。涉及数据迁移时必须核对默认与显式配置 API 直启的写入前零变更门禁、fresh-install 与 completed-migration 标记、首次 marker 发布中断、主库出现后的半初始化拒绝、标记篡改、全部注册 Agent/账号状态漂移、目标 workspace 与端口漂移、必需路径符号链接穿越、外部数据库覆盖、secondary 账号监听、全部账号端口、带标签的各种活动容器、迁移报告四类 copied/preserved 证据、SQLite 表记录数、公共系统提示词哈希、旧文件备份和服务重启后的 API 与 OneBot 状态。Linux 发行验收还要核对干净源码门禁与重新生产构建，预构建 Native Core、生产依赖、Docker Core 构建上下文、迁移 wrapper、门禁模块和迁移文档均存在；在无 `.git`、无开发依赖的解包目录复验真实平台、runtime contract、完整 `dist/`、`tooling/`、生产 `node_modules/` 与锁文件的文件集合及哈希后完成 dry-run，并用篡改 fixture 证明失败关闭。

配置医生验收必须限定目标为 `workspace/business/config/sunabot.json`，覆盖缺失 `schemaVersion` 或小型设置的本地补齐、不支持版本拒绝、UTF-8 BOM 与末尾逗号修复、无效 UTF-8/NUL/重复字段/超限文件/超深或过度复杂结构/非法 JSON/非法根结构的手动处理，以及 Agent manifest、提示词、凭据、SQLite 和其他文件零修改。API 测试必须覆盖 `GET /api/config-doctor/scan`、`POST /api/config-doctor/propose` 和 `POST /api/config-doctor/apply` 的封闭响应 schema、鉴权、session CSRF 与 Origin、错误映射、10 分钟 proposal 过期、10 秒 AI 限流和源 revision 冲突。AI 测试必须证明每次建议只有一次无工具模型调用、请求经过脱敏、异常字段名不外发、响应为受限结构化 JSON，并拒绝过大输出、超过数量或深度限制的操作、非法 JSON Pointer、原型污染字段、重复路径、`remove`、白名单外路径和非当前问题路径。应用测试必须覆盖共用写互斥锁、完整候选校验、运行时预检、持久备份、备份父链与配置文件符号链接拒绝、原子写入、写入前后 revision 复验、热更新、方案外磁盘配置保持待加载，以及预检失败、并发修改、运行时提交失败和双重恢复失败的故障注入；不把备份目录视为用户主动回滚功能。管理台还必须检查独立 `/config-doctor` 页面在系统设置下方的导航位置、状态、AI Provider 信息、服务端目标值说明、修复确认、过期方案、重启提示和成功备份路径，并完成桌面与移动端 light/dark 视觉检查。`./sunabot.sh doctor` 的只读行为必须保持不变，不能把当前版本描述为具备 CLI 离线修复。

Token 统计验收必须覆盖 OpenAI Responses、Deferred Codex CLI 成功与失败结果、Chat Completions、Anthropic 和 Gemini 的原始 usage 夹具，验证缓存输入不重复计数、Codex CLI 失败 usage 不丢失、Anthropic 三类输入求和、思考 Token 归入输出、缓存率分母只包含明确报告缓存字段的记录、无缓存字段返回 `null`、显式零缓存返回 `0`、时区跨日、24 个小时桶、最近 53 周日期范围，以及模型与功能组合筛选不改变可选模型集合。行为统计必须验证回答、编排器、记忆总量与两类真实记忆拆分无重复计数，并验证 `conversationId` 精确隔离。管理台测试必须验证小时/日切换、模型/功能筛选、371 个日历单元、24 个小时柱、缓存率折线不产生 `NaN`/`Infinity`，并分别检查移动端与桌面端的 light/dark Token 卡片、行为统计、群聊详情、日历、小时图和展开后的结构化 usage 日志截图。

Prompt Cache 验收必须分别执行 OpenAI 官方 Responses 与 Codex Responses 的两轮真实连续对话：两轮使用同一模型、提示词家族和稳定 system/developer 前缀，第二轮追加第一轮用户消息与助手回复；逐轮记录 Provider 实际返回的原始 `input_tokens`、`cached_tokens` 和可用的 `cache_write_tokens`。OpenAI 官方 GPT-5.6 及后续支持显式断点的暖请求必须命中前导稳定前缀；Codex GPT-5.6 及后续请求必须以首个 developer input 承载合并 system 文本，不发送 `instructions`、`prompt_cache_breakpoint` 或 `prompt_cache_options`，并如实记录后端机会性隐式缓存结果，不能把未报告的缓存写入或偶发命中推算成稳定缓存率。旧模型、未知模型和兼容 Provider 请求体不得出现显式断点字段。测试还必须验证 system/developer 前缀、完整工具定义或输出 schema 变化会切换缓存键，动态历史、记忆和当前输入变化不会改变稳定前缀键；协议映射前后的语义内容、非 system 输入顺序、图片、工具和输出 schema 必须一致。

涉及跨平台运行时还要执行 `./sunabot.sh doctor`，分别验证 Native Core + 多 NapCat Docker 与 Docker Core + 多 NapCat Docker 的启动、停止、单实例、管理台单账号“运行”、OneBot token、两个 QQ 同时在线、文字、图片、文件、账号定向外发和重启恢复。contract 与测试必须拒绝 NapCat 并入 Core、多个账号复用同一 WebUI 端口、OneBot 复用管理端口、跨组件共享绝对路径和旧新运行时并行。

## 12. 已知验收限制

`FLOW-001`、`FLOW-002`、`FLOW-003`、`MIG-001`、`MIG-002`、`RECOVERY-001` 与 `ONBOARD-002` 至 `ONBOARD-005` 的代码、故障注入和受控 E2E 已完成。真实 macOS Native Core + 多 NapCat Docker 与 Linux/WSL Docker Core + 多 NapCat Docker 的双 QQ 首次运行、账号定向文字/图片/文件外发和重启恢复仍需在具备两套运行环境与真实 QQ 登录态时执行；在该验收完成前，不能把受控 Provider/OneBot fixture 视为真实部署证据。
