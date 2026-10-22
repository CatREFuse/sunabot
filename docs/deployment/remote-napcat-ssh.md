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

## 固定设备与网络身份

可选文件 `workspace/secrets/napcat-device-identities.json` 是固定身份的唯一配置入口，由部署管理员保存为 `0600`。下面使用合成 machine-id；实际配置必须从要保留的设备读取，不能复制示例值：

```json
{
  "version": 1,
  "network": { "subnet": "172.30.77.0/24", "gateway": "172.30.77.1" },
  "accounts": {
    "primary": {
      "hostname": "My-PC",
      "machineId": "1234567890abcdef1234567890abcdef",
      "macAddress": "02:42:ac:1e:4d:02",
      "ipv4Address": "172.30.77.2"
    }
  }
}
```

每账号使用不同的 MAC 和 IP，不能把同一个 ECS 网卡 MAC 分配给共享网桥上的两个容器。网段与网关必须对应实际运行网络；远端网关同时与 `remote-napcat.json` 一致。本地首次创建网络时也显式使用该子网；已有网络不匹配时只报错。未列出的账号沿用既有启动配置。

启动器在账号目录的 `device-identity/` 中生成 Compose override 和 machine-id 文件，本地与远端均以只读绑定挂载覆盖 `/etc/machine-id`。机器 ID 值进入挂载源文件名，明确变更身份会触发 Compose 更新；重复启动不重新抽取宿主标识或分配随机 MAC。原有 QQ 目录及 `global/nt_data/msf/machine-info` 不由此功能修改。设备快照不属于 1 GiB 缓存清理范围。

NapCat 4.18.41 的公开代码将 `os.hostname()` 传入登录的 `hostName` 和会话的 `devName`。Linux GUID 辅助工具读取 `/etc/machine-id` 与 QQ 保存的 MAC，计算 MD5；实际登录 GUID 由 QQ 原生 `getMachineGuid()` 返回。将镜像内 machine-id 换成不同的 ECS 值属于设备身份迁移，可能需要重新扫码，必须明确选择后再进行停服备份、配置发布和容器重建。保留原值并固定快照可避免升级镜像时该输入变化。DMI 与 CPU 已由 ECS 提供，平台仍为 Linux；闭源 QQ 的全部指纹字段无法由此配置保证，固定身份也不保证腾讯不撤销会话。

依据：[设备名](https://github.com/NapNeko/NapCatQQ/blob/v4.18.41/packages/napcat-common/src/system.ts)、[GUID 辅助工具](https://github.com/NapNeko/NapCatQQ/blob/v4.18.41/packages/napcat-webui-backend/src/utils/guid.ts)、[登录入口](https://github.com/NapNeko/NapCatQQ/blob/v4.18.41/packages/napcat-shell/base.ts)、[Docker 固定地址](https://docs.docker.com/reference/compose-file/services/#ipv4_address-ipv6_address)。

## QQ 缓存维护

`deploy/napcat/cache-maintenance.py` 按账号分别统计 QQ 媒体、临时文件、表情缓存和日志，超过 1 GiB 时按修改时间从旧到新删除至不超过 1 GiB。登录文件、配置、消息库与 Sunabot 业务数据库均不属于自动清理范围。它不跟随符号链接，权限错误及清理后仍超限会明确失败。

运行 `python3 deploy/napcat/cache-maintenance.py --accounts-root <远端账号目录>` 查看计划，带 `--apply` 执行。管理员要求清空全部可重建缓存时增加 `--purge-cache`。QQ 消息历史的删除单独确认并在停止对应 QQ 后处理，不能用缓存任务删除活动数据库。

随附 service 模板以 `sunabot-napcat` 用户运行；根据实际安装目录调整 ExecStart 后，安装为 `/etc/systemd/system/sunabot-napcat-cache.service`，timer 安装为 `sunabot-napcat-cache.timer` 并启用。每次任务结束一分钟后再次检查，超限会在下一次检查触发清理，检查间隔内可以短暂超限。运行日志交给 systemd journal，不新增增长型 JSON/JSONL 文件。
