# WSL 内置 Docker 空闲网桥冷启动

用户目标：在全新的 Ubuntu WSL2 中，从已停止的 Sunabot 和无容器的 Docker 网络启动本地服务，并在浏览器打开管理台。

环境：WSL2 Ubuntu 24.04，发行版内置 Docker Engine 与 Compose，非 root 的 `sunabot` 用户；NapCat 使用组件锁指定的镜像，默认 Provider 已配置。停止流程会删除专用 Docker 网络；再次创建网络后，空闲 bridge gateway 虽已分配 IPv4 地址，Node 的 `os.networkInterfaces()` 仍可能未列出该地址。

输入：执行 `./sunabot.sh up`，使用首次 Landing 创建本地管理员凭据。

预期：清理阶段对已删除的旧网关地址进行端口检查时，`EADDRNOTAVAIL` 不视为端口占用；启动器创建 Docker 网络并验证 gateway 可在当前 WSL 命名空间绑定后，OneBot 只监听该 gateway 的 `8788`。从锁定 NapCat 镜像运行的容器内 `/healthz` 探针成功，Core、管理 API、账号调和进程和 NapCat 稳定运行。`http://127.0.0.1:8787/api/auth/session` 返回 HTTP 200，`./sunabot.sh status` 报告 Core 存活。

拒绝条件：若 Docker gateway 不可在当前命名空间绑定，启动器不得绑定 `0.0.0.0`、WSL `eth0` 或局域网地址；应保留原有 WSL 回环探针和失败回滚行为。

质量标准：冷启动成功无需预先运行占位容器或手动唤醒网桥；启动后的 Docker 容器能访问 OneBot，管理端口仍仅对本机开放。
