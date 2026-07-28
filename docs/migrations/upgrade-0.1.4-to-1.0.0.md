# 0.1.4 升级到 1.0.0

状态：`1.0.0` 已将动态 WebFetch Renderer 按平台放入独立受监管隔离环境，并把 Chromium 下载移到首次依赖同步或 Playwright 版本升级阶段。

## 变更范围

- macOS Native Core 使用独立 Docker Renderer；
- Linux 与 WSL Native Core 使用 Bubblewrap Renderer；
- Docker Core 继续使用 Compose 私有网络中的独立 Renderer；
- Renderer 使用启动级 bearer token，宿主端只监听回环地址；
- Chromium sandbox 缺失时失败关闭并由 doctor 报告；
- 普通 `up`、`start` 与 `restart` 复用已安装的 Chromium；
- 不修改业务 SQLite schema、系统提示词或资源目录。

## 预检

```bash
npm run upgrade:1.0.0 -- plan
npm run upgrade:1.0.0 -- plan --workspace /absolute/path/to/workspace
```

`plan` 只读取版本文件、workspace 目录身份和主配置，不停止服务，不写数据库、提示词或资源。

在 Linux 或 WSL 选择 Native Core 时，还需确认宿主已安装 Bubblewrap；缺失时 Native Renderer 会失败关闭，静态 WebFetch 继续可用。

## 执行

```bash
npm run upgrade:1.0.0 -- apply
```

`apply` 固定执行：

1. `./sunabot.sh down`；
2. 为默认 Plana 及全部 Agent 的业务库和 queue 创建离线 SQLite 恢复点；
3. `./sunabot.sh up`；
4. `./sunabot.sh status`；
5. `./sunabot.sh doctor`。

首次启动 1.0.0 或 Playwright 版本发生变化时会同步 Chromium。后续普通启动和重启复用同一镜像或宿主浏览器安装。

任一步失败都会返回 `serviceMayBeStopped`；恢复点创建后、服务启动前失败时保持停止，不能继续运行新旧混合状态。

## 验证

- 全部当前版本文件均为 `1.0.0`；
- macOS Native Core 的 Renderer health 报告 `docker` 与 `chromium-sandbox`；
- Linux 或 WSL Native Core 的 Renderer health 报告 `bubblewrap` 与 `chromium-sandbox`；
- Docker Core 的 Renderer 只在 Compose 私有网络内供 Core 访问；
- 动态 Renderer 缺失或启动失败时，静态 WebFetch 保持可用并报告 degraded 状态；
- 同版本二次 `restart` 不构建 Renderer 镜像、不安装 Playwright、不下载 Chromium；
- `status` 与 `doctor` 通过。

## 回滚

1. 停止服务；
2. 切回 `0.1.4` 代码；
3. 若需要恢复业务数据库，使用本次输出的 SQLite 恢复点；
4. 使用 `./sunabot.sh up`、`status`、`doctor` 验证。

1.0.0 不修改 SQLite schema、系统提示词或 Agent 资源；回滚不会自动删除 Renderer 镜像、宿主浏览器缓存或临时运行目录。
