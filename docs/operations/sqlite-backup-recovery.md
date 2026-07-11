# SQLite 双库备份、恢复与故障门禁

适用范围：`workspace/business/data/sunabot.sqlite` 与
`workspace/business/data/session-queue.sqlite`。两者必须作为同一个恢复点创建、校验和恢复，禁止只恢复其中一个。

## 一致性边界

- `session-queue.sqlite` 是事件、turn、tool job 和 outbox 投递状态的权威来源。
- `sunabot.sqlite` 中的会话和日志是业务记录；外发成功后若主库投影写失败，queue 中的 `sent` 状态仍然有效，恢复后不得重新发送。
- 两个 SQLite 文件不能共享一个原子事务。因此备份只允许在 Sunabot 与 NapCat 已停止写入的离线静默窗口执行。
- 创建恢复点时两个数据库依次执行 `wal_checkpoint(TRUNCATE)`，随后同时持有 `BEGIN EXCLUSIVE` 写锁，再使用 SQLite backup API 复制。
- 临时目录只有在双库 checksum、`integrity_check`、`foreign_key_check`、表记录数和 queue 状态机不变量全部通过后才原子发布。

manifest 是单项备份清单，可以使用 JSON；业务消息、日志和记忆仍只存 SQLite，不新增 JSON/JSONL 持久化。

## 每日备份

先停止整个 QQ Runtime，并确认没有第二个实例写数据库：

```bash
sudo systemctl stop sunabot-runtime.target
SUNABOT_WORKSPACE=/srv/sunabot/workspace npm run backup:create -- --quiesced
SUNABOT_WORKSPACE=/srv/sunabot/workspace npm run backup:prune
sudo systemctl start sunabot-runtime.target
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

恢复命令只接受一个空目标 workspace，不覆盖现有数据库：

```bash
npm run backup:restore -- \
  --backup /srv/sunabot/workspace/backups/sqlite-recovery/<backup-id> \
  --target-workspace /srv/sunabot/restore-staging
```

校验通过后，再在服务停止状态下把旧 `business/data` 移入独立回滚目录，并切换已验证的恢复目录。不得删除旧数据库，也不得在运行中的数据库上原地覆盖。

恢复验收包括：

- manifest 与双库 SHA-256、文件大小和 SQLite 页布局一致；
- `PRAGMA integrity_check` 为 `ok`，`foreign_key_check` 为空；
- 所有表记录数与 manifest 一致；
- session/event/outbox sequence 边界成立；
- terminal outbox 位于已完成前缀，`sent` 必须有 `sent_at`；
- terminal outbox digest 与状态计数未变化。

## 季度恢复演练

季度演练默认恢复到系统临时目录，完成后自动删除临时副本，不触碰生产：

```bash
npm run backup:drill -- \
  --backup /srv/sunabot/workspace/backups/sqlite-recovery/<backup-id> \
  --report /srv/sunabot/workspace/backups/drills/2026-Q3.json
```

报告记录实际 RTO、备份年龄对应的 RPO、双库记录数和 queue 不变量。季度演练必须选择最近一次每日恢复点；`rpoHours` 必须小于等于 24，`integrity` 必须为 `ok`。RTO 使用报告中的 `rtoMilliseconds` 留档，不以估算值替代。

## 故障注入门禁

```bash
npm run backup:gate
```

该门禁只使用临时 workspace，覆盖：

- 备份中断或进程强杀后遗留的 lock/partial 恢复；
- 模拟 `ENOSPC` 时不发布恢复点；
- `SQLITE_BUSY` 时失败退出而不绕过活动写入；
- WAL 尚未 checkpoint 时，已提交帧仍进入双库备份；
- 缺少数据库文件及同尺寸内容损坏时校验失败；
- OneBot 外发成功但主库投影写失败后，恢复的 outbox 保持 `sent` 且不可再次 claim；
- 7/30 天分层保留和隔离季度恢复演练。
