# 2026-10-12 内置工具与表情操作验收

日期：2026-10-12（Asia/Shanghai）。范围：Windows 主机上的 WSL Ubuntu 24.04 Native Core、26 个内置工具、动态 MCP、表情 Workbench 操作。

独立夹具在 `/home/sunabot/sunabot-tool-repair-20261009` 使用 Node 24.18.0 执行，31 个测试文件、500 项测试全部通过。第一批 22 文件、347 项、16.63 秒；第二批 9 文件、153 项、4.30 秒。独立夹具未修改产品代码、未启动生产 Runtime、未写入生产业务数据、未调用外部 Provider 或真实 QQ；生产配置变更与运行记录由主 Agent 核验。

## 当前结论

- 表情存储、管理员图片导入、版本操作、跨 Agent 隔离与 mock 投递链均取得确定性成功证据。
- Native Bash 的真实 Bubblewrap 回归通过，包含超过 64 个宿主线程时执行 Bash、Node、Python，隔离内进程限额及健康探针资源限额。
- Bot 表情操作被独立审核路由阻断：`gpt-5.4-mini` 在当前 Codex 订阅返回 HTTP 400。两个 Agent 的 Bash `auditModel` 已通过认证管理台热更新为 `gpt-6-luna`，Plana 已启用的群聊编排模型也由 `gpt-5.4-mini` 改为 `gpt-6-luna`。Arona 既有 Tone 的 `gpt-6-luna` 成功记录支持模型选型；新审核路由尚未执行真实调用，不能将该 Tone 记录作为审核成功证据。
- 两个 Agent 的 `import_chat_emoji` 描述覆盖已通过管理台保存，过时的 Bash 禁令已移除。已通过真实 Bubblewrap 和生产表情消费者完成两版 PNG32 发布与读回；真实审核 Provider 下的完整链仍待验收。
- 两个 Agent 的 bundled `workbench-config` 已通过既有安装、审查和启用流程发布 PNG32 说明，摘要为 `8eafd2895e3e85f56a4bd4fbbe7873538c0a0807f74db9c0802619e3870e3acd`，来源仍为 bundled，双重审批通过。发布前通过管理台停用清除旧激活缓存，未手改摘要或审批记录。
- 生产近期存在 4 条 `read_skill_resource` 直接返回 `ok:true` 的记录，资源读取已取得真实运行成功证据。本报告不保留私有资源正文。
- Tavily key 在生产配置与运行环境中均缺失，网页搜索标记为 blocked；在线 voice profile 缺失，语音能力标记为 blocked。配置缺失与工具代码错误分别记录。
- `run_skill_script` 是现行规范明确关闭的产品能力。底层执行器测试通过不代表生产脚本工具可用。
- 两个生产 Agent 的 MCP server 数均为 0，stdio 关闭，OAuth vault key 未配置。该安全状态由主 Agent 本轮检查提供；动态 MCP 没有可执行别名，应记录“未配置/有意关闭”，不得计为调用成功。
- 当前证据不足以声称 26 个内置工具全部完成生产成功调用；真实搜索、生图、自拍、语音、Codex 和 QQ 外发仍需各自的执行证据。

## 验证状态

| 验证层 | 当前结果 | 验收判断 |
| --- | --- | --- |
| 独立工具定向回归 | 31 文件、500 项通过 | 本文列明的本地合同和隔离执行通过 |
| 主 Agent 定向回归 | 4 文件、70 项通过 | 单独记录，不与 500 项相加宣称去重覆盖 |
| 全量测试第一轮 | 3,059 通过、1 失败、1 跳过 | 未通过 |
| 全量测试第二轮 | 3,059 通过、1 失败、1 跳过 | 未通过 |
| 文件身份失败项单独重跑 | 通过 | 最初只用于分类，随后真实 WSL 元数据碰撞复现并修正夹具，未放宽断言 |
| 修复夹具后的受影响回归 | 2 文件、41 项通过 | 原错误码、拒绝和零外部读取断言保留 |
| 修复夹具后的全量 unit | 270 文件、3,060 项通过、1 项跳过 | 退出 0，136.98 秒 |
| 其余检查 | harness 37、integration 43、Skill sandbox 13、backup 45、migration 153、runtime smoke 84、E2E 53 项通过；benchmark、build 通过 | 各阶段退出 0；未重复完整 verify 命令 |
| 当前生产 doctor | live、ready、capability degraded；退出 1 | Bash、Core、OneBot、Renderer 通过；MCP stdio 和 OAuth vault 未配置，不计为就绪 |
| 新表情 Bash case 结构校验 | `workbench-resources.emoji-bash-roundtrip` 校验通过 | 可执行定义有效，尚无真实运行报告 |
| 新审核 Provider 实调 | 未执行，外部验收授权尚未收到回答 | 待授权；不能计为成功 |

