# 全 Agent SQLite 备份、恢复与故障门禁

适用范围包括默认 Plana 的 `workspace/business/data/{sunabot.sqlite,session-queue.sqlite}`，以及注册表中每个启用或停用 Agent 的 `workspace/business/agents/<agentId>/data/{sunabot.sqlite,session-queue.sqlite}`。所有 Agent 数据库对必须作为同一个恢复点创建、校验和恢复，禁止遗漏 Agent 或只恢复其中一个数据库。

## 一致性边界

- 每个 Agent 的 `session-queue.sqlite` 是该 Agent 事件、turn、tool job 和 outbox 投递状态的权威来源。
- 每个 Agent 的 `sunabot.sqlite` 保存该 Agent 的会话和日志；OneBot 远端成功后，queue 先保存 receipt 与 `sent_remote`，业务库投影、请求日志、记忆和 hook 只继续本地 settle，恢复后不得再次外发。
- 多个 SQLite 文件不能共享一个原子事务。因此备份只允许在 Sunabot 与全部 NapCat 已停止写入的离线静默窗口执行。
- 创建恢复点时先读取注册主库和 Agent 数据目录的并集。注册 Agent 缺库、单边数据库、未注册 Agent 数据库、非法 ID 或不安全路径都会终止备份。
- 所有数据库依次执行 `wal_checkpoint(TRUNCATE)`，随后全部持有 `BEGIN EXCLUSIVE` 写锁，再使用 SQLite backup API 复制。
- 临时目录只有在全部数据库 checksum、`integrity_check`、`foreign_key_check`、当前 schema 必需表、表记录数和各 Agent queue 状态机不变量通过后才原子发布。
- 临时恢复点会写入目录所有权记录，并在发布前后复核 workspace、备份根目录父链、目录 inode、文件 inode/link count、大小与摘要；异常收尾只处理仍由本次恢复点所有权记录证明的文件，外部替换或缺少所有权证据的目录会被隔离并保留原物。

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

回滚只删除 journal 中记录且类型、大小、SHA-256 仍匹配的恢复产物；未知替换保持原样并返回冲突。恢复库每次 SQLite 校验都先验证主文件类型、大小和 SHA-256，再删除同名且仍为普通文件的 `-wal`、`-shm`，校验关闭后再次删除本次只读检查生成的 sidecar；异常类型或 staging 内其他文件继续失败关闭。恢复、回滚、演练、保留清理和 stale partial 清理都会逐级检查绝对路径父链，用户符号链接路径不会写入或删除外部内容。lock、partial 和已发布目录的删除均采用身份与内容的比较并交换检查；检测到 successor 或路径替换时返回冲突，不删除新对象。

校验通过后，再在服务停止状态下把旧 `business/data` 与 `business/agents/*/data` 移入独立回滚目录，并切换已验证的恢复目录。不得删除旧数据库，也不得在运行中的数据库上原地覆盖。

恢复验收包括：

- manifest 中的全部 Agent 数据库与 SHA-256、文件大小和 SQLite 页布局一致；
- manifest 的 Agent 集合与备份内 Plana 注册表完全一致；
- `PRAGMA integrity_check` 为 `ok`，`foreign_key_check` 为空；
- 所有表记录数与 manifest 一致；
- 每个 Agent 的 session/event/outbox sequence 边界成立；
- 每个 Agent 的 terminal outbox 位于已完成前缀，`sent` 必须有 `sent_at`；
- 每个 Agent 的 terminal outbox digest 与状态计数未变化。

## Arona Dream 身份别名定向修复

`migrate:dream-identity-aliases` 只处理 Arona 的 Dream run
`c810a3fa-3422-46fc-a2b9-d5b6938fe476` 及其三条已审计长期记忆。工具从指定的
offline-quiesced 恢复点重建 63 个 `人物-<24hex>` 映射，默认只输出摘要、数量与
SHA-256，不输出身份原值或记忆正文。历史 `人物-<10hex>` 不在本次修复范围。

