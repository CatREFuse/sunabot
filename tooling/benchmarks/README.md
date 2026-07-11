# 性能与容量基线

这里是 GATE-004 / AUD-013 的可复现门禁。脚本只在操作系统临时目录创建隔离 workspace 和 SQLite；不会读取、迁移或写入 `SUNABOT_WORKSPACE`，也不会启动 API、NapCat 或 OneBot。

## 命令

```bash
npm run benchmark:ci
npm run benchmark:capacity
npm run benchmark:full
```

- `ci`：缩小数据量，但完整覆盖消息会话、请求日志、记忆召回、queue backlog、附件、图片和 soak；进入 `npm run verify`。
- `capacity`：使用 2,000 消息、80 活跃会话、10 万/100 万日志检查点、10 万记忆、10 万 backlog、20M 字符附件和 1 万图片；soak 缩短为 5 秒。
- `full`：与 `capacity` 相同的容量，并运行 72 小时 soak。该命令是发布前或专用性能机上的人工门禁，不进入普通 CI。

可以只运行部分场景，并把已有报告作为回归基线：

```bash
node --expose-gc --import tsx tooling/benchmarks/run.ts \
  --profile ci \
  --scenario messages,queue \
  --baseline benchmark-results/ci.json \
  --max-regression-percent 20 \
  --output benchmark-results/current.json
```

脚本不依赖当前工作目录。默认报告写入仓库根的 `benchmark-results/<profile>.json`，该目录被 Git 忽略；报告是 benchmark artifact，不是业务持久化数据。

## 指标与判定

每个场景报告：

- 各阶段吞吐、p50/p95/p99、最大值和均值；
- 事件循环 p50/p95/p99、RSS 起点/峰值/终点、heap 峰值和 GC pause；
- workspace、SQLite、WAL、峰值 WAL、磁盘可用空间变化；
- queue backlog 与 oldest-age；soak 的 cache size、eviction、oldest-age 和 RSS 趋势。

所有记录数、查询命中和有界缓存不变量必须通过。`capacity`/`full` 还执行 TODO 中已有的消息、记忆、queue 事件循环和图片列表预算；使用 `--baseline` 时，主阶段 p95、吞吐、RSS 和存储增长超过允许回归比例也会失败。

负载数据由固定 seed、固定时间基点和确定性 ID 生成。机器型号、Node 版本、平台和 profile 都写入报告，跨机器报告应先按环境分组，不能直接作为精确回归结论。
