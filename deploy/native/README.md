# Native Core deployment

Native 模式只在宿主环境运行 Sunabot Core。NapCat 在 macOS、WSL2 和 Linux 上始终由独立 Docker 容器运行，不能安装为 Native 组件或交给 Core systemd unit 管理。

统一入口：

```bash
./sunabot.sh up
./sunabot.sh status
./sunabot.sh logs
./sunabot.sh down
```

macOS 快速开发使用：

```bash
./sunabot.sh up --dev
```

Native Core 只向宿主回环发布管理台 `127.0.0.1:8787`，并在专用 `8788` listener 接收带 token 的 OneBot 反向 WebSocket。启动器负责生成 NapCat 配置和容器到宿主的可达地址。

Core 读取当前仓库或显式 `SUNABOT_WORKSPACE`。所有业务配置、SQLite、Agent 和媒体仍保存在 workspace；NapCat 只挂载 `workspace/runtime/napcat/`。图片通过 OneBot `base64://` 传输，Native Core 不与 NapCat 共享绝对路径。

Linux/WSL Native Core 需要 runtime contract 固定的 Node.js 与 Bubblewrap，Office 正文解析随 Node 生产依赖交付。Bubblewrap 缺失或 namespace probe 失败时，`native_bash` 必须明确拒绝。macOS Native Core 只向管理员私聊和已认证管理员 Web Chat 提供逐命令审批的宿主 `native_bash`。

Linux 发行包同时携带统一 launcher 与 Docker Compose；解压后仍使用根目录 `./sunabot.sh`。`bin/start-sunabot.sh` 仅供进程管理器启动 Core，不启动 NapCat；该入口验证完整发行清单并固定使用包内 Node 与 Bubblewrap，不接受宿主可执行文件覆盖。旧服务端切换前阅读 `docs/migrations/one-container-to-split-runtime.md`。
