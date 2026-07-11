# QQ Runtime

`qq-runtime` 是 Sunabot 的内聚 QQ 接入组件，包含 Sunabot 内部的 OneBot v11 网关与 NapCat/QQ 运行进程。OneBot 是组件内部协议，不是可独立远程部署的服务。

## 固定通信契约

```text
QQ ↔ NapCat ↔ ws://127.0.0.1:8787/onebot/v11/ws ↔ OneBotGateway ↔ Sunabot
        │
        └── /srv/sunabot/workspace/artifacts/images（共享文件路径）
```

- NapCat 主动建立 OneBot v11 反向 WebSocket。
- OneBot 入口只使用回环地址，不配置远程主机、容器 DNS 或宿主机网关。
- NapCat 与 Sunabot 必须看到相同的 `/srv/sunabot/workspace` 绝对路径。
- 生成图片直接以本地绝对路径交给 NapCat，不经过 HTTP 下载。
- 对外只按需发布管理台端口；OneBot 没有独立公开端口。
- Docker 与非 Docker 使用同一 URL、同一路径和同一 Token 规则。

## Docker 运行形态

Compose 使用两个独立进程容器，但 NapCat 通过 `network_mode: service:sunabot` 与 Sunabot 共享网络命名空间，因此双方的 `127.0.0.1` 指向同一个运行单元。workspace 同时挂载到两个容器内的固定路径。

```bash
npm run qq:configure
npm run qq:up
npm run qq:logs
```

## 非 Docker 运行形态

Sunabot 与 NapCat 必须运行在同一 Linux/WSL 环境中，项目位于 `/srv/sunabot`，workspace 位于 `/srv/sunabot/workspace`。NapCat 配置仍使用同一反向 WebSocket 地址和图片绝对路径。

不支持以下形态：

- NapCat 部署在另一台服务器；
- OneBot 入口通过公网或反向代理暴露；
- 使用 `host.docker.internal`、Compose 服务名或局域网 IP 连接 OneBot；
- Sunabot 与 NapCat 使用不同的图片目录视图。
