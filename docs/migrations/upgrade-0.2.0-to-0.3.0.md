# 0.2.0 升级到 0.3.0

本升级把每个 Agent 的资源与任务文件统一到 `workspace/business/agents/<agentId>/workbench/`。旧 `docker-workbench/` 中的普通文件经过逐文件校验后合入 canonical Workbench，原目录在成功迁移后进入恢复点归档。

## 适用范围

- 来源版本为完整的 `0.2.0` workspace。
- 目标代码包的 `package.json` 与 lockfile 版本均为 `0.3.0`。
- Core、管理台、全部 NapCat 和任何可能写入 workspace 的维护进程均已停止。
- 命令由拥有仓库和 workspace 的非 root 用户执行。

版本不明、workspace 被多个实例共用、Agent 目录含符号链接、硬链接或特殊文件时停止迁移并保留现场。

## 合并规则

迁移器递归枚举每个 Agent 的 `docker-workbench/`，再逐项检查对应的 `workbench/` 目标：

- 目标缺失：复制源文件并核对 SHA-256；
- 目标是字节完全相同的普通文件：保留 canonical 文件并记录为 identical；
- 目标内容不同、类型不同、路径链不安全：写入冲突报告并拒绝 apply；
- 旧 `native-workbench/` 投影目录必须为空，包含任何文件时按冲突处理。

冲突检查在 SQLite 恢复点与资源修改之前完成。冲突报告位于 `workspace/backups/upgrade-0.3.0/conflicts/`，报告明确记录 `resourceDirectoriesModified=false` 与 `sqliteModified=false`。

## 只读预检

```bash
export SUNABOT_WORKSPACE=/absolute/path/to/workspace
./sunabot.sh upgrade-0.3.0 plan --workspace "$SUNABOT_WORKSPACE"
```

检查输出中的全部 Agent、待复制文件、字节相同文件和冲突。`ok=false` 或 `conflicts` 非空时不要执行 apply；人工核对并统一冲突内容后重新运行 plan。迁移器不会选择任一侧覆盖另一侧。

## 停服与 apply

```bash
SUNABOT_WORKSPACE="$SUNABOT_WORKSPACE" ./sunabot.sh down
SUNABOT_WORKSPACE="$SUNABOT_WORKSPACE" ./sunabot.sh status
./sunabot.sh upgrade-0.3.0 apply --quiesced --workspace "$SUNABOT_WORKSPACE"
```

`--quiesced` 是显式停服确认，缺失时命令返回 `SINGLE_WORKBENCH_QUIESCENCE_REQUIRED`。apply 不负责启动服务。

无冲突时，恢复点位于：

```text
workspace/backups/upgrade-0.3.0/recovery-<timestamp>-<id>/
├── migration.json
├── sqlite/before/
├── before/agents/<agentId>/workbench/
├── before/agents/<agentId>/docker-workbench/
└── archived/agents/<agentId>/docker-workbench/
```

恢复点包含全 Agent 业务库与 queue 数据库、迁移前两套资源树、逐文件摘要、合并结果和旧根归档。迁移器在 SQLite checkpoint 与恢复点完成后记录全部 workspace SQLite 主文件摘要，资源合并后再次核对，并使用恢复点 manifest 检查数据库表、记录数、页布局与跨库不变量。

复制、入口校验或归档失败时，迁移器使用资源前镜像恢复原目录；自动恢复失败会返回恢复点路径并保持服务停止。

## 完成校验

```bash
./sunabot.sh upgrade-0.3.0 verify --workspace "$SUNABOT_WORKSPACE" \
  --recovery /absolute/path/to/recovery-point
```

verify 要求：

- 每个已迁移 Agent 只保留 canonical `workbench/`；
- 旧根位于恢复点归档，字节摘要与迁移时一致；
- `workbench/index.md`、`selfie/references.jsonl`、`emoji/emojis.jsonl`、`skills/index.json`、`knowledge/index.json` 均存在且可解析；
- canonical 资源树与迁移完成 manifest 一致；
- `migration.json` 记录 `sqliteUnchanged=true`。

验证通过后启动并检查运行状态：

```bash
SUNABOT_WORKSPACE="$SUNABOT_WORKSPACE" ./sunabot.sh up
SUNABOT_WORKSPACE="$SUNABOT_WORKSPACE" ./sunabot.sh status
SUNABOT_WORKSPACE="$SUNABOT_WORKSPACE" ./sunabot.sh doctor
```

管理台逐个切换 Agent，检查知识库、自拍参考图和表情只显示一套记录，所有内容 URL 与请求均不包含 `workbench=native|docker|all` 或 `docker-workbench` 路径段。真实 QQ 验收覆盖私聊、群聊、资源检索、图片引用、文件回传和重启恢复。

## 可重入

- plan 始终只读，可重复执行。
- apply 在旧根已经全部归档时返回 `alreadyApplied=true`，不会创建第二份资源或空旧根。
- 复制中途抛错会恢复 canonical 前镜像；再次 apply 会重新执行完整逐文件预检。
- verify 可重复执行；资源发生变化后会返回 drift，不会更新完成 manifest。

## 回滚

回滚会覆盖 canonical Workbench，必须在服务全部停止且迁移后的资源尚未变化时执行：

```bash
SUNABOT_WORKSPACE="$SUNABOT_WORKSPACE" ./sunabot.sh down
./sunabot.sh upgrade-0.3.0 rollback --quiesced \
  --workspace "$SUNABOT_WORKSPACE" \
  --recovery /absolute/path/to/recovery-point
```

回滚前会比较 canonical 资源树与迁移完成摘要；存在 drift 时返回 `SINGLE_WORKBENCH_ROLLBACK_DRIFT`。通过校验后，迁移后的 canonical 树移入恢复点的 `rollback-after/`，迁移前 canonical 镜像复原，旧 `docker-workbench/` 归档回到原路径。重复 rollback 返回 `alreadyRolledBack=true`。

SQLite 在本迁移中没有 schema 或数据变更。需要恢复数据库时使用同一恢复点下 `sqlite/before/` 并遵循 [全 Agent SQLite 备份、恢复与故障门禁](../operations/sqlite-backup-recovery.md)，禁止复制单个数据库文件拼接恢复。
