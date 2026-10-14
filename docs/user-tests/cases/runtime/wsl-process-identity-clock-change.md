# WSL 对时后的进程身份与安全重启

## 用户目标

Windows/WSL 对时后，Core 和账号调和器继续被正确识别，管理员可以检查状态并安全重启当前部署，QQ 登录缓存和业务数据得到保留。

## 角色与环境

- 角色：已认证管理员，通过本机 `./sunabot.sh` 操作；本用例不触发 QQ 对话或外部 Provider。
- 环境：Linux/WSL Native Core、账号调和器、Native Renderer 与每账号独立 NapCat 容器。
- 故障注入仅使用临时目录和受测试控制的进程；不得更改运行主机时钟、生产 owner 文件或真实 QQ 登录状态。

## 输入与验证

1. 为同一 Linux 进程提供相同 boot ID、PID 与 `/proc/<pid>/stat` starttime ticks，令墙钟前移或后移 315 秒，重复观察并核验保存的进程身份。
2. 保持 PID 不变，分别更换 starttime ticks、boot ID、入口命令、owner token 或进程组，检查身份核验拒绝错误对象。
3. 使用包含空格和右括号的 Linux comm 字段、错误 PID、缺失或非法 starttime、非法 boot ID 验证 `/proc` 解析。
4. 在窄终端宽度下启动带长路径和 owner token 的测试 daemon，确认完整命令可读且 owner 核验成功。
5. 在隔离 workspace 启动受控 Core，并保存已漂移的旧 `lstart` launcher-state。调用当前启动器 `down` 使用的实时扫描和停止入口，重新核对命令、workspace 环境与进程组，停止所属 Core；同入口的其他 workspace 进程必须继续存活。完整 `./sunabot.sh down` 和后续启动由部署验收确认。
6. 对非 Linux 平台的采集调用验证继续使用既有 `ps lstart` 行为。
7. 在另一隔离 workspace 启动测试 daemon，暂停该测试进程并把其 owner 的签名改为历史 `lstart` 字符串。执行真实 launcher `down`，Docker 由本地模拟命令替代，确认停止后重新读取 owner 状态并清理已失效记录，同一时刻的无关测试进程继续存活。

## 预期结果

- Linux 进程签名使用 boot ID 与 starttime ticks，墙钟变化不影响同一进程识别。
- PID 复用、系统重新启动或其他身份字段变化仍拒绝匹配，不降级为仅按 PID 或命令发送信号。
- 长命令不会被终端宽度截断。
- 旧持久签名不能被自动当作新签名；停止流程以当前 workspace 的完整实时证据重验，原 owner 证据按既有流程保留或清理。
- 全部验证不读取或更改真实账号登录缓存、业务数据库、历史消息与记忆。

## 质量标准

- 有时钟变化前后的机械身份断言、非法输入断言和旧部署安全停止证据。
- 受控无关进程在停止验收后保持存活。
- 不把测试平台上的通过结果冒称为未执行的真实主机对时或双架构验收。

## 执行入口

`tests/unit/runtime-process-identity.test.ts`、`tests/unit/account-runtime-daemon.test.ts`、`tests/unit/native-core-process.test.ts`、`tests/unit/native-webfetch-renderer-process.test.ts` 与 `tests/unit/runtime-launcher.test.ts`。
