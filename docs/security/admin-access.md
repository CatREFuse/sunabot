# 管理员访问安全

版本：2026-08-12（v0.3.0）

## 认证边界

管理 API、生成图片和管理台数据必须经过管理员认证。管理员账号记录保存在 `workspace/secrets/admin-credentials.json`，密码仅保存 scrypt 派生值。浏览器登录成功后获得随机 HttpOnly 会话 Cookie；服务端只在主库保存 Cookie 的 SHA-256 哈希、CSRF Token 和有效期。会话空闲 7 天或累计 30 天失效，Core 重启后仍可识别有效 Cookie。

fresh workspace 的第一次交互式 `up` 在 Core 与 NapCat 启动前进入 CLI Landing，要求设置管理员名称、至少 12 个字符的密码与密码确认。密码输入不回显，只写入随机 salt 和 scrypt 派生值；无 TTY 且凭据缺失时启动失败。管理员可在设置的“账户安全”中修改密码。修改时必须验证当前密码，服务端重新生成 salt 与派生值；成功后清除其他管理会话，为当前浏览器签发新 Cookie 与 CSRF Token，当前页面保持登录。

Bearer Token 只保留给受控的自动化客户端。浏览器管理台不再读取或保存 Token，本机回环地址也不绕过认证。

## 配置医生安全边界

配置医生只访问 `workspace/business/config/sunabot.json`。`GET /api/config-doctor/scan`、`POST /api/config-doctor/propose` 和 `POST /api/config-doctor/apply` 都属于管理员保护 API；两个 POST 请求同时要求有效 CSRF Token 与可信 Origin。浏览器发起 AI 建议时只提交源文件 revision，应用时只提交服务端生成的 proposal ID 与 source revision，不能直接提交 patch 或候选配置。

本地确定性扫描先于 AI 诊断。发送给默认 Provider 的配置会脱敏凭据、身份、QQ、Provider 地址、workspace、可执行文件和提示词路径；问题列表只使用本次实际失败的白名单路径和固定文案。单次模型请求不提供任何工具，并用结构化输出约束 `add`/`replace` 建议。服务端随后再次执行当前问题路径、字段白名单、JSON Pointer、数量、大小、重复路径、原型污染和完整配置校验，模型输出不能直接写入文件，确认页中的目标值说明由服务端计算。

AI 建议只在进程内保存 10 分钟并绑定原始文件 SHA-256 revision，连续建议至少间隔 10 秒；文件变化后旧方案立即拒绝应用。修复前会在 `workspace/backups/config-doctor/<repairId>/` 持久保存原始配置和 manifest，应用过程使用互斥锁、原子写入与写后复验，失败时自动恢复原始字节和活动配置。当前管理台没有用户主动回滚入口，`./sunabot.sh doctor` 继续保持只读，也没有配置医生 CLI 离线修复入口。

## Agent 自助设置安全边界

`system_config` 由宿主按会话注入，只允许当前 Agent 的管理员 QQ 私聊修改配置；群聊、普通私聊、prompt override 和 Web Chat 修改均失败关闭，Web Chat 只允许查询。查询响应使用固定白名单投影，不能包含密钥、环境变量名、绝对路径、原始消息、Provider 地址或探针诊断正文。Bash 的平台路由和隔离能力不属于可读写设置，不能由 `system_config`、模型参数或持久配置改变。

## 灵魂文件安全边界

灵魂文件导出、预览和导入使用管理员保护 API。WebUI 的预览与导入 POST 同时要求有效会话、CSRF Token 和可信 Origin；CLI 只连接本机管理 API，并在交互终端读取管理员名称与密码，不接受明文密码参数。

`.sunabot-soul.json` 最多 3 MiB，只允许当前 schema、版本和六个人格文件。包不能包含 Agent 身份、Provider、密钥、管理员凭据、QQ/NapCat、SQLite、记忆、WorkBench 或绝对路径。导入绑定明确目标 `agentId`、预览 revision 和冲突策略，任一文件变化、摘要不符或保存失败时保持目标六个文件原状。

## Native Bash 边界

公开工具只有 `native_bash`。Linux/WSL 的真实 OneBot 私聊与群聊均可在当前 Agent 的 Bubblewrap 隔离环境中按会话策略使用；管理员 QQ 私聊与已认证管理员 Web Chat 获得 `admin` access mode，其他 OneBot 会话获得 `isolated` access mode。macOS 只向管理员 QQ 私聊和已认证管理员 Web Chat 开放经审批的宿主 Bash，其他会话不提供该工具。

OneBot 调用必须绑定当前 Agent、Bot 账号、完整会话、一致的 user/sender、有效消息 ID 与 Bot self ID，并且 `promptOverride` 严格为 `undefined`；Web Chat 必须来自管理 API 建立的管理员私聊身份。身份缺失或不匹配时不启动审计、隔离探针或命令。所有会话都解析当前 Agent 的同一 canonical `workbench/`；Bash 不创建或选择第二个工作台。

