# 文件工具、资源权限与 Windows/WSL 审计

日期：2026-10-12（Asia/Shanghai）

## 结论

当前 Windows 主机通过 Ubuntu-24.04 WSL 运行 Native Core 与 Native 工具。已部署文件操作、Bubblewrap 隔离、Node/Python 执行及本地图片转换在隔离目录中通过冒烟验证；审计时 Arona 与 Plana 的表情资源完整，未发现文件所有权、读取权限或清单损坏造成的阻塞。

26 个内置工具中，当前已配置且开放的 23 个已通过真实 Provider 隔离合成链、独立质量评审及 seal/gate；Tavily 凭据缺失、在线 voice profile 缺失、run_skill_script 规范关闭的 3 项不计成功。MCP server 数为 0，动态 MCP 不计入 26 个内置工具。真实 QQ 外发、Windows 原生、arm64 与动态 WebFetch 端到端仍未验收。

生产中两次表情操作的直接阻塞点是独立 Bash 审核：2026-10-12 01:00、01:02 的 `native_bash` 返回 `BASH_AUDIT_UNAVAILABLE: independent audit failed`，未执行命令。主 Agent 核查对应审核请求，确认 `codex.complete` 使用 `gpt-5.4-mini`，收到 HTTP 400，错误为该模型不支持当前 ChatGPT 账号。该故障发生在执行文件命令之前，不能归为文件权限错误。

另有一处工具说明与已部署 Skill 的语义冲突，以及本地 PNG 格式要求的说明遗漏，可能影响模型选择和发布操作，需与审核 Provider 故障分别处理。Arona、Plana 的审核模型配置已热更新为 `gpt-6-luna`，冲突描述与 PNG32 说明已发布；基础检查阶段没有执行真实 Provider 请求；用户后续授权后的完整链路证据见下节。

## 授权后的完整链路复核

真实 gpt-6-luna Bash 审核已返回 HTTP200 allow，原始 OneBot ingress、Session、Provider、工具、outbox 与 mock 投递的表情用例23/23及独立质量通过。生成图为1024×1024、8-bit/color6、6,570 B，production repository实际读回并核对发送字节。模型该次发布没有执行 fsync，因此不能将这一真实 run 声称为覆盖断电持久性；前述确定性发布测试另有 fsync 证据。

专用群聊 emoji/selfie 导入27/27、原件导出26/26均通过。导出复测明确出现模型空末轮：已有进度与资产投递后，旧代码返回空内容错误，修复后无重复或异常；完全空输出、未成功投递、运输失败、空设置确认仍保留原错误。五种协议及普通Runtime分别有确定性回归。

另确认原固定CLI 0.139.0的现有worker模型gpt-5.6-sol返回“需要新版”。完整npm 0.162.1和必要helper已在隔离实例通过真实聊天文件回传，22/22及独立质量通过。测试准备也修复auth默认路径与空值，并允许显式锁定CLI模型，未放宽凭据复制和运行前漂移校验。

本节均使用合成内容与模拟 QQ 投递，不覆盖真实 QQ 出站、Windows 原生或 arm64。静态 WebFetch 已通过真实 IANA 页面验收，动态 WebFetch 仅取得 Native Renderer 隔离、健康和鉴权预检。生图原用例 50% 透明留边的质量失败保留，独立明确正方形全白不透明构图复测 20/20、质量 4/5/5 通过，不能保证任意上游构图确定输出。汇总矩阵、缺配置项及限制见[内置工具验收](./2026-10-12-built-in-tool-validation.md)。

## 当前部署、凭据修复与证据保留

凭据到期后的刷新路径已修复并完成复审：刷新 helper 优先使用受管 CLI 配置；launcher 仅在未配置时补充默认项目 CLI 绝对路径，保留 runtime/env 的既有显式覆盖，inspect 版本检查与 Core 使用同一最终值；probe 使用 Node createRequire 解析项目 CLI 包，source/dist 两种入口均正确，显式环境 CLI 优先。`CODEX_AUTH_REFRESH_UNAVAILABLE` 保留原错误，不再被转换为 credential missing。相关定向测试 68 项通过、1 项既有跳过。