当前本地验证阶段已逐项通过，首次完整 `npm run verify` 的失败日志保留；修复夹具后没有重跑整条命令。生产新审核调用与缺失配置的外部能力仍未验收，不能据此声称全部工具生产就绪。

## Arona 生产只读复核

2026-10-12 01:32（Asia/Shanghai），独立复核使用 SQLite `mode=ro` 与 `PRAGMA query_only=ON`，仅投影会话开关、工具禁用列表、调用时间及直接结果字段。没有构造 Runtime、调用模型或读取消息正文，群标识在此省略。

| 会话 | 回复开关 | 群聊编排开关 | disabledTools | 账号归属 |
| --- | --- | --- | --- | --- |
| 当前关注群 | 开启 | 关闭 | 未设置 | 与指定 Arona 账号一致 |
| 历史两次 Bash 失败群 | 开启 | 开启 | 未设置 | 与指定 Arona 账号一致 |

两个群均没有会话级 `native_bash`、Skill 资源读取或表情导入禁用项。关注群的编排开关关闭是该会话设置，不能解释另一个群的审核 HTTP 400。

| 时间（Asia/Shanghai） | 类别 | 工具/阶段 | 直接结果 |
| --- | --- | --- | --- |
| 2026-10-12 00:59:54.919 | `tool.call` | `read_skill_resource` | `response.ok=true` |
| 2026-10-12 00:59:57.578 | `tool.call` | `read_skill_resource` | `response.ok=true` |
| 2026-10-12 01:00:01.445 | `model.response` | `bash_audit` | `response.ok=false`，HTTP 400 |
| 2026-10-12 01:00:01.446 | `tool.call` | `native_bash` | `response.ok=false`，`exitCode=null`，`timedOut=false`；已知错误码 `BASH_AUDIT_UNAVAILABLE` |
| 2026-10-12 01:01:53.534 | `tool.call` | `read_skill_resource` | `response.ok=true` |
| 2026-10-12 01:01:56.290 | `tool.call` | `read_skill_resource` | `response.ok=true` |
| 2026-10-12 01:02:02.170 | `model.response` | `bash_audit` | `response.ok=false`，HTTP 400 |
| 2026-10-12 01:02:02.171 | `tool.call` | `native_bash` | `response.ok=false`，`exitCode=null`，`timedOut=false`；已知错误码 `BASH_AUDIT_UNAVAILABLE` |

两条 Bash 工具结果均属于历史失败群。截止该只读快照，最新审核记录仍是 01:02 的失败，没有发现热更新后自然用户流量产生的新 `bash_audit` 成功，也没有新的 `native_bash` 成功结果。因此继续保留“配置已生效，新审核调用未验证”的结论。

## 26 个工具验收矩阵

“本地通过”仅适用于表格列明的执行层。mock Provider、注入端口、已排队和工具注册均不能替代实际外部服务完成。未执行为“未验证”，依赖缺失为“blocked”，规范关闭为“有意不可用”；后两项均不计入生产成功工具数。

除 `add_workmemory`、`add_user_profile` 外，工具还受 Agent 开关、当前提示词、会话工具选择与运行能力影响。两个记忆决策工具属于普通主回复轮的宿主固定能力，不通过通用工具开关停用。下表描述正常 QQ 会话；Web Chat 与特殊回调只在对应端口实际注入时拥有能力。

