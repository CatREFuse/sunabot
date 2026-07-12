# Legacy Native entrypoints

本目录保存旧 Native runtime 的兼容资产，不是当前运行入口。当前只允许通过仓库根 `./sunabot.sh` 启停 Sunabot Core 与 NapCat Docker。

`start-napcat.sh` 不得用于新部署；NapCat 必须运行在独立 Docker 容器。现有服务端迁移时按 `docs/migrations/one-container-to-split-runtime.md` 停止旧单元并保留 workspace。
