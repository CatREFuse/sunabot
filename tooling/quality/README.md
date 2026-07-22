# Quality tooling

这里存放架构、协议、许可证和供应链门禁。`npm run architecture` 从任意工作目录执行，并阻止旧目录、隐式 cwd 路径、services/adapters/platform 反向依赖应用组合层和已知巨型文件继续增长；TypeScript 与 Vue TypeScript 同时拒绝未使用的局部声明和参数。

`npm run test:budget` 统计 `tests/`、`packages/testkit/` 和全部 `*.test.*`/`*.spec.*` 代码文件，阻止测试代码超过 82,000 行，促使重复断言收敛到串联场景和共享合同。

`npm run smoke:api` 使用显式 `SUNABOT_WORKSPACE` 和独立端口冷启动构建产物，验证健康端点后自动停止子进程。

`npm run smoke:runtime -- preflight` 对隔离 workspace 做只读检查；真实 Provider 回复和 OneBot 管理员消息链路的双重执行闸门见 [runtime-smoke.md](runtime-smoke.md)。
