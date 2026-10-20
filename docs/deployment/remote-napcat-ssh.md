# 本地 Core 与远端 NapCat

Core、业务 SQLite、人格、工具和模型凭据保留在本地。远端仅运行每个 QQ 独立的 NapCat Docker，接收账号配置、QQ 登录目录及 NapCat 入口文件。

## 连接配置

由部署管理员在本地 `workspace/secrets/remote-napcat.json` 显式配置，权限为 `0600`：

```json
{
  "version": 1,
  "host": "ecs.example.com",
  "port": 22,
  "user": "sunabot-napcat",
  "uid": 1003,
  "gid": 1003,
  "root": "/home/sunabot-napcat/sunabot",
  "gateway": "172.30.77.1",
  "identityFile": "/home/sunabot/sunabot/workspace/secrets/ecs-napcat/id_ed25519",
  "knownHostsFile": "/home/sunabot/sunabot/workspace/secrets/ecs-napcat/known_hosts"
}
```

UID/GID 必须来自实际远端账号。SSH 只接受已核验主机密钥和专用身份文件，使用 BatchMode；私钥不复制到 ECS。远端账号加入 Docker 组通常具有 root 等级能力，创建前须明确告知管理员并取得授权。

远端安装 Docker、Compose 和 Python 3。使用当前 release 锁定的 NapCat 镜像，普通运行不下载。不能访问镜像仓库时可以通过 SSH 传输本地已验证的 `docker image save` 数据流，并在专用账号执行 `docker load`。经典 Docker 存储可能丢失 RepoDigest；此时在配置中显式设置 `offlineImageArchitecture` 为 `amd64` 或 `arm64`，并保存原始 OCI index 和该平台 manifest 到本地 `workspace/runtime/napcat/offline-image/index.json`、`manifest.json`。启动器验证 index SHA-256 等于 release 锁定摘要、平台 descriptor SHA-256 等于 manifest，再使用 manifest 的 config digest 定位导入镜像；不能用任意 tag 或未经证明的 image ID 替代。

Docker 26 的停止命令使用 `docker stop -t`，该参数也兼容当前较新 Docker。较新 Ubuntu 软件包中的 Compose 可依赖 ECS 不具备的 glibc；应使用校验 SHA-256 后的官方独立 Compose 发行文件，并实际运行 `docker compose version`。

## 隧道与网络

远端运行网络沿用 workspace 身份标签，使用配置 gateway 对应的 `/24` 网段。管理员应核验其与 ECS 路由无冲突。远端 SSH 对专用账号设置：

```text
PasswordAuthentication no
AuthenticationMethods publickey
AllowAgentForwarding no
X11Forwarding no
PermitTTY no
AllowTcpForwarding yes
GatewayPorts clientspecified
PermitListen 172.30.77.1:8788
PermitOpen 127.0.0.1:6099 127.0.0.1:6100
```

这些设置放在该账号的 `Match User` 区块内；`authorized_keys` 同样限制转发目标。保留原 root 登录配置。修改后执行 `sshd -t`，成功后 reload SSH 并验证密钥登录。

本地使用受进程管理器监管的 SSH 隧道：

```text
ssh -NT -o BatchMode=yes -o StrictHostKeyChecking=yes
  -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3
  -o UserKnownHostsFile=<known_hosts> -i <private_key>
  -R 172.30.77.1:8788:127.0.0.1:8788
  -L 127.0.0.1:6099:127.0.0.1:6099
  -L 127.0.0.1:6100:127.0.0.1:6100
  sunabot-napcat@ecs.example.com
```

网桥应在隧道建立前存在。隧道退出后由进程管理器重试，不重启 QQ；账号端口发生变化时同步更新转发配置和 SSH 限制。Core 在远端模式只绑定回环 `127.0.0.1:8788`，NapCat 连接 ECS 私有网桥，管理台保持本地 `127.0.0.1:8787`。ECS 安全组不开放 8787、8788、6099 或 6100。

Docker 28 之前的版本存在同一二层网络访问回环发布端口的已知限制（[Docker 文档](https://docs.docker.com/engine/network/port-publishing/)）。使用旧版本时，在切换方案中列出针对外部网卡、NapCat 网段和管理端口的防火墙规则，由管理员确认后持久化；不能把回环监听检查当作完整的网络隔离证明，也不能清空或替换已有防火墙策略。

## 切换与回滚

准备阶段不启用生产 `remote-napcat.json`，不同时运行同一 QQ 的两个实例。完成隔离测试、镜像和资源检查后，由管理员确认停机切换：

1. 保存本地 Core 代码、launcher state、账号配置及 QQ 登录目录恢复点。
2. 停止本地账号调和器和对应 NapCat，再完成 QQ 目录最终同步；业务 SQLite 不离开本地。
3. 启用远端配置和隧道，更新 Core 连接状态并通过正式启动器启动。远端目录归属专用账号，逐账号核对身份。
4. 核验远端容器、QQ 实际在线、OneBot 心跳、管理台状态及真实入站；登录态失效时使用手机重新确认。
5. 仅中断并恢复隧道，验证远端 QQ 容器 ID、启动时间及登录状态不变，并确认 OneBot 重连。

回滚时停止远端 QQ 和隧道，再恢复本地配置、launcher state 和账号目录，移除远端选择配置后通过原入口启动本地实例。不得同时启动两端 QQ。

远端断开时报错，不回退启动本机 QQ。`restart-core` 保留远端 NapCat；完整 `restart/up/down` 继续作用于当前选择的远端账号容器。二维码从对应远端账号目录读取原始修改时间，刷新等待新内容，过期图不显示；手动登录标记及快速登录账号也写回远端。

QQ 留在 ECS 可避免本地网络断开直接结束 QQ 进程。本地断网期间 Core 的消息处理和回复仍会中断，NapCat 是否补发历史事件需要实测，不能承诺零消息丢失。低内存 ECS 加 Swap 仅用于试运行，需要持续观察实际内存、Swap、OOM、磁盘与登录状态。
