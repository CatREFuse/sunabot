# 管理员访问安全

## 认证边界

管理 API、生成图片和管理台数据必须经过管理员认证。管理员账号记录保存在 `workspace/secrets/admin-credentials.json`，密码仅保存 scrypt 派生值。浏览器登录成功后获得随机 HttpOnly 会话 Cookie；服务端只在主库保存 Cookie 的 SHA-256 哈希、CSRF Token 和有效期。会话空闲 7 天或累计 30 天失效，Core 重启后仍可识别有效 Cookie。

管理员可在设置的“账户安全”中修改密码。修改时必须验证当前密码，新密码至少 12 个字符并由服务端重新生成 salt 与 scrypt 派生值；成功后清除其他管理会话，为当前浏览器签发新 Cookie 与 CSRF Token，当前页面保持登录。

Bearer Token 只保留给受控的自动化客户端。浏览器管理台不再读取或保存 Token，本机回环地址也不绕过认证。

## 配置医生安全边界

配置医生只访问 `workspace/business/config/sunabot.json`。`GET /api/config-doctor/scan`、`POST /api/config-doctor/propose` 和 `POST /api/config-doctor/apply` 都属于管理员保护 API；两个 POST 请求同时要求有效 CSRF Token 与可信 Origin。浏览器发起 AI 建议时只提交源文件 revision，应用时只提交服务端生成的 proposal ID 与 source revision，不能直接提交 patch 或候选配置。

本地确定性扫描先于 AI 诊断。发送给默认 Provider 的配置会脱敏凭据、身份、QQ、Provider 地址、workspace、可执行文件和提示词路径；问题列表只使用本次实际失败的白名单路径和固定文案。单次模型请求不提供任何工具，并用结构化输出约束 `add`/`replace` 建议。服务端随后再次执行当前问题路径、字段白名单、JSON Pointer、数量、大小、重复路径、原型污染和完整配置校验，模型输出不能直接写入文件，确认页中的目标值说明由服务端计算。

AI 建议只在进程内保存 10 分钟并绑定原始文件 SHA-256 revision，连续建议至少间隔 10 秒；文件变化后旧方案立即拒绝应用。修复前会在 `workspace/backups/config-doctor/<repairId>/` 持久保存原始配置和 manifest，应用过程使用互斥锁、原子写入与写后复验，失败时自动恢复原始字节和活动配置。当前管理台没有用户主动回滚入口，`./sunabot.sh doctor` 继续保持只读，也没有配置医生 CLI 离线修复入口。

## Agent 自助设置安全边界

`system_config` 由宿主按会话注入，只允许当前 Agent 的管理员 QQ 私聊修改配置；群聊、普通私聊、prompt override 和 Web Chat 修改均失败关闭，Web Chat 只允许查询。查询响应使用固定白名单投影，不能包含密钥、环境变量名、绝对路径、原始消息、Provider 地址或探针诊断正文。Bash backend 仅是配置偏好，不能绕过 capability 探针；macOS Native 缺少 bubblewrap 或等价强隔离时保持关闭，Docker backend 不能使用 Docker socket 或宿主 Bash fallback。

## Bash 管理员边界

`workspace_bash` 的默认执行入口仅接受规范化后的真实 OneBot 管理员私聊，必须绑定当前 Agent、Bot 账号、完整会话、管理员 user/sender、有效消息 ID 与 Bot self ID，且 `promptOverride` 必须严格为 `undefined`。Web Chat、普通私聊、默认群聊、身份缺失或不匹配都不能启动独立审计或隔离探针。未来群聊开关只允许管理员使用 Docker restricted 模式；`adminOnly=false` 不能扩大权限。

每次命令都先进入独立审计 Provider：使用当前默认启用 Provider 的凭据与专用审计模型，只发送审计 system/user 消息，工具列表固定为空并要求 strict JSON。Provider 会话正文、历史、附件和其他工具句柄不得进入审计请求。运行时用单调配置 epoch 和单一 resolver 冻结不可变配置、真实身份、backend、workbench、access mode、strict mode、审批上下文与 audit runner；审计 availability 和隔离 probe 任一 await 后都复验 epoch，最多重探一次。完整 handle 一次性注入 Provider，执行器、Bash runner 与审计闭包共同使用同一 `isCurrent`；文件身份冻结/复验、审批检查/签发/消费、隔离探针及最终 spawn 的每个异步或副作用边界都重新检查，getter 抛错也失败关闭。已过期 handle 返回 `BASH_CONFIGURATION_STALE`，不能启动新的审批、探针或命令，模型可见错误不得包含宿主路径或底层 probe 诊断。API catalog 只有布尔 capability，不能执行命令。

管理员私聊可选择 Native 或 Docker，但偏好不能绕过平台能力：macOS Native 无等价强隔离时不可用，Linux/WSL Native 与 Docker Core 必须通过 bubblewrap capability，Host Docker 必须无网络、无 Docker socket、空环境、固定 entrypoint 并受资源和清理 watchdog 限制。外部路径只允许 Phase A 已定义的精确只读审批；票据绑定 Agent、账号、transport、完整会话、用户、可选群号和命令摘要，过期、重放、上下文变化或命令变化均拒绝。

修改在模型回合中暂存，只有绑定当前管理员、完整会话与规范化 mutation 的 held confirmation 成功写入 durable outbox 后才提交。特殊 delivery 语义由宿主生成并在实际投递时重新验证管理员与纯文本唯一工具 trace，模型参数、普通正文、图片、deferred 和外部 API payload 均不能设置。投递必须读取 store 中可信的 `released`/`fallback_released` provenance 与 mutation fingerprint；仅有 payload marker 或普通 outbox 状态不能获得旁路。commit 失败只能原子释放固定中性通知；任何更新失败都保持原成功文案 held 且不可 claim。

release provenance 绑定 append 时的 ReplyGate 与提交后的当前 ReplyGate。同一 runtime generation 中，只允许 private scope epoch 因关闭当前私聊回复恰好增加 1，conversation epoch 必须不变；其他设置要求两个 epoch 都不变。跨 generation 恢复只接受新 runtime 当前 private scope/conversation epoch 为 0/0；不匹配时遗留 held 继续不可 claim，旧 released 记录也拒绝投递。启动恢复、turn 完成、失败和 deferred 交接都必须终结 origin turn/event，不能再次执行未知 mutation；人工 replay 只保留最多 8 层可信 released/fallback lineage，普通 marker、未释放 held 或 provenance 漂移不能升格。

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
