# Migration tooling

SQLite schema 与 workspace 布局的前向迁移命令。迁移必须先停服务并完成备份、校验和回滚准备。

| 命令 | 用途 |
| --- | --- |
| `npm run workspace:migrate` | 旧 `config/agents/artifacts/security/napcat` 布局迁移到当前 workspace 边界 |
| `npm run migrate:sqlite` | 旧 JSON/JSONL 会话、记忆、日志与索引迁移到 SQLite |
| `npm run migrate:multi-agent -- --workspace PATH` | 单 Agent 到 Plana/primary 多 Agent 结构的只读预检，并检查公共系统提示词目标冲突 |
| `npm run migrate:multi-agent -- --workspace PATH --apply --quiesced` | 创建双库恢复点，迁移 Agent、QQ 与公共系统提示词并校验文件哈希 |

单 Agent 迁移步骤见 `docs/migrations/single-agent-to-multi-agent.md`。

源码仓库中的 SQLite 与多 Agent 迁移会先构建 API，确保迁移使用当前 schema。Linux 发行包包含 schema v2 `release-manifest.json`、预构建 `dist` 和生产依赖；迁移 wrapper 核对真实平台、runtime contract、版本、Node、source commit、完整 `dist/`、`tooling/`、生产 `node_modules/` 与锁文件的文件集合和 SHA-256 后使用随包构建，无需安装 TypeScript 等开发依赖。
