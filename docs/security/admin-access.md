# 管理员访问安全

## 认证边界

管理 API、生成图片和管理台数据必须经过管理员认证。管理员账号记录保存在 `workspace/security/admin-credentials.json`，密码仅保存 scrypt 派生值。浏览器登录成功后获得随机 HttpOnly 会话 Cookie；会话空闲 30 分钟或累计 8 小时失效，服务重启也会使会话失效。

Bearer Token 只保留给受控的自动化客户端。浏览器管理台不再读取或保存 Token，本机回环地址也不绕过认证。

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

`trip` 会创建 `workspace/security/ADMIN_DISABLED.json` 并清空当前进程的管理会话。远程管理请求立即返回 503，QQ 业务处理继续运行。`reset` 只能在具有 workspace 文件权限的本机终端执行。

若怀疑服务器或域名已失陷，还应立即停止 SSH 反向隧道、禁用 Nginx 站点、吊销 SSH 凭据并轮换管理员密码、OneBot Token 和 Provider Key。
