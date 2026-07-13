# Native Core process entrypoint

`start-sunabot.sh` 校验 Node 与 bubblewrap 后启动 Core 进程。人工启停始终使用仓库根 `./sunabot.sh`，NapCat 只由独立 Docker 容器运行。
