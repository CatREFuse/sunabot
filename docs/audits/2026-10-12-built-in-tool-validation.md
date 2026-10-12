# 2026-10-12 内置工具与表情操作验收

日期：2026-10-12（Asia/Shanghai）。范围：Windows 主机上的 WSL Ubuntu 24.04 Native Core、26 个内置工具、动态 MCP、表情 Workbench 操作。

当前结论：26 个内置工具中，已配置且开放的 23 个已通过真实 Provider、隔离合成输入、生产入站/Session/tool/outbox 链和独立质量验收。`websearch` 缺 Tavily 凭据，`send_voice_message` 缺在线 voice profile，`run_skill_script` 按现行规范关闭；这 3 项不计为成功。动态 MCP 不属于这 26 个内置工具，当前 server 数为 0。

授权前的本地检查基线在 `/home/sunabot/sunabot-tool-repair-20261009` 使用 Node 24.18.0 执行：31 个测试文件、500 项测试通过，第一批 22 文件、347 项、16.63 秒，第二批 9 文件、153 项、4.30 秒。该阶段没有修改产品代码、启动生产 Runtime、写入生产业务数据或调用外部 Provider/真实 QQ。后续已授权的真实 Provider 验收与生产部署分别记录如下，不能以基线阶段的“未执行”描述替代当前结果。

## 授权后的真实 Provider 验收

用户已授权现有外部服务的隔离合成验收。所有 run 使用全新 marker workspace、默认模板和合成人格；明确的自拍 A→B 状态链例外仅保存该链合成参考。没有向真实 QQ 发送消息，没有外发生产人格、历史或记忆。独立 fixture Agent 复核机械断言、文件及输出质量，随后 seal/gate。

| 用例 | 机械断言 | 结果及主要证据 |
| --- | --- | --- |
| 管理员文件闭环 | 23/23 | read_file、write_file、真实审核 native_bash、send_file 成功；33 B 与 mock 投递一致 |
| 普通用户编码修复 | 17/17 | 真实隔离 Python 失败→修改→成功，282 B 归档实际交付 |
| Bash 表情发布 | 23/23 | activate_skill、read_skill_resource、3 次 gpt-6-luna 审核和 Bash 均成功；repository 回读 1024² PNG32、6,570 B，发送字节一致 |
| 记忆与 AIR | 22/22 | 真实召回、66 B 长期约定直写工作记忆、AIR 更新成功 |
| 用户画像 | 22/22 | 原称呼保留、新偏好保存；未把 skip 声称为工作记忆写入 |
| 静默与戳一戳 | 18/18 | 仅隔离 pokeOnNoReply=true，1 次 poke，零其他外发 |
| 设置查询与 cron | 20/20 | 查询成功，一次性任务只写隔离 SQLite；该用例未运行导演 |
| 知识库 gpt-6.1-sol | 19/19 | 3 次工具结果成功，错误 0，源第 3 行、检索结果与回复一致 |
| 群聊图片资源导入 | 27/27 | emoji 与自拍参考专用导入成功，消费者重载通过，无 Bash 调用 |
| 媒体导出与投递 | 26/26 | 真实空末轮触发新收尾路径，1 条进度及 1 份 68 B 原件；无重复或异常，2 outbox sent |
| 静态 WebFetch | 28/28 | IANA 页面、fetchMode=static、证据政策保留、3 项事实正确 |
| 导演修订 | 27/27 | 自然生成 rev1→修订 rev2，5 项已开始事项逐字段保留，下一项改为20分钟 |
| 合成自拍 A→B | 26/26、28/28 | 唯一合成参考导入后真实自拍成功；1024²、934,165 B。模拟端记录描述符，另独立重放生产 OneBot 编码器核对 Base64 字节；未实发 QQ |
| 明确正方形构图的生图重测 | 20/20 | 1024²、460,207 B；全1,048,576像素不透明，形状/颜色及全白构图达标，独立质量4/5/5；原失败保留 |
| 新版 Codex 文件回传 | 22/22 | CLI 0.162.1 / worker gpt-5.6-sol 成功，冻结输入、产物和 mock 文件均33 B且摘要相同 |

