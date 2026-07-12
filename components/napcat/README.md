# NapCat component

NapCat/QQ 是独立 Docker 组件，不包含 Sunabot 业务代码。版本、镜像 digest、QQ 版本、架构、smoke 命令和许可证状态由 `components/component.lock.json` 管理。

NapCat 在 macOS、WSL2 和 Linux 上使用同一个锁定的多架构上游镜像。`deploy/docker/Dockerfile.napcat` 只添加配置保护入口：缺少默认配置时补齐文件，并保留启动器预写的 `onebot11.json`。NapCat 通过 OneBot v11 反向 WebSocket 连接 Sunabot Core 的专用 `8788` listener；Docker Core 走 Compose 私有网络，Native Core 走容器到宿主网关，连接强制使用 access token。

NapCat 只挂载 `workspace/runtime/napcat/` 下的配置、QQ 登录态、插件和缓存。它不能挂载 Core 的业务数据库、Agent 或媒体目录。出站图片通过 OneBot `base64://` 交付，不使用共享绝对路径。

`tooling/runtime/export-napcat-component.mjs` 和 Native NapCat 归档属于旧交付资产，不用于当前部署。当前生命周期由根入口 `./sunabot.sh` 管理。
