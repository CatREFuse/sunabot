# NapCat component

NapCat/QQ 是独立 Docker 组件，不包含 Sunabot 业务代码。版本、上游镜像 digest、QQ 版本、架构、smoke 命令和再分发审查状态由 `components/component.lock.json` 管理。

NapCat 在 macOS、WSL2 和 Linux 上使用同一个锁定的多架构上游镜像。`deploy/napcat/napcat-entrypoint.sh` 只添加配置保护入口：缺少默认配置时补齐文件，并保留启动器预写的 `onebot11.json`。NapCat 通过 OneBot v11 反向 WebSocket 连接 Native Sunabot Core 的专用 `8788` listener，经容器到宿主网关接入，连接强制使用 access token。

NapCat 只挂载 `workspace/runtime/napcat/` 下的配置、QQ 登录态、插件和缓存。它不能挂载 Core 的业务数据库、Agent 或媒体目录。出站图片通过 OneBot `base64://` 交付，不使用共享绝对路径。

NapCat 生命周期由根入口 `./sunabot.sh` 管理，不提供并行的 Native 启动器或独立归档入口。

公开再分发授权尚未确认，component lock 保持 `pending-review`。Sunabot GitHub Release 不内置 NapCat/QQ 镜像；安装程序只在安装阶段从上游准备摘要固定的镜像，普通启动固定 `pull never`。