上述 run 的独立质量和 seal/gate 均通过。知识库旧 gpt-6-luna run 出现过重复记忆决策后恢复；新版主模型复测没有该错误。双导入与媒体用例原输入未明示禁用辅助 Bash，后补齐输入并 fresh 重测，没有删除原失败。旧图像纯白背景用例虽然异步完成且20/20机械断言，但有50%透明留边，质量3/5/5，保持失败；明确方形构图的独立重测通过20/20与质量4/5/5，不能以单次成功保证上游任何构图都确定输出。

确认并修复的代码问题为：隔离准备的 Codex auth 默认路径及空覆盖；显式 CLI 模型路由缺失；已投递文字后的空末轮被当作失败；固定 CLI 0.139.0 无法执行现有 gpt-5.6-sol。最后一项实测 HTTP 400 明确要求新版，完整官方及 npm 0.162.1 包已验证包含 code-mode host，并取得真实隔离聊天文件往返成功，未替换生产 worker 模型。

凭据到期后的刷新路径已修复并完成复审：刷新 helper 优先使用受管 CLI 配置；launcher 仅在未配置时补充默认项目 CLI 绝对路径，保留 runtime/env 的既有显式覆盖，inspect 版本检查与 Core 使用同一最终值；probe 使用 Node createRequire 解析项目 CLI 包，source/dist 两种入口均正确，显式环境 CLI 优先。`CODEX_AUTH_REFRESH_UNAVAILABLE` 保留原错误，不再被转换为 credential missing。相关定向测试 68 项通过、1 项既有跳过。

Tavily 凭据、在线 voice profile、MCP server 仍未配置；run_skill_script 仍按规范关闭。动态 WebFetch 只有 Native Renderer 隔离/健康/鉴权预检成功，完整生产端到端未覆盖。当前 Windows/WSL amd64 的成功不能代替 Windows 原生或真实 arm64 运行。

凭据刷新修复前最近一次已确认的完整 `npm run verify` 退出 0：270 文件、3,089 项 unit 通过、1 项既有跳过；harness 39、integration 43、Skill sandbox 13、backup 45、memory migration 153、runtime smoke 84、E2E 53 全部通过，运行合同、架构、类型检查、benchmark 和 build 通过。该退出结果已由工具输出确认。原 `/tmp/20261012-final-upgraded-tools-verify.log` 及此前 `/tmp` 失败、复测日志已随 WSL 停机后重启清空，当前不再保留；不能将历史日志路径当作现存证据。

凭据刷新修复后的一轮 verify 因复审发现 CLI 配置一致性问题而有界中止，日志与 abort 状态保留。修正后完整 verify 为 3,091 项 unit 通过。末轮复审另复现并修复 OpenAI Responses 的明确失败、无明细失败及空 incomplete 被误判完成的问题，3 项负例均先失败后通过，相关 114 项回归及独立 6 场景复审通过。

最终冻结版本完整 `npm run verify` 于 2026-10-12 12:36:35 退出 0：270 文件、3,094 项 unit 通过、1 项既有跳过；harness 39、integration 43、Skill sandbox 13、backup 45、memory migration 153、runtime smoke 84、E2E 53 全部通过，累计 3,524 项通过。运行合同、架构、类型检查、benchmark 和 build 通过；没有 UI 改动，本轮未单独执行 visual suite。持久日志为隔离 checkout `.user-test-runs/completion-final-verify-1791779204271528343.log`，同名 `.status.json` 为 passed / exitCode 0；前轮日志不挪作最终证据。

## 当前生产部署与恢复边界