凭据修复前最近已确认的完整 `npm run verify` 退出 0：unit 270 文件、3,089 项通过、1 项既有跳过，harness 39、integration 43、Skill sandbox 13、backup 45、memory migration 153、runtime smoke 84、E2E 53，以及运行合同、架构、类型检查、benchmark、build 均通过。

凭据刷新修复后的一轮 verify 因复审发现 CLI 配置一致性问题而有界中止，日志与 abort 状态保留；修正后完整 unit 3,091 项通过。最后另复现并修复 OpenAI Responses 明确失败、无明细失败及空 incomplete 被误判完成，相关 114 项回归与独立 6 场景复审通过。

最终冻结版本完整 `npm run verify` 于 2026-10-12 12:36:35 退出 0：unit 270 文件、3,094 项通过、1 项既有跳过，harness 39、integration 43、Skill sandbox 13、backup 45、memory migration 153、runtime smoke 84、E2E 53 全部通过，累计 3,524 项通过；运行合同、架构、类型检查、benchmark 与 build 通过。持久日志位于隔离 checkout `.user-test-runs/completion-final-verify-1791779204271528343.log`，同名状态为 passed / exitCode 0。没有 UI 改动，本轮没有单独执行 visual suite。

WSL 停机重启前的原 `/tmp` 日志已清空，不能声称仍保留；隔离 checkout `.user-test-runs/` 中的密封 reports 持久存在。

最终四文件补丁已完成停服、四库备份、应用、完整 build 与官方 `up`，各阶段退出 0。2026-10-12 12:41:17 独立只读复核：Core HTTP 200 / live=true，启动探针 ready；新 Core 自动取得受管 CLI 路径并解析现存 0.162.1，生产 dist 已包含包解析和响应失败修复。MCP 缺配置使 capability degraded，不能称全部可选能力就绪。Arona CheckLoginStatus code=0 / isLogin=false，OneBot 建立连接为 0；登录缓存没有清空，早前快速登录明确报告登录态失效且无 kick/冲突标记。管理台自动更新的二维码等待手机扫码；没有验证真实 QQ 外发。只读证据位于隔离 `.user-test-runs/production-final-readonly-20261012-KE6Vde/status-safe.json`。

最终部署另保留四个任务源码及 dist 于 `/home/sunabot/sunabot/workspace/backups/tool-final-repair-20261012-1791779860554628189`，对应一致恢复点为 `/home/sunabot/sunabot/workspace/backups/sqlite-recovery/sqlite-recovery-20261012T043844094Z-f9cacf28`，create/verify 成功且包含四库。该末次部署前后 auth 摘要一致；此前通过 app-server 的正常刷新独立记录，不将正常凭据轮换描述为全程字节不变。

回滚目录 `/home/sunabot/sunabot/workspace/backups/tool-deployment-20261012-034514` 保留原 source、dist、CLI 与 `sqlite-backup.log`。备份 create 返回 `ok:true`，实际数据库恢复点另存于 `/home/sunabot/sunabot/workspace/backups/sqlite-recovery/sqlite-recovery-20261012T034618660Z-32d4e4c9`；manifest.databases 共 4 个数据库，覆盖两 Agent 各自的业务库与队列库。停服一致恢复点的 schema/invariants 校验由创建命令 verify 成功，数据库本体不位于 source 回滚目录。原 auth 已正常刷新，没有删除 QQ 缓存或改写生产人格、历史。

## 历史基线：授权前审计范围与方式

- Windows 源码：`F:\sunabot`。
- 实际运行源码与产物：`/home/sunabot/sunabot`、其 `dist/`。
- 运行身份：`sunabot`，UID/GID 1000。
- 生产检查只读取资源入口、文件元数据和图片字节，用于摘要及尺寸验证；不读取或记录凭据、登录缓存或用户消息正文。
- 冒烟使用 `/tmp/sunabot-file-smoke-*` 下的全新临时 Agent 工作区，结束后删除该临时目录。
- 授权前审计与确定性冒烟没有在生产工作区构造 Runtime、执行迁移、Core/NapCat 重启、外发或真实 Provider 调用。该阶段生产写入仅为已备份的模型配置、工具说明及 bundled Skill 说明更新，未改业务数据库或表情清单；后续真实隔离验收、生产 build/up 与回滚结果另见前述当前段落。