| 工具 | 会话权限与配置要求 | 本次成功证据 | 生产验收边界 |
| --- | --- | --- | --- |
| `assistant_text` | 当前轮提供中间消息投递端口 | Provider 工具组合与投递合同通过 | 未进行真实 QQ 外发 |
| `no_reply` | 当前轮允许静默结束 | 15 项终止/组合合同通过 | 按配置可能产生 poke，不能把无文本等同于无全部出站 |
| `memory_recall` | 当前轮提供记忆召回端口 | 工具执行器成功调用注入召回端口 | 该端口为 mock，未证明生产语义召回质量 |
| `add_workmemory` | 普通主回复轮绑定当前会话 | 18 项参数、执行端口与错误合同通过 | 未调用真实主对话 Provider |
| `add_user_profile` | 普通主回复轮绑定当前发言者 | 8 项；隔离画像更新和称呼顺序保留 | 未调用真实主对话 Provider |
| `read_air` | 普通主回复轮提供 AIR 端口 | 7 项工具调用合同通过 | 未验生产 AIR 更新质量 |
| `knowledge_search` | 当前 Agent 知识端口可用 | 2 项；执行器调用检索端口成功 | 该工具测试使用注入端口，未验生产知识资料命中 |
| `websearch` | 搜索配置、服务凭据与网络可用 | 9 项本地搜索请求/解析合同通过 | blocked：生产配置及环境均无 Tavily key；未执行外部搜索 |
| `webfetch` | 网页读取能力；动态抓取另需 Renderer | 20 项本地抓取合同通过 | 本批未验生产外网及动态 Renderer |
| `generate_img` | 启用且有可用生图 Provider；不支持 custom Provider | 6 项质量、参考图、取消和参数传递通过 | 未获得真实生成图片 |
| `selfie` | 自拍能力、生图 Provider、参考资源可用 | 本批没有自拍生成成功证据 | 未验证；不能以参考图库可读代替生成 |
| `read_file` | 管理员 QQ 私聊 | 真实临时文件读取、编码、路径和 Agent 隔离通过 | Web Chat、群聊、普通私聊缺少此端口属于权限限制 |
| `write_file` | 管理员 QQ 私聊 | 真实临时文件原子写入、并发和权限失败测试通过 | 同上；不能据此推断当前生产目录可写 |
| `export_chat_media` | QQ 当前或明确引用消息提供受控媒体句柄 | 工具执行器成功调用导出端口 | 本批未单独执行真实导出存储套件 |
| `import_chat_emoji` | 管理员 QQ 私聊/群聊，当前或引用图片句柄 | 真实临时 PNG/GIF 导入、1024 像素、摘要命名、幂等、JSONL 回读通过；两个 Agent 已保存无过时 Bash 禁令的描述 | 描述已更新，未验证更新后的生产调用及模型选择 |
| `import_chat_selfie` | 管理员 QQ 私聊/群聊，受控图片及允许格式 | 真实临时参考图与 `references.jsonl` 发布成功 | 未验证生产当轮导入 |
| `send_file` | 当前 QQ 会话提供资产投递能力 | mock 投递合同与表情投递链通过 | queued 不算远端送达，真实 QQ 未验 |
| `send_voice_message` | 当前 Agent 配置可用在线音色、语言与会话投递能力 | 参数和语音伴随回复合同通过 | blocked：在线 voice profile 缺失；未证明真实合成或投递成功 |
| `native_bash` | Linux/WSL 合法会话、已启用、独立审核和 Bubblewrap 可用 | 真实沙箱 3 项、会话 wiring 30 项通过；两个 Agent 的 auditModel 已热更新为 `gpt-6-luna` | 新审核路由未实调；既有 Tone 成功不能代替审核成功 |
| `codex` | 管理员、启用、CLI/授权可用；worker/control 按上下文选择 | 30 项 supervisor、app-server、生命周期合同通过 | 主要使用注入进程/端口，真实任务未验 |
| `activate_skill` | 当前 Agent 有已启用、已审批且摘要匹配的 Skill | bundled Skill 安装通过；运行时激活成功 | 激活 reader 为 mock，不能代替完整生产资源链 |
| `read_skill_resource` | 当前会话已激活 Skill，资源属于受控清单 | 本地目录和端口合同通过；生产近期 4 条调用直接返回 `ok:true` | 已有真实资源读取成功证据；未证明新表情 Bash case 整链完成 |
| `run_skill_script` | 当前默认组合根明确关闭 | 不提供执行端口的回归通过；底层执行器 14 项通过 | 有意不可用，不计为生产执行成功 |
| `system_config` | 管理员 QQ 私聊可查询/修改；管理员 Web Chat 仅查询 | service 30 项、runtime 20 项；隔离提交、held outbox 与恢复通过 | Web Chat 修改返回 durable-delivery-required；无表情 CRUD 操作 |
| `cron` | 所有群聊；管理员私聊/Web Chat | 11 项；隔离 CRUD、revision CAS、账号定向回调通过 | 未进行真实定时 QQ 外发 |
| `call_director` | 当前 Agent Director 开启且本轮允许 | 2 项标准化请求与端口调用通过 | 真实导演模型、日程生成质量未验证 |

## 动态 MCP