最终四文件补丁已完成停服、四库备份、应用、完整 build 与官方 `up`，各阶段退出 0。2026-10-12 12:41:17 独立只读复核：Core HTTP 200 / live=true，启动探针 ready；新 Core 自动取得受管 CLI 路径并解析现存 0.162.1，生产 dist 已包含包解析和响应失败修复。MCP 缺配置使 capability degraded，不能称全部可选能力就绪。Arona CheckLoginStatus code=0 / isLogin=false，OneBot 建立连接为 0；登录缓存没有清空，早前快速登录明确报告登录态失效且无 kick/冲突标记。管理台自动更新的二维码等待手机扫码；没有验证真实 QQ 外发。只读证据位于隔离 `.user-test-runs/production-final-readonly-20261012-KE6Vde/status-safe.json`。

最终部署另保留四个任务源码及 dist 于 `/home/sunabot/sunabot/workspace/backups/tool-final-repair-20261012-1791779860554628189`，对应一致恢复点为 `/home/sunabot/sunabot/workspace/backups/sqlite-recovery/sqlite-recovery-20261012T043844094Z-f9cacf28`，create/verify 成功且包含四库。该末次部署前后 auth 摘要一致；此前通过 app-server 的正常刷新独立记录，不将正常凭据轮换描述为全程字节不变。

回滚目录 `/home/sunabot/sunabot/workspace/backups/tool-deployment-20261012-034514` 保留原 source、dist、CLI 与 `sqlite-backup.log`。备份 create 返回 `ok:true`，实际数据库恢复点另存于 `/home/sunabot/sunabot/workspace/backups/sqlite-recovery/sqlite-recovery-20261012T034618660Z-32d4e4c9`；manifest.databases 共 4 个数据库，覆盖两 Agent 各自的业务库与队列库。停服一致恢复点的 schema/invariants 校验由创建命令 verify 成功，数据库本体不位于 source 回滚目录。原 auth 已正常刷新，没有删除 QQ 缓存或改写生产人格、历史。

私有最终证据均位于隔离 checkout `.user-test-runs/`：`platform-live-20261012.Q1IERb`、`platform-live61-20261012.HOHkxX`、`emoji-bash-file-audit-20261012-1791772289210`、`fixture-final-1791772864804266786`、`fixture-retest-1791772374652161120`、`fixture-knowledge-sol-1791776042793857456`、`fixture-imports-retest-1791774165295576504`、`fixture-export-fixed-1791775730913860251`、`external-file-audit-20261012-1791772992195`、`fixture-director-1791774713707546837`、`fixture-selfie-chain-1791774726136140279`、`platform-codex162-roundtrip-20261012.jSu0Xu`。凭据、数据库、图片及完整请求报告不加入 Git。

## 历史基线：外部验收前的本地检查

