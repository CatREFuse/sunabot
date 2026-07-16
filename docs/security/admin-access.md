# 管理员访问安全

## 认证边界

管理 API、生成图片和管理台数据必须经过管理员认证。管理员账号记录保存在 `workspace/secrets/admin-credentials.json`，密码仅保存 scrypt 派生值。浏览器登录成功后获得随机 HttpOnly 会话 Cookie；服务端只在主库保存 Cookie 的 SHA-256 哈希、CSRF Token 和有效期。会话空闲 7 天或累计 30 天失效，Core 重启后仍可识别有效 Cookie。

管理员可在设置的“账户安全”中修改密码。修改时必须验证当前密码，新密码至少 12 个字符并由服务端重新生成 salt 与 scrypt 派生值；成功后清除其他管理会话，为当前浏览器签发新 Cookie 与 CSRF Token，当前页面保持登录。

Bearer Token 只保留给受控的自动化客户端。浏览器管理台不再读取或保存 Token，本机回环地址也不绕过认证。

## 配置医生安全边界

配置医生只访问 `workspace/business/config/sunabot.json`。`GET /api/config-doctor/scan`、`POST /api/config-doctor/propose` 和 `POST /api/config-doctor/apply` 都属于管理员保护 API；两个 POST 请求同时要求有效 CSRF Token 与可信 Origin。浏览器发起 AI 建议时只提交源文件 revision，应用时只提交服务端生成的 proposal ID 与 source revision，不能直接提交 patch 或候选配置。

本地确定性扫描先于 AI 诊断。发送给默认 Provider 的配置会脱敏凭据、身份、QQ、Provider 地址、workspace、可执行文件和提示词路径；问题列表只使用本次实际失败的白名单路径和固定文案。单次模型请求不提供任何工具，并用结构化输出约束 `add`/`replace` 建议。服务端随后再次执行当前问题路径、字段白名单、JSON Pointer、数量、大小、重复路径、原型污染和完整配置校验，模型输出不能直接写入文件，确认页中的目标值说明由服务端计算。

AI 建议只在进程内保存 10 分钟并绑定原始文件 SHA-256 revision，连续建议至少间隔 10 秒；文件变化后旧方案立即拒绝应用。修复前会在 `workspace/backups/config-doctor/<repairId>/` 持久保存原始配置和 manifest，应用过程使用互斥锁、原子写入与写后复验，失败时自动恢复原始字节和活动配置。当前管理台没有用户主动回滚入口，`./sunabot.sh doctor` 继续保持只读，也没有配置医生 CLI 离线修复入口。

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
