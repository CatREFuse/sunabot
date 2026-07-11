# Quality tooling

这里存放架构、协议、许可证和供应链门禁。`npm run architecture` 从任意工作目录执行，并阻止旧目录、隐式 cwd 路径和已知巨型文件继续增长。

`npm run smoke:api` 使用显式 `SUNABOT_WORKSPACE` 和独立端口冷启动构建产物，验证健康端点后自动停止子进程。
