# 全 Agent SQLite 备份、恢复与故障门禁

适用范围包括默认 Plana 的 `workspace/business/data/{sunabot.sqlite,session-queue.sqlite}`，以及注册表中每个启用或停用 Agent 的 `workspace/business/agents/<agentId>/data/{sunabot.sqlite,session-queue.sqlite}`。所有 Agent 数据库对必须作为同一个恢复点创建、校验和恢复，禁止遗漏 Agent 或只恢复其中一个数据库。

## 一致性边界

- 每个 Agent 的 `session-queue.sqlite` 是该 Agent 事件、turn、tool job 和 outbox 投递状态的权威来源。
- 每个 Agent 的 `sunabot.sqlite` 保存该 Agent 的会话和日志；OneBot 远端成功后，queue 先保存 receipt 与 `sent_remote`，业务库投影、请求日志、记忆和 hook 只继续本地 settle，恢复后不得再次外发。
- 多个 SQLite 文件不能共享一个原子事务。因此备份只允许在 Sunabot 与全部 NapCat 已停止写入的离线静默窗口执行。
- 创建恢复点时先读取注册主库和 Agent 数据目录的并集。注册 Agent 缺库、单边数据库、未注册 Agent 数据库、非法 ID 或不安全路径都会终止备份。
- 所有数据库依次执行 `wal_checkpoint(TRUNCATE)`，随后全部持有 `BEGIN EXCLUSIVE` 写锁，再使用 SQLite backup API 复制。
- 临时目录只有在全部数据库 checksum、`integrity_check`、`foreign_key_check`、当前 schema 必需表、表记录数和各 Agent queue 状态机不变量通过后才原子发布。

新恢复点使用 manifest v2，逐项记录安全的 Agent ID、数据库类型、workspace 相对源路径、备份文件名和各 Agent queue 不变量。旧 manifest v1 恢复点仍可校验和恢复，其范围仅包含默认 Plana 双库。manifest 是单项备份清单，可以使用 JSON；业务消息、日志和记忆仍只存 SQLite，不新增 JSON/JSONL 持久化。

## 每日备份

先使用统一入口停止 Core 与 NapCat，并确认没有第二个实例写数据库。需要保持显式 Core 模式时，在停止和恢复启动时使用相同的 `SUNABOT_CORE_MODE`：

```bash
SUNABOT_CORE_MODE=docker ./sunabot.sh down
./sunabot.sh doctor
SUNABOT_WORKSPACE=/srv/sunabot/workspace npm run backup:create -- --quiesced
SUNABOT_WORKSPACE=/srv/sunabot/workspace npm run backup:prune
SUNABOT_CORE_MODE=docker ./sunabot.sh up
```

`backup:prune` 默认只输出计划。人工核对后才执行：

```bash
SUNABOT_WORKSPACE=/srv/sunabot/workspace npm run backup:prune -- --apply
```

保留策略固定为：

- 最近 7 天保留每一个已验证恢复点；
- 第 8–30 天每天保留最新一个恢复点；
- 超过 30 天的已验证恢复点可清理；
- 损坏、缺失 manifest 或未完成的目录不自动删除。

每日调度必须包含 stop → backup → dry-run/apply retention → start，并将非零退出码接入现有告警。恢复点位于
`workspace/backups/sqlite-recovery/`，RPO 目标为不超过 24 小时。

## 校验与恢复

任意恢复点可在不写源 workspace 的情况下重复校验：

```bash
npm run backup:verify -- --backup /srv/sunabot/workspace/backups/sqlite-recovery/<backup-id>
```

首次恢复只接受完全空的目标 workspace，不覆盖现有文件或数据库。命令在复制前持久化 fsync intent，并逐文件记录 copied、replaced 和 completed；进程中断后以相同 backup 和 target 再次执行会按 journal 继续，未知文件、孤儿库和单边数据库都会失败关闭：

```bash
npm run backup:restore -- \
  --backup /srv/sunabot/workspace/backups/sqlite-recovery/<backup-id> \
  --target-workspace /srv/sunabot/restore-staging
```

需要放弃未完成的恢复时执行：

```bash
node tooling/workspace/sqlite-recovery-cli.mjs rollback \
  --backup /srv/sunabot/workspace/backups/sqlite-recovery/<backup-id> \
  --target-workspace /srv/sunabot/restore-staging
```

回滚只删除 journal 中记录且类型、大小、SHA-256 仍匹配的恢复产物；未知替换保持原样并返回冲突。恢复、回滚、演练、保留清理和 stale partial 清理都会逐级检查绝对路径父链，用户符号链接路径不会写入或删除外部内容。

校验通过后，再在服务停止状态下把旧 `business/data` 与 `business/agents/*/data` 移入独立回滚目录，并切换已验证的恢复目录。不得删除旧数据库，也不得在运行中的数据库上原地覆盖。

恢复验收包括：

- manifest 中的全部 Agent 数据库与 SHA-256、文件大小和 SQLite 页布局一致；
- manifest 的 Agent 集合与备份内 Plana 注册表完全一致；
- `PRAGMA integrity_check` 为 `ok`，`foreign_key_check` 为空；
- 所有表记录数与 manifest 一致；
- 每个 Agent 的 session/event/outbox sequence 边界成立；
- 每个 Agent 的 terminal outbox 位于已完成前缀，`sent` 必须有 `sent_at`；
- 每个 Agent 的 terminal outbox digest 与状态计数未变化。

## 季度恢复演练

季度演练默认恢复到系统临时目录，完成后自动删除临时副本，不触碰生产：

```bash
npm run backup:drill -- \
  --backup /srv/sunabot/workspace/backups/sqlite-recovery/<backup-id> \
  --report /srv/sunabot/workspace/backups/drills/2026-Q3.json
```

报告记录实际 RTO、备份年龄对应的 RPO、全部 Agent 数据库记录数和分 Agent queue 不变量。季度演练必须选择最近一次每日恢复点；`rpoHours` 必须小于等于 24，`integrity` 必须为 `ok`。RTO 使用报告中的 `rtoMilliseconds` 留档，不以估算值替代。

## 故障注入门禁

```bash
npm run backup:gate
```

该门禁只使用临时 workspace，覆盖：

- 备份中断或进程强杀后遗留的 lock/partial 恢复；
- intent 写入后、复制前、复制后和 rename 后的幂等继续与安全回滚；
- 模拟 `ENOSPC` 时不发布恢复点；
- `SQLITE_BUSY` 时失败退出而不绕过活动写入；
- WAL 尚未 checkpoint 时，已提交帧仍进入完整恢复点；
- 默认 Plana 与停用 Agent 的四库创建、校验和嵌套恢复；
- 注册 Agent 缺库、单边数据库和未注册 Agent 孤儿库拒绝；
- 缺少备份文件及第二 Agent 数据库同尺寸内容损坏时校验失败；
- manifest 中不安全的 ID、源路径和文件名拒绝，非空恢复目标拒绝；
- 删除或增加 Agent 条目后，即使重算 manifest checksum 也会因 Plana 注册表不一致而拒绝；
- manifest v1 旧恢复点继续校验和恢复；
- OneBot 外发成功但主库投影写失败后，恢复的 outbox 保持 `sent` 且不可再次 claim；
- 7/30 天分层保留和隔离季度恢复演练。
- backup、recovery root 与 target workspace 的父链符号链接攻击拒绝；macOS 根级 `/tmp` 与 `/var` 系统别名保持可用。