生产两个 Agent 均未配置 server，因此没有 ready 的 `mcp__<server>__<tool>` 别名。stdio 关闭与缺少 OAuth vault key 分别属于当前配置状态，不构成“已有 MCP 工具全部执行失败”的证据。无 OAuth key 也不自动等同于全部无认证 HTTP MCP 都不能实现；本实例当前没有 server，不能验证这类连接。

本次 `mcp-host` 43 项与 runtime extensions 16 项包含 mock 客户端工具调用成功、当前 Agent/server 绑定、审批、别名失效和普通用户权限测试。普通用户只获得 `ordinaryUserAllowed` 的别名；管理员仍按 server/tool 的审批模式执行。未连接真实 MCP server，mock 成功不记为生产 MCP 成功。

## Skill 脚本未接线的判断

这是明确的现行产品限制。`docs/specs/03-providers-prompts-and-tools.md` 的 Skill 条款直接规定当前组合根不注册 `run_skill_script`，并说明现有安装审查、摘要投影、只读 Workbench、无网络隔离等属于未接线基础模块，所有平台默认关闭 capability。`docs/specs/08-validation.md` 要求默认组合根不得提供 `runScript` 端口，伪造调用必须在读取、投影、沙箱之前返回 unavailable。

当前实现与这些具体条款一致：

- `services/tools/skillRuntimeTool.ts` 的 `BUILTIN_SKILL_TOOL_CAPABILITIES.runScript` 为 `false`。
- `src/runtime/agentExtensions.ts` 只组装 Skill 激活与资源读取端口。
- `services/extensions/skillActivation.ts` 中的可选脚本执行链在缺少 executor、激活或受控脚本资源时返回 unavailable。
- `adapters/filesystem/agentSkillScriptExecutor.ts` 已实现独立审核、包/脚本摘要复验、投影、执行和清理；缺少审核 runner 时在读取包之前抛出 `SKILL_SCRIPT_AUDIT_UNAVAILABLE`。这些模块存在不等于默认运行时已经交付脚本能力。

规范写明的未完成条件是：无法证明目标脚本不通过解释器、模块加载、`source`、直接可执行文件或其他进程入口执行第二段未审计代码。未来启用需要固定且可证明的单段执行模型、覆盖实际执行字节的独立审核与一次性审批，以及对应零副作用负例。本次只分析，没有新增限制，也没有修改接线。

验证模块末尾原有“Native 审核执行器与平台隔离探针可用时开放”的概括表述，本轮已统一为当前所有平台不注册 `run_skill_script`，与具体规范及现有接线一致；未启用执行器或新增产品限制。

## 表情操作入口与补充 case

`system_config` 的 7 个操作为 `get_settings`、`get_status`、`list_groups`、`set_auto_reply`、`set_orchestrator`、`set_search`、`set_group_reply`，没有表情 CRUD。请求该工具修改表情会发生参数拒绝，不能通过虚构操作解决。

`import_chat_emoji` 面向当前或明确引用的聊天图片。已有 Workbench 表情的整理、重命名、版本调整属于当前 `workbench-config` 所描述的资源操作，应使用本轮实际暴露的 Bash 能力。当前文档允许维护已验证本地 PNG/GIF 与 `emoji/emojis.jsonl`，要求保持现有格式、限额、摘要命名、原子替换和消费者回读。清单 2 MiB 限额不包含被引用图片的累计字节数。

| 补充 case | 输入与执行 | 必须保留的成功证据 |
| --- | --- | --- |
| 表情 Bash 往返 | 管理员私聊；临时 canonical Workbench 中两个合成 1024×1024 图片和有效 JSONL；真实 Bash 完成重命名或新增版本、摘要比较、原子替换 | Bash exit 0、文件权限与摘要、repository 回读、旧版本及其他 key 保留、另一 Agent 无变化；仅 touch 成功不够 |
| 聊天图片导入后维护 | 管理员群聊；原始 OneBot 内联图片进入隔离链，导入后通过 Bash 维护同一资源，再 mock 投递 | 每步成功 tool.call、真实图片及 JSONL、相同 Agent/root、准确出站目标；导入排队不等于完成 |
| 设置与资源入口 | 管理员私聊；查询 system_config，再通过实际可用的 Skill/Bash 或当前图片导入工具完成表情任务 | 查询成功且不虚构 emoji operation；工具缺失、审核失败、目录权限失败分别归因；blocked 不计为完成 |
| Skill 资源读取 | 隔离安装并激活 bundled Skill，调用实际资源读取链读取已登记 reference | 返回字节与磁盘内容一致、digest 与权限有效、调用成功；目录枚举不代替读取 |