审计依据为 `docs/specs/index.md` 及模块 03、04、06，结合 `conversationCapability.ts`、`replyContext.ts`、`workbenchFiles.ts`、Bash sandbox、文件存储实现和已发布 `workbench-config` Skill。

## 历史快照：生产文件与资源检查

两角色各自的 canonical Workbench 为：

```text
workspace/business/agents/<agentId>/workbench/
```

`index.md` 正确指向 `emoji/emojis.jsonl`、`selfie/references.jsonl`、`skills/index.json`、`knowledge/index.json`。没有指向旧 Workbench 的入口。

| 检查项 | Arona | Plana |
| --- | --- | --- |
| Workbench、emoji、skills 目录 | UID/GID 1000，0700，可读写 | UID/GID 1000，0700，可读写 |
| index.md、emojis.jsonl、skills/index.json | UID/GID 1000，0600，可读写 | UID/GID 1000，0600，可读写 |
| MCP 目录及 servers.json | UID/GID 1000，0700 / 0600 | UID/GID 1000，0700 / 0600 |
| 自拍 references.jsonl | UID/GID 1000，0644，可读写 | UID/GID 1000，0644，可读写 |
| 资源树异常 owner、符号链接、不可读文件 | 未发现 | 未发现 |
| 表情 key 数 | 22 | 12 |
| 表情版本数 | 25 | 12 |
| 不重复图片数 | 24 | 12 |
| emojis.jsonl 字节数 | 9,735 | 4,992 |
| 图片总字节数 | 21,048,804 | 12,034,941 |
| 图片缺失、摘要不符、尺寸不符或身份异常 | 0 | 0 |

全部清单引用图片均通过：普通文件、单硬链接、非符号链接、内容 SHA-256 与 `emoji-<sha256>.png|gif` 文件名一致、尺寸 1024×1024、单张不超过 16 MiB。

2 MiB 上限只作用于 `emojis.jsonl` 本身，不能将全部引用图片的字节数相加后套用该限制。现有图片总量超过 2 MiB 不构成清单超限。

初始 `workbench-config` 的 enabled、approval 与 risk review 均为批准状态，绑定同一内容摘要。初始说明与修改前源码文本一致，Windows CRLF 与 WSL LF 的原始字节摘要差异未构成语义版本漂移。更新后的安装结果见“修复与发布”。

## 当前工具权限

下表描述现有代码合同；工具总开关、会话 disabledTools、本轮实际媒体和运行能力仍共同决定是否向模型提供工具。工具可获得不等于任意命令可以通过独立审核。

| 场景 | native_bash（Linux/WSL） | read_file / write_file | import_chat_emoji / import_chat_selfie | sunabot-skill |
| --- | --- | --- | --- | --- |
| 管理员 QQ 私聊 | admin，逐命令独立审核 | 可提供 | 本轮有绑定图片时可提供 | 可提供 |
| 管理员 QQ 群聊 | isolated，逐命令独立审核 | 不提供 | 本轮有绑定图片时可提供 | 不提供 |
| 普通 QQ 私聊、群聊 | isolated，业务任务受独立审核 | 不提供 | 不提供 | 不提供 |
| 已认证管理员 Web Chat | admin，逐命令独立审核 | 不提供 | 不提供 | 可提供 |

`read_file`、`write_file` 只接受当前 Agent Workbench 内的安全 POSIX 相对路径，读写有界 UTF-8 文本。图片等二进制由专用媒体工具或获批 Bash 操作。Windows 盘符、宿主绝对路径、父目录跳转被拒绝符合当前合同。

Linux/WSL 的 Bash 使用真实 Bubblewrap，把当前 Agent Workbench 投影为 `/workbench`，Skill/MCP 另以 `/skills`、`/mcp` 只读投影。普通用户直接要求枚举或修改工作区本身会被现有审核合同拒绝；允许的业务任务可在当前工作区生成、转换和返回文件。

