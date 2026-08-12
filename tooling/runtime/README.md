# Runtime tooling

版本：v0.3.0

用户稳定入口是根目录 `./sunabot.sh`：

```bash
./sunabot.sh up
./sunabot.sh start
./sunabot.sh down
./sunabot.sh restart
./sunabot.sh status
./sunabot.sh logs
./sunabot.sh doctor
./sunabot.sh bootstrap
./sunabot.sh rollback-first-run
./sunabot.sh soul --help
```

Core 固定 Native。`SUNABOT_CORE_MODE` 与 `--core` 已移除，传入时明确失败。`--dev` 或 `SUNABOT_DEV=1` 只用于源码形态的 API watch 与 Vite。

主要实现：

- `launcher.mjs`：编排 workspace 门禁、首次 Landing、Native Core、Native WebFetch renderer、NapCat Docker、账号 daemon、readiness、日志和停止顺序。
- `launcher-core.mjs`：解析参数、平台、workspace 身份、v3 runtime contract 与锁定 NapCat image。
- `first-run-state.mjs`：记录 fresh workspace 的可继续 journal 和显式回滚边界。
- `native-webfetch-renderer*.mjs`：缓存归档内 Node/Lightpanda/renderer 依赖，并在 Linux/WSL Bubblewrap 中监管动态 renderer；macOS 返回 dynamic unavailable。
- `mcp-runtime-config.mjs`：校验 Native MCP、OAuth vault 与 Linux/WSL Bubblewrap executable manifest。
- `validate-contract.mjs`：校验 Node、发行平台、端口、Native 能力、NapCat 唯一容器例外与组件锁。
- `build-release.mjs`：生成 Linux amd64/arm64 自包含归档和 SHA-256，内置 Node、production `node_modules`、Codex、Lightpanda/源码/许可和 Bubblewrap。
- `release-integrity.mjs`：验证归档 manifest、文件摘要、权限、架构和禁止出现的旧运行资产。

固定边界：管理台为 `127.0.0.1:8787`，OneBot 为专用 `8788` listener，Linux/WSL Lightpanda renderer 为 `127.0.0.1:8790`，各账号 NapCat WebUI 从 `127.0.0.1:6099` 起分配独立端口。NapCat 是唯一 Docker 组件；跨组件媒体使用 OneBot `base64://`。

发行安装程序只在安装期下载并校验 Sunabot 归档，同时准备 component lock 中摘要固定的上游 NapCat 镜像。NapCat/QQ 不随 release 重新分发。安装完成后，`up|start|restart` 不安装 npm 依赖、不下载 Lightpanda、不构建容器，也不拉取镜像；NapCat 固定 `pull never`。

首次交互式 `up` 在启动服务前收集管理员名称和密码。当前 Agent 的灵魂文件通过 `./sunabot.sh soul export|inspect|import` 使用本地管理员 API；CLI 不接受明文密码参数。

所有会话的媒体、`send_file`、Codex 和 Native 工具都使用当前 Agent 的单一 canonical `workbench/`。旧 `docker-workbench/` 仅供 0.2→0.3 迁移器识别，launcher 不创建或访问。