涉及真实主对话或 Bash 审核 Provider 的 live harness 仍需满足已授权范围，使用全新隔离 workspace 与 mock MessagingPort。真实 QQ 外发独立验收。

### 新增表情 Bash case 质量复核

`docs/user-tests/cases/workbench-resources/emoji-bash-roundtrip.md` 已通过 harness 的 `validate`，本次仅校验和评审，没有执行 Provider。

该 case 明确使用管理员群聊、原始 OneBot ingress、全新隔离 workspace、已批准的 Workbench Skill、真实独立审核和 Native Bash。合成图片在本地创建，无需读取生产媒体；必需工具为 `activate_skill`、`read_skill_resource`、`native_bash`、`send_file`，出站必须包含 mock asset，禁止联网搜索、生图、自拍和语音工具。预期要求真实命令结果、表情清单及图片校验、消费者回读和诚实回复，符合本次故障的验收目标。

实际运行时仍须完成以下核验，缺少任一项不得封为通过：

- 预检隔离环境中的 `convert`、审核 Provider 与 Skill 资源可用；依赖缺失记为 blocked。
- 保存独立审核成功、Bash exit 0 和工具完成结果，不能只保留工具目录、命令文本或 queued。
- 由生产表情 repository 读取生成的清单与图片，确认 key、实际字节 SHA-256、摘要文件名、1024×1024 尺寸及版本有效。该项在 case 中属于独立质量检查，harness 的 requiredTools 断言不会自动完成。
- 检查 mock asset 的实际内容及原始账号/群目标，保证没有真实 QQ 外发。

此 case 覆盖从空的隔离资源树创建一个表情及返回结果，没有覆盖已有表情重命名、删除、跨 Agent 隔离或旧版本保留；这些范围继续使用相应确定性测试，不扩大该 case 的通过结论。

## 已执行测试清单

| 测试文件 | 通过数 |
| --- | ---: |
| `tests/unit/bundled-workbench-skill.test.ts` | 1 |
| `tests/unit/emoji-delivery-chain.test.ts` | 14 |
| `tests/unit/runtime-system-config.test.ts` | 20 |
| `tests/unit/mcp-host.test.ts` | 43 |
| `tests/unit/workbench-file-tool.test.ts` | 30 |
| `tests/unit/emoji-api-integration.test.ts` | 11 |
| `tests/unit/emoji-jsonl-store.test.ts` | 3 |
| `tests/unit/web-fetch-tool.test.ts` | 20 |
| `tests/unit/bash-wiring.test.ts` | 30 |
| `tests/unit/codex-tool.test.ts` | 30 |
| `tests/unit/no-reply-tool.test.ts` | 15 |
| `tests/unit/system-config-service.test.ts` | 30 |
| `tests/unit/add-user-profile-tool.test.ts` | 8 |
| `tests/unit/tool-registry.test.ts` | 38 |
| `tests/unit/chat-media-tool-executor.test.ts` | 3 |
| `tests/unit/web-search-tool.test.ts` | 9 |
| `tests/unit/send-conversation-asset-tool.test.ts` | 7 |
| `tests/unit/knowledge-search-tool.test.ts` | 2 |
| `tests/unit/add-workmemory-tool.test.ts` | 18 |
| `tests/unit/generate-img-tool.test.ts` | 6 |
| `tests/unit/read-air-tool.test.ts` | 7 |
| `tests/unit/call-director-tool.test.ts` | 2 |
| `tests/integration/native-tool-sandbox.test.ts` | 3 |
| `tests/unit/provider-tool-composition.test.ts` | 69 |
| `tests/unit/chat-media-runtime.test.ts` | 5 |
| `tests/unit/memory-v2.test.ts` | 8 |
| `tests/unit/skill-script-executor.test.ts` | 14 |
| `tests/unit/runtime-agent-extensions.test.ts` | 16 |
| `tests/unit/runtime-scheduled-tasks.test.ts` | 11 |
| `tests/unit/voice-companion.test.ts` | 9 |
| `tests/unit/workbench-file-provider.test.ts` | 18 |
| **合计** | **500** |

以上结果不替代新生产审核路由的真实调用、真实 Provider harness、Windows 原生运行支持、arm64 验收或真实 NapCat/QQ 送达。两次早期全量失败已定位为夹具的快速原地修改/目录恢复与 WSL 元数据时间粒度碰撞，修正文件状态准备后全量 unit 通过；产品完整性检查和拒绝断言没有放宽。详细复现见文件权限审计。错误注入测试通过只证明对应失败合同可控，不能消除未执行层的验收要求。
