# Docker deployment

Docker 运行时由两个独立服务组成：

- `core`：仅包含 Sunabot Core，在 `SUNABOT_CORE_MODE=docker` 时启用。
- `napcat`：仅包含 NapCat/QQ，在所有支持平台和 Core 模式下启用。

`deploy/docker/Dockerfile` 只构建 Core 镜像。`deploy/docker/Dockerfile.napcat` 基于 component lock 固定的 NapCat 多架构 digest 构建独立薄 wrapper，只负责在缺失时初始化默认配置，不能覆盖启动器预写的 `onebot11.json`。禁止将 NapCat 文件复制进 Core 镜像。

用户只通过根入口操作：

```bash
./sunabot.sh up
./sunabot.sh status
./sunabot.sh logs
./sunabot.sh down
```

Docker Core 模式下，两个服务位于 Compose 私有网络，NapCat 连接 `ws://core:8788/onebot/v11/ws`。OneBot 端口不发布到宿主；管理台只发布到 `127.0.0.1:8787`，各账号 NapCat WebUI 从宿主回环 `127.0.0.1:6099` 起分配独立端口。

Native Core 模式下，只启动 `napcat` 服务。NapCat 通过 `host.docker.internal` 与 host-gateway 映射连接宿主 Core 的专用 `8788` listener。管理台继续只监听宿主回环。

挂载边界：

```text
core:
  workspace/ -> /srv/sunabot/workspace

napcat:
  workspace/runtime/napcat/accounts/<accountId>/config-full -> /app/napcat/config
  workspace/runtime/napcat/accounts/<accountId>/qq          -> /app/.config/QQ
  workspace/runtime/napcat/accounts/<accountId>/plugins     -> /app/napcat/plugins
  workspace/runtime/napcat/accounts/<accountId>             -> /app/napcat/cache
```

NapCat 不挂载 `workspace/business/`、SQLite、Agent 或 Core 媒体目录。跨组件图片使用 OneBot `base64://`，不能依赖共享绝对路径。

结构检查：

```bash
docker compose --profile core-docker \
  --env-file workspace/secrets/runtime.env \
  -f deploy/docker/compose.yml config --services
```

输出应包含 `core` 与 `napcat`。Core 和 NapCat 的资源限制、日志轮转、平台架构、镜像 digest 与权限边界必须分别验证。
