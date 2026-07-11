# sunabot WSL2 迁移计划

日期：2026-07-11
目标：将当前 macOS 自托管实例迁移到 Windows 主机的 WSL2 环境，并保留会话、记忆、请求日志、图片、附件缓存和 NapCat 状态。

## 1. 结论

推荐目标环境是 Ubuntu 24.04 WSL2，项目和运行数据全部放在 WSL 的 ext4 文件系统，例如 `/srv/sunabot`，不要放在 `/mnt/c`。Docker 官方指出，Linux 容器绑定挂载使用 WSL Linux 文件系统时性能更高，也能正常接收 inotify 事件。[Docker WSL2 文件系统建议](https://docs.docker.com/desktop/features/wsl/best-practices/)

目标 Windows 版本决定 Docker 方案：

| Windows 主机 | Docker 方案 |
| --- | --- |
| Windows 11 Pro/Enterprise 23H2 或更高 | Docker Desktop WSL2 后端，启用目标发行版的 WSL Integration |
| Windows Server 2022/2025 | Ubuntu WSL 内安装 Docker Engine 和 Compose 插件 |

Docker Desktop 官方明确不支持 Windows Server 2019/2022 等 Server 版本；Windows Server 2022 和 2025 可以通过 `wsl.exe --install` 安装 WSL。[Docker Desktop Windows 支持范围](https://docs.docker.com/desktop/setup/install/windows-install/)，[Windows Server 安装 WSL](https://learn.microsoft.com/en-us/windows/wsl/install-on-server)

## 2. 兼容性结论

| 项目 | 结论 | 处理 |
| --- | --- | --- |
| Node.js | 可迁移 | 使用 Node.js 24 LTS；项目要求 `>=24`，官方仍将 v24 标记为 LTS。[Node.js 发布状态](https://nodejs.org/en/about/previous-releases) |
| SQLite | 可迁移 | 使用 Node.js 内置 `node:sqlite`，数据库放在 WSL ext4，不放在 Windows 挂载盘 |
| sharp | 可迁移 | 锁文件包含 Linux x64、arm64 的 sharp 和 libvips 包 |
| `@napi-rs/canvas` | 可迁移 | 锁文件包含 Linux GNU x64、arm64 预编译包 |
| Vite/esbuild/Rollup | 可迁移 | 锁文件包含 Linux x64、arm64 可选包；必须在 WSL 内重新 `npm ci` |
| LibreOffice | 可迁移 | 安装 Ubuntu 的 `libreoffice`，代码已包含 `/usr/bin/soffice` 和 `/usr/bin/libreoffice` |
| Codex CLI | 条件可用 | 在 WSL 内安装 Codex CLI，或设置 `SUNABOT_CODEX_BIN`；macOS App 内置路径不会在 Linux 分支使用 |
| Bash 工具 | 可用但隔离较弱 | Linux 没有 macOS `sandbox-exec`；迁移初期保持管理员专用，并使用 systemd 文件系统限制 |
| NapCat | 可迁移 | 继续运行 Linux 容器；首次启动后可能需要重新扫码登录 |
| Bark | 可迁移 | HTTPS 通知脚本不依赖 macOS |

## 3. 迁移包结构

不要复制 macOS 的 `node_modules`、`dist`、临时 PID、WAL/SHM、浏览器调试 profile 或 `.git` 工作目录。迁移包拆为三部分：

```text
sunabot-migration-<date>/
├── source/
│   ├── sunabot.bundle
│   └── source.sha256
├── runtime/
│   ├── workspace.tar.zst
│   ├── runtime-manifest.txt
│   └── runtime.sha256
└── secrets/
    ├── env.age
    └── env.sha256
```

### 3.1 源码包

在最终提交后执行：

```bash
git bundle create sunabot.bundle --all
shasum -a 256 sunabot.bundle > source.sha256
```

目标机使用：

```bash
git clone -b master sunabot.bundle /srv/sunabot
cd /srv/sunabot
git checkout master
```

Git bundle 保留提交历史和里程碑标签，避免依赖尚未配置的远端仓库。

### 3.2 运行数据包

停服并 checkpoint 后打包：

```text
workspace/config/
workspace/agents/
workspace/artifacts/sunabot.sqlite
workspace/artifacts/session-queue.sqlite
workspace/artifacts/images/
workspace/artifacts/file-cache/
workspace/napcat/
workspace/napcat/config/
workspace/napcat/config-full/
```

排除：

```text
*.sqlite-wal
*.sqlite-shm
*.pid
*.out
chrome-profile*/
workspace/backups/
workspace/artifacts/bot-behavior-*.png
workspace/artifacts/qq-file-reading-smoke-test.txt
```

NapCat 目录约 260 MB，图片约 149 MB，附件缓存约 30 MB；运行包应预留至少 1 GB 空间。传输前生成 SHA-256 清单，目标机解包后逐项核验。

### 3.3 凭据包

`workspace/.env` 属于终端私有数据，不进入 Git。迁移时随 workspace 加密快照恢复到 `/srv/sunabot/workspace/.env`，权限设为 `0600`。至少包含：

```text
SUNABOT_HOST=0.0.0.0
SUNABOT_PORT=8787
SUNABOT_ADMIN_ORIGINS=https://你的管理域名
ONEBOT_ACCESS_TOKEN=...
TAVILY_API_KEY=...
CODEX_ACCESS_TOKEN=...
```

没有使用的 key 保持为空。迁移后轮换管理令牌和 OneBot token。

## 4. 目标机准备

### 4.1 Windows 侧

管理员 PowerShell：

```powershell
wsl.exe --install -d Ubuntu-24.04
wsl.exe --update
wsl.exe -l -v
```

Windows Server 2022/2025 同样使用 `wsl.exe --install`，安装后重启主机。WSL 发行版导出和导入可使用 `wsl --export` 与 `wsl --import`，适合作为整机回滚快照。[WSL 基本命令](https://learn.microsoft.com/en-us/windows/wsl/basic-commands)

### 4.2 systemd

当前 Ubuntu 默认安装通常已经使用 systemd；如果没有，在 `/etc/wsl.conf` 写入：

```ini
[boot]
systemd=true
```

执行 `wsl.exe --shutdown` 后重新进入发行版，并用 `systemctl status` 验证。微软说明 systemd 服务本身不会让 WSL 实例永久保持运行，因此还需要 Windows 计划任务在开机后启动并保持目标发行版活跃。[WSL systemd](https://learn.microsoft.com/en-us/windows/wsl/systemd)

### 4.3 Ubuntu 依赖

```bash
sudo apt update
sudo apt install -y ca-certificates curl git xz-utils zstd build-essential python3 libreoffice fonts-noto-cjk
```

安装 Node.js 24 LTS，并确认：

```bash
node --version
npm --version
```

Node.js 官方提供 Linux x64 归档和签名校验文件。[Node.js 24 下载归档](https://nodejs.org/en/download/archive/v24)

### 4.4 Docker

Windows 11 使用 Docker Desktop 时，WSL 至少应为 2.1.5，并在 Docker Desktop 中开启目标发行版的 WSL Integration。[Docker Desktop WSL2 后端](https://docs.docker.com/desktop/features/wsl/)

Windows Server 在 Ubuntu WSL 内按 Docker 官方 Ubuntu 文档安装：

```text
docker-ce
docker-ce-cli
containerd.io
docker-buildx-plugin
docker-compose-plugin
```

安装后验证 `sudo systemctl status docker` 和 `sudo docker run hello-world`。[Docker Engine Ubuntu 安装](https://docs.docker.com/engine/install/ubuntu/)

## 5. 部署步骤

### 阶段 A：源机冻结

1. 记录最终提交和标签。
2. 运行 `npm run verify`。
3. 停止 sunabot 和 NapCat。
4. 运行 `npm run migrate:sqlite`，确认迁移已经完成或幂等通过。
5. 对 `sunabot.sqlite` 和 `session-queue.sqlite` 执行 WAL checkpoint。
6. 创建源码、运行数据和加密凭据三个包。
7. 生成 SHA-256 清单。

### 阶段 B：目标机恢复

1. 把源码恢复到 `/srv/sunabot`。
2. 把运行数据恢复到同一路径下的 `workspace/`。
3. 恢复 `workspace/.env` 并设置 `chmod 600 workspace/.env`。
4. 确认 `workspace/config/sunabot.json` 使用 `workspace/.env` 和 `workspace/agents/plana`。
5. 在 WSL 内执行 `npm ci`，不要复制 macOS `node_modules`。
6. 执行 `npm run check && npm test && npm run build`。
7. 执行 `docker compose -f docker-compose.napcat.yml up -d`。
8. 在 NapCat WebUI 配置反向 WebSocket：`ws://host.docker.internal:8787/onebot/v11/ws`。
9. 启动 sunabot，完成 API、管理台、OneBot 和 QQ 实测。

`docker-compose.napcat.yml` 已把 `host.docker.internal` 映射到 Docker host gateway，因此 Docker Desktop 和 WSL 内原生 Docker Engine 都能使用同一地址。

## 6. systemd 服务

创建 `/etc/systemd/system/sunabot.service`：

```ini
[Unit]
Description=sunabot OneBot agent
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
User=sunabot
Group=sunabot
WorkingDirectory=/srv/sunabot
EnvironmentFile=/srv/sunabot/workspace/.env
ExecStart=/usr/bin/node /srv/sunabot/dist/server.js
Restart=on-failure
RestartSec=5
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/srv/sunabot/workspace

[Install]
WantedBy=multi-user.target
```

启用：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now sunabot
sudo systemctl status sunabot
journalctl -u sunabot -n 200 --no-pager
```

Windows 计划任务使用迁移专用 Windows 账户，在开机时运行：

```powershell
wsl.exe -d Ubuntu-24.04 --exec /bin/sleep infinity
```

该任务用于启动并保持 WSL 实例；systemd 负责启动和重启 sunabot、Docker 与 NapCat。

## 7. 网络

sunabot 在 WSL 内监听 `0.0.0.0:8787`，NapCat WebUI 使用 `6099`。Windows 11 22H2 以上可在 `.wslconfig` 启用 `networkingMode=mirrored`，以获得 localhost、IPv6、VPN 和 LAN 兼容性；外部访问仍需配置 Hyper-V/Windows 防火墙规则。[WSL 网络](https://learn.microsoft.com/en-us/windows/wsl/networking)

如果使用默认 NAT 并需要 LAN 访问，开机任务应读取 `wsl hostname -I`，刷新 Windows `netsh interface portproxy`，并开放 8787 与 6099。仅本机使用时不开放公网端口。

## 8. 验收

| 检查 | 验收结果 |
| --- | --- |
| `node --version` | 24.x LTS |
| `npm ci` | 无平台二进制错误 |
| `npm run verify` | 全部通过 |
| SQLite | 两个数据库 `integrity_check=ok`，记录数与源机一致 |
| 管理台 | Windows 浏览器可访问，登录、设置、对话、记忆和图片正常 |
| OneBot | WebSocket 已连接，私聊、群聊、@、reply、图片、文件均通过 |
| 工具 | websearch、图像生成、自拍、Codex、Bash 权限符合预期 |
| LibreOffice | PDF、DOCX、PPTX、XLSX 解析通过 |
| NapCat | 容器重启后自动恢复；必要时重新扫码 |
| 重启 | Windows 重启后 WSL、Docker、NapCat、sunabot 自动恢复 |
| 备份 | WSL export 与 workspace 加密快照可恢复，且同步密钥独立保存 |

## 9. 回滚

1. 源机在目标机验收完成前保持停机但不删除。
2. 保留里程碑标签、最终 Git bundle、SQLite 迁移备份和 WSL 导出文件。
3. 目标机失败时停止 systemd 服务，恢复上一份 SQLite 与运行数据包。
4. WSL 发行版损坏时使用 `wsl --import` 导入导出的 tar 或 VHDX。
5. 完成至少 24 小时稳定运行和一次 Windows 冷启动验证后，再把目标机设为唯一生产实例。
