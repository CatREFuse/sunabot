# Sunabot QQ Runtime

## 运行边界

Sunabot、OneBot v11 网关与 NapCat/QQ 构成一个本机 QQ Runtime。OneBot 网关属于 Sunabot 进程，NapCat 是同一运行单元内的 QQ 适配进程，不支持远程部署。

固定通信参数：

```text
OneBot reverse WebSocket: ws://127.0.0.1:8787/onebot/v11/ws
共享 workspace:           /srv/sunabot/workspace
生成图片目录:             /srv/sunabot/workspace/business/media/images
```

生成图片以经过边界校验的绝对文件路径发送给 NapCat，不提供 OneBot 专用 HTTP 媒体回调。

## Docker 启动

Compose 定义位于 `deploy/docker/compose.yml`。Compose 只有一个 `sunabot-qq-runtime` service；容器内由监督器管理 Sunabot 与 NapCat/QQ 两个进程，双方通过同一网络命名空间内的 `127.0.0.1` 通信，并只挂载一个 `/srv/sunabot/workspace` 数据卷。

```bash
npm ci
npm run workspace:init
```

在 `workspace/secrets/runtime.env` 至少设置：

```text
NAPCAT_ACCOUNT=你的QQ号
ONEBOT_ACCESS_TOKEN=随机长令牌
```

初始化 NapCat OneBot 配置并启动：

```bash
npm run admin:set-password -- admin
npm run qq:configure
npm run qq:up
npm run qq:logs
```

本机入口：

```text
管理台:       http://127.0.0.1:8787
NapCat WebUI: http://127.0.0.1:6099/webui
```

Compose 只在该运行容器上发布回环管理端口；NapCat 不发布独立 OneBot 端口，也不创建 `host.docker.internal` 映射。

## 非 Docker 启动

Sunabot 与 NapCat 必须运行在同一 Linux/WSL 环境，并看到同一个 `/srv/sunabot/workspace`。NapCat 的 OneBot 配置仍使用固定回环 URL：

```bash
npm run qq:configure -- /path/to/napcat/config
```

由同一 systemd 用户会话管理两个进程。Sunabot 必须先监听 8787；NapCat 可持续重连，不需要其他网络地址。

## 验收

1. QQ 登录状态为 `online=true`。
2. Sunabot 监听 `127.0.0.1:8787`，NapCat 与其存在回环 WebSocket 连接。
3. OneBot 文本 action 成功返回消息 ID。
4. 生成图片位于共享目录，OneBot image 段的 `file` 是同一绝对路径。
5. NapCat 成功把图片上传到 QQ，outbox 状态为 `sent`。
6. 当前 Provider 测试成功。

管理员凭据、OneBot Token、Provider Key、QQ 登录态和运行数据全部位于忽略的 `workspace/`。外网访问管理台时必须使用 HTTPS 反向代理并配置 `SUNABOT_ADMIN_ORIGINS`，不要公开 8787、6099 或 OneBot 路径。
