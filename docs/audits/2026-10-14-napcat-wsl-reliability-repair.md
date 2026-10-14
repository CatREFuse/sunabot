# NapCat 升级与 Windows / WSL 对时修复

日期：2026-10-14。环境：Windows 11、Ubuntu 24.04 WSL2、Native Core、每账号独立 NapCat Docker。

## 已部署修复

- NapCat 从 4.18.28 升级到 4.18.30，QQ 从 3.2.30-50969 升级到 3.2.32-52194。OCI index 固定为 `sha256:335f9310198504d8d07aba91cc91d89215269891919c26eb4e46052ff8bb176d`；amd64 镜像已实际启动，arm64 仅核验上游清单及运行合同。
- Linux 进程身份改用 boot ID 与 `/proc/<pid>/stat` 启动 tick。原有命令、workspace、owner token、进程组校验保留；账号调和进程的命令读取使用完整宽度，停止后重新判定 owner。时钟校正不再使同一存活进程被误判为已停止。
- 管理 API 使用 QQ 实际 `online` 状态，保留登录错误；缓存身份信息不能证明在线。管理台状态轮询等待当前请求完成，同账号请求复用，失败清除旧状态；账号切换后的过期响应不能覆盖当前账号。
- OneBot 最近事件、消息时间按账号记录，管理台与服务监控使用目标账号数据。暂时离线时保留登录态，明确手动重新登录入口。
- Windows W32Time 使用 `47.96.149.233,0x8 203.107.6.88,0xA`；WSL `systemd-timesyncd` 已停用，保留 `hv_utils.timesync_implicit=1`。两个地址来自已核验的阿里云 NTP 服务；地址调整后需要重新核验可达性并更新配置。

## 证据与数据保护

原 Windows 时间慢约 72 秒。10:54:38—10:54:42 的 NTP 采样偏差为 +2.129、-1.300、+0.841 毫秒；W32Time 为 Automatic / Running、Leap 0、stratum 3。10:55:49 独立复核时，WSL UTC 落在 Windows 232 毫秒调用采样窗口内，timesyncd 为 inactive / disabled。

历史日志存在三次“登录已失效”和多次静默离线；两次登录失效发生在已确认的 319 秒时钟调整之前。时钟与进程身份缺陷已有证据，不能据此认定所有 QQ 踢出均由对时引起。用户已确认旧实例完全停止。

使用统一入口停服后，全部 4 个业务/队列数据库完成 checkpoint、离线恢复点创建和完整校验。QQ 持久挂载路径保持不变，业务、配置和登录目录归档为 1,954,480,234 字节、3,258 个条目，SHA-256 为 `26936f3a965d47aaf5cb8f6f6ec3b1edb279821fb44830bdf0e115c1a3ea9402`。

本机恢复点根目录为 `/home/sunabot/sunabot/workspace/backups/napcat-upgrade-20261014`，数据库恢复点为其 `sqlite/sqlite-recovery-20261014T024746282Z-68435da0`。原源码、前后端构建、旧镜像、时间服务注册表及启用状态均保留。升级没有退出 QQ、清除登录缓存或替换业务数据库；未修改旧主机、Clash、防火墙、WSL 网络模式或桌面 QQ。

## 验证结果

- runtime contract、架构检查、TypeScript / Vue 类型检查及前后端构建通过。
- 完整单元测试首轮 3,081 通过、1 失败、1 原有跳过；唯一失败来自验证目录漏同步现有表情测试的原子文件恢复夹具，同步后该文件 14/14 通过，无产品代码变更。
- user harness 自测 37/37、运行冒烟 84/84、集成 / 工具隔离 / SQLite 恢复 / 迁移及 CI benchmark 全部通过。
- E2E 53/53。视觉首轮 48/50；旧登录夹具错过短暂请求阶段，固定请求完成时机后，受影响的两主题与四视口矩阵 6/6 通过。人工查看在线、离线、未知、保留登录态的桌面及移动端浅色/深色截图，无横向溢出。
- 生产启动器为 live / ready，新 Core、Renderer、账号调和进程均使用 `linux:<boot-id>:<start-tick>` 身份。原有未配置 MCP 能力仍报告 degraded，不计为本次恢复成功项。
- 真实管理台显示 390 条记忆、11 个会话、37 张图像；等待登录时左右状态均显示离线。

## 需要手机完成的验收

升级后的 NapCat 能找到原 QQ 快速登录记录，但 10:55:26 返回“登录态已失效，请重新登录”。缓存完整保留不能强制 QQ 接受失效凭据，已提供新二维码并打开管理台扫码窗口。

真实消息接收与 OneBot 受控断线恢复尚待手机确认登录，不能以容器 healthy、Core ready、单测或模拟截图替代。扫码后应核对 `CheckLoginStatus`、`GetQQLoginInfo.online`、账号 OneBot 连接以及新消息入库，再仅断开已验证属于阿罗娜的 OneBot TCP 连接，确认自动重连及后续新消息。

上游 60 秒静默离线 Worker 恢复、腾讯强制登录失效、arm64 实机和长期稳定性尚未实测，不能承诺永不掉线。上游版本说明见 [NapCat 4.18.30](https://github.com/NapNeko/NapCatQQ/releases/tag/v4.18.30)，WSL 时钟机制见 [Ubuntu WSL 时间同步说明](https://ubuntu.com/wsl/docs/stable/explanation/time-sync/)。
