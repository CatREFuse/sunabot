# Sunabot NapCat Setup

## 启动 Sunabot

```bash
npm ci
npm run workspace:init
npm run admin:set-password -- admin
npm run dev
```

默认地址：

```text
http://127.0.0.1:8787
ws://127.0.0.1:8787/onebot/v11/ws
```

## 启动 NapCat

```bash
npm run napcat:up
npm run napcat:logs
```

NapCat WebUI：

```text
http://127.0.0.1:6099/webui
```

## OneBot 连接

在 NapCat WebUI 中添加反向 WebSocket：

```text
ws://host.docker.internal:8787/onebot/v11/ws
```

NapCat 与 Sunabot 在同一主机直接运行时使用：

```text
ws://127.0.0.1:8787/onebot/v11/ws
```

NapCat 与 Sunabot 共享文件系统时，生成图片默认直接传递绝对文件路径，不设置 `SUNABOT_OUTBOUND_MEDIA_BASE_URL`。如果 NapCat 运行在 Docker 中而 Sunabot 运行在宿主机，请在 `workspace/.env` 设置签名图片回调地址：

```text
SUNABOT_OUTBOUND_MEDIA_BASE_URL=http://host.docker.internal:8787
```

如果设置了 `ONEBOT_ACCESS_TOKEN`，在 NapCat 连接配置中填入同一个 token。

管理员凭据、OneBot Token、Provider Key 和本机配置全部位于忽略的 `workspace/`。外网访问管理台时必须使用 HTTPS 反向代理并配置 `SUNABOT_ADMIN_ORIGINS`，不要直接公开 8787 或 6099。
