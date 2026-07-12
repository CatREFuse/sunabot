# sunabot WSL2 部署与迁移

日期：2026-07-12
目标：在 Windows WSL2 中通过统一启动器运行 Sunabot Core 与独立 NapCat Docker，并保留业务数据和 QQ 登录态。

## 1. 目标环境

推荐 Ubuntu 24.04 WSL2。仓库与 workspace 放在 WSL ext4 文件系统，例如 `/srv/sunabot` 或 `~/sunabot`，避免 `/mnt/c`。Windows Native 不在支持范围内。

| Windows 主机 | Docker 方案 |
| --- | --- |
| Windows 11 | Docker Desktop WSL2 后端，并启用目标发行版的 WSL Integration |
| Windows Server 2022/2025 | 在 Ubuntu WSL2 内安装 Docker Engine 与 Compose 插件 |

Docker Desktop 不支持 Windows Server；Server 环境使用 WSL2 内 Docker Engine。[Docker Desktop Windows 支持范围](https://docs.docker.com/desktop/setup/install/windows-install/)，[Windows Server 安装 WSL](https://learn.microsoft.com/en-us/windows/wsl/install-on-server)

## 2. 运行形态

NapCat 始终运行在独立 Docker 容器。WSL2 中 Core 有两种选择：

```bash
# 默认：Docker Core + NapCat Docker
./sunabot.sh up

# 可选：WSL Native Core + NapCat Docker
SUNABOT_CORE_MODE=native ./sunabot.sh up
```

Docker Core 模式通过 Compose 私有网络连接 OneBot；Native Core 模式通过容器到 WSL 宿主网关连接。两种模式共用 OneBot token、SQLite schema、workspace 和 `base64://` 媒体协议。

## 3. 目标机准备

管理员 PowerShell：

```powershell
wsl.exe --install -d Ubuntu-24.04
wsl.exe --update
wsl.exe -l -v
```

Ubuntu WSL2：

```bash
sudo apt update
sudo apt install -y ca-certificates curl git build-essential python3 libreoffice fonts-noto-cjk
```

安装仓库 `.node-version` 指定的 Node.js `24.18.0`。安装 Docker 后验证：

```bash
node --version
docker version
docker compose version
docker run --rm hello-world
```

Windows 11 使用 [Docker Desktop WSL2 后端](https://docs.docker.com/desktop/features/wsl/)。Windows Server 按 [Docker Engine Ubuntu 安装文档](https://docs.docker.com/engine/install/ubuntu/)安装 `docker-ce`、`containerd.io`、Buildx 与 Compose 插件。

## 4. 源码与 workspace

源码通过 Git 获取：

```bash
sudo mkdir -p /srv/sunabot
sudo chown "$USER:$USER" /srv/sunabot
git clone https://github.com/CatREFuse/sunabot.git /srv/sunabot
cd /srv/sunabot
```

新实例可以直接执行 `./sunabot.sh up` 初始化空 workspace。迁移现有实例时，源机必须停止 Core 和 NapCat，再复制以下内容：

```text
workspace/business/
workspace/runtime/napcat/
workspace/secrets/
```

可重建的 `workspace/cache/`、`workspace/runtime/logs/`、PID、临时文件、`node_modules/` 与 `dist/` 不需要迁移。SQLite 在复制前执行 checkpoint，并同时保存主库与 session queue 的一致恢复点。凭据包单独加密，恢复后执行：

```bash
chmod 700 workspace/secrets
chmod 600 workspace/secrets/runtime.env
```

不要复制运行中的 `*.sqlite-wal`、`*.sqlite-shm`，也不要让源机和目标机同时登录同一个 QQ 或写入同一个同步目录。

## 5. 启动与切换

```bash
cd /srv/sunabot
git status --short
./sunabot.sh up
```

首次 QQ 登录未完成时，状态显示 `awaiting-login`。在 Windows 浏览器访问 `http://127.0.0.1:6099/webui` 完成登录，再检查：

```bash
./sunabot.sh status
./sunabot.sh doctor
```

管理台固定为 `http://127.0.0.1:8787`。OneBot 使用专用 `8788` listener 和 access token，不直接发布到 Windows 或局域网。Windows 与 WSL localhost 转发异常时，修复 WSL/Docker 集成；不能把管理监听改成 `0.0.0.0` 作为替代。

已有单容器服务端升级时，必须使用 `docs/migrations/one-container-to-split-runtime.md` 的停服与回滚流程。

## 6. 验收

| 检查 | 验收结果 |
| --- | --- |
| runtime | `./sunabot.sh doctor` 通过，只有一个 Core 和一个 NapCat |
| Node 与 Docker | Node `v24.18.0`，Docker Engine 与 Compose 可用 |
| SQLite | 主库与 queue `integrity_check=ok`，记录数与源机一致 |
| 管理台 | `127.0.0.1:8787` 可登录，设置、对话、记忆和图片正常 |
| OneBot | 专用 8788、token 校验、单连接、私聊、群聊、@ 和 reply 通过 |
| 媒体 | 图片使用 `base64://`，消息中不存在跨组件绝对路径 |
| 文件 | QQ 文件可读取，NapCat 容器路径不会被 Core 直接打开 |
| 工具 | Provider、websearch、图像、自拍、Codex 与权限符合当前模式 |
| 重启 | `./sunabot.sh restart` 后 SQLite、outbox、QQ 登录态和连接恢复 |
| 冷启动 | Windows 重启并启动 WSL/Docker 后，执行同一脚本恢复服务 |

## 7. 回滚

1. 目标机验收完成前保持源机停机且数据不删除。
2. 保留目标切换前的 Git commit、SQLite 一致备份、NapCat 登录态副本与 `runtime.env` 加密副本。
3. 目标失败时执行 `./sunabot.sh down`，确认 Core、NapCat 和端口全部停止。
4. 恢复上一份 workspace，切回原 Git commit，再运行对应版本的启动入口。
5. 回滚成功前不能重新启动目标版本，也不能同时启动源机。