- 表情存储、管理员图片导入、版本操作、跨 Agent 隔离与 mock 投递链均取得确定性成功证据。
- Native Bash 的真实 Bubblewrap 回归通过，包含超过 64 个宿主线程时执行 Bash、Node、Python，隔离内进程限额及健康探针资源限额。
- Bot 表情操作被独立审核路由阻断：`gpt-5.4-mini` 在当前 Codex 订阅返回 HTTP 400。两个 Agent 的 Bash `auditModel` 已通过认证管理台热更新为 `gpt-6-luna`，Plana 已启用的群聊编排模型也由 `gpt-5.4-mini` 改为 `gpt-6-luna`。该基线当时仅有 Arona Tone 的 `gpt-6-luna` 成功记录，不能代替审核成功；后续真实 Bash 审核已返回 HTTP 200 allow，并通过表情发布用例。
- 两个 Agent 的 `import_chat_emoji` 描述覆盖已通过管理台保存，过时的 Bash 禁令已移除。该阶段已通过真实 Bubblewrap 和生产表情消费者完成两版 PNG32 发布与读回；后续真实审核 Provider 下的完整链已通过 23/23 与独立质量验收。
- 两个 Agent 的 bundled `workbench-config` 已通过既有安装、审查和启用流程发布 PNG32 说明，摘要为 `8eafd2895e3e85f56a4bd4fbbe7873538c0a0807f74db9c0802619e3870e3acd`，来源仍为 bundled，双重审批通过。发布前通过管理台停用清除旧激活缓存，未手改摘要或审批记录。
- 生产近期存在 4 条 `read_skill_resource` 直接返回 `ok:true` 的记录，资源读取已取得真实运行成功证据。本报告不保留私有资源正文。
- Tavily key 在生产配置与运行环境中均缺失，网页搜索标记为 blocked；在线 voice profile 缺失，语音能力标记为 blocked。配置缺失与工具代码错误分别记录。
- `run_skill_script` 是现行规范明确关闭的产品能力。底层执行器测试通过不代表生产脚本工具可用。
- 两个生产 Agent 的 MCP server 数均为 0，stdio 关闭，OAuth vault key 未配置。该安全状态由主 Agent 本轮检查提供；动态 MCP 没有可执行别名，应记录“未配置/有意关闭”，不得计为调用成功。
- 授权前证据尚不足以覆盖全部外部能力。后续生图、自拍与 Codex 已取得上表真实隔离成功证据；当前 23/26 成功与 3 项缺配置/规范关闭的边界见现行矩阵，真实 QQ 外发仍未验收。

## 历史基线：外部验收前的验证状态

| 验证层 | 当时结果 | 当时验收判断及后续变化 |
| --- | --- | --- |
| 独立工具定向回归 | 31 文件、500 项通过 | 本文列明的本地合同和隔离执行通过 |
| 主 Agent 定向回归 | 4 文件、70 项通过 | 单独记录，不与 500 项相加宣称去重覆盖 |
| 全量测试第一轮 | 3,059 通过、1 失败、1 跳过 | 未通过 |
| 全量测试第二轮 | 3,059 通过、1 失败、1 跳过 | 未通过 |
| 文件身份失败项单独重跑 | 通过 | 最初只用于分类，随后真实 WSL 元数据碰撞复现并修正夹具，未放宽断言 |
| 修复夹具后的受影响回归 | 2 文件、41 项通过 | 原错误码、拒绝和零外部读取断言保留 |
| 修复夹具后的全量 unit | 270 文件、3,060 项通过、1 项跳过 | 退出 0，136.98 秒 |
| 其余检查 | harness 37、integration 43、Skill sandbox 13、backup 45、migration 153、runtime smoke 84、E2E 53 项通过；benchmark、build 通过 | 各阶段退出 0；未重复完整 verify 命令 |
| 该阶段生产 doctor | live、ready、capability degraded；退出 1 | Bash、Core、OneBot、Renderer 通过；MCP stdio 和 OAuth vault 未配置，不计为就绪 |
| 新表情 Bash case 结构校验 | `workbench-resources.emoji-bash-roundtrip` 校验通过 | 当时仅结构校验；后续真实运行 23/23 与独立质量通过 |
| 新审核 Provider 实调 | 当时未执行，尚未获得外部验收授权 | 后续授权后真实审核 HTTP 200 allow；已计入当前成功证据 |

本表保留授权前阶段的历史结果。当时修复夹具后仅逐项执行剩余阶段，随后另有完整 verify 退出 0 和真实 Provider 验收；当前凭据刷新修复后的完整 verify 已因审查问题有界中止并请求重跑，尚未取得最终结果。早期 `/tmp` 原始日志已清空，不能声称仍可读取；现存 `.user-test-runs/` 密封报告继续保留。

## 历史快照：Arona 生产只读复核

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

两条 Bash 工具结果均属于历史失败群。截至 01:32 只读快照，尚无热更新后自然用户流量的新审核成功记录；这只描述该快照，不能否定随后隔离合成链中已完成的真实 `bash_audit` 与 `native_bash` 成功。当前也没有据此宣称真实生产会话已完成 QQ 外发验收。