每次命令都先进入独立审计 Provider：使用当前默认启用 Provider 的凭据与专用审计模型，只发送审计 system/user 消息，工具列表固定为空并要求 strict JSON。Provider 会话正文、历史、附件和其他工具句柄不得进入审计请求。运行时用单调配置 epoch 和单一 resolver 冻结不可变配置、真实身份、backend、workbench、access mode、strict mode、宿主权威 `isAdmin`、原始 `userRequest`、审批上下文与 audit runner；审计闭包会覆盖模型或调用参数里的同名伪造值。普通用户直接要求枚举、读取、披露、覆盖或删除工作区、配置和凭据时拒绝，生成表情包、搜索并下载图片、转换聊天文件、打包和发送结果等高层级任务可以使用隔离 workbench。审计 availability 和隔离 probe 任一 await 后都复验 epoch，最多重探一次。完整 handle 一次性注入 Provider，执行器、Bash runner 与审计闭包共同使用同一 `isCurrent`；文件身份冻结/复验、审批检查/签发/消费、隔离探针及最终 spawn 的每个异步或副作用边界都重新检查，getter 抛错也失败关闭。已过期 handle 返回 `BASH_CONFIGURATION_STALE`，不能启动新的审批、探针或命令，模型可见错误不得包含宿主路径或底层 probe 诊断。API catalog 只有布尔 capability，不能执行命令。

macOS host execution 只在 Core 以非 root 用户运行且宿主 `/bin/bash` 探针通过时可用，命令在逐条独立对抗审批和确定性策略放行后以该 Core OS 用户执行；宿主权限影响、进程、网络、凭据和系统配置风险必须进入审计，运行环境只传入固定 PATH、canonical Workbench 与当前 Agent 的 Skill/MCP 目录。Linux/WSL 必须通过随包 Bubblewrap、namespace 和资源限制 probe；隔离进程没有 Docker socket，使用空代理环境、固定执行入口、只读 Skill/MCP 目录及有界清理 watchdog。probe 失败时工具不可用，不回退到普通宿主 Bash 或容器。外部路径只允许 Phase A 定义的精确只读审批；票据绑定 Native backend、Agent、账号、transport、完整会话、用户、可选群号和命令摘要，过期、重放、上下文变化或命令变化均拒绝。

修改在模型回合中暂存，只有绑定当前管理员、完整会话与规范化 mutation 的 held confirmation 成功写入 durable outbox 后才提交。特殊 delivery 语义由宿主生成并在实际投递时重新验证管理员与纯文本唯一工具 trace，模型参数、普通正文、图片、deferred 和外部 API payload 均不能设置。投递必须读取 store 中可信的 `released`/`fallback_released` provenance 与 mutation fingerprint；仅有 payload marker 或普通 outbox 状态不能获得旁路。commit 失败只能原子释放固定中性通知；任何更新失败都保持原成功文案 held 且不可 claim。

release provenance 绑定 append 时的 ReplyGate 与提交后的当前 ReplyGate。同一 runtime generation 中，只允许 private scope epoch 因关闭当前私聊回复恰好增加 1，conversation epoch 必须不变；其他设置要求两个 epoch 都不变。跨 generation 恢复只接受新 runtime 当前 private scope/conversation epoch 为 0/0；不匹配时遗留 held 继续不可 claim，旧 released 记录也拒绝投递。启动恢复、turn 完成、失败和 deferred 交接都必须终结 origin turn/event，不能再次执行未知 mutation；人工 replay 只保留最多 8 层可信 released/fallback lineage，普通 marker、未释放 held 或 provenance 漂移不能升格。

macOS host `native_bash` 的成功命令结果保留真实 Workbench 与 stdout/stderr 宿主路径；基础设施错误、底层 probe 诊断与 Bubblewrap 结果继续执行宿主路径脱敏。

## 外网访问要求

1. sunabot 只监听 `127.0.0.1:8787`。
2. 公网服务器只通过 SSH 反向隧道访问该端口。
3. Nginx 终止 TLS，仅把域名流量代理到服务器回环端口。
4. `SUNABOT_ADMIN_ORIGINS` 必须精确列出 HTTPS Origin，例如 `https://plana.example.com`。
5. 不公开 NapCat 6099、OneBot WebSocket 或 sunabot 8787。
6. Nginx 应限制请求体、设置连接和读取超时，并保留登录失败访问日志。

应用默认发出 CSP、HSTS（确认 HTTPS 转发时）、DENY frame、nosniff、no-referrer、Permissions Policy、COOP 和 CORP 安全响应头。Cookie 使用 SameSite=Strict；写请求同时要求 CSRF Token 与可信 Origin。

## 限流与自动熔断

- 同一来源 15 分钟内失败 5 次：锁定 30 分钟。
- 全局 10 分钟内失败 20 次：远程管理自动熔断 15 分钟，并清空已有会话。
- 自动熔断期间，本机恢复路径仍可使用。

## 手动紧急熔断

```bash
npm run admin:fuse -- status
npm run admin:fuse -- trip suspected-compromise
npm run admin:fuse -- reset
```

`trip` 会创建 `workspace/secrets/ADMIN_DISABLED.json` 并清空主库中的管理会话。远程管理请求立即返回 503，QQ 业务处理继续运行。`reset` 只能在具有 workspace 文件权限的本机终端执行。

若怀疑服务器或域名已失陷，还应立即停止 SSH 反向隧道、禁用 Nginx 站点、吊销 SSH 凭据并轮换管理员密码、OneBot Token 和 Provider Key。
