# Docker deployment

最终交付为单一 `sunabot-qq-runtime` 镜像和单一 Compose service。镜像内由进程监督器管理 Sunabot 与 QQ/NapCat，二者共享回环网络与 `/srv/sunabot/workspace`。

