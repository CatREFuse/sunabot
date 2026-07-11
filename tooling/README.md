# Tooling

开发、质量、迁移、运行维护和 workspace 管理脚手架集中在此目录。生产业务模块不得导入 `tooling/`。

- `admin/`：管理员凭据和安全熔断维护。
- `codex/`：Codex Web Coding 入口与工作说明。
- `dev/`：源码更新和开发启动辅助。
- `migrations/`：数据库与数据布局前向迁移。
- `runtime/`：QQ Runtime 配置和容器控制入口。
- `workspace/`：终端私有数据初始化、环境变量、同步和快照。
- `shared/`：仅供 tooling 使用的路径与进程辅助。
- `benchmarks/`：隔离 SQLite 性能、容量、回归比较和 72 小时 soak 门禁。