## 当前 26 个内置工具验收矩阵

当前为 23/26 成功：只计算实际成功 `tool.call`、持久化或真实产物、独立质量评审及 seal/gate 均通过的隔离合成 run。真实 Provider 执行与 mock MessagingPort 同时使用；mock 只替代 QQ 传输，没有用 mock 模型、端口注入、工具注册或 queued 代替外部完成。每行的成功只覆盖列明用例，全部真实 QQ 发送尚未验收。

除 `add_workmemory`、`add_user_profile` 外，工具仍受 Agent 开关、提示词、会话选择与运行能力影响。两个记忆决策工具属于普通主回复轮的宿主固定能力。下面的权限描述适用于正常 QQ 会话，Web Chat 和特殊回调以实际注入端口为准。

| 工具 | 会话权限与配置要求 | 当前真实 Provider 隔离合成证据 | 当前验收边界 |
| --- | --- | --- | --- |
| `assistant_text` | 当前轮提供中间投递端口 | 通过：媒体导出 26/26，1 条真实进度＋68 B 原件，空末轮无重复或错误 | mock outbox 成功；真实 QQ 未验 |
| `no_reply` | 当前轮允许静默结束 | 通过：静默用例 18/18，只有隔离配置允许的 1 次 poke | 不将静默等同于无全部出站；真实 QQ poke 未验 |
| `memory_recall` | 当前轮提供召回端口 | 通过：记忆/AIR 用例 22/22，真实召回与回复质量通过 | 合成隔离记忆；未外发生产记忆 |
| `add_workmemory` | 普通主回复轮绑定当前会话 | 通过：记忆/AIR 用例 22/22，66 B 长期约定实际写入工作记忆 | 真实 record 成功；其他用例的 skip 不计为写入 |
| `add_user_profile` | 普通主回复轮绑定当前发言者 | 通过：画像用例 22/22，原称呼保留、新偏好持久化 | 合成隔离画像；未修改生产画像 |
| `read_air` | 普通主回复轮提供 AIR 端口 | 通过：记忆/AIR 用例 22/22，AIR 实际更新及质量通过 | 合成隔离 AIR；未修改生产 AIR |
| `knowledge_search` | 当前 Agent 知识端口可用 | 通过：gpt-6.1-sol 用例 19/19，源第 3 行、结果与回复一致 | 合成知识资料；不宣称覆盖所有生产资料 |
| `websearch` | Tavily 凭据及网络可用 | blocked：生产配置与环境缺 Tavily key；本地请求/解析合同通过 | 未执行真实外部搜索，不计成功 |
| `webfetch` | 网页能力可用；动态抓取另需 Renderer | 通过：静态 IANA 用例 28/28，fetchMode=static、证据政策及 3 项事实一致 | 动态 WebFetch 仅 Renderer 预检，端到端未验 |
| `generate_img` | 启用且有可用生图 Provider | 通过：独立方形白底重测 20/20、质量 4/5/5，1024²、460,207 B，全像素不透明 | 原 50% 透明留边用例保持失败；不保证任意构图确定输出 |
| `selfie` | 生图 Provider、自拍参考与改写能力可用 | 通过：合成 A→B 链 26/26、28/28，实际自拍 1024²、934,165 B | 仅合成参考；mock 描述符与独立 OneBot 编码字节核对通过，真实 QQ 未验 |
| `read_file` | 管理员 QQ 私聊 | 通过：管理员文件用例 23/23，原始入站后实际读取 Workbench 文件 | 群聊、普通私聊、Web Chat 缺端口为权限限制 |
| `write_file` | 管理员 QQ 私聊 | 通过：管理员文件用例 23/23，隔离 Workbench 原子写入并读回 | 未扩大可写根或会话权限 |
| `export_chat_media` | 当前或明确引用消息的受控媒体句柄 | 通过：媒体用例 26/26，68 B 原件实际导出并 mock 投递 | 限当前合成媒体；真实 QQ 未验 |
| `import_chat_emoji` | 管理员私聊/群聊、有绑定图片 | 通过：群聊资源导入 27/27，专用导入与消费者重载成功 | 原始 OneBot 合成图片；生产资源未写入 |
| `import_chat_selfie` | 管理员私聊/群聊、有绑定图片 | 通过：群聊导入 27/27 与自拍 A 步 26/26，实际参考库可消费 | 不以图库可读替代 B 步真实自拍；真实 QQ 未验 |
| `send_file` | 当前 QQ 会话有可靠资产投递端口 | 通过：管理员文件 23/23、Bash 表情 23/23、媒体导出 26/26，真实字节与 mock 目标一致 | queued 不算送达；真实 QQ 未验 |
| `send_voice_message` | 在线 voice profile、语言与投递能力可用 | blocked：在线 voice profile 缺失；本地伴随回复合同通过 | 未验证真实在线合成或 QQ 投递，不计成功 |
| `native_bash` | Linux/WSL 已启用、逐命令审核及 Bubblewrap | 通过：表情用例 23/23，3 次 gpt-6-luna HTTP 200 allow 与 Bash exit 0；管理员文件和普通用户编码也通过 | 仅获批业务命令；未放宽身份、路径或审核边界 |
| `codex` | 启用且有 CLI/授权；worker/control 按上下文选择 | 通过：CLI 0.162.1、worker gpt-5.6-sol 文件回传 22/22，输入/产物/mock 文件 33 B 摘要相同 | 证明 worker 文件链；不等于真实 QQ 或所有控制动作已验 |
| `activate_skill` | 已启用、已审批且摘要匹配的 Skill | 通过：Bash 表情用例 23/23，真实激活 bundled workbench-config | 本轮只覆盖已批准 bundled Skill |
| `read_skill_resource` | 当前会话已激活且资源在受控清单 | 通过：Bash 表情用例 23/23，实际 reference 成功读取；另有生产历史 4 次 ok:true | 不读取或公开私有资源正文 |
| `run_skill_script` | 当前规范关闭默认组合根能力 | 有意不可用：不注册 runScript 端口；拒绝与底层隔离合同通过 | 不计执行成功，不将基础模块存在视为开放能力 |
| `system_config` | 管理员 QQ 私聊；Web Chat 仅查询 | 通过：设置/cron 用例 20/20，真实查询成功 | 配置修改的 held 提交/恢复由确定性回归覆盖；不虚构表情 CRUD |
| `cron` | 所有群聊；管理员私聊/Web Chat | 通过：设置/cron 用例 20/20，一次性任务实际写隔离 SQLite | 未验证真实定时 QQ 外发 |
| `call_director` | 当前 Agent Director 开启且本轮允许 | 通过：导演用例 27/27，rev1→rev2，5 项已开始事项保留、下一项调整 | 仅合成隔离日程；真实分享 QQ 外发未验 |

