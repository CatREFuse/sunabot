# Native deployment

Native 与 Docker 读取同一 `deploy/runtime-contract.json`，使用同一 API/Web release artifact、同一 workspace 路径和同一 NapCat 组件版本。安装、升级和回滚都会把版本化 NapCat 组件的 `cache` 链接到 `workspace/runtime/napcat`，二维码固定写入 `paths.napcatQrCode` 指定的 `runtime/napcat/qrcode.png`。支持 Linux/amd64（含 WSL2），不支持 Windows Native。

Native API 在应用 composition root 中解析 `workspace/secrets/runtime.env` 已注入的代理契约。WSL 可使用 `SUNABOT_PROXY_MODE=auto` 动态发现默认网关，或使用 `wsl-host` 要求探测必须成功；无需在 systemd unit 或启动脚本中固定宿主 IP。回环地址始终加入 `NO_PROXY`，NapCat 与 OneBot 仍只走 `127.0.0.1`。

先在 Linux/WSL 使用 `.node-version` 锁定的 Node 24.18.0 构建：

```bash
npm ci
npm run build
npm run runtime:release -- --output=/tmp/sunabot-release
docker build -f deploy/docker/Dockerfile -t sunabot-qq-runtime:local .
npm run runtime:export-napcat -- --output=/tmp/sunabot-release
```

准备 `/srv/sunabot/workspace/secrets/runtime.env` 后安装。安装只切换版本化链接和 systemd units，不自动启动：

```bash
sudo node tooling/runtime/native.mjs install \
  --release-archive=/tmp/sunabot-release/sunabot-0.1.0-linux-amd64.tar.gz \
  --napcat-archive=/tmp/sunabot-release/sunabot-napcat-4.15.0-linux-amd64.tar.gz
sudo node tooling/runtime/native.mjs start
node tooling/runtime/native.mjs status
node tooling/runtime/native.mjs doctor
```

运行依赖为精确 Node 24.18.0、component lock 固定的 bubblewrap、`xvfb-run`、FFmpeg、LibreOffice、systemd 和 tar。`/usr/bin/bwrap` 是必需 capability：管理员 Bash 在只读宿主根和唯一可写 Agent workspace 中运行，全部子进程继承同一隔离；二进制缺失或 namespace probe 失败时命令会安全拒绝，不会回退到普通 Bash。release manifest 会记录 Node 版本；构建、安装、回滚和服务启动都会拒绝与 runtime contract 不一致的版本。release 安装到 `/opt/sunabot/releases/<version>`，NapCat 组件安装到 `/opt/sunabot/components/napcat/<version>`；`current` 链接原子切换。

回滚与卸载：

```bash
sudo node tooling/runtime/native.mjs rollback \
  --release-version=0.1.0 --napcat-version=4.15.0
sudo node tooling/runtime/native.mjs uninstall
```

卸载保留 workspace、历史 release 和历史组件，不删除用户数据。生产切换前必须在隔离 QQ 账号完成扫码、文字、图片、Provider 和 OneBot action 验收。