dry-run 使用 immutable 只读连接；当前业务库存在未收敛 WAL 时以
`CURRENT_WAL_NOT_QUIESCED` 退出，不创建目标库 sidecar，也不修改业务数据、queue
或 `WORKING_MEMORY.md`：

```bash
npm run migrate:dream-identity-aliases -- \
  --workspace /srv/sunabot/workspace \
  --agent arona \
  --run c810a3fa-3422-46fc-a2b9-d5b6938fe476 \
  --recovery-point /srv/sunabot/workspace/backups/sqlite-recovery/<mapping-backup-id> \
  --recovery-point-id sha256:<mapping-recovery-point-id>
```

apply 前使用统一入口停止 Core 与全部 NapCat，确认 doctor 不再报告活动写入，再创建并
校验一个晚于映射恢复点的新 offline-quiesced 回滚恢复点：

```bash
./sunabot.sh down
./sunabot.sh doctor
SUNABOT_WORKSPACE=/srv/sunabot/workspace npm run backup:create -- --quiesced
npm run backup:verify -- \
  --backup /srv/sunabot/workspace/backups/sqlite-recovery/<rollback-backup-id>
```

记录 dry-run 返回的 `mapping.digest`，并把新恢复点的绝对路径与
`manifest.recoveryPointId` 显式绑定到 apply：

```bash
npm run migrate:dream-identity-aliases -- \
  --workspace /srv/sunabot/workspace \
  --agent arona \
  --run c810a3fa-3422-46fc-a2b9-d5b6938fe476 \
  --recovery-point /srv/sunabot/workspace/backups/sqlite-recovery/<mapping-backup-id> \
  --recovery-point-id sha256:<mapping-recovery-point-id> \
  --apply \
  --quiesced \
  --rollback-recovery-point /srv/sunabot/workspace/backups/sqlite-recovery/<rollback-backup-id> \
  --rollback-recovery-point-id sha256:<rollback-recovery-point-id> \
  --expected-mapping-digest <dry-run-mapping-digest>
```

apply 会再次检查 Native Core、账号调和进程、`8787`/`8788` 监听与当前 workspace
的运行容器，并把回滚恢复点逐库绑定到当前 quiesced workspace 的完整数据库集合。绑定范围
包括 Plana 与全部 Agent 的 application、session queue；每个库按 SQLite schema、pragma、
rowid/主键和类型化行值计算逻辑摘要，因此同记录数的字段变化、queue/outbox 变化、其他
Agent 变化或新增/缺失数据库对都会以 `ROLLBACK_RECOVERY_POINT_STALE` 退出。绑定会在打开
写连接前完整复核，并在提交前与 checkpoint 后复核全部非目标业务库；目标业务库由事务内
精确前置条件与文件身份守卫覆盖。获得 `BEGIN IMMEDIATE` 锁后、执行首条更新前，工具还会
用同一个写连接重新计算目标 application 的完整逻辑摘要，拒绝初次绑定后发生的同记录数漂移。
回滚恢复点的目录链按规范路径与 `dev:ino` 绑定，恢复点直属子项按名称、类型与
`dev:ino` 固定摘要；manifest、manifest checksum、全部数据库文件和标准 WAL/SHM 还会绑定
link count、大小与 SHA-256，并在提交前及完成后复核。恢复点文件被删除、替换或增加未授权
子项时，提交前以 `ROLLBACK_RECOVERY_POINT_CHANGED` 回滚退出。调用通用恢复点验证前先
固定原始 manifest bytes、checksum、recovery point ID 与精确 `.sqlite` 文件集，验证返回值
必须与该快照逐项一致。verify 期间仅允许校验器为清单内数据库产生完整的标准 WAL/SHM；
每个数据库验证连接关闭后、下一个数据库开始前会立即固定该库 WAL/SHM 的完整物理身份，
整轮 verify 返回后逐库复核。随后在进入最终绑定前重新捕获，并对最终绑定状态再执行一次
完整恢复点验证；复验前后的完整直属子项摘要、数据库与 sidecar 路径集合，以及每个
manifest、checksum、数据库、WAL、SHM 文件的 `dev:ino`、link count、大小与 SHA-256
必须完全一致。因此在 verify 逐库循环内部或 verify 与 binding 之间注入完整 junk sidecar
集、原位改写既有 sidecar、替换文件身份、替换 manifest、数据库文件或其他目录子项都会
失败关闭。