当前代码在 `win32` 原生 Node 环境没有 Native Bash 隔离实现。本次验证覆盖 Windows 主机上的实际 WSL 部署，不能作为 Windows 原生 Core 或 PowerShell 工具支持的证据。

## 历史基线：已执行的确定性冒烟

使用生产 `dist/services/tools/bashTool.js` 与 `workbenchFileStore.js`，在临时 Agent 目录执行。Bash 注入确定性的隔离夹具审核结果，未调用外部模型；未更换或绕过生产审核端口。

| 检查 | 结果 |
| --- | --- |
| admin 模式真实 Bubblewrap 命令 | exit 0，stderr 空 |
| isolated 模式真实 Bubblewrap 命令 | exit 0，stderr 空 |
| pwd -P | `/workbench` |
| 复制清单后使用 Node 逐行 JSON.parse | 22 条记录通过 |
| Node 同目录写临时文件、rename、读取确认、删除 | 通过 |
| Python 执行 | 通过 |
| convert 创建图片并由 identify 检查 | 1024×1024，通过 |
| write_file 创建中文文件名 UTF-8 文本 | 通过，13 B |
| read_file 读取并比较完整内容 | 通过，13 B，内容一致 |
| ../outside.txt | WORKBENCH_FILE_PATH_INVALID |
| C:\Windows\system.ini | WORKBENCH_FILE_PATH_INVALID |
| /etc/passwd | WORKBENCH_FILE_PATH_INVALID |

WSL 中已安装 Node、Python、git、rg、bwrap、prlimit、ImageMagick `convert`。当前为 ImageMagick 6，`magick` 命令不存在；本次图片操作使用已安装的 `convert` 与 `identify` 成功。

该阶段的冒烟证明已部署执行和文件存储链能够运行，不覆盖真实审核 Provider、完整主对话入站、生产表情清单发布或 QQ 外发。后续真实审核与原始入站资源链已通过，仍没有生产表情清单写入或真实 QQ 外发验收。

## 历史基线：表情发布与生产消费者确定性复测

新增复测仍只使用生产 `dist` 与全新 `/tmp/sunabot-emoji-consumer-smoke-*` 工作区，创建 `fixture-one`、`fixture-two` 两个隔离 Agent。两者均从空表情清单开始；运行前已明确设置临时 `SUNABOT_WORKSPACE`，全部消费者 SQLite 初始化均定向该临时工作区。没有复制生产数据库或写入生产资源。

第一轮按原 Skill 中的尺寸要求使用 ImageMagick 默认 PNG 输出，Bash 命令退出 0，`EmojiJsonlStore` 能读取发布记录，但 `EmojiLibraryRepository.list()` 返回 0 张图片。格式复查确认：白色默认 PNG 为 1-bit、color type 0；青色默认 PNG 为 1-bit、color type 3。`emojiAssets.ts` 的 `assertNormalizedImageHeader` 要求 PNG bit depth 为 8，且 color type 为 0、2、4、6。原 Skill 只说明尺寸与可解码条件，遗漏该消费者限制，因此这个失败计为说明缺陷。

成功复测使用的实际图片指令为：

```bash
convert -size 1024x1024 xc:white -depth 8 PNG32:emoji/.source.png
convert -size 1024x1024 xc:cyan -depth 8 PNG32:emoji/.source.png
```

两条指令在两个独立的 `runWorkspaceBash` 调用中分别执行，后续通过 `identify` 检查 1024×1024，再由内联 Node 脚本计算 SHA-256、发布内容寻址文件、按既有 schema 增加版本并保留原 `createdAt`。发布脚本对资产身份、字节数、摘要、PNG header、key/版本/清单上限执行校验，同目录写入临时清单并 fsync，比较旧清单摘要后 rename，目录 fsync 后读取确认。

消费者在第一版之前读过空清单，随后对每版调用现有 `EmojiJsonlStore.read/readVersions`、`EmojiLibraryRepository.list/listVersions/content`，验证消费者缓存会随外部原子替换刷新。原图返回后额外以 Sharp 解码检查尺寸，并计算实际返回字节的 SHA-256。

