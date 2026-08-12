# 0.1.2 升级到 0.1.3

状态：`0.1.3` 已实现受控聊天媒体导出、管理员表情导入和系统提示词规则迁移。

## 变更范围

- 新增 `export_chat_media`，只读取当前消息或明确引用消息中的运行时绑定媒体；
- 新增当前 Agent 管理员 QQ 私聊与群聊可用的 `import_chat_emoji`；
- 私聊与群聊持久系统提示词增加 `<chat_media_export_contract version="2">`；
- 不修改业务 SQLite schema，不搬移既有资源目录。

## 预检

```bash
npm run upgrade:0.1.3 -- plan
npm run upgrade:0.1.3 -- plan --workspace /absolute/path/to/workspace
```

`plan` 只读取版本文件、workspace 目录身份和主配置，不停止服务，不写提示词、数据库或资源。

## 执行

```bash
npm run upgrade:0.1.3 -- apply
```

`apply` 固定执行：

1. `./sunabot.sh down`；
2. 为默认 Plana 及全部 Agent 的业务库和 queue 创建离线 SQLite 恢复点；
3. `./sunabot.sh up`；
4. 各 Agent 启动时运行 `conversation-chat-media-v2` 提示词迁移，保留管理员消息、顺序、工具与 response schema，并在首次迁移前创建一次 0600 备份；
5. `./sunabot.sh status`；
6. `./sunabot.sh doctor`。

任一步失败都会返回 `serviceMayBeStopped`；恢复点创建后、服务启动前失败时保持停止，不能继续运行新旧混合状态。

## 验证

- 版本文件均为 `0.1.3`；
- 管理员私聊有当前图片时同时声明两个新工具；
- 普通私聊和群聊只声明导出工具；
- 无当前/引用媒体、Web Chat、prompt override、跨 Agent 或伪造句柄不声明可执行端口；
- 导出文件位于当前 Agent `workbench/`，Docker 只读投影可见；
- `status` 与 `doctor` 通过。

## 回滚

1. 停止服务；
2. 切回 `0.1.2` 代码；
3. 若需要恢复业务数据库，使用本次输出的 SQLite 恢复点；
4. 提示词迁移前备份位于对应 prompt workspace 的 `.prompt-migration-backups/`，只在确认目标 Agent 和摘要后恢复；
5. 删除本次产生且已确认无引用的 `chat-media-<sha256>.<ext>` 文件；
6. 使用 `./sunabot.sh up`、`status`、`doctor` 验证。

表情导入属于管理员明确发起的资源变更；回滚版本不会自动删除已导入表情，需在管理台按 key 或版本删除。