23 项成功不包含缺 Tavily 的搜索、缺 voice profile 的语音及规范关闭的脚本工具。MCP server 数为 0，没有动态别名；MCP 不计入 26 个内置工具分母。

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

## 表情操作入口与历史补充 case 规划

`system_config` 的 7 个操作为 `get_settings`、`get_status`、`list_groups`、`set_auto_reply`、`set_orchestrator`、`set_search`、`set_group_reply`，没有表情 CRUD。请求该工具修改表情会发生参数拒绝，不能通过虚构操作解决。

`import_chat_emoji` 面向当前或明确引用的聊天图片。已有 Workbench 表情的整理、重命名、版本调整属于当前 `workbench-config` 所描述的资源操作，应使用本轮实际暴露的 Bash 能力。当前文档允许维护已验证本地 PNG/GIF 与 `emoji/emojis.jsonl`，要求保持现有格式、限额、摘要命名、原子替换和消费者回读。清单 2 MiB 限额不包含被引用图片的累计字节数。

| 补充 case | 输入与执行 | 必须保留的成功证据 |
| --- | --- | --- |
| 表情 Bash 往返 | 管理员私聊；临时 canonical Workbench 中两个合成 1024×1024 图片和有效 JSONL；真实 Bash 完成重命名或新增版本、摘要比较、原子替换 | Bash exit 0、文件权限与摘要、repository 回读、旧版本及其他 key 保留、另一 Agent 无变化；仅 touch 成功不够 |
| 聊天图片导入后维护 | 管理员群聊；原始 OneBot 内联图片进入隔离链，导入后通过 Bash 维护同一资源，再 mock 投递 | 每步成功 tool.call、真实图片及 JSONL、相同 Agent/root、准确出站目标；导入排队不等于完成 |
| 设置与资源入口 | 管理员私聊；查询 system_config，再通过实际可用的 Skill/Bash 或当前图片导入工具完成表情任务 | 查询成功且不虚构 emoji operation；工具缺失、审核失败、目录权限失败分别归因；blocked 不计为完成 |
| Skill 资源读取 | 隔离安装并激活 bundled Skill，调用实际资源读取链读取已登记 reference | 返回字节与磁盘内容一致、digest 与权限有效、调用成功；目录枚举不代替读取 |

