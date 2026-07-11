# Native runtime entrypoints

`start-sunabot.sh` 与 `start-napcat.sh` 只由入库 systemd units 调用。两者要求显式 `SUNABOT_WORKSPACE=/srv/sunabot/workspace`；Sunabot 会拒绝非契约 Node 版本，NapCat 只从版本化组件目录读取代码并把登录态与配置写入 workspace。
