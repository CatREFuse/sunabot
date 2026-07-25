# Migration tooling

SQLite schema 与 workspace 布局的前向迁移命令。迁移必须先停服务并完成备份、校验和回滚准备。

| 命令 | 用途 |
| --- | --- |
| `npm run workspace:migrate` | 旧 `config/agents/artifacts/security/napcat` 布局迁移到当前 workspace 边界 |
| `npm run migrate:sqlite` | 旧 JSON/JSONL 会话、记忆、日志与索引迁移到 SQLite |
| `npm run migrate:multi-agent -- --workspace PATH` | 单 Agent 到 Plana/primary 多 Agent 结构的只读预检，并检查公共系统提示词目标冲突 |
| `npm run migrate:multi-agent -- --workspace PATH --apply --quiesced` | 创建双库恢复点，迁移 Agent、QQ 与公共系统提示词并校验文件哈希 |
| `npm run migrate:selfie-jsonl -- plan --workspace PATH` | 只读检查全部 Agent 的 `references.json` 到 `references.jsonl` 迁移状态 |
| `npm run migrate:selfie-jsonl -- apply --workspace PATH --quiesced` | 停服后备份、原子发布自拍 JSONL 清单并删除已备份的旧清单 |
| `npm run migrate:agent-resources -- plan --workspace PATH` | 只读枚举全部 Agent 的旧资源路径、表情引用和迁移需求 |
| `npm run migrate:agent-resources -- apply --workspace PATH --quiesced` | 停服后备份并把自拍、表情、Skills、知识库迁入 Native `workbench/` |
| `npm run migrate:agent-resources -- verify --workspace PATH` | 校验 marker、固定管理入口和旧路径退役状态 |
| `npm run upgrade:0.1.2 -- plan [--workspace PATH]` | 只读检查 0.1.0 / 0.1.1 到 0.1.2 的版本与双工作区迁移状态 |
| `npm run upgrade:0.1.2 -- apply [--workspace PATH]` | 自动停服、创建全 Agent SQLite 恢复点、迁移资源、启动并运行 status/doctor |

单 Agent 迁移步骤见 `docs/migrations/single-agent-to-multi-agent.md`。
Agent 双工作区、Native 只读投影、自拍 JSONL 验证及回滚步骤见
`docs/migrations/agent-workbenches.md`。
0.1.0 / 0.1.1 到 0.1.2 的完整升级与回滚步骤见
`docs/migrations/upgrade-0.1.0-to-0.1.2.md`。

源码仓库中的 SQLite 与多 Agent 迁移会先构建 API，确保迁移使用当前 schema。Linux 发行包包含 schema v2 `release-manifest.json`、预构建 `dist` 和生产依赖；迁移 wrapper 核对真实平台、runtime contract、版本、Node、source commit、完整 `dist/`、`tooling/`、生产 `node_modules/` 与锁文件的文件集合和 SHA-256 后使用随包构建，无需安装 TypeScript 等开发依赖。
