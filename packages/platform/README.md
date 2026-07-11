# Platform

配置、时钟、日志、指标和路径等稳定平台原语。

`proxy.mjs` 在 API composition root 导入前解析并安装 Undici 全局 dispatcher。代理优先级为 `SUNABOT_PROXY_URL`、标准 `HTTP_PROXY`/`HTTPS_PROXY`、WSL 默认网关自动探测；`NO_PROXY` 始终补齐回环地址，确保 OneBot、本机健康检查和 NapCat 通信不经过出站代理。该模块不记录代理 URL 或凭据。
