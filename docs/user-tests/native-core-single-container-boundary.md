# 原生 Core 与唯一 NapCat 容器边界

## 用户目标

管理员在 macOS、Linux 或 WSL 中使用同一个 `./sunabot.sh` 入口启动 Sunabot，Core、管理台和 Bash 均由宿主原生进程运行；WebFetch 静态抓取在 Native Core 内完成，Linux/WSL 的动态抓取使用 Native Bubblewrap Lightpanda renderer，macOS 动态能力不可用。Docker 只负责每个 QQ 账号独立的 NapCat 容器。

## 角色与环境

- 角色：已认证管理员。
- 环境：macOS Native、Linux Native、WSL2 Native 各一组；每组均准备一个空白 Workspace 和一个已升级 Workspace。
- 账号：至少两个已启用 QQ 账号，用于验证 NapCat 容器之间的账号、配置和登录状态隔离。

## 输入

1. 执行 `./sunabot.sh up`，随后执行 `status`、`doctor`、`restart`、`logs` 与 `down`。
2. 在 Linux/WSL 中调用受限 Bash，在 macOS 中分别验证管理员 Native Bash 与普通会话不可用状态。
3. 三个平台验证 WebFetch 静态链路；Linux/WSL 再让 JavaScript 页面进入 Lightpanda 动态链路，macOS 验证动态能力明确不可用且静态结果不受影响。
4. 新增、停用并重启其中一个 QQ 账号，再观察另一个账号。
5. 扫描进程、容器、镜像、网络和运行状态，核对 Core、Bash、WebFetch 与 NapCat 的实际边界。

## 预期结果

- Core、管理 API、WebUI 与账号调和器都是当前 Workspace 可验证身份的原生进程；Linux/WSL 额外运行一个受 Bubblewrap 约束的 Native Lightpanda renderer，macOS 不运行动态 renderer。不存在 Core、Bash、MCP、Skill Script 或 WebFetch 的 Docker service、镜像、Compose profile 或运行分支。
- Docker 仅出现于 NapCat，每个已启用 QQ 账号恰好对应一个受当前 Workspace 与 account ID 标记的容器；停用或重启一个账号不会改变其他账号。
- Linux/WSL 的 Bash 使用 Bubblewrap 与资源限制；macOS 管理员 Native Bash 继续经过逐命令审批，其他 macOS 会话得到明确的能力不可用状态。
- Linux/WSL WebFetch 动态抓取只执行发行包内固定版本的 Lightpanda，不查找或安装 Chrome、Chromium、Playwright Browser 或系统浏览器；macOS 只运行 Node + Defuddle 静态链路。
- `doctor` 分别报告 Native Core、Bash 隔离和 NapCat 容器状态；Linux/WSL 报告 Lightpanda renderer，macOS 报告动态 WebFetch unavailable。NapCat 条件不满足时启动失败并给出动作，不把其他能力伪报为 Docker。
- `down` 只停止当前 Workspace 可验证的原生进程与 NapCat 容器，不向其他 Workspace 的进程或容器发送信号。

## 质量标准

- 所有状态和失败信息只显示名称、状态、动作和结果，不输出令牌、账号缓存、宿主凭据路径或内部堆栈。
- 启动、重启和停止可重复执行，不产生重复进程、孤儿容器、残留端口或跨 Workspace 清理。
- 原生能力缺失时明确失败或降级，不能静默切换到已删除的 Docker 实现。
