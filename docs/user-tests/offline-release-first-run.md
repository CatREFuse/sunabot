# 离线发行与首次启动引导

## 用户目标

管理员通过一条 Bash 安装命令获得与当前平台匹配的 Sunabot 发行版，安装完成后首次启动设置管理员名称和密码，后续启动不再下载或安装运行依赖。

## 角色与环境

- 角色：首次安装的管理员。
- 环境：全新 Linux amd64、Linux arm64，以及 WSL2 中对应的 Linux 架构；安装阶段允许访问 GitHub Release，运行阶段断开外网。macOS 不在 v0.3.0 发行资产范围内。
- 发行物：带版本、平台、架构与 SHA-256 完整性清单的压缩包；Bash 安装脚本来自同一 GitHub Release。

## 输入

1. 通过 `curl -fsSL <installer-url> | bash` 安装指定版本，并分别验证默认目录与 `--prefix` 自定义目录。
2. 在安装包下载中断、校验和不匹配、manifest 非法、平台不支持和目标目录已有其他版本时重试；安装成功后损坏当前同版本目录中的启动脚本或 WebUI，再次安装相同版本。
3. 断开外网，首次执行 `./sunabot.sh up`，依次输入管理员名称、密码和密码确认。
4. 分别输入非法名称、过短密码和两次不一致的密码，再输入有效值。
5. 完成首次启动后执行 `restart`、`status`、`doctor` 和灵魂包 CLI 导入导出。
6. 记录所有进程的文件访问与网络连接，确认使用发行目录内的 Node、生产依赖、WebUI、Codex CLI、Lightpanda 与 Bubblewrap；在发行 `.env` 写入伪造 `SUNABOT_BWRAP_EXECUTABLE=/usr/bin/bwrap`，确认启动器仍向 Native Bash、stdio MCP、Skill Script 与 WebFetch Renderer 注入包内绝对入口。

## 预期结果

- 安装脚本只选择明确支持的平台资产，在读取组件锁、运行 bootstrap 或切换当前版本前校验归档 SHA-256 与完整 release manifest；失败不会覆盖已有可用版本。
- 每次安装从归档创建新的不可变版本目录。同版本当前目录被损坏时，重装不执行或复用该目录，全部校验与 bootstrap 成功后通过 `current` 原子切换到新目录；失败时 `current` 保持原值。
- 发行包包含固定版本的 Node 运行时、生产 `node_modules`、已构建 Core/WebUI/CLI、Lightpanda，以及 Bubblewrap 的 ELF loader、完整动态库闭包、源码和许可文件；`sunabot.sh` 优先且强制使用包内运行时。
- 发行构建、安装 bootstrap 和首次启动都执行真实 Bubblewrap namespace probe；loader `--list` 中 `libc`、`libcap`、`libselinux` 与 `libpcre2` 全部解析到发行目录。任一运行库缺失、宿主库回退或内核 user namespace 不可用都在切换 `current` 或启动 Core 前明确失败。
- Native Bash、stdio MCP、Skill Script 与 WebFetch Renderer 消费同一个 launcher 注入值；发行 `.env` 无法覆盖，注入缺失、相对路径、控制字符和 `/usr/bin/bwrap` 回落都失败关闭。源码开发形态仍可明确使用系统 Bubblewrap。
- 首次启动在终端显示产品名称、当前版本、数据目录和三个连续输入步骤：管理员名称、密码、确认密码；密码输入不回显，非法输入停留在对应步骤。
- 凭据通过受限同目录临时文件写入 Workspace，文件 `fsync`、原子替换和父目录 `fsync` 全部成功后返回；终端、日志、进程参数、发行清单和 Git 均不出现明文密码。
- Core 构建只执行首次运行 preflight，不能移除 journal。launcher 在 AdminAuth 读取成功、管理 API 与 OneBot 已监听、account runtime daemon 与全部应运行 NapCat 通过完整稳定探针后再次校验凭据，并把完成标记作为启动流程最后一个可失败提交；此前任一步失败都保留可重试、可回滚状态。
- 断网后的 `up`、`start`、`restart`、`status`、`doctor` 和灵魂包 CLI 不执行 `npm install`、`npm ci`、浏览器下载、镜像构建或其他依赖拉取。
- NapCat 保持唯一容器例外：安装器在安装阶段验证 Docker 与官方 NapCat 镜像可用，运行阶段只使用已存在且锁定摘要的镜像，不执行 pull 或 build。

## 质量标准

- 引导文案短、连续、可从错误中恢复，WSL 终端中的退格、隐藏密码和 UTF-8 管理员名称表现正常。
- 安装与升级使用临时目录、不可变版本目录和原子 `current` 切换；失败时保留既有指向，不承诺额外的 previous rollback 入口，也不修改用户未选择的 shell 配置。
- 离线验证必须由网络禁用或可审计的拒绝代理完成，不能只依赖源码搜索判断没有下载。
