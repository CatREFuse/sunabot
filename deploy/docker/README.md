# Docker deployment

Docker 交付固定为一个 `sunabot-qq-runtime` 镜像、一个 `qq-runtime` Compose service 和一个 `/srv/sunabot/workspace` 挂载。容器内的非 root 监督器先启动 Sunabot，再启动 NapCat/QQ；两个进程只通过 `127.0.0.1` 和共享 workspace 协作。

运行环境文件固定为 `workspace/secrets/runtime.env`。至少配置 `ONEBOT_ACCESS_TOKEN`，首次登录可不填 `NAPCAT_ACCOUNT` 并从 NapCat WebUI 扫码。启动前先生成 OneBot 配置：

模型出口代理也写入该文件。`SUNABOT_PROXY_MODE=auto` 时，`qq-compose.mjs` 在 WSL 宿主侧解析当前默认网关并把无凭据的探测结果传入容器；显式 `SUNABOT_PROXY_URL` 或标准 `HTTP_PROXY`/`HTTPS_PROXY` 由 env file 直接传递。应用启动时统一安装 Undici dispatcher，并强制回环地址进入 `NO_PROXY`，不会改变容器内 OneBot 回环链路。

```bash
npm run runtime:contract
npm run qq:configure
npm run qq:up
npm run qq:logs
```

Compose 仅向宿主机回环发布管理台 8787 与 NapCat WebUI 6099，不发布 OneBot 独立端口。健康检查只验证监督器和 Sunabot API，QQ 临时离线不会触发容器重启风暴；NapCat 子进程退出后由监督器独立拉起。

结构验证与构建：

```bash
docker compose --env-file workspace/secrets/runtime.env \
  -f deploy/docker/compose.yml config --services
docker compose --env-file workspace/secrets/runtime.env \
  -f deploy/docker/compose.yml build qq-runtime
```

输出必须只有 `qq-runtime`。最终镜像以 UID/GID 1000 运行，配置 1 GiB shm、CPU/内存/pids 上限和本地日志轮转。NapCat/QQ 的再分发状态记录在 `components/component.lock.json`；许可证审查完成前只允许本机自用构建，不发布组合镜像。
