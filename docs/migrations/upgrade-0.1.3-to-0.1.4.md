# 0.1.3 升级到 0.1.4

状态：`0.1.4` 已实现异步图片参考归档、Provider 图片数量门禁、群聊编排器上下文隔离和 20 秒 thread 分类等待时间。

## 变更范围

- 当前、引用和历史图片在任务派发时下载并写入内容寻址媒体归档；
- 图片下载最多重试三次，队列只保存不可变摘要和归档引用；
- Provider 请求前核对实际图片数量，必需参考图失败时终止任务；
- 群聊编排器内部结果不进入主回复模型上下文；
- thread 分类器等待时间延长到 20 秒；
- 不修改业务 SQLite schema、系统提示词或资源目录。

## 预检

```bash
npm run upgrade:0.1.4 -- plan
npm run upgrade:0.1.4 -- plan --workspace /absolute/path/to/workspace
```

`plan` 只读取版本文件、workspace 目录身份和主配置，不停止服务，不写数据库、提示词或资源。

## 执行

```bash
npm run upgrade:0.1.4 -- apply
```

`apply` 固定执行：

1. `./sunabot.sh down`；
2. 为默认 Plana 及全部 Agent 的业务库和 queue 创建离线 SQLite 恢复点；
3. `./sunabot.sh up`；
4. `./sunabot.sh status`；
5. `./sunabot.sh doctor`。

任一步失败都会返回 `serviceMayBeStopped`；恢复点创建后、服务启动前失败时保持停止，不能继续运行新旧混合状态。

## 验证

- 全部版本文件均为 `0.1.4`；
- 当前、引用和历史图片在派发时完成内容寻址归档；
- 下载失败最多重试三次，必需参考图失败时返回明确错误；
- Provider 请求携带的 `input_image` 数量与预期一致；
- 编排器内部记录不进入主回复上下文；
- thread 分类器等待时间为 20 秒；
- `status` 与 `doctor` 通过。

## 回滚

1. 停止服务；
2. 切回 `0.1.3` 代码；
3. 若需要恢复业务数据库，使用本次输出的 SQLite 恢复点；
4. 使用 `./sunabot.sh up`、`status`、`doctor` 验证。

内容寻址媒体归档是可重建缓存；回滚版本不会自动删除本次生成的归档文件。
