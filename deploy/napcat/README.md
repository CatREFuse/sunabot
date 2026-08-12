# NapCat runtime

NapCat 是 Sunabot 唯一保留的 Docker 组件。每个 QQ 账号使用一个独立容器，只挂载该账号在 `workspace/runtime/napcat/accounts/<accountId>/` 下的配置、登录态、插件和缓存。

Core、管理台、Bash、MCP、Skill Script 与 WebFetch 均不进入容器。NapCat 使用锁定摘要的上游镜像，安装阶段完成 `docker pull`；`./sunabot.sh up` 固定使用 `pull_policy: never`，不会构建或拉取镜像。

NapCat/QQ 的公开再分发授权尚未确认，component lock 状态为 `pending-review`，因此 Sunabot 发行资产不内置其镜像。安装器在安装期从上游准备摘要固定的镜像；发行归档只包含 Compose 合同与入口脚本。
