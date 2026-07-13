# Runtime tooling

用户稳定入口是仓库根 `./sunabot.sh`：

```bash
./sunabot.sh up
./sunabot.sh down
./sunabot.sh restart
./sunabot.sh status
./sunabot.sh logs
./sunabot.sh doctor
```

`SUNABOT_CORE_MODE=auto|native|docker` 或 `--core=...` 选择 Core 形态。`auto` 在 macOS 使用 Native Core，在 WSL2/Linux 使用 Docker Core。`--dev` 或 `SUNABOT_DEV=1` 仅用于 Native Core 快速开发，启动 API watch 与 Vite。

主要实现：

- `launcher.mjs`：统一编排 workspace、令牌、Core、NapCat Docker、健康状态、日志和停止顺序。
- `launcher-core.mjs`：参数、平台、Core 模式、workspace 身份和运行契约解析。
- `launcher.mjs` 的账号编排：按 account ID 原子写入各自的 OneBot v11 反向连接并启动对应容器。
- `validate-contract.mjs`：校验 Node、端口、双服务 Compose、组件边界和运行入口。
- `doctor.mjs`：检查唯一实例、端口 owner、workspace 身份、OneBot 连接和旧新运行时冲突。

固定边界：管理台为宿主回环 `127.0.0.1:8787`，OneBot 为专用 `8788` listener，各账号 NapCat WebUI 从宿主回环 `127.0.0.1:6099` 起分配独立端口。NapCat 始终是独立 Docker 服务，跨组件媒体默认使用 `base64://`。

`macos.mjs` 只做统一 launcher 的兼容委托。发行包包含统一 launcher、Docker Compose、workspace 初始化与 Native Core 进程脚本，不再携带 Native NapCat 组件、旧 systemd unit 或平行 Compose 入口。