目标 application 主文件、WAL、SHM 及其完整父目录链会在写连接、`BEGIN IMMEDIATE`、
`COMMIT` 和 `wal_checkpoint(TRUNCATE)` 边界复核。目录链固定 `lstat` 类型、`realpath` 与
`dev:ino`；主文件和 sidecar 另行固定 link count、大小与 `dev:ino`。写连接打开前后还会
通过 `/dev/fd`（macOS）或 `/proc/self/fd`（Linux/WSL）枚举本进程新增文件描述符，并把
SQLite 实际持有的主库、WAL 与 SHM fd 分别绑定到预验证 `dev:ino`；后续每个边界都用
`fstat` 复核三个 fd。平台无法提供可靠 fd 枚举时失败关闭，路径在 open 前后被换入并恢复
也不能越过门禁。符号链接、硬链接、主文件替换、sidecar 替换或目标父目录子项变化同样会
失败关闭。目标父目录证据会固定排除主库、WAL、SHM 后的全部子项名称、类型与
`dev:ino` 摘要；共享祖先目录中无关兄弟项的增删不会改变已绑定目录身份，目标父目录新增
子目录仍不能伪装成 sidecar 出现。

四行更新在一个参数化事务内完成；任一提交前门禁失败都会回滚。调用 `COMMIT` 前即进入结果
不可判定阶段；`COMMIT` 调用抛错、已落盘后调用方抛错以及任意后续校验失败都统一要求使用
绑定恢复点恢复，不能按普通提交前失败重跑。成功后要求
`integrity_check=ok`、`foreign_key_check` 为空、全部普通表字符串值中的 24-hex 别名归零、
10-hex 别名数量不变、长期记忆 revision 精确增加 3，并执行 checkpoint。事务内修复完成时
会记录目标 application 的完整逻辑摘要；checkpoint 后使用同一连接再次验证目标记录、全局
别名、revision、完整性与该摘要，提交后的同 inode 合法 SQLite 漂移也会进入固定恢复流程。

提交成功后的任何异常只输出固定恢复指令，不透传底层异常、身份内容或文件身份：

```json
{
  "code": "DREAM_IDENTITY_ALIAS_REPAIR_COMMITTED_RESTORE_REQUIRED",
  "rollbackRecoveryPointId": "sha256:<rollback-recovery-point-id>",
  "guidance": "修复已提交但提交后校验未完成；必须使用 rollbackRecoveryPointId 对应的恢复点恢复，禁止重跑 apply。"
}
```

收到该错误后必须保留现场并按本页“校验与恢复”流程使用绑定的回滚恢复点恢复；恢复与核验
完成前不得再次执行 apply。

提交前的已知门禁错误保留固定错误码与操作提示；未列入门禁合同的异常统一输出
`DREAM_IDENTITY_ALIAS_REPAIR_FAILED` 与固定文案，不透传文件路径、注入文本或底层异常详情。

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
- Dream 身份修复拒绝同记录数业务内容、queue/outbox 与其他 Agent 漂移，拒绝 application
  主文件或 sidecar 链接/替换，并把提交后故障收敛为仅允许恢复的固定错误；
- 7/30 天分层保留和隔离季度恢复演练。
- backup、recovery root 与 target workspace 的父链符号链接攻击拒绝；macOS 根级 `/tmp` 与 `/var` 系统别名保持可用。
