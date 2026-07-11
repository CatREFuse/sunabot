# Docker deployment

Docker 交付固定为一个 `sunabot-qq-runtime` 镜像、一个 `qq-runtime` Compose service 和一个 `/srv/sunabot/workspace` 挂载。容器内的非 root 监督器先启动 Sunabot，再启动 NapCat/QQ；两个进程只通过 `127.0.0.1` 和共享 workspace 协作。

Node 基础镜像按 `components/component.lock.json` 固定为 24.18.0 和对应 digest。Docker 构建阶段会读取实际 Node 二进制版本并与 `NODE_VERSION` 比较，运行时监督器再次与 runtime contract 核对。镜像同时按组件锁安装 bubblewrap。`seccomp-bwrap.json` 固定自 Moby 默认 profile 的 `f9bc03ec19b2dc4c091449b08e88f85c0caa9f0b` 快照，只额外允许 bubblewrap 0.6.1 实测所需的 namespace `clone` flags、`mount`、`pivot_root` 和 `umount2`；不会关闭整个容器的 seccomp。Compose 继续保留 `cap_drop: ALL` 与 `no-new-privileges`。`workspace_bash` 与 Native 使用同一只读宿主文件系统、唯一可写 Agent workspace、子进程继承隔离的命令构造，probe 失败时拒绝执行。

NapCat shell 的 `/app/napcat/config` 只链接到 runtime contract 的 `workspace/runtime/napcat/config-full`；监督器、配置工具和 Native 运行时使用同一个 `paths.napcatConfig`，不会创建并行配置目录。`/app/napcat/cache` 链接到 `workspace/runtime/napcat`，因此二维码始终落在 `paths.napcatQrCode` 指定的 `runtime/napcat/qrcode.png`。镜像还为 UID/GID 1000 创建并授权 `/app/.cache/fontconfig` 与 Mesa shader cache，避免非 root NapCat 反复产生缓存权限错误。

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