| 证据 | 第一版 | 第二版 |
| --- | --- | --- |
| Native Bash exit / stderr | 0 / 空 | 0 / 空 |
| PNG bit depth / color type | 8 / 6 | 8 / 6 |
| 图片字节数 | 6,569 | 6,569 |
| SHA-256 | 4b67b65f0453a08c6fd8509e13e85c207cb79d4888058b0590a5773c61b724bc | 07f9210d3357dbfa639098033e650a89c176fe9ce092a52514471eb635bd6689 |
| 消费者可见 key 数 | 1 | 1 |
| 消费者版本数 | 1 | 2 |
| current 版本数 | 1 | 1 |
| 返回原图尺寸 / 类型 | 1024×1024 / image/png | 1024×1024 / image/png |
| 返回原图摘要与清单文件名 | 一致 | 一致 |

重新创建 `EmojiJsonlStore` 后仍读回两版；原 `createdAt` 保留，`updatedAt` 对应第二版。另一 Agent 的清单字节和表情文件列表与运行前完全一致。机械断言通过；独立质量评审确认读回原图真实可用、版本指向正确、时间字段保留、跨 Agent 隔离、失败与成功边界表达准确。本次测试的图像是受控白色和青色样本，只用于验证文件链，不作为表情内容或画面质量验收。

中间一次运行因夹具误用 `repo.versions` 方法名失败，实际方法为 `listVersions`；该次结果未计为通过，目录清理后重新准备全新工作区完成以上验收。本节测试使用确定性 fixture audit，当时没有真实 Provider、原始 OneBot ingress 或 QQ 外发证据；后续真实审核与完整入站资源链的通过结果已在本文当前复核段单独记录。

## 说明冲突与修复依据

修改前 `services/tools/chatMediaTool.ts` 中 `import_chat_emoji` 的 description 包含：

```text
Do not edit emoji files or emojis.jsonl with Bash.
```

已发布 `workbench-config/references/bash-resource-operations.md` 与 `workbench-addressing.md` 明确允许获批 Bash 维护已验证的本地 PNG/GIF 和 canonical 清单，并要求内容寻址、尺寸及单文件验证、旧清单摘要比较、同目录原子发布和结果复核。

已统一专用导入工具与 Skill 的操作说明：当前聊天图片可由 `import_chat_emoji` 规范化并发布；已获得且验证的本地资源可按既有获批 Bash 合同维护。身份、路径、Skill 审批或文件权限未放宽。

Skill 的本地 PNG 发布说明已补充现有 8-bit、非调色板消费者合同及 `PNG32` / `-depth 8` 转换示例，保留消费者回读要求。消费者边界没有扩大。

生产审核模型已调整，保留独立审核和失败错误。授权前该阶段尚未执行新审核请求；随后真实 gpt-6-luna 审核已返回 HTTP 200 allow 并完成表情链验收。单纯调整目录权限不能解决已确认的模型 HTTP 400。

## 历史记录：首批配置与 Skill 发布

Arona、Plana 的 Bash `auditModel` 已通过认证管理台热更新为 `gpt-6-luna`；Plana 已启用的编排模型同样更新。两个 Agent 的 `import_chat_emoji` 自定义说明已去除旧 Bash 禁句，生产源码和已构建模块也仅删除该句，其他内容保留。

Workbench 说明通过 `BundledAgentSkillInstaller` 的现有安装、确定性审查、CAS 与启用流程发布。发布前由管理台停用旧 Skill，触发现有 Agent 扩展缓存清理；没有手改索引摘要或审批。两角色安装后的摘要均为 `8eafd2895e3e85f56a4bd4fbbe7873538c0a0807f74db9c0802619e3870e3acd`，enabled 为 true，source 为 bundled，risk review 与 approval 均为 approved。

发布后用生产 `AgentSkillRuntimeReader` 与 `SkillActivationService` 在本地临时会话中读取两角色安装包，两次 activate 与 readResource 均成功，PNG32 说明实际返回 8,273 B，资源 SHA-256 为 `267685e3073841d70ab634d62df297d2c568458418ef61ddcee13c99c7e95dd8`。这项只读消费者核验没有进入生产对话、写入业务数据库或调用 Provider，不能当作新的模型 tool.call 证据。

