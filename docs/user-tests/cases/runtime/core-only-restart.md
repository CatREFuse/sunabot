# 单独重启 Core 并保留 QQ 在线会话

## 用户目标

管理员更新 Core 后，通过 `./sunabot.sh restart-core` 重启本机 Native 服务，NapCat 容器和 QQ 进程持续运行，无需因 Core 更新重新扫码。

## 角色与环境

- 角色：本机部署管理员；无主对话、外部 Provider 或 QQ 主动发送。
- 环境：Linux/WSL Native Core、账号调和器、Native WebFetch Renderer，以及独立 NapCat Docker 容器。macOS 保持动态 Renderer unavailable 的既有行为。
- 隔离夹具使用临时 workspace、受控 Native 进程和模拟 Docker；生产验收须获得用户部署及重启授权。

## 输入与预期结果

1. 已启动部署执行 `restart-core`：Core、账号调和器及 Renderer 更新为新进程，沿用既有 OneBot 地址、token、账号列表与 Docker 网络；不执行 NapCat stop/rm/up/recreate，不清空二维码、QQ 缓存或账号配置。
2. 校验或构建失败：旧 Core 继续运行，NapCat 不变。
3. 新 Core 启动或健康检查失败：清理本次 Native 进程，保留 NapCat、网络及已有连接配置，报告原始错误；允许修复后再次执行 `restart-core`，不自动退回完整重启。
4. 缺少既有启动状态或网络：命令明确失败，不创建或删除容器，不改写凭据。
5. `restart`、`up`、`start` 仍执行完整停止和启动；`down` 仍停止全部当前 workspace 组件。
6. 无关 workspace 的 Native 进程不能被停止。

## 验证与质量标准

- 机械证据：命令参数解析、真实隔离进程退出与替换、Docker 调用轨迹、成功与失败后的 launcher state，以及失败重试。
- 独立质量评审：确认夹具覆盖真实启动器控制流；模拟 Docker 结果不能计为真实 QQ 登录验收。
- 必需检查：受影响单元测试、harness 自检、runtime contract、类型检查、构建和相关进程管理回归。
- 生产验收：比较重启前后容器 ID、StartedAt、RestartCount、网络 ID，核验 QQ 登录、OneBot 重连和重启后真实入站消息；Core 不可用期间消息是否补发由 NapCat 决定，不能承诺零消息丢失。
- Linux/WSL amd64 的实际运行与 amd64/arm64 组件合同分别记录；未执行的 arm64 实机验收不得记作通过。

## 执行入口

`tests/unit/runtime-core-restart.test.ts`、`tests/unit/runtime-launcher.test.ts`、`tests/unit/native-core-process.test.ts`、`tests/unit/account-runtime-daemon.test.ts`。
