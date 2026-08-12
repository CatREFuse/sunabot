# 0.1.0 / 0.1.1 升级到 0.1.2

适用范围：当前运行 `0.1.0` 或 `0.1.1`，并使用仓库根 `./sunabot.sh` 管理 Core 与 NapCat 的实例。旧单容器实例必须先按 `one-container-to-split-runtime.md` 完成运行时拆分。

## 变更

- Agent 保留相互独立的 `workbench/` 与 `docker-workbench/`。
- 自拍、表情、Skills 与知识库的权威目录分别是 `workbench/selfie/`、`workbench/emoji/`、`workbench/skills/` 与 `workbench/knowledge/`。
- Docker Bash 的 cwd 是独立可写的 `/workbench`，完整 Native workbench 只读投影到 `/workbench/native-workbench`。
- Native Bash 的 cwd 是真实 `workbench/`，`SUNABOT_DOCKER_WORKBENCH` 指向可寻址的 Docker workbench。
- 自拍清单从 `references.json` 迁移为 `references.jsonl`；表情目录使用 `emojis.jsonl`，旧 SQLite 表情记录在 JSONL 复读成功后清除。
- 系统提示词升级为双工作区 v3 合同，并保留管理员自定义内容。

## 预检

默认 workspace 是仓库根 `workspace/`；自定义路径必须使用绝对路径。

```bash
npm run upgrade:0.1.2 -- plan
npm run upgrade:0.1.2 -- plan --workspace /absolute/path/to/workspace
```

预检核对 package、lock、runtime contract、发行目录和 Docker 默认版本，并列出每个 Agent 的自拍、表情与工作区迁移状态。冲突、非法路径或损坏清单会在停服前失败。

## 执行

```bash
npm run upgrade:0.1.2 -- apply
```

脚本依次停止服务、创建全部 Agent 业务库与队列库恢复点、迁移表情 JSONL、迁移自拍 JSONL、备份并迁移四类资源、校验迁移，然后启动服务并执行 `status` 与 `doctor`。失败时服务保持停止，避免旧代码与新布局同时写入。

## 验收

```bash
npm run migrate:selfie-jsonl -- verify --workspace /absolute/path/to/workspace
npm run migrate:agent-resources -- verify --workspace /absolute/path/to/workspace
./sunabot.sh status
./sunabot.sh doctor
```

需要确认所有 Agent 具备两个 `index.md` 与四个资源入口，Docker 投影读取到与 Native 相同的文件字节且写入失败，Docker cwd 保持可写，Native Bash 能定位 Docker workbench。`connected=unknown` 不代表真实 QQ 收发成功。

## 回滚

先停止服务。自拍清单使用升级输出中的独立备份回滚；表情或 SQLite 数据使用升级输出中的全 Agent SQLite `recoveryPoint`；工作区目录使用 `agentResources.backup`：

```bash
npm run migrate:agent-resources -- rollback \
  --workspace /absolute/path/to/workspace \
  --backup backups/agent-workbenches-v2-<timestamp> \
  --quiesced
```

迁移后资源已发生变化时，工作区回滚会以冲突停止，避免覆盖管理员或 Bot 的新内容。完整 SQLite 恢复流程见 `docs/operations/sqlite-backup-recovery.md`。
