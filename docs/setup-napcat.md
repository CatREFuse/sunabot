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

QQ 回复权限统一使用 `workspace/business/config/sunabot.json` 中的 `bot.adminQq`。私聊、用户群、bot 群、命令和异步任务都只响应这个 QQ；管理员 QQ 缺失或格式非法时会安全地拒绝全部回复。默认管理员为 `171419991`。

模型出口需要使用 Windows 上的 Clash 等代理时，Native 和 Docker 使用同一组环境变量：

```text
SUNABOT_PROXY_MODE=auto
SUNABOT_PROXY_PORTS=7890
NO_PROXY=localhost,127.0.0.1,::1,[::1]
```

`auto` 仅在 WSL 中从当前默认路由发现 Windows 宿主地址，并依次探测配置端口，不保存固定网关 IP。必须使用代理时可设为 `wsl-host`，探测失败会阻止启动；`env` 只读取显式 `SUNABOT_PROXY_URL` 或标准 `HTTP_PROXY`、`HTTPS_PROXY`，`off` 完全禁用。带凭据的代理 URL 只能写入忽略的 `workspace/secrets/runtime.env`，运行日志和状态接口不会返回该 URL。`NO_PROXY` 会自动补齐回环地址，因此 OneBot 反向 WebSocket、NapCat WebUI 和本机健康检查不会进入代理。

Docker 下通过 `npm run qq:up` 启动。包装器在 WSL 侧完成自动探测，只向 Compose 传入不含凭据的已发现地址；显式或带凭据代理仍由 `workspace/secrets/runtime.env` 传入容器。

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
npm run qq:configure
```

配置固定写入 runtime contract 的 `runtime/napcat/config-full`，不接受另一套目录。登录二维码固定写入 `runtime/napcat/qrcode.png`；Docker 与 Native 安装都会把 NapCat 组件的 `cache` 链接到该 workspace 状态目录，旧 `cache/qrcode.png` 会在启动或迁移时保留到新路径。由同一 systemd 用户会话管理两个进程。Sunabot 必须先监听 8787；NapCat 可持续重连，不需要其他网络地址。

## 验收

1. QQ 登录状态为 `online=true`。
2. Sunabot 监听 `127.0.0.1:8787`，NapCat 与其存在回环 WebSocket 连接。
3. OneBot 文本 action 成功返回消息 ID。
4. 生成图片位于共享目录，OneBot image 段的 `file` 是同一绝对路径。
5. NapCat 成功把图片上传到 QQ，outbox 状态为 `sent`。
6. 当前 Provider 测试成功。

管理员凭据、OneBot Token、Provider Key、QQ 登录态和运行数据全部位于忽略的 `workspace/`。外网访问管理台时必须使用 HTTPS 反向代理并配置 `SUNABOT_ADMIN_ORIGINS`，不要公开 8787、6099 或 OneBot 路径。
