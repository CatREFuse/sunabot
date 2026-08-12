# Native Core process entrypoint

`start-sunabot.sh` 验证完整发行清单，固定使用包内 Node 与绝对 Bubblewrap，再以发行模式启动 Core 进程。人工启停始终使用仓库根 `./sunabot.sh`，NapCat 只由独立 Docker 容器运行。
