# Codex Web Coding

1. 进入项目根目录。
2. 阅读根 `AGENTS.md`、`docs/specs/index.md` 与修改范围对应的规范模块。
3. 执行 `npm ci` 和 `npm run verify` 建立基线。
4. 运行态与测试数据必须使用独立 `SUNABOT_WORKSPACE`，不得指向生产 workspace。

根 `AGENTS.md` 是自动发现入口；本目录只保存开发脚手架，不进入生产镜像。
