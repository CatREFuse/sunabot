# Agent 双工作区迁移

状态：`0.1.2` 已实现双工作区、Native workbench 整体只读投影、固定管理入口与停服迁移。

## 目标布局

```text
workspace/business/agents/<agentId>/
├── workbench/
│   ├── index.md
│   ├── selfie/references.jsonl
│   ├── emoji/emojis.jsonl
│   ├── skills/index.json
│   └── knowledge/index.json
└── docker-workbench/
    ├── index.md
    └── native-workbench/       # 运行时只读 bind projection
```

`workbench/` 是 Native Bash 与管理后台使用的资源真值目录。`docker-workbench/` 是 Docker Bash 的独立可写 cwd；容器内固定为 `/workbench`。运行时把完整 Native workbench 只读挂载到 `/workbench/native-workbench`，不依赖跨容器宿主符号链接。

Native Bash 的 cwd 是宿主真实 `workbench/`，环境变量 `SUNABOT_DOCKER_WORKBENCH` 指向同一 Agent 的 `docker-workbench/`。Docker Bash 使用 `SUNABOT_NATIVE_WORKBENCH=/workbench/native-workbench` 寻址只读投影。两个工作区各自使用 `index.md`，并在入口中列出当前环境实际可访问的自拍、表情、Skills 与知识库路径。

## 迁移内容

停服迁移会枚举全部 Agent，并把以下旧目录移动到 Native workbench：

| 旧目录 | 新目录 |
| --- | --- |
| `selfie/` | `workbench/selfie/` |
| `extensions/skills/` | `workbench/skills/` |
| `knowledge/` | `workbench/knowledge/` |
| 旧媒体目录中的 `emojis.jsonl` 与清单引用 PNG | `workbench/emoji/` |

普通生成图片继续位于媒体目录。迁移先在 `workspace/backups/agent-workbenches-v2-<timestamp>/` 建立逐 Agent 文件备份、manifest 与 SHA-256，再执行同文件系统移动并补齐两个 `index.md`、四个资源入口及 Docker 投影点。已知旧默认入口会升级，其他非空管理员自定义入口不会覆盖。

## 执行

只读预检：

```bash
npm run migrate:agent-resources -- plan --workspace /absolute/path/to/workspace
```

停服应用、校验和启动：

```bash
./sunabot.sh down
npm run migrate:agent-resources -- apply --workspace /absolute/path/to/workspace --quiesced
npm run migrate:agent-resources -- verify --workspace /absolute/path/to/workspace
./sunabot.sh up
./sunabot.sh status
./sunabot.sh doctor
```

## 回滚

回滚要求服务停止。脚本会先校验备份 manifest，并确认四类资源从迁移后没有变化；存在管理后台或 Bot 修改时以冲突停止，避免覆盖新内容。

```bash
npm run migrate:agent-resources -- rollback \
  --workspace /absolute/path/to/workspace \
  --backup backups/agent-workbenches-v2-<timestamp> \
  --quiesced
```

## 验收

- 新建与既有 Agent 均具备两个 `index.md` 和四个资源管理入口。
- Native Bash 的 cwd 为真实 `workbench/`，且 `SUNABOT_DOCKER_WORKBENCH` 可读取 Docker 工作区。
- Docker Bash 的 cwd 为 `/workbench`，`/workbench/native-workbench` 可读取完整 Native workbench。
- Docker 投影对自拍、表情、Skills、知识库及其他 Native workbench 文件全部只读。
- 管理后台与 Native workbench 使用同一份资源文件；Docker 通过投影读取相同字节。
- 重启后投影、资源入口、Agent 隔离和管理 API 均保持可用。