首批旧模型配置、Skill 包、索引与生产文本更新原件保留在 `workspace/backups/tool-config-20261012/`，目录 0700、文件 0600。该批热更新没有改写 QQ 缓存或业务数据库，也没有重启 Core/NapCat；后续完整部署已执行 build/up，不能将该历史阶段的未重启描述用于当前部署状态。

该阶段生产 `./sunabot.sh doctor` 返回 liveness live、readiness ready，Core API、OneBot listener、Codex 认证、Native Bash 执行探针和 Lightpanda Renderer 均通过。capability degraded、退出 1 的两项原因是 `MCP_OAUTH_VAULT_UNAVAILABLE`（未配置 vault key）与 `MCP_STDIO_RUNTIME_UNAVAILABLE`（stdio 后端关闭）；两个 Agent 当前 MCP server 数均为 0，未将未配置能力记为就绪。

## 历史记录：早期全量测试失败定位与复测

第一次完整 verify 的 unit 阶段在表情破坏测试后恢复原文件时失败，第二次全量 unit 在根目录快速移走并恢复的错误分支断言失败。两文件单独重跑均通过，因此另做真实 WSL 元数据复现，没有将单独通过作为结案。

根目录替换/恢复 500 次中，371 次捕获与恢复的 ctimeNs 完全相同，随后仍被 descriptor/path 不匹配拒绝；其余 129 次返回 `SEND_FILE_ROOT_CHANGED`，全部 500 次实际文件读取次数为 0。表情同尺寸破坏再原地恢复 250 次中，181 次 inode/size/mtimeNs/ctimeNs 完全碰撞，正确原字节仍命中负缓存；改为同目录临时文件加原子 rename 后 250/250 恢复。正缓存损坏测试 250 次全部拒绝，实际字节读取没有接受损坏图片。

测试夹具据此使用原子 rename 恢复内容寻址图片；两处目录替换 hook 在元数据同时间片时等待并再次 rename，核验真实 ctime 变化。原错误码、拒绝与零外部读取断言均保留，产品代码没有增加处理或放宽校验。受影响 2 文件 41 项通过；该阶段全量 unit 为 270 文件、3,060 项通过、1 项跳过，其余 verify 阶段逐项通过，当时尚未重复整条命令。随后最近一次完整 verify 已确认 3,089 项 unit 与全部后续阶段通过，凭据刷新修复后的完整 verify 已因审查问题有界中止并请求重跑，尚未取得最终结果。原 `/tmp` 首次失败与复测日志已清空，本文保留已确认的故障、复现计数和测试结果，不声称原日志仍存。

## 历史待验项的后续结果与当前边界

授权前待验的真实 Bash 审核、原始 OneBot ingress→Session/Provider/tool/outbox 资源管理链，以及专用导入/导出操作，均已由后续真实隔离合成 run 和独立质量评审补齐。该阶段曾写“待授权”只属于历史，不代表当前尚未执行。

当前仍保留以下边界：

- Tavily 凭据、在线 voice profile 缺失，不能验收真实搜索或在线语音；run_skill_script 按规范关闭。
- MCP server 数为 0，没有动态别名，MCP 不计入 26 个内置工具。
- 动态 WebFetch 只有 Renderer 隔离、健康、鉴权预检；静态成功不能替代动态端到端。
- Windows/WSL amd64 已有文件执行、安装与真实 Provider 隔离成功证据；Windows 原生和真实 arm64 未验。
- 全部真实 QQ 发送未验；当前 Arona 登录态失效，二维码自动更新并等待扫码，尚未确认恢复。
- 凭据刷新修复后的完整 verify 已因审查问题有界中止并请求重跑，未判定测试失败，不能提前写成功。

密封 `.user-test-runs/` 报告持续保留；WSL 重启前的原 `/tmp` 日志已清空，本轮审查中止的日志与 abort 状态另行保留。模拟投递不等于真实 QQ 已收到。