涉及真实主对话或 Bash 审核 Provider 的 live harness 仍需满足已授权范围，使用全新隔离 workspace 与 mock MessagingPort。真实 QQ 外发独立验收。

### 表情 Bash case 的当前完成情况

`docs/user-tests/cases/workbench-resources/emoji-bash-roundtrip.md` 已通过结构校验、真实 Provider 执行、独立质量评审及 seal/gate：23/23 机械断言通过。授权前“仅校验、未执行”的记录已由后续真实运行补齐。

该 case 明确使用管理员群聊、原始 OneBot ingress、全新隔离 workspace、已批准的 Workbench Skill、真实独立审核和 Native Bash。合成图片在本地创建，无需读取生产媒体；必需工具为 `activate_skill`、`read_skill_resource`、`native_bash`、`send_file`，出站必须包含 mock asset，禁止联网搜索、生图、自拍和语音工具。预期要求真实命令结果、表情清单及图片校验、消费者回读和诚实回复，符合本次故障的验收目标。

真实运行已完成以下核验：

- 隔离环境的 `convert`、审核 Provider 与 Skill 资源可用，使用已批准的 bundled Skill。
- 保存 3 次真实 gpt-6-luna 审核 HTTP 200 allow、3 次 Bash exit 0 与成功工具结果，未以目录或 queued 代替完成。
- 由生产表情 repository 实际读回清单与 6,570 B、1024×1024 PNG32 图片，核对 key、版本、摘要文件名及实际 SHA-256，全部像素为不透明绿色。
- mock asset 字节与 repository 原图一致，原始账号/群目标正确；没有真实 QQ 外发。模型该次未执行 fsync，不能据此声称覆盖断电持久性。

此 case 覆盖从空的隔离资源树创建一个表情及返回结果，没有覆盖已有表情重命名、删除、跨 Agent 隔离或旧版本保留；这些范围继续使用相应确定性测试，不扩大该 case 的通过结论。

## 历史基线：授权前 500 项本地测试清单

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

本清单保留授权前本地合同覆盖，不与后续测试项简单相加宣称去重覆盖。真实 Provider 成功以本报告当前矩阵和密封报告为准；Windows 原生、arm64、动态 WebFetch 端到端及真实 NapCat/QQ 送达仍未验收。两次早期全量失败已定位为夹具快速原地修改/目录恢复与 WSL 元数据时间粒度碰撞，修正准备方式后通过；产品完整性检查和拒绝断言未放宽。详细复现见文件权限审计，原 `/tmp` 日志已清空。
